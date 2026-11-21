// Every text a reader sees about an item's cause, built from the cause's data in one place. The
// code that produces a result writes data, never these sentences, so the app and a script read the
// same words, and a change of wording is a change here alone.

import type { LevelRefusal, NetlistAbout, OutsideTable, PlacementFault } from '../types';
import { BASE_QUANTITIES, DERIVED_QUANTITIES } from '../namespace';
import { amps } from './nodes';
import { shown } from './linear';
import { formatQuantity } from '../units';
import {
  andList,
  blockMessage,
  FORMAT_VERSION,
  REGION_CHECK_ID,
  type CheckOp,
  type SolveRange,
} from './types';
import type {
  Attributes,
  CannotEvaluateData,
  Cause,
  CauseName,
  DesignVerdict,
  DidNotSettleData,
  FailsData,
  HeldVerdict,
  Item,
  ItemRef,
  LimitData,
  NotDeterminedData,
  NotReadData,
  OutsideTableData,
  NoSolutionRead,
  SearchData,
  SearchEnd,
  SearchStep,
  StatementFalseData,
  UnevaluableAt,
  Verdict,
  WithheldOn,
} from './states';
import { incompleteOn } from './states';

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
 *  own may be in the wrong place; the wiring's range is where the circuit can put the wire, and no
 *  crossing there — even read at both ends — is no solution found, not a proof that none exists. */
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
    ? `The circuit can put the wire nowhere else. The engine found no solution there, and this is ` +
        `not a proof that none exists`
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
      // A hold that gives no number keeps the words today's fields carry for it.
      if (c.data.hold) return statementFalseMessage(c.data.hold);
      // A relation that gives no number across the stretch keeps the words it had as a search that
      // did not settle.
      if (c.data.unevaluable)
        return didNotSettleMessage({
          members: [c.data.unevaluable.member],
          simplifications: [],
          why: { kind: 'unevaluable', at: c.data.unevaluable.at },
        });
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
// prefix and its unit, to three significant digits; a range reads "from 0 V to 0.9 V", in one
// prefix; a search line gives the value of the quantity the designer wrote, not the difference the
// engine searches; the last line is an action only where a specific one exists, and begins with a
// verb.
//
// A line is a list of segments: plain text, a name from the sheet, or an expression from the
// sheet. The panel sets names and expressions in code font; `lineText` gives the plain string a
// script or a test reads. The standard's checks read the text segments only, and a name or an
// expression counts as one word.

/** One piece of a line: the engine's own words, a name the sheet writes, or an expression the
 *  sheet writes. */
export interface Segment {
  /** `value`: a value as the sheet writes it (a number, a word, a reference), set apart from the
   *  words of the sentence. */
  readonly kind: 'text' | 'name' | 'expr' | 'value';
  readonly text: string;
  /** For a name that names an item of the result: that item, so a reader can link to it. */
  readonly ref?: ItemRef;
}

/** A detail line, as segments. */
export type Line = readonly Segment[];

/** A name from the sheet, as a segment. */
export const nm = (text: string, ref?: ItemRef): Segment => ({
  kind: 'name',
  text,
  ...(ref ? { ref } : {}),
});
/** An expression from the sheet, as a segment. */
const ex = (text: string): Segment => ({ kind: 'expr', text: text.trim() });

type Part = string | Segment | Line;

const isSegment = (p: Part): p is Segment => typeof p === 'object' && !Array.isArray(p);

/** Builds a line: the template's own text is text, an interpolated string is text, and a segment
 *  or a line is spliced in as it is. Neighbouring text segments are joined. */
export function t(strings: TemplateStringsArray, ...parts: Part[]): Line {
  const out: Segment[] = [];
  const push = (s: Segment): void => {
    if (!s.text) return;
    const last = out[out.length - 1];
    if (s.kind === 'text' && last?.kind === 'text')
      out[out.length - 1] = { kind: 'text', text: last.text + s.text };
    else out.push(s);
  };
  strings.forEach((str, k) => {
    push({ kind: 'text', text: str });
    if (k < parts.length) {
      const p = parts[k] as Part | undefined | null;
      // A part the data left out (a word looked up for a value no table lists) adds nothing,
      // rather than stopping the text.
      if (p === undefined || p === null) return;
      if (typeof p === 'string') push({ kind: 'text', text: p });
      else if (isSegment(p)) push(p);
      else p.forEach(push);
    }
  });
  return out;
}

/** The plain string of a line, for a script, a log or a test. */
export const lineText = (line: Line): string => line.map((s) => s.text).join('');

/** Lines joined as a list reads: "a, b and c". */
export const andLines = (ls: readonly Line[]): Line =>
  ls.reduce<Line>(
    (acc, l, k) => (k === 0 ? l : t`${acc}${k === ls.length - 1 ? ' and ' : ', '}${l}`),
    [],
  );

/** What a detail line breaks of the message standard; empty for a line that keeps it. The checks
 *  read the text segments only, and a name or an expression counts as one word. The tests read
 *  every text through this. */
export function standardProblems(line: string | Line): string[] {
  const segs: Line = typeof line === 'string' ? [{ kind: 'text', text: line }] : line;
  // A name or an expression stands as one word that no pattern reads.
  const text = segs.map((s) => (s.kind === 'text' ? s.text : 'N')).join('');
  const out: string[] = [];
  const has = (re: RegExp, what: string): void => {
    if (re.test(text)) out.push(what);
  };
  if (text.trim().split(/\s+/).length > 20) out.push('more than 20 words');
  const label = /^[^\s:]+(?: [^\s:]+){0,3}:\s/;
  has(label, 'opens with a label and a colon');
  if (!label.test(text)) has(/:\s/, 'a colon inside the line');
  has(/\d(\.\d+)?e[-+]?\d/, 'a raw exponent');
  // Significant digits, counted without leading zeros and an integer's trailing zeros: 0.0643
  // has three, 10000 has one.
  for (const n of text.match(/\d+(?:\.\d+)?/g) ?? []) {
    const digits = n.includes('.')
      ? n.replace('.', '').replace(/^0+/, '')
      : n.replace(/^0+/, '').replace(/0+$/, '');
    if (digits.length > 4) {
      out.push('more than four significant digits');
      break;
    }
  }
  has(/["“”]/, 'a quotation mark');
  has(/\([^)]*\s[^)]*\)/, 'a bracketed aside');
  has(/\s[—–]\s|\s-\s/, 'a dash clause');
  has(/\w__\w/, 'a name in the code spelling');
  // "bracket" is the search's word; a square bracket is the reader's.
  has(
    /\b(lhs|rhs|givens|param|override|probe|clamp|crossing|finite|resolve)\b|(?<!square )\bbracket\b/,
    'a word of the code',
  );
  has(/\[[^\]]*,[^\]]*\]/, 'a range in square brackets');
  const range = /from (-?[\d.]+) ([^\s\d.,]*) to (-?[\d.]+) ([^\s\d.,]*)/.exec(text);
  if (range && range[2] !== range[4]) out.push('two prefixes in one range');
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

/** The word each verdict reads, in lower case as the item texts are: every design verdict, every
 *  verdict at a held point, and `not-calculated` for a range end or a block that has no verdict, as
 *  the engine did not calculate it. A design and a held point share the words `non-compliant` and
 *  `undetermined`. Every reader takes a verdict's word from here, and the words still open are
 *  changed here alone. */
export const VERDICT_WORDS: Readonly<
  Record<DesignVerdict | HeldVerdict | 'not-calculated', string>
> = {
  feasible: 'feasible',
  'non-compliant': 'non-compliant',
  infeasible: 'infeasible',
  undetermined: 'undetermined',
  compliant: 'compliant',
  'no-operating-point': 'no operating point',
  'not-calculated': 'not calculated',
};

/** What an item that is withheld reads (the word of a verdict not calculated, VERDICT_WORDS), and
 *  what a held point or range end that was not run reads. */
export const WITHHELD_NAME = VERDICT_WORDS['not-calculated'];
export const NOT_ASKED_NAME = 'not run';

/** A finding as this module reads it: a kind and its data. The causes are the first family; a
 *  later family joins this union and the table in textOf, and nothing else changes. */
export type Finding = Cause;

/** What a reader is shown for a finding: a short name, and the detail lines under it, as segments
 *  and as the plain strings `lineText` gives. */
export interface FindingText {
  readonly name: string;
  readonly segments: readonly Line[];
  readonly lines: readonly string[];
}

const finding = (name: string, segments: readonly Line[]): FindingText => ({
  name,
  segments,
  lines: segments.map(lineText),
});

/** A number with its unit, as a reader reads one: three significant digits, and an SI prefix
 *  joined to the unit. A value from a tenth up to one reads without a prefix (0.45 V, not
 *  450 mV), a ratio of like units takes no prefix, and a pure number from a thousandth up to ten
 *  thousand reads as itself. */
export const quantityText = (x: number, unit?: string, digits = 3): string =>
  withMinus(quantityDigits(x, unit, digits));

/** A negative number as text reads it, with the minus sign and not the hyphen. */
const withMinus = (s: string): string => s.replace(/^-/, '−');

