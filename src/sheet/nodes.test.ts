// The netlist and its DC wiring check. The walk is driven first with relations written by hand,
// whose residuals, levels and verdicts are worked out on paper beside each test; then through
// documents, where the expected numbers are relations between quantities the sizing reports
// (a residual is V_in less the device's own vgs, say), never values pasted from a run.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import {
  NO_ANSWER_NOTE,
  REF,
  RELATION_KINDS,
  dcWalk,
  dofOf,
  formatProblems,
  nodesProblems,
  relation,
  sheetFormat,
  solvedWiring,
  structuralDiodes,
  unwiredDevices,
  wiringRefusal,
  type WalkRelation,
} from './nodes';
import { holdHardware } from './coverage';
import {
  configEligibility,
  dcInputs,
  exprProvenance,
  levelEligibility,
  runSheet,
  validateSheet,
  evaluateSheet,
} from './index';
import type {
  DeviceNodes,
  SheetBlock,
  SheetDoc,
  SheetGivens,
  SheetResult,
  SheetVar,
} from './types';

// ---------------------------------------------------------------------------------------------
// The walk on relations written by hand
// ---------------------------------------------------------------------------------------------

const sym = (o: Record<string, number> = {}): Map<string, number> => new Map(Object.entries(o));
/** V(from) - V(to) = value, an element-kind relation named `name`. */
const tie = (from: string, to: string, value: number, name: string, s = {}): WalkRelation =>
  relation(from, to, value, sym(s), {
    kind: RELATION_KINDS.element,
    inst: '',
    tie: name,
    label: name,
  });
/** A held wire: V(w) - V(ref) = level. */
const held = (w: string, level: number, s = {}): WalkRelation =>
  relation(w, REF, level, sym(s), {
    kind: RELATION_KINDS.anchor,
    inst: '',
    tie: w,
    label: `levels.${w}`,
  });
const seeds = (o: Record<string, number>): Map<string, number> => new Map(Object.entries(o));

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

/** What a walk decided, reduced to what an order change must not move. */
const verdict = (rels: WalkRelation[], s: Map<string, number>) => {
  const w = dcWalk(rels, s);
  return {
    blocks: w.blocks.map((b) => ({
      relations: b.relations.map((r) => r.label),
      chords: b.chords.map((c) => [c.rel.label, Number(c.residual.toFixed(12))]),
      consistent: b.consistent,
    })),
    levels: [...w.levels].map(([k, v]) => [k, Number(v.level.toFixed(12)), v.via]),
    tainted: w.tainted,
    floating: w.floating,
  };
};

describe('the DC walk: blocks, a canonical basis, reported levels', () => {
  it('reads three held wires claiming one wire at 0, 1 and 2 as one block that does not close, in every order', () => {
    // p, q, r held at 0, 1, 2; x tied to each by V(x) - V(.) = 0. Sorted keys: (ref,p) (ref,q)
    // (ref,r) (p,x) (q,x) (r,x). The tree grows from p, the first seed: ref at 0 through (ref,p),
    // x at 0 through (p,x), then q at 1 and r at 2 through their levels. The chords are (q,x) and
    // (r,x), with residuals phi(q) - phi(x) - 0 = 1 and phi(r) - phi(x) - 0 = 2.
    const rels = [
      held('p', 0),
      held('q', 1),
      held('r', 2),
      tie('x', 'p', 0, 'xp'),
      tie('x', 'q', 0, 'xq'),
      tie('x', 'r', 0, 'xr'),
    ];
    const first = verdict(rels, seeds({ p: 0, q: 1, r: 2 }));
    expect(first.blocks).toHaveLength(1);
    expect(first.blocks[0].consistent).toBe(false);
    expect(first.blocks[0].chords).toEqual([
      ['xq', 1],
      ['xr', 2],
    ]);
    // x sits only inside the block that does not close: it is given no value.
    expect(first.tainted).toEqual(['x']);
    for (const order of permutations(rels))
      expect(verdict(order, seeds({ r: 2, q: 1, p: 0 }))).toEqual(first);
  });

  it('keeps held wires at their authored levels and trusts a wire beyond them through a bridge (a, b, c)', () => {
    // Held a = 1, b = 0; a - b = 0.5; c - a = 0.25. Blocks: {ref, a, b} and the bridge {a, c}. From
    // a: ref at -1 (V(a) - V(ref) = 1), b at -0.5 through a - b = 0.5; the chord (ref, b) reads
    // phi(ref) - phi(b) - 0 = -1 + 0.5 = -0.5, so the closure error is 0.5 V. The bridge has no
    // chord, closes, and puts c at 1 + 0.25.
    const rels = [held('a', 1), held('b', 0), tie('a', 'b', 0.5, 'ab'), tie('c', 'a', 0.25, 'ca')];
    const w = dcWalk(rels, seeds({ a: 1, b: 0 }));
    const big = w.blocks.find((b) => b.wires.includes('b'))!;
    expect(big.closureError).toBeCloseTo(0.5, 12);
    expect(big.consistent).toBe(false);
    const bridge = w.blocks.find((b) => b.wires.includes('c'))!;
    expect(bridge.chords).toHaveLength(0);
    expect(bridge.closureError).toBe(0);
    expect(w.levels.get('a')).toEqual({ level: 1, seed: true, via: [] });
    expect(w.levels.get('b')).toEqual({ level: 0, seed: true, via: [] });
    expect(w.levels.get('c')?.level).toBeCloseTo(1.25, 12);
    expect(w.levels.get('c')?.via).toEqual(['ca']);
    expect(w.tainted).toEqual([]);
  });

  it('breaks a tie between parallel relations by name, never by the order they are written in', () => {
    // Three relations between x (held at 0) and y. The first by key is the tree edge, the others
    // chords with residual phi(x) - phi(y) - value. Named 0, 7.5, 15 mV in key order: y at 0 and
    // residuals -7.5 and -15 mV, closure 15 mV, does not close. Named 7.5, 0, 15 mV: y at -7.5 mV
    // and residuals +7.5 and -7.5 mV, closes.
    const rels = (a: number, b: number, c: number): WalkRelation[] => [
      held('x', 0),
      tie('x', 'y', a, 'E1'),
      tie('x', 'y', b, 'E2'),
      tie('x', 'y', c, 'E3'),
    ];
    const open = verdict(rels(0, 0.0075, 0.015), seeds({ x: 0 }));
    const closed = verdict(rels(0.0075, 0, 0.015), seeds({ x: 0 }));
    expect(open.blocks.find((b) => b.relations.includes('E1'))?.consistent).toBe(false);
    expect(closed.blocks.find((b) => b.relations.includes('E1'))?.consistent).toBe(true);
    for (const order of permutations(rels(0, 0.0075, 0.015)))
      expect(verdict(order, seeds({ x: 0 }))).toEqual(open);
    for (const order of permutations(rels(0.0075, 0, 0.015)))
      expect(verdict(order, seeds({ x: 0 }))).toEqual(closed);
  });

  it('reports a held wire at its authored level, and enters the next block from it there', () => {
    // a and b both held at 0, a - b = 7.5 mV: closes (residual 7.5 mV), and b's local potential is
    // -7.5 mV. The bridge c - b = 0.1 starts from b's REPORTED level, 0, so c is at 0.1 V.
    const rels = [
      held('a', 0),
      held('b', 0),
      tie('a', 'b', 0.0075, 'ab'),
      tie('c', 'b', 0.1, 'cb'),
    ];
    const w = dcWalk(rels, seeds({ a: 0, b: 0 }));
    expect(w.blocks.every((b) => b.consistent)).toBe(true);
    expect(w.levels.get('b')?.level).toBe(0);
    expect(w.levels.get('c')?.level).toBeCloseTo(0.1, 12);
  });

  it('trusts a wire beyond a block that closes and taints one beyond a block that does not', () => {
    // p and q held, x tied to both, d hung off x by d - x = 0.2. With p = q = 0 the block closes
    // and d sits at 0.2; with q = 1 it does not, and both x and d are left without a value.
    const rels = (q: number): WalkRelation[] => [
      held('p', 0),
      held('q', q),
      tie('x', 'p', 0, 'xp'),
      tie('x', 'q', 0, 'xq'),
      tie('d', 'x', 0.2, 'dx'),
    ];
    const good = dcWalk(rels(0), seeds({ p: 0, q: 0 }));
    expect(good.levels.get('d')?.level).toBeCloseTo(0.2, 12);
    const bad = dcWalk(rels(1), seeds({ p: 0, q: 1 }));
    expect(bad.levels.has('d')).toBe(false);
    expect(bad.tainted).toEqual(['d', 'x']);
  });

  it('reports a group no held wire reaches as one floating degree of freedom', () => {
    const w = dcWalk([held('a', 1), tie('u', 'v', 0.3, 'uv')], seeds({ a: 1 }));
    expect(w.floating).toEqual([['u', 'v']]);
    expect(w.levels.has('u')).toBe(false);
  });

  it('reads a relation from a wire to itself as a loop of one: g == s states vgs = 0', () => {
    // V(g) - V(g) = 0.5: residual 0 - 0.5. Within 10 mV of zero it closes.
    const off = dcWalk([held('g', 0), tie('g', 'g', 0.5, 'gs', { m__vgs: 1 })], seeds({ g: 0 }));
    const loop = off.blocks.find((b) => b.relations[0].label === 'gs')!;
    expect(loop.chords[0].residual).toBe(-0.5);
    expect(loop.consistent).toBe(false);
    // One real constraint, vgs = 0, proven.
    expect(dofOf(off)).toMatchObject({ proven: 1, bound: 1 });
    const on = dcWalk([held('g', 0), tie('g', 'g', 0.005, 'gs', { m__vgs: 1 })], seeds({ g: 0 }));
    expect(on.blocks.every((b) => b.consistent)).toBe(true);
  });
});

