// The DC-input rule (`sheet-dc-inputs`) and the assumption list a result carries. Each case is a
// small purpose-built document whose DC inputs can be read off by eye: which params a device's
// bias is built from, and what class each one was given. The expectations are those readings,
// not anything the engine computed.

import { describe, it, expect } from 'vitest';
import { compileExpr } from '../derive';
import { additiveCoefficient } from '../expr';
import { dcInputs, EXAMPLES, exprRoots, runSheet, validateSheet } from './index';
import { reachedGivens, solvePlan } from './validate';
import { heldShape } from './coverage';
import { holdAsConstraint, holds } from './types';
import { GIVENS_FLAGS, type SheetGivens, type SheetDoc, type SheetVar } from './types';
import { loadLibrary, REFS, sheet, table, notACircuit } from './library.fixtures';
import { resolveSheetRefs } from './resolve';

/** A leaf that sizes one device with its drain bias taken from the param `vd`. */
const leaf = (givens: Partial<SheetGivens> = {}, params: SheetVar[] = []): SheetDoc => ({
  title: 'leaf',
  polarity: 'n',
  params: [
    { name: 'L', value: 0.5e-6, unit: 'm' },
    { name: 'I', value: 10e-6, unit: 'A' },
    { name: 'vd', value: 0.6, unit: 'V' },
    ...params,
  ],
  givens: { L: 'L', id: 'I', gm_id: '10', vds: 'vd', ...givens },
  equations: [],
  checks: [],
  provides: ['vgs', 'id'],
});

/** The leaf with its drain-bias param `vd` amended. */
const withVd = (patch: Partial<SheetVar>): SheetDoc => {
  const d = leaf();
  d.params = d.params.map((p) => (p.name === 'vd' ? { ...p, ...patch } : p));
  return d;
};

/** A grandchild leaf biased from the top-level VDD through two override hops (top → mid → leaf). */
const overrideChain = (cls?: 'independent'): SheetDoc => ({
  title: 'top',
  polarity: 'n',
  params: [{ name: 'VDD', value: 1.8, unit: 'V', ...(cls ? { class: cls } : {}) }],
  equations: [],
  checks: [],
  blocks: [
    {
      name: 'mid',
      doc: {
        title: 'mid',
        polarity: 'n',
        params: [{ name: 'V_m', value: 1, unit: 'V' }],
        equations: [],
        checks: [],
        blocks: [{ name: 'leaf', doc: leaf(), params: { vd: 'V_m - 0.2' } }],
      },
      params: { V_m: 'VDD' },
    },
  ],
});

/** The top device's drain reads `c__g__lvl`: c re-exports its child g's equation `lvl`, which is
 *  g's own voltage V_g — or, when `fed`, the top-level V_top handed down through c's param V_c. */
const reExport = (fed = false): SheetDoc => {
  const g: SheetDoc = {
    title: 'g',
    polarity: 'n',
    params: [{ name: 'V_g', value: 0.5, unit: 'V' }],
    equations: [{ name: 'lvl', expr: 'V_g + 0.1' }],
    checks: [],
    provides: ['lvl'],
  };
  const c: SheetDoc = {
    title: 'c',
    polarity: 'n',
    params: fed ? [{ name: 'V_c', value: 0.5, unit: 'V' }] : [],
    equations: [],
    checks: [],
    blocks: [{ name: 'g', doc: g, ...(fed ? { params: { V_g: 'V_c' } } : {}) }],
    provides: ['g__lvl'],
  };
  const top = leaf({ vds: 'c__g__lvl' }, fed ? [{ name: 'V_top', value: 0.4, unit: 'V' }] : []);
  return { ...top, blocks: [{ name: 'c', doc: c, ...(fed ? { params: { V_c: 'V_top' } } : {}) }] };
};

/** A drain biased from V_c, with a range end substituting V_lo for it. */
const rangeEndDoc = (lo: Partial<SheetVar>): SheetDoc => ({
  ...leaf({ vds: 'V_c' }),
  params: [
    ...leaf().params,
    { name: 'V_c', value: 0.6, unit: 'V', class: 'independent' },
    { name: 'V_lo', value: 0.3, unit: 'V', ...lo },
  ],
  operatingRange: [{ name: 'lo', set: { V_c: 'V_lo' } }],
});

/** A pair device standing on a tail node that the engine constrains so the common mode lands on CM.
 *  */
const constrainedTail = (tail: Partial<SheetVar> = {}): SheetDoc => ({
  title: 't',
  polarity: 'n',
  params: [
    { name: 'CM', value: 1, unit: 'V', class: 'independent' },
    { name: 'V_out', value: 1.2, unit: 'V', class: 'assumed' },
    {
      name: 'V_tail',
      value: 0.3,
      min: 0.05,
      max: 0.8,
      unit: 'V',
      designConstraint: { lhs: 'V_tail + m__vgs', rhs: 'CM' },
      ...tail,
    },
  ],
  equations: [],
  checks: [],
  blocks: [
    {
      name: 'm',
      doc: leaf({ vsb: 'vs' }, [{ name: 'vs', value: 0, unit: 'V' }]),
      params: { vd: 'V_out - V_tail', vs: 'V_tail' },
    },
  ],
});

/** A leaf whose source node V_s the engine constrains so that V_s + vgs lands on CM_k; its drain
 *  level is stated. */
const constrainedSource = (): SheetDoc => {
  const d = leaf({ vsb: 'V_s' }, [
    {
      name: 'V_s',
      value: 0.2,
      min: 0,
      max: 0.8,
      unit: 'V',
      designConstraint: { lhs: 'V_s + vgs', rhs: 'CM_k' },
    },
    { name: 'CM_k', value: 0.9, unit: 'V' },
  ]);
  d.params = d.params.map((p) => (p.name === 'vd' ? { ...p, class: 'independent' } : p));
  return d;
};

/** A drain V_x torn against the equation `tgt`, which reads V_up: V_x is solved, V_up decides it.
 *  */
const tornDrain = (up: Partial<SheetVar>): SheetDoc => ({
  ...leaf({ vds: 'V_x' }),
  params: [
    ...leaf().params,
    { name: 'V_x', value: 0.5, min: 0, max: 1.2, unit: 'V', solveFor: 'tgt' },
    { name: 'V_up', value: 0.7, unit: 'V', ...up },
  ],
  equations: [{ name: 'tgt', expr: 'V_up - 0.1' }],
});

/** A parent embedding `child` as `k` and overriding `name` with the assumed parent voltage `V_p`. */
const overriding = (child: SheetDoc, name: string): SheetDoc => ({
  title: 'p',
  polarity: 'n',
  params: [{ name: 'V_p', value: 0.3, unit: 'V', class: 'assumed' }],
  equations: [],
  checks: [],
  blocks: [{ name: 'k', doc: child, params: { [name]: 'V_p' } }],
});

const dcFindings = (doc: SheetDoc) =>
  validateSheet(doc).filter((w) => w.rule === 'sheet-dc-inputs' && w.severity === 'error');

