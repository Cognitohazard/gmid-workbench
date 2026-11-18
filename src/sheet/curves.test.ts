// The curves of a sheet's named results across a sweep: each equation's value at every sample of a
// one-parameter sweep, and one asked-for equation at every cell of a two-parameter map — a gap
// wherever the sample does not determine it.
import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import { runSheet, sweepSheet, sweepSheet2, withParams } from './index';
import type { SheetDoc } from './types';

const dev = generateDemoDevice({
  vds: { min: 0, max: 1.2, step: 0.05 },
  vsb: { min: 0, max: 0.4, step: 0.05 },
});

/** One device at a drain voltage `VD`, with an equation that reads the device (`gain`) and one
 *  that reads only params (`room`). */
const device: SheetDoc = {
  title: 'one device',
  polarity: 'n',
  formatVersion: 2,
  nodes: 'none',
  params: [
    { name: 'VD', value: 0.6, unit: 'V', min: 0.2, max: 1.5, role: 'choice', class: 'independent' },
    { name: 'gm_id', value: 12, min: 6, max: 18, role: 'choice' },
    { name: 'VDD', value: 1.8, unit: 'V' },
  ],
  givens: { L: '0.5u', gm_id: 'gm_id', id: '20u', vds: 'VD', vsb: '0' },
  equations: [
    { name: 'gain', expr: 'gm/gds', unit: 'V/V' },
    { name: 'room', expr: 'VDD - VD', unit: 'V' },
  ],
  checks: [{ id: 'gain-spec', kind: 'spec', lhs: 'gain', op: '>=', rhs: '10' }],
};

describe('a one-parameter sweep', () => {
  const sw = sweepSheet(device, 'VD', dev, 14);

  it('keeps every equation of the sheet, in order, with its unit, one value per sample', () => {
    expect(sw.values.map((c) => [c.name, c.unit])).toEqual([
      ['gain', 'V/V'],
      ['room', 'V'],
    ]);
    for (const c of sw.values) expect(c.y).toHaveLength(sw.x.length);
  });

  it('reads at each sample what the sheet evaluated there alone reads', () => {
    sw.x.forEach((x, i) => {
      if (sw.outside[i].length) return;
      const res = runSheet(withParams(device, { VD: x }), dev);
      expect(sw.values[0].y[i]).toBe(res.values.gain);
      expect(sw.values[1].y[i]).toBe(res.values.room);
    });
  });

  it('leaves a gap in every curve at a sample read beyond the table, and only there', () => {
    const beyond = sw.x.map((_, i) => sw.outside[i].length > 0);
    expect(beyond).toContain(true);
    expect(beyond).toContain(false);
    sw.x.forEach((x, i) => {
      for (const c of sw.values) {
        if (beyond[i]) expect(c.y[i], `${c.name} at ${x}`).toBeNull();
        else expect(Number.isFinite(c.y[i]), `${c.name} at ${x}`).toBe(true);
      }
    });
  });
});

describe('a two-parameter map', () => {
  it('keeps the one equation asked for at every cell, with a gap beyond the table', () => {
    const map = sweepSheet2(device, 'gm_id', 'VD', dev, 5, undefined, undefined, {
      value: 'gain',
    });
    expect(map.value?.name).toBe('gain');
    expect(map.value?.z).toHaveLength(map.y.length);
    let gaps = 0;
    map.y.forEach((vd, yi) =>
      map.x.forEach((gmId, xi) => {
        const z = map.value!.z[yi][xi];
        if (map.outside[yi][xi].length) {
          expect(z).toBeNull();
          gaps++;
        } else
          expect(z).toBe(runSheet(withParams(device, { gm_id: gmId, VD: vd }), dev).values.gain);
      }),
    );
    expect(gaps).toBeGreaterThan(0);
  });

  it('keeps nothing where nothing is asked for, or the name is none of the sheet’s equations', () => {
    expect(sweepSheet2(device, 'gm_id', 'VD', dev, 3).value).toBeUndefined();
    const named = sweepSheet2(device, 'gm_id', 'VD', dev, 3, undefined, undefined, {
      value: 'VDD',
    });
    expect(named.value).toBeUndefined();
  });
});
