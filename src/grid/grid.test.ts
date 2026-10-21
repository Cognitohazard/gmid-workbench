import { describe, it, expect } from 'vitest';
import {
  bracketGrid,
  diodeGrid,
  makeGrid,
  flatIndex,
  interpolate,
  offHull,
  sliceGrid,
} from './index';
import { generateDemoDevice } from '../demo';
import type { Axis, Grid } from '../types';

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

describe('offHull', () => {
  it('is the range plus float rounding on a swept axis', () => {
    const vsb = [0, 0.3, 0.6];
    expect(offHull(vsb, 0.3)).toBe(false);
    expect(offHull(vsb, 0)).toBe(false);
    // 0.3 - (0.1 + 0.2) lands a few ULP below zero: still the first node.
    expect(0.3 - (0.1 + 0.2)).toBeLessThan(0);
    expect(offHull(vsb, 0.3 - (0.1 + 0.2))).toBe(false);
    expect(offHull(vsb, -1e-6)).toBe(true);
    expect(offHull(vsb, 0.61)).toBe(true);
    // The allowance is rounding, not closeness: a hundred-millionth of the span past an end is
    // off the axis, a ten-billionth is the end.
    expect(offHull(vsb, 0.6 + 6e-9)).toBe(true);
    expect(offHull(vsb, -6e-9)).toBe(true);
    expect(offHull(vsb, 0.6 + 6e-11)).toBe(false);
  });

  it('on an axis with one value, asks whether this is that value — at any magnitude', () => {
    // No span to scale the rounding allowance by, so the value's own size stands in: one ULP
    // off 3.3 is 4.4e-16, twice what one ULP off 0.3 is, and both are the value aimed at.
    expect(1.1 * 3).not.toBe(3.3);
    expect(offHull([3.3], 1.1 * 3)).toBe(false);
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(offHull([0.3], 0.1 + 0.2)).toBe(false);
    expect(offHull([-3.3], -(1.1 * 3))).toBe(false);
    // A length is some seven orders smaller than a volt: rounding is still rounding there, and
    // a length a fraction of a percent away is still a different length.
    expect(offHull([5e-7], 5e-7 * (1 + 1e-12))).toBe(false);
    expect(offHull([5e-7], 5.01e-7)).toBe(true);
    // Anything that is a different operating point is off it, on either side.
    expect(offHull([3.3], 3.301)).toBe(true);
    expect(offHull([3.3], 3.299)).toBe(true);
    expect(offHull([0], 1e-9)).toBe(true);
    expect(offHull([0], 0.3 - (0.1 + 0.2))).toBe(false);
  });
});

// ── sliceGrid as it was written before its corner weights and offsets were precomputed ──────────
// Kept verbatim (with makeGrid's axis materialization of the time) as the reference the current
// implementation must reproduce bit for bit.

function referenceLocate(values: Float64Array, x: number): { i: number; w: number } {
  const n = values.length;
  if (n === 1) return { i: 0, w: 0 };
  if (x <= values[0]) return { i: 0, w: 0 };
  if (x >= values[n - 1]) return { i: n - 2, w: 1 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= x) lo = mid;
    else hi = mid;
  }
  const i = lo;
  const span = values[i + 1] - values[i];
  const w = span === 0 ? 0 : (x - values[i]) / span;
  return { i, w };
}

function referenceMakeGrid(axes: Axis[], quantities: Map<string, Float64Array>): Grid {
  const shape = axes.map((a) => a.values.length);
  const total = shape.reduce((a, b) => a * b, 1);
  const merged = new Map(quantities);
  for (let dim = 0; dim < axes.length; dim++) {
    const col = new Float64Array(total);
    let stride = 1;
    for (let d = dim + 1; d < shape.length; d++) stride *= shape[d];
    const len = shape[dim];
    for (let i = 0; i < total; i++) col[i] = axes[dim].values[Math.floor(i / stride) % len];
    merged.set(axes[dim].name, col);
  }
  return { axes, shape, quantities: merged };
}

