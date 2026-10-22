// Data-trust QA + sign canonicalization for device tables.
//
// validate() runs a set of cheap, deterministic sanity checks per L-slice and
// returns structured QAWarnings. canonicalizeTable() folds signed (PMOS) source
// conventions into magnitudes, recording the polarity that was applied.

import type { Axis, DeviceTable, Grid, Polarity, QAWarning, TableMeta } from '../types';
import type { CharacterizedDevice } from '../corners';
import {
  axisSignature,
  extraScalar,
  deviceIdentityOf,
  pdkOf,
  sameCondition,
  conditionKeyOf,
  conditionLabel,
} from '../corners';
import { DEFAULT_TEMP_C, PHYS, UT, kelvin } from '../constants';
import { strides } from '../grid';
import { HEADER_NAMES, unreadHeader, type ReadField } from '../parse';
import {
  DERIVED_FORMS,
  derivedFallbacks,
  derivedForm,
  metaScalars,
  noiseLabel,
  noiseSource,
  pointScope,
} from '../derive';
import { scalarScope } from '../expr';
import {
  AXIS_DEFAULT_BIAS,
  BASE_KEYS,
  BASE_QUANTITIES,
  DERIVED_QUANTITIES,
  MAGNITUDE_KEYS,
  engineNameReason,
  passthroughKeys,
  passthroughName,
} from '../namespace';

// --- physical thresholds -----------------------------------------------------

// Both gm/ID ceilings below are anchored at 27 °C and scaled to each table's
// temperature at the check site: the weak-inversion limit gm/ID → 1/(n·U_T) rises
// as it gets colder (U_T = kT/q ∝ T), so a fixed room-temperature ceiling would
// false-flag valid cold-corner data (gm/ID ~48 at −40 °C is physical).

/** Physical ceiling on gm/ID ≈ 1/U_T (weak-inversion limit) at 27 °C, in S/A. */
const GM_ID_CEILING = 1 / UT; // ~38.7 at 27 °C

/** gm/ID above this at 27 °C is almost certainly a unit error, not physics. */
const GM_ID_UNIT_ERROR = 45;

/** The coldest temperature [°C] a table is plausibly characterized at, for the gm/ID ceiling's
 *  other reading on a table whose temperature was assumed: a gm/ID that would need a colder one
 *  to be physical is a unit error whatever the temperature. Well below any qualification range. */
const COLDEST_PLAUSIBLE_C = -200;

/** Per-step vgs spacing above this (in volts) is coarse enough to warn. */
const VGS_STEP_WARN = 0.01; // 10 mV

/** Relative slack on that limit. A step is the difference of two decimal values held as binary
 *  floats, so an axis at exactly 10 mV measures a few ULP either side of 0.01 (0.07 − 0.06 is
 *  0.010000000000000009). One part in a million absorbs that at any vgs a table can hold while
 *  remaining far below any step an exporter actually chose. */
const VGS_STEP_TOL = 1e-6;

/** Plausible range for the thermal-noise factor γ; outside it is likely a unit/model error.
 *  The long-channel value is 2/3; short-channel devices run higher (hot-carrier / velocity
 *  saturation can reach ~2–3), so the ceiling is generous — it targets gross errors (γ stored
 *  as a percentage, or a wrong-model γ≈10) without flagging valid deep-submicron γ. */
const GAMMA_LO = 0.4;
const GAMMA_HI = 4.0;

/** How far apart, as a ratio, a stored γ column and the γ the stored sth gives may sit at the
 *  full-drive point before QA says so (rule `gamma-vs-sth`). The body factor 1 + gmb/gm a column
 *  built against gm alone carries runs 1.10 to 1.42 at full drive on the generated tables, so 1.5
 *  leaves that convention unflagged on its own and catches a column that is not this device's. */
const GAMMA_VS_STH = 1.5;

/** The band the thermal-noise factor γ the stored noise implies (the `gamma` definition,
 *  sth/(4kT·(gm + gmb)), or sth/(4kT·gm) on a table without gmb) has to fall in at a table's
 *  full-drive point (see fullDrive). Real devices spread wider there than the textbook suggests:
 *  across the generated sky130 and gf180 tables, every corner and temperature, it runs from 0.18
 *  (the 5 V pfet, cold) to 10.3 (the low-threshold nfet at the shortest length) — 0.22 to 11.4
 *  against gm alone, the body factor 1 + gmb/gm there being 1.10 to 1.42 — so a narrow band would
 *  flag good data. The unit slips this exists for are orders of magnitude (a µ-prefixed export is
 *  off by 1e6, a density left unsquared by about 1e12, a lost 4kT by about 1e20), and this is the
 *  window the table generator applies to its own output (read against gm alone there, which moves
 *  γ by far less than the window is wide), so the two agree on what a slip is. */
const NOISE_FACTOR_LO = 0.01;
const NOISE_FACTOR_HI = 100;

/** |vgs| above this (in volts) means the axis is probably in mV, not V. */
const VGS_UNIT_ERROR = 100;

/**
 * Per-point relative tolerance for stored gm vs a central-difference d(id)/d(vgs).
 * Deliberately generous: a coarse vgs grid gives the finite difference real O(h²)
 * truncation error (tens of % near threshold), so only a clear mismatch — a
 * mislabeled column or wrong units — should count, not discretization.
 */
const GM_FD_TOL = 0.5;

/**
 * A single vgs sweep trips gm-consistency when more than this fraction of its
 * interior points exceed GM_FD_TOL. A per-line fraction (not a slice-wide median)
 * is essential: a corrupted bias region must not be diluted by unrelated good
 * regions, and a fraction catches a whole-line/whole-plane error without needing a
 * majority of the entire slice.
 */
const GM_BAD_FRACTION = 0.34;

/** An id reversal counts only when the step exceeds this fraction of the line's id
 *  span — so sub-pA leakage/noise wiggles in the off region are not "glitches". */
const MONO_EPS = 1e-3;

/** The capacitances that are magnitudes (self-capacitances and junction capacitances), which the
 *  sign check below covers. The transcapacitances are not among them: their sign carries
 *  information, and taking the absolute value would lose it. Read from the namespace flag
 *  (BaseQuantity.magnitude), which is also what canonicalizeTable folds. */
