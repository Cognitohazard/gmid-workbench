// A leaf design-sheet: a single self-contained block evaluated against ONE device's
// lookup tables + PDK constants. Flat and declarative — named scalar params, an
// optional bind-any-2 device, named author-expression rows, and named comparison
// rules. NO circuit-domain nouns (no nodes/ports/KCL): a leaf has one block and no
// shared node, so the coupling channels that would court a nodal solver are absent by
// construction. Pure data; zero DOM imports.

import type { QAWarning } from '../types';
import { BASE_QUANTITIES } from '../namespace';
import { BINDABLE } from '../device';

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
}

/**
 * One named author expression (an intermediate `let` or an output), evaluated in
 * document order against earlier values + the sized device's quantities + constants.
 * Mirrors a DerivedQuantity {key, expr, unit} — one definition, no hand-rolled formula.
 */
export interface SheetRow {
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
 * mid-supply value, so an undeclared bias silently overstates gain). An axis left
 * undeclared falls back to the caller's bias (with an advisory warning) or errors.
 */
export interface SheetBind {
  L: string;
  gm?: string;
  gm_id?: string;
  id?: string;
  /** Width-first sizing (unit devices, mirror ratios, layout-constrained flows):
   *  W may stand in as one of the two bound quantities. */
  W?: string;
  /** Spec-first sizing: these pin the operating point exactly as gm_id does (each is
   *  width-invariant), so an author can bind the requirement they actually have — a
   *  transit frequency or an intrinsic gain — instead of solving for the gm/ID that
   *  meets it. Exactly one operating-point quantity may be bound. */
  ft?: string;
  gm_gds?: string;
  av0?: string;
  vstar?: string;
  vds?: string;
  vsb?: string;
}

/** The bias axes a bind may declare — every namespace sweep axis except the inversion
 *  sweep (vgs) and the geometry axis (l). Derived from the axis flags so a table axis
 *  added to the namespace is automatically collapsible by a bind/fallback, rather than
 *  dying on the sizer's extra-axis error because a hand-copied list went stale. */
export const BIAS_AXES: readonly string[] = BASE_QUANTITIES.filter(
  (q) => q.axis && q.key !== 'vgs' && q.key !== 'l',
).map((q) => q.key);

/** Every key a `bind` may carry besides `L` — the bindable quantities plus the bias axes it
 *  may pin. Stated once beside the interface it describes, so a document sanitizer can check
 *  a parsed bind against the real shape instead of a copy that goes stale when BINDABLE
 *  grows (which is exactly how a legal fT bind once got deleted on every reload). */
export const BIND_KEYS: ReadonlySet<string> = new Set<string>([...BINDABLE, ...BIAS_AXES]);

// invariant = a hard physical floor (must hold or the design is unphysical); requirement = a
// hard application spec (must hold or the design misses its purpose) — both gate feasibility.
// guardrail = a soft advisory (a near-miss heads-up) that is shown but never blocks feasibility.
export type RuleKind = 'invariant' | 'guardrail' | 'requirement';

/** True for the kinds that GATE feasibility. The one home for "hardness" — the leaf
 *  verdict, the sweep rule collection, and binding-rule attribution all consult this
 *  whitelist, so a future advisory kind cannot be silently promoted to hard by a
 *  `!== 'guardrail'` blacklist somewhere. */
export const isHardRule = (kind: RuleKind): boolean =>
  kind === 'invariant' || kind === 'requirement';
export type RuleOp = '>=' | '<=' | '==';

/** Runtime membership sets mirroring the RuleKind/RuleOp unions — one place to coerce untrusted
 *  input (saved layouts, raw core callers). Typed ReadonlySet<string> so `.has(rawString)` works. */
export const RULE_KINDS: ReadonlySet<string> = new Set<RuleKind>([
  'invariant',
  'guardrail',
  'requirement',
]);
export const RULE_OPS: ReadonlySet<string> = new Set<RuleOp>(['>=', '<=', '==']);

/**
 * A named comparison the design must satisfy. `lhs`/`rhs` are expression strings
 * (structured — the comparison itself is never parsed out of a string). `tolPct`
 * applies only to '=='; `justification` is an advisory note for a relaxed guardrail.
 */
