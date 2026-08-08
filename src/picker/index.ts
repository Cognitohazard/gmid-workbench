// The topology picker: a screening instrument over a library of design sheets. A designer
// states the spec they have; every candidate design-type is evaluated against it, the sheet's
// OWN implementation knobs are searched for a point that closes, and each candidate reports
// what it cost and what binds it.
//
// It is not an optimizer and it proves nothing. A sheet that did not close says so together
// with the budget it was given — never "cannot close", which would be an attainability claim
// this engine cannot make. The three verdicts are kept apart for exactly that reason: a sheet
// the search never got traction on must not borrow the language of a sheet that was searched
// and ran out of room.
//
// Pure, deterministic, DOM-free. The one impurity a budgeted search would normally carry — a
// clock — is INJECTED (PickerOptions.now), so a test can bound the search by evaluations alone
// and get the same answer on every machine.

import type { DeviceTable } from '../types';
import {
  bindingConstraint,
  choiceKnobs,
  clampMargin,
  cloneDoc,
  edgeBroke,
  engineSolved,
  limitingConstraint,
  MARGIN_PCT_CAP,
  measurable,
  runSheet,
  sheetSensitivities,
  sweepSheet,
  sweepable,
  withParams,
} from '../sheet';
import type {
  DeviceResolver,
  SheetDoc,
  SheetRefEntry,
  SheetRefIndex,
  SheetResult,
  SheetSweep,
  SheetVar,
} from '../sheet';

// ---------------------------------------------------------------------------------------
// Which sheets the search is specified over
// ---------------------------------------------------------------------------------------

// The two lists below are exported, though `searchable` is what every consumer calls, because
// the check that keeps THEM honest cannot be written through the predicate: a group prefix that
// matches no directory, or an exclusion naming a sheet that has been moved, quietly stops doing
// anything and `searchable` still answers. The suite asserts against the library on both.

/** The library groups that answer "which design-type closes on this spec" — the amplifier and
 *  buffer classes. The others are left out deliberately, not by oversight: applications/ sheets
 *  TRANSLATE a spec into amplifier requirements (a settling budget becomes an OTA's GBW) rather
 *  than answering one, and mirrors-bias/ answer a different question in a different vocabulary. */
export const SEARCHABLE_GROUPS: readonly string[] = ['stages/', 'otas/', 'multistage/'];

/** Sheets inside those groups that are still not candidates. Neither is a biased design with a
 *  supply branch of its own — stage2-current-source-load is a composable leaf, and the sampling
 *  switch is a passive element between two nodes — so neither has a quiescent current to report
 *  or a design to close. */
export const NOT_SEARCHABLE: readonly string[] = [
  'multistage/stage2-current-source-load',
  'stages/sampling-switch',
];

/**
 * Whether a curated sheet is one the picker searches, by its library id (`group/name`, no
 * extension). ONE home for the curation: the app's candidate list, the library suite's
 * quiescent-current gate and the picker's own goldens all read this, so adding or excluding a
 * sheet moves all three together instead of drifting between hand-kept copies.
 *
 * The end-to-end suite deliberately recomputes the set from the filesystem instead — an
 * independent oracle is worth having precisely because it cannot inherit a mistake made here.
 */
export function searchable(path: string): boolean {
  return SEARCHABLE_GROUPS.some((g) => path.startsWith(g)) && !NOT_SEARCHABLE.includes(path);
}

// ---------------------------------------------------------------------------------------
// The spec vocabulary
// ---------------------------------------------------------------------------------------

/**
 * One field of the common spec vocabulary: the parameter NAME the library converged on, and
 * the unit that name means. Both halves are the match key, never the name alone.
 *
 * A name-only match is a silent-wrong-answer machine, and the library already contains the
 * proof: `vn_target` is a noise DENSITY (V/sqrt(Hz)) on the amplifier sheets and an integrated
 * RMS (V) on the sampling switch, so typing "20 nV/sqrt(Hz)" into a name-only picker applies a
 * budget thousands of times tighter than the sheet's own and reports the design as failing its
 * noise spec. Matching the pair turns that into a disclosure instead: the field lands in
 * `specIgnored` with the mismatch stated.
 */
export interface SpecField {
  readonly name: string;
  /** The unit string a sheet's param must declare for this field to apply to it. */
  readonly unit: string;
  /** What the field means, for the entry form's help text. */
  readonly note: string;
}

/**
 * The common spec vocabulary — the parameter names that recur across the amplifier sheets,
 * each with the one unit it resolves to. This is a VIEW of the library's authoring
 * convention, not a schema: adding a field here does nothing until sheets declare a `spec`
 * param under that name and unit, and a sheet is free to have none of them.
 *
 * `CM_dc` is deliberately absent. It is an operating point the engine solves around, not a
 * requirement a designer states; `CM_lo`/`CM_hi` are the spec. The consequence is worth
 * knowing: when a common-mode rule binds, the search cannot reach the parameter a designer
 * would move first, because the knob set is choice params only.
 */
export const SPEC_FIELDS = [
  { name: 'VDD', unit: 'V', note: 'supply voltage' },
  { name: 'CL', unit: 'F', note: 'load capacitance' },
  { name: 'Av_target', unit: 'V/V', note: 'required small-signal gain' },
  { name: 'GBW_target', unit: 'Hz', note: 'required gain-bandwidth product' },
  { name: 'SR_target', unit: 'V/s', note: 'required slew rate' },
  { name: 'vn_target', unit: 'V/sqrt(Hz)', note: 'input-referred noise density budget' },
  { name: 'vos_target', unit: 'V', note: 'input-referred offset budget (Pelgrom sigma)' },
  { name: 'PM_target', unit: 'deg', note: 'required phase margin' },
  { name: 'CM_lo', unit: 'V', note: 'lowest input common mode that must work' },
  { name: 'CM_hi', unit: 'V', note: 'highest input common mode that must work' },
] as const satisfies readonly SpecField[];

/** A name from the common spec vocabulary. */
export type SpecName = (typeof SPEC_FIELDS)[number]['name'];

/** The designer's spec: any subset of the vocabulary. An absent (or non-finite) field means
 *  "not my requirement" — the sheet keeps its authored default rather than being pushed to
 *  some neutral value the picker invented. */
export type PickerSpec = Partial<Record<SpecName, number>>;

/** A spec field the sheet had no use for, and the reason — ignorance is disclosed, never
 *  silent, because a candidate that consumed two of nine fields is answering a different
 *  question than the one that was asked. */
