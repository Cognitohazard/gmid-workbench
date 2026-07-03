// Forward + inverse operating-point lookup. Interpolates a device table's base
// grid at a point in axis-space, then evaluates derived quantities from the
// interpolated base scalars (dogfooding the expression engine). The inverse path
// recovers vgs from a target gm/ID along a fixed-L slice. Pure, deterministic,
// zero DOM imports.

import type { DeviceTable, Grid } from '../types';
import { BASE_KEYS } from '../namespace';
import { CONSTANTS } from '../constants';
import { interpolate, sliceGrid, orient, interp1 } from '../grid';
import { scalarScope } from '../expr';
import { DERIVED_COMPILED, metaScalars } from '../derive';

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

/** True if every free name of a derived def is an available base scalar or constant. */
function computable(names: readonly string[], base: Record<string, number>): boolean {
  for (const n of names) {
    if (Object.prototype.hasOwnProperty.call(base, n)) continue;
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, n)) continue;
    return false;
  }
  return true;
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
    ...DERIVED_ENTRIES.filter(([, compiled]) => computable(compiled.names, baseScalars)).map(
      ([key]) => key,
    ),
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
 * Inverse lookup by gm/ID along the fixed-length-`L` slice: gm/ID is monotonic in
 * vgs, so build the gm/ID-vs-vgs curve from the slice columns, bracket `gmId`, and
 * linearly interpolate to recover vgs; then forward-lookup at {l: L, vgs}.
 *
 * Fails closed: throws if the slice carries no invertible gm/ID data (e.g. every
 * id==0), if gm/ID is non-monotonic in vgs (an ambiguous fold), or if `gmId` lies
 * outside the slice's [min, max] gm/ID range.
 */
export function lookupByGmId(
  table: DeviceTable,
  gmId: number,
  L: number,
  keys?: string[],
): Record<string, number> {
  return lookup(table, { l: L, vgs: invertOnSlice(table, L, 'gm/id', gmId) }, keys);
}

/**
 * Inverse lookup by a raw column value (gm or id, at the characterization width)
 * along the fixed-L slice — both are monotonic in vgs on healthy data. This is the
 * kernel behind width-first sizing: a target density gm/W or id/W maps to a
 * characterization-column target via the width ratio, which this inverts to vgs.
 */
export function lookupByColumn(
  table: DeviceTable,
  key: 'gm' | 'id',
  target: number,
  L: number,
  keys?: string[],
): Record<string, number> {
  return lookup(table, { l: L, vgs: invertOnSlice(table, L, key, target) }, keys);
}

/**
 * Shared inversion kernel: build the requested curve ('gm/id' ratio, or a raw gm/id
 * column) over vgs on the L-slice and invert it to a vgs coordinate. Fails closed on
 * any uninvertible slice (missing columns, extra live axes, non-monotonic data,
 * out-of-range target) rather than fabricating an operating point.
 */
function invertOnSlice(
  table: DeviceTable,
  L: number,
  what: 'gm/id' | 'gm' | 'id',
  target: number,
): number {
  const grid = table.grid;
  if (!grid.axes.some((a) => a.name === 'l')) {
    throw new Error('inverse lookup: table has no "l" axis to slice');
  }

  // Collapse the l axis at L, leaving a slice grid whose remaining axes include vgs.
  const slice = sliceGrid(grid, { l: L });
  const vgsAxis = slice.axes.find((a) => a.name === 'vgs');
  if (!vgsAxis) {
    throw new Error('inverse lookup: slice has no "vgs" axis');
  }
  const vgs = vgsAxis.values;
  const gm = slice.quantities.get('gm');
  const id = slice.quantities.get('id');
  if (!gm || !id) {
    throw new Error('inverse lookup: slice is missing gm and/or id columns');
  }

  // The vgs axis must be the only non-degenerate remaining axis for the 1-D curve
  // to be well defined (vds/vsb would otherwise break monotonic bracketing).
  for (const a of slice.axes) {
    if (a.name !== 'vgs' && a.values.length > 1) {
      throw new Error(
        `inverse lookup: cannot bracket ${what} with extra non-degenerate axis "${a.name}"`,
      );
    }
  }

  const n = vgs.length;
  // The curve over the vgs lattice, holding any trailing degenerate axes at index 0.
  const curve = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const flat = vgsAxisFlat(slice, i);
    curve[i] = what === 'gm/id' ? gm[flat] / id[flat] : what === 'gm' ? gm[flat] : id[flat];
  }

  // Invert curve → vgs with the SAME monotone bracket-and-interpolate kernel the
  // cursor (series.invertX) uses, so endpoint/ULP handling is identical. orient
  // drops any non-finite node (an id==0 sample yields ±∞) so it cannot widen the
  // range or match a bracket; interp1 carries the shared ULP-overshoot clamp.
  const o = orient(curve, vgs);
  // The sizer is a guardrail: fail closed on any uninvertible slice rather than let
  // orient's fail-soft NaN bounds / arbitrary-branch sort fabricate an operating point.
  if (o.nx.length === 0) {
    throw new Error(
      `inverse lookup: no invertible ${what} data on the L=${L} slice (e.g. every sample has id==0)`,
    );
  }
  if (!o.mono) {
    throw new Error(
      `inverse lookup: ${what} is not monotonic in vgs on the L=${L} slice; cannot invert ${what} ${target} unambiguously`,
    );
  }
  if (target < o.xmin || target > o.xmax) {
    throw new Error(
      `inverse lookup: ${what} ${target} out of range [${o.xmin}, ${o.xmax}] for L=${L}`,
    );
  }
  const vgsAt = interp1(o.nx, o.ny, target);
  if (!Number.isFinite(vgsAt)) {
    throw new Error(
      `inverse lookup: could not invert ${what} ${target} to a finite vgs on the L=${L} slice`,
    );
  }
  return vgsAt;
}

/**
 * Flat index of the i-th vgs node in a slice grid, holding every other (degenerate)
 * axis at index 0. Mirrors the row-major layout of makeGrid.
 */
function vgsAxisFlat(slice: Grid, vgsIdx: number): number {
  let flat = 0;
  for (let d = 0; d < slice.axes.length; d++) {
    const len = slice.axes[d].values.length;
    const idx = slice.axes[d].name === 'vgs' ? vgsIdx : 0;
    flat = flat * len + idx;
  }
  return flat;
}
