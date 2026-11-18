// A second synthetic device: one EKV expression, forward current minus reverse current, that
// covers weak through strong inversion and triode through saturation with no seam. Beside the
// simpler device in ./index.ts (saturation only, gm/ID independent of the drain), this one has a
// triode region, drain-induced barrier lowering, zero current at vds = 0, and gm, gmb and gds
// that are the analytic derivatives of the one current. Its default table reaches 1.8 V on the
// gate and the drain. Pure and deterministic; zero DOM imports.

import type { Axis, DeviceTable } from '../types';
import { UT, PHYS, DEFAULT_TEMP_C, DEFAULT_CORNER } from '../constants';
import { makeGrid } from '../grid';
import { COX, sweepValues } from './index';

/**
 * The process and temperature condition a table is made at. Every field defaults to the nominal
 * device, so an empty condition is the nominal table exactly. A second condition made this way
 * moves the physics (a threshold, a mobility, a thermal voltage), which scaling a nominal table's
 * columns after the fact cannot do.
 */
export interface EkvCondition {
  /** Threshold shift [V] added to VT0(L) at every length. Default 0. */
  vtShift?: number;
  /** Factor on the specific current, standing for a mobility spread. Default 1. */
  ispecFactor?: number;
  /** Temperature [°C]. Sets the thermal voltage, and through EKV_MU_TEMP_EXP and EKV_VT_TEMPCO
   *  lowers mobility and threshold as it rises. Default 27 °C. */
  tempC?: number;
}

/** Options for the generator; every field has a default. */
export interface EkvOptions extends EkvCondition {
  /** The corner name the table's identity records. Default 'tt'. */
  corner?: string;
  /** Channel lengths [m]. Default: 0.18 µm, 0.5 µm, 1 µm, 2 µm. */
  lengths?: number[];
  /** Gate-source sweep [V], inclusive. Default 0 to 1.8 V in 10 mV steps. */
  vgs?: { min: number; max: number; step: number };
  /** Drain-source sweep [V], inclusive. Default 0 to 1.8 V in 50 mV steps. */
  vds?: { min: number; max: number; step: number };
  /** Source-body sweep [V], inclusive. Default 0 to 1 V in 50 mV steps. */
  vsb?: { min: number; max: number; step: number };
  /** Characterization width [m]. Default 10 µm. */
  W?: number;
}

export const EKV_DEFAULT_LENGTHS: readonly number[] = [0.18e-6, 0.5e-6, 1e-6, 2e-6];
export const EKV_DEFAULT_VGS = { min: 0, max: 1.8, step: 0.01 } as const;
export const EKV_DEFAULT_VDS = { min: 0, max: 1.8, step: 0.05 } as const;
// The body-bias sweep reaches 1 V because a library sheet asks for more than 0.9 V on this
// device: the two-stage cascode-compensated OTA's cascode solves its source node to about 0.902 V.
export const EKV_DEFAULT_VSB = { min: 0, max: 1, step: 0.05 } as const;
const DEFAULT_W = 10e-6;

/** Slope factor n. With the pinch-off voltage vp = (vgs + vsb − VT)/n it is also the body
 *  effect: the threshold referred to the source rises (n − 1) per volt of vsb. */
export const EKV_N = 1.3;
/** Specific current at W/L = 1 [A]. */
export const EKV_ISPEC = 1e-6;
/** Long-channel threshold at vds = 0 and vsb = 0 [V]; it rises slightly with length. */
const VT0_REF = 0.4;
/** Drain-induced barrier lowering at the reference length: VT falls this much per volt of vds. */
const SIGMA_REF = 0.06;
/** Barrier lowering falls as (L_REF/L)^SIGMA_EXP, faster than 1/L, as a short-channel effect
 *  does. With the Early voltage below, the intrinsic gain gm/gds at gm/ID = 10 and vds = 0.9 V is
 *  about 11 at 0.18 µm, 45 at 0.5 µm, 100 at 1 µm and 200 at 2 µm. */
