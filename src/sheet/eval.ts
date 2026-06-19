// Evaluate a leaf design-sheet in ONE pass: seed params, (optionally) size the device
// via sizeDevice, then evaluate author rows in document order and check each rule into
// a signed-margin result. Reuses the expression engine (compileExpr), the bind-any-2
// sizing (sizeDevice), and the constant scope verbatim — it adds no numeric or parser
// logic and never traverses a circuit. Pure, deterministic, never throws. Zero DOM.

import type { DeviceTable, QAWarning, Scope, Value } from '../types';
import { CONSTANTS } from '../constants';
import { compileExpr } from '../derive';
import { sizeDevice, type SizeQuery } from '../device';
import { MAX_USE_DEPTH, joinProvide, prefixUseWarning } from './types';
import type {
  BindReport,
  RuleResult,
  RuleStatus,
  SheetBind,
  SheetChildReport,
  SheetDoc,
  SheetResult,
  SheetUse,
} from './types';

/** Resolve a device id to its lookup table (for a child `use` that names its own device).
 *  Absent ⇒ children inherit the parent's table. */
export type DeviceResolver = (id: string) => DeviceTable | undefined;

/** A rule passing by a smaller relative margin than this reads as a near-miss (amber). */
export const AMBER_BAND = 0.05; // 5% of the bound

/** Floor for the relative-margin denominator so a zero bound cannot divide by zero. */
const TINY = 1e-300;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A flat scalar scope over `values`. Unknown names return undefined and fall through
 * to the engine's constant map (so pi/k/T/gamma resolve). It closes over the mutated
 * `values`, so a row evaluated later sees values written by an earlier row.
 */
function scalarScope(values: Record<string, number>): Scope {
  return {
    resolve(name: string): Value | undefined {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
    },
  };
}

/**
 * Compile + evaluate one expression to a scalar against `scope`, or undefined when it
 * cannot resolve (parse error, an undeclared free name, an eval error, or — defensively
 * — an array result, which a scalar-only sheet scope never actually produces). Pushes a
 * warning for each failure. A finite-but-`Infinity`/`NaN` numeric result IS returned so
 * the caller can classify it (a row drops it; a rule side surfaces as `na`).
 */
function evalScalar(
  src: string,
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
  where: string,
): number | undefined {
  let compiled;
  try {
    compiled = compileExpr(src);
  } catch (e) {
    warn({ rule: 'sheet-parse', severity: 'error', message: `${where}: ${msg(e)}`, location: where });
    return undefined;
  }
  for (const n of compiled.names) {
    if (
      !Object.prototype.hasOwnProperty.call(values, n) &&
      !Object.prototype.hasOwnProperty.call(CONSTANTS, n)
    ) {
      warn({ rule: 'sheet-undeclared', severity: 'warning', message: `${where}: "${n}" is not defined`, location: where });
      return undefined;
    }
  }
  let v: Value;
  try {
    v = compiled.eval(scope);
  } catch (e) {
    warn({ rule: 'sheet-eval', severity: 'warning', message: `${where}: ${msg(e)}`, location: where });
    return undefined;
  }
  if (v instanceof Float64Array) {
    // ponytail: defensive — the sheet scope is scalar-only, so this never fires, but
    // the engine's Value type allows arrays, so we refuse one rather than mis-read it.
    warn({ rule: 'sheet-array', severity: 'warning', message: `${where}: expression is array-valued, expected a scalar`, location: where });
    return undefined;
  }
  return v;
}

/** Resolve the bind, call sizeDevice, and merge its operating point into `values`. */
function runBind(
  b: SheetBind,
  table: DeviceTable | undefined,
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
): BindReport {
  // Every bind failure surfaces an error warning AND an ok:false report, so the feasibility
  // aggregate fails closed no matter which path failed (no silent unsized "feasible" design).
  const fail = (error: string): BindReport => {
    warn({ rule: 'sheet-bind', severity: 'error', message: error, location: 'bind' });
    return { ok: false, W: NaN, vgs: NaN, id: NaN, error };
  };

  if (!table) return fail('no device to size against');

  const supplied = (['gm', 'gm_id', 'id'] as const).filter((k) => b[k] !== undefined);
  if (supplied.length !== 2) return fail(`bind needs exactly two of {gm, gm_id, id}, got ${supplied.length}`);

  const L = evalScalar(b.L, values, scope, warn, 'bind L');
  if (L === undefined || !Number.isFinite(L)) return fail('bind L did not resolve to a finite number');

  const q: SizeQuery = { table, L };
  for (const k of supplied) {
    const v = evalScalar(b[k] as string, values, scope, warn, `bind ${k}`);
    if (v === undefined || !Number.isFinite(v)) return fail(`bind ${k} did not resolve to a finite number`);
    q[k] = v;
  }

  try {
    const res = sizeDevice(q);
    Object.assign(values, res.quantities); // gm/gm_id/id/W/vgs/vstar/cgg/vnth_m/… at the point
    values.ceiling = res.ceiling; // not in the quantities bag
    values.feasible = res.feasible ? 1 : 0;
    return { ok: true, W: res.W, vgs: res.vgs, id: res.id };
  } catch (e) {
    return fail(`sizing failed: ${msg(e)}`);
  }
}

