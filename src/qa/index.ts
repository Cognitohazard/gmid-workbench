// Data-trust QA + sign canonicalization for device tables.
//
// validate() runs a set of cheap, deterministic sanity checks per L-slice and
// returns structured QAWarnings. canonicalizeTable() folds signed (PMOS) source
// conventions into magnitudes, recording the polarity that was applied.

import type { Axis, DeviceTable, Grid, Polarity, QAWarning, TableMeta } from '../types';
import type { CornerFamily } from '../corners';
import {
  axisSignature,
  extraScalar,
  familyIdentityOf,
  pdkOf,
  sameVariant,
  variantKeyOf,
  variantLabel,
} from '../corners';
import { PHYS, UT, kelvin } from '../constants';
import { strides } from '../grid';
import { BASE_QUANTITIES, DERIVED_QUANTITIES } from '../namespace';

// --- physical thresholds -----------------------------------------------------

// Both gm/ID ceilings below are anchored at 27 °C and scaled to each table's
// temperature at the check site: the weak-inversion limit gm/ID → 1/(n·U_T) rises
// as it gets colder (U_T = kT/q ∝ T), so a fixed room-temperature ceiling would
// false-flag valid cold-corner data (gm/ID ~48 at −40 °C is physical).

/** Physical ceiling on gm/ID ≈ 1/U_T (weak-inversion limit) at 27 °C, in S/A. */
const GM_ID_CEILING = 1 / UT; // ~38.7 at 27 °C

/** gm/ID above this at 27 °C is almost certainly a unit error, not physics. */
const GM_ID_UNIT_ERROR = 45;

/** Per-step vgs spacing above this (in volts) is coarse enough to warn. */
const VGS_STEP_WARN = 0.01; // 10 mV

/** Plausible range for the thermal-noise factor γ; outside it is likely a unit/model error.
 *  The long-channel value is 2/3; short-channel devices run higher (hot-carrier / velocity
 *  saturation can reach ~2–3), so the ceiling is generous — it targets gross errors (γ stored
 *  as a percentage, or a wrong-model γ≈10) without flagging valid deep-submicron γ. */
const GAMMA_LO = 0.4;
const GAMMA_HI = 4.0;

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

/** Quantities whose sign is convention-dependent and folded to magnitude. */
const SIGNED_MAGNITUDE_KEYS: readonly string[] = ['id', 'gm', 'gds', 'gmb'];

/** Only the self-term gate capacitance cgg is a magnitude folded on signed input.
 *  The cross/trans-capacitances (cgd, cgb, cdb, csb) are legitimately signed under the
 *  common ∂Qi/∂Vj convention (see signCheck below), so they are deliberately NOT folded —
 *  abs-ing them would corrupt their sign information. */
