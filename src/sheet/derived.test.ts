// Today's result fields read the same as what the item list gives: the yes-or-no feasibility, a
// point's compliance state and each range end's, over every library sheet at its defaults and at
// each sweepable parameter's ends, and over sheets made to fail in each way a search can.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import { evaluateSheet, runSheet, withParams } from './index';
import { resolvedSheet } from './resolve';
import { levelEligibility, setReads } from './validate';
import { legacyFeasible, legacyPointState } from './derived';
import {
  causeFits,
  heldVerdictOf,
  isComplete,
  setOf,
  verdictOf,
  type Cause,
  type Item,
} from './states';
import { describe as describeItem, standardProblems, VERDICT_WORDS, verdictText } from './describe';
import { FINDING_CAUSES } from './items';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  namesOf,
  sweepable,
  type CheckResult,
  type SheetBlock,
  type SheetBlockReport,
  type SheetDoc,
  type SheetResult,
} from './types';
import { loadLibrary, namedEnds, sheet, table, REFS } from './library.fixtures';
import { ekvTable } from '../demo/ekv.fixtures';
import type { DeviceTable } from '../types';

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
    {
      at: 'feasible',
      field: res.feasible,
      derived: legacyFeasible(
        items,
        advisory,
        (res.rangeEnds ?? []).map((e) => e.items),
      ),
    },
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
        // An end that is not calculated was not run today, or ran on a sheet whose validation
        // found an error about the sheet as a whole (see the suite of a range end's list).
        // An end refused on its own entry is not run, with nothing its run evaluated.
        derived: refusedOnEntry(e.name, e.items)
          ? 'not-run'
          : notCalculatedList(e.items)
            ? e.state === 'not-run' ||
              wholeSheetError(res) ||
              restsOnAssumed(e.items, res.items ?? [])
              ? e.state
              : 'calculated'
            : legacyPointState(e.items, advisoryOf({ checks: e.checks, blocks: e.blocks })),
      });
  return out;
}

/** Whether a range end's list holds an error of validation located on that end's own entry. */
const refusedOnEntry = (end: string, items: readonly Item[]): boolean =>
  items.some(
    (i) =>
      i.status === 'failed' &&
      (i.cause.kind === 'not-read' || i.cause.kind === 'not-determined') &&
      i.cause.data.stage === 'validation' &&
      'where' in i.cause.data &&
      i.cause.data.where === end,
  );

/** Whether a range end's list is the one of an end the engine does not calculate. */
const notCalculatedList = (items: readonly Item[]): boolean =>
  items.some(
    (i) =>
      i.kind === 'sheet' &&
      i.path.length === 0 &&
      i.status === 'withheld' &&
      i.on.some((o) => o.frame === 'design'),
  );

/** Whether an end is not calculated because the design point rests on an assumed level, which
 *  today's state reads as no answer. */
const restsOnAssumed = (items: readonly Item[], design: readonly Item[]): boolean =>
  items.every(
    (i) =>
      i.status === 'withheld' &&
      i.on.every((o) =>
        design.some(
          (d) =>
            d.kind === o.kind &&
            d.name === o.name &&
            d.path.join('.') === o.path.join('.') &&
            d.status === 'failed' &&
            d.cause.kind === 'not-determined' &&
            d.cause.data.why === 'assumed-level',
        ),
      ),
  );

/** Whether validation found an error about the sheet as a whole: the design point's list holds a
 *  finding of validation that the statements do not determine one design. */
const wholeSheetError = (res: SheetResult): boolean =>
  (res.items ?? []).some(
    (i) =>
      i.status === 'failed' &&
      i.cause.kind === 'not-determined' &&
      i.cause.data.stage === 'validation',
  );

/** The withheld items of a list whose dependency is not a failed item of the list with that
 *  item's cause. */
function danglingIn(items: readonly Item[]): string[] {
  const key = (r: { kind: string; path: readonly string[]; name: string }): string =>
    `${r.kind} ${[...r.path, r.name].filter(Boolean).join('.')}`;
  const failedAt = new Map(
    items.flatMap((i) => (i.status === 'failed' ? [[key(i), i.cause.kind] as const] : [])),
  );
  return items.flatMap((i) =>
    i.status === 'withheld'
      ? i.on
          .filter((o) => o.frame !== 'design' && failedAt.get(key(o)) !== o.cause)
          .map((o) => `${key(i)} -> ${key(o)}`)
      : [],
  );
}

/** The equations whose cause says that every name they read gives a number (`notFinite` empty)
 *  while one of those names has no finite value. */
function notFiniteFalse(doc: SheetDoc, res: SheetResult): string[] {
  return (res.items ?? []).flatMap((i) => {
    if (i.path.length || i.status !== 'failed' || i.cause.kind !== 'cannot-evaluate') return [];
    if (!i.cause.data.notFinite || i.cause.data.notFinite.length) return [];
    const e = doc.equations.find((x) => x.name === i.name);
    const bad = e
      ? namesOf(e.expr).filter((n) => n in res.values && !Number.isFinite(res.values[n]))
      : [];
    return bad.length ? [`${i.name} reads ${bad.join(', ')}`] : [];
  });
}

const expectSame = (res: SheetResult): void => {
  expect(verdictProblems(res)).toEqual([]);
  expect(res.items?.[0]).toMatchObject({ kind: 'sheet', path: [] });
  for (const i of res.items ?? [])
    if (i.status === 'failed') expect(causeFits(i.kind, i.cause)).toBe(true);
  for (const r of readings(res))
    expect({ at: r.at, value: r.derived }).toEqual({ at: r.at, value: r.field });
  // Every item reads to the message standard, and the text module gives every item its lines.
  const all: Item[] = [...(res.items ?? [])];
  const walk = (bs: readonly SheetBlockReport[] | undefined): void => {
    for (const b of bs ?? []) {
      all.push(...(b.items ?? []));
      walk(b.blocks);
    }
  };
  walk(res.blocks);
  for (const e of res.rangeEnds ?? []) all.push(...(e.items ?? []));
  for (const i of all) expect(() => describeItem(i)).not.toThrow();
  expect(
    all.flatMap((i) =>
      describeItem(i)
        .segments.filter((l) => standardProblems(l).length)
        .map((l) => l.map((x) => x.text).join('')),
    ),
  ).toEqual([]);
  // Every margin line of a bound gives the margin as a percentage: 100 × |left − right| / |right|.
  // An equality's margin is measured from its tolerance band, which the cause does not hold.
  for (const i of all)
    if (i.status === 'failed' && i.cause.kind === 'fails' && i.cause.data.text.op !== '==') {
      const { lhs, rhs } = i.cause.data;
      const line = describeItem(i).lines.find((l) => l.startsWith('The margin is'));
      const shown = Number(/([\d.]+)(k?) %/.exec(line ?? '')?.[1]);
      const want = (100 * Math.abs(lhs - rhs)) / Math.max(Math.abs(rhs), 1e-30);
      if (want >= 1e-3 && want < 1e4) expect(shown).toBeCloseTo(Number(want.toPrecision(3)), 6);
    }
  // Every withheld item depends on an item of the list that failed, with that item's cause: read
  // on each full list, where a block's own sheet item finds its parent's items.
  for (const list of [res.items ?? [], ...(res.rangeEnds ?? []).map((e) => e.items ?? [])])
    expect(danglingIn(list)).toEqual([]);
  // An end that is not calculated waits on items of the design point's list, each failed with the
  // cause it names.
  for (const e of res.rangeEnds ?? [])
    for (const i of e.items ?? [])
      if (i.status === 'withheld')
        for (const o of i.on)
          if (o.frame === 'design') {
            const hit = res.items?.find(
              (x) =>
                x.kind === o.kind && x.name === o.name && x.path.join('.') === o.path.join('.'),
            );
            expect({
              on: o.name,
              cause: hit?.status === 'failed' ? hit.cause.kind : undefined,
            }).toEqual({ on: o.name, cause: o.cause });
          }
};

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

/** What no run may give: an item withheld on a requirement that only fails, which stops nothing
 *  from evaluating; and an undetermined verdict with neither a failed item nor a held one. */
function verdictProblems(res: SheetResult): string[] {
  const out: string[] = [];
  const failsAt = new Set(
    (res.items ?? []).flatMap((i) =>
      i.status === 'failed' && i.cause.kind === 'fails' ? [[...i.path, i.name].join('.')] : [],
    ),
  );
  for (const i of res.items ?? [])
    if (i.status === 'withheld')
      for (const o of i.on)
        if (o.cause === 'fails' || failsAt.has([...o.path, o.name].join('.')))
          out.push(`${i.kind} ${i.name} withheld on ${o.name}, which fails`);
  const v = res.verdict;
  if (v?.verdict === 'undetermined' && !v.failed?.length && !v.held?.length)
    out.push('undetermined with no failed and no held item');
  return out;
}

/** Every line of every item of a run, the blocks' and the range ends' lists included, that breaks
 *  the message standard, with the line. */
function textProblems(res: SheetResult): string[] {
  const all: Item[] = [...(res.items ?? [])];
  const walk = (bs: readonly SheetBlockReport[] | undefined): void => {
    for (const b of bs ?? []) {
      all.push(...(b.items ?? []));
      walk(b.blocks);
    }
  };
  walk(res.blocks);
  for (const e of res.rangeEnds ?? []) all.push(...(e.items ?? []));
  return all.flatMap((i) =>
    describeItem(i).segments.flatMap((l) =>
      standardProblems(l).map((p) => `${p}: ${l.map((x) => x.text).join('')}`),
    ),
  );
}

