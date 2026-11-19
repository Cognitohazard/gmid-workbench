// The outcome of one evaluation as a list of items, each with one status: ok, failed with exactly
// one cause from a closed list, or withheld because it depends on items that failed. The verdict is
// read from the list by four rules. Pure data and pure functions: what a reader sees is built from
// these in one place (describe.ts), never written by the code that produces them.

import type { NetlistAbout, OutsideTable } from '../types';
import type { CheckKind, CheckOp, SolveRange } from './types';

/** What an item is: the sheet itself (always the first item of a result), a value (a param or an
 *  equation), a device, a search (one solved param), or a requirement (a check). */
export type ItemKind = 'sheet' | 'value' | 'device' | 'search' | 'requirement';

/** Where an item is: the names of the blocks from the top sheet down to the sheet that owns it
 *  (empty for the top sheet's own), and its name there — a param's or an equation's name, a
 *  check's id, a solved param's name, `givens` for a sheet's own device, empty for the sheet. */
export interface ItemRef {
  readonly kind: ItemKind;
  readonly path: readonly string[];
  readonly name: string;
}

// ── The causes ────────────────────────────────────────────────────────────────────────────────
//
// Each cause is an identifier with typed data. A cause carries no sentence of its own beyond the
// evaluation's own findings it quotes (`reason` fields, the words another part of the evaluation
// used for why something did not evaluate).

/** A sheet that could not be read: an unknown format, a reference that does not resolve, a field
 *  that is malformed. `message` is the reading code's own sentence (see describe.ts). */
export interface NotReadData {
  readonly why: 'format' | 'reference' | 'field';
  readonly where: string;
  readonly message: string;
  /** For a format this app does not read: the version the document declares. */
  readonly declared?: unknown;
  /** For a finding whose rule the finding table does not list: that rule. */
  readonly rule?: string;
  /** For a field that is not well formed: the kind of entry it is in, as its rule knows it. */
  readonly entry?:
    'param' | 'selector' | 'check' | 'tolerance' | 'device' | 'block' | 'expression' | 'range-end';
  /** Set where the finding came from validating the document before it was evaluated, rather
   *  than from the evaluation. */
  readonly stage?: 'validation';
}

/** A sheet whose decisions do not determine one design: one missing, one made twice, or a level
 *  it marks as assumed. `names` are the params or wires involved. */
/** A read beyond a device's table, with the value on the sheet that sets the quantity it asked
 *  for, where that is one value the designer types. */
export type OutsideTableData = OutsideTable & { readonly setBy?: string };

export interface NotDeterminedData {
  readonly why:
    | 'decision-missing'
    | 'decision-twice'
    | 'assumed-level'
    | 'range-outside'
    | 'netlist'
    | 'loop'
    | 'operating-range'
    | 'entry';
  readonly names: readonly string[];
  readonly message: string;
  /** For a search range outside the range its wires permit: each range, and the wires'. */
  readonly ranges?: readonly {
    readonly name: string;
    readonly unit?: string;
    readonly search: readonly [number, number];
    readonly wires: readonly [number, number];
  }[];
  /** For a finding of the netlist check: which problem, and the wires and devices it is about
   *  (devices by block path, `givens` for the sheet's own); for a selector, the param. */
  readonly netlist?: NetlistAbout;
  /** For a range end that holds a value the design run did not record: the values. */
  readonly unheld?: readonly string[];
  /** As NotReadData.stage. */
  readonly stage?: 'validation';
}

/** Something that gives no number: the table lacks a sweep or a column, the two bound quantities
 *  are not a legal pair, or an expression gives no finite number. `name` is the quantity, column or
 *  expression; `reason` is the evaluation's own words for it. */
