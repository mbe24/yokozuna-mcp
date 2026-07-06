import type { SearchJobApi } from './searchJobApi.js';
import { waitForCompletion } from './lifecycle.js';

/**
 * Lite severity-schema auto-detection (v3 §3): one cheap aggregate job classifies every
 * `_sourcecategory` in scope into a schema family, a second (only when string payloads are
 * present) counts severity tokens. From that a fixed-form, vocabulary/threshold-driven
 * predicate is built — NEVER an observed-value list (live proof: on a numeric-family
 * system the error tier `severity=4` never fired in a 4h window; an observed-value
 * predicate would drop the whole error tier).
 *
 * The candidate vocabulary below is a fixed constant: deliberately generic industry
 * vocabulary, not org knowledge. Adding a candidate is a code change with tests, never config.
 */

/** Bump when the candidate vocabulary / thresholds change — part of the cache key. */
export const DETECT_VOCAB_VERSION = 2;

export type SchemaFamily = 'word' | 'numeric' | 'string' | 'none';

/**
 * The COMPLETE Job-1 probe vocabulary — the only payload fields detection ever inspects.
 * Deliberately generic industry vocabulary; a test locks it to exactly this set so an
 * org-specific field can never ship here.
 */
export const CANDIDATE_FIELDS = [
  'log.levelname',
  'log.level',
  'log.severity',
  'log.loglevel',
  'log.type',
  'stream',
] as const;

/** Word-level candidate fields (family A), in vocabulary order. */
const WORD_FIELDS = ['log.levelname', 'log.level', 'log.loglevel'] as const;

/**
 * Enumerated case variants for the word-level predicate: Sumo `where … in (…)` string
 * comparison is case-sensitive; this enumerated list is the validated-safe form.
 */
export const WORD_LEVEL_VALUES = [
  'ERROR', 'Error', 'error', 'ERR',
  'WARNING', 'Warning', 'warning', 'WARN', 'Warn', 'warn',
  'CRITICAL', 'Critical', 'critical', 'CRIT',
  'FATAL', 'Fatal', 'fatal',
  'SEVERE', 'Severe', 'severe',
] as const;

/** Fixed token vocabulary for string payloads (family C). */
export const STRING_TOKENS = ['[error]', '[warn]', '[crit]', 'exception', 'traceback'] as const;

/**
 * Family-B severity STRING enums: live data shows `log.severity` occasionally carries the
 * STRING "Error"/"Warning" (not numeric, not "Fatal") — `num()` misses those rows, and
 * Sumo's `in (…)` comparison is case-sensitive, hence the enumerated case variants.
 */
export const NUMERIC_SEVERITY_ENUMS = [
  'Fatal',
  'Error', 'ERROR', 'error',
  'Warning', 'WARNING', 'warning',
] as const;

/**
 * Classification thresholds (§3.2). Live rationale: numeric-family severity lives on only some
 * of ~9 `log.type`s (hence the 1% floor on severity), and observed family boundaries in the
 * wild were far from these lines.
 */
const JSON_FRACTION_MIN = 0.5;
const WORD_FILL_MIN = 0.05;
const SEVERITY_FILL_MIN = 0.01;
const TYPE_FILL_MIN = 0.05;

export interface CategoryClassification {
  category: string;
  family: SchemaFamily;
  total: number;
  /** Family `word`: the picked level field (highest fill of the word candidates). */
  levelField?: string;
  /** Family `string`: predicate tokens (fixed sub-vocabulary, includes never-fired tiers). */
  tokens?: string[];
  /** Family `string`: raw token hit counts from Job 2 (disclosure context). */
  tokenHits?: Record<string, number>;
  /** Family `string`: `stream=stderr` co-occurrence count (disclosure context ONLY). */
  stderrN?: number;
  /** Raw Job-1 fill counters (consumed by sumo_describe_schema's strata discovery). */
  fills?: CategoryFills;
}

