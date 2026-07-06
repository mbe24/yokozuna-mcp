import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { KeepaliveRegistry } from '../src/sumo/lifecycle.js';
import type { SearchJobApi } from '../src/sumo/searchJobApi.js';
import type { MonitorsApi } from '../src/sumo/monitorsApi.js';
import { registerPrompts } from '../src/tools/registerPrompts.js';
import { registerTools } from '../src/tools/registerTools.js';

async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ SUMO_ACCESS_ID: 'id', SUMO_ACCESS_KEY: 'key', ...env });
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const api = { create: vi.fn(), status: vi.fn(), messages: vi.fn(), records: vi.fn(), delete: vi.fn() };
  registerTools(server, {
    config,
    api: api as unknown as SearchJobApi,
    monitors: { search: vi.fn() } as unknown as MonitorsApi,
    keepalive: new KeepaliveRegistry(api as unknown as SearchJobApi, { intervalMs: 3_600_000 }),
  });
  registerPrompts(server, config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('triage prompt', () => {
  it('is listed with a description and an optional problem argument', async () => {
    const client = await setup();
    const res = await client.listPrompts();
    const triage = res.prompts.find((p) => p.name === 'triage');
    expect(triage).toBeTruthy();
    expect(triage!.description ?? '').not.toBe('');
    const arg = triage!.arguments?.find((a) => a.name === 'problem');
    expect(arg).toBeTruthy();
    expect(arg!.required).toBeFalsy();
  });

  it('carries the schema-neutral cookbook (workflow, severity variance, tracing, extract) and embeds the problem', async () => {
    const client = await setup();
    const res = await client.getPrompt({
      name: 'triage',
      arguments: { problem: 'checkout 500s on preview' },
    });
    const txt = res.messages.map((m) => (m.content as { text: string }).text).join('\n');
    expect(txt).toContain('checkout 500s on preview');
    expect(txt).toContain('sumo_facets');
    expect(txt).toContain('sumo_trend');
    expect(txt).toContain('sumo_error_digest');
    expect(txt).toContain('sumo_export_results');
    expect(txt).toContain('byReceiptTime');
    expect(txt).toMatch(/hostname keyword/i);
    // §9.3: schema-neutral severity guidance — variance stated, no universal recipe.
    expect(txt).toContain('schemas VARY per system');
    expect(txt).toContain('sumo_describe_schema');
    expect(txt).toContain('matched-N-of-M');
    expect(txt).toContain('filter=');
    expect(txt).not.toContain('| json field=_raw "log.levelname" as levelname nodrop'); // the old universal recipe
    expect(txt).not.toMatch(/stream:"stderr" is NOT/i); // family-A-only claim removed
    // Neutral placeholders only (no org names): the default scope example and the
    // hostname example both come from the reserved example.com namespace.
    expect(txt).toContain('kubernetes/myservice/*/backend');
    expect(txt).toContain('example.com');
  });

  it('embeds the configured default source category as the scope example', async () => {
    const client = await setup({ SUMO_DEFAULT_SOURCE_CATEGORY: 'kubernetes/acme/backend' });
    const res = await client.getPrompt({ name: 'triage', arguments: {} });
    const txt = res.messages.map((m) => (m.content as { text: string }).text).join('\n');
    expect(txt).toContain('kubernetes/acme/backend');
  });

  it('the run_search description is slim: it points at the prompt instead of inlining the cookbook', async () => {
    const client = await setup();
    const tools = await client.listTools();
    const run = tools.tools.find((t) => t.name === 'sumo_run_search')!;
    expect(run.description).toContain('triage');
    expect(run.description).not.toContain('Example queries'); // the old EXAMPLES block
    expect(run.description!.length).toBeLessThan(2500);
  });
});