describe('every text the library gives on each device reads to the message standard, and no verdict rests on a requirement that only fails', () => {
  // The library table, the EKV table and the simple test device read the sheets differently:
  // a search steps in at a different edge on each, so each gives texts the others do not.
  const devices: [string, DeviceTable][] = [
    ['the EKV table', ekvTable()],
    ['the simple test device', generateDemoDevice()],
  ];
  for (const [name, device] of devices)
    it(`on ${name}, at the defaults and at each sweepable parameter’s ends`, () => {
      const found: string[] = [];
      let runs = 0;
      for (const { file, doc } of loadLibrary()) {
        const cases: Record<string, number>[] = [{}];
        for (const p of doc.params)
          if (sweepable(p)) cases.push({ [p.name]: p.min }, { [p.name]: p.max });
        for (const over of cases) {
          const res = runSheet(withParams(doc, over), device, undefined, REFS);
          for (const p of [...textProblems(res), ...verdictProblems(res)])
            found.push(`${file} ${JSON.stringify(over)} ${p}`);
          runs++;
        }
      }
      expect([...new Set(found)]).toEqual([]);
      expect(runs).toBeGreaterThan(500);
    }, 600_000);
});

describe('today’s fields equal what the items give', () => {
  it('over every library sheet, at its defaults and at each sweepable parameter’s ends', () => {
    let runs = 0;
    for (const { doc } of loadLibrary()) {
      const cases: Record<string, number>[] = [{}];
      for (const p of doc.params)
        if (sweepable(p)) cases.push({ [p.name]: p.min }, { [p.name]: p.max });
      for (const over of cases) {
        const res = runSheet(withParams(doc, over), table, undefined, REFS);
        expectSame(res);
        expect(notFiniteFalse(withParams(doc, over), res)).toEqual([]);
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
      expect(notFiniteFalse(d, res)).toEqual([]);
      expect(res.verdict?.verdict).not.toBe('feasible');
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
});

describe('an item that gives no number', () => {
  const declaredIn = (doc: SheetDoc, res: SheetResult, n: string): boolean =>
    doc.params.some((p) => p.name === n) ||
    doc.equations.some((e) => e.name === n) ||
    n in res.values ||
    n in (res.withheld ?? {});

  it('is not defined only where no entry of the sheet declares the name it reads', () => {
    for (const { doc } of loadLibrary()) {
      const cases: Record<string, number>[] = [{}];
      for (const p of doc.params)
        if (sweepable(p)) cases.push({ [p.name]: p.min }, { [p.name]: p.max });
      for (const over of cases) {
        const d = withParams(doc, over);
        const res = runSheet(d, table, undefined, REFS);
        for (const i of res.items ?? [])
          if (
            i.path.length === 0 &&
            i.status === 'failed' &&
            i.cause.kind === 'cannot-evaluate' &&
            i.cause.data.why === 'not-defined'
          )
            expect({ item: i.name, declared: declaredIn(d, res, i.cause.data.name) }).toEqual({
              item: i.name,
              declared: false,
            });
      }
    }
  }, 600_000);

  it('is withheld on a name it reads whose own item is not ok, not called undefined', () => {
    const d = withParams(sheet('multistage/two-stage-cascode-comp-ota.json'), { gm_id_casc: 4 });
    const res = runSheet(d, table, undefined, REFS);
    const item = (name: string): Item | undefined =>
      res.items?.find((i) => i.path.length === 0 && i.name === name);
    expect(item('PM')?.status).toBe('withheld');
    expect(item('pm-spec')?.status).toBe('withheld');
    for (const name of ['PM', 'pm-spec']) {
      const i = item(name);
      if (i?.status === 'withheld') expect(i.on.map((o) => o.name)).toContain('wu');
    }
    expectSame(res);
  });

  it('withholds the region requirement of a device that was not sized on that device', () => {
    const d = withParams(sheet('applications/gm-c-filter-pole.json'), { gm_id: 12 * 0.2 });
    const res = runSheet(d, table, undefined, REFS);
    const device = res.items?.find((i) => i.kind === 'device' && i.path.length === 0);
    expect(device?.status).toBe('failed');
    const region = res.items?.find((i) => i.kind === 'requirement' && i.name === 'region');
    expect(region).toMatchObject({
      status: 'withheld',
      on: [{ kind: 'device', path: [], name: 'givens' }],
    });
    // One cause, one failed item.
    expect(res.items?.filter((i) => i.status === 'failed').map((i) => i.kind)).toEqual(['device']);
    expectSame(res);
  });
});

describe('a search that stopped at the edge of a table', () => {
  it('reads not proved, with its stated range, never no solution in that range', () => {
    const d = withParams(sheet('mirrors-bias/cascode-current-mirror.json'), { V_out: 0.05 });
    const res = runSheet(d, table, undefined, REFS);
    const k = res.items?.find(
      (i) => i.kind === 'search' && i.path.length === 0 && i.name === 'k_x',
    );
    expect(k?.status).toBe('failed');
    if (k?.status !== 'failed') return;
    expect(k.cause).toMatchObject({ kind: 'no-crossing', data: { notProof: 'end-not-read' } });
    if (k.cause.kind === 'no-crossing') expect(k.cause.data.searched).toEqual([0, 2]);
    expectSame(res);
  });
});

describe('the table from a finding’s rule to its cause', () => {
  it('has an entry for every rule the sheet’s validation and evaluation raise', () => {
    const dir = join(__dirname);
    const rules = new Set<string>();
    for (const f of readdirSync(dir))
      if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.fixtures.ts'))
        for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/rule: '(sheet-[a-z-]+)'/g))
          rules.add(m[1]);
    expect(rules.size).toBeGreaterThanOrEqual(18);
    expect([...rules].filter((r) => !(r in FINDING_CAUSES)).sort()).toEqual([]);
  });

  it('lists as never an error only rules whose every finding in the source is a warning or a note', () => {
    const dir = join(__dirname);
    const raisedAsError = new Set<string>();
    for (const f of readdirSync(dir))
      if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.fixtures.ts')) {
        const src = readFileSync(join(dir, f), 'utf8');
        for (const m of src.matchAll(/rule: '(sheet-[a-z-]+)'/g)) {
          // The object literal the rule is written in, to its closing brace.
          const at = m.index ?? 0;
          const open = src.lastIndexOf('{', at);
          const close = src.indexOf('}', at);
          const literal = src.slice(open, close);
          // A severity written only as literal warnings or notes is never an error; one that
          // names 'error', or is not written as literals, may be.
          const value = /severity(?::\s*([^,\n]+))?/.exec(literal)?.[1];
          if (!value || /'error'/.test(value) || !/'(info|warning)'/.test(value))
            raisedAsError.add(m[1]);
        }
      }
    const neverAnError = Object.entries(FINDING_CAUSES)
      .filter(([, read]) => read === 'never-an-error')
      .map(([rule]) => rule);
    expect(neverAnError.filter((r) => raisedAsError.has(r)).sort()).toEqual([]);
  });

  it('reads a missing decision as a design not determined, never as an entry not read', () => {
    const d = namedEnds(sheet('otas/five-transistor-ota.json'));
    const p = d.params.find((x) => x.name === 'V_tail') as { designConstraint?: unknown };
    delete p.designConstraint;
    const res = runSheet(d, table, undefined, REFS);
    const v = res.items?.find((i) => i.path.length === 0 && i.name === 'V_tail');
    expect(v).toMatchObject({
      status: 'failed',
      cause: { kind: 'not-determined', data: { why: 'decision-missing', names: ['V_tail'] } },
    });
    for (const i of res.items ?? [])
      if (i.kind === 'sheet' && i.path.length === 0 && i.status === 'failed')
        expect(i.cause.kind).not.toBe('not-read');
    expectSame(res);
  });
});

describe('a current balance that gives no number', () => {
  it('is a search that cannot be calculated, naming the part read beyond its table', () => {
    const d = withParams(namedEnds(sheet('otas/inverter-based-ota.json')), { gm_id_n: 18 });
    const res = runSheet(d, table, undefined, REFS);
    const s = res.items?.find(
      (i) => i.kind === 'search' && i.path.length === 0 && i.name === 'I_bias',
    );
    expect(s).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'cannot-evaluate',
        data: { hold: { param: 'I_bias' }, by: { kind: 'device', path: ['p'] } },
      },
    });
    // Today's fields read it as they did: a false declaration of I_bias.
    expect(res.solve).toMatchObject({ kind: 'declaration-false', param: 'I_bias' });
    expectSame(res);
  });
});

describe('a block that is not evaluated', () => {
  it('names what it waits on in its parent’s terms, and the parent resolves it', () => {
    const d = withParams(namedEnds(sheet('otas/five-transistor-ota.json')), { CM_dc: 1.75 });
    const res = runSheet(d, table, undefined, REFS);
    const report = res.blocks?.find((b) => b.name === 'tail');
    const own = report?.items?.find((i) => i.kind === 'sheet' && i.path.length === 0);
    expect(own).toMatchObject({
      status: 'withheld',
      on: [{ kind: 'search', path: [], name: 'V_tail', frame: 'parent' }],
    });
    if (own?.status === 'withheld') expect(own.on[0].cause).toBeUndefined();
    const inParent = res.items?.find((i) => i.kind === 'sheet' && i.path.join('.') === 'tail');
    expect(inParent).toMatchObject({
      status: 'withheld',
      on: [{ kind: 'search', name: 'V_tail' }],
    });
    if (inParent?.status === 'withheld') {
      expect(inParent.on[0].frame).toBeUndefined();
      expect(inParent.on[0].cause).toBeDefined();
    }
    expectSame(res);
  });
});

