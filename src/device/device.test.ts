import { describe, it, expect } from 'vitest';
import { sizeDevice, mismatch, thermalNoise } from './index';
import { lookup } from '../lookup';
import type { DeviceTable } from '../types';
import { generateDemoDevice } from '../demo';
import { PHYS, GAMMA_DEFAULT } from '../constants';

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

describe('mismatch (Pelgrom budget)', () => {
  const c = { avth: 4e-9, abeta: 1e-8 }; // 4 mV·µm, 1 %·µm

  it('σ scales as 1/√area: 4× the area halves every spread', () => {
    const a = mismatch(1e-6, 1e-7, 15, c);
    const b = mismatch(4e-6, 1e-7, 15, c); // 4× width → 2× √area
    expect(b.sigmaVth).toBeCloseTo(a.sigmaVth / 2, 18);
    expect(b.sigmaBeta).toBeCloseTo(a.sigmaBeta / 2, 18);
    expect(b.sigmaVos).toBeCloseTo(a.sigmaVos / 2, 18);
  });

  it('matches the closed-form pair offset and mirror current spread', () => {
    const W = 2e-6,
      L = 1.8e-7,
      gmId = 20;
    const r = mismatch(W, L, gmId, c);
    const sVth = 4e-9 / Math.sqrt(W * L);
    const sB = 1e-8 / Math.sqrt(W * L);
    expect(r.sigmaVth).toBeCloseTo(sVth, 18);
    expect(r.sigmaVos).toBeCloseTo(Math.SQRT2 * Math.hypot(sVth, sB / gmId), 18);
    expect(r.sigmaIrel).toBeCloseTo(Math.hypot(gmId * sVth, sB), 18);
  });

  it('gm/ID is the matching-vs-bias knob: higher gm/ID lowers offset, raises current spread', () => {
    const lo = mismatch(2e-6, 1.8e-7, 8, c); // low gm/ID
    const hi = mismatch(2e-6, 1.8e-7, 25, c); // high gm/ID
    expect(hi.sigmaVos).toBeLessThan(lo.sigmaVos); // β term referred in by 1/(gm/ID)
    expect(hi.sigmaIrel).toBeGreaterThan(lo.sigmaIrel); // Vth amplified by gm/ID
    expect(hi.sigmaVth).toBeCloseTo(lo.sigmaVth, 18); // Vth spread is bias-independent
  });
});

describe('thermalNoise', () => {
  it('is √(4kTγ/gm) and falls as 1/√gm (width-dependent)', () => {
    const v1 = thermalNoise(1e-3);
    const v4 = thermalNoise(4e-3); // 4× gm (≈4× width) → half the noise density
    expect(v4).toBeCloseTo(v1 / 2, 18);
    expect(v1).toBeCloseTo(Math.sqrt((4 * PHYS.k * PHYS.T * GAMMA_DEFAULT) / 1e-3), 30);
  });

  it('honors an explicit operating-point γ over the default', () => {
    expect(thermalNoise(1e-3, 1.5)).toBeGreaterThan(thermalNoise(1e-3)); // γ>default ⇒ more noise
  });

  it('must use the SIZED gm, not the characterization-width derived value', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];
    const res = sizeDevice({ table, L, gm_id: 12, id: 50e-6 });
    const sized = thermalNoise(res.gm, res.quantities.gamma); // correct: sized gm
    // The model vnth_m inside res.quantities is at W_char, so gm differs ⇒ noise differs.
    expect(sized).not.toBeCloseTo(res.quantities.vnth_m, 12);
    expect(sized).toBeCloseTo(Math.sqrt((4 * PHYS.k * PHYS.T * GAMMA_DEFAULT) / res.gm), 30);
  });
});