const MAGNITUDE_CAP_KEYS: readonly string[] = BASE_QUANTITIES.filter(
  (q) => q.magnitude && q.unit === 'F',
).map((q) => q.key);
/** How the cap-sign finding names a capacitance that is not a node's self-capacitance. */
const CAP_NOUN: Readonly<Record<string, string>> = {
  cgg: 'the total gate capacitance',
  cjd: 'a junction capacitance',
  cjs: 'a junction capacitance',
};

/** Voltage axis/column keys (folded to |v| on signed input). */
const VOLTAGE_KEYS: readonly string[] = BASE_QUANTITIES.filter((q) => q.unit === 'V').map(
  (q) => q.key,
);

// --- grid helpers ------------------------------------------------------------

/** Index of a named axis in the grid, or -1 if absent. */
function axisIndex(grid: Grid, name: string): number {
  return grid.axes.findIndex((a) => a.name === name);
}

/**
 * Walk every L-slice. For each value on the `l` axis (or a single synthetic
 * slice if there is no `l` axis), invoke `fn` with the slice's index on the L
 * axis and the L value (NaN when absent).
 */
function forEachLSlice(grid: Grid, fn: (lIndex: number, lValue: number) => void): void {
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

/** Count column entries matching a predicate (shared by the cheap sign/positivity checks). */
function countWhere(col: Float64Array, pred: (x: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < col.length; i++) if (pred(col[i])) n++;
  return n;
}

/** A table's full-drive point: the shortest length, the largest gate-source and drain-source
 *  voltages in magnitude (a signed PMOS export sweeps them negative), and the source at the body
 *  (the vsb nearest 0). Any other axis is read at its first value. The flat index, and the point
 *  in words; undefined for a grid with no vgs axis. */
function fullDrive(grid: Grid): { at: number; where: string } | undefined {
  if (!grid.axes.some((a) => a.name === 'vgs')) return undefined;
  const st = strides(grid.shape);
  let at = 0;
  const where: string[] = [];
  grid.axes.forEach((a, d) => {
    const v = a.values;
    // Whether value `x` drives harder than the best so far, chosen once for the axis: the shortest
    // length, the largest gate and drain voltage, the body bias nearest 0, and the first node of
    // any other axis.
    const better: ((x: number, y: number) => boolean) | undefined =
      a.name === 'l'
        ? (x, y) => x < y
        : a.name === 'vgs' || a.name === 'vds'
          ? (x, y) => Math.abs(x) > Math.abs(y)
          : a.name === 'vsb'
            ? (x, y) => Math.abs(x) < Math.abs(y)
            : undefined;
    let best = 0;
    if (better) for (let i = 1; i < v.length; i++) if (better(v[i], v[best])) best = i;
    at += best * st[d];
    where.push(`${a.name} = ${v[best]}`);
  });
  return { at, where: where.join(', ') };
}

/**
 * Run data-trust checks on a device table. Pure: never mutates the table.
 * A check that reads an optional column the table lacks is skipped, and leaves a `not-checked`
 * information finding naming the column, so a skipped check never reads as a passed one. A check
 * of a column's own values (a sign, a range) has nothing to examine without that column, and
 * says nothing.
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

    // Monotonicity + step, once for the axis. The vgs axis is one shared values
    // array for the whole grid, so one defect is one finding attributed to the
    // axis (like the |vgs| ceiling above) — not repeated per L-slice.
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
        message: 'vgs axis is not strictly increasing',
        location: 'vgs',
      });
    }
    if (maxStep > VGS_STEP_WARN * (1 + VGS_STEP_TOL)) {
      // Enough decimals that the step shown is visibly past the limit: a 10.04 mV step at one
      // decimal would read "10.0 mV exceeds 10 mV".
      const mV = maxStep * 1e3;
      let digits = 1;
      while (digits < 6 && Number(mV.toFixed(digits)) <= VGS_STEP_WARN * 1e3) digits++;
      out.push({
        rule: 'vgs-step',
        severity: 'warning',
        message: `vgs step up to ${mV.toFixed(digits)} mV exceeds 10 mV`,
        location: 'vgs',
      });
    }
  }

  // --- gm/ID ceiling (needs gm and id columns) ---
  const gm = q.get('gm');
  const id = q.get('id');
  if (gm && id) {
    // Scale both 27 °C anchors by this table's temperature (1/U_T ∝ 1/T): rises
    // when colder, falls when hotter, and their ratio is preserved automatically.
    const tempC = table.meta.temp ?? DEFAULT_TEMP_C;
    // A temperature the table did not declare is the default, and the finding says so: a cold
    // characterization read at 27 °C can sit past these limits and be valid data.
    const assumed = table.meta.filled?.includes('temp') ?? false;
    const at = assumed ? `${tempC} °C (assumed: no readable # temp:)` : `${tempC} °C`;
    const scale = PHYS.T / kelvin(tempC); // 1 @27 °C, >1 colder, <1 hotter
    const ceiling = GM_ID_CEILING * scale; // ~38.7@27, ~49.8@−40, ~29.2@125
    const unitError = GM_ID_UNIT_ERROR * scale; // ~45@27, temp-scaled
    let maxGmId = 0;
    const n = Math.min(gm.length, id.length);
    for (let i = 0; i < n; i++) {
      const idv = id[i];
      if (idv === 0) continue; // undefined ratio; skip
      const r = Math.abs(gm[i] / idv);
      if (Number.isFinite(r) && r > maxGmId) maxGmId = r;
    }
    // On an assumed temperature the other reading is a colder characterization: the temperature
    // at or below which this gm/ID sits under the 1/U_T ceiling. Named, and the finding is no
    // stronger than a warning, unless no temperature a table is taken at reaches it.
    const coldest = (GM_ID_CEILING * PHYS.T) / maxGmId - 273.15;
    const plausible = assumed && coldest >= COLDEST_PLAUSIBLE_C;
    const otherwise = plausible
      ? ` — or a characterization at or below about ${Math.floor(coldest)} °C, where it is ` +
        `physical; declare # temp: to say which`
      : '';
    if (maxGmId > unitError) {
      out.push({
        rule: 'gm-id-ceiling',
        severity: plausible ? 'warning' : 'error',
        message: `max gm/ID ${maxGmId.toFixed(1)} S/A exceeds ${unitError.toFixed(1)} at ${at} — likely a unit error${otherwise}`,
        location: 'gm/id',
      });
    } else if (maxGmId > ceiling) {
      out.push({
        rule: 'gm-id-ceiling',
        severity: 'warning',
        message: `max gm/ID ${maxGmId.toFixed(1)} S/A exceeds the physical ceiling ~${ceiling.toFixed(1)} (1/U_T at ${at})${otherwise}`,
        location: 'gm/id',
      });
    }
  }

  // --- saturation: gds should fall as the device saturates ---
  // Walk gds along vds (preferred) or vgs within each L-slice; if it never
  // decreases anywhere in a slice the device may not reach saturation. Without a gds column, or
  // along a sweep of one value, the question is not asked — and the import says so.
  const gds = q.get('gds');
  const SATURATION = 'whether the device reaches saturation (gds falling along its sweep)';
  if (!gds) out.push(notChecked(SATURATION, 'gds', 'the table has no gds column'));
  else {
    const sweepName = axisIndex(grid, 'vds') >= 0 ? 'vds' : 'vgs';
    const along = grid.axes[axisIndex(grid, sweepName)];
    if (along && along.values.length < 2)
      out.push(notChecked(SATURATION, sweepName, `the table holds ${sweepName} at a single value`));
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

  // --- non-finite islands: any NaN/Inf poisons interpolation downstream ---
  for (const [key, col] of q) {
    let bad = 0;
    for (let i = 0; i < col.length; i++) if (!Number.isFinite(col[i])) bad++;
    if (bad > 0) {
      out.push({
        rule: 'non-finite',
        severity: 'error',
        message: `${key} has ${bad} non-finite value(s) (NaN/Inf)`,
        location: key,
      });
    }
  }

  // --- a column that is zero wherever the device conducts ---
  // An exporter writes 0 for an operating-point quantity its model does not provide, and the zeros
  // import as a measured value: a capacitance of 0 at every point makes fT infinite everywhere, and
  // nothing else would say so. A quantity is never exactly 0 at every point where drain current
  // flows, so such a column is reported — named, with what reads it. Zeros where no current flows
  // are legitimate (flicker noise written as 0 at id = 0), so only conducting points count, and a
  // table that conducts nowhere is left to the other checks. The noise PSDs and a stored gamma are
  // judged by their own checks (noise-psd, gamma-range), which already flag a zero.
  out.push(...zeroColumns(table));

  // --- magnitude / positivity checks ---
  // gm and gds are reported as magnitudes; a self-capacitance (cgg, cdd, css, cbb) and a
  // junction capacitance must be non-negative. A signed PMOS dump trips these until
  // canonicalization folds it to magnitude. The transcapacitances are deliberately NOT checked
  // — they are legitimately negative under some exporters' conventions and in some regions.
  const signCheck = (
    col: Float64Array | undefined,
    rule: string,
    label: string,
    why: string,
  ): void => {
    if (!col) return;
    const neg = countWhere(col, (x) => x < 0);
    if (neg > 0)
      out.push({
        rule,
        severity: 'warning',
        message: `${label} has ${neg} negative value(s) — ${why}`,
        location: label,
      });
  };
  signCheck(
    gm,
    'gm-sign',
    'gm',
    'expected a magnitude (a signed PMOS dump needs sign canonicalization first)',
  );
  signCheck(
    gds,
    'gds-sign',
    'gds',
    'expected a magnitude (a signed PMOS dump needs canonicalization first)',
  );
  // gmb adds to gm in the channel's noise conductance, so a negative one lowers every γ-model
  // noise figure (vnth_m, svth_m) where γ is not read back from sth.
  signCheck(
    q.get('gmb'),
    'gmb-sign',
    'gmb',
    'expected a magnitude (a signed PMOS dump needs canonicalization first); it adds to gm in ' +
      'the thermal noise floor, which a negative one lowers',
  );
  for (const key of MAGNITUDE_CAP_KEYS)
    signCheck(
      q.get(key),
      'cap-sign',
      key,
      `${CAP_NOUN[key] ?? 'a self-capacitance'} should be a magnitude`,
    );

  // A non-positive sth/sfl poisons every input-referred noise quantity (sqrt of ≤0, or a 0 in fco).
  // Flicker noise is the exception where no current flows: a simulator gives exactly 0 at
  // vds = 0, and a table that sweeps the drain voltage from 0 carries those points. A zero sth
  // is never physical (the channel's thermal noise does not vanish at zero current).
  const idCol = q.get('id');
  for (const key of ['sth', 'sfl'] as const) {
    const col = q.get(key);
    if (!col) continue;
    let bad = 0;
    for (let i = 0; i < col.length; i++) {
      const x = col[i];
      if (x > 0) continue;
      if (key === 'sfl' && x === 0 && idCol !== undefined && idCol[i] === 0) continue;
      bad++;
    }
    if (bad > 0) {
      out.push({
        rule: 'noise-psd',
        severity: 'error',
        message:
          `${key} has ${bad} non-positive value(s) — a noise PSD must be > 0` +
          (key === 'sfl' ? ' (except flicker noise where the drain current is exactly 0)' : ''),
        location: key,
      });
    }
  }

  // γ outside a physical band (long-channel 2/3; short-channel runs higher) is likely a unit/model error.
  const gammaCol = q.get('gamma');
  if (gammaCol) {
    const oob = countWhere(gammaCol, (g) => Number.isFinite(g) && (g < GAMMA_LO || g > GAMMA_HI));
    if (oob > 0) {
      out.push({
        rule: 'gamma-range',
        severity: 'warning',
        message: `gamma has ${oob} value(s) outside [${GAMMA_LO}, ${GAMMA_HI}] — likely a unit or model error`,
        location: 'gamma',
      });
    }
  }

  // --- the γ the stored thermal noise implies, read at full drive ---
  // Every thermal-noise figure on a table that stores `sth` is read from it (see noiseSource), so a
  // unit error there ships as measured noise. The γ it implies varies a great deal over the grid —
  // in triode gm falls while the channel noise does not, so γ runs far past any plausible band
  // there, and it is infinite where gm is 0 — so it is read at ONE point where the device is
  // unambiguously saturated and strongly inverted — the point the table generator checks its own
  // output at — and nowhere else.
  // γ is read by its own definition (and its fallback where the table has no gmb), from the stored
  // sth even where a `gamma` column stands beside it — the column is not what is being checked.
  const sth = q.get('sth');
  const drive = sth && gm ? fullDrive(grid) : undefined;
  if (sth && gm && drive) {
    const gmb = q.get('gmb');
    const at: Record<string, number> = {
      ...metaScalars(table.meta),
      sth: sth[drive.at],
      gm: gm[drive.at],
      ...(gmb ? { gmb: gmb[drive.at] } : {}),
    };
    const has = (n: string): boolean => Object.prototype.hasOwnProperty.call(at, n);
    const form = derivedForm('gamma', has)?.compiled.src;
    const g = pointScope(at).resolve('gamma') as number;
    if (Number.isFinite(g) && (g < NOISE_FACTOR_LO || g > NOISE_FACTOR_HI)) {
      out.push({
        rule: 'noise-factor',
        severity: 'warning',
        message:
          `the stored thermal noise (sth) gives γ = ${form} = ${g.toPrecision(3)} at the ` +
          `table's full-drive point (${drive.where}), outside [${NOISE_FACTOR_LO}, ` +
          `${NOISE_FACTOR_HI}], far past any transistor in saturation, so sth is probably in ` +
          `the wrong unit — and every thermal-noise figure on this table is read from it`,
        location: 'sth',
      });
    }
    // A stored γ column wins over the γ sth gives, so where both are stored they have to tell the
    // same story; past a factor of GAMMA_VS_STH apart at full drive one of them is not this
    // device's noise. The usual cause is a column computed against gm alone, which the γ-model
    // reads against gm + gmb.
    const stored = gammaCol?.[drive.at];
    if (
      stored !== undefined &&
      stored > 0 &&
      Number.isFinite(stored) &&
      g > 0 &&
      Number.isFinite(g)
    ) {
      const apart = Math.max(stored / g, g / stored);
      if (apart > GAMMA_VS_STH) {
        out.push({
          rule: 'gamma-vs-sth',
          severity: 'warning',
          message:
            `the stored gamma column reads ${stored.toPrecision(3)} at the table's full-drive ` +
            `point (${drive.where}), where the stored thermal noise gives γ = ${form} = ` +
            `${g.toPrecision(3)}, ${apart.toPrecision(2)}× apart — the column wins, so every ` +
            `thermal-noise figure on this table follows it rather than sth` +
            (gmb ? '; a column built against gm alone reads high by 1 + gmb/gm' : ''),
          location: 'gamma',
        });
      }
    }
  }

  // --- id monotonic in vgs + stored gm consistent with d(id)/d(vgs) ---
  // The headline trust check: gm IS the vgs-derivative of id, so a central
  // difference must track the stored column. Evaluated PER SWEEP LINE (each fixed
  // (vds, vsb, …) within the L-slice), compared MAGNITUDE-to-magnitude so a signed
  // PMOS sweep (signed vgs axis, magnitude id/gm) is not falsely flagged, and gated
  // on a per-line bad-FRACTION so a single corrupted bias plane is not diluted by
  // unrelated good regions (a slice-wide median would hide it).
  if (gm && id) {
    forEachLSlice(grid, (lIndex, lValue) => {
      const sl = sliceIndices(grid, lIndex, 'vgs');
      if (!sl) return;
      const vgs = sl.along.values;

      let glitch = false; // some single line both rises and falls along vgs
      let worstBadFrac = 0; // worst per-line fraction of gm/FD mismatches
      for (const line of sl.indices) {
        // id-monotonicity, per line, with an absolute floor scaled to the line.
        let maxAbsId = 0;
        for (const idx of line) maxAbsId = Math.max(maxAbsId, Math.abs(id[idx]));
        const floor = maxAbsId * MONO_EPS;
        let up = false;
        let down = false;
        for (let j = 1; j < line.length; j++) {
          const d = id[line[j]] - id[line[j - 1]];
          if (Math.abs(d) > floor) {
            if (d > 0) up = true;
            else down = true;
          }
        }
        if (up && down) glitch = true;

        // gm vs central-difference d(id)/d(vgs), magnitude-to-magnitude.
        let bad = 0;
        let total = 0;
        for (let j = 1; j < line.length - 1; j++) {
          const dv = vgs[j + 1] - vgs[j - 1];
          if (dv <= 0) continue;
          const gmFd = Math.abs((id[line[j + 1]] - id[line[j - 1]]) / dv);
          const gmStored = Math.abs(gm[line[j]]);
          const denom = Math.max(gmStored, gmFd);
          if (denom <= 0) continue;
          total++;
          if (Math.abs(gmStored - gmFd) / denom > GM_FD_TOL) bad++;
        }
        if (total > 0) worstBadFrac = Math.max(worstBadFrac, bad / total);
      }

      if (glitch) {
        out.push({
          rule: 'id-non-monotonic',
          severity: 'warning',
          message: `id both rises and falls along a vgs sweep in ${fmtL(lValue)} — likely a glitch`,
          location: `id @ ${fmtL(lValue)}`,
        });
      }
      if (worstBadFrac > GM_BAD_FRACTION) {
        out.push({
          rule: 'gm-consistency',
          severity: 'warning',
          message: `stored gm differs from d(id)/d(vgs) on ${(worstBadFrac * 100).toFixed(0)}% of a vgs sweep in ${fmtL(lValue)} — gm may be mislabeled, in wrong units, or the vgs grid too coarse`,
          location: `gm @ ${fmtL(lValue)}`,
        });
      }
    });
  }

  // --- what the table can be used for: the sweeps it does not carry ---
  // Information, not a defect: a table taken at one drain voltage, at one length, or with the
  // source tied to the body, is valid data and plots as it is. What it cannot do is answer for a
  // point it was not taken at, and a design sheet refuses to size a device that asks it to.
  // A table with no vds column records no drain voltage at all, and every device on a sheet
  // states one, so no sheet sizes a device from it.
  // Saying so here puts the limit in front of whoever imports the table, before a sheet is the
  // first to mention it. Never raised on a table that sweeps the axis, whatever the sweep's sign.
  const unswept = (axis: string): string | undefined => {
    const own = grid.axes.find((a) => a.name === axis);
    if (!own) return `no ${axis} column`;
    return own.values.length === 1 ? `a single value, ${axis} = ${own.values[0]}` : undefined;
  };
  const noL = unswept('l');
  if (noL !== undefined) {
    out.push({
      rule: 'no-l-sweep',
      severity: 'info',
      message:
        `the table has no length sweep (${noL}): it plots, ` +
        (axisIndex(grid, 'l') < 0
          ? `but no device can be sized from it`
          : `and a design sheet sizes a device from it at that length only`),
      location: 'l',
    });
  }
  const noVds = unswept('vds');
  if (noVds !== undefined) {
    out.push({
      rule: 'no-vds-sweep',
      severity: 'info',
      message:
        `the table has no vds sweep (${noVds}): it plots, but ` +
        (axisIndex(grid, 'vds') < 0
          ? `no design sheet can size a device from it — every device on a sheet states its ` +
            `drain voltage, and nothing records the one this table was taken at`
          : `a device that a design sheet gives any other drain voltage, or connects as a ` +
            `diode, cannot be sized from it`),
      location: 'vds',
    });
  }
  const noVsb = unswept('vsb');
  if (noVsb !== undefined) {
    const grounded = AXIS_DEFAULT_BIAS.get('vsb');
    const at = grid.axes.find((a) => a.name === 'vsb')?.values[0];
    out.push({
      rule: 'no-vsb-sweep',
      severity: 'info',
      message:
        at === undefined && grounded !== undefined
          ? `the table has no vsb sweep (${noVsb}), so it is taken as characterized with the ` +
            `source tied to the body, vsb = ${grounded}: it plots, but a device whose source a ` +
            `design sheet puts above its body cannot be sized from it`
          : `the table has no vsb sweep (${noVsb}): it plots, but a device that a design sheet ` +
            `gives any other body bias cannot be sized from it` +
            // Left out, a body bias means the default — which this table was not taken at.
            (at !== grounded ? `, and a sheet that leaves the body bias out has to state it` : ''),
      location: 'vsb',
    });
  }

  // --- a stored column that shadows a standard derived quantity ---
  // Unknown columns pass through on import (the strict-superset rule), so an export can
  // carry its own `ft`/`gm_gds`/`gm_id` alongside the raw quantities they are computed
  // from. Nothing here repairs that — but the two are read by different code: expression
  // scopes prefer the stored column, while the operating-point path (the forward lookup, which
  // interpolates base columns only, and the sizer, which re-derives at the sized width) computes
  // from the definition, so a chart and a sizing can disagree without either being wrong. Naming
  // the column is the only way the difference is ever visible.
  // A base quantity the namespace also knows how to derive (`gamma`, which it reads from `sth`)
  // is no shadow: a stored column of it is the documented input, read as stored by the charts and
  // the operating-point path alike, so nothing disagrees.
  // The form quoted is the one the operating-point path uses on this table, which reads base
  // columns and metadata only: a fallback where the table lacks a column the definition reads.
  const scalars = metaScalars(table.meta);
  const opPath = (n: string): boolean =>
    (BASE_KEYS.has(n) && q.has(n)) || Object.prototype.hasOwnProperty.call(scalars, n);
  for (const def of DERIVED_QUANTITIES) {
    if (!q.has(def.key) || BASE_KEYS.has(def.key)) continue;
    const form = derivedForm(def.key, opPath)?.compiled.src ?? def.expr;
    out.push({
      rule: 'derived-shadow',
      severity: 'warning',
      symbol: def.key,
      message: `the table stores a "${def.key}" column, which shadows the quantity computed from ${form} — charts and expressions read the stored column, while an operating-point lookup and a sizing compute it from that form, so the two disagree if this column was made a different way; drop or rename it to remove the ambiguity`,
      location: def.key,
    });
  }

  // --- columns with no name in the namespace ---
  // The namespace names every quantity it knows how to treat. Any other column is kept under its
  // own name, so nothing in the file is lost, but nothing here knows how it scales or what sign
  // it takes. It is reported once, as information, so that a standard quantity this exporter
  // names differently is noticed instead of going unscaled. A column named like a derived
  // quantity is reported above instead. One whose name the engine already means something by is
  // read under its affixed name everywhere (passthroughName), and the finding names it.
  const unnamed = passthroughKeys(table.grid);
  if (unnamed.length) {
    const listed = unnamed.map((c) => {
      const why = engineNameReason(c);
      return why ? `${c} (read as ${passthroughName(c)}: ${why})` : c;
    });
    out.push({
      rule: 'passthrough-columns',
      severity: 'info',
      message:
        `carried as-is, not recognized: ${listed.join(', ')} — kept under ` +
        `${unnamed.length > 1 ? 'their own names' : 'its own name'}, and can be charted, looked ` +
        `up and read by a design sheet, but ${unnamed.length > 1 ? 'they are' : 'it is'} not ` +
        `rescaled when a device is sized, not folded for a signed PMOS export, and not checked`,
      location: unnamed.join(', '),
    });
  }

  out.push(...filledFindings(table), ...unreadableHeaders(table), ...idSign(table));
  return out;
}

/** Columns another check already judges for a zero (see zeroColumns). */
const ZERO_JUDGED_ELSEWHERE: ReadonlySet<string> = new Set(['id', 'sth', 'sfl', 'gamma']);

/**
 * Every standard quantity column of `table` that is exactly 0 at every point carrying drain current
 * (at least one does), as a `zero-column` warning naming the column, the derived quantities whose
 * definition reads it, and those of them it makes infinite (a definition dividing by it). Axis
 * columns, pass-through columns (not checked, see passthrough-columns) and the columns in
 * ZERO_JUDGED_ELSEWHERE are left out.
 */
function zeroColumns(table: DeviceTable): QAWarning[] {
  const q = table.grid.quantities;
  const id = q.get('id');
  if (!id) return [];
  const conducting: number[] = [];
  for (let i = 0; i < id.length; i++) if (id[i] !== 0) conducting.push(i);
  if (!conducting.length) return [];
  const axes = new Set(table.grid.axes.map((a) => a.name));
  const out: QAWarning[] = [];
  for (const [key, col] of q) {
    if (!BASE_KEYS.has(key) || axes.has(key) || ZERO_JUDGED_ELSEWHERE.has(key)) continue;
    if (!conducting.every((i) => col[i] === 0)) continue;
    const readers: string[] = [];
    const infinite: string[] = [];
    for (const [derived, forms] of DERIVED_FORMS) {
      const form = forms.find((f) => f.compiled.names.includes(key));
      if (!form) continue;
      readers.push(derived);
      // Every other name it reads at 1 and this column at 0: a definition that divides by it
      // comes out non-finite whatever the other values are.
      const at: Record<string, number> = {};
      for (const n of form.compiled.names) at[n] = n === key ? 0 : 1;
      const v = form.compiled.eval(scalarScope(at));
      if (typeof v === 'number' && !Number.isFinite(v)) infinite.push(derived);
    }
    const list = (xs: string[]): string =>
      xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0];
    const rest = readers.filter((r) => !infinite.includes(r));
    const reads = [
      ...(infinite.length
        ? [`${list(infinite)} ${infinite.length > 1 ? 'are' : 'is'} infinite on it`]
        : []),
      ...(rest.length ? [`${list(rest)} ${rest.length > 1 ? 'read' : 'reads'} it`] : []),
    ];
    out.push({
      rule: 'zero-column',
      severity: 'warning',
      message:
        `${key} is 0 at every point that carries drain current — an exporter writes 0 for a ` +
        `quantity its model does not provide, so this column is probably not data` +
        (reads.length ? `; ${reads.join(', and ')}` : ''),
      location: key,
    });
  }
  return out;
}

