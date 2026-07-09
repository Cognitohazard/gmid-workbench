// By-reference composition: the index (bare-name aliasing, collision markers), the
// resolver (materialization, provenance, cycles, depth, fail-closed misses), flatten
// (ref-free self-contained export), and the runSheet/sweep integration. All docs here
// are bind-less minis so no device table is needed — the physics is covered by the
// library suites, which now resolve the curated refs too.

import { describe, it, expect } from 'vitest';
import {
  buildSheetRefIndex,
  flattenSheetDoc,
  resolveSheetRefs,
  MAX_REF_EXPANSION,
} from './resolve';
import { runSheet, sweepSheet, sweepSheet2 } from './index';
import { validateSheet } from './validate';
import { MAX_USE_DEPTH, type SheetDoc, type SheetUse } from './types';

/** A bind-less leaf: y = 2·x, provided upward, with one hard rule on y. */
const LEAF: SheetDoc = {
  title: 'Leaf',
  polarity: 'n',
  params: [{ name: 'x', value: 2 }],
  rows: [{ name: 'y', expr: '2*x' }],
  rules: [{ id: 'r1', kind: 'requirement', lhs: 'y', op: '>=', rhs: '1' }],
  provide: ['y'],
};

const parent = (use: Partial<SheetUse>): SheetDoc => ({
  title: 'Parent',
  polarity: 'n',
  params: [{ name: 'x_top', value: 3, min: 1, max: 5 }],
  rows: [{ name: 'z', expr: 'c__y + 1' }],
  rules: [],
  uses: [{ name: 'c', params: { x: 'x_top' }, ...use }],
});

const INDEX = buildSheetRefIndex([{ path: 'blocks/leaf', doc: LEAF }]);

describe('buildSheetRefIndex', () => {
  it('serves the full path and a unique bare name as aliases of the same doc', () => {
    expect(INDEX.get('blocks/leaf')).toEqual({ doc: LEAF });
    expect(INDEX.get('leaf')).toEqual({ doc: LEAF });
  });

  it('marks a colliding bare name ambiguous while both full paths stay addressable', () => {
    const other: SheetDoc = { ...LEAF, title: 'Other leaf' };
    const idx = buildSheetRefIndex([
      { path: 'a/leaf', doc: LEAF },
      { path: 'b/leaf', doc: other },
    ]);
    expect(idx.get('a/leaf')).toEqual({ doc: LEAF });
    expect(idx.get('b/leaf')).toEqual({ doc: other });
    expect(idx.get('leaf')).toEqual({ ambiguous: ['a/leaf', 'b/leaf'] });
  });

  it('a repeated full path takes the last entry (re-import replaces)', () => {
    const v2: SheetDoc = { ...LEAF, title: 'Leaf v2' };
    const idx = buildSheetRefIndex([
      { path: 'user/leaf', doc: LEAF },
      { path: 'user/leaf', doc: v2 },
    ]);
    expect(idx.get('user/leaf')).toEqual({ doc: v2 });
    expect(idx.get('leaf')).toEqual({ doc: v2 });
  });

  it('an exact full path beats a bare alias from another folder', () => {
    const other: SheetDoc = { ...LEAF, title: 'Other leaf' };
    const idx = buildSheetRefIndex([
      { path: 'leaf', doc: LEAF },
      { path: 'user/leaf', doc: other },
    ]);
    expect(idx.get('leaf')).toEqual({ doc: LEAF });
    expect(idx.get('user/leaf')).toEqual({ doc: other });
  });
});