describe('a member of a set whose search failed where the others were held', () => {
  it('fails with its own cause and its set, and the others of the set wait on it', () => {
    const d = withParams(namedEnds(sheet('otas/five-transistor-ota.json')), { CM_dc: 1.75 });
    const res = runSheet(d, table, undefined, REFS);
    const search = (n: string): Item | undefined =>
      res.items?.find((i) => i.kind === 'search' && i.path.length === 0 && i.name === n);
    const tail = search('V_tail');
    expect(tail?.status).toBe('failed');
    if (tail?.status !== 'failed') return;
    expect(tail.cause.kind).not.toBe('did-not-settle');
    expect(setOf(tail.cause)?.map((m) => m.unknown)).toEqual(['V_tail', 'out_share']);
    expect(search('out_share')).toMatchObject({
      status: 'withheld',
      on: [{ kind: 'search', name: 'V_tail', cause: tail.cause.kind }],
    });
    const lines = describeItem(tail).lines;
    expect(lines).toContain('V_tail and out_share depend on each other.');
    expect(
      lines.some((l) => /^The engine held out_share at .* during this search\.$/.test(l)),
    ).toBe(true);
    // Today's fields read it as the set not settling.
    expect(res.solve).toMatchObject({ kind: 'not-settled', why: 'member' });
    expect(res.verdict?.verdict).toBe('undetermined');
    expectSame(res);
  });

  it('is never read as proof that the design has none', () => {
    const d = withParams(namedEnds(sheet('otas/five-transistor-ota.json')), { CM_dc: 1.75 });
    const res = runSheet(d, table, undefined, REFS);
    const tail = res.items?.find((i) => i.name === 'V_tail' && i.status === 'failed');
    if (tail?.status !== 'failed' || tail.cause.kind !== 'no-crossing') return;
    const proved: Cause = {
      kind: 'no-solution',
      data: { ...tail.cause.data, shown: 'monotonic' },
    };
    expect(verdictOf([{ ...tail, cause: proved }]).verdict).toBe('undetermined');
  });
});

describe('a search whose relation gives no number where it searched', () => {
  it('cannot be calculated, and names the part read beyond its table', () => {
    const d = withParams(namedEnds(sheet('otas/five-transistor-ota.json')), { L_in: 5e-6 });
    const res = runSheet(d, table, undefined, REFS);
    const failed = (res.items ?? []).filter(
      (i) => i.kind === 'search' && i.path.length === 0 && i.status === 'failed',
    );
    expect(failed.length).toBeGreaterThan(0);
    for (const f of failed) {
      if (f.status !== 'failed') continue;
      const c = f.cause.kind === 'cannot-evaluate' ? f.cause : undefined;
      expect(c?.data.unevaluable).toBeDefined();
      expect(c?.data.outside?.quantity).toBe('l');
    }
    for (const i of res.items ?? [])
      if (i.status === 'failed') expect(i.cause.kind).not.toBe('did-not-settle');
    expect(res.solve).toMatchObject({ kind: 'not-settled' });
    expectSame(res);
  });
});

describe('the texts of a search that stopped short, and of a block in its own list', () => {
  it('names the range given and the stretch searched, and each end by its value', () => {
    const fd = loadLibrary().find((s) => s.file === 'multistage/fd-telescopic-ota.json')!.doc;
    const res = runSheet(withParams(fd, { CM_dc: 1.3 }), table, undefined, REFS);
    const s = res.items?.find((i) => i.kind === 'search' && i.status === 'failed');
    const lines = s ? describeItem(s).lines : [];
    expect(lines).toContain('The physical range of wire tail is from 0 V to 0.95 V.');
    expect(lines).toContain('Above 0.523 V, part in is outside its table.');
    expect(lines).toContain('CM_in is 0.567 V at the low end and 1.2 V at 0.523 V.');
    expect(lines.some((l) => /full physical range|the high end|engine searched it/.test(l))).toBe(
      false,
    );
  });

  it('names the block, in its own list, as waiting on its parent sheet', () => {
    const d = withParams(namedEnds(sheet('otas/five-transistor-ota.json')), { CM_dc: 1.75 });
    const res = runSheet(d, table, undefined, REFS);
    const own = res.blocks
      ?.find((b) => b.name === 'tail')
      ?.items?.find((i) => i.kind === 'sheet' && i.path.length === 0);
    expect(own && describeItem(own, ['tail']).lines).toEqual([
      'Block tail is not calculated, because its parent sheet gives it no value for vds_t.',
    ]);
  });
});

describe('an item that gives no number while what it reads was withheld', () => {
  /** The failed items that give no number while a name they read is in the withheld map, and the
   *  failed items that give no number with no reason at all. */
  const misread = (doc: SheetDoc, res: SheetResult): string[] => {
    const exprs = new Map<string, string[]>([
      ...doc.equations.map((e): [string, string[]] => [`value ${e.name}`, [e.expr]]),
      ...doc.checks.map((c): [string, string[]] => [`requirement ${c.id}`, [c.lhs, c.rhs]]),
    ]);
    const out: string[] = [];
    for (const i of res.items ?? []) {
      if (i.path.length || i.status !== 'failed' || i.cause.kind !== 'cannot-evaluate') continue;
      if (i.cause.data.why !== 'not-finite') continue;
      const reads = (exprs.get(`${i.kind} ${i.name}`) ?? []).flatMap((x) => [...namesOf(x)]);
      if (reads.some((n) => n in (res.withheld ?? {})))
        out.push(`${i.kind} ${i.name} reads withheld`);
    }
    return out;
  };

  it('is withheld on what the withheld map traces the name to, for a part beyond its table', () => {
    const cases: [string, Record<string, number>][] = [
      ['applications/sc-settling-to-ota-spec.json', {}],
      ['otas/inverter-based-ota.json', {}],
    ];
    for (const [file, base] of cases) {
      const doc = sheet(file);
      const over: Record<string, number> = { ...base };
      const pick = file.includes('sc-settling') ? 'gm_id_in' : 'VDD';
      const p = doc.params.find((q) => q.name === pick)!;
      over[pick] = p.value * 0.2;
      const d = withParams(doc, over);
      const res = runSheet(d, table, undefined, REFS);
      expect({ file, misread: misread(d, res) }).toEqual({ file, misread: [] });
      expectSame(res);
    }
  });

  it('never happens over the library runs', () => {
    for (const { file, doc } of loadLibrary()) {
      const cases: Record<string, number>[] = [{}];
      for (const p of doc.params)
        if (sweepable(p)) cases.push({ [p.name]: p.min }, { [p.name]: p.max });
      for (const over of cases) {
        const d = withParams(doc, over);
        const res = runSheet(d, table, undefined, REFS);
        expect({ file, over, misread: misread(d, res) }).toEqual({ file, over, misread: [] });
      }
    }
  }, 600_000);
});

describe('a solved param the run held at a given value', () => {
  const heldIn = (res: SheetResult, name: string): Item | undefined =>
    res.items?.find((i) => i.kind === 'search' && i.path.length === 0 && i.name === name);

  it('is ok, marked held with its value and unchecked relation, and the verdict is undetermined', () => {
    const doc = resolvedSheet(namedEnds(sheet('otas/five-transistor-ota.json')), REFS).doc;
    const free = evaluateSheet(doc, table);
    const res = evaluateSheet(doc, table, undefined, { pinned: { V_tail: 0.4 } });
    expect(heldIn(res, 'V_tail')).toEqual({
      kind: 'search',
      path: [],
      name: 'V_tail',
      status: 'ok',
      attributes: {
        kind: 'held',
        value: 0.4,
        unit: 'V',
        relation: { lhs: 'CM_in', rhs: 'CM_dc', field: 'designConstraint' },
      },
    });
    expect(res.verdict?.verdict).toBe('undetermined');
    expect(res.verdict?.held).toEqual([{ kind: 'search', path: [], name: 'V_tail' }]);
    // The run that solves it reads no held item.
    expect(free.verdict?.held).toBeUndefined();
    expectSame(res);
  });

  it('runs each range end with the search held, marks it held there, and reads each undetermined', () => {
    const doc = resolvedSheet(namedEnds(sheet('otas/five-transistor-ota.json')), REFS).doc;
    const res = evaluateSheet(doc, table, undefined, { pinned: { V_tail: 0.4 } });
    expect(res.rangeEnds?.length).toBe(2);
    for (const e of res.rangeEnds ?? []) {
      expect(e.checks.length).toBeGreaterThan(0);
      expect(heldIn({ ...res, items: e.items }, 'V_tail')).toMatchObject({
        status: 'ok',
        attributes: { kind: 'held', value: 0.4 },
      });
      expect(e.verdict).toMatchObject({
        verdict: 'undetermined',
        held: [{ kind: 'search', path: [], name: 'V_tail' }],
      });
    }
  });

  it('decides the verdict ahead of a requirement that fails, on a forced sheet', () => {
    const d: SheetDoc = {
      title: 'held',
      polarity: 'n',
      params: [
        { name: 'goal', value: 3 },
        { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'x', rhs: 'goal' } },
      ],
      equations: [],
      checks: [{ id: 'xc', kind: 'spec', lhs: 'x', op: '<=', rhs: '0' }],
    };
    const res = evaluateSheet(d, dev, undefined, { pinned: { x: 2 } });
    expect(heldIn(res, 'x')?.status).toBe('ok');
    expect(res.verdict).toMatchObject({
      verdict: 'undetermined',
      held: [{ kind: 'search', name: 'x' }],
      failed: [{ kind: 'requirement', name: 'xc', cause: { kind: 'fails' } }],
    });
    expectSame(res);
  });
});

describe('an entry that is not well formed', () => {
  it('fails the entry it names as not read, with the kind of entry, never the evaluated sheet', () => {
    const dup = runSheet(
      own(1, '0.6', 's*0', {
        checks: [
          { id: 'a', kind: 'spec', lhs: 'I', op: '>=', rhs: '0' },
          { id: 'a', kind: 'spec', lhs: 'I', op: '>=', rhs: '0' },
        ],
      }),
      wideDev,
    );
    expect(dup.items?.find((i) => i.kind === 'requirement' && i.name === 'a')).toMatchObject({
      status: 'failed',
      cause: { kind: 'not-read', data: { why: 'field', entry: 'check', where: 'a' } },
    });
    expect(dup.items?.[0].status).toBe('ok');
    expectSame(dup);

    const selector = runSheet(own(0.5, '0.6', 's*0'), wideDev);
    expect(selector.items?.find((i) => i.name === 's')).toMatchObject({
      status: 'failed',
      cause: { kind: 'not-read', data: { why: 'field', entry: 'selector', where: 's' } },
    });
    expectSame(selector);
  });
});

