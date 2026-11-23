// Public surface of the leaf design-sheet module. `runSheet` is the single entrypoint:
// it validates then evaluates, attaching the validation warnings — mirroring the
// importMostab discipline so a caller cannot skip validation.

import type { DeviceTable, OutsideTable, QAWarning } from '../types';
import {
  PATH_SEP,
  RANGE_END_SEP,
  engineChecks,
  indexTreeResults,
  isHardCheck,
  outsideIn,
  sweepable,
  stands,
  withValidation,
  treeCheckResults,
  withoutRange,
  rangePoints,
  AXES_LOCATION,
  withParams,
} from './types';
export { sweepable } from './types';
import { MARGIN_PCT_CAP } from './eval';
import type {
  CheckKind,
  CheckResult,
  SheetBlockReport,
  SheetDoc,
  RangeEndReport,
  SheetResult,
  SheetSweep,
  SheetSweep2,
  SheetSweepCheck,
  SweepCurve,
  SweepWindow,
} from './types';
import { dcInputs, validateSheet } from './validate';
import { formatOf } from './nodes';
import { evaluateSheet, inheritedPolarityWarnings, withVerdict, type DeviceResolver } from './eval';
import {
  aboutTheSheet,
  blockLists,
  designVerdict,
  givesValue,
  isNotCalculated,
  notCalculated,
  withFindings,
} from './items';
import {
  isComplete,
  marginReadable,
  type DesignVerdict,
  type HeldVerdict,
  type Item,
} from './states';
import { resolvedSheet, type SheetRefIndex } from './resolve';
import { namedResults } from './sensitivity';
import type { Settings } from './settings';

export * from './types';
export * from './settings';
export * from './legacy';
export * from './load';
export * from './overrides';
export * from './eval';
// Named rather than `export *`: validate.ts also exports reachedGivens, for a test that holds it
// and dcInputs to the same reach, and that is not public API.
export {
  configEligibility,
  dcInputs,
  exprProvenance,
  exprRoots,
  levelEligibility,
  validateSheet,
  type DcInputs,
  type ExprProvenance,
  type ExprRoots,
  type RootClass,
  type RootsPolicy,
} from './validate';
// The netlist's public surface: the format contract, the structural diode, the refusal, and the
// constants the DC wiring walk reports against. The walk itself runs inside every
// evaluation (see SheetResult.nodes).
export {
  CLOSURE_NOTE,
  KCL_TOL_REL,
  NODE_TOL,
  NO_ANSWER_NOTE,
  carriedBlockWiring,
  carriedConvention,
  carriedDocWiring,
  composedWiringProblems,
  earlierKeyFix,
  formatOf,
  placementsOf,
  sheetFormat,
  structuralDiodes,
  unreadFormat,
  unreadFormatIn,
  unwiredDevices,
  wiredDiode,
  wiringRefusal,
} from './nodes';
export * from './resolve';
export * from './states';
export * from './describe';
export * from './sensitivity';
export * from './properties';
export * from './examples';
export * from './propose';
export * from './spice';

/** What a public evaluation takes besides its document and its devices. */
export interface RunOptions {
  /** The tolerances and caps to evaluate under (see Settings). Absent: DEFAULT_SETTINGS. */
  readonly settings?: Settings;
  /** Keep each sized block's full operating point on its report (see
   *  EvaluateOptions.operatingPoint). */
  readonly operatingPoint?: boolean;
}

/** What a one-parameter sweep takes besides a run's options. */
export interface SweepOptions extends RunOptions {
  /** Also find where the knob passes, each edge pinned between samples (SheetSweep.windows): a
   *  few more evaluations per edge, so asked for by a caller that shows the answer, and left off
   *  by one that scans many knobs. */
  readonly windows?: boolean;
  /** Whether each sample is also asked at every point of the operating range (rangePoints), its
   *  window then reading them all. Not checked by default: each sample is the design point alone
   *  (SheetSweep.range). */
  readonly range?: SheetSweep['range'];
}

/** What a two-parameter sweep takes besides a run's options. */
export interface Sweep2Options extends RunOptions {
  /** One named result of the sheet (namedResults) to keep at every cell (SheetSweep2.value). One
   *  only: the map holds n² cells, and a result kept for each would hold n² values per result. */
  readonly value?: string;
  /** Whether each cell is also asked at every point of the operating range (SheetSweep2.range,
   *  SheetSweep2.rangeEnds). Not checked by default: the map is the design point's. */
  readonly range?: SheetSweep2['range'];
}

/** A result with no values: what the names a sheet always has (its equations and solved values)
 *  are read against before any sample is evaluated. */
const NO_VALUES: SheetResult = { values: {}, checks: [], feasible: false, warnings: [] };