export interface SheetRule {
  id: string;
  kind: RuleKind;
  lhs: string;
  op: RuleOp;
  rhs: string;
  tolPct?: number;
  justification?: string;
  /** One-line physical meaning of the rule, for the designer inheriting the sheet. */
  note?: string;
}

/**
 * A child block this sheet composes. The child is either a full SheetDoc embedded
 * inline (`doc`) or a reference to a library sheet (`ref` — a `folder/name` id, or the
 * bare name while it is unique; see resolve.ts). A ref is materialized into `doc` by
 * `resolveSheetRefs` BEFORE validation/evaluation, so those layers see an embedded
 * tree; a use that reaches evaluation docless fails closed. A use carrying both is an
 * already-resolved snapshot (`ref` is provenance; `doc` is authoritative). `params`
 * overrides the child's param VALUES with expressions evaluated in the PARENT's scope,
 * so a parent budget flows down (e.g. a shared length or current) — this is also the
 * customization channel for a ref'd child, whose internals belong to the library
 * sheet. Children evaluate in DOCUMENT ORDER, and each override resolves against the
 * parent scope as built so far: parent params, constants, and the provides of EARLIER
 * siblings — so a later block can carry a value an earlier block derived (a cascode
 * branch taking the input pair's bound current). A forward reference (or a reference
 * to the parent's own sized device, which binds AFTER the children) fails closed as
 * undeclared. `device` names the device table the child sizes against (by id); absent
 * ⇒ the child inherits the parent's table.
 *
 * The child exposes its `provide`d names to the parent as flat scalars `name__key`
 * (the engine has no member access, so the join is a `__` separator — neither the use
 * `name` nor a provided key may contain `__`). This is scalar composition only: the
 * parent references child outputs and writes its own author math over them. There is
 * NO node/port/KCL machinery — those remain the deferred coupling channels.
 */
export interface SheetUse {
  name: string;
  doc?: SheetDoc;
  ref?: string;
  device?: string;
  params?: Record<string, string>;
}

/** Maximum composition nesting depth — a backstop against a pathologically deep
 *  authored tree (embedded docs form a finite tree, so this is a sanity cap, not a
 *  cycle guard). Shared by the evaluator and the validator. */
export const MAX_USE_DEPTH = 8;

/** The separator joining a child use-name to a provided key. The engine has no member
 *  access (`child.key` cannot parse), so a child's scalars surface in the parent scope as
 *  the flat name `child__key`. One source of truth for the producer (eval), the collision
 *  check (validate), and the UI display; neither a use-name nor a provided key may contain it. */
export const PROVIDE_SEP = '__';
export const joinProvide = (useName: string, key: string): string =>
  `${useName}${PROVIDE_SEP}${key}`;

/** Re-attribute a composed child's warning to its use site, so a rolled-up warning points at
 *  the offending block (and a child error still blocks the parent's closed feasibility). */
export function prefixUseWarning(useName: string, w: QAWarning): QAWarning {
  return {
    ...w,
    message: `use "${useName}": ${w.message}`,
    location: `${useName}.${w.location ?? ''}`,
  };
}

/** A sheet document — the authored model the GUI edits and persists verbatim. A leaf
 *  has no `uses`; a composed sheet embeds child blocks and references their `provide`d
 *  scalars. `provide` lists the names THIS sheet exposes to a parent (ignored at the top). */
export interface SheetDoc {
  title: string;
  /** A few sentences on what the sheet designs, its assumptions, and how to use it —
   *  the block comment a designer inheriting the sheet reads first. */
  description?: string;
  polarity: 'n' | 'p'; // a self-description label only; no contract enforced at leaf
  params: SheetVar[];
  bind?: SheetBind;
  rows: SheetRow[];
  rules: SheetRule[];
  uses?: SheetUse[];
  provide?: string[];
}

/** A child block's evaluated summary, surfaced so the UI can show each child's title,
 *  feasibility, and the scalar values it exposed — without re-evaluating the tree.
 *  `rules` (and nested `children`) carry the child's own rule outcomes so a composed
 *  report or sweep can show WHICH constraint below the top sheet binds — otherwise a
 *  feasibility flip caused by a child rule has no visible cause at the top. */
