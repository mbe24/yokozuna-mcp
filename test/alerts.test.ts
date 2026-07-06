import { describe, expect, it } from 'vitest';
import {
  ALERTS_INDEX_SCOPE,
  collapseDuplicateAlerts,
  correlateAlertEvents,
  filterAlertsByStatus,
  parseAlertEvent,
  renderAlerts,
  type FiredAlert,
} from '../src/sumo/alerts.js';

const eventRaw = (over: {
  time: string;
  name: string;
  alertId?: string;
  monitorId?: string;
  monitorName?: string;
  creation?: string;
  resolution?: string;
  state?: string;
  muted?: boolean;
}) =>
  JSON.stringify({
    eventType: 'System',
    eventName: 'AlertSystemInfo',
    eventTime: over.time,
    subsystem: 'alerts',
    resourceIdentity: { id: over.alertId ?? 'A1', name: over.monitorName ?? 'CPU high', type: 'Alert' },
    details: {
      name: over.name,
      isMuted: over.muted ?? false,
      alertCreationTime: over.creation,
      alertResolutionTime: over.resolution,
      monitorInfo: {
        monitorId: over.monitorId ?? 'M1',
        monitorName: over.monitorName ?? 'CPU high',
        monitorPath: '/Monitor/CPU high',
      },
      alertingGroup: { previousState: 'Normal', currentState: over.state ?? 'Critical' },
    },
  });

describe('parseAlertEvent', () => {
  it('extracts the join keys, times, and state from a system event', () => {
    const e = parseAlertEvent({
      _messagetime: String(Date.parse('2026-07-01T10:00:01Z')),
      _raw: eventRaw({ time: '2026-07-01T10:00:00Z', name: 'AlertCreated', creation: '2026-07-01T10:00:00Z' }),
    })!;
    expect(e.monitorId).toBe('M1');
    expect(e.monitorName).toBe('CPU high');
    expect(e.alertId).toBe('A1');
    expect(e.eventKind).toBe('AlertCreated');
    expect(e.status).toBe('Critical');
    expect(e.creationTimeMs).toBe(Date.parse('2026-07-01T10:00:00Z'));
  });

  it('tolerates junk rows (returns undefined, never throws)', () => {
    expect(parseAlertEvent({ _raw: 'not json' })).toBeUndefined();
    expect(parseAlertEvent({ _raw: '42' })).toBeUndefined();
    expect(parseAlertEvent({})).toBeUndefined();
  });
});

describe('correlateAlertEvents (create and resolve are SEPARATE events)', () => {
  it('correlates create + resolve into one alert with fired-at and resolved-at', () => {
    const events = [
      parseAlertEvent({ _raw: eventRaw({ time: '2026-07-01T10:00:00Z', name: 'AlertCreated', creation: '2026-07-01T10:00:00Z' }) })!,
      parseAlertEvent({
        _raw: eventRaw({
          time: '2026-07-01T10:20:00Z',
          name: 'AlertResolved',
          creation: '2026-07-01T10:00:00Z',
          resolution: '2026-07-01T10:20:00Z',
          state: 'Normal',
        }),
      })!,
    ];
    const alerts = correlateAlertEvents(events);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.firedAtMs).toBe(Date.parse('2026-07-01T10:00:00Z'));
    expect(alerts[0]!.resolvedAtMs).toBe(Date.parse('2026-07-01T10:20:00Z'));
    expect(alerts[0]!.lastStatus).toBe('Normal');
    expect(alerts[0]!.statesSeen).toEqual(['Critical', 'Normal']);
    expect(alerts[0]!.events).toBe(2);
  });

  it('keeps distinct alert ids separate and sorts newest-fired first', () => {
    const alerts = correlateAlertEvents([
      parseAlertEvent({ _raw: eventRaw({ time: '2026-07-01T10:00:00Z', name: 'AlertCreated', creation: '2026-07-01T10:00:00Z' }) })!,
      parseAlertEvent({
        _raw: eventRaw({ time: '2026-07-02T09:00:00Z', name: 'AlertCreated', alertId: 'A2', monitorId: 'M2', monitorName: 'Disk', creation: '2026-07-02T09:00:00Z' }),
      })!,
    ]);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]!.monitorId).toBe('M2'); // newest first
  });
});

