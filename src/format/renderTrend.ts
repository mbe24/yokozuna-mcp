import { coerceNumericDisplay } from './flatten.js';

/**
 * sumo_trend rendering: aggregate records of `... | timeslice <interval> | count by
 * _timeslice[, <dim>]` become one compact sparkline line per series.
 * Live-verified record shape (EU, 2026-07-03): `_timeslice` is an epoch-ms STRING,
 * `_count` is a STRING, records arrive UNSORTED, and empty buckets are ABSENT —
 * so the renderer sorts and gap-fills the timeslice grid itself.
 */

export interface TrendRow {
  sliceMs: number;
  /** Series key ('' when the dimension is absent — rendered as "(none)"). */
  key: string;
  count: number;
}

export interface TrendRenderOptions {
  fromLabel: string;
  toLabel: string;
  intervalLabel: string;
  intervalMs: number;
  /** Series label (detected field, "_sourcehost", "token class", … or "none" for a total). */
  by: string;
  /** Max series rendered (ranked by total, rest merged into "(other)"). */
  maxSeries: number;
}

const SPARK = '▁▂▃▄▅▆▇█';

function sparkline(counts: number[]): string {
  const max = Math.max(...counts);
  if (max <= 0) return SPARK.charAt(0).repeat(counts.length);
  return counts
    .map((c) => SPARK.charAt(c === 0 ? 0 : Math.min(7, Math.ceil((c / max) * 8) - 1)))
    .join('');
}

export function renderTrend(opts: TrendRenderOptions, rows: TrendRow[]): string {
  if (rows.length === 0) return 'trend: no matching messages in this time range.';
  const allNone = opts.by !== 'none' && rows.every((r) => r.key === '');

  const minSlice = Math.min(...rows.map((r) => r.sliceMs));
  const maxSlice = Math.max(...rows.map((r) => r.sliceMs));
  const buckets = Math.round((maxSlice - minSlice) / opts.intervalMs) + 1;
  if (!Number.isFinite(buckets) || buckets < 1 || buckets > 500) {
    // Defensive: a grid this shape means the interval and the records disagree.
    return `trend: unexpected timeslice grid (buckets=${buckets}) — pass an explicit interval.`;
  }

  // Gap-filled per-series bucket counts.
  const series = new Map<string, number[]>();
  for (const r of rows) {
    const idx = Math.round((r.sliceMs - minSlice) / opts.intervalMs);
    if (idx < 0 || idx >= buckets) continue;
    let counts = series.get(r.key);
    if (!counts) {
      counts = new Array<number>(buckets).fill(0);
      series.set(r.key, counts);
    }
    counts[idx] = (counts[idx] ?? 0) + r.count;
  }

  const ranked = [...series.entries()]
    .map(([key, counts]) => ({
      key: key === '' ? '(none)' : coerceNumericDisplay(key),
      counts,
      total: counts.reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total);

  let shown = ranked;
  if (ranked.length > opts.maxSeries) {
    const kept = ranked.slice(0, opts.maxSeries);
    const other = new Array<number>(buckets).fill(0);
    let otherTotal = 0;
    for (const s of ranked.slice(opts.maxSeries)) {
      s.counts.forEach((c, i) => (other[i] = (other[i] ?? 0) + c));
      otherTotal += s.total;
    }
    kept.push({ key: `(other ×${ranked.length - opts.maxSeries})`, counts: other, total: otherTotal });
    shown = kept;
  }

  const keyWidth = Math.max(...shown.map((s) => s.key.length));
  const totalWidth = Math.max(...shown.map((s) => String(s.total).length));
  const lines = [
    `trend by ${opts.by}: ${opts.fromLabel} .. ${opts.toLabel}, interval=${opts.intervalLabel}, buckets=${buckets}` +
      ` (first bucket ${new Date(minSlice).toISOString()}; sparkline scaled per series)`,
  ];
  for (const s of shown) {
    lines.push(
      `${s.key.padEnd(keyWidth)}  total=${String(s.total).padStart(totalWidth)}  ${sparkline(s.counts)}  [${s.counts.join(' ')}]`,
    );
  }
  if (allNone) {
    lines.push(
      '(100% (none) — the series field may not exist at this path in this scope; run sumo_describe_schema)',
    );
  }
  return lines.join('\n');
}
