import { describe, it, expect } from 'vitest';
import { derive, deriveColumn, tableScope } from './index';
import type { Axis, Grid } from '../types';
import { generateDemoDevice } from '../demo';
import { makeGrid } from '../grid';
import { UT } from '../constants';

function col(grid: Grid, key: string): Float64Array {
  const c = grid.quantities.get(key);
  if (!c) throw new Error(`missing column ${key}`);
  return c;
}

describe('tableScope', () => {
  it('resolves stored quantities to full columns', () => {
    const { grid } = generateDemoDevice();
    const scope = tableScope(grid);
    const size = grid.shape[0] * grid.shape[1];

    for (const key of ['id', 'gm', 'gds', 'cgg', 'vth', 'vdsat']) {
      const v = scope.resolve(key);
      expect(v).toBeInstanceOf(Float64Array);
      expect((v as Float64Array).length).toBe(size);
    }
  });

  it('resolves materialized axis columns from a real makeGrid grid', () => {
    // makeGrid materializes each axis as a same-named full-length column.
    const axes: Axis[] = [
      { name: 'l', values: Float64Array.from([1e-6, 2e-6]) },
      { name: 'vgs', values: Float64Array.from([0, 0.5, 1.0]) },
    ];
    const id = Float64Array.from([1, 2, 3, 4, 5, 6]);
    const grid = makeGrid(axes, new Map([['id', id]]));
    const scope = tableScope(grid);
    const size = 6;

    for (const ax of ['l', 'vgs', 'id']) {
      const v = scope.resolve(ax);
      expect(v).toBeInstanceOf(Float64Array);
      expect((v as Float64Array).length).toBe(size);
    }
    // l varies slowest: [1,1,1, 2,2,2] over the 2×3 grid.
    expect(Array.from(scope.resolve('l') as Float64Array)).toEqual([
      1e-6, 1e-6, 1e-6, 2e-6, 2e-6, 2e-6,
    ]);
  });

  it('returns undefined for unknown names', () => {
    const { grid } = generateDemoDevice();
    expect(tableScope(grid).resolve('does_not_exist')).toBeUndefined();
  });
});

describe('derive', () => {
  it('gm_id equals elementwise gm/id', () => {
    const table = generateDemoDevice();
    const out = derive(table, 'gm_id');
    const gm = col(table.grid, 'gm');
    const id = col(table.grid, 'id');

    expect(out).toBeInstanceOf(Float64Array);
    expect(out.length).toBe(gm.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(gm[i] / id[i], 12);
    }
  });

  it('vstar equals 2*id/gm', () => {
    const table = generateDemoDevice();
    const out = derive(table, 'vstar');
    const gm = col(table.grid, 'gm');
    const id = col(table.grid, 'id');

    expect(out.length).toBe(gm.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo((2 * id[i]) / gm[i], 12);
    }
  });

  it('av0 equals gm/gds', () => {
    const table = generateDemoDevice();
    const out = derive(table, 'av0');
    const gm = col(table.grid, 'gm');
    const gds = col(table.grid, 'gds');
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(gm[i] / gds[i], 6);
    }
  });

  it('throws on an unknown derived key', () => {
    const table = generateDemoDevice();
    expect(() => derive(table, 'not_a_quantity')).toThrow(/unknown derived quantity/);
  });
});

describe('deriveColumn', () => {
  it('matches a manual elementwise gm*gds', () => {
    const { grid } = generateDemoDevice();
    const out = deriveColumn(grid, 'gm*gds');
    const gm = col(grid, 'gm');
    const gds = col(grid, 'gds');

    expect(out).toBeInstanceOf(Float64Array);
    expect(out.length).toBe(gm.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(gm[i] * gds[i], 18);
    }
  });

  it('broadcasts a scalar expression into a full-length column', () => {
    const { grid } = generateDemoDevice();
    const size = grid.shape[0] * grid.shape[1];
    const out = deriveColumn(grid, '2*pi');
    expect(out.length).toBe(size);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(2 * Math.PI, 12);
    }
  });

  it('resolves constants (UT) alongside grid columns', () => {
    const { grid } = generateDemoDevice();
    const out = deriveColumn(grid, 'gm/id * UT');
    const gm = col(grid, 'gm');
    const id = col(grid, 'id');
    expect(out.length).toBe(gm.length);
    expect(out[10]).toBeCloseTo((gm[10] / id[10]) * UT, 12);
  });
});
