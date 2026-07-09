// Shared fixture kit for the sheet-library vetting suites (library*.test.ts): the
// demo table every golden evaluates against, the JSON loaders, and the demo-model
// closed-form helpers. Lives outside the vitest glob (not *.test.ts) so importing it
// never re-registers another file's tests, and is NOT exported from the barrel, so
// node:fs stays unreachable from the web bundle.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { generateDemoDevice, VA_PER_L } from '../demo';
import { GAMMA_DEFAULT, PHYS } from '../constants';
import { buildSheetRefIndex, type SheetRefIndex } from './resolve';
import type { SheetDoc } from './types';

export { VA_PER_L };

const SHEETS_DIR = fileURLToPath(new URL('../../sheets', import.meta.url));

export interface LibrarySheet {
  file: string;
  doc: SheetDoc;
}

/** Every JSON document under sheets/<group>/, as parsed data. */
export function loadLibrary(): LibrarySheet[] {
  return readdirSync(SHEETS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((g) =>
      readdirSync(join(SHEETS_DIR, g.name))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => ({
          file: `${g.name}/${f}`,
          doc: JSON.parse(readFileSync(join(SHEETS_DIR, g.name, f), 'utf8')) as SheetDoc,
        })),
    );
}

/** One library document by its `group/file.json` path. */
export function sheet(path: string): SheetDoc {
  return JSON.parse(readFileSync(join(SHEETS_DIR, path), 'utf8')) as SheetDoc;
}

/** Ref index over the whole curated library (ids = `group/name`, extension dropped) —
 *  what the web app builds from its bundled sheets; library goldens resolve against it. */
export const REFS: SheetRefIndex = buildSheetRefIndex(
  loadLibrary().map(({ file, doc }) => ({ path: file.replace(/\.json$/, ''), doc })),
);

// The 3-D [l, vds, vgs] demo table shared by every golden; the 0.05 V vds step keeps
// declared operating points on-grid where goldens want to be tight.
export const table = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.05 } });

export const relErr = (v: number, expected: number): number => Math.abs(v / expected - 1);

/** γ-model input-referred thermal density sqrt(4kTγ/gm) at the demo's γ = GAMMA_DEFAULT. */
export const vnthM = (gm: number): number => Math.sqrt((4 * PHYS.k * PHYS.T * GAMMA_DEFAULT) / gm);
