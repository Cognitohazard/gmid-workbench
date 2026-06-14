import { describe, it, expect } from 'vitest';
import { lookup, lookupByGmId } from './index';
import type { DeviceTable } from '../types';
import { generateDemoDevice } from '../demo';

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

  it('forwards an explicit keys list through to the recovered point', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[0];
    const fwd = lookup(table, { l: L, vgs: 0.6 });
    const back = lookupByGmId(table, fwd.gm_id, L, ['vgs', 'id']);
    expect(Object.keys(back).sort()).toEqual(['id', 'vgs']);
  });
});
