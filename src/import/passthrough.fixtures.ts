// A demo table written out as mostab CSV with one column the namespace has no name for, then read
// back through the importer — the shape of a real export carrying an extra simulator output (here
// the effective channel mobility, `ueff`, which BSIM reports and the format does not name).
// Shared by the lookup, sizing and sheet suites, which each check that the column reaches them.
// Lives outside the vitest glob (not *.test.ts) so importing it never re-registers another file's
// tests, and is not exported from the barrel.

import { generateDemoDevice, toMostabCsv, withColumns } from '../demo';
import { importMostab } from './index';
import type { DeviceTable } from '../types';

/**
 * The pass-through column's value at a grid point: affine in every axis, so multilinear
 * interpolation reproduces it exactly anywhere inside the grid and a test can predict the value
 * between nodes in closed form.
 */
export function ueffAt(p: { l: number; vds: number; vgs: number }): number {
  return 0.04 - 0.01 * p.vgs + 0.002 * p.vds + 1e3 * p.l;
}

/** The demo device over (l, vds, vgs), as mostab CSV text, with extra columns `extra` computed
 *  per grid point from that point's axis coordinates. */
export function demoCsvWith(
  extra: Readonly<Record<string, (p: { l: number; vds: number; vgs: number }) => number>>,
): string {
  const t = generateDemoDevice({
    lengths: [0.18e-6, 0.5e-6, 1e-6],
    vds: { min: 0.3, max: 1.2, step: 0.3 },
  });
  // Every axis is also a full-length column, so a point's coordinates are one index across them.
  const q = t.grid.quantities;
  const [l, vds, vgs] = (['l', 'vds', 'vgs'] as const).map((a) => q.get(a) as Float64Array);
  const columns = Object.fromEntries(
    Object.entries(extra).map(([name, f]) => [
      name,
      Float64Array.from(vgs, (_, i) => f({ l: l[i], vds: vds[i], vgs: vgs[i] })),
    ]),
  );
  return toMostabCsv(withColumns({ ...t, id: { ...t.id, device: 'nmos_extra' } }, columns));
}

/** Import mostab CSV text that must import cleanly, returning its one table. */
export function importOne(csv: string): DeviceTable {
  const res = importMostab(csv, { filename: 'nmos_extra.mostab.csv' });
  if (!res.ok) throw new Error(res.errors.map((e) => e.message).join('; '));
  return res.dataset.tables[0];
}

/** The demo device imported with one pass-through column, `ueff` (see ueffAt). */
export const withUeff = (): DeviceTable => importOne(demoCsvWith({ ueff: ueffAt }));