export interface CannotEvaluateData {
  readonly why: 'no-sweep' | 'no-column' | 'illegal-pair' | 'not-finite' | 'not-defined' | 'syntax';
  readonly name: string;
  readonly reason: string;
  /** For a requirement: which side gave no number. */
  readonly side?: 'lhs' | 'rhs' | 'both';
  /** For a check: the name each side reads that no entry declares. */
  readonly sides?: { readonly lhs?: string; readonly rhs?: string };
  /** For a hold that gives no number where the design is sized: the param it sets and its
   *  statement, as the sheet writes it. */
  readonly hold?: {
    readonly path: readonly string[];
    readonly param: string;
    readonly statement: string;
  };
  /** For a search whose relation gives no number across its stretch, at one point only, or across
   *  its crossing: the search and where; and, for a member of a set, the set. */
  readonly unevaluable?: {
    readonly member: SearchData;
    readonly at: UnevaluableAt;
    readonly set?: readonly SearchData[];
  };
  /** The item found giving no number where the engine read it, and its record where it was read
   *  beyond its table. */
  readonly by?: ItemRef;
  readonly outside?: OutsideTable;
  /** For the check a declared region adds: the device it tests, and what gave no number: the
   *  device, which is not sized, or its drain-source voltage or vdsat. */
  readonly region?: { readonly device: string; readonly missing: 'device' | 'vds' | 'vdsat' };
  /** For a range end whose `set` gives no number against the design run: the end, the param it
   *  sets, and the expression, as the sheet writes it. */
  readonly rangeEnd?: {
    readonly name: string;
    readonly param: string;
    readonly expression: string;
  };
}

/** Which field of a param holds the relation a search solves. */
export type RelationField = 'designConstraint' | 'solveFor' | 'hold';

/** The relation a search drives to zero, `lhs - (rhs)`, and the names each side reads directly. */
export interface RelationData {
  readonly lhs: string;
  readonly rhs: string;
  readonly field: RelationField;
  readonly reads: { readonly lhs: readonly string[]; readonly rhs: readonly string[] };
  /** The unit both sides are in, where the code that writes the record knows it. */
  readonly unit?: string;
  /** That the right side reads only values the designer types, and so stays the same at every
   *  value of the unknown. Absent where it may move with it. */
  readonly rhsFixed?: true;
}

/** One end of a stretch a search read: the unknown there and each side of the relation, and,
 *  where the end was stepped in from the end of the range because the relation does not evaluate
 *  beyond it, the evaluation's own words for why. */
export interface SearchEnd {
  readonly x: number;
  readonly lhs: number;
  readonly rhs: number;
  readonly stepped?: string;
  /** The item `stepped` is about, where the evaluation names it (a device not sized there). */
  readonly steppedBy?: ItemRef;
  /** Where the end was stepped in because a device was read beyond its table: that read. */
  readonly steppedOutside?: OutsideTable;
  /** Where it was stepped in for anything else: the first item that failed at the point that did
   *  not evaluate, with its cause. */
  readonly steppedCause?: Cause;
}

/** One solved param as a failed search reports it: where it is, whether it is a held param, the
 *  unit its values are quoted in, its relation, the range it may be searched in (SolveRange, with
 *  where it came from), and the stretch this search ran over (`searched`: the author's range, or a
 *  stage of it). Where other members of its set stood while it was searched, `given` names them
 *  with their values. */
export interface SearchData {
  readonly path: readonly string[];
  readonly unknown: string;
  readonly held: boolean;
  readonly unit?: string;
  readonly relation: RelationData;
  readonly range: SolveRange;
  readonly searched: readonly [number, number];
  /** Which range the stretch searched is: the search range the sheet states (`sheet`), the range
   *  the circuit allows a wire's level, searched after the sheet's held no root (`physical`), or
   *  the lengths a device's table holds (`table`). */
  readonly stage: 'sheet' | 'physical' | 'table';
  /** For a member of a set of searches that read each other, which failed where the engine held
   *  the others (`given`): every member of the set. Its failure shows nothing about the set. */
  readonly set?: readonly SearchData[];
  readonly given?: readonly {
    readonly name: string;
    readonly value: number;
    readonly unit?: string;
  }[];
}

/** What a search that found no solution read: the two ends of the stretch it searched, and how it
 *  ended — no sign change across the stretch (`sign`); a bracket that closed `at` a point where
 *  the relation still reads `lhs - rhs` far beyond the `band` its slope allows (`step`); a held
 *  relation that moves by `moves` where its own param accounts for `own` (`held-flat`); or a
 *  relation that reads the same at both ends and the middle (`flat`). */