describe('the rank count of the wiring constraints', () => {
  it('counts a = q, b = 2q, a = p, b = 2p as ONE constraint, kept while it holds', () => {
    // Held a = q and b = 2q; a and b also stand p and 2p above ground. Two loops, rows q - p and
    // 2q - 2p, of rank one. At p = q = 0.3 both hold, so the one constraint is kept as satisfied.
    const g = relation(REF, 'gnd', 0, sym(), {
      kind: RELATION_KINDS.ground,
      inst: '',
      tie: '',
      label: 'gnd',
    });
    const rels = [
      g,
      held('a', 0.3, { qq: 1 }),
      held('b', 0.6, { qq: 2 }),
      tie('a', 'gnd', 0.3, 'Ea', { pp: 1 }),
      tie('b', 'gnd', 0.6, 'Eb', { pp: 2 }),
    ];
    const dof = dofOf(dcWalk(rels, seeds({ gnd: 0, a: 0.3, b: 0.6 })));
    expect(dof.proven).toBe(1);
    expect(dof.bound).toBe(1);
    expect(dof.constraints).toHaveLength(1);
    expect(dof.constraints[0].satisfied).toBe(true);
  });

  it('drops a loop whose equation reduces to zero: a symbolic identity is not a constraint', () => {
    // Two relations stating the same thing between the same wires: the row is x - x.
    const rels = [
      held('a', 0),
      tie('a', 'b', 0.4, 'one', { x: 1 }),
      tie('a', 'b', 0.4, 'two', { x: 1 }),
    ];
    expect(dofOf(dcWalk(rels, seeds({ a: 0 })))).toMatchObject({
      proven: 0,
      bound: 0,
      constraints: [],
    });
  });

  it('counts a row with a term it cannot read under BOUND only, naming the term', () => {
    const rels = [
      held('a', 0),
      tie('a', 'b', 0.4, 'one', { x: 1 }),
      tie('a', 'b', 0.4, 'two', { '~(odd)': 1 }),
    ];
    const dof = dofOf(dcWalk(rels, seeds({ a: 0 })));
    expect(dof).toMatchObject({ proven: 0, bound: 1, undecided: ['odd'] });
  });
});

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

// The demo device over drain and body voltage, reaching past every bias below.
const t = generateDemoDevice({
  vds: { min: 0, max: 1.8, step: 0.05 },
  vsb: { min: 0, max: 0.9, step: 0.05 },
});

const param = (name: string, value: number, extra: Partial<SheetVar> = {}): SheetVar => ({
  name,
  value,
  ...extra,
});
const vparam = (name: string, value: number): SheetVar =>
  param(name, value, { unit: 'V', class: 'independent' });
/** A one-device child: givens over its own params, publishing what a parent reads. */
const leaf = (polarity: 'n' | 'p', givens: SheetGivens, params: [string, number][]): SheetDoc => ({
  title: `${polarity} device`,
  polarity,
  params: params.map(([n, v]) => param(n, v)),
  givens,
  equations: [],
  checks: [],
  provides: ['vgs', 'id', 'gm', 'gds', 'W'],
});
const block = (
  name: string,
  doc: SheetDoc,
  params: Record<string, string>,
  nodes?: DeviceNodes | DeviceNodes[],
): SheetBlock => ({
  name,
  doc,
  params,
  ...(nodes ? { nodes } : {}),
});
const nodesWarnings = (r: { warnings: { rule: string; severity: string; message: string }[] }) =>
  r.warnings.filter((w) => w.rule === 'sheet-nodes');

/**
 * A CMOS inverter with its input HELD at V_in and each device sized at its own inversion level:
 * the gates are wired to one wire and nothing makes them agree. The p device's drain voltage is
 * passed through `p_sign`, declared a selector or not.
 */
function inverter(o: { selector?: boolean; pFactor?: string; ldSel?: string } = {}): SheetDoc {
  return {
    title: 'inverter',
    polarity: 'n',
    formatVersion: 2,
    params: [
      vparam('VDD', 1.8),
      vparam('V_in', 0.7),
      vparam('V_out', 0.9),
      param('p_sign', 1, o.selector === false ? {} : { convention: 'axis-sign' }),
    ],
    blocks: [
      block(
        'n',
        leaf('n', { L: '0.5e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
          ['I', 20e-6],
          ['vd', 0.9],
        ]),
        { vd: 'V_out' },
        {
          d: 'out',
          g: 'in',
          s: 'gnd',
          b: 'gnd',
        },
      ),
      block(
        'p',
        leaf('p', { L: '0.5e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
          ['I', 20e-6],
          ['vd', 0.9],
        ]),
        { I: o.pFactor ? `${o.pFactor}*n__id` : 'n__id', vd: o.ldSel ?? 'p_sign*(VDD - V_out)' },
        { d: 'out', g: 'in', s: 'vdd', b: 'vdd' },
      ),
    ],
    levels: { vdd: 'VDD', in: 'V_in' },
    equations: [],
    checks: [],
  };
}

const vgsOf = (r: SheetResult, name: string): number =>
  r.blocks!.find((b) => b.name === name)!.sizing!.vgs;
const idOf = (r: SheetResult, name: string): number =>
  r.blocks!.find((b) => b.name === name)!.sizing!.id;

