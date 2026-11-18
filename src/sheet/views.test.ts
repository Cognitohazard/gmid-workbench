// How each result of a sheet moves with each decision of the designer (sheetSensitivities'
// `results`, and the left side of each check): the relative change of the result for a 1 % change of
// the knob, from full evaluations of the design. Tested against differences the test computes from
// evaluations of its own, on a common-source stage whose gain is gm/gds.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import {
  devicePropertySensitivities,
  evaluateSheet,
  runSheet,
  sheetSensitivities,
  solvedValuesIn,
  withParams,
} from './index';
import { sheet, REFS, table } from './library.fixtures';
import { withoutRange, type SheetDoc } from './types';

const dev = generateDemoDevice({
  vds: { min: 0, max: 1.2, step: 0.05 },
  vsb: { min: 0, max: 0.4, step: 0.05 },
});

/** A common-source stage: one device at a stated drain voltage, its gain gm/gds against the
 *  designer's gm/ID and length. */
const stage = (over: Partial<SheetDoc> = {}): SheetDoc => ({
  title: 'common-source stage',
  polarity: 'n',
  formatVersion: 2,
  nodes: 'none',
  params: [
    { name: 'gm_id', value: 12, min: 6, max: 18, role: 'choice' },
    { name: 'L', value: 0.5e-6, unit: 'm', min: 0.2e-6, max: 2e-6, role: 'choice' },
    { name: 'VD', value: 0.6, unit: 'V', min: 0.2, max: 1.5, role: 'choice', class: 'independent' },
    { name: 'off', value: 0, min: -1, max: 1, role: 'choice' },
  ],
  givens: { L: 'L', gm_id: 'gm_id', id: '20u', vds: 'VD', vsb: '0' },
  equations: [
    { name: 'gain', expr: 'gm/gds', unit: 'V/V' },
    { name: 'square', expr: 'gm_id^2' },
    { name: 'shifted', expr: 'off' },
  ],
  checks: [{ id: 'gain-spec', kind: 'spec', lhs: 'gain', op: '>=', rhs: '10' }],
  ...over,
});

/** The relative change of `name` for a 1 % change of `knob`, from a central difference the test
 *  takes itself. */
function centralRel(doc: SheetDoc, knob: string, name: string): number {
  const p = doc.params.find((q) => q.name === knob)!;
  const h = 0.01 * p.value;
  const at = (x: number) => evaluateSheet(withParams(withoutRange(doc), { [knob]: x }), dev);
  const up = at(p.value + h).values[name];
  const down = at(p.value - h).values[name];
  const base = at(p.value).values[name];
  return ((up - down) / (2 * h)) * (p.value / base);
}

