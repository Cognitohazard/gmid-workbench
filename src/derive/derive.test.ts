import { describe, it, expect } from 'vitest';
import { derive, deriveColumn, compileExpr, evalColumn, tableScope, metaScalars } from './index';
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

  it('resolves a supplied scalar (current density id/w via width); a stored column wins', () => {
    const axes: Axis[] = [{ name: 'vgs', values: Float64Array.from([0, 0.5, 1]) }];
    const id = Float64Array.from([1, 2, 3]);
    const grid = makeGrid(axes, new Map([['id', id]]));
    // Without a scalar `w` is unresolved; with one, id/w (current density) evaluates.
    expect(tableScope(grid).resolve('w')).toBeUndefined();
    expect(Array.from(evalColumn(grid, compileExpr('id/w'), { w: 2 }))).toEqual([0.5, 1, 1.5]);
    // A stored `w` column shadows the scalar (data always wins).
    const grid2 = makeGrid(
      axes,
      new Map([
        ['id', id],
        ['w', Float64Array.from([10, 10, 10])],
      ]),
    );
    expect(Array.from(evalColumn(grid2, compileExpr('id/w'), { w: 2 }))).toEqual([0.1, 0.2, 0.3]);
  });

  it('metaScalars exposes characterization width W as w (and only when finite)', () => {
    expect(metaScalars({ W: 5e-6 } as never)).toEqual({ w: 5e-6 });
    expect(metaScalars({} as never)).toEqual({});
    expect(metaScalars({ W: Number.NaN } as never)).toEqual({});
  });

  it('resolves derived quantity names by evaluating their definition', () => {
    const { grid } = generateDemoDevice();
    const scope = tableScope(grid);
    const gm = col(grid, 'gm');
    const id = col(grid, 'id');
    const ft = scope.resolve('ft') as Float64Array; // gm/(2*pi*cgg)
    const cgg = col(grid, 'cgg');
    expect(ft).toBeInstanceOf(Float64Array);
    expect(ft[10]).toBeCloseTo(gm[10] / (2 * Math.PI * cgg[10]), 18);
    // usable inside a larger expression, not just as a bare lookup
    const expr = deriveColumn(grid, 'gm_id * 2'); // gm_id is a derived name
    expect(expr[10]).toBeCloseTo((gm[10] / id[10]) * 2, 12);
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

  it('compileExpr + evalColumn evaluate a precompiled expression (compile once)', () => {
    const { grid } = generateDemoDevice();
    const compiled = compileExpr('gm/id');
    const out = evalColumn(grid, compiled);
    const gm = col(grid, 'gm');
    const id = col(grid, 'id');
    expect(out.length).toBe(gm.length);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(gm[i] / id[i], 12);
    // same compiled expr reused over another grid yields that grid's column
    const dev2 = generateDemoDevice({ W: 5e-6 });
    expect(evalColumn(dev2.grid, compiled).length).toBe(dev2.grid.shape[0] * dev2.grid.shape[1]);
  });
});
