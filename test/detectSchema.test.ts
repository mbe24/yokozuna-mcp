import { describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_FIELDS,
  DetectionCache,
  NUMERIC_SEVERITY_ENUMS,
  annotateNumWarnings,
  applyTokenCounts,
  confidentZeroFill,
  tokenCandidates,
  type CategoryClassification,
  buildClassificationQuery,
  buildDetectedFromLine,
  buildPredicate,
  buildTokenQuery,
  classifyCategory,
  detectSchema,
  formatAge,
  isNumConversionWarning,
  parseTokenRow,
  pickPrimary,
  type CategoryFills,
  type Detection,
} from '../src/sumo/detectSchema.js';
import type { SearchJobApi } from '../src/sumo/searchJobApi.js';

const fills = (over: Partial<CategoryFills> = {}): CategoryFills => ({
  category: 'cat/x',
  total: 1000,
  jsonN: 1000,
  levelnameN: 0,
  levelN: 0,
  severityN: 0,
  loglevelN: 0,
  typeN: 0,
  streamN: 1000,
  ...over,
});

describe('classifyCategory (§3.2 thresholds)', () => {
  it('classifies family A when a word-level candidate fills ≥5%, picking the highest fill', () => {
    const c = classifyCategory(fills({ levelnameN: 990, levelN: 200 }));
    expect(c.family).toBe('word');
    expect(c.levelField).toBe('log.levelname');
    // A different winner:
    const c2 = classifyCategory(fills({ levelN: 300, loglevelN: 900 }));
    expect(c2.levelField).toBe('log.loglevel');
  });

  it('word fill below 5% does NOT classify as family A', () => {
    const c = classifyCategory(fills({ levelnameN: 40 })); // 4%
    expect(c.family).not.toBe('word');
  });

  it('classifies family B on severity fill ≥1% (severity legitimately lives on a type subset)', () => {
    const c = classifyCategory(fills({ severityN: 15 })); // 1.5%
    expect(c.family).toBe('numeric');
  });

  it('classifies family B on type fill ≥5% even with zero severity fill', () => {
    const c = classifyCategory(fills({ typeN: 60 })); // 6%
    expect(c.family).toBe('numeric');
  });

  it('classifies family C when the JSON fraction is below 50%', () => {
    const c = classifyCategory(fills({ jsonN: 10 })); // 1%
    expect(c.family).toBe('string');
  });

  it('word-level beats numeric when both fill (word checked first)', () => {
    const c = classifyCategory(fills({ levelnameN: 900, severityN: 900 }));
    expect(c.family).toBe('word');
  });

  it('JSON payload with no vocabulary hit is no-signal — never a guess', () => {
    const c = classifyCategory(fills({}));
    expect(c.family).toBe('none');
  });
});