/** Evaluate one rule's two sides and classify into a signed-margin RuleResult. */
function evalRule(
  rule: SheetDoc['rules'][number],
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
): RuleResult {
  const text = `${rule.lhs} ${rule.op} ${rule.rhs}`;
  const lhs = evalScalar(rule.lhs, values, scope, warn, `rule "${rule.id}" lhs`);
  const rhs = evalScalar(rule.rhs, values, scope, warn, `rule "${rule.id}" rhs`);
  const lhsValue = lhs ?? NaN;
  const rhsValue = rhs ?? NaN;
  const base = { id: rule.id, kind: rule.kind, text, lhsValue, rhsValue };

  if (lhs === undefined || rhs === undefined || !Number.isFinite(lhs) || !Number.isFinite(rhs)) {
    return { ...base, margin: NaN, marginPct: NaN, status: 'na', detail: 'a side did not resolve to a finite number' };
  }

  let margin: number;
  if (rule.op === '>=') margin = lhs - rhs;
  else if (rule.op === '<=') margin = rhs - lhs;
  else {
    // '==' : the SIGNED distance INSIDE the tolerance band (≥ 0 ⟺ within tolerance ⟺ pass), so
    // the zero line is the real pass/fail boundary on the chart and in the margin column, exactly
    // like '>='/'<='. tolPct is relative to |rhs|, so it is inert when rhs is 0 (exact match only).
    margin = ((rule.tolPct ?? 0) / 100) * Math.abs(rhs) - Math.abs(lhs - rhs);
  }
  const marginPct = margin / Math.max(Math.abs(rhs), TINY);

  let status: RuleStatus;
  if (margin < 0) status = 'fail';
  else if (rule.op === '==') status = 'pass'; // '==' is pass/fail only — no near-miss (amber) band
  else status = marginPct < AMBER_BAND ? 'amber' : 'pass';
  return { ...base, margin, marginPct, status };
}

/**
 * Build a child doc with its param values overridden by expressions evaluated in the
 * PARENT scope (parent params + constants — children run before the parent's own bind,
 * so they do not see the parent's sized device; that reverse coupling is deferred).
 *
 * Fail-closed: a declared override is the parent EXPLICITLY supplying a value, so one that
 * cannot resolve to a finite number must NOT silently fall back to the child's embedded
 * default — that would size a different design than the author wired and could still read
 * feasible. A failed override raises an error (blocking feasibility) and returns ok:false
 * so the caller withholds the child's provides too.
 */
function applyUseParams(
  use: SheetUse,
  parentValues: Record<string, number>,
  parentScope: Scope,
  warn: (w: QAWarning) => void,
): { doc: SheetDoc; ok: boolean } {
  if (!use.params) return { doc: use.doc, ok: true };
  const overrides: Record<string, number> = {};
  let ok = true;
  for (const [k, expr] of Object.entries(use.params)) {
    const v = evalScalar(expr, parentValues, parentScope, warn, `use "${use.name}" param ${k}`);
    if (v === undefined || !Number.isFinite(v)) {
      ok = false;
      warn({ rule: 'sheet-use-param', severity: 'error', message: `use "${use.name}": override "${k}" did not resolve to a finite number (refusing to fall back to the child default)`, location: use.name });
      continue;
    }
    overrides[k] = v;
  }
  return {
    doc: {
      ...use.doc,
      params: use.doc.params.map((p) =>
        Object.prototype.hasOwnProperty.call(overrides, p.name) ? { ...p, value: overrides[p.name] } : p,
      ),
    },
    ok,
  };
}

/**
 * Evaluate each child block, merge its `provide`d scalars into the parent `values` as
 * flat `name__key` names, roll up its warnings (prefixed + attributed), and return a
 * per-child report. Runs BEFORE the parent's bind/rows so the parent can reference a
 * child's outputs anywhere — including its own bind (e.g. a cascode carrying the child's
 * current). Fail-closed: a child that errors or is infeasible drags the parent down via
 * the rolled-up error warning + the children-feasibility fold in evaluateSheet.
 */