export interface NoSolutionRead {
  readonly ends: readonly [SearchEnd, SearchEnd];
  readonly ended:
    | { readonly kind: 'sign' }
    | { readonly kind: 'step'; readonly at: SearchEnd; readonly band: number }
    | { readonly kind: 'held-flat'; readonly moves: number; readonly own: number }
    | { readonly kind: 'flat' };
}

/** A search over the range the circuit allows, with no crossing there, where the relation was
 *  shown to be monotonic in the unknown across it — the only way a search proves there is none. No
 *  check shows that yet (see noSolutionCause). */
export interface NoSolutionData extends SearchData, NoSolutionRead {
  readonly shown: 'monotonic';
}

/** A search that found no crossing and proved nothing: why it is not a proof. */
export interface NoCrossingData extends SearchData, NoSolutionRead {
  readonly notProof: 'not-monotonic' | 'end-not-read';
  readonly endsRead: boolean;
}

/** A search in a range the author stated (or the lengths a table holds) with no root in it. */
export interface NoneInRangeData extends SearchData, NoSolutionRead {
  readonly endsRead: boolean;
}

/** Where a search found its relation giving no number: nowhere in its stretch (`reason`: why at
 *  its low end); at one point only (with the ends stepped in from); or across the crossing, which
 *  lies `between` two points where the points tried do not evaluate. */
export type UnevaluableAt =
  | { readonly where: 'nowhere'; readonly reason: string; readonly by?: ItemRef }
  | {
      readonly where: 'one-point';
      readonly end: SearchEnd;
      readonly stepped: readonly SearchStep[];
    }
  | {
      readonly where: 'crossing';
      readonly ends: readonly [SearchEnd, SearchEnd];
      readonly between: readonly [number, number];
      readonly reason: string;
      readonly by?: ItemRef;
    };

/**
 * Searches that did not settle, and why. A search records only the last two: its set still moved
 * after the fixed passes, or the final check found a relation off. The first two are kept for the
 * words today's fields carry, which the old message builders write from them:
 *  - `unevaluable`: nothing of the stretch evaluates (`reason`: why at its low end); or only one
 *    point of it does (`only`, with the ends stepped in from); or the sign changes across it but
 *    the crossing lies `between` two points where the points tried do not evaluate;
 *  - `member`: a member of a set failed where the others stood (`failure`: its own cause);
 *  - `sweeps`: the set still moved after `sweeps` sweeps, the last by `moved`;
 *  - `verification`: read from the final evaluation, the relations of `off` were outside their
 *    tolerance (`tolRel` of each one's range, by its slope).
 */
export interface DidNotSettleData {
  readonly members: readonly SearchData[];
  readonly simplifications: readonly string[];
  readonly why:
    | { readonly kind: 'unevaluable'; readonly at: UnevaluableAt }
    | { readonly kind: 'member'; readonly failure: Cause }
    | {
        readonly kind: 'sweeps';
        readonly sweeps: number;
        /** The member that moved most in the last sweep, relative to its own range. */
        readonly moved: { readonly name: string; readonly by: number };
        /** How far every member moved in the last sweep, in document order. */
        readonly moves: readonly { readonly name: string; readonly by: number }[];
      }
    | {
        readonly kind: 'verification';
        readonly tolRel: number;
        readonly off: readonly {
          readonly name: string;
          readonly lhs?: number;
          readonly rhs?: number;
          readonly tolerance: number;
        }[];
      };
}

/** An end of a search stepped in from the end of the range, for why. */
export interface SearchStep {
  readonly side: 'below' | 'above';
  readonly x: number;
  readonly reason: string;
  readonly by?: ItemRef;
}

/** A search stopped by a limit: the evaluations the whole tree may spend, or the probes one search
 *  may take. */
export interface LimitData {
  readonly members: readonly SearchData[];
  readonly limit: 'evaluations' | 'probes';
  readonly count: number;
  /** For a member of a set: the set it was searched in, which its message names. `members[0]` is
   *  the member whose search the limit stopped. */
  readonly set?: readonly SearchData[];
  /** For the probe limit: the ends of the stretch the search had bracketed. */
  readonly ends?: readonly [SearchEnd, SearchEnd];
}