describe('buildPredicate (§3.4 — vocabulary/threshold-driven, never observed values)', () => {
  it('family B: the exact validated fragment — matches unseen severity=4 by construction', () => {
    const { fragment, usesNum } = buildPredicate([
      { category: 'c', family: 'numeric', total: 10 },
    ]);
    expect(fragment).toBe(
      ' | json field=_raw "log.severity" as yz_sev nodrop | json field=_raw "log.type" as yz_type nodrop' +
        ' | where num(yz_sev) >= 3 or yz_sev in ("Fatal","Error","ERROR","error","Warning","WARNING","warning") or yz_type = "exception"',
    );
    // The predicate string is threshold-driven: num() covers "3", "3.0", "4" (incl. tiers
    // that never fired in the window); the string enums and type=exception (NULL severity)
    // are explicit — live data shows severity="Error"/"Warning" STRING rows num() misses.
    expect(fragment).toContain('num(yz_sev) >= 3');
    expect(fragment).toContain('yz_type = "exception"');
    for (const v of NUMERIC_SEVERITY_ENUMS) {
      expect(fragment).toContain(`"${v}"`);
    }
    // severity="Error" and severity="Warning" now match (all case variants enumerated).
    expect(NUMERIC_SEVERITY_ENUMS).toEqual(
      expect.arrayContaining(['Fatal', 'Error', 'ERROR', 'error', 'Warning', 'WARNING', 'warning']),
    );
    expect(usesNum).toBe(true);
  });

  it('family A: enumerated case variants (where…in is case-sensitive)', () => {
    const { fragment, usesNum } = buildPredicate([
      { category: 'c', family: 'word', total: 10, levelField: 'log.levelname' },
    ]);
    expect(fragment).toContain('| json field=_raw "log.levelname" as yz_log_levelname nodrop');
    for (const v of ['"ERROR"', '"error"', '"WARNING"', '"warn"', '"CRITICAL"', '"Fatal"', '"SEVERE"']) {
      expect(fragment).toContain(v);
    }
    expect(usesNum).toBe(false);
  });

  it('pure family-C scope: keyword clause with the full tier sub-vocabulary', () => {
    const { fragment } = buildPredicate([
      { category: 'c', family: 'string', total: 10, tokens: ['[error]', '[crit]', 'exception'] },
    ]);
    expect(fragment).toBe(' ("[error]" OR "[crit]" OR "exception")');
  });

  it('cross-family union: one where OR-ing families, string tokens via _raw matches', () => {
    const { fragment, usesNum } = buildPredicate([
      { category: 'a', family: 'word', total: 10, levelField: 'log.levelname' },
      { category: 'b', family: 'numeric', total: 10 },
      { category: 'c', family: 'string', total: 10, tokens: ['[error]', '[crit]'] },
    ]);
    expect(fragment).toContain('| where (yz_log_levelname in (');
    expect(fragment).toContain(
      ') or (num(yz_sev) >= 3 or yz_sev in ("Fatal","Error","ERROR","error","Warning","WARNING","warning") or yz_type = "exception")',
    );
    expect(fragment).toContain('or (_raw matches "*[error]*" or _raw matches "*[crit]*")');
    // exactly ONE where clause
    expect(fragment!.match(/\| where /g)).toHaveLength(1);
    expect(usesNum).toBe(true);
  });

  it('no-signal yields NO predicate — never an empty where or match-all', () => {
    const { fragment } = buildPredicate([{ category: 'c', family: 'none', total: 10 }]);
    expect(fragment).toBeUndefined();
    expect(buildPredicate([]).fragment).toBeUndefined();
  });
});

describe('token classification (§3.3)', () => {
  it('finds a 1-in-10k token needle and includes exception/traceback only when fired', () => {
    const cats = [
      { category: 'cat/front', family: 'string' as const, total: 11_306 },
    ];
    const out = applyTokenCounts(cats, [
      parseTokenRow({
        _sourcecategory: 'cat/front',
        error_n: '1', // the needle
        warn_n: '0',
        crit_n: '0',
        exc_n: '0',
        tb_n: '0',
        stderr_n: '1',
        total: '11306',
      }),
    ]);
    expect(out[0]!.family).toBe('string');
    expect(out[0]!.tokens).toEqual(['[error]', '[crit]']); // full tier sub-vocab, no exception (0 hits)
    expect(out[0]!.stderrN).toBe(1);
  });

  it('adds exception/traceback to the predicate tokens when they fired', () => {
    const out = applyTokenCounts(
      [{ category: 'c', family: 'string', total: 100 }],
      [parseTokenRow({ _sourcecategory: 'c', error_n: '2', exc_n: '3', tb_n: '1', warn_n: '0', crit_n: '0', stderr_n: '0', total: '100' })],
    );
    expect(out[0]!.tokens).toEqual(['[error]', '[crit]', 'exception', 'traceback']);
  });

  it('a string category with ZERO token hits becomes no-signal', () => {
    const out = applyTokenCounts(
      [{ category: 'c', family: 'string', total: 100 }],
      [parseTokenRow({ _sourcecategory: 'c', error_n: '0', warn_n: '0', crit_n: '0', exc_n: '0', tb_n: '0', stderr_n: '50', total: '100' })],
    );
    expect(out[0]!.family).toBe('none');
  });

  it('rescues a JSON-no-vocabulary category into family C when tokens fire (envelope-with-string-log shape)', () => {
    // Live-found (EU, 2026-07-06): container envelope {"stream","timestamp","log":"<text line>"}
    // is ~100% JSON with zero vocabulary fills, but "[error]" fires inside the string payload.
    const cats: CategoryClassification[] = [{ category: 'c', family: 'none', total: 22_991 }];
    expect(tokenCandidates(cats)).toHaveLength(1); // "none" categories get the token probe
    const out = applyTokenCounts(
      cats,
      [parseTokenRow({ _sourcecategory: 'c', error_n: '1', warn_n: '0', crit_n: '0', exc_n: '0', tb_n: '0', stderr_n: '1', total: '22991' })],
    );
    expect(out[0]!.family).toBe('string');
    expect(out[0]!.tokens).toEqual(['[error]', '[crit]']);
  });
});

