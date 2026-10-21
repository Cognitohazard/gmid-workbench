// A design sheet: a self-contained block evaluated against ONE device's lookup tables + PDK
// constants. Flat and declarative — named scalar params, an optional bind-any-2 device, named
// author-expression equations, and named comparison checks. A sheet in format version 2 also
// names the wires its devices sit on (`nodes`) and the wires it holds (`levels`): a netlist of
// identities, which the engine checks for DC consistency after sizing and never solves — no
// level derived from it is fed back into the design. Pure data; zero DOM imports.

import type { QAWarning } from '../types';
import { compileExpr, metaScalars, type FallbackNote, type NoiseSource } from '../derive';
import { BASE_KEYS, BASE_QUANTITIES, DERIVED_QUANTITIES } from '../namespace';
import { BINDABLE, SIZING_SCALARS } from '../device';
import { additiveCoefficient } from '../expr';

/** How a name is spelt: a param, an equation, a wire, an element. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether a value read from a document is an object with keys (not a list, not null). */
export const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

/** Whether an expression parses at all — distinct from namesOf, whose empty result also describes
 *  a legal literal like "0.9". */
export function parses(expr: string): boolean {
  try {
    compileExpr(expr);
    return true;
  } catch {
    return false;
  }
}

/** Free names of an expression, or none when it is not a string or does not parse. */
export function namesOf(expr: unknown): readonly string[] {
  if (typeof expr !== 'string') return [];
  try {
    return compileExpr(expr).names;
  } catch {
    return [];
  }
}

/**
 * A named scalar design input. `min`/`max` bound the GUI slider only. `role`
 * separates what the sheet is FOR from how it gets there — 'spec' params state the
 * requirement (VDD, CL, GBW_target: an adopter changes these freely), 'choice'
 * params are the author's implementation knobs (I_tail, gm_id, L: change these to
 * re-balance the design). Untagged params render ungrouped, as before. `note` is a
 * one-line derivation/intent annotation for the designer inheriting the sheet.
 */
export interface SheetVar {
  name: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
  role?: 'spec' | 'choice';
  note?: string;
  /**
   * Marks this param as SOLVED FOR the value it must agree with, closing a bias loop the
   * composition DAG cannot express. Children evaluate in document order and can only read
   * earlier siblings, so a real circuit's cyclic bias (a mirror device's drain sits on the node
   * its own current sets) has to be cut somewhere; the author cuts it with a param, and this
   * field says what the param stands for. The engine then chooses the param so that
   * `param - solveFor` reads zero, instead of leaving a human to retune the slider until an
   * advisory check goes green.
   *
   * The target is any name resolvable in THIS sheet's namespace once its body has run —
   * typically a child's provided scalar (`in__vgs`), but an equation or the sheet's own sized
   * operating point works too. It is solved exactly as a `designConstraint` is (see below): by a
   * one-unknown search between `min` and `max`, both required. `value` is what the panel shows
   * before a run and nothing more; the answer never depends on it. A target that does not
   * resolve inside the range, or a relation the search cannot settle, fails closed rather than
   * reporting a design sized against a stale value.
   *
   * A solved param is no longer a free variable, so it is not sweepable.
   */
  solveFor?: string;
  /**
   * Marks this param as CONSTRAINED: a free internal variable — typically a node voltage — that the
   * engine chooses so that one of the sheet's OUTPUTS equals a SPEC (`CM_in == CM_dc`). This is
   * the second door onto the same design: internally the node is the canonical coordinate the
   * tables are indexed by; externally the designer types the quantity the application presents,
   * and the design constraint is the declared inversion between them.
   *
   * Solved by a one-unknown search that keeps the root enclosed, on [min, max] (both required —
   * they are the range searched, not slider bounds). Such a search needs no contraction, cannot
   * overshoot, and cannot depend on a starting guess. Its honesty condition is stated instead of
   * hidden: `lhs - rhs` must change sign across the range, and the solve fails closed when it
   * does not, when nothing in the range evaluates, or when the crossing turns out to be a jump.
   * If the relation folds inside the range the root found is determined by the stated range
   * alone — never by history.
   *
   * `value` is only the displayed default; the solved value replaces it. A constrained param is not
   * sweepable (sweep the spec on the other side of the constraint instead). A sheet may solve
   * several params; ones that depend on each other are settled by repeating the one-unknown
   * searches a fixed number of times (see solvePlan, and SOLVE_SWEEPS in eval.ts).
   *
   * `held` is set by the engine, never authored: it marks the constraint a fixed-hardware run
   * generates from a `hold` (see below), and validation refuses a document that writes it.
   */
  designConstraint?: { lhs: string; rhs: string; held?: boolean };
  /**
   * Marks this param as a node voltage that hangs under a transistor's gate — a cascode's source,
   * a pair's tail — and names the quantity that stays FIXED when the hardware does: the gate
   * voltage, written as the node plus the device's gate-source voltage (`V_a + casc__vgs`).
   *
   * At the nominal run the param is an ordinary input: it keeps its typed value, it can be edited
   * and swept, and the engine reports what the held expression evaluates to (the gate bias the
   * design needs; see SheetResult.held). Wherever the hardware is held — a range end's
   * fixed-hardware run — the roles swap: the expression is held at that nominal value and the
   * param is re-solved, by the same search a `designConstraint` uses on [min, max]. That is what
   * silicon does: a bias line holds the gate, and the node under it moves with the condition.
   *
   * The expression must be a sum of terms in which this param appears exactly once, bare or
   * times a numeric literal (see additiveCoefficient) — so its dependence on the node is there
   * to read, not inferred. A relation of any other shape, or a gate bias the sheet provides, is a
   * `designConstraint`, which is solved at the nominal run as well.
   *
   * The same declaration states a typed CURRENT that is the design point's choice rather than the
   * hardware. An inverter's bias is typed into its NMOS, and the PMOS on the same gate is given
   * that current and the gate voltage the supply leaves. `"hold": "I_bias - p__id"` — a hold that
   * reads a device's current, a current balance (see balancedBy) — says two things: that the
   * PMOS's gate is the fixed thing, so where the design is held it keeps its gate voltage and reads
   * its current from the table (see holdHardware, heldOnGate); and that the bias is then whatever
   * the two devices agree on. The balance must read zero at the design point, as it does by
   * construction, or the run fails closed; validation requires the param to reach another device's
   * current where the design is held.
   */
  hold?: string;
  /**
   * What kind of DC sizing input this param is, for a voltage that a device's bias or givens are
   * built from. `independent` is a voltage nothing on the sheet determines, so the designer
   * states it: a supply, a ground reference, an input common mode, a bias applied from off the
   * sheet, a characterization probe, an output level held by a feedback loop outside the sheet,
   * a voltage across a device whose surrounding circuit is not on the sheet. `assumed` is one
   * the sheet's own parts DO determine but the sheet types a value for now instead of deriving
   * it: an internal stack node, a guessed gate-source drop. It is not a permanent state — it
   * marks a value the sheet still has to derive. The two read the same to the engine; the
   * difference is what a result sized under them is worth, which is why an assumed input is
   * listed with the result of a run (SheetResult.assumptions).
   *
   * A third class, solved, is DERIVED and never written (see dcInputs): the param that
   * carries a `designConstraint` or a `solveFor` is solved by construction — the names its relation
   * reads are not thereby solved — and authoring it is a validation error. Absence is legal for a
   * param that never reaches a device's sizing; a voltage param that does and carries no class is
   * an error (the `sheet-dc-inputs` rule).
   */
  class?: ParamClass;
  /**
   * Declares this param an AXIS-SIGN SELECTOR: the +1 or -1 a p-type device's bias-axis
   * expressions are multiplied by so the same sheet runs on a table in N-style convention (+1,
   * positive axes) and on a signed p export (-1, negative axes). Declared, never inferred from a
   * value: an ordinary param that happens to equal 1 (a gain, a count) is not one. The DC wiring
   * walk reads a declared selector that multiplies a whole bias-axis expression as the table's
   * axis direction, so `p_sign*(VDD - V_out)` is read as the physical voltage it stands for
   * rather than as an unknown product. Its value must be exactly +1 or -1, it must equal the axis
   * direction of every table a device using it is sized on, and it must appear in at least one
   * bias-axis expression. A format-version-2 key (see SheetDoc.formatVersion).
   */
  convention?: 'axis-sign';
}

/** The values SheetVar.convention may take. */
export const PARAM_CONVENTIONS: ReadonlySet<string> = new Set(['axis-sign']);

/** The authorable DC-level classes (see SheetVar.class). `solved` is deliberately absent: it is
 *  derived from `designConstraint`/`solveFor`, never written. */
export type ParamClass = 'independent' | 'assumed';
export const PARAM_CLASSES: ReadonlySet<string> = new Set<ParamClass>(['independent', 'assumed']);

/** Type guard: a CONSTRAINED param — one the engine solves against an authored relation (see
 *  SheetVar.designConstraint). */
export function constrained(
  p: SheetVar,
): p is SheetVar & { designConstraint: { lhs: string; rhs: string; held?: boolean } } {
  return typeof p.designConstraint?.lhs === 'string' && typeof p.designConstraint?.rhs === 'string';
}

/** Type guard: a param whose named expression is held where the hardware is (see SheetVar.hold). */
export function holds(p: SheetVar): p is SheetVar & { hold: string } {
  return typeof p.hold === 'string' && p.hold !== '';
}

/** A `hold` param as the design constraint a fixed-hardware run solves: the held expression against
 *  `rhs`, the value it took at the nominal run. The one spelling of that rewrite, shared by every
 *  held run (holdHardware) and by the held document validation reads (heldShape). */
export function holdAsConstraint(p: SheetVar & { hold: string }, rhs: string): SheetVar {
  const { hold, ...rest } = p;
  return { ...rest, designConstraint: { lhs: hold, rhs, held: true } };
}

/**
 * The devices whose quantity `key` (`id`, `vgs`) a param's `hold` reads, in the order it reads
 * them: the sheet's own as '' (`key` itself, where the sheet sizes one), a block's by name
 * (`<block>__key`). Empty for a param with no hold, and for a hold that does not parse.
 */
