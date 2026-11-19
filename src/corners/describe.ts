// The words for one design across characterization conditions: the condition, the held design at
// each point and over all of them, the margins, and why a condition was not run. Built from the
// corners module's own data and the sheet's text module (src/sheet/describe.ts), whose lines,
// helpers and verdict words this module uses; the sheet module never imports this one. A point's
// reason is never restated here: the "because" part is the sheet's own text for the item, and this
// module adds the place.
//
// A condition is always named plainly ("tt 27 °C"). What its table's file did not declare is said
// once, in a note (conditionNote), and every function whose sentences name a condition returns the
// notes of the conditions it names beside its lines, so a reader that shows a sentence alone still
// has the note with it.
//
// Pure; zero DOM.

import type { SheetDoc } from '../sheet';
import {
  andLines,
  describe,
  designReason,
  incompleteText,
  lineText,
  nm,
  quantityText,
  standardProblems,
  t,
  verdictText,
  withheldClause,
  VERDICT_WORDS,
  type FindingText,
  type Line,
} from '../sheet/describe';
import type { DesignVerdict, HeldVerdict, Item, ItemRef, Verdict } from '../sheet/states';
import {
  conditionKeyOf,
  sameCondition,
  type CharacterizedDevice,
  type CheckWorstPoint,
  type CompliancePoint,
  type ConditionAggregate,
  type ConditionIssue,
  type ConditionKey,
  type ConditionRun,
} from './index';

/** Sentences, and the notes of the conditions they name (conditionNote), kept apart so a reader
 *  can show each note once. */
export interface Said {
  readonly lines: readonly Line[];
  readonly notes: readonly Line[];
}

/** Lines that keep their order, each once. */
const distinct = (ls: readonly Line[]): Line[] =>
  ls.filter((l, k, all) => all.findIndex((m) => lineText(m) === lineText(l)) === k);

// --- the condition -------------------------------------------------------------------------

/** A temperature as a reader reads it: the true minus sign, and the unit after a space. */
const celsius = (temp: number): string => `${String(temp).replace('-', '−')} °C`;

/** The member of `device` at `key`, whose table's record says what its file declared. */
const memberAt = (
  device: CharacterizedDevice | undefined,
  key: { readonly corner: string; readonly temp: number },
) => {
  const at = conditionKeyOf(key);
  return device?.conditions.find((m) => sameCondition(conditionKeyOf(m.id), at));
};

/**
 * A condition in words: the corner as the file spells it, a space, the temperature ("ss 125 °C",
 * "ss −40 °C"). A condition with no corner reads its temperature alone, and one with no finite
 * temperature its corner alone. What the file did not declare is not marked here: it is the
 * condition's note (conditionNote), which every sentence naming the condition returns.
 */
export function conditionWords(
  device: CharacterizedDevice | undefined,
  key: { readonly corner: string; readonly temp: number },
): Line {
  const member = memberAt(device, key);
  const corner = (member?.id.corner ?? key.corner).trim();
  const temp = member?.id.temp ?? key.temp;
  if (!corner) return t`${celsius(temp)}`;
  if (!Number.isFinite(temp)) return [nm(corner)];
  return t`${nm(corner)} ${celsius(temp)}`;
}

/**
 * What the engine assumes of a condition because its table's file did not state it, one sentence
 * for each: "The engine assumes 27 °C, because the table of nmos_demo states no temperature." Read
 * from the record conditionLabel marks its label from (TableMeta.filled), so the note and the
 * label's mark agree. Empty for a condition its file declared in full, or one no table answers to.
 */
export function conditionNote(
  device: CharacterizedDevice | undefined,
  key: { readonly corner: string; readonly temp: number },
): Line[] {
  const member = memberAt(device, key);
  if (!member) return [];
  const filled = member.meta.filled ?? [];
  const of = nm(member.id.device);
  const out: Line[] = [];
  if (filled.includes('temp'))
    out.push(
      t`The engine assumes ${celsius(member.id.temp)}, because the table of ${of} states no temperature.`,
    );
  if (filled.includes('corner'))
    out.push(
      t`The engine assumes the corner ${nm(member.id.corner.trim())}, because the table of ${of} states no corner.`,
    );
  return out;
}

/** The notes of every condition `keys` names, each once. */
const notesOf = (
  device: CharacterizedDevice | undefined,
  keys: readonly { readonly corner: string; readonly temp: number }[],
): Line[] => distinct(keys.flatMap((k) => conditionNote(device, k)));

