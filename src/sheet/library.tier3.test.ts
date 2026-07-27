// Tier-3 golden tests: the OTA sheets in sheets/otas/. Each number is hand-derived
// from the synthetic EKV demo model's closed forms — never by re-running the engine.
//
// The identities this tier leans on (see src/demo/index.ts):
//  - A bound quantity is EXACT: gm = (gm/ID)·id when both are supplied, so slew,
//    GBW, and gm-ratio goldens hold to 1e-9.
//  - After binding at a declared vds, gds/id = 1/(VA + vds) EXACTLY (VA = 5e6·L),
//    so gds = id/(VA + vds) and the intrinsic gain av0 = (gm/ID)·(VA + vds). Analytic
//    single-stage gains therefore land within interpolation error (< 1e-2).
//  - Thermal density vnth_m = sqrt(4kTγ/gm) with γ = 2/3.

import { describe, it, expect } from 'vitest';
import { runSheet } from './index';
import { table, relErr, VA_PER_L, vnthM, sheet as libSheet } from './library.fixtures';

const va = (L: number): number => VA_PER_L * L;
/** gds of a device bound to current `id` at length `L`, declared vds — exact in the model. */
const gdsOf = (id: number, L: number, vds: number): number => id / (va(L) + vds);
/** Intrinsic gain av0 = (gm/ID)·(VA + vds) at length `L`, declared vds. */
const av0Of = (gm_id: number, L: number, vds: number): number => gm_id * (va(L) + vds);

const sheet = (file: string) => libSheet(`otas/${file}`);

const TWO_PI = 2 * Math.PI;
const CL = 2e-12;
const L = 0.5e-6; // every default sheet sizes at 0.5 µm

describe('tier-3 goldens: differential pair + tail', () => {
  const res = runSheet(sheet('differential-pair-tail.json'), table);
  // Defaults: I_tail 20 µA, gm/ID 12, L 0.5 µm, V_out 0.9, CM_dc 1.05 (placed so the tail
  // stays honestly saturated on a 1.8 V process); the tail node is pinned to CM_dc.
  const gmIn = 10e-6 * 12; // (I_tail/2)·gm_id, both supplied to the bind

  it('slew and GBW follow exactly from the tail current and input gm', () => {
    expect(relErr(res.values.SR, 20e-6 / CL)).toBeLessThan(1e-9);
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-9);
  });

  it('the pin lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(1.05, 5);
  });

  it('gain is the input gm into the device gds plus the load conductance', () => {
    // vds_in = V_out_dc − V_tail, with the tail node read from the converged result —
    // the model check (gds/id = 1/(VA + vds) in the demo device) is what this test owns.
    const av = gmIn / (gdsOf(10e-6, L, 0.9 - res.values.V_tail) + 3e-6);
    expect(relErr(res.values.Av, av)).toBeLessThan(1e-2);
  });
});

describe('tier-3 goldens: degenerated differential pair', () => {
  const res = runSheet(sheet('degenerated-differential-pair.json'), table);
  // Defaults: I_tail 20 µA, gm/ID 14, R_s 12 kΩ (sized so the shipped linear-range target
  // is actually met: V* + I·R_s = 0.143 + 0.12), L 0.5 µm.
  const gmIn = 10e-6 * 14;
  const nDeg = 1 + gmIn * 12000;

  it('the degeneration factor divides gm and GBW exactly', () => {
    expect(relErr(res.values.n_deg, nDeg)).toBeLessThan(1e-9);
    expect(relErr(res.values.Gm_eff, gmIn / nDeg)).toBeLessThan(1e-9);
    expect(relErr(res.values.GBW, gmIn / nDeg / (TWO_PI * CL))).toBeLessThan(1e-9);
  });

  it('offset improves by exactly the degeneration factor', () => {
    expect(relErr(res.values.vos / res.values.vos_undeg, 1 / nDeg)).toBeLessThan(1e-9);
    expect(relErr(res.values.SR, 20e-6 / CL)).toBeLessThan(1e-9);
  });
});

describe('tier-3 goldens: telescopic cascode OTA', () => {
  const res = runSheet(sheet('telescopic-cascode-ota.json'), table);
  // Defaults: I_tail 20 µA, gm/ID in 14 / casc 10 / mir 8, all L 0.5 µm; the stack is
  // parameterized by its NODES — V_a 0.55, V_b 1.35, V_out 0.9, the tail node pinned so
  // CM_in lands on CM_dc 0.97 — and every device vds is a subtraction between them.
  // (0.97, not a rounder number: the DC point must sit inside the claimed [0.95, 1.12]
  // AND below the demo table's pin ceiling near 0.98 — the telescopic's ICMR is a slot.)
  const gmIn = 10e-6 * 14;

  it('slew and GBW follow exactly from the tail current and input gm', () => {
    expect(relErr(res.values.SR, 20e-6 / CL)).toBeLessThan(1e-9);
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-9);
  });

  it('the pin lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(0.97, 5);
  });

  it('gain is gm_in times the parallel cascoded output resistance', () => {
    // Node subtractions, with the solved tail node read from the result: the input device
    // sits at vds = V_a − V_tail, its cascode at V_out − V_a; the PMOS side at the V_b splits.
    const Rn = av0Of(10, L, 0.9 - 0.55) / gdsOf(10e-6, L, 0.55 - res.values.V_tail);
    const Rp = av0Of(10, L, 1.35 - 0.9) / gdsOf(10e-6, L, 1.8 - 1.35);
    const Rout = 1 / (1 / Rn + 1 / Rp);
    expect(relErr(res.values.Av, gmIn * Rout)).toBeLessThan(1e-2);
  });
});

