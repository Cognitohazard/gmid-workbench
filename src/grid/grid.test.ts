import { describe, it, expect } from 'vitest';
import { makeGrid, flatIndex, interpolate, sliceGrid } from './index';
import type { Axis } from '../types';

const ax = (name: string, vals: number[]): Axis => ({
  name,
  values: Float64Array.from(vals),
});

describe('flatIndex', () => {
  it('is row-major (first axis slowest)', () => {
    expect(flatIndex([3, 4], [0, 0])).toBe(0);
    expect(flatIndex([3, 4], [0, 3])).toBe(3);
    expect(flatIndex([3, 4], [1, 0])).toBe(4);
    expect(flatIndex([3, 4], [2, 3])).toBe(11);
  });
});

describe('makeGrid', () => {
  it('validates column lengths against prod(shape)', () => {
    const q = new Map([['id', Float64Array.from([1, 2, 3])]]);
    expect(() => makeGrid([ax('vgs', [0, 0.5])], q)).toThrow();
  });

  it('materializes axis columns broadcast row-major', () => {
    // 2x3 grid over vgs (slow) and vds (fast)
    const id = Float64Array.from([0, 1, 2, 3, 4, 5]);
    const g = makeGrid([ax('vgs', [0, 1]), ax('vds', [0, 1, 2])], new Map([['id', id]]));
    expect([...g.shape]).toEqual([2, 3]);
    // vgs slowest: [0,0,0,1,1,1]; vds fastest: [0,1,2,0,1,2]
    expect([...g.quantities.get('vgs')!]).toEqual([0, 0, 0, 1, 1, 1]);
    expect([...g.quantities.get('vds')!]).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('returns a frozen grid', () => {
    const g = makeGrid([ax('vgs', [0, 1])], new Map([['id', Float64Array.from([0, 1])]]));
    expect(Object.isFrozen(g)).toBe(true);
  });
});

describe('interpolate 1-D linear', () => {
  // id = 2*vgs over vgs in {0,1,2,3}
  const g = makeGrid([ax('vgs', [0, 1, 2, 3])], new Map([['id', Float64Array.from([0, 2, 4, 6])]]));

  it('is exact at nodes', () => {
    expect(interpolate(g, { vgs: 0 }).id).toBeCloseTo(0, 12);
    expect(interpolate(g, { vgs: 2 }).id).toBeCloseTo(4, 12);
    expect(interpolate(g, { vgs: 3 }).id).toBeCloseTo(6, 12);
  });

  it('is exact at a midpoint', () => {
    expect(interpolate(g, { vgs: 1.5 }).id).toBeCloseTo(3, 12);
    expect(interpolate(g, { vgs: 0.25 }).id).toBeCloseTo(0.5, 12);
  });

  it('clamps beyond edges', () => {
    expect(interpolate(g, { vgs: -5 }).id).toBeCloseTo(0, 12);
    expect(interpolate(g, { vgs: 99 }).id).toBeCloseTo(6, 12);
  });

  it('also interpolates the materialized axis column', () => {
    expect(interpolate(g, { vgs: 1.5 }).vgs).toBeCloseTo(1.5, 12);
  });

  it('uses first axis value when an axis is missing from point', () => {
    expect(interpolate(g, {}).id).toBeCloseTo(0, 12);
  });
});

describe('interpolate 2-D bilinear', () => {
  // f(vgs,vds) = 10*vgs + vds, vgs in {0,1}, vds in {0,2}
  // samples row-major: (0,0)=0 (0,2)=2 (1,0)=10 (1,2)=12
  const g = makeGrid(
    [ax('vgs', [0, 1]), ax('vds', [0, 2])],
    new Map([['f', Float64Array.from([0, 2, 10, 12])]]),
  );

  it('is exact at a node', () => {
    expect(interpolate(g, { vgs: 1, vds: 2 }).f).toBeCloseTo(12, 12);
    expect(interpolate(g, { vgs: 0, vds: 2 }).f).toBeCloseTo(2, 12);
  });

  it('is exact at the center', () => {
    // center: vgs=0.5, vds=1 -> 10*0.5 + 1 = 6
    expect(interpolate(g, { vgs: 0.5, vds: 1 }).f).toBeCloseTo(6, 12);
  });

  it('clamps both axes beyond edges', () => {
    expect(interpolate(g, { vgs: -1, vds: -1 }).f).toBeCloseTo(0, 12);
    expect(interpolate(g, { vgs: 5, vds: 5 }).f).toBeCloseTo(12, 12);
  });

  it('selects only requested keys', () => {
    const r = interpolate(g, { vgs: 0.5, vds: 1 }, ['f']);
    expect(Object.keys(r)).toEqual(['f']);
  });
});

describe('sliceGrid', () => {
  // f(vgs,vds) = 10*vgs + vds, vgs in {0,1}, vds in {0,2}
  const g = makeGrid(
    [ax('vgs', [0, 1]), ax('vds', [0, 2])],
    new Map([['f', Float64Array.from([0, 2, 10, 12])]]),
  );

  it('drops the fixed axis, keeping the remaining one', () => {
    const s = sliceGrid(g, { vds: 1 });
    expect(s.axes.map((a) => a.name)).toEqual(['vgs']);
    expect([...s.shape]).toEqual([2]);
    // f(vgs, vds=1) = 10*vgs + 1 -> at vgs=0 -> 1, vgs=1 -> 11
    expect([...s.quantities.get('f')!]).toEqual([1, 11]);
    // remaining axis re-materialized
    expect([...s.quantities.get('vgs')!]).toEqual([0, 1]);
    // fixed axis column is gone
    expect(s.quantities.has('vds')).toBe(false);
  });

  it('matches interpolate over the remaining axis', () => {
    const s = sliceGrid(g, { vds: 1 });
    for (const vgs of [0, 0.25, 0.5, 0.75, 1]) {
      const sliced = interpolate(s, { vgs }).f;
      const full = interpolate(g, { vgs, vds: 1 }).f;
      expect(sliced).toBeCloseTo(full, 12);
    }
  });

  it('clamps the fixed coordinate before slicing', () => {
    const s = sliceGrid(g, { vds: 99 }); // clamps to vds=2
    // f(vgs, vds=2) = 10*vgs + 2 -> [2, 12]
    expect([...s.quantities.get('f')!]).toEqual([2, 12]);
  });
});
