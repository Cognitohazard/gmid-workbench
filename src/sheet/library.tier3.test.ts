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
//  - The threshold is the only thing length moves on the gm/ID curve, and the reported vdsat is
//    2·UT plus the overdrive, so a gate-source voltage at another length and a saturation voltage
//    both have closed forms (see vthDemo below).

import { describe, it, expect } from 'vitest';
import { PHYS, UT } from '../constants';
import { BODY_FACTOR, scaleQuantities } from '../demo';
import type { DeviceTable } from '../types';
import { runSheet, withParams } from './index';
import { isHardCheck, type SizingReport, type SheetDoc, type SheetResult } from './types';
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
  VGS_GMID8_L05,
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

/** One check's outcome, by id. */
const check = (r: SheetResult, id: string) => r.checks.find((c) => c.id === id)!;

/** The saturation check a device's `region` declaration adds to its own results, by block. */
const regionOf = (
  r: { blocks?: SheetResult['blocks'] },
  name: string,
): SheetResult['checks'][number] =>
  r.blocks!.find((c) => c.name === name)!.checks.find((c) => c.id === 'region')!;

/** Every hard check that fails anywhere in an evaluation, the sheet's own by id and a block's
 *  as `block.id`. */
const hardFailsIn = (r: Pick<SheetResult, 'checks' | 'blocks'>): string[] => [
  ...r.checks.filter((c) => isHardCheck(c.kind) && c.status === 'fail').map((c) => c.id),
  ...(r.blocks ?? []).flatMap((b) =>
    b.checks
      .filter((c) => isHardCheck(c.kind) && c.status === 'fail')
      .map((c) => `${b.name}.${c.id}`),
  ),
];

/** The blocks of a sheet that declare saturation, in document order. */
const declaredSaturated = (doc: SheetDoc): string[] =>
  (doc.blocks ?? []).filter((u) => u.doc?.givens?.region === 'saturation').map((u) => u.name);

/** Threshold of the demo model at length `len`, body at the source: 0.4 V plus a term that grows
 *  with length, 0.02·ln(len/0.18 µm + 1) (src/demo/index.ts). Length moves nothing else on the
 *  gm/ID curve, so this is what carries a gate-source voltage from one length to another and
 *  what turns one into an overdrive. */
const vthDemo = (len: number): number => 0.4 + 0.02 * Math.log(len / 0.18e-6 + 1);

/** Gate-source voltage of an inversion level at length `len`, from the value the same level
 *  needs at 0.5 µm: the whole curve moves with the threshold. */
const vgsAtLength = (vgs05: number, len: number): number => vgs05 + vthDemo(len) - vthDemo(L);

/** Saturation voltage the demo model reports for a device at gate-source voltage `vgs` and
 *  length `len`, body at the source: a 2·UT floor plus the overdrive. It does not move with the
 *  drain voltage, so a device on another's gate reports its reference's. */
const vdsatDemo = (vgs: number, len: number): number => 2 * UT + (vgs - vthDemo(len));

/** What a tail device delivers of the current its reference is programmed to: the reference's
 *  width on the reference's gate, with the tail node as its drain-source voltage, so the ratio is
 *  (VA + V_tail)/(VA + vgs_ref) at the mirror's length — the reference is diode-connected. */
const tailRatioAt = (vTail: number, vgsRef: number, len = L): number =>
  (va(len) + vTail) / (va(len) + vgsRef);

/** The goldens every sheet with a drawn tail shares: `bias` is the one device the programmed
 *  current `iTail` is typed into, `tail` is that reference's width on that reference's gate with
 *  the tail node as its drain, and the pair takes half of what the tail delivers there. `vTail` and
 *  `vgsRef` are the closed forms of the tail node and of the reference's gate voltage, and
 *  `cmTooLow` a common mode that leaves the tail device short of its saturation voltage. */
const itDrawsItsTail = (
  doc: SheetDoc,
  res: SheetResult,
  iTail: number,
  vTail: number,
  vgsRef: number,
  cmTooLow?: number,
): void => {
  it('one current is typed, into the bias reference, and the tail is on its gate', () => {
    // Kirchhoff at the tail node, to the last bit: the pair is HANDED the tail's current, halved,
    // and only the reference is sized against the programmed number.
    expect(block(res, 'bias').id).toBe(iTail);
    expect(res.values.tail__id).toBe(2 * res.values.in__id);
    // A 1:1 mirror is the same width on the same gate, and the tail node is its drain. The gate
    // voltage is reported as the table's own vgs coordinate at the point it was read, so two
    // devices on one wire agree to rounding rather than always to the last bit.
    expect(block(res, 'tail').W).toBe(block(res, 'bias').W);
    expect(relErr(block(res, 'tail').vgs, block(res, 'bias').vgs)).toBeLessThan(1e-12);
    expect(block(res, 'tail').bias?.vds).toBe(res.values.V_tail);
    expect(relErr(res.values.V_tail, vTail)).toBeLessThan(1e-3);
  });

  it('the tail misses its reference by the drain-voltage ratio of the demo model', () => {
    // The tail node sits below the reference's diode drop, so the tail under-delivers. Compared
    // as an error, the way the mirror goldens compare theirs: the diode diagonal is interpolated,
    // so the ratio is not exact on the table.
    const tailErr = 1 - res.values.tail__id / iTail;
    expect(tailErr).toBeGreaterThan(0);
    expect(relErr(tailErr, 1 - tailRatioAt(vTail, vgsRef))).toBeLessThan(1e-2);
  });

  it("the headroom row is the tail node less the tail device's own saturation voltage", () => {
    // The tail device is on its reference's gate, and the model's saturation voltage follows the
    // gate alone, so the row has a closed form.
    // The tail node sits between two body-bias slices of the table, which moves it by up to
    // 0.2 mV against its closed form: 2e-3 of a 0.13 V headroom.
    const headroom = vTail - vdsatDemo(vgsRef, L);
    expect(relErr(res.values.tail_headroom, headroom)).toBeLessThan(2e-3);
    expect(res.values.tail_headroom).toBe(res.values.V_tail - res.values.tail__vdsat);
    // The tail declares that it must stay saturated, which is a physical check on the tail device
    // itself: the tail node against the same saturation voltage. No authored check repeats it.
    expect(doc.blocks!.find((u) => u.name === 'tail')!.doc!.givens!.region).toBe('saturation');
    const saturated = regionOf(res, 'tail');
    expect([saturated.kind, saturated.status]).toEqual(['physical', 'pass']);
    expect(saturated.lhsValue).toBe(res.values.V_tail);
    expect(saturated.rhsValue).toBe(res.values.tail__vdsat);
    expect(doc.checks.map((c) => c.id)).not.toContain('tail-saturated');
  });

  if (cmTooLow === undefined) return;
  it("a common mode too low for the tail fails at that range end, on the tail's own check", () => {
    // The low end of the common-mode range is where the tail device runs out of drain-source
    // voltage. `cmTooLow` is the common mode that puts the tail node 30 mV under the tail's
    // saturation voltage for a pair free to re-size. The design is held at a range end, and the
    // tail delivers less with its drain that low, so the pair's gate backs off and the node lands
    // a few millivolts higher than that — still well under the saturation voltage. Claiming it
    // as the low end changes nothing where the design is sized, and at that range end the tail's
    // saturation check is the one hard check that fails.
    const vdsat = vdsatDemo(vgsRef, L);
    const claimed = runSheet(withParams(doc, { CM_lo: cmTooLow }), table);
    expect(claimed.feasible).toBe(res.feasible);
    const lo = claimed.rangeEnds!.find((e) => e.name === 'cm-lo')!;
    expect(lo.error).toBeUndefined();
    expect(lo.state).toBe('does-not-comply');
    expect(hardFailsIn(lo)).toEqual(['tail.region']);
    expect(lo.solved.V_tail).toBeGreaterThan(vdsat - 0.03);
    expect(lo.solved.V_tail).toBeLessThan(vdsat - 0.015);
    const tailAt = lo.blocks!.find((c) => c.name === 'tail')!.provides;
    const saturated = regionOf(lo, 'tail');
    expect(saturated.lhsValue).toBe(lo.solved.V_tail);
    expect(
      relErr(saturated.lhsValue! - saturated.rhsValue!, lo.solved.V_tail - tailAt.vdsat),
    ).toBeLessThan(1e-9);
    expect(relErr(tailAt.vdsat, vdsat)).toBeLessThan(1e-3);
  });
};

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
 *  voltage of the pair's inversion level `gmId`.
 *
 *  Under a `mirroredTail` the current is not the same either: the tail device is on its
 *  reference's gate with the node as its drain, so it delivers (VA + node_end)/(VA + node_base)
 *  times what it did, and the pair needs its gate drive changed by the log of that ratio over
 *  gm/ID as well, taken at the same re-sized landing. */