function holdReads(doc: SheetDoc, p: SheetVar, key: string): string[] {
  if (!holds(p)) return [];
  const out: string[] = [];
  for (const n of namesOf(p.hold)) {
    if (n === key && doc.givens) out.push('');
    const split = splitProvide(n);
    if (split && split[1] === key) out.push(split[0]);
  }
  return out;
}

/**
 * The devices whose CURRENT a param's `hold` reads: a block of `doc`, by name (`<block>__id`), or
 * the sheet's own device, as '' (`id`, where the sheet sizes one). A hold that reads one is a
 * current balance (see SheetVar.hold) — the declaration that a device given a gate voltage and a
 * current keeps the gate voltage where the design is held (see holdHardware). Empty for a hold
 * that reads no current, and for an expression that does not parse.
 */
export function balancedBy(doc: SheetDoc, p: SheetVar): string[] {
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  return holdReads(doc, p, 'id').filter((d) => d === '' || blocks.some((b) => b.name === d));
}

/**
 * The device whose gate a param's `hold` keeps fixed where the design is held: the sheet's own
 * (`givens`, for a hold that reads `vgs`) or a block's (`<block>__vgs`) — the first such name the
 * hold reads. Undefined for a param with no hold, for a hold that balances a current (see
 * balancedBy), and for one that reads no gate-source voltage. One statement of the rule, read by
 * validation (which wires a hold may be held on) and by the wiring proposal (which it drafts).
 */
export function heldGateOf(doc: SheetDoc, p: SheetVar): string | undefined {
  if (balancedBy(doc, p).length) return undefined;
  const [first] = holdReads(doc, p, 'vgs');
  return first === undefined ? undefined : first || 'givens';
}

/** Every device of `doc` whose current one of its own holds balances (see balancedBy). */
export const balancesOf = (doc: SheetDoc): ReadonlySet<string> =>
  new Set((Array.isArray(doc.params) ? doc.params : []).flatMap((p) => balancedBy(doc, p)));

/**
 * Whether the device `doc` sizes is held at its width and its GATE VOLTAGE where the design is
 * held, rather than at its width and its current: it is given a gate voltage and no width, and a
 * hold balances its current — its own sheet's (`id`), or, for a block, its parent's
 * (`parentBalances`). One statement of the rule, read by holdHardware and by validation alike.
 */
export function heldOnGate(doc: SheetDoc, parentBalances: boolean): boolean {
  const g = doc.givens;
  return (
    !!g && g.W === undefined && g.vgs !== undefined && (parentBalances || balancesOf(doc).has(''))
  );
}

/**
 * The structural problems that make a document's design constraints unsolvable, stated ONCE —
 * evaluation fails closed on the same words validation reports, mirroring bindProblem. Returns null
 * when the constraints are well-formed. The half-written check comes first because `constrained()`
 * rejects a constraint missing a side: such a param would otherwise be neither swept nor solved —
 * frozen at its authored value with no warning, and the sheet reported feasible on a design never
 * solved.
 */
export function constraintProblem(params: readonly SheetVar[]): string | null {
  return constraintIssue(params)?.message ?? null;
}

/** constraintProblem with the param it is about — what a failed solve names as its unknown. */
export function constraintIssue(
  params: readonly SheetVar[],
): { param: string; message: string } | null {
  const issue = (p: SheetVar, message: string) => ({ param: p.name, message });
  const half = params.find((p) => p.designConstraint !== undefined && !constrained(p));
  if (half)
    return issue(
      half,
      `param "${half.name}": its design constraint needs both lhs and rhs — half-written, it would freeze the ` +
        `param without solving it`,
    );
  const constrainedParams = params.filter(constrained);
  const both = constrainedParams.find((p) => torn(p));
  if (both)
    return issue(
      both,
      `param "${both.name}" has a design constraint and also carries solveFor — the two would fight over ` +
        `it; keep one relation`,
    );
  const unranged = params.find((p) => engineSolved(p) && !ranged(p));
  if (unranged)
    return issue(
      unranged,
      `solved param "${unranged.name}" needs finite min < max — they are the range it is searched ` +
        `in, not slider bounds`,
    );
  const held = params.filter(holds);
  const twice = held.find((p) => p.designConstraint !== undefined || torn(p));
  if (twice)
    return issue(
      twice,
      `param "${twice.name}" carries hold and also has a design constraint or carries solveFor — a param ` +
        `takes one of the three`,
    );
  const loose = held.find((p) => !ranged(p));
  if (loose)
    return issue(
      loose,
      `held param "${loose.name}" needs finite min < max — the range it is re-solved in ` +
        `where the hardware is held`,
    );
  const shapeless = held.find((p) => additiveCoefficient(p.hold, p.name) === undefined);
  if (shapeless)
    return issue(
      shapeless,
      `param "${shapeless.name}": hold "${shapeless.hold}" must be a sum of terms in which ` +
        `${shapeless.name} appears exactly once, bare or times a number — write any other ` +
        `relation as a design constraint`,
    );
  return null;
}

/**
 * One named author expression (an intermediate `let` or an output), evaluated in
 * document order against earlier values + the sized device's quantities + constants.
 * Mirrors a DerivedQuantity {key, expr, unit} — one definition, no hand-rolled formula.
 */
export interface SheetEquation {
  name: string;
  expr: string;
  unit?: string;
  /** One-line derivation/intent annotation (where the formula comes from). */
  note?: string;
}

/**
 * A bind-any-2 device declaration: EXACTLY two bound quantities (each an expression
 * string, so e.g. gm = "2*pi*GBW*CL" works), plus the length L. At most one of them may
 * set the operating point — see BINDABLE / OP_SELECTORS in device/ for the rule. Drives
 * sizeDevice against the panel's active device.
 *
 * `vds`/`vsb` declare the device's OPERATING POINT on those axes (expression strings,
 * signed — matching the table's axis convention, so a PMOS vds is negative). Sizing
 * inverts gm/ID along vgs and needs every other axis collapsed to a point; declaring
 * the point here makes the bias an authored, persisted, sweepable part of the design
 * instead of a hidden host-side slice (a cascode's low-vds gds differs ~4–5× from the
 * mid-supply value, so an undeclared bias silently overstates gain). A `vsb` left undeclared
 * takes its namespace default and is reported as ASSUMED (see SizingReport.assumed). `vds` has
 * no honest default, so every sized device states its drain voltage — as `vds`, or as a diode
 * connection — and one that states neither fails the sizing on any table (see drainProblem).
 *
 * A device is sized only on a table that carries what its givens use. A bias declared on an
 * axis the table does not sweep is sized where the table was taken — its one value on that axis,
 * or vsb = 0 for a table with no `vsb` column — and nowhere else: any other value, and a diode
 * connection on a table with no vds sweep, fails the sizing with the reason. `L` on a table
 * taken at one length is held to the same rule, and so is the default an undeclared `vsb`
 * takes: on a table taken at one other body bias, the sizing fails until `vsb` is declared.
 */
export interface SheetGivens {
  L: string;
  gm?: string;
  gm_id?: string;
  id?: string;
  /** Width-first sizing (unit devices, mirror ratios, layout-constrained flows):
   *  W may stand in as one of the two bound quantities. */
  W?: string;
  /** Spec-first sizing: these pin the operating point exactly as gm_id does (each is
   *  width-invariant), so an author can give the requirement they actually have — a
   *  transit frequency or an intrinsic gain — instead of solving for the gm/ID that
   *  meets it. Exactly one operating-point quantity may be given. */
  ft?: string;
  gm_gds?: string;
  av0?: string;
  vstar?: string;
  /**
   * The device's GATE-SOURCE VOLTAGE, given rather than reported. It is an operating-point
   * quantity like the ones above — it pins where on the curve the device sits and says
   * nothing about its size — but the spec it states is structural rather than a target: two
   * devices whose gates are one wire and whose sources are one node are at one vgs, whatever
   * the table, the corner or the temperature. `{ W: "K*ref__W", vgs: "ref__vgs" }` is a
   * current mirror written down exactly; the same mirror written as a shared `gm_id` is an
   * approximation that only holds while both devices read the same table at the same bias.
   *
   * Signed in the table's own axis convention, so a signed-export PMOS gate voltage is
   * negative — the same convention `vds`/`vsb` already use.
   *
   * Legal alongside `diode: true`. The two statements are independent and both hold: the
   * connection collapses the vds axis onto the vds = vgs diagonal, and the given vgs then names
   * the point on that diagonal. It is `vds` a diode connection excludes, because that one
   * would name the same coordinate twice.
   */
  vgs?: string;
  vds?: string;
  vsb?: string;
  /**
   * The device is DIODE-CONNECTED: gate tied to drain, so `vds = vgs` by wiring rather than by
   * choice. Declaring it collapses the vds axis onto that diagonal, which is the honest way to
   * write a diode — the alternative is a param holding a guess at the drop plus an advisory check
   * reminding the author to retune it, which makes every number downstream depend on how
   * carefully somebody re-typed a voltage. Mutually exclusive with a declared `vds`, since the
   * connection already fixes it.
   */
  diode?: boolean;
  /**
   * The region the device is meant to operate in. Declaring one adds a physical check with the id
   * `region` to the device's own check results: `abs(vds) >= vdsat` for `saturation`, and
   * `abs(vds) <= vdsat` for `triode` (a switch), with `vds` the drain-source voltage the device was
   * sized at and `vdsat` the sizing's own. It gates like an authored physical check, and reads
   * `na` on a table with no `vdsat` column. Not allowed beside `diode: true`, where the drain is
   * the gate and the question does not arise.
   */
  region?: Region;
}

/** The regions a device may declare (see SheetGivens.region). */
export type Region = 'saturation' | 'triode';
export const REGIONS: ReadonlySet<string> = new Set<Region>(['saturation', 'triode']);

/** The id of the check a declared region adds to its device (see SheetGivens.region). */
export const REGION_CHECK_ID = 'region';

/**
 * The checks the engine adds to a sheet's own beside the authored ones, from its givens: today the
 * region check, where a region is declared. Each is a physical check of that sheet, so it gates,
 * sweeps and complies like an authored one, and its id is reserved — an authored check may not
 * take it, because results are keyed by id. The one list the evaluation, the sweep's check
 * collection and validation read.
 */
