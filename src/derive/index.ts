// Derived-quantity evaluation. Resolves the canonical base/axis namespace into
// engine scopes and dogfoods the expression engine to compute derived columns
// (gm/ID, fT, V*, FOMs, …). Pure, deterministic, zero DOM imports.

import type { DeviceTable, Grid, Scope, Value } from '../types';
import { DERIVED_QUANTITIES } from '../namespace';
import { createEngine } from '../expr';

// Compile each standard derived definition once, shared across all calls.
const ENGINE = createEngine();
const DERIVED_COMPILED = new Map(
  DERIVED_QUANTITIES.map((q) => [q.key, ENGINE.compile(q.expr)] as const),
);

/** Number of grid samples (= length of every materialized column). */
const gridSize = (grid: Grid): number => grid.shape.reduce((a, b) => a * b, 1);

/**
 * A Scope over a grid: resolve a base or axis name to its full-length flat
 * column. Axis columns were materialized into `grid.quantities` by makeGrid, so
 * a single map lookup covers both axes and stored quantities. Unknown names
 * return undefined (the engine then falls back to its constant map, else errors).
 */
export function tableScope(grid: Grid): Scope {
  return {
    resolve(name: string): Value | undefined {
      return grid.quantities.get(name);
    },
  };
}

/** Broadcast a scalar engine result into a full-length grid column. */
function asColumn(v: Value, size: number): Float64Array {
  if (v instanceof Float64Array) return v;
  const out = new Float64Array(size);
  out.fill(v);
  return out;
}

/**
 * Evaluate the derived quantity `key` over `table`'s grid, returning a
 * full-length column. Throws if `key` is not a known derived quantity.
 */
export function derive(table: DeviceTable, key: string): Float64Array {
  const compiled = DERIVED_COMPILED.get(key);
  if (!compiled) {
    throw new Error(`derive: unknown derived quantity "${key}"`);
  }
  const result = compiled.eval(tableScope(table.grid));
  return asColumn(result, gridSize(table.grid));
}

/**
 * Evaluate an arbitrary expression over `grid`, returning a full-length column.
 * For charting custom expressions against the base namespace + constants.
 */
export function deriveColumn(grid: Grid, exprSrc: string): Float64Array {
  const result = ENGINE.evaluate(exprSrc, tableScope(grid));
  return asColumn(result, gridSize(grid));
}