const heldTailNode = (
  cm: number,
  cmBase: number,
  vgs0: number,
  gmId: number,
  drain: number,
  mirroredTail = false,
): number => {
  const base = sourceNodeUnder(cmBase, vgs0);
  const resized = sourceNodeUnder(cm, vgs0);
  const more = Math.log((va(L) + drain - resized) / (va(L) + drain - base));
  const less = mirroredTail ? Math.log((va(L) + resized) / (va(L) + base)) : 0;
  return sourceNodeUnder(cm + (more - less) / gmId, vgs0);
};

/** The cgg_in golden five of these OTAs share verbatim; registered per describe. */
const itIsOneInputGate = (res: SheetResult): void => {
  it('input capacitance is one input gate at the width the sizing landed on', () => {
    expect(relErr(res.values.cgg_in, cggInOf(res))).toBeLessThan(1e-9);
  });
};

describe('tier-3: which devices each OTA needs saturated', () => {
  // Written down from each schematic: every device the amplifier needs in saturation — tails,
  // pairs, cascodes, current sources and mirror output devices — and none of the diode-connected
  // ones, whose drain is their gate. A declaration dropped, or one added to a device the design
  // does not need saturated, fails here by name.
  const SATURATED: Record<string, string[]> = {
    'current-mirror-ota.json': ['tail', 'in', 'moutp', 'mfold', 'moutn'],
    'degenerated-differential-pair.json': ['tail', 'in'],
    'differential-pair-tail.json': ['tail', 'in'],
    'five-transistor-ota.json': ['tail', 'in', 'inr', 'ld'],
    'folded-cascode-ota.json': ['tail', 'in', 'pcs', 'pcasc', 'ncasc', 'nmir'],
    'gain-boosted-cascode-ota.json': ['tail', 'in', 'casc_n', 'casc_p', 'mir', 'boost'],
    'inverter-based-ota.json': ['n', 'p'],
    'telescopic-cascode-ota.json': ['tail', 'in', 'casc_n', 'casc_p', 'mir'],
  };
  it('every OTA declares exactly the devices its design needs saturated', () => {
    for (const [file, devices] of Object.entries(SATURATED))
      expect([file, declaredSaturated(sheet(file))]).toEqual([file, devices]);
  });
  it('each declaration is a passing physical check on its own device where the design is sized', () => {
    // On the synthetic table at the shipped defaults. A declaration on a device that does not
    // size reads `na` and fails closed, so this is also the guarantee that every one is read.
    for (const [file, devices] of Object.entries(SATURATED)) {
      const res = runSheet(sheet(file), table, undefined, REFS);
      for (const name of devices) {
        const c = regionOf(res, name);
        expect([file, name, c.kind, c.status === 'fail' || c.status === 'na']).toEqual([
          file,
          name,
          'physical',
          false,
        ]);
      }
    }
  });
});

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
  const doc = sheet('degenerated-differential-pair.json');
  const res = runSheet(doc, table);
  // Defaults: the bias reference programmed to I_tail = 22 µA at gm/ID 14 and 0.5 µm, the tail
  // device on its gate, the pair at gm/ID 14 and L 2 µm with R_s 12 kΩ in each source, V_out 0.9,
  // CM_dc 1.15. The two resistors meet at the tail node, which is the variable the common mode is
  // solved through; the pair's source sits one resistor drop above it.
  const I_TAIL = 22e-6;
  const R_S = 12000;
  const L_IN = 2e-6;
  const vgsRef = VGS_GMID14_L05; // the reference, at the mirror's 0.5 µm
  const vgsIn = vgsAtLength(VGS_GMID14_L05, L_IN); // 0.555395 V, body at the source
  // The pair's source is its body bias as well, so it is placed by the common mode alone, exactly
  // as a tail node under an undegenerated pair is:
  //   source node   V_s = (CM_dc − vgs(14))/1.2 = (1.15 − 0.555395)/1.2 = 0.495504 V
  // The tail node sits one resistor drop below it, and the drop is made by the current the tail
  // delivers AT that node, I_half = (I_tail/2)·(VA + V_tail)/(VA + vgs_ref). That is linear in the
  // node: with a = (I_tail/2)·R_s/(VA + vgs_ref) = 0.132/3.032095 = 0.043534,
  //   V_s = V_tail + a·(VA + V_tail)   ⇒   V_tail = (V_s − a·VA)/(1 + a) = 0.370537 V
  //   tail mirror   (2.5 + 0.370537)/(2.5 + 0.532095) = 0.946717, so each side carries 10.414 µA
  const vS = sourceNodeUnder(1.15, vgsIn);
  const a = ((I_TAIL / 2) * R_S) / (va(L) + vgsRef);
  const vTail = (vS - a * va(L)) / (1 + a);
  const iHalf = (I_TAIL / 2) * tailRatioAt(vTail, vgsRef);
  const gmIn = 14 * iHalf; // (gm/ID)·id, both supplied in the givens
  // Both source-referred generators drive current through R_s, so the degeneration factor
  // carries gmb alongside gm. gmb rides the interpolated gm curve rather than the given
  // gm/ID, so equations built on it hold to interpolation order rather than to 1e-9.
  const nDeg = 1 + (gmIn + gmbOf(gmIn)) * R_S;
  // A common mode that leaves the tail device 30 mV short: the same two steps, backwards.
  const vTailLow = vdsatDemo(vgsRef, L) - 0.03;
  const cmTooLow = (1 + BODY_FACTOR) * (vTailLow + a * (va(L) + vTailLow)) + vgsIn;

  itDrawsItsTail(doc, res, I_TAIL, vTail, vgsRef, cmTooLow);

  it("the pair's source sits one resistor drop above the tail node", () => {
    expect(res.values.CM_in).toBeCloseTo(1.15, 5);
    expect(relErr(res.values.V_s, vS)).toBeLessThan(1e-3);
    // The drop is the current the input device carries through its own resistor: 0.124967 V.
    expect(relErr(res.values.V_s - res.values.V_tail, iHalf * R_S)).toBeLessThan(1e-3);
    expect(relErr(res.values.V_s, res.values.V_tail + res.values.in__id * R_S)).toBeLessThan(1e-12);
    // That node is the device's body bias, and its drain-source voltage is measured from it.
    expect(relErr(block(res, 'in').bias!.vsb, res.values.V_s)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'in').bias!.vds, 0.9 - res.values.V_s)).toBeLessThan(1e-12);
  });

  it('the degeneration factor divides gm and GBW by both source generators', () => {
    expect(relErr(res.values.n_deg, nDeg)).toBeLessThan(1e-3);
    expect(relErr(res.values.Gm_eff, gmIn / nDeg)).toBeLessThan(1e-3);
    expect(relErr(res.values.GBW, gmIn / nDeg / (TWO_PI * CL))).toBeLessThan(1e-3);
  });

  it('slew, linear range and supply current follow from the current the tail delivers', () => {
    // 22 µA × 0.946717 = 20.828 µA — not the 22 µA the reference is programmed to.
    expect(relErr(res.values.SR, (2 * iHalf) / CL)).toBeLessThan(1e-3);
    expect(relErr(res.values.linrange, 2 / 14 + iHalf * R_S)).toBeLessThan(1e-3);
    // Which current each equation reads, exactly: the tail's own, and the pair's half of it.
    expect(relErr(res.values.SR, res.values.tail__id / CL)).toBeLessThan(1e-12);
    expect(relErr(res.values.linrange, 2 / 14 + res.values.in__id * R_S)).toBeLessThan(1e-12);
    // The reference branch is shared bias and is not counted.
    expect(res.values.I_q).toBe(res.values.tail__id);
  });

  it('offset improves by exactly the degeneration factor', () => {
    expect(relErr(res.values.vos / res.values.vos_undeg, 1 / nDeg)).toBeLessThan(1e-3);
  });

  it('input noise takes the device at its gate and the resistor through the source', () => {
    // Per side, the device's own gate-referred density, 4kTγ/gm, and the resistor's 4kT·R_s. The
    // resistor's noise is a voltage in series with the source, and a source voltage moves the
    // drain current through gm + gmb where a gate voltage moves it through gm, so it refers to
    // the gate through (gm + gmb)/gm — 1.2 in the demo model, 1.44 in power:
    //   device    4kTγ/gm      = 1.6576e-20/145.79 µS    = 1.1369e-16 V²/Hz
    //   resistor  4kT·R_s·1.44 = 1.9891e-16 × 1.44       = 2.8643e-16 V²/Hz
    // Both sides of the pair: sqrt(2 × 4.0013e-16) = 28.29 nV/√Hz.
    const viaSource = (gmIn + gmbOf(gmIn)) / gmIn;
    const device = vnthM(gmIn) ** 2;
    const resistor = 4 * PHYS.k * PHYS.T * R_S;
    expect(
      relErr(res.values.vn_in, Math.sqrt(2 * (device + resistor * viaSource ** 2))),
    ).toBeLessThan(1e-3);
    // Which quantities the equation reads, exactly: the device's own gm and gmb for the path, and
    // nothing on the device's own term.
    const path = (res.values.in__gm + res.values.in__gmb) / res.values.in__gm;
    expect(
      relErr(res.values.vn_in, Math.sqrt(2 * (res.values.in__vnth_m ** 2 + resistor * path ** 2))),
    ).toBeLessThan(1e-12);
    // Referred as if it sat at the gate, the resistor would leave the row at 25.0 nV/√Hz, 12 % low.
    const atTheGate = Math.sqrt(2 * (device + resistor));
    expect(atTheGate / res.values.vn_in).toBeLessThan(0.9);
    expect(
      relErr(
        atTheGate / res.values.vn_in,
        Math.sqrt((device + resistor) / (device + resistor * viaSource ** 2)),
      ),
    ).toBeLessThan(1e-3);
  });

  it('degeneration lowers the transconductance but not the output node it drives', () => {
    // Rout is the input device gds against the estimated load conductance — the equation
    // deliberately does NOT claim the degeneration boost the source resistor also gives the device
    // r_o, which is the same conservatism the gain note already records. The device carries the
    // half current at vds = V_out_dc − V_s and L 2 µm, so gds = I/(VA + vds) with VA = 10 V:
    // 10.414 µA/10.404 V = 1.001 µS against the 3 µS the sheet is told, 249.9 kΩ.
    const rout = 1 / (gdsOf(iHalf, L_IN, 0.9 - vS) + 3e-6);
    expect(relErr(res.values.Rout, rout)).toBeLessThan(1e-3);
    expect(relErr(res.values.Av, res.values.Gm_eff * res.values.Rout)).toBeLessThan(1e-12);
    expect(relErr(res.values.cgg_in, cggOf(res.values.in__W, L_IN))).toBeLessThan(1e-9);
  });

  it('meets its own checks where it is sized, and at both ends of its common-mode range', () => {
    // The defaults are chosen so that it does. The gain needs the long input device: at 0.5 µm
    // the device's own output conductance equals the 3 µS load and the gain is 7.5 against a
    // target of 10. The linear range needs the tail to deliver about 20 µA into the two resistors,
    // which takes a reference programmed a little above that.
    expect(res.feasible).toBe(true);
    expect(res.rangeEnds?.map((e) => [e.name, e.state])).toEqual([
      ['cm-lo', 'complies'],
      ['cm-hi', 'complies'],
    ]);
  });
});