describe('sheet-dc-inputs — every voltage a device is biased from carries a class', () => {
  it('an unclassified voltage root is an error naming the param and the device it sizes', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'V_node', value: 0.9, unit: 'V' }],
      equations: [],
      checks: [],
      blocks: [{ name: 'm', doc: leaf(), params: { vd: 'V_node - 0.1' } }],
    };
    const errs = dcFindings(doc);
    expect(errs).toHaveLength(1);
    expect(errs[0].symbol).toBe('V_node');
    expect(errs[0].message).toMatch(/"V_node"/);
    expect(errs[0].message).toMatch(/"m"/);
  });

  it("names the sheet's own device when the root feeds the top-level givens", () => {
    const doc = leaf();
    const errs = dcFindings(doc);
    expect(errs.map((w) => w.symbol)).toEqual(['vd']);
    expect(errs[0].message).toMatch(/this sheet's own device/);
  });

  it('lists independent and assumed roots by class, and raises nothing', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [
        { name: 'VDD', value: 1.8, unit: 'V', class: 'independent' },
        { name: 'V_out', value: 0.9, unit: 'V', class: 'assumed' },
      ],
      equations: [],
      checks: [],
      blocks: [
        { name: 'lo', doc: leaf(), params: { vd: 'V_out' } },
        { name: 'hi', doc: leaf(), params: { vd: 'VDD - V_out' } },
      ],
    };
    expect(dcFindings(doc)).toEqual([]);
    const r = dcInputs(doc);
    expect(r.independent).toEqual(['VDD']);
    expect(r.assumed).toEqual(['V_out']);
    expect(r.solved).toEqual([]);
  });

  it('a voltage param that reaches no device needs no class', () => {
    const doc: SheetDoc = {
      ...leaf({ vds: '0.6' }),
      // One unused, one read only by a check: neither is part of any device's bias.
      params: [...leaf().params, { name: 'V_spare', value: 1, unit: 'V' }],
      checks: [{ id: 'r', kind: 'advisory', lhs: 'vd', op: '<=', rhs: 'V_spare' }],
    };
    expect(dcFindings(doc)).toEqual([]);
    expect(dcInputs(doc).unclassified).toEqual([]);
  });

  it('follows a grandchild back to a top-level param through two override hops', () => {
    // Unclassified: the grandchild's bias is VDD's, and the finding names that grandchild by path.
    const errs = dcFindings(overrideChain());
    expect(errs.map((w) => w.symbol)).toEqual(['VDD']);
    expect(errs[0].message).toMatch(/"mid\.leaf"/);
    // Classified: found, and the overridden params in between are not roots.
    const r = dcInputs(overrideChain('independent'));
    expect(r.independent).toEqual(['VDD']);
    expect(r.unclassified).toEqual([]);
  });

  it('a root the parent does not override is the child’s own, qualified by its path', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'k', doc: leaf() }],
    };
    expect(dcFindings(doc).map((w) => w.symbol)).toEqual(['k.vd']);
  });

  it('a child param named like an object built-in is overridden only by its own key', () => {
    // The parent overrides `I` and nothing else, so the child's `constructor` voltage keeps its
    // own value and is the child's root, exactly as it is when the child stands alone.
    const child = leaf({ vds: 'constructor' }, [{ name: 'constructor', value: 0.6, unit: 'V' }]);
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'k', doc: child, params: { I: '2e-5' } }],
    };
    expect(dcFindings(child).map((w) => w.symbol)).toEqual(['constructor']);
    expect(dcFindings(doc).map((w) => w.symbol)).toEqual(['k.constructor']);
  });
});

