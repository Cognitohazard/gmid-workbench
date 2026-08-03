import type { BaseQuantity, DerivedQuantity } from './types';

/**
 * The canonical base quantities — the stored vocabulary. This is the *namespace*
 * the expression engine binds to, NOT the menu of plottable charts.
 */
export const BASE_QUANTITIES: readonly BaseQuantity[] = [
  // sweep axes
  { key: 'vgs', unit: 'V', required: true, axis: true },
  { key: 'l', unit: 'm', required: false, axis: true },
  { key: 'vds', unit: 'V', required: false, axis: true },
  { key: 'vsb', unit: 'V', required: false, axis: true, defaultBias: 0 }, // body-grounded default
  // required operating-point quantities
  { key: 'id', unit: 'A', required: true, perWidth: true },
  { key: 'gm', unit: 'S', required: true, perWidth: true },
  // recommended / optional
  { key: 'gds', unit: 'S', required: false, perWidth: true },
  { key: 'gmb', unit: 'S', required: false, perWidth: true },
  { key: 'cgg', unit: 'F', required: false, perWidth: true },
  { key: 'cgs', unit: 'F', required: false, perWidth: true },
  { key: 'cgd', unit: 'F', required: false, perWidth: true },
  { key: 'cgb', unit: 'F', required: false, perWidth: true },
  { key: 'cdb', unit: 'F', required: false, perWidth: true },
  { key: 'csb', unit: 'F', required: false, perWidth: true },
  { key: 'vth', unit: 'V', required: false },
  { key: 'vdsat', unit: 'V', required: false },
  { key: 'w', unit: 'm', required: false, perWidth: true }, // may be metadata instead of a column
  { key: 'sth', unit: 'A^2/Hz', required: false, perWidth: true }, // thermal noise PSD
  { key: 'sfl', unit: 'A^2/Hz', required: false, perWidth: true }, // flicker noise PSD @ 1 Hz
  { key: 'gamma', unit: '1', required: false }, // thermal-noise factor γ (defaults to GAMMA_DEFAULT)
  { key: 'igd', unit: 'A', required: false, perWidth: true },
  { key: 'igs', unit: 'A', required: false, perWidth: true },
];

export const BASE_KEYS: ReadonlySet<string> = new Set(BASE_QUANTITIES.map((q) => q.key));

/** Base keys that scale with device width (see BaseQuantity.perWidth). */
export const PER_WIDTH_KEYS: ReadonlySet<string> = new Set(
  BASE_QUANTITIES.filter((q) => q.perWidth).map((q) => q.key),
);

/** Bias axes that carry a safe default operating point (see BaseQuantity.defaultBias),
 *  keyed by axis name — the one place an undeclared bias axis is allowed to size. */
export const AXIS_DEFAULT_BIAS: ReadonlyMap<string, number> = new Map(
  BASE_QUANTITIES.filter((q) => q.axis && q.defaultBias !== undefined).map((q) => [
    q.key,
    q.defaultBias as number,
  ]),
);

/** Keys a usable table must carry (vgs, id, gm) — every chart/lookup needs them. */
export const REQUIRED_KEYS: readonly string[] = BASE_QUANTITIES.filter((q) => q.required).map(
  (q) => q.key,
);

/**
 * Standard derived quantities, each defined as an expression over the base
 * namespace + constants. The derive module evaluates these with the expression
 * engine (dogfooding it), so there is exactly one definition per quantity.
 */
