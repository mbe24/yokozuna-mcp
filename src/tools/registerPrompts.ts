import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';

/**
 * MCP prompts. The `triage` prompt carries the full query cookbook that used to live
 * in the sumo_run_search tool description — moving it here removes its per-call token
 * cost (tool descriptions ship with EVERY request; a prompt only when invoked).
 * In Claude Code it surfaces as /mcp__<server>__triage.
 */
export function registerPrompts(server: McpServer, config: Config): void {
  const scope = config.defaultSourceCategory ?? 'kubernetes/myservice/*/backend';

  server.registerPrompt(
    'triage',
    {
      title: 'Log triage: summary → narrow → trace',
      description:
        'Guided Sumo Logic log-triage workflow (shape first, then messages, then a request trace) with the full query cookbook.',
      argsSchema: {
        problem: z
          .string()
          .optional()
          .describe('What to investigate: symptom, deployment/preview URL, request id, rough time.'),
      },
    },
    ({ problem }) => ({
      description: 'Sumo Logic log triage workflow',
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: buildTriageText(scope, problem),
          },
        },
      ],
    }),
  );
}

function buildTriageText(scope: string, problem: string | undefined): string {
  const header = problem
    ? `Investigate this using the Sumo Logic MCP tools: ${problem}\n\n`
    : 'Triage the current problem using the Sumo Logic MCP tools.\n\n';
  return `${header}WORKFLOW (cheapest first — keep tokens lean):
1. SHAPE: sumo_facets (where do matching logs come from; which categories/hosts dominate) and/or sumo_trend (WHEN did it start/spike). Use detail:"summary" on sumo_run_search for exact whole-job counts + histogram.
2. NARROW: sumo_error_digest for a deduplicated "what is broken" list (top signatures with counts, first/last seen, sample request_id). Then sumo_run_search with detail:"compact" to read the few messages that matter.
3. TRACE: pick a request_id and run a NEW sumo_run_search with JUST the quoted id and NO other filter — ids are full-text indexed. Results default to oldest→newest for chronological reading.
4. BULK: sumo_export_results streams everything (chronological NDJSON, up to 100k lines) to a file for offline analysis — never raise inline limits for bulk.
5. WATCH: sumo_new_since polls for new matches (pass the returned cursor as \`since\` each call).

HOW TO SCOPE (free-text matches the RAW log text — guessing code identifiers usually matches nothing):
- WHERE: _sourcecategory=<path> (e.g. ${scope}) is the primary scope. Discover categories from the [brackets] in results or sumo_facets.
- WHICH ENV: add the deployment hostname as a keyword (e.g. "www.example.com") — CAVEAT: hostname keywords match only request logs (the hostname lives in the request-URL field); startup/worker lines and most errors/exceptions carry NO hostname and get excluded. Hunt errors by _sourcecategory, never by hostname keyword.
- SEVERITY: schemas VARY per system (word levels like log.levelname; numeric tiers like log.severity 1-4 with typed exception rows; plain-string payloads where "[error]" tokens or stderr are the only signal). sumo_error_digest auto-detects and DISCLOSES what it applied — read the disclosure and the matched-N-of-M line. For a new/odd scope run sumo_describe_schema, judge its proposed fragments (syntax is detectable; whether a signal is a real incident is YOUR judgment), record what you confirm in your own memory, and pass filter= on later calls.
- COUNT by severity: use detail:"summary" (exact whole-job counts by the detected field).
- EXCLUDE noise: ${scope} !"health check"
- ONE REQUEST: search the quoted id alone, e.g. "74ec29d7-3420-41f9-8a71-4d91f0b263a6" — other correlation keys (client_ip, account/app ids) work the same way.
- NESTED FIELDS: pass extract to sumo_run_search / sumo_export_results, e.g. {"status":"log.status"} — the server appends one | json clause per field (the comma multi-extract form is broken in Sumo).
- FRESH LOGS: set byReceiptTime: true for windows covering the last few minutes (ingestion lag).

Report findings with timestamps, levels, request_ids, and the Sumo UI deep links the tools return.`;
}
