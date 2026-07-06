import type { SearchJobApi } from './searchJobApi.js';
import { waitForCompletion } from './lifecycle.js';
import { signature } from '../format/formatMessages.js';
import {
  buildPredicate,
  type CategoryClassification,
  type Detection,
} from './detectSchema.js';

/**
 * sumo_describe_schema (v3 §7): the thorough, PROPOSE-ONLY schema learner. It samples a
 * scope with stratified sampling (never first-N), enumerates top-level + nested JSON keys,
 * characterizes string payloads, and closes with ranked paste-ready severity fragments —
 * each carrying its honest caveats. It never applies a filter, never persists anything,
 * never decides.
 *
 * Live rationale for the sampling contract: the only genuine frontend error in the
 * reference org was 1 in 11,306 messages, in a different format on a different stream —
 * first-N sampling concludes "no severity signal exists".
 */

// ------------------------------------------------------------------ sampling plan

export interface Stratum {
  category: string;
  /** Stratification-field value ('' = field absent / no stratification field). */
  value: string;
  count: number;
}

export interface PlanEntry extends Stratum {
  quota: number;
}

/**
 * Allocate the sample across strata: every non-empty stratum gets AT LEAST one slot (this
 * is what puts a 1-in-10k minority stratum into the plan), the remainder is proportional.
 */
export function buildSamplePlan(strata: Stratum[], sampleSize: number): PlanEntry[] {
  const nonEmpty = strata.filter((s) => s.count > 0);
  if (nonEmpty.length === 0) return [];
  const total = nonEmpty.reduce((s, e) => s + e.count, 0);
  const entries: PlanEntry[] = nonEmpty.map((s) => ({ ...s, quota: Math.min(1, s.count) }));
  const remaining = Math.max(0, sampleSize - entries.length);
  for (const e of entries) {
    const extra = Math.min(e.count - e.quota, Math.floor(remaining * (e.count / total)));
    e.quota += extra;
  }
  // Distribute flooring leftovers to the largest strata that still have room.
  let leftover = sampleSize - entries.reduce((s, e) => s + e.quota, 0);
  const byCount = [...entries].sort((a, b) => b.count - a.count);
  for (const e of byCount) {
    if (leftover <= 0) break;
    const room = e.count - e.quota;
    const grant = Math.min(room, leftover);
    e.quota += grant;
    leftover -= grant;
  }
  return entries;
}

// ------------------------------------------------------------------ fetch plan

export interface FetchJob {
  category: string;
  /** Set = a dedicated job for one rare stratum (server-side `where` filter). */
  stratumValue?: string;
  fetchLimit: number;
  /** Plan entries this job is expected to serve. */
  serves: PlanEntry[];
}

const MAX_CATEGORIES = 4;
const MAX_FETCH_JOBS = 6;
/** A stratum below this share of its category gets its own filtered page job. */
const RARE_SHARE = 0.1;

/**
 * Turn the sample plan into a bounded set of page jobs: one shared job per category plus
 * dedicated jobs for RARE strata (a shared page would almost never contain them).
 */
