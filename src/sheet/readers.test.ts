// The readers that take an item's status where they took an error warning or the withheld record,
// each shown in a case where the two readings differ: an equation that reads a name no entry
// declares, a value withheld only on it, and a design that rests on an assumed level. Today's
// fields stay what they were beside the stricter reading.

import { describe as group, it, expect } from 'vitest';
import { evaluateSheet, runSheet, sweepOf, sweepSheet, sweepSheet2 } from './index';
import { resolvedSheet } from './resolve';
import { sheetSensitivities } from './sensitivity';
import { devicePropertySensitivities } from './properties';
import { givesValue, unreadValues } from './items';
import { OPEN_RULINGS, isComplete, marginReadable, verdictOf } from './states';
import { incompleteText, standardProblems } from './describe';
import {
  stands,
  unfinishedBecause,
  withoutRange,
  type CheckResult,
  type SheetDoc,
  type SheetResult,
} from './types';
import { sheet, table, REFS } from './library.fixtures';

const ota = sheet('otas/five-transistor-ota.json');
/** Every requirement made advisory, so that none fails and decides the verdict. */
const soft = (d: SheetDoc): SheetDoc => ({
  ...d,
  checks: d.checks.map((c) => ({ ...c, kind: 'advisory' })),
});
/** The sheet with an equation that reads a name no entry declares, and one that reads it. */
const ghost: SheetDoc = soft({
  ...ota,
  equations: [
    ...ota.equations,
    { name: 'ghost', expr: 'undeclared_name * 2' },
    { name: 'ghost_twice', expr: 'ghost * 2' },
  ],
});
const evaluated = (d: SheetDoc) =>
  evaluateSheet(withoutRange(resolvedSheet(d, REFS).doc), table, undefined);

group('an equation that reads a name no entry declares', () => {
  it('stands today and gives no design to read, and the verdict is undetermined', () => {
    const res = evaluated(ghost);
    expect(stands(res)).toBe(true);
    expect(res.feasible).toBe(true);
    expect(isComplete(res)).toBe(false);
    expect(verdictOf(res.items ?? []).verdict).toBe('undetermined');
    expect(res.items?.find((i) => i.name === 'ghost')).toMatchObject({
      status: 'failed',
      cause: { kind: 'cannot-evaluate', data: { why: 'not-defined', name: 'undeclared_name' } },
    });
    // The same sheet without it gives a design.
    expect(isComplete(evaluated(soft(ota)))).toBe(true);
  });

  it('leaves a value that reads it with no number, though the withheld record holds none', () => {
    const res = evaluated(ghost);
    expect(res.withheld?.ghost_twice).toBeUndefined();
    expect(res.items?.find((i) => i.name === 'ghost_twice')?.status).toBe('withheld');
    expect(givesValue(res, 'ghost_twice')).toBe(false);
    expect(givesValue(res, 'Av')).toBe(true);
  });

  it('gives no point to differentiate around, in both sensitivity views', () => {
    const knobs = sheetSensitivities(ghost, table, undefined, { refs: REFS, params: ['gm_id_in'] });
    expect(knobs.map((k) => k.error)).toEqual([
      'the sheet does not evaluate at its own values, so there is no point to differentiate ' +
        'around — fix the evaluation first',
    ]);
    expect(
      sheetSensitivities(soft(ota), table, undefined, { refs: REFS, params: ['gm_id_in'] })[0]
        .error,
    ).toBeUndefined();
    expect(devicePropertySensitivities(ghost, table, undefined, { refs: REFS }).error).toBe(
      'The sheet does not evaluate at its own values.',
    );
    expect(
      devicePropertySensitivities(soft(ota), table, undefined, { refs: REFS }).error,
    ).toBeUndefined();
  });

  it('is a value no requirement and no output reads, which still makes the verdict undetermined', () => {
    const unread = unreadValues(ghost);
    expect(unread.has('ghost')).toBe(true);
    expect(unread.has('ghost_twice')).toBe(true);
    // Read by a requirement, directly or through another equation.
    expect(unread.has('Av')).toBe(false);
    expect(OPEN_RULINGS.unreadValue).toBe('undetermined');
    expect(verdictOf(evaluated(ghost).items ?? [], unread).verdict).toBe('undetermined');
  });

  it('says why there is no design, from the text module', () => {
    const res = evaluated(ghost);
    expect(unfinishedBecause(res)).toEqual(['the evaluation did not complete']);
    const why = incompleteText(res.items ?? []);
    expect(why).toHaveLength(1);
    for (const f of why) for (const l of f.segments) expect(standardProblems(l)).toEqual([]);
  });
});