/** A named result at one evaluated sample, or null where the sample does not determine it (see
 *  SweepCurve): a value the evaluation withheld, or one that is not finite. */
function sampleValue(res: SheetResult | undefined, name: string): number | null {
  if (!res || !givesValue(res, name)) return null;
  const v = res.values[name];
  return Number.isFinite(v) ? v : null;
}

/** The verdict of one evaluated sample, with validation's findings on its items as runSheet puts
 *  them: the verdict a script that runs the same values reads. */
const sampleVerdict = (
  res: SheetResult,
  findings: readonly QAWarning[],
  doc: SheetDoc,
): DesignVerdict => designVerdict(doc, sampleItems(res, findings, doc), res.rangeEnds).verdict;

/** One sample's items with validation's findings on them, as runSheet puts them. */
const sampleItems = (res: SheetResult, findings: readonly QAWarning[], doc: SheetDoc): Item[] =>
  withFindings(res.items ?? [], findings, doc, 'validation');

/** Which of a run's requirements, by the key its tree of check outcomes gives them (`cs.headroom`),
 *  have a margin a reader may take (marginReadable). A run with no items reads every one. */
const readableIn =
  (items: readonly Item[] | undefined) =>
  (key: string): boolean => {
    if (!items) return true;
    const own = items.find(
      (i) => i.kind === 'requirement' && [...i.path, i.name].join(PATH_SEP) === key,
    );
    return own === undefined || marginReadable(own);
  };

/** Validate + evaluate a sheet, merging validation warnings ahead of eval warnings. A
 *  validation error (e.g. a non-finite param, which eval silently skips, or a block's
 *  structural error) also forces the feasibility verdict false, so a structurally broken
 *  sheet is never reported feasible. `validateSheet` and `evaluateSheet` both recurse into
 *  composed children, so the whole tree is covered. `refs` materializes by-reference
 *  children first (see resolveSheetRefs) — resolution failures block feasibility the
 *  same way validation errors do. The result also carries the assumed DC inputs the design
 *  was sized under (SheetResult.assumptions). */
export function runSheet(
  doc: SheetDoc,
  table?: DeviceTable,
  resolveDevice?: DeviceResolver,
  refs?: SheetRefIndex,
  opts: RunOptions = {},
): SheetResult {
  // A document in a format this app does not read is opened with that reason and not evaluated —
  // nor resolved, since its blocks are written in terms this engine does not know.
  if (formatOf(doc) === 'unknown') return evaluateSheet(doc);
  const r = resolvedSheet(doc, refs);
  const pre = [...r.warnings, ...validateSheet(r.doc)];
  const assumptions = dcInputs(r.doc).assumed;
  const res = evaluateSheet(r.doc, table, resolveDevice, {
    assumed: assumptions,
    settings: opts.settings,
    ...(opts.operatingPoint ? { operatingPoint: true } : {}),
  });
  // A block sized on a table of the other polarity is a fact of the document and its binding,
  // said once for the run rather than by every evaluation inside it (see inheritedPolarityWarnings).
  const bound = inheritedPolarityWarnings(r.doc, table, resolveDevice);
  // What validation found is on the items too, each on the entry it names: a finding about one
  // range end on the sheet item of that end's own list, which an end that was not run has too.
  // A finding about the operating axes is about every corner they span.
  const points = rangePoints(r.doc);
  const endNames = new Set(points.map((e) => e.name));
  const corners = new Set(points.filter((e) => e.corner).map((e) => e.name));
  const onEnd = (w: QAWarning): boolean =>
    w.rule === 'sheet-range' &&
    w.location !== undefined &&
    (endNames.has(w.location) || w.location === AXES_LOCATION);
  const ownedBy = (w: QAWarning, name: string): boolean =>
    w.location === name || (w.location === AXES_LOCATION && corners.has(name));
  // A finding about one range end is on that end's list alone; the sheet's verdict reads the ends'
  // lists (sheetVerdictOf), so it is not feasible while the end's entry is not well formed.
  const items = withFindings(
    res.items ?? [],
    pre.filter((w) => !onEnd(w)),
    r.doc,
    'validation',
  );
  // A range end's run evaluates the entries of the sheet, so its list takes validation's findings
  // about them the way the design point's list does. A finding about the sheet as a whole is read in
  // the design point's list; the end is then not calculated, as it is where the design point gives
  // no design, so an end never reads compliant on a sheet with a validation error.
  const errors = pre.filter((w) => w.severity === 'error' && !onEnd(w));
  const entries = errors.filter((w) => !aboutTheSheet(r.doc, w));
  const wholeSheet = errors.length > entries.length;
  const rangeEnds = res.rangeEnds?.map((e) => {
    const own = pre.filter((w) => w.severity === 'error' && onEnd(w) && ownedBy(w, e.name));
    const notRun = !e.items?.length || isNotCalculated(e.items) || wholeSheet || own.length > 0;
    if (!notRun && !own.length && !entries.length) return e;
    const list = withFindings(
      notRun
        ? notCalculated(items)
        : (e.items ?? [{ kind: 'sheet', path: [], name: '', status: 'ok' }]),
      notRun ? own : [...own, ...entries],
      r.doc,
      'validation',
    );
    const blocks = blockLists(r.doc, list, e.blocks, true);
    // An end refused on its own entry is not run: it carries nothing its run evaluated, no set
    // values, no checks, no landing and no verdict.
    if (own.length)
      return {
        name: e.name,
        state: 'not-run' as const,
        set: {},
        checks: [],
        solved: {},
        warnings: [],
        items: list,
        ...(blocks ? { blocks } : {}),
      };
    const { verdict: _verdict, ...rest } = e;
    return { ...rest, items: list, ...(blocks ? { blocks } : {}), ...withVerdict(list, r.doc) };
  });
  // Each block's own list is the run's list, validation's findings included, under its path.
  const blocks = blockLists(r.doc, items, res.blocks, false);
  return {
    ...withValidation([...pre, ...bound], res),
    feasible: res.feasible && !pre.some((w) => w.severity === 'error'),
    assumptions,
    ...(rangeEnds ? { rangeEnds } : {}),
    ...(blocks ? { blocks } : {}),
    items,
    verdict: designVerdict(r.doc, items, rangeEnds),
  };
}

