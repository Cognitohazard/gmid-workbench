// Dense N-D grid on typed arrays. Row-major: first axis slowest, last fastest.
// Pure and deterministic. Zero DOM imports.

import type { Axis, Grid } from '../types';

/** Row-major flat index into a column over `shape`. */
export function flatIndex(shape: readonly number[], idx: readonly number[]): number {
  let flat = 0;
  for (let d = 0; d < shape.length; d++) {
    flat = flat * shape[d] + idx[d];
  }
  return flat;
}

/** Row-major strides for `shape` (last axis fastest): flat = Σ idx[d]·strides[d]. */
export function strides(shape: readonly number[]): number[] {
  const s = new Array<number>(shape.length);
  let acc = 1;
  for (let d = shape.length - 1; d >= 0; d--) {
    s[d] = acc;
    acc *= shape[d];
  }
  return s;
}

/** Product of axis lengths (= number of grid samples). */
function gridSize(shape: readonly number[]): number {
  let n = 1;
  for (const s of shape) n *= s;
  return n;
}

/**
 * Materialize an axis as a full-length column broadcast over the grid, row-major.
 * The value at sample i is the axis coordinate of i along this axis.
 */
function materializeAxis(axis: Axis, shape: readonly number[], dim: number): Float64Array {
  const total = gridSize(shape);
  const col = new Float64Array(total);
  // stride = product of lengths of axes after `dim` (how often this axis index advances)
  let stride = 1;
  for (let d = dim + 1; d < shape.length; d++) stride *= shape[d];
  const len = shape[dim];
  for (let i = 0; i < total; i++) {
    const ai = Math.floor(i / stride) % len;
    col[i] = axis.values[ai];
  }
  return col;
}

/**
 * Build a frozen dense grid. Validates every provided column length equals
 * prod(shape), then materializes each axis as a same-named full-length column
 * (so axes are queryable elementwise alongside the quantities).
 */
export function makeGrid(axes: Axis[], quantities: Map<string, Float64Array>): Grid {
  const frozenAxes: readonly Axis[] = Object.freeze(axes.map((a) => Object.freeze({ ...a })));
  const shape: readonly number[] = Object.freeze(frozenAxes.map((a) => a.values.length));
  const total = gridSize(shape);

  const merged = new Map<string, Float64Array>();

  // Validate provided quantity columns.
  for (const [key, col] of quantities) {
    if (col.length !== total) {
      throw new Error(
        `grid: column "${key}" length ${col.length} !== product of axis lengths ${total}`,
      );
    }
    merged.set(key, col);
  }

  // Materialize axes as columns (axis columns win over any same-named input).
  for (let d = 0; d < frozenAxes.length; d++) {
    merged.set(frozenAxes[d].name, materializeAxis(frozenAxes[d], shape, d));
  }

  const grid: Grid = {
    axes: frozenAxes,
    shape,
    quantities: merged,
  };
  return Object.freeze(grid);
}

/**
 * Locate `x` within strictly-ascending `values`: returns the lower node index `i`
 * and interpolation weight `w` such that the result is values[i]*(1-w)+values[i+1]*w.
 * Out-of-range clamps to the nearest edge (w pinned to 0 or 1).
 */
function locate(values: Float64Array, x: number): { i: number; w: number } {
  const n = values.length;
  if (n === 1) return { i: 0, w: 0 };
  if (x <= values[0]) return { i: 0, w: 0 };
  if (x >= values[n - 1]) return { i: n - 2, w: 1 };
  // binary search for the interval [values[i], values[i+1]] containing x
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= x) lo = mid;
    else hi = mid;
  }
  const i = lo;
  const span = values[i + 1] - values[i];
  const w = span === 0 ? 0 : (x - values[i]) / span;
  return { i, w };
}

/**
 * Multilinear interpolation of `keys` (default: all quantities) at `point`.
 * One value per axis name; a missing axis uses that axis's only/first value;
 * out-of-range coordinates clamp to the nearest edge.
 */
