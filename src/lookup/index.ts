// Forward + inverse operating-point lookup. Interpolates a device table's stored
// columns at a point in axis-space, then evaluates derived quantities from the
// interpolated base scalars (dogfooding the expression engine). The inverse path
// recovers vgs from a target value of any stored or derived quantity (gm/ID, fT,
// intrinsic gain, …) along a fixed-L slice. Pure, deterministic, zero DOM imports.

import { type Axis, type DeviceTable, type Grid, LookupError, LookupRangeError } from '../types';
import { BASE_KEYS, engineNameReason, passthroughKeys, passthroughName } from '../namespace';
import { interpolate, sliceGrid, orient, interp1, type Oriented } from '../grid';
import { DERIVED_FORMS, derivedForm, metaScalars, evalColumn, pointScope } from '../derive';

// The Map is authoritative (shared with derive); a module-level key array keeps the per-lookup
// default-keys walk allocation-free.
const DERIVED_KEYS = [...DERIVED_FORMS.keys()];

/** Base quantity keys actually stored as columns in this grid (axes included). */
function baseKeysPresent(grid: Grid): string[] {
  const out: string[] = [];
  for (const key of grid.quantities.keys()) {
    if (BASE_KEYS.has(key)) out.push(key);
  }
  return out;
}

/**
 * The first free name of a derived definition that `has` cannot resolve, a derived name counting
 * when some form of it does — what the inverse path names as the missing column when a table
 * cannot compute a quantity by any form. Constants never appear among the free names.
 */
function missingInput(
  names: readonly string[],
  has: (name: string) => boolean,
): string | undefined {
  return names.find((n) => !has(n) && derivedForm(n, has) === undefined);
}

/**
 * Whether a forward lookup reports derived quantity `key` unasked, on a point holding what `has`
 * holds: some form of it is computable there and reads something — a stand-in that reads nothing
 * (γ on a table without `sth`) is not a reading of the table. The one rule behind lookup's default
 * keys and the sizer's re-derivation at the sized width.
 */
export const reportsDerived = (key: string, has: (name: string) => boolean): boolean =>
  (derivedForm(key, has)?.compiled.names.length ?? 0) > 0;

/**
 * The keys a forward lookup reports without evaluating anything: every present base column, each
 * axis coordinate the grid does not store as a column, and every pass-through column under the name
 * it is read by (passthroughName) — its default keys less the derived quantities. For a caller that
 * re-derives at another width (the sizer), which would discard every derived value lookup computed.
 */
export function storedKeys(table: DeviceTable): string[] {
  const base = baseKeysPresent(table.grid);
  const meta = metaScalars(table.meta);
  const axes = table.grid.axes
    .map((a) => a.name)
    .filter((n) => !base.includes(n) && !Object.prototype.hasOwnProperty.call(meta, n));
  return [...base, ...axes, ...passthroughKeys(table.grid).map(passthroughName)];
}

/**
 * Forward lookup: multilinearly interpolate the stored columns at `point` (axis-space),
 * then evaluate any requested derived quantity from the interpolated base scalars.
 *
 * When `keys` is omitted the result holds every present base column, every pass-through
 * column under the name it is read by (see passthroughName: `table__k` for a column called `k`),
 * and every standard derived quantity computable from those bases
 * by a form that reads them — a stand-in that reads nothing (γ on a table without `sth`) is not a
 * reading of the table, and is answered only when asked for by name. Requested derived keys are
 * evaluated from the interpolated scalars (NOT re-interpolated), so vstar = 2/(gm/id) etc. stay
 * self-consistent at the point. Each is computed by the form the table reads it by, which is not
 * always its definition: derivedFallbacks names the quantities that fell back, and why.
 *
 * An axis `point` does not name is read at its first node, and a coordinate past an axis's range
 * at its edge (the axis value returned is the one read). Neither is said here: the caller owns
 * it — sizeDevice holds the point to the table first (operatingPointAxis, offHull), and a chart
 * readout reads the point its curve was drawn at, which the overlay's warning describes
 * (pinnedElsewhere).
 */
