// The spellings sheet documents used before their keys were renamed, and the one-level rewrite
// that brings such a document up to the current ones. Loading is the only place they are read:
// everything past the loader — validation, evaluation, export — knows the current keys alone.

import { isObject as obj } from './types';

/** Document keys: the earlier spelling → the current one. */
export const LEGACY_DOC_KEYS: Readonly<Record<string, string>> = {
  uses: 'blocks',
  provide: 'provides',
  rows: 'equations',
  rules: 'checks',
  bind: 'givens',
  edges: 'operatingRange',
};

/** Param keys, likewise. */
export const LEGACY_VAR_KEYS: Readonly<Record<string, string>> = { pin: 'designConstraint' };

/** Check kinds are VALUES, so they need their own pass: a kind left in its earlier spelling would
 *  fail kind membership and take the whole check with it. */
export const LEGACY_CHECK_KINDS: Readonly<Record<string, string>> = {
  invariant: 'physical',
  requirement: 'spec',
  guardrail: 'advisory',
};

/** `o` with each earlier key in `keys` moved to its current spelling. A container that carries
 *  BOTH spellings of one key is ambiguous — which one did the author mean? — so the pair is named
 *  in `both` and neither is merged into the other. */
function renamed(
  o: Record<string, unknown>,
  keys: Readonly<Record<string, string>>,
  both: string[],
  at: string,
): Record<string, unknown> {
  // Built from entries, never by assignment: a parsed document can carry `__proto__` as an
  // ordinary key, and assigning it would set the object's prototype instead — the key would
  // vanish from the loader's unknown-key accounting and its contents would read as authored.
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(o)) {
    const now = Object.prototype.hasOwnProperty.call(keys, k) ? keys[k] : k;
    if (now !== k && Object.prototype.hasOwnProperty.call(o, now))
      both.push(`${at}${k} and ${now}`);
    else out.push([now, v]);
  }
  return Object.fromEntries(out);
}

/**
 * One level of a raw sheet document in the current vocabulary: its own keys, each param's keys,
 * and each check's kind. A shallow rewrite — embedded child documents are left for the caller,
 * which is already walking them — that touches nothing else, so a value of the wrong shape
 * reaches the loader's own checks exactly as authored. `both` lists every key written in two
 * spellings at once; a caller must refuse such a document rather than pick one.
 */
export function inCurrentKeys(raw: Record<string, unknown>): {
  doc: Record<string, unknown>;
  both: string[];
} {
  const both: string[] = [];
  const doc = renamed(raw, LEGACY_DOC_KEYS, both, '');
  if (Array.isArray(doc.params))
    doc.params = doc.params.map((p: unknown, i) =>
      obj(p) ? renamed(p, LEGACY_VAR_KEYS, both, `params[${i}].`) : p,
    );
  if (Array.isArray(doc.checks))
    doc.checks = doc.checks.map((c: unknown) =>
      obj(c) &&
      typeof c.kind === 'string' &&
      Object.prototype.hasOwnProperty.call(LEGACY_CHECK_KINDS, c.kind)
        ? { ...c, kind: LEGACY_CHECK_KINDS[c.kind] }
        : c,
    );
  return { doc, both };
}
