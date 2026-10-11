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
//  - A device given another device's gate voltage and a multiple K of its width carries K times
//    that device's current times (VA + vds)/(VA + vds_ref): id and gm both scale with
//    (1 + vds/VA) at fixed vgs and W. A diode-connected reference has vds_ref equal to its own
//    vgs, read along an interpolated diagonal, so mirror-ratio goldens hold to about 1e-4.

import { describe, it, expect } from 'vitest';
import { scaleQuantities } from '../demo';
import type { DeviceTable } from '../types';
import { runSheet, withParams } from './index';
import type { SizingReport, SheetDoc, SheetResult } from './types';
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
  REFS,
  VGS_GMID10_L05,
  VGS_GMID12_L05,
  VGS_GMID14_L05,
  sourceNodeUnder,
  vgsAtBody,
} from './library.fixtures';
// Test-only reach across to the condition runs: holding one sized design at a second
// characterization is that module's transition, and one golden below asks it of a sheet.
import { groupDevices, runConditions } from '../corners';

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

/** Where the tail node lands at a range end that moves the common mode to `cm`, with the input
 *  pair HELD: the width the design point gave it, the same current. A pair free to re-size
 *  would put the node at (cm − vgs0)/(1 + BODY_FACTOR), like the design point's own. The held
 *  one sees its drain-source voltage change by what the node moved (its drain stays at `drain`),
 *  and id ∝ (VA + vds) at fixed width and gate drive in the demo model, so it needs its gate
 *  drive changed by ln((VA + vds_end)/(VA + vds_base))/(gm/ID) to carry the same current — first
 *  order in a change of a few percent, with vds_end taken at the re-sized landing. The node
 *  absorbs that through the same 1/(1 + BODY_FACTOR). `vgs0` is the body-grounded gate-source
 *  voltage of the pair's inversion level `gmId`. */