describe('sheet-dc-inputs — what the walk follows, and what it does not', () => {
  it('a value a range end substitutes is a DC input like the centre it replaces', () => {
    expect(dcFindings(rangeEndDoc({})).map((w) => w.symbol)).toEqual(['V_lo']);
    expect(dcInputs(rangeEndDoc({ class: 'independent' })).independent).toEqual(['V_c', 'V_lo']);
    // An assumed range end is reported with the result, exactly as an assumed centre would be.
    expect(runSheet(rangeEndDoc({ class: 'assumed' }), table).assumptions).toEqual(['V_lo']);
  });

  it('follows a grandchild scalar a child re-exports up to the param behind it', () => {
    // Nothing but the re-export reads V_g, so it is reached only through `c__g__lvl`.
    const errs = dcFindings(reExport());
    expect(errs.map((w) => w.symbol)).toEqual(['c.g.V_g']);
    expect(errs[0].message).toMatch(/this sheet's own device/);
  });

  it('a name it cannot place is left to the other checks, never read as the device itself', () => {
    // A child known only by reference, a key the child does not provide, and a misspelt name:
    // none of them is the top device's own quantity, so none of them is a loop through it.
    const refOnly: SheetDoc = {
      ...leaf({ vds: 'vd - c__vgs' }),
      blocks: [{ name: 'c', ref: 'somewhere/else' }],
    };
    const unprovided: SheetDoc = {
      ...leaf({ vds: 'vd - c__vth' }),
      blocks: [{ name: 'c', doc: leaf() }],
    };
    const typo: SheetDoc = leaf({ vds: 'vd - vdd_typo' });
    for (const doc of [refOnly, unprovided, typo]) {
      const cycles = dcInputs(doc).cycles;
      expect(cycles).toEqual([]);
    }
  });

  it('before the sizing runs `w` is the table width, not the device: a given in unit widths is no loop', () => {
    // A given is evaluated before its device is sized, when `w` is still the table's
    // characterization width, so `W: 4*w` reads the table, not this device's own operating point.
    // The sheet validates clean and sizes to exactly four table widths.
    const doc: SheetDoc = notACircuit({
      ...withVd({ class: 'independent' }),
      givens: { L: 'L', W: '4*w', gm_id: '10', vds: 'vd' },
    });
    expect(validateSheet(doc).filter((w) => w.severity === 'error')).toEqual([]);
    const res = runSheet(doc, table);
    expect(res.sizing?.ok, res.sizing?.error).toBe(true);
    expect(res.feasible).toBe(true);
    expect(res.sizing!.W / table.meta.W!).toBeCloseTo(4, 12);
  });

  it("a sizing child's provided pass-through column is that child's device", () => {
    // `foo` is none of c's params or equations, so c can only publish it from its sizing — the
    // table read at c's operating point. c's drain is the top device's own vgs, and the top
    // device's drain is c__foo: each device's sizing rests on the other's, with nothing solving the
    // loop, so both are reported.
    const doc: SheetDoc = {
      ...leaf({ vds: 'c__foo' }),
      blocks: [{ name: 'c', doc: { ...leaf(), provides: ['foo'] }, params: { vd: 'vgs' } }],
    };
    expect(dcInputs(doc).cycles.map((c) => c.device)).toEqual(['givens', 'c']);
  });

  it("a sizing child's provided equation or param is followed into the child, not read as its device", () => {
    // c sizes its own device from L, I and its stated vd; V_r is none of those. The top device's
    // drain reads V_r through c — by an equation `lvl = V_r + 0.1`, or by the param itself — so V_r
    // is a DC input of the top device alone, and it carries no class. Reading either key as c's
    // device would follow c's givens instead, which never reach V_r.
    const viaChild = (key: string, equations: SheetDoc['equations']): SheetDoc => {
      const c = withVd({ class: 'independent' });
      c.params.push({ name: 'V_r', value: 0.5, unit: 'V' });
      return {
        ...leaf({ vds: `c__${key}` }),
        blocks: [{ name: 'c', doc: { ...c, equations, provides: [key] } }],
      };
    };
    const expected = [{ param: 'c.V_r', devices: ['givens'] }];
    const viaEquation = viaChild('lvl', [{ name: 'lvl', expr: 'V_r + 0.1' }]);
    expect(dcInputs(viaEquation).unclassified).toEqual(expected);
    expect(dcInputs(viaChild('V_r', [])).unclassified).toEqual(expected);
  });
});

describe('sheet-dc-inputs — solved is derived, never authored', () => {
  it('a constrained param is solved, and the spec on the far side of the constraint is a DC input too', () => {
    expect(dcFindings(constrainedTail())).toEqual([]);
    const r = dcInputs(constrainedTail());
    expect(r.solved).toEqual(['V_tail']);
    expect(r.independent).toEqual(['CM']);
    expect(r.assumed).toEqual(['V_out']);
  });

  it('the far side of a design constraint is held to the same rule', () => {
    const doc = constrainedTail();
    doc.params[0] = { name: 'CM', value: 1, unit: 'V' };
    expect(dcFindings(doc).map((w) => w.symbol)).toEqual(['CM']);
  });

  it('authoring class "solved" is an error', () => {
    const doc = withVd({ class: 'solved' as never });
    const errs = dcFindings(doc);
    expect(errs.some((w) => w.location === 'vd' && /derived, never authored/.test(w.message))).toBe(
      true,
    );
  });

  it('an unknown class, or a class on an engine-solved param, is an error', () => {
    const typo = withVd({ class: 'indepedent' as never });
    // The message offers the classes an author may write, which are exactly these two.
    expect(
      dcFindings(typo).some((w) =>
        /unknown class "indepedent" — use one of "independent", "assumed"$/.test(w.message),
      ),
    ).toBe(true);
    const both = constrainedTail({ class: 'assumed' });
    expect(dcFindings(both).map((w) => w.location)).toEqual(['V_tail']);
  });

  it('a parent override of a constrained child param is no input: the constraint and its far side are', () => {
    // The engine searches k's source node V_s in its own range and ignores the override, so V_p
    // decides nothing. V_s is solved, and CM_k — the voltage the constraint aims
    // the source at — is the real input, unclassified here.
    const r = dcInputs(overriding(constrainedSource(), 'V_s'));
    expect(r.solved).toEqual(['k.V_s']);
    expect(r.assumed).toEqual([]);
    expect(r.unclassified.map((u) => u.param)).toEqual(['k.CM_k']);
  });

  it('a parent override of a torn child param is ignored: the target behind it is the input', () => {
    // A solveFor param is searched in its own range like a constrained one, whatever is wired in.
    // So V_p is no input, V_x is solved, and V_up — which the target equation reads — must be
    // classified.
    const r = dcInputs(overriding(tornDrain({}), 'V_x'));
    expect(r.solved).toEqual(['k.V_x']);
    expect(r.assumed).toEqual([]);
    expect(r.unclassified.map((u) => u.param)).toEqual(['k.V_up']);
  });
});

describe('hold — a node under a gate is stated at the nominal run and re-solved where held', () => {
  /** The leaf with its drain on node X: `vds = vd - X`, body on X, and X carrying `patch`. */
  const onNode = (patch: Partial<SheetVar>): SheetDoc =>
    notACircuit(
      leaf({ vds: 'vd - X', vsb: 'X' }, [
        { name: 'X', value: 0.2, unit: 'V', min: 0, max: 0.4, ...patch },
      ]),
    );
  const errors = (doc: SheetDoc): string[] =>
    validateSheet(doc)
      .filter((w) => w.severity === 'error')
      .map((w) => w.message);

  it('classes a held node `held`: no authored class is asked for, and it is no assumption', () => {
    // X feeds the givens, so it is a DC input; the hold is what says where it comes from.
    const doc = onNode({ hold: 'X + vgs' });
    doc.params = doc.params.map((p) => (p.name === 'vd' ? { ...p, class: 'independent' } : p));
    expect(errors(doc)).toEqual([]);
    const r = dcInputs(doc);
    expect(r.held).toEqual(['X']);
    expect(r.unclassified).toEqual([]);
    expect(r.assumed).toEqual([]);
  });

  it('refuses a class on a held node, and a hold beside a design constraint or a solveFor', () => {
    expect(errors(onNode({ hold: 'X + vgs', class: 'assumed' }))).toContainEqual(
      expect.stringMatching(/param "X" carries hold, so its class is derived/),
    );
    const three = /param "X" carries hold and also has a design constraint or carries solveFor/;
    expect(
      errors(onNode({ hold: 'X + vgs', designConstraint: { lhs: 'X', rhs: 'vd' } })),
    ).toContainEqual(expect.stringMatching(three));
    expect(errors(onNode({ hold: 'X + vgs', solveFor: 'vgs' }))).toContainEqual(
      expect.stringMatching(three),
    );
  });

  it('needs a range to re-solve the node in', () => {
    expect(errors(onNode({ hold: 'X + vgs', min: undefined }))).toContainEqual(
      expect.stringMatching(/held param "X" needs finite min < max/),
    );
  });

  it('accepts only a sum in which the node appears once, bare or times a number', () => {
    // The node's own term has to be there to read: once, at the top of the sum.
    const shape = /hold ".*" must be a sum of terms in which X appears exactly once/;
    for (const ok of ['X + vgs', 'vd - X + vgs', '-(2*X) + vgs', '1e-9*X'])
      expect(errors(onNode({ hold: ok })).filter((m) => shape.test(m))).toEqual([]);
    for (const bad of [
      'vgs', // the node is absent
      '(0.7 + X) - 0.7 - X', // twice, and they cancel
      'X*vgs/vgs - X', // twice
      'X + abs(X)', // once as a term, once inside a call
      'X^2', // not a term of the sum
      'min(X, 2)',
      'X/2 + vgs', // divided, not multiplied by a number
      'vd*X + vgs', // the coefficient is a param
    ])
      expect(errors(onNode({ hold: bad }))).toContainEqual(expect.stringMatching(shape));
  });

  it('refuses a range end that sets a held node', () => {
    // A range end re-solves the node; an override there would be thrown away.
    const doc = onNode({ hold: 'X + vgs' });
    doc.operatingRange = [{ name: 'hi', set: { X: '0.3' } }];
    expect(errors(doc)).toContainEqual(
      expect.stringMatching(/range end "hi" sets "X", which carries hold/),
    );
  });

  it('groups held nodes that are held through each other into one set, and refuses nothing', () => {
    // Two nodes each held through the other's device: X through a quantity biased from Y, Y
    // through an equation that reads X. Typed, the sheet evaluates; held, the two depend on each
    // other, and a held run settles them together by repeated sweeps.
    const doc = notACircuit(
      leaf({ vds: 'vd - X', vsb: 'Y' }, [
        { name: 'X', value: 0.2, unit: 'V', min: 0, max: 0.4, hold: 'X + vgs' },
        { name: 'Y', value: 0.1, unit: 'V', min: 0, max: 0.4, hold: 'Y + r' },
      ]),
    );
    doc.equations = [{ name: 'r', expr: '2*X' }];
    doc.params = doc.params.map((p) => (p.name === 'vd' ? { ...p, class: 'independent' } : p));
    expect(errors(doc)).toEqual([]);
    const held = {
      ...doc,
      params: doc.params.map((p) => (holds(p) ? holdAsConstraint(p, '0.5') : p)),
    };
    expect(solvePlan(held)).toEqual([['X', 'Y']]);
  });
});

describe('hold — the solve order is checked on the document a range end really runs', () => {
  const errors = (doc: SheetDoc): string[] =>
    validateSheet(doc)
      .filter((w) => w.severity === 'error')
      .map((w) => w.message);
  const dev = (givens: SheetGivens, provide: string[]): SheetDoc => ({
    title: 'dev',
    polarity: 'n',
    params: [
      { name: 'L', value: 0.5e-6, unit: 'm' },
      { name: 'I', value: 10e-6, unit: 'A' },
      { name: 'gmT', value: 1e-4, unit: 'S' },
      { name: 'vd', value: 0.3, unit: 'V' },
      { name: 'vs', value: 0, unit: 'V' },
    ],
    givens,
    equations: [],
    checks: [],
    provides: provide,
  });
  /** A pair device under a cascode. The pair is given gm and gm/ID, so its current is a result
   *  of its sizing; the cascode carries that current. The tail is constrained to the common mode
   *  and the cascode node carries `node`. */
  const stack = (node: Partial<SheetVar>): SheetDoc =>
    notACircuit({
      title: 'stack',
      polarity: 'n',
      params: [
        { name: 'CM', value: 0.9, unit: 'V', class: 'independent' },
        { name: 'CM_hi', value: 1.0, unit: 'V', class: 'independent' },
        { name: 'V_out', value: 0.9, unit: 'V', class: 'independent' },
        {
          name: 'V_tail',
          value: 0.3,
          unit: 'V',
          min: 0.1,
          max: 0.45,
          designConstraint: { lhs: 'V_tail + in__vgs', rhs: 'CM' },
        },
        { name: 'V_a', value: 0.55, unit: 'V', min: 0.46, max: 0.85, ...node },
      ],
      equations: [],
      checks: [],
      blocks: [
        {
          name: 'in',
          doc: dev({ L: 'L', gm: 'gmT', gm_id: '10', vds: 'vd', vsb: 'vs' }, ['vgs', 'id']),
          params: { vd: 'V_a - V_tail', vs: 'V_tail' },
        },
        {
          name: 'casc',
          doc: dev({ L: 'L', id: 'I', gm_id: '10', vds: 'vd', vsb: 'vs' }, ['vgs']),
          params: { I: 'in__id', vd: 'V_out - V_a', vs: 'V_a' },
        },
      ],
      operatingRange: [{ name: 'hi', set: { CM: 'CM_hi' } }],
    });

  it('reads the givens as a range end rewrites them, not as authored', () => {
    // As authored, the pair's current comes out of its sizing, which reads the tail; the cascode
    // carries that current, so its gate-source voltage would wait on the tail while the tail
    // waits on the cascode node. A range end holds the pair's width and current as numbers, so
    // there the cascode reads no tail at all: two sets of one, the node, then the tail.
    expect(errors(stack({ hold: 'V_a + casc__vgs' }))).toEqual([]);
    expect(solvePlan(stack({ hold: 'V_a + casc__vgs' }))).toEqual([['V_tail']]);
    expect(solvePlan(heldShape(stack({ hold: 'V_a + casc__vgs' })))).toEqual([['V_a'], ['V_tail']]);
  });

  it('refuses nothing across levels: a child solves its own inside every probe of its parent', () => {
    // The parent constrains P against the child's Q; the child constrains Q against X/2; the parent
    // wires X = P. Each level's plan holds only its own solved params, so neither the sheet as
    // authored nor its fixed-hardware form has anything to refuse.
    const doc: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [
        { name: 'P', value: 0.5, min: 0, max: 1, designConstraint: { lhs: 'P + c__Q', rhs: '1' } },
      ],
      equations: [],
      checks: [],
      blocks: [
        {
          name: 'c',
          params: { X: 'P' },
          doc: {
            title: 'child',
            polarity: 'n',
            provides: ['Q'],
            params: [
              { name: 'Q', value: 0.5, min: 0, max: 1, designConstraint: { lhs: 'Q', rhs: 'X/2' } },
              { name: 'X', value: 0, min: 0, max: 1, hold: 'X + B' },
              { name: 'B', value: 0.1 },
            ],
            equations: [],
            checks: [],
          },
        },
      ],
    };
    expect(errors(doc)).toEqual([]);
    expect(solvePlan(doc)).toEqual([['P']]);
    expect(solvePlan(heldShape(doc))).toEqual([['P']]);
  });

  it('counts a held expression among the expressions a sheet reads', () => {
    // The cascode does not publish vgs here, so the hold names a scalar nothing provides. The
    // sheet says so the way it does for an equation or a design constraint.
    const doc = stack({ hold: 'V_a + casc__vgs' });
    doc.blocks![1].doc!.provides = [];
    expect(validateSheet(doc).map((w) => w.message)).toContainEqual(
      expect.stringMatching(/casc__vgs/),
    );
  });

  it('warns where a parent wires a value into a node its child holds', () => {
    // The wired value is honoured at the design point; a range end re-solves the node inside the
    // child, and the parent goes on reading its own number for it.
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [{ name: 'Xp', value: 0.25, unit: 'V', class: 'independent' }],
      equations: [],
      checks: [],
      blocks: [
        {
          name: 'k',
          params: { X: 'Xp' },
          doc: leaf({ vds: 'vd - X', vsb: 'X' }, [
            { name: 'X', value: 0.2, unit: 'V', min: 0, max: 0.4, hold: 'X + vgs' },
          ]),
        },
      ],
    };
    expect(
      validateSheet(doc)
        .filter((w) => w.severity === 'warning')
        .map((w) => w.message),
    ).toContainEqual(expect.stringMatching(/block "k" override "X" sets a node the child holds/));
  });

  it('reads no coefficient out of a source the engine cannot evaluate', () => {
    for (const src of ['X + foo[X]', 'X + "X"', 'X + (a + b)(2)'])
      expect(additiveCoefficient(src, 'X')).toBeUndefined();
    expect(additiveCoefficient('X + 100m', 'X')).toBe(1);
  });
});

