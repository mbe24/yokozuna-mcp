#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Configuration errors must be readable, never a stack trace, and never leak the key.
    console.error(`[yokozuna-mcp] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const { server, keepalive } = createServer(config);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[yokozuna-mcp] ${signal} received; cleaning up tracked search jobs…`);
    try {
      await keepalive.shutdown();
    } catch {
      // best effort
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.connect(transport);
  console.error('[yokozuna-mcp] server started (stdio)');
}

main().catch((err) => {
  console.error(`[yokozuna-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