const heldTailNode = (
  cm: number,
  cmBase: number,
  vgs0: number,
  gmId: number,
  drain: number,
): number => {
  const base = sourceNodeUnder(cmBase, vgs0);
  const resized = sourceNodeUnder(cm, vgs0);
  const backOff = Math.log((va(L) + drain - resized) / (va(L) + drain - base)) / gmId;
  return sourceNodeUnder(cm + backOff, vgs0);
};

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
  // level the sheet asks of each device, so nothing here is read back from the run. The pair's
  // source is the tail node, so the node is its body bias as well and its gate needs
  // BODY_FACTOR·V_tail more than vgs(12): CM_dc = V_tail + vgs(12) + 0.2·V_tail.
  //   tail node    V_tail = (CM_dc − vgs(12))/1.2 = (1.05 − 0.567023)/1.2 = 0.402481 V
  //   tail mirror  (2.5 + 0.402481)/(2.5 + 0.610063) = 0.933255   (reference at vgs(10))
  const vTail = sourceNodeUnder(1.05, VGS_GMID12_L05);
  const tailRatio = (va(L) + vTail) / (va(L) + VGS_GMID10_L05);
  /** What each side of the pair carries: half of what the tail delivers, 9.333 µA. */
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
    // The tail node (0.402 V) sits below the reference's diode drop (0.610 V), so the tail
    // under-delivers by 1 − 0.933255 = 6.67 %. Compared as an error, the way the mirror goldens
    // compare theirs: the diode diagonal is interpolated, so the ratio is not exact on the
    // table, and 1e-2 of this error is 2.1 mV of drain-voltage difference.
    const tailErr = 1 - res.values.tail__id / I_TAIL;
    expect(relErr(tailErr, 1 - tailRatio)).toBeLessThan(1e-2);
  });

  it('slew, GBW and supply current follow from the current the tail delivers', () => {
    // 20 µA × 0.933255 = 18.665 µA — not the 20 µA the reference is programmed to.
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
    // delivers: 111.99 µS / (3.113 µS + 3 µS) = 18.32.
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
    // and the reference's gate voltage both cancel: Acm = 1/(12·(VA + V_tail)) = 0.028711.
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
  // (The telescopic's ICMR is a slot: the DC point has to sit inside the claimed [0.95, 1.12]
  // and under what the tail bracket can produce. On the demo table that is the bracket's 0.45 V
  // top plus the pair's gate-source voltage there, 0.45 + vgs(14) + 0.2 × 0.45 = 1.072 V — above
  // the 0.97 V design point, and below the claimed 1.12 V end, which is therefore not reached.)
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

  it('every device whose source sits above its body pays for it at its gate', () => {
    // Three devices in this stack have a source that is not at their body, and each needs
    // BODY_FACTOR × that difference more gate voltage than the same inversion level takes
    // body-grounded. None of these is read back from the run.
    //
    // The input pair's source is the tail node, which is solved so its gate lands on CM_dc:
    //   V_tail = (0.97 − vgs(14))/1.2 = (0.97 − 0.532095)/1.2 = 0.364921 V
    //   vgs_in = vgs(14) + 0.2 × 0.364921 = 0.605079 V
    // The node sits between two body-bias slices of the table (0.35 and 0.40 V), where the
    // table is interpolated, so these two agree to interpolation order: 0.16 mV here.
    const vTail = sourceNodeUnder(0.97, VGS_GMID14_L05);
    expect(relErr(res.values.V_tail, vTail)).toBeLessThan(1e-3);
    expect(relErr(res.values.in__vgs, vgsAtBody(VGS_GMID14_L05, vTail))).toBeLessThan(1e-3);
    // The N cascode's source is V_a = 0.55 V above ground, and the P cascode's is V_b = 1.35 V,
    // which is 0.45 V below its body at the supply. Both are on a body-bias slice, so the gate
    // each node is held under comes out to the constant's own precision:
    //   N gate  V_a + vgs(10) + 0.2 × 0.55 = 0.55 + 0.610063 + 0.11 = 1.270063 V
    //   P gate  V_b − vgs(10) − 0.2 × 0.45 = 1.35 − 0.610063 − 0.09 = 0.649937 V
    expect(relErr(res.held!.V_a, 0.55 + vgsAtBody(VGS_GMID10_L05, 0.55))).toBeLessThan(1e-5);
    expect(relErr(res.held!.V_b, 1.35 - vgsAtBody(VGS_GMID10_L05, 1.8 - 1.35))).toBeLessThan(1e-5);
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
    // operating point instead. A range end free to re-size would give the input pair ~11% more
    // width at cm-hi (1.167 µm → 1.291 µm: the pair's drain-source voltage falls from 0.968 V to
    // 0.635 V there, and the same current at the same inversion level then takes
    // (VA + 0.968)/(VA + 0.635) = 1.106 times the width) and report the margins of a different
    // amplifier.
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
    // Pulling the input common mode 50 mV down to 1.0 V moves the tail node 41 mV
    // (0.4318 → 0.3908 V) and the pair's gate-source voltage the other 9 mV. The pair's source
    // is the tail node, so 8.2 mV of that is the body effect giving back BODY_FACTOR × 41 mV.
    // The remaining 0.8 mV is the pair being held at the width the base run sized: its drain
    // stays at the fold node, so what the tail gives up lands on its own vds, and the extra
    // channel-length modulation lets the gate back off at the same 10 µA. The margins move with
    // that.
    //
    // The four six-decimal numbers below are RECORDED from the engine on this table, not derived:
    // each rides the table's interpolation between two body-bias slices, which no closed form
    // reproduces past about 1e-4. A check that is derived stands beside each of them.
    const lo = res.rangeEnds?.find((e) => e.name === 'cm-lo');
    expect(lo?.error).toBeUndefined();
    expect(lo?.solved.V_tail).toBeCloseTo(0.3907617, 6);
    // Beside the node: the held-width landing in closed form, 0.39063 V. A pair re-sized at this
    // end would land at (1.0 − vgs(14))/1.2 = 0.38992 V, 0.7 mV lower and 1.8e-3 of the node
    // away, so the tolerance tells the two apart.
    const heldLo = heldTailNode(1.0, 1.05, VGS_GMID14_L05, 14, 1.4);
    expect(relErr(lo!.solved.V_tail, heldLo)).toBeLessThan(1e-3);
    expect(relErr(sourceNodeUnder(1.0, VGS_GMID14_L05), heldLo)).toBeGreaterThan(1.5e-3);
    const inAt = lo?.blocks?.find((c) => c.name === 'in')?.sizing;
    expect(inAt?.vgs).toBeCloseTo(0.6092381, 6);
    // Beside the gate-source voltage: it and the node are the common mode the end asked for.
    expect(lo!.solved.V_tail + inAt!.vgs).toBeCloseTo(1.0, 5);
    const margin = (id: string): number => lo!.checks.find((r) => r.id === id)!.marginPct;
    expect(margin('gain-spec')).toBeCloseTo(-0.186085, 6);
    expect(margin('offset-spec')).toBeCloseTo(-0.4178275, 6);
    // Beside the margins: the output branches did not move, so both follow from the base run and
    // the transconductances the range end reports. The pair's gm is 1.0033 times what it was at
    // the design point (backing the gate off at a fixed current raises gm/ID), and the gain
    // scales with it. The offset is the pair's own Pelgrom spread and the mirror's, the mirror's
    // referred to the input by gm_mir/gm_in, at the widths the base run sized.
    const gmAt = (name: string): number => lo!.blocks!.find((c) => c.name === name)!.provides.gm;
    const gmRatio = gmAt('in') / res.values.in__gm;
    expect(margin('gain-spec')).toBeCloseTo((res.values.Av * gmRatio) / 300 - 1, 6);
    const sigma = (W: number, gmId: number): number =>
      (Math.SQRT2 * Math.hypot(res.values.avt, res.values.abeta / gmId)) / Math.sqrt(W * L);
    const vosLo = Math.hypot(
      sigma(res.values.in__W, 14),
      (sigma(res.values.nmir__W, 8) * gmAt('nmir')) / gmAt('in'),
    );
    expect(margin('offset-spec')).toBeCloseTo(1 - vosLo / 12e-3, 6);
    expect(lo?.state).toBe('does-not-comply'); // measured, and two specs fail there

    // cm-hi lands too. The pair's gate needs BODY_FACTOR·V_tail more than it would body-grounded,
    // so the 1.45 V end is produced with the tail node at 0.759 V, inside its [0.1, 0.8] bracket
    // (body-grounded it would take 1.45 − vgs(14) = 0.918 V, which the bracket does not reach).
    // It is therefore measured, and the same two specs fail there.
    const hi = res.rangeEnds?.find((e) => e.name === 'cm-hi');
    expect(hi?.error).toBeUndefined();
    expect(
      relErr(hi!.solved.V_tail, heldTailNode(1.45, 1.05, VGS_GMID14_L05, 14, 1.4)),
    ).toBeLessThan(1e-3);
    expect(hi?.state).toBe('does-not-comply');
    expect(hi?.checks.filter((r) => r.status === 'fail').map((r) => r.id)).toEqual([
      'gain-spec',
      'offset-spec',
    ]);
  });

  it('gives no answer at a range end its tail-node bracket cannot produce', () => {
    // The case where the solve never LANDS (the shipped ends both land and merely fail their
    // checks), and the only honest assertions about it are the three the engine actually vouches
    // for. The top of the tail bracket produces 0.8 + vgs(14) + 0.2 × 0.8 = 1.492 V; an
    // application that presents 1.6 V asks for more than that. The tail-node constraint then
    // finds no sign change anywhere in the bracket, so nothing was measured at that end: it is
    // no answer, not a failure. Whatever the bisection was holding when it gave up is the last
    // PROBE, not a landing — locking those numbers would be asserting an operating point the run
    // never reached, and `solved` is left empty precisely so no consumer can go looking for one.
    expect(0.8 + vgsAtBody(VGS_GMID14_L05, 0.8)).toBeLessThan(1.6);
    const far = runSheet(withParams(sheet('folded-cascode-ota.json'), { CM_hi: 1.6 }), table);
    const hi = far.rangeEnds?.find((e) => e.name === 'cm-hi');
    expect(hi?.state).toBe('no-answer');
    expect(hi?.error).toMatch(/does not change sign/);
    expect(hi?.solved).toEqual({});
    // The end that was already reachable is untouched by the claim beside it.
    expect(far.rangeEnds?.find((e) => e.name === 'cm-lo')?.solved).toEqual(
      res.rangeEnds?.find((e) => e.name === 'cm-lo')?.solved,
    );
  });

  itIsOneInputGate(res);
});

