// Tier-3 golden tests: the OTA sheets in sheets/otas/. Each number is hand-derived
// from the synthetic EKV demo model's closed forms — never by re-running the engine.
//
// The identities this tier leans on (see src/demo/index.ts):
//  - A given quantity is EXACT: gm = (gm/ID)·id when both are supplied, so slew,
//    GBW, and gm-ratio goldens hold to 1e-9.
//  - After sizing at a declared vds, gds/id = 1/(VA + vds) EXACTLY (VA = 5e6·L),
//    so gds = id/(VA + vds) and the intrinsic gain av0 = (gm/ID)·(VA + vds). Analytic
//    single-stage gains therefore land within interpolation error (< 1e-2).
//  - Thermal density vnth_m = sqrt(4kTγ/gm) with γ = GAMMA_DEFAULT.

import { describe, it, expect } from 'vitest';
import { runSheet } from './index';
import type { SizingReport, SheetResult } from './types';
import {
  table,
  relErr,
  va,
  gdsOf,
  stage2Rout,
  vnthM,
  gmbOf,
  cggOf,
  sheet as libSheet,
  VGS_GMID10_L05,
  VGS_GMID12_L05,
} from './library.fixtures';

/** Intrinsic gain av0 = (gm/ID)·(VA + vds) at length `L`, declared vds. */
const av0Of = (gm_id: number, L: number, vds: number): number => gm_id * (va(L) + vds);

const sheet = (file: string) => libSheet(`otas/${file}`);

const TWO_PI = 2 * Math.PI;
const CL = 2e-12;
const L = 0.5e-6; // every default sheet sizes at 0.5 µm

/** One block's sizing report, by block name. */
const block = (r: SheetResult, name: string): SizingReport =>
  r.blocks!.find((c) => c.name === name)!.sizing!;

// Every OTA's cgg_in is the gate of ONE input device, per input terminal. cgg = W*L*Cox is
// exact in the demo model at the width the sizing landed on, so where the input child exposes its
// sized width the equation has a closed form to check; the estimate the sheet notes warn about is
// the missing Miller term, which no table here carries and no check reads.
const cggInOf = (res: SheetResult): number => cggOf(res.values.in__W, L);

/** The cgg_in golden five of these OTAs share verbatim; registered per describe. */
const itIsOneInputGate = (res: SheetResult): void => {
  it('input capacitance is one input gate at the width the sizing landed on', () => {
    expect(relErr(res.values.cgg_in, cggInOf(res))).toBeLessThan(1e-9);
  });
};

