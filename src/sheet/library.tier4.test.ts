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
//   - The phase-margin rows are the sheet's own arctan estimate recomputed here from the
//     exact gm values.

import { describe, it, expect } from 'vitest';
import { PHYS } from '../constants';
import { runSheet } from './index';
import { table, relErr, VA_PER_L, sheet as libSheet, REFS } from './library.fixtures';

const par = (a: number, b: number): number => 1 / (1 / a + 1 / b);

/** Load a multistage sheet document by file basename. */
const sheet = (file: string) => libSheet(`multistage/${file}.json`);

// --- Demo-model closed forms shared across the buffer/output goldens ---
const UT = (PHYS.k * PHYS.T) / PHYS.q;
const vthDemo = (L: number): number => 0.4 + 0.02 * Math.log(L / 0.18e-6 + 1);
const vdsatDemo = (vgs: number, L: number): number => 2 * UT + Math.max(vgs - vthDemo(L), 0);
// Diode vgs from the EKV inversion gm/ID = sigmoid(x)/(n·UT·softplus(x)), n = 1.3, at L = 0.5 µm.
const VGS_GMID8_L05 = 0.668042;
const VGS_GMID10_L05 = 0.610063;

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

  it('phase-margin estimate matches the arctan formula on the exact poles/zero', () => {
    const wc = gm1 / Cc;
    const z = gm2 / Cc;
    const p2 = gm2 / (CL + 0.5e-12);
    const pm = 90 - (Math.atan(wc / p2) * 180) / Math.PI - (Math.atan(wc / z) * 180) / Math.PI;
    expect(relErr(res.values.PM, pm)).toBeLessThan(1e-6);
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
});

describe('tier4 goldens: Super source follower', () => {
  const res = runSheet(sheet('super-source-follower'), table);
  // Defaults: in and fb both 50 µA, gm/ID 10, L 0.5 µm, vds 0.6 V.
  const gmIn = 10 * 50e-6;

  it('input transconductance is exact', () => {
    expect(relErr(res.values.gm_in, gmIn)).toBeLessThan(1e-9);
  });

  it('output resistance is the follower 1/gm reduced by the feedback intrinsic gain', () => {
    // av0_fb = gm_id·(VA+vds) = 10·(2.5+0.6) = 31 (from provided av0, so ~1e-2).
    const av0fb = 10 * (VA_PER_L * 0.5e-6 + 0.6);
    expect(relErr(res.values.Rout, 1 / (gmIn * av0fb))).toBeLessThan(1e-2);
  });

  it('the DC level shift is the input follower vgs', () => {
    expect(relErr(res.values.level_shift, VGS_GMID10_L05)).toBeLessThan(1e-2);
  });
});

describe('tier4 goldens: Flipped voltage follower', () => {
  const res = runSheet(sheet('flipped-voltage-follower'), table);
  // Defaults: in and fb both 50 µA, gm/ID 10, L 0.5 µm, vds 0.6 V.
  const gm = 10 * 50e-6;
  const gdsIn = 50e-6 / (VA_PER_L * 0.5e-6 + 0.6);

  it('output resistance is exact (built only from gm and gds)', () => {
    // Rout = gds_in/(gm_in·gm_fb); no av0, so exact to 1e-9.
    expect(relErr(res.values.Rout, gdsIn / (gm * gm))).toBeLessThan(1e-9);
  });

  it('branch headroom is the two stacked saturation voltages', () => {
    expect(relErr(res.values.headroom, 2 * vdsatDemo(VGS_GMID10_L05, 0.5e-6))).toBeLessThan(1e-2);
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
  });

  it('the supply-current line item adds the CMFB budget exactly', () => {
    expect(relErr(res.values.I_total, 40e-6 + 10e-6)).toBeLessThan(1e-9);
  });

  it('differential swing is twice the range left after four cascode vdsat drops', () => {
    const v12 = vdsatDemo(0.567023, 0.5e-6); // input pair, gm/ID 12
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

  it('the phase-margin estimate matches the arctan formula on the exact poles/zero', () => {
    const wc = gm1 / Cc;
    const z = gm2 / Cc;
    const p2 = gm2 / (CL + 0.5e-12);
    const pm = 90 - (Math.atan(wc / p2) * 180) / Math.PI - (Math.atan(wc / z) * 180) / Math.PI;
    expect(relErr(res.values.PM, pm)).toBeLessThan(1e-6);
  });

  it('total supply current is the two stage-2 branches, the tail, and the CMFB budget', () => {
    expect(relErr(res.values.I_total, 2 * 60e-6 + 20e-6 + 10e-6)).toBeLessThan(1e-9);
    // FD output swing doubles the single-ended range set by the two output vdsats.
    const swing = 2 * (1.8 - vdsatDemo(0.567023, 0.5e-6) - vdsatDemo(VGS_GMID8_L05, 0.5e-6));
    expect(relErr(res.values.swing_diff, swing)).toBeLessThan(1e-2);
  });
});
