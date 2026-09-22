// Forward + inverse operating-point lookup. Interpolates a device table's base
// grid at a point in axis-space, then evaluates derived quantities from the
// interpolated base scalars (dogfooding the expression engine). The inverse path
// recovers vgs from a target value of any stored or derived quantity (gm/ID, fT,
// intrinsic gain, …) along a fixed-L slice. Pure, deterministic, zero DOM imports.

import { type Axis, type DeviceTable, type Grid, LookupError, LookupRangeError } from '../types';
import { BASE_KEYS } from '../namespace';
import { CONSTANTS } from '../constants';
import { interpolate, sliceGrid, orient, interp1 } from '../grid';
import { scalarScope } from '../expr';
import { DERIVED_COMPILED, metaScalars, evalColumn } from '../derive';

// The Map is authoritative (shared with derive); a module-level entries array keeps
// the per-lookup default-keys walk allocation-free.
const DERIVED_ENTRIES = [...DERIVED_COMPILED];

/** Base quantity keys actually stored as columns in this grid (axes included). */
function baseKeysPresent(grid: Grid): string[] {
  const out: string[] = [];
  for (const key of grid.quantities.keys()) {
    if (BASE_KEYS.has(key)) out.push(key);
  }
  return out;
}

/**
 * The first free name of a derived definition that `has` cannot resolve, or undefined when
 * the whole definition is computable. One home for "can this table compute that quantity",
 * shared by the forward path (which uses it to filter the default key set) and the inverse
 * path (which uses the name to say WHICH column is missing). Constants always resolve.
 */
function missingInput(
  names: readonly string[],
  has: (name: string) => boolean,
): string | undefined {
  for (const n of names) {
    if (has(n)) continue;
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, n)) continue;
    return n;
  }
  return undefined;
}

/**
 * Forward lookup: multilinearly interpolate the base grid at `point` (axis-space),
 * then evaluate any requested derived quantity from the interpolated base scalars.
 *
 * When `keys` is omitted the result holds every present base column plus every
 * standard derived quantity whose definition is computable from those bases.
 * Requested derived keys are evaluated from the interpolated scalars (NOT
 * re-interpolated), so vstar = 2/(gm/id) etc. stay self-consistent at the point.
 */
export function lookup(
  table: DeviceTable,
  point: Record<string, number>,
  keys?: string[],
): Record<string, number> {
  const grid = table.grid;

  // Interpolate the full set of present base quantity columns once (one corner walk).
  const basePresent = baseKeysPresent(grid);
  const baseScalars = interpolate(grid, point, basePresent);

  // Device-metadata scalars — the same scope derive/tableScope uses: T/UT overrides
  // (so the γ-model noise evaluates at this table's characterization temperature; the
  // scope shadows the engine's 27 °C defaults) and the width `w` (so width-relative
  // deriveds like id_w are computable on tables that carry W as metadata). Assign only
  // if absent: an interpolated stored column of the same name keeps winning, matching
  // tableScope's stored-before-scalars precedence.
  const metaVals = metaScalars(table.meta);
  for (const k of Object.keys(metaVals)) {
    if (!Object.prototype.hasOwnProperty.call(baseScalars, k)) baseScalars[k] = metaVals[k];
  }

  // Always expose the axis coordinates at the point, even when a grid does not
  // materialize axis columns (e.g. the demo grid). The coordinate is the requested
  // value clamped to the axis range, matching the grid's clamp-at-edge convention.
  const axisKeys: string[] = [];
  for (const axis of grid.axes) {
    const vals = axis.values;
    const raw = point[axis.name];
    const x = raw === undefined ? vals[0] : raw;
    const clamped = x < vals[0] ? vals[0] : x > vals[vals.length - 1] ? vals[vals.length - 1] : x;
    if (!Object.prototype.hasOwnProperty.call(baseScalars, axis.name)) {
      baseScalars[axis.name] = clamped;
      axisKeys.push(axis.name);
    }
  }

  const requested = keys ?? [
    ...basePresent,
    ...axisKeys,
    ...DERIVED_ENTRIES.filter(
      ([, compiled]) =>
        missingInput(compiled.names, (n) =>
          Object.prototype.hasOwnProperty.call(baseScalars, n),
        ) === undefined,
    ).map(([key]) => key),
  ];

  const scope = scalarScope(baseScalars);
  const out: Record<string, number> = {};

  for (const key of requested) {
    if (Object.prototype.hasOwnProperty.call(baseScalars, key)) {
      out[key] = baseScalars[key];
      continue;
    }
    const def = DERIVED_COMPILED.get(key);
    if (!def) {
      throw new Error(
        `lookup: "${key}" is neither a present base column nor a known derived quantity`,
      );
    }
    const v = def.eval(scope);
    if (v instanceof Float64Array) {
      // Derived definitions over scalar bases yield scalars; guard defensively.
      throw new Error(`lookup: derived "${key}" did not reduce to a scalar`);
    }
    out[key] = v;
  }

  return out;
}

