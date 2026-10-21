// Compliance semantics: the fixed-hardware transformation, and what a fixed-hardware range check
// produces.
//
// The goldens here are HAND-DERIVED from the demo model's closed forms — vth(L, vsb) =
// 0.4 + 0.02·ln(L/0.18µ + 1) + BODY_FACTOR·vsb, VA = VA_PER_L·L, gds = id/(VA + vds), and the EKV
// inversion gm/ID = (1 − e^-s)/(n·U_T·s) at s = sqrt(iNorm), n = 1.3 — never read back off the
// engine.
//
// The table carries a vsb axis because a real characterization does, and because the body effect
// is the strongest way a range end moves a device that is not free to re-size. What SEPARATES a
// range end that re-biases from one that re-sizes, though, is the drain: this model's body effect
// is a pure threshold translation, so at a fixed drain voltage and a fixed current the two land
// on the same operating point and no assertion can tell them apart. Channel-length modulation is
// what breaks the tie. The tests below therefore split into a body-effect LAW (exact, and true
// under either reading) and two separation tests, both of which move a drain — one directly, one
// through the body effect on the sibling that sets it.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice, BODY_FACTOR } from '../demo';
import { compileExpr } from '../derive';
import { sizeDevice } from '../device';
import { scalarScope } from '../expr';
import { makeGrid } from '../grid';
import { fixTable } from '../series';
import type { DeviceTable } from '../types';
import {
  runSheet,
  evaluateSheet,
  heldOutcome,
  rangeEndCheck,
  sweepSheet,
  sheetSensitivities,
  validateSheet,
} from './index';
import { holdHardware } from './coverage';
// The closed forms, from the module the library goldens share — not the fixtures that re-export
// them, whose import walks sheets/ off disk and builds a demo table this suite does not use.
import { gdsOf, relErr } from './library.math';
import { clampedIn, stands, treeCheckResults } from './types';
import type { SizingReport, SheetBlockReport, SheetDoc } from './types';

/** A four-dimensional [l, vds, vsb, vgs] table — the shape a real PDK export has. The 0.05 V
 *  vsb step lands each body-effect threshold shift (BODY_FACTOR × step) exactly on the 0.01 V
 *  vgs lattice, so a translation golden is not fighting the interpolation. */
const dev = generateDemoDevice({
  vds: { min: 0, max: 1.2, step: 0.05 },
  vsb: { min: 0, max: 0.4, step: 0.05 },
});

// ---------------------------------------------------------------------------------------
// The transformation alone
// ---------------------------------------------------------------------------------------

describe('the fixed-hardware transformation — decided on which givens are present', () => {
  const report = (over: Partial<SizingReport> = {}): SizingReport => ({
    ok: true,
    W: 1.194e-6,
    L: 5e-7,
    vgs: 0.61,
    id: 2e-5,
    ...over,
  });
  const doc = (givens: SheetDoc['givens']): SheetDoc => ({
    title: 't',
    polarity: 'n',
    params: [{ name: 'I_d', value: 2e-5 }],
    equations: [{ name: 'r', expr: 'I_d * 2' }],
    checks: [{ id: 'x', kind: 'physical', lhs: 'r', op: '>=', rhs: '0' }],
    givens,
  });
  const hold = (
    givens: SheetDoc['givens'],
    r: SizingReport | undefined = report(),
  ): SheetDoc['givens'] => holdHardware(doc(givens), { sizing: r }).doc.givens;

  it('leaves width-first givens exactly as authored', () => {
    // Already fixed hardware. Its partner is how the sheet writes a gate tie, and under a move
    // that shifts vds alone — every move the library's range ends make — holding it reproduces the
    // tied device exactly. Dropping it would replace a wiring statement with an assumption.
    const b = { L: 'L_p', W: 'K*ref__W', gm_id: 'gm_id_m', vds: 'V_o' };
    expect(hold(b)).toEqual(b);
  });

  it('trades an authored selector for the solved width, and KEEPS the authored current', () => {
    // The current expression IS the hardware in the sheet's own algebra — a mirror ratio, a tail
    // split — so it re-evaluates at the range end on purpose. Only the operating-point spec goes.
    expect(hold({ L: 'L_p', gm_id: '10', id: 'I_tail/2', vds: 'V_o', vsb: 'V_t' })).toEqual({
      L: '5e-7',
      W: '0.000001194',
      id: 'I_tail/2',
      vds: 'V_o',
      vsb: 'V_t',
    });
  });

  it('holds the current too when the sheet never said where it comes from, and says so', () => {
    const p = holdHardware(doc({ L: 'L_p', gm: '2*pi*GBW*CL', gm_id: '10', vds: 'V_o' }), {
      sizing: report(),
    });
    expect(p.doc.givens).toEqual({ L: '5e-7', W: '0.000001194', id: '0.00002', vds: 'V_o' });
    expect(p.assumedSource).toEqual(['givens']);
  });

  it('drops EVERY operating-point target, not a hand-copied subset', () => {
    // The list is derived from the device module's own selectors; a selector left behind would
    // re-size the transistor at the range end, which is what a fixed-hardware check must not do.
    // A gate voltage is the one selector that is not a target, and has its own test below.
    for (const k of ['gm_id', 'ft', 'gm_gds', 'av0', 'vstar', 'gm']) {
      const out = hold({ L: 'L_p', [k]: '3', id: 'I_d', vds: 'V_o' });
      expect(Object.keys(out!).sort(), k).toEqual(['L', 'W', 'id', 'vds']);
    }
  });

  it('keeps a given gate voltage only where a hold balances the current — the declaration', () => {
    // An inverter's PMOS is written (id, vgs): the NMOS's current, at the gate voltage the supply
    // leaves. So is a device whose gate voltage is a typed operating point. The two are told apart
    // by what the sheet declares: a hold that reads this device's current (`id`, for the sheet's
    // own device) balances it, and then the gate is what stays where the design is held and the
    // current is read from the table — not kept, and not reported as assumed either.
    const tied = (hold?: string): SheetDoc => ({
      ...doc({ L: 'L_p', id: 'n__id', vgs: 'VDD - n__vgs', vds: 'V_o', region: 'saturation' }),
      params: [{ name: 'I_d', value: 2e-5, min: 1e-6, max: 1e-4, ...(hold ? { hold } : {}) }],
    });
    const balanced = holdHardware(tied('I_d - id'), { sizing: report(), held: { I_d: 0 } });
    expect(balanced.doc.givens).toEqual({
      L: '5e-7',
      W: '0.000001194',
      vgs: 'VDD - n__vgs',
      vds: 'V_o',
      region: 'saturation',
    });
    expect(balanced.assumedSource).toEqual([]);
    // Undeclared, the gate voltage is an operating-point spec like any other: held at the width
    // and the current, as it always was.
    const asBefore = {
      L: '5e-7',
      W: '0.000001194',
      id: 'n__id',
      vds: 'V_o',
      region: 'saturation',
    };
    expect(holdHardware(tied(), { sizing: report() }).doc.givens).toEqual(asBefore);
    // A hold that reads no current declares nothing about one.
    expect(
      holdHardware(tied('I_d + vgs'), { sizing: report(), held: { I_d: 0 } }).doc.givens,
    ).toEqual(asBefore);
    // Whatever a balanced gate voltage was paired with goes the same way, a transconductance
    // included.
    const gm = holdHardware(
      { ...tied('I_d - id'), givens: { L: 'L_p', gm: '1e-4', vgs: '0.6', vds: 'V_o' } },
      { sizing: report(), held: { I_d: 0 } },
    );
    expect(gm.doc.givens).toEqual({ L: '5e-7', W: '0.000001194', vgs: '0.6', vds: 'V_o' });
    // Beside a width, nothing is rewritten at all (the first test above), so a mirror's tie is
    // unchanged by this rule.
    expect(hold({ L: 'L_p', W: 'ref__W', vgs: 'ref__vgs', vds: 'V_o' })).toEqual({
      L: 'L_p',
      W: 'ref__W',
      vgs: 'ref__vgs',
      vds: 'V_o',
    });
  });

  it('holds the length the sizing used, not the authored expression', () => {
    // An L that reads a param a range end overrides would otherwise hand the range end a different
    // transistor while the report claimed the hardware was fixed.
    expect(hold({ L: 'L_min * ratio', gm_id: '10', id: 'I_d', vds: 'V_o' })!.L).toBe('5e-7');
  });

  it('injects numbers that parse back to the same double', () => {
    // A fixed-digit reformat would hold the design at a width the base run never sized.
    for (const W of [Math.PI * 1e-6, 1e-7, 1.2345678901234567e-9, 1e21, 5e-324]) {
      const given = { L: 'L_p', gm_id: '10', id: 'I_d', vds: 'V_o' };
      const expr = hold(given, report({ W }))!.W as string;
      expect(compileExpr(expr).eval(scalarScope({})), expr).toBe(W);
    }
  });

  it('keys the tree by index, so two blocks of one name still get their own hardware', () => {
    // evalBlocks pushes exactly one report per block, dead ones included, so the indices align —
    // while names can duplicate on a document that reached the engine without validation.
    const leaf = (id: string): SheetDoc => ({
      title: 'c',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      givens: { L: 'L_p', gm_id: '10', id, vds: 'V_o' },
    });
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        { name: 'dup', doc: leaf('I_a') },
        { name: 'dup', doc: leaf('I_b') },
      ],
    };
    const kids: SheetBlockReport[] = [
      {
        name: 'dup',
        title: 'c',
        feasible: true,
        sizing: report({ W: 1e-6 }),
        provides: {},
        checks: [],
      },
      {
        name: 'dup',
        title: 'c',
        feasible: true,
        sizing: report({ W: 2e-6 }),
        provides: {},
        checks: [],
      },
    ];
    const out = holdHardware(parent, { blocks: kids }).doc;
    expect(out.blocks?.map((u) => u.doc?.givens?.W)).toEqual(['0.000001', '0.000002']);
    expect(out.blocks?.map((u) => u.doc?.givens?.id)).toEqual(['I_a', 'I_b']);
  });

  it('leaves the givens alone when there is no hardware to hold them at', () => {
    // Degrade, never invent — the same discipline the rest of the engine takes. The caller gates
    // on the base run standing, so this is defence rather than a path in normal use.
    const b = { L: 'L_p', gm_id: '10', id: 'I_d', vds: 'V_o' };
    expect(holdHardware(doc(b), {}).doc.givens).toEqual(b); // no report at all
    expect(hold(b, report({ ok: false, W: NaN, L: NaN }))).toEqual(b);
  });

  it('touches nothing but the givens', () => {
    const p = holdHardware(doc({ L: 'L_p', gm_id: '10', id: 'I_d', diode: true }), {
      sizing: report(),
    }).doc;
    expect(p.params).toEqual([{ name: 'I_d', value: 2e-5 }]);
    expect(p.equations).toEqual([{ name: 'r', expr: 'I_d * 2' }]);
    expect(p.checks).toEqual([{ id: 'x', kind: 'physical', lhs: 'r', op: '>=', rhs: '0' }]);
    expect(p.givens?.diode).toBe(true); // wiring, not a sizing spec
  });
});

