// The curated sheet library: the JSON documents under /sheets, grouped by directory.
// import.meta.glob resolves statically at build time, so the offline single-file build
// inlines every sheet. The docs are first-party data vetted by the core suite
// (src/sheet/library.test.ts) — trusted the same way the EXAMPLES literal is, so no
// sanitize pass here.

import { EXAMPLES, searchable, type SheetDoc, type SheetRefEntry } from '@gmid/mostab-core';

export interface SheetLibraryGroup {
  label: string;
  sheets: readonly SheetDoc[];
}

// Directory → display label, in menu order.
const GROUPS: [dir: string, label: string][] = [
  ['stages', 'Stages'],
  ['mirrors-bias', 'Mirrors & bias'],
  ['otas', 'OTAs'],
  ['multistage', 'Multi-stage & buffers'],
  ['applications', 'Applications'],
];

const modules = import.meta.glob('../../sheets/*/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, SheetDoc>;

/** Curated sheets with their library ids (`group/name`, extension dropped) — the static
 *  half of the by-reference index; user-loaded sheets add the dynamic half (sheetlib).
 *  The shipped examples are deliberately NOT addressable — they are demos, not blocks. */
export const CURATED_ENTRIES: readonly SheetRefEntry[] = Object.entries(modules).map(
  ([path, doc]) => ({
    path: path.slice(path.indexOf('/sheets/') + '/sheets/'.length).replace(/\.json$/, ''),
    doc,
  }),
);

/** The picker's candidates — which sheets are searchable is the core's curation (`searchable`),
 *  so the app cannot drift from what the core suite gates. In a stable display order: the queue
 *  order is what the results table streams in, so it is alphabetical by title, not the glob's. */
export const SEARCHABLE_SHEETS: readonly SheetRefEntry[] = CURATED_ENTRIES.filter((e) =>
  searchable(e.path),
).sort((a, b) => a.doc.title.localeCompare(b.doc.title));

// One uniform menu for the sheet picker: the shipped examples are just the first
// group, so the panel needs a single render loop and a single group:index decode.
export const SHEET_MENU: readonly SheetLibraryGroup[] = [
  { label: 'Examples', sheets: EXAMPLES },
  ...GROUPS.map(([dir, label]) => ({
    label,
    sheets: Object.entries(modules)
      .filter(([path]) => path.includes(`/sheets/${dir}/`))
      .map(([, doc]) => doc)
      .sort((a, b) => a.title.localeCompare(b.title)),
  })).filter((g) => g.sheets.length > 0),
];
