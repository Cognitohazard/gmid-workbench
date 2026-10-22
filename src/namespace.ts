import type { BaseQuantity, DerivedQuantity, Grid } from './types';
import { CONSTANTS, GAMMA_DEFAULT_LABEL } from './constants';

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
  { key: 'id', unit: 'A', required: true, perWidth: true, magnitude: true },
  { key: 'gm', unit: 'S', required: true, perWidth: true, magnitude: true },
  // recommended / optional
  { key: 'gds', unit: 'S', required: false, perWidth: true, magnitude: true },
  { key: 'gmb', unit: 'S', required: false, perWidth: true, magnitude: true },
  // Capacitances, named c<i><j> for terminals g, d, s, b. C_ii = ∂Q_i/∂V_i is the total
  // self-capacitance of node i, a magnitude. C_ij for i ≠ j is a transcapacitance: not
  // reciprocal (cgd is not cdg), and its sign depends on the exporter's convention (BSIM's
  // −∂Q_i/∂V_j or the plain ∂Q_i/∂V_j) and on the region, so it is kept as exported. Gate row
  // first (as the format has always listed it), then drain, source, body.
  { key: 'cgg', unit: 'F', required: false, perWidth: true, magnitude: true },
  { key: 'cgs', unit: 'F', required: false, perWidth: true },
  { key: 'cgd', unit: 'F', required: false, perWidth: true },
  { key: 'cgb', unit: 'F', required: false, perWidth: true },
  { key: 'cdb', unit: 'F', required: false, perWidth: true },
  { key: 'csb', unit: 'F', required: false, perWidth: true },
  { key: 'cdd', unit: 'F', required: false, perWidth: true, magnitude: true },
  { key: 'cdg', unit: 'F', required: false, perWidth: true },
  { key: 'cds', unit: 'F', required: false, perWidth: true },
  { key: 'css', unit: 'F', required: false, perWidth: true, magnitude: true },
  { key: 'csg', unit: 'F', required: false, perWidth: true },
  { key: 'csd', unit: 'F', required: false, perWidth: true },
  { key: 'cbb', unit: 'F', required: false, perWidth: true, magnitude: true },
  { key: 'cbg', unit: 'F', required: false, perWidth: true },
  { key: 'cbd', unit: 'F', required: false, perWidth: true },
  { key: 'cbs', unit: 'F', required: false, perWidth: true },
  // Junction capacitances: the drain- and source-to-body diodes, apart from the intrinsic
  // matrix above. Not cbd/cbs, which are transcapacitances in BSIM's own output.
  { key: 'cjd', unit: 'F', required: false, perWidth: true, magnitude: true },
  { key: 'cjs', unit: 'F', required: false, perWidth: true, magnitude: true },
  // Terminal charges, kept as exported (see BaseQuantity.magnitude).
  { key: 'qg', unit: 'C', required: false, perWidth: true },
  { key: 'qd', unit: 'C', required: false, perWidth: true },
  { key: 'qs', unit: 'C', required: false, perWidth: true },
  { key: 'qb', unit: 'C', required: false, perWidth: true },
  { key: 'vth', unit: 'V', required: false },
  { key: 'vdsat', unit: 'V', required: false },
  { key: 'w', unit: 'm', required: false, perWidth: true }, // may be metadata instead of a column
  { key: 'sth', unit: 'A^2/Hz', required: false, perWidth: true }, // thermal noise PSD
  { key: 'sfl', unit: 'A^2/Hz', required: false, perWidth: true }, // flicker noise PSD @ 1 Hz
  // thermal-noise factor γ: a stored column wins; without one it is derived from `sth` where the
  // table carries it, and is GAMMA_DEFAULT where it does not (see the `gamma` definition below).
  // `gmb` above is what separates the body effect out of the channel noise (Sid = 4kTγ·(gm + gmb)).
  { key: 'gamma', unit: '1', required: false },
  { key: 'igd', unit: 'A', required: false, perWidth: true },
  { key: 'igs', unit: 'A', required: false, perWidth: true },
];

export const BASE_KEYS: ReadonlySet<string> = new Set(BASE_QUANTITIES.map((q) => q.key));

