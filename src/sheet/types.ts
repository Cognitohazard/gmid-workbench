// A leaf design-sheet: a single self-contained block evaluated against ONE device's
// lookup tables + PDK constants. Flat and declarative — named scalar params, an
// optional bind-any-2 device, named author-expression equations, and named comparison
// checks. NO circuit-domain nouns (no nodes/ports/KCL): a leaf has one block and no
// shared node, so the coupling channels that would court a nodal solver are absent by
// construction. Pure data; zero DOM imports.

import type { QAWarning } from '../types';
import { BASE_QUANTITIES } from '../namespace';
import { BINDABLE } from '../device';
import { additiveCoefficient } from '../expr';

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
   * Marks this param as a TEARING VARIABLE and names the value it must agree with, closing
   * a bias loop the composition DAG cannot express. Children evaluate in document order and
   * can only read earlier siblings, so a real circuit's cyclic bias (the input pair's drain
   * sits below the mirror's VGS, while the pair's own VGS sets the tail node it stands on)
   * has to be cut somewhere; the author cuts it with an estimate, and this field says what
   * the estimate is an estimate OF. Evaluation then iterates the sheet to a fixed point
   * instead of leaving a human to retune the slider until an advisory check goes green.
   *
   * The target is any name resolvable in THIS sheet's namespace once its body has run —
   * typically a child's provided scalar (`in__vgs`), but an equation or the sheet's own sized
   * operating point works too. `value` is only the starting guess. A target that does not
   * resolve, or an iteration that does not settle, fails closed rather than reporting a
   * design sized against a stale estimate.
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
   * Solved by BISECTION on [min, max] (both required — they are the bracket, not slider bounds).
   * Bisection needs no contraction, cannot overshoot, and cannot depend on a starting guess, so
   * the failure modes substitution has (two-cycles, rotation, damping heuristics) do not exist
   * for it. Its honesty condition is stated instead of hidden: `lhs - rhs` must change sign
   * across the bracket, and the solve fails closed when it does not, when an end does not
   * evaluate, or when the crossing turns out to be a jump. If the relation folds inside the
   * bracket the root found is determined by the authored bracket alone — never by history.
   *
   * `value` is only the displayed default; the solved value replaces it. A constrained param is not
   * sweepable (sweep the spec on the other side of the constraint instead). A sheet may constrain
   * several params when they can be solved one after another — each one's relation reading only
   * params solved before it (see constraintPlan); two that depend on each other are a coupled
   * system, which is refused.
   *
   * `held` is set by the engine, never authored: it marks the constraint a fixed-hardware run
   * generates from a `hold` (see below).
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
   * param is re-solved, by the same bisection a `designConstraint` uses on [min, max]. That is what
   * silicon does: a bias line holds the gate, and the node under it moves with the condition.
   *
   * The expression must be a sum of terms in which this param appears exactly once, bare or
   * times a numeric literal (see additiveCoefficient) — so its dependence on the node is there
   * to read, not inferred. A relation of any other shape, or a gate bias the sheet provides, is a
   * `designConstraint`, which is solved at the nominal run as well.
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
}

/** The authorable DC-level classes (see SheetVar.class). `solved` is deliberately absent: it is
 *  derived from `designConstraint`/`solveFor`, never written. */
export type ParamClass = 'independent' | 'assumed';
export const PARAM_CLASSES: ReadonlySet<string> = new Set<ParamClass>(['independent', 'assumed']);

/** Type guard: a CONSTRAINED param — one the engine solves by bracketed inversion (see
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
 *  `rhs`, the value it took at the nominal run. The one spelling of that rewrite, shared by the run
 *  that performs it and the validator that checks the solve order it will need. */