const quantityDigits = (x: number, unit: string | undefined, digits: number): string => {
  const a = Math.abs(Number(x.toPrecision(digits)));
  const plain = String(Number(x.toPrecision(digits)));
  if (!unit || unit === '1') {
    if (a === 0 || (a >= 1e-3 && a < 1e4)) return plain;
    return formatQuantity(x, unit, digits);
  }
  // A ratio of like units (V/V, A/A) is a pure number with its unit after it: 8090 V/V.
  if ((a >= 0.1 && a < 1) || /^(\w+)\/\1$/.test(unit)) return `${plain} ${unit}`;
  return formatQuantity(x, unit, digits);
};

/** `x` with one more digit where three read it the same as `from`: an end the search stepped in
 *  from by less than the rounding. Four at most, which the message standard allows. */
const apartText = (x: number, from: number, unit?: string): string => {
  for (let digits = 3; digits <= 4; digits++) {
    const a = quantityText(x, unit, digits);
    if (x === from || a !== quantityText(from, unit, digits)) return a;
  }
  return quantityText(x, unit, 4);
};

/** The SI prefix of each engineering group a range is quoted in. */
const SI_PREFIX: Record<number, string> = {
  [-15]: 'f',
  [-12]: 'p',
  [-9]: 'n',
  [-6]: 'µ',
  [-3]: 'm',
  3: 'k',
  6: 'M',
  9: 'G',
  12: 'T',
};

/** A range as a reader reads one: "from 0.05 V to 0.7 V". Both ends take the prefix of the
 *  larger, and the smaller is rounded to the larger's last digit, so one range never reads in two
 *  prefixes. A pure number and a ratio of like units keep their own forms. */
const spanText = (lo: number, hi: number, unit?: string): string => {
  const big = Math.max(Math.abs(lo), Math.abs(hi));
  if (!unit || unit === '1' || /^(\w+)\/\1$/.test(unit) || big === 0 || !Number.isFinite(big))
    return `from ${quantityText(lo, unit)} to ${quantityText(hi, unit)}`;
  const shownBig = Number(big.toPrecision(3));
  // The prefix: none from a tenth up to one, else the engineering group of the larger end.
  const exp3 = shownBig >= 0.1 && shownBig < 1 ? 0 : Math.floor(Math.log10(shownBig) / 3) * 3;
  const decimals = Math.max(0, 2 - Math.floor(Math.log10(shownBig / 10 ** exp3)));
  const num = (x: number): string => {
    const n = Number((x / 10 ** exp3).toFixed(decimals));
    return withMinus(String(n === 0 ? 0 : n));
  };
  const prefix = exp3 === 0 ? '' : (SI_PREFIX[exp3] ?? '');
  return `from ${num(lo)} ${prefix}${unit} to ${num(hi)} ${prefix}${unit}`;
};

/** A block by its path, naming its sheet item. */
const blockSegment = (path: readonly string[]): Segment =>
  nm(path.join('.'), { kind: 'sheet', path, name: '' });

/** A name with the blocks it belongs to after it: "V_ref in block bias". The name links to the
 *  item it is, where the caller knows which. */
const inBlock = (name: string, path: readonly string[], ref?: ItemRef): Line =>
  path.length ? t`${nm(name, ref)} in block ${blockSegment(path)}` : [nm(name, ref)];

/** An unknown as a reader reads it. */
const unknownName = (d: Pick<SearchData, 'path' | 'unknown'>): Line =>
  inBlock(d.unknown, d.path, { kind: 'search', path: d.path, name: d.unknown });

/** The plain words and the unit for each quantity a table is read at or a device is sized by:
 *  one table, so a sentence can say "a length of 5 µm" and "the table holds lengths". */
const QUANTITY_WORDS: Record<string, { one: string; many: string; unit?: string }> = {
  vgs: { one: 'gate-source voltage', many: 'gate-source voltages', unit: 'V' },
  vds: { one: 'drain-source voltage', many: 'drain-source voltages', unit: 'V' },
  vsb: { one: 'source-body voltage', many: 'source-body voltages', unit: 'V' },
  l: { one: 'length', many: 'lengths', unit: 'm' },
  id: { one: 'drain current', many: 'drain currents', unit: 'A' },
  gm: { one: 'transconductance', many: 'transconductances', unit: 'S' },
  gm_id: { one: 'gm/ID', many: 'values of gm/ID', unit: 'S/A' },
};
const quantityWords = (q: string): { one: string; many: string; unit?: string } =>
  QUANTITY_WORDS[q] ?? { one: q, many: `values of ${q}` };

/** The device quantities a table holds or the namespace derives, by key. */
const DEVICE_KEYS = new Set([...BASE_QUANTITIES, ...DERIVED_QUANTITIES].map((q) => q.key));

/** A device quantity in a sentence: its plain words where the table has them, else its symbol. */
const deviceQuantity = (key: string): Line =>
  QUANTITY_WORDS[key] ? t`the ${QUANTITY_WORDS[key].one}` : [nm(key)];

/** A name as a reader reads it: a block's output in plain words ("the drain current of part in",
 *  "V_b of block pbias"), anything else as the sheet writes it. */
export const nameText = (n: string): Line => {
  const parts = n.trim().split('__');
  if (parts.length < 2 || parts.some((p) => !p)) return [nm(n.trim())];
  const last = parts.pop() as string;
  const where = parts.join('.');
  if (DEVICE_KEYS.has(last)) return t`${deviceQuantity(last)} of part ${nm(where)}`;
  return t`${nm(last)} of block ${nm(where)}`;
};

/** A device as a reader reads it, by the path a record names it with: the sheet's own, or the
 *  part a block is. */
const partName = (device: string): Line =>
  device === '' || device === 'givens'
    ? t`the device of this sheet`
    : t`part ${nm(device, { kind: 'device', path: device.split('.'), name: 'givens' })}`;

/** Any item as the subject of a sentence names it. */
const itemName = (r: ItemRef): Line => {
  if (r.kind === 'sheet') return r.path.length ? t`block ${blockSegment(r.path)}` : t`the sheet`;
  if (r.kind === 'device') {
    const own = r.name === '' || r.name === 'givens';
    return own && r.path.length ? partName(r.path.join('.')) : partName(r.name);
  }
  return inBlock(r.name, r.path, { kind: r.kind, path: r.path, name: r.name });
};

/** The first letter of a sentence made capital where the engine's own word opens it ("Part in",
 *  "The device"); a name from the sheet keeps the case the sheet writes it in. */
const upperFirst = (l: Line): Line => {
  const [first, ...rest] = l;
  if (first?.kind !== 'text' || !/^(the|part|block|neither) /.test(first.text)) return l;
  return [
    { kind: 'text', text: first.text.charAt(0).toUpperCase() + first.text.slice(1) },
    ...rest,
  ];
};

/** Whether a side is a single name, which a sentence can quote; a longer expression is named by
 *  its place, and shown once in its own line. */
const isName = (s: string): boolean => /^[A-Za-z_][\w.]*$/.test(s.trim());

/** The two sides of a relation as a sentence names them: each by its name where it is one, and
 *  both by their place where either is an expression. */
const sidesOf = (r: { lhs: string; rhs: string }): { lhs: Line; rhs: Line } =>
  isName(r.lhs) && isName(r.rhs)
    ? { lhs: nameText(r.lhs), rhs: nameText(r.rhs) }
    : { lhs: t`the left side`, rhs: t`the right side` };

/** What a monotonic relation would mean, in the words of its two sides: the right side changes
 *  more slowly than the unknown where the left side is the unknown itself; the left side only
 *  rises or falls where the right reads only typed values, so it is the same everywhere; otherwise
 *  the gap between them only grows or only shrinks. The way is read from the left side minus the
 *  right. Two equal end values do not make a side constant. */
function monotonicText(d: SearchData & NoSolutionRead): Line {
  const { lhs, rhs } = sidesOf(d.relation);
  const U = unknownName(d);
  const [lo, hi] = d.ends;
  const rises = hi.lhs - hi.rhs >= lo.lhs - lo.rhs;
  if (d.relation.lhs.trim() === d.unknown) return t`${rhs} changes more slowly than ${U}`;
  if (d.relation.rhsFixed) return t`${lhs} ${rises ? 'only rises' : 'only falls'} with ${U}`;
  return t`the gap between the two sides only ${rises ? 'grows' : 'shrinks'} with ${U}`;
}

/** The unit the two sides of a relation are quoted in: the relation's own, or, until the relation
 *  carries one, the unknown's where the unknown is a level. */
const relationUnit = (d: SearchData): string | undefined =>
  d.relation.unit ??
  (d.unit === 'V' ? 'V' : (quantityUnitOf(d.relation.lhs) ?? quantityUnitOf(d.relation.rhs)));

/** The unit a side is in where the side is one device quantity of a part the text names in
 *  plain words, such as a drain current, which is in A. */
const quantityUnitOf = (side: string): string | undefined => {
  const parts = side.trim().split('__');
  return parts.length >= 2 && isName(side)
    ? QUANTITY_WORDS[parts[parts.length - 1]]?.unit
    : undefined;
};

