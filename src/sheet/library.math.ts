// Closed forms of the demo model, and the tolerance convention the goldens compare against.
// Split out of library.fixtures.ts (which re-exports them) so a suite needing one arithmetic
// helper does not import the fixtures' eager work — walking sheets/ off disk and generating a
// demo table. Pure, side-effect-free, and outside the vitest glob.

import { VA_PER_L } from '../demo';

/** Relative error against an expected value — the tolerance convention every golden states. */
export const relErr = (v: number, expected: number): number => Math.abs(v / expected - 1);

/** Two resistances in parallel — the shape half the library's output-node rows take. */
export const par = (a: number, b: number): number => 1 / (1 / a + 1 / b);

/** Early voltage of the demo model at length `L`. */
export const va = (L: number): number => VA_PER_L * L;

/** gds of a device bound to current `id` at length `L`, declared vds — exact in the model
 *  once bound, since gds/id = 1/(VA + vds) there. The one spelling of the demo's
 *  channel-length-modulation law; every output-node golden goes through it. */
export const gdsOf = (id: number, L: number, vds: number): number => id / (va(L) + vds);