/**
 * Inverse lookup by ANY quantity along the fixed-length-`L` slice: build that
 * quantity's curve over vgs from the slice, bracket `target`, linearly interpolate to
 * recover vgs, then forward-lookup at {l: L, vgs}.
 *
 * `key` may be a stored column (gm, id, …) or a standard derived quantity (gm_id, ft,
 * gm_gds, vstar, …) — the latter always evaluated from its single namespace definition.
 * Note that an expression SCOPE resolves a same-named stored column first, so a table that
 * ships its own `ft` column plots one curve and inverts another; qa/validate flags that
 * collision by name rather than either side silently winning.
 *
 * Fails closed: throws if the table cannot compute `key` at all, if the slice carries
 * no invertible data (e.g. every id==0), if the curve is non-monotonic in vgs (an
 * ambiguous fold), or if `target` lies outside the slice's [min, max] range.
 */
export function lookupByQuantity(
  table: DeviceTable,
  key: string,
  target: number,
  L: number,
  keys?: string[],
): Record<string, number> {
  return lookup(table, { l: L, vgs: invertOnSlice(table, L, key, target) }, keys);
}

/** Inverse lookup by gm/ID — the canonical design axis, and the most common call. */
export function lookupByGmId(
  table: DeviceTable,
  gmId: number,
  L: number,
  keys?: string[],
): Record<string, number> {
  return lookupByQuantity(table, 'gm_id', gmId, L, keys);
}

/**
 * The `key` curve over a slice.
 *
 * A key with a namespace definition is EVALUATED from that definition — it is never read
 * from a same-named stored column, even though unknown import columns do pass through under
 * such names. The forward half of sizing surfaces only base columns and re-derives the rest
 * (see `lookup` and sizeDevice's re-evaluation at the sized width), so inverting a stored
 * `ft` or `gm_id` column would place the operating point on a curve nothing downstream
 * agrees with: the sizer would silently return a device whose reported fT is not the fT it
 * was asked for. Stored columns serve the base keys (gm, id) that have no definition.
 *
 * Fails closed naming the missing input when this table cannot compute `key` at all —
 * "size by fT" on a table with no cgg column is a data limit, not a bad bind, and must
 * say so rather than surface as an out-of-range or non-monotonic complaint.
 */
function sliceColumn(table: DeviceTable, slice: Grid, key: string): Float64Array {
  const def = DERIVED_COMPILED.get(key);
  if (!def) {
    const stored = slice.quantities.get(key);
    if (stored) return stored;
    throw new Error(
      `inverse lookup: "${key}" is neither a present base column nor a known derived quantity`,
    );
  }
  const scalars = metaScalars(table.meta);
  const missing = missingInput(
    def.names,
    (n) => slice.quantities.has(n) || Object.prototype.hasOwnProperty.call(scalars, n),
  );
  if (missing !== undefined) {
    throw new Error(
      `inverse lookup: cannot invert "${key}" on this table — it carries no "${missing}" column`,
    );
  }
  return evalColumn(slice, def, scalars);
}

