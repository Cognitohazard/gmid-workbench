// Structural QA for a leaf sheet, in the qa/validate() shape: init an array, push
// warning literals, skip-not-throw, return the bare array. It checks what evaluation
// cannot conveniently express — bind arity, finite params, equality tolerance, kind/op
// sanity, and a param shadowing a device quantity. Identifier resolution is left to
// evaluateSheet, which surfaces undeclared names against the live value set. DOM-free.

import type { QAWarning } from '../types';
import { compileExpr } from '../derive';
import { BINDABLE, bindProblem } from '../device';
import {
  MAX_USE_DEPTH,
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