export function holdAsConstraint(p: SheetVar & { hold: string }, rhs: string): SheetVar {
  const { hold, ...rest } = p;
  return { ...rest, designConstraint: { lhs: hold, rhs, held: true } };
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
  const half = params.find((p) => p.designConstraint !== undefined && !constrained(p));
  if (half)
    return (
      `param "${half.name}": its design constraint needs both lhs and rhs — half-written, it would freeze the ` +
      `param without solving it`
    );
  const constrainedParams = params.filter(constrained);
  const both = constrainedParams.find((p) => torn(p));
  if (both)
    return (
      `param "${both.name}" has a design constraint and is also a tearing variable — the two would fight over ` +
      `it; keep one solver`
    );
  const bracketed = (p: SheetVar): boolean =>
    Number.isFinite(p.min) && Number.isFinite(p.max) && (p.min as number) < (p.max as number);
  const unbracketed = constrainedParams.find((p) => !bracketed(p));
  if (unbracketed)
    return (
      `constrained param "${unbracketed.name}" needs finite min < max — they are the bisection ` +
      `bracket, not slider bounds`
    );
  const held = params.filter(holds);
  const twice = held.find((p) => p.designConstraint !== undefined || torn(p));
  if (twice)
    return (
      `param "${twice.name}" carries hold and also has a design constraint or is a tearing variable — a param ` +
      `takes one of the three`
    );
  const loose = held.find((p) => !bracketed(p));
  if (loose)
    return (
      `held param "${loose.name}" needs finite min < max — the bracket it is re-solved in ` +
      `where the hardware is held`
    );
  const shapeless = held.find((p) => additiveCoefficient(p.hold, p.name) === undefined);
  if (shapeless)
    return (
      `param "${shapeless.name}": hold "${shapeless.hold}" must be a sum of terms in which ` +
      `${shapeless.name} appears exactly once, bare or times a number — write any other ` +
      `relation as a design constraint`
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
 * mid-supply value, so an undeclared bias silently overstates gain). An axis left undeclared
 * takes its namespace default and is reported as ASSUMED (see SizingReport.assumed), or — for
 * vds, which has no honest default — fails the sizing.
 *
 * A device is sized only on a table that carries what its givens use. A bias declared on an
 * axis the table does not sweep is sized where the table was taken — its one value on that axis,
 * or vsb = 0 for a table with no `vsb` column — and nowhere else: any other value, and a diode
 * connection on a table with no vds sweep, fails the sizing with the reason. `L` on a table
 * taken at one length is held to the same rule.
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
 * `name` nor a provided key may contain `__`). This is scalar composition only: the
 * parent references child outputs and writes its own author math over them. There is
 * NO node/port/KCL machinery — those remain the deferred coupling channels.
 */
/**
 * How a block's GATE is wired, declared so the engine can check the identity that
 * wiring imposes. A sheet already declares vds/vsb — differences the tables are indexed by —
 * but never the gate NODE, because vgs is an output of the sizing rather than an input. That
 * leaves a node that is free (some param names its level), implied (the child's vgs describes
 * the same wire), and unchecked, which is how two devices' givens can imply gate voltages hundreds
 * of millivolts apart with every check still green.
 *
 * Both `gate` and `source` are expressions in the PARENT's scope — the node the child's gate
 * is tied to, and the node its source sits on. The identity checked is
 * `gate == source + (the child is p-type ? -1 : +1) * abs(<the child's sized vgs>)`: a gate
 * sits one gate-source voltage ABOVE its source on an N device and one BELOW it on a P device,
 * which is the whole of the convention. Taking the magnitude and the direction separately is
 * what makes the check independent of how the table was exported — a signed PMOS export
 * (negative vgs axis) and one in N convention (positive) give the same answer — where an
 * author-written sign expression could silently INVERT the identity and report agreement on a
 * design wired backwards.
 *
 * The voltage compared against is the child's SIZED vgs, not a scalar it publishes: the sizing
 * always has it, so the check cannot be switched off by an authoring omission upstream.
 */
export interface SheetWiring {
  gate: string;
  source: string;
}

/** The exact key set of a `wiring` declaration — strict, like GIVENS_KEYS/RANGE_END_KEYS, so a typo
 *  is named rather than silently dropping half of the identity. */
export const WIRING_KEYS: ReadonlySet<string> = new Set<string>(['gate', 'source']);

