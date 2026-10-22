// The DC wiring check across a hierarchy, and the currents it balances: port maps that join a
// child's wiring to its parent's, elements, held wires, the body's direction on a signed table,
// the format a document is refused in, and the loader's round trip. Expected numbers are worked by
// hand beside each test, or are relations between quantities the sizing reports.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice, signedMirrorDemo } from '../demo';
import { makeGrid } from '../grid';
import {
  dcWalk,
  dofOf,
  nodesProblems,
  relation,
  REF,
  RELATION_KINDS,
  type WalkRelation,
  type WalkResult,
} from './nodes';
import { readFileSync } from 'node:fs';
import { EARLIER_FORMAT_NOTE } from './nodes';
import { buildSheetRefIndex } from './resolve';
import { holdHardware } from './coverage';
import { REFS, sheet as librarySheet, table as libraryTable } from './library.fixtures';
import { aggregateConditionRuns, groupDevices, runConditions } from '../corners';
import {
  EXAMPLES,
  NO_ANSWER_NOTE,
  applyWiringProposal,
  evaluateSheet,
  levelEligibility,
  proposeWiring,
  resolvedSheet,
  runSheet,
  structuralDiodes,
  validateSheet,
  withParams,
} from './index';
import type { DeviceTable } from '../types';
import type {
  DeviceNodes,
  SheetBlock,
  SheetDoc,
  SheetGivens,
  SheetResult,
  SheetVar,
} from './types';

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
  extra: Partial<SheetBlock> = {},
): SheetBlock => ({
  name,
  doc,
  params,
  ...(nodes ? { nodes } : {}),
  ...extra,
});
const wiring = (r: { warnings: { rule: string; severity: string; message: string }[] }) =>
  r.warnings.filter((w) => w.rule === 'sheet-nodes');
const idOf = (r: SheetResult, path: string[]): number => {
  let at: { blocks?: SheetResult['blocks']; sizing?: SheetResult['sizing'] } = r;
  for (const name of path) at = at.blocks!.find((b) => b.name === name)!;
  return at.sizing!.id;
};

/** A table with one more axis read back to front and negated — a signed export's convention. */
function negateAxis(dev: DeviceTable, name: string): DeviceTable {
  const axes = dev.grid.axes.map((a) =>
    a.name === name
      ? { name, values: new Float64Array([...a.values].map((v) => -v).reverse()) }
      : a,
  );
  const dim = dev.grid.axes.findIndex((a) => a.name === name);
  const shape = dev.grid.shape;
  const stride = shape.slice(dim + 1).reduce((a, b) => a * b, 1);
  const n = shape[dim];
  const quantities = new Map<string, Float64Array>();
  for (const [k, col] of dev.grid.quantities) {
    if (dev.grid.axes.some((a) => a.name === k)) continue;
    const out = new Float64Array(col.length);
    for (let flat = 0; flat < col.length; flat++) {
      const i = Math.floor(flat / stride) % n;
      out[flat] = col[flat + (n - 1 - 2 * i) * stride];
    }
    quantities.set(k, out);
  }
  return { ...dev, grid: makeGrid(axes, quantities) };
}

describe("the body relation takes its direction from the table's own vsb axis", () => {
  /** A p cascode with its source on wire b (held at V_b), its body on vdd, its drain on out — every
   *  wire held, so the walk closes exactly when each relation has the right sign. */
  const pcasc = (sp: number, vsb: string): SheetDoc => ({
    title: 'p cascode',
    polarity: 'n',
    formatVersion: 2,
    params: [
      vparam('VDD', 1.8),
      vparam('V_b', 1.4),
      vparam('V_out', 0.9),
      param('sp', sp, { convention: 'axis-sign' }),
    ],
    blocks: [
      block(
        'c',
        leaf('p', { L: '0.5e-6', id: '10e-6', gm_id: '10', vds: 'vd', vsb: 'vs' }, [
          ['vd', -0.5],
          ['vs', 0.4],
        ]),
        { vd: 'sp*(V_b - V_out)', vs: vsb },
        { d: 'out', g: 'g', s: 'b', b: 'vdd' },
        { device: 'p' },
      ),
    ],
    levels: { vdd: 'VDD', b: 'V_b', out: 'V_out' },
    ports: ['g'],
    equations: [],
    checks: [],
  });
  const on = (p: DeviceTable) => (id: string) => (id === 'p' ? p : undefined);

  it('closes a p device on a signed table whose vsb axis is a magnitude (vgs, vds negative, vsb positive)', () => {
    // V(vdd) - V(b) = +vsb = VDD - V_b = 0.4 V: the body above the source. Read with the vgs axis's
    // sign it was -0.4 V, an 0.8 V miss.
    const signed = signedMirrorDemo(t);
    expect(Math.min(...signed.grid.axes.find((a) => a.name === 'vsb')!.values)).toBe(0);
    const r = runSheet(pcasc(-1, 'VDD - V_b'), t, on(signed));
    expect(r.blocks![0].terminals!.bodyAxis).toBe(1);
    expect(r.nodes!.disputes).toEqual([]);
    expect(r.nodes!.dof).toMatchObject({ proven: 0, bound: 0 });
  });

  it('closes the same device on an N-style table and on one whose vsb axis is signed too', () => {
    expect(runSheet(pcasc(1, 'VDD - V_b'), t, on(t)).nodes!.disputes).toEqual([]);
    // A vsb axis holding negative values follows the vgs one: vsb = sp*(VDD - V_b) = -0.4 V, and
    // V(vdd) - V(b) = -vsb.
    const allSigned = negateAxis(signedMirrorDemo(t), 'vsb');
    const r = runSheet(pcasc(-1, 'sp*(VDD - V_b)'), t, on(allSigned));
    expect(r.blocks![0].terminals!.bodyAxis).toBe(-1);
    expect(r.nodes!.disputes).toEqual([]);
  });

  it('reports the miss when the body voltage disagrees with the held wires', () => {
    // vsb stated 0.1 V short of VDD - V_b: one loop misses by 0.1 V.
    const r = runSheet(pcasc(-1, 'VDD - V_b - 0.1'), t, on(signedMirrorDemo(t)));
    expect(r.nodes!.closureError).toBeCloseTo(0.1, 9);
  });
});

/** A child that wires its own n current sink: drain on its port o, gate on its port bias, source
 *  and body on its port sx. */
const sink: SheetDoc = {
  ...leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
    ['I', 10e-6],
    ['vd', 0.9],
  ]),
  formatVersion: 2,
  nodes: { d: 'o', g: 'bias', s: 'sx', b: 'sx' },
  ports: ['o', 'bias', 'sx'],
};
/** A parent: an n device and a p device carrying twice its current on `out`, and the sink child
 *  carrying the n device's current on `out` too, joined through its ports. */
const withSink = (
  ports: Record<string, string | null> | undefined,
  extra: Partial<SheetBlock> = {},
): SheetDoc => ({
  title: 'parent',
  polarity: 'n',
  formatVersion: 2,
  params: [vparam('VDD', 1.8), vparam('V_out', 0.9)],
  blocks: [
    block(
      'a',
      leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
        ['I', 10e-6],
        ['vd', 0.9],
      ]),
      { vd: 'V_out' },
      { d: 'out', g: 'ga', s: 'gnd', b: 'gnd' },
    ),
    block(
      'p',
      leaf('p', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
        ['I', 20e-6],
        ['vd', 0.9],
      ]),
      { I: '2*a__id', vd: 'VDD - V_out' },
      { d: 'out', g: 'gp', s: 'vdd', b: 'vdd' },
    ),
    {
      name: 'k',
      doc: sink,
      params: { I: 'a__id', vd: 'V_out' },
      ...(ports ? { ports } : {}),
      ...extra,
    },
  ],
  levels: { vdd: 'VDD' },
  ports: ['gp'],
  equations: [],
  checks: [],
});

