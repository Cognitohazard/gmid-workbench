// Today's result fields, derived from the new ones (states.ts). Each old field is computed from the
// causes by one function here, never the other way, so the two cannot drift; they go when nothing
// reads them.

import { causeMessage } from './describe';
import {
  legacyDesignFailure,
  setOf,
  withoutSet,
  type Cause,
  type Item,
  type NoSolutionRead,
} from './states';
import type { NoSolutionWhy, SolveFailure } from './types';

/** How a search that found no solution ended, in today's words (NoSolutionWhy). */
const becauseOf = (d: NoSolutionRead): NoSolutionWhy =>
  d.ended.kind === 'sign' ? 'no-crossing' : d.ended.kind === 'step' ? 'step' : 'undetermined';

/** The solve outcome today's fields carry for a failed search, from its cause: the same kind, the
 *  same unknowns and the same message. */
export const solveFailureOf = (c: Cause): SolveFailure => legacyFailure(c);

/** A failed search as the engine carries it: today's failure record, and the cause it was derived
 *  from, side by side, so a reader of the cause never looks it up from the record. */
export const failOn = (cause: Cause): { failure: SolveFailure; cause: Cause } => ({
  failure: legacyFailure(cause),
  cause,
});

/** A cause that is not the outcome of a search reaching today's solve record: no search writes
 *  one, so this is never reached, but the evaluator never throws. It reads as a set that is not
 *  well formed, with its message. */
const notASearchOutcome = (c: Cause, message: string): SolveFailure => ({
  kind: 'not-settled',
  unknowns: [],
  why: 'malformed',
  message: message || c.kind,
});

function legacyFailure(c: Cause): SolveFailure {
  // A member of a set that failed where the others were held: today, the set did not settle, in
  // the words of the member's own cause.
  const set = setOf(c);
  if (set)
    return {
      kind: 'not-settled',
      unknowns: set.map((m) => m.unknown),
      why: 'member',
      message: causeMessage({
        kind: 'did-not-settle',
        data: {
          members: set,
          simplifications: [],
          why: { kind: 'member', failure: withoutSet(c) },
        },
      }),
    };
  const message = causeMessage(c);
  switch (c.kind) {
    case 'no-solution':
    case 'no-crossing':
    case 'none-in-range':
      return {
        kind: 'no-solution',
        unknown: c.data.unknown,
        range: [c.data.ends[0].x, c.data.ends[1].x],
        message,
        from: c.data.range.from,
        because: becauseOf(c.data),
        endsRead: c.kind === 'no-solution' ? true : c.data.endsRead,
      };
    case 'did-not-settle':
      return {
        kind: 'not-settled',
        unknowns:
          c.data.why.kind === 'verification'
            ? c.data.why.off.map((o) => o.name)
            : c.data.members.map((m) => m.unknown),
        why: c.data.why.kind,
        message,
      };
    case 'limit':
      return {
        kind: 'not-settled',
        unknowns: (c.data.set ?? c.data.members).map((m) => m.unknown),
        why: c.data.limit === 'evaluations' ? 'budget' : 'probes',
        message,
      };
    case 'not-determined':
      return {
        kind: 'not-settled',
        unknowns: [...c.data.names],
        why: 'malformed',
        message,
      };
    case 'statement-false':
      return { kind: 'declaration-false', param: c.data.param, message };
    case 'cannot-evaluate':
      // A hold that gives no number where the design is sized: today, a false declaration.
      if (c.data.hold) return { kind: 'declaration-false', param: c.data.hold.param, message };
      // A relation that gives no number across the stretch: today, a search that did not settle.
      if (c.data.unevaluable)
        return {
          kind: 'not-settled',
          unknowns: [c.data.unevaluable.member.unknown],
          why: 'unevaluable',
          message,
        };
      return notASearchOutcome(c, message);
    default:
      return notASearchOutcome(c, message);
  }
}

/**
 * Today's yes-or-no feasibility of one evaluation, from its items: every item ok, except a
 * requirement that is advisory, which gates nothing. A requirement that could not be calculated
 * counts as failing ("fails closed"), as it does today, though its verdict is undetermined.
 * `advisory` names the requirements that are advisory, by their path in the list; `ends` are the
 * range ends' own lists.
 */