describe('tier-3 goldens: telescopic cascode OTA', () => {
  const doc = sheet('telescopic-cascode-ota.json');
  const res = runSheet(doc, table);
  // Defaults: the bias reference programmed to I_tail = 20 µA at gm/ID 10, the tail device on its
  // gate, gm/ID in 14 / casc 10 / mir 8, all L 0.5 µm; the stack is parameterized by its NODES —
  // V_a 0.55, V_b 1.35, V_out 0.9, the tail node constrained so CM_in lands on CM_dc 0.97 — and
  // every device vds is a subtraction between them. Every device in the stack carries the input
  // device's current, half of what the tail delivers.
  // (The telescopic's ICMR is a slot: the DC point has to sit inside the claimed [0.95, 1.12]
  // and under what the tail bracket can produce. On the demo table that is the bracket's 0.45 V
  // top plus the pair's gate-source voltage there, 0.45 + vgs(14) + 0.2 × 0.45 = 1.072 V — above
  // the 0.97 V design point, and below the claimed 1.12 V end, which is therefore not reached.)
  //   tail node    (CM_dc − vgs(14))/1.2 = (0.97 − 0.532095)/1.2 = 0.364921 V
  //   tail device  (2.5 + 0.364921)/(2.5 + 0.610063) = 0.921178   (reference at vgs(10))
  const I_TAIL = 20e-6;
  const vTail = sourceNodeUnder(0.97, VGS_GMID14_L05);
  /** What each side of the stack carries: half of what the tail delivers, 9.212 µA. */
  const iHalf = (I_TAIL / 2) * tailRatioAt(vTail, VGS_GMID10_L05);
  const gmIn = 14 * iHalf;

  // The low-common-mode golden of the shared tail goldens is left out: on this table the design
  // also misses its offset and swing targets, so a range end there fails more than the tail.
  itDrawsItsTail(doc, res, I_TAIL, vTail, VGS_GMID10_L05);

  it('slew and GBW follow from the current the tail delivers and the input gm', () => {
    // 20 µA × 0.921178 = 18.424 µA — not the 20 µA the reference is programmed to.
    expect(relErr(res.values.SR, (2 * iHalf) / CL)).toBeLessThan(1e-3);
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-3);
    // Which current each equation reads, exactly: the tail's own, and the pair's half of it.
    expect(relErr(res.values.SR, res.values.tail__id / CL)).toBeLessThan(1e-12);
    expect(relErr(res.values.GBW, (14 * res.values.in__id) / (TWO_PI * CL))).toBeLessThan(1e-9);
    expect(res.values.I_q).toBe(res.values.tail__id);
    for (const name of ['casc_n', 'casc_p', 'mir'])
      expect([name, block(res, name).id]).toEqual([name, block(res, 'in').id]);
  });

  it('the design constraint lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(0.97, 5);
  });

  it('gain is gm_in times the parallel cascoded output resistance', () => {
    // Node subtractions, with the solved tail node read from the result: the input device
    // sits at vds = V_a − V_tail, its cascode at V_out − V_a; the PMOS side at the V_b splits.
    // Every device carries the same current, so it cancels out of the gain.
    const Rn = av0Of(10, L, 0.9 - 0.55) / gdsOf(iHalf, L, 0.55 - res.values.V_tail);
    const Rp = av0Of(10, L, 1.35 - 0.9) / gdsOf(iHalf, L, 1.8 - 1.35);
    const Rout = 1 / (1 / Rn + 1 / Rp);
    expect(relErr(res.values.Av, gmIn * Rout)).toBeLessThan(1e-2);
  });

  it('every device in the stack declares that it must stay saturated', () => {
    // The stack's saturation is what its node placement buys, so every device in it says so, and
    // each declaration is a physical check on its own device at its own drain-source voltage.
    expect(declaredSaturated(doc)).toEqual(['tail', 'in', 'casc_n', 'casc_p', 'mir']);
    const across = {
      in: 0.55 - res.values.V_tail,
      casc_n: 0.9 - 0.55,
      casc_p: 1.35 - 0.9,
      mir: 1.8 - 1.35,
    };
    for (const [name, vds] of Object.entries(across)) {
      const c = regionOf(res, name);
      expect([name, c.kind, c.status]).toEqual([name, 'physical', 'pass']);
      expect([name, relErr(c.lhsValue!, vds) < 1e-9]).toEqual([name, true]);
    }
    // Squeeze the input device's drain node down onto its source and its declaration is what
    // trips: V_a 0.40 leaves it 35 mV against a saturation voltage of 0.16 V.
    const squeezed = runSheet(withParams(doc, { V_a: 0.4 }), table);
    expect(hardFailsIn(squeezed)).toContain('in.region');
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

  it('at a range end the tail node and the cascode node above the pair settle together', () => {
    // Where the design is held, the tail node is solved for the common mode and the node under the
    // N cascode for that cascode's held gate; the pair's current is half of what the tail
    // delivers at the tail node, and the pair's drain is the cascode node, so each reads the
    // other. The engine settles the two by repeated searches. At cm-lo both relations hold to the
    // solve's tolerance on the design the base run sized.
    const lo = res.rangeEnds!.find((e) => e.name === 'cm-lo')!;
    expect(lo.error).toBeUndefined();
    const inAt = lo.blocks!.find((c) => c.name === 'in')!.sizing!;
    const cascAt = lo.blocks!.find((c) => c.name === 'casc_n')!.sizing!;
    expect(lo.solved.V_tail + inAt.vgs).toBeCloseTo(0.95, 5);
    expect(lo.solved.V_a + cascAt.vgs).toBeCloseTo(res.held!.V_a, 5);
    const tailAt = lo.blocks!.find((c) => c.name === 'tail')!.sizing!;
    expect(
      relErr(1 - tailAt.id / I_TAIL, 1 - tailRatioAt(lo.solved.V_tail, VGS_GMID10_L05)),
    ).toBeLessThan(1e-2);
    expect(inAt.id).toBe(tailAt.id / 2);
  });

  itIsOneInputGate(res);
});

