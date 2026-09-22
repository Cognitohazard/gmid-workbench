// Coverage semantics: the edge transformation, and what a fixed-hardware range check produces.
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
import { scalarScope } from '../expr';
import { runSheet, evaluateSheet, sweepSheet, sheetSensitivities, validateSheet } from './index';
import { pinHardware } from './coverage';
// The closed forms, from the module the library goldens share — not the fixtures that re-export
// them, whose import walks sheets/ off disk and builds a demo table this suite does not use.
import { gdsOf, relErr } from './library.math';
import { stands, treeRuleResults } from './types';
import type { BindReport, SheetChildReport, SheetDoc } from './types';

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

describe('the edge transformation — fixed hardware, decided on two booleans', () => {
  const report = (over: Partial<BindReport> = {}): BindReport => ({
    ok: true,
    W: 1.194e-6,
    L: 5e-7,
    vgs: 0.61,
    id: 2e-5,
    ...over,
  });
  const doc = (bind: SheetDoc['bind']): SheetDoc => ({
    title: 't',
    polarity: 'n',
    params: [{ name: 'I_d', value: 2e-5 }],
    rows: [{ name: 'r', expr: 'I_d * 2' }],
    rules: [{ id: 'x', kind: 'invariant', lhs: 'r', op: '>=', rhs: '0' }],
    bind,
  });
  const pin = (bind: SheetDoc['bind'], r: BindReport | undefined = report()): SheetDoc['bind'] =>
    pinHardware(doc(bind), { bind: r }).doc.bind;

  it('leaves a width-first bind exactly as authored', () => {
    // Already fixed hardware. Its partner is how the sheet writes a gate tie, and under a move
    // that shifts vds alone — every move the library's edges make — holding it reproduces the
    // tied device exactly. Dropping it would replace a wiring statement with an assumption.
    const b = { L: 'L_p', W: 'K*ref__W', gm_id: 'gm_id_m', vds: 'V_o' };
    expect(pin(b)).toEqual(b);
  });

  it('trades an authored selector for the solved width, and KEEPS the authored current', () => {
    // The current expression IS the hardware in the sheet's own algebra — a mirror ratio, a tail
    // split — so it re-evaluates at the range end on purpose. Only the operating-point spec goes.
    expect(pin({ L: 'L_p', gm_id: '10', id: 'I_tail/2', vds: 'V_o', vsb: 'V_t' })).toEqual({
      L: '5e-7',
      W: '0.000001194',
      id: 'I_tail/2',
      vds: 'V_o',
      vsb: 'V_t',
    });
  });

  it('pins the current too when the sheet never said where it comes from, and says so', () => {
    const p = pinHardware(doc({ L: 'L_p', gm: '2*pi*GBW*CL', gm_id: '10' }), { bind: report() });
    expect(p.doc.bind).toEqual({ L: '5e-7', W: '0.000001194', id: '0.00002' });
    expect(p.assumedSource).toEqual(['bind']);
  });

  it('drops EVERY operating-point selector, not a hand-copied subset', () => {
    // The list is derived from the device module's own selectors; a selector left behind would
    // re-size the transistor at the range end, which is what a fixed-hardware check must not do.
    for (const k of ['gm_id', 'ft', 'gm_gds', 'av0', 'vstar', 'vgs', 'gm']) {
      const out = pin({ L: 'L_p', [k]: '3', id: 'I_d' });
      expect(Object.keys(out!).sort(), k).toEqual(['L', 'W', 'id']);
    }
  });

  it('pins the length the sizing used, not the authored expression', () => {
    // An L that reads an edge-overridden param would otherwise hand the range end a different
    // transistor while the report claimed the hardware was fixed.
    expect(pin({ L: 'L_min * ratio', gm_id: '10', id: 'I_d' })!.L).toBe('5e-7');
  });

  it('injects numbers that parse back to the same double', () => {
    // A fixed-digit reformat would pin the design to a width the base run never sized.
    for (const W of [Math.PI * 1e-6, 1e-7, 1.2345678901234567e-9, 1e21, 5e-324]) {
      const expr = pin({ L: 'L_p', gm_id: '10', id: 'I_d' }, report({ W }))!.W as string;
      expect(compileExpr(expr).eval(scalarScope({})), expr).toBe(W);
    }
  });

  it('keys the tree by index, so two uses of one name still get their own hardware', () => {
    // evalChildren pushes exactly one report per use, dead ones included, so the indices align —
    // while names can duplicate on a document that reached the engine without validation.
    const leaf = (id: string): SheetDoc => ({
      title: 'c',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      bind: { L: 'L_p', gm_id: '10', id },
    });
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [
        { name: 'dup', doc: leaf('I_a') },
        { name: 'dup', doc: leaf('I_b') },
      ],
    };
    const kids: SheetChildReport[] = [
      {
        name: 'dup',
        title: 'c',
        feasible: true,
        bind: report({ W: 1e-6 }),
        provides: {},
        rules: [],
      },
      {
        name: 'dup',
        title: 'c',
        feasible: true,
        bind: report({ W: 2e-6 }),
        provides: {},
        rules: [],
      },
    ];
    const out = pinHardware(parent, { children: kids }).doc;
    expect(out.uses?.map((u) => u.doc?.bind?.W)).toEqual(['0.000001', '0.000002']);
    expect(out.uses?.map((u) => u.doc?.bind?.id)).toEqual(['I_a', 'I_b']);
  });

  it('leaves a bind alone when there is no hardware to pin it to', () => {
    // Degrade, never invent — the same discipline the rest of the engine takes. The caller gates
    // on the base run standing, so this is defence rather than a path in normal use.
    const b = { L: 'L_p', gm_id: '10', id: 'I_d' };
    expect(pinHardware(doc(b), {}).doc.bind).toEqual(b); // no report at all
    expect(pin(b, report({ ok: false, W: NaN, L: NaN }))).toEqual(b);
  });

  it('touches nothing but the binds', () => {
    const p = pinHardware(doc({ L: 'L_p', gm_id: '10', id: 'I_d', diode: true }), {
      bind: report(),
    }).doc;
    expect(p.params).toEqual([{ name: 'I_d', value: 2e-5 }]);
    expect(p.rows).toEqual([{ name: 'r', expr: 'I_d * 2' }]);
    expect(p.rules).toEqual([{ id: 'x', kind: 'invariant', lhs: 'r', op: '>=', rhs: '0' }]);
    expect(p.bind?.diode).toBe(true); // wiring, not a sizing spec
  });
});

