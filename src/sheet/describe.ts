// Every text a reader sees about an item's cause, built from the cause's data in one place. The
// code that produces a result writes data, never these sentences, so the app and a script read the
// same words, and a change of wording is a change here alone.

import type { OutsideTable } from '../types';
import { BASE_QUANTITIES, DERIVED_QUANTITIES } from '../namespace';
import { amps } from './nodes';
import { shown } from './linear';
import { formatQuantity } from '../units';
import { andList, blockMessage, FORMAT_VERSION, type CheckOp, type SolveRange } from './types';
import type {
  CannotEvaluateData,
  Cause,
  CauseName,
  DidNotSettleData,
  FailsData,
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
  WithheldOn,
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
  readonly kind: 'text' | 'name' | 'expr';
  readonly text: string;
}

/** A detail line, as segments. */
export type Line = readonly Segment[];

/** A name from the sheet, as a segment. */
const nm = (text: string): Segment => ({ kind: 'name', text });
/** An expression from the sheet, as a segment. */
const ex = (text: string): Segment => ({ kind: 'expr', text: text.trim() });

type Part = string | Segment | Line;

const isSegment = (p: Part): p is Segment => typeof p === 'object' && !Array.isArray(p);

/** Builds a line: the template's own text is text, an interpolated string is text, and a segment
 *  or a line is spliced in as it is. Neighbouring text segments are joined. */