/**
 * The goldens of the current-mirror OTA, which is also called the symmetrical OTA. `diode` is
 * the name of its PMOS diode block and `pmosPole` of its PMOS mirror-node pole equation.
 *
 * Defaults: I_tail 20 µA, K_m 2, gm/ID in 12 / mirror diodes 10, every L 0.5 µm, V_out_dc 0.9 V,
 * VDD 1.8 V. Only the PMOS diode's current is typed, half the tail current. The input device is
 * in its branch and reads it; each output device is a multiple of its diode device's width on
 * that device's gate, so what it carries is read off the table at its own drain voltage. Both
 * diodes are sized at gm/ID 10 and the one table stands for both polarities, so both sit at
 * vgs(10) = 0.610063 V and the mirror ratios follow from the closed form in the header, with
 * nothing read back from the run:
 *   PMOS output at the output      (2.5 + 0.9)/(2.5 + 0.610063)      = 1.093225   rOut
 *   PMOS output on the NMOS diode  (2.5 + 1.189937)/(2.5 + 0.610063) = 1.186451   rFold
 *                                  (its drain is that diode's node, vgs(10) above ground)
 *   NMOS output at the output      (2.5 + 0.9)/(2.5 + 0.610063)      = 1.093225   rOut again
 */
const itIsAMirrorOta = (
  doc: SheetDoc,
  res: SheetResult,
  diode: 'mload',
  pmosPole: 'f_pole',
): void => {
  const I_HALF = 10e-6;
  const K_M = 2;
  const gmIn = 12 * I_HALF; // (gm/ID)·id; the input device reads the diode's typed current
  const refDrop = va(L) + VGS_GMID10_L05;
  const rOut = (va(L) + 0.9) / refDrop;
  const rFold = (va(L) + (1.8 - VGS_GMID10_L05)) / refDrop;
  const v = res.values;

  it('one current is typed, and each mirror is one gate wire', () => {
    // Half the tail current goes into the PMOS diode and nowhere else. The input device below it
    // and the NMOS diode under the second PMOS output device are HANDED the current of the device
    // above them, to the last bit.
    expect(block(res, diode).id).toBe(I_HALF);
    expect(block(res, 'in').id).toBe(block(res, diode).id);
    expect(block(res, 'nmir').id).toBe(v.mfold__id);
    // A mirror is a multiple of the diode's width on the diode's gate. The width is passed
    // through untouched; the gate voltage is reported as the table's own vgs coordinate at the
    // point it was read, so two devices on one wire agree to rounding rather than always to the
    // last bit.
    expect(block(res, 'moutp').W).toBe(K_M * block(res, diode).W);
    expect(block(res, 'mfold').W).toBe(K_M * block(res, diode).W);
    expect(block(res, 'moutn').W).toBe(block(res, 'nmir').W);
    for (const [out, ref] of [
      ['moutp', diode],
      ['mfold', diode],
      ['moutn', 'nmir'],
    ])
      expect([out, relErr(block(res, out).vgs, block(res, ref).vgs) < 1e-12]).toEqual([out, true]);
  });

  it('the NMOS diode node is solved to the gate-source voltage of the diode on it', () => {
    // The one bias loop on the sheet: the second PMOS output device has its drain on this node,
    // the current it delivers there is the NMOS diode's, and the diode's gate-source voltage at
    // that current is the node. Sized for its inversion level, the diode sits at vgs(10)
    // whatever it carries, so the node lands there and the PMOS device sits
    // 1.8 − 0.610063 = 1.189937 V below the supply.
    expect(relErr(v.V_nmir, block(res, 'nmir').vgs)).toBeLessThan(1e-6);
    expect(relErr(v.V_nmir, VGS_GMID10_L05)).toBeLessThan(1e-5);
    expect(block(res, 'mfold').bias?.vds).toBeCloseTo(1.8 - VGS_GMID10_L05, 5);
    // Solved, not typed: the value the sheet stores is a starting guess, 0.19 V away from the
    // answer here, and another guess lands on the same node.
    const guess = doc.params.find((p) => p.name === 'V_nmir');
    expect(guess?.solveFor).toBe('nmir__vgs');
    expect(Math.abs(guess!.value - v.V_nmir)).toBeGreaterThan(0.1);
    const other = runSheet(withParams(doc, { V_nmir: 0.5 }), table);
    expect(relErr(other.values.V_nmir, v.V_nmir)).toBeLessThan(1e-6);
  });

  it('each mirror misses its reference by the drain-voltage ratio of the demo model', () => {
    // Compared as errors, the way the mirror goldens compare theirs. The output sits 0.9 V from
    // either rail, further than a diode drop, so both copies made at the output over-deliver by
    // 9.32 %; the copy made onto the NMOS diode's node sits 1.19 V below the supply and
    // over-delivers by 18.65 %. 1e-3 of those errors is 0.3 mV and 0.6 mV of drain voltage.
    expect(relErr(v.moutp__id / (K_M * I_HALF) - 1, rOut - 1)).toBeLessThan(1e-3);
    expect(relErr(v.mfold__id / (K_M * I_HALF) - 1, rFold - 1)).toBeLessThan(1e-3);
    expect(relErr(v.moutn__id / v.mfold__id - 1, rOut - 1)).toBeLessThan(1e-3);
    // The NMOS output device is a copy of a copy, so it asks for rFold times what the PMOS one
    // does, and the difference has to come from the input. Referred through the transconductance
    // of the next golden, the currents, K_m and rOut all cancel:
    // vos_sys = (2/12)·(rFold − 1)/(rFold + 1) = 14.21 mV.
    expect(relErr(v.vos_sys, ((2 / 12) * (rFold - 1)) / (rFold + 1))).toBeLessThan(1e-3);
    expect(relErr(v.vos_sys, Math.abs(v.moutn__id - v.moutp__id) / v.Gm_out)).toBeLessThan(1e-12);
  });

  it('transconductance and GBW follow the gain the two mirror paths deliver', () => {
    // gm scales with (VA + vds) exactly as id does, so each mirror's small-signal current gain is
    // its current ratio: K_m·rOut straight to the output, K_m·rFold·rOut through the NMOS mirror.
    // The gm of a device on another's gate rides the interpolated gm curve, so these two hold to
    // interpolation order. Each input device takes half the differential input, so
    // Gm_out = gm_in·K_m·rOut·(1 + rFold)/2 = 120 µS × 2.390283 = 286.83 µS, against the 240 µS
    // of two exact copies.
    expect(relErr(v.Ai_p / K_M - 1, rOut - 1)).toBeLessThan(1e-2);
    expect(relErr(v.Ai_n / K_M - 1, rFold * rOut - 1)).toBeLessThan(1e-2);
    const gmOut = (gmIn * K_M * rOut * (1 + rFold)) / 2;
    expect(relErr(v.Gm_out, gmOut)).toBeLessThan(1e-3);
    expect(relErr(v.GBW, gmOut / (TWO_PI * CL))).toBeLessThan(1e-3);
    // Which quantities each equation reads, exactly.
    expect(relErr(v.Gm_out, (v.in__gm * (v.Ai_p + v.Ai_n)) / 2)).toBeLessThan(1e-12);
    expect(relErr(v.GBW, v.Gm_out / (TWO_PI * CL))).toBeLessThan(1e-12);
  });

  it('slew is twice what the slower output device carries at rest', () => {
    // The PMOS output device carries K_m·I_half·rOut = 21.86 µA and the NMOS one rFold times
    // that, so the rising direction is the slower: 2 × 21.86 µA into 2 pF, not the 40 µA of two
    // exact copies.
    expect(v.moutp__id).toBeLessThan(v.moutn__id);
    expect(relErr(v.SR, (2 * K_M * I_HALF * rOut) / CL)).toBeLessThan(1e-3);
    expect(relErr(v.SR, (2 * v.moutp__id) / CL)).toBeLessThan(1e-12);
  });

  it('the supply carries both input branches and the two PMOS output branches', () => {
    // 2·I_half through the two PMOS diodes plus K_m·I_half·(rOut + rFold) through the two PMOS
    // output devices: 20 µA + 20 µA × 2.279676 = 65.59 µA, against the 60 µA of exact copies.
    // The NMOS mirror is not a further branch: it carries to ground what the PMOS side delivers.
    expect(relErr(v.I_q, 2 * I_HALF + K_M * I_HALF * (rOut + rFold))).toBeLessThan(1e-3);
    expect(relErr(v.I_q, 2 * v[`${diode}__id`] + v.moutp__id + v.mfold__id)).toBeLessThan(1e-12);
  });

  it('DC gain is K_m-independent: gain = (gm/ID_in)·(VA + V_out)/2', () => {
    // gds = idSat/VA in the demo model and an output device copies its diode's saturation current
    // per width, so the drain voltage an output device sits at cancels out of its gds: it is its
    // diode's current, times the width ratio, over (VA + vgs(10)). The PMOS output device copies
    // K_m·I_half and the NMOS one rFold times that, so Rout = 71.12 kΩ.
    const rout =
      1 / (gdsOf(K_M * I_HALF, L, VGS_GMID10_L05) + gdsOf(K_M * I_HALF * rFold, L, VGS_GMID10_L05));
    expect(relErr(v.Rout, rout)).toBeLessThan(1e-3);
    // Against the transconductance above, the currents, K_m and (1 + rFold) all cancel:
    // Av = 12·rOut·(VA + vgs(10))/2 = 12·(VA + 0.9)/2 = 20.4, the gain of two exact copies at
    // the output's drain voltage. The output sits mid-supply, which is what makes the two rOut
    // one number.
    expect(relErr(v.Av, (12 * (va(L) + 0.9)) / 2)).toBeLessThan(1e-3);
    expect(relErr(v.Av, v.Gm_out * v.Rout)).toBeLessThan(1e-12);
    // K_m scales every output-side width and current together, so it cancels on the table too.
    const wider = runSheet(withParams(doc, { K_m: 4 }), table);
    expect(relErr(wider.values.Av, v.Av)).toBeLessThan(1e-9);
  });

  it('each mirror-node pole is the diode gm over the gates on its node', () => {
    // A diode device's gm is (gm/ID)·id, both given, and cgg = W·L·Cox at the width the sizing
    // landed on. The PMOS node carries the diode's gate and one K_m times as wide.
    const fP = (10 * I_HALF) / (TWO_PI * (1 + K_M) * cggOf(v[`${diode}__W`], L));
    expect(relErr(v[pmosPole], fP)).toBeLessThan(1e-9);
    // The NMOS node carries two gates of its diode's width, and that diode carries what the
    // second PMOS output device delivers.
    const fN = (10 * v.mfold__id) / (TWO_PI * 2 * cggOf(v.nmir__W, L));
    expect(relErr(v.f_pole_n, fN)).toBeLessThan(1e-9);
    // Both diodes sit at the same inversion level and the same diode drop, so the NMOS one is
    // the PMOS one widened in proportion to its current and the currents cancel between the two
    // poles: they differ only in how many diode widths of gate hang on each node, 1 + K_m
    // against 2.
    expect(relErr(v.f_pole_n / v[pmosPole], (1 + K_M) / 2)).toBeLessThan(1e-3);
  });
};

