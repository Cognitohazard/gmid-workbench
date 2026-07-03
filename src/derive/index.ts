// Derived-quantity evaluation. Resolves the canonical base/axis namespace into
// engine scopes and dogfoods the expression engine to compute derived columns
// (gm/ID, fT, V*, FOMs, …). Pure, deterministic, zero DOM imports.

import type { CompiledExpr, DeviceTable, Grid, Scope, TableMeta, Value } from '../types';
import { DERIVED_QUANTITIES } from '../namespace';
import { thermalScalars } from '../constants';
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
 * return undefined (the engine then tries its constant map, else errors). Derived
 * definitions reference only base quantities + scalars, so recursion bottoms out.
 */
export function tableScope(grid: Grid, scalars: Record<string, number> = {}): Scope {
  const scope: Scope = {
    resolve(name: string): Value | undefined {
      const stored = grid.quantities.get(name);
      if (stored) return stored;
      const def = DERIVED_COMPILED.get(name);
      if (def) return asColumn(def.eval(scope), gridSize(grid));
      return name in scalars ? scalars[name] : undefined;
    },
  };
  return scope;
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
