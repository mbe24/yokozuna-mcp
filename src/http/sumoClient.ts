import { CookieJar } from './cookieJar.js';
import { RateLimiter } from './rateLimiter.js';
import { RateLimitExceededError, SumoApiError, WrongEndpointError } from './errors.js';
import type { SumoErrorBody } from './errors.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SumoClientConfig {
  accessId: string;
  accessKey: string;
  /** Normalized base, e.g. `https://api.eu.sumologic.com/api/`. */
  baseUrl: string;
}

export interface SumoClientOptions {
  fetchFn?: FetchLike;
  limiter?: RateLimiter;
  requestTimeoutMs?: number;
  max429Retries?: number;
  max5xxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source for deterministic tests. */
  random?: () => number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** High priority = keepalive/status polls; they jump the rate-limiter queue. */
  priority?: 'high' | 'normal';
  signal?: AbortSignal;
  /**
   * Whether 5xx responses may be retried. Defaults to true for GET/DELETE and false
   * for POST (a create POST may have succeeded server-side; retrying could leak an
   * untracked job against the 200-job org cap).
   */
  retryOn5xx?: boolean;
}

export interface SumoResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SumoClient {
  private readonly cfg: SumoClientConfig;
  private readonly fetchFn: FetchLike;
  readonly limiter: RateLimiter;
  private readonly jar = new CookieJar();
  private readonly requestTimeoutMs: number;
  private readonly max429Retries: number;
  private readonly max5xxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly authHeader: string;

  constructor(cfg: SumoClientConfig, opts: SumoClientOptions = {}) {
    this.cfg = cfg;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.limiter = opts.limiter ?? new RateLimiter();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.max429Retries = opts.max429Retries ?? 5;
    this.max5xxRetries = opts.max5xxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.authHeader = `Basic ${Buffer.from(`${cfg.accessId}:${cfg.accessKey}`).toString('base64')}`;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: RequestOptions = {},
  ): Promise<SumoResponse<T>> {
    const url = this.buildUrl(path, opts.query);
    const retry5xx = opts.retryOn5xx ?? method !== 'POST';
    let attempt429 = 0;
    let attempt5xx = 0;

    for (;;) {
      const res = await this.doFetch(method, url, opts);

      if (res.status === 301) {
        throw new WrongEndpointError(res.headers.get('location'));
      }
      if (res.status === 429) {
        attempt429 += 1;
        if (attempt429 > this.max429Retries) throw new RateLimitExceededError(this.max429Retries);
        await this.sleep(this.backoffMs(attempt429, res.headers.get('retry-after')));
        continue;
      }
      if (res.status >= 500 && retry5xx && attempt5xx < this.max5xxRetries) {
        attempt5xx += 1;
        await this.sleep(this.backoffMs(attempt5xx, null));
        continue;
      }
      if (!res.ok) {
        const errBody = await parseJsonSafe<SumoErrorBody>(res);
        throw new SumoApiError(res.status, errBody, `Sumo API error HTTP ${res.status}`);
      }
      const body = (await parseJsonSafe<T>(res)) as T;
      return { status: res.status, headers: res.headers, body };
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(path.replace(/^\//, ''), this.cfg.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async doFetch(method: string, url: string, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json', // NEVER application/xml — the API 500s on it.
    };
    const cookie = this.jar.header();
    if (cookie) headers['Cookie'] = cookie;
    let bodyText: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyText = JSON.stringify(opts.body);
    }

    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

    const release = await this.limiter.acquire(opts.priority ?? 'normal');
    try {
      const res = await this.fetchFn(url, {
        method,
        headers,
        body: bodyText,
        signal,
        redirect: 'manual', // 301 must never be auto-followed (POST would become GET).
      });
      this.jar.storeFrom(res.headers);
      return res;
    } finally {
      release();
    }
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60_000);
    }
    const base = Math.min(500 * 2 ** (attempt - 1), 8000);
    return base + Math.floor(this.random() * 250);
  }
}

async function parseJsonSafe<T>(res: Response): Promise<T | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
