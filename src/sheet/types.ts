// A leaf design-sheet: a single self-contained block evaluated against ONE device's
// lookup tables + PDK constants. Flat and declarative — named scalar params, an
// optional bind-any-2 device, named author-expression rows, and named comparison
// rules. NO circuit-domain nouns (no nodes/ports/KCL): a leaf has one block and no
// shared node, so the coupling channels that would court a nodal solver are absent by
// construction. Pure data; zero DOM imports.

import type { QAWarning } from '../types';

/** A named scalar design input. `min`/`max` bound the GUI slider only. */
export interface SheetVar {
  name: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
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
}

/**
 * A bind-any-2 device declaration: EXACTLY two of {gm, gm_id, id} (each an expression
 * string, so e.g. gm = "2*pi*GBW*CL" works), plus the length L. Drives sizeDevice
 * against the panel's active device.
 */
export interface SheetBind {
  L: string;
  gm?: string;
  gm_id?: string;
  id?: string;
}

// invariant = a hard physical floor (must hold or the design is unphysical); requirement = a
// hard application spec (must hold or the design misses its purpose) — both gate feasibility.
// guardrail = a soft advisory (a near-miss heads-up) that is shown but never blocks feasibility.
export type RuleKind = 'invariant' | 'guardrail' | 'requirement';
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
}

/**
 * A child block this sheet composes. The child is a full SheetDoc embedded inline
 * (self-contained — the whole tree persists as one document). `params` overrides the
 * child's param VALUES with expressions evaluated in the PARENT's param scope, so a
 * parent budget flows down (e.g. a shared length or current). `device` names the
 * device table the child sizes against (by id); absent ⇒ the child inherits the
 * parent's table.
 *
 * The child exposes its `provide`d names to the parent as flat scalars `name__key`
 * (the engine has no member access, so the join is a `__` separator — neither the use
 * `name` nor a provided key may contain `__`). This is scalar composition only: the
 * parent references child outputs and writes its own author math over them. There is
 * NO node/port/KCL machinery — those remain the deferred coupling channels.
 */
export interface SheetUse {
  name: string;
  doc: SheetDoc;
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
  polarity: 'n' | 'p'; // a self-description label only; no contract enforced at leaf
  params: SheetVar[];
  bind?: SheetBind;
  rows: SheetRow[];
  rules: SheetRule[];
  uses?: SheetUse[];
  provide?: string[];
}

/** A child block's evaluated summary, surfaced so the UI can show each child's title,
 *  feasibility, and the scalar values it exposed — without re-evaluating the tree. */
export interface SheetChildReport {
  name: string;
  title: string;
  feasible: boolean;
  provides: Record<string, number>;
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
 * one axis.
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