const SIGMA_EXP = 2;
const L_REF = 0.18e-6;
/** Early voltage per metre of length: VA = EKV_VA_PER_L·L. */
export const EKV_VA_PER_L = 12e6;
/** Flicker coefficient, the same area-domain form as the simpler device. */
const KFLICKER = 3e-25;

/** Mobility falls with temperature as (T/T0)^−EKV_MU_TEMP_EXP. */
export const EKV_MU_TEMP_EXP = 1.5;
/** Threshold temperature coefficient [V/K]: VT0 falls this much per kelvin above 27 °C. */
export const EKV_VT_TEMPCO = 1e-3;

interface ResolvedCondition {
  T: number;
  ut: number;
  vtShift: number;
  ispecScale: number;
}

/**
 * A condition as the model reads it. The specific current is 2·n·µ·Cox·UT²·(W/L) in EKV, so it
 * moves with the mobility factor and the temperature exponent through µ, and with UT² through the
 * thermal voltage. In strong inversion the UT² cancels and the current goes as µ·(overdrive)², so
 * a hotter device carries less current there while its lower threshold lets it carry more in weak
 * inversion. At the nominal condition every term is exactly its nominal value.
 */
function resolveCondition(c: EkvCondition): ResolvedCondition {
  const tempC = c.tempC ?? DEFAULT_TEMP_C;
  const T = tempC + 273.15;
  const nominalT = tempC === DEFAULT_TEMP_C;
  const ut = nominalT ? UT : (PHYS.k * T) / PHYS.q;
  const mu = nominalT ? 1 : Math.pow(T / PHYS.T, -EKV_MU_TEMP_EXP);
  const utSq = nominalT ? 1 : (ut / UT) ** 2;
  return {
    T: nominalT ? PHYS.T : T,
    ut,
    vtShift: (c.vtShift ?? 0) - (nominalT ? 0 : EKV_VT_TEMPCO * (T - PHYS.T)),
    ispecScale: (c.ispecFactor ?? 1) * mu * utSq,
  };
}

/** Threshold at vds = 0, vsb = 0 [V] for length L, at the nominal condition. */
export const ekvVt0 = (L: number): number => VT0_REF + 0.02 * Math.log(L / L_REF + 1);
/** Barrier-lowering coefficient [V/V] for length L: falls as 1/L². */
export const ekvSigma = (L: number): number => SIGMA_REF * (L_REF / L) ** SIGMA_EXP;
/** Early voltage [V] for length L. */
export const ekvVa = (L: number): number => EKV_VA_PER_L * L;

const softplus = (x: number): number => (x > 30 ? x : Math.log1p(Math.exp(x)));
const sigmoid = (x: number): number => (x > 30 ? 1 : 1 / (1 + Math.exp(-x)));

/** The device at one bias point, every quantity from the one expression. */
export interface EkvPoint {
  id: number;
  gm: number;
  gmb: number;
  gds: number;
  /** Forward and reverse normalized currents, F(vp − vsb) and F(vp − vsb − vds). */
  iF: number;
  iR: number;
  /** The channel-length-modulation factor 1 + vds/VA. */
  clm: number;
  vth: number;
  vdsat: number;
  sth: number;
}

/**
 * The model at one point (an n-type device; voltages in volts, SI throughout):
 *
 *   id = Ispec·(W/L)·[F(vp − vsb) − F(vp − vsb − vds)]·(1 + vds/VA)
 *   F(v) = ln²(1 + exp(v/2UT)),  vp = (vgs + vsb − VT)/n,  VT = VT0(L) − σ(L)·vds
 *
 * gm, gmb and gds are its analytic partial derivatives (gmb = ∂id/∂vbs = −∂id/∂vsb).
 */