describe('a finding with no item of its own', () => {
  const wired = (nodes: unknown, rest: Partial<SheetDoc> = {}): SheetDoc =>
    own(1, '0.6', '0', { nodes, levels: { vdd: '1.2' }, ...rest } as Partial<SheetDoc>);

  it('fails the sheet item of a range end’s own list where its set gives no number', () => {
    const res = evaluateSheet(
      own(1, 'VD', '0', { operatingRange: [{ name: 'lo', set: { VD: 'nonsense_name' } }] }),
      wideDev,
    );
    expect(res.rangeEnds?.[0].items).toEqual([
      {
        kind: 'sheet',
        path: [],
        name: '',
        status: 'failed',
        cause: {
          kind: 'cannot-evaluate',
          data: {
            why: 'not-defined',
            name: 'nonsense_name',
            reason: 'did not evaluate to a finite number against the base result',
            rangeEnd: { name: 'lo', param: 'VD', expression: 'nonsense_name' },
          },
        },
      },
    ]);
    expectSame(res);
  });

  it('puts a netlist finding on the device or selector it names, else on the sheet with its wires', () => {
    const selector = evaluateSheet(own(-1, '0.6', 's*0'), wideDev);
    expect(selector.items?.find((i) => i.name === 's')).toMatchObject({
      kind: 'value',
      status: 'failed',
      cause: {
        kind: 'not-determined',
        data: {
          why: 'netlist',
          netlist: [{ problem: 'selector', devices: ['givens'], param: 's' }],
        },
      },
    });
    expectSame(selector);

    const badWire = runSheet(wired({ d: 'vdd', g: 'a.b', s: 'gnd', b: 'gnd' }), wideDev);
    expect(badWire.items?.find((i) => i.kind === 'device')).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'not-determined',
        data: {
          why: 'netlist',
          names: ['a.b'],
          netlist: [{ problem: 'wire-name', wires: ['a.b'], devices: ['givens'] }],
        },
      },
    });
    expectSame(badWire);

    const lone = runSheet(wired({ d: 'vdd', g: 'lone', s: 'gnd', b: 'gnd' }), wideDev);
    expect(lone.items?.[0]).toMatchObject({
      kind: 'sheet',
      status: 'failed',
      cause: {
        kind: 'not-determined',
        data: { why: 'netlist', names: ['lone'], netlist: [{ problem: 'one-terminal' }] },
      },
    });
    expectSame(lone);
  });
});

describe('the data an item carries for its text', () => {
  const plain = (rest: Partial<SheetDoc>): SheetDoc => ({
    title: 'forced',
    polarity: 'n',
    params: [{ name: 'a', value: 1 }],
    equations: [],
    checks: [],
    ...rest,
  });
  const at = (res: SheetResult, kind: Item['kind'], name: string): Item | undefined =>
    res.items?.find((i) => i.kind === kind && i.name === name && i.path.length === 0);

  it('a syntax error carries its expression and where the parser stops', () => {
    const res = runSheet(plain({ equations: [{ name: 'y', expr: 'a +* a' }] }), dev);
    expect(at(res, 'value', 'y')).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'cannot-evaluate',
        data: { why: 'syntax', syntax: { expression: 'a +* a', at: 3 } },
      },
    });
    expectSame(res);
  });

  it('a value that more than one statement sets carries the fields that set it', () => {
    const res = runSheet(
      plain({
        params: [
          { name: 'a', value: 1 },
          { name: 'goal', value: 2 },
          {
            name: 'x',
            value: 1,
            min: 0,
            max: 10,
            designConstraint: { lhs: 'x', rhs: 'goal' },
            solveFor: 'goal',
          },
        ],
      }),
      dev,
    );
    const twice = res.items?.find(
      (i) =>
        i.status === 'failed' &&
        i.cause.kind === 'not-determined' &&
        i.cause.data.why === 'decision-twice',
    );
    expect(twice).toMatchObject({
      cause: { data: { statements: [{ name: 'x', fields: ['designConstraint', 'solveFor'] }] } },
    });
    expectSame(res);
  });

  it('an equation whose own arithmetic gives no number says that each name it reads gives one', () => {
    const res = runSheet(plain({ equations: [{ name: 'y', expr: 'a / 0' }] }), dev);
    expect(at(res, 'value', 'y')).toMatchObject({
      status: 'failed',
      cause: { kind: 'cannot-evaluate', data: { why: 'not-finite', notFinite: [] } },
    });
    expectSame(res);
  });

  it('a failing region check carries its region, in volts', () => {
    const res = runSheet(
      own(1, '0.02', '0', {
        givens: { L: '0.5u', gm_id: '5', id: 'I', vds: '0.02', vsb: '0', region: 'saturation' },
      }),
      wideDev,
    );
    expect(at(res, 'requirement', 'region')).toMatchObject({
      status: 'failed',
      cause: { kind: 'fails', data: { region: 'saturation', unit: 'V' } },
    });
    expectSame(res);
  });

  it('a block its parent gives no value names the inputs it waits for', () => {
    const res = runSheet(
      withParams(namedEnds(sheet('otas/five-transistor-ota.json')), { CM_dc: 1.75 }),
      table,
      undefined,
      REFS,
    );
    const own = res.blocks
      ?.find((b) => b.name === 'tail')
      ?.items?.find((i) => i.kind === 'sheet' && i.path.length === 0);
    expect(own).toMatchObject({ status: 'withheld', on: [{ frame: 'parent', inputs: ['vds_t'] }] });
    expectSame(res);
  });
});

