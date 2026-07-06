# yokozuna-mcp

<img src="https://raw.githubusercontent.com/mbe24/yokozuna-mcp/main/assets/logo.png" alt="yokozuna-mcp logo: a levitating, meditating sumo inside an enso circle, orbited by log lines" width="160" align="right">

An MCP (Model Context Protocol) server that gives coding agents (Claude Code, Claude
Desktop, …) programmatic access to **Sumo Logic** logs via the
[Search Job API](https://www.sumologic.com/help/docs/api/search-job/) — so issues
in **preview deployments** and **production** can be found and triaged without leaving the
editor.

- Transport: **stdio** (local, per-developer; credentials via env vars)
- Deployment default: **EU** (`api.eu.sumologic.com`), configurable
- Token-economical by default: lean output with explicit levers (`detail`, `fields`,
  `dedupe`), bulk data goes to files instead of your context window
- **Zero-config & schema-learning**: only `SUMO_ACCESS_ID` + `SUMO_ACCESS_KEY` are
  required. Severity schemas vary per system — the triage tools **auto-detect** each
  scope's severity signal at call time and **disclose** exactly what they applied
  (predicate, provenance, matched-N-of-M); `sumo_describe_schema` learns any scope's
  schema in depth and proposes paste-ready filters. No schema config exists, on purpose.

This README is self-sufficient: following it top-to-bottom from a checkout of this repo
yields a working, registered MCP server.

## Prerequisites

- **Node.js >= 20** (`node --version` to check) and npm. Node 20+ is required for the
  built-in `fetch` and for `node --env-file`.
- A Sumo Logic **Enterprise** account (the Search Job API is Enterprise-only).
- A Sumo Logic **access ID / access key** pair, ideally for a dedicated **read-only
  service account** whose role has these capabilities:
  - **Data Management → Download Search Results**
  - **Data Management → View Collectors**
  - optionally **Alerting → View Monitors** (only needed for `sumo_list_monitors`)
  - plus search access to the indexes/partitions holding your preview & prod logs.
- Know your **deployment region** (e.g. `eu`). If unsure, start with `eu` — a wrong
  region produces an HTTP 301 error that names the correct one (see Troubleshooting).

## Step 1 — Install and build

Once the package is published to the npm registry, no checkout is needed —
`npx yokozuna-mcp` fetches and runs it directly (see launch form 4 in Step 4).
Until then (or to run from source), build locally from this repo:

```sh
cd <path-to-this-repo>      # e.g. C:/Users/you/Development/yokozuna
npm install
npm run build
```

The build produces `dist/index.js` (the server entry point). Note its **absolute path**
(e.g. `C:/Users/you/Development/yokozuna/dist/index.js`) — you need it for client config.

Optionally, put a `yokozuna-mcp` binary on your PATH (enables launch form 3 below):

```sh
npm link
```

## Step 2 — Provide credentials (environment variables)

> **IMPORTANT: the server does NOT read a `.env` file by itself.** Environment variables
> must reach the server process via one of:
> 1. the `env` block of your MCP client config (recommended — see Step 4),
> 2. exported shell variables, or
> 3. `node --env-file=.env dist/index.js` (Node's built-in flag; used by the smoke test
>    below). Copy `.env.example` to `.env` and fill in the two required values for this.

| Var | Required | Default | Notes |
|---|---|---|---|
| `SUMO_ACCESS_ID` | yes | — | Access ID. |
| `SUMO_ACCESS_KEY` | yes | — | Access key. **Never logged or echoed.** |
| `SUMO_DEPLOYMENT` | no | `eu` | One of `au,ca,ch,de,eu,fed,in,jp,kr,us1,us2`. |
| `SUMO_ENDPOINT` | no | derived | Explicit **API** base URL override (e.g. `https://api.eu.sumologic.com/api/`); accepts host with/without `/api/`; https only. Takes precedence over `SUMO_DEPLOYMENT`. |
| `SUMO_UI_BASE_URL` | no | `service.<code>.sumologic.com` | **UI** origin for "open in Sumo UI" deep links only (not the API). Set to your company host, e.g. `https://<org>.<deployment>.sumologic.com`, so links match your actual UI. |
| `SUMO_DEFAULT_TIMEZONE` | no | `UTC` | IANA tz used when a tool call omits `timeZone`. |
| `SUMO_DEFAULT_SOURCE_CATEGORY` | no | — | Embedded into tool descriptions as the recommended query prefix. Queries are never mutated. |
| `YOKOZUNA_EXPORT_DIR` | no | OS temp dir | Where `sumo_export_results` writes NDJSON files. |
| `YOKOZUNA_DEFAULT_DETAIL` | no | `compact` | `summary` \| `compact` \| `full` \| `raw`. |
| `YOKOZUNA_DEFAULT_LIMIT` | no | `100` | Default inline result limit. |
| `YOKOZUNA_MAX_MESSAGE_CHARS` | no | `10000` | Safety cap for the `message` field. |
| `YOKOZUNA_SETTLE_MARGIN_SECONDS` | no | `180` | `sumo_new_since` freshness lag: poll windows end at `now − margin` so late-arriving logs are never skipped (complete but that many seconds stale). |
| `YOKOZUNA_FACET_DIMENSIONS` | no | `_sourcecategory,_sourcehost` | Default `sumo_facets` dimensions (comma-separated). `_`-prefixed = native fields; anything else is an **absolute JSON path from the `_raw` root** (e.g. `stream`, `log.levelname`). |
| `YOKOZUNA_MAX_RESPONSE_CHARS` | no | `200000` | **Whole-response** safety cap (chars) for inline tool results. Oversized responses are tail-truncated with a pointer to `sumo_export_results`; header/count lines come first and always survive. |
| `YOKOZUNA_KEEPALIVE_IDLE_MINUTES` | no | `10` | Minutes a kept job (`sumo_create_search_job` / `keepJob: true`) may sit idle before the server deletes it. Any access (status/messages/records) resets the timer. |
| `YOKOZUNA_KEEPALIVE_MAX_JOBS` | no | `20` | Max jobs the keepalive tracks at once; beyond the cap the stalest job is evicted (logged to stderr with the job id) and left to expire server-side. |

> **Removed in 0.2.0:** `YOKOZUNA_LEVEL_EXPR`. Severity is auto-detected per scope at
> call time (and disclosed in tool output); use the per-call `filter=` parameter for
> overrides. Setting the variable produces a startup warning.

See `.env.example` for a commented template. Never commit a filled-in `.env`.

## Step 3 — Smoke-test the server (optional but recommended)

With a filled-in `.env` in the repo root, this sends a real MCP handshake plus
`tools/list` over stdio and exits. Expect a `tools` array with **14 tools** on stdout and
only `[yokozuna-mcp] server started (stdio)` on stderr.

bash / Git Bash:

```sh
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | node --env-file=.env dist/index.js
```

PowerShell:

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
'@ | node --env-file=.env dist/index.js
```

If instead the process exits immediately with `Missing required environment variable(s)`,
the env vars did not reach the process — see Step 2.

## Step 4 — Register in an MCP client

Three equivalent local launch forms (all require Step 1 first):

1. **Direct node** (most explicit): `"command": "node", "args": ["<abs>/dist/index.js"]`
2. **npx with a local path** (no registry involved): `"command": "npx", "args": ["<abs-project-dir>"]`
3. **Linked bin** (after `npm link`): `"command": "yokozuna-mcp"` or `"command": "npx", "args": ["yokozuna-mcp"]`

Plus one registry form (works once the package is published to npm — no checkout or
build needed):

4. **npx from the registry**: `"command": "npx", "args": ["-y", "yokozuna-mcp"]`

On Windows, use forward slashes (`C:/Users/...`) or escaped backslashes (`C:\\Users\\...`)
in JSON — never single backslashes.

### Claude Code

One command (replace the path and credentials):

```sh
claude mcp add yokozuna --env SUMO_ACCESS_ID=suXXXX --env SUMO_ACCESS_KEY=<key> --env SUMO_DEPLOYMENT=eu -- node C:/Users/you/Development/yokozuna/dist/index.js
```

By default this registers for the current project only; add `--scope user` to make it
available in every project. Alternatively, create/extend `.mcp.json` **in the root of the
project where you want to use it** (shared, project scope):

```json
{
  "mcpServers": {
    "yokozuna": {
      "command": "node",
      "args": ["C:/Users/you/Development/yokozuna/dist/index.js"],
      "env": {
        "SUMO_ACCESS_ID": "suXXXX",
        "SUMO_ACCESS_KEY": "<key>",
        "SUMO_DEPLOYMENT": "eu"
      }
    }
  }
}
```

Verify with `claude mcp list` — `yokozuna` should show as connected. In a Claude Code
session, `/mcp` shows the server, its 14 tools, and the `triage` prompt
(available as `/mcp__yokozuna__triage`).

> Do not commit a `.mcp.json` containing the real access key to a shared repo — prefer
> `claude mcp add` (local scope) or user-level config for real credentials.

### Claude Desktop

Edit `claude_desktop_config.json` (create it if missing):

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

The `npx <local-path>` or linked-bin forms avoid brittle absolute `dist` paths:

```json
{
  "mcpServers": {
    "yokozuna": {
      "command": "npx",
      "args": ["C:\\Users\\you\\Development\\yokozuna"],
      "env": {
        "SUMO_ACCESS_ID": "suXXXX",
        "SUMO_ACCESS_KEY": "<key>",
        "SUMO_DEPLOYMENT": "eu"
      }
    }
  }
}
```

Then **fully quit and restart Claude Desktop** (system-tray quit on Windows, Cmd-Q on
macOS — closing the window is not enough). The tools appear under the tools icon in the
chat input.

## Tools

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
| `sumo_list_alerts` | **Fired-alert history** from the documented System Event Index (`_index=sumologic_system_events _sourceCategory=alerts`) via the Search Job API: correlates create/resolve events into one line per fired alert with fired-at, resolved-at, status, and the `monitorId` + name **join keys** to `sumo_list_monitors`. | time range, `monitorQuery`, `status`, `limit` (default 50) |

**Time range** (all search tools): exactly one of `last` (`"15m"`, `"2h"`, `"1d"`; units
`s/m/h/d`) or both `from`+`to` (ISO-8601 like `2026-07-02T18:28:00`, or epoch ms). Optional
`timeZone` (IANA) and `byReceiptTime` (recommended `true` for very recent windows).

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

### Learning a schema and remembering it (the `filter=` workflow)

Schemas are learned per scope, semantics are YOURS to confirm — the intended loop:

1. Meet a new scope → `sumo_error_digest` auto-detects; read the disclosure block.
2. If detection was wrong or insufficient (zero-match guardrail, no-signal, or the
   matched signatures look like noise) → run `sumo_describe_schema` on the scope and
   judge its ranked, paste-ready fragments. Syntax is detectable; whether a signal is a
   real incident (e.g. `[error]` lines that are all scanner probes) is a judgment call.
3. **Record confirmed semantics in your own memory** (CLAUDE.md / auto-memory / project
   notes), e.g. *"scope `kubernetes/foo/*`: real errors are
   `| json field=_raw "log.severity" as s nodrop | where num(s)>=3 or s="Fatal"`;
   `[error]` on the frontend scope is scanner noise"*.
4. On later calls pass `filter=` from your memory — the MCP itself stays stateless
   (only an in-process, ~12-minute detection memo exists; disclosed as
   `(detection cached, <age>)`).

Example `sumo_new_since` polling loop (stateless monitoring — e.g. "tell me when new
errors show up in the preview deployment"):

1. First call — baseline (no `since`):

   ```json
   { "query": "_sourcecategory=kubernetes/myservice/*/backend \"myservice-preview.dev.example.com\"", "lookback": "15m" }
   ```

   The response starts with a header plus a cursor line like `cursor=1783017420000`.

2. Every following call passes the last cursor as `since`:

   ```json
   { "query": "_sourcecategory=kubernetes/myservice/*/backend \"myservice-preview.dev.example.com\"", "since": 1783017420000 }
   ```

   Windows are half-open `[since, now − settle margin)` over **receipt time**
   (`byReceiptTime` is forced), so consecutive calls tile with no gaps and no duplicates —
   the server keeps **no state**; the cursor in your hand is everything.

   **Freshness note:** results trail real time by the settle margin (default **180 s**,
   `YOKOZUNA_SETTLE_MARGIN_SECONDS`) so logs that arrive late are not skipped —
   *complete but ~3 minutes stale*. Polling faster than the margin just returns a
   "not settled yet" note with the cursor unchanged (no job is created).

   In Claude Code this pairs well with `/loop`, e.g.:
   `/loop 5m check sumo_new_since for new backend errors (keep passing the returned cursor as since) and summarize anything new`.
   Aggregate queries (`| count …`) are rejected — use `sumo_run_search` for those.

Example primitive flow (only needed when paging beyond one call):
`sumo_create_search_job` `{"query": "...", "last": "1h"}` → returns `id=XXX` →
`sumo_get_search_job_status` `{"id": "XXX"}` until `DONE GATHERING RESULTS` →
`sumo_get_messages` `{"id": "XXX", "offset": 0, "limit": 100}` (or `sumo_get_records` for
aggregate queries) → `sumo_delete_search_job` `{"id": "XXX"}` when done.

Successful searches include a **Sumo UI deep link**
(`https://service.eu.sumologic.com/log-search/create?...`) to open the same query in the
browser.

