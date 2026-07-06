# Changelog

## 0.2.1 — correctness patch

Five confirmed misleading-output fixes plus a describe→digest handoff line. No config
changes; still zero-config (only `SUMO_ACCESS_ID` + `SUMO_ACCESS_KEY`).

### Fixed

- **`sumo_list_alerts` `status` filtered on lifetime state, not current.** It matched any
  state an alert had EVER been in, so a resolved Critical alert (now `[Normal]`) still
  matched `status:["Critical"]` — effectively returning every alert. The filter now
  matches the alert's LATEST state by default. New `statusScope: "latest" | "ever"` param
  (default `"latest"`) restores the old lifetime behavior when explicitly requested.
- **Duplicate alert instances inflated the counts.** Sumo fires DISTINCT alert instances
  (separate alertIds) per monitor evaluation, near-simultaneously. Instances with the
  same `monitorId` fired within ≤5s are now collapsed into one row annotated
  `×N instances`; the summary counts reflect the collapsed rows.
- **`sumo_facets` split int/float forms of a numeric field.** A field emitting both `"2"`
  and `"2.0"` rendered as two indistinguishable rows with split counts. Rows are now
  merged by their coerced numeric key (counts summed), re-sorted desc, and the merged row
  is annotated `(int+float forms)`.
- **`extract` silently produced empty columns.** An extracted path absent on the matched
  rows yielded an all-`""` column with no warning. `sumo_run_search` and
  `sumo_export_results` now count non-empty values per alias and warn
  `extract "<alias>": 0/<N> non-empty — the path may not exist on these rows; run
  sumo_describe_schema.`
- **`sumo_error_digest` calm-clean reads could be under-scoped.** When a digest is about
  to print the CALM "genuinely clean" block for an EXACT `_sourcecategory=<X>` (no
  wildcard), it now runs ONE extra volume-only `count by _sourcecategory` over the `<X>*`
  prefix. If sibling/child categories carry non-trivial volume, it appends a COVERAGE
  note (not an error claim) listing the top-5 siblings and suggesting `_sourcecategory=<X>*`.
  Coverage/volume only — the detected error predicate is never run over the prefix.

### Added

- **describe→digest handoff line**: each ranked candidate in `sumo_describe_schema` output
  now ends with a copy-paste `next: sumo_error_digest query="<scope>" filter='<fragment>'`
  line (fragments are already paste-ready via the shared predicate builder).

## 0.2.0 — schema-learning triage

Behavior + interface changes. The MCP now works out-of-the-box on ANY log schema with
only `SUMO_ACCESS_ID` + `SUMO_ACCESS_KEY` — severity is auto-detected per scope at call
time and every inference is disclosed.

### Added

- **Per-scope severity auto-detection** in `sumo_error_digest`, `sumo_trend`, and the
  `detail:"summary"` side-aggregates of `sumo_run_search`/`sumo_new_since`: one cheap
  aggregate job classifies each `_sourcecategory` (word-level / numeric+typed /
  string-payload), builds a vocabulary/threshold-driven predicate, applies it, and
  **discloses** the predicate, per-category provenance, and a **matched-N-of-M** line.
  Positive detections are memoized in-process (~12 min TTL, LRU); "no-signal" is never
  cached. Fixes the v2 false-clean bug ("scanned 0 messages" over a window with 1,470
  exceptions).
- **Zero-match guardrail**: a filtered zero on a non-empty scope renders a loud
  `!! ZERO MATCHES` block with the next step — never a bare "(no matching messages)".
- **No-signal fallback**: scopes with no detectable severity signal are digested
  UNFILTERED by signature, with an explicit disclosure — cold-start-correct, never silent.
- **`filter` param** on `sumo_error_digest` and `sumo_trend`: a raw fragment applied
  verbatim (skips detection; disclosed as agent-supplied). This is how confirmed,
  agent-remembered semantics are supplied per call.
- **`sumo_describe_schema`** (new tool): thorough propose-only schema learner —
  stratified sampling (never first-N), top-level + nested key enumeration with fill %/
  types/top values, string-payload characterization, per-(category×type) breakdown, and
  ranked paste-ready `filter=` fragments with honest caveats.
- **`sumo_list_alerts`** (new tool): fired-alert history from the documented System
  Event Index (`_index=sumologic_system_events _sourceCategory=alerts`) via the standard
  Search Job API; correlates create/resolve events and returns `monitorId` + monitor
  name join keys to `sumo_list_monitors`.
- **`sumo_list_monitors`**: `status` param (multi-status = multiple API calls unioned
  client-side — the API has no OR), summary header
  (`monitors: matched/total — N Critical, …`), and explicit name-only-substring
  matching caveats (folder paths are not searched).
- `sumo_new_since` `detail:"summary"` now gets the exact whole-job side-aggregate that
  was previously only wired into `sumo_run_search`; sample-only fallbacks are labeled
  loudly (`SAMPLE — first N of M only; not whole-job`).

### Changed (breaking)

- **`sumo_facets` / `sumo_trend` dimension meaning**: non-`_` dimensions/series are now
  **absolute JSON paths from the `_raw` root** (`stream` reaches the top-level envelope
  key; `log.levelname` the nested field). The implicit `log.` prefix is gone — bare dims
  like `levelname` now mean top-level `levelname`. A 100%-`(none)` dimension is annotated
  with a `sumo_describe_schema` hint. Clean break at 0.2.0 (owner decision O3).
- **`sumo_facets` default dimensions** are native-only: `_sourcecategory,_sourcehost`
  (payload-schema defaults lied on non-word-level scopes).
- **`sumo_trend` default series** is the auto-detected severity field (was: hardcoded
  `levelname` via `YOKOZUNA_LEVEL_EXPR`).
- Docstrings and the `triage` prompt are schema-neutral: the universal
  "level is log.levelname / never stream:stderr" guidance was wrong on 2 of 3 live
  schema families and has been replaced with detect-and-disclose guidance.

### Removed (breaking)

- **`YOKOZUNA_LEVEL_EXPR` env / `Config.levelExpr`** — replaced by detection. Setting
  the variable now produces a startup warning naming the replacement (per-call
  `filter=`), not a silent ignore.
- **`sumo_error_digest`'s `levels` param** — a value-list cannot express numeric or
  string-payload severity schemas; use `filter=`.

### Fixed / polish

- Integral float-strings (`"404.0"`, `"2.0"`) display coerced (`404`, `2`) in facets
  keys, trend series, digest levels, and compact/full `status`; docstrings note to match
  numerically (`num(x) = 404`), never by string equality.
- `duration_s` and friends render fixed-point (`0.000715`), never E-notation.
- `dedupe` reworded honestly (groups within the RETURNED page) and `detail:"raw"` +
  `dedupe` keeps one verbatim `_raw` exemplar per group.
- `sumo_error_digest` renders `req=—` when a group has no request id (explicit absence).
- The benign `num()`-on-null field-conversion warning is annotated (never suppressed)
  on jobs where the detected filter itself injected `num()`.
