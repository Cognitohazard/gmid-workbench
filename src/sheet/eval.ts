// Evaluate a leaf design-sheet in ONE pass: seed params, (optionally) size the device
// via sizeDevice, then evaluate author rows in document order and check each rule into
// a signed-margin result. Reuses the expression engine (compileExpr), the bind-any-2
// sizing (sizeDevice), and the constant scope verbatim — it adds no numeric or parser
// logic and never traverses a circuit. Pure, deterministic, never throws. Zero DOM.

import { LOOKUP_RANGE_MESSAGE } from '../types';
import type { DeviceTable, QAWarning, Scope, Value } from '../types';
import { CONSTANTS } from '../constants';
import { compileExpr, metaScalars } from '../derive';
import { AXIS_DEFAULT_BIAS } from '../namespace';
import { scalarScope } from '../expr';
import { BINDABLE, bindProblem, sizeDevice, type SizeQuery } from '../device';
import { fixTable } from '../series';
import { diodeGrid } from '../grid';
import {
  BIAS_AXES,
  MAX_USE_DEPTH,
  PATH_SEP,
  engineSolved,
  isHardRule,
  joinProvide,
  pinProblem,
  pinned,
  prefixUseWarning,
  stands,
  torn,
  withParams,
} from './types';
import { pinHardware, type PinnedHardware } from './coverage';
import type {
  BindReport,
  RuleResult,
  RuleStatus,
  SheetBind,
  SheetChildReport,
  SheetDoc,
  SheetEdge,
  SheetEdgeReport,
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

/** Past this magnitude a relative margin carries no information — it came from the TINY
 *  clamp on a ~0 bound, not from the design. The ONE definition consumers (sweep
 *  aggregation, the UI's percentage formatter) share for "show no ratio here". */
export const MARGIN_PCT_CAP = 1e4;

/** Swallow diagnostics for a probe that is re-evaluated many times — the caller reports
 *  once, with its own message, instead of once per probe. */
const NO_WARN = (): void => {};

/**
 * Margins within this relative distance of zero snap to exactly 0. Two mechanisms park a
 * rule ON its own boundary by construction: a spec pinned by its own bind (bind
 * gm = 2π·GBW·CL, then rule GBW >= GBW_target) lands within floating-point rounding, and
 * a containment edge lands CM_in within the pin's landing tolerance of the very range end
 * the rule compares it against (PIN_TOL_REL x the bracket span, stretched by the
 * relation's slope — microvolts on a volt-scale node, ~1e-6 relative). Without the snap
 * either verdict is a coin flip. 1e-5 covers the pin case with margin while staying two
 * orders below the ~0.1% the sizer resolves between grid nodes — a rule "failing" by
 * less than the data can distinguish is not failing, it is sitting on the boundary,
 * and the snap reads it as the deterministic near-miss (amber) that it is.
 */
export const MARGIN_SNAP_REL = 1e-5;

/**
 * How far a declared gate wiring may disagree with the child's own vgs before it is reported.
 * ABSOLUTE and in the voltage domain, not relative: a relative tolerance would excuse a larger
 * error on a higher supply, where the node budget is no roomier. 10 mV is the resolution bias
 * plans are actually written to — designers round node levels to about that — and it sits an
 * order of magnitude below the real disagreements this check exists to catch (the three found
 * by hand were 41, 350 and 690 mV).
 */
export const WIRING_TOL = 0.01;

/** Passes a tearing loop may take and still be unremarkable. Above it the closure is weak or
 *  oscillatory — the designer's two-pass smell — which is worth a note even though the loop
 *  did close. Pins are excluded: bisection spends ~20 probes by construction, so a probe
 *  count carries no fragility signal there. */
const SOLVE_PASSES_NOTE = 16;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** An expression that is nothing but a decimal number — exactly the spellings `String` emits
 *  for a finite value, plus a leading sign. Deliberately narrower than `Number`, which also
 *  accepts hex, binary and `Infinity` literals the expression grammar need not share. */
const NUMERIC_LITERAL = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

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
  // A bare number is its own value: it compiles to itself and has no free names, so the whole
  // path below is a no-op for it. Worth short-circuiting because the coverage transformation
  // MINTS such sources (see coverage.ts numExpr), one per solved geometry per sample, and each
  // one is a permanent entry in the compile memo that can never be hit again. Anything the
  // pattern does not cover — a non-decimal spelling, a value that overflows to infinity — falls
  // through to the parser, which stays the authority on what the grammar accepts.
  if (NUMERIC_LITERAL.test(src)) {
    const lit = Number(src);
    if (Number.isFinite(lit)) return lit;
  }
  let compiled;
  try {
    compiled = compileExpr(src);
  } catch (e) {
    warn({
      rule: 'sheet-parse',
      severity: 'error',
      message: `${where}: ${msg(e)}`,
      location: where,
    });
    return undefined;
  }
  for (const n of compiled.names) {
    if (
      !Object.prototype.hasOwnProperty.call(values, n) &&
      !Object.prototype.hasOwnProperty.call(CONSTANTS, n)
    ) {
      warn({
        rule: 'sheet-undeclared',
        severity: 'warning',
        message: `${where}: "${n}" is not defined`,
        location: where,
        symbol: n,
      });
      return undefined;
    }
  }
  let v: Value;
  try {
    v = compiled.eval(scope);
  } catch (e) {
    warn({
      rule: 'sheet-eval',
      severity: 'warning',
      message: `${where}: ${msg(e)}`,
      location: where,
    });
    return undefined;
  }
  if (v instanceof Float64Array) {
    // defensive — the sheet scope is scalar-only, so this never fires, but
    // the engine's Value type allows arrays, so we refuse one rather than mis-read it.
    warn({
      rule: 'sheet-array',
      severity: 'warning',
      message: `${where}: expression is array-valued, expected a scalar`,
      location: where,
    });
    return undefined;
  }
  return v;
}

/**
 * Memoized single-axis slice. fixTable re-interpolates every quantity column, and a
 * sweep re-slices the SAME table at the SAME constant bias for every sample — up to n²
 * evaluations per render doing identical full-grid work. Keyed weakly by the source
 * table (chained vds→vsb slices hit because a cached first slice returns the identical
 * object). fixTable is pure, so a hit is referentially transparent. Bounded: sweeping a
 * BIAS param mints one full-grid slice per sample, and an unbounded cache would hold
 * tens of MB — at the cap the least-recently-used entry is evicted, never the whole map:
 * solver probes mint a unique key per pass, and flushing wholesale threw out the
 * constant-bias slices (e.g. vsb=0) that hit on every probe — measured at 11% of a
 * sweep's fixTable work redone.
 */
const SLICE_CACHE = new WeakMap<DeviceTable, Map<string, unknown>>();
const SLICE_CACHE_CAP = 64;

/** Memoize any pure table→table collapse under `key`, per source table. */
function collapsed<T>(t: DeviceTable, key: string, make: () => T): T {
  let m = SLICE_CACHE.get(t);
  if (!m) {
    m = new Map();
    SLICE_CACHE.set(t, m);
  }
  const hit = m.get(key);
  if (hit !== undefined) {
    // Re-insert so insertion order tracks recency and the cap evicts the coldest entry.
    m.delete(key);
    m.set(key, hit);
    return hit as T;
  }
  if (m.size >= SLICE_CACHE_CAP) m.delete(m.keys().next().value as string);
  const out = make();
  m.set(key, out);
  return out;
}

const fixAxisCached = (t: DeviceTable, axis: string, v: number): DeviceTable =>
  collapsed(t, `${axis}=${v}`, () => fixTable(t, { [axis]: v }));

/** The diode diagonal — same memo, same reason: a sweep re-folds the SAME table for every
 *  sample, and the fold re-interpolates every quantity column. Carries the fold's own clamp
 *  report along with the table, so a caller cannot hold one without the other. */
