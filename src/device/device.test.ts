import { describe, it, expect } from 'vitest';
import { sizeDevice } from './index';
import { lookup } from '../lookup';
import type { DeviceTable } from '../types';
import { generateDemoDevice } from '../demo';

/** A known operating point: forward-lookup the demo at (L, vgs) to get a self-consistent (gm, id, gm/id). */
function knownPoint(table: DeviceTable, L: number, vgs: number) {
  const out = lookup(table, { l: L, vgs });
  return { gm: out.gm, id: out.id, gm_id: out.gm_id, vgs };
}

describe('sizeDevice (bind-any-2)', () => {
  it('binds gm+id at a known point: derives gm_id and a positive W', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1]; // 0.5 µm
    const pt = knownPoint(table, L, 0.6);

    const res = sizeDevice({ table, L, gm: pt.gm, id: pt.id });

    expect(res.gm_id).toBeCloseTo(pt.gm / pt.id, 12);
    expect(res.gm).toBeCloseTo(pt.gm, 12);
    expect(res.id).toBeCloseTo(pt.id, 12);
    expect(res.W).toBeGreaterThan(0);
    expect(Number.isFinite(res.W)).toBe(true);
    // Sizing at the characterization current reproduces the characterization width.
    expect(res.W).toBeCloseTo(table.meta.W as number, 9);
    // The recovered vgs round-trips back to the chosen operating point.
    expect(res.vgs).toBeCloseTo(pt.vgs, 4);
  });

  it('binds gm_id+id: derives gm = gm_id * id', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];
    const pt = knownPoint(table, L, 0.6);

    const res = sizeDevice({ table, L, gm_id: pt.gm_id, id: pt.id });

    expect(res.gm).toBeCloseTo(pt.gm_id * pt.id, 12);
    expect(res.gm).toBeCloseTo(pt.gm, 9);
    expect(res.gm_id).toBeCloseTo(pt.gm_id, 12);
    expect(res.id).toBeCloseTo(pt.id, 12);
    expect(res.W).toBeGreaterThan(0);
  });

  it('binds gm+gm_id: derives id = gm / gm_id', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];
    const pt = knownPoint(table, L, 0.6);

    const res = sizeDevice({ table, L, gm: pt.gm, gm_id: pt.gm_id });

    expect(res.id).toBeCloseTo(pt.gm / pt.gm_id, 12);
    expect(res.id).toBeCloseTo(pt.id, 9);
    expect(res.W).toBeGreaterThan(0);
  });

  it('scales W linearly with the target id (twice the current => twice the width)', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];
    const pt = knownPoint(table, L, 0.6);

    const base = sizeDevice({ table, L, gm_id: pt.gm_id, id: pt.id });
    const doubled = sizeDevice({ table, L, gm_id: pt.gm_id, id: 2 * pt.id });
    expect(doubled.W).toBeCloseTo(2 * base.W, 9);
  });

  it('over-constrained input (all three) throws', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];
    const pt = knownPoint(table, L, 0.6);
    expect(() =>
      sizeDevice({ table, L, gm: pt.gm, gm_id: pt.gm_id, id: pt.id }),
    ).toThrow(/EXACTLY two/);
  });

  it('under-constrained input (only one) throws', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];
    expect(() => sizeDevice({ table, L, id: 1e-6 })).toThrow(/EXACTLY two/);
  });

  it('under-constrained input (none) throws', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];
    expect(() => sizeDevice({ table, L })).toThrow(/EXACTLY two/);
  });

  it('feasible flag is true for a mid-range gm/id', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];

    const res = sizeDevice({ table, L, gm_id: 15, id: 1e-6 });
    expect(res.gm_id).toBe(15);
    expect(res.ceiling).toBeGreaterThan(15);
    expect(res.feasible).toBe(true);
  });

  it('ceiling equals the max gm/id over the L-slice and gates feasibility', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];

    // ceiling ~ 1/(n·UT) ≈ 29.7 for the demo; pick id so gm_id is solvable in range.
    const res = sizeDevice({ table, L, gm_id: 15, id: 1e-6 });
    expect(res.ceiling).toBeGreaterThan(25);
    expect(res.ceiling).toBeLessThan(31);
    // A gm/id above the ceiling is out of the slice range; lookupByGmId rejects it.
    expect(() => sizeDevice({ table, L, gm_id: res.ceiling + 5, id: 1e-6 })).toThrow(
      /out of range/,
    );
  });

  it('reports operating-point quantities at the point', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];
    const pt = knownPoint(table, L, 0.6);

    const res = sizeDevice({ table, L, gm_id: pt.gm_id, id: pt.id });
    for (const key of ['gm', 'id', 'gm_id', 'gds', 'cgg', 'vth', 'W', 'id_w']) {
      expect(res.quantities[key]).toBeDefined();
      expect(Number.isFinite(res.quantities[key])).toBe(true);
    }
    expect(res.quantities.W).toBeCloseTo(res.W, 12);
    expect(res.quantities.id_w).toBeCloseTo(res.id / res.W, 6);
  });
});
