// Numeric-entry and margin formatting shared by the panels. Presentation only: parsing and
// formatting live in the core, and these are the two idioms every panel wraps them in.

import { formatEng, parseEng, MARGIN_PCT_CAP } from '@gmid/mostab-core';

/**
 * Commit an engineering-notation field ("20u", "1.8", "2p") on change: parse, normalize the
 * display to the canonical suffix, and set. A malformed entry restores the last good value so
 * a typo never writes NaN. Empty is allowed only when `clearable`, clearing via null — which is
 * how a field says "no value" rather than "zero".
 */
export function commitEng(
  el: HTMLInputElement,
  current: number | undefined,
  set: (v: number | null) => void,
  clearable = false,
): void {
  const raw = el.value.trim();
  if (raw === '' && clearable) {
    set(null);
    return;
  }
  try {
    const v = parseEng(raw);
    el.value = formatEng(v);
    set(v);
  } catch {
    el.value = current === undefined ? '' : formatEng(current);
  }
}

/** A rule's relative margin as a signed percentage. Past MARGIN_PCT_CAP the ratio carries no
 *  information (a rule whose right-hand side is ~0 gets its margin from the clamp), so it reads
 *  as "no percentage" rather than as a very large number. */
export const pct = (v: number): string =>
  Number.isFinite(v) && Math.abs(v) < MARGIN_PCT_CAP
    ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`
    : '—';
