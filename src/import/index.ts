// Full mostab import: parse → canonicalize → validate (QA). parseMostabCsv
// deliberately stops at parsing, so this is the single seam every consumer should
// use — canonicalization and QA can't be forgotten. A signed PMOS dump is FLAGGED
// by QA warnings, never sniffed-and-repaired: magnitude-canonicalization only runs
// when the SOURCE declares its polarity (`# polarity: p`), which the parser records
// as meta.polarity.signedInput. With that declaration the fold runs BEFORE QA, so a
// properly-declared signed PMOS table folds to magnitudes (and records its polarity)
// and raises no sign warnings; an UNDECLARED signed dump stays signed and QA warns.
// Pure, deterministic, zero DOM imports.

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
  // canonicalizeTable folds the value columns to magnitudes only when the source
  // declared a signed polarity (meta.polarity.signedInput, set by the parser from
  // `# polarity: p`); otherwise it is a no-op and the QA pass below FLAGS a signed
  // PMOS dump rather than silently folding an undeclared one.
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
