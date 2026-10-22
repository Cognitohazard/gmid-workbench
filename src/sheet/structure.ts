// The structural well-posedness analysis of a sheet tree: is the sheet a function from its
// decisions to one design, and what does finding that design take?
//
// A sheet evaluates forward. Every relation but a solved one DETERMINES one unknown from the
// unknowns it reads: a decision's value its param, an equation its value, a parent's override
// the child's param, a given a device coordinate, a device's table one quantity from the point
// the sizing placed. The solved relations (a design constraint, a hold) determine nothing: they
// are RESIDUALS, and the params the engine solves are what a one-unknown search inverts on so
// that the residuals vanish. The structural question is therefore about the REDUCED graph:
// which solved params each residual reads, transitively. That graph is matched (Hopcroft–Karp),
// split into its over-determined, under-determined and well-determined parts
// (Dulmage–Mendelsohn), and the well-determined part is ordered into sets (Tarjan). A set of one
// param is one inversion; a set of more is a LOOP, the params reading each other through their
// residuals, which only nested inversions settle.
//
// A device's table relations are per QUANTITY, not per device: a width-invariant quantity of a
// device bound by an operating-point selector (its gate voltage, its saturation voltage) reads the
// selector and the bias, never the current or the width, so a parent reading `in__vgs` does not
// thereby depend on `in__id`. That refinement is what separates two unknowns that are solved one
// after the other from two that read each other.
//
// Read-only and table-free: nothing here evaluates, and nothing an evaluation does reads this.
// Deterministic: every order is the document's. Pure; zero DOM.

import { parse, type ExprNode } from '../expr';
import { BINDABLE, EXTENSIVE, OP_SELECTORS, SIZING_SCALARS } from '../device';
import { BASE_KEYS, DERIVED_QUANTITIES, PER_WIDTH_KEYS } from '../namespace';
import { CONSTANTS } from '../constants';
import {
  DEVICE_NAMES,
  MAX_BLOCK_DEPTH,
  META_PUBLISHED,
  PATH_SEP,
  balancesOf,
  blockOverride,
  engineSolved,
  heldOnGate,
  holds,
  namesOf,
  splitProvide,
  type SheetBlock,
  type SheetDoc,
  type SheetGivens,
  type SheetVar,
} from './types';
import { solvedRelation } from './validate';
import { resolvedSheet, type SheetRefIndex } from './resolve';

/** Which design the graph describes: the one sized at the design point, or that design held at
 *  its geometry and re-biased (the form a range end or another process condition evaluates). */
export type StructureMode = 'size' | 'verify';

export type UnknownKind = 'param' | 'equation' | 'device';

export type RelationKind =
  | 'value'
  | 'constraint'
  | 'hold'
  | 'equation'
  | 'override'
  | 'given'
  | 'diode'
  | 'default'
  | 'fixed'
  | 'table';

export interface StructureUnknown {
  /** `p:`, `e:` or `d:` plus the qualified name, so a param and a device quantity of one name
   *  stay apart. */
  id: string;
  kind: UnknownKind;
  /** The block path prefix the unknown belongs to: `''` at the top, `in.` for a child. */
  level: string;
  /** The qualified name, as a message shows it. */
  name: string;
  /** A param the engine solves (a design constraint or a solveFor), or in verify mode a hold's
   *  param: an unknown no relation determines, found by a search in the range the author states. */
  solved?: boolean;
}

export interface StructureRelation {
  id: string;
  kind: RelationKind;
  level: string;
  /** What the relation is about: the param, equation or quantity it determines in the author's
   *  reading. */
  about: string;
  /** The unknown it determines when evaluated forward; `null` for a solved relation, which
   *  determines nothing and is a residual. */
  determines: string | null;
  /** The unknowns it reads, including the one it determines. */
  reads: string[];
}

/** The input decomposeGraph takes: unknowns, and relations each naming the unknowns it reads. */
export interface StructureGraph {
  unknowns: readonly string[];
  relations: readonly { id: string; reads: readonly string[] }[];
}

export interface Decomposition {
  /** Unknown → the relation it is matched to. */
  matching: ReadonlyMap<string, string>;
  /** Relations in the over-determined part: the ones left over, and every relation an
   *  alternating path from one reaches. Empty for a square graph. */
  over: string[];
  /** Unknowns in the under-determined part: nothing determines them. Empty for a square graph. */
  under: string[];
  /** The well-determined part as strongly connected components, dependencies first: the order a
   *  block-triangular evaluation takes. */
  components: string[][];
}

/** One step of the inversion order: the solved params that are found together, and the residuals
 *  that pin them. One param is one inversion; more is a loop. */
export interface StructureSet {
  params: string[];
  relations: string[];
}