/** A `hold` that does not hold where the design is sized: it gives no number, or a current balance
 *  that does not read zero. */
export interface StatementFalseData {
  readonly path: readonly string[];
  readonly param: string;
  readonly statement: string;
  /** For a current balance that does not read zero: what it reads, and the tolerance. Absent where
   *  the statement gives no number. */
  readonly balance?: { readonly reads: number; readonly tolerance: number };
}

/** A requirement that does not hold: its two sides, the margin, and whether it is hard. */
export interface FailsData {
  /** The two sides as the sheet writes them, and how they compare. */
  readonly text: { readonly lhs: string; readonly op: CheckOp; readonly rhs: string };
  readonly lhs: number;
  readonly rhs: number;
  readonly margin: number;
  readonly marginPct: number;
  readonly hard: boolean;
  /** The unit of the two sides, where the sheet declares one for a name either side is. */
  readonly unit?: string;
}

/** The closed list of causes, each with its data. */
export type Cause =
  | { readonly kind: 'not-read'; readonly data: NotReadData }
  | { readonly kind: 'not-determined'; readonly data: NotDeterminedData }
  | { readonly kind: 'outside-table'; readonly data: OutsideTableData }
  | { readonly kind: 'cannot-evaluate'; readonly data: CannotEvaluateData }
  | { readonly kind: 'no-solution'; readonly data: NoSolutionData }
  | { readonly kind: 'no-crossing'; readonly data: NoCrossingData }
  | { readonly kind: 'none-in-range'; readonly data: NoneInRangeData }
  | { readonly kind: 'did-not-settle'; readonly data: DidNotSettleData }
  | { readonly kind: 'limit'; readonly data: LimitData }
  | { readonly kind: 'statement-false'; readonly data: StatementFalseData }
  | { readonly kind: 'fails'; readonly data: FailsData };

export type CauseName = Cause['kind'];

/** Every cause, in the order the definition lists them. */
export const CAUSES: readonly CauseName[] = [
  'not-read',
  'not-determined',
  'outside-table',
  'cannot-evaluate',
  'no-solution',
  'no-crossing',
  'none-in-range',
  'did-not-settle',
  'limit',
  'statement-false',
  'fails',
];

/** The kinds of item each cause may occur on. A cause on any other kind is a defect in the code
 *  that produced it (see causeFits). */
export const OCCURS_ON: { readonly [C in CauseName]: readonly ItemKind[] } = {
  // A sheet that is not read at all, or one entry whose field is malformed on a sheet that is
  // still read and evaluated (the entry named by the finding).
  'not-read': ['sheet', 'value', 'device', 'search', 'requirement'],
  // On the sheet, or on a value the sheet marks as assumed that the design rests on; and on the
  // device or the selector a finding of the netlist check names.
  'not-determined': ['sheet', 'value', 'device'],
  'outside-table': ['device'],
  // A block's sheet that is not evaluated because a value its parent sets gives no number.
  'cannot-evaluate': ['sheet', 'value', 'device', 'requirement', 'search'],
  'no-solution': ['search'],
  'no-crossing': ['search'],
  'none-in-range': ['search'],
  'did-not-settle': ['search'],
  limit: ['search'],
  'statement-false': ['search'],
  fails: ['requirement'],
};

/** Whether a cause may occur on an item of this kind (OCCURS_ON). */
export const causeFits = (kind: ItemKind, c: Cause): boolean => OCCURS_ON[c.kind].includes(kind);

// ── Items ─────────────────────────────────────────────────────────────────────────────────────

/** A quantity computed by a fallback definition: the quantity, the column the table lacks, and the
 *  form that was used. */
export interface Fallback {
  readonly quantity: string;
  readonly missing: readonly string[];
  readonly form: string;
}

/** What an item that is ok carries. A value or a device: the quantities computed by a fallback. A
 *  search: where it landed, the range and where it came from, whether the root lay in the range
 *  searched first, and whether it was found by repeated searches and verified. A requirement: its
 *  sides, its margin, whether the margin is narrow, and whether it sits exactly on its limit. */