describe('tier-3 goldens: folded cascode OTA', () => {
  const doc = sheet('folded-cascode-ota.json');
  const res = runSheet(doc, table);
  // Defaults: the bias reference programmed to I_tail = 20 µA at gm/ID 8 and 0.5 µm, the tail
  // device on its gate, I_branch 30 µA, gm/ID in 14 / casc 10 / cs 8; the cascodes at 0.5 µm, the
  // input pair, the folding current sources and the output mirror at 1 µm; node-parameterized —
  // V_fold 1.4, V_c 0.3, V_out 0.9, the tail node constrained so CM_in lands on CM_dc 1.05 — and
  // every device vds is a subtraction between adjacent nodes. The pair at 1 µm needs the 0.5 µm
  // gate-source voltage of gm/ID 14 moved by the model's threshold step between the two lengths.
  //   pair         vgs(14) at 1 µm = 0.532095 + 0.011023 = 0.543119 V
  //   tail node    (CM_dc − 0.543119)/1.2 = 0.422401 V
  //   tail device  (2.5 + 0.422401)/(2.5 + 0.668042) = 0.922463   (reference at vgs(8))
  const I_TAIL = 20e-6;
  const L_IN = 1e-6;
  const L_CS = 1e-6;
  const vgsIn = vgsAtLength(VGS_GMID14_L05, L_IN);
  const vTail = sourceNodeUnder(1.05, vgsIn);
  /** What each input device carries: half of what the tail delivers, 9.225 µA. */
  const iHalf = (I_TAIL / 2) * tailRatioAt(vTail, VGS_GMID8_L05);
  const gmIn = 14 * iHalf;
  /** The fold current: the branch bias less what the input device takes, 20.775 µA. */
  const iFold = 30e-6 - iHalf;
  // A common mode that leaves the tail device 30 mV short of its saturation voltage, for the pair
  // at gm/ID 14 standing on it: 1.2 × 0.263163 + 0.543119 = 0.858914 V.
  const cmTooLow = (1 + BODY_FACTOR) * (vdsatDemo(VGS_GMID8_L05, L) - 0.03) + vgsIn;
  /** Where the tail node lands at a range end with every device held: the pair (Early voltage
   *  `vaPair`, its drain at `drain`) carries half of what the tail delivers, and the tail device
   *  (Early voltage `vaTail`) delivers in proportion to (VA + node). heldTailNode's argument, with
   *  each device's own length. */
  const heldAt = (cm: number, vaPair: number, vaTail: number): number => {
    const base = sourceNodeUnder(1.05, vgsIn);
    const resized = sourceNodeUnder(cm, vgsIn);
    const more = Math.log((vaPair + 1.4 - resized) / (vaPair + 1.4 - base));
    const less = Math.log((vaTail + resized) / (vaTail + base));
    return sourceNodeUnder(cm + (more - less) / 14, vgsIn);
  };

  itDrawsItsTail(doc, res, I_TAIL, vTail, VGS_GMID8_L05, cmTooLow);

  it('the fold current is the branch bias less what the input device takes', () => {
    expect(relErr(res.values.I_fold, iFold)).toBeLessThan(1e-3);
    expect(relErr(res.values.I_fold, 30e-6 - res.values.in__id)).toBeLessThan(1e-12);
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-3);
    expect(relErr(res.values.SR, res.values.tail__id / CL)).toBeLessThan(1e-12);
    // The branch must take at least the input device's current, so that slewing the whole tail
    // into one folding node does not starve it: the check compares the two currents the run reads.
    const fold = check(res, 'fold-current');
    expect([fold.lhsValue, fold.rhsValue]).toEqual([res.values.I_fold, res.values.in__id]);
  });

  it('the supply carries the two folding branches, and the tail current runs through them', () => {
    // Only the two folding current sources sit on the supply rail, so what VDD delivers is
    // 2 × 30 µA. The tail is not a third branch: it is drawn down THROUGH those sources, so
    // the equation is 2·I_branch. The cross-check is the other end of the circuit — everything
    // reaching ground is what the tail delivers plus both fold currents, and KCL requires the two
    // to be the same 60 µA.
    expect(relErr(res.values.I_q, 2 * 30e-6)).toBeLessThan(1e-9);
    expect(relErr(res.values.I_q, res.values.tail__id + 2 * res.values.I_fold)).toBeLessThan(1e-12);
  });

  it('the design constraint lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(1.05, 5);
  });

  it('gain is gm_in times the parallel folded-cascode output resistance', () => {
    // The cascodes sit at 0.5 µm, the current sources they stand on at 1 µm, where VA is 5 V.
    const Rp = av0Of(10, L, 1.4 - 0.9) / gdsOf(30e-6, L_CS, 1.8 - 1.4); // pcasc av0 / pcs gds
    const Rn = av0Of(10, L, 0.9 - 0.3) / gdsOf(iFold, L_CS, 0.3); // ncasc av0 / nmir gds
    const Rout = 1 / (1 / Rp + 1 / Rn);
    expect(relErr(res.values.Av, gmIn * Rout)).toBeLessThan(1e-2);
  });

  it('every device declares that it must stay saturated', () => {
    expect(declaredSaturated(doc)).toEqual(['tail', 'in', 'pcs', 'pcasc', 'ncasc', 'nmir']);
    const across = {
      in: 1.4 - res.values.V_tail,
      pcs: 1.8 - 1.4,
      pcasc: 1.4 - 0.9,
      ncasc: 0.9 - 0.3,
      nmir: 0.3,
    };
    for (const [name, vds] of Object.entries(across)) {
      const c = regionOf(res, name);
      expect([name, c.kind]).toEqual([name, 'physical']);
      expect([name, c.status === 'pass' || c.status === 'amber']).toEqual([name, true]);
      expect([name, relErr(c.lhsValue!, vds) < 1e-9]).toEqual([name, true]);
    }
    // The output mirror sits 7 mV above its saturation voltage at V_c = 0.3 V on this table, inside
    // the near-miss band; a node 20 mV lower takes it out, and its declaration is what says so.
    expect(regionOf(res, 'nmir').status).toBe('amber');
    expect(hardFailsIn(runSheet(withParams(doc, { V_c: 0.28 }), table))).toContain('nmir.region');
  });

  it('meets its own checks where it is sized, and at both ends of its common-mode range', () => {
    // The defaults are chosen so that it does. With the pair carrying half of what the tail
    // delivers rather than half of the programmed current, the pair, the output mirror and the
    // folding sources need their 1 µm: with all of them at 0.5 µm the gain is 222 against a target
    // of 300 and the offset 18.5 mV against 12 mV.
    expect(res.feasible).toBe(true);
    expect(res.rangeEnds?.map((e) => [e.name, e.state])).toEqual([
      ['cm-lo', 'complies'],
      ['cm-hi', 'complies'],
    ]);
    const short = runSheet(withParams(doc, { L_cs: 0.5e-6, L_in: 0.5e-6 }), table);
    expect(hardFailsIn(short)).toEqual(['gain-spec', 'offset-spec']);
  });

  it('checks its claimed common-mode range on THIS design, not on a re-sized one', () => {
    // A range end re-measures the amplifier the defaults produced: every device keeps the width
    // and length the base run solved, to the last bit, and the endpoint bias comes out of the
    // operating point instead.
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
    // Pulling the input common mode 50 mV down to 1.0 V moves the tail node about 40 mV and the
    // pair's gate-source voltage the rest. The pair's source is the tail node, so most of that is
    // the body effect giving back BODY_FACTOR × the node's move. The remainder is the pair being
    // held at the width the base run sized: its drain stays near the fold node, so what the tail
    // gives up lands on its own vds, and the tail device — on its reference's gate with the node
    // as its drain — delivers less there, so the pair needs less gate drive for its half.
    const lo = res.rangeEnds!.find((e) => e.name === 'cm-lo')!;
    expect(lo.error).toBeUndefined();
    const heldLo = heldAt(1.0, va(L_IN), va(L));
    expect(relErr(lo.solved.V_tail, heldLo)).toBeLessThan(1e-3);
    // A pair re-sized at this end would land 1.4 mV lower, and one held at an ideal tail current
    // 1.0 mV lower: the tolerance tells all three apart.
    expect(relErr(sourceNodeUnder(1.0, vgsIn), heldLo)).toBeGreaterThan(3e-3);
    // (an ideal tail current is a tail whose Early voltage is too large for the node to move it).
    expect(relErr(heldAt(1.0, va(L_IN), 1e30), heldLo)).toBeGreaterThan(2e-3);
    const inAt = lo.blocks!.find((c) => c.name === 'in')!.sizing!;
    expect(lo.solved.V_tail + inAt.vgs).toBeCloseTo(1.0, 5);
    const tailAt = lo.blocks!.find((c) => c.name === 'tail')!.sizing!;
    expect(inAt.id).toBe(tailAt.id / 2);
    // cm-hi lands too. The pair's gate needs BODY_FACTOR·V_tail more than it would body-grounded,
    // so the 1.45 V end is produced with the tail node at 0.746 V, inside its [0.1, 0.8] bracket
    // (body-grounded it would take 1.45 − 0.543 = 0.907 V, which the bracket does not reach).
    const hi = res.rangeEnds!.find((e) => e.name === 'cm-hi')!;
    expect(hi.error).toBeUndefined();
    expect(relErr(hi.solved.V_tail, heldAt(1.45, va(L_IN), va(L)))).toBeLessThan(1e-3);
  });

  it('gives no answer at a range end its tail-node bracket cannot produce', () => {
    // The case where the solve never LANDS (the shipped ends both land and comply), and the only
    // honest assertions about it are the three the engine actually vouches for. The top of the
    // tail bracket produces about 0.8 + 0.543 + 0.2 × 0.8 = 1.503 V; an application that presents
    // 1.6 V asks for more than that. The tail-node constraint then finds no sign change anywhere
    // in the bracket, so nothing was measured at that end: it is no answer, not a failure, and
    // `solved` is left empty so no consumer can go looking for a landing.
    expect(0.8 + vgsAtBody(vgsIn, 0.8)).toBeLessThan(1.6);
    const far = runSheet(withParams(doc, { CM_hi: 1.6 }), table);
    const hi = far.rangeEnds?.find((e) => e.name === 'cm-hi');
    expect(hi?.state).toBe('no-answer');
    expect(hi?.error).toMatch(/does not change sign/);
    expect(hi?.solved).toEqual({});
    // The end that was already reachable is untouched by the claim beside it.
    expect(far.rangeEnds?.find((e) => e.name === 'cm-lo')?.solved).toEqual(
      res.rangeEnds?.find((e) => e.name === 'cm-lo')?.solved,
    );
  });

  it('input capacitance is one input gate at the width and length the sizing landed on', () => {
    expect(relErr(res.values.cgg_in, cggOf(res.values.in__W, L_IN))).toBeLessThan(1e-9);
  });
});

