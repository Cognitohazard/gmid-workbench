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
import { resolveSheetRefs } from './resolve';
import {
  isHardCheck,
  withParams,
  type SheetDoc,
  type SheetResult,
  type SizingReport,
} from './types';
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
  VGS_GMID14_L05,
  sourceNodeUnder,
  vgsAtBody,
  vgsForCurrentRatio,
  gmIdDemo,
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

/** The saturation check a device's `region` declaration adds to its own results, by block. */
const regionOf = (r: Pick<SheetResult, 'blocks'>, name: string): SheetResult['checks'][number] =>
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

describe('tier4: which devices each multistage sheet needs saturated', () => {
  // Written down from each schematic: every device the design needs in saturation, and none of
  // the diode-connected ones. The second stage's current-source load is a library sheet of its
  // own, which declares it once for every sheet that composes it. A declaration dropped, or one
  // added to a device the design does not need saturated, fails here by name.
  const SATURATED: Record<string, string[]> = {
    'class-ab-output-monticelli': ['mn', 'mp'],
    'fd-telescopic-ota': ['tail', 'in', 'cascn', 'cascp', 'load'],
    'fd-two-stage-ota': ['s2', 'tail', 'ld1', 'in', 'ld2'],
    'flipped-voltage-follower': ['fb', 'in'],
    'rail-to-rail-input-stage': ['n', 'p'],
    'super-source-follower': ['fb', 'in'],
    'two-stage-cascode-comp-ota': ['tail', 's2', 'ld1o', 'ino', 'in', 'casc', 'casco', 'ld2'],
    'two-stage-miller-ota': ['tail', 's2', 'ld1o', 'ino', 'in', 'ld2'],
  };
  it('every sheet declares exactly the devices its design needs saturated', () => {
    for (const [file, devices] of Object.entries(SATURATED)) {
      const doc = resolveSheetRefs(sheet(file), REFS).doc;
      expect([file, declaredSaturated(doc)]).toEqual([file, devices]);
    }
    expect(sheet('stage2-current-source-load').givens?.region).toBe('saturation');
  });
  it('each declaration replaces an authored check, and reads as a physical check on its device', () => {
    // The zero-margin saturation checks the declarations stand for are gone from every sheet, and
    // at the shipped defaults on the synthetic table every declared device is saturated.
    const replaced = [
      'stage2-sat',
      'load2-sat',
      'tail-saturated',
      'tail-sat',
      'in-sat',
      'fb-sat',
      'cascn-sat',
      'cascp-sat',
      'load-sat',
      'cascode-sat',
      'cascode-out-sat',
      'out-hi-sat',
      'out-lo-sat',
    ];
    for (const [file, devices] of Object.entries(SATURATED)) {
      const doc = sheet(file);
      expect([file, doc.checks.map((c) => c.id).filter((id) => replaced.includes(id))]).toEqual([
        file,
        [],
      ]);
      const res = runSheet(doc, table, undefined, REFS);
      for (const name of devices) {
        const c = regionOf(res, name);
        expect([file, name, c.kind, c.status]).toEqual([file, name, 'physical', 'pass']);
      }
    }
  });
});

