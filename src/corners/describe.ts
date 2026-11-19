// The words for one design across characterization conditions: the condition, the held design at
// each point and over all of them, the margins, and why a condition was not run. Built from the
// corners module's own data and the sheet's text module (src/sheet/describe.ts), whose lines,
// helpers and verdict words this module uses; the sheet module never imports this one. A point's
// reason is never restated here: the "because" part is the sheet's own text for the item, and this
// module adds the place.
//
// Pure; zero DOM.

import type { SheetDoc } from '../sheet';
import {
  andLines,
  describe,
  incompleteText,
  lineText,
  nm,
  t,
  verdictText,
  withheldClause,
  VERDICT_WORDS,
  type FindingText,
  type Line,
} from '../sheet/describe';
import type { HeldVerdict, Item, ItemRef, Verdict } from '../sheet/states';
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

// --- the condition -------------------------------------------------------------------------

/** A temperature as a reader reads it: the true minus sign, and the unit after a space. */
const celsius = (temp: number): string => `${String(temp).replace('-', '−')} °C`;

/**
 * A condition in words: the corner as the file spells it, a space, the temperature ("ss 125 °C",
 * "ss −40 °C"). A condition with no corner reads its temperature alone, and one with no finite
 * temperature its corner alone. A corner or temperature the file did not declare (the table's
 * record of what it filled in) reads as assumed, where it stands, so a default never reads as a
 * declaration: "tt at an assumed 27 °C", "an assumed tt at 125 °C", "an assumed tt at an assumed
 * 27 °C". Read from the same record as conditionLabelIn: the member of `device` at `key`, or the
 * bare key where no member answers to it.
 */
export function conditionWords(
  device: CharacterizedDevice | undefined,
  key: { readonly corner: string; readonly temp: number },
): Line {
  const at = conditionKeyOf(key);
  const member = device?.conditions.find((m) => sameCondition(conditionKeyOf(m.id), at));
  const corner = (member?.id.corner ?? key.corner).trim();
  const temp = member?.id.temp ?? key.temp;
  const filled = member?.meta.filled ?? [];
  const noCorner = filled.includes('corner');
  const noTemp = filled.includes('temp');
  if (!noCorner && !noTemp) {
    if (!corner) return t`${celsius(temp)}`;
    if (!Number.isFinite(temp)) return [nm(corner)];
    return t`${nm(corner)} ${celsius(temp)}`;
  }
  const c = noCorner ? t`an assumed ${nm(corner)}` : [nm(corner)];
  const k = noTemp ? `an assumed ${celsius(temp)}` : celsius(temp);
  return t`${c} at ${k}`;
}

// --- counts --------------------------------------------------------------------------------

/** "at 3 of 5", "at all 5", "at both". */
const ofAll = (n: number, total: number, what: string): string =>
  n === total
    ? total === 2
      ? `at both ${what}`
      : `at all ${total} ${what}`
    : `at ${n} of ${total} ${what}`;

/** The held-point counts, read in one order: compliant, non-compliant, no operating point,
 *  undetermined. */