// ---------------------------------------------------------------------------------------
// A gate on a shared node, held at a condition where the thresholds moved
// ---------------------------------------------------------------------------------------

/** The same device with its threshold moved by `dv`: everything the table held at a gate voltage
 *  is now found `dv` higher. The vgs axis is shifted and the vth column with it — a process
 *  condition reduced to the one thing these tests need it to change. */
function shiftedThreshold(t: DeviceTable, dv: number): DeviceTable {
  const axisNames = new Set(t.grid.axes.map((a) => a.name));
  const axes = t.grid.axes.map((a) =>
    a.name === 'vgs' ? { name: a.name, values: a.values.map((v) => v + dv) } : a,
  );
  const quantities = new Map(
    [...t.grid.quantities]
      .filter(([k]) => !axisNames.has(k))
      .map(([k, c]) => [k, k === 'vth' ? c.map((v) => v + dv) : c] as const),
  );
  return { ...t, grid: makeGrid(axes, quantities) };
}

describe('a gate on a shared node keeps its supply where the design is held', () => {
  // The demo's gate-source voltage at gm/ID = 12, L = 0.5 µm, body grounded (the library's
  // VGS_GMID12_L05). With the supply at twice it and the output at half the supply, the inverter's
  // two devices sit at the same gate-source voltage and the same drain voltage on the same table,
  // so they size to the same width — and held on tables whose thresholds moved by dn and dp, the
  // currents balance where V_in - dn = VDD - V_in - dp: V_in = (VDD + dn - dp)/2, in closed form.
  const V0 = 0.567023;
  const VDD = 2 * V0;
  const L = 5e-7;
  const DN = 0.04; // the NMOS slower
  const DP = -0.02; // the PMOS faster

  /** The inverter-based OTA's two devices, in the library's spelling: the NMOS sized from the
   *  bias current and its gm/ID, the PMOS given that current and the gate voltage the supply
   *  leaves. `hold` goes on the typed current. */
  const inverter = (hold?: string): SheetDoc => ({
    title: 'inverter',
    polarity: 'n',
    params: [
      { name: 'VDD', value: VDD, unit: 'V', class: 'independent' },
      { name: 'V_out', value: V0, unit: 'V', class: 'independent' },
      { name: 'I_bias', value: 2e-5, min: 2e-6, max: 2e-4, unit: 'A', ...(hold ? { hold } : {}) },
    ],
    blocks: [
      {
        name: 'n',
        doc: {
          title: 'n',
          polarity: 'n',
          params: [
            { name: 'I_d', value: 2e-5, unit: 'A' },
            { name: 'vds_d', value: 0.5, unit: 'V' },
          ],
          givens: { L: String(L), id: 'I_d', gm_id: '12', vds: 'vds_d' },
          equations: [],
          checks: [],
          provides: ['vgs', 'id', 'W'],
        },
        params: { I_d: 'I_bias', vds_d: 'V_out' },
      },
      {
        name: 'p',
        device: 'pmos',
        doc: {
          title: 'p',
          polarity: 'p',
          params: [
            { name: 'I_d', value: 2e-5, unit: 'A' },
            { name: 'vgs_d', value: 0.5, unit: 'V' },
            { name: 'vds_d', value: 0.5, unit: 'V' },
          ],
          givens: { L: String(L), id: 'I_d', vgs: 'vgs_d', vds: 'vds_d' },
          equations: [],
          checks: [],
          provides: ['vgs', 'id', 'W'],
        },
        params: { I_d: 'n__id', vgs_d: 'VDD - n__vgs', vds_d: 'VDD - V_out' },
        wiring: { gate: 'V_in', source: 'VDD' },
      },
    ],
    equations: [{ name: 'V_in', expr: 'n__vgs', unit: 'V' }],
    checks: [],
  });

  const nHeld = shiftedThreshold(dev, DN);
  const pHeld = shiftedThreshold(dev, DP);
  /** Sized on the demo device for both halves, then held on the moved tables. */
  const heldRun = (doc: SheetDoc) => {
    const base = evaluateSheet(doc, dev, (id) => (id === 'pmos' ? dev : undefined));
    expect(stands(base)).toBe(true);
    const held = holdHardware(doc, base);
    return {
      base,
      held,
      res: evaluateSheet(held.doc, nHeld, (id) => (id === 'pmos' ? pHeld : undefined)),
    };
  };
  /** A device's current at a held width and gate voltage, read straight off a table. */
  const currentAt = (t: DeviceTable, W: number, vgs: number, vds: number): number =>
    sizeDevice({ table: fixTable(t, { vds, vsb: 0 }), L, W, vgs }).id;

  it('sizes the two halves alike at the design point, so the closed form applies', () => {
    // Alike to the gm/ID inversion's interpolation: the NMOS lands some 50 µV off V0, which
    // hands the PMOS 50 µV less and parts the widths by about 0.13 %. That moves the balance by
    // about 0.13 %/(2 gm/ID) ≈ 0.05 mV, well inside the 0.5 mV the closed form is held to below.
    const { base } = heldRun(inverter('I_bias - p__id'));
    expect(relErr(base.values.n__W, base.values.p__W)).toBeLessThan(2e-3);
    // The balance is zero there by construction: the PMOS was sized to carry the NMOS's current.
    expect(base.held).toEqual({ I_bias: 0 });
  });

  it('keeps the gate on its wire, balances the currents, and reports the input level', () => {
    const { held, res } = heldRun(inverter('I_bias - p__id'));
    expect(res.feasible).toBe(true);
    expect(res.warnings.filter((w) => w.severity !== 'info')).toEqual([]);
    const v = res.values;
    // The two gate-source voltages add up to the supply — the PMOS kept its gate expression.
    expect(v.n__vgs + v.p__vgs).toBeCloseTo(VDD, 12);
    // One current through both devices, to the search's tolerance.
    expect(relErr(v.n__id, v.p__id)).toBeLessThan(1e-5);
    // The input level the balance lands on, against the closed form; the bias current that
    // is solved for is the current both carry.
    expect(v.V_in).toBeCloseTo((VDD + DN - DP) / 2, 3);
    expect(v.V_in).toBe(v.n__vgs);
    expect(relErr(v.I_bias, v.n__id)).toBeLessThan(1e-12);
    // Read straight off the moved tables at the held widths and the reported gate voltages,
    // with no sheet in between, the two devices carry that current.
    const W = { n: held.doc.blocks?.[0].doc?.givens?.W, p: held.doc.blocks?.[1].doc?.givens?.W };
    const iN = currentAt(nHeld, Number(W.n), v.V_in, V0);
    const iP = currentAt(pHeld, Number(W.p), VDD - v.V_in, VDD - V0);
    expect(relErr(iN, v.I_bias)).toBeLessThan(1e-5);
    expect(relErr(iP, v.I_bias)).toBeLessThan(1e-5);
    // The NMOS lost overdrive (V_in - DN sits 10 mV below V0), so the current fell.
    expect(v.I_bias).toBeLessThan(0.95 * 2e-5);
  });

  it('holds the NMOS the old way, and the PMOS at its width and gate voltage', () => {
    const { held } = heldRun(inverter('I_bias - p__id'));
    const [n, p] = held.doc.blocks?.map((b) => b.doc?.givens) ?? [];
    expect(Object.keys(n ?? {}).sort()).toEqual(['L', 'W', 'id', 'vds']);
    expect(n?.id).toBe('I_d');
    expect(Object.keys(p ?? {}).sort()).toEqual(['L', 'W', 'vds', 'vgs']);
    expect(p?.vgs).toBe('vgs_d');
    expect(held.assumedSource).toEqual([]);
    // The typed current is re-solved where the design is held: the hold became its constraint.
    expect(held.doc.params.find((q) => q.name === 'I_bias')?.designConstraint).toEqual({
      lhs: 'I_bias - p__id',
      rhs: '0',
      held: true,
    });
  });

  const flagged = (doc: SheetDoc): string[] =>
    validateSheet(doc)
      .filter((w) => w.rule === 'sheet-held-current')
      .map((w) => `${w.severity} ${w.location}`);
  /** The inverter with the PMOS handed a different current expression. */
  const pCurrent = (doc: SheetDoc, id: string): SheetDoc => ({
    ...doc,
    blocks: doc.blocks?.map((b) =>
      b.name === 'p' ? { ...b, params: { ...b.params, I_d: id } } : b,
    ),
  });

  it('holds the PMOS as a current source where nothing declares the gate, and says so', () => {
    // Undeclared, the PMOS is held as it always was: its width and the NMOS's current. The two
    // currents agree by construction and the gates part — which the PMOS's wiring declaration
    // reports — and validation names the choice the sheet has not made, both ways out included.
    const { res } = heldRun(inverter());
    const v = res.values;
    expect(v.n__id).toBe(2e-5);
    expect(v.p__id).toBe(2e-5);
    expect(Math.abs(v.n__vgs + v.p__vgs - VDD)).toBeGreaterThan(0.01);
    expect(res.warnings.filter((w) => w.rule === 'sheet-wiring').map((w) => w.location)).toEqual([
      'p',
    ]);
    expect(flagged(inverter())).toEqual(['warning p']);
    const said = validateSheet(inverter()).find((w) => w.rule === 'sheet-held-current');
    expect(said?.message).toMatch(/hold that balances the two currents/);
    expect(said?.message).toMatch(/mirror copy of a reference gets the reference's width and gate/);
    expect(flagged(inverter('I_bias - p__id'))).toEqual([]);
    // A current the sheet types as its own param is no different from one read off a partner.
    expect(flagged(pCurrent(inverter(), 'I_bias'))).toEqual(['warning p']);
    // A current given as a number is a source by statement, and draws nothing.
    expect(flagged(pCurrent(inverter(), '2e-5'))).toEqual([]);
  });

  it('asks the same of the sheet’s own device, at the top of a tree only', () => {
    // The PMOS as the sheet's own device, beside the NMOS block.
    const own: SheetDoc = {
      ...inverter(),
      polarity: 'p',
      blocks: inverter().blocks?.filter((b) => b.name === 'n'),
      givens: { L: String(L), id: 'n__id', vgs: 'VDD - n__vgs', vds: 'VDD - V_out' },
    };
    expect(flagged(own)).toEqual(['warning givens']);
    expect(
      flagged({
        ...own,
        params: own.params.map((p) => (p.name === 'I_bias' ? { ...p, hold: 'I_bias - id' } : p)),
      }),
    ).toEqual([]);
    // Embedded, a child's own givens are its parent's to settle: the inverter's PMOS block alone
    // reads as undeclared, and inside the inverter with its balance nothing is raised anywhere.
    const pDoc = inverter().blocks?.find((b) => b.name === 'p')?.doc as SheetDoc;
    expect(flagged(pDoc)).toEqual(['warning givens']);
    expect(
      validateSheet(inverter('I_bias - p__id')).filter((w) => w.rule === 'sheet-held-current'),
    ).toEqual([]);
  });

  it('refuses a current balance that is not zero where the design is sized', () => {
    for (const hold of ['2*I_bias - p__id', 'I_bias - p__id - 1e-6']) {
      const base = evaluateSheet(inverter(hold), dev, (id) => (id === 'pmos' ? dev : undefined));
      expect(stands(base), hold).toBe(false);
      expect(base.held, hold).toEqual({});
      expect(base.warnings.find((w) => w.rule === 'sheet-solve')?.message, hold).toMatch(
        /a current balance must be zero where the design is sized — it reads -?[\d.]+e/,
      );
    }
    // A hold that reads no current holds whatever it read, as a node's gate voltage does.
    const node = evaluateSheet(inverter('I_bias + 1e-6'), dev, (id) =>
      id === 'pmos' ? dev : undefined,
    );
    expect(stands(node)).toBe(true);
  });

  it('refuses a balance whose param reaches no other current where the design is held', () => {
    // A lone device given its gate voltage and a current, with its own current balanced against
    // the param it was given: where the design is held the device keeps its gate, and the param
    // feeds nothing but the balance — solving it would set a number and move no current.
    const lone: SheetDoc = {
      title: 'lone',
      polarity: 'n',
      params: [{ name: 'I_set', value: 2e-5, min: 2e-6, max: 2e-4, unit: 'A', hold: 'I_set - id' }],
      givens: { L: String(L), id: 'I_set', vgs: '0.6', vds: '0.6' },
      equations: [],
      checks: [],
    };
    const errors = validateSheet(lone).filter((w) => w.severity === 'error');
    expect(errors.map((w) => `${w.rule} ${w.location}`)).toEqual(['sheet-param I_set']);
    expect(errors[0].message).toMatch(/reaches no other device's current/);
    // The NMOS's own current against the param it carries cancels: the balanced device is the
    // only one the param reaches, which counts for nothing.
    expect(
      validateSheet(inverter('I_bias - n__id'))
        .filter((w) => w.severity === 'error')
        .map((w) => `${w.rule} ${w.location}`),
    ).toEqual(['sheet-param I_bias']);
    expect(validateSheet(inverter('I_bias - p__id')).filter((w) => w.severity === 'error')).toEqual(
      [],
    );
  });

  it('balances two halves that were both given a gate voltage, keeping the PMOS’s alone', () => {
    // Both halves written (id, vgs) on a typed input level. The balance names the PMOS's current,
    // so the PMOS keeps its gate; the NMOS, undeclared, is held at its width and the bias current,
    // which the balance solves — the two currents agree. The NMOS is still reported: where the
    // design is held its gate is no longer the input level.
    const both: SheetDoc = {
      ...inverter('I_bias - p__id'),
      params: [
        ...inverter('I_bias - p__id').params,
        { name: 'V_in', value: V0, unit: 'V', class: 'independent' },
      ],
      equations: [],
      blocks: inverter().blocks?.map((b) =>
        b.name === 'n'
          ? {
              ...b,
              doc: {
                ...(b.doc as SheetDoc),
                params: [...(b.doc as SheetDoc).params, { name: 'vg', value: 0.5, unit: 'V' }],
                givens: { L: String(L), id: 'I_d', vgs: 'vg', vds: 'vds_d' },
              },
              params: { ...b.params, vg: 'V_in' },
            }
          : { ...b, params: { ...b.params, vgs_d: 'VDD - V_in' }, wiring: undefined },
      ),
    };
    expect(validateSheet(both).filter((w) => w.severity === 'error')).toEqual([]);
    expect(flagged(both)).toEqual(['warning n']);
    const { held, res } = heldRun(both);
    expect(held.doc.blocks?.[0].doc?.givens?.id).toBe('I_d');
    expect(held.doc.blocks?.[1].doc?.givens?.vgs).toBe('vgs_d');
    expect(relErr(res.values.n__id, res.values.p__id)).toBeLessThan(1e-5);
    expect(res.values.I_bias).toBe(res.values.n__id);
  });

  it('keeps a gate on a node by re-solving the node, as before, with nothing to declare', () => {
    // A cascode written (id, vgs) on a typed gate voltage, the node under it held: the hold reads
    // its gate-source voltage, so the sheet has said what stays — the gate — and the device is
    // held at its width and current, the node re-solved under it. On the slower table the node
    // drops by about the threshold shift over (1 + the body factor): 40 mV/1.2 = 33 mV.
    const stack: SheetDoc = {
      title: 'stack',
      polarity: 'n',
      params: [
        { name: 'I', value: 2e-5, unit: 'A' },
        { name: 'V_out', value: 1.0, unit: 'V', class: 'independent' },
        { name: 'V_a', value: 0.4, min: 0.1, max: 0.8, unit: 'V', hold: 'V_a + c__vgs' },
      ],
      blocks: [
        {
          name: 'in',
          doc: {
            title: 'in',
            polarity: 'n',
            params: [
              { name: 'I_d', value: 2e-5, unit: 'A' },
              { name: 'vd', value: 0.4, unit: 'V' },
            ],
            givens: { L: String(L), id: 'I_d', gm_id: '12', vds: 'vd' },
            equations: [],
            checks: [],
            provides: ['id'],
          },
          params: { I_d: 'I', vd: 'V_a' },
        },
        {
          name: 'c',
          doc: {
            title: 'c',
            polarity: 'n',
            params: [
              { name: 'I_d', value: 2e-5, unit: 'A' },
              { name: 'vd', value: 0.6, unit: 'V' },
              { name: 'vs', value: 0.4, unit: 'V' },
            ],
            givens: { L: String(L), id: 'I_d', vgs: '0.6', vds: 'vd', vsb: 'vs' },
            equations: [],
            checks: [],
            provides: ['vgs', 'id'],
          },
          params: { I_d: 'I', vd: 'V_out - V_a', vs: 'V_a' },
        },
      ],
      equations: [],
      checks: [],
    };
    expect(flagged(stack)).toEqual([]);
    const base = evaluateSheet(stack, dev);
    const held = holdHardware(stack, base);
    expect(held.doc.blocks?.[1].doc?.givens?.id).toBe('I_d');
    const res = evaluateSheet(held.doc, nHeld);
    expect(res.feasible).toBe(true);
    expect(res.values.in__id).toBe(2e-5);
    expect(res.values.c__id).toBe(2e-5);
    const drop = base.values.V_a - res.values.V_a;
    expect(drop).toBeGreaterThan(0.03);
    expect(drop).toBeLessThan(0.037);
  });

  it('holds a lone device with a typed gate voltage at its width and current, as before', () => {
    // Nothing declares the gate, so the current is what stays: on the table whose threshold sits
    // DN higher, the same current needs exactly DN more gate-source voltage.
    const one: SheetDoc = {
      title: 'one',
      polarity: 'n',
      params: [],
      givens: { L: String(L), id: '2e-5', vgs: '0.6', vds: '0.6' },
      equations: [],
      checks: [],
    };
    const base = evaluateSheet(one, dev);
    const res = evaluateSheet(holdHardware(one, base).doc, nHeld);
    expect(res.sizing?.ok).toBe(true);
    expect(res.sizing?.W).toBe(base.sizing?.W);
    expect(res.sizing?.id).toBe(2e-5);
    expect(res.sizing?.vgs).toBeCloseTo(0.6 + DN, 9);
  });
});

// ---------------------------------------------------------------------------------------
// What a range-end run produces, on a body-biased table
// ---------------------------------------------------------------------------------------

describe('range-end runs re-bias the design instead of re-sizing it', () => {
  const L = 5e-7; // VA = 2.5 V here
  const ID = 2e-5;

  /** One device, biased by the parent, exposing what a range-end golden needs to see. */
  const device = (vds: string, vsb: string): SheetDoc => ({
    title: 'device',
    polarity: 'n',
    provides: ['gm_id', 'gds', 'vgs'],
    params: [
      { name: 'V_d', value: 0.6 },
      { name: 'V_s', value: 0.4 },
      { name: 'I_d', value: ID },
    ],
    equations: [],
    checks: [],
    givens: { L: '0.5u', gm_id: '10', id: 'I_d', vds, vsb },
  });

  const mk = (over: Partial<SheetDoc>): SheetDoc => ({
    title: 'cov',
    polarity: 'n',
    params: [
      { name: 'V_o', value: 0.6, min: 0.2, max: 1.2 },
      { name: 'V_o_hi', value: 1.0 },
      { name: 'VSB', value: 0.4, min: 0, max: 0.4 },
      { name: 'VSB_lo', value: 0 },
      { name: 'VDD', value: 1.3 },
    ],
    equations: [],
    checks: [{ id: 'inverted', kind: 'physical', lhs: 'm__gm_id', op: '>=', rhs: '1' }],
    blocks: [{ name: 'm', doc: device('V_d', 'V_s'), params: { V_d: 'V_o', V_s: 'VSB' } }],
    ...over,
  });

  const sizingAt = (c: SheetBlockReport | undefined): SizingReport => c!.sizing!;

  it('holds the transistor and lets the body effect move the gate, and only the gate', () => {
    // The purest fixed-hardware statement the model can make: at a fixed vds and a fixed current
    // the demo's body effect is a pure threshold translation, so dropping vsb by 0.4 V must move
    // vgs down by exactly BODY_FACTOR·0.4 = 80 mV and leave the device otherwise untouched.
    //
    // A law, not a discriminator: because that translation is exact, a device sized to a gm/ID
    // spec at the range end would land on this same point, so re-sizing here is indistinguishable
    // from re-biasing. The two tests below are the ones that tell them apart — both need the
    // drain to move, which on this model is the only channel that separates them.
    const res = runSheet(
      mk({ operatingRange: [{ name: 'body-lo', set: { VSB: 'VSB_lo' } }] }),
      dev,
    );
    expect(res.complies).toBe(true);
    const base = sizingAt(res.blocks?.[0]);
    const end = sizingAt(res.rangeEnds?.[0].blocks?.[0]);
    expect(end.W).toBe(base.W); // to the last bit: this is the same transistor
    expect(end.L).toBe(base.L);
    expect(end.id).toBe(base.id); // the authored current, re-evaluated to the same number
    expect(end.vgs - base.vgs).toBeCloseTo(-BODY_FACTOR * 0.4, 9);
    expect(res.rangeEnds?.[0].blocks?.[0].provides.gm_id).toBeCloseTo(10, 3);
  });

  it('re-settles the operating point when the range end moves the drain', () => {
    // vds 0.6 → 1.0 at VA = 2.5 V. Under fixed hardware the current density is what is held, so
    // the channel-length-modulation factor rising 1.24 → 1.4 must come back out of the inversion
    // level: iNorm falls by 1.24/1.4, gm/ID rises off its authored 10 to (1 − e^-s)/(n·U_T·s) at
    // s = s(gm/ID = 10)·sqrt(1.24/1.4) = 10.5016, and gds is id/(VA + vds) at the new vds.
    // A range end free to re-size would instead give the device 88.57% of its width
    // and read gm/ID = 10 exactly at an unchanged vgs — which is what these numbers rule out.
    const res = runSheet(mk({ operatingRange: [{ name: 'vds-hi', set: { V_o: 'V_o_hi' } }] }), dev);
    expect(res.complies).toBe(true);
    const base = sizingAt(res.blocks?.[0]);
    const end = sizingAt(res.rangeEnds?.[0].blocks?.[0]);
    expect(end.W).toBe(base.W);
    expect(end.vgs).toBeLessThan(base.vgs);
    const at = res.rangeEnds?.[0].blocks?.[0].provides;
    expect(relErr(at!.gm_id, 10.5016)).toBeLessThan(1e-3); // interpolation, not the model
    expect(relErr(at!.gds, gdsOf(ID, L, 1.0))).toBeLessThan(1e-9); // closed form, exact
  });

  it('carries a body-effect shift through a sibling into the device it biases', () => {
    // The library's own idiom: one device's gate sets another's drain. Dropping vsb moves the
    // reference's gate down 80 mV, which lifts the output device's vds by the same 80 mV — and
    // THAT device, whose own body bias never moved, must still hold its width. The old semantics
    // would have re-sized it to 97.49% (the ratio of the two modulation factors).
    const ref: SheetDoc = {
      ...device('0.6', 'V_s'),
      title: 'ref',
      provides: ['vgs'],
    };
    const res = runSheet(
      mk({
        blocks: [
          { name: 'r', doc: ref, params: { V_s: 'VSB' } },
          { name: 'm', doc: device('V_d', '0'), params: { V_d: 'VDD - r__vgs' } },
        ],
        operatingRange: [{ name: 'body-lo', set: { VSB: 'VSB_lo' } }],
      }),
      dev,
    );
    expect(res.complies).toBe(true);
    const [rBase, mBase] = (res.blocks ?? []).map(sizingAt);
    const [rEnd, mEnd] = (res.rangeEnds?.[0].blocks ?? []).map(sizingAt);
    expect(rEnd.vgs - rBase.vgs).toBeCloseTo(-BODY_FACTOR * 0.4, 9);
    expect(rEnd.W).toBe(rBase.W);
    expect(mEnd.W).toBe(mBase.W);
    const vds = mEnd.bias!.vds;
    expect(vds - mBase.bias!.vds).toBeCloseTo(BODY_FACTOR * 0.4, 6);
    const at = res.rangeEnds?.[0].blocks?.[1].provides;
    expect(at!.gm_id).toBeGreaterThan(10); // exactly 10 if the device had re-sized instead
    expect(relErr(at!.gds, gdsOf(ID, L, vds))).toBeLessThan(1e-9);
  });

  it('re-reads gm at a range end, so even an end that moves nothing is not bit-identical', () => {
    // The one thing a fixed-hardware end does NOT hold. The base givens name a gm/ID, which the
    // sizer honours arithmetically (gm = gm_id·I_D); its rewritten (W, I_D) form has no ratio to
    // honour and reads gm back off the operating point the held width lands on. So this range end —
    // which sets a param to its own value and therefore changes nothing whatsoever — still
    // reports a gm a fraction under the base's, and Av, GBW, PM, noise and offset each inherit
    // that fraction, always in the pessimistic direction.
    //
    // It is an interpolation residual, not physics — the assertions below hold the geometry, the
    // current and the gate voltage equal to the last bit. Pinned as a magnitude (0.108% here) so
    // it cannot grow unnoticed, and so a reader comparing a base value against a range-end value
    // knows a floor of disagreement this size is under both of them before any condition moves.
    const res = runSheet(
      mk({
        blocks: [
          {
            name: 'm',
            doc: {
              ...device('V_d', '0'),
              provides: ['gm', 'gm_id'],
              givens: { L: '0.5u', gm_id: '12', id: '10u', vds: 'V_d' },
            },
            params: { V_d: 'V_o' },
          },
        ],
        operatingRange: [{ name: 'null', set: { V_o: 'V_o' } }],
      }),
      dev,
    );
    expect(res.complies).toBe(true);
    const base = sizingAt(res.blocks?.[0]);
    const end = sizingAt(res.rangeEnds?.[0].blocks?.[0]);
    expect(end.W).toBe(base.W);
    expect(end.L).toBe(base.L);
    expect(end.id).toBe(base.id);
    expect(end.vgs).toBe(base.vgs);
    const baseAt = res.blocks![0].provides;
    const endAt = res.rangeEnds![0].blocks![0].provides;
    expect(baseAt.gm_id).toBe(12); // the authored ratio, honoured exactly
    const drift = 1 - endAt.gm / baseAt.gm;
    expect(drift).toBeGreaterThan(0);
    expect(drift).toBeLessThan(2e-3);
  });

  /** The device with its source on node X: the drain is moved by the range end, the body bias is
   *  X. `hold` says the gate — X plus the device's gate-source voltage — is what stays put. */
  const underGate = (
    x: SheetDoc['params'][number],
    rangeEnds?: SheetDoc['operatingRange'],
  ): SheetDoc =>
    mk({
      params: [...mk({}).params, x],
      blocks: [{ name: 'm', doc: device('V_d', 'V_s'), params: { V_d: 'V_o', V_s: 'X' } }],
      ...(rangeEnds ? { operatingRange: rangeEnds } : {}),
    });
  const drainHi = [{ name: 'vds-hi', set: { V_o: 'V_o_hi' } }];
  const X0 = 0.2;
  const held = { name: 'X', value: X0, min: 0, max: 0.4, hold: 'X + m__vgs' };

  it('reports the gate voltage a held node needs, and leaves the node where it was typed', () => {
    // At the nominal run a hold changes nothing: the node keeps its typed value and the engine
    // only says what the held expression came to.
    const res = runSheet(underGate(held), dev);
    expect(res.feasible).toBe(true);
    expect(res.values.X).toBe(X0);
    expect(res.held).toEqual({ X: X0 + sizingAt(res.blocks?.[0]).vgs });
  });

  it('holds the gate at a range end and lets the node under it move', () => {
    // The drain rises 0.6 → 1.0 V. With the node typed, the fixed transistor needs less gate
    // drive at the higher drain, so its gate-source voltage falls by some d and the gate voltage
    // X + vgs falls with it: the gate floats. With the gate held, the node has to rise instead.
    // On this model the body effect is a pure threshold translation, so raising the node by D
    // raises vgs by BODY_FACTOR·D on top of the same drain-driven fall d:
    //   (X + D) + (vgs - d + BODY_FACTOR·D) = X + vgs   gives   D = d/(1 + BODY_FACTOR).
    const typed = runSheet(underGate({ name: 'X', value: X0 }, drainHi), dev);
    const d = sizingAt(typed.blocks?.[0]).vgs - sizingAt(typed.rangeEnds?.[0].blocks?.[0]).vgs;
    expect(d).toBeGreaterThan(5e-3); // the drain really moved the device

    const res = runSheet(underGate(held, drainHi), dev);
    expect(res.complies).toBe(true);
    const base = sizingAt(res.blocks?.[0]);
    const end = sizingAt(res.rangeEnds?.[0].blocks?.[0]);
    expect(end.W).toBe(base.W); // the same transistor
    const landed = res.rangeEnds![0].solved.X;
    expect(end.bias!.vsb).toBeCloseTo(landed, 12); // the node the device actually sat on
    // The gate is where it was, to the search's landing tolerance on a 0.4 V range.
    expect(landed + end.vgs).toBeCloseTo(res.held!.X, 5);
    // And the node moved by the law above; the slack is interpolation between vsb nodes.
    expect(relErr(landed - X0, d / (1 + BODY_FACTOR))).toBeLessThan(5e-3);
  });

  it('refuses a held expression that its own param does not move', () => {
    // In the required form, yet the equation cancels the param: R is -X, so X + R is zero
    // everywhere and no value of X is singled out. The relation reads exactly zero at the low end
    // of the range, which a search takes for a root — it would report the node at 0 V and
    // cover.
    const doc = underGate({ name: 'X', value: X0, min: 0, max: 0.4, hold: 'X + R' }, drainHi);
    doc.equations = [{ name: 'R', expr: '0 - X' }];
    const res = runSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(res.complies).toBe(false);
    expect(res.rangeEnds?.[0].error).toMatch(/held param "X".*numerically unresolved/);
    expect(res.rangeEnds?.[0].solved).toEqual({});
  });

  it('still solves a held expression whose own term is tiny', () => {
    // 1e-9·X moves by 4e-10 across the range — all of it the param's own term, so the node is
    // determined however small the numbers are: X stays 0.2 because nothing else moved.
    const res = runSheet(
      underGate({ name: 'X', value: X0, min: 0, max: 0.4, hold: '1e-9*X' }, drainHi),
      dev,
    );
    expect(res.complies).toBe(true);
    expect(res.rangeEnds![0].solved.X).toBeCloseTo(X0, 5);
  });

  it('fails the run when a held expression does not evaluate', () => {
    // Nothing to hold the node at: a range end would have no value to solve against.
    const res = runSheet(
      underGate({ name: 'X', value: X0, min: 0, max: 0.4, hold: 'X + missing' }),
      dev,
    );
    expect(res.feasible).toBe(false);
    expect(res.warnings.map((w) => w.message)).toContainEqual(
      expect.stringMatching(/param "X": hold "X \+ missing" did not evaluate/),
    );
  });

  it('holds a node inside a child at the value its parent wired in', () => {
    // The hold lives in the child, on its own source node, with 0.2 V as the embedded default;
    // the parent wires 0.25 V in. What is held is the gate at the WIRED node, so the range end
    // moves the node by the same law as before, starting from 0.25 V.
    const inner: SheetDoc = {
      ...device('V_d', 'X'),
      params: [...device('V_d', 'X').params, { name: 'X', value: 0.2, min: 0, max: 0.4 }],
    };
    const held = (hold?: string): SheetDoc => {
      const doc = mk({
        params: [...mk({}).params, { name: 'Xp', value: 0.25 }],
        blocks: [
          {
            name: 'm',
            doc: {
              ...inner,
              params: inner.params.map((p) => (p.name === 'X' && hold ? { ...p, hold } : p)),
            },
            params: { V_d: 'V_o', X: 'Xp' },
          },
        ],
        operatingRange: drainHi,
      });
      return doc;
    };
    const typed = runSheet(held(), dev);
    const d = sizingAt(typed.blocks?.[0]).vgs - sizingAt(typed.rangeEnds?.[0].blocks?.[0]).vgs;

    const res = runSheet(held('X + vgs'), dev);
    const base = res.blocks![0];
    expect(base.held).toEqual({ X: 0.25 + sizingAt(base).vgs });
    const end = sizingAt(res.rangeEnds?.[0].blocks?.[0]);
    expect(end.W).toBe(sizingAt(base).W);
    expect(relErr(end.bias!.vsb - 0.25, d / (1 + BODY_FACTOR))).toBeLessThan(5e-3);
    expect(end.bias!.vsb + end.vgs).toBeCloseTo(base.held!.X, 5);
  });

  it('says a device cannot carry its current at the endpoint in the vocabulary of the question', () => {
    // A failure mode a re-sizing range end could not produce: at a fixed width the authored current
    // needs a density the swept vgs range no longer reaches once the body bias raises vth. The
    // lookup's own words are accurate but width-domain, so the finding leads with what it means
    // and keeps them behind it.
    const doc: SheetDoc = {
      title: 'edge-of-table',
      polarity: 'n',
      params: [
        { name: 'VSB', value: 0, min: 0, max: 0.4 },
        { name: 'VSB_hi', value: 0.4 },
      ],
      equations: [],
      checks: [],
      givens: { L: '0.5u', gm_id: '2.8', id: '20u', vds: '0.6', vsb: 'VSB' },
      operatingRange: [{ name: 'body-hi', set: { VSB: 'VSB_hi' } }],
    };
    const res = runSheet(doc, dev);
    expect(res.sizing?.ok).toBe(true); // the center sized; it is the range end that cannot
    const e = res.rangeEnds?.[0];
    expect(e?.state).toBe('does-not-comply');
    expect(e?.error).toMatch(/^this device cannot carry its current here/);
    expect(e?.error).toMatch(/inverse lookup: id .* out of range/); // the reach, verbatim
    expect(res.complies).toBe(false);
  });

  it('names the transconductance instead when that is what the endpoint cannot reach', () => {
    // Width-first givens are carried through untouched, so the quantity they run out of table on is
    // whichever one they authored. Saying "current" over a given gm would describe the wrong
    // quantity to the one reader who most needs it named.
    const doc: SheetDoc = {
      title: 'edge-of-table-gm',
      polarity: 'n',
      params: [
        { name: 'VSB', value: 0, min: 0, max: 0.4 },
        { name: 'VSB_hi', value: 0.4 },
      ],
      equations: [],
      checks: [],
      givens: { L: '0.5u', W: '10u', gm: '8e-3', vds: '0.6', vsb: 'VSB' },
      operatingRange: [{ name: 'body-hi', set: { VSB: 'VSB_hi' } }],
    };
    const e = runSheet(doc, dev).rangeEnds?.[0];
    expect(e?.state).toBe('does-not-comply');
    expect(e?.error).toMatch(/^this device cannot reach its transconductance here/);
    expect(e?.error).toMatch(/inverse lookup: gm .* out of range/);
  });
});

// ---------------------------------------------------------------------------------------
// The standing-center gate
// ---------------------------------------------------------------------------------------

describe('compliance is only asked of a design that exists', () => {
  /** A sheet whose design constraint cannot reach its target, with givens that size at every probe.
   *  */
  const unreachable = (T: number): SheetDoc => ({
    title: 'g',
    polarity: 'n',
    params: [
      { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'Spec' } },
      { name: 'Spec', value: T },
      { name: 'Spec_lo', value: 3 },
      { name: 'floor', value: 0.5 },
    ],
    equations: [{ name: 'y', expr: '2*x + 1' }],
    checks: [{ id: 'node-floor', kind: 'physical', lhs: 'x', op: '>=', rhs: 'floor' }],
    givens: { L: '0.5u', gm_id: '10', id: '20u', vds: '0.6', vsb: '0' },
    operatingRange: [{ name: 'lo', set: { Spec: 'Spec_lo' } }],
  });

  it('skips the range ends when the base run did not stand, and says the question went unasked', () => {
    // The case that makes "did the devices size" the wrong test: a design constraint that fails
    // returns its LAST BISECTION PROBE, so every sizing in the result reads ok while the engine
    // landed on nothing. Holding hardware at that probe would report a verdict about a design that
    // was never produced — the same phantom the errored-range-end guards elsewhere exist to refuse.
    const res = evaluateSheet(unreachable(0.5), dev);
    expect(res.sizing?.ok).toBe(true);
    expect(stands(res)).toBe(false);
    expect(res.rangeEnds?.[0].state).toBe('not-run');
    expect(res.rangeEnds?.[0].error).toBeUndefined(); // "we did not check" is not "it broke"
    expect(res.rangeEnds?.[0].set).toEqual({}); // no point was proven, so none is reported
    expect(res.complies).toBeUndefined(); // absent: the question has no answer here, not a false one
    expect(res.feasible).toBe(false);
  });

  it('checks the range ends of a design that misses its spec — a failing check is still a design', () => {
    const doc = unreachable(5);
    doc.params.find((p) => p.name === 'floor')!.value = 5; // base x = 2 fails the floor
    const res = evaluateSheet(doc, dev);
    expect(stands(res)).toBe(true);
    expect(res.checks[0].status).toBe('fail');
    expect(res.rangeEnds?.[0].state).toBe('does-not-comply'); // checked, and the floor fails there too
    expect(res.complies).toBe(false);
  });

  it('leaves a skipped range end out of the checks a caller can name', () => {
    const res = evaluateSheet(unreachable(0.5), dev);
    expect([...treeCheckResults(res).keys()]).toEqual(['node-floor']);
  });

  it('draws no range-end failure on a sweep where compliance was never checked', () => {
    // A bottom clip here would put a cause on the chart the engine never established — and would
    // flatten the picker's objective across the whole region whose centers fail.
    const doc = unreachable(5);
    doc.params.find((p) => p.name === 'Spec')!.min = 0.5;
    doc.params.find((p) => p.name === 'Spec')!.max = 25; // y spans [1, 21]: the top is unreachable
    // y spans [1, 21] over the constraint's bracket, so the two ends of this sweep have no design
    // and its interior does. The range-end curve must be a GAP at the ends and a real margin
    // between.
    const sw = sweepSheet(doc, 'Spec', dev, 5);
    const curve = sw.checks.find((r) => r.rangeEnd === 'lo')!;
    expect(curve.marginPct.map((m) => m === null)).toEqual([true, false, false, false, true]);
    expect(sw.feasible).toEqual([false, true, true, true, false]);
  });

  it('reports no sensitivity around a point that is not a design', () => {
    const s = sheetSensitivities(unreachable(0.5), dev, undefined, { params: ['floor'] });
    expect(s[0].error).toMatch(/does not evaluate at its own values/);
  });
});

// ---------------------------------------------------------------------------------------
// complies, beside feasible
// ---------------------------------------------------------------------------------------

describe('complies — the second question, answered apart from feasibility', () => {
  const mk = (over: Partial<SheetDoc> = {}): SheetDoc => ({
    title: 'c',
    polarity: 'n',
    params: [
      { name: 'Spec', value: 5 },
      { name: 'Spec_lo', value: 3 },
      { name: 'Spec_hi', value: 7 },
      { name: 'cap', value: 20 },
    ],
    equations: [{ name: 'y', expr: '2*Spec' }],
    checks: [{ id: 'ceil', kind: 'spec', lhs: 'cap', op: '>=', rhs: 'y' }],
    operatingRange: [
      { name: 'lo', set: { Spec: 'Spec_lo' } },
      { name: 'hi', set: { Spec: 'Spec_hi' } },
    ],
    ...over,
  });

  it('is true only when every claimed end holds', () => {
    const res = evaluateSheet(mk(), dev);
    expect(res.rangeEnds?.map((e) => e.state)).toEqual(['complies', 'complies']);
    expect(res.complies).toBe(true);
    expect(res.feasible).toBe(true);
  });

  it('separates a design that is feasible from one that holds across its range', () => {
    // The two questions, visibly apart: this design meets its spec where it is sized
    // (y = 10 ≤ 12) and stops complying at the high end (y = 14). Neither answer moves the other.
    const res = evaluateSheet(
      mk({ params: [...mk().params.slice(0, 3), { name: 'cap', value: 12 }] }),
      dev,
    );
    expect(res.checks[0].status).toBe('pass');
    expect(res.rangeEnds?.map((e) => e.state)).toEqual(['complies', 'does-not-comply']);
    expect(res.complies).toBe(false);
    expect(res.feasible).toBe(true);
  });

  it('is absent on a sheet that claims no range at all', () => {
    expect(evaluateSheet(mk({ operatingRange: undefined }), dev).complies).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// No answer: asked, and nothing was measured at the point asked about
// ---------------------------------------------------------------------------------------

describe('no answer — a range end the data or the sheet cannot speak for', () => {
  // The demo table characterizes vds up to 1.2 V. A range end at 1.5 V is read at 1.2 V instead.
  const offHull = (over: Partial<SheetDoc> = {}): SheetDoc => ({
    title: 'off-hull',
    polarity: 'n',
    params: [
      { name: 'VD', value: 0.6, unit: 'V', min: 0.2, max: 1.2 },
      { name: 'VD_hi', value: 1.5, unit: 'V' },
    ],
    equations: [],
    checks: [{ id: 'vd-cap', kind: 'spec', lhs: 'VD', op: '<=', rhs: '1.4' }],
    givens: { L: '0.5u', gm_id: '12', id: '20u', vds: 'VD', vsb: '0' },
    operatingRange: [{ name: 'vd-hi', set: { VD: 'VD_hi' } }],
    ...over,
  });

  it('declines a range end the table does not reach, instead of answering from its edge', () => {
    const res = evaluateSheet(offHull(), dev);
    expect(res.feasible).toBe(true);
    const e = res.rangeEnds![0];
    expect(e.set).toEqual({ VD: 1.5 });
    // The run completed — on data taken 0.3 V away. Its `vd-cap` check even fails there
    // (1.5 > 1.4), and that still is not a finding: the device numbers beside it are not this
    // point's, so the end is no answer rather than a failure, and no check of it is named.
    expect(e.state).toBe('no-answer');
    expect(e.error).toMatch(/^the table does not reach this point \(givens vds\)/);
    expect(e.solved).toEqual({});
    expect(e.warnings.some((w) => /clamped to 1.2/.test(w.message))).toBe(true);
    expect(rangeEndCheck(res)).toBeUndefined();
    expect(res.complies).toBe(false);
  });

  it('keeps the same clamp advisory where the design is sized', () => {
    // At the design's own operating point a clamp is the author's to see and judge, as it always
    // was: a warning beside a verdict, not a refusal.
    const doc = offHull({ operatingRange: undefined });
    doc.params[0].value = 1.3;
    doc.params[0].max = 1.5;
    const res = evaluateSheet(doc, dev);
    expect(res.sizing?.clamped).toEqual(['vds']);
    expect(res.sizing?.bias?.vds).toBeCloseTo(1.2, 12); // the table's last vds node
    expect(res.feasible).toBe(true);
    expect(clampedIn(res)).toEqual(['givens vds']);
  });

  it('names a clamped child by its block path', () => {
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        { name: 'load', doc: offHull({ operatingRange: undefined }), params: { VD: '1.3' } },
      ],
    };
    expect(clampedIn(evaluateSheet(parent, dev))).toEqual(['load vds']);
  });

  it('declines a range end read off the hull on any coordinate, not only vds', () => {
    // The body bias, the length and a supplied gate voltage each have a nearest characterized
    // node to fall back to, exactly as vds does — and each fallback is a different point.
    const end = (
      givens: SheetDoc['givens'],
      params: SheetDoc['params'],
      set: Record<string, string>,
    ): { state?: string; error?: string } => {
      const e = evaluateSheet(
        {
          title: 'off',
          polarity: 'n',
          params,
          equations: [],
          checks: [],
          givens,
          operatingRange: [{ name: 'end', set }],
        },
        dev,
      ).rangeEnds![0];
      return { state: e.state, error: e.error };
    };
    // vsb is characterized to 0.4 V; the end asks 0.6 V.
    const vsb = end(
      { L: '0.5u', gm_id: '12', id: '20u', vds: '0.6', vsb: 'VB' },
      [
        { name: 'VB', value: 0, unit: 'V', class: 'independent' },
        { name: 'VB_hi', value: 0.6, unit: 'V', class: 'independent' },
      ],
      { VB: 'VB_hi' },
    );
    expect(vsb.state).toBe('no-answer');
    expect(vsb.error).toMatch(/\(givens vsb\)/);
    // Width-first givens keep their length as an authored expression, so an end can move it:
    // 5 µm against a table that stops at 2 µm.
    const len = end(
      { L: 'Lp', W: '10u', id: '20u', vds: '0.6', vsb: '0' },
      [
        { name: 'Lp', value: 0.5e-6 },
        { name: 'Lp_hi', value: 5e-6 },
      ],
      { Lp: 'Lp_hi' },
    );
    expect(len.state).toBe('no-answer');
    expect(len.error).toMatch(/\(givens l\)/);
    // A supplied gate voltage of 1.5 V against a sweep that ends at 1.2 V.
    const vgs = end(
      { L: '0.5u', W: '10u', vgs: 'VG', vds: '0.6', vsb: '0' },
      [
        { name: 'VG', value: 0.6, unit: 'V', class: 'independent' },
        { name: 'VG_hi', value: 1.5, unit: 'V', class: 'independent' },
      ],
      { VG: 'VG_hi' },
    );
    expect(vgs.state).toBe('no-answer');
    expect(vgs.error).toMatch(/\(givens vgs\)/);
  });

  it('does not call it a failure when the lookup runs out of range on clamped data', () => {
    // The trap behind the clamp: at vds = 1.5 V the device carries the current asked of it, but
    // this table stops at 1.2 V, and at 1.2 V it does not. The inverse lookup then fails on the
    // clamped slice with the very message that otherwise means "this device cannot carry its
    // current". That would be a verdict about a point nobody measured. A table that reaches
    // 1.5 V gives the true one.
    const wide = generateDemoDevice({
      vds: { min: 0, max: 1.6, step: 0.05 },
      vsb: { min: 0, max: 0.4, step: 0.05 },
    });
    // The most current a 10 µm device carries on the narrow table at vds = 0.6 V.
    const top = evaluateSheet(
      {
        title: 'top',
        polarity: 'n',
        params: [],
        equations: [],
        checks: [],
        givens: { L: '0.5u', W: '10u', vgs: '1.2', vds: '0.6', vsb: '0' },
      },
      dev,
    ).sizing!.id;
    const doc: SheetDoc = {
      title: 'trap',
      polarity: 'n',
      params: [
        { name: 'VD', value: 0.6, unit: 'V', class: 'independent' },
        { name: 'VD_hi', value: 1.5, unit: 'V', class: 'independent' },
        { name: 'K', value: 0.95 },
        { name: 'K_hi', value: 1.22 },
      ],
      equations: [],
      checks: [],
      givens: { L: '0.5u', W: '10u', id: `K*${top}`, vds: 'VD', vsb: '0' },
      operatingRange: [{ name: 'hi', set: { VD: 'VD_hi', K: 'K_hi' } }],
    };
    const narrowEnd = evaluateSheet(doc, dev).rangeEnds![0];
    expect(narrowEnd.state).toBe('no-answer');
    expect(narrowEnd.error).toMatch(/^the table does not reach this point \(givens vds\)/);
    expect(narrowEnd.error).toMatch(/the run then stopped: sizing failed: inverse lookup: id/);
    expect(evaluateSheet(doc, wide).rangeEnds![0].state).toBe('complies');
  });

  it('declines a diode-connected device whose gate voltage lies past the characterized drain range', () => {
    // A diode connection is read where vds = vgs. Raise the current and the gate voltage climbs
    // to about 0.97 V; a table swept only to vds = 0.6 V reads that point at 0.6 V instead and
    // reports a gate voltage 30 mV away from the real one — enough to flip a check either way.
    const mk = (vdsMax: number) => generateDemoDevice({ vds: { min: 0, max: vdsMax, step: 0.05 } });
    const doc: SheetDoc = {
      title: 'diode',
      polarity: 'n',
      params: [
        { name: 'I', value: 2e-5, unit: 'A' },
        { name: 'I_hi', value: 3e-4, unit: 'A' },
      ],
      equations: [],
      checks: [{ id: 'drop', kind: 'spec', lhs: 'vgs', op: '<=', rhs: '0.975' }],
      givens: { L: '0.5u', gm_id: '12', id: 'I', diode: true },
      operatingRange: [{ name: 'hi', set: { I: 'I_hi' } }],
    };
    const reached = evaluateSheet(doc, mk(1.2));
    expect(reached.rangeEnds![0].state).toBe('complies'); // 0.967 V against the 0.975 V cap
    const short = evaluateSheet(doc, mk(0.6));
    // At the centre the gate sits near 0.57 V, inside the drain range: read where it was asked.
    expect(short.sizing?.clamped).toBeUndefined();
    expect(short.rangeEnds![0].state).toBe('no-answer');
    expect(short.rangeEnds![0].error).toMatch(/\(givens vds\)/);
  });

  it('does not mistake float rounding at the hull for a clamp', () => {
    // 0.3 - (0.1 + 0.2) is -5.6e-17, a hair below the body-bias axis's first node at 0. Reading
    // that node is reading the table where it was asked.
    const doc: SheetDoc = {
      title: 'ulp',
      polarity: 'n',
      params: [
        { name: 'Spec', value: 1 },
        { name: 'Spec_hi', value: 2 },
      ],
      equations: [],
      checks: [],
      givens: { L: '0.5u', gm_id: '12', id: '20u', vds: '0.6', vsb: '0.3 - (0.1 + 0.2)' },
      operatingRange: [{ name: 'hi', set: { Spec: 'Spec_hi' } }],
    };
    const res = evaluateSheet(doc, dev);
    expect(0.3 - (0.1 + 0.2)).toBeLessThan(0);
    expect(res.sizing?.clamped).toBeUndefined();
    expect(res.warnings.filter((w) => /clamped/.test(w.message))).toEqual([]);
    expect(res.rangeEnds![0].state).toBe('complies');
  });

  it('reads a held current from the table: too much is a failure, too little is no answer', () => {
    // The same device at its sized width, asked for an absurd current either way. One ampere is
    // more than any characterized gate voltage carries: the device cannot do it. A femtoampere
    // is less than the sweep's lowest point carries: the device would sit below anything
    // measured, and the data cannot say how it behaves there.
    const doc: SheetDoc = {
      title: 'reach',
      polarity: 'n',
      params: [
        { name: 'I', value: 2e-5, unit: 'A' },
        { name: 'I_lo', value: 1e-15, unit: 'A' },
        { name: 'I_hi', value: 1, unit: 'A' },
      ],
      equations: [],
      checks: [],
      givens: { L: '0.5u', gm_id: '12', id: 'I', vds: '0.6', vsb: '0' },
      operatingRange: [
        { name: 'lo', set: { I: 'I_lo' } },
        { name: 'hi', set: { I: 'I_hi' } },
      ],
    };
    const [lo, hi] = evaluateSheet(doc, dev).rangeEnds!;
    expect(lo.state).toBe('no-answer');
    expect(lo.error).toMatch(/^sizing failed: inverse lookup: id 1e-15 out of range/);
    expect(hi.state).toBe('does-not-comply');
    expect(hi.error).toMatch(/^this device cannot carry its current here/);
  });

  it('declines every range end of a design sized under an assumed voltage', () => {
    // V_d is typed, and classed as something the sheet's own parts would set. Held fixed while
    // the body bias moves, it is a guess about a different circuit — so the range end is not
    // run at all, and says why. Feasibility, which holds nothing fixed, still reports.
    const doc = (cls: 'assumed' | 'independent'): SheetDoc => ({
      title: 'fenced',
      polarity: 'n',
      params: [
        { name: 'V_d', value: 0.6, unit: 'V', class: cls },
        { name: 'VB', value: 0, unit: 'V', min: 0, max: 0.4, class: 'independent' },
        { name: 'VB_hi', value: 0.2, unit: 'V', class: 'independent' },
      ],
      equations: [],
      checks: [],
      givens: { L: '0.5u', gm_id: '12', id: '20u', vds: 'V_d', vsb: 'VB' },
      operatingRange: [{ name: 'body-hi', set: { VB: 'VB_hi' } }],
    });
    const fenced = evaluateSheet(doc('assumed'), dev);
    expect(fenced.feasible).toBe(true);
    expect(fenced.rangeEnds![0].state).toBe('no-answer');
    expect(fenced.rangeEnds![0].error).toMatch(/sized under assumed level V_d/);
    expect(fenced.rangeEnds![0].checks).toEqual([]);
    expect(fenced.complies).toBe(false);
    // The same sheet with the voltage classed as an outside input is asked, and answers.
    const free = evaluateSheet(doc('independent'), dev);
    expect(free.rangeEnds![0].state).toBe('complies');
    expect(free.complies).toBe(true);
  });
});

describe('heldOutcome — what one run of a held design amounts to', () => {
  const run = (message?: string, feasible = true): Parameters<typeof heldOutcome>[0] => ({
    values: {},
    checks: [],
    feasible: feasible && message === undefined,
    warnings: message === undefined ? [] : [{ rule: 'sheet-givens', severity: 'error', message }],
  });

  it('reads a completed run by its hard checks', () => {
    expect(heldOutcome(run())).toEqual({ state: 'complies' });
    expect(heldOutcome(run(undefined, false))).toEqual({ state: 'does-not-comply' });
  });

  it('calls a current past the TOP of the swept range a failure of the design', () => {
    // The device is asked for 2 mA and the table tops out at 1 mA: no gate voltage it was
    // characterized at carries that, so the held design does not work here.
    const out = heldOutcome(
      run('sizing failed: inverse lookup: id 0.002 out of range [1e-9, 0.001] for L=5e-7'),
    );
    expect(out.state).toBe('does-not-comply');
    expect(out.error).toMatch(/^this device cannot carry its current here — sizing failed/);
  });

  it('calls a current below the BOTTOM of the swept range no answer', () => {
    // 1 pA against a sweep that starts at 1 nA: the device would sit at a gate voltage below
    // anything characterized. It may well work there; the data cannot say.
    const out = heldOutcome(
      run('sizing failed: inverse lookup: id 1e-12 out of range [1e-9, 0.001] for L=5e-7'),
    );
    expect(out.state).toBe('no-answer');
    expect(out.error).toMatch(/^sizing failed: inverse lookup/);
  });

  it('calls any other run that did not complete no answer, with its message', () => {
    expect(heldOutcome(run('constrained param x: does not change sign'))).toEqual({
      state: 'no-answer',
      error: 'constrained param x: does not change sign',
    });
  });

  it("reads a solve's failure as no answer even when it quotes a device past the top of its range", () => {
    // A solve's message can quote the device failure that bounded its search — here the end where
    // a held device could not carry 2 mA. That quote is why the range was searched where it was,
    // not this point's verdict: the solve found nothing, so the point is unanswered. The same text
    // as the run's own sizing error is a verdict (above).
    const quoted =
      'solved param "V" found no solution in the searched range [0.2, 0.8] V (the relation does ' +
      'not evaluate below V = 0.2 V: block "m": sizing failed: inverse lookup: id 0.002 out of ' +
      'range [1e-9, 0.001] for L=5e-7): CM_in - (CM_dc) does not change sign across it';
    const solve: Parameters<typeof heldOutcome>[0] = {
      ...run(),
      feasible: false,
      warnings: [{ rule: 'sheet-solve', severity: 'error', message: quoted }],
    };
    expect(heldOutcome(solve)).toEqual({ state: 'no-answer', error: quoted });
  });
});

// ---------------------------------------------------------------------------------------
// Where an authored sheet reaches past what fixed hardware can say
// ---------------------------------------------------------------------------------------

describe('validation marks the reach of a range claim, and never repairs it', () => {
  const warnings = (doc: SheetDoc): string[] =>
    validateSheet(doc)
      .filter((w) => w.severity === 'warning' && /^range end "/.test(w.message))
      .map((w) => w.message);
  /** The notes: what an author should know and has nothing to fix. */
  const notes = (doc: SheetDoc): string[] =>
    validateSheet(doc)
      .filter((w) => w.severity === 'info' && w.rule === 'sheet-range')
      .map((w) => w.message);

  /** A device driven by the parent, so a range end can reach its givens through the wiring. */
  const child = (givens: SheetDoc['givens'], provide = ['id']): SheetDoc => ({
    title: 'c',
    polarity: 'n',
    provides: provide,
    params: [
      { name: 'V_x', value: 0.6 },
      { name: 'I_c', value: 2e-5 },
    ],
    equations: [],
    checks: [],
    givens,
  });

  const parent = (over: Partial<SheetDoc>): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    params: [
      { name: 'CM_dc', value: 0.9, min: 0.7, max: 1.3 },
      { name: 'CM_hi', value: 1.2 },
      {
        name: 'V_t',
        value: 0.4,
        min: 0,
        max: 1,
        designConstraint: { lhs: 'CM_out', rhs: 'CM_dc' },
      },
    ],
    // The constraint's own relation reads the param the range end overrides, so the node it solves
    // for — and the equation that names it — move at the range end. That two-hop reach is what the
    // checks below have to follow; a direct-reference test alone would pass on a validator that
    // never closed.
    equations: [{ name: 'CM_out', expr: 'V_t + 0.5' }],
    checks: [],
    operatingRange: [{ name: 'hi', set: { CM_dc: 'CM_hi' } }],
    ...over,
  });

  /** The single-block shape every reach test below is a variation of. */
  const withK = (givens: SheetDoc['givens'], params: Record<string, string>): SheetDoc =>
    parent({ blocks: [{ name: 'k', doc: child(givens), params }] });

  it('says nothing when a range end reaches a device through its drain alone', () => {
    // The exact case: width-first givens at a moved vds reproduce their gate tie to the digit.
    // Warning here would fire on every mirror in the library, which is the false flag that
    // makes a QA signal worthless.
    expect(
      warnings(withK({ L: '0.5u', W: '10u', gm_id: '10', vds: 'V_x' }, { V_x: 'V_t' })),
    ).toEqual([]);
  });

  it('marks width-first givens a range end reaches through anything but the drain', () => {
    // Body bias is the case that bites: holding the operating-point spec across a vsb move
    // keeps a current a gate-tied device would lose, so the reach is named.
    const w = warnings(
      withK({ L: '0.5u', W: '10u', gm_id: '10', vds: '0.6', vsb: 'V_x' }, { V_x: 'V_t' }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /range end "hi" reaches the givens at "k", which fix a width, through "vsb"/,
    );
  });

  it('does not mark a gate-tied device whose body bias a range end moves', () => {
    // Given its width and a gate voltage, the device keeps no spec across the move: the table is
    // read at that gate voltage and the new body bias. One half of a matched pair on a tail node
    // is written this way, with the gate voltage read from its partner; a gate voltage typed as
    // a number, as here, is taken as the author's statement of it.
    expect(
      warnings(withK({ L: '0.5u', W: '10u', vgs: '0.6', vds: '0.6', vsb: 'V_x' }, { V_x: 'V_t' })),
    ).toEqual([]);
  });

  it('does not mark a width-and-current device whose current follows what the range end moves', () => {
    // The diode-side half of a matched pair: its partner's width, carrying the rest of what the
    // tail delivers, on the tail node. Nothing authored is kept across the move — the current is
    // re-read from the expression and the table is read at it and at the new body bias.
    expect(
      warnings(
        withK(
          { L: '0.5u', W: '10u', id: 'I_t*(1 - s)', vds: '0.6', vsb: 'V_x' },
          { V_x: 'V_t', I_t: 'V_t*1e-4' },
        ),
      ),
    ).toEqual([]);
    // A typed current beside a moved body bias is still a spec kept across the move.
    expect(
      warnings(withK({ L: '0.5u', W: '10u', id: '20e-6', vds: '0.6', vsb: 'V_x' }, { V_x: 'V_t' })),
    ).toHaveLength(1);
  });

  it('follows a range end through a node held under a gate', () => {
    // The node is re-solved at the range end from the expression it holds, which reads the
    // constrained V_t the range end moves. So a width-first device with its body on that node is
    // reached exactly as it is when the node is constrained.
    const doc = parent({
      params: [
        ...parent({}).params,
        { name: 'V_n', value: 0.2, min: 0, max: 0.4, hold: 'V_n + V_t' },
      ],
      blocks: [
        {
          name: 'k',
          doc: child({ L: '0.5u', W: '10u', gm_id: '10', vds: '0.6', vsb: 'V_x' }),
          params: { V_x: 'V_n' },
        },
      ],
    });
    const w = warnings(doc);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /range end "hi" reaches the givens at "k", which fix a width, through "vsb"/,
    );
  });

  it('notes, without warning, a current that follows something the range end moves', () => {
    // A current authored as an expression is the hardware description at a range end — a mirror
    // ratio, a share of another device's current — so it is re-evaluated there on purpose and the
    // held device carries the new value. Nothing to fix; the author of a range claim should
    // still see that the current is not the one the design was sized at.
    const doc = withK({ L: '0.5u', gm_id: '10', id: 'I_c', vds: '0.6' }, { I_c: '20u * CM_dc' });
    expect(warnings(doc)).toEqual([]);
    expect(notes(doc)).toEqual([
      'range end "hi" changes the current in the givens at "k": its expression reads "I_c", ' +
        'which moves there, so the device is held at its width and carries a different current',
    ]);
  });

  it('notes a device whose current is read from the table when the range end moves its drain', () => {
    // A width and no current: a mirror's output device. Its current is whatever the table says
    // at its operating point, so a range end that moves its drain changes it. A drain move draws
    // no WARNING (the device is still the same device); it does draw this note.
    const tied = withK({ L: '0.5u', W: '10u', vgs: '0.6', vds: 'V_x' }, { V_x: 'V_t' });
    expect(warnings(tied)).toEqual([]);
    expect(notes(tied)).toEqual([
      'range end "hi" moves the "vds" of the givens at "k", whose current is read from the table ' +
        'rather than given — that current is different there, and so is any current derived from it',
    ]);
    // Given its current as well, the same device's current is the authored one: no note.
    expect(notes(withK({ L: '0.5u', W: '10u', id: '20u', vds: 'V_x' }, { V_x: 'V_t' }))).toEqual(
      [],
    );
  });

  it("does not warn when a tied device follows its partner's gate to a new voltage", () => {
    // The mirror shape: `r` is diode-connected and carries a current the range end changes, so
    // its gate settles somewhere else; `k` is given r's width and r's gate voltage. That reach
    // through `vgs` is the tie doing its job — the device is read at exactly the voltage its
    // partner sits at — so it draws no warning, only the note that k's current changed.
    const doc = parent({
      blocks: [
        {
          name: 'r',
          doc: child({ L: '0.5u', gm_id: '10', id: 'I_c', diode: true }, ['W', 'vgs']),
          params: { I_c: '20u * CM_dc' },
        },
        {
          name: 'k',
          doc: child({ L: '0.5u', W: '10u', vgs: 'V_x', vds: '0.6' }),
          params: { V_x: 'r__vgs' },
        },
      ],
    });
    expect(warnings(doc)).toEqual([]);
    expect(notes(doc)).toEqual([
      expect.stringMatching(/^range end "hi" changes the current in the givens at "r"/),
      expect.stringMatching(/^range end "hi" moves the "vgs" of the givens at "k"/),
    ]);
  });

  it('follows a table-read current into the device that takes its share', () => {
    // The tail-and-pair shape: `t` is tied to a gate and reads its current off the table at the
    // node the range end moves; `k` is given half of it. `k` has nothing else the range end
    // reaches, so its note exists only if the walk knows `t`'s current moved.
    const doc = parent({
      blocks: [
        {
          name: 't',
          doc: child({ L: '0.5u', W: '10u', vgs: '0.6', vds: 'V_x' }),
          params: { V_x: 'V_t' },
        },
        {
          name: 'k',
          doc: child({ L: '0.5u', gm_id: '10', id: 'I_c', vds: '0.6' }, ['gm']),
          params: { I_c: 't__id/2' },
        },
      ],
    });
    expect(notes(doc)).toEqual([
      expect.stringMatching(/^range end "hi" moves the "vds" of the givens at "t"/),
      expect.stringMatching(/^range end "hi" changes the current in the givens at "k"/),
    ]);
    // With `t` given its current instead, that current is held and `k` is not reached.
    const typed = parent({
      blocks: [
        {
          name: 't',
          doc: child({ L: '0.5u', gm_id: '10', id: '20u', vds: 'V_x' }),
          params: { V_x: 'V_t' },
        },
        {
          name: 'k',
          doc: child({ L: '0.5u', gm_id: '10', id: 'I_c', vds: '0.6' }, ['gm']),
          params: { I_c: 't__id/2' },
        },
      ],
    });
    expect(notes(typed)).toEqual([]);
  });

  it('reaches an earlier block through a node solved from a later one', () => {
    // The block order a tail-first sheet has: `t` is listed first and sits at the solved node;
    // the node is solved from `k`'s gate voltage, and `k` is listed second. A range end that
    // moves only `k`'s drain reaches `t` the long way round — k's operating point, the solved
    // node, t's drain — which one pass in document order would miss.
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [
        { name: 'V_o', value: 0.9 },
        { name: 'V_o_hi', value: 1.1 },
        { name: 'CM', value: 1.0 },
        {
          name: 'V_t',
          value: 0.4,
          min: 0,
          max: 1,
          designConstraint: { lhs: 'V_t + k__vgs', rhs: 'CM' },
        },
      ],
      equations: [],
      checks: [],
      blocks: [
        {
          name: 't',
          doc: child({ L: '0.5u', W: '10u', vgs: '0.6', vds: 'V_x' }),
          params: { V_x: 'V_t' },
        },
        {
          name: 'k',
          doc: child({ L: '0.5u', gm_id: '10', id: '20u', vds: 'V_x' }, ['vgs']),
          params: { V_x: 'V_o - V_t' },
        },
      ],
      operatingRange: [{ name: 'hi', set: { V_o: 'V_o_hi' } }],
    };
    expect(notes(doc)).toEqual([
      expect.stringMatching(/^range end "hi" moves the "vds" of the givens at "t"/),
    ]);
  });

  it('follows a range end through a sibling device onto the block it biases', () => {
    // The library's own shape: one device's settled gate sets another's bias. The reach has to
    // cross the block boundary — a block whose sizing moved publishes a different operating
    // point — or both checks go quiet on exactly the composition they exist for.
    const w = warnings(
      parent({
        blocks: [
          {
            name: 'r',
            doc: child({ L: '0.5u', gm_id: '10', id: 'I_c', vds: 'V_x' }, ['vgs']),
            params: { V_x: 'V_t' },
          },
          {
            name: 'k',
            doc: child({ L: '0.5u', W: '10u', gm_id: '10', vds: '0.6', vsb: 'V_x' }),
            params: { V_x: 'r__vgs * 0.5' },
          },
        ],
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /range end "hi" reaches the givens at "k", which fix a width, through "vsb"/,
    );
  });

  it('says the geometry moved when THAT is what a range end reaches', () => {
    // A different finding from the one above, and pointing an author at the operating point when
    // the transistor itself changed size would send them to the wrong place: width-first givens
    // are carried through untouched, so a moved W is a different device, not a different bias.
    const w = warnings(
      withK({ L: '0.5u', W: '10u * V_x', gm_id: '10', vds: '0.6' }, { V_x: 'V_t' }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/range end "hi" moves the "W" of the givens at "k" — it sizes a/);
  });

  it('reads a gate-tied device whose current a hold balances as one read from the table', () => {
    // Given a gate voltage, a current and no width, a device is held at its width and its current
    // unless a hold balances that current — then at its width and gate voltage, its authored
    // current not kept. So the same givens draw the old note undeclared, and the read-current
    // note declared.
    const balanced = (over: Partial<SheetDoc>, device: string): SheetDoc =>
      parent({
        ...over,
        params: [
          ...parent({}).params,
          { name: 'I_k', value: 2e-5, min: 1e-6, max: 1e-4, hold: `I_k - ${device}__id` },
        ],
      });
    const budget = {
      blocks: [
        {
          name: 'k',
          doc: child({ L: '0.5u', id: 'I_c', vgs: '0.6', vds: '0.6' }),
          params: { I_c: '20u * CM_dc' },
        },
      ],
    };
    expect(notes(parent(budget))).toEqual([
      expect.stringMatching(/^range end "hi" changes the current in the givens at "k"/),
    ]);
    expect(notes(balanced(budget, 'k'))).toEqual([]);
    const gate = {
      blocks: [
        {
          name: 'k',
          doc: child({ L: '0.5u', id: '20u', vgs: 'V_x', vds: '0.6' }),
          params: { V_x: 'V_t' },
        },
      ],
    };
    expect(notes(parent(gate))).toEqual([]);
    expect(warnings(balanced(gate, 'k'))).toEqual([]);
    expect(notes(balanced(gate, 'k'))).toEqual([
      'range end "hi" moves the "vgs" of the givens at "k", whose current is read from the table ' +
        'rather than given — that current is different there, and so is any current derived from it',
    ]);
    // And the current it reads moves whatever takes a share of it.
    const share: Partial<SheetDoc> = {
      blocks: [
        {
          name: 't',
          doc: child({ L: '0.5u', id: '20u', vgs: 'V_x', vds: '0.6' }),
          params: { V_x: 'V_t' },
        },
        {
          name: 'k',
          doc: child({ L: '0.5u', gm_id: '10', id: 'I_c', vds: '0.6' }, ['gm']),
          params: { I_c: 't__id/2' },
        },
      ],
    };
    expect(notes(balanced(share, 't'))).toEqual([
      expect.stringMatching(/^range end "hi" moves the "vgs" of the givens at "t"/),
      expect.stringMatching(/^range end "hi" changes the current in the givens at "k"/),
    ]);
    expect(notes(parent(share))).toEqual([]);
  });

  it('says nothing about a current that is simply a parent budget', () => {
    expect(
      warnings(withK({ L: '0.5u', gm_id: '10', id: 'I_c', vds: 'V_x' }, { V_x: 'V_t' })),
    ).toEqual([]);
  });

  it('is advisory only — the sheet still evaluates and still reaches a verdict', () => {
    const doc = withK({ L: '0.5u', gm_id: '10', id: 'I_c', vds: '0.6' }, { I_c: '20u * CM_dc' });
    const res = runSheet(doc, dev);
    expect(res.warnings.every((w) => w.severity !== 'error')).toBe(true);
    expect(res.rangeEnds?.[0].state).toBe('complies');
  });
});
