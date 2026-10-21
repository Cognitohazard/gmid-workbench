// Evaluate a leaf design-sheet in ONE pass: seed params, (optionally) size the device
// via sizeDevice, then evaluate author equations in document order and evaluate each check into
// a signed-margin result. Reuses the expression engine (compileExpr), the bind-any-2
// sizing (sizeDevice), and the constant scope verbatim — it adds no numeric or parser
// logic and never traverses a circuit. Pure, deterministic, never throws. Zero DOM.

import { LOOKUP_RANGE_MESSAGE } from '../types';
import type { DeviceTable, QAWarning, Scope, Value } from '../types';
import { CONSTANTS } from '../constants';
import { compileExpr, metaScalars } from '../derive';
import { AXIS_DEFAULT_BIAS } from '../namespace';
import { additiveCoefficient, scalarScope } from '../expr';
import { BINDABLE, bindProblem, sizeDevice, type SizeQuery } from '../device';
import { fixTable } from '../series';
import { diodeGrid, offHull } from '../grid';
import {
  BIAS_AXES,
  MAX_BLOCK_DEPTH,
  PATH_SEP,
  clampedIn,
  engineSolved,
  holds,
  isHardCheck,
  joinProvide,
  constraintProblem,
  constrained,
  drainProblem,
  prefixBlockWarning,
  refusedIn,
  stands,
  torn,
  withParams,
} from './types';
import { assumedLevelRefusal, holdHardware, type HeldHardware } from './coverage';
import { dcInputs, constraintPlan } from './validate';
import type {
  SizingReport,
  CheckResult,
  CheckStatus,
  SheetGivens,
  SheetBlockReport,
  SheetDoc,
  SheetRangeEnd,
  RangeEndReport,
  PointState,
  SheetResult,
  SheetVar,
  SheetBlock,
} from './types';

/** Resolve a device id to its lookup table (for a block that names its own device).
 *  Absent ⇒ children inherit the parent's table. */
export type DeviceResolver = (id: string) => DeviceTable | undefined;

