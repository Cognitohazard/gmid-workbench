// Data-trust QA + sign canonicalization for device tables.
//
// validate() runs a set of cheap, deterministic sanity checks per L-slice and
// returns structured QAWarnings. canonicalizeTable() folds signed (PMOS) source
// conventions into magnitudes, recording the polarity that was applied.

import type {
  Axis,
  DeviceTable,
  Grid,
  Polarity,
  QAWarning,
  TableMeta,
} from '../types';
import { UT } from '../constants';
import { BASE_QUANTITIES } from '../namespace';

// --- physical thresholds -----------------------------------------------------

/** Physical ceiling on gm/ID ≈ 1/U_T (weak-inversion limit), in S/A. */
const GM_ID_CEILING = 1 / UT; // ~38.7 at 27 °C

/** Above this, a gm/ID value is almost certainly a unit error, not physics. */
const GM_ID_UNIT_ERROR = 45;

/** Per-step vgs spacing above this (in volts) is coarse enough to warn. */
const VGS_STEP_WARN = 0.01; // 10 mV

/** |vgs| above this (in volts) means the axis is probably in mV, not V. */
const VGS_UNIT_ERROR = 100;

/** Quantities whose sign is convention-dependent and folded to magnitude. */
const SIGNED_MAGNITUDE_KEYS: readonly string[] = ['id', 'gm', 'gds', 'gmb'];

/** Capacitance keys (also folded to magnitude on signed input). */
const CAP_KEYS: readonly string[] = BASE_QUANTITIES
  .filter((q) => q.unit === 'F')
  .map((q) => q.key);

/** Voltage axis/column keys (folded to |v| on signed input). */
const VOLTAGE_KEYS: readonly string[] = BASE_QUANTITIES
  .filter((q) => q.unit === 'V')
  .map((q) => q.key);

// --- grid helpers ------------------------------------------------------------

/** Index of a named axis in the grid, or -1 if absent. */
function axisIndex(grid: Grid, name: string): number {
  return grid.axes.findIndex((a) => a.name === name);
}

/** Row-major strides for the given shape (last axis fastest). */
function strides(shape: readonly number[]): number[] {
  const s = new Array<number>(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    s[i] = acc;
    acc *= shape[i];
  }
  return s;
}

/**
 * Walk every L-slice. For each value on the `l` axis (or a single synthetic
 * slice if there is no `l` axis), invoke `fn` with the slice's index on the L
 * axis and the L value (NaN when absent).
 */
function forEachLSlice(
  grid: Grid,
  fn: (lIndex: number, lValue: number) => void,
): void {
  const li = axisIndex(grid, 'l');
  if (li < 0) {
    fn(0, NaN);
    return;
  }
  const lvals = grid.axes[li].values;
  for (let i = 0; i < lvals.length; i++) fn(i, lvals[i]);
}

/**
 * Collect the flat indices belonging to one L-slice, ordered so that the named
 * sweep axis (`alongName`) varies fastest. Returns null if the named axis is
 * absent. Used to read a quantity column along one physical sweep within a slice.
 */
function sliceIndices(
  grid: Grid,
  lIndex: number,
  alongName: string,
): { indices: number[][]; along: Axis } | null {
  const along = axisIndex(grid, alongName);
  if (along < 0) return null;
  const li = axisIndex(grid, 'l');
  const st = strides(grid.shape);

  // Fixed coordinates: every axis except L (pinned to lIndex) and the sweep
  // axis. We enumerate the cartesian product of the remaining "other" axes so
  // each entry is one independent line of the sweep within this L-slice.
  const otherAxes: number[] = [];
  for (let a = 0; a < grid.axes.length; a++) {
    if (a === along || a === li) continue;
    otherAxes.push(a);
  }

  const lines: number[][] = [];
  const otherCounts = otherAxes.map((a) => grid.shape[a]);
  const total = otherCounts.reduce((p, c) => p * c, 1);

  for (let combo = 0; combo < total; combo++) {
    // Decode `combo` into per-otherAxis coordinates.
    let rem = combo;
    let base = 0;
    for (let k = otherAxes.length - 1; k >= 0; k--) {
      const coord = rem % otherCounts[k];
      rem = Math.floor(rem / otherCounts[k]);
      base += coord * st[otherAxes[k]];
    }
    if (li >= 0) base += lIndex * st[li];

    const line: number[] = [];
    for (let j = 0; j < grid.shape[along]; j++) line.push(base + j * st[along]);
    lines.push(line);
  }

  return { indices: lines, along: grid.axes[along] };
}

// --- validation rules --------------------------------------------------------

function fmtL(lValue: number): string {
  return Number.isNaN(lValue) ? 'L-slice' : `L=${lValue.toExponential(3)}`;
}

/**
 * Run data-trust checks on a device table. Pure: never mutates the table.
 * Checks are skipped gracefully when a required column/axis is absent.
 */
