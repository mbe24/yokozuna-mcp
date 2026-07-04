import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Config, DetailLevel } from '../config.js';
import { SumoApiError } from '../http/errors.js';
import type { SearchJobApi } from '../sumo/searchJobApi.js';
import { collectMessages, waitForCompletion, type KeepaliveRegistry } from '../sumo/lifecycle.js';
import { parseLast, pickTrendInterval, resolveRange } from '../sumo/time.js';
import { buildExtractClauses, isAggregateQuery } from '../sumo/queryShape.js';
import { buildDeepLink } from '../sumo/deepLink.js';
import type { MonitorsApi } from '../sumo/monitorsApi.js';
import { MAX_PAGE_LIMIT, MAX_TOTAL_MESSAGES, type SearchJobStatus } from '../sumo/types.js';
import { flattenMessage, isCookieNoiseWarning, normalizeLevel } from '../format/flatten.js';
import { formatMessages, sortRowsByMessageTime, type FormatOptions } from '../format/formatMessages.js';
import { formatRecords } from '../format/formatRecords.js';
import { renderFacets, type FacetDimensionResult } from '../format/renderFacets.js';
import { accumulateDigest, renderDigest, type DigestGroup } from '../format/renderDigest.js';
import { renderTrend, type TrendRow } from '../format/renderTrend.js';
import { capResponseText } from '../format/capResponse.js';

export interface ToolContext {
  config: Config;
  api: SearchJobApi;
  monitors: MonitorsApi;
  keepalive: KeepaliveRegistry;
  now?: () => number;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

const AGGREGATE_MESSAGES_400 = 'raw.messages.not.available';
const NOT_AGGREGATE_RECORDS_400 = 'no.records.not.an.aggregation.query';

/** All read tools create/read ephemeral search jobs against a fixed, configured API. */
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false } as const;
/** Delete frees a job slot; deleting an already-gone job is OK (idempotent, not destructive). */
const DELETE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Progress plumbing: when the client sent a progressToken, returns a reporter that emits
 * `notifications/progress` with a strictly increasing counter (`total` intentionally
 * omitted — the number of polls/pages is unknowable upfront). Without a token: undefined,
 * so the hot paths pay zero overhead.
 */
function progressReporter(extra: HandlerExtra): ((message: string) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let progress = 0;
  return (message: string) => {
    progress += 1;
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, message },
      })
      .catch(() => undefined); // progress is best-effort — never fail the search over it
  };
}

/** Real pendingWarnings/pendingErrors minus the persistent cookie-noise warning. */
function realWarnings(status: SearchJobStatus): string[] {
  return [
    ...(status.pendingWarnings ?? []),
    ...(status.pendingErrors ?? []).map((e) => `ERROR: ${e}`),
  ].filter((w) => !isCookieNoiseWarning(w));
}

const SCOPING = `
Scoping in one line: filter WHERE with _sourcecategory=<path>, filter SEVERITY by parsing the JSON payload (| json field=_raw "log.levelname" as levelname nodrop | where levelname in ("ERROR","WARNING") — never _loglevel or stream:"stderr"), and TRACE one request by searching its quoted request_id with no other filters. Hostname keywords match only request logs — hunt errors by _sourcecategory. Full cookbook + workflow: the "triage" MCP prompt.`;