describe('the items of the second audit', () => {
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const lib = (d: SheetDoc): SheetResult => runSheet(d, table, undefined, REFS);
  const top = (
    res: SheetResult,
    kind: Item['kind'],
    name: string,
    path: string[] = [],
  ): Item | undefined =>
    res.items?.find(
      (i) => i.kind === kind && i.name === name && i.path.join('/') === path.join('/'),
    );
  const tail = namedEnds(sheet('otas/differential-pair-tail.json'));
  const ota = namedEnds(sheet('otas/five-transistor-ota.json'));

  it('keeps two netlist findings on one item, in the order raised', () => {
    const d = clone(tail);
    (d.blocks![0] as { ports: Record<string, string> }).ports.vdd = 'lonely';
    const res = lib(d);
    expect(top(res, 'sheet', '')).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'not-determined',
        data: {
          why: 'netlist',
          names: ['vdd', 'lonely'],
          netlist: [
            { problem: 'level-unnamed', wires: ['vdd'] },
            { problem: 'one-terminal', wires: ['lonely'] },
          ],
        },
      },
    });
    expectSame(res);
  });

  it('gives a check written twice one item, which the finding that its id is doubled takes', () => {
    const d = clone(tail);
    d.checks.push(clone(d.checks.find((c) => c.id === 'gain-spec')!));
    const res = lib(withParams(d, { gm_id_in: 25 }));
    expect(res.items?.filter((i) => i.kind === 'requirement' && i.name === 'gain-spec')).toEqual([
      expect.objectContaining({
        status: 'failed',
        cause: expect.objectContaining({
          kind: 'not-read',
          data: expect.objectContaining({ entry: 'check' }),
        }),
      }),
    ]);
    expectSame(res);
  });

  it('fails a param that is not a number as the list is built, and withholds what reads it', () => {
    const d = clone(tail);
    (d.params.find((p) => p.name === 'CL') as { value: unknown }).value = 'text';
    const res = lib(d);
    expect(top(res, 'value', 'CL')).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'not-read',
        data: { field: { name: 'value', value: 'text', problem: 'not-a-number' } },
      },
    });
    for (const n of ['GBW', 'SR'])
      expect(top(res, 'value', n)).toMatchObject({
        status: 'withheld',
        on: [{ kind: 'value', name: 'CL', cause: 'not-read' }],
      });
    expectSame(res);
    expect(notFiniteFalse(d, res)).toEqual([]);
  });

  it('reads a block override that names no child param as the block entry, naming the key', () => {
    const d = clone(tail);
    (d.blocks!.find((b) => b.name === 'tail')!.params as Record<string, string>).nope = '1';
    const res = lib(d);
    expect(top(res, 'sheet', '', ['tail'])).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'not-read',
        data: { entry: 'block', field: { name: 'params', key: 'nope', problem: 'unknown-name' } },
      },
    });
    expectSame(res);
  });

  it('puts a range end’s validation finding on that end’s own list', () => {
    const d = clone(tail);
    d.operatingRange![0].set = { NOPE: '1' };
    const res = lib(d);
    // The design point was calculated: its list holds no copy of the finding, and the sheet's
    // verdict reads the end's list, so it is not feasible while the finding stands.
    expect(top(res, 'sheet', '')?.status).toBe('ok');
    expect(res.verdict?.verdict).not.toBe('feasible');
    expect(res.rangeEnds?.[0].items?.[0]).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'not-read',
        data: { entry: 'range-end', field: { name: 'set', key: 'NOPE', problem: 'unknown-name' } },
      },
    });
    expectSame(res);
  });

  it('refuses a range end whose expression does not parse, or reads a name that is not typed, with one item', () => {
    const d = clone(ota);
    d.operatingRange![0].set = { CM_dc: '((' };
    const res = lib(d);
    expect(res.rangeEnds?.[0]).toMatchObject({ state: 'not-run', set: {}, checks: [] });
    expect(res.rangeEnds?.[0].items).toEqual([
      expect.objectContaining({
        status: 'failed',
        cause: expect.objectContaining({
          kind: 'not-read',
          data: expect.objectContaining({
            field: expect.objectContaining({ name: 'set', key: 'CM_dc', problem: 'syntax' }),
          }),
        }),
      }),
    ]);
    expectSame(res);
    const u = clone(ota);
    u.operatingRange![0].set = { CM_dc: 'nonsense_name' };
    const r2 = lib(u);
    expect(r2.rangeEnds?.[0]).toMatchObject({ state: 'not-run', set: {}, checks: [] });
    expect(r2.rangeEnds?.[0].items).toEqual([
      expect.objectContaining({
        status: 'failed',
        cause: expect.objectContaining({
          kind: 'not-read',
          data: expect.objectContaining({
            where: 'cm-lo',
            message: expect.stringContaining('"nonsense_name"'),
          }),
        }),
      }),
    ]);
    expectSame(r2);
  });

  it('refuses a range end that sets a value from a derived quantity, and leaves the other end as it was', () => {
    // The equation takes the name of the elementary charge: the end reads the equation.
    const d = clone(ota);
    d.equations.push({ name: 'q', expr: 'CM_lo + 0' });
    d.operatingRange![0].set = { CM_dc: 'q' };
    const res = lib(d);
    const plain = lib(clone(ota));
    const finding = res.warnings.filter((w) => w.rule === 'sheet-range' && w.severity === 'error');
    expect(finding).toHaveLength(1);
    expect(finding[0].message).toContain('"q"');
    expect(finding[0].message).toContain('type the value');
    expect(res.rangeEnds?.[0]).toMatchObject({
      name: 'cm-lo',
      state: 'not-run',
      set: {},
      checks: [],
    });
    const kept = (e: (typeof res.rangeEnds & object)[number] | undefined) =>
      e && { state: e.state, set: e.set, checks: e.checks };
    expect(kept(res.rangeEnds?.[1])).toEqual(kept(plain.rangeEnds?.[1]));
    expect(res.verdict?.verdict).toBe(plain.verdict?.verdict);
    expectSame(res);
  });

  it('refuses a range end whose name is not allowed, with no checks and an empty set', () => {
    const d = clone(ota);
    d.operatingRange![0].name = 'cm@lo';
    const res = lib(d);
    const plain = lib(clone(ota));
    expect(res.rangeEnds?.[0]).toMatchObject({ state: 'not-run', set: {}, checks: [] });
    expect(res.rangeEnds?.[0].items).toEqual([
      expect.objectContaining({
        status: 'failed',
        cause: expect.objectContaining({ kind: 'not-read' }),
      }),
    ]);
    expect(res.rangeEnds?.[1]).toEqual(plain.rangeEnds?.[1]);
    expectSame(res);
  });

  it('reads a check with an operator the engine does not know as not read, and keeps today’s field', () => {
    const d = clone(ota);
    (d.checks[0] as { op: string }).op = '>>';
    const res = lib(d);
    expect(top(res, 'requirement', d.checks[0].id)).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'not-read',
        data: { entry: 'check', field: { name: 'op', value: '>>', problem: 'operator' } },
      },
    });
    expectSame(res);
    // Its two sides equal: today's result judges it an equality that passes, and the field reads
    // feasible; the item is not read, and the derivation still gives today's field.
    const eq = runSheet(
      {
        title: 'op',
        polarity: 'n',
        params: [{ name: 'a', value: 1 }],
        equations: [],
        checks: [{ id: 'c', kind: 'spec', lhs: '1', op: '>>' as never, rhs: '1' }],
      },
      dev,
    );
    expect(eq.feasible).toBe(true);
    expect(eq.verdict?.verdict).toBe('undetermined');
    expectSame(eq);
  });

  it('reads a tolerance that is not a number on an equality as the tolerance not read', () => {
    const d = clone(tail);
    Object.assign(d.checks[0], { op: '==', tolPct: 'x' });
    const res = lib(d);
    expect(top(res, 'requirement', d.checks[0].id)).toMatchObject({
      cause: {
        kind: 'not-read',
        data: { entry: 'tolerance', field: { name: 'tolPct', value: 'x' } },
      },
    });
    expectSame(res);
  });

  it('withholds the blocks downstream of a value that is not read, and of a block not resolved', () => {
    const a = clone(ota);
    (a.params.find((p) => p.name === 'I_tail') as { value: unknown }).value = 'abc';
    const ra = lib(a);
    expect(top(ra, 'sheet', '', ['bias'])).toMatchObject({
      status: 'withheld',
      on: [{ kind: 'value', name: 'I_tail', cause: 'not-read' }],
    });
    expect(top(ra, 'search', 'V_tail')).toMatchObject({
      status: 'withheld',
      on: [{ name: 'I_tail' }],
    });
    expectSame(ra);
    const b = clone(ota);
    (b.blocks![0] as { ref?: string }).ref = 'nope/nope';
    delete (b.blocks![0] as { doc?: unknown }).doc;
    const rb = lib(b);
    expect(top(rb, 'sheet', '', ['tail'])).toMatchObject({
      status: 'withheld',
      on: [{ kind: 'sheet', path: ['bias'], cause: 'not-read' }],
    });
    expectSame(rb);
  });

  it('withholds a search that nothing evaluates on the item that failed there', () => {
    const d = clone(ota);
    d.equations.find((e) => e.name === 'CM_in')!.expr = 'VDD +* 1';
    const res = lib(d);
    expect(top(res, 'search', 'V_tail')).toMatchObject({
      status: 'withheld',
      on: [{ kind: 'value', name: 'CM_in', cause: 'cannot-evaluate' }],
    });
    expect(res.verdict?.failed).toEqual([
      expect.objectContaining({ kind: 'value', name: 'CM_in' }),
    ]);
    expectSame(res);
    // On the EKV table the first part to fail is the tail, whose sizing derives no transconductance.
    const ekv = runSheet(withParams(ota, { L_in: 5e-6 }), ekvTable(), undefined, REFS);
    const v = top(ekv, 'search', 'V_tail');
    expect(v).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'cannot-evaluate',
        data: {
          by: { kind: 'device', path: ['tail'], name: 'givens' },
          unevaluable: { at: { where: 'nowhere' } },
        },
      },
    });
    const at =
      v?.status === 'failed' && 'cause' in v && v.cause.kind === 'cannot-evaluate'
        ? v.cause.data.unevaluable?.at
        : undefined;
    const first = at?.where === 'nowhere' ? at.points[0]?.failed[0] : undefined;
    expect(first).toMatchObject({
      ref: { kind: 'device', path: ['tail'], name: 'givens' },
      cause: { kind: 'cannot-evaluate', data: { sizing: { quantity: 'gm' } } },
    });
    expectSame(ekv);
  });
});

describe('a search that nothing evaluates, beside a requirement that only fails', () => {
  it('keeps its own cause, and is never withheld on the requirement', () => {
    const d = sheet('mirrors-bias/wide-swing-cascode-mirror.json');
    const min = d.params.find((q) => q.name === 'V_out')!.min as number;
    const res = runSheet(withParams(d, { V_out: min }), ekvTable(), undefined, REFS);
    expect(res.items?.find((i) => i.name === 'k_x')).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'cannot-evaluate',
        data: {
          by: { kind: 'device', path: ['out'] },
          unevaluable: {
            at: {
              where: 'nowhere',
              points: expect.arrayContaining([
                expect.objectContaining({
                  failed: expect.arrayContaining([
                    expect.objectContaining({
                      ref: expect.objectContaining({ kind: 'device', path: ['out'] }),
                      cause: expect.objectContaining({
                        data: expect.objectContaining({
                          sizing: expect.objectContaining({ quantity: 'gm' }),
                        }),
                      }),
                    }),
                  ]),
                }),
              ]),
            },
          },
        },
      },
    });
    expect(res.verdict?.failed).toEqual([expect.objectContaining({ kind: 'search', name: 'k_x' })]);
    expect(verdictProblems(res)).toEqual([]);
  });

  it('gives a reference to no sheet the same sentence in the block’s own list', () => {
    const d = JSON.parse(
      JSON.stringify(namedEnds(sheet('otas/five-transistor-ota.json'))),
    ) as SheetDoc;
    (d.blocks![0] as { ref?: string }).ref = 'nope/nope';
    delete (d.blocks![0] as { doc?: unknown }).doc;
    const res = runSheet(d, table, undefined, REFS);
    const own = res.blocks?.find((b) => b.name === 'bias')?.items?.[0];
    expect(own).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'not-read',
        data: { why: 'reference', field: { name: 'ref', value: 'nope/nope' } },
      },
    });
    expect(describeItem(own!).lines).toEqual(
      describeItem(res.items!.find((i) => i.kind === 'sheet' && i.path.join() === 'bias')!).lines,
    );
  });
});

describe('a placement that is not well formed', () => {
  it('says which fault it is, as validation found it', () => {
    const doc = sheet('mirrors-bias/matched-mirror-bank.json');
    const res = runSheet(
      {
        ...doc,
        nodes: { d: 'out', g: 'nref', s: 'gnd', bulk: 'gnd', intent: 'on' },
      } as unknown as SheetDoc,
      table,
      undefined,
      REFS,
    );
    // On the sheet's own item: a finding of its netlist. The device's own item is not failed by it.
    expect(res.items?.find((i) => i.kind === 'device' && i.path.length === 0)?.status).toBe('ok');
    const own = res.items?.find((i) => i.kind === 'sheet' && i.path.length === 0);
    const netlist =
      own?.status === 'failed' &&
      own.cause.kind === 'not-determined' &&
      own.cause.data.why === 'netlist'
        ? own.cause.data.netlist
        : undefined;
    expect(netlist?.filter((n) => n.problem === 'placement').map((n) => n.placement)).toEqual([
      { fault: 'unknown-key', key: 'bulk' },
      { fault: 'no-wire', terminal: 'b' },
      { fault: 'intent', value: 'on' },
    ]);
    expectSame(res);
  });
});

