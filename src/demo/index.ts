// Synthetic demo device generator. Produces a DeviceTable from a simple EKV-like
// nMOS model so the app has something to render before any real data is imported.
// Pure and deterministic: same options in => same table out. Zero DOM imports.

import type { Axis, DeviceTable } from '../types';
import { UT } from '../constants';
import { makeGrid } from '../grid';

/** Options for the synthetic generator; every field has a physical default. */
export interface DemoOptions {
  /** Channel lengths [m]. Default: 0.18 µm, 0.5 µm, 1 µm, 2 µm. */
  lengths?: number[];
  /** Gate-source sweep [V]: inclusive min..max in `step` increments. */
  vgs?: { min: number; max: number; step: number };
  /** Characterization width [m]. Default 10 µm. */
  W?: number;
}

const DEFAULT_LENGTHS = [0.18e-6, 0.5e-6, 1e-6, 2e-6];
const DEFAULT_VGS = { min: 0.0, max: 1.2, step: 0.01 };
const DEFAULT_W = 10e-6;

// EKV / model constants.
const N_SLOPE = 1.3; // subthreshold slope factor n (dimensionless)
const COX = 0.01; // gate oxide capacitance per area [F/m^2]
const VTH0 = 0.4; // nominal threshold [V]
const ISPEC_REF = 1e-6; // specific-current scale [A] at the reference geometry W/L = 1
const VA_PER_L = 5e6; // Early voltage slope: VA = VA_PER_L * L [V] (∝ L)

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
  const nL = lVals.length;
  const nVgs = vgsVals.length;
  const size = nL * nVgs;

  const id = new Float64Array(size);
  const gm = new Float64Array(size);
  const gds = new Float64Array(size);
  const cgg = new Float64Array(size);
  const vth = new Float64Array(size);
  const vdsat = new Float64Array(size);

  for (let li = 0; li < nL; li++) {
    const L = lVals[li];
    // Slight L dependence of Vth (reverse short-channel-ish): longer L => a touch
    // higher Vth. Bounded and monotone in L so the family fans out cleanly.
    const vthL = VTH0 + 0.02 * Math.log(L / DEFAULT_LENGTHS[0] + 1);
    const ispec = ISPEC_REF * (W / L); // specific current ∝ W/L
    const VA = VA_PER_L * L; // Early voltage ∝ L
    const cggL = W * L * COX; // gate cap ∝ W·L·Cox

    for (let vi = 0; vi < nVgs; vi++) {
      const vgs = vgsVals[vi];
      const vov = vgs - vthL;

      const iNorm = ekvCurrent(vov);
      const idVal = ispec * iNorm;

      // gm = d(id)/d(vgs). Closed EKV form: with i = softplus(x)^2 and
      // x = vov/(2 n U_T), d(id)/d(vov) = ispec * 2*softplus * sigmoid(x) / (2 n U_T)
      // = ispec * sqrt(i) * sigmoid(x) / (n U_T). sigmoid(x) -> 1 (weak) gives the
      // weak-inversion limit gm/id -> 1/(n U_T); -> sqrt(i) grows in strong
      // inversion so gm/id falls. Numerically equals the central difference.
      const x = vov / (2 * N_SLOPE * UT);
      const sig = x > 30 ? 1 : 1 / (1 + Math.exp(-x));
      const sqrtI = Math.sqrt(iNorm);
      const gmVal = (ispec * sqrtI * sig) / (N_SLOPE * UT);

      const gdsVal = idVal / VA; // small output conductance

      const flat = li * nVgs + vi;
      id[flat] = idVal;
      gm[flat] = gmVal;
      gds[flat] = gdsVal;
      cgg[flat] = cggL;
      vth[flat] = vthL;
      // Rough saturation voltage: a thermal floor plus the positive overdrive.
      vdsat[flat] = 2 * UT + Math.max(vov, 0);
    }
  }

  const axes: Axis[] = [
    { name: 'l', values: lVals },
    { name: 'vgs', values: vgsVals },
  ];

  const quantities = new Map<string, Float64Array>([
    ['id', id],
    ['gm', gm],
    ['gds', gds],
    ['cgg', cgg],
    ['vth', vth],
    ['vdsat', vdsat],
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