/**
 * The shape a table must have before an operating point can be placed on it: an `l` axis
 * to collapse, a `vgs` axis to place the point on, and every other axis degenerate. With
 * a vds or vsb still live the interpolation would silently take that axis's first node
 * instead of saying the operating point was never pinned.
 *
 * Checked on the UNSLICED grid, which is equivalent to checking the slice — `sliceGrid`
 * carries the remaining axes' `values` by reference, so they are the same arrays — and
 * lets a caller fail before paying for a slice it cannot use. Returns the vgs axis,
 * which every caller needs next.
 *
 * Both halves of sizing share this: the inverse path here, and the forward read at a
 * bound vgs in `sizeDevice`. They differ in what they do at the hull, not in what shape
 * they require, so stating the rule twice would only let the two drift.
 *
 * `context` completes "cannot <context> with extra non-degenerate axis". The substring
 * `non-degenerate axis` is load-bearing: sheet evaluation keys an author-facing hint on
 * it, so reword the rest freely and leave those two words alone.
 */
export function operatingPointAxis(grid: Grid, prefix: string, context: string): Axis {
  if (!grid.axes.some((a) => a.name === 'l')) {
    throw new Error(`${prefix}: table has no "l" axis to slice`);
  }
  const vgsAxis = grid.axes.find((a) => a.name === 'vgs');
  if (!vgsAxis || vgsAxis.values.length === 0) {
    throw new Error(`${prefix}: table has no "vgs" axis to place an operating point on`);
  }
  for (const a of grid.axes) {
    if (a.name !== 'l' && a.name !== 'vgs' && a.values.length > 1) {
      throw new Error(`${prefix}: cannot ${context} with extra non-degenerate axis "${a.name}"`);
    }
  }
  return vgsAxis;
}

/**
 * Shared inversion kernel: build the `key` curve over vgs on the L-slice and invert it
 * to a vgs coordinate. Fails closed on any uninvertible slice (uncomputable quantity,
 * missing columns, extra live axes, non-monotonic data, out-of-range target) rather
 * than fabricating an operating point.
 */
function invertOnSlice(table: DeviceTable, L: number, key: string, target: number): number {
  const grid = table.grid;
  const vgs = operatingPointAxis(grid, 'inverse lookup', `bracket ${key}`).values;

  // Collapse the l axis at L, leaving a slice grid whose remaining axes include vgs.
  const slice = sliceGrid(grid, { l: L });

  // Every other axis is degenerate (the guard above), so the column IS the curve over the
  // vgs lattice — one value per node, in order.
  const curve = sliceColumn(table, slice, key);

  // Invert curve → vgs with the SAME monotone bracket-and-interpolate kernel the
  // cursor (series.invertX) uses, so endpoint/ULP handling is identical. orient
  // drops any non-finite node (an id==0 sample yields ±∞) so it cannot widen the
  // range or match a bracket; interp1 carries the shared ULP-overshoot clamp.
  const o = orient(curve, vgs);
  // The sizer is a guardrail: fail closed on any uninvertible slice rather than let
  // orient's fail-soft NaN bounds / arbitrary-branch sort fabricate an operating point.
  if (o.nx.length === 0) {
    throw new LookupError(
      `inverse lookup: no invertible ${key} data on the L=${L} slice (e.g. every sample has id==0)`,
    );
  }
  if (!o.mono) {
    throw new LookupError(
      `inverse lookup: ${key} is not monotonic in vgs on the L=${L} slice; cannot invert ${key} ${target} unambiguously`,
    );
  }
  if (target < o.xmin || target > o.xmax) {
    throw new LookupRangeError(key, target, o.xmin, o.xmax, L);
  }
  const vgsAt = interp1(o.nx, o.ny, target);
  if (!Number.isFinite(vgsAt)) {
    throw new LookupError(
      `inverse lookup: could not invert ${key} ${target} to a finite vgs on the L=${L} slice`,
    );
  }
  return vgsAt;
}
