// Tier 5 goldens: the spec-translation application sheets. These sheets are mostly
// pure algebra over their params (settling counts, kT/C floors, loop-gain budgets),
// with one embedded or bound device where a real transistor is sized. Every number
// below is hand-derived from the same closed form the sheet author wrote (spec rows)
// or from the demo model's exact relations (device rows) — never by re-running the
// engine. The generic contract in library.test.ts already runs these sheets through
// validation + demo evaluation; here we pin the physics.
//
// Demo model relations used: a bound (gm, gm/ID) or (id, gm/ID) pair is EXACT, so
// id = gm/(gm/ID), gm = id·(gm/ID), and gm_id, id, gm, W are reported to 1e-9. The
// DERIVED layer (vstar, ro, av0, vnth_m) is re-evaluated from the interpolated
// operating point the sizer landed on, so those match only to interpolation order
// (~1e-3), exactly like the exemplar goldens. gds/id = 1/(VA + vds) with VA = 5e6·L,
// so the intrinsic gain gm·ro = (gm/ID)·(VA + vds); the gamma-model thermal density is
// vnth_m = sqrt(4kTγ/gm) with γ = GAMMA_DEFAULT.

import { describe, it, expect } from 'vitest';
import { GAMMA_DEFAULT, PHYS } from '../constants';
import { runSheet } from './index';
import { table, relErr, VA_PER_L, vnthM, sheet as libSheet } from './library.fixtures';

const loadSheet = (file: string) => libSheet(`applications/${file}`);

describe('tier5 goldens: SC settling to OTA spec', () => {
  const res = runSheet(loadSheet('sc-settling-to-ota-spec.json'), table);
  // Defaults: T_s 20 ns, eps_s = eps_d = 1e-3, beta 0.5, Cs 2 pF, Cf 0.5 pF, CL 1 pF,
  // V_step 0.5 V, t_slew_frac 0.3, input gm/ID 12.
  const N_tau = Math.log(1 / 1e-3);
  const tau_max = 20e-9 / (2 * N_tau);
  const GBW_req = 1 / (2 * Math.PI * 0.5 * tau_max);
  const CL_eff = 1e-12 + (2e-12 * 0.5e-12) / (2e-12 + 0.5e-12);

  it('translates the settling budget into the OTA requirements', () => {
    expect(relErr(res.values.N_tau, N_tau)).toBeLessThan(1e-9);
    expect(relErr(res.values.GBW_req, GBW_req)).toBeLessThan(1e-9);
    expect(relErr(res.values.A_req, 1 / (0.5 * 1e-3))).toBeLessThan(1e-9);
    expect(relErr(res.values.CL_eff, CL_eff)).toBeLessThan(1e-9);
    expect(relErr(res.values.SR_req, 0.5 / ((0.3 * 20e-9) / 2))).toBeLessThan(1e-9);
  });

  it('sizes the input device so gm meets GBW_req into the effective load', () => {
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(relErr(res.values.in__gm, 2 * Math.PI * GBW_req * CL_eff)).toBeLessThan(1e-9);
    expect(relErr(res.values.in__gm_id, 12)).toBeLessThan(1e-9);
  });
});

describe('tier5 goldens: Track & hold budget', () => {
  const res = runSheet(loadSheet('track-and-hold-budget.json'), table);
  // Defaults: vn target 70 uV, C_s 1 pF, gm/ID 5, W_sw 5 um, eps_settle 1e-3.

  it('sets the kT/C sampling floor from the noise budget', () => {
    expect(relErr(res.values.C_s_min, (PHYS.k * PHYS.T) / 70e-6 ** 2)).toBeLessThan(1e-9);
    expect(relErr(res.values.N_tau_req, Math.log(1 / 1e-3))).toBeLessThan(1e-9);
  });

  it('binds the switch width-first at the chosen inversion', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.W, 5e-6)).toBeLessThan(1e-9);
    expect(relErr(res.values.gm_id, 5)).toBeLessThan(1e-9);
  });
});

