// Tier-4 golden tests: multi-stage and buffer sheets under sheets/multistage/.
// Each number here is hand-derived from the synthetic EKV demo model's closed forms
// (never by re-running the engine):
//
//   - Bound quantities are EXACT: with a gm/ID + ID bind the sizer sets gm = gm/ID·ID
//     and reports ID exactly, so gm1, gm2, GBW = gm1/(2π·Cc), z = gm2/Cc, and the slew
//     limits pin to 1e-9.
//   - Output conductance is EXACT in the demo: gds = ID/(VA + vds) with VA = 5e6·L,
//     independent of the found vgs. So a gain built only from gm and gds (Av2, the FVF
//     output resistance) is exact too.
//   - Intrinsic gain av0 = gm/gds is reported from the INTERPOLATED gm (before the bind
//     overwrites gm), so any gain built on a provided av0 (the SSF/telescopic output
//     resistances) carries the demo grid's ~1e-4 interpolation error — those assert at 1e-2.
//   - vdsat and diode vgs come from the EKV inversion (noted constants), so swing/level
//     rows assert at 1e-2.
//   - gmb = BODY_FACTOR·gm at every point, but like av0 it rides the interpolated gm, so
//     rows built on it assert at interpolation order rather than at 1e-9.
//   - The phase-margin rows are the sheet's own arctan estimate recomputed here from the
//     exact gm values.

import { describe, it, expect } from 'vitest';
import { PHYS } from '../constants';
import { runSheet } from './index';
import {
  table,
  relErr,
  VA_PER_L,
  gmbOf,
  sheet as libSheet,
  REFS,
  VGS_GMID8_L05,
  VGS_GMID10_L05,
  VGS_GMID12_L05,
  cggOf,
  par,
  stage2Rout,
} from './library.fixtures';

/** Load a multistage sheet document by file basename. */
const sheet = (file: string) => libSheet(`multistage/${file}.json`);

// --- Demo-model closed forms shared across the buffer/output goldens ---
const UT = (PHYS.k * PHYS.T) / PHYS.q;
const vthDemo = (L: number): number => 0.4 + 0.02 * Math.log(L / 0.18e-6 + 1);
const vdsatDemo = (vgs: number, L: number): number => 2 * UT + Math.max(vgs - vthDemo(L), 0);

describe('tier4 goldens: Two-stage Miller OTA', () => {
  const res = runSheet(sheet('two-stage-miller-ota'), table, undefined, REFS);
  // Defaults: I1 20 µA, I2 60 µA, Cc 3 pF, CL 5 pF, C1_est 0.5 pF, gm/ID in 12, s2 12,
  // ld2 8, all L 0.5 µm, V_out2 0.9 V.
  const gm1 = 12 * (20e-6 / 2);
  const gm2 = 12 * 60e-6;
  const Cc = 3e-12;
  const CL = 5e-12;
  const va = VA_PER_L * 0.5e-6;

  it('bandwidth, RHP zero, and slew pin exactly to the bound transconductances', () => {
    expect(relErr(res.values.GBW, gm1 / (2 * Math.PI * Cc))).toBeLessThan(1e-9);
    expect(relErr(res.values.z_rhp, gm2 / Cc)).toBeLessThan(1e-9);
    expect(relErr(res.values.SR, Math.min(20e-6 / Cc, 60e-6 / CL))).toBeLessThan(1e-9);
  });

  it('stage-2 gain is exact from gm and the two gds = I/(VA+vds)', () => {
    // s2 and ld2 both carry 60 µA at |vds| = 0.9 V, L 0.5 µm ⇒ gds = 60µ/(VA+0.9) each.
    const av2 = gm2 / (2 * (60e-6 / (va + 0.9)));
    expect(relErr(res.values.Av2, av2)).toBeLessThan(1e-9);
  });

  it('phase-margin estimate is the second pole alone, the nulling resistor having removed the zero', () => {
    // The sheet supplies Rz = 1/gm2, which moves the RHP zero to infinity — so the estimate
    // carries no zero term. Keeping one double-charged the design for a zero it had cancelled.
    const wc = gm1 / Cc;
    const p2 = gm2 / (CL + 0.5e-12);
    const pm = 90 - (Math.atan(wc / p2) * 180) / Math.PI;
    expect(relErr(res.values.PM, pm)).toBeLessThan(1e-6);
  });

  it('the output interface is that same node, named, plus the input gate', () => {
    expect(relErr(res.values.Rout, stage2Rout(60e-6, 0.5e-6, 0.9))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av2, gm2 * res.values.Rout)).toBeLessThan(1e-12);
    // Composition golden on cgg_in: the input child does not expose its sized width, so what is
    // pinned is WHICH gate the row reads — one input device, per input terminal.
    expect(res.values.cgg_in).toBe(res.values.in__cgg);
  });
});