// ---------------------------------------------------------------------------------------
// What a coverage run produces, on a body-biased table
// ---------------------------------------------------------------------------------------

describe('coverage runs re-bias the design instead of re-sizing it', () => {
  const L = 5e-7; // VA = 2.5 V here
  const ID = 2e-5;

  /** One device, biased by the parent, exposing what a range-end golden needs to see. */
  const device = (vds: string, vsb: string): SheetDoc => ({
    title: 'device',
    polarity: 'n',
    provide: ['gm_id', 'gds', 'vgs'],
    params: [
      { name: 'V_d', value: 0.6 },
      { name: 'V_s', value: 0.4 },
      { name: 'I_d', value: ID },
    ],
    rows: [],
    rules: [],
    bind: { L: '0.5u', gm_id: '10', id: 'I_d', vds, vsb },
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
    rows: [],
    rules: [{ id: 'inverted', kind: 'invariant', lhs: 'm__gm_id', op: '>=', rhs: '1' }],
    uses: [{ name: 'm', doc: device('V_d', 'V_s'), params: { V_d: 'V_o', V_s: 'VSB' } }],
    ...over,
  });

  const bindAt = (c: SheetChildReport | undefined): BindReport => c!.bind!;

  it('holds the transistor and lets the body effect move the gate, and only the gate', () => {
    // The purest fixed-hardware statement the model can make: at a fixed vds and a fixed current
    // the demo's body effect is a pure threshold translation, so dropping vsb by 0.4 V must move
    // vgs down by exactly BODY_FACTOR·0.4 = 80 mV and leave the device otherwise untouched.
    //
    // A law, not a discriminator: because that translation is exact, a device sized to a gm/ID
    // spec at the range end would land on this same point, so re-sizing here is indistinguishable
    // from re-biasing. The two tests below are the ones that tell them apart — both need the
    // drain to move, which on this model is the only channel that separates them.
    const res = runSheet(mk({ edges: [{ name: 'body-lo', set: { VSB: 'VSB_lo' } }] }), dev);
    expect(res.covers).toBe(true);
    const base = bindAt(res.children?.[0]);
    const end = bindAt(res.edges?.[0].children?.[0]);
    expect(end.W).toBe(base.W); // to the last bit: this is the same transistor
    expect(end.L).toBe(base.L);
    expect(end.id).toBe(base.id); // the authored current, re-evaluated to the same number
    expect(end.vgs - base.vgs).toBeCloseTo(-BODY_FACTOR * 0.4, 9);
    expect(res.edges?.[0].children?.[0].provides.gm_id).toBeCloseTo(10, 3);
  });

  it('re-settles the operating point when the range end moves the drain', () => {
    // vds 0.6 → 1.0 at VA = 2.5 V. Under fixed hardware the current density is what is held, so
    // the channel-length-modulation factor rising 1.24 → 1.4 must come back out of the inversion
    // level: iNorm falls by 1.24/1.4, gm/ID rises off its authored 10 to (1 − e^-s)/(n·U_T·s) at
    // s = s(gm/ID = 10)·sqrt(1.24/1.4) = 10.5016, and gds is id/(VA + vds) at the new vds.
    // A range end free to re-size would instead give the device 88.57% of its width
    // and read gm/ID = 10 exactly at an unchanged vgs — which is what these numbers rule out.
    const res = runSheet(mk({ edges: [{ name: 'vds-hi', set: { V_o: 'V_o_hi' } }] }), dev);
    expect(res.covers).toBe(true);
    const base = bindAt(res.children?.[0]);
    const end = bindAt(res.edges?.[0].children?.[0]);
    expect(end.W).toBe(base.W);
    expect(end.vgs).toBeLessThan(base.vgs);
    const at = res.edges?.[0].children?.[0].provides;
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
      provide: ['vgs'],
    };
    const res = runSheet(
      mk({
        uses: [
          { name: 'r', doc: ref, params: { V_s: 'VSB' } },
          { name: 'm', doc: device('V_d', '0'), params: { V_d: 'VDD - r__vgs' } },
        ],
        edges: [{ name: 'body-lo', set: { VSB: 'VSB_lo' } }],
      }),
      dev,
    );
    expect(res.covers).toBe(true);
    const [rBase, mBase] = (res.children ?? []).map(bindAt);
    const [rEnd, mEnd] = (res.edges?.[0].children ?? []).map(bindAt);
    expect(rEnd.vgs - rBase.vgs).toBeCloseTo(-BODY_FACTOR * 0.4, 9);
    expect(rEnd.W).toBe(rBase.W);
    expect(mEnd.W).toBe(mBase.W);
    const vds = mEnd.bias!.vds;
    expect(vds - mBase.bias!.vds).toBeCloseTo(BODY_FACTOR * 0.4, 6);
    const at = res.edges?.[0].children?.[1].provides;
    expect(at!.gm_id).toBeGreaterThan(10); // exactly 10 if the device had re-sized instead
    expect(relErr(at!.gds, gdsOf(ID, L, vds))).toBeLessThan(1e-9);
  });

  it('re-reads gm at a range end, so even an end that moves nothing is not bit-identical', () => {
    // The one thing a fixed-hardware end does NOT hold. The base bind names a gm/ID, which the
    // sizer honours arithmetically (gm = gm_id·I_D); its rewritten (W, I_D) form has no ratio to
    // honour and reads gm back off the operating point the pinned width lands on. So this edge —
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
        uses: [
          {
            name: 'm',
            doc: {
              ...device('V_d', '0'),
              provide: ['gm', 'gm_id'],
              bind: { L: '0.5u', gm_id: '12', id: '10u', vds: 'V_d' },
            },
            params: { V_d: 'V_o' },
          },
        ],
        edges: [{ name: 'null', set: { V_o: 'V_o' } }],
      }),
      dev,
    );
    expect(res.covers).toBe(true);
    const base = bindAt(res.children?.[0]);
    const end = bindAt(res.edges?.[0].children?.[0]);
    expect(end.W).toBe(base.W);
    expect(end.L).toBe(base.L);
    expect(end.id).toBe(base.id);
    expect(end.vgs).toBe(base.vgs);
    const baseAt = res.children![0].provides;
    const endAt = res.edges![0].children![0].provides;
    expect(baseAt.gm_id).toBe(12); // the authored ratio, honoured exactly
    const drift = 1 - endAt.gm / baseAt.gm;
    expect(drift).toBeGreaterThan(0);
    expect(drift).toBeLessThan(2e-3);
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
      rows: [],
      rules: [],
      bind: { L: '0.5u', gm_id: '2.8', id: '20u', vds: '0.6', vsb: 'VSB' },
      edges: [{ name: 'body-hi', set: { VSB: 'VSB_hi' } }],
    };
    const res = runSheet(doc, dev);
    expect(res.bind?.ok).toBe(true); // the center sized; it is the range end that cannot
    const e = res.edges?.[0];
    expect(e?.state).toBe('does-not-cover');
    expect(e?.error).toMatch(/^this device cannot carry its authored current at the endpoint bias/);
    expect(e?.error).toMatch(/inverse lookup: id .* out of range/); // the reach, verbatim
    expect(res.covers).toBe(false);
  });

  it('names the transconductance instead when that is what the endpoint cannot reach', () => {
    // A width-first bind is carried through untouched, so the quantity it runs out of table on is
    // whichever one it authored. Saying "current" over a gm bind would describe the wrong
    // quantity to the one reader who most needs it named.
    const doc: SheetDoc = {
      title: 'edge-of-table-gm',
      polarity: 'n',
      params: [
        { name: 'VSB', value: 0, min: 0, max: 0.4 },
        { name: 'VSB_hi', value: 0.4 },
      ],
      rows: [],
      rules: [],
      bind: { L: '0.5u', W: '10u', gm: '8e-3', vds: '0.6', vsb: 'VSB' },
      edges: [{ name: 'body-hi', set: { VSB: 'VSB_hi' } }],
    };
    const e = runSheet(doc, dev).edges?.[0];
    expect(e?.state).toBe('does-not-cover');
    expect(e?.error).toMatch(
      /^this device cannot reach its authored transconductance at the endpoint bias/,
    );
    expect(e?.error).toMatch(/inverse lookup: gm .* out of range/);
  });
});

