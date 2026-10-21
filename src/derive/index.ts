// Derived-quantity evaluation. Resolves the canonical base/axis namespace into
// engine scopes and dogfoods the expression engine to compute derived columns
// (gm/ID, fT, V*, FOMs, …). Pure, deterministic, zero DOM imports.

import type { CompiledExpr, DeviceTable, Grid, Scope, TableMeta, Value } from '../types';
import { DERIVED_QUANTITIES } from '../namespace';
import { CONSTANTS, GAMMA_DEFAULT, thermalScalars } from '../constants';
import { createEngine } from '../expr';

// Compile each standard derived definition once, shared across all calls.
const ENGINE = createEngine();

/**
 * Every standard derived quantity, compiled once against the shared engine —
 * key → CompiledExpr. The single compile of the namespace: other modules (e.g.
 * lookup) evaluate these instead of re-compiling their own copies.
 */
export const DERIVED_COMPILED: ReadonlyMap<string, CompiledExpr> = new Map(
  DERIVED_QUANTITIES.map((q) => [q.key, ENGINE.compile(q.expr)] as const),
);

/**
 * The derived quantities that share their name with an engine constant. The constant is the
 * quantity's DEFAULT: where a table carries what the definition reads, the name resolves to the
 * definition, and where it does not, the name is left to the constant map. Today that is `gamma`
 * — the table's own thermal noise where it stores `sth`, GAMMA_DEFAULT where it does not — so
 * every expression reading `gamma` (the γ-model keys, a sheet's own noise math) follows the data
 * without being written twice. Any other derived quantity a table cannot compute stays an error.
 */
export const DEFAULTED_DERIVED: ReadonlySet<string> = new Set(
  DERIVED_QUANTITIES.filter((q) => Object.prototype.hasOwnProperty.call(CONSTANTS, q.key)).map(
    (q) => q.key,
  ),
);

/** Whether every free name of a derived definition resolves, given what `has` holds — a derived
 *  name counting when its own definition does. Constants never appear among the free names. */
function computable(names: readonly string[], has: (name: string) => boolean): boolean {
  return names.every((n) => {
    if (has(n)) return true;
    const def = DERIVED_COMPILED.get(n);
    return def !== undefined && computable(def.names, has);
  });
}

/** Number of grid samples (= length of every materialized column). */
const gridSize = (grid: Grid): number => grid.shape.reduce((a, b) => a * b, 1);

/**
 * A Scope over a grid: resolve a name to its full-length flat column.
 *
 * Resolution order: stored quantities (base + materialized axis columns) first,
 * then standard derived quantities by name — a derived key (e.g. "ft", "vstar",
 * "gm_id") resolves by evaluating its definition against this same scope, so
 * derived names are usable anywhere in an expression ("ft", "ft*2", "gm_id-1"),
 * not just as a whole-expression lookup — then any scalar `scalars` passed in
 * (device-metadata scalars such as width `w`, see metaScalars). Stored columns
 * always win, so real data shadows a same-named derived or scalar. Unknown names
 * return undefined (the engine then tries its constant map, else errors), and so does
 * a DEFAULTED_DERIVED name this grid cannot compute, which leaves it to its constant.
 * A definition may read another derived name; none reads itself, so recursion bottoms out.
 */
export function tableScope(grid: Grid, scalars: Record<string, number> = {}): Scope {
  const has = (n: string): boolean => grid.quantities.has(n) || n in scalars;
  const scope: Scope = {
    resolve(name: string): Value | undefined {
      const stored = grid.quantities.get(name);
      if (stored) return stored;
      const def = DERIVED_COMPILED.get(name);
      if (def && (!DEFAULTED_DERIVED.has(name) || computable(def.names, has)))
        return asColumn(def.eval(scope), gridSize(grid));
      return name in scalars ? scalars[name] : undefined;
    },
  };
  return scope;
}

/**
 * The scalar counterpart of tableScope, over the values at ONE operating point: a value present
 * wins, then a derived definition those values can compute, then the engine's constants. It is
 * what the forward lookup and the sizer re-derivation evaluate definitions against, so a
 * definition that reads another derived name — the γ-model keys read `gamma` — sees the same
 * value at a point as over the whole table, instead of the constant a plain scalar scope falls
 * back to.
 */
export function pointScope(values: Record<string, number>): Scope {
  const has = (n: string): boolean => Object.prototype.hasOwnProperty.call(values, n);
  const scope: Scope = {
    resolve(name: string): Value | undefined {
      if (has(name)) return values[name];
      const def = DERIVED_COMPILED.get(name);
      return def && computable(def.names, has) ? def.eval(scope) : undefined;
    },
  };
  return scope;
}

/**
 * Where a table's thermal-noise figures come from. Every γ-model key (`svth_m`, `vnth_m`, and an
 * author's own `4*k*T*gamma/gm`) reads `gamma`, so this is one fact per table, decided by which
 * columns it stores and nothing else:
 *  - `column`: the table stores a `gamma` column, which wins as any stored column does;
 *  - `measured`: it stores `sth`, so γ is that drain noise read back through Sid = 4kTγ·gm at the
 *    table's temperature, and the γ-model keys equal the measured `svth`/`vnth` point for point;
 *  - `estimated`: it stores neither, and γ is GAMMA_DEFAULT.
 * Reported rather than hidden because the two readings can differ by a factor of two on real
 * data (a short-channel NMOS runs near γ = 2), and a noise figure has to say which it is.
 */
export type NoiseSource = 'column' | 'measured' | 'estimated';

export function noiseSource(grid: Grid): NoiseSource {
  if (grid.quantities.has('gamma')) return 'column';
  const def = DERIVED_COMPILED.get('gamma');
  return def && computable(def.names, (n) => grid.quantities.has(n)) ? 'measured' : 'estimated';
}

/** A noise source in the words a result or a panel states it in, after "noise: " — `measured`,
 *  or `estimated, γ = 1.0` with the default the estimate used. */
export function noiseSourceLabel(source: NoiseSource): string {
  if (source === 'measured') return 'measured';
  if (source === 'column') return 'γ from the table';
  const g = Number.isInteger(GAMMA_DEFAULT) ? GAMMA_DEFAULT.toFixed(1) : String(GAMMA_DEFAULT);
  return `estimated, γ = ${g}`;
}

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
  const compiled = DERIVED_COMPILED.get(key);
  if (!compiled) {
    throw new Error(`derive: unknown derived quantity "${key}"`);
  }
  // A defaulted quantity is read by NAME, so it comes back exactly as every expression reading it
  // sees it on this table: a stored column, else the definition, else the constant.
  if (DEFAULTED_DERIVED.has(key))
    return evalColumn(table.grid, compileExpr(key), metaScalars(table.meta));
  return evalColumn(table.grid, compiled, metaScalars(table.meta));
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
