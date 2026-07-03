// Structural QA for a leaf sheet, in the qa/validate() shape: init an array, push
// warning literals, skip-not-throw, return the bare array. It checks what evaluation
// cannot conveniently express — bind arity, finite params, equality tolerance, kind/op
// sanity, and a param shadowing a device quantity. Identifier resolution is left to
// evaluateSheet, which surfaces undeclared names against the live value set. DOM-free.

import type { QAWarning } from '../types';
import {
  MAX_USE_DEPTH,
  PROVIDE_SEP,
  RULE_KINDS,
  RULE_OPS,
  joinProvide,
  prefixUseWarning,
  type SheetDoc,
} from './types';

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
    const n = (['gm', 'gm_id', 'id'] as const).filter((k) => doc.bind?.[k] !== undefined).length;
    if (n !== 2) {
      out.push({
        rule: 'sheet-bind',
        severity: 'error',
        message: `bind needs exactly two of {gm, gm_id, id}, got ${n}`,
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
  }

  // Composition: validate each child block and attribute its findings to the use site.
  if (doc.uses) {
    // Collision guard: a child exposes scalars into the parent scope as `name__key`. If a
    // parent param or row is named identically, the child injection silently overwrites it
    // (or the row shadows the injection) — surface it rather than resolve it by overwrite.
    const injected = new Set<string>();
    for (const use of doc.uses) {
      for (const key of use.doc.provide ?? []) injected.add(joinProvide(use.name, key));
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

    const seen = new Set<string>();
    for (const use of doc.uses) {
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
      for (const key of use.doc.provide ?? []) {
        if (key.includes(PROVIDE_SEP)) {
          out.push({
            rule: 'sheet-provide',
            severity: 'warning',
            message: `provided name "${key}" in use "${use.name}" must not contain "${PROVIDE_SEP}"`,
            location: use.name,
          });
        }
      }
      if (use.params) {
        const childParams = new Set(use.doc.params.map((p) => p.name));
        for (const k of Object.keys(use.params)) {
          if (!childParams.has(k)) {
            out.push({
              rule: 'sheet-use-param',
              severity: 'warning',
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
      for (const w of validateSheet(use.doc, _depth + 1)) out.push(prefixUseWarning(use.name, w));
    }
  }

  return out;
}
