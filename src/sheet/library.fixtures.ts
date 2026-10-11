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
import { buildSheetRefIndex, type SheetRefEntry, type SheetRefIndex } from './resolve';
import { gdsOf } from './library.math';
import type { SheetDoc } from './types';

export { VA_PER_L };
// The demo model's closed forms live in library.math.ts, which has no import-time work; they
// are re-exported here so a suite already holding the fixtures needs no second import.
export { relErr, par, va, gdsOf, pelgromIrelRatio } from './library.math';

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

/** The library keyed the way the app keys it: `group/name`, extension dropped. That id is what
 *  a `ref` names, what the picker reports, and what the curation lists are written in, so a
 *  suite comparing against any of those reads the library through this. */
export function libraryEntries(): SheetRefEntry[] {
  return loadLibrary().map(({ file, doc }) => ({ path: file.replace(/\.json$/, ''), doc }));
}

/** Ref index over the whole curated library — what the web app builds from its bundled
 *  sheets; library goldens resolve against it. */
export const REFS: SheetRefIndex = buildSheetRefIndex(libraryEntries());

// The 4-D [l, vds, vsb, vgs] demo table shared by every golden; the 0.05 V vds step keeps
// declared operating points on-grid where goldens want to be tight.
//
// The body-bias sweep is there because the library uses it: a sheet that places a device's
// source above its body (an input pair on its tail node, a cascode on the node under it)
// declares that `vsb`, and a table without the axis would read the device body-grounded. The
// 0.05 V step raises the threshold by BODY_FACTOR × 0.05 V = 10 mV per slice, which is the vgs
// step, so each slice is the body-grounded one moved along vgs by whole grid steps. A body bias
// that falls ON a slice is therefore read to the grid's own precision, and most of the node
// levels the library types (0.3, 0.4, 0.45, 0.55 V) do. One between two slices — a tail node
// the engine solved — is interpolated, which a golden that hinges on it sees as up to about
// 0.2 mV of gate voltage. Both ranges reach past everything the library asks for, at its
// defaults and at every range end: the largest body bias is 0.76 V (the folded cascode's input
// pair at the top of its common-mode range) and the largest drain-source voltage 1.19 V (the
// current-mirror OTA's PMOS output device whose drain is the NMOS diode's node,
// one diode drop above ground under a 1.8 V supply). A library test holds the table to that.
export const table = generateDemoDevice({
  vds: { min: 0, max: 1.2, step: 0.05 },
  vsb: { min: 0, max: 0.9, step: 0.05 },
});

/** Output-device r_o of a width-mirrored leg, in closed form. The reference sets the saturation
 *  current idSat_ref = I_in/(1 + vds_ref/VA); the output device copies the same current density at
 *  K times the width, and gds = idSat/VA in the demo model, so the vds the OUTPUT device sits at
 *  cancels out entirely. For a diode reference vds_ref is its own solved drop, read from the
 *  result the way the mirror goldens read it. The mirror sheets all size at L = 1 µm. */
export const roMirrored = (vdsRef: number, K: number, iIn: number): number =>
  1 / gdsOf(K * iIn, 1e-6, vdsRef);

/** An output node where a driver and its load carry the same current at the same L and the same
 *  |vds|: both gds are equal, so the node is half of one device's r_o. Pinning it alongside
 *  Av = gm·Rout says the interface equation added a name and no arithmetic. */
export const stage2Rout = (I: number, L: number, vds: number): number => 1 / (2 * gdsOf(I, L, vds));

/** γ-model input-referred thermal density sqrt(4kTγ/gm) at the demo's γ = GAMMA_DEFAULT. */
export const vnthM = (gm: number): number => Math.sqrt((4 * PHYS.k * PHYS.T * GAMMA_DEFAULT) / gm);

/** Body transconductance of the demo model — exact at every point (see src/demo/index.ts). */
export const gmbOf = (gm: number): number => BODY_FACTOR * gm;

/** Gate capacitance of the demo model at a sized width: cgg = W·L·Cox, exact at every
 *  operating point (the model gives cgg no bias dependence at all). The sized W is what the
 *  sizing lands on, so an input-capacitance golden pins the model relation and which device the
 *  equation reads — the width itself is the sizer's answer, like a solved vgs. */
export const cggOf = (W: number, L: number): number => W * L * COX;

// The gate-source voltage the demo model needs for a given gm/ID at L = 0.5 µm, from the EKV
// inversion gm/ID = sigmoid(x)/(n·UT·softplus(x)) with n = 1.3. Shared because a NODE LEVEL a
// sheet derives from one device's gate — rather than typing it — lands on exactly these
// numbers, so several goldens now hinge on the same few. The demo's gm/ID is independent of
// vds, so one constant per gm/ID is the whole story for a device whose source is at its body.
// One whose source sits above it needs BODY_FACTOR·vsb more — see vgsAtBody, and
// sourceNodeUnder for a node that is solved from such a gate.
export const VGS_GMID8_L05 = 0.668042;
export const VGS_GMID10_L05 = 0.610063;
export const VGS_GMID12_L05 = 0.567023;
export const VGS_GMID14_L05 = 0.532095;

/** Gate-source voltage of a device whose source sits `vsb` above its body, from the value the
 *  same inversion level needs body-grounded. The demo model's threshold rises BODY_FACTOR·vsb and
 *  nothing else moves, so the whole vgs curve shifts by exactly that. */
export const vgsAtBody = (vgs0: number, vsb: number): number => vgs0 + BODY_FACTOR * vsb;

/** Where a node lands when it is solved to put a device's gate at `gate` and that node is the
 *  device's own source, body at ground: the node is then the body bias as well, so
 *  gate = V + vgs0 + BODY_FACTOR·V, and V = (gate − vgs0)/(1 + BODY_FACTOR). `vgs0` is the
 *  body-grounded gate-source voltage of the inversion level the device is sized at. */
export const sourceNodeUnder = (gate: number, vgs0: number): number =>
  (gate - vgs0) / (1 + BODY_FACTOR);