describe('tier-3 goldens: current-mirror OTA', () => {
  const doc = sheet('current-mirror-ota.json');
  const res = runSheet(doc, table);

  itIsAMirrorOta(doc, res, 'mload', 'f_pole');

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

  it('held at another condition, each mirror follows its diode and the node is solved again', () => {
    // A second characterization with half the current and half the transconductance at every
    // gate voltage, and the design sized on the first asked about on the second. Every width is
    // the sized one. The PMOS diode keeps the half tail current it is handed, so at half the
    // current density it needs a higher gate voltage, and both PMOS output devices are on that
    // gate: they follow it there instead of being handed K_m times a typed current.
    const at = (t: DeviceTable, corner: string, temp: number): DeviceTable => ({
      ...t,
      id: { ...t.id, corner, temp },
    });
    const weak = scaleQuantities(table, { id: 0.5, gm: 0.5 });
    const [device] = groupDevices([at(table, 'tt', 27), at(weak, 'ss', -40)]);
    const tt = { corner: 'tt', temp: 27 };
    const [sized, held] = runConditions(
      doc,
      device,
      [tt, { corner: 'ss', temp: -40 }],
      () => undefined,
      REFS,
      tt,
    );
    expect([sized.design, held.design]).toEqual(['sized', 'held']);
    expect([sized.state, held.state]).toEqual(['evaluated', 'evaluated']);
    if (sized.state !== 'evaluated' || held.state !== 'evaluated') return;
    const [s, h] = [sized.result, held.result];

    for (const name of ['mload', 'in', 'moutp', 'mfold', 'nmir', 'moutn'])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    expect(block(h, 'mload').id).toBe(10e-6);
    expect(block(h, 'in').id).toBe(block(h, 'mload').id);
    expect(block(h, 'mload').vgs).toBeGreaterThan(block(s, 'mload').vgs);
    expect(relErr(block(h, 'moutp').vgs, block(h, 'mload').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(h, 'mfold').vgs, block(h, 'mload').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(h, 'moutn').vgs, block(h, 'nmir').vgs)).toBeLessThan(1e-12);

    // The NMOS diode is held at its width too, so here its gate-source voltage does depend on
    // the current it is handed, and that current on the node: the loop is a real one, and it
    // closes on the diode's own gate-source voltage with the diode carrying exactly what the
    // PMOS device above it delivers at that node.
    expect(relErr(h.values.V_nmir, block(h, 'nmir').vgs)).toBeLessThan(1e-6);
    expect(block(h, 'nmir').id).toBe(h.values.mfold__id);
    expect(block(h, 'mfold').bias?.vds).toBeCloseTo(1.8 - h.values.V_nmir, 9);
    // Where the node lands has no closed form (it inverts the model's current law at a fixed
    // width), but it is bracketed from both sides. From below: at the gate voltage it was sized
    // at, the diode carries half its sized current on this table, while the device above still
    // hands it most of that — a mirror ratio moves by a few percent, not by half — so the node
    // has to rise. From above: the two diodes were sized at one gate voltage, so their widths are
    // in the ratio of their sized currents, K_m·rFold; at the PMOS diode's gate voltage here the
    // NMOS diode would therefore carry K_m·rFold times the PMOS diode's current, and with both
    // diode drops higher the copy made onto this node is worth less than rFold. So the node
    // settles below the PMOS diode's drop, carrying less than where the design was sized.
    expect(h.values.V_nmir).toBeGreaterThan(s.values.V_nmir);
    expect(h.values.V_nmir).toBeLessThan(block(h, 'mload').vgs);
    expect(h.values.mfold__id).toBeLessThan(s.values.mfold__id);
    expect(h.values.mfold__id).toBeGreaterThan(s.values.mfold__id / 2);

    // Every copy is the same closed form, read at this condition's voltages: scaling the current
    // column by a constant leaves its (VA + vds) dependence alone.
    const iRef = 2 * 10e-6; // K_m times the diode's current
    const refDrop = va(L) + block(h, 'mload').vgs;
    const foldRatio = (va(L) + 1.8 - h.values.V_nmir) / refDrop;
    const outRatioN = (va(L) + 0.9) / (va(L) + h.values.V_nmir);
    expect(relErr(h.values.moutp__id / iRef - 1, (va(L) + 0.9) / refDrop - 1)).toBeLessThan(1e-2);
    expect(relErr(h.values.mfold__id / iRef - 1, foldRatio - 1)).toBeLessThan(1e-2);
    expect(relErr(h.values.moutn__id / h.values.mfold__id - 1, outRatioN - 1)).toBeLessThan(1e-2);
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
  // current-mirror OTA's CM_hi (1.35 V) is unreachable — the 0.55 V top of the tail bracket plus
  // the pair's gate-source voltage there, vgs(12) + 0.2 × 0.55, caps the producible common mode
  // near 1.23 V — so the tail-node solve finds no landing at cm-hi. The design is feasible where
  // it is sized; what it cannot be given on this table is a compliance answer at that end.
  // Locked as a golden so neither half is lost: the range end must never read as complying, and
  // must never drag feasibility down with it.
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
    // produce settles the tail 0.54% higher than it would with the endpoint free to re-size the
    // devices around it, which lands at (0.95 − vgs(12))/1.2 (0.31915 → 0.32087). Locked as
    // intent, not as a regression.
    const lo = res.rangeEnds?.find((e) => e.name === 'cm-lo');
    expect(lo?.state).toBe('complies');
    // RECORDED from the engine on this table to six decimals. Beside it stands the held-width
    // landing in closed form: the pair's drain is the load's diode node, VDD − vgs(10), and the
    // pair sits at gm/ID 12, which gives 0.32089 V.
    expect(lo?.solved.V_tail).toBeCloseTo(0.3208677, 6);
    const held = heldTailNode(0.95, 1.05, VGS_GMID12_L05, 12, 1.8 - VGS_GMID10_L05);
    expect(relErr(lo!.solved.V_tail, held)).toBeLessThan(1e-3);
    expect(relErr(sourceNodeUnder(0.95, VGS_GMID12_L05), held)).toBeGreaterThan(5e-3);
  });
});