describe("a child that wires itself joins its parent's walk through its ports", () => {
  it("balances the parent's wire through the port map and reads the child's device", () => {
    // On out: a draws I, p returns 2I, k (through its port o) draws I — zero.
    const r = runSheet(withSink({ o: 'out', bias: 'ga', sx: 'gnd' }), t);
    const out = r.nodes!.balance.find((b) => b.wire === 'out')!;
    expect(out.branches.map((b) => b.terminal)).toEqual(['a.d', 'k.d', 'p.d']);
    expect(out.residual).toBeCloseTo(0, 18);
    expect(wiring(r)).toEqual([]);
    expect(r.nodes!.state).toBe('checked-clean');
    // The child runs no walk of its own: the parent's covers it, its gate on ga beside a's.
    const k = r.blocks!.find((b) => b.name === 'k')!;
    expect(k.nodes).toBeUndefined();
    expect(k.terminals).toBeDefined();
    expect(r.nodes!.levels.ga.level).toBeCloseTo(r.blocks![0].sizing!.vgs, 12);
  });

  it("flattens a port left open to the child's own wire, never reported as floating", () => {
    // bias mapped to null: the child's gate sits on k__bias, one gate, a declared port.
    const r = runSheet(withSink({ o: 'out', bias: null, sx: 'gnd' }), t);
    expect(r.nodes!.levels.k__bias).toBeDefined();
    expect(wiring(r).some((w) => w.message.includes('float'))).toBe(false);
  });

  it('refuses a child that wires itself and declares ports when the block maps none, and a block with both maps', () => {
    const unmapped = nodesProblems(withSink(undefined));
    expect(
      unmapped.some(
        (w) =>
          w.severity === 'error' &&
          w.message.startsWith(
            'block "k": the child wires itself and declares ports "o", "bias", "sx"',
          ),
      ),
    ).toBe(true);
    const both = nodesProblems(
      withSink(
        { o: 'out', bias: 'ga', sx: 'gnd' },
        { nodes: { d: 'out', g: 'ga', s: 'gnd', b: 'gnd' } },
      ),
    );
    expect(both.some((w) => w.message.startsWith('block "k": carries both nodes and ports'))).toBe(
      true,
    );
  });

  it('composes the stage-2 current-source load by reference, through its ports, end to end', () => {
    // The load is the library's shape: a mirror output, given its width and its gate-source
    // voltage (a composing amplifier passes a bias reference's width times the ratio, and that
    // reference's vgs), its current read off the table and provided. It wires its own device and
    // holds its drain at vx; the parent maps its ports onto out2 and vb2, holds out2 at V_out2,
    // overrides vx with V_out2, and gives the p stage the load's current. Two statements hold out2
    // at one level — one loop, an identity once the override is read — and out2's currents
    // balance: the load sets the current, and the p stage, carrying ld2__id, returns it.
    const load: SheetDoc = {
      title: 'Stage-2 current-source load',
      polarity: 'n',
      formatVersion: 2,
      params: [
        param('Wx', 3e-6),
        param('vgsx', 0.61, { unit: 'V', class: 'independent' }),
        param('Lx', 0.5e-6),
        param('vx', 0.9, { unit: 'V', class: 'independent' }),
      ],
      givens: { L: 'Lx', W: 'Wx', vgs: 'vgsx', vds: 'vx' },
      nodes: { d: 'out', g: 'vb', s: 'gnd', b: 'gnd' },
      levels: { out: 'vx' },
      ports: ['out', 'vb'],
      equations: [],
      checks: [],
      provides: ['id', 'gds', 'vdsat'],
    };
    const amp: SheetDoc = {
      title: 'two-stage output',
      polarity: 'n',
      formatVersion: 2,
      params: [vparam('VDD', 1.8), vparam('V_out2', 0.9), param('W_ld', 6e-6), vparam('V_bn', 0.6)],
      blocks: [
        {
          name: 'ld2',
          ref: 'multistage/stage2-current-source-load',
          params: { Wx: 'W_ld', vgsx: 'V_bn', vx: 'V_out2' },
          ports: { out: 'out2', vb: 'vb2' },
        },
        block(
          's2',
          leaf('p', { L: '0.5e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 60e-6],
            ['vd', 0.9],
          ]),
          { I: 'ld2__id', vd: 'VDD - V_out2' },
          { d: 'out2', g: 'g2', s: 'vdd', b: 'vdd' },
        ),
      ],
      levels: { vdd: 'VDD', out2: 'V_out2' },
      ports: ['g2', 'vb2'],
      equations: [],
      checks: [],
    };
    const refs = buildSheetRefIndex([{ path: 'multistage/stage2-current-source-load', doc: load }]);
    const r = runSheet(amp, t, undefined, refs);
    expect(r.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(r.nodes!.state).toBe('checked-clean');
    const out2 = r.nodes!.balance.find((b) => b.wire === 'out2')!;
    expect(out2).toMatchObject({ held: true });
    expect(out2.branches.map((b) => b.terminal)).toEqual(['ld2.d', 's2.d']);
    expect(out2.residual).toBeCloseTo(0, 18);
    expect(r.nodes!.dof).toMatchObject({ proven: 0 });
    // The load's gate wire, a port of the parent, is derived from the load's own vgs.
    expect(r.nodes!.levels.vb2.level).toBeCloseTo(r.blocks![0].sizing!.vgs, 12);
  });

  it('keeps three child levels mapped onto one wire as three relations, one verdict in every order', () => {
    // Children p, q, r each hold their port o — at 0, 1 and 2 — and the parent maps every o onto x.
    // Three anchors on x, keyed by the sheet that states each: x is held at p's 0 (the first key);
    // the chords read 0 - 0 + 1 and 0 - 0 + 2.
    const child = (level: string): SheetDoc => ({
      title: 'level',
      polarity: 'n',
      formatVersion: 2,
      params: [],
      equations: [],
      checks: [],
      levels: { o: level },
      ports: ['o'],
    });
    const kids: SheetBlock[] = [
      { name: 'p', doc: child('0'), ports: { o: 'x' } },
      { name: 'q', doc: child('1'), ports: { o: 'x' } },
      { name: 'r', doc: child('2'), ports: { o: 'x' } },
    ];
    const order = (blocks: SheetBlock[]): SheetDoc => ({
      title: 'three',
      polarity: 'n',
      formatVersion: 2,
      params: [],
      blocks,
      equations: [],
      checks: [],
    });
    const verdicts = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((ix) => evaluateSheet(order(ix.map((i) => kids[i]))).nodes!);
    expect(verdicts[0].disputes[0].chords).toEqual([
      { relation: 'q.levels.o', residual: 1 },
      { relation: 'r.levels.o', residual: 2 },
    ]);
    expect(verdicts[0].levels.x).toEqual({ level: 0, seed: true, via: [] });
    for (const v of verdicts) expect(v).toEqual(verdicts[0]);
  });
});

describe('elements', () => {
  /** Held a at 1 V; a voltage element puts b 0.25 V above it; b optionally held as well. */
  const vdoc = (bHeld?: string): SheetDoc => ({
    title: 'V',
    polarity: 'n',
    formatVersion: 2,
    params: [],
    elements: [{ name: 'Vb', kind: 'V', between: ['b', 'a'], value: 0.25 }],
    levels: { a: '1', ...(bHeld ? { b: bHeld } : {}) },
    equations: [],
    checks: [],
  });

  it('reads a voltage element as a relation: V(from) - V(to) = value', () => {
    const r = evaluateSheet(vdoc());
    expect(r.nodes!.levels.b).toEqual({ level: 1.25, seed: false, via: ['Vb'] });
    // b held at 1.3 V: from a, ref sits at -1 and b at 0.25; the chord (ref, b) reads
    // -1 - 0.25 + 1.3 = 0.05 V.
    const off = evaluateSheet(vdoc('1.3'));
    expect(off.nodes!.disputes[0].chords).toEqual([
      { relation: 'levels.b', residual: expect.closeTo(0.05, 12) },
    ]);
  });

  /** A diode on bias_d fed — or not — by an ideal source from the held supply: the shape a
   *  programmed reference current is drawn in. */
  const reference = (drawn: boolean): SheetDoc => ({
    title: 'reference',
    polarity: 'n',
    formatVersion: 2,
    params: [vparam('VDD', 1.8), param('I_tail', 20e-6, { unit: 'A', class: 'independent' })],
    blocks: [
      block(
        'bias',
        leaf('n', { L: '1e-6', id: 'I', gm_id: '10', diode: true }, [['I', 20e-6]]),
        { I: 'I_tail' },
        { d: 'bias_d', g: 'bias_d', s: 'gnd', b: 'gnd' },
      ),
    ],
    ...(drawn
      ? {
          elements: [
            {
              name: 'Iref',
              kind: 'I' as const,
              between: ['vdd', 'bias_d'] as [string, string],
              value: 'I_tail',
            },
          ],
        }
      : {}),
    levels: { vdd: 'VDD' },
    equations: [],
    checks: [],
  });

  it('counts a current element by its direction: from `from` to `to` inside it, so the diode balances', () => {
    // On bias_d: the diode's drain draws I_tail, the element delivers I_tail: zero. On vdd the
    // element takes I_tail out of the held supply — a rail, reported and not raised.
    const r = runSheet(reference(true), t);
    const d = r.nodes!.balance.find((b) => b.wire === 'bias_d')!;
    expect(d.branches).toEqual([
      { terminal: 'Iref', current: 20e-6 },
      { terminal: 'bias.d', current: -idOf(r, ['bias']) },
    ]);
    expect(d.residual).toBeCloseTo(0, 18);
    expect(r.nodes!.balance.find((b) => b.wire === 'vdd')).toMatchObject({
      held: true,
      residual: -20e-6,
    });
    expect(wiring(r)).toEqual([]);
  });

  it("reports the programmed current as missing when nothing draws it: one terminal's residual is its whole current", () => {
    const r = runSheet(reference(false), t);
    const d = r.nodes!.balance.find((b) => b.wire === 'bias_d')!;
    expect(d.residual).toBeCloseTo(-idOf(r, ['bias']), 18);
    expect(
      wiring(r).some((w) => w.message.startsWith('the currents at wire "bias_d" do not balance')),
    ).toBe(true);
  });

  /** A common-source stage: its input a port, its drain on out, a resistor load from the held
   *  supply. */
  const csStage = (R: string, out: 'derived' | 'floating'): SheetDoc => ({
    title: 'cs',
    polarity: 'n',
    formatVersion: 2,
    params: [
      vparam('VDD', 1.8),
      vparam('V_out', 0.9),
      vparam('V_in', 0.7),
      param('R', 1, { class: 'independent' }),
    ],
    blocks: [
      block(
        'm',
        leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
          ['I', 20e-6],
          ['vd', 0.9],
        ]),
        { vd: 'V_out' },
        out === 'derived'
          ? { d: 'out', g: 'in', s: 'gnd', b: 'gnd' }
          : { d: 'out', g: 'in', s: 'sx', b: 'sx' },
      ),
    ],
    elements: [
      { name: 'RL', kind: 'R', between: ['vdd', 'out'], value: R },
      { name: 'Cl', kind: 'C', between: ['out', 'gnd'], value: 1e-12 },
    ],
    levels: { vdd: 'VDD' },
    ports: out === 'floating' ? ['in', 'sx'] : ['in'],
    equations: [],
    checks: [],
  });

  it("counts a resistor through its ends' levels, and a capacitor as nothing at DC", () => {
    // out sits at V_out = 0.9 V (the device's vds over ground), so RL carries (1.8 - 0.9)/R into
    // out. With R = 0.9/I the device's drain current is exactly what the resistor delivers.
    const base = runSheet(csStage('45000', 'derived'), t);
    const I = idOf(base, ['m']);
    const r = runSheet(csStage(String(0.9 / I), 'derived'), t);
    const out = r.nodes!.balance.find((b) => b.wire === 'out')!;
    expect(out.branches.map((b) => b.terminal)).toEqual(['RL', 'm.d']);
    expect(out.residual).toBeCloseTo(0, 15);
    expect(wiring(r)).toEqual([]);
  });

  it('leaves a resistor wire unbalanced, with a note, when an end has no trusted level', () => {
    // The device's source on a port: out is not reachable from a held wire, so the resistor's
    // current is unknown.
    const r = runSheet(csStage('45000', 'floating'), t);
    expect(r.nodes!.balance.find((b) => b.wire === 'out')).toBeUndefined();
    expect(r.nodes!.notes).toContain(
      'Wire "out" is not balanced: resistor RL has an end with no trusted level, so its current is unknown.',
    );
  });

  it('reports what a voltage element supplies at its wire, and never raises it', () => {
    // A device's drain on a wire a voltage element sets above ground: the element takes the current.
    const doc: SheetDoc = {
      title: 'vsrc',
      polarity: 'n',
      formatVersion: 2,
      params: [vparam('V_in', 0.7)],
      blocks: [
        block(
          'm',
          leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 20e-6],
            ['vd', 0.9],
          ]),
          { vd: '0.9' },
          { d: 'o', g: 'in', s: 'gnd', b: 'gnd' },
        ),
      ],
      elements: [{ name: 'Vo', kind: 'V', between: ['o', 'gnd'], value: 0.9 }],
      ports: ['in'],
      equations: [],
      checks: [],
    };
    const r = runSheet(doc, t);
    expect(r.nodes!.balance.find((b) => b.wire === 'o')).toMatchObject({ held: true });
    expect(wiring(r)).toEqual([]);
  });
});

