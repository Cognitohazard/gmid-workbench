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

export interface FamilyCurves {
  readonly xName: string;
  readonly x: Float64Array; // shared X lattice (the X axis nodes)
  readonly famName: string;
  readonly famValues: Float64Array; // one per curve
  readonly lines: Float64Array[]; // lines[k] = expr along x at famValues[k]
}

/**
 * Build one Y curve per value of the `famName` axis: fix that axis, fix every
 * other non-X axis at the coordinate given in `fixed` (or its first node when
 * absent), slice to a 1-D grid over `xName`, and evaluate `expr` over the slice.
 * Every curve aligns to the shared X lattice.
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
  famName = 'l',
  fixed: Record<string, number> = {},
): FamilyCurves {
  if (xName === famName) {
    throw new Error(`familyCurves: xName and famName must differ (both "${xName}")`);
  }
  const grid = table.grid;
  const xAxis = grid.axes.find((a) => a.name === xName);
  const famAxis = grid.axes.find((a) => a.name === famName);
  if (!xAxis) throw new Error(`familyCurves: table has no "${xName}" axis`);
  if (!famAxis) throw new Error(`familyCurves: table has no "${famName}" axis`);

  const compiled = compileExpr(expr); // parse once; reused across every curve
  const lines: Float64Array[] = [];
  for (const fv of famAxis.values) {
    const at: Record<string, number> = { [famName]: fv };
    for (const a of grid.axes) {
      if (a.name !== xName && a.name !== famName) at[a.name] = fixed[a.name] ?? a.values[0];
    }
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