describe('sheet-dc-inputs — a device may not depend on its own operating point unsolved', () => {
  // The top device's drain bias is read through a child's published equation, and that child is fed
  // back the top device's own gate voltage — a loop through a child's provide.
  const loop = (viaEstimate: boolean): SheetDoc => ({
    title: 't',
    polarity: 'n',
    params: [
      { name: 'L', value: 0.5e-6, unit: 'm' },
      { name: 'I', value: 10e-6, unit: 'A' },
      ...(viaEstimate ? [{ name: 'vgs_est', value: 0.6, unit: 'V', solveFor: 'vgs' }] : []),
    ],
    givens: { L: 'L', id: 'I', gm_id: '10', vds: 'c__x' },
    equations: [],
    checks: [],
    blocks: [
      {
        name: 'c',
        doc: {
          title: 'c',
          polarity: 'n',
          params: [{ name: 'p', value: 0.6 }],
          equations: [{ name: 'x', expr: '1.5*p' }],
          checks: [],
          provides: ['x'],
        },
        params: { p: viaEstimate ? 'vgs_est' : 'vgs' },
      },
    ],
  });

  it('is a cycle error naming the device', () => {
    const errs = dcFindings(loop(false));
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/depends on its own operating point/);
    expect(errs[0].message).toMatch(/this sheet's own device/);
  });

  it('is accepted when a solveFor closes it', () => {
    expect(dcFindings(loop(true))).toEqual([]);
    expect(dcInputs(loop(true)).solved).toEqual(['vgs_est']);
  });
});