describe('renderAlerts', () => {
  it('renders join keys, duration, and the open-alert placeholder', () => {
    const alerts = correlateAlertEvents([
      parseAlertEvent({ _raw: eventRaw({ time: '2026-07-01T10:00:00Z', name: 'AlertCreated', creation: '2026-07-01T10:00:00Z' }) })!,
    ]);
    const out = renderAlerts(alerts, { rangeLabel: 'a .. b', scannedEvents: 1, limit: 50 });
    expect(out).toContain('fired alerts: 1');
    expect(out).toContain('monitorId=M1');
    expect(out).toContain('resolved=— (open, or resolved outside this range)');
    expect(out).toContain('sumo_list_monitors');
  });

  it('the empty case explains the event-window semantics instead of implying "no alerts ever"', () => {
    const out = renderAlerts([], { rangeLabel: 'a .. b', scannedEvents: 0, limit: 50 });
    expect(out).toContain('no fired alerts in this range');
    expect(out).toContain('EVENTS');
  });

  it('the index scope constant is the documented one with _index leading', () => {
    expect(ALERTS_INDEX_SCOPE).toBe('_index=sumologic_system_events _sourceCategory=alerts');
  });
});

const firedAlert = (over: Partial<FiredAlert>): FiredAlert => ({
  monitorId: 'M1',
  firedAtMs: 1_000_000,
  lastStatus: 'Normal',
  statesSeen: ['Critical', 'Normal'],
  events: 2,
  instances: 1,
  ...over,
});

describe('filterAlertsByStatus (§0.2.1 #1 — latest vs ever)', () => {
  const resolvedCritical = firedAlert({ lastStatus: 'Normal', statesSeen: ['Critical', 'Normal'] });
  const openCritical = firedAlert({ monitorId: 'M2', lastStatus: 'Critical', statesSeen: ['Critical'] });

  it('"latest" matches the current state only — a resolved Critical (now Normal) is excluded', () => {
    const out = filterAlertsByStatus([resolvedCritical, openCritical], ['Critical'], 'latest');
    expect(out).toHaveLength(1);
    expect(out[0]!.monitorId).toBe('M2');
  });

  it('"ever" restores lifetime behavior — the resolved Critical matches again', () => {
    const out = filterAlertsByStatus([resolvedCritical, openCritical], ['Critical'], 'ever');
    expect(out).toHaveLength(2);
  });

  it('is case-insensitive', () => {
    expect(filterAlertsByStatus([openCritical], ['critical'], 'latest')).toHaveLength(1);
  });
});

describe('collapseDuplicateAlerts (§0.2.1 #3)', () => {
  it('collapses same-monitor instances fired within the window into one ×N row', () => {
    const alerts: FiredAlert[] = [
      firedAlert({ monitorId: 'M1', firedAtMs: 1_000_000, resolvedAtMs: 1_030_000, lastStatus: 'Normal' }),
      firedAlert({ monitorId: 'M1', firedAtMs: 1_000_003, resolvedAtMs: 1_090_000, lastStatus: 'Normal' }),
      firedAlert({ monitorId: 'M1', firedAtMs: 1_000_004, resolvedAtMs: undefined, lastStatus: 'Critical' }),
    ];
    const out = collapseDuplicateAlerts(alerts);
    expect(out).toHaveLength(1);
    expect(out[0]!.instances).toBe(3);
    expect(out[0]!.firedAtMs).toBe(1_000_000); // earliest
    expect(out[0]!.resolvedAtMs).toBeUndefined(); // one instance still open
    expect(out[0]!.events).toBe(6);
  });

  it('does NOT collapse instances fired more than the window apart', () => {
    const out = collapseDuplicateAlerts([
      firedAlert({ monitorId: 'M1', firedAtMs: 1_000_000 }),
      firedAlert({ monitorId: 'M1', firedAtMs: 1_000_000 + 6_000 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((a) => a.instances === 1)).toBe(true);
  });

  it('never collapses across different monitors', () => {
    const out = collapseDuplicateAlerts([
      firedAlert({ monitorId: 'M1', firedAtMs: 1_000_000 }),
      firedAlert({ monitorId: 'M2', firedAtMs: 1_000_001 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('renderAlerts shows the ×N instances annotation and the status-scope label', () => {
    const out = renderAlerts(
      [firedAlert({ monitorId: 'M1', firedAtMs: 1_000_000, resolvedAtMs: undefined, lastStatus: 'Critical', instances: 4 })],
      { rangeLabel: 'a .. b', scannedEvents: 8, limit: 50, statusFilter: ['Critical'], statusScope: 'latest' },
    );
    expect(out).toContain('×4 instances');
    expect(out).toContain('latest state');
  });
});
