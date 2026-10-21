// Tier-3 golden tests: the OTA sheets in sheets/otas/. Each number is hand-derived
// from the synthetic EKV demo model's closed forms — never by re-running the engine.
//
// The identities this tier leans on (see src/demo/index.ts):
//  - A given quantity is EXACT: gm = (gm/ID)·id when both are supplied, so slew,
//    GBW, and gm-ratio goldens hold to 1e-9.
//  - After sizing at a declared vds, gds/id = 1/(VA + vds) EXACTLY (VA = 5e6·L),
//    so gds = id/(VA + vds) and the intrinsic gain av0 = (gm/ID)·(VA + vds). Analytic
//    single-stage gains therefore land within interpolation error (< 1e-2).
//  - Thermal density vnth_m = sqrt(4kTγ·(gm + gmb))/gm with γ = GAMMA_DEFAULT and the demo's
//    gmb = BODY_FACTOR·gm, i.e. sqrt(4kTγ·(1 + BODY_FACTOR)/gm) (vnthM).
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
  vgsAtGmId,
  vgsForCurrentRatio,
  gmIdDemo,
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
 *  the tail node as its drain, and the pair takes what the tail delivers there — half each, or,
 *  on a sheet drawn at rest with the pair's other transistor as the block `partner`, a share each
 *  that adds up to it. `vTail` and `vgsRef` are the closed forms of the tail node and of the
 *  reference's gate voltage, and `cmTooLow` a common mode that leaves the tail device short of its
 *  saturation voltage. */
