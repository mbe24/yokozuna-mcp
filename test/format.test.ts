import { describe, expect, it } from 'vitest';
import {
  coerceNumericDisplay,
  fallbackDigestLevel,
  fixedPointNumberDisplay,
  flattenMessage,
  isCookieNoiseWarning,
  normalizeLevel,
} from '../src/format/flatten.js';
import { accumulateDigest, renderDigest, type DigestGroup } from '../src/format/renderDigest.js';
import { renderFacets } from '../src/format/renderFacets.js';
import { formatMessages, signature, sortRowsByMessageTime } from '../src/format/formatMessages.js';
import { formatRecords } from '../src/format/formatRecords.js';
import type { ResultRow, SearchJobStatus } from '../src/sumo/types.js';

const WARNING_MESSAGE =
  'failed to create user due to already existing account: jane.doe@example.com';

/** Realistic sample mirroring the live EU shape (lowercase metadata, log.* inside _raw). */
const sampleRaw = JSON.stringify({
  stream: 'stderr',
  timestamp: 1783017533330,
  log: {
    lineno: 298,
    method: 'POST',
    path: '/api/users',
    status: 409,
    duration_s: '0.031',
    timestamp: '2026-07-02T18:38:53.329889Z',
    logger: 'context_logger',
    request_url: 'http://myservice-preview.dev.example.com/api/users',
    pathname: '/app/app/app_factory.py',
    greenlet_id: '139854456166400',
    levelname: 'WARNING',
    request_id: 'caa722fc-3420-41f9-8a71-4d91f0b263a6',
    message: WARNING_MESSAGE,
    level: 'warning',
    headers: '{"User-Agent":"x","Cookie":"big"}',
    data: '{"huge":"blob"}',
  },
});

const sampleRow: ResultRow = {
  map: {
    _messagetime: '1783017533330',
    _receipttime: '1783017534000',
    _sourcecategory: 'kubernetes/myservice/backend',
    _sourcehost: 'ip-10-0-0-1',
    _sourcename: 'x.log',
    _collector: 'k8s',
    _loglevel: 'WARNING',
    _view: '',
    _raw: sampleRaw,
  },
};

const baseOpts = {
  detail: 'compact' as const,
  maxMessageChars: 10_000,
  format: 'text' as const,
};

describe('flattenMessage', () => {
  it('parses _raw and promotes log.* fields (request_id, levelname are NOT top-level)', () => {
    const f = flattenMessage(sampleRow.map);
    expect(f.requestId).toBe('caa722fc-3420-41f9-8a71-4d91f0b263a6');
    expect(f.level).toBe('WARNING');
    expect(f.sourceCategory).toBe('kubernetes/myservice/backend');
    expect(f.message).toBe(WARNING_MESSAGE);
    expect(f.fields['method']).toBe('POST');
    expect(f.fields['status']).toBe('409');
  });

  it('all map values are strings (stringly-typed API contract)', () => {
    for (const v of Object.values(sampleRow.map)) expect(typeof v).toBe('string');
    const f = flattenMessage(sampleRow.map);
    expect(typeof f.fields['lineno']).toBe('string'); // numeric in _raw, still emitted as string
  });

  it('degrades gracefully on non-JSON _raw', () => {
    const f = flattenMessage({ _raw: 'plain text line, no JSON here' });
    expect(f.message).toBe('plain text line, no JSON here');
    expect(f.requestId).toBeUndefined();
  });

  it('degrades gracefully on empty-string (nodrop) values and missing fields', () => {
    const f = flattenMessage({ _raw: '', _loglevel: '', _sourcecategory: '' });
    expect(f.level).toBeUndefined();
    expect(f.sourceCategory).toBeUndefined();
    expect(f.message).toBe('');
  });

  it('handles double-encoded JSON _raw', () => {
    const f = flattenMessage({ _raw: JSON.stringify(sampleRaw) });
    expect(f.message).toBe(WARNING_MESSAGE);
  });

  it('prefers log.levelname over _loglevel (which is empty on most warnings)', () => {
    const f = flattenMessage({
      _loglevel: 'INFO', // wrong/cheap signal
      _raw: JSON.stringify({ log: { levelname: 'WARNING', message: 'x' } }),
    });
    expect(f.level).toBe('WARNING');
  });

  it('falls back to _loglevel then level when levelname is missing, aliasing WARN→WARNING', () => {
    expect(flattenMessage({ _loglevel: 'WARN', _raw: '{}' }).level).toBe('WARNING');
    expect(
      flattenMessage({ _raw: JSON.stringify({ log: { level: 'warning', message: 'x' } }) }).level,
    ).toBe('WARNING');
  });

  it('normalizeLevel uppercases and aliases WARN', () => {
    expect(normalizeLevel('warn')).toBe('WARNING');
    expect(normalizeLevel('error')).toBe('ERROR');
    expect(normalizeLevel('')).toBeUndefined();
    expect(normalizeLevel(undefined)).toBeUndefined();
  });
});

