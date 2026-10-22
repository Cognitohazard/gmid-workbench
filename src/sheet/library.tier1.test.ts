// Tier 1 golden tests: the eight single-device stage sheets in sheets/stages/.
// Each expected number is hand-derived from the synthetic EKV demo model's closed
// forms (never by re-running the engine): supplied givens are exact (gm =
// gm/ID * id algebra), the Early-voltage model gives gds/id = 1/(VA + vds) exactly
// after sizing (VA = VA_PER_L * L), and the thermal density is sqrt(4kTgamma/gm).
// gmb is BODY_FACTOR*gm at every point of the demo, but unlike gds it rides the
// interpolated gm curve rather than the given gm/ID, so equations built on it agree with
// the closed form to interpolation order (~1e-3) instead of to the givens' 1e-9.
// The generic contract in library.test.ts already checks these sheets validate,
// size, and raise no hard-check na on the same table; here we pin the physics.

import { describe, it, expect } from 'vitest';
import { PHYS } from '../constants';
import { runSheet, withParams, SOLVE_TOL_REL } from './index';
import { isHardCheck, type SheetDoc, type SheetResult } from './types';
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
  VGS_GMID10_L05,
  VGS_GMID12_L05,
  vgsAtBody,
  vdsatDemo,
  vthDemo,
  vgsAtGmId,
  sourceNodeUnder,
  block,
  REFS,
} from './library.fixtures';

const sheet = (file: string) => libSheet(`stages/${file}`);

// The gate-source voltage the demo model needs for gm/ID 7 at L = 0.5 µm, from the EKV inversion
// gm/ID = sigmoid(x)/(n·UT·softplus(x)) with n = 1.3 — the same derivation as the fixture
// constants for 8 to 14: overdrive 0.280327 V on a 0.426582 V threshold.
const VGS_GMID7_L05 = 0.70691;

describe('tier1 goldens: CS amp, resistive load', () => {
  const res = runSheet(sheet('cs-amp-resistive-load.json'), table);
  // Defaults: GBW 10 MHz into 2 pF, 1.25 over-design, gm/ID 12, L 0.5 um, R_load
  // 50 kohm, VDD 1.8. gm = 2*pi*10M*2p*1.25 = 157.08 uS and id = gm/12 = 13.090 uA, so the
  // drain sits at VDD - id*R_load = 1.8 - 0.65450 = 1.14550 V, which is the device's vds.
  // VA = 2.5, so gds = id/(2.5 + 1.14550).
  const gm = 2 * Math.PI * 10e6 * 2e-12 * 1.25;
  const id = gm / 12;
  const vOut = 1.8 - id * 50e3;

  it('takes gm exactly from the spec and derives id', () => {
    expect(res.sizing?.ok).toBe(true);
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
    // The givens write the level with id expanded as gm/gm_id; the equation reads the sized id.
    // Both supplied quantities are exact, so the two agree to rounding.
    expect(relErr(res.sizing?.bias?.vds ?? NaN, res.values.V_out)).toBeLessThan(1e-9);
  });

  it('a different load moves the drain by exactly -id*dR, since nothing types it', () => {
    // R_load 50k -> 60k leaves gm and id alone (both follow from the spec), so the drain falls
    // by id*10k = 0.13090 V to 1.01460 V, and gds follows it to id/(2.5 + 1.01460).
    const moved = runSheet(
      withParams(sheet('cs-amp-resistive-load.json'), { R_load: 60e3 }),
      table,
    );
    const dv = (moved.sizing?.bias?.vds ?? NaN) - (res.sizing?.bias?.vds ?? NaN);
    expect(relErr(dv, -id * 10e3)).toBeLessThan(1e-9);
    expect(relErr(moved.values.V_out, 1.8 - id * 60e3)).toBeLessThan(1e-9);
    const gds = id / (VA_PER_L * 0.5e-6 + 1.8 - id * 60e3);
    expect(relErr(moved.values.Rout, par(60e3, 1 / gds))).toBeLessThan(2e-3);
  });

  it('a different inversion level or over-design factor moves the drain with the current', () => {
    // gm/ID 12 -> 10 at R_load 50k: gm stays 157.08 uS (the spec fixes it), so id = 157.08u/10 =
    // 15.708 uA and the drain sits at 1.8 - 15.708u*50k = 1.8 - 0.78540 = 1.01460 V, with gds =
    // id/(2.5 + 1.01460). A current typed into the givens would leave the drain where it was.
    const moved = runSheet(withParams(sheet('cs-amp-resistive-load.json'), { gm_id: 10 }), table);
    const id10 = gm / 10;
    expect(relErr(moved.values.id, id10)).toBeLessThan(1e-9);
    expect(relErr(moved.sizing?.bias?.vds ?? NaN, 1.8 - id10 * 50e3)).toBeLessThan(1e-9);
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
    expect(relErr(margin.sizing?.bias?.vds ?? NaN, 1.8 - idM * 50e3)).toBeLessThan(1e-9);
  });

  it('the interface equations are the load resistor paralleled with ro, and the gate capacitance', () => {
    // Rout is the inverse of the denominator the gain already used, so Av = gm*Rout is the same
    // number by construction; what this pins is that the equation IS that output node. cgg =
    // W*L*Cox exactly in the demo model, at the width the sizing landed on.
    const gds = id / (VA_PER_L * 0.5e-6 + vOut);
    expect(relErr(res.values.Rout, par(50e3, 1 / gds))).toBeLessThan(2e-3);
    expect(relErr(res.values.Av, gm * res.values.Rout)).toBeLessThan(1e-12);
    expect(relErr(res.values.cgg_in, cggOf(res.values.W, 0.5e-6))).toBeLessThan(1e-9);
  });

  it('bandwidth is gm into the load plus the typed drain estimate', () => {
    // 1 fF beside the 2 pF load: 157.08 uS/(2*pi*2.001 pF) = 12.494 MHz.
    expect(relErr(res.values.Cout, 2e-12 + 1e-15)).toBeLessThan(1e-12);
    expect(relErr(res.values.GBW, gm / (2 * Math.PI * (2e-12 + 1e-15)))).toBeLessThan(1e-9);
  });
});

