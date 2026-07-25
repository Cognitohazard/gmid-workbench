// bind-any-2 device sizing. Given any two of {gm, gm/ID, ID, W, fT, gm/gds, A_v0, V*}
// plus a channel length L, recover the rest via gm = (gm/ID)·ID and the
// width/current-density relation, placing the operating point on the table by inverse
// lookup (of a width-invariant selector such as gm/ID or fT, or of a gm/id column at
// the density target when W is bound). The gm/ID ceiling at the L-slice gates
// feasibility. Pure, deterministic, zero DOM imports.

import { type DeviceTable, LookupRangeError } from '../types';
import { lookupByGmId, lookupByQuantity } from '../lookup';
import { sliceGrid } from '../grid';
import { scalarScope, registerExprFunction } from '../expr';
import { CONSTANTS, thermalScalars } from '../constants';
import { compileExpr, metaScalars, DERIVED_COMPILED } from '../derive';
import { DERIVED_QUANTITIES, PER_WIDTH_KEYS } from '../namespace';

/**
 * A sizing query: a table and length L, plus EXACTLY two bound quantities.
 *
 * The two split into different jobs. An OPERATING-POINT SELECTOR (gm_id, ft, gm_gds,
 * av0, vstar) is a width-invariant ratio, so it pins vgs on the L-slice by itself and
 * says nothing about size; an EXTENSIVE quantity (gm, id, W) sets the scale. A legal
 * bind is therefore one selector plus one extensive quantity — or two extensive ones,
 * which pin the point between them (gm + id fixes gm/ID; W + gm or W + id fixes a
 * current/transconductance density). Two selectors over-determine vgs and are refused.
 *
 * Binding a selector other than gm/ID is what lets a designer state the spec they
 * actually have — "fT ≥ 5 GHz", "intrinsic gain ≥ 40 dB" — instead of hand-iterating
 * gm/ID until the reported fT lands.
 */
export interface SizeQuery {
  table: DeviceTable;
  L: number;
  gm?: number;
  gm_id?: number;
  id?: number;
  W?: number;
  ft?: number;
  gm_gds?: number;
  av0?: number;
  vstar?: number;
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
  /**
   * Every base + derived quantity at the operating point, describing the SIZED device:
   * per-width quantities (id, gm, gds, caps, current-noise PSDs, w) are rescaled from
   * the characterization width w0 to the sized W (parallel-composition model), and the
   * derived layer is re-evaluated from those scaled bases — so author math like
   * gm/(gds + gds_load) or ft = gm/(2π·cgg) reads the device that was actually sized,
   * not the characterization-width artifact. `w0` records the characterization width;
   * quantities from unknown pass-through columns are NOT rescaled (their width law is
   * unknowable) and remain at w0.
   */
  quantities: Record<string, number>;
  /**
   * Human-readable engineering notes for this sizing (e.g. a requested L that fell
   * off the table's L hull and was clamped). Empty when nothing needs flagging.
   */
  warnings: string[];
}

/**
 * Operating-point selectors: quantities that pin vgs on the L-slice by themselves.
 *
 * Every one is a ratio of two per-width base quantities (gm/id, gm/(2π·cgg), gm/gds,
 * 2·id/gm), hence width-INVARIANT — which is exactly why it carries no size information and
 * must be paired with an extensive quantity. A per-width key here would silently size wrong,
 * so a property test asserts the invariance of every member.
 *
 * That invariance is NECESSARY BUT NOT SUFFICIENT — this is a curated list, not everything
 * that qualifies. `gm_cgd`, `cgd_cgg`, `gmb_gm`, `ft_eff`, `av0_ft` and `id_w` are all
 * width-invariant ratios and all deliberately absent. A member must also be monotonic in vgs
 * on real data (or the inversion fails closed, which is a poor headline feature) and be a
 * quantity designers actually state as a spec. Add one only when all three hold.
 */