/** Default sample count for a parameter sweep across its [min,max] bound. */
export const SWEEP_POINTS = 41;

/**
 * Every check the sweep should trace, walking the WHOLE composition: all of the top
 * sheet's checks, plus every HARD (physical/spec) check of each descendant block,
 * its id prefixed with the block path (`cs.headroom`, `amp.s1.pm-spec`). A child's advisory
 * checks are noise at the top and are left out. Without the descendants, a composed
 * feasibility curve can flip with NO on-chart cause — the binding check lives
 * below the top sheet.
 */
function collectTreeChecks(doc: SheetDoc, prefix: string, into: SheetSweepCheck[]): void {
  for (const r of doc.checks) {
    if (prefix === '' || isHardCheck(r.kind))
      into.push({ id: prefix + r.id, kind: r.kind, marginPct: [] });
  }
  // The checks the engine adds (a declared region's) are checks of this doc like the authored
  // ones, so they ride the sweep beside them.
  for (const c of engineChecks(doc.givens))
    into.push({ id: prefix + c.id, kind: c.kind, marginPct: [] });
  // A docless (unresolved-ref) block has no visible checks; the sweep is all-infeasible
  // there anyway via eval's fail-closed guard.
  for (const u of doc.blocks ?? []) {
    if (u.doc) collectTreeChecks(u.doc, `${prefix}${u.name}.`, into);
  }
}

/**
 * Whether a check outcome carries HEADROOM information — the one definition of "measurable"
 * shared by the limiting check, the range-end aggregate, and any search that scores
 * a design point by its worst margin. A check is measurable when it gates the design (hard),
 * produced a finite relative margin at all, and is not parked exactly on its own boundary: two
 * mechanisms put it there by construction — a spec set by its own givens, and a range
 * end landing on the very value its check compares against — and the near-zero snap makes
 * both read exactly 0. A tautology admitted as the minimum is the answer forever, hiding every
 * check that can actually move.
 *
 * Takes the two fields it decides on rather than a whole `CheckResult`, so a caller holding a
 * SWEEP row — which carries exactly a kind and a margin per sample — reads the same predicate
 * as a caller holding a full result, instead of restating it. The narrowing loses nothing: an
 * `na` outcome has a NaN margin, and `margin` is zero exactly when `marginPct` is (the relative
 * denominator is floored at TINY and the operands are finite by the time a margin exists).
 */
export function measurable(kind: CheckKind, marginPct: number): boolean {
  return isHardCheck(kind) && Number.isFinite(marginPct) && marginPct !== 0;
}

/** A relative margin clamped to the range that carries information. Past MARGIN_PCT_CAP the
 *  ratio came from the TINY-floored denominator rather than from the design, so every consumer
 *  that compares margins — the range-end aggregate, a search objective — clamps the same way. The
 *  clamp is monotone, so clamping the minimum is the same as taking the minimum of the clamped. */
export const clampMargin = (m: number): number =>
  Math.max(-MARGIN_PCT_CAP, Math.min(MARGIN_PCT_CAP, m));

