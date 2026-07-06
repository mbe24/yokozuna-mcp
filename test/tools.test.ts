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

// -------------------------------------------------------- detection-aware mock plumbing
// Detection Job 1 groups per-category fill counters; these rows emulate the three live
// schema families with NEUTRAL category names.

type DetRecord = { map: Record<string, string> };

/** Family A (word-level JSON): high levelname fill. */
const detRowWord = (cat = 'cat/word', total = 100): DetRecord => ({
  map: {
    _sourcecategory: cat, total: String(total), json_n: String(total),
    levelname_n: String(total), level_n: '0', severity_n: '0', loglevel_n: '0',
    type_n: '0', stream_n: String(total),
  },
});

/** Family B (numeric/typed JSON): severity on a subset, type on all. */
const detRowNumeric = (cat = 'cat/numeric', total = 100): DetRecord => ({
  map: {
    _sourcecategory: cat, total: String(total), json_n: String(total),
    levelname_n: '0', level_n: '0', severity_n: String(Math.ceil(total * 0.3)),
    loglevel_n: '0', type_n: String(total), stream_n: String(total),
  },
});

/** Family C (string payload): near-zero JSON fraction. */
const detRowString = (cat = 'cat/string', total = 100): DetRecord => ({
  map: {
    _sourcecategory: cat, total: String(total), json_n: '0',
    levelname_n: '0', level_n: '0', severity_n: '0', loglevel_n: '0',
    type_n: '0', stream_n: '0',
  },
});

/** No-signal (JSON but nothing from the candidate vocabulary). */
const detRowNoSignal = (cat = 'cat/opaque', total = 100): DetRecord => ({
  map: {
    _sourcecategory: cat, total: String(total), json_n: String(total),
    levelname_n: '0', level_n: '0', severity_n: '0', loglevel_n: '0',
    type_n: '0', stream_n: '0',
  },
});

const tokRow = (cat = 'cat/string', over: Record<string, string> = {}): DetRecord => ({
  map: {
    _sourcecategory: cat, total: '100', error_n: '5', warn_n: '2', crit_n: '0',
    exc_n: '0', tb_n: '0', stderr_n: '1', ...over,
  },
});

/**
 * An api mock whose create() dispatches on the QUERY SHAPE: detection Job 1 / token Job 2
 * / summary side-aggregates get their own ids, so records() can answer per job.
 */