export function ekvPoint(
  L: number,
  W: number,
  vgs: number,
  vds: number,
  vsb: number,
  condition: EkvCondition = {},
): EkvPoint {
  const c = resolveCondition(condition);
  const ut = c.ut;
  const n = EKV_N;
  const ispec = EKV_ISPEC * c.ispecScale * (W / L);
  const sigma = ekvSigma(L);
  const VA = ekvVa(L);
  const VT = ekvVt0(L) + c.vtShift - sigma * vds;
  const vp = (vgs + vsb - VT) / n;
  const xf = (vp - vsb) / (2 * ut);
  const xr = (vp - vsb - vds) / (2 * ut);
  const sf = softplus(xf);
  const sr = softplus(xr);
  const iF = sf * sf;
  const iR = sr * sr;
  // F'(v) = 2·softplus(x)·sigmoid(x)·dx/dv = softplus·sigmoid/UT. qf and qr are the same
  // derivative times UT: the normalized source-side and drain-side conductances.
  const qf = sf * sigmoid(xf);
  const qr = sr * sigmoid(xr);
  const dF = (qf - qr) / ut;
  const clm = 1 + vds / VA;
  const diff = iF - iR;
  const id = ispec * diff * clm;
  // ∂(vp − vsb)/∂vgs = 1/n for both terms.
  const gm = (ispec * clm * dF) / n;
  // ∂(vp − vsb)/∂vsb = 1/n − 1 for both terms, so gmb = −∂id/∂vsb = (n − 1)·gm, from the
  // same expression rather than set by a separate constant.
  const gmb = ispec * clm * dF * (1 - 1 / n);
  // ∂(vp − vsb)/∂vds = σ/n (barrier lowering); ∂(vp − vsb − vds)/∂vds = σ/n − 1; and the
  // channel-length-modulation factor contributes diff/VA.
  const gds = ispec * ((clm * ((qf * sigma) / n - qr * (sigma / n - 1))) / ut + diff / VA);

  // Threshold: the gate-source voltage at which the pinch-off voltage equals the source voltage,
  // vp = vsb, i.e. vgs = VT + (n − 1)·vsb — barrier lowering through VT, the body effect
  // through (n − 1)·vsb.
  const vth = VT + (n - 1) * vsb;
  // Saturation voltage: the EKV interpolation 2·UT·sqrt(iF + 1/4) + 3·UT. In strong inversion
  // 2·UT·sqrt(iF) tends to vp − vsb, the pinch-off voltage above the source; in weak inversion
  // it tends to 4·UT, where the reverse current has fallen to e⁻⁴ of the forward one.
  const vdsat = 2 * ut * Math.sqrt(iF + 0.25) + 3 * ut;

  // Channel thermal noise. Integrating the channel's local conductance noise along a charge-based
  // channel (normalized current i = q² + q, with q the normalized inversion charge) gives
  //   Sid = 4kT·(Ispec/UT)·[(2/3)(qs² + qs·qd + qd²) + (qs + qd)/2] / (qs + qd + 1)
  // which is 4kT times the channel conductance at vds = 0 (qs = qd), 2q·id in weak-inversion
  // saturation, and (2/3)·4kT·gms in strong-inversion saturation. The source- and drain-side
  // charges are read as this model's own normalized conductances qf and qr, so the vds = 0 limit
  // is exactly 4kT·gds: the thermal noise of the channel's conductance, never zero. It carries
  // the channel-length-modulation factor like every other current-like quantity.
  const N = ((2 / 3) * (qf * qf + qf * qr + qr * qr) + (qf + qr) / 2) / (qf + qr + 1);
  const sth = 4 * PHYS.k * c.T * (ispec / ut) * N * clm;
  // No γ column is stored: the namespace reads γ back from sth as sth/(4kT·(gm + gmb)), so every
  // noise figure a sheet reads is this sth. Where gm and gmb are 0 (vds = 0) that γ is 0/0, which
  // is the honest reading of a channel that carries no current.

  return { id, gm, gmb, gds, iF, iR, clm, vth, vdsat, sth };
}