describe('sheet-dc-inputs — the solve relation is followed upstream', () => {
  it('a voltage behind a solveFor target is a DC input and must be classified', () => {
    // V_up is what actually decides where the torn V_x lands, so it needs a class like any other
    // input.
    expect(dcFindings(tornDrain({})).map((w) => w.symbol)).toEqual(['V_up']);
    const r = dcInputs(tornDrain({ class: 'independent' }));
    expect(r.solved).toEqual(['V_x']);
    expect(r.independent).toEqual(['V_up']);
  });
});

describe('sheet-dc-inputs — curated reference sheets', () => {
  const classes = (path: string) => {
    const r = dcInputs(resolveSheetRefs(sheet(path), REFS).doc);
    const sorted = (xs: string[]) => [...xs].sort();
    return {
      independent: sorted(r.independent),
      assumed: sorted(r.assumed),
      solved: sorted(r.solved),
    };
  };

  it('5T OTA: the tail node and the split of the tail current are solved; the supply, the common mode, its range ends, the output level and the programmed current are stated', () => {
    // The design constraint moves V_tail until the produced common mode equals CM_dc; the range
    // ends substitute CM_lo and CM_hi for CM_dc. The output is a high-impedance node that only the
    // feedback the application closes around the amplifier holds, and that loop is not on the
    // sheet, so V_out_dc is stated like the supply — nothing on this sheet is assumed. The two
    // mirrors add no voltage to state: the tail device's gate is the bias reference's own diode
    // drop and the load's output side sits on its diode side's gate, both read off devices that
    // are on the sheet. Nor does the pair's diode-side transistor: its width is its partner's,
    // its current is the rest of what the tail delivers, and its drain is the load's diode node,
    // one load gate-source voltage below the supply. The share of the tail current the
    // output-side pair transistor carries is the second solved value: it is searched until that
    // transistor takes what the mirror's output side returns, the current law at the output. The
    // programmed tail current is stated too: the netlist draws it as a current source feeding the
    // bias reference, and an element's value reads only what the designer states.
    expect(classes('otas/five-transistor-ota.json')).toEqual({
      independent: ['CM_dc', 'CM_hi', 'CM_lo', 'I_tail', 'VDD', 'V_out_dc'],
      assumed: [],
      solved: ['V_tail', 'out_share'],
    });
  });

  it('wide-swing cascode mirror: the mirror drain and the output-branch node are solved, the margin that places them is stated', () => {
    const r = classes('mirrors-bias/wide-swing-cascode-mirror.json');
    expect(r.solved).toEqual(['k_x', 'vds_lo']);
    expect(r.independent).toContain('node_margin');
  });

  it('source follower: the gate drop is solved, the supply, the input level and the bias current are stated', () => {
    // The drain bias is VDD - V_in + vgs_est, and vgs_est is solved to the device's own vgs, so
    // the supply and the input level are the voltages that reach the device. The bias current is
    // stated as well: the netlist draws it as the current source the output drives.
    expect(classes('stages/source-follower.json')).toEqual({
      independent: ['I_bias', 'VDD', 'V_in'],
      assumed: [],
      solved: ['vgs_est'],
    });
  });

  it('CS amp, resistive load: the supply is the only voltage; the drain level is derived', () => {
    // The drain bias is VDD - gm*R_load/gm_id: the supply is the one voltage it reads, and
    // nothing typed stands in for the output level. The load resistor is stated too: the netlist
    // draws it as an element, whose value reads only what the designer states.
    expect(classes('stages/cs-amp-resistive-load.json')).toEqual({
      independent: ['R_load', 'VDD'],
      assumed: [],
      solved: [],
    });
  });

  it('common gate: the supply and the input level are stated; the drain level is derived', () => {
    // The drain bias is VDD - I_bias*R_load - V_in and the body bias is V_in, so those two
    // voltages reach the device and nothing typed stands in for the output level. The load
    // resistor is stated too, as the element the netlist draws from the drain to the supply.
    expect(classes('stages/common-gate.json')).toEqual({
      independent: ['R_load', 'VDD', 'V_in'],
      assumed: [],
      solved: [],
    });
  });
});

// dcInputs and reachedGivens read the same dependency links — equations, solved relations, block
// overrides, child provides — one walked backwards from each device's givens, the other forwards
// from a set of moved names, each under its own policy. This holds them to the same answer on the
// question both can ask: does a top-level param reach any device's sizing?

/** Every `<block path>.<givens key>:<name>` whose expression reads a name that moves with `moved`,
 *  by reachedGivens. */
const forwardHits = (doc: SheetDoc, moved: string): string[] => {
  return reachedGivens(doc, [moved]).flatMap(({ path, givens, reached }) =>
    Object.entries(givens).flatMap(([k, v]) =>
      !GIVENS_FLAGS.has(k) && typeof v === 'string'
        ? compileExpr(v)
            .names.filter((n) => reached.has(n))
            .map((n) => `${path}.${k}:${n}`)
        : [],
    ),
  );
};

/** Forward reach of a top-level param, closed once through the range ends. That closure
 *  is the one deliberate asymmetry between the walks: dcInputs follows a range end back into the
 *  range end's `set` expression, while reachedGivens starts from the param a range end sets and
 *  never reads what the setting is written in — so a param named only in a `set` reaches when the
 *  param that range end sets does. */
const forward = (doc: SheetDoc, p: string): boolean =>
  forwardHits(doc, p).length > 0 ||
  (doc.operatingRange ?? []).some((e) =>
    Object.entries(e.set ?? {}).some(
      ([q, x]) =>
        typeof x === 'string' && compileExpr(x).names.includes(p) && forwardHits(doc, q).length > 0,
    ),
  );

/** Backward reach: the param is one of dcInputs' roots, whatever its class. */
const backward = (doc: SheetDoc, p: string): boolean => {
  const r = dcInputs(doc);
  return [
    ...r.independent,
    ...r.assumed,
    ...r.solved,
    ...r.held,
    ...r.unclassified.map((u) => u.param),
  ].includes(p);
};

const bothWays = (doc: SheetDoc, p: string): [boolean, boolean] => [
  backward(doc, p),
  forward(doc, p),
];

