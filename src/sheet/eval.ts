// Evaluate a leaf design-sheet in ONE pass: seed params, (optionally) size the device
// via sizeDevice, then evaluate author rows in document order and check each rule into
// a signed-margin result. Reuses the expression engine (compileExpr), the bind-any-2
// sizing (sizeDevice), and the constant scope verbatim — it adds no numeric or parser
// logic and never traverses a circuit. Pure, deterministic, never throws. Zero DOM.

import type { DeviceTable, QAWarning, Scope, Value } from '../types';
import { CONSTANTS } from '../constants';
import { compileExpr, metaScalars } from '../derive';
import { AXIS_DEFAULT_BIAS } from '../namespace';
import { scalarScope } from '../expr';
import { BINDABLE, sizeDevice, type SizeQuery } from '../device';
import { fixTable } from '../series';
import { BIAS_AXES, MAX_USE_DEPTH, isHardRule, joinProvide, prefixUseWarning } from './types';
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

/**
 * Margins within this relative distance of zero snap to exactly 0. A spec that is pinned
 * by its own bind (e.g. bind gm = 2π·GBW·CL, then rule GBW >= GBW_target) lands within
 * floating-point rounding of the boundary, and without the snap the verdict is a coin
 * flip between pass and fail on ±1e-16 noise. Snapped-to-zero margins read as a
 * deterministic near-miss (amber) — the honest description of a pinned spec.
 */
export const MARGIN_SNAP_REL = 1e-12;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
 * tens of MB — clearing wholesale at the cap trades a rare recompute for a hard ceiling.
 */
const SLICE_CACHE = new WeakMap<DeviceTable, Map<string, DeviceTable>>();
const SLICE_CACHE_CAP = 64;
function fixAxisCached(t: DeviceTable, axis: string, v: number): DeviceTable {
  let m = SLICE_CACHE.get(t);
  if (!m) {
    m = new Map();
    SLICE_CACHE.set(t, m);
  }
  const key = `${axis}=${v}`;
  const hit = m.get(key);
  if (hit) return hit;
  if (m.size >= SLICE_CACHE_CAP) m.clear();
  const out = fixTable(t, { [axis]: v });
  m.set(key, out);
  return out;
}

/**
 * Collapse the table's bias axes (vds/vsb) to the operating point before sizing: a value
 * DECLARED in the bind wins; a live axis the bind does not declare falls back to the
 * caller's bias with an advisory warning naming the assumed value (so a host-side slice
 * is never invisible); with neither, the axis stays live and sizing fails with guidance.
 * Returns the sliced table plus the applied coordinates for the BindReport.
 */
function applyBindBias(
  b: SheetBind,
  table: DeviceTable,
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
): { table: DeviceTable; bias: Record<string, number> } | { error: string; needs?: string[] } {
  let t = table;
  const bias: Record<string, number> = {};
  const needs: string[] = [];
  const slice = (axis: string, live: { values: ArrayLike<number> }, v: number): number => {
    const lo = live.values[0];
    const hi = live.values[live.values.length - 1];
    const applied = v < lo ? lo : v > hi ? hi : v;
    t = fixAxisCached(t, axis, applied);
    bias[axis] = applied;
    return applied;
  };
  for (const axis of BIAS_AXES) {
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
      if (def !== undefined && lo <= def && def <= hi) slice(axis, live, def);
      else needs.push(axis);
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
  return { table: t, bias };
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
    return { ok: false, W: NaN, vgs: NaN, id: NaN, error, ...(needs?.length ? { needs } : {}) };
  };

  if (!table) return fail('no device to size against');

  const supplied = BINDABLE.filter((k) => b[k] !== undefined);
  if (supplied.length !== 2)
    return fail(`bind needs exactly two of {${BINDABLE.join(', ')}}, got ${supplied.length}`);

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
    const report: BindReport = { ok: true, W: res.W, vgs: res.vgs, id: res.id };
    if (Object.keys(sliced.bias).length) report.bias = sliced.bias;
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
  const base = { id: rule.id, kind: rule.kind, text, lhsValue, rhsValue };

  if (lhs === undefined || rhs === undefined || !Number.isFinite(lhs) || !Number.isFinite(rhs)) {
    return {
      ...base,
      margin: NaN,
      marginPct: NaN,
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
      status: 'na',
      detail: 'margin did not compute to a finite number (check tolPct)',
    };
  }
  if (margin !== 0 && Math.abs(margin) <= MARGIN_SNAP_REL * Math.max(Math.abs(lhs), Math.abs(rhs)))
    margin = 0; // see MARGIN_SNAP_REL — a bind-pinned spec must not coin-flip on FP noise
  const marginPct = margin / Math.max(Math.abs(rhs), TINY);

  let status: RuleStatus;
  if (margin < 0) status = 'fail';
  else if (rule.op === '==')
    status = 'pass'; // '==' is pass/fail only — no near-miss (amber) band
  else status = marginPct < AMBER_BAND ? 'amber' : 'pass';
  return { ...base, margin, marginPct, status };
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
  const childParams = new Set(childDoc.params.map((p) => p.name));
  const overrides: Record<string, number> = {};
  let ok = true;
  for (const [k, expr] of Object.entries(use.params)) {
    // An override key that names no child param is the same failure as an unresolvable
    // one: the parent explicitly supplied a value (typo and all) that will NOT reach the
    // child, so the child would size a different design than the author wired — and its
    // embedded default could still read feasible. Fail closed, by name.
    if (!childParams.has(k)) {
      ok = false;
      warn({
        rule: 'sheet-use-param',
        severity: 'error',
        message: `use "${use.name}": override "${k}" does not match any child param (refusing to size the child on its embedded defaults)`,
        location: use.name,
      });
      continue;
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
    const res = evaluateSheet(childDoc, childTable, resolveDevice, depth + 1);

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
 * Evaluate a sheet against an optional device table. One pass, never throws: seed
 * params → (compose children) → size → author-order rows → signed-margin rules →
 * aggregate feasibility. A leaf (no `uses`) behaves exactly as before. `resolveDevice`
 * is only consulted by a child `use` that names its own device; `opts` threads the
 * whole tree (children included); `_depth` is internal.
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

  // 0. Device-metadata scalars — the same scope derive/tableScope uses: T/UT (so
  //    temperature-aware author math and the γ-model noise evaluate at the table's
  //    characterization temperature) and the characterization width `w`. Seeded
  //    before params, so a same-named param deliberately wins.
  if (table) Object.assign(values, metaScalars(table.meta));

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

  return { values, bind, rules, feasible, warnings, ...(children ? { children } : {}) };
}
