// The operating axes: a claim over several givens at once, checked at every corner of the box the
// axes span, ahead of the named range ends. Every case runs on the demo table; the library sheets
// that state their common-mode range as one axis are checked against the same claim written as
// two named range ends, which is how they stated it before.

import { describe, expect, it } from 'vitest';
import { ekvTable } from '../demo/ekv.fixtures';
import { generateDemoDevice } from '../demo';
import { aggregateConditionRuns, groupDevices, runConditions, type ConditionKey } from '../corners';
import type { DeviceTable } from '../types';
import { REFS, namedEnds, sheet, table } from './library.fixtures';
import {
  evaluateSheet,
  runSheet,
  sheetSensitivities,
  sweepSheet,
  sweepSheet2,
  validateSheet,
} from './index';
import {
  AXES_LOCATION,
  rangePoints,
  withoutRange,
  type RangeEndReport,
  type SheetDoc,
  type SheetResult,
} from './types';

/** The seven library sheets whose common-mode range is one axis. */
const MOVED = [
  'otas/current-mirror-ota.json',
  'otas/degenerated-differential-pair.json',
  'otas/differential-pair-tail.json',
  'otas/five-transistor-ota.json',
  'otas/folded-cascode-ota.json',
  'otas/gain-boosted-cascode-ota.json',
  'otas/telescopic-cascode-ota.json',
];

const RENAME: Record<string, string> = { 'CM_dc=lo': 'cm-lo', 'CM_dc=hi': 'cm-hi' };
const renamedId = (id: string): string => {
  const at = id.indexOf('@');
  return at < 0 ? id : `${RENAME[id.slice(0, at)] ?? id.slice(0, at)}${id.slice(at)}`;
};

/** Every number and word a range end answers with, apart from its name and the prose that quotes
 *  the name. */
const endFacts = (e: RangeEndReport): unknown => ({
  state: e.state,
  set: e.set,
  solved: e.solved,
  error: e.error,
  verdict: e.verdict?.verdict,
  checks: e.checks.map((c) => [c.id, c.status, c.margin, c.rawMargin, c.lhsValue, c.rhsValue]),
  warnings: e.warnings.map((w) => [w.rule, w.severity]),
  blocks: e.blocks?.map((b) => [b.name, b.feasible, b.provides]),
});

/** A result's answer, with each corner renamed to the named end it replaces. */
const facts = (r: SheetResult): unknown => ({
  feasible: r.feasible,
  complies: r.complies,
  verdict: r.verdict?.verdict,
  values: r.values,
  checks: r.checks.map((c) => [renamedId(c.id), c.status, c.margin, c.rawMargin]),
  ends: r.rangeEnds?.map((e) => [RENAME[e.name] ?? e.name, endFacts(e)]),
});

/** A small sheet in the library's idiom: x is the internal node the design constraint solves,
 *  y = 2x + 1 the produced output, V the typed spec the axis moves, S a second axis the sheet
 *  reads only in a side result. */
const mk = (over: Partial<SheetDoc> = {}): SheetDoc => ({
  title: 'axes',
  polarity: 'n',
  params: [
    { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'V' } },
    { name: 'V', value: 5 },
    { name: 'V_lo', value: 3 },
    { name: 'V_hi', value: 7 },
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
    { param: 'V', lo: 'V_lo', hi: 'V_hi' },
    { param: 'S', lo: '0', hi: '1' },
  ],
  ...over,
});
const ekv = ekvTable();
const dev = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });

const notRun = (r: SheetResult): boolean =>
  (r.rangeEnds ?? []).length > 0 &&
  r.rangeEnds!.every((e) => e.state === 'not-run' && e.checks.length === 0);

const axisErrors = (doc: SheetDoc): string[] =>
  validateSheet(doc)
    .filter((w) => w.severity === 'error' && w.location === AXES_LOCATION)
    .map((w) => w.message);