export interface SpecMismatch {
  name: string;
  reason: string;
}

// ---------------------------------------------------------------------------------------
// The result shape
// ---------------------------------------------------------------------------------------

/**
 * What happened to one candidate, in three states that must never be conflated:
 *
 * - `closed` — a feasible point was found (at the sheet's defaults, or by the search).
 * - `did-not-close` — there was a failing rule to search against, and no feasible point was
 *   reached inside the budget or the round cap. This is a statement about the SEARCH, never
 *   about the design. It INCLUDES the case where the budget admitted no search round at all —
 *   which is not an edge case: on a real PDK table one evaluation of a solved OTA costs
 *   ~180 ms, so a wall-clock budget can expire before a knob is scanned, and that is expected
 *   to be a common outcome there. `cause` always leads with what stopped the search, and any
 *   margin it quotes is labelled as belonging to the last point reached.
 * - `could-not-be-searched` — the search never got traction: the sheet is infeasible for a
 *   reason that is not a failing rule (an edge whose solve could not bracket, a structural
 *   error), so there is no margin to descend on. Reporting this as "did not close within N
 *   evaluations" would be the misleading half of an honest-sounding message.
 */
export type PickerVerdict = 'closed' | 'did-not-close' | 'could-not-be-searched';

/** One design-type's answer to the spec. */
export interface PickerCandidate {
  /** The library id of the sheet searched (`group/name`), exactly as the ref index keys it. */
  path: string;
  title: string;
  /** The library group (`otas`, `stages`, `multistage`) — the leading path segment. */
  group: string;
  verdict: PickerVerdict;
  /** Knob values the search MOVED, by param name — the sheet's own defaults are not
   *  repeated here, so this reads as "what had to change". */
  knobs: Record<string, number>;
  /** Moved knobs that ended sitting on their authored minimum. The value there is a bound on
   *  the SEARCH (the author's slider ran out), never a property of the design, and a consumer
   *  must qualify it as such — the same doctrine as `budgetExhausted`. */
  atRangeFloor: string[];
  /** Whether the reported `I_q` is bounded by the author's slider rather than by the design:
   *  some current-class knob sits on its authored minimum. Decided here, where the unit that
   *  marks a knob current-class is defined — a length knob on its own minimum says nothing about
   *  the supply current and must not qualify that number. Wider than `atRangeFloor`, which lists
   *  only knobs the search MOVED: a current the author already shipped at its minimum bounds the
   *  reported number just as hard, and the back-off has nothing left to do there. */
  currentAtRangeFloor: boolean;
  /** The worst hard-rule margin among the rules that COULD BE EVALUATED at the reported point,
   *  with the rule that owns it — defined whether or not anything fails, so a closed candidate
   *  still says how much room it has. A containment edge that did not run contributes no rules
   *  at all, so this number can look like a near miss on a point that cannot close; `cause` is
   *  where that is said. */
  worstMargin?: { id: string; marginPct: number };
  /** The worst FAILING hard rule at the reported point. Undefined on a closed candidate, and
   *  also on an infeasible one whose failure is not a rule — which is why `cause` exists. */
  bindingConstraint?: { id: string; marginPct: number };
  /** Why this candidate is not closed, in words, always present when it is not. It carries
   *  every fact that applies, joined by `; `: the binding constraint, any range end the design
   *  does not cover (named), the claimed range going unchecked because there was no design to
   *  check it against, any error-severity warning, and — when the search stopped rather than the
   *  design failing — what stopped it. These are ADDITIVE, not a first-match chain: a point with
   *  a failing rule AND a range end it does not cover cannot close no matter how much margin the
   *  rule is given, so naming only the rule sends the designer after the wrong thing. Never left
   *  blank next to a red verdict. */
  cause?: string;
  /** Quiescent supply current at the reported point, resolved by name from the evaluation —
   *  the sheet's `I_q` interface row, or its `I_q` param on the one topology that publishes the
   *  quantity as a parameter instead. Absent when the sheet does not publish one. */
  I_q?: number;
  /** Spec fields this sheet consumed, by name. */
  specApplied: string[];
  /** Spec fields this sheet had no use for, with the reason each was dropped. */
  specIgnored: SpecMismatch[];
  /** How much of what the designer typed this candidate actually answers. A candidate that
   *  consumed 1 of 9 supplied fields is not comparable with one that consumed 9, and a
   *  consumer must not rank them against each other on that basis. */
  specCoverage: { consumed: number; supplied: number };
  /** Full sheet evaluations charged to this candidate. On a sheet with containment edges one
   *  charged evaluation is (1 + edges) tree passes, so the wall clock, not this count, is the
   *  honest measure of effort there. It can exceed `budget.evalBudget` by one: the screening
   *  evaluation is not optional — a candidate the picker never evaluated has nothing to say —
   *  so it is charged rather than gated. */
  evals: number;
  /** Wall-clock spent, from the injected clock. Reads 0 when no clock was supplied. */
  elapsedMs: number;
  /** The budget this candidate was searched under, so a "did not close" is quotable with the
   *  numbers that bounded it. */
  budget: { evalBudget: number; msBudget: number };
  /** Whether a budget ran out during the search (as opposed to closing, stalling, or reaching
   *  the round cap). `cause` states it in words; this is the flag to branch on. */
  budgetExhausted: boolean;
}

// ---------------------------------------------------------------------------------------
// Options and the budget meter
// ---------------------------------------------------------------------------------------

/**
 * Per-sheet wall-clock cap for the interactive default. Chosen against the measured cost
 * spread rather than a round number: one evaluation of a solved, edge-bearing OTA costs
 * ~0.1 ms on a small table and ~180 ms on a real PDK table, a spread wide enough that any
 * fixed evaluation count is either wasteful on the cheap sheets or an eleven-second stall on
 * the expensive ones. A time cap equalizes effort instead of equalizing counts.
 */
export const PICKER_MS_BUDGET = 1500;

/** Per-sheet evaluation cap — the backstop that keeps the search bounded when no clock is
 *  supplied, and the ONLY budget a test should set, because it is the machine-independent
 *  one. Sized to allow roughly five full rounds on the library's widest sheets. */
export const PICKER_EVAL_BUDGET = 200;

/** How many rounds of "pick a knob, scan it, move" the repair stage may take. A cap rather
 *  than a convergence test: coordinate descent on a multi-rule tree can cycle (closing one
 *  margin opens another), and a bounded search that reports its bound is preferable to one
 *  that decides for itself when it is finished. */
