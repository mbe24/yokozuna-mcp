import { describe, expect, it } from 'vitest';
import {
  ALERTS_INDEX_SCOPE,
  correlateAlertEvents,
  parseAlertEvent,
  renderAlerts,
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
