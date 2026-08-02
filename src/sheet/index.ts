// Public surface of the leaf design-sheet module. `runSheet` is the single entrypoint:
// it validates then evaluates, attaching the validation warnings — mirroring the
// importMostab discipline so a caller cannot skip validation.

import type { DeviceTable } from '../types';
import {
  EDGE_SEP,
  indexTreeResults,
  isHardRule,
  sweepable,
  treeRuleResults,
  withParams,
} from './types';
export { sweepable } from './types';
import { MARGIN_PCT_CAP } from './eval';
import type {
  RuleResult,
  SheetChildReport,
  SheetDoc,
  SheetEdgeReport,
  SheetResult,
  SheetSweep,
  SheetSweep2,
  SheetSweepRule,
} from './types';
import { validateSheet } from './validate';
import { evaluateSheet, type DeviceResolver } from './eval';
import { resolvedSheet, type SheetRefIndex } from './resolve';

export * from './types';
export * from './eval';
export * from './validate';
export * from './resolve';
export * from './sensitivity';
export * from './examples';

/** Validate + evaluate a sheet, merging validation warnings ahead of eval warnings. A
 *  validation error (e.g. a non-finite param, which eval silently skips, or a child block's
 *  structural error) also forces the feasibility verdict false, so a structurally broken
 *  sheet is never reported feasible. `validateSheet` and `evaluateSheet` both recurse into
 *  composed children, so the whole tree is covered. `refs` materializes by-reference
 *  children first (see resolveSheetRefs) — resolution failures block feasibility the
 *  same way validation errors do. */
export function runSheet(
  doc: SheetDoc,
  table?: DeviceTable,
  resolveDevice?: DeviceResolver,
  refs?: SheetRefIndex,
): SheetResult {
  const r = resolvedSheet(doc, refs);
  const pre = [...r.warnings, ...validateSheet(r.doc)];
  const res = evaluateSheet(r.doc, table, resolveDevice);
  const blocked = pre.some((w) => w.severity === 'error');
  return { ...res, feasible: res.feasible && !blocked, warnings: [...pre, ...res.warnings] };
}

/** Default sample count for a parameter sweep across its [min,max] bound. */
export const SWEEP_POINTS = 41;

/**
 * Every rule the sweep should trace, walking the WHOLE composition: all of the top
 * sheet's rules, plus every HARD (invariant/requirement) rule of each descendant block,
 * its id prefixed with the use path (`cs.headroom`, `amp.s1.pm-spec`). Child guardrails
 * are advisory noise at the top and are left out. Without the descendants, a composed
 * feasibility curve can flip with NO on-chart cause — the binding constraint lives
 * below the top sheet.
 */
function collectTreeRules(doc: SheetDoc, prefix: string, into: SheetSweepRule[]): void {
  for (const r of doc.rules) {
    if (prefix === '' || isHardRule(r.kind))
      into.push({ id: prefix + r.id, kind: r.kind, marginPct: [] });
  }
  // A docless (unresolved-ref) use has no visible rules; the sweep is all-infeasible
  // there anyway via eval's fail-closed guard.
  for (const u of doc.uses ?? []) {
    if (u.doc) collectTreeRules(u.doc, `${prefix}${u.name}.`, into);
  }
}

/**
 * Whether a rule outcome carries HEADROOM information — the one definition of "measurable"
 * shared by the limiting constraint and the containment-edge aggregate, which had drifted
 * apart as two near-copies. A rule is measurable when it gates the design (hard), produced a
 * finite relative margin at all, and is not parked exactly on its own boundary: two mechanisms
 * put it there by construction — a spec pinned by its own bind, and a containment edge landing
 * on the very range end its rule compares against — and the near-zero snap makes both read
 * exactly 0. A tautology admitted as the minimum is the answer forever, hiding every rule that
 * can actually move.
 */
function measurable(rr: RuleResult): boolean {
  return (
    isHardRule(rr.kind) && rr.status !== 'na' && Number.isFinite(rr.marginPct) && rr.margin !== 0
  );
}

/** The smallest relative margin among the outcomes `keep` admits, with the tree key that names
 *  it — the one selector behind every "which rule is it" answer, so they can never disagree
 *  about how the minimum is taken. */
function worstBy(
  rules: Iterable<[string, RuleResult]>,
  keep: (rr: RuleResult) => boolean,
): { id: string; marginPct: number } | undefined {
  let worst: { id: string; marginPct: number } | undefined;
  for (const [id, rr] of rules) {
    if (!keep(rr)) continue;
    if (!worst || rr.marginPct < worst.marginPct) worst = { id, marginPct: rr.marginPct };
  }
  return worst;
}

