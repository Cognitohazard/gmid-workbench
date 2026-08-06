// Tier 1 golden tests: the eight single-device stage sheets in sheets/stages/.
// Each expected number is hand-derived from the synthetic EKV demo model's closed
// forms (never by re-running the engine): supplied bind quantities are exact (gm =
// gm/ID * id algebra), the Early-voltage model gives gds/id = 1/(VA + vds) exactly
// after binding (VA = VA_PER_L * L), and the thermal density is sqrt(4kTgamma/gm).
// gmb is BODY_FACTOR*gm at every point of the demo, but unlike gds it rides the
// interpolated gm curve rather than the bound gm/ID, so rows built on it agree with
// the closed form to interpolation order (~1e-3) instead of to the bind's 1e-9.
// The generic contract in library.test.ts already checks these sheets validate,
// bind, and raise no hard-rule na on the same table; here we pin the physics.

import { describe, it, expect } from 'vitest';
import { PHYS } from '../constants';
import { runSheet } from './index';
import {
  table,
  relErr,
  VA_PER_L,
  vnthM,
  gmbOf,
  cggOf,
  par,
  gdsOf,
  stage2Rout,
  sheet as libSheet,
  VGS_GMID8_L05,
} from './library.fixtures';

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
    // Supply current is that derived branch current — an OUTPUT of the sizing here, since the
    // bandwidth spec fixes gm and the inversion choice divides it down.
    expect(relErr(res.values.I_q, id)).toBeLessThan(1e-9);
  });

  it('gain is gm into the load resistor parallel with 1/gds', () => {
    const gds = id / (VA_PER_L * 0.5e-6 + 0.9);
    const av = gm / (1 / 50e3 + gds);
    expect(relErr(res.values.Av, av)).toBeLessThan(2e-3);
  });

  it('output DC level is VDD minus the load drop', () => {
    expect(relErr(res.values.V_out_actual, 1.8 - id * 50e3)).toBeLessThan(1e-9);
  });

  it('the interface rows are the load resistor paralleled with ro, and the gate capacitance', () => {
    // Rout is the inverse of the denominator the gain already used, so Av = gm*Rout is the same
    // number by construction; what this pins is that the row IS that output node. cgg = W*L*Cox
    // exactly in the demo model, at the width the bind landed on.
    const gds = id / (VA_PER_L * 0.5e-6 + 0.9);
    expect(relErr(res.values.Rout, par(50e3, 1 / gds))).toBeLessThan(2e-3);
    expect(relErr(res.values.Av, gm * res.values.Rout)).toBeLessThan(1e-12);
    expect(relErr(res.values.cgg_in, cggOf(res.values.W, 0.5e-6))).toBeLessThan(1e-9);
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
    // The branch current follows from that gm and the inversion choice, and is what the supply
    // pays — the load sits in the same branch and carries no current of its own.
    expect(relErr(res.values.I_q, gm / 12)).toBeLessThan(1e-9);
  });

  it('input/load transconductance ratio is the gm/ID ratio (equal currents)', () => {
    // gm_in/gm_load = (12*id)/(8*id) = 12/8 exactly.
    expect(relErr(res.values.gm / res.values.load__gm, 12 / 8)).toBeLessThan(1e-9);
  });

  it('input noise is the density scaled by the load contribution', () => {
    const vn = vnthM(gm) * Math.sqrt(1 + 8 / 12);
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(3e-3);
  });

  it('the diode load, not the output conductances, sets the output resistance', () => {
    // The load sits on the vds = vgs diagonal at gm/ID 8, so its drop is the fixture constant and
    // the input device sees VDD minus it. Rout carries load__gm, which is ~13x the two gds terms
    // together — the reason a diode load buys so little gain.
    const id = gm / 12;
    const va = VA_PER_L * 0.5e-6;
    const rout = 1 / (8 * id + id / (va + 1.8 - VGS_GMID8_L05) + id / (va + VGS_GMID8_L05));
    expect(relErr(res.values.Rout, rout)).toBeLessThan(2e-3);
    expect(relErr(res.values.Av, gm * res.values.Rout)).toBeLessThan(1e-12);
    expect(relErr(res.values.cgg_in, cggOf(res.values.W, 0.5e-6))).toBeLessThan(1e-9);
  });
});

