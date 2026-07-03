// bind-any-2 device sizing. Given any two of {gm, gm/ID, ID} plus a channel
// length L, recover the third via gm = (gm/ID)·ID, place the operating point on
// the table at the (gm/ID, L) coordinate (inverse lookup), and size the width
// from the current density id/w. The gm/ID ceiling at the L-slice gates
// feasibility. Pure, deterministic, zero DOM imports.

import type { DeviceTable } from '../types';
import { lookup, lookupByGmId } from '../lookup';
import { sliceGrid } from '../grid';
import { scalarScope } from '../expr';
import { CONSTANTS, thermalScalars } from '../constants';
import { compileExpr } from '../derive';
import { DERIVED_QUANTITIES } from '../namespace';

/**
 * A sizing query: a table and length L, plus EXACTLY two of {gm, gm_id, id}. The
 * third is derived from gm = gm_id * id.
 */
export interface SizeQuery {
  table: DeviceTable;
  L: number;
  gm?: number;
  gm_id?: number;
  id?: number;
}

/** A solved operating point with the sized width and feasibility against the slice ceiling. */
export interface SizeResult {
  gm: number;
  gm_id: number;
  id: number;
  W: number;
  vgs: number;
  feasible: boolean;
  ceiling: number;
  /** Every base + derived quantity reported by the forward lookup at the point. */
  quantities: Record<string, number>;
  /**
   * Human-readable engineering notes for this sizing (e.g. a requested L that fell
   * off the table's L hull and was clamped). Empty when nothing needs flagging.
   */
  warnings: string[];
}

/**
 * Solve the third of {gm, gm_id, id} from the two that are supplied, using the
 * single relation gm = gm_id * id. Throws unless EXACTLY two are present, and
 * throws on a supplied non-finite value — a NaN must fail here, by name, not
 * surface downstream as a misleading out-of-range lookup error.
 */
function bindThree(q: SizeQuery): { gm: number; gm_id: number; id: number } {
  const has = {
    gm: q.gm !== undefined,
    gm_id: q.gm_id !== undefined,
    id: q.id !== undefined,
  };
  const count = (has.gm ? 1 : 0) + (has.gm_id ? 1 : 0) + (has.id ? 1 : 0);
  if (count !== 2) {
    throw new Error(
      `sizeDevice: require EXACTLY two of {gm, gm_id, id}; got ${count} ` +
        `(gm=${q.gm}, gm_id=${q.gm_id}, id=${q.id})`,
    );
  }
  for (const k of ['gm', 'gm_id', 'id'] as const) {
    const v = q[k];
    if (v !== undefined && !Number.isFinite(v)) {
      throw new Error(`sizeDevice: ${k} must be a finite number, got ${v}`);
    }
  }

  if (has.gm && has.id) {
    const gm = q.gm as number;
    const id = q.id as number;
    return { gm, gm_id: gm / id, id };
  }
  if (has.gm_id && has.id) {
    const gm_id = q.gm_id as number;
    const id = q.id as number;
    return { gm: gm_id * id, gm_id, id };
  }
  // has.gm && has.gm_id
  const gm = q.gm as number;
  const gm_id = q.gm_id as number;
  return { gm, gm_id, id: gm / gm_id };
}

/**
 * Maximum gm/ID over the fixed-L slice — the weak-inversion ceiling the device
 * cannot physically exceed. Computed elementwise from the slice's gm and id
 * columns so it reflects exactly the data, not a model assumption.
 */
function gmIdCeiling(table: DeviceTable, L: number): number {
  const slice = sliceGrid(table.grid, { l: L });
  const gm = slice.quantities.get('gm');
  const id = slice.quantities.get('id');
  if (!gm || !id) {
    throw new Error('sizeDevice: slice is missing gm and/or id columns for the ceiling');
  }
  let max = -Infinity;
  for (let i = 0; i < gm.length; i++) {
    if (id[i] === 0) continue; // undefined ratio; skip (mirrors qa/validate's ceiling scan)
    const r = gm[i] / id[i];
    if (Number.isFinite(r) && r > max) max = r; // skip ±∞/NaN so they can't pin the ceiling
  }
  return max;
}