export function validate(table: DeviceTable): QAWarning[] {
  const out: QAWarning[] = [];
  const grid = table.grid;
  const q = grid.quantities;

  const vgsAxisI = axisIndex(grid, 'vgs');
  const vgsAxis = vgsAxisI >= 0 ? grid.axes[vgsAxisI] : undefined;

  // --- vgs axis checks (monotonicity, step size, unit sniff) ---
  if (vgsAxis) {
    const v = vgsAxis.values;

    // |vgs| ceiling: mV-instead-of-V. Reported once for the axis.
    let maxAbs = 0;
    for (let i = 0; i < v.length; i++) maxAbs = Math.max(maxAbs, Math.abs(v[i]));
    if (maxAbs > VGS_UNIT_ERROR) {
      out.push({
        rule: 'unit-vgs',
        severity: 'error',
        message: `vgs reaches |${maxAbs}| V — axis is likely in mV, not V`,
        location: 'vgs',
      });
    }

    // Per-L-slice monotonicity + step. The vgs axis is shared across slices, so
    // the sequence is identical per slice; we still attribute findings to a slice.
    forEachLSlice(grid, (_li, lValue) => {
      let prev = v[0];
      let maxStep = 0;
      let nonMonotonic = false;
      for (let i = 1; i < v.length; i++) {
        const step = v[i] - prev;
        if (step <= 0) nonMonotonic = true;
        if (step > maxStep) maxStep = step;
        prev = v[i];
      }
      if (nonMonotonic) {
        out.push({
          rule: 'non-monotonic',
          severity: 'error',
          message: `vgs is not strictly increasing in ${fmtL(lValue)}`,
          location: `vgs @ ${fmtL(lValue)}`,
        });
      }
      if (maxStep > VGS_STEP_WARN) {
        out.push({
          rule: 'vgs-step',
          severity: 'warning',
          message: `vgs step up to ${(maxStep * 1e3).toFixed(1)} mV exceeds 10 mV in ${fmtL(lValue)}`,
          location: `vgs @ ${fmtL(lValue)}`,
        });
      }
    });
  }

  // --- gm/ID ceiling (needs gm and id columns) ---
  const gm = q.get('gm');
  const id = q.get('id');
  if (gm && id) {
    let maxGmId = 0;
    const n = Math.min(gm.length, id.length);
    for (let i = 0; i < n; i++) {
      const idv = id[i];
      if (idv === 0) continue; // undefined ratio; skip
      const r = Math.abs(gm[i] / idv);
      if (Number.isFinite(r) && r > maxGmId) maxGmId = r;
    }
    if (maxGmId > GM_ID_UNIT_ERROR) {
      out.push({
        rule: 'gm-id-ceiling',
        severity: 'error',
        message: `max gm/ID ${maxGmId.toFixed(1)} S/A exceeds ${GM_ID_UNIT_ERROR} — likely a unit error`,
        location: 'gm/id',
      });
    } else if (maxGmId > GM_ID_CEILING) {
      out.push({
        rule: 'gm-id-ceiling',
        severity: 'warning',
        message: `max gm/ID ${maxGmId.toFixed(1)} S/A exceeds the physical ceiling ~${GM_ID_CEILING.toFixed(1)} (1/U_T)`,
        location: 'gm/id',
      });
    }
  }

  // --- saturation: gds should fall as the device saturates ---
  // Walk gds along vds (preferred) or vgs within each L-slice; if it never
  // decreases anywhere in a slice the device may not reach saturation.
  const gds = q.get('gds');
  if (gds) {
    const sweepName = axisIndex(grid, 'vds') >= 0 ? 'vds' : 'vgs';
    forEachLSlice(grid, (lIndex, lValue) => {
      const sl = sliceIndices(grid, lIndex, sweepName);
      if (!sl) return;
      let anyFall = false;
      for (const line of sl.indices) {
        for (let j = 1; j < line.length; j++) {
          if (gds[line[j]] < gds[line[j - 1]]) {
            anyFall = true;
            break;
          }
        }
        if (anyFall) break;
      }
      if (!anyFall && sl.along.values.length > 1) {
        out.push({
          rule: 'no-saturation',
          severity: 'info',
          message: `gds never falls along ${sweepName} in ${fmtL(lValue)} — device may not reach saturation`,
          location: `gds @ ${fmtL(lValue)}`,
        });
      }
    });
  }

  return out;
}

// --- canonicalization --------------------------------------------------------

/**
 * Fold signed (e.g. PMOS) source conventions into magnitudes. When
 * meta.polarity.signedInput is set, replace id/gm/gds/gmb, capacitances and
 * NON-AXIS voltages (vth, vdsat) with |value|, and record the polarity. Sweep
 * AXES are left untouched: a signed sweep is still ascending and valid, and the
 * data row order already matches it — abs-ing + re-sorting an axis without
 * reindexing the data would corrupt the mapping. |V| axis presentation, if ever
 * wanted, belongs at parse time pre-grid (see the vbs sign-flip in parse).
 */
export function canonicalizeTable(table: DeviceTable): DeviceTable {
  const pol: Polarity | undefined = table.meta.polarity;
  if (!pol?.signedInput) return table;

  const grid = table.grid;

  // Magnitude for currents/conductances, capacitances, and non-axis voltages.
  // Axis-name columns are skipped so the materialized axis column keeps matching
  // its (untouched) axis.
  const magKeys = new Set<string>([
    ...SIGNED_MAGNITUDE_KEYS,
    ...CAP_KEYS,
    ...VOLTAGE_KEYS,
  ]);
  const axisNames = new Set(grid.axes.map((ax) => ax.name));

  const nextQ = new Map<string, Float64Array>();
  for (const [key, col] of grid.quantities) {
    if (magKeys.has(key) && !axisNames.has(key)) nextQ.set(key, absCopy(col));
    else nextQ.set(key, col);
  }

  const nextGrid: Grid = {
    axes: grid.axes,
    shape: grid.shape,
    quantities: nextQ,
  };

  // Record that canonicalization ran: polarity stays, but the input is no longer
  // signed (it has been folded to magnitudes).
  const nextMeta: TableMeta = {
    ...table.meta,
    polarity: { device: pol.device, signedInput: false },
  };

  return {
    id: table.id,
    grid: nextGrid,
    meta: nextMeta,
    passthrough: table.passthrough,
  };
}

function absCopy(src: Float64Array): Float64Array {
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.abs(src[i]);
  return out;
}
