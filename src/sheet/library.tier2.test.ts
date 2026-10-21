// Tier 2 golden tests: the mirror/bias sheets under sheets/mirrors-bias. Each sheet's
// numbers are hand-derived from the synthetic EKV demo model's closed forms (never by
// re-running the engine), so a physics or wiring regression in a sheet is caught here,
// while the generic contract (validates, sizes, no hard-check na) is covered by
// library.test.ts running over the same files.
//
// Demo model facts used below:
//  - Early voltage VA = 5e6 * L, so gds/id = 1/(VA + vds) after sizing.
//  - gm/ID is drain-voltage independent (the CLM factor cancels), so a sized device's vgs and
//    idSat are the same on any vds slice: two mirror devices at the SAME declared vds
//    carry the SAME current density and their ratio error is exactly zero, and two
//    devices at DIFFERENT on-grid vds differ by exactly the CLM ratio
//    (1 + vds_a/VA)/(1 + vds_b/VA).
//  - Supplied givens (id, W) are exact; a width-first W = N*ref__W makes
//    W/ref__W exactly N.
//  - pelgrom_irel scales as 1/sqrt(W*L), so at fixed L and gm/ID a K-times-wider device
//    has exactly 1/sqrt(K) of the reference's current spread.
//  - gmb = BODY_FACTOR*gm at every point, but it rides the interpolated gm curve rather
//    than the given gm/ID, so equations built on it hold to interpolation order, not to 1e-9.
//  - The threshold rises BODY_FACTOR per volt of source-body bias and nothing else moves, and
//    vdsat is 2*UT plus the overdrive above threshold. So a device's vdsat moves one for one
//    with its gate-source voltage and by -BODY_FACTOR per volt of body bias, exactly on the
//    grid, since both are linear along the axes.
//  - gm/ID falls as the saturation current density rises, and never faster than the square
//    law's 1/sqrt(density): the level sits between that and constant.

import { describe, it, expect } from 'vitest';
import { UT } from '../constants';
import { BODY_FACTOR } from '../demo';
import { runSheet, withParams, SOLVE_TOL_REL } from './index';
import type { SheetDoc, SheetResult } from './types';
import {
  table,
  relErr,
  va,
  gdsOf,
  VA_PER_L,
  gmbOf,
  roMirrored,
  pelgromIrelRatio,
  vgsAtBody,
  vgsForCurrentRatio,
  vgsAtGmId,
  sheet as libSheet,
} from './library.fixtures';

const sheet = (file: string) => libSheet(`mirrors-bias/${file}`);