describe('the list of a range end', () => {
  const ota = namedEnds(sheet('otas/five-transistor-ota.json'));
  const run = (doc: SheetDoc): SheetResult => runSheet(doc, table, undefined, REFS);
  const top = (items: readonly Item[] | undefined): Item | undefined =>
    items?.find((i) => i.kind === 'sheet' && i.path.length === 0);

  it('takes the findings of validation about the entries its run evaluates', () => {
    const res = run({
      ...ota,
      checks: ota.checks.map((c) => (c.id === 'gain-spec' ? { ...c, op: '==', tolPct: -1 } : c)),
    } as SheetDoc);
    const gain = (items: readonly Item[] | undefined): Item | undefined =>
      items?.find((i) => i.kind === 'requirement' && i.name === 'gain-spec');
    expect(gain(res.items)).toMatchObject({
      status: 'failed',
      cause: { kind: 'not-read', data: { why: 'field', entry: 'tolerance', stage: 'validation' } },
    });
    for (const e of res.rangeEnds ?? []) expect(gain(e.items)).toEqual(gain(res.items));
    expectSame(res);
  });

  it('is not calculated where validation finds an error about the sheet as a whole', () => {
    const res = run({
      ...ota,
      blocks: ota.blocks?.map((b) =>
        b.name === 'tail' ? { ...b, nodes: { ...(b.nodes as object), bulk: 'gnd' } } : b,
      ),
    } as SheetDoc);
    for (const e of res.rangeEnds ?? []) {
      // Today's state is the run's, beside the list that does not read it.
      expect(e.state).toBe('does-not-comply');
      expect(e.items).toEqual([
        {
          kind: 'sheet',
          path: [],
          name: '',
          status: 'withheld',
          on: [{ kind: 'sheet', path: [], name: '', frame: 'design', cause: 'not-determined' }],
        },
      ]);
    }
    expectSame(res);
  });

  it('never reads compliant on a sheet whose validation finds an error', () => {
    const broken: [string, SheetDoc][] = [
      [
        'tolerance',
        {
          ...ota,
          checks: ota.checks.map((c) =>
            c.id === 'gain-spec' ? { ...c, op: '==', tolPct: -1 } : c,
          ),
        },
      ],
      [
        'netlist',
        {
          ...ota,
          blocks: ota.blocks?.map((b) =>
            b.name === 'tail' ? { ...b, nodes: { ...(b.nodes as object), bulk: 'gnd' } } : b,
          ),
        } as SheetDoc,
      ],
      ['param', withParams(ota, { Av_target: Number.NaN })],
      [
        'range end',
        {
          ...ota,
          operatingRange: ota.operatingRange?.map((e, k) =>
            k ? e : { ...e, set: { CM_dc: '((' } },
          ),
        },
      ],
      [
        'equation',
        {
          ...ota,
          equations: [...ota.equations, { name: 'broken_eq', expr: '((' }],
        },
      ],
    ];
    // Every requirement of the sheet made advisory, so that none fails and decides the verdict.
    const soft = (d: SheetDoc): SheetDoc => ({
      ...d,
      checks: d.checks.map((c) => ({ ...c, kind: 'advisory' })),
    });
    for (const [what, d] of broken) {
      const res = run(soft(d));
      expect({ what, error: res.warnings.some((w) => w.severity === 'error') }).toEqual({
        what,
        error: true,
      });
      // A finding about one range end is about that end alone: the other end is read as it is.
      for (const e of res.rangeEnds ?? [])
        if (what !== 'range end' || e.name === 'cm-lo')
          expect({ what, end: e.name, verdict: heldVerdictOf(e.items ?? []).verdict }).not.toEqual({
            what,
            end: e.name,
            verdict: 'compliant',
          });
    }
    // The same sheet with no error reads compliant at its ends, so the cases above are not
    // compliant for the error alone.
    const res = run(soft(ota));
    expect(res.rangeEnds?.map((e) => heldVerdictOf(e.items ?? []).verdict)).toEqual([
      'compliant',
      'compliant',
    ]);
    expect(top(res.items)?.status).toBe('ok');
  }, 60_000);
});

describe('a range end that is not calculated, in the design point’s terms', () => {
  const ota = namedEnds(sheet('otas/five-transistor-ota.json'));

  it('waits on a level the design point rests on as assumed', () => {
    const { out: _out, ...levels } = (ota as unknown as { levels: Record<string, string> }).levels;
    const doc = {
      ...ota,
      levels,
      params: ota.params.map((p) => (p.name === 'V_out_dc' ? { ...p, class: 'assumed' } : p)),
    } as SheetDoc;
    const res = runSheet(doc, table, undefined, REFS);
    for (const e of res.rangeEnds ?? []) {
      expect(e.verdict).toBeUndefined();
      expect(e.items).toEqual([
        {
          kind: 'sheet',
          path: [],
          name: '',
          status: 'withheld',
          on: [
            {
              kind: 'value',
              path: [],
              name: 'V_out_dc',
              frame: 'design',
              cause: 'not-determined',
            },
          ],
        },
      ]);
    }
    expectSame(res);
  });
});

describe('the verdict of a sheet whose range end’s own entry failed', () => {
  it('reads the end, names its item with the end’s name, and keeps no copy on the design point', () => {
    const ota = namedEnds(sheet('otas/five-transistor-ota.json'));
    const doc: SheetDoc = {
      ...ota,
      checks: ota.checks.map((c) => ({ ...c, kind: 'advisory' })),
      operatingRange: ota.operatingRange?.map((e, k) => (k ? e : { ...e, set: { CM_dc: '((' } })),
    };
    const res = runSheet(doc, table, undefined, REFS);
    expect(res.feasible).toBe(false);
    expect((res.items ?? []).filter((i) => i.status !== 'ok' && i.kind !== 'requirement')).toEqual(
      [],
    );
    expect(isComplete(res)).toBe(true);
    expect(res.verdict?.verdict).toBe('undetermined');
    expect(res.verdict?.failed).toEqual([
      expect.objectContaining({
        kind: 'sheet',
        path: [],
        name: '',
        end: 'cm-lo',
        cause: expect.objectContaining({ kind: 'not-read' }),
      }),
    ]);
    expectSame(res);
  });
});

describe('a part whose placement is not well formed', () => {
  it('is that placement’s finding alone, not a part that names no wires', () => {
    const ota = namedEnds(sheet('otas/five-transistor-ota.json'));
    const doc = {
      ...ota,
      blocks: ota.blocks?.map((b) => (b.name === 'in' ? { ...b, nodes: 5 } : b)),
    } as unknown as SheetDoc;
    const res = runSheet(doc, table, undefined, REFS);
    const problems = res.warnings.flatMap((w) =>
      w.about?.kind === 'netlist' ? [[w.about.problem, w.about.devices]] : [],
    );
    expect(problems).toEqual([['placement', ['in']]]);
    expectSame(res);
  });
});

describe('a range end whose own entry is not well formed, or gives no number', () => {
  const ota = namedEnds(sheet('otas/five-transistor-ota.json'));
  // Every requirement advisory, so that none fails and decides the verdict.
  const soft: SheetDoc = { ...ota, checks: ota.checks.map((c) => ({ ...c, kind: 'advisory' })) };
  const withSet = (set: Record<string, string>): SheetDoc => ({
    ...soft,
    operatingRange: soft.operatingRange?.map((e, k) => (k ? e : { ...e, set })),
  });
  const cases: [string, Record<string, string>, boolean, string][] = [
    ['a set that does not parse', { CM_dc: '((' }, false, 'undetermined'],
    ['a set of a name that is not an input', { NOPE: '1' }, false, 'undetermined'],
    ['a set that gives no number at this design', { CM_dc: 'sqrt(0-1)' }, true, 'feasible'],
    ['a set that reads a name no entry declares', { CM_dc: 'nothing_here' }, false, 'undetermined'],
  ];
  for (const [what, set, feasible, verdict] of cases)
    it(`reads ${verdict} where ${what}, with today's feasibility the same`, () => {
      const res = runSheet(withSet(set), table, undefined, REFS);
      expect({ feasible: res.feasible, verdict: res.verdict?.verdict }).toEqual({
        feasible,
        verdict,
      });
      expect(res.feasible).toBe(res.verdict?.verdict === 'feasible');
      // The end is not answered, whatever the verdict of the sheet.
      expect(res.rangeEnds?.[0].verdict).toBeUndefined();
      expectSame(res);
    });
});

describe('a level that cannot hold a wire', () => {
  it('says why, as validation found it', () => {
    const ota = namedEnds(sheet('otas/five-transistor-ota.json'));
    const doc = {
      ...ota,
      params: ota.params.map((p) => (p.name === 'V_out_dc' ? { ...p, class: 'assumed' } : p)),
    } as SheetDoc;
    const res = runSheet(doc, table, undefined, REFS);
    const refused = res.warnings.flatMap((w) =>
      w.about?.kind === 'netlist' && w.about.problem === 'level-refused' ? [w.about] : [],
    );
    expect(refused).toEqual([
      expect.objectContaining({
        wires: ['out'],
        level: 'V_out_dc',
        refused: [{ reason: 'class', name: 'V_out_dc', cls: 'assumed' }],
      }),
    ]);
    expectSame(res);
  });

  it('gives one reason for each name the level itself reads, and follows only an alias', () => {
    const base = namedEnds(sheet('otas/five-transistor-ota.json'));
    const ota = resolvedSheet(
      {
        ...base,
        params: base.params.map((p) => (p.name === 'V_out_dc' ? { ...p, class: 'assumed' } : p)),
      } as SheetDoc,
      REFS,
    ).doc;
    const reasons = (doc: SheetDoc, level: string, e: string) => {
      const v = levelEligibility(doc, level, e);
      return v.kind === 'refused' ? v.reasons : v.kind;
    };
    expect(reasons(ota, '', 'CM_in')).toEqual([{ reason: 'equation', name: 'CM_in' }]);
    expect(reasons(ota, '', 'in__vgs')).toEqual([{ reason: 'device', device: 'in' }]);
    expect(reasons(ota, '', 'V_out_dc + V_tail')).toEqual([
      { reason: 'class', name: 'V_out_dc', cls: 'assumed' },
      { reason: 'class', name: 'V_tail', cls: 'solved' },
    ]);
    expect(reasons(ota, '', 'V_tail')).toEqual([
      { reason: 'class', name: 'V_tail', cls: 'solved' },
    ]);
    expect(reasons(ota, '', 'nope')).toEqual([{ reason: 'unresolved', name: 'nope' }]);
    expect(reasons(ota, '', 'V_out_dc')).toEqual([
      { reason: 'class', name: 'V_out_dc', cls: 'assumed' },
    ]);
    expect(reasons(ota, '', 'gm_id_in')).toEqual([
      { reason: 'class', name: 'gm_id_in', cls: 'unclassified' },
    ]);
    expect(reasons(ota, '', 'V_out_dc + nope + CM_in + in__vgs + gm_id_in + VDD')).toEqual([
      { reason: 'class', name: 'V_out_dc', cls: 'assumed' },
      { reason: 'unresolved', name: 'nope' },
      { reason: 'equation', name: 'CM_in' },
      { reason: 'device', device: 'in' },
      { reason: 'class', name: 'gm_id_in', cls: 'unclassified' },
    ]);
    expect(reasons(ota, '', 'VDD')).toBe('held');
    // A block param its parent overrides from a device's quantity: the device, as the parent
    // names it.
    const mirror = resolvedSheet(sheet('mirrors-bias/cascode-current-mirror.json'), REFS).doc;
    expect(reasons(mirror, 'ref_casc', 'vsb_rc')).toEqual([{ reason: 'device', device: 'ref' }]);
    // A node a hold re-solves: the device whose gate the hold keeps.
    const fvf = resolvedSheet(sheet('multistage/flipped-voltage-follower.json'), REFS).doc;
    expect(reasons(fvf, '', 'V_out')).toEqual([
      { reason: 'class', name: 'V_out', cls: 'held', device: 'in' },
    ]);
  });
});