export const DERIVED_QUANTITIES: readonly DerivedQuantity[] = [
  { key: 'gm_id', expr: 'gm/id', unit: '1/V' },
  { key: 'id_w', expr: 'id/w', unit: 'A/m' },
  { key: 'gm_gds', expr: 'gm/gds', unit: 'V/V' },
  { key: 'av0', expr: 'gm/gds', unit: 'V/V' },
  { key: 'ro', expr: '1/gds', unit: 'ohm' },
  { key: 'ft', expr: 'gm/(2*pi*cgg)', unit: 'Hz' },
  { key: 'vstar', expr: '2*id/gm', unit: 'V' }, // = 2 / (gm/id)
  { key: 'gm_cgd', expr: 'gm/cgd', unit: 'rad/s' },
  { key: 'cgd_cgg', expr: 'cgd/cgg', unit: '1' },
  { key: 'gmb_gm', expr: 'gmb/gm', unit: '1' },
  { key: 'ft_eff', expr: '(gm/id)*(gm/(2*pi*cgg))', unit: 'Hz/V' }, // (gm/ID)·fT FOM
  { key: 'av0_ft', expr: '(gm/gds)*(gm/(2*pi*cgg))', unit: 'Hz' }, // gain·fT FOM
  // Input-referred channel thermal noise = Sid/gm². Falls as 1/gm, i.e. as
  // 1/(gm/ID) at fixed current — the gm/ID methodology IS the noise-efficiency axis.
  // MEASURED (preferred): from the simulator's stored drain-current PSD `sth`; only
  // resolvable when the table actually carries `sth`, so a model is never shown as data.
  { key: 'svth', expr: 'sth/(gm^2)', unit: 'V^2/Hz' }, // input-referred thermal PSD (data)
  { key: 'vnth', expr: 'sqrt(sth)/gm', unit: 'V/sqrt(Hz)' }, // input-referred thermal density (data)
  // MODEL estimate: Sid = 4kTγ·gm. Always available (needs only gm); γ from a `gamma`
  // column when present, else GAMMA_DEFAULT (a sub-micron stand-in, not the long-channel
  // 2/3). The `_m` keys + visible formula mark it as a model so it is never mistaken for
  // measured device noise.
  { key: 'svth_m', expr: '4*k*T*gamma/gm', unit: 'V^2/Hz' }, // input-referred thermal PSD (γ-model)
  { key: 'vnth_m', expr: 'sqrt(4*k*T*gamma/gm)', unit: 'V/sqrt(Hz)' }, // density (γ-model)
  // Input-referred 1/f (flicker) noise from the simulator's stored flicker PSD @ 1 Hz
  // (`sfl`). Area-domain, so unlike thermal there is no universal model default — these
  // are MEASURED-only, resolvable solely when the table carries `sfl`.
  { key: 'svfl', expr: 'sfl/(gm^2)', unit: 'V^2/Hz' }, // input-referred flicker PSD @1Hz (data)
  { key: 'vnfl', expr: 'sqrt(sfl)/gm', unit: 'V/sqrt(Hz)' }, // input-referred flicker density @1Hz (data)
  // Flicker corner: the frequency where the 1/f tail equals the thermal floor.
  // Since S_fl(f) = sfl/f and S_th = sth, they cross at f = sfl/sth — drain or
  // input-referred (both PSDs divide by gm²), data-only (needs sth and sfl).
  { key: 'fco', expr: 'sfl/sth', unit: 'Hz' },
];

/**
 * Header alias map: lower-cased source header -> canonical key. Used by importers
 * to canonicalize column names. (The vbs -> vsb mapping additionally requires a
 * sign flip vsb = -vbs, handled in canonicalization, not here.)
 */
export const ALIASES: Readonly<Record<string, string>> = {
  // currents
  ids: 'id',
  i_d: 'id',
  id: 'id',
  // geometry
  length: 'l',
  lch: 'l',
  l: 'l',
  width: 'w',
  w: 'w',
  // conductances
  gout: 'gds',
  go: 'gds',
  gds: 'gds',
  gm: 'gm',
  gmbs: 'gmb',
  gmb: 'gmb',
  // capacitances
  cgg: 'cgg',
  cgs: 'cgs',
  cgd: 'cgd',
  cgb: 'cgb',
  cdd: 'cdb',
  cdb: 'cdb',
  css: 'csb',
  csb: 'csb',
  // voltages
  vt: 'vth',
  vt0: 'vth',
  vth: 'vth',
  vdssat: 'vdsat',
  vdsat: 'vdsat',
  vgs: 'vgs',
  vds: 'vds',
  vsb: 'vsb',
  vbs: 'vsb', // NB: vsb = -vbs (sign handled in canonicalization)
  // noise / leakage
  sth: 'sth',
  sfl: 'sfl',
  gamma: 'gamma',
  igd: 'igd',
  igs: 'igs',
};
