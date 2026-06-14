// Full mostab import: parse → canonicalize (fold signed PMOS conventions into
// magnitudes) → validate (QA). parseMostabCsv deliberately stops at parsing, so
// this is the single seam every consumer should use — canonicalization and QA
// can't be forgotten. Pure, deterministic, zero DOM imports.

import type { ImportError, ImportHints, ImportResult } from '../types';
import { parseMostabCsv } from '../parse';
import { REQUIRED_KEYS } from '../namespace';
import { canonicalizeTable, validate } from '../qa';

/**
 * Import mostab CSV text/bytes into a Dataset: parse, canonicalize every table,
 * reject any table missing a required column, and attach the QA warnings. On a
 * parse failure the parser's ImportError list is returned unchanged. Optional
 * axes (l, vds, vsb) are NOT required here — a consumer that needs a particular
 * axis (e.g. a family chart over l) handles its absence itself.
 */
export function importMostab(input: string | Uint8Array, hints?: ImportHints): ImportResult {
  const parsed = parseMostabCsv(input, hints);
  if (!parsed.ok) return parsed;
  const tables = parsed.dataset.tables.map(canonicalizeTable);

  const errors: ImportError[] = [];
  for (const t of tables) {
    const missing = REQUIRED_KEYS.filter((k) => !t.grid.quantities.has(k));
    if (missing.length) {
      errors.push({
        kind: 'missing-required',
        message: `missing required column(s): ${missing.join(', ')}`,
        location: t.id.device,
      });
    }
  }
  if (errors.length) return { ok: false, errors };

  const warnings = tables.flatMap((t) => validate(t));
  return { ok: true, dataset: { tables, warnings } };
}