describe('the current balance at held wires and lone terminals', () => {
  /** One drawn input device on a tail device that carries twice its current. */
  const half = (levels: Record<string, string>): SheetDoc => ({
    title: 'half',
    polarity: 'n',
    formatVersion: 2,
    params: [
      vparam('V_cm', 0.9),
      vparam('V_o', 1.3),
      param('vgs_cm', 0.5, { solveFor: 'm__vgs', min: 0.2, max: 1.5 }),
    ],
    blocks: [
      block(
        'm',
        leaf('n', { L: '1e-6', id: 'I', gm_id: '12', vds: 'vd', vsb: 'vs' }, [
          ['I', 10e-6],
          ['vd', 0.6],
          ['vs', 0.4],
        ]),
        { vd: 'V_o - V_cm + vgs_cm', vs: 'V_cm - vgs_cm' },
        { d: 'o1', g: 'i', s: 't', b: 'gnd' },
      ),
      block(
        'tail',
        leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
          ['I', 20e-6],
          ['vd', 0.4],
        ]),
        { I: '2*m__id', vd: 'V_cm - vgs_cm' },
        { d: 't', g: 'vb', s: 'gnd', b: 'gnd' },
      ),
    ],
    levels: { i: 'V_cm', o1: 'V_o', ...levels },
    ports: ['vb'],
    equations: [],
    checks: [],
  });

  it('keeps the balance at a held wire: holding the tail does not hide the half the tail delivers', () => {
    // At t: m returns I, tail draws 2I; the source holding t supplies 2I - I = I.
    const free = runSheet(half({}), t);
    const level = free.nodes!.levels.t.level;
    const r = runSheet(half({ t: String(level) }), t);
    expect(idOf(r, ['m'])).toBeCloseTo(1e-5, 15);
    expect(r.nodes!.balance.find((b) => b.wire === 't')).toMatchObject({ held: true });
    const raised = wiring(r).find((w) => w.message.startsWith('wire "t" is held'))!;
    // Currents read with an SI prefix: I = 10 µA.
    expect(raised.message).toContain('an ideal source supplies 10 µA (m.s 10 µA, tail.d -20 µA;');
    expect(r.nodes!.state).toBe('checked-with-findings');
  });

  it('raises nothing at a rail, where every current flows the same way', () => {
    const r = runSheet(half({}), t);
    expect(r.nodes!.balance.find((b) => b.wire === 'gnd')).toMatchObject({ held: true });
    expect(wiring(r).some((w) => w.message.startsWith('wire "gnd" is held'))).toBe(false);
  });

  it('balances a wire one source terminal sits on: its whole current has nowhere to go', () => {
    // One drawn input device, body on its own source, no tail device: t carries m's current alone.
    const lone: SheetDoc = {
      title: 'lone',
      polarity: 'n',
      formatVersion: 2,
      params: [
        vparam('V_cm', 0.9),
        vparam('V_o', 1.3),
        param('vgs_cm', 0.5, { solveFor: 'm__vgs', min: 0.2, max: 1.5 }),
      ],
      blocks: [
        block(
          'm',
          leaf('n', { L: '1e-6', id: 'I', gm_id: '12', vds: 'vd' }, [
            ['I', 10e-6],
            ['vd', 0.6],
          ]),
          { vd: 'V_o - V_cm + vgs_cm' },
          { d: 'o1', g: 'i', s: 't', b: 't' },
        ),
      ],
      levels: { i: 'V_cm', o1: 'V_o' },
      equations: [],
      checks: [],
    };
    const r = runSheet(lone, t);
    expect(r.nodes!.balance.find((b) => b.wire === 't')!.residual).toBeCloseTo(idOf(r, ['m']), 18);
    expect(
      wiring(r).some((w) => w.message.startsWith('the currents at wire "t" do not balance')),
    ).toBe(true);
  });
});

describe("the held gate is held on its device's gate wire only", () => {
  const casc = (levels: Record<string, string>, nodes: DeviceNodes): SheetDoc => ({
    title: 'casc',
    polarity: 'n',
    formatVersion: 2,
    params: [
      vparam('VDD', 1.8),
      vparam('V_out', 1.2),
      param('V_a', 0.5, { unit: 'V', hold: 'V_a + casc__vgs', min: 0.2, max: 1 }),
    ],
    blocks: [
      block(
        'in',
        leaf('n', { L: '1e-6', id: 'I', gm_id: '12', vds: 'vd' }, [
          ['I', 20e-6],
          ['vd', 0.5],
        ]),
        { vd: 'V_a' },
        { d: 'x', g: 'vin', s: 'gnd', b: 'gnd' },
      ),
      block(
        'casc',
        leaf('n', { L: '1e-6', id: 'I', gm_id: '12', vds: 'vd', vsb: 'vs' }, [
          ['I', 20e-6],
          ['vd', 0.7],
          ['vs', 0.5],
        ]),
        { vd: 'V_out - V_a', vs: 'V_a' },
        nodes,
      ),
    ],
    levels,
    ports: ['out', 'vin', 'vbn'],
    equations: [],
    checks: [],
  });
  const refused = (d: SheetDoc): string[] =>
    validateSheet(d)
      .filter((w) => w.severity === 'error' && w.message.includes('may hold only'))
      .map((w) => w.message);

  it('admits the hold expression on the gate wire, and refuses it on the node under the gate', () => {
    expect(
      refused(casc({ vbn: 'V_a + casc__vgs' }, { d: 'out', g: 'vbn', s: 'x', b: 'gnd' })),
    ).toEqual([]);
    expect(refused(casc({ x: 'V_a + casc__vgs' }, { d: 'out', g: 'vbn', s: 'x', b: 'x' }))).toEqual(
      [
        'levels "x": "V_a + casc__vgs" is the gate voltage the hold on V_a keeps fixed for "casc", so it ' +
          'may hold only that device\'s gate wire — "casc" has its gate on "vbn"',
      ],
    );
  });

  it("admits it on every placement's gate wire of a device placed twice", () => {
    // A pair placed twice on a tail node V_s that a hold re-solves under the gates: both gate wires
    // may be held at V_s + in__vgs; the tail wire may not.
    const pairDoc = (levels: Record<string, string>): SheetDoc => ({
      title: 'pair',
      polarity: 'n',
      formatVersion: 2,
      params: [
        vparam('V_o', 1.3),
        param('V_s', 0.4, { unit: 'V', hold: 'V_s + in__vgs', min: 0.1, max: 0.9 }),
      ],
      blocks: [
        block(
          'in',
          leaf('n', { L: '1e-6', id: 'I', gm_id: '12', vds: 'vd', vsb: 'vs' }, [
            ['I', 10e-6],
            ['vd', 0.9],
            ['vs', 0.4],
          ]),
          { vd: 'V_o - V_s', vs: 'V_s' },
          [
            { d: 'o1', g: 'vinp', s: 't', b: 'gnd' },
            { d: 'o2', g: 'vinn', s: 't', b: 'gnd' },
          ],
        ),
      ],
      levels: { o1: 'V_o', o2: 'V_o', ...levels },
      ports: ['t'],
      equations: [],
      checks: [],
    });
    expect(refused(pairDoc({ vinp: 'V_s + in__vgs', vinn: 'V_s + in__vgs' }))).toEqual([]);
    const r = runSheet(pairDoc({ vinp: 'V_s + in__vgs', vinn: 'V_s + in__vgs' }), t);
    expect(r.nodes!.placements).toEqual([{ device: 'in', shared: true }]);
    expect(refused(pairDoc({ t: 'V_s + in__vgs' }))).toEqual([
      'levels "t": "V_s + in__vgs" is the gate voltage the hold on V_s keeps fixed for "in", so it may ' +
        'hold only that device\'s gate wires — "in" has its gates on "vinp", "vinn"',
    ]);
  });

  it('admits nothing for a hold that balances currents', () => {
    const doc: SheetDoc = {
      title: 'bal',
      polarity: 'n',
      formatVersion: 2,
      params: [param('I_bias', 20e-6, { hold: 'I_bias - p__id', min: 1e-6, max: 1e-4 })],
      blocks: [
        block(
          'p',
          leaf('p', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 20e-6],
            ['vd', 0.9],
          ]),
          {},
        ),
      ],
      equations: [],
      checks: [],
    };
    expect(levelEligibility(doc, '', 'I_bias - p__id').kind).toBe('refused');
  });
});

describe('a wire only gates touch', () => {
  it('is a warning: nothing on the sheet sets its level', () => {
    const doc: SheetDoc = {
      title: 'nobias',
      polarity: 'n',
      formatVersion: 2,
      params: [vparam('V_o', 0.9)],
      blocks: [
        block(
          'a',
          leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 10e-6],
            ['vd', 0.9],
          ]),
          { vd: 'V_o' },
          { d: 'o1', g: 'vb', s: 'gnd', b: 'gnd' },
        ),
        block(
          'b',
          leaf('n', { L: '1e-6', W: 'w', vgs: 'vg', vds: 'vd' }, [
            ['w', 1e-6],
            ['vg', 0.6],
            ['vd', 0.9],
          ]),
          { w: 'a__W', vg: 'a__vgs', vd: 'V_o' },
          { d: 'o2', g: 'vb', s: 'gnd', b: 'gnd' },
        ),
      ],
      levels: { o1: 'V_o', o2: 'V_o' },
      equations: [],
      checks: [],
    };
    expect(nodesProblems(doc).map((w) => `${w.severity}: ${w.message}`)).toContain(
      'warning: wire "vb" is touched only by gates (block "a" g, block "b" g), so nothing on the sheet ' +
        'sets its level — hold it in levels, make it a port, or wire the device that drives it',
    );
    expect(
      nodesProblems({ ...doc, ports: ['vb'] }).some((w) =>
        w.message.includes('touched only by gates'),
      ),
    ).toBe(false);
  });
});

describe("the walk's edges", () => {
  const sym = (o: Record<string, number> = {}): Map<string, number> => new Map(Object.entries(o));
  const tie = (from: string, to: string, value: number, name: string): WalkRelation =>
    relation(from, to, value, sym(), {
      kind: RELATION_KINDS.element,
      inst: '',
      tie: name,
      label: name,
    });
  const held = (w: string, level: number): WalkRelation =>
    relation(w, REF, level, sym(), {
      kind: RELATION_KINDS.anchor,
      inst: '',
      tie: w,
      label: `levels.${w}`,
    });

  it("grows a block's tree from its first held wire, not from the wire it was entered through", () => {
    // a is held alone on a bridge; c and d, held, close the loop ref-c-x-y-d-ref. The block is
    // entered through ref, but its tree grows from c: ref and x, then d (through its level) and y;
    // the relation (d, y) is the chord. From ref it would have been (x, y).
    const w = dcWalk(
      [
        held('a', 0),
        held('c', 1),
        held('d', 2),
        tie('c', 'x', 0.5, 'cx'),
        tie('x', 'y', 0.5, 'xy'),
        tie('d', 'y', 0, 'dy'),
      ],
      new Map([
        ['a', 0],
        ['c', 1],
        ['d', 2],
      ]),
    );
    const loop = w.blocks.find((b) => b.wires.includes('x'))!;
    // The tree's root is the one wire of the block with no parent in it.
    expect(loop.wires.filter((x) => !loop.parent.has(x))).toEqual(['c']);
    expect(loop.chords.map((c) => c.rel.label)).toEqual(['dy']);
  });

  it('closes a loop within the 10 mV tolerance and opens one past it', () => {
    const at = (miss: number) =>
      dcWalk(
        [held('x', 0), tie('x', 'y', 0, 'E1'), tie('x', 'y', miss, 'E2')],
        new Map([['x', 0]]),
      ).blocks.find((b) => b.wires.includes('y'))!.consistent;
    expect(at(0.0095)).toBe(true);
    expect(at(0.0105)).toBe(false);
  });

  it('counts a linear row before rows with an unreadable term: PROVEN 1, not 0', () => {
    // O1 = x + ~a, O2 = y + ~a, P = x - y. Taken in that order the two opaque rows span P and
    // nothing is proven; the linear row first is proven, and only one opaque row survives it.
    const chord = (row: Record<string, number>) => ({
      rel: tie('p', 'q', 0, 'r'),
      residual: 0,
      row: sym(row),
      cycle: [],
    });
    const walk = {
      blocks: [
        { chords: [chord({ x: 1, '~a': 1 }), chord({ y: 1, '~a': 1 }), chord({ x: 1, y: -1 })] },
      ],
    } as unknown as WalkResult;
    expect(dofOf(walk)).toMatchObject({ proven: 1, bound: 2 });
  });
});

