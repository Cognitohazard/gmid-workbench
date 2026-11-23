// The other half of a margin. A margin says how much room a constraint has left; it does not
// say which knob to turn, or how far — so an infeasible sheet reports a number and no direction,
// and the designer goes back to moving sliders one at a time. This module differences the
// evaluator against itself: perturb one design parameter, re-evaluate the WHOLE sheet through
// the public entrypoint (children and solves included — a sensitivity must see what the verdict
// sees; range ends only when the check in question lives on one, see
// SensitivityOptions.check), and report how far each check's margin moved. No new numerics, no
// analytic model of the sheet: the derivative is finite differences over the same evaluation
// the badge shows. Pure, deterministic, never throws.

import type { DeviceTable, OutsideTable } from '../types';
import {
  choiceKnobs,
  outsideIn,
  RANGE_END_SEP,
  engineSolved,
  OWN_DEVICE,
  sweepable,
  treeCheckResults,
  withoutRange,
  rangePoints,
  withParams,
} from './types';
import type {
  CheckResult,
  SheetDoc,
  SheetResult,
  SheetSensitivity,
  SheetSensitivityCheck,
  SheetSensitivityResult,
  SheetVar,
} from './types';
import { evaluateSheet, type DeviceResolver } from './eval';
import type { Settings } from './settings';
import { validateSheet } from './validate';
import { resolvedSheet, type SheetRefIndex } from './resolve';
import { givesValue } from './items';
import { isComplete } from './states';
import { outsideMessage } from './describe';

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
  /** The tolerances and caps every probe is evaluated under (see Settings). */
  settings?: Settings;
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
    results: [],
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

  // Only a check that lives ON a point of the operating range is worth asking a point for, and then
  // only that point (found by its key among rangePoints): each probe is two evaluations, the design
  // point and that one point. See SensitivityOptions.check.
  const end = opts.check?.includes(RANGE_END_SEP)
    ? opts.check.slice(0, opts.check.indexOf(RANGE_END_SEP))
    : undefined;
  const onPoint = end !== undefined && rangePoints(r.doc).some((pt) => pt.name === end);
  const probeDoc = onPoint ? r.doc : withoutRange(r.doc);
  const at = (over: Record<string, number>): SheetResult =>
    evaluateSheet(withParams(probeDoc, over), table, resolveDevice, {
      settings: opts.settings,
      ...(onPoint ? { rangePoint: end } : {}),
    });

  // A probe has to have completed wherever it is read: the one point it asks leaving no outcomes
  // is a probe with nothing to difference, exactly like a base run that did not stand.
  const endBroke = (res: SheetResult): boolean =>
    (res.rangeEnds ?? []).some((e) => e.name === end && !isComplete(e));
  const whole = (res: SheetResult): boolean => isComplete(res) && !endBroke(res);
  const base = at({});
  const baseOutside = outsideIn(base);
  if (baseOutside.length) {
    return dead(
      `the sheet reads a device beyond its table at its own values (` +
        `${baseOutside.map(outsideMessage).join('; ')}), so there is no point to differentiate ` +
        `around`,
    );
  }
  if (!isComplete(base)) {
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
  const named = namedResults(r.doc, base);

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
    const beyond: OutsideTable[] = [];
    /** One probe: its outcomes where it completed, else why it is not used — a probe that read a
     *  device beyond its table is never used, since its numbers would come from another bias. */
    const probe = (
      dx: number,
    ): {
      checks?: Map<string, CheckResult>;
      values?: SheetResult['values'];
      given?: (name: string) => boolean;
      why?: string;
      beyond: boolean;
    } => {
      const res = at({ [p.name]: p.value + dx });
      const outside = outsideIn(res);
      beyond.push(...outside);
      if (outside.length)
        return {
          why:
            `the evaluation at ${p.name} = ${p.value + dx} reads a device beyond its table ` +
            `(${outside.map(outsideMessage).join('; ')}), so it is not used`,
          beyond: true,
        };
      if (whole(res))
        return {
          checks: treeCheckResults(res),
          values: res.values,
          given: (name) => givesValue(res, name),
          beyond: false,
        };
      return { why: `the evaluation at ${p.name} = ${p.value + dx} did not stand`, beyond: false };
    };
    let taken = offsets.map(probe);
    // A central difference whose one side reads beyond the table becomes a one-sided difference on
    // the other side, where that fits inside the range and both of its probes stay on the table.
    if (offsets[1] === -offsets[0]) {
      const lost = taken.findIndex((t) => t.beyond);
      const kept = 1 - lost;
      const other = offsets[kept];
      if (lost >= 0 && !taken[kept].beyond && taken[kept].checks) {
        const far = 2 * other;
        if (p.value + far >= lo && p.value + far <= hi) {
          const second = probe(far);
          if (second.checks) {
            errors.push(`${taken[lost].why} — differenced on the other side instead`);
            offsets = [other, far];
            taken = [taken[kept], second];
          }
        }
      }
    }
    for (const t of taken)
      if (t.why && !errors.some((e) => e.startsWith(t.why as string))) errors.push(t.why);
    const probes = taken.map((t) => t.checks);
    /** The raw margin of `id` at probe `i`, or NaN where that probe or that check is absent. */
    const raw = (i: number, id: string): number => probes[i]?.get(id)?.rawMargin ?? NaN;

    /** A check's left side at probe `i`, or NaN where that probe or that check is absent. */
    const lhs = (i: number, id: string): number => probes[i]?.get(id)?.lhsValue ?? NaN;

    const checks: SheetSensitivityCheck[] = [];
    for (const [id, rr] of baseChecks) {
      const c = record(id, rr, offsets, raw);
      // The left side's relative move, beside the margin's absolute one.
      const [slope] = differences(rr.lhsValue, lhs(0, id), lhs(1, id), offsets);
      const rel = relative(slope, rr.lhsValue, p.value, `the left side of ${id}`, p.name);
      checks.push(typeof rel === 'number' ? { ...c, relPerPct: rel } : { ...c, why: rel });
    }
    const results = named.map(({ name, unit }) => result(name, unit, base, taken, offsets, p));
    return {
      param: p.name,
      value: p.value,
      step: h,
      checks,
      results,
      ...(errors.length ? { error: errors.join('; ') } : {}),
      ...(beyond.length ? { outside: beyond } : {}),
    };
  });
}

