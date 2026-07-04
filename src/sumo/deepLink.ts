/**
 * Sumo UI deep link (officially documented "Use a URL to Run a Search"):
 *   <uiBase>/log-search/create?query=<enc>&startTime=<ms>&endTime=<ms>
 * `uiBase` is the org UI origin (Config.uiBaseUrl) — either the deployment default
 * (service.<code>.sumologic.com) or a company host set via SUMO_UI_BASE_URL
 * (e.g. https://myorg.eu.sumologic.com). startTime/endTime are epoch milliseconds.
 * The viewer must already be logged in to that deployment. Returns undefined when the
 * UI base is unknown (custom endpoint, no override) or the time range is not in epoch ms.
 */
export function buildDeepLink(
  uiBase: string | undefined,
  query: string,
  fromMs: number | undefined,
  toMs: number | undefined,
): string | undefined {
  if (!uiBase || fromMs === undefined || toMs === undefined) return undefined;
  const params = new URLSearchParams({
    query,
    startTime: String(fromMs),
    endTime: String(toMs),
  });
  return `${uiBase}/log-search/create?${params.toString()}`;
}