export function buildFetchPlan(
  plan: PlanEntry[],
  stratField: string | undefined,
  maxJobs = MAX_FETCH_JOBS,
): FetchJob[] {
  const byCategory = new Map<string, PlanEntry[]>();
  for (const e of plan) {
    const g = byCategory.get(e.category);
    if (g) g.push(e);
    else byCategory.set(e.category, [e]);
  }
  const categories = [...byCategory.entries()]
    .map(([category, entries]) => ({
      category,
      entries,
      total: entries.reduce((s, e) => s + e.count, 0),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_CATEGORIES);

  const jobs: FetchJob[] = [];
  for (const c of categories) {
    const rare =
      stratField === undefined
        ? []
        : c.entries.filter((e) => c.entries.length > 1 && e.count / c.total < RARE_SHARE);
    const shared = c.entries.filter((e) => !rare.includes(e));
    if (shared.length > 0) {
      const quota = shared.reduce((s, e) => s + e.quota, 0);
      jobs.push({
        category: c.category,
        fetchLimit: Math.min(1000, Math.max(100, quota * 4)),
        serves: shared,
      });
    }
    for (const e of rare) {
      if (jobs.length >= maxJobs) {
        // Job cap: fold the rare stratum back into the shared page (best effort).
        const sharedJob = jobs.find((j) => j.category === c.category && j.stratumValue === undefined);
        if (sharedJob) sharedJob.serves.push(e);
        continue;
      }
      jobs.push({
        category: e.category,
        stratumValue: e.value,
        fetchLimit: Math.min(100, Math.max(10, e.quota * 5)),
        serves: [e],
      });
    }
  }
  return jobs;
}

// ------------------------------------------------------------------ exemplar selection

export interface FetchedMessage {
  raw: string;
  stratumValue: string;
}

/**
 * Within a stratum, spread the picks across message SHAPES: group by signature() and take
 * exemplars round-robin across signatures until the quota — never the first N rows.
 */
export function selectExemplars(messages: FetchedMessage[], quotaByValue: Map<string, number>): FetchedMessage[] {
  const byValue = new Map<string, FetchedMessage[]>();
  for (const m of messages) {
    const g = byValue.get(m.stratumValue);
    if (g) g.push(m);
    else byValue.set(m.stratumValue, [m]);
  }
  const picked: FetchedMessage[] = [];
  for (const [value, quota] of quotaByValue) {
    const pool = byValue.get(value) ?? [];
    if (pool.length === 0) continue;
    const bySig = new Map<string, FetchedMessage[]>();
    for (const m of pool) {
      const sig = signature(m.raw.slice(0, 500));
      const g = bySig.get(sig);
      if (g) g.push(m);
      else bySig.set(sig, [m]);
    }
    const groups = [...bySig.values()];
    let taken = 0;
    let round = 0;
    while (taken < quota) {
      let any = false;
      for (const g of groups) {
        if (taken >= quota) break;
        const m = g[round];
        if (m !== undefined) {
          picked.push(m);
          taken += 1;
          any = true;
        }
      }
      if (!any) break;
      round += 1;
    }
  }
  return picked;
}

// ------------------------------------------------------------------ key enumeration

export type ValueKind =
  | 'string'
  | 'int-string'
  | 'float-string'
  | 'int'
  | 'float'
  | 'bool'
  | 'null'
  | 'object'
  | 'array';

export interface LeafValue {
  path: string;
  kind: ValueKind;
  display: string;
}

function kindOf(v: unknown): ValueKind {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') {
    if (/^-?\d+$/.test(v)) return 'int-string';
    if (/^-?\d+\.\d+$/.test(v)) return 'float-string';
    return 'string';
  }
  return Array.isArray(v) ? 'array' : 'object';
}

function displayOf(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** Flatten one parsed JSON payload into leaf paths, arrays marked `[]`, bounded by maxDepth. */
export function enumeratePaths(value: unknown, maxDepth: number): LeafValue[] {
  const out: LeafValue[] = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    const kind = kindOf(v);
    if (kind === 'object' && depth < maxDepth) {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        walk(child, path === '' ? k : `${path}.${k}`, depth + 1);
      }
      return;
    }
    if (kind === 'array') {
      const arr = v as unknown[];
      const el = arr[0];
      if (el !== undefined && kindOf(el) === 'object' && depth < maxDepth) {
        for (const [k, child] of Object.entries(el as Record<string, unknown>)) {
          walk(child, `${path}[].${k}`, depth + 1);
        }
        return;
      }
      out.push({ path: `${path}[]`, kind: 'array', display: displayOf(v) });
      return;
    }
    out.push({ path, kind, display: displayOf(v) });
  };
  walk(value, '', 0);
  return out;
}

// ------------------------------------------------------------------ field statistics

export interface FieldStats {
  path: string;
  /** Messages (JSON-payload rows) where this path exists. */
  seen: number;
  kinds: Set<ValueKind>;
  topValues: Map<string, number>;
  /** stratumLabel → {seen, of} for per-(category×type) breakdowns. */
  byStratum: Map<string, { seen: number; of: number }>;
}

export interface StringPayloadStats {
  stratumLabel: string;
  lines: number;
  format: string;
  tokenHits: Record<string, number>;
  streamValues: Map<string, number>;
}