function evalChildren(
  uses: SheetUse[],
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  depth: number,
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
): SheetChildReport[] {
  const reports: SheetChildReport[] = [];
  for (const use of uses) {
    if (depth >= MAX_USE_DEPTH) {
      warn({ rule: 'sheet-use', severity: 'error', message: `use "${use.name}": composition nested deeper than ${MAX_USE_DEPTH}`, location: use.name });
      reports.push({ name: use.name, title: use.doc.title, feasible: false, provides: {} });
      continue;
    }
    const { doc: childDoc, ok: paramsOk } = applyUseParams(use, values, scope, warn);
    const childTable = use.device !== undefined ? resolveDevice?.(use.device) : table;
    const res = evaluateSheet(childDoc, childTable, resolveDevice, depth + 1);

    // Roll up child warnings, attributed to the use site (so a child error fails the
    // parent's closed feasibility, and the message points at the offending block).
    for (const w of res.warnings) warn(prefixUseWarning(use.name, w));

    // Expose the child's declared `provide` names as flat parent scalars — but ONLY when the
    // parent wiring was honored (paramsOk). On a broken override the child sized with the wrong
    // input, so its outputs are meaningless: withhold them so dependent parent math goes `na`.
    const provides: Record<string, number> = {};
    if (paramsOk) {
      for (const key of use.doc.provide ?? []) {
        const v = res.values[key];
        if (v !== undefined && Number.isFinite(v)) {
          provides[key] = v;
          values[joinProvide(use.name, key)] = v;
        }
      }
    }
    reports.push({ name: use.name, title: use.doc.title, feasible: paramsOk && res.feasible, provides });
  }
  return reports;
}

/**
 * Evaluate a sheet against an optional device table. One pass, never throws: seed
 * params → (compose children) → size → author-order rows → signed-margin rules →
 * aggregate feasibility. A leaf (no `uses`) behaves exactly as before. `resolveDevice`
 * is only consulted by a child `use` that names its own device; `_depth` is internal.
 */
export function evaluateSheet(
  doc: SheetDoc,
  table?: DeviceTable,
  resolveDevice?: DeviceResolver,
  _depth = 0,
): SheetResult {
  const warnings: QAWarning[] = [];
  const warn = (w: QAWarning): void => void warnings.push(w);
  const values: Record<string, number> = {};

  // 1. Seed top-level scalar params (a parent supplies a child's via use.params).
  for (const p of doc.params) {
    if (Number.isFinite(p.value)) values[p.name] = p.value;
  }
  const scope = scalarScope(values); // closes over the mutated `values`

  // 2. Compose children FIRST, so the parent can reference their provided scalars
  //    (name__key) in its own bind/rows/rules.
  const children =
    doc.uses && doc.uses.length > 0
      ? evalChildren(doc.uses, table, resolveDevice, _depth, values, scope, warn)
      : undefined;

  // 3. Size the device — the ONLY place physics enters — when bound.
  const bind = doc.bind ? runBind(doc.bind, table, values, scope, warn) : undefined;

  // 4. Author rows, in document order; a row that cannot resolve is skipped, not fatal.
  for (const row of doc.rows) {
    const r = evalScalar(row.expr, values, scope, warn, `row "${row.name}"`);
    if (r === undefined) continue;
    if (!Number.isFinite(r)) {
      warn({ rule: 'sheet-nonfinite', severity: 'warning', message: `row "${row.name}" is not finite`, location: row.name });
      continue;
    }
    values[row.name] = r;
  }

  // 5. Rules → signed margins.
  const rules = doc.rules.map((rule) => evalRule(rule, values, scope, warn));

  // 6. Overall feasibility, fail-closed: a declared bind sized successfully, every HARD rule
  //    (invariant = physical floor, requirement = application spec) holds (pass or near-miss),
  //    EVERY child is feasible, and nothing errored. Guardrails are advisory and excluded.
  const hard = rules.filter((r) => r.kind === 'invariant' || r.kind === 'requirement');
  const feasible =
    (!doc.bind || (bind?.ok ?? false)) &&
    hard.every((r) => r.status === 'pass' || r.status === 'amber') &&
    (children?.every((c) => c.feasible) ?? true) &&
    !warnings.some((w) => w.severity === 'error');

  return { values, bind, rules, feasible, warnings, ...(children ? { children } : {}) };
}
