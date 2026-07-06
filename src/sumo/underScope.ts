/**
 * §0.2.1 #2: under-scope coverage hint (owner-approved design). When an error digest is
 * about to render the CALM "genuinely clean" block AND the scope pins an EXACT
 * `_sourcecategory=<X>` (no wildcard), one extra volume-only aggregate over the PREFIX
 * `<X>*` reveals sibling/child categories the scope silently excludes (live case: the
 * exact `…/worker` was clean while `…/worker/script` carried the hourly errors).
 *
 * Volume/coverage ONLY — the detected error predicate is NEVER run over the prefix
 * (sibling schemas may differ; that would re-introduce a false-clean). The probe runs
 * only on this rare calm-clean exact-category path, never on busy/wildcard scopes.
 */

export interface ExactCategoryTerm {
  /** The verbatim `_sourcecategory=<X>` term as it appears in the scope. */
  term: string;
  /** The exact category value (quotes stripped). */
  category: string;
  /** Whether the original term was double-quoted. */
  quoted: boolean;
}

const CATEGORY_TERM_RE = /(^|\s)(_sourcecategory\s*=\s*(?:"([^"*]+)"|([^\s"*]+)))(?=\s|$)/gi;
const ANY_CATEGORY_RE = /_sourcecategory\s*=/gi;

/**
 * Returns the scope's single EXACT `_sourcecategory=<X>` term (no `*` anywhere in the
 * value), or undefined when there is none, more than one `_sourcecategory=` term, or the
 * term is wildcarded/negated — ambiguity always disables the probe, never guesses.
 */
export function exactSourceCategoryTerm(scope: string): ExactCategoryTerm | undefined {
  const exact = [...scope.matchAll(CATEGORY_TERM_RE)];
  const any = [...scope.matchAll(ANY_CATEGORY_RE)];
  if (exact.length !== 1 || any.length !== 1) return undefined;
  const m = exact[0]!;
  const quoted = m[3] !== undefined;
  return { term: m[2]!, category: (m[3] ?? m[4])!, quoted };
}

/** The scope with the exact term widened to the prefix, plus the count-by aggregation. */
export function buildSiblingProbeQuery(scope: string, exact: ExactCategoryTerm): string {
  const prefixTerm = exact.quoted
    ? `_sourcecategory="${exact.category}*"`
    : `_sourcecategory=${exact.category}*`;
  const widened = scope.replace(exact.term, prefixTerm);
  return `${widened} | count by _sourcecategory | sort by _count | limit 100`;
}

export interface SiblingRow {
  category: string;
  count: number;
}

/** Siblings below this total message volume are noise — stay silent. */
export const SIBLING_VOLUME_FLOOR = 10;

const MAX_LISTED_SIBLINGS = 5;

const nUS = (n: number): string => n.toLocaleString('en-US');

/**
 * Build the COVERAGE note (not an error claim) from the probe rows, or undefined when
 * there are no meaningful siblings (then the plain "genuinely clean" stands alone).
 */
export function buildUnderScopeNote(
  exactCategory: string,
  rows: SiblingRow[],
  exactCountFallback: number,
  floor = SIBLING_VOLUME_FLOOR,
): string | undefined {
  const isExact = (c: string) => c.toLowerCase() === exactCategory.toLowerCase();
  const exactN = rows.find((r) => isExact(r.category))?.count ?? exactCountFallback;
  const siblings = rows
    .filter((r) => !isExact(r.category) && r.count > 0)
    .sort((a, b) => b.count - a.count);
  const total = siblings.reduce((s, r) => s + r.count, 0);
  if (siblings.length === 0 || total < floor) return undefined;
  const listed = siblings
    .slice(0, MAX_LISTED_SIBLINGS)
    .map((r) => `${r.category} (${nUS(r.count)})`)
    .join(', ');
  const restN = siblings.length - Math.min(MAX_LISTED_SIBLINGS, siblings.length);
  const rest = restN > 0 ? ` …and ${restN} more` : '';
  return (
    `you may be under-scoped: scope is the exact category ${exactCategory} (${nUS(exactN)} msgs) — ` +
    `related categories under ${exactCategory}* are NOT included: ${listed}${rest} ` +
    `(total ${nUS(total)} msgs). Re-run with _sourcecategory=${exactCategory}* to cover them.`
  );
}
