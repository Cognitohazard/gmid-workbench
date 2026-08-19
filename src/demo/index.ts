// Synthetic demo device generator. Produces a DeviceTable from a simple EKV-like
// nMOS model so the app has something to render before any real data is imported.
// Pure and deterministic: same options in => same table out. Zero DOM imports.

import type { Axis, DeviceTable } from '../types';
import { UT, PHYS, GAMMA_DEFAULT } from '../constants';
import { makeGrid, strides } from '../grid';

/** Options for the synthetic generator; every field has a physical default. */
export interface DemoOptions {
  /** Channel lengths [m]. Default: 0.18 µm, 0.5 µm, 1 µm, 2 µm. */
  lengths?: number[];
  /** Gate-source sweep [V]: inclusive min..max in `step` increments. */
  vgs?: { min: number; max: number; step: number };
  /**
   * Optional drain-source sweep [V]. When given, adds a `vds` axis with a
   * channel-length-modulation id(vds) dependence; omitted ⇒ a 2-D [l, vgs] table.
   */
  vds?: { min: number; max: number; step: number };
  /**
   * Optional source-body sweep [V]. When given, adds a `vsb` axis with a body-effect
   * threshold shift (higher vsb ⇒ higher Vth), matching a real 4-D PDK table's
   * [l, vds, vsb, vgs] shape. At vsb = 0 (body-grounded) the slice is identical to the
   * no-vsb table, so it composes with the other options without perturbing them.
   */
  vsb?: { min: number; max: number; step: number };
  /** Characterization width [m]. Default 10 µm. */
  W?: number;
}

const DEFAULT_LENGTHS = [0.18e-6, 0.5e-6, 1e-6, 2e-6];
const DEFAULT_VGS = { min: 0.0, max: 1.2, step: 0.01 };
const DEFAULT_W = 10e-6;

// EKV / model constants.
const N_SLOPE = 1.3; // subthreshold slope factor n (dimensionless)
// Gate oxide capacitance per area [F/m^2]. Exported so golden tests derive expected gate
// capacitance (cgg = W·L·Cox exactly, at every operating point) from the one model constant
// instead of re-declaring the number.
export const COX = 0.01;
const VTH0 = 0.4; // nominal threshold [V]
const ISPEC_REF = 1e-6; // specific-current scale [A] at the reference geometry W/L = 1
// Body-effect Vth slope [V/V]: Vth rises BODY_FACTOR·vsb (0 at vsb = 0). Since the
// threshold enters only through vov = vgs - vth, it is also the exact body-transconductance
// ratio gmb/gm of this model. Exported so golden tests derive expected gmb from the one
// model constant instead of re-declaring the number.
export const BODY_FACTOR = 0.2;
// Early voltage slope: VA = VA_PER_L * L [V] (∝ L). Exported so golden tests derive
// expected gds/gain from the one model constant instead of re-declaring the number.
export const VA_PER_L = 5e6;
// Flicker coefficient: input-referred 1/f PSD at 1 Hz is area-domain,
// svfl = KFLICKER/(Cox·W·L) [V²/Hz], so the stored drain PSD is sfl = svfl·gm².
// Tuned so the flicker corner fco = sfl/sth lands at a few tens of kHz on the
// default geometry — a realistic crossover for a sub-µm device.
const KFLICKER = 3e-25;

/**
 * Inclusive ascending sweep grid for `{min, max, step}`. The number of samples is
 * derived by rounding (max-min)/step so floating-point step accumulation cannot
 * drop or duplicate the endpoint; values themselves are reconstructed as
 * min + i*step to stay on a clean lattice.
 */
function sweepValues(spec: { min: number; max: number; step: number }): Float64Array {
  const { min, max, step } = spec;
  if (!(step > 0)) throw new Error('demo: vgs.step must be > 0');
  if (!(max >= min)) throw new Error('demo: vgs.max must be >= vgs.min');
  const n = Math.round((max - min) / step) + 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = min + i * step;
  return out;
}