export interface Detection {
  categories: CategoryClassification[];
  /** M — the scope total across categories (matched-N-of-M denominator; free from Job 1). */
  scopeTotal: number;
  /** Fragment appended verbatim after the scope; undefined = no severity signal anywhere. */
  predicate?: string;
  /** Predicate applies num() — used to annotate the benign field-conversion warning. */
  usesNum: boolean;
  /** Dominant family with a signal (largest message total) — drives trend/summary choices. */
  primary?: { family: SchemaFamily; field?: string };
  /** "K categor(y/ies) in scope — cat→family, …" (disclosure line). */
  detectedFromLine: string;
  /** Search jobs the detection ran (0 when served from cache). */
  jobsRun: number;
  /** Set when this detection was served from the in-process cache. */
  cachedAgeMs?: number;
}

// ------------------------------------------------------------------ query builders

/**
 * Job 1 (§3.1): per-category JSON fraction + candidate-field fill counters. Always one job.
 * Fill tests use `isBlank()` — live-verified (EU, 2026-07-06): a nodrop-missing field is
 * NULL in the pipeline and `if(d != "", 1, 0)` evaluates to 1 for it, which would count
 * every candidate as 100% filled; `isBlank()` treats null and "" alike.
 */
export function buildClassificationQuery(scope: string): string {
  return (
    `${scope}` +
    ' | json field=_raw "log.levelname" as d_levelname nodrop' +
    ' | json field=_raw "log.level" as d_level nodrop' +
    ' | json field=_raw "log.severity" as d_severity nodrop' +
    ' | json field=_raw "log.loglevel" as d_loglevel nodrop' +
    ' | json field=_raw "log.type" as d_type nodrop' +
    ' | json field=_raw "stream" as d_stream nodrop' +
    ' | if(_raw matches "{*", 1, 0) as is_json' +
    ' | if(isBlank(d_levelname), 0, 1) as f_levelname' +
    ' | if(isBlank(d_level), 0, 1) as f_level' +
    ' | if(isBlank(d_severity), 0, 1) as f_severity' +
    ' | if(isBlank(d_loglevel), 0, 1) as f_loglevel' +
    ' | if(isBlank(d_type), 0, 1) as f_type' +
    ' | if(isBlank(d_stream), 0, 1) as f_stream' +
    ' | sum(is_json) as json_n, sum(f_levelname) as levelname_n, sum(f_level) as level_n,' +
    ' sum(f_severity) as severity_n, sum(f_loglevel) as loglevel_n, sum(f_type) as type_n,' +
    ' sum(f_stream) as stream_n, count as total by _sourcecategory'
  );
}

/** Job 2 (§3.3): token counts for the family-C categories only. */
export function buildTokenQuery(scope: string, categories: string[]): string {
  const named = categories.filter((c) => c !== '');
  const catTerms = named.map((c) => `_sourcecategory="${c.replace(/"/g, '')}"`);
  const catFilter =
    catTerms.length === 0 ? '' : catTerms.length === 1 ? ` ${catTerms[0]}` : ` (${catTerms.join(' OR ')})`;
  return (
    `${scope}${catFilter}` +
    ' | json field=_raw "stream" as d_stream nodrop' +
    ' | if(_raw matches "*[error]*", 1, 0) as t_error' +
    ' | if(_raw matches "*[warn*", 1, 0) as t_warn' +
    ' | if(_raw matches "*[crit]*", 1, 0) as t_crit' +
    ' | if(_raw matches "*exception*", 1, 0) as t_exc' +
    ' | if(_raw matches "*traceback*", 1, 0) as t_tb' +
    ' | if(d_stream = "stderr", 1, 0) as on_stderr' +
    ' | sum(t_error) as error_n, sum(t_warn) as warn_n, sum(t_crit) as crit_n,' +
    ' sum(t_exc) as exc_n, sum(t_tb) as tb_n, sum(on_stderr) as stderr_n,' +
    ' count as total by _sourcecategory'
  );
}