/** `measurable` over a whole check outcome — the shape the tree walks hand `worstBy`. */
const isMeasurable = (rr: CheckResult): boolean => measurable(rr.kind, rr.marginPct);

/** The smallest relative margin among the outcomes `keep` admits, with the tree key that names
 *  it — the one selector behind every "which check is it" answer, so they can never disagree
 *  about how the minimum is taken. */
function worstBy(
  checks: Iterable<[string, CheckResult]>,
  keep: (rr: CheckResult, id: string) => boolean,
): { id: string; marginPct: number } | undefined {
  let worst: { id: string; marginPct: number } | undefined;
  for (const [id, rr] of checks) {
    if (!keep(rr, id)) continue;
    if (!worst || rr.marginPct < worst.marginPct) worst = { id, marginPct: rr.marginPct };
  }
  return worst;
}

/**
 * One number for "how much room does the held design have at this range end": the WORST
 * measurable hard-check margin anywhere in the range-end run's tree, clamped to the informative
 * range (see `clampMargin`). An end that does not comply with nothing left to measure reads
 * -MARGIN_PCT_CAP, which the chart clips at the bottom; a compliant one with nothing to measure, 0.
 *
 * Only where the end's verdict is compliant or non-compliant and its run is complete (isComplete):
 * an end that was not calculated, is undetermined, or whose run stopped short reads null — a gap
 * in the curve, the same shape a check that could not be computed takes.
 */
function rangeEndMargin(e: RangeEndReport): number | null {
  // A margin is charted where the end's verdict says what the held design is there and every number
  // of the end's run is there; elsewhere its checks were read where the run stopped.
  const verdict = e.verdict?.verdict;
  if ((verdict !== 'compliant' && verdict !== 'non-compliant') || !isComplete(e)) return null;
  // The three conditions every reader of a requirement's margin applies: the verdict says what the
  // design is, the run is complete, and the requirement itself holds or fails (marginReadable).
  const readable = readableIn(e.items);
  const found = worstBy(treeCheckResults(e), (rr, id) => isMeasurable(rr) && readable(id));
  const worst = found === undefined ? null : clampMargin(found.marginPct);
  // An end that DOES NOT COMPLY must never chart non-negative: hard `na` fails the run closed
  // while contributing no margin, so without this floor a passing sibling check could paint a
  // failing range end at +margin.
  if (verdict !== 'compliant' && (worst === null || worst >= 0)) return -MARGIN_PCT_CAP;
  return worst ?? 0;
}

/** A failing hard check — what "binds". */
const isFailing = (rr: CheckResult): boolean => isHardCheck(rr.kind) && rr.status === 'fail';

/** One run's own check outcomes: its checks and its children's, and nothing from a range end.
 *  The binding and limiting checks answer about ONE run — the design where it was sized,
 *  or one range end handed in by itself — so a range end's failure is never named as the
 *  reason a feasible design is infeasible. */
const ownChecks = (res: {
  checks: readonly CheckResult[];
  blocks?: readonly SheetBlockReport[];
}): Map<string, CheckResult> => treeCheckResults({ checks: res.checks, blocks: res.blocks });

/**
 * The BINDING CHECK of one run: the failing HARD check with the worst relative margin
 * anywhere in the composition, its id carrying the block path (`amp.s1.pm-spec`) so a child's check
 * is attributable. `undefined` when no hard check fails — including when the design is infeasible
 * for a reason that is not a failing check (a sizing error, a child's structural error), which is
 * why callers must treat "no binding check" as "no check to name", never as "feasible".
 *
 * One definition, so the 2-D map's per-cell cause and a caller naming the cause of a single
 * verdict can never disagree about which check binds. A range end's report is a run too: pass
 * the report to ask what binds there.
 */
export function bindingCheck(res: {
  checks: readonly CheckResult[];
  blocks?: readonly SheetBlockReport[];
}): { id: string; marginPct: number } | undefined {
  return worstBy(ownChecks(res), isFailing);
}

/**
 * The LIMITING check of one run: the hard check with the smallest finite relative margin
 * anywhere in the composition, whatever its status — the same walk and the same tree-keyed ids as
 * bindingCheck, over a wider net. The two answer different questions and are kept apart on
 * purpose. "Which check broke the design" only exists when something failed, so bindingCheck
 * stays failing-only and a caller reading it can never mistake a comfortable pass for a cause.
 * "Which check is closest to breaking" is the question a FEASIBLE design poses — the one to point
 * a sensitivity readout at — and it has an answer whether or not anything is failing. `undefined`
 * when no hard check produced a finite margin at all (an all-`na` tree).
 *
 * The admissible set is `measurable` above — which skips the boundary tautologies, the reason
 * that predicate exists. bindingCheck never had to care: a snapped zero is never `fail`.
 */
