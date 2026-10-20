// Tier-4 golden tests: multi-stage and buffer sheets under sheets/multistage/.
// Each number here is hand-derived from the synthetic EKV demo model's closed forms
// (never by re-running the engine):
//
//   - Given quantities are EXACT: with gm/ID + ID given the sizer sets gm = gm/ID·ID
//     and reports ID exactly, so gm1, gm2, GBW = gm1/(2π·Cc), z = gm2/Cc, and the slew
//     limits pin to 1e-9.
//   - Output conductance is EXACT in the demo: gds = ID/(VA + vds) with VA = 5e6·L,
//     independent of the found vgs. So a gain built only from gm and gds (Av2, the FVF
//     output resistance) is exact too.
//   - Intrinsic gain av0 = gm/gds is reported from the INTERPOLATED gm (before the sizing
//     overwrites gm), so any gain built on a provided av0 (the SSF/telescopic output
//     resistances) carries the demo grid's ~1e-4 interpolation error — those assert at 1e-2.
//   - vdsat and diode vgs come from the EKV inversion (noted constants), so swing/level
//     equations assert at 1e-2.
//   - gmb = BODY_FACTOR·gm at every point, but like av0 it rides the interpolated gm, so
//     equations built on it assert at interpolation order rather than at 1e-9.
//   - The phase-margin equations are the sheet's own arctan estimate recomputed here from the
//     exact gm values.
//   - A device given another device's gate-source voltage and its width carries that device's
//     current times (VA + vds)/(VA + vds_ref): id and gm both scale with (1 + vds/VA) at fixed
//     vgs and W, and gds = idSat/VA does not move with vds at all. A diode-connected reference
//     has vds_ref equal to its own vgs, read along an interpolated diagonal, and a tail node is
//     solved between two body-bias slices, so goldens built on such a ratio compare its ERROR
//     (the ratio minus one) and hold to about 1e-2 of it.

import { describe, it, expect } from 'vitest';
import { PHYS } from '../constants';
import { scaleQuantities } from '../demo';
import type { DeviceTable } from '../types';
import { runSheet } from './index';
import { withParams, type SheetDoc, type SheetResult, type SizingReport } from './types';
import {
  table,
  relErr,
  VA_PER_L,
  gdsOf,
  gmbOf,
  vnthM,
  sheet as libSheet,
  REFS,
  VGS_GMID8_L05,
  VGS_GMID10_L05,
  VGS_GMID12_L05,
  sourceNodeUnder,
  vgsAtBody,
  cggOf,
  par,
  stage2Rout,
} from './library.fixtures';
// Test-only reach across to the condition runs: holding one sized design at a second
// characterization is that module's transition, and the two-stage goldens below ask it of a sheet.
import { groupDevices, runConditions } from '../corners';

/** Load a multistage sheet document by file basename. */
const sheet = (file: string) => libSheet(`multistage/${file}.json`);

/** One block's sizing report, by block name. */
const block = (r: SheetResult, name: string): SizingReport =>
  r.blocks!.find((c) => c.name === name)!.sizing!;

/** A check's outcome, by id. */
const statusOf = (r: SheetResult, id: string): string | undefined =>
  r.checks.find((c) => c.id === id)?.status;

// --- Demo-model closed forms shared across the buffer/output goldens ---
const UT = (PHYS.k * PHYS.T) / PHYS.q;
const vthDemo = (L: number): number => 0.4 + 0.02 * Math.log(L / 0.18e-6 + 1);
// vdsat depends on the overdrive vgs − vth alone. A source above the body raises the gate-source
// voltage and the threshold by the same BODY_FACTOR·vsb, so for a device at any body bias this
// takes the BODY-GROUNDED vgs of its inversion level, against the body-grounded threshold.
const vdsatDemo = (vgs: number, L: number): number => 2 * UT + Math.max(vgs - vthDemo(L), 0);

// --- Closed forms shared by the two-stage goldens ---
// Every default length is 0.5 µm, so VA = 2.5 V throughout, and all three sheets default to
// I1 20 µA, I2 60 µA, Cc 3 pF, CL 5 pF, C1_est 0.5 pF, CM_dc 1.0 V, VDD 1.8 V, V_out2 0.9 V.
const L05 = 0.5e-6;
const VA05 = VA_PER_L * L05;
const I1 = 20e-6;
const I2 = 60e-6;
const CC = 3e-12;
const C_LOAD = 5e-12;
/** The tail node. It is the pair's source and its body bias, so the pair's gate needs
 *  BODY_FACTOR·V_tail more than vgs(12) and the node is solved to
 *  (CM_dc − vgs(12))/1.2 = (1.0 − 0.567023)/1.2 = 0.360814 V. */
const V_TAIL = sourceNodeUnder(1.0, VGS_GMID12_L05);
/** What the tail device delivers of the current its reference is programmed to. It is the
 *  reference's width on the reference's gate; the reference is diode-connected at vgs(10) and the
 *  tail's drain is the tail node: (2.5 + 0.360814)/(2.5 + 0.610063) = 0.919857. */
const TAIL_RATIO = (VA05 + V_TAIL) / (VA05 + VGS_GMID10_L05);
/** The two levels a mirror-loaded first stage sits at. The mirror node is one diode drop below
 *  the supply, 1.8 − vgs(8) = 1.131958 V; the stage-1 output is the second stage's gate, one
 *  second-stage gate-source voltage below it, 1.8 − vgs(12) = 1.232977 V. */
const V_MIR = 1.8 - VGS_GMID8_L05;
const V_1 = 1.8 - VGS_GMID12_L05;
/** The mirror's output device over its diode device. The output device's drain is the stage-1
 *  output, so it sits vgs(12) below the supply where the diode device sits at its own vgs(8):
 *  (2.5 + 0.567023)/(2.5 + 0.668042) = 0.968113. */
const R_LD = (VA05 + VGS_GMID12_L05) / (VA05 + VGS_GMID8_L05);
/** The phase-margin estimate every two-stage sheet shares: the second pole alone, read at the
 *  crossover the stage-1 transconductance sets. */
const pmOf = (gm1: number): number =>
  90 - (Math.atan(gm1 / CC / ((12 * I2) / (C_LOAD + 0.5e-12))) * 180) / Math.PI;

/** The sheet sized on the shared table and then held on a second characterization of the same
 *  device with half the current and half the transconductance at every gate voltage. */
const sizedAndHeld = (doc: SheetDoc): [SheetResult, SheetResult] => {
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
  if (sized.state !== 'evaluated' || held.state !== 'evaluated')
    throw new Error('a condition was not evaluated');
  return [sized.result, held.result];
};