/**
 * Size a device by binding any two of {gm, gm/ID, ID} at a chosen length L.
 *
 * The two supplied quantities fix the third (gm = gm/ID · ID). The (gm/ID, L)
 * coordinate is inverted to a vgs via the table, the forward lookup at that point
 * yields the characterization-width operating point, and the width is scaled from
 * the current density id_w = id_char / W_char so the device delivers the target
 * ID: W = id / id_w. Feasibility is gm/ID <= the slice ceiling.
 */
export function sizeDevice(q: SizeQuery): SizeResult {
  const { gm, gm_id, id } = bindThree(q);
  const L = q.L;

  // Surface — never silently substitute — a length the table cannot represent: the
  // grid's locate() clamps an off-hull L to the nearest characterized node, so the
  // sizing then runs at a different L than requested. This is a warned clamp, NOT an
  // infeasibility (unlike a gm/ID past the ceiling, which lookupByGmId throws on).
  const warnings: string[] = [];
  const lAxis = q.table.grid.axes.find((a) => a.name === 'l');
  if (lAxis && lAxis.values.length > 0) {
    const lLo = lAxis.values[0];
    const lHi = lAxis.values[lAxis.values.length - 1];
    if (L < lLo || L > lHi) {
      warnings.push(
        `requested L ${L} m is outside the table's L range [${lLo}, ${lHi}] m; clamped to the nearest characterized length`,
      );
    }
  }

  const ceiling = gmIdCeiling(q.table, L);
  const feasible = gm_id <= ceiling;

  // Invert (gm/ID, L) -> vgs, then read the full operating point at that point.
  const point = lookupByGmId(q.table, gm_id, L);
  const vgs = point.vgs;

  // Current density at the characterization width. The grid carries no `w`
  // column, so derive it from the table's characterization width metadata.
  const Wchar = q.table.meta.W;
  if (Wchar === undefined || !(Wchar > 0)) {
    throw new Error('sizeDevice: table.meta.W (characterization width) is required to size W');
  }
  const idChar = point.id;
  const id_w = idChar / Wchar; // current per unit width [A/m]
  const W = id / id_w;

  // Report the operating point's quantities, augmented with the bound targets and
  // the sized current density (id_w is not in the grid because there is no w col).
  // `w0` is the characterization width: the lookup's extensive quantities (caps,
  // conductances, the noise PSDs sth/sfl/svth/svfl) are reported at w0, so an author
  // refers them to the SIZED device by the width ratio — e.g. an input-referred noise
  // PSD (∝ 1/W) scales by `w0/W`. gm/id/W above are already the sized values.
  const quantities: Record<string, number> = {
    ...lookup(q.table, { l: L, vgs }),
    id_w,
    gm,
    gm_id,
    id,
    W,
    w0: Wchar,
  };

  return { gm, gm_id, id, W, vgs, feasible, ceiling, quantities, warnings };
}

// The input-referred thermal-noise density √(4kTγ/gm), compiled ONCE from its single
// home in namespace.ts (the `vnth_m` derived quantity). thermalNoise evaluates this
// compiled definition rather than re-coding the formula, so the two can never drift.
const VNTH_M = compileExpr(
  (() => {
    const def = DERIVED_QUANTITIES.find((d) => d.key === 'vnth_m');
    if (!def) throw new Error('thermalNoise: namespace is missing the vnth_m definition');
    return def.expr;
  })(),
);

/**
 * Input-referred channel thermal-noise density √(4kTγ/gm) [V/√Hz] at the device's
 * actual transconductance gm. Noise is width-dependent (gm ∝ W), so a sized device
 * must pass its SIZED gm — the characterization-width value would be wrong. γ comes
 * from the operating point when the table carries it, else GAMMA_DEFAULT. Pass the
 * table's characterization temperature `tempC` (meta.temp, °C) so kT tracks the
 * data; omitted, T falls through to the engine's 27 °C default.
 *
 * The formula itself lives only in namespace.ts (vnth_m); here we just bind gm, γ,
 * and the temperature and evaluate that definition. k falls through resolve() to
 * the engine's constant scope; bound names shadow constants so explicit values win.
 */
export function thermalNoise(gm: number, gamma?: number, tempC?: number): number {
  const scope = scalarScope({ ...thermalScalars(tempC), gm, gamma: gamma ?? CONSTANTS.gamma });
  // vnth_m over scalar gm,γ reduces to a scalar; the engine's Value admits an array,
  // which this scalar-only scope never produces, so read it back as a number.
  return VNTH_M.eval(scope) as number;
}