export function limitingCheck(res: {
  checks: readonly CheckResult[];
  blocks?: readonly SheetBlockReport[];
}): { id: string; marginPct: number } | undefined {
  return worstBy(ownChecks(res), isMeasurable);
}

/**
 * The worst failing hard check among the range-end runs, named with its range end
 * (`cm-lo@sr-spec`) — what keeps a feasible design from complying, in the id form the
 * sensitivity readout takes. `undefined` when no range end has a failing check, which includes
 * every end that was not run or returned no answer: those carry no check outcomes to name.
 */
export function rangeEndCheck(res: {
  rangeEnds?: readonly RangeEndReport[];
}): { id: string; marginPct: number } | undefined {
  return worstBy(treeCheckResults({ checks: [], rangeEnds: res.rangeEnds }), isFailing);
}

/** One sample of a sweep, as the caller that evaluated it reads it: the evaluation (absent where
 *  nothing was evaluated), whether the sample counts as `feasible`, and whether it completed
 *  (see SheetSweep.stands). */
export interface SweepSample {
  readonly res?: SheetResult;
  readonly feasible: boolean;
  readonly stands: boolean;
  /** The sample's verdict, where the caller gives one: a design's (sampleVerdict) where the design is
   *  sized at the sample, a held design's where it is held there. A pass window is where it is
   *  feasible or compliant. A caller that gives none is read by `feasible`. */
  readonly verdict?: DesignVerdict | HeldVerdict;
  /** Whether every number of the sample is there (isComplete), where the caller says; else it is
   *  read from the sample's result. */
  readonly complete?: boolean;
}

/**
 * The one way a sheet is traced across one parameter's slider range: at each of `n` evenly spaced
 * samples, override that parameter, hand the document to `sample` to evaluate, and collect every
 * check's relative margin plus the sample's feasibility. What "evaluate" means is the caller's —
 * the design sized at each sample (sweepSheet), or sized at one condition and held at another
 * (sweepAtCondition in corners) — and everything else, the check list, the range-end curves and
 * the structural gate, is the same for both. Structural validation runs once (its result is
 * constant across the sweep) and forces every sample infeasible if the doc is broken, matching
 * `runSheet`. Returns an empty sweep when `param` is not a finitely-bounded slider variable.
 * `sample` receives the resolved document with the sample's value written in.
 */