describe('tier4 goldens: Two-stage Miller OTA', () => {
  const doc = sheet('two-stage-miller-ota');
  const res = runSheet(doc, table, undefined, REFS);
  const v = res.values;
  // Defaults: the bias reference programmed to I1 at gm/ID 10; gm/ID in 12, mirror 8, s2 12,
  // ld2 8. Only the reference and the stage-2 device have a current typed into them.
  /** What the tail delivers to the pair: 20 µA × 0.919857 = 18.397 µA. */
  const iTail = I1 * TAIL_RATIO;
  // The pair's output-side device over its diode-side partner. Both stand on the tail node; one
  // drain is the stage-1 output and the other the mirror node:
  // (2.5 + 1.232977 − 0.360814)/(2.5 + 1.131958 − 0.360814) = 1.030882.
  const rIn = (VA05 + V_1 - V_TAIL) / (VA05 + V_MIR - V_TAIL);
  /** The share of the tail current the output-side device carries. The two input devices are
   *  one width at one gate-source voltage, so they carry the tail's current in the ratio
   *  1.030882 : 1 and the output side takes 1.030882/2.030882 = 0.507603 of it, 9.339 µA; the
   *  diode side carries the other 9.059 µA. */
  const share = rIn / (1 + rIn);
  const iOut = iTail * share;
  const iIn = iTail - iOut;
  const gm2 = 12 * I2;
  // Half the differential input reaches the stage-1 output through the mirror and half directly,
  // and gm scales with (VA + vds) exactly as id does. The output-side device is the sized one,
  // gm = 12·id with both given, and its partner's gm is that over 1.030882, which is 12 times
  // the diode side's current: gm1 = 12·9.059 µA·(0.968113 + 1.030882)/2.
  const gm1 = (12 * iIn * (R_LD + rIn)) / 2;

  it('one first-stage current is typed, and every tie is one gate wire', () => {
    // The programmed current goes into the bias reference and nowhere else: both sides of the
    // first stage are handed a share of what the tail delivers. The second stage keeps its own
    // programmed current, which its load reads.
    expect(block(res, 'bias').id).toBe(I1);
    expect(relErr(block(res, 'ino').id, v.tail__id * v.out_share)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'ld1').id, v.tail__id * (1 - v.out_share))).toBeLessThan(1e-12);
    expect(block(res, 's2').id).toBe(I2);
    expect(block(res, 'ld2').id).toBe(I2);
    // A tie is the partner's width on the partner's gate-source voltage. The width is passed
    // through untouched; the gate voltage is reported as the table's own vgs coordinate at the
    // point it was read, so two devices on one wire agree to rounding.
    for (const [tied, partner] of [
      ['tail', 'bias'],
      ['ld1o', 'ld1'],
      ['in', 'ino'],
    ]) {
      expect([tied, block(res, tied).W]).toEqual([tied, block(res, partner).W]);
      expect([tied, relErr(block(res, tied).vgs, block(res, partner).vgs) < 1e-12]).toEqual([
        tied,
        true,
      ]);
    }
  });

  it('the tail misses its reference by the drain-voltage ratio of the demo model', () => {
    // The tail node (0.361 V) sits below the reference's diode drop (0.610 V), so the tail
    // under-delivers by 1 − 0.919857 = 8.01 %. 1e-2 of that error is 2 mV of drain voltage.
    expect(relErr(1 - v.tail__id / I1, 1 - TAIL_RATIO)).toBeLessThan(1e-2);
  });

  it('the pair carries the tail current between its two devices, and the split is solved', () => {
    // Kirchhoff at the tail node: what the two input devices carry adds up to what the tail
    // delivers, to rounding. They do not carry it evenly, because the output-side device's drain
    // sits 101 mV above its partner's: it takes 0.507603 of the tail current. Compared as the
    // distance from an even split, of which 1e-2 is 0.3 mV of drain voltage.
    expect(relErr(v.in__id + v.ino__id, v.tail__id)).toBeLessThan(1e-9);
    expect(relErr(v.out_share - 0.5, share - 0.5)).toBeLessThan(1e-2);
    expect(relErr(v.ino__id, iOut)).toBeLessThan(1e-3);
    expect(relErr(v.in__id, iIn)).toBeLessThan(1e-3);
    expect(v.ino__id).toBeGreaterThan(v.tail__id / 2);
    // The mirror's diode device is handed what the tail delivers less the output side's share,
    // and that is what the input device in its branch carries: one current in one branch.
    expect(relErr(block(res, 'ld1').id, v.in__id)).toBeLessThan(1e-9);
    // Solved, not typed: the share is the output-side device's fraction of the pair's current as
    // the table reads the two, and the value the sheet stores is only what the panel shows — an
    // even split, not the answer, and never read by the solve.
    const guess = doc.params.find((p) => p.name === 'out_share');
    expect(guess?.solveFor).toBe('pair_split');
    expect(guess?.value).toBe(0.5);
    expect(relErr(v.out_share, v.pair_split)).toBeLessThan(1e-9);
    expect(relErr(v.pair_split, v.ino__id / (v.in__id + v.ino__id))).toBeLessThan(1e-12);
    for (const start of [0.3, 0.7]) {
      const other = runSheet(withParams(doc, { out_share: start }), table, undefined, REFS);
      expect([start, relErr(other.values.out_share, v.out_share) < 1e-9]).toEqual([start, true]);
    }
    // With the second stage at the mirror's diode drop the two drains sit at one level and the
    // split is even.
    const matched = runSheet(withParams(doc, { gm_id_s2: 8 }), table, undefined, REFS);
    expect(matched.values.out_share).toBeCloseTo(0.5, 8);
  });

  it('the stage-1 output sits at the second-stage gate, not at the mirror node', () => {
    expect(relErr(v.V_mir, V_MIR)).toBeLessThan(1e-3);
    expect(relErr(v.V1, V_1)).toBeLessThan(1e-3);
    // Each output-side device has its drain on the stage-1 output and each diode-side device on
    // the mirror node: the mirror devices are read down from the supply, the pair up from the
    // tail node.
    expect(Math.abs(block(res, 'ld1o').bias!.vds!)).toBeCloseTo(1.8 - v.V1, 9);
    expect(block(res, 'ino').bias!.vds).toBeCloseTo(v.V1 - v.V_tail, 9);
    expect(block(res, 'in').bias!.vds).toBeCloseTo(v.V_mir - v.V_tail, 9);
    // The level follows the second stage and nothing else: at gm/ID 8 the second stage needs the
    // mirror's own diode drop, and the two levels become one.
    const level = runSheet(withParams(doc, { gm_id_s2: 8 }), table, undefined, REFS);
    expect(relErr(level.values.V1, V_MIR)).toBeLessThan(1e-3);
    expect(relErr(level.values.V_mir, V_MIR)).toBeLessThan(1e-3);
  });

  it('each output-side device misses its diode-side partner by the drain-voltage ratio', () => {
    // The stage-1 output sits 101 mV above the mirror node. The mirror's output device therefore
    // has less drain-source voltage than its diode device and delivers 3.19 % less; the pair's
    // output-side device has more than its partner and takes 3.09 % more. Compared as errors:
    // 1e-2 of them is about 1 mV of drain voltage.
    expect(relErr(v.ld1o__id / block(res, 'ld1').id - 1, R_LD - 1)).toBeLessThan(1e-2);
    expect(relErr(v.ino__id / v.in__id - 1, rIn - 1)).toBeLessThan(1e-2);
    expect(v.ld1o__id).toBeLessThan(v.in__id);
    expect(v.ino__id).toBeGreaterThan(v.in__id);
  });

  it('the systematic offset is the current missing at the stage-1 output, referred to the input', () => {
    // The mirror delivers 0.968113 of the diode side's current into the node and the pair's
    // output-side device takes 1.030882 of it out. Referred through gm1, which is 12 times the
    // diode side's current times (0.968113 + 1.030882)/2, that current cancels:
    // vos_sys = (2/12)·(1.030882 − 0.968113)/(1.030882 + 0.968113) = 5.23 mV.
    expect(relErr(v.vos_sys, ((2 / 12) * (rIn - R_LD)) / (rIn + R_LD))).toBeLessThan(1e-2);
    expect(relErr(v.vos_sys, Math.abs(v.ld1o__id - v.ino__id) / v.gm1)).toBeLessThan(1e-12);
    // The check reads that row against its budget of 1 mV. It advises and never gates: the sheet
    // is feasible with the offset five times over.
    expect(statusOf(res, 'systematic-offset')).toBe('fail');
    expect(res.checks.find((c) => c.id === 'systematic-offset')?.lhsValue).toBe(v.vos_sys);
    expect(res.feasible).toBe(true);
    // With the second stage at the mirror's diode drop both output-side devices sit where their
    // partners do, nothing is missing at the node, and the check passes.
    const matched = runSheet(withParams(doc, { gm_id_s2: 8 }), table, undefined, REFS);
    expect(matched.values.vos_sys).toBeLessThan(v.vos_sys / 100);
    expect(statusOf(matched, 'systematic-offset')).toBe('pass');
  });

  it('bandwidth and slew follow what the first stage delivers; the RHP zero is the second stage’s', () => {
    // 12/V × 9.059 µA × 0.999497 = 108.65 µS, not the 120 µS of an input device at a typed 10 µA.
    expect(relErr(v.gm1, gm1)).toBeLessThan(1e-3);
    expect(relErr(v.GBW, gm1 / (2 * Math.PI * CC))).toBeLessThan(1e-3);
    // The stage-1 limit binds: 18.40 µA into 3 pF is slower than 60 µA into 5 pF.
    expect(relErr(v.SR, Math.min(iTail / CC, I2 / C_LOAD))).toBeLessThan(1e-3);
    expect(relErr(v.z_rhp, gm2 / CC)).toBeLessThan(1e-9);
    // Which quantities each equation reads, exactly.
    expect(relErr(v.gm1, ((v.in__gm * v.ld1o__gm) / v.ld1__gm + v.ino__gm) / 2)).toBeLessThan(
      1e-12,
    );
    expect(relErr(v.GBW, v.gm1 / (2 * Math.PI * CC))).toBeLessThan(1e-12);
    expect(relErr(v.SR, v.tail__id / CC)).toBeLessThan(1e-12);
  });

  it('stage-1 gain reads the two conductances on the stage-1 output node', () => {
    // gds = idSat/VA in the demo model, and a device and the one tied to it have one saturation
    // current, so the drain voltage an output-side device sits at cancels out of its gds: each
    // is the diode side's current over (VA + the DIODE-side partner's vds). That current then
    // cancels against gm1: Av1 = 12·0.999497/(1/3.271144 + 1/3.168042) = 19.30.
    const gdsOut = gdsOf(iIn, L05, V_MIR - V_TAIL) + gdsOf(iIn, L05, VGS_GMID8_L05);
    expect(relErr(v.Av1, gm1 / gdsOut)).toBeLessThan(1e-3);
    expect(relErr(v.Av1, v.gm1 / (v.ino__gds + v.ld1o__gds))).toBeLessThan(1e-12);
    expect(relErr(v.Av, v.Av1 * v.Av2)).toBeLessThan(1e-12);
  });

  it('stage-2 gain is exact from gm and the two gds = I/(VA+vds)', () => {
    // s2 and ld2 both carry 60 µA at |vds| = 0.9 V, L 0.5 µm ⇒ gds = 60µ/(VA+0.9) each.
    const av2 = gm2 / (2 * (I2 / (VA05 + 0.9)));
    expect(relErr(v.Av2, av2)).toBeLessThan(1e-9);
  });

  it('phase-margin estimate is the second pole alone, the nulling resistor having removed the zero', () => {
    // The sheet supplies Rz = 1/gm2, which moves the RHP zero to infinity — so the estimate
    // carries no zero term. Keeping one double-charged the design for a zero it had cancelled.
    expect(relErr(v.PM, pmOf(gm1))).toBeLessThan(1e-3);
    expect(relErr(v.PM, pmOf(v.gm1))).toBeLessThan(1e-9);
  });

  it('the tail device keeps its headroom, and a common mode that takes it away is refused', () => {
    // The tail device shares its reference's gate, so its saturation voltage is the reference's:
    // 0.360814 − vdsat(vgs(10)) = 0.126 V of headroom at the default common mode.
    expect(relErr(v.tail_headroom, V_TAIL - vdsatDemo(VGS_GMID10_L05, L05))).toBeLessThan(1e-2);
    expect(relErr(v.tail_headroom, v.V_tail - v.tail__vdsat)).toBeLessThan(1e-12);
    expect(statusOf(res, 'tail-saturated')).toBe('pass');
    // A common mode of 0.75 V leaves the tail node (0.75 − 0.567023)/1.2 = 0.152 V, under the
    // tail device's 0.235 V. The check is physical, so the sheet is no longer feasible.
    const low = runSheet(withParams(doc, { CM_dc: 0.75 }), table, undefined, REFS);
    expect(relErr(low.values.V_tail, sourceNodeUnder(0.75, VGS_GMID12_L05))).toBeLessThan(1e-2);
    expect(low.values.tail_headroom).toBeLessThan(0);
    expect(statusOf(low, 'tail-saturated')).toBe('fail');
    expect(low.feasible).toBe(false);
  });

  it('the output interface is that same node, named, plus the input gate', () => {
    expect(relErr(v.Rout, stage2Rout(I2, L05, 0.9))).toBeLessThan(1e-9);
    expect(relErr(v.Av2, gm2 * v.Rout)).toBeLessThan(1e-12);
    // Composition golden on cgg_in: one input device, per input terminal, at the width the
    // sizing landed on. The two input devices share that width, so they present the same gate.
    expect(v.cgg_in).toBe(v.in__cgg);
    expect(relErr(v.cgg_in, cggOf(block(res, 'ino').W, L05))).toBeLessThan(1e-9);
    // Supply current is what the tail delivers plus the single-ended output branch:
    // 18.40 µA + 60 µA. The reference branch is shared bias and is not counted.
    expect(relErr(v.I_q, iTail + I2)).toBeLessThan(1e-3);
    expect(relErr(v.I_q, v.tail__id + I2)).toBeLessThan(1e-12);
  });

  it('held at another condition, the first stage follows its tail and every tie its partner', () => {
    // Every width is the sized one. The reference keeps the current it is programmed to, so at
    // half the current density it needs a higher gate voltage, and the tail device follows it
    // there instead of being handed 20 µA. The second stage keeps its own programmed current, so
    // its gate — the stage-1 output — moves with its own device.
    const [s, h] = sizedAndHeld(doc);
    for (const name of ['bias', 'tail', 'ld1', 'in', 's2', 'ld1o', 'ino', 'ld2'])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    expect(block(h, 'bias').id).toBe(I1);
    expect(block(h, 's2').id).toBe(I2);
    expect(block(h, 'bias').vgs).toBeGreaterThan(block(s, 'bias').vgs);
    for (const [tied, partner] of [
      ['tail', 'bias'],
      ['ld1o', 'ld1'],
      ['in', 'ino'],
    ])
      expect([tied, relErr(block(h, tied).vgs, block(h, partner).vgs) < 1e-12]).toEqual([
        tied,
        true,
      ]);
    expect(h.values.tail__id).toBeLessThan(s.values.tail__id);
    // The split is solved again here, with the input devices at their sized width. The two still
    // carry what the tail delivers between them, and the mirror's diode device what the input
    // device in its branch does, to the solve's tolerance.
    const hv = h.values;
    expect(relErr(hv.in__id + hv.ino__id, hv.tail__id)).toBeLessThan(1e-6);
    expect(relErr(hv.out_share, hv.pair_split)).toBeLessThan(1e-6);
    expect(relErr(block(h, 'ld1').id, hv.in__id)).toBeLessThan(1e-6);
    // Every tie is the same closed form, read at this condition's voltages: scaling the current
    // column by a constant leaves its (VA + vds) dependence alone.
    const tail = (VA05 + hv.V_tail) / (VA05 + block(h, 'bias').vgs);
    const mirror = (VA05 + block(h, 's2').vgs) / (VA05 + block(h, 'ld1').vgs);
    const pair = (VA05 + hv.V1 - hv.V_tail) / (VA05 + hv.V_mir - hv.V_tail);
    expect(relErr(1 - hv.tail__id / I1, 1 - tail)).toBeLessThan(1e-2);
    expect(relErr(hv.ld1o__id / block(h, 'ld1').id - 1, mirror - 1)).toBeLessThan(1e-2);
    expect(relErr(hv.ino__id / hv.in__id - 1, pair - 1)).toBeLessThan(1e-2);
    expect(relErr(hv.vos_sys, Math.abs(hv.ld1o__id - hv.ino__id) / hv.gm1)).toBeLessThan(1e-12);
  });

  it('held at another condition, the split and the tail node land the same from any stored value', () => {
    // Where the design is held the output-side device's gate-source voltage does depend on its
    // current, so the split and the tail node depend on each other and are settled together by
    // repeated sweeps — and where they land must not depend on the stored value. Three stored
    // values, one answer to the last bit: the same share, the same tail node, the same verdict on
    // every hard check.
    const hard = (r: SheetResult): string[] =>
      r.checks.filter((c) => c.kind !== 'advisory').map((c) => `${c.id}:${c.status}`);
    const [, even] = sizedAndHeld(doc);
    for (const start of [0.3, 0.7]) {
      const [, h] = sizedAndHeld(withParams(doc, { out_share: start }));
      expect([start, h.values.out_share]).toEqual([start, even.values.out_share]);
      expect([start, h.values.V_tail]).toEqual([start, even.values.V_tail]);
      expect([start, hard(h)]).toEqual([start, hard(even)]);
      expect([start, h.feasible]).toEqual([start, even.feasible]);
    }
  });
});

