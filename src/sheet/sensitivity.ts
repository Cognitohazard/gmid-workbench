// The other half of a margin. A margin says how much room a constraint has left; it does not
// say which knob to turn, or how far — so an infeasible sheet reports a number and no direction,
// and the designer goes back to moving sliders one at a time. This module differences the
// evaluator against itself: perturb one design parameter, re-evaluate the WHOLE sheet through
// the public entrypoint (children and solves included — a sensitivity must see what the verdict
// sees; range ends only when the check in question lives on one, see
// SensitivityOptions.check), and report how far each check's margin moved. No new numerics, no
// analytic model of the sheet: the derivative is finite differences over the same evaluation
// the badge shows. Pure, deterministic, never throws.

import type { DeviceTable } from '../types';
import {
  choiceKnobs,
  RANGE_END_SEP,
  rangeEndBroke,
  engineSolved,
  stands,
  sweepable,
  treeCheckResults,
  withoutRange,
  withParams,
} from './types';
import type {
  CheckResult,
  SheetDoc,
  SheetResult,
  SheetSensitivity,
  SheetSensitivityCheck,
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
 * `check` names the outcome the caller actually wants ranked, and it is a COST declaration as
 * much as a filter: range ends are re-run per probe only when the named check lives on one
 * (a range-end-keyed id, `cm-lo@sr-spec`). Without it every probe re-checks compliance at
 * every range end — 2*(1 + range ends) full evaluations per knob, dozens per click on a sheet with
 * several claims — to produce numbers about a check at the top. The range-free runs then carry no
 * range-end-keyed checks at all, in the base as well as the probes, so nothing reads as an
 * unmeasured NaN that was in fact never asked for.
 */
export interface SensitivityOptions {
  refs?: SheetRefIndex;
  params?: readonly string[];
  absStep?: number;
  check?: string;
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
 * explicit request: a solved param's authored value is never read — the engine searches its
 * range — so perturbing it measures nothing about the design.
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
          `the engine solves "${name}" by searching its range, so its authored value is never ` +
          `read — perturbing it measures nothing about the design`,
      };
    return { name, param: p };
  });
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
 * How each check's margin responds to each design knob, one entry per knob. Costs 2 full
 * evaluations per knob on top of the base one (more only when `opts.check` asks for a
 * range-end-keyed check, which puts every range end back in each of them), so it is an on-demand
 * readout, never part of a reactive evaluation.
 *
 * Refs are materialized and the doc validated ONCE — the tree is constant across the probes,
 * only a value moves — and the probes then go through `evaluateSheet`, the same entrypoint the
 * verdict uses. Differences are taken on RAW margins (see CheckResult.rawMargin): the snapped
 * margin reads exactly 0 for a check parked on its own boundary, which would report zero slope
 * for a check that is in fact moving. Relative margins are deliberately NOT differentiated —
 * their denominator is a bound that may be ~0, and the resulting ratio carries the denominator's
 * noise rather than the design's response.
 *
 * A central difference is used only where both probes stay strictly inside the authored
 * [min, max]; at a bound the readout switches to a second-order one-sided difference on the side
 * that fits, so a knob already at its limit still reports which way it would move things rather
 * than silently reporting nothing. Checks are keyed exactly as `bindingCheck` names them, so
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
    checks: [],
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

  // Only a check that lives ON a range end is worth re-checking compliance at every range end for;
  // see SensitivityOptions.check.
  const probeDoc = opts.check?.includes(RANGE_END_SEP) ? r.doc : withoutRange(r.doc);
  const at = (over: Record<string, number>): SheetResult =>
    evaluateSheet(withParams(probeDoc, over), table, resolveDevice);

  // A probe has to have completed wherever it is read. The probe doc carries range ends only
  // when the check in question lives on one, and then THAT end leaving no outcomes is a probe
  // with nothing to difference, exactly like a base run that did not stand. Another range end
  // having no answer is no obstacle: its checks are simply not among the ones read.
  const end = opts.check?.includes(RANGE_END_SEP)
    ? opts.check.slice(0, opts.check.indexOf(RANGE_END_SEP))
    : undefined;
  const endBroke = (res: SheetResult): boolean =>
    (res.rangeEnds ?? []).some((e) => e.name === end && rangeEndBroke(e));
  const whole = (res: SheetResult): boolean => stands(res) && !endBroke(res);
  const base = at({});
  if (!stands(base)) {
    return dead(
      'the sheet does not evaluate at its own values, so there is no point to differentiate ' +
        'around — fix the evaluation first',
    );
  }
  if (endBroke(base)) {
    return dead(
      `the range end "${end}" has no check outcomes at these values, so there is nothing there ` +
        `to differentiate`,
    );
  }
  const baseChecks = treeCheckResults(base);

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
      if (whole(res)) return treeCheckResults(res);
      errors.push(`the evaluation at ${p.name} = ${p.value + dx} did not stand`);
      return undefined;
    });
    /** The raw margin of `id` at probe `i`, or NaN where that probe or that check is absent. */
    const raw = (i: number, id: string): number => probes[i]?.get(id)?.rawMargin ?? NaN;

    const checks: SheetSensitivityCheck[] = [];
    for (const [id, rr] of baseChecks) checks.push(record(id, rr, offsets, raw));
    return {
      param: p.name,
      value: p.value,
      step: h,
      checks,
      ...(errors.length ? { error: errors.join('; ') } : {}),
    };
  });
}

/** One check's record from the base outcome and the two probes, at the signed offsets they were
 *  taken at: `step` is the one-step probe (positive leaning up, negative leaning down) and the
 *  scheme is central exactly when the second probe mirrors it. An EQUALITY check's margin is
 *  `tol - |lhs - rhs|`, which has a cusp exactly where the check is satisfied: a difference
 *  taken across it averages two different one-sided slopes into a number that describes
 *  neither, so no slope is reported and the two one-sided deltas stand alone. */
function record(
  id: string,
  rr: CheckResult,
  [step, far]: [number, number],
  raw: (i: number, id: string) => number,
): SheetSensitivityCheck {
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
