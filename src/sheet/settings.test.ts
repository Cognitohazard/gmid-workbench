// The engine's tolerances and caps as one value handed to every evaluation: held to their limits,
// defaulted where absent, and — at their defaults — the numbers every golden is pinned at.

import { describe, expect, it } from 'vitest';
import { loadLibrary, REFS, sheet, table } from './library.fixtures';
import {
  changedSettings,
  DEFAULT_SETTINGS,
  runSheet,
  SETTING_KEYS,
  SETTINGS_LIMITS,
  settingsFrom,
  sheetSensitivities,
  sweepable,
  sweepSheet,
  withParams,
  type Settings,
} from './index';

const with_ = (over: Partial<Settings>): { settings: Settings } => ({
  settings: { ...DEFAULT_SETTINGS, ...over },
});

describe('settings values', () => {
  it('are the defaults wherever nothing usable is given', () => {
    expect(settingsFrom(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom('six')).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ solveSweeps: 'many', nearMiss: NaN })).toEqual(DEFAULT_SETTINGS);
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(changedSettings(DEFAULT_SETTINGS)).toEqual([]);
  });

  it('are held to their limits, with every count a whole number', () => {
    const s = settingsFrom({ solveSweeps: 2.6, solveEvaluations: 1, solveTolRel: -1, nearMiss: 9 });
    expect(s.solveSweeps).toBe(3);
    expect(s.solveEvaluations).toBe(SETTINGS_LIMITS.solveEvaluations.min);
    expect(s.solveTolRel).toBe(SETTINGS_LIMITS.solveTolRel.min);
    expect(s.nearMiss).toBe(SETTINGS_LIMITS.nearMiss.max);
    expect(changedSettings(s)).toEqual([
      'solveTolRel',
      'solveSweeps',
      'solveEvaluations',
      'nearMiss',
    ]);
    // Every default sits inside its own limits, so holding the defaults changes nothing.
    for (const k of SETTING_KEYS) {
      const { min, max } = SETTINGS_LIMITS[k];
      expect(DEFAULT_SETTINGS[k], k).toBeGreaterThanOrEqual(min);
      expect(DEFAULT_SETTINGS[k], k).toBeLessThanOrEqual(max);
    }
  });
});

describe('evaluating under settings', () => {
  it('gives every library sheet the same answer at the defaults, given or not', () => {
    // The goldens run with no settings at all; this holds the explicit defaults to them.
    for (const { file, doc } of loadLibrary())
      expect(runSheet(doc, table, undefined, REFS, { settings: DEFAULT_SETTINGS }), file).toEqual(
        runSheet(doc, table, undefined, REFS),
      );
  });

  it('reports the folded cascode’s dependent set as not settled when it gets one sweep', () => {
    const doc = sheet('otas/folded-cascode-ota.json');
    expect(runSheet(doc, table, undefined, REFS).solve).toEqual({ kind: 'settled' });
    const one = runSheet(doc, table, undefined, REFS, with_({ solveSweeps: 1 }));
    expect(one.solve).toMatchObject({ kind: 'not-settled', why: 'sweeps' });
    expect(one.feasible).toBe(false);
    expect(one.warnings.map((w) => w.message).join('\n')).toMatch(/did not settle in 1 sweep:/);
    // A range end of a design that did not stand is never asked.
    expect(one.rangeEnds?.map((e) => e.state)).toEqual(['not-run', 'not-run']);
  });

  it('stops a solve at the evaluation budget it is given, and says how large it was', () => {
    const res = runSheet(sheet('otas/folded-cascode-ota.json'), table, undefined, REFS, {
      settings: { ...DEFAULT_SETTINGS, solveEvaluations: 100 },
    });
    expect(res.solve).toMatchObject({ kind: 'not-settled', why: 'budget' });
    expect(res.warnings.map((w) => w.message).join('\n')).toMatch(
      /shared evaluation budget \(100 evaluations\) ran out/,
    );
  });

  it('lands a solved param within the looser tolerance it is given, not on the same value', () => {
    const doc = sheet('otas/folded-cascode-ota.json');
    const tight = runSheet(doc, table, undefined, REFS);
    const loose = runSheet(doc, table, undefined, REFS, with_({ solveTolRel: 1e-3 }));
    const v = doc.params.find((p) => p.name === 'V_tail')!;
    const span = (v.max as number) - (v.min as number);
    expect(loose.values.V_tail).not.toBe(tight.values.V_tail);
    // Both land within their tolerance of the root, so they agree to the looser one (with the
    // relation's slope, a few times it).
    expect(Math.abs(loose.values.V_tail - tight.values.V_tail)).toBeLessThan(10 * 1e-3 * span);
  });

  it('marks a pass amber under a wider near-miss margin', () => {
    const doc = sheet('otas/five-transistor-ota.json');
    const status = (r: ReturnType<typeof runSheet>): string | undefined =>
      r.checks.find((c) => c.id === 'gain-spec')?.status;
    const at = runSheet(doc, table, undefined, REFS);
    expect(status(at)).toBe('pass');
    const margin = at.checks.find((c) => c.id === 'gain-spec')!.marginPct;
    expect(status(runSheet(doc, table, undefined, REFS, with_({ nearMiss: margin * 1.01 })))).toBe(
      'amber',
    );
    expect(status(runSheet(doc, table, undefined, REFS, with_({ nearMiss: margin * 0.99 })))).toBe(
      'pass',
    );
  });

  it('reads the wiring check’s two tolerances from the settings', () => {
    // The CMOS inverter at gm/ID 12 reads its PMOS off the table's edge, and the loop through the
    // two gates misses by some 33 mV: past the 10 mV default, inside a 50 mV tolerance.
    const doc = withParams(sheet('stages/cmos-inverter-amp.json'), { gm_id_n: 12 });
    const strict = runSheet(doc, table);
    expect(strict.nodes!.disputes).toHaveLength(1);
    const lax = runSheet(doc, table, undefined, undefined, with_({ closureTol: 0.05 }));
    expect(lax.nodes!.disputes).toEqual([]);
    expect(lax.warnings.some((w) => w.message.startsWith('the wiring does not close'))).toBe(false);
    // A current-balance tolerance of zero raises the rounding residual the 0.1 % default leaves
    // in the data unraised.
    const five = sheet('otas/five-transistor-ota.json');
    const balance = (s?: Partial<Settings>): number =>
      runSheet(five, table, undefined, REFS, s ? with_(s) : {}).warnings.filter((w) =>
        /do not balance/.test(w.message),
      ).length;
    expect(balance()).toBe(0);
    expect(balance({ kclTolRel: 0 })).toBe(1);
  });

  it('reaches the sweeps and the sensitivity readout too', () => {
    const doc = sheet('otas/folded-cascode-ota.json');
    const knob = doc.params.find((p) => sweepable(p))!.name;
    expect(sweepSheet(doc, knob, table, 2, undefined, REFS).stands).toEqual([true, true]);
    const swept = sweepSheet(doc, knob, table, 2, undefined, REFS, with_({ solveSweeps: 1 }));
    expect(swept.stands).toEqual([false, false]);
    const rows = sheetSensitivities(doc, table, undefined, {
      refs: REFS,
      settings: { ...DEFAULT_SETTINGS, solveSweeps: 1 },
    });
    expect(rows.every((r) => r.error?.includes('does not evaluate at its own values'))).toBe(true);
  });
});