// --- counts --------------------------------------------------------------------------------

/** "at 3 of 5 points", "at all 5 points", "at both points". */
const ofAll = (n: number, total: number, what: string): string =>
  n === total
    ? total === 2
      ? `at both ${what}`
      : `at all ${total} ${what}`
    : `at ${n} of ${total} ${what}`;

type Counts = ConditionAggregate['heldPoints'];

/** The held-point counts, read in one order: compliant, non-compliant, no operating point,
 *  undetermined. */
const HELD_ORDER = ['compliant', 'nonCompliant', 'noOperatingPoint', 'undetermined'] as const;
const HELD_WORD: Record<(typeof HELD_ORDER)[number], HeldVerdict> = {
  compliant: 'compliant',
  nonCompliant: 'non-compliant',
  noOperatingPoint: 'no-operating-point',
  undetermined: 'undetermined',
};

/** A verdict as a clause of the held design: "is compliant", "has no operating point". */
const heldClause = (v: HeldVerdict): { verb: 'is' | 'has'; word: string } =>
  v === 'no-operating-point'
    ? { verb: 'has', word: VERDICT_WORDS[v] }
    : { verb: 'is', word: VERDICT_WORDS[v] };

/** What one set of counts reads: its sentences, and a chip. */
export interface CountText {
  readonly lines: readonly Line[];
  readonly chip: string;
}

/**
 * The held-point counts (ConditionAggregate.heldPoints) as sentences and a chip. One sentence over
 * the points the engine calculated, in the order compliant, non-compliant, no operating point,
 * undetermined, the first with its "of N points", zero counts left out; the points the engine did
 * not calculate in a sentence of their own. With one point in all there is no count to read: the
 * point's own sentence says it (pointText), and only the chip is given. It names no condition.
 *
 * The chip: with one point, its verdict word alone; otherwise the worst word present with its
 * count, in the order no operating point, non-compliant, undetermined; where no point is any of
 * those, how many are compliant, or that none was calculated.
 */
export function heldPointsText(counts: Counts): CountText {
  const total = counts.total;
  const lines: Line[] = [];
  const present = HELD_ORDER.filter((k) => counts[k] > 0);
  if (total > 1) {
    if (present.length) {
      let last: 'is' | 'has' | undefined;
      const clauses = present.map((k, i) => {
        const { verb, word } = heldClause(HELD_WORD[k]);
        const n = counts[k];
        const at = i === 0 ? ofAll(n, total, 'points') : `at ${n}`;
        const lead = verb === last ? '' : `${verb} `;
        last = verb;
        return t`${lead}${word} ${at}`;
      });
      lines.push(t`The held design ${andLines(clauses)}.`);
      if (counts.notCalculated)
        lines.push(
          t`The engine did not calculate ${counts.notCalculated === 1 ? '1 point' : `${counts.notCalculated} points`}.`,
        );
    } else if (counts.notCalculated)
      lines.push(
        t`The engine did not calculate the held design at any of the ${String(total)} points.`,
      );
  }
  return { lines, chip: countChip(counts, 'points') };
}

/** The chip of a set of verdict counts (heldPointsText, endCountText). */
function countChip(counts: Counts, what: string): string {
  const total = counts.total;
  if (total === 0) return '';
  const worse = (['noOperatingPoint', 'nonCompliant', 'undetermined'] as const).find(
    (k) => counts[k] > 0,
  );
  const word = worse
    ? VERDICT_WORDS[HELD_WORD[worse]]
    : counts.compliant
      ? VERDICT_WORDS.compliant
      : VERDICT_WORDS['not-calculated'];
  if (total === 1) return word;
  const n = worse ? counts[worse] : counts.compliant || counts.notCalculated;
  return `${word} ${ofAll(n, total, what)}`;
}

/** The verdicts of one run's range ends as a fragment: "compliant at both range ends",
 *  "non-compliant at 1 of 2 range ends", "not calculated at all 4 range ends". Empty where the run
 *  has no range end. It names no condition. */