// ---------------------------------------------------------------------------------------
// The standing-center gate
// ---------------------------------------------------------------------------------------

describe('coverage is only asked of a design that exists', () => {
  /** A sheet whose pin cannot reach its target, with a bind that sizes at every probe. */
  const unreachable = (T: number): SheetDoc => ({
    title: 'g',
    polarity: 'n',
    params: [
      { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'Spec' } },
      { name: 'Spec', value: T },
      { name: 'Spec_lo', value: 3 },
      { name: 'floor', value: 0.5 },
    ],
    rows: [{ name: 'y', expr: '2*x + 1' }],
    rules: [{ id: 'node-floor', kind: 'invariant', lhs: 'x', op: '>=', rhs: 'floor' }],
    bind: { L: '0.5u', gm_id: '10', id: '20u', vds: '0.6', vsb: '0' },
    edges: [{ name: 'lo', set: { Spec: 'Spec_lo' } }],
  });

  it('skips the edges when the base run did not stand, and says the question went unasked', () => {
    // The case that makes "did the binds size" the wrong test: a pin that fails returns its LAST
    // BISECTION PROBE, so every bind in the result reads ok while the engine landed on nothing.
    // Pinning coverage hardware to that probe would report a verdict about a design that was
    // never produced — the same phantom the errored-edge guards elsewhere exist to refuse.
    const res = evaluateSheet(unreachable(0.5), dev);
    expect(res.bind?.ok).toBe(true);
    expect(stands(res)).toBe(false);
    expect(res.edges?.[0].state).toBe('not-checked');
    expect(res.edges?.[0].error).toBeUndefined(); // "we did not check" is not "it broke"
    expect(res.edges?.[0].set).toEqual({}); // no point was proven, so none is reported
    expect(res.covers).toBeUndefined(); // absent: the question has no answer here, not a false one
    expect(res.feasible).toBe(false);
  });

  it('checks the edges of a design that misses its spec — a failing rule is still a design', () => {
    const doc = unreachable(5);
    doc.params.find((p) => p.name === 'floor')!.value = 5; // base x = 2 fails the floor
    const res = evaluateSheet(doc, dev);
    expect(stands(res)).toBe(true);
    expect(res.rules[0].status).toBe('fail');
    expect(res.edges?.[0].state).toBe('does-not-cover'); // checked, and the floor fails there too
    expect(res.covers).toBe(false);
  });

  it('leaves a skipped edge out of the rules a caller can name', () => {
    const res = evaluateSheet(unreachable(0.5), dev);
    expect([...treeRuleResults(res).keys()]).toEqual(['node-floor']);
  });

  it('draws no edge failure on a sweep where coverage was never checked', () => {
    // A bottom clip here would put a cause on the chart the engine never established — and would
    // flatten the picker's objective across the whole region whose centers fail.
    const doc = unreachable(5);
    doc.params.find((p) => p.name === 'Spec')!.min = 0.5;
    doc.params.find((p) => p.name === 'Spec')!.max = 25; // y spans [1, 21]: the top is unreachable
    // y spans [1, 21] over the pin's bracket, so the two ends of this sweep have no design and
    // its interior does. The edge curve must be a GAP at the ends and a real margin between.
    const sw = sweepSheet(doc, 'Spec', dev, 5);
    const curve = sw.rules.find((r) => r.edge === 'lo')!;
    expect(curve.marginPct.map((m) => m === null)).toEqual([true, false, false, false, true]);
    expect(sw.feasible).toEqual([false, true, true, true, false]);
  });

  it('reports no sensitivity around a point that is not a design', () => {
    const s = sheetSensitivities(unreachable(0.5), dev, undefined, { params: ['floor'] });
    expect(s[0].error).toMatch(/does not evaluate at its own values/);
  });
});

