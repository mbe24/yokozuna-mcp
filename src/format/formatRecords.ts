import type { RecordsPage } from '../sumo/types.js';

/**
 * Render aggregate records as a small aligned text table (default) or NDJSON rows.
 * `detail`/`fields`/message-truncation levers do not apply to records.
 */
export function formatRecords(page: RecordsPage, format: 'text' | 'ndjson' = 'text'): string {
  const fieldNames = page.fields?.map((f) => f.name) ?? [];
  const rows = page.records ?? [];

  if (format === 'ndjson') {
    return rows.map((r) => JSON.stringify(r.map)).join('\n');
  }

  if (rows.length === 0) return '(no records)';
  const names =
    fieldNames.length > 0 ? fieldNames : Object.keys(rows[0]?.map ?? {}).sort();

  const widths = names.map((n) =>
    Math.max(n.length, ...rows.map((r) => (r.map[n] ?? '').length)),
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  const header = names.map((n, i) => pad(n, widths[i] ?? n.length)).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows.map((r) =>
    names.map((n, i) => pad(r.map[n] ?? '', widths[i] ?? 0)).join('  '),
  );
  return [header, sep, ...body].join('\n');
}
