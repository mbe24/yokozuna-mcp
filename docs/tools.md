# Tools reference

| Tool | Purpose | Key inputs |
|---|---|---|
| `sumo_run_search` | **Workhorse.** Create job → wait → fetch first N results → auto-delete. One call for the common case. | `query`, time range, `limit` (≤5000), `detail`, `fields`, `dedupe`, `sort`, `format`, `extract`, `keepJob` |
| `sumo_create_search_job` | Primitive: create only, returns the job id (kept alive by the server in the background). | `query`, time range |
| `sumo_get_search_job_status` | Primitive: poll state/counts. | `id` |
| `sumo_get_messages` | Primitive: page raw messages (non-aggregate jobs). | `id`, `offset`, `limit` (≤10000), `detail`, `fields`, `sort`, … |
| `sumo_get_records` | Primitive: page aggregate records (aggregate jobs). | `id`, `offset`, `limit` (≤10000), `format` |
| `sumo_delete_search_job` | Primitive: delete a job (idempotent; already-gone is OK). | `id` |
| `sumo_export_results` | Run a search and stream **all** results (up to 100k) to an NDJSON file; returns the path, not the payload. Lines are **chronological** (oldest→newest by `_messagetime`; the server appends `\| sort by _messagetime asc` to non-aggregate queries — a PARTIAL/timed-out export may not be fully ordered). | `query`, time range, `maxMessages`, `extract` |
| `sumo_facets` | See the **shape** first: one `count by` aggregate per dimension (concurrent, auto-deleted), ranked top-N table each. `_`-prefixed dims are native fields; others are **absolute JSON paths from the `_raw` root** (`stream`, `log.levelname`). An all-`(none)` dimension is annotated with a `sumo_describe_schema` hint. One failing dimension = an error line, never a total failure. | `query`, time range, `dimensions` (default `_sourcecategory,_sourcehost`), `limit` (top-N per dim, default 15) |
| `sumo_error_digest` | One-call triage: **auto-detects** the scope's severity signal (schemas vary — word levels, numeric tiers + typed exception rows, string-token payloads), applies it, groups by normalized signature, and returns top-N with count, first/last seen, a sample `request_id`, and `_sourcecategory`. Every response **discloses** the applied filter with a matched-N-of-M line; zero matches on a non-empty scope render a loud guardrail, never silence. | `query` (default `_sourcecategory=<SUMO_DEFAULT_SOURCE_CATEGORY>`), time range, `filter` (agent-supplied override; skips detection), `limit`, `maxScan` (default 5000) |
| `sumo_new_since` | Stateless **monitoring cursor**: returns messages that *arrived* since the last call plus a `cursor=<epoch ms>` line; pass it back as `since` for contiguous, gap-free windows. `byReceiptTime` forced true; aggregate queries rejected. `detail:"summary"` adds the exact whole-job severity counts. | `query`, `since` (cursor), `lookback` (baseline, default `"15m"`), `limit`, `detail`/`fields`/`dedupe`/`sort`/`format` |
| `sumo_trend` | See **when** things happened: `\| timeslice` counts per bucket split into series (default: the scope's **auto-detected** severity field, disclosed in the output), rendered as one sparkline + per-bucket counts per series. Jobs auto-deleted. | `query` (plain scope, no `\|` aggregates), time range, `interval` (default auto ≤40 buckets), `by` (`_native` field \| `none` \| absolute JSON path), `filter`, `maxSeries` (default 8) |
| `sumo_describe_schema` | **Learn a scope's schema in depth (propose-only)**: stratified sampling (never first-N), top-level + nested key enumeration (fill %, types, top values), string-payload characterization, per-(category×type) breakdown, and ranked **paste-ready `filter=` fragments** with honest caveats. Applies nothing, persists nothing. | `query`, time range, `sampleSize` (default 200), `stratifyBy`, `maxDepth` (default 4) |
| `sumo_list_monitors` | Read-only list of the org's **native Sumo Monitors** (24/7 prod alerting): summary header + name, folder path, type, enabled/disabled, current status, trigger types, notification destinations. Requires the **View Monitors** capability (clear error otherwise); no search jobs involved. Free-text matching is **name-only substring** — folder paths are not searched. | `query` (name filter), `status` (multi = unioned API calls), `limit` (default 100) |
| `sumo_list_alerts` | **Fired-alert history** from the documented System Event Index (`_index=sumologic_system_events _sourceCategory=alerts`) via the Search Job API: correlates create/resolve events into one line per fired alert with fired-at, resolved-at, status, and the `monitorId` + name **join keys** to `sumo_list_monitors`. | time range, `monitorQuery`, `status`, `statusScope`, `limit` (default 50) |

**Time range** (all search tools): exactly one of `last` (`"15m"`, `"2h"`, `"1d"`; units
`s/m/h/d`) or both `from`+`to` (ISO-8601 like `2026-07-02T18:28:00`, or epoch ms). Optional
`timeZone` (IANA) and `byReceiptTime` (recommended `true` for very recent windows).

## Examples

Example `sumo_run_search` call (the common case):

```json
{
  "query": "_sourcecategory=kubernetes/myservice/*/backend \"myservice-preview.dev.example.com\"",
  "last": "15m",
  "byReceiptTime": true,
  "detail": "compact",
  "limit": 100
}
```

Example `sumo_export_results` call (bulk to file, not to context; the file comes out
oldest→newest so a coding agent can read it as a chronological trace):

```json
{
  "query": "_sourcecategory=kubernetes/myservice/*/backend | json field=_raw \"log.levelname\" as levelname nodrop | where levelname in (\"ERROR\",\"WARNING\")",
  "last": "2h"
}
```

The optional `extract` parameter (also on `sumo_run_search`) pulls extra JSON fields
out of `_raw` without hand-writing the clauses — `{"status": "log.status"}` appends
`| json field=_raw "log.status" as status nodrop` server-side (one chained clause per
field — the comma multi-extract form is broken in Sumo). Aliases must be simple
identifiers; non-aggregate queries only.

Example `sumo_trend` call (when did it start/spike? — one sparkline per level):

```json
{
  "query": "_sourcecategory=kubernetes/myservice/*/backend",
  "last": "2h",
  "byReceiptTime": true
}
```

```
series (auto-detected): log.levelname — word-level family; syntax only, semantics unverified. Override with by= / filter=.
trend by log.levelname: 2026-07-03T16:00:00.000Z .. 2026-07-03T18:00:00.000Z, interval=5m, buckets=24 (…)
INFO     total=53210  ▅▅▆▅▅▅▄▅▅█▅▅▅▄▅▅▅▅▅▅▄▅▅▅  [2226 2221 …]
ERROR    total=12     ▁▁▁▁▁▁▁▁▁█▁▁▂▁▁▁▁▁▁▁▁▁▁▁  [0 0 …]
```

`interval` defaults to the smallest nice step (`10s…1d`) giving ≤40 buckets; `by`
defaults to the scope's **auto-detected** severity field (disclosed, as above) and
accepts a `_native` field (e.g. `_sourcecategory`), an **absolute JSON path** from the
`_raw` root (e.g. `stream`, `log.status`), or `none` for one total series. `filter`
applies a raw fragment before the timeslice (e.g. trend only the errors).

Example `sumo_facets` call (see the shape before reading messages — where do matching
logs come from):

```json
{
  "query": "_sourcecategory=kubernetes/myservice/backend",
  "last": "30m",
  "byReceiptTime": true
}
```

Default dimensions are native-only: `_sourcecategory`, `_sourcehost` (override per call
with `dimensions` — e.g. `["stream", "log.levelname"]`; absolute paths from the `_raw`
root — or globally with `YOKOZUNA_FACET_DIMENSIONS`). Each dimension is one small
concurrent aggregate job, auto-deleted; a dimension that fails renders as an error line
without failing the rest, and a dimension that is 100% `(none)` is annotated (the field
probably does not exist at that path — run `sumo_describe_schema`).

Example `sumo_error_digest` call (deduplicated "what is broken" summary — counts,
first/last occurrence, and a sample `request_id` per distinct problem):

```json
{
  "query": "_sourcecategory=kubernetes/myservice/*/backend",
  "last": "2h",
  "limit": 20
}
```

Omit `query` to fall back to `_sourcecategory=<SUMO_DEFAULT_SOURCE_CATEGORY>`. The
severity filter is **auto-detected and appended automatically** — pass only the scope,
no `|` operators. Every response opens with a disclosure block like:

```
severity filter (auto-detected): | json field=_raw "log.severity" as yz_sev nodrop | json field=_raw "log.type" as yz_type nodrop | where num(yz_sev) >= 3 or yz_sev in ("Fatal","Error","ERROR","error","Warning","WARNING","warning") or yz_type = "exception"
  detected from: 1 category in scope — kubernetes/myservice/prod→numeric+type(log.severity/log.type)
  matched: 1,470 of 48,112 in-scope messages (3.1%)
  caveat: detection is SYNTACTIC — severity semantics are not verified (…). Pass filter= to
  override; run sumo_describe_schema to learn this scope's schema in depth.
```

The **matched-N-of-M line is the false-clean killer**: `matched: 0 of 48,112` can never
be read as "prod is clean" silently. A zero-match on a non-empty scope renders a calm
"looks genuinely clean" note when detection was confident (the detected severity field
fills ≥50% of in-scope messages), and a loud `!! ZERO MATCHES` guardrail when it was not
(possible schema mismatch). A scope with no detectable severity signal is digested
**unfiltered** by signature, with that disclosed.

## Primitive flow (paging beyond one call)

`sumo_create_search_job` `{"query": "...", "last": "1h"}` → returns `id=XXX` →
`sumo_get_search_job_status` `{"id": "XXX"}` until `DONE GATHERING RESULTS` →
`sumo_get_messages` `{"id": "XXX", "offset": 0, "limit": 100}` (or `sumo_get_records` for
aggregate queries) → `sumo_delete_search_job` `{"id": "XXX"}` when done.

Successful searches include a **Sumo UI deep link**
(`https://service.eu.sumologic.com/log-search/create?...`) to open the same query in the
browser (origin configurable via `SUMO_UI_BASE_URL` — see
[Configuration](configuration.md)).

## MCP prompt: `triage`

The server also registers a `triage` **MCP prompt** (in Claude Code:
`/mcp__yokozuna__triage`, with an optional `problem` argument). It encodes the
recommended workflow — *shape first* (`sumo_facets`/`sumo_trend`/`detail:"summary"`) →
*narrow* (`sumo_error_digest`, then `compact` reads) → *trace* (quoted `request_id`,
no other filters) → *bulk export* — plus the full query cookbook (severity-schema
variance and the detect-disclose-override loop, the hostname-keyword caveat, noise
exclusion, `extract`, and `byReceiptTime`). The cookbook lives in the prompt rather
than in every tool description to keep per-call token cost down.

## Token economy

Log messages are huge (~33 metadata fields + a nested JSON `log` object). The tools are
lean by default and give the agent explicit levers:

- **`detail`** — `summary` (**exact whole-job counts by the auto-detected severity
  field** via a side aggregate — provenance disclosed, e.g.
  `by log.severity (auto-detected; exact, whole job)` — plus a compact histogram
  sparkline and top message signatures; anything computed from the fetched page alone is
  labeled loudly as a `SAMPLE` — cheapest) · `compact` (**default**: timestamp, level,
  `request_id`, `_sourcecategory`, the **full `message`**, plus `method`/`path`/`status`
  when present on request logs) · `full` (compact + `duration_s/logger/client_ip`) ·
  `raw` (verbatim `_raw` — returns logs exactly as the application emitted them, including
  anything sensitive the app logged).
- **`fields`** — explicit projection from the flattened namespace (level/`request_id` are
  always kept for cross-referencing).
- **`dedupe`** — group repeated messages **within the returned page** by (level,
  normalized signature): timestamps, UUIDs, hex runs and numbers are normalized away, so
  the same log statement with varying values collapses into
  `first_ts..last_ts LEVEL ×N message` (raise `limit` for broader grouping). With
  `detail:"raw"` each group keeps one verbatim `_raw` exemplar.
- **`sort`** — `asc` (**default**: oldest→newest, best for tracing) or `desc` by
  `_messagetime`. Client-side: it orders only the **returned** result set — raise `limit`
  or narrow the query for full ordering. Not applicable to aggregate records.
- **`maxMessageChars`** — safety cap only; **`message` is never truncated by default**.
- **`limit`** — inline max 5000; anything bulk belongs in `sumo_export_results` (file, not
  context).
- **Whole-response cap** — independent of the levers above, no inline response exceeds
  `YOKOZUNA_MAX_RESPONSE_CHARS` (default 200k chars): the tail is truncated with a note
  pointing at narrowing or `sumo_export_results`. Header/count/cursor lines come first
  in every tool's output, so they survive truncation.

Recommended triage pattern: `detail:"summary"` to see the shape → narrow the query →
`compact` to read messages → `full`/`raw` on the few that matter → `sumo_export_results`
when a coding agent should chew through everything.
