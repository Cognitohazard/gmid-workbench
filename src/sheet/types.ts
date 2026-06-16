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
export const RULE_KINDS: ReadonlySet<string> = new Set<RuleKind>(['invariant', 'guardrail', 'requirement']);
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

/** A leaf sheet document — the authored model the GUI edits and persists verbatim. */
export interface SheetDoc {
  title: string;
  polarity: 'n' | 'p'; // a self-description label only; no contract enforced at leaf
  params: SheetVar[];
  bind?: SheetBind;
  rows: SheetRow[];
  rules: SheetRule[];
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