/**
 * Total input-referred noise (RMS, [V]) integrated over the band [fLo, fHi], from a
 * white thermal floor plus a 1/f flicker tail. Flicker is parameterized by its corner
 * `fc` — the frequency where flicker equals thermal — so S(f) = Sth·(1 + fc/f). Then
 *   ∫ S df = Sth·[(fHi − fLo) + fc·ln(fHi/fLo)].
 * `sth` is the thermal PSD [V²/Hz] (= thermalNoise(gm)²). The corner is a process/bias
 * quantity supplied by the user (or table metadata); it is width-INDEPENDENT because
 * both Sth and the flicker PSD scale as 1/W. Requires sth ≥ 0, fc ≥ 0, and
 * 0 < fLo < fHi — violated preconditions throw rather than silently returning
 * NaN/Infinity (fLo = 0 would make the flicker integral diverge).
 */
export function integratedNoise(sth: number, fc: number, fLo: number, fHi: number): number {
  if (!(sth >= 0)) throw new Error(`integratedNoise: sth must be >= 0, got ${sth}`);
  if (!(fc >= 0)) throw new Error(`integratedNoise: fc must be >= 0, got ${fc}`);
  if (!(fLo > 0) || !(fHi > fLo) || !Number.isFinite(fLo) || !Number.isFinite(fHi)) {
    throw new Error(`integratedNoise: require 0 < fLo < fHi (finite), got fLo=${fLo}, fHi=${fHi}`);
  }
  return Math.sqrt(sth * (fHi - fLo + fc * Math.log(fHi / fLo)));
}

/** Pelgrom matching coefficients (SI): A_Vth in V·m, A_β dimensionless·m. */
export interface MismatchCoeffs {
  avth: number;
  abeta: number;
}

/** Random-mismatch budget for a sized device, evaluated at its operating point. */
export interface MismatchResult {
  sigmaVth: number; // σ(ΔVth) of one device [V] — the area-set threshold spread
  sigmaBeta: number; // σ(Δβ/β) of one device [1] — current-factor spread
  sigmaVos: number; // σ(Vos) of a matched pair, input-referred [V]
  sigmaIrel: number; // σ(ΔI/I) of ONE device at fixed VGS [1]; a mirror PAIR is √2 larger
}

/**
 * Pelgrom random-mismatch budget. σ scales as 1/√(W·L) — bigger area averages out
 * more grains — so the sized geometry sets matching, NOT the gm/ID bias. gm/ID
 * couples the two: it refers the β-spread to the input as ΔI/gm = (Δβ/β)/(gm/ID)
 * — exact at any inversion level, not a square-law approximation — and amplifies
 * the Vth-spread into current spread. So:
 *   σ(Vos,pair) = √2 · √( σ(ΔVth)² + (σ(Δβ/β)/(gm/ID))² )   — input offset of a pair
 *   σ(ΔI/I)     = √( (gm/ID · σ(ΔVth))² + σ(Δβ/β)² )         — mirror current spread
 * High gm/ID (low Vov) shrinks the offset's β term but grows current spread: the
 * matching-vs-bias trade the methodology makes visible. Pure; no table needed.
 * Requires W > 0, L > 0, gm_id > 0, and non-negative coefficients — violated
 * preconditions throw rather than silently returning NaN/Infinity σ.
 */
export function mismatch(W: number, L: number, gm_id: number, c: MismatchCoeffs): MismatchResult {
  if (!(W > 0) || !(L > 0))
    throw new Error(`mismatch: require W > 0 and L > 0, got W=${W}, L=${L}`);
  if (!(gm_id > 0)) throw new Error(`mismatch: require gm_id > 0, got ${gm_id}`);
  if (!(c.avth >= 0) || !(c.abeta >= 0)) {
    throw new Error(`mismatch: coefficients must be >= 0, got avth=${c.avth}, abeta=${c.abeta}`);
  }
  const rtArea = Math.sqrt(W * L);
  const sigmaVth = c.avth / rtArea;
  const sigmaBeta = c.abeta / rtArea;
  return {
    sigmaVth,
    sigmaBeta,
    sigmaVos: Math.SQRT2 * Math.hypot(sigmaVth, sigmaBeta / gm_id),
    sigmaIrel: Math.hypot(gm_id * sigmaVth, sigmaBeta),
  };
}
