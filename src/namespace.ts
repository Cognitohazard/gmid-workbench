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
  // thermal-noise factor γ: a stored column wins; without one it is derived from `sth` where the
  // table carries it, and is GAMMA_DEFAULT where it does not (see the `gamma` definition below)
  { key: 'gamma', unit: '1', required: false },
  { key: 'igd', unit: 'A', required: false, perWidth: true },
  { key: 'igs', unit: 'A', required: false, perWidth: true },
];

export const BASE_KEYS: ReadonlySet<string> = new Set(BASE_QUANTITIES.map((q) => q.key));

/** Base keys that scale with device width (see BaseQuantity.perWidth). */
export const PER_WIDTH_KEYS: ReadonlySet<string> = new Set(
  BASE_QUANTITIES.filter((q) => q.perWidth).map((q) => q.key),
);

/** Base keys swept as grid coordinates rather than measured as values (see
 *  BaseQuantity.axis). An axis coordinate is signed — a PMOS export sweeps vgs and vds
 *  negative — where a value column has been canonicalized to a magnitude, so the two
 *  cannot share the checks that assume positivity. */
export const AXIS_KEYS: ReadonlySet<string> = new Set(
  BASE_QUANTITIES.filter((q) => q.axis).map((q) => q.key),
);

/** Bias axes that carry a safe default operating point (see BaseQuantity.defaultBias),
 *  keyed by axis name — the one place an undeclared bias axis is allowed to size, and the point
 *  a table with no such column at all is taken to have been characterized at. */
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
  // The thermal-noise factor γ read back from the stored PSD: Sid = 4kTγ·gm solved for γ, at the
  // table's own temperature (T comes from its metadata). It shares its name with the engine
  // constant `gamma` (GAMMA_DEFAULT), and that constant is its default: on a table without `sth`
  // the name resolves to the constant instead (see DEFAULTED_DERIVED in derive/). A stored `gamma`
  // column wins over both, as every stored column does.
  { key: 'gamma', expr: 'sth/(4*k*T*gm)', unit: '1' },
  // The γ-model: Sid = 4kTγ·gm. Always available (needs only gm), and it reads `gamma` as above —
  // so on a table that carries `sth` it IS the measured noise (vnth_m = sqrt(sth)/gm = vnth), and
  // on one that does not it is the estimate at GAMMA_DEFAULT (a sub-micron stand-in, not the
  // long-channel 2/3). These are the keys sheets read, because they resolve on every table;
  // noiseSource (derive/) says per table which of the two they are.
  { key: 'svth_m', expr: '4*k*T*gamma/gm', unit: 'V^2/Hz' }, // input-referred thermal PSD
  { key: 'vnth_m', expr: 'sqrt(4*k*T*gamma/gm)', unit: 'V/sqrt(Hz)' }, // input-referred density
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