export function engineChecks(givens: SheetGivens | undefined): { id: string; kind: CheckKind }[] {
  return givens?.region !== undefined ? [{ id: REGION_CHECK_ID, kind: 'physical' }] : [];
}

/** The bias axes the givens may declare — every namespace sweep axis except the inversion
 *  sweep (vgs) and the geometry axis (l). Derived from the axis flags so a table axis
 *  added to the namespace is automatically collapsible by a given or its namespace default,
 *  rather than
 *  dying on the sizer's extra-axis error because a hand-copied list went stale.
 *
 *  vgs stays out even though the givens may now name it, and the exclusion is load-bearing: a
 *  bias axis is SLICED before sizing, which would collapse the very axis the sizing works
 *  along and leave nothing to place an operating point on. vgs reaches GIVENS_KEYS as a
 *  BINDABLE selector instead, and is consumed by sizeDevice — never by applyGivensBias. */
export const BIAS_AXES: readonly string[] = BASE_QUANTITIES.filter(
  (q) => q.axis && q.key !== 'vgs' && q.key !== 'l',
).map((q) => q.key);

/** Every EXPRESSION-valued key `givens` may carry besides `L` — the bindable quantities plus the
 *  bias axes it may pin. Stated once beside the interface it describes, so a document sanitizer
 *  can check parsed givens against the real shape instead of a copy that goes stale when BINDABLE
 *  grows (which is exactly how a legal fT given once got deleted on every reload). */
export const GIVENS_KEYS: ReadonlySet<string> = new Set<string>([...BINDABLE, ...BIAS_AXES]);

/** Givens keys that are FLAGS rather than expressions. Listed separately because a sanitizer has
 *  to type-check them differently, and because a flag silently failing a string test is the same
 *  reload-eating bug GIVENS_KEYS was introduced to stop. */
export const GIVENS_FLAGS: ReadonlySet<string> = new Set<string>(['diode']);

/** Givens keys whose value is one word from a fixed list rather than an expression (see
 *  SheetGivens.region). Kept apart from the expression keys for the reason GIVENS_FLAGS is: every
 *  walk that reads a given as an expression would otherwise read `saturation` as a name. */
export const GIVENS_WORDS: ReadonlySet<string> = new Set<string>(['region']);

/** Whether the givens key `k` holds an expression: every key but the flags and the words. */
export const givenIsExpression = (k: string): boolean =>
  !GIVENS_FLAGS.has(k) && !GIVENS_WORDS.has(k);

/**
 * Why givens that leave the drain voltage out size no device, stated ONCE — the sizing fails on
 * the same words validation reports, mirroring bindProblem. Returns null when they state it: as
 * `vds`, or as a diode connection, which fixes the drain at the gate.
 *
 * It holds on every table. A drain voltage is set by the node the drain sits on, so neither the
 * device nor its table has one to supply: a table taken at one drain voltage, or with no `vds`
 * column, would otherwise size the device from whatever point it happens to hold, with nothing
 * beside the result to say which.
 */
export function drainProblem(givens: SheetGivens): string | null {
  // A blank `vds` states nothing, and only a literal `true` is a connection: a document read as
  // plain JSON can carry `"diode": "false"`, which must not pass for one.
  const vds = String(givens.vds ?? '').trim();
  return vds === '' && givens.diode !== true
    ? 'the givens state no drain voltage, so the device is not sized — give vds, or declare a ' +
        'diode connection (diode: true), which fixes the drain at the gate'
    : null;
}

// physical = a hard physical floor (must hold or the design is unphysical); spec = a
// hard application spec (must hold or the design misses its purpose) — both gate feasibility.
// advisory = a soft advisory (a near-miss heads-up) that is shown but never blocks feasibility.
export type CheckKind = 'physical' | 'advisory' | 'spec';

/** True for the kinds that GATE feasibility. The one home for "hardness" — the leaf
 *  verdict, the sweep check collection, and binding-check attribution all consult this
 *  whitelist, so a future advisory kind cannot be silently promoted to hard by a
 *  `!== 'advisory'` blacklist somewhere. */
export const isHardCheck = (kind: CheckKind): boolean => kind === 'physical' || kind === 'spec';
export type CheckOp = '>=' | '<=' | '==';

/** Runtime membership sets mirroring the CheckKind/CheckOp unions — one place to coerce untrusted
 *  input (saved layouts, raw core callers). Typed ReadonlySet<string> so `.has(rawString)` works. */
export const CHECK_KINDS: ReadonlySet<string> = new Set<CheckKind>([
  'physical',
  'advisory',
  'spec',
]);
export const CHECK_OPS: ReadonlySet<string> = new Set<CheckOp>(['>=', '<=', '==']);

/**
 * A named comparison the design must satisfy. `lhs`/`rhs` are expression strings
 * (structured — the comparison itself is never parsed out of a string). `tolPct`
 * applies only to '=='; `justification` is an advisory note for a relaxed advisory check.
 */
export interface SheetCheck {
  id: string;
  kind: CheckKind;
  lhs: string;
  op: CheckOp;
  rhs: string;
  tolPct?: number;
  justification?: string;
  /** One-line physical meaning of the check, for the designer inheriting the sheet. */
  note?: string;
}

/**
 * A block this sheet composes. The child is either a full SheetDoc embedded
 * inline (`doc`) or a reference to a library sheet (`ref` — a `folder/name` id, or the
 * bare name while it is unique; see resolve.ts). A ref is materialized into `doc` by
 * `resolveSheetRefs` BEFORE validation/evaluation, so those layers see an embedded
 * tree; a block that reaches evaluation docless fails closed. A block carrying both is an
 * already-resolved snapshot (`ref` is provenance; `doc` is authoritative). `params`
 * overrides the child's param VALUES with expressions evaluated in the PARENT's scope,
 * so a parent budget flows down (e.g. a shared length or current) — this is also the
 * customization channel for a ref'd child, whose internals belong to the library
 * sheet. Children evaluate in DOCUMENT ORDER, and each override resolves against the
 * parent scope as built so far: parent params, constants, and the provides of EARLIER
 * siblings — so a later block can carry a value an earlier block derived (a cascode
 * branch taking the input pair's sized current). A forward reference (or a reference
 * to the parent's own sized device, which is sized AFTER the children) fails closed as
 * undeclared. `device` names the device table the child sizes against (by id); absent
 * ⇒ the child inherits the parent's table.
 *
 * The child exposes its `provide`d names to the parent as flat scalars `name__key`
 * (the engine has no member access, so the join is a `__` separator — neither the block
 * `name` nor a provided key may contain `__`). The values that cross a block boundary are
 * scalars only: the parent references child outputs and writes its own author math over them.
 * A block's `nodes` say which of the parent's wires the child's device sits on; they are checked
 * against the sized result and never change it.
 */
export interface SheetBlock {
  name: string;
  doc?: SheetDoc;
  ref?: string;
  device?: string;
  params?: Record<string, string>;
  /**
   * The wires the child's device sits on, named in THIS sheet's namespace: one placement
   * `{d, g, s, b}`, or a list of placements of the one sizing (see DeviceNodes). Only a child
   * that sizes a device takes it, and only when the child does not wire its own device itself.
   * A format-version-2 key (see SheetDoc.formatVersion).
   */
  nodes?: SheetNodes;
  /**
   * How a sub-sheet that wires itself connects to this sheet: every port the child declares,
   * mapped to a wire here or to `null` (left open). The child's wiring then joins this sheet's walk:
   * a mapped port IS the wire it is mapped to, and every other wire of the child is its own,
   * spelt `block__wire`. A child that does not wire itself is wired by `nodes` instead; a block
   * may not carry both.
   */
  ports?: Record<string, string | null>;
}

/**
 * The four terminals of one placement of a sized device, each named by a wire: drain, gate,
 * source and body. A wire is an identifier in the sheet's namespace; `gnd` is the reference at
 * potential 0 and every other wire is an ordinary name. The names are identities only — a wire's
 * level is never written here: it is held in `levels` or derived, for checking, from the
 * devices on it.
 *
 * Two wires being the same name is a statement about the circuit with consequences: `g == d` is
 * a diode connection, which reads the device's table along its vds = vgs diagonal exactly as
 * `diode: true` does; `g == s` is the real constraint vgs = 0, which `intent: "off"` declares
 * deliberate (it silences only the accidental-short warning); `d == s` is refused.
 */
export interface DeviceNodes {
  d: string;
  g: string;
  s: string;
  b: string;
  intent?: 'off';
}

/** One placement, or several placements of the same sizing (a matched pair written once). A
 *  list shares one operating point only where the DC walk shows every placement at the same
 *  gate, drain and body voltage; it may not mix diode-connected and other placements. */
export type SheetNodes = DeviceNodes | DeviceNodes[];

/** The terminals of a placement, in the order they are reported. */
export const TERMINALS: readonly ('d' | 'g' | 's' | 'b')[] = ['d', 'g', 's', 'b'];

/** The exact key set of a placement. */
export const NODE_KEYS: ReadonlySet<string> = new Set([...TERMINALS, 'intent']);

/** The reference wire: potential 0 everywhere, never listed in `levels`. */
export const GROUND = 'gnd';

/** The document format this engine writes. A document with no `formatVersion` is read in the
 *  earlier format; one that states another number is not read (see SheetDoc.formatVersion). */
export const FORMAT_VERSION = 2;

/**
 * A passive or ideal source between two wires. `I` drives `value` amperes from `between[0]` to
 * `between[1]`; `V` holds V(between[0]) - V(between[1]) = value; `R` and `C` are symmetric. The
 * value is a number or an expression that reads only configuration (see configEligibility). The
 * wiring walk reads a `V` as a relation like a placement's and an `I` as a current in the balance;
 * a wire an `R` or a `V` touches carries a current the walk cannot read and is not balanced.
 */
export interface SheetElement {
  name: string;
  kind: 'R' | 'C' | 'I' | 'V';
  between: [string, string];
  value: number | string;
}

export const ELEMENT_KEYS: ReadonlySet<string> = new Set(['name', 'kind', 'between', 'value']);
export const ELEMENT_KINDS: ReadonlySet<string> = new Set(['R', 'C', 'I', 'V']);

/** A small-signal analysis a sheet asks for by name. Accepted and shape-checked; not yet
 *  evaluated. Coefficient maps are `{wire: number}` with literal numbers. */
