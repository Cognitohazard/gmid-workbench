import { describe, it, expect } from 'vitest';
import { LookupRangeError } from '../types';
import {
  sizeDevice,
  sizeableLengths,
  OP_SELECTORS,
  mismatch,
  thermalNoise,
  integratedNoise,
} from './index';
import { lookup } from '../lookup';
import { makeGrid, sliceGrid } from '../grid';
import type { DeviceTable } from '../types';
import { generateDemoDevice, signedMirrorDemo, withoutColumns } from '../demo';
import { PHYS, GAMMA_DEFAULT } from '../constants';
import { compileExpr } from '../derive';
import { ExprError } from '../types';

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
    expect(() => sizeDevice({ table, L, gm: pt.gm, gm_id: pt.gm_id, id: pt.id })).toThrow(
      /EXACTLY two/,
    );
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

  it('guards an id==0 (infinite-ratio) sample so the gm/ID ceiling stays finite', () => {
    // A slice carrying one id==0 sample: gm/id there is ∞. Before the guard the ceiling
    // scan took max = Infinity, so feasibility (gm_id <= ceiling) was vacuously true.
    const l = new Float64Array([1e-7]);
    const vgs = new Float64Array([0.2, 0.4, 0.6, 0.8]);
    const gm = new Float64Array([1e-5, 2e-5, 2.4e-5, 2.7e-5]);
    const id = new Float64Array([0, 1e-6, 2e-6, 3e-6]); // node 0: id==0 ⇒ gm/id = ∞
    const table: DeviceTable = {
      id: { device: 'n', corner: 'tt', temp: 27 },
      grid: makeGrid(
        [
          { name: 'l', values: l },
          { name: 'vgs', values: vgs },
        ],
        new Map([
          ['gm', gm],
          ['id', id],
        ]),
      ),
      meta: { W: 1e-6 },
    };

    const res = sizeDevice({ table, L: 1e-7, gm_id: 15, id: 1e-6 });
    expect(Number.isFinite(res.ceiling)).toBe(true); // not Infinity
    expect(res.ceiling).toBeCloseTo(20, 9); // max(20, 12, 9) over the FINITE samples
    expect(res.feasible).toBe(true); // 15 <= 20

    // A gm/ID above the finite ceiling is out of the bracketable range (the ∞ node no
    // longer widens it), so it is rejected — not silently sized as "feasible".
    expect(() => sizeDevice({ table, L: 1e-7, gm_id: 25, id: 1e-6 })).toThrow(/out of range/);
  });

  it('warns (not silently) when the requested L falls off the table L hull', () => {
    const table = generateDemoDevice();
    const offL = 5e-6; // above the demo's max L (2 µm); locate() clamps to the nearest node
    const res = sizeDevice({ table, L: offL, gm_id: 15, id: 1e-6 });
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings.some((w) => /L range/.test(w))).toBe(true);

    // An in-range L (an exact node) raises no such warning.
    const inL = table.grid.axes[0].values[1];
    const ok = sizeDevice({ table, L: inL, gm_id: 15, id: 1e-6 });
    expect(ok.warnings).toEqual([]);
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
    // w0 is the characterization width — pinned directly (not via a ratio) so a w0:W
    // mis-report is observable rather than cancelling in a width-referral consumer.
    expect(res.quantities.w0).toBeCloseTo(table.meta.W as number, 18);
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

describe('integratedNoise (thermal + 1/f over a band)', () => {
  const sth = 1e-17; // V²/Hz white floor

  it('thermal-only (fc=0) integrates the white floor: √(Sth·BW)', () => {
    expect(integratedNoise(sth, 0, 1, 1e6)).toBeCloseTo(Math.sqrt(sth * (1e6 - 1)), 18);
  });

  it('adds the 1/f tail as Sth·fc·ln(fHi/fLo)', () => {
    const fc = 1e3;
    const expected = Math.sqrt(sth * (1e6 - 1 + fc * Math.log(1e6 / 1)));
    expect(integratedNoise(sth, fc, 1, 1e6)).toBeCloseTo(expected, 18);
  });

  it('grows with the flicker corner and with bandwidth', () => {
    expect(integratedNoise(sth, 1e5, 1, 1e6)).toBeGreaterThan(integratedNoise(sth, 1e2, 1, 1e6));
    expect(integratedNoise(sth, 1e3, 1, 1e7)).toBeGreaterThan(integratedNoise(sth, 1e3, 1, 1e6));
  });

  it('throws on violated preconditions instead of returning NaN/Infinity', () => {
    expect(() => integratedNoise(sth, 0, 0, 1e6)).toThrow(/fLo/); // fLo=0 diverges
    expect(() => integratedNoise(sth, 0, 1e6, 1e3)).toThrow(/fLo/); // fHi < fLo
    expect(() => integratedNoise(sth, -1, 1, 1e6)).toThrow(/fc/);
    expect(() => integratedNoise(-1e-17, 0, 1, 1e6)).toThrow(/sth/);
    expect(() => integratedNoise(sth, 0, 1, Infinity)).toThrow(/finite/);
  });
});

describe('argument validation', () => {
  it('sizeDevice rejects a supplied NaN by name (not a downstream lookup error)', () => {
    const table = generateDemoDevice();
    const L = table.grid.axes[0].values[1];
    expect(() => sizeDevice({ table, L, gm: NaN, id: 1e-5 })).toThrow(/gm must be a finite/);
    expect(() => sizeDevice({ table, L, gm_id: 12, id: Infinity })).toThrow(/id must be a finite/);
  });

  it('mismatch rejects non-positive geometry/bias and negative coefficients', () => {
    const c = { avth: 3.5e-9, abeta: 1e-8 };
    expect(() => mismatch(0, 1e-7, 15, c)).toThrow(/W > 0/);
    expect(() => mismatch(1e-6, -1e-7, 15, c)).toThrow(/L > 0/);
    expect(() => mismatch(1e-6, 1e-7, 0, c)).toThrow(/gm_id > 0/);
    expect(() => mismatch(1e-6, 1e-7, 15, { avth: -1, abeta: 0 })).toThrow(/>= 0/);
  });
});

describe('thermalNoise temperature', () => {
  it('scales kT with the table temperature instead of pinning 27 °C', () => {
    const gm = 1e-3;
    const at27 = thermalNoise(gm); // default T = 300.15 K
    const at125 = thermalNoise(gm, undefined, 125); // 398.15 K
    // vnth ∝ √T at fixed gm and γ.
    expect(at125 / at27).toBeCloseTo(Math.sqrt((125 + 273.15) / PHYS.T), 12);
    // 27 °C explicitly matches the default exactly.
    expect(thermalNoise(gm, undefined, 27)).toBeCloseTo(at27, 15);
  });
});

describe('sizeDevice — unphysical binds are rejected', () => {
  const table = generateDemoDevice();
  const L = table.grid.axes[0].values[1];

  it('throws by name on a non-positive supplied quantity', () => {
    expect(() => sizeDevice({ table, L, gm: -1e-3, gm_id: 12 })).toThrow(/gm must be > 0/);
    expect(() => sizeDevice({ table, L, gm_id: 12, id: 0 })).toThrow(/id must be > 0/);
    expect(() => sizeDevice({ table, L, gm_id: -12, id: 1e-5 })).toThrow(/gm_id must be > 0/);
  });

  it('throws when the DERIVED third quantity is non-positive (sign disagreement)', () => {
    // gm > 0 with id < 0 derives gm_id < 0 — the bind is internally inconsistent
    // with magnitude tables and must fail here, not size a negative width.
    expect(() => sizeDevice({ table, L, gm: 1e-3, id: -1e-5 })).toThrow(/must be > 0/);
  });
});

describe('sizeDevice — quantities describe the SIZED device (width rescale)', () => {
  const table = generateDemoDevice();
  const L = table.grid.axes[0].values[1];

  it('parallel-composition invariance: per-width quantities scale by W/w0, ratios do not', () => {
    const res = sizeDevice({ table, L, gm_id: 12, id: 20e-6 });
    const w0 = table.meta.W as number;
    const k = res.W / w0;
    const char = lookup(table, { l: L, vgs: res.vgs }); // characterization-width point
    expect(res.quantities.gds).toBeCloseTo(char.gds * k, 15);
    expect(res.quantities.cgg).toBeCloseTo(char.cgg * k, 20);
    expect(res.quantities.w).toBeCloseTo(res.W, 12);
    // intensive quantities unchanged
    expect(res.quantities.vstar).toBeCloseTo(char.vstar, 12);
    expect(res.quantities.av0).toBeCloseTo(char.av0, 9);
    expect(res.quantities.id_w).toBeCloseTo(char.id / w0, 18);
  });

  it('hand-written author math now agrees with the derived ratios (the gm/gds trap)', () => {
    const res = sizeDevice({ table, L, gm_id: 12, id: 20e-6 });
    const q = res.quantities;
    // Before the rescale, gm/gds disagreed with av0 by the width ratio W/w0 (a silent
    // ~2–20× gain error). Now the only residue is the inverse-lookup interpolation gap
    // between the BOUND gm (the exact design target, overlaid) and the table's gm at
    // the recovered vgs — sub-percent on the demo grid, versus ×k before.
    expect(Math.abs(q.gm / q.gds / q.av0 - 1)).toBeLessThan(0.01);
    expect(Math.abs(q.gm / (2 * Math.PI * q.cgg) / q.ft - 1)).toBeLessThan(0.01);
    // ro is derived from the same scaled gds — exact.
    expect(1 / q.gds / q.ro).toBeCloseTo(1, 12);
  });
});

describe('sizeDevice — width-first binding (any 2 of {gm, gm_id, id, W})', () => {
  const table = generateDemoDevice();
  const L = table.grid.axes[0].values[1];
  // Reference point from the classic electrical bind.
  const ref = sizeDevice({ table, L, gm_id: 12, id: 20e-6 });

  it('W + gm_id recovers the same operating point as the electrical bind', () => {
    const res = sizeDevice({ table, L, W: ref.W, gm_id: 12 });
    expect(res.vgs).toBeCloseTo(ref.vgs, 12);
    expect(res.id).toBeCloseTo(ref.id, 12);
    expect(res.gm).toBeCloseTo(ref.gm, 12);
  });

  // The W+id / W+gm paths invert the raw COLUMN curve, while the reference inverted the
  // gm/id RATIO curve; between grid nodes the two piecewise-linear interpolants differ at
  // sub-percent level, so the round-trips below assert grid-interpolation agreement (and
  // exactness of the supplied quantities), not bit equality.
  it('W + id inverts the current-density curve back to the same point', () => {
    const res = sizeDevice({ table, L, W: ref.W, id: ref.id });
    expect(res.id).toBe(ref.id); // supplied — exact
    expect(res.W).toBe(ref.W);
    expect(Math.abs(res.vgs - ref.vgs)).toBeLessThan(1e-3);
    expect(Math.abs(res.gm_id / ref.gm_id - 1)).toBeLessThan(0.01);
  });

  it('W + gm inverts the gm-density curve back to the same point', () => {
    const res = sizeDevice({ table, L, W: ref.W, gm: ref.gm });
    expect(res.gm).toBe(ref.gm); // supplied — exact
    expect(Math.abs(res.vgs - ref.vgs)).toBeLessThan(1e-3);
    expect(Math.abs(res.gm_id / ref.gm_id - 1)).toBeLessThan(0.01);
  });

  it('rejects three bound quantities and a non-positive W by name', () => {
    expect(() => sizeDevice({ table, L, W: 1e-6, gm_id: 12, id: 1e-6 })).toThrow(/EXACTLY two/);
    expect(() => sizeDevice({ table, L, W: -1e-6, gm_id: 12 })).toThrow(/W must be > 0/);
  });
});

describe('author-callable oracles (registered expression functions)', () => {
  it('noise_rms / pelgrom_vos / pelgrom_irel call the core implementations', () => {
    const scope = {
      resolve: (n: string) =>
        ({ sth: 1e-16, fc: 1e4, flo: 1, fhi: 1e6, avt: 5e-9, ab: 1e-8, W: 1e-5, L: 1e-6, g: 12 })[
          n
        ],
    };
    expect(compileExpr('noise_rms(sth, fc, flo, fhi)').eval(scope)).toBeCloseTo(
      integratedNoise(1e-16, 1e4, 1, 1e6),
      18,
    );
    expect(compileExpr('pelgrom_vos(avt, ab, W, L, g)').eval(scope)).toBeCloseTo(
      mismatch(1e-5, 1e-6, 12, { avth: 5e-9, abeta: 1e-8 }).sigmaVos,
      18,
    );
    expect(compileExpr('pelgrom_irel(avt, ab, W, L, g)').eval(scope)).toBeCloseTo(
      mismatch(1e-5, 1e-6, 12, { avth: 5e-9, abeta: 1e-8 }).sigmaIrel,
      18,
    );
  });

  it('a violated precondition surfaces as an engine error (na chip), not a crash', () => {
    const scope = { resolve: () => undefined };
    expect(() => compileExpr('noise_rms(0-1e-16, 1e4, 1, 1e6)').eval(scope)).toThrow(ExprError);
  });
});

describe('sizeDevice — spec-first binds (fT, intrinsic gain, V*)', () => {
  const table = generateDemoDevice();
  const L = table.grid.axes[0].values[1]; // 0.5 µm

  it('round-trips fT: re-binding the fT a gm/ID sizing produced recovers that same device', () => {
    const pt = knownPoint(table, L, 0.6);
    const byGmId = sizeDevice({ table, L, gm_id: pt.gm_id, id: pt.id });
    const byFt = sizeDevice({ table, L, ft: byGmId.quantities.ft, id: pt.id });

    expect(byFt.vgs).toBeCloseTo(byGmId.vgs, 6);
    expect(byFt.gm_id).toBeCloseTo(byGmId.gm_id, 6);
    expect(byFt.W / byGmId.W).toBeCloseTo(1, 9);
    // And the device that comes back actually meets the spec it was sized to.
    expect(byFt.quantities.ft / byGmId.quantities.ft).toBeCloseTo(1, 9);
  });

  it('binds intrinsic gain, landing on the requested gm/gds', () => {
    const target = lookup(table, { l: L, vgs: 0.55 }).gm_gds;
    const res = sizeDevice({ table, L, gm_gds: target, id: 2e-5 });

    expect(res.quantities.gm_gds / target).toBeCloseTo(1, 6);
    expect(res.id).toBeCloseTo(2e-5, 12);
    expect(res.W).toBeGreaterThan(0);
    // av0 is the same namespace expression, so it must select the same point.
    const byAv0 = sizeDevice({ table, L, av0: target, id: 2e-5 });
    expect(byAv0.vgs).toBeCloseTo(res.vgs, 12);
  });

  it('a selector carries no size: fT + W and fT + ID agree on the operating point', () => {
    const ft = lookup(table, { l: L, vgs: 0.6 }).ft;
    const byId = sizeDevice({ table, L, ft, id: 2e-5 });
    const byW = sizeDevice({ table, L, ft, W: byId.W });

    expect(byW.vgs).toBeCloseTo(byId.vgs, 12);
    expect(byW.gm_id).toBeCloseTo(byId.gm_id, 12);
    expect(byW.id / byId.id).toBeCloseTo(1, 9);
  });

  it('binds V* exactly equivalently to the matching gm/ID', () => {
    const pt = knownPoint(table, L, 0.6);
    const byVstar = sizeDevice({ table, L, vstar: 2 / pt.gm_id, id: pt.id });
    const byGmId = sizeDevice({ table, L, gm_id: pt.gm_id, id: pt.id });

    expect(byVstar.gm_id).toBeCloseTo(byGmId.gm_id, 12);
    expect(byVstar.W / byGmId.W).toBeCloseTo(1, 6);
  });

  it('refuses two operating-point selectors, naming the two supplied and the remedy', () => {
    const overDetermined = (): unknown => sizeDevice({ table, L, ft: 1e9, gm_id: 15 });
    expect(overDetermined).toThrow(/both set the operating point/);
    expect(overDetermined).toThrow(/gm_id and ft/);
    expect(overDetermined).not.toThrow(/vstar/); // the two supplied, not the whole list
    expect(overDetermined).toThrow(/\{gm, id, W\}/); // remedy is a SIZE quantity, never a selector
    expect(() => sizeDevice({ table, L, gm_gds: 40, vstar: 0.2 })).toThrow(
      /both set the operating point/,
    );
  });

  it('names the column the table lacks rather than failing as an out-of-range bind', () => {
    expect(() =>
      sizeDevice({ table: withoutColumns(table, ['cgg']), L, ft: 1e9, id: 2e-5 }),
    ).toThrow(/carries no "cgg"/);
    expect(() =>
      sizeDevice({ table: withoutColumns(table, ['gds']), L, gm_gds: 40, id: 2e-5 }),
    ).toThrow(/carries no "gds"/);
  });

  it('reports an unreachable spec as out of range, with the lengths that do reach it', () => {
    // Far past any fT the demo can deliver at any length.
    const absurd = 1e15;
    expect(() => sizeDevice({ table, L, ft: absurd, id: 2e-5 })).toThrow(/out of range/);
    expect(sizeableLengths({ table, L, ft: absurd, id: 2e-5 })).toEqual([]);
  });

  it('every operating-point selector is width-invariant — the property the bind rule rests on', () => {
    // If a per-width quantity were ever added to OP_SELECTORS it would pin the operating
    // point differently at every size, and the bind would silently size wrong. Scaling the
    // current 7x must scale the width 7x and leave every selector untouched.
    const pt = knownPoint(table, L, 0.6);
    const small = sizeDevice({ table, L, gm_id: pt.gm_id, id: pt.id });
    const big = sizeDevice({ table, L, gm_id: pt.gm_id, id: pt.id * 7 });

    expect(big.W / small.W).toBeCloseTo(7, 6);
    for (const key of OP_SELECTORS) {
      expect(big.quantities[key] / small.quantities[key]).toBeCloseTo(1, 9);
    }
  });

  it('a stored column never shadows a derived target — the namespace definition wins', () => {
    // An export may carry its own `ft` column under a different convention (here a
    // cgs-flavoured one, 30% off). Inverting THAT curve would place the operating point
    // where nothing else in the result agrees: the sizer would report an fT it was not
    // asked for, silently. Everything downstream re-derives ft from gm and cgg, so the
    // inverse must too.
    const quantities = new Map(table.grid.quantities);
    const cgg = quantities.get('cgg') as Float64Array;
    const gmCol = quantities.get('gm') as Float64Array;
    const bogus = new Float64Array(gmCol.length);
    for (let i = 0; i < bogus.length; i++) bogus[i] = gmCol[i] / (2 * Math.PI * 0.7 * cgg[i]);
    quantities.set('ft', bogus);
    const shadowed: DeviceTable = { ...table, grid: makeGrid([...table.grid.axes], quantities) };

    const target = lookup(table, { l: L, vgs: 0.6 }).ft;
    const res = sizeDevice({ table: shadowed, L, ft: target, id: 2e-5 });

    expect(res.quantities.ft / target).toBeCloseTo(1, 9);
    expect(res.vgs).toBeCloseTo(sizeDevice({ table, L, ft: target, id: 2e-5 }).vgs, 12);
  });

  it('carries the achievable range as data, in the quantity that was bound', () => {
    // The UI restates this range instead of parsing the message, so min/max must be the
    // right way round and in the caller's units — a swap would print the range backwards.
    const target = 1e15;
    let caught: unknown;
    try {
      sizeDevice({ table, L, ft: target, id: 2e-5 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LookupRangeError);
    const e = caught as LookupRangeError;
    expect(e.key).toBe('ft');
    expect(e.target).toBe(target);
    expect(e.L).toBe(L);
    expect(e.min).toBeLessThan(e.max);
    // The top of the range is the fT at the top of the vgs sweep on this slice.
    const vgsAxis = table.grid.axes.find((a) => a.name === 'vgs') as { values: Float64Array };
    const vgsTop = vgsAxis.values[vgsAxis.values.length - 1];
    expect(e.max / lookup(table, { l: L, vgs: vgsTop }).ft).toBeCloseTo(1, 9);

    // A width-first bind reports the gm the caller asked for, NOT the internal density
    // target (gm·w0/W) the lookup actually inverted.
    const w0 = table.meta.W as number;
    let wide: unknown;
    try {
      sizeDevice({ table, L, W: 1e3 * w0, gm: 1e-12 });
    } catch (err) {
      wide = err;
    }
    expect(wide).toBeInstanceOf(LookupRangeError);
    expect((wide as LookupRangeError).key).toBe('gm');
    expect((wide as LookupRangeError).target).toBe(1e-12);
  });

  it('sizes a signed PMOS table identically — magnitudes bind, the axis stays signed', () => {
    // Value columns are canonicalized to magnitudes on import while the swept vgs axis stays
    // negative, so a spec-first bind must give the same geometry as the NMOS twin and return
    // the signed operating point rather than a mirrored magnitude.
    const p = signedMirrorDemo(table);
    const ft = lookup(table, { l: L, vgs: 0.6 }).ft;
    const n = sizeDevice({ table, L, ft, id: 2e-5 });
    const res = sizeDevice({ table: p, L, ft, id: 2e-5 });

    expect(res.W / n.W).toBeCloseTo(1, 9);
    expect(res.gm_id).toBeCloseTo(n.gm_id, 9);
    expect(res.vgs).toBeCloseTo(-n.vgs, 9);
    expect(res.quantities.ft / ft).toBeCloseTo(1, 9);
  });

  it('sizeableLengths agrees exactly with where sizing succeeds', () => {
    // A target the short devices reach and the long ones cannot: fT falls with L.
    const lAxis = table.grid.axes[0].values;
    const target = lookup(table, { l: lAxis[0], vgs: 0.7 }).ft;
    const reachable = sizeableLengths({ table, L, ft: target, id: 2e-5 });

    expect(reachable.length).toBeGreaterThan(0);
    expect(reachable.length).toBeLessThan(lAxis.length); // a real subset, not "everything"
    // Axis order, so the UI can list lengths shortest-first without re-sorting.
    expect([...reachable]).toEqual([...reachable].sort((a, b) => a - b));
    for (const len of lAxis) {
      const sized = (): unknown => sizeDevice({ table, L: len, ft: target, id: 2e-5 });
      if (reachable.includes(len)) expect(sized).not.toThrow();
      else expect(sized).toThrow();
    }
  });
});

// ── the gate tie: binding vgs ─────────────────────────────────────────────────
// The demo model cannot tell a shared gate from a shared gm/ID. Its channel-length
// modulation multiplies id and gm by the SAME factor (1 + vds/VA), so the factor cancels out
// of every ratio and gm/ID is exactly independent of the drain voltage — two devices holding
// one gm/ID therefore land on one gate voltage no matter how far apart their drains sit.
// Measured silicon has no such cancellation. So the oracle below is an algebraic device where
// the two CLM slopes DIFFER, which is the whole of what separates the two statements:
//
//   id(vgs, vds) = ID_SLOPE * vgs * (1 + vds/VA_ID)   [A at the characterization width]
//   gm(vgs, vds) = GM0             * (1 + vds/VA_GM)  [S at the characterization width]
//   ⇒ gm/ID     = (GM0/ID_SLOPE) * (1/vgs) * (1 + vds/VA_GM)/(1 + vds/VA_ID)
//
// Every column is bilinear in (vgs, vds), so the grid's multilinear interpolation reproduces
// it EXACTLY, and gm/ID is strictly decreasing in vgs, so the inverse lookup is unambiguous.
// It is not a physical model and is not meant to be: it is the smallest device on which the
// two ways of writing a mirror give different currents, and both currents are closed form.
const GT_ID_SLOPE = 1e-5; // A per volt of vgs, at the characterization width
const GT_GM0 = 1e-5; // S, at the characterization width
const GT_VA_ID = 1; // V — the current's CLM slope
const GT_VA_GM = 4; // V — the transconductance's, deliberately different
const GT_W0 = 1e-6; // m, the characterization width
const GT_L = 1e-6; // m, the single characterized length
/** vgs nodes 0.05 … 1.00. The step puts both operating points used below exactly ON a node,
 *  so the inversion is a node hit rather than a piecewise-linear approximation of one. */
const GT_VGS = Array.from({ length: 20 }, (_, i) => (i + 1) * 0.05);
const GT_VDS = [0, 2];

/** The oracle table over [l, vds, vgs]. */
function gateTieTable(): DeviceTable {
  const axes = [
    { name: 'l', values: Float64Array.from([GT_L]) },
    { name: 'vds', values: Float64Array.from(GT_VDS) },
    { name: 'vgs', values: Float64Array.from(GT_VGS) },
  ];
  const size = GT_VDS.length * GT_VGS.length;
  const id = new Float64Array(size);
  const gm = new Float64Array(size);
  let at = 0;
  for (const vds of GT_VDS) {
    for (const vgs of GT_VGS) {
      id[at] = GT_ID_SLOPE * vgs * (1 + vds / GT_VA_ID);
      gm[at] = GT_GM0 * (1 + vds / GT_VA_GM);
      at++;
    }
  }
  return {
    id: { device: 'algebraic', corner: 'tt', temp: 27 },
    grid: makeGrid(axes, new Map([['id', id] as const, ['gm', gm] as const])),
    meta: { W: GT_W0 },
  };
}

/** The oracle at one drain voltage — what a sheet's declared bias hands the sizer. */
function gateTieAt(vds: number): DeviceTable {
  const t = gateTieTable();
  return { ...t, grid: sliceGrid(t.grid, { vds }) };
}

describe('sizeDevice — a bound gate-source voltage', () => {
  it('places the device at the gate voltage given, on the table current density there', () => {
    // At vds = 0: id = 1e-5·vgs per w0 = 1 µm, gm = 1e-5 per w0, both flat in vds' absence.
    // At vgs = 0.4 and W = 3 µm (three characterization widths):
    //   id = 1e-5 · 0.4 · 3 = 12 µA,  gm = 1e-5 · 3 = 30 µS,  gm/ID = 30/12 = 2.5 1/V.
    const res = sizeDevice({ table: gateTieAt(0), L: GT_L, vgs: 0.4, W: 3 * GT_W0 });

    expect(res.vgs).toBeCloseTo(0.4, 15);
    expect(res.id).toBeCloseTo(12e-6, 15);
    expect(res.gm).toBeCloseTo(30e-6, 15);
    expect(res.gm_id).toBeCloseTo(2.5, 12);
    expect(res.W).toBeCloseTo(3 * GT_W0, 15);
    expect(res.warnings).toEqual([]);
  });

  it('carries no size information: the same gate voltage at 7x the current is 7x the width', () => {
    // The property every operating-point selector rests on, asserted of the new one as the
    // BINDING quantity rather than only as a reported one. On the oracle table the width is
    // closed form — at vgs = 0.4 the density is 1e-5·0.4 = 4 µA per w0, so 12 µA is 3·w0.
    const table = gateTieAt(0);
    const small = sizeDevice({ table, L: GT_L, vgs: 0.4, id: 12e-6 });
    const big = sizeDevice({ table, L: GT_L, vgs: 0.4, id: 7 * 12e-6 });

    expect(small.W).toBeCloseTo(3 * GT_W0, 15);
    expect(big.W).toBeCloseTo(21 * GT_W0, 15);
    expect(big.vgs).toBeCloseTo(small.vgs, 15);
    expect(big.gm_id).toBeCloseTo(small.gm_id, 12);

    // The full selector set needs a table that carries every column the ratios are built from,
    // which the two-column oracle deliberately does not; the demo device does.
    const demo = generateDemoDevice();
    const demoL = demo.grid.axes[0].values[1];
    const one = sizeDevice({ table: demo, L: demoL, vgs: 0.6, id: 2e-5 });
    const seven = sizeDevice({ table: demo, L: demoL, vgs: 0.6, id: 7 * 2e-5 });
    expect(seven.W / one.W).toBeCloseTo(7, 9);
    for (const key of OP_SELECTORS) {
      expect(Number.isFinite(one.quantities[key])).toBe(true);
      expect(seven.quantities[key] / one.quantities[key]).toBeCloseTo(1, 9);
    }
  });

  it('a mirror sized on the shared gate carries the true ratio; one sized on a shared gm/ID does not', () => {
    // K:1 mirror. Reference diode-connected at vds = V_REF carrying I_IN; output device K times
    // as wide, at vds = V_OUT. The output shares the reference's GATE, and both sources are the
    // same node, so it sits at the reference's own gate-source voltage.
    const I_IN = 20e-6;
    const K = 2;
    const V_REF = 0;
    const V_OUT = 2;

    // Reference: gm/ID at vds = 0 is (GM0/ID_SLOPE)/vgs = 1/vgs, so gm/ID = 2 ⇒ vgs = 0.5 V.
    // Its current density there is 1e-5 · 0.5 = 5 µA per w0, so 20 µA needs W = 4 · w0.
    const ref = sizeDevice({ table: gateTieAt(V_REF), L: GT_L, id: I_IN, gm_id: 2 });
    expect(ref.vgs).toBeCloseTo(0.5, 12);
    expect(ref.W).toBeCloseTo(4 * GT_W0, 15);

    // The truth: same gate voltage, same length, K times the width, its own drain voltage. Only
    // the current's CLM slope survives, so I_out/I_in = K·(1 + V_OUT/VA_ID)/(1 + V_REF/VA_ID).
    const trueRatio = (K * (1 + V_OUT / GT_VA_ID)) / (1 + V_REF / GT_VA_ID); // = 2·3/1 = 6
    const tied = sizeDevice({ table: gateTieAt(V_OUT), L: GT_L, W: K * ref.W, vgs: ref.vgs });
    expect(tied.id / I_IN).toBeCloseTo(trueRatio, 9);
    expect(tied.id / I_IN).toBeCloseTo(6, 9);

    // The proxy: holding the reference's gm/ID instead re-solves the gate voltage on the OUTPUT
    // device's own drain slice, where gm/ID = 0.5/vgs, so it lands at vgs = 0.25 V — 250 mV off
    // a wire that has one voltage. The ratio it reports keeps the TRANSCONDUCTANCE's CLM slope
    // instead of the current's: I_out/I_in = K·(1 + V_OUT/VA_GM)/(1 + V_REF/VA_GM).
    const proxyRatio = (K * (1 + V_OUT / GT_VA_GM)) / (1 + V_REF / GT_VA_GM); // = 2·1.5/1 = 3
    const proxy = sizeDevice({ table: gateTieAt(V_OUT), L: GT_L, W: K * ref.W, gm_id: 2 });
    expect(proxy.vgs).toBeCloseTo(0.25, 12);
    expect(proxy.id / I_IN).toBeCloseTo(proxyRatio, 9);
    expect(proxy.id / I_IN).toBeCloseTo(3, 9);

    // Stated as the systematic error the mirror sheets rule on: the truth is +200%, the proxy
    // reports +50%. One-sided and a factor of four low — a mirror the sheet passes at a 5%
    // budget while its real error is forty times that.
    const sysErr = (i: number): number => i / (K * I_IN) - 1;
    expect(sysErr(tied.id)).toBeCloseTo(2, 9);
    expect(sysErr(proxy.id)).toBeCloseTo(0.5, 9);
  });

  it('warns and clamps a gate voltage off the table, as it does for an off-table length', () => {
    // vgs is a swept AXIS, so an off-hull request has a nearest characterized node to fall back
    // to — the same situation an off-hull L is in, and it gets the same warned clamp rather than
    // the refusal an unreachable SELECTOR target gets (there is no node to fall back to there).
    const table = gateTieAt(0);
    const res = sizeDevice({ table, L: GT_L, vgs: 1.3, W: GT_W0 });

    expect(res.vgs).toBeCloseTo(1.0, 15); // the top characterized node
    expect(res.id).toBeCloseTo(1e-5 * 1.0, 15); // read AT the hull, not at 1.3 V
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/vgs 1\.3 .*outside .*\[0\.05, 1\].*clamped/);

    // Below the hull too, and the sizing runs — a clamp is not an infeasibility.
    const low = sizeDevice({ table, L: GT_L, vgs: -0.2, W: GT_W0 });
    expect(low.vgs).toBeCloseTo(0.05, 15);
    expect(low.warnings).toHaveLength(1);

    // Contrast: an out-of-reach gm/ID on the same slice throws instead.
    expect(() => sizeDevice({ table, L: GT_L, gm_id: 500, W: GT_W0 })).toThrow(LookupRangeError);
  });

  it('refuses to read a gate voltage while another bias axis is still live', () => {
    // The forward read would otherwise take the first vds node silently, reporting a device at
    // an operating point nobody pinned. Every other bind path refuses this; so does this one.
    expect(() => sizeDevice({ table: gateTieTable(), L: GT_L, vgs: 0.4, W: GT_W0 })).toThrow(
      /non-degenerate axis "vds"/,
    );
  });

  it('is an operating-point selector, so it cannot be paired with another one', () => {
    expect(() => sizeDevice({ table: gateTieAt(0), L: GT_L, vgs: 0.4, gm_id: 2 })).toThrow(
      /both set the operating point/,
    );
    expect(() => sizeDevice({ table: gateTieAt(0), L: GT_L, vgs: 0.4 })).toThrow(/EXACTLY two/);
  });

  it('accepts the negative gate voltage a signed PMOS export sweeps', () => {
    // vgs is the one bindable carried in the table's own AXIS convention rather than as a
    // canonicalized magnitude, so the positivity rule that guards every other bind must not
    // apply to it. signedMirrorDemo is the same device with its voltage axes negated, so the
    // PMOS at -0.6 V is the NMOS at +0.6 V — same width, same current, same inversion level.
    const n = generateDemoDevice();
    const p = signedMirrorDemo(n);
    const L = n.grid.axes[0].values[1];

    const pRes = sizeDevice({ table: p, L, vgs: -0.6, id: 2e-5 });
    const nRes = sizeDevice({ table: n, L, vgs: 0.6, id: 2e-5 });

    expect(pRes.vgs).toBeCloseTo(-0.6, 12);
    expect(pRes.W).toBeCloseTo(nRes.W, 12);
    expect(pRes.gm_id).toBeCloseTo(nRes.gm_id, 12);
    expect(pRes.warnings).toEqual([]);
  });
});
