import { describe, it, expect } from 'vitest';
import { lookup, lookupByGmId } from './index';
import { invertX } from '../series';
import { makeGrid } from '../grid';
import type { Axis, DeviceTable } from '../types';
import { generateDemoDevice } from '../demo';
import { importMostab } from '../import';
import { PHYS, GAMMA_DEFAULT } from '../constants';

/** Build a single-L (l, vgs) DeviceTable from explicit gm/id columns so a slice's
 *  gm/id-vs-vgs curve can be made deliberately degenerate (all id==0) or folded
 *  (non-monotone), exercising the inverse guardrail. gm[i]/id[i] is gm/id at vgs[i]. */
function makeFixedLTable(L: number, vgs: number[], gm: number[], id: number[]): DeviceTable {
  const axes: Axis[] = [
    { name: 'l', values: Float64Array.from([L]) },
    { name: 'vgs', values: Float64Array.from(vgs) },
  ];
  const quantities = new Map<string, Float64Array>([
    ['gm', Float64Array.from(gm)],
    ['id', Float64Array.from(id)],
  ]);
  return {
    id: { device: 'fixture', corner: 'tt', temp: 27 },
    grid: makeGrid(axes, quantities),
    meta: { polarity: { device: 'n', signedInput: false } },
  };
}

/** A copy of `table` with the named quantity columns removed (for testing the
 *  measured-noise-absent path now that the demo carries sth/sfl/gamma). */
function stripCols(table: DeviceTable, keys: string[]): DeviceTable {
  const q = new Map(table.grid.quantities);
  for (const k of keys) q.delete(k);
  return { ...table, grid: { ...table.grid, quantities: q } };
}

/** Read the stored column value at the (li, vi) lattice node of a 2-D (l,vgs) grid. */
function nodeValue(table: DeviceTable, key: string, li: number, vi: number): number {
  const col = table.grid.quantities.get(key);
  if (!col) throw new Error(`missing column ${key}`);
  const nVgs = table.grid.shape[1];
  return col[li * nVgs + vi];
}

describe('lookup (forward)', () => {
  it('at an exact grid (l,vgs) node returns the stored column values', () => {
    const table = generateDemoDevice();
    const lAxis = table.grid.axes[0].values;
    const vgsAxis = table.grid.axes[1].values;

    const li = 2;
    const vi = 37;
    const L = lAxis[li];
    const vgs = vgsAxis[vi];

    const out = lookup(table, { l: L, vgs });

    for (const key of ['id', 'gm', 'gds', 'cgg', 'vth', 'vdsat']) {
      expect(out[key]).toBeCloseTo(nodeValue(table, key, li, vi), 9);
    }
    // Axis coordinates are returned exactly.
    expect(out.l).toBeCloseTo(L, 12);
    expect(out.vgs).toBeCloseTo(vgs, 12);
  });

  it('default keys include base columns plus computable standard derived', () => {
    const table = generateDemoDevice();
    const out = lookup(table, { l: table.grid.axes[0].values[0], vgs: 0.6 });

    // Present base columns.
    for (const key of ['id', 'gm', 'gds', 'cgg', 'vth', 'vdsat', 'l', 'vgs']) {
      expect(out[key]).toBeDefined();
    }
    // Standard derived that are computable from {gm,id,gds,cgg}.
    for (const key of ['gm_id', 'gm_gds', 'av0', 'ro', 'ft', 'vstar', 'ft_eff', 'av0_ft']) {
      expect(out[key]).toBeDefined();
      expect(Number.isFinite(out[key])).toBe(true);
    }
    // Not computable: id_w (no w column), gmb_gm (no gmb), cgd_cgg / gm_cgd (no cgd).
    for (const key of ['id_w', 'gmb_gm', 'cgd_cgg', 'gm_cgd']) {
      expect(out[key]).toBeUndefined();
    }
  });

  it('derived are evaluated from the interpolated base scalars (self-consistent)', () => {
    const table = generateDemoDevice();
    const out = lookup(table, { l: 0.5e-6, vgs: 0.55 });

    expect(out.gm_id).toBeCloseTo(out.gm / out.id, 12);
    expect(out.vstar).toBeCloseTo((2 * out.id) / out.gm, 12);
    expect(out.vstar).toBeCloseTo(2 / out.gm_id, 12);
    expect(out.av0).toBeCloseTo(out.gm / out.gds, 12);
    expect(out.ro).toBeCloseTo(1 / out.gds, 12);
    expect(out.ft).toBeCloseTo(out.gm / (2 * Math.PI * out.cgg), 12);
  });

  it('honours an explicit keys list', () => {
    const table = generateDemoDevice();
    const out = lookup(table, { l: 1e-6, vgs: 0.7 }, ['gm', 'gm_id']);
    expect(Object.keys(out).sort()).toEqual(['gm', 'gm_id']);
  });

  it('throws for an unknown requested key', () => {
    const table = generateDemoDevice();
    expect(() => lookup(table, { l: 1e-6, vgs: 0.7 }, ['nope'])).toThrow(/neither a present base/);
  });
});