describe('tier4 goldens: Two-stage OTA, cascode compensation', () => {
  const res = runSheet(sheet('two-stage-cascode-comp-ota'), table, undefined, REFS);
  const gm1 = 12 * (20e-6 / 2);
  const gm2 = 12 * 60e-6;
  const Cc = 3e-12;
  const CL = 5e-12;
  const va = VA_PER_L * 0.5e-6;

  it('bandwidth pins exactly and stage-2 gain is exact', () => {
    expect(relErr(res.values.GBW, gm1 / (2 * Math.PI * Cc))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av2, gm2 / (2 * (60e-6 / (va + 0.9))))).toBeLessThan(1e-9);
  });

  it('phase margin has no RHP-zero term (cascode compensation removes it)', () => {
    const wc = gm1 / Cc;
    const p2 = gm2 / (CL + 0.5e-12);
    const pm = 90 - (Math.atan(wc / p2) * 180) / Math.PI;
    expect(relErr(res.values.PM, pm)).toBeLessThan(1e-6);
  });

  it('the output interface is that same node, named, plus the input gate', () => {
    expect(relErr(res.values.Rout, stage2Rout(60e-6, 0.5e-6, 0.9))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av2, gm2 * res.values.Rout)).toBeLessThan(1e-12);
    // Composition golden on cgg_in: the input child does not expose its sized width, so what is
    // pinned is WHICH gate the row reads — one input device, per input terminal.
    expect(res.values.cgg_in).toBe(res.values.in__cgg);
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
  // Defaults: in and fb both 50 µA, gm/ID 10, L 0.5 µm, vds 0.6 V.
  const gmIn = 10 * 50e-6;

  it('input transconductance is exact', () => {
    expect(relErr(res.values.gm_in, gmIn)).toBeLessThan(1e-9);
  });

  it('output resistance is the input device gds divided by both transconductances', () => {
    // The loop senses the INPUT device's drain current, so its gds is the numerator, and the
    // output node is that device's source, so gmb adds to its gm. gds = ID/(VA + vds) is exact.
    const gdsIn = 50e-6 / (VA_PER_L * 0.5e-6 + 0.6);
    const gmFb = 10 * 50e-6;
    expect(relErr(res.values.Rout, gdsIn / ((gmIn + gmbOf(gmIn)) * gmFb))).toBeLessThan(1e-3);
    // Well below the plain follower it replaces — that reduction is the point of the stage.
    expect(res.values.Rout).toBeLessThan(res.values.Rout_plain / 10);
  });

  it('the DC level shift is the input follower vgs', () => {
    expect(relErr(res.values.level_shift, VGS_GMID10_L05)).toBeLessThan(1e-2);
  });

  it('input capacitance is one input gate at the width the bind landed on', () => {
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
    // this asserts at that constant's precision rather than at the bind's 1e-9.
    expect(relErr(res.values.Rout, gdsIn / (gm * gm))).toBeLessThan(1e-5);
    expect(res.values.Rout).toBeLessThan(res.values.Rout_plain / 10);
  });

  it('branch headroom is the two stacked saturation voltages', () => {
    // Unmoved by the node derivation: vdsat is a function of vgs and L in the demo model, and
    // neither device's inversion level changed.
    expect(relErr(res.values.headroom, 2 * vdsatDemo(VGS_GMID10_L05, 0.5e-6))).toBeLessThan(1e-2);
  });

  it('input capacitance is one input gate at the width the bind landed on', () => {
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
    // …and Rout is that same parallel combination, which the gain row already reads through.
    expect(relErr(res.values.Rout, par(av0cascn / gdsIn, av0cascp / gdsLoad))).toBeLessThan(1e-2);
    expect(relErr(res.values.Av, gmIn * res.values.Rout)).toBeLessThan(1e-3);
  });

  it('input capacitance is the gate of one input device', () => {
    // Composition golden: the input child does not expose its sized width, so what is pinned is
    // which gate the row reads — one input device, per input terminal, half-circuit like the
    // gain above.
    expect(res.values.cgg_in).toBe(res.values.in__cgg);
  });

  it('the supply-current line item adds the CMFB budget exactly', () => {
    expect(relErr(res.values.I_total, 40e-6 + 10e-6)).toBeLessThan(1e-9);
  });

  it('differential swing is twice the range left after four cascode vdsat drops', () => {
    const v12 = vdsatDemo(VGS_GMID12_L05, 0.5e-6); // input pair, gm/ID 12
    const v8 = vdsatDemo(VGS_GMID8_L05, 0.5e-6); // cascodes + load, gm/ID 8
    const swing = 2 * (1.8 - v12 - 3 * v8 - 0.3);
    expect(relErr(res.values.swing_diff, swing)).toBeLessThan(1e-2);
  });
});

