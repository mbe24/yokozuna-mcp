import { describe, expect, it } from 'vitest';
import {
  buildFetchPlan,
  buildSamplePlan,
  classifyStringFormat,
  enumeratePaths,
  pickStratField,
  profileSample,
  proposeCandidates,
  renderDescription,
  selectExemplars,
  type Stratum,
} from '../src/sumo/describeSchema.js';
import type { CategoryClassification } from '../src/sumo/detectSchema.js';

describe('buildSamplePlan (stratified — never first-N)', () => {
  it('a 1-in-10k minority stratum appears in the sample plan with quota ≥ 1', () => {
    const strata: Stratum[] = [
      { category: 'cat/a', value: 'stdout', count: 99_990 },
      { category: 'cat/a', value: 'stderr', count: 1 }, // the needle stratum
    ];
    const plan = buildSamplePlan(strata, 200);
    const needle = plan.find((e) => e.value === 'stderr')!;
    expect(needle).toBeTruthy();
    expect(needle.quota).toBeGreaterThanOrEqual(1);
    const majority = plan.find((e) => e.value === 'stdout')!;
    expect(majority.quota).toBeGreaterThan(150); // remainder is proportional
    expect(plan.reduce((s, e) => s + e.quota, 0)).toBeLessThanOrEqual(200);
  });

  it('never allocates beyond a stratum size and skips empty strata', () => {
    const plan = buildSamplePlan(
      [
        { category: 'a', value: 'x', count: 3 },
        { category: 'a', value: 'y', count: 0 },
      ],
      100,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]!.quota).toBe(3);
  });
});

describe('buildFetchPlan', () => {
  it('gives RARE strata dedicated filtered page jobs (a shared page would miss them)', () => {
    const plan = buildSamplePlan(
      [
        { category: 'cat/a', value: 'service', count: 9500 },
        { category: 'cat/a', value: 'exception', count: 50 }, // 0.5% — rare
      ],
      100,
    );
    const jobs = buildFetchPlan(plan, 'log.type');
    const dedicated = jobs.find((j) => j.stratumValue === 'exception');
    expect(dedicated).toBeTruthy();
    const shared = jobs.find((j) => j.stratumValue === undefined);
    expect(shared!.serves.some((e) => e.value === 'service')).toBe(true);
  });

  it('caps the number of page jobs and the number of categories', () => {
    const strata: Stratum[] = [];
    for (let c = 0; c < 8; c += 1) {
      strata.push({ category: `cat/${c}`, value: 'v', count: 1000 * (8 - c) });
    }
    const jobs = buildFetchPlan(buildSamplePlan(strata, 200), 'log.type');
    expect(jobs.length).toBeLessThanOrEqual(6);
    expect(new Set(jobs.map((j) => j.category)).size).toBeLessThanOrEqual(4);
  });
});

describe('selectExemplars (signature spread)', () => {
  it('spreads picks across message SHAPES instead of taking the first N rows', () => {
    // 90 rows of shape A, then 10 of shape B — first-N(4) would see only shape A.
    const messages = [
      ...Array.from({ length: 90 }, (_, i) => ({ raw: `shape A id=${i}`, stratumValue: 's' })),
      ...Array.from({ length: 10 }, (_, i) => ({ raw: `totally different shape B #${i}`, stratumValue: 's' })),
    ];
    const picked = selectExemplars(messages, new Map([['s', 4]]));
    expect(picked).toHaveLength(4);
    expect(picked.some((m) => m.raw.includes('shape B'))).toBe(true);
    expect(picked.some((m) => m.raw.includes('shape A'))).toBe(true);
  });

  it('honors per-stratum quotas', () => {
    const messages = [
      { raw: 'a 1', stratumValue: 'x' },
      { raw: 'a 2', stratumValue: 'x' },
      { raw: 'b 1', stratumValue: 'y' },
    ];
    const picked = selectExemplars(messages, new Map([['x', 1], ['y', 5]]));
    expect(picked.filter((m) => m.stratumValue === 'x')).toHaveLength(1);
    expect(picked.filter((m) => m.stratumValue === 'y')).toHaveLength(1); // pool-bounded
  });
});

