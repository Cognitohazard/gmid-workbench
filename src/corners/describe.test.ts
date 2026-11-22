import { describe as group, expect, it } from 'vitest';
import { generateDemoDevice, scaleQuantities } from '../demo';
import { lineText, noDesignClause, standardProblems, type Line } from '../sheet/describe';
import { runSheet, type SheetDoc } from '../sheet';
import { REFS, sheet, table } from '../sheet/library.fixtures';
import type { DeviceTable, TableMeta } from '../types';
import {
  aggregateConditionRuns,
  conditionLabelIn,
  groupDevices,
  runCondition,
  runConditions,
  tableAt,
  type CharacterizedDevice,
  type ConditionAggregate,
  type ConditionIssue,
  type ConditionKey,
  type ConditionRun,
} from './index';
import {
  conditionIssueText,
  conditionNote,
  conditionWords,
  endCountText,
  heldPointsText,
  issueFindings,
  pointText,
  tightestText,
  worstAtText,
  type Said,
} from './describe';

const dev = generateDemoDevice({ vds: { min: 0, max: 1, step: 0.5 } });
const retag = (
  t: DeviceTable,
  corner: string,
  temp: number,
  meta: TableMeta = {},
): DeviceTable => ({
  ...t,
  id: { ...t.id, corner, temp },
  meta: { ...t.meta, ...meta },
});
const key = (corner: string, temp = 27): ConditionKey => ({ corner, temp });
const tt = key('tt');
const ss = key('ss', 125);
const noDevices = (): undefined => undefined;
const sole = (tables: DeviceTable[]): CharacterizedDevice => groupDevices(tables)[0];
const device = sole([retag(dev, 'tt', 27), retag(scaleQuantities(dev, { gds: 2 }), 'ss', 125)]);
/** The library's test table at three conditions, for the library sheets. */
const libraryDevice = sole([
  retag(table, 'tt', 27),
  retag(table, 'ss', 125),
  retag(table, 'ff', -40),
]);

/** Every line as its plain string, after checking it keeps the message standard. */
const read = (lines: readonly Line[]): string[] =>
  lines.map((l) => {
    expect(standardProblems(l), lineText(l)).toEqual([]);
    return lineText(l);
  });
const lines = (s: Said): string[] => read(s.lines);
const notes = (s: Said): string[] => read(s.notes);

const counts = (c: Partial<ConditionAggregate['heldPoints']>): ConditionAggregate['heldPoints'] => {
  const full = {
    compliant: 0,
    nonCompliant: 0,
    noOperatingPoint: 0,
    undetermined: 0,
    notCalculated: 0,
    ...c,
  };
  return {
    ...full,
    total:
      full.compliant +
      full.nonCompliant +
      full.noOperatingPoint +
      full.undetermined +
      full.notCalculated,
  };
};

group('the condition in words, and its note', () => {
  const marked = sole([
    retag(dev, 'ss', 125),
    retag(dev, 'ff', -40),
    retag(dev, 'tt', 27, { filled: ['temp'] }),
    retag(dev, 'tt', 85, { filled: ['corner'] }),
    retag(dev, 'tt', 0, { filled: ['corner', 'temp'] }),
  ]);

  it('reads the corner and the temperature, the same whatever the file declared', () => {
    expect(read([conditionWords(marked, ss)])).toEqual(['ss 125 °C']);
    expect(read([conditionWords(marked, key('ff', -40))])).toEqual(['ff −40 °C']);
    expect(read([conditionWords(marked, tt)])).toEqual(['tt 27 °C']);
    expect(read([conditionWords(undefined, key('', 125))])).toEqual(['125 °C']);
    expect(read([conditionWords(undefined, key('ss', NaN))])).toEqual(['ss']);
    expect(conditionWords(marked, ss)[0]).toMatchObject({ kind: 'name', text: 'ss' });
  });

  it('says what the engine assumes, in a note', () => {
    const name = marked.conditions[0].id.device;
    expect(read(conditionNote(marked, tt))).toEqual([
      `The engine assumes 27 °C, because the table of ${name} states no temperature.`,
    ]);
    expect(read(conditionNote(marked, key('tt', 85)))).toEqual([
      `The engine assumes the corner tt, because the table of ${name} states no corner.`,
    ]);
    expect(read(conditionNote(marked, key('tt', 0)))).toEqual([
      `The engine assumes 0 °C, because the table of ${name} states no temperature.`,
      `The engine assumes the corner tt, because the table of ${name} states no corner.`,
    ]);
    expect(conditionNote(marked, ss)).toEqual([]);
  });

  it('gives a note exactly where the data label carries its mark', () => {
    for (const k of [ss, key('ff', -40), tt, key('tt', 85), key('tt', 0), key('xx', 3)]) {
      const label = conditionLabelIn(marked, k);
      expect(conditionNote(marked, k).length > 0, label).toBe(label.includes('assumed'));
    }
  });
});