/**
 * The goldens of the current-mirror OTA, which is also called the symmetrical OTA. `diode` is
 * the name of its PMOS diode block and `pmosPole` of its PMOS mirror-node pole equation.
 *
 * Defaults: the bias reference programmed to I_tail = 20 µA at gm/ID 10, K_m 2, gm/ID in 12 /
 * mirror diodes 10, every L 0.5 µm, V_out_dc 0.9 V, VDD 1.8 V, CM_dc 1.05 V. Only the reference's
 * current is typed. The tail device is the reference's width on the reference's gate with the
 * tail node as its drain; each side of the pair, and the PMOS diode above it, carries half of
 * what the tail delivers; each output device is a multiple of its diode device's width on that
 * device's gate, so what it carries is read off the table at its own drain voltage. The reference
 * and both diodes are sized at gm/ID 10 and the one table stands for both polarities, so all
 * three sit at vgs(10) = 0.610063 V, and every ratio follows from the closed form in the header,
 * with nothing read back from the run:
 *   tail node                      (CM_dc − vgs(12))/1.2 = (1.05 − 0.567023)/1.2 = 0.402481 V
 *   tail device                    (2.5 + 0.402481)/(2.5 + 0.610063) = 0.933255   tailRatio
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
  const I_TAIL = 20e-6;
  const K_M = 2;
  const vTail = sourceNodeUnder(1.05, VGS_GMID12_L05);
  /** What each side of the pair carries: half of what the tail delivers, 9.333 µA. */
  const iHalf = (I_TAIL / 2) * tailRatioAt(vTail, VGS_GMID10_L05);
  const gmIn = 12 * iHalf; // (gm/ID)·id, both supplied in the givens
  const refDrop = va(L) + VGS_GMID10_L05;
  const rOut = (va(L) + 0.9) / refDrop;
  const rFold = (va(L) + (1.8 - VGS_GMID10_L05)) / refDrop;
  const v = res.values;

  // A common mode that leaves the tail device 30 mV short of its saturation voltage, for the pair
  // at gm/ID 12 standing on it: 1.2 × 0.205212 + 0.567023 = 0.813278 V.
  const cmTooLow = (1 + BODY_FACTOR) * (vdsatDemo(VGS_GMID10_L05, L) - 0.03) + VGS_GMID12_L05;
  itDrawsItsTail(doc, res, I_TAIL, vTail, VGS_GMID10_L05, cmTooLow);

  it('every other current is handed on, and each mirror is one gate wire', () => {
    // The PMOS diode is in the input device's branch and the NMOS diode under the second PMOS
    // output device: each is HANDED the current of the device it is in series with, to the last
    // bit, and none of them is sized against the programmed number.
    expect(block(res, diode).id).toBe(block(res, 'in').id);
    expect(2 * block(res, diode).id).toBe(v.tail__id);
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
    // Solved, not typed: the value the sheet stores is only what the panel shows, 0.19 V away
    // from the answer here, and the solve never reads it.
    const guess = doc.params.find((p) => p.name === 'V_nmir');
    expect(guess?.solveFor).toBe('nmir__vgs');
    expect(Math.abs(guess!.value - v.V_nmir)).toBeGreaterThan(0.1);
    const other = runSheet(withParams(doc, { V_nmir: 0.5 }), table);
    expect(relErr(other.values.V_nmir, v.V_nmir)).toBeLessThan(1e-6);
  });

  it('each mirror misses its reference by the drain-voltage ratio of the demo model', () => {
    // Each copy is compared with the current its own diode device carries, so the tail's error
    // does not enter, and as errors, the way the mirror goldens compare theirs. The output sits
    // 0.9 V from either rail, further than a diode drop, so both copies made at the output
    // over-deliver by 9.32 %; the copy made onto the NMOS diode's node sits 1.19 V below the
    // supply and over-delivers by 18.65 %. 1e-3 of those errors is 0.3 mV and 0.6 mV of drain
    // voltage.
    const iRef = K_M * v[`${diode}__id`];
    expect(relErr(v.moutp__id / iRef - 1, rOut - 1)).toBeLessThan(1e-3);
    expect(relErr(v.mfold__id / iRef - 1, rFold - 1)).toBeLessThan(1e-3);
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
    // Gm_out = gm_in·K_m·rOut·(1 + rFold)/2 = 111.99 µS × 2.390283 = 267.69 µS, against the
    // 240 µS of two exact copies under an ideal 20 µA tail.
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
    // The PMOS output device carries K_m·I_half·rOut = 20.41 µA and the NMOS one rFold times
    // that, so the rising direction is the slower: 2 × 20.41 µA into 2 pF, not the 40 µA of two
    // exact copies under an ideal tail.
    expect(v.moutp__id).toBeLessThan(v.moutn__id);
    expect(relErr(v.SR, (2 * K_M * iHalf * rOut) / CL)).toBeLessThan(1e-3);
    expect(relErr(v.SR, (2 * v.moutp__id) / CL)).toBeLessThan(1e-12);
  });

  it('the supply carries both input branches and the two PMOS output branches', () => {
    // What the tail delivers comes down the two input branches, 2·I_half, plus
    // K_m·I_half·(rOut + rFold) through the two PMOS output devices: 18.665 µA + 18.665 µA ×
    // 2.279676 = 61.22 µA, against the 60 µA of exact copies under an ideal tail. The NMOS mirror
    // is not a further branch: it carries to ground what the PMOS side delivers. The reference
    // branch is shared bias and is not counted.
    expect(relErr(v.I_q, 2 * iHalf + K_M * iHalf * (rOut + rFold))).toBeLessThan(1e-3);
    expect(relErr(v.I_q, v.tail__id + v.moutp__id + v.mfold__id)).toBeLessThan(1e-12);
  });

  it('DC gain is K_m-independent: gain = (gm/ID_in)·(VA + V_out)/2', () => {
    // gds = idSat/VA in the demo model and an output device copies its diode's saturation current
    // per width, so the drain voltage an output device sits at cancels out of its gds: it is its
    // diode's current, times the width ratio, over (VA + vgs(10)). The PMOS output device copies
    // K_m·I_half and the NMOS one rFold times that, so Rout = 76.21 kΩ.
    const rout =
      1 / (gdsOf(K_M * iHalf, L, VGS_GMID10_L05) + gdsOf(K_M * iHalf * rFold, L, VGS_GMID10_L05));
    expect(relErr(v.Rout, rout)).toBeLessThan(1e-3);
    // Against the transconductance above, the currents, K_m and (1 + rFold) all cancel:
    // Av = 12·rOut·(VA + vgs(10))/2 = 12·(VA + 0.9)/2 = 20.4, the gain of two exact copies at
    // the output's drain voltage. The output sits mid-supply, which is what makes the two rOut
    // one number. What the tail delivers cancels too.
    expect(relErr(v.Av, (12 * (va(L) + 0.9)) / 2)).toBeLessThan(1e-3);
    expect(relErr(v.Av, v.Gm_out * v.Rout)).toBeLessThan(1e-12);
    // K_m scales every output-side width and current together, so it cancels on the table too.
    const wider = runSheet(withParams(doc, { K_m: 4 }), table);
    expect(relErr(wider.values.Av, v.Av)).toBeLessThan(1e-9);
  });

  it('each mirror-node pole is the diode gm over the gates on its node', () => {
    // A diode device's gm is (gm/ID)·id, both given, and cgg = W·L·Cox at the width the sizing
    // landed on. The PMOS node carries the diode's gate and one K_m times as wide; the diode
    // carries the half of the tail's current it is handed.
    const fP = (10 * v[`${diode}__id`]) / (TWO_PI * (1 + K_M) * cggOf(v[`${diode}__W`], L));
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

  it('input noise counts all eight signal-path devices, each through its own path', () => {
    // Every device's drain noise current is 4kTγ·gm, and every gm here is (gm/ID)·id: 12 on the
    // pair, 10 on every mirror device — a device on another's gate keeps that device's gm/ID in
    // the demo model, whatever its drain voltage. Referred to the input, a noise current at the
    // output is divided by Gm_out = gm_in·G, with G = K_m·rOut·(1 + rFold)/2 = 2.390283.
    //   pair            each device's current splits between the two sides at the tail node and
    //                   takes both paths, as the signal does: 2 devices at the pair's own density
    //   PMOS diodes     one through the PMOS mirror, (K_m·rOut)², one through both mirrors,
    //                   (K_m·rFold·rOut)²:                          4.780567 + 6.729441
    //   output devices  straight into the output, at K_m·rOut and K_m·rFold·rOut times the
    //                   diode's current:                            2.186451 + 2.594117
    //   folded branch   the PMOS output device on the NMOS diode's node and that diode, both at
    //                   K_m·rFold times the diode's current, copied by the bottom mirror's rOut²:
    //                                                               2 × 2.835954
    // vn² = (4kTγ/gm_in)·(2 + (10/12)·21.962484/G²) = (4kTγ/gm_in) × 5.203327, so 27.75 nV/√Hz.
    const G = (K_M * rOut * (1 + rFold)) / 2;
    const viaDiodes = (K_M * rOut) ** 2 + (K_M * rFold * rOut) ** 2; // the two PMOS diodes
    const viaOutputSide =
      K_M * rOut + // PMOS output device at the output
      K_M * rFold * rOut ** 2 + // PMOS output device feeding the bottom mirror
      K_M * rFold * rOut ** 2 + // NMOS diode
      K_M * rFold * rOut; // NMOS output device
    const total = 2 + ((10 / 12) * (viaDiodes + viaOutputSide)) / G ** 2;
    expect(relErr(v.vn_in, vnthM(gmIn) * Math.sqrt(total))).toBeLessThan(1e-3);
    // Which devices the equation reads, exactly: every one of the six mirror devices, at its own
    // density and gm, so leaving any of them out moves the row.
    const i2 = (name: string): number => (v[`${name}__vnth_m`] * v[`${name}__gm`]) ** 2;
    const bottomGain = v.moutn__gm / v.nmir__gm;
    const output =
      i2(diode) * (v.Ai_p ** 2 + v.Ai_n ** 2) +
      i2('moutp') +
      (i2('mfold') + i2('nmir')) * bottomGain ** 2 +
      i2('moutn');
    expect(relErr(v.vn_in, Math.sqrt(2 * v.in__vnth_m ** 2 + output / v.Gm_out ** 2))).toBeLessThan(
      1e-12,
    );
    // The pair and the two PMOS diodes alone come to 2 + (10/12)·11.510008/G² = 3.678787 of the
    // same unit: a row that stopped there would read 16 % low.
    const pairAndDiodes = Math.sqrt(
      2 * v.in__vnth_m ** 2 + (i2(diode) * (v.Ai_p ** 2 + v.Ai_n ** 2)) / v.Gm_out ** 2,
    );
    const stoppedThere = 2 + ((10 / 12) * viaDiodes) / G ** 2;
    expect(relErr(pairAndDiodes / v.vn_in, Math.sqrt(stoppedThere / total))).toBeLessThan(1e-3);
    expect(pairAndDiodes / v.vn_in).toBeLessThan(0.85);
  });

  it('each output device is held against its own saturation voltage', () => {
    // An output device takes its gate voltage from its diode device, so nothing in its givens
    // keeps it saturated: each declares that it must stay saturated, and the declaration is a
    // physical check on that device, comparing the drain-source voltage it sits at with the
    // saturation voltage it reports. On the demo model that is the diode's, 2·UT plus the
    // overdrive of gm/ID 10: 0.235 V.
    const vdsat = vdsatDemo(VGS_GMID10_L05, L);
    const across = { moutp: 1.8 - 0.9, mfold: 1.8 - VGS_GMID10_L05, moutn: 0.9 };
    for (const [name, vds] of Object.entries(across)) {
      const c = regionOf(res, name);
      expect([name, c.kind, c.status]).toEqual([name, 'physical', 'pass']);
      expect([name, relErr(c.lhsValue!, vds) < 1e-5]).toEqual([name, true]);
      expect([name, c.rhsValue]).toEqual([name, v[`${name}__vdsat`]]);
      expect([name, relErr(c.rhsValue!, vdsat) < 1e-2]).toEqual([name, true]);
    }
    expect(doc.checks.map((c) => c.id).filter((id) => /-saturated$/.test(id))).toEqual([]);
    // Each one trips when its own device is squeezed, and takes feasibility with it. Under
    // a 1.4 V supply, an output 0.2 V above ground squeezes the NMOS output device and one 0.2 V
    // below the supply the PMOS output device beside it. The other PMOS output device sits on the
    // NMOS diode's drop, so it is squeezed by strong mirrors under that supply: at gm/ID 4 a
    // diode drops 0.93 V and an output device needs 0.55 V, which 1.4 V does not leave (the
    // output is at 0.7 V there, where both devices at the output still have their 0.55 V).
    const failing = (over: Record<string, number>): string[] => {
      const r = runSheet(withParams(doc, over), table);
      expect(r.feasible).toBe(false);
      return hardFailsIn(r).filter((id) => id.endsWith('.region'));
    };
    expect(failing({ VDD: 1.4, V_out_dc: 0.2 })).toEqual(['moutn.region']);
    expect(failing({ VDD: 1.4, V_out_dc: 1.2 })).toEqual(['moutp.region']);
    // The same strong PMOS diode squeezes the input device under it as well — 1.4 V less 0.93 V
    // less the tail node leaves it a few tens of millivolts — and it declares saturation too.
    expect(failing({ gm_id_ml: 4, VDD: 1.4, V_out_dc: 0.7 })).toEqual([
      'in.region',
      'mfold.region',
    ]);
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
    // the sized one. The bias reference keeps the current it is programmed to, so at half the
    // current density it needs a higher gate voltage, and the tail device is on that gate: it
    // follows the reference there instead of being handed 20 µA. The PMOS diode is handed half
    // of what the tail delivers, needs a higher gate voltage too, and both PMOS output devices
    // are on that gate: they follow it instead of being handed K_m times a typed current.
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

    for (const name of ['bias', 'tail', 'mload', 'in', 'moutp', 'mfold', 'nmir', 'moutn'])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    expect(block(h, 'bias').id).toBe(20e-6);
    expect(block(h, 'bias').vgs).toBeGreaterThan(block(s, 'bias').vgs);
    expect(relErr(block(h, 'tail').vgs, block(h, 'bias').vgs)).toBeLessThan(1e-12);
    expect(h.values.tail__id).toBe(2 * h.values.in__id);
    expect(block(h, 'mload').id).toBe(block(h, 'in').id);
    expect(block(h, 'mload').vgs).toBeGreaterThan(block(s, 'mload').vgs);
    expect(relErr(block(h, 'moutp').vgs, block(h, 'mload').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(h, 'mfold').vgs, block(h, 'mload').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(h, 'moutn').vgs, block(h, 'nmir').vgs)).toBeLessThan(1e-12);

    // The pair, at its own fixed width, needs a higher gate voltage as well, which lowers the
    // tail node the common mode leaves it. Both moves push the tail's mirror ratio down, so it
    // delivers less than where the design was sized — the same closed form, read at this
    // condition's two voltages (scaling the current column by a constant leaves its (VA + vds)
    // dependence alone).
    expect(h.values.V_tail).toBeLessThan(s.values.V_tail);
    expect(h.values.tail__id).toBeLessThan(s.values.tail__id);
    const tailRatio = tailRatioAt(h.values.V_tail, block(h, 'bias').vgs);
    expect(relErr(1 - h.values.tail__id / 20e-6, 1 - tailRatio)).toBeLessThan(1e-2);

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

    // Every copy is the same closed form, read at this condition's voltages.
    const iRef = 2 * block(h, 'mload').id; // K_m times the diode's current
    const refDrop = va(L) + block(h, 'mload').vgs;
    const foldRatio = (va(L) + 1.8 - h.values.V_nmir) / refDrop;
    const outRatioN = (va(L) + 0.9) / (va(L) + h.values.V_nmir);
    expect(relErr(h.values.moutp__id / iRef - 1, (va(L) + 0.9) / refDrop - 1)).toBeLessThan(1e-2);
    expect(relErr(h.values.mfold__id / iRef - 1, foldRatio - 1)).toBeLessThan(1e-2);
    expect(relErr(h.values.moutn__id / h.values.mfold__id - 1, outRatioN - 1)).toBeLessThan(1e-2);
  });
});