describe('tier-2 goldens: cascode current mirror', () => {
  const doc = sheet('cascode-current-mirror.json');
  const res = runSheet(doc, table);
  // Defaults: I_in 20 µA, K = 4, gm/ID 8 on both reference devices, L = L_c = 1 µm, output at
  // 1.1 V. The sheet's own device is the output cascode; the block `out` is the mirror device
  // under it, and the node between the two is solved, as a multiple of the reference device's
  // diode drop.
  const K = 4;
  const I_IN = 20e-6;
  const V_OUT = 1.1;
  const VA = va(1e-6);

  /** The output branch of a run in the terms every golden below is written in: the two output
   *  devices as sized, the node between them, and the two diode drops of the reference stack —
   *  read from the result, as every mirror golden reads a diode's own drop. */
  const branch = (r: SheetResult) => ({
    mirror: r.blocks!.find((b) => b.name === 'out')!.sizing!,
    casc: r.sizing!,
    node: r.values.V_x,
    vRef: r.values.ref__vgs,
    vCasc: r.values.ref_casc__vgs,
  });
  const { mirror, casc, node, vRef, vCasc } = branch(res);

  it('solves the node between the output devices to where the cascode gate puts it', () => {
    // The output cascode's gate is the top of the reference stack and its source is the node, so
    // the node is that top less the gate-source voltage the cascode needs for its current. Formed
    // here from the sized voltages rather than read from the sheet's own equation for it, so an
    // equation that stopped saying this fails.
    expect(relErr(node, vRef + vCasc - casc.vgs)).toBeLessThan(1e-6);
    // What is solved is that node as a multiple of the reference device's diode drop, so that its
    // range of 0 to 2 follows the device; the node in volts is that multiple of the drop.
    expect(relErr(node, res.values.k_x * vRef)).toBeLessThan(1e-12);
    // The solve lands, so it has nothing to report.
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
  });

  it('the two output devices are in series: one current, and one node between them', () => {
    // The cascode is given the current the mirror device delivers, and that is the output current.
    expect(relErr(casc.id, mirror.id)).toBeLessThan(1e-12);
    expect(relErr(res.values.I_out, mirror.id)).toBeLessThan(1e-12);
    // The node is the mirror device's drain, and the cascode's source: its body bias, and what
    // is left of the output level is its drain-source voltage.
    expect(mirror.bias?.vds).toBeCloseTo(node, 12);
    expect(casc.bias?.vsb).toBeCloseTo(node, 12);
    expect(casc.bias?.vds).toBeCloseTo(V_OUT - node, 12);
    // The mirror device is on the reference device's gate, with its source at ground like it.
    expect(mirror.vgs).toBeCloseTo(vRef, 12);
    expect(mirror.bias?.vsb).toBe(0);
  });

  it('sizes each output device at exactly K times the matching reference width', () => {
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.out__W / res.values.ref__W, K)).toBeLessThan(1e-9);
    expect(relErr(res.values.W / res.values.ref_casc__W, K)).toBeLessThan(1e-9);
  });

  it('with the output level with the top of the reference stack, the output branch copies the reference branch', () => {
    // Every voltage on the output branch then equals its counterpart on the reference branch and
    // each output device is K reference devices side by side, so the node is the reference
    // device's diode drop, the cascode sits at the reference cascode's gate-source voltage and the
    // current is K times the reference current. That holds for any device, so it is the one
    // point where the solve has an exact answer.
    //
    // What is left is the grid's: the reference devices are read along the vds = vgs diagonal and
    // the output devices on a fixed-vds slice, which interpolate the same table differently and
    // disagree in the fifth decimal.
    const level = runSheet(withParams(doc, { V_out: vRef + vCasc }), table);
    const b = branch(level);
    expect(Math.abs(b.node - b.vRef)).toBeLessThan(1e-5);
    expect(Math.abs(b.casc.vgs - b.vCasc)).toBeLessThan(1e-5);
    expect(Math.abs(level.values.sys_err)).toBeLessThan(5e-5);
  });

  it('below that level the node settles under the reference diode drop, by a bracketed amount', () => {
    // No closed form here: the node is where two table currents cross. A bracket instead.
    //
    // Put the node on the reference device's diode drop. The cascode then has the reference
    // cascode's gate-source voltage and body bias, so K times its saturation current, but
    // V_out - vgs_ref across it where the reference cascode has its own gate-source voltage. It
    // carries a = (VA + V_out - vgs_ref)/(VA + vgs_casc) of K*I_in while the mirror device
    // delivers all of it. Lowering the node by d closes that gap three ways at once: the cascode
    // gains d of gate-source voltage and loses d of body bias, (1 + BODY_FACTOR)*gm*d; it gains d
    // of drain-source voltage, gds*d; and the mirror device loses d, its own gds*d. So
    //   d = (1 - a)*K*I_in / ((1 + BODY_FACTOR)*gm_casc + gds_casc + gds_mirror)
    // with the conductances taken somewhere along the way. They are least at the start, where
    // the cascode carries a*K*I_in at gm/ID 8 on a saturation current of K*I_in/(1 + vgs_casc/VA).
    // They never exceed gm/ID 8 on the whole K*I_in, since the level only falls as the overdrive
    // rises and the branch never carries more than K*I_in, with gds at the least drain-source
    // voltage the cascode sees. The mirror device's gds does not move. K*I_in cancels throughout.
    const a = (VA + V_OUT - vRef) / (VA + vCasc);
    const least = (1 + BODY_FACTOR) * 8 * a + 1 / (VA + vCasc) + 1 / (VA + vRef);
    const most = (1 + BODY_FACTOR) * 8 + 1 / (VA + V_OUT - vRef) + 1 / (VA + vRef);
    const drop = vRef - node;
    expect(drop).toBeGreaterThan((1 - a) / most);
    expect(drop).toBeLessThan((1 - a) / least);
    // The bracket is 6.8 to 7.3 mV, so a node left on the diode drop misses it by all of that.
    expect((1 - a) / most).toBeGreaterThan(6e-3);
  });

  it('systematic error is the mirror device channel-length modulation across the node offset', () => {
    // The mirror device shares the reference device's gate and source, so the two differ only in
    // drain voltage: the reference at its own diode drop, the mirror device at the node. Their
    // currents are in the ratio (VA + node)/(VA + vgs_ref), which is closed-form once the node is
    // in hand. The tolerance is the fifth-decimal disagreement between the diagonal and the slice.
    expect(Math.abs(res.values.sys_err - (node - vRef) / (VA + vRef))).toBeLessThan(5e-5);
    expect(relErr(res.values.I_out, (K * I_IN * (VA + node)) / (VA + vRef))).toBeLessThan(5e-5);
  });

  it('the K-times-larger output device halves the AREA term of the reference current spread', () => {
    // W_out = 4*W_ref at the same L, so the AREA term contributes exactly 1/2 — but not the
    // whole ratio. The output mirror device is sized on the reference's GATE, so its inversion
    // level is read off the table instead of being the authored 8, and the threshold term
    // carries the difference. It is the mirror device's level, not the cascode's, that counts.
    const level = res.values.out__gm_id;
    const expected = pelgromIrelRatio(level, 8, K, res.values.avt, res.values.abeta);
    expect(relErr(res.values.irel_out / res.values.irel_ref, expected)).toBeLessThan(1e-12);
    // On this table the two levels agree to the grid's own interpolation resolution, so the
    // ratio still sits within 4e-4 of 1/2. A real drift between the two gate-source voltages
    // would show up here as a far larger departure.
    expect(relErr(res.values.irel_out / res.values.irel_ref, 0.5)).toBeLessThan(1e-3);
  });

  it('the cascode multiplies the mirror r_o by its own local feedback factor, at the current it carries', () => {
    // Rout = r_o,casc*(1 + (gm + gmb)*r_o,mirror) + r_o,mirror — the mirror device's own output
    // resistance is what degenerates the cascode, playing the role a resistor plays in the
    // degenerated mirror. The mirror device's r_o is the width-mirrored closed form. The
    // cascode's is its current over VA plus the drain-source voltage it sits at, and that current
    // is the mirror device's at the node.
    const ro = roMirrored(vRef, K, I_IN);
    const id = (K * I_IN * (VA + node)) / (VA + vRef);
    const roCasc = 1 / gdsOf(id, 1e-6, V_OUT - node);
    // The cascode is given a width and a current, so its gm is what the table gives at the
    // density that lands — read back, as it is for any device given that way.
    const gm = res.values.gm;
    expect(relErr(res.values.Rout, roCasc * (1 + (gm + gmbOf(gm)) * ro) + ro)).toBeLessThan(1e-4);
    // What the model does fix is the range that gm is read in. The cascode runs the reference
    // cascode's saturation current density times
    //   r = (VA + node)(VA + vgs_casc) / ((VA + vgs_ref)(VA + V_out - node)),
    // 7 % more here, because it carries nearly the same current across less drain-source
    // voltage. Its level is therefore under the reference cascode's 8, and by no more than the
    // square-law factor 1/sqrt(r).
    const r = ((VA + node) * (VA + vCasc)) / ((VA + vRef) * (VA + V_OUT - node));
    expect(r).toBeGreaterThan(1.05);
    expect(res.values.gm_id).toBeGreaterThan(8 / Math.sqrt(r));
    expect(res.values.gm_id).toBeLessThan(8);
    // The whole point of the cascode: two orders of magnitude over the bare mirror.
    expect(res.values.Rout / ro).toBeGreaterThan(50);
  });

  it('the compliance floor is measured from the solved node, with the cascode at the overdrive it needs', () => {
    // Against the reference cascode, the output cascode has (vgs_ref - node) more gate-source
    // voltage — the same gate over a lower source — and that much less body bias. Its saturation
    // voltage is therefore the reference cascode's plus (1 + BODY_FACTOR) times that difference.
    const vdsat = res.values.ref_casc__vdsat + (1 + BODY_FACTOR) * (vRef - node);
    expect(Math.abs(res.values.vdsat - vdsat)).toBeLessThan(1e-6);
    const floor = res.checks.find((c) => c.id === 'compliance')!;
    expect(floor.lhsValue).toBe(V_OUT);
    expect(Math.abs(floor.rhsValue - (node + vdsat + res.values.v_margin))).toBeLessThan(1e-6);
    expect(floor.status).toBe('pass');
  });

  it('holds away from the defaults, with the mirror and the cascode at different lengths and levels', () => {
    // At the defaults the two lengths and the two inversion levels coincide, so a statement that
    // read the wrong one of a pair would still pass above. Here they differ.
    const over = { K: 2, gm_id_m: 6, gm_id_c: 10, L_c: 0.5e-6, V_out: 1.2 };
    const off = runSheet(withParams(doc, over), table);
    const b = branch(off);
    expect(b.mirror.L).toBe(1e-6);
    expect(b.casc.L).toBe(over.L_c);
    expect(relErr(off.values.out__W / off.values.ref__W, over.K)).toBeLessThan(1e-9);
    expect(relErr(off.values.W / off.values.ref_casc__W, over.K)).toBeLessThan(1e-9);
    // The same node identity and the same series connection.
    expect(relErr(b.node, b.vRef + b.vCasc - b.casc.vgs)).toBeLessThan(1e-6);
    expect(relErr(b.casc.id, b.mirror.id)).toBeLessThan(1e-12);
    expect(b.mirror.bias?.vds).toBeCloseTo(b.node, 12);
    expect(b.casc.bias?.vsb).toBeCloseTo(b.node, 12);
    expect(b.casc.bias?.vds).toBeCloseTo(over.V_out - b.node, 12);
    // The output current through the MIRROR device's Early voltage, the cascode's r_o through
    // its own, and the floor from the node.
    const id = (over.K * I_IN * (VA + b.node)) / (VA + b.vRef);
    expect(relErr(off.values.I_out, id)).toBeLessThan(5e-5);
    expect(relErr(off.values.gds, gdsOf(id, over.L_c, over.V_out - b.node))).toBeLessThan(1e-4);
    const vdsat = off.values.ref_casc__vdsat + (1 + BODY_FACTOR) * (b.vRef - b.node);
    const floor = off.checks.find((c) => c.id === 'compliance')!;
    expect(Math.abs(floor.rhsValue - (b.node + vdsat + off.values.v_margin))).toBeLessThan(1e-6);
    // The level the sheet's own check holds against the ceiling is the cascode's.
    expect(off.checks.find((c) => c.id === 'feasible-inversion')!.lhsValue).toBe(over.gm_id_c);
  });
});

