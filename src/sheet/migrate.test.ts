// Migrating a sheet written before the netlist, with a child included by reference, in one step.

import { describe, it, expect } from 'vitest';
import { migrateSheet } from './migrate';
import { buildSheetRefIndex } from './resolve';
import { runSheet, validateSheet } from './index';
import { table } from './library.fixtures';
import type { SheetDoc } from './types';

/** One n device whose drain the given expression places over ground. */
const device = (vds: string, vsb?: string) => ({
  title: 'm',
  polarity: 'n',
  params: [
    { name: 'Vd', value: 0.6 },
    { name: 'Vs', value: 0 },
    { name: 'I', value: 1e-6 },
  ],
  givens: { L: '1e-6', id: 'I', gm_id: '10', vds, ...(vsb ? { vsb } : {}) },
  rows: [],
  rules: [],
  provides: ['vgs', 'W'],
});

/** A bias branch written in the earlier key spellings (`rows`, `rules`, `uses`): two stacked
 *  devices, and its node solved for the lower device's own gate-source voltage with no range. */
const branch = {
  title: 'branch',
  polarity: 'n',
  params: [
    { name: 'VDD_b', value: 1.8 },
    { name: 'V_m', value: 0.5, unit: 'V', solveFor: 'lo__vgs' },
  ],
  uses: [
    { name: 'lo', doc: device('Vd'), params: { Vd: 'V_m' } },
    { name: 'hi', doc: device('Vd - Vs', 'Vs'), params: { Vd: 'VDD_b', Vs: 'V_m' } },
  ],
  rows: [{ name: 'Vnode', expr: 'V_m' }],
  rules: [{ id: 'room', kind: 'invariant', lhs: 'VDD_b - V_m', op: '>=', rhs: '0.2' }],
  provide: ['Vnode'],
};

const top = {
  title: 'top',
  polarity: 'n',
  params: [{ name: 'VDD', value: 1.8, unit: 'V', class: 'independent' }],
  blocks: [{ name: 'bias', ref: 'blocks/branch', params: { VDD_b: 'VDD' } }],
  equations: [{ name: 'Vb', expr: 'bias__Vnode' }],
  checks: [],
};

describe('migrating a composed sheet', () => {
  const m = migrateSheet({ path: 'top', raw: top }, [{ path: 'blocks/branch', raw: branch }]);

  it('writes one document per file, the child by reference again', () => {
    expect(m.refused).toBeUndefined();
    expect(m.documents.map((d) => [d.path, d.changed])).toEqual([
      ['top', true],
      ['blocks/branch', true],
    ]);
    const [t, b] = m.documents.map((d) => d.doc);
    expect(t.formatVersion).toBe(2);
    expect(t.blocks?.[0]).toMatchObject({ name: 'bias', ref: 'blocks/branch' });
    expect(t.blocks?.[0].doc).toBeUndefined();
    expect(t.blocks?.[0].ports).toBeDefined();
    // The child is in the current spellings at every level, and states its own wiring.
    expect(b.formatVersion).toBe(2);
    expect(b.equations.map((e) => e.name)).toEqual(['Vnode']);
    expect(b.checks.map((c) => c.kind)).toEqual(['physical']);
    expect(b.provides).toEqual(['Vnode']);
    expect(b.blocks?.map((x) => x.nodes !== undefined)).toEqual([true, true]);
    expect(b.blocks?.[0].doc?.equations).toEqual([]);
  });

  it('writes a voltage range from the held levels, and says so', () => {
    expect(m.ranges).toEqual([{ at: 'bias', param: 'V_m', written: [0, 1.8] }]);
    const b = m.documents[1].doc;
    expect(b.params.find((p) => p.name === 'V_m')).toMatchObject({ min: 0, max: 1.8 });
    expect(
      m.confirm.some((c) => /solved param "V_m" had no range; written as \[0, 1\.8\] V/.test(c)),
    ).toBe(true);
    expect(m.report).toMatch(/^Migration of "top" to format version 2/);
  });

  it('reads back as a tree that validates and evaluates, solving the node', () => {
    const [t, ...children] = m.documents;
    const refs = buildSheetRefIndex(children.map((d) => ({ path: d.path, doc: d.doc })));
    const res = runSheet(t.doc, table, undefined, refs);
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(res.blocks?.[0].solve).toEqual({ kind: 'settled' });
    expect(res.values.Vb).toBeCloseTo(res.blocks?.[0].blocks?.[0].sizing?.vgs as number, 4);
    expect(validateSheet(t.doc).filter((w) => w.severity === 'error')).toEqual([]);
  });

  it('says what it could not read, rather than migrating around it', () => {
    const r = migrateSheet({ path: 'top', raw: top }, []);
    expect(r.confirm.some((c) => /ref "blocks\/branch" does not match any sheet/.test(c))).toBe(
      true,
    );
    expect(migrateSheet({ path: 'x', raw: 42 }, []).refused).toBeDefined();
    const doc = m.documents[0].doc as SheetDoc;
    expect(doc.title).toBe('top');
  });
});
