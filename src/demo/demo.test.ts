import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from './index';
import type { Grid } from '../types';
import { UT } from '../constants';

function col(grid: Grid, key: string): Float64Array {
  const c = grid.quantities.get(key);
  if (!c) throw new Error(`missing column ${key}`);
  return c;
}

describe('generateDemoDevice', () => {
  it('produces a grid whose shape is lengths × vgs', () => {
    const lengths = [0.18e-6, 0.5e-6, 1e-6, 2e-6];
    const vgs = { min: 0.0, max: 1.2, step: 0.01 };
    const dev = generateDemoDevice({ lengths, vgs });

    const nVgs = Math.round((vgs.max - vgs.min) / vgs.step) + 1; // 121
    expect(dev.grid.shape).toEqual([lengths.length, nVgs]);
    expect(dev.grid.axes.map((a) => a.name)).toEqual(['l', 'vgs']);
    expect(dev.grid.axes[0].values.length).toBe(lengths.length);
    expect(dev.grid.axes[1].values.length).toBe(nVgs);

    const size = lengths.length * nVgs;
    for (const key of ['id', 'gm', 'gds', 'cgg', 'vth', 'vdsat']) {
      expect(col(dev.grid, key).length).toBe(size);
    }
  });

  it('defaults require no inputs', () => {
    const dev = generateDemoDevice();
    expect(dev.grid.shape).toEqual([4, 121]);
    expect(dev.meta.W).toBe(10e-6);
    expect(dev.id.device).toBe('nmos_demo');
  });

  it('keeps every column finite with id > 0', () => {
    const dev = generateDemoDevice();
    for (const key of ['id', 'gm', 'gds', 'cgg', 'vth', 'vdsat']) {
      const c = col(dev.grid, key);
      for (let i = 0; i < c.length; i++) {
        expect(Number.isFinite(c[i])).toBe(true);
      }
    }
    const id = col(dev.grid, 'id');
    for (let i = 0; i < id.length; i++) expect(id[i]).toBeGreaterThan(0);
  });

  it('has id strictly increasing with vgs at fixed L', () => {
    const dev = generateDemoDevice();
    const id = col(dev.grid, 'id');
    const [nL, nVgs] = dev.grid.shape;
    for (let li = 0; li < nL; li++) {
      for (let vi = 1; vi < nVgs; vi++) {
        const prev = id[li * nVgs + vi - 1];
        const cur = id[li * nVgs + vi];
        expect(cur).toBeGreaterThan(prev);
      }
    }
  });

  it('has physical gm/id: peak near 1/(n·UT) and a sane floor', () => {
    const dev = generateDemoDevice();
    const id = col(dev.grid, 'id');
    const gm = col(dev.grid, 'gm');

    let maxGmId = -Infinity;
    let minGmId = Infinity;
    for (let i = 0; i < id.length; i++) {
      const r = gm[i] / id[i];
      if (r > maxGmId) maxGmId = r;
      if (r < minGmId) minGmId = r;
    }

    // Weak-inversion ceiling ~ 1/(n·UT) ≈ 1/(1.3·0.0259) ≈ 29.7 V^-1.
    const ceiling = 1 / (1.3 * UT);
    expect(maxGmId).toBeLessThanOrEqual(40);
    expect(maxGmId).toBeGreaterThanOrEqual(10);
    expect(maxGmId).toBeLessThanOrEqual(ceiling + 1e-6);
    // gm/id falls in strong inversion, so the minimum sits well below the peak.
    expect(minGmId).toBeLessThan(maxGmId);
    expect(minGmId).toBeGreaterThan(0);
  });

  it('is deterministic for identical options', () => {
    const a = generateDemoDevice({ W: 5e-6 });
    const b = generateDemoDevice({ W: 5e-6 });
    const ida = col(a.grid, 'id');
    const idb = col(b.grid, 'id');
    expect(Array.from(ida)).toEqual(Array.from(idb));
  });

  it('respects a custom vgs sweep and width', () => {
    const dev = generateDemoDevice({
      lengths: [1e-6],
      vgs: { min: 0, max: 1, step: 0.1 },
      W: 20e-6,
    });
    expect(dev.grid.shape).toEqual([1, 11]);
    expect(dev.meta.W).toBe(20e-6);
    // cgg ∝ W·L·Cox = 20e-6 · 1e-6 · 0.01 = 2e-13 F, constant along vgs.
    const cgg = col(dev.grid, 'cgg');
    for (let i = 0; i < cgg.length; i++) {
      expect(cgg[i]).toBeCloseTo(20e-6 * 1e-6 * 0.01, 18);
    }
  });
});