describe('tier-2 goldens: wide-swing cascode mirror', () => {
  const doc = sheet('wide-swing-cascode-mirror.json');
  const res = runSheet(doc, table);
  // Defaults: I_in 20 µA, K = 4, gm/ID 10 on the reference device and the reference cascode,
  // L = L_c = 1 µm, output at 0.6 V, node_margin 50 mV. The reference node is solved to the
  // reference device's own saturation voltage plus the margin, and the cascode gate bias is the
  // reference cascode's gate-source voltage above that node. The sheet's own device is the output
  // cascode; the block `out` is the output mirror device under it, and the node between the two is
  // solved, as a fraction of the cascode gate bias.
  const K = 4;
  const I_IN = 20e-6;
  const V_OUT = 0.6;
  const VA = va(1e-6);

  /** The two branches of a run in the terms every golden below is written in: the output devices
   *  as sized, the node between them, the reference node and the reference device's gate, and the
   *  cascode gate bias — read from the result, as every mirror golden reads a solved node. */
  const branch = (r: SheetResult) => ({
    mirror: r.blocks!.find((b) => b.name === 'out')!.sizing!,
    refCasc: r.blocks!.find((b) => b.name === 'ref_casc')!.sizing!,
    casc: r.sizing!,
    node: r.values.V_x,
    lo: r.values.vds_lo,
    vRef: r.values.ref__vgs,
    bias: r.values.V_bias,
  });
  const { mirror, refCasc, casc, node, lo, vRef, bias } = branch(res);

  it('solves the reference node to the saturation knee plus the stated margin', () => {
    // The solve closes when the node equals what it names, to the search's own tolerance:
    // SOLVE_TOL_REL of the 1.8 V range it is searched in. The authored 0.3 is never read.
    expect(Math.abs(lo - res.values.wideswing_node)).toBeLessThanOrEqual(SOLVE_TOL_REL * 1.8);
    expect(Math.abs(lo - (res.values.ref__vdsat + 0.05))).toBeLessThanOrEqual(SOLVE_TOL_REL * 1.8);
    // In the demo model the saturation voltage is 2·UT plus the overdrive, and gm/ID 10 is an
    // overdrive of 0.183481 V at any length, so the node is 0.285211 V; the table reads the
    // overdrive on a 10 mV gate grid, about 3e-5 V off.
    expect(Math.abs(lo - (2 * UT + 0.183481 + 0.05))).toBeLessThan(1e-4);
    // So the reference device's own saturation margin is exactly the margin the bias is designed
    // for, and the region it declares reads that.
    const refRegion = res
      .blocks!.find((b) => b.name === 'ref')!
      .checks.find((c) => c.id === 'region')!;
    expect(refRegion.status).toBe('pass');
    expect(Math.abs(refRegion.lhsValue - refRegion.rhsValue - 0.05)).toBeLessThanOrEqual(
      SOLVE_TOL_REL * 1.8,
    );
  });

  it('the reference cascode stands on the reference node with its drain on the shared gate', () => {
    // The input current enters at the gate the two mirror devices share, which is the reference
    // cascode's drain; its source is the reference node. So it is read at a drain-source voltage
    // of the reference device's gate less that node, with that node as its body bias.
    expect(refCasc.id).toBe(res.values.ref__id);
    expect(refCasc.bias?.vsb).toBeCloseTo(lo, 12);
    expect(refCasc.bias?.vds).toBeCloseTo(vRef - lo, 12);
    // At the reference device's inversion level it needs BODY_FACTOR·lo more gate-source voltage
    // than the reference device does; the body bias falls between two slices of the table, which
    // interpolates it to about 0.2 mV (see the fixture table's note).
    expect(Math.abs(refCasc.vgs - vgsAtBody(vRef, lo))).toBeLessThan(2e-4);
    // The cascode gate bias is that gate-source voltage above the reference node, and the supply
    // has to produce it.
    expect(bias).toBeCloseTo(refCasc.vgs + lo, 12);
    const realizable = res.checks.find((c) => c.id === 'vbias-realizable')!;
    expect([realizable.lhsValue, realizable.status]).toEqual([bias, 'pass']);
  });

  it('solves the node between the output devices to where the cascode gate puts it', () => {
    // The output cascode's gate is the cascode bias and its source is the node, so the node is
    // that bias less the gate-source voltage the cascode needs for its current. Formed here from
    // the sized voltages rather than read from the sheet's own equation for it.
    expect(relErr(node, bias - casc.vgs)).toBeLessThan(1e-6);
    // What is solved is that node as a fraction of the bias, so that its range of 0 to 1 is
    // ground to the cascode gate whatever the table; the node in volts is that fraction of it.
    expect(relErr(node, res.values.k_x * bias)).toBeLessThan(1e-12);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
  });

  it('the two output devices are in series: one current, and one node between them', () => {
    expect(relErr(casc.id, mirror.id)).toBeLessThan(1e-12);
    expect(relErr(res.values.I_out, mirror.id)).toBeLessThan(1e-12);
    // The node is the mirror device's drain and the cascode's source: its body bias, and what is
    // left of the output level is its drain-source voltage.
    expect(mirror.bias?.vds).toBeCloseTo(node, 12);
    expect(casc.bias?.vsb).toBeCloseTo(node, 12);
    expect(casc.bias?.vds).toBeCloseTo(V_OUT - node, 12);
    // The mirror device is on the reference device's gate, with its source at ground like it.
    expect(mirror.vgs).toBeCloseTo(vRef, 12);
    expect(mirror.bias?.vsb).toBe(0);
  });

  it('sizes each output device at exactly K times the matching reference width', () => {
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.out__W / res.values.ref__W, K)).toBeLessThan(1e-9);
    expect(relErr(res.values.W / res.values.ref_casc__W, K)).toBeLessThan(1e-9);
  });

  it('with the output level with the reference cascode drain, the output branch copies the reference branch', () => {
    // Every voltage on the output branch then equals its counterpart on the reference branch and
    // each output device is K reference devices side by side, so the node is the reference node,
    // the cascode sits at the reference cascode's gate-source voltage and the current is K times
    // the reference current — the one point where the solve has an exact answer for any device.
    const level = runSheet(withParams(doc, { V_out: vRef }), table);
    const b = branch(level);
    expect(Math.abs(b.node - b.lo)).toBeLessThan(1e-6);
    expect(Math.abs(b.casc.vgs - b.refCasc.vgs)).toBeLessThan(1e-6);
    expect(Math.abs(level.values.sys_err)).toBeLessThan(1e-6);
  });

  it('above that level the node settles over the reference node, by a bracketed amount', () => {
    // No closed form here: the node is where two table currents cross. A bracket instead, at an
    // output of 1.2 V, 0.58 V above the level.
    //
    // Put the node on the reference node. The output cascode then has the reference cascode's
    // gate-source voltage and body bias, so K times its saturation current, but V_out − lo across
    // it where the reference cascode has vgs_ref − lo. It would carry
    // a = (VA + V_out − lo)/(VA + vgs_ref − lo) of K*I_in while the mirror device delivers K*I_in.
    // Raising the node by d closes that gap three ways at once: the cascode loses d of
    // gate-source voltage and gains d of body bias, (1 + BODY_FACTOR)*gm*d; it loses d of
    // drain-source voltage, gds*d; and the mirror device gains d, its own gds*d. So
    //   d = (a − 1)*K*I_in / ((1 + BODY_FACTOR)*gm_casc + gds_casc + gds_mirror)
    // with the conductances taken somewhere along the way. The cascode's gm is at least gm/ID 10 on
    // K*I_in, since its level only rises as its overdrive falls and it never carries less than the
    // mirror device's K*I_in, and at most gm/ID 10 on a*K*I_in, where it starts. Its gds lies
    // between K*I_in over the most drain-source voltage it has and a*K*I_in over none; the mirror
    // device's gds does not move. K*I_in cancels throughout.
    const vOut = 1.2;
    const up = runSheet(withParams(doc, { V_out: vOut }), table);
    const b = branch(up);
    const a = (VA + vOut - b.lo) / (VA + b.vRef - b.lo);
    const least = (1 + BODY_FACTOR) * 10 + 1 / (VA + vOut - b.lo) + 1 / (VA + b.lo);
    const most = (1 + BODY_FACTOR) * 10 * a + a / VA + 1 / (VA + b.lo);
    const rise = b.node - b.lo;
    expect(rise).toBeGreaterThan((a - 1) / most);
    expect(rise).toBeLessThan((a - 1) / least);
    // The bracket is 7.9 to 8.8 mV, so a node left on the reference node misses it by all of that.
    expect((a - 1) / most).toBeGreaterThan(7e-3);
    // At the 0.6 V default, 21 mV under the level, the node settles a third of a millivolt under the
    // reference node.
    expect(lo - node).toBeGreaterThan(0);
    expect(lo - node).toBeLessThan(1e-3);
  });

  it('systematic error is the output mirror device channel-length modulation across the node offset', () => {
    // The two mirror devices share a gate and a source and differ only in drain voltage: the
    // reference at the reference node, the output mirror device at the solved node. In the demo
    // model their currents are then in the ratio (VA + node)/(VA + lo), and both drain voltages
    // are read on slices of the table along which its current is exactly linear, so the error is
    // that ratio less one to rounding.
    expect(Math.abs(res.values.sys_err - (node - lo) / (VA + lo))).toBeLessThan(1e-12);
    expect(relErr(res.values.I_out, (K * I_IN * (VA + node)) / (VA + lo))).toBeLessThan(1e-12);
    // The output sits under the level, so the output branch delivers a little under K*I_in.
    expect(res.values.sys_err).toBeLessThan(0);
  });

  it('the K-times-larger output device halves the AREA term of the reference current spread', () => {
    // W_out = 4*W_ref at the same L, so the AREA term contributes exactly 1/2 — but not the whole
    // ratio. The output mirror device is sized on the reference's GATE, so its inversion level is
    // read off the table instead of being the authored 10, and the threshold term carries the
    // difference. It is the mirror device's level, not the cascode's, that counts.
    const level = res.values.out__gm_id;
    const expected = pelgromIrelRatio(level, 10, K, res.values.avt, res.values.abeta);
    expect(relErr(res.values.irel_out / res.values.irel_ref, expected)).toBeLessThan(1e-12);
    expect(relErr(res.values.irel_out / res.values.irel_ref, 0.5)).toBeLessThan(1e-3);
  });

  it('output resistance is the cascode boost over the output mirror device, at the current it carries', () => {
    // Rout = r_o,casc*(1 + (gm + gmb)*r_o,mirror) + r_o,mirror. The mirror device's r_o is the
    // width-mirrored closed form from the reference node: its saturation current is K times the
    // reference's, whatever drain voltage it sits at. The cascode's is its current over VA plus
    // the drain-source voltage it sits at, and that current is the mirror device's at the node.
    const ro = roMirrored(lo, K, I_IN);
    const id = (K * I_IN * (VA + node)) / (VA + lo);
    const roCasc = 1 / gdsOf(id, 1e-6, V_OUT - node);
    // The cascode is given a width and a current, so its gm is what the table gives at the
    // density that lands — read back, as it is for any device given that way.
    const gm = res.values.gm;
    expect(relErr(res.values.Rout, roCasc * (1 + (gm + gmbOf(gm)) * ro) + ro)).toBeLessThan(1e-4);
    expect(res.values.Rout / ro).toBeGreaterThan(50);
  });

  it('the output cascode holds the output above its compliance floor, measured from the solved node', () => {
    // Against the reference cascode, the output cascode has (lo − node) more gate-source voltage
    // — the same gate over a lower source — and that much less body bias. Its saturation voltage
    // is therefore the reference cascode's plus (1 + BODY_FACTOR) times that difference, and the
    // floor is the node plus it: two stacked saturation voltages and the node margin.
    const vdsat = res.values.ref_casc__vdsat + (1 + BODY_FACTOR) * (lo - node);
    expect(Math.abs(res.values.vdsat - vdsat)).toBeLessThan(1e-6);
    expect(Math.abs(res.values.V_out_min - (node + vdsat))).toBeLessThan(1e-6);
    // The region the output cascode declares is that floor: its drain-source voltage, the output
    // less the node, against its saturation voltage.
    const region = res.checks.find((c) => c.id === 'region')!;
    expect([region.kind, region.status]).toEqual(['physical', 'pass']);
    expect(region.lhsValue).toBeCloseTo(V_OUT - node, 12);
    expect(region.rhsValue).toBe(res.values.vdsat);
    expect(res.checks.map((c) => c.id)).not.toContain('compliance');
    // An output under the floor puts the cascode out of saturation, and the design fails there.
    const low = runSheet(withParams(doc, { V_out: 0.45 }), table);
    expect(low.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    expect(low.checks.find((c) => c.id === 'region')!.status).toBe('fail');
    expect(low.feasible).toBe(false);
  });
});