describe('a wiring fault of a part', () => {
  it('is a finding of the netlist of the sheet that wires it, on that sheet’s own item', () => {
    const ota = namedEnds(sheet('otas/five-transistor-ota.json'));
    const doc = {
      ...ota,
      blocks: ota.blocks?.map((b) =>
        b.name === 'in' ? { ...b, nodes: { ...(b.nodes as object), x: 'gnd' } } : b,
      ),
    } as SheetDoc;
    const res = runSheet(doc, table, undefined, REFS);
    const item = (path: string[]): Item | undefined =>
      res.items?.find((i) => i.kind === 'sheet' && i.path.join('.') === path.join('.'));
    expect(item([])).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'not-determined',
        data: {
          why: 'netlist',
          netlist: [
            {
              problem: 'placement',
              devices: ['in'],
              placement: { fault: 'unknown-key', key: 'x' },
            },
          ],
        },
      },
    });
    expect(item(['in'])?.status).toBe('ok');
    for (const e of res.rangeEnds ?? [])
      expect(e.items).toEqual([
        {
          kind: 'sheet',
          path: [],
          name: '',
          status: 'withheld',
          on: [{ kind: 'sheet', path: [], name: '', frame: 'design', cause: 'not-determined' }],
        },
      ]);
    expectSame(res);
  });

  it('puts a short and a diode flag its wires contradict on the sheet that wires the part', () => {
    const ota = namedEnds(sheet('otas/five-transistor-ota.json'));
    const run = (doc: SheetDoc) => {
      const res = runSheet(doc, table, undefined, REFS);
      const sheets = (res.items ?? []).filter((i) => i.kind === 'sheet' && i.status === 'failed');
      return { res, sheets };
    };
    // Part in with its drain and source on one wire.
    const short = run({
      ...ota,
      blocks: ota.blocks?.map((b) =>
        b.name === 'in' ? { ...b, nodes: { ...(b.nodes as object), s: 'out' } } : b,
      ),
    } as SheetDoc);
    expect(short.sheets).toEqual([
      expect.objectContaining({
        path: [],
        cause: expect.objectContaining({
          data: expect.objectContaining({
            netlist: [{ problem: 'short', wires: ['out'], devices: ['in'] }],
          }),
        }),
      }),
    ]);
    expect(describeItem(short.sheets[0]).lines).toEqual([
      'The statements of the sheet do not determine one design.',
      'Part in has its drain and its source on wire out, which shorts it.',
    ]);
    expectSame(short.res);
    // The diode side of the load with its diode flag off, its wires a diode connection.
    const flag = run({
      ...ota,
      blocks: ota.blocks?.map((b) =>
        b.name === 'ldr' && b.doc
          ? { ...b, doc: { ...b.doc, givens: { ...b.doc.givens, diode: false } } }
          : b,
      ),
    } as SheetDoc);
    expect(flag.sheets).toEqual([
      expect.objectContaining({
        path: [],
        cause: expect.objectContaining({
          data: expect.objectContaining({
            netlist: [{ problem: 'diode-flag', devices: ['ldr'], diodeFlag: false }],
          }),
        }),
      }),
    ]);
    expectSame(flag.res);
  });
});

describe('a range end behind a level that cannot hold a wire', () => {
  const endLines = (level: string, assumed = false): readonly string[] => {
    const ota = namedEnds(sheet('otas/five-transistor-ota.json'));
    const doc = {
      ...ota,
      levels: { ...(ota as { levels?: object }).levels, out: level },
      params: ota.params.map((p) =>
        assumed && p.name === 'V_out_dc' ? { ...p, class: 'assumed' } : p,
      ),
    } as SheetDoc;
    const res = runSheet(doc, table, undefined, REFS);
    const end = res.rangeEnds?.[0];
    return end?.items?.[0]
      ? describeItem(end.items[0], [], { end: end.name, design: res.items }).lines
      : [];
  };

  it('carries the reason, or how many there are', () => {
    expect(endLines('V_tail')).toEqual([
      'Range end cm-lo is not calculated, because the statements of the sheet do not determine one design.',
      'At the design point, the level V_tail cannot hold wire out, because the engine solves V_tail.',
    ]);
    expect(endLines('V_out_dc + nope + CM_in')).toEqual([
      'Range end cm-lo is not calculated, because the statements of the sheet do not determine one design.',
      'At the design point, the level V_out_dc + nope + CM_in cannot hold wire out, for 2 reasons.',
    ]);
    expect(endLines('V_out_dc', true)).toEqual([
      'Range end cm-lo is not calculated, because the statements of the sheet do not determine one design.',
      'At the design point, the level V_out_dc cannot hold wire out, because V_out_dc is marked assumed.',
      'At the design point, V_out_dc is an assumed level.',
    ]);
  });
});

describe('a level that reads a param a range end substitutes', () => {
  it('a level may read a param that a range end substitutes; the substitute is not a reason', () => {
    // The five-transistor OTA holds wire vdd at VDD. A range end that sets VDD to an expression
    // is evaluated on the finished design, where its substitute is a number: the level is still
    // the designer's, whatever the substitute reads (a loop through VDD itself, a solved param,
    // an equation, a device quantity, or a number). A set that reads anything but numbers,
    // constants and typed params is refused on its own entry, and that end is not run.
    const ota = namedEnds(sheet('otas/five-transistor-ota.json'));
    for (const set of ['VDD*0.9', 'V_tail + 1.2', 'CM_in + 1.0', 'in__vgs', '1.62']) {
      const doc = {
        ...ota,
        operatingRange: [...(ota.operatingRange ?? []), { name: 'vdd-lo', set: { VDD: set } }],
      } as SheetDoc;
      expect(levelEligibility(resolvedSheet(doc, REFS).doc, '', 'VDD'), set).toEqual({
        kind: 'held',
      });
      const res = runSheet(doc, table, undefined, REFS);
      expect(
        res.warnings.filter(
          (w) => w.about?.kind === 'netlist' && w.about.problem === 'level-refused',
        ),
        set,
      ).toEqual([]);
      const end = res.rangeEnds?.find((e) => e.name === 'vdd-lo');
      if (setReads(doc, set).length) expect(end?.state, set).toBe('not-run');
      else expect(end?.verdict, set).toBeDefined();
      expectSame(res);
    }
  });
});

describe('a level that reads a value a hold balancing currents solves', () => {
  it('gives the reason and what to write, and no gate wire to hold', () => {
    // The CMOS inverter amplifier's I_bias is held by "I_bias - p__id": a hold that balances two
    // currents and keeps no gate.
    const inv = sheet('stages/cmos-inverter-amp.json');
    const doc = {
      ...inv,
      levels: { ...(inv as { levels?: object }).levels, out: 'I_bias' },
    } as SheetDoc;
    const res = runSheet(doc, table, undefined, REFS);
    const item = res.items?.find((i) => i.kind === 'sheet' && i.path.length === 0);
    expect(item?.status).toBe('failed');
    expect(describeItem(item as Item).lines).toEqual([
      'The statements of the sheet do not determine one design.',
      'The level I_bias cannot hold wire out.',
      'The level reads I_bias, which the engine calculates again where the design is held, so the level is derived.',
      'Write the level as a number, or from values marked independent.',
    ]);
  });
});

describe('a block report carries its own verdict, read as the sheet’s is', () => {
  const blockAt = (res: SheetResult, path: readonly string[]): SheetBlockReport | undefined => {
    let blocks = res.blocks;
    let b: SheetBlockReport | undefined;
    for (const n of path) {
      b = blocks?.find((x) => x.name === n);
      blocks = b?.blocks;
    }
    return b;
  };
  const ownItem = (b: SheetBlockReport | undefined) =>
    b?.items?.find((i) => i.kind === 'sheet' && i.path.length === 0);

  it('a block that is calculated reads its verdict; one its parent gives no value has none', () => {
    // The cascode mirror's output at its lowest: the reference side sizes, and the output side is
    // withheld on what its parent sets for it.
    const d = sheet('mirrors-bias/cascode-current-mirror.json');
    const p = d.params.find((q) => q.name === 'V_out') as { min: number };
    const res = runSheet(withParams(d, { V_out: p.min }), table, undefined, REFS);
    for (const n of ['ref', 'ref_casc'])
      expect(blockAt(res, [n])?.verdict).toEqual({ verdict: 'feasible', failed: [] });
    const out = blockAt(res, ['out']);
    expect(ownItem(out)?.status).toBe('withheld');
    expect(out).not.toHaveProperty('verdict');
  });

  it('a block whose requirement fails is non-compliant, on that requirement', () => {
    const d = sheet('applications/sc-settling-to-ota-spec.json');
    const p = d.params.find((q) => q.name === 'vds_in') as { value: number };
    const res = runSheet(withParams(d, { vds_in: p.value * 0.2 }), table, undefined, REFS);
    const b = blockAt(res, ['in']);
    expect(ownItem(b)?.status).toBe('ok');
    expect(b?.verdict?.verdict).toBe('non-compliant');
    expect(b?.verdict?.failed).toEqual([
      expect.objectContaining({ kind: 'requirement', path: [], name: 'region' }),
    ]);
  });

  it('a block inside a block reads its own verdict too', () => {
    const res = runSheet(sheet('multistage/fd-telescopic-ota.json'), table, undefined, REFS);
    expect(blockAt(res, ['cbn', 'base'])?.verdict).toEqual({ verdict: 'feasible', failed: [] });
    expect(blockAt(res, ['cbn'])?.verdict?.verdict).toBe('feasible');
  });
});

