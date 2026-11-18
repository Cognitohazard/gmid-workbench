// The second synthetic device at its default grid, built once for the suites that read it. Its
// own file, outside the vitest glob, so a suite that does not import it never pays for it: the
// full grid is about 560 thousand points (4 lengths × 37 vds × 21 vsb × 181 vgs), some 63 MB
// across its fourteen columns, axes included.

import { generateEkvDevice } from './ekv';
import { signedMirrorDemo } from './index';
import type { DeviceTable } from '../types';

let nmos: DeviceTable | undefined;
let pmos: DeviceTable | undefined;

/** The n-type table at the default grid, built on first use and shared after. */
export function ekvTable(): DeviceTable {
  return (nmos ??= generateEkvDevice());
}

/** The p-type table: the n-type one with vgs and vds negated, as the simpler device's is. */
export function ekvTableP(): DeviceTable {
  return (pmos ??= signedMirrorDemo(ekvTable()));
}
