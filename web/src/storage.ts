// One place for the "persist a small JSON blob in localStorage, tolerate corrupt/blocked
// storage" pattern shared by the dashboard layout and the appearance settings. Keeping the
// try/catch + parse/sanitize/fallback idiom in a single spot stops the two callers from
// drifting (e.g. file:// with storage blocked, quota errors — all swallowed the same way).

/** Read + sanitize a stored value, or the fallback. `parse` coerces the untrusted parsed JSON
 *  and may return null to reject it; corrupt/unavailable storage also yields the fallback.
 *  `fallback` is a thunk so it isn't computed when a valid stored value is present. `maxLen`
 *  bounds the RAW text and treats an oversized blob as corrupt — the one guard that runs
 *  before JSON.parse, so a poisoned key cannot hang every subsequent load. */
export function loadJSON<T>(
  key: string,
  parse: (raw: unknown) => T | null,
  fallback: () => T,
  maxLen?: number,
): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null && (maxLen === undefined || raw.length <= maxLen)) {
      const v = parse(JSON.parse(raw));
      if (v != null) return v;
    }
  } catch {
    // unavailable (e.g. file:// with storage blocked) or corrupt → fallback
  }
  return fallback();
}

/** Persist a value as JSON (best-effort; quota / unavailable storage is non-fatal). */
export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota / unavailable — ignore
  }
}

/** Delete a stored key (best-effort, like saveJSON). */
export function removeJSON(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // unavailable — ignore
  }
}

/** The sizer's persisted problem (bound pair, band, chosen L) — defined here so the
 *  bench-wide "clear all" can wipe it without importing the component. */
export const SIZER_KEY = 'gmid.sizer';