const timeRangeDoc =
  'Time range: exactly ONE of `last` (relative, e.g. "15m", "2h"; units s/m/h/d) OR both `from` and `to` (ISO-8601 like 2026-07-02T18:28:00, or epoch milliseconds).';

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { config, api, monitors, keepalive } = ctx;
  const now = ctx.now ?? Date.now;

  /** All inline successes flow through here — the whole-response cap applies uniformly. */
  const ok = (text: string): ToolResult => ({
    content: [{ type: 'text', text: capResponseText(text, config.maxResponseChars) }],
  });

  const idleDoc = `${config.keepaliveIdleMinutes} minute${config.keepaliveIdleMinutes === 1 ? '' : 's'}`;

  const extractShape = {
    extract: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Optional per-field JSON extraction: alias → path under _raw, e.g. {"status":"log.status","user":"log.context.user"}. Appends one `| json field=_raw "<path>" as <alias> nodrop` clause per entry (chained; never the broken comma multi-extract form). Aliases must be simple identifiers; non-aggregate queries only. Extracted aliases join the flattened field namespace (combine with `fields` or ndjson/export lines).',
      ),
  };

  const sourceCategoryHint = config.defaultSourceCategory
    ? `\nRecommended query prefix for this org (queries are never mutated automatically): _sourcecategory=${config.defaultSourceCategory}`
    : '';

  const detailDoc =
    'Token levers: detail=summary (whole-job level counts — exact via a side-aggregate, or a labeled sample if that fails — plus a compact histogram and top message signatures; cheapest) | compact (timestamp, level, request_id, _sourcecategory, FULL message, plus method/path/status when present) | full (compact + duration_s/logger/client_ip) | raw (verbatim _raw — logs exactly as the app emitted them, including anything sensitive it logged). See the fields/dedupe/maxMessageChars params for projection, grouping, and the message-length cap.';

  const timeRangeShape = {
    last: z
      .string()
      .optional()
      .describe('Relative window ending now, e.g. "15m", "2h", "1d". Mutually exclusive with from/to.'),
    from: z.string().optional().describe('Start time: ISO-8601 or epoch ms. Requires `to`.'),
    to: z.string().optional().describe('End time: ISO-8601 or epoch ms. Requires `from`.'),
    timeZone: z
      .string()
      .optional()
      .describe(`IANA timezone for query-time parsing (default ${config.defaultTimeZone}).`),
    byReceiptTime: z
      .boolean()
      .optional()
      .describe('Search by receipt time; recommended true for very recent windows (ingestion lag).'),
  };

  const formatShape = {
    detail: z.enum(['summary', 'compact', 'full', 'raw']).optional()
      .describe(`Output verbosity (default ${config.defaultDetail}).`),
    fields: z.array(z.string()).optional()
      .describe('Explicit field projection from the flattened namespace (level/request_id always kept).'),
    dedupe: z.boolean().optional().describe(
      'Group repeated messages globally by (level, signature) — timestamps/UUIDs/hex/numbers are normalized away — and render "first_ts..last_ts LEVEL ×N message".',
    ),
    maxMessageChars: z.number().int().min(100).optional()
      .describe(`Safety cap for the message field (default ${config.maxMessageChars}); the message is never truncated by default.`),
    format: z.enum(['text', 'ndjson']).optional().describe('Output mode (default text).'),
    sort: z.enum(['asc', 'desc']).optional().describe(
      'Order of returned messages by _messagetime (default "asc" = oldest→newest, best for tracing). Client-side: orders only the RETURNED result set — raise limit or narrow the query for full ordering. Not applicable to aggregate records.',
    ),
  };

  const fmtOpts = (input: {
    detail?: DetailLevel;
    fields?: string[];
    dedupe?: boolean;
    maxMessageChars?: number;
    format?: 'text' | 'ndjson';
  }): FormatOptions => ({
    detail: input.detail ?? config.defaultDetail,
    fields: input.fields,
    dedupe: input.dedupe ?? false,
    maxMessageChars: input.maxMessageChars ?? config.maxMessageChars,
    format: input.format ?? ('text' as const),
  });

  /** Shared create step: resolve the time range and create the job. */
  const createJob = async (
    input: {
      query: string;
      last?: string;
      from?: string;
      to?: string;
      timeZone?: string;
      byReceiptTime?: boolean;
    },
    signal?: AbortSignal,
  ) => {
    const range = resolveRange(input, now);
    const created = await api.create(
      {
        query: input.query,
        from: range.from,
        to: range.to,
        timeZone: input.timeZone ?? config.defaultTimeZone,
        byReceiptTime: input.byReceiptTime,
      },
      signal,
    );
    return { created, range };
  };

  /**
   * Summary support: one extra `count by levelname` aggregate job for an EXACT whole-job
   * level breakdown (the fetched page is only a sample). Returns undefined on any failure
   * or partial wait — the summary then falls back to a clearly-labeled sample count.
   */
  const fetchExactLevelCounts = async (
    input: { query: string; timeZone?: string; byReceiptTime?: boolean },
    range: { from: string | number; to: string | number },
    signal?: AbortSignal,
  ): Promise<Record<string, number> | undefined> => {
    let aggId: string | undefined;
    try {
      const created = await api.create(
        {
          query: `${input.query} | json field=_raw "${config.levelExpr}" as levelname nodrop | count by levelname`,
          from: range.from,
          to: range.to,
          timeZone: input.timeZone ?? config.defaultTimeZone,
          byReceiptTime: input.byReceiptTime,
        },
        signal,
      );
      aggId = created.id;
      const wait = await waitForCompletion(api, aggId, { timeoutMs: 120_000, signal });
      if (wait.partial) return undefined;
      const page = await api.records(aggId, 0, 100, signal);
      const counts: Record<string, number> = {};
      for (const r of page.records ?? []) {
        const lvl = normalizeLevel(r.map['levelname']) ?? 'UNKNOWN';
        counts[lvl] = (counts[lvl] ?? 0) + Number(r.map['_count'] ?? 0);
      }
      return counts;
    } catch {
      return undefined;
    } finally {
      // Cleanup delete stays SIGNAL-FREE: an aborted signal here would leak the job.
      if (aggId) await api.delete(aggId, { tolerateMissing: true }).catch(() => undefined);
    }
  };

  // ---------------------------------------------------------------- sumo_run_search
  server.registerTool(
    'sumo_run_search',
    {
      title: 'Run a Sumo Logic search (create → wait → fetch → delete)',
      description:
        `Workhorse: creates a Sumo Logic search job, waits for completion, returns the first N results, and deletes the job. ${timeRangeDoc}\n${detailDoc}\nInline limit max 5000 — use sumo_export_results for bulk (up to 100k to a file).${sourceCategoryHint}\n${SCOPING}`,
      inputSchema: {
        query: z.string().min(1).describe('Sumo Logic query text.'),
        ...timeRangeShape,
        limit: z.number().int().min(1).max(5000).optional()
          .describe(`Max inline results (default ${config.defaultLimit}, hard max 5000).`),
        ...formatShape,
        ...extractShape,
        keepJob: z.boolean().optional()
          .describe(`Keep the job alive after returning (server keeps it polled; use the primitives to page more). Idle kept jobs are auto-deleted after ~${idleDoc} (YOKOZUNA_KEEPALIVE_IDLE_MINUTES); any access (status/messages/records) resets the idle timer.`),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      let jobId: string | undefined;
      try {
        const report = progressReporter(extra);
        if (input.extract && Object.keys(input.extract).length > 0 && isAggregateQuery(input.query)) {
          return fail(
            new Error(
              '`extract` only applies to NON-aggregate queries (clauses are appended after the query, which would land after your aggregation). Put the | json extraction into the query yourself for aggregates.',
            ),
          );
        }
        const effectiveQuery = `${input.query}${buildExtractClauses(input.extract)}`;
        const { created, range } = await createJob({ ...input, query: effectiveQuery }, extra.signal);
        jobId = created.id;

        // Summary side-aggregate runs CONCURRENTLY with the main wait (2 jobs ≪ the
        // 10-concurrent/4-rps caps); skipped for aggregate queries, where the exact
        // breakdown is meaningless and the sample-count fallback already applies.
        const detail = input.detail ?? config.defaultDetail;
        const exactLevelCountsPromise =
          detail === 'summary' && !isAggregateQuery(input.query)
            ? fetchExactLevelCounts(input, range, extra.signal)
            : undefined;

        const wait = await waitForCompletion(api, jobId, {
          signal: extra.signal,
          onProgress: report
            ? (p) => report(`${p.state} messageCount=${p.messageCount}`)
            : undefined,
        });
        const status = wait.status;
        const limit = input.limit ?? config.defaultLimit;

        let body: string;
        let resultCount: number;
        let kind: 'records' | 'messages';
        if ((status.recordCount ?? 0) > 0) {
          const page = await api.records(jobId, 0, limit, extra.signal);
          body = formatRecords(page, input.format ?? 'text');
          resultCount = page.records?.length ?? 0;
          kind = 'records';
        } else {
          try {
            const page = await api.messages(jobId, 0, limit, extra.signal);
            const rows = sortRowsByMessageTime(page.messages ?? [], input.sort ?? 'asc');
            const opts = fmtOpts(input);
            if (opts.detail === 'summary') {
              opts.exactLevelCounts = exactLevelCountsPromise
                ? await exactLevelCountsPromise
                : undefined;
            }
            body = formatMessages(rows, opts, status);
            resultCount = rows.length;
            kind = 'messages';
          } catch (err) {
            if (err instanceof SumoApiError && err.is(AGGREGATE_MESSAGES_400)) {
              // Zero-record aggregate: /records returns 200 with fields + empty records.
              const page = await api.records(jobId, 0, limit, extra.signal);
              body = formatRecords(page, input.format ?? 'text');
              resultCount = page.records?.length ?? 0;
              kind = 'records';
            } else {
              throw err;
            }
          }
        }

        // Shared trailer notes — must appear on BOTH the results and the 0-result paths.
        const warns = realWarnings(status);
        const link = buildDeepLink(config.uiBaseUrl, effectiveQuery, range.fromMs, range.toMs);
        const notes: string[] = [];
        if (wait.truncated) notes.push('TRUNCATED: query hit the 100k message cap (FORCE PAUSED) — narrow the time range for full coverage.');
        if (wait.partial) notes.push('PARTIAL: wait timed out before completion — results are what was gathered so far.');
        if (warns.length > 0) notes.push(`warnings: ${warns.join(' | ')}`);
        if (link) notes.push(`open in Sumo UI: ${link}`);
        if (input.keepJob) notes.push(`job kept alive: id=${jobId} (auto-polled by the server; idle jobs are auto-deleted after ~${idleDoc}, any access resets the timer; delete with sumo_delete_search_job)`);
        if (kind === 'messages' && resultCount > 0 && resultCount < status.messageCount) {
          notes.push(
            `showing ${resultCount} of ${status.messageCount} messages — raise limit (max 5000), or re-run with keepJob: true and page the rest via sumo_get_messages offset/limit.`,
          );
        }

        if (resultCount === 0) {
          const zero = [`No results (state=${status.state}, messageCount=${status.messageCount}, recordCount=${status.recordCount}).`];
          if (warns.length === 0 && !wait.partial && !wait.truncated) {
            zero.push('No warnings — the query matched nothing in this time range (check the range, source category spelling, and ingestion lag; consider byReceiptTime: true).');
          }
          return ok([...zero, ...notes].join('\n'));
        }

        const header =
          kind === 'records'
            ? `aggregate search: recordCount=${status.recordCount} (messageCount=${status.messageCount} is scanned input, not results)`
            : `messageCount=${status.messageCount}, showing ${resultCount}`;
        return ok(`${[header, ...notes].join('\n')}\n\n${body}`);
      } catch (err) {
        return fail(err);
      } finally {
        if (jobId) {
          if (input.keepJob && !extra.signal.aborted) {
            keepalive.register(jobId);
          } else {
            // Cancelled requests never keep the job. This delete stays SIGNAL-FREE:
            // passing the (possibly aborted) signal would instantly abort it and leak.
            await api.delete(jobId, { tolerateMissing: true }).catch(() => undefined);
          }
        }
      }
    },
  );

  // ---------------------------------------------------------- sumo_create_search_job
  server.registerTool(
    'sumo_create_search_job',
    {
      title: 'Create a search job (primitive)',
      description:
        `Creates a search job and returns its id WITHOUT waiting. The server background-polls created jobs (keepalive) so the job persists across your tool calls; without that, Sumo cancels jobs after a short idle period. Page results with sumo_get_messages / sumo_get_records; always call sumo_delete_search_job when done. ${timeRangeDoc}${sourceCategoryHint}`,
      inputSchema: {
        query: z.string().min(1).describe('Sumo Logic query text.'),
        ...timeRangeShape,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      try {
        const { created } = await createJob(input, extra.signal);
        if (extra.signal.aborted) {
          // Cancelled between create and return: never keepalive an unwanted job.
          await api.delete(created.id, { tolerateMissing: true }).catch(() => undefined);
          return fail(new Error('Request cancelled — the created search job was deleted.'));
        }
        keepalive.register(created.id);
        return ok(
          `Search job created: id=${created.id}\nThe server keeps it alive by background-polling; it will be auto-deleted after ~${idleDoc} idle (any access via status/messages/records resets the idle timer). Poll with sumo_get_search_job_status; page with sumo_get_messages (non-aggregate) or sumo_get_records (aggregate); delete with sumo_delete_search_job.`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------ sumo_get_search_job_status
  server.registerTool(
    'sumo_get_search_job_status',
    {
      title: 'Get search job status (primitive)',
      description:
        'Polls a search job (and resets a kept job\'s idle timer). States: NOT STARTED / GATHERING RESULTS (in progress; partial results already pageable) / DONE GATHERING RESULTS / FORCE PAUSED (100k cap hit — results available, truncated) / CANCELLED. For aggregate queries messageCount counts scanned input; recordCount is the result count.',
      inputSchema: { id: z.string().min(1).describe('Search job id.') },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      try {
        keepalive.touch(input.id);
        const status = await api.status(input.id, { signal: extra.signal });
        const lines = [
          `state: ${status.state}`,
          `messageCount: ${status.messageCount}`,
          `recordCount: ${status.recordCount}`,
        ];
        const warns = realWarnings(status);
        if (warns.length > 0) lines.push(`warnings: ${warns.join(' | ')}`);
        return ok(lines.join('\n'));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --------------------------------------------------------------- sumo_get_messages
  server.registerTool(
    'sumo_get_messages',
    {
      title: 'Page messages of a search job (non-aggregate; primitive)',
      description:
        `Pages messages of a NON-aggregate search job (aggregate jobs 400 — use sumo_get_records). Page size max ${MAX_PAGE_LIMIT}. Partial results are pageable while the job is still gathering. ${detailDoc}`,
      inputSchema: {
        id: z.string().min(1).describe('Search job id.'),
        offset: z.number().int().min(0).optional().describe('Start offset (default 0).'),
        limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional().describe('Page size (default 100).'),
        ...formatShape,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      try {
        keepalive.touch(input.id);
        const page = await api.messages(input.id, input.offset ?? 0, input.limit ?? 100, extra.signal);
        const n = page.messages?.length ?? 0;
        if (n === 0) return ok('(no messages in this page)');
        const rows = sortRowsByMessageTime(page.messages, input.sort ?? 'asc');
        return ok(formatMessages(rows, fmtOpts(input)));
      } catch (err) {
        if (err instanceof SumoApiError && err.is(AGGREGATE_MESSAGES_400)) {
          return fail(
            new Error('This is an AGGREGATE search job — raw messages are not available; use sumo_get_records instead.'),
          );
        }
        return fail(err);
      }
    },
  );

  // ---------------------------------------------------------------- sumo_get_records
  server.registerTool(
    'sumo_get_records',
    {
      title: 'Page aggregate records of a search job (primitive)',
      description:
        `Pages records of an AGGREGATE search job (non-aggregate jobs 400 — use sumo_get_messages). Page size max ${MAX_PAGE_LIMIT}.`,
      inputSchema: {
        id: z.string().min(1).describe('Search job id.'),
        offset: z.number().int().min(0).optional().describe('Start offset (default 0).'),
        limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional().describe('Page size (default 100).'),
        format: z.enum(['text', 'ndjson']).optional().describe('Output mode (default text).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      try {
        keepalive.touch(input.id);
        const page = await api.records(input.id, input.offset ?? 0, input.limit ?? 100, extra.signal);
        return ok(formatRecords(page, input.format ?? 'text'));
      } catch (err) {
        if (err instanceof SumoApiError && err.is(NOT_AGGREGATE_RECORDS_400)) {
          return fail(
            new Error('This is a NON-aggregate search job — there are no records; use sumo_get_messages instead.'),
          );
        }
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------ sumo_delete_search_job
  server.registerTool(
    'sumo_delete_search_job',
    {
      title: 'Delete a search job (primitive)',
      description:
        'Deletes a search job, freeing its slot against the 200-active-jobs org cap. Always delete jobs you created via sumo_create_search_job (or kept with keepJob: true) when done. Deleting an already-gone job is not an error.',
      inputSchema: { id: z.string().min(1).describe('Search job id.') },
      annotations: DELETE_ANNOTATIONS,
    },
    async (input): Promise<ToolResult> => {
      try {
        keepalive.unregister(input.id);
        await api.delete(input.id, { tolerateMissing: true });
        return ok(`Search job ${input.id} deleted (or already gone).`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -------------------------------------------------------------- sumo_export_results
  server.registerTool(
    'sumo_export_results',
    {
      title: 'Export all search results to a file',
      description:
        `Runs a search and streams ALL results (up to the ${MAX_TOTAL_MESSAGES.toLocaleString('en-US')} server cap) to an NDJSON file on disk, returning the file path — NOT the content. Use this for bulk analysis ("feed the logs to a coding agent") instead of large inline limits. Each line is one flattened log object (metadata + parsed _raw log.* fields). Lines are CHRONOLOGICAL (oldest→newest by _messagetime; the server appends "| sort by _messagetime asc" to non-aggregate queries — a PARTIAL result may not be fully ordered). Aggregate queries export their records instead (one JSON record per line, query order; maxMessages/extract do not apply). If more than 100k messages match, split the time range into multiple exports. ${timeRangeDoc}${sourceCategoryHint}`,
      inputSchema: {
        query: z.string().min(1).describe('Sumo Logic query text.'),
        ...timeRangeShape,
        maxMessages: z.number().int().min(1).max(MAX_TOTAL_MESSAGES).optional()
          .describe(`Stop after this many messages (default ${MAX_TOTAL_MESSAGES.toLocaleString('en-US')}).`),
        ...extractShape,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      let jobId: string | undefined;
      let stream: fs.WriteStream | undefined;
      try {
        const report = progressReporter(extra);
        const aggregate = isAggregateQuery(input.query);
        if (input.extract && Object.keys(input.extract).length > 0 && aggregate) {
          return fail(
            new Error(
              '`extract` only applies to NON-aggregate queries (clauses are appended after the query, which would land after your aggregation). Put the | json extraction into the query yourself for aggregates.',
            ),
          );
        }
        // Non-aggregate exports are sorted SERVER-SIDE for exact global chronological
        // order with O(page) client memory (live-verified: "| sort by _messagetime asc"
        // keeps the job a messages job and orders across pages beyond 10k).
        const effectiveQuery = aggregate
          ? input.query
          : `${input.query}${buildExtractClauses(input.extract)} | sort by _messagetime asc`;
        const { created } = await createJob({ ...input, query: effectiveQuery }, extra.signal);
        jobId = created.id;
        const wait = await waitForCompletion(api, jobId, {
          timeoutMs: 480_000,
          signal: extra.signal,
          onProgress: report
            ? (p) => report(`${p.state} messageCount=${p.messageCount}`)
            : undefined,
        });
        const status = wait.status;

        fs.mkdirSync(config.exportDir, { recursive: true });
        const file = path.join(
          config.exportDir,
          `yokozuna-export-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${jobId}.ndjson`,
        );
        stream = fs.createWriteStream(file, { encoding: 'utf8' });
        // ONE write (and one await) per PAGE, not per line — ~1000× fewer round-trips
        // through the stream machinery on big exports.
        const writeBatch = (lines: string[]) =>
          new Promise<void>((resolve, reject) => {
            if (lines.length === 0) return resolve();
            stream!.write(lines.join('\n') + '\n', (e) => (e ? reject(e) : resolve()));
          });

        let count = 0;
        let truncated = wait.truncated;

        if ((status.recordCount ?? 0) > 0) {
          // Aggregate: export records.
          let offset = 0;
          for (;;) {
            extra.signal.throwIfAborted();
            const page = await api.records(jobId, offset, MAX_PAGE_LIMIT, extra.signal);
            const got = page.records?.length ?? 0;
            if (got === 0) break;
            await writeBatch(page.records.map((r) => JSON.stringify(r.map)));
            offset += got;
            count = offset;
          }
        } else {
          const max = input.maxMessages ?? MAX_TOTAL_MESSAGES;
          try {
            const res = await collectMessages(api, jobId, {
              max,
              pageSize: Math.min(1000, max),
              signal: extra.signal,
              onProgress: report
                ? (p) => report(`exported ${p.collected} messages`)
                : undefined,
              onPage: async (page) => {
                const lines = page.messages.map((m) => {
                  const flat = flattenMessage(m.map);
                  // _raw is dropped: it is a bulky duplicate of the flattened fields.
                  const { _raw, ...rest } = flat.fields;
                  return JSON.stringify({
                    timestamp: flat.timestamp,
                    level: flat.level,
                    request_id: flat.requestId,
                    message: flat.message,
                    ...rest,
                  });
                });
                await writeBatch(lines);
              },
            });
            count = res.collected;
            truncated = truncated || res.truncated;
          } catch (err) {
            if (err instanceof SumoApiError && err.is(AGGREGATE_MESSAGES_400)) {
              // 0-record aggregate — nothing to export.
              count = 0;
            } else {
              throw err;
            }
          }
        }

        await new Promise<void>((resolve, reject) => {
          stream!.end((e?: Error | null) => (e ? reject(e) : resolve()));
        });
        stream = undefined;
        const bytes = fs.statSync(file).size;

        const lines = [
          `exported: ${count} ${status.recordCount > 0 ? 'records' : 'messages'}`,
          `file: ${file}`,
          `bytes: ${bytes}`,
          `job messageCount=${status.messageCount} recordCount=${status.recordCount}`,
        ];
        if (status.recordCount === 0) lines.push('order: chronological (oldest→newest by _messagetime)');
        if (truncated) lines.push('TRUNCATED: hit the export/message cap — split the time range to get everything.');
        if (wait.partial) lines.push('PARTIAL: search did not finish before the wait timeout; exported what was gathered — line order is NOT guaranteed for a partial export.');
        const warns = realWarnings(status);
        if (warns.length > 0) lines.push(`warnings: ${warns.join(' | ')}`);
        return ok(lines.join('\n'));
      } catch (err) {
        return fail(err);
      } finally {
        if (stream) {
          stream.destroy();
        }
        if (jobId) await api.delete(jobId, { tolerateMissing: true }).catch(() => undefined);
      }
    },
  );

  // --------------------------------------------------------------------- sumo_facets
  server.registerTool(
    'sumo_facets',
    {
      title: 'Facet a query across dimensions (ranked top-N counts)',
      description:
        `The fastest way to see the SHAPE of matching logs before reading any messages: runs one small "count by <dimension>" aggregate per dimension (concurrently; every job auto-deleted) and returns a compact ranked table per dimension. Dimensions starting with "_" are native Sumo fields (e.g. _sourcecategory, _sourcehost); anything else is parsed from the JSON payload as log.<dimension> (e.g. levelname, status, path). One failing dimension yields an error line, never a total failure. ${timeRangeDoc}${sourceCategoryHint}`,
      inputSchema: {
        query: z.string().min(1)
          .describe('Sumo Logic scope query (keywords + metadata filters). Scope only — no | operators; each dimension appends its own "| count by".'),
        ...timeRangeShape,
        dimensions: z.array(z.string().min(1)).min(1).max(8).optional()
          .describe(`Dimensions to facet on (default ${JSON.stringify(config.facetDimensions)}). One concurrent search job each.`),
        limit: z.number().int().min(1).max(100).optional()
          .describe('Top-N values per dimension (default 15, max 100).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      try {
        const report = progressReporter(extra);
        const range = resolveRange(input, now);
        const dims = input.dimensions ?? [...config.facetDimensions];
        const limit = input.limit ?? 15;

        const results: FacetDimensionResult[] = await Promise.all(
          dims.map(async (dim): Promise<FacetDimensionResult> => {
            let facetJobId: string | undefined;
            try {
              // `sort by _count` (desc) BEFORE limit — otherwise limit truncates unranked.
              const facetQuery = dim.startsWith('_')
                ? `${input.query} | count by ${dim} | sort by _count | limit ${limit}`
                : `${input.query} | json field=_raw "log.${dim}" as ${dim} nodrop | count by ${dim} | sort by _count | limit ${limit}`;
              const created = await api.create(
                {
                  query: facetQuery,
                  from: range.from,
                  to: range.to,
                  timeZone: input.timeZone ?? config.defaultTimeZone,
                  byReceiptTime: input.byReceiptTime,
                },
                extra.signal,
              );
              facetJobId = created.id;
              const wait = await waitForCompletion(api, facetJobId, {
                signal: extra.signal,
                onProgress: report ? (p) => report(`${dim}: ${p.state}`) : undefined,
              });
              const page = await api.records(facetJobId, 0, limit, extra.signal);
              const rows = (page.records ?? []).map((r) => ({
                key: r.map[dim] ?? '',
                // _count arrives as a STRING — parse for numeric alignment.
                count: Number.parseInt(r.map['_count'] ?? '0', 10) || 0,
              }));
              return { dimension: dim, rows, partial: wait.partial };
            } catch (err) {
              return {
                dimension: dim,
                error: err instanceof Error ? err.message : String(err),
              };
            } finally {
              // SIGNAL-FREE cleanup (an aborted signal here would leak the job).
              if (facetJobId) {
                await api.delete(facetJobId, { tolerateMissing: true }).catch(() => undefined);
              }
            }
          }),
        );

        const fmtBound = (label: string | number, ms: number | undefined) =>
          ms !== undefined ? new Date(ms).toISOString() : String(label);
        return ok(
          renderFacets(
            {
              query: input.query,
              fromLabel: fmtBound(range.from, range.fromMs),
              toLabel: fmtBound(range.to, range.toMs),
              byReceiptTime: input.byReceiptTime ?? false,
              limit,
            },
            results,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --------------------------------------------------------------- sumo_error_digest
  server.registerTool(
    'sumo_error_digest',
    {
      title: 'Deduplicated error/warning digest for a scope',
      description:
        `One-call triage: finds ERROR/WARNING (configurable via levels) messages in scope, groups them by normalized signature (timestamps/UUIDs/hex/numbers stripped), and returns the top-N distinct problems with count, first/last occurrence, a sample request_id for cross-referencing, and the _sourcecategory. Level filter uses ${config.levelExpr} parsed from _raw (reliable), never _loglevel. ${timeRangeDoc}${sourceCategoryHint}`,
      inputSchema: {
        query: z.string().min(1).optional()
          .describe(`Base scope query (default: _sourcecategory=${config.defaultSourceCategory ?? '<SUMO_DEFAULT_SOURCE_CATEGORY — not set>'}). Scope by _sourcecategory, NOT by a hostname keyword — errors/exceptions carry no hostname and would be silently excluded. The level filter is appended automatically — do not add | operators.`),
        ...timeRangeShape,
        levels: z.array(z.string().min(1)).min(1).optional()
          .describe('Levels to include (default ["ERROR","WARNING"]).'),
        limit: z.number().int().min(1).max(200).optional()
          .describe('Top-N signatures to return (default 20).'),
        maxScan: z.number().int().min(1).max(MAX_TOTAL_MESSAGES).optional()
          .describe(`Max messages to scan for grouping (default 5000, cap ${MAX_TOTAL_MESSAGES.toLocaleString('en-US')}). Counts cover the scanned prefix when truncated.`),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      let jobId: string | undefined;
      try {
        const report = progressReporter(extra);
        const base =
          input.query ??
          (config.defaultSourceCategory
            ? `_sourcecategory=${config.defaultSourceCategory}`
            : undefined);
        if (base === undefined) {
          return fail(
            new Error(
              'No scope: provide `query` (e.g. _sourcecategory=kubernetes/...) or set SUMO_DEFAULT_SOURCE_CATEGORY.',
            ),
          );
        }
        const levels = input.levels ?? ['ERROR', 'WARNING'];
        const quoted = levels.map((l) => `"${l.replace(/"/g, '')}"`).join(',');
        const query = `${base} | json field=_raw "${config.levelExpr}" as levelname nodrop | where levelname in (${quoted})`;

        const { created, range } = await createJob({ ...input, query }, extra.signal);
        jobId = created.id;
        const wait = await waitForCompletion(api, jobId, {
          signal: extra.signal,
          onProgress: report
            ? (p) => report(`${p.state} messageCount=${p.messageCount}`)
            : undefined,
        });

        const maxScan = Math.min(input.maxScan ?? 5000, MAX_TOTAL_MESSAGES);
        const groups = new Map<string, DigestGroup>();
        const res = await collectMessages(api, jobId, {
          max: maxScan,
          pageSize: 1000,
          signal: extra.signal,
          onProgress: report ? (p) => report(`scanned ${p.collected} messages`) : undefined,
          onPage: (page) => {
            for (const m of page.messages) {
              accumulateDigest(groups, flattenMessage(m.map), Number(m.map['_messagetime'] ?? 0));
            }
          },
        });

        const body = renderDigest(
          {
            scanned: res.collected,
            levels,
            topN: input.limit ?? 20,
            truncated: res.truncated || wait.truncated,
          },
          groups,
        );

        const notes: string[] = [];
        if (wait.partial) notes.push('PARTIAL: wait timed out before completion — digest covers what was gathered so far.');
        const warns = realWarnings(wait.status);
        if (warns.length > 0) notes.push(`warnings: ${warns.join(' | ')}`);
        const link = buildDeepLink(config.uiBaseUrl, query, range.fromMs, range.toMs);
        if (link) notes.push(`open in Sumo UI: ${link}`);
        return ok([body, ...notes].join('\n'));
      } catch (err) {
        return fail(err);
      } finally {
        // SIGNAL-FREE cleanup (an aborted signal here would leak the job).
        if (jobId) await api.delete(jobId, { tolerateMissing: true }).catch(() => undefined);
      }
    },
  );

  // ------------------------------------------------------------------ sumo_new_since
  server.registerTool(
    'sumo_new_since',
    {
      title: 'What arrived since the last poll (stateless cursor monitor)',
      description:
        `Stateless receipt-time monitor for polling loops: returns messages that ARRIVED since your last call plus a new cursor. First call: omit \`since\` to get a baseline over \`lookback\` (default "15m"). Every response contains a \`cursor=<epoch ms>\` line — pass that value as \`since\` on the next call and the half-open windows [since, now−settleMargin) tile contiguously with no gaps or duplicates. byReceiptTime is FORCED true and the window ends ${config.settleMarginSeconds}s in the past (settle margin) so late-arriving logs are not skipped — results are complete but ~${config.settleMarginSeconds}s stale. Aggregate queries (| count …) are rejected — use sumo_run_search for those. ${detailDoc}${sourceCategoryHint}`,
      inputSchema: {
        query: z.string().min(1).describe('Sumo Logic query text (NON-aggregate — raw messages only).'),
        since: z.union([z.number(), z.string()]).optional()
          .describe('Cursor from the previous sumo_new_since response (epoch ms). Omit on the first call.'),
        lookback: z.string().optional()
          .describe('Baseline window when `since` is absent, e.g. "15m", "1h" (units s/m/h/d; default "15m").'),
        limit: z.number().int().min(1).max(5000).optional()
          .describe(`Max inline results (default ${config.defaultLimit}, hard max 5000).`),
        ...formatShape,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      let jobId: string | undefined;
      try {
        if (isAggregateQuery(input.query)) {
          return fail(
            new Error(
              'sumo_new_since only supports NON-aggregate queries (it pages raw messages by receipt time). This query contains an aggregation operator — use sumo_run_search for aggregates.',
            ),
          );
        }
        const report = progressReporter(extra);
        const nowMs = now();
        const to = nowMs - config.settleMarginSeconds * 1000;
        let from: number;
        if (input.since !== undefined) {
          from = Number(input.since);
          if (!Number.isFinite(from)) {
            return fail(
              new Error(
                `Invalid \`since\` value "${String(input.since)}" — pass the cursor=<epoch ms> value from the previous sumo_new_since response.`,
              ),
            );
          }
        } else {
          from = to - parseLast(input.lookback ?? '15m');
        }

        if (to <= from) {
          // Polled too soon: the settle margin has not elapsed past the cursor.
          // No job is created; the cursor is echoed UNCHANGED.
          const retryS = Math.ceil((from - to) / 1000);
          return ok(
            [
              `not settled yet: polled too soon — the window end (now − ${config.settleMarginSeconds}s settle margin) has not passed the cursor. No search was run.`,
              `cursor=${from}  (unchanged — pass as \`since\` next poll; retry in ~${retryS}s)`,
            ].join('\n'),
          );
        }

        const created = await api.create(
          {
            query: input.query,
            from,
            to,
            timeZone: config.defaultTimeZone,
            byReceiptTime: true, // forced: the cursor is only sound over receipt time
          },
          extra.signal,
        );
        jobId = created.id;
        const wait = await waitForCompletion(api, jobId, {
          signal: extra.signal,
          onProgress: report
            ? (p) => report(`${p.state} messageCount=${p.messageCount}`)
            : undefined,
        });
        const status = wait.status;
        const limit = input.limit ?? config.defaultLimit;

        let body = '';
        let shown = 0;
        if ((status.messageCount ?? 0) > 0) {
          const page = await api.messages(jobId, 0, limit, extra.signal);
          const rows = sortRowsByMessageTime(page.messages ?? [], input.sort ?? 'asc');
          body = formatMessages(rows, fmtOpts(input), status);
          shown = rows.length;
        }

        const sinceLabel =
          input.since !== undefined
            ? new Date(from).toISOString()
            : `BASELINE (lookback ${input.lookback ?? '15m'})`;
        const lines = [
          `new since ${sinceLabel}: ${status.messageCount} matches`,
          `window: [${new Date(from).toISOString()} .. ${new Date(to).toISOString()}) byReceiptTime=true settleMargin=${config.settleMarginSeconds}s`,
          `cursor=${to}  (pass as \`since\` in the next sumo_new_since call)`,
        ];
        if (wait.truncated) lines.push('TRUNCATED: query hit the 100k message cap (FORCE PAUSED) — narrow the query or poll more often.');
        if (wait.partial) lines.push('PARTIAL: wait timed out before completion — counts cover what was gathered so far.');
        if (shown > 0 && shown < status.messageCount) {
          lines.push(`showing ${shown} of ${status.messageCount} messages — raise limit (max 5000) or narrow the query.`);
        }
        const warns = realWarnings(status);
        if (warns.length > 0) lines.push(`warnings: ${warns.join(' | ')}`);
        const link = buildDeepLink(config.uiBaseUrl, input.query, from, to);
        if (link) lines.push(`open in Sumo UI: ${link}`);
        return ok(body === '' ? lines.join('\n') : `${lines.join('\n')}\n\n${body}`);
      } catch (err) {
        return fail(err);
      } finally {
        // SIGNAL-FREE cleanup (an aborted signal here would leak the job).
        if (jobId) await api.delete(jobId, { tolerateMissing: true }).catch(() => undefined);
      }
    },
  );

  // --------------------------------------------------------------------- sumo_trend
  server.registerTool(
    'sumo_trend',
    {
      title: 'Timeslice trend: counts over time per series (sparklines)',
      description:
        `Shows WHEN things happened: buckets matching messages with | timeslice, counts per bucket split into series (default: log level via ${config.levelExpr}), and renders one compact sparkline + per-bucket counts per series. Use it to spot spikes and onsets before reading messages. The query must be a plain scope — no | aggregation operators (timeslice/count are appended; one search job, auto-deleted). ${timeRangeDoc}${sourceCategoryHint}`,
      inputSchema: {
        query: z.string().min(1)
          .describe('Sumo Logic scope query (keywords + metadata filters; no | aggregation operators).'),
        ...timeRangeShape,
        interval: z.string().optional().describe(
          'Bucket size, e.g. "30s", "5m", "1h" (units s/m/h/d). Default: auto — the smallest nice step giving ≤40 buckets over the window.',
        ),
        by: z.string().optional().describe(
          `Series dimension (default "levelname", parsed from ${config.levelExpr}). "_"-prefixed = native Sumo field (e.g. _sourcecategory); "none" = one total series; anything else parses log.<by> from the JSON payload.`,
        ),
        maxSeries: z.number().int().min(1).max(20).optional()
          .describe('Max series rendered, ranked by total count (default 8; the rest merge into "(other)").'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      let jobId: string | undefined;
      try {
        if (isAggregateQuery(input.query)) {
          return fail(
            new Error(
              'sumo_trend needs a plain scope query — it appends its own "| timeslice | count by". For custom aggregates use sumo_run_search.',
            ),
          );
        }
        const by = input.by ?? 'levelname';
        if (by !== 'none' && !/^_?[A-Za-z][A-Za-z0-9_]*$/.test(by)) {
          return fail(
            new Error(`Invalid series dimension "${by}" — use a simple identifier, a "_"-prefixed native field, or "none".`),
          );
        }
        const report = progressReporter(extra);
        const range = resolveRange(input, now);
        const windowMs =
          range.fromMs !== undefined && range.toMs !== undefined ? range.toMs - range.fromMs : undefined;
        const intervalLabel = input.interval?.trim() || pickTrendInterval(windowMs);
        const intervalMs = parseLast(intervalLabel); // also validates an explicit interval

        let query: string;
        if (by === 'none') {
          query = `${input.query} | timeslice ${intervalLabel} | count by _timeslice`;
        } else if (by.startsWith('_')) {
          query = `${input.query} | timeslice ${intervalLabel} | count by _timeslice, ${by}`;
        } else {
          const path = by === 'levelname' ? config.levelExpr : `log.${by}`;
          query = `${input.query} | json field=_raw "${path}" as ${by} nodrop | timeslice ${intervalLabel} | count by _timeslice, ${by}`;
        }

        const created = await api.create(
          {
            query,
            from: range.from,
            to: range.to,
            timeZone: input.timeZone ?? config.defaultTimeZone,
            byReceiptTime: input.byReceiptTime,
          },
          extra.signal,
        );
        jobId = created.id;
        const wait = await waitForCompletion(api, jobId, {
          signal: extra.signal,
          onProgress: report
            ? (p) => report(`${p.state} messageCount=${p.messageCount}`)
            : undefined,
        });

        // Collect ALL records (series × buckets is small; still page defensively,
        // with a hard stop at the 100k server cap in case a page keeps repeating).
        const rows: TrendRow[] = [];
        let offset = 0;
        while (offset < MAX_TOTAL_MESSAGES) {
          extra.signal.throwIfAborted();
          const page = await api.records(jobId, offset, MAX_PAGE_LIMIT, extra.signal);
          const got = page.records?.length ?? 0;
          if (got === 0) break;
          for (const r of page.records) {
            const key =
              by === 'none'
                ? 'all'
                : by === 'levelname'
                  ? (normalizeLevel(r.map[by]) ?? '')
                  : (r.map[by] ?? '');
            rows.push({
              sliceMs: Number(r.map['_timeslice'] ?? 0),
              key,
              // _count arrives as a STRING (live-verified).
              count: Number.parseInt(r.map['_count'] ?? '0', 10) || 0,
            });
          }
          offset += got;
        }

        const fmtBound = (label: string | number, ms: number | undefined) =>
          ms !== undefined ? new Date(ms).toISOString() : String(label);
        const body = renderTrend(
          {
            fromLabel: fmtBound(range.from, range.fromMs),
            toLabel: fmtBound(range.to, range.toMs),
            intervalLabel,
            intervalMs,
            by,
            maxSeries: input.maxSeries ?? 8,
          },
          rows,
        );

        const notes: string[] = [];
        if (wait.truncated) notes.push('TRUNCATED: the scan hit the 100k message cap (FORCE PAUSED) — counts cover the scanned prefix.');
        if (wait.partial) notes.push('PARTIAL: wait timed out before completion — counts cover what was gathered so far.');
        const warns = realWarnings(wait.status);
        if (warns.length > 0) notes.push(`warnings: ${warns.join(' | ')}`);
        const link = buildDeepLink(config.uiBaseUrl, query, range.fromMs, range.toMs);
        if (link) notes.push(`open in Sumo UI: ${link}`);
        return ok([body, ...notes].join('\n'));
      } catch (err) {
        return fail(err);
      } finally {
        // SIGNAL-FREE cleanup (an aborted signal here would leak the job).
        if (jobId) await api.delete(jobId, { tolerateMissing: true }).catch(() => undefined);
      }
    },
  );

  // ------------------------------------------------------------- sumo_list_monitors
  server.registerTool(
    'sumo_list_monitors',
    {
      title: 'List Sumo Logic Monitors (native alerting; read-only)',
      description:
        'Discovers the org\'s native Sumo Logic Monitors (the 24/7 prod alerting): name, folder path, type, enabled/disabled, current status, trigger types, and notification destinations. Read-only management-API call — no search jobs involved. Requires an access key with the "View Monitors" capability (without it Sumo returns HTTP 403). Optional query filters by monitor name/content.',
      inputSchema: {
        query: z.string().min(1).optional()
          .describe('Filter text (Sumo monitors-search syntax; matched against monitor names/content).'),
        limit: z.number().int().min(1).max(1000).optional()
          .describe('Max monitors returned (default 100).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      try {
        const q = input.query ? `type:monitor ${input.query}` : 'type:monitor';
        const hits = await monitors.search(q, input.limit ?? 100, extra.signal);
        if (hits.length === 0) return ok('No monitors matched.');
        const lines = [`monitors: ${hits.length}`];
        for (const h of hits) {
          const m = h.item ?? {};
          const state = m.isDisabled ? 'DISABLED' : (m.status ?? []).join(',') || '?';
          const triggers =
            [...new Set((m.triggers ?? []).map((t) => t.triggerType).filter(Boolean))].join(',') || '-';
          const dests = [
            ...new Set(
              (m.notifications ?? [])
                .map((n) => n.notification?.connectionType)
                .filter((c): c is string => !!c),
            ),
          ];
          lines.push(
            `[${state}] ${m.name ?? m.id ?? '?'} (${h.path ?? '?'}) type=${m.monitorType ?? '?'} triggers=${triggers} notify=${dests.length > 0 ? dests.join(',') : 'none'}`,
          );
        }
        return ok(lines.join('\n'));
      } catch (err) {
        if (err instanceof SumoApiError && err.httpStatus === 403) {
          return fail(
            new Error(
              'Sumo denied the Monitors API (HTTP 403): this access key lacks the "View Monitors" capability. Ask an admin to add it to the service-account role to use sumo_list_monitors.',
            ),
          );
        }
        return fail(err);
      }
    },
  );
}
