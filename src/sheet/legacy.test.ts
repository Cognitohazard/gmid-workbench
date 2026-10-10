// The earlier key spellings, and the one-level rewrite that loads them. Each expectation is the
// rename table read off by hand.

import { describe, it, expect } from 'vitest';
import { inCurrentKeys } from './legacy';
import { DOC_KEYS, CHECK_KINDS, VAR_KEYS } from './types';

describe('inCurrentKeys — an earlier document in the current vocabulary', () => {
  const earlier = {
    title: 't',
    polarity: 'n',
    params: [{ name: 'x', value: 1, min: 0, max: 2, pin: { lhs: 'y', rhs: '1' } }],
    bind: { L: 'L', id: 'I', gm_id: '10' },
    rows: [{ name: 'y', expr: '2*x' }],
    rules: [
      { id: 'a', kind: 'invariant', lhs: 'y', op: '>=', rhs: '0' },
      { id: 'b', kind: 'requirement', lhs: 'y', op: '>=', rhs: '0' },
      { id: 'c', kind: 'guardrail', lhs: 'y', op: '>=', rhs: '0' },
    ],
    uses: [{ name: 'k', doc: { title: 'k', polarity: 'n', params: [], rows: [], rules: [] } }],
    provide: ['y'],
    edges: [{ name: 'lo', set: { x: '0' } }],
  };

  it('moves every renamed key and kind, and leaves the values as they were', () => {
    const { doc, both } = inCurrentKeys(earlier);
    expect(both).toEqual([]);
    expect(Object.keys(doc).sort()).toEqual(
      [
        'title',
        'polarity',
        'params',
        'givens',
        'equations',
        'checks',
        'blocks',
        'provides',
        'operatingRange',
      ].sort(),
    );
    expect(doc.givens).toBe(earlier.bind);
    expect(doc.equations).toBe(earlier.rows);
    expect(doc.provides).toBe(earlier.provide);
    expect(doc.operatingRange).toBe(earlier.edges);
    expect(doc.params).toEqual([
      { name: 'x', value: 1, min: 0, max: 2, designConstraint: { lhs: 'y', rhs: '1' } },
    ]);
    expect((doc.checks as { kind: string }[]).map((c) => c.kind)).toEqual([
      'physical',
      'spec',
      'advisory',
    ]);
  });

  it('produces only keys and kinds the current format knows', () => {
    const { doc } = inCurrentKeys(earlier);
    for (const k of Object.keys(doc)) expect(DOC_KEYS.has(k)).toBe(true);
    for (const p of doc.params as object[])
      for (const k of Object.keys(p)) expect(VAR_KEYS.has(k)).toBe(true);
    for (const c of doc.checks as { kind: string }[]) expect(CHECK_KINDS.has(c.kind)).toBe(true);
  });

  it("rewrites one level: an embedded child is the walker's to pass back in", () => {
    const { doc } = inCurrentKeys(earlier);
    const child = (doc.blocks as { doc: Record<string, unknown> }[])[0].doc;
    expect(Object.keys(child)).toContain('rows');
    expect(Object.keys(inCurrentKeys(child).doc)).toContain('equations');
  });

  it('leaves a current document exactly as it is', () => {
    const now = inCurrentKeys(earlier).doc;
    expect(inCurrentKeys(now)).toEqual({ doc: now, both: [] });
  });

  it('names a key written in both spellings and merges neither', () => {
    const { doc, both } = inCurrentKeys({
      ...earlier,
      equations: [],
      params: [
        {
          name: 'x',
          value: 1,
          pin: { lhs: 'a', rhs: 'b' },
          designConstraint: { lhs: 'c', rhs: 'd' },
        },
      ],
    });
    expect(both.sort()).toEqual(['params[0].pin and designConstraint', 'rows and equations']);
    expect(doc.equations).toEqual([]);
  });

  it('keeps a key named like the prototype slot as an ordinary key', () => {
    // A parsed file can carry "__proto__" as its own key. It has to stay one — visible to the
    // loader, which reports it as unknown — and never become the object's prototype, where its
    // contents would be read as if the author had written them.
    const raw = JSON.parse('{"title":"t","rules":[],"__proto__":{"equations":[{"name":"y"}]}}');
    const { doc } = inCurrentKeys(raw);
    expect(Object.keys(doc).sort()).toEqual(['__proto__', 'checks', 'title']);
    expect(doc.equations).toBeUndefined();
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
  });

  it('does not repair a value of the wrong shape', () => {
    // The loader's own checks name these; the rename must not hide them.
    const { doc } = inCurrentKeys({ rules: 'nope', params: [7, { name: 'x', pin: 3 }] });
    expect(doc.checks).toBe('nope');
    expect(doc.params).toEqual([7, { name: 'x', designConstraint: 3 }]);
  });
});