describe('tier-2 goldens: degenerated current mirror', () => {
  const doc = sheet('degenerated-current-mirror.json');
  const res = runSheet(doc, table);
  // Defaults: I_in 20 µA, K = 1, R_s = 5 kΩ, L = 1 µm, gm/ID 8, output at 0.9 V. The reference
  // leg's resistor drops I_in·R_s = 0.1 V exactly, since its current is the typed one. The output
  // device's source is solved: it sits where the device's own current through R_s/K drops it.
  const VA = VA_PER_L * 1e-6;
  const V_DEG = 0.1;

  /** The demo model's EKV saturation current at an overdrive, up to the device's specific current,
   *  and its gm/ID: i = softplus(x)², x = vov/(2·n·UT), n = 1.3 (src/demo). */
  const N_SLOPE = 1.3;
  const softplus = (x: number): number => (x > 30 ? x : Math.log1p(Math.exp(x)));
  const ekv = (vov: number): number => softplus(vov / (2 * N_SLOPE * UT)) ** 2;
  const gmIdAt = (vov: number): number => {
    const x = vov / (2 * N_SLOPE * UT);
    return 1 / (1 + Math.exp(-x)) / (N_SLOPE * UT * softplus(x));
  };
  /** The root of a function that changes sign once across [lo, hi], by bisection. */
  const root = (f: (x: number) => number, lo: number, hi: number): number => {
    const neg = f(lo) < 0;
    for (let i = 0; i < 200; i++) {
      const m = (lo + hi) / 2;
      if (f(m) < 0 === neg) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };

  /** The systematic error the model gives, written out independently of the engine. Both devices
   *  share one gate. The output device's source sits u above the reference's, so it has u less
   *  gate-source voltage and u more body bias: its overdrive is (1 + BODY_FACTOR)·u under the
   *  reference's. Its current is then K·I_in times the saturation-current ratio at the two
   *  overdrives times the channel-length-modulation ratio at the two drain voltages, and that
   *  current through R_s/K must drop V_DEG + u: u = V_DEG·(ratio − 1). The reference's overdrive is
   *  the one gm/ID gm_id_m names, and its drain is its own diode drop, read from the run. */
  const closedForm = (r: SheetResult, vOut: number, vDeg: number, gmId: number): number => {
    const vov = root((v) => gmIdAt(v) - gmId, -0.5, 1.5);
    const vRef = r.values.ref__vgs;
    const ratio = (u: number): number =>
      (ekv(vov - (1 + BODY_FACTOR) * u) / ekv(vov)) * ((VA + vOut - vDeg - u) / (VA + vRef));
    return root((u) => vDeg + u - vDeg * ratio(u), -vDeg, vDeg) / vDeg;
  };
  /** What the sheet reported before its source node was solved: the drain-voltage mismatch alone,
   *  with the output device's source taken to sit where the reference's does. */
  const bare = (r: SheetResult, vOut: number, vDeg: number): number =>
    (VA + vOut - vDeg) / (VA + r.values.ref__vgs) - 1;

  it("solves the output device's source to where its own current through R_s/K puts it", () => {
    expect(relErr(res.values.V_s, res.values.I_out * res.values.R_s_out)).toBeLessThan(1e-5);
    // The node is solved as a multiple of the reference leg's drop, and the current through R_s/K
    // over that drop is the current over its target — so the multiple is one plus the error.
    expect(relErr(res.values.k_s, 1 + res.values.sys_err)).toBeLessThan(1e-5);
    expect(relErr(res.values.V_s, res.values.k_s * V_DEG)).toBeLessThan(1e-12);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
  });

  it("the output device is on the reference's gate: its gate-source voltage is that gate less its source", () => {
    // The shared gate sits at the reference's diode drop above the reference's own lifted source.
    const out = res.sizing!;
    expect(out.vgs).toBeCloseTo(res.values.ref__vgs + V_DEG - res.values.V_s, 12);
    expect(out.bias?.vsb).toBeCloseTo(res.values.V_s, 12);
    expect(out.bias?.vds).toBeCloseTo(0.9 - res.values.V_s, 12);
    // Its saturation region is the compliance floor: the output must clear the resistor drop and
    // the device's own saturation voltage.
    const region = res.checks.find((c) => c.id === 'region')!;
    expect([region.kind, region.status]).toEqual(['physical', 'pass']);
    expect(region.lhsValue).toBeCloseTo(0.9 - res.values.V_s, 12);
    expect(region.rhsValue).toBe(res.values.vdsat);
    expect(res.values.V_out_min).toBeCloseTo(res.values.V_s + res.values.vdsat, 12);
    expect(res.checks.map((c) => c.id)).not.toContain('compliance');
  });

  it('systematic error is the drain-voltage mismatch, divided down by the degeneration', () => {
    // The closed form is the model's own; the engine reads the table, which interpolates the
    // current on a 10 mV gate grid, so the two agree to about 1 % of this error (7e-5 absolute).
    const err = closedForm(res, 0.9, V_DEG, 8);
    expect(relErr(res.values.sys_err, err)).toBeLessThan(2e-2);
    // The bare drain-voltage mismatch is 1.77 %; the source the output current lifts takes back
    // gate-source voltage, and the error is about half that: 0.89 %. Reporting the bare figure
    // overstates it by the local-feedback factor, 1 + (1 + BODY_FACTOR)·(gm/ID)·I_in·R_s ≈ 2.
    expect(bare(res, 0.9, V_DEG)).toBeGreaterThan(1.9 * res.values.sys_err);
    expect(bare(res, 0.9, V_DEG)).toBeLessThan(2.1 * res.values.sys_err);
  });

  it('holds under the level and with a larger resistor, where the feedback divides more', () => {
    // An output at 0.5 V sits under the reference's drain, so the output leg carries less, and its
    // source settles under the reference's; the error changes sign and keeps its closed form.
    const low = runSheet(withParams(doc, { V_out: 0.5 }), table);
    expect(low.values.sys_err).toBeLessThan(0);
    expect(low.values.V_s).toBeLessThan(V_DEG);
    expect(relErr(low.values.sys_err, closedForm(low, 0.5, V_DEG, 8))).toBeLessThan(2e-2);
    // R_s = 20 kΩ drops 0.4 V; the feedback factor is then near 5, and so is the overstatement.
    const deep = runSheet(withParams(doc, { R_s: 20e3 }), table);
    expect(relErr(deep.values.sys_err, closedForm(deep, 0.9, 0.4, 8))).toBeLessThan(2e-2);
    expect(bare(deep, 0.9, 0.4) / deep.values.sys_err).toBeGreaterThan(4.5);
  });

  it('sizes the output device width-first at K times the reference width', () => {
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.W / res.values.ref__W, 1)).toBeLessThan(1e-9);
  });

  it('output resistance is boosted by the local-feedback factor (1 + (gm + gmb)·R_s_out)', () => {
    // (Rout − R_s_out)·gds should equal 1 + (gm + gmb)·(R_s/K); R_s/K = 5 kΩ at K = 1. Both
    // source-referred generators feed back through the resistor.
    const boost = 1 + (res.values.gm + gmbOf(res.values.gm)) * 5000;
    expect(relErr((res.values.Rout - 5000) * res.values.gds, boost)).toBeLessThan(1e-3);
  });
});