/** A search's relation as the subject of a sentence: "the constraint of k_x". */
const relationName = (d: SearchData): Line =>
  d.relation.field === 'hold'
    ? t`the hold on ${unknownName(d)}`
    : d.relation.field === 'solveFor'
      ? t`the equation of ${unknownName(d)}`
      : t`the constraint of ${unknownName(d)}`;

/** The line that shows a relation once, where a sentence names its sides by their place. */
function relationLine(d: SearchData): Line[] {
  if (isName(d.relation.lhs) && isName(d.relation.rhs)) return [];
  const U = unknownName(d);
  const what =
    d.relation.field === 'hold'
      ? t`The hold on ${U}`
      : d.relation.field === 'solveFor'
        ? t`The equation of ${U}`
        : t`The constraint of ${U}`;
  return [t`${what} is ${ex(`${d.relation.lhs.trim()} = ${d.relation.rhs.trim()}`)}.`];
}

/** Whether a search stepped in from an end of its range, so it did not read the whole of it. */
/** Whether the search stepped end `k` in from the range by more than a thousandth of the range: a
 *  step that small sits at the numerical edge of the range, says nothing a designer can use, and
 *  reads as the range end. The data keep the true numbers. */
const farStep = (d: SearchData & NoSolutionRead, k: 0 | 1): boolean => {
  const e = d.ends[k];
  if (e.stepped === undefined) return false;
  const { span } = rangeGiven(d);
  return (
    Math.abs(e.x - span[k]) > 1e-3 * Math.abs(span[1] - span[0]) &&
    quantityText(e.x, d.unit, 4) !== quantityText(span[k], d.unit, 4)
  );
};

const steppedIn = (d: SearchData & NoSolutionRead): boolean => farStep(d, 0) || farStep(d, 1);

/** The range a failed search was given, and how the reader names it. */
function rangeGiven(d: SearchData): { span: [number, number]; what: Line } {
  const w = d.range.wiring?.range;
  const wire = d.range.wires?.[0];
  if (d.stage === 'physical' && w)
    return {
      span: [w[0], w[1]],
      what: wire
        ? t`the physical range of wire ${nm(wire)}`
        : t`the physical range of ${unknownName(d)}`,
    };
  if (d.stage === 'table')
    return { span: [d.searched[0], d.searched[1]], what: t`the lengths that the table holds` };
  return { span: [d.searched[0], d.searched[1]], what: t`the search range on the sheet` };
}

/** The lines that say where a failed search searched. Where it read its whole range: one
 *  sentence. Where it stepped in from an end: the range, the stretch it searched, and why each
 *  end stepped in. */
function searchedLines(d: SearchData & NoSolutionRead): Line[] {
  const { span, what } = rangeGiven(d);
  const range = spanText(span[0], span[1], d.unit);
  if (!steppedIn(d))
    return [
      d.stage === 'physical' && d.range.wiring
        ? d.range.wires?.[0]
          ? t`The engine searched the full physical range of wire ${nm(d.range.wires[0])}, ${range}.`
          : t`The engine searched the full physical range of ${unknownName(d)}, ${range}.`
        : t`The engine searched ${what}, ${range}.`,
    ];
  // Each end stepped in far enough to matter has its own line, which says where the search stopped;
  // a line of the stretch searched would repeat them.
  const lines: Line[] = [t`${what} is ${range}.`];
  d.ends.forEach((e, k) => {
    if (!farStep(d, k as 0 | 1)) return;
    const past = `${k === 0 ? 'Below' : 'Above'} ${apartText(e.x, span[k], d.unit)}`;
    lines.push(
      e.steppedOutside
        ? t`${past}, ${partName(e.steppedOutside.device)} is outside its table.`
        : t`${past}, ${relationName(d)} gives no number.`,
    );
  });
  return lines;
}

/** A side's values at the two ends of the stretch searched: named "the low end" and "the high
 *  end" where the search read its whole range, and by their values where it stepped in. */
function endValues(
  d: SearchData & NoSolutionRead,
  side: Line,
  a: number,
  b: number,
  unit?: string,
): Line {
  const { span } = rangeGiven(d);
  // An end the search stepped in from far enough to matter, by where it stopped; otherwise by name.
  const at = (k: 0 | 1): string =>
    farStep(d, k)
      ? `at ${apartText(d.ends[k].x, span[k], d.unit)}`
      : k === 0
        ? 'at the low end'
        : 'at the high end';
  return t`${side} is ${quantityText(a, unit)} ${at(0)} and ${quantityText(b, unit)} ${at(1)}.`;
}

/** The lines every failed search gives: what has no solution, the relation where its sides are
 *  expressions, where the engine searched, and what the two sides read at the ends. */
function searchLines(
  c: Extract<Cause, { kind: 'no-solution' | 'no-crossing' | 'none-in-range' }>,
): Line[] {
  const d = c.data;
  const { lhs, rhs } = sidesOf(d.relation);
  const unit = relationUnit(d);
  const [lo, hi] = d.ends;
  const U = unknownName(d);
  const lines: Line[] = [];
  if (c.kind === 'none-in-range' && d.stage === 'sheet') {
    lines.push(
      t`No value of ${U} ${spanText(d.searched[0], d.searched[1], d.unit)} makes ${lhs} equal to ${rhs}.`,
      ...relationLine(d),
      t`This range is the search range on the sheet, and the engine did not search outside it.`,
    );
  } else {
    lines.push(t`No value of ${U} makes ${lhs} equal to ${rhs}.`, ...relationLine(d));
    const a = d.range.author;
    const w = d.range.wiring?.range;
    if (d.stage === 'physical' && a && w && (a[0] !== w[0] || a[1] !== w[1]))
      lines.push(
        t`The search range on the sheet, ${spanText(a[0], a[1], d.unit)}, holds no solution.`,
        t`The engine then searched the physical range.`,
      );
    lines.push(...searchedLines(d));
  }
  // Where the left side is the unknown itself, its values at the ends are the range again.
  if (d.relation.lhs.trim() !== d.unknown) lines.push(endValues(d, lhs, lo.lhs, hi.lhs, unit));
  lines.push(
    d.relation.rhsFixed
      ? t`${rhs} is ${quantityText(lo.rhs, unit)}.`
      : lo.rhs === hi.rhs
        ? t`${rhs} is ${quantityText(lo.rhs, unit)} at both ends.`
        : endValues(d, rhs, lo.rhs, hi.rhs, unit),
  );
  return lines;
}

/** For a member of a set that failed where the others were held: that they read each other. */
const setLines = (d: SearchData): Line[] =>
  d.set && d.set.length > 1 ? [t`${andLines(d.set.map(unknownName))} depend on each other.`] : [];

/** The other members of a set, where the engine held each during the search. */
const givenLines = (d: SearchData): Line[] =>
  (d.given ?? []).map(
    (o) =>
      t`The engine held ${nameText(o.name)} at ${quantityText(o.value, o.unit)} during this search.`,
  );

function noSolutionText(
  c: Extract<Cause, { kind: 'no-solution' | 'no-crossing' | 'none-in-range' }>,
): Line[] {
  const d = c.data;
  const { lhs, rhs } = sidesOf(d.relation);
  const U = unknownName(d);
  const e = d.ended;
  const span = spanText(d.ends[0].x, d.ends[1].x, d.unit);
  if (e.kind === 'flat')
    return [
      t`${lhs} does not change with ${U}.`,
      ...relationLine(d),
      t`${lhs} is ${quantityText(d.ends[0].lhs, relationUnit(d))} at both ends and at the middle of the range ${span}.`,
      t`Change the constraint of ${U} so that it reads ${U}.`,
    ];
  if (e.kind === 'held-flat')
    return [
      t`${lhs} does not change with ${U} ${span}.`,
      t`The hold on ${U} does not determine ${U}.`,
    ];
  const lines = searchLines(c);
  if (e.kind === 'step')
    lines.push(
      t`${lhs} jumps past ${rhs} at ${U} = ${quantityText(e.at.x, d.unit)} without reaching it.`,
    );
  if (c.kind === 'no-solution') lines.push(t`${monotonicText(d)}, so no solution exists.`);
  else if (c.kind === 'no-crossing') {
    lines.push(t`This is not a proof.`);
    if (e.kind === 'sign' && c.data.notProof === 'not-monotonic')
      lines.push(t`The engine did not show that ${monotonicText(d)}.`);
  } else if (d.range.from === 'table')
    lines.push(t`Load a table that holds a wider range of lengths.`);
  else if (d.stage === 'sheet') lines.push(t`Widen the search range of ${U}.`);
  return [...lines, ...setLines(d), ...givenLines(d)];
}

/** The simplifications that would separate a set, as one sentence. */
const simplificationLines = (d: DidNotSettleData): Line[] =>
  d.simplifications.length
    ? [
        t`A declared simplification can separate them, for example ${d.simplifications.join(' or ')}.`,
      ]
    : [];