describe('tier1 goldens: Source-degenerated CS amp', () => {
  const res = runSheet(sheet('source-degenerated-cs-amp.json'), table);
  // Defaults: I_bias 20 uA, gm/ID 12, R_s 2 kohm. gm = 20u*12 = 240 uS, gmb = 48 uS.
  const gm = 20e-6 * 12;
  const gmb = gmbOf(gm);
  const Rs = 2e3;

  it('binds gm exactly from the current and gm/ID', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
  });

  it('the degeneration factor carries both source-referred generators', () => {
    // Both gm and gmb drive current through R_s, so the loop factor is 1 + (gm + gmb)*R_s.
    expect(relErr(res.values.loop, 1 + (gm + gmb) * Rs)).toBeLessThan(1e-3);
    expect(relErr(res.values.Gm, gm / (1 + (gm + gmb) * Rs))).toBeLessThan(1e-3);
  });

  it('input noise adds the 4kT*R_s resistor term to the channel density', () => {
    const vn = Math.sqrt(vnthM(gm) ** 2 + 4 * PHYS.k * PHYS.T * Rs);
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(3e-3);
  });

  it('the output node is the load resistor against the degeneration-boosted device', () => {
    // The source lift I_bias*R_s is the device's own vds offset, so gds is read at 0.86 V.
    const gds = 20e-6 / (VA_PER_L * 0.5e-6 + (0.9 - 20e-6 * Rs));
    const routDev = (1 + (gm + gmb) * Rs) / gds + Rs;
    expect(relErr(res.values.Rout, par(100e3, routDev))).toBeLessThan(1e-3);
    expect(relErr(res.values.Av, res.values.Gm * res.values.Rout)).toBeLessThan(1e-12);
    expect(relErr(res.values.cgg_in, cggOf(res.values.W, 0.5e-6))).toBeLessThan(1e-9);
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

  it('input capacitance is the input device gate, and nothing the cascode adds', () => {
    // Composition golden. The input child does not expose its sized width, so the absolute
    // capacitance has no closed form to check here; what the row must get right is WHICH gate it
    // reads — the driven one at the bottom of the stack, not the cascode's fixed gate above it.
    expect(res.values.cgg_in).toBe(res.values.in__cgg);
  });
});

describe('tier1 goldens: Source follower', () => {
  const res = runSheet(sheet('source-follower.json'), table);
  // Defaults: I_bias 20 uA, gm/ID 12, L 0.5 um, VDD 1.8, V_in 1.2, vgs_est 0.57,
  // R_L 100 kohm. Declared vds = VDD - V_in + vgs_est = 1.17, inside the demo hull.
  const gm = 20e-6 * 12;
  const vds = 1.17;

  it('binds gm exactly and the follower gain is below unity', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    expect(res.values.Av).toBeLessThan(1);
  });

  it('gain is gm/(gm + gds + 1/R_L)', () => {
    const gds = gdsOf(20e-6, 0.5e-6, vds);
    const av = gm / (gm + gds + 1 / 100e3);
    expect(relErr(res.values.Av, av)).toBeLessThan(2e-3);
  });

  it('is self-consistent at defaults: the level-shift guardrail is green with no warnings', () => {
    // The shipped vgs_est is tuned to the bundled demo device (a sky130-like table wants
    // ~0.77 V — the param note records it); the guardrail is the retune loop's readout,
    // so the shipped default must hold it green on the shipped table.
    const g = res.rules.find((r) => r.id === 'level-shift-consistent');
    expect(g?.status).toBe('pass');
    expect(res.feasible).toBe(true);
    expect(res.warnings).toHaveLength(0);
  });

  it('the ten-to-one loading guardrail is the buffering claim, and the load clears it', () => {
    // R_L >= 10*Rout is not an identity: Rout folds 1/R_L in, so the condition reduces to
    // R_L*(gm + gds) >= 9 — about 36.7 kohm here, which the 100 kohm default clears. At exactly
    // ten to one the loaded gain sits 10% below what an unloaded follower would give.
    const gds = gdsOf(20e-6, 0.5e-6, vds);
    expect(relErr(res.values.Rout, 1 / (gm + gds + 1 / 100e3))).toBeLessThan(2e-3);
    expect(res.rules.find((r) => r.id === 'loading')?.status).toBe('pass');
    expect(9 / (gm + gds)).toBeLessThan(100e3);
    expect(relErr(res.values.cgg_in, cggOf(res.values.W, 0.5e-6))).toBeLessThan(1e-9);
  });
});

