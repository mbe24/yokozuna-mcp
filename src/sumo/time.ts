/**
 * Time-range helpers. Relative windows (`last: "15m"`) are resolved to epoch milliseconds,
 * which the API accepts directly — this sidesteps all client-side IANA timezone math
 * (`timeZone` then only affects server-side query-time parsing / histogram bucketing).
 * Explicit `from`/`to` values (ISO-8601 or epoch ms) are passed through verbatim.
 */

export interface ResolvedRange {
  from: string | number;
  to: string | number;
  /** Epoch ms when derivable (used for UI deep links); undefined for opaque ISO passthrough. */
  fromMs?: number;
  toMs?: number;
}

const LAST_RE = /^(\d+)\s*(s|m|h|d)$/i;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseLast(last: string): number {
  const m = LAST_RE.exec(last.trim());
  if (!m) {
    throw new Error(
      `Invalid relative time "${last}". Use <n><unit> with unit one of s/m/h/d, e.g. "15m", "2h".`,
    );
  }
  const n = Number(m[1]);
  const unit = (m[2] as string).toLowerCase();
  const ms = n * (UNIT_MS[unit] ?? 0);
  if (ms <= 0) throw new Error(`Relative time "${last}" must be positive.`);
  return ms;
}

export interface RangeInput {
  last?: string;
  from?: string;
  to?: string;
}

export function resolveRange(input: RangeInput, now: () => number = Date.now): ResolvedRange {
  const hasLast = input.last !== undefined;
  const hasFromTo = input.from !== undefined && input.to !== undefined;
  if (hasLast === hasFromTo) {
    throw new Error('Provide exactly one of `last` (e.g. "15m") or both `from` and `to`.');
  }
  if (hasLast) {
    const toMs = now();
    const fromMs = toMs - parseLast(input.last!);
    return { from: fromMs, to: toMs, fromMs, toMs };
  }
  const fromMs = toEpochMs(input.from!);
  const toMs = toEpochMs(input.to!);
  return { from: input.from!, to: input.to!, fromMs, toMs };
}

/** "Nice" timeslice steps for sumo_trend's auto interval. */
const TREND_STEPS = [
  '10s',
  '30s',
  '1m',
  '2m',
  '5m',
  '10m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '12h',
  '1d',
] as const;

/**
 * Auto-pick a trend interval: the smallest nice step giving ≤ 40 buckets over the
 * window (≈ 15–40 buckets in practice). Falls back to "5m" when the window size is
 * not derivable (opaque from/to strings).
 */
export function pickTrendInterval(windowMs: number | undefined): string {
  if (windowMs === undefined || !Number.isFinite(windowMs) || windowMs <= 0) return '5m';
  for (const label of TREND_STEPS) {
    if (windowMs / parseLast(label) <= 40) return label;
  }
  return TREND_STEPS[TREND_STEPS.length - 1]!;
}

/** Best-effort epoch-ms parse for deep links; undefined when not derivable. */
function toEpochMs(v: string): number | undefined {
  if (/^\d{10,}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
