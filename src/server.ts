import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { SumoClient } from './http/sumoClient.js';
import { SearchJobApi } from './sumo/searchJobApi.js';
import { MonitorsApi } from './sumo/monitorsApi.js';
import { KeepaliveRegistry } from './sumo/lifecycle.js';
import { registerTools } from './tools/registerTools.js';
import { registerPrompts } from './tools/registerPrompts.js';

const require = createRequire(import.meta.url);

function packageVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface CreatedServer {
  server: McpServer;
  keepalive: KeepaliveRegistry;
}

/**
 * Build a configured McpServer. Transport-agnostic: no stdio (or any transport)
 * references in here — the caller wires the transport.
 */
export function createServer(config: Config): CreatedServer {
  const client = new SumoClient({
    accessId: config.accessId,
    accessKey: config.accessKey,
    baseUrl: config.baseUrl,
  });
  const api = new SearchJobApi(client);
  const monitors = new MonitorsApi(client);
  const keepalive = new KeepaliveRegistry(api, {
    idleTtlMs: config.keepaliveIdleMinutes * 60_000,
    maxJobs: config.keepaliveMaxJobs,
    onError: (jobId) => {
      // stderr only — stdout is the MCP protocol channel. Never log credentials.
      console.error(`[yokozuna-mcp] keepalive: job ${jobId} is gone server-side; untracking.`);
    },
    onEvict: (jobId) => {
      console.error(
        `[yokozuna-mcp] keepalive: job cap (YOKOZUNA_KEEPALIVE_MAX_JOBS=${config.keepaliveMaxJobs}) reached — evicted stalest job ${jobId} from keepalive; it will expire server-side unless accessed.`,
      );
    },
  });

  const server = new McpServer({ name: 'yokozuna-mcp', version: packageVersion() });
  registerTools(server, { config, api, monitors, keepalive });
  registerPrompts(server, config);
  return { server, keepalive };
}