`sumo_list_monitors` (read-only) lists the org's native Sumo Monitors for discovering
what 24/7 prod alerting already exists — a summary header plus name, folder path, type,
enabled/disabled, current status, trigger types, and notification destinations. It needs
the **View Monitors** capability on the access key and creates no search jobs. Filter by
`status` (e.g. `["Critical","Warning"]` — one API call per status, unioned client-side;
the API has no OR). Footgun: free-text `query` matching is **name-only, case-insensitive
substring** — folder paths are not searched.

`sumo_list_alerts` complements it with **fired-alert history**: it queries the
documented System Event Index (`_index=sumologic_system_events _sourceCategory=alerts`,
enabled by default on Enterprise accounts) through the ordinary Search Job API and
correlates the separate create/resolve events into one line per fired alert — fired-at,
resolved-at, latest status, and the `monitorId` + monitor-name join keys back to
`sumo_list_monitors`.

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

## Example queries (the real workflow)

**How to scope a search (read this first).** Free-text terms match the **raw log text**
(`_raw`), so guessing at source-code identifiers — Java/Python class names, function names —
is unreliable and usually matches nothing. Scope and filter using these instead:

- **Where**: `_sourcecategory=<path>` (e.g. `kubernetes/myservice/*/backend`) — the primary
  scoping dimension. Discover categories from the `[in brackets]` in any result line, or
  with `| count by _sourcecategory`.