describe('lookupByGmId (inverse)', () => {
  it('round-trips: pick a vgs, compute its gm/id, recover the vgs', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1]; // an exact L node

    // Pick interior vgs values, forward-lookup gm/id, then invert.
    for (const vgs of [0.45, 0.6, 0.75, 0.9]) {
      const fwd = lookup(table, { l: L, vgs });
      const back = lookupByGmId(table, fwd.gm_id, L);
      expect(back.vgs).toBeCloseTo(vgs, 4);
      // gm/id at the recovered point matches the target.
      expect(back.gm_id).toBeCloseTo(fwd.gm_id, 6);
    }
  });

  it('recovers an exact-node vgs to high precision', () => {
    const table = generateDemoDevice();
    const li = 0;
    const vi = 70;
    const L = table.grid.axes[0].values[li];
    const vgs = table.grid.axes[1].values[vi];

    const gmId = nodeValue(table, 'gm', li, vi) / nodeValue(table, 'id', li, vi);
    const back = lookupByGmId(table, gmId, L);
    expect(back.vgs).toBeCloseTo(vgs, 6);
  });

  it('throws when gm/id is outside the slice range', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[0];
    // gm/id ceiling is ~1/(n·UT) ≈ 29.9 for the demo; 1e6 is well above.
    expect(() => lookupByGmId(table, 1e6, L)).toThrow(/out of range/);
    expect(() => lookupByGmId(table, -1, L)).toThrow(/out of range/);
  });

  it('shares its inverse kernel with series.invertX (agree interior + at endpoints)', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];
    const vgsAxis = table.grid.axes.find((a) => a.name === 'vgs')!.values;

    // An interior gm/ID plus BOTH curve endpoints (max gm/ID at the lowest vgs, min at
    // the highest) — the spots where the old hand-rolled bracket, lacking interp1's ULP
    // clamp, could disagree with the cursor's invertX. They must now match exactly.
    const interior = lookup(table, { l: L, vgs: 0.6 }).gm_id;
    const hiEnd = lookup(table, { l: L, vgs: vgsAxis[0] }).gm_id;
    const loEnd = lookup(table, { l: L, vgs: vgsAxis[vgsAxis.length - 1] }).gm_id;

    for (const gmId of [interior, hiEnd, loEnd]) {
      const viaLookup = lookupByGmId(table, gmId, L).vgs;
      const viaCursor = invertX(table, 'gm/id', gmId, 'vgs', { l: L });
      expect(viaCursor).not.toBeNull();
      expect(viaLookup).toBeCloseTo(viaCursor as number, 12);
    }
  });

  it('forwards an explicit keys list through to the recovered point', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[0];
    const fwd = lookup(table, { l: L, vgs: 0.6 });
    const back = lookupByGmId(table, fwd.gm_id, L, ['vgs', 'id']);
    expect(Object.keys(back).sort()).toEqual(['id', 'vgs']);
  });

  it('models input-referred thermal noise vnth_m = √(4kTγ/gm), falling as gm rises', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[0];
    const weak = lookup(table, { l: L, vgs: 0.45 }); // low gm
    const strong = lookup(table, { l: L, vgs: 0.9 }); // high gm

    // The γ-model quantity is exactly the closed form with the default γ.
    const expected = Math.sqrt((4 * PHYS.k * PHYS.T * GAMMA_DEFAULT) / weak.gm);
    expect(weak.vnth_m).toBeCloseTo(expected, 18);
    expect(weak.svth_m).toBeCloseTo(weak.vnth_m * weak.vnth_m, 30); // PSD = density²

    // Higher gm (stronger inversion) ⇒ lower input-referred thermal noise.
    expect(strong.gm).toBeGreaterThan(weak.gm);
    expect(strong.vnth_m).toBeLessThan(weak.vnth_m);

    // The MEASURED keys need stored PSDs: a device WITHOUT them reports no measured
    // thermal (sth) or flicker (sfl) noise — no model masquerades as data.
    const bare = stripCols(table, ['sth', 'sfl', 'gamma']);
    const w2 = lookup(bare, { l: L, vgs: 0.45 });
    expect(w2.vnth).toBeUndefined();
    expect(w2.svth).toBeUndefined();
    expect(w2.vnfl).toBeUndefined();
    expect(w2.svfl).toBeUndefined();
  });

  it('reports MEASURED thermal + flicker noise from stored sth/sfl PSDs', () => {
    const csv = [
      '# device: noisy',
      '# W: 1e-6',
      'L,VGS,ID,GM,STH,SFL',
      '1e-7,0.4,1e-6,1e-5,4e-21,1e-20',
      '1e-7,0.6,2e-6,3e-5,9e-21,4e-20',
    ].join('\n');
    const res = importMostab(new TextEncoder().encode(csv), { filename: 'noisy.mostab.csv' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = lookup(res.dataset.tables[0], { l: 1e-7, vgs: 0.4 }); // node: sth=4e-21, sfl=1e-20, gm=1e-5
    expect(out.svth).toBeCloseTo(4e-21 / 1e-5 ** 2, 18); // thermal input-referred PSD
    expect(out.vnth).toBeCloseTo(Math.sqrt(4e-21) / 1e-5, 18); // thermal density = √PSD
    expect(out.svfl).toBeCloseTo(1e-20 / 1e-5 ** 2, 18); // flicker input-referred PSD @1Hz
    expect(out.vnfl).toBeCloseTo(Math.sqrt(1e-20) / 1e-5, 18); // flicker density @1Hz
  });

  it('fails closed on a degenerate slice where every id==0 (gm/id is ±∞ everywhere)', () => {
    // id==0 at every vgs node makes gm/id = ±∞, so orient drops every node and its
    // bounds are NaN; the range gate (gmId < NaN || gmId > NaN) is false, so the old
    // code interpolated an empty curve to NaN and forward-looked-up at vgs:NaN —
    // fabricating an operating point. The sizer must throw instead.
    const L = 1e-7;
    const vgs = [0.3, 0.4, 0.5, 0.6];
    const gm = [1e-5, 2e-5, 3e-5, 4e-5]; // nonzero
    const id = [0, 0, 0, 0]; // every sample id==0
    const table = makeFixedLTable(L, vgs, gm, id);

    let result: Record<string, number> | null = null;
    let threw = false;
    try {
      result = lookupByGmId(table, 10, L);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // And specifically: no fabricated record with a NaN vgs/quantity leaked out.
    expect(result).toBeNull();
    expect(() => lookupByGmId(table, 10, L)).toThrow(/invertible/);
  });

  it('fails closed on a folded (non-monotone) gm/id-vs-vgs slice instead of sizing an arbitrary branch', () => {
    // gm/id rises 1→2→3 then falls 3→2→1 across vgs: total variation (4) exceeds the
    // span (2) by more than FOLD_TOL, so orient.mono is false. The target gmId=2 sits
    // inside [xmin,xmax]=[1,3], so the range gate passes; without honouring o.mono the
    // old code interp1'd against an arbitrary sorted branch and returned a value.
    const L = 1e-7;
    const vgs = [0.3, 0.4, 0.5, 0.6, 0.7];
    const id = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6];
    const gm = [1e-6, 2e-6, 3e-6, 2e-6, 1e-6]; // gm/id = [1,2,3,2,1] — a fold
    const table = makeFixedLTable(L, vgs, gm, id);

    expect(() => lookupByGmId(table, 2, L)).toThrow(/monoton/);
  });
});