export function sweepOf(
  doc: SheetDoc,
  param: string,
  n: number,
  refs: SheetRefIndex | undefined,
  sample: (doc: SheetDoc, findings: readonly QAWarning[]) => SweepSample,
  probe: ((doc: SheetDoc, findings: readonly QAWarning[]) => SweepSample) | undefined,
  range: SheetSweep['range'],
): SheetSweep {
  const v = doc.params.find((p) => p.name === param);
  if (!sweepable(v)) {
    return {
      param,
      unit: v?.unit ?? '',
      range,
      x: [],
      checks: [],
      feasible: [],
      stands: [],
      complete: [],
      verdicts: [],
      outside: [],
      values: [],
    };
  }

  const pts = Math.max(2, Math.min(401, Math.floor(n)));
  // Resolve refs ONCE — the tree is constant across the sweep, only param values move —
  // so ref'd children's hard checks ride the sweep like embedded ones.
  const r = resolvedSheet(doc, refs);
  // Validate the doc AS SWEPT: the swept param's stored default is overridden at every
  // sample, so validating it (e.g. a NaN default with a finite [min,max]) would force
  // every sample infeasible for a value no sample ever uses. Any finite stand-in works
  // structurally; min is one.
  const pre = [...r.warnings, ...validateSheet(withParams(r.doc, { [param]: v.min }))];
  const blocked = pre.some((w) => w.severity === 'error');
  const findings = pre;
  /** Whether a sample's numbers are all there: as the caller says, else from its result. */
  const completeAt = (s: SweepSample): boolean =>
    s.complete ?? (s.res !== undefined && isComplete(s.res));
  /** Whether a sample passes: its verdict is feasible or compliant and it is complete, where the
   *  caller gives a verdict. */
  const passes = (s: SweepSample): boolean =>
    s.verdict !== undefined
      ? (s.verdict === 'feasible' || s.verdict === 'compliant') && completeAt(s)
      : !blocked && s.feasible;
  const checks: SheetSweepCheck[] = [];
  collectTreeChecks(r.doc, '', checks);
  // Each range end rides the sweep as ONE aggregate curve: the held design's worst hard-check
  // margin there, per sample — where along this knob the design stops complying at that end. It
  // is a compliance curve and never moves `feasible`. Held in a parallel array
  // (res.rangeEnds mirrors rangePoints by index), so the sample loop needs no id matching.
  const rangeEndChecks: SheetSweepCheck[] = rangePoints(r.doc).map((e) => ({
    id: e.name + RANGE_END_SEP,
    kind: 'spec',
    marginPct: [],
    rangeEnd: e.name,
  }));
  const x: number[] = [];
  const feasible: boolean[] = [];
  const passed: boolean[] = [];
  const verdicts: (DesignVerdict | HeldVerdict | null)[] = [];
  const complete: boolean[] = [];
  const stood: boolean[] = [];
  const beyond: OutsideTable[][] = [];
  // One curve per named result (namedResults): the sheet's equations and solved values from the
  // start, and each value a block provides from the first sample that holds it, a gap before.
  const curves = new Map<string, SweepCurve>();
  const addNamed = (res: SheetResult, filled: number): void => {
    for (const { name, unit } of namedResults(r.doc, res))
      if (!curves.has(name))
        curves.set(name, { name, unit: unit ?? '', y: Array<number | null>(filled).fill(null) });
  };
  addNamed(NO_VALUES, 0);
  /** The hard checks failing in one run's own outcomes, by the ids the sweep's curves carry: each one
   *  whose margin may be read (marginReadable). */
  const failingIn = (
    byPath: ReadonlyMap<string, CheckResult>,
    items: readonly Item[] | undefined,
  ): string[] => {
    const readable = readableIn(items);
    return checks.flatMap((c) => {
      const rr = byPath.get(c.id);
      return rr && isFailing(rr) && readable(c.id) ? [c.id] : [];
    });
  };
  /** Each sample's failing hard checks, kept where windows are asked for (see windowsOf). */
  const failedAt: string[][] = [];

  for (let i = 0; i < pts; i++) {
    const t = v.min + ((v.max - v.min) * i) / (pts - 1);
    x.push(t);
    const s = sample(withParams(r.doc, { [param]: t }), findings);
    const { res, feasible: ok, stands: done } = s;
    feasible.push(!blocked && ok);
    passed.push(passes(s));
    verdicts.push(s.verdict ?? null);
    complete.push(completeAt(s));
    beyond.push(res ? outsideIn(res) : []);
    if (res) addNamed(res, i);
    for (const c of curves.values()) c.y.push(sampleValue(res, c.name));
    const byPath = new Map<string, CheckResult>();
    if (res) indexTreeResults(res.checks, res.blocks, '', byPath);
    if (probe) failedAt.push(failingIn(byPath, res?.items));
    for (const rl of checks) {
      const rr = byPath.get(rl.id);
      rl.marginPct.push(
        !rr || rr.status === 'na' || !Number.isFinite(rr.marginPct) ? null : rr.marginPct,
      );
    }
    for (let j = 0; j < rangeEndChecks.length; j++) {
      const rep = res?.rangeEnds?.[j];
      rangeEndChecks[j].marginPct.push(rep ? rangeEndMargin(rep) : null);
    }
    // `blocked` too: a structurally broken doc has no design at any sample, exactly as
    // `runSheet` reports it.
    stood.push(!blocked && done);
  }
  const out: SheetSweep = {
    param,
    unit: v.unit ?? '',
    range,
    x,
    checks: [...checks, ...rangeEndChecks],
    feasible,
    stands: stood,
    complete,
    verdicts,
    outside: beyond,
    values: [...curves.values()],
  };
  if (!probe) return out;
  const at = (t: number): { ok: boolean; failing: string[]; outside: OutsideTable[] } => {
    const s = probe(withParams(r.doc, { [param]: t }), findings);
    if (s.verdict === undefined && blocked) return { ok: false, failing: [], outside: [] };
    return {
      ok: passes(s),
      failing: s.res ? failingIn(ownChecks(s.res), s.res.items) : [],
      outside: s.res ? outsideIn(s.res) : [],
    };
  };
  return { ...out, windows: windowsOf(x, passed, failedAt, beyond, at) };
}

/** Halvings that pin a window's edge between two samples: 2^-8 of their spacing, about a
 *  ten-thousandth of the range on a sweep of SWEEP_POINTS samples. */
export const WINDOW_EDGE_STEPS = 8;

/** Every run of passing samples as a window, each edge that lies between two samples pinned by
 *  halving the gap (see SweepWindow). */