/** Base keys that scale with device width (see BaseQuantity.perWidth). */
export const PER_WIDTH_KEYS: ReadonlySet<string> = new Set(
  BASE_QUANTITIES.filter((q) => q.perWidth).map((q) => q.key),
);

/** Value keys that are magnitudes whatever the polarity (see BaseQuantity.magnitude): folded
 *  to |value| on a declared signed PMOS export, and expected non-negative by QA. */
export const MAGNITUDE_KEYS: ReadonlySet<string> = new Set(
  BASE_QUANTITIES.filter((q) => q.magnitude).map((q) => q.key),
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

/** The γ-model figures without a `gmb` column: the body-effect term of the channel's noise
 *  conductance gm + gmb is lost. Where γ itself was read back from the stored noise against gm
 *  alone it carries that term, so the figure is still the table's own noise. Whether a stored γ
 *  column carries it depends on how the column was made, which the engine cannot know. */
const WITHOUT_GMB =
  'the floor has no body-effect term: exact where γ is read back from the stored noise, which ' +
  'then carries it, low by the factor 1 + gmb/gm in power where γ is the stand-in, and for a ' +
  'stored gamma column exact only if the column was built against gm alone';

/**
 * Standard derived quantities, each defined as an expression over the base
 * namespace + constants. The derive module evaluates these with the expression
 * engine (dogfooding it), so there is exactly one definition per quantity. A definition that
 * reads a column some tables lack may declare the next-best forms (see DerivedFallback); a
 * result that used one says so.
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
  // The thermal-noise factor γ read back from the stored PSD. In saturation the channel's noise
  // conductance is g_d0 = gm + gmb, so Sid = 4kTγ·(gm + gmb), solved here for γ at the table's own
  // temperature (T comes from its metadata). It shares its name with the engine constant `gamma`
  // (GAMMA_DEFAULT), which is its last fallback. A stored `gamma` column wins over every form, as
  // every stored column does.
  {
    key: 'gamma',
    expr: 'sth/(4*k*T*(gm+gmb))',
    unit: '1',
    fallbacks: [
      {
        without: ['gmb'],
        expr: 'sth/(4*k*T*gm)',
        says: 'γ carries the body-effect factor 1 + gmb/gm, so it reads that much above the channel’s own γ',
      },
      {
        without: ['sth'],
        expr: GAMMA_DEFAULT_LABEL,
        says: `γ is the stand-in ${GAMMA_DEFAULT_LABEL}, not the table’s own noise`,
      },
    ],
  },
  // The γ-model: the channel's thermal noise Sid = 4kTγ·(gm + gmb) referred to the gate through
  // gm. It resolves on every table and reads `gamma` as above — so on a table that carries `sth`
  // it IS the measured noise (vnth_m = sqrt(sth)/gm = vnth, with or without `gmb`), and on one that
  // does not it is the estimate at GAMMA_DEFAULT (a sub-micron stand-in, not the long-channel 2/3).
  // These are the keys sheets read, because they resolve on every table; noiseSource (derive/)
  // says per table which of the two they are.
  {
    key: 'svth_m', // input-referred thermal PSD
    expr: '4*k*T*gamma*(gm+gmb)/gm^2',
    unit: 'V^2/Hz',
    fallbacks: [{ without: ['gmb'], expr: '4*k*T*gamma/gm', says: WITHOUT_GMB }],
  },
  {
    key: 'vnth_m', // input-referred thermal density
    expr: 'sqrt(4*k*T*gamma*(gm+gmb))/gm',
    unit: 'V/sqrt(Hz)',
    fallbacks: [{ without: ['gmb'], expr: 'sqrt(4*k*T*gamma/gm)', says: WITHOUT_GMB }],
  },
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

const DERIVED_KEYS: ReadonlySet<string> = new Set(DERIVED_QUANTITIES.map((q) => q.key));

/**
 * Whether a stored column is a pass-through: an import's unknown header, carried under its
 * lower-cased name (the strict-superset rule) and read like any quantity, but with no unit,
 * width law or sign rule. A column named like a standard derived quantity is not one: lookup and
 * sizing evaluate that name from its one definition, so reporting the stored copy would put two
 * numbers under one name, and QA flags such a column as `derived-shadow` instead.
 */
export const isPassthroughKey = (key: string): boolean =>
  !BASE_KEYS.has(key) && !DERIVED_KEYS.has(key);

/** The pass-through columns a grid stores, in column order (see isPassthroughKey). */
export const passthroughKeys = (grid: Grid): string[] =>
  [...grid.quantities.keys()].filter(isPassthroughKey);

/** The names a sheet reads a sizing by beyond the namespace quantities and the selectors: `w0`,
 *  the characterization width (in SizeResult.quantities), and `ceiling` and `feasible`, the
 *  slice's gm/ID ceiling and the verdict against it — SizeResult's own fields, which the sheet
 *  engine puts in scope under these names. */
export const SIZING_SCALARS = ['w0', 'ceiling', 'feasible'] as const;

/** The block name a pass-through column's affixed name is joined to (see affixedColumn). A sheet
 *  may not name a block this, so the affixed name never reads a child's quantity. */
export const TABLE_AFFIX = 'table';

/** A pass-through column under its affixed name, `table__<column>`: the double-underscore join a
 *  sheet already reads a child's quantity by (`child__gm`), with the table in the child's place.
 *  The name a column is read under where its own name is taken. */
export const affixedColumn = (column: string): string => `${TABLE_AFFIX}__${column}`;

/** The names the engine itself means something by wherever a table is read: the expression
 *  constants (`pi`, `k`, `q`, `eps`, …) and the scalars a sizing writes beside its quantities
 *  (SIZING_SCALARS). */
const ENGINE_NAMES: ReadonlySet<string> = new Set([...Object.keys(CONSTANTS), ...SIZING_SCALARS]);

/**
 * The name a pass-through column is read under wherever a table is read — a lookup's result, a
 * sizing's quantities, a chart expression, a sheet: its own lower-cased name, or its affixed name
 * (affixedColumn) where that is one the engine means something by (ENGINE_NAMES). A column called
 * `k` would otherwise replace Boltzmann's constant in every expression that reads `k`, and one
 * called `w0` would be overwritten by the characterization width. A sheet affixes more: a column
 * whose name the sheet itself uses (see the sheet's sizing).
 */
export const passthroughName = (column: string): string =>
  ENGINE_NAMES.has(column) ? affixedColumn(column) : column;

/** The column a name passthroughName affixed reads (`k` for `table__k`), or undefined where `name`
 *  is not such a name. */
export function columnAffixedAs(name: string): string | undefined {
  const prefix = affixedColumn('');
  const column = name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
  return column !== undefined && ENGINE_NAMES.has(column) ? column : undefined;
}

/** Why a pass-through column is not read under its own name (see passthroughName), as a clause
 *  completing "... is read as table__k: ..."; undefined for a column read under its own. */
export const engineNameReason = (column: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(CONSTANTS, column)
    ? `"${column}" is an expression constant`
    : ENGINE_NAMES.has(column)
      ? `"${column}" is a scalar a sizing writes`
      : undefined;

/**
 * Header alias map: lower-cased source header -> canonical key, for the headers that are not
 * already the key they mean. Used by importers to canonicalize column names; a header that is a
 * base key needs no entry. (The vbs -> vsb mapping additionally requires a sign flip
 * vsb = -vbs, handled in canonicalization, not here.)
 */
export const ALIASES: Readonly<Record<string, string>> = {
  // currents
  ids: 'id',
  i_d: 'id',
  // geometry
  length: 'l',
  lch: 'l',
  width: 'w',
  // conductances
  gout: 'gds',
  go: 'gds',
  gmbs: 'gmb',
  // capacitances: capbd and capbs are BSIM4's names (in ngspice) for the junction capacitances.
  // (cdd and css need no entry: they are self-capacitances, keys of their own, not the cross
  // terms cdb and csb.)
  capbd: 'cjd',
  capbs: 'cjs',
  // voltages
  vt: 'vth',
  vt0: 'vth',
  vdssat: 'vdsat',
  vbs: 'vsb', // NB: vsb = -vbs (sign handled in canonicalization)
};