const PICKER_ROUND_CAP = 8;

/** Samples per knob scan. The scan spans the knob's WHOLE authored range, so this is a
 *  resolution, not a neighbourhood: the measured failure mode of a local probe is a knob whose
 *  margin is flat nearby and only moves after a 5x change, which a short step never reaches. */
const PICKER_SCAN_POINTS = 7;

/** Bisection steps in the current back-off, after the one probe at the floor. Six halvings
 *  resolve the scale factor to under 2% of the range they start from — finer than the
 *  authored slider granularity the answer is reported against. */
const PICKER_BISECT_STEPS = 6;

/** The unit that marks a knob as current-class, for the back-off stage and for the report of
 *  whether the current landed on the author's floor. */
const CURRENT_UNIT = 'A';

/** How close to its authored minimum a moved knob counts as sitting ON it, as a fraction of the
 *  slider range. The bisection lands on the floor by arithmetic rather than by assignment, so an
 *  exact comparison would miss it by one ulp. */
const AT_FLOOR_EPS = 1e-9;

export interface PickerOptions {
  /** By-reference child index, exactly as `runSheet` takes it. */
  refs?: SheetRefIndex;
  /** Per-sheet wall-clock cap, honoured only when `now` is supplied. */
  msBudget?: number;
  /** Per-sheet evaluation cap. */
  evalBudget?: number;
  /**
   * The clock the wall-clock budget reads. The core owns no clock — a module that called
   * `Date.now` itself would make its own results machine-dependent and untestable — so the
   * caller decides what time is: `() => Date.now()` in the app, absent in tests.
   *
   * With no clock, time stands at 0 and `elapsedMs` reads 0, so a POSITIVE `msBudget` is never
   * enforced. A budget of 0 (or less) is, and blocks the search outright: zero elapsed is not
   * inside a zero cap. That is the honest reading of "no time at all", not a special case — but
   * it means a clockless caller asking for a zero time budget gets one screening evaluation and
   * nothing else, rather than an unbounded search.
   */
  now?: () => number;
}

/** The running cost of one sheet's search. */
interface Meter {
  evals: number;
  exhausted: boolean;
  readonly evalBudget: number;
  readonly msBudget: number;
  readonly started: number;
  readonly clock: () => number;
}

/** Whether `n` more evaluations fit in what is left. Asks without answering for the
 *  consequence — a caller with a cheaper plan B is not starved just because plan A did not
 *  fit. */
function fits(m: Meter, n: number): boolean {
  return m.evals + n <= m.evalBudget && m.clock() - m.started < m.msBudget;
}

/** `fits`, and marks the meter exhausted when it does not — for the calls where not fitting IS
 *  the end of the search, so that the decision to stop and the reason it stopped are one fact. */
function afford(m: Meter, n: number): boolean {
  if (fits(m, n)) return true;
  m.exhausted = true;
  return false;
}

// ---------------------------------------------------------------------------------------
// Scoring: one objective, two readings of it
// ---------------------------------------------------------------------------------------

/**
 * The search's objective: the WORST hard-rule relative margin anywhere in the tree, including
 * the containment edges. Bigger is better; feasible points land at or above zero.
 *
 * Descending on the currently-binding rule alone is what makes a multi-rule search chase its
 * own tail, and descending on the top sheet's rules alone is worse than that — the measured
 * case is an OTA whose interior rules all pass while the failure sits in an edge, where a
 * search reading only the interior improves a number that was never the problem and looks
 * like it is succeeding.
 *
 * An edge that was CHECKED and could not run reads the floor rather than being skipped, for the
 * same reason: a point whose claimed range check broke down is not a good point, whatever the
 * rules that did evaluate say about it. That has a consequence worth stating, because it looks
 * wrong from outside: on a sheet whose edge cannot bracket, EVERY such point reads the same
 * floor, so the search will trade a named margin away to reach a point where the edge stands —
 * and the candidate can end up worse on the rule it names than the sheet's own defaults were.
 * It is still the right trade: a range end that cannot be checked gates the sheet, so a point
 * carrying one can never close, however comfortable its other margins look.
 *
 * An edge that was never checked is a different case and must not read the floor. Coverage is
 * skipped exactly where the evaluation produced no design to check, so flooring it would flatten
 * the objective across the whole region whose centres fail — on `current-mirror-ota` that is
 * every `CM_dc` above about 1.12 of an authored [0.7, 1.3], a third of one slider, and the same
 * ceiling sits on the telescopic, folded and gain-boosted sheets — and the descent would have no
 * gradient to follow out of precisely the region it exists to escape.
 *
 * So a point with no design is still ordered by its own worst margin, but inside a BAND of its
 * own, strictly below every score a real design can reach (see `noDesign`). Both halves matter.
 * Without the ordering the search cannot climb out; without the band it climbs the wrong way — a
 * margin read off a bracket-end probe is not smaller than a real design's worst margin, so a bare
 * score lets the search trade a design it has for one that does not exist, and then report the
 * phantom's numbers. Nothing else distinguishes the two: `beats` compares feasibility first, and
 * neither kind of point is feasible.
 *
 * The objective therefore has three tiers, in this order: a design, however badly it scores; a
 * design whose claimed range check broke down (the floor, -MARGIN_PCT_CAP); and no design (the
 * band below that, ordered within itself). The middle tier outranking the bottom one is
 * deliberate — a design that exists but could not have its range checked is still something a
 * designer can work with, and a point that evaluated to nothing is not.
 *
 * "No design here" is read from the SKIPPED RANGE CHECK, not from the standing predicate, and the
 * difference is load-bearing rather than a shortcut. The two readings of this objective are
 * compared against each other, and a sweep sample carries no standing flag — only what the
 * evaluation reported. A skipped range check is the one form of "this did not evaluate" both
 * readings can see, so keeping them on that fact is what stops them disagreeing: here it is an
 * absent `covers`, and in a sweep the same absence per sample. On a sheet claiming no range
 * neither can see anything, and both leave the score alone, exactly as before.
 */
function scoreResult(res: SheetResult): number {
  const edges = res.edges ?? [];
  if (edges.some(edgeBroke)) return -MARGIN_PCT_CAP;
  const worst = limitingConstraint(res);
  const s =
    worst === undefined ? (res.feasible ? 0 : -MARGIN_PCT_CAP) : clampMargin(worst.marginPct);
  return edges.length > 0 && res.covers === undefined ? noDesign(s) : s;
}