describe('tier4 goldens: Two-stage OTA, cascode compensation', () => {
  const doc = sheet('two-stage-cascode-comp-ota');
  const res = runSheet(doc, table, undefined, REFS);
  const v = res.values;
  // Defaults: as the Miller sheet, plus a cascode at gm/ID 10 in each first-stage branch, the
  // diode-side one stated at V_casc = 0.4 V. No tail device is on this sheet: half of I1 is
  // typed into the mirror's diode device and the branch under it reads that.
  const I_HALF = I1 / 2;
  const gmIn = 12 * I_HALF;
  const gm2 = 12 * I2;
  /** The diode-side cascode's source, V_casc below the mirror node: 0.731958 V. */
  const V_A = V_MIR - 0.4;
  // The output-side cascode's source has no closed form (it inverts the model's current law at a
  // fixed width), so it is read where the solve landed and bracketed in its own golden. The
  // pair's output-side device over its diode-side partner is then the same ratio as on the
  // Miller sheet, with each drain on its own cascode's source. The two sources are 2.7 mV
  // apart, so the ratio is read at the two drain-source voltages the run reports rather than
  // at a closed-form node 0.1 mV away from either: 1.000934.
  const vX = v.V1 - v.V_casco;
  const rIn = (VA05 + block(res, 'ino').bias!.vds!) / (VA05 + block(res, 'in').bias!.vds!);
  const gm1 = (gmIn * (R_LD + rIn)) / 2;

  it('one first-stage current is typed, and every tie is one gate wire', () => {
    expect(block(res, 'ld1').id).toBe(I_HALF);
    expect(block(res, 'in').id).toBe(I_HALF);
    expect(block(res, 'casc').id).toBe(I_HALF);
    expect(block(res, 's2').id).toBe(I2);
    // The output-side cascode is in one branch with the input device under it and is handed
    // that device's current, to the last bit.
    expect(block(res, 'casco').id).toBe(v.ino__id);
    for (const [tied, partner] of [
      ['ld1o', 'ld1'],
      ['ino', 'in'],
      ['casco', 'casc'],
    ])
      expect([tied, block(res, tied).W]).toEqual([tied, block(res, partner).W]);
    expect(relErr(block(res, 'ld1o').vgs, block(res, 'ld1').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'ino').vgs, block(res, 'in').vgs)).toBeLessThan(1e-12);
  });

  it('the two cascodes share one gate, and the node under the output-side one is solved to it', () => {
    // The diode-side cascode's gate is what the sheet holds: its source, V_casc below the mirror
    // node, plus its gate-source voltage. The output-side cascode's source is solved until its
    // own gate lands on the same voltage, to the solve's microvolt.
    const gate = block(res, 'casc').bias!.vsb! + block(res, 'casc').vgs;
    expect(relErr(res.held!.V_casc, gate)).toBeLessThan(1e-9);
    expect(block(res, 'casco').bias!.vsb! + block(res, 'casco').vgs).toBeCloseTo(gate, 5);
    expect(block(res, 'casco').bias!.vsb).toBeCloseTo(vX, 9);
    expect(block(res, 'casco').bias!.vds).toBeCloseTo(v.V_casco, 9);
    expect(block(res, 'ino').bias!.vds).toBeCloseTo(vX - v.V_tail, 9);
    // Where it lands, to first order. The output-side cascode has its drain on the stage-1
    // output, 101 mV above the mirror node, so it carries its current with less gate drive:
    // id ∝ (VA + vds)·exp((gm/ID)·Δvgs) near a point, which at gm/ID 10 is
    // ln((2.5 + 0.501)/(2.5 + 0.4))/10 = 3.4 mV less. Its source rises to give that back, and
    // rising takes body bias with it, so the node moves by 3.4 mV/1.2 = 2.85 mV. The estimate
    // overstates it by the few percent that the node's own move takes off that drain voltage.
    const rise = Math.log((VA05 + V_1 - V_A) / (VA05 + 0.4)) / 10 / 1.2;
    expect(vX - V_A).toBeGreaterThan(0.9 * rise);
    expect(vX - V_A).toBeLessThan(rise);
    expect(statusOf(res, 'cascode-sat')).toBe('pass');
    expect(statusOf(res, 'cascode-out-sat')).toBe('pass');
  });

  it('the cascode shields the pair, so the mirror sets the systematic offset', () => {
    // The mirror's output device sits at the second stage's gate and delivers 3.19 % less than
    // its diode device, as on the Miller sheet. The pair's output-side device moves only with
    // the 2.7 mV its cascode's source moved: 0.09 % more than its partner.
    expect(relErr(v.ld1o__id / I_HALF - 1, R_LD - 1)).toBeLessThan(1e-2);
    expect(relErr(v.ino__id / I_HALF - 1, rIn - 1)).toBeLessThan(1e-2);
    expect(rIn - 1).toBeLessThan((1 - R_LD) / 20);
    // Referred through gm1 the half current cancels:
    // vos_sys = (2/12)·(1.000934 − 0.968113)/(1.000934 + 0.968113) = 2.78 mV, within a few
    // percent of the 2.70 mV the mirror alone would give.
    expect(relErr(v.vos_sys, ((2 / 12) * (rIn - R_LD)) / (rIn + R_LD))).toBeLessThan(1e-2);
    expect(relErr(v.vos_sys, ((2 / 12) * (1 - R_LD)) / (1 + R_LD))).toBeLessThan(0.05);
    expect(relErr(v.vos_sys, Math.abs(v.ld1o__id - v.ino__id) / v.gm1)).toBeLessThan(1e-12);
    expect(statusOf(res, 'systematic-offset')).toBe('fail');
    expect(res.checks.find((c) => c.id === 'systematic-offset')?.lhsValue).toBe(v.vos_sys);
    expect(res.feasible).toBe(true);
    // What the pair's two halves carry over the tail current is that 0.09 % of a half current.
    expect(relErr(v.pair_residual, I_HALF * (rIn - 1))).toBeLessThan(1e-2);
    expect(relErr(v.pair_residual, v.in__id + v.ino__id - I1)).toBeLessThan(1e-9);
    // With the second stage at the mirror's diode drop the two sides sit at one set of levels:
    // the output-side cascode's source lands on the diode side's and nothing is missing.
    const matched = runSheet(withParams(doc, { gm_id_s2: 8 }), table, undefined, REFS);
    expect(matched.values.V_casco).toBeCloseTo(0.4, 4);
    expect(matched.values.vos_sys).toBeLessThan(v.vos_sys / 100);
    expect(statusOf(matched, 'systematic-offset')).toBe('pass');
  });

  it('bandwidth pins to the stage-1 transconductance and stage-2 gain is exact', () => {
    expect(relErr(v.gm1, gm1)).toBeLessThan(1e-3);
    expect(relErr(v.GBW, gm1 / (2 * Math.PI * CC))).toBeLessThan(1e-3);
    expect(relErr(v.gm1, ((v.in__gm * v.ld1o__gm) / v.ld1__gm + v.ino__gm) / 2)).toBeLessThan(
      1e-12,
    );
    expect(relErr(v.Av2, gm2 / (2 * (I2 / (VA05 + 0.9))))).toBeLessThan(1e-9);
    // No tail device is drawn, so the stage-1 slew limit is the programmed tail current.
    expect(relErr(v.SR, Math.min(I1 / CC, I2 / C_LOAD))).toBeLessThan(1e-9);
  });

  it('stage-1 gain reads the two conductances on the output side', () => {
    // As on the Miller sheet, a tied device's gds is the half current over (VA + its partner's
    // vds): the input device under its cascode at 0.731958 − 0.360814 V, the mirror at vgs(8).
    const gdsOut = gdsOf(I_HALF, L05, V_A - V_TAIL) + gdsOf(I_HALF, L05, VGS_GMID8_L05);
    expect(relErr(v.Av1, gm1 / gdsOut)).toBeLessThan(1e-3);
    expect(relErr(v.Av1, v.gm1 / (v.ino__gds + v.ld1o__gds))).toBeLessThan(1e-12);
  });

  it('the compensation returns through the output-side cascode', () => {
    // That cascode carries the output-side input device's current at 3.2 mV less overdrive than
    // its partner, so its gm/ID sits a little above the 10 its partner is sized at and its gm a
    // little above the partner's 100 µS: 101.3 µS. Bracketed, since the inversion level it lands
    // on has no closed form.
    expect(relErr(v.casc__gm, 10 * I_HALF)).toBeLessThan(1e-9);
    expect(v.gm_casc).toBeGreaterThan(1.005 * v.casc__gm);
    expect(v.gm_casc).toBeLessThan(1.02 * v.casc__gm);
  });

  it('phase margin has no RHP-zero term (cascode compensation removes it)', () => {
    expect(relErr(v.PM, pmOf(gm1))).toBeLessThan(1e-3);
    expect(relErr(v.PM, pmOf(v.gm1))).toBeLessThan(1e-9);
  });

  it('the output interface is that same node, named, plus the input gate', () => {
    expect(relErr(v.Rout, stage2Rout(I2, L05, 0.9))).toBeLessThan(1e-9);
    expect(relErr(v.Av2, gm2 * v.Rout)).toBeLessThan(1e-12);
    // Composition golden on cgg_in: one input device, per input terminal, at the width the
    // sizing landed on. The two input devices share that width, so they present the same gate.
    expect(v.cgg_in).toBe(v.in__cgg);
    expect(relErr(v.cgg_in, cggOf(block(res, 'ino').W, L05))).toBeLessThan(1e-9);
    // Cascode compensation changes where the compensation current flows, not what the two
    // branches draw: the 20 µA tail plus the 60 µA output branch.
    expect(relErr(v.I_q, I1 + I2)).toBeLessThan(1e-9);
  });

  it('held at another condition, both cascode nodes are solved again under the one gate', () => {
    // Every width is the sized one and the cascode gate stays where the design put it. The
    // diode-side cascode's node, the tail node and the output-side cascode's node are each
    // solved again, one after another, and the two cascodes still share that gate.
    const [s, h] = sizedAndHeld(doc);
    for (const name of ['ld1', 'in', 'casc', 's2', 'ld1o', 'ino', 'casco', 'ld2'])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    const gate = s.held!.V_casc;
    expect(block(h, 'casc').bias!.vsb! + block(h, 'casc').vgs).toBeCloseTo(gate, 5);
    expect(block(h, 'casco').bias!.vsb! + block(h, 'casco').vgs).toBeCloseTo(gate, 5);
    expect(h.values.V_casc).not.toBeCloseTo(s.values.V_casc, 3);
    expect(block(h, 'casco').id).toBe(h.values.ino__id);
    expect(relErr(block(h, 'ld1o').vgs, block(h, 'ld1').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(h, 'ino').vgs, block(h, 'in').vgs)).toBeLessThan(1e-12);
    const mirror = (VA05 + block(h, 's2').vgs) / (VA05 + block(h, 'ld1').vgs);
    expect(relErr(h.values.ld1o__id / I_HALF - 1, mirror - 1)).toBeLessThan(1e-2);
  });
});