export function endCountText(run: ConditionRun): string {
  const ends = run.points.slice(1);
  const counts = {
    compliant: 0,
    nonCompliant: 0,
    noOperatingPoint: 0,
    undetermined: 0,
    notCalculated: 0,
    total: ends.length,
  };
  for (const p of ends) {
    const v = p.verdict?.verdict as HeldVerdict | undefined;
    const k = HELD_ORDER.find((h) => HELD_WORD[h] === v);
    counts[k ?? 'notCalculated']++;
  }
  return countChip(counts, 'range ends');
}

// --- one point -----------------------------------------------------------------------------

/** A requirement's name as a reader reads it, with its block path, linked to its item. */
const requirementName = (r: ItemRef): Line => [
  nm(r.path.length ? `${r.path.join('.')}.${r.name}` : r.name, {
    kind: r.kind,
    path: r.path,
    name: r.name,
  }),
];

/** "offset-spec fails", "offset-spec and gain-spec fail", "3 hard requirements fail". */
function failsClause(failed: Verdict<string>['failed']): Line {
  const fails = failed.filter((f) => f.cause.kind === 'fails');
  if (fails.length >= 3) return t`${String(fails.length)} hard requirements fail`;
  return t`${andLines(fails.map(requirementName))} ${fails.length > 1 ? 'fail' : 'fails'}`;
}

/** The clause each failed item gives its verdict ("the engine found no solution for V_tail"),
 *  distinct, joined as a list. */
const failedClauses = (failed: Verdict<string>['failed']): Line =>
  andLines(
    distinct(
      failed.map((f) =>
        withheldClause({ kind: f.kind, path: f.path, name: f.name, cause: f.cause.kind }),
      ),
    ),
  );

/** A failed item of a verdict as the item it is, for its own text. */
const asItem = (f: Verdict<string>['failed'][number]): Item => ({
  kind: f.kind,
  path: f.path,
  name: f.name,
  status: 'failed',
  cause: f.cause,
});

/** What a range end sets, in words: "sets CM_dc to 1 V", with the unit the sheet gives the param. */
function setsText(set: Readonly<Record<string, number>>, doc?: SheetDoc): Line {
  const unit = (n: string): string | undefined => doc?.params.find((p) => p.name === n)?.unit;
  const parts = Object.entries(set).map(([n, v]) => {
    return t`${nm(n)} to ${quantityText(v, unit(n))}`;
  });
  return t`sets ${andLines(parts)}`;
}

/** A verdict of the design at a place, with its reason: the subject ("The held design", "The
 *  design") and the place ("at ss 125 °C", "there"). */
function verdictLines(
  subject: string,
  v: Verdict<HeldVerdict> | Verdict<DesignVerdict>,
  where: Line,
): Line[] {
  const { verb, word } =
    v.verdict === 'no-operating-point'
      ? heldClause(v.verdict)
      : { verb: 'is', word: VERDICT_WORDS[v.verdict] };
  const head = t`${subject} ${verb} ${word} ${where}`;
  switch (v.verdict) {
    case 'compliant':
    case 'feasible':
      return [t`${head}.`];
    case 'non-compliant':
      return [t`${head}, because ${failsClause(v.failed)}.`];
    case 'no-operating-point':
    case 'infeasible': {
      const first = v.failed[0];
      const line = first ? describe(asItem(first)).segments[0] : undefined;
      return line ? [t`${head}.`, line] : [t`${head}.`];
    }
    case 'undetermined':
      return v.failed.length
        ? [t`${head}, because ${failedClauses(v.failed)}.`]
        : [t`${head}.`, ...verdictText(v)];
  }
}

/** The run and its range end that a point belongs to. */
export interface PointPlace {
  readonly run: ConditionRun;
  /** The point's index in run.points: 0 is the centre. */
  readonly index: number;
  /** The device whose conditions name the place (conditionWords). */
  readonly device?: CharacterizedDevice;
  /** The sheet, for the units of what a range end sets. */
  readonly doc?: SheetDoc;
}

/**
 * One point in sentences: what the design is there, and why, with the note of its condition.
 * - The condition the design is sized at: "The engine sized the design at tt 27 °C." and the design
 *   verdict "there".
 * - A held centre: the held verdict at the condition.
 * - A range end: what the end sets at the condition, and the held verdict "there"; a range end the
 *   engine did not calculate, one sentence whose reason is the end's own item's.
 * - A point with no verdict: that the engine did not calculate or run it, and why.
 */