describe('operating axes — the corners of a claimed box, checked on the held design', () => {
  it('one axis on CM_dc answers exactly as the two named ends it replaces', () => {
    const doc = sheet('otas/five-transistor-ota.json');
    const axis = runSheet(doc, table, undefined, REFS);
    const ends = runSheet(namedEnds(doc), table, undefined, REFS);
    expect(axis.rangeEnds?.map((e) => e.name)).toEqual(['CM_dc=lo', 'CM_dc=hi']);
    expect(axis.rangeEnds?.map((e) => e.corner)).toEqual([
      [{ param: 'CM_dc', end: 'lo', value: 1.0 }],
      [{ param: 'CM_dc', end: 'hi', value: 1.35 }],
    ]);
    expect(facts(axis)).toEqual(facts(ends));
  });

  it.each(MOVED)('%s: its CM_dc axis answers exactly as the named ends it replaces', (file) => {
    const doc = sheet(file);
    expect(doc.operatingRange).toBeUndefined();
    expect(doc.operatingAxes?.map((a) => [a.param, a.lo, a.hi])).toEqual([
      ['CM_dc', 'CM_lo', 'CM_hi'],
    ]);
    expect(doc.operatingAxes?.[0].note).toBeTruthy();
    for (const t of [table, ekv]) {
      const axis = runSheet(doc, t, undefined, REFS);
      const ends = runSheet(namedEnds(doc), t, undefined, REFS);
      expect(facts(axis)).toEqual(facts(ends));
    }
  });

  it('two axes give four corners, an end that reads another axis following it', () => {
    const doc = sheet('otas/five-transistor-ota.json');
    doc.operatingAxes = [
      { param: 'VDD', lo: '1.62', hi: '1.98' },
      { param: 'CM_dc', lo: '1.0', hi: 'VDD - 0.45' },
    ];
    expect(rangePoints(doc).map((p) => p.name)).toEqual([
      'VDD=lo,CM_dc=lo',
      'VDD=lo,CM_dc=hi',
      'VDD=hi,CM_dc=lo',
      'VDD=hi,CM_dc=hi',
    ]);
    const res = runSheet(doc, table, undefined, REFS);
    expect(res.rangeEnds?.map((e) => e.corner?.map((c) => c.value))).toEqual([
      [1.62, 1.0],
      [1.62, 1.62 - 0.45],
      [1.98, 1.0],
      [1.98, 1.98 - 0.45],
    ]);
    expect(res.rangeEnds?.[1].set).toEqual({ VDD: 1.62, CM_dc: 1.62 - 0.45 });
    expect(res.rangeEnds?.[1].set.CM_dc).toBeCloseTo(1.17, 12);
  });

  it('an end that reads a value the design computes is an error, and no corner runs', () => {
    const doc = sheet('otas/five-transistor-ota.json');
    const base = runSheet(withoutRange(doc), table, undefined, REFS);
    doc.operatingAxes = [{ param: 'CM_dc', lo: 'CM_lo', hi: 'CM_in' }];
    expect(axisErrors(doc).length).toBeGreaterThan(0);
    const res = runSheet(doc, table, undefined, REFS);
    expect(notRun(res)).toBe(true);
    expect(res.verdict?.verdict).toBe(base.verdict?.verdict);
    expect(res.feasible).toBe(base.feasible);
  });

  it('two axes that read each other are a cycle, named by both', () => {
    const doc = mk({
      operatingAxes: [
        { param: 'V', lo: 'S + 2', hi: 'V_hi' },
        { param: 'S', lo: '0', hi: 'V - 4' },
      ],
    });
    const errs = axisErrors(doc);
    expect(errs.some((m) => m.includes('"V"') && m.includes('"S"'))).toBe(true);
    expect(notRun(runSheet(doc, dev))).toBe(true);
  });

  it('a cycle through three axes names all three', () => {
    const doc = mk({
      operatingAxes: [
        { param: 'V', lo: 'S + 2', hi: 'V_hi' },
        { param: 'S', lo: 'x_floor - 0.5', hi: '1' },
        { param: 'x_floor', lo: 'V - 5', hi: '1.6' },
      ],
    });
    const errs = axisErrors(doc);
    expect(errs.some((m) => ['"V"', '"S"', '"x_floor"'].every((p) => m.includes(p)))).toBe(true);
    expect(notRun(runSheet(doc, dev))).toBe(true);
  });

  it('an axis on a param the engine solves is an error', () => {
    const doc = sheet('otas/five-transistor-ota.json');
    doc.operatingAxes = [{ param: 'V_tail', lo: '0.3', hi: '0.5' }];
    expect(axisErrors(doc).some((m) => m.includes('V_tail'))).toBe(true);
    expect(notRun(runSheet(doc, table, undefined, REFS))).toBe(true);
  });

  it('a corner whose low end lies above its high end is undetermined; the others run', () => {
    // V's high end follows S: at S = 0 it is 2, below the low end 3.
    const doc = mk({
      operatingAxes: [
        { param: 'S', lo: '0', hi: '1' },
        { param: 'V', lo: 'V_lo', hi: '2 + 6*S' },
      ],
    });
    expect(axisErrors(doc)).toEqual([]);
    const res = runSheet(doc, dev);
    expect(res.rangeEnds?.map((e) => [e.name, e.state])).toEqual([
      ['S=lo,V=lo', 'no-answer'],
      ['S=lo,V=hi', 'no-answer'],
      ['S=hi,V=lo', 'complies'],
      ['S=hi,V=hi', 'complies'],
    ]);
    // The V axis is empty along the whole S = lo row, so both of its corners say so.
    for (const e of res.rangeEnds!.slice(0, 2))
      expect(e.error).toMatch(/low end lies above its high end/);
    // A corner that has no answer still says which corner it is.
    expect(res.rangeEnds?.[0].corner?.map((c) => [c.param, c.end])).toEqual([
      ['S', 'lo'],
      ['V', 'lo'],
    ]);
    expect(res.verdict?.verdict).toBe('feasible');
    expect(res.rangeEnds?.[3].solved.x).toBeCloseTo(3.5, 4); // V = 8 → y = 2x + 1 = 8
  });

  it('axes and a named end: the corners first, then the end, which answers as it did alone', () => {
    const named = { name: 'mid', set: { V: '4' } };
    const both = runSheet(mk({ operatingRange: [named] }), dev);
    const alone = runSheet(mk({ operatingAxes: undefined, operatingRange: [named] }), dev);
    expect(both.rangeEnds?.map((e) => e.name)).toEqual([
      'V=lo,S=lo',
      'V=lo,S=hi',
      'V=hi,S=lo',
      'V=hi,S=hi',
      'mid',
    ]);
    expect(endFacts(both.rangeEnds![4])).toEqual(endFacts(alone.rangeEnds![0]));
    expect(both.rangeEnds?.[4].corner).toBeUndefined();
  });

  it('a sheet stated with named ends only answers as before, over the library on both devices', () => {
    // Every named end is evaluated as before: no corner appears, the order is the document's,
    // and the answer is the axis form's, end for end.
    for (const file of MOVED) {
      const doc = namedEnds(sheet(file));
      expect(rangePoints(doc).map((p) => [p.name, p.corner])).toEqual([
        ['cm-lo', undefined],
        ['cm-hi', undefined],
      ]);
      for (const t of [table, ekv]) {
        const res = runSheet(doc, t, undefined, REFS);
        expect(res.rangeEnds?.map((e) => e.name)).toEqual(['cm-lo', 'cm-hi']);
        expect(res.rangeEnds?.every((e) => e.corner === undefined)).toBe(true);
      }
    }
  });

  it('three conditions and three axes give 27 points, each named by condition and corner', () => {
    const doc = mk({
      operatingAxes: [
        { param: 'V', lo: 'V_lo', hi: 'V_hi' },
        { param: 'S', lo: '0', hi: '1' },
        { param: 'slack', lo: '0', hi: '0.5' },
      ],
    });
    // x_floor 1.5 fails at every corner with V at its low end (x = 1), and nowhere else.
    doc.params.find((p) => p.name === 'x_floor')!.value = 1.5;
    const retag = (t: DeviceTable, corner: string, temp: number): DeviceTable => ({
      ...t,
      id: { ...t.id, corner, temp },
    });
    const [device] = groupDevices([
      retag(dev, 'tt', 27),
      retag(dev, 'ss', 125),
      retag(dev, 'ff', -40),
    ]);
    const keys: ConditionKey[] = [
      { corner: 'tt', temp: 27 },
      { corner: 'ss', temp: 125 },
      { corner: 'ff', temp: -40 },
    ];
    const runs = runConditions(doc, device, keys, () => undefined, undefined, keys[0]);
    expect(runs.map((r) => r.points.length)).toEqual([9, 9, 9]);
    const agg = aggregateConditionRuns(runs);
    // The held points: 27 points over three conditions, less the sized centre.
    expect(agg.heldPoints.total).toBe(26);
    expect(agg.heldVerdict?.verdict).toBe('non-compliant');
    const decided = agg.heldVerdict!.decidedBy.map((p) => `${p.key.corner} ${p.rangeEnd}`);
    expect(decided).toEqual(
      keys.flatMap((k) =>
        [
          'V=lo,S=lo,slack=lo',
          'V=lo,S=lo,slack=hi',
          'V=lo,S=hi,slack=lo',
          'V=lo,S=hi,slack=hi',
        ].map((c) => `${k.corner} ${c}`),
      ),
    );
    const point = runs[1].points.find((p) => p.rangeEnd === 'V=lo,S=hi,slack=hi');
    expect(point?.corner).toEqual([
      { param: 'V', end: 'lo', value: 3 },
      { param: 'S', end: 'hi', value: 1 },
      { param: 'slack', end: 'hi', value: 0.5 },
    ]);
  });

  it('a design point with no design runs no corner', () => {
    // A floor no x reaches: the design point fails, so there is no hardware to hold.
    const doc = mk();
    doc.params.find((p) => p.name === 'V')!.value = 50; // y = 50 is beyond x's range
    const res = runSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.rangeEnds?.every((e) => e.state === 'not-run')).toBe(true);
    expect(res.rangeEnds?.some((e) => e.checks.length > 0)).toBe(false);
  });

  it('a design value outside its own axis is a warning, and every corner runs', () => {
    const doc = sheet('otas/five-transistor-ota.json');
    doc.operatingAxes = [{ param: 'CM_dc', lo: '1.2', hi: '1.35' }]; // CM_dc = 1.1 below it
    const found = validateSheet(doc).filter(
      (w) => w.location === AXES_LOCATION && w.severity !== 'info',
    );
    expect(found.map((w) => w.severity)).toEqual(['warning']);
    expect(found[0].message).toContain('CM_dc');
    const res = runSheet(doc, table, undefined, REFS);
    expect(res.rangeEnds?.map((e) => e.name)).toEqual(['CM_dc=lo', 'CM_dc=hi']);
    expect(res.rangeEnds?.every((e) => e.state !== 'not-run')).toBe(true);
  });

  it('a sweep asks every corner when checked, and is the design point alone when not', () => {
    const doc = mk();
    const on = sweepSheet(doc, 'x_floor', dev, 5, undefined, undefined, {
      range: 'checked',
      windows: true,
    });
    const off = sweepSheet(doc, 'x_floor', dev, 5, undefined, undefined, { windows: true });
    const bare = sweepSheet(withoutRange(doc), 'x_floor', dev, 5, undefined, undefined, {
      windows: true,
    });
    expect(on.range).toBe('checked');
    const corners = rangePoints(doc).map((p) => p.name);
    expect(corners).toHaveLength(4);
    for (const c of corners) {
      const curve = on.checks.find((k) => k.rangeEnd === c);
      expect(curve?.id).toBe(`${c}@`);
      expect(curve?.marginPct).toHaveLength(5);
    }
    // The window reads the corners as it reads named ends: the same four points written as named
    // ends give the same window.
    const written = sweepSheet(
      {
        ...withoutRange(doc),
        operatingRange: rangePoints(doc).map((p, k) => ({
          name: `c${k}`,
          set: p.set,
        })),
      },
      'x_floor',
      dev,
      5,
      undefined,
      undefined,
      { range: 'checked', windows: true },
    );
    expect(on.windows?.map((w) => [w.lo, w.hi])).toEqual(written.windows?.map((w) => [w.lo, w.hi]));
    expect(on.checks.filter((k) => k.rangeEnd).map((k) => k.marginPct)).toEqual(
      written.checks.filter((k) => k.rangeEnd).map((k) => k.marginPct),
    );
    expect(off.range).toBe('not-checked');
    expect({ ...off, range: undefined }).toEqual({ ...bare, range: undefined });
  });

  it('a map asks every corner per cell when checked, and is today’s map when not', () => {
    const doc = mk();
    const on = sweepSheet2(doc, 'x_floor', 'slack', dev, 3, undefined, undefined, {
      range: 'checked',
    });
    const off = sweepSheet2(doc, 'x_floor', 'slack', dev, 3);
    expect(on.range).toBe('checked');
    expect(on.rangeEnds?.flat().map((cell) => cell.length)).toEqual(Array(9).fill(4));
    expect(on.rangeEnds?.[0][0].map((e) => e.name)).toEqual(rangePoints(doc).map((p) => p.name));
    // Feasibility is the design point's either way.
    expect(on.feasible).toEqual(off.feasible);
    expect(off.range).toBe('not-checked');
    expect(off.rangeEnds).toBeUndefined();
  });

  it('a ranking probe on a corner check asks the design point and that one corner only', () => {
    const doc = mk();
    doc.params.find((p) => p.name === 'x_floor')!.value = 0.8;
    const only = evaluateSheet(doc, dev, undefined, { rangePoint: 'V=lo,S=hi' });
    expect(only.rangeEnds?.map((e) => e.name)).toEqual(['V=lo,S=hi']);
    const [row] = sheetSensitivities(doc, dev, undefined, {
      params: ['x_floor'],
      check: 'V=lo,S=hi@node-floor',
    });
    expect(row.error).toBeUndefined();
    const ids = row.checks.map((c) => c.id);
    expect(ids).toContain('V=lo,S=hi@node-floor');
    // No other corner was asked.
    expect(ids.filter((id) => id.includes('@'))).toEqual(['V=lo,S=hi@node-floor']);
  });

  it('a named end may not contain "="', () => {
    const doc = mk({
      operatingAxes: undefined,
      operatingRange: [{ name: 'V=lo', set: { V: '3' } }],
    });
    expect(
      validateSheet(doc).some((w) => w.severity === 'error' && w.message.includes('"="')),
    ).toBe(true);
  });
});
