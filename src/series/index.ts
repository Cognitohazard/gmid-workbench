// Family-of-curves preparation for charting. Hold one axis as X, sweep another
// axis as the "family", and evaluate an expression along X for each family
// value — yielding one Y curve per family member, all aligned to the shared X
// lattice. Pure, deterministic, zero DOM imports. Reuses sliceGrid (fix the
// family + any other axes) + deriveColumn (evaluate the expression).

import type { DeviceTable, Grid } from '../types';
import { sliceGrid, orient, interp1 } from '../grid';
import type { Oriented } from '../grid';
import { compileExpr, evalColumn, metaScalars } from '../derive';
import { BASE_QUANTITIES, DERIVED_QUANTITIES } from '../namespace';

// Free identifiers of each standard derived definition, compiled once.
const DERIVED_NAMES = DERIVED_QUANTITIES.map((q) => ({
  key: q.key,
  names: compileExpr(q.expr).names,
}));

/**
 * Collapse the named axes of a table — fixing each at a coordinate (interpolated
 * by sliceGrid, clamped at the edges) — into a lower-dimensional table, keeping
 * identity and metadata. Lets a consumer reduce an N-D table to the shape a tool
 * needs (e.g. an [l × vgs] table for sizeDevice) without hand-rebuilding the type.
 */
export function fixTable(table: DeviceTable, fixed: Record<string, number>): DeviceTable {
  return { ...table, grid: sliceGrid(table.grid, fixed) };
}

export interface FamilyCurves {
  readonly xName: string;
  readonly x: Float64Array; // shared X lattice (the X axis nodes)
  readonly famName: string; // '' when there is no family (a single curve)
  readonly famValues: Float64Array; // one per curve; empty when famName is ''
  readonly lines: Float64Array[]; // lines[k] = expr along x at famValues[k]
}

/**
 * Build one Y curve per value of the `famName` axis: fix that axis, fix every
 * other non-X axis at the coordinate given in `fixed` (or its first node when
 * absent), slice to a 1-D grid over `xName`, and evaluate `expr` over the slice.
 * Every curve aligns to the shared X lattice.
 *
 * Pass `famName = null` for a SINGLE curve over X (every other axis fixed) — e.g.
 * a table whose only sweep axis is X. The result then has `famName: ''`, empty
 * `famValues`, and one line.
 *
 * `expr` is any expression over the base namespace + constants (e.g. "gm/id",
 * "gm*gds", "2*id/gm"). `fixed` carries the coordinate for each extra axis (vds,
 * vsb, …) — a slider value; coordinates between nodes are interpolated by
 * sliceGrid. Throws on a missing axis or an invalid expression. Non-finite
 * expression points pass through as NaN — the consumer decides how to render gaps.
 */
export function familyCurves(
  table: DeviceTable,
  expr: string,
  xName = 'vgs',
  famName: string | null = 'l',
  fixed: Record<string, number> = {},
): FamilyCurves {
  const grid = table.grid;
  const xAxis = grid.axes.find((a) => a.name === xName);
  if (!xAxis) throw new Error(`familyCurves: table has no "${xName}" axis`);
  const compiled = compileExpr(expr); // parse once; reused across every curve

  // Coordinates for every axis except X and `keep` (the family), interpolated.
  const fixOthers = (at: Record<string, number>, keep: string): void => {
    for (const a of grid.axes) {
      if (a.name !== xName && a.name !== keep) at[a.name] = fixed[a.name] ?? a.values[0];
    }
  };

  if (famName === null) {
    const at: Record<string, number> = {};
    fixOthers(at, xName); // fix everything but X (the would-be family included)
    const line = evalColumn(sliceGrid(grid, at), compiled);
    return { xName, x: xAxis.values, famName: '', famValues: new Float64Array(0), lines: [line] };
  }

  if (xName === famName) {
    throw new Error(`familyCurves: xName and famName must differ (both "${xName}")`);
  }
  const famAxis = grid.axes.find((a) => a.name === famName);
  if (!famAxis) throw new Error(`familyCurves: table has no "${famName}" axis`);

  const lines: Float64Array[] = [];
  for (const fv of famAxis.values) {
    const at: Record<string, number> = { [famName]: fv };
    fixOthers(at, famName);
    lines.push(evalColumn(sliceGrid(grid, at), compiled));
  }

  return { xName, x: xAxis.values, famName, famValues: famAxis.values, lines };
}

