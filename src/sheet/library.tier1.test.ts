// Tier 1 golden tests: the eight single-device stage sheets in sheets/stages/.
// Each expected number is hand-derived from the synthetic EKV demo model's closed
// forms (never by re-running the engine): supplied bind quantities are exact (gm =
// gm/ID * id algebra), the Early-voltage model gives gds/id = 1/(VA + vds) exactly
// after binding (VA = VA_PER_L * L), and the thermal density is sqrt(4kTgamma/gm).
// The generic contract in library.test.ts already checks these sheets validate,
// bind, and raise no hard-rule na on the same table; here we pin the physics.

import { describe, it, expect } from 'vitest';
import { PHYS } from '../constants';
import { runSheet } from './index';
import { table, relErr, VA_PER_L, vnthM, sheet as libSheet } from './library.fixtures';

const sheet = (file: string) => libSheet(`stages/${file}`);

describe('tier1 goldens: CS amp, resistive load', () => {
  const res = runSheet(sheet('cs-amp-resistive-load.json'), table);
  // Defaults: GBW 10 MHz into 2 pF, 1.25 over-design, gm/ID 12, L 0.5 um, R_load
  // 50 kohm, V_out 0.9 V. VA = 2.5, so gds = id/(2.5 + 0.9).
  const gm = 2 * Math.PI * 10e6 * 2e-12 * 1.25;
  const id = gm / 12;

  it('binds gm exactly from the spec and derives id', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    expect(relErr(res.values.id, id)).toBeLessThan(1e-9);
  });

  it('gain is gm into the load resistor parallel with 1/gds', () => {
    const gds = id / (VA_PER_L * 0.5e-6 + 0.9);
    const av = gm / (1 / 50e3 + gds);
    expect(relErr(res.values.Av, av)).toBeLessThan(2e-3);
  });

  it('output DC level is VDD minus the load drop', () => {
    expect(relErr(res.values.V_out_actual, 1.8 - id * 50e3)).toBeLessThan(1e-9);
  });
});

describe('tier1 goldens: CS amp, diode-connected load', () => {
  const res = runSheet(sheet('cs-amp-diode-load.json'), table);
  // Input gm from the spec; the load carries the same current (I_load = gm/12), so
  // the transconductance ratio is exactly the gm/ID ratio.
  const gm = 2 * Math.PI * 10e6 * 2e-12 * 1.25;

  it('binds the input gm exactly from the spec', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
  });

  it('input/load transconductance ratio is the gm/ID ratio (equal currents)', () => {
    // gm_in/gm_load = (12*id)/(8*id) = 12/8 exactly.
    expect(relErr(res.values.gm / res.values.load__gm, 12 / 8)).toBeLessThan(1e-9);
  });

  it('input noise is the density scaled by the load contribution', () => {
    const vn = vnthM(gm) * Math.sqrt(1 + 8 / 12);
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(3e-3);
  });
});

describe('tier1 goldens: Source-degenerated CS amp', () => {
  const res = runSheet(sheet('source-degenerated-cs-amp.json'), table);
  // Defaults: I_bias 20 uA, gm/ID 12, R_s 2 kohm. gm = 20u*12 = 240 uS.
  const gm = 20e-6 * 12;
  const Rs = 2e3;

  it('binds gm exactly from the current and gm/ID', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
  });

  it('degenerated transconductance is gm/(1 + gm*R_s)', () => {
    expect(relErr(res.values.Gm, gm / (1 + gm * Rs))).toBeLessThan(1e-9);
  });

  it('input noise adds the 4kT*R_s resistor term to the channel density', () => {
    const vn = Math.sqrt(vnthM(gm) ** 2 + 4 * PHYS.k * PHYS.T * Rs);
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(3e-3);
  });
});

describe('tier1 goldens: Cascode CS amp', () => {
  const res = runSheet(sheet('cascode-cs-amp.json'), table);
  // Defaults: I_bias 20 uA shared, gm/ID in 12 / casc 10 / load 8, all L 0.5 um,
  // V_out 0.9, V_x 0.4. VA = 2.5. vds: in 0.4, casc 0.5, load 0.9.
  const I = 20e-6;
  const VA = VA_PER_L * 0.5e-6;

  it('the cascode device carries the input branch current', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.in__id, I)).toBeLessThan(1e-9);
    expect(relErr(res.values.id, res.values.in__id)).toBeLessThan(1e-12);
  });

  it('cascode intrinsic gain is gm/ID_casc * (VA + vds_casc)', () => {
    expect(relErr(res.values.av0, 10 * (VA + 0.5))).toBeLessThan(2e-3);
  });

  it('gain is the input gm into the full cascoded output resistance', () => {
    const inGm = 12 * I;
    const inGds = I / (VA + 0.4);
    const gdsCasc = I / (VA + 0.5);
    const av0Casc = 10 * (VA + 0.5);
    const RoutCasc = (1 / inGds) * (1 + av0Casc) + 1 / gdsCasc;
    const loadGds = I / (VA + 0.9);
    const Rout = 1 / (1 / RoutCasc + loadGds);
    expect(relErr(res.values.Av, inGm * Rout)).toBeLessThan(2e-3);
  });
});

