// Every text a reader sees about an item's cause, built from the cause's data in one place. The
// code that produces a result writes data, never these sentences, so the app and a script read the
// same words, and a change of wording is a change here alone.

import { outsideTableMessage } from '../types';
import { amps } from './nodes';
import { shown } from './linear';
import { andList, type SolveRange } from './types';
import type {
  Cause,
  CauseName,
  DidNotSettleData,
  Item,
  LimitData,
  NoSolutionRead,
  SearchData,
  SearchEnd,
  SearchStep,
  StatementFalseData,
} from './states';

// ── Numbers, units and names as a message quotes them ────────────────────────────────────────

/** A unit as a message follows a number with it: nothing for none or a pure number. */
export const unitText = (unit: string | undefined): string =>
  unit && unit !== '1' ? ` ${unit}` : '';

/** A range as a message quotes it. */
export const rangeText = (lo: number, hi: number, unit: string | undefined): string =>
  `[${shown(lo)}, ${shown(hi)}]${unitText(unit)}`;

/** A wire's name as a message quotes it. */
export const wireName = (w: string): string => `"${w}"`;

const valueOf = (d: { unit?: string }, x: number): string => `${shown(x)}${unitText(d.unit)}`;
const rangeOf = (d: { unit?: string }, lo: number, hi: number): string => rangeText(lo, hi, d.unit);

/** How a message names a solved param: `solved param "x"`, or `held param "x"` for a node under a
 *  gate re-solved where the hardware is held. */
export const searchWhat = (d: Pick<SearchData, 'held' | 'unknown'>): string =>
  `${d.held ? 'held' : 'solved'} param "${d.unknown}"`;

/** A relation as a message prints it: `lhs - (rhs)`. */
const relationText = (d: SearchData): string => `${d.relation.lhs} - (${d.relation.rhs})`;

/** The members of a set searched alongside this one, with where each stood. */
const givenText = (d: SearchData): string =>
  d.given?.length
    ? ` (searched with ${d.given.map((o) => `${o.name} = ${valueOf(o, o.value)}`).join(', ')})`
    : '';

/** Members named for a sentence, each with the range it is searched in. */
const nameList = (ms: readonly SearchData[]): string =>
  andList(ms.map((m) => `"${m.unknown}" in ${rangeOf(m, ...m.range.range)}`));

/** `lhs - rhs` at an end, as the search read it. */
const gOf = (e: SearchEnd): number => e.lhs - e.rhs;

/** A stepped-in end as a message says it. */
const stepText = (d: SearchData, s: SearchStep): string =>
  `the relation does not evaluate ${s.side} ${d.unknown} = ${valueOf(d, s.x)}: ${s.reason}`;

/** The ends of a stretch that were stepped in, low end first. */
const stepsOf = (ends: readonly [SearchEnd, SearchEnd]): SearchStep[] => [
  ...(ends[0].stepped !== undefined
    ? [{ side: 'below' as const, x: ends[0].x, reason: ends[0].stepped }]
    : []),
  ...(ends[1].stepped !== undefined
    ? [{ side: 'above' as const, x: ends[1].x, reason: ends[1].stepped }]
    : []),
];

/** Where a search's stretch came from, as a failure's message says it — nothing for a param that
 *  is no wire's level, whose range can only be its author's. */
export function rangeSource(
  r: SolveRange,
  searched: readonly [number, number],
  unit: string | undefined,
): string | undefined {
  if (r.from === 'author') return r.wires ? `the author's range — ${r.why}` : undefined;
  if (r.from === 'table')
    return `the lengths its table holds, from the process's shortest to the longest the table reaches`;
  const w = r.wiring as NonNullable<SolveRange['wiring']>;
  const between = `between ${wireName(w.below)} and ${wireName(w.above)}`;
  const whole = searched[0] === w.range[0] && searched[1] === w.range[1];
  if (!whole)
    return `the author's range, before the wiring's ${rangeText(w.range[0], w.range[1], unit)} ${between}`;
  const a = r.author;
  const first =
    a && (a[0] !== w.range[0] || a[1] !== w.range[1])
      ? `, after the author's range ${rangeText(a[0], a[1], unit)}`
      : '';
  return `the range the wiring puts its wire in, ${between}${first}`;
}

/** What a search that found no crossing in its stretch tells the author: a range of the author's
 *  own may be in the wrong place; the wiring's range is where the circuit can put the wire, so no
 *  crossing there — read at both ends — is the design not reaching its target. */
export function noCrossingAdvice(from: SolveRange['from'], endsRead: boolean): string {
  if (from === 'table')
    return (
      `No length the table holds reaches the target: none shorter can be built, and past the ` +
      `longest the table does not reach — re-export the table with longer lengths, or state ` +
      `min/max`
    );
  if (from !== 'wiring')
    return (
      `Move or widen min/max to bracket one, or the relation does not reach its target on ` +
      `this table`
    );
  return endsRead
    ? `The circuit can put the wire nowhere else, so the design does not reach its target here`
    : `The circuit can put the wire nowhere else, but an end of the search read a device beyond ` +
        `its table, had a device refused, or was stepped in past a stretch that does not evaluate ` +
        `— so this is not shown to be the design's failure`;
}