// ------------------------------------------------------------------ classification

export interface CategoryFills {
  category: string;
  total: number;
  jsonN: number;
  levelnameN: number;
  levelN: number;
  severityN: number;
  loglevelN: number;
  typeN: number;
  streamN: number;
}

export function parseFillsRow(map: Record<string, string>): CategoryFills {
  const n = (k: string) => Number(map[k] ?? 0) || 0;
  return {
    category: map['_sourcecategory'] ?? '',
    total: n('total'),
    jsonN: n('json_n'),
    levelnameN: n('levelname_n'),
    levelN: n('level_n'),
    severityN: n('severity_n'),
    loglevelN: n('loglevel_n'),
    typeN: n('type_n'),
    streamN: n('stream_n'),
  };
}

/** §3.2 per-category family classification. String categories still need Job 2 (tokens). */
export function classifyCategory(f: CategoryFills): CategoryClassification {
  const base = { category: f.category, total: f.total, fills: f };
  if (f.total <= 0) return { ...base, family: 'none' };
  if (f.jsonN / f.total < JSON_FRACTION_MIN) return { ...base, family: 'string' };
  const wordFills: [string, number][] = [
    [WORD_FIELDS[0], f.levelnameN],
    [WORD_FIELDS[1], f.levelN],
    [WORD_FIELDS[2], f.loglevelN],
  ];
  const bestWord = wordFills.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (bestWord[1] / f.total >= WORD_FILL_MIN) {
    return { ...base, family: 'word', levelField: bestWord[0] };
  }
  if (f.severityN / f.total >= SEVERITY_FILL_MIN || f.typeN / f.total >= TYPE_FILL_MIN) {
    return { ...base, family: 'numeric' };
  }
  // Never guess beyond the vocabulary — disclose and point at sumo_describe_schema.
  return { ...base, family: 'none' };
}

export interface TokenCounts {
  category: string;
  errorN: number;
  warnN: number;
  critN: number;
  excN: number;
  tbN: number;
  stderrN: number;
}

export function parseTokenRow(map: Record<string, string>): TokenCounts {
  const n = (k: string) => Number(map[k] ?? 0) || 0;
  return {
    category: map['_sourcecategory'] ?? '',
    errorN: n('error_n'),
    warnN: n('warn_n'),
    critN: n('crit_n'),
    excN: n('exc_n'),
    tbN: n('tb_n'),
    stderrN: n('stderr_n'),
  };
}

/**
 * Which categories get the token job (§3.3): string-payload categories, PLUS
 * JSON-but-no-vocabulary ("none") categories — live-verified (EU, 2026-07-06): an nginx
 * frontend emits the k8s JSON envelope with a plain-STRING `log` payload, so the JSON
 * fraction is ~100% while the only severity signal is an `[error]` token inside the
 * string. Token probing is the same fixed vocabulary either way — no guessing added.
 */
export function tokenCandidates(cats: CategoryClassification[]): CategoryClassification[] {
  return cats.filter((c) => (c.family === 'string' || c.family === 'none') && c.total > 0);
}

/**
 * Fold Job-2 token counts into the token-candidate categories. A candidate where NO
 * token fired at all is (or becomes) no-signal. Predicate tokens follow rule zero:
 * always the full `[error]`/`[crit]` tier sub-vocabulary (even at 0 hits), plus
 * `exception`/`traceback` only when the scope showed any hits for them.
 */