const HELD_ORDER: readonly (keyof ConditionAggregate['heldPoints'] & string)[] = [
  'compliant',
  'nonCompliant',
  'noOperatingPoint',
  'undetermined',
];
const HELD_WORD: Record<string, HeldVerdict> = {
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

/** What one held-point count reads: its sentences, and a chip. */
export interface CountText {
  readonly lines: readonly Line[];
  readonly chip: string;
}

/**
 * The held-point counts (ConditionAggregate.heldPoints) as sentences and a chip. One sentence over
 * the points the engine calculated, in the order compliant, non-compliant, no operating point,
 * undetermined, the first with its "of N points", zero counts left out; the points the engine did
 * not calculate in a sentence of their own. With one point in all there is no count to read: the
 * point's own sentence says it (pointText), and only the chip is given.
 *
 * The chip names the worst word present with its count, in the order no operating point,
 * non-compliant, undetermined; where no point is any of those, how many are compliant, or that none
 * was calculated.
 */
export function heldPointsText(counts: ConditionAggregate['heldPoints']): CountText {
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
  return { lines, chip: countChip(counts, total, 'points') };
}

/** The chip of a set of verdict counts (heldPointsText, endCountText). */
function countChip(counts: ConditionAggregate['heldPoints'], total: number, what: string): string {
  if (total === 0) return '';
  const worse = (['noOperatingPoint', 'nonCompliant', 'undetermined'] as const).find(
    (k) => counts[k] > 0,
  );
  const of = (n: number): string =>
    total === 1 ? `at the ${what.replace(/s$/, '')}` : ofAll(n, total, what);
  if (worse) return `${VERDICT_WORDS[HELD_WORD[worse]]} ${of(counts[worse])}`;
  if (counts.compliant) return `${VERDICT_WORDS.compliant} ${of(counts.compliant)}`;
  return `${VERDICT_WORDS['not-calculated']} ${of(counts.notCalculated)}`;
}

/** The verdicts of one run's range ends as a fragment: "compliant at both range ends",
 *  "non-compliant at 1 of 2 range ends", "not calculated at all 4 range ends". Empty where the run
 *  has no range end. */
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
    if (v === undefined) counts.notCalculated++;
    else
      counts[
        (Object.keys(HELD_WORD) as (keyof typeof HELD_WORD)[]).find(
          (k) => HELD_WORD[k] === v,
        ) as 'compliant'
      ]++;
  }
  return countChip(counts, ends.length, 'range ends');
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
    failed
      .map((f) => withheldClause({ kind: f.kind, path: f.path, name: f.name, cause: f.cause.kind }))
      .filter((l, k, all) => all.findIndex((m) => lineText(m) === lineText(l)) === k),
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
    const u = unit(n);
    const shown = `${String(Number(v.toPrecision(3))).replace('-', '−')}${u ? ` ${u}` : ''}`;
    return t`${nm(n)} to ${shown}`;
  });
  return parts.length ? t`sets ${andLines(parts)}` : t`sets nothing`;
}

/** The held design's verdict at a place, with its reason, as one or two sentences. `where` is the
 *  place ("at ss 125 °C") for a centre, or "there" after a range end's own sentence. */