describe('the decisions view: how each result moves with each knob', () => {
  const rows = sheetSensitivities(stage(), dev, undefined, { params: ['gm_id', 'L', 'off'] });
  const row = (knob: string) => rows.find((r) => r.param === knob)!;
  const cell = (knob: string, name: string) => row(knob).results.find((r) => r.name === name)!;

  it('gives the gain against gm/ID and L as the difference of two evaluations', () => {
    for (const knob of ['gm_id', 'L']) {
      const c = cell(knob, 'gain');
      expect(c.unit).toBe('V/V');
      expect(c.relPerPct).toBeCloseTo(centralRel(stage(), knob, 'gain'), 12);
      expect(c.dPerUnit * stage().params.find((p) => p.name === knob)!.value).toBeCloseTo(
        c.relPerPct! * c.base,
        9,
      );
    }
    // A longer device has more gain: the sign is the hardware's.
    expect(cell('L', 'gain').relPerPct).toBeGreaterThan(0);
  });

  it('reads 2 for a square, 1 % for 1 % meaning 1', () => {
    expect(cell('gm_id', 'square').relPerPct).toBeCloseTo(2, 3);
    expect(cell('L', 'square').relPerPct).toBe(0);
  });

  it('gives the left side of each check its own relative change, and leaves the margin absolute', () => {
    const c = row('gm_id').checks.find((k) => k.id === 'gain-spec')!;
    expect(c.relPerPct).toBeCloseTo(cell('gm_id', 'gain').relPerPct!, 12);
    expect(Number.isFinite(c.dMarginPerUnit)).toBe(true);
  });

  it('has no relative change for a result that is zero at the design, or for a knob at zero', () => {
    const zero = cell('gm_id', 'shifted');
    expect(zero.base).toBe(0);
    expect(zero.relPerPct).toBeUndefined();
    expect(zero.why).toBe('shifted is zero at the design, so it has no relative change.');
    // The knob `off` is zero: its step comes from its range, and a relative change of it has no
    // size; the absolute slope is still given.
    const knob = cell('off', 'shifted');
    expect(knob.dPerUnit).toBeCloseTo(1, 12);
    expect(knob.relPerPct).toBeUndefined();
    expect(row('off').checks[0].relPerPct).toBeUndefined();
    expect(row('off').checks[0].why).toBe('off is zero, so a change of it has no relative size.');
  });

  it('takes the difference on the side that stays on the table, and says so', () => {
    // At VD = 1.2 V the device sits on the table's last vds node: the probe 1 % up is beyond it.
    const [r] = sheetSensitivities(
      stage({ params: stage().params.map((p) => (p.name === 'VD' ? { ...p, value: 1.2 } : p)) }),
      dev,
      undefined,
      { params: ['VD'] },
    );
    expect(r.error).toMatch(/differenced on the other side/);
    const gain = r.results.find((x) => x.name === 'gain')!;
    expect(Number.isFinite(gain.relPerPct)).toBe(true);
    expect(gain.deltaPlus).toBeNaN();
    expect(Number.isFinite(gain.deltaMinus)).toBe(true);
  });

  it('gives no numbers where the design itself reads beyond its table', () => {
    // At VD = 1.3 V the device is beyond its table at the design itself: no knob has numbers.
    const [r] = sheetSensitivities(
      stage({ params: stage().params.map((p) => (p.name === 'VD' ? { ...p, value: 1.3 } : p)) }),
      dev,
      undefined,
      { params: ['gm_id'] },
    );
    expect(r.results).toEqual([]);
    expect(r.checks).toEqual([]);
  });

  it('gives a solved value and a block’s provided values as rows, in the order the sheet writes them', () => {
    const doc = sheet('stages/cs-amp-diode-load.json');
    const base = runSheet(doc, table, undefined, REFS);
    const [r] = sheetSensitivities(doc, table, undefined, { refs: REFS, params: ['gm_id'] });
    const names = r.results.map((x) => x.name);
    const equations = (doc.equations ?? []).map((e) => e.name);
    expect(names.slice(0, equations.length)).toEqual(equations);
    expect(names[equations.length]).toBe('V_out');
    const vOut = r.results.find((x) => x.name === 'V_out')!;
    expect(vOut.unit).toBe('V');
    expect(vOut.base).toBe(base.values.V_out);
    expect(Number.isFinite(vOut.relPerPct)).toBe(true);
    expect(names).toContain('load__vgs');
    expect(names.filter((n) => n.includes('__')).every((n) => n in base.values)).toBe(true);
  });
});

/** One device with the derived quantities a formula reads, its operating point, and a gate
 *  voltage that bounds the drain voltage it is held at. */
const reader = (): SheetDoc => ({
  title: 'reader',
  polarity: 'n',
  formatVersion: 2,
  nodes: 'none',
  params: [
    { name: 'gm_id', value: 12, min: 6, max: 18, role: 'choice' },
    { name: 'VD', value: 0.6, unit: 'V', min: 0.2, max: 1.1, role: 'choice', class: 'independent' },
  ],
  givens: { L: '0.5u', gm_id: 'gm_id', id: '20u', vds: 'VD', vsb: '0' },
  equations: [
    { name: 'r_out', expr: 'ro' },
    { name: 'a0', expr: 'av0' },
    { name: 'f_t', expr: 'ft' },
    { name: 'eff', expr: 'gm_id' },
    { name: 'width', expr: 'W' },
    { name: 'gate', expr: 'vgs' },
    { name: 'current', expr: 'id' },
  ],
  checks: [
    { id: 'gain-spec', kind: 'spec', lhs: 'a0', op: '>=', rhs: '10' },
    { id: 'headroom', kind: 'physical', lhs: 'VD', op: '>=', rhs: 'vdsat' },
  ],
});