export type Attributes =
  | { readonly kind: 'sheet' }
  | { readonly kind: 'value' | 'device'; readonly fallbacks?: readonly Fallback[] }
  | {
      /** A solved param the run held at a given value instead of solving: the value, and the
       *  relation that was not checked there. The point evaluated is not a solution of the sheet. */
      readonly kind: 'held';
      readonly value: number;
      readonly unit?: string;
      readonly relation: {
        readonly lhs: string;
        readonly rhs: string;
        readonly field: RelationField;
      };
    }
  | {
      readonly kind: 'search';
      readonly value: number;
      readonly range: SolveRange;
      readonly inFirstRange: boolean;
      readonly settledInSet: boolean;
    }
  | {
      readonly kind: 'requirement';
      readonly lhs: number;
      readonly rhs: number;
      readonly margin: number;
      readonly marginPct: number;
      readonly narrow: boolean;
      readonly onLimit: boolean;
      readonly hard: boolean;
    };

/** One item's status. A withheld item names the failed items it depends on, nearest first. */
export type Status =
  | { readonly status: 'ok'; readonly attributes?: Attributes }
  | { readonly status: 'failed'; readonly cause: Cause }
  | { readonly status: 'withheld'; readonly on: readonly WithheldOn[] };

export type Item = ItemRef & Status;

/** A failed item a withheld one depends on, with the kind of its cause. */
export type WithheldOn =
  | (ItemRef & { readonly cause: CauseName; readonly frame?: undefined })
  /** An item of the parent sheet, named as the parent names it: a block that is not evaluated
   *  waits on what its parent did not give it. Its cause is read in the parent's list, which
   *  resolves the reference; the block's own list carries none. */
  | (ItemRef & { readonly frame: 'parent'; readonly cause?: undefined });

// ── Mapping today's search outcomes to causes, in one place ───────────────────────────────────

/**
 * The choices not yet ruled on, in one place, so that each is a change here alone:
 *  - `equationOnly`: the verdict of a sheet that sizes no device and solves nothing, where every
 *    item is ok. It has no design to be feasible; "feasible" stands until its word is ruled.
 */
export const OPEN_RULINGS: { readonly equationOnly: DesignVerdict } = { equationOnly: 'feasible' };

/**
 * The cause of a search that found no solution in what it searched, from its data — where its
 * range came from (`range.from`) and how the search ended — and whether both ends of the stretch
 * read the design. The one place that decides whether a failed search is proved.
 *
 * "No solution (proved)" needs the relation shown to be monotonic in the unknown across the range,
 * and no check does that yet, so no search maps to it: a search over the circuit's own range with
 * no crossing, both ends read, is "no solution found (not proved)", undetermined. Today's result
 * fields still read it as the design failing, by one stated rule (legacyDesignFailure).
 */
export function noSolutionCause(data: SearchData & NoSolutionRead, endsRead: boolean): Cause {
  // In a stated range, no solution there only where both its ends were read: a search that
  // stopped short of an end did not look at what lies between.
  if (data.range.from !== 'wiring' && data.ended.kind === 'sign' && endsRead)
    return { kind: 'none-in-range', data: { ...data, endsRead } };
  // Over the circuit's own range with no proof, an end not read, a step across the target, or a
  // relation that singles out no value, in a range of any source: no crossing, and nothing proved.
  return {
    kind: 'no-crossing',
    data: { ...data, endsRead, notProof: endsRead ? 'not-monotonic' : 'end-not-read' },
  };
}

/**
 * The one compatibility rule that keeps today's result fields where the cause has changed its
 * reading: a search over the circuit's own range that found no sign change, both ends read, is
 * read by today's fields (the solve outcome's design failure, a point's does-not-comply) as the
 * design failing, though its cause is "not proved".
 *
 * So for these cases one result holds two readings while this rule stands: the old fields say the
 * design does not comply, and the verdict derived from the items (verdictOf) says undetermined. No
 * reader may take the derived verdict until the readers move to it; when they do, this rule and
 * the design-failure test it serves are deleted together, and the tests that force such a search
 * change with them.
 */
export const legacyDesignFailure = (c: Cause): boolean =>
  c.kind === 'no-crossing' &&
  c.data.set === undefined &&
  c.data.range.from === 'wiring' &&
  c.data.ended.kind === 'sign' &&
  c.data.endsRead;