/**
 * A check `validate` could not run because the table lacks what it reads (`column`, and `why` in
 * words): an information finding, so a skipped check is never read as a passed one.
 */
const notChecked = (check: string, column: string, why: string): QAWarning => ({
  rule: 'not-checked',
  severity: 'info',
  message: `not checked: ${check} — ${why}`,
  location: column,
});

/** What filled-in temperature the figures on a table assume, the words several findings share. */
const ASSUMED_TEMP_CONSEQUENCE =
  `kT (the thermal noise, the γ read back from sth, kT/C), the gm/ID ceiling checked here and ` +
  `the condition it is grouped and labelled under all assume it, and every sizing on it says so`;

/**
 * The identity fields the importer filled in (TableMeta.filled), one information finding each.
 * A filled-in field reads like a declared one wherever the table's identity is read, so this is
 * where the import says it was assumed, and what rests on it. A temperature filled in because
 * its header could not be read is said by that header's own finding (unreadableHeaders), which
 * names what the file held instead of saying it declared none.
 */
function filledFindings(table: DeviceTable): QAWarning[] {
  return (table.meta.filled ?? []).flatMap((field): QAWarning[] => {
    if (field === 'temp')
      return unreadHeader(table.meta, 'temp')
        ? []
        : [
            {
              rule: 'no-temp',
              severity: 'info',
              message:
                `the table declares no temperature (# temp:), so it is read at ` +
                `${table.id.temp} °C: ${ASSUMED_TEMP_CONSEQUENCE}`,
              location: 'temp',
            },
          ];
    if (field === 'corner')
      return [
        {
          rule: 'no-corner',
          severity: 'info',
          message:
            `the table declares no corner (# corner:), so it is taken as "${table.id.corner}": ` +
            `it is grouped and labelled as that condition of its device, every sizing on it says ` +
            `so, and it is the automatic nominal only when no condition of its device is declared`,
          location: 'corner',
        },
      ];
    return [
      {
        rule: 'no-device',
        severity: 'info',
        message:
          `the table declares no device name (# device:), so it is named "${table.id.device}", ` +
          `from its file name (or "dev0" without one): tables are grouped into one device by ` +
          `that name, so a renamed file groups differently`,
        location: 'device',
      },
    ];
  });
}

