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
import { runSheet, withParams, SOLVE_TOL_REL } from './index';
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
  VGS_GMID12_L05,
} from './library.fixtures';

const sheet = (file: string) => libSheet(`stages/${file}`);

describe('tier1 goldens: CS amp, resistive load', () => {
  const res = runSheet(sheet('cs-amp-resistive-load.json'), table);
  // Defaults: GBW 10 MHz into 2 pF, 1.25 over-design, gm/ID 12, L 0.5 um, R_load
  // 50 kohm, VDD 1.8. gm = 2*pi*10M*2p*1.25 = 157.08 uS and id = gm/12 = 13.090 uA, so the
  // drain sits at VDD - id*R_load = 1.8 - 0.65450 = 1.14550 V, which is the device's vds.
  // VA = 2.5, so gds = id/(2.5 + 1.14550).
  const gm = 2 * Math.PI * 10e6 * 2e-12 * 1.25;
  const id = gm / 12;
  const vOut = 1.8 - id * 50e3;

  it('binds gm exactly from the spec and derives id', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    expect(relErr(res.values.id, id)).toBeLessThan(1e-9);
    // Supply current is that derived branch current — an OUTPUT of the sizing here, since the
    // bandwidth spec fixes gm and the inversion choice divides it down.
    expect(relErr(res.values.I_q, id)).toBeLessThan(1e-9);
  });

  it('gain is gm into the load resistor parallel with 1/gds', () => {
    // gds = 13.090u/3.64550 = 3.5907 uS, so Av = 157.08u/(20u + 3.5907u) = 6.6585.
    const gds = id / (VA_PER_L * 0.5e-6 + vOut);
    const av = gm / (1 / 50e3 + gds);
    expect(relErr(res.values.Av, av)).toBeLessThan(2e-3);
  });

  it('output DC level is VDD minus the load drop, and the device is sized there', () => {
    expect(relErr(res.values.V_out, vOut)).toBeLessThan(1e-9);
    // The bind writes the level with id expanded as gm/gm_id; the row reads the sized id. Both
    // supplied quantities are exact, so the two agree to rounding.
    expect(relErr(res.bind?.bias?.vds ?? NaN, res.values.V_out)).toBeLessThan(1e-9);
  });

  it('a different load moves the drain by exactly -id*dR, since nothing types it', () => {
    // R_load 50k -> 60k leaves gm and id alone (both follow from the spec), so the drain falls
    // by id*10k = 0.13090 V to 1.01460 V, and gds follows it to id/(2.5 + 1.01460).
    const moved = runSheet(
      withParams(sheet('cs-amp-resistive-load.json'), { R_load: 60e3 }),
      table,
    );
    const dv = (moved.bind?.bias?.vds ?? NaN) - (res.bind?.bias?.vds ?? NaN);
    expect(relErr(dv, -id * 10e3)).toBeLessThan(1e-9);
    expect(relErr(moved.values.V_out, 1.8 - id * 60e3)).toBeLessThan(1e-9);
    const gds = id / (VA_PER_L * 0.5e-6 + 1.8 - id * 60e3);
    expect(relErr(moved.values.Rout, par(60e3, 1 / gds))).toBeLessThan(2e-3);
  });

  it('a different inversion level or over-design factor moves the drain with the current', () => {
    // gm/ID 12 -> 10 at R_load 50k: gm stays 157.08 uS (the spec fixes it), so id = 157.08u/10 =
    // 15.708 uA and the drain sits at 1.8 - 15.708u*50k = 1.8 - 0.78540 = 1.01460 V, with gds =
    // id/(2.5 + 1.01460). A current typed into the bind would leave the drain where it was.
    const moved = runSheet(withParams(sheet('cs-amp-resistive-load.json'), { gm_id: 10 }), table);
    const id10 = gm / 10;
    expect(relErr(moved.values.id, id10)).toBeLessThan(1e-9);
    expect(relErr(moved.bind?.bias?.vds ?? NaN, 1.8 - id10 * 50e3)).toBeLessThan(1e-9);
    expect(relErr(moved.values.V_out, 1.8 - id10 * 50e3)).toBeLessThan(1e-9);
    const gds = id10 / (VA_PER_L * 0.5e-6 + 1.8 - id10 * 50e3);
    expect(relErr(moved.values.Rout, par(50e3, 1 / gds))).toBeLessThan(2e-3);
    // gbw_margin 0.25 -> 0.5 at gm/ID 12: gm = 2*pi*10M*2p*1.5 = 188.50 uS, id = 15.708 uA, the
    // same drain as above. A transconductance typed as a number would leave it where it was.
    const margin = runSheet(
      withParams(sheet('cs-amp-resistive-load.json'), { gbw_margin: 0.5 }),
      table,
    );
    const idM = (2 * Math.PI * 10e6 * 2e-12 * 1.5) / 12;
    expect(relErr(margin.bind?.bias?.vds ?? NaN, 1.8 - idM * 50e3)).toBeLessThan(1e-9);
  });

  it('the interface rows are the load resistor paralleled with ro, and the gate capacitance', () => {
    // Rout is the inverse of the denominator the gain already used, so Av = gm*Rout is the same
    // number by construction; what this pins is that the row IS that output node. cgg = W*L*Cox
    // exactly in the demo model, at the width the bind landed on.
    const gds = id / (VA_PER_L * 0.5e-6 + vOut);
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
  // Defaults: I_bias 20 uA, gm/ID 12, L 0.5 um, VDD 1.8, V_in 1.2, R_L 100 kohm. vgs_est is
  // solved to the device's own vgs, which at gm/ID 12 is 0.567023 V on the demo device
  // (VGS_GMID12_L05), so vds = VDD - V_in + vgs = 0.6 + 0.567023 = 1.167023, inside the hull.
  const gm = 20e-6 * 12;
  const vds = 1.8 - 1.2 + VGS_GMID12_L05;

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

  it('the gate drop is solved to the sized vgs and places the drain, with no warnings', () => {
    // The solve closes when the estimate equals what it names, to the engine's own tolerance
    // (relative to the larger of the two); the authored 0.57 is only where it starts.
    expect(Math.abs(res.values.vgs_est - res.values.vgs)).toBeLessThanOrEqual(
      SOLVE_TOL_REL * Math.max(Math.abs(res.values.vgs_est), Math.abs(res.values.vgs)),
    );
    // The fixture vgs is the closed-form inversion; the table interpolates gm/ID on a 10 mV vgs
    // grid, so the solved drop agrees with it to about 1e-4 relative, inside the 1e-3 used here.
    expect(relErr(res.values.vgs_est, VGS_GMID12_L05)).toBeLessThan(1e-3);
    // The gap below is vgs_est - vgs, which the solve closes to SOLVE_TOL_REL relative to the
    // larger of the two; vds is larger than both, so relative to vds it is smaller still. It is
    // zero to rounding on the demo device only because its vgs does not depend on vds.
    expect(relErr(res.bind?.bias?.vds ?? NaN, 1.8 - 1.2 + res.values.vgs)).toBeLessThanOrEqual(
      SOLVE_TOL_REL,
    );
    expect(res.feasible).toBe(true);
    expect(res.warnings).toHaveLength(0);
    expect(res.assumptions).toEqual([]);
  });

  it('the solved drop follows the device when its inversion level moves', () => {
    // gm/ID 8 needs vgs = 0.668042 V (VGS_GMID8_L05). V_in moves to 1.3 V so the drain stays
    // inside the table: vds = 1.8 - 1.3 + 0.668042 = 1.168042 V. A typed estimate would stay at
    // 0.57 V, 98 mV off.
    const moved = runSheet(
      withParams(sheet('source-follower.json'), { gm_id: 8, V_in: 1.3 }),
      table,
    );
    expect(relErr(moved.values.vgs_est, VGS_GMID8_L05)).toBeLessThan(1e-3);
    expect(Math.abs(moved.values.vgs_est - moved.values.vgs)).toBeLessThanOrEqual(
      SOLVE_TOL_REL * Math.max(Math.abs(moved.values.vgs_est), Math.abs(moved.values.vgs)),
    );
    expect(relErr(moved.bind?.bias?.vds ?? NaN, 1.8 - 1.3 + moved.values.vgs)).toBeLessThanOrEqual(
      SOLVE_TOL_REL,
    );
    expect(moved.warnings).toHaveLength(0);
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
  // Defaults: I_bias 20 uA, gm/ID 10, L 0.5 um, VDD 1.8, V_in 0.3, R_load 50 kohm returned to
  // VDD. The drain sits at VDD - I_bias*R_load = 1.8 - 1.0 = 0.8 V, so vds = 0.8 - 0.3 = 0.5.
  // gm = 200 uS, gmb = 40 uS, VA = 2.5, gds = 20u/3.0 = 6.667 uS.
  const gm = 20e-6 * 10;
  const gmb = gmbOf(gm);
  const gds = 20e-6 / (VA_PER_L * 0.5e-6 + 0.5);

  it('the drain sits at the supply less the load drop, and the device is sized there', () => {
    expect(relErr(res.values.V_out, 0.8)).toBeLessThan(1e-9);
    expect(relErr(res.bind?.bias?.vds ?? NaN, 0.5)).toBeLessThan(1e-9);
  });

  it('a different load moves the drain by exactly -I_bias*dR, since nothing types it', () => {
    // R_load 50k -> 40k: the drain rises by 20u*10k = 0.2 V to 1.0 V, so vds = 0.7 and the
    // drain-side node follows gds to 20u/3.2.
    const moved = runSheet(withParams(sheet('common-gate.json'), { R_load: 40e3 }), table);
    expect(relErr(moved.values.V_out - res.values.V_out, 0.2)).toBeLessThan(1e-9);
    expect(relErr(moved.bind?.bias?.vds ?? NaN, 0.7)).toBeLessThan(1e-9);
    expect(relErr(moved.values.Rout, 1 / (1 / 40e3 + 20e-6 / 3.2))).toBeLessThan(1e-9);
  });

  it('a different bias current moves the drain by exactly -dI*R_load', () => {
    // I_bias 20u -> 16u: the drain rises by 4u*50k = 0.2 V to 1.0 V, so vds = 0.7, gds =
    // 16u/3.2 = 5 uS, and Rout = 1/(20u + 5u) = 40 kohm. A current typed into the bind would
    // leave the drain where it was.
    const moved = runSheet(withParams(sheet('common-gate.json'), { I_bias: 16e-6 }), table);
    expect(relErr(moved.values.V_out, 1.0)).toBeLessThan(1e-9);
    expect(relErr(moved.bind?.bias?.vds ?? NaN, 0.7)).toBeLessThan(1e-9);
    expect(relErr(moved.values.Rout, 40e3)).toBeLessThan(1e-9);
  });

  it('binds gm exactly and Rin carries the drain load back to the source', () => {
    // The input looks into the source, so the finite ro couples R_load back: the resistance
    // is (R_load + ro) divided by the device's own loop gain, not the 1/(gm + gmb) shorthand.
    // (50k + 150k)/(1 + 240u/6.667u) = 200k/37 = 5.405 kohm.
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    const rin = (50e3 + 1 / gds) / (1 + (gm + gmb) / gds);
    expect(relErr(res.values.Rin, rin)).toBeLessThan(1e-3);
    // …and that is well above the shorthand, which is what makes the input match bind.
    expect(res.values.Rin).toBeGreaterThan(1 / (gm + gmb));
  });

  it('gain drives the load through gm, gmb, and gds together', () => {
    // (200u + 40u + 6.667u)/(20u + 6.667u) = 9.25.
    const av = (gm + gmb + gds) / (1 / 50e3 + gds);
    expect(relErr(res.values.Av, av)).toBeLessThan(2e-3);
    // Adding gmb raises the gain by about a fifth. On a sky130 tt realization of this stage
    // that is what carries it past the 10 V/V target (10.57 measured against an 8.72 gm-only
    // estimate, simulated at a 0.6 V drain-source bias); the demo's Early voltage is lower, so
    // here it lands short and the gain rule still reads fail. Either way the binding
    // constraint is the input match.
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