export type SheetAnalysis =
  | {
      name: string;
      kind: 'gain';
      in: Record<string, number>;
      out: Record<string, number>;
      at: number | string;
      as?: 'mag' | 'db' | 'phase';
    }
  | {
      name: string;
      kind: 'impedance';
      node: string;
      at: number | string;
      as?: 'mag' | 'real' | 'imag' | 'phase';
    }
  | {
      name: string;
      kind: 'noise_in';
      in: Record<string, number>;
      out: Record<string, number>;
      at: number | string;
      breakdown?: boolean;
    };

/** Per analysis kind: the keys it requires, the keys it may carry, and the words `as` takes. */
export const ANALYSIS_SHAPES: Readonly<
  Record<
    string,
    { required: readonly string[]; optional: readonly string[]; as?: readonly string[] }
  >
> = {
  gain: {
    required: ['name', 'kind', 'in', 'out', 'at'],
    optional: ['as'],
    as: ['mag', 'db', 'phase'],
  },
  impedance: {
    required: ['name', 'kind', 'node', 'at'],
    optional: ['as'],
    as: ['mag', 'real', 'imag', 'phase'],
  },
  noise_in: { required: ['name', 'kind', 'in', 'out', 'at'], optional: ['breakdown'] },
};

/** Maximum composition nesting depth — a backstop against a pathologically deep
 *  authored tree (embedded docs form a finite tree, so this is a sanity cap, not a
 *  cycle guard). Shared by the evaluator and the validator. */
export const MAX_BLOCK_DEPTH = 8;

/** A param solved for the value it names (see SheetVar.solveFor) — the ONE definition of
 *  "torn", mirroring how `sweepable` owns the notion of a free slider variable. A type guard,
 *  so a caller that narrows gets `solveFor` as a plain string instead of casting it. */
export function torn(p: SheetVar): p is SheetVar & { solveFor: string } {
  return typeof p.solveFor === 'string' && p.solveFor !== '';
}

/** A param the ENGINE resolves rather than the author setting — torn or constrained, both found by
 *  the same one-unknown search. The one predicate for every surface that renders "solved, not set": read-only
 *  fields, slider suppression. (`sweepable` keeps its own structural test on purpose: it must
 *  also refuse to sweep a MALFORMED design constraint, which the shape guards here deliberately
 *  reject so constraintProblem can name it.) */
export function engineSolved(p: SheetVar): boolean {
  return torn(p) || constrained(p);
}

/** Whether a param states a finite range, min below max: what a slider sweeps, and what a solved
 *  or held param is searched in. */
const ranged = (v: { min?: number; max?: number }): v is { min: number; max: number } =>
  Number.isFinite(v.min) && Number.isFinite(v.max) && (v.min as number) < (v.max as number);

/** True when a param is a finitely-bounded slider variable (sweepable). The ONE
 *  definition of a free, finitely-bounded variable — the sweep UIs and the sensitivity
 *  step-scaler both read it, so they can never disagree about what "bounded" means. A param
 *  under `solveFor` or `designConstraint` is solved by the engine, not set by anyone — and its
 *  min/max are the range it is searched in, not slider bounds — so both are excluded. */
export function sweepable(
  v: { min?: number; max?: number; solveFor?: string; designConstraint?: unknown } | undefined,
): v is { min: number; max: number } {
  return !!v && !v.solveFor && !v.designConstraint && ranged(v);
}

/**
 * A parent's override of its child's param `name`, as the child reads it: own keys only (so a
 * param named `constructor` is not read as overridden by every override object), a string, and
 * not a param the engine solves — a solved param's value is the engine's answer whatever the
 * parent writes. Undefined where there is none.
 */
export function blockOverride(block: SheetBlock, name: string): string | undefined {
  const over = block.params;
  if (!over || !Object.prototype.hasOwnProperty.call(over, name)) return undefined;
  const src: unknown = over[name];
  const p = block.doc?.params.find((q) => q.name === name);
  return typeof src === 'string' && p && !engineSolved(p) ? src : undefined;
}

/** The author's implementation knobs: the params declared 'choice' that the engine does not
 *  solve — the set a designer re-balances, as opposed to 'spec' params, which state the
 *  requirement. The ONE definition, so the sensitivity readout and any search that ranks knobs
 *  through it can never disagree about which params are in play. Not filtered by `sweepable`:
 *  a knob with no authored range is still a choice, and only a caller that needs a slider
 *  range (a sweep, a scan) adds that filter. */
export function choiceKnobs(doc: SheetDoc): SheetVar[] {
  return doc.params.filter((p) => p.role === 'choice' && !engineSolved(p));
}

/** The separator joining a block's name to a provided key. The engine has no member
 *  access (`child.key` cannot parse), so a child's scalars surface in the parent scope as
 *  the flat name `child__key`. One source of truth for the producer (eval), the collision
 *  check (validate), and the UI display; neither a block name nor a provided key may contain it. */
export const PROVIDE_SEP = '__';
export const joinProvide = (blockName: string, key: string): string =>
  `${blockName}${PROVIDE_SEP}${key}`;
/** The inverse of joinProvide: `[blockName, key]` for a name that reads a child's scalar, split at
 *  the first separator, or undefined when the name carries none (or starts with one). */
export const splitProvide = (name: string): [string, string] | undefined => {
  const at = name.indexOf(PROVIDE_SEP);
  return at > 0 ? [name.slice(0, at), name.slice(at + PROVIDE_SEP.length)] : undefined;
};

/** The flat names a block injects into its parent's scope: exactly what its `provides`
 *  declare, each joined to the block name. A ref-only block (no embedded doc yet) injects nothing
 *  — its provides arrive at resolution. One spelling of "a block exposes only what it provides". */
export const providedNames = (u: SheetBlock): string[] =>
  (u.doc?.provides ?? []).map((k) => joinProvide(u.name, k));

/** The scope prefix of a chain of blocks from the top down: each name joined by PROVIDE_SEP, so a
 *  name at the end of the chain reads `a__b__name` from the top. */
export const providePrefix = (chain: readonly { name: string }[]): string =>
  chain.map((b) => joinProvide(b.name, '')).join('');

/** A block path one level down: `path` joined to `name` with PATH_SEP, or `name` at the top. */
export const childPath = (path: string, name: string): string =>
  path ? `${path}${PATH_SEP}${name}` : name;

/** The table scalars a sizing re-reads into its scope beside the device quantities (metaScalars).
 *  Read off metaScalars itself rather than listed again. The probe must supply EVERY metadata
 *  field, because the key set follows the fields present: thermalScalars yields nothing for a
 *  missing temp and `w` needs `W`, so a slimmer probe would silently shrink the set. */
export const META_PUBLISHED: ReadonlySet<string> = new Set(
  Object.keys(metaScalars({ W: 1, temp: 27 })),
);

/** Every name a sized device puts in its sheet's scope: the namespace quantities, the selectors,
 *  what the sizer adds beside them (SIZING_SCALARS), and the table's own scalars. */
export const DEVICE_NAMES: ReadonlySet<string> = new Set([
  ...BASE_KEYS,
  ...DERIVED_QUANTITIES.map((d) => d.key),
  ...BINDABLE,
  ...SIZING_SCALARS,
  ...META_PUBLISHED,
]);

/**
 * A private deep copy of a sheet document — the one clone every caller uses before editing a
 * document it does not own, since `withParams` copies the params array and leaves the checks,
 * equations and blocks aliased to the original.
 *
 * JSON rather than `structuredClone`, and both halves of that choice matter. A sheet edited in
 * the app is a reactive proxy, which `structuredClone` refuses outright. And JSON turns a
 * non-finite param value into `null` on the way through — harmless where validation refuses
 * both anyway, but the reason this is a SHEET clone and not a general-purpose one.
 */
export const cloneDoc = (doc: SheetDoc): SheetDoc => JSON.parse(JSON.stringify(doc)) as SheetDoc;

/** Clone a doc with the named params' VALUES overridden — the one override mechanism the
 *  sweeps and the range ends share, so a change to what an override must touch
 *  (e.g. clearing a solver field) has exactly one home. */
export function withParams(doc: SheetDoc, o: Record<string, number>): SheetDoc {
  return {
    ...doc,
    params: doc.params.map((p) =>
      Object.prototype.hasOwnProperty.call(o, p.name) ? { ...p, value: o[p.name] } : p,
    ),
  };
}

/** Re-attribute a composed child's warning to its block, so a rolled-up warning points at
 *  the offending one (and a child error still blocks the parent's closed feasibility). */
export function prefixBlockWarning(blockName: string, w: QAWarning): QAWarning {
  return {
    ...w,
    message: blockMessage(blockName, w.message),
    location: `${blockName}${PATH_SEP}${w.location ?? ''}`,
  };
}

/** A child's message as its parent reports it: attributed to the block. */
const blockMessage = (blockName: string, message: string): string =>
  `block "${blockName}": ${message}`;

/** A warning raised at the block path `segments` (top first), as the top of the tree reports it:
 *  attributed to each block on the way up. */
export const prefixBlockPath = (segments: readonly string[], w: QAWarning): QAWarning =>
  segments.reduceRight((acc, seg) => prefixBlockWarning(seg, acc), w);

/**
 * One end of the sheet's claimed operating range: one more full evaluation of THIS doc with the
 * named params' values overridden — each `set` expression evaluated against the base result —
 * whose outcome is reported as compliance, beside feasibility and never folded into it (see
 * RangeEndReport.state). The canonical use is the claimed common-mode range:
 * `{name: "cm-lo", set: {CM_dc: "CM_lo"}}` asks whether the design the base run produced still
 * holds at the low end, EXACTLY (its own constraint solve over the full stated range, its own
 * children) where a linearized advisory check could only estimate it. The devices are held at the
 * geometry the base run sized and only the bias re-settles, so the answer is about that design
 * and no other. Range ends check the ENDS, not the interior — the sweep remains the interval
 * authority. A composed child's range ends are not evaluated; the parent owns range claims.
 */
export interface SheetRangeEnd {
  name: string;
  /** param name → expression, evaluated in the BASE evaluation's scope */
  set: Record<string, string>;
  note?: string;
}