function detectAwareApi(opts: {
  detRows: DetRecord[];
  tokRows?: DetRecord[];
  status?: SearchJobStatus;
  mainMessages?: () => { fields: never[]; messages: { map: Record<string, string> }[] };
  aggRecords?: DetRecord[];
}) {
  const createdQueries: string[] = [];
  let mainPage = 0;
  const api = mockApi({
    create: vi.fn(async (req: { query: string }) => {
      createdQueries.push(req.query);
      if (req.query.includes('sum(is_json)')) return { id: 'DET1' };
      if (req.query.includes('sum(t_error)')) return { id: 'DET2' };
      if (/count by yz_/.test(req.query)) return { id: 'AGG' };
      return { id: 'MAIN' };
    }),
    status: vi.fn(async () => opts.status ?? doneStatus(2, 0)),
    records: vi.fn(async (id: string) => {
      if (id === 'DET1') return { fields: [], records: opts.detRows };
      if (id === 'DET2') return { fields: [], records: opts.tokRows ?? [] };
      if (id === 'AGG') return { fields: [], records: opts.aggRecords ?? [] };
      return { fields: [], records: [] };
    }),
    messages: vi.fn(async () => {
      mainPage += 1;
      if (opts.mainMessages && mainPage === 1) return opts.mainMessages();
      return { fields: [], messages: [] };
    }),
  });
  return { api, createdQueries };
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
  it('exposes all fourteen tools with non-empty descriptions and schemas', async () => {
    const { client } = await setup(mockApi());
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'sumo_create_search_job',
      'sumo_delete_search_job',
      'sumo_describe_schema',
      'sumo_error_digest',
      'sumo_export_results',
      'sumo_facets',
      'sumo_get_messages',
      'sumo_get_records',
      'sumo_get_search_job_status',
      'sumo_list_alerts',
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

  it('no docstring universalizes one schema family (levelname/stderr claims are gone)', async () => {
    const { client } = await setup(mockApi());
    const res = await client.listTools();
    for (const t of res.tools) {
      const d = t.description ?? '';
      expect(d, t.name).not.toMatch(/log\.levelname" as levelname/);
      expect(d, t.name).not.toMatch(/never _loglevel/);
      expect(d, t.name).not.toMatch(/stream:"stderr" is NOT/i);
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

  it('detail:summary: detection picks the field, one count aggregate yields exact whole-job counts with provenance', async () => {
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowWord('cat/word', 500)],
      status: doneStatus(500, 0),
      mainMessages: () => ({ fields: [], messages: [msgRow('hello'), msgRow('world')] }),
      aggRecords: [
        { map: { yz_lvl: 'INFO', _count: '480' } },
        { map: { yz_lvl: 'WARN', _count: '2' } }, // alias → merges into WARNING
        { map: { yz_lvl: 'WARNING', _count: '14' } },
        { map: { yz_lvl: '', _count: '4' } }, // nodrop empty → UNKNOWN
      ],
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_run_search',
      arguments: { query: 'x', last: '15m', detail: 'summary' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('by log.levelname (auto-detected; exact, whole job):');
    expect(out).toContain('INFO: 480');
    expect(out).toContain('WARNING: 16'); // WARN(2) + WARNING(14) merged
    expect(out).toContain('UNKNOWN: 4');
    // main job + detection Job 1 + count aggregate = 3 creates
    expect(createdQueries.length).toBe(3);
    expect(createdQueries.some((q) => q.includes('sum(is_json)'))).toBe(true);
    expect(
      createdQueries.some((q) =>
        q.includes('| json field=_raw "log.levelname" as yz_lvl nodrop | count by yz_lvl'),
      ),
    ).toBe(true);
    expect(api.delete).toHaveBeenCalledWith('AGG', { tolerateMissing: true });
    expect(api.delete).toHaveBeenCalledWith('DET1', { tolerateMissing: true });
    expect(api.delete).toHaveBeenCalledWith('MAIN', { tolerateMissing: true });
  });

  it('detail:summary on a numeric-family scope counts by log.severity with provenance', async () => {
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowNumeric('cat/numeric', 500)],
      status: doneStatus(500, 0),
      mainMessages: () => ({ fields: [], messages: [msgRow('hello')] }),
      aggRecords: [
        { map: { yz_sev: '2.0', _count: '400' } }, // float-string → displayed "2"
        { map: { yz_sev: '', _count: '100' } }, // NULL severity rows → (none)
      ],
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_run_search',
        arguments: { query: 'x', last: '15m', detail: 'summary' },
      }),
    );
    expect(out).toContain('by log.severity (auto-detected; exact, whole job):');
    expect(out).toContain('2: 400'); // "2.0" coerced for display
    expect(out).toContain('(none): 100');
    expect(
      createdQueries.some((q) =>
        q.includes('| json field=_raw "log.severity" as yz_sev nodrop | count by yz_sev'),
      ),
    ).toBe(true);
  });

  it('detail:summary falls back to a LOUD SAMPLE label when detection/aggregate fails', async () => {
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
    expect(out).toContain('by level (SAMPLE — first 2 of 500 only; not whole-job):');
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
    expect(out).toContain('SAMPLE');
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
      create: vi.fn(async (req: { query: string }) => {
        if (req.query.includes('sum(is_json)')) return { id: 'DET1' };
        return { id: 'MAIN' };
      }),
      status: vi.fn(async () => doneStatus(3, 0)),
      records: vi.fn(async (id: string) =>
        id === 'DET1' ? { fields: [], records: [detRowWord('cat/x', 3)] } : { fields: [], records: [] },
      ),
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
    expect(notes.length).toBeGreaterThanOrEqual(3); // detection + status poll + message pages
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
  it('runs one aggregate per dimension: native for _fields, ABSOLUTE JSON path otherwise', async () => {
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
        if (id === 'F2') {
          // top-level `stream` — reachable now that the log. prefix is not forced
          return {
            fields: [],
            records: [
              { map: { stream: 'stdout', _count: '11305' } },
              { map: { stream: 'stderr', _count: '1' } },
            ],
          };
        }
        return { fields: [], records: [{ map: { log_levelname: 'ERROR', _count: '5' } }] };
      }),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_facets',
      arguments: { query: 'scope', last: '30m', dimensions: ['_sourcecategory', 'stream', 'log.levelname'] },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(createdQueries).toEqual([
      'scope | count by _sourcecategory | sort by _count | limit 15',
      'scope | json field=_raw "stream" as stream nodrop | count by stream | sort by _count | limit 15',
      'scope | json field=_raw "log.levelname" as log_levelname nodrop | count by log_levelname | sort by _count | limit 15',
    ]);
    const out = text(res);
    expect(out).toContain('42  kubernetes/a/backend'); // _count parsed to int, aligned
    expect(out).toContain('(none)'); // empty-string key
    expect(out).toContain('11305  stdout');
    expect(out).toContain('1  stderr');
    expect(out).toContain('5  ERROR'); // dotted path works, alias sanitized
    expect(api.delete).toHaveBeenCalledWith('F1', { tolerateMissing: true });
    expect(api.delete).toHaveBeenCalledWith('F2', { tolerateMissing: true });
    expect(api.delete).toHaveBeenCalledWith('F3', { tolerateMissing: true });
  });

  it('annotates a dimension that is entirely (none) with a describe_schema hint', async () => {
    const api = mockApi({
      records: vi.fn(async () => ({
        fields: [],
        records: [{ map: { levelname: '', _count: '48112' } }],
      })),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_facets',
        arguments: { query: 'scope', last: '30m', dimensions: ['levelname'] },
      }),
    );
    expect(out).toContain('(none)');
    expect(out).toContain('may not exist at this path');
    expect(out).toContain('sumo_describe_schema');
  });

  it('one failing dimension yields an error line, not a total failure', async () => {
    const api = mockApi({
      create: vi.fn(async (req: { query: string }) => {
        if (req.query.includes('"baddim"')) {
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

  it('rejects an invalid dimension with an error line and creates no job for it', async () => {
    const api = mockApi({
      records: vi.fn(async () => ({ fields: [], records: [] })),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_facets',
        arguments: { query: 'scope', last: '30m', dimensions: ['bad"dim'] },
      }),
    );
    expect(out).toContain('invalid dimension');
    expect(api.create).not.toHaveBeenCalled();
  });

  it('defaults to NATIVE-ONLY dimensions (no payload-schema assumptions)', async () => {
    const createdQueries: string[] = [];
    const api = mockApi({
      create: vi.fn(async (req: { query: string }) => {
        createdQueries.push(req.query);
        return { id: `F${createdQueries.length}` };
      }),
      records: vi.fn(async () => ({ fields: [], records: [] })),
    });
    const { client } = await setup(api);
    await client.callTool({ name: 'sumo_facets', arguments: { query: 'scope', last: '30m' } });
    expect(createdQueries).toEqual([
      'scope | count by _sourcecategory | sort by _count | limit 15',
      'scope | count by _sourcehost | sort by _count | limit 15',
    ]);
  });

  it('uses the configured default dimensions (YOKOZUNA_FACET_DIMENSIONS) as absolute paths', async () => {
    const createdQueries: string[] = [];
    const api = mockApi({
      create: vi.fn(async (req: { query: string }) => {
        createdQueries.push(req.query);
        return { id: `F${createdQueries.length}` };
      }),
      records: vi.fn(async () => ({ fields: [], records: [] })),
    });
    const { client } = await setup(api, { YOKOZUNA_FACET_DIMENSIONS: '_collector,log.logger' });
    await client.callTool({ name: 'sumo_facets', arguments: { query: 'scope', last: '30m' } });
    expect(createdQueries).toHaveLength(2);
    expect(createdQueries[0]).toContain('count by _collector');
    expect(createdQueries[1]).toContain('"log.logger" as log_logger');
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

  const wordDigestApi = (opts: { detTotal?: number; status?: SearchJobStatus } = {}) =>
    detectAwareApi({
      detRows: [detRowWord('cat/be', opts.detTotal ?? 100)],
      status: opts.status ?? doneStatus(3, 0),
      mainMessages: () => ({
        fields: [],
        messages: [
          digestRow(T1, 'ERROR', 'boom id=111'),
          digestRow(T3, 'ERROR', 'boom id=222', 'req-9'),
          digestRow(T2, 'WARNING', 'slow query took 1.2s'),
        ],
      }),
    });

  it('word-level scope: detects, applies the enumerated-case predicate, and discloses matched-N-of-M', async () => {
    const { api, createdQueries } = wordDigestApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_error_digest',
      arguments: { query: '_sourcecategory=cat/be', last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    // Disclosure block (§4.3): predicate, provenance, matched-N-of-M, caveat.
    expect(out).toContain('severity filter (auto-detected):');
    expect(out).toContain('detected from: 1 category in scope — cat/be→word-level(log.levelname)');
    expect(out).toContain('matched: 3 of 100 in-scope messages (3.0%)');
    expect(out).toContain('detection is SYNTACTIC');
    expect(out).toContain('sumo_describe_schema');
    // Digest body still groups by (level, signature).
    expect(out).toContain('scanned 3 messages, 2 distinct signatures');
    const errLine = out.split('\n').find((l) => l.startsWith('×2 ERROR'))!;
    expect(errLine).toContain(`${new Date(T1).toISOString()}..${new Date(T3).toISOString()}`);
    expect(errLine).toContain('req=req-9'); // first NON-EMPTY request_id
    expect(errLine).toContain('[cat/be]');
    expect(errLine).toContain('boom id=111'); // representative = first occurrence
    expect(out).toContain('×1 WARNING');
    // 2 jobs: detection Job 1 + the filtered digest job (no token job — no string family).
    expect(createdQueries).toHaveLength(2);
    expect(createdQueries[0]).toContain('sum(is_json)');
    expect(createdQueries[1]).toBe(
      '_sourcecategory=cat/be | json field=_raw "log.levelname" as yz_log_levelname nodrop' +
        ' | where yz_log_levelname in ("ERROR","Error","error","ERR","WARNING","Warning","warning","WARN","Warn","warn","CRITICAL","Critical","critical","CRIT","FATAL","Fatal","fatal","SEVERE","Severe","severe")',
    );
    expect(api.delete).toHaveBeenCalledWith('DET1', { tolerateMissing: true });
    expect(api.delete).toHaveBeenCalledWith('MAIN', { tolerateMissing: true });
  });

  it('numeric/typed scope (the v2 false-clean repro): applies the §3.4-B predicate verbatim', async () => {
    const exceptionRow = {
      map: {
        _messagetime: String(T1),
        _sourcecategory: 'cat/numeric',
        _raw: JSON.stringify({ log: { type: 'exception', message: 'NullPointerException in worker' } }),
      },
    };
    const fatalRow = {
      map: {
        _messagetime: String(T2),
        _sourcecategory: 'cat/numeric',
        _raw: JSON.stringify({ log: { severity: 'Fatal', type: 'system', message: 'disk full' } }),
      },
    };
    const floatSevRow = {
      map: {
        _messagetime: String(T3),
        _sourcecategory: 'cat/numeric',
        _raw: JSON.stringify({ log: { severity: '3.0', type: 'service', message: 'upstream timeout' } }),
      },
    };
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowNumeric('cat/numeric', 2045)],
      status: doneStatus(1470, 0),
      mainMessages: () => ({ fields: [], messages: [exceptionRow, fatalRow, floatSevRow] }),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_error_digest',
        arguments: { query: '_sourcecategory=cat/numeric', last: '4h' },
      }),
    );
    // The exact validated fragment from §3.4 — num() coercion + string enums (Fatal plus
    // the live-observed Error/Warning case variants) + NULL-severity exceptions.
    expect(createdQueries[1]).toBe(
      '_sourcecategory=cat/numeric | json field=_raw "log.severity" as yz_sev nodrop' +
        ' | json field=_raw "log.type" as yz_type nodrop' +
        ' | where num(yz_sev) >= 3 or yz_sev in ("Fatal","Error","ERROR","error","Warning","WARNING","warning") or yz_type = "exception"',
    );
    expect(out).toContain('detected from: 1 category in scope — cat/numeric→numeric+type(log.severity/log.type)');
    expect(out).toContain('matched: 1,470 of 2,045 in-scope messages');
    // §4.6 level display fallback: sev=/Fatal/type= instead of a wall of UNKNOWN.
    expect(out).toContain('type=exception');
    expect(out).toContain('Fatal');
    expect(out).toContain('sev=3'); // "3.0" float-string coerced for display
    expect(out).not.toContain('UNKNOWN');
  });

  it('string-payload scope: token job runs, keyword predicate applied, scanner-noise caveat present', async () => {
    const nginxRow = {
      map: {
        _messagetime: String(T1),
        _sourcecategory: 'cat/string',
        _raw: '2026/07/04 10:00:00 [error] 31#31: *1 open() "/usr/share/nginx/html/wp-login.php" failed',
      },
    };
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowString('cat/string', 11306)],
      tokRows: [tokRow('cat/string', { error_n: '1', stderr_n: '1' })],
      status: doneStatus(1, 0),
      mainMessages: () => ({ fields: [], messages: [nginxRow] }),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_error_digest',
        arguments: { query: '_sourcecategory=cat/string', last: '1h' },
      }),
    );
    // 3 jobs: classification + token + digest; keyword clause (never a post-pipe where).
    expect(createdQueries).toHaveLength(3);
    expect(createdQueries[1]).toContain('sum(t_error)');
    expect(createdQueries[2]).toBe('_sourcecategory=cat/string ("[error]" OR "[crit]")');
    expect(out).toContain('cat/string→string-tokens');
    expect(out).toContain('matched: 1 of 11,306 in-scope messages');
    expect(out).toContain('benign scanner noise'); // the mandatory family-C caveat
    expect(out).toContain('[error]'); // token as the displayed level (§4.6)
  });

  it('zero matches under a LOW-confidence detection (sparse field fill) renders the loud §4.4 guardrail', async () => {
    // levelname fills only 5.2% of the scope — above the 5% word floor (family A detects)
    // but far below the 50% confidence bar, so a zero could be a schema mismatch: stay loud.
    const sparseRow = {
      map: {
        _sourcecategory: 'cat/be', total: '48112', json_n: '48112',
        levelname_n: '2500', level_n: '0', severity_n: '0', loglevel_n: '0',
        type_n: '0', stream_n: '48112',
      },
    };
    const { api } = detectAwareApi({
      detRows: [sparseRow],
      status: doneStatus(0, 0),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_error_digest',
        arguments: { query: '_sourcecategory=cat/be', last: '1h' },
      }),
    );
    expect(out).toContain('!! ZERO MATCHES from the severity filter, but the scope is NOT empty (48,112 messages in range)');
    expect(out).toContain('Do NOT read this result as "no errors"');
    expect(out).toContain('matched: 0 of 48,112 in-scope messages (0.0%)');
    expect(out).not.toContain('(no matching messages)');
    expect(out).not.toContain('genuinely clean');
  });

  it('zero matches under a CONFIDENT detection (high field fill) renders the CALM clean message', async () => {
    // detRowWord fills log.levelname on 100% of messages — a zero here means the window is
    // genuinely clean, not a schema mismatch. Still honest: matched 0 of M stays disclosed.
    const { api } = detectAwareApi({
      detRows: [detRowWord('cat/be', 48_112)],
      status: doneStatus(0, 0),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_error_digest',
        arguments: { query: '_sourcecategory=cat/be', last: '1h' },
      }),
    );
    expect(out).toContain(
      'no ERROR/WARNING in this window — the detected level field (log.levelname) is present on ' +
        '100.0% of 48,112 messages, so this looks genuinely clean (not a schema mismatch).',
    );
    expect(out).toContain('matched: 0 of 48,112 in-scope messages (0.0%)');
    expect(out).not.toContain('!! ZERO MATCHES');
    expect(out).not.toContain('(no matching messages)');
  });

  it('no-signal scope: digests UNFILTERED with the §4.5 disclosure — never an error, never silence', async () => {
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowNoSignal('cat/opaque', 42)],
      tokRows: [], // token probe runs for JSON-no-vocab categories too — zero hits here
      status: doneStatus(42, 0),
      mainMessages: () => ({ fields: [], messages: [digestRow(T1, 'ERROR', 'strange payload')] }),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_error_digest',
      arguments: { query: '_sourcecategory=cat/opaque', last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('severity filter: NONE APPLIED — no severity signal detected');
    expect(out).toContain('Digesting ALL 42 messages by signature instead');
    expect(out).toContain('sumo_describe_schema');
    // Jobs: classification + token probe (JSON-no-vocab) + the UNFILTERED digest.
    expect(createdQueries).toHaveLength(3);
    expect(createdQueries[1]).toContain('sum(t_error)');
    expect(createdQueries[2]).toBe('_sourcecategory=cat/opaque');
  });

  it('JSON envelope with a string log payload: token probe rescues it into family C (live-found shape)', async () => {
    // json_n ≈ 100% but no vocabulary field fills — the only signal is an [error] token
    // INSIDE the string payload of {"stream","timestamp","log"}.
    const envelopeRow = {
      map: {
        _messagetime: String(T1),
        _sourcecategory: 'cat/envfront',
        _raw: JSON.stringify({
          stream: 'stderr',
          timestamp: T1,
          log: '2026/07/06 10:00:00 [error] 31#31: open() "/usr/share/nginx/html/x.php" failed',
        }),
      },
    };
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowNoSignal('cat/envfront', 22_991)],
      tokRows: [tokRow('cat/envfront', { error_n: '2', warn_n: '0', crit_n: '0', exc_n: '0', tb_n: '0' })],
      status: doneStatus(2, 0),
      mainMessages: () => ({ fields: [], messages: [envelopeRow] }),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_error_digest',
        arguments: { query: '_sourcecategory=cat/envfront', last: '4h' },
      }),
    );
    expect(createdQueries[2]).toBe('_sourcecategory=cat/envfront ("[error]" OR "[crit]")');
    expect(out).toContain('cat/envfront→string-tokens');
    expect(out).toContain('matched: 2 of 22,991 in-scope messages');
    expect(out).toContain('[error]'); // token as the display level
    // The string `log` payload is the MESSAGE, not the whole envelope JSON.
    expect(out).toContain('open() "/usr/share/nginx/html/x.php" failed');
    expect(out).not.toContain('"stream":"stderr"');
  });

  it('empty scope says EMPTY (a scope/range result), not "no errors"', async () => {
    const { api, createdQueries } = detectAwareApi({ detRows: [], status: doneStatus(0, 0) });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_error_digest',
        arguments: { query: '_sourcecategory=cat/gone', last: '1h' },
      }),
    );
    expect(out).toContain('scope is EMPTY in this range');
    expect(out).toContain('NOT "no errors"');
    expect(createdQueries).toHaveLength(1); // detection only — no pointless digest job
  });

  it('filter= skips detection (exactly 1 job), applies verbatim, and discloses agent provenance', async () => {
    const { api, createdQueries } = wordDigestApi();
    const { client } = await setup(api);
    const fragment = '| json field=_raw "log.severity" as s nodrop | where num(s)>=3 or s="Fatal"';
    const out = text(
      await client.callTool({
        name: 'sumo_error_digest',
        arguments: { query: '_sourcecategory=cat/be', last: '1h', filter: fragment },
      }),
    );
    expect(createdQueries).toHaveLength(1); // no detection job
    expect(createdQueries[0]).toBe(`_sourcecategory=cat/be ${fragment}`);
    expect(out).toContain(`severity filter (agent-supplied): ${fragment}`);
    expect(out).toContain('matched: 3 messages (scope total not measured in filter= mode)');
  });

  it('filter= with zero matches renders the softened guardrail (M unknown)', async () => {
    const { api } = detectAwareApi({ detRows: [], status: doneStatus(0, 0) });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_error_digest',
        arguments: { query: 'scope', last: '1h', filter: '("[error]")' },
      }),
    );
    expect(out).toContain('!! ZERO MATCHES from the severity filter (scope total not measured in filter= mode)');
    expect(out).toContain('Do NOT read this result as "no errors"');
  });

  it('memoizes POSITIVE detections: a second call re-uses the detection and discloses the cache age', async () => {
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowWord('cat/be', 100)],
      status: doneStatus(3, 0),
      mainMessages: () => ({ fields: [], messages: [digestRow(T1, 'ERROR', 'boom')] }),
    });
    const { client } = await setup(api);
    const args = { query: '_sourcecategory=cat/be', last: '1h' };
    await client.callTool({ name: 'sumo_error_digest', arguments: args });
    const out2 = text(await client.callTool({ name: 'sumo_error_digest', arguments: args }));
    expect(createdQueries.filter((q) => q.includes('sum(is_json)'))).toHaveLength(1); // one detection total
    expect(out2).toContain('(detection cached, ');
  });

  it('NEVER caches a no-signal result: every call re-detects', async () => {
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowNoSignal('cat/opaque', 42)],
      status: doneStatus(42, 0),
    });
    const { client } = await setup(api);
    const args = { query: '_sourcecategory=cat/opaque', last: '1h' };
    await client.callTool({ name: 'sumo_error_digest', arguments: args });
    await client.callTool({ name: 'sumo_error_digest', arguments: args });
    expect(createdQueries.filter((q) => q.includes('sum(is_json)'))).toHaveLength(2);
  });

  it('the levels param is GONE from the schema (never reaches the query)', async () => {
    const { api, createdQueries } = wordDigestApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_error_digest',
      arguments: { query: 'scope', last: '1h', levels: ['CRITICAL'] },
    })) as ToolResult;
    // Whether the SDK rejects the unknown param or strips it, the value-list model must
    // never influence the query.
    if (!res.isError) {
      expect(createdQueries.every((q) => !q.includes('CRITICAL,'))).toBe(true);
      expect(createdQueries.every((q) => !q.includes('in ("CRITICAL")'))).toBe(true);
    }
    const tools = await client.listTools();
    const digest = tools.tools.find((t) => t.name === 'sumo_error_digest')!;
    expect(JSON.stringify(digest.inputSchema)).not.toContain('"levels"');
  });

  it('applies top-N (limit) while still reporting the full distinct count', async () => {
    const { api } = wordDigestApi();
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
    const { api } = detectAwareApi({
      detRows: [detRowWord('cat/be', 100)],
      status: doneStatus(100, 0),
      mainMessages: () => ({
        fields: [],
        messages: [digestRow(T1, 'ERROR', 'boom 1'), digestRow(T2, 'ERROR', 'boom 2')],
      }),
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
    const { api, createdQueries } = wordDigestApi();
    const { client } = await setup(api, { SUMO_DEFAULT_SOURCE_CATEGORY: 'kubernetes/x/backend' });
    const res = (await client.callTool({
      name: 'sumo_error_digest',
      arguments: { last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(createdQueries[0]!.startsWith('_sourcecategory=kubernetes/x/backend | json')).toBe(true);
  });

  it('errors clearly when there is no query and no default source category', async () => {
    const { api } = wordDigestApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_error_digest',
      arguments: { last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No scope');
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
  const trendRecords = (key: string) => [
    { map: { _timeslice: '1783017300000', [key]: 'INFO', _count: '40' } },
    { map: { _timeslice: '1783017000000', [key]: 'INFO', _count: '10' } }, // unsorted on purpose
    { map: { _timeslice: '1783017300000', [key]: 'ERROR', _count: '3' } },
    // gap at 1783017600000 for INFO; ERROR only in one bucket
    { map: { _timeslice: '1783017600000', [key]: 'WARN', _count: '2' } }, // alias → WARNING
  ];

  it('by omitted: detection picks the series (word family), discloses it, sorts + gap-fills', async () => {
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowWord('cat/be', 55)],
      status: doneStatus(55, 4),
    });
    api.records = vi.fn(async (id: string, offset: number) => {
      if (id === 'DET1') return { fields: [], records: [detRowWord('cat/be', 55)] };
      return { fields: [], records: offset === 0 ? trendRecords('yz_lvl') : [] };
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_trend',
      arguments: { query: 'scope', from: '1783017000000', to: '1783017900000', interval: '5m' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(createdQueries[1]).toBe(
      'scope | json field=_raw "log.levelname" as yz_lvl nodrop | timeslice 5m | count by _timeslice, yz_lvl',
    );
    const out = text(res);
    expect(out).toContain('series (auto-detected): log.levelname — word-level family');
    expect(out).toContain('semantics unverified');
    expect(out).toContain('trend by log.levelname');
    expect(out).toContain('buckets=3');
    expect(out).toContain('[10 40 0]'); // INFO: sorted by slice, gap-filled trailing 0
    expect(out).toContain('[0 3 0]'); // ERROR
    expect(out).toContain('WARNING'); // WARN normalized on the word family
    expect(api.delete).toHaveBeenCalledWith('MAIN', { tolerateMissing: true });
  });

  it('by omitted on a numeric-family scope trends by log.severity with the disclosure line', async () => {
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowNumeric('cat/numeric', 100)],
      status: doneStatus(100, 2),
    });
    api.records = vi.fn(async (id: string) => {
      if (id === 'DET1') return { fields: [], records: [detRowNumeric('cat/numeric', 100)] };
      return { fields: [], records: [{ map: { _timeslice: '1783017000000', yz_sev: '2.0', _count: '9' } }] };
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({ name: 'sumo_trend', arguments: { query: 'scope', last: '30m' } }),
    );
    expect(createdQueries[1]).toBe(
      'scope | json field=_raw "log.severity" as yz_sev nodrop | timeslice 1m | count by _timeslice, yz_sev',
    );
    expect(out).toContain('series (auto-detected): log.severity — numeric family');
    expect(out).toContain('log.type is a second-choice series');
    expect(out).toMatch(/^2 /m); // "2.0" float-string coerced in the series key
  });

  it('by omitted on a string-family scope trends by token class', async () => {
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowString('cat/string', 100)],
      tokRows: [tokRow('cat/string', { error_n: '3' })],
      status: doneStatus(100, 2),
    });
    api.records = vi.fn(async (id: string) => {
      if (id === 'DET1') return { fields: [], records: [detRowString('cat/string', 100)] };
      if (id === 'DET2') return { fields: [], records: [tokRow('cat/string', { error_n: '3' })] };
      return {
        fields: [],
        records: [
          { map: { _timeslice: '1783017000000', yz_tok: '[error]', _count: '3' } },
          { map: { _timeslice: '1783017000000', yz_tok: 'other', _count: '97' } },
        ],
      };
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({ name: 'sumo_trend', arguments: { query: 'scope', last: '30m' } }),
    );
    expect(createdQueries.at(-1)).toContain(
      '| if(_raw matches "*[error]*","[error]", if(_raw matches "*[crit]*","[crit]", if(_raw matches "*[warn*","[warn]", "other"))) as yz_tok | timeslice 1m | count by _timeslice, yz_tok',
    );
    expect(out).toContain('series (auto-detected): string-token class');
    expect(out).toContain('[error]');
  });

  it('by omitted on a no-signal scope trends the total with a disclosure note', async () => {
    const { api, createdQueries } = detectAwareApi({
      detRows: [detRowNoSignal('cat/opaque', 10)],
      tokRows: [],
      status: doneStatus(10, 1),
    });
    api.records = vi.fn(async (id: string) => {
      if (id === 'DET1') return { fields: [], records: [detRowNoSignal('cat/opaque', 10)] };
      if (id === 'DET2') return { fields: [], records: [] };
      return { fields: [], records: [{ map: { _timeslice: '1783017000000', _count: '10' } }] };
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({ name: 'sumo_trend', arguments: { query: 'scope', last: '30m' } }),
    );
    expect(createdQueries.at(-1)).toBe('scope | timeslice 1m | count by _timeslice');
    expect(out).toContain('series: none — no severity signal detected');
    expect(out).toContain('sumo_describe_schema');
  });

  it('by="stream" reaches the TOP-LEVEL key (stdout/stderr split)', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(11306, 2)),
      records: vi.fn(async (_id: string, offset: number) => ({
        fields: [],
        records:
          offset === 0
            ? [
                { map: { _timeslice: '1783017000000', stream: 'stdout', _count: '11305' } },
                { map: { _timeslice: '1783017000000', stream: 'stderr', _count: '1' } },
              ]
            : [],
      })),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_trend',
        arguments: { query: 'scope', last: '30m', by: 'stream' },
      }),
    );
    expect((api.create.mock.calls[0] as [{ query: string }])[0].query).toBe(
      'scope | json field=_raw "stream" as stream nodrop | timeslice 1m | count by _timeslice, stream',
    );
    expect(api.create).toHaveBeenCalledTimes(1); // explicit by → no detection
    expect(out).toContain('stdout');
    expect(out).toContain('stderr');
  });

  it('by="log.levelname" works as an absolute path (dots accepted, alias sanitized)', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(10, 1)),
      records: vi.fn(async () => ({ fields: [], records: [] })),
    });
    const { client } = await setup(api);
    await client.callTool({
      name: 'sumo_trend',
      arguments: { query: 'scope', last: '30m', by: 'log.levelname' },
    });
    expect((api.create.mock.calls[0] as [{ query: string }])[0].query).toBe(
      'scope | json field=_raw "log.levelname" as log_levelname nodrop | timeslice 1m | count by _timeslice, log_levelname',
    );
  });

  it('filter= + explicit by= runs exactly 1 job (no detection), filter applied before timeslice', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(10, 1)),
      records: vi.fn(async () => ({
        fields: [],
        records: [{ map: { _timeslice: '1783017000000', _count: '10' } }],
      })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_trend',
      arguments: { query: 'scope', last: '30m', by: 'none', filter: '("[error]" OR "[crit]")' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(api.create).toHaveBeenCalledTimes(1);
    expect((api.create.mock.calls[0] as [{ query: string }])[0].query).toBe(
      'scope ("[error]" OR "[crit]") | timeslice 1m | count by _timeslice',
    );
  });

  it('zero data points from a detected series on a non-empty scope triggers the guardrail', async () => {
    const { api } = detectAwareApi({
      detRows: [detRowWord('cat/be', 5000)],
      status: doneStatus(0, 0),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({ name: 'sumo_trend', arguments: { query: 'scope', last: '30m' } }),
    );
    expect(out).toContain('!! ZERO DATA POINTS');
    expect(out).toContain('5,000 messages in range');
    expect(out).not.toContain('no matching messages in this time range');
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
      arguments: { query: 'x', last: '15m', by: 'none' },
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

  it('renders a summary header plus compact monitor lines (status, triggers, destinations)', async () => {
    const monitors = mockMonitors([
      hit(),
      hit({ id: 'M2', name: 'Latency', isDisabled: true }),
      hit({ id: 'M3', name: 'Error rate prod', status: ['Critical'] }),
    ]);
    const { client } = await setup(mockApi(), {}, undefined, monitors);
    const res = (await client.callTool({
      name: 'sumo_list_monitors',
      arguments: {},
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('monitors: 3 — 1 Critical, 0 Warning, 1 disabled');
    expect(out).toContain('[Normal] Backend error rate (/Monitors/Prod) type=Logs');
    expect(out).toContain('triggers=Critical,ResolvedCritical');
    expect(out).toContain('notify=Email,PagerDuty');
    expect(out).toContain('[DISABLED] Latency');
    expect(monitors.search).toHaveBeenCalledTimes(1); // unfiltered → no extra total call
    expect(monitors.search).toHaveBeenCalledWith('type:monitor', 100, expect.anything());
  });

  it('zero-result filtered query names the unfiltered total and the name-only-substring caveat', async () => {
    const monitors: MockMonitors = {
      search: vi.fn(async (q: string) => (q === 'type:monitor' ? [hit(), hit({ id: 'M2' })] : [])),
    };
    const { client } = await setup(mockApi(), {}, undefined, monitors);
    const res = (await client.callTool({
      name: 'sumo_list_monitors',
      arguments: { query: 'Aurora', limit: 5 },
    })) as ToolResult;
    const out = text(res);
    expect(out).toContain('monitors: 0/2 matched');
    expect(out).toContain('2 exist unfiltered');
    expect(out).toContain('name-only, case-insensitive substring');
    expect(out).toContain('folder paths are NOT searched');
    expect(monitors.search).toHaveBeenCalledWith('type:monitor Aurora', 5, expect.anything());
    expect(monitors.search).toHaveBeenCalledWith('type:monitor', 1000, expect.anything());
  });

  it('status:["Critical","Warning"] runs one API call per status and unions by monitor id', async () => {
    const calls: string[] = [];
    const monitors: MockMonitors = {
      search: vi.fn(async (q: string) => {
        calls.push(q);
        if (q.includes('monitorStatus:Critical')) {
          return [hit({ id: 'M1', status: ['Critical'] }), hit({ id: 'M3', status: ['Critical'] })];
        }
        if (q.includes('monitorStatus:Warning')) {
          // M1 appears in BOTH result sets — the union must dedupe it.
          return [hit({ id: 'M1', status: ['Critical'] }), hit({ id: 'M2', name: 'Slow', status: ['Warning'] })];
        }
        return [hit(), hit({ id: 'M2' }), hit({ id: 'M3' }), hit({ id: 'M4' })];
      }),
    };
    const { client } = await setup(mockApi(), {}, undefined, monitors);
    const res = (await client.callTool({
      name: 'sumo_list_monitors',
      arguments: { status: ['Critical', 'Warning'] },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('monitors: 3/4 matched — 2 Critical, 1 Warning, 0 disabled');
    // NO OR support: one call per status, never "monitorStatus:X OR monitorStatus:Y".
    expect(calls.some((q) => q.includes(' OR '))).toBe(false);
    expect(calls).toContain('type:monitor monitorStatus:Critical');
    expect(calls).toContain('type:monitor monitorStatus:Warning');
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

describe('sumo_list_alerts', () => {
  const alertEvent = (over: {
    time: string;
    name: string;
    alertId?: string;
    monitorId?: string;
    monitorName?: string;
    creation?: string;
    resolution?: string;
    state?: string;
  }) => ({
    map: {
      _messagetime: String(Date.parse(over.time)),
      _raw: JSON.stringify({
        eventType: 'System',
        eventName: 'AlertSystemInfo',
        eventTime: over.time,
        subsystem: 'alerts',
        resourceIdentity: { id: over.alertId ?? 'A1', name: over.monitorName ?? 'CPU high', type: 'Alert' },
        details: {
          name: over.name,
          isMuted: false,
          alertCreationTime: over.creation,
          alertResolutionTime: over.resolution,
          monitorInfo: {
            monitorId: over.monitorId ?? '0000000000574434',
            monitorName: over.monitorName ?? 'CPU high',
            monitorPath: '/Monitor/CPU high',
          },
          alertingGroup: { previousState: 'Normal', currentState: over.state ?? 'Critical' },
        },
      }),
    },
  });

  it('queries the System Event Index with a LEADING _index term via the Search Job API', async () => {
    const api = mockApi({
      status: vi.fn(async () => doneStatus(0, 0)),
      messages: vi.fn(async () => ({ fields: [], messages: [] })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_list_alerts',
      arguments: { last: '7d', monitorQuery: 'CPU' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const req = (api.create.mock.calls[0] as [{ query: string }])[0];
    expect(req.query).toBe('_index=sumologic_system_events _sourceCategory=alerts "CPU"');
    expect(req.query.startsWith('_index=')).toBe(true); // leading top-level term — load-bearing
    expect(api.delete).toHaveBeenCalledWith('JOB1', { tolerateMissing: true });
  });

  it('correlates separate create/resolve events into one fired alert with monitorId+name join keys', async () => {
    let page = 0;
    const api = mockApi({
      status: vi.fn(async () => doneStatus(3, 0)),
      messages: vi.fn(async () => {
        page += 1;
        if (page > 1) return { fields: [], messages: [] };
        return {
          fields: [],
          messages: [
            alertEvent({ time: '2026-07-01T10:00:00Z', name: 'AlertCreated', creation: '2026-07-01T10:00:00Z', state: 'Critical' }),
            alertEvent({ time: '2026-07-01T10:20:00Z', name: 'AlertResolved', creation: '2026-07-01T10:00:00Z', resolution: '2026-07-01T10:20:00Z', state: 'Normal' }),
            alertEvent({ time: '2026-07-01T11:00:00Z', name: 'AlertCreated', alertId: 'A2', monitorId: 'M2', monitorName: 'Disk full', creation: '2026-07-01T11:00:00Z', state: 'Warning' }),
          ],
        };
      }),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({ name: 'sumo_list_alerts', arguments: { last: '7d' } }),
    );
    expect(out).toContain('fired alerts: 2');
    // A1: create + resolve correlated into one line, with duration.
    expect(out).toContain('fired=2026-07-01T10:00:00.000Z resolved=2026-07-01T10:20:00.000Z (20m)');
    expect(out).toContain('monitorId=0000000000574434');
    expect(out).toContain('CPU high');
    // A2: unresolved in range — explicit, never silent.
    expect(out).toContain('resolved=— (open, or resolved outside this range)');
    expect(out).toContain('monitorId=M2');
    expect(out).toContain('sumo_list_monitors'); // the join-key pointer
  });

  it('status filter matches any state seen across the correlated events', async () => {
    let page = 0;
    const api = mockApi({
      status: vi.fn(async () => doneStatus(2, 0)),
      messages: vi.fn(async () => {
        page += 1;
        if (page > 1) return { fields: [], messages: [] };
        return {
          fields: [],
          messages: [
            alertEvent({ time: '2026-07-01T10:00:00Z', name: 'AlertCreated', state: 'Critical' }),
            alertEvent({ time: '2026-07-01T11:00:00Z', name: 'AlertCreated', alertId: 'A2', monitorName: 'Slow', state: 'Warning' }),
          ],
        };
      }),
    });
    const { client } = await setup(api);
    const out = text(
      await client.callTool({
        name: 'sumo_list_alerts',
        arguments: { last: '7d', status: ['critical'] },
      }),
    );
    expect(out).toContain('fired alerts: 1');
    expect(out).toContain('CPU high');
    expect(out).not.toContain('Slow');
  });
});

describe('sumo_describe_schema (tool registration)', () => {
  it('runs detection + strata discovery + sampling and returns a propose-only description', async () => {
    const api = mockApi({
      create: vi.fn(async (req: { query: string }) => {
        if (req.query.includes('sum(is_json)')) return { id: 'DET1' };
        if (req.query.includes('count by _sourcecategory, yz_s')) return { id: 'STRATA' };
        return { id: 'PAGE' };
      }),
      status: vi.fn(async () => doneStatus(100, 1)),
      records: vi.fn(async (id: string) => {
        if (id === 'DET1') return { fields: [], records: [detRowNumeric('cat/numeric', 100)] };
        if (id === 'STRATA') {
          return {
            fields: [],
            records: [
              { map: { _sourcecategory: 'cat/numeric', yz_s: 'service', _count: '90' } },
              { map: { _sourcecategory: 'cat/numeric', yz_s: 'exception', _count: '10' } },
            ],
          };
        }
        return { fields: [], records: [] };
      }),
      messages: vi.fn(async () => ({
        fields: [],
        messages: [
          {
            map: {
              _raw: JSON.stringify({ stream: 'stdout', log: { severity: '2.0', type: 'service', message: 'ok' } }),
            },
          },
          {
            map: {
              _raw: JSON.stringify({ stream: 'stderr', log: { type: 'exception', message: 'boom' } }),
            },
          },
        ],
      })),
    });
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_describe_schema',
      arguments: { query: '_sourcecategory=cat/numeric', last: '4h' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('schema description: _sourcecategory=cat/numeric');
    expect(out).toContain('never first-N');
    expect(out).toContain('log.severity'); // enumerated nested key
    expect(out).toContain('float-strings'); // "2.0" flagged
    expect(out).toContain('candidate severity filters');
    expect(out).toContain(
      'num(yz_sev) >= 3 or yz_sev in ("Fatal","Error","ERROR","error","Warning","WARNING","warning") or yz_type = "exception"',
    );
    expect(out).toContain('describe_schema PROPOSES — you decide');
    // Propose-only: every created job was deleted; nothing persisted.
    for (const id of ['DET1', 'STRATA', 'PAGE']) {
      expect(api.delete).toHaveBeenCalledWith(id, { tolerateMissing: true });
    }
  });

  it('rejects aggregate queries without creating a job', async () => {
    const api = mockApi();
    const { client } = await setup(api);
    const res = (await client.callTool({
      name: 'sumo_describe_schema',
      arguments: { query: 'x | count by y', last: '1h' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
  });
});