describe('the inverter with a held input: both gate claims, and the rank count', () => {
  it('reports the two loops through the shared gate with both claims, and the output balance as an identity', () => {
    // Worked on the canonical tree (from gnd): the chord levels.in reads V_in - n.vgs, the chord
    // p.gs reads n.vgs + p.vgs - VDD (the p device's physical vgs is -p.vgs on an N-style table),
    // and the output loop V_out - VDD + (VDD - V_out) is zero.
    const r = runSheet(inverter(), t);
    const vn = vgsOf(r, 'n');
    const vp = vgsOf(r, 'p');
    const chords = r.nodes!.disputes[0].chords;
    expect(chords.find((c) => c.relation === 'levels.in')!.residual).toBeCloseTo(0.7 - vn, 12);
    expect(chords.find((c) => c.relation === 'p.gs')!.residual).toBeCloseTo(vn + vp - 1.8, 12);
    expect(chords.find((c) => c.relation === 'p.ds')!.residual).toBeCloseTo(0, 12);
    expect(r.nodes!.state).toBe('checked-with-findings');
    // Both claims, each with what it reads along: no value is chosen for the shared gate's partner.
    const [raised] = nodesWarnings(r);
    expect(raised.message).toContain('levels.in holds in at 0.7 V, while gnd, n.gs put it at');
    expect(raised.message).toContain('p.gs states V(in) - V(vdd) =');
    expect(raised.message).toContain(
      'Held gnd at 0 V, in at 0.7 V, vdd at 1.8 V, disputed by levels.in, p.gs',
    );
    expect(r.nodes!.tainted).toEqual(['out']);
  });

  it('is over-determined by two, proven, with the selector declared — and by two proven of three when it is not', () => {
    const declared = runSheet(inverter(), t).nodes!.dof;
    expect(declared).toMatchObject({ proven: 2, bound: 2 });
    // Undeclared, p_sign*(VDD - V_out) is a product of params: the drain loop becomes a row the
    // count cannot read, which lands under BOUND and never under PROVEN.
    const bare = runSheet(inverter({ selector: false }), t).nodes!.dof;
    expect(bare).toMatchObject({ proven: 2, bound: 3 });
    expect(bare.undecided[0]).toContain('p_sign*(VDD - V_out)');
  });

  it('keeps the row of a param that merely equals 1 and carries no marker', () => {
    const doc = inverter({ ldSel: 'g*(VDD - V_out)' });
    doc.params.push(param('g', 1));
    expect(runSheet(doc, t).nodes!.dof.bound).toBe(3);
  });

  it('does not read a selector distributed over a sum: p_sign*VDD - p_sign*V_out reports under BOUND', () => {
    expect(runSheet(inverter({ ldSel: 'p_sign*VDD - p_sign*V_out' }), t).nodes!.dof).toMatchObject({
      proven: 2,
      bound: 3,
    });
  });

  it('gives the same warnings and report in every order its blocks and levels are written in', () => {
    // The p device is given the n device's current as a number, so neither block reads the other
    // and both orders size the same design.
    const doc = inverter();
    doc.blocks![1].params = { ...doc.blocks![1].params, I: '20e-6' };
    const swapped = {
      ...doc,
      blocks: [...doc.blocks!].reverse(),
      levels: { in: 'V_in', vdd: 'VDD' },
    };
    const a = runSheet(doc, t);
    const b = runSheet(swapped, t);
    expect(nodesWarnings(b).map((w) => w.message)).toEqual(nodesWarnings(a).map((w) => w.message));
    expect(b.nodes).toEqual(a.nodes);
  });

  it('refuses a declared selector whose value is not the table axis direction, wherever an axis reads it', () => {
    const refused = (d: SheetDoc): boolean =>
      runSheet(d, t).warnings.some(
        (w) =>
          w.rule === 'sheet-nodes' &&
          w.severity === 'error' &&
          w.message.includes('"p_sign" is an axis-sign selector'),
      );
    const flipped = (d: SheetDoc): SheetDoc => ({
      ...d,
      params: d.params.map((p) => (p.name === 'p_sign' ? { ...p, value: -1 } : p)),
    });
    expect(refused(flipped(inverter()))).toBe(true);
    expect(runSheet(flipped(inverter()), t).feasible).toBe(false);
    // Read outside the root product it is not normalized, and is still held to the table.
    expect(refused(flipped(inverter({ ldSel: 'p_sign*VDD - p_sign*V_out' })))).toBe(true);
    expect(refused(inverter())).toBe(false);
  });
});

describe('the current balance', () => {
  it('sums the currents flowing INTO a wire nothing holds: an n drain draws its current out, a p drain returns it', () => {
    // On the output wire: the n device's drain carries I_n out of the wire, the p device's drain
    // carries I_p into it. With the p device given 1.5 times the n device's current, the residual
    // is I_p - I_n = +0.5 I_n — positive, more current arriving than leaving.
    const r = runSheet(inverter({ pFactor: '1.5' }), t);
    const out = r.nodes!.balance.find((b) => b.wire === 'out')!;
    const iN = idOf(r, 'n');
    expect(out.residual).toBeCloseTo(0.5 * iN, 18);
    expect(out.branches).toEqual([
      { terminal: 'n.d', current: -iN },
      { terminal: 'p.d', current: idOf(r, 'p') },
    ]);
    expect(
      nodesWarnings(r).some((w) => w.message.includes('the currents at wire "out" do not balance')),
    ).toBe(true);
  });

  it('reports a wire whose currents agree, and raises nothing for it', () => {
    const r = runSheet(inverter(), t);
    expect(r.nodes!.balance.find((b) => b.wire === 'out')!.residual).toBeCloseTo(0, 18);
    expect(nodesWarnings(r).some((w) => w.message.includes('do not balance'))).toBe(false);
  });
});

/**
 * A source follower: gate held at V_in, drain held at VDD, source derived. Its drain-source and
 * body voltages are written from an estimate of its own gate-source voltage, solved or typed.
 */
function follower(solved: boolean): SheetDoc {
  return {
    title: 'follower',
    polarity: 'n',
    formatVersion: 2,
    params: [
      vparam('VDD', 1.8),
      vparam('V_in', 1.2),
      param('vgs_est', 0.5, solved ? { solveFor: 'm__vgs', min: 0.2, max: 1.5 } : {}),
    ],
    blocks: [
      block(
        'm',
        leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd', vsb: 'vs' }, [
          ['I', 10e-6],
          ['vd', 1],
          ['vs', 0.6],
        ]),
        { vd: 'VDD - V_in + vgs_est', vs: 'V_in - vgs_est' },
        { d: 'vdd', g: 'in', s: 'out', b: 'gnd' },
      ),
    ],
    levels: { vdd: 'VDD', in: 'V_in' },
    // The output is what the follower drives: a port, whose other end is outside this sheet.
    ports: ['out'],
    equations: [],
    checks: [],
  };
}

describe('the source follower: a held gate, a held drain, a derived source', () => {
  it('reports the conflict with both claims and chooses no value for the source', () => {
    // Canonical tree from gnd: ref at 0, out at vsb = V_in - vgs_est, then in and vdd at their
    // levels. The chord m.gs reads V_in - (V_in - vgs_est) - vgs = vgs_est - vgs; the chord m.ds
    // reads (V_in - vgs_est) - VDD + (VDD - V_in + vgs_est) = 0.
    const r = runSheet(follower(false), t);
    const vgs = vgsOf(r, 'm');
    const chords = r.nodes!.disputes[0].chords;
    expect(chords.find((c) => c.relation === 'm.gs')!.residual).toBeCloseTo(0.5 - vgs, 12);
    expect(chords.find((c) => c.relation === 'm.ds')!.residual).toBeCloseTo(0, 12);
    const [raised] = nodesWarnings(r);
    expect(raised.message).toContain(
      `m.gs states V(in) - V(out) = ${Number(vgs.toPrecision(4))} V, while gnd, levels.in, m.bs put it at 0.5 V`,
    );
    expect(r.nodes!.levels.out).toBeUndefined();
    expect(r.nodes!.tainted).toEqual(['out']);
  });

  it('closes once the estimate is solved, derives the source, and keeps vgs - vgs_est as a satisfied constraint', () => {
    const r = runSheet(follower(true), t);
    expect(r.nodes!.state).toBe('checked-clean');
    expect(r.nodes!.levels.out.level).toBeCloseTo(1.2 - vgsOf(r, 'm'), 5);
    // Derived from the first held wire, gnd, along the tree edge the body relation is.
    expect(r.nodes!.levels.out.via).toEqual(['m.bs']);
    // The row vgs_est - m__vgs is not an identity — it holds because a solve makes it hold — so it
    // is kept, proven, and reported as satisfied.
    expect(r.nodes!.dof).toMatchObject({ proven: 1, bound: 1 });
    expect(r.nodes!.dof.constraints[0]).toMatchObject({ satisfied: true, proven: true });
  });
});