const itDrawsItsTail = (
  doc: SheetDoc,
  res: SheetResult,
  iTail: number,
  vTail: number,
  vgsRef: number,
  cmTooLow?: number,
  partner?: string,
): void => {
  it('one current is typed, into the bias reference, and the tail is on its gate', () => {
    // Kirchhoff at the tail node: the pair is HANDED the tail's current — halved, or in two
    // shares that add up to it — and only the reference is sized against the programmed number.
    expect(block(res, 'bias').id).toBe(iTail);
    if (partner)
      expect(
        relErr(res.values.in__id + res.values[`${partner}__id`], res.values.tail__id),
      ).toBeLessThan(1e-12);
    else expect(res.values.tail__id).toBe(2 * res.values.in__id);
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
    'current-mirror-ota.json': ['tail', 'in', 'in_f', 'moutp', 'mfold', 'moutn'],
    'degenerated-differential-pair.json': ['tail', 'in'],
    'differential-pair-tail.json': ['tail', 'in'],
    'five-transistor-ota.json': ['tail', 'in', 'inr', 'ld'],
    'folded-cascode-ota.json': [
      'tail',
      'in',
      'pcs',
      'pcasc',
      'pcs_r',
      'inr',
      'nmir_r',
      'nmir',
      'ncasc',
      'ncasc_r',
      'pcasc_r',
    ],
    'gain-boosted-cascode-ota.json': [
      'tail',
      'in',
      'casc_n',
      'casc_p',
      'mir',
      'casc_nr',
      'casc_pr',
      'boost',
    ],
    'inverter-based-ota.json': ['n', 'p'],
    'telescopic-cascode-ota.json': [
      'tail',
      'in',
      'casc_n',
      'casc_p',
      'mirr',
      'mir',
      'inr',
      'casc_nr',
      'casc_pr',
    ],
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
    // Per side, the device's own gate-referred density, 4kTγ·(gm + gmb)/gm², and the resistor's
    // 4kT·R_s. The resistor's noise is a voltage in series with the source, and a source voltage
    // moves the drain current through gm + gmb where a gate voltage moves it through gm, so it
    // refers to the gate through (gm + gmb)/gm — 1.2 in the demo model, 1.44 in power. The
    // device's own channel noise carries the same 1.2 (its noise conductance is gm + gmb):
    //   device    4kTγ·1.2/gm  = 1.9891e-20/145.79 µS    = 1.3643e-16 V²/Hz
    //   resistor  4kT·R_s·1.44 = 1.9891e-16 × 1.44       = 2.8643e-16 V²/Hz
    // Both sides of the pair: sqrt(2 × 4.2286e-16) = 29.08 nV/√Hz.
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
    // Referred as if it sat at the gate, the resistor would leave the row at 25.9 nV/√Hz, 11 % low.
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
  // gate, gm/ID in 14 / casc 10 / mir 13, all L 0.5 µm; the output side's nodes V_a 0.55 and
  // V_b 1.52, V_out 0.9, the tail node constrained so CM_in lands on CM_dc 0.97. The sheet is
  // drawn at rest with its mirror load the low-voltage kind: the two mirror devices share a gate
  // on the diode side's output node X, one mirror vgs below the supply, the two NMOS cascodes
  // share one gate and the two PMOS cascodes another, and the split of the tail current is solved
  // so the output node balances. On the demo model the resting state is a short fixed point of
  // closed forms (VA = 2.5 V; a device on another's gate carries that device's current times
  // (VA + vds)/(VA + vds_ref); vgsForCurrentRatio gives the gate-source voltage of a current
  // ratio at one width; the threshold rises BODY_FACTOR per volt of body bias):
  //   X              1.8 − vgs(13)
  //   mirror         the output side at V_b, the diode side at its own node V_br: the output side
  //                  returns rM = (VA + 1.8 − V_b)/(VA + 1.8 − V_br) of the diode side's current,
  //                  so the output-side share is s = rM/(1 + rM)
  //   V_br           the diode-side PMOS cascode, the output side's width at the diode-side
  //                  current with its drain on X, sits above the shared gate by its own vgs:
  //                  V_br = V_b + (vgs_pr − vgs(10))/1.2
  //   V_ar           likewise under the shared NMOS gate: V_ar = V_a + (vgs(10) − vgs_nr)/1.2
  //   pair           the output side at vgs(14) plus the body effect, its partner the same width
  //                  at the other share and its own drain V_ar; the tail node puts the mean of
  //                  the two on CM_dc
  const I_TAIL = 20e-6;
  const VA = va(L);
  const vgs10 = vgsAtGmId(10);
  const vgs14 = vgsAtGmId(14);
  const V_A = 0.55;
  const V_B = 1.52;
  const X = 1.8 - vgsAtGmId(13);
  const rest = (() => {
    let [share, vBr, vAr, vTail, vgsInr] = [0.5, V_B, V_A, sourceNodeUnder(0.97, vgs14), vgs14];
    for (let i = 0; i < 60; i++) {
      const rM = (VA + 1.8 - V_B) / (VA + 1.8 - vBr);
      share = rM / (1 + rM);
      const other = (1 - share) / share;
      const pr = (other * (1 + (V_B - 0.9) / VA)) / (1 + (vBr - X) / VA);
      vBr = V_B + (vgsForCurrentRatio(vgs10, pr) - vgs10) / 1.2;
      const nr = (other * (1 + (0.9 - V_A) / VA)) / (1 + (X - vAr) / VA);
      vAr = V_A + (vgs10 - vgsForCurrentRatio(vgs10, nr)) / 1.2;
      const ir = (other * (1 + (V_A - vTail) / VA)) / (1 + (vAr - vTail) / VA);
      vgsInr = vgsForCurrentRatio(vgs14, ir);
      vTail = sourceNodeUnder(0.97 - (vgsInr - vgs14) / 2, vgs14);
    }
    const iTail = I_TAIL * tailRatioAt(vTail, vgs10);
    const iOut = share * iTail;
    const iDiode = iTail - iOut;
    const gmOut = 14 * iOut;
    const gmDiode = gmIdDemo(vgsInr) * iDiode;
    // The load mirror's current gain, its output device's gm over its diode device's: one gate,
    // one width, so the ratio its currents are in, rM = share/(1 − share).
    const rM = share / (1 - share);
    return {
      share,
      vBr,
      vAr,
      vTail,
      delta: vgsInr - vgs14,
      iTail,
      iOut,
      iDiode,
      rM,
      gmDiode,
      // The diode side's half through the mirror, the output side's half direct.
      gmPair: (gmDiode * rM + gmOut) / 2,
    };
  })();
  const { vTail, iOut, iDiode, gmPair } = rest;

  // The low-common-mode golden of the shared tail goldens is left out: on this table the design
  // also misses its offset and swing targets, so a range end there fails more than the tail.
  itDrawsItsTail(doc, res, I_TAIL, vTail, VGS_GMID10_L05, undefined, 'inr');

  it('the split is solved so the currents at the output node balance', () => {
    // What the output side carries down is what the mirror's output side returns, to the solve's
    // tolerance. The mirror's two sides sit at V_b and V_br, 10 mV apart here, so the share is
    // one half moved by the ratio rM — compared as its distance from one half, 0.00086.
    expect(relErr(res.values.in__id, res.values.mir__id)).toBeLessThan(1e-6);
    expect(doc.params.find((p) => p.name === 'out_share')?.designConstraint).toEqual({
      lhs: 'in__id',
      rhs: 'mir__id',
    });
    expect(relErr(res.values.out_share - 0.5, rest.share - 0.5)).toBeLessThan(1e-2);
    expect(relErr(res.values.in__id, iOut)).toBeLessThan(1e-3);
    expect(relErr(res.values.inr__id, iDiode)).toBeLessThan(1e-3);
    // Each cascode carries the current of the pair transistor under it, and the diode side's
    // mirror device the diode side's, handed on to the last bit.
    for (const name of ['casc_n', 'casc_p'])
      expect([name, block(res, name).id]).toEqual([name, block(res, 'in').id]);
    for (const name of ['casc_nr', 'casc_pr', 'mirr'])
      expect([name, block(res, name).id]).toEqual([name, block(res, 'inr').id]);
  });

  it('the diode side hangs under the gates the output side sets, and its drain is the mirror gate', () => {
    // The two NMOS cascodes share one gate and the two PMOS cascodes another; the diode side's
    // nodes are solved under them. The mirror's gate is the diode side's output node: both
    // diode-side cascodes have their drains there, one mirror vgs below the supply.
    expect(relErr(res.values.V_ar, rest.vAr)).toBeLessThan(1e-3);
    expect(relErr(res.values.V_br, rest.vBr)).toBeLessThan(1e-4);
    expect(res.values.V_ar + res.values.casc_nr__vgs).toBeCloseTo(V_A + res.values.casc_n__vgs, 6);
    expect(res.values.V_br - res.values.casc_pr__vgs).toBeCloseTo(V_B - res.values.casc_p__vgs, 6);
    const node = 1.8 - block(res, 'mirr').vgs;
    expect(relErr(node, X)).toBeLessThan(1e-4);
    expect(block(res, 'casc_nr').bias?.vds).toBeCloseTo(node - res.values.V_ar, 12);
    expect(block(res, 'casc_pr').bias?.vds).toBeCloseTo(res.values.V_br - node, 12);
    // The mirror's output side is the diode side's width on the diode side's gate.
    expect(block(res, 'mir').W).toBe(block(res, 'mirr').W);
    expect(relErr(block(res, 'mir').vgs, block(res, 'mirr').vgs)).toBeLessThan(1e-12);
  });

  it('systematic offset is the difference of the two gate-source voltages at rest', () => {
    // The cascodes shield the pair's drains, so the two pair transistors differ by the share and
    // by the few millivolts between V_a and V_ar: 0.50 mV here. Read directly, nothing estimated.
    expect(res.values.vos_sys).toBe(Math.abs(res.values.inr__vgs - res.values.in__vgs));
    expect(relErr(res.values.vos_sys, Math.abs(rest.delta))).toBeLessThan(5e-3);
  });

  it('slew and GBW follow from the current the tail delivers and the pair transconductance', () => {
    // 20 µA × 0.921 = 18.43 µA — not the 20 µA the reference is programmed to.
    expect(relErr(res.values.SR, rest.iTail / CL)).toBeLessThan(1e-3);
    // The diode-side transistor's gm is read off the table between drain-voltage and body-bias
    // nodes, 0.15 % under the model's, and the mirror's gain rides the interpolated gm curve; the
    // diode side's half carries both, so the closed form holds to 1.5e-3 rather than 1e-3.
    expect(relErr(res.values.inr__gm, rest.gmDiode)).toBeLessThan(2e-3);
    expect(relErr(res.values.GBW, gmPair / (TWO_PI * CL))).toBeLessThan(1.5e-3);
    // Which current each equation reads, exactly: the tail's own, and the pair's two halves,
    // the diode side's through the load mirror's gain.
    expect(relErr(res.values.SR, res.values.tail__id / CL)).toBeLessThan(1e-12);
    const { in__gm, inr__gm, mir__gm, mirr__gm } = res.values;
    expect(relErr(res.values.gm_pair, (inr__gm * (mir__gm / mirr__gm) + in__gm) / 2)).toBeLessThan(
      1e-12,
    );
    expect(relErr(mir__gm / mirr__gm, rest.rM)).toBeLessThan(1e-3);
    expect(relErr(res.values.GBW, res.values.gm_pair / (TWO_PI * CL))).toBeLessThan(1e-12);
    expect(res.values.I_q).toBe(res.values.tail__id);
  });

  it('the design constraint lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(0.97, 5);
    expect(res.values.CM_in).toBe(
      res.values.V_tail + (res.values.in__vgs + res.values.inr__vgs) / 2,
    );
  });

  it('gain is the pair transconductance times the parallel cascoded output resistance', () => {
    // Node subtractions, with the solved tail node read from the result: the output-side pair
    // transistor sits at vds = V_a − V_tail, its cascode at V_out − V_a; the PMOS side at the V_b
    // splits. Both output-side branches carry the output-side current.
    const Rn = av0Of(10, L, 0.9 - V_A) / gdsOf(iOut, L, V_A - res.values.V_tail);
    const Rp = av0Of(10, L, V_B - 0.9) / gdsOf(iOut, L, 1.8 - V_B);
    const Rout = 1 / (1 / Rn + 1 / Rp);
    expect(relErr(res.values.Av, gmPair * Rout)).toBeLessThan(1e-2);
  });

  it('every device in the stack declares that it must stay saturated', () => {
    // The stack's saturation is what its node placement buys, so every device in it says so, and
    // each declaration is a physical check on its own device at its own drain-source voltage.
    expect(declaredSaturated(doc)).toEqual([
      'tail',
      'in',
      'casc_n',
      'casc_p',
      'mirr',
      'mir',
      'inr',
      'casc_nr',
      'casc_pr',
    ]);
    const across = {
      in: V_A - res.values.V_tail,
      casc_n: 0.9 - V_A,
      casc_p: V_B - 0.9,
      mir: 1.8 - V_B,
      mirr: 1.8 - res.values.V_br,
      inr: res.values.V_ar - res.values.V_tail,
    };
    for (const [name, vds] of Object.entries(across)) {
      const c = regionOf(res, name);
      expect([name, c.kind, c.status]).toEqual([name, 'physical', 'pass']);
      expect([name, relErr(c.lhsValue!, vds) < 1e-9]).toEqual([name, true]);
    }
    // The diode side's PMOS cascode is what the mirror gate leaves the least: V_br less X, 0.28 V
    // against a saturation voltage of 0.25 V. At the 1.35 V the output side once sat at it would
    // have 0.12 V, in triode, which is why V_b sits at 1.52 V.
    expect(regionOf(res, 'casc_pr').status).toBe('pass');
    expect(hardFailsIn(runSheet(withParams(doc, { V_b: 1.35 }), table))).toContain(
      'casc_pr.region',
    );
    // Squeeze the pair's drain node down onto its source and its declarations are what trip:
    // V_a 0.40 leaves it 35 mV against a saturation voltage of 0.16 V.
    const squeezed = runSheet(withParams(doc, { V_a: 0.4 }), table);
    expect(hardFailsIn(squeezed)).toEqual(expect.arrayContaining(['in.region', 'inr.region']));
  });

  it('every device whose source sits above its body pays for it at its gate', () => {
    // The output side's pair transistor stands on the tail node, which is solved so the mean of
    // the two pair gates lands on CM_dc; it is sized at gm/ID 14, so its gate-source voltage is
    // vgs(14) plus BODY_FACTOR × that node. The node sits between two body-bias slices of the
    // table (0.35 and 0.40 V), where the table is interpolated, so these agree to interpolation
    // order.
    expect(relErr(res.values.V_tail, vTail)).toBeLessThan(1e-3);
    expect(relErr(res.values.in__vgs, vgsAtBody(VGS_GMID14_L05, res.values.V_tail))).toBeLessThan(
      1e-3,
    );
    // The N cascode's source is V_a = 0.55 V above ground, on a body-bias slice, and the P
    // cascode's is V_b = 1.52 V, 0.28 V below its body at the supply — between the 0.25 and 0.30 V
    // slices, so read to interpolation order (0.1 mV here). The gate each node is held under:
    //   N gate  V_a + vgs(10) + 0.2 × 0.55 = 0.55 + 0.610063 + 0.11 = 1.270063 V
    //   P gate  V_b − vgs(10) − 0.2 × 0.28 = 1.52 − 0.610063 − 0.056 = 0.853937 V
    expect(relErr(res.held!.V_a, V_A + vgsAtBody(VGS_GMID10_L05, V_A))).toBeLessThan(1e-5);
    expect(relErr(res.held!.V_b, V_B - vgsAtBody(VGS_GMID10_L05, 1.8 - V_B))).toBeLessThan(2e-4);
  });

  it('at a range end the tail node, the split and the nodes under the cascode gates settle together', () => {
    // Where the design is held, the tail node is solved for the common mode, the output side's
    // nodes for their held gates, the diode side's under the same gates, and the split for the
    // output node's balance; each reads the others, and the engine settles them by repeated
    // searches. At cm-lo every relation holds to the solve's tolerance on the design the base run
    // sized.
    const lo = res.rangeEnds!.find((e) => e.name === 'cm-lo')!;
    expect(lo.error).toBeUndefined();
    const at = (name: string) => lo.blocks!.find((c) => c.name === name)!.sizing!;
    expect(lo.solved.V_tail + (at('in').vgs + at('inr').vgs) / 2).toBeCloseTo(0.95, 5);
    expect(lo.solved.V_a + at('casc_n').vgs).toBeCloseTo(res.held!.V_a, 5);
    expect(lo.solved.V_ar + at('casc_nr').vgs).toBeCloseTo(res.held!.V_a, 5);
    expect(relErr(at('in').id, at('mir').id)).toBeLessThan(1e-6);
    expect(relErr(at('in').id + at('inr').id, at('tail').id)).toBeLessThan(1e-12);
    expect(
      relErr(1 - at('tail').id / I_TAIL, 1 - tailRatioAt(lo.solved.V_tail, VGS_GMID10_L05)),
    ).toBeLessThan(1e-2);
  });

  itIsOneInputGate(res);
});