/** "Make `decide` a decision; `derive` becomes derived": the swap of which quantity carries a
 *  value, and the sizes of the loops that remain after it. */
export interface StructureSuggestion {
  decide: string;
  derive: string;
  loops: number[];
}

export interface StructureReport {
  mode: StructureMode;
  assume: StructureAssumption[];
  unknowns: StructureUnknown[];
  relations: StructureRelation[];
  /** Each solved relation → the solved params it reads, transitively: the reduced graph. */
  depends: Record<string, string[]>;
  /** Solved relations in the over-determined part of the reduced graph: no solved param is left
   *  for them to pin. A conflict. */
  over: string[];
  /** Free unknowns: a coordinate nothing places (a device with no drain voltage stated), then the
   *  solved params in the under-determined part, which no solved relation is left to pin. */
  under: string[];
  /** The well-determined part in the order the inversions run, dependencies first. */
  sets: StructureSet[];
  /** Each solved relation → the param it is paired with, or its loop joined with `+`. */
  pairing: Record<string, string>;
  /** Determined unknowns that read themselves through others: circular definitions, which no
   *  forward evaluation computes. Each cycle in document order. */
  cycles: string[][];
  /** Names an expression reads that resolve to nothing on the sheet, qualified. */
  unresolved: string[];
  /** Top-level implementation knobs at the author's values: `choice` decisions the engine does
   *  not solve. */
  defaulted: string[];
  /** Params classed `assumed`, qualified. */
  assumed: string[];
  /** The degrees of freedom the sheet leaves open: the size of the under-determined part. */
  dof: number;
  suggestions: StructureSuggestion[];
}

/** A designer's simplification with an exact graph meaning: each deletes couplings, so the
 *  analysis under it says which loops the simplification breaks. `fixed-vds-lookups` is the
 *  first one under the name a lookup convention gives it. */
export type StructureAssumption =
  'no-channel-length-modulation' | 'no-body-effect' | 'ideal-mirrors' | 'fixed-vds-lookups';

export const STRUCTURE_ASSUMPTIONS: readonly StructureAssumption[] = [
  'no-channel-length-modulation',
  'no-body-effect',
  'ideal-mirrors',
  'fixed-vds-lookups',
];

export interface StructureOptions {
  mode?: StructureMode;
  /** The sheet library, to materialize by-reference children first. */
  refs?: SheetRefIndex;
  /** Simplifications to analyse under: a device quantity loses its drain-voltage edge under
   *  `no-channel-length-modulation` (or `fixed-vds-lookups`) and its body-bias edge under
   *  `no-body-effect`; under `ideal-mirrors` the current of a device that copies another's gate
   *  voltage and width reads that device's current and the ratio, not the table. */
  assume?: readonly StructureAssumption[];
}

// ---------------------------------------------------------------------------------------------
// Width law of a quantity: what a device's table relation for it reads.

type Degree = number | null; // null: a sum of unlike degrees, read as width-dependent

/** The width degree of an expression over the base namespace: a per-width base is degree one, a
 *  voltage or a constant zero; products add, quotients subtract, a sum of unlike degrees is
 *  `null`. Degree zero is width-invariant. */
function degree(n: ExprNode): Degree {
  switch (n.type) {
    case 'Literal':
      return 0;
    case 'Identifier':
      return PER_WIDTH_KEYS.has(n.name) ? 1 : 0;
    case 'UnaryExpression':
      return degree(n.argument);
    case 'BinaryExpression': {
      const a = degree(n.left);
      const b = degree(n.right);
      if (a === null || b === null) return null;
      switch (n.operator) {
        case '*':
          return a + b;
        case '/':
          return a - b;
        case '+':
        case '-':
          return a === b ? a : null;
        case '^':
          if (n.right.type === 'Literal' && typeof n.right.value === 'number')
            return a * n.right.value;
          return a === 0 && b === 0 ? 0 : null;
        default:
          return a === 0 && b === 0 ? 0 : null;
      }
    }
    case 'CallExpression': {
      const args = n.arguments.map(degree);
      if (args.some((d) => d === null)) return null;
      const ds = args as number[];
      const name = n.callee.type === 'Identifier' ? n.callee.name : '';
      if (name === 'sqrt') return ds[0] / 2;
      if (name === 'abs' || name === 'min' || name === 'max' || name === 'par')
        return ds.every((d) => d === ds[0]) ? ds[0] : null;
      return ds.every((d) => d === 0) ? 0 : null;
    }
    case 'ConditionalExpression': {
      const a = degree(n.consequent);
      const b = degree(n.alternate);
      return a !== null && a === b ? a : null;
    }
  }
}

const INVARIANCE = new Map<string, boolean>();