/** Separator between a range end's name and a check id in range-end-qualified ids
 *  (`cm-lo@sr-spec`). */
export const RANGE_END_SEP = '@';

/** Separator that joins a block path to a check id in tree-keyed results (`cs.headroom`). */
export const PATH_SEP = '.';

/** The first tree-key separator `name` contains, or undefined. Check outcomes across the
 *  whole composition — block paths (`cs.headroom`), range-end-qualified ids (`cm-lo@check`) —
 *  share ONE map, so every identifier that becomes part of a key (check ids, range end names,
 *  block names) reserves both separators; a name carrying one could silently shadow
 *  another check's outcome. One definition, so the reserved set cannot drift per site. */
export function idSepProblem(name: string): string | undefined {
  if (name.includes(RANGE_END_SEP)) return RANGE_END_SEP;
  if (name.includes(PATH_SEP)) return PATH_SEP;
  return undefined;
}

/** How a block names itself in a report or a warning: `givens` for the sheet's own device, the
 *  trimmed block path for anything below. One spelling, because a reader is meant to match a
 *  report's block against the warning that names the same one. */
export const blockPath = (path: string): string =>
  path === '' ? 'givens' : path.slice(0, -PATH_SEP.length);

/** How a finding names a device: the sheet's own, or a child by block path — the words a reader
 *  matches across warnings. */
export const deviceName = (d: string): string =>
  d === 'givens' ? "this sheet's own device" : `"${d}"`;

/** A sheet document — the authored model the GUI edits and persists verbatim. A leaf
 *  has no `blocks`; a composed sheet embeds blocks and references their `provide`d
 *  scalars. `provides` lists the names THIS sheet exposes to a parent (ignored at the top). */
export interface SheetDoc {
  title: string;
  /** A few sentences on what the sheet designs, its assumptions, and how to use it —
   *  the block comment a designer inheriting the sheet reads first. */
  description?: string;
  polarity: 'n' | 'p'; // a self-description label only; no contract enforced at leaf
  params: SheetVar[];
  givens?: SheetGivens;
  equations: SheetEquation[];
  checks: SheetCheck[];
  blocks?: SheetBlock[];
  provides?: string[];
  operatingRange?: SheetRangeEnd[];
  /**
   * The document format. Absent: the earlier format, which knows none of the keys below — a
   * document in it is still read, but a sized device in it is refused until it is migrated, since
   * every device names its wiring (see wiringRefusal; a script drafts the migration with proposeWiring and applyWiringProposal).
   * `2`: the format with a netlist — `nodes`, `levels`, `elements`, `ports`, `analyses` and a
   * param's `convention`. Any other number is a format this app does not read: such a document is
   * refused at import, and a stored copy is kept as it was stored and not evaluated. Stated per
   * document; an embedded child that states none is read in the earlier format.
   */
  formatVersion?: number;
  /**
   * `"none"`: the sheet is not a circuit — an abstract budget or a block-level estimate — and has
   * no wiring to check; exclusive with `levels`, `elements`, `analyses` and any block's `nodes`.
   * Otherwise, on a sheet that sizes a device, the wires that device sits on (see DeviceNodes);
   * a child's device is wired by its parent's block instead.
   */
  nodes?: SheetNodes | 'none';
  /**
   * The wires this sheet HOLDS, each at the level an expression gives it: supplies, references,
   * inputs, a bias the application applies. Every other wire's level is derived, for checking,
   * from the devices on it. Only a level the designer states may be written here (see
   * levelEligibility); `gnd` is 0 and is not listed.
   */
  levels?: Record<string, string>;
  /** Passives and ideal sources between wires (see SheetElement). */
  elements?: SheetElement[];
  /** The wires a parent may connect this sheet to (see SheetBlock.ports). A port is never
   *  reported as floating — its other end is outside the sheet — and a port of the sheet the walk
   *  runs on is not balanced, for the same reason. */
  ports?: string[];
  /** Small-signal analyses asked for by name (see SheetAnalysis). */
  analyses?: SheetAnalysis[];
}

/**
 * The exact key set of every authored container, stated beside the interfaces they mirror so a
 * document sanitizer can walk a parsed object against the REAL shape. GIVENS_KEYS/GIVENS_FLAGS above
 * exist for the same reason and stay separate only because the givens' keys additionally split by
 * type (expression vs flag). A sanitizer keeping its own copy of this knowledge is the mechanism
 * that silently ate a legal fT given on reload — and would have eaten `designConstraint` and
 * `diode` — so any new field belongs HERE, in the same edit that adds it to its interface.
 *
 * The keys format version 2 adds come first, per container (WIRING_*_KEYS) — what a document in
 * the earlier format may not carry (see SheetDoc.formatVersion) — and the key sets spread them in.
 */
export const WIRING_DOC_KEYS: readonly string[] = [
  'nodes',
  'levels',
  'elements',
  'ports',
  'analyses',
];
export const WIRING_BLOCK_KEYS: readonly string[] = ['nodes', 'ports'];
export const WIRING_VAR_KEYS: readonly string[] = ['convention'];
export const VAR_KEYS: ReadonlySet<string> = new Set<string>([
  'name', 'value', 'min', 'max', 'unit', 'role', 'note', 'solveFor', 'designConstraint', 'hold', 'class',
  ...WIRING_VAR_KEYS,
]); // prettier-ignore
export const EQUATION_KEYS: ReadonlySet<string> = new Set<string>(['name', 'expr', 'unit', 'note']);
export const CHECK_KEYS: ReadonlySet<string> = new Set<string>([
  'id', 'kind', 'lhs', 'op', 'rhs', 'tolPct', 'justification', 'note',
]); // prettier-ignore
export const BLOCK_KEYS: ReadonlySet<string> = new Set<string>([
  'name', 'doc', 'ref', 'device', 'params', ...WIRING_BLOCK_KEYS,
]); // prettier-ignore
export const RANGE_END_KEYS: ReadonlySet<string> = new Set<string>(['name', 'set', 'note']);
export const DOC_KEYS: ReadonlySet<string> = new Set<string>([
  'title', 'description', 'polarity', 'params', 'givens', 'equations', 'checks', 'blocks',
  'provides', 'operatingRange', 'formatVersion', ...WIRING_DOC_KEYS,
]); // prettier-ignore
/** Keys a block no longer carries in any format: the gate `wiring` of documents written before the
 *  netlist, which `nodes` state in format version 2. Named, so a document that still carries one
 *  is told how to migrate rather than seeing an unknown key. */
export const EARLIER_BLOCK_KEYS: readonly string[] = ['wiring'];

/**
 * Every authored expression in a doc, in one flat list: the givens, constrained and solved params,
 * the equations, both sides of every check, each block's param overrides,
 * each range end's setting, each held level, and each element value and analysis frequency
 * written as an expression. Lives HERE for the same reason the key sets above do: a consumer
 * keeping its own copy of which fields hold expressions goes silently stale the day a field
 * is added — so a new expression-bearing field joins this walk in the same edit that adds it
 * to its interface.
 */
export function docExpressions(doc: SheetDoc): string[] {
  const out: string[] = [];
  if (doc.givens) {
    for (const [k, v] of Object.entries(doc.givens)) {
      if (givenIsExpression(k) && typeof v === 'string') out.push(v);
    }
  }
  for (const p of doc.params) {
    if (constrained(p)) out.push(p.designConstraint.lhs, p.designConstraint.rhs);
    if (torn(p)) out.push(p.solveFor);
    if (holds(p)) out.push(p.hold);
  }
  for (const r of doc.equations) out.push(r.expr);
  for (const r of doc.checks) out.push(r.lhs, r.rhs);
  for (const u of doc.blocks ?? []) out.push(...Object.values(u.params ?? {}));
  for (const e of doc.operatingRange ?? []) out.push(...Object.values(e.set));
  // Read as `unknown` where a persisted document may carry the wrong shape; validation names it.
  const levels: unknown = doc.levels;
  if (isObject(levels))
    for (const v of Object.values(levels)) if (typeof v === 'string') out.push(v);
  for (const e of Array.isArray(doc.elements) ? doc.elements : [])
    if (typeof e?.value === 'string') out.push(e.value);
  for (const a of Array.isArray(doc.analyses) ? doc.analyses : [])
    if (typeof a?.at === 'string') out.push(a.at);
  return out;
}

/** A block's evaluated summary, surfaced so the UI can show each child's title,
 *  feasibility, and the scalar values it exposed — without re-evaluating the tree.
 *  `checks` (and nested `blocks`) carry the child's own check outcomes so a composed
 *  report or sweep can show WHICH check below the top sheet binds — otherwise a
 *  feasibility flip caused by a child's check has no visible cause at the top. */
export interface SheetBlockReport {
  name: string;
  title: string;
  feasible: boolean;
  /** The child's own sized operating point (W, VGS, ID, bias) or its sizing error — so a
   *  composed view can show each block's sizing, not just the scalars it exposes upward.
   *  Absent for a child that has no givens or died before sizing. */
  sizing?: SizingReport;
  provides: Record<string, number>;
  checks: CheckResult[];
  blocks?: SheetBlockReport[];
  /** This block's own held expressions at this run (see SheetResult.held). */
  held?: Record<string, number>;
  /** The block's device as the parent's wiring walk reads it — present where the parent's block
   *  names the wires it sits on (see SheetResult.terminals). */
  terminals?: DevicePoint;
  /** The block's own wiring check, where it has one (see SheetResult.nodes). */
  nodes?: NodesReport;
  /** The block's held levels and element values, where its wiring joins its parent's walk (see
   *  SheetResult.wiringValues). */
  wiringValues?: WiringValues;
  /** How the block's own solved params came out (see SheetResult.solve). */
  solve?: SolveOutcome;
}

/** What a sheet whose wiring joins its parent's walk evaluated its own held levels and element
 *  values to, in its own scope — the numbers the parent's walk cannot read itself. A level or an
 *  element that did not evaluate is absent. */
export interface WiringValues {
  levels: Record<string, number>;
  elements: Record<string, number>;
}

/**
 * What the DC wiring walk reads of one sized device: its operating point as the sizing and the
 * givens state it, in the table's axis convention, and what maps that onto physical terminal
 * voltages. The drain and body voltages are the ones the givens STATE, not a value a table that
 * does not reach them was read at — the walk checks the circuit the author wrote, and a clamp is
 * reported where it happens.
 */
