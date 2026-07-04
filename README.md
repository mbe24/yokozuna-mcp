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
| `YOKOZUNA_LEVEL_EXPR` | no | `log.levelname` | JSON path (inside `_raw`) of the log level — used by `detail: "summary"` side-aggregates, `sumo_error_digest`, and the `levelname` facet. |
| `YOKOZUNA_SETTLE_MARGIN_SECONDS` | no | `180` | `sumo_new_since` freshness lag: poll windows end at `now − margin` so late-arriving logs are never skipped (complete but that many seconds stale). |
| `YOKOZUNA_FACET_DIMENSIONS` | no | `_sourcecategory,_sourcehost,levelname,status,path` | Default `sumo_facets` dimensions (comma-separated). `_`-prefixed = native fields; anything else is parsed as `log.<dimension>`. |
| `YOKOZUNA_MAX_RESPONSE_CHARS` | no | `200000` | **Whole-response** safety cap (chars) for inline tool results. Oversized responses are tail-truncated with a pointer to `sumo_export_results`; header/count lines come first and always survive. |
| `YOKOZUNA_KEEPALIVE_IDLE_MINUTES` | no | `10` | Minutes a kept job (`sumo_create_search_job` / `keepJob: true`) may sit idle before the server deletes it. Any access (status/messages/records) resets the timer. |
| `YOKOZUNA_KEEPALIVE_MAX_JOBS` | no | `20` | Max jobs the keepalive tracks at once; beyond the cap the stalest job is evicted (logged to stderr with the job id) and left to expire server-side. |

See `.env.example` for a commented template. Never commit a filled-in `.env`.

## Step 3 — Smoke-test the server (optional but recommended)