const SELF_CAP_KEYS: readonly string[] = ['cgg'];

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
    if (maxStep > VGS_STEP_WARN) {
      out.push({
        rule: 'vgs-step',
        severity: 'warning',
        message: `vgs step up to ${(maxStep * 1e3).toFixed(1)} mV exceeds 10 mV`,
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
    const tempC = table.meta.temp ?? 27;
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
    if (maxGmId > unitError) {
      out.push({
        rule: 'gm-id-ceiling',
        severity: 'error',
        message: `max gm/ID ${maxGmId.toFixed(1)} S/A exceeds ${unitError.toFixed(1)} at ${tempC} °C — likely a unit error`,
        location: 'gm/id',
      });
    } else if (maxGmId > ceiling) {
      out.push({
        rule: 'gm-id-ceiling',
        severity: 'warning',
        message: `max gm/ID ${maxGmId.toFixed(1)} S/A exceeds the physical ceiling ~${ceiling.toFixed(1)} (1/U_T at ${tempC} °C)`,
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

  // --- magnitude / positivity checks ---
  // gm and gds are reported as magnitudes; the total gate capacitance cgg is a self-term and
  // must be non-negative. A signed PMOS dump trips these until canonicalization folds it to
  // magnitude. The cross/trans-capacitances (cgd, cgb, cdb, csb) are deliberately NOT checked
  // — they are legitimately negative under the common ∂Qi/∂Vj convention.
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
  signCheck(q.get('cgg'), 'cap-sign', 'cgg', 'the total gate capacitance should be a magnitude');

  // A non-positive sth/sfl poisons every input-referred noise quantity (sqrt of ≤0, or a 0 in fco).
  for (const key of ['sth', 'sfl'] as const) {
    const col = q.get(key);
    if (!col) continue;
    const bad = countWhere(col, (x) => !(x > 0));
    if (bad > 0) {
      out.push({
        rule: 'noise-psd',
        severity: 'error',
        message: `${key} has ${bad} non-positive value(s) — a noise PSD must be > 0`,
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

  // --- a stored column that shadows a standard derived quantity ---
  // Unknown columns pass through on import (the strict-superset rule), so an export can
  // carry its own `ft`/`gm_gds`/`gm_id` alongside the raw quantities they are computed
  // from. Nothing here repairs that — but the two are read by different code: expression
  // scopes prefer the stored column, while the operating-point path re-derives from the
  // definition, so a chart and a sizing can disagree without either being wrong. Naming
  // the column is the only way the difference is ever visible.
  for (const def of DERIVED_QUANTITIES) {
    if (!q.has(def.key)) continue;
    out.push({
      rule: 'derived-shadow',
      severity: 'warning',
      symbol: def.key,
      message: `the table stores a "${def.key}" column, which shadows the quantity computed from ${def.expr} — charts read the stored column while sizing re-derives it, so the two disagree if this column was made a different way; drop or rename it to remove the ambiguity`,
      location: def.key,
    });
  }

  return out;
}

// --- family QA ---------------------------------------------------------------

/** The distinct values of one per-table fact across a family, each with the conditions that
 *  carry it. One entry means the family agrees; more means it does not, and the map already
 *  says which corner is the odd one out. */
function byFact(
  variants: readonly DeviceTable[],
  fact: (t: DeviceTable) => string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of variants) {
    const key = fact(t);
    const labels = out.get(key);
    if (labels) labels.push(variantLabel(t.id));
    else out.set(key, [variantLabel(t.id)]);
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
 * Data-trust checks ACROSS one corner family — the questions that only exist once several
 * tables claim to be one device. Pure, and warn-never-fix like every other check here: a
 * family is never repaired, reordered, resampled, or silently split.
 *
 * Error severity marks a family nothing should project from, and projection independently
 * enforces both cases: an ambiguous condition (`variantAt` refuses that condition) and
 * variants that do not even sweep the same axes (`runVariant` refuses the whole family — a
 * sheet pinned on one is not pinned on the other, compared here and there through the one
 * `axisSignature`). Everything else is a warning, because coverage IS legitimately
 * corner-specific — a slow corner characterized over a shorter vgs range is ordinary, not a
 * defect — and gating on it would refuse valid data.
 */
export function validateFamily(f: CornerFamily): QAWarning[] {
  const out: QAWarning[] = [];
  const variants = f.variants;

  for (const key of f.duplicates) {
    const n = variants.filter((t) => sameVariant(variantKeyOf(t.id), key)).length;
    const label = variantLabel(key);
    out.push({
      rule: 'family-duplicate-variant',
      severity: 'error',
      message: `${n} loaded tables claim "${f.device}" at ${label} — nothing evaluates at an ambiguous condition; remove one or replace it explicitly`,
      location: label,
    });
  }
  if (variants.length < 2) return out;

  const axisSets = byFact(variants, axisSignature);
  if (axisSets.size > 1) {
    out.push({
      rule: 'family-axes',
      severity: 'error',
      message: `variants of "${f.device}" sweep different axes — ${describe(axisSets)} — a design pinned on one is not pinned on the other`,
      location: f.device,
    });
  } else {
    // Compared on the sample points themselves, reported as ranges: two sweeps can share
    // their endpoints and their count and still sit on different points (a log spacing
    // against a linear one), and a summary-only comparison would call those identical.
    const lattices = byFact(variants, (t) =>
      t.grid.axes.map((a) => `${a.name}:${a.values.join(',')}`).join(' | '),
    );
    if (lattices.size > 1) {
      out.push({
        rule: 'family-sweep-range',
        severity: 'warning',
        message: `variants of "${f.device}" were swept over different ranges, step sizes or sample points — ${describe(byFact(variants, (t) => t.grid.axes.map(axisSummary).join(' | ')))} — each table is read as imported, so an operating point reachable at one condition may be out of range at another`,
        location: f.device,
      });
    }
  }

  const widths = byFact(variants, (t) => (t.meta.W === undefined ? '' : t.meta.W.toExponential(3)));
  if (widths.size > 1) {
    out.push({
      rule: 'family-width',
      severity: 'warning',
      message: `variants of "${f.device}" were characterized at different widths — ${describe(widths)} — sizing rescales from each table's own width, so compare the sized results, not the raw columns`,
      location: f.device,
    });
  }

  // Non-axis columns only: the grid materializes every axis as a column too, and an axis
  // difference is the check above's finding, not a second one about quantities.
  const columns = byFact(variants, (t) => {
    const axes = new Set(t.grid.axes.map((a) => a.name));
    return [...t.grid.quantities.keys()]
      .filter((k) => !axes.has(k))
      .sort()
      .join(', ');
  });
  if (columns.size > 1) {
    out.push({
      rule: 'family-quantities',
      severity: 'warning',
      message: `variants of "${f.device}" carry different quantity columns — ${describe(columns)} — author math that reads a column a variant lacks goes na at that condition`,
      location: f.device,
    });
  }

  // Provenance says two different things depending on whether the process namespace is
  // declared. Undeclared, it is the only evidence about IDENTITY — whether these tables are
  // one device at all. Declared, identity is settled and a simulator difference is a fact
  // about the DATA. One fact, one warning. The branch reads the whole family, not one member:
  // grouping joins an undeclared member to a declared sibling, so a family can mix the two —
  // and any undeclared member means its membership was INFERRED, which is exactly when the
  // identity evidence must stay visible, whichever file the user happened to import first.
  if (variants.some((t) => pdkOf(t) === '')) {
    const provenance = byFact(variants, (t) =>
      [extraScalar(t, 'source') ?? '', t.meta.simulator ?? '', t.meta.date ?? '']
        .filter((s) => s !== '')
        .join(' / '),
    );
    if (provenance.size > 1) {
      out.push({
        rule: 'family-provenance',
        severity: 'warning',
        message: `"${f.device}" was grouped by device name alone and its variants record different provenance — ${describe(provenance)} — declare "# pdk:" in the exports to confirm these are one device or to separate them`,
        location: f.device,
      });
    }
  } else {
    const simulators = byFact(variants, (t) => t.meta.simulator ?? '');
    if (simulators.size > 1) {
      out.push({
        rule: 'family-simulator',
        severity: 'warning',
        message: `variants of "${f.device}" were characterized with different simulators — ${describe(simulators)}`,
        location: f.device,
      });
    }
  }

  return out;
}

/**
 * Data-trust checks ACROSS families — the split question `validateFamily` cannot see, because
 * it holds one family at a time. Grouping resolves an under-declared identity (blank `pdk`,
 * undeclared polarity) into the unique declared candidate for the same device name; when
 * several candidates make that join a guess, it refuses — and a refused join is as invisible
 * per-family as a wrong one, so it is warned about here, naming the header that would settle
 * it. Fully declared same-name families are legitimate (two PDKs both shipping an `nch`) and
 * stay silent. Warn, never fix: nothing is ever joined or split by this check.
 */
export function validateFamilies(families: readonly CornerFamily[]): QAWarning[] {
  const byName = new Map<string, CornerFamily[]>();
  for (const f of families) {
    const id = familyIdentityOf(f.familyUid);
    if (!id) continue;
    const list = byName.get(id.device) ?? [];
    list.push(f);
    byName.set(id.device, list);
  }
  const out: QAWarning[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    // Only a header that is declared in one family and undeclared in another is a split
    // cause: undeclared-everywhere groups fine, and declared-everywhere is a real difference.
    const ids = group.map((f) => familyIdentityOf(f.familyUid)!);
    const varies: string[] = [];
    if (ids.some((id) => id.pdk === '') && ids.some((id) => id.pdk !== '')) varies.push('# pdk:');
    if (ids.some((id) => id.polarity === 'unknown') && ids.some((id) => id.polarity !== 'unknown'))
      varies.push('# polarity:');
    if (!varies.length) continue;
    out.push({
      rule: 'family-split',
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
 * meta.polarity.signedInput is set, replace id/gm/gds/gmb, the self-term gate
 * capacitance cgg and NON-AXIS voltages (vth, vdsat) with |value|, and record the
 * polarity. The cross/trans-capacitances (cgd/cgb/cdb/csb) are left signed. Sweep
 * AXES are left untouched: a signed sweep is still ascending and valid, and the
 * data row order already matches it — abs-ing + re-sorting an axis without
 * reindexing the data would corrupt the mapping. |V| axis presentation, if ever
 * wanted, belongs at parse time pre-grid (see the vbs sign-flip in parse).
 */
export function canonicalizeTable(table: DeviceTable): DeviceTable {
  const pol: Polarity | undefined = table.meta.polarity;
  if (!pol?.signedInput) return table;

  const grid = table.grid;

  // Magnitude for currents/conductances, the self-term capacitance cgg, and
  // non-axis voltages. Axis-name columns are skipped so the materialized axis
  // column keeps matching its (untouched) axis.
  const magKeys = new Set<string>([...SIGNED_MAGNITUDE_KEYS, ...SELF_CAP_KEYS, ...VOLTAGE_KEYS]);
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
