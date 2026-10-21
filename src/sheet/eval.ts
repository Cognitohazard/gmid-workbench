// Evaluate a leaf design-sheet in ONE pass: seed params, (optionally) size the device
// via sizeDevice, then evaluate author equations in document order and evaluate each check into
// a signed-margin result. Reuses the expression engine (compileExpr), the bind-any-2
// sizing (sizeDevice), and the constant scope verbatim — it adds no numeric or parser
// logic and solves no circuit: a declared netlist is checked against the finished result
// (nodes.ts) and never feeds back into it. Pure, deterministic, never throws. Zero DOM.

import { LOOKUP_RANGE_MESSAGE } from '../types';
import type { DeviceTable, QAWarning, Scope, Value } from '../types';
import { CONSTANTS } from '../constants';
import { compileExpr, metaScalars, noiseSource } from '../derive';
import { AXIS_DEFAULT_BIAS } from '../namespace';
import { additiveCoefficient, scalarScope } from '../expr';
import { BINDABLE, bindProblem, sizeDevice, type SizeQuery } from '../device';
import { fixTable } from '../series';
import { diodeGrid, offHull } from '../grid';
import {
  BIAS_AXES,
  MAX_BLOCK_DEPTH,
  balancedBy,
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
  withParams,
} from './types';
import { assumedLevelRefusal, holdHardware, type HeldHardware } from './coverage';
// A value as a message quotes it: what the author wrote, without the float tail arithmetic leaves
// on it (`0.1 + 0.2` reads 0.3, not 0.30000000000000004).
import { shown } from './linear';
import { dcInputs, solvePlan, solvedRelation } from './validate';
import {
  blockWires,
  childFindingsOf,
  flattened,
  formatOf,
  formatProblems,
  readsParentSelector,
  structuralDiodes,
  unwalkedReport,
  withNodes,
  withoutWalk,
  type WiringMode,
} from './nodes';
import type {
  SizingReport,
  CheckOp,
  CheckResult,
  CheckStatus,
  SheetGivens,
  SheetBlockReport,
  SheetDoc,
  SheetRangeEnd,
  RangeEndReport,
  PointOutcome,
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
 * the check compares it against (SOLVE_TOL_REL x the stated range's span, stretched by the
 * relation's slope — microvolts on a volt-scale node, ~1e-6 relative). Without the snap
 * either verdict is a coin flip. 1e-5 covers the constraint case with margin while staying two
 * orders below the ~0.1% the sizer resolves between grid nodes — a check "failing" by
 * less than the data can distinguish is not failing, it is sitting on the boundary,
 * and the snap reads it as the deterministic near-miss (amber) that it is.
 */
export const MARGIN_SNAP_REL = 1e-5;

/** How far a diode-connected device's drain voltage may sit from its gate voltage, relative to
 *  the gate voltage, before the difference is the table's hull rather than interpolation. */
const HULL_SNAP = 1e-6;

/** How far a stated bias may sit from the one value a table was taken at and still be that
 *  value: float rounding at volt scale, the allowance a swept axis's ends are read with. */
const HULL_SNAP_V = 1e-9;

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
      /** Each declared axis value as the givens state it, before any clamp to the table. */
      stated: Record<string, number>;
      assumed: string[];
      clamped: string[];
      /** A diode connection folded the vds axis; `clamped` when the vgs sweep leaves the
       *  characterized vds range somewhere, so part of the diagonal reads the table's edge. */
      diode?: { clamped: boolean };
    }
  | { error: string; needs?: string[]; unswept?: string[] } {
  let t = table;
  const bias: Record<string, number> = {};
  const stated: Record<string, number> = {};
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
      stated[axis] = v;
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
  return { table: t, bias, stated, assumed, clamped, ...(diode ? { diode } : {}) };
}

/** Where a sized device sits relative to its saturation edge: the drain-source voltage its givens
 *  state (signed, in the table's axis convention) and the sizing's own vdsat. Either is absent
 *  when the sizing has none to give — no vdsat column, a device that did not size. */
interface RegionPoint {
  vds?: number;
  vdsat?: number;
  /** The direction of the table's own vds axis: +1 where it holds no negative value, −1 where it
   *  holds no positive one (a signed PMOS export), undefined where it spans both or is absent. */
  axis?: 1 | -1;
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

/** Resolve the givens, call sizeDevice, and merge its operating point into `values` (through
 *  mergeSized, so a pass-through column never shadows a name the sheet uses). `point` receives
 *  the two numbers the region check reads, taken from the givens and the sizing rather than from
 *  `values`, where a param or equation of the same name could stand in for them. */
function runSizing(
  b: SheetGivens,
  table: DeviceTable | undefined,
  values: Record<string, number>,
  scope: Scope,
  warn: (w: QAWarning) => void,
  point: RegionPoint = {},
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
    const report: SizingReport = {
      ok: true,
      W: res.W,
      L,
      vgs: res.vgs,
      id: res.id,
      noise: noiseSource(table.grid),
    };
    if (Object.keys(sliced.bias).length) report.bias = sliced.bias;
    // The drain voltage the region check compares: the one the givens STATE, not the one a
    // table that does not reach it was read at. A clamp is reported where it happens (`clamped`
    // and its warning), and comparing the clamped value would let a drain stated below the
    // table's lowest vds pass a saturation check it fails. On a diode diagonal the folded table's
    // own column is the drain voltage.
    point.vds = sliced.stated.vds ?? (sliced.diode ? res.quantities.vds : undefined);
    point.vdsat = res.quantities.vdsat;
    const vdsAxis = table.grid.axes.find((a) => a.name === 'vds')?.values;
    if (vdsAxis?.length) {
      const lo = Math.min(...vdsAxis);
      const hi = Math.max(...vdsAxis);
      point.axis = lo >= 0 ? 1 : hi <= 0 ? -1 : undefined;
    }
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
  return classify({ id: check.id, kind: check.kind, op: check.op, text }, lhs, rhs, check.tolPct);
}

/** A check's two sides, already evaluated, as a signed-margin CheckResult — the one reading of a
 *  comparison that authored checks and the engine's own region check share. */
function classify(
  check: Pick<CheckResult, 'id' | 'kind' | 'op' | 'text'>,
  lhs: number | undefined,
  rhs: number | undefined,
  tolPct?: number,
): CheckResult {
  const lhsValue = lhs ?? NaN;
  const rhsValue = rhs ?? NaN;
  const base = { ...check, lhsValue, rhsValue };

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
    margin = ((tolPct ?? 0) / 100) * Math.abs(rhs) - Math.abs(lhs - rhs);
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
 * The check a declared region adds to its device (see SheetGivens.region): `abs(vds) >= vdsat` in
 * saturation, `abs(vds) <= vdsat` in triode, with the stated drain voltage and the sizing's vdsat.
 * A physical check like any authored one, so it gates feasibility, sweeps and compliance the same
 * way. Everything that leaves it without two numbers — no vdsat column, a device that did not
 * size, a region the validator refuses — reads `na`, which a hard check fails closed on.
 *
 * The magnitude is compared only where the stated voltage points the way the table's own vds axis
 * does. One of the other sign is a device with its drain and source the other way round: the
 * table characterizes no such point (the sizing reads it at the axis's edge, with a warning), and
 * its magnitude clearing vdsat says nothing about saturation, so the check fails, in either
 * region, with the reason.
 */
function regionCheck(
  b: SheetGivens,
  sizing: SizingReport | undefined,
  point: RegionPoint,
): CheckResult {
  const op: CheckOp = b.region === 'triode' ? '<=' : '>=';
  const check = { id: 'region', kind: 'physical' as const, op, text: `abs(vds) ${op} vdsat` };
  const na = (detail: string): CheckResult => ({
    ...classify(check, undefined, undefined),
    detail,
  });
  if (b.region !== 'saturation' && b.region !== 'triode')
    return na(`region "${String(b.region)}" is neither saturation nor triode`);
  if (b.diode === true) return na('a diode connection ties vds to vgs, so it declares no region');
  if (!sizing?.ok) return na('the device was not sized');
  if (point.vds === undefined || !Number.isFinite(point.vds))
    return na('the drain-source voltage the givens state is not known');
  if (point.vdsat === undefined || !Number.isFinite(point.vdsat))
    return na('the table has no vdsat column');
  // Float rounding about zero is a drain at the source, not a reversed one (HULL_SNAP_V).
  if (point.axis !== undefined && point.vds * point.axis < -HULL_SNAP_V) {
    // Read the other way round, the drain sits |vds| on the wrong side of the source: a margin of
    // that size below zero, whichever region was declared.
    const margin = -Math.abs(point.vds);
    return {
      ...classify(check, Math.abs(point.vds), point.vdsat),
      lhsValue: point.vds * point.axis,
      margin,
      rawMargin: margin,
      marginPct: margin / Math.max(Math.abs(point.vdsat), TINY),
      status: 'fail',
      detail:
        `the stated drain-source voltage ${shown(point.vds)} V points against this table's vds ` +
        `axis, so the device is reverse-biased — drain and source the other way round — which ` +
        `the table does not characterize`,
    };
  }
  return classify(check, Math.abs(point.vds), point.vdsat);
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
    // Overriding a param the CHILD solves does nothing: the child searches it in its own range
    // whatever is wired in, so the number the parent wired is not the one the child uses. Say so:
    // silently dropping an explicit wiring is the same class of surprise the unmatched-key error
    // above exists to prevent, and this one is easy to write by accident.
    if (engineSolved(child)) {
      warn({
        rule: 'sheet-block-param',
        severity: 'warning',
        message:
          constrained(child) && child.designConstraint.held
            ? `block "${block.name}": override "${k}" sets a param the child holds — a node under a gate, or a current its balance fixes — and here the hardware is held, so the child re-solves it and the override is ignored`
            : `block "${block.name}": override "${k}" sets a param the child SOLVES — the engine searches it in its own range, so the override is ignored entirely`,
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
  parent: SheetDoc,
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
  for (const block of parent.blocks ?? []) {
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
    // A child document in a format this app does not read is kept as stored, never evaluated.
    if (formatOf(srcDoc) === 'unknown') {
      dead(`block "${block.name}": ${formatProblems(srcDoc)[0].message}`);
      continue;
    }
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
    // the parent owns range claims (validation says so at the block). Its wiring is read once the
    // whole tree has settled (see finishWiring), in the mode its parent asks for: a block that
    // names the wires its child's device sits on, or whose device reads a selector the parent
    // declares, asks for that device's operating point; a child whose wiring joins the parent's
    // walk reports its held levels and element values instead of walking itself (see withNodes).
    const mode: WiringMode = {
      wired: blockWires(parent, block) !== undefined || readsParentSelector(parent, block),
      flattened: flattened(parent, srcDoc, block),
    };
    const res = evaluateNode(childDoc, childTable, resolveDevice, depth + 1, { budget });

    // Roll up child warnings, attributed to the block (so a child error fails the
    // parent's closed feasibility, and the message points at the offending block).
    for (const w of res.warnings) warn(prefixBlockWarning(block.name, w));

    // Expose the child's declared `provides` as flat parent scalars — but ONLY when the
    // parent wiring was honored (paramsOk) and the child's own solve landed. On a broken override
    // the child sized with the wrong input; after a solve that found nothing or did not settle,
    // its numbers are whatever its last probe left behind. Either way its outputs are
    // meaningless: withhold them so dependent parent math goes `na` — and a parent search does not
    // steer by them, which would land it on roots that exist only in a failed child's leftovers.
    const solveFailedInChild = res.warnings.some(
      (w) => w.rule === 'sheet-solve' && w.severity === 'error',
    );
    const provides: Record<string, number> = {};
    if (paramsOk && !solveFailedInChild) {
      for (const key of srcDoc.provides ?? []) {
        const v = res.values[key];
        if (v !== undefined && Number.isFinite(v)) {
          provides[key] = v;
          values[joinProvide(block.name, key)] = v;
        }
      }
    }
    const report: SheetBlockReport = {
      name: block.name,
      title: srcDoc.title,
      feasible: paramsOk && res.feasible,
      ...(res.sizing ? { sizing: res.sizing } : {}),
      provides,
      checks: res.checks,
      ...(res.blocks ? { blocks: res.blocks } : {}),
      ...(res.held ? { held: res.held } : {}),
    };
    PENDING_WIRING.set(report, { doc: childDoc, res, table: childTable, mode });
    reports.push(report);
  }
  return reports;
}

/** A child's wiring, to be read once its tree has settled: what withNodes needs of it. Keyed by
 *  the child's report, so only the reports of the evaluation a tree keeps are ever read. */
interface PendingWiring {
  doc: SheetDoc;
  res: SheetResult;
  table: DeviceTable | undefined;
  mode: WiringMode;
}
const PENDING_WIRING = new WeakMap<SheetBlockReport, PendingWiring>();

/**
 * The wiring of every child in a settled tree, read once: the child's device point and held
 * levels where its parent's walk reads them, and the walk or selector check of a child that runs
 * its own — innermost first, so each check counts what its own children found. Every solver probe
 * of the tree before this one is thrown away unread. Where the tree's point is not `sized`, nothing
 * is walked or checked, and each child that would have run its own check reports not-evaluated
 * (see unwalkedReport). A child's findings are attributed to its block path and follow the tree's
 * own warnings; an error among them fails the child, every block above it, and the tree closed.
 */
function finishWiring(res: SheetResult, sized: boolean): SheetResult {
  if (!res.blocks?.length) return res;
  const extra: QAWarning[] = [];
  const visit = (
    reports: readonly SheetBlockReport[],
    path: readonly string[],
  ): { blocks: SheetBlockReport[]; failed: boolean } => {
    let failed = false;
    const blocks = reports.map((report) => {
      const below = report.blocks ? visit(report.blocks, [...path, report.name]) : undefined;
      let out: SheetBlockReport = below ? { ...report, blocks: below.blocks } : report;
      let bad = below?.failed ?? false;
      const pending = PENDING_WIRING.get(report);
      if (pending && !sized) {
        // The report the check would have written, saying it did not run: none where the parent's
        // walk covers the child, or where the child is read only for its device point.
        const covered =
          pending.mode.flattened || (pending.mode.wired && formatOf(pending.doc) === 'earlier');
        const nodes = covered ? undefined : unwalkedReport(pending.doc, childFindingsOf(out));
        if (nodes) out = { ...out, nodes };
      } else if (pending) {
        const walked = withNodes(
          pending.doc,
          { ...pending.res, ...(out.blocks ? { blocks: out.blocks } : {}), warnings: [] },
          pending.table,
          pending.mode,
        );
        const at = [...path, report.name];
        for (const w of walked.warnings)
          extra.push(at.reduceRight((acc, seg) => prefixBlockWarning(seg, acc), w));
        if (walked.warnings.some((w) => w.severity === 'error')) bad = true;
        out = {
          ...out,
          ...(walked.terminals ? { terminals: walked.terminals } : {}),
          ...(walked.nodes ? { nodes: walked.nodes } : {}),
          ...(walked.wiringValues ? { wiringValues: walked.wiringValues } : {}),
        };
      }
      if (bad) {
        out = { ...out, feasible: false };
        failed = true;
      }
      return out;
    });
    return { blocks, failed };
  };
  const { blocks, failed } = visit(res.blocks, []);
  return {
    ...res,
    blocks,
    warnings: [...res.warnings, ...extra],
    ...(failed ? { feasible: false } : {}),
  };
}

/**
 * One evaluation pass. `solved` overrides the seeded values of the params the engine solves (the
 * point a search is probing); everything else behaves as if the doc had those values. Every call
 * is one evaluation charged to the tree's budget, children's included.
 */
function evaluateOnce(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  _depth: number,
  budget: SolveBudget,
  solved?: Record<string, number>,
): SheetResult {
  budget.left--;
  const warnings: QAWarning[] = [];
  const warn = (w: QAWarning): void => void warnings.push(w);
  const values: Record<string, number> = {};

  // 0. Device-metadata scalars — the same scope derive/tableScope uses: T/UT (so
  //    temperature-aware author math and the γ-model noise evaluate at the table's
  //    characterization temperature) and the characterization width `w`. Seeded
  //    before params, so a same-named param deliberately wins.
  if (table) Object.assign(values, metaScalars(table.meta));

  // 1. Seed top-level scalar params (a parent supplies a child's via its block's params). A solved
  //    param takes the value the search is probing in place of its stored one.
  for (const p of doc.params) {
    const v = solved?.[p.name] ?? p.value;
    if (Number.isFinite(v)) values[p.name] = v;
  }
  const scope = scalarScope(values); // closes over the mutated `values`

  // 2. Compose children FIRST, so the parent can reference their provided scalars
  //    (name__key) in its own givens/equations/checks.
  const blocks =
    doc.blocks && doc.blocks.length > 0
      ? evalBlocks(doc, table, resolveDevice, _depth, values, scope, warn, budget)
      : undefined;

  // 3. Size the device — the ONLY place physics enters — when givens are declared.
  const point: RegionPoint = {};
  const sizing = doc.givens ? runSizing(doc.givens, table, values, scope, warn, point) : undefined;

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

  // 5. Checks → signed margins, then the region the givens declare, which is this device's own.
  const checks = doc.checks.map((check) => evalCheck(check, values, scope, warn));
  if (doc.givens?.region !== undefined) checks.push(regionCheck(doc.givens, sizing, point));

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
 * How close a solved param must be to its root, relative to the param's STATED range — not to its
 * value, which never closes a relative test when the root sits at 0. 1e-6 resolves a volt-scale
 * node to a microvolt. It is one tolerance, in the param's own terms, everywhere it is used: the
 * search's bracket closes to it, and "the relation reads within tolerance" means the relation
 * reads no more than its local slope times it — the param is within SOLVE_TOL_REL of the span of
 * its root. Measuring in the param's terms rather than the relation's is what keeps a steep
 * relation honest: an exponential reads a large number a hair off its root, and a small one on a
 * flat stretch far from it. The search's interpolation steps converge faster than halving near the
 * root, so these last digits cost a probe or two, not one probe each.
 */
export const SOLVE_TOL_REL = 1e-6;

/** The least a held expression may move across its range, as a fraction of what its own param's
 *  term moves. For a node under a gate the rest of the expression is a gate-source voltage, which
 *  moves the same way as the node, and for a current balance (`I_bias - p__id`) it is the other
 *  branch's current, which moves against the param's own: either way the true ratio is at least
 *  one, and a cancelled or unresponsive relation leaves rounding error, some ten orders below
 *  this. */
const HOLD_SLOPE_MIN = 1e-6;

/**
 * How many times a search halves its way in from an end of the stated range where the relation
 * does not evaluate — a device with no headroom there, a lookup out of range, a refused device —
 * toward a point where it does. Such an end says the circuit has no operating point there, not
 * that the search failed, so the search moves to the nearest point that evaluates and searches
 * what is left. Eight halvings place that point within 1/256 of the range of the edge — a few
 * millivolts on a volt-scale node, finer than any author states a range to — for at most eight
 * evaluations per end.
 */
const INWARD_STEPS = 8;

/**
 * How many sweeps a set of solved params that depend on each other gets. One sweep searches each
 * member in turn, with the others at their current values; the set has settled when every
 * member's relation, read from the sweep's last evaluation, is within its tolerance (see settle).
 * The library's dependent pairs — a tail node and the split of the pair standing on it, in the 5T
 * and the two-stage Miller OTA — settle in one sweep at the design point and in two or three where
 * the hardware is held: each relation reads the other unknown only through a weak second-order
 * effect, so every sweep shrinks what is left by orders of magnitude. The most any library case
 * needs is four: the 5T on sky130's low-threshold device, held at 125 C and asked at the top of
 * its common-mode range. Six leaves that case a margin without changing what the number means.
 * It is FIXED rather than tuned, because it is the line the scope rule draws: a set still moving
 * after this many sweeps depends on itself strongly enough that repeating searches until
 * something gives would be iterating a coupled system to convergence, and the engine reports it
 * instead.
 */
export const SOLVE_SWEEPS = 6;

/** Probes one search may spend, approximately — a backstop far above what a search needs on a
 *  finite range (the interpolation steps fall back to halving whenever they stop gaining, so
 *  twenty-odd halvings bound it in practice); the shared budget is the real ceiling. It is checked
 *  once per step, so a step that stops to go round a stretch that does not evaluate, or to narrow
 *  a closed bracket, can carry one search a few tens of probes past it. */
const SEARCH_MAX_PROBES = 200;

/**
 * The evaluations one composed tree may spend, counted per evaluation of any document in it — a
 * probe of a three-child sheet costs four. A search costs a few tens of evaluations, a set that
 * depends on each other a few searches per sweep, and a child solves inside every evaluation of
 * its parent, so nesting multiplies: the ceiling is there so a deep tree of solved params stops
 * with a reason instead of running for minutes. The library's costliest tree (the two-stage
 * Miller OTA, held at a sky130 process condition) spends about 430 of them.
 */
export const SOLVE_EVALUATIONS = 10000;

/** The evaluations left to one composed evaluation, shared by every node of the tree. */
interface SolveBudget {
  left: number;
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
 * Evaluate a sheet document — the single public entry. A doc that declares an operating
 * range dispatches to the range wrapper; everything else, and every step the engine takes
 * below the top of a tree (composed children, solver probes, the range-end runs themselves),
 * goes through evaluateNode — which structurally has no range branch, so "range ends evaluate
 * only at the top" holds with no runtime guard to maintain. `opts.held` marks a held design asked
 * about at another condition (see EvaluateOptions).
 */
export function evaluateSheet(
  authored: SheetDoc,
  table?: DeviceTable,
  resolveDevice?: DeviceResolver,
  opts: EvaluateOptions = {},
): SheetResult {
  // A document in a format this app does not read is not evaluated: rebuilding its meaning from
  // keys this engine does not know would report on a design nobody wrote.
  if (formatOf(authored) === 'unknown')
    return { values: {}, checks: [], feasible: false, warnings: formatProblems(authored) };
  // A device whose wires put its gate on its drain is diode-connected, and is sized on the
  // diode diagonal like one that says so (see structuralDiodes) — stated before anything sizes.
  const doc = structuralDiodes(authored);
  // Array.isArray, not truthiness: evaluate never throws, and a malformed doc (operatingRange as a
  // string or object — validation's problem) must degrade to a plain evaluation, not a
  // TypeError out of .map.
  return Array.isArray(doc.operatingRange) && doc.operatingRange.length
    ? evaluateWithRange(doc, table, resolveDevice, opts)
    : evaluateNode(doc, table, resolveDevice, 0, opts);
}

/** How a caller asks evaluateSheet about a document. */
export interface EvaluateOptions {
  /** The document is a held design (see holdHardware) asked about at another condition: its point
   *  is classified like a range end's (heldOutcome). */
  held?: boolean;
  /** The assumed DC inputs the design rests on (dcInputs), where the caller has them: the point
   *  then has no compliance answer, though its wiring is still checked (see pointOutcome). */
  assumed?: readonly string[];
}

/** How one node of a tree is evaluated (see evaluateNode): the tree's evaluation budget, and, at
 *  the top, how its point is classified. */
interface NodeOptions extends EvaluateOptions {
  budget?: SolveBudget;
}

/**
 * Evaluate one node of a sheet tree: solve it (below). A node below the top returns its solved
 * result as it is — its wiring is read when the whole tree has settled. At the top, the run is
 * classified once as a compliance point (pointOutcome), and then, only where its sizing stood,
 * every node's wiring is read on that settled design: the children's (finishWiring), then the
 * top's own walk (withNodes) — so a solver probe's intermediate value is never a wiring
 * disagreement, and a point with no sized design reports not-evaluated rather than findings (see
 * withoutWalk). A call at the top of a tree (no budget passed) starts the tree's evaluation budget.
 */
function evaluateNode(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  depth: number,
  opts: NodeOptions = {},
): SheetResult {
  const res = withHeld(
    doc,
    solveNode(doc, table, resolveDevice, depth, opts.budget ?? { left: SOLVE_EVALUATIONS }),
  );
  if (depth > 0) return res;
  const point = pointOutcome(res, opts.held === true, opts.assumed);
  if (!point.sized) return { ...withoutWalk(doc, finishWiring(res, false)), point };
  const out = withNodes(doc, finishWiring(res, true), table, { wired: false, flattened: false });
  // The point was classified before the wiring was read; a selector the table contradicts then
  // leaves the run infeasible, so a centre that complied does not.
  const raised = out.warnings.slice(res.warnings.length).find((w) => w.severity === 'error');
  return {
    ...out,
    point:
      raised && point.state === 'complies'
        ? { ...point, state: 'does-not-comply', error: raised.message }
        : point,
  };
}

/**
 * How far from zero a current balance may read where the design is sized, as a fraction of its
 * param's own magnitude. The balance is zero by construction — the device was sized to carry the
 * current the param sets — so what is left is rounding, some ten orders below this; anything
 * larger is a hold that does not balance what it names.
 */
const BALANCE_TOL_REL = 1e-6;

/** The finished run with each of the doc's `hold` expressions evaluated against it (see
 *  SheetResult.held). One that does not evaluate fails the run: a fixed-hardware run would have
 *  nothing to hold it at. So does a current balance (a hold that reads a device's current, see
 *  balancedBy) that is not zero here: held at whatever it read, it would carry an offset between
 *  the two currents to every condition the design is asked about, and the declaration that the
 *  two are one current would be false at the very point it was made. */
function withHeld(doc: SheetDoc, res: SheetResult): SheetResult {
  const params = doc.params.filter(holds);
  if (params.length === 0) return res;
  const scope = scalarScope(res.values);
  const held: Record<string, number> = {};
  let out = res;
  for (const p of params) {
    const v = evalScalar(p.hold, res.values, scope, NO_WARN, `hold ${p.name}`);
    if (v === undefined || !Number.isFinite(v)) {
      out = solveFailed(
        out,
        `param "${p.name}": hold "${p.hold}" did not evaluate to a finite number`,
      );
      continue;
    }
    const tol = BALANCE_TOL_REL * Math.abs(res.values[p.name] ?? p.value);
    if (balancedBy(doc, p).length && !(Math.abs(v) <= tol)) {
      out = solveFailed(
        out,
        `param "${p.name}": hold "${p.hold}" reads a device's current, so it is a current ` +
          `balance, and a current balance must be zero where the design is sized — it reads ` +
          `${v.toExponential(3)} here (tolerance ${tol.toExponential(3)}, a millionth of ` +
          `${p.name}). Write it as the param less the current it has to equal`,
      );
      continue;
    }
    held[p.name] = v;
  }
  return { ...out, held };
}

/** One solved param as a search reads it: its relation (`lhs - rhs` reads zero at the answer), the
 *  range it is searched in, and how messages name it. */
interface Unknown {
  p: SheetVar;
  lhs: string;
  rhs: string;
  /** A node under a gate, re-solved where the hardware is held (see SheetVar.hold). */
  held: boolean;
  what: string;
  lo: number;
  hi: number;
}

function unknownOf(p: SheetVar): Unknown {
  const { lhs, rhs } = solvedRelation(p) as { lhs: string; rhs: string };
  const held = constrained(p) && p.designConstraint.held === true;
  return {
    p,
    lhs,
    rhs,
    held,
    what: `${held ? 'held' : 'solved'} param "${p.name}"`,
    lo: p.min as number,
    hi: p.max as number,
  };
}

/** An unknown's unit as a message appends it — none for a dimensionless share. */
const unitOf = (u: Unknown): string => (u.p.unit && u.p.unit !== '1' ? ` ${u.p.unit}` : '');

/** A value, and a range, of an unknown as a message quotes them. */
const valueOf = (u: Unknown, x: number): string => `${shown(x)}${unitOf(u)}`;
const rangeOf = (u: Unknown, lo: number, hi: number): string =>
  `[${shown(lo)}, ${shown(hi)}]${unitOf(u)}`;

/** Unknowns named for a sentence, each with the range it is searched in: `"a" in [0, 1] V`,
 *  `"a" in … and "b" in …`, `"a" in …, "b" in … and "c" in …`. */
const nameList = (us: readonly Unknown[]): string => {
  const q = us.map((u) => `"${u.p.name}" in ${rangeOf(u, u.lo, u.hi)}`);
  return q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}` : q[0];
};

/** What the search reads at a node: the document, its table, the shared budget, and the current
 *  value of every solved param of the node, which each probe evaluates with. */
interface SolveContext {
  doc: SheetDoc;
  table: DeviceTable | undefined;
  resolveDevice: DeviceResolver | undefined;
  depth: number;
  budget: SolveBudget;
  at: Record<string, number>;
}

/** `lhs - rhs` of an unknown's relation at an evaluated probe; undefined when either side does
 *  not resolve to a finite number. Diagnostics are swallowed (NO_WARN): a relation that stops
 *  resolving is reported once, with the solve's own message, not once per probe. */
function relationAt(u: Unknown, res: SheetResult): number | undefined {
  const scope = scalarScope(res.values);
  const at = (src: string): number | undefined => {
    const v = evalScalar(src, res.values, scope, NO_WARN, `relation ${u.p.name}`);
    return v !== undefined && Number.isFinite(v) ? v : undefined;
  };
  const l = at(u.lhs);
  const r = at(u.rhs);
  return l === undefined || r === undefined ? undefined : l - r;
}

/** Why an unknown's relation did not evaluate at a probe, in the words the probe's own evaluation
 *  gives: a device its table cannot answer for first (no range or re-bias changes that), then the
 *  first error the evaluation raised — a device that did not size there, typically. */
function whyNot(u: Unknown, res: SheetResult): string {
  const refused = refusedIn(res);
  if (refused.length) return refused.join('; ');
  const error = res.warnings.find((w) => w.severity === 'error');
  if (error) return error.message;
  // Nothing in the evaluation failed, so the relation itself reads something that is not there.
  const said: string[] = [];
  const scope = scalarScope(res.values);
  for (const side of [u.lhs, u.rhs])
    evalScalar(side, res.values, scope, (w) => void said.push(w.message), `relation ${u.p.name}`);
  return said[0] ?? `${u.lhs} - (${u.rhs}) does not resolve to a finite number`;
}

/** One probe: the node evaluated with the unknown at `x`, and its relation there or why not. */
interface Probe {
  x: number;
  res: SheetResult;
  g?: number;
  why?: string;
}

/** How a solve ended. `ok` only for an answer that was reached; every failure carries the last
 *  evaluation and the message that names it. */
type Outcome = { ok: true; res: SheetResult } | { ok: false; res: SheetResult; message: string };

/** A search's answer: where the unknown landed, the evaluation there, and the relation's slope at
 *  the root — what converts the param's tolerance into the relation's units wherever the relation
 *  is read again (see holdsAt). */
type Found =
  | { ok: true; res: SheetResult; x: number; slope: number }
  | {
      ok: false;
      res: SheetResult;
      message: string;
      /** The budget ran out: nothing the other members of a set do can give it back, so a retry
       *  would only fail the same way. */
      final?: boolean;
    };

/**
 * Find one unknown with every other solved param of the node at its current value (`ctx.at`):
 * Brent's method on the stated range — bisection, with secant and inverse-quadratic steps taken
 * only while they stay inside the bracket and keep shrinking it, so the root stays enclosed from
 * the first probe to the last and the answer is a function of the range and the relation alone.
 *
 * Every way it can end is one of the three outcomes a solve reports:
 *  - a root reached: the bracket closed to SOLVE_TOL_REL of the stated span, and the relation at
 *    the accepted point reads within its tolerance by the slope just outside the bracket (a jump
 *    fails this: beside a step the relation barely moves, so the slope there leaves no room for
 *    the step's height); or an end of the range reads within its tolerance of zero by the slope
 *    there, and is the root;
 *  - no solution found in the range: the relation does not change sign across what was searched
 *    and neither end is within its tolerance of zero (none, or an even number, of roots), jumps
 *    across the target, does not appear to depend on the param at all, or (held) does not single
 *    the node out;
 *  - not settled: nothing of the range could be evaluated, the sign changes across a stretch
 *    inside the bracket that does not evaluate, the shared budget ran out (here or in a child a
 *    probe evaluated), or the probe backstop was hit.
 * An end where the relation does not evaluate is stepped inward (INWARD_STEPS) before any of that,
 * and a point inside the bracket that does not evaluate is stepped round the same way,
 * silently; a failure's message quotes the range actually searched. `also` are the other members
 * of a set searched together; a message says where they stood, because an answer about this
 * unknown is an answer at those values.
 */
function search(ctx: SolveContext, u: Unknown, also: readonly Unknown[]): Found {
  const name = u.p.name;
  const rel = `${u.lhs} - (${u.rhs})`;
  const given = also.length
    ? ` (searched with ${also.map((o) => `${o.p.name} = ${valueOf(o, ctx.at[o.p.name])}`).join(', ')})`
    : '';
  const tol = SOLVE_TOL_REL * (u.hi - u.lo);
  let probes = 0;
  let last: SheetResult | undefined;
  /** A failed search, carrying `at` — the evaluation that shows why — or else the last one. */
  const failed = (message: string, at?: Probe, final = false): Found => {
    // Only the budget can stop a search before its first probe; the node is evaluated once even
    // then, so the failure still carries a result to read.
    last ??= evaluateOnce(ctx.doc, ctx.table, ctx.resolveDevice, ctx.depth, ctx.budget, ctx.at);
    return { ok: false, res: at?.res ?? last, message, ...(final ? { final } : {}) };
  };
  const exhausted = (): Found =>
    failed(
      `${u.what} in ${rangeOf(u, u.lo, u.hi)} stopped before it settled because the design's ` +
        `shared evaluation budget (${SOLVE_EVALUATIONS} evaluations) ran out — spent by the ` +
        `solves each of its probes re-runs, or by an expensive sibling elsewhere in the tree. ` +
        `It was not shown to be unsolvable`,
      undefined,
      true,
    );
  const probe = (x: number): Probe | undefined => {
    if (ctx.budget.left <= 0) return undefined;
    probes++;
    const res = evaluateOnce(ctx.doc, ctx.table, ctx.resolveDevice, ctx.depth, ctx.budget, {
      ...ctx.at,
      [name]: x,
    });
    last = res;
    const g = relationAt(u, res);
    // A relation that did not evaluate because the budget ran out inside this probe — a child's
    // solve stopping short — says nothing about this point: the search is out of budget, and says
    // so in the budget's words rather than as anything about the relation.
    if (g === undefined && ctx.budget.left <= 0) return undefined;
    return g === undefined ? { x, res, why: whyNot(u, res) } : { x, res, g };
  };
  /** Halve from `bad`, where the relation does not evaluate, toward `good`, where it does, keeping
   *  each midpoint as the new `good` when it evaluates and as the new `bad` when it does not. What
   *  comes back is the evaluating point nearest the edge, and why the nearest failing one failed. */
  const inward = (bad: Probe, good: Probe): { at: Probe; why: string } | undefined => {
    for (let k = 0; k < INWARD_STEPS; k++) {
      const m = probe((bad.x + good.x) / 2);
      if (!m) return undefined;
      if (m.g === undefined) bad = m;
      else good = m;
    }
    return { at: good, why: bad.why as string };
  };

  /** The relation's slope at `p`, read from one more probe a tolerance away toward `toward` — the
   *  local slope a tolerance in the param's terms is converted with. Undefined when that point
   *  does not evaluate; null when the budget ran out. */
  const slopeAt = (p: Probe, toward: number): number | undefined | null => {
    const step = Math.sign(toward - p.x) * tol;
    const q = probe(p.x + step);
    if (!q) return null;
    return q.g === undefined ? undefined : Math.abs((q.g - (p.g as number)) / step);
  };

  let lo = probe(u.lo);
  if (!lo) return exhausted();
  let hi = probe(u.hi);
  if (!hi) return exhausted();
  const moved: string[] = [];
  if (lo.g === undefined || hi.g === undefined) {
    let mid: Probe | undefined;
    if (lo.g === undefined && hi.g === undefined) {
      mid = probe((u.lo + u.hi) / 2);
      if (!mid) return exhausted();
      // Three failed points show nothing about the rest of the range: a stretch that evaluates
      // between them, with a root in it, is not ruled out. So this is not "no solution".
      if (mid.g === undefined)
        return failed(
          `${u.what} in ${rangeOf(u, u.lo, u.hi)} did not settle: nothing of the range could be ` +
            `evaluated: ${rel} does not evaluate at either end of it or at its middle — ` +
            `${lo.why}${given}`,
          lo,
        );
    }
    if (lo.g === undefined) {
      const step = inward(lo, mid ?? hi);
      if (!step) return exhausted();
      lo = step.at;
      moved.push(`the relation does not evaluate below ${name} = ${valueOf(u, lo.x)}: ${step.why}`);
    }
    if (hi.g === undefined) {
      const step = inward(hi, mid ?? lo);
      if (!step) return exhausted();
      hi = step.at;
      moved.push(`the relation does not evaluate above ${name} = ${valueOf(u, hi.x)}: ${step.why}`);
    }
  }
  const gLo = lo.g as number;
  const gHi = hi.g as number;
  // Stepping in from one end can come all the way back to the other: as far as halving can tell,
  // the relation evaluates at that end alone, which shows nothing about the rest of the range.
  if (lo.x === hi.x)
    return gLo === 0
      ? { ok: true, res: lo.res, x: lo.x, slope: 0 }
      : failed(
          `${u.what} in ${rangeOf(u, u.lo, u.hi)} did not settle: nothing of the range but ` +
            `${name} = ${valueOf(u, lo.x)} could be evaluated, and ${rel} reads ` +
            `${gLo.toExponential(3)} there — ${moved.join('; ')}${given}`,
          lo,
        );
  const range = moved.length
    ? `the searched range ${rangeOf(u, lo.x, hi.x)} (${moved.join('; ')})`
    : rangeOf(u, lo.x, hi.x);
  if (u.held) {
    // A held expression is its own param's term plus the rest (see SheetVar.hold), so across the
    // range it has to move about as far as that term does. When it does not, the rest cancels the
    // term — on a table that does not respond, or by rounding alone — and no value of the param is
    // singled out. Checked before either end can be taken as a root, because a cancelled relation
    // reads zero-to-rounding everywhere.
    const own = Math.abs(additiveCoefficient(u.lhs, name) ?? 0) * (hi.x - lo.x);
    if (!(Math.abs(gHi - gLo) >= HOLD_SLOPE_MIN * own))
      return failed(
        `${u.what} found no single solution in ${range}: ${u.lhs} moves by ` +
          `${Math.abs(gHi - gLo).toExponential(3)} across it where ${name} alone accounts for ` +
          `${own.toExponential(3)} — holding it does not determine ${name} here (numerically ` +
          `unresolved)${given}`,
        hi,
      );
  } else if (gLo === gHi) {
    // The same number, to the last bit, at both ends — and at the middle too — is what a relation
    // that does not read its param gives (a constraint on a param it never mentions, a param
    // solving for an alias of itself). Taken as found it would land on `min` with no warning. A
    // relation that is merely symmetric reads differently at the middle, and goes on to the tests
    // below; one that varies and happens to agree at the three points is refused all the same,
    // and the message says only what three points can show.
    const mid = probe((lo.x + hi.x) / 2);
    if (!mid) return exhausted();
    if (mid.g === gLo)
      return failed(
        `${u.what} is not determined by its relation: ${rel} reads ${gLo.toExponential(3)} at ` +
          `both ends of ${range} and at its middle — it does not appear to depend on ${name}, so ` +
          `no value of it is singled out${given}`,
        hi,
      );
  }
  // An end that reads exactly zero, or within its tolerance of zero by the slope there, is the
  // root — the second case is a root that sits on the end and lands a rounding error to the wrong
  // side of it, which the sign test alone would call no solution.
  const atEnd = (end: Probe, other: Probe): Found | null | undefined => {
    const slope = slopeAt(end, other.x);
    if (slope === null) return null;
    if (end.g === 0) return { ok: true, res: end.res, x: end.x, slope: slope ?? 0 };
    return slope !== undefined && Math.abs(end.g as number) <= slope * tol
      ? { ok: true, res: end.res, x: end.x, slope }
      : undefined;
  };
  if (gLo === 0 || gHi === 0 || gLo > 0 === gHi > 0) {
    // Both ends are asked, the nearer to zero first: a relation that is steep at one end can be
    // within its tolerance there while reading the smaller value at the other.
    const nearer = Math.abs(gLo) <= Math.abs(gHi) ? lo : hi;
    for (const end of [nearer, nearer === lo ? hi : lo]) {
      const root = atEnd(end, end === lo ? hi : lo);
      if (root === null) return exhausted();
      if (root) return root;
    }
    return failed(
      `${u.what} found no solution in ${range}: ${rel} does not change sign across it ` +
        `(${gLo.toExponential(3)} at ${shown(lo.x)}, ${gHi.toExponential(3)} at ${shown(hi.x)}) ` +
        `— none, or an even number, of roots there. Move or widen min/max to bracket one, or ` +
        `the relation does not reach its target on this table${given}`,
      hi,
    );
  }

  // Brent's method. `b` is the best estimate, `c` the contrapoint — the relation has opposite
  // signs at the two, so the root lies between them — and `a` the previous `b`. Each step tries
  // inverse-quadratic interpolation through a, b, c (or a secant through two of them), and takes
  // it only when it lands inside the bracket and shrinks faster than halving would; otherwise it
  // halves. The bracket width is the acceptance test, so a root is only ever accepted enclosed.
  let a = lo;
  let b = hi;
  let c = hi;
  let d = b.x - a.x;
  let e = d;
  /** The stretch last stepped round without either half changing sign on its own (see below). */
  let stuck: [number, number] | undefined;
  /** How often a closed bracket against a range end has been halved to tell a kink from a step. */
  let narrowed = 0;
  for (;;) {
    if ((b.g as number) > 0 === (c.g as number) > 0) {
      c = a;
      d = e = b.x - a.x;
    }
    if (Math.abs(c.g as number) < Math.abs(b.g as number)) {
      a = b;
      b = c;
      c = a;
    }
    const fa = a.g as number;
    const fb = b.g as number;
    const fc = c.g as number;
    const tol1 = 2 * Number.EPSILON * Math.abs(b.x) + 0.5 * tol;
    const xm = 0.5 * (c.x - b.x);
    if (fb === 0) {
      // An exact root needs no tolerance argument; the slope is still read, for the relation to
      // be judged against wherever it is read again.
      const slope = slopeAt(b, c.x);
      if (slope === null) return exhausted();
      return { ok: true, res: b.res, x: b.x, slope: slope ?? Math.abs((fc - fb) / (c.x - b.x)) };
    }
    if (Math.abs(xm) <= tol1) {
      // The bracket has closed. Across it the slope is whatever made the sign change; just outside
      // it, it is the relation's own. For a continuous relation the two agree. For one that steps
      // across the target, the slope outside knows nothing of the step, so the tolerance it gives
      // cannot hold the step's height and the crossing is refused as a jump — the same tolerance
      // test, read with the slope that tells the two apart. b's side is read first. When that
      // point lies outside the range, does not evaluate, or leaves the step unexplained, c's side
      // is read too and the steeper of the two kept: a kink beside the root leaves one side
      // shallow, a step leaves both flat.
      const across = Math.abs((fc - fb) / (c.x - b.x));
      /** The slope just outside the bracket beside `near` (b or c), from it to its reflection of
       *  `far`. Undefined when that point lies outside the searched range or does not evaluate;
       *  null when the budget ran out. */
      const outside = (near: Probe, far: Probe): number | undefined | null => {
        const x = near.x - (far.x - near.x);
        if (x < lo.x || x > hi.x) return undefined;
        const o = probe(x);
        if (!o) return null;
        return o.g === undefined ? undefined : Math.abs(((near.g as number) - o.g) / (near.x - x));
      };
      const sb = outside(b, c);
      if (sb === null) return exhausted();
      let slope = sb === undefined ? across : Math.min(across, sb);
      let sc: number | undefined = 0;
      if (sb === undefined || !(Math.abs(fb) <= slope * tol)) {
        const read = outside(c, b);
        if (read === null) return exhausted();
        sc = read;
        slope =
          sb === undefined && sc === undefined
            ? across
            : Math.min(across, Math.max(sb ?? 0, sc ?? 0));
      }
      // A side that cannot be read — the bracket closed against an end of the range — leaves only
      // the other, which may be the shallow side of a kink. Halving the bracket a few more times
      // tells the two apart: beside a kink the relation shrinks with the bracket until the root is
      // within tolerance, while a step keeps it at the step's height.
      if (
        !(Math.abs(fb) <= slope * tol) &&
        (sb === undefined || sc === undefined) &&
        narrowed < 4
      ) {
        narrowed++;
        const m = probe((b.x + c.x) / 2);
        if (!m) return exhausted();
        if (m.g !== undefined) {
          if (m.g === 0 || m.g > 0 === fc > 0) c = b;
          a = b;
          b = m;
          d = e = c.x - b.x;
          continue;
        }
      }
      if (!(Math.abs(fb) <= slope * tol))
        return failed(
          `${u.what} found no solution in ${range}: the search closed on ${name} = ` +
            `${valueOf(u, b.x)}, but ${rel} still reads ${fb.toExponential(3)} there, where just ` +
            `beside the crossing it moves by ${(slope * tol).toExponential(3)} over the ` +
            `tolerance — the relation steps across the target without touching it (a table edge ` +
            `or a fold)${given}`,
          b,
        );
      return { ok: true, res: b.res, x: b.x, slope };
    }
    if (probes >= SEARCH_MAX_PROBES)
      return failed(
        `${u.what} did not settle: its search in ${range} did not close in ${SEARCH_MAX_PROBES} ` +
          `probes${given}`,
      );
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p: number;
      let q: number;
      if (a.x === c.x) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const qa = fa / fc;
        const r = fb / fc;
        p = s * (2 * xm * qa * (qa - r) - (b.x - a.x) * (r - 1));
        q = (qa - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      else p = -p;
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }
    a = b;
    const next = probe(b.x + (Math.abs(d) > tol1 ? d : Math.sign(xm) * tol1));
    if (!next) return exhausted();
    if (next.g === undefined) {
      // A sign change across the bracket is evidence of a root, so a point inside it that does
      // not evaluate is a hole to step around, never a verdict. Halve from it toward each end of
      // the bracket to the nearest point that evaluates (INWARD_STEPS each way), and go on in a
      // half that still changes sign — b's first. When neither does, the sign changes somewhere
      // between the two points found, and halving may have stepped over a stretch that evaluates
      // (one stretch that does not, then another): search between them once more, narrower than
      // before. Only when a later probe falls back inside a stretch already stepped round, with
      // neither half changing sign again, is the crossing taken to be out of reach — and that is
      // not shown to be no solution.
      const nearB = inward(next, b);
      if (!nearB) return exhausted();
      const nearC = inward(next, c);
      if (!nearC) return exhausted();
      const [pb, pc] = [nearB.at, nearC.at];
      const flips = (p: Probe, q: Probe): boolean =>
        (p.g as number) === 0 || (p.g as number) > 0 !== (q.g as number) > 0;
      let half: [Probe, Probe] | undefined;
      if (pb !== b && flips(pb, b)) half = [b, pb];
      else if (pc !== c && flips(pc, c)) half = [pc, c];
      else if (!(stuck && next.x > stuck[0] && next.x < stuck[1]) && (pb !== b || pc !== c)) {
        // pb keeps b's sign and pc keeps c's, so they still bracket the crossing.
        stuck = [Math.min(pb.x, pc.x), Math.max(pb.x, pc.x)];
        half = [pb, pc];
      }
      if (!half)
        return failed(
          `${u.what} in ${rangeOf(u, u.lo, u.hi)} did not settle: ${rel} changes sign across ` +
            `${range}, but the crossing could not be followed: it lies between ${name} = ` +
            `${valueOf(u, Math.min(pb.x, pc.x))} and ${valueOf(u, Math.max(pb.x, pc.x))}, where ` +
            `the points tried do not evaluate — ${nearB.why}${given}`,
          next,
        );
      // Start again on the half, as on the whole range.
      [a, b] = half;
      c = b;
      d = e = b.x - a.x;
      continue;
    }
    b = next;
  }
}

/** An unknown's tolerance in its relation's units: its slope at the root times SOLVE_TOL_REL of
 *  its range. A relation read within it puts the param within SOLVE_TOL_REL of the span of its
 *  root, by the slope its last search read. */
const tolOf = (u: Unknown, slope: Record<string, number>): number =>
  slope[u.p.name] * SOLVE_TOL_REL * (u.hi - u.lo);

/** Whether an unknown's relation, read from an evaluation, is within its tolerance (tolOf) — the
 *  test a settled set and a verified node both apply. */
function holdsAt(u: Unknown, res: SheetResult, slope: Record<string, number>): boolean {
  const g = relationAt(u, res);
  return g !== undefined && Math.abs(g) <= tolOf(u, slope);
}

/**
 * Settle a set of solved params that depend on each other by repeating one-unknown searches: each
 * sweep searches every member in document order with the others at their current values. Never
 * more than SOLVE_SWEEPS sweeps: a set still moving after them is reported, naming its members and
 * the largest move of the last sweep, rather than iterated further. `slope` collects each member's
 * slope at its root from its last search, which the node's verification reads.
 *
 * The set has settled when every member's relation, read from the sweep's last evaluation — where
 * every member sits at the value it landed on — is within its tolerance: each member is within
 * SOLVE_TOL_REL of the span of its root, by its slope, given where the others ended up. That
 * evaluation then IS a simultaneous answer, and a confirming sweep would only land every search
 * where it already is.
 *
 * A member whose search fails inside a set has failed with the others where they happened to
 * stand, so its failure says nothing about the set: it is reported as the set not settling, never
 * as the member having no solution. On the first sweep, where the others may still sit at the
 * middle of their ranges, such a member is searched again after others have landed before
 * anything is reported.
 */
function settle(
  ctx: SolveContext,
  set: readonly Unknown[],
  slope: Record<string, number>,
): Outcome {
  let res: SheetResult | undefined;
  let moves: number[] = [];
  for (let sweep = 0; sweep < SOLVE_SWEEPS; sweep++) {
    moves = set.map(() => 0);
    // On the first sweep a member that finds nothing — no root, or nothing that evaluates — was
    // searched with members it reads still at the middle of their ranges. It is put back at the
    // end of that sweep's order and searched again once others have landed, and again after that
    // while something new has landed since it was last put back. Each putting back needs a new
    // landing, and a sweep has only so many, so this ends. Only a budget that ran out, which
    // nothing the others do can change, is never put back.
    const order = set.map((_, i) => i);
    /** For each member put back, how many members had landed when it was. */
    const deferredAt = new Map<number, number>();
    let landed = 0;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const u = set[i];
      const found = search(
        ctx,
        u,
        set.filter((o) => o !== u),
      );
      const prev = deferredAt.get(i);
      if (
        !found.ok &&
        sweep === 0 &&
        !found.final &&
        k < order.length - 1 &&
        (prev === undefined || landed > prev)
      ) {
        deferredAt.set(i, landed);
        order.push(i);
        continue;
      }
      if (!found.ok)
        return {
          ok: false,
          res: found.res,
          message: `solved params ${nameList(set)} did not settle: ${found.message}`,
        };
      moves[i] = Math.abs(found.x - ctx.at[u.p.name]);
      ctx.at[u.p.name] = found.x;
      slope[u.p.name] = found.slope;
      res = found.res;
      landed++;
    }
    // `res` is the last member's accepted probe, evaluated with every other member at the value
    // it landed on in this sweep.
    if (set.every((u) => holdsAt(u, res as SheetResult, slope)))
      return { ok: true, res: res as SheetResult };
  }
  // The largest move relative to the member's own range, quoted in its own unit.
  const share = (i: number): number => moves[i] / (set[i].hi - set[i].lo);
  let worst = 0;
  for (let i = 1; i < set.length; i++) if (share(i) > share(worst)) worst = i;
  return {
    ok: false,
    res: res as SheetResult,
    message:
      `solved params ${nameList(set)} did not settle in ${SOLVE_SWEEPS} sweeps: in the last ` +
      `one ${set[worst].p.name} still moved by ${valueOf(set[worst], moves[worst])} — they ` +
      `depend on each other too strongly for repeated one-unknown searches to settle them in ` +
      `their stated ranges`,
  };
}

/**
 * Resolve one node's solved params — every param carrying a `designConstraint` (a `hold` becomes
 * one where the hardware is held) or a `solveFor`. Each has a relation that must read zero and a
 * range the author states, and each is found by a one-unknown search in that range (search).
 *
 * The node's solved params are grouped by solvePlan into sets that depend on each other, in the
 * order their relations read each other. A set of one is one search, with every earlier set held
 * at the values it landed on; a set of several is settled by a fixed number of sweeps (settle).
 * A child's solved params are no unknowns of this node: the child solves them inside every probe
 * of this one, which is exact.
 *
 * The values a search starts from never come from the document: before anything is searched,
 * every solved param is placed at the middle of its stated range. So no stored value reaches any
 * evaluation of the solve, and the answer is the same whatever the panel was showing — the
 * stored value is a display default and nothing more.
 *
 * Outcome 1 — settled — is reported only after VERIFICATION: every solved param's relation, read
 * from the evaluation that is returned, within its tolerance — each param within SOLVE_TOL_REL of
 * the span of its root, by the slope its search read. That evaluation is the last accepted probe of
 * the last set, which was evaluated with every solved param at its final value, so no extra
 * evaluation is needed to read it; a relation a missed dependency left behind would show here.
 */
function solveNode(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  depth: number,
  budget: SolveBudget,
): SheetResult {
  // One home for the structural checks (validateSheet raises the same words as errors); checked
  // BEFORE filtering by the engineSolved() shape guard, because the guard rejects a half-written
  // constraint — which would otherwise sail past as "nothing to solve" and freeze the param.
  const problem = constraintProblem(doc.params);
  if (problem) return solveFailed(evaluateOnce(doc, table, resolveDevice, depth, budget), problem);
  const unknowns = doc.params.filter(engineSolved).map(unknownOf);
  if (unknowns.length === 0) return evaluateOnce(doc, table, resolveDevice, depth, budget);

  const at: Record<string, number> = {};
  for (const u of unknowns) at[u.p.name] = (u.lo + u.hi) / 2;
  const ctx: SolveContext = { doc, table, resolveDevice, depth, budget, at };
  const byName = new Map(unknowns.map((u) => [u.p.name, u]));
  const plan = unknowns.length === 1 ? [[unknowns[0].p.name]] : solvePlan(doc);
  const slope: Record<string, number> = {};
  let last: SheetResult | undefined;
  for (const names of plan) {
    const set = names.map((n) => byName.get(n) as Unknown);
    let outcome: Outcome;
    if (set.length === 1) {
      const found = search(ctx, set[0], []);
      if (found.ok) {
        at[set[0].p.name] = found.x;
        slope[set[0].p.name] = found.slope;
      }
      outcome = found;
    } else outcome = settle(ctx, set, slope);
    if (!outcome.ok) return solveFailed(outcome.res, outcome.message);
    last = outcome.res;
  }

  const final = last as SheetResult;
  const off = unknowns
    .filter((u) => !holdsAt(u, final, slope))
    .map((u) => ({ u, g: relationAt(u, final), tol: tolOf(u, slope) }));
  if (off.length)
    return solveFailed(
      final,
      `${off.length > 1 ? 'solved params' : off[0].u.held ? 'held param' : 'solved param'} ` +
        `${nameList(off.map((o) => o.u))} did not settle: read from the final evaluation, ` +
        off
          .map(
            ({ u, g, tol }) =>
              `${u.lhs} - (${u.rhs}) ${g === undefined ? 'does not evaluate' : `reads ${g.toExponential(3)}`}` +
              ` against a tolerance of ${tol.toExponential(3)} (its slope there times ` +
              `${SOLVE_TOL_REL} of its range)`,
          )
          .join('; ') +
        ` — the values it was solved with moved after it landed`,
    );
  return final;
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
 * landed on — a failed solve leaves its last probe in the result with every
 * sizing reading `ok`, so "the devices sized" is nowhere near enough to have produced an instance.
 * Check FAILURES do not gate: a center that misses its spec is still a design, and whether it holds
 * across its claimed range is still a real question.
 */
function evaluateWithRange(
  doc: SheetDoc,
  table: DeviceTable | undefined,
  resolveDevice: DeviceResolver | undefined,
  opts: EvaluateOptions,
): SheetResult {
  const base = evaluateNode(doc, table, resolveDevice, 0, opts);
  const rangeEnds = doc.operatingRange ?? [];
  if (!stands(base)) {
    const reports = rangeEnds.map((e): RangeEndReport => ({
      name: e.name,
      state: 'not-run',
      // No `set`: the overrides resolve against the base VALUES, which here are wherever the
      // failed solve stopped. Reporting the point that would have been asked about from those
      // is reporting a phantom, the same reason a failed solve's probe is never reported as a
      // landing.
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
    const nodes = unwalkedReport(doc);
    const reports = rangeEnds.map((e): RangeEndReport => ({
      name: e.name,
      state: 'no-answer',
      set: {},
      checks: [],
      solved: {},
      warnings: [],
      error,
      ...(nodes ? { nodes } : {}),
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
  let solveErr: string | undefined;
  let lastError: string | undefined;
  for (let i = res.warnings.length - 1; i >= 0 && solveErr === undefined; i--) {
    const w = res.warnings[i];
    if (w.severity !== 'error') continue;
    lastError ??= w.message;
    if (w.rule === 'sheet-solve') solveErr = w.message;
  }
  const err = solveErr ?? lastError;

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
  // A solve that found no solution in its range, or did not settle, is no answer. Its message may
  // quote the device failure that bounded the search (the relation not evaluating past some
  // point), and that quote is the reason for the range searched, not this point's verdict.
  if (solveErr !== undefined) return { state: 'no-answer', error: solveErr };
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

/**
 * One run as a point of the compliance question (see PointOutcome), classified once: the wiring
 * walk's gate reads `sized`, and a range end and a process condition read the answer. A held
 * design (`held`) is read as heldOutcome reads it: sized where it raised no error and read no
 * device off its table. A design sized here is sized where it stands (see stands), and answers for
 * itself: it complies where it is feasible. A design resting on an assumed level (`assumed`) is
 * still sized, and gives no answer.
 */
export function pointOutcome(
  res: SheetResult,
  held: boolean,
  assumed: readonly string[] = [],
): PointOutcome {
  let sized: boolean;
  let answer: Omit<PointOutcome, 'sized'>;
  if (held) {
    answer = heldOutcome(res);
    sized = answer.error === undefined;
  } else {
    sized = stands(res);
    answer = sized
      ? { state: res.feasible ? 'complies' : 'does-not-comply' }
      : {
          state: 'no-answer',
          error:
            res.warnings.find((w) => w.severity === 'error')?.message ??
            'the evaluation did not complete',
        };
  }
  if (assumed.length) answer = { state: 'no-answer', error: assumedLevelRefusal(assumed) };
  return { sized, ...answer };
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
 *    "nothing in the range reaches it". */
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
  const unwalked = unwalkedReport(held.doc);
  const unanswered = (error: string): RangeEndReport => ({
    name: rangeEnd.name,
    state: 'no-answer',
    set: over,
    checks: [],
    solved: {},
    warnings: [],
    error,
    ...(unwalked ? { nodes: unwalked } : {}),
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
  const res = evaluateNode(withParams(held.doc, over), table, resolveDevice, 0, { held: true });
  const { state, error: err } = res.point as PointOutcome;
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
    ...(res.nodes ? { nodes: res.nodes } : {}),
    ...assumed,
  };
}
