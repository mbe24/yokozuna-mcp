/**
 * Query-shape heuristics. `isAggregateQuery` detects queries whose results are RECORDS
 * (aggregate) rather than raw messages, by looking for an aggregation/transform operator
 * after a pipe. Used to (a) skip the pointless severity-count side-aggregate in
 * summary mode, and (b) reject aggregate queries in sumo_new_since (which is
 * message-cursor based and meaningless over records).
 */
const AGGREGATE_OPERATOR_RE =
  /\|\s*(count|count_distinct|count_frequent|sum|avg|min|max|stddev|variance|pct|percentile|median|first|last|most_recent|least_recent|values|total|geomean|timeslice|transpose|outlier|predict|logreduce|logcompare)\b/i;

export function isAggregateQuery(query: string): boolean {
  return AGGREGATE_OPERATOR_RE.test(query);
}

const EXTRACT_ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Compile the `extract` param (alias → JSON path under `_raw`) into a chain of
 * per-field `| json field=_raw "<path>" as <alias> nodrop` clauses.
 * ONE clause per field — the comma multi-extract form ("p1" as a1, "p2" as a2)
 * is broken in Sumo ("Field name expected"; live-verified 2026-07-03).
 */
export function buildExtractClauses(extract: Record<string, string> | undefined): string {
  if (!extract) return '';
  let out = '';
  for (const [alias, path] of Object.entries(extract)) {
    if (!EXTRACT_ALIAS_RE.test(alias)) {
      throw new Error(
        `extract alias "${alias}" is not a simple identifier (letters/digits/underscore, not starting with a digit).`,
      );
    }
    const p = path.trim();
    if (p === '' || p.includes('"')) {
      throw new Error(
        `extract path for alias "${alias}" must be a non-empty JSON path without double quotes (e.g. "log.status").`,
      );
    }
    out += ` | json field=_raw "${p}" as ${alias} nodrop`;
  }
  return out;
}