/**
 * Generate the device table over [l, vds, vsb, vgs] (l slowest, vgs fastest), row-major like
 * every Grid. At vds = 0 the table holds id and gm exactly 0 and gds positive, which is what a
 * simulator exports. gm/ID is 0/0 there: the lookup drops such nodes and refuses a slice that
 * has none left.
 */
export function generateEkvDevice(opts: EkvOptions = {}): DeviceTable {
  const lengths = (opts.lengths ?? EKV_DEFAULT_LENGTHS).slice();
  const W = opts.W ?? DEFAULT_W;
  if (lengths.length === 0) throw new Error('ekv: lengths must be non-empty');
  for (const L of lengths) if (!(L > 0)) throw new Error('ekv: every length must be > 0');
  if (!(W > 0)) throw new Error('ekv: W must be > 0');

  const condition: EkvCondition = {
    vtShift: opts.vtShift,
    ispecFactor: opts.ispecFactor,
    tempC: opts.tempC,
  };
  if (opts.ispecFactor !== undefined && !(opts.ispecFactor > 0))
    throw new Error('ekv: ispecFactor must be > 0');
  const tempC = opts.tempC ?? DEFAULT_TEMP_C;
  if (!(tempC > -273.15)) throw new Error('ekv: tempC must be above absolute zero');
  const corner = opts.corner ?? DEFAULT_CORNER;

  const lVals = Float64Array.from(lengths).sort();
  const vdsVals = sweepValues(opts.vds ?? EKV_DEFAULT_VDS);
  const vsbVals = sweepValues(opts.vsb ?? EKV_DEFAULT_VSB);
  const vgsVals = sweepValues(opts.vgs ?? EKV_DEFAULT_VGS);
  const nL = lVals.length;
  const nVds = vdsVals.length;
  const nVsb = vsbVals.length;
  const nVgs = vgsVals.length;
  const size = nL * nVds * nVsb * nVgs;

  const names = ['id', 'gm', 'gmb', 'gds', 'cgg', 'vth', 'vdsat', 'sth', 'sfl'] as const;
  const cols = Object.fromEntries(names.map((k) => [k, new Float64Array(size)])) as Record<
    (typeof names)[number],
    Float64Array
  >;

  let flat = 0;
  for (let li = 0; li < nL; li++) {
    const L = lVals[li];
    const cggL = W * L * COX;
    for (let di = 0; di < nVds; di++) {
      for (let si = 0; si < nVsb; si++) {
        for (let vi = 0; vi < nVgs; vi++, flat++) {
          const p = ekvPoint(L, W, vgsVals[vi], vdsVals[di], vsbVals[si], condition);
          cols.id[flat] = p.id;
          cols.gm[flat] = p.gm;
          cols.gmb[flat] = p.gmb;
          cols.gds[flat] = p.gds;
          cols.cgg[flat] = cggL;
          cols.vth[flat] = p.vth;
          cols.vdsat[flat] = p.vdsat;
          cols.sth[flat] = p.sth;
          // Flicker drain PSD at 1 Hz: the input-referred area-domain form KFLICKER/(W·L·Cox)
          // times gm². Exactly 0 where gm is, at vds = 0, as a simulator writes it where no
          // current flows.
          cols.sfl[flat] = (KFLICKER * p.gm * p.gm) / cggL;
        }
      }
    }
  }

  const axes: Axis[] = [
    { name: 'l', values: lVals },
    { name: 'vds', values: vdsVals },
    { name: 'vsb', values: vsbVals },
    { name: 'vgs', values: vgsVals },
  ];
  const grid = makeGrid(axes, new Map(names.map((k) => [k, cols[k]])));
  return {
    id: { device: 'nmos_ekv', corner, temp: tempC },
    grid,
    meta: {
      W,
      temp: tempC,
      simulator: 'demo-ekv-full',
      polarity: { device: 'n', signedInput: false },
    },
  };
}