export const OP_SELECTORS = ['gm_id', 'ft', 'gm_gds', 'av0', 'vstar'] as const;

/** Extensive quantities: these set the device's SCALE once the operating point is fixed. */
export const EXTENSIVE = ['gm', 'id', 'W'] as const;

/** The bind-any-2 quantity set — the one home for the list, shared by the sizer's own
 *  arity check and the sheet bind's eval/validate sites (same set, same error text). */
export const BINDABLE = [...OP_SELECTORS, ...EXTENSIVE] as const;

/**
 * The bind rule, in one place: EXACTLY two bound quantities, at most one of them an
 * operating-point selector. Returns null for a legal bind, else the problem in the
 * words every caller reports (sizeDevice throws it; the sheet's eval and validate
 * surface it as a sheet-bind error), so the three can never describe it differently.
 */
export function bindProblem(supplied: readonly (typeof BINDABLE)[number][]): string | null {
  if (supplied.length !== 2) {
    return `require EXACTLY two of {${BINDABLE.join(', ')}}; got ${supplied.length}`;
  }
  const selectors = supplied.filter((k) => (OP_SELECTORS as readonly string[]).includes(k));
  if (selectors.length > 1) {
    return (
      `${selectors.join(' and ')} both set the operating point; ` +
      `supply one of them plus one of {${EXTENSIVE.join(', ')}}`
    );
  }
  return null;
}

/**
 * Check the query supplies a legal bind, each value finite and strictly positive. A
 * NaN must fail here, by name, not surface downstream as a misleading out-of-range
 * lookup error; and the tables hold magnitudes (PMOS is canonicalized on import), so
 * a negative or zero bind — e.g. an author expression like gm/(1+gm·Rs) driven past
 * its pole — is always a mistake, never a convention.
 */
function checkBindPair(q: SizeQuery): void {
  const supplied = BINDABLE.filter((k) => q[k] !== undefined);
  const problem = bindProblem(supplied);
  if (problem) {
    const shown = supplied.map((k) => `${k}=${q[k]}`).join(', ');
    throw new Error(`sizeDevice: ${problem}${shown ? ` (${shown})` : ''}`);
  }
  for (const k of supplied) {
    const v = q[k] as number;
    if (!Number.isFinite(v)) {
      throw new Error(`sizeDevice: ${k} must be a finite number, got ${v}`);
    }
    if (!(v > 0)) {
      throw new Error(`sizeDevice: ${k} must be > 0, got ${v} — unphysical bind`);
    }
  }
}

/**
 * Invert a characterization-width column at a density target, reporting an out-of-reach
 * failure in the quantity the CALLER bound. The value handed to the lookup is q·w0/W, an
 * internal rescaling — surfacing it would tell a designer whose 1 nA request failed that
 * "gm 1e-11 is out of range", a number they never typed.
 */
