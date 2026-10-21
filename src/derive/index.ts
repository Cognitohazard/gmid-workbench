// Derived-quantity evaluation. Resolves the canonical base/axis namespace into
// engine scopes and dogfoods the expression engine to compute derived columns
// (gm/ID, fT, V*, FOMs, …). Pure, deterministic, zero DOM imports.

import type {
  CompiledExpr,
  DerivedFallback,
  DeviceTable,
  Grid,
  Scope,
  TableMeta,
  Value,
} from '../types';
import { BASE_KEYS, DERIVED_QUANTITIES } from '../namespace';
import { GAMMA_DEFAULT_LABEL, thermalScalars } from '../constants';
import { createEngine } from '../expr';

// Compile each standard derived definition once, shared across all calls.
const ENGINE = createEngine();

/** One way to compute a derived quantity: its definition, or one of its declared fallbacks. */
export interface DerivedForm {
  readonly compiled: CompiledExpr;
  /** The fallback this form is; absent on the definition itself. */
  readonly fallback?: DerivedFallback;
}

/**
 * Every standard derived quantity's forms, compiled once against the shared engine — key → its
 * definition followed by its fallbacks, in order of preference. The single compile of the
 * namespace: other modules (lookup, the sizer) evaluate these instead of compiling their own.
 */
export const DERIVED_FORMS: ReadonlyMap<string, readonly DerivedForm[]> = new Map(
  DERIVED_QUANTITIES.map(
    (q) =>
      [
        q.key,
        [
          { compiled: ENGINE.compile(q.expr) },
          ...(q.fallbacks ?? []).map((f) => ({ compiled: ENGINE.compile(f.expr), fallback: f })),
        ],
      ] as const,
  ),
);

/**
 * The form a table computes derived quantity `key` by, given what `has` holds (its stored columns
 * and scalars): the first, in order of preference, whose free names all resolve — a derived name
 * resolving when some form of it does. Undefined when `key` is not a derived quantity or no form
 * is computable. It depends on which names are present and nothing else, so a table reads a
 * quantity one way at every point, over the whole grid and at one operating point alike.
 * Constants never appear among the free names; no definition reads itself, so recursion bottoms
 * out.
 */
export function derivedForm(key: string, has: (name: string) => boolean): DerivedForm | undefined {
  return DERIVED_FORMS.get(key)?.find((f) =>
    f.compiled.names.every((n) => has(n) || derivedForm(n, has) !== undefined),
  );
}

/** Number of grid samples (= length of every materialized column). */
const gridSize = (grid: Grid): number => grid.shape.reduce((a, b) => a * b, 1);

/** What a grid holds for the derived layer: its stored columns, then the scalars passed in. */
const holds =
  (grid: Grid, scalars: Record<string, number>) =>
  (name: string): boolean =>
    grid.quantities.has(name) || Object.prototype.hasOwnProperty.call(scalars, name);

/**
 * A Scope over a grid: resolve a name to its full-length flat column.
 *
 * Resolution order: stored quantities (base + materialized axis columns) first,
 * then standard derived quantities by name — a derived key (e.g. "ft", "vstar",
 * "gm_id") resolves by evaluating, against this same scope, the form this grid computes it by
 * (see derivedForm), so derived names are usable anywhere in an expression ("ft", "ft*2",
 * "gm_id-1"), not just as a whole-expression lookup — then any scalar `scalars` passed in
 * (device-metadata scalars such as width `w`, see metaScalars). Stored columns always win, so
 * real data shadows a same-named derived or scalar. A derived quantity the grid cannot compute
 * by any form is evaluated by its definition, whose error names the missing column. Unknown
 * names return undefined (the engine then tries its constant map, else errors).
 */
export function tableScope(grid: Grid, scalars: Record<string, number> = {}): Scope {
  const has = holds(grid, scalars);
  const scope: Scope = {
    resolve(name: string): Value | undefined {
      const stored = grid.quantities.get(name);
      if (stored) return stored;
      const forms = DERIVED_FORMS.get(name);
      if (forms) {
        const form = derivedForm(name, has) ?? forms[0];
        return asColumn(form.compiled.eval(scope), gridSize(grid));
      }
      return name in scalars ? scalars[name] : undefined;
    },
  };
  return scope;
}

/**
 * The scalar counterpart of tableScope, over the values at ONE operating point: a value present
 * wins, then the form of a derived quantity those values can compute (see derivedForm), then the
 * engine's constants. It is what the forward lookup and the sizer re-derivation evaluate
 * definitions against, so a definition that reads another derived name — the γ-model keys read
 * `gamma` — sees the same value at a point as over the whole table, and a point without `gmb`
 * reads the same fallback the table does.
 */