group('the held-point counts', () => {
  const sentence = (c: Partial<ConditionAggregate['heldPoints']>) =>
    read(heldPointsText(counts(c)).lines);
  const chip = (c: Partial<ConditionAggregate['heldPoints']>) => heldPointsText(counts(c)).chip;

  it('reads every count present in one sentence, the first with its total', () => {
    expect(sentence({ compliant: 3, nonCompliant: 1, undetermined: 1 })).toEqual([
      'The held design is compliant at 3 of 5 points, non-compliant at 1 and undetermined at 1.',
    ]);
    expect(sentence({ compliant: 3, noOperatingPoint: 2 })).toEqual([
      'The held design is compliant at 3 of 5 points and has no operating point at 2.',
    ]);
    expect(sentence({ compliant: 5 })).toEqual(['The held design is compliant at all 5 points.']);
    expect(sentence({ nonCompliant: 3, undetermined: 2 })).toEqual([
      'The held design is non-compliant at 3 of 5 points and undetermined at 2.',
    ]);
    expect(sentence({ compliant: 3, notCalculated: 2 })).toEqual([
      'The held design is compliant at 3 of 5 points.',
      'The engine did not calculate 2 points.',
    ]);
    expect(sentence({ notCalculated: 5 })).toEqual([
      'The engine did not calculate the held design at any of the 5 points.',
    ]);
    expect(sentence({ compliant: 1 })).toEqual([]);
  });

  it('gives a chip: the word alone at one point, else the worst word or how many comply', () => {
    expect(chip({ compliant: 1 })).toBe('compliant');
    expect(chip({ nonCompliant: 1 })).toBe('non-compliant');
    expect(chip({ compliant: 2 })).toBe('compliant at both points');
    expect(chip({ compliant: 1, nonCompliant: 1 })).toBe('non-compliant at 1 of 2 points');
    expect(chip({ compliant: 3, notCalculated: 2 })).toBe('compliant at 3 of 5 points');
    expect(chip({ compliant: 5 })).toBe('compliant at all 5 points');
    expect(chip({ notCalculated: 5 })).toBe('not calculated at all 5 points');
    expect(chip({ nonCompliant: 1, noOperatingPoint: 1, compliant: 3 })).toBe(
      'no operating point at 1 of 5 points',
    );
  });
});

/** y = 2x + 1 solved to T; the floor x ≥ 1.6 holds at T = 5 and fails at the lo end, T = 3. */
const ranged = (floor = 1.6): SheetDoc => ({
  title: 'ranged',
  polarity: 'n',
  params: [
    { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'T' } },
    { name: 'T', value: 5, unit: 'V' },
    { name: 'T_lo', value: 3 },
    { name: 'T_hi', value: 7 },
    { name: 'x_floor', value: floor },
  ],
  equations: [{ name: 'y', expr: '2*x + 1' }],
  checks: [{ id: 'floor', kind: 'physical', lhs: 'x', op: '>=', rhs: 'x_floor' }],
  operatingRange: [
    { name: 'lo', set: { T: 'T_lo' } },
    { name: 'hi', set: { T: 'T_hi' } },
  ],
});
/** The same sheet with T = 0.5, which y = 2x + 1 cannot reach over the bracket. */
const unreachable = (): SheetDoc => ({
  ...ranged(),
  params: ranged().params.map((p) => (p.name === 'T' ? { name: 'T', value: 0.5 } : p)),
});