/**
 * EKV interpolation: the normalized inversion-coefficient current as a function
 * of the (normalized) overdrive. i = ln(1 + exp(vov / (2 n U_T)))^2. This is the
 * smooth bridge from weak (exponential) to strong (square-law) inversion.
 */
function ekvCurrent(vov: number): number {
  const x = vov / (2 * N_SLOPE * UT);
  // log1p(exp(x)) computed stably for large x to avoid overflow in exp.
  const softplus = x > 30 ? x : Math.log1p(Math.exp(x));
  return softplus * softplus;
}

/**
 * Saturation operating point at overdrive `vov`: the EKV current and its closed
 * gm, plus gds = idSat/VA. These are the vds-independent factors; a vds axis (if
 * present) multiplies id and gm by the channel-length-modulation factor.
 *
 * gm = d(id)/d(vgs): with i = softplus(x)^2 and x = vov/(2 n U_T),
 * d(id)/d(vov) = ispec·sqrt(i)·sigmoid(x)/(n U_T). sigmoid→1 (weak) gives the
 * weak-inversion limit gm/id → 1/(n U_T); sqrt(i) grows in strong inversion so
 * gm/id falls.
 */
function satPoint(
  vov: number,
  ispec: number,
  VA: number,
): { idSat: number; gmSat: number; gdsSat: number } {
  const iNorm = ekvCurrent(vov);
  const idSat = ispec * iNorm;
  const x = vov / (2 * N_SLOPE * UT);
  const sig = x > 30 ? 1 : 1 / (1 + Math.exp(-x));
  const gmSat = (ispec * Math.sqrt(iNorm) * sig) / (N_SLOPE * UT);
  return { idSat, gmSat, gdsSat: idSat / VA };
}

/**
 * Generate a synthetic EKV-like nMOS DeviceTable over (l, vgs).
 *
 * Axis order is [l, vgs] (l slowest, vgs fastest), matching the row-major Grid
 * convention. Every operating-point column is finite, id > 0 everywhere, and
 * gm/id is physical: it saturates near 1/(n·U_T) in weak inversion and falls in
 * strong inversion.
 */