function didNotSettleText(d: DidNotSettleData): Line[] {
  const names = andLines(d.members.map(unknownName));
  const why = d.why;
  const pair = d.members.length > 1 ? [t`${names} depend on each other.`] : [];
  // A member the data name, or the name alone where the list does not hold it.
  const member = (name: string): Line => {
    const m = d.members.find((x) => x.unknown === name);
    return m ? unknownName(m) : [nm(name)];
  };
  if (why.kind === 'sweeps') {
    const m = d.members.find((x) => x.unknown === why.moved.name);
    return [
      ...pair,
      t`The engine searched them in turn ${String(why.sweeps)} times, and they still moved.`,
      t`In the last pass, ${member(why.moved.name)} moved by ${quantityText(why.moved.by, m?.unit)}.`,
      ...simplificationLines(d),
    ];
  }
  if (why.kind === 'member') {
    const inner = linesOf(why.failure);
    return [
      ...pair,
      t`One search found no solution while the engine held the others.`,
      ...inner.slice(0, 1),
      ...simplificationLines(d),
    ];
  }
  if (why.kind === 'verification') {
    const off = why.off.map((o) => {
      const m = d.members.find((x) => x.unknown === o.name);
      const gap =
        o.lhs !== undefined && o.rhs !== undefined
          ? ` by ${quantityText(Math.abs(o.lhs - o.rhs), m ? relationUnit(m) : undefined)}`
          : '';
      return t`When the engine checked the solution, the two sides for ${member(o.name)} differed${gap}.`;
    });
    return [
      ...pair,
      ...(off.length ? off : [t`When the engine checked the solution, its two sides differed.`]),
    ];
  }
  return d.members[0]
    ? unevaluableLines(d.members[0], why.at)
    : [t`A relation of the search gives no number where the engine tried it.`];
}

/** What stopped the points a search tried: the first item that failed there, in its cause's own
 *  first lines, or by name where the data hold no cause. */
function stoppedBy(at: { by?: ItemRef; byCause?: Cause }): Line[] {
  if (!at.by) return [];
  if (at.byCause) return linesOf(at.byCause, at.by).slice(0, 2).map(upperFirst);
  return [t`${itemName(at.by)} gives no number there.`];
}

/** Where a search found its relation giving no number, and what it searched. */
function unevaluableLines(m: SearchData, at: UnevaluableAt): Line[] {
  const { lhs, rhs } = sidesOf(m.relation);
  const span = spanText(m.searched[0], m.searched[1], m.unit);
  if (at.where === 'nowhere')
    return [
      t`The engine searched ${unknownName(m)} ${span}.`,
      ...relationLine(m),
      t`${relationName(m)} gives no number at any value that the engine tried.`,
      ...stoppedBy(at),
    ];
  if (at.where === 'one-point')
    return [
      t`${relationName(m)} gives a number only at ${unknownName(m)} = ${quantityText(at.end.x, m.unit)}.`,
      ...relationLine(m),
      t`The engine searched ${unknownName(m)} ${span}.`,
    ];
  return [
    t`${lhs} crosses ${rhs} between ${quantityText(at.between[0], m.unit)} and ${quantityText(at.between[1], m.unit)}.`,
    ...relationLine(m),
    t`${relationName(m)} gives no number at the values that the engine tried there.`,
    ...stoppedBy(at),
  ];
}

function limitText(d: LimitData): Line[] {
  const m = d.members[0];
  if (!m)
    return [
      d.limit === 'evaluations'
        ? t`The engine stopped after ${String(d.count)} calculations, because it reached its limit.`
        : t`A search stopped after ${String(d.count)} trial values, because it reached its limit.`,
    ];
  return d.limit === 'evaluations'
    ? [
        t`The engine stopped after ${String(d.count)} calculations, because it reached its limit.`,
        t`The last search was for ${unknownName(m)}.`,
        t`Raise the calculation limit in the solver settings.`,
      ]
    : [
        t`The search for ${unknownName(m)} stopped after ${String(d.count)} trial values, because it reached its limit.`,
        t`Narrow the search range of ${unknownName(m)}.`,
        ...setLines({ ...m, set: d.set }),
      ];
}

function statementFalseText(d: StatementFalseData): Line[] {
  const at = d.balance
    ? t`At the design point, ${ex(d.statement)} is ${quantityText(d.balance.reads, 'A')} and not zero.`
    : t`At the design point, ${ex(d.statement)} gives no number.`;
  return [
    t`The sheet sets ${inBlock(d.param, d.path)} by the statement that ${ex(d.statement)} is zero.`,
    at,
  ];
}

function notReadText(d: NotReadData): Line[] {
  const where = d.where.replace(/"/g, '');
  const reason =
    d.why === 'format'
      ? d.declared !== undefined
        ? t`The sheet declares format version ${JSON.stringify(d.declared)}.`
        : t`The file is not in a sheet format that this app reads.`
      : d.why === 'reference'
        ? where && d.field?.value !== undefined
          ? t`Block ${nm(where)} refers to the sheet ${val(d.field.value)}, and the library holds no sheet of that name.`
          : where
            ? t`Block ${nm(where)} refers to a sheet, and the library holds no sheet of that name.`
            : t`The sheet refers to a sheet, and the library holds no sheet of that name.`
        : where
          ? t`The entry ${nm(where)} holds a value that is not valid.`
          : t`An entry of the sheet holds a value that is not valid.`;
  // A field of one entry that is not well formed: the entry, as its rule knows it.
  // A block that refers to a sheet the library does not hold: the block and the reference.
  if (d.why === 'reference' && where) return [reason];
  if (d.why === 'field' && d.entry && where)
    return (d.field && fieldLines(d.entry, where, d.field)) || [entryLine(d.entry, where)];
  const reads =
    d.why === 'format'
      ? [t`This app reads format version ${String(FORMAT_VERSION)} and sheets with no version.`]
      : [];
  return [t`The engine cannot read the sheet.`, reason, ...reads];
}

/** What is wrong with one entry of the sheet, as far as its rule's finding says. The finding does
 *  not hold the value it refused, so the line says what kind of entry is not well formed; the one
 *  rule that refuses only a value (a tolerance that is not a number of zero or more) says that. */
/** A value the sheet wrote, as a sentence quotes it. */
const writtenValue = (v: unknown): string =>
  typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));

/** A value as the sheet writes it, as a segment set apart from the words of the sentence. */
const val = (v: unknown): Segment => ({ kind: 'value', text: writtenValue(v) });

/** The words for a field a param holds. */
const PARAM_FIELD: Readonly<Record<string, string>> = {
  value: 'value',
  min: 'minimum',
  max: 'maximum',
};

/** The lines of one field of an entry that is not well formed: a class on a param the engine solves
 *  names the conflict, with the relation that solves it, and its fix; any other field gives its
 *  one line. */
function fieldLines(
  entry: NonNullable<NotReadData['entry']>,
  where: string,
  f: NonNullable<NotReadData['field']>,
): Line[] | undefined {
  if (
    entry === 'param' &&
    f.name === 'class' &&
    f.problem === 'solved' &&
    f.relation !== undefined &&
    typeof f.value === 'string'
  )
    return f.relation === 'designConstraint'
      ? [
          t`${nm(where)} is marked ${f.value} and also has a constraint.`,
          t`Remove the mark or the constraint.`,
        ]
      : [
          t`${nm(where)} is marked ${f.value} and is also solved by a solve-for entry.`,
          t`Remove the mark or the solve-for entry.`,
        ];
  const line = fieldLine(entry, where, f);
  return line && [line];
}

/** What is wrong with one field of an entry, where the finding says which field and what it holds;
 *  undefined where no sentence says this field's problem, so the entry's general line stands. */
function fieldLine(
  entry: NonNullable<NotReadData['entry']>,
  where: string,
  f: NonNullable<NotReadData['field']>,
): Line | undefined {
  const n = nm(where);
  const has = f.value !== undefined;
  const v = val(f.value);
  const key = nm(f.key ?? '');
  switch (f.problem) {
    case 'not-a-number':
      if (entry === 'tolerance') {
        if (!has) return undefined;
        // A number below zero: what it is, and what a tolerance must be. Anything else: not a number.
        return typeof f.value === 'number' && Number.isFinite(f.value)
          ? t`The tolerance of check ${n} is ${quantityText(f.value)} %, and a tolerance must be zero or more.`
          : t`The engine cannot read the tolerance of check ${n}, because its value ${v} is not a number.`;
      }
      if (entry === 'param')
        return has
          ? t`The engine cannot read ${n}, because its ${PARAM_FIELD[f.name] ?? f.name} ${v} is not a number.`
          : t`The engine cannot read ${n}, because it has no ${PARAM_FIELD[f.name] ?? f.name}.`;
      return undefined;
    case 'sign':
      return t`${n} is ${v}, and a sign convention must be +1 or −1.`;
    case 'convention':
      return t`The sign convention of ${n} is ${v}, and the only one known is axis-sign.`;
    case 'unknown-name':
      if (entry === 'range-end')
        return t`Range end ${n} sets ${key}, which is not an input of this sheet.`;
      if (entry === 'block')
        return t`Block ${n} sets ${key}, but its sheet has no input of that name.`;
      return undefined;
    case 'solved':
      return entry === 'range-end'
        ? t`Range end ${n} sets ${key}, which the engine solves.`
        : undefined;
    case 'syntax':
      return entry === 'range-end' && has
        ? t`Range end ${n} sets ${key} to ${ex(writtenValue(f.value))}, which has a syntax error.`
        : undefined;
    case 'operator':
      return entry === 'check' && has
        ? t`The engine cannot read check ${n}, because ${v} is not an operator that it knows.`
        : undefined;
    case 'no-sheet':
      return undefined;
  }
}