function referenceSliceGrid(grid: Grid, fixed: Record<string, number>): Grid {
  const fixedNames = new Set(Object.keys(fixed));
  const fixedLowers = new Map<number, number>();
  const fixedWeights = new Map<number, number>();
  for (let d = 0; d < grid.axes.length; d++) {
    const axis = grid.axes[d];
    if (fixedNames.has(axis.name)) {
      const { i, w } = referenceLocate(axis.values, fixed[axis.name]);
      fixedLowers.set(d, i);
      fixedWeights.set(d, w);
    }
  }
  const keepDims: number[] = [];
  const remainingAxes: Axis[] = [];
  for (let d = 0; d < grid.axes.length; d++) {
    if (!fixedLowers.has(d)) {
      keepDims.push(d);
      remainingAxes.push({ name: grid.axes[d].name, values: grid.axes[d].values });
    }
  }
  const remainingNames = new Set(remainingAxes.map((a) => a.name));
  const carryKeys = [...grid.quantities.keys()].filter(
    (k) => !fixedNames.has(k) && !remainingNames.has(k),
  );
  const remShape = remainingAxes.map((a) => a.values.length);
  const remTotal = remShape.reduce((a, b) => a * b, 1);
  const srcCols = carryKeys.map((k) => grid.quantities.get(k)!);
  const dstCols = carryKeys.map(() => new Float64Array(remTotal));
  const remIdx = new Array<number>(keepDims.length);
  const fullIdx = new Array<number>(grid.axes.length);
  const fixedDims = [...fixedLowers.keys()];
  const corners = 1 << fixedDims.length;
  const acc = new Float64Array(srcCols.length);
  for (let r = 0; r < remTotal; r++) {
    let rem = r;
    for (let k = keepDims.length - 1; k >= 0; k--) {
      remIdx[k] = rem % remShape[k];
      rem = Math.floor(rem / remShape[k]);
    }
    for (let k = 0; k < keepDims.length; k++) fullIdx[keepDims[k]] = remIdx[k];
    acc.fill(0);
    for (let corner = 0; corner < corners; corner++) {
      let cw = 1;
      for (let f = 0; f < fixedDims.length; f++) {
        const d = fixedDims[f];
        const high = (corner >> f) & 1;
        const w = fixedWeights.get(d)!;
        const len = grid.shape[d];
        if (high) {
          cw *= len > 1 ? w : 0;
          fullIdx[d] = len > 1 ? fixedLowers.get(d)! + 1 : fixedLowers.get(d)!;
        } else {
          cw *= len > 1 ? 1 - w : 1;
          fullIdx[d] = fixedLowers.get(d)!;
        }
      }
      if (cw === 0) continue;
      const flat = flatIndex(grid.shape, fullIdx);
      for (let c = 0; c < srcCols.length; c++) acc[c] += cw * srcCols[c][flat];
    }
    for (let c = 0; c < dstCols.length; c++) dstCols[c][r] = acc[c];
  }
  return referenceMakeGrid(remainingAxes, new Map(carryKeys.map((k, c) => [k, dstCols[c]])));
}

/** The first index at which two columns differ in any bit (NaN payloads and the sign of zero
 *  included), or -1 when they are identical; -2 when their lengths differ. */
function firstBitDifference(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) return -2;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return Math.floor(i / 8);
  return -1;
}

/** Two grids hold the same axes, the same columns in the same order, and the same bits. */
function expectBitIdentical(got: Grid, want: Grid): void {
  expect(got.axes.map((a) => a.name)).toEqual(want.axes.map((a) => a.name));
  got.axes.forEach((a, d) => expect(firstBitDifference(a.values, want.axes[d].values)).toBe(-1));
  expect([...got.shape]).toEqual([...want.shape]);
  expect([...got.quantities.keys()]).toEqual([...want.quantities.keys()]);
  for (const [key, col] of want.quantities)
    expect({ key, at: firstBitDifference(got.quantities.get(key)!, col) }).toEqual({ key, at: -1 });
}

// The library's 4-D demo table: l × vds × vsb × vgs, every quantity column a real curve.
const demo = generateDemoDevice({
  vds: { min: 0, max: 1.2, step: 0.05 },
  vsb: { min: 0, max: 0.9, step: 0.05 },
}).grid;