/**
 * For each field read from a header, what the header must hold, whether a header the importer
 * could not read leaves the field unread (`missing`: the field has no value from any other
 * header of the file), and what that costs. The temperature, the width and the polarity change
 * what every figure on the table means or whether a device can be sized from it at all, so an
 * unreadable one is a warning; the matching coefficients and the flicker corner are the Sizer's
 * inputs, with a placeholder it shows as one.
 */
const HEADER_READING: Readonly<
  Record<ReadField, { expected: string; unread: string; severity: 'warning' | 'info' }>
> = {
  temp: {
    expected: 'a number in °C (27, not 27C or 300K)',
    unread: `the table is read at ${DEFAULT_TEMP_C} °C: ${ASSUMED_TEMP_CONSEQUENCE}`,
    severity: 'warning',
  },
  W: {
    expected: 'a number in metres (1e-6, not 1u)',
    unread: 'the characterization width is unknown, so no device can be sized from the table',
    severity: 'warning',
  },
  polarity: {
    expected: 'one of n, p, nmos, pmos, nch, pch, nfet, pfet, nmosfet, pmosfet',
    unread:
      'the table declares no polarity: a signed p-channel export is not folded to magnitudes, ' +
      'its channel type is unknown when it is grouped, and no device is sized from it until the ' +
      'header says n or p',
    severity: 'warning',
  },
  AVT: {
    expected: 'a number in V·m (3.5e-9 for 3.5 mV·µm)',
    unread: 'the sizer’s matching budget uses its generic A_Vth instead',
    severity: 'info',
  },
  ABETA: {
    expected: 'a number in metres (2e-8 for 2 %·µm)',
    unread: 'the sizer’s matching budget uses its generic A_β instead',
    severity: 'info',
  },
  FCO: {
    expected: 'a number in Hz (2e6, not 2meg)',
    unread: 'the sizer does not read it as the 1/f corner',
    severity: 'info',
  },
};

