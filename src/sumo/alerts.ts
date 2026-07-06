/**
 * sumo_list_alerts support (v3 §15.2): fired-alert history from the documented, universal
 * **System Event Index** queried through the standard Search Job API — NEVER the
 * undocumented `/v1/alerts/search` REST endpoint (its schemas sit orphaned in Sumo's
 * OpenAPI spec with no published path).
 *
 * Two load-bearing facts (live-verified in the design doc):
 *  1. `_index=sumologic_system_events` must be a LEADING top-level term — nesting the
 *     `_index=` term in an OR group silently matches nothing.
 *  2. Create and resolve are SEPARATE events — "resolved-at" means correlating the two
 *     by alert identity, not one row per alert lifecycle.
 */

export const ALERTS_INDEX_SCOPE = '_index=sumologic_system_events _sourceCategory=alerts';

export interface AlertEvent {
  eventTimeMs: number;
  /** details.name, e.g. AlertCreated / AlertUpdated / AlertResolved (eventName fallback). */
  eventKind: string;
  /** resourceIdentity.id (type "Alert") — the correlation key across create/resolve. */
  alertId?: string;
  monitorId?: string;
  monitorName?: string;
  monitorPath?: string;
  /** Trigger state carried by this event (alertingGroup.currentState / triggerType-ish). */
  status?: string;
  creationTimeMs?: number;
  resolutionTimeMs?: number;
  isMuted?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string' || v === '') return undefined;
  if (/^\d{10,}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Tolerant parse of one system-event message (`_raw` JSON). Returns undefined on junk. */
export function parseAlertEvent(map: Record<string, string>): AlertEvent | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(map['_raw'] ?? '');
  } catch {
    return undefined;
  }
  if (!isRecord(obj)) return undefined;
  const details = isRecord(obj['details']) ? obj['details'] : {};
  const monitorInfo = isRecord(details['monitorInfo']) ? details['monitorInfo'] : {};
  const alerting = isRecord(details['alertingGroup']) ? details['alertingGroup'] : {};
  const resource = isRecord(obj['resourceIdentity']) ? obj['resourceIdentity'] : {};

  const eventTimeMs =
    toMs(obj['eventTime']) ?? toMs(map['_messagetime']) ?? toMs(map['_receipttime']);
  if (eventTimeMs === undefined) return undefined;

  return {
    eventTimeMs,
    eventKind: asString(details['name']) ?? asString(obj['eventName']) ?? 'unknown',
    alertId: asString(resource['id']),
    monitorId: asString(monitorInfo['monitorId']),
    monitorName: asString(monitorInfo['monitorName']) ?? asString(resource['name']),
    monitorPath: asString(monitorInfo['monitorPath']),
    status:
      asString(alerting['currentState']) ??
      asString(details['triggerType']) ??
      asString(details['alertStatus']),
    creationTimeMs: toMs(details['alertCreationTime']),
    resolutionTimeMs: toMs(details['alertResolutionTime']),
    isMuted: typeof details['isMuted'] === 'boolean' ? details['isMuted'] : undefined,
  };
}

export interface FiredAlert {
  alertId?: string;
  monitorId?: string;
  monitorName?: string;
  monitorPath?: string;
  firedAtMs?: number;
  resolvedAtMs?: number;
  /** State from the latest correlated event (e.g. Critical / Normal after resolve). */
  lastStatus?: string;
  /** Every state seen across the correlated events (status filtering matches any). */
  statesSeen: string[];
  isMuted?: boolean;
  events: number;
}

/** Correlate create/update/resolve events into one row per fired alert, newest first. */
export function correlateAlertEvents(events: AlertEvent[]): FiredAlert[] {
  const groups = new Map<string, AlertEvent[]>();
  for (const e of events) {
    const key = e.alertId ?? `${e.monitorId ?? '?'}:${e.creationTimeMs ?? e.eventTimeMs}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const alerts: FiredAlert[] = [];
  for (const [, g] of groups) {
    g.sort((a, b) => a.eventTimeMs - b.eventTimeMs);
    const creation = g.map((e) => e.creationTimeMs).filter((t): t is number => t !== undefined);
    const resolution = g.map((e) => e.resolutionTimeMs).filter((t): t is number => t !== undefined);
    const withStatus = [...g].reverse().find((e) => e.status !== undefined);
    alerts.push({
      alertId: g.find((e) => e.alertId)?.alertId,
      monitorId: g.find((e) => e.monitorId)?.monitorId,
      monitorName: g.find((e) => e.monitorName)?.monitorName,
      monitorPath: g.find((e) => e.monitorPath)?.monitorPath,
      firedAtMs: creation.length > 0 ? Math.min(...creation) : g[0]!.eventTimeMs,
      resolvedAtMs: resolution.length > 0 ? Math.max(...resolution) : undefined,
      lastStatus: withStatus?.status,
      statesSeen: [...new Set(g.map((e) => e.status).filter((s): s is string => !!s))],
      isMuted: g.some((e) => e.isMuted === true) ? true : g.find((e) => e.isMuted !== undefined)?.isMuted,
      events: g.length,
    });
  }
  return alerts.sort((a, b) => (b.firedAtMs ?? 0) - (a.firedAtMs ?? 0));
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1).replace(/\.0$/, '')}h`;
  return `${(s / 86_400).toFixed(1).replace(/\.0$/, '')}d`;
}

export interface RenderAlertsOptions {
  rangeLabel: string;
  scannedEvents: number;
  limit: number;
  statusFilter?: string[];
}

export function renderAlerts(alerts: FiredAlert[], opts: RenderAlertsOptions): string {
  const iso = (ms: number | undefined) => (ms !== undefined ? new Date(ms).toISOString() : '—');
  const lines: string[] = [];
  lines.push(
    `fired alerts: ${alerts.length} (correlated from ${opts.scannedEvents} create/resolve events in the System Event Index, ${opts.rangeLabel})` +
      (opts.statusFilter && opts.statusFilter.length > 0
        ? ` status filter: ${opts.statusFilter.join(',')}`
        : ''),
  );
  if (alerts.length === 0) {
    lines.push('(no fired alerts in this range — note: this reads alert EVENTS; an alert fired before the range with no events inside it will not appear)');
    return lines.join('\n');
  }
  const shown = alerts.slice(0, opts.limit);
  for (const a of shown) {
    const resolved =
      a.resolvedAtMs !== undefined
        ? `resolved=${iso(a.resolvedAtMs)}` +
          (a.firedAtMs !== undefined ? ` (${humanDuration(a.resolvedAtMs - a.firedAtMs)})` : '')
        : 'resolved=— (open, or resolved outside this range)';
    const parts = [
      `fired=${iso(a.firedAtMs)}`,
      resolved,
      `[${a.lastStatus ?? '?'}]`,
      a.monitorName ?? '?',
      `monitorId=${a.monitorId ?? '—'}`,
    ];
    if (a.monitorPath) parts.push(`path=${a.monitorPath}`);
    if (a.isMuted) parts.push('MUTED');
    lines.push(parts.join(' '));
  }
  if (alerts.length > shown.length) {
    lines.push(`(+${alerts.length - shown.length} more — raise limit or narrow the range)`);
  }
  lines.push(
    'join key: monitorId/monitor name → sumo_list_monitors (definitions + current state).',
  );
  return lines.join('\n');
}