describe('tier1 goldens: CS amp, diode-connected load', () => {
  const res = runSheet(sheet('cs-amp-diode-load.json'), table);
  // Input gm from the spec; the load is given the current the input device lands on (gm/12), so
  // the transconductance ratio is exactly the gm/ID ratio.
  const gm = 2 * Math.PI * 10e6 * 2e-12 * 1.25;

  it('takes the input gm exactly from the spec', () => {
    expect(block(res, 'in').ok).toBe(true);
    expect(relErr(res.values.in__gm, gm)).toBeLessThan(1e-9);
    expect(block(res, 'load').id).toBe(res.values.in__id);
    // The branch current follows from that gm and the inversion choice, and is what the supply
    // pays — the load sits in the same branch and carries no current of its own.
    expect(relErr(res.values.I_q, gm / 12)).toBeLessThan(1e-9);
  });

  it('input/load transconductance ratio is the gm/ID ratio (equal currents)', () => {
    // gm_in/gm_load = (12*id)/(8*id) = 12/8 exactly.
    expect(relErr(res.values.in__gm / res.values.load__gm, 12 / 8)).toBeLessThan(1e-9);
  });

  it('solves the output level one diode drop below the supply, and the input drain sits there', () => {
    // The one value the sheet solves: the input device is sized first, so its drain voltage cannot
    // read the load's drop directly; the engine searches the output level at which the two agree.
    expect(res.solve?.kind).toBe('settled');
    expect(relErr(res.values.V_out, 1.8 - res.values.load__vgs)).toBeLessThan(1e-9);
    expect(relErr(res.values.V_out, 1.8 - VGS_GMID8_L05)).toBeLessThan(1e-4);
    expect(block(res, 'in').bias?.vds).toBe(res.values.V_out);
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
    expect(relErr(res.values.cgg_in, cggOf(block(res, 'in').W, 0.5e-6))).toBeLessThan(1e-9);
  });

  it("the output carries the diode load's own gate capacitance from the table", () => {
    // The load's gate is the output node, so its W*L*Cox sits there beside the 2 pF load and the
    // 1 fF typed for the two drains.
    const cout = 2e-12 + cggOf(block(res, 'load').W, 0.5e-6) + 1e-15;
    expect(relErr(res.values.Cout, cout)).toBeLessThan(1e-9);
    expect(relErr(res.values.GBW, gm / (2 * Math.PI * cout))).toBeLessThan(1e-9);
  });
});