/**
 * One number for "how close is this containment edge to closing": the WORST measurable hard-rule
 * margin anywhere in the edge run's tree, clamped to ±MARGIN_PCT_CAP (a rule against a ~0 bound
 * carries a TINY-scaled, information-free ratio that would otherwise peg the aggregate; the
 * clamp is monotone, so clamping the minimum is the same as taking the minimum of the clamped).
 * An edge that did not stand at all (solve failure, unresolvable set) reads -MARGIN_PCT_CAP, not
 * null: the chart clips it at the bottom, so an edge-driven feasibility flip ALWAYS has an
 * on-chart cause. A standing edge with nothing left to measure reads its verdict as
 * 0 / -MARGIN_PCT_CAP.
 */
function edgeMargin(e: SheetEdgeReport): number {
  if (e.error !== undefined) return -MARGIN_PCT_CAP;
  const found = worstBy(treeRuleResults(e), measurable);
  const worst =
    found === undefined
      ? null
      : Math.max(-MARGIN_PCT_CAP, Math.min(MARGIN_PCT_CAP, found.marginPct));
  // An INFEASIBLE edge must never chart non-negative: hard `na` fails the run closed
  // while contributing no margin, so without this floor a passing sibling rule could
  // paint a broken edge at +margin — a feasibility flip with no on-chart cause, the
  // exact defect this curve exists to prevent.
  if (!e.feasible && (worst === null || worst >= 0)) return -MARGIN_PCT_CAP;
  return worst ?? 0;
}

/**
 * The BINDING CONSTRAINT of one evaluation: the failing HARD rule with the worst relative margin
 * anywhere in the composition, its id carrying the use path (`amp.s1.pm-spec`) so a child's rule
 * is attributable — and across the containment-edge runs, their ids carrying the edge name
 * (`cm-lo@tail-saturated`). `undefined` when no hard rule fails — including when the design is
 * infeasible for a reason that is not a failing rule (a bind error, a child's structural error,
 * an edge whose solve failed), which is why callers must treat "no binding constraint" as "no
 * rule to name", never as "feasible".
 *
 * One definition, so the 2-D map's per-cell cause and a caller naming the cause of a single
 * verdict can never disagree about which rule binds.
 */
export function bindingConstraint(res: {
  rules: RuleResult[];
  children?: SheetChildReport[];
  edges?: SheetEdgeReport[];
}): { id: string; marginPct: number } | undefined {
  return worstBy(treeRuleResults(res), (rr) => isHardRule(rr.kind) && rr.status === 'fail');
}

/**
 * The LIMITING constraint of one evaluation: the hard rule with the smallest finite relative
 * margin anywhere in the composition, whatever its status — the same walk and the same tree-keyed
 * ids as bindingConstraint, over a wider net. The two answer different questions and are kept
 * apart on purpose. "Which rule broke the design" only exists when something failed, so
 * bindingConstraint stays failing-only and a caller reading it can never mistake a comfortable
 * pass for a cause. "Which rule is closest to breaking" is the question a FEASIBLE design poses —
 * the one to point a sensitivity readout at — and it has an answer whether or not anything is
 * failing. `undefined` when no hard rule produced a finite margin at all (an all-`na` tree).
 *
 * The admissible set is `measurable` above — which skips the boundary tautologies, the reason
 * that predicate exists. bindingConstraint never had to care: a snapped zero is never `fail`.
 */
export function limitingConstraint(res: {
  rules: RuleResult[];
  children?: SheetChildReport[];
  edges?: SheetEdgeReport[];
}): { id: string; marginPct: number } | undefined {
  return worstBy(treeRuleResults(res), measurable);
}

