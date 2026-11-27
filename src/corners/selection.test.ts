// The corner selection: one record that says which conditions, which operating axes and which
// named range ends a bench asks about, and cornersOf, the one function that lists the corners it
// names. The corner run, the sweep, the map and the sensitivity view all read it.

import { describe, expect, it } from 'vitest';
import { generateDemoDevice, toMostabCsv } from '../demo';
import { importMostab } from '../import';
import { sheetSensitivities, sweepSheet2 } from '../sheet';
import { rangePoints, type SheetDoc } from '../sheet/types';
import type { ConditionKey, DeviceTable } from '../types';
import { groupDevices, runConditions, sweepAtCondition, type CharacterizedDevice } from './index';
import {
  ALL_CORNERS,
  cornersOf,
  selectedConditions,
  selectedRange,
  selectionRun,
  type CornerSelection,
} from './selection';

/** A small sheet: x is solved from y = V, V and S are typed, and each moves on its own axis. A
 *  named end sets the floor, so a selection can leave it out. */
const doc: SheetDoc = {
  title: 'selection',
  polarity: 'n',
  params: [
    { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'V' } },
    { name: 'V', value: 5 },
    { name: 'S', value: 0.5 },
    { name: 'x_floor', value: 0.5, min: 0, max: 1.6 },
    { name: 'slack', value: 0, min: 0, max: 1 },
  ],
  equations: [
    { name: 'y', expr: '2*x + 1' },
    { name: 'side', expr: 'S + slack' },
  ],
  checks: [{ id: 'node-floor', kind: 'physical', lhs: 'x', op: '>=', rhs: 'x_floor' }],
  operatingAxes: [
    { param: 'V', lo: '3', hi: '7' },
    { param: 'S', lo: '0', hi: '1' },
  ],
  operatingRange: [{ name: 'high-floor', set: { x_floor: '1.2' } }],
};

const TT: ConditionKey = { corner: 'tt', temp: 27 };
const SS: ConditionKey = { corner: 'ss', temp: 125 };
const FF: ConditionKey = { corner: 'ff', temp: -40 };

const base = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });
const retag = (t: DeviceTable, c: ConditionKey): DeviceTable => ({
  ...t,
  id: { device: t.id.device, condition: c },
});
const [device] = groupDevices([retag(base, TT), retag(base, SS), retag(base, FF)]);

const label = (k: ConditionKey): string => `${k.corner}@${k.temp}`;