export function legacyFeasible(
  items: readonly Item[],
  advisory: ReadonlySet<string>,
  ends: readonly (readonly Item[] | undefined)[] = [],
): boolean {
  const quiet = quietIn(items);
  // A finding of validation about one range end is on that end's own list, and blocks today's
  // feasibility as every validation error does.
  if (ends.some((list) => (list ?? []).some(fromValidation))) return false;
  return items.every(
    (i) =>
      i.status === 'ok' ||
      quiet(i) ||
      (i.kind === 'requirement' && advisory.has([...i.path, i.name].join('.'))),
  );
}

/** What gates nothing in today's fields though its item is not ok: an equation that gives no
 *  number because it reads a name that is not defined (a warning today, so a sheet can carry an
 *  equation for a column only some tables have), and a design that rests on a level the sheet
 *  marks as assumed (the point has no answer, but feasibility is read on the design as sized). */
const quietToday = (i: Item): boolean =>
  i.status === 'failed' &&
  // A check whose operator is not known, which today's result judged as an equality that passed.
  ((i.kind === 'requirement' &&
    i.cause.kind === 'not-read' &&
    i.cause.data.classified === 'pass') ||
    (i.kind === 'value' &&
      i.cause.kind === 'cannot-evaluate' &&
      i.cause.data.why === 'not-defined') ||
    (i.cause.kind === 'not-determined' &&
      i.cause.data.why === 'assumed-level' &&
      i.cause.data.stage === undefined));

/** quietToday over a list: also a value withheld only on items that are quiet, as an equation
 *  that reads another whose name is not defined gave no number today without failing anything. */
const quietIn =
  (items: readonly Item[]) =>
  (i: Item): boolean => {
    if (quietToday(i)) return true;
    if (i.status !== 'withheld' || i.kind !== 'value') return false;
    return i.on.every((o) => {
      const t = items.find(
        (x) => x.kind === o.kind && x.name === o.name && x.path.join('.') === o.path.join('.'),
      );
      return t !== undefined && quietToday(t);
    });
  };

/** A finding that validating the document raised before it was evaluated. */
const fromValidation = (i: Item): boolean =>
  i.status === 'failed' &&
  (i.cause.kind === 'not-read' || i.cause.kind === 'not-determined') &&
  i.cause.data.stage === 'validation';

/** A finding of the netlist check, made on the evaluated design. */
const netlistFinding = (i: Item): boolean =>
  i.status === 'failed' &&
  i.cause.kind === 'not-determined' &&
  i.cause.data.why === 'netlist' &&
  i.cause.data.stage === undefined;

/**
 * Today's reading of one run as a point of the compliance question (PointOutcome.state), from its
 * items. The point is read from the evaluation alone, so a finding of validation does not enter
 * it. A search over the circuit's own range with no crossing, both ends read, is the design
 * failing (legacyDesignFailure); any other item that failed or was withheld, a requirement that
 * fails aside, leaves no answer; a design that rests on a level the sheet marks as assumed has
 * none either; otherwise it complies where it is feasible. The netlist is checked once the point is
 * read, and a finding of it turns a point that complied into one that does not.
 */
export function legacyPointState(
  all: readonly Item[],
  advisory: ReadonlySet<string>,
): 'complies' | 'does-not-comply' | 'no-answer' {
  // A value that waits only on a finding of validation is left out with it: today it gave no
  // number, which the requirements that read it are judged on. A search or a block that waits on
  // one was not found or not evaluated, and leaves no answer.
  const validated = all.filter(fromValidation);
  const onValidation = (i: Item): boolean =>
    i.kind === 'value' &&
    i.status === 'withheld' &&
    i.on.every((o) =>
      validated.some(
        (v) => v.kind === o.kind && v.name === o.name && v.path.join('.') === o.path.join('.'),
      ),
    );
  const items = all.filter((i) => !fromValidation(i) && !onValidation(i));
  const design = items.filter((i) => !netlistFinding(i));
  const assumed = design.some(
    (i) =>
      i.status === 'failed' &&
      i.cause.kind === 'not-determined' &&
      i.cause.data.why === 'assumed-level',
  );
  const base = ((): 'complies' | 'does-not-comply' | 'no-answer' => {
    if (design.some((i) => i.status === 'failed' && legacyDesignFailure(i.cause)))
      return 'does-not-comply';
    // A requirement that fails or gives no number is read by feasibility, which fails closed.
    const unanswered = design.some(
      (i) => i.status !== 'ok' && i.kind !== 'requirement' && !quietIn(design)(i),
    );
    if (unanswered) return 'no-answer';
    return legacyFeasible(design, advisory) ? 'complies' : 'does-not-comply';
  })();
  if (assumed) return 'no-answer';
  return base === 'complies' && items.some(netlistFinding) ? 'does-not-comply' : base;
}
