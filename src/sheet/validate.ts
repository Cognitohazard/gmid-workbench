// Structural QA for a leaf sheet, in the qa/validate() shape: init an array, push
// warning literals, skip-not-throw, return the bare array. It checks what evaluation
// cannot conveniently express — bind arity, finite params, equality tolerance, kind/op
// sanity, and a param shadowing a device quantity. Identifier resolution is left to
// evaluateSheet, which surfaces undeclared names against the live value set. DOM-free.

import type { QAWarning } from '../types';
import { compileExpr } from '../derive';
import { BINDABLE, bindProblem } from '../device';
import {
  BIAS_AXES,
  MAX_TORN_PARAMS,
  MAX_USE_DEPTH,
  torn,
  PROVIDE_SEP,
  RULE_KINDS,
  RULE_OPS,
  joinProvide,
  prefixUseWarning,
  type SheetDoc,
} from './types';

/** Free identifiers of an expression, or [] when it does not parse (eval names the
 *  parse error at the failing site; the validator only needs the names). */
function namesOf(expr: string): readonly string[] {
  try {
    return compileExpr(expr).names;
  } catch {
    return [];
  }
}

/** Free names inside each `abs(...)` call of an expression. A consistency check reads
 *  `abs(child__vgs - vgs_est) <= tol`, so the two sides of the round trip appear inside ONE
 *  absolute difference — which is what separates it from a headroom guardrail like
 *  `V_node - child__vdsat >= 0`, where the same two names appear with no claim that they are
 *  equal. Scans for the matching close paren; unbalanced source simply yields nothing. */
/** Free names inside each `abs(...)` call of an expression. A consistency check reads
 *  `abs(child__vgs - vgs_est) <= tol`, so the two sides of the round trip appear inside ONE
 *  absolute difference — which is what separates it from a headroom guardrail like
 *  `V_node - child__vdsat >= 0`, where the same two names appear with no claim that they are
 *  equal. The parser supplies the call sites (CompiledExpr.calls), so whitespace and nesting are
 *  its problem, not a second grammar's. */
function absArgNames(expr: string): readonly ReadonlySet<string>[] {
  try {
    return compileExpr(expr).calls.get('abs') ?? [];
  } catch {
    return [];
  }
}

/**
 * Quantities a bias stand-in can be a stand-in FOR: the LEVEL a device sits at. A margin
 * quantity like vdsat is not one, and letting it count made a legitimately declared bias paired
 * with a symmetric headroom check — `abs(v_bias - dev__vdsat) <= 0.15`, which the format docs
 * recommend — read as a hand-tuned estimate.
 *
 * Hand-maintained, which the BIND_KEYS comment warns against for good reason. It stays a list
 * because nothing in the namespace distinguishes a level from a margin; deriving it needs a new
 * flag on BASE_QUANTITIES. Tolerable only because the blast radius is one advisory warning.
 */
const STANDIN_TARGETS: readonly string[] = ['vgs', 'vth'];

/**
 * A param that BIASES a child block while a rule asserts that same param EQUALS the child's own
 * operating point is a hand-tuned stand-in: the author guessed a value, biased the device with the
 * guess, and added a guardrail telling themselves to retune until the guess agrees. It works, and
 * it silently makes every number downstream depend on how carefully somebody re-typed a voltage.
 *
 * Detected structurally, never by name: for each bias axis a child binds, take the free names of
 * the expression feeding it, keep the ones that are parent params, and look for a rule that puts
 * one of those params and something the same child provides inside a single absolute difference.
 * The absolute difference is the discriminator — it is the sheet asserting the two are the same
 * number. A guardrail that merely mentions both (headroom against a node voltage) is not a round
 * trip and must not be flagged.
 *
 * The message names the fix, which depends on where the stand-in is used:
 *  - as `vds`, tied to the child's own `vgs` — the device is DIODE-CONNECTED. `vds = vgs` holds by
 *    construction; nothing needs estimating, the table can be read on that diagonal.
 *  - as `vsb` — the source sits above the bulk, so the node it sits on is the natural variable.
 *    Parameterize by that node and both of the device's bias coordinates are known outright.
 *  - anything else — usually a node voltage inside a stack, written as an estimated difference.
 *    Declare the node voltages and each bias becomes a subtraction.
 *
 * Advisory: the sheets carrying this pattern give correct answers today. It is a standing
 * invitation to reparameterize, not a defect report.
 */