group('one point', () => {
  const [sized, held] = runConditions(ranged(), device, [tt, ss], noDevices, undefined, tt);
  const text = (run: ConditionRun, index: number) =>
    lines(pointText({ run, index, device, doc: ranged() }));

  it('reads the sized design where the engine sized it, and the held design at its centre', () => {
    expect(text(sized, 0)).toEqual([
      'The engine sized the design at tt 27 °C.',
      'The design is feasible there.',
    ]);
    expect(text(held, 0)).toEqual(['The held design is compliant at ss 125 °C.']);
  });

  it('gives the sized design its reason after the place', () => {
    const failing: ConditionRun = {
      ...sized,
      points: [
        {
          state: 'does-not-comply',
          verdict: {
            verdict: 'non-compliant',
            failed: [
              {
                kind: 'requirement',
                path: [],
                name: 'offset-spec',
                cause: { kind: 'fails', data: {} as never },
              },
            ],
          },
        },
      ],
    };
    expect(text(failing, 0)).toEqual([
      'The engine sized the design at tt 27 °C.',
      'The design is non-compliant there, because offset-spec fails.',
    ]);
    const base = runCondition(unreachable(), device, tt, noDevices);
    const [first, ...rest] = text(base, 0);
    expect(first).toBe('The engine sized the design at tt 27 °C.');
    expect(rest[0]).toMatch(/^The design is undetermined there, because .+\.$/);
  });

  it('reads a range end in two sentences: what it sets, then the held design there', () => {
    expect(text(held, 1)).toEqual([
      'At ss 125 °C, range end lo sets T to 3 V.',
      'The held design is non-compliant there, because floor fails.',
    ]);
    expect(text(held, 2)).toEqual([
      'At ss 125 °C, range end hi sets T to 7 V.',
      'The held design is compliant there.',
    ]);
  });

  it('reads a range end the engine did not calculate in one sentence, with its own reason', () => {
    const base = runCondition(unreachable(), device, tt, noDevices);
    expect(text(base, 1)).toEqual([
      'The engine did not calculate range end lo at tt 27 °C, because the design point has no design.',
    ]);
  });

  it('reads a held condition with no design to hold', () => {
    const [, declined] = runConditions(unreachable(), device, [tt, ss], noDevices, undefined, tt);
    expect(text(declined, 0)).toEqual([
      'The engine did not calculate the held design at ss 125 °C, because the design point has no design.',
    ]);
    expect(text(declined, 1)).toEqual([
      'The engine did not run range end lo at ss 125 °C, because the design point has no design.',
    ]);
  });

  it('gives each failed requirement by name, up to two, and a count beyond', () => {
    const fails = (n: number): ConditionRun => ({
      ...held,
      points: [
        {
          state: 'does-not-comply',
          verdict: {
            verdict: 'non-compliant',
            failed: Array.from({ length: n }, (_, k) => ({
              kind: 'requirement' as const,
              path: [],
              name: ['offset-spec', 'gain-spec', 'sr-spec'][k],
              cause: { kind: 'fails' as const, data: {} as never },
            })),
          },
        },
      ],
    });
    expect(text(fails(1), 0)).toEqual([
      'The held design is non-compliant at ss 125 °C, because offset-spec fails.',
    ]);
    expect(text(fails(2), 0)).toEqual([
      'The held design is non-compliant at ss 125 °C, because offset-spec and gain-spec fail.',
    ]);
    expect(text(fails(3), 0)).toEqual([
      'The held design is non-compliant at ss 125 °C, because 3 hard requirements fail.',
    ]);
  });

  it('reads no operating point, and undetermined with the clause of its failed item (made up)', () => {
    // A search that did not land, from a real run, carried by a made-up held verdict: no search
    // proves its relation monotonic yet, so no run reads "no operating point".
    const base = runCondition(unreachable(), device, tt, noDevices);
    const search = base.result!.items!.find((i) => i.status === 'failed')!;
    if (search.status !== 'failed') throw new Error('no failed item');
    const failed = [
      { kind: search.kind, path: search.path, name: search.name, cause: search.cause },
    ];
    const madeUp = (verdict: 'no-operating-point' | 'undetermined'): ConditionRun => ({
      ...held,
      points: [{ state: 'no-answer', verdict: { verdict, failed } }],
    });
    const noOp = text(madeUp('no-operating-point'), 0);
    expect(noOp[0]).toBe('The held design has no operating point at ss 125 °C.');
    expect(noOp).toHaveLength(2);
    expect(text(madeUp('undetermined'), 0)).toEqual([
      expect.stringMatching(/^The held design is undetermined at ss 125 °C, because .+\.$/),
    ]);
  });

  it('returns the note of the condition it names, apart from its lines', () => {
    const marked = sole([retag(dev, 'tt', 27), retag(dev, 'ss', 27, { filled: ['temp'] })]);
    const [, h] = runConditions(ranged(), marked, [tt, key('ss')], noDevices, undefined, tt);
    const said = pointText({ run: h, index: 0, device: marked });
    expect(lines(said)).toEqual(['The held design is compliant at ss 27 °C.']);
    expect(notes(said)).toEqual([
      `The engine assumes 27 °C, because the table of ${marked.conditions[0].id.device} states no temperature.`,
    ]);
  });

  it('counts a run’s range ends as a fragment', () => {
    expect(endCountText(held)).toBe('non-compliant at 1 of 2 range ends');
    const [, allOk] = runConditions(ranged(0.5), device, [tt, ss], noDevices, undefined, tt);
    expect(endCountText(allOk)).toBe('compliant at both range ends');
  });
});