function atDensity(
  table: DeviceTable,
  key: 'gm' | 'id',
  bound: number,
  scale: number,
  L: number,
): Record<string, number> {
  try {
    return lookupByQuantity(table, key, bound * scale, L);
  } catch (e) {
    throw e instanceof LookupRangeError ? e.rescaled(scale) : e;
  }
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
 * Size a device by binding any two of {gm, gm/ID, ID, W, fT, gm/gds, A_v0, V*} at a
 * chosen length L (see SizeQuery for which pairs are legal).
 *
 * A bound SELECTOR is inverted on the L-slice to a vgs — gm/ID, or a spec-level
 * quantity like fT or intrinsic gain — and the paired extensive quantity then scales
 * the device: width from the current density W = id / (id_char/w0), or current from
 * the density at a given W. Two extensive quantities instead pin the point between
 * them: gm + ID fixes gm/ID, while W + gm / W + ID invert the matching
 * characterization column at the density target gm·w0/W / id·w0/W. Feasibility is
 * gm/ID <= the slice ceiling in every case.
 */
export function sizeDevice(q: SizeQuery): SizeResult {
  checkBindPair(q);
  const L = q.L;

  // The characterization width — every binding path sizes width against it.
  const Wchar = q.table.meta.W;
  if (Wchar === undefined || !(Wchar > 0)) {
    throw new Error('sizeDevice: table.meta.W (characterization width) is required to size W');
  }

  // Surface — never silently substitute — a length the table cannot represent: the
  // grid's locate() clamps an off-hull L to the nearest characterized node, so the
  // sizing then runs at a different L than requested. This is a warned clamp, NOT an
  // infeasibility (unlike a gm/ID past the ceiling, which the inverse lookup throws on).
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

  // Resolve the bound pair to the full (gm, gm_id, id, W) + the characterization-width
  // operating point. Each path inverts exactly one monotone curve on the L-slice.
  let gm: number;
  let gm_id: number;
  let id: number;
  let W: number;
  let point: Record<string, number>;
  const selector = OP_SELECTORS.find((k) => q[k] !== undefined);
  if (selector !== undefined) {
    // One selector pins the operating point; the single extensive quantity scales it. Each
    // selector inverts its OWN curve — including V*, which could be rewritten as the gm/ID
    // it names but must not be: the failure and the reported operating point would then
    // come back in a quantity the caller never bound.
    point = lookupByQuantity(q.table, selector, q[selector] as number, L);
    // A bound gm/ID is honoured exactly: interpolating gm and id separately does not
    // preserve their ratio, so reading it back off the point would return a hair off what
    // the designer asked for — and a gm to match. Every other selector has no such closed
    // form; there the solved point IS the answer, to interpolation accuracy.
    gm_id = selector === 'gm_id' ? (q.gm_id as number) : point.gm / point.id;
    if (q.W !== undefined) {
      W = q.W;
      id = (point.id / Wchar) * W;
    } else {
      id = q.id ?? (q.gm as number) / gm_id;
      W = (id / point.id) * Wchar; // = id / (id_char/w0), the current-density sizing
    }
    gm = q.gm ?? gm_id * id;
  } else if (q.W === undefined) {
    // gm + id: the pair fixes gm/ID between them, which places the point.
    gm = q.gm as number;
    id = q.id as number;
    gm_id = gm / id;
    point = lookupByGmId(q.table, gm_id, L);
    W = (id / point.id) * Wchar;
  } else {
    // W + gm or W + id: invert whichever characterization column was bound, at its
    // density target. The two differ only in that column.
    W = q.W;
    const key = q.id !== undefined ? 'id' : 'gm';
    point = atDensity(q.table, key, q[key] as number, Wchar / W, L);
    gm_id = point.gm / point.id;
    id = q.id ?? (q.gm as number) / gm_id;
    gm = q.gm ?? gm_id * id;
  }
  // Plausibility gate on the DERIVED quantities (checkBindPair covered the supplied
  // pair): a sign-inconsistent pair, or a degenerate operating point (vanishing
  // current density sizing W to ±Infinity), must fail here by name — letting it
  // through would report a negative/infinite "design" that downstream feasibility
  // checks cannot catch (rule inequalities flip sign along with the values).
  for (const [k, v] of [
    ['gm', gm],
    ['gm_id', gm_id],
    ['id', id],
    ['W', W],
  ] as const) {
    if (!Number.isFinite(v) || !(v > 0)) {
      throw new Error(`sizeDevice: derived ${k} is not a positive finite number (got ${v})`);
    }
  }

  const ceiling = gmIdCeiling(q.table, L);
  const feasible = gm_id <= ceiling;
  const vgs = point.vgs;
  const id_w = point.id / Wchar; // current per unit width [A/m], width-invariant

  // Rescale the operating point from the characterization width to the sized width
  // (parallel-composition model: the sized device is k = W/w0 unit devices in
  // parallel), then re-evaluate the derived layer from the scaled bases — each derived
  // quantity from its single namespace definition, so ratios (av0, ft, vstar) stay
  // invariant and width-law quantities (ro ∝ 1/W, input-referred noise ∝ 1/W) come out
  // right without any per-key case analysis here.
  const k = W / Wchar;
  const bases: Record<string, number> = {};
  for (const [key, val] of Object.entries(point)) {
    if (DERIVED_COMPILED.has(key)) continue; // re-derived below at the sized width
    bases[key] = PER_WIDTH_KEYS.has(key) ? val * k : val;
  }
  // The meta layer lookup used but did not report: T/UT (temperature) and — when the
  // table has no w column — the width itself, which must reflect the SIZED device.
  for (const [key, val] of Object.entries(metaScalars(q.table.meta))) {
    if (!Object.prototype.hasOwnProperty.call(bases, key)) {
      bases[key] = PER_WIDTH_KEYS.has(key) ? val * k : val;
    }
  }
  const scaledScope = scalarScope(bases);
  const quantities: Record<string, number> = { ...bases };
  for (const [key, compiled] of DERIVED_COMPILED) {
    if (!Object.prototype.hasOwnProperty.call(point, key)) continue; // not computable on this table
    quantities[key] = compiled.eval(scaledScope) as number;
  }
  // Bound targets and sizing outputs win over anything reconstructed above; id_w is the
  // (width-invariant) current density; `w0` records the characterization width so a consumer
  // can refer an unknown pass-through column (not rescaled) by hand.
  //
  // That includes a bound SELECTOR, which is recovered by inverting a curve sampled at the
  // vgs nodes while the point re-evaluates it from separately interpolated bases — for a
  // ratio the two differ by ~0.1% between nodes, well inside the data's own resolution but
  // far outside the rule engine's pinned-spec tolerance. Without it, the most natural thing
  // an author writes — bind a gain spec, then require that gain — fails against its own bind.
  Object.assign(quantities, {
    id_w,
    gm,
    gm_id,
    id,
    W,
    w0: Wchar,
    ...(selector !== undefined ? { [selector]: q[selector] as number } : {}),
  });

  return { gm, gm_id, id, W, vgs, feasible, ceiling, quantities, warnings };
}

/**
 * The characterized lengths at which this bind actually sizes — the answer to the question a
 * failed spec-first bind raises: "out of reach at this L, so where does it work?" That is how
 * the methodology picks L in the first place.
 *
 * It re-runs the WHOLE sizing at each length, not just the inversion, so it cannot advise a
 * length that then fails: a slice can invert cleanly and still be rejected downstream — one
 * id==0 sample leaves fT monotone while sending gm/ID to infinity, which the plausibility
 * gate refuses. Lengths come back in axis order; empty when none work or there is no L axis.
 */
export function sizeableLengths(q: SizeQuery): number[] {
  const lAxis = q.table.grid.axes.find((a) => a.name === 'l');
  if (!lAxis) return [];
  const out: number[] = [];
  for (const L of lAxis.values) {
    try {
      sizeDevice({ ...q, L });
      out.push(L);
    } catch {
      // not sizeable at this length — precisely the question being asked
    }
  }
  return out;
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

// ── Author-callable oracles ───────────────────────────────────────────────────
// The noise/mismatch closed-forms above are the single trusted home of those
// formulas; registering them as expression functions lets sheet authors CALL them
// (noise_rms, pelgrom_vos, pelgrom_irel) instead of re-typing Pelgrom or the band
// integral per sheet — re-typed copies drift, calls cannot. Names are prefixed by
// domain so they cannot shadow plausible row/param names.
registerExprFunction('noise_rms', 4, integratedNoise);
registerExprFunction(
  'pelgrom_vos',
  5,
  (avt, abeta, W, L, gm_id) => mismatch(W, L, gm_id, { avth: avt, abeta }).sigmaVos,
);
registerExprFunction(
  'pelgrom_irel',
  5,
  (avt, abeta, W, L, gm_id) => mismatch(W, L, gm_id, { avth: avt, abeta }).sigmaIrel,
);
