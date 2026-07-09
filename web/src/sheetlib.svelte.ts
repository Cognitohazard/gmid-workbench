// The live sheet library: the bundled curated entries plus the user's imported sheets,
// unioned into one by-reference index and one picker menu. User sheets are untrusted
// JSON — sanitized on the way in — kept in $state and persisted to localStorage, so a
// sheet imported once keeps resolving refs across reloads (the runtime stand-in for
// the sheets/ folder the browser cannot read). Ids live under an implicit `user/`
// folder, so a bare name that collides with a curated sheet stays disambiguable.

import { buildSheetRefIndex, type SheetDoc, type SheetRefIndex } from '@gmid/mostab-core';
import { CURATED_ENTRIES, SHEET_MENU, type SheetLibraryGroup } from './library';
import { sanitizeSheet } from './dashboard';
import { loadJSON, saveJSON } from './storage';

export interface UserSheet {
  name: string; // bare id (filename sans .json); addressable as `user/<name>` or bare
  doc: SheetDoc;
}

const KEY = 'gmid.sheets';

/** A sheet document is KBs; this cap (on the raw JSON text) refuses a multi-MB import
 *  before it is parsed or persisted — the resolver's expansion budget bounds ref
 *  blowup, not raw document size. The persisted blob gets the matching pre-parse
 *  guard via loadJSON's maxLen below. */
export const MAX_SHEET_JSON_BYTES = 2_000_000;

/** The one id contract for a user sheet, shared by the import path (which reports the
 *  violation) and the persisted-list loader (which drops the entry): bare non-empty
 *  name, no '/' (the folder separator is the index's namespace qualifier). */
const validSheetName = (name: string): boolean => !!name.trim() && !name.includes('/');

/** Coerce the persisted list — each entry re-sanitized like any untrusted sheet, and
 *  held to the SAME id contract as a fresh import (last one wins on duplicates) so
 *  hand-edited localStorage cannot mint ids the import path would refuse. */
function parseUserSheets(raw: unknown): UserSheet[] {
  if (!Array.isArray(raw)) return [];
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive dedup scratch, discarded on return
  const byName = new Map<string, UserSheet>();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (typeof o.name !== 'string' || !validSheetName(o.name)) continue;
    const doc = sanitizeSheet(o.doc);
    if (doc) byName.set(o.name, { name: o.name, doc });
  }
  return [...byName.values()];
}

const store = $state({
  // 4× the per-sheet cap bounds the whole persisted blob BEFORE parse (loadJSON maxLen)
  // — past it the store is treated as corrupt and reset, never re-parsed on every boot.
  sheets: loadJSON(KEY, parseUserSheets, (): UserSheet[] => [], 4 * MAX_SHEET_JSON_BYTES),
});

export function userSheets(): readonly UserSheet[] {
  return store.sheets;
}

/**
 * Import one sheet JSON (file picker / drag-drop). Returns an error message, or null on
 * success. The bare filename becomes the id; re-importing the same name replaces the
 * old version (matching the index's last-wins rule for a repeated full path).
 */
export function importSheetJSON(filename: string, text: string): string | null {
  if (text.length > MAX_SHEET_JSON_BYTES) {
    return `sheet JSON is ${Math.round(text.length / 1e6)} MB — a sheet document is a few KB; refusing to import`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `not valid JSON (${e instanceof Error ? e.message : String(e)})`;
  }
  const doc = sanitizeSheet(parsed);
  if (!doc) return 'not a sheet document';
  const name = filename.replace(/\.json$/i, '').trim();
  if (!validSheetName(name)) {
    return name ? 'the sheet id must not contain "/"' : 'the filename gives the sheet an empty id';
  }
  const i = store.sheets.findIndex((s) => s.name === name);
  if (i >= 0) store.sheets[i] = { name, doc };
  else store.sheets.push({ name, doc });
  saveJSON(KEY, store.sheets);
  return null;
}

export function removeUserSheet(name: string): void {
  store.sheets = store.sheets.filter((s) => s.name !== name);
  saveJSON(KEY, store.sheets);
}

// One index over both halves. Rebuilt when the user list changes; the curated half is
// static. Bare-name collisions (user file shadowing a curated name) become explicit
// ambiguous markers — a ref then fails with the qualified candidates, never a guess.
const refIndex = $derived(
  buildSheetRefIndex([
    ...CURATED_ENTRIES,
    ...store.sheets.map((s) => ({ path: `user/${s.name}`, doc: s.doc })),
  ]),
);

export function sheetRefIndex(): SheetRefIndex {
  return refIndex;
}

const menu = $derived.by((): readonly SheetLibraryGroup[] =>
  store.sheets.length
    ? [...SHEET_MENU, { label: 'Your sheets', sheets: store.sheets.map((s) => s.doc) }]
    : SHEET_MENU,
);

/** The picker menu: curated groups plus a "Your sheets" group when any are loaded. */
export function sheetMenu(): readonly SheetLibraryGroup[] {
  return menu;
}