describe('tier-3 goldens: differential pair + tail', () => {
  const res = runSheet(sheet('differential-pair-tail.json'), table);
  // Defaults: the bias reference programmed to I_tail = 20 µA at gm/ID 10, input gm/ID 12,
  // L 0.5 µm, V_out 0.9, CM_dc 1.05 (placed so the tail stays honestly saturated on a 1.8 V
  // process); the tail node is constrained to CM_dc.
  const I_TAIL = 20e-6;
  // Only the reference's current is typed. The tail device is the reference's width on the
  // reference's gate, and in the demo model id ∝ (VA + vds) at fixed vgs and W, so it delivers
  // the programmed current times (VA + vds_tail)/(VA + vds_ref) — the reference being
  // diode-connected, vds_ref is its own vgs. Both voltages are the model's for the inversion
  // level the sheet asks of each device, so nothing here is read back from the run:
  //   tail node    V_tail = CM_dc − vgs(12) = 1.05 − 0.567023 = 0.482977 V
  //   tail mirror  (2.5 + 0.482977)/(2.5 + 0.610063) = 0.959137   (reference at vgs(10))
  const vTail = 1.05 - VGS_GMID12_L05;
  const tailRatio = (va(L) + vTail) / (va(L) + VGS_GMID10_L05);
  /** What each side of the pair carries: half of what the tail delivers, 9.591 µA. */
  const iHalf = (I_TAIL / 2) * tailRatio;
  const gmIn = 12 * iHalf; // (gm/ID)·id, both supplied in the givens

  it('the tail node carries one current and the tail mirror is one gate wire', () => {
    // Kirchhoff at the tail node, to the last bit: the pair is HANDED the tail's current,
    // halved, and only the reference is sized against the programmed number.
    expect(block(res, 'bias').id).toBe(I_TAIL);
    expect(res.values.tail__id).toBe(2 * res.values.in__id);
    // A 1:1 mirror is the same width on the same gate. The width is passed through untouched;
    // the gate voltage is reported as the table's own vgs coordinate at the point it was read,
    // so two devices on one wire agree to rounding rather than always to the last bit.
    expect(block(res, 'tail').W).toBe(block(res, 'bias').W);
    expect(relErr(block(res, 'tail').vgs, block(res, 'bias').vgs)).toBeLessThan(1e-12);
  });

  it('the tail misses its reference by the drain-voltage ratio of the demo model', () => {
    // The tail node (0.483 V) sits below the reference's diode drop (0.610 V), so the tail
    // under-delivers by 1 − 0.959137 = 4.09 %. Compared as an error, the way the mirror goldens
    // compare theirs: the diode diagonal is interpolated, so the ratio is not exact on the
    // table, and 1e-2 of this error is 1.3 mV of drain-voltage difference.
    const tailErr = 1 - res.values.tail__id / I_TAIL;
    expect(relErr(tailErr, 1 - tailRatio)).toBeLessThan(1e-2);
  });

  it('slew, GBW and supply current follow from the current the tail delivers', () => {
    // 20 µA × 0.959137 = 19.183 µA — not the 20 µA the reference is programmed to.
    expect(relErr(res.values.SR, (I_TAIL * tailRatio) / CL)).toBeLessThan(1e-3);
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-3);
    // Which current each equation reads, exactly: the tail's own, and the pair's half of it.
    expect(relErr(res.values.SR, res.values.tail__id / CL)).toBeLessThan(1e-12);
    expect(relErr(res.values.GBW, (12 * res.values.in__id) / (TWO_PI * CL))).toBeLessThan(1e-9);
    // The reference branch is shared bias and is not counted.
    expect(res.values.I_q).toBe(res.values.tail__id);
  });

  it('the design constraint lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(1.05, 5);
  });

  it('gain is the input gm into the device gds plus the load conductance', () => {
    // The input device carries the half current at vds = V_out_dc − V_tail, so in the demo
    // model gds = I/(VA + vds) there; the load is the 3 µS the sheet is told. The half current
    // does not cancel against a fixed load conductance, so the gain falls with what the tail
    // delivers: 115.10 µS / (3.288 µS + 3 µS) = 18.30.
    const av = gmIn / (gdsOf(iHalf, L, 0.9 - vTail) + 3e-6);
    expect(relErr(res.values.Av, av)).toBeLessThan(1e-3);
  });

  it('Rout is the inverse of that same denominator, and Av now reads through it', () => {
    const rout = 1 / (gdsOf(iHalf, L, 0.9 - vTail) + 3e-6);
    expect(relErr(res.values.Rout, rout)).toBeLessThan(1e-3);
    expect(relErr(res.values.Av, res.values.Gm * res.values.Rout)).toBeLessThan(1e-12);
    expect(relErr(res.values.cgg_in, cggInOf(res))).toBeLessThan(1e-9);
  });

  it('the common-mode gain is read off the tail device where it sits', () => {
    // The tail copies its reference's saturation current I_tail/(1 + vgs(10)/VA), and
    // gds = idSat/VA in the demo model, so its gds is I_tail/(VA + vgs(10)) whatever the tail
    // node is. Over twice the pair's gm = 12 × (I_tail/2) × tailRatio, the programmed current
    // and the reference's gate voltage both cancel: Acm = 1/(12·(VA + V_tail)) = 0.027937.
    expect(relErr(res.values.Acm, 1 / (12 * (va(L) + vTail)))).toBeLessThan(1e-3);
    expect(relErr(res.values.CMRR, res.values.Av / res.values.Acm)).toBeLessThan(1e-12);
  });
});

