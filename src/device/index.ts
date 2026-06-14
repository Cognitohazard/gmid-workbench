// bind-any-2 device sizing. Given any two of {gm, gm/ID, ID} plus a channel
// length L, recover the third via gm = (gm/ID)·ID, place the operating point on
// the table at the (gm/ID, L) coordinate (inverse lookup), and size the width
// from the current density id/w. The gm/ID ceiling at the L-slice gates
// feasibility. Pure, deterministic, zero DOM imports.

import type { DeviceTable } from '../types';
import { lookup, lookupByGmId } from '../lookup';
import { sliceGrid } from '../grid';

/**
 * A sizing query: a table and length L, plus EXACTLY two of {gm, gm_id, id}. The
 * third is derived from gm = gm_id * id.
 */
export interface SizeQuery {
  table: DeviceTable;
  L: number;
  gm?: number;
  gm_id?: number;
  id?: number;
}

/** A solved operating point with the sized width and feasibility against the slice ceiling. */
export interface SizeResult {
  gm: number;
  gm_id: number;
  id: number;
  W: number;
  vgs: number;
  feasible: boolean;
  ceiling: number;
  /** Every base + derived quantity reported by the forward lookup at the point. */
  quantities: Record<string, number>;
}

/**
 * Solve the third of {gm, gm_id, id} from the two that are supplied, using the
 * single relation gm = gm_id * id. Throws unless EXACTLY two are present.
 */
function bindThree(q: SizeQuery): { gm: number; gm_id: number; id: number } {
  const has = {
    gm: q.gm !== undefined,
    gm_id: q.gm_id !== undefined,
    id: q.id !== undefined,
  };
  const count = (has.gm ? 1 : 0) + (has.gm_id ? 1 : 0) + (has.id ? 1 : 0);
  if (count !== 2) {
    throw new Error(
      `sizeDevice: require EXACTLY two of {gm, gm_id, id}; got ${count} ` +
        `(gm=${q.gm}, gm_id=${q.gm_id}, id=${q.id})`,
    );
  }

  if (has.gm && has.id) {
    const gm = q.gm as number;
    const id = q.id as number;
    return { gm, gm_id: gm / id, id };
  }
  if (has.gm_id && has.id) {
    const gm_id = q.gm_id as number;
    const id = q.id as number;
    return { gm: gm_id * id, gm_id, id };
  }
  // has.gm && has.gm_id
  const gm = q.gm as number;
  const gm_id = q.gm_id as number;
  return { gm, gm_id, id: gm / gm_id };
}

/**
 * Maximum gm/ID over the fixed-L slice — the weak-inversion ceiling the device
 * cannot physically exceed. Computed elementwise from the slice's gm and id
 * columns so it reflects exactly the data, not a model assumption.
 */
function gmIdCeiling(table: DeviceTable, L: number): number {
  const slice = sliceGrid(table.grid, { l: L });
  const gm = slice.quantities.get('gm');
  const id = slice.quantities.get('id');
  if (!gm || !id) {
    throw new Error('sizeDevice: slice is missing gm and/or id columns for the ceiling');
  }
  let max = -Infinity;
  for (let i = 0; i < gm.length; i++) {
    const r = gm[i] / id[i];
    if (r > max) max = r;
  }
  return max;
}

/**
 * Size a device by binding any two of {gm, gm/ID, ID} at a chosen length L.
 *
 * The two supplied quantities fix the third (gm = gm/ID · ID). The (gm/ID, L)
 * coordinate is inverted to a vgs via the table, the forward lookup at that point
 * yields the characterization-width operating point, and the width is scaled from
 * the current density id_w = id_char / W_char so the device delivers the target
 * ID: W = id / id_w. Feasibility is gm/ID <= the slice ceiling.
 */
export function sizeDevice(q: SizeQuery): SizeResult {
  const { gm, gm_id, id } = bindThree(q);
  const L = q.L;

  const ceiling = gmIdCeiling(q.table, L);
  const feasible = gm_id <= ceiling;

  // Invert (gm/ID, L) -> vgs, then read the full operating point at that point.
  const point = lookupByGmId(q.table, gm_id, L);
  const vgs = point.vgs;

  // Current density at the characterization width. The grid carries no `w`
  // column, so derive it from the table's characterization width metadata.
  const Wchar = q.table.meta.W;
  if (Wchar === undefined || !(Wchar > 0)) {
    throw new Error('sizeDevice: table.meta.W (characterization width) is required to size W');
  }
  const idChar = point.id;
  const id_w = idChar / Wchar; // current per unit width [A/m]
  const W = id / id_w;

  // Report the operating point's quantities, augmented with the bound targets and
  // the sized current density (id_w is not in the grid because there is no w col).
  const quantities: Record<string, number> = {
    ...lookup(q.table, { l: L, vgs }),
    id_w,
    gm,
    gm_id,
    id,
    W,
  };

  return { gm, gm_id, id, W, vgs, feasible, ceiling, quantities };
}