function entryLine(entry: NonNullable<NotReadData['entry']>, where: string): Line {
  const n = nm(where);
  switch (entry) {
    case 'param':
      return t`The entry of ${n} is not well formed.`;
    case 'selector':
      return t`The axis-sign selector ${n} is not well formed.`;
    case 'check':
      return t`The entry of check ${n} is not well formed.`;
    case 'tolerance':
      return t`The tolerance of check ${n} is not a number of zero or more.`;
    case 'device':
      return t`The device of this sheet is not well formed.`;
    case 'block':
      return where.trim() && where !== 'blocks'
        ? t`The entry of block ${n} is not well formed.`
        : t`A block of the sheet has no name.`;
    case 'expression':
      return t`The expression of ${n} is not well formed.`;
    case 'range-end':
      return where === 'operatingRange'
        ? t`A range end of the operating range is not well formed.`
        : t`Range end ${n} is not well formed.`;
  }
}

function notDeterminedText(d: NotDeterminedData, ref?: ItemRef): Line[] {
  const head = t`The statements of the sheet do not determine one design.`;
  const each = (f: (n: Segment) => Line): Line[] => d.names.map((n) => f(nm(n)));
  switch (d.why) {
    case 'decision-missing':
      return [head, ...each((n) => t`No statement sets ${n}.`)];
    case 'decision-twice':
      return [
        head,
        ...d.names.map((n) => {
          const fields = d.statements?.find((x) => x.name === n)?.fields;
          return fields?.length
            ? t`${nm(n)} has ${andLines(fields.map((f) => [{ kind: 'text', text: FIELD_WORD[f] }]))}, and only one may set it.`
            : t`More than one statement sets ${nm(n)}.`;
        }),
      ];
    case 'assumed-level':
      return [
        head,
        ...each(
          (n) => t`${n} is an assumed level, and the engine runs no condition on an assumed level.`,
        ),
      ];
    case 'range-outside':
      return [
        head,
        ...(d.ranges?.length
          ? d.ranges.flatMap((r) => [
              t`The search range of ${nm(r.name)} is ${spanText(r.search[0], r.search[1], r.unit)}.`,
              t`Its wires permit ${spanText(r.wires[0], r.wires[1], r.unit)}.`,
            ])
          : each((n) => t`The search range of ${n} lies outside the range that its wires permit.`)),
      ];
    case 'loop':
      return [
        head,
        ...d.names.flatMap((n) => [
          t`${partName(n)} depends on its own operating point.`,
          t`No statement solves this loop.`,
        ]),
      ];
    case 'operating-range':
      if (d.unheld?.length && d.names.length)
        return [
          head,
          t`Range end ${nm(d.names[0])} holds ${andLines(d.unheld.map((n) => [nm(n)]))} at the value of the design run.`,
          t`The design run recorded no value for ${d.unheld.length > 1 ? 'them' : 'it'}.`,
        ];
      return [
        head,
        d.names.length
          ? t`Range end ${nm(d.names[0])} holds a value that is not valid.`
          : t`The operating range holds an entry that is not valid.`,
      ];
    case 'netlist':
      // Each finding of the netlist check gives its own lines, in the order raised.
      if (d.netlist?.length)
        return [head, ...distinctLines(d.netlist.flatMap((n) => netlistLines(n, ref?.path ?? [])))];
      return [
        head,
        d.names.length
          ? t`The netlist check reports a problem at ${andLines(d.names.map((n) => [nm(n.replace(/"/g, ''))]))}.`
          : t`The netlist check reports a problem in the wiring of the sheet.`,
      ];
  }
}

/** Each line once, in the order given: findings whose data say the same give one sentence. */
const distinctLines = (ls: readonly Line[]): Line[] =>
  ls.filter((l, k) => ls.findIndex((m) => lineText(m) === lineText(l)) === k);

/** A problem of the netlist check, with the wires and the devices it is about. Its devices are
 *  named as the sheet at `at` (the item's path) names them: its own device as `givens`, a part by
 *  its name there; a reader is given them by their path from the top. */
function netlistLines(n: NetlistAbout, at: readonly string[] = []): Line[] {
  const wires = (n.wires ?? []).map((w) => [nm(w)]);
  const parts = (n.devices ?? []).map((d) =>
    partName(d === '' || d === 'givens' ? at.join('.') : [...at, d].join('.')),
  );
  const wire = wires[0] ?? [];
  const part = parts[0] ?? t`a device`;
  switch (n.problem) {
    case 'short':
      return [t`${part} has its drain and its source on wire ${wire}, which shorts it.`];
    case 'wire-name':
      return [
        t`The wire name ${wire} is not valid.`,
        t`A wire name is an identifier of letters, digits and underscores.`,
      ];
    case 'one-terminal':
      return [
        t`Only one terminal names wire ${wire}.`,
        t`A wire joins two terminals or more, or the sheet gives it a level, or it is a port.`,
      ];
    case 'level-unnamed':
      return [
        t`The sheet gives wire ${wire} a level, but no terminal, element or port names ${wire}.`,
      ];
    case 'unwired':
      return [t`The sheet names no wires for ${andLines(parts)}.`];
    case 'diode-flag':
      return n.diodeFlag === false
        ? [t`The wires of ${part} put its gate on its drain, but its diode flag is off.`]
        : n.diodeFlag === true
          ? [t`The diode flag of ${part} is on, but its wires do not put its gate on its drain.`]
          : [t`The wires of ${part} and its diode flag disagree.`];
    case 'placement':
      return n.placement
        ? placementLines(n.placement, part)
        : [t`The wiring of ${part} is not well formed.`];
    case 'level-refused':
      return n.refused?.length
        ? [t`The level ${ex(n.level ?? '')} cannot hold wire ${wire}.`, ...refusedLines(n.refused)]
        : [
            t`The sheet gives wire ${wire} the level ${ex(n.level ?? '')}, but a level can read only numbers, specs and knobs.`,
          ];
    case 'level-gate':
      return [
        t`Wire ${wire} cannot be held at ${ex(n.level ?? '')}, because that level holds only the gate of ${part}.`,
      ];
    case 'other':
      return n.where
        ? [t`The netlist check reports a problem at ${nm(n.where.replace(/"/g, ''))}.`]
        : [t`The netlist check reports a problem in the wiring of the sheet.`];
    case 'selector':
      return [t`The axis-sign selector ${nm(n.param ?? '')} does not match the table of ${part}.`];
  }
}

/** Why a level cannot hold a wire, from its data: one line for each reason, then what to do. A
 *  param a hold re-solves at a device's gate is followed by its own action, holding the gate wire
 *  the hold keeps; where every reason is one of those, it is the whole of what to do. */
function refusedLines(rs: readonly LevelRefusal[]): Line[] {
  const lines = rs.flatMap(refusalLines);
  const onlyHeld = rs.every((r) => r.reason === 'class' && r.cls === 'held' && r.device);
  return onlyHeld
    ? lines
    : [...lines, t`Write the level as a number, or from values marked independent.`];
}

/** One reason a level cannot hold a wire, as the clause after "because". */
function refusalClause(r: LevelRefusal): Line {
  switch (r.reason) {
    case 'class':
      switch (r.cls) {
        case 'assumed':
          return t`${nm(r.name)} is marked assumed`;
        case 'solved':
          return t`the engine solves ${nm(r.name)}`;
        case 'held':
          return t`the engine calculates ${nm(r.name)} again`;
        case 'unclassified':
          return t`${nm(r.name)} has no mark`;
      }
      break;
    case 'unresolved':
      return t`${nm(r.name)} names nothing on the sheet`;
    case 'cycle':
      return t`${andLines(r.via.map((v) => [nm(v)]))} read each other`;
    case 'device':
      return t`it reads a quantity of ${partName(r.device)}`;
    case 'equation':
      return t`it reads equation ${nm(r.name)}`;
    case 'analysis':
      return t`it reads analysis ${nm(r.name)}`;
  }
}

