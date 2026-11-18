// Today's result fields read the same as what the item list gives: the yes-or-no feasibility, a
// point's compliance state and each range end's, over every library sheet at its defaults and at
// each sweepable parameter's ends, and over sheets made to fail in each way a search can.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import { evaluateSheet, runSheet, withParams } from './index';
import { legacyFeasible, legacyPointState } from './derived';
import { causeFits } from './states';
import {
  sweepable,
  type CheckResult,
  type SheetBlockReport,
  type SheetDoc,
  type SheetResult,
} from './types';
import { loadLibrary, table, REFS } from './library.fixtures';

const dev = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });

/** The requirements that are advisory, by their path in the item list. */
function advisoryOf(
  res: { checks: CheckResult[]; blocks?: SheetBlockReport[] },
  path: string[] = [],
  out = new Set<string>(),
): Set<string> {
  for (const c of res.checks) if (c.kind === 'advisory') out.add([...path, c.id].join('.'));
  for (const b of res.blocks ?? []) advisoryOf(b, [...path, b.name], out);
  return out;
}

/** Every reading today's fields give, against what the items give: the result's feasibility and
 *  point state, every block report's feasibility at any depth, and each range end's state. */
function readings(res: SheetResult): { at: string; field: unknown; derived: unknown }[] {
  const items = res.items ?? [];
  const advisory = advisoryOf(res);
  const out: { at: string; field: unknown; derived: unknown }[] = [
    { at: 'feasible', field: res.feasible, derived: legacyFeasible(items, advisory) },
  ];
  if (res.point)
    out.push({ at: 'point', field: res.point.state, derived: legacyPointState(items, advisory) });
  const blocks = (reports: readonly SheetBlockReport[] | undefined, path: string): void => {
    for (const b of reports ?? []) {
      out.push({
        at: `block ${path}${b.name}`,
        field: b.feasible,
        derived: legacyFeasible(b.items ?? [], advisoryOf(b)),
      });
      blocks(b.blocks, `${path}${b.name}.`);
    }
  };
  blocks(res.blocks, '');
  for (const e of res.rangeEnds ?? [])
    if (e.items)
      out.push({
        at: `range end ${e.name}`,
        field: e.state,
        derived: legacyPointState(e.items, advisoryOf({ checks: e.checks, blocks: e.blocks })),
      });
  return out;
}

const expectSame = (res: SheetResult): void => {
  expect(res.items?.[0]).toMatchObject({ kind: 'sheet', path: [] });
  for (const i of res.items ?? [])
    if (i.status === 'failed') expect(causeFits(i.kind, i.cause)).toBe(true);
  for (const r of readings(res))
    expect({ at: r.at, value: r.derived }).toEqual({ at: r.at, value: r.field });
};