describe('tier-3 goldens: degenerated differential pair', () => {
  const res = runSheet(sheet('degenerated-differential-pair.json'), table);
  // Defaults: I_tail 20 µA, gm/ID 14, R_s 12 kΩ (sized so the shipped linear-range target
  // is actually met: V* + I·R_s = 0.143 + 0.12), L 0.5 µm.
  const gmIn = 10e-6 * 14;
  // Both source-referred generators drive current through R_s, so the degeneration factor
  // carries gmb alongside gm. gmb rides the interpolated gm curve rather than the given
  // gm/ID, so equations built on it hold to interpolation order rather than to 1e-9.
  const nDeg = 1 + (gmIn + gmbOf(gmIn)) * 12000;

  it('the degeneration factor divides gm and GBW by both source generators', () => {
    expect(relErr(res.values.n_deg, nDeg)).toBeLessThan(1e-3);
    expect(relErr(res.values.Gm_eff, gmIn / nDeg)).toBeLessThan(1e-3);
    expect(relErr(res.values.GBW, gmIn / nDeg / (TWO_PI * CL))).toBeLessThan(1e-3);
  });

  it('offset improves by exactly the degeneration factor', () => {
    expect(relErr(res.values.vos / res.values.vos_undeg, 1 / nDeg)).toBeLessThan(1e-3);
    expect(relErr(res.values.SR, 20e-6 / CL)).toBeLessThan(1e-9);
  });

  it('degeneration lowers the transconductance but not the output node it drives', () => {
    // Rout is the input device gds against the estimated load conductance — the equation
    // deliberately does NOT claim the degeneration boost the source resistor also gives the device
    // r_o, which is the same conservatism the gain note already records. The pair's source node V_s
    // is constrained to CM_dc, so read it from the result and let the model check own the rest.
    const rout = 1 / (gdsOf(10e-6, L, 0.9 - res.values.V_s) + 3e-6);
    expect(relErr(res.values.Rout, rout)).toBeLessThan(1e-2);
    expect(relErr(res.values.Av, res.values.Gm_eff * res.values.Rout)).toBeLessThan(1e-12);
    expect(relErr(res.values.cgg_in, cggInOf(res))).toBeLessThan(1e-9);
  });
});

