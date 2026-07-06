import { coerceNumericDisplay } from './flatten.js';

/**
 * Rendering for sumo_facets: one compact ranked table per dimension. A dimension that
 * failed renders as an error LINE (never fails the whole call); empty-string keys
 * (nodrop rows where the field is absent) render as `(none)`. A dimension that is
 * entirely `(none)` carries an explicit "may not exist at this path" hint (§10.3) —
 * silence must never read as "the field has no values".
 */

export interface FacetRow {
  key: string;
  count: number;
}

export interface FacetDimensionResult {
  dimension: string;
  /** Ranked rows (already sorted count-desc by Sumo). Present iff the dimension succeeded. */
  rows?: FacetRow[];
  /** Failure message for this dimension only. */
  error?: string;
  /** The per-dimension wait timed out — counts cover what was gathered so far. */
  partial?: boolean;
}

export interface FacetsHeader {
  query: string;
  fromLabel: string;
  toLabel: string;
  byReceiptTime: boolean;
  limit: number;
}

export function renderFacets(header: FacetsHeader, results: FacetDimensionResult[]): string {
  const lines: string[] = [];
  lines.push(`facets (top ${header.limit} per dimension): ${header.query}`);
  lines.push(
    `range: ${header.fromLabel} .. ${header.toLabel}${header.byReceiptTime ? ' (byReceiptTime)' : ''}`,
  );

  for (const r of results) {
    lines.push('');
    if (r.error !== undefined) {
      lines.push(`${r.dimension}: ERROR — ${r.error}`);
      continue;
    }
    const rows = r.rows ?? [];
    const partial = r.partial ? ' (partial — wait timed out)' : '';
    if (rows.length === 0) {
      lines.push(`${r.dimension}:${partial} (no results)`);
      continue;
    }
    lines.push(`${r.dimension}:${partial}`);
    const width = Math.max(...rows.map((row) => String(row.count).length));
    for (const row of rows) {
      lines.push(
        `  ${String(row.count).padStart(width)}  ${row.key === '' ? '(none)' : coerceNumericDisplay(row.key)}`,
      );
    }
    if (rows.every((row) => row.key === '')) {
      lines.push(
        '  (100% (none) — the field may not exist at this path in this scope; run sumo_describe_schema)',
      );
    }
  }
  return lines.join('\n');
}