describe('the format a document is refused in', () => {
  const v3 = {
    title: 'future',
    polarity: 'n',
    formatVersion: 3,
    params: [],
    equations: [],
    checks: [],
    givens: { L: '1e-6', id: '1e-5', gm_id: '10', vds: '0.6', diode: true },
    wires3: { x: 1 },
  } as unknown as SheetDoc;

  it('is opened with that reason and not evaluated, with no other finding', () => {
    const r = runSheet(v3, t);
    expect(r.values).toEqual({});
    expect(r.feasible).toBe(false);
    expect(r.warnings.map((w) => w.rule)).toEqual(['sheet-format']);
    expect(validateSheet(v3).map((w) => w.message)).toEqual([r.warnings[0].message]);
    expect(evaluateSheet(v3, t).values).toEqual({});
  });

  it('stops a composed child in that format at its block', () => {
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'f', doc: v3 }],
    };
    const r = evaluateSheet(parent, t);
    expect(
      r.warnings.some((w) =>
        w.message.startsWith('block "f": format version 3 is not one this app reads'),
      ),
    ).toBe(true);
  });
});

describe('a point with no answer is not walked', () => {
  // One device with its drain on a held wire. Moved past the table's drain axis (1.8 V), the
  // device is read at the axis end, a point that is not the one asked about: no answer, so the
  // walk does not read it. An end whose setting does not evaluate has no run at all.
  const doc: SheetDoc = {
    title: 'off the table',
    polarity: 'n',
    formatVersion: 2,
    params: [param('I', 1e-5), vparam('V_out', 0.9), vparam('V_far', 2.5)],
    givens: { L: '1e-6', id: 'I', gm_id: '10', vds: 'V_out' },
    nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
    levels: { out: 'V_out' },
    ports: ['in'],
    equations: [],
    checks: [],
    operatingRange: [
      { name: 'far', set: { V_out: 'V_far' } },
      { name: 'unset', set: { V_out: 'V_far/0' } },
    ],
  };

  it('reports a range end with no answer as not evaluated, with no wiring finding', () => {
    const r = runSheet(doc, t);
    expect(r.nodes?.state).toBe('checked-clean');
    const [far, unset] = r.rangeEnds!;
    for (const e of [far, unset]) {
      expect(e.state).toBe('no-answer');
      expect(e.nodes).toMatchObject({ state: 'not-evaluated', notes: [NO_ANSWER_NOTE] });
      expect(wiring(e)).toEqual([]);
    }
  });

  it('walks a held design asked about elsewhere only where heldOutcome has an answer', () => {
    const base = evaluateSheet(doc, t);
    const far = withParams(holdHardware({ ...doc, operatingRange: [] }, base).doc, { V_out: 2.5 });
    const asHeld = evaluateSheet(far, t, undefined, { held: true });
    expect(asHeld.nodes?.state).toBe('not-evaluated');
    expect(wiring(asHeld)).toEqual([]);
    expect(asHeld.nodes?.levels).toEqual({});
    // Read as a sized run it completes (a clamp is a warning), so it is walked.
    const asSized = evaluateSheet(far, t);
    expect(asSized.nodes?.state).toBe('checked-clean');
    expect(Object.keys(asSized.nodes!.levels).sort()).toEqual(['gnd', 'in', 'out']);
  });

  it('reports a sized run that did not stand as not evaluated', () => {
    const r = evaluateSheet({ ...doc, givens: { ...doc.givens!, gm_id: '1e3' } }, t);
    expect(r.warnings.some((w) => w.severity === 'error')).toBe(true);
    expect(r.nodes?.state).toBe('not-evaluated');
    expect(wiring(r)).toEqual([]);
  });

  it('leaves the library ends that have no answer unwalked: the current-mirror OTA at cm-hi', () => {
    const r = runSheet(librarySheet('otas/current-mirror-ota.json'), libraryTable, undefined, REFS);
    const hi = r.rangeEnds!.find((e) => e.name === 'cm-hi')!;
    expect(hi.state).toBe('no-answer');
    expect(hi.nodes?.state).toBe('not-evaluated');
    expect(wiring(hi)).toEqual([]);
  });
});

describe('the loader: restore, save, reload', () => {
  type Loader = (v: unknown, depth?: number, lost?: string[]) => SheetDoc | undefined;
  // The web app's loader, read from outside the core's sources by a path the compiler does not
  // follow.
  const loader = async (): Promise<Loader> => {
    const at = '../../web/src/dashboard';
    return ((await import(/* @vite-ignore */ at)) as { sanitizeSheet: Loader }).sanitizeSheet;
  };
  const stored = {
    title: 'x',
    polarity: 'n',
    formatVersion: 2,
    params: [
      { name: 'p_sign', value: 1, convention: 'axis-sign' },
      { name: 'VDD', value: 1.8, class: 'independent' },
    ],
    givens: { L: '1e-6', id: '1e-5', gm_id: '10', vds: 'p_sign*(VDD - 0.9)' },
    nodes: { d: 'o', g: 'o', s: 'gnd', b: 'gnd' },
    levels: { o: 'VDD' },
    ports: ['o'],
    elements: [{ name: 'R1', kind: 'R', between: ['o', 'gnd'], value: 1e3 }],
    analyses: [{ name: 'G', kind: 'gain', in: { o: 1 }, out: { o: 1 }, at: 1e3 }],
    blocks: [
      {
        name: 'b',
        doc: {
          title: 'c',
          polarity: 'n',
          formatVersion: 2,
          params: [],
          equations: [],
          checks: [],
          ports: ['a'],
        },
        ports: { a: null },
      },
    ],
    equations: [],
    checks: [],
  };

  it('keeps every format-2 key and the selector marker through restore, save and reload', async () => {
    const sanitize = await loader();
    const lost: string[] = [];
    const restored = sanitize(JSON.parse(JSON.stringify(stored)), 0, lost);
    expect(lost).toEqual([]);
    const reloaded = sanitize(JSON.parse(JSON.stringify(restored)), 0, []);
    expect(reloaded).toEqual(restored);
    for (const k of ['formatVersion', 'nodes', 'levels', 'ports', 'elements', 'analyses'] as const)
      expect(reloaded?.[k], k).toEqual(stored[k]);
    expect(reloaded?.params[0]).toEqual({ name: 'p_sign', value: 1, convention: 'axis-sign' });
    expect(reloaded?.blocks?.[0].ports).toEqual({ a: null });
  });

  it("keeps an earlier block's gate wiring as stored, so validation names the migration it needs", async () => {
    const sanitize = await loader();
    const earlier = {
      title: 'e',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        {
          name: 'b',
          doc: { title: 'c', polarity: 'n', params: [], equations: [], checks: [] },
          wiring: { gate: 'V_g', source: '0' },
        },
      ],
    };
    // Nothing is lost on the way through — with a loss collector (an import) or without (a restore).
    const lost: string[] = [];
    const imported = sanitize(JSON.parse(JSON.stringify(earlier)), 0, lost);
    expect(lost).toEqual([]);
    const restored = sanitize(JSON.parse(JSON.stringify(earlier)));
    expect(restored).toEqual(imported);
    expect(restored?.blocks?.[0]).toEqual(earlier.blocks[0]);
    expect(validateSheet(restored!).map((w) => w.message)).toContain(
      'block "b": "wiring" is not read in any format — the wires a block\'s device sits on are its ' +
        '"nodes" in format version 2; a script can draft the nodes from the givens with ' +
        'proposeWiring and write them into a format-version-2 copy with applyWiringProposal (see ' +
        '"Scripting the core" in the README)',
    );
  });

  it('keeps a document of an unknown format exactly as stored, and records why an import refuses it', async () => {
    const sanitize = await loader();
    const v3 = { ...stored, formatVersion: 3, wires3: { x: 1 } };
    const restored = sanitize(JSON.parse(JSON.stringify(v3)));
    expect(restored).toEqual(v3);
    const lost: string[] = [];
    sanitize(JSON.parse(JSON.stringify(v3)), 0, lost);
    expect(lost).toEqual([
      'formatVersion: format version 3 is not one this app reads (it reads documents with no format ' +
        'version, and format version 2) — the document is not imported or evaluated; a stored copy is ' +
        'kept as it was stored',
    ]);
    expect(sanitize(JSON.parse(JSON.stringify(restored)))).toEqual(v3);
  });
});