describe('tier-3 goldens: telescopic cascode OTA', () => {
  const res = runSheet(sheet('telescopic-cascode-ota.json'), table);
  // Defaults: I_tail 20 µA, gm/ID in 14 / casc 10 / mir 8, all L 0.5 µm; the stack is
  // parameterized by its NODES — V_a 0.55, V_b 1.35, V_out 0.9, the tail node constrained so
  // CM_in lands on CM_dc 0.97 — and every device vds is a subtraction between them.
  // (0.97, not a rounder number: the DC point must sit inside the claimed [0.95, 1.12]
  // AND below the demo table's constraint ceiling near 0.98 — the telescopic's ICMR is a slot.)
  const gmIn = 10e-6 * 14;

  it('slew and GBW follow exactly from the tail current and input gm', () => {
    expect(relErr(res.values.SR, 20e-6 / CL)).toBeLessThan(1e-9);
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-9);
  });

  it('the design constraint lands the common mode on CM_dc, with the tail node as the variable', () => {
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

  itIsOneInputGate(res);
});

describe('tier-3 goldens: folded cascode OTA', () => {
  const res = runSheet(sheet('folded-cascode-ota.json'), table);
  // Defaults: I_tail 20 µA, I_branch 30 µA, gm/ID in 14 / casc 10 / cs 8, all L 0.5 µm;
  // node-parameterized — V_fold 1.4, V_c 0.3, V_out 0.9, the tail node constrained so CM_in
  // lands on CM_dc 1.05 — and every device vds is a subtraction between adjacent nodes.
  const gmIn = 10e-6 * 14;
  const iFold = 30e-6 - 10e-6; // I_branch − I_tail/2, read from the input device

  it('the fold current is the branch bias minus the peak steered current', () => {
    expect(relErr(res.values.I_fold, iFold)).toBeLessThan(1e-9);
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-9);
  });

  it('the supply carries the two folding branches, and the tail current runs through them', () => {
    // Only the two folding current sources sit on the supply rail, so what VDD delivers is
    // 2 × 30 µA. The tail is not a third branch: it is drawn down THROUGH those sources, so
    // the equation is 2·I_branch. The cross-check is the other end of the circuit — everything
    // reaching ground is the tail plus both fold currents, I_tail + 2·I_fold = 20 + 2 × 20 µA,
    // and KCL requires the two to be the same 60 µA.
    expect(relErr(res.values.I_q, 2 * 30e-6)).toBeLessThan(1e-9);
    expect(relErr(res.values.I_q, 20e-6 + 2 * iFold)).toBeLessThan(1e-9);
  });

  it('the design constraint lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(1.05, 5);
  });

  it('gain is gm_in times the parallel folded-cascode output resistance', () => {
    const Rp = av0Of(10, L, 1.4 - 0.9) / gdsOf(30e-6, L, 1.8 - 1.4); // pcasc av0 / pcs gds
    const Rn = av0Of(10, L, 0.9 - 0.3) / gdsOf(iFold, L, 0.3); // ncasc av0 / nmir gds
    const Rout = 1 / (1 / Rp + 1 / Rn);
    expect(relErr(res.values.Av, gmIn * Rout)).toBeLessThan(1e-2);
  });

  it('checks its claimed common-mode range on THIS design, not on a re-sized one', () => {
    // A range end re-measures the amplifier the defaults produced: every device keeps the width
    // and length the base run solved, to the last bit, and the endpoint bias comes out of the
    // operating point instead. A range end free to re-size gave the input pair ~9% more width at
    // cm-hi (1.194 µm → 1.302 µm) and reported the margins of a different amplifier.
    for (const e of res.rangeEnds ?? []) {
      expect(
        e.blocks?.map((c) => c.sizing?.W),
        e.name,
      ).toEqual(res.blocks?.map((c) => c.sizing?.W));
      expect(
        e.blocks?.map((c) => c.sizing?.L),
        e.name,
      ).toEqual(res.blocks?.map((c) => c.sizing?.L));
    }
    // cm-lo's solve LANDS, so its operating point is a design point and can be locked as intent.
    // Pulling the input common mode 50 mV down to 1.0 V is paid almost entirely by the tail node
    // (0.5179 → 0.4689 V), because the input pair is held at the width the base run sized: its
    // drain stays at the fold node, so the 49 mV the tail gives up lands on its own vds, and the
    // extra channel-length modulation lets the gate back off the remaining ~1 mV at the same
    // 10 µA. The margins move with that.
    const lo = res.rangeEnds?.find((e) => e.name === 'cm-lo');
    expect(lo?.error).toBeUndefined();
    expect(lo?.solved.V_tail).toBeCloseTo(0.4688622, 6);
    const inAt = lo?.blocks?.find((c) => c.name === 'in')?.sizing;
    expect(inAt?.vgs).toBeCloseTo(0.5311371, 6);
    const margin = (id: string): number => lo!.checks.find((r) => r.id === id)!.marginPct;
    expect(margin('gain-spec')).toBeCloseTo(-0.185759, 6);
    expect(margin('offset-spec')).toBeCloseTo(-0.4126382, 6);
    expect(lo?.state).toBe('does-not-comply'); // measured, and two specs fail there
    // cm-hi is the case where the solve never LANDS (cm-lo landed and merely fails its checks), and
    // the only honest assertions about it are the three the engine actually vouches for. Its
    // tail-node constraint finds no sign change anywhere in the bracket, so nothing was measured at
    // that end: it is no answer, not a failure. Whatever the bisection was holding when it gave up
    // is the last PROBE, not a landing — locking those numbers would be asserting an operating
    // point the run never reached, and `solved` is left empty precisely so no consumer can go
    // looking for one.
    const hi = res.rangeEnds?.find((e) => e.name === 'cm-hi');
    expect(hi?.state).toBe('no-answer');
    expect(hi?.error).toMatch(/does not change sign/);
    expect(hi?.solved).toEqual({});
  });

  itIsOneInputGate(res);
});