export interface DevicePoint {
  /** The sized gate-source voltage, in the table's axis convention. */
  vgs: number;
  /** The drain-source voltage the givens state; the gate-source voltage for a diode connection. */
  vds: number;
  /** The source-body voltage the givens state, or 0 where they leave it to its default. */
  vsb: number;
  /** The drain current, a magnitude like every value column. */
  id: number;
  /** The small-signal sensitivities that turn a voltage residual into a current estimate. */
  gm?: number;
  gds?: number;
  gmb?: number;
  /** The direction of the table's vgs axis: +1 where it holds no negative value, -1 where it holds
   *  no positive one (a signed p export); absent where it holds both. */
  axis?: 1 | -1;
  /** The direction of the table's vsb axis, read on its own: +1 where it holds no negative value —
   *  a magnitude, the body above the source for a p device, the source above the body for an n
   *  one, whatever the vgs axis does (a signed p export can store vgs and vds negative and vsb
   *  positive) — and -1 where it holds a negative value, a signed axis that follows the vgs one.
   *  +1 for a table with no vsb axis, where the stated vsb is 0. */
  bodyAxis: 1 | -1;
  polarity: 'n' | 'p';
}

/** The outcome of a sheet's DC wiring check. `not-applicable` is a sheet that declares
 *  `nodes: "none"`. `not-evaluated` is a check that did not run, and its report is neither clean
 *  nor with findings: the point has no sized design for it to read (see PointOutcome.sized), or the
 *  document carries wiring keys in the earlier format, which does not read them. */
export type NodesState =
  'checked-clean' | 'checked-with-findings' | 'not-applicable' | 'not-evaluated';

/**
 * One sheet's DC wiring check: the relations its netlist states (each placement's gate, drain and
 * body voltage above its source; each held wire's level), checked for consistency after sizing.
 * Every number here is a reading of the sized design; none is fed back into it.
 */
export interface NodesReport {
  state: NodesState;
  /** Every wire reached from a seed (`gnd` and each held wire) through blocks that close, with the
   *  level it is reported at and the relations it was derived along. A seed is reported at its
   *  authored level. */
  levels: Record<string, { level: number; seed: boolean; via: string[] }>;
  /** Wires a seed reaches only through a block that does not close: never given a value. */
  tainted: string[];
  /** Groups of wires no seed reaches at all, each one missing statement. */
  floating: string[][];
  /** Each block of relations that does not close within NODE_TOL. */
  disputes: {
    relations: string[];
    closureError: number;
    chords: { relation: string; residual: number }[];
    seeds: string[];
  }[];
  /** The largest loop residual over every block: what "closes" is measured against. */
  closureError: number;
  /**
   * The constraints the netlist states beyond the sizing, counted by rank. `proven` counts the
   * loop equations that are linear in params and device quantities; `bound` counts them all,
   * including those with a term the count could not read (`undecided` names those terms). Each
   * equation that survives the count is listed with the relations it closes over, whether it
   * holds at this design point, and its residual.
   */
  dof: {
    proven: number;
    bound: number;
    constraints: { relations: string[]; residual: number; satisfied: boolean; proven: boolean }[];
    undecided: string[];
  };
  /**
   * The signed current residual at every wire a drain or source terminal sits on: the sum of the
   * currents flowing INTO the wire, from the devices and from ideal current sources. At a held wire
   * (`held`) it is the current the ideal source holding the wire takes, so that source supplies its
   * negative. A wire an element of unknown current touches (a resistor, a voltage source), or a port
   * of the sheet the walk runs on, is not summed.
   */
  balance: {
    wire: string;
    residual: number;
    held: boolean;
    branches: { terminal: string; current: number }[];
  }[];
  /** Each device placed more than once: whether its placements share one operating point. */
  placements: { device: string; shared: boolean; reason?: string }[];
  /** Relations the walk could not form, and why. */
  unresolved: string[];
  /** Sized devices on this sheet that name no wires. */
  unwired: string[];
  /** How many warnings and errors the check raised, here and in the blocks below. */
  findings: number;
  /** What the numbers above mean, in words: the closure error's meaning wherever a loop exists,
   *  the over-determination the rank count proves, and what it could not decide. */
  notes: string[];
}

/**
 * One range end's evaluated outcome: the numeric overrides the range end resolved to
 * (`set` — WHICH point was checked; the authored side may be an expression), its own check
 * results (and children, so a failure below the top doc keeps its path), the engine-solved
 * params where the range end landed (e.g. V_tail at CM_lo — empty when the run did not stand,
 * so a range end's probe is never reported as a landing), the run's own warnings VERBATIM (a
 * bias clamp fires exactly at a claim's extreme, and a green chip must not rest on
 * silently clamped data), and — when the run could not be evaluated at all — the solver's
 * message in `error`, so a budget starvation stays tellable from "nothing in the range
 * reaches it". Check-level failures live in `checks`, never in `error`.
 */
export interface RangeEndReport {
  name: string;
  /**
   * Which of FOUR outcomes this range end reached. `complies` / `does-not-comply` are verdicts
   * about the held design, measured at this end. The other two are not verdicts and must never
   * be shown as one:
   *
   * - `not-run`: the question was never put, because the base run produced no design to hold
   *   (see `stands`). Carries no `error` and no outcomes — nothing ran.
   * - `no-answer`: the question was put and could not be answered. The run did not complete (a
   *   solve that did not land, an override that did not resolve), or it completed on data read
   *   off the table's hull. `error` says which; the check outcomes it may carry were taken at a
   *   point that is not the one asked about, so nothing reads them as findings.
   *
   * `does-not-comply` carries an `error` in one case: a device held at its width cannot carry
   * its current at this end at all. That is a measured failure of the design, not a gap in the
   * tool, though it leaves no check outcomes either.
   */
  state: PointState;
  set: Record<string, number>;
  checks: CheckResult[];
  blocks?: SheetBlockReport[];
  solved: Record<string, number>;
  warnings: QAWarning[];
  error?: string;
  /** The DC wiring check of this run, on a sheet that states wiring: `not-evaluated` wherever the
   *  end has no answer (see NodesState). */
  nodes?: NodesReport;
  /** Blocks whose givens named neither a width nor a current, so this run held the base current
   *  by ASSUMPTION — an ideal source, since the sheet never said where the current comes from.
   *  Paths as warnings spell them (`givens` for the sheet's own device, the block path for a
   *  child). Reported rather than warned, like SizingReport.assumed: it is a property of what
   *  the author wrote down, and the fix is to author the current explicitly. */
  assumedSource?: string[];
}

/** A range end's outcome — one compliance point's. `not-run` and `no-answer` are first-class
 *  answers, not absences: asking a question of a design that does not exist, or of data that
 *  does not reach, has no honest verdict, and inventing one (either way) is what these two
 *  states exist to prevent. */
export type PointState = 'complies' | 'does-not-comply' | 'no-answer' | 'not-run';

export type CheckStatus = 'pass' | 'amber' | 'fail' | 'na';

/**
 * The evaluated outcome of one check: the two sides, a signed margin (SI distance to
 * the bound; >= 0 passes), its relative size, and a four-state status. `na` means a
 * side could not be computed (undeclared name, eval error, or a non-finite value) —
 * never a silent pass.
 */
export interface CheckResult {
  id: string;
  kind: CheckKind;
  /** The comparison this outcome came from, carried structurally rather than left to be read
   *  back out of `text` — the same discipline SheetCheck states for the authored side. A
   *  consumer that must treat '==' differently (its margin has a CUSP at agreement, so a
   *  central derivative across it is meaningless) needs the operator, not a rendering of it. */
  op: CheckOp;
  text: string; // human-readable "lhs op rhs"
  lhsValue: number;
  rhsValue: number;
  margin: number;
  marginPct: number;
  /**
   * The margin BEFORE the near-zero snap (see MARGIN_SNAP_REL) — the honest signed distance,
   * whatever its size. `margin` deliberately reads 0 on a check parked on its own boundary so a
   * verdict cannot coin-flip on floating-point noise; a derivative taken from that snapped
   * value would read zero slope for a check that is in fact moving. Verdicts and display use
   * `margin`; anything DIFFERENCING margins uses this.
   */
  rawMargin: number;
  status: CheckStatus;
  detail?: string;
}

/**
 * The headline of the sized operating point for display, or an error when the sizing
 * could not be solved (out-of-range gm/ID, missing characterization width, no device).
 * The full operating point (gm, gm/ID, ceiling, feasible, vstar, …) reaches equations and
 * checks through the merged `values` map, so it is not duplicated here.
 */
export interface SizingReport {
  ok: boolean;
  W: number;
  /** The length the givens resolved to — what the sizing was ASKED for (a length off the table's
   *  L hull is clamped by the sizer, which says so in its own warning). Reported beside W
   *  because the two together are the transistor: a caller holding a design fixed while its
   *  bias moves needs the geometry, and re-evaluating the authored L expression at the new
   *  bias is exactly what "fixed" forbids. */
  L: number;
  vgs: number;
  id: number;
  /** The operating-point coordinates the table was sliced at before sizing (per bias
   *  axis, signed) — declared in the givens, or defaulted for body bias. Absent when the
   *  table needed no reduction. Makes the sizing bias visible in reports. */
  bias?: Record<string, number>;
  /** Bias axes this block must declare: `vds` where its givens state neither a drain voltage
   *  nor a diode connection, on any table (it varies per device and has no default), and `vsb`
   *  where the table does not answer for its default of 0, body-grounded. Present only on a
   *  sizing that failed at the operating point — a given that did not resolve, or givens that
   *  do not size at all, is reported alone — so the UI can offer an in-place fix. */
  needs?: string[];
  /** Bias axes whose coordinate the engine ASSUMED (the namespace default) because the givens
   *  left them undeclared — an authored operating point and a filled-in one must be tellable
   *  apart. Reported rather than warned, so the UI can mark it in place; see
   *  docs/sheet-format.md for when the default is wrong and why this is not a warning. */
  assumed?: string[];
  /** Coordinates the sizing asked for and the table does not reach (`vds`, `vsb`, `l`, a
   *  supplied `vgs`), each read at the nearest characterized value instead and warned about.
   *  At the design's own operating point that is an advisory; where a held design is being
   *  asked whether it still works, an answer read somewhere else is no answer (see clampedIn). */
  clamped?: string[];
  /** Axes the givens use and the table does not sweep (`vds`, `vsb`, `l`) — present only on a
   *  failed sizing, and what marks it as REFUSED: the table cannot answer for this device at
   *  all, which no knob, search range or re-bias changes (see refusedIn). `error` says why. */
  unswept?: string[];
  /** Where the device's thermal-noise figures (`vnth_m`, `svth_m`, `gamma`) come from: the table's
   *  own noise, or the γ = GAMMA_DEFAULT estimate (see noiseSource). A fact about the table it was
   *  sized on, carried on the sizing so a result can say which its noise rows are. Present on a
   *  sizing that succeeded. */
  noise?: NoiseSource;
  /** The derived quantities the table this device was sized on computes by a fallback form
   *  rather than their definition — a γ-model noise figure without a `gmb` column, γ without
   *  `sth` — each with the missing column, the form used and what it costs (see FallbackNote).
   *  Like `noise`, a fact about the table, carried on the sizing so a result says which of its
   *  rows rest on a lesser form. Present on a sizing that succeeded and fell back somewhere. */
  fallbacks?: FallbackNote[];
  /** The table's pass-through columns (see passthroughKeys) this sizing put in the sheet's scope,
   *  under their own names. Each is read as characterized, at the characterization width `w0`,
   *  not rescaled to `W`: nothing says how it scales. Present on a sizing that succeeded and
   *  read any. */
  passthrough?: string[];
  error?: string;
}