function heldVerdictLines(v: Verdict<HeldVerdict>, where: Line): Line[] {
  const { verb, word } = heldClause(v.verdict);
  const head = t`The held design ${verb} ${word} ${where}`;
  switch (v.verdict) {
    case 'compliant':
      return [t`${head}.`];
    case 'non-compliant':
      return [t`${head}, because ${failsClause(v.failed)}.`];
    case 'no-operating-point': {
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
 * One point in sentences: what the design is there, and why. At a centre the place is the
 * condition; at a range end, a first sentence says what the end sets, and the verdict follows
 * "there". The condition the design is sized at reads its design verdict, "where the engine sized
 * it". A point with no verdict reads that the engine did not calculate it, and why: a range end's
 * own text, or the reason the condition was not run.
 */
export function pointText(place: PointPlace): Line[] {
  const { run, index, device, doc } = place;
  const point: CompliancePoint | undefined = run.points[index];
  if (!point) return [];
  const where = conditionWords(device, run.key);
  const end = index > 0 ? run.result?.rangeEnds?.[index - 1] : undefined;
  const v = point.verdict;

  if (index === 0 && run.design === 'sized') {
    if (!v)
      return [t`The engine did not calculate the design at ${where}.`, ...issueLines(run, device)];
    return [t`The design is ${VERDICT_WORDS[v.verdict]} at ${where}, where the engine sized it.`];
  }

  if (index === 0) {
    if (v) return heldVerdictLines(v as Verdict<HeldVerdict>, t`at ${where}`);
    const noDesign =
      run.state === 'not-evaluated' &&
      run.issues.some((i) => i.kind === 'no-design' && i.reason === 'base-not-evaluated');
    return noDesign
      ? [
          t`The engine did not calculate the held design at ${where}, because the design point has no design.`,
        ]
      : issueLines(run, device);
  }

  const name = point.rangeEnd ?? '';
  if (v)
    return [
      t`At ${where}, range end ${nm(name)} ${setsText(end?.set ?? {}, doc)}.`,
      ...heldVerdictLines(v as Verdict<HeldVerdict>, t`there`),
    ];
  // Not calculated: the design point gives no design, or the end's own list says why.
  const head = t`The engine did not calculate range end ${nm(name)} at ${where}`;
  const designItems = run.result?.items;
  const own = end?.items;
  if (own?.length === 1 && own[0].kind === 'sheet' && own[0].status === 'withheld')
    return [t`${head}, because the design point has no design.`];
  if (own?.length)
    return [
      t`${head}.`,
      ...incompleteText(own, {
        end: name,
        ...(designItems ? { design: designItems } : {}),
      }).flatMap((f) => f.segments),
    ];
  const noDesign =
    run.state === 'not-evaluated' &&
    run.issues.some((i) => i.kind === 'no-design' || i.kind === 'runtime-evaluation');
  return noDesign
    ? [t`${head}, because the design point has no design.`]
    : [t`${head}.`, ...issueLines(run, device)];
}

// --- the margins ---------------------------------------------------------------------------

/** A relative margin as a reader reads it: percent, two significant digits, the true minus sign. */
const percent = (marginPct: number): string => {
  const p = marginPct * 100;
  const shown = String(Number(Math.abs(p).toPrecision(2)));
  return `${p < 0 ? '−' : ''}${shown} %`;
};

/** A point's place: "at ss 125 °C", "at ss 125 °C, range end cm-lo". */
const placeText = (
  device: CharacterizedDevice | undefined,
  at: { readonly key: ConditionKey; readonly rangeEnd?: string },
): Line =>
  at.rangeEnd === undefined
    ? t`at ${conditionWords(device, at.key)}`
    : t`at ${conditionWords(device, at.key)}, range end ${nm(at.rangeEnd)}`;

/** Several points as one place: the conditions joined under one range end where they share it
 *  ("at range end cm-lo of tt 27 °C, ss 125 °C and ff −40 °C"), else each point's place. */
function placesText(
  device: CharacterizedDevice | undefined,
  points: readonly { readonly key: ConditionKey; readonly rangeEnd?: string }[],
): Line {
  const ends = new Set(points.map((p) => p.rangeEnd));
  const [only] = ends;
  if (points.length > 1 && ends.size === 1 && only !== undefined)
    return t`at range end ${nm(only)} of ${andLines(points.map((p) => conditionWords(device, p.key)))}`;
  if (points.length > 1 && ends.size === 1)
    return t`at ${andLines(points.map((p) => conditionWords(device, p.key)))}`;
  return andLines(points.map((p) => placeText(device, p)));
}

/**
 * The tightest hard requirement over every point, in sentences. The checks that sit on their limit
 * come first, grouped by the points they sit there at; then the tightest of the others, or the one
 * that fails worst. Where the margins were read at fewer points than there are, it says how many.
 * Where no hard requirement has a margin anywhere, it says why: the engine calculated no point, or
 * every hard requirement is not calculated.
 */
export function tightestText(agg: ConditionAggregate, device?: CharacterizedDevice): Line[] {
  const lines: Line[] = [];
  const groups = new Map<
    string,
    { ids: string[]; points: ConditionAggregate['onLimit'][number]['points'] }
  >();
  for (const c of agg.onLimit) {
    const k = JSON.stringify(c.points.map((p) => [p.key.corner, p.key.temp, p.rangeEnd ?? null]));
    const g = groups.get(k);
    if (g) g.ids.push(c.id);
    else groups.set(k, { ids: [c.id], points: c.points });
  }
  for (const g of groups.values()) {
    const names = andLines(g.ids.map((id) => [nm(id)]));
    const places = placesText(device, g.points);
    lines.push(
      g.ids.length > 1
        ? t`${names} sit on their limits ${places}.`
        : t`${names} sits on its limit ${places}.`,
    );
  }
  const w = agg.worst;
  if (w) {
    const at = placeText(device, w);
    const fails = w.status === 'fail';
    const sentence = fails
      ? t`${nm(w.id)} fails worst, with a margin of ${percent(w.marginPct)} ${at}.`
      : t`${nm(w.id)} is the tightest, with a margin of ${percent(w.marginPct)} ${at}.`;
    lines.push(
      agg.onLimit.length
        ? t`Of the other hard requirements, ${sentence}`
        : fails
          ? sentence
          : t`The tightest hard requirement is ${nm(w.id)}, with a margin of ${percent(w.marginPct)} ${at}.`,
    );
  }
  if (!w && !agg.onLimit.length) {
    const calculated = agg.heldPoints.total - agg.heldPoints.notCalculated + (agg.verdict ? 1 : 0);
    lines.push(
      calculated === 0
        ? t`No hard requirement has a margin at any point, because the engine calculated no point.`
        : t`No hard requirement has a margin at any point, because every hard requirement is not calculated.`,
    );
  } else if (agg.marginPoints.read < agg.marginPoints.total)
    lines.push(
      t`The margins were read at ${String(agg.marginPoints.read)} of ${String(agg.marginPoints.total)} points.`,
    );
  return lines;
}

/** One check's tightest point as a cell fragment: "−59 % at tt 27 °C", "−59 % at ss 125 °C,
 *  cm-lo". */
export function worstAtText(w: CheckWorstPoint, device?: CharacterizedDevice): Line {
  const where = conditionWords(device, w.key);
  return w.rangeEnd === undefined
    ? t`${percent(w.marginPct)} at ${where}`
    : t`${percent(w.marginPct)} at ${where}, ${nm(w.rangeEnd)}`;
}

// --- why a condition was not run -----------------------------------------------------------

/**
 * Why a condition was not run, from the issue's data: a sentence, and the action line where the
 * designer can act. A run that did not complete and a sheet that does not validate write no
 * sentence here: their text is the items' own (issueFindings).
 */
export function conditionIssueText(
  issue: ConditionIssue,
  key: ConditionKey,
  device?: CharacterizedDevice,
): Line[] {
  const where = conditionWords(device, key);
  switch (issue.kind) {
    case 'absent-condition':
      return issue.missing === 'device'
        ? [
            t`Block ${nm(issue.block ?? '')} names the device ${nm(issue.device)}, which is not loaded, so the engine did not run this condition.`,
            t`Load a table of ${nm(issue.device)}.`,
          ]
        : [
            t`The device ${nm(issue.device)} has no table at ${where}, so the engine did not run this condition.`,
            t`Load a table of ${nm(issue.device)} at ${where}.`,
          ];
    case 'ambiguous-condition':
      return [
        t`Two tables of the device ${nm(issue.device)} claim ${where}, so the engine did not run this condition.`,
        t`Remove one of the two tables.`,
      ];
    case 'incompatible-table':
      return [
        t`The tables of the device ${nm(issue.device)} do not sweep the same axes, so the engine runs none of its conditions.`,
        t`Load tables of ${nm(issue.device)} that sweep the same axes.`,
      ];
    case 'no-design':
      return issue.reason === 'base-not-evaluated'
        ? [t`The engine did not run ${where}, because the design point has no design.`]
        : [
            t`No condition is named for sizing the design, so the engine did not run ${where}.`,
            t`Name the condition to size the design at.`,
          ];
    case 'assumed-level': {
      const names = andLines(issue.names.map((r) => requirementName(r)));
      return [
        t`The engine does not hold the design at ${where}, because ${names} ${issue.names.length > 1 ? 'are' : 'is'} marked assumed.`,
      ];
    }
    case 'runtime-evaluation':
    case 'invalid-sheet-or-ref':
      return [];
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
  const own = run.issues.flatMap((i) => conditionIssueText(i, run.key, device));
  const items = issueFindings(run).flatMap((f) => f.segments);
  return [...own, ...items].filter(
    (l, k, all) => all.findIndex((m) => lineText(m) === lineText(l)) === k,
  );
}