export interface SheetChildReport {
  name: string;
  title: string;
  feasible: boolean;
  /** The child's own sized operating point (W, VGS, ID, bias) or its bind error — so a
   *  composed view can show each block's sizing, not just the scalars it exposes upward.
   *  Absent for a child that has no bind or died before sizing. */
  bind?: BindReport;
  provides: Record<string, number>;
  rules: RuleResult[];
  children?: SheetChildReport[];
}

export type RuleStatus = 'pass' | 'amber' | 'fail' | 'na';

/**
 * The evaluated outcome of one rule: the two sides, a signed margin (SI distance to
 * the bound; >= 0 passes), its relative size, and a four-state status. `na` means a
 * side could not be computed (undeclared name, eval error, or a non-finite value) —
 * never a silent pass.
 */
export interface RuleResult {
  id: string;
  kind: RuleKind;
  text: string; // human-readable "lhs op rhs"
  lhsValue: number;
  rhsValue: number;
  margin: number;
  marginPct: number;
  status: RuleStatus;
  detail?: string;
}

/**
 * The headline of the sized operating point for display, or an error when the bind
 * could not be solved (out-of-range gm/ID, missing characterization width, no device).
 * The full operating point (gm, gm/ID, ceiling, feasible, vstar, …) reaches rows and
 * rules through the merged `values` map, so it is not duplicated here.
 */
export interface BindReport {
  ok: boolean;
  W: number;
  vgs: number;
  id: number;
  /** The operating-point coordinates the table was sliced at before sizing (per bias
   *  axis, signed) — declared in the bind, or defaulted for body bias. Absent when the
   *  table needed no reduction. Makes the sizing bias visible in reports. */
  bias?: Record<string, number>;
  /** Bias axes this block must declare: the table has them live and there is no safe
   *  default (i.e. `vds`, which varies per device — `vsb` defaults to 0, body-grounded).
   *  Present only on a failed bind, so the UI can offer an in-place operating-point fix. */
  needs?: string[];
  error?: string;
}

/**
 * The full evaluation of a sheet: every resolved scalar, the bind report, the rule
 * outcomes, an overall feasibility, and any validation/eval warnings.
 *
 * `feasible` is fail-closed: true only when a declared bind sized successfully, every
 * invariant AND requirement rule holds (pass or near-miss), and no error-severity warning
 * was raised (including validation errors, via runSheet). Guardrails do not affect it.
 */
export interface SheetResult {
  values: Record<string, number>;
  bind?: BindReport;
  rules: RuleResult[];
  feasible: boolean;
  warnings: QAWarning[];
  /** Present (possibly empty) only when the sheet composes children; absent for a leaf. */
  children?: SheetChildReport[];
}

/**
 * One rule's relative margin traced across a parameter sweep, parallel to the sweep's `x`.
 * `null` where the rule was `na` (a side could not be computed at that point). The relative
 * (dimensionless) margin — not the raw SI margin — is what lets rules of different units share
 * one axis. In a composed sweep, descendant blocks' HARD rules ride along with path-prefixed
 * ids (`cs.headroom`) so the constraint that binds is on the chart wherever it lives.
 */
export interface SheetSweepRule {
  id: string;
  kind: RuleKind;
  marginPct: (number | null)[];
}

/**
 * A leaf sheet evaluated across a grid of one parameter's [min,max] range: the X samples, each
 * rule's relative-margin curve, and the overall feasibility at each point. The classic gm/ID
 * feasibility-region view — wherever every hard rule's curve sits at or above zero, the design
 * closes. Empty (`x: []`) when the named parameter is not a finitely-bounded slider variable.
 */
export interface SheetSweep {
  param: string;
  unit: string;
  x: number[];
  rules: SheetSweepRule[];
  feasible: boolean[];
}

/**
 * A sheet evaluated across the 2-D grid of two parameters' [min,max] ranges — the design-plane
 * view (gm_id × L is the classic) a 1-D cut cannot answer, e.g. "the minimum L that stays
 * feasible across the whole gm_id range". `feasible[yi][xi]` maps the region; `binding[yi][xi]`
 * names the WORST failing hard rule at each infeasible cell (tree-path id, so a child block's
 * constraint is named as `cs.headroom`), or null where feasible / failed without a failing rule
 * (e.g. a bind error). Empty (`x: []`) unless both params are distinct, finitely-bounded
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