/**
 * The full evaluation of a sheet: every resolved scalar, the sizing report, the check
 * outcomes, an overall feasibility, and any validation/eval warnings.
 *
 * `feasible` is fail-closed: true only when declared givens sized successfully, every
 * physical AND spec check holds (pass or near-miss), and no error-severity warning
 * was raised (including validation errors, via runSheet). Advisory checks do not affect it.
 */
export interface SheetResult {
  values: Record<string, number>;
  sizing?: SizingReport;
  checks: CheckResult[];
  feasible: boolean;
  warnings: QAWarning[];
  /** Present (possibly empty) only when the sheet composes children; absent for a leaf. */
  blocks?: SheetBlockReport[];
  /** Present only when the doc declares an operating range (top-level evaluation only). */
  rangeEnds?: RangeEndReport[];
  /**
   * Whether the design this run produced, held fixed, still works at every end of its claimed
   * operating range — true only when every range end came back `complies`. A second question,
   * never folded into `feasible`: a design that meets every spec where it was sized and loses a
   * range end is feasible and does not comply. ABSENT when the range ends were not run, which
   * is the honest shape: an unasked question is not a `false`, and a consumer that read one
   * would report a failure the engine never looked for.
   */
  complies?: boolean;
  /**
   * The params classed `assumed` whose value reaches at least one device's sizing, anywhere in
   * the tree — the levels this design was sized under rather than solved for. Qualified by block
   * path below the top sheet (`stage1.V_out`) and in document order, so the list is stable across
   * evaluations. Empty when the sheet assumes nothing. A doc-level fact from the same walk the
   * `sheet-dc-inputs` rule makes (see dcInputs), attached where a whole sheet is run — runSheet
   * and the condition runs — once per document rather than per evaluation. ABSENT on a bare
   * evaluateSheet result and on every inner one (a child, a solver probe, a range-end run): not
   * computed there, which is not the same as assuming nothing.
   */
  assumptions?: string[];
  /**
   * What each of THIS sheet's `hold` expressions evaluated to, by param name — for a node under a
   * cascode's gate, the gate bias the design needs; for a current balance, zero. Read from the
   * finished run, after every override and solve. A fixed-hardware run holds each expression at
   * this value. Absent when the sheet holds nothing; a child's own are on its report.
   */
  held?: Record<string, number>;
  /** This sheet's own device as its parent's wiring walk reads it (see DevicePoint). Present only
   *  where the parent's block names the wires the device sits on. */
  terminals?: DevicePoint;
  /** The sheet's DC wiring check (see NodesReport). Absent on a sheet that declares no wiring, and on
   *  one whose wiring joins its parent's walk (its parent's report covers it). */
  nodes?: NodesReport;
  /** This sheet's held levels and element values, where its wiring joins its parent's walk (see
   *  WiringValues). */
  wiringValues?: WiringValues;
  /** This run as one point of the compliance question (see pointOutcome): set on a top-level
   *  evaluation. */
  point?: PointOutcome;
  /** How this sheet's own solved params came out (see SolveOutcome); a child's own are on its
   *  report. */
  solve?: SolveOutcome;
}

/**
 * How the params one sheet solves came out: the scope rule's outcomes as data, written beside the
 * `sheet-solve` error that says the same in words (`message`, verbatim).
 *  - `settled`: every solved param was found, and verified on the evaluation returned;
 *  - `no-solution`: the named unknown has no solution in `range`, the stretch actually searched;
 *  - `not-settled`: the named unknowns did not settle, for the reason `why` gives;
 *  - `declaration-false`: a `hold` of the sheet does not hold where the design is sized — it does
 *    not evaluate, or it is a current balance that does not read zero — so the run has nothing to
 *    hold it at. No search failed here: the declaration itself is false at the design point.
 * Absent on a run with no solved param to find whose holds, if any, all evaluated. Where several
 * failures are raised, it is the last of them, as the warnings list them.
 */
export type SolveOutcome =
  | { kind: 'settled' }
  | { kind: 'no-solution'; unknown: string; range: [number, number]; message: string }
  | { kind: 'not-settled'; unknowns: string[]; why: NotSettledWhy; message: string }
  | { kind: 'declaration-false'; param: string; message: string };

/** A solve outcome that is not `settled`. */
export type SolveFailure = Exclude<SolveOutcome, { kind: 'settled' }>;

/**
 * Why solved params did not settle:
 *  - `budget`: the tree's shared evaluation budget ran out, here or in a child a probe evaluated;
 *  - `probes`: one search used up the probes it may spend;
 *  - `unevaluable`: the relation could not be evaluated across the range, or across the stretch
 *    where it changes sign;
 *  - `member`: one member of a set of params that depend on each other failed with the others
 *    where they stood, which says nothing about the set;
 *  - `sweeps`: such a set was still moving after the fixed number of sweeps;
 *  - `verification`: read from the final evaluation, a relation was outside its tolerance;
 *  - `malformed`: the declarations cannot be solved as written (see constraintProblem).
 */
export type NotSettledWhy =
  'budget' | 'probes' | 'unevaluable' | 'member' | 'sweeps' | 'verification' | 'malformed';

const isSolveFailure = (o: SolveOutcome | undefined): o is SolveFailure =>
  o !== undefined && o.kind !== 'settled';

/** Whether a solve failed anywhere in one evaluation's tree: its own, or a block's at any depth. */
export function solveFailedIn(res: {
  solve?: SolveOutcome;
  blocks?: readonly SheetBlockReport[];
}): boolean {
  return isSolveFailure(res.solve) || (res.blocks ?? []).some(solveFailedIn);
}

/** The message of the solve failure an evaluation's warnings list last, in the words they list it
 *  in: its own, which is raised after everything below it, else the last block's that has one,
 *  attributed to the block as a rolled-up warning is (prefixBlockWarning). Undefined where every
 *  solve in the tree settled. */
export function lastSolveFailure(res: {
  solve?: SolveOutcome;
  blocks?: readonly SheetBlockReport[];
}): string | undefined {
  if (isSolveFailure(res.solve)) return res.solve.message;
  const blocks = res.blocks ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const below = lastSolveFailure(blocks[i]);
    if (below !== undefined) return blockMessage(blocks[i].name, below);
  }
  return undefined;
}

/**
 * One run as a point of the compliance question, classified once and read by every reader — the
 * wiring walk's gate, a range end, a process condition. Two facts, kept apart:
 *  - `sized`: the sizing at this point stood — no solve error, no device refused or unsized, and,
 *    for a held design, no device read off its table's hull. Only then does the wiring check run.
 *  - `state` (with `error` where the point is no verdict): the answer the point gives. A design
 *    resting on an assumed level was sized, and still has no answer.
 */
export interface PointOutcome {
  sized: boolean;
  state: Exclude<PointState, 'not-run'>;
  error?: string;
}

/**
 * Whether an evaluation produced numbers worth standing on — the ONE definition of "there is a
 * design here", shared by the sensitivity readout (which will not difference around a point that
 * is not one) and the range-end runs (which will not hold hardware fixed at one). A hard check
 * FAILING is a perfectly good point: the signed margin is exactly the signal those callers want,
 * and refusing the infeasible side would blind them precisely where a designer needs them. What
 * does not stand is an evaluation that could not be COMPLETED: an error-severity diagnostic (which
 * givens that did not size already raise, and a failed design constraint raises through
 * solveFailed). What happened at a range end is not part of it: that is a question about the
 * design, asked after this one is answered, and its failure is reported in its own `error`, never
 * merged upward.
 */
export function stands(res: SheetResult): boolean {
  return !res.warnings.some((w) => w.severity === 'error');
}

/** Why an evaluation that did not stand did not complete, in its own words: its error
 *  diagnostics, in order. Never empty — a refusal with no reason is indistinguishable from a
 *  verdict — so a run with none reads that the evaluation did not complete. */
export function unfinishedBecause(res: SheetResult): string[] {
  const errors = res.warnings.filter((w) => w.severity === 'error').map((w) => w.message);
  return errors.length ? errors : ['the evaluation did not complete'];
}

/** The range end was run and left no check outcomes to read: it could not be answered, or a held
 *  device could not carry its current there. As distinct from `not-run`, where nothing was
 *  attempted at all. Named once rather than retyped at each consumer: it is a two-field
 *  conjunction, and the site that gets its polarity wrong is the site that turns "we did not
 *  look" back into "we looked and it failed". */
export const rangeEndBroke = (e: RangeEndReport): boolean =>
  e.state !== 'not-run' && e.error !== undefined;

/** The same doc with its operating range dropped, so an evaluation of it answers feasibility
 *  alone and never enters the range-end runs. Structural. */