/** The lines of one reason a level cannot hold a wire. */
function refusalLines(r: LevelRefusal): Line[] {
  switch (r.reason) {
    case 'class':
      switch (r.cls) {
        case 'assumed':
          return [
            t`${nm(r.name)} is marked assumed, and a level that holds a wire cannot read an assumed value.`,
          ];
        case 'solved':
          return [
            t`The level reads ${nm(r.name)}, which the engine solves, so the level is derived.`,
          ];
        case 'held':
          return [
            t`The level reads ${nm(r.name)}, which the engine calculates again where the design is held, so the level is derived.`,
            // A hold that balances currents keeps no gate: no wire to hold instead.
            ...(r.device !== undefined
              ? [t`Hold the gate wire of ${partName(r.device)} at the expression of its hold.`]
              : []),
          ];
        case 'unclassified':
          return [
            t`${nm(r.name)} has no mark, and a level that holds a wire reads only values marked independent.`,
          ];
      }
      break;
    case 'unresolved':
      return [t`${nm(r.name)} names nothing on the sheet.`];
    case 'cycle': {
      const names = andLines(r.via.map((v) => [nm(v)]));
      return [
        r.via.length > 2
          ? t`${names} read each other in a loop, so the level never gives a number.`
          : t`${names} read each other, so the level never gives a number.`,
      ];
    }
    case 'device':
      return [
        t`The level reads a quantity of ${partName(r.device)}, and a level derived from a device is never held.`,
      ];
    case 'equation':
      return [t`The level reads equation ${nm(r.name)}, and a level cannot read an equation.`];
    case 'analysis':
      return [t`The level reads analysis ${nm(r.name)}, and a level cannot read an analysis.`];
  }
}

/** Each terminal, as a sentence names it. */
const TERMINAL_WORD = { d: 'drain', g: 'gate', s: 'source', b: 'body' } as const;

/** A placement that is not well formed, by its fault. */
function placementLines(f: PlacementFault, part: Line): Line[] {
  const which = (index: number | undefined): Line =>
    index === undefined ? t`The wiring of ${part}` : t`Placement ${String(index + 1)} of ${part}`;
  switch (f.fault) {
    case 'shape':
      return [
        t`The wiring of ${part} is not well formed.`,
        f.none
          ? t`A part's wiring is one placement of drain, gate, source and body wires, a list of placements, or none.`
          : t`A part's wiring is one placement of drain, gate, source and body wires, or a list of placements.`,
      ];
    case 'unknown-key':
      return [
        t`${which(f.index)} names ${nm(f.key)}, which a placement does not have.`,
        t`A placement names only the drain, gate, source and body wires.`,
      ];
    case 'no-wire':
      return [
        t`${which(f.index)} names no wire for the ${TERMINAL_WORD[f.terminal]}.`,
        t`Each terminal needs a wire.`,
      ];
    case 'intent':
      return [
        t`${which(f.index)} sets its intent to ${val(f.value)}.`,
        t`The only intent that a placement can set is off, for a device meant to be off.`,
      ];
    case 'mixed-diode':
      return [
        t`Some placements of ${part} put the gate on the drain wire and some do not.`,
        t`Put the diode-connected placements and the others in separate blocks.`,
      ];
  }
}

const SIDE_WORD = { lhs: 'left', rhs: 'right' } as const;

/** Each quantity a sizing derives, as a sentence names it. */
const SIZING_WORD = {
  gm: 'transconductance',
  gm_id: 'gm/ID',
  id: 'drain current',
  W: 'width',
} as const;

/** The parser's reasons that a plain sentence says, by the start of its words. A reason with no
 *  entry gives no line. */