describe('edges the tests above leave open', () => {
  it('admits no held gate for a hold that balances currents, though it reads a gate-source voltage', () => {
    // A current balance (it reads p__id) that also mentions p__vgs: still a balance, so it holds no
    // wire, and as a level it crosses a device.
    const doc: SheetDoc = {
      title: 'bal',
      polarity: 'n',
      formatVersion: 2,
      params: [
        param('I_bias', 20e-6, { hold: 'I_bias - p__id*(1 + 0*p__vgs)', min: 1e-6, max: 1e-4 }),
      ],
      blocks: [
        block(
          'p',
          leaf('p', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 20e-6],
            ['vd', 0.9],
          ]),
          {},
        ),
      ],
      equations: [],
      checks: [],
    };
    expect(levelEligibility(doc, '', 'I_bias - p__id*(1 + 0*p__vgs)').kind).toBe('refused');
  });

  it('raises an imbalance of a few per cent: the threshold is 0.1 %', () => {
    // Two n sinks on one unheld wire fed by a p source carrying 1.05 times their sum: 5 % left over.
    const doc: SheetDoc = {
      title: 'five',
      polarity: 'n',
      formatVersion: 2,
      params: [vparam('VDD', 1.8), vparam('V_o', 0.9)],
      blocks: [
        block(
          'a',
          leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 10e-6],
            ['vd', 0.9],
          ]),
          { vd: 'V_o' },
          { d: 'o', g: 'g', s: 'gnd', b: 'gnd' },
        ),
        block(
          'p',
          leaf('p', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 10e-6],
            ['vd', 0.9],
          ]),
          { I: '1.05*a__id', vd: 'VDD - V_o' },
          { d: 'o', g: 'gp', s: 'vdd', b: 'vdd' },
        ),
      ],
      levels: { vdd: 'VDD' },
      ports: ['g', 'gp'],
      equations: [],
      checks: [],
    };
    const r = runSheet(doc, t);
    expect(r.nodes!.balance.find((b) => b.wire === 'o')!.residual).toBeCloseTo(
      0.05 * idOf(r, ['a']),
      15,
    );
    expect(
      wiring(r).some((w) => w.message.startsWith('the currents at wire "o" do not balance')),
    ).toBe(true);
  });

  it("reads a selector's value as the walk's own sheet was evaluated, through a parent's override", () => {
    // A parent sets its wired child's selector to -1 on an N-style table; the child's wiring joins
    // the parent's walk, and its p_sign is -1 there, whatever the child's document says.
    const child: SheetDoc = {
      title: 'child',
      polarity: 'n',
      formatVersion: 2,
      params: [vparam('VDD', 1.8), param('p_sign', 1, { convention: 'axis-sign' })],
      blocks: [
        block(
          'p',
          leaf('p', { L: '0.5e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 1e-5],
            ['vd', 0.9],
          ]),
          { vd: 'p_sign*(VDD - 0.9)' },
          { d: 'o', g: 'g', s: 'vdd', b: 'vdd' },
        ),
      ],
      levels: { vdd: 'VDD' },
      ports: ['o', 'g'],
      equations: [],
      checks: [],
    };
    const parent = (sel: string): SheetDoc => ({
      title: 'parent',
      polarity: 'n',
      formatVersion: 2,
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'c', doc: child, params: { p_sign: sel }, ports: { o: null, g: null } }],
    });
    const refused = (d: SheetDoc): boolean =>
      evaluateSheet(d, t).warnings.some((w) =>
        w.message.includes('"p_sign" is an axis-sign selector'),
      );
    expect(refused(parent('-1'))).toBe(true);
    expect(refused(parent('1'))).toBe(false);
  });

  it('does not raise a group that reaches a port as floating', () => {
    // Drain and gate on ports, source and body on x: nothing held, but the ports connect outside.
    const doc: SheetDoc = {
      title: 'ported',
      polarity: 'n',
      formatVersion: 2,
      params: [],
      blocks: [
        block(
          'm',
          leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 1e-5],
            ['vd', 0.6],
          ]),
          {},
          { d: 'o', g: 'i', s: 'x', b: 'x' },
        ),
      ],
      ports: ['o', 'i', 'x'],
      equations: [],
      checks: [],
    };
    const r = evaluateSheet(doc, t);
    expect(r.nodes!.floating).toEqual([['i', 'o', 'x']]);
    expect(wiring(r).some((w) => w.message.includes('float'))).toBe(false);
  });

  it('leaves a selector the table contradicts unnormalized: its loop is a term the count cannot read', () => {
    // p_sign = -1 on an N-style table: replacing it by -1 would invent a proven constraint.
    const doc: SheetDoc = {
      title: 'inv',
      polarity: 'n',
      formatVersion: 2,
      params: [
        vparam('VDD', 1.8),
        vparam('V_in', 0.7),
        vparam('V_out', 0.9),
        param('p_sign', -1, { convention: 'axis-sign' }),
      ],
      blocks: [
        block(
          'n',
          leaf('n', { L: '0.5e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 20e-6],
            ['vd', 0.9],
          ]),
          { vd: 'V_out' },
          { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
        ),
        block(
          'p',
          leaf('p', { L: '0.5e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 20e-6],
            ['vd', 0.9],
          ]),
          { I: 'n__id', vd: 'p_sign*(VDD - V_out)' },
          { d: 'out', g: 'in', s: 'vdd', b: 'vdd' },
        ),
      ],
      levels: { vdd: 'VDD', in: 'V_in' },
      equations: [],
      checks: [],
    };
    expect(evaluateSheet(doc, t).nodes!.dof).toMatchObject({ proven: 2, bound: 3 });
  });
});

describe('a key of format version 2 is read only in a document of format version 2', () => {
  const doc = (extra: Partial<SheetDoc>): SheetDoc => ({
    title: 'diode by its wires',
    polarity: 'n',
    params: [param('I', 1e-5)],
    givens: { L: '1e-6', id: 'I', gm_id: '10' },
    nodes: { d: 'x', g: 'x', s: 'gnd', b: 'gnd' },
    equations: [],
    checks: [],
    ...extra,
  });

  it('reads no wiring of a document in the earlier format: no structural diode, and no walk', () => {
    const earlier = doc({});
    // Validation refuses the key; nothing else half-reads it.
    expect(validateSheet(earlier).some((w) => w.rule === 'sheet-format')).toBe(true);
    expect(structuralDiodes(earlier)).toBe(earlier);
    const r = evaluateSheet(earlier, t);
    expect(r.nodes).toMatchObject({ state: 'not-evaluated', notes: [EARLIER_FORMAT_NOTE] });
    expect(wiring(r)).toEqual([]);
  });

  it('reads the same wires in format version 2: a diode, sized and walked', () => {
    const v2 = doc({ formatVersion: 2 });
    expect(structuralDiodes(v2).givens?.diode).toBe(true);
    const r = evaluateSheet(v2, t);
    expect(r.sizing?.ok).toBe(true);
    expect(r.nodes?.state).toMatch(/^checked-/);
  });
});

describe('one wiring pass, on the tree once it has settled', () => {
  // A child that wires itself, connected through its block's port map (empty: it declares no
  // ports), so its wiring joins its parent's walk — the one walk of the tree.
  const child = (gm_id: string): SheetDoc => ({
    title: 'cs',
    polarity: 'n',
    formatVersion: 2,
    params: [param('I', 1e-5), param('g', 10), vparam('V_d', 0.9), vparam('V_g', 0.6)],
    givens: { L: '1e-6', id: 'I', gm_id, vds: 'V_d' },
    nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
    levels: { out: 'V_d', in: 'V_g' },
    equations: [],
    checks: [],
    provides: ['vgs', 'id', 'gm', 'W'],
  });

  it("walks a child's wiring in its parent's walk at the settled point, and not at a range end with no answer", () => {
    const parent: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      formatVersion: 2,
      params: [vparam('VD', 0.9)],
      blocks: [{ name: 'a', doc: child('10'), params: { V_d: 'VD' }, ports: {} }],
      equations: [],
      checks: [],
      operatingRange: [{ name: 'hi', set: { VD: '2.5' } }],
    };
    expect(validateSheet(parent).filter((w) => w.severity === 'error')).toEqual([]);
    const r = evaluateSheet(parent, t);
    expect(r.nodes?.state).toMatch(/^checked-/);
    expect(r.nodes!.levels.a__out.level).toBeCloseTo(0.9, 12);
    // The child runs no walk of its own; its levels reach the parent's.
    expect(r.blocks![0].nodes).toBeUndefined();
    expect(r.blocks![0].wiringValues).toBeDefined();
    // Past the 1.8 V drain axis the end has no answer: the child's drain was read at the axis end.
    const [hi] = r.rangeEnds!;
    expect(hi.state).toBe('no-answer');
    expect(hi.nodes).toMatchObject({ state: 'not-evaluated', notes: [NO_ANSWER_NOTE] });
    expect(wiring(hi)).toEqual([]);
  });

  it('does not walk a child at the probe a failed solve stopped on', () => {
    const parent = (spec: number): SheetDoc => ({
      title: 'parent',
      polarity: 'n',
      formatVersion: 2,
      params: [
        {
          name: 'gx',
          value: 10,
          min: 5,
          max: 20,
          designConstraint: { lhs: 'a__vgs', rhs: 'Spec' },
        },
        param('Spec', spec),
      ],
      blocks: [{ name: 'a', doc: child('g'), params: { g: 'gx' }, ports: {} }],
      equations: [],
      checks: [],
    });
    const landed = runSheet(parent(0.6), t);
    expect(landed.warnings.some((w) => w.severity === 'error')).toBe(false);
    expect(landed.nodes?.state).toBe('checked-clean');
    // No gate-source voltage in the search range reaches 5 V: the solve finds no solution.
    const failed = runSheet(parent(5), t);
    expect(failed.warnings.some((w) => /found no solution/.test(w.message))).toBe(true);
    expect(failed.nodes?.state).toBe('not-evaluated');
    expect(wiring(failed)).toEqual([]);
  });

  it('does not walk a library child composed by reference when its parent finds no answer', () => {
    const parent: SheetDoc = {
      title: 'uses a 5T',
      polarity: 'n',
      formatVersion: 2,
      params: [
        {
          name: 'gi',
          value: 10,
          min: 6,
          max: 16,
          designConstraint: { lhs: 'ota__Rout', rhs: 'Spec' },
        },
        param('Spec', 1e12),
      ],
      blocks: [
        {
          name: 'ota',
          ref: 'otas/five-transistor-ota',
          params: { gm_id_in: 'gi' },
          ports: { vinp: null, vinn: null },
        },
      ],
      equations: [],
      checks: [],
    };
    expect(validateSheet(parent).filter((w) => w.severity === 'error')).toEqual([]);
    const r = runSheet(parent, libraryTable, undefined, REFS);
    expect(r.warnings.filter((w) => w.rule === 'sheet-nodes' && w.severity === 'error')).toEqual(
      [],
    );
    expect(r.warnings.some((w) => /found no solution/.test(w.message))).toBe(true);
    expect(r.nodes?.state).toBe('not-evaluated');
    expect(wiring(r)).toEqual([]);
  });
});