describe('tier4 goldens: Two-stage Miller OTA', () => {
  const doc = sheet('two-stage-miller-ota');
  const res = runSheet(doc, table, undefined, REFS);
  const v = res.values;
  // Defaults: the bias reference programmed to I1 at gm/ID 10; gm/ID in 12, mirror 8, s2 12,
  // ld2 8. Only the reference and the stage-2 device have a current typed into them.
  //
  // The first stage is drawn at rest: the feedback around the amplifier holds the stage-1 output
  // at the second stage's gate, one vgs(12) below the supply, and the inputs sit apart by what
  // that takes. The current law at that node fixes the split: the mirror's output device returns
  // R_LD = 0.968113 times the diode side's current, which is the diode-side input device's I_r,
  // and the output-side input device has to take exactly that, I_o = R_LD·I_r. So the output side
  // carries R_LD/(1 + R_LD) = 0.491899 of what the tail delivers, whatever that is.
  //
  // The two input devices are one width on one source. The output-side one is sized for gm/ID 12;
  // its partner carries 1/R_LD times its current at a drain 101 mV lower — the mirror node instead
  // of the stage-1 output — and needs more gate-source voltage for both reasons. The model's
  // current law gives how much (vgsForCurrentRatio); the common mode is the tail node plus the
  // mean of the two, so the tail node is a short fixed point:
  //   tail node   V_tail = (CM_dc − vgs(12) − Δ/2)/1.2 = 0.358608 V,   Δ = 5.294 mV
  //   tail        20 µA × (2.5 + 0.358608)/(2.5 + 0.610063) = 18.383 µA
  //   output side 18.383 µA × 0.491899 = 9.043 µA, diode side 9.340 µA
  const share = R_LD / (1 + R_LD);
  let vTail = V_TAIL;
  let delta = 0;
  for (let i = 0; i < 30; i++) {
    const ratio = ((1 / R_LD) * (VA05 + V_1 - vTail)) / (VA05 + V_MIR - vTail);
    delta = vgsForCurrentRatio(VGS_GMID12_L05, ratio) - VGS_GMID12_L05;
    vTail = sourceNodeUnder(1.0 - delta / 2, VGS_GMID12_L05);
  }
  /** What the tail delivers to the pair. */
  const iTail = (I1 * (VA05 + vTail)) / (VA05 + VGS_GMID10_L05);
  const iOut = iTail * share;
  const iIn = iTail - iOut;
  const gm2 = 12 * I2;
  // Half the differential input reaches the stage-1 output through the mirror and half directly,
  // and gm scales with (VA + vds) exactly as id does, so the mirror passes the diode-side device's
  // gm on at R_LD: gm1 = (gm_in·R_LD + gm_ino)/2. The diode-side device sits at the slightly
  // weaker inversion its larger gate drive gives (gm/ID 11.73 in the model), and its current times
  // R_LD is the output side's, so gm1 = I_o·(11.73 + 12)/2.
  const gm1 = (iOut * (gmIdDemo(VGS_GMID12_L05 + delta) + 12)) / 2;

  it('one first-stage current is typed, the pair is one width, and each mirror is one gate wire', () => {
    // The programmed current goes into the bias reference and nowhere else: both sides of the
    // first stage are handed a share of what the tail delivers. The second stage keeps its own
    // programmed current, which its load reads.
    expect(block(res, 'bias').id).toBe(I1);
    expect(relErr(block(res, 'ino').id, v.tail__id * v.out_share)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'in').id, v.tail__id * (1 - v.out_share))).toBeLessThan(1e-12);
    expect(relErr(block(res, 'ld1').id, v.in__id)).toBeLessThan(1e-12);
    expect(block(res, 's2').id).toBe(I2);
    expect(block(res, 'ld2').id).toBe(I2);
    // A mirror tie is the partner's width on the partner's gate-source voltage. The width is passed
    // through untouched; the gate voltage is reported as the table's own vgs coordinate at the
    // point it was read, so two devices on one wire agree to rounding. The pair shares the width
    // only: each of its devices carries its own current at its own gate-source voltage.
    for (const [tied, partner] of [
      ['tail', 'bias'],
      ['ld1o', 'ld1'],
    ]) {
      expect([tied, block(res, tied).W]).toEqual([tied, block(res, partner).W]);
      expect([tied, relErr(block(res, tied).vgs, block(res, partner).vgs) < 1e-12]).toEqual([
        tied,
        true,
      ]);
    }
    expect(block(res, 'in').W).toBe(block(res, 'ino').W);
    expect(doc.blocks!.find((u) => u.name === 'in')!.doc!.givens).toMatchObject({
      W: 'Wx',
      id: 'Ix',
    });
  });

  it('the tail misses its reference by the drain-voltage ratio of the demo model', () => {
    // The tail node (0.359 V) sits below the reference's diode drop (0.610 V), so the tail
    // under-delivers by 8.05 %. 1e-2 of that error is 2 mV of drain voltage.
    expect(relErr(1 - v.tail__id / I1, 1 - iTail / I1)).toBeLessThan(1e-2);
  });

  it('the split is solved so the currents at the stage-1 output balance', () => {
    // What the pair's output-side device takes is what the mirror's output device returns, to the
    // solve's tolerance; the two input devices add up to what the tail delivers by construction.
    expect(relErr(v.ino__id, v.ld1o__id)).toBeLessThan(1e-6);
    expect(relErr(v.in__id + v.ino__id, v.tail__id)).toBeLessThan(1e-12);
    expect(doc.params.find((p) => p.name === 'out_share')?.designConstraint).toEqual({
      lhs: 'ino__id',
      rhs: 'ld1o__id',
    });
    // The share is the mirror's ratio R_LD/(1 + R_LD), compared as its distance from an even split,
    // of which 1e-2 is about 0.1 mV of drain voltage.
    expect(relErr(v.out_share - 0.5, share - 0.5)).toBeLessThan(1e-2);
    expect(relErr(v.ino__id, iOut)).toBeLessThan(1e-3);
    expect(relErr(v.in__id, iIn)).toBeLessThan(1e-3);
    expect(v.ino__id).toBeLessThan(v.tail__id / 2);
    // Solved, not typed: the value the sheet stores is only what the panel shows, and never read.
    expect(doc.params.find((p) => p.name === 'out_share')?.value).toBe(0.5);
    for (const start of [0.3, 0.7]) {
      const other = runSheet(withParams(doc, { out_share: start }), table, undefined, REFS);
      expect([start, other.values.out_share]).toEqual([start, v.out_share]);
    }
    // With the second stage at the mirror's diode drop the two levels are one and the split is
    // even, to the table's resolution.
    const matched = runSheet(withParams(doc, { gm_id_s2: 8 }), table, undefined, REFS);
    expect(matched.values.out_share).toBeCloseTo(0.5, 4);
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
    expect(relErr(v.V_tail, vTail)).toBeLessThan(1e-3);
    // The level follows the second stage and nothing else: at gm/ID 8 the second stage needs the
    // mirror's own diode drop, and the two levels become one.
    const level = runSheet(withParams(doc, { gm_id_s2: 8 }), table, undefined, REFS);
    expect(relErr(level.values.V1, V_MIR)).toBeLessThan(1e-3);
    expect(relErr(level.values.V_mir, V_MIR)).toBeLessThan(1e-3);
  });

  it('the mirror output device misses its diode-side partner by the drain-voltage ratio', () => {
    // The stage-1 output sits 101 mV above the mirror node, so the mirror's output device has
    // less drain-source voltage than its diode device and delivers 3.19 % less. Compared as an
    // error: 1e-2 of it is about 1 mV of drain voltage.
    expect(relErr(v.ld1o__id / block(res, 'ld1').id - 1, R_LD - 1)).toBeLessThan(1e-2);
  });

  it('the systematic offset is the difference of the two input gate-source voltages at rest', () => {
    // The diode-side input device carries 3.3 % more current at a drain 101 mV lower, and in the
    // model that takes 5.29 mV more gate-source voltage. The row reads the difference directly.
    expect(v.vos_sys).toBe(Math.abs(v.in__vgs - v.ino__vgs));
    expect(v.in__vgs).toBeGreaterThan(v.ino__vgs);
    expect(relErr(v.vos_sys, delta)).toBeLessThan(1e-2);
    // The check reads that row against its budget of 1 mV. It advises and never gates: the sheet
    // is feasible with the offset five times over.
    expect(statusOf(res, 'systematic-offset')).toBe('fail');
    expect(res.checks.find((c) => c.id === 'systematic-offset')?.lhsValue).toBe(v.vos_sys);
    expect(res.feasible).toBe(true);
    // With the second stage at the mirror's diode drop the two sides sit at one set of levels and
    // carry one current, and the check passes.
    const matched = runSheet(withParams(doc, { gm_id_s2: 8 }), table, undefined, REFS);
    expect(matched.values.vos_sys).toBeLessThan(v.vos_sys / 100);
    expect(statusOf(matched, 'systematic-offset')).toBe('pass');
  });

  it('bandwidth and slew follow what the first stage delivers; the RHP zero is the second stage’s', () => {
    // I_o·(gm/ID_in + 12)/2 = 9.043 µA × 11.86 = 107.28 µS.
    expect(relErr(v.gm1, gm1)).toBeLessThan(1e-3);
    expect(relErr(v.GBW, gm1 / (2 * Math.PI * CC))).toBeLessThan(1e-3);
    // The stage-1 limit binds: 18.38 µA into 3 pF is slower than 60 µA into 5 pF.
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
    // The pair's output-side device carries I_o at vds = V1 − V_tail, so its gds is I_o over
    // (VA + that). The mirror's output device copies its diode side's saturation current and
    // gds = idSat/VA in the demo model, so its gds is the diode side's I_r over (VA + vgs(8)) —
    // the drain voltage it sits at cancels. Av1 = 107.28 µS/(3.008 + 2.948 µS) = 19.06.
    const gdsOut = gdsOf(iOut, L05, V_1 - vTail) + gdsOf(iIn, L05, VGS_GMID8_L05);
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

  it('every device the design needs saturated says so, and a common mode that starves the tail is refused', () => {
    // The tail, the pair, the mirror's output device, the second stage and its load; the two
    // diode-connected devices cannot declare one.
    expect(declaredSaturated(resolveSheetRefs(doc, REFS).doc)).toEqual([
      'tail',
      's2',
      'ld1o',
      'ino',
      'in',
      'ld2',
    ]);
    // The tail device shares its reference's gate, so its saturation voltage is the reference's:
    // 0.358608 − vdsat(vgs(10)) = 0.123 V of headroom at the default common mode.
    expect(relErr(v.tail_headroom, vTail - vdsatDemo(VGS_GMID10_L05, L05))).toBeLessThan(1e-2);
    expect(relErr(v.tail_headroom, v.V_tail - v.tail__vdsat)).toBeLessThan(1e-12);
    expect(regionOf(res, 'tail').status).toBe('pass');
    // A common mode of 0.75 V leaves the tail node about 0.15 V, under the tail device's 0.235 V.
    // The declaration is a physical check, so the sheet is no longer feasible.
    const low = runSheet(withParams(doc, { CM_dc: 0.75 }), table, undefined, REFS);
    expect(low.values.tail_headroom).toBeLessThan(0);
    expect(regionOf(low, 'tail').status).toBe('fail');
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
    // 18.38 µA + 60 µA. The reference branch is shared bias and is not counted.
    expect(relErr(v.I_q, iTail + I2)).toBeLessThan(1e-3);
    expect(relErr(v.I_q, v.tail__id + I2)).toBeLessThan(1e-12);
  });

  it('held at another condition, the first stage follows its tail and the stage-1 output still balances', () => {
    // Every width is the sized one. The reference keeps the current it is programmed to, so at
    // half the current density it needs a higher gate voltage, and the tail device follows it
    // there instead of being handed 20 µA. The second stage keeps its own programmed current, so
    // its gate — the stage-1 output — moves with its own device.
    const [s, h] = sizedAndHeld(doc);
    for (const name of ['bias', 'tail', 'ld1', 's2', 'ld1o', 'ino', 'in', 'ld2'])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    expect(block(h, 'bias').id).toBe(I1);
    expect(block(h, 's2').id).toBe(I2);
    expect(block(h, 'bias').vgs).toBeGreaterThan(block(s, 'bias').vgs);
    for (const [tied, partner] of [
      ['tail', 'bias'],
      ['ld1o', 'ld1'],
    ])
      expect([tied, relErr(block(h, tied).vgs, block(h, partner).vgs) < 1e-12]).toEqual([
        tied,
        true,
      ]);
    expect(h.values.tail__id).toBeLessThan(s.values.tail__id);
    // The split is solved again here, on the held widths: the stage-1 output balances to the
    // solve's tolerance, and the two input devices carry what the tail delivers between them.
    const hv = h.values;
    expect(relErr(hv.ino__id, hv.ld1o__id)).toBeLessThan(1e-6);
    expect(relErr(hv.in__id + hv.ino__id, hv.tail__id)).toBeLessThan(1e-12);
    expect(relErr(block(h, 'ld1').id, hv.in__id)).toBeLessThan(1e-12);
    // Every tie is the same closed form, read at this condition's voltages: scaling the current
    // column by a constant leaves its (VA + vds) dependence alone.
    const tail = (VA05 + hv.V_tail) / (VA05 + block(h, 'bias').vgs);
    const mirror = (VA05 + block(h, 's2').vgs) / (VA05 + block(h, 'ld1').vgs);
    expect(relErr(1 - hv.tail__id / I1, 1 - tail)).toBeLessThan(1e-2);
    expect(relErr(hv.ld1o__id / block(h, 'ld1').id - 1, mirror - 1)).toBeLessThan(1e-2);
    expect(relErr(hv.out_share - 0.5, mirror / (1 + mirror) - 0.5)).toBeLessThan(1e-2);
    expect(hv.vos_sys).toBe(Math.abs(hv.in__vgs - hv.ino__vgs));
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
  // diode-side one stated at V_casc = 0.25 V; the bias reference is programmed to I1 at gm/ID 14.
  // The first stage is drawn at rest, as on the Miller sheet: the current law at the stage-1
  // output fixes the split (the output-side cascode passes up what the mirror's output device
  // returns, R_LD times the diode side's current), and the input devices are one width carrying
  // their own currents at their own gate-source voltages. Each input device's drain is its own
  // cascode's source:
  //   diode side   V_A = V_mir − V_casc = 1.131958 − 0.25 = 0.881958 V
  //   output side  V_X, where the output-side cascode, carrying R_LD times its partner's current
  //                with its drain at V1 instead of the mirror node, needs the gate voltage the two
  //                cascodes share. The model's current law puts it at 0.887430 V, 5.5 mV above V_A.
  // With the drains that close, the offset is almost all the current ratio: 2.87 mV.
  //   tail node    (CM_dc − vgs(12) − Δ/2)/1.2 = 0.359619 V
  //   tail         20 µA × (2.5 + 0.359619)/(2.5 + 0.532095) = 18.862 µA
  const gm2 = 12 * I2;
  const V_A = V_MIR - 0.25;
  const share = R_LD / (1 + R_LD);
  let vX = V_A;
  let vTail = V_TAIL;
  let delta = 0;
  for (let i = 0; i < 50; i++) {
    const cascRatio = (R_LD * (VA05 + 0.25)) / (VA05 + V_1 - vX);
    vX = V_A - (vgsForCurrentRatio(VGS_GMID10_L05, cascRatio) - VGS_GMID10_L05) / 1.2;
    const ratio = ((1 / R_LD) * (VA05 + vX - vTail)) / (VA05 + V_A - vTail);
    delta = vgsForCurrentRatio(VGS_GMID12_L05, ratio) - VGS_GMID12_L05;
    vTail = sourceNodeUnder(1.0 - delta / 2, VGS_GMID12_L05);
  }
  const iTail = (I1 * (VA05 + vTail)) / (VA05 + VGS_GMID14_L05);
  const iOut = iTail * share;
  const iIn = iTail - iOut;
  const gm1 = (iOut * (gmIdDemo(VGS_GMID12_L05 + delta) + 12)) / 2;

  it('one first-stage current is typed, into the bias reference, and every tie is one gate wire', () => {
    // The programmed current goes into the bias reference and nowhere else; the mirror's diode
    // device and the cascode and input device under it carry the diode side's share of what the
    // tail delivers, and the output-side input device the rest.
    expect(block(res, 'bias').id).toBe(I1);
    expect(relErr(block(res, 'ino').id, v.tail__id * v.out_share)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'in').id, v.tail__id * (1 - v.out_share))).toBeLessThan(1e-12);
    expect(relErr(block(res, 'ld1').id, v.in__id)).toBeLessThan(1e-12);
    expect(block(res, 'casc').id).toBe(v.in__id);
    expect(block(res, 's2').id).toBe(I2);
    // The output-side cascode is in one branch with the input device under it and is handed
    // that device's current, to the last bit.
    expect(block(res, 'casco').id).toBe(v.ino__id);
    for (const [tied, partner] of [
      ['tail', 'bias'],
      ['ld1o', 'ld1'],
      ['in', 'ino'],
      ['casco', 'casc'],
    ])
      expect([tied, block(res, tied).W]).toEqual([tied, block(res, partner).W]);
    for (const [tied, partner] of [
      ['tail', 'bias'],
      ['ld1o', 'ld1'],
    ])
      expect([tied, relErr(block(res, tied).vgs, block(res, partner).vgs) < 1e-12]).toEqual([
        tied,
        true,
      ]);
    expect(doc.blocks!.find((u) => u.name === 'in')!.doc!.givens).toMatchObject({
      W: 'Wx',
      id: 'Ix',
    });
  });

  it('the tail misses its reference, and the split is solved so the stage-1 output balances', () => {
    // The tail node (0.360 V) sits below the reference's diode drop (vgs(14) = 0.532 V).
    expect(relErr(v.V_tail, vTail)).toBeLessThan(1e-3);
    expect(relErr(1 - v.tail__id / I1, 1 - iTail / I1)).toBeLessThan(1e-2);
    // What the output-side cascode passes up is what the mirror's output device returns, to the
    // solve's tolerance; the two input devices add up to what the tail delivers by construction.
    expect(relErr(v.ino__id, v.ld1o__id)).toBeLessThan(1e-6);
    expect(relErr(v.in__id + v.ino__id, v.tail__id)).toBeLessThan(1e-12);
    expect(doc.params.find((p) => p.name === 'out_share')?.designConstraint).toEqual({
      lhs: 'ino__id',
      rhs: 'ld1o__id',
    });
    expect(relErr(v.out_share - 0.5, share - 0.5)).toBeLessThan(1e-2);
    expect(relErr(v.ino__id, iOut)).toBeLessThan(1e-3);
    for (const start of [0.3, 0.7]) {
      const other = runSheet(withParams(doc, { out_share: start }), table, undefined, REFS);
      expect([start, relErr(other.values.out_share, v.out_share) < 1e-9]).toEqual([start, true]);
    }
    expect(doc.equations.map((e) => e.name)).not.toContain('pair_residual');
    expect(doc.equations.map((e) => e.name)).not.toContain('pair_split');
  });

  it('the two cascodes share one gate, and the node under the output-side one is solved to it', () => {
    // The diode-side cascode's gate is what the sheet holds: its source, V_casc below the mirror
    // node, plus its gate-source voltage. The output-side cascode's source is solved until its
    // own gate lands on the same voltage, to the solve's microvolt.
    const gate = block(res, 'casc').bias!.vsb! + block(res, 'casc').vgs;
    expect(relErr(res.held!.V_casc, gate)).toBeLessThan(1e-9);
    expect(block(res, 'casco').bias!.vsb! + block(res, 'casco').vgs).toBeCloseTo(gate, 5);
    const x = v.V1 - v.V_casco;
    expect(block(res, 'casco').bias!.vsb).toBeCloseTo(x, 9);
    expect(block(res, 'casco').bias!.vds).toBeCloseTo(v.V_casco, 9);
    expect(block(res, 'ino').bias!.vds).toBeCloseTo(x - v.V_tail, 9);
    expect(block(res, 'in').bias!.vds).toBeCloseTo(v.V_mir - 0.25 - v.V_tail, 9);
    // Where it lands: the model's closed form, 5.5 mV above the diode-side cascode's source, to
    // within 3 % of that rise (the node's own move reads the table between two body-bias points).
    expect(relErr(x - V_A, vX - V_A)).toBeLessThan(3e-2);
  });

  it('the systematic offset is the difference of the two input gate-source voltages at rest', () => {
    // The diode-side input device carries 1/R_LD of its partner's current at a drain 5.5 mV lower:
    // 2.87 mV more gate-source voltage. The cascodes hold the two drains so close that the
    // current ratio is nearly all of it — the mirror's 1/R_LD alone, at equal drains, is 95 % of
    // the row.
    expect(v.vos_sys).toBe(Math.abs(v.in__vgs - v.ino__vgs));
    expect(v.in__vgs).toBeGreaterThan(v.ino__vgs);
    expect(relErr(v.vos_sys, delta)).toBeLessThan(1e-2);
    const mirrorAlone = vgsForCurrentRatio(VGS_GMID12_L05, 1 / R_LD) - VGS_GMID12_L05;
    expect(relErr(v.vos_sys, mirrorAlone)).toBeLessThan(0.06);
    expect(mirrorAlone).toBeLessThan(v.vos_sys);
    expect(statusOf(res, 'systematic-offset')).toBe('fail');
    expect(res.checks.find((c) => c.id === 'systematic-offset')?.lhsValue).toBe(v.vos_sys);
    expect(res.feasible).toBe(true);
    // With the second stage at the mirror's diode drop the two sides sit at one set of levels:
    // the output-side cascode's source lands on the diode side's and nothing is missing.
    const matched = runSheet(withParams(doc, { gm_id_s2: 8 }), table, undefined, REFS);
    expect(matched.values.V_casco).toBeCloseTo(0.25, 4);
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
    // The stage-1 slew limit is what the tail delivers into Cc: 18.86 µA into 3 pF is slower than
    // 60 µA into 5 pF.
    expect(relErr(v.SR, Math.min(iTail / CC, I2 / C_LOAD))).toBeLessThan(1e-3);
    expect(relErr(v.SR, v.tail__id / CC)).toBeLessThan(1e-12);
  });

  it('stage-1 gain reads the two conductances on the output side', () => {
    // The output-side input device carries I_o at vds = V_X − V_tail; the mirror's output device
    // copies its diode side's saturation current, so its gds is I_r over (VA + vgs(8)).
    const gdsOut = gdsOf(iOut, L05, vX - vTail) + gdsOf(iIn, L05, VGS_GMID8_L05);
    expect(relErr(v.Av1, gm1 / gdsOut)).toBeLessThan(1e-3);
    expect(relErr(v.Av1, v.gm1 / (v.ino__gds + v.ld1o__gds))).toBeLessThan(1e-12);
  });

  it('the compensation returns through the output-side cascode', () => {
    // That cascode carries the output side's current, R_LD = 0.968 times its partner's, at a little
    // less overdrive, so its gm sits between R_LD times its partner's and its partner's.
    expect(relErr(v.casc__gm, 10 * v.in__id)).toBeLessThan(1e-9);
    expect(v.gm_casc).toBeGreaterThan(R_LD * v.casc__gm);
    expect(v.gm_casc).toBeLessThan(v.casc__gm);
  });

  it('phase margin has no RHP-zero term (cascode compensation removes it)', () => {
    expect(relErr(v.PM, pmOf(gm1))).toBeLessThan(1e-3);
    expect(relErr(v.PM, pmOf(v.gm1))).toBeLessThan(1e-9);
  });

  it('every device the design needs saturated says so', () => {
    // The tail, both input devices, both cascodes, the mirror's output device, the second stage
    // and its load. The diode-side cascode is held at the 0.25 V the sheet states, 15 mV above its
    // saturation voltage on this table; 0.2 V takes it out, and its declaration says so.
    expect(declaredSaturated(resolveSheetRefs(doc, REFS).doc)).toEqual([
      'tail',
      's2',
      'ld1o',
      'ino',
      'in',
      'casc',
      'casco',
      'ld2',
    ]);
    expect(relErr(regionOf(res, 'casc').lhsValue!, 0.25)).toBeLessThan(1e-12);
    expect(regionOf(res, 'casco').lhsValue).toBe(v.V_casco);
    for (const name of ['casc', 'casco', 'tail'])
      expect([name, regionOf(res, name).status]).toEqual([name, 'pass']);
    const starved = runSheet(withParams(doc, { V_casc: 0.2 }), table, undefined, REFS);
    expect(hardFailsIn(starved)).toContain('casc.region');
  });

  it('the output interface is that same node, named, plus the input gate', () => {
    expect(relErr(v.Rout, stage2Rout(I2, L05, 0.9))).toBeLessThan(1e-9);
    expect(relErr(v.Av2, gm2 * v.Rout)).toBeLessThan(1e-12);
    // Composition golden on cgg_in: one input device, per input terminal, at the width the
    // sizing landed on. The two input devices share that width, so they present the same gate.
    expect(v.cgg_in).toBe(v.in__cgg);
    expect(relErr(v.cgg_in, cggOf(block(res, 'ino').W, L05))).toBeLessThan(1e-9);
    // Cascode compensation changes where the compensation current flows, not what the two
    // branches draw: what the tail delivers plus the 60 µA output branch. The reference branch is
    // shared bias and is not counted.
    expect(relErr(v.I_q, iTail + I2)).toBeLessThan(1e-3);
    expect(relErr(v.I_q, v.tail__id + I2)).toBeLessThan(1e-12);
  });

  it('held at another condition, the tail node, the split and both cascode nodes are solved again', () => {
    // Every width is the sized one and the cascode gate stays where the design put it. The
    // diode-side cascode's node, the tail node, the split and the output-side cascode's node read
    // one another, and are settled together; the stage-1 output still balances, and the two
    // cascodes still share that gate.
    const [s, h] = sizedAndHeld(doc);
    for (const name of ['bias', 'tail', 'ld1', 's2', 'ld1o', 'ino', 'in', 'casc', 'casco', 'ld2'])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    const gate = s.held!.V_casc;
    expect(block(h, 'casc').bias!.vsb! + block(h, 'casc').vgs).toBeCloseTo(gate, 5);
    expect(block(h, 'casco').bias!.vsb! + block(h, 'casco').vgs).toBeCloseTo(gate, 5);
    expect(h.values.V_casc).not.toBeCloseTo(s.values.V_casc, 3);
    expect(block(h, 'casco').id).toBe(h.values.ino__id);
    expect(relErr(h.values.ino__id, h.values.ld1o__id)).toBeLessThan(1e-6);
    expect(relErr(h.values.in__id + h.values.ino__id, h.values.tail__id)).toBeLessThan(1e-12);
    expect(h.values.tail__id).toBeLessThan(s.values.tail__id);
    expect(relErr(block(h, 'ld1o').vgs, block(h, 'ld1').vgs)).toBeLessThan(1e-12);
    const mirror = (VA05 + block(h, 's2').vgs) / (VA05 + block(h, 'ld1').vgs);
    expect(relErr(h.values.ld1o__id / block(h, 'ld1').id - 1, mirror - 1)).toBeLessThan(1e-2);
    expect(h.values.vos_sys).toBe(Math.abs(h.values.in__vgs - h.values.ino__vgs));
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
  const doc = sheet('fd-telescopic-ota');
  const res = runSheet(doc, table);
  // Defaults: the bias reference programmed to I_tail = 40 µA at gm/ID 8, the tail device on its
  // gate with its drain on the tail node V_s; gm/ID in 12, casc/load 8, all L 0.5 µm. Node levels
  // V_s 0.32, V_a 0.55, V_out 0.95, V_b 1.30, VDD 1.8. Each side carries half of what the tail
  // delivers:
  //   tail device  (2.5 + 0.32)/(2.5 + 0.668042) = 0.890140, so each side carries 17.803 µA
  const va = VA_PER_L * 0.5e-6;
  const I_TAIL = 40e-6;
  const iSide = (I_TAIL / 2) * ((va + 0.32) / (va + VGS_GMID8_L05));
  const gmIn = 12 * iSide;

  it('one current is typed, into the bias reference, and the tail is on its gate', () => {
    expect(block(res, 'bias').id).toBe(I_TAIL);
    expect(res.values.tail__id).toBe(2 * block(res, 'in').id);
    for (const name of ['cascn', 'cascp', 'load'])
      expect([name, block(res, name).id]).toEqual([name, block(res, 'in').id]);
    expect(block(res, 'tail').W).toBe(block(res, 'bias').W);
    expect(relErr(block(res, 'tail').vgs, block(res, 'bias').vgs)).toBeLessThan(1e-12);
    expect(block(res, 'tail').bias?.vds).toBe(0.32);
    // The tail node sits below the reference's diode drop, so the tail under-delivers by
    // 1 − 0.890140 = 10.99 %. Compared as an error; 1e-2 of it is 3.5 mV of drain voltage.
    expect(relErr(1 - res.values.tail__id / I_TAIL, 1 - (2 * iSide) / I_TAIL)).toBeLessThan(1e-2);
  });

  it('the cascoded gain matches gm_in·(Rdown ∥ Rup) from the branch closed forms', () => {
    // Every device in a side carries the same current, so it cancels out of the gain.
    const gdsIn = gdsOf(iSide, 0.5e-6, 0.55 - 0.32);
    const av0cascn = 8 * (va + (0.95 - 0.55));
    const gdsLoad = gdsOf(iSide, 0.5e-6, 1.8 - 1.3);
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

  it('the supply-current line item is what the tail delivers plus the CMFB budget', () => {
    // 35.606 µA + 10 µA. The reference branch is shared bias and is not counted.
    expect(relErr(res.values.I_q, 2 * iSide + 10e-6)).toBeLessThan(1e-3);
    expect(relErr(res.values.I_q, res.values.tail__id + 10e-6)).toBeLessThan(1e-12);
  });

  it('input noise counts both input devices and both load current sources', () => {
    // Each device's thermal density is sqrt(4kTγ/gm). A load's noise current reaches the output
    // in full, so it is referred to the input by gm_load/gm_in: the two sides together give
    // 2·4kTγ/gm_in·(1 + gm_load/gm_in). The load runs at gm/ID 8 on the side's current against
    // the pair's 12, so the loads raise the pair's own density by sqrt(1 + 2/3) = 1.29.
    const gmLoad = 8 * iSide;
    const vn = Math.sqrt(2 * (vnthM(gmIn) ** 2 + (vnthM(gmLoad) * (gmLoad / gmIn)) ** 2));
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(1e-3);
    expect(relErr(res.values.vn_in, Math.SQRT2 * vnthM(gmIn) * Math.sqrt(1 + 8 / 12))).toBeLessThan(
      1e-3,
    );
    // The load term follows the load: at a lower gm/ID its gm, and its share, both fall.
    const quiet = runSheet(withParams(doc, { gm_id_load: 4 }), table);
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

  it('every device in the stack declares that it must stay saturated', () => {
    expect(declaredSaturated(doc)).toEqual(['tail', 'in', 'cascn', 'cascp', 'load']);
    const across = {
      tail: 0.32,
      in: 0.55 - 0.32,
      cascn: 0.95 - 0.55,
      cascp: 1.3 - 0.95,
      load: 0.5,
    };
    for (const [name, vds] of Object.entries(across)) {
      const c = regionOf(res, name);
      expect([name, c.kind, c.status]).toEqual([name, 'physical', 'pass']);
      expect([name, relErr(c.lhsValue!, vds) < 1e-9]).toEqual([name, true]);
    }
    // A tail node 0.1 V lower leaves the tail device short of its 0.293 V saturation voltage.
    expect(hardFailsIn(runSheet(withParams(doc, { V_s: 0.22 }), table))).toContain('tail.region');
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
    // The tail declares that it must stay saturated: a physical check on the tail device, the
    // tail node against the same saturation voltage.
    expect(regionOf(res, 'tail').status).toBe('pass');
    expect(regionOf(res, 'tail').lhsValue).toBe(v.V_tail);
    // A common mode of 0.75 V leaves the tail node (0.75 − 0.567023)/1.2 = 0.152 V, under the
    // tail device's 0.235 V. The declaration is physical, so the sheet is no longer feasible.
    const low = runSheet(withParams(doc, { CM_dc: 0.75 }), table, undefined, REFS);
    expect(low.values.tail_headroom).toBeLessThan(0);
    expect(regionOf(low, 'tail').status).toBe('fail');
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