describe('tier4 goldens: Rail-to-rail input stage', () => {
  const res = runSheet(sheet('rail-to-rail-input-stage'), table);
  // Defaults: matched pairs, each device 10 µA, gm/ID 12, L 0.5 µm ⇒ gm = 120 µS each.
  const gm = 12 * (20e-6 / 2);

  it('the both-on total is the sum of the two pair transconductances', () => {
    expect(relErr(res.values.gm_mid, 2 * gm)).toBeLessThan(1e-9);
    expect(relErr(res.values.gm_min, gm)).toBeLessThan(1e-9);
  });

  it('matched complementary pairs give the classic gm ratio of 2', () => {
    expect(relErr(res.values.gm_ratio, 2)).toBeLessThan(1e-9);
  });

  it('the supply pays for both pairs, which is the mid-supply worst case', () => {
    // Both tails, 20 µA each. The stage only draws this much where both pairs conduct; toward
    // either rail one of them shuts off, so the equation is deliberately the pessimistic reading.
    expect(relErr(res.values.I_q, 20e-6 + 20e-6)).toBeLessThan(1e-9);
  });
});

describe('tier4 goldens: Class-AB output stage (Monticelli)', () => {
  const res = runSheet(sheet('class-ab-output-monticelli'), table);
  // Defaults: both output devices at I_q 20 µA, gm/ID 8, L 0.5 µm, V_out 0.9 V.

  it('both output devices carry the quiescent current exactly', () => {
    expect(relErr(res.values.mn__id, 20e-6)).toBeLessThan(1e-9);
    expect(relErr(res.values.mp__id, 20e-6)).toBeLessThan(1e-9);
  });

  it('output swing is the supply minus the two saturation voltages', () => {
    const vdsat = vdsatDemo(VGS_GMID8_L05, 0.5e-6);
    expect(relErr(res.values.swing, 1.8 - 2 * vdsat)).toBeLessThan(1e-2);
  });

  it('the translinear vgs sum is the two output-device gate drives', () => {
    expect(relErr(res.values.vgs_sum, 2 * VGS_GMID8_L05)).toBeLessThan(1e-2);
  });

  it('output resistance is the two devices in parallel — they conduct together at quiescent', () => {
    // Same current, same L, same |vds| on both sides, so the node is (VA + vds)/(2*I_q). This
    // is a class-AB output stage: at quiescent both devices are on, which is why both gds load
    // the node rather than one. The push-pull transconductance sums for the same reason.
    expect(relErr(res.values.Rout, stage2Rout(20e-6, 0.5e-6, 0.9))).toBeLessThan(1e-9);
    expect(relErr(res.values.gm_out * res.values.Rout, 8 * (VA_PER_L * 0.5e-6 + 0.9))).toBeLessThan(
      1e-9,
    );
  });
});