describe('resolveSheetRefs', () => {
  it('materializes a ref into its doc, keeping the ref as provenance', () => {
    const raw = parent({ ref: 'blocks/leaf' });
    const r = resolveSheetRefs(raw, INDEX);
    expect(r.warnings).toEqual([]);
    expect(r.doc.uses?.[0].doc).toEqual(LEAF);
    expect(r.doc.uses?.[0].ref).toBe('blocks/leaf');
    // the input doc is untouched — resolution is pure
    expect(raw.uses?.[0].doc).toBeUndefined();
  });

  it('resolves a chain of refs and a ref inside an embedded child', () => {
    const mid: SheetDoc = {
      title: 'Mid',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'inner', ref: 'blocks/leaf' }],
    };
    const idx = buildSheetRefIndex([
      { path: 'blocks/leaf', doc: LEAF },
      { path: 'blocks/mid', doc: mid },
    ]);
    // parent → ref mid → ref leaf, plus parent → embedded doc that itself refs leaf
    const raw: SheetDoc = {
      ...parent({ ref: 'blocks/mid' }),
      uses: [
        { name: 'c', ref: 'blocks/mid' },
        { name: 'e', doc: { ...mid, title: 'Embedded' } },
      ],
    };
    const r = resolveSheetRefs(raw, idx);
    expect(r.warnings).toEqual([]);
    expect(r.doc.uses?.[0].doc?.uses?.[0].doc).toEqual(LEAF);
    expect(r.doc.uses?.[1].doc?.uses?.[0].doc).toEqual(LEAF);
  });

  it('a missing ref warns by id and stays docless (eval then fails closed)', () => {
    const r = resolveSheetRefs(parent({ ref: 'blocks/nope' }), INDEX);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].severity).toBe('error');
    expect(r.warnings[0].message).toContain('"blocks/nope"');
    expect(r.doc.uses?.[0].doc).toBeUndefined();

    const res = runSheet(parent({ ref: 'blocks/nope' }), undefined, undefined, INDEX);
    expect(res.feasible).toBe(false);
    expect(res.children?.[0].feasible).toBe(false);
  });

  it('an ambiguous ref names every qualified candidate', () => {
    const idx = buildSheetRefIndex([
      { path: 'a/leaf', doc: LEAF },
      { path: 'b/leaf', doc: LEAF },
    ]);
    const r = resolveSheetRefs(parent({ ref: 'leaf' }), idx);
    expect(r.warnings[0].message).toContain('a/leaf');
    expect(r.warnings[0].message).toContain('b/leaf');
    expect(r.doc.uses?.[0].doc).toBeUndefined();
  });

  it('detects reference cycles, including self-reference', () => {
    const a: SheetDoc = { ...LEAF, title: 'A', uses: [{ name: 'u', ref: 'x/b' }] };
    const b: SheetDoc = { ...LEAF, title: 'B', uses: [{ name: 'u', ref: 'x/a' }] };
    const idx = buildSheetRefIndex([
      { path: 'x/a', doc: a },
      { path: 'x/b', doc: b },
    ]);
    const r = resolveSheetRefs(parent({ ref: 'x/a' }), idx);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].message).toContain('circular');
    expect(r.warnings[0].message).toContain('x/a -> x/b -> x/a');

    const self: SheetDoc = { ...LEAF, title: 'Self', uses: [{ name: 'u', ref: 'x/self' }] };
    const idx2 = buildSheetRefIndex([{ path: 'x/self', doc: self }]);
    const r2 = resolveSheetRefs(parent({ ref: 'x/self' }), idx2);
    expect(r2.warnings[0].message).toContain('circular');
  });

  it('caps a non-cyclic reference chain at MAX_USE_DEPTH', () => {
    // chain-0 uses chain-1 uses chain-2 … — distinct docs, no cycle, just deep.
    const n = MAX_USE_DEPTH + 2;
    const entries = Array.from({ length: n }, (_, i) => ({
      path: `x/chain-${i}`,
      doc: {
        ...LEAF,
        title: `Chain ${i}`,
        uses: i < n - 1 ? [{ name: 'u', ref: `x/chain-${i + 1}` }] : undefined,
      } as SheetDoc,
    }));
    const idx = buildSheetRefIndex(entries);
    const r = resolveSheetRefs(parent({ ref: 'x/chain-0' }), idx);
    expect(r.warnings.some((w) => w.message.includes(`deeper than ${MAX_USE_DEPTH}`))).toBe(true);
  });

  it('leaves an embedded doc alone even when a ref sits beside it', () => {
    const pinned: SheetDoc = { ...LEAF, title: 'Pinned snapshot' };
    const r = resolveSheetRefs(parent({ ref: 'blocks/leaf', doc: pinned }), INDEX);
    expect(r.warnings).toEqual([]);
    expect(r.doc.uses?.[0].doc?.title).toBe('Pinned snapshot');
  });

  it('caps TOTAL expansion on a fan-out DAG (width^depth is acyclic but explosive)', () => {
    // Each level's 20 uses all reference the next sheet: ~20^7 nodes if unbounded.
    // Duplicate use names are irrelevant here — resolution happens before eval's checks.
    const WIDTH = 20;
    const levels = MAX_USE_DEPTH;
    const entries = Array.from({ length: levels }, (_, i) => ({
      path: `x/fan-${i}`,
      doc: {
        ...LEAF,
        title: `Fan ${i}`,
        uses:
          i < levels - 1
            ? Array.from({ length: WIDTH }, (_, j) => ({ name: `u${j}`, ref: `x/fan-${i + 1}` }))
            : undefined,
      } as SheetDoc,
    }));
    const idx = buildSheetRefIndex(entries);
    const t0 = performance.now();
    const r = resolveSheetRefs(parent({ ref: 'x/fan-0' }), idx);
    expect(performance.now() - t0).toBeLessThan(2000); // terminates promptly, not 20^7
    const capped = r.warnings.filter((w) => w.message.includes(`exceeded ${MAX_REF_EXPANSION}`));
    expect(capped).toHaveLength(1); // one ceiling error, not one per abandoned node
    expect(r.warnings[0].severity).toBe('error'); // fail-closed: blocks feasibility
  });
});