describe('tier1 goldens: Source-degenerated CS amp', () => {
  const res = runSheet(sheet('source-degenerated-cs-amp.json'), table);
  // Defaults: I_bias 20 uA, gm/ID 12, R_s 2 kohm. gm = 20u*12 = 240 uS, gmb = 48 uS.
  const gm = 20e-6 * 12;
  const gmb = gmbOf(gm);
  const Rs = 2e3;

  it('takes gm exactly from the current and gm/ID', () => {
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
  });

  it('the degeneration factor carries both source-referred generators', () => {
    // Both gm and gmb drive current through R_s, so the loop factor is 1 + (gm + gmb)*R_s.
    expect(relErr(res.values.loop, 1 + (gm + gmb) * Rs)).toBeLessThan(1e-3);
    expect(relErr(res.values.Gm, gm / (1 + (gm + gmb) * Rs))).toBeLessThan(1e-3);
  });

  it('input noise adds the 4kT*R_s resistor term, referred through (gm + gmb)/gm', () => {
    // R_s's noise is a voltage in series with the source, and the source drives the channel
    // through gm + gmb, so it reaches the gate scaled by (gm + gmb)/gm = 1 + BODY_FACTOR = 1.2.
    const vn = Math.sqrt(vnthM(gm) ** 2 + 4 * PHYS.k * PHYS.T * Rs * ((gm + gmb) / gm) ** 2);
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
  const res = runSheet(sheet('cascode-cs-amp.json'), table, undefined, REFS);
  // Defaults: I_bias 20 uA shared, gm/ID in 12 / casc 10 / load 8, all L 0.5 um, V_out 0.9.
  // VA = 2.5. The cascode's gate is a bias diode at gm/ID 3 on the same length, so it sits at
  // vgs(3), and the node under the cascode is solved under it: the cascode, at gm/ID 10 with its
  // source at the node, needs vgs(10) plus BODY_FACTOR times the node, so the node is
  // (vgs(3) - vgs(10))/1.2 = 0.4026 V. vds: in V_x, casc 0.9 - V_x, load 0.9.
  const I = 20e-6;
  const VA = VA_PER_L * 0.5e-6;
  const gate = vgsAtGmId(3);
  const vx = sourceNodeUnder(gate, VGS_GMID10_L05);

  it('the cascode device carries the input branch current', () => {
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.in__id, I)).toBeLessThan(1e-9);
    expect(relErr(res.values.id, res.values.in__id)).toBeLessThan(1e-12);
  });

  it('the node under the cascode hangs from the bias diode, its gate', () => {
    // The diode is read along the table's diagonal, to about 1e-3; the node follows it.
    expect(relErr(res.values.cb__vgs, gate)).toBeLessThan(1e-3);
    expect(relErr(res.values.V_x, vx)).toBeLessThan(2e-3);
    // Solved, to the search's tolerance: the node plus the cascode's own gate-source voltage is
    // the diode's, and nothing holds the gate.
    expect(Math.abs(res.values.V_x + res.values.vgs - res.values.cb__vgs)).toBeLessThan(1e-6);
    expect(res.held).toBeUndefined();
    expect(res.nodes?.state).toBe('checked-clean');
  });

  it('cascode intrinsic gain is gm/ID_casc * (VA + vds_casc)', () => {
    expect(relErr(res.values.av0, 10 * (VA + 0.9 - res.values.V_x))).toBeLessThan(2e-3);
  });

  it('gain is the input gm into the full cascoded output resistance', () => {
    const V_X = res.values.V_x;
    const inGm = 12 * I;
    const inGds = I / (VA + V_X);
    const gdsCasc = I / (VA + 0.9 - V_X);
    const av0Casc = 10 * (VA + 0.9 - V_X);
    const RoutCasc = (1 / inGds) * (1 + av0Casc) + 1 / gdsCasc;
    const loadGds = I / (VA + 0.9);
    const Rout = 1 / (1 / RoutCasc + loadGds);
    expect(relErr(res.values.Av, inGm * Rout)).toBeLessThan(2e-3);
  });

  it('input capacitance is the input device gate, and nothing the cascode adds', () => {
    // Composition golden. The input child does not expose its sized width, so the absolute
    // capacitance has no closed form to check here; what the equation must get right is WHICH gate
    // it reads — the driven one at the bottom of the stack, not the cascode's fixed gate above it.
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

  it('takes gm exactly and the follower gain is below unity', () => {
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    expect(res.values.Av).toBeLessThan(1);
  });

  it('gain is gm/(gm + gds + 1/R_L)', () => {
    const gds = gdsOf(20e-6, 0.5e-6, vds);
    const av = gm / (gm + gds + 1 / 100e3);
    expect(relErr(res.values.Av, av)).toBeLessThan(2e-3);
  });

  it('the gate drop is solved to the sized vgs and places the drain, with no warnings', () => {
    // The solve closes when the param equals what it names, to the search's own tolerance:
    // SOLVE_TOL_REL of the 1.6 V range it is searched in. The authored 0.57 is never read.
    expect(Math.abs(res.values.vgs_est - res.values.vgs)).toBeLessThanOrEqual(SOLVE_TOL_REL * 1.6);
    // The fixture vgs is the closed-form inversion; the table interpolates gm/ID on a 10 mV vgs
    // grid, so the solved drop agrees with it to about 1e-4 relative, inside the 1e-3 used here.
    expect(relErr(res.values.vgs_est, VGS_GMID12_L05)).toBeLessThan(1e-3);
    // The gap below is vgs_est - vgs, which the solve closes to the same tolerance. It is zero to
    // rounding on the demo device only because its vgs does not depend on vds.
    expect(
      Math.abs((res.sizing?.bias?.vds ?? NaN) - (1.8 - 1.2 + res.values.vgs)),
    ).toBeLessThanOrEqual(SOLVE_TOL_REL * 1.6);
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
      SOLVE_TOL_REL * 1.6,
    );
    expect(
      Math.abs((moved.sizing?.bias?.vds ?? NaN) - (1.8 - 1.3 + moved.values.vgs)),
    ).toBeLessThanOrEqual(SOLVE_TOL_REL * 1.6);
    expect(moved.warnings).toHaveLength(0);
  });

  it('the ten-to-one loading advisory check is the buffering claim, and the load clears it', () => {
    // R_L >= 10*Rout is not an identity: Rout folds 1/R_L in, so the condition reduces to
    // R_L*(gm + gds) >= 9 — about 36.7 kohm here, which the 100 kohm default clears. At exactly
    // ten to one the loaded gain sits 10% below what an unloaded follower would give.
    const gds = gdsOf(20e-6, 0.5e-6, vds);
    expect(relErr(res.values.Rout, 1 / (gm + gds + 1 / 100e3))).toBeLessThan(2e-3);
    expect(res.checks.find((r) => r.id === 'loading')?.status).toBe('pass');
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
    expect(relErr(res.sizing?.bias?.vds ?? NaN, 0.5)).toBeLessThan(1e-9);
  });

  it('the source sits above the body, and the gate pays for it', () => {
    // The signal enters at the source, V_in = 0.3 V above the body at ground, and the givens
    // declare that as the device's body bias. The demo threshold rises BODY_FACTOR x 0.3 V =
    // 60 mV there, so holding gm/ID 10 takes vgs(10) + 0.06 = 0.610063 + 0.06 = 0.670063 V.
    // Read body-grounded the gate would come out 60 mV too low.
    expect(res.sizing?.bias?.vsb).toBe(0.3);
    expect(relErr(res.values.vgs, vgsAtBody(VGS_GMID10_L05, 0.3))).toBeLessThan(1e-4);
  });

  it('a different load moves the drain by exactly -I_bias*dR, since nothing types it', () => {
    // R_load 50k -> 40k: the drain rises by 20u*10k = 0.2 V to 1.0 V, so vds = 0.7 and the
    // drain-side node follows gds to 20u/3.2.
    const moved = runSheet(withParams(sheet('common-gate.json'), { R_load: 40e3 }), table);
    expect(relErr(moved.values.V_out - res.values.V_out, 0.2)).toBeLessThan(1e-9);
    expect(relErr(moved.sizing?.bias?.vds ?? NaN, 0.7)).toBeLessThan(1e-9);
    expect(relErr(moved.values.Rout, 1 / (1 / 40e3 + 20e-6 / 3.2))).toBeLessThan(1e-9);
  });

  it('a different bias current moves the drain by exactly -dI*R_load', () => {
    // I_bias 20u -> 16u: the drain rises by 4u*50k = 0.2 V to 1.0 V, so vds = 0.7, gds =
    // 16u/3.2 = 5 uS, and Rout = 1/(20u + 5u) = 40 kohm. A current typed into the givens would
    // leave the drain where it was.
    const moved = runSheet(withParams(sheet('common-gate.json'), { I_bias: 16e-6 }), table);
    expect(relErr(moved.values.V_out, 1.0)).toBeLessThan(1e-9);
    expect(relErr(moved.sizing?.bias?.vds ?? NaN, 0.7)).toBeLessThan(1e-9);
    expect(relErr(moved.values.Rout, 40e3)).toBeLessThan(1e-9);
  });

  it('takes gm exactly and Rin carries the drain load back to the source', () => {
    // The input looks into the source, so the finite ro couples R_load back: the resistance
    // is (R_load + ro) divided by the device's own loop gain, not the 1/(gm + gmb) shorthand.
    // (50k + 150k)/(1 + 240u/6.667u) = 200k/37 = 5.405 kohm.
    expect(res.sizing?.ok).toBe(true);
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
    // here it lands short and the gain check still reads fail. Either way the binding
    // check is the input match.
    expect(res.checks.find((r) => r.id === 'gain-spec')?.status).toBe('fail');
    expect(res.checks.find((r) => r.id === 'input-match')?.status).toBe('fail');
  });

  it('the drain-side interface is the load paralleled with ro, and the gain rides it', () => {
    // Rout is the inverse of the denominator the gain equation already used, so the rewrite is
    // arithmetic-free; the gds feedforward stays visible in the transconductance factor.
    expect(relErr(res.values.Rout, 1 / (1 / 50e3 + gds))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av, (gm + gmb + gds) * res.values.Rout)).toBeLessThan(1e-3);
    // Rin, not Rout, is this stage's headline: the input is the low-impedance side.
    expect(res.values.Rin).toBeLessThan(res.values.Rout);
  });

  it('input noise refers the drain-side noise currents back through the source drive', () => {
    // The input is the source, which reaches the drain through gm + gmb + gds, so the channel's
    // noise current sqrt(4kTγ·(gm + gmb)) = 1.995 pA/√Hz and the load resistor's sqrt(4kT/R_load)
    // = 0.576 pA/√Hz refer back through 246.67 µS: 8.416 nV/√Hz. Through gm alone the channel
    // term would read vnth_m = 9.973 nV/√Hz, 18.5 % high, without the resistor.
    const iCh = vnthM(gm) * gm;
    const iR = Math.sqrt((4 * PHYS.k * PHYS.T) / 50e3);
    expect(relErr(res.values.vn_in, Math.hypot(iCh, iR) / (gm + gmb + gds))).toBeLessThan(2e-3);
    const { vnth_m, gm: gmV, gmb: gmbV, gds: gdsV } = res.values;
    expect(
      relErr(res.values.vn_in, Math.hypot(vnth_m * gmV, iR) / (gmV + gmbV + gdsV)),
    ).toBeLessThan(1e-12);
  });
});