export interface SheetBlock {
  name: string;
  doc?: SheetDoc;
  ref?: string;
  device?: string;
  params?: Record<string, string>;
  /** The node this child's gate and source are tied to; checked, never used to size (see
   *  SheetWiring). Disagreement is a warning — a wiring declaration describes the schematic,
   *  and QA surfaces what it finds instead of quietly repairing the design. */
  wiring?: SheetWiring;
}

/** Maximum composition nesting depth — a backstop against a pathologically deep
 *  authored tree (embedded docs form a finite tree, so this is a sanity cap, not a
 *  cycle guard). Shared by the evaluator and the validator. */
export const MAX_BLOCK_DEPTH = 8;

/** Maximum tearing variables (params carrying `solveFor`) one sheet may declare. The scope rule
 *  permits "small, explicit, designer-named fixed points" and forbids a nodal solver; tearing
 *  many unknowns at once crosses that line into relaxation over a node set. Shared by the
 *  validator and the format docs so the limit is stated once. */
export const MAX_TORN_PARAMS = 4;

/** A param the engine solves for rather than the author setting — the ONE definition of
 *  "torn", mirroring how `sweepable` owns the notion of a free slider variable. A type guard,
 *  so a caller that narrows gets `solveFor` as a plain string instead of casting it. */
export function torn(p: SheetVar): p is SheetVar & { solveFor: string } {
  return typeof p.solveFor === 'string' && p.solveFor !== '';
}

/** A param the ENGINE resolves rather than the author setting — torn (substitution) or constrained
 *  (bisection). The one predicate for every surface that renders "solved, not set": read-only
 *  fields, slider suppression. (`sweepable` keeps its own structural test on purpose: it must
 *  also refuse to sweep a MALFORMED design constraint, which the shape guards here deliberately
 *  reject so constraintProblem can name it.) */
export function engineSolved(p: SheetVar): boolean {
  return torn(p) || constrained(p);
}

/** True when a param is a finitely-bounded slider variable (sweepable). The ONE
 *  definition of a free, finitely-bounded variable — the sweep UIs and the sensitivity
 *  step-scaler both read it, so they can never disagree about what "bounded" means. A param
 *  under `solveFor` or `designConstraint` is solved by the engine, not set by anyone — and a
 *  constrained param's min/max are its bisection bracket, not slider bounds — so both are
 *  excluded. */
export function sweepable(
  v: { min?: number; max?: number; solveFor?: string; designConstraint?: unknown } | undefined,
): v is { min: number; max: number } {
  return (
    !!v &&
    !v.solveFor &&
    !v.designConstraint &&
    v.min !== undefined &&
    v.max !== undefined &&
    Number.isFinite(v.min) &&
    Number.isFinite(v.max) &&
    v.max > v.min
  );
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
    message: `block "${blockName}": ${w.message}`,
    location: `${blockName}.${w.location ?? ''}`,
  };
}

/**
 * One end of the sheet's claimed operating range: one more full evaluation of THIS doc with the
 * named params' values overridden — each `set` expression evaluated against the base result —
 * whose outcome is reported as compliance, beside feasibility and never folded into it (see
 * RangeEndReport.state). The canonical use is the claimed common-mode range:
 * `{name: "cm-lo", set: {CM_dc: "CM_lo"}}` asks whether the design the base run produced still
 * holds at the low end, EXACTLY (its own constraint solve from the full authored bracket, its own
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
 *  (`cm-lo@tail-saturated`). */
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
}

/**
 * The exact key set of every authored container, stated beside the interfaces they mirror so a
 * document sanitizer can walk a parsed object against the REAL shape. GIVENS_KEYS/GIVENS_FLAGS above
 * exist for the same reason and stay separate only because the givens' keys additionally split by
 * type (expression vs flag). A sanitizer keeping its own copy of this knowledge is the mechanism
 * that silently ate a legal fT given on reload — and would have eaten `designConstraint` and
 * `diode` — so any new field belongs HERE, in the same edit that adds it to its interface.
 */