/** The root of a function that changes sign once on [lo, hi], by bisection. */
const rootOf = (f: (x: number) => number, lo: number, hi: number): number => {
  const sLo = Math.sign(f(lo));
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(f(mid)) === sLo) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

describe('tier-2 goldens: Widlar current source', () => {
  const res = runSheet(sheet('widlar-current-source.json'), table);
  // Defaults: I_in 20 µA, R_s 10 kΩ, M_ratio 1, L = 1 µm, gm/ID 8 on the reference, V_out 0.9 V.
  // The output current is solved: it is the current at which the output device, the reference's
  // width on the reference's gate, sits exactly I_out*R_s below the reference's gate-source
  // voltage. On the demo model that fixed point is closed form apart from one root:
  //   reference   vgs_ref = vgs at gm/ID 8 (L 1 µm), a diode, so vds_ref = vgs_ref
  //   output      saturation current I_out/(1 + vds_out/VA) at the reference's width, with
  //               vds_out = V_out − I_out·R_s and the source lifted I_out·R_s above the body, so
  //               vgs_out = vgsForCurrentRatio(vgs_ref, ratio) + BODY_FACTOR·I_out·R_s, where the
  //               ratio is that saturation current over the reference's, I_in/(1 + vds_ref/VA)
  //   fixed point vgs_ref − vgs_out = I_out·R_s
  const L = 1e-6;
  const VA = va(L);
  const vgsRef = vgsAtGmId(8, L);
  const vgsOut = (I: number): number => {
    const ratio = I / (1 + (0.9 - I * 10000) / VA) / (20e-6 / (1 + vgsRef / VA));
    return vgsForCurrentRatio(vgsRef, ratio, L) + BODY_FACTOR * I * 10000;
  };
  const I_OUT = rootOf((I) => vgsRef - vgsOut(I) - I * 10000, 1e-6, 20e-6);

  it('solves the output current at the Widlar fixed point', () => {
    // 8.04 µA here: the reference's 20 µA stepped down by the gate-source difference R_s develops.
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.I_out, I_OUT)).toBeLessThan(1e-3);
    expect(res.values.id).toBe(res.values.I_out);
    // The identity the search makes hold, to the search's own tolerance, and the rule reading it.
    expect(Math.abs(res.values.delta_vgs - res.values.vgs_drop)).toBeLessThan(1e-6);
    expect(res.checks.find((c) => c.id === 'widlar-fixed-point')!.status).toBe('pass');
    expect(res.feasible).toBe(true);
  });

  it('sizes the output device at M_ratio times the reference width', () => {
    expect(relErr(res.values.W / res.values.ref__W, 1)).toBeLessThan(1e-9);
  });

  it('the output device steps down: its vgs sits below the reference vgs by the IR drop', () => {
    // Same width, less than half the current ⇒ lower density ⇒ lower vgs ⇒ positive step.
    expect(relErr(res.values.ref__vgs, vgsRef)).toBeLessThan(1e-3);
    expect(relErr(res.values.vgs, vgsOut(I_OUT))).toBeLessThan(1e-3);
    expect(res.values.delta_vgs).toBeGreaterThan(0);
    expect(res.values.I_out).toBeLessThan(res.values.I_in);
  });

  it('output resistance carries the degeneration boost, same form as the degenerated mirror', () => {
    // The output device is given (W, id), not by gm/ID, so its gm is what the table gives at
    // the density that lands — read it back, exactly as the degenerated-mirror golden does. What
    // this test owns is the model's gds (id/(VA + vds), with the source lifted I_out*R_s) and the
    // Rout algebra: the boost factor carries BOTH source-referred generators, and the resistor's
    // own series contribution is added back.
    const I = res.values.I_out;
    const ro = (VA + (0.9 - I * 10000)) / I;
    const boost = 1 + (res.values.gm + gmbOf(res.values.gm)) * 10000;
    expect(relErr(res.values.Rout, ro * boost + 10000)).toBeLessThan(1e-3);
  });
});

