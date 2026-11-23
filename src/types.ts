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
   * The identity fields the importer filled in because the file did not declare them: `device`
   * when the table is named after the file (or `dev0`), then each condition dimension given its
   * fill value (by default the corner `tt` and the temperature 27 °C), under the dimension's
   * name. The table's identity holds a filled-in value like a declared one, so this is the only
   * record that it was assumed — what QA, the condition labels, the nominal pick and every
   * sizing read to say so. `temp` is listed whenever the file gave no temperature, whether or
   * not temperature is a condition dimension, because the engine still reads one (tableTempC).
   * Absent when nothing was filled in.
   */
  readonly filled?: readonly FilledField[];
  /** The condition dimensions of the import that the file did not declare and that have no fill,
   *  so the table's condition leaves them out and QA warns. Absent when none was left out. */
  readonly unset?: readonly string[];
  /** Extra scalar metadata carried through verbatim (the strict-superset pass-through rule). A
   *  recognized header whose value could not be read (`# temp: 27C`) is kept here as written,
   *  under its own key, and QA names it. */
  readonly extra?: Readonly<Record<string, string | number>>;
}

/** An identity field the importer can fill in (see TableMeta.filled): `device`, or the name of
 *  a condition dimension. */
export type FilledField = string;

/** One value of a condition dimension: text (a corner) or a number (a temperature, a supply). */
export type ConditionValue = string | number;

/**
 * One characterization condition: a value for each named dimension, e.g.
 * `{ corner: 'tt', temp: 27, vdd: 1.8 }`. Which dimensions there are is the designer's choice;
 * corner and temperature are the defaults. Compare and name keys only through `conditionKeyOf`,
 * `sameCondition` and `conditionKeyId`.
 */
export type ConditionKey = Readonly<Record<string, ConditionValue>>;

/** A condition dimension the importer resolves for every table: from a hint, else the file's
 *  `# name: value` header, else `fill` (recorded in TableMeta.filled). With no fill and nothing
 *  declaring it, the table's condition leaves the dimension out and QA says so. */
export interface ConditionDimension {
  readonly name: string;
  readonly kind: 'text' | 'number';
  readonly unit?: string;
  readonly fill?: ConditionValue;
}

/**
 * Identity of a device table: the device and the condition it was characterized at, in the
 * file's own spelling (`conditionKeyOf` canonicalizes). A field the file did not declare holds
 * the importer's fill and is listed in TableMeta.filled.
 *
 * The second form is how tables stored before conditions were records hold their identity; it
 * stays valid as written. Read a table's condition through `conditionOf`, never a field.
 */
export type TableId =
  | { readonly device: string; readonly condition: ConditionKey }
  | { readonly device: string; readonly corner: string; readonly temp: number };

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
  /** For a finding that follows from another rather than standing on its own: the path of the
   *  composed block (`bias`, `amp.s1`) whose outputs were withheld — it did not settle, or was
   *  not evaluated — and that this finding traces back to. A reader fixes the block's own
   *  findings and these go with them. At the top of a sheet tree it may instead name a solved
   *  param of that sheet whose search did not land, which withholds what reads it (see the sheet
   *  result's `withheld`). Absent for a finding that stands on its own. */
  readonly cause?: string;
  /** What the finding is about, as data, for the item it is given to (see FindingAbout). Absent
   *  for a finding whose sentence is all that it says. */
  readonly about?: FindingAbout;
}

/**
 * What one error finding is about, by its kind:
 *  - `decision`: the sheet's statements leave values without one decision (`missing`), with two
 *    (`twice`), or in a loop no statement solves (`loop`); the names it is about.
 *  - `netlist`: a problem of the netlist check, and the wires and devices it names.
 *  - `entry`: one field of an entry that is not well formed: the field, the value as the sheet
 *    writes it (absent where the field is missing), and for a field that maps names (a block's
 *    params, a range end's set) the key.
 */
export type FindingAbout =
  | {
      readonly kind: 'decision';
      readonly decision: 'missing' | 'twice' | 'loop';
      readonly names: readonly string[];
    }
  | ({ readonly kind: 'netlist' } & NetlistAbout)
  | EntryAbout;

/** One field of an entry that is not well formed (FindingAbout `entry`): the field, the value as
 *  the sheet writes it, the key for a field that maps names, and what is wrong with it. */
export interface EntryAbout {
  readonly kind: 'entry';
  readonly field: string;
  readonly value?: unknown;
  readonly key?: string;
  readonly problem: EntryProblem;
  /** For a field that marks a param the engine solves (problem `solved`): the relation that solves
   *  it, a design constraint or a solve-for. */
  readonly relation?: 'designConstraint' | 'solveFor';
}

/** What is wrong with one field: not a number; a name that is not the entry it must name; a value
 *  the engine solves, so the field cannot set it; an expression that does not parse; a sign that is
 *  not +1 or -1; a convention not known; a reference to no sheet; an operator not known. */
export type EntryProblem =
  | 'not-a-number'
  | 'unknown-name'
  | 'solved'
  | 'syntax'
  | 'sign'
  | 'convention'
  | 'no-sheet'
  | 'operator';