describe('tier-3 goldens: gain-boosted cascode OTA', () => {
  const doc = sheet('gain-boosted-cascode-ota.json');
  const res = runSheet(doc, table);
  // Defaults: the bias reference programmed to I_tail = 20 µA at gm/ID 14, the tail device on its
  // gate, gm/ID in 14 / casc 10 / mir 8 / boost 12, all L 0.5 µm; the stack is node-parameterized
  // — V_a 0.55, V_b 1.3, V_out 0.9, the tail node constrained so CM_in lands on CM_dc 0.95 — and
  // every device vds is a subtraction between nodes.
  //   tail node    (CM_dc − vgs(14))/1.2 = (0.95 − 0.532095)/1.2 = 0.348254 V
  //   tail device  (2.5 + 0.348254)/(2.5 + 0.532095) = 0.939368   (reference at vgs(14))
  const I_TAIL = 20e-6;
  const vTail = sourceNodeUnder(0.95, VGS_GMID14_L05);
  /** What each side of the stack carries: half of what the tail delivers, 9.394 µA. */
  const iHalf = (I_TAIL / 2) * tailRatioAt(vTail, VGS_GMID14_L05);
  const gmIn = 14 * iHalf; // (gm/ID)·id, both supplied in the givens
  // A common mode that leaves the tail device 30 mV short of its saturation voltage, for the pair
  // at gm/ID 14 standing on it: 1.2 × 0.127242 + 0.532095 = 0.684786 V.
  const cmTooLow = (1 + BODY_FACTOR) * (vdsatDemo(VGS_GMID14_L05, L) - 0.03) + VGS_GMID14_L05;

  itDrawsItsTail(doc, res, I_TAIL, vTail, VGS_GMID14_L05, cmTooLow);

  it('GBW and slew follow from what the tail delivers (boosting lifts gain, not bandwidth)', () => {
    // 20 µA × 0.939368 = 18.787 µA — not the 20 µA the reference is programmed to.
    expect(relErr(res.values.GBW, gmIn / (TWO_PI * CL))).toBeLessThan(1e-3);
    expect(relErr(res.values.SR, (2 * iHalf) / CL)).toBeLessThan(1e-3);
    // Which current each equation reads, exactly: the pair's half of the tail's, and the tail's.
    expect(relErr(res.values.GBW, (14 * res.values.in__id) / (TWO_PI * CL))).toBeLessThan(1e-9);
    expect(relErr(res.values.SR, res.values.tail__id / CL)).toBeLessThan(1e-12);
  });

  it('the boosters cost supply current the main branch never sees: one per cascode polarity', () => {
    // The main branch at what the tail delivers, 18.787 µA, + 2 × 5 µA of booster tail. The
    // factor of two is the topology claim — the equations model an amplifier on the NMOS cascode
    // and another on the PMOS cascode. The reference branch is shared bias and is not counted.
    expect(relErr(res.values.I_q, 2 * iHalf + 2 * 5e-6)).toBeLessThan(1e-3);
    expect(relErr(res.values.I_q, res.values.tail__id + 2 * 5e-6)).toBeLessThan(1e-12);
  });

  it('gain is the cascode gain multiplied again by the booster gain on each side', () => {
    // Every device in the stack carries the input device's current, so it cancels out of the
    // gain: what is left is node voltages and inversion levels.
    const boost = av0Of(12, L, 0.6);
    const Rn = (boost * av0Of(10, L, 0.9 - 0.55)) / gdsOf(iHalf, L, 0.55 - vTail);
    const Rp = (boost * av0Of(10, L, 1.3 - 0.9)) / gdsOf(iHalf, L, 1.8 - 1.3);
    const Rout = 1 / (1 / Rn + 1 / Rp);
    expect(relErr(res.values.Av, gmIn * Rout)).toBeLessThan(1e-2);
    for (const name of ['casc_n', 'casc_p', 'mir'])
      expect([name, block(res, name).id]).toEqual([name, block(res, 'in').id]);
  });

  itIsOneInputGate(res);
});