describe('tier-2 goldens: beta-multiplier bias', () => {
  const res = runSheet(sheet('beta-multiplier-bias.json'), table);
  // Defaults: K_bm = 4, R_bias 5 kΩ, L = 1 µm, gm/ID 8 on the diode device, V_dm2 0.9 V. The loop
  // current is solved. The diode device is sized at gm/ID 8 whatever its current, so its
  // gate-source voltage is vgs(8) at 1 µm and only its width follows the current; the
  // resistor-side device is four of those widths at the same current, a quarter of the current
  // density, with its source lifted I·R above the body:
  //   vgs_2 = vgsForCurrentRatio(vgs_1, (1 + vgs_1/VA)/(4·(1 + vds_2/VA))) + BODY_FACTOR·I·R,
  //   vds_2 = V_dm2 − I·R
  //   fixed point vgs_1 − vgs_2 = I·R
  const L = 1e-6;
  const VA = va(L);
  const vgs1 = vgsAtGmId(8, L);
  const vgs2 = (I: number): number =>
    vgsForCurrentRatio(vgs1, (1 + vgs1 / VA) / (4 * (1 + (0.9 - I * 5000) / VA)), L) +
    BODY_FACTOR * I * 5000;
  const I_BIAS = rootOf((I) => vgs1 - vgs2(I) - I * 5000, 1e-6, 100e-6);

  it('the constant-gm identity is pure param arithmetic', () => {
    // gm_target = (2/R_bias)(1 − 1/√K_bm) = (2/5000)(1 − 1/2) = 2e-4 S.
    const gmTarget = (2 / 5000) * (1 - 1 / Math.sqrt(4));
    expect(relErr(res.values.gm_target, gmTarget)).toBeLessThan(1e-9);
  });

  it('sizes the resistor-side device at K_bm times the diode-device width', () => {
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.W / res.values.m1__W, 4)).toBeLessThan(1e-9);
  });

  it('solves the loop current at the self-bias fixed point, and both legs carry it', () => {
    // 22.2 µA here. The diode device's gm is then gm/ID 8 times that current, 178 µS, inside the
    // 25 % band of the square-law identity's 200 µS. The root moves by the table's interpolation
    // error in the two gate-source voltages over R·(1 + BODY_FACTOR) — about 0.2 mV over the
    // 0.13 V the loop drops here, so it is held to 2e-3, not to the 1e-3 a sized current gets.
    expect(relErr(res.values.I_bias, I_BIAS)).toBeLessThan(2e-3);
    expect(res.values.id).toBe(res.values.I_bias);
    expect(res.values.m1__id).toBe(res.values.I_bias);
    expect(Math.abs(res.values.delta_vgs - res.values.vgs_drop)).toBeLessThan(1e-6);
    expect(relErr(res.values.m1__gm, 8 * res.values.I_bias)).toBeLessThan(1e-9);
    expect(res.checks.find((c) => c.id === 'gm-identity')!.status).toBe('pass');
    expect(res.feasible).toBe(true);
  });
});

