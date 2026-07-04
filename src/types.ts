// The shared spine: canonical types every module builds against. Zero DOM imports.

/** A scalar or a flat numeric column (one value per grid sample). */
export type Value = number | Float64Array;

/** One sweep axis of a device table; values sorted strictly ascending. */
export interface Axis {
  readonly name: string; // canonical axis key: "l" | "vgs" | "vds" | "vsb"
  readonly values: Float64Array; // ascending, length >= 1
}

/**
 * Dense N-D grid on typed arrays. Quantities are stored flat in row-major order
 * over `axes` (first axis varies slowest, last axis fastest). Every column length
 * equals the product of axis lengths (= prod(shape)).
 */
export interface Grid {
  readonly axes: readonly Axis[];
  readonly shape: readonly number[]; // axes.map(a => a.values.length)
  readonly quantities: ReadonlyMap<string, Float64Array>; // canonical key -> flat column
}

/** Polarity record kept after canonicalizing PMOS sign conventions. */
export interface Polarity {
  readonly device: 'n' | 'p';
  readonly signedInput: boolean; // true if the source columns were signed (e.g. PMOS)
}

/** Per-table scalar metadata (not grid axes). */
export interface TableMeta {
  readonly W?: number; // characterization width [m]
  readonly temp?: number; // [°C]
  readonly simulator?: string;
  readonly date?: string;
  readonly polarity?: Polarity;
  readonly AVT?: number; // Pelgrom threshold-mismatch constant [V·m]
  readonly ABETA?: number; // Pelgrom current-factor constant [m]
  readonly FCO?: number; // 1/f (flicker) noise corner frequency [Hz]
  /** Extra scalar metadata carried through verbatim (the strict-superset pass-through rule). */
  readonly extra?: Readonly<Record<string, string | number>>;
}

/** Identity of a device table. */
export interface TableId {
  readonly device: string;
  readonly corner: string;
  readonly temp: number; // [°C], default 27
}

/** One characterized device table: a grid plus identity and metadata. */
export interface DeviceTable {
  readonly id: TableId;
  readonly grid: Grid;
  readonly meta: TableMeta;
  /** Column keys present beyond the canonical namespace, carried through verbatim. */
  readonly passthrough?: ReadonlySet<string>;
}

/** A parsed dataset: one or more device tables, plus any QA warnings. */
export interface Dataset {
  readonly tables: readonly DeviceTable[];
  readonly warnings: readonly QAWarning[];
}

export type Severity = 'info' | 'warning' | 'error';

export interface QAWarning {
  readonly rule: string; // e.g. "vgs-step", "gm-id-ceiling", "non-monotonic"
  readonly severity: Severity;
  readonly message: string;
  readonly location?: string; // human-readable: file, row, or quantity
}

export interface ImportError {
  readonly kind: string;
  readonly message: string;
  readonly location?: string;
}

export type ImportResult =
  | { readonly ok: true; readonly dataset: Dataset }
  | { readonly ok: false; readonly errors: readonly ImportError[] };

export interface ImportHints {
  readonly filename?: string;
  readonly device?: string;
  readonly corner?: string;
}

/** Definition of a canonical base quantity. */
export interface BaseQuantity {
  readonly key: string; // canonical, lower-case, e.g. "gm", "id", "vgs"
  readonly unit: string; // SI unit string, e.g. "S", "A", "V", "F"
  readonly required: boolean;
  readonly axis?: boolean; // true if it is a sweep axis (vgs, l, vds, vsb)
  /**
   * True for quantities proportional to device width under the parallel-composition
   * model (a device of width k·w0 behaves as k characterized unit devices in
   * parallel): currents, (trans)conductances, capacitances, current-noise PSDs — and
   * the width itself. Voltages and ratios are intensive and carry no flag. Sizing
   * uses this to rescale an operating point from the characterization width to the
   * sized width, so author math over gds/cgg reads the SIZED device.
   */
  readonly perWidth?: boolean;
  /**
   * For a bias sweep axis only: the operating point a sizer may assume when a design sheet's
   * bind leaves this axis undeclared — e.g. vsb = 0 (source at body, the body-grounded case
   * almost every device sits in). An axis without one (vds, set by the circuit node) has no
   * honest default and must be pinned explicitly. The default applies only when the table
   * actually characterizes that point; otherwise sizing fails closed rather than silently
   * sliding to the nearest slice.
   */
  readonly defaultBias?: number;
}

/** Definition of a derived quantity as an expression over the base namespace. */
export interface DerivedQuantity {
  readonly key: string; // e.g. "gm_id", "ft", "vstar"
  readonly expr: string; // closed-form over base quantities + constants, e.g. "gm/id"
  readonly unit: string;
}

/** A name resolver for the expression engine: base columns, derived, constants. */
export interface Scope {
  resolve(name: string): Value | undefined;
}

/** A compiled expression, evaluable against any Scope. */
export interface CompiledExpr {
  readonly src: string;
  readonly names: readonly string[]; // free identifiers referenced (for dependency/QA)
  eval(scope: Scope): Value;
}

/** The expression-engine surface (jsep-backed implementation lives in src/expr). */
export interface ExprEngine {
  /** Parse + validate once; throws ExprError on syntax / unknown function. */
  compile(src: string): CompiledExpr;
  /** Convenience: compile + evaluate. */
  evaluate(src: string, scope: Scope): Value;
}

export class ExprError extends Error {
  override name = 'ExprError';
}