export interface FamilyCurvesXY {
  readonly xExpr: string;
  readonly xLabel: string; // display label for the X axis (currently the expression)
  readonly sweepName: string; // the bias axis traversed to parameterize each curve
  readonly x: Float64Array; // common, monotonic-ascending lattice shared by all curves
  readonly famName: string; // '' when there is no family (a single curve)
  readonly famValues: Float64Array; // one per curve; empty when famName is ''
  readonly lines: Float64Array[]; // lines[k] = yExpr resampled onto x; NaN outside curve k's native X range
  readonly degenerate: boolean; // true when X barely varies (or is non-monotonic) along the sweep
  readonly reason: string; // human-readable cause when degenerate, else ''
  readonly warning: string; // non-fatal note (X nearly constant ⇒ curves pile up), else ''
}

// X must vary by more than this (relative) over the sweep to be a usable axis.
const DEGEN_TOL = 1e-6;
// Below this relative span X still draws, but it's so narrow the curves pile up — warn.
const NEAR_TOL = 0.02;

/**
 * Like familyCurves, but X is an arbitrary EXPRESSION (e.g. "gm/id") evaluated
 * along a swept bias axis (`sweepName`, default "vgs"), not a raw axis. Each family
 * curve is the parametric locus (xExpr, yExpr) as the sweep advances; because the X
 * values differ per curve, every curve is resampled onto one shared ascending
 * lattice so the result can drive an aligned-data chart (uPlot wants a single X).
 *
 * This is the defining gm/ID view: X is the efficiency coordinate (gm/ID), Y a
 * figure of merit (ID/W, fT, gm/gds, …), one curve per L. Reuses the same
 * expression resolution as Y (compileExpr/evalColumn over the slice namespace, plus
 * device-metadata scalars so `id/w` resolves) and the same axis-fixing as
 * familyCurves: `fixed` pins every axis that is neither the sweep nor the family.
 *
 * Degeneracy: if X is ~constant along the sweep (e.g. gm/ID against a vds sweep —
 * gm/ID is vds-independent, the CLM factor cancels) or non-monotonic, the curves
 * collapse and a shared X lattice is meaningless. Rather than draw a smear, the
 * result is flagged `degenerate` with a `reason`; the caller shows the message and
 * keeps its last good chart. Genuine compile/axis errors still throw, as before.
 */
export function familyCurvesXY(
  table: DeviceTable,
  xExpr: string,
  yExpr: string,
  sweepName = 'vgs',
  famName: string | null = 'l',
  fixed: Record<string, number> = {},
  lattice = 0,
): FamilyCurvesXY {
  const grid = table.grid;
  const sweepAxis = grid.axes.find((a) => a.name === sweepName);
  if (!sweepAxis) throw new Error(`familyCurvesXY: table has no "${sweepName}" sweep axis`);
  if (famName !== null && famName === sweepName) {
    throw new Error(`familyCurvesXY: sweep and family must differ (both "${sweepName}")`);
  }
  const scalars = metaScalars(table.meta);
  const cx = compileExpr(xExpr);
  const cy = compileExpr(yExpr);

  // Fix every axis except the sweep and `keep` (the family) at `fixed`/first node.
  const fixOthers = (at: Record<string, number>, keep: string): void => {
    for (const a of grid.axes) {
      if (a.name !== sweepName && a.name !== keep) at[a.name] = fixed[a.name] ?? a.values[0];
    }
  };
  // Evaluate (xExpr, yExpr) along the sweep for one fixed bias point.
  const curveAt = (at: Record<string, number>): Oriented =>
    orient(evalColumn(sliceGrid(grid, at), cx, scalars), evalColumn(sliceGrid(grid, at), cy, scalars));

  let famValues: Float64Array;
  const curves: Oriented[] = [];
  if (famName === null) {
    const at: Record<string, number> = {};
    fixOthers(at, sweepName); // every non-sweep axis fixed (no family held out)
    curves.push(curveAt(at));
    famValues = new Float64Array(0);
  } else {
    const famAxis = grid.axes.find((a) => a.name === famName);
    if (!famAxis) throw new Error(`familyCurvesXY: table has no "${famName}" family axis`);
    for (const fv of famAxis.values) {
      const at: Record<string, number> = { [famName]: fv };
      fixOthers(at, famName);
      curves.push(curveAt(at));
    }
    famValues = famAxis.values;
  }

  // Degeneracy: any curve whose X is non-monotonic or spans ~nothing (relative).
  let degenerate = false;
  let reason = '';
  for (const c of curves) {
    const span = c.xmax - c.xmin;
    if (!(span > DEGEN_TOL * (Math.abs(c.xmax) + Math.abs(c.xmin) + Number.EPSILON))) {
      degenerate = true;
      reason = `X (${xExpr}) is ~constant along the ${sweepName} sweep (range ${span.toExponential(2)})`;
      break;
    }
    if (!c.mono) {
      degenerate = true;
      reason = `X (${xExpr}) is not monotonic along the ${sweepName} sweep`;
      break;
    }
  }

  // Common ascending lattice spanning the union of every curve's native X range.
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of curves) {
    if (c.xmin < lo) lo = c.xmin;
    if (c.xmax > hi) hi = c.xmax;
  }
  const M = lattice > 0 ? lattice : sweepAxis.values.length;
  const span = hi - lo;
  const x = new Float64Array(M);
  for (let j = 0; j < M; j++) x[j] = M > 1 && span > 0 ? lo + (j * span) / (M - 1) : lo;

  // Non-fatal hint: X varies, but so little that the curves squash into a sliver (e.g.
  // gm/ID against an L sweep — gm/ID barely depends on length at a fixed bias).
  const relSpan = span / (Math.abs(hi) + Math.abs(lo) + Number.EPSILON);
  const warning =
    !degenerate && relSpan < NEAR_TOL
      ? `X (${xExpr}) varies only ${(relSpan * 100).toPrecision(2)}% along the ${sweepName} sweep — nearly constant, so curves pile up. Sweep an axis X varies with (e.g. vgs).`
      : '';

  const lines = curves.map((c) => {
    const line = new Float64Array(M);
    for (let j = 0; j < M; j++) line[j] = interp1(c.nx, c.ny, x[j]);
    return line;
  });

  return {
    xExpr,
    xLabel: xExpr,
    sweepName,
    x,
    famName: famName ?? '',
    famValues,
    lines,
    degenerate,
    reason,
    warning,
  };
}

