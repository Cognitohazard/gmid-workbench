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
  { key: 'vsb', unit: 'V', required: false, axis: true },
  // required operating-point quantities
  { key: 'id', unit: 'A', required: true },
  { key: 'gm', unit: 'S', required: true },
  // recommended / optional
  { key: 'gds', unit: 'S', required: false },
  { key: 'gmb', unit: 'S', required: false },
  { key: 'cgg', unit: 'F', required: false },
  { key: 'cgs', unit: 'F', required: false },
  { key: 'cgd', unit: 'F', required: false },
  { key: 'cgb', unit: 'F', required: false },
  { key: 'cdb', unit: 'F', required: false },
  { key: 'csb', unit: 'F', required: false },
  { key: 'vth', unit: 'V', required: false },
  { key: 'vdsat', unit: 'V', required: false },
  { key: 'w', unit: 'm', required: false }, // may be metadata instead of a column
  { key: 'sth', unit: 'A^2/Hz', required: false }, // thermal noise PSD
  { key: 'sfl', unit: 'A^2/Hz', required: false }, // flicker noise PSD @ 1 Hz
  { key: 'igd', unit: 'A', required: false },
  { key: 'igs', unit: 'A', required: false },
];

export const BASE_KEYS: ReadonlySet<string> = new Set(BASE_QUANTITIES.map((q) => q.key));

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
];

export const DERIVED_KEYS: ReadonlySet<string> = new Set(DERIVED_QUANTITIES.map((q) => q.key));

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
  igd: 'igd',
  igs: 'igs',
};