describe('tier4 goldens: Super source follower', () => {
  const res = runSheet(sheet('super-source-follower'), table);
  // Defaults: in and fb both 50 µA, gm/ID 10, L 0.5 µm; the output node (the feedback device's
  // drain-source voltage) is stated at 0.3 V.
  const gmIn = 10 * 50e-6;
  // The input device's drain sits on the feedback device's gate, one feedback gate-source voltage
  // above ground: vgs(10) = 0.610 V. Its source is the output, so its drain-source voltage is the
  // difference — nothing here is typed.
  const vdsIn = VGS_GMID10_L05 - 0.3;

  it('input transconductance is exact', () => {
    expect(relErr(res.values.gm_in, gmIn)).toBeLessThan(1e-9);
  });

  it('output resistance is the input device gds divided by both transconductances', () => {
    // The loop senses the INPUT device's drain current, so its gds is the numerator, and the
    // output node is that device's source, so gmb adds to its gm. gds = ID/(VA + vds) is exact.
    const gdsIn = 50e-6 / (VA_PER_L * 0.5e-6 + vdsIn);
    const gmFb = 10 * 50e-6;
    expect(relErr(res.values.Rout, gdsIn / ((gmIn + gmbOf(gmIn)) * gmFb))).toBeLessThan(1e-3);
    // Well below the plain follower it replaces — that reduction is the point of the stage.
    expect(res.values.Rout).toBeLessThan(res.values.Rout_plain / 10);
  });

  it('the input device sits between the feedback device’s gate and the output', () => {
    expect(relErr(res.values.vds_in, vdsIn)).toBeLessThan(1e-3);
    // Raising the output by 50 mV takes the same 50 mV off the input device: one branch.
    const up = runSheet(withParams(sheet('super-source-follower'), { vds_fb: 0.35 }), table);
    expect(up.values.vds_in - res.values.vds_in).toBeCloseTo(-0.05, 6);
  });

  // The input device's source is the output node, 0.3 V above its body at ground, so its
  // gate-source voltage is the body-grounded vgs(10) plus BODY_FACTOR × 0.3 V:
  // 0.610063 + 0.06 = 0.670063 V.
  const vgsIn = vgsAtBody(VGS_GMID10_L05, 0.3);

  it('reports the input level the output node hangs under', () => {
    // The input device's gate is its source (the output, 0.3 V) plus its gate-source voltage:
    // 0.970063 V.
    expect(relErr(res.held!.vds_fb, 0.3 + vgsIn)).toBeLessThan(1e-3);
  });

  it('the DC level shift is the input follower vgs', () => {
    expect(relErr(res.values.level_shift, vgsIn)).toBeLessThan(1e-2);
  });

  it('the loop costs no extra supply current: both devices are one stacked branch', () => {
    // The feedback device REUSES the follower's current rather than drawing its own — it sits
    // under the output node in the same stack — so the supply pays 50 µA once. Only a
    // realization that biases the output node with a source of its own adds current on top.
    expect(relErr(res.values.I_q, 50e-6)).toBeLessThan(1e-9);
  });

  it('input capacitance is one input gate at the width the sizing landed on', () => {
    expect(relErr(res.values.cgg_in, cggOf(res.values.in__W, 0.5e-6))).toBeLessThan(1e-9);
  });
});