function t(strings: TemplateStringsArray, ...parts: Part[]): Line {
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
      const p = parts[k];
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
const andLines = (ls: readonly Line[]): Line =>
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
  has(
    /\b(lhs|rhs|givens|param|override|probe|bracket|clamp|crossing|finite|resolve)\b/,
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

/** What an item that is withheld reads, and what a held point or range end that was not run
 *  reads. The first is not yet ruled: it is kept here alone. */
export const WITHHELD_NAME = 'not calculated';
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
export const quantityText = (x: number, unit?: string): string => {
  const a = Math.abs(Number(x.toPrecision(3)));
  const plain = String(Number(x.toPrecision(3)));
  if (!unit || unit === '1') {
    if (a === 0 || (a >= 1e-3 && a < 1e4)) return plain;
    return formatQuantity(x, unit, 3);
  }
  // A ratio of like units (V/V, A/A) is a pure number with its unit after it: 8090 V/V.
  if ((a >= 0.1 && a < 1) || /^(\w+)\/\1$/.test(unit)) return `${plain} ${unit}`;
  return formatQuantity(x, unit, 3);
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
    return String(n === 0 ? 0 : n);
  };
  const prefix = exp3 === 0 ? '' : (SI_PREFIX[exp3] ?? '');
  return `from ${num(lo)} ${prefix}${unit} to ${num(hi)} ${prefix}${unit}`;
};

/** A name with the blocks it belongs to after it: "V_ref in block bias". */
const inBlock = (name: string, path: readonly string[]): Line =>
  path.length ? t`${nm(name)} in block ${nm(path.join('.'))}` : [nm(name)];

/** An unknown as a reader reads it. */
const unknownName = (d: Pick<SearchData, 'path' | 'unknown'>): Line => inBlock(d.unknown, d.path);

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
  device === '' || device === 'givens' ? t`the device of this sheet` : t`part ${nm(device)}`;

/** Any item as the subject of a sentence names it. */
const itemName = (r: ItemRef): Line => {
  if (r.kind === 'sheet') return r.path.length ? t`block ${nm(r.path.join('.'))}` : t`the sheet`;
  if (r.kind === 'device') {
    const own = r.name === '' || r.name === 'givens';
    return own && r.path.length ? partName(r.path.join('.')) : partName(r.name);
  }
  return inBlock(r.name, r.path);
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
 *  rises or falls where the right is constant; otherwise the gap between them only grows or only
 *  shrinks. The way is read from the left side minus the right. */
function monotonicText(d: SearchData & NoSolutionRead): Line {
  const { lhs, rhs } = sidesOf(d.relation);
  const U = unknownName(d);
  const [lo, hi] = d.ends;
  const rises = hi.lhs - hi.rhs >= lo.lhs - lo.rhs;
  if (d.relation.lhs.trim() === d.unknown) return t`${rhs} changes more slowly than ${U}`;
  if (lo.rhs === hi.rhs) return t`${lhs} ${rises ? 'only rises' : 'only falls'} with ${U}`;
  return t`the gap between the two sides only ${rises ? 'grows' : 'shrinks'} with ${U}`;
}

/** The unit the two sides of a relation are quoted in: the relation's own, or, until the relation
 *  carries one, the unknown's where the unknown is a level. */
const relationUnit = (d: SearchData): string | undefined =>
  d.relation.unit ?? (d.unit === 'V' ? 'V' : undefined);

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

/** The sentence a failed search gives for where the engine searched. */
function searchedLine(d: SearchData & NoSolutionRead): Line {
  // The range searched, not where a search that stopped short ended: that is said after it.
  const w = d.range.wiring?.range;
  const [a, b] = d.stage === 'physical' && w ? w : d.searched;
  const span = spanText(a, b, d.unit);
  const wire = d.range.wires?.[0];
  if (d.stage === 'physical')
    return wire
      ? t`The engine searched the full physical range of wire ${nm(wire)}, ${span}.`
      : t`The engine searched the full physical range of ${unknownName(d)}, ${span}.`;
  if (d.stage === 'table') return t`The engine searched the lengths that the table holds, ${span}.`;
  return t`The engine searched the search range on the sheet, ${span}.`;
}

/** The lines every failed search gives: what has no solution, where the engine searched, and
 *  what the two sides read at the ends. */
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
      t`This range is the search range on the sheet, and the engine did not search outside it.`,
    );
  } else {
    lines.push(t`No value of ${U} makes ${lhs} equal to ${rhs}.`);
    const a = d.range.author;
    const w = d.range.wiring?.range;
    if (d.stage === 'physical' && a && w && (a[0] !== w[0] || a[1] !== w[1]))
      lines.push(
        t`The search range on the sheet, ${spanText(a[0], a[1], d.unit)}, holds no solution.`,
        t`The engine then searched the physical range.`,
      );
    lines.push(searchedLine(d));
  }
  d.ends.forEach((e, k) => {
    if (e.stepped === undefined) return;
    const past = k === 0 ? 'below' : 'above';
    lines.push(
      e.steppedOutside
        ? t`The search stopped at ${quantityText(e.x, d.unit)}, because ${partName(e.steppedOutside.device)} is outside its table ${past} it.`
        : t`The search stopped at ${quantityText(e.x, d.unit)}, because ${lhs} gives no number ${past} it.`,
    );
  });
  lines.push(...relationLine(d));
  // Where the left side is the unknown itself, its values at the ends are the range again.
  if (d.relation.lhs.trim() !== d.unknown)
    lines.push(
      t`${lhs} is ${quantityText(lo.lhs, unit)} at the low end and ${quantityText(hi.lhs, unit)} at the high end.`,
    );
  lines.push(
    lo.rhs === hi.rhs
      ? t`${rhs} is ${quantityText(lo.rhs, unit)}.`
      : t`${rhs} is ${quantityText(lo.rhs, unit)} at the low end and ${quantityText(hi.rhs, unit)} at the high end.`,
  );
  return lines;
}

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
    if (e.kind === 'sign') lines.push(t`The engine did not show that ${monotonicText(d)}.`);
  } else if (d.range.from === 'table')
    lines.push(t`Load a table that holds a wider range of lengths.`);
  else if (d.stage === 'sheet') lines.push(t`Widen the search range of ${U}.`);
  return [...lines, ...givenLines(d)];
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
  if (why.kind === 'sweeps') {
    const m = d.members.find((x) => x.unknown === why.moved.name) as SearchData;
    return [
      ...pair,
      t`The engine searched them in turn ${String(why.sweeps)} times, and they still moved.`,
      t`In the last pass, ${unknownName(m)} moved by ${quantityText(why.moved.by, m.unit)}.`,
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
  if (why.kind === 'verification')
    return [
      ...pair,
      ...why.off.map((o) => {
        const m = d.members.find((x) => x.unknown === o.name) as SearchData;
        const gap =
          o.lhs !== undefined && o.rhs !== undefined
            ? ` by ${quantityText(Math.abs(o.lhs - o.rhs), relationUnit(m))}`
            : '';
        return t`When the engine checked the solution, the two sides for ${unknownName(m)} differed${gap}.`;
      }),
    ];
  const m = d.members[0];
  const at = why.at;
  const { lhs, rhs } = sidesOf(m.relation);
  const span = spanText(m.searched[0], m.searched[1], m.unit);
  if (at.where === 'nowhere')
    return [
      t`The engine searched ${unknownName(m)} ${span}.`,
      ...relationLine(m),
      t`${lhs} gives no number at any value that the engine tried.`,
      ...(at.by ? [t`${itemName(at.by)} gives no number there.`] : []),
    ];
  if (at.where === 'one-point')
    return [
      ...relationLine(m),
      t`${lhs} gives a number only at ${unknownName(m)} = ${quantityText(at.end.x, m.unit)}.`,
      t`The engine searched ${unknownName(m)} ${span}.`,
    ];
  return [
    ...relationLine(m),
    t`${lhs} crosses ${rhs} between ${quantityText(at.between[0], m.unit)} and ${quantityText(at.between[1], m.unit)}.`,
    t`${lhs} gives no number at the values that the engine tried there.`,
  ];
}

function limitText(d: LimitData): Line[] {
  const m = d.members[0];
  return d.limit === 'evaluations'
    ? [
        t`The engine stopped after ${String(d.count)} calculations, because it reached its limit.`,
        t`The last search was for ${unknownName(m)}.`,
        t`Raise the calculation limit in the solver settings.`,
      ]
    : [
        t`The search for ${unknownName(m)} stopped after ${String(d.count)} trial values, because it reached its limit.`,
        t`Narrow the search range of ${unknownName(m)}.`,
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
        ? where
          ? t`Block ${nm(where)} refers to a sheet, and the library holds no sheet of that name.`
          : t`The sheet refers to a sheet, and the library holds no sheet of that name.`
        : where
          ? t`The entry ${nm(where)} holds a value that is not valid.`
          : t`An entry of the sheet holds a value that is not valid.`;
  const reads =
    d.why === 'format'
      ? [t`This app reads format version ${String(FORMAT_VERSION)} and sheets with no version.`]
      : [];
  return [t`The engine cannot read the sheet.`, reason, ...reads];
}

function notDeterminedText(d: NotDeterminedData): Line[] {
  const head = t`The statements of the sheet do not determine one design.`;
  const each = (f: (n: Segment) => Line): Line[] => d.names.map((n) => f(nm(n)));
  switch (d.why) {
    case 'decision-missing':
      return [head, ...each((n) => t`No statement sets ${n}.`)];
    case 'decision-twice':
      return [head, ...each((n) => t`More than one statement sets ${n}.`)];
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
    case 'netlist':
      return [
        head,
        d.names.length
          ? t`The netlist check reports a problem at ${andLines(d.names.map((n) => [nm(n.replace(/"/g, ''))]))}.`
          : t`The netlist check reports a problem in the wiring of the sheet.`,
      ];
  }
}

const SIDE_WORD = { lhs: 'left', rhs: 'right' } as const;

function cannotEvaluateText(d: CannotEvaluateData, ref?: ItemRef): Line[] {
  const subject: Line = ref ? itemName(ref) : [nm(d.name)];
  if (ref?.kind === 'device') {
    const sized = t`${subject} cannot be sized.`;
    if (d.why === 'no-column') return [sized, t`The table holds no column for ${nm(d.name)}.`];
    if (d.why === 'no-sweep') return [sized, t`The table holds no sweep of ${nm(d.name)}.`];
    if (d.why === 'illegal-pair')
      return [sized, t`The two quantities bound on it do not determine its size.`];
    return [sized];
  }
  // A region check: the engine wrote its two sides from the region the device declares.
  if (d.region) {
    const device = ref?.path.length ? partName(ref.path.join('.')) : partName(d.region.device);
    const head = t`The engine cannot test the region of ${device}.`;
    return d.region.missing === 'device'
      ? [head, t`${device} is not sized.`]
      : [head, t`${deviceQuantity(d.region.missing)} of ${device} gives no number.`];
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
    case 'syntax':
      return [head, t`${subject} has a syntax error.`];
    case 'no-column':
      return [head, t`The table holds no column for ${nm(d.name)}.`];
    case 'no-sweep':
      return [head, t`The table holds no sweep of ${nm(d.name)}.`];
    case 'illegal-pair':
      return [head, t`The two quantities bound on the device do not determine its size.`];
    case 'not-finite':
      return [head];
  }
}

function outsideTableText(d: OutsideTableData): Line[] {
  const w = quantityWords(d.quantity);
  const [lo, hi] = d.held;
  return [
    t`${partName(d.device)} asks for a ${w.one} of ${quantityText(d.asked, w.unit)}.`,
    t`The table holds ${w.many} ${spanText(lo, hi, w.unit)}.`,
    ...(d.set ? [t`Change ${nm(d.set)}, or load a table that holds this ${w.one}.`] : []),
  ];
}

const REQUIRES: Record<CheckOp, string> = {
  '>=': 'at least',
  '<=': 'at most',
  '==': 'a value equal to',
};

function failsText(d: FailsData, ref?: ItemRef): Line[] {
  const check: Line = ref ? itemName(ref) : t`the check`;
  // marginPct is a fraction of the limit; the reader reads a percentage.
  const sign = d.marginPct >= 0 ? '+' : '−';
  const left = isName(d.text.lhs) ? nameText(d.text.lhs) : t`the left side of ${check}`;
  return [
    t`${check} fails.`,
    t`${left} is ${quantityText(d.lhs, d.unit)}, and ${check} requires ${REQUIRES[d.text.op]} ${quantityText(d.rhs, d.unit)}.`,
    t`The margin is ${sign}${quantityText(Math.abs(d.marginPct) * 100)} %.`,
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
      return notDeterminedText(c.data);
    case 'outside-table':
      return outsideTableText(c.data);
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

/** The clause a withheld item's sentence gives for the failed item it depends on: one for each
 *  cause, so the not-proved cause never reads as a proof. */
export function withheldClause(r: WithheldOn): Line {
  const n = itemName(r);
  switch (r.cause) {
    case 'not-read':
      return r.path.length
        ? t`the engine cannot read block ${nm(r.path.join('.'))}`
        : t`the engine cannot read the sheet`;
    case 'not-determined':
      return r.kind === 'sheet'
        ? t`the statements of ${n} do not determine one design`
        : t`the statements do not determine ${n}`;
    case 'cannot-evaluate':
      return t`${n} gives no number`;
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

/** What a reader is shown for one item: nothing for an item that is ok; for a failed one, its
 *  cause's text; for a withheld one, one sentence for each failed item it depends on. */
export function describe(item: Item): FindingText {
  if (item.status === 'ok') return finding('', []);
  if (item.status === 'withheld')
    return finding(
      WITHHELD_NAME,
      item.on.map((r) =>
        upperFirst(t`${itemName(item)} is not calculated, because ${withheldClause(r)}.`),
      ),
    );
  return textOf(item.cause, item);
}

/** What a held point or range end that was not run is shown: its own word, and why. */
export const notAskedText = (what: 'range end' | 'held point', name: string): FindingText =>
  finding(NOT_ASKED_NAME, [
    what === 'range end'
      ? t`The engine did not run range end ${nm(name)}, because the design point has no design.`
      : t`The engine did not run the condition ${nm(name)}, because the design point has no design.`,
  ]);
