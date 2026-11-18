// A read beyond a device's table is one outcome wherever a sheet makes it: the device is not sized,
// the result holds one typed record of what was asked and what the table holds, everything that
// reads the device is withheld with the device as its cause, and the point has no answer. These
// tests follow that outcome through each place a sheet reaches — the design point, a composed
// block, a sweep, a sensitivity, a search — on the present demo table, which stops at
// vds = 1.2 V, and on the full-range device, which reaches the supply.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import { ekvTable } from '../demo/ekv.fixtures';
import { outsideTableMessage } from '../types';
import { runSheet, sheetSensitivities, sweepSheet, withParams } from './index';
import { sheet, REFS, table as demoTable } from './library.fixtures';
import { followOnSummary, outsideIn, type SheetDoc } from './types';

const dev = generateDemoDevice({
  vds: { min: 0, max: 1.2, step: 0.05 },
  vsb: { min: 0, max: 0.4, step: 0.05 },
});

/** One device at a stated drain voltage `VD`, with an equation and a check that read the device
 *  and an equation and a check that read only a param. */
const device = (VD = 0.6, over: Partial<SheetDoc> = {}): SheetDoc => ({
  title: 'one device',
  polarity: 'n',
  formatVersion: 2,
  nodes: 'none',
  params: [
    {
      name: 'VD',
      value: VD,
      unit: 'V',
      min: 0.2,
      max: 1.5,
      role: 'choice',
      class: 'independent',
    },
    { name: 'gm_id', value: 12, min: 6, max: 18, role: 'choice' },
    { name: 'VDD', value: 1.8, unit: 'V' },
  ],
  givens: { L: '0.5u', gm_id: 'gm_id', id: '20u', vds: 'VD', vsb: '0' },
  equations: [
    { name: 'gain', expr: 'gm/gds' },
    { name: 'room', expr: 'VDD - VD' },
  ],
  checks: [
    { id: 'gain-spec', kind: 'spec', lhs: 'gain', op: '>=', rhs: '10' },
    { id: 'room-spec', kind: 'spec', lhs: 'room', op: '>=', rhs: '0.2' },
  ],
  ...over,
});

describe('a read beyond the table at the design point', () => {
  const res = runSheet(device(1.3), dev);

  it('does not size the device, and holds one record generated into one error', () => {
    expect(res.sizing?.ok).toBe(false);
    const record = { device: 'givens', quantity: 'vds', asked: 1.3, held: [0, 1.2] as const };
    expect(res.sizing?.outside).toEqual([{ ...record, held: [0, expect.closeTo(1.2, 12)] }]);
    expect(res.sizing?.error).toBe(outsideTableMessage(res.sizing!.outside![0]));
    expect(res.warnings.filter((w) => w.severity === 'error').map((w) => w.message)).toEqual([
      res.sizing?.error,
    ]);
    expect(outsideIn(res)).toEqual(res.sizing?.outside);
  });

  it('withholds what reads the device, with the device as the cause, and evaluates the rest', () => {
    expect(res.values.gain).toBeUndefined();
    expect(res.withheld?.gain).toBe('givens');
    expect(res.withheld?.gm).toBe('givens');
    // What reads no device is still evaluated and shown.
    expect(res.values.room).toBeCloseTo(0.5, 12);
    expect(res.checks.find((c) => c.id === 'room-spec')?.status).toBe('pass');
    expect(res.checks.find((c) => c.id === 'gain-spec')?.status).toBe('na');
    // The findings that follow from the device are folded under it.
    const summary = followOnSummary(res.warnings);
    expect(summary?.message).toMatch(/follows? from the sheet's own device, which is not sized/);
  });

  it('has no answer: never feasible, never complies, never fails', () => {
    expect(res.feasible).toBe(false);
    expect(res.point).toEqual({ sized: false, state: 'no-answer', error: res.sizing?.error });
  });

  it('names a block whose device was read beyond its table by its path, and withholds its outputs', () => {
    const parent: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [],
      blocks: [{ name: 'amp', doc: { ...device(1.3), provides: ['gain', 'room'] } }],
      equations: [{ name: 'twice', expr: '2*amp__gain' }],
      checks: [],
    };
    const r = runSheet(parent, dev);
    expect(outsideIn(r).map((o) => [o.device, o.quantity, o.asked])).toEqual([['amp', 'vds', 1.3]]);
    expect(r.point?.state).toBe('no-answer');
    expect(r.point?.error).toBe(`block "amp": ${res.sizing?.error}`);
    expect(r.withheld?.twice).toBe('amp');
    expect(r.values.amp__room).toBeCloseTo(0.5, 12);
  });
});