export function applyTokenCounts(
  cats: CategoryClassification[],
  tokenRows: TokenCounts[],
): CategoryClassification[] {
  const byCat = new Map(tokenRows.map((t) => [t.category, t]));
  return cats.map((c) => {
    if (c.family !== 'string' && c.family !== 'none') return c;
    const t = byCat.get(c.category);
    if (!t || t.errorN + t.warnN + t.critN + t.excN + t.tbN === 0) {
      return { category: c.category, total: c.total, family: 'none' as const, fills: c.fills };
    }
    const tokens = ['[error]', '[crit]'];
    if (t.excN > 0) tokens.push('exception');
    if (t.tbN > 0) tokens.push('traceback');
    return {
      ...c,
      family: 'string' as const,
      tokens,
      tokenHits: {
        '[error]': t.errorN,
        '[warn]': t.warnN,
        '[crit]': t.critN,
        exception: t.excN,
        traceback: t.tbN,
      },
      stderrN: t.stderrN,
    };
  });
}

// ------------------------------------------------------------------ predicate construction

export interface BuiltPredicate {
  /** Fragment to append verbatim after the scope; undefined = no signal (NEVER match-all). */
  fragment?: string;
  usesNum: boolean;
}

const wordAlias = (field: string): string => `yz_${field.replace(/\./g, '_')}`;

/** The family-A `where` membership list (shared with describe_schema's proposals). */
export function wordLevelInList(): string {
  return WORD_LEVEL_VALUES.map((v) => `"${v}"`).join(',');
}

/**
 * §3.4/§3.5: fixed-form predicates, unioned across families with all extractions nodrop'd.
 * Family-C keyword terms cannot live in a post-pipe `where` — a PURE string scope gets a
 * keyword clause; mixed scopes use `_raw matches` terms inside the single `where`.
 */
export function buildPredicate(cats: CategoryClassification[]): BuiltPredicate {
  const wordFields = [...new Set(cats.filter((c) => c.family === 'word').map((c) => c.levelField!))];
  const hasNumeric = cats.some((c) => c.family === 'numeric');
  const stringTokens = [
    ...new Set(cats.filter((c) => c.family === 'string').flatMap((c) => c.tokens ?? [])),
  ];

  if (wordFields.length === 0 && !hasNumeric) {
    if (stringTokens.length === 0) return { usesNum: false };
    // Pure string-payload scope: keyword clause (index-served, validated form).
    return { fragment: ` (${stringTokens.map((t) => `"${t}"`).join(' OR ')})`, usesNum: false };
  }

  const extractions: string[] = [];
  const terms: string[] = [];
  for (const f of wordFields) {
    extractions.push(`| json field=_raw "${f}" as ${wordAlias(f)} nodrop`);
    terms.push(`${wordAlias(f)} in (${wordLevelInList()})`);
  }
  if (hasNumeric) {
    extractions.push('| json field=_raw "log.severity" as yz_sev nodrop');
    extractions.push('| json field=_raw "log.type" as yz_type nodrop');
    // num() handles "3" and float-strings "3.0"; type=exception catches the NULL-severity
    // exception rows (the real errors on this family); the in(…) list catches the string
    // enums num() misses — "Fatal", plus live-observed "Error"/"Warning" case variants.
    const enums = NUMERIC_SEVERITY_ENUMS.map((v) => `"${v}"`).join(',');
    terms.push(`num(yz_sev) >= 3 or yz_sev in (${enums}) or yz_type = "exception"`);
  }
  if (stringTokens.length > 0) {
    terms.push(stringTokens.map((t) => `_raw matches "*${t}*"`).join(' or '));
  }
  const where = terms.length === 1 ? terms[0]! : terms.map((t) => `(${t})`).join(' or ');
  return { fragment: ` ${extractions.join(' ')} | where ${where}`, usesNum: hasNumeric };
}

// ------------------------------------------------------------------ disclosure helpers

const FAMILY_LABELS: Record<SchemaFamily, (c: CategoryClassification) => string> = {
  word: (c) => `word-level(${c.levelField})`,
  numeric: () => 'numeric+type(log.severity/log.type)',
  string: () => 'string-tokens',
  none: () => 'no-signal',
};

const MAX_DISCLOSED_CATEGORIES = 6;