/** The value a field was read at from another header of the same file, when it was. */
const readValue = (meta: TableMeta, field: ReadField): string | undefined => {
  if (field === 'polarity') return meta.polarity?.device;
  const v = meta[field];
  return v === undefined ? undefined : String(v);
};

/**
 * Recognized headers whose value the importer could not read. The parser keeps each in `extra`
 * as written (a recognized header is only there when its value was unreadable), so nothing is
 * lost; this names the header, what it holds, what it should hold and what goes unread. Where
 * another header of the same file gave the field its value (`# temp: 85` beside `# temp: 85C`),
 * nothing goes unread, and the finding says which value was read instead.
 */
function unreadableHeaders(table: DeviceTable): QAWarning[] {
  return Object.entries(table.meta.extra ?? {}).flatMap(([key, value]): QAWarning[] => {
    const field = (Object.keys(HEADER_NAMES) as ReadField[]).find((f) =>
      (HEADER_NAMES[f] as readonly string[]).includes(key.toLowerCase()),
    );
    if (!field) return [];
    const reading = HEADER_READING[field];
    const read = readValue(table.meta, field);
    const said = `its # ${key}: header reads "${value}", which could not be read — it should be ${reading.expected}; it is kept as written`;
    return [
      read === undefined
        ? {
            rule: 'unreadable-header',
            severity: reading.severity,
            message: `${said}, so ${reading.unread}`,
            location: key,
          }
        : {
            rule: 'unreadable-header',
            severity: 'info',
            message: `${said}, and the value is read from another header of the file instead (${read})`,
            location: key,
          },
    ];
  });
}

