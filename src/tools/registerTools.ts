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
import type { MonitorsApi, MonitorSearchHit } from '../sumo/monitorsApi.js';
import { MAX_PAGE_LIMIT, MAX_TOTAL_MESSAGES, type SearchJobStatus } from '../sumo/types.js';
import {
  detectSchema,
  DetectionCache,
  annotateNumWarnings,
  confidentZeroFill,
  formatAge,
  type Detection,
} from '../sumo/detectSchema.js';
import { describeSchema } from '../sumo/describeSchema.js';
import {
  ALERTS_INDEX_SCOPE,
  correlateAlertEvents,
  parseAlertEvent,
  renderAlerts,
  type AlertEvent,
} from '../sumo/alerts.js';
import {
  coerceNumericDisplay,
  flattenMessage,
  isCookieNoiseWarning,
  normalizeLevel,
} from '../format/flatten.js';
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
Scoping in one line: filter WHERE with _sourcecategory=<path>. Severity schemas VARY per system — let sumo_error_digest auto-detect (it discloses what it applied), or run sumo_describe_schema on a new scope and pass filter=. TRACE one request by searching its quoted correlation id with no other filters. Hostname keywords match only request logs — hunt errors by _sourcecategory. Full workflow: the "triage" MCP prompt.`;

/** Shared derived-series clause for string-payload scopes (trend series / summary counts). */
const TOKEN_CLASS_CLAUSE =
  ' | if(_raw matches "*[error]*","[error]", if(_raw matches "*[crit]*","[crit]", if(_raw matches "*[warn*","[warn]", "other"))) as yz_tok';

/** Dimensions/series: `_native`, or an ABSOLUTE JSON path from the `_raw` root (dots ok). */
const DIM_RE = /^_?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

/** Append an agent-supplied `filter=` fragment verbatim (keyword terms or a `|` chain). */
const appendFilter = (scope: string, filter: string): string => `${scope} ${filter.trim()}`;

const nUS = (n: number): string => n.toLocaleString('en-US');

const pctLabel = (x: number, m: number): string => {
  if (m <= 0) return '?';
  const pct = (x / m) * 100;
  return `${pct === 0 || pct >= 0.1 ? pct.toFixed(1) : pct.toFixed(3)}%`;
};

/** §4.3 caveat lines — shared verbatim by digest/trend/summary disclosures. */
const DETECTION_CAVEAT =
  '  caveat: detection is SYNTACTIC — severity semantics are not verified (e.g. "[error]"-on-stderr\n' +
  '  can be benign scanner noise; judge the signatures below). Pass filter= to override; run\n' +
  "  sumo_describe_schema to learn this scope's schema in depth.";

/** §4.3: the disclosure block for an auto-detected filter. matched-N-of-M is mandatory. */
function detectionDisclosure(det: Detection, matched: number): string {
  const cached = det.cachedAgeMs !== undefined;
  const suffix = cached ? ` (detection cached, ${formatAge(det.cachedAgeMs!)})` : '';
  const m = det.scopeTotal;
  const matchedLine = cached
    ? `  matched: ${nUS(matched)} of ~${nUS(m)} in-scope messages (${pctLabel(matched, m)} — scope total from the cached detection window)`
    : `  matched: ${nUS(matched)} of ${nUS(m)} in-scope messages (${pctLabel(matched, m)})`;
  return [
    `severity filter (auto-detected): ${det.predicate!.trim()}${suffix}`,
    `  detected from: ${det.detectedFromLine}`,
    matchedLine,
    DETECTION_CAVEAT,
  ].join('\n');
}

/** §4.4: the zero-match guardrail — loud, top of output, never a bare "(no matching messages)". */
function zeroMatchBlock(mLabel: string): string {
  return [
    `!! ZERO MATCHES from the severity filter, but the scope is NOT empty (${mLabel}).`,
    "   The filter may not fit this scope's schema. Run sumo_describe_schema on this scope, then",
    '   re-run with filter=<fragment it proposes>. Do NOT read this result as "no errors".',
  ].join('\n');
}

/**
 * §4.4 refinement: zero matches under a CONFIDENT detection (the detected severity field
 * present at high fill on a non-empty scope) is a genuinely clean read — render calm, not
 * alarming. Honest either way: the §4.3 disclosure above still shows matched 0 of M.
 */
function calmZeroBlock(conf: { label: string; fillN: number }, m: number): string {
  return (
    `no ERROR/WARNING in this window — the detected ${conf.label} is present on ` +
    `${pctLabel(conf.fillN, m)} of ${nUS(m)} messages, so this looks genuinely clean ` +
    '(not a schema mismatch).'
  );
}

/** §4.4 softened variant for filter= mode, where the scope total is unknown. */
const ZERO_MATCH_UNKNOWN_M = [
  '!! ZERO MATCHES from the severity filter (scope total not measured in filter= mode).',
  '   If the scope is non-empty the filter may not fit its schema. Run sumo_describe_schema on this',
  '   scope, then re-run with filter=<fragment it proposes>. Do NOT read this result as "no errors".',
].join('\n');

/** §4.5: no-signal fallback disclosure (the digest still runs, unfiltered). */
function noSignalDisclosure(m: number): string {
  return [
    'severity filter: NONE APPLIED — no severity signal detected in this scope (candidate',
    'vocabulary: log.levelname/level/severity/loglevel/type, stream, [error]/[warn]/[crit] tokens).',
    `Digesting ALL ${nUS(m)} messages by signature instead. Run sumo_describe_schema to learn this`,
    "scope's fields, then pass filter=.",
  ].join('\n');
}

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
    'Token levers: detail=summary (whole-job counts by the AUTO-DETECTED severity field — exact via a side-aggregate with disclosed provenance, or a loud SAMPLE label if that fails — plus a compact histogram and top message signatures; cheapest) | compact (timestamp, level, request_id, _sourcecategory, FULL message, plus method/path/status when present) | full (compact + duration_s/logger/client_ip) | raw (verbatim _raw — logs exactly as the app emitted them, including anything sensitive it logged). See the fields/dedupe/maxMessageChars params for projection, grouping, and the message-length cap.';

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
      'Group repeated messages within the RETURNED page by (level, signature) — timestamps/UUIDs/hex/numbers are normalized away — rendering "first_ts..last_ts LEVEL ×N message". Raise limit for broader grouping (only fetched rows are grouped). With detail:"raw", each group keeps one verbatim _raw exemplar.',
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
   * In-process detection memoization (§3, O1): positive detections only, short TTL,
   * LRU-capped. Dies with the process — no files in Phase 1.
   */
  const detectionCache = new DetectionCache();
  const detectDeps = (
    input: { timeZone?: string; byReceiptTime?: boolean },
    signal: AbortSignal | undefined,
  ) => ({
    api,
    timeZone: input.timeZone ?? config.defaultTimeZone,
    byReceiptTime: input.byReceiptTime,
    signal,
    cache: detectionCache,
  });

  interface ExactLevelResult {
    counts: Record<string, number>;
    /** Disclosed provenance, e.g. "log.severity". */
    provenance: string;
  }

  /**
   * Summary support (§6): detection picks the scope's severity field, then one extra
   * `count by <field>` aggregate yields EXACT whole-job counts (the fetched page is only
   * a sample). Returns undefined on any failure/no-signal — the summary then falls back
   * to a LOUDLY-labeled sample count. Best-effort by contract: never throws.
   */
  const fetchExactLevelCounts = async (
    input: { query: string; timeZone?: string; byReceiptTime?: boolean },
    range: { from: string | number; to: string | number },
    signal?: AbortSignal,
  ): Promise<ExactLevelResult | undefined> => {
    let aggId: string | undefined;
    try {
      const det = await detectSchema(detectDeps(input, signal), input.query, range);
      if (!det.primary) return undefined; // no-signal: keep the sample fallback
      let clause: string;
      let alias: string;
      let provenance: string;
      let mapKey: (v: string) => string;
      switch (det.primary.family) {
        case 'word': {
          const field = det.primary.field!;
          clause = ` | json field=_raw "${field}" as yz_lvl nodrop`;
          alias = 'yz_lvl';
          provenance = field;
          mapKey = (v) => normalizeLevel(v) ?? 'UNKNOWN';
          break;
        }
        case 'numeric':
          clause = ' | json field=_raw "log.severity" as yz_sev nodrop';
          alias = 'yz_sev';
          provenance = 'log.severity';
          mapKey = (v) => (v === '' ? '(none)' : coerceNumericDisplay(v));
          break;
        default:
          clause = TOKEN_CLASS_CLAUSE;
          alias = 'yz_tok';
          provenance = 'string token class';
          mapKey = (v) => (v === '' ? '(none)' : v);
      }
      const created = await api.create(
        {
          query: `${input.query}${clause} | count by ${alias}`,
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
        const key = mapKey(r.map[alias] ?? '');
        counts[key] = (counts[key] ?? 0) + Number(r.map['_count'] ?? 0);
      }
      return { counts, provenance };
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
              const exact = exactLevelCountsPromise ? await exactLevelCountsPromise : undefined;
              opts.exactLevelCounts = exact?.counts;
              opts.exactLevelProvenance = exact?.provenance;
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
        `The fastest way to see the SHAPE of matching logs before reading any messages: runs one small "count by <dimension>" aggregate per dimension (concurrently; every job auto-deleted) and returns a compact ranked table per dimension. Dimensions starting with "_" are native Sumo fields (e.g. _sourcecategory, _sourcehost); anything else is an ABSOLUTE JSON path from the _raw root (e.g. stream, log.levelname, log.status — dots allowed). A dimension that is 100% (none) probably does not exist at that path — run sumo_describe_schema to learn the scope's real fields. Numeric keys match numerically when filtering (num(x) = 404) — some producers emit float-strings like "404.0" (displayed coerced). One failing dimension yields an error line, never a total failure. ${timeRangeDoc}${sourceCategoryHint}`,
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
              if (!DIM_RE.test(dim)) {
                return {
                  dimension: dim,
                  error:
                    'invalid dimension — use a "_"-prefixed native field or an absolute JSON path from the _raw root (letters/digits/underscores, dots between segments).',
                };
              }
              // Non-"_" dims are ABSOLUTE paths from the _raw root (§10): `stream` reaches
              // the top-level envelope key; `log.levelname` the nested field. The alias is
              // the path with dots→underscores.
              const alias = dim.startsWith('_') ? dim : dim.replace(/\./g, '_');
              // `sort by _count` (desc) BEFORE limit — otherwise limit truncates unranked.
              const facetQuery = dim.startsWith('_')
                ? `${input.query} | count by ${dim} | sort by _count | limit ${limit}`
                : `${input.query} | json field=_raw "${dim}" as ${alias} nodrop | count by ${alias} | sort by _count | limit ${limit}`;
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
              const alias2 = dim.startsWith('_') ? dim : dim.replace(/\./g, '_');
              const rows = (page.records ?? []).map((r) => ({
                key: r.map[alias2] ?? '',
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
      title: 'Deduplicated error/warning digest for a scope (auto-detected severity)',
      description:
        `One-call triage: finds the scope's severity-signal messages, groups them by normalized signature (timestamps/UUIDs/hex/numbers stripped), and returns the top-N distinct problems with count, first/last occurrence, a sample request_id for cross-referencing, and the _sourcecategory. The severity filter is AUTO-DETECTED per scope (severity schemas VARY per system) and DISCLOSED in the output with a matched-N-of-M line — override with filter=; run sumo_describe_schema on a new/odd scope for paste-ready fragments. Cost: 2 search jobs (3 when string-payload categories are in scope; 1 with filter=), all auto-deleted. ${timeRangeDoc}${sourceCategoryHint}`,
      inputSchema: {
        query: z.string().min(1).optional()
          .describe(`Base scope query (default: _sourcecategory=${config.defaultSourceCategory ?? '<SUMO_DEFAULT_SOURCE_CATEGORY — not set>'}). Scope by _sourcecategory, NOT by a hostname keyword — errors/exceptions carry no hostname and would be silently excluded. The severity filter is appended automatically — do not add | operators.`),
        ...timeRangeShape,
        filter: z.string().min(1).optional()
          .describe('Optional raw Sumo fragment appended verbatim after the scope: keyword/paren terms (e.g. ("[error]" OR "[crit]")) or an operator chain starting with | (e.g. | json field=_raw "log.severity" as s nodrop | where num(s)>=3 or s="Fatal"). Supplying filter SKIPS auto-detection (exactly 1 search job) and is disclosed as agent-supplied. sumo_describe_schema proposes paste-ready fragments.'),
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
        const range = resolveRange(input, now);
        const agentFilter = input.filter?.trim();

        // Default flow (§4.2): detect, apply, disclose. filter= skips detection entirely.
        let det: Detection | undefined;
        let query: string;
        let usesNum = false;
        if (agentFilter !== undefined && agentFilter !== '') {
          query = appendFilter(base, agentFilter);
        } else {
          report?.('detecting severity schema');
          det = await detectSchema(detectDeps(input, extra.signal), base, range);
          if (det.predicate === undefined && det.scopeTotal === 0) {
            // Empty scope: a severity result would be a lie — say what this actually is.
            return ok(
              [
                'scope is EMPTY in this range: 0 messages matched the scope (a scope/range result, NOT "no errors").',
                'Check the range and the _sourcecategory spelling; consider byReceiptTime: true for recent windows.',
              ].join('\n'),
            );
          }
          query = det.predicate !== undefined ? `${base}${det.predicate}` : base; // §4.5: unfiltered fallback
          usesNum = det.usesNum;
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
        const matched = wait.status.messageCount ?? 0;

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

        // Disclosure block (§4.3) — every digest response carries one; no silent filtering.
        let disclosure: string;
        if (agentFilter !== undefined && agentFilter !== '') {
          disclosure = [
            `severity filter (agent-supplied): ${agentFilter}`,
            `  matched: ${nUS(matched)} messages (scope total not measured in filter= mode)`,
          ].join('\n');
        } else if (det!.predicate !== undefined) {
          disclosure = detectionDisclosure(det!, matched);
        } else {
          disclosure = noSignalDisclosure(det!.scopeTotal);
        }

        // Zero-match guardrail (§4.4): a filtered zero on a non-empty scope is never a bare
        // "(no matching messages)" — CALM when detection was confident (high field fill:
        // the scope is genuinely clean), LOUD when it was not (possible schema mismatch).
        let body: string;
        const filterApplied = (agentFilter !== undefined && agentFilter !== '') || det?.predicate !== undefined;
        if (matched === 0 && filterApplied) {
          if (det !== undefined) {
            const conf = confidentZeroFill(det);
            if (conf !== undefined) {
              body = calmZeroBlock(conf, det.scopeTotal);
            } else {
              const mLabel =
                det.cachedAgeMs !== undefined
                  ? `${nUS(det.scopeTotal)} messages at detection time, ${formatAge(det.cachedAgeMs)} ago (cached)`
                  : `${nUS(det.scopeTotal)} messages in range`;
              body = zeroMatchBlock(mLabel);
            }
          } else {
            body = ZERO_MATCH_UNKNOWN_M;
          }
        } else {
          body = renderDigest(
            {
              scanned: res.collected,
              topN: input.limit ?? 20,
              truncated: res.truncated || wait.truncated,
            },
            groups,
          );
        }

        const notes: string[] = [];
        if (wait.partial) notes.push('PARTIAL: wait timed out before completion — digest covers what was gathered so far.');
        const warns = annotateNumWarnings(realWarnings(wait.status), usesNum);
        if (warns.length > 0) notes.push(`warnings: ${warns.join(' | ')}`);
        const link = buildDeepLink(config.uiBaseUrl, query, range.fromMs, range.toMs);
        if (link) notes.push(`open in Sumo UI: ${link}`);
        return ok([disclosure, '', body, ...notes].join('\n'));
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

        // §6: summary polls get the SAME detection-driven exact side-aggregate as
        // run_search (concurrent with the main wait). Compact polls stay 1 job.
        const detail = input.detail ?? config.defaultDetail;
        const exactLevelCountsPromise =
          detail === 'summary'
            ? fetchExactLevelCounts(
                { query: input.query, timeZone: config.defaultTimeZone, byReceiptTime: true },
                { from, to },
                extra.signal,
              )
            : undefined;

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
          const opts = fmtOpts(input);
          if (opts.detail === 'summary') {
            const exact = exactLevelCountsPromise ? await exactLevelCountsPromise : undefined;
            opts.exactLevelCounts = exact?.counts;
            opts.exactLevelProvenance = exact?.provenance;
          }
          body = formatMessages(rows, opts, status);
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
        `Shows WHEN things happened: buckets matching messages with | timeslice, counts per bucket split into series (default: the scope's AUTO-DETECTED severity field, disclosed in the output), and renders one compact sparkline + per-bucket counts per series. Use it to spot spikes and onsets before reading messages. The query must be a plain scope — no | aggregation operators (timeslice/count are appended; jobs auto-deleted). ${timeRangeDoc}${sourceCategoryHint}`,
      inputSchema: {
        query: z.string().min(1)
          .describe('Sumo Logic scope query (keywords + metadata filters; no | aggregation operators).'),
        ...timeRangeShape,
        interval: z.string().optional().describe(
          'Bucket size, e.g. "30s", "5m", "1h" (units s/m/h/d). Default: auto — the smallest nice step giving ≤40 buckets over the window.',
        ),
        by: z.string().optional().describe(
          'Series dimension. "_"-prefixed = native Sumo field (e.g. _sourcecategory); "none" = one total series; anything else is an ABSOLUTE JSON path from the _raw root (dots allowed — e.g. stream, log.levelname). Omitted: the scope\'s auto-detected severity field (disclosed).',
        ),
        filter: z.string().min(1).optional().describe(
          'Optional raw Sumo fragment applied between the scope and the timeslice (same contract as sumo_error_digest\'s filter=) — e.g. trend ONLY the errors using a fragment sumo_describe_schema proposed. With filter= AND an explicit by=, no detection runs (exactly 1 job).',
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
        const report = progressReporter(extra);
        const range = resolveRange(input, now);
        const windowMs =
          range.fromMs !== undefined && range.toMs !== undefined ? range.toMs - range.fromMs : undefined;
        const intervalLabel = input.interval?.trim() || pickTrendInterval(windowMs);
        const intervalMs = parseLast(intervalLabel); // also validates an explicit interval
        const agentFilter = input.filter?.trim();

        // Series selection: explicit `by` (absolute path / native / none), or detection.
        let det: Detection | undefined;
        let seriesClause = '';
        let alias: string | undefined; // record column carrying the series key
        let byLabel: string;
        let normalizeAsLevel = false;
        const disclosures: string[] = [];

        if (input.by !== undefined) {
          const by = input.by;
          if (by === 'none') {
            byLabel = 'none';
          } else if (!DIM_RE.test(by)) {
            return fail(
              new Error(
                `Invalid series dimension "${by}" — use a "_"-prefixed native field, "none", or an absolute JSON path from the _raw root (dots allowed).`,
              ),
            );
          } else if (by.startsWith('_')) {
            alias = by;
            byLabel = by;
          } else {
            alias = by.replace(/\./g, '_');
            seriesClause = ` | json field=_raw "${by}" as ${alias} nodrop`;
            byLabel = by;
          }
        } else {
          report?.('detecting severity schema');
          det = await detectSchema(detectDeps(input, extra.signal), input.query, range);
          const cachedSuffix =
            det.cachedAgeMs !== undefined ? ` (detection cached, ${formatAge(det.cachedAgeMs)})` : '';
          switch (det.primary?.family) {
            case 'word': {
              const field = det.primary.field!;
              alias = 'yz_lvl';
              seriesClause = ` | json field=_raw "${field}" as yz_lvl nodrop`;
              byLabel = field;
              normalizeAsLevel = true;
              disclosures.push(
                `series (auto-detected): ${field} — word-level family; syntax only, semantics unverified. Override with by= / filter=.${cachedSuffix}`,
              );
              break;
            }
            case 'numeric':
              alias = 'yz_sev';
              seriesClause = ' | json field=_raw "log.severity" as yz_sev nodrop';
              byLabel = 'log.severity';
              disclosures.push(
                `series (auto-detected): log.severity — numeric family (log.type is a second-choice series); syntax only, semantics unverified. Override with by= / filter=.${cachedSuffix}`,
              );
              break;
            case 'string':
              alias = 'yz_tok';
              seriesClause = TOKEN_CLASS_CLAUSE;
              byLabel = 'token class';
              disclosures.push(
                `series (auto-detected): string-token class ([error]/[crit]/[warn]/other) — string-payload family; syntax only, semantics unverified. Override with by= / filter=.${cachedSuffix}`,
              );
              break;
            default:
              byLabel = 'none';
              disclosures.push(
                'series: none — no severity signal detected in this scope (trending the total). Run sumo_describe_schema to learn its fields, then pass by= / filter=.',
              );
          }
        }

        const scoped = agentFilter ? appendFilter(input.query, agentFilter) : input.query;
        const countBy = alias !== undefined ? `_timeslice, ${alias}` : '_timeslice';
        const query = `${scoped}${seriesClause} | timeslice ${intervalLabel} | count by ${countBy}`;

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
            const rawKey = alias === undefined ? 'all' : (r.map[alias] ?? '');
            const key = normalizeAsLevel ? (normalizeLevel(rawKey) ?? '') : rawKey;
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

        // Zero-data guardrail (§5.1): a filtered/detected trend with zero rows on a
        // non-empty scope must never render as a quiet "nothing happened".
        let body: string;
        if (rows.length === 0 && det !== undefined && det.predicate !== undefined && det.scopeTotal > 0) {
          const mLabel =
            det.cachedAgeMs !== undefined
              ? `${nUS(det.scopeTotal)} messages at detection time, ${formatAge(det.cachedAgeMs)} ago (cached)`
              : `${nUS(det.scopeTotal)} messages in range`;
          body = zeroMatchBlock(mLabel).replace('ZERO MATCHES from the severity filter', 'ZERO DATA POINTS from the trend series/filter');
        } else if (rows.length === 0 && agentFilter) {
          body = ZERO_MATCH_UNKNOWN_M.replace('ZERO MATCHES from the severity filter', 'ZERO DATA POINTS from the trend filter');
        } else {
          body = renderTrend(
            {
              fromLabel: fmtBound(range.from, range.fromMs),
              toLabel: fmtBound(range.to, range.toMs),
              intervalLabel,
              intervalMs,
              by: byLabel,
              maxSeries: input.maxSeries ?? 8,
            },
            rows,
          );
        }

        const notes: string[] = [];
        if (wait.truncated) notes.push('TRUNCATED: the scan hit the 100k message cap (FORCE PAUSED) — counts cover the scanned prefix.');
        if (wait.partial) notes.push('PARTIAL: wait timed out before completion — counts cover what was gathered so far.');
        const warns = realWarnings(wait.status);
        if (warns.length > 0) notes.push(`warnings: ${warns.join(' | ')}`);
        const link = buildDeepLink(config.uiBaseUrl, query, range.fromMs, range.toMs);
        if (link) notes.push(`open in Sumo UI: ${link}`);
        return ok([...disclosures, body, ...notes].join('\n'));
      } catch (err) {
        return fail(err);
      } finally {
        // SIGNAL-FREE cleanup (an aborted signal here would leak the job).
        if (jobId) await api.delete(jobId, { tolerateMissing: true }).catch(() => undefined);
      }
    },
  );

  // ------------------------------------------------------------- sumo_list_monitors
  const MONITOR_STATUSES = ['Critical', 'Warning', 'MissingData', 'Normal', 'Disabled'] as const;
  server.registerTool(
    'sumo_list_monitors',
    {
      title: 'List Sumo Logic Monitors (native alerting; read-only)',
      description:
        'Discovers the org\'s native Sumo Logic Monitors (the 24/7 prod alerting): name, folder path, type, enabled/disabled, current status, trigger types, and notification destinations. Read-only management-API call — no search jobs involved. Requires an access key with the "View Monitors" capability (without it Sumo returns HTTP 403). FOOTGUN: free-text `query` matching is NAME-ONLY, case-insensitive substring — folder paths are NOT searched (a folder name yields 0 even when monitors live under it). The query syntax also accepts monitorStatus:<Critical|Warning|MissingData|Normal|Disabled> (what the `status` param wraps). Fired-alert HISTORY is a different question — use sumo_list_alerts.',
      inputSchema: {
        query: z.string().min(1).optional()
          .describe('Filter text (Sumo monitors-search syntax). Matching is NAME-ONLY case-insensitive substring — folder paths are not searched.'),
        status: z.array(z.enum(MONITOR_STATUSES)).min(1).optional()
          .describe('Filter by current monitor status. The API has NO OR support — multiple statuses run one API call each, unioned client-side by monitor id.'),
        limit: z.number().int().min(1).max(1000).optional()
          .describe('Max monitors returned per API call (default 100).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      try {
        const limit = input.limit ?? 100;
        const statuses = input.status ?? [];
        const buildQuery = (status?: string) =>
          ['type:monitor', status !== undefined ? `monitorStatus:${status}` : undefined, input.query]
            .filter((p): p is string => p !== undefined)
            .join(' ');

        let hits: MonitorSearchHit[];
        if (statuses.length === 0) {
          hits = await monitors.search(buildQuery(), limit, extra.signal);
        } else {
          // No OR support in the API (live-verified: "monitorStatus:Critical OR
          // monitorStatus:Warning" returns 0) — one call per status, unioned by id.
          const results = await Promise.all(
            statuses.map((s) => monitors.search(buildQuery(s), limit, extra.signal)),
          );
          const seen = new Map<string, MonitorSearchHit>();
          for (const h of results.flat()) {
            const key = h.item?.id ?? `${h.path ?? ''}/${h.item?.name ?? ''}`;
            if (!seen.has(key)) seen.set(key, h);
          }
          hits = [...seen.values()];
        }

        const filtered = input.query !== undefined || statuses.length > 0;
        let total: number | undefined;
        if (filtered) {
          // One unfiltered call for the denominator (best-effort — header degrades to "?").
          total = await monitors
            .search('type:monitor', 1000, extra.signal)
            .then((all) => all.length)
            .catch(() => undefined);
        }

        const statusCount = (s: string) =>
          hits.filter((h) => !h.item?.isDisabled && (h.item?.status ?? []).includes(s)).length;
        const disabled = hits.filter((h) => h.item?.isDisabled === true).length;
        const summary = `${statusCount('Critical')} Critical, ${statusCount('Warning')} Warning, ${disabled} disabled`;

        if (hits.length === 0) {
          if (filtered) {
            return ok(
              `monitors: 0${total !== undefined ? `/${total}` : ''} matched (${total ?? '?'} exist unfiltered; matching is name-only, case-insensitive substring — folder paths are NOT searched). Try a shorter name fragment, drop the status filter, or call with no query.`,
            );
          }
          return ok('No monitors matched.');
        }

        const lines = [
          filtered
            ? `monitors: ${hits.length}/${total ?? '?'} matched — ${summary}`
            : `monitors: ${hits.length} — ${summary}`,
        ];
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

  // --------------------------------------------------------------- sumo_list_alerts
  server.registerTool(
    'sumo_list_alerts',
    {
      title: 'List fired alerts (history) from the System Event Index',
      description:
        `Fired-alert HISTORY — the complement to sumo_list_monitors (definitions + current state): queries the documented System Event Index (${ALERTS_INDEX_SCOPE}) through the standard Search Job API. The index is enabled and searchable by default on Enterprise accounts (the same tier the Search Job API already requires). Alert create and resolve are SEPARATE events — this tool correlates them into one line per fired alert: fired-at, resolved-at (when the resolve event is in range), latest trigger status, and the monitorId + monitor name JOIN KEYS back to sumo_list_monitors. One search job, auto-deleted. ${timeRangeDoc}`,
      inputSchema: {
        ...timeRangeShape,
        monitorQuery: z.string().min(1).optional()
          .describe('Keyword filter (e.g. a monitor-name fragment), matched full-text against the alert event JSON.'),
        status: z.array(z.string().min(1)).min(1).optional()
          .describe('Client-side filter on trigger states seen across an alert\'s events (e.g. ["Critical","Warning"]; case-insensitive).'),
        limit: z.number().int().min(1).max(500).optional()
          .describe('Max fired alerts returned (default 50).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      let jobId: string | undefined;
      try {
        const report = progressReporter(extra);
        const range = resolveRange(input, now);
        const kw = input.monitorQuery?.trim().replace(/"/g, '');
        // The `_index=` term MUST lead at the top level — nesting it in an OR group
        // silently matches nothing (live-verified).
        const query = `${ALERTS_INDEX_SCOPE}${kw ? ` "${kw}"` : ''}`;
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

        const events: AlertEvent[] = [];
        const res = await collectMessages(api, jobId, {
          max: 5000,
          pageSize: 1000,
          signal: extra.signal,
          onProgress: report ? (p) => report(`scanned ${p.collected} events`) : undefined,
          onPage: (page) => {
            for (const m of page.messages) {
              const e = parseAlertEvent(m.map);
              if (e) events.push(e);
            }
          },
        });

        let alerts = correlateAlertEvents(events);
        if (input.status !== undefined && input.status.length > 0) {
          const wanted = new Set(input.status.map((s) => s.toLowerCase()));
          alerts = alerts.filter(
            (a) =>
              a.statesSeen.some((s) => wanted.has(s.toLowerCase())) ||
              (a.lastStatus !== undefined && wanted.has(a.lastStatus.toLowerCase())),
          );
        }

        const fmtBound = (label: string | number, ms: number | undefined) =>
          ms !== undefined ? new Date(ms).toISOString() : String(label);
        const body = renderAlerts(alerts, {
          rangeLabel: `${fmtBound(range.from, range.fromMs)} .. ${fmtBound(range.to, range.toMs)}`,
          scannedEvents: res.collected,
          limit: input.limit ?? 50,
          statusFilter: input.status,
        });

        const notes: string[] = [];
        if (res.truncated) notes.push('TRUNCATED: event scan capped at 5000 — narrow the range for full coverage.');
        if (wait.partial) notes.push('PARTIAL: wait timed out before completion — events cover what was gathered so far.');
        const warns = realWarnings(wait.status);
        if (warns.length > 0) notes.push(`warnings: ${warns.join(' | ')}`);
        return ok([body, ...notes].join('\n'));
      } catch (err) {
        return fail(err);
      } finally {
        // SIGNAL-FREE cleanup (an aborted signal here would leak the job).
        if (jobId) await api.delete(jobId, { tolerateMissing: true }).catch(() => undefined);
      }
    },
  );

  // ----------------------------------------------------------- sumo_describe_schema
  server.registerTool(
    'sumo_describe_schema',
    {
      title: "Learn a scope's log schema in depth (propose-only)",
      description:
        `Thorough schema learner — the deep counterpart to the lite auto-detection inside sumo_error_digest/sumo_trend: STRATIFIED-samples the scope (per category × type/stream stratum, spread across message shapes — never first-N rows), enumerates top-level AND nested JSON keys (fill %, inferred types incl. float-strings, top values; arrays marked []), characterizes string payloads (format + severity-ish token hits) instead of returning an empty schema, breaks fields out per stratum, and closes with RANKED paste-ready severity fragments for the filter= param — each with honest caveats. It PROPOSES, never decides: it applies no filters and persists nothing; record what you confirm in your own memory. Use when a digest disclosed no-signal/zero-match or on first contact with a new system. Job budget: 2-4 aggregate jobs + 1-6 bounded page jobs, all auto-deleted. ${timeRangeDoc}${sourceCategoryHint}`,
      inputSchema: {
        query: z.string().min(1)
          .describe('Scope query (keywords + metadata filters; no | operators).'),
        ...timeRangeShape,
        sampleSize: z.number().int().min(10).max(1000).optional()
          .describe('Messages sampled for key enumeration (default 200, cap 1000).'),
        stratifyBy: z.string().min(1).optional()
          .describe('Explicit stratification field: an absolute JSON path from the _raw root (e.g. log.type, stream). Default: auto-detected (log.type, then stream, then category-only).'),
        maxDepth: z.number().int().min(1).max(8).optional()
          .describe('Nested-key flattening depth (default 4); arrays marked [].'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, extra): Promise<ToolResult> => {
      try {
        if (isAggregateQuery(input.query)) {
          return fail(
            new Error(
              'sumo_describe_schema needs a plain scope query (it appends its own aggregations). Drop the | operators.',
            ),
          );
        }
        if (input.stratifyBy !== undefined && !DIM_RE.test(input.stratifyBy)) {
          return fail(
            new Error(
              `Invalid stratifyBy "${input.stratifyBy}" — use an absolute JSON path from the _raw root (dots allowed).`,
            ),
          );
        }
        const report = progressReporter(extra);
        const range = resolveRange(input, now);
        report?.('detecting severity schema');
        const det = await detectSchema(detectDeps(input, extra.signal), input.query, range);
        const fmtBound = (label: string | number, ms: number | undefined) =>
          ms !== undefined ? new Date(ms).toISOString() : String(label);
        const text = await describeSchema(
          {
            api,
            timeZone: input.timeZone ?? config.defaultTimeZone,
            byReceiptTime: input.byReceiptTime,
            signal: extra.signal,
            onProgress: report,
          },
          det,
          {
            scope: input.query,
            range,
            rangeLabel: `${fmtBound(range.from, range.fromMs)} .. ${fmtBound(range.to, range.toMs)}`,
            sampleSize: input.sampleSize ?? 200,
            stratifyBy: input.stratifyBy,
            maxDepth: input.maxDepth ?? 4,
          },
        );
        return ok(text);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