// ── Today's messages, from the data ───────────────────────────────────────────────────────────

/** The message of a search that found no solution in its stretch, in any of its three causes. */
function noSolutionMessage(d: SearchData & NoSolutionRead, endsRead: boolean): string {
  const what = searchWhat(d);
  const rel = relationText(d);
  const given = givenText(d);
  const [lo, hi] = d.ends;
  const moved = stepsOf(d.ends).map((s) => stepText(d, s));
  const range = moved.length
    ? `the searched range ${rangeOf(d, lo.x, hi.x)} (${moved.join('; ')})`
    : rangeOf(d, lo.x, hi.x);
  const e = d.ended;
  if (e.kind === 'held-flat')
    return (
      `${what} found no single solution in ${range}: ${d.relation.lhs} moves by ` +
      `${e.moves.toExponential(3)} across it where ${d.unknown} alone accounts for ` +
      `${e.own.toExponential(3)} — holding it does not determine ${d.unknown} here (numerically ` +
      `unresolved)${given}`
    );
  if (e.kind === 'flat')
    return (
      `${what} is not determined by its relation: ${rel} reads ${gOf(lo).toExponential(3)} at ` +
      `both ends of ${range} and at its middle — it does not appear to depend on ${d.unknown}, so ` +
      `no value of it is singled out${given}`
    );
  if (e.kind === 'step')
    return (
      `${what} found no solution in ${range}: the search closed on ${d.unknown} = ` +
      `${valueOf(d, e.at.x)}, but ${rel} still reads ${gOf(e.at).toExponential(3)} there, where ` +
      `just beside the crossing it moves by ${e.band.toExponential(3)} over the tolerance — the ` +
      `relation steps across the target without touching it (a table edge or a fold)${given}`
    );
  const source = rangeSource(d.range, d.searched, d.unit);
  const sourced = source
    ? `${moved.length ? 'the searched range ' : ''}${rangeOf(d, lo.x, hi.x)} (${[source, ...moved].join('; ')})`
    : range;
  return (
    `${what} found no solution in ${sourced}: ${rel} does not change sign ` +
    `across it (${gOf(lo).toExponential(3)} at ${shown(lo.x)}, ${gOf(hi).toExponential(3)} at ` +
    `${shown(hi.x)}) — none, or an even number, of roots there. ` +
    `${noCrossingAdvice(d.range.from, endsRead)}${given}`
  );
}

/** The message of searches that did not settle. */
function didNotSettleMessage(d: DidNotSettleData): string {
  const why = d.why;
  if (why.kind === 'member')
    return `solved params ${nameList(d.members)} did not settle: ${causeMessage(why.failure)}`;
  if (why.kind === 'sweeps') {
    const worst = d.members.find((m) => m.unknown === why.moved.name) as SearchData;
    return (
      `solved params ${nameList(d.members)} did not settle in ${why.sweeps} ` +
      `${why.sweeps === 1 ? 'sweep' : 'sweeps'}: in the last ` +
      `one ${why.moved.name} still moved by ${valueOf(worst, why.moved.by)} — they ` +
      `depend on each other too strongly for repeated one-unknown searches to settle them in ` +
      `their stated ranges`
    );
  }
  if (why.kind === 'verification') {
    const off = why.off.map((o) => d.members.find((m) => m.unknown === o.name) as SearchData);
    const first = off[0];
    return (
      `${off.length > 1 ? 'solved params' : first.held ? 'held param' : 'solved param'} ` +
      `${nameList(off)} did not settle: read from the final evaluation, ` +
      why.off
        .map((o, i) => {
          const m = off[i];
          const g = o.lhs === undefined || o.rhs === undefined ? undefined : o.lhs - o.rhs;
          return (
            `${m.relation.lhs} - (${m.relation.rhs}) ${g === undefined ? 'does not evaluate' : `reads ${g.toExponential(3)}`}` +
            ` against a tolerance of ${o.tolerance.toExponential(3)} (its slope there times ` +
            `${why.tolRel} of its range)`
          );
        })
        .join('; ') +
      ` — the values it was solved with moved after it landed`
    );
  }
  // One search whose relation could not be evaluated where it had to be.
  const m = d.members[0];
  const what = searchWhat(m);
  const rel = relationText(m);
  const given = givenText(m);
  const whole = rangeOf(m, m.searched[0], m.searched[1]);
  const at = why.at;
  if (at.where === 'nowhere')
    return (
      `${what} in ${whole} did not settle: nothing of the range could be ` +
      `evaluated: ${rel} does not evaluate at either end of it or at its middle — ` +
      `${at.reason}${given}`
    );
  if (at.where === 'one-point')
    return (
      `${what} in ${whole} did not settle: nothing of the range but ` +
      `${m.unknown} = ${valueOf(m, at.end.x)} could be evaluated, and ${rel} reads ` +
      `${gOf(at.end).toExponential(3)} there — ${at.stepped.map((s) => stepText(m, s)).join('; ')}${given}`
    );
  const moved = stepsOf(at.ends).map((s) => stepText(m, s));
  const range = moved.length
    ? `the searched range ${rangeOf(m, at.ends[0].x, at.ends[1].x)} (${moved.join('; ')})`
    : rangeOf(m, at.ends[0].x, at.ends[1].x);
  return (
    `${what} in ${whole} did not settle: ${rel} changes sign across ` +
    `${range}, but the crossing could not be followed: it lies between ${m.unknown} = ` +
    `${valueOf(m, at.between[0])} and ${valueOf(m, at.between[1])}, where ` +
    `the points tried do not evaluate — ${at.reason}${given}`
  );
}

