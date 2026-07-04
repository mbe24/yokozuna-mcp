import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/http/rateLimiter.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('RateLimiter', () => {
  it('never exceeds the concurrency cap under a burst', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 1000, maxConcurrent: 3 });
    let active = 0;
    let peak = 0;
    const job = async () => {
      const release = await limiter.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 20 }, job));
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('enforces the requests-per-second budget', async () => {
    let now = 0;
    const timers: { cb: () => void; at: number }[] = [];
    const limiter = new RateLimiter({
      requestsPerSecond: 4,
      maxConcurrent: 10,
      now: () => now,
      setTimeoutFn: (cb, ms) => timers.push({ cb, at: now + ms }),
    });
    const granted: number[] = [];
    for (let i = 0; i < 8; i++) {
      void limiter.acquire().then((rel) => {
        granted.push(i);
        rel();
      });
    }
    await tick();
    expect(granted.length).toBe(4); // initial bucket of 4 tokens
    // Advance virtual time 1s and fire scheduled pumps.
    now = 1000;
    for (const t of timers.splice(0)) t.cb();
    await tick();
    expect(granted.length).toBe(8);
  });

  it('lets high-priority acquires jump the queue', async () => {
    let now = 0;
    const timers: { cb: () => void }[] = [];
    const limiter = new RateLimiter({
      requestsPerSecond: 1,
      maxConcurrent: 10,
      now: () => now,
      setTimeoutFn: (cb) => timers.push({ cb }),
    });
    const order: string[] = [];
    // Token 1 goes to the first normal acquire immediately.
    void limiter.acquire('normal').then((rel) => {
      order.push('n1');
      rel();
    });
    void limiter.acquire('normal').then((rel) => {
      order.push('n2');
      rel();
    });
    void limiter.acquire('high').then((rel) => {
      order.push('keepalive');
      rel();
    });
    await tick();
    // Fire timer pumps until the queue drains (each pump refills from the advancing clock).
    while (timers.length > 0 && order.length < 3) {
      now += 10_000; // plenty of tokens per pump
      for (const t of timers.splice(0)) t.cb();
      await tick();
    }
    expect(order[0]).toBe('n1');
    expect(order[1]).toBe('keepalive'); // jumped ahead of n2
    expect(order[2]).toBe('n2');
  });
});