group('the margins', () => {
  const agg = (over: Partial<ConditionAggregate>): ConditionAggregate => ({
    feasibility: 'feasible',
    heldPoints: counts({ compliant: 4 }),
    marginPoints: { read: 5, unreadable: 0, notCalculated: 0, total: 5 },
    compliance: { complies: 5, doesNotComply: 0, noAnswer: 0, notRun: 0, total: 5 },
    worst: null,
    onLimit: [],
    verdict: { verdict: 'feasible', failed: [] },
    ...over,
  });
  const w = (marginPct: number, rangeEnd?: string) => ({
    id: 'offset-spec',
    marginPct,
    status: marginPct < 0 ? ('fail' as const) : ('pass' as const),
    key: ss,
    ...(rangeEnd ? { rangeEnd } : {}),
  });

  it('names the tightest hard requirement, or the one that fails worst, and where', () => {
    expect(lines(tightestText(agg({ worst: w(0.042) }), device))).toEqual([
      'The tightest hard requirement is offset-spec, with a margin of 4.2 % at ss 125 °C.',
    ]);
    expect(lines(tightestText(agg({ worst: { ...w(-0.59), key: tt } }), device))).toEqual([
      'offset-spec fails worst, with a margin of −59 % at tt 27 °C.',
    ]);
  });

  it('gives the margin its own sentence where a range end makes one run past the standard', () => {
    const said = tightestText(
      agg({
        worst: { ...w(0.058, 'cm-lo'), id: 'linrange-spec' },
        onLimit: [{ id: 'x', points: [{ key: tt }] }],
      }),
      device,
    );
    expect(lines(said)).toEqual([
      'x sits on its limit at tt 27 °C.',
      'Of the other hard requirements, linrange-spec is the tightest.',
      'Its margin is 5.8 % at ss 125 °C, range end cm-lo.',
    ]);
  });

  it('puts the requirements on their limit first, grouped by where they sit there', () => {
    const said = tightestText(
      agg({
        worst: w(0.042),
        onLimit: [
          { id: 'sr-spec', points: [{ key: tt }, { key: key('ss', -40) }] },
          { id: 'gain-spec', points: [{ key: tt }] },
          {
            id: 'cm-not-below',
            points: [
              { key: tt, rangeEnd: 'cm-lo' },
              { key: ss, rangeEnd: 'cm-lo' },
            ],
          },
        ],
      }),
      device,
    );
    expect(lines(said)).toEqual([
      'sr-spec sits on its limit at tt 27 °C and ss −40 °C.',
      'gain-spec sits on its limit at tt 27 °C.',
      'cm-not-below sits on its limit at range end cm-lo in tt 27 °C and ss 125 °C.',
      'Of the other hard requirements, offset-spec is the tightest, with a margin of 4.2 % at ss 125 °C.',
    ]);
    const shared = tightestText(
      agg({
        onLimit: [
          { id: 'sr-spec', points: [{ key: tt }] },
          { id: 'gain-spec', points: [{ key: tt }] },
        ],
      }),
      device,
    );
    expect(lines(shared)).toEqual(['sr-spec and gain-spec sit on their limits at tt 27 °C.']);
  });

  it('says at how many points the engine read margins, and what the others are', () => {
    const at = (m: Partial<ConditionAggregate['marginPoints']>) =>
      lines(
        tightestText(
          agg({
            worst: w(0.042),
            marginPoints: { read: 6, unreadable: 0, notCalculated: 0, total: 9, ...m },
          }),
          device,
        ),
      ).slice(1);
    expect(at({ notCalculated: 3 })).toEqual([
      'The engine read margins at 6 of 9 points.',
      'The other 3 points are not calculated.',
    ]);
    expect(at({ unreadable: 3 })).toEqual([
      'The engine read margins at 6 of 9 points.',
      'The engine read no margin at the other 3 points.',
    ]);
    expect(at({ notCalculated: 1, unreadable: 2 })).toEqual([
      'The engine read margins at 6 of 9 points.',
      '1 of the other points is not calculated.',
      'The engine read no margin at 2 of the other points.',
    ]);
    expect(at({ notCalculated: 2, unreadable: 1 })[1]).toBe(
      '2 of the other points are not calculated.',
    );
  });

  it('says why no hard requirement has a margin', () => {
    expect(
      lines(
        tightestText(
          agg({
            verdict: undefined,
            marginPoints: { read: 0, unreadable: 0, notCalculated: 5, total: 5 },
          }),
          device,
        ),
      ),
    ).toEqual([
      'No hard requirement has a margin at any point, because the engine calculated no point.',
    ]);
    expect(
      lines(
        tightestText(
          agg({ marginPoints: { read: 0, unreadable: 1, notCalculated: 8, total: 9 } }),
          device,
        ),
      ),
    ).toEqual(['The engine read no margin at any point.', '8 of the 9 points are not calculated.']);
    expect(
      lines(
        tightestText(
          agg({ marginPoints: { read: 0, unreadable: 5, notCalculated: 0, total: 5 } }),
          device,
        ),
      ),
    ).toEqual(['The engine read no margin at any point.']);
    expect(
      lines(
        tightestText(
          agg({ marginPoints: { read: 5, unreadable: 0, notCalculated: 0, total: 5 } }),
          device,
        ),
      ),
    ).toEqual([
      'No hard requirement has a margin at any point, because every hard requirement is not calculated.',
    ]);
  });

  it('gives one check’s tightest point as a fragment, with the note of its condition', () => {
    const at = {
      id: 'gain-spec',
      kind: 'spec' as const,
      marginPct: -0.59,
      status: 'fail' as const,
      key: tt,
    };
    expect(read([worstAtText(at, device).line])).toEqual(['−59 % at tt 27 °C']);
    expect(read([worstAtText({ ...at, key: ss, rangeEnd: 'cm-lo' }, device).line])).toEqual([
      '−59 % at ss 125 °C, cm-lo',
    ]);
    expect(worstAtText(at, device).notes).toEqual([]);
  });
});

