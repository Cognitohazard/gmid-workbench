// Public surface of the leaf design-sheet module. `runSheet` is the single entrypoint:
// it validates then evaluates, attaching the validation warnings — mirroring the
// importMostab discipline so a caller cannot skip validation.

import type { DeviceTable } from '../types';
import {
  RANGE_END_SEP,
  engineChecks,
  indexTreeResults,
  isHardCheck,
  sweepable,
  stands,
  withValidation,
  treeCheckResults,
  withoutRange,
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
} from './types';
import { dcInputs, validateSheet } from './validate';
import { formatOf } from './nodes';
import { evaluateSheet, type DeviceResolver } from './eval';
import { resolvedSheet, type SheetRefIndex } from './resolve';

export * from './types';
export * from './legacy';
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
export * from './sensitivity';
export * from './examples';
export * from './propose';
// The structural analysis: read-only, table-free, and read by nothing an evaluation does.
export * from './structure';

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
): SheetResult {
  // A document in a format this app does not read is opened with that reason and not evaluated —
  // nor resolved, since its blocks are written in terms this engine does not know.
  if (formatOf(doc) === 'unknown') return evaluateSheet(doc);
  const r = resolvedSheet(doc, refs);
  const pre = [...r.warnings, ...validateSheet(r.doc)];
  const assumptions = dcInputs(r.doc).assumed;
  const res = evaluateSheet(r.doc, table, resolveDevice, { assumed: assumptions });
  return {
    ...withValidation(pre, res),
    feasible: res.feasible && !pre.some((w) => w.severity === 'error'),
    assumptions,
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
  keep: (rr: CheckResult) => boolean,
): { id: string; marginPct: number } | undefined {
  let worst: { id: string; marginPct: number } | undefined;
  for (const [id, rr] of checks) {
    if (!keep(rr)) continue;
    if (!worst || rr.marginPct < worst.marginPct) worst = { id, marginPct: rr.marginPct };
  }
  return worst;
}

/**
 * One number for "how much room does the held design have at this range end": the WORST
 * measurable hard-check margin anywhere in the range-end run's tree, clamped to the informative
 * range (see `clampMargin`). An end the design measurably fails without leaving check outcomes —
 * a held device that cannot carry its current there — reads -MARGIN_PCT_CAP, which the chart
 * clips at the bottom. An end with nothing left to measure reads its verdict as
 * 0 / -MARGIN_PCT_CAP.
 *
 * An end that was NOT RUN, or that returned NO ANSWER, reads null — a gap in the curve, the same
 * shape a check that could not be computed takes. Nothing about the range was measured there, and
 * a bottom clip would put a failure on the chart that the engine never established.
 */
function rangeEndMargin(e: RangeEndReport): number | null {
  if (e.state === 'not-run' || e.state === 'no-answer') return null;
  if (e.error !== undefined) return -MARGIN_PCT_CAP;
  const found = worstBy(treeCheckResults(e), isMeasurable);
  const worst = found === undefined ? null : clampMargin(found.marginPct);
  // An end that DOES NOT COMPLY must never chart non-negative: hard `na` fails the run closed
  // while contributing no margin, so without this floor a passing sibling check could paint a
  // failing range end at +margin.
  if (e.state !== 'complies' && (worst === null || worst >= 0)) return -MARGIN_PCT_CAP;
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

/**
 * Trace a leaf sheet across one parameter's slider range: at each of `n` evenly spaced samples,
 * override that parameter, evaluate, and collect every check's relative margin plus the overall
 * feasibility. Structural validation runs once (its result is constant across the sweep) and
 * forces every point infeasible if the doc is broken, matching `runSheet`. Returns an empty
 * sweep when `param` is not a finitely-bounded slider variable. Pure; never throws.
 */
export function sweepSheet(
  doc: SheetDoc,
  param: string,
  table?: DeviceTable,
  n = SWEEP_POINTS,
  resolveDevice?: DeviceResolver,
  refs?: SheetRefIndex,
): SheetSweep {
  const v = doc.params.find((p) => p.name === param);
  if (!sweepable(v)) {
    return { param, unit: v?.unit ?? '', x: [], checks: [], feasible: [], stands: [] };
  }

  const pts = Math.max(2, Math.min(401, Math.floor(n)));
  // Resolve refs ONCE — the tree is constant across the sweep, only param values move —
  // so ref'd children's hard checks ride the sweep like embedded ones.
  const r = resolvedSheet(doc, refs);
  // Validate the doc AS SWEPT: the swept param's stored default is overridden at every
  // sample, so validating it (e.g. a NaN default with a finite [min,max]) would force
  // every sample infeasible for a value no sample ever uses. Any finite stand-in works
  // structurally; min is one.
  const blocked =
    r.warnings.some((w) => w.severity === 'error') ||
    validateSheet(withParams(r.doc, { [param]: v.min })).some((w) => w.severity === 'error');
  const checks: SheetSweepCheck[] = [];
  collectTreeChecks(r.doc, '', checks);
  // Each range end rides the sweep as ONE aggregate curve: the held design's worst hard-check
  // margin there, per sample — where along this knob the design stops complying at that end. It
  // is a compliance curve and never moves `feasible`. Held in a parallel array
  // (res.rangeEnds mirrors doc.operatingRange by index), so the sample loop needs no id matching.
  // Array.isArray, not truthiness, for the reason evaluateSheet's operatingRange guard gives
  // (eval.ts) — a malformed persisted doc must degrade to a sweep with no compliance curves, not
  // throw out of .map.
  const rangeEndChecks: SheetSweepCheck[] = (
    Array.isArray(r.doc.operatingRange) ? r.doc.operatingRange : []
  ).map((e) => ({
    id: e.name + RANGE_END_SEP,
    kind: 'spec',
    marginPct: [],
    rangeEnd: e.name,
  }));
  const x: number[] = [];
  const feasible: boolean[] = [];
  const stood: boolean[] = [];

  for (let i = 0; i < pts; i++) {
    const t = v.min + ((v.max - v.min) * i) / (pts - 1);
    x.push(t);
    const res = evaluateSheet(withParams(r.doc, { [param]: t }), table, resolveDevice);
    feasible.push(!blocked && res.feasible);
    const byPath = new Map<string, CheckResult>();
    indexTreeResults(res.checks, res.blocks, '', byPath);
    for (const rl of checks) {
      const rr = byPath.get(rl.id);
      rl.marginPct.push(
        !rr || rr.status === 'na' || !Number.isFinite(rr.marginPct) ? null : rr.marginPct,
      );
    }
    for (let j = 0; j < rangeEndChecks.length; j++) {
      const rep = res.rangeEnds?.[j];
      rangeEndChecks[j].marginPct.push(rep ? rangeEndMargin(rep) : null);
    }
    // `blocked` too: a structurally broken doc has no design at any sample, exactly as
    // `runSheet` reports it.
    stood.push(!blocked && stands(res));
  }
  return {
    param,
    unit: v.unit ?? '',
    x,
    checks: [...checks, ...rangeEndChecks],
    feasible,
    stands: stood,
  };
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
 * default 21x21. The map is a FEASIBILITY map, so the sheet's operating range is never evaluated
 * here: a range end is a compliance question and cannot move a cell. This runs synchronously; a
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
): SheetSweep2 {
  const px = doc.params.find((p) => p.name === paramX);
  const py = doc.params.find((p) => p.name === paramY);
  const empty: SheetSweep2 = {
    paramX,
    paramY,
    unitX: px?.unit ?? '',
    unitY: py?.unit ?? '',
    x: [],
    y: [],
    feasible: [],
    binding: [],
  };
  if (paramX === paramY || !sweepable(px) || !sweepable(py)) return empty;

  const pts = Math.max(2, Math.min(101, Math.floor(n)));
  const r = resolvedSheet(doc, refs); // once — constant tree, only the two params move
  const swept = withoutRange(r.doc);
  const overrideTwo = (vx: number, vy: number): SheetDoc =>
    withParams(swept, { [paramX]: vx, [paramY]: vy });
  // Validated WITH its range: the map does not evaluate the range ends, but a sheet whose range
  // is structurally broken is a broken sheet, and every other entry point refuses it.
  const blocked =
    r.warnings.some((w) => w.severity === 'error') ||
    validateSheet(withParams(r.doc, { [paramX]: px.min, [paramY]: py.min })).some(
      (w) => w.severity === 'error',
    );

  const x = Array.from({ length: pts }, (_, i) => px.min + ((px.max - px.min) * i) / (pts - 1));
  const y = Array.from({ length: pts }, (_, i) => py.min + ((py.max - py.min) * i) / (pts - 1));
  const feasible: boolean[][] = [];
  const binding: (string | null)[][] = [];

  for (let yi = 0; yi < pts; yi++) {
    const frow: boolean[] = [];
    const brow: (string | null)[] = [];
    for (let xi = 0; xi < pts; xi++) {
      const res = evaluateSheet(overrideTwo(x[xi], y[yi]), table, resolveDevice);
      frow.push(!blocked && res.feasible);
      // Name the binding check — null when the cell is feasible, and also when
      // infeasibility came from something other than a failing check (sizing error, child
      // structural error), which bindingCheck reports as "no check to name".
      brow.push(res.feasible ? null : (bindingCheck(res)?.id ?? null));
    }
    feasible.push(frow);
    binding.push(brow);
  }
  return { ...empty, x, y, feasible, binding };
}