function windowsOf(
  x: readonly number[],
  ok: readonly boolean[],
  failedAt: readonly string[][],
  outsideAt: readonly OutsideTable[][],
  at: (t: number) => { ok: boolean; failing: string[]; outside: OutsideTable[] },
): SweepWindow[] {
  /** The edge between the passing sample `good` and the failing one `bad`: the passing end of the
   *  last bracket, and what fails at its other end — the failing sample's own, where no value
   *  between them failed — or what it read beyond a table, where that is why it does not pass. */
  const pin = (
    good: number,
    bad: number,
  ): { at: number; closedBy: string[]; outside: OutsideTable[] } => {
    let g = x[good];
    let b = x[bad];
    let closedBy = failedAt[bad];
    let outside = outsideAt[bad];
    for (let k = 0; k < WINDOW_EDGE_STEPS; k++) {
      const m = (g + b) / 2;
      const s = at(m);
      if (s.ok) g = m;
      else {
        b = m;
        closedBy = s.failing;
        outside = s.outside;
      }
    }
    return { at: g, closedBy, outside };
  };
  const out: SweepWindow[] = [];
  for (let i = 0; i < ok.length; i++) {
    if (!ok[i]) continue;
    let j = i;
    while (j + 1 < ok.length && ok[j + 1]) j++;
    const lo = i === 0 ? undefined : pin(i, i - 1);
    const hi = j === ok.length - 1 ? undefined : pin(j, j + 1);
    out.push({
      lo: lo?.at ?? x[i],
      hi: hi?.at ?? x[j],
      ...(lo ? { below: lo.closedBy } : {}),
      ...(hi ? { above: hi.closedBy } : {}),
      ...(lo?.outside.length ? { belowOutside: lo.outside } : {}),
      ...(hi?.outside.length ? { aboveOutside: hi.outside } : {}),
    });
    i = j;
  }
  return out;
}

/**
 * Trace a leaf sheet across one parameter's slider range: at each of `n` evenly spaced samples,
 * override that parameter, evaluate — the design sized afresh at that value — and collect every
 * check's relative margin plus the overall feasibility (see sweepOf). Pure; never throws.
 */
export function sweepSheet(
  doc: SheetDoc,
  param: string,
  table?: DeviceTable,
  n = SWEEP_POINTS,
  resolveDevice?: DeviceResolver,
  refs?: SheetRefIndex,
  opts: SweepOptions = {},
): SheetSweep {
  // Not checked, the sweep never sees the operating range: each sample, its window and its
  // validation are the design point's alone.
  const range = opts.range ?? 'not-checked';
  const swept = range === 'checked' ? doc : withoutRange(doc);
  const sample = (d: SheetDoc, findings: readonly QAWarning[]): SweepSample => {
    const res = evaluateSheet(d, table, resolveDevice, { settings: opts.settings });
    const items = sampleItems(res, findings, d);
    return {
      res,
      feasible: res.feasible,
      stands: stands(res),
      verdict: designVerdict(d, items, res.rangeEnds).verdict,
      complete: isComplete({ items }),
    };
  };
  // Feasibility never reads a range end, so an edge is pinned without them: one evaluation a probe.
  return sweepOf(
    swept,
    param,
    n,
    refs,
    sample,
    opts.windows ? (d, findings) => sample(withoutRange(d), findings) : undefined,
    range,
  );
}

/** Default per-axis sample count for a 2-D sweep (samples² evaluations per call). */
export const SWEEP2_POINTS = 21;

/**
 * Trace a sheet across the 2-D grid of two parameters' slider ranges: the design-plane
 * feasibility map a 1-D cut cannot answer ("does any L hold the phase margin across the
 * whole gm_id range?"). Each infeasible cell also names the WORST failing hard check —
 * walking the composition tree, so a child's check is attributed by path.
 * Cost is n² full-tree evaluations (sub-millisecond each on real tables). A sheet the engine
 * SOLVES costs far more per cell: every sample searches each of its solved params (several
 * probes each, every probe a full tree evaluation) AND lands on biases the slice cache has not
 * seen. Measured on a three-child 5T OTA over sky130: 0.47 ms/cell unsolved against ~50-60
 * ms/cell once a design constraint and both declared bias axes are in play, i.e. ~21-27 s for the
 * default 21x21. By default the map is the design point's and the sheet's operating range is not
 * evaluated; asked to check it (Sweep2Options.range), each cell is also asked at every point of the
 * range, which multiplies the cost by their count. This runs synchronously; a
 * caller driving it from a UI should expect to block for that long. Each declared axis costs
 * another slice per pass, so the cheap figure is cheap
 * only because a frozen estimate re-slices at the same handful of biases; the honest
 * computation is the slower one.
 *
 * Each sample is solved INDEPENDENTLY, from its stated ranges alone. Starting a sample from its
 * neighbour's answer is the obvious optimisation and is deliberately not done: a relation with
 * more than one root in its range would land wherever the neighbour led it, so the map would be
 * hysteretic — a swept cell could then report a different verdict than the same parameters
 * evaluated standalone, which is a worse defect than the time it saves.
 *
 * Structural validation runs once, with both swept params overridden. Pure; never throws.
 */