describe('a parent that composes a child stating wiring states its own and maps the child’s ports', () => {
  // A child's wiring is checked only as part of its parent's walk: a parent with no wiring of its
  // own, or one declaring nodes: "none", would leave the child's ports connected to nothing.
  const child: SheetDoc = {
    title: 'cs',
    polarity: 'n',
    formatVersion: 2,
    params: [param('I', 1e-5), vparam('V_d', 0.9)],
    givens: { L: '1e-6', id: 'I', gm_id: '10', vds: 'V_d' },
    nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
    levels: { out: 'V_d' },
    ports: ['in'],
    equations: [],
    checks: [],
    provides: ['vgs'],
  };
  const parent = (over: Partial<SheetDoc> = {}, b: Partial<SheetBlock> = {}): SheetDoc => ({
    title: 'parent',
    polarity: 'n',
    formatVersion: 2,
    params: [],
    blocks: [{ name: 'a', doc: child, ...b }],
    equations: [],
    checks: [],
    ...over,
  });
  /** The refusals of this rule (a child's own lints, such as a wire one terminal names, aside). */
  const refusals = (d: SheetDoc): string[] =>
    validateSheet(d)
      .filter((w) => w.rule === 'sheet-nodes' && w.message.includes('the child states wiring'))
      .map((w) => w.message);

  it('refuses a parent that states no wiring, naming the child and its unmapped ports', () => {
    expect(refusals(parent())).toEqual([
      'block "a": the child states wiring and this sheet states none, so the child\'s wiring ' +
        "would be checked against nothing — a child's wiring is checked as part of its parent's: " +
        'connect it through the block\'s ports, mapping its port "in" to a wire here (or to null ' +
        'for one left open)',
    ]);
    // In the earlier format, which has no wiring, the message says what the fix needs.
    const { formatVersion: _v, ...earlier } = parent();
    expect(refusals(earlier)).toContainEqual(
      expect.stringMatching(
        /^block "a": the child states wiring and this sheet states none, .*; wiring needs "formatVersion": 2$/,
      ),
    );
  });

  it('refuses a parent that declares nodes: "none" though it contains the child’s circuit', () => {
    expect(refusals(parent({ nodes: 'none' }))).toEqual([
      'block "a": the child states wiring, so this sheet contains a circuit and cannot declare ' +
        'nodes: "none" — state this sheet\'s wiring instead: connect it through the block\'s ports, ' +
        'mapping its port "in" to a wire here (or to null for one left open)',
    ]);
    // A port map does not make "none" true: the child's circuit is still this sheet's.
    expect(refusals(parent({ nodes: 'none' }, { ports: { in: 'x' } }))).toEqual([
      'block "a": the child states wiring, so this sheet contains a circuit and cannot declare ' +
        'nodes: "none" — state this sheet\'s wiring instead',
    ]);
  });

  it('admits the parent once it maps the ports, and a child that declares none through an empty map', () => {
    expect(refusals(parent({}, { ports: { in: null } }))).toEqual([]);
    const { ports: _p, ...portless } = child;
    const refused = refusals({ ...parent(), blocks: [{ name: 'a', doc: portless }] });
    expect(refused).toEqual([
      expect.stringContaining(
        "connect it through the block's ports (an empty map, {}, where it declares none)",
      ),
    ]);
    expect(refusals({ ...parent(), blocks: [{ name: 'a', doc: portless, ports: {} }] })).toEqual(
      [],
    );
  });

  it('judges a child composed by reference once it is resolved: runSheet validates the resolved document', () => {
    const refs = buildSheetRefIndex([{ path: 'lib/cs', doc: child }]);
    const byRef = parent({}, {});
    byRef.blocks = [{ name: 'a', ref: 'lib/cs' }];
    // Unresolved, the block carries no child to judge.
    expect(refusals(byRef)).toEqual([]);
    // Resolved, the same rule refuses it, and the run is not feasible.
    const r = runSheet(byRef, t, undefined, refs);
    expect(
      r.warnings
        .filter((w) => w.rule === 'sheet-nodes' && w.severity === 'error')
        .map((w) => w.message),
    ).toEqual([
      expect.stringMatching(/^block "a": the child states wiring and this sheet states none/),
    ]);
    expect(r.feasible).toBe(false);
    const mapped = { ...byRef, blocks: [{ name: 'a', ref: 'lib/cs', ports: { in: null } }] };
    expect(
      runSheet(mapped, t, undefined, refs).warnings.filter((w) => w.severity === 'error'),
    ).toEqual([]);
  });

  it('walks a child under a refused parent in no walk at all: the refusal is the report', () => {
    // The child joins its parent's walk, which a parent with no wiring does not run.
    const r = runSheet(parent(), t);
    expect(r.feasible).toBe(false);
    expect(r.nodes).toBeUndefined();
    expect(r.blocks![0].nodes).toBeUndefined();
  });

  it('keeps a child wired by its block’s nodes a device of the parent’s walk', () => {
    const { nodes: _n, levels: _l, ports: _p, ...bare } = child;
    const d = parent(
      { levels: { out: 'V_o' }, params: [vparam('V_o', 0.9)], ports: ['in'] },
      { doc: bare, params: { V_d: 'V_o' }, nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' } },
    );
    expect(validateSheet(d).filter((w) => w.severity === 'error')).toEqual([]);
    const r = runSheet(d, t);
    expect(r.nodes?.state).toMatch(/^checked-/);
    expect(r.blocks![0].terminals).toBeDefined();
    expect(r.nodes!.levels.out.level).toBeCloseTo(0.9, 12);
  });
});

describe('a child result read back from its tree is walked as the settled tree has it', () => {
  // Every probe of a parent search evaluates every block again, and a block whose inputs the probe
  // did not move is read back from what the tree evaluated earlier instead. The result read back
  // is shared by the reports of every probe that read it; each report keeps its own wiring entry,
  // so the walk of the settled tree must come out exactly as if each child had been evaluated
  // there afresh. A document with the solved params fixed where they landed evaluates every child
  // once, with nothing read back, and is the reference.

  /** `table` behind a getter that counts how often its metadata is read: once per evaluation of a
   *  document sized on it, which is how a test sees a child evaluated or read back. */
  const counted = (table: DeviceTable): { table: DeviceTable; reads: () => number } => {
    let n = 0;
    const wrapped: DeviceTable = {
      id: table.id,
      grid: table.grid,
      get meta() {
        n++;
        return table.meta;
      },
    };
    return { table: wrapped, reads: () => n };
  };

  /** The same document with every solved param fixed at the value `res` landed it on. */
  const fixedAt = (doc: SheetDoc, res: SheetResult): SheetDoc => ({
    ...doc,
    params: doc.params.map((p) => {
      if (!p.designConstraint && !p.solveFor) return p;
      const { designConstraint: _c, solveFor: _s, ...rest } = p;
      return { ...rest, value: res.values[p.name] };
    }),
  });

  /** Everything a block report says, the walk's findings included. */
  const reportOf = (r: SheetResult, name: string): string =>
    JSON.stringify(r.blocks!.find((b) => b.name === name));
  /** The findings attributed to one block, in order. */
  const saidOf = (r: SheetResult, name: string): string[] =>
    r.warnings.filter((w) => w.message.startsWith(`block "${name}"`)).map((w) => w.message);

  it('a composed sheet: a child the search never moves is evaluated once and walked as fresh', () => {
    const cs = (gm_id: string): SheetDoc => ({
      title: 'cs',
      polarity: 'n',
      formatVersion: 2,
      params: [param('I', 1e-5), param('g', 10), vparam('V_d', 0.9), vparam('V_g', 0.6)],
      givens: { L: '1e-6', id: 'I', gm_id, vds: 'V_d' },
      nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
      levels: { out: 'V_d', in: 'V_g' },
      equations: [],
      checks: [],
      provides: ['vgs', 'id', 'gm', 'W'],
    });
    const parent: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      formatVersion: 2,
      params: [
        {
          name: 'gx',
          value: 10,
          min: 5,
          max: 20,
          designConstraint: { lhs: 'a__vgs', rhs: 'Spec' },
        },
        param('Spec', 0.6),
      ],
      blocks: [
        { name: 'a', doc: cs('g'), params: { g: 'gx' }, ports: {} },
        { name: 'b', doc: cs('12'), device: 'still', ports: {} },
      ],
      equations: [],
      checks: [],
    };
    expect(validateSheet(parent).filter((w) => w.severity === 'error')).toEqual([]);
    const top = counted(t);
    const still = counted(t);
    const r = evaluateSheet(parent, top.table, (id) => (id === 'still' ? still.table : undefined));
    expect(r.solve).toEqual({ kind: 'settled' });
    // The parent probed many times; `b`, whose inputs no probe moves, was evaluated once (one read
    // more is the cut of its table to its length, taken once).
    expect(top.reads()).toBeGreaterThan(5);
    expect(still.reads()).toBeLessThanOrEqual(2);
    // `b` is biased off its own gate level, so the walk its wiring joins — the parent's — has a
    // finding against it: said once, on the settled tree, however many probes read the result back.
    expect(r.nodes?.state).toBe('checked-with-findings');
    expect(wiring(r)).toHaveLength(1);
    expect(wiring(r)[0].message).toMatch(/^the wiring does not close .* disputed by b\.gs\./);
    const ref = evaluateSheet(fixedAt(parent, r), t, (id) => (id === 'still' ? t : undefined));
    for (const name of ['a', 'b']) {
      expect(reportOf(r, name)).toBe(reportOf(ref, name));
      expect(saidOf(r, name)).toEqual(saidOf(ref, name));
    }
    expect(JSON.stringify(r.nodes)).toBe(JSON.stringify(ref.nodes));
  });

  it('the flattened two-stage sheets: every block, the referenced load included, as fresh', () => {
    for (const path of [
      'multistage/two-stage-miller-ota.json',
      'multistage/two-stage-cascode-comp-ota.json',
    ]) {
      const doc = resolvedSheet(librarySheet(path), REFS).doc;
      // The output load is composed by reference through its port map, with no nodes of its
      // block: its wiring joins the parent's walk (it is flattened), and its inputs do not move
      // with the solved tail.
      const ld2 = doc.blocks!.find((b) => b.name === 'ld2')!;
      expect(ld2.nodes).toBeUndefined();
      // The bias leg reads nothing the search moves; it is bound to a counted copy of the table.
      const bound: SheetDoc = {
        ...doc,
        blocks: doc.blocks!.map((b) => (b.name === 'bias' ? { ...b, device: 'bias' } : b)),
      };
      const top = counted(libraryTable);
      const bias = counted(libraryTable);
      const r = evaluateSheet(bound, top.table, (id) => (id === 'bias' ? bias.table : undefined));
      expect(r.solve).toEqual({ kind: 'settled' });
      expect(top.reads()).toBeGreaterThan(20);
      expect(bias.reads()).toBeLessThanOrEqual(2);
      expect(r.blocks!.find((b) => b.name === 'ld2')!.wiringValues).toBeDefined();
      const ref = evaluateSheet(fixedAt(bound, r), libraryTable, (id) =>
        id === 'bias' ? libraryTable : undefined,
      );
      for (const b of bound.blocks!) {
        expect([path, b.name, reportOf(r, b.name)]).toEqual([path, b.name, reportOf(ref, b.name)]);
        expect(saidOf(r, b.name)).toEqual(saidOf(ref, b.name));
      }
      expect(JSON.stringify(r.nodes)).toBe(JSON.stringify(ref.nodes));
    }
  });
});