export function pointScope(values: Record<string, number>): Scope {
  const has = (n: string): boolean => Object.prototype.hasOwnProperty.call(values, n);
  const scope: Scope = {
    resolve(name: string): Value | undefined {
      if (has(name)) return values[name];
      return derivedForm(name, has)?.compiled.eval(scope);
    },
  };
  return scope;
}

/**
 * A derived quantity a table computes by a fallback rather than its definition: the quantity, the
 * column(s) it lacks, the form used instead, and what that costs. A result evaluated on the table
 * carries these, so a lesser form is never chosen without saying so.
 */
export interface FallbackNote {
  readonly quantity: string;
  readonly missing: readonly string[];
  readonly form: string;
  readonly says: string;
}

/**
 * Every derived quantity this grid computes by a fallback, in namespace order — decided once per
 * table, by its columns (and `scalars`, its metadata; see metaScalars). A base quantity the table
 * stores (a `gamma` column) is read as stored and owes no note; a quantity it cannot compute by
 * any form is not read at all, so it owes none either.
 */
export function derivedFallbacks(grid: Grid, scalars: Record<string, number> = {}): FallbackNote[] {
  const has = holds(grid, scalars);
  const out: FallbackNote[] = [];
  for (const quantity of DERIVED_FORMS.keys()) {
    if (BASE_KEYS.has(quantity) && grid.quantities.has(quantity)) continue;
    const f = derivedForm(quantity, has)?.fallback;
    if (f) out.push({ quantity, missing: f.without, form: f.expr, says: f.says });
  }
  return out;
}

/** A fallback note as one sentence: the quantity, the form it was read by, the column that forced
 *  it, and what that costs. The words a sizing's warnings and a panel's tooltip carry. */
export function fallbackMessage(n: FallbackNote): string {
  return `${n.quantity} is read as ${n.form} because the table has no ${n.missing.join(' or ')} column — ${n.says}`;
}

/**
 * Where a table's thermal-noise figures come from. Every γ-model key (`svth_m`, `vnth_m`, and an
 * author's own math reading `gamma`) reads `gamma`, so this is one fact per table, decided by which
 * columns it stores and nothing else:
 *  - `column`: the table stores a `gamma` column, which wins as any stored column does;
 *  - `measured`: it stores `sth`, so γ is that drain noise read back through Sid = 4kTγ·(gm + gmb)
 *    at the table's temperature, and the γ-model keys equal the measured `svth`/`vnth` point for
 *    point;
 *  - `estimated`: it stores neither, and γ is GAMMA_DEFAULT.
 * Reported rather than hidden because the two readings can differ by a factor of two on real
 * data (a short-channel NMOS runs near γ = 2), and a noise figure has to say which it is. The
 * forms that stand in for a missing `gmb` are a separate fact, in derivedFallbacks.
 */
export type NoiseSource = 'column' | 'measured' | 'estimated';

export function noiseSource(grid: Grid): NoiseSource {
  if (grid.quantities.has('gamma')) return 'column';
  // A form that reads the table is a measurement; the last one reads nothing and is the stand-in.
  const form = derivedForm('gamma', (n) => grid.quantities.has(n));
  return form && form.compiled.names.length > 0 ? 'measured' : 'estimated';
}

/** A noise source in the words a result or a panel states it in, after "noise: " — `measured`,
 *  or `estimated, γ = 1.0` with the default the estimate used. */
export function noiseSourceLabel(source: NoiseSource): string {
  if (source === 'measured') return 'measured';
  if (source === 'column') return 'γ from the table';
  return `estimated, γ = ${GAMMA_DEFAULT_LABEL}`;
}

/** The thermal-noise figures: the quantities a noise source and its fallbacks are about. */
const NOISE_KEYS: ReadonlySet<string> = new Set(['gamma', 'svth_m', 'vnth_m']);

/**
 * A device's thermal noise in one line, after "noise: " — its source (noiseSourceLabel), then, for
 * each column the noise figures fell back for, the figures that did: `measured · no gmb column:
 * gamma, svth_m, vnth_m`. The γ stand-in is stated once, by the `estimated` label, so its own note
 * is not repeated. Notes about anything other than the noise figures are left to their own report.
 */