describe('tier1 goldens: CMOS inverter amplifier', () => {
  const doc = sheet('cmos-inverter-amp.json');
  const res = runSheet(doc, table);
  // Defaults: I_bias 20 µA typed into the NMOS at gm/ID 7, both L 0.5 µm, V_out 0.9, VDD 1.8. The
  // two gates are one node and the two sources are the rails, so the PMOS is not given an
  // inversion level: it carries the NMOS's current at the gate-source voltage the supply leaves.
  //   input level   V_in = vgs(7) = 0.706910 V
  //   PMOS          vgs = 1.8 − 0.706910 = 1.093090 V, overdrive 1.093090 − 0.426582 = 0.666507 V
  // That overdrive is 9.9 times 2·n·UT, deep in strong inversion, where the model's gm/ID is the
  // square law's 2/overdrive to about a part in 10⁴: 3.0007 /V against the NMOS's 7.
  const I = 20e-6;
  const vIn = VGS_GMID7_L05;
  const vovP = 1.8 - vIn - vthDemo(0.5e-6);
  const gmIdP = 2 / vovP;
  const gmTot = I * (7 + gmIdP); // 140 µS + 60.01 µS
  const blockOf = (r: SheetResult, name: string) => r.blocks!.find((b) => b.name === name)!;
  const checkOf = (r: SheetResult, id: string) => r.checks.find((c) => c.id === id)!;
  const hardFails = (r: SheetResult): string[] => [
    ...r.checks.filter((c) => isHardCheck(c.kind) && c.status === 'fail').map((c) => c.id),
    ...(r.blocks ?? []).flatMap((b) =>
      b.checks
        .filter((c) => isHardCheck(c.kind) && c.status === 'fail')
        .map((c) => `${b.name}.${c.id}`),
    ),
  ];

  it('the two gate-source voltages add up to the supply', () => {
    // The fact the sheet is drawn from. The NMOS is sized for its gm/ID and its gate-source
    // voltage is the input level; the PMOS is read at what is left of the supply above it. A
    // given gate voltage is reported as the coordinate the table was read at, so the sum is the
    // supply to rounding, and here that coordinate lies on the table, 107 mV inside its 1.2 V.
    const n = blockOf(res, 'n').sizing!;
    const p = blockOf(res, 'p').sizing!;
    expect(relErr(n.vgs + p.vgs, 1.8)).toBeLessThan(1e-12);
    expect(p.clamped).toBeUndefined();
    expect(res.values.V_in).toBe(n.vgs);
    expect(relErr(res.values.V_in, vIn)).toBeLessThan(1e-4);
    // One current: typed into the NMOS, read from the NMOS by the PMOS.
    expect(n.id).toBe(I);
    expect(p.id).toBe(n.id);
    // The inversion level the PMOS lands at is an output, and nothing on the sheet sets it.
    expect(doc.params.map((q) => q.name)).not.toContain('gm_id_p');
    expect(relErr(res.values.p__gm_id, gmIdP)).toBeLessThan(1e-3);
    // The netlist puts the two gates on one wire and the two sources on the rails, and the loop
    // through them closes: the input wire sits at the NMOS's gate-source voltage.
    expect(res.nodes!.state).toBe('checked-clean');
    expect(res.nodes!.levels.in.level).toBe(n.vgs);
  });

  it('the input-consistency checks read the tie: the PMOS gate is the input level, and the input level is held to the output level', () => {
    // input-consistent-p asserts the tie: the PMOS's gate, one PMOS gate-source voltage below the
    // supply, is the input level. The PMOS is handed exactly that, so the two sides are equal and
    // the '==' margin is the whole band, 1 % of the input level.
    const p = checkOf(res, 'input-consistent-p');
    expect([p.kind, p.status]).toEqual(['advisory', 'pass']);
    expect(relErr(p.lhsValue, p.rhsValue)).toBeLessThan(1e-12);
    expect(relErr(p.margin, 0.01 * res.values.V_in)).toBeLessThan(1e-9);
    // input-consistent-n is the trip point: a self-biased inverter sits where its input and
    // output levels coincide. Here the input is 0.707 V and the output 0.9 V, 193 mV apart
    // against a band of 9 mV, so it reads fail by that much.
    const n = checkOf(res, 'input-consistent-n');
    expect([n.kind, n.status]).toEqual(['advisory', 'fail']);
    expect(n.lhsValue).toBe(res.values.V_in);
    expect(n.rhsValue).toBe(0.9);
    expect(relErr(n.margin, 0.009 - (0.9 - res.values.V_in))).toBeLessThan(1e-9);
    // Where the gate the tie hands the PMOS lies past the table, the assertion trips. At gm/ID
    // 12 the input level is vgs(12) = 0.567 V, so the PMOS is asked for 1.233 V and read at the
    // table's 1.2 V edge: its gate is then 33 mV above the input level, and the check says so
    // together with the wiring check, whose loop through the two gates misses by the same amount.
    const clamped = runSheet(withParams(doc, { gm_id_n: 12 }), table);
    expect(blockOf(clamped, 'p').sizing!.clamped).toEqual(['vgs']);
    const tripped = checkOf(clamped, 'input-consistent-p');
    expect(tripped.status).toBe('fail');
    expect(relErr(tripped.lhsValue, 1.8 - 1.2)).toBeLessThan(1e-12);
    expect(relErr(tripped.rhsValue, VGS_GMID12_L05)).toBeLessThan(1e-4);
    expect(clamped.nodes!.state).toBe('checked-with-findings');
    expect(relErr(clamped.nodes!.closureError, 1.8 - 1.2 - clamped.values.V_in)).toBeLessThan(1e-9);
  });

  it('combined transconductance is I_bias*(gm/ID_n + gm/ID_p)', () => {
    expect(relErr(res.values.n__gm, 7 * I)).toBeLessThan(1e-9);
    expect(relErr(res.values.gm_tot, gmTot)).toBeLessThan(1e-3);
    expect(relErr(res.values.gm_tot, res.values.n__gm + res.values.p__gm)).toBeLessThan(1e-12);
  });

  it('gain is the summed gm into the summed output conductance', () => {
    // Both devices at L 0.5 µm and |vds| 0.9 carry one current, so gds_n = gds_p and
    // Av = (gm/ID_n + gm/ID_p)·(VA + vds)/2 = 10.0007 × 3.4/2 = 17.001.
    const gds = gdsOf(I, 0.5e-6, 0.9);
    expect(relErr(res.values.Av, gmTot / (2 * gds))).toBeLessThan(2e-3);
  });

  it('both gates load the driver, and the stronger-inversion device is the smaller one', () => {
    // Rout is one output node: equal L and |vds| put both devices at the same gds, so it is
    // (VA + vds)/(2*I_bias) exactly. cgg_in sums both gates because they are driven together.
    // The PMOS, in strong inversion, carries the same current at a far higher current density,
    // so it is the narrower device and contributes the smaller gate.
    expect(relErr(res.values.Rout, stage2Rout(I, 0.5e-6, 0.9))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av, res.values.gm_tot * res.values.Rout)).toBeLessThan(1e-12);
    expect(res.values.cgg_in).toBe(res.values.n__cgg + res.values.p__cgg);
    expect(res.values.p__cgg).toBeLessThan(res.values.n__cgg);
  });

  it('both devices are held in saturation by the region each declares', () => {
    // Each device's region check compares the drain-source voltage its givens state against its
    // own saturation voltage, 2·UT plus its overdrive in the demo model. The PMOS's overdrive is
    // whatever the supply leaves, so its saturation voltage is large: 0.718 V of the 0.9 V
    // between the supply and the output.
    const nRegion = blockOf(res, 'n').checks.find((c) => c.id === 'region')!;
    const pRegion = blockOf(res, 'p').checks.find((c) => c.id === 'region')!;
    expect([nRegion.kind, nRegion.status, pRegion.kind, pRegion.status]).toEqual([
      'physical',
      'pass',
      'physical',
      'pass',
    ]);
    expect(nRegion.lhsValue).toBe(0.9);
    expect(relErr(nRegion.rhsValue, vdsatDemo(vIn, 0.5e-6))).toBeLessThan(1e-3);
    expect(relErr(pRegion.lhsValue, 1.8 - 0.9)).toBeLessThan(1e-12);
    expect(relErr(pRegion.rhsValue, vdsatDemo(1.8 - vIn, 0.5e-6))).toBeLessThan(1e-3);
    // An output 0.2 V higher leaves the PMOS 0.7 V, under that, and the design fails there.
    const high = runSheet(withParams(doc, { V_out: 1.1 }), table);
    expect(hardFails(high)).toContain('p.region');
    expect(high.feasible).toBe(false);
  });

  it('does not close on this table at its defaults: the gain is short', () => {
    // The defaults put the input level at the 0.9 V output level on a sky130 typical-corner table,
    // where the NMOS threshold is high enough that gm/ID 7 lands there. This table's thresholds
    // are 0.43 V for either polarity at 0.5 µm, so gm/ID 7 puts the input at 0.707 V and leaves the
    // PMOS 0.667 V of overdrive, deep in strong inversion at gm/ID 3.0. The composite gm/ID is
    // 10.0, and on this table's Early voltage the gain is 17.0 against a target of 20; the
    // trip-point check reads fail as well (above). Every other check holds.
    expect(res.feasible).toBe(false);
    expect(hardFails(res)).toEqual(['gain-spec']);
    const gain = checkOf(res, 'gain-spec');
    const av = ((7 + gmIdP) * (VA_PER_L * 0.5e-6 + 0.9)) / 2;
    expect(relErr(gain.lhsValue, av)).toBeLessThan(2e-3);
    expect(relErr(gain.marginPct, av / 20 - 1)).toBeLessThan(2e-3); // −15.0 %
    expect(res.checks.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual([
      'input-consistent-n',
      'gain-spec',
    ]);
  });
});

