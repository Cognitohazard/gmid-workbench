// The curves of a sheet's named results across a sweep: each equation's value at every sample of a
// one-parameter sweep, and one asked-for equation at every cell of a two-parameter map — a gap
// wherever the sample withholds it, and its value wherever the sample's problem does not touch it.
import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import { groupDevices, sweepAtCondition } from '../corners';
import {
  namedResults,
  resolveSheetRefs,
  runSheet,
  sweepSheet,
  sweepSheet2,
  withParams,
} from './index';
import { loadLibrary, table, REFS } from './library.fixtures';
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
      const res = runSheet(withParams(device, { VD: x }), dev);
      expect(sw.values[1].y[i]).toBe(res.values.room);
      if (!sw.outside[i].length) expect(sw.values[0].y[i]).toBe(res.values.gain);
    });
  });

  it('leaves a gap where a sample withholds the result, and keeps one the problem does not touch', () => {
    const beyond = sw.x.map((_, i) => sw.outside[i].length > 0);
    expect(beyond).toContain(true);
    expect(beyond).toContain(false);
    const [gain, room] = sw.values;
    sw.x.forEach((x, i) => {
      // `gain` reads the device: withheld where the device is read beyond its table.
      if (beyond[i]) expect(gain.y[i], `gain at ${x}`).toBeNull();
      else expect(Number.isFinite(gain.y[i]), `gain at ${x}`).toBe(true);
      // `room` reads only params, so the device's problem does not touch it.
      expect(room.y[i], `room at ${x}`).toBeCloseTo(1.8 - x, 12);
    });
  });
});

describe('a two-parameter map', () => {
  it('keeps a result the problem does not touch at a cell beyond the table', () => {
    const map = sweepSheet2(device, 'gm_id', 'VD', dev, 5, undefined, undefined, {
      value: 'room',
    });
    let beyond = 0;
    map.y.forEach((vd, yi) =>
      map.x.forEach((_, xi) => {
        if (map.outside[yi][xi].length) beyond++;
        expect(map.value!.z[yi][xi]).toBeCloseTo(1.8 - vd, 12);
      }),
    );
    expect(beyond).toBeGreaterThan(0);
  });

  it('keeps the one equation asked for at every cell, with a gap where it reads the device beyond the table', () => {
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
    expect(named.valueNotNamed?.name).toBe('VDD');
  });
});

describe('the named results a sweep follows', () => {
  const lib = loadLibrary();
  const fiveT = lib.find((s) => s.file === 'otas/five-transistor-ota.json')!.doc;
  // CM_dc up to 1.75 V: past about 1.5 V the tail voltage is not found, and the sweep crosses it.
  const doc = {
    ...fiveT,
    params: fiveT.params.map((p) => (p.name === 'CM_dc' ? { ...p, max: 1.75 } : p)),
  };
  const sw = sweepSheet(doc, 'CM_dc', table, 7, undefined, REFS);
  const at = (name: string) => sw.values.find((c) => c.name === name)!;

  it('are the decisions view’s: equations, solved values, then what the blocks provide', () => {
    const names = sw.values.map((c) => c.name);
    const design = runSheet(doc, table, undefined, REFS);
    const fromDesign = namedResults(resolveSheetRefs(doc, REFS).doc, design).map((n) => n.name);
    expect(names.slice(0, fromDesign.length)).toEqual(fromDesign);
    // The tail voltage the engine solves for is a curve, and so is a value a block provides.
    expect(names).toContain('V_tail');
    expect(names).toContain('in__gm');
    expect(names.indexOf('V_tail')).toBeLessThan(names.indexOf('in__gm'));
  });

  it('reads a solved value at each sample, with a gap where the solve did not find it', () => {
    const tail = at('V_tail');
    let gaps = 0;
    sw.x.forEach((x, i) => {
      const res = runSheet(withParams(doc, { CM_dc: x }), table, undefined, REFS);
      if (res.withheld?.V_tail !== undefined) {
        expect(tail.y[i], `V_tail at ${x}`).toBeNull();
        gaps++;
      } else expect(tail.y[i], `V_tail at ${x}`).toBe(res.values.V_tail);
    });
    expect(gaps).toBeGreaterThan(0);
    expect(tail.y.some((v) => v !== null)).toBe(true);
  });

  it('are all gaps on a held sweep at a condition nothing was evaluated at', () => {
    const tt = { ...table, id: { device: table.id.device, condition: { corner: 'tt', temp: 27 } } };
    const [device] = groupDevices([tt]);
    // The design is sized at tt and held at ss, which has no table: no sample is evaluated there.
    const held = sweepAtCondition(
      fiveT,
      'I_tail',
      device,
      { corner: 'ss', temp: 27 },
      () => undefined,
      REFS,
      {
        base: { corner: 'tt', temp: 27 },
        points: 4,
      },
    );
    expect(held.design).toBe('held');
    expect(held.x).toHaveLength(4);
    expect(held.values.length).toBeGreaterThan(0);
    for (const c of held.values) expect(c.y, c.name).toEqual([null, null, null, null]);
  });

  it('on a map, keeps a value a block provides, and says so of a name that is not a named result', () => {
    const map = sweepSheet2(fiveT, 'I_tail', 'gm_id_in', table, 2, undefined, REFS, {
      value: 'in__gm',
    });
    expect(map.value?.name).toBe('in__gm');
    expect(map.value!.z.flat().every((v) => v !== null && v > 0)).toBe(true);
    const off = sweepSheet2(fiveT, 'I_tail', 'gm_id_in', table, 2, undefined, REFS, {
      value: 'VDD',
    });
    expect(off.value).toBeUndefined();
    expect(off.valueNotNamed).toEqual({
      name: 'VDD',
      message:
        'VDD is not a named result of this sheet. A named result is one of its equations, a ' +
        'value it solves for, or a value one of its blocks provides.',
    });
  });
});
