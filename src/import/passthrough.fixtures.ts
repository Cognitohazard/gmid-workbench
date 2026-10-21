// A demo table written out as mostab CSV with one column the namespace has no name for, then read
// back through the importer — the shape of a real export carrying an extra simulator output (here
// a drain-junction capacitance, `cjd`). Shared by the lookup, sizing and sheet suites, which each
// check that the column reaches them. Lives outside the vitest glob (not *.test.ts) so importing
// it never re-registers another file's tests, and is not exported from the barrel.

import { generateDemoDevice } from '../demo';
import { importMostab } from './index';
import type { DeviceTable } from '../types';

/**
 * The pass-through column's value at a grid point: affine in every axis, so multilinear
 * interpolation reproduces it exactly anywhere inside the grid and a test can predict the value
 * between nodes in closed form.
 */
export function cjdAt(p: { l: number; vds: number; vgs: number }): number {
  return 1e-15 + 2e-15 * p.vgs + 0.5e-15 * p.vds + 1e-9 * p.l;
}

/** The demo device over (l, vds, vgs), as mostab CSV text, with extra columns `extra` computed
 *  per row from the row's axis coordinates. */
export function demoCsvWith(
  extra: Readonly<Record<string, (p: { l: number; vds: number; vgs: number }) => number>>,
): string {
  const t = generateDemoDevice({
    lengths: [0.18e-6, 0.5e-6, 1e-6],
    vds: { min: 0.3, max: 1.2, step: 0.3 },
  });
  const axes = t.grid.axes;
  // makeGrid materializes each axis as a column too; those go out once, as axes.
  const cols = [...t.grid.quantities].filter(([k]) => !axes.some((a) => a.name === k));
  const extras = Object.entries(extra);
  const lines = [
    '# device: nmos_extra',
    '# corner: tt',
    '# temp: 27',
    `# W: ${t.meta.W}`,
    '# polarity: n',
    [...axes.map((a) => a.name), ...cols.map(([k]) => k), ...extras.map(([k]) => k)].join(','),
  ];
  const size = t.grid.shape.reduce((a, b) => a * b, 1);
  for (let flat = 0; flat < size; flat++) {
    // Row-major, last axis fastest: peel each axis index off the flat index from the back.
    const coord: Record<string, number> = {};
    let rest = flat;
    for (let d = axes.length - 1; d >= 0; d--) {
      const n = axes[d].values.length;
      coord[axes[d].name] = axes[d].values[rest % n];
      rest = Math.floor(rest / n);
    }
    const p = { l: coord.l, vds: coord.vds, vgs: coord.vgs };
    lines.push(
      [
        ...axes.map((a) => coord[a.name]),
        ...cols.map(([, col]) => col[flat]),
        ...extras.map(([, f]) => f(p)),
      ].join(','),
    );
  }
  return lines.join('\n');
}

/** Import mostab CSV text that must import cleanly, returning its one table. */
export function importOne(csv: string): DeviceTable {
  const res = importMostab(csv, { filename: 'nmos_extra.mostab.csv' });
  if (!res.ok) throw new Error(res.errors.map((e) => e.message).join('; '));
  return res.dataset.tables[0];
}

/** The demo device imported with one pass-through column, `cjd` (see cjdAt). */
export const withCjd = (): DeviceTable => importOne(demoCsvWith({ cjd: cjdAt }));
