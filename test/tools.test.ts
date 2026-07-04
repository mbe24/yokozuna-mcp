import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { SumoApiError } from '../src/http/errors.js';
import { KeepaliveRegistry } from '../src/sumo/lifecycle.js';
import type { SearchJobApi } from '../src/sumo/searchJobApi.js';
import type { MonitorsApi, MonitorSearchHit } from '../src/sumo/monitorsApi.js';
import type { SearchJobStatus } from '../src/sumo/types.js';
import { registerTools } from '../src/tools/registerTools.js';

const COOKIE_WARNING =
  'You must enable cookies for subsequent requests to the search job. A 404 status…';

const doneStatus = (messageCount: number, recordCount: number, extra?: Partial<SearchJobStatus>): SearchJobStatus => ({
  state: 'DONE GATHERING RESULTS',
  messageCount,
  recordCount,
  pendingWarnings: [],
  pendingErrors: [],
  warning: COOKIE_WARNING,
  ...extra,
});

const msgRow = (message: string, level = 'INFO') => ({
  map: {
    _messagetime: '1783017533330',
    _sourcecategory: 'kubernetes/myservice/backend',
    _loglevel: level,
    _raw: JSON.stringify({ log: { levelname: level, request_id: 'req-1', message } }),
  },
});

type MockApi = { [K in keyof SearchJobApi]: ReturnType<typeof vi.fn> };

function mockApi(overrides: Partial<Record<keyof SearchJobApi, unknown>> = {}): MockApi {
  return {
    create: vi.fn(async () => ({ id: 'JOB1' })),
    status: vi.fn(async () => doneStatus(2, 0)),
    messages: vi.fn(async () => ({ fields: [], messages: [msgRow('hello'), msgRow('world')], warning: COOKIE_WARNING })),
    records: vi.fn(async () => ({ fields: [], records: [], warning: COOKIE_WARNING })),
    delete: vi.fn(async () => {}),
    ...(overrides as object),
  } as MockApi;
}

type MockMonitors = { search: ReturnType<typeof vi.fn> };

function mockMonitors(hits: MonitorSearchHit[] = []): MockMonitors {
  return { search: vi.fn(async () => hits) };
}

const FIXED_NOW = 1_783_017_600_000;

async function setup(
  api: MockApi,
  env: Record<string, string> = {},
  nowFn: () => number = () => FIXED_NOW,
  monitors: MockMonitors = mockMonitors(),
) {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yokozuna-test-'));
  const config = loadConfig({
    SUMO_ACCESS_ID: 'id',
    SUMO_ACCESS_KEY: 'key',
    YOKOZUNA_EXPORT_DIR: exportDir,
    ...env,
  });
  const keepalive = new KeepaliveRegistry(api as unknown as SearchJobApi, { intervalMs: 3_600_000 });
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, {
    config,
    api: api as unknown as SearchJobApi,
    monitors: monitors as unknown as MonitorsApi,
    keepalive,
    now: nowFn,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, keepalive, exportDir };
}

// ------------------------------------------------------------------ direct handler access
// For cancellation/progress tests the handlers are captured from registerTools directly,
// so a custom `extra` (signal, _meta.progressToken, sendNotification) can be injected.

interface RawToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
type RawHandler = (input: Record<string, unknown>, extra: unknown) => Promise<RawToolResult>;

function setupHandlers(api: MockApi, env: Record<string, string> = {}) {
  const config = loadConfig({ SUMO_ACCESS_ID: 'id', SUMO_ACCESS_KEY: 'key', ...env });
  const keepalive = new KeepaliveRegistry(api as unknown as SearchJobApi, { intervalMs: 3_600_000 });
  const handlers = new Map<string, RawHandler>();
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, handler: RawHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerTools(fakeServer, {
    config,
    api: api as unknown as SearchJobApi,
    monitors: mockMonitors() as unknown as MonitorsApi,
    keepalive,
    now: () => FIXED_NOW,
  });
  const call = (name: string, input: Record<string, unknown>, extra: unknown) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`tool not registered: ${name}`);
    return h(input, extra);
  };
  return { call, keepalive };
}

