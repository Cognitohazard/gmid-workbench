// A solved param that states no range: a node's voltage takes the range its wiring gives it, a
// device's length the lengths its table holds; anything else — the design's scale — still needs
// its author's.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import { runSheet, validateSheet } from './index';
import { notACircuit, REFS, sheet, table } from './library.fixtures';
import { designFailure, type SheetDoc, type SheetResult, type SheetVar } from './types';

/** `doc` with the named param's min and max removed. */
const unranged = (doc: SheetDoc, name: string): SheetDoc => ({
  ...doc,
  params: doc.params.map((p): SheetVar => {
    if (p.name !== name) return p;
    const { min: _min, max: _max, ...rest } = p;
    return rest;
  }),
});

/** Every device's width in a result, by block path. */
const widths = (r: { sizing?: { W: number }; blocks?: readonly unknown[] }, at = ''): string[] => [
  ...(r.sizing ? [`${at || '(top)'} ${r.sizing.W.toPrecision(6)}`] : []),
  ...((r.blocks ?? []) as { name: string; sizing?: { W: number }; blocks?: unknown[] }[]).flatMap(
    (b) => widths(b, at ? `${at}.${b.name}` : b.name),
  ),
];

const errors = (r: SheetResult): string[] =>
  r.warnings.filter((w) => w.severity === 'error').map((w) => w.message);

describe('a node voltage that states no range', () => {
  const fiveT = sheet('otas/five-transistor-ota.json');

  it('is searched in the range its wiring gives it, and lands where the stated range does', () => {
    const stated = runSheet(fiveT, table, undefined, REFS);
    const open = runSheet(unranged(fiveT, 'V_tail'), table, undefined, REFS);
    expect(validateSheet(unranged(fiveT, 'V_tail')).filter((w) => w.severity === 'error')).toEqual(
      [],
    );
    expect(errors(open)).toEqual([]);
    expect(open.solve).toEqual({ kind: 'settled' });
    expect(Math.abs(open.values.V_tail - stated.values.V_tail)).toBeLessThan(1e-5);
    const range = open.ranges?.find((r) => r.param === 'V_tail');
    expect(range?.from).toBe('wiring');
    expect(range?.author).toBeUndefined();
    expect(range?.range[0]).toBe(0);
    expect(widths(open)).toEqual(widths(stated));
    // Where the hardware is held, the node is re-solved in the range its wiring gives it there.
    expect(stated.rangeEnds?.length).toBeGreaterThan(0);
    expect(open.rangeEnds?.map((e) => e.state)).toEqual(stated.rangeEnds?.map((e) => e.state));
  });

  it('inside a child sheet, takes its range from the wiring of the whole tree', () => {
    const wrap = (child: SheetDoc): SheetDoc => ({
      formatVersion: 2,
      title: 'wrapper',
      params: [],
      blocks: [{ name: 'amp', doc: child, ports: { vinp: 'vinp', vinn: 'vinn' } }],
      ports: ['vinp', 'vinn'],
      equations: [],
      checks: [],
    });
    const stated = runSheet(wrap(fiveT), table, undefined, REFS);
    const open = runSheet(wrap(unranged(fiveT, 'V_tail')), table, undefined, REFS);
    expect(errors(stated)).toEqual([]);
    expect(errors(open)).toEqual([]);
    expect(open.blocks?.[0].solve).toEqual({ kind: 'settled' });
    expect(widths(open)).toEqual(widths(stated));
  });
});

describe('a length that states no range', () => {
  const devBias = generateDemoDevice({
    vds: { min: 0, max: 1.2, step: 0.05 },
    vsb: { min: 0, max: 0.9, step: 0.05 },
  });
  /** A diode held at a width, its length solved for the drop it makes at a set current. */
  const bias = (vSet: number): SheetDoc =>
    notACircuit({
      title: 'diode at a set drop, at a set width',
      polarity: 'n',
      params: [
        { name: 'I_cbias', value: 1.6e-6, class: 'independent' },
        { name: 'V_set', value: vSet, class: 'independent' },
        { name: 'W_diode', value: 0.5e-6 },
        { name: 'L_d', value: 1e-6, unit: 'm', designConstraint: { lhs: 'd__W', rhs: 'W_diode' } },
      ],
      blocks: [
        {
          name: 'd',
          doc: {
            title: 'diode',
            polarity: 'n',
            params: [
              { name: 'L', value: 1e-6 },
              { name: 'I', value: 1e-6 },
              { name: 'V', value: 0.5 },
            ],
            givens: { L: 'L', id: 'I', vgs: 'V', diode: true },
            equations: [],
            checks: [],
            provides: ['W'],
          },
          params: { L: 'L_d', I: 'I_cbias', V: 'V_set' },
        },
      ],
      equations: [],
      checks: [],
    });

  it("is searched over the lengths its table holds, from the process's shortest", () => {
    const r = runSheet(bias(0.55), devBias);
    expect(errors(r)).toEqual([]);
    expect(r.solve).toEqual({ kind: 'settled' });
    expect(Math.abs(r.values.d__W / 0.5e-6 - 1)).toBeLessThan(1e-4);
    const range = r.ranges?.find((x) => x.param === 'L_d');
    const lengths = devBias.grid.axes.find((a) => a.name === 'l')!.values;
    expect(range).toMatchObject({
      from: 'table',
      range: [lengths[0], lengths[lengths.length - 1]],
    });
  });

  it('says the table does not reach, not that the design fails, where no length it holds will do', () => {
    const r = runSheet(bias(0.7), devBias);
    expect(r.feasible).toBe(false);
    expect(r.solve).toMatchObject({ kind: 'no-solution', unknown: 'L_d', from: 'table' });
    expect(designFailure(r.solve)).toBe(false);
    expect(r.solve && 'message' in r.solve ? r.solve.message : '').toMatch(
      /No length the table holds reaches the target/,
    );
  });
});

describe('the scale states its own range', () => {
  it('refuses a current with no range: nothing but its author says where to look', () => {
    const doc = unranged(sheet('mirrors-bias/widlar-current-source.json'), 'I_out');
    const said = validateSheet(doc).filter((w) => w.severity === 'error');
    expect(said.map((w) => w.message)).toEqual([
      'solved param "I_out" needs finite min < max — they are the range it is searched in, not slider bounds',
    ]);
  });

  it('refuses, with the reason, a volt-valued param that is no wire at all', () => {
    const fiveT = sheet('otas/five-transistor-ota.json');
    const doc: SheetDoc = {
      ...fiveT,
      params: [
        ...fiveT.params,
        { name: 'V_e', value: 0.5, unit: 'V', designConstraint: { lhs: 'V_e', rhs: '0.5' } },
      ],
    };
    // Validation cannot tell without the tables; the evaluation can, and says why.
    expect(validateSheet(doc).filter((w) => /"V_e"/.test(w.message))).toEqual([]);
    const r = runSheet(doc, table, undefined, REFS);
    expect(errors(r).join('\n')).toMatch(
      /no range can be read for "V_e" — it is not the level of any wire, and it sets no device's length/,
    );
  });
});
