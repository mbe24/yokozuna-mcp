# Yokozuna MCP

<img src="https://raw.githubusercontent.com/mbe24/yokozuna-mcp/main/assets/logo.png" alt="yokozuna-mcp logo: a levitating, meditating sumo inside an enso circle, orbited by log lines" width="160" align="right">

[![CI](https://github.com/mbe24/yokozuna-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mbe24/yokozuna-mcp/actions/workflows/ci.yml)
[![Docs](https://readthedocs.org/projects/yokozuna-mcp/badge/?version=latest)](https://yokozuna-mcp.readthedocs.io/en/latest/)
[![npm](https://img.shields.io/npm/v/yokozuna-mcp?color=7C3AED&label=npm)](https://www.npmjs.com/package/yokozuna-mcp)
[![License Info](https://img.shields.io/badge/license-Apache%20License%20v2.0-orange.svg)](https://raw.githubusercontent.com/mbe24/yokozuna-mcp/main/LICENSE)

Yokozuna MCP (Model Context Protocol) gives coding agents (Claude Code, Claude
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

## Installation

Requires **Node.js >= 20** and a Sumo Logic **Enterprise** access ID/key pair (ideally a
read-only service account). The package is on npm — `npx -y yokozuna-mcp` fetches and
runs it, so registering it in your MCP client is the whole install.

### Claude Code

```sh
claude mcp add yokozuna --env SUMO_ACCESS_ID=suXXXX --env SUMO_ACCESS_KEY=<key> --env SUMO_DEPLOYMENT=eu -- npx -y yokozuna-mcp
```

Add `--scope user` to make it available in every project. Verify with `claude mcp list`.

### Codex

Add to `~/.codex/config.toml` (or use
`codex mcp add yokozuna --env SUMO_ACCESS_ID=suXXXX --env SUMO_ACCESS_KEY=<key> -- npx -y yokozuna-mcp`):

```toml
[mcp_servers.yokozuna]
command = "npx"
args = ["-y", "yokozuna-mcp"]

[mcp_servers.yokozuna.env]
SUMO_ACCESS_ID = "suXXXX"
SUMO_ACCESS_KEY = "<key>"
SUMO_DEPLOYMENT = "eu"
```

Other clients (Claude Desktop, `.mcp.json`, from-source) are covered in the
[installation docs](https://yokozuna-mcp.readthedocs.io/en/latest/installation/).

## Environment variables

The server does **not** read a `.env` file by itself — pass variables via the MCP
client's `env` block (as above).

| Var | Required | Default | Notes |
|---|---|---|---|
| `SUMO_ACCESS_ID` | yes | — | Access ID. |
| `SUMO_ACCESS_KEY` | yes | — | Access key. **Never logged or echoed.** |
| `SUMO_DEPLOYMENT` | no | `eu` | One of `au,ca,ch,de,eu,fed,in,jp,kr,us1,us2`. |
| `SUMO_ENDPOINT` | no | derived | Explicit **API** base URL override; takes precedence over `SUMO_DEPLOYMENT`. |
| `SUMO_UI_BASE_URL` | no | `service.<code>.sumologic.com` | **UI** origin for "open in Sumo UI" deep links, e.g. `https://<org>.<deployment>.sumologic.com`. |

All remaining variables (output tuning, export dir, keepalive, facet defaults) are in the
[configuration docs](https://yokozuna-mcp.readthedocs.io/en/latest/configuration/).

## Documentation

Full documentation — the 14-tool reference, the querying & schema-learning workflow,
monitoring, troubleshooting, and development — lives at
**<https://yokozuna-mcp.readthedocs.io/>**.