/**
 * Trace a leaf sheet across one parameter's slider range: at each of `n` evenly spaced samples,
 * override that parameter, evaluate, and collect every rule's relative margin plus the overall
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
    return { param, unit: v?.unit ?? '', x: [], rules: [], feasible: [] };
  }

  const pts = Math.max(2, Math.min(401, Math.floor(n)));
  // Resolve refs ONCE — the tree is constant across the sweep, only param values move —
  // so ref'd children's hard rules ride the sweep like embedded ones.
  const r = resolvedSheet(doc, refs);
  // Validate the doc AS SWEPT: the swept param's stored default is overridden at every
  // sample, so validating it (e.g. a NaN default with a finite [min,max]) would force
  // every sample infeasible for a value no sample ever uses. Any finite stand-in works
  // structurally; min is one.
  const blocked =
    r.warnings.some((w) => w.severity === 'error') ||
    validateSheet(withParams(r.doc, { [param]: v.min })).some((w) => w.severity === 'error');
  const rules: SheetSweepRule[] = [];
  collectTreeRules(r.doc, '', rules);
  // Each containment edge rides the sweep as ONE aggregate curve: its worst hard-rule
  // margin per sample. Without it a cell can flip infeasible with no on-chart cause — the
  // same gap collectTreeRules closes for descendant rules. Held in a parallel array
  // (res.edges mirrors doc.edges by index), so the sample loop needs no id matching.
  const edgeRules: SheetSweepRule[] = (r.doc.edges ?? []).map((e) => ({
    id: e.name + EDGE_SEP,
    kind: 'requirement',
    marginPct: [],
    edge: e.name,
  }));
  const x: number[] = [];
  const feasible: boolean[] = [];

  for (let i = 0; i < pts; i++) {
    const t = v.min + ((v.max - v.min) * i) / (pts - 1);
    x.push(t);
    const res = evaluateSheet(withParams(r.doc, { [param]: t }), table, resolveDevice);
    feasible.push(!blocked && res.feasible);
    const byPath = new Map<string, RuleResult>();
    indexTreeResults(res.rules, res.children, '', byPath);
    for (const rl of rules) {
      const rr = byPath.get(rl.id);
      rl.marginPct.push(
        !rr || rr.status === 'na' || !Number.isFinite(rr.marginPct) ? null : rr.marginPct,
      );
    }
    for (let j = 0; j < edgeRules.length; j++) {
      const rep = res.edges?.[j];
      edgeRules[j].marginPct.push(rep ? edgeMargin(rep) : null);
    }
  }
  return { param, unit: v.unit ?? '', x, rules: [...rules, ...edgeRules], feasible };
}

/** Default per-axis sample count for a 2-D sweep (samples² evaluations per call). */
export const SWEEP2_POINTS = 21;

/**
 * Trace a sheet across the 2-D grid of two parameters' slider ranges: the design-plane
 * feasibility map a 1-D cut cannot answer ("does any L hold the phase margin across the
 * whole gm_id range?"). Each infeasible cell also names the WORST failing hard rule —
 * walking the composition tree, so a child block's constraint is attributed by path.
 * Cost is n² full-tree evaluations (sub-millisecond each on real tables). A sheet the engine
 * SOLVES costs far more per cell: every sample converges its own fixed point or bisects its own
 * pin (~20 probes, each a full tree evaluation) AND lands on biases the slice cache has not
 * seen. Measured on a three-child 5T OTA over sky130: 0.47 ms/cell unsolved against ~50-60
 * ms/cell once a pin and both declared bias axes are in play, i.e. ~21-27 s for the default
 * 21x21 — and containment edges multiply every cell by (1 + edge count) on top, so the
 * library's two-edge OTAs sit near three times that. This runs synchronously; a caller
 * driving it from a UI should expect to block for that long. Each declared axis costs another slice per pass, so the cheap figure is cheap
 * only because a frozen estimate re-slices at the same handful of biases; the honest
 * computation is the slower one.
 *
 * Each sample is solved INDEPENDENTLY, from the doc's authored starting guess. Seeding a sample
 * from its neighbour's converged estimate is the obvious optimisation and is deliberately not
 * done: contraction does not imply a unique fixed point, so a carried seed makes the map
 * hysteretic — a swept cell can then report a different verdict than the same parameters
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
  const overrideTwo = (vx: number, vy: number): SheetDoc =>
    withParams(r.doc, { [paramX]: vx, [paramY]: vy });
  const blocked =
    r.warnings.some((w) => w.severity === 'error') ||
    validateSheet(overrideTwo(px.min, py.min)).some((w) => w.severity === 'error');

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
      // Name the binding constraint — null when the cell is feasible, and also when
      // infeasibility came from something other than a failing rule (bind error, child
      // structural error), which bindingConstraint reports as "no rule to name".
      brow.push(res.feasible ? null : (bindingConstraint(res)?.id ?? null));
    }
    feasible.push(frow);
    binding.push(brow);
  }
  return { ...empty, x, y, feasible, binding };
}