export function buildDetectedFromLine(cats: CategoryClassification[]): string {
  const shown = cats.slice(0, MAX_DISCLOSED_CATEGORIES);
  const parts = shown.map((c) => `${c.category || '(no category)'}→${FAMILY_LABELS[c.family](c)}`);
  const more = cats.length > shown.length ? ` … (+${cats.length - shown.length} more)` : '';
  return `${cats.length} categor${cats.length === 1 ? 'y' : 'ies'} in scope — ${parts.join(', ')}${more}`;
}

/** Dominant family with a signal (by message volume) — drives trend series / summary counts. */
export function pickPrimary(
  cats: CategoryClassification[],
): { family: SchemaFamily; field?: string } | undefined {
  const totals = new Map<SchemaFamily, number>();
  for (const c of cats) {
    if (c.family === 'none') continue;
    totals.set(c.family, (totals.get(c.family) ?? 0) + c.total);
  }
  if (totals.size === 0) return undefined;
  const family = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  if (family === 'word') {
    const wordCats = cats.filter((c) => c.family === 'word').sort((a, b) => b.total - a.total);
    return { family, field: wordCats[0]!.levelField };
  }
  return { family };
}

/**
 * §4.4 refinement: a zero-match may only read as CALM ("genuinely clean") when the
 * detected severity field(s) are present on at least this share of in-scope messages.
 */
export const CONFIDENT_FILL_MIN = 0.5;

/**
 * Confidence signal for the zero-match guardrail: sums the Job-1 fill of each positive
 * category's chosen field (word: the picked level field; numeric: the better-filled of
 * log.severity/log.type) and compares it to the scope total. String-token families never
 * qualify — a token that fired at detection time but matches 0 in the digest window is
 * exactly the mismatch the loud alarm exists for. Returns undefined below
 * CONFIDENT_FILL_MIN (keep the loud alarm); otherwise the field label + fill count for
 * the calm "genuinely clean" rendering.
 */
export function confidentZeroFill(det: Detection): { label: string; fillN: number } | undefined {
  if (det.scopeTotal <= 0) return undefined;
  let fillN = 0;
  const wordFields = new Set<string>();
  let numeric = false;
  for (const c of det.categories) {
    const f = c.fills;
    if (f === undefined) continue;
    if (c.family === 'word' && c.levelField !== undefined) {
      fillN +=
        c.levelField === 'log.levelname' ? f.levelnameN
        : c.levelField === 'log.level' ? f.levelN
        : c.levelField === 'log.loglevel' ? f.loglevelN
        : 0;
      wordFields.add(c.levelField);
    } else if (c.family === 'numeric') {
      fillN += Math.max(f.severityN, f.typeN);
      numeric = true;
    }
  }
  if (wordFields.size === 0 && !numeric) return undefined;
  if (fillN / det.scopeTotal < CONFIDENT_FILL_MIN) return undefined;
  const parts: string[] = [];
  if (wordFields.size > 0) parts.push(`level field (${[...wordFields].join(', ')})`);
  if (numeric) parts.push('severity/type fields (log.severity, log.type)');
  return { label: parts.join(' + '), fillN };
}

/**
 * §3.6: the benign `num()`-on-null field-conversion warning. Only annotated (never
 * suppressed) and only on jobs where WE injected a num() predicate.
 */
export function annotateNumWarnings(warnings: string[], usesNum: boolean): string[] {
  if (!usesNum) return warnings;
  return warnings.map((w) =>
    isNumConversionWarning(w)
      ? `${w} (expected when the detected filter applies num() to rows without that field — benign)`
      : w,
  );
}

export function isNumConversionWarning(w: string): boolean {
  return /field/i.test(w) && /(convert|conversion|cast|pars)/i.test(w) && /(num|double|long|int)/i.test(w);
}

// ------------------------------------------------------------------ in-process memoization

/**
 * O1 (owner-approved): cache POSITIVE detections only, keyed by normalized scope +
 * vocabulary version, short TTL, LRU-capped. NEVER cache a no-signal result — a stale
 * no-signal is a false-clean generator, the exact bug this design kills. No files: the
 * cache dies with the process.
 */
