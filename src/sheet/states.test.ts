// The set of states: the closed list of causes, the kinds of item each may occur on, the four
// verdict rules and their order, the one place a failed search is taken as proved, and the text
// module that builds today's messages from a cause's data.

import { describe as group, it, expect } from 'vitest';
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
  type Cause,
  type Item,
  type SearchData,
  type NoSolutionRead,
} from './states';
import { CAUSE_NAMES, causeMessage, describe, rangeSource } from './describe';
import type { SheetDoc, SolveRange } from './types';

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
  cause: 'no-solution',
  data: { ...search(), ...read([0, 1, 50], [10, 21, 50]), shown: 'ends-read' },
};
const hardFail = failsCause({
  kind: 'spec',
  lhsValue: 2,
  rhsValue: 1,
  margin: -1,
  marginPct: -100,
});
const softFail = failsCause({
  kind: 'advisory',
  lhsValue: 2,
  rhsValue: 1,
  margin: -1,
  marginPct: -100,
});
const notEvaluated: Cause = {
  cause: 'cannot-evaluate',
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
        on: [{ kind: 'value', path: [], name: 'z' }],
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
      cause: 'not-read',
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
    ...search({ range, searched: range.range }),
    ...read([0, 1, 2], [1.8, 1.5, 2]),
    ended,
  });

  it('takes no crossing over the circuit range, both ends read, as proved', () => {
    expect(OPEN_RULINGS.noCrossingOverWiringIsProof).toBe(true);
    expect(noSolutionCause(over(wiring), true).cause).toBe('no-solution');
  });

  it('takes it as not proved where an end was not read', () => {
    const c = noSolutionCause(over(wiring), false);
    expect(c).toMatchObject({ cause: 'no-crossing', data: { notProof: 'end-not-read' } });
  });

  it('reads a range the author stated as none in that range', () => {
    expect(noSolutionCause(over(authorRange('x', 0, 1)), true).cause).toBe('none-in-range');
  });

  it('never takes a step or a relation that singles nothing out as proved', () => {
    const step = noSolutionCause(over(wiring, { kind: 'flat' }), true);
    expect(step.cause).toBe('no-crossing');
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
    expect(c.cause).toBe('none-in-range');
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
      cause: 'did-not-settle',
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
      cause: 'did-not-settle',
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
    expect(describe(failed('value', 'z', notEvaluated))).toEqual({
      name: 'cannot be evaluated',
      lines: ['"z" is not defined'],
    });
    expect(
      describe({
        kind: 'value',
        path: ['amp'],
        name: 'w',
        status: 'withheld',
        on: [{ kind: 'search', path: ['amp'], name: 'x' }],
      }),
    ).toEqual({ name: 'withheld', lines: ['depends on amp.x'] });
  });
});
