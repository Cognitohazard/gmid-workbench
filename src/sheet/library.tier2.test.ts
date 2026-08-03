// Tier 2 golden tests: the mirror/bias sheets under sheets/mirrors-bias. Each sheet's
// numbers are hand-derived from the synthetic EKV demo model's closed forms (never by
// re-running the engine), so a physics or wiring regression in a sheet is caught here,
// while the generic contract (validates, binds, no hard-rule na) is covered by
// library.test.ts running over the same files.
//
// Demo model facts used below:
//  - Early voltage VA = 5e6 * L, so gds/id = 1/(VA + vds) after binding.
//  - gm/ID is drain-voltage independent (the CLM factor cancels), so a bind's vgs and
//    idSat are the same on any vds slice: two mirror devices at the SAME declared vds
//    carry the SAME current density and their ratio error is exactly zero, and two
//    devices at DIFFERENT on-grid vds differ by exactly the CLM ratio
//    (1 + vds_a/VA)/(1 + vds_b/VA).
//  - Supplied bind quantities (id, W) are exact; a width-first W = N*ref__W makes
//    W/ref__W exactly N.
//  - pelgrom_irel scales as 1/sqrt(W*L), so at fixed L and gm/ID a K-times-wider device
//    has exactly 1/sqrt(K) of the reference's current spread.
//  - gmb = BODY_FACTOR*gm at every point, but it rides the interpolated gm curve rather
//    than the bound gm/ID, so rows built on it hold to interpolation order, not to 1e-9.

import { describe, it, expect } from 'vitest';
import { runSheet } from './index';
import { table, relErr, VA_PER_L, gmbOf, sheet as libSheet } from './library.fixtures';

const sheet = (file: string) => libSheet(`mirrors-bias/${file}`);

describe('tier-2 goldens: cascode current mirror', () => {
  const res = runSheet(sheet('cascode-current-mirror.json'), table);
  // Defaults: I_in 20 µA, K = 4, gm/ID 8, L = 1 µm, both mirror devices at vds = 0.7 V.

  it('sizes the output device at exactly K times the reference width', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.W / res.values.ref__W, 4)).toBeLessThan(1e-9);
  });

  it('systematic error is essentially zero: both mirror devices share one vds', () => {
    // The cascode holds the reference and output mirror devices at the same vds — the reference
    // diode's own drop — so their CLM factors match and the ratio error all but vanishes.
    //
    // It is no longer EXACTLY zero, and the reason is worth keeping: the two sides now reach that
    // shared voltage by different routes. The reference is folded onto the vds = vgs diagonal
    // while the output device is sliced at a fixed vds, so they interpolate the same grid
    // differently and disagree in the fifth decimal. The old exact zero came from both sides
    // reading one hand-typed literal, which agreed with itself but not necessarily with the
    // device.
    expect(Math.abs(res.values.sys_err)).toBeLessThan(1e-4);
  });

  it('the K-times-larger output device carries half the reference current spread', () => {
    // pelgrom_irel ∝ 1/sqrt(W·L): W_out = 4·W_ref at the same L ⇒ ratio exactly 1/2.
    expect(relErr(res.values.irel_out / res.values.irel_ref, 0.5)).toBeLessThan(1e-9);
  });
});

describe('tier-2 goldens: wide-swing cascode mirror', () => {
  const res = runSheet(sheet('wide-swing-cascode-mirror.json'), table);
  // Defaults: K = 4, gm/ID 10, L = 1 µm; the wide-swing node is SOLVED to the mirror
  // device's own vdsat plus the 50 mV node_margin, not typed.

  it('solves the node to the saturation knee plus the stated margin', () => {
    expect(res.values.vds_lo).toBeCloseTo(res.values.ref__vdsat + 0.05, 3);
  });

  it('closes at defaults: the corrected compliance floor stays under the V_out default', () => {
    // The compliance floor is the solved node plus the cascode vdsat — the node's real
    // parking spot, not the bare two-vdsat stack. The gm/ID 10 default exists so that this
    // floor clears V_out = 0.6 even on this high-V* device; at gm/ID 8 it does not.
    expect(res.feasible).toBe(true);
    expect(res.values.vds_lo + res.values.casc__vdsat).toBeLessThan(0.6);
  });

  it('sizes the output device at exactly K times the reference width', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.W / res.values.ref__W, 4)).toBeLessThan(1e-9);
  });

  it('systematic error is essentially zero: both mirror devices at the same low node', () => {
    expect(Math.abs(res.values.sys_err)).toBeLessThan(1e-9);
  });

  it('the K-times-larger output device carries half the reference current spread', () => {
    expect(relErr(res.values.irel_out / res.values.irel_ref, 0.5)).toBeLessThan(1e-9);
  });
});