describe('ref’d children under evaluation', () => {
  it('parent overrides flow into the resolved child and provides flow back', () => {
    const res = runSheet(parent({ ref: 'blocks/leaf' }), undefined, undefined, INDEX);
    expect(res.feasible).toBe(true);
    expect(res.values.c__y).toBe(6); // 2 · x_top(3)
    expect(res.values.z).toBe(7);
  });

  it('a ref-carrying doc evaluated WITHOUT an index fails closed', () => {
    const res = runSheet(parent({ ref: 'blocks/leaf' }));
    expect(res.feasible).toBe(false);
    expect(res.warnings.some((w) => w.message.includes('unresolved reference'))).toBe(true);
  });

  it('a ref’d child’s hard rules ride a sweep with path-prefixed ids', () => {
    const sw = sweepSheet(parent({ ref: 'blocks/leaf' }), 'x_top', undefined, 5, undefined, INDEX);
    expect(sw.rules.map((r) => r.id)).toContain('c.r1');
    expect(sw.feasible.every(Boolean)).toBe(true);
  });

  it('refs resolve once for a 2-D sweep, and an unresolvable ref blocks every cell', () => {
    const twoParams = (use: Partial<SheetUse>): SheetDoc => ({
      ...parent(use),
      params: [
        { name: 'x_top', value: 3, min: 1, max: 5 },
        { name: 'k', value: 1, min: 0.5, max: 2 },
      ],
    });
    const ok = sweepSheet2(
      twoParams({ ref: 'blocks/leaf' }),
      'x_top',
      'k',
      undefined,
      3,
      undefined,
      INDEX,
    );
    expect(ok.feasible.flat().every(Boolean)).toBe(true);
    const bad = sweepSheet2(
      twoParams({ ref: 'blocks/nope' }),
      'x_top',
      'k',
      undefined,
      3,
      undefined,
      INDEX,
    );
    expect(bad.feasible.flat().some(Boolean)).toBe(false);
  });
});

describe('flattenSheetDoc', () => {
  it('inlines every ref and strips provenance — a self-contained doc', () => {
    const flat = flattenSheetDoc(parent({ ref: 'blocks/leaf' }), INDEX);
    expect(flat.warnings).toEqual([]);
    expect(flat.doc.uses?.[0].ref).toBeUndefined();
    expect(flat.doc.uses?.[0].doc).toEqual(LEAF);
    expect(JSON.stringify(flat.doc)).not.toContain('"ref"');
    // the flattened doc stands alone: same numbers with NO index supplied
    const res = runSheet(flat.doc);
    expect(res.feasible).toBe(true);
    expect(res.values.z).toBe(7);
  });

  it('keeps an unresolvable ref in place rather than dropping the use', () => {
    const flat = flattenSheetDoc(parent({ ref: 'blocks/nope' }), INDEX);
    expect(flat.warnings).toHaveLength(1);
    expect(flat.doc.uses?.[0].ref).toBe('blocks/nope');
  });
});

describe('validateSheet on raw (unresolved) docs', () => {
  it('accepts a ref-only use and rejects neither/empty', () => {
    expect(validateSheet(parent({ ref: 'blocks/leaf' }))).toEqual([]);
    const neither = validateSheet(parent({})).filter((w) => w.severity === 'error');
    expect(neither.some((w) => w.message.includes('neither an embedded doc nor a ref'))).toBe(true);
    const blank = validateSheet(parent({ ref: '  ' })).filter((w) => w.severity === 'error');
    expect(blank.some((w) => w.message.includes('empty ref'))).toBe(true);
  });
});
