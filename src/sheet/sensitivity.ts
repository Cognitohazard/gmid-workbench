// The other half of a margin. A margin says how much room a constraint has left; it does not
// say which knob to turn, or how far — so an infeasible sheet reports a number and no direction,
// and the designer goes back to moving sliders one at a time. This module differences the
// evaluator against itself: perturb one design parameter, re-evaluate the WHOLE sheet through
// the public entrypoint (children and solves included — a sensitivity must see what the verdict
// sees; containment edges only when the rule in question lives on one, see
// SensitivityOptions.rule), and report how far each rule's margin moved. No new numerics, no
// analytic model of the sheet: the derivative is finite differences over the same evaluation
// the badge shows. Pure, deterministic, never throws.

import type { DeviceTable } from '../types';
import {
  choiceKnobs,
  EDGE_SEP,
  engineSolved,
  sweepable,
  treeRuleResults,
  withParams,
} from './types';
import type {
  RuleResult,
  SheetDoc,
  SheetResult,
  SheetSensitivity,
  SheetSensitivityRule,
  SheetVar,
} from './types';
import { evaluateSheet, type DeviceResolver } from './eval';
import { validateSheet } from './validate';
import { resolvedSheet, type SheetRefIndex } from './resolve';

/**
 * Default perturbation, as a FRACTION of the knob's own value. A fraction rather than an
 * absolute step because the core is SI throughout — a knob is as likely to be a capacitance
 * (~1e-15 F) as a gm/ID (~15) — so only a relative move means the same thing to both. 1% is
 * small enough that a smooth margin is locally linear over it, and large enough to sit well
 * above the ~0.1% the sizer resolves an operating point to between grid nodes, below which a
 * difference would measure interpolation noise instead of the design.
 */
export const SENSITIVITY_REL_STEP = 1e-2;

/**
 * `refs` materializes by-reference children exactly as runSheet does, so the perturbed runs see
 * the same tree the badge does. `params` names the knobs to probe (default: every 'choice'
 * param — the author's implementation knobs, which is what "what should I turn" means).
 * `absStep` supplies a step for a knob sitting at 0 with no bounded range: the engine refuses to
 * invent one, because the invented scale would set the answer.
 *
 * `rule` names the outcome the caller actually wants ranked, and it is a COST declaration as
 * much as a filter: containment edges are re-run per probe only when the named rule lives on one
 * (an edge-keyed id, `cm-lo@tail-saturated`). Without it every probe re-proves every range end —
 * 2*(1 + edges) full evaluations per knob, dozens per click on a sheet with several claims — to
 * produce numbers about a rule at the top. The edge-free runs then carry no edge-keyed rules at
 * all, in the base as well as the probes, so nothing reads as an unmeasured NaN that was in fact
 * never asked for.
 */
export interface SensitivityOptions {
  refs?: SheetRefIndex;
  params?: readonly string[];
  absStep?: number;
  rule?: string;
}

/** One knob to probe, or the reason it cannot be one. */
interface Selected {
  name: string;
  param?: SheetVar;
  error?: string;
}

/**
 * Which knobs to probe. The default set is the author's 'choice' params — the implementation
 * knobs a designer re-balances, as opposed to 'spec' params, which state the requirement and
 * are not free to move. Engine-solved params are excluded from BOTH the default set and an
 * explicit request: a torn or pinned param's authored value is a starting guess the solver
 * discards, so perturbing it measures the solver's tolerance, not the design.
 */
function select(doc: SheetDoc, names?: readonly string[]): Selected[] {
  if (!names) return choiceKnobs(doc).map((p) => ({ name: p.name, param: p }));
  return names.map((name) => {
    const p = doc.params.find((q) => q.name === name);
    if (!p) return { name, error: `"${name}" is not a param of this sheet` };
    if (engineSolved(p))
      return {
        name,
        error:
          `the engine solves "${name}", so its authored value is only a starting guess — ` +
          `perturbing it measures the solver, not the design`,
      };
    return { name, param: p };
  });
}