export function withoutRange(doc: SheetDoc): SheetDoc {
  const { operatingRange: _range, ...rest } = doc;
  return rest;
}

/** Every coordinate, anywhere in one evaluation's tree, that a device was asked for and its
 *  table does not reach (see SizingReport.clamped) — `givens vds` for the sheet's own device,
 *  `stage1.load l` for a child's. Empty when every operating point was read where it was asked
 *  for. A held design's run consults it before calling its outcome an answer. */
export const clampedIn = (res: TreeSizings): string[] =>
  devicesIn(res, (s, at) => (s.clamped ?? []).map((axis) => `${at} ${axis}`));

/** One evaluation's tree as the walks over its sizings read it. */
type TreeSizings = { sizing?: SizingReport; blocks?: readonly SheetBlockReport[] };

/** What `f` reads of every device sized anywhere in one evaluation's tree, in tree order — each
 *  named as findings name it: `givens` for the sheet's own device, the block path below it. */
export function devicesIn<T>(
  res: TreeSizings,
  f: (sizing: SizingReport, device: string) => T[],
  path = '',
): T[] {
  const out = res.sizing ? f(res.sizing, path || 'givens') : [];
  for (const c of res.blocks ?? []) out.push(...devicesIn(c, f, childPath(path, c.name)));
  return out;
}

/** Every device, anywhere in one evaluation's tree, that was refused because its table lacks a
 *  sweep its givens use (see SizingReport.unswept) — each in the words the run's own error
 *  carries it in, `block "pair": given vsb = 0.3 asks for …`. Empty when every device had the
 *  data it asked for. Consulted before any reading of the run's other failures: with a device
 *  missing, what the rest of the design then did is not a finding about the design. */
export function refusedIn(res: TreeSizings): string[] {
  const out = res.sizing?.unswept?.length ? [res.sizing.error ?? 'the device is not sized'] : [];
  for (const c of res.blocks ?? []) out.push(...refusedIn(c).map((m) => blockMessage(c.name, m)));
  return out;
}

/** Every device sized anywhere in one evaluation's tree, with where its thermal-noise figures
 *  come from (SizingReport.noise) and the fallback forms its table forced (SizingReport.fallbacks,
 *  empty when none), named as clampedIn names them (`givens` for the sheet's own device, a block
 *  path below it) and in tree order. A device that did not size is not listed. */
export const noiseSourcesIn = (
  res: TreeSizings,
): { device: string; source: NoiseSource; fallbacks: FallbackNote[] }[] =>
  devicesIn(res, (s, device) =>
    s.noise ? [{ device, source: s.noise, fallbacks: s.fallbacks ?? [] }] : [],
  );

/** `pre` — what resolving and validating a sheet found — without the findings the evaluation
 *  then repeats in the same words at the same place. A device that states no drain voltage is
 *  named when the sheet is validated and refused when it is sized; a reader needs it once, and
 *  the evaluation's is the one that carries the consequence. */
export function withoutRestated(
  pre: readonly QAWarning[],
  evaluated: readonly QAWarning[],
): QAWarning[] {
  return pre.filter(
    (w) =>
      !evaluated.some(
        (e) => e.rule === w.rule && e.location === w.location && e.message === w.message,
      ),
  );
}

/**
 * One evaluation with what resolving and validating its document found, as both seams that run a
 * sheet report it (runSheet, and a condition run): the validation findings first — less those the
 * evaluation repeats — then the evaluation's, and the wiring check's verdict counting the netlist's
 * structural problems (a misspelt wire, a short, a level that may not be held) as findings, since
 * they belong to that verdict as much as what the walk found. A walk that did not run stays
 * not-evaluated, with the structural findings counted.
 */
export function withValidation(pre: readonly QAWarning[], res: SheetResult): SheetResult {
  const structural = pre.filter(
    (w) => w.rule === 'sheet-nodes' || w.rule === 'sheet-format',
  ).length;
  const nodes =
    res.nodes && structural && res.nodes.state !== 'not-applicable'
      ? {
          ...res.nodes,
          state:
            res.nodes.state === 'not-evaluated'
              ? ('not-evaluated' as const)
              : ('checked-with-findings' as const),
          findings: res.nodes.findings + structural,
        }
      : res.nodes;
  return {
    ...res,
    warnings: [...withoutRestated(pre, res.warnings), ...res.warnings],
    ...(nodes ? { nodes } : {}),
  };
}

/** Index one evaluation's check outcomes under `prefix`, by the tree-key scheme the sweep's
 *  check collection uses: a child's outcomes carry its block path (`cs.headroom`). */
export function indexTreeResults(
  checks: readonly CheckResult[],
  blocks: readonly SheetBlockReport[] | undefined,
  prefix: string,
  into: Map<string, CheckResult>,
): void {
  for (const rr of checks) into.set(prefix + rr.id, rr);
  for (const c of blocks ?? [])
    indexTreeResults(c.checks, c.blocks, `${prefix}${c.name}${PATH_SEP}`, into);
}

/** Every check outcome of one evaluation keyed by its tree key — block paths below the top sheet,
 *  range end names for the range-end runs (`cm-lo@sr-spec`). The ONE walk every consumer
 *  that names a check across a whole evaluation shares (the binding and limiting checks,
 *  the sensitivity readout), so they can never disagree about what a check is called.
 *
 *  A range end that carries an `error` contributes NOTHING: its checks were evaluated wherever its
 *  solve stopped, or on data read off the table's hull — a point the engine was not asked about
 *  — so reading them as outcomes names a check that was measured on a phantom. The range end's
 *  own `error` is the finding there. A range end that was not run contributes nothing for the
 *  plainer reason that it has no outcomes at all — stated rather than left to the empty array,
 *  so the two reasons stay tellable apart here as everywhere else. */
export function treeCheckResults(res: {
  checks: readonly CheckResult[];
  blocks?: readonly SheetBlockReport[];
  rangeEnds?: readonly RangeEndReport[];
}): Map<string, CheckResult> {
  const byPath = new Map<string, CheckResult>();
  indexTreeResults(res.checks, res.blocks, '', byPath);
  for (const e of res.rangeEnds ?? [])
    if (e.state !== 'not-run' && e.error === undefined)
      indexTreeResults(e.checks, e.blocks, `${e.name}${RANGE_END_SEP}`, byPath);
  return byPath;
}

/**
 * One check's response to one parameter's perturbation — the missing half of a margin. A margin
 * says how much room a constraint has; this says which knob moves it, and how fast, so
 * "infeasible" comes with somewhere to turn.
 *
 * Margins are DIFFERENCED raw (see CheckResult.rawMargin), in SI units of the check's own two
 * sides. `deltaPlus`/`deltaMinus` are the change over one step in each direction — the ranking
 * quantity, since they compare knobs at a common fractional move — and `dMarginPerUnit` is the
 * slope in margin per unit of the parameter. Any of the three is NaN where it could not be
 * formed: a probe that did not stand, a direction a bound blocked, or an equality check, whose
 * margin has a cusp at agreement and therefore no central derivative.
 */
export interface SheetSensitivityCheck {
  id: string;
  kind: CheckKind;
  baseStatus: CheckStatus;
  baseMargin: number;
  dMarginPerUnit: number;
  deltaPlus: number;
  deltaMinus: number;
}

/**
 * One parameter's sensitivity entry: the point it was taken at, the step used, and one record
 * per check in the whole composition. `error` explains what could not be probed — a parameter the
 * engine solves rather than the author setting, a zero value with no range to scale a step from,
 * a step that does not fit inside the bounds, or a perturbed evaluation that did not stand. The
 * first three leave `checks` empty; the last is per-DIRECTION, so an entry can carry both an error
 * and the records the surviving side still supports. Never a fabricated slope: whatever the
 * failed side would have contributed reads NaN.
 */
export interface SheetSensitivity {
  param: string;
  value: number;
  step: number;
  checks: SheetSensitivityCheck[];
  error?: string;
}

/**
 * One check's relative margin traced across a parameter sweep, parallel to the sweep's `x`.
 * `null` where the check was `na` (a side could not be computed at that point). The relative
 * (dimensionless) margin — not the raw SI margin — is what lets checks of different units share
 * one axis. In a composed sweep, descendant blocks' HARD checks ride along with path-prefixed
 * ids (`cs.headroom`) so the check that binds is on the chart wherever it lives.
 */
export interface SheetSweepCheck {
  id: string;
  kind: CheckKind;
  marginPct: (number | null)[];
  /** Present on a range end's aggregate curve (the range end's name): the trace is the
   *  range-end run's WORST hard-check margin, not a single authored check — consumers label it as
   *  a range end rather than parsing the trailing separator out of the id. */
  rangeEnd?: string;
}

/**
 * A leaf sheet evaluated across a grid of one parameter's [min,max] range: the X samples, each
 * check's relative-margin curve, and the overall feasibility at each point. The classic gm/ID
 * feasibility-region view — wherever every hard check's curve sits at or above zero, the design
 * is feasible. Empty (`x: []`) when the named parameter is not a finitely-bounded slider variable.
 */
export interface SheetSweep {
  param: string;
  unit: string;
  x: number[];
  checks: SheetSweepCheck[];
  feasible: boolean[];
  /**
   * Whether each sample's evaluation completed (see `stands`). A sample that did not is
   * infeasible, and its check margins were read wherever a solve stopped — carried as data so a
   * consumer comparing samples never mistakes that for a design that merely misses a spec.
   */
  stands: boolean[];
}

/**
 * A sheet evaluated across the 2-D grid of two parameters' [min,max] ranges — the design-plane
 * view (gm_id × L is the classic) a 1-D cut cannot answer, e.g. "the minimum L that stays
 * feasible across the whole gm_id range". `feasible[yi][xi]` maps the region; `binding[yi][xi]`
 * names the WORST failing hard check at each infeasible cell (tree-path id, so a child's
 * check is named as `cs.headroom`), or null where feasible / failed without a failing check
 * (e.g. a sizing error). Empty (`x: []`) unless both params are distinct, finitely-bounded
 * slider variables.
 */
export interface SheetSweep2 {
  paramX: string;
  paramY: string;
  unitX: string;
  unitY: string;
  x: number[];
  y: number[];
  feasible: boolean[][];
  binding: (string | null)[][];
}
