/**
 * Shared rate limiter: token bucket (default 4 req/s) + concurrency semaphore (default 10).
 * Two priority classes: `high` (keepalive/status polls — must never be starved past the
 * ~20s keepalive bound) and `normal` (everything else). High-priority acquires jump the queue.
 */
export interface RateLimiterOptions {
  requestsPerSecond?: number;
  maxConcurrent?: number;
  now?: () => number;
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
}

interface Waiter {
  resolve: () => void;
  priority: 'high' | 'normal';
}

export class RateLimiter {
  private readonly rps: number;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;

  private tokens: number;
  private lastRefill: number;
  private active = 0;
  private queue: Waiter[] = [];
  private timerScheduled = false;

  constructor(opts: RateLimiterOptions = {}) {
    this.rps = opts.requestsPerSecond ?? 4;
    this.maxConcurrent = opts.maxConcurrent ?? 10;
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.tokens = this.rps;
    this.lastRefill = this.now();
  }

  /** Acquire a slot; returns a release function that MUST be called when the request ends. */
  async acquire(priority: 'high' | 'normal' = 'normal'): Promise<() => void> {
    await new Promise<void>((resolve) => {
      const waiter: Waiter = { resolve, priority };
      if (priority === 'high') {
        const idx = this.queue.findIndex((w) => w.priority === 'normal');
        if (idx === -1) this.queue.push(waiter);
        else this.queue.splice(idx, 0, waiter);
      } else {
        this.queue.push(waiter);
      }
      this.pump();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.pump();
    };
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.rps, this.tokens + elapsed * this.rps);
      this.lastRefill = t;
    }
  }

  private pump(): void {
    this.refill();
    while (this.queue.length > 0 && this.active < this.maxConcurrent && this.tokens >= 1) {
      this.tokens -= 1;
      this.active += 1;
      const w = this.queue.shift()!;
      w.resolve();
    }
    if (this.queue.length > 0 && this.active < this.maxConcurrent && !this.timerScheduled) {
      // Waiting on tokens: schedule a refill pump.
      this.timerScheduled = true;
      const waitMs = Math.max(10, Math.ceil(((1 - this.tokens) / this.rps) * 1000));
      this.setTimeoutFn(() => {
        this.timerScheduled = false;
        this.pump();
      }, waitMs);
    }
  }
}