/** The problems of the netlist check that name the wires or devices they are about. */
export type NetlistProblem =
  | 'short'
  | 'wire-name'
  | 'one-terminal'
  | 'level-unnamed'
  | 'unwired'
  | 'diode-flag'
  | 'placement'
  | 'selector'
  | 'level-refused'
  | 'level-gate'
  | 'other';

/** What one finding of the netlist check is about (FindingAbout `netlist`). */
export interface NetlistAbout {
  readonly problem: NetlistProblem;
  readonly wires?: readonly string[];
  readonly devices?: readonly string[];
  /** For a selector the table contradicts: the param. */
  readonly param?: string;
  /** For a diode flag the wires contradict: the flag as the givens state it. */
  readonly diodeFlag?: boolean;
  /** For a level the sheet gives a wire that cannot hold it: the level, as written. */
  readonly level?: string;
  /** For a problem that names no wire or device (`other`): where its finding is located. */
  readonly where?: string;
  /** For a placement that is not well formed: which fault it is (PlacementFault). */
  readonly placement?: PlacementFault;
  /** For a level the sheet gives a wire that cannot hold it: why, one entry for each reason. */
  readonly refused?: readonly LevelRefusal[];
}

/** Why a level cannot hold a wire (NetlistAbout `refused`), one entry for each name the level's
 *  expression itself reads and may not: a param marked other than independent (assumed, solved by
 *  the engine, re-solved where the design is held, or with no mark), with, for one a hold re-solves,
 *  the device whose gate the hold keeps; a name that names nothing on the sheet; a quantity of a
 *  device; an equation; an analysis. A name that only stands for another (a block param its parent
 *  overrides, a scalar a child provides) is followed to what it stands for; a loop of such names is
 *  `cycle`. */
export type LevelRefusal =
  | {
      readonly reason: 'class';
      readonly name: string;
      readonly cls: 'assumed' | 'solved' | 'held' | 'unclassified';
      /** For a param a hold re-solves: the device whose gate the hold keeps, as findings name it. */
      readonly device?: string;
    }
  | { readonly reason: 'unresolved'; readonly name: string }
  | { readonly reason: 'cycle'; readonly via: readonly string[] }
  | { readonly reason: 'device'; readonly device: string }
  | { readonly reason: 'equation'; readonly name: string }
  | { readonly reason: 'analysis'; readonly name: string };

/** What is wrong with a device's placements (NetlistAbout `placement`): not one placement or a
 *  list of them; a key a placement does not have; a terminal on no wire; an intent other than
 *  "off"; some placements diode-connected and some not. `index` is the placement's position where
 *  the device has more than one. */
export type PlacementFault =
  | {
      readonly fault: 'shape';
      /** Where the sheet's own device may also be written as having no wires ("none"). */
      readonly none?: true;
    }
  | { readonly fault: 'unknown-key'; readonly key: string; readonly index?: number }
  | { readonly fault: 'no-wire'; readonly terminal: 'd' | 'g' | 's' | 'b'; readonly index?: number }
  | { readonly fault: 'intent'; readonly value: unknown; readonly index?: number }
  | { readonly fault: 'mixed-diode' };

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
  /** Short form of `condition.corner`. */
  readonly corner?: string;
  /** The condition dimensions to resolve; corner and temperature (DEFAULT_DIMENSIONS) when
   *  absent. */
  readonly dimensions?: readonly ConditionDimension[];
  /** Values the caller declares for this file, by dimension name; they win over its headers. */
  readonly condition?: Readonly<Record<string, ConditionValue>>;
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
/**
 * A sizing whose derived quantity (gm, gm/ID, the drain current or the width) is not a positive
 * finite number: the operating point the table gives there is degenerate. The quantity and the
 * value it came to, as data; the message is the sizer's own words.
 */
export class SizingQuantityError extends Error {
  override name = 'SizingQuantityError';
  constructor(
    readonly quantity: 'gm' | 'gm_id' | 'id' | 'W',
    readonly value: number,
  ) {
    super(`sizeDevice: derived ${quantity} is not a positive finite number (got ${value})`);
  }
}

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

/**
 * A read a design asked of a device's table that lies beyond the data: the device it is for, what
 * was asked (a bias axis such as `vds`, the length `l`, a bound gate voltage `vgs`, or the quantity
 * an inverse lookup was asked to reach such as `gm_id` or `id`), the value asked, and the two ends
 * of what the table holds for it. A device read beyond its table is not sized: nothing the table
 * holds answers for that point, and a number taken at the table's edge would be a number from a
 * different bias. Plain data, one shape wherever such a read is found, so a reader decides from
 * these fields and never from a message.
 *
 * `device` is the device's path as findings name it: `givens` for a sheet's own device, the block
 * path below it (`pair`, `amp.load`). The sizer, which does not know the device's name, leaves it
 * empty for its caller to fill.
 */
export interface OutsideTable {
  readonly device: string;
  readonly quantity: string;
  readonly asked: number;
  readonly held: readonly [number, number];
}