const diodeTableCached = (t: DeviceTable): { table: DeviceTable; clamped: boolean } =>
  collapsed(t, 'diode', () => {
    const f = diodeGrid(t.grid);
    return { table: { ...t, grid: f.grid }, clamped: f.clamped };
  });

/**
 * Collapse the table's bias axes (vds/vsb) to the operating point before sizing: a value
 * DECLARED in the bind wins; a live axis the bind does not declare takes the namespace
 * default when the table characterizes that point, and is reported as ASSUMED so the
 * coordinate is never silently invented; with neither, the axis stays live and sizing fails
 * with guidance. Returns the sliced table, the applied coordinates, and which of them were
 * assumed rather than authored — all three reach the BindReport.
 */
function applyBindBias(
  b: SheetBind,
  table: DeviceTable,
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
):
  | { table: DeviceTable; bias: Record<string, number>; assumed: string[] }
  | { error: string; needs?: string[] } {
  let t = table;
  const bias: Record<string, number> = {};
  const needs: string[] = [];
  const assumed: string[] = [];
  const slice = (axis: string, live: { values: ArrayLike<number> }, v: number): number => {
    const lo = live.values[0];
    const hi = live.values[live.values.length - 1];
    const applied = v < lo ? lo : v > hi ? hi : v;
    t = fixAxisCached(t, axis, applied);
    bias[axis] = applied;
    return applied;
  };
  // A diode connection is resolved BEFORE the per-axis loop: it collapses vds without being
  // given a coordinate, because the wiring supplies one that moves with vgs. The applied value
  // then varies across the slice, so `bias.vds` would be a single number that is true nowhere —
  // the report says "diode" instead, which is the whole content of the operating point here.
  if (b.diode) {
    const live = t.grid.axes.find((a) => a.name === 'vds' && a.values.length > 1);
    if (live) {
      const fold = diodeTableCached(t);
      // Say it out loud when the diagonal cannot be followed everywhere: past the characterized
      // vds range the fold reads the table's edge, so a diode biased up there is reported at a
      // drop the data never measured. Silently clamping is exactly what this project does not do.
      if (fold.clamped)
        warn({
          rule: 'sheet-bind',
          severity: 'warning',
          message:
            `diode connection: the vgs sweep runs outside the characterized vds range, so the ` +
            `vds = vgs diagonal is clamped to the table's edge where it does. A drop landing in ` +
            `that region is read from data taken at a different vds`,
          location: 'bind',
        });
      t = fold.table;
    } else
      warn({
        rule: 'sheet-bind',
        severity: 'warning',
        message:
          'bind declares a diode connection, but the table has no live vds axis to fold onto the ' +
          'vds = vgs diagonal — using the table as-is',
        location: 'bind',
      });
  }

  for (const axis of BIAS_AXES) {
    if (axis === 'vds' && b.diode) continue; // the connection already fixed it
    const live = t.grid.axes.find((a) => a.name === axis && a.values.length > 1);
    // BIAS_AXES is namespace-derived (dynamic strings), while SheetBind's declared bias
    // fields are static — index structurally rather than by the literal key union.
    const declared = (b as unknown as Partial<Record<string, string>>)[axis];
    if (declared !== undefined) {
      const v = evalScalar(declared, values, scope, warn, `bind ${axis}`);
      if (v === undefined || !Number.isFinite(v))
        return { error: `bind ${axis} did not resolve to a finite number` };
      if (!live) {
        // The declaration is an assertion the table cannot honor (axis absent or already
        // collapsed — possibly at a DIFFERENT point we cannot see). Advisory, not fatal.
        warn({
          rule: 'sheet-bind',
          severity: 'warning',
          message: `bind ${axis} = ${v} declared, but the table has no live ${axis} axis to slice — using the table as-is`,
          location: 'bind',
        });
        continue;
      }
      // sliceGrid clamps to the hull; apply the clamp HERE so the report and the slice
      // agree — recording the requested value would show an operating point the sizing
      // never used. The requested value survives in the warning only.
      const applied = slice(axis, live, v);
      if (applied !== v) {
        warn({
          rule: 'sheet-bind',
          severity: 'warning',
          message: `bind ${axis} ${v} is outside the table's ${axis} range [${live.values[0]}, ${live.values[live.values.length - 1]}]; clamped to ${applied}`,
          location: 'bind',
        });
      }
    } else if (live) {
      // Undeclared, but the table has this axis live. An axis the namespace gives a safe default
      // (vsb = 0, body-grounded) takes it — but ONLY when the table characterizes that point: if
      // the default is outside the swept range, it is not honest (slice would silently clamp to the
      // nearest slice), so fail closed like vds and make the author pin a real value.
      const def = AXIS_DEFAULT_BIAS.get(axis);
      const lo = live.values[0];
      const hi = live.values[live.values.length - 1];
      if (def !== undefined && lo <= def && def <= hi) {
        slice(axis, live, def);
        // Assumed, not authored — reported rather than warned; see BindReport.assumed.
        assumed.push(axis);
      } else needs.push(axis);
    }
  }
  if (needs.length) {
    const list = needs.join(', ');
    return {
      error: `declare the operating point (${list}) in the bind — the table has ${
        needs.length > 1 ? 'those axes' : 'that axis'
      } and sizing must pin ${needs.length > 1 ? 'them' : 'it'} to a value`,
      needs,
    };
  }
  return { table: t, bias, assumed };
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
  const fail = (error: string, needs?: string[]): BindReport => {
    warn({ rule: 'sheet-bind', severity: 'error', message: error, location: 'bind' });
    return {
      ok: false,
      W: NaN,
      L: NaN,
      vgs: NaN,
      id: NaN,
      error,
      ...(needs?.length ? { needs } : {}),
    };
  };

  if (!table) return fail('no device to size against');

  const supplied = BINDABLE.filter((k) => b[k] !== undefined);
  const problem = bindProblem(supplied);
  if (problem) return fail(`bind ${problem}`);

  const L = evalScalar(b.L, values, scope, warn, 'bind L');
  if (L === undefined || !Number.isFinite(L))
    return fail('bind L did not resolve to a finite number');

  const sliced = applyBindBias(b, table, values, scope, warn);
  if ('error' in sliced) return fail(sliced.error, sliced.needs);

  const q: SizeQuery = { table: sliced.table, L };
  for (const k of supplied) {
    const v = evalScalar(b[k] as string, values, scope, warn, `bind ${k}`);
    if (v === undefined || !Number.isFinite(v))
      return fail(`bind ${k} did not resolve to a finite number`);
    q[k] = v;
  }

  try {
    const res = sizeDevice(q);
    Object.assign(values, res.quantities); // gm/gm_id/id/W/vgs/vstar/cgg/vnth_m/… at the point
    values.ceiling = res.ceiling; // not in the quantities bag
    values.feasible = res.feasible ? 1 : 0;
    // Surface the sizer's own engineering notes (e.g. an L clamped onto the table's
    // hull) as advisory sheet warnings — same pattern children use at evalChildren.
    // Severity 'warning', not 'error', so a clamp does not flip feasibility closed.
    for (const m of res.warnings) {
      warn({ rule: 'sheet-bind', severity: 'warning', message: m, location: 'bind' });
    }
    const report: BindReport = { ok: true, W: res.W, L, vgs: res.vgs, id: res.id };
    if (Object.keys(sliced.bias).length) report.bias = sliced.bias;
    if (sliced.assumed.length) report.assumed = sliced.assumed;
    return report;
  } catch (e) {
    let m = msg(e);
    // The lookup's "extra non-degenerate axis" error is accurate but not actionable in
    // sheet vocabulary — point the author at the fix.
    if (m.includes('non-degenerate axis'))
      m += ' — declare the operating point in the bind (vds/vsb) to collapse the axis';
    return fail(`sizing failed: ${m}`);
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
  const base = { id: rule.id, kind: rule.kind, op: rule.op, text, lhsValue, rhsValue };

  if (lhs === undefined || rhs === undefined || !Number.isFinite(lhs) || !Number.isFinite(rhs)) {
    return {
      ...base,
      margin: NaN,
      marginPct: NaN,
      rawMargin: NaN,
      status: 'na',
      detail: 'a side did not resolve to a finite number',
    };
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
  // The operands are finite (guarded above) but the margin itself may not be — a
  // non-finite tolPct poisons the '==' arithmetic, and NaN compares false against 0,
  // which would read as a silent pass. A margin that did not compute is `na`, never pass.
  if (!Number.isFinite(margin)) {
    return {
      ...base,
      margin: NaN,
      marginPct: NaN,
      rawMargin: NaN,
      status: 'na',
      detail: 'margin did not compute to a finite number (check tolPct)',
    };
  }
  // Kept before the snap: the verdict wants the snapped value, a DERIVATIVE wants the honest
  // one (see RuleResult.rawMargin).
  const rawMargin = margin;
  // see MARGIN_SNAP_REL — a bind-pinned spec must not coin-flip on FP noise
  const snapped =
    margin !== 0 && Math.abs(margin) <= MARGIN_SNAP_REL * Math.max(Math.abs(lhs), Math.abs(rhs));
  if (snapped) margin = 0;
  const marginPct = margin / Math.max(Math.abs(rhs), TINY);

  let status: RuleStatus;
  if (margin < 0) status = 'fail';
  else if (snapped)
    // A SNAPPED zero always reads amber, whatever the operator: the rule is sitting on
    // its boundary by construction, and for '==' the alternative would be worse than a
    // coin flip — a margin just OUTSIDE the tolerance band silently reading full pass.
    status = 'amber';
  else if (rule.op === '==')
    status = 'pass'; // '==' is pass/fail only — no near-miss (amber) band
  else status = marginPct < AMBER_BAND ? 'amber' : 'pass';
  return { ...base, margin, marginPct, rawMargin, status };
}

/**
 * Build a child doc with its param values overridden by expressions evaluated in the
 * PARENT scope as built so far: parent params, constants, and the provides of EARLIER
 * siblings (children evaluate in document order — the ratified idiom for a later block
 * carrying a value an earlier block derived, e.g. binding a spec exactly on the input
 * device and feeding the derived current to the branch blocks). Children run before
 * the parent's own bind, so they never see the parent's sized device (that reverse
 * coupling stays deferred), and a forward sibling reference fails closed as undeclared.
 *
 * Fail-closed: a declared override is the parent EXPLICITLY supplying a value, so one that
 * cannot resolve to a finite number must NOT silently fall back to the child's embedded
 * default — that would size a different design than the author wired and could still read
 * feasible. A failed override raises an error (blocking feasibility) and returns ok:false
 * so the caller withholds the child's provides too.
 */
function applyUseParams(
  use: SheetUse,
  childDoc: SheetDoc,
  parentValues: Record<string, number>,
  parentScope: Scope,
  warn: (w: QAWarning) => void,
): { doc: SheetDoc; ok: boolean } {
  if (!use.params) return { doc: childDoc, ok: true };
  const childParams = new Map(childDoc.params.map((p) => [p.name, p]));
  const overrides: Record<string, number> = {};
  let ok = true;
  for (const [k, expr] of Object.entries(use.params)) {
    // An override key that names no child param is the same failure as an unresolvable
    // one: the parent explicitly supplied a value (typo and all) that will NOT reach the
    // child, so the child would size a different design than the author wired — and its
    // embedded default could still read feasible. Fail closed, by name.
    const child = childParams.get(k);
    if (child === undefined) {
      ok = false;
      warn({
        rule: 'sheet-use-param',
        severity: 'error',
        message: `use "${use.name}": override "${k}" does not match any child param (refusing to size the child on its embedded defaults)`,
        location: use.name,
      });
      continue;
    }
    // Overriding a param the CHILD solves for only moves its starting guess — the fixed point
    // decides the value, so the number the parent wired is not the one the child uses. Say so:
    // silently demoting an explicit wiring to a hint is the same class of surprise the
    // unmatched-key error above exists to prevent, and this one is easy to write by accident.
    if (torn(child)) {
      warn({
        rule: 'sheet-use-param',
        severity: 'warning',
        message: `use "${use.name}": override "${k}" sets a param the child solves for, so it only seeds the iteration — the converged value wins`,
        location: use.name,
      });
    }
    // A pinned param is stronger still: bisection needs no seed, so the wired value does nothing.
    if (pinned(child)) {
      warn({
        rule: 'sheet-use-param',
        severity: 'warning',
        message: `use "${use.name}": override "${k}" sets a param the child PINS — the engine chooses it from the pin's own bracket, so the override is ignored entirely`,
        location: use.name,
      });
    }
    const v = evalScalar(expr, parentValues, parentScope, warn, `use "${use.name}" param ${k}`);
    if (v === undefined || !Number.isFinite(v)) {
      ok = false;
      warn({
        rule: 'sheet-use-param',
        severity: 'error',
        message: `use "${use.name}": override "${k}" did not resolve to a finite number (refusing to fall back to the child default)`,
        location: use.name,
      });
      continue;
    }
    overrides[k] = v;
  }
  return {
    doc: {
      ...childDoc,
      params: childDoc.params.map((p) =>
        Object.prototype.hasOwnProperty.call(overrides, p.name)
          ? { ...p, value: overrides[p.name] }
          : p,
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
  budget: SolveBudget,
): SheetChildReport[] {
  const reports: SheetChildReport[] = [];
  // Structural self-defense for direct evaluateSheet callers (runSheet validates, but
  // this entrypoint is public): a duplicate or empty use name would silently overwrite
  // the earlier sibling's provides — skip it, fail closed.
  const seenNames = new Set<string>();
  for (const use of uses) {
    const dead = (message: string): void => {
      warn({ rule: 'sheet-use', severity: 'error', message, location: use.name });
      reports.push({
        name: use.name,
        title: use.doc?.title ?? use.ref ?? '',
        feasible: false,
        provides: {},
        rules: [],
      });
    };
    if (!use.name.trim()) {
      dead('a use has an empty name');
      continue;
    }
    // A ref that reached evaluation unmaterialized (the caller skipped resolveSheetRefs,
    // or resolution failed and already named why) must never size on nothing.
    const srcDoc = use.doc;
    if (!srcDoc) {
      dead(
        use.ref !== undefined
          ? `use "${use.name}": unresolved reference "${use.ref}" — resolve against a sheet library before evaluation`
          : `use "${use.name}" has neither an embedded doc nor a ref`,
      );
      continue;
    }
    if (seenNames.has(use.name)) {
      dead(`duplicate use name "${use.name}" — the block was skipped, not silently merged`);
      continue;
    }
    seenNames.add(use.name);
    if (depth >= MAX_USE_DEPTH) {
      dead(`use "${use.name}": composition nested deeper than ${MAX_USE_DEPTH}`);
      continue;
    }
    // A child names its own device id (else it inherits the parent table). A named device that the
    // resolver cannot supply fails closed with a clear, attributed message — rather than the generic
    // "no device to size against" the bind would otherwise raise.
    let childTable = table;
    if (use.device !== undefined) {
      childTable = resolveDevice?.(use.device);
      if (childTable === undefined) {
        dead(`use "${use.name}": device "${use.device}" did not resolve`);
        continue;
      }
    }

    const { doc: childDoc, ok: paramsOk } = applyUseParams(use, srcDoc, values, scope, warn);
    // evaluateNode, not evaluateSheet: a composed child never evaluates its own edges —
    // the parent owns range claims (validation says so at the use site).
    const res = evaluateNode(childDoc, childTable, resolveDevice, depth + 1, budget);

    // Roll up child warnings, attributed to the use site (so a child error fails the
    // parent's closed feasibility, and the message points at the offending block).
    for (const w of res.warnings) warn(prefixUseWarning(use.name, w));

    // Expose the child's declared `provide` names as flat parent scalars — but ONLY when the
    // parent wiring was honored (paramsOk). On a broken override the child sized with the wrong
    // input, so its outputs are meaningless: withhold them so dependent parent math goes `na`.
    const provides: Record<string, number> = {};
    if (paramsOk) {
      for (const key of srcDoc.provide ?? []) {
        const v = res.values[key];
        if (v !== undefined && Number.isFinite(v)) {
          provides[key] = v;
          values[joinProvide(use.name, key)] = v;
        }
      }
    }
    reports.push({
      name: use.name,
      title: srcDoc.title,
      feasible: paramsOk && res.feasible,
      ...(res.bind ? { bind: res.bind } : {}),
      provides,
      rules: res.rules,
      ...(res.children ? { children: res.children } : {}),
    });
  }
  return reports;
}

/**
 * Check every child use that DECLARES its gate wiring against the identity that wiring imposes:
 * the gate sits one gate-source voltage from the source, above it for an N device and below it
 * for a P one (see SheetWiring). Runs once, on the FINAL result of a node — after any pin or
 * tearing solve, and after the parent's own rows, so a node the sheet defines as a row is as
 * reachable as one it defines as a param, and a solver's probes never spam the diagnostic.
 *
 * The voltage compared against is the child's own BIND — the sizing's answer, which the sizing
 * always has — not a scalar the child publishes upward. That is what keeps the check
 * unswitchoffable: no `provide` list, no parent expression, and no sign convention stands
 * between the declaration and the number it is checked against.
 *
 * A sheet that also claims operating ranges reports the disagreement once per RUN — the base
 * evaluation plus each containment edge, whose warnings ride its own report verbatim. That is
 * intended: an edge holds the SAME hardware at a different bias, and the identity is a statement
 * about voltages, so the residual there is a different measurement for a different reason — not
 * a duplicate of the first. A wiring declaration that holds at the center and breaks at a range
 * end is exactly the finding worth having twice.
 *
 * A DEDICATED evaluator, deliberately: every runtime problem here — an expression that does not
 * resolve, a block with no sized operating point, a disagreement past WIRING_TOL — is a
 * warning-severity 'sheet-wiring' diagnostic and nothing more. It never throws, never touches
 * feasibility, and never repairs anything. A wiring declaration describes the schematic the
 * author drew; when it disagrees with the sizing, which of the two is wrong is the author's
 * call, and an author who wants the disagreement to GATE writes a hard rule on the same numbers.
 * (Structural problems — a half-declaration, an unknown key, an expression that does not parse —
 * are validation errors, which is the only way wiring reaches a verdict.)
 */
function checkWiring(doc: SheetDoc, res: SheetResult): SheetResult {
  // Shape-guarded rather than trusted: evaluate never throws, so a malformed authored doc
  // (uses as a string, wiring as a string) has to degrade to "nothing to check".
  const uses = Array.isArray(doc.uses) ? doc.uses : [];
  const out: QAWarning[] = [];
  const scope = scalarScope(res.values);
  const sized = new Map((res.children ?? []).map((c) => [c.name, c.bind]));
  for (const use of uses) {
    // Read as `unknown`: a persisted doc reaches evaluation unverified, and the shape checks
    // below are the same ones validate.ts reports on — stated here in the types, not assumed.
    const w: unknown = use?.wiring;
    if (typeof w !== 'object' || w === null) continue;
    const decl = w as Record<string, unknown>;
    const where = `use "${use.name}" wiring`;
    const warn = (message: string): void => {
      out.push({ rule: 'sheet-wiring', severity: 'warning', message, location: use.name });
    };
    // A use the evaluation already killed — an unresolved ref, a device that did not resolve, an
    // override that would not evaluate, a bind that could not size — has no operating point to
    // check against, and the reason is already reported. A second line advising a fix to the
    // wiring would be noise stacked on the finding, and worse, advice about the wrong thing. The
    // prefix match is what makes that true for a child's INTERNAL errors: they roll up to this
    // use under its path (`<use>.bind`, `<use>.<inner>`), not under the bare use name. That
    // path spelling is a contract with ONE owner — prefixUseWarning (types.ts) — so this match
    // moves if and only if that function does.
    if (
      res.warnings.some(
        (v) =>
          v.severity === 'error' &&
          (v.location === use.name || (v.location ?? '').startsWith(use.name + PATH_SEP)),
      )
    )
      continue;
    // The sized gate-source voltage first: without it there is no identity to form, and reporting
    // each expression separately as well would turn one unsized block into three warnings.
    const vgs = sized.get(use.name)?.vgs;
    if (vgs === undefined || !Number.isFinite(vgs)) {
      warn(
        `${where}: the block declares no bind, so it has no sized gate-source voltage for the ` +
          `wiring identity to be checked against`,
      );
      continue;
    }
    /** One wiring expression against the final scope. Diagnostics are swallowed (NO_WARN) and
     *  re-raised here: this evaluator emits 'sheet-wiring' warnings only, never the parse
     *  errors evalScalar would otherwise push at error severity. */
    const at = (src: unknown, key: string): number | undefined => {
      if (typeof src !== 'string') {
        warn(`${where}: ${key} is not an expression`);
        return undefined;
      }
      const v = evalScalar(src, res.values, scope, NO_WARN, where);
      if (v === undefined || !Number.isFinite(v)) {
        warn(`${where}: ${key} "${src}" did not resolve to a finite number — cannot check`);
        return undefined;
      }
      return v;
    };
    const gate = at(decl.gate, 'gate');
    const source = at(decl.source, 'source');
    if (gate === undefined || source === undefined) continue;
    // Magnitude plus direction, never the raw axis value: the sign lives in the child's declared
    // polarity, so a signed PMOS export and one in N convention check identically.
    const expected = source + (use.doc?.polarity === 'p' ? -1 : 1) * Math.abs(vgs);
    const delta = gate - expected;
    if (Math.abs(delta) > WIRING_TOL) {
      warn(
        `${where}: gate reads ${gate.toExponential(4)} V but the block's source and its own ` +
          `sized V_GS put that node at ${expected.toExponential(4)} V — they describe the same ` +
          `node, so the design is sized at one voltage and wired at another (delta ` +
          `${delta.toExponential(3)} V, tolerance ${WIRING_TOL} V)`,
      );
    }
  }
  return out.length ? { ...res, warnings: [...res.warnings, ...out] } : res;
}

/**
 * One evaluation pass. `solved` overrides the seeded value of a tearing-variable param
 * (see SheetVar.solveFor); everything else behaves as if the doc had those values.
 */
function evaluateOnce(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  _depth: number,
  budget: SolveBudget,
  solved?: Record<string, number>,
): SheetResult {
  const warnings: QAWarning[] = [];
  const warn = (w: QAWarning): void => void warnings.push(w);
  const values: Record<string, number> = {};

  // 0. Device-metadata scalars — the same scope derive/tableScope uses: T/UT (so
  //    temperature-aware author math and the γ-model noise evaluate at the table's
  //    characterization temperature) and the characterization width `w`. Seeded
  //    before params, so a same-named param deliberately wins.
  if (table) Object.assign(values, metaScalars(table.meta));

  // 1. Seed top-level scalar params (a parent supplies a child's via use.params). A param
  //    being solved for takes the current iterate in place of its authored starting guess.
  for (const p of doc.params) {
    const v = solved?.[p.name] ?? p.value;
    if (Number.isFinite(v)) values[p.name] = v;
  }
  const scope = scalarScope(values); // closes over the mutated `values`

  // 2. Compose children FIRST, so the parent can reference their provided scalars
  //    (name__key) in its own bind/rows/rules.
  const children =
    doc.uses && doc.uses.length > 0
      ? evalChildren(doc.uses, table, resolveDevice, _depth, values, scope, warn, budget)
      : undefined;

  // 3. Size the device — the ONLY place physics enters — when bound.
  const bind = doc.bind ? runBind(doc.bind, table, values, scope, warn) : undefined;

  // 4. Author rows, in document order. A row that cannot RESOLVE (missing quantity,
  //    parse error) is skipped with a plain warning — graceful degradation for optional
  //    data. A row that resolves but computes NON-FINITE from finite inputs (sqrt of a
  //    negative headroom, a division by zero) means the design math itself broke at this
  //    point, so it is an error: feasibility must fail closed even when no hard rule
  //    happens to reference the row (a guardrail-only figure of merit would otherwise
  //    render a green verdict over a NaN).
  for (const row of doc.rows) {
    const r = evalScalar(row.expr, values, scope, warn, `row "${row.name}"`);
    if (r === undefined) continue;
    if (!Number.isFinite(r)) {
      warn({
        rule: 'sheet-nonfinite',
        severity: 'error',
        message: `row "${row.name}" evaluated to a non-finite number from resolved inputs`,
        location: row.name,
      });
      continue;
    }
    values[row.name] = r;
  }

  // 5. Rules → signed margins.
  const rules = doc.rules.map((rule) => evalRule(rule, values, scope, warn));

  // 6. Overall feasibility, fail-closed: a declared bind sized successfully, every HARD rule
  //    (invariant = physical floor, requirement = application spec) holds (pass or near-miss),
  //    EVERY child is feasible, and nothing errored. Guardrails are advisory and excluded.
  const hard = rules.filter((r) => isHardRule(r.kind));
  const feasible =
    // A bound sheet needs the sizing to have succeeded AND the sizer's own verdict
    // (gm/ID ≤ the data ceiling) to hold — today the sizer throws past the ceiling, so
    // the flag is belt-and-suspenders, but it must never be silently ignored.
    (!doc.bind || ((bind?.ok ?? false) && values.feasible !== 0)) &&
    hard.every((r) => r.status === 'pass' || r.status === 'amber') &&
    (children?.every((c) => c.feasible) ?? true) &&
    !warnings.some((w) => w.severity === 'error');

  // `closes` starts life equal to `feasible` and is left alone by the edge fold below —
  // that fold is the ONLY place the two are allowed to diverge.
  return {
    values,
    bind,
    rules,
    feasible,
    closes: feasible,
    warnings,
    ...(children ? { children } : {}),
  };
}

/**
 * Convergence tolerance for a tearing variable, relative. Five orders below the ~0.1% the
 * sizer itself resolves an operating point to between grid nodes, so it is far finer than the
 * data can justify while still being cheap to reach.
 */
export const SOLVE_TOL_REL = 1e-7;
// Applied purely RELATIVELY, deliberately with no absolute floor. The core is SI throughout, so
// a tearing variable is as likely to be a capacitance (~1e-15 F) as a voltage; any fixed
// absolute floor is met instantly at the small end and would report a wildly wrong estimate as
// converged, which is precisely the failure this whole mechanism exists to prevent. The cost is
// that an estimate whose fixed point is exactly zero only settles once two iterates are
// bit-identical, so it runs to the cap and fails closed — the safe direction, and a bias
// estimate converging to exactly zero is degenerate anyway.

/**
 * Passes one tearing loop may take. Any finite cap rejects a contraction slow enough to need
 * more (here |f'| above ~1 - ln(SOLVE_TOL_REL)/PASSES, about 0.97), so the cap cannot be the
 * divergence test — a loop stopped here may have been converging the whole time, and the
 * message says so rather than blaming the author. Real bias loops sit far from that edge; the
 * library's 5T input-bias loop measures |f'| well under 0.2.
 *
 * It doubles as the per-loop share of the tree-wide budget below, which is simply this times
 * the number of loops — so one loop cannot spend another's allowance.
 */
const SOLVE_PASSES_PER_LOOP = 500;

/** Consecutive increases of the error measure that count as divergence, not a transient wobble. */
const SOLVE_DIVERGING = 4;

/**
 * Smallest under-relaxation factor the solver will fall back to. Plain substitution steps the
 * whole way to the value the sheet resolved (factor 1) and converges only where the loop map
 * contracts; a loop that OVERSHOOTS instead settles into a two-cycle, bouncing between the same
 * pair of values forever — no pass budget rescues that, since it is not converging slowly, it is
 * not converging at all. Stepping only part of the way turns the overshoot into a contraction.
 * A loop that runs away monotonically is unaffected by any factor and still gets caught as
 * divergent, so damping costs no detection.
 */
const SOLVE_DAMP_MIN = 1 / 64;

/** Per-pass error ratio that still counts as real progress; anything slower reads as a stall. */
const SOLVE_PROGRESS = 0.99;

/**
 * The pass budget shared across one composed evaluation, counted in SOLVE PASSES — iterations of
 * a tearing loop — and not in sheet evaluations. Those differ by the size of the tree: a pass of a
 * three-child sheet evaluates four documents, so charging per evaluation quietly handed that sheet
 * a quarter of the passes the constant promises, and a wider one less still. Iterations a loop
 * needs do not shrink because the design has more blocks in it.
 */
interface SolveBudget {
  left: number;
}

/**
 * How many sheets in this tree tear a loop. The shared budget scales with it, so that nesting —
 * which multiplies passes, since a parent iteration re-converges each child — still runs into a
 * ceiling, while BREADTH costs only linearly. A flat budget made feasibility non-compositional:
 * eight sibling loops that each pass alone would see the last few fail for want of budget, with
 * blame landing by document order.
 */
function tornSheets(doc: SheetDoc, depth = 0): number {
  if (depth >= MAX_USE_DEPTH) return 0;
  // A pinned sheet runs a solver too (bisection probes are passes); count each mechanism.
  let n = (doc.params.some(torn) ? 1 : 0) + (doc.params.some(pinned) ? 1 : 0);
  for (const u of doc.uses ?? []) if (u.doc) n += tornSheets(u.doc, depth + 1);
  return n;
}

/**
 * A loop that DID close, but only after SOLVE_PASSES_NOTE passes. Informational: the design is
 * sized and the verdict stands, so nothing about feasibility changes — but a loop that needs
 * that many substitutions is contracting weakly or oscillating into place, and either is worth
 * a look before the sheet is trusted at a different operating point. Whether the step had to be
 * damped separates the two, so it rides along.
 */
function slowClosure(res: SheetResult, passes: number, damp: number): SheetResult {
  return {
    ...res,
    warnings: [
      ...res.warnings,
      {
        rule: 'sheet-solve',
        severity: 'info',
        message:
          `bias loop needed ${passes} substitution passes — inspect weak or oscillatory ` +
          `closure` +
          (damp < 1 ? ` (the step was damped to ${damp} to stop it overshooting)` : ''),
      },
    ],
  };
}

/** The evaluation, marked infeasible and carrying one more error warning. */
function solveFailed(res: SheetResult, message: string): SheetResult {
  return {
    ...res,
    feasible: false,
    closes: false,
    warnings: [...res.warnings, { rule: 'sheet-solve', severity: 'error', message }],
  };
}

/**
 * Evaluate a sheet against an optional device table. Never throws: seed params → (compose
 * children) → size → author-order rows → signed-margin rules → aggregate feasibility.
 * `resolveDevice` is only consulted by a child `use` that names its own device; `_depth` is
 * internal.
 *
 * When the sheet declares tearing variables (params carrying `solveFor`), the pass above is
 * iterated to a fixed point: each estimate is replaced by the value the sheet resolved for
 * it, until every one agrees with what it names. This is plain substitution, which converges
 * exactly when the loop contracts (|f'| < 1) — true of the bias loops the library actually
 * writes, where an estimated node voltage perturbs a drain bias only weakly (well under 0.2 for
 * the library's 5T input-bias loop).
 *
 * The upgrade path for a loop that does NOT contract is a secant/Wegstein step over the handful
 * of unknowns. Note that UNDER-relaxation cannot substitute for it: x + λ·(f(x) − x) has an
 * effective derivative of 1 + λ·(f' − 1), which stays above 1 for every λ in (0, 1] once
 * f' > 1 — rescuing a divergent loop needs the negative λ = 1/(1 − f') that a secant step
 * derives. Left out deliberately: failing closed on a divergent loop tells the author their
 * tearing choice is unstable, which is information, whereas silently solving it is not.
 *
 * Failure is closed at every end — an estimate naming something that does not resolve to a
 * finite number, a residual that keeps growing, a loop that never settles, and an exhausted
 * tree-wide pass budget each return an infeasible result carrying the reason. Never a design
 * sized against a stale estimate. `evalChildren` recurses through here, so a child closes its
 * own loops, and `budget` is shared across the whole tree so nesting cannot go exponential.
 */
function solveTorn(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  _depth: number,
  budget: SolveBudget,
  extra?: Record<string, number>,
): SheetResult {
  const unknowns = doc.params.filter(torn);
  if (unknowns.length === 0) return evaluateOnce(doc, table, resolveDevice, _depth, budget, extra);

  // `extra` (a pinned param's probe value) merges UNDER the torn estimates: the two mechanisms
  // never share a param — validation refuses that — so the spread order is belt and braces.
  const est: Record<string, number> = { ...extra };
  for (const p of unknowns) est[p.name] = p.value;

  /** Each estimate against what the sheet last resolved for it — read BEFORE the update, so a
   *  failure message shows the disagreement rather than a value compared with itself. */
  const report = (): string =>
    unknowns.map((p) => `${p.name} → ${p.solveFor}: ${est[p.name]} vs ${target(p)}`).join('; ');
  const target = (p: { solveFor: string }): number => res.values[p.solveFor];

  let res = evaluateOnce(doc, table, resolveDevice, _depth, budget, est);
  // Divergence is judged on ONE error measure for the whole loop, not on each estimate
  // separately. Judging per-estimate and OR-ing the growths false-fires whenever the error
  // rotates — with two coupled unknowns (a tail node and a mirror drain are exactly that pair)
  // one component grows for several passes while the error as a whole shrinks. Each gap is
  // divided by a scale FIXED on the first pass, which keeps the measure dimensionless across
  // unlike units while staying absolute, so a geometric run-away still grows it (a
  // per-pass-relative measure would sit at a constant while the values ran away).
  const unit: Record<string, number> = {};
  let err = Infinity;
  let first = Infinity;
  let growing = 0;
  let passes = 0;
  let damp = 1;
  const lastStep: Record<string, number> = {};
  let revRun = 0;
  while (passes < SOLVE_PASSES_PER_LOOP && budget.left > 0) {
    passes++;
    budget.left--;
    let done = true;
    let sq = 0;
    for (const p of unknowns) {
      const to = target(p);
      if (to === undefined || !Number.isFinite(to)) {
        return solveFailed(
          res,
          `param "${p.name}" solves for "${p.solveFor}", which did not resolve to a finite ` +
            `number — the estimate cannot be closed, so the design is unsized`,
        );
      }
      const gap = Math.abs(est[p.name] - to);
      // Relative, per SOLVE_TOL_REL — the gap is already in hand, so no separate helper.
      if (gap > SOLVE_TOL_REL * Math.max(Math.abs(est[p.name]), Math.abs(to))) done = false;
      unit[p.name] ??= Math.max(Math.abs(est[p.name]), Math.abs(to), TINY);
      sq += (gap / unit[p.name]) ** 2;
    }
    // `res` was evaluated AT `est` as it stood, so once every estimate agrees with what the
    // sheet resolved for it, this result already IS the converged one.
    // `passes - 1`: the first pass only CHECKS the authored guesses against what the sheet
    // resolved for them, so a loop that agreed immediately performed no substitution at all.
    if (done) return passes - 1 > SOLVE_PASSES_NOTE ? slowClosure(res, passes - 1, damp) : res;

    const prev = err;
    err = Math.sqrt(sq);
    if (passes === 1) first = err;

    // Shorten the step when it CHANGES SIGN, which is what overshooting looks like: the iterate
    // steps past the fixed point and back, settling into a two-cycle whose error stops falling
    // but never rises. Neither a growing-error nor a stalled-error trigger finds that — the first
    // never fires, and the second also fires on a slow monotone contraction, where a shorter step
    // is precisely the wrong answer.
    //
    // The step only ever shortens. Growing it back on a good pass sounds better and is worse: the
    // longer step overshoots again, the next one shortens, and the step length itself falls into a
    // cycle that never settles. Shortening alone stops as soon as the iteration stops reversing,
    // which is exactly when it has become a contraction.
    // Reversal is judged for the loop as a WHOLE, not per unknown, for the same reason the error
    // measure is: judging each estimate separately and combining the verdicts is what made a
    // rotating loop read as divergent. The cost is a short blind spot — one oscillating estimate
    // can hold the step short while another walks away — but the step grinds to its floor within
    // a few passes and the divergence verdict then lands correctly.
    let reversed = false;
    for (const p of unknowns) {
      const step = target(p) - est[p.name];
      if (lastStep[p.name] !== undefined && step * lastStep[p.name] < 0) reversed = true;
      lastStep[p.name] = step;
    }

    // A loop running away in ONE direction is genuinely divergent — no step length rescues it,
    // since shortening only slows the escape. One that runs away while reversing is overshooting,
    // and the step above is already being cut, so give that a chance and judge it only once the
    // shortest step still walks away.
    growing = err > prev && (!reversed || damp <= SOLVE_DAMP_MIN) ? growing + 1 : 0;
    if (growing >= SOLVE_DIVERGING) {
      return solveFailed(
        res,
        `bias loop is diverging — the estimates move further from their targets each pass ` +
          `(${report()}). Reparametrize so the loop disappears, or tear it at a quantity the ` +
          `rest of the design depends on more weakly`,
      );
    }
    // Reversal ALONE is not overshoot. A loop with two coupled unknowns rotates as it contracts,
    // reversing every few passes while closing in perfectly well, and shortening its step only
    // slows it down. Overshoot reverses on EVERY pass and buys nothing for it, so require both:
    // reversals back to back, and an error that has stopped moving.
    revRun = reversed ? revRun + 1 : 0;
    if (revRun >= 2 && err >= prev * SOLVE_PROGRESS) damp = Math.max(damp / 2, SOLVE_DAMP_MIN);
    // Commit the iterate only after every check above has had the pre-update values. At damp = 1
    // this is plain substitution; below it, a partial step toward what the sheet resolved.
    for (const p of unknowns) est[p.name] += damp * lastStep[p.name];
    res = evaluateOnce(doc, table, resolveDevice, _depth, budget, est);
  }

  // Out of passes — but WHOSE passes? The budget is shared across the whole composition so that
  // nesting cannot multiply the work without bound, which means the pool can drain before this
  // loop has iterated at all: an expensive sibling elsewhere in the design, or a pin ABOVE this
  // loop whose every probe re-closes it (the multiplicative cost is then this loop's own, spread
  // across probes). Blaming this loop alone would send an author to rewrite a sheet that is
  // fine; the message names both spenders because the engine cannot tell them apart here.
  //
  // KNOWN GAP: naming the cause is not fixing it. The allowance is linear in the NUMBER of loops
  // while nesting multiplies their cost, so a well-posed sheet can still read infeasible because
  // of how expensive the rest of the tree is — order-dependence this codebase rejects elsewhere.
  // The fix is a reservation: a floor each loop can always draw on, with the shared ceiling above
  // it. Not built, because no real sheet nests torn loops yet.
  if (budget.left <= 0 && passes < SOLVE_PASSES_PER_LOOP) {
    return solveFailed(
      res,
      `bias loop stopped after ${passes} pass(es) (${report()}) because the design's shared ` +
        `iteration budget ran out — spent by an expensive loop elsewhere in the tree, or by a ` +
        `pin above this loop re-closing it on every probe. This loop was not shown to diverge. ` +
        `Simplify or reparametrize the costliest loop in the composition, or reduce the nesting`,
    );
  }

  // Its own allowance ran out. Distinguish "still closing, just slowly" from "stuck": a loop whose
  // error shrank the whole way was converging, and telling its author to check for instability
  // would be false. Substitution converges at |f'| per pass, so a weak contraction can genuinely
  // need more passes than any cap allows.
  return solveFailed(
    res,
    `bias loop did not reach tolerance in ${passes} passes (${report()}) — ` +
      (err < first
        ? `the disagreement fell ${first.toExponential(2)} → ${err.toExponential(2)}, so it IS ` +
          `converging, just too weakly damped to close here; tear it at a quantity the design ` +
          `depends on more weakly`
        : `it is neither converging nor clearly diverging; check that each solveFor names the ` +
          `value its estimate really stands in for`),
  );
}

/** Probes bisection may spend before giving up — a backstop far above the ~20 halvings a real
 *  bracket needs; the shared budget is the real ceiling. */
const PIN_MAX_PROBES = 200;

/** Bracket-width tolerance, relative to the AUTHORED bracket's span — not to the iterates,
 *  which never close a purely relative test when the root sits at 0 (|lo|,|hi| stay ~constant
 *  while the width shrinks). Its own constant, looser than SOLVE_TOL_REL, because a bisection
 *  digit costs a full tree evaluation where a substitution digit is nearly free: 1e-6 lands in
 *  ~20 probes and resolves a volt-scale node to a microvolt. */
const PIN_TOL_REL = 1e-6;

/** Residual tolerance at the accepted root, relative to the relation's RANGE over the authored
 *  bracket (max |lhs-rhs| at the two ends — already in hand from the sign check). Scaling by the
 *  range is form-invariant: the verdict is the same whether the author writes lhs=CM_in/rhs=CM_dc
 *  or lhs=CM_in-CM_dc/rhs=0, where scaling by |lhs| itself rejected every correct root written in
 *  residual form and waved through a real jump riding a large DC offset. A steep-but-continuous
 *  relation leaves a residual of (slope x final width) — vanishing on the range scale — while a
 *  JUMP leaves a fixed fraction of it. */
const PIN_RESIDUAL_REL = 1e-5;

/**
 * Evaluate a sheet document — the single public entry. A doc that declares containment
 * edges dispatches to the edge wrapper; everything else, and every step the engine takes
 * below the top of a tree (composed children, solver probes, the edge runs themselves),
 * goes through evaluateNode — which structurally has no edge branch, so "edges evaluate
 * only at the top" holds with no runtime guard to maintain.
 */
export function evaluateSheet(
  doc: SheetDoc,
  table?: DeviceTable,
  resolveDevice?: DeviceResolver,
): SheetResult {
  // Array.isArray, not truthiness: evaluate never throws, and a malformed doc (edges as a
  // string or object — validation's problem) must degrade to a plain evaluation, not a
  // TypeError out of .map.
  return Array.isArray(doc.edges) && doc.edges.length
    ? evaluateWithEdges(doc, table, resolveDevice)
    : evaluateNode(doc, table, resolveDevice, 0);
}

/**
 * Evaluate one node of a sheet tree: solve it (below), then check the gate wiring its children
 * declare against the result. The wiring check sits HERE, outside the solve, so it sees the
 * settled design exactly once — a probe's intermediate estimate is not a wiring disagreement.
 */
function evaluateNode(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  _depth: number,
  budget: SolveBudget = { left: SOLVE_PASSES_PER_LOOP * tornSheets(doc) },
): SheetResult {
  return checkWiring(doc, solveNode(doc, table, resolveDevice, _depth, budget));
}

/**
 * Resolve one node's engine-solved parameters. Two mechanisms, by what the author could
 * honestly write down:
 *
 *  - `solveFor` — the param is an ESTIMATE of a value the sheet itself resolves; closed by
 *    damped substitution (solveTorn above), with all the care that method needs.
 *  - `pin` — the param is a FREE internal variable (a node voltage) chosen so an output equals
 *    a spec. Closed by bisection on the param's [min, max]: no contraction requirement, no
 *    overshoot, no dependence on a starting guess. The honesty conditions are explicit —
 *    `lhs - rhs` must change sign across the bracket and must actually reach zero at the root —
 *    and every violation fails closed with the reason, never a design sized where the data was
 *    not.
 *
 * The pinned solve is the OUTER loop: each probe re-closes any torn loops inside, and both
 * mechanisms draw on the one tree-wide pass budget, so nesting stays bounded.
 */
function solveNode(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  _depth: number,
  budget: SolveBudget,
): SheetResult {
  // One home for the structural pin checks (validateSheet raises the same words as errors);
  // checked BEFORE filtering by the pinned() shape guard, because the guard rejects a
  // half-written pin — which would otherwise sail past as "no pins" and freeze the param.
  const problem = pinProblem(doc.params);
  if (problem) {
    return solveFailed(solveTorn(doc, table, resolveDevice, _depth, budget), problem);
  }
  const pins = doc.params.filter(pinned);
  if (pins.length === 0) return solveTorn(doc, table, resolveDevice, _depth, budget);

  const p = pins[0];
  const { lhs, rhs } = p.pin;
  const probeAt = (x: number): SheetResult => {
    budget.left--;
    return solveTorn(doc, table, resolveDevice, _depth, budget, { [p.name]: x });
  };

  /** lhs - rhs at an already-evaluated probe; undefined when either side does not resolve.
   *  Diagnostics are swallowed (NO_WARN): a side that stops resolving is reported once,
   *  with the pin's own message, not once per probe. */
  const gap = (res: SheetResult): number | undefined => {
    const at = (src: string): number | undefined => {
      const v = evalScalar(src, res.values, scalarScope(res.values), NO_WARN, `pin ${p.name}`);
      return v !== undefined && Number.isFinite(v) ? v : undefined;
    };
    const l = at(lhs);
    const r = at(rhs);
    return l === undefined || r === undefined ? undefined : l - r;
  };
  const atEnd = (x: number, which: string): { res: SheetResult; g?: number } => {
    const res = probeAt(x);
    const g = gap(res);
    return g === undefined
      ? {
          res: solveFailed(
            res,
            `pinned param "${p.name}": ${lhs} - ${rhs} did not evaluate at the ${which} of ` +
              `its bracket (${p.name} = ${x}) — tighten min/max to where the design sizes`,
          ),
        }
      : { res, g };
  };

  let lo = p.min!;
  let hi = p.max!;
  const span = hi - lo;
  const first = atEnd(lo, 'low end');
  if (first.g === undefined) return first.res;
  const second = atEnd(hi, 'high end');
  if (second.g === undefined) return second.res;
  let gLo = first.g;
  const gHi = second.g;
  if (gLo === 0) return first.res;
  if (gHi === 0) return second.res;
  if (gLo > 0 === gHi > 0) {
    return solveFailed(
      second.res,
      `pinned param "${p.name}": ${lhs} - ${rhs} does not change sign across ` +
        `[${lo}, ${hi}] (${gLo.toExponential(3)} at both … ${gHi.toExponential(3)}) — the ` +
        `bracket does not straddle the target. Widen min/max, or the relation cannot reach it ` +
        `on this table`,
    );
  }
  // The residual scale for acceptRoot: the relation's range over the authored bracket,
  // captured before the loop shrinks it. Nonzero here — a zero end already returned above.
  const gScale = Math.max(Math.abs(gLo), Math.abs(gHi));

  let res = second.res;
  for (let probes = 0; probes < PIN_MAX_PROBES && budget.left > 0; probes++) {
    const mid = (lo + hi) / 2;
    res = probeAt(mid);
    const g = gap(res);
    if (g === undefined)
      return solveFailed(
        res,
        `pinned param "${p.name}": ${lhs} - ${rhs} stopped evaluating inside the bracket ` +
          `(${p.name} = ${mid}) — the relation is not defined everywhere between min and max`,
      );
    if (g === 0) return res; // an exact root needs no residual argument
    if (g > 0 === gLo > 0) {
      lo = mid;
      gLo = g;
    } else hi = mid;
    // Accept only a genuine crossing (see acceptRoot): a relation that JUMPS across the target
    // brings the bracket to nothing while the residual stays macroscopic.
    if (hi - lo <= PIN_TOL_REL * span) {
      return acceptRoot(res, g);
    }
  }

  return solveFailed(
    res,
    budget.left <= 0
      ? `pinned param "${p.name}" stopped before its bracket closed because the design's ` +
          `shared iteration budget ran out — spent by the loops this pin re-closes on every ` +
          `probe, or by an expensive sibling elsewhere in the tree. This pin was not shown ` +
          `to be unsolvable`
      : `pinned param "${p.name}": the bracket did not close in ${PIN_MAX_PROBES} probes`,
  );

  function acceptRoot(at: SheetResult, g: number): SheetResult {
    if (Math.abs(g) > PIN_RESIDUAL_REL * gScale) {
      return solveFailed(
        at,
        `pinned param "${p.name}": the bracket closed but ${lhs} - ${rhs} still reads ` +
          `${g.toExponential(3)} — the relation steps across the target without touching it ` +
          `(a table edge or a fold), so no ${p.name} in [${p.min}, ${p.max}] produces it`,
      );
    }
    return at;
  }
}

/**
 * Evaluate a doc that declares containment edges: the base run, then one more complete
 * evaluation per edge with that edge's params overridden. Every run — base and each edge —
 * takes the default budget of a fresh top-level call: each is a complete evaluation with its own
 * solves to close, and sharing one pool sized for a single solve would starve the later runs into
 * phantom infeasibility. Cost is therefore at most (1 + edge count) full evaluations everywhere the
 * sheet evaluates, sweep cells included — the price of a swept cell never disagreeing with the
 * same numbers evaluated alone. A base run that did not stand costs one, for the reason below.
 *
 * The edge runs are the base run's DESIGN re-measured at another condition (see coverage.ts),
 * which makes them conditional on there being a design at all. When the base run did not stand,
 * every edge comes back `not-checked` rather than carrying a verdict about hardware the engine
 * never landed on — a failed pin leaves its last bisection probe in the result with every bind
 * reading `ok`, so "the binds sized" is nowhere near enough to have produced an instance. Rule
 * FAILURES do not gate: a center that misses its spec is still a design, and whether it holds
 * across its claimed range is still a real question.
 */
function evaluateWithEdges(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
): SheetResult {
  const base = evaluateNode(doc, table, resolveDevice, 0);
  const edges = doc.edges ?? [];
  if (!stands(base)) {
    const reports = edges.map((e): SheetEdgeReport => ({
      name: e.name,
      feasible: false,
      state: 'not-checked',
      // No `set`: the overrides resolve against the base VALUES, which here are wherever the
      // failed solve stopped. Reporting the point that would have been proven from those is
      // reporting a phantom, the same reason a bracket end is never reported as a landing.
      set: {},
      rules: [],
      solved: {},
      warnings: [],
    }));
    // No `feasible` override: a base that does not stand carries an error-severity warning,
    // which evaluateNode has already folded into the `feasible` the spread brings along.
    return { ...base, edges: reports };
  }
  const pinned = pinHardware(doc, base);
  const reports = edges.map((e) => runEdge(e, pinned, base, table, resolveDevice));
  // `closes` rides the spread untouched — it is the base verdict by definition, and this is
  // the one fold that separates "the design closes" from "the whole claim stands".
  return {
    ...base,
    edges: reports,
    feasible: base.feasible && reports.every((r) => r.feasible),
    covers: reports.every((r) => r.state === 'covers'),
  };
}

/** One edge: resolve its `set` expressions against the base result, re-evaluate the
 *  FIXED-HARDWARE form of the doc with those values (through evaluateNode, so the run cannot
 *  recurse into edges), and report the outcome. An edge that cannot be evaluated at all — a
 *  `set` expression that does not resolve, a solve that fails — does not cover, with the
 *  underlying message VERBATIM in `error`, so a shared-budget starvation stays distinguishable
 *  from "the bracket cannot reach it". Rule-level failures are not errors: they live in `rules`,
 *  like anywhere else. */
function runEdge(
  edge: SheetEdge,
  pinned: PinnedHardware,
  base: SheetResult,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
): SheetEdgeReport {
  // Copied per report rather than shared: the transformation allocates one list for the whole
  // document, and a consumer that sorted or de-duplicated one report's copy in place would be
  // rewriting every sibling's at the same time.
  const assumed = pinned.assumedSource.length
    ? { assumedSource: [...pinned.assumedSource] }
    : undefined;
  const scope = scalarScope(base.values);
  const over: Record<string, number> = {};
  // `?? {}`: a half-written edge (no set) is validation's error to name; evaluate never throws.
  for (const [param, expr] of Object.entries(edge.set ?? {})) {
    const v = evalScalar(expr, base.values, scope, NO_WARN, `edge ${edge.name}`);
    if (v === undefined || !Number.isFinite(v)) {
      return {
        name: edge.name,
        feasible: false,
        state: 'does-not-cover',
        set: over,
        rules: [],
        solved: {},
        warnings: [],
        error:
          `edge "${edge.name}": set ${param} = "${expr}" did not evaluate to a finite ` +
          `number against the base result`,
        ...assumed,
      };
    }
    over[param] = v;
  }
  const res = evaluateNode(withParams(pinned.doc, over), table, resolveDevice, 0);
  // `error` promises the SOLVER's own message when one exists — a child's solve failure
  // rolls up mid-evaluation and later diagnostics (a non-finite parent row) land after
  // it, so "last error" alone reports the consequence instead of the cause. One reverse
  // scan: remember the last error of any kind as the fallback, prefer the last
  // sheet-solve. (Reverse loop: the target lib predates findLast, and a filter would
  // copy the array to read one element.)
  let err: string | undefined;
  if (!res.feasible) {
    let lastError: string | undefined;
    for (let i = res.warnings.length - 1; i >= 0 && err === undefined; i--) {
      const w = res.warnings[i];
      if (w.severity !== 'error') continue;
      lastError ??= w.message;
      if (w.rule === 'sheet-solve') err = w.message;
    }
    err ??= lastError;
    // A device held at a fixed width can run out of table: the endpoint bias moves the density
    // its authored current (or transconductance) needs outside the swept vgs range, and the
    // inverse lookup says so in its own accurate but width-domain words. That failure cannot
    // arise while a range end is free to re-size the device — any gm/ID inside the ceiling lands
    // — so it comes with no vocabulary of its own. Lead with what it MEANS for the question being
    // asked and keep the lookup's message behind it, where its reach numbers stay quotable.
    const reach = err === undefined ? null : LOOKUP_RANGE_MESSAGE.exec(err);
    if (reach)
      err =
        `this device cannot ${reach[1] === 'id' ? 'carry its authored current' : 'reach its authored transconductance'}` +
        ` at the endpoint bias — ${err}`;
  }
  // The solved map is "where the edge LANDED" — an errored run (a pin that never landed)
  // leaves the values at the last probe, which must not be reported as a landing.
  const solved: Record<string, number> = {};
  if (err === undefined)
    for (const p of pinned.doc.params)
      if (engineSolved(p) && Number.isFinite(res.values[p.name]))
        solved[p.name] = res.values[p.name];
  // The run's warnings ride the report VERBATIM (never merged into the parent's): a bias
  // clamp fires exactly at a claim's extreme, and a green chip must not rest on silently
  // clamped data — but the base result's warning contract stays untouched.
  return {
    name: edge.name,
    feasible: res.feasible,
    state: res.feasible ? 'covers' : 'does-not-cover',
    set: over,
    rules: res.rules,
    ...(res.children ? { children: res.children } : {}),
    solved,
    warnings: res.warnings,
    ...(err !== undefined ? { error: err } : {}),
    ...assumed,
  };
}