describe('sliceGrid reproduces its earlier implementation bit for bit', () => {
  it('4-D to 3-D: one axis between nodes, on a node, and past each end', () => {
    expect(demo.axes.map((a) => a.name)).toEqual(['l', 'vds', 'vsb', 'vgs']);
    const cases: Record<string, number>[] = [
      { vds: 0.4321 },
      { vds: 0.45 },
      { vds: -1 },
      { vds: 7 },
      { l: 7.7e-7 },
    ];
    for (const fixed of cases)
      expectBitIdentical(sliceGrid(demo, fixed), referenceSliceGrid(demo, fixed));
  });

  it('4-D to 1-D: three axes at once, between nodes and on them', () => {
    for (const fixed of [
      { l: 7.7e-7, vds: 0.4321, vsb: 0.123 },
      { l: 5e-7, vds: 0.4321, vsb: 0.3 },
      { l: 2e-6, vds: 1.2, vsb: 0 },
      { l: 1e-9, vds: 0.61, vsb: 0.95 },
    ])
      expectBitIdentical(sliceGrid(demo, fixed), referenceSliceGrid(demo, fixed));
  });

  it('4-D to 2-D, and a name that is no axis drops that column as before', () => {
    expectBitIdentical(
      sliceGrid(demo, { vds: 0.4321, vsb: 0.123 }),
      referenceSliceGrid(demo, { vds: 0.4321, vsb: 0.123 }),
    );
    const folded = diodeGrid(demo).grid; // vds survives as a column, no longer an axis
    expectBitIdentical(sliceGrid(folded, { vds: 0.4 }), referenceSliceGrid(folded, { vds: 0.4 }));
  });
});

describe('bracketGrid', () => {
  const lengths = [1.8e-7, 5e-7, 1e-6, 2e-6];
  const asked = [1e-7, 1.8e-7, 3e-7, 5e-7, 7.7e-7, 1e-6, 1.999e-6, 2e-6, 5e-6];

  it('keeps the one length node a length reads, or the two around it', () => {
    expect([...demo.axes[0].values]).toEqual(lengths);
    const kept = (L: number): number[] => [...bracketGrid(demo, 'l', L).axes[0].values];
    expect(kept(1e-7)).toEqual([1.8e-7]); // clamped to the first node
    expect(kept(1.8e-7)).toEqual([1.8e-7]);
    expect(kept(3e-7)).toEqual([1.8e-7, 5e-7]);
    expect(kept(5e-7)).toEqual([5e-7]);
    expect(kept(2e-6)).toEqual([2e-6]); // the last node, read with all its weight on it
    expect(kept(5e-6)).toEqual([2e-6]); // clamped to the last node
    const g = bracketGrid(demo, 'l', 3e-7);
    expect([...g.shape]).toEqual([2, ...demo.shape.slice(1)]);
    expect([...g.quantities.keys()]).toEqual([...demo.quantities.keys()]);
  });

  it('cuts the first axis by viewing the source columns, and any other by copying', () => {
    const g = bracketGrid(demo, 'l', 7.7e-7);
    for (const [key, col] of g.quantities)
      expect(col.buffer).toBe(demo.quantities.get(key)!.buffer);
    const v = bracketGrid(demo, 'vsb', 0.123);
    expect(v.quantities.get('id')!.buffer).not.toBe(demo.quantities.get('id')!.buffer);
    expect(bracketGrid(demo, 'temp', 1)).toBe(demo);
  });

  it('changes no number a slice or a point read at that length gives', () => {
    for (const L of asked) {
      const cut = bracketGrid(demo, 'l', L);
      // The sheet engine's order: the bias axes on the cut table, then the length.
      const chained = (g: Grid): Grid =>
        sliceGrid(sliceGrid(sliceGrid(g, { vds: 0.4321 }), { vsb: 0.123 }), { l: L });
      expectBitIdentical(chained(cut), chained(demo));
      expectBitIdentical(
        sliceGrid(diodeGrid(cut).grid, { l: L }),
        sliceGrid(diodeGrid(demo).grid, { l: L }),
      );
      const at = { l: L, vds: 0.4321, vsb: 0.123, vgs: 0.537 };
      const got = interpolate(cut, at);
      const want = interpolate(demo, at);
      for (const key of Object.keys(want))
        expect([key, Object.is(got[key], want[key])]).toEqual([key, true]);
    }
    // Cutting an axis that is not the first changes nothing either.
    const v = bracketGrid(demo, 'vsb', 0.123);
    expectBitIdentical(sliceGrid(v, { vsb: 0.123 }), sliceGrid(demo, { vsb: 0.123 }));
  });
});