export function interpolate(
  grid: Grid,
  point: Record<string, number>,
  keys?: string[],
): Record<string, number> {
  const dims = grid.axes.length;
  const lowers = new Array<number>(dims);
  const weights = new Array<number>(dims);
  for (let d = 0; d < dims; d++) {
    const axis = grid.axes[d];
    const raw = point[axis.name];
    const x = raw === undefined ? axis.values[0] : raw;
    const { i, w } = locate(axis.values, x);
    lowers[d] = i;
    weights[d] = w;
  }

  const selectedKeys = keys ?? [...grid.quantities.keys()];
  const cols: Float64Array[] = [];
  for (const k of selectedKeys) {
    const col = grid.quantities.get(k);
    if (!col) throw new Error(`grid: unknown quantity "${k}"`);
    cols.push(col);
  }

  const out: Record<string, number> = {};
  const corners = 1 << dims;
  const idx = new Array<number>(dims);

  for (let c = 0; c < cols.length; c++) {
    out[selectedKeys[c]] = 0;
  }

  for (let corner = 0; corner < corners; corner++) {
    let cornerWeight = 1;
    for (let d = 0; d < dims; d++) {
      const high = (corner >> d) & 1;
      const wd = weights[d];
      const len = grid.shape[d];
      if (high) {
        // upper node; if the axis is degenerate (len 1) there is no upper node
        cornerWeight *= len > 1 ? wd : 0;
        idx[d] = len > 1 ? lowers[d] + 1 : lowers[d];
      } else {
        cornerWeight *= len > 1 ? 1 - wd : 1;
        idx[d] = lowers[d];
      }
    }
    if (cornerWeight === 0) continue;
    const flat = flatIndex(grid.shape, idx);
    for (let c = 0; c < cols.length; c++) {
      out[selectedKeys[c]] += cornerWeight * cols[c][flat];
    }
  }

  return out;
}

/**
 * Interpolate away the `fixed` axes, returning a lower-D Grid over the remaining
 * axes. Remaining axis columns are re-materialized by makeGrid.
 */
export function sliceGrid(grid: Grid, fixed: Record<string, number>): Grid {
  const fixedNames = new Set(Object.keys(fixed));
  const keepDims: number[] = [];
  const remainingAxes: Axis[] = [];
  for (let d = 0; d < grid.axes.length; d++) {
    if (!fixedNames.has(grid.axes[d].name)) {
      keepDims.push(d);
      remainingAxes.push({ name: grid.axes[d].name, values: grid.axes[d].values });
    }
  }

  // Precompute the locate (lower index + weight) for each fixed axis once.
  const fixedLowers = new Map<number, number>();
  const fixedWeights = new Map<number, number>();
  for (let d = 0; d < grid.axes.length; d++) {
    const axis = grid.axes[d];
    if (fixedNames.has(axis.name)) {
      const { i, w } = locate(axis.values, fixed[axis.name]);
      fixedLowers.set(d, i);
      fixedWeights.set(d, w);
    }
  }

  // Quantities to carry across: everything except the fixed axis columns
  // (remaining axis columns are re-materialized by makeGrid, so skip them too).
  const remainingNames = new Set(remainingAxes.map((a) => a.name));
  const carryKeys: string[] = [];
  for (const key of grid.quantities.keys()) {
    if (fixedNames.has(key)) continue;
    if (remainingNames.has(key)) continue;
    carryKeys.push(key);
  }

  const remShape = remainingAxes.map((a) => a.values.length);
  const remTotal = gridSize(remShape);
  // Resolve source/destination columns to arrays once so the inner loops index by
  // position instead of hashing carryKeys through the Map on every corner/cell.
  const srcCols = carryKeys.map((k) => grid.quantities.get(k)!);
  const dstCols = carryKeys.map(() => new Float64Array(remTotal));
  const outCols = new Map<string, Float64Array>();
  carryKeys.forEach((k, c) => outCols.set(k, dstCols[c]));

  const dims = grid.axes.length;
  const remIdx = new Array<number>(keepDims.length);
  const fullIdx = new Array<number>(dims);
  const fixedDims = [...fixedLowers.keys()]; // loop-invariant
  const corners = 1 << fixedDims.length;
  const acc = new Float64Array(carryKeys.length); // reused per output cell

  for (let r = 0; r < remTotal; r++) {
    // decode remaining-grid multi-index (row-major over remShape)
    let rem = r;
    for (let k = keepDims.length - 1; k >= 0; k--) {
      remIdx[k] = rem % remShape[k];
      rem = Math.floor(rem / remShape[k]);
    }
    for (let k = 0; k < keepDims.length; k++) {
      fullIdx[keepDims[k]] = remIdx[k];
    }

    // multilinear over the fixed axes only
    acc.fill(0);
    for (let corner = 0; corner < corners; corner++) {
      let cw = 1;
      for (let f = 0; f < fixedDims.length; f++) {
        const d = fixedDims[f];
        const high = (corner >> f) & 1;
        const w = fixedWeights.get(d)!;
        const len = grid.shape[d];
        if (high) {
          cw *= len > 1 ? w : 0;
          fullIdx[d] = len > 1 ? fixedLowers.get(d)! + 1 : fixedLowers.get(d)!;
        } else {
          cw *= len > 1 ? 1 - w : 1;
          fullIdx[d] = fixedLowers.get(d)!;
        }
      }
      if (cw === 0) continue;
      const flat = flatIndex(grid.shape, fullIdx);
      for (let c = 0; c < srcCols.length; c++) {
        acc[c] += cw * srcCols[c][flat];
      }
    }
    for (let c = 0; c < dstCols.length; c++) {
      dstCols[c][r] = acc[c];
    }
  }

  return makeGrid(remainingAxes, outCols);
}