const SYNTAX_REASONS: readonly (readonly [RegExp, Line])[] = [
  [/^Unclosed \(/, t`A parenthesis is not closed.`],
  [/^Unclosed \[/, t`A square bracket is not closed.`],
  [/^Unclosed quote/, t`A quotation mark is not closed.`],
  [/^Expected \)/, t`A parenthesis is not closed.`],
  [/^Unexpected "\)"/, t`A closing parenthesis has no parenthesis that it closes.`],
  [/^Expected expression after/, t`An operator has nothing after it.`],
  [/^Variable names cannot start with a number/, t`A name starts with a digit.`],
];
/** Whether a syntax error's position is past the expression's last character: the parser ran out
 *  of text, so no character of it is at fault. */
const atEnd = (x: { at?: number; expression: string }): boolean =>
  x.at !== undefined && x.at >= x.expression.trimEnd().length;

const syntaxReason = (problem: string): Line | undefined =>
  SYNTAX_REASONS.find(([re]) => re.test(problem))?.[1];

/** Each field that states a relation, as a sentence names it. */
const FIELD_WORD = {
  designConstraint: 'a constraint',
  solveFor: 'a solve-for entry',
  hold: 'a hold',
} as const;

/** What gave no number where the engine read it: a part read beyond its table, with the record,
 *  or another item. */
function byLines(d: CannotEvaluateData): Line[] {
  if (d.outside) return outsideTableText(d.outside).slice(0, 2);
  return d.by ? [t`${itemName(d.by)} gives no number.`] : [];
}

function cannotEvaluateText(d: CannotEvaluateData, ref?: ItemRef): Line[] {
  const subject: Line = ref ? itemName(ref) : [nm(d.name)];
  if (ref?.kind === 'device') {
    const sized = t`${subject} cannot be sized.`;
    if (d.why === 'no-column') return [sized, t`The table holds no column for ${nm(d.name)}.`];
    if (d.why === 'no-sweep')
      return [
        sized,
        t`The table holds no sweep of ${andLines(d.name.split(', ').map((a) => [nm(a)]))}.`,
      ];
    if (d.why === 'illegal-pair')
      return [sized, t`The two quantities bound on it do not determine its size.`];
    if (d.sizing) {
      const word = SIZING_WORD[d.sizing.quantity];
      return [
        Number.isFinite(d.sizing.value)
          ? t`${subject} cannot be sized, because the ${word} its table gives there is not positive.`
          : t`${subject} cannot be sized, because its table gives no ${word} there.`,
      ];
    }
    return [sized];
  }
  // A search whose relation gives no number where it searched, and what gave none there.
  if (d.unevaluable) {
    const m = d.unevaluable.member;
    const at = d.unevaluable.at;
    const lines = unevaluableLines(
      m,
      at.where === 'nowhere' && d.outside ? { ...at, by: undefined } : at,
    );
    return [
      ...lines,
      ...(d.outside ? outsideTableText(d.outside).slice(0, 2) : []),
      ...setLines({ ...m, set: d.unevaluable.set }),
      ...givenLines(m),
    ];
  }
  // A hold that gives no number where the design is sized, and what gave none there.
  if (d.hold)
    return [
      t`The sheet sets ${inBlock(d.hold.param, d.hold.path)} by the statement that ${ex(d.hold.statement)} is zero.`,
      t`At the design point, ${ex(d.hold.statement)} gives no number.`,
      ...byLines(d),
    ];
  // A block that is not evaluated, because a value its parent sets for it gives no number.
  if (d.inputs?.length) {
    // The block, by its path where the item has one, else by the name the data hold.
    const block: Line =
      ref?.kind === 'sheet' && ref.path.length
        ? t`Block ${blockSegment(ref.path)}`
        : d.why === 'not-finite'
          ? t`Block ${nm(d.name)}`
          : t`This block`;
    return [
      t`${block} is not calculated, because ${parentGivesNo(d.inputs)}.`,
      ...(d.why === 'not-defined' ? [t`The parent sheet does not define ${nm(d.name)}.`] : []),
    ];
  }
  // A range end whose `set` gives no number against the design run.
  if (d.rangeEnd && d.why === 'syntax') {
    const why = d.syntax ? syntaxReason(d.syntax.problem) : undefined;
    return [
      t`Range end ${nm(d.rangeEnd.name)} sets ${nm(d.rangeEnd.param)} to ${ex(d.rangeEnd.expression)}, which has a syntax error.`,
      ...(d.syntax?.at !== undefined
        ? [
            atEnd(d.syntax)
              ? t`The error is at the end of the expression.`
              : t`The error is at character ${String(d.syntax.at + 1)}.`,
          ]
        : []),
      ...(why ? [why] : []),
    ];
  }
  if (d.rangeEnd && d.why === 'not-defined')
    return [
      t`Range end ${nm(d.rangeEnd.name)} sets ${nm(d.rangeEnd.param)} to ${ex(d.rangeEnd.expression)}.`,
      t`The sheet does not define ${nm(d.name)}.`,
    ];
  if (d.rangeEnd)
    return [
      t`Range end ${nm(d.rangeEnd.name)} sets ${nm(d.rangeEnd.param)} to ${ex(d.rangeEnd.expression)}.`,
      t`At the design point, ${ex(d.rangeEnd.expression)} gives no number.`,
    ];
  // A region check: the engine wrote its two sides from the region the device declares.
  if (d.region) {
    const device = ref?.path.length ? partName(ref.path.join('.')) : partName(d.region.device);
    return d.region.missing === 'device'
      ? [t`The engine cannot test the region of ${device}, because ${device} is not sized.`]
      : [
          t`The engine cannot test the region of ${device}.`,
          t`${deviceQuantity(d.region.missing)} of ${device} gives no number.`,
        ];
  }
  // A check that reads a name no entry declares: one sentence for each side that does.
  if (d.sides && (d.sides.lhs || d.sides.rhs))
    return (['lhs', 'rhs'] as const).flatMap((s) => {
      const n = d.sides?.[s];
      return n
        ? [
            t`The ${SIDE_WORD[s]} side of ${subject} reads ${nm(n)}, and the sheet does not define ${nm(n)}.`,
          ]
        : [];
    });
  // A check names the side that gave no number.
  const head =
    d.side === 'both'
      ? t`neither side of ${subject} gives a number.`
      : d.side
        ? t`The ${SIDE_WORD[d.side]} side of ${subject} gives no number.`
        : t`${subject} gives no number.`;
  switch (d.why) {
    case 'not-defined':
      return ref && ref.name !== d.name
        ? [t`${subject} reads ${nm(d.name)}, and the sheet does not define ${nm(d.name)}.`]
        : [head, t`The sheet does not define ${nm(d.name)}.`];
    case 'syntax': {
      const why = d.syntax ? syntaxReason(d.syntax.problem) : undefined;
      return [
        head,
        d.syntax?.at !== undefined && !atEnd(d.syntax)
          ? t`${subject} has a syntax error at character ${String(d.syntax.at + 1)} of ${ex(d.syntax.expression)}.`
          : d.syntax
            ? t`${subject} has a syntax error in ${ex(d.syntax.expression)}.`
            : t`${subject} has a syntax error.`,
        ...(d.syntax && atEnd(d.syntax) ? [t`The error is at the end of the expression.`] : []),
        ...(why ? [why] : []),
      ];
    }
    case 'no-column':
      return [head, t`The table holds no column for ${nm(d.name)}.`];
    case 'no-sweep':
      return [head, t`The table holds no sweep of ${nm(d.name)}.`];
    case 'illegal-pair':
      return [head, t`The two quantities bound on the device do not determine its size.`];
    case 'not-finite':
      if (!d.notFinite) return [head];
      return [
        head,
        d.notFinite.length
          ? t`${subject} reads ${andLines(d.notFinite.map((n) => [nm(n)]))}, which ${d.notFinite.length > 1 ? 'give' : 'gives'} no number.`
          : t`Every name that ${subject} reads gives a number, but the expression of ${subject} gives none.`,
      ];
  }
}

/** A part read beyond its table. The record names the device as its own sheet does (`givens`);
 *  a device item of a block, read in its parent's list, names that block, and so does a param
 *  of the block that sets the reading. */
function outsideTableText(d: OutsideTableData, ref?: ItemRef): Line[] {
  const w = quantityWords(d.quantity);
  const [lo, hi] = d.held;
  const path = ref?.kind === 'device' ? ref.path : [];
  const own = d.device === '' || d.device === 'givens';
  const part = path.length && own ? partName(path.join('.')) : partName(d.device);
  return [
    t`${part} asks for a ${w.one} of ${quantityText(d.asked, w.unit)}.`,
    t`The table holds ${w.many} ${spanText(lo, hi, w.unit)}.`,
    ...(d.setBy
      ? [t`Change ${inBlock(d.setBy, path)}, or load a table that holds this ${w.one}.`]
      : []),
  ];
}

/** What a check requires, by its operator; an operator no entry lists is quoted as written. */
const requires = (op: string): Line =>
  op in REQUIRES ? t`${REQUIRES[op as CheckOp]}` : t`a value related by ${ex(op)} to`;

const REQUIRES: Record<CheckOp, string> = {
  '>=': 'at least',
  '<=': 'at most',
  '==': 'a value equal to',
};

/** A failed check's margin: a signed percentage of its limit, or, for a limit of zero, of which
 *  no percentage can be taken, the margin itself in the check's unit. */
/** The margin as a percentage of the limit; none against a limit of zero, where it would only
 *  repeat the value the line before gives. */
function marginLine(d: FailsData): Line[] {
  const sign = d.margin >= 0 ? '+' : '−';
  return Math.abs(d.rhs) > 0
    ? [t`The margin is ${sign}${quantityText(Math.abs(d.marginPct) * 100)} %.`]
    : [];
}

function failsText(d: FailsData, ref?: ItemRef): Line[] {
  // The check a declared region adds: its sides are the engine's, from the region, so the text
  // names the part it tests. Its unit is given only where the data hold it.
  if (ref?.kind === 'requirement' && ref.name === REGION_CHECK_ID) {
    const part = ref.path.length ? partName(ref.path.join('.')) : t`the device of this sheet`;
    if (d.region)
      return [
        t`The region check of ${part} fails.`,
        t`The drain-source voltage of ${part} is ${quantityText(d.lhs, d.unit)}, and ${d.region === 'triode' ? 'the triode region' : 'saturation'} needs ${requires(d.text.op)} ${quantityText(d.rhs, d.unit)}.`,
        ...marginLine(d),
      ];
    return [
      t`The region check of ${part} fails.`,
      t`The region check of ${part} reads ${quantityText(d.lhs, d.unit)}, and it needs ${requires(d.text.op)} ${quantityText(d.rhs, d.unit)}.`,
      ...marginLine(d),
    ];
  }
  const check: Line = ref ? itemName(ref) : t`the check`;
  const left = isName(d.text.lhs) ? nameText(d.text.lhs) : t`the left side of ${check}`;
  return [
    t`${check} fails.`,
    t`${left} is ${quantityText(d.lhs, d.unit)}, and ${check} requires ${requires(d.text.op)} ${quantityText(d.rhs, d.unit)}.`,
    ...marginLine(d),
  ];
}

/** Every text a reader sees for one finding, from its kind and data alone, and the item it is
 *  about where the caller has it. */
export function textOf(f: Finding, ref?: ItemRef): FindingText {
  return finding(CAUSE_NAMES[f.kind], linesOf(f, ref).map(upperFirst));
}

function linesOf(c: Cause, ref?: ItemRef): Line[] {
  switch (c.kind) {
    case 'not-read':
      return notReadText(c.data);
    case 'not-determined':
      return notDeterminedText(c.data, ref);
    case 'outside-table':
      return outsideTableText(c.data, ref);
    case 'cannot-evaluate':
      return cannotEvaluateText(c.data, ref);
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
    case 'fails':
      return failsText(c.data, ref);
  }
}

/** The clause of a block that waits on its parent: the inputs it is given no value for, where
 *  they are known. */
const parentGivesNo = (inputs: readonly string[] | undefined): Line =>
  inputs?.length
    ? t`its parent sheet gives it no value for ${andLines(inputs.map((n) => [nm(n)]))}`
    : t`its parent sheet gives it no value`;

/** The clause a withheld item's sentence gives for the failed item it depends on: one for each
 *  cause, so the not-proved cause never reads as a proof. */
export function withheldClause(r: WithheldOn): Line {
  if (r.frame === 'parent') return parentGivesNo(r.inputs);
  if (r.frame === 'design')
    return withheldClause({ kind: r.kind, path: r.path, name: r.name, cause: r.cause });
  const n = itemName(r);
  switch (r.cause) {
    case 'not-read':
      return r.kind !== 'sheet'
        ? t`the engine cannot read ${n}`
        : r.path.length
          ? t`the engine cannot read block ${nm(r.path.join('.'))}`
          : t`the engine cannot read the sheet`;
    case 'not-determined':
      return r.kind === 'sheet'
        ? t`the statements of ${n} do not determine one design`
        : t`the statements do not determine ${n}`;
    case 'cannot-evaluate':
      return r.kind === 'search' ? t`the engine could not calculate ${n}` : t`${n} gives no number`;
    case 'outside-table':
      return t`${n} is outside its table`;
    case 'no-solution':
      return t`${n} has no solution`;
    case 'no-crossing':
      return t`the engine found no solution for ${n}`;
    case 'none-in-range':
      return t`${n} has no solution in its search range`;
    case 'did-not-settle':
      return t`${n} did not converge`;
    case 'limit':
      return t`the engine reached its calculation limit`;
    case 'statement-false':
      return t`the statement on ${n} is false`;
    case 'fails':
      return t`${n} fails`;
  }
}

/** The item of the design point's list a pointer of a range end names. */
const pointedAt = (r: WithheldOn, design: readonly Item[]): Item | undefined =>
  design.find(
    (i) =>
      i.kind === r.kind &&
      i.name === r.name &&
      i.path.length === r.path.length &&
      i.path.every((p, k) => p === r.path[k]),
  );

/** Why a range end is not calculated, from the design point's items its pointers name: the design
 *  point has no design where one of them is not complete (incompleteOn) for a reason other than
 *  the statements; else its statements do not determine one design; else it rests on an assumed
 *  level. Undefined where none of these is what the items say. */
/** Why the engine did not calculate a range end, from the end's own item: the clause its pointers
 *  into the design point's list give ("the design point has no design"). */
export function designReason(on: readonly WithheldOn[], design: readonly Item[]): Line | undefined {
  const items = on.flatMap((r) => {
    const i = r.frame === 'design' ? pointedAt(r, design) : undefined;
    return i ? [i] : [];
  });
  const determined = (i: Item): boolean =>
    i.status === 'failed' && i.cause.kind === 'not-determined';
  const assumed = (i: Item): boolean =>
    determined(i) &&
    i.status === 'failed' &&
    i.cause.kind === 'not-determined' &&
    i.cause.data.why === 'assumed-level';
  if (items.some((i) => incompleteOn([i]).length > 0 && !determined(i)))
    return t`the design point has no design`;
  if (items.some((i) => determined(i) && !assumed(i)))
    return t`the statements of the sheet do not determine one design`;
  if (items.some(assumed)) return t`the design point rests on an assumed level`;
  return undefined;
}

/** A line as the clause after "At the design point,": its first word in lower case where it opens
 *  with plain text; a name keeps its case. */
const lowerFirst = (l: Line): Line => {
  const [first, ...rest] = l;
  if (first?.kind !== 'text' || !first.text) return l;
  return [
    { kind: 'text', text: first.text.charAt(0).toLowerCase() + first.text.slice(1) },
    ...rest,
  ];
};

/** The one line a range end that is not calculated gives for a failed item of the design point it
 *  waits on: that item's first specific sentence, after "At the design point, ". A design on an
 *  assumed level says the value is one; a finding that the statements do not determine one design
 *  gives the sentence after its heading; any other cause, the clause that names what failed. The
 *  details stay on the design point. */
function designLine(i: Item): Line {
  const ref = { kind: i.kind, path: i.path, name: i.name };
  if (i.status === 'failed' && i.cause.kind === 'not-determined') {
    if (i.cause.data.why === 'assumed-level')
      return t`At the design point, ${itemName(ref)} is an assumed level.`;
    // A level that cannot hold a wire: the level and wire, with its reason, or how many it has.
    const [first] = i.cause.data.netlist ?? [];
    if (first?.problem === 'level-refused' && first.refused?.length) {
      const head = t`the level ${ex(first.level ?? '')} cannot hold wire ${nm(first.wires?.[0] ?? '')}`;
      return first.refused.length > 1
        ? t`At the design point, ${head}, for ${String(first.refused.length)} reasons.`
        : t`At the design point, ${head}, because ${refusalClause(first.refused[0])}.`;
    }
    const specific = describe(i).segments[1];
    if (specific) return t`At the design point, ${lowerFirst(specific)}`;
  }
  const kind = i.status === 'failed' ? i.cause.kind : 'cannot-evaluate';
  return t`At the design point, ${withheldClause({ ...ref, cause: kind })}.`;
}

/** The lines of a range end the engine does not calculate. With the design point's list: the reason,
 *  then one line for each failed item its pointers name. Without it: one line, with no reason, as
 *  what the pointer names cannot be told from the pointer alone. */
function notCalculatedText(
  on: readonly WithheldOn[],
  end: string | undefined,
  design: readonly Item[] | undefined,
): Line[] {
  const who = end === undefined ? t`This range end` : t`Range end ${nm(end)}`;
  const reason = design ? designReason(on, design) : undefined;
  const head = reason
    ? t`${who} is not calculated, because ${reason}.`
    : t`${who} is not calculated.`;
  if (!design) return [head];
  const clauses = on.flatMap((r): Line[] => {
    const own = pointedAt(r, design);
    return own?.status === 'failed' ? [designLine(own)] : [];
  });
  return distinctLines([head, ...clauses]);
}

/** What describe is told of a range end that is not calculated: the end's name, and the design
 *  point's list its pointers name items of. */
export interface DescribeOptions {
  readonly end?: string;
  readonly design?: readonly Item[];
}

/** What a reader is shown for one item: nothing for an item that is ok; for a failed one, its
 *  cause's text; for a withheld one, one sentence for each failed item it depends on. `within`
 *  is the path of the block whose own list the item is read in, where it is one. */
export function describe(
  item: Item,
  within: readonly string[] = [],
  { end, design }: DescribeOptions = {},
): FindingText {
  if (item.status === 'ok')
    return item.attributes?.kind === 'held' ? heldText(item, item.attributes) : finding('', []);
  // A range end the engine does not calculate: the design point gives no design, and its items say
  // why.
  if (
    item.status === 'withheld' &&
    item.kind === 'sheet' &&
    !item.path.length &&
    item.on.some((r) => r.frame === 'design')
  )
    return finding(WITHHELD_NAME, notCalculatedText(item.on, end, design));
  // An item read in a block's own list is named by its path from the top, as the parent's list
  // names it: the block's own sheet item as the block, its device as the part.
  const rooted = <R extends ItemRef>(r: R): R =>
    within.length ? { ...r, path: [...within, ...r.path] } : r;
  if (item.status === 'withheld' && !item.on.length)
    return finding(WITHHELD_NAME, [upperFirst(t`${itemName(rooted(item))} is not calculated.`)]);
  if (item.status === 'withheld')
    return finding(
      WITHHELD_NAME,
      item.on
        .map((r) =>
          // A block's own sheet item, read in the block's own list, waits on its parent.
          r.frame === 'parent' && item.kind === 'sheet' && item.path.length === 0
            ? within.length
              ? t`Block ${blockSegment(within)} is not calculated, because ${parentGivesNo(r.inputs)}.`
              : t`This block is not calculated, because ${parentGivesNo(r.inputs)}.`
            : upperFirst(
                t`${itemName(rooted(item))} is not calculated, because ${withheldClause(r.frame === 'parent' ? r : rooted(r))}.`,
              ),
        )
        .filter((l, k, all) => all.findIndex((m) => lineText(m) === lineText(l)) === k),
    );
  return textOf(item.cause, rooted(item));
}

/** What an item the run held at a given value instead of solving reads. */
export const HELD_NAME = 'held';

function heldText(r: ItemRef, a: Extract<Attributes, { kind: 'held' }>): FindingText {
  const n = inBlock(r.name, r.path, { kind: r.kind, path: r.path, name: r.name });
  const relation = a.relation.field === 'solveFor' ? 'the equation' : 'the constraint';
  return finding(HELD_NAME, [
    t`${n} is held at ${quantityText(a.value, a.unit)}.`,
    t`The engine did not check ${relation} of ${n} at this value.`,
  ]);
}

/** Why a verdict is what it is, where a line says more than its word: for each value the run held
 *  instead of solving, that the verdict is undetermined because of it. */
export function verdictText(v: Verdict<string>, within: readonly string[] = []): readonly Line[] {
  // A block's verdict names what it rests on by its path from the top, as describe does.
  const rooted = <R extends ItemRef>(r: R): R =>
    within.length ? { ...r, path: [...within, ...r.path] } : r;
  const held = (v.held ?? []).map(rooted);
  const lines: Line[] = [];
  if (held.length) {
    const names = andLines(held.map((r) => inBlock(r.name, r.path, r)));
    lines.push(
      t`The verdict is ${VERDICT_WORDS.undetermined}, because ${names} ${held.length > 1 ? 'are' : 'is'} held and not solved.`,
    );
  }
  // An undetermined verdict gives one clause for each failed item it rests on: a range end's own
  // item by the end's name.
  if (v.verdict === 'undetermined')
    for (const f of v.failed.map(rooted))
      lines.push(
        f.end !== undefined
          ? t`The verdict is ${VERDICT_WORDS.undetermined}, because the entry of range end ${nm(f.end)} is not well formed.`
          : t`The verdict is ${VERDICT_WORDS.undetermined}, because ${withheldClause({ kind: f.kind, path: f.path, name: f.name, cause: f.cause.kind })}.`,
      );
  return distinctLines(lines);
}

/** What a held point or range end that was not run is shown: its own word, and why. */
export const notAskedText = (what: 'range end' | 'held point', name: string): FindingText =>
  finding(NOT_ASKED_NAME, [
    what === 'range end'
      ? t`The engine did not run range end ${nm(name)}, because the design point has no design.`
      : t`The engine did not run the condition ${nm(name)}, because the design point has no design.`,
  ]);

/** Why a run is not complete (incompleteOn): the finding of each failed item whose number it does
 *  not have, in the list's order; a withheld item follows from one of them. The list of a range end
 *  that is not calculated gives that end's own text (`options` as describe takes them). A list
 *  with nothing incomplete gives nothing; one that is incomplete and gives no text reads that the
 *  evaluation did not complete, as a refusal with no reason is indistinguishable from a verdict.
 *  Each reader renders the findings. */
export function incompleteText(
  items: readonly Item[],
  options: DescribeOptions = {},
): FindingText[] {
  const [only] = items;
  if (
    items.length === 1 &&
    only.kind === 'sheet' &&
    only.status === 'withheld' &&
    only.on.some((r) => r.frame === 'design')
  )
    return [describe(only, [], options)];
  const missing = incompleteOn(items);
  if (!missing.length) return [];
  const why = missing.filter((i) => i.status === 'failed').map((i) => describe(i));
  return why.length ? why : [finding('', [t`The evaluation did not complete.`])];
}

/** incompleteText as one string, where one is needed (a thrown error, a refusal to a script): each
 *  finding's name, then each of its lines, one to a line; empty where nothing is incomplete. */
export const incompleteMessage = (items: readonly Item[], options: DescribeOptions = {}): string =>
  incompleteText(items, options)
    .flatMap((f) => (f.name ? [f.name, ...f.lines] : f.lines))
    .join('\n');
