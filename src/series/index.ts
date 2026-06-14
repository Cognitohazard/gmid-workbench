// Family-of-curves preparation for charting. Hold one axis as X, sweep another
// axis as the "family", and evaluate an expression along X for each family
// value — yielding one Y curve per family member, all aligned to the shared X
// lattice. Pure, deterministic, zero DOM imports. Reuses sliceGrid (fix the
// family + any other axes) + deriveColumn (evaluate the expression).

import type { DeviceTable, Grid } from '../types';
import { sliceGrid } from '../grid';
import { compileExpr, evalColumn } from '../derive';
import { BASE_QUANTITIES, DERIVED_QUANTITIES } from '../namespace';
import { CONSTANTS } from '../constants';

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

/**
 * The canonical quantities a familyCurves chart over `xName` can plot as Y: every
 * name a per-curve slice can resolve. The slice collapses the family axis and
 * every other non-X axis, so the resolvable namespace is the X axis + the
 * non-axis columns + constants — axis quantities other than X (l, vds, …) are NOT
 * plottable here. Returns the present base keys and the standard derived keys
 * expressible from them, for building a Y picker honestly per table.
 */
export function plottableQuantities(grid: Grid, xName = 'vgs'): { base: string[]; derived: string[] } {
  const axisNames = new Set(grid.axes.map((a) => a.name));
  const resolvable = new Set<string>([
    xName,
    ...[...grid.quantities.keys()].filter((k) => !axisNames.has(k)),
    ...Object.keys(CONSTANTS),
  ]);
  const base = BASE_QUANTITIES.filter((q) => resolvable.has(q.key)).map((q) => q.key);
  const derived = DERIVED_NAMES.filter((d) => d.names.every((n) => resolvable.has(n))).map(
    (d) => d.key,
  );
  return { base, derived };
}