export function generateDemoDevice(opts: DemoOptions = {}): DeviceTable {
  const lengths = (opts.lengths ?? DEFAULT_LENGTHS).slice();
  const vgsSpec = opts.vgs ?? DEFAULT_VGS;
  const W = opts.W ?? DEFAULT_W;

  if (lengths.length === 0) throw new Error('demo: lengths must be non-empty');
  for (const L of lengths) {
    if (!(L > 0)) throw new Error('demo: every length must be > 0');
  }
  if (!(W > 0)) throw new Error('demo: W must be > 0');

  const lVals = Float64Array.from(lengths).sort();
  const vgsVals = sweepValues(vgsSpec);
  const vdsVals = opts.vds ? sweepValues(opts.vds) : undefined;
  const vsbVals = opts.vsb ? sweepValues(opts.vsb) : undefined;
  const nL = lVals.length;
  const nVgs = vgsVals.length;
  const nVds = vdsVals ? vdsVals.length : 1;
  const nVsb = vsbVals ? vsbVals.length : 1;
  const size = nL * nVds * nVsb * nVgs; // collapses to nL*nVgs when neither axis is present

  const id = new Float64Array(size);
  const gm = new Float64Array(size);
  const gds = new Float64Array(size);
  // Body transconductance gmb = ∂id/∂vbs. The threshold shift is the only path from the
  // body to the current (vov = vgs - vth, vth = vthL + BODY_FACTOR·vsb) and the
  // channel-length-modulation factor multiplies id and gm alike, so gmb = BODY_FACTOR·gm
  // exactly — well-defined whether or not the table carries a vsb axis.
  const gmb = new Float64Array(size);
  const cgg = new Float64Array(size);
  const vth = new Float64Array(size);
  const vdsat = new Float64Array(size);
  // Noise columns: a constant thermal factor γ, the channel thermal PSD
  // sth = 4kTγ·gm [A²/Hz], and the 1/f flicker PSD at 1 Hz sfl [A²/Hz]. These
  // make the data-thermal / flicker / corner (fco) derived quantities live on the
  // demo device. Clearly synthetic-model-derived (so data == the γ-model thermal
  // here) — never how a real measured import is treated.
  const gamma = new Float64Array(size);
  const sth = new Float64Array(size);
  const sfl = new Float64Array(size);
  const kT4 = 4 * PHYS.k * PHYS.T;

  for (let li = 0; li < nL; li++) {
    const L = lVals[li];
    // Slight L dependence of Vth (reverse short-channel-ish): longer L => a touch
    // higher Vth. Bounded and monotone in L so the family fans out cleanly.
    const vthL = VTH0 + 0.02 * Math.log(L / DEFAULT_LENGTHS[0] + 1);
    const ispec = ISPEC_REF * (W / L); // specific current ∝ W/L
    const VA = VA_PER_L * L; // Early voltage ∝ L
    const cggL = W * L * COX; // gate cap ∝ W·L·Cox
    // Channel-length-modulation multiplier per vds point: id (and gm) rise ~linearly with
    // vds about saturation. Depends only on (L, vds), so compute it once per L rather than
    // per (vsb, vgs) cell. null ⇒ no vds axis ⇒ factor 1.
    const factors = vdsVals ? Array.from(vdsVals, (vd) => 1 + vd / VA) : null;

    for (let si = 0; si < nVsb; si++) {
      // Body effect: source-body reverse bias raises the threshold (0 at vsb = 0, the
      // body-grounded case), so a vsb axis fans Vth up and id down at fixed vgs.
      const vthEff = vthL + (vsbVals ? BODY_FACTOR * vsbVals[si] : 0);

      for (let vi = 0; vi < nVgs; vi++) {
        const vov = vgsVals[vi] - vthEff;
        const { idSat, gmSat, gdsSat } = satPoint(vov, ispec, VA);
        // Rough saturation voltage: a thermal floor plus the positive overdrive.
        const vdsatVal = 2 * UT + Math.max(vov, 0);

        for (let di = 0; di < nVds; di++) {
          const factor = factors ? factors[di] : 1; // gds = ∂id/∂vds = idSat/VA (below)
          const flat = ((li * nVds + di) * nVsb + si) * nVgs + vi;
          const gmv = gmSat * factor;
          id[flat] = idSat * factor;
          gm[flat] = gmv;
          gmb[flat] = BODY_FACTOR * gmv;
          gds[flat] = gdsSat;
          cgg[flat] = cggL;
          vth[flat] = vthEff;
          vdsat[flat] = vdsatVal;
          gamma[flat] = GAMMA_DEFAULT;
          sth[flat] = kT4 * GAMMA_DEFAULT * gmv; // 4kTγ·gm
          sfl[flat] = (KFLICKER * gmv * gmv) / cggL; // area-domain: svfl = sfl/gm² = KFLICKER/(W·L·Cox)
        }
      }
    }
  }

  const axes: Axis[] = [
    { name: 'l', values: lVals },
    ...(vdsVals ? [{ name: 'vds', values: vdsVals }] : []),
    ...(vsbVals ? [{ name: 'vsb', values: vsbVals }] : []),
    { name: 'vgs', values: vgsVals },
  ];

  const quantities = new Map<string, Float64Array>([
    ['id', id],
    ['gm', gm],
    ['gmb', gmb],
    ['gds', gds],
    ['cgg', cgg],
    ['vth', vth],
    ['vdsat', vdsat],
    ['gamma', gamma],
    ['sth', sth],
    ['sfl', sfl],
  ]);

  const grid = makeGrid(axes, quantities);

  return {
    id: { device: 'nmos_demo', corner: 'tt', temp: 27 },
    grid,
    meta: {
      W,
      temp: 27,
      simulator: 'demo-ekv',
      polarity: { device: 'n', signedInput: false },
    },
  };
}