/** One score demoted into the no-design band: ordered among its own kind, and below everything
 *  else. `clampMargin` bounds a real score to ±MARGIN_PCT_CAP, so this lands in
 *  [-2.5, -1.5]·MARGIN_PCT_CAP — under the floor a standing point can reach, monotone in `s`. */
function noDesign(s: number): number {
  return -2 * MARGIN_PCT_CAP + s / 2;
}

/**
 * The same objective read off one sample of a sweep. The sweep carries every hard rule in the
 * tree plus one aggregate curve per containment edge (which already reads the floor when the
 * edge could not run), so the minimum over those is the same number `scoreResult` computes
 * from a full result — deliberately, since the search compares the two against each other.
 *
 * Admissibility is the core's own `measurable`, read off the two fields a sweep row carries: a
 * rule parked on its own boundary by construction reads zero forever and would otherwise be the
 * minimum forever, hiding every rule that can actually move.
 *
 * Taking a MINIMUM over the whole sweep, rather than looking one rule up in it, is also what
 * keeps the search clear of the two id namespaces: a sweep names containment edges by the edge
 * alone (`cm-lo@`) while a result names them per rule (`cm-lo@offset-spec`), so an id carried
 * from one to the other would silently miss. Every id the picker REPORTS comes from a full
 * result, never from a sweep.
 *
 * "This sample produced no design" is not inferred from the curves: the sweep forwards each
 * sample's own coverage answer (`SheetSweep.covers`), so both readings key off the one field the
 * evaluation produced. They have to agree, because the search compares one against the other — an
 * incumbent scored from a full result against a move scored from a sweep.
 */
function scoreSample(sw: SheetSweep, i: number): number {
  let worst = Infinity;
  for (const r of sw.rules) {
    // `m === null` is not redundant against `measurable`: TypeScript needs it to narrow.
    const m = r.marginPct[i];
    if (m === null || !measurable(r.kind, m)) continue;
    if (m < worst) worst = m;
  }
  const s = worst === Infinity ? (sw.feasible[i] ? 0 : -MARGIN_PCT_CAP) : clampMargin(worst);
  return sw.covers?.[i] === null ? noDesign(s) : s;
}

/** Whether `(feasible, score)` beats the incumbent, feasibility first. Strict, so the first
 *  of equal samples wins and the scan's answer does not depend on iteration order. */
function beats(f: boolean, s: number, bf: boolean, bs: number): boolean {
  if (f !== bf) return f;
  return s > bs;
}

// ---------------------------------------------------------------------------------------
// Naming the cause
// ---------------------------------------------------------------------------------------

/**
 * Why this evaluation is not feasible, in words — EVERY reason that applies, not the first one
 * found. A failing rule names itself; a containment edge that could not run is named too; so is
 * an error-severity warning; and when none of them applies the last resort states the situation
 * rather than inventing a cause. Never returns a blank — an empty cause beside a red verdict
 * reads as a defect in the tool.
 *
 * Additive rather than first-match, because the combination is the case that misleads. A point
 * carrying a failing rule AND a range end it does not cover reports, under a first-match chain,
 * a rule missing by some tractable-looking percentage — and a designer who goes and buys that
 * margin still cannot close, because the range end gates the sheet whatever the rules say. The
 * engine knows that (the search scores such a point at the floor); the candidate has to say it.
 */
function causeOf(res: SheetResult): string {
  const parts: string[] = [];
  const b = bindingConstraint(res);
  if (b) parts.push(`${b.id} fails by ${(b.marginPct * 100).toFixed(1)}%`);
  const skipped: string[] = [];
  for (const e of res.edges ?? []) {
    if (e.state === 'not-checked') skipped.push(`"${e.name}"`);
    else if (e.error !== undefined)
      // A checked range end fails in two quite different ways, and only one of them is a verdict
      // about the design. Usually the endpoint run itself failed — the design was measured and
      // could not hold there — which deserves saying so plainly, because "the edge could not be
      // evaluated" reads as a gap in the tool and sends a designer looking for a setting to fix.
      // But an edge whose OVERRIDE never resolved (a name that is not in scope) measured nothing
      // at all, and claiming the design misses its range there would be inventing a result. That
      // case is told apart by the run's own warnings being empty: an endpoint failure draws its
      // message out of an error-severity warning, so it always leaves one behind, while the
      // override failure returns before anything is evaluated. Its message already names the
      // edge and says what did not resolve, so it stands alone rather than being wrapped.
      parts.push(
        e.rules.length === 0 && e.warnings.length === 0
          ? e.error
          : `the design stops covering its claimed range at "${e.name}": ${e.error}`,
      );
  }
  // One clause for all the skipped edges, not one apiece: they are skipped for a single shared
  // reason, and repeating it per edge would read as several findings where there is one. Said at
  // all — rather than left as a silence — because a reader who sees no edge finding beside a red
  // verdict would take the claimed range as checked and holding, which is the one thing it is
  // not.
  if (skipped.length)
    parts.push(
      `the claimed range was not checked (${skipped.join(', ')}): there is no design at this ` +
        `point to check it against`,
    );
  const w = res.warnings.find((x) => x.severity === 'error');
  if (w) parts.push(w.message);
  return parts.length > 0 ? parts.join('; ') : 'infeasible with no failing rule';
}

// ---------------------------------------------------------------------------------------
// Stage 0 — apply the spec
// ---------------------------------------------------------------------------------------

/**
 * Which of the designer's fields this sheet can consume, decided from the SHEET'S OWN params
 * rather than from whether an override appeared to land: `withParams` silently drops a name
 * the sheet does not have, so trusting it would make the coverage report agree with itself
 * instead of with the document.
 *
 * The overrides ARE the applied list — `Object.keys(over)`, in vocabulary order — so there is
 * one account of what was consumed rather than two accumulators to keep in step.
 */
