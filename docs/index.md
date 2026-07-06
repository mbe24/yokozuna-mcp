# Yokozuna MCP

<img src="https://raw.githubusercontent.com/mbe24/yokozuna-mcp/main/assets/logo.png" alt="yokozuna-mcp logo: a levitating, meditating sumo inside an enso circle, orbited by log lines" width="160" align="right">

Yokozuna MCP (Model Context Protocol) gives coding agents (Claude Code, Claude
Desktop, Codex, …) programmatic access to **Sumo Logic** logs via the
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

## Where to go

- **[Installation](installation.md)** — prerequisites, npm-based setup, registering the
  server in Claude Code, Claude Desktop, and Codex, and a smoke test.
- **[Tools reference](tools.md)** — all 14 tools, the `triage` MCP prompt, and the
  token-economy levers (`detail`, `fields`, `dedupe`, `sort`, caps).
- **[Querying & schema-learning](querying.md)** — how to scope a search, the
  detect–disclose–override severity loop, cross-referencing requests, and bulk export.
- **[Monitoring](monitoring.md)** — the stateless `sumo_new_since` polling cursor,
  native Sumo Monitors, and fired-alert history.
- **[Configuration](configuration.md)** — the full environment-variable table plus
  credential and security guidance.
- **[Troubleshooting](troubleshooting.md)** — limits, common HTTP errors, ingestion lag,
  and job lifecycle gotchas.
- **[Development](development.md)** — building from source, tests, CI/release, layout.

## The recommended triage pattern

*Shape first* (`sumo_facets` / `sumo_trend` / `detail:"summary"`) → *narrow*
(`sumo_error_digest`, then `compact` reads) → *trace* (quoted `request_id`, no other
filters) → *bulk export* (`sumo_export_results` writes NDJSON to a file, not to your
context window). The `triage` MCP prompt encodes this workflow with the full query
cookbook.