describe('tier4 goldens: Flipped voltage follower', () => {
  const res = runSheet(sheet('flipped-voltage-follower'), table);
  // Defaults: in and fb both 50 µA, gm/ID 10, L 0.5 µm, V_out 0.3 V.
  const gm = 10 * 50e-6;
  // Node X is the feedback device's gate above its grounded source, so it is that device's own
  // gate-source voltage: vgs(10) = 0.610 V. The input device sits between node X and the output,
  // so its drain-source voltage is the difference — nothing here is typed.
  const vdsIn = VGS_GMID10_L05 - 0.3;
  const gdsIn = 50e-6 / (VA_PER_L * 0.5e-6 + vdsIn);

  it('the internal node is the FEEDBACK device’s own gate-source voltage', () => {
    expect(relErr(res.values.V_x, VGS_GMID10_L05)).toBeLessThan(1e-3);
    // At the shipped defaults both devices sit at gm/ID 10 and the same length, so a value read
    // at those defaults cannot tell which child the node follows. Split them: move the feedback
    // device to gm/ID 12 and leave the input device at 10. The node must land on the FEEDBACK
    // device's vgs, the input device's transconductance must not budge, and its drain-source
    // voltage must absorb the whole change.
    const doc = sheet('flipped-voltage-follower');
    doc.params.find((p) => p.name === 'gm_id_fb')!.value = 12;
    const split = runSheet(doc, table);
    expect(relErr(split.values.V_x, VGS_GMID12_L05)).toBeLessThan(1e-3);
    expect(relErr(split.values.gm_in, gm)).toBeLessThan(1e-9);
    // Rout rides the input device's gds, which follows the node: vds_in = vgs_fb(12) - V_out.
    const gdsSplit = 50e-6 / (VA_PER_L * 0.5e-6 + (VGS_GMID12_L05 - 0.3));
    expect(relErr(split.values.Rout, gdsSplit / (gm * 12 * 50e-6))).toBeLessThan(1e-4);
  });

  it('output resistance follows the derived node through the input device’s gds', () => {
    // Rout = gds_in/(gm_in·gm_fb), and gds = ID/(VA + vds) is exact in the demo at any vds. What
    // is not exact is vds itself: it now carries the interpolated vgs the node derives from, so
    // this asserts at that constant's precision rather than at the givens' 1e-9.
    expect(relErr(res.values.Rout, gdsIn / (gm * gm))).toBeLessThan(1e-5);
    expect(res.values.Rout).toBeLessThan(res.values.Rout_plain / 10);
  });

  it('the shunt feedback device shares the input branch, so the supply pays 50 µA once', () => {
    // The bias source feeds node X, the input device carries that current down to the output
    // node, and the feedback device reuses it on the way to ground: one stacked branch, one
    // supply current. Biasing the output node separately is what would add current on top.
    expect(relErr(res.values.I_q, 50e-6)).toBeLessThan(1e-9);
  });

  it('branch headroom is the two stacked saturation voltages', () => {
    // Unmoved by the node derivation: vdsat is a function of the overdrive and L in the demo
    // model, and neither device's inversion level changed. The input device's source sits 0.3 V
    // above its body, which raises its gate-source voltage and its threshold by the same 60 mV,
    // so the body-grounded vgs(10) is the right argument for both devices.
    expect(relErr(res.values.headroom, 2 * vdsatDemo(VGS_GMID10_L05, 0.5e-6))).toBeLessThan(1e-2);
  });

  it('input capacitance is one input gate at the width the sizing landed on', () => {
    expect(relErr(res.values.cgg_in, cggOf(res.values.in__W, 0.5e-6))).toBeLessThan(1e-9);
  });
});

