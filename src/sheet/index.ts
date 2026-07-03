// Public surface of the leaf design-sheet module. `runSheet` is the single entrypoint:
// it validates then evaluates, attaching the validation warnings — mirroring the
// importMostab discipline so a caller cannot skip validation.

import type { DeviceTable } from '../types';
import type { SheetDoc, SheetResult, SheetSweep, SheetSweepRule } from './types';
import { validateSheet } from './validate';
import { evaluateSheet, type DeviceResolver } from './eval';

export * from './types';
export * from './eval';
export * from './validate';
export * from './examples';

/** Validate + evaluate a sheet, merging validation warnings ahead of eval warnings. A
 *  validation error (e.g. a non-finite param, which eval silently skips, or a child block's
 *  structural error) also forces the feasibility verdict false, so a structurally broken
 *  sheet is never reported feasible. `validateSheet` and `evaluateSheet` both recurse into
 *  composed children, so the whole tree is covered. */
export function runSheet(
  doc: SheetDoc,
  table?: DeviceTable,
  resolveDevice?: DeviceResolver,
): SheetResult {
  const pre = validateSheet(doc);
  const res = evaluateSheet(doc, table, resolveDevice);
  const blocked = pre.some((w) => w.severity === 'error');
  return { ...res, feasible: res.feasible && !blocked, warnings: [...pre, ...res.warnings] };
}

/** Default sample count for a parameter sweep across its [min,max] bound. */
export const SWEEP_POINTS = 41;

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
): SheetSweep {
  const v = doc.params.find((p) => p.name === param);
  if (
    !v ||
    v.min === undefined ||
    v.max === undefined ||
    !Number.isFinite(v.min) ||
    !Number.isFinite(v.max) ||
    !(v.max > v.min)
  ) {
    return { param, unit: v?.unit ?? '', x: [], rules: [], feasible: [] };
  }

  const pts = Math.max(2, Math.min(401, Math.floor(n)));
  const blocked = validateSheet(doc).some((w) => w.severity === 'error');
  const rules: SheetSweepRule[] = doc.rules.map((r) => ({ id: r.id, kind: r.kind, marginPct: [] }));
  const x: number[] = [];
  const feasible: boolean[] = [];

  for (let i = 0; i < pts; i++) {
    const t = v.min + ((v.max - v.min) * i) / (pts - 1);
    x.push(t);
    const at: SheetDoc = {
      ...doc,
      params: doc.params.map((p) => (p.name === param ? { ...p, value: t } : p)),
    };
    const res = evaluateSheet(at, table, resolveDevice);
    feasible.push(!blocked && res.feasible);
    res.rules.forEach((rr, j) =>
      rules[j].marginPct.push(
        rr.status === 'na' || !Number.isFinite(rr.marginPct) ? null : rr.marginPct,
      ),
    );
  }
  return { param, unit: v.unit ?? '', x, rules, feasible };
}