export function classifyStringFormat(line: string): string {
  const t = line.trimStart();
  if (t.startsWith('<')) return 'XML-ish blob';
  if (/^\S+ \S+ \S+ \[/.test(t) || /"(?:GET|POST|PUT|DELETE|HEAD|PATCH) /.test(t) || t.includes('HTTP/1.'))
    return 'access-log-like';
  return 'free-text';
}

const TOKEN_PATTERNS: [string, RegExp][] = [
  ['[error]', /\[error\]/i],
  ['[warn]', /\[warn/i],
  ['[crit]', /\[crit\]/i],
  ['exception', /exception/i],
  ['traceback', /traceback/i],
];

export interface SampleProfile {
  jsonRows: number;
  stringRows: number;
  fields: Map<string, FieldStats>;
  stringStats: Map<string, StringPayloadStats>;
  /** Rows per stratum label (denominator for per-stratum fills). */
  rowsByStratum: Map<string, number>;
}

export function profileSample(
  sample: { raw: string; stratumLabel: string }[],
  maxDepth: number,
): SampleProfile {
  const fields = new Map<string, FieldStats>();
  const stringStats = new Map<string, StringPayloadStats>();
  const rowsByStratum = new Map<string, number>();
  let jsonRows = 0;
  let stringRows = 0;

  for (const { raw, stratumLabel } of sample) {
    rowsByStratum.set(stratumLabel, (rowsByStratum.get(stratumLabel) ?? 0) + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed !== null && typeof parsed === 'object') {
      jsonRows += 1;
      for (const leaf of enumeratePaths(parsed, maxDepth)) {
        let st = fields.get(leaf.path);
        if (!st) {
          st = { path: leaf.path, seen: 0, kinds: new Set(), topValues: new Map(), byStratum: new Map() };
          fields.set(leaf.path, st);
        }
        st.seen += 1;
        st.kinds.add(leaf.kind);
        if (st.topValues.size < 30 || st.topValues.has(leaf.display)) {
          st.topValues.set(leaf.display, (st.topValues.get(leaf.display) ?? 0) + 1);
        }
        const bs = st.byStratum.get(stratumLabel) ?? { seen: 0, of: 0 };
        bs.seen += 1;
        st.byStratum.set(stratumLabel, bs);
      }
    } else {
      stringRows += 1;
      let ss = stringStats.get(stratumLabel);
      if (!ss) {
        ss = {
          stratumLabel,
          lines: 0,
          format: classifyStringFormat(raw),
          tokenHits: {},
          streamValues: new Map(),
        };
        stringStats.set(stratumLabel, ss);
      }
      ss.lines += 1;
      for (const [tok, re] of TOKEN_PATTERNS) {
        if (re.test(raw)) ss.tokenHits[tok] = (ss.tokenHits[tok] ?? 0) + 1;
      }
    }
  }
  // Per-stratum denominators.
  for (const st of fields.values()) {
    for (const [label, bs] of st.byStratum) bs.of = rowsByStratum.get(label) ?? bs.seen;
  }
  return { jsonRows, stringRows, fields, stringStats, rowsByStratum };
}

// ------------------------------------------------------------------ candidate proposals

export interface Candidate {
  fragment: string;
  rationale: string;
  caveats: string[];
}

/**
 * Ranked, paste-ready `filter=` fragments. Built through the SAME builder detection uses,
 * so a proposed fragment is exactly what detect-and-disclose would apply.
 */
export function proposeCandidates(
  cats: CategoryClassification[],
  profile: SampleProfile,
): Candidate[] {
  const out: Candidate[] = [];
  const totalOf = (fam: string) =>
    cats.filter((c) => c.family === fam).reduce((s, c) => s + c.total, 0);

  const sev = profile.fields.get('log.severity');
  const floatStringSeverity = sev !== undefined && sev.kinds.has('float-string');
  // Strata where severity NEVER appeared (while it exists elsewhere) — the NULL-severity
  // trap: a severity-only predicate silently misses those rows.
  const nullSeverityStrata: string[] = [];
  if (sev) {
    for (const [label, rows] of profile.rowsByStratum) {
      if (rows >= 3 && (sev.byStratum.get(label)?.seen ?? 0) === 0) nullSeverityStrata.push(label);
    }
  }

  if (cats.some((c) => c.family === 'numeric')) {
    const { fragment } = buildPredicate([
      { category: '', family: 'numeric', total: 1 },
    ]);
    const caveats = [
      'tier ordering assumed from the numeric convention (higher = worse), not observed',
      'values may exist that did not fire in this window (e.g. a "4" tier never seen)',
    ];
    if (nullSeverityStrata.length > 0) {
      caveats.push(
        `type=exception rows have NULL severity (observed on: ${nullSeverityStrata.join(', ')}) — a severity-only predicate misses them`,
      );
    } else {
      caveats.push('rows of some log.type values may carry NULL severity — a severity-only predicate misses them');
    }
    if (floatStringSeverity) {
      caveats.push('float-string severities (e.g. "2.0") observed — match via num(), never string equality');
    }
    out.push({
      fragment: fragment!.trim(),
      rationale: `numeric/typed family (${totalOf('numeric').toLocaleString('en-US')} msgs in scope)`,
      caveats,
    });
  }

  for (const field of [
    ...new Set(cats.filter((c) => c.family === 'word').map((c) => c.levelField!)),
  ]) {
    const { fragment } = buildPredicate([
      { category: '', family: 'word', total: 1, levelField: field },
    ]);
    out.push({
      fragment: fragment!.trim(),
      rationale: `word-level family via ${field} (${totalOf('word').toLocaleString('en-US')} msgs in scope)`,
      caveats: ['level vocabulary is fixed, not observed — tiers that never fired are still matched'],
    });
  }

  const stringCats = cats.filter((c) => c.family === 'string');
  const sampledStringTokens = [...profile.stringStats.values()].some(
    (s) => Object.keys(s.tokenHits).length > 0,
  );
  if (stringCats.length > 0 || sampledStringTokens) {
    const tokens = [
      ...new Set(stringCats.flatMap((c) => c.tokens ?? ['[error]', '[crit]'])),
    ];
    const toks = tokens.length > 0 ? tokens : ['[error]', '[crit]'];
    out.push({
      fragment: `(${toks.map((t) => `"${t}"`).join(' OR ')})`,
      rationale: 'string payload — severity token keywords',
      caveats: [
        'no severity field exists in these payloads; other candidates: stream=stderr, HTTP status >= 500 via parse regex',
        'tokens can be 100% benign noise (e.g. scanner probes hitting /wp-login.php) — confirm semantics before trusting',
      ],
    });
  }

  // Rank by in-scope coverage (message volume of the family behind each candidate).
  const volume = (c: Candidate) =>
    c.rationale.startsWith('numeric')
      ? totalOf('numeric')
      : c.rationale.startsWith('word')
        ? totalOf('word')
        : totalOf('string');
  return out.sort((a, b) => volume(b) - volume(a));
}

// ------------------------------------------------------------------ rendering

const MAX_FIELDS_LISTED = 40;

export function renderDescription(args: {
  scope: string;
  rangeLabel: string;
  stratField: string | undefined;
  plan: PlanEntry[];
  sampledCount: number;
  profile: SampleProfile;
  cats: CategoryClassification[];
  candidates: Candidate[];
  notes: string[];
}): string {
  const { plan, profile } = args;
  const lines: string[] = [];
  const strataLabel = args.stratField
    ? `stratified by _sourcecategory × ${args.stratField}`
    : 'stratified by _sourcecategory';
  lines.push(`schema description: ${args.scope}`);
  lines.push(
    `range: ${args.rangeLabel} — sampled ${args.sampledCount} messages across ${plan.length} strata (${strataLabel}; signature-spread, never first-N)`,
  );
  for (const n of args.notes) lines.push(n);

  lines.push('');
  lines.push('strata (from exact counts):');
  const planTotal = plan.reduce((s, e) => s + e.count, 0);
  for (const e of [...plan].sort((a, b) => b.count - a.count).slice(0, 12)) {
    const label = e.value === '' ? '' : ` × ${args.stratField}=${e.value}`;
    const pct = planTotal > 0 ? ((e.count / planTotal) * 100).toFixed(1) : '0.0';
    lines.push(
      `  ${e.category || '(no category)'}${label}: ${e.count.toLocaleString('en-US')} msgs (${pct}%), sample quota ${e.quota}`,
    );
  }
  if (plan.length > 12) lines.push(`  … (+${plan.length - 12} more strata)`);

  if (profile.fields.size > 0) {
    lines.push('');
    lines.push(`fields (JSON payloads; fill = % of ${profile.jsonRows} sampled JSON rows):`);
    const ranked = [...profile.fields.values()].sort((a, b) => b.seen - a.seen);
    for (const f of ranked.slice(0, MAX_FIELDS_LISTED)) {
      const fill = profile.jsonRows > 0 ? ((f.seen / profile.jsonRows) * 100).toFixed(0) : '0';
      const kinds = [...f.kinds].join('|');
      const floatNote = f.kinds.has('float-string') ? ' (float-strings like "2.0" present)' : '';
      const top = [...f.topValues.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([v, n]) => `${JSON.stringify(v)}×${n}`)
        .join(' ');
      let strataNote = '';
      if (f.byStratum.size > 1) {
        const fills = [...f.byStratum.entries()]
          .filter(([, bs]) => bs.of > 0)
          .map(([label, bs]) => [label, bs.seen / bs.of] as const);
        const min = Math.min(...fills.map(([, x]) => x));
        const max = Math.max(...fills.map(([, x]) => x));
        if (max - min >= 0.25) {
          strataNote =
            '; by stratum: ' +
            fills.map(([label, x]) => `${label}→${(x * 100).toFixed(0)}%`).join(', ');
        }
      }
      lines.push(`  ${f.path}: fill ${fill}% — ${kinds}${floatNote}; top: ${top}${strataNote}`);
    }
    if (ranked.length > MAX_FIELDS_LISTED) {
      lines.push(`  … (+${ranked.length - MAX_FIELDS_LISTED} more fields)`);
    }
  }

  if (profile.stringStats.size > 0) {
    lines.push('');
    lines.push('string payloads (non-JSON rows — characterized, not skipped):');
    for (const s of profile.stringStats.values()) {
      const toks =
        Object.entries(s.tokenHits)
          .map(([t, n]) => `${t}×${n}`)
          .join(' ') || 'none in sample';
      lines.push(`  ${s.stratumLabel}: format=${s.format}, ${s.lines} sampled lines, severity-ish tokens: ${toks}`);
    }
  }

  lines.push('');
  if (args.candidates.length === 0) {
    lines.push(
      'candidate severity filters: NONE — no severity-ish signal found in the vocabulary or the sample. Inspect the field list above and hand-write a filter= from what this system actually emits.',
    );
  } else {
    lines.push('candidate severity filters (ranked; paste into filter= as-is):');
    args.candidates.forEach((c, i) => {
      lines.push(`  ${i + 1}. ${c.fragment}`);
      lines.push(`     basis: ${c.rationale}`);
      for (const cv of c.caveats) lines.push(`     caveat: ${cv}`);
    });
  }
  lines.push('');
  lines.push(
    'describe_schema PROPOSES — you decide: syntax is detectable, but whether a signal is a real incident is YOUR judgment. Record what you confirm in your own memory (CLAUDE.md / notes) and pass filter= on later calls.',
  );
  return lines.join('\n');
}

// ------------------------------------------------------------------ orchestration

export interface DescribeDeps {
  api: SearchJobApi;
  timeZone: string;
  byReceiptTime?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface DescribeInput {
  scope: string;
  range: { from: string | number; to: string | number };
  rangeLabel: string;
  sampleSize: number;
  stratifyBy?: string;
  maxDepth: number;
}

const STRAT_FILL_MIN = 0.05;

/** Pick the stratification field from detection Job-1 fills (log.type first, then stream). */
export function pickStratField(cats: CategoryClassification[]): string | undefined {
  const anyFill = (get: (f: NonNullable<CategoryClassification['fills']>) => number) =>
    cats.some((c) => c.fills !== undefined && c.total > 0 && get(c.fills) / c.total >= STRAT_FILL_MIN);
  if (anyFill((f) => f.typeN)) return 'log.type';
  if (anyFill((f) => f.streamN)) return 'stream';
  return undefined;
}

async function runJob<T>(
  deps: DescribeDeps,
  query: string,
  range: DescribeInput['range'],
  read: (api: SearchJobApi, id: string) => Promise<T>,
): Promise<T> {
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
    return await read(deps.api, jobId);
  } finally {
    // SIGNAL-FREE cleanup (an aborted signal here would leak the job).
    if (jobId) await deps.api.delete(jobId, { tolerateMissing: true }).catch(() => undefined);
  }
}

const quoteCat = (c: string) => `_sourcecategory="${c.replace(/"/g, '')}"`;

/**
 * Full describe run. `detection` is the (possibly cached) §3 Job-1 result the caller
 * already holds — reused here for families and strata-field discovery.
 */
export async function describeSchema(
  deps: DescribeDeps,
  detection: Detection,
  input: DescribeInput,
): Promise<string> {
  const notes: string[] = [];
  const stratField = input.stratifyBy ?? pickStratField(detection.categories);

  // Strata discovery: exact per-stratum counts (one aggregate) when a strat field exists;
  // otherwise the detection Job-1 category totals are already the strata.
  let strata: Stratum[];
  if (stratField !== undefined) {
    deps.onProgress?.('strata discovery');
    const rows = await runJob(
      deps,
      `${input.scope} | json field=_raw "${stratField}" as yz_s nodrop | count by _sourcecategory, yz_s`,
      input.range,
      async (api, id) => (await api.records(id, 0, 1000, deps.signal)).records ?? [],
    );
    strata = rows.map((r) => ({
      category: r.map['_sourcecategory'] ?? '',
      value: r.map['yz_s'] ?? '',
      count: Number(r.map['_count'] ?? 0) || 0,
    }));
  } else {
    strata = detection.categories.map((c) => ({ category: c.category, value: '', count: c.total }));
  }

  const plan = buildSamplePlan(strata, input.sampleSize);
  if (plan.length === 0) {
    return `schema description: ${input.scope}\nrange: ${input.rangeLabel}\nscope is EMPTY in this range — nothing to learn. Check the range/scope; consider byReceiptTime: true.`;
  }
  const fetchJobs = buildFetchPlan(plan, stratField);
  const skippedCats = new Set(plan.map((e) => e.category)).size - new Set(fetchJobs.map((j) => j.category)).size;
  if (skippedCats > 0) {
    notes.push(
      `note: sampled the ${MAX_CATEGORIES} largest categories only (${skippedCats} smaller categor${skippedCats === 1 ? 'y' : 'ies'} skipped — narrow the scope to learn them).`,
    );
  }

  // Fetch pages (concurrent; the client rate-limiter paces the requests).
  const sample: { raw: string; stratumLabel: string }[] = [];
  await Promise.all(
    fetchJobs.map(async (job) => {
      const catTerm = job.category === '' ? '' : ` ${quoteCat(job.category)}`;
      const stratClause =
        job.stratumValue !== undefined && stratField !== undefined
          ? ` | json field=_raw "${stratField}" as yz_s nodrop | where yz_s = "${job.stratumValue.replace(/"/g, '')}"`
          : '';
      deps.onProgress?.(`sampling ${job.category || '(no category)'}${job.stratumValue ? `×${job.stratumValue}` : ''}`);
      try {
        const messages = await runJob(
          deps,
          `${input.scope}${catTerm}${stratClause}`,
          input.range,
          async (api, id) => (await api.messages(id, 0, job.fetchLimit, deps.signal)).messages ?? [],
        );
        const fetched: FetchedMessage[] = messages.map((m) => {
          const raw = m.map['_raw'] ?? '';
          let value = '';
          if (stratField !== undefined) {
            try {
              const parsed: unknown = JSON.parse(raw);
              let v: unknown = parsed;
              for (const part of stratField.split('.')) {
                v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
              }
              if (typeof v === 'string') value = v;
              else if (typeof v === 'number') value = String(v);
            } catch {
              value = '';
            }
          }
          return { raw, stratumValue: job.stratumValue ?? value };
        });
        const quotas = new Map(job.serves.map((e) => [e.value, e.quota]));
        // A dedicated rare-stratum job pre-filtered server-side: everything is that stratum.
        if (job.stratumValue !== undefined) quotas.set(job.stratumValue, job.serves[0]?.quota ?? 1);
        const picked = selectExemplars(fetched, quotas);
        for (const p of picked) {
          const label =
            stratField !== undefined && p.stratumValue !== ''
              ? `${job.category || '(no category)'}×${p.stratumValue}`
              : job.category || '(no category)';
          sample.push({ raw: p.raw, stratumLabel: label });
        }
      } catch (err) {
        notes.push(
          `note: sampling failed for ${job.category || '(no category)'}${job.stratumValue ? `×${job.stratumValue}` : ''}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  const profile = profileSample(sample, input.maxDepth);
  const candidates = proposeCandidates(detection.categories, profile);
  return renderDescription({
    scope: input.scope,
    rangeLabel: input.rangeLabel,
    stratField,
    plan,
    sampledCount: sample.length,
    profile,
    cats: detection.categories,
    candidates,
    notes,
  });
}