export function pointText(place: PointPlace): Said {
  const { run, index, device, doc } = place;
  const point: CompliancePoint | undefined = run.points[index];
  const notes = notesOf(device, [run.key]);
  if (!point) return { lines: [], notes: [] };
  const where = conditionWords(device, run.key);
  const v = point.verdict;
  const said = (lines: Line[]): Said => ({ lines: distinct(lines), notes });

  if (index === 0 && run.design === 'sized') {
    if (!v)
      return said([
        t`The engine did not calculate the design at ${where}.`,
        ...issueLines(run, device),
      ]);
    return said([
      t`The engine sized the design at ${where}.`,
      ...verdictLines('The design', v, t`there`),
    ]);
  }

  if (index === 0) {
    if (v) return said(verdictLines('The held design', v as Verdict<HeldVerdict>, t`at ${where}`));
    return said(
      noDesignToHold(run)
        ? [
            t`The engine did not calculate the held design at ${where}, because the design point has no design.`,
          ]
        : issueLines(run, device),
    );
  }

  const name = point.rangeEnd ?? '';
  const end = run.result?.rangeEnds?.[index - 1];
  if (v)
    return said([
      t`At ${where}, range end ${nm(name)} ${setsText(end?.set ?? {}, doc)}.`,
      ...verdictLines('The held design', v as Verdict<HeldVerdict>, t`there`),
    ]);
  // Not calculated: the reason is the end's own item's (designReason), or its list's text.
  const head = t`The engine did not calculate range end ${nm(name)} at ${where}`;
  const own = end?.items;
  const design = run.result?.items;
  const [only] = own ?? [];
  const reason =
    own?.length === 1 && only.status === 'withheld' && design
      ? designReason(only.on, design)
      : undefined;
  // At a held condition the end's list points at the held centre's, not the design point's: the
  // reason is what the held design is there.
  const centre = run.points[0]?.verdict;
  if (reason && run.design === 'held' && centre?.verdict === 'undetermined')
    return said([t`${head}, because the held design is undetermined there.`]);
  if (reason && run.design === 'held' && centre?.verdict === 'no-operating-point')
    return said([t`${head}, because the held design has no operating point there.`]);
  if (reason) return said([t`${head}, because ${reason}.`]);
  if (own?.length)
    return said([
      t`${head}.`,
      ...incompleteText(own, { end: name, ...(design ? { design } : {}) }).flatMap(
        (f) => f.segments,
      ),
    ]);
  // A condition declined before anything ran: its range ends were never run.
  const ran = t`The engine did not run range end ${nm(name)} at ${where}`;
  return said(
    noDesignToHold(run) ? [t`${ran}, because the design point has no design.`] : [t`${ran}.`],
  );
}

/** Whether a condition was declined because the design was not evaluated where it is sized. */
const noDesignToHold = (run: ConditionRun): boolean =>
  run.state === 'not-evaluated' &&
  run.issues.some((i) => i.kind === 'no-design' && i.reason === 'base-not-evaluated');

// --- the margins ---------------------------------------------------------------------------

/** A relative margin as a reader reads it: percent, two significant digits, the true minus sign. */
const percent = (marginPct: number): string => {
  const p = marginPct * 100;
  const shown = String(Number(Math.abs(p).toPrecision(2)));
  return `${p < 0 ? '−' : ''}${shown} %`;
};

type At = { readonly key: ConditionKey; readonly rangeEnd?: string };

/** A point's place: "at ss 125 °C", "at ss 125 °C, range end cm-lo". */
const placeText = (device: CharacterizedDevice | undefined, at: At): Line =>
  at.rangeEnd === undefined
    ? t`at ${conditionWords(device, at.key)}`
    : t`at ${conditionWords(device, at.key)}, range end ${nm(at.rangeEnd)}`;

/** Several points as one place: the conditions joined under one range end where they share it
 *  ("at range end cm-lo in tt 27 °C, ss 125 °C and ff −40 °C"), else each point's place. */
function placesText(device: CharacterizedDevice | undefined, points: readonly At[]): Line {
  const ends = new Set(points.map((p) => p.rangeEnd));
  const [only] = ends;
  const conditions = andLines(points.map((p) => conditionWords(device, p.key)));
  if (points.length > 1 && ends.size === 1 && only !== undefined)
    return t`at range end ${nm(only)} in ${conditions}`;
  if (points.length > 1 && ends.size === 1) return t`at ${conditions}`;
  return andLines(points.map((p) => placeText(device, p)));
}