/** One drawn line's provenance: which input table it came from and its family value. */
export interface OverlayLine {
  readonly tableIndex: number; // index into the `tables` passed to overlayCurvesXY
  readonly famValue: number; // the curve's family value; NaN when that table has no family
}

/**
 * Several devices' family-of-curves, cross-plotted on ONE shared X lattice so they can
 * overlay on a single chart (NMOS vs PMOS, or one device across process corners). Each
 * input table is resolved independently with `familyCurvesXY`, then every curve is
 * resampled onto the union lattice; `meta[k]` tags `lines[k]` with its source table and
 * family value so the UI can colour by family value and dash by device.
 */
export interface OverlayCurvesXY {
  readonly xExpr: string;
  readonly xLabel: string;
  readonly sweepName: string;
  readonly x: Float64Array; // union lattice, monotonic-ascending, spanning every table's range
  readonly famName: string; // '' when no surviving table fans a family
  readonly famValues: Float64Array; // sorted-unique UNION of all tables' family values (shared colour scale)
  readonly lines: Float64Array[]; // table-major; each resampled onto x, NaN outside its native range
  readonly meta: OverlayLine[]; // parallel to lines
  readonly warning: string; // first surviving table's near-constant hint, else ''
  readonly notes: (string | null)[]; // per-INPUT-table reason (throw / degenerate), else null
}

/**
 * Overlay `tables` on one X lattice. A single table is the fast path: it returns
 * `familyCurvesXY`'s own `x`/`lines` unchanged (no second resample) so the lone-device
 * result is identical to plotting it directly. With several tables, each is resolved
 * independently and a failing or degenerate one is isolated to `notes[t]` (its curves are
 * dropped) instead of breaking the whole panel; the survivors share a union lattice.
 *
 * A table lacking the requested `family` axis contributes a single curve (famValue NaN)
 * rather than erroring, so a device without that axis still overlays. Family values are
 * unioned across tables, so an identical L in two devices maps to the same colour.
 */