function extraFor(opts: { signal?: AbortSignal; progressToken?: string | number } = {}) {
  const sendNotification = vi.fn(async () => {});
  return {
    extra: {
      signal: opts.signal ?? new AbortController().signal,
      _meta: opts.progressToken !== undefined ? { progressToken: opts.progressToken } : undefined,
      sendNotification,
      requestId: 1,
    },
    sendNotification,
  };
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const text = (r: unknown) => (r as ToolResult).content.map((c) => c.text).join('\n');

describe('tools/list', () => {
  it('exposes all twelve tools with non-empty descriptions and schemas', async () => {
    const { client } = await setup(mockApi());
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'sumo_create_search_job',
      'sumo_delete_search_job',
      'sumo_error_digest',
      'sumo_export_results',
      'sumo_facets',
      'sumo_get_messages',
      'sumo_get_records',
      'sumo_get_search_job_status',
      'sumo_list_monitors',
      'sumo_new_since',
      'sumo_run_search',
      'sumo_trend',
    ]);
    for (const t of res.tools) {
      expect(t.description ?? '').not.toBe('');
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it('annotates every read tool readOnly/closedWorld and delete as idempotent non-destructive', async () => {
    const { client } = await setup(mockApi());
    const res = await client.listTools();
    for (const t of res.tools) {
      expect(t.annotations, `annotations missing on ${t.name}`).toBeTruthy();
      if (t.name === 'sumo_delete_search_job') {
        expect(t.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      } else {
        expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      }
    }
  });
});

describe('sumo_run_search', () => {
  it('runs a non-aggregate search, formats results, and deletes the job', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'myservice-preview.dev.example.com', last: '15m' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('hello');
    expect(out).toContain('req=req-1');
    expect(out).toContain('messageCount=2');
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
    expect(out).not.toContain('You must enable cookies');
  });

  it('includes a Sumo UI deep link for known deployments', async () => {
    const { client } = await setup(mockApi());
    const res = await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'error', last: '15m' },
    });
    expect(text(res)).toContain('https://service.eu.sumologic.com/log-search/create?query=error');
  });

  it('fetches /records (never /messages) for aggregate jobs', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(1727, 4)),
      records: vi.fn(async () => ({
        fields: [
          { name: 'levelname', fieldType: 'string', keyField: true },
          { name: '_count', fieldType: 'long', keyField: false },
        ],
        records: [{ map: { levelname: 'ERROR', _count: '18' } }],
      })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x | count by levelname', last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('recordCount=4');
    expect(out).toContain('scanned input');
    expect(out).toContain('ERROR');
    expect(api.messages).not.toHaveBeenCalled();
    expect(api.delete).toHaveBeenCalled();
  });

  it('falls back to /records when a ZERO-record aggregate 400s on /messages', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(0, 0)),
      messages: vi.fn(async () => {
        throw new SumoApiError(
          400,
          { code: 'searchjob.raw.messages.not.available', message: 'requireRawMessages is false for this search job.' },
          'x',
        );
      }),
      records: vi.fn(async () => ({
        fields: [{ name: '_count', fieldType: 'long', keyField: false }],
        records: [],
      })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: '"no match" | count', last: '15m' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('No results');
    expect(api.records).toHaveBeenCalled();
    expect(api.delete).toHaveBeenCalled();
  });

  it('returns a clean 0-result summary including real warnings, minus cookie noise', async () => {
    const api = mockApi({
      status: vi.fn(async () =>
        doneStatus(0, 0, { pendingWarnings: ['partition xyz not found', COOKIE_WARNING] }),
      ),
      messages: vi.fn(async () => ({ fields: [], messages: [] })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: '_sourceCategory=typo', last: '15m' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('No results');
    expect(out).toContain('partition xyz not found');
    expect(out).not.toContain('You must enable cookies');
  });

  it('deletes the job even when the search fails mid-flight, without masking the error', async () => {
    const api = mockApi({
      status: vi.fn(async () => ({ ...doneStatus(0, 0), state: 'CANCELLED' })),
      delete: vi.fn(async () => {
        throw new SumoApiError(404, { code: 'searchjob.jobid.invalid', message: 'Job ID is invalid.' }, 'x');
      }),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('CANCELLED'); // original error, not the cleanup 404
    expect(api.delete).toHaveBeenCalled();
  });

  it('reports the kept job id even when the search has zero results', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(0, 0)),
      messages: vi.fn(async () => ({ fields: [], messages: [] })),
    });
    const { client, keepalive } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m', keepJob: true },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('No results');
    expect(out).toContain('id=JOB1'); // the kept job must be reported so it can be deleted
    expect(keepalive.trackedIds()).toContain('JOB1');
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('keeps the job and registers keepalive with keepJob: true', async () => {
    const api = mockApi();
    const { client, keepalive } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m', keepJob: true },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(api.delete).not.toHaveBeenCalled();
    expect(keepalive.trackedIds()).toContain('JOB1');
    expect(text(res)).toContain('JOB1');
  });

  it('detail:summary runs ONE extra count-by-levelname aggregate for exact whole-job counts', async () => {
    const createdQueries: string[] = [];
    const api = mockApi({
      create: vi.fn(async (req: { query: string }) => {
        createdQueries.push(req.query);
        return { id: createdQueries.length === 1 ? 'MAIN' : 'AGG' };
      }),
      status: vi.fn(async () => doneStatus(500, 0)),
      records: vi.fn(async () => ({
        fields: [
          { name: 'levelname', fieldType: 'string', keyField: true },
          { name: '_count', fieldType: 'long', keyField: false },
        ],
        records: [
          { map: { levelname: 'INFO', _count: '480' } },
          { map: { levelname: 'WARN', _count: '2' } }, // alias → merges into WARNING
          { map: { levelname: 'WARNING', _count: '14' } },
          { map: { levelname: '', _count: '4' } }, // nodrop empty → UNKNOWN
        ],
      })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m', detail: 'summary' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('by level (exact, whole job):');
    expect(out).toContain('INFO: 480');
    expect(out).toContain('WARNING: 16'); // WARN(2) + WARNING(14) merged
    expect(out).toContain('UNKNOWN: 4');
    expect(createdQueries.length).toBe(2); // main job + one aggregate
    expect(createdQueries[1]).toContain('count by levelname');
    expect(api.delete).toHaveBeenCalledWith('AGG', { tolerateMissing: true });
    expect(api.delete).toHaveBeenCalledWith('MAIN', { tolerateMissing: true });
  });

  it('detail:summary falls back to a clearly-labeled SAMPLE count when the aggregate errors', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(500, 0)),
      records: vi.fn(async () => {
        throw new SumoApiError(400, { code: 'searchjob.query.creation.error', message: 'nope' }, 'x');
      }),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m', detail: 'summary' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).not.toContain('exact, whole job');
    expect(out).toContain('by level (over first 2 of 500 — sample):');
  });

  it('detail:summary starts the side-aggregate CONCURRENTLY (created before the first main poll)', async () => {
    let createCallsAtFirstStatus = -1;
    const api = mockApi({
      status: vi.fn(async () => {
        if (createCallsAtFirstStatus === -1) {
          createCallsAtFirstStatus = api.create.mock.calls.length;
        }
        return doneStatus(500, 0);
      }),
      records: vi.fn(async () => ({
        fields: [
          { name: 'levelname', fieldType: 'string', keyField: true },
          { name: '_count', fieldType: 'long', keyField: false },
        ],
        records: [{ map: { levelname: 'INFO', _count: '500' } }],
      })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m', detail: 'summary' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    // Both jobs were created before the main job's FIRST status poll — no ordering dep.
    expect(createCallsAtFirstStatus).toBe(2);
    expect(text(res)).toContain('by level (exact, whole job):');
  });

  it('detail:summary SKIPS the side-aggregate for aggregate queries', async () => {
    // Aggregate operator in the query, but the job yields messages (recordCount 0) so the
    // messages/summary path runs: the side-aggregate must be skipped, sample label used.
    const api = mockApi({ status: vi.fn(async () => doneStatus(500, 0)) });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x | count by levelname', last: '15m', detail: 'summary' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(api.create).toHaveBeenCalledTimes(1); // main job only — no side-aggregate
    const out = text(res);
    expect(out).not.toContain('exact, whole job');
    expect(out).toContain('— sample');
  });

  it('detail:summary side-aggregate honors YOKOZUNA_LEVEL_EXPR', async () => {
    const createdQueries: string[] = [];
    const api = mockApi({
      create: vi.fn(async (req: { query: string }) => {
        createdQueries.push(req.query);
        return { id: `J${createdQueries.length}` };
      }),
      status: vi.fn(async () => doneStatus(500, 0)),
    });
    const { client } = await setup(api, { YOKOZUNA_LEVEL_EXPR: 'log.severity' });
    await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m', detail: 'summary' },
    });
    expect(createdQueries[1]).toContain('json field=_raw "log.severity" as levelname nodrop');
  });

  it('returns messages oldest→newest by default (sort asc) and newest-first on sort:desc', async () => {
    const row = (t: string, message: string) => ({
      map: { _messagetime: t, _raw: JSON.stringify({ log: { levelname: 'INFO', message } }) },
    });
    const api = mockApi({
      messages: vi.fn(async () => ({
        fields: [],
        messages: [row('1783017535000', 'NEWEST'), row('1783017533000', 'OLDEST')],
      })),
    });
    const { client } = await setup(api);
    const asc = text(
      await client.callTool({ name: 'sumo_run_search', arguments: { query: 'x', last: '15m' } }),
    );
    expect(asc.indexOf('OLDEST')).toBeLessThan(asc.indexOf('NEWEST'));
    const desc = text(
      await client.callTool({
        name: 'sumo_run_search',
        arguments: { query: 'x', last: '15m', sort: 'desc' },
      }),
    );
    expect(desc.indexOf('NEWEST')).toBeLessThan(desc.indexOf('OLDEST'));
  });

  it('appends a paging hint when fewer messages are shown than messageCount', async () => {
    const api = mockApi({ status: vi.fn(async () => doneStatus(10, 0)) });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({ name: 'sumo_run_search', arguments: { query: 'x', last: '15m' } }),
    );
    expect(out).toContain('showing 2 of 10 messages — raise limit');
    expect(out).toContain('sumo_get_messages offset/limit');
  });

  it('rejects inline limit above 5000 at the schema layer', async () => {
    const { client } = await setup(mockApi());
    // The SDK surfaces input-validation failures as isError tool results.
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m', limit: 6000 },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('5000');
  });

  it('errors helpfully when neither last nor from/to is given', async () => {
    const { client } = await setup(mockApi());
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/exactly one/i);
  });

  it('surfaces query parser errors verbatim', async () => {
    const api = mockApi({
      create: vi.fn(async () => {
        throw new SumoApiError(
          400,
          { code: 'searchjob.query.creation.error', message: "Unexpected token 'x' found." },
          'y',
        );
      }),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: '| bad x', last: '15m' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Unexpected token 'x' found.");
  });
});

describe('primitives', () => {
  it('sumo_create_search_job returns the id and registers keepalive', async () => {
    const api = mockApi();
    const { client, keepalive } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_create_search_job',
      arguments: { query: 'x', last: '15m' },
    })) as ToolResult;
    expect(text(res)).toContain('id=JOB1');
    expect(keepalive.trackedIds()).toContain('JOB1');
  });

  it('sumo_get_search_job_status reports state and counts', async () => {
    const { client } = await setup(mockApi());
    const res = (await client.callTool({
      name: 'sumo_get_search_job_status',
      arguments: { id: 'JOB1' },
    })) as ToolResult;
    const out = text(res);
    expect(out).toContain('state: DONE GATHERING RESULTS');
    expect(out).toContain('messageCount: 2');
  });

  it('sumo_get_messages on an aggregate job points to sumo_get_records', async () => {
    const api = mockApi({
      messages: vi.fn(async () => {
        throw new SumoApiError(400, { code: 'searchjob.raw.messages.not.available', message: 'nope' }, 'x');
      }),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_get_messages',
      arguments: { id: 'JOB1' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('sumo_get_records');
  });

  it('sumo_get_messages sorts oldest→newest by default too', async () => {
    const row = (t: string, message: string) => ({
      map: { _messagetime: t, _raw: JSON.stringify({ log: { levelname: 'INFO', message } }) },
    });
    const api = mockApi({
      messages: vi.fn(async () => ({
        fields: [],
        messages: [row('1783017535000', 'NEWEST'), row('1783017533000', 'OLDEST')],
      })),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({ name: 'sumo_get_messages', arguments: { id: 'JOB1' } }),
    );
    expect(out.indexOf('OLDEST')).toBeLessThan(out.indexOf('NEWEST'));
  });

  it('sumo_get_records on a non-aggregate job points to sumo_get_messages', async () => {
    const api = mockApi({
      records: vi.fn(async () => {
        throw new SumoApiError(
          400,
          { code: 'searchjob.no.records.not.an.aggregation.query', message: 'nope' },
          'x',
        );
      }),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_get_records',
      arguments: { id: 'JOB1' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('sumo_get_messages');
  });

  it('sumo_delete_search_job tolerates already-gone jobs and unregisters keepalive', async () => {
    const api = mockApi();
    const { client, keepalive } = await setup(api);
    keepalive.register('JOB1');
    const res = (await client.callTool({
      name: 'sumo_delete_search_job',
      arguments: { id: 'JOB1' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
    expect(keepalive.trackedIds()).not.toContain('JOB1');
  });
});

describe('sumo_export_results', () => {
  it('streams flattened NDJSON to a file and returns the path, not the payload', async () => {
    let call = 0;
    const api = mockApi({
      status: vi.fn(async () => doneStatus(5, 0)),
      messages: vi.fn(async () => {
        call += 1;
        if (call === 1) return { fields: [], messages: [msgRow('a'), msgRow('b'), msgRow('c')] };
        if (call === 2) return { fields: [], messages: [msgRow('d'), msgRow('e')] };
        return { fields: [], messages: [] };
      }),
    });
    const { client, exportDir } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_export_results',
      arguments: { query: 'x', last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('exported: 5 messages');
    const fileLine = out.split('\n').find((l) => l.startsWith('file: '))!;
    const file = fileLine.slice('file: '.length);
    expect(file.startsWith(exportDir)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(5);
    const first = JSON.parse(lines[0]!);
    expect(first.message).toBe('a');
    expect(first.request_id).toBe('req-1');
    expect(first._raw).toBeUndefined(); // bulky duplicate dropped
    expect(out).not.toContain('"message":"a"'); // payload not inlined in the tool result
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
  });
});

describe('cancellation', () => {
  it('pre-aborted request fails fast, deletes the job exactly once, and never registers keepalive', async () => {
    const api = mockApi();
    const { call, keepalive } = setupHandlers(api);
    const controller = new AbortController();
    controller.abort();
    const { extra } = extraFor({ signal: controller.signal });
    const res = await call('sumo_run_search', { query: 'x', last: '15m', keepJob: true }, extra);
    expect(res.isError).toBe(true);
    expect(api.status).not.toHaveBeenCalled(); // fast fail — no poll burned
    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
    expect(keepalive.trackedIds()).toEqual([]);
  });

  it('abort mid-wait stops polling and still deletes the job', async () => {
    const controller = new AbortController();
    const api = mockApi({
      status: vi.fn(async () => {
        controller.abort(); // abort DURING the wait loop
        return { ...doneStatus(0, 0), state: 'GATHERING RESULTS' };
      }),
    });
    const { call } = setupHandlers(api);
    const { extra } = extraFor({ signal: controller.signal });
    const res = await call('sumo_run_search', { query: 'x', last: '15m' }, extra);
    expect(res.isError).toBe(true);
    expect(api.status).toHaveBeenCalledTimes(1); // no further polls after the abort
    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
  });

  it('sumo_create_search_job aborted right after create deletes instead of keepaliving', async () => {
    const controller = new AbortController();
    const api = mockApi({
      create: vi.fn(async () => {
        controller.abort();
        return { id: 'JOB1' };
      }),
    });
    const { call, keepalive } = setupHandlers(api);
    const { extra } = extraFor({ signal: controller.signal });
    const res = await call('sumo_create_search_job', { query: 'x', last: '15m' }, extra);
    expect(res.isError).toBe(true);
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
    expect(keepalive.trackedIds()).toEqual([]);
  });
});

describe('progress notifications', () => {
  const digestApi = () => {
    let page = 0;
    return mockApi({
      status: vi.fn(async () => doneStatus(3, 0)),
      messages: vi.fn(async () => {
        page += 1;
        if (page === 1) return { fields: [], messages: [msgRow('a', 'ERROR'), msgRow('b', 'ERROR')] };
        if (page === 2) return { fields: [], messages: [msgRow('c', 'WARNING')] };
        return { fields: [], messages: [] };
      }),
    });
  };

  it('emits notifications/progress with a strictly increasing counter when a token is present', async () => {
    const api = digestApi();
    const { call } = setupHandlers(api, { SUMO_DEFAULT_SOURCE_CATEGORY: 'cat/x' });
    const { extra, sendNotification } = extraFor({ progressToken: 'tok-1' });
    const res = await call('sumo_error_digest', { last: '15m' }, extra);
    expect(res.isError).toBeFalsy();
    const notes = sendNotification.mock.calls.map(
      (c) => (c as unknown[])[0] as {
        method: string;
        params: { progressToken: string; progress: number; total?: number; message?: string };
      },
    );
    expect(notes.length).toBeGreaterThanOrEqual(3); // 1 status poll + 2 message pages
    for (const [i, n] of notes.entries()) {
      expect(n.method).toBe('notifications/progress');
      expect(n.params.progressToken).toBe('tok-1');
      expect(n.params.progress).toBe(i + 1); // strictly increasing, monotonic counter
      expect(n.params.total).toBeUndefined(); // unknowable upfront — intentionally omitted
    }
  });

  it('emits nothing when no progressToken was sent', async () => {
    const api = digestApi();
    const { call } = setupHandlers(api, { SUMO_DEFAULT_SOURCE_CATEGORY: 'cat/x' });
    const { extra, sendNotification } = extraFor();
    const res = await call('sumo_error_digest', { last: '15m' }, extra);
    expect(res.isError).toBeFalsy();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe('sumo_facets', () => {
  it('runs one aggregate per dimension: native for _fields, log.* JSON parse otherwise', async () => {
    const createdQueries: string[] = [];
    const api = mockApi({
      create: vi.fn(async (req: { query: string }) => {
        createdQueries.push(req.query);
        return { id: `F${createdQueries.length}` };
      }),
      records: vi.fn(async (id: string) => {
        if (id === 'F1') {
          return {
            fields: [],
            records: [
              { map: { _sourcecategory: 'kubernetes/a/backend', _count: '42' } },
              { map: { _sourcecategory: '', _count: '7' } }, // nodrop empty → (none)
            ],
          };
        }
        return { fields: [], records: [{ map: { path: '/api/x', _count: '5' } }] };
      }),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_facets',
      arguments: { query: 'scope', last: '30m', dimensions: ['_sourcecategory', 'path'] },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(createdQueries).toEqual([
      'scope | count by _sourcecategory | sort by _count | limit 15',
      'scope | json field=_raw "log.path" as path nodrop | count by path | sort by _count | limit 15',
    ]);
    const out = text(res);
    expect(out).toContain('_sourcecategory:');
    expect(out).toContain('42  kubernetes/a/backend'); // _count parsed to int, aligned
    expect(out).toContain('(none)'); // empty-string key
    expect(out).toContain('path:');
    expect(out).toContain('5  /api/x');
    expect(api.delete).toHaveBeenCalledWith('F1', { tolerateMissing: true });
    expect(api.delete).toHaveBeenCalledWith('F2', { tolerateMissing: true });
  });

  it('one failing dimension yields an error line, not a total failure', async () => {
    const api = mockApi({
      create: vi.fn(async (req: { query: string }) => {
        if (req.query.includes('log.baddim')) {
          throw new SumoApiError(
            400,
            { code: 'searchjob.query.creation.error', message: 'parse error near baddim' },
            'x',
          );
        }
        return { id: 'FOK' };
      }),
      records: vi.fn(async () => ({
        fields: [],
        records: [{ map: { _sourcehost: 'node-1', _count: '3' } }],
      })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_facets',
      arguments: { query: 'scope', last: '30m', dimensions: ['_sourcehost', 'baddim'] },
    })) as ToolResult;
    expect(res.isError).toBeFalsy(); // partial success is a SUCCESS
    const out = text(res);
    expect(out).toContain('3  node-1');
    expect(out).toContain('baddim: ERROR — ');
    expect(out).toContain('parse error near baddim');
    expect(api.delete).toHaveBeenCalledWith('FOK', { tolerateMissing: true }); // good job cleaned
  });

  it('uses the configured default dimensions (YOKOZUNA_FACET_DIMENSIONS)', async () => {
    const createdQueries: string[] = [];
    const api = mockApi({
      create: vi.fn(async (req: { query: string }) => {
        createdQueries.push(req.query);
        return { id: `F${createdQueries.length}` };
      }),
      records: vi.fn(async () => ({ fields: [], records: [] })),
    });
    const { client } = await setup(api, { YOKOZUNA_FACET_DIMENSIONS: '_collector,logger' });
    await client.callTool({ name: 'sumo_facets', arguments: { query: 'scope', last: '30m' } });
    expect(createdQueries).toHaveLength(2);
    expect(createdQueries[0]).toContain('count by _collector');
    expect(createdQueries[1]).toContain('"log.logger" as logger');
  });
});

describe('sumo_error_digest', () => {
  const digestRow = (t: number, level: string, message: string, reqId = '') => ({
    map: {
      _messagetime: String(t),
      _sourcecategory: 'cat/be',
      _raw: JSON.stringify({ log: { levelname: level, request_id: reqId, message } }),
    },
  });
  const T1 = 1_783_017_500_000;
  const T2 = 1_783_017_540_000;
  const T3 = 1_783_017_580_000;

  const digestApi = (extraRows: ReturnType<typeof digestRow>[] = []) => {
    let page = 0;
    return mockApi({
      status: vi.fn(async () => doneStatus(3 + extraRows.length, 0)),
      messages: vi.fn(async () => {
        page += 1;
        if (page > 1) return { fields: [], messages: [] };
        return {
          fields: [],
          messages: [
            digestRow(T1, 'ERROR', 'boom id=111'),
            digestRow(T3, 'ERROR', 'boom id=222', 'req-9'),
            digestRow(T2, 'WARNING', 'slow query took 1.2s'),
            ...extraRows,
          ],
        };
      }),
    });
  };

  it('groups by (level, signature) with count, first/last, sample request_id, and source', async () => {
    const api = digestApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_error_digest',
      arguments: { query: '_sourcecategory=cat/be', last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('scanned 3 messages, 2 distinct signatures');
    const errLine = out.split('\n').find((l) => l.startsWith('×2 ERROR'))!;
    expect(errLine).toContain(`${new Date(T1).toISOString()}..${new Date(T3).toISOString()}`);
    expect(errLine).toContain('req=req-9'); // first NON-EMPTY request_id
    expect(errLine).toContain('[cat/be]');
    expect(errLine).toContain('boom id=111'); // representative = first occurrence
    expect(out).toContain('×1 WARNING');
    // Query shape: levelExpr parse + quoted default levels.
    const createdQuery = (api.create.mock.calls[0] as [{ query: string }])[0].query;
    expect(createdQuery).toBe(
      '_sourcecategory=cat/be | json field=_raw "log.levelname" as levelname nodrop | where levelname in ("ERROR","WARNING")',
    );
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
  });

  it('applies top-N (limit) while still reporting the full distinct count', async () => {
    const api = digestApi();
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_error_digest',
        arguments: { query: 'scope', last: '1h', limit: 1 },
      }),
    );
    expect(out).toContain('2 distinct signatures — top 1');
    expect(out).toContain('×2 ERROR');
    expect(out).not.toContain('×1 WARNING'); // beyond top-N
  });

  it('marks the digest TRUNCATED when maxScan stops the scan early', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(100, 0)),
      messages: vi.fn(async () => ({
        fields: [],
        messages: [digestRow(T1, 'ERROR', 'boom 1'), digestRow(T2, 'ERROR', 'boom 2')],
      })),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_error_digest',
        arguments: { query: 'scope', last: '1h', maxScan: 2 },
      }),
    );
    expect(out).toContain('scanned 2 messages');
    expect(out).toContain('[TRUNCATED');
  });

  it('falls back to SUMO_DEFAULT_SOURCE_CATEGORY when query is omitted', async () => {
    const api = digestApi();
    const { client } = await setup(api, { SUMO_DEFAULT_SOURCE_CATEGORY: 'kubernetes/x/backend' });
    const res = (await client.callTool({
      name: 'sumo_error_digest',
      arguments: { last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const createdQuery = (api.create.mock.calls[0] as [{ query: string }])[0].query;
    expect(createdQuery.startsWith('_sourcecategory=kubernetes/x/backend | json')).toBe(true);
  });

  it('errors clearly when there is no query and no default source category', async () => {
    const { client } = await setup(digestApi());
    const res = (await client.callTool({
      name: 'sumo_error_digest',
      arguments: { last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No scope');
  });

  it('honors a custom levels filter', async () => {
    const api = digestApi();
    const { client } = await setup(api);
    await client.callTool({
      name: 'sumo_error_digest',
      arguments: { query: 'scope', last: '1h', levels: ['CRITICAL'] },
    });
    const createdQuery = (api.create.mock.calls[0] as [{ query: string }])[0].query;
    expect(createdQuery).toContain('where levelname in ("CRITICAL")');
  });
});

describe('sumo_new_since', () => {
  const MARGIN_MS = 180_000;

  it('baseline: window is [to − lookback, now − settleMargin), byReceiptTime FORCED true, cursor=to', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_new_since',
      arguments: { query: 'x', lookback: '15m' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const to = 1_783_017_600_000 - MARGIN_MS;
    const from = to - 900_000;
    const req = (api.create.mock.calls[0] as [Record<string, unknown>])[0];
    expect(req).toMatchObject({ query: 'x', from, to, byReceiptTime: true });
    const out = text(res);
    expect(out).toContain('new since BASELINE (lookback 15m): 2 matches');
    expect(out).toContain(`cursor=${to}`);
    expect(out).toContain('settleMargin=180s');
    expect(out).toContain('byReceiptTime=true');
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
  });

  it('two sequential calls tile contiguously: from2 === to1 (half-open, no +1ms)', async () => {
    let t = 1_783_017_600_000;
    const api = mockApi();
    const { client } = await setup(api, {}, () => t);
    const out1 = text(
      await client.callTool({ name: 'sumo_new_since', arguments: { query: 'x' } }),
    );
    const cursor1 = Number(/cursor=(\d+)/.exec(out1)![1]);
    expect(cursor1).toBe(t - MARGIN_MS);

    t += 60_000; // one minute later
    const out2 = text(
      await client.callTool({
        name: 'sumo_new_since',
        arguments: { query: 'x', since: cursor1 },
      }),
    );
    const req2 = (api.create.mock.calls[1] as [Record<string, unknown>])[0];
    expect(req2['from']).toBe(cursor1); // from2 === to1 — contiguous tiling
    expect(req2['to']).toBe(t - MARGIN_MS);
    expect(req2['byReceiptTime']).toBe(true);
    expect(out2).toContain(`new since ${new Date(cursor1).toISOString()}`);
    expect(out2).toContain(`cursor=${t - MARGIN_MS}`);
  });

  it('polled too soon (to <= since): no job created, cursor echoed unchanged', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const since = 1_783_017_600_000 - 30_000; // newer than now − margin
    const res = (await client.callTool({
      name: 'sumo_new_since',
      arguments: { query: 'x', since },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('not settled yet');
    expect(out).toContain(`cursor=${since}`);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('rejects aggregate queries with a pointer to sumo_run_search', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_new_since',
      arguments: { query: 'x | count by levelname' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('sumo_run_search');
    expect(api.create).not.toHaveBeenCalled();
  });

  it('rejects a garbage since value without creating a job', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_new_since',
      arguments: { query: 'x', since: 'yesterday' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('cursor');
    expect(api.create).not.toHaveBeenCalled();
  });

  it('honors YOKOZUNA_SETTLE_MARGIN_SECONDS', async () => {
    const api = mockApi();
    const { client } = await setup(api, { YOKOZUNA_SETTLE_MARGIN_SECONDS: '60' });
    const out = text(
      await client.callTool({ name: 'sumo_new_since', arguments: { query: 'x' } }),
    );
    const req = (api.create.mock.calls[0] as [Record<string, unknown>])[0];
    expect(req['to']).toBe(1_783_017_600_000 - 60_000);
    expect(out).toContain('settleMargin=60s');
  });
});

describe('extract param', () => {
  it('compiles one chained | json clause per field on sumo_run_search', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: {
        query: '_sourcecategory=kubernetes/myservice/backend',
        last: '15m',
        extract: { status: 'log.status', user: 'log.context.user' },
      },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const req = (api.create.mock.calls[0] as [{ query: string }])[0];
    expect(req.query).toBe(
      '_sourcecategory=kubernetes/myservice/backend' +
        ' | json field=_raw "log.status" as status nodrop' +
        ' | json field=_raw "log.context.user" as user nodrop',
    );
  });

  it('rejects a non-identifier alias without creating a job', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m', extract: { 'bad alias': 'log.a' } },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('bad alias');
    expect(api.create).not.toHaveBeenCalled();
  });

  it('rejects a path containing double quotes without creating a job', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m', extract: { a: 'log."x"' } },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('rejects extract on aggregate queries with a clear message', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x | count by levelname', last: '15m', extract: { a: 'log.a' } },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('NON-aggregate');
    expect(api.create).not.toHaveBeenCalled();
  });
});

describe('whole-response cap (YOKOZUNA_MAX_RESPONSE_CHARS)', () => {
  it('truncates an oversized inline response with a pointer to sumo_export_results', async () => {
    const big = 'x'.repeat(400);
    const api = mockApi({
      status: vi.fn(async () => doneStatus(10, 0)),
      messages: vi.fn(async () => ({
        fields: [],
        messages: Array.from({ length: 10 }, (_, i) => msgRow(`${big} ${i}`)),
      })),
    });
    const { client } = await setup(api, { YOKOZUNA_MAX_RESPONSE_CHARS: '1000' });
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('[RESPONSE TRUNCATED');
    expect(out).toContain('sumo_export_results');
    // Cap + the truncation note itself; the note is bounded (~250 chars).
    expect(out.length).toBeLessThan(1400);
    // Header lines survive — truncation only eats the tail of the body.
    expect(out).toContain('messageCount=10');
  });

  it('leaves small responses untouched', async () => {
    const { client } = await setup(mockApi(), { YOKOZUNA_MAX_RESPONSE_CHARS: '1000' });
    const out = text(
      await client.callTool({ name: 'sumo_run_search', arguments: { query: 'x', last: '15m' } }),
    );
    expect(out).not.toContain('[RESPONSE TRUNCATED');
  });
});

describe('sumo_export_results ordering + batching', () => {
  it('appends "| sort by _messagetime asc" (after extract clauses) for non-aggregate queries', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(2, 0)),
      messages: vi.fn(async () => ({ fields: [], messages: [] })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_export_results',
      arguments: { query: 'scope', last: '1h', extract: { status: 'log.status' } },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const req = (api.create.mock.calls[0] as [{ query: string }])[0];
    expect(req.query).toBe(
      'scope | json field=_raw "log.status" as status nodrop | sort by _messagetime asc',
    );
    expect(text(res)).toContain('order: chronological');
  });

  it('does NOT append sort (or allow extract) for aggregate queries', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(10, 2)),
      records: vi.fn(async () => ({ fields: [], records: [] })),
    });
    const { client } = await setup(api);
    await client.callTool({
      name: 'sumo_export_results',
      arguments: { query: 'scope | count by levelname', last: '1h' },
    });
    const req = (api.create.mock.calls[0] as [{ query: string }])[0];
    expect(req.query).toBe('scope | count by levelname');

    const res2 = (await client.callTool({
      name: 'sumo_export_results',
      arguments: { query: 'scope | count', last: '1h', extract: { a: 'log.a' } },
    })) as ToolResult;
    expect(res2.isError).toBe(true);
    expect(text(res2)).toContain('NON-aggregate');
  });

  it('writes one batch per page (not per line) and keeps every line', async () => {
    let call = 0;
    const api = mockApi({
      status: vi.fn(async () => doneStatus(5, 0)),
      messages: vi.fn(async () => {
        call += 1;
        if (call === 1) return { fields: [], messages: [msgRow('a'), msgRow('b'), msgRow('c')] };
        if (call === 2) return { fields: [], messages: [msgRow('d'), msgRow('e')] };
        return { fields: [], messages: [] };
      }),
    });
    const { client, exportDir } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_export_results',
      arguments: { query: 'x', last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    const file = out.split('\n').find((l) => l.startsWith('file: '))!.slice('file: '.length);
    expect(file.startsWith(exportDir)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { message: string }).message)).toEqual([
      'a', 'b', 'c', 'd', 'e',
    ]);
  });
});

describe('sumo_trend', () => {
  const trendRecords = [
    { map: { _timeslice: '1783017300000', levelname: 'INFO', _count: '40' } },
    { map: { _timeslice: '1783017000000', levelname: 'INFO', _count: '10' } }, // unsorted on purpose
    { map: { _timeslice: '1783017300000', levelname: 'ERROR', _count: '3' } },
    // gap at 1783017600000 for INFO; ERROR only in one bucket
    { map: { _timeslice: '1783017600000', levelname: 'WARN', _count: '2' } }, // alias → WARNING
  ];

  it('builds the timeslice query, sorts + gap-fills buckets, and renders per-series sparklines', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(55, 4)),
      records: vi.fn(async (_id: string, offset: number) => ({
        fields: [],
        records: offset === 0 ? trendRecords : [],
      })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_trend',
      arguments: { query: 'scope', from: '1783017000000', to: '1783017900000', interval: '5m' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const req = (api.create.mock.calls[0] as [{ query: string }])[0];
    expect(req.query).toBe(
      'scope | json field=_raw "log.levelname" as levelname nodrop | timeslice 5m | count by _timeslice, levelname',
    );
    const out = text(res);
    expect(out).toContain('trend by levelname');
    expect(out).toContain('buckets=3');
    expect(out).toContain('[10 40 0]'); // INFO: sorted by slice, gap-filled trailing 0
    expect(out).toContain('[0 3 0]'); // ERROR
    expect(out).toContain('WARNING'); // WARN normalized
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
  });

  it('auto-picks an interval from the window and honors by=_native / by=none', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(10, 1)),
      records: vi.fn(async () => ({ fields: [], records: [] })),
    });
    const { client } = await setup(api);
    await client.callTool({
      name: 'sumo_trend',
      arguments: { query: 'scope', last: '30m', by: '_sourcecategory' },
    });
    // 30m window → smallest nice step with ≤40 buckets = 1m.
    expect((api.create.mock.calls[0] as [{ query: string }])[0].query).toBe(
      'scope | timeslice 1m | count by _timeslice, _sourcecategory',
    );
    await client.callTool({
      name: 'sumo_trend',
      arguments: { query: 'scope', last: '30m', by: 'none' },
    });
    expect((api.create.mock.calls[1] as [{ query: string }])[0].query).toBe(
      'scope | timeslice 1m | count by _timeslice',
    );
  });

  it('rejects aggregate queries and bad dimensions without creating a job', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const res1 = (await client.callTool({
      name: 'sumo_trend',
      arguments: { query: 'x | count by levelname', last: '15m' },
    })) as ToolResult;
    expect(res1.isError).toBe(true);
    expect(text(res1)).toContain('sumo_run_search');
    const res2 = (await client.callTool({
      name: 'sumo_trend',
      arguments: { query: 'x', last: '15m', by: 'bad dim' },
    })) as ToolResult;
    expect(res2.isError).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('deletes the job even when the wait fails', async () => {
    const api = mockApi({
      status: vi.fn(async () => ({ ...doneStatus(0, 0), state: 'CANCELLED' })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_trend',
      arguments: { query: 'x', last: '15m' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
  });
});

describe('sumo_list_monitors', () => {
  const hit = (over: Record<string, unknown> = {}): MonitorSearchHit => ({
    path: '/Monitors/Prod',
    item: {
      id: 'M1',
      name: 'Backend error rate',
      monitorType: 'Logs',
      isDisabled: false,
      status: ['Normal'],
      notifications: [
        { notification: { connectionType: 'Email' }, runForTriggerTypes: ['Critical'] },
        { notification: { connectionType: 'PagerDuty' }, runForTriggerTypes: ['Critical'] },
      ],
      triggers: [{ triggerType: 'Critical' }, { triggerType: 'ResolvedCritical' }],
      ...over,
    },
  });

  it('renders monitors compactly with status, triggers, and notification destinations', async () => {
    const monitors = mockMonitors([hit(), hit({ id: 'M2', name: 'Latency', isDisabled: true })]);
    const { client } = await setup(mockApi(), {}, undefined, monitors);
    const res = (await client.callTool({
      name: 'sumo_list_monitors',
      arguments: {},
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('monitors: 2');
    expect(out).toContain('[Normal] Backend error rate (/Monitors/Prod) type=Logs');
    expect(out).toContain('triggers=Critical,ResolvedCritical');
    expect(out).toContain('notify=Email,PagerDuty');
    expect(out).toContain('[DISABLED] Latency');
    expect(monitors.search).toHaveBeenCalledWith('type:monitor', 100, expect.anything());
  });

  it('prepends type:monitor to a user filter query', async () => {
    const monitors = mockMonitors([]);
    const { client } = await setup(mockApi(), {}, undefined, monitors);
    const res = (await client.callTool({
      name: 'sumo_list_monitors',
      arguments: { query: 'error', limit: 5 },
    })) as ToolResult;
    expect(text(res)).toContain('No monitors matched');
    expect(monitors.search).toHaveBeenCalledWith('type:monitor error', 5, expect.anything());
  });

  it('maps HTTP 403 to a "View Monitors capability" message', async () => {
    const monitors: MockMonitors = {
      search: vi.fn(async () => {
        throw new SumoApiError(403, { code: 'forbidden', message: 'nope' }, 'x');
      }),
    };
    const { client } = await setup(mockApi(), {}, undefined, monitors);
    const res = (await client.callTool({
      name: 'sumo_list_monitors',
      arguments: {},
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('View Monitors');
  });
});