export class DetectionCache {
  private readonly entries = new Map<string, { det: Detection; at: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 12 * 60_000;
    this.maxEntries = opts.maxEntries ?? 64;
    this.now = opts.now ?? Date.now;
  }

  private key(scope: string): string {
    return `${DETECT_VOCAB_VERSION}:${scope.trim().replace(/\s+/g, ' ')}`;
  }

  get(scope: string): { det: Detection; ageMs: number } | undefined {
    const k = this.key(scope);
    const e = this.entries.get(k);
    if (!e) return undefined;
    const ageMs = this.now() - e.at;
    if (ageMs > this.ttlMs) {
      this.entries.delete(k);
      return undefined;
    }
    // LRU touch.
    this.entries.delete(k);
    this.entries.set(k, e);
    return { det: e.det, ageMs };
  }

  set(scope: string, det: Detection): void {
    if (det.predicate === undefined) return; // never cache no-signal
    const k = this.key(scope);
    if (!this.entries.has(k) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(k, { det, at: this.now() });
  }
}

/** Compact age label for the `(detection cached, <age>)` disclosure suffix. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

// ------------------------------------------------------------------ orchestration

export interface DetectDeps {
  api: SearchJobApi;
  timeZone: string;
  byReceiptTime?: boolean;
  signal?: AbortSignal;
  cache?: DetectionCache;
}

async function runAggregate(
  deps: DetectDeps,
  query: string,
  range: { from: string | number; to: string | number },
): Promise<Record<string, string>[]> {
  let jobId: string | undefined;
  try {
    const created = await deps.api.create(
      {
        query,
        from: range.from,
        to: range.to,
        timeZone: deps.timeZone,
        byReceiptTime: deps.byReceiptTime,
      },
      deps.signal,
    );
    jobId = created.id;
    await waitForCompletion(deps.api, jobId, { timeoutMs: 120_000, signal: deps.signal });
    const page = await deps.api.records(jobId, 0, 1000, deps.signal);
    return (page.records ?? []).map((r) => r.map);
  } finally {
    // SIGNAL-FREE cleanup (an aborted signal here would leak the job).
    if (jobId) await deps.api.delete(jobId, { tolerateMissing: true }).catch(() => undefined);
  }
}

/**
 * Run detection over a scope + range: Job 1 always, Job 2 only when string-payload
 * categories are present. Both jobs auto-deleted. Positive results are memoized when a
 * cache is supplied; no-signal re-detects every call (cheap — no-signal scopes are rare).
 */
export async function detectSchema(
  deps: DetectDeps,
  scope: string,
  range: { from: string | number; to: string | number },
): Promise<Detection> {
  if (deps.cache) {
    const hit = deps.cache.get(scope);
    if (hit) return { ...hit.det, cachedAgeMs: hit.ageMs, jobsRun: 0 };
  }

  let jobsRun = 1;
  const fills = (await runAggregate(deps, buildClassificationQuery(scope), range)).map(parseFillsRow);
  let cats = fills.map(classifyCategory);

  const candidates = tokenCandidates(cats);
  if (candidates.length > 0) {
    jobsRun += 1;
    const tokenRows = (
      await runAggregate(deps, buildTokenQuery(scope, candidates.map((c) => c.category)), range)
    ).map(parseTokenRow);
    cats = applyTokenCounts(cats, tokenRows);
  }

  const { fragment, usesNum } = buildPredicate(cats);
  const det: Detection = {
    categories: cats,
    scopeTotal: cats.reduce((s, c) => s + c.total, 0),
    predicate: fragment,
    usesNum,
    primary: pickPrimary(cats),
    detectedFromLine: buildDetectedFromLine(cats),
    jobsRun,
  };
  if (deps.cache && det.predicate !== undefined) deps.cache.set(scope, det);
  return det;
}