group('a design that rests on an assumed level', () => {
  // The output level classed assumed, and no longer held as the level of its wire.
  const { out: _out, ...levels } = (ota as unknown as { levels: Record<string, string> }).levels;
  const assumed = soft({
    ...ota,
    levels,
    params: ota.params.map((p) => (p.name === 'V_out_dc' ? { ...p, class: 'assumed' } : p)),
  } as SheetDoc);

  it('is feasible today and undetermined by its verdict', () => {
    const res = runSheet(withoutRange(assumed), table, undefined, REFS);
    expect(res.feasible).toBe(true);
    expect(res.verdict?.verdict).toBe('undetermined');
    expect(res.items?.find((i) => i.name === 'V_out_dc')).toMatchObject({
      status: 'failed',
      cause: { kind: 'not-determined', data: { why: 'assumed-level', names: ['V_out_dc'] } },
    });
  });

  it('is complete, as it stands today, and its sensitivities are computed', () => {
    const res = evaluated(assumed);
    expect(stands(res)).toBe(true);
    expect(isComplete(res)).toBe(true);
    expect(
      sheetSensitivities(assumed, table, undefined, { refs: REFS, params: ['gm_id_in'] })[0].error,
    ).toBeUndefined();
    expect(devicePropertySensitivities(assumed, table, undefined, { refs: REFS }).error).toBe(
      undefined,
    );
  });

  it('passes nowhere in a sweep, as its verdict is undetermined, where today it passes', () => {
    const s = sweepSheet(assumed, 'gm_id_in', table, 3, undefined, REFS, { windows: true });
    expect(s.feasible).toEqual([true, true, true]);
    expect(s.verdicts).toEqual(['undetermined', 'undetermined', 'undetermined']);
    expect(s.windows).toEqual([]);
    // Its range ends are not calculated, so they chart a gap, as today's no-answer does.
    for (const c of s.checks.filter((x) => x.rangeEnd !== undefined))
      expect(c.marginPct).toEqual([null, null, null]);
  });
});

group('a sweep', () => {
  it('passes where the sample reads feasible, beside today’s flag', () => {
    const s = sweepSheet(ghost, 'gm_id_in', table, 5, undefined, REFS, { windows: true });
    expect(s.feasible).toEqual([true, true, true, true, true]);
    expect(s.verdicts).toEqual(Array(5).fill('undetermined'));
    expect(s.windows).toEqual([]);
    const plain = sweepSheet(soft(ota), 'gm_id_in', table, 5, undefined, REFS, { windows: true });
    expect(plain.verdicts).toEqual(Array(5).fill('feasible'));
    expect(plain.windows).toHaveLength(1);
  });

  it('gives each cell of a map its verdict, beside today’s flag', () => {
    const m = sweepSheet2(ghost, 'gm_id_in', 'gm_id_ld', table, 3, undefined, REFS);
    expect(m.feasible).toEqual(Array(3).fill(Array(3).fill(true)));
    expect(m.verdicts).toEqual(Array(3).fill(Array(3).fill('undetermined')));
  });

  it('leaves a gap where a value’s item is not ok, though the withheld record holds none', () => {
    // A sample whose result holds a number for a value its own item withholds.
    const doc: SheetDoc = {
      title: 't',
      params: [{ name: 'k', value: 1, min: 0, max: 2 }],
      equations: [{ name: 'y', expr: 'k * 2' }],
      checks: [],
    };
    const res = (k: number): SheetResult => ({
      values: { k, y: 2 * k },
      checks: [],
      feasible: true,
      warnings: [],
      items: [
        { kind: 'sheet', path: [], name: '', status: 'ok' },
        {
          kind: 'value',
          path: [],
          name: 'y',
          status: 'withheld',
          on: [{ kind: 'value', path: [], name: 'k', cause: 'cannot-evaluate' }],
        },
      ],
    });
    const s = sweepOf(doc, 'k', 3, undefined, (d) => ({
      res: res(d.params[0].value),
      feasible: true,
      stands: true,
    }));
    expect(s.values.find((c) => c.name === 'y')?.y).toEqual([null, null, null]);
  });
});