describe('tier-2 goldens: degenerated current mirror', () => {
  const res = runSheet(sheet('degenerated-current-mirror.json'), table);
  // Defaults: I_in 20 µA, K = 1, R_s = 5 kΩ, L = 1 µm, gm/ID 8. The IR drop is
  // I_in·R_s = 0.1 V, so the output transistor sits at vds = 0.9 − 0.1 = 0.8 V and the
  // reference diode at 0.7 V. VA = 5 V.

  it('systematic error is the demo CLM ratio between the two vds points', () => {
    // The reference is diode-connected, so its vds is its own drop rather than a typed estimate;
    // read it from the result and let this test own the CLM model check.
    const va = VA_PER_L * 1e-6;
    const err = (1 + 0.8 / va) / (1 + res.values.ref__vgs / va) - 1;
    expect(relErr(res.values.sys_err, err)).toBeLessThan(1e-2);
  });

  it('binds the output device width-first at K times the reference width', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.W / res.values.ref__W, 1)).toBeLessThan(1e-9);
  });

  it('output resistance is boosted by the local-feedback factor (1 + (gm + gmb)·R_s_out)', () => {
    // (Rout − R_s_out)·gds should equal 1 + (gm + gmb)·(R_s/K); R_s/K = 5 kΩ at K = 1. Both
    // source-referred generators feed back through the resistor.
    const boost = 1 + (res.values.gm + gmbOf(res.values.gm)) * 5000;
    expect(relErr((res.values.Rout - 5000) * res.values.gds, boost)).toBeLessThan(1e-3);
  });
});

describe('tier-2 goldens: Widlar current source', () => {
  const res = runSheet(sheet('widlar-current-source.json'), table);
  // Defaults: I_in 20 µA, I_out 5 µA, R_s 10 kΩ, M_ratio 1, L = 1 µm.

  it('binds the output device exactly at the chosen output current', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.id, 5e-6)).toBeLessThan(1e-9);
  });

  it('sizes the output device at M_ratio times the reference width', () => {
    expect(relErr(res.values.W / res.values.ref__W, 1)).toBeLessThan(1e-9);
  });

  it('the output device steps down: its vgs sits below the reference vgs', () => {
    // Same width, one quarter the current ⇒ lower density ⇒ lower vgs ⇒ positive step.
    expect(res.values.delta_vgs).toBeGreaterThan(0);
  });
});

describe('tier-2 goldens: beta-multiplier bias', () => {
  const res = runSheet(sheet('beta-multiplier-bias.json'), table);
  // Defaults: I_bias 10 µA, K_bm = 4, R_bias 5 kΩ, L = 1 µm, gm/ID 8.

  it('the constant-gm identity is pure param arithmetic', () => {
    // gm_target = (2/R_bias)(1 − 1/√K_bm) = (2/5000)(1 − 1/2) = 2e-4 S.
    const gmTarget = (2 / 5000) * (1 - 1 / Math.sqrt(4));
    expect(relErr(res.values.gm_target, gmTarget)).toBeLessThan(1e-9);
  });

  it('sizes the resistor-side device at K_bm times the diode-device width', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.W / res.values.m1__W, 4)).toBeLessThan(1e-9);
  });

  it('both legs carry the loop current exactly', () => {
    expect(relErr(res.values.id, 10e-6)).toBeLessThan(1e-9);
  });
});

describe('tier-2 goldens: matched mirror bank', () => {
  const res = runSheet(sheet('matched-mirror-bank.json'), table);
  // Defaults: I_unit 10 µA, N_legs = 8, L = 1 µm, gm/ID 8, unit diode at 0.7 V,
  // output rail at 0.9 V. VA = 5 V.

  it('sizes the bank at exactly N_legs unit widths', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.W / res.values.unit__W, 8)).toBeLessThan(1e-9);
  });

  it('full-scale current is N_legs·I_unit scaled by the demo CLM ratio', () => {
    const va = VA_PER_L * 1e-6;
    const iFs = 8 * 10e-6 * ((1 + 0.9 / va) / (1 + 0.7 / va));
    expect(relErr(res.values.I_fs, iFs)).toBeLessThan(1e-2);
  });

  it('accumulated matching grows as sqrt(N_legs) over one leg', () => {
    expect(relErr(res.values.sigma_bank / res.values.sigma_leg, Math.sqrt(8))).toBeLessThan(1e-9);
  });
});
