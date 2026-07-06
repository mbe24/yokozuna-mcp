import { describe, expect, it } from 'vitest';
import {
  buildSiblingProbeQuery,
  buildUnderScopeNote,
  exactSourceCategoryTerm,
} from '../src/sumo/underScope.js';

describe('exactSourceCategoryTerm (§0.2.1 #2)', () => {
  it('detects a single exact _sourcecategory term (unquoted and quoted)', () => {
    const a = exactSourceCategoryTerm('_sourcecategory=kubernetes/team/worker')!;
    expect(a.category).toBe('kubernetes/team/worker');
    expect(a.quoted).toBe(false);

    const b = exactSourceCategoryTerm('error _sourcecategory="k8s/team/worker" foo')!;
    expect(b.category).toBe('k8s/team/worker');
    expect(b.quoted).toBe(true);
  });

  it('returns undefined for wildcard, missing, or multiple category terms', () => {
    expect(exactSourceCategoryTerm('_sourcecategory=k8s/team/worker*')).toBeUndefined();
    expect(exactSourceCategoryTerm('some keyword only')).toBeUndefined();
    expect(
      exactSourceCategoryTerm('_sourcecategory=a/b (_sourcecategory=c/d OR _sourcecategory=e/f)'),
    ).toBeUndefined();
  });
});

describe('buildSiblingProbeQuery (§0.2.1 #2)', () => {
  it('widens the exact term to the prefix and appends a volume-only count-by', () => {
    const exact = exactSourceCategoryTerm('_sourcecategory=k8s/team/worker')!;
    const q = buildSiblingProbeQuery('_sourcecategory=k8s/team/worker', exact);
    expect(q).toBe('_sourcecategory=k8s/team/worker* | count by _sourcecategory | sort by _count | limit 100');
    expect(q).not.toContain('where'); // no error predicate over the prefix
  });
});

describe('buildUnderScopeNote (§0.2.1 #2)', () => {
  it('builds the coverage note with top-5 siblings and a "…and K more" tail', () => {
    const rows = [
      { category: 'k8s/team/worker', count: 500 },
      { category: 'k8s/team/worker/script', count: 300 },
      { category: 'k8s/team/worker/cron', count: 200 },
      { category: 'k8s/team/worker/a', count: 40 },
      { category: 'k8s/team/worker/b', count: 30 },
      { category: 'k8s/team/worker/c', count: 20 },
      { category: 'k8s/team/worker/d', count: 10 },
    ];
    const note = buildUnderScopeNote('k8s/team/worker', rows, 500)!;
    expect(note).toContain('you may be under-scoped');
    expect(note).toContain('exact category k8s/team/worker (500 msgs)');
    expect(note).toContain('k8s/team/worker/script (300)');
    expect(note).toContain('…and 1 more'); // 6 siblings (excl. exact), 5 listed
    expect(note).toContain('(total 600 msgs)'); // 300+200+40+30+20+10
    expect(note).toContain('Re-run with _sourcecategory=k8s/team/worker*');
  });

  it('stays silent when siblings are below the volume floor or absent', () => {
    expect(
      buildUnderScopeNote('k8s/team/worker', [{ category: 'k8s/team/worker', count: 500 }], 500),
    ).toBeUndefined();
    expect(
      buildUnderScopeNote(
        'k8s/team/worker',
        [
          { category: 'k8s/team/worker', count: 500 },
          { category: 'k8s/team/worker/tiny', count: 3 },
        ],
        500,
      ),
    ).toBeUndefined();
  });
});