/** The set a failed member of a set of searches was one of, where its cause records one. A limit
 *  of the calculations carries its set too, but as the set's own failure, not a member's. */
export function setOf(c: Cause): readonly SearchData[] | undefined {
  switch (c.kind) {
    case 'no-solution':
    case 'no-crossing':
    case 'none-in-range':
      return c.data.set;
    case 'cannot-evaluate':
      return c.data.unevaluable?.set;
    case 'limit':
      return c.data.limit === 'probes' ? c.data.set : undefined;
    default:
      return undefined;
  }
}

/** The search a failed member's cause is about. */
export function memberOf(c: Cause): string | undefined {
  switch (c.kind) {
    case 'no-solution':
    case 'no-crossing':
    case 'none-in-range':
      return c.data.unknown;
    case 'cannot-evaluate':
      return c.data.unevaluable?.member.unknown;
    case 'limit':
      return c.data.members[0]?.unknown;
    default:
      return undefined;
  }
}

/** A member's own cause with its set recorded, where the cause can carry one. */
export function withSet(c: Cause, set: readonly SearchData[]): Cause | undefined {
  switch (c.kind) {
    case 'no-solution':
      return { kind: c.kind, data: { ...c.data, set } };
    case 'no-crossing':
      return { kind: c.kind, data: { ...c.data, set } };
    case 'none-in-range':
      return { kind: c.kind, data: { ...c.data, set } };
    case 'cannot-evaluate':
      return c.data.unevaluable
        ? { kind: c.kind, data: { ...c.data, unevaluable: { ...c.data.unevaluable, set } } }
        : undefined;
    case 'limit':
      return c.data.limit === 'probes' ? { kind: c.kind, data: { ...c.data, set } } : undefined;
    default:
      return undefined;
  }
}

/** A member's own cause without its set: the cause as the member's search alone wrote it. */
export function withoutSet(c: Cause): Cause {
  switch (c.kind) {
    case 'no-solution':
    case 'no-crossing':
    case 'none-in-range': {
      const { set: _set, ...data } = c.data;
      return { kind: c.kind, data } as Cause;
    }
    case 'cannot-evaluate': {
      if (!c.data.unevaluable) return c;
      const { set: _set, ...unevaluable } = c.data.unevaluable;
      return { kind: c.kind, data: { ...c.data, unevaluable } };
    }
    case 'limit': {
      if (c.data.limit !== 'probes') return c;
      const { set: _set, ...data } = c.data;
      return { kind: c.kind, data };
    }
    default:
      return c;
  }
}

// ── The verdict ───────────────────────────────────────────────────────────────────────────────

/** The verdict at the design point. */
export type DesignVerdict = 'infeasible' | 'non-compliant' | 'feasible' | 'undetermined';
/** The verdict at a held point (a range end, another process condition). */
export type HeldVerdict = 'no-operating-point' | 'non-compliant' | 'compliant' | 'undetermined';

/** A verdict, with the failed items it rests on: for an infeasible or non-compliant one, the items
 *  that decide it; for an undetermined one, every failed item. */
export interface Verdict<V extends string = DesignVerdict> {
  readonly verdict: V;
  readonly failed: readonly (ItemRef & { readonly cause: Cause })[];
  /** The solved params the run held instead of solving, where any was: the reason the verdict is
   *  undetermined. */
  readonly held?: readonly ItemRef[];
}

/** Whether an item is a solved param the run held at a given value instead of solving. */
export const isHeld = (i: Item): boolean => i.status === 'ok' && i.attributes?.kind === 'held';

const failedItems = (items: readonly Item[]): (ItemRef & { cause: Cause })[] =>
  items.flatMap((i) =>
    i.status === 'failed' ? [{ kind: i.kind, path: i.path, name: i.name, cause: i.cause }] : [],
  );

