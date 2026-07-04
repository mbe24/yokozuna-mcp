import type { SearchJobApi } from './searchJobApi.js';
import {
  MAX_PAGE_LIMIT,
  MAX_TOTAL_MESSAGES,
  STATE_CANCELLED,
  STATE_DONE,
  STATE_FORCE_PAUSED,
  type MessagesPage,
  type SearchJobStatus,
} from './types.js';

export interface WaitResult {
  status: SearchJobStatus;
  /** FORCE PAUSED: non-aggregate query hit the 100k cap — results available but capped. */
  truncated: boolean;
  /** waitForCompletion timed out — results gathered so far are still pageable. */
  partial: boolean;
}

export interface WaitOptions {
  /** Base poll interval; must stay well under the keepalive bound. */
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Early-exit: stop polling once messageCount reaches this (partial paging is allowed). */
  stopAtMessageCount?: number;
  /** Called after EACH status poll (progress notifications). `poll` is 1-based and monotonic. */
  onProgress?: (info: { poll: number; state: string; messageCount: number }) => void | Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Poll job status until a terminal outcome, at a keepalive-safe cadence (default 3s,
 * never more than 20s between requests). State set is treated as OPEN:
 * resolve only on DONE (and FORCE PAUSED -> truncated), reject only on CANCELLED,
 * keep polling on anything else including unknown/future states.
 */
export async function waitForCompletion(
  api: SearchJobApi,
  id: string,
  opts: WaitOptions = {},
): Promise<WaitResult> {
  const pollIntervalMs = Math.min(opts.pollIntervalMs ?? 3000, 20_000);
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const start = now();

  let poll = 0;
  const fetchStatus = async (): Promise<SearchJobStatus> => {
    opts.signal?.throwIfAborted(); // fast fail — never burn a poll on an aborted request
    const s = await api.status(id, { priority: 'high', signal: opts.signal });
    poll += 1;
    await opts.onProgress?.({ poll, state: s.state, messageCount: s.messageCount ?? 0 });
    return s;
  };

  let status = await fetchStatus();
  for (;;) {
    if (status.state === STATE_DONE) return { status, truncated: false, partial: false };
    if (status.state === STATE_FORCE_PAUSED) return { status, truncated: true, partial: false };
    if (status.state === STATE_CANCELLED) {
      throw new Error(
        `Search job ${id} was CANCELLED server-side (keepalive missed, or cancelled by an operator).`,
      );
    }
    if (
      opts.stopAtMessageCount !== undefined &&
      (status.messageCount ?? 0) >= opts.stopAtMessageCount
    ) {
      return { status, truncated: false, partial: true };
    }
    if (now() - start >= timeoutMs) {
      return { status, truncated: false, partial: true };
    }
    await sleep(pollIntervalMs, opts.signal);
    status = await fetchStatus();
  }
}

export interface CollectResult {
  messages: MessagesPage['messages'];
  fields: MessagesPage['fields'];
  /** True when collection stopped because of `max` or the 100k server cap. */
  truncated: boolean;
}

export interface CollectOptions {
  max?: number;
  pageSize?: number;
  signal?: AbortSignal;
  /** Streaming hook — called per page. When provided, messages are NOT accumulated in memory. */
  onPage?: (page: MessagesPage, offset: number) => void | Promise<void>;
  /** Called after EACH page (progress notifications). `pages` is 1-based and monotonic. */
  onProgress?: (info: { pages: number; collected: number }) => void | Promise<void>;
}

/**
 * Page through /messages. Advances offset by the number of messages actually returned
 * (a page may be short when it hits the 100 MB size cap), stops on an empty page,
 * `max`, or the 100k hard cap.
 */
export async function collectMessages(
  api: SearchJobApi,
  id: string,
  opts: CollectOptions = {},
): Promise<CollectResult & { collected: number }> {
  const max = Math.min(opts.max ?? MAX_TOTAL_MESSAGES, MAX_TOTAL_MESSAGES);
  const pageSize = Math.min(opts.pageSize ?? 1000, MAX_PAGE_LIMIT);
  const accumulate = opts.onPage === undefined;

  const all: MessagesPage['messages'] = [];
  let fields: MessagesPage['fields'] = [];
  let offset = 0;
  let truncated = false;
  let pages = 0;

  while (offset < max) {
    opts.signal?.throwIfAborted();
    const limit = Math.min(pageSize, max - offset);
    const page = await api.messages(id, offset, limit, opts.signal);
    if (page.fields?.length) fields = page.fields;
    const got = page.messages?.length ?? 0;
    if (got === 0) break;
    if (opts.onPage) await opts.onPage(page, offset);
    if (accumulate) all.push(...page.messages);
    offset += got; // advance by RETURNED count, never by requested limit
    pages += 1;
    await opts.onProgress?.({ pages, collected: offset });
    if (offset >= max) {
      truncated = true; // there may be more; we stopped at max/100k
      break;
    }
  }
  return { messages: all, fields, truncated, collected: offset };
}

/**
 * Background keepalive registry (Task 04): jobs created via the create primitive are
 * status-polled every `intervalMs` (default 15s, safely under the observed expiry window)
 * so an agent's thinking time between tool calls doesn't get the job cancelled.
 * Live finding 2026-07-03: un-polled jobs survive gaps well beyond the documented ~30s
 * (see plan README), but the registry stays — the documented bound is the contract.
 */
export class KeepaliveRegistry {
  private readonly jobs = new Map<string, { lastTouched: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly api: SearchJobApi,
    private readonly opts: {
      intervalMs?: number;
      idleTtlMs?: number;
      maxJobs?: number;
      now?: () => number;
      onError?: (jobId: string, err: unknown) => void;
      /** Called when the job cap forces the stalest tracked job out of keepalive. */
      onEvict?: (jobId: string) => void;
    } = {},
  ) {}

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }

