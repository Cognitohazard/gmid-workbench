// The set of states: the closed list of causes, the kinds of item each may occur on, the four
// verdict rules and their order, the one place a failed search is taken as proved, and the text
// module that builds today's messages from a cause's data.

import { describe as group, it, expect } from 'vitest';
import { syntaxAt } from '../expr';
import { generateDemoDevice } from '../demo';
import { evaluateSheet } from './index';
import {
  CAUSES,
  OCCURS_ON,
  OPEN_RULINGS,
  causeFits,
  failsCause,
  heldVerdictOf,
  noSolutionCause,
  verdictOf,
  type NotReadData,
  type NoCrossingData,
  type Cause,
  type DidNotSettleData,
  type Item,
  type ItemRef,
  type SearchData,
  type NoSolutionRead,
  type Verdict,
  type WithheldOn,
} from './states';
import {
  CAUSE_NAMES,
  causeMessage,
  describe,
  incompleteMessage,
  incompleteText,
  notAskedText,
  rangeSource,
  withheldClause,
  lineText,
  standardProblems,
  verdictText,
  textOf,
  type Line,
} from './describe';
import type { SheetDoc, SolveRange } from './types';
import type { NetlistAbout, OutsideTable } from '../types';

const outside: OutsideTable = { device: 'in', quantity: 'l', asked: 5e-6, held: [180e-9, 2e-6] };

const dev = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });

const authorRange = (param: string, lo: number, hi: number): SolveRange => ({
  param,
  range: [lo, hi],
  from: 'author',
  author: [lo, hi],
  note: '',
});

const search = (over: Partial<SearchData> = {}): SearchData => ({
  path: [],
  unknown: 'x',
  held: false,
  relation: {
    lhs: 'y',
    rhs: 'goal',
    field: 'designConstraint',
    reads: { lhs: ['y'], rhs: ['goal'] },
  },
  range: authorRange('x', 0, 10),
  searched: [0, 10],
  stage: 'sheet',
  ...over,
});

const read = (lo: [number, number, number], hi: [number, number, number]): NoSolutionRead => ({
  ends: [
    { x: lo[0], lhs: lo[1], rhs: lo[2] },
    { x: hi[0], lhs: hi[1], rhs: hi[2] },
  ],
  ended: { kind: 'sign' },
});

const ok = (kind: Item['kind'], name: string): Item => ({ kind, path: [], name, status: 'ok' });
const failed = (kind: Item['kind'], name: string, cause: Cause): Item => ({
  kind,
  path: [],
  name,
  status: 'failed',
  cause,
});

const proved: Cause = {
  kind: 'no-solution',
  data: { ...search(), ...read([0, 1, 50], [10, 21, 50]), shown: 'monotonic' },
};
const hardFail = failsCause({
  kind: 'spec',
  text: { lhs: 'gain', op: '>=', rhs: 'gain_min' },
  lhsValue: 2,
  rhsValue: 1,
  margin: -1,
  marginPct: -1,
});
const softFail = failsCause({
  kind: 'advisory',
  text: { lhs: 'a', op: '<=', rhs: '1' },
  lhsValue: 2,
  rhsValue: 1,
  margin: -1,
  marginPct: -1,
});
const notEvaluated: Cause = {
  kind: 'cannot-evaluate',
  data: { why: 'not-defined', name: 'z', reason: '"z" is not defined' },
};

group('the closed list of causes', () => {
  it('names the kinds of item every cause may occur on, and nothing else', () => {
    expect(Object.keys(OCCURS_ON).sort()).toEqual([...CAUSES].sort());
    expect(CAUSES).toHaveLength(11);
    for (const c of CAUSES) expect(OCCURS_ON[c].length).toBeGreaterThan(0);
    expect(causeFits('search', proved)).toBe(true);
    expect(causeFits('value', proved)).toBe(false);
    expect(causeFits('requirement', hardFail)).toBe(true);
    expect(causeFits('device', hardFail)).toBe(false);
  });

  it('has a short name for every cause', () => {
    for (const c of CAUSES) expect(CAUSE_NAMES[c]).toMatch(/\S/);
  });
});

group('the verdict, by four rules in order', () => {
  const sheet = ok('sheet', '');
  it('reads a proved search as infeasible, before a failing requirement', () => {
    const v = verdictOf([
      sheet,
      failed('search', 'x', proved),
      failed('requirement', 'c', hardFail),
    ]);
    expect(v.verdict).toBe('infeasible');
    expect(v.failed.map((f) => f.name)).toEqual(['x']);
  });

  it('reads a failing hard requirement as non-compliant, whatever else is not known', () => {
    const v = verdictOf([
      sheet,
      failed('value', 'z', notEvaluated),
      {
        kind: 'value',
        path: [],
        name: 'w',
        status: 'withheld',
        on: [{ kind: 'value', path: [], name: 'z', cause: 'cannot-evaluate' }],
      },
      failed('requirement', 'c', hardFail),
    ]);
    expect(v.verdict).toBe('non-compliant');
    expect(v.failed.map((f) => f.name)).toEqual(['c']);
  });

  it('reads every item ok as feasible; an advisory requirement that fails decides nothing', () => {
    expect(verdictOf([sheet, ok('value', 'a'), ok('requirement', 'c')]).verdict).toBe('feasible');
    expect(verdictOf([sheet, failed('requirement', 'adv', softFail)]).verdict).toBe('feasible');
  });

  it('gives a sheet with no device and no search the word the open ruling holds', () => {
    expect(verdictOf([sheet, ok('value', 'a')]).verdict).toBe(OPEN_RULINGS.equationOnly);
    expect(verdictOf([sheet, ok('device', 'givens')]).verdict).toBe('feasible');
  });

  it('reads anything else as undetermined, listing each failed item', () => {
    const v = verdictOf([sheet, failed('value', 'z', notEvaluated), ok('requirement', 'c')]);
    expect(v.verdict).toBe('undetermined');
    expect(v.failed.map((f) => f.name)).toEqual(['z']);
    // A withheld item alone cannot reach rule 3.
    expect(
      verdictOf([sheet, { kind: 'value', path: [], name: 'w', status: 'withheld', on: [] }])
        .verdict,
    ).toBe('undetermined');
    // A sheet that was not read cannot reach rule 3.
    const unread = failed('sheet', '', {
      kind: 'not-read',
      data: { why: 'format', where: '', message: 'unknown format' },
    });
    expect(verdictOf([unread]).verdict).toBe('undetermined');
  });

  it('says the same at a held point in its own words', () => {
    expect(heldVerdictOf([sheet, failed('search', 'x', proved)]).verdict).toBe(
      'no-operating-point',
    );
    expect(heldVerdictOf([sheet, failed('requirement', 'c', hardFail)]).verdict).toBe(
      'non-compliant',
    );
    expect(heldVerdictOf([sheet]).verdict).toBe('compliant');
    expect(heldVerdictOf([sheet, failed('value', 'z', notEvaluated)]).verdict).toBe('undetermined');
  });
});