/**
 * A signed p-channel export read as magnitudes: the drain current is negative over most of the
 * table, which only a p-channel export written in the signed convention produces, and the table
 * declares no polarity that would fold it (none, or one the importer could not read). Every
 * figure is then of the wrong sign — gm/ID negative everywhere — so it is named here, with the
 * header that would settle it. Leakage-level negatives near zero current on an n-channel table
 * are not this: the finding needs most nonzero samples negative.
 */
function idSign(table: DeviceTable): QAWarning[] {
  if (table.meta.polarity) return [];
  const id = table.grid.quantities.get('id');
  if (!id) return [];
  let neg = 0;
  let nonzero = 0;
  for (let i = 0; i < id.length; i++) {
    if (id[i] === 0 || !Number.isFinite(id[i])) continue;
    nonzero++;
    if (id[i] < 0) neg++;
  }
  if (nonzero === 0 || neg * 2 <= nonzero) return [];
  const unread = unreadHeader(table.meta, 'polarity');
  const why = unread
    ? `its # ${unread[0]}: header reads "${unread[1]}", which could not be read as a channel type`
    : 'the table declares no polarity (# polarity:)';
  return [
    {
      rule: 'id-sign',
      severity: 'warning',
      message:
        `id is negative at ${neg} of ${nonzero} points — a signed p-channel export, read as ` +
        `magnitudes because ${why}: every figure on it has the wrong sign; write # polarity: p`,
      location: 'id',
    },
  ];
}