/** A sentence, or where it runs past the standard's length, its subject in one sentence and its
 *  margin in the next ("Its margin is 5.8 % at tt 27 °C, range end cm-lo."). */
function withMargin(subject: Line, margin: Line): Line[] {
  const whole = t`${subject}, with a margin of ${margin}.`;
  return standardProblems(whole).includes('more than 20 words')
    ? [t`${subject}.`, t`Its margin is ${margin}.`]
    : [whole];
}

/** What the points the margins were not read at are, after "The engine read margins at 6 of 9
 *  points.": not calculated, or calculated with no margin to read; one sentence for each kind. */
function unreadText(m: ConditionAggregate['marginPoints']): Line[] {
  const rest = m.total - m.read;
  if (rest <= 0) return [];
  if (m.notCalculated && m.unreadable)
    return [
      t`${String(m.notCalculated)} of the other points ${m.notCalculated === 1 ? 'is' : 'are'} not calculated.`,
      t`The engine read no margin at ${String(m.unreadable)} of the other points.`,
    ];
  if (m.notCalculated)
    return [
      rest === 1
        ? t`The other point is not calculated.`
        : t`The other ${String(rest)} points are not calculated.`,
    ];
  return [
    t`The engine read no margin at ${rest === 1 ? 'the other point' : `the other ${rest} points`}.`,
  ];
}

/**
 * The tightest hard requirement over every point, in sentences, with the notes of the conditions
 * they name. The checks that sit on their limit come first, grouped by the points they sit there
 * at; then the tightest of the others, or the one that fails worst, its margin in a sentence of its
 * own where one sentence would run past the standard's length. Where the margins were read at fewer
 * points than there are, it says how many and what the others are. Where no hard requirement has a
 * margin anywhere, it says why: the engine calculated no point, or every hard requirement is not
 * calculated.
 */
export function tightestText(agg: ConditionAggregate, device?: CharacterizedDevice): Said {
  const lines: Line[] = [];
  const named: ConditionKey[] = [];
  const groups = new Map<string, { ids: string[]; points: readonly At[] }>();
  for (const c of agg.onLimit) {
    const k = JSON.stringify(c.points.map((p) => [p.key.corner, p.key.temp, p.rangeEnd ?? null]));
    const g = groups.get(k);
    if (g) g.ids.push(c.id);
    else groups.set(k, { ids: [c.id], points: c.points });
  }
  for (const g of groups.values()) {
    const names = andLines(g.ids.map((id) => [nm(id)]));
    const places = placesText(device, g.points);
    named.push(...g.points.map((p) => p.key));
    lines.push(
      g.ids.length > 1
        ? t`${names} sit on their limits ${places}.`
        : t`${names} sits on its limit ${places}.`,
    );
  }
  const w = agg.worst;
  if (w) {
    named.push(w.key);
    const margin = t`${percent(w.marginPct)} ${placeText(device, w)}`;
    const fails = w.status === 'fail';
    const subject = agg.onLimit.length
      ? fails
        ? t`Of the other hard requirements, ${nm(w.id)} fails worst`
        : t`Of the other hard requirements, ${nm(w.id)} is the tightest`
      : fails
        ? t`${nm(w.id)} fails worst`
        : t`The tightest hard requirement is ${nm(w.id)}`;
    lines.push(...withMargin(subject, margin));
  }
  const m = agg.marginPoints;
  if (!w && !agg.onLimit.length) {
    // No margin anywhere, said by what the points are: none calculated; some calculated and no
    // margin read at any; or margins read and no hard requirement has one.
    if (m.read + m.unreadable === 0)
      lines.push(
        t`No hard requirement has a margin at any point, because the engine calculated no point.`,
      );
    else if (m.read === 0) {
      lines.push(t`The engine read no margin at any point.`);
      if (m.notCalculated)
        lines.push(
          t`${String(m.notCalculated)} of the ${String(m.total)} points ${m.notCalculated === 1 ? 'is' : 'are'} not calculated.`,
        );
    } else
      lines.push(
        t`No hard requirement has a margin at any point, because every hard requirement is not calculated.`,
      );
  } else if (m.read < m.total)
    lines.push(
      t`The engine read margins at ${String(m.read)} of ${String(m.total)} points.`,
      ...unreadText(m),
    );
  return { lines, notes: notesOf(device, named) };
}