/** A check passing by a smaller relative margin than this reads as a near-miss (amber). */
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
 * check ON its own boundary by construction: a spec set by its own givens (given
 * gm = 2π·GBW·CL, then check GBW >= GBW_target) lands within floating-point rounding, and
 * a range end lands CM_in within the constraint's landing tolerance of the very range end
 * the check compares it against (CONSTRAINT_TOL_REL x the bracket span, stretched by the
 * relation's slope — microvolts on a volt-scale node, ~1e-6 relative). Without the snap
 * either verdict is a coin flip. 1e-5 covers the constraint case with margin while staying two
 * orders below the ~0.1% the sizer resolves between grid nodes — a check "failing" by
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

/** How far a diode-connected device's drain voltage may sit from its gate voltage, relative to
 *  the gate voltage, before the difference is the table's hull rather than interpolation. */
const HULL_SNAP = 1e-6;

/** How far a stated bias may sit from the one value a table was taken at and still be that
 *  value: float rounding at volt scale, the allowance a swept axis's ends are read with. */
const HULL_SNAP_V = 1e-9;

/** Passes a tearing loop may take and still be unremarkable. Above it the closure is weak or
 *  oscillatory — the designer's two-pass smell — which is worth a note even though the loop
 *  did close. Design constraints are excluded: bisection spends ~20 probes by construction, so a
 *  probe count carries no fragility signal there. */
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
 * the caller can classify it (an equation drops it; a check side surfaces as `na`).
 */
function evalScalar(
  src: string,
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
  where: string,
): number | undefined {
  // A bare number is its own value: it compiles to itself and has no free names, so the whole
  // path below is a no-op for it. Worth short-circuiting because the fixed-hardware transformation
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
 * One thing a device's givens use that its table does not sweep: the reason in words, and the
 * sweep a table would need to answer it.
 *
 * A table that sweeps an axis can be read anywhere along it. One that does not was taken at a
 * single point, and a device is sized on it only if that is the point its givens state:
 *
 *  - an axis with ONE value says where the table was taken;
 *  - no axis at all says nothing — except body bias, where a table with no `vsb` column is taken
 *    as characterized with the source tied to the body (the namespace default, vsb = 0).
 *
 * Anything else is REFUSED rather than read off the table as it stands: the numbers would belong
 * to a different operating point than the one written down, and a warning beside them does not
 * make them right.
 */
interface Unswept {
  axis: string;
  reason: string;
  sweep: string;
}

/** A value as a message quotes it: what the author wrote, without the float tail arithmetic
 *  leaves on it (`0.1 + 0.2` reads 0.3, not 0.30000000000000004). */
const shown = (v: number): string => String(Number(v.toPrecision(12)));

/** What each axis the givens can state is called in a refusal: the quantity it asks for, and
 *  the sweep that would answer it. */
const AXIS_WORDS: Readonly<Record<string, { asks: string; sweep: string }>> = {
  vds: { asks: 'a drain voltage', sweep: 'vds sweep' },
  vsb: { asks: 'a body bias', sweep: 'vsb sweep' },
  l: { asks: 'a length', sweep: 'length sweep' },
};

/** What a table has in place of a sweep of `axis`, in the words a refusal quotes. `given` is
 *  the axis as the givens name it, so one message does not call the length both `L` and `l`. */
function inPlaceOfSweep(table: DeviceTable, axis: string, given = axis): string {
  const own = table.grid.axes.find((a) => a.name === axis);
  if (own) return `a single value, ${given} = ${shown(own.values[0])}`;
  const def = AXIS_DEFAULT_BIAS.get(axis);
  return def === undefined
    ? `no ${axis} column`
    : `no ${axis} column, so it is taken as characterized at ${given} = ${def}`;
}

/**
 * Whether `v` is the one point `at` a table was taken at on an axis it does not sweep — equal
 * beyond float rounding only. A voltage rounds at volt scale wherever the table sits: a supply
 * expression such as `3.3 - 1.1*3` lands 4e-16 below zero and is still a source at the body, on
 * a table taken at vsb = 0 as on any other. A length has no such floor (a micron is 1e-6), so it
 * is held to its own magnitude (see offHull).
 */
const takenAt = (axis: string, at: number, v: number): boolean =>
  axis === 'l' ? !offHull([at], v) : Math.abs(v - at) <= HULL_SNAP_V * Math.max(1, Math.abs(at));

/**
 * A given that states `v` on an axis its table does NOT sweep: undefined — the device is sized
 * there, silently — when `v` is the point the table was taken at, else why it is refused.
 * `given` is the givens key as the author wrote it (`L`, where the axis is `l`).
 */
function unsweptGiven(
  table: DeviceTable,
  given: string,
  axis: string,
  v: number,
): Unswept | undefined {
  const own = table.grid.axes.find((a) => a.name === axis);
  const at = own ? own.values[0] : AXIS_DEFAULT_BIAS.get(axis);
  if (at !== undefined && takenAt(axis, at, v)) return undefined;
  const { asks, sweep } = AXIS_WORDS[axis] ?? {
    asks: `a value of ${axis}`,
    sweep: `${axis} sweep`,
  };
  return {
    axis,
    reason:
      `given ${given} = ${shown(v)} asks for ${asks} the table cannot give: it has no ${sweep} ` +
      `(${inPlaceOfSweep(table, axis, given)})`,
    sweep: `a ${sweep} that covers ${shown(v)}`,
  };
}

/** A diode connection on a table with no vds sweep. The connection is read along the whole
 *  vds = vgs diagonal, which only a sweep holds: one characterized drain voltage meets it at a
 *  single gate voltage, so a table taken at one vds is refused like a table with none. */
function unsweptDiode(table: DeviceTable): Unswept {
  return {
    axis: 'vds',
    reason:
      `the givens declare a diode connection, which is read where vds = vgs, and the table ` +
      `cannot give that: it has no vds sweep (${inPlaceOfSweep(table, 'vds')})`,
    sweep: 'a vds sweep',
  };
}

/** The refusal of one device, said once for everything its table lacks — so its author learns
 *  what to re-export in one message rather than one re-export at a time. */
function sweepRefusal(lacking: readonly Unswept[]): string {
  return (
    `${lacking.map((u) => u.reason).join('; ')}. The device is not sized — re-export the ` +
    `table with ${lacking.map((u) => u.sweep).join(' and ')}, or evaluate on a table that has ` +
    (lacking.length > 1 ? 'them' : 'one')
  );
}

/**
 * Collapse the table's bias axes (vds/vsb) to the operating point before sizing: a value
 * DECLARED in the givens wins; a live axis the givens do not declare takes the namespace
 * default when the table characterizes that point, and is reported as ASSUMED so the
 * coordinate is never silently invented; with neither, the axis stays live and sizing fails
 * with guidance. The drain voltage has no default and is never left out: givens that state
 * neither a `vds` nor a diode connection fail the sizing on any table (see drainProblem).
 * A value declared on an axis the table does not sweep is held against the one
 * point the table was taken at, and sized there or refused (see Unswept); `lacking` arrives
 * holding what the caller already found missing, so one device is refused in one message. An
 * undeclared axis's default is held against that point too, and has to be declared where the
 * table was taken somewhere else.
 * Returns the sliced table, the applied coordinates, and which of them were assumed rather than
 * authored — all three reach the SizingReport.
 */
function applyGivensBias(
  b: SheetGivens,
  table: DeviceTable,
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
  lacking: Unswept[],
):
  | {
      table: DeviceTable;
      bias: Record<string, number>;
      assumed: string[];
      clamped: string[];
      /** A diode connection folded the vds axis; `clamped` when the vgs sweep leaves the
       *  characterized vds range somewhere, so part of the diagonal reads the table's edge. */
      diode?: { clamped: boolean };
    }
  | { error: string; needs?: string[]; unswept?: string[] } {
  let t = table;
  const bias: Record<string, number> = {};
  const needs: string[] = [];
  /** Of `needs`, the axes the table holds at one value away from the default — in words. */
  const taken: string[] = [];
  const assumed: string[] = [];
  const clamped: string[] = [];
  let diode: { clamped: boolean } | undefined;
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
  if (b.diode === true) {
    const live = t.grid.axes.find((a) => a.name === 'vds' && a.values.length > 1);
    if (live) {
      const fold = diodeTableCached(t);
      diode = { clamped: fold.clamped };
      // Say it out loud when the diagonal cannot be followed everywhere: past the characterized
      // vds range the fold reads the table's edge, so a diode biased up there is reported at a
      // drop the data never measured. Silently clamping is exactly what this project does not do.
      if (fold.clamped)
        warn({
          rule: 'sheet-givens',
          severity: 'warning',
          message:
            `diode connection: the vgs sweep runs outside the characterized vds range, so the ` +
            `vds = vgs diagonal is clamped to the table's edge where it does. A drop landing in ` +
            `that region is read from data taken at a different vds`,
          location: 'givens',
        });
      t = fold.table;
    } else lacking.push(unsweptDiode(t));
  }

  // Every sized device states its drain voltage, whatever its table holds: a table that sweeps
  // vds cannot be collapsed without one, and a table taken at one drain voltage, or with no vds
  // column, would size the device from whatever point it happens to hold. So the omission is the
  // author's to fix on all three, and `vds` is asked for like any other axis left to declare.
  const drain = drainProblem(b);

  for (const axis of BIAS_AXES) {
    // The connection already fixed it — or nothing states it, which is said below.
    if (axis === 'vds' && (b.diode === true || drain)) continue;
    const live = t.grid.axes.find((a) => a.name === axis && a.values.length > 1);
    // BIAS_AXES is namespace-derived (dynamic strings), while SheetGivens's declared bias
    // fields are static — index structurally rather than by the literal key union.
    const declared = (b as unknown as Partial<Record<string, string>>)[axis];
    if (declared !== undefined) {
      const v = evalScalar(declared, values, scope, warn, `given ${axis}`);
      if (v === undefined || !Number.isFinite(v))
        return { error: `given ${axis} did not resolve to a finite number` };
      if (!live) {
        // Nothing to slice: the table was taken at one point on this axis. Where the given
        // states that point there is nothing to do and nothing to say; anywhere else the device
        // is refused, because the table as it stands would answer for a different bias.
        const refused = unsweptGiven(t, axis, axis, v);
        if (refused) lacking.push(refused);
        continue;
      }
      // sliceGrid clamps to the hull; apply the clamp HERE so the report and the slice
      // agree — recording the requested value would show an operating point the sizing
      // never used. The requested value survives in the warning only.
      const applied = slice(axis, live, v);
      // Beyond float rounding only: an expression landing a few ULP outside the axis reads the
      // end node it was aiming at, which is not a clamp.
      if (offHull(live.values, v)) {
        clamped.push(axis);
        warn({
          rule: 'sheet-givens',
          severity: 'warning',
          message: `given ${axis} ${v} is outside the table's ${axis} range [${live.values[0]}, ${live.values[live.values.length - 1]}]; clamped to ${applied}`,
          location: 'givens',
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
        // Assumed, not authored — reported rather than warned; see SizingReport.assumed.
        assumed.push(axis);
      } else needs.push(axis);
    } else {
      // Undeclared, and nothing to slice. The default an undeclared axis takes is a claim about
      // the operating point like any other, so it is held against the one value the table was
      // taken at: a table characterized at vsb = 0.3 on every row does not answer for a source
      // at the body, and reading it as if it did would size the device somewhere nobody wrote
      // down. The author states the value — the same fail-closed path a sweep that leaves the
      // default out takes above. (The drain voltage has no default, and never gets here unstated.)
      const own = t.grid.axes.find((a) => a.name === axis);
      const def = AXIS_DEFAULT_BIAS.get(axis);
      if (own && def !== undefined && !takenAt(axis, own.values[0], def)) {
        needs.push(axis);
        taken.push(`${axis} = ${shown(own.values[0])}, not at the default ${axis} = ${def}`);
      }
    }
  }
  // What the table lacks comes first: no declaration the author could add would make it answer.
  // An axis that still needs declaring rides along as data, so the fix for it stays on offer.
  const toDeclare = drain ? ['vds', ...needs] : needs;
  if (lacking.length)
    return {
      error: sweepRefusal(lacking),
      unswept: lacking.map((u) => u.axis),
      ...(toDeclare.length ? { needs: toDeclare } : {}),
    };
  if (needs.length) {
    const list = needs.join(', ');
    const swept = needs.length - taken.length;
    return {
      error:
        (drain ? `${drain}; ` : '') +
        `declare the operating point (${list}) in the givens — ` +
        [
          ...(swept
            ? [
                `the table has ${swept > 1 ? 'those axes' : 'that axis'} and sizing must fix ` +
                  `${swept > 1 ? 'them' : 'it'} at a value`,
              ]
            : []),
          ...taken.map((at) => `the table was taken at ${at}`),
        ].join('; '),
      needs: toDeclare,
    };
  }
  if (drain) return { error: drain, needs: toDeclare };
  return { table: t, bias, assumed, clamped, ...(diode ? { diode } : {}) };
}

/**
 * Put a sizing's operating point in scope: gm/gm_id/id/W/vgs/vstar/cgg/vnth_m/… and every
 * pass-through column the table carries (`passthrough`, as the sizing reports them), which is how
 * a sheet reads a quantity the format has no name for.
 *
 * A pass-through column never replaces a name the sheet already uses: a param, a child's provide,
 * or an expression constant. Otherwise a column called `k` would replace Boltzmann's constant in
 * every equation after the sizing, on this table and no other. Such a column is left out of scope
 * and a warning says so, so neither side silently wins. Namespace quantities are always put in
 * scope: they are how the sheet reads its device.
 */
function mergeSized(
  values: Record<string, number>,
  quantities: Record<string, number>,
  passthrough: readonly string[],
  warn: (w: QAWarning) => void,
): void {
  const extra = new Set(passthrough);
  for (const [key, v] of Object.entries(quantities)) {
    if (extra.has(key)) {
      const taken = Object.prototype.hasOwnProperty.call(values, key)
        ? 'the sheet already defines that name'
        : Object.prototype.hasOwnProperty.call(CONSTANTS, key)
          ? 'that name is an expression constant'
          : undefined;
      if (taken) {
        warn({
          rule: 'sheet-passthrough',
          severity: 'warning',
          message: `the table's "${key}" column is not read: ${taken}, which keeps its meaning — rename the column in the export to read it`,
          location: 'givens',
          symbol: key,
        });
        continue;
      }
    }
    values[key] = v;
  }
}

/** Resolve the givens, call sizeDevice, and merge its operating point into `values`. */
function runSizing(
  b: SheetGivens,
  table: DeviceTable | undefined,
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
): SizingReport {
  // Every sizing failure surfaces an error warning AND an ok:false report, so the feasibility
  // aggregate fails closed no matter which path failed (no silent unsized "feasible" design).
  const fail = (
    error: string,
    why: Pick<SizingReport, 'needs' | 'clamped' | 'unswept'> = {},
  ): SizingReport => {
    warn({ rule: 'sheet-givens', severity: 'error', message: error, location: 'givens' });
    return {
      ok: false,
      W: NaN,
      L: NaN,
      vgs: NaN,
      id: NaN,
      error,
      ...(why.needs?.length ? { needs: why.needs } : {}),
      ...(why.clamped?.length ? { clamped: why.clamped } : {}),
      ...(why.unswept?.length ? { unswept: why.unswept } : {}),
    };
  };

  if (!table) return fail('no device to size against');

  const supplied = BINDABLE.filter((k) => b[k] !== undefined);
  const problem = bindProblem(supplied);
  if (problem) return fail(`givens ${problem}`);

  const L = evalScalar(b.L, values, scope, warn, 'given L');
  if (L === undefined || !Number.isFinite(L))
    return fail('given L did not resolve to a finite number');

  // A table taken at ONE length says which: a device is sized on it at that length and refused
  // at any other, like a bias on an axis the table does not sweep (see Unswept). A table with no
  // length axis at all records no length anywhere, so there is nothing to hold the given against;
  // the lookup refuses that table in its own words below.
  const lacking: Unswept[] = [];
  const lAxis = table.grid.axes.find((a) => a.name === 'l');
  if (lAxis?.values.length === 1) {
    const refused = unsweptGiven(table, 'L', 'l', L);
    if (refused) lacking.push(refused);
  }

  const sliced = applyGivensBias(b, table, values, scope, warn, lacking);
  if ('error' in sliced) return fail(sliced.error, sliced);

  const q: SizeQuery = { table: sliced.table, L };
  for (const k of supplied) {
    const v = evalScalar(b[k] as string, values, scope, warn, `given ${k}`);
    if (v === undefined || !Number.isFinite(v))
      return fail(`given ${k} did not resolve to a finite number`);
    q[k] = v;
  }

  try {
    const res = sizeDevice(q);
    mergeSized(values, res.quantities, res.passthrough, warn);
    values.ceiling = res.ceiling; // not in the quantities bag
    values.feasible = res.feasible ? 1 : 0;
    // Surface the sizer's own engineering notes (e.g. an L clamped onto the table's
    // hull) as advisory sheet warnings — same pattern children use at evalBlocks.
    // Severity 'warning', not 'error', so a clamp does not flip feasibility closed.
    for (const m of res.warnings) {
      warn({ rule: 'sheet-givens', severity: 'warning', message: m, location: 'givens' });
    }
    const report: SizingReport = { ok: true, W: res.W, L, vgs: res.vgs, id: res.id };
    if (Object.keys(sliced.bias).length) report.bias = sliced.bias;
    if (sliced.assumed.length) report.assumed = sliced.assumed;
    const clamped = [...sliced.clamped, ...res.clamped];
    // A diode connection is read on the vds = vgs diagonal. Where the gate voltage this device
    // landed on lies past the characterized vds range, the fold read the table's edge instead:
    // the folded table's own `vds` column says which drain voltage the point was taken at.
    const vdsRead = res.quantities.vds;
    if (
      sliced.diode?.clamped &&
      Number.isFinite(vdsRead) &&
      Math.abs(vdsRead - res.vgs) > HULL_SNAP * Math.max(1, Math.abs(res.vgs))
    )
      clamped.push('vds');
    if (clamped.length) report.clamped = clamped;
    return report;
  } catch (e) {
    let m = msg(e);
    // The lookup's "extra non-degenerate axis" error is accurate but not actionable in
    // sheet vocabulary — point the author at the fix.
    if (m.includes('non-degenerate axis'))
      m += ' — declare the operating point in the givens to collapse the axis';
    // What the failed sizing was read from still matters to whoever asks what the failure
    // means: a lookup that ran out of range on a table slice taken at its hull — a clamped
    // bias axis, a length off the hull, a diode diagonal that leaves the vds range — failed on
    // data from somewhere else, and says nothing certain about the point that was asked for.
    const off = [
      ...sliced.clamped,
      ...(lAxis && lAxis.values.length > 0 && offHull(lAxis.values, L) ? ['l'] : []),
      ...(sliced.diode?.clamped ? ['vds'] : []),
    ];
    return fail(`sizing failed: ${m}`, { clamped: off });
  }
}

/** Evaluate one check's two sides and classify into a signed-margin CheckResult. */
function evalCheck(
  check: SheetDoc['checks'][number],
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
): CheckResult {
  const text = `${check.lhs} ${check.op} ${check.rhs}`;
  const lhs = evalScalar(check.lhs, values, scope, warn, `check "${check.id}" lhs`);
  const rhs = evalScalar(check.rhs, values, scope, warn, `check "${check.id}" rhs`);
  const lhsValue = lhs ?? NaN;
  const rhsValue = rhs ?? NaN;
  const base = { id: check.id, kind: check.kind, op: check.op, text, lhsValue, rhsValue };

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
  if (check.op === '>=') margin = lhs - rhs;
  else if (check.op === '<=') margin = rhs - lhs;
  else {
    // '==' : the SIGNED distance INSIDE the tolerance band (≥ 0 ⟺ within tolerance ⟺ pass), so
    // the zero line is the real pass/fail boundary on the chart and in the margin column, exactly
    // like '>='/'<='. tolPct is relative to |rhs|, so it is inert when rhs is 0 (exact match only).
    margin = ((check.tolPct ?? 0) / 100) * Math.abs(rhs) - Math.abs(lhs - rhs);
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
  // one (see CheckResult.rawMargin).
  const rawMargin = margin;
  // see MARGIN_SNAP_REL — a spec set by its own givens must not coin-flip on FP noise
  const snapped =
    margin !== 0 && Math.abs(margin) <= MARGIN_SNAP_REL * Math.max(Math.abs(lhs), Math.abs(rhs));
  if (snapped) margin = 0;
  const marginPct = margin / Math.max(Math.abs(rhs), TINY);

  let status: CheckStatus;
  if (margin < 0) status = 'fail';
  else if (snapped)
    // A SNAPPED zero always reads amber, whatever the operator: the check is sitting on
    // its boundary by construction, and for '==' the alternative would be worse than a
    // coin flip — a margin just OUTSIDE the tolerance band silently reading full pass.
    status = 'amber';
  else if (check.op === '==')
    status = 'pass'; // '==' is pass/fail only — no near-miss (amber) band
  else status = marginPct < AMBER_BAND ? 'amber' : 'pass';
  return { ...base, margin, marginPct, rawMargin, status };
}

/**
 * Build a child doc with its param values overridden by expressions evaluated in the
 * PARENT scope as built so far: parent params, constants, and the provides of EARLIER
 * siblings (children evaluate in document order — the ratified idiom for a later block
 * carrying a value an earlier block derived, e.g. giving a spec exactly on the input
 * device and feeding the derived current to the branch blocks). Children run before
 * the parent's own sizing, so they never see the parent's sized device (that reverse
 * coupling stays deferred), and a forward sibling reference fails closed as undeclared.
 *
 * Fail-closed: a declared override is the parent EXPLICITLY supplying a value, so one that
 * cannot resolve to a finite number must NOT silently fall back to the child's embedded
 * default — that would size a different design than the author wired and could still read
 * feasible. A failed override raises an error (blocking feasibility) and returns ok:false
 * so the caller withholds the child's provides too.
 */
function applyBlockParams(
  block: SheetBlock,
  childDoc: SheetDoc,
  parentValues: Record<string, number>,
  parentScope: Scope,
  warn: (w: QAWarning) => void,
): { doc: SheetDoc; ok: boolean } {
  if (!block.params) return { doc: childDoc, ok: true };
  const childParams = new Map(childDoc.params.map((p) => [p.name, p]));
  const overrides: Record<string, number> = {};
  let ok = true;
  for (const [k, expr] of Object.entries(block.params)) {
    // An override key that names no child param is the same failure as an unresolvable
    // one: the parent explicitly supplied a value (typo and all) that will NOT reach the
    // child, so the child would size a different design than the author wired — and its
    // embedded default could still read feasible. Fail closed, by name.
    const child = childParams.get(k);
    if (child === undefined) {
      ok = false;
      warn({
        rule: 'sheet-block-param',
        severity: 'error',
        message: `block "${block.name}": override "${k}" does not match any child param (refusing to size the child on its embedded defaults)`,
        location: block.name,
      });
      continue;
    }
    // Overriding a param the CHILD solves for only moves its starting guess — the fixed point
    // decides the value, so the number the parent wired is not the one the child uses. Say so:
    // silently demoting an explicit wiring to a hint is the same class of surprise the
    // unmatched-key error above exists to prevent, and this one is easy to write by accident.
    if (torn(child)) {
      warn({
        rule: 'sheet-block-param',
        severity: 'warning',
        message: `block "${block.name}": override "${k}" sets a param the child solves for, so it only seeds the iteration — the converged value wins`,
        location: block.name,
      });
    }
    // A constrained param is stronger still: bisection needs no seed, so the wired value does
    // nothing.
    if (constrained(child)) {
      warn({
        rule: 'sheet-block-param',
        severity: 'warning',
        message: child.designConstraint.held
          ? `block "${block.name}": override "${k}" sets a node the child holds under a gate — here the hardware is held, so the child re-solves it and the override is ignored`
          : `block "${block.name}": override "${k}" sets a param the child CONSTRAINS — the engine chooses it from the constraint's own bracket, so the override is ignored entirely`,
        location: block.name,
      });
    }
    const v = evalScalar(expr, parentValues, parentScope, warn, `block "${block.name}" param ${k}`);
    if (v === undefined || !Number.isFinite(v)) {
      ok = false;
      warn({
        rule: 'sheet-block-param',
        severity: 'error',
        message: `block "${block.name}": override "${k}" did not resolve to a finite number (refusing to fall back to the child default)`,
        location: block.name,
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
 * Evaluate each block, merge its `provide`d scalars into the parent `values` as
 * flat `name__key` names, roll up its warnings (prefixed + attributed), and return a
 * per-child report. Runs BEFORE the parent's sizing/equations so the parent can reference a
 * child's outputs anywhere — including its own givens (e.g. a cascode carrying the child's
 * current). Fail-closed: a child that errors or is infeasible drags the parent down via
 * the rolled-up error warning + the children-feasibility fold in evaluateSheet.
 */
function evalBlocks(
  blocks: SheetBlock[],
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  depth: number,
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
  budget: SolveBudget,
): SheetBlockReport[] {
  const reports: SheetBlockReport[] = [];
  // Structural self-defense for direct evaluateSheet callers (runSheet validates, but
  // this entrypoint is public): a duplicate or empty block name would silently overwrite
  // the earlier sibling's provides — skip it, fail closed.
  const seenNames = new Set<string>();
  for (const block of blocks) {
    const dead = (message: string): void => {
      warn({ rule: 'sheet-block', severity: 'error', message, location: block.name });
      reports.push({
        name: block.name,
        title: block.doc?.title ?? block.ref ?? '',
        feasible: false,
        provides: {},
        checks: [],
      });
    };
    if (!block.name.trim()) {
      dead('a block has an empty name');
      continue;
    }
    // A ref that reached evaluation unmaterialized (the caller skipped resolveSheetRefs,
    // or resolution failed and already named why) must never size on nothing.
    const srcDoc = block.doc;
    if (!srcDoc) {
      dead(
        block.ref !== undefined
          ? `block "${block.name}": unresolved reference "${block.ref}" — resolve against a sheet library before evaluation`
          : `block "${block.name}" has neither an embedded doc nor a ref`,
      );
      continue;
    }
    if (seenNames.has(block.name)) {
      dead(`duplicate block name "${block.name}" — the block was skipped, not silently merged`);
      continue;
    }
    seenNames.add(block.name);
    if (depth >= MAX_BLOCK_DEPTH) {
      dead(`block "${block.name}": composition nested deeper than ${MAX_BLOCK_DEPTH}`);
      continue;
    }
    // A child names its own device id (else it inherits the parent table). A named device that the
    // resolver cannot supply fails closed with a clear, attributed message — rather than the generic
    // "no device to size against" the sizing would otherwise raise.
    let childTable = table;
    if (block.device !== undefined) {
      childTable = resolveDevice?.(block.device);
      if (childTable === undefined) {
        dead(`block "${block.name}": device "${block.device}" did not resolve`);
        continue;
      }
    }

    const { doc: childDoc, ok: paramsOk } = applyBlockParams(block, srcDoc, values, scope, warn);
    // evaluateNode, not evaluateSheet: a composed child never evaluates its own range ends —
    // the parent owns range claims (validation says so at the block).
    const res = evaluateNode(childDoc, childTable, resolveDevice, depth + 1, budget);

    // Roll up child warnings, attributed to the block (so a child error fails the
    // parent's closed feasibility, and the message points at the offending block).
    for (const w of res.warnings) warn(prefixBlockWarning(block.name, w));

    // Expose the child's declared `provides` as flat parent scalars — but ONLY when the
    // parent wiring was honored (paramsOk). On a broken override the child sized with the wrong
    // input, so its outputs are meaningless: withhold them so dependent parent math goes `na`.
    const provides: Record<string, number> = {};
    if (paramsOk) {
      for (const key of srcDoc.provides ?? []) {
        const v = res.values[key];
        if (v !== undefined && Number.isFinite(v)) {
          provides[key] = v;
          values[joinProvide(block.name, key)] = v;
        }
      }
    }
    reports.push({
      name: block.name,
      title: srcDoc.title,
      feasible: paramsOk && res.feasible,
      ...(res.sizing ? { sizing: res.sizing } : {}),
      provides,
      checks: res.checks,
      ...(res.blocks ? { blocks: res.blocks } : {}),
      ...(res.held ? { held: res.held } : {}),
    });
  }
  return reports;
}

/**
 * Check every block that DECLARES its gate wiring against the identity that wiring imposes:
 * the gate sits one gate-source voltage from the source, above it for an N device and below it
 * for a P one (see SheetWiring). Runs once, on the FINAL result of a node — after any constraint or
 * tearing solve, and after the parent's own equations, so a node the sheet defines as an equation
 * is as reachable as one it defines as a param, and a solver's probes never spam the diagnostic.
 *
 * The voltage compared against is the child's own SIZED vgs — the sizing's answer, which the sizing
 * always has — not a scalar the child publishes upward. That is what keeps the check
 * unswitchoffable: no `provides`, no parent expression, and no sign convention stands
 * between the declaration and the number it is checked against.
 *
 * A sheet that also claims operating ranges reports the disagreement once per RUN — the base
 * evaluation plus each range end, whose warnings ride its own report verbatim. That is
 * intended: a range end holds the SAME hardware at a different bias, and the identity is a
 * statement about voltages, so the residual there is a different measurement for a different reason
 * — not a duplicate of the first. A wiring declaration that holds at the center and breaks at a
 * range end is exactly the finding worth having twice.
 *
 * A DEDICATED evaluator, deliberately: every runtime problem here — an expression that does not
 * resolve, a block with no sized operating point, a disagreement past WIRING_TOL — is a
 * warning-severity 'sheet-wiring' diagnostic and nothing more. It never throws, never touches
 * feasibility, and never repairs anything. A wiring declaration describes the schematic the
 * author drew; when it disagrees with the sizing, which of the two is wrong is the author's
 * call, and an author who wants the disagreement to GATE writes a hard check on the same numbers.
 * (Structural problems — a half-declaration, an unknown key, an expression that does not parse —
 * are validation errors, which is the only way wiring reaches a verdict.)
 */
function checkWiring(doc: SheetDoc, res: SheetResult): SheetResult {
  // Shape-guarded rather than trusted: evaluate never throws, so a malformed authored doc
  // (blocks as a string, wiring as a string) has to degrade to "nothing to check".
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  const out: QAWarning[] = [];
  const scope = scalarScope(res.values);
  const sized = new Map((res.blocks ?? []).map((c) => [c.name, c.sizing]));
  for (const block of blocks) {
    // Read as `unknown`: a persisted doc reaches evaluation unverified, and the shape checks
    // below are the same ones validate.ts reports on — stated here in the types, not assumed.
    const w: unknown = block?.wiring;
    if (typeof w !== 'object' || w === null) continue;
    const decl = w as Record<string, unknown>;
    const where = `block "${block.name}" wiring`;
    const warn = (message: string): void => {
      out.push({ rule: 'sheet-wiring', severity: 'warning', message, location: block.name });
    };
    // A block the evaluation already killed — an unresolved ref, a device that did not resolve, an
    // override that would not evaluate, givens that could not size — has no operating point to
    // check against, and the reason is already reported. A second line advising a fix to the
    // wiring would be noise stacked on the finding, and worse, advice about the wrong thing. The
    // prefix match is what makes that true for a child's INTERNAL errors: they roll up to this
    // block under its path (`<block>.givens`, `<block>.<inner>`), not under the bare block name.
    // That path spelling is a contract with ONE owner — prefixBlockWarning (types.ts) — so this
    // match moves if and only if that function does.
    if (
      res.warnings.some(
        (v) =>
          v.severity === 'error' &&
          (v.location === block.name || (v.location ?? '').startsWith(block.name + PATH_SEP)),
      )
    )
      continue;
    // The sized gate-source voltage first: without it there is no identity to form, and reporting
    // each expression separately as well would turn one unsized block into three warnings.
    const vgs = sized.get(block.name)?.vgs;
    if (vgs === undefined || !Number.isFinite(vgs)) {
      warn(
        `${where}: the block declares no givens, so it has no sized gate-source voltage for the ` +
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
    const expected = source + (block.doc?.polarity === 'p' ? -1 : 1) * Math.abs(vgs);
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

  // 1. Seed top-level scalar params (a parent supplies a child's via its block's params). A param
  //    being solved for takes the current iterate in place of its authored starting guess.
  for (const p of doc.params) {
    const v = solved?.[p.name] ?? p.value;
    if (Number.isFinite(v)) values[p.name] = v;
  }
  const scope = scalarScope(values); // closes over the mutated `values`

  // 2. Compose children FIRST, so the parent can reference their provided scalars
  //    (name__key) in its own givens/equations/checks.
  const blocks =
    doc.blocks && doc.blocks.length > 0
      ? evalBlocks(doc.blocks, table, resolveDevice, _depth, values, scope, warn, budget)
      : undefined;

  // 3. Size the device — the ONLY place physics enters — when givens are declared.
  const sizing = doc.givens ? runSizing(doc.givens, table, values, scope, warn) : undefined;

  // 4. Author equations, in document order. An equation that cannot RESOLVE (missing quantity,
  //    parse error) is skipped with a plain warning — graceful degradation for optional
  //    data. An equation that resolves but computes NON-FINITE from finite inputs (sqrt of a
  //    negative headroom, a division by zero) means the design math itself broke at this
  //    point, so it is an error: feasibility must fail closed even when no hard check
  //    happens to reference the equation (an advisory-only figure of merit would otherwise
  //    render a green verdict over a NaN).
  for (const equation of doc.equations) {
    const r = evalScalar(equation.expr, values, scope, warn, `equation "${equation.name}"`);
    if (r === undefined) continue;
    if (!Number.isFinite(r)) {
      warn({
        rule: 'sheet-nonfinite',
        severity: 'error',
        message: `equation "${equation.name}" evaluated to a non-finite number from resolved inputs`,
        location: equation.name,
      });
      continue;
    }
    values[equation.name] = r;
  }

  // 5. Checks → signed margins.
  const checks = doc.checks.map((check) => evalCheck(check, values, scope, warn));

  // 6. Overall feasibility, fail-closed: declared givens sized successfully, every HARD check
  //    (physical = physical floor, spec = application spec) holds (pass or near-miss),
  //    EVERY child is feasible, and nothing errored. Advisory checks are excluded.
  const hard = checks.filter((r) => isHardCheck(r.kind));
  const feasible =
    // A sheet with givens needs the sizing to have succeeded AND the sizer's own verdict
    // (gm/ID ≤ the data ceiling) to hold — today the sizer throws past the ceiling, so
    // the flag is belt-and-suspenders, but it must never be silently ignored.
    (!doc.givens || ((sizing?.ok ?? false) && values.feasible !== 0)) &&
    hard.every((r) => r.status === 'pass' || r.status === 'amber') &&
    (blocks?.every((c) => c.feasible) ?? true) &&
    !warnings.some((w) => w.severity === 'error');

  return {
    values,
    sizing,
    checks,
    feasible,
    warnings,
    ...(blocks ? { blocks } : {}),
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
  if (depth >= MAX_BLOCK_DEPTH) return 0;
  // Each constrained param runs a solver too (bisection probes are passes), one per constraint.
  let n = (doc.params.some(torn) ? 1 : 0) + doc.params.filter(constrained).length;
  for (const u of doc.blocks ?? []) if (u.doc) n += tornSheets(u.doc, depth + 1);
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
    warnings: [...res.warnings, { rule: 'sheet-solve', severity: 'error', message }],
  };
}

/**
 * Evaluate a sheet against an optional device table. Never throws: seed params → (compose
 * children) → size → author-order equations → signed-margin checks → aggregate feasibility.
 * `resolveDevice` is only consulted by a block that names its own device; `_depth` is
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
 * sized against a stale estimate. `evalBlocks` recurses through here, so a child closes its
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

  // `extra` (a constrained param's probe value) merges UNDER the torn estimates: the two mechanisms
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
  // loop has iterated at all: an expensive sibling elsewhere in the design, or a design constraint
  // ABOVE this loop whose every probe re-closes it (the multiplicative cost is then this loop's
  // own, spread across probes). Blaming this loop alone would send an author to rewrite a sheet
  // that is fine; the message names both spenders because the engine cannot tell them apart here.
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
        `design constraint above this loop re-closing it on every probe. This loop was not shown to diverge. ` +
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
const CONSTRAINT_MAX_PROBES = 200;

/** Bracket-width tolerance, relative to the AUTHORED bracket's span — not to the iterates,
 *  which never close a purely relative test when the root sits at 0 (|lo|,|hi| stay ~constant
 *  while the width shrinks). Its own constant, looser than SOLVE_TOL_REL, because a bisection
 *  digit costs a full tree evaluation where a substitution digit is nearly free: 1e-6 lands in
 *  ~20 probes and resolves a volt-scale node to a microvolt. */
const CONSTRAINT_TOL_REL = 1e-6;

/** Residual tolerance at the accepted root, relative to the relation's RANGE over the authored
 *  bracket (max |lhs-rhs| at the two ends — already in hand from the sign check). Scaling by the
 *  range is form-invariant: the verdict is the same whether the author writes lhs=CM_in/rhs=CM_dc
 *  or lhs=CM_in-CM_dc/rhs=0, where scaling by |lhs| itself rejected every correct root written in
 *  residual form and waved through a real jump riding a large DC offset. A steep-but-continuous
 *  relation leaves a residual of (slope x final width) — vanishing on the range scale — while a
 *  JUMP leaves a fixed fraction of it. */
const CONSTRAINT_RESIDUAL_REL = 1e-5;

/** The least a held expression may move across its bracket, as a fraction of what its own param's
 *  term moves. For a node under a gate the rest of the expression is a gate-source voltage, which
 *  moves the same way as the node, so the true ratio is at least one; a cancelled or unresponsive
 *  relation leaves rounding error, some ten orders below this. */
const HOLD_SLOPE_MIN = 1e-6;

/**
 * Evaluate a sheet document — the single public entry. A doc that declares an operating
 * range dispatches to the range wrapper; everything else, and every step the engine takes
 * below the top of a tree (composed children, solver probes, the range-end runs themselves),
 * goes through evaluateNode — which structurally has no range branch, so "range ends evaluate
 * only at the top" holds with no runtime guard to maintain.
 */
export function evaluateSheet(
  doc: SheetDoc,
  table?: DeviceTable,
  resolveDevice?: DeviceResolver,
): SheetResult {
  // Array.isArray, not truthiness: evaluate never throws, and a malformed doc (operatingRange as a
  // string or object — validation's problem) must degrade to a plain evaluation, not a
  // TypeError out of .map.
  return Array.isArray(doc.operatingRange) && doc.operatingRange.length
    ? evaluateWithRange(doc, table, resolveDevice)
    : evaluateTop(doc, table, resolveDevice);
}

/** How many params the tree constrains — each one a bisection of its own. */
function constraintCount(doc: SheetDoc, depth = 0): number {
  if (depth >= MAX_BLOCK_DEPTH) return 0;
  let n = doc.params.filter(constrained).length;
  for (const u of doc.blocks ?? []) if (u.doc) n += constraintCount(u.doc, depth + 1);
  return n;
}

/**
 * evaluateNode for the top of a tree, refusing a tree whose design constraints depend on each other
 * ACROSS levels. A child solves its own constraints inside each of its parent's probes, which is
 * exact while the child's relations do not read the parent's constrained param; when they do, the
 * nesting would close a coupled system by iteration, which this engine does not do. One level's own
 * constraints are ordered (or refused) where they are solved; this is the same question asked of
 * the whole tree, in the words validation raises. Two constraints are the fewest that can depend on
 * each other.
 */
function evaluateTop(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
): SheetResult {
  const res = evaluateNode(doc, table, resolveDevice, 0);
  if (constraintCount(doc) < 2) return res;
  const plan = constraintPlan(doc);
  // A pair on the top level itself was already refused, in these words, where it would have
  // been solved.
  return 'problem' in plan && !res.warnings.some((w) => w.message === plan.problem)
    ? solveFailed(res, plan.problem)
    : res;
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
  return checkWiring(doc, withHeld(doc, solveNode(doc, table, resolveDevice, _depth, budget)));
}

/** The finished run with each of the doc's `hold` expressions evaluated against it (see
 *  SheetResult.held). One that does not evaluate fails the run: a fixed-hardware run would have
 *  nothing to hold it at. */
function withHeld(doc: SheetDoc, res: SheetResult): SheetResult {
  const params = doc.params.filter(holds);
  if (params.length === 0) return res;
  const scope = scalarScope(res.values);
  const held: Record<string, number> = {};
  let out = res;
  for (const p of params) {
    const v = evalScalar(p.hold, res.values, scope, NO_WARN, `hold ${p.name}`);
    if (v !== undefined && Number.isFinite(v)) held[p.name] = v;
    else
      out = solveFailed(
        out,
        `param "${p.name}": hold "${p.hold}" did not evaluate to a finite number`,
      );
  }
  return { ...out, held };
}

/**
 * Resolve one node's engine-solved parameters. Two mechanisms, by what the author could
 * honestly write down:
 *
 *  - `solveFor` — the param is an ESTIMATE of a value the sheet itself resolves; closed by
 *    damped substitution (solveTorn above), with all the care that method needs.
 *  - `designConstraint` — the param is a FREE internal variable (a node voltage) chosen so an
 *    output equals a spec. Closed by bisection on the param's [min, max]: no contraction
 *    requirement, no overshoot, no dependence on a starting guess. The honesty conditions are
 *    explicit — `lhs - rhs` must change sign across the bracket and must actually reach zero at
 *    the root — and every violation fails closed with the reason, never a design sized where the
 *    data was not.
 *
 * The constraint solve is the OUTER loop: each probe re-closes any torn loops inside, and both
 * mechanisms draw on the one tree-wide pass budget, so nesting stays bounded.
 */
function solveNode(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  _depth: number,
  budget: SolveBudget,
): SheetResult {
  // One home for the structural design-constraint checks (validateSheet raises the same words as
  // errors); checked BEFORE filtering by the constrained() shape guard, because the guard rejects a
  // half-written constraint — which would otherwise sail past as "no constraints" and freeze the
  // param.
  const problem = constraintProblem(doc.params);
  if (problem) {
    return solveFailed(solveTorn(doc, table, resolveDevice, _depth, budget), problem);
  }
  const constrainedParams = doc.params.filter(constrained);
  if (constrainedParams.length === 0) return solveTorn(doc, table, resolveDevice, _depth, budget);

  // Several constraints at one level are solved one at a time, each after the ones its relation
  // reads and with those held at the values they landed on. constraintPlan proves that order
  // exists; when it does not, the constraints form a coupled system and nothing is solved.
  let order = constrainedParams;
  if (constrainedParams.length > 1) {
    const plan = constraintPlan(doc);
    if ('problem' in plan)
      return solveFailed(solveTorn(doc, table, resolveDevice, _depth, budget), plan.problem);
    const rank = new Map(plan.order.map((name, at) => [name, at]));
    const at = (p: SheetVar): number => rank.get(p.name) ?? Infinity;
    order = [...constrainedParams].sort((a, b) => at(a) - at(b));
  }
  const landed: Record<string, number> = {};
  let last: SheetResult | undefined;
  for (const p of order) {
    const { res, ok } = solveConstraint(doc, p, landed, table, resolveDevice, _depth, budget);
    if (!ok) return res;
    landed[p.name] = res.values[p.name];
    last = res;
  }
  return last as SheetResult;
}

/**
 * Bisect one constrained param on its bracket, with the ones solved before it (`landed`) held at
 * their values. `ok` is false for every way the solve can fail — each returns the last evaluation
 * marked infeasible with the reason — and true only for a root that was actually reached.
 */
function solveConstraint(
  doc: SheetDoc,
  p: SheetVar & { designConstraint: { lhs: string; rhs: string; held?: boolean } },
  landed: Record<string, number>,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  _depth: number,
  budget: SolveBudget,
): { res: SheetResult; ok: boolean } {
  const { lhs, rhs } = p.designConstraint;
  // A constraint generated from a hold is named as the author wrote it.
  const what = `${p.designConstraint.held ? 'held' : 'constrained'} param "${p.name}"`;
  const failed = (res: SheetResult, message: string) => ({
    res: solveFailed(res, message),
    ok: false,
  });
  const probeAt = (x: number): SheetResult => {
    budget.left--;
    return solveTorn(doc, table, resolveDevice, _depth, budget, { ...landed, [p.name]: x });
  };

  /** lhs - rhs at an already-evaluated probe; undefined when either side does not resolve.
   *  Diagnostics are swallowed (NO_WARN): a side that stops resolving is reported once,
   *  with the constraint's own message, not once per probe. */
  const gap = (res: SheetResult): number | undefined => {
    const at = (src: string): number | undefined => {
      const v = evalScalar(
        src,
        res.values,
        scalarScope(res.values),
        NO_WARN,
        `constraint ${p.name}`,
      );
      return v !== undefined && Number.isFinite(v) ? v : undefined;
    };
    const l = at(lhs);
    const r = at(rhs);
    return l === undefined || r === undefined ? undefined : l - r;
  };
  const unevaluated = (res: SheetResult, x: number, which: string) => {
    // A device its table cannot answer for is why nothing evaluated, and no bracket sizes it:
    // say so here, where the reader is looking, in place of advice that would not help.
    const refused = refusedIn(res);
    return failed(
      res,
      `${what}: ${lhs} - ${rhs} did not evaluate at the ${which} of ` +
        `its bracket (${p.name} = ${x}) — ` +
        (refused.length
          ? `a device was not sized there: ${refused.join('; ')}`
          : `tighten min/max to where the design sizes`),
    );
  };

  let lo = p.min!;
  let hi = p.max!;
  const span = hi - lo;
  const first = probeAt(lo);
  let gLo = gap(first);
  if (gLo === undefined) return unevaluated(first, lo, 'low end');
  const second = probeAt(hi);
  const gHi = gap(second);
  if (gHi === undefined) return unevaluated(second, hi, 'high end');
  // A held expression is its own param's term plus the rest (see SheetVar.hold), so across the
  // bracket it has to move about as far as that term does. When it does not, the rest cancels the
  // term — on a table that does not respond, or by rounding alone — and no value of the param is
  // singled out. Checked before either end can be taken as a root, because a cancelled relation
  // reads zero-to-rounding everywhere.
  if (p.designConstraint.held) {
    const own = Math.abs(additiveCoefficient(lhs, p.name) ?? 0) * span;
    if (!(Math.abs(gHi - gLo) >= HOLD_SLOPE_MIN * own))
      return failed(
        second,
        `${what}: ${lhs} moves by ${Math.abs(gHi - gLo).toExponential(3)} across ` +
          `[${lo}, ${hi}] where ${p.name} alone accounts for ${own.toExponential(3)} — holding ` +
          `it does not determine ${p.name} here (numerically unresolved)`,
      );
  }
  if (gLo === 0) return { res: first, ok: true };
  if (gHi === 0) return { res: second, ok: true };
  if (gLo > 0 === gHi > 0) {
    return failed(
      second,
      `${what}: ${lhs} - ${rhs} does not change sign across ` +
        `[${lo}, ${hi}] (${gLo.toExponential(3)} at both … ${gHi.toExponential(3)}) — the ` +
        `bracket does not straddle the target. Widen min/max, or the relation cannot reach it ` +
        `on this table`,
    );
  }
  // The residual scale for the acceptance test below: the relation's range over the authored
  // bracket, captured before the loop shrinks it. Nonzero here — a zero end already returned.
  const gScale = Math.max(Math.abs(gLo), Math.abs(gHi));

  let res = second;
  for (let probes = 0; probes < CONSTRAINT_MAX_PROBES && budget.left > 0; probes++) {
    const mid = (lo + hi) / 2;
    res = probeAt(mid);
    const g = gap(res);
    if (g === undefined)
      return failed(
        res,
        `${what}: ${lhs} - ${rhs} stopped evaluating inside the bracket ` +
          `(${p.name} = ${mid}) — the relation is not defined everywhere between min and max`,
      );
    if (g === 0) return { res, ok: true }; // an exact root needs no residual argument
    if (g > 0 === gLo > 0) {
      lo = mid;
      gLo = g;
    } else hi = mid;
    // Accept only a genuine crossing: a relation that JUMPS across the target brings the bracket
    // to nothing while the residual stays macroscopic.
    if (hi - lo <= CONSTRAINT_TOL_REL * span) {
      if (Math.abs(g) > CONSTRAINT_RESIDUAL_REL * gScale)
        return failed(
          res,
          `${what}: the bracket closed but ${lhs} - ${rhs} still reads ` +
            `${g.toExponential(3)} — the relation steps across the target without touching it ` +
            `(a table edge or a fold), so no ${p.name} in [${p.min}, ${p.max}] produces it`,
        );
      return { res, ok: true };
    }
  }

  return failed(
    res,
    budget.left <= 0
      ? `${what} stopped before its bracket closed because the design's ` +
          `shared iteration budget ran out — spent by the loops this constraint re-closes on every ` +
          `probe, or by an expensive sibling elsewhere in the tree. This constraint was not shown ` +
          `to be unsolvable`
      : `${what}: the bracket did not close in ${CONSTRAINT_MAX_PROBES} probes`,
  );
}

/**
 * Evaluate a doc that declares an operating range: the base run, then one more complete
 * evaluation per range end with that end's params overridden. Every run — base and each end —
 * takes the default budget of a fresh top-level call: each is a complete evaluation with its own
 * solves to close, and sharing one pool sized for a single solve would starve the later runs into
 * phantom failures. Cost is therefore at most (1 + range-end count) full evaluations, the price
 * of a swept sample never disagreeing with the same numbers evaluated alone. A base run that did
 * not stand costs one, for the reason below.
 *
 * Two questions, answered apart. `feasible` is the base run's own verdict and nothing here
 * touches it. `complies` is whether that design, HELD FIXED (see coverage.ts), still works at
 * every range end — conditional on there being a design at all. When the base run did not stand,
 * every end comes back `not-run` rather than carrying a verdict about hardware the engine never
 * landed on — a failed design constraint leaves its last bisection probe in the result with every
 * sizing reading `ok`, so "the devices sized" is nowhere near enough to have produced an instance.
 * Check FAILURES do not gate: a center that misses its spec is still a design, and whether it holds
 * across its claimed range is still a real question.
 */
function evaluateWithRange(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
): SheetResult {
  const base = evaluateTop(doc, table, resolveDevice);
  const rangeEnds = doc.operatingRange ?? [];
  if (!stands(base)) {
    const reports = rangeEnds.map((e): RangeEndReport => ({
      name: e.name,
      state: 'not-run',
      // No `set`: the overrides resolve against the base VALUES, which here are wherever the
      // failed solve stopped. Reporting the point that would have been asked about from those
      // is reporting a phantom, the same reason a bracket end is never reported as a landing.
      set: {},
      checks: [],
      solved: {},
      warnings: [],
    }));
    return { ...base, rangeEnds: reports };
  }
  // A design resting on an assumed voltage has no answer at a range end: holding a typed guess
  // fixed while the range moves around it measures the guess. Asked, and declined with the
  // reason — never run, so no outcome exists that could be mistaken for a finding.
  const assumed = dcInputs(doc).assumed;
  if (assumed.length) {
    const error = assumedLevelRefusal(assumed);
    const reports = rangeEnds.map((e): RangeEndReport => ({
      name: e.name,
      state: 'no-answer',
      set: {},
      checks: [],
      solved: {},
      warnings: [],
      error,
    }));
    return { ...base, rangeEnds: reports, complies: false };
  }
  const held = holdHardware(doc, base);
  const reports = rangeEnds.map((e) => runRangeEnd(e, held, base, table, resolveDevice));
  return { ...base, rangeEnds: reports, complies: reports.every((r) => r.state === 'complies') };
}

/**
 * What one evaluation of a HELD design amounts to, as an answer to "does it still work here":
 * the classification every compliance point shares, whether "here" is a range end or another
 * process condition.
 *
 * - it completed, every device read where it was asked for: `complies` when every hard check
 *   holds, else `does-not-comply` (the failures are in the run's checks);
 * - a device held at its width cannot carry its current here: `does-not-comply`, with `error`;
 * - it did not complete for any other reason, or completed on data read off the table's hull:
 *   `no-answer`, with `error` — the solver's message verbatim where there is one.
 *
 * An `error` means the run's check outcomes are not findings about this point.
 */
export function heldOutcome(res: SheetResult): {
  state: Exclude<PointState, 'not-run'>;
  error?: string;
} {
  // The SOLVER's own message when one exists — a child's solve failure rolls up mid-evaluation
  // and later diagnostics (a non-finite parent equation) land after it, so "last error" alone
  // reports the consequence instead of the cause. One reverse scan: remember the last error of any
  // kind as the fallback, prefer the last sheet-solve. (Reverse loop: the target lib predates
  // findLast, and a filter would copy the array to read one element.)
  let err: string | undefined;
  let lastError: string | undefined;
  for (let i = res.warnings.length - 1; i >= 0 && err === undefined; i--) {
    const w = res.warnings[i];
    if (w.severity !== 'error') continue;
    lastError ??= w.message;
    if (w.rule === 'sheet-solve') err = w.message;
  }
  err ??= lastError;

  // First: did every device have a table that could answer for it? One that was refused leaves
  // the rest of the run evaluating a design with a device missing, so whatever stopped it next —
  // a solve that could not land, another device running out of table — is a consequence, and
  // which of them happens to be reported last depends on the order the blocks are written in.
  const refused = refusedIn(res);
  if (refused.length) return { state: 'no-answer', error: refused.join('; ') };

  // Then: was every device read where it was asked for? A bias clamp fires
  // exactly at a claim's extreme, and no verdict — green, red, or "this device cannot carry its
  // current" — may rest on data taken at the table's edge instead. That holds for a run that
  // completed and for one whose lookup then ran out of range on the clamped slice.
  const off = clampedIn(res);
  if (off.length)
    return {
      state: 'no-answer',
      error:
        `the table does not reach this point (${off.join(', ')}) — it was read at the nearest ` +
        `characterized point, which is not the point asked about` +
        (err === undefined ? '' : `; the run then stopped: ${err}`),
    };
  if (err !== undefined) {
    // A device held at a fixed width can run out of table: the bias here moves the density its
    // current (or transconductance) needs outside the swept vgs range, and the inverse lookup
    // says so in its own accurate but width-domain words. Past the TOP of that range the device
    // cannot carry what the design asks of it — a failure of the design, and the one way a run
    // that did not complete is still a verdict. Lead with what it means for the question being
    // asked and keep the lookup's message behind it, where its reach numbers stay quotable.
    // Below the bottom of the range the device would simply sit at a gate voltage nobody
    // characterized, which is no answer like any other gap in the data.
    const reach = LOOKUP_RANGE_MESSAGE.exec(err);
    if (reach && Number(reach[2]) > Number(reach[4]))
      return {
        state: 'does-not-comply',
        error:
          `this device cannot ${reach[1] === 'id' ? 'carry its current' : 'reach its transconductance'}` +
          ` here — ${err}`,
      };
    return { state: 'no-answer', error: err };
  }
  return { state: res.feasible ? 'complies' : 'does-not-comply' };
}

/** One range end: resolve its `set` expressions against the base result, re-evaluate the
 *  FIXED-HARDWARE form of the doc with those values (through evaluateNode, so the run cannot
 *  recurse into range ends), and classify the outcome (see RangeEndReport.state):
 *
 *  - every hard check holds: `complies`. One fails: `does-not-comply`, the failures in `checks`.
 *  - a device held at its width cannot carry its current here: `does-not-comply`, with `error`.
 *  - the run could not be completed — a `set` that does not resolve, a solve that does not
 *    land — or it completed on data read off the table's hull: `no-answer`, the underlying
 *    message VERBATIM in `error`, so a shared-budget starvation stays distinguishable from
 *    "the bracket cannot reach it". */
function runRangeEnd(
  rangeEnd: SheetRangeEnd,
  held: HeldHardware,
  base: SheetResult,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
): RangeEndReport {
  // Copied per report rather than shared: the transformation allocates one list for the whole
  // document, and a consumer that sorted or de-duplicated one report's copy in place would be
  // rewriting every sibling's at the same time.
  const assumed = held.assumedSource.length
    ? { assumedSource: [...held.assumedSource] }
    : undefined;
  const scope = scalarScope(base.values);
  const over: Record<string, number> = {};
  /** Asked, and nothing was evaluated that could answer. */
  const unanswered = (error: string): RangeEndReport => ({
    name: rangeEnd.name,
    state: 'no-answer',
    set: over,
    checks: [],
    solved: {},
    warnings: [],
    error,
    ...assumed,
  });
  // `?? {}`: a half-written range end (no set) is validation's error to name; evaluate never
  // throws.
  for (const [param, expr] of Object.entries(rangeEnd.set ?? {})) {
    const v = evalScalar(expr, base.values, scope, NO_WARN, `range end ${rangeEnd.name}`);
    if (v === undefined || !Number.isFinite(v))
      return unanswered(
        `range end "${rangeEnd.name}": set ${param} = "${expr}" did not evaluate to a finite ` +
          `number against the base result`,
      );
    over[param] = v;
  }
  // A hold with no recorded value has nothing to be held at. Unreachable while the base run
  // stands (a hold that does not evaluate fails it), so this is the closed door behind that.
  if (held.unheld.length)
    return unanswered(
      `range end "${rangeEnd.name}": no nominal value was recorded for the held expression of ` +
        held.unheld.join(', '),
    );
  const res = evaluateTop(withParams(held.doc, over), table, resolveDevice);
  const { state, error: err } = heldOutcome(res);
  // The solved map is "where the range end LANDED" — a run with an `error` (a solve that never
  // landed, data read somewhere else) leaves values that must not be reported as a landing.
  const solved: Record<string, number> = {};
  if (err === undefined)
    for (const p of held.doc.params)
      if (engineSolved(p) && Number.isFinite(res.values[p.name]))
        solved[p.name] = res.values[p.name];
  // The run's warnings ride the report VERBATIM (never merged into the parent's), so the base
  // result's warning contract stays untouched.
  return {
    name: rangeEnd.name,
    state,
    set: over,
    checks: res.checks,
    ...(res.blocks ? { blocks: res.blocks } : {}),
    solved,
    warnings: res.warnings,
    ...(err !== undefined ? { error: err } : {}),
    ...assumed,
  };
}