// --- device QA ---------------------------------------------------------------

/** The distinct values of one per-table fact across a device, each with the conditions that
 *  carry it. One entry means the device's tables agree; more means it does not, and the map already
 *  says which corner is the odd one out. */
function byFact(
  conditions: readonly DeviceTable[],
  fact: (t: DeviceTable) => string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of conditions) {
    const key = fact(t);
    const label = conditionLabel(t);
    const labels = out.get(key);
    if (labels) labels.push(label);
    else out.set(key, [label]);
  }
  return out;
}

/** A disagreement spelled out as `tt, ff: <value>; ss@-40: <other>`. */
function describe(groups: Map<string, string[]>): string {
  return [...groups].map(([v, labels]) => `${labels.join(', ')}: ${v === '' ? '—' : v}`).join('; ');
}

/** One axis as a range and a sample count. */
function axisSummary(axis: Axis): string {
  const v = axis.values;
  return `${axis.name} ${v[0]?.toExponential(3) ?? '—'}…${v[v.length - 1]?.toExponential(3) ?? '—'} (${v.length})`;
}

/**
 * Data-trust checks ACROSS one characterized device — the questions that only exist once several
 * tables claim to be one device. Pure, and warn-never-fix like every other check here: a
 * device is never repaired, reordered, resampled, or silently split.
 *
 * Error severity marks a device nothing should project from, and projection independently
 * enforces both cases: an ambiguous condition (`tableAt` refuses that condition) and
 * conditions that do not even sweep the same axes (`runCondition` refuses the whole device — a
 * sheet pinned on one is not pinned on the other, compared here and there through the one
 * `axisSignature`). Everything else is a warning, because coverage IS legitimately
 * corner-specific — a slow corner characterized over a shorter vgs range is ordinary, not a
 * defect — and gating on it would refuse valid data.
 */
