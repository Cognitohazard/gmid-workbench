// Structural QA for a leaf sheet, in the qa/validate() shape: init an array, push
// warning literals, skip-not-throw, return the bare array. It checks what evaluation
// cannot conveniently express — bind arity, finite params, equality tolerance, kind/op
// sanity, and a param shadowing a device quantity. Identifier resolution is left to
// evaluateSheet, which surfaces undeclared names against the live value set. DOM-free.

import type { QAWarning } from '../types';
import { RULE_KINDS, RULE_OPS, type SheetDoc } from './types';

/** Surface authoring problems as warnings; never throws, never mutates the doc. Structural
 *  and device-independent — identifier resolution against the live values is eval's job. */
export function validateSheet(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];

  for (const p of doc.params) {
    if (!Number.isFinite(p.value)) {
      out.push({ rule: 'sheet-param', severity: 'error', message: `param "${p.name}" is not a finite number`, location: p.name });
    }
  }

  if (doc.bind) {
    const n = (['gm', 'gm_id', 'id'] as const).filter((k) => doc.bind?.[k] !== undefined).length;
    if (n !== 2) {
      out.push({ rule: 'sheet-bind', severity: 'error', message: `bind needs exactly two of {gm, gm_id, id}, got ${n}`, location: 'bind' });
    }
  }

  for (const r of doc.rules) {
    if (!RULE_KINDS.has(r.kind)) {
      out.push({ rule: 'sheet-rule', severity: 'warning', message: `rule "${r.id}" has unknown kind "${r.kind}"`, location: r.id });
    }
    if (!RULE_OPS.has(r.op)) {
      out.push({ rule: 'sheet-rule', severity: 'warning', message: `rule "${r.id}" has unknown operator "${r.op}"`, location: r.id });
    }
    if (r.op === '==' && r.tolPct === undefined) {
      out.push({ rule: 'sheet-tol', severity: 'warning', message: `equality rule "${r.id}" has no tolPct (will require an exact match)`, location: r.id });
    }
  }

  return out;
}