describe('the words of the verdicts, from one table', () => {
  it('gives every design verdict, every held verdict and a verdict not calculated a word', () => {
    const keys: string[] = [
      'feasible',
      'non-compliant',
      'infeasible',
      'undetermined',
      'compliant',
      'no-operating-point',
      'not-calculated',
    ];
    expect(Object.keys(VERDICT_WORDS).sort()).toEqual([...keys].sort());
    for (const k of keys)
      expect(VERDICT_WORDS[k as keyof typeof VERDICT_WORDS]).toMatch(/^[a-z -]+$/);
    expect(VERDICT_WORDS['no-operating-point']).toBe('no operating point');
  });

  it('writes the word of an undetermined verdict from the table', () => {
    const lines = verdictText({
      verdict: 'undetermined',
      failed: [],
      held: [{ kind: 'search', path: [], name: 'V_tail' }],
    }).map((l) => l.map((s) => s.text).join(''));
    expect(lines).toEqual([
      `The verdict is ${VERDICT_WORDS.undetermined}, because V_tail is held and not solved.`,
    ]);
  });
});

describe('a solved value that is also marked with a class', () => {
  it('names the class and the constraint, and how to fix it', () => {
    const d = namedEnds(sheet('otas/five-transistor-ota.json'));
    const doc = {
      ...d,
      params: d.params.map((p) => (p.name === 'V_tail' ? { ...p, class: 'assumed' } : p)),
    } as SheetDoc;
    const res = runSheet(doc, table, undefined, REFS);
    const item = res.items?.find((i) => i.kind === 'search' && i.name === 'V_tail');
    expect(item).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'not-read',
        data: {
          why: 'field',
          entry: 'param',
          field: {
            name: 'class',
            value: 'assumed',
            problem: 'solved',
            relation: 'designConstraint',
          },
        },
      },
    });
    expect(describeItem(item as Item).lines).toEqual([
      'V_tail is marked assumed and also has a constraint.',
      'Remove the mark or the constraint.',
    ]);
  });
  it('names the solve-for entry where that is what solves it', () => {
    const d = sheet('mirrors-bias/cascode-current-mirror.json');
    const doc = {
      ...d,
      params: d.params.map((p) => (p.name === 'k_x' ? { ...p, class: 'assumed' } : p)),
    } as SheetDoc;
    const res = runSheet(doc, table, undefined, REFS);
    const item = res.items?.find((i) => i.kind === 'search' && i.name === 'k_x');
    expect(item).toMatchObject({
      status: 'failed',
      cause: {
        kind: 'not-read',
        data: {
          field: { name: 'class', value: 'assumed', problem: 'solved', relation: 'solveFor' },
        },
      },
    });
    expect(describeItem(item as Item).lines).toEqual([
      'k_x is marked assumed and is also solved by a solve-for entry.',
      'Remove the mark or the solve-for entry.',
    ]);
  });
});

describe('a block read in its own list names its part as its parent does', () => {
  it('a cascode on a table with no body-bias sweep: the part, the sweep it lacks, the verdict', () => {
    const vdsOnly = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });
    const res = runSheet(
      sheet('mirrors-bias/cascode-current-mirror.json'),
      vdsOnly,
      undefined,
      REFS,
    );
    const block = res.blocks?.find((b) => b.name === 'ref_casc');
    const device = block?.items?.find((i) => i.kind === 'device' && !i.path.length);
    expect(device).toMatchObject({
      status: 'failed',
      cause: { kind: 'cannot-evaluate', data: { why: 'no-sweep', name: 'vsb' } },
    });
    expect(describeItem(device as Item, ['ref_casc']).lines).toEqual([
      'Part ref_casc cannot be sized.',
      'The table holds no sweep of vsb.',
    ]);
    expect(lineTexts(verdictText(block!.verdict!, ['ref_casc']))).toEqual([
      'The verdict is undetermined, because part ref_casc gives no number.',
    ]);
  });

  it('a part outside its table: the verdict of its block names the part', () => {
    const res = runSheet(
      withParams(sheet('stages/cmos-inverter-amp.json'), { V_out: 1.5 }),
      table,
      undefined,
      REFS,
    );
    const block = res.blocks?.find((b) => b.name === 'n');
    expect(lineTexts(verdictText(block!.verdict!, ['n']))).toEqual([
      'The verdict is undetermined, because part n is outside its table.',
    ]);
    const device = block?.items?.find((i) => i.kind === 'device' && !i.path.length);
    expect(describeItem(device as Item, ['n']).lines[0]).toBe(
      'Part n asks for a drain-source voltage of 1.5 V.',
    );
  });
});

function lineTexts(ls: readonly (readonly { text: string }[])[]): string[] {
  return ls.map((l) => l.map((x) => x.text).join(''));
}

describe('a block’s list is the run’s list under its path, so its verdict says what the sheet’s list says', () => {
  const blockOf = (res: SheetResult, path: readonly string[]): SheetBlockReport | undefined => {
    let blocks = res.blocks;
    let b: SheetBlockReport | undefined;
    for (const n of path) {
      b = blocks?.find((x) => x.name === n);
      blocks = b?.blocks;
    }
    return b;
  };
  const inBlock = (d: SheetDoc, name: string, f: (b: SheetBlock) => SheetBlock): SheetDoc => ({
    ...d,
    blocks: d.blocks?.map((b) => (b.name === name ? f(b) : b)),
  });
  const ota = namedEnds(sheet('otas/five-transistor-ota.json'));
  const refs = (res: SheetResult, path: string[]) =>
    blockOf(res, path)?.verdict?.failed.map((f) => [f.kind, [...f.path, f.name].join('.')]);

  it('a tolerance that is not a number on a block’s requirement', () => {
    const doc = inBlock(ota, 'in', (b) => ({
      ...b,
      doc: {
        ...b.doc!,
        checks: b.doc!.checks.map((c) =>
          c.id === 'feasible-inversion' ? { ...c, tolPct: 'x' as unknown as number } : c,
        ),
      },
    }));
    const res = runSheet(doc, table, undefined, REFS);
    expect(
      res.items?.find((i) => i.name === 'feasible-inversion' && i.path[0] === 'in')?.status,
    ).toBe('failed');
    expect(blockOf(res, ['in'])?.verdict?.verdict).toBe('undetermined');
    expect(refs(res, ['in'])).toEqual([['requirement', 'feasible-inversion']]);
  });

  it('a block’s param that is not a number', () => {
    const doc = inBlock(ota, 'in', (b) => ({
      ...b,
      doc: {
        ...b.doc!,
        params: b.doc!.params.map((p, k) =>
          k === 0 ? { ...p, value: 'abc' as unknown as number } : p,
        ),
      },
    }));
    const res = runSheet(doc, table, undefined, REFS);
    expect(blockOf(res, ['in'])?.verdict?.verdict).toBe('undetermined');
    expect(refs(res, ['in'])).toEqual([['value', 'I_side']]);
  });

  it('a short and an unknown key in the placement of a part a block wires', () => {
    const fd = resolvedSheet(sheet('multistage/fd-telescopic-ota.json'), REFS).doc;
    for (const nodes of [
      { d: 'm', g: 'm', s: 'm', b: 'gnd' },
      { d: 'm', g: 'm', s: 'gnd', b: 'gnd', x: 'gnd' },
    ]) {
      const doc = inBlock(fd, 'cbn', (b) => ({
        ...b,
        doc: inBlock(b.doc!, 'base', (base) => ({ ...base, nodes })),
      }));
      const res = runSheet(doc, table);
      expect(res.verdict?.failed.map((f) => [f.kind, f.path.join('.')])).toEqual([
        ['sheet', 'cbn'],
      ]);
      const cbn = blockOf(res, ['cbn']);
      expect(cbn?.items?.find((i) => i.kind === 'sheet' && !i.path.length)?.status).toBe('failed');
      expect(cbn?.verdict?.verdict).toBe('undetermined');
      expect(refs(res, ['cbn'])).toEqual([['sheet', '']]);
    }
  });

  it('a block at a range end reads the held design’s verdict, never the design word', () => {
    const runs = [
      runSheet(namedEnds(sheet('otas/degenerated-differential-pair.json')), table, undefined, REFS),
      runSheet(namedEnds(sheet('otas/gain-boosted-cascode-ota.json')), table, undefined, REFS),
    ];
    const words = new Set<string>();
    for (const res of runs)
      for (const e of res.rangeEnds ?? []) {
        const walk = (bs: readonly SheetBlockReport[] | undefined): void => {
          for (const b of bs ?? []) {
            expect(b.verdict, `${e.name} ${b.name}`).toBeUndefined();
            if (b.heldVerdict) words.add(b.heldVerdict.verdict);
            walk(b.blocks);
          }
        };
        walk(e.blocks);
      }
    expect([...words].sort()).toEqual(['compliant', 'non-compliant']);
  });
});