/** One check's tightest point as a cell fragment, with the note of its condition: "−59 % at tt
 *  27 °C", "−59 % at ss 125 °C, cm-lo". */
export function worstAtText(
  w: CheckWorstPoint,
  device?: CharacterizedDevice,
): { readonly line: Line; readonly notes: readonly Line[] } {
  const where = conditionWords(device, w.key);
  return {
    line:
      w.rangeEnd === undefined
        ? t`${percent(w.marginPct)} at ${where}`
        : t`${percent(w.marginPct)} at ${where}, ${nm(w.rangeEnd)}`,
    notes: notesOf(device, [w.key]),
  };
}

// --- why a condition was not run -----------------------------------------------------------

/**
 * Why a condition was not run, from the issue's data: its sentences, ending with the one action
 * where the designer can act, and the note of the condition. A run that did not complete and a
 * sheet that does not validate write no sentence here: their text is the items' own
 * (issueFindings).
 */
export function conditionIssueText(
  issue: ConditionIssue,
  key: ConditionKey,
  device?: CharacterizedDevice,
): Said {
  const where = conditionWords(device, key);
  const said = (lines: Line[]): Said => ({ lines, notes: notesOf(device, [key]) });
  switch (issue.kind) {
    case 'absent-condition':
      return issue.missing === 'device'
        ? said([
            t`Block ${nm(issue.block ?? '')} names the device ${nm(issue.device)}, and no table of ${nm(issue.device)} is loaded.`,
            t`So the engine did not run this condition.`,
            t`Load a table of ${nm(issue.device)} at ${where}.`,
          ])
        : said([
            t`The device ${nm(issue.device)} has no table at ${where}, so the engine did not run this condition.`,
            t`Load a table of ${nm(issue.device)} at ${where}.`,
          ]);
    case 'ambiguous-condition':
      return said([
        t`Two tables of the device ${nm(issue.device)} claim ${where}, so the engine did not run this condition.`,
        t`Remove one of the two tables.`,
      ]);
    case 'incompatible-table':
      return said([
        t`The tables of the device ${nm(issue.device)} do not sweep the same axes, so the engine runs none of its conditions.`,
        t`Load tables of ${nm(issue.device)} that sweep the same axes.`,
      ]);
    case 'no-design':
      return issue.reason === 'base-not-evaluated'
        ? said([t`The engine did not run ${where}, because the design point has no design.`])
        : said([
            t`The sheet names no condition to size the design at, so the engine did not run ${where}.`,
            t`Choose the condition at which the engine sizes the design.`,
          ]);
    case 'assumed-level': {
      const names = andLines(issue.names.map(requirementName));
      return said([
        t`The engine does not hold the design at ${where}, because ${names} ${issue.names.length > 1 ? 'are' : 'is'} marked assumed.`,
      ]);
    }
    case 'runtime-evaluation':
    case 'invalid-sheet-or-ref':
      return { lines: [], notes: [] };
  }
}

/** The text of a run's issues whose text is the items' own: a run that did not complete reads its
 *  incomplete items (incompleteText); a sheet that does not validate reads each item its findings
 *  are on, from the list the declined run carries (describe). Empty for the other issues. */
export function issueFindings(run: ConditionRun): FindingText[] {
  if (run.state !== 'not-evaluated') return [];
  if (run.issues.some((i) => i.kind === 'invalid-sheet-or-ref')) {
    const on = run.issues.flatMap((i) => (i.kind === 'invalid-sheet-or-ref' ? i.on : []));
    return (run.items ?? [])
      .filter((it) =>
        on.some(
          (r) => r.kind === it.kind && r.name === it.name && r.path.join('.') === it.path.join('.'),
        ),
      )
      .map((it) => describe(it));
  }
  if (run.issues.some((i) => i.kind === 'runtime-evaluation') && run.result?.items)
    return incompleteText(run.result.items);
  return [];
}

/** Every line of why a declined run was not run: the issues with a sentence of their own, then the
 *  items' own text. */
function issueLines(run: ConditionRun, device?: CharacterizedDevice): Line[] {
  if (run.state !== 'not-evaluated') return [];
  const own = run.issues.flatMap((i) => conditionIssueText(i, run.key, device).lines);
  const items = issueFindings(run).flatMap((f) => f.segments);
  return distinct([...own, ...items]);
}
