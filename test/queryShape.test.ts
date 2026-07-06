import { describe, expect, it } from 'vitest';
import { isAggregateQuery } from '../src/sumo/queryShape.js';

describe('isAggregateQuery', () => {
  const aggregates = [
    'x | count',
    'x | count by levelname',
    'x |count by _sourcecategory',
    'x |  COUNT BY host', // case-insensitive, extra spaces
    'x | count_distinct(request_id)',
    'x | count_frequent path',
    'x | sum(bytes)',
    'x | avg(duration_s)',
    'x | min(t) | max(t)',
    'x | stddev(x)',
    'x | variance(x)',
    'x | pct(latency, 95)',
    'x | percentile(latency, 99)',
    'x | median(latency)',
    'x | first(message)',
    'x | last(message)',
    'x | most_recent(message)',
    'x | least_recent(message)',
    'x | values(host)',
    'x | total bytes',
    'x | geomean(x)',
    'x | timeslice 1m | count by _timeslice',
    'x | transpose row _timeslice column level',
    'x | outlier count',
    'x | predict count by 1m',
    'x | logreduce',
    'x | logcompare timeshift -1d',
    'a | json field=_raw "log.levelname" as levelname nodrop | count by levelname',
  ];
  for (const q of aggregates) {
    it(`detects aggregate: ${q}`, () => {
      expect(isAggregateQuery(q)).toBe(true);
    });
  }

  const nonAggregates = [
    'error',
    '_sourcecategory=kubernetes/myservice/*/backend "host.example.com"',
    'x | json field=_raw "log.levelname" as levelname nodrop | where levelname in ("ERROR")',
    'x | where status = "500"',
    'x | parse "duration=*" as duration',
    'x | fields level, message',
    'countdown | limit 10', // "count" only as a word prefix inside a keyword, not an operator
    'x | counter', // count must be a whole word after the pipe
    'x | firstname = "a"', // first only as a prefix
    'a count b', // no pipe
  ];
  for (const q of nonAggregates) {
    it(`passes non-aggregate: ${q}`, () => {
      expect(isAggregateQuery(q)).toBe(false);
    });
  }

  it('is lexical by design: a quoted "| count" phrase still counts as aggregate (safe direction)', () => {
    // The regex cannot see quoting; erring toward "aggregate" only skips an optional
    // side-job / rejects a monitor query with a clear message — never a wrong result.
    expect(isAggregateQuery('"| count by levelname"')).toBe(true);
  });
});

describe('buildExtractClauses', () => {
  it('returns an empty string for undefined/empty extract', async () => {
    const { buildExtractClauses } = await import('../src/sumo/queryShape.js');
    expect(buildExtractClauses(undefined)).toBe('');
    expect(buildExtractClauses({})).toBe('');
  });

  it('compiles one chained clause per field (never the broken comma form)', async () => {
    const { buildExtractClauses } = await import('../src/sumo/queryShape.js');
    const out = buildExtractClauses({ status: 'log.status', user: 'log.context.user' });
    expect(out).toBe(
      ' | json field=_raw "log.status" as status nodrop | json field=_raw "log.context.user" as user nodrop',
    );
    expect(out).not.toMatch(/as \w+,/); // comma multi-extract is broken in Sumo
  });

  it('rejects non-identifier aliases and quoted/empty paths', async () => {
    const { buildExtractClauses } = await import('../src/sumo/queryShape.js');
    expect(() => buildExtractClauses({ 'bad alias': 'log.a' })).toThrow(/identifier/);
    expect(() => buildExtractClauses({ '1st': 'log.a' })).toThrow(/identifier/);
    expect(() => buildExtractClauses({ ok: 'log."x"' })).toThrow(/double quotes/);
    expect(() => buildExtractClauses({ ok: '  ' })).toThrow(/non-empty/);
  });
});

describe('ExtractFillCounter (§0.2.1 #5)', () => {
  it('warns only for aliases that are all-empty across observed rows', async () => {
    const { ExtractFillCounter } = await import('../src/sumo/queryShape.js');
    const c = new ExtractFillCounter(['st', 'user']);
    c.observe({ st: '', user: 'alice' });
    c.observe({ st: '', user: 'bob' });
    c.observe({ user: 'carol' }); // st absent → still empty
    const warns = c.warnings();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe(
      'extract "st": 0/3 non-empty — the path may not exist on these rows; run sumo_describe_schema.',
    );
  });

  it('a single non-empty value suppresses the warning; no rows → no warnings', async () => {
    const { ExtractFillCounter } = await import('../src/sumo/queryShape.js');
    const c = new ExtractFillCounter(['st']);
    expect(c.warnings()).toEqual([]); // nothing observed
    c.observe({ st: '' });
    c.observe({ st: '200' });
    expect(c.warnings()).toEqual([]);
  });
});