describe('a structural diode: the gate on the drain wire', () => {
  const diodeGivens: SheetGivens = { L: '0.5e-6', id: 'I', gm_id: '10' };
  const own = (extra: Partial<SheetDoc> = {}, givens: Partial<SheetGivens> = {}): SheetDoc => ({
    title: 'diode',
    polarity: 'n',
    params: [param('I', 10e-6)],
    givens: { ...diodeGivens, ...givens },
    equations: [],
    checks: [],
    ...extra,
  });
  const wired = (
    givens: Partial<SheetGivens> = {},
    nodes: DeviceNodes = { d: 'x', g: 'x', s: 'gnd', b: 'gnd' },
  ): SheetDoc => own({ formatVersion: 2, nodes }, givens);

  it('is sized on the vds = vgs diagonal exactly as diode: true is', () => {
    const legacy = runSheet(own({}, { diode: true }), t);
    const derived = runSheet(wired(), t);
    expect(derived.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(derived.sizing!.vgs).toBe(legacy.sizing!.vgs);
    expect(derived.sizing!.W).toBe(legacy.sizing!.W);
  });

  it('adds no constraint: its gate and drain relations say the same thing', () => {
    expect(runSheet(wired(), t).nodes!.dof).toMatchObject({ proven: 0, bound: 0 });
  });

  it('refuses a flag the wires contradict, either way, and a vds beside the connection', () => {
    const errs = (d: SheetDoc): string[] =>
      validateSheet(d)
        .filter((w) => w.severity === 'error')
        .map((w) => w.message);
    expect(
      errs(wired({ diode: false })).some((m) => m.includes('but the givens say diode: false')),
    ).toBe(true);
    expect(runSheet(wired({ diode: false }), t).feasible).toBe(false);
    expect(
      errs(wired({ diode: true }, { d: 'x', g: 'y', s: 'gnd', b: 'gnd' })).some((m) =>
        m.includes('the givens say diode: true'),
      ),
    ).toBe(true);
    expect(
      errs(wired({ vds: '0.6' })).some((m) => m.includes('the wires put the gate on the drain')),
    ).toBe(true);
  });

  it('wires a child as a diode from the parent block, and sizes it there', () => {
    const parent = (nodes: DeviceNodes, flag?: boolean): SheetDoc => ({
      title: 'parent',
      polarity: 'n',
      formatVersion: 2,
      params: [],
      blocks: [
        block(
          'm',
          leaf('n', { ...diodeGivens, ...(flag ? { diode: true } : {}) }, [['I', 10e-6]]),
          {},
          nodes,
        ),
      ],
      equations: [],
      checks: [],
    });
    const viaWires = runSheet(parent({ d: 'x', g: 'x', s: 'gnd', b: 'gnd' }), t);
    const viaFlag = runSheet(parent({ d: 'x', g: 'x', s: 'gnd', b: 'gnd' }, true), t);
    expect(viaWires.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(viaWires.blocks![0].sizing!.vgs).toBe(viaFlag.blocks![0].sizing!.vgs);
  });

  it('round-trips: the legacy flag stays a flag, the wires stay wires, and no flag is written into the document', () => {
    // The flag on a sheet that declares it is not a circuit: the one place it still stands alone.
    const legacy = own({ formatVersion: 2, nodes: 'none' }, { diode: true });
    expect(JSON.parse(JSON.stringify(legacy))).toEqual(legacy);
    expect(validateSheet(legacy).filter((w) => w.severity === 'error')).toEqual([]);
    const v2 = wired();
    const back = JSON.parse(JSON.stringify(v2)) as SheetDoc;
    expect(back.nodes).toEqual({ d: 'x', g: 'x', s: 'gnd', b: 'gnd' });
    expect(back.givens?.diode).toBeUndefined();
    // The structural diode is applied to a copy the evaluation reads; the authored document keeps
    // its wires as written and gains no flag.
    expect(structuralDiodes(v2).givens?.diode).toBe(true);
    expect(v2.givens?.diode).toBeUndefined();
  });

  it('passes a document with no wiring through untouched, so no library sheet moves', () => {
    const doc = own({}, { vds: '0.6' });
    expect(structuralDiodes(doc)).toBe(doc);
  });
});

describe('the fixed-hardware rewrite keeps the wiring', () => {
  /** A wired simple mirror: a reference wired as a diode (no flag) and an output on its gate. */
  const mirror: SheetDoc = {
    title: 'mirror',
    polarity: 'n',
    formatVersion: 2,
    params: [
      vparam('V_out', 0.9),
      vparam('VDD', 1.8),
      param('I_in', 20e-6, { unit: 'A', class: 'independent' }),
      param('V_lo', 0.6, { unit: 'V', class: 'independent' }),
      param('V_hi', 1.2, { unit: 'V', class: 'independent' }),
    ],
    blocks: [
      block(
        'ref',
        leaf('n', { L: '1e-6', id: 'I', gm_id: '8' }, [['I', 20e-6]]),
        { I: 'I_in' },
        { d: 'g', g: 'g', s: 'gnd', b: 'gnd' },
      ),
    ],
    givens: { L: '1e-6', W: '4*ref__W', vgs: 'ref__vgs', vds: 'V_out' },
    nodes: { d: 'out', g: 'g', s: 'gnd', b: 'gnd' },
    // The programmed reference current, drawn as an ideal source from the supply into the diode.
    elements: [{ name: 'Iref', kind: 'I', between: ['vdd', 'g'], value: 'I_in' }],
    levels: { out: 'V_out', vdd: 'VDD' },
    operatingRange: [
      { name: 'lo', set: { V_out: 'V_lo' } },
      { name: 'hi', set: { V_out: 'V_hi' } },
    ],
    equations: [],
    checks: [],
  };

  it('keeps every nodes declaration, and the derived diode survives where the hardware is held', () => {
    const base = evaluateSheet(mirror, t);
    const held = holdHardware(mirror, base).doc;
    expect(held.nodes).toEqual(mirror.nodes);
    expect(held.blocks![0].nodes).toEqual(mirror.blocks![0].nodes);
    expect(held.levels).toEqual(mirror.levels);
    // Held at its width with no drain voltage stated: without the diode it would not size at all.
    const r = runSheet(mirror, t);
    for (const e of r.rangeEnds!) {
      expect(e.error).toBeUndefined();
      expect(e.state).not.toBe('no-answer');
    }
    // Rewriting the normalized document keeps the flag the wires implied.
    expect(holdHardware(structuralDiodes(mirror), base).doc.blocks![0].doc!.givens!.diode).toBe(
      true,
    );
  });

  it('checks the mirror clean: the shared gate is the output device given the reference vgs', () => {
    const r = runSheet(mirror, t);
    expect(r.nodes!.state).toBe('checked-clean');
    expect(r.nodes!.dof).toMatchObject({ proven: 0, bound: 0 });
    expect(r.nodes!.levels.g.level).toBeCloseTo(vgsOf(r, 'ref'), 12);
  });
});

describe('placements of one sizing', () => {
  const pair = (second: DeviceNodes, levels: Record<string, string>): SheetDoc => ({
    title: 'pair',
    polarity: 'n',
    formatVersion: 2,
    params: [vparam('V_cm', 1), vparam('V_o', 1.3), vparam('V_o2', 1.0)],
    blocks: [
      block(
        'm',
        leaf('n', { L: '1e-6', id: 'I', gm_id: '12', vds: 'vd', vsb: 'vs' }, [
          ['I', 10e-6],
          ['vd', 0.6],
          ['vs', 0.4],
        ]),
        { vd: 'V_o - V_cm + m_vgs_cm', vs: 'V_cm - m_vgs_cm' },
        [{ d: 'o1', g: 'i1', s: 't', b: 'gnd' }, second],
      ),
    ],
    levels,
    equations: [],
    checks: [],
  });
  const withEstimate = (d: SheetDoc): SheetDoc => ({
    ...d,
    params: [...d.params, param('m_vgs_cm', 0.5, { solveFor: 'm__vgs', min: 0.2, max: 1.5 })],
  });

  it('accepts a balanced pair: both halves at one gate, drain and body voltage', () => {
    const doc = withEstimate(
      pair(
        { d: 'o2', g: 'i2', s: 't', b: 'gnd' },
        { i1: 'V_cm', i2: 'V_cm', o1: 'V_o', o2: 'V_o' },
      ),
    );
    const r = runSheet(doc, t);
    expect(r.nodes!.placements).toEqual([{ device: 'm', shared: true }]);
  });

  it('disqualifies two placements whose drains are held apart: the loop does not close, so no level is trusted', () => {
    // Both drains state one vds from one source, and are held 0.3 V apart: the walk cannot close,
    // the shared source is tainted, and the placements cannot be shown to share an operating point.
    const doc = withEstimate(
      pair(
        { d: 'o2', g: 'i2', s: 't', b: 'gnd' },
        { i1: 'V_cm', i2: 'V_cm', o1: 'V_o', o2: 'V_o2' },
      ),
    );
    const r = runSheet(doc, t);
    expect(r.nodes!.placements[0]).toMatchObject({ device: 'm', shared: false });
    expect(r.nodes!.placements[0].reason).toContain('no trusted level');
    expect(nodesWarnings(r).some((w) => w.message.startsWith('the wiring does not close'))).toBe(
      true,
    );
  });

  it('refuses placements the walk puts at gate voltages more than the tolerance apart, though every loop closes', () => {
    // Gates held 9 mV above and below the common mode. The source is derived from ground through
    // the body relation, at V_cm - vgs; each gate loop's residual is then +9 or -9 mV, within the
    // tolerance, so the walk closes — but the two placements read gate-source voltages 18 mV apart.
    const doc = withEstimate(
      pair(
        { d: 'o2', g: 'i2', s: 't', b: 'gnd' },
        { i1: 'V_cm + 0.009', i2: 'V_cm - 0.009', o1: 'V_o', o2: 'V_o' },
      ),
    );
    const r = runSheet(doc, t);
    expect(r.nodes!.disputes).toEqual([]);
    expect(r.nodes!.placements[0].shared).toBe(false);
    expect(
      nodesWarnings(r).some((w) =>
        w.message.includes('the placements of "m" are not at one operating point'),
      ),
    ).toBe(true);
  });

  it('refuses placements 12 mV apart: the tolerance is 10 mV, compared per terminal difference', () => {
    // Gates 6 mV either side of the common mode: each loop within tolerance, the two placements
    // 12 mV apart in vgs — past 10 mV, under any looser bound. Body voltages are the same.
    const doc = withEstimate(
      pair(
        { d: 'o2', g: 'i2', s: 't', b: 'gnd' },
        { i1: 'V_cm + 0.006', i2: 'V_cm - 0.006', o1: 'V_o', o2: 'V_o' },
      ),
    );
    const r = runSheet(doc, t);
    expect(r.nodes!.disputes).toEqual([]);
    const reason = r.nodes!.placements[0].reason!;
    expect(reason).toMatch(
      /^placement 1 sits at vgs .* V, vds .* V, vsb .* V and placement 0 at vgs/,
    );
    expect(r.nodes!.placements[0].shared).toBe(false);
  });

  it('refuses, structurally, a list that mixes a diode-connected placement with one that is not', () => {
    const doc = pair({ d: 'i2', g: 'i2', s: 't', b: 'gnd' }, { i1: 'V_cm', o1: 'V_o' });
    expect(
      nodesProblems(doc).some(
        (w) =>
          w.severity === 'error' &&
          w.message.includes('some placements put the gate on the drain wire'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The format contract and the netlist's own structure
// ---------------------------------------------------------------------------------------------

const errors = (ws: { severity: string; message: string }[]): string[] =>
  ws.filter((w) => w.severity === 'error').map((w) => w.message);

describe('the format contract', () => {
  const plainDoc: SheetDoc = { title: 'x', polarity: 'n', params: [], equations: [], checks: [] };

  it('reads a document with no version in the earlier format, where every netlist key is refused by name', () => {
    const doc: SheetDoc = { ...plainDoc, levels: { a: '1' }, nodes: 'none' };
    const msgs = errors(formatProblems(doc));
    expect(msgs).toContain(
      '"levels" belongs to format version 2 — add "formatVersion": 2 to this document to use it',
    );
    expect(msgs).toContain(
      '"nodes" belongs to format version 2 — add "formatVersion": 2 to this document to use it',
    );
  });

  it('refuses the earlier gate wiring in either format, as a key it names with the migration', () => {
    const fix =
      'block "b": "wiring" is not read in any format — the wires a block\'s device sits on are its ' +
      '"nodes" in format version 2; a script can draft the nodes from the givens with proposeWiring ' +
      'and write them into a format-version-2 copy with applyWiringProposal (see "Scripting the ' +
      'core" in the README)';
    for (const version of [{}, { formatVersion: 2 }]) {
      const doc = {
        ...plainDoc,
        ...version,
        blocks: [{ name: 'b', doc: plainDoc, wiring: { gate: 'a', source: 'b' } }],
      } as unknown as SheetDoc;
      expect(errors(formatProblems(doc))).toEqual([fix]);
      expect(errors(validateSheet(doc))).toContain(fix);
    }
  });

  it('refuses a document of an unknown version, naming its version and the ones this app reads', () => {
    const doc = { ...plainDoc, formatVersion: 3 };
    expect(errors(formatProblems(doc))[0]).toBe(
      'format version 3 is not one this app reads (it reads documents with no format version, and ' +
        'format version 2) — the document is not imported or evaluated; a stored copy is kept as it ' +
        'was stored',
    );
    expect(sheetFormat(doc).format).toBe('unknown');
    expect(sheetFormat(plainDoc)).toEqual({ format: 'earlier' });
  });
});

describe('the netlist lints', () => {
  const dev = leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
    ['I', 1e-5],
    ['vd', 0.6],
  ]);
  const doc = (blocks: SheetBlock[], extra: Partial<SheetDoc> = {}): SheetDoc => ({
    title: 'lint',
    polarity: 'n',
    formatVersion: 2,
    params: [vparam('VDD', 1.8)],
    blocks,
    equations: [],
    checks: [],
    ...extra,
  });
  const lints = (d: SheetDoc): string[] =>
    nodesProblems(d).map((w) => `${w.severity}: ${w.message}`);

  it('names a missing terminal, an unknown key, a misspelt wire and the flattening separator', () => {
    const msgs = lints(
      doc([
        block('a', dev, {}, { d: 'x', g: 'y', s: 'gnd' } as unknown as DeviceNodes),
        block('b', dev, {}, { d: 'x', g: 'y', s: 'gnd', b: 'gnd', q: 1 } as unknown as DeviceNodes),
        block('c', dev, {}, { d: '9x', g: 'a__b', s: 'gnd', b: 'gnd' }),
      ]),
    );
    expect(msgs).toContain('error: block "a": nodes names no b — every terminal sits on a wire');
    expect(msgs).toContain(
      'error: block "b": nodes has unknown key "q" — a placement names d, g, s and b',
    );
    expect(msgs).toContain(
      'error: block "c": a wire is named by an identifier (letters, digits, _), got "9x"',
    );
    expect(msgs).toContain(
      'error: block "c": wire "a__b" contains "__", which joins a child\'s names to its block',
    );
  });

  it('refuses a short, warns on a gate on its own source unless it is declared off', () => {
    expect(lints(doc([block('a', dev, {}, { d: 'x', g: 'y', s: 'x', b: 'gnd' })]))).toContain(
      'error: block "a": drain and source are both on wire "x", which shorts the device',
    );
    const off = (intent?: 'off') =>
      lints(
        doc([
          block('a', dev, {}, { d: 'x', g: 's', s: 's', b: 'gnd', ...(intent ? { intent } : {}) }),
          block('b', dev, {}, { d: 'x', g: 's', s: 'gnd', b: 'gnd' }),
        ]),
      );
    expect(
      off().some((m) => m.startsWith('warning: block "a": gate and source are both on wire "s"')),
    ).toBe(true);
    expect(off('off').some((m) => m.includes('gate and source are both on wire'))).toBe(false);
  });

  it('refuses a wire one terminal names, unless it is held or a port', () => {
    const lone = doc([
      block('a', dev, {}, { d: 'x', g: 'lone', s: 'gnd', b: 'gnd' }),
      block('b', dev, {}, { d: 'x', g: 'g2', s: 'gnd', b: 'gnd' }),
    ]);
    expect(
      lints(lone).some((m) =>
        m.startsWith('error: wire "lone" is named by one terminal only (block "a" g)'),
      ),
    ).toBe(true);
    const ok = { ...lone, levels: { lone: 'VDD', g2: 'VDD' } };
    expect(lints(ok).some((m) => m.includes('named by one terminal only'))).toBe(false);
    const ported = { ...lone, ports: ['lone', 'g2'] };
    expect(lints(ported).some((m) => m.includes('named by one terminal only'))).toBe(false);
  });

  it('refuses gnd in levels and a level on a wire nothing names', () => {
    const d = doc([block('a', dev, {}, { d: 'x', g: 'x', s: 'gnd', b: 'gnd' })], {
      levels: { gnd: '0', nowhere: 'VDD' },
    });
    const msgs = lints(d);
    expect(msgs).toContain('error: levels: "gnd" is the reference at 0 and is not listed');
    expect(msgs).toContain(
      'error: levels holds wire "nowhere", which no terminal, element or port of this sheet names',
    );
  });

  it('keeps nodes: "none" exclusive with every piece of wiring', () => {
    const d = doc([block('a', dev, {}, { d: 'x', g: 'x', s: 'gnd', b: 'gnd' })], {
      nodes: 'none',
      levels: { x: 'VDD' },
    });
    expect(
      lints(d).some((m) =>
        m.startsWith(
          'error: nodes: "none" says this sheet is not a circuit, so it carries no wiring — drop levels, block "a" nodes',
        ),
      ),
    ).toBe(true);
  });

  it('refuses a block that wires a child already wiring itself, and nodes on a document that sizes nothing', () => {
    const self: SheetDoc = {
      ...dev,
      formatVersion: 2,
      nodes: { d: 'p', g: 'p', s: 'gnd', b: 'gnd' },
    };
    expect(
      lints(doc([block('a', self, {}, { d: 'x', g: 'x', s: 'gnd', b: 'gnd' })])).some((m) =>
        m.includes('the child wires its own device'),
      ),
    ).toBe(true);
    expect(
      lints(doc([], { nodes: { d: 'x', g: 'x', s: 'gnd', b: 'gnd' } })).some((m) =>
        m.startsWith('error: nodes on a document name the wires its own device sits on'),
      ),
    ).toBe(true);
  });

  it('requires an exact port map: a port left out is refused, and so is one the child does not declare', () => {
    const child: SheetDoc = { ...dev, formatVersion: 2, ports: ['in', 'out'] };
    const partial = doc([{ name: 'a', doc: child, ports: { in: 'x' } }]);
    expect(
      lints(partial).some((m) => m.includes('ports does not map the child\'s port "out"')),
    ).toBe(true);
    const extra = doc([{ name: 'a', doc: child, ports: { in: 'x', out: null, side: 'y' } }]);
    expect(
      lints(extra).some((m) =>
        m.includes('ports maps "side", which the child does not declare as a port'),
      ),
    ).toBe(true);
    const exact = doc([{ name: 'a', doc: child, ports: { in: 'x', out: null } }], {
      levels: { x: 'VDD' },
    });
    expect(lints(exact)).toEqual([]);
  });

  it('checks an analysis shape and refuses a name the sheet already uses', () => {
    const d = doc([block('a', dev, {}, { d: 'x', g: 'g', s: 'gnd', b: 'gnd' })], {
      levels: { x: 'VDD', g: 'VDD' },
      analyses: [
        { name: 'VDD', kind: 'gain', in: { g: 1 }, out: { x: 1 }, at: 1e3 },
        { name: 'z', kind: 'impedance', node: 'nowhere', at: -1, as: 'db' } as never,
      ],
    });
    const msgs = lints(d);
    expect(msgs.some((m) => m.includes('analysis "VDD": the name is already a param'))).toBe(true);
    expect(
      msgs.some((m) => m.includes('analysis "z": node "nowhere" is not a wire of this sheet')),
    ).toBe(true);
    expect(msgs.some((m) => m.includes('analysis "z": at must be a positive frequency'))).toBe(
      true,
    );
    expect(
      msgs.some((m) => m.includes('analysis "z": as must be one of mag, real, imag, phase')),
    ).toBe(true);
  });

  it('holds an axis-sign selector to +1 or -1, read by a bias axis', () => {
    const d = doc(
      [block('a', dev, { vd: 's*(VDD - 0.9)' }, { d: 'x', g: 'x', s: 'gnd', b: 'gnd' })],
      {
        params: [
          vparam('VDD', 1.8),
          param('s', 2, { convention: 'axis-sign' }),
          param('u', 1, { convention: 'axis-sign' }),
        ],
      },
    );
    const msgs = lints(d);
    expect(
      msgs.some((m) =>
        m.includes('param "s" is an axis-sign selector, so its value is exactly +1'),
      ),
    ).toBe(true);
    expect(
      msgs.some((m) =>
        m.includes('param "u" is declared an axis-sign selector, but no bias-axis expression'),
      ),
    ).toBe(true);
  });
});

describe('the mandatory wiring rule', () => {
  const sized: SheetDoc = {
    title: 's',
    polarity: 'n',
    params: [param('I', 1e-5)],
    givens: { L: '1e-6', id: 'I', gm_id: '10', vds: '0.6' },
    equations: [],
    checks: [],
  };

  it('is raised by validation: a sized device that names no wiring is refused', () => {
    expect(errors(validateSheet(sized)).join()).toContain(
      "this sheet names no wiring for this sheet's own device",
    );
  });

  it('refuses a sheet that names no wiring for a sized device — and not one declaring nodes: "none"', () => {
    const [refusal] = wiringRefusal(sized);
    expect(refusal.severity).toBe('error');
    expect(refusal.message).toContain("this sheet names no wiring for this sheet's own device");
    expect(refusal.message).toContain('wiring needs "formatVersion": 2');
    // The app has no control that drafts wiring: the message names the functions a script calls.
    expect(refusal.message).toContain('with proposeWiring');
    expect(refusal.message).toContain('with applyWiringProposal');
    expect(wiringRefusal({ ...sized, formatVersion: 2, nodes: 'none' })).toEqual([]);
    expect(
      wiringRefusal({ ...sized, formatVersion: 2, nodes: { d: 'x', g: 'y', s: 'gnd', b: 'gnd' } }),
    ).toEqual([]);
    // Nodes a document of the earlier format carries are not read: its device is still unwired.
    expect(wiringRefusal({ ...sized, nodes: { d: 'x', g: 'y', s: 'gnd', b: 'gnd' } })).toHaveLength(
      1,
    );
  });

  it('counts a child wired by its block as wired, and names the ones that are not', () => {
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      formatVersion: 2,
      params: [],
      blocks: [
        block('a', sized, {}, { d: 'x', g: 'y', s: 'gnd', b: 'gnd' }),
        block('b', sized, {}),
      ],
      equations: [],
      checks: [],
    };
    expect(unwiredDevices(parent)).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------------------------
// Where a level may be written
// ---------------------------------------------------------------------------------------------

describe('levels eligibility and the provenance of one expression', () => {
  const base = (params: SheetVar[], extra: Partial<SheetDoc> = {}): SheetDoc => ({
    title: 'e',
    polarity: 'n',
    formatVersion: 2,
    params,
    equations: [],
    checks: [],
    ...extra,
  });

  it('refuses a solved, an assumed, an unclassified and an equation-valued level, each by name', () => {
    const doc = base(
      [
        vparam('VDD', 1.8),
        param('V_tail', 0.4, {
          unit: 'V',
          designConstraint: { lhs: 'V_tail', rhs: 'VDD/4' },
          min: 0,
          max: 1,
        }),
        param('V_g', 0.7, { unit: 'V', class: 'assumed' }),
        param('V_in', 0.7, { unit: 'V' }),
      ],
      { equations: [{ name: 'V_mid', expr: 'VDD/2' }] },
    );
    const refused = (e: string): string[] => {
      const v = levelEligibility(doc, '', e);
      return v.kind === 'refused' ? v.problems : [];
    };
    expect(refused('V_tail')).toContain(
      'it reads "V_tail", which is solved by the engine, so what it sets is derived',
    );
    expect(refused('V_g')).toContain(
      'it reads "V_g", which is classed assumed — a typed guess held fixed becomes a fact',
    );
    expect(refused('V_in')).toContain(
      'it reads "V_in", which carries no class — say whether it is independent',
    );
    expect(refused('V_mid')).toContain('it reads equation "V_mid"');
    expect(levelEligibility(doc, '', 'VDD')).toEqual({ kind: 'held' });
    expect(levelEligibility(doc, '', '1.8')).toEqual({ kind: 'held' });
  });

  it('tells VDD from a device quantity a parent wires in, although dcInputs reads the same roots', () => {
    // A producer sized at VDD publishes its vgs; a child's `bias` param is wired to VDD in one
    // document and to producer__vgs in the other. Both rest on VDD alone, but the second crosses a
    // device on the way, which no held level may.
    const producer = leaf('n', { L: '1e-6', id: '1e-5', gm_id: '10', vds: 'vd' }, [['vd', 0.6]]);
    const child: SheetDoc = {
      ...leaf('n', { L: '1e-6', id: '1e-5', gm_id: '10', vds: 'bias' }, [['bias', 0.7]]),
    };
    const parent = (bias: string): SheetDoc =>
      base([vparam('VDD', 1.8)], {
        blocks: [block('producer', producer, { vd: 'VDD' }), block('c', child, { bias })],
      });
    const a = parent('VDD');
    const b = parent('producer__vgs');
    expect(dcInputs(a).independent).toEqual(dcInputs(b).independent);
    expect(exprProvenance(a, 'c', 'bias').crossings.device).toEqual([]);
    expect(exprProvenance(b, 'c', 'bias').crossings.device).toEqual(['producer']);
    expect(levelEligibility(b, 'c', 'bias').kind).toBe('refused');
    expect(levelEligibility(a, 'c', 'bias').kind).toBe('held');
  });

  it('finds an independent input that only a level reads', () => {
    const doc = base([vparam('V_ref', 0.6)]);
    expect(exprProvenance(doc, '', 'V_ref').roots.independent).toEqual(['V_ref']);
  });

  it('admits the gate of a node a hold re-solves at the hold expression, and refuses the node itself', () => {
    const casc = leaf('n', { L: '1e-6', id: '1e-5', gm_id: '10', vds: 'vd', vsb: 'vs' }, [
      ['vd', 0.4],
      ['vs', 0.5],
    ]);
    const doc = base(
      [
        vparam('VDD', 1.8),
        param('V_a', 0.5, { unit: 'V', hold: 'V_a + casc__vgs', min: 0.2, max: 1 }),
      ],
      { blocks: [block('casc', casc, { vd: 'VDD - V_a', vs: 'V_a' })] },
    );
    expect(levelEligibility(doc, '', 'V_a + casc__vgs')).toEqual({
      kind: 'held-gate',
      hold: 'V_a',
      device: 'casc',
    });
    expect(levelEligibility(doc, '', 'V_a+casc__vgs')).toEqual({
      kind: 'held-gate',
      hold: 'V_a',
      device: 'casc',
    });
    const node = levelEligibility(doc, '', 'V_a');
    expect(node.kind === 'refused' && node.problems[0]).toContain(
      'the node under a gate that a hold re-solves',
    );
    // Any other expression through a device quantity is a derived level, not a hold.
    expect(levelEligibility(doc, '', 'VDD - casc__vgs').kind).toBe('refused');
  });

  it('reports a dependency cycle a configuration reaches, and terminates', () => {
    const doc = base([], {
      equations: [
        { name: 'a', expr: 'b' },
        { name: 'b', expr: 'a' },
      ],
    });
    expect(configEligibility(doc, '', 'a').some((p) => p.startsWith('its dependencies loop'))).toBe(
      true,
    );
  });

  it('refuses a configuration or an element value that reads an analysis, directly or through an equation', () => {
    const doc = base([param('f', 1e3, { class: 'independent' })], {
      equations: [{ name: 'f2', expr: 'G * 2' }],
      analyses: [{ name: 'G', kind: 'gain', in: { a: 1 }, out: { b: 1 }, at: 'f' }],
    });
    expect(configEligibility(doc, '', 'f')).toEqual([]);
    expect(configEligibility(doc, '', 'G')).toContain('it reads analysis "G"');
    expect(configEligibility(doc, '', 'f2')).toContain('it reads analysis "G"');
    // Equations of configuration are allowed.
    const ok = base([param('f', 1e3, { class: 'independent' })], {
      equations: [{ name: 'w', expr: '2*pi*f' }],
    });
    expect(configEligibility(ok, '', 'w')).toEqual([]);
  });

  it('raises a refused level as a validation error, attributed to the block it is written in', () => {
    const inner: SheetDoc = {
      ...leaf('n', { L: '1e-6', id: '1e-5', gm_id: '10', vds: 'vd' }, [['vd', 0.6]]),
      formatVersion: 2,
      params: [param('vd', 0.6), param('bias', 0.7, { unit: 'V' })],
      nodes: { d: 'x', g: 'x', s: 'gnd', b: 'gnd' },
      levels: { x: 'bias' },
    };
    const parent = base([], { blocks: [block('c', inner, {})] });
    const w = validateSheet(parent).find((x) => x.message.includes('cannot hold the wire'));
    expect(w?.message.startsWith('block "c": levels "x": "bias" cannot hold the wire')).toBe(true);
  });
});

describe('what the check raises, counted once', () => {
  it('counts a selector the table contradicts once, though several axes read it', () => {
    // p_sign is read by the p device's vgs and vds; the table's axis is +1, the selector -1.
    const doc = inverter({ pFactor: '1' });
    doc.params = doc.params.map((p) => (p.name === 'p_sign' ? { ...p, value: -1 } : p));
    const r = evaluateSheet(doc, t);
    const raised = nodesWarnings(r);
    expect(
      raised.filter((w) => w.message.includes('"p_sign" is an axis-sign selector')),
    ).toHaveLength(1);
    expect(r.nodes!.findings).toBe(raised.length);
  });

  it("folds validation's netlist problems into the state runSheet reports", () => {
    // A level on a wire nothing names: a validation error, while the walk itself closes.
    const doc = inverter();
    doc.levels = { ...doc.levels, in: 'V_in', vdd: 'VDD', nowhere: 'VDD' };
    expect(evaluateSheet(doc, t).nodes!.findings).toBe(
      evaluateSheet(inverter(), t).nodes!.findings,
    );
    const r = runSheet(doc, t);
    expect(r.nodes!.findings).toBe(evaluateSheet(doc, t).nodes!.findings + 1);
    expect(r.nodes!.state).toBe('checked-with-findings');
  });

  it('raises a group of wires no held wire reaches', () => {
    // Two devices stacked on wires p, q, r: no gnd, no level, no port.
    const doc: SheetDoc = {
      title: 'float',
      polarity: 'n',
      formatVersion: 2,
      params: [],
      blocks: [
        block(
          'a',
          leaf('n', { L: '1e-6', id: 'I', gm_id: '10', diode: true }, [['I', 1e-5]]),
          {},
          { d: 'p', g: 'p', s: 'q', b: 'q' },
        ),
        block(
          'c',
          leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 1e-5],
            ['vd', 0.6],
          ]),
          {},
          { d: 'q', g: 'p', s: 'r', b: 'r' },
        ),
      ],
      equations: [],
      checks: [],
    };
    const r = evaluateSheet(doc, t);
    expect(r.nodes!.floating).toEqual([['p', 'q', 'r']]);
    expect(nodesWarnings(r).some((w) => w.message.startsWith('wires "p", "q", "r" float'))).toBe(
      true,
    );
  });

  it('does not walk a run with no answer: a device that did not size leaves no design to check', () => {
    const doc: SheetDoc = {
      title: 'nodrain',
      polarity: 'n',
      formatVersion: 2,
      params: [],
      blocks: [
        block(
          'a',
          leaf('n', { L: '1e-6', id: 'I', gm_id: '10' }, [['I', 1e-5]]),
          {},
          { d: 'x', g: 'x2', s: 'gnd', b: 'gnd' },
        ),
      ],
      equations: [],
      checks: [],
    };
    const r = evaluateSheet(doc, t);
    expect(r.warnings.some((w) => w.severity === 'error' && w.location?.startsWith('a'))).toBe(
      true,
    );
    expect(r.nodes).toMatchObject({ state: 'not-evaluated', notes: [NO_ANSWER_NOTE], findings: 0 });
    expect(nodesWarnings(r)).toEqual([]);
  });
});

describe('a selector is held to its table wherever it is read', () => {
  it('on a format-2 sheet that names no wiring', () => {
    const doc = inverter();
    delete doc.levels;
    doc.blocks = doc.blocks!.map(({ nodes: _n, ...b }) => b);
    doc.params = doc.params.map((p) => (p.name === 'p_sign' ? { ...p, value: -1 } : p));
    const r = runSheet(doc, t);
    expect(r.nodes).toBeUndefined();
    expect(
      r.warnings.some(
        (w) => w.severity === 'error' && w.message.includes('"p_sign" is an axis-sign selector'),
      ),
    ).toBe(true);
    expect(r.feasible).toBe(false);
  });

  it("through a parent's override of a child's own selector", () => {
    // The child declares s and multiplies its drain voltage by it; the parent sets s to -1 on an
    // N-style table. Read from the child's embedded value (+1) it would pass.
    // A selector is a key of format version 2: the child says so, and its block wires it.
    const child: SheetDoc = {
      ...leaf('p', { L: '0.5e-6', id: '1e-5', gm_id: '10', vds: 's*(1.8 - 0.9)' }, [['I', 1e-5]]),
      formatVersion: 2,
      params: [param('s', 1, { convention: 'axis-sign' })],
    };
    const doc: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      formatVersion: 2,
      params: [],
      blocks: [block('p', child, { s: '-1' }, { d: 'o', g: 'g', s: 'gnd', b: 'gnd' })],
      ports: ['o', 'g'],
      equations: [],
      checks: [],
    };
    expect(
      evaluateSheet(doc, t).warnings.some((w) =>
        w.message.includes('"s" is an axis-sign selector'),
      ),
    ).toBe(true);
    expect(
      evaluateSheet(
        { ...doc, blocks: [block('p', child, {}, { d: 'o', g: 'g', s: 'gnd', b: 'gnd' })] },
        t,
      ).warnings.some((w) => w.message.includes('axis-sign selector')),
    ).toBe(false);
  });

  it('is read on either side of the product: (E)*p_sign and V_x*p_sign normalize like p_sign*(E)', () => {
    expect(runSheet(inverter({ ldSel: '(VDD - V_out)*p_sign' }), t).nodes!.dof).toMatchObject({
      proven: 2,
      bound: 2,
    });
    const bare = inverter({ ldSel: 'V_d*p_sign' });
    bare.params.push(param('V_d', 0.9));
    // V_d is the drain-source drop itself: the drain loop reads V_out - VDD + V_d, a proven row.
    expect(runSheet(bare, t).nodes!.dof.undecided).toEqual([]);
  });
});

describe('a region beside a diode connection stated by the wires', () => {
  it('is refused, as beside diode: true', () => {
    const doc: SheetDoc = {
      title: 'd',
      polarity: 'n',
      formatVersion: 2,
      params: [param('I', 1e-5)],
      givens: { L: '1e-6', id: 'I', gm_id: '10', region: 'saturation' },
      nodes: { d: 'x', g: 'x', s: 'gnd', b: 'gnd' },
      equations: [],
      checks: [],
    };
    expect(
      validateSheet(doc).some(
        (w) =>
          w.severity === 'error' &&
          w.message.startsWith(
            'the givens declare a region, and the wires put the gate on the drain',
          ),
      ),
    ).toBe(true);
  });
});

describe('which wire a solved param is the level of, and the wires it sits between', () => {
  const demo = generateDemoDevice({ vds: { min: 0, max: 1.8, step: 0.1 } });
  // A p device from the supply down to `x`, its drain-source voltage `VDD - V_x` (a magnitude on
  // the N-style demo table), and an n device from `x` down to ground whose drain-source voltage is
  // `V_x`. `V_y` names the gate wire's level through nothing at all.
  const doc: SheetDoc = {
    title: 'a node between a p and an n device',
    polarity: 'n',
    formatVersion: 2,
    params: [
      { name: 'VDD', value: 1.8, unit: 'V', class: 'independent' },
      { name: 'VB', value: 0.9, unit: 'V', class: 'independent' },
      { name: 'V_x', value: 0.9, unit: 'V', min: 0.1, max: 1.7, solveFor: 'n__vgs' },
      { name: 'V_y', value: 0.5, unit: 'V', min: 0, max: 1, solveFor: 'p__vgs' },
    ],
    equations: [],
    checks: [],
    levels: { vdd: 'VDD', b: 'VB' },
    blocks: [
      {
        name: 'p',
        doc: {
          title: 'p',
          polarity: 'p',
          params: [{ name: 'vd', value: 0.9 }],
          givens: { L: '1e-6', id: '1e-5', gm_id: '10', vds: 'vd' },
          equations: [],
          checks: [],
          provides: ['vgs'],
        },
        params: { vd: 'VDD - V_x' },
        nodes: { d: 'x', g: 'b', s: 'vdd', b: 'vdd' },
      },
      {
        name: 'n',
        doc: {
          title: 'n',
          polarity: 'n',
          params: [{ name: 'vd', value: 0.9 }],
          givens: { L: '1e-6', id: '1e-5', gm_id: '10', vds: 'vd' },
          equations: [],
          checks: [],
          provides: ['vgs'],
        },
        params: { vd: 'V_x' },
        nodes: { d: 'x', g: 'b', s: 'gnd', b: 'gnd' },
      },
    ],
  };

  it("reads the param's wire through a p device's direction, and its neighbours by polarity", () => {
    const read = solvedWiring(doc, () => demo, ['V_x', 'V_y'])!;
    expect(read.wires.get('V_x')).toEqual({
      wires: ['x'],
      below: [{ wire: 'gnd', device: 'n' }],
      above: [{ wire: 'vdd', device: 'p' }],
    });
    // V_y is no wire's level: its relation reads a gate-source voltage the wiring never states as
    // a wire.
    expect(read.wires.has('V_y')).toBe(false);
  });

  it('relates nothing through a device whose direction its table cannot give', () => {
    // A p device on a table whose vgs axis holds both signs: its voltages have no direction, so
    // nothing reached through it, and x is the level of V_x through the n device alone.
    const both = generateDemoDevice({ vgs: { min: -0.5, max: 1.8, step: 0.1 } });
    const read = solvedWiring(doc, (chain) => (chain[0]?.name === 'p' ? both : demo), ['V_x'])!;
    expect(read.wires.get('V_x')?.wires).toEqual(['x']);
    expect(read.forms.get('x')?.length).toBeGreaterThan(0);
  });

  it('reads nothing of a sheet that names no wiring', () => {
    expect(solvedWiring({ ...doc, nodes: 'none', levels: undefined }, () => demo, ['V_x'])).toBe(
      undefined,
    );
  });
});
