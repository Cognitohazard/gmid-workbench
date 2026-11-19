// Today's result fields read the same as what the item list gives: the yes-or-no feasibility, a
// point's compliance state and each range end's, over every library sheet at its defaults and at
// each sweepable parameter's ends, and over sheets made to fail in each way a search can.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import { evaluateSheet, runSheet, withParams } from './index';
import { resolvedSheet } from './resolve';
import { legacyFeasible, legacyPointState } from './derived';
import { causeFits, legacyDesignFailure, setOf, verdictOf, type Cause, type Item } from './states';
import { describe as describeItem, standardProblems } from './describe';
import { FINDING_CAUSES } from './items';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  namesOf,
  sweepable,
  type CheckResult,
  type SheetBlockReport,
  type SheetDoc,
  type SheetResult,
} from './types';
import { loadLibrary, sheet, table, REFS } from './library.fixtures';

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
      ? i.on.filter((o) => failedAt.get(key(o)) !== o.cause).map((o) => `${key(i)} -> ${key(o)}`)
      : [],
  );
}

const expectSame = (res: SheetResult): void => {
  expect(res.items?.[0]).toMatchObject({ kind: 'sheet', path: [] });
  for (const i of res.items ?? [])
    if (i.status === 'failed') expect(causeFits(i.kind, i.cause)).toBe(true);
  for (const r of readings(res))
    expect({ at: r.at, value: r.derived }).toEqual({ at: r.at, value: r.field });
  // Every item reads to the message standard.
  const all: Item[] = [...(res.items ?? [])];
  const walk = (bs: readonly SheetBlockReport[] | undefined): void => {
    for (const b of bs ?? []) {
      all.push(...(b.items ?? []));
      walk(b.blocks);
    }
  };
  walk(res.blocks);
  for (const e of res.rangeEnds ?? []) all.push(...(e.items ?? []));
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
    const d = sheet('otas/five-transistor-ota.json');
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
    const d = withParams(sheet('otas/inverter-based-ota.json'), { gm_id_n: 18 });
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
    const d = withParams(sheet('otas/five-transistor-ota.json'), { CM_dc: 1.75 });
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
    const d = withParams(sheet('otas/five-transistor-ota.json'), { CM_dc: 1.75 });
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
    const d = withParams(sheet('otas/five-transistor-ota.json'), { CM_dc: 1.75 });
    const res = runSheet(d, table, undefined, REFS);
    const tail = res.items?.find((i) => i.name === 'V_tail' && i.status === 'failed');
    if (tail?.status !== 'failed' || tail.cause.kind !== 'no-crossing') return;
    const proved: Cause = {
      kind: 'no-solution',
      data: { ...tail.cause.data, shown: 'monotonic' },
    };
    expect(verdictOf([{ ...tail, cause: proved }]).verdict).toBe('undetermined');
    expect(legacyDesignFailure(tail.cause)).toBe(false);
  });
});

describe('a search whose relation gives no number where it searched', () => {
  it('cannot be calculated, and names the part read beyond its table', () => {
    const d = withParams(sheet('otas/five-transistor-ota.json'), { L_in: 5e-6 });
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
    expect(lines).toContain('The engine searched it from 0 V to 0.523 V.');
    expect(lines).toContain('Above 0.523 V, part in is outside its table.');
    expect(lines).toContain('CM_in is 0.567 V at 0 V and 1.2 V at 0.523 V.');
    expect(lines.some((l) => /full physical range|the high end/.test(l))).toBe(false);
  });

  it('names the block, in its own list, as waiting on its parent sheet', () => {
    const d = withParams(sheet('otas/five-transistor-ota.json'), { CM_dc: 1.75 });
    const res = runSheet(d, table, undefined, REFS);
    const own = res.blocks
      ?.find((b) => b.name === 'tail')
      ?.items?.find((i) => i.kind === 'sheet' && i.path.length === 0);
    expect(own && describeItem(own, ['tail']).lines).toEqual([
      'Block tail is not calculated, because its parent sheet gives it no value.',
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
    const doc = resolvedSheet(sheet('otas/five-transistor-ota.json'), REFS).doc;
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
            why: 'not-finite',
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
          netlist: { problem: 'selector', devices: ['givens'], param: 's' },
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
          netlist: { problem: 'wire-name', wires: ['a.b'], devices: ['givens'] },
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
        data: { why: 'netlist', names: ['lone'], netlist: { problem: 'one-terminal' } },
      },
    });
    expectSame(lone);
  });
});
