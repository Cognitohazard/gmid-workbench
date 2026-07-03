import { describe, it, expect } from 'vitest';
import { sizeDevice, mismatch, thermalNoise, integratedNoise } from './index';
import { lookup } from '../lookup';
import { makeGrid } from '../grid';
import type { DeviceTable } from '../types';
import { generateDemoDevice } from '../demo';
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