describe('tier-3 goldens: folded cascode OTA', () => {
  const res = runSheet(sheet('folded-cascode-ota.json'), table);
  // Defaults: I_tail 20 µA, I_branch 30 µA, gm/ID in 14 / casc 10 / cs 8, all L 0.5 µm;
  // node-parameterized — V_fold 1.4, V_c 0.3, V_out 0.9, the tail node pinned so CM_in
  // lands on CM_dc 1.05 — and every device vds is a subtraction between adjacent nodes.
  const gmIn = 10e-6 * 14;
  const iFold = 30e-6 - 10e-6; // I_branch − I_tail/2, read from the input device

  it('the fold current is the branch bias minus the peak steered current', () => {
    expect(relErr(res.values.I_fold, iFold)).toBeLessThan(1e-9);
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-9);
  });

  it('the pin lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(1.05, 5);
  });

  it('gain is gm_in times the parallel folded-cascode output resistance', () => {
    const Rp = av0Of(10, L, 1.4 - 0.9) / gdsOf(30e-6, L, 1.8 - 1.4); // pcasc av0 / pcs gds
    const Rn = av0Of(10, L, 0.9 - 0.3) / gdsOf(iFold, L, 0.3); // ncasc av0 / nmir gds
    const Rout = 1 / (1 / Rp + 1 / Rn);
    expect(relErr(res.values.Av, gmIn * Rout)).toBeLessThan(1e-2);
  });
});

describe('tier-3 goldens: current-mirror OTA', () => {
  const res = runSheet(sheet('current-mirror-ota.json'), table);
  // Defaults: I_tail 20 µA, K_m 2, gm/ID in 12 / mirror-out 8, L_mir 0.5 µm, V_out 0.9.
  const gmIn = 10e-6 * 12;

  it('GBW and slew carry the mirror ratio K_m exactly', () => {
    expect(relErr(res.values.GBW, (2 * gmIn) / (TWO_PI * CL))).toBeLessThan(1e-9);
    expect(relErr(res.values.SR, (2 * 20e-6) / CL)).toBeLessThan(1e-9);
  });

  it('DC gain is K_m-independent: gain = (gm/ID_in)·(VA + V_out)/2 for the matched output pair', () => {
    // Both output devices sit at L_mir, vds 0.9, so gds_p = gds_n and K_m cancels.
    expect(relErr(res.values.Av, (12 * (va(L) + 0.9)) / 2)).toBeLessThan(1e-2);
  });

  it('PM pays the PMOS node as a FULL pole and the folded NMOS node as a DOUBLET', () => {
    // Structure golden on the sheet's own poles: both branches pass a PMOS mirror (full
    // pole); only the folded branch passes the bottom NMOS mirror (doublet — zero at twice
    // the pole). Both terms must be observable, so dropping either cannot pass.
    const v = res.values;
    const pm =
      90 -
      ((Math.atan(v.GBW / v.f_pole) +
        Math.atan(v.GBW / v.f_pole_n) -
        Math.atan(v.GBW / (2 * v.f_pole_n))) *
        180) /
        Math.PI;
    expect(relErr(v.PM, pm)).toBeLessThan(1e-9);
    const withoutN = 90 - ((Math.atan(v.GBW / v.f_pole) - 0) * 180) / Math.PI;
    expect(withoutN - v.PM).toBeGreaterThan(1e-4); // the NMOS node costs real phase…
    const nAsFullPole =
      90 - ((Math.atan(v.GBW / v.f_pole) + Math.atan(v.GBW / v.f_pole_n)) * 180) / Math.PI;
    expect(v.PM - nAsFullPole).toBeGreaterThan(1e-4); // …but less than a lone pole would
  });
});