export const VAR_KEYS: ReadonlySet<string> = new Set<string>([
  'name', 'value', 'min', 'max', 'unit', 'role', 'note', 'solveFor', 'designConstraint', 'hold', 'class',
]); // prettier-ignore
export const EQUATION_KEYS: ReadonlySet<string> = new Set<string>(['name', 'expr', 'unit', 'note']);
export const CHECK_KEYS: ReadonlySet<string> = new Set<string>([
  'id', 'kind', 'lhs', 'op', 'rhs', 'tolPct', 'justification', 'note',
]); // prettier-ignore
export const BLOCK_KEYS: ReadonlySet<string> = new Set<string>([
  'name', 'doc', 'ref', 'device', 'params', 'wiring',
]); // prettier-ignore
export const RANGE_END_KEYS: ReadonlySet<string> = new Set<string>(['name', 'set', 'note']);
export const DOC_KEYS: ReadonlySet<string> = new Set<string>([
  'title', 'description', 'polarity', 'params', 'givens', 'equations', 'checks', 'blocks',
  'provides', 'operatingRange',
]); // prettier-ignore

/**
 * Every authored expression in a doc, in one flat list: the givens, constrained and solved params,
 * the equations, both sides of every check, each block's param overrides and wiring declaration,
 * and each range end's setting. Lives HERE for the same reason the key sets above do: a consumer
 * keeping its own copy of which fields hold expressions goes silently stale the day a field
 * is added — so a new expression-bearing field joins this walk in the same edit that adds it
 * to its interface.
 */
export function docExpressions(doc: SheetDoc): string[] {
  const out: string[] = [];
  if (doc.givens) {
    for (const [k, v] of Object.entries(doc.givens)) {
      if (!GIVENS_FLAGS.has(k) && typeof v === 'string') out.push(v);
    }
  }
  for (const p of doc.params) {
    if (constrained(p)) out.push(p.designConstraint.lhs, p.designConstraint.rhs);
    if (torn(p)) out.push(p.solveFor);
    if (holds(p)) out.push(p.hold);
  }
  for (const r of doc.equations) out.push(r.expr);
  for (const r of doc.checks) out.push(r.lhs, r.rhs);
  for (const u of doc.blocks ?? []) {
    out.push(...Object.values(u.params ?? {}));
    if (u.wiring) out.push(u.wiring.gate, u.wiring.source);
  }
  for (const e of doc.operatingRange ?? []) out.push(...Object.values(e.set));
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
}

/**
 * One range end's evaluated outcome: the numeric overrides the range end resolved to
 * (`set` — WHICH point was checked; the authored side may be an expression), its own check
 * results (and children, so a failure below the top doc keeps its path), the engine-solved
 * params where the range end landed (e.g. V_tail at CM_lo — empty when the run did not stand,
 * so a bracket end is never reported as a landing), the run's own warnings VERBATIM (a
 * bias clamp fires exactly at a claim's extreme, and a green chip must not rest on
 * silently clamped data), and — when the run could not be evaluated at all — the solver's
 * message in `error`, so a budget starvation stays tellable from "the bracket cannot
 * reach it". Check-level failures live in `checks`, never in `error`.
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
  /** Bias axes this block must declare: the table has them live and there is no safe
   *  default (i.e. `vds`, which varies per device — `vsb` defaults to 0, body-grounded).
   *  Present only on a failed sizing, so the UI can offer an in-place operating-point fix. */
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
   * cascode's gate, the gate bias the design needs. Read from the finished run, after every
   * override and solve. A fixed-hardware run holds each expression at this value. Absent when the
   * sheet holds nothing; a child's own are on its report.
   */
  held?: Record<string, number>;
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
export function clampedIn(
  res: { sizing?: SizingReport; blocks?: readonly SheetBlockReport[] },
  path = '',
): string[] {
  const out = (res.sizing?.clamped ?? []).map((axis) => `${path || 'givens'} ${axis}`);
  for (const c of res.blocks ?? [])
    out.push(...clampedIn(c, path ? `${path}${PATH_SEP}${c.name}` : c.name));
  return out;
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
 *  range end names for the range-end runs (`cm-lo@tail-saturated`). The ONE walk every consumer
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