- **Which environment**: add the deployment **hostname as a keyword** (matches the
  request-URL field) — but see the request-logs-only caveat below.
- **Severity**: schemas **vary per system** — let `sumo_error_digest` auto-detect (see #2),
  or learn the scope with `sumo_describe_schema` and pass `filter=`.
- **A specific request/entity**: the `request_id` (or any correlation key your logs
  carry, e.g. `session_id`, `client_ip`) as a quoted keyword (see #3).

Nested JSON payload fields are parsed with `| json field=_raw "<absolute.path>" as <alias>
nodrop` (one clause per field); discover which paths exist with `sumo_describe_schema`
or `sumo_facets`.

1. **Search by preview deployment URL / hostname keyword** (wait a few minutes for
   ingestion; use `byReceiptTime: true` for very recent windows):

   ```
   _sourcecategory=kubernetes/myservice/*/backend "myservice-preview.dev.example.com"
   ```

   > **Caveat:** a hostname keyword matches only *request* logs (the hostname lives in
   > `log.request_url`) — startup/Celery/Redis lines and most **errors/exceptions carry no
   > hostname** and get excluded (live-verified: a host-keyword error search returned 0
   > while the same search by `_sourcecategory` found them). Hunt errors by
   > `_sourcecategory`, never by hostname keyword.

2. **Errors/warnings** — severity schemas **vary per system**: some emit word levels
   (`log.levelname`), some numeric tiers plus typed exception rows (`log.severity`,
   `log.type`), some plain-string payloads where an `[error]` token or stderr is the only
   signal. Don't guess — run:

   ```
   sumo_error_digest { "query": "_sourcecategory=kubernetes/myservice/*/backend", "last": "2h" }
   ```

   It detects the scope's signal, applies it, and **discloses** the predicate plus a
   matched-N-of-M line. If the disclosure says no-signal/zero-match (or the matches look
   like noise), run `sumo_describe_schema` on the scope, pick/edit one of its paste-ready
   fragments, confirm the semantics yourself, and pass it as `filter=` — then record the
   confirmed fragment in your own notes for next time.

   Count by severity: `detail:"summary"` on `sumo_run_search` (exact whole-job counts by
   the detected field). Exclude noise with negation:

   ```
   _sourcecategory=kubernetes/myservice/*/backend !"health check"
   ```

3. **Cross-reference / trace one request**: take the `req=` id from any result line and
   run a **new search with just the quoted id and NO source/host filter** — ids are
   full-text indexed even though they live inside `_raw`:

   ```
   "74ec29d7-3420-41f9-8a71-4d91f0b263a6"
   ```

   Other correlation keys (e.g. `session_id`, `client_ip`) work the same way.
   Results are returned oldest→newest by default (`sort: "asc"`), so the trace reads
   chronologically. Remember the hostname caveat above: don't add a hostname keyword when
   the trace may include errors.

4. **Export everything for a coding agent**: call `sumo_export_results` with the same
   query and a wider window — it streams flattened NDJSON to a file (chronological,
   oldest→newest) and returns the path.

## Limits & troubleshooting

- **Server exits with `Missing required environment variable(s)`** — the env vars did not
  reach the process. The server does **not** read `.env` on its own: set them in the MCP
  client's `env` block, export them in the shell, or launch via `node --env-file=.env`.
- **HTTP 401** — wrong `SUMO_ACCESS_ID`/`SUMO_ACCESS_KEY` (or the key was revoked). Keys
  are region-bound: also check `SUMO_DEPLOYMENT`.
- **HTTP 301** = wrong deployment endpoint — the error message names the correct
  `SUMO_DEPLOYMENT` (parsed from the redirect `Location`).
- **HTTP 404 on a job** = the job expired server-side, was cancelled, or was deleted —
  re-create it. **Job ids do not survive a server restart** (the keepalive registry and
  session state are in-memory).
- **100,000 messages max** per search (`FORCE PAUSED` state = a non-aggregate query hit
  the cap; results are available but truncated — split the time range).
- **10,000 per page** max; requesting more silently returns exactly 10,000.
- **Rate limits**: 4 requests/s, 10 concurrent per key, 200 active search jobs per org.
  The server rate-limits itself and always deletes finished jobs.
- **Aggregate vs non-aggregate**: records ↔ messages are mutually exclusive per job; a
  mismatched fetch returns 400. The tools detect this and route (or tell you which tool
  to use).
- **Ingestion lag**: logs appear minutes after they happen. Wait a few minutes and/or set
  `byReceiptTime: true` for windows covering the last few minutes — it surfaces more
  recent logs.
- **No results but the query looks right** — check the time range, the exact
  `_sourcecategory` spelling, and ingestion lag; the 0-result response lists any server
  warnings (e.g. unknown partition).
- Jobs created via `sumo_create_search_job` (or `keepJob: true`) are background-polled
  (kept alive) by the server and auto-deleted after `YOKOZUNA_KEEPALIVE_IDLE_MINUTES`
  (default 10) minutes idle; any access (status/messages/records) resets the idle timer.
  At most `YOKOZUNA_KEEPALIVE_MAX_JOBS` (default 20) jobs are tracked — beyond that the
  stalest is evicted from keepalive (logged to stderr with its job id). Delete jobs
  explicitly when done.
- `sumo_run_search` that shows fewer messages than `messageCount` includes a hint: raise
  `limit` (max 5000), or re-run with `keepJob: true` and page via `sumo_get_messages`
  `offset`/`limit`.

## Development

```sh
npm run dev               # tsx watch (needs SUMO_* in the shell env)
npm test                  # unit tests (no network)
npm run test:integration  # opt-in; needs SUMO_ACCESS_ID/KEY in env; creates+deletes 1 tiny job
npm run lint
npm run typecheck
```

Full local quality gate (no CI is configured — the repo is not hosted on GitHub for now):

```sh
npm run typecheck && npm run lint && npm run build && npm test
```

Layout: `src/config.ts` (env → typed config) · `src/http/` (rate-limited fetch client,
errors, cookies) · `src/sumo/` (Search Job API, job lifecycle/keepalive, time ranges) ·
`src/format/` (log flattening + token-economical rendering) · `src/tools/` (MCP tool
definitions) · `src/server.ts`/`src/index.ts` (wiring + stdio entry). `plan/` holds the
task specs the implementation was built from.

## Publishing

The package is publish-ready: `files` allowlist (`dist`, `README.md`, `LICENSE` only —
no sources, tests, or env files in the tarball), a `bin` entry with a shebang that
survives the build, and a `prepublishOnly` hook that rebuilds `dist` on publish. Verify
the tarball contents with `npm pack --dry-run`; publish with `npm publish`. Once
published, `npx -y yokozuna-mcp` works as-is (launch form 4 above). Until then, use the
local forms.

Brand assets live in `assets/` (logo) and `.github/` (social preview); the SVGs are the
source of truth and `npm run assets` re-rasterizes the PNGs (dev-only
`@resvg/resvg-js`, excluded from the published tarball).

## Security

- Credentials come from environment variables only; the access key is **never** logged,
  echoed, or included in error messages (unit-tested).
- Use a **read-only service account** scoped to the log indexes you need.
- Nothing is network-exposed: stdio transport only. stdout carries only MCP protocol
  JSON; all diagnostics go to stderr.
