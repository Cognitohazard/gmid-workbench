// Public surface of the leaf design-sheet module. `runSheet` is the single entrypoint:
// it validates then evaluates, attaching the validation warnings — mirroring the
// importMostab discipline so a caller cannot skip validation.

import type { DeviceTable, QAWarning } from '../types';
import { isHardRule } from './types';
import type {
  RuleResult,
  SheetChildReport,
  SheetDoc,
  SheetResult,
  SheetSweep,
  SheetSweep2,
  SheetSweepRule,
} from './types';
import { validateSheet } from './validate';
import { evaluateSheet, type DeviceResolver } from './eval';
import { resolveSheetRefs, type SheetRefIndex } from './resolve';

export * from './types';
export * from './eval';
export * from './validate';
export * from './resolve';
export * from './examples';

/** Materialize refs when an index is supplied; otherwise pass the doc through. The
 *  resolver's failures are error warnings, so they ride the same fail-closed channel
 *  as validation errors in every entrypoint below. */
function resolved(doc: SheetDoc, refs?: SheetRefIndex): { doc: SheetDoc; warnings: QAWarning[] } {
  return refs ? resolveSheetRefs(doc, refs) : { doc, warnings: [] };
}

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
  const r = resolved(doc, refs);
  const pre = [...r.warnings, ...validateSheet(r.doc)];
  const res = evaluateSheet(r.doc, table, resolveDevice);
  const blocked = pre.some((w) => w.severity === 'error');
  return { ...res, feasible: res.feasible && !blocked, warnings: [...pre, ...res.warnings] };
}

/** Default sample count for a parameter sweep across its [min,max] bound. */
export const SWEEP_POINTS = 41;

/** True when a param is a finitely-bounded slider variable (sweepable). The ONE
 *  definition of sweepability — both sweep engines and the UI's param pickers consult
 *  it, so they can never disagree about which params can be swept. */
export function sweepable(
  v: { min?: number; max?: number } | undefined,
): v is { min: number; max: number } {
  return (
    !!v &&
    v.min !== undefined &&
    v.max !== undefined &&
    Number.isFinite(v.min) &&
    Number.isFinite(v.max) &&
    v.max > v.min
  );
}

/** Clone a doc with the named params' VALUES overridden — the sweeps' sample injection. */
function withParams(doc: SheetDoc, o: Record<string, number>): SheetDoc {
  return {
    ...doc,
    params: doc.params.map((p) =>
      Object.prototype.hasOwnProperty.call(o, p.name) ? { ...p, value: o[p.name] } : p,
    ),
  };
}

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

/** Index one evaluation's rule outcomes by the same path scheme collectTreeRules uses. */
function indexTreeResults(
  rules: RuleResult[],
  children: SheetChildReport[] | undefined,
  prefix: string,
  into: Map<string, RuleResult>,
): void {
  for (const rr of rules) into.set(prefix + rr.id, rr);
  for (const c of children ?? [])
    indexTreeResults(c.rules, c.children, `${prefix}${c.name}.`, into);
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
  const r = resolved(doc, refs);
  // Validate the doc AS SWEPT: the swept param's stored default is overridden at every
  // sample, so validating it (e.g. a NaN default with a finite [min,max]) would force
  // every sample infeasible for a value no sample ever uses. Any finite stand-in works
  // structurally; min is one.
  const blocked =
    r.warnings.some((w) => w.severity === 'error') ||
    validateSheet(withParams(r.doc, { [param]: v.min })).some((w) => w.severity === 'error');
  const rules: SheetSweepRule[] = [];
  collectTreeRules(r.doc, '', rules);
  const x: number[] = [];
  const feasible: boolean[] = [];

  for (let i = 0; i < pts; i++) {
    const t = v.min + ((v.max - v.min) * i) / (pts - 1);
    x.push(t);
    const res = evaluateSheet(withParams(r.doc, { [param]: t }), table, resolveDevice);
    feasible.push(!blocked && res.feasible);
    const byPath = new Map<string, RuleResult>();
    indexTreeResults(res.rules, res.children, '', byPath);
    for (const r of rules) {
      const rr = byPath.get(r.id);
      r.marginPct.push(
        !rr || rr.status === 'na' || !Number.isFinite(rr.marginPct) ? null : rr.marginPct,
      );
    }
  }
  return { param, unit: v.unit ?? '', x, rules, feasible };
}

/** Default per-axis sample count for a 2-D sweep (samples² evaluations per call). */
export const SWEEP2_POINTS = 21;

/**
 * Trace a sheet across the 2-D grid of two parameters' slider ranges: the design-plane
 * feasibility map a 1-D cut cannot answer ("does any L hold the phase margin across the
 * whole gm_id range?"). Each infeasible cell also names the WORST failing hard rule —
 * walking the composition tree, so a child block's constraint is attributed by path.
 * Cost is n² full-tree evaluations (sub-millisecond each on real tables). Structural
 * validation runs once, with both swept params overridden. Pure; never throws.
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
  const r = resolved(doc, refs); // once — constant tree, only the two params move
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
      // Name the binding constraint: the failing HARD rule with the worst relative
      // margin anywhere in the tree. null when feasible, or when infeasibility came
      // from something other than a failing rule (bind error, child structural error).
      let worst: { id: string; m: number } | undefined;
      if (!res.feasible) {
        const byPath = new Map<string, RuleResult>();
        indexTreeResults(res.rules, res.children, '', byPath);
        for (const [id, rr] of byPath) {
          if (!isHardRule(rr.kind) || rr.status !== 'fail') continue;
          if (!worst || rr.marginPct < worst.m) worst = { id, m: rr.marginPct };
        }
      }
      brow.push(worst?.id ?? null);
    }
    feasible.push(frow);
    binding.push(brow);
  }
  return { ...empty, x, y, feasible, binding };
}