function standInEstimates(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const paramNames = new Set(doc.params.map((p) => p.name));
  const ruleNames = doc.rules.map((r) => ({
    id: r.id,
    absArgs: [...absArgNames(r.lhs), ...absArgNames(r.rhs)],
  }));

  for (const use of doc.uses ?? []) {
    const bind = use.doc?.bind;
    if (!bind) continue;
    const provided = new Set((use.doc?.provide ?? []).map((k) => joinProvide(use.name, k)));
    for (const axis of BIAS_AXES) {
      // BIAS_AXES is namespace-derived; SheetBind's bias fields are static keys. Index
      // structurally, as eval does, rather than by the literal key union.
      const childParam = (bind as unknown as Partial<Record<string, string>>)[axis];
      const expr = childParam === undefined ? undefined : use.params?.[childParam];
      if (expr === undefined) continue;
      const exprNames = namesOf(expr);
      const standIns = exprNames.filter((n) => paramNames.has(n));
      if (standIns.length === 0) continue;

      for (const r of ruleNames) {
        // Both sides of the round trip must sit inside ONE absolute difference — the sheet
        // asserting they are the same number, not a guardrail that happens to mention both.
        const levels = STANDIN_TARGETS.map((q) => joinProvide(use.name, q)).filter((q) =>
          provided.has(q),
        );
        const pair = r.absArgs.find(
          (a) => standIns.some((n) => a.has(n)) && levels.some((q) => a.has(q)),
        );
        if (!pair) continue;
        const tiedTo = levels.filter((q) => pair.has(q));
        const hit = standIns.find((n) => pair.has(n)) as string;
        // Diode-connected requires BOTH: the bias is nothing but the stand-in (`vds = vgs_est`,
        // the identity written as a guess), and the rule compares exactly those two quantities.
        // A stack's KVL check — `abs((CM - in__vgs) + vds_a + vds_b - V_out)` — also puts the
        // two inside one abs, but it is summing a loop of node drops, not asserting an identity.
        const sole = exprNames.length === 1 && exprNames[0] === hit;
        const pairwise = pair.size === 2;
        const diode =
          axis === 'vds' && sole && pairwise && tiedTo.includes(joinProvide(use.name, 'vgs'));
        const fix = diode
          ? `"${use.name}" is diode-connected — its vds IS its vgs, so bind the connection instead of estimating it`
          : axis === 'vsb'
            ? `the source of "${use.name}" sits above the bulk — parameterize by that node voltage and both of its bias coordinates follow directly`
            : `this reads as a node voltage written as an estimated difference — declare the node voltages and let ${axis} be a subtraction`;
        out.push({
          rule: 'sheet-standin',
          severity: 'warning',
          message:
            `param "${hit}" biases block "${use.name}" (${axis}) while rule "${r.id}" ties it back ` +
            `to that block's own ${tiedTo.join(', ')} — a hand-tuned stand-in for the operating ` +
            `point it is meant to produce. ${fix}`,
          location: use.name,
          symbol: hit,
        });
        break; // one finding per axis; the first rule that closes the loop names it
      }
    }
  }
  return out;
}

/** Surface authoring problems as warnings; never throws, never mutates the doc. Structural
 *  and device-independent — identifier resolution against the live values is eval's job.
 *  Recurses into composed children, attributing each child's findings to its use site. */