describe('dcInputs and reachedGivens agree on which top-level params reach a device', () => {
  const lib = (file: string) => resolveSheetRefs(sheet(file), REFS).doc;

  it('on every curated sheet and example, for every voltage or classed param', () => {
    const corpus = [
      ...loadLibrary().map(({ file, doc }) => ({
        name: file,
        doc: resolveSheetRefs(doc, REFS).doc,
      })),
      ...EXAMPLES.map((doc) => ({ name: doc.title, doc })),
    ];
    let pairs = 0;
    let reaching = 0;
    const disagreements: string[] = [];
    for (const { name, doc } of corpus) {
      for (const p of doc.params) {
        if (p.unit !== 'V' && p.class === undefined) continue;
        const [b, f] = bothWays(doc, p.name);
        pairs++;
        if (b && f) reaching++;
        if (b !== f) disagreements.push(`${name}: ${p.name} (backward ${b}, forward ${f})`);
      }
    }
    expect(disagreements).toEqual([]);
    // Both answers must occur, so two walks that agreed only by both saying "everything reaches"
    // (or "nothing does") still fail here. Which params reach is pinned case by case below.
    expect(reaching).toBeGreaterThan(0);
    expect(pairs - reaching).toBeGreaterThan(0);
  });

  it('names the case each kind of link has to get right', () => {
    const ota = lib('otas/five-transistor-ota.json');
    // CM_dc reaches the pair and the tail only through the design constraint that solves V_tail
    // from it.
    expect(bothWays(ota, 'CM_dc')).toEqual([true, true]);
    expect(forwardHits(ota, 'CM_dc')).toContain('tail.vds:vds_t');
    // The programmed current enters the bias reference alone, and reaches the tail device as that
    // reference's gate voltage — a mirror's shared gate, followed like any other link.
    expect(forwardHits(ota, 'I_tail')).toContain('bias.id:I_ref');
    expect(forwardHits(ota, 'I_tail')).toContain('tail.vgs:vgs_t');
    // The pair's two transistors hang from different nodes. The diode-side one has its drain on
    // the load's diode node, one load gate-source voltage below the supply, so the supply reaches
    // it there. Its current then decides how the tail current splits, and the split is what the
    // output-side transistor and the load's diode side are each handed — so the supply reaches
    // both of those currents through the solved share and nowhere else.
    expect(forwardHits(ota, 'VDD')).toEqual(
      expect.arrayContaining(['inr.vds:vds_i', 'in.id:I_side', 'ldr.id:I_side']),
    );
    expect(forwardHits(ota, 'out_share')).toEqual(
      expect.arrayContaining(['in.id:I_side', 'ldr.id:I_side']),
    );
    // The diode-side one copies its partner's width, which is hardware this walk holds and so
    // never reports as moved, and carries the rest of the tail current. The inversion level typed
    // for the output-side one sets that one's gate-source voltage, which the common mode reads, so
    // it reaches the tail node and, through it, the current the diode-side one is handed.
    expect(forwardHits(ota, 'gm_id_in')).toEqual(
      expect.arrayContaining(['in.gm_id:gm_id_i', 'tail.vds:vds_t', 'inr.id:I_side']),
    );
    // CM_lo is read by nothing but the cm-lo range end's `set`, so only the range-end closure
    // reaches it.
    expect(forwardHits(ota, 'CM_lo')).toEqual([]);
    expect(bothWays(ota, 'CM_lo')).toEqual([true, true]);
    // The simple mirror's output level is its own drain bias, read directly.
    const mirror = lib('mirrors-bias/simple-mirror.json');
    expect(bothWays(mirror, 'V_out')).toEqual([true, true]);
    expect(forwardHits(mirror, 'V_out')).toEqual(['givens.vds:V_out']);
    // The wide-swing margin places vds_lo (solved for ref's vdsat plus the margin), which is the
    // reference's drain — so it reaches the output device's gate through the reference's gate
    // voltage that device copies.
    const wide = lib('mirrors-bias/wide-swing-cascode-mirror.json');
    expect(bothWays(wide, 'node_margin')).toEqual([true, true]);
    expect(forwardHits(wide, 'node_margin')).toContain('out.vgs:vgs_o');
    // The inverter's input level is not a param at all: it is the NMOS's own gate-source
    // voltage, which the PMOS reads. So the NMOS's inversion level reaches the PMOS's gate, and
    // the output level both drains.
    const cmos = lib('stages/cmos-inverter-amp.json');
    expect(cmos.params.map((p) => p.name)).not.toContain('V_in');
    expect(forwardHits(cmos, 'gm_id_n')).toContain('p.vgs:vgs_d');
    expect(bothWays(cmos, 'V_out')).toEqual([true, true]);
  });

  it('on the composition shapes the library does not carry', () => {
    // Two override hops down to a grandchild's drain.
    expect(bothWays(overrideChain('independent'), 'VDD')).toEqual([true, true]);
    // A top-level voltage handed down two levels and read back up through a re-export; the top
    // device's own `vd` is not in its givens at all.
    expect(bothWays(reExport(true), 'V_top')).toEqual([true, true]);
    expect(bothWays(reExport(true), 'vd')).toEqual([false, false]);
    // A design constraint: the solved node, the spec it is solved from, and the level beside it.
    for (const p of ['CM', 'V_out', 'V_tail'])
      expect(bothWays(constrainedTail(), p)).toEqual([true, true]);
    // A solveFor: the torn drain and the voltage its target reads.
    const torn = tornDrain({ class: 'independent' });
    expect(bothWays(torn, 'V_x')).toEqual([true, true]);
    expect(bothWays(torn, 'V_up')).toEqual([true, true]);
    expect(bothWays(torn, 'vd')).toEqual([false, false]);
    // A range end: the centre directly, the range end only through the range-end closure.
    const ranged = rangeEndDoc({ class: 'independent' });
    expect(bothWays(ranged, 'V_c')).toEqual([true, true]);
    expect(forwardHits(ranged, 'V_lo')).toEqual([]);
    expect(bothWays(ranged, 'V_lo')).toEqual([true, true]);
  });

  it('an override of a constrained child param reaches nothing — a case reachedGivens does not model', () => {
    // The engine ignores the override (it searches the value in its own range), so the
    // parent's V_p reaches no device. Only the backward side is asserted: reachedGivens seeds a
    // child param from any override that reads a moved name, constrained or not, and so reports V_p
    // as reaching k's source — a known over-approximation in an advisory walk.
    expect(backward(overriding(constrainedSource(), 'V_s'), 'V_p')).toBe(false);
  });
});

describe('a range end moves the current a block is given, and every partner reading it', () => {
  // `src` is given its current as a share of a tail current the range end moves; `dst` is given
  // its width, takes `src__id` as its current, and has its source on a node the range end moves.
  // Its current follows src's there, so its width-first givens keep no stale operating-point spec.
  const doc = (): SheetDoc => ({
    title: 'a given current read by a partner',
    polarity: 'n',
    params: [
      { name: 'I_tail', value: 20e-6, unit: 'A', class: 'independent' },
      { name: 'share', value: 0.5, unit: '1', class: 'independent' },
      { name: 'V_s', value: 0.3, unit: 'V', class: 'independent' },
    ],
    equations: [],
    checks: [],
    blocks: [
      {
        name: 'src',
        doc: leaf({}, [{ name: 'I_side', value: 10e-6, unit: 'A' }]),
        params: { I: 'I_tail*share' },
      },
      {
        name: 'dst',
        doc: leaf({ gm_id: undefined, W: 'Wd', vsb: 'vs' }, [
          { name: 'Wd', value: 1e-6, unit: 'm' },
          { name: 'vs', value: 0.3, unit: 'V' },
        ]),
        params: { I: 'src__id', vs: 'V_s' },
      },
    ],
    operatingRange: [{ name: 'hi', set: { I_tail: '2*I_tail', V_s: '0.4' } }],
  });

  it("marks the block's id provide moved, so the partner's current is reached", () => {
    expect(forwardHits(doc(), 'I_tail')).toEqual(['src.id:I', 'dst.id:I']);
    expect(bothWays(doc(), 'I_tail')).toEqual([true, true]);
  });

  it('raises no width-first warning on the partner, whose current follows', () => {
    const rangeWarnings = validateSheet(doc()).filter(
      (w) => w.severity === 'warning' && /^range end "hi"/.test(w.message),
    );
    expect(rangeWarnings).toEqual([]);
  });
});

