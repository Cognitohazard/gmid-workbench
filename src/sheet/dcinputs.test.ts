// The DC-input rule (`sheet-dc-inputs`) and the assumption list a result carries. Each case is a
// small purpose-built document whose DC inputs can be read off by eye: which params a device's
// bias is built from, and what class each one was given. The expectations are those readings,
// not anything the engine computed.

import { describe, it, expect } from 'vitest';
import { compileExpr } from '../derive';
import { dcInputs, EXAMPLES, runSheet, validateSheet } from './index';
import { reachedBinds, type ReachedBind } from './validate';
import { BIND_FLAGS, type SheetBind, type SheetDoc, type SheetVar } from './types';
import { loadLibrary, REFS, sheet, table } from './library.fixtures';
import { resolveSheetRefs } from './resolve';

/** A leaf that sizes one device with its drain bias taken from the param `vd`. */
const leaf = (bind: Partial<SheetBind> = {}, params: SheetVar[] = []): SheetDoc => ({
  title: 'leaf',
  polarity: 'n',
  params: [
    { name: 'L', value: 0.5e-6, unit: 'm' },
    { name: 'I', value: 10e-6, unit: 'A' },
    { name: 'vd', value: 0.6, unit: 'V' },
    ...params,
  ],
  bind: { L: 'L', id: 'I', gm_id: '10', vds: 'vd', ...bind },
  rows: [],
  rules: [],
  provide: ['vgs', 'id'],
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
  rows: [],
  rules: [],
  uses: [
    {
      name: 'mid',
      doc: {
        title: 'mid',
        polarity: 'n',
        params: [{ name: 'V_m', value: 1, unit: 'V' }],
        rows: [],
        rules: [],
        uses: [{ name: 'leaf', doc: leaf(), params: { vd: 'V_m - 0.2' } }],
      },
      params: { V_m: 'VDD' },
    },
  ],
});

/** The top device's drain reads `c__g__lvl`: c re-exports its child g's row `lvl`, which is g's
 *  own voltage V_g — or, when `fed`, the top-level V_top handed down through c's param V_c. */
const reExport = (fed = false): SheetDoc => {
  const g: SheetDoc = {
    title: 'g',
    polarity: 'n',
    params: [{ name: 'V_g', value: 0.5, unit: 'V' }],
    rows: [{ name: 'lvl', expr: 'V_g + 0.1' }],
    rules: [],
    provide: ['lvl'],
  };
  const c: SheetDoc = {
    title: 'c',
    polarity: 'n',
    params: fed ? [{ name: 'V_c', value: 0.5, unit: 'V' }] : [],
    rows: [],
    rules: [],
    uses: [{ name: 'g', doc: g, ...(fed ? { params: { V_g: 'V_c' } } : {}) }],
    provide: ['g__lvl'],
  };
  const top = leaf({ vds: 'c__g__lvl' }, fed ? [{ name: 'V_top', value: 0.4, unit: 'V' }] : []);
  return { ...top, uses: [{ name: 'c', doc: c, ...(fed ? { params: { V_c: 'V_top' } } : {}) }] };
};

/** A drain biased from V_c, with a containment edge substituting the range end V_lo for it. */
const edgeRange = (lo: Partial<SheetVar>): SheetDoc => ({
  ...leaf({ vds: 'V_c' }),
  params: [
    ...leaf().params,
    { name: 'V_c', value: 0.6, unit: 'V', class: 'independent' },
    { name: 'V_lo', value: 0.3, unit: 'V', ...lo },
  ],
  edges: [{ name: 'lo', set: { V_c: 'V_lo' } }],
});

/** A pair device standing on a tail node that the engine pins so the common mode lands on CM. */
const pinnedTail = (tail: Partial<SheetVar> = {}): SheetDoc => ({
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
      pin: { lhs: 'V_tail + m__vgs', rhs: 'CM' },
      ...tail,
    },
  ],
  rows: [],
  rules: [],
  uses: [
    {
      name: 'm',
      doc: leaf({ vsb: 'vs' }, [{ name: 'vs', value: 0, unit: 'V' }]),
      params: { vd: 'V_out - V_tail', vs: 'V_tail' },
    },
  ],
});