describe('a sweep across the edge of the table', () => {
  const sw = sweepSheet(device(), 'VD', dev, 14, undefined, undefined, { windows: true });

  it('marks each sample read beyond the table, with its record', () => {
    for (let i = 0; i < sw.x.length; i++) {
      const beyond = sw.x[i] > 1.2 + 1e-12;
      expect([sw.x[i], sw.outside[i].length > 0]).toEqual([sw.x[i], beyond]);
      if (beyond) {
        expect(sw.outside[i].map((r) => [r.quantity, r.asked])).toEqual([['vds', sw.x[i]]]);
        expect(sw.feasible[i]).toBe(false);
        expect(sw.stands[i]).toBe(false);
      }
    }
  });

  it('leaves the margins that read the device null there, and the others measured', () => {
    const gain = sw.checks.find((c) => c.id === 'gain-spec')!;
    const room = sw.checks.find((c) => c.id === 'room-spec')!;
    sw.x.forEach((x, i) => {
      if (sw.outside[i].length) {
        expect(gain.marginPct[i]).toBeNull();
        expect(room.marginPct[i]).not.toBeNull();
      } else expect(gain.marginPct[i]).not.toBeNull();
    });
  });

  it('ends a passing stretch where the table ends, and says so', () => {
    const last = sw.windows![sw.windows!.length - 1];
    expect(last.hi).toBeLessThanOrEqual(1.2 + 1e-12);
    expect(last.above).toEqual([]);
    expect(last.aboveOutside?.map((r) => r.quantity)).toEqual(['vds']);
    expect(last.aboveOutside![0].asked).toBeGreaterThan(1.2);
  });
});

describe('a sensitivity at the edge of the table', () => {
  it('never reports a slope from a probe read beyond the table', () => {
    // At VD = 1.2 V the device sits on the table's last vds node: a central probe 1 % up asks for
    // 1.212 V. That probe is not used; the knob is differenced on the side that stays on the table,
    // and the entry says why.
    const [row] = sheetSensitivities(device(1.2), dev, undefined, { params: ['VD'] });
    expect(row.outside?.map((r) => r.quantity)).toEqual(['vds']);
    expect(row.error).toMatch(/reads a device beyond its table .* differenced on the other side/);
    const gain = row.checks.find((c) => c.id === 'gain-spec')!;
    expect(Number.isFinite(gain.dMarginPerUnit)).toBe(true);
    expect(gain.dMarginPerUnit).not.toBe(0);
    expect(gain.deltaPlus).toBeNaN();
    expect(Number.isFinite(gain.deltaMinus)).toBe(true);
  });

  it('gives no numbers at all where every probe and the design itself are beyond the table', () => {
    const rows = sheetSensitivities(device(1.3), dev, undefined, { params: ['VD'] });
    expect(rows[0].checks).toEqual([]);
    expect(rows[0].error).toMatch(/reads a device beyond its table at its own values/);
  });
});

describe('a search one end of whose range is beyond the table', () => {
  it('finds a root that lies on the table, and gives no answer when the root lies beyond it', () => {
    // The folded cascode at a low common mode: its tail node's root lies where the present table
    // cannot read the input pair (beyond 1.2 V of drain voltage). The search steps in from that end
    // and finds no crossing in what is left — not shown to be the design's failure, so no answer.
    // The full-range device reads that stretch and gives the design's own verdict.
    const doc = withParams(sheet('otas/folded-cascode-ota.json'), { CM_dc: 0.7 });
    const short = runSheet(doc, demoTable, undefined, REFS);
    expect(short.point?.state).toBe('no-answer');
    expect(short.solve).toMatchObject({ kind: 'not-settled' });
    expect(short.point?.error).toMatch(/vds = 1\.2\d* V is above what the table holds/);
    const full = runSheet(doc, ekvTable(), undefined, REFS);
    expect(full.solve).toEqual({ kind: 'settled' });
    expect(outsideIn(full)).toEqual([]);
    expect(full.point?.state).toBe('does-not-comply');
  });
});
