import { describe, expect, it } from 'vitest';
import { parseLast, resolveRange } from '../src/sumo/time.js';

describe('parseLast', () => {
  it('parses s/m/h/d units', () => {
    expect(parseLast('30s')).toBe(30_000);
    expect(parseLast('15m')).toBe(900_000);
    expect(parseLast('2h')).toBe(7_200_000);
    expect(parseLast('1d')).toBe(86_400_000);
  });

  it('rejects garbage', () => {
    expect(() => parseLast('15x')).toThrow(/s\/m\/h\/d/);
    expect(() => parseLast('')).toThrow();
    expect(() => parseLast('0m')).toThrow(/positive/);
  });
});

describe('resolveRange', () => {
  const NOW = 1_783_017_600_000; // fixed injected clock
  const now = () => NOW;

  it('resolves last:"15m" to a 15-minute epoch-ms window ending now', () => {
    const r = resolveRange({ last: '15m' }, now);
    expect(r.to).toBe(NOW);
    expect(r.from).toBe(NOW - 900_000);
    expect(r.fromMs).toBe(NOW - 900_000);
    expect(r.toMs).toBe(NOW);
  });

  it('passes explicit from/to through verbatim and derives epoch ms for deep links', () => {
    const r = resolveRange({ from: '2026-07-02T18:28:00Z', to: '2026-07-02T18:43:00Z' }, now);
    expect(r.from).toBe('2026-07-02T18:28:00Z');
    expect(r.to).toBe('2026-07-02T18:43:00Z');
    expect(r.fromMs).toBe(Date.parse('2026-07-02T18:28:00Z'));
  });

  it('requires exactly one of last or from+to', () => {
    expect(() => resolveRange({}, now)).toThrow(/exactly one/i);
    expect(() => resolveRange({ last: '15m', from: 'x', to: 'y' }, now)).toThrow(/exactly one/i);
    expect(() => resolveRange({ from: '2026-07-02T18:28:00' }, now)).toThrow(/exactly one/i);
  });
});

describe('pickTrendInterval', () => {
  it('picks the smallest nice step giving ≤40 buckets', async () => {
    const { pickTrendInterval } = await import('../src/sumo/time.js');
    expect(pickTrendInterval(15 * 60_000)).toBe('30s'); // 15m → 30 buckets
    expect(pickTrendInterval(30 * 60_000)).toBe('1m'); // 30m → 30 buckets
    expect(pickTrendInterval(2 * 3_600_000)).toBe('5m'); // 2h → 24 buckets
    expect(pickTrendInterval(24 * 3_600_000)).toBe('1h'); // 1d → 24 buckets
  });

  it('falls back to 5m when the window is unknown, and clamps huge windows to 1d', async () => {
    const { pickTrendInterval } = await import('../src/sumo/time.js');
    expect(pickTrendInterval(undefined)).toBe('5m');
    expect(pickTrendInterval(-5)).toBe('5m');
    expect(pickTrendInterval(400 * 86_400_000)).toBe('1d');
  });
});