/** A leaf whose source node V_s the engine pins so that V_s + vgs lands on CM_k; its drain
 *  level is stated. */
const pinnedSource = (): SheetDoc => {
  const d = leaf({ vsb: 'V_s' }, [
    {
      name: 'V_s',
      value: 0.2,
      min: 0,
      max: 0.8,
      unit: 'V',
      pin: { lhs: 'V_s + vgs', rhs: 'CM_k' },
    },
    { name: 'CM_k', value: 0.9, unit: 'V' },
  ]);
  d.params = d.params.map((p) => (p.name === 'vd' ? { ...p, class: 'independent' } : p));
  return d;
};

/** A drain V_x torn against the row `tgt`, which reads V_up: V_x is solved, V_up decides it. */
const tornDrain = (up: Partial<SheetVar>): SheetDoc => ({
  ...leaf({ vds: 'V_x' }),
  params: [
    ...leaf().params,
    { name: 'V_x', value: 0.5, unit: 'V', solveFor: 'tgt' },
    { name: 'V_up', value: 0.7, unit: 'V', ...up },
  ],
  rows: [{ name: 'tgt', expr: 'V_up - 0.1' }],
});

/** A parent embedding `child` as `k` and overriding `name` with the assumed parent voltage `V_p`. */
const overriding = (child: SheetDoc, name: string): SheetDoc => ({
  title: 'p',
  polarity: 'n',
  params: [{ name: 'V_p', value: 0.3, unit: 'V', class: 'assumed' }],
  rows: [],
  rules: [],
  uses: [{ name: 'k', doc: child, params: { [name]: 'V_p' } }],
});

const dcFindings = (doc: SheetDoc) =>
  validateSheet(doc).filter((w) => w.rule === 'sheet-dc-inputs' && w.severity === 'error');

describe('sheet-dc-inputs — every voltage a device is biased from carries a class', () => {
  it('an unclassified voltage root is an error naming the param and the device it sizes', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'V_node', value: 0.9, unit: 'V' }],
      rows: [],
      rules: [],
      uses: [{ name: 'm', doc: leaf(), params: { vd: 'V_node - 0.1' } }],
    };
    const errs = dcFindings(doc);
    expect(errs).toHaveLength(1);
    expect(errs[0].symbol).toBe('V_node');
    expect(errs[0].message).toMatch(/"V_node"/);
    expect(errs[0].message).toMatch(/"m"/);
  });

  it("names the sheet's own device when the root feeds the top-level bind", () => {
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
      rows: [],
      rules: [],
      uses: [
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
      // One unused, one read only by a rule: neither is part of any device's bias.
      params: [...leaf().params, { name: 'V_spare', value: 1, unit: 'V' }],
      rules: [{ id: 'r', kind: 'guardrail', lhs: 'vd', op: '<=', rhs: 'V_spare' }],
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
      rows: [],
      rules: [],
      uses: [{ name: 'k', doc: leaf() }],
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
      rows: [],
      rules: [],
      uses: [{ name: 'k', doc: child, params: { I: '2e-5' } }],
    };
    expect(dcFindings(child).map((w) => w.symbol)).toEqual(['constructor']);
    expect(dcFindings(doc).map((w) => w.symbol)).toEqual(['k.constructor']);
  });
});