export function overlayCurvesXY(
  tables: readonly DeviceTable[],
  xExpr: string,
  yExpr: string,
  sweepName = 'vgs',
  family: string | null = 'l',
  fixed: Record<string, number> = {},
  lattice = 0,
): OverlayCurvesXY {
  // Fast path: one table ⇒ familyCurvesXY verbatim (its x/lines by reference, no re-resample).
  if (tables.length === 1) {
    const fc = familyCurvesXY(tables[0], xExpr, yExpr, sweepName, family, fixed, lattice);
    if (fc.degenerate) {
      return empty(xExpr, fc.xLabel, sweepName, fc.famName, [fc.reason]);
    }
    const meta: OverlayLine[] =
      fc.famName === ''
        ? [{ tableIndex: 0, famValue: NaN }]
        : Array.from(fc.famValues, (v) => ({ tableIndex: 0, famValue: v }));
    return {
      xExpr,
      xLabel: fc.xLabel,
      sweepName,
      x: fc.x,
      famName: fc.famName,
      famValues: fc.famValues,
      lines: fc.lines,
      meta,
      warning: fc.warning,
      notes: [null],
    };
  }

  // Resolve each table independently; isolate per-table failures into notes[t].
  const notes: (string | null)[] = [];
  const survivors: { idx: number; fc: FamilyCurvesXY }[] = [];
  for (let t = 0; t < tables.length; t++) {
    const tbl = tables[t];
    // A table without the requested family axis draws as a single curve, not an error.
    const famForTable = family !== null && tbl.grid.axes.some((a) => a.name === family) ? family : null;
    try {
      const fc = familyCurvesXY(tbl, xExpr, yExpr, sweepName, famForTable, fixed, lattice);
      if (fc.degenerate) notes.push(fc.reason);
      else {
        notes.push(null);
        survivors.push({ idx: t, fc });
      }
    } catch (e) {
      notes.push((e as Error).message);
    }
  }

  const xLabel = survivors[0]?.fc.xLabel ?? xExpr;
  const famName = survivors.find((s) => s.fc.famName !== '')?.fc.famName ?? '';
  const warning = survivors[0]?.fc.warning ?? '';
  if (survivors.length === 0) return empty(xExpr, xLabel, sweepName, famName, notes);

  // Union lattice spanning every survivor's range; M = the densest survivor (never downsample).
  let lo = Infinity;
  let hi = -Infinity;
  let M = 0;
  for (const { fc } of survivors) {
    if (fc.x.length === 0) continue;
    if (fc.x[0] < lo) lo = fc.x[0];
    if (fc.x[fc.x.length - 1] > hi) hi = fc.x[fc.x.length - 1];
    if (fc.x.length > M) M = fc.x.length;
  }
  if (lattice > 0) M = lattice;
  if (M === 0) return empty(xExpr, xLabel, sweepName, famName, notes);

  const span = hi - lo;
  const x = new Float64Array(M);
  for (let j = 0; j < M; j++) x[j] = M > 1 && span > 0 ? lo + (j * span) / (M - 1) : lo;

  // double-resample (familyCurvesXY's own lattice → union x) — second-order error on
  // already-piecewise-linear curves, fine for an overlay; resample from native orient() if exactness ever matters.
  const lines: Float64Array[] = [];
  const meta: OverlayLine[] = [];
  const famSet = new Set<number>();
  for (const { idx, fc } of survivors) {
    for (let i = 0; i < fc.lines.length; i++) {
      const o = orient(fc.x, fc.lines[i]); // drop the NaN gaps, ascending — same prep interp1 expects
      const line = new Float64Array(M);
      for (let j = 0; j < M; j++) line[j] = interp1(o.nx, o.ny, x[j]);
      lines.push(line);
      const fv = fc.famName === '' ? NaN : fc.famValues[i];
      meta.push({ tableIndex: idx, famValue: fv });
      if (Number.isFinite(fv)) famSet.add(fv);
    }
  }
  const famValues = Float64Array.from([...famSet].sort((a, b) => a - b));
  return { xExpr, xLabel, sweepName, x, famName, famValues, lines, meta, warning, notes };
}

// An overlay with nothing drawable: empty curves, but the per-table notes still surface.
function empty(
  xExpr: string,
  xLabel: string,
  sweepName: string,
  famName: string,
  notes: (string | null)[],
): OverlayCurvesXY {
  return {
    xExpr,
    xLabel,
    sweepName,
    x: new Float64Array(0),
    famName,
    famValues: new Float64Array(0),
    lines: [],
    meta: [],
    warning: '',
    notes,
  };
}

/**
 * Count the DISTINCT family-axis values across `tables` — the size of the union an overlay
 * would fan into. Reads axis values only (no curve building), so a caller can decide cheaply
 * whether an overlay's family is too dense to draw before paying for overlayCurvesXY.
 */
export function familyUnionCount(tables: readonly DeviceTable[], family: string): number {
  if (!family) return 0;
  const set = new Set<number>();
  for (const t of tables) {
    const ax = t.grid.axes.find((a) => a.name === family);
    if (ax) for (const v of ax.values) set.add(v);
  }
  return set.size;
}