group('a range end', () => {
  it('reads its verdict where today’s state complies, and charts no margin where it is undetermined', () => {
    const res = runSheet(ghost, table, undefined, REFS);
    for (const e of res.rangeEnds ?? []) {
      expect(e.state).toBe('complies');
      expect(e.verdict?.verdict).toBe('undetermined');
    }
    const s = sweepSheet(ghost, 'gm_id_in', table, 3, undefined, REFS);
    // An undetermined end charts a gap, and a non-compliant one a negative margin: none charts the
    // room a compliant end would have.
    const ends = s.checks.filter((c) => c.rangeEnd !== undefined);
    expect(ends.flatMap((c) => c.marginPct).filter((m) => m !== null && m >= 0)).toEqual([]);
    expect(ends.flatMap((c) => c.marginPct).filter((m) => m === null).length).toBeGreaterThan(0);
    // Without the equation, the same ends chart a margin.
    const plain = sweepSheet(soft(ota), 'gm_id_in', table, 3, undefined, REFS);
    for (const c of plain.checks.filter((x) => x.rangeEnd !== undefined))
      expect(c.marginPct.every((m) => typeof m === 'number')).toBe(true);
  });

  it('has no verdict where the engine did not calculate it, and names why', () => {
    const res = runSheet(
      {
        ...ota,
        operatingRange: ota.operatingRange?.map((e, k) => (k ? e : { ...e, set: { CM_dc: '((' } })),
      },
      table,
      undefined,
      REFS,
    );
    const [bad, other] = res.rangeEnds ?? [];
    expect(bad.verdict).toBeUndefined();
    expect(bad.items).toEqual([
      expect.objectContaining({
        kind: 'sheet',
        status: 'failed',
        cause: expect.objectContaining({ kind: 'cannot-evaluate' }),
      }),
    ]);
    expect(other.verdict?.verdict).toBeDefined();
    // The sheet's own verdict is not feasible while the finding about the end stands.
    expect(res.verdict?.verdict).not.toBe('feasible');
  });

  it('is not complete where it read no number, for the sensitivity view of a check at that end', () => {
    const res = runSheet(ghost, table, undefined, REFS);
    for (const e of res.rangeEnds ?? []) expect(isComplete(e)).toBe(false);
    for (const e of runSheet(soft(ota), table, undefined, REFS).rangeEnds ?? [])
      expect(isComplete(e)).toBe(true);
  });
});

group('a requirement that cannot be evaluated', () => {
  // A requirement that reads a name no entry declares gives no number, beside one that fails.
  const na: SheetDoc = {
    ...ota,
    checks: [
      ...ota.checks,
      { id: 'reads-nothing', kind: 'spec', lhs: 'undeclared_name', op: '>=', rhs: '0' },
    ],
  };

  it('leaves the run complete, and its sensitivities are computed, as today', () => {
    const res = evaluated(na);
    expect(stands(res)).toBe(true);
    expect(isComplete(res)).toBe(true);
    expect(
      sheetSensitivities(na, table, undefined, { refs: REFS, params: ['gm_id_in'] })[0].error,
    ).toBeUndefined();
    expect(devicePropertySensitivities(na, table, undefined, { refs: REFS }).error).toBe(undefined);
  });

  it('beside one that fails, reads non-compliant: the failing one is charted, it leaves a gap', () => {
    const res = runSheet(na, table, undefined, REFS);
    expect(res.verdict?.verdict).toBe('non-compliant');
    const s = sweepSheet(na, 'gm_id_in', table, 3, undefined, REFS);
    const curve = (id: string) => s.checks.find((c) => c.id === id)?.marginPct;
    expect(curve('reads-nothing')).toEqual([null, null, null]);
    expect(curve('offset-spec')?.every((m) => typeof m === 'number')).toBe(true);
    // Each range end is non-compliant and complete, and charts the margin that fails there. At the
    // last sample offset-spec passes, the requirement that gives no number is all that is left, and
    // the end is undetermined: a gap.
    for (const e of res.rangeEnds ?? []) {
      expect(e.verdict?.verdict).toBe('non-compliant');
      expect(isComplete(e)).toBe(true);
    }
    expect(s.verdicts).toEqual(['non-compliant', 'non-compliant', 'undetermined']);
    for (const c of s.checks.filter((x) => x.rangeEnd !== undefined)) {
      expect(c.marginPct.slice(0, 2).every((m) => typeof m === 'number' && m < 0)).toBe(true);
      expect(c.marginPct[2]).toBeNull();
    }
  });
});