function applySpec(
  doc: SheetDoc,
  spec: PickerSpec,
): { ignored: SpecMismatch[]; over: Record<string, number> } {
  const ignored: SpecMismatch[] = [];
  const over: Record<string, number> = {};
  for (const field of SPEC_FIELDS) {
    const value = spec[field.name];
    if (value === undefined || !Number.isFinite(value)) continue;
    const p = doc.params.find((q) => q.name === field.name);
    if (!p) {
      ignored.push({ name: field.name, reason: `this sheet has no "${field.name}" parameter` });
    } else if ((p.unit ?? '') !== field.unit) {
      ignored.push({
        name: field.name,
        reason:
          `this sheet's "${field.name}" is in ${p.unit ? p.unit : 'no declared unit'}, ` +
          `not ${field.unit} — the same name for a different quantity`,
      });
    } else if (p.role === undefined) {
      // Not the same statement as "it is a knob": the sheet said nothing, and `knobsOf` will
      // not treat it as a knob either, so claiming it is one would contradict the other half
      // of the same candidate.
      ignored.push({
        name: field.name,
        reason:
          `this sheet's "${field.name}" declares no role, so the picker cannot tell whether it ` +
          `is a requirement to set or a value the sheet chooses for itself`,
      });
    } else if (p.role !== 'spec') {
      ignored.push({
        name: field.name,
        reason: `"${field.name}" is an implementation knob on this sheet, not a stated requirement`,
      });
    } else if (engineSolved(p)) {
      ignored.push({
        name: field.name,
        reason: `the engine solves "${field.name}" on this sheet, so it is not free to set`,
      });
    } else {
      over[field.name] = value;
    }
  }
  // A field the vocabulary does not carry is disclosed too. TypeScript blocks it at this
  // module's own boundary, but the spec arrives from an entry form and from persisted layout,
  // neither of which the type system reaches.
  const vocabulary = new Set<string>(SPEC_FIELDS.map((f) => f.name));
  for (const name of Object.keys(spec).sort()) {
    if (vocabulary.has(name)) continue;
    ignored.push({
      name,
      reason: `"${name}" is not one of the spec fields this picker knows how to apply`,
    });
  }
  return { ignored, over };
}

/** The knobs the search may move: the author's implementation choices (`choiceKnobs`, the same
 *  set the sensitivity readout ranks — so the ranking and the scan can never disagree about
 *  what is in play) narrowed to those with a finite slider range to scan across. */
function knobsOf(doc: SheetDoc): Knob[] {
  return choiceKnobs(doc).filter((p): p is Knob => sweepable(p));
}

/** A knob is a param with a finite authored range — the guarantee `sweepable` states, carried
 *  in the type so the search can read `min`/`max` without re-proving it at every site. */
type Knob = SheetVar & { min: number; max: number };

// ---------------------------------------------------------------------------------------
// Stage 1 — repair an infeasible sheet
// ---------------------------------------------------------------------------------------

/**
 * Rank the knobs the readout can score by how strongly each moves the rule that currently
 * binds, best first — or return no ranking at all when it has no signal to give.
 *
 * The statistic is the margin change at the readout's own 1%-of-value step, NOT the slope.
 * The slope is margin per SI unit and the library's knobs span currents (1e-5), lengths
 * (1e-7) and inversion coefficients (1e1), so ranking by slope ranks by unit and reliably
 * picks a length; measured on the five-transistor OTA, the top-slope knob is 2.5x WEAKER per
 * equal relative move than the one the step-based statistic picks.
 *
 * No signal is a normal outcome, not an error: the readout refuses to differentiate around a
 * point where some containment edge did not stand, which is exactly the sheet class the repair
 * stage exists for. The caller falls back to scanning every knob — sensitivity is an
 * accelerator here, never a dependency.
 *
 * The returned list holds ONLY the knobs that were scored, never the unscored ones sorted to the
 * end. That is load-bearing for the caller's ranking cache, not tidiness: the cache hands back
 * the list minus what has been tried, so a remainder that is empty has to mean "nothing here has
 * signal" — the case that must fall through to the breadth scan. Padding the list with unscored
 * knobs would make the cached round descend on a knob a fresh ranking would have refused.
 */
function rankKnobs(
  doc: SheetDoc,
  knobs: readonly Knob[],
  target: string | undefined,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  refs: SheetRefIndex | undefined,
): { ranked?: Knob[]; evals: number } {
  if (target === undefined) return { evals: 0 };
  const sens = sheetSensitivities(doc, table, resolveDevice, {
    refs,
    params: knobs.map((k) => k.name),
    // Containment edges are re-run per probe only when the rule in question lives on one;
    // passing the id through is what keeps an edge-keyed target measurable at all.
    rule: target,
  });
  // Charge what was spent, not what was reserved: a knob the readout refused (its step reads
  // NaN) cost no probes, and a readout that refused the whole sheet cost only its base
  // evaluation. Over-charging would make a budget report describe work never done. One
  // residual, not worth string-matching an error message to close: a readout that refused
  // because the DOC does not validate returns before evaluating anything, and is charged 1.
  const evals = 1 + 2 * sens.filter((s) => Number.isFinite(s.step)).length;
  const strength = new Map<string, number>();
  for (const s of sens) {
    const r = s.rules.find((x) => x.id === target);
    if (!r) continue;
    const up = Number.isFinite(r.deltaPlus) ? r.deltaPlus : -Infinity;
    const down = Number.isFinite(r.deltaMinus) ? r.deltaMinus : -Infinity;
    const best = Math.max(up, down);
    if (best > -Infinity) strength.set(s.param, best);
  }
  if (strength.size === 0) return { evals };
  // Only the knobs the readout SCORED: one it gave no signal for is not ranked last, it is not
  // ranked at all, so a caller left holding only those falls through to a breadth scan instead
  // of descending on whatever sorted to the end. Stable sort over the knobs in document order,
  // so ties resolve the way the author wrote them rather than by whatever order the readout
  // happened to return.
  const of = (k: Knob): number => strength.get(k.name) ?? -Infinity;
  const ranked: Knob[] = knobs.filter((k) => strength.has(k.name)).sort((a, b) => of(b) - of(a));
  return { ranked, evals };
}

/** The best sample of one knob scan: feasibility first, then the objective, first-wins on
 *  ties. Returns `undefined` for an empty sweep (a knob the sweep refused). */
function bestSample(sw: SheetSweep): { x: number; feasible: boolean; score: number } | undefined {
  let best: { x: number; feasible: boolean; score: number } | undefined;
  for (let i = 0; i < sw.x.length; i++) {
    const f = sw.feasible[i];
    const s = scoreSample(sw, i);
    if (!best || beats(f, s, best.feasible, best.score))
      best = { x: sw.x[i], feasible: f, score: s };
  }
  return best;
}