describe('a selector on a sheet that is not a circuit', () => {
  it('is held to its table: the rail-to-rail input stage at p_sign = -1 on an N-style table', () => {
    const base = librarySheet('multistage/rail-to-rail-input-stage.json');
    expect(base.nodes).toBe('none');
    const at = (v: number) =>
      runSheet(
        { ...base, params: base.params.map((p) => (p.name === 'p_sign' ? { ...p, value: v } : p)) },
        t,
      );
    const selectorErrors = (r: SheetResult) =>
      r.warnings.filter(
        (w) => w.severity === 'error' && w.message.includes('"p_sign" is an axis-sign selector'),
      );
    expect(selectorErrors(at(1))).toEqual([]);
    const flipped = at(-1);
    expect(selectorErrors(flipped)).toHaveLength(1);
    expect(flipped.feasible).toBe(false);
  });
});

describe("both seams count the netlist's structural findings in the wiring verdict", () => {
  it('gives runSheet and a condition run the same state for a wire only gates touch', () => {
    const leafOf = (): SheetDoc =>
      leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: '0.9' }, [['I', 1e-5]]);
    const doc: SheetDoc = {
      title: 'two gates on one wire',
      polarity: 'n',
      formatVersion: 2,
      params: [vparam('VDD', 1.8)],
      blocks: [
        block('a', leafOf(), {}, { d: 'o1', g: 'g', s: 'gnd', b: 'gnd' }),
        block('b', leafOf(), {}, { d: 'o2', g: 'g', s: 'gnd', b: 'gnd' }),
      ],
      levels: { o1: '0.9', o2: '0.9' },
      equations: [],
      checks: [],
    };
    expect(validateSheet(doc).map((w) => w.message)).toEqual([
      expect.stringMatching(/^wire "g" is touched only by gates/),
    ]);
    const direct = runSheet(doc, t);
    const tt = { ...t, id: { ...t.id, corner: 'tt', temp: 27 } };
    const [device] = groupDevices([tt]);
    const [run] = runConditions(doc, device, [{ corner: 'tt', temp: 27 }], () => undefined);
    expect(run.state).toBe('evaluated');
    if (run.state !== 'evaluated') return;
    expect(direct.nodes).toMatchObject({ state: 'checked-with-findings', findings: 1 });
    expect(run.result.nodes).toEqual(direct.nodes);
  });
});

describe('a held gate on the wire a child that wires itself names through its port map', () => {
  // The cascode wires itself and is connected through its ports; the parent holds the node under
  // its gate, so the gate's wire may be held at the hold expression — the wire the port map names.
  const casc: SheetDoc = {
    title: 'casc',
    polarity: 'n',
    formatVersion: 2,
    params: [param('I', 1e-5), vparam('V_d', 1.2), vparam('V_s', 0.3)],
    givens: { L: '1e-6', id: 'I', gm_id: '10', vds: 'V_d - V_s', vsb: 'V_s' },
    nodes: { d: 'd', g: 'g', s: 's', b: 'gnd' },
    ports: ['d', 'g', 's'],
    equations: [],
    checks: [],
    provides: ['vgs', 'id'],
  };
  const parent = (levels: Record<string, string>): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    formatVersion: 2,
    params: [
      vparam('V_out', 1.2),
      { name: 'V_x', value: 0.3, min: 0.1, max: 0.8, unit: 'V', hold: 'V_x + c__vgs' },
    ],
    blocks: [
      {
        name: 'c',
        doc: casc,
        params: { V_d: 'V_out', V_s: 'V_x' },
        ports: { d: 'out', g: 'vcasc', s: 'x' },
      },
    ],
    levels,
    ports: ['x'],
    equations: [],
    checks: [],
  });

  it('admits the level on that wire', () => {
    expect(validateSheet(parent({ out: 'V_out', vcasc: 'V_x + c__vgs' }))).toEqual([]);
  });

  it('refuses it elsewhere, naming the gate wire the port map gives', () => {
    const errs = validateSheet(parent({ out: 'V_x + c__vgs', vcasc: 'V_out' })).filter(
      (w) => w.severity === 'error',
    );
    expect(errs.map((w) => w.message)).toContain(
      'levels "out": "V_x + c__vgs" is the gate voltage the hold on V_x keeps fixed for "c", so it ' +
        'may hold only that device\'s gate wire — "c" has its gate on "vcasc"',
    );
  });
});

describe('the proposal drafts a document validation reads', () => {
  it('migrates the single-NMOS sheet: the drain held at the level the draft placed it at, the gate a port', () => {
    const earlier: SheetDoc = {
      title: 'Single NMOS gm/ID sizing',
      polarity: 'n',
      params: [
        { name: 'GBW_target', value: 10e6, unit: 'Hz', role: 'spec' },
        { name: 'CL', value: 2e-12, unit: 'F', role: 'spec' },
        { name: 'gm_id', value: 12, min: 6, max: 18, unit: '1/V', role: 'choice' },
        { name: 'L', value: 0.5e-6, unit: 'm', role: 'choice' },
      ],
      givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.9' },
      equations: [{ name: 'GBW', expr: 'gm/(2*pi*(cgg + CL))', unit: 'Hz' }],
      checks: [{ id: 'inversion', kind: 'physical', lhs: 'gm_id', op: '<=', rhs: 'ceiling' }],
    };
    const p = proposeWiring(earlier);
    const copy = applyWiringProposal(earlier, p);
    expect(copy.nodes).toEqual({ d: 'own_d', g: 'own_g', s: 'gnd', b: 'gnd' });
    expect(copy.levels).toEqual({ own_d: '0.9' });
    expect(copy.ports).toEqual(['own_g']);
    // The draft's marks stand: the gate is still a wire nothing named.
    expect(p.devices[0].nodes.g.mark).toBe('unknown');
    expect(p.notes.some((n) => n.startsWith('wire "own_g" has one terminal (own.g)'))).toBe(true);
    expect(validateSheet(copy).filter((w) => w.severity === 'error')).toEqual([]);
    const demo = generateDemoDevice({ vds: { min: 0.1, max: 1.8, step: 0.1 } });
    expect(runSheet(copy, demo).nodes?.state).toBe('checked-clean');
  });

  it("holds a child's lone drain at its level and makes its lone gate a port", () => {
    const earlier: SheetDoc = {
      title: 'one child',
      polarity: 'n',
      params: [vparam('V_d', 0.7)],
      blocks: [
        block(
          'm',
          leaf('n', { L: '1e-6', id: 'I', gm_id: '10', vds: 'vd' }, [
            ['I', 1e-5],
            ['vd', 0.6],
          ]),
          {
            vd: 'V_d',
          },
        ),
      ],
      equations: [],
      checks: [],
    };
    const copy = applyWiringProposal(earlier, proposeWiring(earlier));
    expect(copy.blocks![0].nodes).toEqual({ d: 'd', g: 'm_g', s: 'gnd', b: 'gnd' });
    expect(copy.levels).toEqual({ d: 'V_d' });
    expect(copy.ports).toEqual(['m_g']);
    expect(validateSheet(copy).filter((w) => w.severity === 'error')).toEqual([]);
  });

  it("drafts the held gate of a sheet's own device: the cascode example, written before the netlist", () => {
    const earlier = JSON.parse(JSON.stringify(EXAMPLES[2])) as SheetDoc;
    for (const k of ['formatVersion', 'nodes', 'levels', 'ports'] as const) delete earlier[k];
    for (const b of earlier.blocks ?? []) delete b.nodes;
    const p = proposeWiring(earlier);
    const gate = p.devices.find((d) => d.device === 'givens')!.nodes.g.wire;
    expect(p.levels).toContainEqual(
      expect.objectContaining({ wire: gate, expr: 'V_x + vgs', held: 'held-gate' }),
    );
    const copy = applyWiringProposal(earlier, p);
    expect(validateSheet(copy).filter((w) => w.severity === 'error')).toEqual([]);
    expect(runSheet(copy, t).nodes?.state).toBe('checked-clean');
  });

  it('drops the earlier gate wiring from the copy, and says so: the inverter shipped before the netlist', () => {
    const earlier = JSON.parse(
      readFileSync(new URL('./fixtures/earlier-cmos-inverter-amp.json', import.meta.url), 'utf8'),
    ) as SheetDoc;
    expect(JSON.stringify(earlier)).toContain('"wiring"');
    const p = proposeWiring(earlier);
    expect(
      p.notes.some((n) =>
        n.startsWith('the earlier gate wiring on block "p" is read by no format'),
      ),
    ).toBe(true);
    const copy = applyWiringProposal(earlier, p);
    expect(JSON.stringify(copy)).not.toContain('"wiring"');
    expect(JSON.stringify(earlier)).toContain('"wiring"');
    expect(validateSheet(copy).filter((w) => w.rule === 'sheet-format')).toEqual([]);
  });
});

describe('compliance and the wiring check read one classification', () => {
  // A drain bias the design assumes: the sizing stands, and the claim cannot be made.
  const assumedDrain: SheetDoc = {
    title: 'assumed drain',
    polarity: 'n',
    formatVersion: 2,
    params: [param('I', 1e-5), { name: 'V_d', value: 0.6, unit: 'V', class: 'assumed' }],
    givens: { L: '1e-6', id: 'I', gm_id: '10', vds: 'V_d' },
    nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
    ports: ['in', 'out'],
    equations: [],
    checks: [],
  };
  const tt = { corner: 'tt', temp: 27 };
  const ss = { corner: 'ss', temp: 27 };
  const [device] = groupDevices([
    { ...t, id: { ...t.id, ...tt } },
    { ...t, id: { ...t.id, ...ss } },
  ]);

  it('walks a centre sized under an assumed level, which still has no compliance answer', () => {
    const [sized] = runConditions(assumedDrain, device, [tt], () => undefined);
    expect(sized.state).toBe('evaluated');
    if (sized.state !== 'evaluated') return;
    expect(sized.result.assumptions).toEqual(['V_d']);
    expect(sized.result.nodes?.state).toBe('checked-clean');
    expect(sized.points[0].state).toBe('no-answer');
    expect(sized.result.point).toMatchObject({ sized: true, state: 'no-answer' });
  });

  it('reports a condition declined before anything ran as not evaluated, as a declined range end is', () => {
    const [, held] = runConditions(assumedDrain, device, [tt, ss], () => undefined, undefined, tt);
    expect(held.state).toBe('not-evaluated');
    if (held.state !== 'not-evaluated') return;
    expect(held.points[0].state).toBe('no-answer');
    expect(held.nodes).toMatchObject({ state: 'not-evaluated', notes: [NO_ANSWER_NOTE] });
  });
});