/**
 * One monotone curve oriented for inversion: the finite (x, y) pairs ordered by
 * ascending X, plus the X range and a monotonicity flag. The shared substrate for
 * 1-D inverse lookup — the sizer (lookup.lookupByGmId, gm/ID → vgs) and the cursor
 * (series.invertX, an X-expression → its sweep coordinate) both build one of these
 * and read it back with interp1, so their endpoint/ULP handling is identical.
 */
export interface Oriented {
  readonly nx: number[]; // finite X values, ascending
  readonly ny: number[]; // matching Y values
  readonly xmin: number; // nx[0] (NaN when empty)
  readonly xmax: number; // nx[last] (NaN when empty)
  readonly mono: boolean; // X traces a single direction along the sweep (no real fold)
}

// A monotone curve's total variation equals its span; a folded one doubles back
// (tv ≈ 2·span). Allow this much excess for sweep noise before calling it folded —
// generous, so valid (slightly noisy) silicon data is never false-flagged.
const FOLD_TOL = 0.25;

/**
 * Keep finite (x, y) pairs, order them by ascending X (so interp1 can bracket), and
 * decide whether X is a usable monotone axis — true unless the curve genuinely folds
 * back on itself (total variation along the sweep exceeds the span by > FOLD_TOL).
 * Sorting handles a descending sweep (gm/ID falls as vgs rises) and minor wiggles
 * uniformly; the fold test, not the sort, is what flags a non-monotone X. Dropping
 * the non-finite pairs is also the guard against a divide-by-zero node (e.g. an id==0
 * sample whose gm/ID is ±∞): such a node never widens [xmin, xmax] or matches a bracket.
 */
export function orient(xs: Float64Array, ys: Float64Array): Oriented {
  const fx: number[] = [];
  const fy: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      fx.push(xs[i]);
      fy.push(ys[i]);
    }
  }
  let tv = 0; // total variation of X in sweep order
  for (let i = 1; i < fx.length; i++) tv += Math.abs(fx[i] - fx[i - 1]);
  const order = fx.map((_, i) => i).sort((a, b) => fx[a] - fx[b]);
  const nx = order.map((i) => fx[i]);
  const ny = order.map((i) => fy[i]);
  const n = nx.length;
  const span = n ? nx[n - 1] - nx[0] : NaN;
  const mono = n < 2 ? true : tv <= (1 + FOLD_TOL) * span;
  return { nx, ny, xmin: n ? nx[0] : NaN, xmax: n ? nx[n - 1] : NaN, mono };
}

// A query this far (relative to the curve's span) past either end is float rounding
// from the X expression, not a real gap — clamp it in rather than return NaN.
const EDGE_SNAP_REL = 1e-9;

/**
 * Linear interpolation of an ascending (nx, ny) curve at xq. Returns NaN outside the
 * native range — a gap, never an extrapolation. A query a few ULP past either end (from
 * float rounding in the X expression, which can differ curve-to-curve at a shared bias)
 * is clamped in rather than dropped, so curves that share a range don't get spurious
 * one-point gaps; a genuine gap (query well outside) still returns NaN.
 */
export function interp1(nx: number[], ny: number[], xq: number): number {
  const n = nx.length;
  if (n === 0) return NaN;
  const tol = (nx[n - 1] - nx[0]) * EDGE_SNAP_REL + Number.EPSILON;
  if (xq < nx[0] - tol || xq > nx[n - 1] + tol) return NaN;
  const q = xq <= nx[0] ? nx[0] : xq >= nx[n - 1] ? nx[n - 1] : xq; // clamp the ULP overshoot
  if (n === 1) return ny[0];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (nx[mid] <= q) lo = mid;
    else hi = mid;
  }
  const x0 = nx[lo];
  const x1 = nx[hi];
  if (x1 === x0) return ny[lo];
  return ny[lo] + ((ny[hi] - ny[lo]) * (q - x0)) / (x1 - x0);
}