describe('SheetResult.assumptions', () => {
  it('lists exactly the assumed roots that reach a device, in document order', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [
        { name: 'V_b', value: 0.5, unit: 'V', class: 'assumed' },
        { name: 'VDD', value: 1.2, unit: 'V', class: 'independent' },
        { name: 'V_idle', value: 0.4, unit: 'V', class: 'assumed' }, // reaches nothing
        { name: 'V_a', value: 0.6, unit: 'V', class: 'assumed' },
      ],
      equations: [],
      checks: [],
      blocks: [
        // The parent does not override the child's drain level: the child's own assumption.
        { name: 'k', doc: withVd({ class: 'assumed' }) },
        { name: 'n', doc: leaf(), params: { vd: 'VDD - V_a' } },
        { name: 'm', doc: leaf(), params: { vd: 'V_b' } },
      ],
    };
    expect(runSheet(doc, table).assumptions).toEqual(['V_b', 'V_a', 'k.vd']);
  });

  it('is empty for a sheet that assumes nothing', () => {
    const doc = leaf({ vds: '0.6' });
    expect(runSheet(doc, table).assumptions).toEqual([]);
  });

  it('the CMOS inverter assumes nothing: its output level is stated, and its input level is no DC input', () => {
    // The two drains meet at a high-impedance output held by the feedback that biases the
    // inverter at its trip point, which is not on the sheet, so V_out is stated beside the
    // supply. The input level is the NMOS's own gate-source voltage — an output of its sizing,
    // which the PMOS reads — and not a param, so it is not among the DC inputs at all.
    const doc = sheet('stages/cmos-inverter-amp.json');
    const res = runSheet(doc, table, undefined, REFS);
    expect(res.assumptions).toEqual([]);
    const r = dcInputs(doc);
    expect(r.independent).toEqual(['VDD', 'V_out']);
    expect([...r.independent, ...r.assumed, ...r.solved]).not.toContain('V_in');
  });
});

// exprRoots under the residual reading: which OTHER solved params of its own level a solved
// param's relation reads, the edges a level's solves are ordered and grouped by. Each expectation
// follows the fixture's own expressions by hand.

/** A drain-biased leaf whose source node P is constrained against the equation rq, which reads the
 *  constrained Q; Q's own relation reads R. */
const constraintPair = (): SheetDoc => ({
  ...leaf({ vsb: 'P' }),
  params: [
    ...leaf().params,
    {
      name: 'P',
      value: 0.2,
      min: 0,
      max: 0.8,
      unit: 'V',
      designConstraint: { lhs: 'P + vgs', rhs: 'rq' },
    },
    { name: 'Q', value: 0.5, min: 0, max: 1, unit: 'V', designConstraint: { lhs: 'Q', rhs: 'R' } },
    { name: 'R', value: 0.5, unit: 'V', class: 'independent' },
  ],
  equations: [{ name: 'rq', expr: 'Q + 0.1' }],
});