group('whether a failed search is proved, decided in one place', () => {
  const wiring: SolveRange = {
    param: 'x',
    range: [0, 1.8],
    from: 'wiring',
    author: [0.1, 0.8],
    wiring: { range: [0, 1.8], below: 'gnd', above: 'vdd' },
    wires: ['x'],
    note: '',
  };
  const over = (range: SolveRange, ended: NoSolutionRead['ended'] = { kind: 'sign' }) => ({
    ...search({
      range,
      searched: range.range,
      stage: range.from === 'wiring' ? 'physical' : 'sheet',
    }),
    ...read([0, 1, 2], [1.8, 1.5, 2]),
    ended,
  });

  it('takes no crossing over the circuit range, both ends read, as not proved', () => {
    const c = noSolutionCause(over(wiring), true);
    expect(c).toMatchObject({ kind: 'no-crossing', data: { notProof: 'not-monotonic' } });
    expect(
      verdictOf([{ kind: 'search', path: [], name: 'x', status: 'failed', cause: c }]).verdict,
    ).toBe('undetermined');
  });

  it('takes it as not proved where an end was not read', () => {
    const c = noSolutionCause(over(wiring), false);
    expect(c).toMatchObject({ kind: 'no-crossing', data: { notProof: 'end-not-read' } });
  });

  it('reads a range the author stated as none in that range', () => {
    expect(noSolutionCause(over(authorRange('x', 0, 1)), true).kind).toBe('none-in-range');
  });

  it('never takes a step or a relation that singles nothing out as proved', () => {
    const step = noSolutionCause(over(wiring, { kind: 'flat' }), true);
    expect(step.kind).toBe('no-crossing');
  });
});

group('the text module builds today’s messages from the data', () => {
  const doc = (params: SheetDoc['params'], equations: SheetDoc['equations'] = []): SheetDoc => ({
    title: 't',
    polarity: 'n',
    params,
    equations,
    checks: [],
  });

  it('a search with no crossing in the author’s range', () => {
    const res = evaluateSheet(
      doc(
        [
          { name: 'goal', value: 50 },
          {
            name: 'x',
            value: 0,
            min: 0,
            max: 10,
            unit: 'V',
            designConstraint: { lhs: 'y', rhs: 'goal' },
          },
        ],
        [{ name: 'y', expr: '2*x + 1' }],
      ),
      dev,
    );
    const c = noSolutionCause(
      { ...search({ unit: 'V' }), ...read([0, 1, 50], [10, 21, 50]) },
      true,
    );
    expect(c.kind).toBe('none-in-range');
    expect(causeMessage(c)).toBe(res.solve?.kind === 'no-solution' ? res.solve.message : '');
  });

  it('a relation that does not read its param', () => {
    const res = evaluateSheet(
      doc([
        { name: 'x', value: 0, min: 0, max: 1, designConstraint: { lhs: 'q', rhs: '2' } },
        { name: 'q', value: 1 },
      ]),
      dev,
    );
    const c = noSolutionCause(
      {
        ...search({
          relation: {
            lhs: 'q',
            rhs: '2',
            field: 'designConstraint',
            reads: { lhs: ['q'], rhs: [] },
          },
          range: authorRange('x', 0, 1),
          searched: [0, 1],
        }),
        ...read([0, 1, 2], [1, 1, 2]),
        ended: { kind: 'flat' },
      },
      false,
    );
    expect(causeMessage(c)).toBe(res.solve?.kind === 'no-solution' ? res.solve.message : '');
  });

  it('a member of a set that found nothing where the others stood', () => {
    const res = evaluateSheet(
      doc([
        { name: 'a', value: 0, min: 0, max: 10, designConstraint: { lhs: 'a', rhs: 'b + 1' } },
        { name: 'b', value: 0, min: 0, max: 10, designConstraint: { lhs: 'b', rhs: 'a + 1' } },
      ]),
      dev,
    );
    const a = search({
      unknown: 'a',
      relation: {
        lhs: 'a',
        rhs: 'b + 1',
        field: 'designConstraint',
        reads: { lhs: ['a'], rhs: ['b'] },
      },
    });
    const b = search({
      unknown: 'b',
      relation: {
        lhs: 'b',
        rhs: 'a + 1',
        field: 'designConstraint',
        reads: { lhs: ['b'], rhs: ['a'] },
      },
      given: [{ name: 'a', value: 10 }],
    });
    const c: Cause = {
      kind: 'did-not-settle',
      data: {
        members: [a, b],
        simplifications: [],
        why: {
          kind: 'member',
          failure: noSolutionCause({ ...b, ...read([0, 0, 11], [10, 10, 11]) }, true),
        },
      },
    };
    expect(causeMessage(c)).toBe(res.solve?.kind === 'not-settled' ? res.solve.message : '');
  });

  it('a relation that evaluates nowhere in its range', () => {
    const res = evaluateSheet(
      doc([
        { name: 'x', value: 0, min: 0, max: 1, designConstraint: { lhs: 'sqrt(-1-x)', rhs: '2' } },
      ]),
      dev,
    );
    const c: Cause = {
      kind: 'did-not-settle',
      data: {
        members: [
          search({
            relation: {
              lhs: 'sqrt(-1-x)',
              rhs: '2',
              field: 'designConstraint',
              reads: { lhs: ['x'], rhs: [] },
            },
            range: authorRange('x', 0, 1),
            searched: [0, 1],
          }),
        ],
        simplifications: [],
        why: {
          kind: 'unevaluable',
          at: { where: 'nowhere', reason: 'sqrt(-1-x) - (2) does not resolve to a finite number' },
        },
      },
    };
    expect(causeMessage(c)).toBe(res.solve?.kind === 'not-settled' ? res.solve.message : '');
  });

  it('says where a wiring range came from', () => {
    const r: SolveRange = {
      param: 'V_x',
      range: [0, 1.8],
      from: 'wiring',
      author: [-0.5, 0.8],
      wiring: { range: [0, 1.8], below: 'gnd', above: 'vdd' },
      wires: ['x'],
      note: '',
    };
    expect(rangeSource(r, [0, 1.8], 'V')).toBe(
      'the range the wiring puts its wire in, between "gnd" and "vdd", after the author\'s range [-0.5, 0.8] V',
    );
  });

  it('describes an item by its cause’s short name and message, and a withheld one by what it depends on', () => {
    expect(describe(failed('value', 'z', notEvaluated))).toMatchObject({
      name: 'cannot be calculated',
      lines: ['z gives no number.', 'The sheet does not define z.'],
    });
    expect(
      describe({
        kind: 'value',
        path: ['amp'],
        name: 'w',
        status: 'withheld',
        on: [{ kind: 'search', path: ['amp'], name: 'x', cause: 'no-crossing' }],
      }),
    ).toMatchObject({
      name: 'not calculated',
      lines: [
        'w in block amp is not calculated, because the engine found no solution for x in block amp.',
      ],
    });
  });
});