describe('sheet-dc-inputs — what the walk follows, and what it does not', () => {
  it('a range end a containment edge substitutes is a DC input like the centre it replaces', () => {
    expect(dcFindings(edgeRange({})).map((w) => w.symbol)).toEqual(['V_lo']);
    expect(dcInputs(edgeRange({ class: 'independent' })).independent).toEqual(['V_c', 'V_lo']);
    // An assumed range end is reported with the result, exactly as an assumed centre would be.
    expect(runSheet(edgeRange({ class: 'assumed' }), table).assumptions).toEqual(['V_lo']);
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
      uses: [{ name: 'c', ref: 'somewhere/else' }],
    };
    const unprovided: SheetDoc = {
      ...leaf({ vds: 'vd - c__vth' }),
      uses: [{ name: 'c', doc: leaf() }],
    };
    const typo: SheetDoc = leaf({ vds: 'vd - vdd_typo' });
    for (const doc of [refOnly, unprovided, typo]) {
      const cycles = dcInputs(doc).cycles;
      expect(cycles).toEqual([]);
    }
  });

  it('before the bind runs `w` is the table width, not the device: a bind in unit widths is no loop', () => {
    // A bind is evaluated before its device is sized, when `w` is still the table's
    // characterization width, so `W: 4*w` reads the table, not this device's own operating point.
    // The sheet validates clean and sizes to exactly four table widths.
    const doc: SheetDoc = {
      ...withVd({ class: 'independent' }),
      bind: { L: 'L', W: '4*w', gm_id: '10', vds: 'vd' },
    };
    expect(validateSheet(doc).filter((w) => w.severity === 'error')).toEqual([]);
    const res = runSheet(doc, table);
    expect(res.bind?.ok, res.bind?.error).toBe(true);
    expect(res.feasible).toBe(true);
    expect(res.bind!.W / table.meta.W!).toBeCloseTo(4, 12);
  });

  it("a binding child's provided pass-through column is that child's device", () => {
    // `foo` is none of c's params or rows, so c can only publish it from its sizing — the table
    // read at c's operating point. c's drain is the top device's own vgs, and the top device's
    // drain is c__foo: each device's sizing rests on the other's, with nothing solving the loop,
    // so both are reported.
    const doc: SheetDoc = {
      ...leaf({ vds: 'c__foo' }),
      uses: [{ name: 'c', doc: { ...leaf(), provide: ['foo'] }, params: { vd: 'vgs' } }],
    };
    expect(dcInputs(doc).cycles.map((c) => c.device)).toEqual(['bind', 'c']);
  });

  it("a binding child's provided row or param is followed into the child, not read as its device", () => {
    // c sizes its own device from L, I and its stated vd; V_r is none of those. The top device's
    // drain reads V_r through c — by a row `lvl = V_r + 0.1`, or by the param itself — so V_r is a
    // DC input of the top device alone, and it carries no class. Reading either key as c's device
    // would follow c's bind instead, which never reaches V_r.
    const viaChild = (key: string, rows: SheetDoc['rows']): SheetDoc => {
      const c = withVd({ class: 'independent' });
      c.params.push({ name: 'V_r', value: 0.5, unit: 'V' });
      return {
        ...leaf({ vds: `c__${key}` }),
        uses: [{ name: 'c', doc: { ...c, rows, provide: [key] } }],
      };
    };
    const expected = [{ param: 'c.V_r', devices: ['bind'] }];
    const row = viaChild('lvl', [{ name: 'lvl', expr: 'V_r + 0.1' }]);
    expect(dcInputs(row).unclassified).toEqual(expected);
    expect(dcInputs(viaChild('V_r', [])).unclassified).toEqual(expected);
  });
});

describe('sheet-dc-inputs — solved is derived, never authored', () => {
  it('a pin target is solved, and the spec on the far side of the pin is a DC input too', () => {
    expect(dcFindings(pinnedTail())).toEqual([]);
    const r = dcInputs(pinnedTail());
    expect(r.solved).toEqual(['V_tail']);
    expect(r.independent).toEqual(['CM']);
    expect(r.assumed).toEqual(['V_out']);
  });

  it('the far side of a pin is held to the same rule', () => {
    const doc = pinnedTail();
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
    const both = pinnedTail({ class: 'assumed' });
    expect(dcFindings(both).map((w) => w.location)).toEqual(['V_tail']);
  });

  it('a parent override of a pinned child param is no input: the pin and its far side are', () => {
    // The engine chooses k's source node V_s from the pin's own bracket and ignores the
    // override, so V_p decides nothing. V_s is solved, and CM_k — the voltage the pin aims the
    // source at — is the real input, unclassified here.
    const r = dcInputs(overriding(pinnedSource(), 'V_s'));
    expect(r.solved).toEqual(['k.V_s']);
    expect(r.assumed).toEqual([]);
    expect(r.unclassified.map((u) => u.param)).toEqual(['k.CM_k']);
  });

  it('a parent override of a torn child param only seeds it: the target behind it is the input', () => {
    // A solveFor override is the iteration's starting point; the converged value wins. So V_p
    // is no input, V_x is solved, and V_up — which the target row reads — must be classified.
    const r = dcInputs(overriding(tornDrain({}), 'V_x'));
    expect(r.solved).toEqual(['k.V_x']);
    expect(r.assumed).toEqual([]);
    expect(r.unclassified.map((u) => u.param)).toEqual(['k.V_up']);
  });
});