describe('exprRoots — the residual reading', () => {
  const residual = (name: string) => ({ residual: name });

  it('depends on another solved param it reads, directly or through an equation, and stops there', () => {
    // P + vgs - Q names Q itself; P + vgs - rq reaches it through rq = Q + 0.1. Q is solved on the
    // same level, so the walk records it and does not cross its relation: R, on Q's far side, is
    // never reached.
    for (const expr of ['P + vgs - Q', 'P + vgs - rq']) {
      const r = exprRoots(constraintPair(), '', expr, residual('P'));
      expect(r.constraints).toEqual(['Q']);
      expect(r.roots.independent).not.toContain('R');
    }
  });

  it("reads its own level as it is solved: a parent's override there is a number, not an edge", () => {
    // m's drain level vd is overridden by the parent as V_out - V_tail, and V_tail is the
    // parent's constrained node — but m is solved inside every probe of V_tail, with vd already a
    // number, so vd is a root of m's level and V_tail is no edge of it.
    const r = exprRoots(constrainedTail(), 'm', 'vd', residual('vs'));
    expect(r.constraints).toEqual([]);
    expect(r.roots.unclassified).toEqual(['m.vd']);
  });

  it("crosses a child's solved param, provided or read through its device: the child solves it", () => {
    // k publishes its constrained source node V_s, and foo — none of k's params or equations, so a
    // column of the table read at k's operating point, which rests on the whole of k's givens,
    // whose vsb is V_s. k solves V_s inside every evaluation of this level, so the walk crosses
    // its relation instead of stopping: it is no unknown beside V_p.
    const doc = overriding({ ...constrainedSource(), provides: ['foo', 'V_s'] }, 'vd');
    const param = exprRoots(doc, '', 'k__V_s', residual('V_p'));
    expect(param.constraints).toEqual([]);
    expect(param.crossings.solved).toEqual(['k.V_s']);
    const column = exprRoots(doc, '', 'k__foo', residual('V_p'));
    expect(column.constraints).toEqual([]);
    expect(column.crossings.solved).toEqual(['k.V_s']);
    expect(column.unresolved).toEqual([]);
  });

  it('stops at a solveFor param of its own level exactly as at a constrained one', () => {
    // P + V_x: V_x solves for tgt = V_up - 0.1, and V_up is constrained. Both are solved params of
    // P's level, so the walk stops at the one P reads, V_x, and never reaches V_up behind it.
    const doc = tornDrain({ min: 0, max: 1, designConstraint: { lhs: 'V_up', rhs: '0.7' } });
    doc.params.push({
      name: 'P',
      value: 0.5,
      min: 0,
      max: 1,
      unit: 'V',
      designConstraint: { lhs: 'P + V_x', rhs: '1' },
    });
    const r = exprRoots(doc, '', 'P + V_x', residual('P'));
    expect(r.constraints).toEqual(['V_x']);
    expect(r.crossings.solved).toEqual([]);
    expect(solvePlan(doc)).toEqual([['V_up'], ['V_x'], ['P']]);
  });

  it('follows a quantity the givens name through that expression alone: a branch current is not its tail node', () => {
    // m is given id as its param I, which the parent sets to I_tail/2; neither reads the
    // constrained V_tail, although m's drain (V_out - V_tail) and source (V_tail) biases do. m's
    // vgs is not given, so it rests on all of the givens, V_tail included.
    const doc = constrainedTail();
    doc.params.push(
      { name: 'I_tail', value: 20e-6, unit: 'A', class: 'independent' },
      { name: 'V_f', value: 0.9, unit: 'V', class: 'independent' },
    );
    doc.blocks![0].params!.I = 'I_tail/2';
    const viaId = exprRoots(doc, '', 'V_f - m__id', residual('V_f'));
    expect(viaId.constraints).toEqual([]);
    expect(viaId.roots.independent).toEqual(['I_tail']);
    expect(exprRoots(doc, '', 'V_f - m__vgs', residual('V_f')).constraints).toEqual(['V_tail']);
  });

  it("reads a sized level's `w` as its device's, and a given's `w` as the table's", () => {
    // k's equation wu = w*1e6 is evaluated after k is sized, so its w is k's width, sized from the
    // current I, which the parent sets from the constrained Q.
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [
        {
          name: 'Q',
          value: 1,
          min: 0.5,
          max: 2,
          unit: 'V',
          designConstraint: { lhs: 'Q', rhs: '1' },
        },
        { name: 'P', value: 1, unit: 'V' },
      ],
      equations: [],
      checks: [],
      blocks: [
        {
          name: 'k',
          doc: {
            ...withVd({ class: 'independent' }),
            equations: [{ name: 'wu', expr: 'w*1e6' }],
            provides: ['wu'],
          },
          params: { I: 'Q*1e-5' },
        },
      ],
    };
    expect(exprRoots(doc, '', 'P - k__wu', residual('P')).constraints).toEqual(['Q']);
    // Here the top device is sized from the constrained Q. The override setting k's vd from w is
    // evaluated before the top sizing, so it reads the table's width; the equation wu, after it,
    // reads the device's — whichever of the two the walk meets first.
    const top: SheetDoc = {
      ...leaf({ id: 'Q*1e-5' }, [
        {
          name: 'Q',
          value: 1,
          min: 0.5,
          max: 2,
          unit: 'V',
          designConstraint: { lhs: 'Q', rhs: '1' },
        },
        { name: 'P', value: 1, unit: 'V' },
      ]),
      equations: [{ name: 'wu', expr: 'w*1e6' }],
      blocks: [{ name: 'k', doc: { ...leaf(), provides: ['vd'] }, params: { vd: 'w*1e5' } }],
    };
    expect(exprRoots(top, '', 'P + k__vd', residual('P')).constraints).toEqual([]);
    for (const expr of ['P + wu', 'P + k__vd + wu', 'P + wu + k__vd'])
      expect(exprRoots(top, '', expr, residual('P')).constraints).toEqual(['Q']);
    // A given is evaluated before its device is sized: W = 4*w reads the table's width, so neither
    // the device's vgs nor an equation reading the sized w comes back to the device itself.
    const unit: SheetDoc = {
      ...withVd({ class: 'independent' }),
      givens: { L: 'L', W: '4*w', gm_id: '10', vds: 'vd' },
      equations: [{ name: 'wu', expr: 'w*1e6' }],
    };
    for (const expr of ['vgs + wu', 'wu + vgs'])
      expect(exprRoots(unit, '', expr, residual('vd')).cycles).toEqual([]);
  });

  it("ignores what one evaluation ignores: an override of a solved child param, a range end's set", () => {
    // The engine searches V_s and V_x each in its own range whatever the parent wires, so the
    // parent's assumed V_p decides neither. The lo range end's V_lo replaces V_c
    // only in a run of its own, evaluated against the finished base run; the provenance reading
    // counts it as an input like the centre it replaces.
    for (const [child, key] of [
      [constrainedSource(), 'V_s'],
      [tornDrain({}), 'V_x'],
    ] as const) {
      const doc = overriding({ ...child, provides: [key] }, key);
      expect(exprRoots(doc, '', `k__${key}`, residual('P')).roots.assumed).toEqual([]);
    }
    expect(exprRoots(rangeEndDoc({}), '', 'V_c', residual('vd')).roots.unclassified).toEqual([]);
    expect(exprRoots(rangeEndDoc({}), '', 'V_c', 'provenance').roots.unclassified).toEqual([
      'V_lo',
    ]);
  });

  it('flags a read of its own param without making it an ordering edge', () => {
    // constrainedSource constrains V_s with V_s + vgs, and its bias vsb is V_s: the residual reads
    // V_s directly, and vgs alone reads it through the device.
    const r = exprRoots(constrainedSource(), '', 'V_s + vgs', residual('V_s'));
    expect(r.selfRead).toBe(true);
    expect(r.constraints).toEqual([]);
    expect(exprRoots(constrainedSource(), '', 'vgs', residual('V_s')).selfRead).toBe(true);
    // Here the device sits on Y: Y + vgs never reads X, and X + vgs does — still so when the
    // parent overrides X, because the read is of the level's own X, taken before its override.
    const onY = leaf({ vsb: 'Y' }, [
      { name: 'X', value: 0.5, unit: 'V' },
      { name: 'Y', value: 0.2, unit: 'V' },
    ]);
    expect(exprRoots(onY, '', 'Y + vgs', residual('X')).selfRead).toBe(false);
    expect(exprRoots(onY, '', 'X + vgs', residual('X')).selfRead).toBe(true);
    expect(exprRoots(overriding(onY, 'X'), 'k', 'X + vgs', residual('X')).selfRead).toBe(true);
  });

  it('reports a name that resolves to nothing, apart from a constant, and fails closed on it', () => {
    // k constrains its source node V_s and provides vgs and id, not vth; nope names nothing; pi is
    // a constant, not a name. A name that resolves to nothing could stand for anything, so the
    // relation depends on every other solved param of its own level: here the parent's W_p.
    // k's V_s is no such param — k solves it inside every probe of this level.
    const doc = overriding(constrainedSource(), 'vd');
    doc.params.push({
      name: 'W_p',
      value: 1,
      min: 0,
      max: 2,
      designConstraint: { lhs: 'W_p', rhs: '1' },
    });
    const r = exprRoots(doc, '', 'V_p + k__vth + nope + pi', residual('V_p'));
    expect(r.unresolved).toEqual(['k__vth', 'nope']);
    expect(r.constraints).toEqual(['W_p']);
    expect(exprRoots(doc, '', 'V_p + pi', residual('V_p')).constraints).toEqual([]);
    // Read from inside k against its own constrained V_s, the only solved param of that level is
    // the relation's own, so there is no other for the unresolved name to stand for.
    expect(exprRoots(doc, 'k', 'V_s + vgs + nope', residual('V_s')).constraints).toEqual([]);
  });

  it('reports a cycle and terminates', () => {
    // a = b and b = a: the walk comes back to a through b, with no solve on the way.
    const doc: SheetDoc = {
      ...leaf({ vds: '0.6' }),
      equations: [
        { name: 'a', expr: 'b' },
        { name: 'b', expr: 'a' },
      ],
    };
    for (const policy of ['provenance', residual('vd')] as const)
      expect(exprRoots(doc, '', 'a', policy).cycles).toEqual([
        { via: ['a', 'b', 'a'], closed: false },
      ]);
  });
});

describe('exprRoots — the provenance reading', () => {
  it('returns a param no givens read by its class, unclassified when it has none', () => {
    // V_spare feeds only a check, so it is no DC input — but an expression that reads it rests on
    // it.
    const spare = (cls?: 'independent'): SheetDoc => ({
      ...leaf({ vds: '0.6' }),
      params: [
        ...leaf().params,
        { name: 'V_spare', value: 1, unit: 'V', ...(cls ? { class: cls } : {}) },
      ],
      checks: [{ id: 'r', kind: 'advisory', lhs: 'vd', op: '<=', rhs: 'V_spare' }],
    });
    expect(dcInputs(spare()).unclassified).toEqual([]);
    expect(exprRoots(spare(), '', 'V_spare', 'provenance').roots.unclassified).toEqual(['V_spare']);
    expect(exprRoots(spare('independent'), '', 'V_spare', 'provenance').roots.independent).toEqual([
      'V_spare',
    ]);
  });

  it("crosses a child's device only when it reads a device quantity", () => {
    // k publishes its stated drain level vd and its vgs. k__vd ends at vd; k__vgs comes out of k's
    // sizing, which reads L, I and vd — the same independent root, reached through the device.
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        { name: 'k', doc: { ...withVd({ class: 'independent' }), provides: ['vd', 'vgs'] } },
      ],
    };
    const param = exprRoots(doc, '', 'k__vd', 'provenance');
    const device = exprRoots(doc, '', 'k__vgs', 'provenance');
    expect(param.roots.independent).toEqual(['k.vd']);
    expect(device.roots.independent).toEqual(['k.vd']);
    expect(param.crossings.device).toEqual([]);
    expect(device.crossings.device).toEqual(['k']);
  });
});