group('a validation error on a requirement’s own entry only', () => {
  const badTolerance: SheetDoc = {
    ...ota,
    checks: ota.checks.map((c) => (c.id === 'gain-spec' ? { ...c, op: '==', tolPct: -1 } : c)),
  };

  it('does not stand today, and is complete, with a verdict that is not feasible', () => {
    const res = runSheet(badTolerance, table, undefined, REFS);
    expect(stands(res)).toBe(false);
    expect(isComplete(res)).toBe(true);
    expect(res.verdict?.verdict).not.toBe('feasible');
  });

  it('is refused by both sensitivity views and passes nowhere in a sweep, as today', () => {
    expect(
      sheetSensitivities(badTolerance, table, undefined, { refs: REFS, params: ['gm_id_in'] })[0]
        .error,
    ).toBeDefined();
    expect(devicePropertySensitivities(badTolerance, table, undefined, { refs: REFS }).error).toBe(
      'The sheet does not validate, so it has no formulas to read.',
    );
    const s = sweepSheet(soft(badTolerance), 'gm_id_in', table, 3, undefined, REFS, {
      windows: true,
    });
    expect(s.feasible).toEqual([false, false, false]);
    expect(s.windows).toEqual([]);
  });
});

group('each sample of a sweep', () => {
  it('says whether its numbers are all there, beside today’s flag', () => {
    const s = sweepSheet(ghost, 'gm_id_in', table, 3, undefined, REFS);
    expect(s.stands).toEqual([true, true, true]);
    expect(s.complete).toEqual([false, false, false]);
    expect(sweepSheet(soft(ota), 'gm_id_in', table, 3, undefined, REFS).complete).toEqual([
      true,
      true,
      true,
    ]);
  });

  // A one-param sheet whose sampler is the test's: the verdict and the items are what it says.
  const doc: SheetDoc = {
    title: 't',
    params: [{ name: 'k', value: 1, min: 0, max: 2 }],
    equations: [],
    checks: [
      { id: 'holds', kind: 'spec', lhs: 'k', op: '>=', rhs: '0' },
      { id: 'stale', kind: 'spec', lhs: 'k', op: '>=', rhs: '9' },
    ],
    operatingRange: [{ name: 'hi', set: { k: '2' } }],
  };
  const check = (id: string, marginPct: number): CheckResult => ({
    id,
    kind: 'spec',
    op: '>=',
    text: `${id} >= 0`,
    lhsValue: 0,
    rhsValue: 0,
    margin: marginPct,
    marginPct,
    rawMargin: marginPct,
    status: marginPct < 0 ? 'fail' : 'pass',
  });

  it('carries a held design’s verdict, passes where it is compliant, and gaps where none is given', () => {
    const verdicts = ['compliant', undefined, 'non-compliant'] as const;
    let i = 0;
    const s = sweepOf(
      doc,
      'k',
      3,
      undefined,
      () => ({
        res: { values: {}, checks: [], feasible: true, warnings: [], items: [] },
        feasible: true,
        stands: true,
        ...(verdicts[i] ? { verdict: verdicts[i] } : {}),
        complete: (i++, true),
      }),
      () => ({ feasible: false, stands: true, verdict: 'non-compliant', complete: true }),
    );
    expect(s.verdicts).toEqual(['compliant', null, 'non-compliant']);
    // The middle sample has no verdict and is read by its flag, as today.
    expect(s.windows?.map((w) => [w.lo, w.hi])).toEqual([[0, expect.any(Number)]]);
  });

  it('charts a range end from the requirements whose own margin may be read', () => {
    const end = {
      name: 'hi',
      state: 'does-not-comply' as const,
      set: {},
      checks: [check('holds', -0.5), check('stale', -0.9)],
      solved: {},
      warnings: [],
      verdict: { verdict: 'non-compliant' as const, failed: [] },
      items: [
        { kind: 'sheet' as const, path: [], name: '', status: 'ok' as const },
        {
          kind: 'requirement' as const,
          path: [],
          name: 'holds',
          status: 'failed' as const,
          cause: {
            kind: 'fails' as const,
            data: {
              text: { lhs: 'k', op: '>=' as const, rhs: '0' },
              lhs: 0,
              rhs: 0,
              margin: -0.5,
              marginPct: -0.5,
              hard: true,
            },
          },
        },
        {
          kind: 'requirement' as const,
          path: [],
          name: 'stale',
          status: 'withheld' as const,
          on: [{ kind: 'sheet' as const, path: [], name: '', cause: 'not-read' as const }],
        },
      ],
    };
    expect(marginReadable(end.items[1])).toBe(true);
    expect(marginReadable(end.items[2])).toBe(false);
    const s = sweepOf(doc, 'k', 2, undefined, () => ({
      res: { values: {}, checks: [], feasible: true, warnings: [], items: [], rangeEnds: [end] },
      feasible: true,
      stands: true,
    }));
    expect(s.checks.find((c) => c.rangeEnd === 'hi')?.marginPct).toEqual([-0.5, -0.5]);
  });
});