/**
 * The verdict of one result, by four rules, the first that applies, after one rule ahead of them:
 * an item the run held at a given value instead of solving gives undetermined, and the verdict
 * names it in `held`, since the point evaluated is not a solution of the sheet:
 *  1. a search failed with "no solution (proved)": infeasible (at a held point, no operating point);
 *  2. a hard requirement failed with "fails": non-compliant;
 *  3. every item is ok: feasible (at a held point, compliant) — an advisory requirement that does
 *     not hold is failed, and does not stop this rule, as it gates nothing today; a sheet with no
 *     device and no search reads OPEN_RULINGS.equationOnly;
 *  4. otherwise: undetermined, with each failed item and its cause.
 * Rule 2 before rule 3 is three-valued logic: one requirement that fails decides, whatever else is
 * not known. The sheet is an item, so a sheet that was not read cannot reach rule 3. Withheld items
 * follow from failed ones, which the list already holds.
 */
export function verdictOf(items: readonly Item[]): Verdict {
  const failed = failedItems(items);
  for (const rule of VERDICT_RULES) {
    const v = rule(items, failed);
    if (v) return v;
  }
  // An advisory requirement that does not hold decides nothing (see failsCause).
  return { verdict: 'undetermined', failed: blocking(failed) };
}

type Failed = (ItemRef & { cause: Cause })[];
type VerdictRule = (items: readonly Item[], failed: Failed) => Verdict | undefined;

const blocking = (failed: Failed): Failed =>
  failed.filter((f) => !(f.cause.kind === 'fails' && !f.cause.data.hard));

/** A solved param held instead of solved: the point evaluated is not a solution of the sheet. */
const heldRule: VerdictRule = (items, failed) => {
  const held = items.filter(isHeld).map((i) => ({ kind: i.kind, path: i.path, name: i.name }));
  return held.length ? { verdict: 'undetermined', failed: blocking(failed), held } : undefined;
};

/** Rule 1. A search with the others of its set held where they stood says nothing about the set,
 *  even proved. */
const provedRule: VerdictRule = (_items, failed) => {
  const proved = failed.filter((f) => f.cause.kind === 'no-solution' && !setOf(f.cause));
  return proved.length ? { verdict: 'infeasible', failed: proved } : undefined;
};

/** Rule 2. */
const failsRule: VerdictRule = (_items, failed) => {
  const fails = failed.filter((f) => f.cause.kind === 'fails' && f.cause.data.hard);
  return fails.length ? { verdict: 'non-compliant', failed: fails } : undefined;
};

/** Rule 3. */
const okRule: VerdictRule = (items, failed) =>
  blocking(failed).length === 0 && items.every((i) => i.status !== 'withheld')
    ? {
        verdict: items.some((i) => i.kind === 'device' || i.kind === 'search')
          ? 'feasible'
          : OPEN_RULINGS.equationOnly,
        failed: [],
      }
    : undefined;

/** The rules in the order they apply; rule 4, undetermined, is what none of them decides. The
 *  held rule comes first: whether a held value or a failing hard requirement decides first is an
 *  open ruling, and this order is the one line that holds it. */
const VERDICT_RULES: readonly VerdictRule[] = [heldRule, provedRule, failsRule, okRule];

/** The verdict of a held point: verdictOf, in the words a held design is asked in. */
export function heldVerdictOf(items: readonly Item[]): Verdict<HeldVerdict> {
  const v = verdictOf(items);
  const word: Record<DesignVerdict, HeldVerdict> = {
    infeasible: 'no-operating-point',
    'non-compliant': 'non-compliant',
    feasible: 'compliant',
    undetermined: 'undetermined',
  };
  return { verdict: word[v.verdict], failed: v.failed, ...(v.held ? { held: v.held } : {}) };
}

/** A hard requirement's cause, where it does not hold. A requirement that is advisory and does not
 *  hold is failed all the same, with `hard: false`, and decides nothing (verdictOf rule 2). */
export const failsCause = (r: {
  kind: CheckKind;
  text: { lhs: string; op: CheckOp; rhs: string };
  lhsValue: number;
  rhsValue: number;
  margin: number;
  marginPct: number;
  unit?: string;
}): Cause => ({
  kind: 'fails',
  data: {
    text: r.text,
    ...(r.unit !== undefined ? { unit: r.unit } : {}),
    lhs: r.lhsValue,
    rhs: r.rhsValue,
    margin: r.margin,
    marginPct: r.marginPct,
    hard: r.kind === 'physical' || r.kind === 'spec',
  },
});