describe('sheet-dc-inputs — a device may not depend on its own operating point unsolved', () => {
  // The top device's drain bias is read through a child's published row, and that child is fed
  // back the top device's own gate voltage — a loop through a child's provide.
  const loop = (viaEstimate: boolean): SheetDoc => ({
    title: 't',
    polarity: 'n',
    params: [
      { name: 'L', value: 0.5e-6, unit: 'm' },
      { name: 'I', value: 10e-6, unit: 'A' },
      ...(viaEstimate ? [{ name: 'vgs_est', value: 0.6, unit: 'V', solveFor: 'vgs' }] : []),
    ],
    bind: { L: 'L', id: 'I', gm_id: '10', vds: 'c__x' },
    rows: [],
    rules: [],
    uses: [
      {
        name: 'c',
        doc: {
          title: 'c',
          polarity: 'n',
          params: [{ name: 'p', value: 0.6 }],
          rows: [{ name: 'x', expr: '1.5*p' }],
          rules: [],
          provide: ['x'],
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

  it('5T OTA: the tail node is solved; the supply, the common mode, its range ends and the output level are stated', () => {
    // The pin moves V_tail until the produced common mode equals CM_dc; the containment edges
    // substitute CM_lo and CM_hi for CM_dc. The output is a high-impedance node that only the
    // feedback the application closes around the amplifier holds, and that loop is not on the
    // sheet, so V_out_dc is stated like the supply — nothing on this sheet is assumed.
    expect(classes('otas/five-transistor-ota.json')).toEqual({
      independent: ['CM_dc', 'CM_hi', 'CM_lo', 'VDD', 'V_out_dc'],
      assumed: [],
      solved: ['V_tail'],
    });
  });

  it('wide-swing cascode mirror: the mirror drain is solved, the margin that places it is stated', () => {
    const r = classes('mirrors-bias/wide-swing-cascode-mirror.json');
    expect(r.solved).toEqual(['vds_lo']);
    expect(r.independent).toContain('node_margin');
  });

  it('source follower: the estimated gate drop is an assumption, the input level is stated', () => {
    const r = classes('stages/source-follower.json');
    expect(r.assumed).toEqual(['vgs_est']);
    expect(r.independent).toContain('V_in');
  });
});

// dcInputs and reachedBinds encode the same dependency links — rows, solved relations, use
// overrides, child provides — one walked backwards from each bind, the other forwards from a set
// of moved names. Until they share one definition of those links, this holds them to the same
// answer on the question both can ask: does a top-level param reach any device's sizing?

/** Every `<bind path>.<bind key>:<name>` whose expression reads a name that moves with `moved`,
 *  by reachedBinds. */
const forwardHits = (doc: SheetDoc, moved: string): string[] => {
  const binds: ReachedBind[] = [];
  reachedBinds(doc, [moved], '', binds, 0);
  return binds.flatMap(({ path, bind, reached }) =>
    Object.entries(bind).flatMap(([k, v]) =>
      !BIND_FLAGS.has(k) && typeof v === 'string'
        ? compileExpr(v)
            .names.filter((n) => reached.has(n))
            .map((n) => `${path}.${k}:${n}`)
        : [],
    ),
  );
};

/** Forward reach of a top-level param, closed once through the containment edges. That closure
 *  is the one deliberate asymmetry between the walks: dcInputs follows a range end back into the
 *  edge's `set` expression, while reachedBinds starts from the param an edge sets and never reads
 *  what the setting is written in — so a param named only in a `set` reaches when the param that
 *  edge sets does. */
const forward = (doc: SheetDoc, p: string): boolean =>
  forwardHits(doc, p).length > 0 ||
  (doc.edges ?? []).some((e) =>
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
    ...r.unclassified.map((u) => u.param),
  ].includes(p);
};

const bothWays = (doc: SheetDoc, p: string): [boolean, boolean] => [
  backward(doc, p),
  forward(doc, p),
];

describe('dcInputs and reachedBinds agree on which top-level params reach a device', () => {
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
    // CM_dc reaches the pair and the tail only through the pin that solves V_tail from it.
    expect(bothWays(ota, 'CM_dc')).toEqual([true, true]);
    expect(forwardHits(ota, 'CM_dc')).toContain('tail.vds:vds_t');
    // CM_lo is read by nothing but the cm-lo edge's `set`, so only the edge closure reaches it.
    expect(forwardHits(ota, 'CM_lo')).toEqual([]);
    expect(bothWays(ota, 'CM_lo')).toEqual([true, true]);
    // The simple mirror's output level is its own drain bias, read directly.
    const mirror = lib('mirrors-bias/simple-mirror.json');
    expect(bothWays(mirror, 'V_out')).toEqual([true, true]);
    expect(forwardHits(mirror, 'V_out')).toEqual(['bind.vds:V_out']);
    // The wide-swing margin places vds_lo (solved for ref's vdsat plus the margin), which is the
    // reference's drain — so it reaches the output device's gate through the sibling's ref__vgs.
    const wide = lib('mirrors-bias/wide-swing-cascode-mirror.json');
    expect(bothWays(wide, 'node_margin')).toEqual([true, true]);
    expect(forwardHits(wide, 'node_margin')).toContain('bind.vgs:ref__vgs');
    // The inverter's input level enters neither device's bias.
    expect(bothWays(lib('stages/cmos-inverter-amp.json'), 'V_in')).toEqual([false, false]);
  });

  it('on the composition shapes the library does not carry', () => {
    // Two override hops down to a grandchild's drain.
    expect(bothWays(overrideChain('independent'), 'VDD')).toEqual([true, true]);
    // A top-level voltage handed down two levels and read back up through a re-export; the top
    // device's own `vd` is not in its bind at all.
    expect(bothWays(reExport(true), 'V_top')).toEqual([true, true]);
    expect(bothWays(reExport(true), 'vd')).toEqual([false, false]);
    // A pin: the solved node, the spec it is solved from, and the level beside it.
    for (const p of ['CM', 'V_out', 'V_tail'])
      expect(bothWays(pinnedTail(), p)).toEqual([true, true]);
    // A solveFor: the torn drain and the voltage its target reads.
    const torn = tornDrain({ class: 'independent' });
    expect(bothWays(torn, 'V_x')).toEqual([true, true]);
    expect(bothWays(torn, 'V_up')).toEqual([true, true]);
    expect(bothWays(torn, 'vd')).toEqual([false, false]);
    // An edge: the centre directly, the range end only through the edge closure.
    const edged = edgeRange({ class: 'independent' });
    expect(bothWays(edged, 'V_c')).toEqual([true, true]);
    expect(forwardHits(edged, 'V_lo')).toEqual([]);
    expect(bothWays(edged, 'V_lo')).toEqual([true, true]);
  });

  it('an override of a pinned child param reaches nothing — a case reachedBinds does not model', () => {
    // The engine ignores the override (the pin picks the value from its own bracket), so the
    // parent's V_p reaches no device. Only the backward side is asserted: reachedBinds seeds a
    // child param from any override that reads a moved name, pinned or not, and so reports V_p
    // as reaching k's source — a known over-approximation in an advisory walk.
    expect(backward(overriding(pinnedSource(), 'V_s'), 'V_p')).toBe(false);
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
      rows: [],
      rules: [],
      uses: [
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
    // supply. The input level never enters either device's bias — gate levels are outputs of
    // gm/ID sizing — so it is not among the DC inputs at all.
    const doc = sheet('stages/cmos-inverter-amp.json');
    const res = runSheet(doc, table, undefined, REFS);
    expect(res.assumptions).toEqual([]);
    const r = dcInputs(doc);
    expect(r.independent).toEqual(['VDD', 'V_out']);
    expect([...r.independent, ...r.assumed, ...r.solved]).not.toContain('V_in');
  });
});
