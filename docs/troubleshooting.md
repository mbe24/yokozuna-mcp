# Limits & troubleshooting

- **Server exits with `Missing required environment variable(s)`** — the env vars did not
  reach the process. The server does **not** read `.env` on its own: set them in the MCP
  client's `env` block, export them in the shell, or launch via `node --env-file=.env`.
- **HTTP 401** — wrong `SUMO_ACCESS_ID`/`SUMO_ACCESS_KEY` (or the key was revoked). Keys
  are region-bound: also check `SUMO_DEPLOYMENT`.
- **HTTP 301** = wrong deployment endpoint — the error message names the correct
  `SUMO_DEPLOYMENT` (parsed from the redirect `Location`).
- **HTTP 404 on a job** = the job expired server-side, was cancelled, or was deleted —
  re-create it. **Job ids do not survive a server restart** (the keepalive registry and
  session state are in-memory).
- **100,000 messages max** per search (`FORCE PAUSED` state = a non-aggregate query hit
  the cap; results are available but truncated — split the time range).
- **10,000 per page** max; requesting more silently returns exactly 10,000.
- **Rate limits**: 4 requests/s, 10 concurrent per key, 200 active search jobs per org.
  The server rate-limits itself and always deletes finished jobs.
- **Aggregate vs non-aggregate**: records ↔ messages are mutually exclusive per job; a
  mismatched fetch returns 400. The tools detect this and route (or tell you which tool
  to use).
- **Ingestion lag**: logs appear minutes after they happen. Wait a few minutes and/or set
  `byReceiptTime: true` for windows covering the last few minutes — it surfaces more
  recent logs.
- **No results but the query looks right** — check the time range, the exact
  `_sourcecategory` spelling, and ingestion lag; the 0-result response lists any server
  warnings (e.g. unknown partition).
- Jobs created via `sumo_create_search_job` (or `keepJob: true`) are background-polled
  (kept alive) by the server and auto-deleted after `YOKOZUNA_KEEPALIVE_IDLE_MINUTES`
  (default 10) minutes idle; any access (status/messages/records) resets the idle timer.
  At most `YOKOZUNA_KEEPALIVE_MAX_JOBS` (default 20) jobs are tracked — beyond that the
  stalest is evicted from keepalive (logged to stderr with its job id). Delete jobs
  explicitly when done.
- `sumo_run_search` that shows fewer messages than `messageCount` includes a hint: raise
  `limit` (max 5000), or re-run with `keepJob: true` and page via `sumo_get_messages`
  `offset`/`limit`.
