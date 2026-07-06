# Configuration

All configuration is via environment variables. Only two are required — everything else
has a sensible default (zero-config by design; there is deliberately **no** schema
configuration, see [Querying & schema-learning](querying.md)).

!!! important
    The server does **NOT** read a `.env` file by itself. Environment variables must
    reach the server process via the `env` block of your MCP client config (recommended),
    exported shell variables, or `node --env-file=.env` when running from source. See
    [Installation](installation.md). `.env.example` in the repo is a commented template —
    never commit a filled-in `.env`.

## Environment variables

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

!!! note "Removed in 0.2.0"
    `YOKOZUNA_LEVEL_EXPR`. Severity is auto-detected per scope at call time (and
    disclosed in tool output); use the per-call `filter=` parameter for overrides.
    Setting the variable produces a startup warning.

## Security

- Credentials come from environment variables only; the access key is **never** logged,
  echoed, or included in error messages (unit-tested).
- Use a **read-only service account** scoped to the log indexes you need. The
  capabilities it needs are listed in [Installation](installation.md).
- Nothing is network-exposed: stdio transport only. stdout carries only MCP protocol
  JSON; all diagnostics go to stderr.
- `detail:"raw"` returns logs exactly as the application emitted them — including
  anything sensitive the application logged.