describe('tier4 goldens: Fully differential telescopic OTA', () => {
  const res = runSheet(sheet('fd-telescopic-ota'), table);
  // Defaults: I_tail 40 µA (20 µA/side), gm/ID in 12, casc/load 8, all L 0.5 µm.
  // Node levels V_s 0.32, V_a 0.55, V_out 0.95, V_b 1.30, VDD 1.8.
  const va = VA_PER_L * 0.5e-6;
  const gmIn = 12 * 20e-6;

  it('the cascoded gain matches gm_in·(Rdown ∥ Rup) from the branch closed forms', () => {
    const gdsIn = 20e-6 / (va + (0.55 - 0.32));
    const av0cascn = 8 * (va + (0.95 - 0.55));
    const gdsLoad = 20e-6 / (va + (1.8 - 1.3));
    const av0cascp = 8 * (va + (1.3 - 0.95));
    const av = gmIn * par(av0cascn / gdsIn, av0cascp / gdsLoad);
    expect(relErr(res.values.Av, av)).toBeLessThan(1e-2);
    // …and Rout is that same parallel combination, which the gain equation already reads through.
    expect(relErr(res.values.Rout, par(av0cascn / gdsIn, av0cascp / gdsLoad))).toBeLessThan(1e-2);
    expect(relErr(res.values.Av, gmIn * res.values.Rout)).toBeLessThan(1e-3);
  });

  it('input capacitance is the gate of one input device', () => {
    // Composition golden: the input child does not expose its sized width, so what is pinned is
    // which gate the equation reads — one input device, per input terminal, half-circuit like the
    // gain above.
    expect(res.values.cgg_in).toBe(res.values.in__cgg);
  });

  it('the supply-current line item adds the CMFB budget exactly', () => {
    expect(relErr(res.values.I_q, 40e-6 + 10e-6)).toBeLessThan(1e-9);
  });

  it('input noise counts both input devices and both load current sources', () => {
    // Each device's thermal density is sqrt(4kTγ/gm). A load's noise current reaches the output
    // in full, so it is referred to the input by gm_load/gm_in: the two sides together give
    // 2·4kTγ/gm_in·(1 + gm_load/gm_in). The load runs at gm/ID 8 on the same 20 µA, 160 µS
    // against the pair's 240 µS, so the loads raise the pair's own sqrt(2)·8.31 nV/rtHz by
    // sqrt(1 + 2/3) = 1.29, to 15.2 nV/rtHz.
    const gmLoad = 8 * 20e-6;
    const vn = Math.sqrt(2 * (vnthM(gmIn) ** 2 + (vnthM(gmLoad) * (gmLoad / gmIn)) ** 2));
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(1e-3);
    expect(relErr(res.values.vn_in, Math.SQRT2 * vnthM(gmIn) * Math.sqrt(1 + 8 / 12))).toBeLessThan(
      1e-3,
    );
    // The load term follows the load: at a lower gm/ID its gm, and its share, both fall.
    const quiet = runSheet(withParams(sheet('fd-telescopic-ota'), { gm_id_load: 4 }), table);
    expect(
      relErr(quiet.values.vn_in, Math.SQRT2 * vnthM(gmIn) * Math.sqrt(1 + 4 / 12)),
    ).toBeLessThan(1e-3);
  });

  it('differential swing is twice the range left after four cascode vdsat drops', () => {
    const v12 = vdsatDemo(VGS_GMID12_L05, 0.5e-6); // input pair, gm/ID 12
    const v8 = vdsatDemo(VGS_GMID8_L05, 0.5e-6); // cascodes + load, gm/ID 8
    const swing = 2 * (1.8 - v12 - 3 * v8 - 0.3);
    expect(relErr(res.values.swing_diff, swing)).toBeLessThan(1e-2);
  });
});