  register(id: string): void {
    const maxJobs = this.opts.maxJobs ?? 20;
    if (!this.jobs.has(id) && this.jobs.size >= maxJobs) {
      // Drop the stalest tracked job from keepalive (it will expire server-side).
      let stalest: string | undefined;
      let stalestT = Infinity;
      for (const [jid, meta] of this.jobs) {
        if (meta.lastTouched < stalestT) {
          stalestT = meta.lastTouched;
          stalest = jid;
        }
      }
      if (stalest) {
        this.jobs.delete(stalest);
        this.opts.onEvict?.(stalest);
      }
    }
    this.jobs.set(id, { lastTouched: this.now() });
    this.ensureTimer();
  }

  /** Reset the idle TTL (call on any explicit tool access to the job). */
  touch(id: string): void {
    const meta = this.jobs.get(id);
    if (meta) meta.lastTouched = this.now();
  }

  unregister(id: string): void {
    this.jobs.delete(id);
    if (this.jobs.size === 0) this.stopTimer();
  }

  trackedIds(): string[] {
    return [...this.jobs.keys()];
  }

  private ensureTimer(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? 15_000;
    this.timer = setInterval(() => void this.tick(), interval);
    // Never keep the process alive just for keepalive.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const idleTtl = this.opts.idleTtlMs ?? 10 * 60_000;
    const t = this.now();
    for (const [id, meta] of [...this.jobs]) {
      if (t - meta.lastTouched > idleTtl) {
        // Idle too long: stop keeping it alive AND clean it up server-side.
        this.jobs.delete(id);
        void this.api.delete(id, { tolerateMissing: true }).catch(() => undefined);
        continue;
      }
      try {
        await this.api.status(id, { priority: 'high' });
      } catch (err) {
        this.opts.onError?.(id, err);
        this.jobs.delete(id); // gone server-side; stop polling it
      }
    }
    if (this.jobs.size === 0) this.stopTimer();
  }

  /** Best-effort deletion of all tracked jobs (shutdown path). */
  async shutdown(): Promise<void> {
    this.stopTimer();
    const ids = [...this.jobs.keys()];
    this.jobs.clear();
    await Promise.allSettled(ids.map((id) => this.api.delete(id, { tolerateMissing: true })));
  }
}