describe('tier-3 goldens: inverter-based OTA', () => {
  const doc = sheet('inverter-based-ota.json');
  const res = runSheet(doc, table);
  // Defaults: I_bias 20 µA typed into the NMOS at gm/ID 10, both L 0.5 µm, V_out 0.9, VDD 1.8. The
  // two gates are one node and the two sources are the rails, so the PMOS is not given an
  // inversion level: it carries the NMOS's current at the gate-source voltage the supply leaves.
  //   input level   V_in = vgs(10) = 0.610063 V
  //   PMOS          vgs = 1.8 − 0.610063 = 1.189937 V, overdrive 1.189937 − 0.426583 = 0.763354 V
  // That overdrive is 11.4 times 2·n·UT, deep in strong inversion, where the model's gm/ID is the
  // square law's 2/overdrive to about a part in 10⁵: 2.620015 /V against the NMOS's 10.
  const I_BIAS = 20e-6;
  const vIn = VGS_GMID10_L05;
  const vovP = 1.8 - vIn - vthDemo(L);
  const gmIdP = 2 / vovP;
  const gmTot = I_BIAS * (10 + gmIdP); // 200 µS + 52.40 µS
  /** Pelgrom, written out: sigma(vos) of a pair is sqrt(2)·hypot(A_VT, A_beta/(gm/ID))/sqrt(W·L). */
  const sigma = (W: number, gmId: number): number =>
    (Math.SQRT2 * Math.hypot(res.values.avt, res.values.abeta / gmId)) / Math.sqrt(W * L);
  const hardFails = (r: SheetResult): string[] =>
    r.checks.filter((c) => isHardCheck(c.kind) && c.status === 'fail').map((c) => c.id);

  it('the two gate-source voltages add up to the supply', () => {
    // The fact the sheet is drawn from. The NMOS is sized for its gm/ID and its gate-source
    // voltage is the input level; the PMOS is read at what is left of the supply above it. A
    // given gate voltage is reported as the coordinate the table was read at, so the sum is the
    // supply to rounding, and that coordinate has to lie on the table for it to be the one asked
    // for: here it does, 10 mV inside the 1.2 V the table sweeps to.
    expect(relErr(block(res, 'n').vgs + block(res, 'p').vgs, 1.8)).toBeLessThan(1e-12);
    expect(block(res, 'p').clamped).toBeUndefined();
    expect(res.values.V_in).toBe(block(res, 'n').vgs);
    expect(relErr(res.values.V_in, vIn)).toBeLessThan(1e-5);
    // One current: typed into the NMOS, read from the NMOS by the PMOS.
    expect(block(res, 'n').id).toBe(I_BIAS);
    expect(block(res, 'p').id).toBe(block(res, 'n').id);
    // The inversion level the PMOS lands at is an output, and nothing on the sheet sets it.
    expect(doc.params.map((p) => p.name)).not.toContain('gm_id_p');
    expect(relErr(res.values.p__gm_id, gmIdP)).toBeLessThan(1e-3);
  });

  it('the gate-wiring check holds the PMOS to the shared gate', () => {
    // The PMOS's gate is declared on the input level with its source on the supply. Where the
    // design is sized that restates how it was sized, so nothing is reported; a PMOS read 0.1 V
    // off the shared gate is reported, with that 0.1 V.
    const wiring = (r: SheetResult): string[] =>
      r.warnings.filter((w) => w.rule === 'sheet-wiring').map((w) => w.message);
    expect(wiring(res)).toEqual([]);
    const off: SheetDoc = {
      ...doc,
      blocks: doc.blocks!.map((u) =>
        u.name === 'p'
          ? { ...u, params: { ...u.params, vgs_d: 'sign_p*(VDD - n__vgs) - 0.1' } }
          : u,
      ),
    };
    const [said] = wiring(runSheet(off, table));
    expect(said).toMatch(/block "p" wiring/);
    const delta = Number(/delta (-?[\d.]+e[+-]\d+) V/.exec(said)![1]);
    expect(relErr(Math.abs(delta), 0.1)).toBeLessThan(1e-3);
  });

  it('the composite transconductance is the sum of the two gm, and slew/GBW follow', () => {
    expect(relErr(res.values.n__gm, 10 * I_BIAS)).toBeLessThan(1e-9);
    expect(relErr(res.values.gm_tot, gmTot)).toBeLessThan(1e-3);
    expect(relErr(res.values.gm_tot, res.values.n__gm + res.values.p__gm)).toBeLessThan(1e-12);
    expect(relErr(res.values.gm_id_eff, 10 + gmIdP)).toBeLessThan(1e-3);
    expect(relErr(res.values.SR, I_BIAS / CL)).toBeLessThan(1e-9);
    expect(relErr(res.values.GBW, gmTot / (TWO_PI * CL))).toBeLessThan(1e-3);
  });

  it('gain and the current-reuse noise density match the demo model', () => {
    // Both devices at L 0.5 µm and |vds| 0.9 carry one current, so gds_n = gds_p and
    // Av = (gid_n + gid_p)·(VA + vds)/2 = 12.620015 × 3.4/2 = 21.454.
    expect(relErr(res.values.Av, ((10 + gmIdP) * (va(L) + 0.9)) / 2)).toBeLessThan(1e-3);
    // Both devices are counted: each puts 4kTγ·gm of noise current into the output, and the sum
    // over gm_tot² is the density of one device with the composite transconductance.
    expect(relErr(res.values.vn_in, vnthM(gmTot))).toBeLessThan(1e-3);
    const i2 = (name: string): number =>
      (res.values[`${name}__vnth_m`] * res.values[`${name}__gm`]) ** 2;
    expect(relErr(res.values.vn_in, Math.sqrt(i2('n') + i2('p')) / res.values.gm_tot)).toBeLessThan(
      1e-12,
    );
  });

  it('one output node, and both stacked gates on the input terminal', () => {
    // Equal L and |vds| put the two devices at the same gds, so Rout = (VA + vds)/(2*I_bias)
    // exactly, whatever their inversion levels. Current reuse means the input drives BOTH gates,
    // so cgg_in sums them. The two are far from one size: the PMOS, in strong inversion, carries
    // the same current in a fraction of the NMOS's width.
    expect(relErr(res.values.Rout, stage2Rout(I_BIAS, L, 0.9))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av, res.values.gm_tot * res.values.Rout)).toBeLessThan(1e-12);
    const cgg = cggOf(res.values.n__W, L) + cggOf(res.values.p__W, L);
    expect(relErr(res.values.cgg_in, cgg)).toBeLessThan(1e-9);
    expect(res.values.p__W).toBeLessThan(res.values.n__W / 10);
  });

  it('the offset weights each device by its share of the transconductance', () => {
    // An offset at one device's gate moves the output current by that device's gm, and the input
    // sees gm_tot, so each device's own Pelgrom spread — at its own width and its own gm/ID, the
    // NMOS's chosen 10 and the PMOS's landed 2.62 — enters times gm/gm_tot: 10/12.62 and
    // 2.62/12.62. The same weights the noise row gives the two noise currents. The widths are the
    // sizer's answers, read from the result.
    const share = (gmId: number): number => gmId / (10 + gmIdP);
    const ofN = sigma(res.values.n__W, 10);
    const ofP = sigma(res.values.p__W, gmIdP);
    const vos = Math.hypot(ofN * share(10), ofP * share(gmIdP));
    expect(relErr(res.values.vos, vos)).toBeLessThan(1e-4);
    // The narrow PMOS has five times the NMOS's spread and a fifth of the transconductance:
    // added unweighted, the row would read almost four times what it does.
    expect(ofP).toBeGreaterThan(4 * ofN);
    expect(Math.hypot(ofN, ofP) / res.values.vos).toBeGreaterThan(3.5);
  });

  it('both devices are held against their own saturation voltages', () => {
    // Both declare that they must stay saturated. The PMOS's overdrive is whatever the supply
    // leaves, so its saturation voltage is large: 2·UT + 0.763354 = 0.815084 V of the 0.9 V
    // between the supply and the output. The NMOS's is the 0.235 V of gm/ID 10.
    expect(declaredSaturated(doc)).toEqual(['n', 'p']);
    const saturated = regionOf(res, 'p');
    expect([saturated.kind, saturated.status]).toEqual(['physical', 'pass']);
    expect(relErr(saturated.lhsValue!, 1.8 - 0.9)).toBeLessThan(1e-12);
    expect(saturated.rhsValue).toBe(res.values.p__vdsat);
    expect(relErr(saturated.rhsValue!, vdsatDemo(1.8 - vIn, L))).toBeLessThan(1e-3);
    expect(relErr(regionOf(res, 'n').rhsValue!, vdsatDemo(vIn, L))).toBeLessThan(1e-3);
    // An output 0.2 V higher leaves the PMOS 0.7 V, under that, and the sheet says so.
    const high = runSheet(withParams(doc, { V_out_dc: 1.1 }), table);
    expect(regionOf(high, 'p').status).toBe('fail');
    expect(hardFailsIn(high)).toContain('p.region');
    expect(doc.checks.map((c) => c.id)).not.toContain('p-saturated');
  });

  it('does not close on this table at its defaults: the gain and the offset are short', () => {
    // This table's thresholds are low — 0.43 V for either polarity at 0.5 µm, so the two together
    // take under half of a 1.8 V supply — and the gate the two devices share leaves the PMOS
    // 0.76 V of overdrive, far into strong inversion. It has a quarter of the NMOS's gm/ID and
    // carries the current in a sixteenth of its width. So the composite gm/ID is 12.62, where two
    // devices in moderate inversion would give 20 or more, and the gain is 21.45 against a target
    // of 30; and the narrow PMOS has the mismatch of a small device, which puts the offset at
    // 13.7 mV against a budget of 8 mV even at its one-fifth weight. The defaults are a design for
    // a process whose thresholds nearly fill the supply, and are not moved to close here.
    expect(res.feasible).toBe(false);
    expect(hardFails(res)).toEqual(['gain-spec', 'offset-spec']);
    const gain = check(res, 'gain-spec');
    const av = ((10 + gmIdP) * (va(L) + 0.9)) / 2;
    expect(relErr(gain.lhsValue, av)).toBeLessThan(1e-3);
    expect(relErr(gain.marginPct, av / 30 - 1)).toBeLessThan(1e-3); // −28.49 %
    const offset = check(res, 'offset-spec');
    const vos = Math.hypot(
      (sigma(res.values.n__W, 10) * 10) / (10 + gmIdP),
      (sigma(res.values.p__W, gmIdP) * gmIdP) / (10 + gmIdP),
    );
    expect(relErr(offset.marginPct, 1 - vos / 8e-3)).toBeLessThan(1e-3); // −71.7 %
    expect(offset.marginPct).toBeLessThan(-0.5);
    // Every other check holds, the PMOS's saturation among them.
    expect(res.checks.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual([
      'gain-spec',
      'offset-spec',
    ]);
  });

  it('held at another condition, the inverter keeps its supply and the current is solved again', () => {
    // A second characterization with twice the current and twice the transconductance at every
    // gate voltage, and the design sized on the first asked about on the second. Each device
    // keeps its width, the PMOS keeps the gate voltage the supply leaves above the input, and the
    // bias current is solved again so the two devices carry one current. Scaling the current by a
    // constant moves no gate voltage, so the input level stays where it was and the current
    // doubles.
    const at = (t: DeviceTable, corner: string, temp: number): DeviceTable => ({
      ...t,
      id: { ...t.id, corner, temp },
    });
    const strong = scaleQuantities(table, { id: 2, gm: 2 });
    const [device] = groupDevices([at(table, 'tt', 27), at(strong, 'ff', 125)]);
    const tt = { corner: 'tt', temp: 27 };
    const [sized, held] = runConditions(
      doc,
      device,
      [tt, { corner: 'ff', temp: 125 }],
      () => undefined,
      REFS,
      tt,
    );
    expect([sized.design, held.design]).toEqual(['sized', 'held']);
    expect([sized.state, held.state]).toEqual(['evaluated', 'evaluated']);
    if (sized.state !== 'evaluated' || held.state !== 'evaluated') return;
    const [s, h] = [sized.result, held.result];
    for (const name of ['n', 'p'])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    expect(block(h, 'n').vgs + block(h, 'p').vgs).toBeCloseTo(1.8, 12);
    expect(relErr(h.values.V_in, s.values.V_in)).toBeLessThan(1e-6);
    expect(relErr(h.values.I_bias, 2 * I_BIAS)).toBeLessThan(1e-5);
    expect(relErr(block(h, 'n').id, block(h, 'p').id)).toBeLessThan(1e-5);
    expect(h.warnings.filter((w) => w.rule === 'sheet-wiring')).toEqual([]);
    // That characterization doubles the current and the transconductance but not the output
    // conductance, so the gain target is met there; only the offset, which depends on the widths
    // and the inversion levels and on no current, still fails.
    expect(hardFails(h)).toEqual(['offset-spec']);
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
    // produce settles the tail 1.15% higher than it would with the endpoint free to re-size the
    // devices around it, which lands at (0.95 − vgs(12))/1.2 (0.31915 → 0.32283). Two things
    // let the held pair's gate back off: more drain-source voltage, and less current, because
    // the tail device is on its reference's gate and delivers less with its drain 80 mV lower.
    // Locked as intent, not as a regression.
    const lo = res.rangeEnds?.find((e) => e.name === 'cm-lo');
    expect(lo?.state).toBe('complies');
    // RECORDED from the engine on this table to six decimals. Beside it stands the held-width
    // landing in closed form: the pair's drain is the load's diode node, VDD − vgs(10), the pair
    // sits at gm/ID 12, and its current is what the tail delivers at the node, which gives
    // 0.32291 V.
    expect(lo?.solved.V_tail).toBeCloseTo(0.3228332, 6);
    const held = heldTailNode(0.95, 1.05, VGS_GMID12_L05, 12, 1.8 - VGS_GMID10_L05, true);
    expect(relErr(lo!.solved.V_tail, held)).toBeLessThan(1e-3);
    expect(relErr(sourceNodeUnder(0.95, VGS_GMID12_L05), held)).toBeGreaterThan(5e-3);
    // The tail's current at that end is the closed form read at the landed node: the reference
    // has not moved, so it is the design point's ratio with the new drain voltage.
    const tailAt = lo!.blocks!.find((c) => c.name === 'tail')!.sizing!;
    expect(
      relErr(1 - tailAt.id / 20e-6, 1 - tailRatioAt(lo!.solved.V_tail, VGS_GMID10_L05)),
    ).toBeLessThan(1e-2);
  });
});