interface RepairOutcome {
  doc: SheetDoc;
  res: SheetResult;
  /** Set whenever the search stopped without closing — the budget, the round cap, or nothing
   *  left to try — so a "did not close" is never a bare margin the reader could mistake for a
   *  property of the design. Absent only when the search closed. */
  stopped?: string;
}

/**
 * Bounded coordinate descent on the worst hard margin: rank the knobs against the binding
 * rule, scan the best one across its whole authored range with the existing sweep, move to the
 * best sample, repeat.
 *
 * The scan rather than a step is the load-bearing choice. A derivative says which way to lean;
 * it does not say how far, and several of the library's knobs are flat for a factor of five
 * before they bite. One sweep is seven evaluations and returns the whole 1-D landscape —
 * feasibility included — so it is strictly more information than a short probe for the same
 * cost, and it is immune to the plateaus that make the derivative pick nothing.
 *
 * A knob that was scanned without improving is not re-scanned until the point moves: the
 * ranking is a function of the point, so re-ranking at an unchanged point would return the
 * same knob and burn the round cap on one knob. That the ranking is a function of the point is
 * also what lets it be kept and reused while the point holds, instead of being bought twice.
 */
function repair(
  doc0: SheetDoc,
  res0: SheetResult,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  refs: SheetRefIndex | undefined,
  meter: Meter,
): RepairOutcome {
  let doc = doc0;
  let res = res0;
  let score = scoreResult(res0);
  const tried = new Set<string>();
  /** The ranking, kept beside the point it was ranked AT. The readout is deterministic and
   *  per-knob independent, so while the point holds, every strength a fresh ranking would
   *  return is one this list already carries — which is why re-ranking an unmoved point costs
   *  ZERO evaluations here, and why a round that scanned without finding a move leaves the
   *  budget for depth instead of spending it on numbers already in hand. Dropped the moment a
   *  move lands, because the ranking is a statement about the point it was taken at. */
  let ranked: Knob[] | undefined;
  /** Whether any knob was actually scanned — i.e. whether any alternative design point was
   *  ever evaluated. A ranking pass on its own does not count: it measures the point the sheet
   *  already sits on, so a budget that bought only that has looked at nothing new. */
  let scanned = false;
  /** The budget stop, phrased for what it interrupted. Set only on a budget exit, so a caller
   *  can tell "the budget stopped this" from "the search ran out of ideas". */
  const starved = (): RepairOutcome => {
    const limits = `the limits were ${meter.evalBudget} evaluations and ${meter.msBudget} ms`;
    return {
      doc,
      res,
      stopped: scanned
        ? `the search stopped when its budget ran out, after ${meter.evals} evaluations (${limits})`
        : `the budget admitted no search round — no knob was ever scanned, so no design point ` +
          `other than the sheet's own was tried (${limits})`,
    };
  };

  for (let round = 0; round < PICKER_ROUND_CAP; round++) {
    const knobs = knobsOf(doc).filter((k) => !tried.has(k.name));
    if (knobs.length === 0) {
      return {
        doc,
        res,
        stopped: 'the search ran out of knobs — every one was scanned without gain',
      };
    }
    let candidates: readonly Knob[] = knobs;
    const left = ranked?.filter((k) => !tried.has(k.name));
    if (left !== undefined) {
      // The point has not moved, so the ranking it already carries still holds: filtering that
      // by the tried set is the same answer as re-ranking the survivors — the sort key is
      // per-knob and the sort is stable, so their relative order is unchanged — for no
      // evaluations at all. An empty remainder means every knob the readout could score has
      // been scanned, which is the no-signal case: drop to breadth rather than pay a ranking to
      // rediscover it.
      if (left.length > 0) candidates = [left[0]];
    } else if (fits(meter, 1 + 2 * knobs.length)) {
      // The readout costs a base evaluation plus two probes per knob at worst. When that worst
      // case does not fit, the round falls back to breadth rather than ending the search: on a
      // real PDK table one evaluation costs ~180 ms, so a wall-clock budget routinely affords a
      // scan but not a ranking, and spending the remainder on an unranked scan beats spending
      // it on nothing. `fits`, not `afford`, so a plan that did not fit does not declare the
      // meter spent while plan B still can be paid for.
      const rank = rankKnobs(doc, knobs, limitingConstraint(res)?.id, table, resolveDevice, refs);
      meter.evals += rank.evals;
      ranked = rank.ranked;
      // With a ranking, one knob per round is enough and the rest of the budget goes into
      // depth; without one, breadth is all that is left, so every knob gets scanned.
      if (rank.ranked) candidates = [rank.ranked[0]];
    }

    let move: { name: string; x: number; feasible: boolean; score: number } | undefined;
    for (const k of candidates) {
      if (!afford(meter, PICKER_SCAN_POINTS)) break;
      const sw = sweepSheet(doc, k.name, table, PICKER_SCAN_POINTS, resolveDevice, refs);
      meter.evals += sw.x.length; // what the sweep actually evaluated, not what it was asked for
      scanned = scanned || sw.x.length > 0;
      tried.add(k.name);
      const b = bestSample(sw);
      // A "move" back onto the value we are already at is not a move: accepting one would
      // clear the tried set and re-rank at an unchanged point, spending the round cap in a
      // circle. The two scores are computed by different readings of the same objective, so
      // this guards the float-noise case rather than a real preference.
      if (b && b.x === k.value) continue;
      if (b && (!move || beats(b.feasible, b.score, move.feasible, move.score))) {
        move = { name: k.name, ...b };
      }
    }

    if (!move || !beats(move.feasible, move.score, res.feasible, score)) {
      if (meter.exhausted) return starved();
      continue; // this knob had nothing; the next round takes the next one down the ranking
    }
    if (!afford(meter, 1)) return starved();
    doc = withParams(doc, { [move.name]: move.x });
    res = runSheet(doc, table, resolveDevice, refs);
    meter.evals += 1;
    score = scoreResult(res);
    tried.clear();
    ranked = undefined; // the point moved; the ranking was about where it was
    if (res.feasible) return { doc, res };
  }
  return {
    doc,
    res,
    stopped: `the search reached its cap of ${PICKER_ROUND_CAP} rounds without closing`,
  };
}

// ---------------------------------------------------------------------------------------
// Stage 2 — back the current off
// ---------------------------------------------------------------------------------------