/**
 * Inverse of an X expression along the sweep: the sweep coordinate (e.g. vgs) at which
 * `xExpr` equals `xValue`, on the curve fixed by `fixed` (family value + pinned bias).
 * Recovers the bias behind a gm/ID-axis cursor so the full operating point can be looked
 * up. Non-sweep axes absent from `fixed` pin at their first node (as familyCurvesXY does).
 * Returns null if the sweep axis is missing or `xValue` is outside the curve's range.
 */
export function invertX(
  table: DeviceTable,
  xExpr: string,
  xValue: number,
  sweepName = 'vgs',
  fixed: Record<string, number> = {},
): number | null {
  const grid = table.grid;
  const sweepAxis = grid.axes.find((a) => a.name === sweepName);
  if (!sweepAxis) return null;
  const at: Record<string, number> = {};
  for (const a of grid.axes) {
    if (a.name !== sweepName) at[a.name] = fixed[a.name] ?? a.values[0];
  }
  const slice = sliceGrid(grid, at);
  const sweepVals = slice.axes.find((a) => a.name === sweepName)?.values ?? sweepAxis.values;
  const xs = evalColumn(slice, compileExpr(xExpr), metaScalars(table.meta));
  const o = orient(xs, sweepVals); // ascending by X; ny = matching sweep coordinate
  const v = interp1(o.nx, o.ny, xValue);
  return Number.isFinite(v) ? v : null;
}

/**
 * Choose which indices of a sorted-ascending family axis to keep when it has too many
 * values to draw legibly. Always keeps the value nearest each `include` entry, then fills
 * the remainder evenly across the range (endpoints first) up to `count` total. Deduped,
 * returned ascending. `count >= length` keeps all; explicit includes are honored even if
 * they exceed `count`. Pure index math — the caller slices the curves/labels/colors.
 */
export function subsample(famValues: Float64Array, count: number, include: number[] = []): number[] {
  const len = famValues.length;
  if (len === 0) return [];
  const n = Math.max(1, Math.min(Math.floor(count), len));
  if (n >= len) return Array.from({ length: len }, (_, i) => i);

  // Nearest index to a target value (famValues ascending), clamped to the range.
  const nearest = (t: number): number => {
    let lo = 0;
    let hi = len - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (famValues[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && t - famValues[lo - 1] <= famValues[lo] - t ? lo - 1 : lo;
  };

  const forced = new Set<number>();
  for (const t of include) if (Number.isFinite(t)) forced.add(nearest(t));
  const out = new Set<number>(forced);
  const denom = Math.max(1, n - 1); // n === 1 ⇒ a single point at index 0, not a div-by-zero NaN
  for (let k = 0; k < n && out.size < n; k++) out.add(Math.round((k * (len - 1)) / denom));
  return Array.from(out).sort((a, b) => a - b).slice(0, Math.max(n, forced.size));
}

/**
 * The canonical quantities a familyCurves chart over `xName` can plot as Y: every
 * name a per-curve slice can resolve. The slice collapses the family axis and
 * every other non-X axis, so the resolvable namespace is the X axis + the present
 * non-axis columns — axis quantities other than X (l, vds, …) are NOT plottable
 * here. Constants (pi, k, gamma, …) are deliberately NOT counted as plottable: a
 * derived's free names already exclude constants, so a constant only ever leaks in
 * as a flat base "quantity" (e.g. a `gamma` constant masquerading as device data).
 * Returns the present base keys and the standard derived keys expressible from
 * them, for building a Y (or X) picker honestly per table. `scalarNames` are
 * metadata scalars (e.g. width `w`, see metaScalars) that enable derived quantities
 * referencing them (id/w) WITHOUT being offered as flat base lines — a scalar is
 * not device data.
 */
export function plottableQuantities(
  grid: Grid,
  xName = 'vgs',
  scalarNames: string[] = [],
): { base: string[]; derived: string[] } {
  const axisNames = new Set(grid.axes.map((a) => a.name));
  const columns = new Set<string>([
    xName,
    ...[...grid.quantities.keys()].filter((k) => !axisNames.has(k)),
  ]);
  const resolvable = new Set<string>([...columns, ...scalarNames]);
  const base = BASE_QUANTITIES.filter((q) => columns.has(q.key)).map((q) => q.key);
  const derived = DERIVED_NAMES.filter((d) => d.names.every((n) => resolvable.has(n))).map(
    (d) => d.key,
  );
  return { base, derived };
}