/**
 * The demo device recast as a signed-convention PMOS table: the voltage axes
 * (vgs, vds) are negated — values reversed so every axis stays ascending — and every
 * value column is re-ordered to match. Value columns stay magnitudes, per the import
 * convention (PMOS value columns are canonicalized to magnitudes; swept axis columns
 * stay signed). This is the cross-polarity oracle for overlay/lookup tests and the
 * signed e2e fixture.
 */
export function signedMirrorDemo(dev: DeviceTable): DeviceTable {
  const flip = new Set(['vgs', 'vds']);
  const shape = dev.grid.shape;
  const axes: Axis[] = dev.grid.axes.map((a) =>
    flip.has(a.name)
      ? { name: a.name, values: new Float64Array([...a.values].map((v) => -v).reverse()) }
      : a,
  );
  // One permutation shared by every column: a flipped dimension reads its source
  // index back-to-front (row-major strides, same convention as grid/).
  const st = strides(shape);
  const flipDim = dev.grid.axes.map((a) => flip.has(a.name));
  const size = shape.reduce((a, b) => a * b, 1);
  const srcOf = new Int32Array(size);
  for (let flat = 0; flat < size; flat++) {
    let rem = flat;
    let src = 0;
    for (let d = 0; d < shape.length; d++) {
      const i = Math.floor(rem / st[d]);
      rem -= i * st[d];
      src += (flipDim[d] ? shape[d] - 1 - i : i) * st[d];
    }
    srcOf[flat] = src;
  }
  // Only the VALUE columns need remapping — makeGrid re-materializes the axis
  // columns from the flipped axes itself, and validates every column length.
  const quantities = new Map<string, Float64Array>();
  for (const [k, col] of dev.grid.quantities) {
    if (dev.grid.axes.some((a) => a.name === k)) continue;
    const out = new Float64Array(col.length);
    for (let flat = 0; flat < col.length; flat++) out[flat] = col[srcOf[flat]];
    quantities.set(k, out);
  }
  return {
    id: { ...dev.id, device: 'pmos_demo' },
    grid: makeGrid(axes, quantities),
    meta: { ...dev.meta, polarity: { device: 'p', signedInput: true } },
  };
}

/**
 * A copy of `table` without the named quantity columns — for exercising the paths that must
 * degrade when a table simply does not carry something (measured noise, cgg, gds). Lives here
 * beside signedMirrorDemo because it is fixture shaping, not numerics; the grid is otherwise
 * untouched, so axes and shape still agree.
 */
export function withoutColumns(table: DeviceTable, keys: readonly string[]): DeviceTable {
  const quantities = new Map(table.grid.quantities);
  for (const k of keys) quantities.delete(k);
  return { ...table, grid: { ...table.grid, quantities } };
}

/**
 * A copy of `table` with named quantity columns multiplied — how a second characterization of
 * one device is made for a test: not physics, but a difference from nominal that is exactly
 * known, so a per-condition verdict can be predicted in closed form rather than read back off
 * the engine. A column the table does not carry is skipped; the grid is otherwise untouched,
 * so axes and shape still agree.
 */
export function scaleQuantities(
  table: DeviceTable,
  scale: Readonly<Record<string, number>>,
): DeviceTable {
  const quantities = new Map(table.grid.quantities);
  for (const [name, factor] of Object.entries(scale)) {
    const col = quantities.get(name);
    if (col)
      quantities.set(
        name,
        Float64Array.from(col, (v) => v * factor),
      );
  }
  return { ...table, grid: { ...table.grid, quantities } };
}
