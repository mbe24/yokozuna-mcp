# Querying & schema-learning

## How to scope a search (read this first)

Free-text terms match the **raw log text** (`_raw`), so guessing at source-code
identifiers — Java/Python class names, function names — is unreliable and usually matches
nothing. Scope and filter using these instead:

- **Where**: `_sourcecategory=<path>` (e.g. `kubernetes/myservice/*/backend`) — the primary
  scoping dimension. Discover categories from the `[in brackets]` in any result line, or
  with `| count by _sourcecategory`.
- **Which environment**: add the deployment **hostname as a keyword** (matches the
  request-URL field) — but see the request-logs-only caveat below.
- **Severity**: schemas **vary per system** — let `sumo_error_digest` auto-detect (see
  the workflow below), or learn the scope with `sumo_describe_schema` and pass `filter=`.
- **A specific request/entity**: the `request_id` (or any correlation key your logs
  carry, e.g. `session_id`, `client_ip`) as a quoted keyword.

Nested JSON payload fields are parsed with `| json field=_raw "<absolute.path>" as <alias>
nodrop` (one clause per field); discover which paths exist with `sumo_describe_schema`
or `sumo_facets`.

## The real workflow, by example

1. **Search by preview deployment URL / hostname keyword** (wait a few minutes for
   ingestion; use `byReceiptTime: true` for very recent windows):

    ```
    _sourcecategory=kubernetes/myservice/*/backend "myservice-preview.dev.example.com"
    ```

    !!! warning "Hostname-keyword caveat"
        A hostname keyword matches only *request* logs (the hostname lives in
        `log.request_url`) — startup/Celery/Redis lines and most **errors/exceptions
        carry no hostname** and get excluded (live-verified: a host-keyword error search
        returned 0 while the same search by `_sourcecategory` found them). Hunt errors by
        `_sourcecategory`, never by hostname keyword.

2. **Errors/warnings** — severity schemas **vary per system**: some emit word levels
   (`log.levelname`), some numeric tiers plus typed exception rows (`log.severity`,
   `log.type`), some plain-string payloads where an `[error]` token or stderr is the only
   signal. Don't guess — run:

    ```
    sumo_error_digest { "query": "_sourcecategory=kubernetes/myservice/*/backend", "last": "2h" }
    ```

    It detects the scope's signal, applies it, and **discloses** the predicate plus a
    matched-N-of-M line. If the disclosure says no-signal/zero-match (or the matches look
    like noise), run `sumo_describe_schema` on the scope, pick/edit one of its paste-ready
    fragments, confirm the semantics yourself, and pass it as `filter=` — then record the
    confirmed fragment in your own notes for next time.

    Count by severity: `detail:"summary"` on `sumo_run_search` (exact whole-job counts by
    the detected field). Exclude noise with negation:

    ```
    _sourcecategory=kubernetes/myservice/*/backend !"health check"
    ```

3. **Cross-reference / trace one request**: take the `req=` id from any result line and
   run a **new search with just the quoted id and NO source/host filter** — ids are
   full-text indexed even though they live inside `_raw`:

    ```
    "74ec29d7-3420-41f9-8a71-4d91f0b263a6"
    ```

    Other correlation keys (e.g. `session_id`, `client_ip`) work the same way.
    Results are returned oldest→newest by default (`sort: "asc"`), so the trace reads
    chronologically. Remember the hostname caveat above: don't add a hostname keyword when
    the trace may include errors.

4. **Export everything for a coding agent**: call `sumo_export_results` with the same
   query and a wider window — it streams flattened NDJSON to a file (chronological,
   oldest→newest) and returns the path.

## Learning a schema and remembering it (the `filter=` workflow)

Schemas are learned per scope, semantics are YOURS to confirm — the intended loop:

1. Meet a new scope → `sumo_error_digest` auto-detects; read the disclosure block.
2. If detection was wrong or insufficient (zero-match guardrail, no-signal, or the
   matched signatures look like noise) → run `sumo_describe_schema` on the scope and
   judge its ranked, paste-ready fragments. Syntax is detectable; whether a signal is a
   real incident (e.g. `[error]` lines that are all scanner probes) is a judgment call.
3. **Record confirmed semantics in your own memory** (CLAUDE.md / auto-memory / project
   notes), e.g. *"scope `kubernetes/foo/*`: real errors are
   `| json field=_raw "log.severity" as s nodrop | where num(s)>=3 or s="Fatal"`;
   `[error]` on the frontend scope is scanner noise"*.
4. On later calls pass `filter=` from your memory — the MCP itself stays stateless
   (only an in-process, ~12-minute detection memo exists; disclosed as
   `(detection cached, <age>)`).