describe('tier4 goldens: Fully differential two-stage OTA', () => {
  const res = runSheet(sheet('fd-two-stage-ota'), table);
  // Defaults mirror the single-ended Miller OTA; FD adds two stage-2 branches + CMFB.
  const gm1 = 12 * (20e-6 / 2);
  const gm2 = 12 * 60e-6;
  const Cc = 3e-12;
  const CL = 5e-12;

  it('bandwidth, RHP zero, and slew pin exactly to the bound transconductances', () => {
    expect(relErr(res.values.GBW, gm1 / (2 * Math.PI * Cc))).toBeLessThan(1e-9);
    expect(relErr(res.values.z_rhp, gm2 / Cc)).toBeLessThan(1e-9);
    expect(relErr(res.values.SR, Math.min(20e-6 / Cc, 60e-6 / CL))).toBeLessThan(1e-9);
  });

  it('the phase margin costs the second pole only — the nulling resistor removes the zero', () => {
    // Rz = 1/gm2 moves the RHP zero to infinity, so the estimate carries no zero term; z_rhp
    // stays as the uncompensated reference point asserted above.
    const wc = gm1 / Cc;
    const p2 = gm2 / (CL + 0.5e-12);
    const pm = 90 - (Math.atan(wc / p2) * 180) / Math.PI;
    expect(relErr(res.values.PM, pm)).toBeLessThan(1e-6);
  });

  it('the stage-1 output level is what the stage-2 gate needs, not a typed number', () => {
    // V1 is the stage-2 gate, so it sits one stage-2 vgs below the supply: for gm/ID 12 at
    // L 0.5 µm that is 1.8 - 0.567023 = 1.232977 V. Declared wiring on that use restates the
    // same identity, so it agrees to the last digit and reports nothing.
    expect(relErr(res.values.V1, 1.8 - VGS_GMID12_L05)).toBeLessThan(1e-3);
    expect(res.warnings.filter((w) => w.rule === 'sheet-wiring')).toEqual([]);

    // That silence means nothing unless the check is LIVE on this sheet — a declaration this
    // sheet derives its own node from cannot disagree with itself, which is exactly the shape
    // that would hide a check that had quietly stopped running. Re-type the node 100 mV off,
    // the way a hand-typed V1 used to be, and it is reported at once, on the block that owns
    // the gate.
    const doc = sheet('fd-two-stage-ota');
    const v1 = doc.rows.find((r) => r.name === 'V1');
    expect(v1).toBeDefined();
    (v1 as { expr: string }).expr = 'VDD - abs(s2__vgs) + 0.1';
    const off = runSheet(doc, table, undefined, REFS);
    expect(off.warnings.filter((w) => w.rule === 'sheet-wiring').map((w) => w.location)).toEqual([
      's2',
    ]);
  });

  it('the output interface is the stage-2 node, named, plus the input gate', () => {
    expect(relErr(res.values.Rout, stage2Rout(60e-6, 0.5e-6, 0.9))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av2, gm2 * res.values.Rout)).toBeLessThan(1e-12);
    expect(res.values.cgg_in).toBe(res.values.in__cgg);
  });

  it('stage-1 gain follows from the two levels that derived node fixes', () => {
    // The tail is bisected until the produced common mode equals CM_dc = 1.0 V, and the demo
    // vgs depends on neither vds nor body bias, so V_tail = CM_dc - vgs(12) — and the input
    // device's drain-source V1 - V_tail collapses to VDD - CM_dc = 0.8 V, free of the EKV
    // constant. The stage-1 load carries the rest of the supply, VDD - V1 = vgs(12).
    const va = VA_PER_L * 0.5e-6;
    const gdsIn = 10e-6 / (va + (1.8 - 1.0));
    const gdsLd1 = 10e-6 / (va + VGS_GMID12_L05);
    expect(relErr(res.values.Av1, gm1 / (gdsIn + gdsLd1))).toBeLessThan(1e-3);
  });

  it('total supply current is the two stage-2 branches, the tail, and the CMFB budget', () => {
    expect(relErr(res.values.I_total, 2 * 60e-6 + 20e-6 + 10e-6)).toBeLessThan(1e-9);
    // FD output swing doubles the single-ended range set by the two output vdsats.
    const swing = 2 * (1.8 - vdsatDemo(VGS_GMID12_L05, 0.5e-6) - vdsatDemo(VGS_GMID8_L05, 0.5e-6));
    expect(relErr(res.values.swing_diff, swing)).toBeLessThan(1e-2);
  });
});