describe('tier1 goldens: Sampling switch', () => {
  const res = runSheet(sheet('sampling-switch.json'), table);
  // Defaults: W_sw 10 um, L 0.18 um, gm_id_on 3.5, vds_test 0.05, C_s 1 pF. The
  // width is given directly, so cgg = W*L*Cox is exact (Cox = 0.01).
  const Wsw = 10e-6;
  const L = 0.18e-6;

  it('gate capacitance is W*L*Cox at the given width', () => {
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.cgg, Wsw * L * 0.01)).toBeLessThan(1e-9);
  });

  it('the width-first givens still land gm/id at the target gm_id_on', () => {
    expect(relErr(res.values.gm / res.values.id, 3.5)).toBeLessThan(1e-9);
  });

  it('sampled noise is the kT/C RMS voltage', () => {
    expect(relErr(res.values.vn_kTC, Math.sqrt((PHYS.k * PHYS.T) / 1e-12))).toBeLessThan(1e-9);
  });
});

// Each device states the region the design needs it in: saturation for every amplifying, load and
// cascode device, triode for the switch, and nothing on a diode-connected device, whose drain is
// its gate. The engine then holds each declared device to it with a physical check of its own,
// `region`, which compares the drain-source voltage the givens state against the device's
// saturation voltage. A sheet therefore writes no check of its own comparing the same two voltages
// with no margin: the declaration says it once, at every point.
describe('tier1: the regions the stage devices declare', () => {
  /** The region each device of a sheet declares, keyed by block name ('' for the sheet's own). */
  const declared = (doc: SheetDoc): Record<string, string> => {
    const out: Record<string, string> = {};
    if (doc.givens?.region) out[''] = doc.givens.region;
    for (const b of doc.blocks ?? []) if (b.doc?.givens?.region) out[b.name] = b.doc.givens.region;
    return out;
  };
  /** The engine's region check on one device of a run, and the saturation voltage it read. */
  const regionOf = (r: SheetResult, device: string) => {
    const b = device ? r.blocks!.find((u) => u.name === device)! : undefined;
    const vdsat = b ? b.provides.vdsat : r.values.vdsat;
    return { check: (b ? b.checks : r.checks).find((c) => c.id === 'region')!, vdsat };
  };

  // Per sheet: each declaring device, its region, and the drain-source voltage that region
  // compares, written from the schematic and read back from the run; then the hand-written checks
  // the declaration replaced.
  const CASES: Record<
    string,
    [Record<string, ['saturation' | 'triode', (r: SheetResult) => number]>, string[]]
  > = {
    'cs-amp-resistive-load.json': [{ '': ['saturation', (r) => r.values.V_out] }, ['headroom']],
    'cs-amp-diode-load.json': [
      { in: ['saturation', (r) => r.values.VDD - Math.abs(r.values.load__vgs)] },
      ['input-sat'],
    ],
    'cs-amp-current-source-load.json': [
      {
        in: ['saturation', (r) => r.values.V_out],
        load: ['saturation', (r) => r.values.VDD - r.values.V_out],
      },
      ['input-sat', 'load-sat'],
    ],
    'cascode-cs-amp.json': [
      {
        in: ['saturation', (r) => r.values.V_x],
        '': ['saturation', (r) => r.values.V_out - r.values.V_x],
        load: ['saturation', (r) => r.values.VDD - r.values.V_out],
      },
      ['input-sat', 'cascode-sat', 'load-sat'],
    ],
    'common-gate.json': [
      { '': ['saturation', (r) => r.values.V_out - r.values.V_in] },
      ['headroom'],
    ],
    'source-degenerated-cs-amp.json': [
      { '': ['saturation', (r) => r.values.V_out - r.values.I_bias * r.values.R_s] },
      ['headroom'],
    ],
    'source-follower.json': [
      { '': ['saturation', (r) => r.values.VDD - r.values.V_out] },
      ['headroom'],
    ],
    'cmos-inverter-amp.json': [
      {
        n: ['saturation', (r) => r.values.V_out],
        p: ['saturation', (r) => r.values.VDD - r.values.V_out],
      },
      ['n-sat', 'p-sat'],
    ],
    'sampling-switch.json': [{ '': ['triode', (r) => r.values.vds_test] }, []],
  };

  it.each(Object.keys(CASES))('%s', (file) => {
    const [devices, replaced] = CASES[file];
    const doc = sheet(file);
    expect(declared(doc)).toEqual(
      Object.fromEntries(Object.entries(devices).map(([d, [region]]) => [d, region])),
    );
    for (const id of replaced) expect(doc.checks.map((c) => c.id)).not.toContain(id);
    const res = runSheet(doc, table, undefined, REFS);
    for (const [device, [region, vds]] of Object.entries(devices)) {
      const { check, vdsat } = regionOf(res, device);
      expect([device, check.kind, check.op, check.status]).toEqual([
        device,
        'physical',
        region === 'triode' ? '<=' : '>=',
        'pass',
      ]);
      expect([device, relErr(check.lhsValue, Math.abs(vds(res))) < 1e-9]).toEqual([device, true]);
      if (vdsat !== undefined) expect(check.rhsValue).toBe(vdsat);
    }
  });

  it('the switch is held in triode: a drain-source voltage past its saturation voltage fails it', () => {
    // The on-resistance is vds_test over the current, which is a triode figure only while the
    // drain-source voltage stays under the saturation voltage — 0.62 V here, at gm/ID 3.5. At
    // vds_test 0.7 V the device is no longer a switch, and the sheet says so.
    const doc = sheet('sampling-switch.json');
    const at = runSheet(withParams(doc, { vds_test: 0.7 }), table);
    const check = at.checks.find((c) => c.id === 'region')!;
    expect([check.status, check.lhsValue]).toEqual(['fail', 0.7]);
    expect(at.feasible).toBe(false);
  });
});