group('why a condition was not run', () => {
  const issue = (i: ConditionIssue) => lines(conditionIssueText(i, ss, device));

  it('says what is missing, and the one action that answers it', () => {
    expect(
      issue({ kind: 'absent-condition', device: 'nmos_demo', missing: 'condition', message: '' }),
    ).toEqual([
      'The device nmos_demo has no table at ss 125 °C, so the engine did not run this condition.',
      'Load a table of nmos_demo at ss 125 °C.',
    ]);
    expect(
      issue({
        kind: 'absent-condition',
        device: 'nch_tail',
        missing: 'device',
        block: 'tailblk',
        message: '',
      }),
    ).toEqual([
      'Block tailblk names the device nch_tail, and no table of nch_tail is loaded.',
      'So the engine did not run this condition.',
      'Load a table of nch_tail at ss 125 °C.',
    ]);
    expect(issue({ kind: 'ambiguous-condition', device: 'nmos_demo', message: '' })).toEqual([
      'Two tables of the device nmos_demo claim ss 125 °C, so the engine did not run this condition.',
      'Remove one of the two tables.',
    ]);
    expect(issue({ kind: 'incompatible-table', device: 'nmos_demo', message: '' })).toEqual([
      'The tables of the device nmos_demo do not sweep the same axes, so the engine runs none of its conditions.',
      'Load tables of nmos_demo that sweep the same axes.',
    ]);
    expect(
      issue({ kind: 'no-design', reason: 'no-design-at-base', base: tt, on: [], message: '' }),
    ).toEqual(['The engine did not run ss 125 °C, because the design point has no design.']);
    expect(issue({ kind: 'no-design', reason: 'no-base', message: '' })).toEqual([
      'The sheet names no condition to size the design at, so the engine did not run ss 125 °C.',
      'Choose the condition at which the engine sizes the design.',
    ]);
    expect(
      issue({
        kind: 'assumed-level',
        names: [{ kind: 'value', path: [], name: 'V_d' }],
        message: '',
      }),
    ).toEqual(['The engine does not hold the design at ss 125 °C, because V_d is marked assumed.']);
    expect(issue({ kind: 'runtime-evaluation', on: [], message: '' })).toEqual([]);
    expect(issue({ kind: 'invalid-sheet-or-ref', on: [], message: '' })).toEqual([]);
  });

  it('gives a sheet that does not validate the text the sheet itself shows', () => {
    const doc: SheetDoc = {
      ...ranged(),
      checks: [{ id: 'floor', kind: 'physical', lhs: 'x', op: '>=', rhs: 'x_floor', tolPct: -1 }],
    };
    const run = runCondition(doc, device, tt, noDevices);
    const mine = issueFindings(run).flatMap((f) => f.lines);
    const sheet = runSheet(doc, tableAt(device, tt)).items!.find((i) => i.name === 'floor')!;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine).toEqual(
      issueFindings({ ...run, items: [sheet] } as ConditionRun).flatMap((f) => f.lines),
    );
  });

  it('puts a finding the sheet shows on another item on the item its place names', () => {
    // An override of a name the child does not have: the sheet's own run shows it under the
    // child's input; the condition has no such item, so it goes on the block's own.
    const doc = sheet('otas/five-transistor-ota.json');
    doc.blocks![0].params = { ...doc.blocks![0].params, nope: '1' };
    const run = runCondition(doc, libraryDevice, tt, noDevices, REFS);
    expect(run.state === 'not-evaluated' && run.issues.map((i) => 'on' in i && i.on)).toEqual([
      [{ kind: 'sheet', path: ['bias'], name: '' }],
    ]);
    expect(issueFindings(run).flatMap((f) => f.lines)).toEqual([
      'Block bias sets nope, but its sheet has no input of that name.',
    ]);
  });

  it('gives a run that did not complete its incomplete items’ own text', () => {
    const run = runCondition(unreachable(), device, tt, noDevices);
    expect(issueFindings(run).length).toBeGreaterThan(0);
  });
});