/** The slope and the two one-step changes of a quantity from its base value `v0` and its values
 *  at the two probes, at the signed offsets they were taken at: a central difference when the
 *  second probe mirrors the first, else the second-order one-sided one. */
function differences(
  v0: number,
  v1: number,
  v2: number,
  [step, far]: [number, number],
): [slope: number, deltaPlus: number, deltaMinus: number] {
  const central = far === -step;
  const slope = central ? (v1 - v2) / (2 * step) : (-3 * v0 + 4 * v1 - v2) / (2 * step);
  const near = v1 - v0;
  return [slope, step > 0 ? near : NaN, step < 0 ? near : central ? v2 - v0 : NaN];
}

/** A slope of `what` as a relative change per relative change of the knob `knobName` — 1 meaning
 *  1 % for 1 % — or the reason there is none, as a sentence. */
function relative(
  slope: number,
  base: number,
  knob: number,
  what: string,
  knobName: string,
): number | string {
  if (!Number.isFinite(base) || base === 0)
    return `${what} is ${Number.isFinite(base) ? 'zero' : 'not finite'} at the design, so it has no relative change.`;
  if (knob === 0) return `${knobName} is zero, so a change of it has no relative size.`;
  if (!Number.isFinite(slope)) return `${what} has no slope against ${knobName}.`;
  return (slope * knob) / base;
}

/** The named results of a sheet, in the order it writes them: its equations, its solved params,
 *  then each composed block's provided values as the parent reads them (`amp__gain`). */
export function namedResults(doc: SheetDoc, base: SheetResult): { name: string; unit?: string }[] {
  const out: { name: string; unit?: string }[] = [];
  for (const e of doc.equations ?? []) out.push({ name: e.name, unit: e.unit });
  for (const p of doc.params) if (engineSolved(p)) out.push({ name: p.name, unit: p.unit });
  const seen = new Set(out.map((o) => o.name));
  for (const b of doc.blocks ?? [])
    for (const key of Object.keys(base.values))
      if (key.startsWith(`${b.name}__`) && !seen.has(key)) {
        seen.add(key);
        out.push({ name: key });
      }
  return out;
}

/** One named result's record from the base run and the probes taken (see SheetSensitivityResult). */
function result(
  name: string,
  unit: string | undefined,
  base: SheetResult,
  taken: readonly { values?: SheetResult['values']; given?: (name: string) => boolean }[],
  offsets: [number, number],
  knob: SheetVar,
): SheetSensitivityResult {
  const v0 = base.values[name];
  const head = { name, ...(unit ? { unit } : {}) };
  const blank = { base: v0 ?? NaN, dPerUnit: NaN, deltaPlus: NaN, deltaMinus: NaN };
  const cause = base.withheld?.[name];
  if (!givesValue(base, name))
    return {
      ...head,
      ...blank,
      why:
        cause !== undefined
          ? `${name} is withheld at the design, because it follows from ${cause === OWN_DEVICE ? 'the sheet’s own device' : cause}.`
          : `${name} has no value at the design.`,
    };
  const at = taken.map((t) => (t.given?.(name) ? t.values?.[name] : undefined));
  if (at.some((v) => v === undefined))
    return {
      ...head,
      ...blank,
      why: `${name} has no value at a probe of ${knob.name}, so no slope is taken.`,
    };
  const [dPerUnit, deltaPlus, deltaMinus] = differences(v0, at[0]!, at[1]!, offsets);
  const rel = relative(dPerUnit, v0, knob.value, name, knob.name);
  return {
    ...head,
    base: v0,
    dPerUnit,
    deltaPlus,
    deltaMinus,
    ...(typeof rel === 'number' ? { relPerPct: rel } : { why: rel }),
  };
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
  const m0 = rr.rawMargin;
  const [slope, deltaPlus, deltaMinus] = differences(m0, raw(0, id), raw(1, id), [step, far]);
  return {
    id,
    kind: rr.kind,
    baseStatus: rr.status,
    baseMargin: m0,
    dMarginPerUnit: rr.op === '==' ? NaN : slope,
    deltaPlus,
    deltaMinus,
  };
}