describe('tier-3 goldens: folded cascode OTA', () => {
  const doc = sheet('folded-cascode-ota.json');
  const res = runSheet(doc, table);
  // Defaults: the bias reference programmed to I_tail = 20 µA at gm/ID 8 and 0.5 µm, the tail
  // device on its gate, I_branch 30 µA into the output side's folding source, gm/ID in 14 / casc
  // 10 / cs 8; the cascodes at 0.5 µm, the input pair, the folding sources and the output mirror
  // at 1 µm; the output side's nodes V_fold 1.4 and V_c 0.31, V_out 0.9, the tail node
  // constrained so CM_in lands on CM_dc 1.05. Drawn at rest: the bottom mirror is the low-voltage
  // kind, its two devices sharing a gate on the diode side's output node X, one mirror vgs above
  // ground; the two folding sources share a gate and a width; each pair of cascodes shares a gate;
  // the split of the tail current is solved so the output node balances. On the demo model the
  // resting state is a short fixed point of closed forms (VA = 2.5 V at 0.5 µm, 5 V at 1 µm):
  //   X              vgs(8) at 1 µm, the mirror diode side's gate
  //   folding sources the diode side's copy of I_branch at its own node: I_pr = 30 µA ×
  //                  (5 + 1.8 − V_fold_r)/(5 + 0.4)
  //   bottom mirror  the diode side carries I_pr less the diode-side pair transistor's current;
  //                  the output side copies it at V_c, (5 + V_c)/(5 + V_c_r) times
  //   split          the output side's fold current, I_branch less its pair transistor's, is
  //                  what the bottom mirror's output side pulls
  //   V_fold_r, V_c_r the diode-side cascodes, the output side's widths at the diode side's fold
  //                  current with their drains on X, under the shared gates
  //   pair           the output side at vgs(14) at 1 µm plus the body effect, its partner the
  //                  same width at the other share and its own folding node; the tail node puts
  //                  the mean of the two on CM_dc
  const I_TAIL = 20e-6;
  const L_IN = 1e-6;
  const L_CS = 1e-6;
  const VA = va(L);
  const VA1 = va(L_CS);
  const vgs10 = vgsAtGmId(10);
  const vgsIn = vgsAtGmId(14, L_IN);
  const X = vgsAtGmId(8, L_CS);
  const V_FOLD = 1.4;
  const V_C = 0.31;
  const rest = (() => {
    let [share, vFr, vCr, vTail, vgsInr] = [0.5, V_FOLD, V_C, sourceNodeUnder(1.05, vgsIn), vgsIn];
    let [iTail, iPr, iFr, iNmir] = [0, 30e-6, 0, 0];
    for (let i = 0; i < 60; i++) {
      iTail = I_TAIL * tailRatioAt(vTail, VGS_GMID8_L05);
      iPr = (30e-6 * (VA1 + 1.8 - vFr)) / (VA1 + 1.8 - V_FOLD);
      const copy = (VA1 + V_C) / (VA1 + vCr);
      share = (30e-6 - copy * (iPr - iTail)) / (iTail * (1 + copy));
      iFr = iPr - (1 - share) * iTail;
      iNmir = iFr * copy;
      const nr = (iFr * (1 + (0.9 - V_C) / VA)) / (iNmir * (1 + (X - vCr) / VA));
      vCr = V_C + (vgs10 - vgsForCurrentRatio(vgs10, nr)) / 1.2;
      const pr =
        (iFr * (1 + (V_FOLD - 0.9) / VA)) / ((30e-6 - share * iTail) * (1 + (vFr - X) / VA));
      vFr = V_FOLD + (vgsForCurrentRatio(vgs10, pr) - vgs10) / 1.2;
      const ir = ((1 - share) * (1 + (V_FOLD - vTail) / VA1)) / (share * (1 + (vFr - vTail) / VA1));
      vgsInr = vgsForCurrentRatio(vgsIn, ir, L_IN);
      vTail = sourceNodeUnder(1.05 - (vgsInr - vgsIn) / 2, vgsIn);
    }
    const iOut = share * iTail;
    const gmOut = 14 * iOut;
    const gmDiode = gmIdDemo(vgsInr, L_IN) * (iTail - iOut);
    // The bottom mirror's current gain, its output device's gm over its diode device's: one gate,
    // one width, drains at V_C and V_c_r, so the ratio its currents are in.
    const copy = (VA1 + V_C) / (VA1 + vCr);
    return {
      share,
      vFr,
      vCr,
      vTail,
      delta: vgsInr - vgsIn,
      iTail,
      iOut,
      iPr,
      iNmir,
      copy,
      // The diode side's half through the bottom mirror, the output side's half direct.
      gmPair: (gmDiode * copy + gmOut) / 2,
    };
  })();
  const { vTail, gmPair } = rest;
  /** The output side's fold current: the branch bias less what its pair transistor takes. */
  const iFold = 30e-6 - rest.iOut;
  // A common mode that leaves the tail device 30 mV short of its saturation voltage, for the pair
  // at gm/ID 14 standing on it: 1.2 × 0.263163 + 0.543119 = 0.858914 V.
  const cmTooLow = (1 + BODY_FACTOR) * (vdsatDemo(VGS_GMID8_L05, L) - 0.03) + vgsIn;
  /** Where the tail node lands at a range end with every device held: the pair (Early voltage
   *  `vaPair`, its drain at `drain`) carries what the tail delivers, and the tail device
   *  (Early voltage `vaTail`) delivers in proportion to (VA + node). heldTailNode's argument, with
   *  each device's own length. */
  const heldAt = (cm: number, vaPair: number, vaTail: number): number => {
    const base = sourceNodeUnder(1.05, vgsIn);
    const resized = sourceNodeUnder(cm, vgsIn);
    const more = Math.log((vaPair + V_FOLD - resized) / (vaPair + V_FOLD - base));
    const less = Math.log((vaTail + resized) / (vaTail + base));
    return sourceNodeUnder(cm + (more - less) / 14, vgsIn);
  };

  itDrawsItsTail(doc, res, I_TAIL, vTail, VGS_GMID8_L05, cmTooLow, 'inr');

  it('the fold current is the branch bias less what the input device takes', () => {
    expect(relErr(res.values.I_fold, iFold)).toBeLessThan(1e-3);
    expect(relErr(res.values.I_fold, 30e-6 - res.values.in__id)).toBeLessThan(1e-12);
    expect(relErr(res.values.GBW, gmPair / (TWO_PI * CL))).toBeLessThan(1e-3);
    expect(relErr(res.values.GBW, res.values.gm_pair / (TWO_PI * CL))).toBeLessThan(1e-12);
    // The pair's two halves, the diode side's through the bottom mirror's gain.
    const { in__gm, inr__gm, nmir__gm, nmir_r__gm } = res.values;
    expect(
      relErr(res.values.gm_pair, (inr__gm * (nmir__gm / nmir_r__gm) + in__gm) / 2),
    ).toBeLessThan(1e-12);
    expect(relErr(nmir__gm / nmir_r__gm, rest.copy)).toBeLessThan(1e-3);
    expect(relErr(res.values.SR, res.values.tail__id / CL)).toBeLessThan(1e-12);
    // The branch must take at least the input device's current, so that slewing the whole tail
    // into one folding node does not starve it: the check compares the two currents the run reads.
    const fold = check(res, 'fold-current');
    expect([fold.lhsValue, fold.rhsValue]).toEqual([res.values.I_fold, res.values.in__id]);
  });

  it('the split is solved so the currents at the output node balance', () => {
    // What the output side's PMOS cascode brings down is what the bottom mirror's output side
    // pulls, to the solve's tolerance; the split lands 0.0015 under one half here.
    expect(relErr(res.values.I_branch - res.values.in__id, res.values.nmir__id)).toBeLessThan(1e-6);
    expect(doc.params.find((p) => p.name === 'out_share')?.designConstraint).toEqual({
      lhs: 'I_branch - in__id',
      rhs: 'nmir__id',
    });
    expect(relErr(res.values.out_share - 0.5, rest.share - 0.5)).toBeLessThan(2e-2);
    expect(relErr(res.values.nmir__id, rest.iNmir)).toBeLessThan(1e-3);
    // The diode side's folding source is the output side's width on its gate, read at its own
    // drain; its fold current is what the mirror's diode side, and both diode-side cascodes, carry.
    expect(block(res, 'pcs_r').W).toBe(block(res, 'pcs').W);
    expect(relErr(block(res, 'pcs_r').vgs, block(res, 'pcs').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'pcs_r').id, rest.iPr)).toBeLessThan(1e-3);
    const diodeFold = block(res, 'pcs_r').id - res.values.inr__id;
    for (const name of ['nmir_r', 'ncasc_r', 'pcasc_r'])
      expect([name, block(res, name).id]).toEqual([name, diodeFold]);
  });

  it('the diode side hangs under the gates the output side sets, and its drain is the mirror gate', () => {
    expect(relErr(res.values.V_fold_r, rest.vFr)).toBeLessThan(1e-4);
    expect(relErr(res.values.V_c_r, rest.vCr)).toBeLessThan(1e-3);
    expect(res.values.V_c_r + res.values.ncasc_r__vgs).toBeCloseTo(V_C + res.values.ncasc__vgs, 6);
    expect(res.values.V_fold_r - res.values.pcasc_r__vgs).toBeCloseTo(
      V_FOLD - res.values.pcasc__vgs,
      6,
    );
    const node = block(res, 'nmir_r').vgs;
    expect(relErr(node, X)).toBeLessThan(1e-4);
    expect(block(res, 'ncasc_r').bias?.vds).toBeCloseTo(node - res.values.V_c_r, 12);
    expect(block(res, 'pcasc_r').bias?.vds).toBeCloseTo(res.values.V_fold_r - node, 12);
    expect(block(res, 'nmir').W).toBe(block(res, 'nmir_r').W);
    expect(relErr(block(res, 'nmir').vgs, block(res, 'nmir_r').vgs)).toBeLessThan(1e-12);
  });

  it('systematic offset is the difference of the two gate-source voltages at rest', () => {
    // 0.5 mV here: the two folding nodes and the two fold currents differ by a little, and the
    // pair carries what makes the output balance. The table resolves the two gate voltages to a
    // few tens of microvolts, so the closed form is met to 5e-2 of that half millivolt.
    expect(res.values.vos_sys).toBe(Math.abs(res.values.inr__vgs - res.values.in__vgs));
    expect(relErr(res.values.vos_sys, Math.abs(rest.delta))).toBeLessThan(5e-2);
  });

  it('the supply carries the two folding branches, and the tail current runs through them', () => {
    // Only the two folding current sources sit on the supply rail, each at what it delivers. The
    // tail is not a third branch: it is drawn down THROUGH those sources. The cross-check is the
    // other end of the circuit — everything reaching ground is what the tail delivers plus both
    // fold currents, and the current law makes the two the same.
    expect(relErr(res.values.I_q, 30e-6 + rest.iPr)).toBeLessThan(1e-4);
    expect(res.values.I_q).toBe(res.values.pcs__id + res.values.pcs_r__id);
    const diodeFold = block(res, 'pcs_r').id - res.values.inr__id;
    expect(
      relErr(res.values.I_q, res.values.tail__id + res.values.I_fold + diodeFold),
    ).toBeLessThan(1e-12);
  });

  it('the design constraint lands the common mode on CM_dc, with the tail node as the variable', () => {
    expect(res.values.CM_in).toBeCloseTo(1.05, 5);
  });

  it('gain is the pair transconductance times the parallel folded-cascode output resistance', () => {
    // The cascodes sit at 0.5 µm, the current sources they stand on at 1 µm, where VA is 5 V.
    const Rp = av0Of(10, L, V_FOLD - 0.9) / gdsOf(30e-6, L_CS, 1.8 - V_FOLD); // pcasc av0 / pcs gds
    const Rn = av0Of(10, L, 0.9 - V_C) / gdsOf(rest.iNmir, L_CS, V_C); // ncasc av0 / nmir gds
    const Rout = 1 / (1 / Rp + 1 / Rn);
    expect(relErr(res.values.Av, gmPair * Rout)).toBeLessThan(1e-2);
  });

  it('every device declares that it must stay saturated', () => {
    expect(declaredSaturated(doc)).toEqual([
      'tail',
      'in',
      'pcs',
      'pcasc',
      'pcs_r',
      'inr',
      'nmir_r',
      'nmir',
      'ncasc',
      'ncasc_r',
      'pcasc_r',
    ]);
    const across = {
      in: V_FOLD - res.values.V_tail,
      pcs: 1.8 - V_FOLD,
      pcasc: V_FOLD - 0.9,
      ncasc: 0.9 - V_C,
      nmir: V_C,
      nmir_r: res.values.V_c_r,
      pcs_r: 1.8 - res.values.V_fold_r,
      inr: res.values.V_fold_r - res.values.V_tail,
    };
    for (const [name, vds] of Object.entries(across)) {
      const c = regionOf(res, name);
      expect([name, c.kind]).toEqual([name, 'physical']);
      expect([name, c.status === 'pass' || c.status === 'amber']).toEqual([name, true]);
      expect([name, relErr(c.lhsValue!, vds) < 1e-9]).toEqual([name, true]);
    }
    // The bottom mirror sits near its saturation voltage at V_c = 0.31 V on this table, and its
    // diode side a few millivolts lower, because that side's cascode has its drain on the mirror
    // node; a node 20 mV lower takes the diode side out first, and its declaration says so.
    expect(hardFailsIn(runSheet(withParams(doc, { V_c: 0.29 }), table))).toContain('nmir_r.region');
  });

  it('meets its own checks where it is sized, and at both ends of its common-mode range', () => {
    // The defaults are chosen so that it does. With the pair carrying what the tail delivers
    // rather than the programmed current, the pair, the output mirror and the folding sources
    // need their 1 µm: with all of them at 0.5 µm the gain and the offset both miss.
    expect(res.feasible).toBe(true);
    expect(res.rangeEnds?.map((e) => [e.name, e.state])).toEqual([
      ['cm-lo', 'complies'],
      ['cm-hi', 'complies'],
    ]);
    const short = runSheet(withParams(doc, { L_cs: 0.5e-6, L_in: 0.5e-6 }), table);
    expect(hardFailsIn(short)).toEqual(expect.arrayContaining(['gain-spec', 'offset-spec']));
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
    const inrAt = lo.blocks!.find((c) => c.name === 'inr')!.sizing!;
    expect(lo.solved.V_tail + (inAt.vgs + inrAt.vgs) / 2).toBeCloseTo(1.0, 5);
    const tailAt = lo.blocks!.find((c) => c.name === 'tail')!.sizing!;
    expect(relErr(inAt.id + inrAt.id, tailAt.id)).toBeLessThan(1e-12);
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
 * the name of the PMOS diode block on the output-driving side and `pmosPole` of its PMOS
 * mirror-node pole equation.
 *
 * Defaults: the bias reference programmed to I_tail = 20 µA at gm/ID 10, K_m 2, gm/ID in 12 /
 * mirror diodes 10, every L 0.5 µm, V_out_dc 0.9 V, VDD 1.8 V, CM_dc 1.05 V. Only the reference's
 * current is typed. The tail device is the reference's width on the reference's gate with the
 * tail node as its drain. The sheet is drawn at rest: the pair's two transistors are one width
 * and so are the two PMOS diodes, each side carrying its own share of what the tail delivers, and
 * the share is solved so the two output devices carry the same current. Each output device is a
 * multiple of its diode device's width on that device's gate, so what it carries is read off the
 * table at its own drain voltage. The reference, the output-driving side's PMOS diode and the
 * NMOS diode are sized at gm/ID 10 and the one table stands for both polarities, so all three sit
 * at vgs(10) = 0.610063 V; the folded side's PMOS diode carries the other share at that width,
 * along its own diagonal. The resting state is a short fixed point of closed forms:
 *   copies at the output           rOut = (2.5 + 0.9)/(2.5 + vgs(10))
 *   copy onto the NMOS diode       rFold = (2.5 + 1.8 − vgs(10))/(2.5 + vgs_f), its drain on that
 *                                  diode's node, vgs(10) above ground, its gate the folded diode's
 *   split                          the PMOS output device carries 2·s·I·rOut and the NMOS one
 *                                  2·(1 − s)·I·rFold·rOut, so s = rFold/(1 + rFold)
 *   pair                           the output-driving side at vgs(12) plus the body effect, its
 *                                  partner the same width at the other share and its own drain;
 *                                  the tail node puts the mean of the two on CM_dc
 */
/** The current-mirror OTA's resting state on the demo model at its defaults, from the closed forms
 *  in the comment above (see itIsAMirrorOta). */
const mirrorOtaAtRest = () => {
  const I_TAIL = 20e-6;
  const K_M = 2;
  const VA = va(L);
  const vgs10 = VGS_GMID10_L05;
  const rOut = (VA + 0.9) / (VA + vgs10);

  let [share, vgsF, vTail, vgsInf] = [0.5, vgs10, sourceNodeUnder(1.05, VGS_GMID12_L05), 0];
  let iTail = 0;
  for (let i = 0; i < 80; i++) {
    iTail = I_TAIL * tailRatioAt(vTail, vgs10);
    // The folded side's diode: the same width at (1 − s)/s the current, read along its own
    // vds = vgs diagonal.
    for (let k = 0; k < 20; k++)
      vgsF = vgsForCurrentRatio(
        vgs10,
        ((1 - share) * (1 + vgs10 / VA)) / (share * (1 + vgsF / VA)),
      );
    const rFold = (VA + 1.8 - vgs10) / (VA + vgsF);
    share = rFold / (1 + rFold);
    const ir =
      ((1 - share) * (1 + (1.8 - vgs10 - vTail) / VA)) / (share * (1 + (1.8 - vgsF - vTail) / VA));
    vgsInf = vgsForCurrentRatio(VGS_GMID12_L05, ir);
    vTail = sourceNodeUnder(1.05 - (vgsInf - VGS_GMID12_L05) / 2, VGS_GMID12_L05);
  }
  const rFold = (VA + 1.8 - vgs10) / (VA + vgsF);
  const iOut = share * iTail;
  const iFolded = iTail - iOut;
  const gmIn = 12 * iOut;
  const gmInF = gmIdDemo(vgsInf) * iFolded;
  // Each pair transistor's half of the signal through its own mirror path: the output-driving
  // side's through the PMOS mirror, K_m·rOut, the folded side's through both, K_m·rFold·rOut.
  const gmOut = (gmIn * K_M * rOut + gmInF * K_M * rFold * rOut) / 2;
  const iP = K_M * iOut * rOut; // the PMOS output device at the output
  const iFold = K_M * iFolded * rFold; // the PMOS output device on the NMOS diode
  return {
    share,
    vgsF,
    vTail,
    delta: vgsInf - VGS_GMID12_L05,
    iTail,
    iOut,
    iFolded,
    gmIn,
    gmInF,
    gmOut,
    rFold,
    iP,
    iFold,
    gmF: gmIdDemo(vgsF),
  };
};

const itIsAMirrorOta = (
  doc: SheetDoc,
  res: SheetResult,
  diode: 'mload',
  pmosPole: 'f_pole',
): void => {
  const I_TAIL = 20e-6;
  const K_M = 2;
  const VA = va(L);
  const vgs10 = VGS_GMID10_L05;
  const rOut = (VA + 0.9) / (VA + vgs10);
  const rest = mirrorOtaAtRest();
  const { vTail, iOut, iFolded, gmOut, rFold, iP, iFold } = rest;
  const v = res.values;

  // A common mode that leaves the tail device 30 mV short of its saturation voltage, for the pair
  // at gm/ID 12 standing on it: 1.2 × 0.205212 + 0.567023 = 0.813278 V.
  const cmTooLow = (1 + BODY_FACTOR) * (vdsatDemo(vgs10, L) - 0.03) + VGS_GMID12_L05;
  itDrawsItsTail(doc, res, I_TAIL, vTail, vgs10, cmTooLow, 'in_f');

  it('the split is solved so the two output devices carry one current', () => {
    // The output node is held at V_out_dc by feedback outside the sheet, so what the PMOS output
    // device sources is what the NMOS one sinks, to the solve's tolerance. The NMOS one is a copy
    // of a copy, its first copy made onto the NMOS diode's node 1.19 V below the supply, so at an
    // even split it would carry rFold times more: the output-driving side carries
    // rFold/(1 + rFold) = 54.4 % of the tail's current instead.
    expect(relErr(v.moutp__id, v.moutn__id)).toBeLessThan(1e-6);
    expect(doc.params.find((p) => p.name === 'out_share')?.designConstraint).toEqual({
      lhs: 'moutp__id',
      rhs: 'moutn__id',
    });
    expect(relErr(v.out_share - 0.5, rest.share - 0.5)).toBeLessThan(1e-3);
    expect(relErr(v.in__id, iOut)).toBeLessThan(1e-4);
    expect(relErr(v.in_f__id, iFolded)).toBeLessThan(1e-4);
  });

  it('every other current is handed on, and each mirror is one gate wire', () => {
    // Each PMOS diode is in its pair transistor's branch and the NMOS diode under the second PMOS
    // output device: each is HANDED the current of the device it is in series with, to the last
    // bit, and none of them is sized against the programmed number.
    expect(block(res, diode).id).toBe(block(res, 'in').id);
    expect(block(res, 'mload_f').id).toBe(block(res, 'in_f').id);
    expect(block(res, 'nmir').id).toBe(v.mfold__id);
    // The two diodes are one width, and so are the two pair transistors.
    expect(block(res, 'mload_f').W).toBe(block(res, diode).W);
    expect(block(res, 'in_f').W).toBe(block(res, 'in').W);
    // A mirror is a multiple of the diode's width on the diode's gate. The width is passed
    // through untouched; the gate voltage is reported as the table's own vgs coordinate at the
    // point it was read, so two devices on one wire agree to rounding rather than always to the
    // last bit.
    expect(block(res, 'moutp').W).toBe(K_M * block(res, diode).W);
    expect(block(res, 'mfold').W).toBe(K_M * block(res, 'mload_f').W);
    expect(block(res, 'moutn').W).toBe(block(res, 'nmir').W);
    for (const [out, ref] of [
      ['moutp', diode],
      ['mfold', 'mload_f'],
      ['moutn', 'nmir'],
    ])
      expect([out, relErr(block(res, out).vgs, block(res, ref).vgs) < 1e-12]).toEqual([out, true]);
    // The folded side's diode carries the smaller share at the same width, so it sits lower on
    // its diagonal than the output-driving side's.
    expect(relErr(block(res, 'mload_f').vgs, rest.vgsF)).toBeLessThan(1e-3);
  });

  it('the NMOS diode node is solved to the gate-source voltage of the diode on it', () => {
    // The one bias loop on the sheet: the second PMOS output device has its drain on this node,
    // the current it delivers there is the NMOS diode's, and the diode's gate-source voltage at
    // that current is the node. Sized for its inversion level, the diode sits at vgs(10)
    // whatever it carries, so the node lands there and the PMOS device sits
    // 1.8 − 0.610063 = 1.189937 V below the supply.
    expect(relErr(v.V_nmir, block(res, 'nmir').vgs)).toBeLessThan(1e-6);
    expect(relErr(v.V_nmir, vgs10)).toBeLessThan(1e-5);
    expect(block(res, 'mfold').bias?.vds).toBeCloseTo(1.8 - vgs10, 5);
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
    // does not enter, and as errors, the way the mirror goldens compare theirs. Both copies made
    // at the output sit 0.9 V from their rail, further than their diode's drop, and over-deliver
    // by 9.32 %; the copy made onto the NMOS diode's node over-delivers by rFold − 1.
    expect(relErr(v.moutp__id / (K_M * v[`${diode}__id`]) - 1, rOut - 1)).toBeLessThan(1e-3);
    expect(relErr(v.mfold__id / (K_M * block(res, 'mload_f').id) - 1, rFold - 1)).toBeLessThan(
      1e-3,
    );
    expect(relErr(v.moutn__id / v.mfold__id - 1, rOut - 1)).toBeLessThan(1e-3);
  });

  it('systematic offset is the difference of the two gate-source voltages at rest', () => {
    // The pair's two transistors carry the two shares at one width, and their drains sit at the
    // two diode drops: 14.7 mV apart in gate-source voltage here. Read directly, nothing estimated.
    expect(v.vos_sys).toBe(Math.abs(v.in_f__vgs - v.in__vgs));
    expect(relErr(v.vos_sys, Math.abs(rest.delta))).toBeLessThan(1e-2);
  });

  it('transconductance and GBW follow the gain the two mirror paths deliver', () => {
    // gm scales with (VA + vds) exactly as id does, so each mirror's small-signal current gain is
    // its current ratio: K_m·rOut straight to the output, K_m·rFold·rOut through the NMOS mirror.
    // The gm of a device on another's gate rides the interpolated gm curve, so these two hold to
    // interpolation order. Each pair transistor turns half the differential input into current at
    // its own transconductance, and each half takes its own side's path.
    expect(relErr(v.Ai_p / K_M - 1, rOut - 1)).toBeLessThan(1e-2);
    expect(relErr(v.Ai_n / K_M - 1, rFold * rOut - 1)).toBeLessThan(1e-2);
    expect(relErr(v.Gm_out, gmOut)).toBeLessThan(1e-3);
    expect(relErr(v.GBW, gmOut / (TWO_PI * CL))).toBeLessThan(1e-3);
    // Which quantities each equation reads, exactly.
    expect(relErr(v.Gm_out, (v.in__gm * v.Ai_p + v.in_f__gm * v.Ai_n) / 2)).toBeLessThan(1e-12);
    expect(relErr(v.GBW, v.Gm_out / (TWO_PI * CL))).toBeLessThan(1e-12);
  });

  it('slew is twice what the output devices carry at rest', () => {
    // At rest the two output devices carry one current, K_m·s·I·rOut = 22.25 µA, and the whole
    // tail steered to one side doubles it to first order: 2 × 22.25 µA into 2 pF.
    expect(relErr(v.SR, (2 * iP) / CL)).toBeLessThan(1e-3);
    expect(relErr(v.SR, (2 * Math.min(v.moutp__id, v.moutn__id)) / CL)).toBeLessThan(1e-12);
  });

  it('the supply carries both input branches and the two PMOS output branches', () => {
    // What the tail delivers comes down the two input branches, plus the two PMOS output devices'
    // currents. The NMOS mirror is not a further branch: it carries to ground what the PMOS side
    // delivers. The reference branch is shared bias and is not counted.
    expect(relErr(v.I_q, rest.iTail + iP + iFold)).toBeLessThan(1e-3);
    expect(relErr(v.I_q, v.tail__id + v.moutp__id + v.mfold__id)).toBeLessThan(1e-12);
  });

  it('DC gain is K_m-independent: gain = (gm_in + rFold·gm_in_f)·(VA + V_out)/(4·I_out) at rest', () => {
    // gds = idSat/VA in the demo model and an output device copies its diode's saturation current
    // per width, so the drain voltage an output device sits at cancels out of its gds: it is its
    // diode's current, times the width ratio, over (VA + that diode's drop). The two output
    // devices carry one current at rest, so each has the same gds.
    const rout = 1 / (2 * gdsOf(iP, L, 0.9));
    expect(relErr(v.Rout, rout)).toBeLessThan(1e-3);
    // Against the transconductance above, K_m and the mirror gain rOut cancel, leaving the pair's
    // two gm over the output side's current: Av = (gm_in + rFold·gm_in_f)·(VA + 0.9)/(4·I_out).
    expect(relErr(v.Av, gmOut * rout)).toBeLessThan(1e-3);
    expect(
      relErr(v.Av, ((rest.gmIn + rFold * rest.gmInF) * (va(L) + 0.9)) / (4 * iOut)),
    ).toBeLessThan(1e-3);
    expect(relErr(v.Av, v.Gm_out * v.Rout)).toBeLessThan(1e-12);
    // K_m scales every output-side width and current together, so it cancels on the table too.
    const wider = runSheet(withParams(doc, { K_m: 4 }), table);
    expect(relErr(wider.values.Av, v.Av)).toBeLessThan(1e-6);
  });

  it('each mirror-node pole is the diode gm over the gates on its node', () => {
    // A diode device's gm is (gm/ID)·id, both given, and cgg = W·L·Cox at the width the sizing
    // landed on. The PMOS node carries the diode's gate and one K_m times as wide; the diode
    // carries the share of the tail's current it is handed.
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
    // Every device's drain noise current is 4kTγ·(gm + gmb), which on the demo is 4kTγ·1.2·gm (kT4
    // below is that coefficient). Referred to the input, a pair transistor's
    // noise is its own density; a mirror device's drain noise current reaches the output through
    // the gain of its path and is divided by Gm_out:
    //   PMOS diodes     the output-driving one through the PMOS mirror, Ai_p, the folded one
    //                   through both mirrors, Ai_n
    //   output devices  straight into the output
    //   folded branch   the PMOS output device on the NMOS diode's node and that diode, copied by
    //                   the bottom mirror's rOut
    const kT4 = (4 * PHYS.k * PHYS.T * vnthM(1) ** 2) / (4 * PHYS.k * PHYS.T);
    const gmP = 10 * iP;
    const gmFold = rest.gmF * iFold;
    const gmNmir = 10 * iFold;
    const aiP = K_M * rOut;
    const aiN = K_M * rFold * rOut;
    const outputSide =
      10 * iOut * aiP ** 2 + // output-driving PMOS diode
      rest.gmF * iFolded * aiN ** 2 + // folded PMOS diode
      gmP + // PMOS output device at the output
      (gmFold + gmNmir) * rOut ** 2 + // the folded branch, copied by the bottom mirror
      gmP; // NMOS output device, at the PMOS one's current at rest
    const vn2 = kT4 * (1 / rest.gmIn + 1 / rest.gmInF + outputSide / gmOut ** 2);
    expect(relErr(v.vn_in, Math.sqrt(vn2))).toBeLessThan(1e-3);
    // Which devices the equation reads, exactly: every one of the six mirror devices, at its own
    // density and gm, so leaving any of them out moves the row.
    const i2 = (name: string): number => (v[`${name}__vnth_m`] * v[`${name}__gm`]) ** 2;
    const bottomGain = v.moutn__gm / v.nmir__gm;
    const output =
      i2(diode) * v.Ai_p ** 2 +
      i2('mload_f') * v.Ai_n ** 2 +
      i2('moutp') +
      (i2('mfold') + i2('nmir')) * bottomGain ** 2 +
      i2('moutn');
    expect(
      relErr(v.vn_in, Math.sqrt(v.in__vnth_m ** 2 + v.in_f__vnth_m ** 2 + output / v.Gm_out ** 2)),
    ).toBeLessThan(1e-12);
    // The pair and the two PMOS diodes alone read well under the whole: a row that stopped there
    // would read about 16 % low.
    const pairAndDiodes = Math.sqrt(
      v.in__vnth_m ** 2 +
        v.in_f__vnth_m ** 2 +
        (i2(diode) * v.Ai_p ** 2 + i2('mload_f') * v.Ai_n ** 2) / v.Gm_out ** 2,
    );
    expect(pairAndDiodes / v.vn_in).toBeLessThan(0.86);
  });

  it('each output device is held against its own saturation voltage', () => {
    // An output device takes its gate voltage from its diode device, so nothing in its givens
    // keeps it saturated: each declares that it must stay saturated, and the declaration is a
    // physical check on that device, comparing the drain-source voltage it sits at with the
    // saturation voltage it reports. On the demo model that is its diode's, 2·UT plus the
    // diode's overdrive: 0.235 V on the two at gm/ID 10, a little less on the copy of the folded
    // side's diode, which sits lower on its diagonal.
    const across: Record<string, [number, number]> = {
      moutp: [1.8 - 0.9, vgs10],
      mfold: [1.8 - vgs10, rest.vgsF],
      moutn: [0.9, vgs10],
    };
    for (const [name, [vds, gate]] of Object.entries(across)) {
      const c = regionOf(res, name);
      expect([name, c.kind, c.status]).toEqual([name, 'physical', 'pass']);
      expect([name, relErr(c.lhsValue!, vds) < 1e-5]).toEqual([name, true]);
      expect([name, c.rhsValue]).toEqual([name, v[`${name}__vdsat`]]);
      expect([name, relErr(c.rhsValue!, vdsatDemo(gate, L)) < 1e-2]).toEqual([name, true]);
    }
    expect(doc.checks.map((c) => c.id).filter((id) => /-saturated$/.test(id))).toEqual([]);
    // Each one trips when its own device is squeezed, and takes feasibility with it. Under
    // a 1.4 V supply, an output 0.2 V above ground squeezes the NMOS output device and one 0.2 V
    // below the supply the PMOS output device beside it.
    const failing = (over: Record<string, number>): string[] => {
      const r = runSheet(withParams(doc, over), table);
      expect(r.feasible).toBe(false);
      return hardFailsIn(r).filter((id) => id.endsWith('.region'));
    };
    expect(failing({ VDD: 1.4, V_out_dc: 0.2 })).toContain('moutn.region');
    expect(failing({ VDD: 1.4, V_out_dc: 1.2 })).toContain('moutp.region');
    // A strong PMOS diode under that supply squeezes the other PMOS output device, which sits on
    // the NMOS diode's drop, and the pair transistors under the diodes: each declares it.
    expect(failing({ gm_id_ml: 4, VDD: 1.4, V_out_dc: 0.7 })).toEqual(
      expect.arrayContaining(['in.region', 'mfold.region']),
    );
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

    for (const name of [
      'bias',
      'tail',
      'mload',
      'in',
      'mload_f',
      'in_f',
      'moutp',
      'mfold',
      'nmir',
      'moutn',
    ])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    expect(block(h, 'bias').id).toBe(20e-6);
    expect(block(h, 'bias').vgs).toBeGreaterThan(block(s, 'bias').vgs);
    expect(relErr(block(h, 'tail').vgs, block(h, 'bias').vgs)).toBeLessThan(1e-12);
    expect(relErr(h.values.in__id + h.values.in_f__id, h.values.tail__id)).toBeLessThan(1e-12);
    expect(relErr(h.values.moutp__id, h.values.moutn__id)).toBeLessThan(1e-6);
    expect(block(h, 'mload').id).toBe(block(h, 'in').id);
    expect(block(h, 'mload').vgs).toBeGreaterThan(block(s, 'mload').vgs);
    expect(relErr(block(h, 'moutp').vgs, block(h, 'mload').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(h, 'mfold').vgs, block(h, 'mload_f').vgs)).toBeLessThan(1e-12);
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
    // settles below the output-driving PMOS diode's drop, carrying less than where the design was
    // sized.
    expect(h.values.V_nmir).toBeGreaterThan(s.values.V_nmir);
    expect(h.values.V_nmir).toBeLessThan(block(h, 'mload').vgs);
    expect(h.values.mfold__id).toBeLessThan(s.values.mfold__id);
    expect(h.values.mfold__id).toBeGreaterThan(s.values.mfold__id / 2);

    // Every copy is the same closed form, read at this condition's voltages: each PMOS output
    // device against K_m times the current of the diode whose gate it shares.
    const iRef = 2 * block(h, 'mload').id;
    const refDrop = va(L) + block(h, 'mload').vgs;
    const iRefF = 2 * block(h, 'mload_f').id;
    const foldRatio = (va(L) + 1.8 - h.values.V_nmir) / (va(L) + block(h, 'mload_f').vgs);
    const outRatioN = (va(L) + 0.9) / (va(L) + h.values.V_nmir);
    expect(relErr(h.values.moutp__id / iRef - 1, (va(L) + 0.9) / refDrop - 1)).toBeLessThan(1e-2);
    expect(relErr(h.values.mfold__id / iRefF - 1, foldRatio - 1)).toBeLessThan(1e-2);
    expect(relErr(h.values.moutn__id / h.values.mfold__id - 1, outRatioN - 1)).toBeLessThan(1e-2);
  });
});

describe('tier-3 goldens: gain-boosted cascode OTA', () => {
  const doc = sheet('gain-boosted-cascode-ota.json');
  const res = runSheet(doc, table);
  // Defaults: the bias reference programmed to I_tail = 20 µA at gm/ID 14, the tail device on its
  // gate, gm/ID in 14 / casc 10 / mir 13 / boost 12, all L 0.5 µm; the stack is node-parameterized
  // — V_a 0.55 and V_b 1.52 on both sides, V_out 0.9, the tail node constrained so CM_in lands on
  // CM_dc 0.95 — and every device vds is a subtraction between nodes. Both sides' internal nodes
  // sit at V_a and V_b, so the pair and the mirror are each one sizing placed twice, at one
  // operating point, and split the tail current evenly; only the cascodes differ between the
  // sides, the diode side's with their drains on the mirror's gate, X = 1.8 − vgs(13).
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
    const Rp = (boost * av0Of(10, L, 1.52 - 0.9)) / gdsOf(iHalf, L, 1.8 - 1.52);
    const Rout = 1 / (1 / Rn + 1 / Rp);
    expect(relErr(res.values.Av, gmIn * Rout)).toBeLessThan(1e-2);
    for (const name of ['casc_n', 'casc_p', 'mir'])
      expect([name, block(res, name).id]).toEqual([name, block(res, 'in').id]);
  });

  it('the pair and the mirror are each placed twice at one point, and the diode-side cascodes sit on the mirror gate', () => {
    // The boosters hold both sides' internal nodes at the same levels, so the two pair transistors
    // share a drain level, a source and a current, and so do the two mirror devices: the wiring
    // check shows each pair of placements at one operating point. The diode side's two cascodes
    // are the output side's widths at the same current, their drains on the mirror's gate.
    expect(res.nodes!.placements).toEqual([
      { device: 'in', shared: true },
      { device: 'mir', shared: true },
    ]);
    const X = 1.8 - vgsAtGmId(13);
    expect(relErr(1.8 - block(res, 'mir').vgs, X)).toBeLessThan(1e-4);
    expect(block(res, 'casc_nr').W).toBe(block(res, 'casc_n').W);
    expect(block(res, 'casc_pr').W).toBe(block(res, 'casc_p').W);
    expect(relErr(block(res, 'casc_nr').bias!.vds, X - 0.55)).toBeLessThan(1e-4);
    expect(relErr(block(res, 'casc_pr').bias!.vds, 1.52 - X)).toBeLessThan(1e-3);
    // Each is held saturated there; the diode side's PMOS cascode is the one with least to spare,
    // and at the 1.3 V V_b once shipped it would sit in triode, which is why V_b is 1.52 V.
    for (const name of ['casc_nr', 'casc_pr'])
      expect([name, regionOf(res, name).status]).toEqual([name, 'pass']);
    expect(hardFailsIn(runSheet(withParams(doc, { V_b: 1.3 }), table))).toContain('casc_pr.region');
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

  it('the wiring check holds the PMOS to the shared gate', () => {
    // The netlist puts the two gates on one input wire and the two sources on the rails. Where the
    // design is sized the loop through them restates how it was sized, so it closes; a PMOS read
    // 0.1 V off the shared gate makes the loop miss by that 0.1 V, and the check says so.
    expect(res.nodes!.state).toBe('checked-clean');
    const off: SheetDoc = {
      ...doc,
      blocks: doc.blocks!.map((u) =>
        u.name === 'p'
          ? { ...u, params: { ...u.params, vgs_d: 'sign_p*(VDD - n__vgs) - 0.1' } }
          : u,
      ),
    };
    const moved = runSheet(off, table);
    expect(moved.nodes!.state).toBe('checked-with-findings');
    const [dispute] = moved.nodes!.disputes;
    expect(dispute.relations).toEqual(expect.arrayContaining(['n.gs', 'p.gs']));
    expect(relErr(dispute.closureError, 0.1)).toBeLessThan(1e-9);
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
    // Both devices are counted: each puts 4kTγ·(gm + gmb) of noise current into the output —
    // 4kTγ·1.2·gm on the demo — and the sum over gm_tot² is the density of one device with the
    // composite transconductance.
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
    expect(h.nodes!.state).toBe('checked-clean');
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
    // produce settles the tail higher than it would with the endpoint free to re-size the
    // devices around it, which lands at (0.95 − vgs(12))/1.2 = 0.31915 V. Two things let the held
    // pair's gate back off: more drain-source voltage, and less current, because the tail device
    // is on its reference's gate and delivers less with its drain 80 mV lower. And the sheet is
    // drawn at rest: the common mode is the mean of the two pair gates, which sit apart by the
    // offset, so the node sits another half offset over 1.2 higher. Locked as intent, not as a
    // regression.
    const lo = res.rangeEnds?.find((e) => e.name === 'cm-lo');
    expect(lo?.state).toBe('complies');
    // RECORDED from the engine on this table to six decimals. Beside it stands the held-width
    // landing in closed form: the pair's drain is the load's diode node, VDD − vgs(10), the pair
    // sits at gm/ID 12, its current is what the tail delivers at the node, and the offset between
    // its two transistors is the one at the design point (its golden is in the block above),
    // which gives 0.32903 V.
    expect(lo?.solved.V_tail).toBeCloseTo(0.328899, 6);
    const offset = mirrorOtaAtRest().delta;
    const held =
      heldTailNode(0.95, 1.05, VGS_GMID12_L05, 12, 1.8 - VGS_GMID10_L05, true) -
      offset / 2 / (1 + BODY_FACTOR);
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