describe('query builders', () => {
  it('Job 1 carries the full fixed candidate vocabulary and per-category sums', () => {
    const q = buildClassificationQuery('_sourcecategory=x');
    expect(q.startsWith('_sourcecategory=x | json field=_raw "log.levelname"')).toBe(true);
    for (const f of ['log.levelname', 'log.level', 'log.severity', 'log.loglevel', 'log.type']) {
      expect(q).toContain(`json field=_raw "${f}"`);
    }
    expect(q).toContain('json field=_raw "stream"'); // TOP-LEVEL key, no log. prefix
    expect(q).toContain('if(_raw matches "{*", 1, 0) as is_json');
    // Fill tests MUST be null-safe: a nodrop-missing field is NULL and `d != ""` is TRUE
    // for it on live Sumo (would count every candidate as 100% filled).
    expect(q).toContain('if(isBlank(d_levelname), 0, 1) as f_levelname');
    expect(q).toContain('if(isBlank(d_severity), 0, 1) as f_severity');
    expect(q).not.toContain('!= ""');
    expect(q).toContain('count as total by _sourcecategory');
    // One clause per field — the comma multi-extract form is broken in Sumo.
    expect(q).not.toMatch(/as \w+ nodrop\s*,/);
  });

  it('Job 2 restricts to the family-C categories and counts the fixed token vocabulary', () => {
    const q = buildTokenQuery('scope', ['cat/a', 'cat/b']);
    expect(q).toContain('(_sourcecategory="cat/a" OR _sourcecategory="cat/b")');
    for (const t of ['\\*\\[error\\]\\*', '\\*\\[warn\\*', '\\*\\[crit\\]\\*', '\\*exception\\*', '\\*traceback\\*']) {
      expect(q).toMatch(new RegExp(t));
    }
    expect(q).toContain('if(d_stream = "stderr", 1, 0) as on_stderr');
    // single category: no parens needed
    expect(buildTokenQuery('scope', ['cat/a'])).toContain('scope _sourcecategory="cat/a"');
  });
});

describe('pickPrimary / detectedFrom', () => {
  it('picks the dominant family by message volume, with the word field of the largest word category', () => {
    const p = pickPrimary([
      { category: 'a', family: 'word', total: 100, levelField: 'log.level' },
      { category: 'a2', family: 'word', total: 900, levelField: 'log.levelname' },
      { category: 'b', family: 'numeric', total: 500 },
    ]);
    expect(p).toEqual({ family: 'word', field: 'log.levelname' });
    expect(pickPrimary([{ category: 'x', family: 'none', total: 10 }])).toBeUndefined();
  });

  it('caps the disclosed category list (token economy)', () => {
    const cats = Array.from({ length: 9 }, (_, i) => ({
      category: `cat/${i}`,
      family: 'word' as const,
      total: 10,
      levelField: 'log.levelname',
    }));
    const line = buildDetectedFromLine(cats);
    expect(line).toContain('9 categories in scope');
    expect(line).toContain('(+3 more)');
  });
});

describe('DetectionCache (§3, O1)', () => {
  const positiveDet = (): Detection => ({
    categories: [],
    scopeTotal: 10,
    predicate: ' | where x',
    usesNum: false,
    primary: { family: 'word', field: 'log.levelname' },
    detectedFromLine: '1 category',
    jobsRun: 1,
  });

  it('caches positive detections by normalized scope, with age reporting', () => {
    let t = 0;
    const cache = new DetectionCache({ ttlMs: 10_000, now: () => t });
    cache.set('scope   a', positiveDet());
    t = 3000;
    const hit = cache.get(' scope a ');
    expect(hit).toBeTruthy();
    expect(hit!.ageMs).toBe(3000);
  });

  it('NEVER caches a no-signal detection (a stale no-signal is a false-clean generator)', () => {
    const cache = new DetectionCache();
    cache.set('scope', { ...positiveDet(), predicate: undefined });
    expect(cache.get('scope')).toBeUndefined();
  });

  it('expires entries after the TTL', () => {
    let t = 0;
    const cache = new DetectionCache({ ttlMs: 10_000, now: () => t });
    cache.set('scope', positiveDet());
    t = 10_001;
    expect(cache.get('scope')).toBeUndefined();
  });

  it('is LRU-capped', () => {
    const cache = new DetectionCache({ maxEntries: 2, now: () => 0 });
    cache.set('a', positiveDet());
    cache.set('b', positiveDet());
    cache.get('a'); // touch a → b is now oldest
    cache.set('c', positiveDet());
    expect(cache.get('a')).toBeTruthy();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeTruthy();
  });

  it('formatAge renders compact ages', () => {
    expect(formatAge(45_000)).toBe('45s');
    expect(formatAge(9 * 60_000)).toBe('9m');
  });
});