export function validateSheet(doc: SheetDoc, _depth = 0): QAWarning[] {
  const out: QAWarning[] = [];

  for (const p of doc.params) {
    if (!Number.isFinite(p.value)) {
      out.push({
        rule: 'sheet-param',
        severity: 'error',
        message: `param "${p.name}" is not a finite number`,
        location: p.name,
      });
    }
    // A tearing variable that solves for itself is a fixed point trivially, and hides the
    // loop it was meant to close. Only the self-reference is checkable here — whether the
    // target resolves at all depends on the live value set, which is eval's job.
    if (p.solveFor === p.name) {
      out.push({
        rule: 'sheet-param',
        severity: 'error',
        message: `param "${p.name}" solves for itself — name the value it is an estimate of`,
        location: p.name,
      });
    }
  }

  // The architecture allows "small, explicit, designer-named fixed points" and no nodal solver.
  // A sheet tearing many unknowns at once stops being that and becomes relaxation over a node
  // set, so the word "small" is enforced here rather than left as an aspiration.
  const unknowns = doc.params.filter(torn);
  if (unknowns.length > MAX_TORN_PARAMS) {
    out.push({
      rule: 'sheet-param',
      severity: 'error',
      message:
        `${unknowns.length} params carry solveFor (${unknowns.map((p) => p.name).join(', ')}); ` +
        `at most ` +
        `${MAX_TORN_PARAMS} are allowed — a sheet solves a few named bias loops, it is not a ` +
        `circuit solver over a node set`,
      location: 'params',
    });
  }

  if (doc.bind) {
    const problem = bindProblem(BINDABLE.filter((k) => doc.bind?.[k] !== undefined));
    if (problem) {
      out.push({
        rule: 'sheet-bind',
        severity: 'error',
        message: `bind ${problem}`,
        location: 'bind',
      });
    }
  }

  for (const r of doc.rules) {
    if (!RULE_KINDS.has(r.kind)) {
      out.push({
        rule: 'sheet-rule',
        severity: 'warning',
        message: `rule "${r.id}" has unknown kind "${r.kind}"`,
        location: r.id,
      });
    }
    if (!RULE_OPS.has(r.op)) {
      out.push({
        rule: 'sheet-rule',
        severity: 'warning',
        message: `rule "${r.id}" has unknown operator "${r.op}"`,
        location: r.id,
      });
    }
    if (r.op === '==' && r.tolPct === undefined) {
      out.push({
        rule: 'sheet-tol',
        severity: 'warning',
        message: `equality rule "${r.id}" has no tolPct (will require an exact match)`,
        location: r.id,
      });
    }
    // A non-finite tolPct poisons the '==' margin arithmetic into NaN; eval degrades that
    // to `na` (fail-closed), but the authoring mistake should be named at the source.
    if (r.tolPct !== undefined && (!Number.isFinite(r.tolPct) || r.tolPct < 0)) {
      out.push({
        rule: 'sheet-tol',
        severity: 'error',
        message: `rule "${r.id}" tolPct must be a finite number >= 0, got ${r.tolPct}`,
        location: r.id,
      });
    }
  }

  // A diode connection already fixes vds; declaring both means one of them is a fiction, and
  // guessing which the author meant would be worse than saying so.
  if (doc.bind?.diode && doc.bind.vds !== undefined) {
    out.push({
      rule: 'sheet-bind',
      severity: 'error',
      message:
        'bind declares both a diode connection and a vds — the connection ties vds to vgs, so a ' +
        'separate vds cannot also hold. Drop one',
      location: 'bind',
    });
  }

  // Composition: validate each child block and attribute its findings to the use site.
  if (doc.uses) {
    // Collision guard: a child exposes scalars into the parent scope as `name__key`. If a
    // parent param or row is named identically, the child injection silently overwrites it
    // (or the row shadows the injection) — surface it rather than resolve it by overwrite.
    // A ref-only use's provides are unknown until resolution, so these structural
    // checks cover embedded children only — run validation on the RESOLVED doc (as
    // runSheet does when given a ref index) for full coverage.
    const injected = new Set<string>();
    for (const use of doc.uses) {
      for (const key of use.doc?.provide ?? []) injected.add(joinProvide(use.name, key));
    }
    for (const p of doc.params) {
      if (injected.has(p.name)) {
        out.push({
          rule: 'sheet-collision',
          severity: 'warning',
          message: `param "${p.name}" collides with a scalar a child block provides — the child's value would silently override it`,
          location: p.name,
        });
      }
    }
    for (const r of doc.rows) {
      if (injected.has(r.name)) {
        out.push({
          rule: 'sheet-collision',
          severity: 'warning',
          message: `row "${r.name}" collides with a scalar a child block provides`,
          location: r.name,
        });
      }
    }

    out.push(...standInEstimates(doc));

    // Children evaluate in document order, and a use's param overrides may reference the
    // provides of EARLIER siblings only. A forward (or self) reference is statically
    // detectable here: the joined name can never be in scope when the override resolves.
    const providedBy = (idx: number): Set<string> => {
      const s = new Set<string>();
      const u = doc.uses![idx];
      for (const key of u.doc?.provide ?? []) s.add(joinProvide(u.name, key));
      return s;
    };
    for (let i = 0; i < doc.uses.length; i++) {
      const use = doc.uses[i];
      if (!use.params) continue;
      const later = new Set<string>();
      for (let j = i; j < doc.uses.length; j++) for (const n of providedBy(j)) later.add(n);
      for (const [k, expr] of Object.entries(use.params)) {
        for (const n of namesOf(expr)) {
          if (later.has(n)) {
            out.push({
              rule: 'sheet-use-param',
              severity: 'warning',
              message: `use "${use.name}" override "${k}" references "${n}", which is provided by this or a LATER sibling — children evaluate in document order, so it will not resolve`,
              location: use.name,
            });
          }
        }
      }
    }

    const seen = new Set<string>();
    for (const use of doc.uses) {
      // Exactly one content source: an embedded doc, or a non-blank ref to resolve. A
      // use with neither can never evaluate; a blank ref can never match a library id.
      if (!use.doc && use.ref === undefined) {
        out.push({
          rule: 'sheet-use',
          severity: 'error',
          message: `use "${use.name}" has neither an embedded doc nor a ref`,
          location: use.name,
        });
      }
      if (use.ref !== undefined && !use.ref.trim()) {
        out.push({
          rule: 'sheet-ref',
          severity: 'error',
          message: `use "${use.name}" has an empty ref`,
          location: use.name,
        });
      }
      const name = use.name?.trim();
      if (!name) {
        out.push({
          rule: 'sheet-use',
          severity: 'error',
          message: 'a use has an empty name',
          location: 'uses',
        });
      } else {
        if (seen.has(name)) {
          out.push({
            rule: 'sheet-use',
            severity: 'error',
            message: `duplicate use name "${name}"`,
            location: name,
          });
        }
        seen.add(name);
        if (name.includes(PROVIDE_SEP)) {
          out.push({
            rule: 'sheet-use',
            severity: 'error',
            message: `use name "${name}" must not contain "${PROVIDE_SEP}" (the provide separator)`,
            location: name,
          });
        }
      }
      // A provide key normally must not contain the separator — EXCEPT when it names a
      // scalar the child itself received from ITS children (`grand__key`): re-exporting a
      // grandchild value up the tree is the ratified idiom for surfacing a deep quantity,
      // so only a separator-bearing key that matches nothing injectable is flagged.
      const childInjected = new Set<string>();
      for (const g of use.doc?.uses ?? []) {
        for (const k of g.doc?.provide ?? []) childInjected.add(joinProvide(g.name, k));
      }
      for (const key of use.doc?.provide ?? []) {
        if (key.includes(PROVIDE_SEP) && !childInjected.has(key)) {
          out.push({
            rule: 'sheet-provide',
            severity: 'warning',
            message: `provided name "${key}" in use "${use.name}" must not contain "${PROVIDE_SEP}" (unless re-exporting a child's provide)`,
            location: use.name,
          });
        }
      }
      // Override keys can only be checked against a KNOWN child param list — for a
      // ref-only use that list arrives at resolution, and revalidating the resolved
      // doc (runSheet's path) performs this same check with the doc filled in.
      if (use.params && use.doc) {
        const childParams = new Set(use.doc.params.map((p) => p.name));
        for (const k of Object.keys(use.params)) {
          // An error, not advice: the value the parent wired will never reach the child,
          // which then sizes on its embedded default — eval fails this closed too.
          if (!childParams.has(k)) {
            out.push({
              rule: 'sheet-use-param',
              severity: 'error',
              message: `use "${use.name}" overrides "${k}", which is not a param of the child`,
              location: use.name,
            });
          }
        }
      }
      if (_depth >= MAX_USE_DEPTH) {
        out.push({
          rule: 'sheet-use',
          severity: 'error',
          message: `use "${use.name}": composition nested deeper than ${MAX_USE_DEPTH}`,
          location: use.name,
        });
        continue;
      }
      if (use.doc) {
        for (const w of validateSheet(use.doc, _depth + 1)) {
          out.push(prefixUseWarning(use.name, w));
        }
      }
    }
  }

  return out;
}