describe('today’s fields equal what the items give', () => {
  it('over every library sheet, at its defaults and at each sweepable parameter’s ends', () => {
    let runs = 0;
    for (const { doc } of loadLibrary()) {
      const cases: Record<string, number>[] = [{}];
      for (const p of doc.params)
        if (sweepable(p)) cases.push({ [p.name]: p.min }, { [p.name]: p.max });
      for (const over of cases) {
        expectSame(runSheet(withParams(doc, over), table, undefined, REFS));
        runs++;
      }
    }
    expect(runs).toBeGreaterThan(500);
  }, 600_000);

  const doc = (params: SheetDoc['params'], rest: Partial<SheetDoc> = {}): SheetDoc => ({
    title: 'forced',
    polarity: 'n',
    params,
    equations: [],
    checks: [],
    ...rest,
  });

  const forced: Record<string, SheetDoc> = {
    'no root in the stated range': doc(
      [
        { name: 'goal', value: 50 },
        { name: 'x', value: 0, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'goal' } },
      ],
      {
        equations: [{ name: 'y', expr: '2*x + 1' }],
        checks: [{ id: 'yc', kind: 'spec', lhs: 'y', op: '<=', rhs: '100' }],
      },
    ),
    'a set that does not settle': doc([
      { name: 'a', value: 0, min: 0, max: 10, designConstraint: { lhs: 'a', rhs: 'b + 1' } },
      { name: 'b', value: 0, min: 0, max: 10, designConstraint: { lhs: 'b', rhs: 'a + 1' } },
    ]),
    'a relation that does not read its param': doc([
      { name: 'x', value: 0, min: 0, max: 1, designConstraint: { lhs: 'q', rhs: '2' } },
      { name: 'q', value: 1 },
    ]),
    'a relation that evaluates nowhere': doc([
      { name: 'x', value: 0, min: 0, max: 1, designConstraint: { lhs: 'sqrt(-1-x)', rhs: '2' } },
    ]),
    'a declaration with no range': doc([
      { name: 'a', value: 0, min: 0, max: 10, designConstraint: { lhs: 'a*2', rhs: '3' } },
      { name: 'b', value: 0, designConstraint: { lhs: 'b', rhs: '2' } },
    ]),
    'a hold that gives no number': doc([{ name: 'h', value: 0.5, hold: 'h - nothing' }]),
    'a check that fails and one that gives no number': doc([{ name: 'a', value: 2 }], {
      equations: [{ name: 'r', expr: 'sqrt(-a)' }],
      checks: [
        { id: 'fails', kind: 'spec', lhs: 'a', op: '<=', rhs: '1' },
        { id: 'none', kind: 'spec', lhs: 'r', op: '<=', rhs: '1' },
        { id: 'hint', kind: 'advisory', lhs: 'a', op: '<=', rhs: '1' },
      ],
    }),
    'a device sized beyond its table': doc(
      [
        { name: 'L', value: 50e-6 },
        { name: 'I', value: 1e-5 },
      ],
      { givens: { L: 'L', id: 'I', gm_id: '10', vds: '0.6' } },
    ),
    'a block whose search fails': doc([], {
      blocks: [
        {
          name: 'c',
          doc: doc(
            [{ name: 'x', value: 0.5, min: 0, max: 1, designConstraint: { lhs: 'x', rhs: '5' } }],
            {
              provides: ['x'],
            },
          ),
        },
      ],
      equations: [{ name: 'y', expr: 'c__x*2' }],
    }),
  };

  for (const [name, d] of Object.entries(forced))
    it(`over a sheet made to fail: ${name}`, () => {
      const res = evaluateSheet(d, dev);
      expectSame(res);
      expect(res.verdict?.verdict).not.toBe('feasible');
    });

  const wideDev = generateDemoDevice({
    vds: { min: 0, max: 1.2, step: 0.05 },
    vsb: { min: 0, max: 0.4, step: 0.05 },
  });
  /** A sheet's own device in the current format, with an axis-sign selector `s` (its sign is
   *  wrong for this table at -1), its drain at `vds` and its body at `vsb`. */
  const own = (sign: number, vds: string, vsb: string, rest: Partial<SheetDoc> = {}): SheetDoc => ({
    title: 'own device',
    polarity: 'n',
    formatVersion: 2,
    nodes: 'none',
    params: [
      { name: 's', value: sign, convention: 'axis-sign' },
      { name: 'I', value: 2e-5 },
      { name: 'VD', value: 0.6, unit: 'V' },
    ],
    givens: { L: '0.5u', gm_id: '12', id: 'I', vds, vsb },
    equations: [],
    checks: [],
    ...rest,
  });

  /** Each place that writes today's feasibility, with a case that reaches it. */
  const sites: Record<string, () => SheetResult> = {
    'the fold of one evaluation, and a check that gives no number': () =>
      evaluateSheet(forced['a check that fails and one that gives no number'], dev),
    'a failed solve': () => evaluateSheet(forced['no root in the stated range'], dev),
    'a document in a format this app does not read': () =>
      runSheet({ ...own(1, '0.6', '0'), formatVersion: 99 } as unknown as SheetDoc, wideDev),
    'validation errors on a sheet that is still evaluated (a duplicate check id)': () =>
      runSheet(
        own(1, '0.6', 's*0', {
          checks: [
            { id: 'a', kind: 'spec', lhs: 'I', op: '>=', rhs: '0' },
            { id: 'a', kind: 'spec', lhs: 'I', op: '>=', rhs: '0' },
          ],
        }),
        wideDev,
      ),
    'a block that is not evaluated: a value its parent sets gives no number': () =>
      evaluateSheet(
        doc([], {
          blocks: [
            { name: 'c', doc: forced['a declaration with no range'], params: { a: 'nothing' } },
          ],
        }),
        dev,
      ),
    'a block that is not evaluated: a reference that is not resolved': () =>
      evaluateSheet(doc([], { blocks: [{ name: 'c', ref: 'no/such' }] }), dev),
    'a block report that copies its child': () =>
      evaluateSheet(forced['a block whose search fails'], dev),
    'a netlist finding at the top of a walked design': () =>
      evaluateSheet(own(-1, '0.6', 's*0'), wideDev),
    'a netlist finding in a block': () =>
      evaluateSheet(
        {
          ...own(1, '0.6', '0'),
          givens: undefined,
          blocks: [{ name: 'c', doc: own(-1, '0.6', 's*0') }],
        },
        wideDev,
      ),
    'a selector held to a device read beyond its table, on a design not walked': () =>
      evaluateSheet(own(-1, 's*0.6', '0'), wideDev),
    'a device read beyond its table in a held run': () =>
      evaluateSheet(
        own(1, 'VD', '0', { operatingRange: [{ name: 'hi', set: { VD: '1.3' } }] }),
        wideDev,
      ),
  };

  for (const [name, run] of Object.entries(sites))
    it(`at each place that writes it: ${name}`, () => {
      const res = run();
      expectSame(res);
      // Each case is a failure there: the design's, or the held run's at its range end.
      expect(res.feasible === false || res.rangeEnds?.[0]?.state === 'no-answer').toBe(true);
    });

  it('over the tail pair at a common mode its tail node cannot reach', () => {
    const tail = loadLibrary().find((s) => s.file === 'otas/differential-pair-tail.json')!.doc;
    const res = runSheet(withParams(tail, { CM_dc: 1.75 }), table, undefined, REFS);
    expectSame(res);
    // Today's fields read the design as failing; the items read it as not proved.
    expect(res.point?.state).toBe('does-not-comply');
    expect(res.verdict?.verdict).toBe('undetermined');
  });
});