describe('tier-3 goldens: symmetrical OTA', () => {
  const res = runSheet(sheet('symmetrical-ota.json'), table);
  // Defaults mirror the current-mirror OTA: I_tail 20 µA, K_m 2, gm/ID in 12, out 8.
  const gmIn = 10e-6 * 12;

  it('GBW and symmetric slew carry K_m exactly', () => {
    expect(relErr(res.values.GBW, (2 * gmIn) / (TWO_PI * CL))).toBeLessThan(1e-9);
    expect(relErr(res.values.SR, (2 * 20e-6) / CL)).toBeLessThan(1e-9);
  });

  it('DC gain matches the current-mirror OTA form (K_m-independent)', () => {
    expect(relErr(res.values.Av, (12 * (va(L) + 0.9)) / 2)).toBeLessThan(1e-2);
  });

  it('PM pays the PMOS node as a FULL pole and the intermediate NMOS node as a DOUBLET', () => {
    // Same structure golden as the current-mirror OTA — the symmetrical OTA shares the
    // asymmetric path accounting (every branch passes a PMOS mirror; half pass the NMOS one).
    const v = res.values;
    const pm =
      90 -
      ((Math.atan(v.GBW / v.f_pole_p) +
        Math.atan(v.GBW / v.f_pole_n) -
        Math.atan(v.GBW / (2 * v.f_pole_n))) *
        180) /
        Math.PI;
    expect(relErr(v.PM, pm)).toBeLessThan(1e-9);
    const nAsFullPole =
      90 - ((Math.atan(v.GBW / v.f_pole_p) + Math.atan(v.GBW / v.f_pole_n)) * 180) / Math.PI;
    expect(v.PM - nAsFullPole).toBeGreaterThan(1e-4);
  });
});

describe('tier-3 goldens: gain-boosted cascode OTA', () => {
  const res = runSheet(sheet('gain-boosted-cascode-ota.json'), table);
  // Defaults: I_tail 20 µA, gm/ID in 14 / casc 10 / mir 8 / boost 12, all L 0.5 µm; the
  // stack is node-parameterized — V_a 0.55, V_b 1.3, V_out 0.9, the tail node pinned so
  // CM_in lands on CM_dc 0.95 — and every device vds is a subtraction between nodes.
  const gmIn = 10e-6 * 14;

  it('GBW follows from the input gm (boosting lifts gain, not bandwidth)', () => {
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-9);
  });

  it('the pin lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(0.95, 5);
  });

  it('gain is the cascode gain multiplied again by the booster gain on each side', () => {
    const boost = av0Of(12, L, 0.6);
    const Rn = (boost * av0Of(10, L, 0.9 - 0.55)) / gdsOf(10e-6, L, 0.55 - res.values.V_tail);
    const Rp = (boost * av0Of(10, L, 1.3 - 0.9)) / gdsOf(10e-6, L, 1.8 - 1.3);
    const Rout = 1 / (1 / Rn + 1 / Rp);
    expect(relErr(res.values.Av, gmIn * Rout)).toBeLessThan(1e-2);
  });
});

describe('tier-3 goldens: inverter-based OTA', () => {
  const res = runSheet(sheet('inverter-based-ota.json'), table);
  // Defaults: I_bias 20 µA shared, gm/ID n 12 / p 12, L 0.5 µm, V_out 0.9, VDD 1.8.
  const gmTot = 20e-6 * (12 + 12); // current reuse: gm_n + gm_p, both supplied exactly

  it('the composite transconductance is the sum of the two gm, and slew/GBW follow', () => {
    expect(relErr(res.values.gm_tot, gmTot)).toBeLessThan(1e-9);
    expect(relErr(res.values.SR, 20e-6 / CL)).toBeLessThan(1e-9);
    expect(relErr(res.values.GBW, gmTot / (TWO_PI * CL))).toBeLessThan(1e-9);
  });

  it('gain and the current-reuse noise density match the demo model', () => {
    // Both devices at L 0.5 µm, vds 0.9, so gds_n = gds_p and Av = (gid_n+gid_p)(VA+vds)/2.
    expect(relErr(res.values.Av, ((12 + 12) * (va(L) + 0.9)) / 2)).toBeLessThan(1e-2);
    const vn = vnthM(gmTot);
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(1e-2);
  });
});

describe('containment honesty on the demo table', () => {
  // The claimed CM ranges are tuned against real sky130 data. On the demo device the
  // current-mirror OTA's CM_hi (1.35 V) is genuinely unreachable — the tail bracket plus
  // the demo diode drop cap the producible common mode near 1.1 V — so the cm-hi edge
  // must FAIL and the sheet must read infeasible on this table. That is the kit working,
  // not a regression: before edges, the identical false claim simply went unchecked and
  // the sheet read feasible. Locked as a golden so the flip stays ASSERTED intent.
  const res = runSheet(sheet('current-mirror-ota.json'), table);

  it('the unreachable cm-hi edge fails with the solver reason and gates the verdict', () => {
    expect(res.feasible).toBe(false);
    const hi = res.edges?.find((e) => e.name === 'cm-hi');
    expect(hi?.feasible).toBe(false);
    expect(hi?.error).toMatch(/does not change sign/);
    expect(hi?.solved).toEqual({}); // a bracket end is never reported as a landing
  });
});