describe('tier-3 goldens: current-mirror OTA', () => {
  const res = runSheet(sheet('current-mirror-ota.json'), table);
  // Defaults: I_tail 20 µA, K_m 2, gm/ID in 12 / mirror-out 8, L_mir 0.5 µm, V_out 0.9.
  const gmIn = 10e-6 * 12;

  it('GBW and slew carry the mirror ratio K_m exactly', () => {
    expect(relErr(res.values.GBW, (2 * gmIn) / (TWO_PI * CL))).toBeLessThan(1e-9);
    expect(relErr(res.values.SR, (2 * 20e-6) / CL)).toBeLessThan(1e-9);
  });

  it('K_m is paid for out of the supply: the input branch plus two K_m-scaled output branches', () => {
    // The mirror ratio buys GBW and slew above at a current price the gain equation never shows:
    // I_tail + 2·(K_m·I_tail/2) = I_tail·(1 + K_m) = 60 µA at the shipped K_m of 2.
    expect(relErr(res.values.I_q, 20e-6 * 3)).toBeLessThan(1e-9);
  });

  it('DC gain is K_m-independent: gain = (gm/ID_in)·(VA + V_out)/2 for the matched output pair', () => {
    // Both output devices sit at L_mir, vds 0.9, so gds_p = gds_n and K_m cancels.
    expect(relErr(res.values.Av, (12 * (va(L) + 0.9)) / 2)).toBeLessThan(1e-2);
  });

  itIsOneInputGate(res);

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

  it('the supply current matches the current-mirror OTA form, I_tail·(1 + K_m)', () => {
    expect(relErr(res.values.I_q, 20e-6 * 3)).toBeLessThan(1e-9);
  });

  itIsOneInputGate(res);

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
  // stack is node-parameterized — V_a 0.55, V_b 1.3, V_out 0.9, the tail node constrained so
  // CM_in lands on CM_dc 0.95 — and every device vds is a subtraction between nodes.
  const gmIn = 10e-6 * 14;

  it('GBW follows from the input gm (boosting lifts gain, not bandwidth)', () => {
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-9);
  });

  it('the boosters cost supply current the main branch never sees: one per cascode polarity', () => {
    // 20 µA main branch + 2 × 5 µA of booster tail. The factor of two is the topology claim —
    // the equations model an amplifier on the NMOS cascode and another on the PMOS cascode.
    expect(relErr(res.values.I_q, 20e-6 + 2 * 5e-6)).toBeLessThan(1e-9);
  });

  it('the design constraint lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(0.95, 5);
  });

  it('gain is the cascode gain multiplied again by the booster gain on each side', () => {
    const boost = av0Of(12, L, 0.6);
    const Rn = (boost * av0Of(10, L, 0.9 - 0.55)) / gdsOf(10e-6, L, 0.55 - res.values.V_tail);
    const Rp = (boost * av0Of(10, L, 1.3 - 0.9)) / gdsOf(10e-6, L, 1.8 - 1.3);
    const Rout = 1 / (1 / Rn + 1 / Rp);
    expect(relErr(res.values.Av, gmIn * Rout)).toBeLessThan(1e-2);
  });

  itIsOneInputGate(res);
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

  it('one output node, and both stacked gates on the input terminal', () => {
    // Equal L and |vds| put the two devices at the same gds, so Rout = (VA + vds)/(2*I_bias)
    // exactly. Current reuse means the input drives BOTH gates, so cgg_in sums them; at equal
    // gm/ID and equal current the two widths match, making the sum exactly twice one gate.
    expect(relErr(res.values.Rout, stage2Rout(20e-6, L, 0.9))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av, res.values.gm_tot * res.values.Rout)).toBeLessThan(1e-12);
    const cgg = cggOf(res.values.n__W, L) + cggOf(res.values.p__W, L);
    expect(relErr(res.values.cgg_in, cgg)).toBeLessThan(1e-9);
    expect(relErr(res.values.cgg_in, 2 * cggOf(res.values.n__W, L))).toBeLessThan(1e-9);
  });
});

describe('operating-range honesty on the demo table', () => {
  // The claimed CM ranges are tuned against real sky130 data. On the demo device the
  // current-mirror OTA's CM_hi (1.35 V) is unreachable — the tail bracket plus the demo diode
  // drop cap the producible common mode near 1.1 V — so the tail-node solve finds no landing at
  // cm-hi. The design is feasible where it is sized; what it cannot be given on this table is a
  // compliance answer at that end. Locked as a golden so neither half is lost: the range end
  // must never read as complying, and must never drag feasibility down with it.
  const res = runSheet(sheet('current-mirror-ota.json'), table);

  it('the unreachable cm-hi end is no answer, with the solver reason, and feasibility stands', () => {
    expect(res.feasible).toBe(true);
    const hi = res.rangeEnds?.find((e) => e.name === 'cm-hi');
    expect(hi?.state).toBe('no-answer'); // asked, and nothing landed — not "never asked"
    expect(hi?.error).toMatch(/does not change sign/);
    expect(hi?.solved).toEqual({}); // a bracket end is never reported as a landing
    expect(res.complies).toBe(false);
  });

  it('the reachable cm-lo end lands the tail node where the fixed design puts it', () => {
    // Holding the widths moves the landing: the same claim proven on the design the defaults
    // produce settles the tail 0.65% higher than it did when the endpoint was free to re-size
    // the devices around it (0.38292 → 0.38542). Locked as intent, not as a regression.
    const lo = res.rangeEnds?.find((e) => e.name === 'cm-lo');
    expect(lo?.state).toBe('complies');
    expect(lo?.solved.V_tail).toBeCloseTo(0.385423, 6);
  });
});
