import { describe as group, expect, it } from 'vitest';
import { generateDemoDevice, scaleQuantities } from '../demo';
import { lineText, standardProblems, type Line } from '../sheet/describe';
import { runSheet, type SheetDoc } from '../sheet';
import type { DeviceTable, TableMeta } from '../types';
import {
  aggregateConditionRuns,
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
  conditionWords,
  endCountText,
  heldPointsText,
  issueFindings,
  pointText,
  tightestText,
  worstAtText,
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

/** Every line as its plain string, after checking it keeps the message standard. */
const read = (lines: readonly Line[], over20 = false): string[] =>
  lines.map((l) => {
    const problems = standardProblems(l).filter((p) => !(over20 && p === 'more than 20 words'));
    expect(problems, lineText(l)).toEqual([]);
    return lineText(l);
  });

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

group('the condition in words', () => {
  it('reads the corner and the temperature, and marks what the file did not declare', () => {
    const d = sole([
      retag(dev, 'ss', 125),
      retag(dev, 'ff', -40),
      retag(dev, 'tt', 27, { filled: ['temp'] }),
      retag(dev, 'tt', 85, { filled: ['corner'] }),
    ]);
    expect(read([conditionWords(d, ss)])).toEqual(['ss 125 °C']);
    expect(read([conditionWords(d, key('ff', -40))])).toEqual(['ff −40 °C']);
    expect(read([conditionWords(d, tt)])).toEqual(['tt at an assumed 27 °C']);
    expect(read([conditionWords(d, key('tt', 85))])).toEqual(['an assumed tt at 85 °C']);
    const both = sole([retag(dev, 'tt', 27, { filled: ['corner', 'temp'] })]);
    expect(read([conditionWords(both, tt)])).toEqual(['an assumed tt at an assumed 27 °C']);
    // A bare key, with no member to read: no corner, or no finite temperature.
    expect(read([conditionWords(undefined, key('', 125))])).toEqual(['125 °C']);
    expect(read([conditionWords(undefined, key('ss', NaN))])).toEqual(['ss']);
    // The corner is a name segment.
    expect(conditionWords(d, ss)[0]).toMatchObject({ kind: 'name', text: 'ss' });
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
    // One point: the point's own sentence says it.
    expect(sentence({ compliant: 1 })).toEqual([]);
  });

  it('gives a chip of the worst word present, or how many are compliant', () => {
    expect(chip({ compliant: 3, notCalculated: 2 })).toBe('compliant at 3 of 5 points');
    expect(chip({ compliant: 5 })).toBe('compliant at all 5 points');
    expect(chip({ compliant: 4, nonCompliant: 1 })).toBe('non-compliant at 1 of 5 points');
    expect(chip({ notCalculated: 5 })).toBe('not calculated at all 5 points');
    expect(chip({ nonCompliant: 1, noOperatingPoint: 1, compliant: 3 })).toBe(
      'no operating point at 1 of 5 points',
    );
    expect(chip({ compliant: 1 })).toBe('compliant at the point');
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

group('one point', () => {
  const [sized, held] = runConditions(ranged(), device, [tt, ss], noDevices, undefined, tt);
  const text = (run: ConditionRun, index: number) =>
    read(pointText({ run, index, device, doc: ranged() }));

  it('reads the sized design where the engine sized it, and the held design at its centre', () => {
    expect(text(sized, 0)).toEqual([
      'The design is feasible at tt 27 °C, where the engine sized it.',
    ]);
    expect(text(held, 0)).toEqual(['The held design is compliant at ss 125 °C.']);
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

  it('reads a held condition with no design to hold', () => {
    const unreachable: SheetDoc = {
      ...ranged(),
      params: [...ranged().params.slice(0, 1), { name: 'T', value: 0.5 }],
    };
    const [, declined] = runConditions(unreachable, device, [tt, ss], noDevices, undefined, tt);
    expect(text(declined, 0)).toEqual([
      'The engine did not calculate the held design at ss 125 °C, because the design point has no design.',
    ]);
    expect(text(declined, 1)).toEqual([
      'The engine did not calculate range end lo at ss 125 °C, because the design point has no design.',
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
    const unreachable: SheetDoc = {
      ...ranged(),
      params: [...ranged().params.slice(0, 1), { name: 'T', value: 0.5 }],
    };
    const base = runCondition(unreachable, device, tt, noDevices);
    const search = base.result!.items!.find((i) => i.status === 'failed')!;
    expect(search.status).toBe('failed');
    if (search.status !== 'failed') return;
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
      expect.stringMatching(/^The held design is undetermined at ss 125 °C, because .*x.*\.$/),
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
    marginPoints: { read: 5, total: 5 },
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
    expect(read(tightestText(agg({ worst: w(0.042) }), device))).toEqual([
      'The tightest hard requirement is offset-spec, with a margin of 4.2 % at ss 125 °C.',
    ]);
    expect(read(tightestText(agg({ worst: w(0.042, 'cm-lo') }), device), true)).toEqual([
      'The tightest hard requirement is offset-spec, with a margin of 4.2 % at ss 125 °C, range end cm-lo.',
    ]);
    expect(read(tightestText(agg({ worst: { ...w(-0.59), key: tt } }), device))).toEqual([
      'offset-spec fails worst, with a margin of −59 % at tt 27 °C.',
    ]);
  });

  it('puts the requirements on their limit first, and the tightest of the others after', () => {
    const lines = tightestText(
      agg({
        worst: w(0.042),
        onLimit: [
          { id: 'sr-spec', points: [{ key: tt }, { key: key('ss', -40) }] },
          { id: 'gain-spec', points: [{ key: tt }] },
        ],
      }),
      device,
    );
    expect(read(lines)).toEqual([
      'sr-spec sits on its limit at tt 27 °C and ss −40 °C.',
      'gain-spec sits on its limit at tt 27 °C.',
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
    expect(read(shared)).toEqual(['sr-spec and gain-spec sit on their limits at tt 27 °C.']);
  });

  it('says at how many points the margins were read, and why there is none', () => {
    expect(
      read(tightestText(agg({ worst: w(0.042), marginPoints: { read: 3, total: 5 } }), device)),
    ).toEqual([
      'The tightest hard requirement is offset-spec, with a margin of 4.2 % at ss 125 °C.',
      'The margins were read at 3 of 5 points.',
    ]);
    expect(
      read(
        tightestText(
          agg({
            heldPoints: counts({ notCalculated: 4 }),
            verdict: undefined,
            marginPoints: { read: 0, total: 5 },
          }),
          device,
        ),
      ),
    ).toEqual([
      'No hard requirement has a margin at any point, because the engine calculated no point.',
    ]);
    expect(read(tightestText(agg({ marginPoints: { read: 0, total: 5 } }), device))).toEqual([
      'No hard requirement has a margin at any point, because every hard requirement is not calculated.',
    ]);
  });

  it('gives one check’s tightest point as a fragment', () => {
    const at = {
      id: 'gain-spec',
      kind: 'spec' as const,
      marginPct: -0.59,
      status: 'fail' as const,
      key: tt,
    };
    expect(read([worstAtText(at, device)])).toEqual(['−59 % at tt 27 °C']);
    expect(read([worstAtText({ ...at, key: ss, rangeEnd: 'cm-lo' }, device)])).toEqual([
      '−59 % at ss 125 °C, cm-lo',
    ]);
  });
});

group('why a condition was not run', () => {
  const issue = (i: ConditionIssue) => read(conditionIssueText(i, ss, device));

  it('says what is missing, and the one action that answers it', () => {
    expect(
      issue({ kind: 'absent-condition', device: 'nmos_demo', missing: 'condition', message: '' }),
    ).toEqual([
      'The device nmos_demo has no table at ss 125 °C, so the engine did not run this condition.',
      'Load a table of nmos_demo at ss 125 °C.',
    ]);
    expect(issue({ kind: 'ambiguous-condition', device: 'nmos_demo', message: '' })).toEqual([
      'Two tables of the device nmos_demo claim ss 125 °C, so the engine did not run this condition.',
      'Remove one of the two tables.',
    ]);
    expect(
      issue({ kind: 'no-design', reason: 'base-not-evaluated', base: tt, message: '' }),
    ).toEqual(['The engine did not run ss 125 °C, because the design point has no design.']);
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

  it('drafts the three facts with no final sentence yet', () => {
    expect(
      issue({
        kind: 'absent-condition',
        device: 'nch_tail',
        missing: 'device',
        block: 'tailblk',
        message: '',
      }),
    ).toEqual([
      'Block tailblk names the device nch_tail, which is not loaded, so the engine did not run this condition.',
      'Load a table of nch_tail.',
    ]);
    expect(issue({ kind: 'incompatible-table', device: 'nmos_demo', message: '' })).toEqual([
      'The tables of the device nmos_demo do not sweep the same axes, so the engine runs none of its conditions.',
      'Load tables of nmos_demo that sweep the same axes.',
    ]);
    expect(issue({ kind: 'no-design', reason: 'no-base', message: '' })).toEqual([
      'No condition is named for sizing the design, so the engine did not run ss 125 °C.',
      'Name the condition to size the design at.',
    ]);
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

  it('gives a run that did not complete its incomplete items’ own text', () => {
    const unreachable: SheetDoc = {
      ...ranged(),
      params: [...ranged().params.slice(0, 1), { name: 'T', value: 0.5 }],
    };
    const run = runCondition(unreachable, device, tt, noDevices);
    expect(issueFindings(run).length).toBeGreaterThan(0);
    expect(read(pointText({ run, index: 0, device })).slice(0, 1)).toEqual([
      'The design is undetermined at tt 27 °C, where the engine sized it.',
    ]);
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
});
