// The readers that take an item's status where they took an error warning or the withheld record,
// each shown in a case where the two readings differ: an equation that reads a name no entry
// declares, a value withheld only on it, and a design that rests on an assumed level. Today's
// fields stay what they were beside the stricter reading.

import { describe as group, it, expect } from 'vitest';
import { evaluateSheet, runSheet } from './index';
import { resolvedSheet } from './resolve';
import { sheetSensitivities } from './sensitivity';
import { devicePropertySensitivities } from './properties';
import { givesValue } from './items';
import { givesDesign, verdictOf } from './states';
import { noDesignText, standardProblems } from './describe';
import { stands, unfinishedBecause, withoutRange, type SheetDoc } from './types';
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
    expect(givesDesign(res)).toBe(false);
    expect(verdictOf(res.items ?? []).verdict).toBe('undetermined');
    expect(res.items?.find((i) => i.name === 'ghost')).toMatchObject({
      status: 'failed',
      cause: { kind: 'cannot-evaluate', data: { why: 'not-defined', name: 'undeclared_name' } },
    });
    // The same sheet without it gives a design.
    expect(givesDesign(evaluated(soft(ota)))).toBe(true);
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

  it('says why there is no design, from the text module', () => {
    const res = evaluated(ghost);
    expect(unfinishedBecause(res)).toEqual(['the evaluation did not complete']);
    const why = noDesignText(res.items ?? []);
    expect(why).toHaveLength(1);
    for (const l of why) expect(standardProblems(l)).toEqual([]);
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

  it('stands today and gives no design to read', () => {
    const res = evaluated(assumed);
    expect(stands(res)).toBe(true);
    expect(givesDesign(res)).toBe(false);
  });
});
