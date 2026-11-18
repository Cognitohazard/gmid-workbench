// Today's result fields, derived from the new ones (states.ts). Each old field is computed from the
// causes by one function here, never the other way, so the two cannot drift; they go when nothing
// reads them.

import { causeMessage } from './describe';
import { legacyDesignFailure, type Cause, type Item, type NoSolutionRead } from './states';
import type { NoSolutionWhy, SolveFailure } from './types';

/** How a search that found no solution ended, in today's words (NoSolutionWhy). */
const becauseOf = (d: NoSolutionRead): NoSolutionWhy =>
  d.ended.kind === 'sign' ? 'no-crossing' : d.ended.kind === 'step' ? 'step' : 'undetermined';

/** The cause each solve outcome derived here was derived from (solveFailureOf). */
const CAUSE_OF = new WeakMap<SolveFailure, Cause>();

/** The cause a solve outcome was derived from, where it was derived from one. */
export const causeOfFailure = (f: SolveFailure): Cause | undefined => CAUSE_OF.get(f);

/** The solve outcome today's fields carry for a failed search, from its cause: the same kind, the
 *  same unknowns and the same message. The cause is kept beside it (causeOfFailure). */
export function solveFailureOf(c: Cause): SolveFailure {
  const f = legacyFailure(c);
  CAUSE_OF.set(f, c);
  return f;
}

function legacyFailure(c: Cause): SolveFailure {
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
    default:
      throw new Error(`a ${c.kind} cause is not the outcome of a search`);
  }
}

/**
 * Today's yes-or-no feasibility of one evaluation, from its items: every item ok, except a
 * requirement that is advisory, which gates nothing. A requirement that could not be calculated
 * counts as failing ("fails closed"), as it does today, though its verdict is undetermined.
 * `advisory` names the requirements that are advisory, by their path in the list.
 */
export function legacyFeasible(items: readonly Item[], advisory: ReadonlySet<string>): boolean {
  return items.every(
    (i) =>
      i.status === 'ok' ||
      (i.kind === 'requirement' && advisory.has([...i.path, i.name].join('.'))),
  );
}

/**
 * Today's reading of one run as a point of the compliance question (PointOutcome.state), from its
 * items: a search over the circuit's own range with no crossing, both ends read, is the design
 * failing (legacyDesignFailure); any other item that failed or was withheld, a requirement that
 * fails aside, leaves no answer; a design that rests on an assumed level (`assumed`) has none
 * either; otherwise it complies where it is feasible.
 */
export function legacyPointState(
  items: readonly Item[],
  advisory: ReadonlySet<string>,
  assumed = false,
): 'complies' | 'does-not-comply' | 'no-answer' {
  const answer = ((): 'complies' | 'does-not-comply' | 'no-answer' => {
    if (items.some((i) => i.status === 'failed' && legacyDesignFailure(i.cause)))
      return 'does-not-comply';
    const unanswered = items.some(
      (i) =>
        i.status !== 'ok' &&
        !(
          i.kind === 'requirement' &&
          (i.status === 'failed' && i.cause.kind === 'fails'
            ? true
            : advisory.has([...i.path, i.name].join('.')))
        ),
    );
    if (unanswered) return 'no-answer';
    return legacyFeasible(items, advisory) ? 'complies' : 'does-not-comply';
  })();
  return assumed ? 'no-answer' : answer;
}