// ---------------------------------------------------------------------------------------
// covers, beside feasible
// ---------------------------------------------------------------------------------------

describe('covers — the sub-verdict that names which question was answered', () => {
  const mk = (over: Partial<SheetDoc> = {}): SheetDoc => ({
    title: 'c',
    polarity: 'n',
    params: [
      { name: 'Spec', value: 5 },
      { name: 'Spec_lo', value: 3 },
      { name: 'Spec_hi', value: 7 },
      { name: 'cap', value: 20 },
    ],
    rows: [{ name: 'y', expr: '2*Spec' }],
    rules: [{ id: 'ceil', kind: 'requirement', lhs: 'cap', op: '>=', rhs: 'y' }],
    edges: [
      { name: 'lo', set: { Spec: 'Spec_lo' } },
      { name: 'hi', set: { Spec: 'Spec_hi' } },
    ],
    ...over,
  });

  it('is true only when every claimed end holds', () => {
    const res = evaluateSheet(mk(), dev);
    expect(res.edges?.map((e) => e.state)).toEqual(['covers', 'covers']);
    expect(res.covers).toBe(true);
    expect(res.feasible).toBe(true);
  });

  it('separates a design that closes from one that holds across its range', () => {
    // The two questions, visibly apart: this design closes at its center (y = 10 ≤ 12) and stops
    // covering at the high end (y = 14). `feasible` keeps its aggregate meaning — the sheet's
    // whole claim, range included — while `covers` names which half gave way.
    const res = evaluateSheet(
      mk({ params: [...mk().params.slice(0, 3), { name: 'cap', value: 12 }] }),
      dev,
    );
    expect(res.rules[0].status).toBe('pass');
    expect(res.edges?.map((e) => e.state)).toEqual(['covers', 'does-not-cover']);
    expect(res.covers).toBe(false);
    expect(res.feasible).toBe(false);
  });

  it('is absent on a sheet that claims no range at all', () => {
    expect(evaluateSheet(mk({ edges: undefined }), dev).covers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// Where an authored sheet reaches past what fixed hardware can say
// ---------------------------------------------------------------------------------------

describe('validation marks the reach of a range claim, and never repairs it', () => {
  const warnings = (doc: SheetDoc): string[] =>
    validateSheet(doc)
      .filter((w) => w.severity === 'warning' && /^edge "/.test(w.message))
      .map((w) => w.message);

  /** A device driven by the parent, so a range end can reach its bind through the wiring. */
  const child = (bind: SheetDoc['bind'], provide = ['id']): SheetDoc => ({
    title: 'c',
    polarity: 'n',
    provide,
    params: [
      { name: 'V_x', value: 0.6 },
      { name: 'I_c', value: 2e-5 },
    ],
    rows: [],
    rules: [],
    bind,
  });

  const parent = (over: Partial<SheetDoc>): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    params: [
      { name: 'CM_dc', value: 0.9, min: 0.7, max: 1.3 },
      { name: 'CM_hi', value: 1.2 },
      { name: 'V_t', value: 0.4, min: 0, max: 1, pin: { lhs: 'CM_out', rhs: 'CM_dc' } },
    ],
    // The pin's own relation reads the edge-overridden param, so the node it solves for — and
    // the row that names it — move at the range end. That two-hop reach is what the checks below
    // have to follow; a direct-reference test alone would pass on a validator that never closed.
    rows: [{ name: 'CM_out', expr: 'V_t + 0.5' }],
    rules: [],
    edges: [{ name: 'hi', set: { CM_dc: 'CM_hi' } }],
    ...over,
  });

  /** The single-use shape every reach test below is a variation of. */
  const withK = (bind: SheetDoc['bind'], params: Record<string, string>): SheetDoc =>
    parent({ uses: [{ name: 'k', doc: child(bind), params }] });

  it('says nothing when a range end reaches a device through its drain alone', () => {
    // The exact case: a width-first bind at a moved vds reproduces its gate tie to the digit.
    // Warning here would fire on every mirror in the library, which is the false flag that
    // makes a QA signal worthless.
    expect(
      warnings(withK({ L: '0.5u', W: '10u', gm_id: '10', vds: 'V_x' }, { V_x: 'V_t' })),
    ).toEqual([]);
  });

  it('marks a width-first bind a range end reaches through anything but the drain', () => {
    // Body bias is the case that bites: holding the operating-point spec across a vsb move
    // keeps a current a gate-tied device would lose. The engine cannot express the tie — vgs is
    // not bindable — so naming the reach is the honest thing available.
    const w = warnings(
      withK({ L: '0.5u', W: '10u', gm_id: '10', vds: '0.6', vsb: 'V_x' }, { V_x: 'V_t' }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/edge "hi" reaches the bind at "k", which fixes a width, through "vsb"/);
  });

  it('marks a current that tracks the condition being swept', () => {
    // A current authored to follow the input common mode is the tail-source non-ideality the
    // fidelity statement puts out of scope — not hardware wearing the shape of hardware.
    const w = warnings(
      withK({ L: '0.5u', gm_id: '10', id: 'I_c', vds: '0.6' }, { I_c: '20u * CM_dc' }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/edge "hi" reaches the current expression of the bind at "k"/);
  });

  it('follows a range end through a sibling device onto the block it biases', () => {
    // The library's own shape: one device's settled gate sets another's bias. The reach has to
    // cross the block boundary — a block whose sizing moved publishes a different operating
    // point — or both checks go quiet on exactly the composition they exist for.
    const w = warnings(
      parent({
        uses: [
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
    expect(w[0]).toMatch(/edge "hi" reaches the bind at "k", which fixes a width, through "vsb"/);
  });

  it('says the geometry moved when THAT is what a range end reaches', () => {
    // A different finding from the one above, and pointing an author at the operating point when
    // the transistor itself changed size would send them to the wrong place: a width-first bind
    // is carried through untouched, so a moved W is a different device, not a different bias.
    const w = warnings(
      withK({ L: '0.5u', W: '10u * V_x', gm_id: '10', vds: '0.6' }, { V_x: 'V_t' }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/edge "hi" moves the "W" of the bind at "k" — the range end sizes a/);
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
    expect(res.edges?.[0].state).toBe('covers');
  });
});
