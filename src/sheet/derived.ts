// Today's result fields, derived from the new ones (states.ts). Each old field is computed from the
// causes by one function here, never the other way, so the two cannot drift; they go when nothing
// reads them.

import { causeMessage } from './describe';
import type { Cause, NoSolutionRead } from './states';
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