/**
 * Whether an evaluation produced numbers worth differencing. A hard rule FAILING is a perfectly
 * good point — the signed margin is exactly the signal being differentiated, and refusing the
 * infeasible side would blind the readout precisely where a designer needs it. What does not
 * stand is an evaluation that could not be completed: an error-severity diagnostic (which a
 * bind that did not size already raises), or a containment edge that never ran — an edge's
 * failure is reported in its own `error` and never merged upward, so it needs its own clause.
 */
function stands(res: SheetResult): boolean {
  return (
    !res.warnings.some((w) => w.severity === 'error') &&
    !(res.edges ?? []).some((e) => e.error !== undefined)
  );
}

/** The same doc with its containment edges dropped — see SensitivityOptions.rule for why a
 *  probe skips them. Structural, so `evaluateSheet` simply never enters the edge path. */
function withoutEdges(doc: SheetDoc): SheetDoc {
  const { edges: _edges, ...rest } = doc;
  return rest;
}

/** The authored slider span, or undefined when the param is not finitely bounded —
 *  `sweepable` is the one definition of "finitely bounded", shared with the sweep UIs. */
function spanOf(p: SheetVar): number | undefined {
  return sweepable(p) ? p.max - p.min : undefined;
}

/** The step for one knob, or a string saying why there is none. A zero value has no fraction to
 *  take, so its authored range stands in; with neither, the caller must say what a small move
 *  means here, because a step the engine invented would set the scale of every answer. */
function stepFor(p: SheetVar, absStep?: number): number | string {
  const from = p.value !== 0 ? Math.abs(p.value) : spanOf(p);
  if (from !== undefined) {
    const h = SENSITIVITY_REL_STEP * from;
    if (Number.isFinite(h) && h > 0) return h;
  }
  if (absStep !== undefined && Number.isFinite(absStep) && absStep > 0) return absStep;
  return (
    `"${p.name}" is 0 with no finite [min, max] to scale a step from — pass an absolute step ` +
    `(opts.absStep) to say what a small move means for this knob`
  );
}

/**
 * How each rule's margin responds to each design knob, one entry per knob. Costs 2 full
 * evaluations per knob on top of the base one (more only when `opts.rule` asks for an edge-keyed
 * rule, which puts every containment edge back in each of them), so it is an on-demand readout,
 * never part of a reactive evaluation.
 *
 * Refs are materialized and the doc validated ONCE — the tree is constant across the probes,
 * only a value moves — and the probes then go through `evaluateSheet`, the same entrypoint the
 * verdict uses. Differences are taken on RAW margins (see RuleResult.rawMargin): the snapped
 * margin reads exactly 0 for a rule parked on its own boundary, which would report zero slope
 * for a rule that is in fact moving. Relative margins are deliberately NOT differentiated —
 * their denominator is a bound that may be ~0, and the resulting ratio carries the denominator's
 * noise rather than the design's response.
 *
 * A central difference is used only where both probes stay strictly inside the authored
 * [min, max]; at a bound the readout switches to a second-order one-sided difference on the side
 * that fits, so a knob already at its limit still reports which way it would move things rather
 * than silently reporting nothing. Rules are keyed exactly as `bindingConstraint` names them, so
 * a caller can hand this the id it already has.
 */