group('the texts a reader sees, by the message standard', () => {
  const wiring: SolveRange = {
    param: 'V_tail',
    range: [0, 0.9],
    from: 'wiring',
    wiring: { range: [0, 0.9], below: 'gnd', above: 'tail' },
    wires: ['tail'],
    note: '',
  };
  const tail = (over: Partial<SearchData> = {}): SearchData =>
    search({
      unknown: 'V_tail',
      unit: 'V',
      relation: {
        lhs: 'CM_in',
        rhs: 'CM_dc',
        field: 'designConstraint',
        reads: { lhs: ['CM_in'], rhs: ['CM_dc'] },
        unit: 'V',
        rhsFixed: true,
      },
      range: wiring,
      searched: [0, 0.9],
      stage: 'physical',
      given: [{ name: 'out_share', value: 0.518 }],
      ...over,
    });

  it('a search over the circuit range with no solution found, and no proof', () => {
    const c = noSolutionCause({ ...tail(), ...read([0, 0.562, 1.75], [0.9, 1.64, 1.75]) }, true);
    expect(textOf(c)).toMatchObject({
      name: 'no solution found (not proved)',
      lines: [
        'No value of V_tail makes CM_in equal to CM_dc.',
        'The engine searched the full physical range of wire tail, from 0 V to 0.9 V.',
        'CM_in is 0.562 V at the low end and 1.64 V at the high end.',
        'CM_dc is 1.75 V.',
        'This is not a proof.',
        'The engine did not show that CM_in only rises with V_tail.',
        'The engine held out_share at 0.518 during this search.',
      ],
    });
  });

  it('links each name that is an item to that item', () => {
    const c = noSolutionCause(
      { ...tail({ path: ['bias'], given: [] }), ...read([0, 0.562, 1.75], [0.9, 1.64, 1.75]) },
      true,
    );
    const names = textOf(c)
      .segments.flat()
      .filter((g) => g.kind === 'name');
    expect(names.find((g) => g.text === 'V_tail')?.ref).toEqual({
      kind: 'search',
      path: ['bias'],
      name: 'V_tail',
    });
    expect(names.find((g) => g.text === 'bias')?.ref).toEqual({
      kind: 'sheet',
      path: ['bias'],
      name: '',
    });
  });

  it('claims no more of a right side that is equal at the two ends than those two points', () => {
    const t = tail({ given: [] });
    const c = noSolutionCause(
      {
        ...t,
        relation: { ...t.relation, rhsFixed: undefined },
        ...read([0, 0.562, 1.75], [0.9, 1.64, 1.75]),
      },
      true,
    );
    const lines = textOf(c).lines;
    expect(lines).toContain('CM_dc is 1.75 V at both ends.');
    expect(lines).toContain(
      'The engine did not show that the gap between the two sides only grows with V_tail.',
    );
  });

  it('names the block an unknown belongs to in front of it', () => {
    const c = noSolutionCause(
      { ...tail({ path: ['bias'], given: [] }), ...read([0, 0.562, 1.75], [0.9, 1.64, 1.75]) },
      true,
    );
    expect(textOf(c).lines[0]).toBe('No value of V_tail in block bias makes CM_in equal to CM_dc.');
  });

  it('a search with no solution in the range the sheet states, with the action', () => {
    const c = noSolutionCause(
      {
        ...tail({
          range: authorRange('V_tail', 0.1, 0.5),
          searched: [0.1, 0.5],
          stage: 'sheet',
          given: [],
        }),
        ...read([0.1, 0.6, 1.75], [0.5, 1.2, 1.75]),
      },
      true,
    );
    expect(textOf(c)).toMatchObject({
      name: 'no solution in the stated range',
      lines: [
        'No value of V_tail from 0.1 V to 0.5 V makes CM_in equal to CM_dc.',
        'This range is the search range on the sheet, and the engine did not search outside it.',
        'CM_in is 0.6 V at the low end and 1.2 V at the high end.',
        'CM_dc is 1.75 V.',
        'Widen the search range of V_tail.',
      ],
    });
  });

  it('names the side of a check that gave no number', () => {
    expect(
      textOf(
        {
          kind: 'cannot-evaluate',
          data: { why: 'not-finite', name: 'gain-spec', reason: '', side: 'lhs' },
        },
        { kind: 'requirement', path: [], name: 'gain-spec' },
      ).lines[0],
    ).toBe('The left side of gain-spec gives no number.');
  });

  it('a read outside the table, and a requirement that fails', () => {
    expect(
      textOf({
        kind: 'outside-table',
        data: { device: 'in', quantity: 'l', asked: 5e-6, held: [180e-9, 2e-6] },
      }),
    ).toMatchObject({
      name: 'outside the table',
      lines: [
        'Part in asks for a length of 5 µm.',
        'The table holds lengths from 0.18 µm to 2 µm.',
      ],
    });
    expect(textOf(hardFail, { kind: 'requirement', path: [], name: 'gain-spec' }).lines).toEqual([
      'gain-spec fails.',
      'gain is 2, and gain-spec requires at least 1.',
      'The margin is −100 %.',
    ]);
  });

  it('keeps the message standard in every text the module gives', () => {
    const t = tail();
    const ends = read([0, 0.562, 1.75], [0.9, 1.64, 1.75]);
    const ref = (kind: Item['kind'], name: string, path: string[] = ['bias']) => ({
      kind,
      path,
      name,
    });
    const causes: [Cause, ItemRef?][] = [
      [noSolutionCause({ ...t, ...ends }, true)],
      [
        noSolutionCause(
          { ...t, ...ends, ended: { kind: 'step', at: ends.ends[0], band: 1 } },
          false,
        ),
      ],
      [noSolutionCause({ ...t, ...ends, ended: { kind: 'flat' } }, true)],
      [noSolutionCause({ ...t, ...ends, ended: { kind: 'held-flat', moves: 0, own: 0 } }, true)],
      [
        noSolutionCause(
          {
            ...t,
            range: { ...wiring, author: [0.1, 0.5] },
            ...read([0, 0.562, 1.75], [0.9, 1.64, 1.75]),
            ends: [
              { x: 0, lhs: 0.562, rhs: 1.75, stepped: 'x', steppedOutside: outside },
              { x: 0.9, lhs: 1.64, rhs: 1.8, stepped: 'y' },
            ],
          },
          true,
        ),
      ],
      [
        noSolutionCause(
          {
            ...tail({
              range: authorRange('V_tail', 0.1, 0.5),
              searched: [0.1, 0.5],
              stage: 'sheet',
            }),
            ...ends,
          },
          true,
        ),
      ],
      [
        noSolutionCause(
          { ...tail({ range: { ...wiring, from: 'table' }, stage: 'table' }), ...ends },
          true,
        ),
      ],
      [proved],
      [hardFail],
      [hardFail, ref('requirement', 'gain-spec')],
      [softFail],
      [notEvaluated],
      [notEvaluated, ref('value', 'gain')],
      ...(
        ['no-sweep', 'no-column', 'illegal-pair', 'not-finite', 'not-defined', 'syntax'] as const
      ).flatMap((why): [Cause, ItemRef?][] => {
        const c: Cause = { kind: 'cannot-evaluate', data: { why, name: 'vgs', reason: '' } };
        return [
          [c],
          [c, ref('value', 'gain')],
          [c, ref('device', 'in')],
          [c, ref('device', 'givens', [])],
          ...(['lhs', 'rhs', 'both'] as const).map((side): [Cause, ItemRef] => [
            { kind: 'cannot-evaluate', data: { ...c.data, side } },
            ref('requirement', 'gain-spec'),
          ]),
        ];
      }),
      [{ kind: 'outside-table', data: outside }],
      [{ kind: 'outside-table', data: { ...outside, device: 'givens', quantity: 'vds' } }],
      ...(['format', 'reference', 'field'] as const).flatMap((why): [Cause][] => [
        [{ kind: 'not-read', data: { why, where: 'amp', message: '' } }],
        [{ kind: 'not-read', data: { why, where: '', message: '' } }],
      ]),
      ...(
        ['decision-missing', 'decision-twice', 'assumed-level', 'range-outside', 'netlist'] as const
      ).flatMap((why): [Cause][] => [
        [{ kind: 'not-determined', data: { why, names: ['V_a', 'V_b'], message: '' } }],
        [{ kind: 'not-determined', data: { why, names: [], message: '' } }],
      ]),
      ...(
        [
          { kind: 'sweeps', sweeps: 8, moved: { name: 'V_tail', by: 0.01 }, moves: [] },
          { kind: 'member', failure: proved },
          {
            kind: 'verification',
            tolRel: 1e-6,
            off: [{ name: 'V_tail', tolerance: 1e-6 }],
          },
          { kind: 'unevaluable', at: { where: 'nowhere', reason: '' } },
          {
            kind: 'unevaluable',
            at: { where: 'one-point', end: ends.ends[0], stepped: [] },
          },
          {
            kind: 'unevaluable',
            at: { where: 'crossing', ends: ends.ends, between: [0.3, 0.4], reason: '' },
          },
        ] as DidNotSettleData['why'][]
      ).map((why): [Cause] => [
        {
          kind: 'did-not-settle',
          data: {
            members: [t, tail({ unknown: 'V_out', path: ['bias'] })],
            simplifications: ['ideal mirrors'],
            why,
          },
        },
      ]),
      [{ kind: 'limit', data: { members: [t], limit: 'evaluations', count: 2000 } }],
      [{ kind: 'limit', data: { members: [t], limit: 'probes', count: 200 } }],
      [{ kind: 'statement-false', data: { path: [], param: 'V_x', statement: 'I_a - I_b' } }],
      [
        {
          kind: 'statement-false',
          data: {
            path: ['bias'],
            param: 'V_x',
            statement: 'I_a - I_b',
            balance: { reads: 3e-6, tolerance: 1e-9 },
          },
        },
      ],
    ];
    const texts: Line[] = [];
    for (const [c, r] of causes) {
      const f = textOf(c, r);
      texts.push(...f.segments);
      for (const k of ['sheet', 'value', 'device', 'search', 'requirement'] as const)
        for (const path of [[], ['bias']])
          texts.push(
            ...describe({
              kind: k,
              path,
              name: 'w',
              status: 'withheld',
              on: [{ ...ref(k === 'value' ? 'search' : k, 'V_tail', path), cause: c.kind }],
            }).segments,
          );
    }
    for (const c of CAUSES) texts.push(withheldClause({ ...ref('search', 'V_tail'), cause: c }));
    texts.push(...notAskedText('range end', 'cm-lo').segments);
    texts.push(...notAskedText('held point', 'ss at 125 °C').segments);
    for (const l of texts) {
      const line = lineText(l);
      expect({ line, problems: standardProblems(l) }).toEqual({ line, problems: [] });
    }
    for (const l of texts)
      expect(lineText(l)).not.toMatch(/\de[+-]?\d|"|\blhs\b|\brhs\b|\bparam\b/);
  });

  it('says what a value the run held reads, and why the verdict is undetermined', () => {
    const held: Item = {
      kind: 'search',
      path: [],
      name: 'V_out',
      status: 'ok',
      attributes: {
        kind: 'held',
        value: 0.6,
        unit: 'V',
        relation: { lhs: 'V_out', rhs: 'V_ref', field: 'designConstraint' },
      },
    };
    expect(describe(held)).toMatchObject({
      name: 'held',
      lines: [
        'V_out is held at 0.6 V.',
        'The engine did not check the constraint of V_out at this value.',
      ],
    });
    const v = verdictOf([held]);
    expect(v.verdict).toBe('undetermined');
    expect(verdictText(v).map(lineText)).toEqual([
      'The verdict is undetermined, because V_out is held and not solved.',
    ]);
    for (const l of [...describe(held).segments, ...verdictText(v)])
      expect(standardProblems(l)).toEqual([]);
  });

  it('gives no margin line against a limit of zero, and a negative value with the minus sign', () => {
    const zero = failsCause({
      kind: 'spec',
      text: { lhs: 'x', op: '<=', rhs: '0' },
      lhsValue: 2,
      rhsValue: 0,
      margin: -2,
      marginPct: -2e300,
      unit: 'V',
    });
    // Against a limit of zero the margin would repeat the value; the line is left out.
    expect(textOf(zero).lines).toEqual([
      'The check fails.',
      'x is 2 V, and the check requires at most 0 V.',
    ]);
    // A value below zero takes the minus sign, not the hyphen.
    expect(
      textOf(
        failsCause({
          kind: 'spec',
          text: { lhs: 'x', op: '>=', rhs: '0' },
          lhsValue: -1.55,
          rhsValue: 0,
          margin: -1.55,
          marginPct: -2e300,
        }),
      ).lines,
    ).toEqual(['The check fails.', 'x is −1.55, and the check requires at least 0.']);
  });

  it('says what a held point that was not run reads', () => {
    expect(notAskedText('range end', 'cm-lo')).toMatchObject({
      name: 'not run',
      lines: ['The engine did not run range end cm-lo, because the design point has no design.'],
    });
  });
});

group('the message standard, as a test reads it', () => {
  it('takes a full sentence with its subject first', () => {
    expect(
      standardProblems(
        'The engine searched the full physical range of wire tail, from 0 V to 0.9 V.',
      ),
    ).toEqual([]);
  });

  it('refuses a line that opens with a label and a colon, or runs past 20 words', () => {
    for (const line of [
      'Searched: 0 V to 0.9 V.',
      'Not proved: the engine did not show it.',
      'Part in: L = 5 µm.',
    ])
      expect(standardProblems(line)).toContain('opens with a label and a colon');
    expect(standardProblems(Array(21).fill('word').join(' '))).toContain('more than 20 words');
  });
});

group('the texts of a finding with no item of its own', () => {
  const net = (netlist: NetlistAbout): Item => ({
    kind: 'sheet',
    path: [],
    name: '',
    status: 'failed',
    cause: {
      kind: 'not-determined',
      data: { why: 'netlist', names: [...(netlist.wires ?? [])], message: '', netlist: [netlist] },
    },
  });
  const lines = (i: Item): string[] => describe(i).lines.slice(1);
  const head = 'The statements of the sheet do not determine one design.';

  it('names the problem of the netlist check and the wires and devices it is about', () => {
    const cases: [NetlistAbout, string[]][] = [
      [
        { problem: 'short', wires: ['vdd'], devices: ['givens'] },
        ['The device of this sheet has its drain and its source on wire vdd, which shorts it.'],
      ],
      [
        { problem: 'wire-name', wires: ['a.b'], devices: ['givens'] },
        [
          'The wire name a.b is not valid.',
          'A wire name is an identifier of letters, digits and underscores.',
        ],
      ],
      [
        { problem: 'one-terminal', wires: ['lone'] },
        [
          'Only one terminal names wire lone.',
          'A wire joins two terminals or more, or the sheet gives it a level, or it is a port.',
        ],
      ],
      [
        { problem: 'level-unnamed', wires: ['zz'] },
        ['The sheet gives wire zz a level, but no terminal, element or port names zz.'],
      ],
      [
        { problem: 'unwired', devices: ['givens', 'tail'] },
        ['The sheet names no wires for the device of this sheet and part tail.'],
      ],
      [
        { problem: 'diode-flag', devices: ['load'] },
        ['The wires of part load and its diode flag disagree.'],
      ],
      [
        { problem: 'diode-flag', devices: ['ldr'], diodeFlag: false },
        ['The wires of part ldr put its gate on its drain, but its diode flag is off.'],
      ],
      [
        { problem: 'diode-flag', devices: ['ldr'], diodeFlag: true },
        ['The diode flag of part ldr is on, but its wires do not put its gate on its drain.'],
      ],
      [
        { problem: 'placement', devices: ['load'] },
        ['The wiring of part load is not well formed.'],
      ],
      [
        { problem: 'placement', devices: ['load'], placement: { fault: 'shape' } },
        [
          'The wiring of part load is not well formed.',
          "A part's wiring is one placement of drain, gate, source and body wires, or a list of placements.",
        ],
      ],
      [
        { problem: 'placement', devices: ['givens'], placement: { fault: 'shape', none: true } },
        [
          'The wiring of the device of this sheet is not well formed.',
          "A part's wiring is one placement of drain, gate, source and body wires, a list of placements, or none.",
        ],
      ],
      [
        {
          problem: 'placement',
          devices: ['load'],
          placement: { fault: 'unknown-key', key: 'bulk' },
        },
        [
          'The wiring of part load names bulk, which a placement does not have.',
          'A placement names only the drain, gate, source and body wires.',
        ],
      ],
      [
        {
          problem: 'placement',
          devices: ['load'],
          placement: { fault: 'no-wire', terminal: 'g', index: 1 },
        },
        ['Placement 2 of part load names no wire for the gate.', 'Each terminal needs a wire.'],
      ],
      [
        { problem: 'placement', devices: ['load'], placement: { fault: 'intent', value: 'on' } },
        [
          'The wiring of part load sets its intent to on.',
          'The only intent that a placement can set is off, for a device meant to be off.',
        ],
      ],
      [
        { problem: 'placement', devices: ['load'], placement: { fault: 'mixed-diode' } },
        [
          'Some placements of part load put the gate on the drain wire and some do not.',
          'Put the diode-connected placements and the others in separate blocks.',
        ],
      ],
      [
        {
          problem: 'level-refused',
          wires: ['out'],
          level: 'V_out_dc',
          refused: [
            { reason: 'class', name: 'V_out_dc', cls: 'assumed' },
            { reason: 'class', name: 'V_tail', cls: 'solved' },
            { reason: 'class', name: 'V_s', cls: 'held' },
            { reason: 'class', name: 'k', cls: 'unclassified' },
            { reason: 'unresolved', name: 'nope' },
            { reason: 'cycle', via: ['a', 'b'] },
            { reason: 'device', device: 'in' },
            { reason: 'equation', name: 'gain' },
            { reason: 'solved-relation', name: 'V_tail' },
            { reason: 'analysis', name: 'ac' },
          ],
        },
        [
          'The level V_out_dc cannot hold wire out.',
          'V_out_dc is classed assumed, and a held level does not rest on a typed guess.',
          'V_tail is solved by the engine, so the level it sets is derived.',
          'V_s is the node under a gate that a hold solves again, so its wire is derived.',
          'k carries no class, and a held level reads only params classed independent.',
          'nope names nothing on the sheet.',
          'The dependencies of the level loop through a and b.',
          'The level reads a quantity of part in, and a level derived from a device is never held.',
          'The level reads equation gain, and a held level reads no equation.',
          'The level reads through the relation that solves V_tail.',
          'The level reads analysis ac.',
        ],
      ],
      [
        { problem: 'selector', devices: ['givens'], param: 's' },
        ['The axis-sign selector s does not match the table of the device of this sheet.'],
      ],
    ];
    for (const [about, want] of cases) {
      const i = net(about);
      expect(describe(i).lines[0]).toBe(head);
      expect(lines(i)).toEqual(want);
      for (const l of describe(i).segments) expect(standardProblems(l)).toEqual([]);
    }
  });

  it('says which range end gives no number, and which value it holds that was not recorded', () => {
    const set: Item = {
      kind: 'sheet',
      path: [],
      name: '',
      status: 'failed',
      cause: {
        kind: 'cannot-evaluate',
        data: {
          why: 'not-finite',
          name: 'nonsense_name',
          reason: '',
          rangeEnd: { name: 'lo', param: 'VD', expression: 'nonsense_name' },
        },
      },
    };
    expect(describe(set).lines).toEqual([
      'Range end lo sets VD to nonsense_name.',
      'At the design point, nonsense_name gives no number.',
    ]);
    const unheld: Item = {
      kind: 'sheet',
      path: [],
      name: '',
      status: 'failed',
      cause: {
        kind: 'not-determined',
        data: { why: 'operating-range', names: ['lo'], unheld: ['I_b'], message: '' },
      },
    };
    expect(lines(unheld)).toEqual([
      'Range end lo holds I_b at the value of the design run.',
      'The design run recorded no value for it.',
    ]);
    for (const l of [...describe(set).segments, ...describe(unheld).segments])
      expect(standardProblems(l)).toEqual([]);
  });
});

group('the texts of the data an item now carries', () => {
  const failed = (kind: Item['kind'], name: string, cause: Cause): Item => ({
    kind,
    path: [],
    name,
    status: 'failed',
    cause,
  });
  const check = (i: Item, want: string[]): void => {
    expect(describe(i).lines).toEqual(want);
    for (const l of describe(i).segments) expect(standardProblems(l)).toEqual([]);
  };

  it('names the statements of a value that more than one statement sets', () => {
    check(
      failed('sheet', '', {
        kind: 'not-determined',
        data: {
          why: 'decision-twice',
          names: ['V_out'],
          message: '',
          statements: [{ name: 'V_out', fields: ['designConstraint', 'hold'] }],
        },
      }),
      [
        'The statements of the sheet do not determine one design.',
        'V_out has a constraint and a hold, and only one may set it.',
      ],
    );
  });

  it('gives where the parser stops in an expression with a syntax error', () => {
    const syntax = (at?: number): Item =>
      failed('value', 'y', {
        kind: 'cannot-evaluate',
        data: {
          why: 'syntax',
          name: 'y',
          reason: '',
          syntax: { expression: 'a +* b', ...(at !== undefined ? { at } : {}), problem: '' },
        },
      });
    check(syntax(3), ['y gives no number.', 'y has a syntax error at character 4 of a +* b.']);
    check(syntax(), ['y gives no number.', 'y has a syntax error in a +* b.']);
  });

  it('names the input a block is given no value for', () => {
    check(
      failed('sheet', '', {
        kind: 'cannot-evaluate',
        data: { why: 'not-finite', name: 'tail', reason: '', inputs: ['vds_t'] },
      }),
      ['Block tail is not calculated, because its parent sheet gives it no value for vds_t.'],
    );
    // A name its parent's expression reads that no entry declares: the block, named by its path
    // in its own list, and the name.
    const undeclared = failed('sheet', '', {
      kind: 'cannot-evaluate',
      data: { why: 'not-defined', name: 'nope', reason: '', inputs: ['I_ref'] },
    });
    expect(describe(undeclared, ['bias']).lines).toEqual([
      'Block bias is not calculated, because its parent sheet gives it no value for I_ref.',
      'The parent sheet does not define nope.',
    ]);
  });

  it('names the quantity on each side of a region check', () => {
    const region: Item = {
      kind: 'requirement',
      path: [],
      name: 'region',
      status: 'failed',
      cause: failsCause({
        kind: 'physical',
        text: { lhs: 'abs(vds)', op: '>=', rhs: 'vdsat' },
        lhsValue: 0.25,
        rhsValue: 0.551,
        margin: -0.301,
        marginPct: -54.6,
        unit: 'V',
        region: 'saturation',
      }),
    };
    expect(describe(region).lines.slice(0, 2)).toEqual([
      'The region check of the device of this sheet fails.',
      'The drain-source voltage of the device of this sheet is 0.25 V, and saturation needs at least 0.551 V.',
    ]);
    for (const l of describe(region).segments) expect(standardProblems(l)).toEqual([]);
  });

  it('says which names a value reads give no number, or that its own arithmetic gives none', () => {
    const nf = (notFinite: string[]): Item =>
      failed('value', 'y', {
        kind: 'cannot-evaluate',
        data: { why: 'not-finite', name: 'y', reason: '', notFinite },
      });
    check(nf(['a']), ['y gives no number.', 'y reads a, which gives no number.']);
    check(nf([]), [
      'y gives no number.',
      'Every name that y reads gives a number, but the expression of y gives none.',
    ]);
  });
});

group('the text of a block’s part read beyond its table, in its parent’s list', () => {
  it('names the block’s part, and the block’s param that sets the reading', () => {
    const i: Item = {
      kind: 'device',
      path: ['ref_casc'],
      name: 'givens',
      status: 'failed',
      cause: {
        kind: 'outside-table',
        data: { device: 'givens', quantity: 'vsb', asked: 0.937, held: [0, 0.9], setBy: 'vsb_rc' },
      },
    };
    expect(describe(i).lines).toEqual([
      'Part ref_casc asks for a source-body voltage of 0.937 V.',
      'The table holds source-body voltages from 0 V to 0.9 V.',
      'Change vsb_rc in block ref_casc, or load a table that holds this source-body voltage.',
    ]);
    for (const l of describe(i).segments) expect(standardProblems(l)).toEqual([]);
  });
});

group('a text for every item the types allow', () => {
  it('describe gives lines, and never throws, on odd but type-correct data of every cause', () => {
    const rel = {
      lhs: '',
      rhs: '',
      field: 'designConstraint' as const,
      reads: { lhs: [], rhs: [] },
    };
    const sd: SearchData = {
      path: [],
      unknown: '',
      held: false,
      relation: rel,
      range: { param: '', range: [Number.NaN, Number.NaN], from: 'author', note: '' },
      searched: [Number.NaN, Number.NaN],
      stage: 'sheet',
    };
    const end = { x: Number.NaN, lhs: Number.NaN, rhs: Number.NaN };
    const read = { ends: [end, end] as const, ended: { kind: 'flat' as const } };
    const odd = (op: string) =>
      ({ lhs: '', op, rhs: '' }) as unknown as { lhs: string; op: '>='; rhs: string };
    const causes: Cause[] = [
      { kind: 'not-read', data: { why: 'format', where: '', message: '' } },
      { kind: 'not-read', data: { why: 'reference', where: '', message: '' } },
      { kind: 'not-read', data: { why: 'field', where: '', message: '', entry: 'param' } },
      ...(
        [
          'decision-missing',
          'decision-twice',
          'assumed-level',
          'range-outside',
          'netlist',
          'loop',
          'operating-range',
        ] as const
      ).map((why): Cause => ({ kind: 'not-determined', data: { why, names: [], message: '' } })),
      {
        kind: 'not-determined',
        data: {
          why: 'netlist',
          names: [],
          message: '',
          netlist: [{ problem: 'short' }, { problem: 'other' }],
        },
      },
      {
        kind: 'outside-table',
        data: { device: '', quantity: '', asked: Number.NaN, held: [0, 0] },
      },
      ...(
        ['no-sweep', 'no-column', 'illegal-pair', 'not-finite', 'not-defined', 'syntax'] as const
      ).map((why): Cause => ({ kind: 'cannot-evaluate', data: { why, name: '', reason: '' } })),
      {
        kind: 'cannot-evaluate',
        data: {
          why: 'not-finite',
          name: '',
          reason: '',
          unevaluable: { member: sd, at: { where: 'nowhere', reason: '' } },
        },
      },
      { kind: 'no-solution', data: { ...sd, ...read, shown: 'monotonic' } },
      { kind: 'no-crossing', data: { ...sd, ...read, notProof: 'not-monotonic', endsRead: false } },
      { kind: 'none-in-range', data: { ...sd, ...read, endsRead: false } },
      {
        kind: 'did-not-settle',
        data: {
          members: [],
          simplifications: [],
          why: { kind: 'sweeps', sweeps: 0, moved: { name: '', by: 0 }, moves: [] },
        },
      },
      {
        kind: 'did-not-settle',
        data: {
          members: [],
          simplifications: [],
          why: { kind: 'verification', tolRel: 0, off: [] },
        },
      },
      { kind: 'limit', data: { members: [], limit: 'evaluations', count: 0 } },
      { kind: 'limit', data: { members: [], limit: 'probes', count: 0 } },
      { kind: 'statement-false', data: { path: [], param: '', statement: '' } },
      {
        kind: 'fails',
        data: { text: odd('>>'), lhs: 1, rhs: 0, margin: 0, marginPct: 0, hard: true },
      },
      {
        kind: 'fails',
        data: {
          text: odd('>>'),
          lhs: 1,
          rhs: 2,
          margin: 0,
          marginPct: 0,
          hard: true,
          region: 'saturation',
        },
      },
    ];
    const kinds: Item['kind'][] = ['sheet', 'value', 'device', 'search', 'requirement'];
    for (const cause of causes)
      for (const kind of kinds) {
        const item: Item = {
          kind,
          path: [],
          name: kind === 'requirement' ? 'region' : '',
          status: 'failed',
          cause,
        };
        let lines: readonly string[] = [];
        expect(() => (lines = describe(item).lines), `${cause.kind} on ${kind}`).not.toThrow();
        expect(lines.length, `${cause.kind} on ${kind}`).toBeGreaterThan(0);
      }
    for (const kind of kinds)
      expect(describe({ kind, path: [], name: '', status: 'withheld', on: [] }).lines.length).toBe(
        1,
      );
  });
});

group('the parser’s reason for a syntax error, where a plain sentence says it', () => {
  it('adds the reason line from the table, and none where the table has no entry', () => {
    const at = (expression: string): string[] => {
      const found = syntaxAt(expression)!;
      return describe({
        kind: 'value',
        path: [],
        name: 'y',
        status: 'failed',
        cause: {
          kind: 'cannot-evaluate',
          data: { why: 'syntax', name: 'y', reason: '', syntax: { expression, ...found } },
        },
      }).lines.slice(2);
    };
    expect(at('a + (b')).toEqual(['A parenthesis is not closed.']);
    expect(at('f(a')).toEqual(['A parenthesis is not closed.']);
    expect(at('(a))')).toEqual(['A closing parenthesis has no parenthesis that it closes.']);
    expect(at('a +* b')).toEqual(['An operator has nothing after it.']);
    expect(at('1a + b')).toEqual(['A name starts with a digit.']);
    expect(at('a ? b')).toEqual([]);
  });
});

group('the texts the audit of the item data asked for', () => {
  it('gives one verdict reason for every value the run held', () => {
    const v = verdictOf([
      {
        kind: 'search',
        path: [],
        name: 'a',
        status: 'ok',
        attributes: {
          kind: 'held',
          value: 1,
          relation: { lhs: 'a', rhs: 'b', field: 'designConstraint' },
        },
      },
      {
        kind: 'search',
        path: [],
        name: 'c',
        status: 'ok',
        attributes: {
          kind: 'held',
          value: 1,
          relation: { lhs: 'c', rhs: 'b', field: 'designConstraint' },
        },
      },
    ]);
    expect(verdictText(v).map(lineText)).toEqual([
      'The verdict is undetermined, because a and c are held and not solved.',
    ]);
  });

  it('says what kind of entry is not well formed, and what a tolerance must be', () => {
    const entry = (e: NonNullable<NotReadData['entry']>, where: string): readonly string[] =>
      describe(
        failed('sheet', '', {
          kind: 'not-read',
          data: { why: 'field', where, message: '', entry: e },
        }),
      ).lines;
    expect(entry('param', 'I_tail')).toEqual(['The entry of I_tail is not well formed.']);
    expect(entry('selector', 'ld_sign')).toEqual([
      'The axis-sign selector ld_sign is not well formed.',
    ]);
    expect(entry('check', 'gain')).toEqual(['The entry of check gain is not well formed.']);
    expect(entry('tolerance', 'eq')).toEqual([
      'The tolerance of check eq is not a number of zero or more.',
    ]);
    expect(entry('device', 'givens')).toEqual(['The device of this sheet is not well formed.']);
    expect(entry('block', 'bias')).toEqual(['The entry of block bias is not well formed.']);
    expect(entry('expression', 'CM_in')).toEqual(['The expression of CM_in is not well formed.']);
    expect(entry('range-end', 'cm-lo')).toEqual(['Range end cm-lo is not well formed.']);
  });

  it('gives an end stepped in by more than a thousandth of the range its own line, and none to a smaller step', () => {
    const d: NoCrossingData = {
      ...search({
        unit: 'V',
        stage: 'physical',
        range: {
          ...authorRange('x', 0, 0.9),
          wiring: { range: [0, 0.9], below: 'gnd', above: 'vdd' },
        },
        searched: [0, 0.9],
      }),
      ends: [
        { x: 0, lhs: 1, rhs: 2 },
        { x: 0.898, lhs: 1.5, rhs: 2, stepped: 'gives no number' },
      ],
      ended: { kind: 'sign' },
      notProof: 'end-not-read',
      endsRead: false,
    };
    const lines = describe(failed('search', 'x', { kind: 'no-crossing', data: d })).lines;
    // A step of 2 mV in a range of 0.9 V is more than a thousandth of it: its own line, with the
    // digits that tell it from the range end, and no line of the stretch searched to repeat it.
    expect(lines.some((l) => l.startsWith('Above 0.898 V,'))).toBe(true);
    expect(lines.some((l) => l.startsWith('The engine searched it'))).toBe(false);
    // A step of less than a thousandth of the range reads as the range end, with no line.
    const tiny: NoCrossingData = {
      ...d,
      ends: [
        { x: 4.29e-7, lhs: 1, rhs: 2, stepped: 'gives no number' },
        { x: 0.8999, lhs: 1.5, rhs: 2, stepped: 'gives no number' },
      ],
    };
    const t2 = describe(failed('search', 'x', { kind: 'no-crossing', data: tiny })).lines;
    expect(t2.some((l) => /^(Above|Below)/.test(l))).toBe(false);
    expect(t2).toContain(
      'The engine searched the full physical range of wire vdd, from 0 V to 0.9 V.'.replace(
        'wire vdd',
        'x',
      ),
    );
    for (const l of describe(failed('search', 'x', { kind: 'no-crossing', data: tiny })).segments)
      expect(standardProblems(l)).toEqual([]);
  });

  it('names an operator that no entry lists, and does not stop', () => {
    const c = failsCause({
      kind: 'spec',
      text: { lhs: 'x', op: '>>' as never, rhs: 'y' },
      lhsValue: 1,
      rhsValue: 2,
      margin: -1,
      marginPct: -0.5,
    });
    expect(textOf(c).lines[1]).toBe('x is 1, and the check requires a value related by >> to 2.');
  });
});

group('the texts that name the value a field holds', () => {
  const field = (
    entry: NonNullable<NotReadData['entry']>,
    where: string,
    f: NonNullable<NotReadData['field']>,
    why: 'field' | 'reference' = 'field',
  ): readonly string[] =>
    describe(
      failed('sheet', '', { kind: 'not-read', data: { why, where, message: '', entry, field: f } }),
    ).lines;
  it('says what the value is and what it must be', () => {
    const cases: [readonly string[], string][] = [
      [
        field('param', 'I_tail', { name: 'value', value: 'abc', problem: 'not-a-number' }),
        'The engine cannot read I_tail, because its value abc is not a number.',
      ],
      [
        field('selector', 'ld_sign', { name: 'value', value: 5, problem: 'sign' }),
        'ld_sign is 5, and a sign convention must be +1 or −1.',
      ],
      [
        field('tolerance', 'eq', { name: 'tolPct', value: 'x', problem: 'not-a-number' }),
        'The engine cannot read the tolerance of check eq, because its value x is not a number.',
      ],
      [
        field('range-end', 'cm-lo', { name: 'set', key: 'NOPE', problem: 'unknown-name' }),
        'Range end cm-lo sets NOPE, which is not an input of this sheet.',
      ],
      [
        field('block', 'tail', { name: 'params', key: 'nope', problem: 'unknown-name' }),
        'Block tail sets nope, but its sheet has no input of that name.',
      ],
      [
        field('check', 'gain-spec', { name: 'op', value: '>>', problem: 'operator' }),
        'The engine cannot read check gain-spec, because >> is not an operator that it knows.',
      ],
    ];
    cases.push([
      field('tolerance', 'eq', { name: 'tolPct', value: -5, problem: 'not-a-number' }),
      'The tolerance of check eq is −5 %, and a tolerance must be zero or more.',
    ]);
    for (const [lines, want] of cases) expect(lines).toEqual([want]);
    // The value as the sheet writes it is a segment of its own, set apart from the words.
    const seg = describe(
      failed('value', 'CL', {
        kind: 'not-read',
        data: {
          why: 'field',
          where: 'CL',
          message: '',
          entry: 'param',
          field: { name: 'value', value: 'text', problem: 'not-a-number' },
        },
      }),
    ).segments[0];
    expect(seg.find((x) => x.text === 'text')?.kind).toBe('value');
    for (const [lines] of cases) expect(lines.flatMap((l) => standardProblems(l))).toEqual([]);
    expect(
      field('block', 'bias', { name: 'ref', value: 'nope/nope', problem: 'no-sheet' }, 'reference'),
    ).toContain(
      'Block bias refers to the sheet nope/nope, and the library holds no sheet of that name.',
    );
  });

  it('names a level that cannot hold its wire', () => {
    const net = (n: NetlistAbout): readonly string[] =>
      describe(
        failed('sheet', '', {
          kind: 'not-determined',
          data: { why: 'netlist', names: [], message: '', netlist: [n] },
        }),
      ).lines.slice(1);
    expect(net({ problem: 'level-refused', wires: ['vinp'], level: 'CM_dc + V_tail' })).toEqual([
      'The sheet gives wire vinp the level CM_dc + V_tail, but a level can read only numbers, specs and knobs.',
    ]);
    expect(net({ problem: 'level-gate', wires: ['x'], devices: ['ld'], level: 'vg' })).toEqual([
      'Wire x cannot be held at vg, because that level holds only the gate of part ld.',
    ]);
  });
});

group('the message standard reads bracket as the search’s word only', () => {
  it('flags a bracket, and not a square bracket', () => {
    expect(standardProblems('The engine widened the bracket.')).toContain('a word of the code');
    expect(standardProblems('A square bracket is not closed.')).toEqual([]);
  });
});

group('findings of the netlist check that say the same thing', () => {
  it('give their sentence once', () => {
    const i = failed('sheet', '', {
      kind: 'not-determined',
      data: {
        why: 'netlist',
        names: ['tail'],
        message: '',
        netlist: [
          { problem: 'placement', devices: ['tail'] },
          { problem: 'placement', devices: ['tail'] },
          { problem: 'placement', devices: ['tail'] },
        ],
      },
    });
    expect(describe(i).lines).toEqual([
      'The statements of the sheet do not determine one design.',
      'The wiring of part tail is not well formed.',
    ]);
  });
});

group('a range end that is not calculated', () => {
  const end = (on: WithheldOn[]): Item => ({
    kind: 'sheet',
    path: [],
    name: '',
    status: 'withheld',
    on,
  });
  const check = (
    item: Item,
    name: string | undefined,
    design: Item[] | undefined,
    want: string[],
  ) => {
    const said = describe(item, [], name, design);
    expect(said.lines).toEqual(want);
    for (const l of said.segments) expect(standardProblems(l)).toEqual([]);
  };
  const searchFailed = failed('search', 'V_tail', {
    kind: 'cannot-evaluate',
    data: { why: 'not-finite', name: 'V_tail', reason: '' },
  });
  const wiring: Item = {
    kind: 'sheet',
    path: ['in'],
    name: '',
    status: 'failed',
    cause: {
      kind: 'not-determined',
      data: {
        why: 'netlist',
        names: ['in'],
        message: '',
        netlist: [
          {
            problem: 'placement',
            devices: ['in'],
            placement: { fault: 'unknown-key', key: 'x' },
          },
        ],
      },
    },
  };

  it('names the end, says why from the design point’s items, and gives one line for each', () => {
    check(
      end([{ kind: 'sheet', path: ['in'], name: '', frame: 'design', cause: 'not-determined' }]),
      'cm-lo',
      [wiring],
      [
        'Range end cm-lo is not calculated, because the statements of the sheet do not determine one design.',
        'At the design point, the wiring of part in names x, which a placement does not have.',
      ],
    );
  });

  it('says the design point has no design where an item it waits on failed', () => {
    const said = describe(
      end([
        { kind: 'search', path: [], name: 'V_tail', frame: 'design', cause: 'cannot-evaluate' },
      ]),
      [],
      'cm-lo',
      [searchFailed],
    ).lines;
    expect(said).toEqual([
      'Range end cm-lo is not calculated, because the design point has no design.',
      'At the design point, the engine could not calculate V_tail.',
    ]);
  });

  it('says the design point rests on an assumed level', () => {
    const assumed = failed('value', 'V_out_dc', {
      kind: 'not-determined',
      data: { why: 'assumed-level', names: ['V_out_dc'], message: '' },
    });
    check(
      end([
        { kind: 'value', path: [], name: 'V_out_dc', frame: 'design', cause: 'not-determined' },
      ]),
      'cm-hi',
      [assumed],
      [
        'Range end cm-hi is not calculated, because the design point rests on an assumed level.',
        'At the design point, V_out_dc is an assumed level.',
      ],
    );
  });

  it('names what the engine did for a search that found no solution', () => {
    const noCrossing = failed('search', 'V_tail', {
      kind: 'no-crossing',
      data: {
        ...search({ unknown: 'V_tail' }),
        ...read([0, 1, 2], [1, 3, 2]),
        notProof: 'not-monotonic',
        endsRead: false,
      },
    });
    check(
      end([{ kind: 'search', path: [], name: 'V_tail', frame: 'design', cause: 'no-crossing' }]),
      'cm-lo',
      [noCrossing],
      [
        'Range end cm-lo is not calculated, because the design point has no design.',
        'At the design point, the engine found no solution for V_tail.',
      ],
    );
  });

  it('gives one line and no reason, where the design point’s list is not given', () => {
    check(
      end([{ kind: 'sheet', path: ['in'], name: '', frame: 'design', cause: 'not-determined' }]),
      'cm-lo',
      undefined,
      ['Range end cm-lo is not calculated.'],
    );
  });
});

group('why a run is not complete, as one string', () => {
  it('gives each finding’s name, then its lines, one to a line', () => {
    const items: Item[] = [
      { kind: 'sheet', path: [], name: '', status: 'ok' },
      failed('device', 'givens', {
        kind: 'outside-table',
        data: { device: 'givens', quantity: 'l', asked: 5e-6, held: [180e-9, 2e-6] },
      }),
    ];
    const [f] = incompleteText(items);
    expect(incompleteMessage(items)).toBe([f.name, ...f.lines].join('\n'));
    // Nothing incomplete: nothing to say.
    expect(incompleteText([{ kind: 'sheet', path: [], name: '', status: 'ok' }])).toEqual([]);
    expect(incompleteMessage([{ kind: 'sheet', path: [], name: '', status: 'ok' }])).toBe('');
    // Incomplete, with no failed item to say why.
    expect(
      incompleteMessage([
        {
          kind: 'value',
          path: [],
          name: 'y',
          status: 'withheld',
          on: [{ kind: 'value', path: [], name: 'x', cause: 'cannot-evaluate' }],
        },
      ]),
    ).toBe('The evaluation did not complete.');
  });
});

group('why a range end that is not calculated is not complete', () => {
  it('is that end’s own text', () => {
    const design = [
      failed('search', 'V_tail', {
        kind: 'cannot-evaluate',
        data: { why: 'not-finite', name: 'V_tail', reason: '' },
      }),
    ];
    const items: Item[] = [
      {
        kind: 'sheet',
        path: [],
        name: '',
        status: 'withheld',
        on: [
          { kind: 'search', path: [], name: 'V_tail', frame: 'design', cause: 'cannot-evaluate' },
        ],
      },
    ];
    expect(incompleteMessage(items, 'cm-lo', design).split('\n').slice(1)).toEqual([
      'Range end cm-lo is not calculated, because the design point has no design.',
      'At the design point, the engine could not calculate V_tail.',
    ]);
  });
});

group('the line of an undetermined verdict', () => {
  it('names a range end whose own entry failed, and each other failed item', () => {
    const v: Verdict = {
      verdict: 'undetermined',
      failed: [
        {
          kind: 'sheet',
          path: [],
          name: '',
          end: 'cm-lo',
          cause: { kind: 'cannot-evaluate', data: { why: 'syntax', name: '((', reason: '' } },
        },
        {
          kind: 'search',
          path: [],
          name: 'V_tail',
          cause: {
            kind: 'cannot-evaluate',
            data: { why: 'not-finite', name: 'V_tail', reason: '' },
          },
        },
      ],
    };
    const lines = verdictText(v);
    expect(lines.map(lineText)).toEqual([
      'The verdict is undetermined, because the entry of range end cm-lo is not well formed.',
      'The verdict is undetermined, because the engine could not calculate V_tail.',
    ]);
    expect(lines[0].find((sg) => sg.kind === 'name')).toEqual({ kind: 'name', text: 'cm-lo' });
    for (const l of lines) expect(standardProblems(l)).toEqual([]);
  });
});
