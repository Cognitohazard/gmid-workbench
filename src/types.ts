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
  /**
   * Process/library namespace the device name belongs to (e.g. "sky130A"). Optional, and
   * blank on most exports — but when two files both call their device `nch`, this is the
   * only fact that says whether they are one device characterized twice or two unrelated
   * devices. Corner grouping reads it, which is why it is promoted out of `extra`.
   */
  readonly pdk?: string;
  readonly simulator?: string;
  readonly date?: string;
  readonly polarity?: Polarity;
  readonly AVT?: number; // Pelgrom threshold-mismatch constant [V·m]
  readonly ABETA?: number; // Pelgrom current-factor constant [m]
  readonly FCO?: number; // 1/f (flicker) noise corner frequency [Hz]
  /**
   * The identity fields the importer filled in because the file did not declare them, in the
   * order device, corner, temp: a device named after the file (or `dev0`), the corner `tt`, the
   * temperature 27 °C. TableId holds the filled-in value like a declared one, so this is the only
   * record that it was assumed — what QA, the condition labels, the nominal pick and every sizing
   * read to say so. Absent when the file declared all three.
   */
  readonly filled?: readonly FilledField[];
  /** Extra scalar metadata carried through verbatim (the strict-superset pass-through rule). A
   *  recognized header whose value could not be read (`# temp: 27C`) is kept here as written,
   *  under its own key, and QA names it. */
  readonly extra?: Readonly<Record<string, string | number>>;
}

/** An identity field the importer can fill in (see TableMeta.filled). */
export type FilledField = 'device' | 'corner' | 'temp';

/** Identity of a device table. A field the file did not declare holds the importer's default
 *  and is listed in TableMeta.filled. */
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
  /** The pass-through columns the grid stores, carried through verbatim: `passthroughKeys(grid)`,
   *  the namespace's one reading of which columns those are. Absent when there are none. */
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
  /** The offending symbol name when the warning is about one (e.g. the undefined
   *  name in "sheet-undeclared") — structured, so a UI can group related warnings
   *  without parsing message text. */
  readonly symbol?: string;
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
   * True for value columns that are magnitudes whatever the device's polarity: currents,
   * conductances, and a node's total self-capacitance or a junction capacitance. A signed PMOS
   * export declared `# polarity: p` has these folded to |value| on import; on an undeclared one,
   * QA flags a negative gm, gds or magnitude capacitance. Transcapacitances and terminal charges
   * carry no flag: their sign is
   * information (a transcapacitance is legitimately negative in places, and a gate charge
   * crosses zero near flat band), so they are kept as exported.
   */
  readonly magnitude?: boolean;
  /**
   * For a bias sweep axis only: the operating point a sizer may assume when a design sheet's
   * givens leave this axis undeclared — e.g. vsb = 0 (source at body, the body-grounded case
   * almost every device sits in). An axis without one (vds, set by the circuit node) has no
   * honest default and must be pinned explicitly. The default applies only when the table
   * actually characterizes that point; otherwise sizing fails closed rather than silently
   * sliding to the nearest slice.
   *
   * It is also where a table that has no such column at all is taken to have been
   * characterized: a file with no `vsb` column is a body-grounded characterization, so a device
   * given `vsb = 0` is sized on it and one given any other body bias is refused. An axis without
   * a default has no such reading — a table with no `vds` column says nothing about the drain
   * voltage it was taken at.
   */
  readonly defaultBias?: number;
}

/**
 * The next-best form of a derived quantity, for a table that lacks a column its definition
 * reads. It is used only where every form before it cannot be computed, and the result that
 * used it says so: the quantity, the missing column and this form (see the derive module's
 * fallback notes). A lesser form is never chosen silently.
 */
export interface DerivedFallback {
  /** The column(s) whose absence this form stands in for — what the note names as missing. */
  readonly without: readonly string[];
  /** The form used instead, over the base namespace + constants like the definition itself. */
  readonly expr: string;
  /** What reading the quantity this way costs, in a clause the note ends with. */
  readonly says: string;
}

/** Definition of a derived quantity as an expression over the base namespace. */
export interface DerivedQuantity {
  readonly key: string; // e.g. "gm_id", "ft", "vstar"
  readonly expr: string; // closed-form over base quantities + constants, e.g. "gm/id"
  readonly unit: string;
  /** Lesser forms in order of preference, each tried only when everything before it cannot be
   *  computed on a table. Absent for a quantity that has none: a table that cannot compute the
   *  definition cannot compute the quantity. */
  readonly fallbacks?: readonly DerivedFallback[];
}

/** A name resolver for the expression engine: base columns, derived, constants. */
export interface Scope {
  resolve(name: string): Value | undefined;
}

/** A compiled expression, evaluable against any Scope. */
export interface CompiledExpr {
  readonly src: string;
  readonly names: readonly string[]; // free identifiers referenced (for dependency/QA)
  /**
   * Per CALL SITE, the free identifiers appearing inside that call's arguments, keyed by the
   * function's name — so `abs(a - b) + abs(c)` yields `abs → [{a,b}, {c}]`. Filled during the
   * same walk that gathers `names`, so it costs nothing extra and rides the compile cache.
   *
   * It exists because a caller that wants "what is inside this call" would otherwise scan the
   * SOURCE TEXT for it, and a hand-rolled scanner is a second, worse grammar living beside the
   * real one: the first version of the sheet validator's missed `abs (x)` outright, because the
   * parser accepts a space before the paren and a literal search does not.
   */
  readonly calls: ReadonlyMap<string, readonly ReadonlySet<string>[]>;
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

/**
 * An inverse lookup that failed for THIS length in particular — the target is outside the
 * slice's reach, or the curve is too folded there to invert unambiguously. Another
 * characterized length may well work, so a caller can offer that as the next step. Structural
 * failures (a missing column, no vgs axis) are plain Errors: no length would help.
 */
export class LookupError extends Error {
  override name = 'LookupError';
}

/**
 * A per-length failure whose cause is reach. Carries the achievable range as data so a caller
 * can answer the design question this raises — "out of reach here, so at which length IS it
 * reachable?" — and re-render the numbers in its own units, without parsing the message text.
 */
export class LookupRangeError extends LookupError {
  override name = 'LookupRangeError';
  constructor(
    readonly key: string,
    readonly target: number,
    readonly min: number,
    readonly max: number,
    readonly L: number,
  ) {
    super(`inverse lookup: ${key} ${target} out of range [${min}, ${max}] for L=${L}`);
  }

  /**
   * The same failure expressed in a quantity `scale` times smaller — for a caller that
   * inverted an internally rescaled target (a per-width density) and must report the number
   * its own caller actually asked for. Rebuilt through the constructor, so there is one
   * wording for both.
   */
  rescaled(scale: number): LookupRangeError {
    return new LookupRangeError(
      this.key,
      this.target / scale,
      this.min / scale,
      this.max / scale,
      this.L,
    );
  }
}

/** The wording of `LookupRangeError`'s message, with the failing quantity as capture 1 and the
 *  target and the reachable [min, max] as captures 2-4 — for a caller that can only see the
 *  message, because the typed error was flattened into a string before reaching it. Lives beside
 *  the constructor above so the two are edited together: a reworded message that left this
 *  behind would silently stop matching. Anyone holding the error itself should read its fields
 *  instead. */
export const LOOKUP_RANGE_MESSAGE = /inverse lookup: (id|gm) (\S+) out of range \[(\S+), (\S+)\]/;