export function validateDeviceConditions(f: CharacterizedDevice): QAWarning[] {
  const out: QAWarning[] = [];
  const conditions = f.conditions;

  for (const key of f.duplicates) {
    const n = conditions.filter((t) => sameCondition(conditionKeyOf(t.id), key)).length;
    const label = conditionLabel(key);
    out.push({
      rule: 'device-duplicate-condition',
      severity: 'error',
      message: `${n} loaded tables claim "${f.device}" at ${label} — nothing evaluates at an ambiguous condition; remove one or replace it explicitly`,
      location: label,
    });
  }
  if (conditions.length < 2) return out;

  const axisSets = byFact(conditions, axisSignature);
  if (axisSets.size > 1) {
    out.push({
      rule: 'device-axes',
      severity: 'error',
      message: `conditions of "${f.device}" sweep different axes — ${describe(axisSets)} — a design fixed on one is not fixed on the other`,
      location: f.device,
    });
  } else {
    // Compared on the sample points themselves, reported as ranges: two sweeps can share
    // their endpoints and their count and still sit on different points (a log spacing
    // against a linear one), and a summary-only comparison would call those identical.
    const lattices = byFact(conditions, (t) =>
      t.grid.axes.map((a) => `${a.name}:${a.values.join(',')}`).join(' | '),
    );
    if (lattices.size > 1) {
      out.push({
        rule: 'device-sweep-range',
        severity: 'warning',
        message: `conditions of "${f.device}" were swept over different ranges, step sizes or sample points — ${describe(byFact(conditions, (t) => t.grid.axes.map(axisSummary).join(' | ')))} — each table is read as imported, so an operating point reachable at one condition may be out of range at another`,
        location: f.device,
      });
    }
  }

  const widths = byFact(conditions, (t) =>
    t.meta.W === undefined ? '' : t.meta.W.toExponential(3),
  );
  if (widths.size > 1) {
    out.push({
      rule: 'device-width',
      severity: 'warning',
      message: `conditions of "${f.device}" were characterized at different widths — ${describe(widths)} — sizing rescales from each table's own width, so compare the sized results, not the raw columns`,
      location: f.device,
    });
  }

  // Non-axis columns only: the grid materializes every axis as a column too, and an axis
  // difference is the check above's finding, not a second one about quantities.
  const columns = byFact(conditions, (t) => {
    const axes = new Set(t.grid.axes.map((a) => a.name));
    return [...t.grid.quantities.keys()]
      .filter((k) => !axes.has(k))
      .sort()
      .join(', ');
  });
  if (columns.size > 1) {
    // A missing column is not always a gap: a quantity with a lesser form (the γ-model noise
    // without sth or gmb) is read by it at that condition instead, and says so on its noise line.
    // Which conditions read which is spelled out when they differ.
    const noise = byFact(conditions, (t) =>
      noiseLabel(noiseSource(t.grid), derivedFallbacks(t.grid, metaScalars(t.meta))),
    );
    out.push({
      rule: 'device-quantities',
      severity: 'warning',
      message:
        `conditions of "${f.device}" carry different quantity columns — ${describe(columns)} — ` +
        `author math that reads a column one of them lacks goes na at that condition` +
        (noise.size > 1
          ? `, and the thermal-noise figures fall back where a column they read is missing ` +
            `(noise: ${describe(noise)})`
          : ''),
      location: f.device,
    });
  }

  // Provenance says two different things depending on whether the process namespace is
  // declared. Undeclared, it is the only evidence about IDENTITY — whether these tables are
  // one device at all. Declared, identity is settled and a simulator difference is a fact
  // about the DATA. One fact, one warning. The branch reads the whole device, not one member:
  // grouping joins an undeclared member to a declared sibling, so a device can mix the two —
  // and any undeclared member means its membership was INFERRED, which is exactly when the
  // identity evidence must stay visible, whichever file the user happened to import first.
  if (conditions.some((t) => pdkOf(t) === '')) {
    const provenance = byFact(conditions, (t) =>
      [extraScalar(t, 'source') ?? '', t.meta.simulator ?? '', t.meta.date ?? '']
        .filter((s) => s !== '')
        .join(' / '),
    );
    if (provenance.size > 1) {
      out.push({
        rule: 'device-provenance',
        severity: 'warning',
        message: `"${f.device}" was grouped by device name alone and its conditions record different provenance — ${describe(provenance)} — declare "# pdk:" in the exports to confirm these are one device or to separate them`,
        location: f.device,
      });
    }
  } else {
    const simulators = byFact(conditions, (t) => t.meta.simulator ?? '');
    if (simulators.size > 1) {
      out.push({
        rule: 'device-simulator',
        severity: 'warning',
        message: `conditions of "${f.device}" were characterized with different simulators — ${describe(simulators)}`,
        location: f.device,
      });
    }
  }

  return out;
}

/**
 * Data-trust checks ACROSS devices — the split question `validateDeviceConditions` cannot see,
 * because it holds one device at a time. Grouping resolves an under-declared identity (blank `pdk`,
 * undeclared polarity) into the unique declared candidate for the same device name; when
 * several candidates make that join a guess, it refuses — and a refused join is as invisible
 * per-device as a wrong one, so it is warned about here, naming the header that would settle
 * it. Fully declared same-name devices are legitimate (two PDKs both shipping an `nch`) and
 * stay silent. Warn, never fix: nothing is ever joined or split by this check.
 */
export function validateDevices(devices: readonly CharacterizedDevice[]): QAWarning[] {
  const byName = new Map<string, CharacterizedDevice[]>();
  for (const f of devices) {
    const id = deviceIdentityOf(f.deviceUid);
    if (!id) continue;
    const list = byName.get(id.device) ?? [];
    list.push(f);
    byName.set(id.device, list);
  }
  const out: QAWarning[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    // Only a header that is declared in one device and undeclared in another is a split
    // cause: undeclared-everywhere groups fine, and declared-everywhere is a real difference.
    const ids = group.map((f) => deviceIdentityOf(f.deviceUid)!);
    const varies: string[] = [];
    if (ids.some((id) => id.pdk === '') && ids.some((id) => id.pdk !== '')) varies.push('# pdk:');
    if (ids.some((id) => id.polarity === 'unknown') && ids.some((id) => id.polarity !== 'unknown'))
      varies.push('# polarity:');
    if (!varies.length) continue;
    out.push({
      rule: 'device-split',
      severity: 'warning',
      message: `${group.length} device groups share the name "${name}" and one of them declares no full identity — they stay separate because joining would be a guess; declare ${varies.join(' and ')} in the exports to say which device each file is`,
      location: name,
    });
  }
  return out;
}

// --- canonicalization --------------------------------------------------------

/**
 * Fold signed (e.g. PMOS) source conventions into magnitudes. When
 * meta.polarity.signedInput is set, replace every magnitude quantity (BaseQuantity.magnitude:
 * id/gm/gds/gmb, the self-capacitances cgg/cdd/css/cbb and the junction capacitances cjd/cjs)
 * and the NON-AXIS voltages (vth, vdsat) with |value|, and record the polarity. The
 * transcapacitances and the terminal charges are left signed. Sweep
 * AXES are left untouched: a signed sweep is still ascending and valid, and the
 * data row order already matches it — abs-ing + re-sorting an axis without
 * reindexing the data would corrupt the mapping. |V| axis presentation, if ever
 * wanted, belongs at parse time pre-grid (see the vbs sign-flip in parse).
 */
export function canonicalizeTable(table: DeviceTable): DeviceTable {
  const pol: Polarity | undefined = table.meta.polarity;
  if (!pol?.signedInput) return table;

  const grid = table.grid;

  // Magnitude for currents/conductances, the self- and junction capacitances, and
  // non-axis voltages. Axis-name columns are skipped so the materialized axis
  // column keeps matching its (untouched) axis.
  const magKeys = new Set<string>([...MAGNITUDE_KEYS, ...VOLTAGE_KEYS]);
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