/**
 * Scale every current-class knob down together by one factor, bisected to the smallest factor
 * that still closes — the designer's own move, and the only thing that gives a current column
 * any content beyond "what the author happened to ship".
 *
 * ONE factor rather than one knob at a time, for two reasons. Backing knobs off individually
 * is order-dependent (I1-then-I2 and I2-then-I1 are both deterministic and different), and it
 * breaks the topology's own branch ratios — a folded cascode requires its fold branch to carry
 * more than half the tail, so driving one to its floor while the other holds is not a smaller
 * version of the same design.
 *
 * The floor is the largest ratio any knob needs to stay inside its authored range, so no knob
 * is ever clamped and the authored ratios survive the whole bisection exactly.
 *
 * A point where the design becomes infeasible with no failing rule to name — the signature of
 * a pin whose bracket no longer straddles its target — STOPS the back-off with the last
 * feasible point kept. It is not an error: the sheet was feasible where we left it, and a
 * search that cannot see past a bracket miss should say less, not throw.
 */
function backOff(
  doc0: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  refs: SheetRefIndex | undefined,
  meter: Meter,
): { doc: SheetDoc; res?: SheetResult } {
  const knobs = knobsOf(doc0).filter((k) => k.unit === CURRENT_UNIT && k.value > 0);
  if (knobs.length === 0) return { doc: doc0 };
  const floor = Math.max(...knobs.map((k) => k.min / k.value));
  if (!(floor < 1)) return { doc: doc0 };

  const scaled = (s: number): SheetDoc =>
    withParams(doc0, Object.fromEntries(knobs.map((k) => [k.name, k.value * s])));

  let lo = floor; // probed below, and infeasible by the time the bisection starts
  let hi = 1; // known feasible: the caller only calls this on a closed point
  let best: { doc: SheetDoc; res: SheetResult } | undefined;

  // Try the floor first. Several sheets ride all the way down to it, and finding that in one
  // evaluation is worth more than the bisection it saves.
  if (!afford(meter, 1)) return { doc: doc0 };
  const atFloor = runSheet(scaled(floor), table, resolveDevice, refs);
  meter.evals += 1;
  if (atFloor.feasible) return { doc: scaled(floor), res: atFloor };
  if (bindingConstraint(atFloor) === undefined) return { doc: doc0 };

  for (let i = 0; i < PICKER_BISECT_STEPS; i++) {
    if (!afford(meter, 1)) break;
    const mid = (lo + hi) / 2;
    const res = runSheet(scaled(mid), table, resolveDevice, refs);
    meter.evals += 1;
    if (res.feasible) {
      hi = mid;
      best = { doc: scaled(mid), res };
    } else {
      // A failure with no rule to name is a solve that stopped standing, not a design that
      // ran out of current; bisecting further would be bisecting noise.
      if (bindingConstraint(res) === undefined) break;
      lo = mid;
    }
  }
  return best ?? { doc: doc0 };
}

// ---------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------

/**
 * Search ONE sheet against the spec. The only entry point, because the search is per-sheet by
 * construction — each candidate carries its own budget — so a caller drains its own sheet list
 * and renders each candidate on arrival (a chunked queue on the main thread, say), with no
 * streaming machinery in the core and no collect-all wrapper hiding the loop.
 *
 * The results carry NO ordering opinion of their own: which candidate is "best" depends on what
 * the designer is short of, so ranking is a separate step (`rankCandidates`) a consumer opts
 * into. Which sheets are offered at all is likewise the caller's (see `searchable`).
 */
export function pickTopology(
  spec: PickerSpec,
  sheet: SheetRefEntry,
  table?: DeviceTable,
  resolveDevice?: DeviceResolver,
  opts: PickerOptions = {},
): PickerCandidate {
  const clock = opts.now ?? (() => 0);
  const meter: Meter = {
    evals: 0,
    exhausted: false,
    evalBudget: opts.evalBudget ?? PICKER_EVAL_BUDGET,
    msBudget: opts.msBudget ?? PICKER_MS_BUDGET,
    started: clock(),
    clock,
  };
  const refs = opts.refs;

  // Clone before overriding: a library doc is shared by every candidate in the run, and the
  // search must not leave a mark on it.
  const base = cloneDoc(sheet.doc);
  const { ignored, over } = applySpec(base, spec);
  const applied = Object.keys(over);
  const supplied = SPEC_FIELDS.filter((f) => {
    const v = spec[f.name];
    return v !== undefined && Number.isFinite(v);
  }).length;
  const start = withParams(base, over);
  const defaults = new Map(start.params.map((p) => [p.name, p.value]));

  const res0 = runSheet(start, table, resolveDevice, refs);
  meter.evals += 1;

  let doc = start;
  let res = res0;
  let verdict: PickerVerdict;
  /** Why the search stopped, when that is a fact in its own right — the whole answer for a
   *  sheet that could not be searched, an addendum to the binding constraint for one that was. */
  let stopNote: string | undefined;

  if (res0.feasible) {
    verdict = 'closed';
  } else if (bindingConstraint(res0) === undefined) {
    // Nothing failing to descend on. The interior rules that DO evaluate are all passing here,
    // so a search would improve a number that was never the problem and report progress.
    // No stop note: `causeOf` already carries the whole answer for this one.
    verdict = 'could-not-be-searched';
  } else if (knobsOf(start).length === 0) {
    verdict = 'could-not-be-searched';
    stopNote = 'this sheet has no adjustable design knobs with a finite range';
  } else {
    const out = repair(start, res0, table, resolveDevice, refs, meter);
    doc = out.doc;
    res = out.res;
    stopNote = out.stopped;
    verdict = res.feasible ? 'closed' : 'did-not-close';
  }

  if (res.feasible && !meter.exhausted) {
    const relaxed = backOff(doc, table, resolveDevice, refs, meter);
    if (relaxed.res) {
      doc = relaxed.doc;
      res = relaxed.res;
    }
  }

  const onFloor = (k: SheetVar & { min: number; max: number }): boolean =>
    k.value - k.min <= AT_FLOOR_EPS * (k.max - k.min);

  const knobs: Record<string, number> = {};
  const atRangeFloor: string[] = [];
  for (const p of doc.params) {
    if (p.value === defaults.get(p.name)) continue;
    knobs[p.name] = p.value;
    if (sweepable(p) && onFloor(p as Knob)) atRangeFloor.push(p.name);
  }
  // Over EVERY current-class knob, not only the ones that moved. A sheet shipping a current
  // already at its authored minimum leaves the back-off nothing to do — the floor ratio is 1,
  // so it returns without scaling anything — and yet that current is exactly as slider-bounded
  // as one the search drove down to the same place. No sheet in the library ships that way
  // today, so this is a case kept honest rather than one anyone can currently see.
  const currentAtRangeFloor = knobsOf(doc).some((k) => k.unit === CURRENT_UNIT && onFloor(k));

  // Why this is not closed, in an order that cannot be misread. The STOP comes first, because
  // a margin quoted at the point a search was cut off is an artifact of the cut, not a property
  // of the design: the same sheet and the same spec were measured swinging from -42% to -166%
  // purely by moving the budget. Leading with the number invites a designer to go and buy it.
  // The margin follows, explicitly labelled as belonging to the last point the search reached.
  //
  // Nothing is ever dropped in any branch — only the framing differs, and it differs because a
  // sheet that was never searched has no "last point searched" to speak of.
  let cause: string | undefined;
  if (!res.feasible) {
    const found = causeOf(res);
    if (stopNote === undefined) cause = found;
    else if (verdict === 'did-not-close')
      cause = `${stopNote}; at the last point searched, ${found}`;
    else cause = `${stopNote}; ${found}`;
  }

  const worst = limitingConstraint(res);
  const binding = bindingConstraint(res);
  const iq = res.values['I_q'];
  return {
    path: sheet.path,
    title: doc.title,
    group: sheet.path.includes('/') ? sheet.path.slice(0, sheet.path.indexOf('/')) : '',
    verdict,
    knobs,
    atRangeFloor,
    currentAtRangeFloor,
    ...(worst === undefined ? {} : { worstMargin: worst }),
    ...(binding === undefined ? {} : { bindingConstraint: binding }),
    ...(cause === undefined ? {} : { cause }),
    ...(Number.isFinite(iq) ? { I_q: iq } : {}),
    specApplied: applied,
    specIgnored: ignored,
    specCoverage: { consumed: applied.length, supplied },
    evals: meter.evals,
    elapsedMs: clock() - meter.started,
    budget: { evalBudget: meter.evalBudget, msBudget: meter.msBudget },
    budgetExhausted: meter.exhausted,
  };
}