describe('the corner selection', () => {
  it('everything selected lists every condition alone and at every range point', () => {
    const corners = cornersOf(device, doc, ALL_CORNERS);
    const points = rangePoints(doc).map((p) => p.name);
    expect(points).toEqual(['V=lo,S=lo', 'V=lo,S=hi', 'V=hi,S=lo', 'V=hi,S=hi', 'high-floor']);
    expect(corners).toHaveLength(3 * (1 + points.length));
    expect(selectedRange(doc, ALL_CORNERS)).toBe(doc);
  });

  it('two conditions, one of two axes and no named end give 2 × (1 + 2) = 6 corners, everywhere', () => {
    const sel: CornerSelection = {
      conditions: [SS, TT],
      excludeAxes: ['S'],
      excludeEnds: ['high-floor'],
    };
    const corners = cornersOf(device, doc, sel);
    expect(corners.map((c) => `${label(c.key)} ${c.point?.name ?? ''}`)).toEqual([
      'ss@125 ',
      'ss@125 V=lo',
      'ss@125 V=hi',
      'tt@27 ',
      'tt@27 V=lo',
      'tt@27 V=hi',
    ]);
    // The axis left out stays at its design value; the named end is gone.
    const cut = selectedRange(doc, sel);
    expect(cut.operatingAxes?.map((a) => a.param)).toEqual(['V']);
    expect(cut.operatingRange).toBeUndefined();

    // The corner run: the same six points, sized at the nominal and held at ss.
    const run = selectionRun(device, doc, sel);
    expect(run.base).toEqual(TT);
    const runs = runConditions(run.doc, device, run.keys, () => undefined, undefined, run.base);
    expect(runs.flatMap((r) => r.points.map((p) => `${label(r.key)} ${p.rangeEnd ?? ''}`))).toEqual(
      corners.map((c) => `${label(c.key)} ${c.point?.name ?? ''}`),
    );

    // The sweep with its switch on asks the same two range points at a condition, and no other.
    const sweep = sweepAtCondition(run.doc, 'x_floor', device, SS, () => undefined, undefined, {
      base: TT,
      points: 3,
      range: 'checked',
    });
    expect(sweep.range).toBe('checked');
    expect([...new Set(sweep.checks.flatMap((k) => (k.rangeEnd ? [k.rangeEnd] : [])))]).toEqual([
      'V=lo',
      'V=hi',
    ]);

    // The map with its switch on carries those two points in each cell.
    const map = sweepSheet2(run.doc, 'x_floor', 'slack', device.nominal!, 2, undefined, undefined, {
      range: 'checked',
    });
    expect(map.rangeEnds?.flat().map((cell) => cell.map((e) => e.name))).toEqual(
      Array(4).fill(['V=lo', 'V=hi']),
    );

    // The sensitivity view reads the same cut sheet: a corner check it ranks is one of the two.
    const [row] = sheetSensitivities(run.doc, device.nominal!, undefined, {
      params: ['x_floor'],
      check: 'V=lo@node-floor',
    });
    expect(row.error).toBeUndefined();
    expect(row.checks.map((c) => c.id).filter((id) => id.includes('@'))).toEqual([
      'V=lo@node-floor',
    ]);
  });

  it('a condition no table holds is listed as absent, and the others run', () => {
    const gone: ConditionKey = { corner: 'sf', temp: 27 };
    const sel: CornerSelection = {
      conditions: [TT, gone, SS],
      excludeAxes: ['V', 'S'],
      excludeEnds: ['high-floor'],
    };
    const { held, absent } = selectedConditions(device, sel);
    expect(held).toEqual([TT, SS]);
    expect(absent).toEqual([gone]);
    expect(cornersOf(device, doc, sel).map((c) => label(c.key))).toEqual(['tt@27', 'ss@125']);
    const run = selectionRun(device, doc, sel);
    expect(run.absent).toEqual([gone]);
    const runs = runConditions(run.doc, device, run.keys, () => undefined, undefined, run.base);
    const design = (r: (typeof runs)[number]) => (r.state === 'evaluated' ? r.design : r.state);
    expect(runs.map((r) => [label(r.key), design(r)])).toEqual([
      ['tt@27', 'sized'],
      ['sf@27', 'not-evaluated'],
      ['ss@125', 'held'],
    ]);
  });

  it('an empty list of conditions asks about the base alone; a base of its own sizes there', () => {
    const only = selectionRun(device, doc, { conditions: [], excludeAxes: [], excludeEnds: [] });
    expect(only.keys).toEqual([TT]);
    expect(only.base).toEqual(TT);
    const there = selectionRun(device, doc, {
      conditions: [SS],
      excludeAxes: [],
      excludeEnds: [],
      base: SS,
    });
    expect(there.keys).toEqual([SS]);
    expect(there.base).toEqual(SS);
    const [r] = runConditions(
      there.doc,
      device,
      there.keys,
      () => undefined,
      undefined,
      there.base,
    );
    expect(r.state === 'evaluated' && r.design).toBe('sized');
  });

  it('the run takes its corners from cornersOf: the same list, and keys in the named order', () => {
    const sel: CornerSelection = { conditions: [FF, SS], excludeAxes: ['V'], excludeEnds: [] };
    const run = selectionRun(device, doc, sel);
    expect(run.corners).toEqual(cornersOf(device, doc, sel));
    expect(run.keys).toEqual([FF, SS]);
  });

  it('an axis the designer did not leave out counts, even one declared after the choice', () => {
    // One exclusion stored on the bench; the sheet then gains a third axis.
    const sel: CornerSelection = { conditions: [TT], excludeAxes: ['S'], excludeEnds: [] };
    const grown: SheetDoc = {
      ...doc,
      operatingAxes: [...doc.operatingAxes!, { param: 'slack', lo: '0', hi: '1' }],
    };
    expect(selectedRange(grown, sel).operatingAxes?.map((a) => a.param)).toEqual(['V', 'slack']);
    // 1 alone + 4 corners of two axes + the named end.
    expect(cornersOf(device, grown, sel)).toHaveLength(6);
  });

  it('a script on the same files and the same selection gives the same runs, key for key', () => {
    // The files the app would load: each condition written out and read back as text.
    const files = [TT, SS, FF].map((c) => toMostabCsv(retag(base, c)));
    const tables = files.map((text) => {
      const res = importMostab(text);
      if (!res.ok) throw new Error('fixture did not import');
      return res.dataset.tables[0];
    });
    const [read] = groupDevices(tables) as CharacterizedDevice[];
    const sel: CornerSelection = {
      conditions: [FF, TT],
      excludeAxes: ['V'],
      excludeEnds: [],
    };
    const script = selectionRun(read, doc, sel);
    const scripted = runConditions(
      script.doc,
      read,
      script.keys,
      () => undefined,
      undefined,
      script.base,
    );
    const app = selectionRun(device, doc, sel);
    const direct = runConditions(app.doc, device, app.keys, () => undefined, undefined, app.base);
    const facts = (rs: typeof direct) =>
      rs.map((r) => ({
        key: label(r.key),
        state: r.state,
        points: r.points.map((p) => [p.rangeEnd ?? '', p.state, p.verdict?.verdict]),
      }));
    expect(facts(scripted)).toEqual(facts(direct));
    expect(facts(scripted).map((r) => r.points.map(([n]) => n))).toEqual([
      ['', 'S=lo', 'S=hi', 'high-floor'],
      ['', 'S=lo', 'S=hi', 'high-floor'],
    ]);
  });
});