describe('enumeratePaths', () => {
  it('enumerates top-level AND nested keys, marks arrays [], respects maxDepth', () => {
    const leaves = enumeratePaths(
      {
        stream: 'stdout',
        log: {
          severity: '2.0',
          context: { user: 'u1', deep: { deeper: { deepest: 1 } } },
          tags: ['a', 'b'],
          items: [{ id: 7 }],
        },
      },
      4,
    );
    const byPath = new Map(leaves.map((l) => [l.path, l]));
    expect(byPath.get('stream')!.kind).toBe('string');
    expect(byPath.get('log.severity')!.kind).toBe('float-string'); // "2.0" flagged
    expect(byPath.get('log.context.user')!.kind).toBe('string');
    expect(byPath.get('log.tags[]')!.kind).toBe('array');
    expect(byPath.get('log.items[].id')!.kind).toBe('int');
    // depth 4: log(1).context(2).deep(3).deeper(4) is an object AT the depth cap → leaf
    expect(byPath.has('log.context.deep.deeper')).toBe(true);
    expect(byPath.has('log.context.deep.deeper.deepest')).toBe(false);
  });

  it('infers int-string vs float-string vs string', () => {
    const kinds = new Map(enumeratePaths({ a: '42', b: '2.0', c: 'x', d: 42, e: 4.2, f: true }, 4).map((l) => [l.path, l.kind]));
    expect(kinds.get('a')).toBe('int-string');
    expect(kinds.get('b')).toBe('float-string');
    expect(kinds.get('c')).toBe('string');
    expect(kinds.get('d')).toBe('int');
    expect(kinds.get('e')).toBe('float');
    expect(kinds.get('f')).toBe('bool');
  });
});

describe('classifyStringFormat / string-payload characterization', () => {
  it('recognizes access-log-like, XML-ish, and free-text', () => {
    expect(
      classifyStringFormat('10.0.0.1 - - [04/Jul/2026:10:00:00 +0000] "GET /x HTTP/1.1" 200 5'),
    ).toBe('access-log-like');
    expect(classifyStringFormat('<xml><y/></xml>')).toBe('XML-ish blob');
    expect(classifyStringFormat('something happened today')).toBe('free-text');
  });

  it('profileSample characterizes non-JSON strata instead of returning an empty schema', () => {
    const profile = profileSample(
      [
        { raw: '2026/07/04 [error] 31#31: open() "/x/wp-login.php" failed', stratumLabel: 'cat/front' },
        { raw: '10.0.0.1 - - [04/Jul/2026] "GET / HTTP/1.1" 200 12', stratumLabel: 'cat/front' },
      ],
      4,
    );
    expect(profile.stringRows).toBe(2);
    const ss = profile.stringStats.get('cat/front')!;
    expect(ss.tokenHits['[error]']).toBe(1);
    expect(ss.lines).toBe(2);
  });
});