describe('tier1 goldens: Source follower', () => {
  const res = runSheet(sheet('source-follower.json'), table);
  // Defaults: I_bias 20 uA, gm/ID 12, L 0.5 um, VDD 1.8, V_in 1.2, vgs_est 0.57,
  // R_L 100 kohm. Declared vds = VDD - V_in + vgs_est = 1.17. VA = 2.5.
  const gm = 20e-6 * 12;

  it('binds gm exactly and the follower gain is below unity', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    expect(res.values.Av).toBeLessThan(1);
  });

  it('gain is gm/(gm + gds + 1/R_L)', () => {
    const gds = 20e-6 / (VA_PER_L * 0.5e-6 + (1.8 - 1.2 + 0.57));
    const av = gm / (gm + gds + 1 / 100e3);
    expect(relErr(res.values.Av, av)).toBeLessThan(2e-3);
  });

  it('level-shift-consistent guardrail is green at defaults', () => {
    const g = res.rules.find((r) => r.id === 'level-shift-consistent');
    expect(g && g.status !== 'fail' && g.status !== 'na').toBe(true);
  });
});

describe('tier1 goldens: Common gate', () => {
  const res = runSheet(sheet('common-gate.json'), table);
  // Defaults: I_bias 20 uA, gm/ID 10, L 0.5 um, V_out 0.9, V_in 0.3, R_load 50 kohm.
  // gm = 200 uS, vds = 0.6, VA = 2.5.
  const gm = 20e-6 * 10;

  it('binds gm exactly and Rin = 1/gm', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    expect(relErr(res.values.Rin, 1 / gm)).toBeLessThan(1e-9);
  });

  it('gain is gm into the load resistor parallel with 1/gds', () => {
    const gds = 20e-6 / (VA_PER_L * 0.5e-6 + 0.6);
    const av = gm / (1 / 50e3 + gds);
    expect(relErr(res.values.Av, av)).toBeLessThan(2e-3);
  });
});

describe('tier1 goldens: CMOS inverter amplifier', () => {
  const res = runSheet(sheet('cmos-inverter-amp.json'), table);
  // Defaults: I_bias 20 uA (both devices), gm/ID n 12 / p 10, both L 0.5 um,
  // V_out 0.9. Both vds = 0.9, VA = 2.5.
  const I = 20e-6;

  it('both devices share the same bias current', () => {
    expect(relErr(res.values.n__id, I)).toBeLessThan(1e-9);
    expect(relErr(res.values.p__id, res.values.n__id)).toBeLessThan(1e-12);
  });

  it('combined transconductance is I_bias*(gm/ID_n + gm/ID_p)', () => {
    expect(relErr(res.values.gm_tot, I * (12 + 10))).toBeLessThan(1e-9);
  });

  it('gain is the summed gm into the summed output conductance', () => {
    const gmTot = I * 22;
    const gds = I / (VA_PER_L * 0.5e-6 + 0.9); // same for both: equal L and |vds|
    expect(relErr(res.values.Av, gmTot / (2 * gds))).toBeLessThan(2e-3);
  });
});

describe('tier1 goldens: Sampling switch', () => {
  const res = runSheet(sheet('sampling-switch.json'), table);
  // Defaults: W_sw 10 um, L 0.18 um, gm_id_on 3.5, vds_test 0.05, C_s 1 pF. The
  // width is bound directly, so cgg = W*L*Cox is exact (Cox = 0.01).
  const Wsw = 10e-6;
  const L = 0.18e-6;

  it('gate capacitance is W*L*Cox at the bound width', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.cgg, Wsw * L * 0.01)).toBeLessThan(1e-9);
  });

  it('the width-first bind still lands gm/id at the target gm_id_on', () => {
    expect(relErr(res.values.gm / res.values.id, 3.5)).toBeLessThan(1e-9);
  });

  it('sampled noise is the kT/C RMS voltage', () => {
    expect(relErr(res.values.vn_kTC, Math.sqrt((PHYS.k * PHYS.T) / 1e-12))).toBeLessThan(1e-9);
  });
});
