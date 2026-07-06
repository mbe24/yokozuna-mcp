# Monitoring

Three complementary surfaces: a stateless polling cursor for *your* ad-hoc watch
(`sumo_new_since`), the org's configured 24/7 alerting (`sumo_list_monitors`), and the
history of alerts that actually fired (`sumo_list_alerts`).

## Polling with `sumo_new_since`

Stateless monitoring — e.g. "tell me when new errors show up in the preview deployment":

1. First call — baseline (no `since`):

    ```json
    { "query": "_sourcecategory=kubernetes/myservice/*/backend \"myservice-preview.dev.example.com\"", "lookback": "15m" }
    ```

    The response starts with a header plus a cursor line like `cursor=1783017420000`.

2. Every following call passes the last cursor as `since`:

    ```json
    { "query": "_sourcecategory=kubernetes/myservice/*/backend \"myservice-preview.dev.example.com\"", "since": 1783017420000 }
    ```

    Windows are half-open `[since, now − settle margin)` over **receipt time**
    (`byReceiptTime` is forced), so consecutive calls tile with no gaps and no duplicates —
    the server keeps **no state**; the cursor in your hand is everything.

!!! note "Freshness"
    Results trail real time by the settle margin (default **180 s**,
    `YOKOZUNA_SETTLE_MARGIN_SECONDS`) so logs that arrive late are not skipped —
    *complete but ~3 minutes stale*. Polling faster than the margin just returns a
    "not settled yet" note with the cursor unchanged (no job is created).

In Claude Code this pairs well with `/loop`, e.g.:
`/loop 5m check sumo_new_since for new backend errors (keep passing the returned cursor as since) and summarize anything new`.
Aggregate queries (`| count …`) are rejected — use `sumo_run_search` for those.

## Native Sumo Monitors: `sumo_list_monitors`

`sumo_list_monitors` (read-only) lists the org's native Sumo Monitors for discovering
what 24/7 prod alerting already exists — a summary header plus name, folder path, type,
enabled/disabled, current status, trigger types, and notification destinations. It needs
the **View Monitors** capability on the access key and creates no search jobs. Filter by
`status` (e.g. `["Critical","Warning"]` — one API call per status, unioned client-side;
the API has no OR). Footgun: free-text `query` matching is **name-only, case-insensitive
substring** — folder paths are not searched.

## Fired-alert history: `sumo_list_alerts`

`sumo_list_alerts` complements it with **fired-alert history**: it queries the
documented System Event Index (`_index=sumologic_system_events _sourceCategory=alerts`,
enabled by default on Enterprise accounts) through the ordinary Search Job API and
correlates the separate create/resolve events into one line per fired alert — fired-at,
resolved-at, latest status, and the `monitorId` + monitor-name join keys back to
`sumo_list_monitors`.

The `status` filter matches the alert's **latest** state by default; pass
`statusScope: "ever"` to match any state the alert has passed through. Near-simultaneous
duplicate instances of the same monitor (fired within ≤5s) are collapsed into one row
annotated `×N instances`.