describe('num()-conversion warning annotation (§3.6)', () => {
  const WARN = 'Field yz_sev of type string could not be converted to a number for 42 rows.';

  it('annotates the conversion warning as benign ONLY on self-injected num() predicates', () => {
    expect(annotateNumWarnings([WARN], true)[0]).toContain('benign');
    expect(annotateNumWarnings([WARN], false)[0]).not.toContain('benign');
  });

  it('never blanket-annotates unrelated warnings', () => {
    const other = 'partition xyz not found';
    expect(annotateNumWarnings([other], true)[0]).toBe(other);
    expect(isNumConversionWarning(other)).toBe(false);
  });
});

describe('detectSchema orchestration', () => {
  const rec = (map: Record<string, string>) => ({ map });

  function fakeApi(recordsById: Record<string, { map: Record<string, string> }[]>) {
    let n = 0;
    const created: string[] = [];
    return {
      created,
      api: {
        create: vi.fn(async (req: { query: string }) => {
          created.push(req.query);
          n += 1;
          return { id: req.query.includes('sum(t_error)') ? 'TOK' : `J${n}` };
        }),
        status: vi.fn(async () => ({
          state: 'DONE GATHERING RESULTS',
          messageCount: 0,
          recordCount: 1,
          pendingWarnings: [],
          pendingErrors: [],
        })),
        records: vi.fn(async (id: string) => ({ fields: [], records: recordsById[id] ?? [] })),
        messages: vi.fn(),
        delete: vi.fn(async () => {}),
      } as unknown as SearchJobApi,
    };
  }

  it('runs ONE job for JSON families and deletes it; two when family C is present', async () => {
    const { api } = fakeApi({
      J1: [rec({ _sourcecategory: 'a', total: '100', json_n: '100', levelname_n: '100', level_n: '0', severity_n: '0', loglevel_n: '0', type_n: '0', stream_n: '0' })],
    });
    const det = await detectSchema({ api, timeZone: 'UTC' }, 'scope', { from: 1, to: 2 });
    expect(det.jobsRun).toBe(1);
    expect(det.predicate).toContain('yz_log_levelname in');
    expect(det.scopeTotal).toBe(100);
    expect((api.delete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    const { api: api2 } = fakeApi({
      J1: [rec({ _sourcecategory: 'c', total: '100', json_n: '0', levelname_n: '0', level_n: '0', severity_n: '0', loglevel_n: '0', type_n: '0', stream_n: '0' })],
      TOK: [rec({ _sourcecategory: 'c', error_n: '5', warn_n: '0', crit_n: '0', exc_n: '0', tb_n: '0', stderr_n: '0', total: '100' })],
    });
    const det2 = await detectSchema({ api: api2, timeZone: 'UTC' }, 'scope', { from: 1, to: 2 });
    expect(det2.jobsRun).toBe(2);
    expect(det2.predicate).toBe(' ("[error]" OR "[crit]")');
  });

  it('serves the second call from the cache (0 jobs) with the age set', async () => {
    const { api } = fakeApi({
      J1: [rec({ _sourcecategory: 'a', total: '100', json_n: '100', levelname_n: '100', level_n: '0', severity_n: '0', loglevel_n: '0', type_n: '0', stream_n: '0' })],
    });
    let t = 1000;
    const cache = new DetectionCache({ now: () => t });
    const deps = { api, timeZone: 'UTC', cache };
    await detectSchema(deps, 'scope', { from: 1, to: 2 });
    t = 61_000;
    const det2 = await detectSchema(deps, 'scope', { from: 1, to: 2 });
    expect(det2.jobsRun).toBe(0);
    expect(det2.cachedAgeMs).toBe(60_000);
    expect((api.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

});

describe('publish hygiene', () => {
  it('candidate vocabulary is EXACTLY the generic industry set — org fields can never ship', () => {
    // The allowlist: locking the constant means adding an org-specific probe field is a
    // test failure, with zero org names embedded in this repo.
    expect([...CANDIDATE_FIELDS]).toEqual([
      'log.levelname',
      'log.level',
      'log.severity',
      'log.loglevel',
      'log.type',
      'stream',
    ]);
    // And the Job-1 query probes the constant and NOTHING else.
    const q = buildClassificationQuery('scope');
    for (const f of CANDIDATE_FIELDS) {
      expect(q).toContain(`json field=_raw "${f}" as `);
    }
    expect(q.match(/json field=_raw "/g)).toHaveLength(CANDIDATE_FIELDS.length);
  });

  // Opt-in broad denylist: set YOKOZUNA_DEV_FORBIDDEN_TERMS (comma-separated, dev-local
  // .env value exported into the test env) to grep ALL of src/ and test/ for org terms.
  // Unset (CI, fresh clones): skipped — the repo never embeds the terms themselves.
  const forbidden = (process.env['YOKOZUNA_DEV_FORBIDDEN_TERMS'] ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  it.skipIf(forbidden.length === 0)(
    'no YOKOZUNA_DEV_FORBIDDEN_TERMS term appears anywhere in src/ or test/',
    async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else files.push(p);
        }
      };
      walk('src');
      walk('test');
      const offenders: string[] = [];
      for (const file of files) {
        const body = fs.readFileSync(file, 'utf8').toLowerCase();
        for (const term of forbidden) {
          if (body.includes(term)) offenders.push(`${file}: "${term}"`);
        }
      }
      expect(offenders, `forbidden org terms found:\n${offenders.join('\n')}`).toEqual([]);
    },
  );
});

describe('confidentZeroFill (§4.4 refinement)', () => {
  const det = (cats: CategoryClassification[]): Detection => ({
    categories: cats,
    scopeTotal: cats.reduce((s, c) => s + c.total, 0),
    predicate: ' | where x',
    usesNum: false,
    detectedFromLine: '',
    jobsRun: 1,
  });
  const catFills = (total: number, over: Partial<CategoryFills> = {}): CategoryFills => ({
    category: 'c',
    total,
    jsonN: total,
    levelnameN: 0,
    levelN: 0,
    severityN: 0,
    loglevelN: 0,
    typeN: 0,
    streamN: total,
    ...over,
  });

  it('word family at high fill is confident — returns the field label + fill count', () => {
    const d = det([
      {
        category: 'c',
        family: 'word',
        total: 1000,
        levelField: 'log.levelname',
        fills: catFills(1000, { levelnameN: 998 }),
      },
    ]);
    expect(confidentZeroFill(d)).toEqual({ label: 'level field (log.levelname)', fillN: 998 });
  });

  it('word family at sparse fill (above the 5% word floor, below 50%) is NOT confident', () => {
    const d = det([
      {
        category: 'c',
        family: 'word',
        total: 1000,
        levelField: 'log.levelname',
        fills: catFills(1000, { levelnameN: 80 }),
      },
    ]);
    expect(confidentZeroFill(d)).toBeUndefined();
  });

  it('numeric family qualifies via the better-filled of log.severity/log.type', () => {
    const d = det([
      {
        category: 'c',
        family: 'numeric',
        total: 1000,
        fills: catFills(1000, { severityN: 300, typeN: 1000 }),
      },
    ]);
    expect(confidentZeroFill(d)).toEqual({
      label: 'severity/type fields (log.severity, log.type)',
      fillN: 1000,
    });
  });

  it('string-token families never qualify (a stale token IS the mismatch to alarm on)', () => {
    const d = det([
      {
        category: 'c',
        family: 'string',
        total: 1000,
        tokens: ['[error]', '[crit]'],
        fills: catFills(1000, { jsonN: 0 }),
      },
    ]);
    expect(confidentZeroFill(d)).toBeUndefined();
  });

  it('a big no-signal category dilutes confidence below the threshold', () => {
    const d = det([
      {
        category: 'a',
        family: 'word',
        total: 400,
        levelField: 'log.levelname',
        fills: catFills(400, { levelnameN: 400 }),
      },
      { category: 'b', family: 'none', total: 600, fills: catFills(600) },
    ]);
    expect(confidentZeroFill(d)).toBeUndefined(); // 400 of 1000 = 40% < 50%
  });

  it('empty scope is never confident', () => {
    expect(confidentZeroFill(det([]))).toBeUndefined();
  });
});