describe('the device-property view: which property each formula leans on', () => {
  const view = devicePropertySensitivities(reader(), dev);
  const col = (key: string) => view.columns.find((c) => c.key === key && c.device === 'givens')!;
  const cell = (key: string, name: string) => col(key).results.find((r) => r.name === name)!;

  it('moves ro and av0 by -1 % for +1 % of gds, and ft by +1 % for gm', () => {
    expect(view.error).toBeUndefined();
    expect(cell('gds', 'r_out').relPerPct).toBeCloseTo(-1, 9);
    expect(cell('gds', 'a0').relPerPct).toBeCloseTo(-1, 9);
    expect(cell('gm', 'f_t').relPerPct).toBeCloseTo(1, 9);
    expect(cell('gm', 'a0').relPerPct).toBeCloseTo(1, 9);
  });

  it('moves a bound gm/ID with gm, though the sizing restored it', () => {
    expect(cell('gm', 'eff').relPerPct).toBeCloseTo(1, 9);
  });

  it('holds the width, the gate voltage and the current: exactly zero, not read', () => {
    for (const key of ['gm', 'gds', 'cgg'])
      for (const name of ['width', 'gate', 'current']) expect(cell(key, name).relPerPct).toBe(0);
  });

  it('refuses a requirement on voltages or regions, and keeps one that reads a property', () => {
    expect(view.rows.checks).toEqual(['gain-spec']);
    expect(view.refused.map((x) => x.name)).toEqual(['headroom']);
    expect(view.refused[0].why).toMatch(/^headroom reads no small-signal property/);
    expect(col('gds').checks).toEqual([{ id: 'gain-spec', relPerPct: expect.closeTo(-1, 9) }]);
  });

  it('refuses a property the table does not hold, naming the column', () => {
    const missing = view.columns.find((c) => c.error);
    expect(missing?.error).toBe(
      `The table of the sheet’s own device holds no ${missing?.key} column.`,
    );
    expect(view.columns.filter((c) => !c.error).map((c) => c.key)).toEqual(
      expect.arrayContaining(['gm', 'gds', 'cgg']),
    );
    expect(view.columns.map((c) => c.key)).not.toContain('id');
    expect(view.columns.map((c) => c.key)).not.toContain('vth');
  });

  it('gives the design itself unchanged with the new options unset', () => {
    const a = evaluateSheet(reader(), dev);
    const b = evaluateSheet(reader(), dev, undefined, {});
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('pinning the solved values', () => {
  const doc = sheet('stages/cs-amp-diode-load.json');
  const base = evaluateSheet(withoutRange(doc), table);

  it('names every solved value of the tree by path', () => {
    const pinned = solvedValuesIn(doc, base);
    expect(pinned.V_out).toBe(base.values.V_out);
  });

  it('takes a pinned value as given and searches nothing', () => {
    // Pinned off its root, the value stays where it is put: a search would have moved it back.
    const off = base.values.V_out + 0.05;
    const res = evaluateSheet(withoutRange(doc), table, undefined, { pinned: { V_out: off } });
    expect(res.values.V_out).toBe(off);
    expect(res.solve).toBeUndefined();
    // Pinned at the root, the design is the base design.
    const same = evaluateSheet(withoutRange(doc), table, undefined, {
      pinned: solvedValuesIn(doc, base),
    });
    expect(same.values).toEqual(base.values);
  });

  it('marks a sheet where a solved value reads a small-signal property', () => {
    const view = devicePropertySensitivities(doc, table, undefined, { refs: REFS });
    expect(view.refused.map((x) => x.name)).toContain('V_out');
    expect(view.rows.results).not.toContain('V_out');
    expect(Array.isArray(view.solvedReads)).toBe(true);
  });
});

describe('the device-property view on a composed sheet', () => {
  it('moves a block’s device by its path, and only that device', () => {
    const doc = sheet('stages/cs-amp-diode-load.json');
    const view = devicePropertySensitivities(doc, table, undefined, { refs: REFS });
    const devices = [...new Set(view.columns.map((c) => c.device))];
    expect(devices).toEqual(expect.arrayContaining(['in', 'load']));
    // The load's gm moves none of the input device's provided values.
    const load = view.columns.find((c) => c.device === 'load' && c.key === 'gm')!;
    const own = load.results.filter((x) => x.name.startsWith('in__'));
    expect(own.length).toBeGreaterThan(0);
    for (const r of own) expect(r.relPerPct ?? 0).toBe(0);
  });

  it('counts the places one sizing stands in: both sides of a pair move together', () => {
    const view = devicePropertySensitivities(
      sheet('otas/differential-pair-tail.json'),
      table,
      undefined,
      {
        refs: REFS,
      },
    );
    expect(new Set(view.columns.filter((c) => c.device === 'in').map((c) => c.placements))).toEqual(
      new Set([2]),
    );
    expect(
      view.columns.filter((c) => c.device === 'tail').every((c) => c.placements === undefined),
    ).toBe(true);
  });

  it('marks a solved value whose own relation reads a small-signal property', () => {
    // A length solved for a gain: held here, it would move with gds in the hardware.
    const doc: SheetDoc = {
      ...reader(),
      params: [
        ...reader().params,
        {
          name: 'L',
          value: 0.5e-6,
          unit: 'm',
          min: 0.2e-6,
          max: 2e-6,
          designConstraint: { lhs: 'a0', rhs: '40' },
        },
      ],
      givens: { ...reader().givens!, L: 'L' },
    };
    const view = devicePropertySensitivities(doc, dev);
    expect(view.error).toBeUndefined();
    expect(view.solvedReads).toEqual(['L']);
    expect(view.refused.map((x) => x.name)).toContain('L');
  });
});