/** The message of a search a limit stopped. */
function limitMessage(d: LimitData): string {
  const m = d.members[0];
  const stretch = (ends: readonly [SearchEnd, SearchEnd]): string => {
    const moved = stepsOf(ends).map((s) => stepText(m, s));
    return moved.length
      ? `the searched range ${rangeOf(m, ends[0].x, ends[1].x)} (${moved.join('; ')})`
      : rangeOf(m, ends[0].x, ends[1].x);
  };
  const inner =
    d.limit === 'probes'
      ? `${searchWhat(m)} did not settle: its search in ` +
        `${d.ends ? stretch(d.ends) : rangeOf(m, m.searched[0], m.searched[1])} ` +
        `did not close in ${d.count} probes${givenText(m)}`
      : `${searchWhat(m)} in ${rangeOf(m, m.searched[0], m.searched[1])} stopped before it settled ` +
        `because the design's shared evaluation budget (${d.count} evaluations) ran out — spent ` +
        `by the solves each of its probes re-runs, or by an expensive sibling elsewhere in the ` +
        `tree. It was not shown to be unsolvable`;
  return d.inSet ? `solved params ${nameList(d.members)} did not settle: ${inner}` : inner;
}

/** The message of a `hold` that does not hold where the design is sized. */
function statementFalseMessage(d: StatementFalseData): string {
  if (!d.balance)
    return `param "${d.param}": hold "${d.statement}" did not evaluate to a finite number`;
  return (
    `param "${d.param}": hold "${d.statement}" reads a device's current, so it is a current ` +
    `balance, and a current balance must be zero where the design is sized — it reads ` +
    `${amps(d.balance.reads)} here (tolerance ${amps(d.balance.tolerance)}, a millionth of ` +
    `${d.param}). Write it as the param less the current it has to equal`
  );
}

/** One cause in today's words: the message a result carries for it. */
export function causeMessage(c: Cause): string {
  switch (c.cause) {
    case 'not-read':
    case 'not-determined':
      return c.data.message;
    case 'outside-table':
      return outsideTableMessage(c.data);
    case 'cannot-evaluate':
      return c.data.reason;
    case 'no-solution':
      return noSolutionMessage(c.data, true);
    case 'no-crossing':
    case 'none-in-range':
      return noSolutionMessage(c.data, c.data.endsRead);
    case 'did-not-settle':
      return didNotSettleMessage(c.data);
    case 'limit':
      return limitMessage(c.data);
    case 'statement-false':
      return statementFalseMessage(c.data);
    case 'fails':
      // A requirement that does not hold has no message today: its row says it.
      return '';
  }
}

// ── Names and detail lines ────────────────────────────────────────────────────────────────────

/** The short name of each cause. Placeholders until the plain names are settled: one table, so
 *  the change is here alone. */
export const CAUSE_NAMES: { readonly [C in CauseName]: string } = {
  'not-read': 'not read',
  'not-determined': 'not determined',
  'outside-table': 'outside the table',
  'cannot-evaluate': 'cannot be evaluated',
  'no-solution': 'no solution (proved)',
  'no-crossing': 'no crossing, not proved',
  'none-in-range': 'none in the stated range',
  'did-not-settle': 'did not settle',
  limit: 'limit used up',
  'statement-false': 'statement false',
  fails: 'fails',
};

/** What a reader is shown for one item: a short name, and the detail lines under it. An item that
 *  is ok has no name; a withheld one names the failed items it depends on. */
export function describe(item: Item): { name: string; lines: string[] } {
  if (item.status === 'ok') return { name: '', lines: [] };
  if (item.status === 'withheld')
    return {
      name: 'withheld',
      lines: item.on.map((r) => `depends on ${[...r.path, r.name].filter(Boolean).join('.')}`),
    };
  return { name: CAUSE_NAMES[item.cause.cause], lines: [causeMessage(item.cause)] };
}
