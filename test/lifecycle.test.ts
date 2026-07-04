import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchJobApi } from '../src/sumo/searchJobApi.js';
import {
  KeepaliveRegistry,
  collectMessages,
  waitForCompletion,
} from '../src/sumo/lifecycle.js';
import type { MessagesPage, SearchJobStatus } from '../src/sumo/types.js';

const status = (state: string, messageCount = 0, recordCount = 0): SearchJobStatus => ({
  state,
  messageCount,
  recordCount,
  pendingWarnings: [],
  pendingErrors: [],
});

function fakeApi(statuses: SearchJobStatus[]): SearchJobApi & { statusCalls: number } {
  let i = 0;
  const api = {
    statusCalls: 0,
    status: vi.fn(async () => {
      api.statusCalls += 1;
      const s = statuses[Math.min(i, statuses.length - 1)]!;
      i += 1;
      return s;
    }),
    create: vi.fn(),
    messages: vi.fn(),
    records: vi.fn(),
    delete: vi.fn(async () => {}),
  };
  return api as unknown as SearchJobApi & { statusCalls: number };
}

const instantSleep = { sleep: async () => {} };

describe('waitForCompletion', () => {
  it('polls through GATHERING to DONE and resolves', async () => {
    const api = fakeApi([
      status('NOT STARTED'),
      status('GATHERING RESULTS', 10),
      status('DONE GATHERING RESULTS', 42),
    ]);
    const res = await waitForCompletion(api, 'J', { ...instantSleep });
    expect(res.status.messageCount).toBe(42);
    expect(res.truncated).toBe(false);
    expect(res.partial).toBe(false);
  });

  it('resolves with truncated on FORCE PAUSED', async () => {
    const api = fakeApi([status('GATHERING RESULTS'), status('FORCE PAUSED', 100_000)]);
    const res = await waitForCompletion(api, 'J', { ...instantSleep });
    expect(res.truncated).toBe(true);
  });

  it('rejects only on CANCELLED', async () => {
    const api = fakeApi([status('CANCELLED')]);
    await expect(waitForCompletion(api, 'J', { ...instantSleep })).rejects.toThrow(/CANCELLED/);
  });

  it('keeps polling on unknown/future states', async () => {
    const api = fakeApi([
      status('GATHERING RESULTS FROM SUBQUERIES'),
      status('DONE GATHERING HISTOGRAM'),
      status('SOME FUTURE STATE NOBODY KNOWS'),
      status('DONE GATHERING RESULTS'),
    ]);
    const res = await waitForCompletion(api, 'J', { ...instantSleep });
    expect(res.status.state).toBe('DONE GATHERING RESULTS');
    expect(api.statusCalls).toBe(4);
  });

  it('never sleeps more than 20s between polls, even if asked to', async () => {
    const sleeps: number[] = [];
    const api = fakeApi([status('GATHERING RESULTS'), status('DONE GATHERING RESULTS')]);
    await waitForCompletion(api, 'J', {
      pollIntervalMs: 60_000, // absurd request — must be clamped
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps.length).toBeGreaterThan(0);
    for (const s of sleeps) expect(s).toBeLessThanOrEqual(20_000);
  });

  it('returns partial on timeout instead of throwing', async () => {
    let t = 0;
    const api = fakeApi([status('GATHERING RESULTS', 7)]);
    const res = await waitForCompletion(api, 'J', {
      timeoutMs: 10_000,
      now: () => {
        t += 6000;
        return t;
      },
      ...instantSleep,
    });
    expect(res.partial).toBe(true);
    expect(res.status.messageCount).toBe(7);
  });

  it('supports early-exit at a target message count while gathering', async () => {
    const api = fakeApi([status('GATHERING RESULTS', 500)]);
    const res = await waitForCompletion(api, 'J', { stopAtMessageCount: 100, ...instantSleep });
    expect(res.partial).toBe(true);
    expect(api.statusCalls).toBe(1);
  });
});

describe('collectMessages', () => {
  const page = (n: number): MessagesPage => ({
    fields: [{ name: '_raw', fieldType: 'string', keyField: false }],
    messages: Array.from({ length: n }, (_, i) => ({ map: { _raw: `m${i}` } })),
  });

  it('advances offset by the RETURNED count, not the requested limit', async () => {
    const calls: [number, number][] = [];
    const api = {
      messages: vi.fn(async (_id: string, offset: number, limit: number) => {
        calls.push([offset, limit]);
        if (offset === 0) return page(600); // short page (e.g. 100MB cap)
        if (offset === 600) return page(400);
        return page(0);
      }),
    } as unknown as SearchJobApi;
    const res = await collectMessages(api, 'J', { pageSize: 1000 });
    expect(calls.map(([o]) => o)).toEqual([0, 600, 1000]);
    expect(res.collected).toBe(1000);
    expect(res.truncated).toBe(false);
  });

  it('stops at max with a truncation flag', async () => {
    const api = {
      messages: vi.fn(async (_id: string, _offset: number, limit: number) => page(limit)),
    } as unknown as SearchJobApi;
    const res = await collectMessages(api, 'J', { max: 2500, pageSize: 1000 });
    expect(res.collected).toBe(2500);
    expect(res.truncated).toBe(true);
  });

  it('clamps max to the 100k hard cap', async () => {
    const api = {
      messages: vi.fn(async (_id: string, offset: number, limit: number) =>
        offset >= 100_000 ? page(0) : page(limit),
      ),
    } as unknown as SearchJobApi;
    const res = await collectMessages(api, 'J', { max: 999_999, pageSize: 10_000 });
    expect(res.collected).toBe(100_000);
    expect(res.truncated).toBe(true);
  });

  it('streams via onPage without accumulating', async () => {
    const api = {
      messages: vi.fn(async (_id: string, offset: number) => (offset === 0 ? page(10) : page(0))),
    } as unknown as SearchJobApi;
    const seen: number[] = [];
    const res = await collectMessages(api, 'J', {
      onPage: (p) => {
        seen.push(p.messages.length);
      },
    });
    expect(seen).toEqual([10]);
    expect(res.messages.length).toBe(0); // not accumulated in streaming mode
    expect(res.collected).toBe(10);
  });
});

describe('KeepaliveRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls a registered job at the configured cadence and stops on unregister', async () => {
    const api = fakeApi([status('DONE GATHERING RESULTS')]);
    const reg = new KeepaliveRegistry(api, { intervalMs: 15_000 });
    reg.register('J1');
    await vi.advanceTimersByTimeAsync(46_000);
    expect(api.statusCalls).toBe(3); // one per 15s tick
    reg.unregister('J1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.statusCalls).toBe(3); // no more polling
  });

  it('stops tracking a job that is gone server-side', async () => {
    const api = fakeApi([]);
    (api.status as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404'));
    const errors: string[] = [];
    const reg = new KeepaliveRegistry(api, {
      intervalMs: 15_000,
      onError: (id) => errors.push(id),
    });
    reg.register('J1');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(errors).toEqual(['J1']);
    expect(reg.trackedIds()).toEqual([]);
  });

  it('deletes idle jobs after the TTL', async () => {
    const api = fakeApi([status('DONE GATHERING RESULTS')]);
    const reg = new KeepaliveRegistry(api, { intervalMs: 15_000, idleTtlMs: 30_000 });
    reg.register('J1');
    await vi.advanceTimersByTimeAsync(50_000);
    expect(reg.trackedIds()).toEqual([]);
    expect(api.delete).toHaveBeenCalledWith('J1', { tolerateMissing: true });
  });

  it('shutdown deletes all tracked jobs', async () => {
    const api = fakeApi([status('DONE GATHERING RESULTS')]);
    const reg = new KeepaliveRegistry(api, { intervalMs: 15_000 });
    reg.register('A');
    reg.register('B');
    await reg.shutdown();
    expect(api.delete).toHaveBeenCalledTimes(2);
    expect(reg.trackedIds()).toEqual([]);
  });

  it('caps the number of tracked jobs', () => {
    const api = fakeApi([status('DONE GATHERING RESULTS')]);
    const reg = new KeepaliveRegistry(api, { maxJobs: 2 });
    reg.register('A');
    reg.register('B');
    reg.register('C');
    expect(reg.trackedIds().length).toBe(2);
    expect(reg.trackedIds()).toContain('C');
  });

  it('reports the evicted (stalest) job id via onEvict', () => {
    const api = fakeApi([status('DONE GATHERING RESULTS')]);
    const evicted: string[] = [];
    let t = 0;
    const reg = new KeepaliveRegistry(api, {
      maxJobs: 2,
      now: () => (t += 1),
      onEvict: (id) => evicted.push(id),
    });
    reg.register('A'); // t=1 — stalest
    reg.register('B'); // t=2
    reg.register('C'); // evicts A
    expect(evicted).toEqual(['A']);
    expect(reg.trackedIds().sort()).toEqual(['B', 'C']);
    // Re-registering an already-tracked id never evicts.
    reg.register('B');
    expect(evicted).toEqual(['A']);
  });
});