group('the aggregate from real runs', () => {
  it('reads the counts of a set of conditions', () => {
    const runs = runConditions(ranged(), device, [tt, ss], noDevices, undefined, tt);
    const agg = aggregateConditionRuns(runs);
    expect(read(heldPointsText(agg.heldPoints).lines)).toEqual([
      'The held design is compliant at 3 of 5 points and non-compliant at 2.',
    ]);
  });

  it('asks a range end at a held condition whose centre is undetermined', () => {
    // Drain currents a third of tt's at ff: the held folded cascode is undetermined there. The
    // hardware comes from the design point, which has a design, so its range ends are still
    // asked, each giving its own verdict.
    const skewed = sole([
      retag(table, 'tt', 27),
      retag(scaleQuantities(table, { id: 0.3 }), 'ff', -40),
    ]);
    const doc = sheet('otas/folded-cascode-ota.json');
    const [, held] = runConditions(doc, skewed, [tt, key('ff', -40)], noDevices, REFS, tt);
    expect(held.points[0].verdict?.verdict).toBe('undetermined');
    expect(lines(pointText({ run: held, index: 1, device: skewed, doc }))).toEqual([
      'At ff −40 °C, range end cm-lo sets CM_dc to 1 V.',
      'The held design is undetermined there, because part cbn is outside its table and part cbp is outside its table.',
    ]);
  });

  group('a design point with no design', () => {
    const ff = key('ff', -40);
    const withValue = (
      file: string,
      name: string,
      value: (min?: number, max?: number) => number,
    ) => {
      const doc = sheet(file);
      const p = doc.params.find((q) => q.name === name)!;
      p.value = value(p.min, p.max);
      return doc;
    };
    /** The held condition's issue, its text, and each range end of the design point. */
    const heldOver = (doc: SheetDoc) => {
      const [base, held] = runConditions(doc, libraryDevice, [tt, ff], noDevices, REFS, tt);
      expect(held.state).toBe('not-evaluated');
      const issues = held.state === 'not-evaluated' ? held.issues : [];
      expect(issues).toHaveLength(1);
      return {
        issue: issues[0],
        text: lines(conditionIssueText(issues[0], ff, libraryDevice, base.result?.items)),
        ends: base.result?.rangeEnds ?? [],
      };
    };
    const clause = `The engine did not run ff −40 °C, because ${lineText(noDesignClause())}.`;

    it('points each range end and the held condition at the search that did not close', () => {
      // An input pair biased so weakly that the tail search reads it beyond its table everywhere.
      const { issue, text, ends } = heldOver(
        withValue('otas/five-transistor-ota.json', 'gm_id_in', () => 60),
      );
      const search = { kind: 'search', path: [], name: 'V_tail' };
      expect(issue).toMatchObject({ kind: 'no-design', reason: 'no-design-at-base', on: [search] });
      expect(text[0]).toBe(clause);
      expect(ends).toHaveLength(2);
      for (const e of ends) {
        expect(e).toMatchObject({ state: 'not-run', set: {}, checks: [] });
        expect(e.items).toEqual([
          expect.objectContaining({ status: 'withheld', on: [expect.objectContaining(search)] }),
        ]);
      }
    });

    it('names the search with no crossing as what the held condition waits on', () => {
      const { issue, text } = heldOver(
        withValue('mirrors-bias/widlar-current-source.json', 'R_s', (_, max) => max!),
      );
      expect(issue).toMatchObject({
        kind: 'no-design',
        reason: 'no-design-at-base',
        on: [{ kind: 'search', path: [], name: 'I_out' }],
      });
      expect(text[0]).toBe(clause);
    });

    it('points each range end and the held condition at a device outside its table', () => {
      const doc = withValue('mirrors-bias/matched-mirror-bank.json', 'V_out', () => 1.6);
      doc.operatingRange = [{ name: 'lo', set: { V_out: '0.9' } }];
      const { issue, text, ends } = heldOver(doc);
      const device = { kind: 'device', path: [], name: 'givens' };
      expect(issue).toMatchObject({ kind: 'no-design', reason: 'no-design-at-base', on: [device] });
      expect(text[0]).toBe(clause);
      expect(ends[0]).toMatchObject({ state: 'not-run', set: {}, checks: [] });
      expect(ends[0].items).toEqual([
        expect.objectContaining({ status: 'withheld', on: [expect.objectContaining(device)] }),
      ]);
    });
  });

  it('says no margin was read, not that none is calculated, where no run point has one', () => {
    // An equation with no value: the design point is calculated and undetermined, and still has a
    // design, so every point is run and none reads a margin.
    const doc = sheet('otas/five-transistor-ota.json');
    doc.equations.push({ name: 'y', expr: '1/0' });
    const keys = [tt, key('ss', 125), key('ff', -40)];
    const agg = aggregateConditionRuns(
      runConditions(doc, libraryDevice, keys, noDevices, REFS, tt),
    );
    expect(agg.marginPoints).toEqual({ read: 0, unreadable: 9, notCalculated: 0, total: 9 });
    expect(lines(tightestText(agg, libraryDevice))).toEqual([
      'The engine read no margin at any point.',
    ]);
  });
});