export function lookup(
  table: DeviceTable,
  point: Record<string, number>,
  keys?: string[],
): Record<string, number> {
  const grid = table.grid;

  // Interpolate every present stored column once (one corner walk), then split the pass-through
  // columns back out: they are reported, but they stay out of the scope the derived layer reads.
  // A derived definition names only base quantities and constants, so the one thing a
  // pass-through could do there is shadow a constant — a column called `k` would silently
  // replace Boltzmann's constant in the γ-model noise. Each is reported under the name it is
  // read by everywhere (passthroughName), so the same column has one name in a lookup, a sizing
  // and a sheet.
  const basePresent = baseKeysPresent(grid);
  const columns = passthroughKeys(grid);
  const baseScalars = interpolate(grid, point, [...basePresent, ...columns]);
  const extraScalars: Record<string, number> = {};
  for (const key of columns) {
    extraScalars[passthroughName(key)] = baseScalars[key];
    delete baseScalars[key];
  }
  const extraPresent = Object.keys(extraScalars);

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

  const hasBase = (n: string): boolean => Object.prototype.hasOwnProperty.call(baseScalars, n);
  const requested = keys ?? [
    ...basePresent,
    ...axisKeys,
    ...extraPresent,
    ...DERIVED_KEYS.filter((key) => reportsDerived(key, hasBase)),
  ];

  // A point scope rather than a plain scalar one: a definition that reads another derived name
  // (the γ-model keys read `gamma`) must see the table's value of it, not the constant.
  const scope = pointScope(baseScalars);
  const out: Record<string, number> = {};

  for (const key of requested) {
    if (Object.prototype.hasOwnProperty.call(baseScalars, key)) {
      out[key] = baseScalars[key];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(extraScalars, key)) {
      out[key] = extraScalars[key];
      continue;
    }
    const forms = DERIVED_FORMS.get(key);
    if (!forms) {
      const renamed = grid.quantities.has(key) ? engineNameReason(key) : undefined;
      throw new Error(
        renamed
          ? `lookup: this table's "${key}" column is read as "${passthroughName(key)}" — ${renamed}`
          : `lookup: "${key}" is neither a present column of this table nor a known derived ` +
              `quantity`,
      );
    }
    // By name, so it is the value every expression reading the name gets at this point: the form
    // this table reads it by (or, computable by none, the definition's error naming the column).
    const v = scope.resolve(key) ?? forms[0].compiled.eval(scope);
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
 * such names. The forward half of sizing re-derives every name that has a definition (see
 * `lookup`, passthroughKeys and sizeDevice's re-evaluation at the sized width), so inverting a stored
 * `ft` or `gm_id` column would place the operating point on a curve nothing downstream
 * agrees with: the sizer would silently return a device whose reported fT is not the fT it
 * was asked for. Stored columns serve the base keys (gm, id) that have no definition, and a base
 * key that also has one (`gamma`), which is read as stored here as it is everywhere else.
 *
 * Fails closed naming the missing input when this table cannot compute `key` at all, or only by a
 * stand-in that reads no column — "size by fT" on a table with no cgg column is a data limit, not
 * a bad bind, and must say so rather than surface as an out-of-range or non-monotonic complaint.
 */
function sliceColumn(table: DeviceTable, slice: Grid, key: string): Float64Array {
  const forms = DERIVED_FORMS.get(key);
  // A base quantity the namespace also derives (a `gamma` column beside `sth`) is read as stored,
  // the way derive() and the forward lookup read it, so the curve inverted is the one reported.
  const stored = slice.quantities.get(key);
  if (stored && (!forms || BASE_KEYS.has(key))) return stored;
  if (!forms) {
    throw new Error(
      `inverse lookup: "${key}" is neither a present base column nor a known derived quantity`,
    );
  }
  const scalars = metaScalars(table.meta);
  const has = (n: string): boolean =>
    slice.quantities.has(n) || Object.prototype.hasOwnProperty.call(scalars, n);
  const form = derivedForm(key, has);
  // A form that reads no column (γ's stand-in) is not a curve of this table: there is nothing to
  // invert, as the forward lookup and the chart picker leave it out too.
  if (!form || form.compiled.names.length === 0) {
    throw new Error(
      `inverse lookup: cannot invert "${key}" on this table — it carries no "${missingInput(forms[0].compiled.names, has)}" column`,
    );
  }
  return evalColumn(slice, form.compiled, scalars);
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
 * A table's slice at one length, and what sizing reads off it: the curve of each quantity it has
 * inverted there, oriented for inversion, and the gm/ID ceiling. All three are pure functions of
 * the table and the length, so each is built once and read again by every later sizing on the
 * same table at the same length — the sheet engine sizes many devices on one cached table (see
 * sheet/eval.ts), and the solver sizes the same ones again on every probe.
 */
interface LengthSlice {
  readonly grid: Grid;
  readonly curves: Map<string, Oriented>;
  ceiling?: number;
}

/** Per table, its slices by length. Weak in the table, so a slice lives exactly as long as the
 *  table it was cut from; bounded per table, the least recently used dropped first, because a
 *  sweep of L asks for a new length every sample. */
const LENGTH_SLICES = new WeakMap<DeviceTable, Map<number, LengthSlice>>();
const LENGTH_SLICES_PER_TABLE = 8;

/** The table's slice at length `L` (see LengthSlice). */
function lengthSlice(table: DeviceTable, L: number): LengthSlice {
  let byL = LENGTH_SLICES.get(table);
  if (!byL) LENGTH_SLICES.set(table, (byL = new Map()));
  const hit = byL.get(L);
  if (hit) {
    // Re-inserted, so insertion order tracks recency and the cap drops the coldest.
    byL.delete(L);
    byL.set(L, hit);
    return hit;
  }
  if (byL.size >= LENGTH_SLICES_PER_TABLE) byL.delete(byL.keys().next().value as number);
  const made: LengthSlice = { grid: sliceGrid(table.grid, { l: L }), curves: new Map() };
  byL.set(L, made);
  return made;
}

/**
 * Maximum gm/ID over the fixed-L slice — the weak-inversion ceiling the device
 * cannot physically exceed. Computed elementwise from the slice's gm and id
 * columns so it reflects exactly the data, not a model assumption.
 */
export function gmIdCeiling(table: DeviceTable, L: number): number {
  const slice = lengthSlice(table, L);
  if (slice.ceiling !== undefined) return slice.ceiling;
  const gm = slice.grid.quantities.get('gm');
  const id = slice.grid.quantities.get('id');
  if (!gm || !id) {
    throw new Error('sizeDevice: slice is missing gm and/or id columns for the ceiling');
  }
  let max = -Infinity;
  for (let i = 0; i < gm.length; i++) {
    if (id[i] === 0) continue; // undefined ratio; skip (mirrors qa/validate's ceiling scan)
    const r = gm[i] / id[i];
    if (Number.isFinite(r) && r > max) max = r; // skip ±∞/NaN so they can't pin the ceiling
  }
  slice.ceiling = max;
  return max;
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
  const slice = lengthSlice(table, L);

  // Every other axis is degenerate (the guard above), so the column IS the curve over the
  // vgs lattice — one value per node, in order.
  //
  // Invert curve → vgs with the SAME monotone bracket-and-interpolate kernel the
  // cursor (series.invertX) uses, so endpoint/ULP handling is identical. orient
  // drops any non-finite node (an id==0 sample yields ±∞) so it cannot widen the
  // range or match a bracket; interp1 carries the shared ULP-overshoot clamp. The oriented
  // curve depends on the table, the length and the key alone, so it is built once for each; a
  // key the table cannot compute throws here every time, and is never stored.
  let o = slice.curves.get(key);
  if (!o) {
    o = orient(sliceColumn(table, slice.grid, key), vgs);
    slice.curves.set(key, o);
  }
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