describe('the range a solved wire is searched in is the circuit’s own where the wiring reads one', () => {
  // A follower on a sink: `m` sits between the supply and the node `x`, its gate on the held wire
  // `g`; `sink` sits between `x` and ground. `V_x` is solved so that the gate sits at `VG`. The
  // wiring puts `x` between ground (below, through the sink) and the supply (above, through `m`),
  // both held, so its range reads [0, VDD] before anything is solved. With `load`, `m`'s drain is
  // instead the node of a p diode from the supply — a wire a device sets, which the walk places only
  // once the design is solved.
  const follower = (
    range: [number, number],
    o: { VG?: number; load?: boolean; ends?: SheetDoc['operatingRange'] } = {},
  ): SheetDoc => ({
    title: 'a follower on a sink',
    polarity: 'n',
    formatVersion: 2,
    params: [
      vparam('VDD', 1.8),
      vparam('VG', o.VG ?? 1.2),
      param('I', 10e-6, { unit: 'A', class: 'independent' }),
      param('V_x', 0.5, {
        unit: 'V',
        min: range[0],
        max: range[1],
        designConstraint: { lhs: 'V_x + m__vgs', rhs: 'VG' },
      }),
    ],
    equations: [],
    checks: [],
    levels: { vdd: 'VDD', g: 'VG' },
    ports: ['b'],
    blocks: [
      ...(o.load
        ? [
            block(
              'ld',
              leaf('p', { L: '0.5e-6', id: 'Id', gm_id: '10', diode: true }, [['Id', 1e-5]]),
              { Id: 'I' },
              { d: 'y', g: 'y', s: 'vdd', b: 'vdd' },
            ),
          ]
        : []),
      block(
        'm',
        leaf('n', { L: '0.5e-6', id: 'Id', gm_id: '10', vds: 'vd', vsb: 'vs' }, [
          ['Id', 1e-5],
          ['vd', 1],
          ['vs', 0.5],
        ]),
        { Id: 'I', vd: o.load ? 'VDD - abs(ld__vgs) - V_x' : 'VDD - V_x', vs: 'V_x' },
        { d: o.load ? 'y' : 'vdd', g: 'g', s: 'x', b: 'gnd' },
      ),
      block(
        'sink',
        leaf('n', { L: '0.5e-6', id: 'Id', gm_id: '10', vds: 'vd' }, [
          ['Id', 1e-5],
          ['vd', 0.5],
        ]),
        { Id: 'I', vd: 'V_x' },
        { d: 'x', g: 'b', s: 'gnd', b: 'gnd' },
      ),
    ],
    ...(o.ends ? { operatingRange: o.ends } : {}),
  });
  const notes = (r: { warnings: SheetResult['warnings'] }): string[] =>
    r.warnings
      .filter((w) => w.rule === 'sheet-range' && w.location === 'V_x')
      .map((w) => w.message);
  const errors = (r: SheetResult): string[] =>
    r.warnings.filter((w) => w.severity === 'error').map((w) => w.message);
  // The node lands where the gate sits at VG: V_x + vgs(gm/ID 10) + BODY_FACTOR·V_x = 1.2 on the
  // demo model, near 0.49 V — the same whatever range the search ran over.
  const landed = runSheet(follower([0.1, 0.8]), t).values.V_x;

  it('searches the author’s range where it lies inside the wiring’s, and says both', () => {
    const r = runSheet(follower([0.1, 0.8]), t);
    expect(r.feasible).toBe(true);
    expect(r.ranges).toEqual([
      expect.objectContaining({
        param: 'V_x',
        range: [0.1, 0.8],
        from: 'narrowed',
        author: [0.1, 0.8],
        wires: ['x'],
        wiring: { range: [0, 1.8], below: 'gnd', above: 'vdd' },
      }),
    ]);
    expect(notes(r)).toEqual([
      'solved param "V_x" is searched in the author\'s range [0.1, 0.8] V, inside the range the ' +
        'wiring puts its wire "x" in, [0, 1.8] V between "gnd" below and "vdd" above',
    ]);
  });

  it('clips an author’s range wider than the wiring’s, and notes it', () => {
    const r = runSheet(follower([-0.5, 2.5]), t);
    expect(r.feasible).toBe(true);
    expect(r.ranges?.[0]).toMatchObject({ range: [0, 1.8], from: 'wiring', author: [-0.5, 2.5] });
    expect(notes(r)).toEqual([
      'solved param "V_x" is searched in [0, 1.8] V, the range the wiring puts its wire "x" in, ' +
        'between "gnd" below and "vdd" above — the author\'s range [-0.5, 2.5] V reaches past it',
    ]);
    // The tolerance is a fraction of the span searched, so the landing agrees to that fraction.
    expect(Math.abs(r.values.V_x - landed)).toBeLessThan(1e-5);
  });

  it('refuses an author’s range outside the wiring’s, naming both, and searches nothing', () => {
    const r = runSheet(follower([2, 2.5]), t);
    const message =
      'solved param "V_x": its range [2, 2.5] V lies outside the range the wiring puts its wire ' +
      '"x" in, [0, 1.8] V between "gnd" below and "vdd" above — no level it allows is one the ' +
      "circuit can put the wire at. Move min/max inside the wiring's range";
    expect(r.feasible).toBe(false);
    expect(r.solve).toEqual({ kind: 'not-settled', unknowns: ['V_x'], why: 'malformed', message });
    expect(errors(r)).toEqual([message]);
    expect(notes(r)).toEqual([]);
    expect(r.point).toMatchObject({ sized: false, state: 'no-answer' });
  });

  it('keeps the author’s range, and no solution as no answer, where no range is read', () => {
    const r = runSheet(follower([0.6, 0.8], { load: true }), t);
    const why =
      'the wire above it, "y" (through "m"), is set by a device, and the walk places it only ' +
      'once the design is solved';
    expect(r.ranges?.[0]).toMatchObject({ range: [0.6, 0.8], from: 'author', wires: ['x'], why });
    expect(notes(r)).toEqual([
      `solved param "V_x" is searched in the author's range [0.6, 0.8] V: no range is read from ` +
        `the wiring for its wire "x" — ${why}`,
    ]);
    expect(r.solve).toMatchObject({ kind: 'no-solution', from: 'author', because: 'no-crossing' });
    expect(errors(r)[0]).toContain(
      `found no solution in [0.6, 0.8] V (the author's range — ${why})`,
    );
    expect(errors(r)[0]).toContain('Move or widen min/max to bracket one');
    expect(r.point).toMatchObject({ sized: false, state: 'no-answer' });
  });

  it('reads no crossing in the wiring’s range as the design failing: infeasible where it is sized', () => {
    // At VG = 0.4 V the gate would need the node below ground; the wiring puts it at or above.
    const r = runSheet(follower([-0.5, 0.8], { VG: 0.4 }), t);
    expect(r.feasible).toBe(false);
    expect(r.solve).toMatchObject({
      kind: 'no-solution',
      from: 'narrowed',
      because: 'no-crossing',
    });
    const [message] = errors(r);
    expect(message).toContain(
      "found no solution in [0, 0.8] V (the author's range clipped to the wiring's [0, 1.8] V " +
        'between "gnd" and "vdd")',
    );
    expect(r.point).toEqual({ sized: false, state: 'does-not-comply', error: message });
    // The condition runs read the same centre, and its feasibility is infeasibility, not a
    // missing answer.
    const tt = { corner: 'tt', temp: 27 };
    const [device] = groupDevices([{ ...t, id: { ...t.id, ...tt } }]);
    const runs = runConditions(follower([-0.5, 0.8], { VG: 0.4 }), device, [tt], () => undefined);
    expect(runs[0].points[0]).toEqual({ state: 'does-not-comply', error: message });
    expect(aggregateConditionRuns(runs).feasibility).toBe('infeasible');
  });

  it('reads no crossing in the wiring’s range at a held point as not complying', () => {
    const r = runSheet(follower([0.1, 0.8], { ends: [{ name: 'low', set: { VG: '0.4' } }] }), t);
    expect(r.feasible).toBe(true);
    const [low] = r.rangeEnds!;
    expect(low.state).toBe('does-not-comply');
    expect(low.error).toContain(
      "found no solution in [0.1, 0.8] V (the author's range inside the wiring's [0, 1.8] V " +
        'between "gnd" and "vdd")',
    );
    expect(r.complies).toBe(false);
  });

  it('reads a wire a device sets from the design point’s walk where the design is held', () => {
    const r = runSheet(
      follower([0.1, 0.8], { load: true, ends: [{ name: 'hi', set: { VG: '1.3' } }] }),
      t,
    );
    // At the design point "y" cannot be placed before the solve; at the range end it is read at the
    // level the design point's walk gave it, to the millivolt and one millivolt above.
    expect(r.ranges?.[0].from).toBe('author');
    const y = r.nodes!.levels.y.level;
    const above = (Math.round(y * 1000) + 1) / 1000;
    const [hi] = r.rangeEnds!;
    expect(hi.state).toBe('complies');
    expect(notes(hi)).toEqual([
      `solved param "V_x" is searched in the author's range [0.1, 0.8] V, inside the range the ` +
        `wiring puts its wire "x" in, [0, ${above}] V between "gnd" below and "y" above`,
    ]);
    // The held document carries the design point's placings; an authored one is refused.
    const held = holdHardware(structuralDiodes(follower([0.1, 0.8], { load: true })), r);
    expect(held.doc.designLevels).toEqual(
      Object.fromEntries(Object.entries(r.nodes!.levels).map(([w, l]) => [w, l.level])),
    );
    expect(
      validateSheet({ ...follower([0.1, 0.8]), designLevels: { x: 0.5 } }).filter(
        (w) => w.location === 'designLevels',
      ),
    ).toEqual([expect.objectContaining({ rule: 'sheet-param', severity: 'error' })]);
  });

  it('keeps a set that does not settle as no answer, whatever its members’ ranges', () => {
    // `Q` reads the node and the node's relation reads `Q`: one set. At VG = 0.4 V the node finds
    // no crossing in the wiring's range where `Q` stands, which says nothing about the set.
    const coupled = (VG: number): SheetDoc => {
      const d = follower([0.1, 0.8], { VG });
      return {
        ...d,
        params: [
          ...d.params.map((p) =>
            p.name === 'V_x'
              ? { ...p, designConstraint: { lhs: 'V_x + m__vgs - Q', rhs: 'VG - 0.3' } }
              : p,
          ),
          param('Q', 0.3, { unit: '1', min: 0, max: 1, solveFor: 'qx' }),
        ],
        equations: [{ name: 'qx', expr: '0.5*V_x + 0.1' }],
      };
    };
    const r = runSheet(coupled(0.4), t);
    expect(r.solve).toMatchObject({ kind: 'not-settled', why: 'member' });
    expect(errors(r)[0]).toContain("(the author's range inside the wiring's [0, 1.8] V");
    expect(r.point).toMatchObject({ sized: false, state: 'no-answer' });
    expect(r.ranges?.map((x) => [x.param, x.from])).toEqual([
      ['V_x', 'narrowed'],
      ['Q', 'author'],
    ]);
    // `Q` is no wire's level: its range is its author's, with no note.
    expect(r.warnings.filter((w) => w.location === 'Q' && w.rule === 'sheet-range')).toEqual([]);
  });
});