describe('tier1 goldens: Common gate', () => {
  const res = runSheet(sheet('common-gate.json'), table);
  // Defaults: I_bias 20 uA, gm/ID 10, L 0.5 um, V_out 0.9, V_in 0.3, R_load 50 kohm.
  // gm = 200 uS, gmb = 40 uS, vds = 0.6, VA = 2.5.
  const gm = 20e-6 * 10;
  const gmb = gmbOf(gm);
  const gds = 20e-6 / (VA_PER_L * 0.5e-6 + 0.6);

  it('binds gm exactly and Rin carries the drain load back to the source', () => {
    // The input looks into the source, so the finite ro couples R_load back: the resistance
    // is (R_load + ro) divided by the device's own loop gain, not the 1/(gm + gmb) shorthand.
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    const rin = (50e3 + 1 / gds) / (1 + (gm + gmb) / gds);
    expect(relErr(res.values.Rin, rin)).toBeLessThan(1e-3);
    // …and that is well above the shorthand, which is what makes the input match bind.
    expect(res.values.Rin).toBeGreaterThan(1 / (gm + gmb));
  });

  it('gain drives the load through gm, gmb, and gds together', () => {
    const av = (gm + gmb + gds) / (1 / 50e3 + gds);
    expect(relErr(res.values.Av, av)).toBeLessThan(2e-3);
    // Adding gmb raises the gain by about a fifth. On a sky130 tt realization of this stage
    // that is what carries it past the 10 V/V target (10.57 measured against an 8.72 gm-only
    // estimate); the demo's Early voltage is lower, so here it lands short and the gain rule
    // still reads fail. Either way the binding constraint is the input match.
    expect(res.rules.find((r) => r.id === 'gain-spec')?.status).toBe('fail');
    expect(res.rules.find((r) => r.id === 'input-match')?.status).toBe('fail');
  });

  it('the drain-side interface is the load paralleled with ro, and the gain rides it', () => {
    // Rout is the inverse of the denominator the gain row already used, so the rewrite is
    // arithmetic-free; the gds feedforward stays visible in the transconductance factor.
    expect(relErr(res.values.Rout, 1 / (1 / 50e3 + gds))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av, (gm + gmb + gds) * res.values.Rout)).toBeLessThan(1e-3);
    // Rin, not Rout, is this stage's headline: the input is the low-impedance side.
    expect(res.values.Rin).toBeLessThan(res.values.Rout);
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
    const gds = gdsOf(I, 0.5e-6, 0.9); // same for both: equal L and |vds|
    expect(relErr(res.values.Av, gmTot / (2 * gds))).toBeLessThan(2e-3);
  });

  it('both gates load the driver, and the stronger-inversion device is the smaller one', () => {
    // Rout is one output node: equal L and |vds| put both devices at the same gds, so it is
    // (VA + vds)/(2*I_bias) exactly. cgg_in sums both gates because they are driven together;
    // neither child exposes its width, so what is pinned is the sum and its ordering — the
    // PMOS runs at gm/ID 10 against the NMOS at 12, which is a HIGHER current density and
    // therefore a narrower device, so it contributes the smaller gate.
    expect(relErr(res.values.Rout, stage2Rout(I, 0.5e-6, 0.9))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av, res.values.gm_tot * res.values.Rout)).toBeLessThan(1e-12);
    expect(res.values.cgg_in).toBe(res.values.n__cgg + res.values.p__cgg);
    expect(res.values.p__cgg).toBeLessThan(res.values.n__cgg);
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