export function sheetSensitivities(
  doc: SheetDoc,
  table?: DeviceTable,
  resolveDevice?: DeviceResolver,
  opts: SensitivityOptions = {},
): SheetSensitivity[] {
  const r = resolvedSheet(doc, opts.refs);
  const picked = select(r.doc, opts.params);
  /** An entry with no numbers and the reason there are none — the ONE shape every unprobeable
   *  knob takes, whether the sheet, the knob, or one probe is what could not be done. */
  const none = (param: string, value: number, error: string): SheetSensitivity => ({
    param,
    value,
    step: NaN,
    rules: [],
    error,
  });
  /** Every entry unavailable for one shared reason (a per-knob reason still wins). */
  const dead = (why: string): SheetSensitivity[] =>
    picked.map((s) => none(s.name, s.param?.value ?? NaN, s.error ?? why));

  if (
    r.warnings.some((w) => w.severity === 'error') ||
    validateSheet(r.doc).some((w) => w.severity === 'error')
  ) {
    return dead(
      'the sheet does not validate — a derivative around a structurally broken design would ' +
        'describe nothing',
    );
  }

  // Only a rule that lives ON an edge is worth re-proving every range end for; see
  // SensitivityOptions.rule.
  const probeDoc = opts.rule?.includes(EDGE_SEP) ? r.doc : withoutEdges(r.doc);
  const at = (over: Record<string, number>): SheetResult =>
    evaluateSheet(withParams(probeDoc, over), table, resolveDevice);

  const base = at({});
  if (!stands(base)) {
    return dead(
      'the sheet does not evaluate at its own values, so there is no point to differentiate ' +
        'around — fix the evaluation first',
    );
  }
  const baseRules = treeRuleResults(base);

  return picked.map((s) => {
    const p = s.param;
    if (!p) return none(s.name, NaN, s.error ?? 'this knob cannot be probed');

    const h = stepFor(p, opts.absStep);
    if (typeof h === 'string') return none(p.name, p.value, h);

    // A bound is a bound: stepping past it probes a design the author declared out of range. The
    // probe offsets are SIGNED, so leaning up and leaning down are the same code with the same
    // formulas — the first offset is always the one-step probe, whichever way it points.
    const lo = Number.isFinite(p.min) ? (p.min as number) : -Infinity;
    const hi = Number.isFinite(p.max) ? (p.max as number) : Infinity;
    let offsets: [number, number];
    if (p.value - h >= lo && p.value + h <= hi)
      offsets = [h, -h]; // central
    else if (p.value + 2 * h <= hi)
      offsets = [h, 2 * h]; // one-sided, upward
    else if (p.value - 2 * h >= lo)
      offsets = [-h, -2 * h]; // one-sided, downward
    else {
      return none(
        p.name,
        p.value,
        `a ${h} step does not fit inside [${p.min}, ${p.max}] — the range is too narrow to ` +
          `difference across at this step`,
      );
    }

    const errors: string[] = [];
    const probes = offsets.map((dx) => {
      const res = at({ [p.name]: p.value + dx });
      if (stands(res)) return treeRuleResults(res);
      errors.push(`the evaluation at ${p.name} = ${p.value + dx} did not stand`);
      return undefined;
    });
    /** The raw margin of `id` at probe `i`, or NaN where that probe or that rule is absent. */
    const raw = (i: number, id: string): number => probes[i]?.get(id)?.rawMargin ?? NaN;

    const rules: SheetSensitivityRule[] = [];
    for (const [id, rr] of baseRules) rules.push(record(id, rr, offsets, raw));
    return {
      param: p.name,
      value: p.value,
      step: h,
      rules,
      ...(errors.length ? { error: errors.join('; ') } : {}),
    };
  });
}

/** One rule's record from the base outcome and the two probes, at the signed offsets they were
 *  taken at: `step` is the one-step probe (positive leaning up, negative leaning down) and the
 *  scheme is central exactly when the second probe mirrors it. An EQUALITY rule's margin is
 *  `tol - |lhs - rhs|`, which has a cusp exactly where the rule is satisfied: a difference
 *  taken across it averages two different one-sided slopes into a number that describes
 *  neither, so no slope is reported and the two one-sided deltas stand alone. */
function record(
  id: string,
  rr: RuleResult,
  [step, far]: [number, number],
  raw: (i: number, id: string) => number,
): SheetSensitivityRule {
  const central = far === -step;
  const m0 = rr.rawMargin;
  const m1 = raw(0, id);
  const m2 = raw(1, id);
  const slope =
    rr.op === '==' ? NaN : central ? (m1 - m2) / (2 * step) : (-3 * m0 + 4 * m1 - m2) / (2 * step);
  const near = m1 - m0;
  return {
    id,
    kind: rr.kind,
    baseStatus: rr.status,
    baseMargin: m0,
    dMarginPerUnit: slope,
    deltaPlus: step > 0 ? near : NaN,
    deltaMinus: step < 0 ? near : central ? m2 - m0 : NaN,
  };
}