describe('tier4 goldens: Fully differential two-stage OTA', () => {
  const doc = sheet('fd-two-stage-ota');
  const res = runSheet(doc, table, undefined, REFS);
  const v = res.values;
  // Defaults mirror the single-ended Miller OTA; FD adds two stage-2 branches + CMFB, and its
  // stage-1 loads are current sources, so the two sides of the first stage are alike.
  /** What each side of the first stage is handed: half of what the tail delivers, 9.199 µA. */
  const iHalf = (I1 / 2) * TAIL_RATIO;
  const gm1 = 12 * iHalf;
  const gm2 = 12 * I2;

  it('one first-stage current is typed, and the tail is one gate wire', () => {
    // The programmed current goes into the bias reference and nowhere else: the stage-1 load and
    // the input device under it are HANDED half of what the tail delivers, to the last bit.
    expect(block(res, 'bias').id).toBe(I1);
    expect(v.tail__id).toBe(2 * block(res, 'in').id);
    expect(block(res, 'ld1').id).toBe(block(res, 'in').id);
    expect(block(res, 's2').id).toBe(I2);
    expect(block(res, 'tail').W).toBe(block(res, 'bias').W);
    expect(relErr(block(res, 'tail').vgs, block(res, 'bias').vgs)).toBeLessThan(1e-12);
  });

  it('the tail misses its reference by the drain-voltage ratio of the demo model', () => {
    // The tail node (0.361 V) sits below the reference's diode drop (0.610 V), so the tail
    // under-delivers by 1 − 0.919857 = 8.01 %. 1e-2 of that error is 2 mV of drain voltage.
    expect(relErr(1 - v.tail__id / I1, 1 - TAIL_RATIO)).toBeLessThan(1e-2);
  });

  it('bandwidth and slew follow what the tail delivers; the RHP zero is the second stage’s', () => {
    // The input device's gm is (gm/ID)·id with both given, and its id is half of 18.40 µA.
    expect(relErr(v.GBW, gm1 / (2 * Math.PI * CC))).toBeLessThan(1e-3);
    expect(relErr(v.GBW, (12 * block(res, 'in').id) / (2 * Math.PI * CC))).toBeLessThan(1e-9);
    expect(relErr(v.z_rhp, gm2 / CC)).toBeLessThan(1e-9);
    // The stage-1 limit binds: 18.40 µA into 3 pF is slower than 60 µA into 5 pF.
    expect(relErr(v.SR, Math.min((I1 * TAIL_RATIO) / CC, I2 / C_LOAD))).toBeLessThan(1e-3);
    expect(relErr(v.SR, v.tail__id / CC)).toBeLessThan(1e-12);
  });

  it('the phase margin costs the second pole only — the nulling resistor removes the zero', () => {
    // Rz = 1/gm2 moves the RHP zero to infinity, so the estimate carries no zero term; z_rhp
    // stays as the uncompensated reference point asserted above.
    expect(relErr(v.PM, pmOf(gm1))).toBeLessThan(1e-3);
    expect(relErr(v.PM, pmOf(v.gm1))).toBeLessThan(1e-9);
  });

  it('the stage-1 output level is what the stage-2 gate needs, not a typed number', () => {
    // V1 is the stage-2 gate, so it sits one stage-2 vgs below the supply: for gm/ID 12 at
    // L 0.5 µm that is 1.8 - 0.567023 = 1.232977 V. Declared wiring on that block restates the
    // same identity, so it agrees to the last digit and reports nothing.
    expect(relErr(v.V1, V_1)).toBeLessThan(1e-3);
    expect(res.warnings.filter((w) => w.rule === 'sheet-wiring')).toEqual([]);

    // That silence means nothing unless the check is LIVE on this sheet — a declaration this
    // sheet derives its own node from cannot disagree with itself, which is exactly the shape
    // that would hide a check that had quietly stopped running. Re-type the node 100 mV off,
    // the way a hand-typed V1 used to be, and it is reported at once, on the block that owns
    // the gate.
    const retyped = sheet('fd-two-stage-ota');
    const v1 = retyped.equations.find((r) => r.name === 'V1');
    expect(v1).toBeDefined();
    (v1 as { expr: string }).expr = 'VDD - abs(s2__vgs) + 0.1';
    const off = runSheet(retyped, table, undefined, REFS);
    expect(off.warnings.filter((w) => w.rule === 'sheet-wiring').map((w) => w.location)).toEqual([
      's2',
    ]);
  });

  it('the output interface is the stage-2 node, named, plus the input gate', () => {
    expect(relErr(v.Rout, stage2Rout(I2, L05, 0.9))).toBeLessThan(1e-9);
    expect(relErr(v.Av2, gm2 * v.Rout)).toBeLessThan(1e-12);
    expect(v.cgg_in).toBe(v.in__cgg);
  });

  it('stage-1 gain follows from the two levels that derived node fixes', () => {
    // The input device's drain is V1 = VDD - vgs(12) = 1.232977 V and its source the tail node
    // at 0.360814 V, so its drain-source voltage is 0.872163 V. The stage-1 load carries the
    // rest of the supply, VDD - V1 = vgs(12). Both carry the half current the tail delivers,
    // which cancels against the input gm: the gain is the same 19.27 a typed 10 µA would give.
    const gdsIn = gdsOf(iHalf, L05, V_1 - V_TAIL);
    const gdsLd1 = gdsOf(iHalf, L05, VGS_GMID12_L05);
    expect(relErr(v.Av1, gm1 / (gdsIn + gdsLd1))).toBeLessThan(1e-3);
  });

  it('the tail device keeps its headroom, and a common mode that takes it away is refused', () => {
    // The tail device shares its reference's gate, so its saturation voltage is the reference's:
    // 0.360814 − vdsat(vgs(10)) = 0.126 V of headroom at the default common mode.
    expect(relErr(v.tail_headroom, V_TAIL - vdsatDemo(VGS_GMID10_L05, L05))).toBeLessThan(1e-2);
    expect(relErr(v.tail_headroom, v.V_tail - v.tail__vdsat)).toBeLessThan(1e-12);
    expect(statusOf(res, 'tail-saturated')).toBe('pass');
    // A common mode of 0.75 V leaves the tail node (0.75 − 0.567023)/1.2 = 0.152 V, under the
    // tail device's 0.235 V. The check is physical, so the sheet is no longer feasible.
    const low = runSheet(withParams(doc, { CM_dc: 0.75 }), table, undefined, REFS);
    expect(low.values.tail_headroom).toBeLessThan(0);
    expect(statusOf(low, 'tail-saturated')).toBe('fail');
    expect(low.feasible).toBe(false);
  });

  it('total supply current is the two stage-2 branches, what the tail delivers, and the CMFB budget', () => {
    // 120 µA + 18.40 µA + 10 µA. The reference branch is shared bias and is not counted.
    expect(relErr(v.I_q, 2 * I2 + I1 * TAIL_RATIO + 10e-6)).toBeLessThan(1e-3);
    expect(relErr(v.I_q, 2 * I2 + v.tail__id + 10e-6)).toBeLessThan(1e-12);
    // FD output swing doubles the single-ended range set by the two output vdsats.
    const swing = 2 * (1.8 - vdsatDemo(VGS_GMID12_L05, L05) - vdsatDemo(VGS_GMID8_L05, L05));
    expect(relErr(v.swing_diff, swing)).toBeLessThan(1e-2);
  });

  it('held at another condition, the first stage follows its tail', () => {
    // Every width is the sized one. The reference keeps the current it is programmed to, so at
    // half the current density it needs a higher gate voltage, and the tail device follows it
    // there instead of being handed 20 µA; the load and the input device are handed half of
    // what it delivers at the tail node this condition leaves it.
    const [s, h] = sizedAndHeld(doc);
    for (const name of ['s2', 'bias', 'tail', 'ld1', 'in', 'ld2'])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    expect(block(h, 'bias').id).toBe(I1);
    expect(block(h, 'bias').vgs).toBeGreaterThan(block(s, 'bias').vgs);
    expect(relErr(block(h, 'tail').vgs, block(h, 'bias').vgs)).toBeLessThan(1e-12);
    expect(h.values.tail__id).toBe(2 * block(h, 'in').id);
    expect(block(h, 'ld1').id).toBe(block(h, 'in').id);
    expect(h.values.tail__id).toBeLessThan(s.values.tail__id);
    const tail = (VA05 + h.values.V_tail) / (VA05 + block(h, 'bias').vgs);
    expect(relErr(1 - h.values.tail__id / I1, 1 - tail)).toBeLessThan(1e-2);
  });
});