describe('proposeCandidates', () => {
  const numericCat: CategoryClassification = { category: 'cat/b', family: 'numeric', total: 48_000 };
  const stringCat: CategoryClassification = {
    category: 'cat/c',
    family: 'string',
    total: 11_306,
    tokens: ['[error]', '[crit]'],
  };

  it('numeric candidate is the §3.4-B fragment with the honest caveats (NULL severity, unseen tiers, float-strings)', () => {
    const profile = profileSample(
      [
        { raw: JSON.stringify({ log: { severity: '2.0', type: 'service', message: 'x' } }), stratumLabel: 'cat/b×service' },
        { raw: JSON.stringify({ log: { severity: '2.0', type: 'service', message: 'x' } }), stratumLabel: 'cat/b×service' },
        { raw: JSON.stringify({ log: { severity: '1', type: 'service', message: 'x' } }), stratumLabel: 'cat/b×service' },
        { raw: JSON.stringify({ log: { type: 'exception', message: 'boom' } }), stratumLabel: 'cat/b×exception' },
        { raw: JSON.stringify({ log: { type: 'exception', message: 'boom2' } }), stratumLabel: 'cat/b×exception' },
        { raw: JSON.stringify({ log: { type: 'exception', message: 'boom3' } }), stratumLabel: 'cat/b×exception' },
      ],
      4,
    );
    const cands = proposeCandidates([numericCat], profile);
    expect(cands).toHaveLength(1);
    const c = cands[0]!;
    expect(c.fragment).toBe(
      '| json field=_raw "log.severity" as yz_sev nodrop | json field=_raw "log.type" as yz_type nodrop' +
        ' | where num(yz_sev) >= 3 or yz_sev in ("Fatal","Error","ERROR","error","Warning","WARNING","warning") or yz_type = "exception"',
    );
    expect(c.caveats.join(' ')).toContain('not observed');
    expect(c.caveats.join(' ')).toContain('did not fire in this window');
    expect(c.caveats.join(' ')).toContain('NULL severity');
    expect(c.caveats.join(' ')).toContain('cat/b×exception'); // observed NULL-severity stratum named
    expect(c.caveats.join(' ')).toContain('float-string');
  });

  it('string candidate carries the benign-noise caveat and alternates (stderr, status ≥ 500)', () => {
    const profile = profileSample([{ raw: '[error] x', stratumLabel: 'cat/c' }], 4);
    const cands = proposeCandidates([stringCat], profile);
    const c = cands.find((x) => x.fragment.startsWith('('))!;
    expect(c.fragment).toBe('("[error]" OR "[crit]")');
    expect(c.caveats.join(' ')).toContain('benign noise');
    expect(c.caveats.join(' ')).toContain('stream=stderr');
    expect(c.caveats.join(' ')).toContain('parse regex');
  });

  it('ranks candidates by in-scope message volume', () => {
    const profile = profileSample([], 4);
    const cands = proposeCandidates([numericCat, stringCat], profile);
    expect(cands[0]!.rationale).toContain('numeric');
  });
});

describe('pickStratField', () => {
  const cat = (typeN: number, streamN: number): CategoryClassification => ({
    category: 'c',
    family: 'numeric',
    total: 100,
    fills: {
      category: 'c', total: 100, jsonN: 100, levelnameN: 0, levelN: 0,
      severityN: 10, loglevelN: 0, typeN, streamN,
    },
  });

  it('prefers log.type, then stream, then none', () => {
    expect(pickStratField([cat(50, 100)])).toBe('log.type');
    expect(pickStratField([cat(0, 100)])).toBe('stream');
    expect(pickStratField([cat(0, 0)])).toBeUndefined();
  });
});

describe('renderDescription', () => {
  it('ends with the propose-only reminder and shows the strata plan', () => {
    const plan = buildSamplePlan([{ category: 'cat/a', value: 'x', count: 100 }], 10);
    const out = renderDescription({
      scope: 'scope',
      rangeLabel: 'a .. b',
      stratField: 'log.type',
      plan,
      sampledCount: 10,
      profile: profileSample([{ raw: JSON.stringify({ log: { m: 1 } }), stratumLabel: 'cat/a×x' }], 4),
      cats: [],
      candidates: [],
      notes: [],
    });
    expect(out).toContain('strata (from exact counts):');
    expect(out).toContain('cat/a × log.type=x: 100 msgs');
    expect(out).toContain('describe_schema PROPOSES — you decide');
    expect(out).toContain('candidate severity filters: NONE');
  });

  it('emits a paste-ready next: sumo_error_digest handoff line per candidate (§0.2.1 c)', () => {
    const out = renderDescription({
      scope: '_sourcecategory=k8s/team/api',
      rangeLabel: 'a .. b',
      stratField: undefined,
      plan: buildSamplePlan([{ category: 'k8s/team/api', value: '', count: 100 }], 10),
      sampledCount: 10,
      profile: profileSample([{ raw: JSON.stringify({ log: { m: 1 } }), stratumLabel: 'k8s/team/api' }], 4),
      cats: [],
      candidates: [
        { fragment: '(\"[error]\" OR \"[crit]\")', rationale: 'string payload', caveats: ['token noise'] },
      ],
      notes: [],
    });
    expect(out).toContain(
      `next: sumo_error_digest query="_sourcecategory=k8s/team/api" filter='("[error]" OR "[crit]")'`,
    );
  });
});