describe('formatMessages – detail levels', () => {
  it('compact text keeps the COMPLETE message + core fields + request triage, drops heavy fields', () => {
    const out = formatMessages([sampleRow], baseOpts);
    expect(out).toContain(WARNING_MESSAGE); // untruncated
    expect(out).toContain('WARNING');
    expect(out).toContain('req=caa722fc-3420-41f9-8a71-4d91f0b263a6');
    expect(out).toContain('[kubernetes/myservice/backend]');
    expect(out).toContain('method=POST'); // request fields now compact-visible
    expect(out).toContain('path=/api/users');
    expect(out).toContain('status=409');
    expect(out).not.toContain('User-Agent'); // headers dropped
    expect(out).not.toContain('huge'); // data dropped
    expect(out).not.toContain('duration_s='); // full-only field
    expect(out).not.toContain('logger='); // full-only field
  });

  it('compact falls back to pathname when path is absent, and omits absent request fields', () => {
    const row: ResultRow = {
      map: {
        _raw: JSON.stringify({
          log: { levelname: 'INFO', message: 'boot', pathname: '/app/app/worker.py' },
        }),
      },
    };
    const out = formatMessages([row], baseOpts);
    expect(out).toContain('path=/app/app/worker.py');
    expect(out).not.toContain('method=');
    expect(out).not.toContain('status=');
  });

  it('ndjson compact includes method/path/status only when present', () => {
    const out = formatMessages([sampleRow], { ...baseOpts, format: 'ndjson' });
    const obj = JSON.parse(out);
    expect(obj.method).toBe('POST');
    expect(obj.path).toBe('/api/users');
    expect(obj.status).toBe('409');
    expect(obj.duration_s).toBeUndefined(); // full-only
  });

  it('full includes method/path/status/duration_s/logger/client_ip; compact stops at status', () => {
    const out = formatMessages([sampleRow], { ...baseOpts, detail: 'full' });
    expect(out).toContain('method=POST');
    expect(out).toContain('path=/api/users');
    expect(out).toContain('status=409');
    expect(out).toContain('duration_s=0.031');
    expect(out).toContain('logger=context_logger');
    expect(out).not.toContain('headers='); // still dropped
  });

  it('summary emits per-level counts, top signatures, histogram — and NO per-message dump', () => {
    const status: SearchJobStatus = {
      state: 'DONE GATHERING RESULTS',
      messageCount: 2,
      recordCount: 0,
      pendingWarnings: [],
      pendingErrors: [],
      histogramBuckets: [
        { startTimestamp: 1783017530000, length: 60000, count: 2, logLevel: null },
      ],
    };
    const out = formatMessages([sampleRow, sampleRow], { ...baseOpts, detail: 'summary' }, status);
    expect(out).toContain('WARNING: 2');
    expect(out).toContain('top message signatures');
    expect(out).toContain('×2 WARNING'); // grouped signature count
    expect(out).toContain('histogram (1 buckets ×60s');
    expect(out).not.toMatch(/— sample/); // sample == whole job here, so no sample label
  });

  it('summary prefers exact whole-job level counts when provided, and labels sample sections', () => {
    const status: SearchJobStatus = {
      state: 'DONE GATHERING RESULTS',
      messageCount: 500, // more than the 2 sampled → sample labels required
      recordCount: 0,
      pendingWarnings: [],
      pendingErrors: [],
    };
    const out = formatMessages([sampleRow, sampleRow], {
      ...baseOpts,
      detail: 'summary',
      exactLevelCounts: { INFO: 480, WARNING: 16, ERROR: 4 },
    }, status);
    expect(out).toContain('by level (exact, whole job):');
    expect(out).toContain('INFO: 480');
    expect(out).toContain('ERROR: 4');
    expect(out).toContain('(over first 2 of 500 — sample)'); // signatures/sources labeled
  });

  it('summary histogram merges adjacent buckets to ≤16 and drops leading/trailing zeros', () => {
    const buckets = Array.from({ length: 50 }, (_, i) => ({
      startTimestamp: 1783017000000 + i * 60000,
      length: 60000,
      count: i === 0 || i >= 48 ? 0 : i, // leading zero + trailing zeros
      logLevel: null,
    }));
    const status: SearchJobStatus = {
      state: 'DONE GATHERING RESULTS',
      messageCount: 2,
      recordCount: 0,
      pendingWarnings: [],
      pendingErrors: [],
      histogramBuckets: buckets,
    };
    const out = formatMessages([sampleRow], { ...baseOpts, detail: 'summary' }, status);
    const histLine = out.split('\n').find((l) => l.startsWith('histogram ('))!;
    const n = Number(/histogram \((\d+) buckets/.exec(histLine)![1]);
    expect(n).toBeGreaterThanOrEqual(12);
    expect(n).toBeLessThanOrEqual(20);
    const counts = out.split('\n').find((l) => l.trim().startsWith('counts:'))!;
    expect(counts.trim()).not.toMatch(/^counts: 0 /); // leading zeros trimmed
    expect(counts.trim()).not.toMatch(/ 0$/); // trailing zeros trimmed
  });

  it('raw returns verbatim _raw', () => {
    const out = formatMessages([sampleRow], { ...baseOpts, detail: 'raw' });
    expect(out).toBe(sampleRaw);
  });

  it('ndjson compact yields a flat object with level, request_id and full message', () => {
    const out = formatMessages([sampleRow], { ...baseOpts, format: 'ndjson' });
    const obj = JSON.parse(out);
    expect(obj.level).toBe('WARNING');
    expect(obj.request_id).toBe('caa722fc-3420-41f9-8a71-4d91f0b263a6');
    expect(obj.message).toBe(WARNING_MESSAGE);
  });
});

describe('formatMessages – levers', () => {
  it('fields projection returns exactly the requested fields plus level/request_id', () => {
    const out = formatMessages([sampleRow], {
      ...baseOpts,
      format: 'ndjson',
      fields: ['status', 'duration_s'],
    });
    const obj = JSON.parse(out);
    expect(Object.keys(obj).sort()).toEqual(['duration_s', 'level', 'request_id', 'status']);
  });

  it('truncates only messages beyond maxMessageChars, with a marker', () => {
    const longMsg = 'A'.repeat(600);
    const row: ResultRow = {
      map: { _raw: JSON.stringify({ log: { message: longMsg, levelname: 'INFO' } }) },
    };
    const truncated = formatMessages([row], { ...baseOpts, maxMessageChars: 500 });
    expect(truncated).toContain('…(truncated 100 chars)');
    const untouched = formatMessages([row], { ...baseOpts, maxMessageChars: 10_000 });
    expect(untouched).toContain(longMsg);
    expect(untouched).not.toContain('truncated');
  });

  it('dedupe collapses repeated identical lines into ×N', () => {
    const out = formatMessages([sampleRow, sampleRow, sampleRow], { ...baseOpts, dedupe: true });
    expect(out.split('\n').length).toBe(1);
    expect(out).toContain('×3');
  });

  it('dedupe groups GLOBALLY by (level, signature) — varying ids/timestamps, interleaved', () => {
    const mk = (ts: number, msg: string, level = 'ERROR'): ResultRow => ({
      map: {
        _messagetime: String(ts),
        _raw: JSON.stringify({ log: { levelname: level, message: msg } }),
      },
    });
    const rows = [
      mk(1783017533000, 'cache miss for entry111e4567-e89b-12d3-a456-426614174000'),
      mk(1783017534000, 'unrelated line'),
      mk(1783017535000, 'cache miss for entry222e4567-e89b-12d3-a456-426614174999'),
      mk(1783017536000, 'cache miss for entry333e4567-e89b-12d3-a456-426614174111'),
    ];
    const out = formatMessages(rows, { ...baseOpts, dedupe: true });
    const lines = out.split('\n');
    expect(lines.length).toBe(2); // one group of 3 (non-adjacent) + one singleton
    const grouped = lines.find((l) => l.includes('×3'))!;
    expect(grouped).toContain('2026-07-02T18:38:53.000Z..2026-07-02T18:38:56.000Z');
    expect(grouped).toContain('ERROR ×3 cache miss for entry');
    expect(lines.find((l) => l.includes('unrelated line'))).toBeTruthy();
    expect(lines.find((l) => l.includes('unrelated line'))).not.toContain('×'); // N=1 renders as today
  });

  it('dedupe keys on level too: same message at different levels does NOT merge', () => {
    const mk = (level: string): ResultRow => ({
      map: { _raw: JSON.stringify({ log: { levelname: level, message: 'same text' } }) },
    });
    const out = formatMessages([mk('ERROR'), mk('WARNING')], { ...baseOpts, dedupe: true });
    expect(out.split('\n').length).toBe(2);
  });
});

describe('signature', () => {
  it('normalizes ISO timestamps, UUIDs, hex runs and numbers into placeholders', () => {
    expect(
      signature(
        'req 74ec29d7-3420-41f9-8a71-4d91f0b263a6 at 2026-07-03T09:15:22.123Z took 0.532s (epoch 1783017533330, hash deadbeefcafe42)',
      ),
    ).toBe('req <uuid> at <ts> took <n>s (epoch <n>, hash <hex>)');
  });

  it('identical statements with different values share one signature', () => {
    const a = signature('cache miss for entry42 at 2026-07-03 09:00:01');
    const b = signature('cache miss for entry977 at 2026-07-01 23:59:59');
    expect(a).toBe(b);
  });
});

describe('sortRowsByMessageTime', () => {
  const row = (t: string, msg: string): ResultRow => ({
    map: { _messagetime: t, _raw: JSON.stringify({ log: { message: msg } }) },
  });
  const rows = [row('300', 'newest'), row('100', 'oldest'), row('200', 'middle')];

  it('asc orders oldest→newest (tracing default)', () => {
    expect(sortRowsByMessageTime(rows, 'asc').map((r) => r.map['_messagetime'])).toEqual([
      '100',
      '200',
      '300',
    ]);
  });

  it('desc orders newest→oldest and does not mutate the input', () => {
    expect(sortRowsByMessageTime(rows, 'desc').map((r) => r.map['_messagetime'])).toEqual([
      '300',
      '200',
      '100',
    ]);
    expect(rows[0]!.map['_messagetime']).toBe('300'); // input untouched
  });
});

describe('cookie-noise warning', () => {
  it('detects the persistent cookie warning', () => {
    expect(
      isCookieNoiseWarning(
        'You must enable cookies for subsequent requests to the search job. A 404 status…',
      ),
    ).toBe(true);
    expect(isCookieNoiseWarning('Some real warning about a bad partition')).toBe(false);
    expect(isCookieNoiseWarning(undefined)).toBe(false);
  });
});

describe('formatRecords', () => {
  const page = {
    fields: [
      { name: 'levelname', fieldType: 'string', keyField: true },
      { name: '_count', fieldType: 'long', keyField: false },
    ],
    records: [
      { map: { levelname: 'INFO', _count: '1688' } },
      { map: { levelname: '', _count: '5' } }, // nodrop empty string
    ],
  };

  it('renders a text table', () => {
    const out = formatRecords(page, 'text');
    expect(out).toContain('levelname');
    expect(out).toContain('1688');
    expect(out.split('\n').length).toBe(4); // header + sep + 2 rows
  });

  it('renders ndjson rows', () => {
    const out = formatRecords(page, 'ndjson');
    const rows = out.split('\n').map((l) => JSON.parse(l));
    expect(rows[0]._count).toBe('1688'); // strings stay strings
  });

  it('handles zero records', () => {
    expect(formatRecords({ fields: page.fields, records: [] }, 'text')).toBe('(no records)');
  });
});

describe('capResponseText', () => {
  it('passes small text through untouched', async () => {
    const { capResponseText } = await import('../src/format/capResponse.js');
    expect(capResponseText('short', 1000)).toBe('short');
  });

  it('truncates the tail and appends an actionable note', async () => {
    const { capResponseText } = await import('../src/format/capResponse.js');
    const out = capResponseText('h'.repeat(2000), 1000);
    expect(out.startsWith('h'.repeat(1000))).toBe(true);
    expect(out).toContain('[RESPONSE TRUNCATED: 1000 chars over');
    expect(out).toContain('YOKOZUNA_MAX_RESPONSE_CHARS');
    expect(out).toContain('sumo_export_results');
  });
});

describe('display coercions (§11)', () => {
  it('coerceNumericDisplay renders integral float-strings as integers, display-only', () => {
    expect(coerceNumericDisplay('404.0')).toBe('404');
    expect(coerceNumericDisplay('2.000')).toBe('2');
    expect(coerceNumericDisplay('-3.0')).toBe('-3');
    expect(coerceNumericDisplay('2.5')).toBe('2.5'); // non-integral stays
    expect(coerceNumericDisplay('v2.0')).toBe('v2.0'); // not a bare number
  });

  it('fixedPointNumberDisplay converts E-notation to fixed point', () => {
    expect(fixedPointNumberDisplay('7.15E-4')).toBe('0.000715');
    expect(fixedPointNumberDisplay('1e3')).toBe('1000');
    expect(fixedPointNumberDisplay('0.031')).toBe('0.031'); // untouched
    expect(fixedPointNumberDisplay('fast')).toBe('fast');
  });

  it('compact status displays coerced ("409.0" → 409) and full duration_s fixed-point', () => {
    const row: ResultRow = {
      map: {
        _raw: JSON.stringify({
          log: { levelname: 'INFO', message: 'req', method: 'GET', path: '/x', status: '409.0', duration_s: '7.15E-4' },
        }),
      },
    };
    const out = formatMessages([row], { detail: 'full', maxMessageChars: 10_000, format: 'text' });
    expect(out).toContain('status=409');
    expect(out).not.toContain('409.0');
    expect(out).toContain('duration_s=0.000715');
    expect(out).not.toContain('E-4');
  });

  it('fallbackDigestLevel: sev=/Fatal/type=/token fallbacks when the standard level is absent', () => {
    const flat = (raw: string) => flattenMessage({ _raw: raw });
    expect(fallbackDigestLevel(flat(JSON.stringify({ log: { severity: '4', message: 'x' } })))).toBe('sev=4');
    expect(fallbackDigestLevel(flat(JSON.stringify({ log: { severity: '2.0', message: 'x' } })))).toBe('sev=2');
    expect(fallbackDigestLevel(flat(JSON.stringify({ log: { severity: 'Fatal', message: 'x' } })))).toBe('Fatal');
    expect(fallbackDigestLevel(flat(JSON.stringify({ log: { type: 'exception', message: 'x' } })))).toBe('type=exception');
    expect(fallbackDigestLevel(flat('2026/07/04 [error] open() failed'))).toBe('[error]');
    expect(fallbackDigestLevel(flat('plain line'))).toBe('UNKNOWN');
    // The standard level always wins when present.
    expect(fallbackDigestLevel(flat(JSON.stringify({ log: { levelname: 'ERROR', severity: '1', message: 'x' } })))).toBe('ERROR');
  });
});

describe('renderDigest (§4.6, §11.4)', () => {
  it('renders req=— when a group has no request id (explicit absence, not omission)', () => {
    const groups = new Map<string, DigestGroup>();
    accumulateDigest(groups, flattenMessage({ _messagetime: '1783017533330', _raw: JSON.stringify({ log: { levelname: 'ERROR', message: 'boom' } }) }), 1783017533330);
    const out = renderDigest({ scanned: 1, topN: 5, truncated: false }, groups);
    expect(out).toContain('req=—');
  });

  it('groups by the fallback level so numeric-family rows do not all collapse into UNKNOWN', () => {
    const groups = new Map<string, DigestGroup>();
    const mk = (raw: string) => flattenMessage({ _raw: raw });
    accumulateDigest(groups, mk(JSON.stringify({ log: { severity: '4', message: 'same text' } })), 1);
    accumulateDigest(groups, mk(JSON.stringify({ log: { type: 'exception', message: 'same text' } })), 2);
    expect(groups.size).toBe(2); // sev=4 and type=exception are distinct groups
    const out = renderDigest({ scanned: 2, topN: 5, truncated: false }, groups);
    expect(out).toContain('sev=4');
    expect(out).toContain('type=exception');
  });
});

describe('renderFacets annotations (§10.3, §11.1)', () => {
  const header = { query: 'scope', fromLabel: 'a', toLabel: 'b', byReceiptTime: false, limit: 15 };

  it('annotates an all-(none) dimension with the describe_schema hint', () => {
    const out = renderFacets(header, [
      { dimension: 'levelname', rows: [{ key: '', count: 48_112 }] },
    ]);
    expect(out).toContain('(none)');
    expect(out).toContain('may not exist at this path');
    expect(out).toContain('sumo_describe_schema');
  });

  it('does NOT annotate a dimension with real values, and coerces float-string keys', () => {
    const out = renderFacets(header, [
      {
        dimension: 'log.status',
        rows: [
          { key: '404.0', count: 10 },
          { key: '', count: 2 },
        ],
      },
    ]);
    expect(out).toContain('10  404');
    expect(out).not.toContain('404.0');
    expect(out).not.toContain('may not exist');
  });
});

describe('dedupe + detail:"raw" keeps one exemplar (§11.3)', () => {
  it('each multi-row group renders its header line PLUS one verbatim _raw exemplar', () => {
    const raw1 = JSON.stringify({ log: { levelname: 'ERROR', message: 'boom id=1', user_agent: 'curl/8' } });
    const raw2 = JSON.stringify({ log: { levelname: 'ERROR', message: 'boom id=2', user_agent: 'curl/8' } });
    const rows: ResultRow[] = [{ map: { _raw: raw1 } }, { map: { _raw: raw2 } }];
    const out = formatMessages(rows, { detail: 'raw', dedupe: true, maxMessageChars: 10_000, format: 'text' });
    expect(out).toContain('×2');
    expect(out).toContain(raw1); // the payload survives the grouping
    expect(out).toContain('user_agent');
    expect(out).not.toContain(raw2); // ONE exemplar, not all
  });

  it('ndjson dedupe+raw carries the exemplar in _raw', () => {
    const raw = JSON.stringify({ log: { levelname: 'ERROR', message: 'boom id=1' } });
    const rows: ResultRow[] = [{ map: { _raw: raw } }, { map: { _raw: raw } }];
    const out = formatMessages(rows, { detail: 'raw', dedupe: true, maxMessageChars: 10_000, format: 'ndjson' });
    const obj = JSON.parse(out);
    expect(obj.count).toBe(2);
    expect(obj._raw).toBe(raw);
  });
});

describe('summary provenance + loud sample labels (§6)', () => {
  const status: SearchJobStatus = {
    state: 'DONE GATHERING RESULTS',
    messageCount: 500,
    recordCount: 0,
    pendingWarnings: [],
    pendingErrors: [],
  };

  it('labels exact counts with the detected field provenance', () => {
    const out = formatMessages([sampleRow], {
      detail: 'summary', maxMessageChars: 10_000, format: 'text',
      exactLevelCounts: { '3': 12, Fatal: 1 },
      exactLevelProvenance: 'log.severity',
    }, status);
    expect(out).toContain('by log.severity (auto-detected; exact, whole job):');
    expect(out).toContain('3: 12');
  });

  it('the sample fallback label is LOUD (never a quiet ambiguous sample)', () => {
    const out = formatMessages([sampleRow, sampleRow], {
      detail: 'summary', maxMessageChars: 10_000, format: 'text',
    }, status);
    expect(out).toContain('by level (SAMPLE — first 2 of 500 only; not whole-job):');
  });
});

describe('renderTrend', () => {
  it('handles no rows', async () => {
    const { renderTrend } = await import('../src/format/renderTrend.js');
    const out = renderTrend(
      { fromLabel: 'a', toLabel: 'b', intervalLabel: '5m', intervalMs: 300_000, by: 'levelname', maxSeries: 8 },
      [],
    );
    expect(out).toContain('no matching messages');
  });

  it('ranks series by total and merges overflow into "(other)"', async () => {
    const { renderTrend } = await import('../src/format/renderTrend.js');
    const rows = [
      { sliceMs: 0, key: 'A', count: 10 },
      { sliceMs: 300_000, key: 'B', count: 5 },
      { sliceMs: 0, key: 'C', count: 1 },
      { sliceMs: 300_000, key: 'D', count: 2 },
    ];
    const out = renderTrend(
      { fromLabel: 'a', toLabel: 'b', intervalLabel: '5m', intervalMs: 300_000, by: 'levelname', maxSeries: 2 },
      rows,
    );
    const lines = out.split('\n');
    expect(lines[1]).toContain('A');
    expect(lines[2]).toContain('B');
    expect(out).toContain('(other ×2)');
    expect(out).toMatch(/total=\s*3\b/); // C(1) + D(2); totals are right-aligned
    expect(out).toContain('[10 0]');
  });

  it('renders empty-key series as (none), annotating an ALL-(none) trend with the hint', async () => {
    const { renderTrend } = await import('../src/format/renderTrend.js');
    const out = renderTrend(
      { fromLabel: 'a', toLabel: 'b', intervalLabel: '1m', intervalMs: 60_000, by: 'levelname', maxSeries: 8 },
      [{ sliceMs: 0, key: '', count: 4 }],
    );
    expect(out).toContain('(none)');
    expect(out).toContain('buckets=1');
    expect(out).toContain('may not exist at this path');
    expect(out).toContain('sumo_describe_schema');
  });

  it('coerces float-string series keys for display', async () => {
    const { renderTrend } = await import('../src/format/renderTrend.js');
    const out = renderTrend(
      { fromLabel: 'a', toLabel: 'b', intervalLabel: '1m', intervalMs: 60_000, by: 'log.severity', maxSeries: 8 },
      [{ sliceMs: 0, key: '2.0', count: 4 }],
    );
    expect(out).toMatch(/^2 {2}/m);
    expect(out).not.toContain('2.0');
  });
});