describe('tier5 goldens: Gm-C filter pole', () => {
  const res = runSheet(loadSheet('gm-c-filter-pole.json'), table);
  // Defaults: f_c 10 MHz into C_int 2 pF with a 1.2 over-design factor, gm/ID 12,
  // fco_est 8 MHz, band 1 Hz .. 10 MHz. With the corner that close to the band edge the
  // 1/f tail dominates the integral: it contributes fco*ln(f_hi/f_lo) = 1.29e8 against the
  // thermal band's 1e7, so vn_int is about 3.6x what a 50 kHz corner would predict.
  const gm = 2 * Math.PI * 1e7 * 2e-12 * 1.2;
  const vnth_m = vnthM(gm);
  const vn_int = Math.sqrt(vnth_m ** 2 * (1e7 - 1 + 8e6 * Math.log(1e7 / 1)));

  it('pins gm from the cutoff spec and V* from the inversion knob', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    expect(relErr(res.values.gm_id, 12)).toBeLessThan(1e-9);
  });

  it('integrates the thermal floor plus the 1/f tail over the band', () => {
    expect(relErr(res.values.vn_dens, vnth_m)).toBeLessThan(1e-3);
    expect(relErr(res.values.vn_int, vn_int)).toBeLessThan(1e-3);
  });

  it('deliberately misses its own noise budget at the honest flicker corner', () => {
    // The megahertz corner puts the integrated noise about 2.5x past vn_target, and the
    // sheet keeps the tight budget ON PURPOSE: the red advisory is the 1/f tail made
    // visible, the same teaching stance as the inverter's consistency guardrails. The rule
    // is a guardrail, so feasibility is untouched — this locks both halves of that
    // statement so neither edit can be silently "fixed" away.
    const noise = res.rules.find((r) => r.id === 'noise-spec');
    expect(noise?.kind).toBe('guardrail');
    expect(noise?.status).toBe('fail');
    expect(res.feasible).toBe(true);
  });
});

describe('tier5 goldens: LDO (pass device + error amp)', () => {
  const res = runSheet(loadSheet('ldo-pass-device-error-amp.json'), table);
  // Defaults: I_load_max 5 mA at gm/ID 10, L 0.5 um, V_dropout 0.2 V, A_ea 1000.
  const gm_pass = 5e-3 * 10;
  const A_loop = 1000 * 10 * (VA_PER_L * 0.5e-6 + 0.2);

  it('binds the pass device at max load with the dropout as its vds', () => {
    expect(res.bind?.ok).toBe(true);
    expect(res.bind?.bias?.vds).toBe(0.2);
    expect(relErr(res.values.gm_pass, gm_pass)).toBeLessThan(1e-9);
    expect(relErr(res.values.gm_id, 10)).toBeLessThan(1e-9);
  });

  it('load regulation and DC loop gain follow the demo intrinsic gain', () => {
    expect(relErr(res.values.dVout_dI, 1 / (1000 * gm_pass))).toBeLessThan(1e-9);
    expect(relErr(res.values.A_loop, A_loop)).toBeLessThan(1e-3);
  });
});

describe('tier5 goldens: StrongARM comparator', () => {
  const res = runSheet(loadSheet('strongarm-comparator.json'), table);
  // Defaults: C_int 20 fF, dV_int 0.2 V, I_int 20 uA, gm/ID 12, gm_latch_est 1 mS.

  it('integration time and regeneration constant are pure algebra', () => {
    expect(relErr(res.values.t_int, (2e-14 * 0.2) / 2e-5)).toBeLessThan(1e-9);
    expect(relErr(res.values.tau_reg, 2e-14 / 1e-3)).toBeLessThan(1e-9);
    expect(relErr(res.values.gm_id, 12)).toBeLessThan(1e-9);
  });

  it('integration-phase noise is the kT/C thermal floor', () => {
    expect(
      relErr(res.values.sigma_n, Math.sqrt((2 * PHYS.k * PHYS.T * GAMMA_DEFAULT) / 2e-14)),
    ).toBeLessThan(1e-9);
  });
});

describe('tier5 goldens: Preamp + latch comparator', () => {
  const res = runSheet(loadSheet('preamp-latch-comparator.json'), table);
  // Defaults: I_pre 50 uA at gm/ID 15, L 0.5 um, vds 0.6 V, R_L 20 kohm, C_p 50 fF.
  const gm = 5e-5 * 15;
  const ro = (VA_PER_L * 0.5e-6 + 0.6) / 5e-5;
  const Rout = 1 / (1 / 2e4 + 1 / ro);

  it('binds the preamp and reports gm and gm/ID exactly', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    expect(relErr(res.values.gm_id, 15)).toBeLessThan(1e-9);
  });

  it('gain and recovery delay both track the same output resistance', () => {
    expect(relErr(res.values.A_pre, gm * Rout)).toBeLessThan(1e-3);
    expect(relErr(res.values.tau_pre, Rout * 5e-14)).toBeLessThan(1e-3);
  });
});
