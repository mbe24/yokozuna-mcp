# Installation

Following this page top-to-bottom yields a working, registered MCP server.

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
  region produces an HTTP 301 error that names the correct one (see
  [Troubleshooting](troubleshooting.md)).

## Install from npm (recommended)

The package is published to the npm registry as
[`yokozuna-mcp`](https://www.npmjs.com/package/yokozuna-mcp) — no checkout or build
needed. `npx -y yokozuna-mcp` fetches and runs the server directly, so registering it in
an MCP client (below) is the whole installation.

## Provide credentials (environment variables)

!!! important
    The server does **NOT** read a `.env` file by itself. Environment variables must
    reach the server process via one of:

    1. the `env` block of your MCP client config (recommended — see below),
    2. exported shell variables, or
    3. `node --env-file=.env dist/index.js` (Node's built-in flag; used by the smoke
       test below when running from source).

Only two variables are required:

| Var | Required | Default | Notes |
|---|---|---|---|
| `SUMO_ACCESS_ID` | yes | — | Access ID. |
| `SUMO_ACCESS_KEY` | yes | — | Access key. **Never logged or echoed.** |
| `SUMO_DEPLOYMENT` | no | `eu` | One of `au,ca,ch,de,eu,fed,in,jp,kr,us1,us2`. |

The full variable list (endpoints, UI deep links, output tuning, keepalive) is in
[Configuration](configuration.md).

## Register in an MCP client

### Claude Code

One command (replace the credentials):

```sh
claude mcp add yokozuna --env SUMO_ACCESS_ID=suXXXX --env SUMO_ACCESS_KEY=<key> --env SUMO_DEPLOYMENT=eu -- npx -y yokozuna-mcp
```

By default this registers for the current project only; add `--scope user` to make it
available in every project. Alternatively, create/extend `.mcp.json` **in the root of the
project where you want to use it** (shared, project scope):

```json
{
  "mcpServers": {
    "yokozuna": {
      "command": "npx",
      "args": ["-y", "yokozuna-mcp"],
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

!!! warning
    Do not commit a `.mcp.json` containing the real access key to a shared repo — prefer
    `claude mcp add` (local scope) or user-level config for real credentials.

### Codex CLI

Either one command:

```sh
codex mcp add yokozuna --env SUMO_ACCESS_ID=suXXXX --env SUMO_ACCESS_KEY=<key> --env SUMO_DEPLOYMENT=eu -- npx -y yokozuna-mcp
```

or add this block to `~/.codex/config.toml` (shared by the Codex CLI and IDE extension):

```toml
[mcp_servers.yokozuna]
command = "npx"
args = ["-y", "yokozuna-mcp"]

[mcp_servers.yokozuna.env]
SUMO_ACCESS_ID = "suXXXX"
SUMO_ACCESS_KEY = "<key>"
SUMO_DEPLOYMENT = "eu"
```

### Claude Desktop

Edit `claude_desktop_config.json` (create it if missing):

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "yokozuna": {
      "command": "npx",
      "args": ["-y", "yokozuna-mcp"],
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

## Running from source (alternative)

To run from a checkout instead of the registry (development, unreleased changes):

```sh
cd <path-to-the-repo>       # e.g. C:/Users/you/Development/yokozuna
npm install
npm run build
```

The build produces `dist/index.js` (the server entry point). Note its **absolute path** —
you need it for client config. Three equivalent local launch forms:

1. **Direct node** (most explicit): `"command": "node", "args": ["<abs>/dist/index.js"]`
2. **npx with a local path** (no registry involved): `"command": "npx", "args": ["<abs-project-dir>"]`
3. **Linked bin** (after `npm link`): `"command": "yokozuna-mcp"` or `"command": "npx", "args": ["yokozuna-mcp"]`

On Windows, use forward slashes (`C:/Users/...`) or escaped backslashes
(`C:\\Users\\...`) in JSON — never single backslashes.

## Smoke-test the server (optional but recommended)

With a filled-in `.env` in the repo root (copy `.env.example` and fill in the two
required values), this sends a real MCP handshake plus `tools/list` over stdio and
exits. Expect a `tools` array with **14 tools** on stdout and only
`[yokozuna-mcp] server started (stdio)` on stderr.

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
the env vars did not reach the process — see the credentials section above.