// ---------------------------------------------------------------------------------------
// Reading the results: the ordering, and the honesty rules that constrain it
// ---------------------------------------------------------------------------------------

/** What a consumer may rank candidates by. Both keys are properties of the reported point, and
 *  neither is a quality score — "best" depends on what the designer is short of. */
export type PickerSortKey = 'margin' | 'current';

/**
 * Whether `worstMargin` speaks for this candidate, or is a comfortable-looking number on a
 * design that cannot close. The field covers the rules that COULD be evaluated at the reported
 * point, so on a sheet made infeasible by something no rule measures — a containment edge whose
 * solve could not bracket — it reads as a pass on a point that gates the sheet. That class is
 * exactly the one with no binding constraint.
 *
 * The predicate ships beside the hazard its doc comment describes, rather than being
 * re-derived from two other fields by every surface that shows the number.
 */
export const marginSpeaksFor = (c: PickerCandidate): boolean =>
  c.verdict === 'closed' || c.bindingConstraint !== undefined;

/** A ranked reading of one run's candidates. */
export interface PickerRanking {
  /** The comparable candidates, best first under `sortKey`. */
  ranked: PickerCandidate[];
  /** The rest — the ones answering a smaller question — alphabetically, carrying no ranking
   *  claim of any kind. */
  other: PickerCandidate[];
  /** How many supplied fields a candidate had to consume to be ranked. */
  threshold: number;
  /** How many fields the designer supplied, as the candidates themselves report it. */
  supplied: number;
}

/**
 * Split and order one run's candidates, with the two honesty rules that go with showing results
 * in a row.
 *
 * A candidate that consumed fewer than two of the fields the designer actually supplied is
 * answering a different question, so it is PARTITIONED OUT rather than ranked: a source follower
 * that consumed only VDD has no business sitting above a two-stage OTA that met the gain and the
 * bandwidth as well. The threshold degrades with the spec — with one field supplied, consuming
 * that one IS full coverage, and with none supplied there is nothing to be short of.
 *
 * Infeasible candidates sit below feasible ones whatever the key: what failed and why is worth
 * reading, but it is not a ranking against designs that closed. Ties — and two candidates that
 * both LACK the key — break by title, so the table never reshuffles rows the sort has no opinion
 * about, and the comparator stays transitive when only one side lacks the key (the subtraction is
 * then ±Infinity, which is a real answer: the sheet with no published value sorts last).
 *
 * The margin key is read through `marginSpeaksFor`, and that is not a detail: a candidate gated
 * by something no rule measures typically has a COMFORTABLE margin (its interior rules all pass),
 * so a comparator reading the number directly floats exactly the rows whose margin cell prints
 * "—" to the top of the failures, above genuine near misses. Position in a sorted table is a
 * presentation of the key, so a margin no surface may print is a margin the order may not use
 * either; such a candidate has no value for this key and sorts last, like a sheet with no I_q.
 */
export function rankCandidates(
  results: readonly PickerCandidate[],
  sortKey: PickerSortKey,
): PickerRanking {
  const supplied = results[0]?.specCoverage.supplied ?? 0;
  const threshold = Math.min(2, supplied);
  const byTitle = (a: PickerCandidate, b: PickerCandidate): number =>
    a.title.localeCompare(b.title);
  /** The margin as a sort key: the number only where it speaks for the candidate, and the
   *  bottom of the order otherwise. Both sides lacking it yields NaN, which falls to the title. */
  const mv = (c: PickerCandidate): number =>
    marginSpeaksFor(c) && c.worstMargin ? c.worstMargin.marginPct : -Infinity;
  const cmp = (a: PickerCandidate, b: PickerCandidate): number => {
    const af = a.verdict === 'closed';
    const bf = b.verdict === 'closed';
    if (af !== bf) return af ? -1 : 1;
    const d = sortKey === 'current' ? (a.I_q ?? Infinity) - (b.I_q ?? Infinity) : mv(b) - mv(a);
    // `Math.sign`, not `d`: an infinite difference is an ordering, and returning it raw is fine
    // — but NaN (both sides missing the key) is not, and must fall through to the title.
    return !Number.isNaN(d) && d !== 0 ? Math.sign(d) : byTitle(a, b);
  };
  return {
    ranked: results.filter((c) => c.specCoverage.consumed >= threshold).sort(cmp),
    other: results.filter((c) => c.specCoverage.consumed < threshold).sort(byTitle),
    threshold,
    supplied,
  };
}
