// The curated sheet library: the JSON documents under /sheets, grouped by directory.
// import.meta.glob resolves statically at build time, so the offline single-file build
// inlines every sheet. The docs are first-party data vetted by the core suite
// (src/sheet/library.test.ts) — trusted the same way the EXAMPLES literal is, so no
// sanitize pass here.

import { EXAMPLES, type SheetDoc } from '@gmid/mostab-core';

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
