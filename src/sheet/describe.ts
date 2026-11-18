// Every text a reader sees about an item's cause, built from the cause's data in one place. The
// code that produces a result writes data, never these sentences, so the app and a script read the
// same words, and a change of wording is a change here alone.

import type { OutsideTable } from '../types';
import { BASE_QUANTITIES, DERIVED_QUANTITIES } from '../namespace';
import { amps } from './nodes';
import { shown } from './linear';
import { formatQuantity } from '../units';
import { andList, blockMessage, type SolveRange } from './types';
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
export const stepsOf = (ends: readonly [SearchEnd, SearchEnd]): SearchStep[] => [
  ...(ends[0].stepped !== undefined
    ? [
        {
          side: 'below' as const,
          x: ends[0].x,
          reason: ends[0].stepped,
          ...(ends[0].steppedBy ? { by: ends[0].steppedBy } : {}),
        },
      ]
    : []),
  ...(ends[1].stepped !== undefined
    ? [
        {
          side: 'above' as const,
          x: ends[1].x,
          reason: ends[1].stepped,
          ...(ends[1].steppedBy ? { by: ends[1].steppedBy } : {}),
        },
      ]
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

/** One read beyond the table in words, from its fields alone. It names the quantity, not the
 *  device: a finding is attributed to its device where it is listed (a block's findings carry the
 *  block's name). */
export function outsideTableMessage(r: OutsideTable): string {
  const [lo, hi] = r.held;
  const side = r.asked > hi ? 'above' : 'below';
  // In engineering notation with the quantity's unit, to ten significant digits: an axis end built
  // by repeated addition reads 1.2 V, not 1.2000000000000002 V, and nothing a table resolves is
  // lost.
  const key = r.quantity.toLowerCase();
  const unit = [...BASE_QUANTITIES, ...DERIVED_QUANTITIES].find((q) => q.key === key)?.unit;
  const n = (v: number): string => formatQuantity(v, unit, 10);
  return (
    `${r.quantity} = ${n(r.asked)} is ${side} what the table holds for this device ` +
    `(${r.quantity} from ${n(lo)} to ${n(hi)}), so the device is not sized: no data answers for ` +
    `that point, and a value read at the table's edge would come from a different one`
  );
}

/** One read beyond a table as a finding names it: the block it belongs to, then the record's own
 *  words (outsideTableMessage). */
export const outsideMessage = (r: OutsideTable): string =>
  r.device === 'givens' || r.device === ''
    ? outsideTableMessage(r)
    : blockMessage(r.device, outsideTableMessage(r));

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
  return d.set ? `solved params ${nameList(d.set)} did not settle: ${inner}` : inner;
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
  switch (c.kind) {
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

// ── What a reader is shown: short names and detail lines ──────────────────────────────────────
//
// The texts follow one standard: each detail line is one fact made from data, at most 20 words, in
// the active voice, with no bracketed aside and no dash clause; a name from the sheet is written as
// the sheet writes it, with no quotation marks; a number is in engineering notation with an SI
// prefix and its unit, to three significant digits; a range reads "0 V to 0.9 V"; a search line
// gives the value of the quantity the designer wrote, not the difference the engine searches; the
// last line is an action only where a specific one exists, and begins with a verb.

/** What a detail line breaks of the message standard: more than 20 words, or a line that opens
 *  with a label and a colon in place of a subject and a verb. Empty for a line that keeps it. The
 *  tests read every text through this. */
export function standardProblems(line: string): string[] {
  const out: string[] = [];
  if (line.trim().split(/\s+/).length > 20) out.push('more than 20 words');
  if (/^[^\s:]+(?: [^\s:]+){0,3}:\s/.test(line)) out.push('opens with a label and a colon');
  return out;
}

/** The short name of each cause: one table, so a change of wording is here alone. Two causes share
 *  "no convergence"; their first detail line tells them apart, and the data keep the two kinds. */
export const CAUSE_NAMES: { readonly [C in CauseName]: string } = {
  'not-read': 'sheet not read',
  'not-determined': 'design not determined',
  'outside-table': 'outside the table',
  'cannot-evaluate': 'cannot be calculated',
  'no-solution': 'no solution (proved)',
  'no-crossing': 'no solution found (not proved)',
  'none-in-range': 'no solution in the stated range',
  'did-not-settle': 'no convergence',
  limit: 'no convergence',
  'statement-false': 'statement is false',
  fails: 'fails',
};

/** What an item that is withheld reads, and what a held point or range end that was not run
 *  reads. The first is not yet ruled: it is kept here alone. */
export const WITHHELD_NAME = 'not calculated';
export const NOT_ASKED_NAME = 'not run';

/** A finding as this module reads it: a kind and its data. The causes are the first family; a
 *  later family joins this union and the table in textOf, and nothing else changes. */
export type Finding = Cause;

/** What a reader is shown for a finding: a short name, and the detail lines under it. */
export interface FindingText {
  readonly name: string;
  readonly lines: readonly string[];
}

/** A number with its unit, as a reader reads one: engineering notation, three significant
 *  digits, an SI prefix joined to the unit. */
export const quantityText = (x: number, unit?: string): string => {
  // A pure number between a thousandth and ten thousand reads as itself: a share of 0.518, not
  // 518m.
  const a = Math.abs(x);
  if ((!unit || unit === '1') && (a === 0 || (a >= 1e-3 && a < 1e4)))
    return String(Number(x.toPrecision(3)));
  return formatQuantity(x, unit, 3);
};

/** A range as a reader reads one: "0 V to 0.9 V". */
const spanText = (lo: number, hi: number, unit?: string): string =>
  `${quantityText(lo, unit)} to ${quantityText(hi, unit)}`;

/** An unknown, with the blocks it belongs to in front: "in block bias: V_ref". */
const unknownName = (d: Pick<SearchData, 'path' | 'unknown'>): string =>
  d.path.length ? `in block ${d.path.join('.')}: ${d.unknown}` : d.unknown;

/** The unit a table axis or a sized quantity is quoted in, and the symbol the panel shows. */
const AXIS: Record<string, { symbol: string; unit?: string }> = {
  vgs: { symbol: 'vgs', unit: 'V' },
  vds: { symbol: 'vds', unit: 'V' },
  vsb: { symbol: 'vsb', unit: 'V' },
  l: { symbol: 'L', unit: 'm' },
  id: { symbol: 'ID', unit: 'A' },
  gm: { symbol: 'gm', unit: 'S' },
  gm_id: { symbol: 'gm/ID', unit: '1/V' },
};

/** A device as a reader reads it: the sheet's own, or a part of a block. */
const partName = (device: string): string =>
  device === '' || device === 'givens' ? 'The device of this sheet' : `Part ${device}`;

const lowerFirst = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1);

/** The lines a failed search's relation and its two ends give: what was asked, where the engine
 *  searched, and what the two sides read at the ends. */
function searchLines(
  d: SearchData & NoSolutionRead,
  where: string,
): { asked: string; searched: string[]; ends: string[] } {
  const { lhs, rhs, unit } = d.relation;
  const [lo, hi] = d.ends;
  const searched = [`Searched: ${spanText(lo.x, hi.x, d.unit)}, ${where}.`];
  const a = d.range.author;
  const w = d.range.wiring?.range;
  if (d.stage === 'physical' && a && w && (a[0] !== w[0] || a[1] !== w[1]))
    searched.unshift(
      `The search range on the sheet, ${spanText(a[0], a[1], d.unit)}, holds no solution.`,
      `The engine then searched the physical range.`,
    );
  for (const e of d.ends)
    if (e.stepped !== undefined)
      searched.push(
        e.steppedOutside
          ? `The search stopped at ${quantityText(e.x, d.unit)}: ${lowerFirst(partName(e.steppedOutside.device))} is outside the table there.`
          : `The search stopped at ${quantityText(e.x, d.unit)}: ${lhs} gives no number beyond it.`,
      );
  const rv = lo.rhs === hi.rhs ? `${rhs} is ${quantityText(lo.rhs, unit)}.` : '';
  return {
    asked: `No ${unknownName(d)} gives ${lhs} = ${rhs}.`,
    searched,
    ends: [
      `${lhs} at the two ends: ${quantityText(lo.lhs, unit)} and ${quantityText(hi.lhs, unit)}.` +
        (rv ? ` ${rv}` : ''),
    ],
  };
}

/** Where a failed search's stretch lies, in the words of its source. */
const whereText = (d: SearchData): string =>
  d.stage === 'physical'
    ? 'the full range that the circuit permits'
    : d.stage === 'table'
      ? 'the lengths the table holds'
      : 'the search range on the sheet';

/** The other members of a set, where each stood during the search. */
const givenLines = (d: SearchData): string[] =>
  (d.given ?? []).map((o) => `${o.name} was ${quantityText(o.value, o.unit)} during this search.`);

/** Which way the written side moved across the stretch. */
const direction = (d: NoSolutionRead): string =>
  d.ends[1].lhs >= d.ends[0].lhs ? 'only rises' : 'only falls';

function noSolutionText(
  c: Extract<Cause, { kind: 'no-solution' | 'no-crossing' | 'none-in-range' }>,
): string[] {
  const d = c.data;
  const { lhs, rhs } = d.relation;
  const U = unknownName(d);
  const e = d.ended;
  if (e.kind === 'flat')
    return [
      `${lhs} does not change with ${U}.`,
      `${lhs} is ${quantityText(d.ends[0].lhs, d.relation.unit)} at both ends and the middle of ${spanText(d.ends[0].x, d.ends[1].x, d.unit)}.`,
      `Write a constraint on ${U} that reads ${U}.`,
    ];
  if (e.kind === 'held-flat')
    return [
      `${lhs} does not move with ${U} across ${spanText(d.ends[0].x, d.ends[1].x, d.unit)}.`,
      `The hold on ${U} does not determine it.`,
    ];
  const s = searchLines(d, whereText(d));
  const lines = [s.asked, ...s.searched, ...s.ends];
  if (e.kind === 'step')
    lines.push(
      `${lhs} jumps across ${rhs} at ${U} = ${quantityText(e.at.x, d.unit)}, without reaching it.`,
    );
  if (c.kind === 'no-solution') lines.push(`Proved: ${lhs} ${direction(d)} with ${U}.`);
  else if (c.kind === 'no-crossing' && e.kind === 'sign')
    lines.push(`Not proved: the engine did not show that ${lhs} ${direction(d)} with ${U}.`);
  else if (c.kind === 'none-in-range') {
    if (d.range.from === 'table') lines.push(`Use a table that holds a wider range of lengths.`);
    else {
      lines.splice(1, 0, `The engine did not search outside the search range on the sheet.`);
      lines.push(`Widen the search range of ${U}.`);
    }
  }
  return [...lines, ...givenLines(d)];
}

function didNotSettleText(d: DidNotSettleData): string[] {
  const names = andList(d.members.map(unknownName));
  const why = d.why;
  const simpl = d.simplifications.length
    ? [`Declare a simplification to separate them: ${d.simplifications.join(', ')}.`]
    : [];
  if (why.kind === 'sweeps') {
    const m = d.members.find((x) => x.unknown === why.moved.name) as SearchData;
    return [
      `${names} read each other.`,
      `The engine searched them in turn ${why.sweeps} times. They still moved.`,
      `In the last pass, ${unknownName(m)} moved by ${quantityText(why.moved.by, m.unit)}.`,
      ...simpl,
    ];
  }
  if (why.kind === 'member') {
    const inner = textOf(why.failure);
    return [
      `${names} read each other.`,
      `One search found no solution while the others held their values.`,
      ...inner.lines.slice(0, 1),
      ...simpl,
    ];
  }
  if (why.kind === 'verification')
    return why.off.map((o) => {
      const m = d.members.find((x) => x.unknown === o.name) as SearchData;
      return `The solution for ${unknownName(m)} moved after the engine found it.`;
    });
  const m = d.members[0];
  const at = why.at;
  if (at.where === 'nowhere')
    return [
      `${m.relation.lhs} gives no number anywhere in ${spanText(m.searched[0], m.searched[1], m.unit)}.`,
      `The engine searched ${unknownName(m)} there.`,
    ];
  if (at.where === 'one-point')
    return [
      `${m.relation.lhs} gives a number only at ${unknownName(m)} = ${quantityText(at.end.x, m.unit)}.`,
      `The engine searched ${spanText(m.searched[0], m.searched[1], m.unit)}.`,
    ];
  return [
    `${m.relation.lhs} crosses ${m.relation.rhs} between ${quantityText(at.between[0], m.unit)} and ${quantityText(at.between[1], m.unit)}.`,
    `It gives no number at the values the engine tried there.`,
  ];
}

function limitText(d: LimitData): string[] {
  const m = d.members[0];
  return d.limit === 'evaluations'
    ? [
        `The engine stopped at its limit of ${d.count} calculations.`,
        `The last search was for ${unknownName(m)}.`,
        `Raise the limit in the solver settings.`,
      ]
    : [
        `The search for ${unknownName(m)} stopped at its limit of ${d.count} trial values.`,
        `Narrow the search range of ${unknownName(m)}.`,
      ];
}

function statementFalseText(d: StatementFalseData): string[] {
  const at = d.balance
    ? `At the design point: it reads ${quantityText(d.balance.reads, 'A')}, not zero.`
    : `At the design point: it gives no number.`;
  return [`The sheet states: ${d.param} holds ${d.statement}.`, at];
}

/** Every text a reader sees for one finding, from its kind and data alone. */
export function textOf(f: Finding): FindingText {
  return { name: CAUSE_NAMES[f.kind], lines: linesOf(f) };
}

function linesOf(c: Cause): string[] {
  switch (c.kind) {
    case 'not-read':
      return [`The sheet cannot be read.`, c.data.message];
    case 'not-determined':
      return [`The statements do not determine one design.`, c.data.message];
    case 'outside-table': {
      const a = AXIS[c.data.quantity] ?? { symbol: c.data.quantity };
      const [lo, hi] = c.data.held;
      return [
        `${partName(c.data.device)}: ${a.symbol} = ${quantityText(c.data.asked, a.unit)}.`,
        `The table holds ${spanText(lo, hi, a.unit)}.`,
      ];
    }
    case 'cannot-evaluate':
      return [
        `${c.data.name} gives no number.`,
        c.data.why === 'not-defined' ? `${c.data.name} is not defined.` : c.data.reason,
      ];
    case 'no-solution':
    case 'no-crossing':
    case 'none-in-range':
      return noSolutionText(c);
    case 'did-not-settle':
      return didNotSettleText(c.data);
    case 'limit':
      return limitText(c.data);
    case 'statement-false':
      return statementFalseText(c.data);
    case 'fails': {
      const t = c.data.text;
      const required = t.op === '>=' ? 'at least' : t.op === '<=' ? 'at most' : 'equal to';
      return [
        `${t.lhs} = ${quantityText(c.data.lhs)}. Required: ${required} ${quantityText(c.data.rhs)}.`,
        `Margin: ${c.data.marginPct >= 0 ? '+' : '−'}${quantityText(Math.abs(c.data.marginPct))} %.`,
      ];
    }
  }
}

/** What a reader is shown for one item: nothing for an item that is ok; for a failed one, its
 *  cause's text; for a withheld one, one line for each failed item it depends on. */
export function describe(item: Item): FindingText {
  if (item.status === 'ok') return { name: '', lines: [] };
  if (item.status === 'withheld')
    return {
      name: WITHHELD_NAME,
      lines: item.on.map(
        (r) =>
          `Depends on ${[...r.path, r.name].filter(Boolean).join('.')}: ${CAUSE_NAMES[r.cause]}.`,
      ),
    };
  return textOf(item.cause);
}

/** What a held point or range end that was not run is shown: its own word, and why. */
export const notAskedText = (what: 'range end' | 'held point'): FindingText => ({
  name: NOT_ASKED_NAME,
  lines: [`The design point has no design, so the engine did not run this ${what}.`],
});