export function sweepSheet2(
  doc: SheetDoc,
  paramX: string,
  paramY: string,
  table?: DeviceTable,
  n = SWEEP2_POINTS,
  resolveDevice?: DeviceResolver,
  refs?: SheetRefIndex,
  opts: Sweep2Options = {},
): SheetSweep2 {
  const px = doc.params.find((p) => p.name === paramX);
  const py = doc.params.find((p) => p.name === paramY);
  const empty: SheetSweep2 = {
    paramX,
    paramY,
    unitX: px?.unit ?? '',
    unitY: py?.unit ?? '',
    range: opts.range ?? 'not-checked',
    x: [],
    y: [],
    feasible: [],
    verdicts: [],
    binding: [],
    outside: [],
  };
  if (paramX === paramY || !sweepable(px) || !sweepable(py)) return empty;

  const pts = Math.max(2, Math.min(101, Math.floor(n)));
  const r = resolvedSheet(doc, refs); // once — constant tree, only the two params move
  const checked = empty.range === 'checked';
  const swept = checked ? r.doc : withoutRange(r.doc);
  const overrideTwo = (vx: number, vy: number): SheetDoc =>
    withParams(swept, { [paramX]: vx, [paramY]: vy });
  // Validated WITH its range: the map does not evaluate the range ends, but a sheet whose range
  // is structurally broken is a broken sheet, and every other entry point refuses it.
  const pre = [
    ...r.warnings,
    ...validateSheet(withParams(r.doc, { [paramX]: px.min, [paramY]: py.min })),
  ];
  const blocked = pre.some((w) => w.severity === 'error');
  const findings = pre;

  const x = Array.from({ length: pts }, (_, i) => px.min + ((px.max - px.min) * i) / (pts - 1));
  const y = Array.from({ length: pts }, (_, i) => py.min + ((py.max - py.min) * i) / (pts - 1));
  const feasible: boolean[][] = [];
  const verdicts: DesignVerdict[][] = [];
  const binding: (string | null)[][] = [];
  const beyond: OutsideTable[][][] = [];
  const asked = opts.value;
  const z: (number | null)[][] = [];
  const ends: RangeEndReport[][][] = [];
  /** The asked name's entry among a cell's named results, from the first cell that names it. */
  let named: { name: string; unit?: string } | undefined;

  for (let yi = 0; yi < pts; yi++) {
    const frow: boolean[] = [];
    const vrow: DesignVerdict[] = [];
    const brow: (string | null)[] = [];
    const orow: OutsideTable[][] = [];
    const zrow: (number | null)[] = [];
    const erow: RangeEndReport[][] = [];
    for (let xi = 0; xi < pts; xi++) {
      const res = evaluateSheet(overrideTwo(x[xi], y[yi]), table, resolveDevice, {
        settings: opts.settings,
      });
      const cell = overrideTwo(x[xi], y[yi]);
      const verdict = sampleVerdict(res, findings, cell);
      frow.push(!blocked && res.feasible);
      vrow.push(verdict);
      // Name the binding check — null when the cell is feasible, and also when
      // infeasibility came from something other than a failing check (sizing error, child
      // structural error), which bindingCheck reports as "no check to name".
      brow.push(verdict === 'feasible' ? null : (bindingCheck(res)?.id ?? null));
      orow.push(outsideIn(res));
      if (checked) erow.push(res.rangeEnds ?? []);
      if (asked !== undefined) {
        named ??= namedResults(r.doc, res).find((n) => n.name === asked);
        zrow.push(sampleValue(res, asked));
      }
    }
    feasible.push(frow);
    verdicts.push(vrow);
    binding.push(brow);
    beyond.push(orow);
    if (asked !== undefined) z.push(zrow);
    if (checked) ends.push(erow);
  }
  return {
    ...empty,
    x,
    y,
    feasible,
    verdicts,
    binding,
    outside: beyond,
    ...(checked ? { rangeEnds: ends } : {}),
    ...(asked === undefined
      ? {}
      : named
        ? { value: { name: asked, unit: named.unit ?? '', z } }
        : {
            valueNotNamed: {
              name: asked,
              message:
                `${asked} is not a named result of this sheet. A named result is one of its ` +
                `equations, a value it solves for, or a value one of its blocks provides.`,
            },
          }),
  };
}

// The structural analysis: read-only, table-free, and read by nothing an evaluation does.
export * from './structure';