With a filled-in `.env` in the repo root, this sends a real MCP handshake plus
`tools/list` over stdio and exits. Expect a `tools` array with **12 tools** on stdout and
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
session, `/mcp` shows the server, its 12 tools, and the `triage` prompt
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
| `sumo_facets` | See the **shape** first: one `count by` aggregate per dimension (concurrent, auto-deleted), ranked top-N table each. `_`-prefixed dims are native fields; others parse `log.<dim>` from `_raw`. One failing dimension = an error line, never a total failure. | `query`, time range, `dimensions`, `limit` (top-N per dim, default 15) |
| `sumo_error_digest` | One-call triage: filter to ERROR/WARNING (via `YOKOZUNA_LEVEL_EXPR`), group by normalized signature, return top-N with count, first/last seen, a sample `request_id`, and `_sourcecategory`. | `query` (default `_sourcecategory=<SUMO_DEFAULT_SOURCE_CATEGORY>`), time range, `levels`, `limit`, `maxScan` (default 5000) |
| `sumo_new_since` | Stateless **monitoring cursor**: returns messages that *arrived* since the last call plus a `cursor=<epoch ms>` line; pass it back as `since` for contiguous, gap-free windows. `byReceiptTime` forced true; aggregate queries rejected. | `query`, `since` (cursor), `lookback` (baseline, default `"15m"`), `limit`, `detail`/`fields`/`dedupe`/`sort`/`format` |
| `sumo_trend` | See **when** things happened: `\| timeslice` counts per bucket split into series (default: log level via `YOKOZUNA_LEVEL_EXPR`), rendered as one sparkline + per-bucket counts per series. One aggregate job, auto-deleted. | `query` (plain scope, no `\|` aggregates), time range, `interval` (default auto ≤40 buckets), `by` (`levelname` \| `_native` field \| `none` \| `log.<field>` name), `maxSeries` (default 8) |
| `sumo_list_monitors` | Read-only list of the org's **native Sumo Monitors** (24/7 prod alerting): name, folder path, type, enabled/disabled, current status, trigger types, notification destinations. Requires the **View Monitors** capability (clear error otherwise); no search jobs involved. | `query` (name/content filter), `limit` (default 100) |

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
trend by levelname: 2026-07-03T16:00:00.000Z .. 2026-07-03T18:00:00.000Z, interval=5m, buckets=24 (…)
INFO     total=53210  ▅▅▆▅▅▅▄▅▅█▅▅▅▄▅▅▅▅▅▅▄▅▅▅  [2226 2221 …]
ERROR    total=12     ▁▁▁▁▁▁▁▁▁█▁▁▂▁▁▁▁▁▁▁▁▁▁▁  [0 0 …]
```

`interval` defaults to the smallest nice step (`10s…1d`) giving ≤40 buckets; `by`
accepts `levelname` (default; parsed via `YOKOZUNA_LEVEL_EXPR`), a `_native` field
(e.g. `_sourcecategory`), any `log.<field>` name (e.g. `status`), or `none` for one
total series.

Example `sumo_facets` call (see the shape before reading messages — where do matching
logs come from, which levels/statuses/paths dominate):

```json
{
  "query": "_sourcecategory=kubernetes/myservice/backend",
  "last": "30m",
  "byReceiptTime": true
}
```

Default dimensions: `_sourcecategory`, `_sourcehost`, `levelname`, `status`, `path`
(override per call with `dimensions`, or globally with `YOKOZUNA_FACET_DIMENSIONS`).
Each dimension is one small concurrent aggregate job, auto-deleted; a dimension that
fails renders as an error line without failing the rest.

Example `sumo_error_digest` call (deduplicated "what is broken" summary — counts,
first/last occurrence, and a sample `request_id` per distinct problem):

```json
{
  "query": "_sourcecategory=kubernetes/myservice/*/backend",
  "last": "2h",
  "levels": ["ERROR", "WARNING"],
  "limit": 20
}
```

Omit `query` to fall back to `_sourcecategory=<SUMO_DEFAULT_SOURCE_CATEGORY>`. The level
filter is appended automatically (parsing `YOKOZUNA_LEVEL_EXPR`, default `log.levelname`)
— pass only the scope, no `|` operators.

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
what 24/7 prod alerting already exists — name, folder path, type, enabled/disabled,
current status, trigger types, and notification destinations. It needs the
**View Monitors** capability on the access key and creates no search jobs.

## MCP prompt: `triage`

The server also registers a `triage` **MCP prompt** (in Claude Code:
`/mcp__yokozuna__triage`, with an optional `problem` argument). It encodes the
recommended workflow — *shape first* (`sumo_facets`/`sumo_trend`/`detail:"summary"`) →
*narrow* (`sumo_error_digest`, then `compact` reads) → *trace* (quoted `request_id`,
no other filters) → *bulk export* — plus the full query cookbook (severity filtering
via `log.levelname`, the hostname-keyword caveat, noise exclusion, `extract`, and
`byReceiptTime`). The cookbook lives in the prompt rather than in every tool
description to keep per-call token cost down.

## Token economy

Log messages are huge (~33 metadata fields + a nested JSON `log` object). The tools are
lean by default and give the agent explicit levers:

- **`detail`** — `summary` (**exact whole-job per-level counts** via a side aggregate,
  compact histogram sparkline, top message signatures; sections computed from the fetched
  page are labeled `— sample` — cheapest) · `compact` (**default**: timestamp, level,
  `request_id`, `_sourcecategory`, the **full `message`**, plus `method`/`path`/`status`
  when present on request logs) · `full` (compact + `duration_s/logger/client_ip`) ·
  `raw` (verbatim `_raw` — returns logs exactly as the application emitted them, including
  anything sensitive the app logged).
- **`fields`** — explicit projection from the flattened namespace (level/`request_id` are
  always kept for cross-referencing).
- **`dedupe`** — group repeated messages **globally** by (level, normalized signature):
  timestamps, UUIDs, hex runs and numbers are normalized away, so the same log statement
  with varying values collapses into `first_ts..last_ts LEVEL ×N message`.
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
- **Which environment**: add the deployment **hostname as a keyword** (matches `request_url`)
  — but see the request-logs-only caveat below.
- **Severity**: parse `log.levelname` (see #2) — not a class name, not `_loglevel`.
- **A specific request/entity**: the `request_id` (or any correlation key your logs
  carry, e.g. `session_id`, `client_ip`) as a quoted keyword (see #3).

Backend logs here are structured JSON (`_raw = {stream, timestamp, log:{…}}`); the fields
worth filtering on are `log.levelname`, `log.request_id`, `log.status`, `log.path`,
`log.logger`, `log.pathname` — parse them with `| json field=_raw "log.<field>" as <alias>`.

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

2. **Errors/warnings** — note `stream:"stderr"` is **NOT** the error signal; the reliable
   level is `log.levelname` parsed from `_raw`:

   ```
   _sourcecategory=kubernetes/myservice/*/backend | json field=_raw "log.levelname" as levelname nodrop | where levelname in ("ERROR","WARNING")
   ```

   > **Do not filter on the top-level `_loglevel`**: it is often **empty on warnings**
   > (~78% observed) and uses `WARN` where `levelname` says `WARNING`, so
   > `| where _loglevel in ("ERROR","WARN")` silently misses most warnings.

   Count by level (aggregate):

   ```
   _sourcecategory=kubernetes/myservice/*/backend | json field=_raw "log.levelname" as levelname nodrop | count by levelname
   ```

   Exclude noise with negation:

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
