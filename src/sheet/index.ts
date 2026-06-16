// Public surface of the leaf design-sheet module. `runSheet` is the single entrypoint:
// it validates then evaluates, attaching the validation warnings — mirroring the
// importMostab discipline so a caller cannot skip validation.

import type { DeviceTable } from '../types';
import type { SheetDoc, SheetResult } from './types';
import { validateSheet } from './validate';
import { evaluateSheet } from './eval';

export * from './types';
export * from './eval';
export * from './validate';
export * from './examples';

/** Validate + evaluate a leaf sheet, merging validation warnings ahead of eval warnings. A
 *  validation error (e.g. a non-finite param, which eval silently skips) also forces the
 *  feasibility verdict false, so a structurally broken sheet is never reported feasible. */
export function runSheet(doc: SheetDoc, table?: DeviceTable): SheetResult {
  const pre = validateSheet(doc);
  const res = evaluateSheet(doc, table);
  const blocked = pre.some((w) => w.severity === 'error');
  return { ...res, feasible: res.feasible && !blocked, warnings: [...pre, ...res.warnings] };
}