/**
 * Whether a device quantity is width-invariant: a terminal voltage, a ratio of per-width
 * quantities, a sizing scalar. Read off the namespace — a derived quantity's own definition
 * decides — so a quantity added there is classed without a list here. A name the namespace does
 * not know (a pass-through column) is read as width-dependent, the safe direction: it then reads
 * the width, and a loop through it is reported rather than missed.
 */
export function widthInvariant(q: string): boolean {
  const hit = INVARIANCE.get(q);
  if (hit !== undefined) return hit;
  let out: boolean;
  if (q === 'W' || PER_WIDTH_KEYS.has(q)) out = false;
  else if (BASE_KEYS.has(q) || META_PUBLISHED.has(q)) out = true;
  else if ((SIZING_SCALARS as readonly string[]).includes(q)) out = true;
  else {
    const def = DERIVED_QUANTITIES.find((d) => d.key === q);
    if (!def) out = false;
    else {
      try {
        out = degree(parse(def.expr)) === 0;
      } catch {
        out = false;
      }
    }
  }
  INVARIANCE.set(q, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The bipartite graph of a sheet tree.

interface Level {
  doc: SheetDoc;
  /** `''` at the top, `in.` below, like the validator's level paths. */
  path: string;
  block?: SheetBlock;
  parent?: Level;
  kids: Map<string, Level>;
}

function levelsOf(doc: SheetDoc): Level[] {
  const out: Level[] = [];
  const enroll = (lv: Level, depth: number): void => {
    out.push(lv);
    if (depth >= MAX_BLOCK_DEPTH) return;
    for (const block of Array.isArray(lv.doc.blocks) ? lv.doc.blocks : []) {
      if (!block.doc || lv.kids.has(block.name)) continue;
      const kid: Level = {
        doc: block.doc,
        path: `${lv.path}${block.name}${PATH_SEP}`,
        block,
        parent: lv,
        kids: new Map(),
      };
      lv.kids.set(block.name, kid);
      enroll(kid, depth + 1);
    }
  };
  enroll({ doc, path: '', kids: new Map() }, 0);
  return out;
}

/** The table scalars a sizing writes over with the sized device's own (the width `w`). */
const SIZED_META: ReadonlySet<string> = new Set(
  [...META_PUBLISHED].filter((k) => PER_WIDTH_KEYS.has(k)),
);

const SELECTORS: ReadonlySet<string> = new Set(OP_SELECTORS);
const EXTENSIVES: ReadonlySet<string> = new Set(EXTENSIVE);

/** The device coordinates every sized device has as unknowns, whatever its givens name. */
const COORDINATES: readonly string[] = ['L', 'vgs', 'vds', 'vsb', 'W', 'id'];

class Builder {
  readonly unknowns = new Map<string, StructureUnknown>();
  readonly relations: StructureRelation[] = [];
  readonly unresolved = new Set<string>();
  /** Per level, the device quantities something reads, so each gets a table relation. */
  readonly refs = new Map<Level, Set<string>>();
  readonly assume: ReadonlySet<StructureAssumption>;

  constructor(
    readonly mode: StructureMode,
    assume: readonly StructureAssumption[] = [],
  ) {
    this.assume = new Set(assume);
  }

  unknown(id: string, kind: UnknownKind, level: string, name: string, solved = false): string {
    if (!this.unknowns.has(id)) this.unknowns.set(id, { id, kind, level, name, solved });
    else if (solved) (this.unknowns.get(id) as StructureUnknown).solved = true;
    return id;
  }

  /** A relation determining `determines` (`null`: a residual) from `reads`, which lists the
   *  determined unknown first. */
  relation(
    id: string,
    kind: RelationKind,
    level: string,
    about: string,
    determines: string | null,
    reads: string[],
  ): void {
    this.relations.push({
      id,
      kind,
      level,
      about,
      determines,
      reads: [...new Set(determines === null ? reads : [determines, ...reads])],
    });
  }

  param(lv: Level, name: string, solved = false): string {
    return this.unknown(`p:${lv.path}${name}`, 'param', lv.path, `${lv.path}${name}`, solved);
  }

  equation(lv: Level, name: string): string {
    return this.unknown(`e:${lv.path}${name}`, 'equation', lv.path, `${lv.path}${name}`);
  }

  device(lv: Level, q: string): string {
    let set = this.refs.get(lv);
    if (!set) this.refs.set(lv, (set = new Set()));
    set.add(q);
    return this.unknown(`d:${lv.path}${q}`, 'device', lv.path, `${lv.path}${q}`);
  }

  /**
   * The unknown a name read at `lv` stands for, or undefined for a name that is no unknown: a
   * constant, a table scalar, or a name nothing on the sheet provides (recorded as unresolved).
   * A name means the first of: a param, an equation, a scalar a child provides (an alias into the
   * child), a quantity of the level's own sized device, a table scalar. `post` says the name is
   * read after the level's sizing, when the width `w` is the sized device's; `deviceOk` is false
   * for a parent's override, which the engine evaluates before the parent's own device exists.
   */
  resolve(lv: Level, name: string, post: boolean, deviceOk: boolean): string | undefined {
    if (lv.doc.params.some((p) => p.name === name)) return this.param(lv, name);
    if (lv.doc.equations.some((e) => e.name === name)) return this.equation(lv, name);
    const split = splitProvide(name);
    if (split) {
      const kid = lv.kids.get(split[0]);
      if (kid && (kid.doc.provides ?? []).includes(split[1]))
        return this.resolve(kid, split[1], true, true);
      this.unresolved.add(`${lv.path}${name}`);
      return undefined;
    }
    const sized = !!lv.doc.givens && deviceOk;
    if (sized && post && SIZED_META.has(name)) return this.device(lv, name);
    if (META_PUBLISHED.has(name)) return undefined;
    if (sized && DEVICE_NAMES.has(name)) return this.device(lv, name);
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return undefined;
    this.unresolved.add(`${lv.path}${name}`);
    return undefined;
  }

  reads(lv: Level, expr: unknown, post: boolean, deviceOk = true): string[] {
    const out: string[] = [];
    for (const n of namesOf(expr)) {
      const id = this.resolve(lv, n, post, deviceOk);
      if (id !== undefined) out.push(id);
    }
    return out;
  }
}

/** Whether the parent's own holds balance this level's device current (see heldOnGate). */
const parentBalances = (lv: Level): boolean =>
  !!lv.parent && !!lv.block && balancesOf(lv.parent.doc).has(lv.block.name);

/** The relations of one level's params and equations. */
function algebra(b: Builder, lv: Level): void {
  const P = lv.path;
  for (const p of lv.doc.params) {
    const solved = engineSolved(p);
    const held = b.mode === 'verify' && holds(p);
    const u = b.param(lv, p.name, solved || held);
    if (solved) {
      const rel = solvedRelation(p) as { lhs: string; rhs: string };
      b.relation(`c:${P}${p.name}`, 'constraint', P, `${P}${p.name}`, null, [
        ...b.reads(lv, rel.lhs, true),
        ...b.reads(lv, rel.rhs, true),
      ]);
      continue;
    }
    if (held) {
      b.relation(`h:${P}${p.name}`, 'hold', P, `${P}${p.name}`, null, b.reads(lv, p.hold, true));
      continue;
    }
    const over = lv.block && lv.parent ? blockOverride(lv.block, p.name) : undefined;
    if (over !== undefined && lv.parent) {
      b.relation(
        `o:${P}${p.name}`,
        'override',
        P,
        `${P}${p.name}`,
        u,
        b.reads(lv.parent, over, false, false),
      );
      continue;
    }
    b.relation(`v:${P}${p.name}`, 'value', P, `${P}${p.name}`, u, []);
  }
  for (const e of lv.doc.equations) {
    const u = b.equation(lv, e.name);
    b.relation(`e:${P}${e.name}`, 'equation', P, `${P}${e.name}`, u, b.reads(lv, e.expr, true));
  }
}

/**
 * The relations of one level's sized device: its givens, and one table relation per quantity
 * something reads. Which quantities a relation reads follows the sizing: a bound selector places
 * the operating point, so the gate voltage reads it and the bias; the width reads the extensive
 * given at that point; every other quantity reads the gate voltage and the bias, and the width
 * too when it scales with the width. In verify mode the givens are first rewritten the way a
 * fixed-hardware run rewrites them (see holdHardware): the geometry fixed, the operating-point
 * target dropped, a tied gate or an authored current kept, a current nobody authored fixed.
 */
function device(b: Builder, lv: Level): void {
  const g = lv.doc.givens as SheetGivens;
  const P = lv.path;
  const d = (q: string): string => b.device(lv, q);
  for (const q of COORDINATES) d(q);

  // What the givens state, after the verify-mode rewrite.
  let supplied = (BINDABLE as readonly string[]).filter(
    (k) => (g as unknown as Record<string, unknown>)[k] !== undefined,
  );
  const fixed = new Set<string>();
  if (b.mode === 'verify' && g.W === undefined) {
    fixed.add('L').add('W');
    if (heldOnGate(lv.doc, parentBalances(lv))) supplied = ['vgs'];
    else if (g.id !== undefined) supplied = ['id'];
    else {
      supplied = [];
      fixed.add('id');
    }
  }
  for (const k of fixed) b.relation(`f:${P}${k}`, 'fixed', P, `${P}${k}`, d(k), []);
  if (!fixed.has('L')) b.relation(`g:${P}L`, 'given', P, `${P}L`, d('L'), b.reads(lv, g.L, false));
  for (const k of supplied) {
    const expr = (g as unknown as Record<string, unknown>)[k];
    b.relation(`g:${P}${k}`, 'given', P, `${P}${k}`, d(k), b.reads(lv, expr, false));
  }
  if (g.diode === true) b.relation(`g:${P}diode`, 'diode', P, `${P}vds`, d('vds'), [d('vgs')]);
  else if (g.vds !== undefined)
    b.relation(`g:${P}vds`, 'given', P, `${P}vds`, d('vds'), b.reads(lv, g.vds, false));
  if (g.vsb !== undefined)
    b.relation(`g:${P}vsb`, 'given', P, `${P}vsb`, d('vsb'), b.reads(lv, g.vsb, false));
  else b.relation(`g:${P}vsb`, 'default', P, `${P}vsb`, d('vsb'), []);

  // The table relations. What places the operating point: the selector, or the two extensive
  // quantities the point lies between.
  const placed = new Set<string>([...supplied, ...fixed]);
  const selector = supplied.find((k) => SELECTORS.has(k));
  const placers =
    selector !== undefined ? [selector] : [...placed].filter((k) => EXTENSIVES.has(k));
  // A diode-connected device is read on the table's vds = vgs diagonal, folded before sizing:
  // its quantities read the gate voltage and the body bias, and the diode relation sets the
  // drain from the gate. Reading the drain too would draw a loop the fold does not have. Under
  // the assumptions, a quantity stops reading the drain voltage or the body bias.
  const noVds =
    g.diode === true ||
    b.assume.has('no-channel-length-modulation') ||
    b.assume.has('fixed-vds-lookups');
  const noVsb = b.assume.has('no-body-effect');
  const bias = [d('L'), ...(noVds ? [] : [d('vds')]), ...(noVsb ? [] : [d('vsb')])];
  if (!placed.has('vgs'))
    b.relation(`t:${P}vgs`, 'table', P, `${P}vgs`, d('vgs'), [...bias, ...placers.map(d)]);
  const extensive = [...placed].find((k) => k !== 'W' && EXTENSIVES.has(k));
  if (!placed.has('W'))
    b.relation(`t:${P}W`, 'table', P, `${P}W`, d('W'), [
      d('vgs'),
      ...bias,
      ...(extensive === undefined ? [] : [d(extensive)]),
    ]);
  // Under ideal mirrors, a device that copies another's gate voltage and width carries that
  // device's current times the ratio: its current reads the reference's and the ratio's params,
  // never the table. The reference is the one device the gate-voltage given names, read through
  // the level's own param when the parent's override is what names it (`vgs_l: "ldr__vgs"`).
  const through = (ids: string[]): string[] =>
    ids.flatMap((id) => {
      if (!id.startsWith('p:')) return [id];
      const over = b.relations.find((r) => r.kind === 'override' && r.determines === id);
      return over ? over.reads.filter((u) => u !== id) : [id];
    });
  const copied = (k: 'vgs' | 'W'): string[] =>
    supplied.includes(k)
      ? through(b.reads(lv, (g as unknown as Record<string, unknown>)[k], false))
      : [];
  const gateOf = copied('vgs').filter((u) => u.startsWith('d:') && u.endsWith('vgs'));
  const widthOf = copied('W');
  const reference = gateOf.length === 1 ? gateOf[0].slice(0, -'vgs'.length) : undefined;
  const mirrored =
    b.assume.has('ideal-mirrors') &&
    reference !== undefined &&
    !placed.has('id') &&
    (fixed.has('W') || widthOf.includes(`${reference}W`));
  if (mirrored) {
    b.relation(`t:${P}id`, 'table', P, `${P}id`, d('id'), [
      `${reference}id`,
      ...widthOf.filter((u) => u !== `${reference}W`),
    ]);
  }
  // Every other quantity read, and the current whether or not something reads it: the point
  // placed, the table answers it.
  const refs = new Set(['id', ...(b.refs.get(lv) ?? [])]);
  for (const q of [...refs].sort()) {
    if (placed.has(q) || COORDINATES.includes(q) !== (q === 'id')) continue;
    if (q === 'id' && mirrored) continue;
    if (SIZED_META.has(q)) {
      // The sized device's own scalar: its width, after the sizing.
      b.relation(`t:${P}${q}`, 'table', P, `${P}${q}`, d(q), [d('W')]);
      continue;
    }
    b.relation(`t:${P}${q}`, 'table', P, `${P}${q}`, d(q), [
      d('vgs'),
      ...bias,
      ...(widthInvariant(q) ? [] : [d('W')]),
    ]);
  }
}

/** The graph of a resolved document in one mode, with the levels it was built from. */
function build(
  doc: SheetDoc,
  mode: StructureMode,
  assume: readonly StructureAssumption[],
): { b: Builder; levels: Level[] } {
  const b = new Builder(mode, assume);
  const levels = levelsOf(doc);
  for (const lv of levels) algebra(b, lv);
  // Second pass: the table relations need every quantity anything reads, and a parent reads a
  // child's quantities through its provides.
  for (const lv of levels) if (lv.doc.givens) device(b, lv);
  return { b, levels };
}

// ---------------------------------------------------------------------------------------------
// Matching and decomposition.

/**
 * A maximum matching (Hopcroft–Karp) and the Dulmage–Mendelsohn decomposition it induces.
 * `prefer` seeds the matching with relation → unknown pairs to try first, so a solved param's
 * own relation is matched to it where a maximum matching allows; the parts and the components do
 * not depend on which maximum matching is found.
 */
export function decomposeGraph(
  g: StructureGraph,
  prefer?: ReadonlyMap<string, string>,
): Decomposition {
  const known = new Set(g.unknowns);
  const adjR = new Map<string, string[]>();
  const adjU = new Map<string, string[]>();
  for (const u of g.unknowns) adjU.set(u, []);
  for (const r of g.relations) {
    const reads = [...new Set(r.reads)].filter((u) => known.has(u));
    adjR.set(r.id, reads);
    for (const u of reads) (adjU.get(u) as string[]).push(r.id);
  }
  const matchU = new Map<string, string>();
  const matchR = new Map<string, string>();
  if (prefer)
    for (const [r, u] of prefer)
      if (
        adjR.has(r) &&
        !matchR.has(r) &&
        !matchU.has(u) &&
        (adjR.get(r) as string[]).includes(u)
      ) {
        matchR.set(r, u);
        matchU.set(u, r);
      }

  // Hopcroft–Karp, unknowns on the left.
  const INF = Number.POSITIVE_INFINITY;
  const dist = new Map<string, number>();
  const bfs = (): boolean => {
    const queue: string[] = [];
    let found = false;
    for (const u of g.unknowns) {
      if (!matchU.has(u)) {
        dist.set(u, 0);
        queue.push(u);
      } else dist.set(u, INF);
    }
    for (let i = 0; i < queue.length; i++) {
      const u = queue[i];
      for (const r of adjU.get(u) as string[]) {
        const v = matchR.get(r);
        if (v === undefined) found = true;
        else if (dist.get(v) === INF) {
          dist.set(v, (dist.get(u) as number) + 1);
          queue.push(v);
        }
      }
    }
    return found;
  };
  const dfs = (u: string): boolean => {
    for (const r of adjU.get(u) as string[]) {
      const v = matchR.get(r);
      if (v === undefined || (dist.get(v) === (dist.get(u) as number) + 1 && dfs(v))) {
        matchU.set(u, r);
        matchR.set(r, u);
        return true;
      }
    }
    dist.set(u, INF);
    return false;
  };
  while (bfs()) for (const u of g.unknowns) if (!matchU.has(u)) dfs(u);

  // Dulmage–Mendelsohn: the under-determined part is what alternating paths from unmatched
  // unknowns reach (unknown → any relation → its matched unknown); the over-determined part is
  // what they reach from unmatched relations (relation → any unknown → its matched relation).
  const under = new Set<string>();
  {
    const queue = g.unknowns.filter((u) => !matchU.has(u));
    for (const u of queue) under.add(u);
    for (let i = 0; i < queue.length; i++)
      for (const r of adjU.get(queue[i]) as string[]) {
        const v = matchR.get(r);
        if (v !== undefined && !under.has(v)) {
          under.add(v);
          queue.push(v);
        }
      }
  }
  const over = new Set<string>();
  const overU = new Set<string>();
  {
    const queue = g.relations.map((r) => r.id).filter((r) => !matchR.has(r));
    for (const r of queue) over.add(r);
    for (let i = 0; i < queue.length; i++)
      for (const u of adjR.get(queue[i]) as string[]) {
        overU.add(u);
        const r = matchU.get(u);
        if (r !== undefined && !over.has(r)) {
          over.add(r);
          queue.push(r);
        }
      }
  }

  // The well-determined part: unknown u reads u' when its matched relation does.
  const well = g.unknowns.filter((u) => !under.has(u) && !overU.has(u));
  const wellSet = new Set(well);
  const edges = new Map<string, string[]>();
  for (const u of well) {
    const r = matchU.get(u) as string;
    edges.set(
      u,
      (adjR.get(r) as string[]).filter((v) => v !== u && wellSet.has(v)),
    );
  }
  return {
    matching: matchU,
    over: g.relations.map((r) => r.id).filter((r) => over.has(r)),
    under: g.unknowns.filter((u) => under.has(u)),
    components: tarjan(well, edges),
  };
}

/** Strongly connected components, emitted dependencies first: a component is emitted once every
 *  component it reads has been. Iterative, so a long chain cannot overflow the stack. */
function tarjan(nodes: readonly string[], edges: ReadonlyMap<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  // Document order inside a component, so a report reads the way the sheet does.
  const rank = new Map(nodes.map((n, i) => [n, i]));
  let next = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const frames: { v: string; i: number }[] = [{ v: root, i: 0 }];
    index.set(root, next);
    low.set(root, next);
    next++;
    stack.push(root);
    onStack.add(root);
    while (frames.length) {
      const f = frames[frames.length - 1];
      const succ = edges.get(f.v) ?? [];
      if (f.i < succ.length) {
        const w = succ[f.i++];
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next);
          next++;
          stack.push(w);
          onStack.add(w);
          frames.push({ v: w, i: 0 });
        } else if (onStack.has(w))
          low.set(f.v, Math.min(low.get(f.v) as number, index.get(w) as number));
      } else {
        frames.pop();
        if (frames.length) {
          const p = frames[frames.length - 1].v;
          low.set(p, Math.min(low.get(p) as number, low.get(f.v) as number));
        }
        if (low.get(f.v) === index.get(f.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop() as string;
            onStack.delete(w);
            comp.push(w);
          } while (w !== f.v);
          comp.sort((a, b) => (rank.get(a) as number) - (rank.get(b) as number));
          out.push(comp);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The reduced graph: what each residual reads, transitively, through the forward evaluation.

/** Everything reachable from `start` along `reads`, `start` included. */
function closure(
  start: readonly string[],
  reads: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const seen = new Set<string>(start);
  const queue = [...start];
  for (let i = 0; i < queue.length; i++)
    for (const v of reads.get(queue[i]) ?? [])
      if (!seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
  return seen;
}

/** The forward evaluation as a graph: each determined unknown → what its relation reads, and
 *  each residual → what it reads. An unknown no relation determines (a solved param) reads
 *  nothing. */
function forward(relations: readonly StructureRelation[]): {
  reads: Map<string, string[]>;
  residuals: Map<string, string[]>;
} {
  const reads = new Map<string, string[]>();
  const residuals = new Map<string, string[]>();
  for (const r of relations) {
    if (r.determines === null) residuals.set(r.id, r.reads);
    else
      reads.set(
        r.determines,
        r.reads.filter((u) => u !== r.determines),
      );
  }
  return { reads, residuals };
}

/** The reduced graph over one choice of solved params, decomposed. `fanin` is each residual's
 *  closure; the relations read the solved params in that closure, in document order. */
function reduce(
  fanin: ReadonlyMap<string, ReadonlySet<string>>,
  solved: readonly string[],
  prefer: ReadonlyMap<string, string>,
): { graph: StructureGraph; d: Decomposition } {
  const graph: StructureGraph = {
    unknowns: solved,
    relations: [...fanin].map(([id, f]) => ({ id, reads: solved.filter((s) => f.has(s)) })),
  };
  return { graph, d: decomposeGraph(graph, prefer) };
}

/** The sets of a decomposition of the reduced graph: each component with the residuals matched
 *  into it. */
function setsOf(graph: StructureGraph, d: Decomposition): StructureSet[] {
  return d.components.map((params) => ({
    params: [...params],
    relations: graph.relations
      .map((r) => r.id)
      .filter((r) => params.some((p) => d.matching.get(p) === r)),
  }));
}

const loopSizes = (sets: readonly StructureSet[]): number[] =>
  sets.filter((s) => s.params.length > 1).map((s) => s.params.length);

/** How many re-pairings a report lists for one loop, and in all. */
const SUGGESTIONS_PER_LOOP = 4;
const SUGGESTIONS_TOTAL = 12;

/**
 * Re-pairings that shrink a loop: for a solved param in it and a top-level decision its residuals
 * read, give the former a value and take the latter's away — "make U a decision; D becomes
 * derived" — and keep the swap when the reduced graph stays square and the largest loop is
 * smaller, or a loop is gone.
 */
function suggestions(
  sets: readonly StructureSet[],
  fanin: ReadonlyMap<string, ReadonlySet<string>>,
  solved: readonly string[],
  unknowns: ReadonlyMap<string, StructureUnknown>,
  decided: readonly string[],
  prefer: ReadonlyMap<string, string>,
): StructureSuggestion[] {
  const before = loopSizes(sets);
  if (!before.length) return [];
  const worst = Math.max(...before);
  const out: StructureSuggestion[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    if (set.params.length < 2) continue;
    const reached = new Set<string>();
    for (const r of set.relations) for (const u of fanin.get(r) ?? []) reached.add(u);
    const decisions = decided.filter((u) => reached.has(u));
    let found = 0;
    for (const decide of set.params) {
      for (const derive of decisions) {
        if (found >= SUGGESTIONS_PER_LOOP || out.length >= SUGGESTIONS_TOTAL) break;
        const key = `${decide}|${derive}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const swapped = [...solved.filter((s) => s !== decide), derive];
        const { graph, d } = reduce(fanin, swapped, prefer);
        if (d.over.length || d.under.length) continue;
        const after = loopSizes(setsOf(graph, d));
        const most = after.length ? Math.max(...after) : 0;
        const better = most < worst || (most <= worst && after.length < before.length);
        if (!better) continue;
        out.push({
          decide: unknowns.get(decide)?.name ?? decide,
          derive: unknowns.get(derive)?.name ?? derive,
          loops: after,
        });
        found++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The report.

/**
 * The structural analysis of a sheet tree in one mode. References are materialized first when
 * `refs` is given; a block left unresolved contributes nothing, and names read into it resolve to
 * nothing. Pure: reads the document, returns a report.
 */
export function analyzeStructure(doc: SheetDoc, opts: StructureOptions = {}): StructureReport {
  const mode = opts.mode ?? 'size';
  const resolved = resolvedSheet(doc, opts.refs).doc;
  const { b, levels } = build(resolved, mode, opts.assume ?? []);
  const { reads, residuals } = forward(b.relations);

  // Circular definitions: determined unknowns reading themselves through others.
  const determined = [...reads.keys()];
  const determinedSet = new Set(determined);
  const inner = new Map(
    determined.map((u) => [u, (reads.get(u) as string[]).filter((v) => determinedSet.has(v))]),
  );
  const cycles = tarjan(determined, inner).filter((c) => c.length > 1);
  // An unknown no relation determines and no search finds.
  const unplaced = [...b.unknowns.values()]
    .filter((u) => !u.solved && !reads.has(u.id))
    .map((u) => u.id);

  // The reduced graph: each residual → its closure; the solved params in document order.
  const fanin = new Map<string, Set<string>>();
  for (const [id, r] of residuals) fanin.set(id, closure(r, reads));
  const solved = [...b.unknowns.values()].filter((u) => u.solved).map((u) => u.id);
  // A solved relation is tried against its own param first, so the pairing reads as authored.
  const prefer = new Map<string, string>();
  for (const r of b.relations) if (r.determines === null) prefer.set(r.id, `p:${r.about}`);
  const { graph, d } = reduce(fanin, solved, prefer);
  const sets = setsOf(graph, d);

  const depends: Record<string, string[]> = {};
  for (const r of graph.relations) depends[r.id] = [...r.reads];
  const pairing: Record<string, string> = {};
  for (const set of sets) for (const r of set.relations) pairing[r] = set.params.join('+');

  // The decisions a loop could trade for one of its params: the top level's, a convention
  // excepted; the ones with a stated range first, since a derived param needs one.
  const top = resolved.params.filter(
    (p) => !engineSolved(p) && !(mode === 'verify' && holds(p)) && p.convention === undefined,
  );
  const ranged = (p: SheetVar): boolean => typeof p.min === 'number' && typeof p.max === 'number';
  const decided = [...top.filter(ranged), ...top.filter((p) => !ranged(p))].map(
    (p) => `p:${p.name}`,
  );
  const defaulted = resolved.params
    .filter((p) => p.role === 'choice' && !engineSolved(p))
    .map((p) => p.name);
  const assumed: string[] = [];
  for (const lv of levels)
    for (const p of lv.doc.params as SheetVar[])
      if (p.class === 'assumed') assumed.push(`${lv.path}${p.name}`);

  return {
    mode,
    assume: [...(opts.assume ?? [])],
    unknowns: [...b.unknowns.values()],
    relations: b.relations,
    depends,
    over: d.over,
    under: [...unplaced, ...d.under],
    sets,
    pairing,
    cycles,
    unresolved: [...b.unresolved].sort(),
    defaulted,
    assumed,
    dof: unplaced.length + d.under.length,
    suggestions: suggestions(sets, fanin, solved, b.unknowns, decided, prefer),
  };
}

/** One line per report, the shape the library census pins: counts, the loops by size, and the
 *  sets in order with each loop's params joined by `+`. */
export function summarizeStructure(r: StructureReport): string {
  const order = r.sets.map((s) => s.params.map((p) => p.slice(2)).join('+')).join(' ');
  return (
    `${r.unknowns.length} unknowns, ${r.relations.length} relations; solved ${r.sets.reduce(
      (n, s) => n + s.params.length,
      0,
    )}; over ${r.over.length}, under ${r.under.length}; loops [${loopSizes(r.sets).join(' ')}]; ` +
    `cycles ${r.cycles.length}; unresolved ${r.unresolved.length}; defaulted ${r.defaulted.length}; ` +
    `suggestions ${r.suggestions.length}; order ${order}`
  );
}
