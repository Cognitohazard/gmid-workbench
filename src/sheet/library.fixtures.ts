// Shared fixture kit for the sheet-library vetting suites (library*.test.ts): the
// demo table every golden evaluates against, the JSON loaders, and the demo-model
// closed-form helpers. Lives outside the vitest glob (not *.test.ts) so importing it
// never re-registers another file's tests, and is NOT exported from the barrel, so
// node:fs stays unreachable from the web bundle.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { generateDemoDevice, VA_PER_L, BODY_FACTOR, COX } from '../demo';
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

/** Two resistances in parallel — the shape half the library's output-node rows take. */
export const par = (a: number, b: number): number => 1 / (1 / a + 1 / b);

/** Early voltage of the demo model at length `L`. */
export const va = (L: number): number => VA_PER_L * L;

/** gds of a device bound to current `id` at length `L`, declared vds — exact in the model
 *  once bound, since gds/id = 1/(VA + vds) there. The one spelling of the demo's
 *  channel-length-modulation law; every output-node golden goes through it. */
export const gdsOf = (id: number, L: number, vds: number): number => id / (va(L) + vds);

/** Output-device r_o of a width-mirrored leg, in closed form. The reference sets the saturation
 *  current idSat_ref = I_in/(1 + vds_ref/VA); the output device copies the same current density at
 *  K times the width, and gds = idSat/VA in the demo model, so the vds the OUTPUT device sits at
 *  cancels out entirely. For a diode reference vds_ref is its own solved drop, read from the
 *  result the way the mirror goldens read it. The mirror sheets all size at L = 1 µm. */
export const roMirrored = (vdsRef: number, K: number, iIn: number): number =>
  1 / gdsOf(K * iIn, 1e-6, vdsRef);

/** An output node where a driver and its load carry the same current at the same L and the same
 *  |vds|: both gds are equal, so the node is half of one device's r_o. Pinning it alongside
 *  Av = gm·Rout says the interface row added a name and no arithmetic. */
export const stage2Rout = (I: number, L: number, vds: number): number => 1 / (2 * gdsOf(I, L, vds));

/** γ-model input-referred thermal density sqrt(4kTγ/gm) at the demo's γ = GAMMA_DEFAULT. */
export const vnthM = (gm: number): number => Math.sqrt((4 * PHYS.k * PHYS.T * GAMMA_DEFAULT) / gm);

/** Body transconductance of the demo model — exact at every point (see src/demo/index.ts). */
export const gmbOf = (gm: number): number => BODY_FACTOR * gm;

/** Gate capacitance of the demo model at a sized width: cgg = W·L·Cox, exact at every
 *  operating point (the model gives cgg no bias dependence at all). The sized W is what the
 *  bind lands on, so an input-capacitance golden pins the model relation and which device the
 *  row reads — the width itself is the sizer's answer, like a solved vgs. */
export const cggOf = (W: number, L: number): number => W * L * COX;

// The gate-source voltage the demo model needs for a given gm/ID at L = 0.5 µm, from the EKV
// inversion gm/ID = sigmoid(x)/(n·UT·softplus(x)) with n = 1.3. Shared because a NODE LEVEL a
// sheet derives from one device's gate — rather than typing it — lands on exactly these
// numbers, so several goldens now hinge on the same three. The demo's gm/ID is independent of
// vds and (with no vsb axis) of body bias, so one constant per gm/ID is the whole story.
export const VGS_GMID8_L05 = 0.668042;
export const VGS_GMID10_L05 = 0.610063;
export const VGS_GMID12_L05 = 0.567023;