describe('tier-2 goldens: matched mirror bank', () => {
  const res = runSheet(sheet('matched-mirror-bank.json'), table);
  // Defaults: I_unit 10 µA, N_legs = 8, L = 1 µm, gm/ID 8, unit diode at 0.7 V,
  // output rail at 0.9 V. VA = 5 V.

  it('sizes the bank at exactly N_legs unit widths', () => {
    expect(res.sizing?.ok).toBe(true);
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

// Each mirror and bias device the design needs saturated states it, and nothing is declared on a
// diode-connected device, whose drain is its gate. The engine then holds each declared device to it
// with a physical check of its own, `region`, comparing the drain-source voltage the givens state
// against the device's saturation voltage. A compliance floor that is that comparison with no
// margin is therefore not written as a check of its own; the cascode mirror's carries a design
// margin, so it is.
describe('tier-2: the regions the mirror and bias devices declare', () => {
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

  // Per sheet: each declaring device and the drain-source voltage its region compares, written
  // from the schematic and read back from the run; then the hand-written checks it replaced.
  const CASES: Record<string, [Record<string, (r: SheetResult) => number>, string[]]> = {
    'simple-mirror.json': [{ '': (r) => r.values.V_out }, ['compliance']],
    'matched-mirror-bank.json': [{ '': (r) => r.values.V_out }, ['compliance']],
    'widlar-current-source.json': [
      { '': (r) => r.values.V_out - r.values.I_out * r.values.R_s },
      ['compliance'],
    ],
    'beta-multiplier-bias.json': [
      { '': (r) => r.values.V_dm2 - r.values.I_bias * r.values.R_bias },
      [],
    ],
    'degenerated-current-mirror.json': [
      { '': (r) => r.values.V_out - r.values.V_s },
      ['compliance'],
    ],
    'cascode-current-mirror.json': [
      { out: (r) => r.values.V_x, '': (r) => r.values.V_out - r.values.V_x },
      [],
    ],
    'wide-swing-cascode-mirror.json': [
      {
        ref: (r) => r.values.vds_lo,
        ref_casc: (r) => r.values.ref__vgs - r.values.vds_lo,
        out: (r) => r.values.V_x,
        '': (r) => r.values.V_out - r.values.V_x,
      },
      ['compliance'],
    ],
  };

  it.each(Object.keys(CASES))('%s', (file) => {
    const [devices, replaced] = CASES[file];
    const doc = sheet(file);
    expect(declared(doc)).toEqual(
      Object.fromEntries(Object.keys(devices).map((d) => [d, 'saturation'])),
    );
    for (const id of replaced) expect(doc.checks.map((c) => c.id)).not.toContain(id);
    const res = runSheet(doc, table);
    for (const [device, vds] of Object.entries(devices)) {
      const { check, vdsat } = regionOf(res, device);
      expect([device, check.kind, check.op, check.status]).toEqual([
        device,
        'physical',
        '>=',
        'pass',
      ]);
      expect([device, relErr(check.lhsValue, Math.abs(vds(res))) < 1e-9]).toEqual([device, true]);
      if (vdsat !== undefined) expect(check.rhsValue).toBe(vdsat);
    }
  });

  it('the cascode mirror keeps its compliance check, which carries a margin the region does not', () => {
    // The compliance floor there is the node plus the cascode's saturation voltage plus v_margin,
    // so it is the stricter of the two and fails first; the region is the bare saturation edge.
    const res = runSheet(sheet('cascode-current-mirror.json'), table);
    const floor = res.checks.find((c) => c.id === 'compliance')!;
    const region = res.checks.find((c) => c.id === 'region')!;
    expect(floor.lhsValue - floor.rhsValue).toBeCloseTo(
      region.lhsValue - region.rhsValue - res.values.v_margin,
      12,
    );
  });
});