export function noiseLabel(source: NoiseSource, fallbacks: readonly FallbackNote[] = []): string {
  const byColumn = new Map<string, string[]>();
  for (const f of fallbacks) {
    if (!NOISE_KEYS.has(f.quantity)) continue;
    if (source === 'estimated' && f.quantity === 'gamma') continue;
    const column = f.missing.join(' or ');
    byColumn.set(column, [...(byColumn.get(column) ?? []), f.quantity]);
  }
  return [
    noiseSourceLabel(source),
    ...[...byColumn].map(([column, qs]) => `no ${column} column: ${qs.join(', ')}`),
  ].join(' · ');
}

/** The noise fallbacks among `fallbacks`, for a tooltip that spells out what noiseLabel names. */
export const noiseFallbacks = (fallbacks: readonly FallbackNote[]): FallbackNote[] =>
  fallbacks.filter((f) => NOISE_KEYS.has(f.quantity));

/** Broadcast a scalar engine result into a full-length grid column. */
function asColumn(v: Value, size: number): Float64Array {
  if (v instanceof Float64Array) return v;
  const out = new Float64Array(size);
  out.fill(v);
  return out;
}

// Memoize compiled expressions by source string. A CompiledExpr is immutable and its
// eval(scope) is pure, so sharing one per distinct source is safe — it collapses the
// per-sample re-parse that a sheet sweep (now over a composed child tree) would otherwise
// repeat for every identical string. The Map is unbounded, but sheet/derive expression
// strings are a small, author-fixed set, so it cannot grow without bound in practice.
const COMPILE_CACHE = new Map<string, CompiledExpr>();

/** Compile an expression (shared engine), memoized by source string for repeated evaluation. */
export function compileExpr(src: string): CompiledExpr {
  let compiled = COMPILE_CACHE.get(src);
  if (compiled === undefined) {
    compiled = ENGINE.compile(src);
    COMPILE_CACHE.set(src, compiled);
  }
  return compiled;
}

/** Evaluate an already-compiled expression over `grid`, returning a full column. */
export function evalColumn(
  grid: Grid,
  compiled: CompiledExpr,
  scalars: Record<string, number> = {},
): Float64Array {
  return asColumn(compiled.eval(tableScope(grid, scalars)), gridSize(grid));
}

/**
 * Scalar device-metadata exposed to the expression scope as named identifiers:
 * the characterization width `meta.W` → `w` (so width-relative quantities like
 * `id/w` resolve on tables that store width as metadata rather than a column),
 * and the table temperature `meta.temp` → `T`/`UT` overrides (so the γ-model
 * noise quantities and any temperature-aware author math evaluate at the table's
 * characterization temperature, not the 27 °C engine default). A stored column
 * of the same name still wins — it is resolved before scalars in tableScope.
 */
export function metaScalars(meta: TableMeta): Record<string, number> {
  const s: Record<string, number> = { ...thermalScalars(meta.temp) };
  if (meta.W !== undefined && Number.isFinite(meta.W)) s.w = meta.W;
  return s;
}

/**
 * Evaluate the derived quantity `key` over `table`'s grid, returning a
 * full-length column. Throws if `key` is not a known derived quantity.
 */
export function derive(table: DeviceTable, key: string): Float64Array {
  const forms = DERIVED_FORMS.get(key);
  if (!forms) {
    throw new Error(`derive: unknown derived quantity "${key}"`);
  }
  // A base quantity the namespace also derives (`gamma`) comes back as every expression reading
  // it sees it on this table: a stored column first. Any other name is computed by the form this
  // table reads it by (see derivedFallbacks for when that is not the definition).
  const stored = BASE_KEYS.has(key) ? table.grid.quantities.get(key) : undefined;
  if (stored) return stored;
  const scalars = metaScalars(table.meta);
  const form = derivedForm(key, holds(table.grid, scalars)) ?? forms[0];
  return evalColumn(table.grid, form.compiled, scalars);
}

/**
 * Compile + evaluate an arbitrary expression over `grid`, returning a full-length
 * column. For charting custom expressions against the base namespace + constants.
 * Table-backed callers should pass `metaScalars(table.meta)` as `scalars` so
 * width-relative (`id/w`) and temperature-dependent (T/UT) expressions evaluate
 * against the table's own metadata rather than the 27 °C engine defaults. Hot
 * loops that reuse one expression should compileExpr() once and evalColumn().
 */
export function deriveColumn(
  grid: Grid,
  exprSrc: string,
  scalars: Record<string, number> = {},
): Float64Array {
  return evalColumn(grid, compileExpr(exprSrc), scalars);
}
