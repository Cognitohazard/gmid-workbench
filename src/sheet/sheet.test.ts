// Golden suite for the leaf design-sheet evaluator. Anchors the two load-bearing
// promises: the sizing is sizeDevice verbatim (no re-inversion), and bad author input
// degrades to warnings / 'na' chips instead of throwing.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  generateDemoDevice,
  scaleQuantities,
  signedMirrorDemo,
  withoutColumns,
  VA_PER_L,
} from '../demo';
import { PHYS } from '../constants';
import { importMostab } from '../import';
import { sizeDevice, integratedNoise, mismatch } from '../device';
import { fixTable } from '../series';
import { diodeGrid, makeGrid } from '../grid';
import { lookup } from '../lookup';
import { derivedFallbacks, fallbackMessage } from '../derive';
import {
  evaluateSheet,
  heldOutcome,
  runSheet,
  validateSheet,
  sweepSheet,
  sweepSheet2,
  sweepable,
  bindingCheck,
  limitingCheck,
  rangeEndCheck,
  sheetSensitivities,
  withParams,
  isHardCheck,
  SOLVE_EVALUATIONS,
  SOLVE_SWEEPS,
  SOLVE_TOL_REL,
  noiseSourcesIn,
} from './index';
import { EXAMPLES } from './examples';
import { ueffAt, demoCsvWith, importOne, withUeff } from '../import/passthrough.fixtures';
import type { DeviceTable } from '../types';
import type { SheetDoc, SheetResult, SheetVar } from './types';
import { notACircuit, REFS } from './library.fixtures';

// The demo device characterized over drain voltage. Every sized device states its drain voltage,
// so every document here that sizes one does — 0.6 V, unless the test is about another — and
// runs on a table that sweeps it.
const dev = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });

/** That table sliced at the stated drain voltage: what `sizeDevice`, which takes a table already
 *  reduced to [l × vgs], is handed where a sheet's answer is compared with it. */
const devAt = fixTable(dev, { vds: 0.6 });

/** What `sizeDevice` makes of boundDoc's givens on a table it can read as it stands. */
const sizeBound = (table: DeviceTable): ReturnType<typeof sizeDevice> =>
  sizeDevice({ table, L: 0.5e-6, gm: 2 * Math.PI * 10e6 * 2e-12, gm_id: 12 });

// The same device characterized over body bias as well, on a finer grid. A device is sized only
// on a table that carries what its givens use, so a sheet that puts a source above its body
// runs on this one: the cascode stands its upper device on the node between the two. The
// 0.05 V steps put every bias the shipped examples ask for on a grid node.
const devBias = generateDemoDevice({
  vds: { min: 0, max: 1.2, step: 0.05 },
  vsb: { min: 0, max: 0.9, step: 0.05 },
});

/** gm/gds on the 0.5 µm slice at a chosen vgs — used to pick a sizing target off-node. */
const lookupAt = (vgs: number): number => lookup(devAt, { l: 0.5e-6, vgs }).gm_gds;

/** A minimal sheet with givens at a known in-range operating point (gm/ID = 12, L = 0.5 µm,
 *  vds = 0.6 V), declared not a circuit. */
function boundDoc(overrides: Partial<SheetDoc> = {}): SheetDoc {
  return notACircuit({
    title: 't',
    polarity: 'n',
    params: [
      { name: 'GBW_target', value: 10e6 },
      { name: 'CL', value: 2e-12 },
      { name: 'L', value: 0.5e-6 },
      { name: 'gm_id', value: 12 },
      { name: 'vstar_floor', value: 0.15 },
    ],
    givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
    equations: [],
    checks: [],
    ...overrides,
  });
}

/** boundDoc sizing its device with exactly the bias `bias` states — none at all when it is
 *  empty, which leaves the drain voltage out. */
const given = (bias: Record<string, unknown>, overrides: Partial<SheetDoc> = {}): SheetDoc =>
  boundDoc({ givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', ...bias }, ...overrides });

describe('evaluateSheet — spec-first givens', () => {
  it('sizes from a given fT through a sheet, matching sizeDevice exactly', () => {
    // The claim that a sheet can state a speed spec directly, not just gm/ID.
    const ft = 2e9;
    const ref = sizeDevice({ table: devAt, L: 0.5e-6, ft, id: 20e-6 });
    const doc = boundDoc({
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'ft_target', value: ft },
        { name: 'Ib', value: 20e-6 },
      ],
      givens: { L: 'L', ft: 'ft_target', id: 'Ib', vds: '0.6' },
      equations: [{ name: 'speed', expr: 'ft' }],
    });
    const res = evaluateSheet(doc, dev);

    expect(res.sizing?.ok).toBe(true);
    expect(res.sizing?.W).toBeCloseTo(ref.W, 12);
    expect(res.sizing?.vgs).toBeCloseTo(ref.vgs, 12);
    // The sized device meets the spec the sheet asked for.
    expect(res.values.speed / ft).toBeCloseTo(1, 9);
  });

  it('refuses two operating-point quantities in a sheet, in validate AND in eval', () => {
    // bindProblem is the single home of the rule; both sheet paths must report it, in the
    // same words, or an author gets contradictory advice from the two.
    const doc = boundDoc({
      params: [{ name: 'L', value: 0.5e-6 }],
      givens: { L: 'L', ft: '2e9', gm_id: '12', vds: '0.6' },
    });

    const problems = validateSheet(doc);
    const invalid = problems.find((p) => p.rule === 'sheet-givens');
    expect(invalid?.message).toMatch(/both set the operating point/);
    // Named: exactly the two supplied, not the whole selector list.
    expect(invalid?.message).toContain('gm_id and ft');
    expect(invalid?.message).not.toContain('vstar');
    // The remedy points at the size quantities, never at another selector.
    expect(invalid?.message).toContain('{gm, id, W}');

    const res = evaluateSheet(doc, dev);
    expect(res.sizing?.ok).toBe(false);
    expect(res.sizing?.error).toBe(invalid?.message);
    expect(res.feasible).toBe(false);
  });

  it('a check restating a given spec reads as set by its own givens, not as a failure against them', () => {
    // A selector is recovered by inverting a node-sampled curve while the point re-derives it
    // from interpolated bases; between nodes those differ by ~0.1%, enough to drive a
    // spec check on the very quantity the givens set to a hard fail. Giving a gain and
    // then requiring that gain is the most natural thing an author writes, so it must not.
    const vgs = dev.grid.axes.find((a) => a.name === 'vgs') as { values: Float64Array };
    const midway = (vgs.values[40] + vgs.values[41]) / 2; // deliberately between nodes
    const target = lookupAt(midway);
    const doc = boundDoc({
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'Av', value: target },
        { name: 'Ib', value: 2e-5 },
      ],
      givens: { L: 'L', gm_gds: 'Av', id: 'Ib', vds: '0.6' },
      checks: [{ id: 'gain', kind: 'spec', lhs: 'gm_gds', op: '>=', rhs: 'Av' }],
    });
    const res = evaluateSheet(doc, dev);

    expect(res.checks[0].status).toBe('amber'); // set by its own givens, not failed
    expect(res.feasible).toBe(true);
  });

  it('names the missing column when a sheet gives a quantity the table cannot compute', () => {
    const noCgg = withoutColumns(dev, ['cgg']);
    const doc = boundDoc({
      params: [{ name: 'L', value: 0.5e-6 }],
      givens: { L: 'L', ft: '2e9', id: '20e-6', vds: '0.6' },
    });
    const res = evaluateSheet(doc, noCgg);

    expect(res.sizing?.ok).toBe(false);
    expect(res.sizing?.error).toMatch(/carries no "cgg" column/);
    expect(res.feasible).toBe(false);
  });
});

describe('evaluateSheet — sizing reuse', () => {
  it('reproduces sizeDevice W and vgs for the same givens (no re-inversion)', () => {
    const gm = 2 * Math.PI * 10e6 * 2e-12;
    const ref = sizeDevice({ table: devAt, L: 0.5e-6, gm, gm_id: 12 });
    const res = evaluateSheet(boundDoc(), dev);
    expect(res.sizing?.ok).toBe(true);
    expect(res.sizing?.W).toBeCloseTo(ref.W, 12);
    expect(res.sizing?.vgs).toBeCloseTo(ref.vgs, 9);
    expect(res.values.W).toBeCloseTo(ref.W, 12);
    // the operating-point bag is surfaced as flat scalars, matching sizeDevice exactly
    expect(res.values.vstar).toBeCloseTo(ref.quantities.vstar, 12);
    expect(res.values.ceiling).toBeCloseTo(ref.ceiling, 12);
  });
});

describe('evaluateSheet — checks', () => {
  it('flips a physical check pass<->fail across its boundary', () => {
    const check = {
      id: 'headroom',
      kind: 'physical' as const,
      lhs: 'vstar',
      op: '>=' as const,
      rhs: 'vstar_floor',
    };
    // vstar = 2/12 ≈ 0.1667
    const passDoc = boundDoc({ params: [...boundDoc().params], checks: [check] });
    passDoc.params.find((p) => p.name === 'vstar_floor')!.value = 0.15;
    expect(evaluateSheet(passDoc, dev).checks[0].status).toBe('pass');

    const failDoc = boundDoc({ checks: [check] });
    failDoc.params.find((p) => p.name === 'vstar_floor')!.value = 0.2;
    const failed = evaluateSheet(failDoc, dev).checks[0];
    expect(failed.status).toBe('fail');
    expect(failed.margin).toBeLessThan(0);
  });

  it('reports the correct signed margin for >=, <= and ==', () => {
    const doc = boundDoc({
      params: [
        { name: 'a', value: 10 },
        { name: 'b', value: 8 },
      ],
      givens: undefined,
      checks: [
        { id: 'ge', kind: 'advisory', lhs: 'a', op: '>=', rhs: 'b' }, // 10>=8  margin +2
        { id: 'le', kind: 'advisory', lhs: 'a', op: '<=', rhs: 'b' }, // 10<=8  margin -2
        { id: 'eq', kind: 'advisory', lhs: 'a', op: '==', rhs: 'b', tolPct: 10 }, // |2|>0.8 -> fail
      ],
    });
    const [ge, le, eq] = evaluateSheet(doc, dev).checks;
    expect(ge.status).toBe('pass');
    expect(ge.margin).toBeCloseTo(2, 9);
    expect(le.status).toBe('fail');
    expect(le.margin).toBeCloseTo(-2, 9);
    expect(eq.status).toBe('fail');
  });

  it('gives a passing == check a non-negative margin so the zero line is the real boundary', () => {
    // The feasibility chart and the margin column read margin >= 0 as passing; an '==' check that
    // holds within tolPct must sit at/above zero, not below it (it once always did, being |Δ|).
    const within = boundDoc({
      params: [
        { name: 'a', value: 10.3 },
        { name: 'b', value: 10 },
      ],
      givens: undefined,
      checks: [{ id: 'eq', kind: 'spec', lhs: 'a', op: '==', rhs: 'b', tolPct: 5 }], // |Δ|=0.3 ≤ 0.5
    });
    const pass = evaluateSheet(within, dev).checks[0];
    expect(pass.status).toBe('pass');
    expect(pass.marginPct).toBeGreaterThanOrEqual(0);

    const outside = boundDoc({
      params: [
        { name: 'a', value: 11 },
        { name: 'b', value: 10 },
      ],
      givens: undefined,
      checks: [{ id: 'eq', kind: 'spec', lhs: 'a', op: '==', rhs: 'b', tolPct: 5 }], // |Δ|=1 > 0.5
    });
    const fail = evaluateSheet(outside, dev).checks[0];
    expect(fail.status).toBe('fail');
    expect(fail.marginPct).toBeLessThan(0);
  });

  it('marks a non-finite check side as na, never a false pass', () => {
    const doc = boundDoc({
      params: [
        { name: 'z', value: 0 },
        { name: 'lim', value: 1 },
      ],
      givens: undefined,
      checks: [{ id: 'div0', kind: 'advisory', lhs: '1/z', op: '<=', rhs: 'lim' }], // 1/0 = Inf
    });
    expect(evaluateSheet(doc, dev).checks[0].status).toBe('na');
  });
});

describe('evaluateSheet — an assumed bias coordinate is reported, not invented', () => {
  // A table that actually sweeps body bias, so leaving vsb undeclared is a real choice.
  const bodySwept = generateDemoDevice({
    vds: { min: 0, max: 1.2, step: 0.3 },
    vsb: { min: 0, max: 0.6, step: 0.2 },
  });

  it('marks a bias axis the givens left undeclared', () => {
    // vsb = 0 is right for a device whose source sits at its bulk and wrong for a differential
    // pair, cascode or source follower. The engine cannot tell which — a sheet describes no
    // nodes — so the coordinate it filled in must be distinguishable from one the author wrote.
    const res = evaluateSheet(boundDoc(), bodySwept);
    expect(res.sizing?.ok).toBe(true);
    expect(res.sizing?.bias?.vsb).toBe(0);
    expect(res.sizing?.assumed).toContain('vsb');
  });

  it('does not mark a bias axis the givens declare', () => {
    const doc = boundDoc();
    const res = evaluateSheet({ ...doc, givens: { ...doc.givens!, vsb: '0.2' } }, bodySwept);
    expect(res.sizing?.bias?.vsb).toBeCloseTo(0.2, 12);
    expect(res.sizing?.assumed ?? []).not.toContain('vsb');
  });

  it('sizes a body-biased device differently — which is why the assumption has to be visible', () => {
    const doc = boundDoc();
    const at = (vsb: string): number =>
      evaluateSheet({ ...doc, givens: { ...doc.givens!, vsb } }, bodySwept).sizing?.vgs ?? NaN;
    // Same gm/ID, same L: body bias moves the gate drive it takes to get there.
    expect(Math.abs(at('0.6') - at('0'))).toBeGreaterThan(1e-3);
  });
});

describe('evaluateSheet — closing a bias loop (solveFor)', () => {
  // A loop shaped like a real one: a param standing in for a value only the evaluated sheet
  // knows, perturbing the operating point WEAKLY. Here the loop runs through an equation rather
  // than a bias declaration — `gm/ID` is nudged by the param, and the param solves for the vstar
  // that results. The engine finds it by a one-unknown search of vstar_est - vstar_actual
  // between min and max.
  function loopDoc(overrides: Partial<SheetDoc> = {}): SheetDoc {
    return notACircuit({
      title: 'loop',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'id', value: 10e-6 },
        { name: 'vstar_est', value: 0.3, min: 0.05, max: 0.6, solveFor: 'vstar_actual' },
      ],
      givens: { L: 'L', id: 'id', gm_id: '8 + 5*vstar_est', vds: '0.6' },
      equations: [{ name: 'vstar_actual', expr: 'vstar' }],
      checks: [],
      ...overrides,
    });
  }
  /** loopDoc with its solved param replaced. */
  const solving = (p: SheetVar, over: Partial<SheetDoc> = {}): SheetDoc =>
    loopDoc({
      params: [{ name: 'L', value: 0.5e-6 }, { name: 'id', value: 10e-6 }, p],
      ...over,
    });
  const solveErrors = (res: SheetResult): string[] =>
    res.warnings.filter((w) => w.rule === 'sheet-solve').map((w) => w.message);

  it('solves the param until it agrees with what it names', () => {
    const res = evaluateSheet(loopDoc(), dev);
    expect(res.feasible).toBe(true);
    // The landed value equals the value it solves for — that IS the contract — to the search's
    // own tolerance: SOLVE_TOL_REL of the 0.55 V range, stretched by the relation's slope of about 1.
    expect(Math.abs(res.values.vstar_est - res.values.vstar_actual)).toBeLessThanOrEqual(
      2 * SOLVE_TOL_REL * 0.55,
    );
    // ...and the answer is not the stored value, or the test would pass without any solving.
    expect(Math.abs(res.values.vstar_est - 0.3)).toBeGreaterThan(1e-2);
    expect(res.warnings.filter((w) => w.severity === 'error')).toHaveLength(0);
  });

  it('lands on the same point the sized device reports', () => {
    const res = evaluateSheet(loopDoc(), dev);
    // Independently re-size at the landed value: the engine's answer must be the true root of
    // the relation, not merely a value the search stopped at.
    const point = sizeDevice({
      table: devAt,
      L: 0.5e-6,
      id: 10e-6,
      gm_id: 8 + 5 * res.values.vstar_est,
    });
    expect(point.quantities.vstar).toBeCloseTo(res.values.vstar_est, 6);
  });

  it('does not depend on the stored value at all, inside or outside the range', () => {
    // The search starts from the stated range alone, so the stored value reaches no evaluation:
    // the answer is the same number to the last bit.
    const from = (v: number): number =>
      evaluateSheet(
        solving({ name: 'vstar_est', value: v, min: 0.05, max: 0.6, solveFor: 'vstar_actual' }),
        dev,
      ).values.vstar_est;
    const answer = from(0.3);
    for (const v of [0.06, 0.15, 0.45, 0.59, 5, -1]) expect(from(v)).toBe(answer);
  });

  it('fails closed when the param names something that never resolves, as not shown', () => {
    // Three failed points — both ends and the middle — show nothing about the rest of the range,
    // so this is reported as a solve that did not settle, never as "no solution".
    const res = evaluateSheet(
      solving({ name: 'vstar_est', value: 0.2, min: 0.05, max: 0.6, solveFor: 'no_such_value' }),
      dev,
    );
    expect(res.feasible).toBe(false);
    expect(solveErrors(res)).toEqual([
      expect.stringMatching(
        /^solved param "vstar_est" in \[0\.05, 0\.6\] did not settle: nothing of the range could be evaluated: vstar_est - \(no_such_value\) does not evaluate at either end of it or at its middle/,
      ),
    ]);
  });

  it('says a relation that does not cross its target in the range found no solution there, and no more', () => {
    // run = 0.5*run + 20 has its root at 40, outside [-10, 10]. What the search saw is a relation
    // with one sign across the range, which is none, or an even number, of roots — said as such.
    const res = evaluateSheet(
      solving(
        { name: 'run', value: 1, min: -10, max: 10, unit: 'V', solveFor: 'onward' },
        { givens: undefined, equations: [{ name: 'onward', expr: '0.5*run + 20' }] },
      ),
      dev,
    );
    expect(res.feasible).toBe(false);
    expect(solveErrors(res)).toEqual([
      'solved param "run" found no solution in [-10, 10] V: run - (onward) does not change sign ' +
        'across it (-2.500e+1 at -10, -1.500e+1 at 10) — none, or an even number, of roots ' +
        'there. Move or widen min/max to bracket one, or the relation does not reach its target ' +
        'on this table',
    ]);
  });

  it('carries the outcome as data beside its message: settled, no solution, not settled', () => {
    expect(evaluateSheet(loopDoc(), dev).solve).toEqual({ kind: 'settled' });
    // The relation keeps one sign over the whole range: no solution in the stretch searched.
    const none = evaluateSheet(
      solving(
        { name: 'run', value: 1, min: -10, max: 10, unit: 'V', solveFor: 'onward' },
        { givens: undefined, equations: [{ name: 'onward', expr: '0.5*run + 20' }] },
      ),
      dev,
    );
    // The param is no wire's level (the sheet names no wiring), so its range is its author's and
    // the failure is no finding about the design.
    expect(none.solve).toEqual({
      kind: 'no-solution',
      unknown: 'run',
      range: [-10, 10],
      message: solveErrors(none)[0],
      from: 'author',
      because: 'no-crossing',
    });
    expect(none.point).toEqual({ sized: false, state: 'no-answer', error: solveErrors(none)[0] });
    // Nothing of the range evaluates: not settled, which is not the same answer.
    const blind = evaluateSheet(
      solving({ name: 'vstar_est', value: 0.2, min: 0.05, max: 0.6, solveFor: 'no_such_value' }),
      dev,
    );
    expect(blind.solve).toEqual({
      kind: 'not-settled',
      unknowns: ['vstar_est'],
      why: 'unevaluable',
      message: solveErrors(blind)[0],
    });
    // A sheet with nothing to solve has no outcome to report.
    expect(evaluateSheet(loopDoc({ params: loopDoc().params.slice(0, 2) }), dev).solve).toBe(
      undefined,
    );
  });

  it('refuses a relation that does not depend on its param, however it got that way', () => {
    // `run = run + 1` reads -1 at every run; `x` solving for an equation that is x itself reads 0
    // at every x. Neither singles its param out, and the first value tried is not an answer: the
    // same number at both ends and the middle says so.
    for (const [eq, reads] of [
      ['run + 1', '-1.000e+0'],
      ['run', '0.000e+0'],
    ] as const) {
      const res = evaluateSheet(
        solving(
          { name: 'run', value: 1, min: -10, max: 10, unit: 'V', solveFor: 'onward' },
          { givens: undefined, equations: [{ name: 'onward', expr: eq }] },
        ),
        dev,
      );
      expect(res.feasible).toBe(false);
      expect(solveErrors(res)).toEqual([
        `solved param "run" is not determined by its relation: run - (onward) reads ${reads} at ` +
          'both ends of [-10, 10] V and at its middle — it does not appear to depend on run, so no value ' +
          'of it is singled out',
      ]);
    }
  });

  it('finds the root of a loop that substitution overshoots, since a search never steps through the map', () => {
    // `flip = -2*osc + 3` has its root at 1, and a substitution step lands twice as far past it
    // on the other side every time. The relation osc - flip = 3*osc - 3 is simply searched.
    const res = evaluateSheet(
      solving(
        { name: 'osc', value: 5, min: -10, max: 10, solveFor: 'flip' },
        { givens: undefined, equations: [{ name: 'flip', expr: '-2*osc + 3' }] },
      ),
      dev,
    );
    expect(solveErrors(res)).toEqual([]);
    expect(res.values.osc).toBeCloseTo(1, 6);
  });

  it('finds a root at zero: the tolerance is relative to the range, not to the value', () => {
    // `flip = -flip` has its only root at 0, where a value-relative test never closes.
    const res = evaluateSheet(
      solving(
        { name: 'flip', value: 1, min: -1, max: 3, solveFor: 'negated' },
        { givens: undefined, equations: [{ name: 'negated', expr: '-flip' }] },
      ),
      dev,
    );
    expect(solveErrors(res)).toEqual([]);
    expect(Math.abs(res.values.flip)).toBeLessThanOrEqual(SOLVE_TOL_REL * 4);
  });

  it('finds a capacitance-scale root, not just a volt-scale one', () => {
    // The core is SI throughout, so a solved param is as likely to be ~1e-15 F as ~1 V. The
    // tolerance scales with the stated range, so it is as tight at either end. The root of
    // c = 2e-15 - 0.5*c is 4/3 fF.
    const doc: SheetDoc = {
      title: 'tiny',
      polarity: 'n',
      params: [{ name: 'c_est', value: 0.5e-15, min: 0, max: 1e-14, solveFor: 'c_actual' }],
      equations: [{ name: 'c_actual', expr: '2e-15 - 0.5*c_est' }],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(Math.abs(res.values.c_est - (4 / 3) * 1e-15)).toBeLessThanOrEqual(SOLVE_TOL_REL * 1e-14);
  });

  it('finds the root of a loop substitution would need hundreds of passes for, quietly', () => {
    // x = k*x + 1 - k contracts at |f'| = k: 0.999 is about 16000 passes of substitution to 1e-7.
    // To a search the relation (1 - k)(x - 1) is a straight line through 1, whatever k is, and a
    // solve that lands says nothing more.
    for (const k of [0.6, 0.95, 0.999]) {
      const res = evaluateSheet(geometric(k), dev);
      expect(res.feasible).toBe(true);
      expect(res.values.x).toBeCloseTo(1, 6);
      expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    }
  });

  it('refuses a param that solves for itself', () => {
    const w = validateSheet(
      loopDoc({
        params: [{ name: 'x', value: 1, min: 0, max: 2, solveFor: 'x' }],
        givens: undefined,
        equations: [],
      }),
    );
    expect(w.some((v) => v.rule === 'sheet-param' && /solves for itself/.test(v.message))).toBe(
      true,
    );
  });

  it('refuses a param that solves for something with no range to search in', () => {
    // Without min and max there is nothing to search; the stored value would become a guess the
    // answer depends on, which is exactly what a solve must never have.
    for (const range of [{}, { min: 0.05 }, { min: 0.6, max: 0.05 }, { min: 0.3, max: 0.3 }]) {
      const doc = solving({ name: 'vstar_est', value: 0.3, ...range, solveFor: 'vstar_actual' });
      const message =
        'solved param "vstar_est" needs finite min < max — they are the range it is searched in, ' +
        'not slider bounds';
      expect(
        validateSheet(doc)
          .filter((w) => w.severity === 'error')
          .map((w) => w.message),
      ).toEqual([message]);
      const res = evaluateSheet(doc, dev);
      expect(res.feasible).toBe(false);
      expect(solveErrors(res)).toEqual([message]);
    }
  });

  it('solves a loop inside a composed child', () => {
    // evalBlocks recurses through evaluateNode, so a child's own solved param must be found
    // without the parent knowing anything about it.
    const parent: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'c', doc: { ...loopDoc(), provides: ['vstar_actual'] } }],
    };
    const res = evaluateSheet(parent, dev);
    const child = res.blocks?.[0];
    expect(child?.feasible).toBe(true);
    expect(res.values.c__vstar_actual).toBeCloseTo(
      evaluateSheet(loopDoc(), dev).values.vstar_est,
      6,
    );
  });

  it('bounds nested solves with one evaluation budget for the whole tree', () => {
    // A parent's every probe re-solves its child, so nested solves multiply: a search of a
    // cubic costs about eight probes, and eight levels of them would cost 8^8. With a shared
    // budget the nest fails closed, quickly, and says the budget ran out rather than that any
    // level has no solution.
    const leaf = (): SheetDoc => ({
      title: 'leaf',
      polarity: 'n',
      params: [{ name: 'x', value: 1, min: 0, max: 2, solveFor: 'y' }],
      equations: [{ name: 'y', expr: '0.1*x^3 + 1' }],
      checks: [],
      provides: ['y'],
    });
    let doc = leaf();
    for (let i = 0; i < 7; i++) doc = { ...leaf(), blocks: [{ name: `c${i}`, doc }] };
    const t0 = performance.now();
    const res = evaluateSheet(doc, dev);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(res.feasible).toBe(false);
    const messages = solveErrors(res);
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) {
      expect(m).toMatch(
        new RegExp(`shared evaluation budget \\(${SOLVE_EVALUATIONS} evaluations\\) ran out`),
      );
      expect(m).toMatch(/It was not shown to be unsolvable/);
    }
  });

  it('does not let sibling solves starve each other', () => {
    // Feasibility must not depend on document order: eight siblings that each solve alone all
    // solve together.
    const res = evaluateSheet(
      {
        title: 'eight',
        polarity: 'n',
        params: [],
        equations: [],
        checks: [],
        blocks: Array.from({ length: 8 }, (_, i) => ({ name: `c${i}`, doc: geometric(0.9) })),
      },
      dev,
    );
    expect(res.blocks?.every((c) => c.feasible)).toBe(true);
    expect(res.feasible).toBe(true);
  });

  it('warns when a parent overrides a param the child solves for', () => {
    // The child searches its own range whatever is wired in, so the override does nothing.
    // Silently dropping an explicit wiring is the surprise the unmatched-key error guards against.
    const res = evaluateSheet(
      {
        title: 'wired',
        polarity: 'n',
        params: [],
        equations: [],
        checks: [],
        blocks: [{ name: 'c', doc: geometric(0.5), params: { x: '42' } }],
      },
      dev,
    );
    expect(
      res.warnings.some((w) =>
        /override "x" sets a param the child SOLVES — the engine searches it in its own range, so the override is ignored/.test(
          w.message,
        ),
      ),
    ).toBe(true);
    expect(res.values.c__fx).toBeCloseTo(1, 6); // solved, not 42
  });

  it('puts no cap on how many params carry solveFor: the search rule bounds the work', () => {
    // Five independent loops, each closed by its own solveFor. Each is one search in its own
    // range, and the sweeps and the shared budget bound what a set of them may cost, so the count
    // alone is nothing to refuse.
    const doc: SheetDoc = notACircuit({
      title: 'five loops',
      polarity: 'n',
      params: Array.from({ length: 5 }, (_, i) => ({
        name: `e${i}`,
        value: 1,
        min: 0,
        max: 2,
        solveFor: `t${i}`,
      })),
      equations: Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, expr: `0.5*e${i} + 0.5` })),
      checks: [],
    });
    expect(validateSheet(doc)).toEqual([]);
    const res = evaluateSheet(doc, dev);
    expect(res.solve).toEqual({ kind: 'settled' });
    for (let i = 0; i < 5; i++) expect(res.values[`e${i}`]).toBeCloseTo(1, 5);
  });

  it('refuses a design constraint that writes the engine-only held flag', () => {
    const doc = solving({
      name: 'vstar_est',
      value: 0.3,
      min: 0.05,
      max: 0.6,
      designConstraint: { lhs: 'vstar_est', rhs: 'vstar_actual', held: true },
    });
    const errors = validateSheet(doc).filter((w) => w.severity === 'error');
    expect(errors.map((w) => `${w.rule} ${w.location}`)).toEqual(['sheet-param vstar_est']);
    expect(errors[0].message).toMatch(/carries "held", which the engine sets/);
    // Written as false it is still the engine's flag, and still refused by name.
    const unheld = solving({
      name: 'vstar_est',
      value: 0.3,
      min: 0.05,
      max: 0.6,
      designConstraint: { lhs: 'vstar_est', rhs: 'vstar_actual', held: false },
    });
    expect(validateSheet(unheld).some((w) => /carries "held"/.test(w.message))).toBe(true);
  });

  it('excludes a solved param from the sweepable set', () => {
    // It is no longer a free variable, so no sweep may drive it — whatever range it carries.
    expect(sweepable({ min: 0.1, max: 0.3 })).toBe(true);
    expect(sweepable({ min: 0.1, max: 0.3, solveFor: 'vstar_actual' })).toBe(false);
  });
});

/** Root 1, where substitution would contract at exactly |f'| = k per pass. */
function geometric(k: number): SheetDoc {
  return {
    title: `contract ${k}`,
    polarity: 'n',
    params: [{ name: 'x', value: 5, min: -10, max: 10, solveFor: 'fx' }],
    equations: [{ name: 'fx', expr: `${k}*x + ${1 - k}` }],
    checks: [],
    provides: ['fx'],
  };
}

describe('evaluateSheet — degrades instead of throwing', () => {
  it('catches an out-of-range gm/ID as a failed sizing, not an exception', () => {
    const doc = boundDoc();
    doc.params.find((p) => p.name === 'gm_id')!.value = 1000; // far above the slice ceiling
    let res!: ReturnType<typeof evaluateSheet>;
    expect(() => (res = evaluateSheet(doc, dev))).not.toThrow();
    expect(res.sizing?.ok).toBe(false);
    expect(res.warnings.some((w) => w.severity === 'error')).toBe(true);
    expect(res.feasible).toBe(false);
  });

  it('skips an equation with an undeclared name and warns', () => {
    const doc = boundDoc({ equations: [{ name: 'oops', expr: 'no_such_name * 2' }] });
    const res = evaluateSheet(doc, dev);
    expect('oops' in res.values).toBe(false);
    expect(res.warnings.some((w) => w.rule === 'sheet-undeclared')).toBe(true);
  });

  it('evaluates without a device: equations that read it go na, param checks still evaluate', () => {
    const doc = boundDoc({
      checks: [{ id: 'ok', kind: 'advisory', lhs: 'gm_id', op: '<=', rhs: '20' }],
    });
    const res = evaluateSheet(doc); // no table
    expect(res.sizing?.ok).toBe(false);
    expect(res.warnings.some((w) => w.severity === 'error')).toBe(true); // unsolved sizing ⇒ error
    expect(res.feasible).toBe(false); // never vacuously feasible without a successful size
    expect(res.checks[0].status).toBe('pass'); // gm_id is a param, resolvable without a device
  });
});

describe('feasibility is fail-closed', () => {
  it('a non-finite given expression is infeasible even when a param-only physical check passes', () => {
    const doc = boundDoc({
      givens: { L: '1/0', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' }, // L = Infinity → sizing fails
      checks: [{ id: 'param-inv', kind: 'physical', lhs: 'gm_id', op: '<=', rhs: '20' }], // 12<=20 would pass
    });
    const res = evaluateSheet(doc, dev);
    expect(res.sizing?.ok).toBe(false);
    expect(res.warnings.some((w) => w.rule === 'sheet-givens' && w.severity === 'error')).toBe(
      true,
    );
    expect(res.feasible).toBe(false);
  });

  it('a failed spec check is infeasible, but a failed advisory check only advises', () => {
    const base = boundDoc({
      params: [
        { name: 'a', value: 10 },
        { name: 'lim', value: 5 },
      ],
      givens: undefined,
    });
    const req = evaluateSheet(
      { ...base, checks: [{ id: 'spec', kind: 'spec', lhs: 'a', op: '<=', rhs: 'lim' }] },
      dev,
    );
    expect(req.checks[0].status).toBe('fail');
    expect(req.feasible).toBe(false);
    const soft = evaluateSheet(
      { ...base, checks: [{ id: 'soft', kind: 'advisory', lhs: 'a', op: '<=', rhs: 'lim' }] },
      dev,
    );
    expect(soft.checks[0].status).toBe('fail');
    expect(soft.feasible).toBe(true); // advisory checks never block
  });

  it('runSheet folds a validation error (non-finite param) into feasibility', () => {
    const doc = boundDoc({
      params: [{ name: 'x', value: Number.NaN }],
      givens: undefined,
      checks: [],
    });
    const res = runSheet(doc, dev);
    expect(res.warnings.some((w) => w.rule === 'sheet-param')).toBe(true);
    expect(res.feasible).toBe(false);
  });
});

describe('validateSheet', () => {
  it('flags a non-finite param and a wrong givens arity', () => {
    const doc = boundDoc({
      params: [{ name: 'x', value: Number.NaN }],
      givens: { L: 'L', gm: '1', gm_id: '1', id: '1', vds: '0.6' }, // three of three
    });
    const w = validateSheet(doc);
    expect(w.some((x) => x.rule === 'sheet-param')).toBe(true);
    expect(w.some((x) => x.rule === 'sheet-givens')).toBe(true);
  });
});

describe('validateSheet — every sized device states its drain voltage', () => {
  const NO_DRAIN =
    'the givens state no drain voltage, so the device is not sized — give vds, or declare a ' +
    'diode connection (diode: true), which fixes the drain at the gate';
  /** A sheet that sizes nothing itself and composes `blocks`. */
  const composing = (blocks: NonNullable<SheetDoc['blocks']>): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    params: [],
    equations: [],
    checks: [],
    blocks,
  });
  const onGivens = (doc: SheetDoc) => validateSheet(doc).filter((w) => w.rule === 'sheet-givens');

  it('is reported on the givens with no table in hand — as a warning, the sizing being what refuses', () => {
    expect(validateSheet(given({}))).toEqual([
      { rule: 'sheet-givens', severity: 'warning', message: NO_DRAIN, location: 'givens' },
    ]);
  });

  it('is met by a vds or by a diode connection, and by nothing else', () => {
    expect(validateSheet(given({ vds: '0.6' }))).toEqual([]);
    expect(validateSheet(given({ diode: true }))).toEqual([]);
    // A body bias says nothing about the drain, and a connection switched off is no connection.
    expect(validateSheet(given({ vsb: '0' })).map((w) => w.message)).toEqual([NO_DRAIN]);
    expect(validateSheet(given({ diode: false })).map((w) => w.message)).toEqual([NO_DRAIN]);
    // A blank drain voltage states nothing.
    expect(validateSheet(given({ vds: '  ' })).map((w) => w.message)).toEqual([NO_DRAIN]);
    expect(evaluateSheet(given({ vds: '' }), dev).sizing?.needs).toEqual(['vds']);
  });

  it('takes only a literal true for a diode connection', () => {
    // A document read as plain JSON can carry the flag as a string. It is not a connection: the
    // device is not sized on the diagonal, and validation says the flag is malformed.
    const quoted = given({ diode: 'false' as unknown as boolean });
    expect(validateSheet(quoted).map((w) => [w.severity, w.message])).toEqual([
      ['warning', NO_DRAIN],
      ['error', 'given diode must be true or false'],
    ]);
    const res = evaluateSheet(quoted, dev);
    expect(res.sizing?.ok).toBe(false);
    expect(res.sizing?.needs).toEqual(['vds']);
    // Beside a stated drain voltage the string is ignored by the sizing, not read as a diode.
    const both = evaluateSheet(given({ vds: '0.6', diode: 'true' as unknown as boolean }), dev);
    expect(both.sizing?.bias).toEqual({ vds: 0.6 });
  });

  it('names the block whose givens leave it out, and no other', () => {
    const doc = composing([
      { name: 'in', doc: given({ vds: '0.6' }) },
      { name: 'load', doc: given({}) },
      { name: 'ref', doc: given({ diode: true }) },
    ]);
    expect(onGivens(doc)).toEqual([
      {
        rule: 'sheet-givens',
        severity: 'warning',
        message: `block "load": ${NO_DRAIN}`,
        location: 'load.givens',
      },
    ]);
  });

  it('names a nested block by its path', () => {
    const doc = composing([{ name: 'stage', doc: composing([{ name: 'load', doc: given({}) }]) }]);
    expect(onGivens(doc)).toEqual([
      {
        rule: 'sheet-givens',
        severity: 'warning',
        message: `block "stage": block "load": ${NO_DRAIN}`,
        location: 'stage.load.givens',
      },
    ]);
  });

  it('reports the sheet’s own givens and a block’s separately', () => {
    const doc: SheetDoc = { ...given({}), blocks: [{ name: 'load', doc: given({}) }] };
    expect(onGivens(doc).map((w) => w.location)).toEqual(['givens', 'load.givens']);
  });

  it('says nothing about a sheet or a block that sizes no device', () => {
    const bare = composing([]);
    expect(onGivens(bare)).toEqual([]);
    expect(onGivens(composing([{ name: 'k', doc: bare }]))).toEqual([]);
  });

  it('leaves the refusing to the sizing, which fails the run closed on the same words', () => {
    const res = runSheet(given({}), dev);
    expect(res.feasible).toBe(false);
    expect(res.sizing?.error).toBe(NO_DRAIN);
    expect(res.sizing?.needs).toEqual(['vds']);
    // Validation and the sizing say it in the same words at the same place; the run carries it
    // once, as the sizing's error.
    expect(validateSheet(given({})).map((w) => [w.severity, w.message])).toEqual([
      ['warning', NO_DRAIN],
    ]);
    expect(res.warnings.map((w) => [w.severity, w.message])).toEqual([['error', NO_DRAIN]]);
  });
});

describe('the shipped example', () => {
  it('runs on the demo device with a mix of pass and fail', () => {
    const res = runSheet(EXAMPLES[0], devBias);
    expect(res.sizing?.ok).toBe(true);
    const statuses = res.checks.map((r) => r.status);
    expect(statuses).toContain('pass');
    expect(statuses).toContain('fail'); // headroom fails at the default gm/ID = 12
  });
});

describe('the noise & matching example', () => {
  const ex = EXAMPLES.find((e) => e.title === 'NMOS noise & matching')!;

  it('its author formulas reproduce the core noise/mismatch oracles (no drift from the trusted impls)', () => {
    const res = runSheet(ex, devBias);
    expect(res.sizing?.ok).toBe(true);
    const v = res.values;
    // Integrated input noise == core integratedNoise on the thermal PSD — which the
    // sizing already reports at the SIZED width — and the intensive flicker corner fco.
    // (svth·fco == svfl, so the flicker term matches too.)
    const expectedVn = integratedNoise(v.svth, v.fco, v.f_lo, v.f_hi);
    expect(v.vn_int / expectedVn).toBeCloseTo(1, 12);
    // Input offset == core Pelgrom mismatch().sigmaVos at the sized geometry.
    const m = mismatch(v.W, v.L, v.gm_id, { avth: v.avt, abeta: v.abeta });
    expect(v.sigma_vos / m.sigmaVos).toBeCloseTo(1, 12);
  });

  it('vn_int matches an INDEPENDENT numerical integral of the input PSD (not the closed form)', () => {
    // The cross-check above shares the analytic closed form, so it cannot catch a wrong band
    // integral. Anchor it with a numerical quadrature of S(f) = svth_w + svfl_w/f over the band
    // (log-grid trapezoid — the 1/f tail spans decades), a genuinely separate computation path.
    const v = runSheet(ex, devBias).values;
    const svth_w = v.svth; // already reported at the sized width
    const svfl_w = v.svfl;
    const N = 40000;
    const r = Math.log(v.f_hi / v.f_lo) / N;
    let integral = 0;
    for (let i = 0; i < N; i++) {
      const fa = v.f_lo * Math.exp(i * r);
      const fb = v.f_lo * Math.exp((i + 1) * r);
      integral += 0.5 * (svth_w + svfl_w / fa + (svth_w + svfl_w / fb)) * (fb - fa);
    }
    expect(v.vn_int / Math.sqrt(integral)).toBeCloseTo(1, 4);
  });

  it('sweeping gm/ID opens a bounded feasible window: noise binds the low end, headroom the high end', () => {
    const sw = sweepSheet(ex, 'gm_id', devBias, 13);
    const margins = (id: string) =>
      sw.checks.find((r) => r.id === id)!.marginPct.filter((x): x is number => x != null);
    const noise = margins('noise-spec');
    const head = margins('headroom');
    // noise margin IMPROVES as gm/ID rises (more gm ⇒ less integrated thermal noise) ...
    expect(noise.at(-1)!).toBeGreaterThan(noise[0]!);
    // ... while the headroom margin DEGRADES (V* = 2/(gm/ID) shrinks).
    expect(head.at(-1)!).toBeLessThan(head[0]!);
    // A bounded window: infeasible at both ends, feasible in the middle.
    expect(sw.feasible[0]).toBe(false);
    expect(sw.feasible.at(-1)).toBe(false);
    expect(sw.feasible.some((f) => f)).toBe(true);
  });
});

describe('a param or equation named like a quantity the sizing publishes', () => {
  // The sizing merges what it publishes into its level's scope after the params are seeded, so a
  // param of such a name holds the author's number on a table that lacks the quantity and the
  // device's on one that carries it. `T` is every table's temperature; `gamma` follows `sth`.
  const named = (params: SheetVar[], equations: SheetDoc['equations'] = []): SheetDoc =>
    boundDoc({
      params: [...boundDoc().params, ...params],
      equations: [{ name: 'seen', expr: 'gamma*T' }, ...equations],
    });
  const said = (doc: SheetDoc): string[] =>
    validateSheet(doc)
      .filter((w) => w.rule === 'sheet-collision')
      .map((w) => `${w.severity} ${w.location}`);

  it('warns, because the sizing overwrites the param where a device is sized', () => {
    const doc = named([
      { name: 'T', value: 350 },
      { name: 'gamma', value: 3 },
    ]);
    expect(said(doc)).toEqual(['warning T', 'warning gamma']);
    expect(validateSheet(doc).find((w) => w.location === 'gamma')?.message).toBe(
      'param "gamma": the sizing publishes a quantity named gamma, which overwrites this param ' +
        'where a device is sized; rename it',
    );
    // What it guards against: on a table that stores the demo's gamma column the sizing's 1.0
    // replaces the author's 3, and the table's 300.15 K the author's 350 K.
    const res = evaluateSheet(doc, dev);
    expect(res.values.gamma).toBe(1);
    expect(res.values.T).toBeCloseTo(300.15, 9);
  });

  it('warns on an equation of such a name too, and not on a param that is the same-named given', () => {
    expect(said(named([], [{ name: 'ro', expr: '1/gds' }]))).toEqual(['warning ro']);
    // boundDoc gives gm_id as the param `gm_id`: the sizing writes back the number it was handed.
    expect(boundDoc().givens?.gm_id).toBe('gm_id');
    expect(said(boundDoc())).toEqual([]);
    // A level that sizes no device publishes nothing over its params.
    expect(said({ ...named([{ name: 'gamma', value: 3 }]), givens: undefined })).toEqual([]);
  });
});

describe('a sheet that reads γ against gm without gmb is told', () => {
  const rows = (exprs: string[]): SheetDoc =>
    boundDoc({ equations: exprs.map((expr, i) => ({ name: `r${i}`, expr })) });
  const said = (doc: SheetDoc) =>
    validateSheet(doc)
      .filter((w) => w.rule === 'sheet-noise-form')
      .map((w) => [w.severity, w.location, w.symbol]);

  it('warns on the 4kTγ/gm idiom, at the sheet’s own level and through a block’s names', () => {
    expect(said(rows(['4*k*T*gamma/gm', 'sqrt(2*4*k*T*in__gamma/in__gm)']))).toEqual([
      ['warning', 'r0', 'gamma'],
      ['warning', 'r1', 'in__gamma'],
    ]);
    expect(
      validateSheet(rows(['4*k*T*gamma/gm'])).find((w) => w.rule === 'sheet-noise-form'),
    ).toMatchObject({
      message:
        'equation "r0" reads gamma against gm without gmb, which is the thermal floor without ' +
        'body effect, low by 1 + gmb/gm in power on a table that carries gmb — read svth_m or ' +
        'vnth_m, or include gmb',
    });
  });

  it('is silent where the row carries the body effect or reads a noise figure', () => {
    expect(
      said(
        rows([
          '4*k*T*gamma*(gm+gmb)/gm^2',
          'svth_m*gm/(4*k*T)',
          'gamma*vnth_m',
          '2*k*T*gamma/C_x',
          'in__gamma*gm',
        ]),
      ),
    ).toEqual([]);
  });
});

describe('thermal noise from the table when it carries it, and the result says which', () => {
  // sth doubled and the demo's own gamma column dropped, so the measured γ is 2 and cannot pass
  // for the default; and the same table with no thermal noise at all.
  const measured = scaleQuantities(withoutColumns(dev, ['gamma']), { sth: 2 });
  const bare = withoutColumns(dev, ['gamma', 'sth']);
  const doc = boundDoc({
    equations: [
      { name: 'vn', expr: 'vnth_m' },
      { name: 'sv_own', expr: '4*k*T*gamma*(gm+gmb)/gm^2' },
    ],
  });

  it('reads vnth_m off the stored noise, and so does an author formula reading gamma', () => {
    const res = runSheet(doc, measured);
    expect(res.sizing?.noise).toBe('measured');
    const v = res.values;
    expect(v.gamma).toBeCloseTo(2, 12);
    expect(v.vn / v.vnth).toBeCloseTo(1, 12);
    // The author's formula divides by the sizing's honoured gm, the namespace keys by the gm the
    // point re-derives: the two differ by the interpolation residual (~0.1 %), not by γ.
    expect(v.sv_own / v.svth_m).toBeCloseTo(1, 2);
  });

  it('falls back to the γ = 1 estimate on a table without it, and says so', () => {
    const res = runSheet(doc, bare);
    expect(res.sizing?.noise).toBe('estimated');
    expect(res.values).not.toHaveProperty('gamma');
    const { gm, gmb } = res.values;
    const estimate = Math.sqrt(4 * PHYS.k * PHYS.T * (gm + gmb)) / gm;
    expect(res.values.vn / estimate).toBeCloseTo(1, 2);
    // The estimate is γ's own fallback, carried beside the noise source.
    expect(res.sizing?.fallbacks?.map((f) => [f.quantity, f.missing])).toEqual([
      ['gamma', ['sth']],
    ]);
    expect(runSheet(doc, dev).sizing?.noise).toBe('column');
    expect(runSheet(doc, dev).sizing).not.toHaveProperty('fallbacks');
  });

  it('carries the fallback forms a table without gmb forces beside the noise source, once per device', () => {
    const noGmb = withoutColumns(bare, ['gmb']);
    const res = runSheet(doc, noGmb);
    expect(res.sizing?.noise).toBe('estimated');
    expect(res.sizing?.fallbacks?.map((f) => [f.quantity, f.missing, f.form])).toEqual([
      ['gamma', ['sth'], '1.0'],
      ['svth_m', ['gmb'], '4*k*T*gamma/gm'],
      ['vnth_m', ['gmb'], 'sqrt(4*k*T*gamma/gm)'],
    ]);
    // The figure is that form: no body-effect term.
    expect(res.values.vn / Math.sqrt((4 * PHYS.k * PHYS.T) / res.values.gm)).toBeCloseTo(1, 2);
    // Said on the report, not repeated as a warning of the run.
    const said = res.sizing!.fallbacks!.map(fallbackMessage);
    expect(res.warnings.filter((w) => said.some((m) => w.message.includes(m)))).toEqual([]);
    // And where the table has the column, nothing is owed.
    expect(runSheet(doc, measured).sizing).not.toHaveProperty('fallbacks');
  });

  it('lists each sized device of a composed tree with its own table’s answer', () => {
    const child = (title: string): SheetDoc => ({ ...boundDoc(), title, provides: ['vnth_m'] });
    const tree: SheetDoc = {
      title: 'tree',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        { name: 'a', doc: child('a') },
        { name: 'b', device: 'bare', doc: child('b') },
      ],
    };
    const res = runSheet(tree, measured, (id) => (id === 'bare' ? bare : undefined));
    expect(noiseSourcesIn(res)).toEqual([
      { device: 'a', source: 'measured', fallbacks: [] },
      { device: 'b', source: 'estimated', fallbacks: derivedFallbacks(bare.grid) },
    ]);
  });
});

// The five-transistor OTA on the sky130 tables the generator writes (data/pdk is not committed,
// so this runs only where the tables have been generated). Simulated, the OTA's input-referred
// thermal floor is 28.24 nV/√Hz, and the nfet's own effective γ at the pair's bias point is 1.95
// where the pfet's at the load's is 1.00 (tools/verify/README.md), both against gm alone. The
// γ = 1 estimate, body effect counted, reads 25.0 nV/√Hz; reading the tables' own thermal noise
// has to land near the simulation.
const SKY130 = fileURLToPath(new URL('../../data/pdk/sky130', import.meta.url));
const skyTable = (name: string): string =>
  join(SKY130, `sky130_fd_pr__${name}__tt__27C.mostab.csv`);
describe.skipIf(!existsSync(skyTable('nfet_01v8')) || !existsSync(skyTable('pfet_01v8')))(
  'the five-transistor OTA on sky130 reads its noise from the tables',
  () => {
    const load = (name: string): DeviceTable => {
      const r = importMostab(readFileSync(skyTable(name)));
      if (!r.ok) throw new Error(`${name} did not import`);
      return r.dataset.tables[0];
    };

    it('lands its input-referred thermal density near the simulated floor', () => {
      const nfet = load('nfet_01v8');
      const pfet = load('pfet_01v8');
      const doc = JSON.parse(
        readFileSync(
          fileURLToPath(new URL('../../sheets/otas/five-transistor-ota.json', import.meta.url)),
          'utf8',
        ),
      ) as SheetDoc;
      // The load mirror on the pfet table, which is exported signed (tools/verify/README.md).
      const load_ = new Set(['ldr', 'ld']);
      doc.blocks = doc.blocks?.map((b) => (load_.has(b.name) ? { ...b, device: 'pfet' } : b));
      doc.params = doc.params.map((q) => (q.name === 'ld_sign' ? { ...q, value: -1 } : q));
      // The bias reference is a library sheet the 5T composes by reference.
      const res = runSheet(doc, nfet, (id) => (id === 'pfet' ? pfet : undefined), REFS);
      expect(res.feasible).toBe(true);
      expect(new Set(noiseSourcesIn(res).map((d) => d.source))).toEqual(new Set(['measured']));
      const v = res.values;
      expect(v.vn_in).toBeGreaterThan(26.5e-9);
      expect(v.vn_in).toBeLessThan(29.5e-9);
      // Each device type at its own bias point, as an effective γ against kT/gm.
      const gammaOf = (block: string): number =>
        (v[`${block}__vnth_m`] ** 2 * v[`${block}__gm`]) / (4 * PHYS.k * PHYS.T);
      expect(gammaOf('in')).toBeGreaterThan(1.8);
      expect(gammaOf('in')).toBeLessThan(2.1);
      expect(gammaOf('ld')).toBeGreaterThan(0.9);
      expect(gammaOf('ld')).toBeLessThan(1.1);
    });
  },
);

describe('sweepSheet — feasibility curve', () => {
  it('traces a check margin across a parameter range and bounds the feasible window', () => {
    const doc = structuredClone(EXAMPLES[0]);
    const sw = sweepSheet(doc, 'gm_id', devBias, 21);

    expect(sw.x.length).toBe(21);
    expect(sw.x[0]).toBeCloseTo(6, 9); // the example's gm/ID slider spans 6..18
    expect(sw.x[20]).toBeCloseTo(18, 9);
    expect(sw.checks.map((r) => r.id)).toEqual(doc.checks.map((r) => r.id)); // parallel, in order

    // V* ≈ 2/(gm/ID) falls as gm/ID rises, so the headroom margin shrinks monotonically and
    // crosses zero — the whole point of the view (the efficiency↔headroom trade made visible).
    const head = sw.checks.find((r) => r.id === 'headroom')!;
    const finite = head.marginPct.filter((m): m is number => m != null);
    expect(finite[0]).toBeGreaterThan(finite.at(-1)!);
    expect(Math.max(...finite)).toBeGreaterThan(0); // passes at the low-gm/ID end
    expect(Math.min(...finite)).toBeLessThan(0); // fails at the high-gm/ID end

    // A bounded feasible window exists: some samples close, some do not, and the highest
    // gm/ID (least headroom) is infeasible.
    expect(sw.feasible.some((f) => f)).toBe(true);
    expect(sw.feasible.some((f) => !f)).toBe(true);
    expect(sw.feasible.at(-1)).toBe(false);
  });

  it('returns an empty sweep for an unbounded or unknown parameter', () => {
    const doc = structuredClone(EXAMPLES[0]);
    expect(sweepSheet(doc, 'CL', dev).x).toEqual([]); // CL has no min/max → not sweepable
    expect(sweepSheet(doc, 'no_such_param', dev).x).toEqual([]);
  });
});

describe('composition — blocks and the scalars they provide', () => {
  const cascode = EXAMPLES.find((e) => e.title.startsWith('NMOS cascode'))!;

  it('evaluates children first, exposes provides as name__key, and reports each child', () => {
    const res = runSheet(cascode, devBias);
    expect(res.sizing?.ok).toBe(true);
    expect(res.blocks).toHaveLength(1);
    const cs = res.blocks![0];
    expect(cs.name).toBe('cs');
    expect(cs.feasible).toBe(true);
    // the provided scalars are visible in the parent scope as cs__*
    expect(res.values['cs__av0']).toBeCloseTo(cs.provides.av0, 12);
    // the parent's author math composed them: Av == av0 · cs__av0 (the cascode gain)
    expect(res.values.Av).toBeCloseTo(res.values.av0 * res.values['cs__av0'], 9);
    // and the parent sized its OWN device from the child's current (the series stack)
    expect(res.values.id).toBeCloseTo(cs.provides.id, 15);
  });

  it('a leaf reports no children', () => {
    expect(runSheet(EXAMPLES[0], devBias).blocks).toBeUndefined();
  });

  it('is fail-closed: an infeasible child drags the parent infeasible, attributed to the block', () => {
    const badChild: SheetDoc = {
      title: 'bad',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'gm_id', value: 999 },
        { name: 'I_bias', value: 20e-6 },
      ],
      givens: { L: 'L', id: 'I_bias', gm_id: 'gm_id', vds: '0.6' }, // gm/ID 999 ≫ ceiling ⇒ the child cannot size
      equations: [],
      checks: [],
      provides: ['id'],
    };
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'c', doc: badChild }],
    };
    const res = runSheet(parent, dev);
    expect(res.blocks![0].feasible).toBe(false);
    expect(res.feasible).toBe(false);
    expect(res.warnings.some((w) => w.message.includes('block "c":'))).toBe(true);
  });

  it('sweeping the shared knob bounds a feasible window over the whole tree', () => {
    const sw = sweepSheet(cascode, 'gm_id', devBias, 13);
    expect(sw.feasible[0]).toBe(false); // gain too low at low gm/ID
    expect(sw.feasible.at(-1)).toBe(false); // headroom gone at high gm/ID
    expect(sw.feasible.some((f) => f)).toBe(true);
    const gain = sw.checks
      .find((r) => r.id === 'gain-spec')!
      .marginPct.filter((x): x is number => x != null);
    expect(gain.at(-1)!).toBeGreaterThan(gain[0]!); // gain improves with gm/ID
  });

  it('a child sizes against the device its block names (resolver), or inherits the parent table', () => {
    const child: SheetDoc = {
      title: 'k',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'gm_id', value: 10 },
        { name: 'I_bias', value: 20e-6 },
      ],
      givens: { L: 'L', id: 'I_bias', gm_id: 'gm_id', vds: '0.6' },
      equations: [],
      checks: [],
      provides: ['id'],
    };
    const parent = (device?: string): SheetDoc => ({
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'k', doc: child, ...(device ? { device } : {}) }],
    });
    const wide = generateDemoDevice({ W: 40e-6, vds: { min: 0, max: 1.2, step: 0.3 } });
    const resolve = (id: string) => (id === 'wide' ? wide : undefined);
    expect(runSheet(parent('wide'), dev, resolve).blocks![0].feasible).toBe(true); // resolved
    expect(runSheet(parent(undefined), dev, resolve).blocks![0].feasible).toBe(true); // inherited

    // A named device the resolver cannot supply fails closed with a clear, attributed message.
    const missing = runSheet(parent('missing'), dev, resolve);
    expect(missing.blocks![0].feasible).toBe(false);
    expect(missing.feasible).toBe(false);
    expect(
      missing.warnings.some(
        (w) => w.severity === 'error' && /device "missing" did not resolve/.test(w.message),
      ),
    ).toBe(true);
  });

  it('a named-but-unresolved device fails even a BINDLESS child closed (not vacuously feasible)', () => {
    // The regression this guards: without the unresolved-device branch, a bindless child sized
    // against no table is vacuously feasible (no givens ⇒ no error), so the parent reads feasible
    // while its child's named device silently does not exist. A child WITH givens would fail on
    // the sizing regardless, so only a child without givens distinguishes the branch.
    const noGivens: SheetDoc = {
      title: 'k0',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      provides: [],
    };
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'k', doc: noGivens, device: 'missing' }],
    };
    const res = runSheet(parent, dev, () => undefined);
    expect(res.blocks![0].feasible).toBe(false);
    expect(res.feasible).toBe(false);
    expect(res.warnings.some((w) => /device "missing" did not resolve/.test(w.message))).toBe(true);
  });

  it('fails closed on a broken param override (no silent fallback to the child default)', () => {
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'gm_id', value: 12 },
        { name: 'I_bias', value: 20e-6 },
      ],
      givens: { L: 'L', id: 'I_bias', gm_id: 'gm_id', vds: '0.6' },
      equations: [],
      checks: [],
      provides: ['id'],
    };
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [{ name: 'I_budget', value: 30e-6 }],
      equations: [{ name: 'echo', expr: 'c__id' }],
      checks: [],
      blocks: [{ name: 'c', doc: child, params: { I_bias: 'I_budgett' } }], // typo ⇒ unresolvable
    };
    const res = runSheet(parent, dev);
    expect(
      res.warnings.some((w) => w.severity === 'error' && /override "I_bias"/.test(w.message)),
    ).toBe(true);
    expect(res.blocks![0].feasible).toBe(false); // wiring broke ⇒ child infeasible
    expect(res.feasible).toBe(false); // ⇒ parent infeasible
    // the child's provides are withheld, so dependent parent math is `na`, not a stale number
    expect('c__id' in res.values).toBe(false);
    expect('echo' in res.values).toBe(false);
  });
});

describe('pass-through columns reach the sheet scope', () => {
  // A column the importer does not recognize (`ueff`) is carried through as a quantity, and the
  // sheet format promises it is readable like any other — not rescaled, so at w0.
  const extra = withUeff();
  // boundDoc's operating point, sized by current so the bias is a round number.
  const sizedDoc = (overrides: Partial<SheetDoc> = {}): SheetDoc =>
    boundDoc({
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'Ib', value: 20e-6 },
      ],
      givens: { L: 'L', gm_id: '12', id: 'Ib', vds: '0.6' },
      ...overrides,
    });
  const atSizing = (res: SheetResult): number =>
    ueffAt({ l: 0.5e-6, vds: 0.6, vgs: res.sizing!.vgs });
  const noted = (res: SheetResult, rule: string): string[] =>
    res.warnings.filter((w) => w.rule === rule).map((w) => w.message);

  it('a sized sheet reads the column in its own equations, at w0', () => {
    const res = runSheet(
      sizedDoc({
        equations: [
          { name: 'U', expr: 'ueff' },
          { name: 'U_scaled', expr: 'ueff*W/w0' },
        ],
        provides: ['ueff'],
      }),
      extra,
    );
    expect(res.sizing?.ok).toBe(true);
    expect(noted(res, 'sheet-undeclared')).toEqual([]);
    expect(res.values.ueff).toBeCloseTo(atSizing(res), 12);
    expect(res.values.U).toBe(res.values.ueff);
    expect(res.values.U_scaled / res.values.U).toBeCloseTo(res.sizing!.W / extra.meta.W!, 12);
    expect(res.feasible).toBe(true);
    // The sizing says which of its numbers are read at w0, so a reader need not know the table.
    expect(res.sizing?.passthrough).toEqual(['ueff']);
  });

  it('a child provides the column to its parent, which reads child__ueff', () => {
    const parent: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [],
      equations: [{ name: 'U_twice', expr: '2*cs__ueff' }],
      checks: [{ id: 'mobility', kind: 'spec', lhs: 'U_twice', op: '<=', rhs: '1' }],
      blocks: [{ name: 'cs', doc: sizedDoc({ provides: ['ueff'] }) }],
    };
    const res = runSheet(parent, extra);
    expect(res.warnings.filter((w) => /ueff/.test(w.message))).toEqual([]);
    const child = res.blocks![0];
    expect(child.sizing?.ok).toBe(true);
    expect(child.provides.ueff).toBeCloseTo(
      ueffAt({ l: 0.5e-6, vds: 0.6, vgs: child.sizing!.vgs }),
      27,
    );
    expect(res.values.cs__ueff).toBe(child.provides.ueff);
    expect(res.values.U_twice).toBe(2 * child.provides.ueff);
    expect(res.checks[0].status).toBe('pass');
    expect(res.feasible).toBe(true);
  });

  it('a child bound to a named device provides that device’s column', () => {
    // The parent has no table of its own: the column can only have come from the bound one.
    const parent: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'cs', device: 'extra', doc: sizedDoc({ provides: ['ueff'] }) }],
    };
    const res = runSheet(parent, undefined, (id) => (id === 'extra' ? extra : undefined));
    expect(res.blocks![0].sizing?.ok).toBe(true);
    expect(res.values.cs__ueff).toBeCloseTo(
      ueffAt({ l: 0.5e-6, vds: 0.6, vgs: res.blocks![0].sizing!.vgs }),
      12,
    );
  });

  it('a column never displaces a name the sheet already means something by: it is read as table__<name>', () => {
    // A column called `k` would otherwise replace Boltzmann's constant for every equation after
    // the sizing, and one called like a param would silently replace the param — on this table
    // and no other. Each stays readable under its affixed name, and the sheet is told which.
    const table = importOne(demoCsvWith({ k: () => 1, ueff: ueffAt, mob: () => 2 }));
    const res = runSheet(
      sizedDoc({
        params: [
          { name: 'L', value: 0.5e-6 },
          { name: 'Ib', value: 20e-6 },
          { name: 'ueff', value: 3e-15 },
        ],
        equations: [
          { name: 'kT', expr: 'k*T' },
          { name: 'U', expr: 'ueff' },
          { name: 'K_col', expr: 'table__k' },
          { name: 'U_col', expr: 'table__ueff' },
          { name: 'M', expr: 'mob' },
        ],
      }),
      table,
    );
    expect(res.sizing?.ok).toBe(true);
    expect(res.values.kT).toBeCloseTo(PHYS.k * PHYS.T, 30);
    expect(res.values.U).toBe(3e-15);
    expect(res.values.K_col).toBe(1);
    expect(res.values.U_col).toBeCloseTo(atSizing(res), 12);
    // A column whose name collides with nothing keeps it, and draws no note.
    expect(res.values.M).toBe(2);
    expect(noted(res, 'sheet-undeclared')).toEqual([]);
    // Validation does not take table__k for a block called `table` that is missing.
    expect(noted(res, 'sheet-provide-coverage')).toEqual([]);
    expect(noted(res, 'sheet-passthrough')).toEqual([
      `the table's "k" column is read as "table__k": "k" is an expression constant, which keeps its meaning`,
      `the table's "ueff" column is read as "table__ueff": the sheet already defines "ueff", which keeps its meaning`,
    ]);
    // The sizing lists each column under the name the sheet reads it by — the panel's
    // "at w0, not scaled" line shows these.
    expect([...(res.sizing?.passthrough ?? [])].sort()).toEqual(['mob', 'table__k', 'table__ueff']);
    // An advisory note, not a failure: the sheet still means what it says.
    expect(res.feasible).toBe(true);
  });

  it("an equation's name is the sheet's too, and a column is left out only where its affixed name is taken as well", () => {
    // An equation is written after the sizing, so a column of its name would be read by the
    // expressions before it and replaced for the ones after: it is affixed like a param's.
    const table = importOne(demoCsvWith({ ueff: ueffAt, kappa: () => 5 }));
    const res = runSheet(
      sizedDoc({
        params: [
          { name: 'L', value: 0.5e-6 },
          { name: 'Ib', value: 20e-6 },
          { name: 'kappa', value: 1 },
          { name: 'table__kappa', value: 2 },
        ],
        equations: [
          { name: 'ueff', expr: '7' },
          { name: 'U_col', expr: 'table__ueff' },
        ],
      }),
      table,
    );
    expect(res.values.ueff).toBe(7);
    expect(res.values.U_col).toBeCloseTo(atSizing(res), 12);
    expect(res.values.kappa).toBe(1);
    expect(res.values.table__kappa).toBe(2);
    expect(noted(res, 'sheet-passthrough')).toEqual([
      `the table's "ueff" column is read as "table__ueff": the sheet already defines "ueff", which keeps its meaning`,
      `the table's "kappa" column is not read: the sheet already defines both "kappa" and ` +
        `"table__kappa" — rename the column in the export to read it`,
    ]);
    expect(res.sizing?.passthrough).toEqual(['table__ueff']);
  });

  it('a child provides its affixed column to its parent, which reads child__table__k', () => {
    const table = importOne(demoCsvWith({ k: () => 1 }));
    const parent: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [],
      equations: [{ name: 'K', expr: 'cs__table__k' }],
      checks: [],
      blocks: [{ name: 'cs', doc: sizedDoc({ provides: ['table__k'] }) }],
    };
    const res = runSheet(parent, table);
    expect(res.values.K).toBe(1);
    expect(res.warnings.filter((w) => /table__k/.test(w.message)).map((w) => w.rule)).toEqual([
      'sheet-passthrough',
    ]);
  });

  it('refuses a block named table, whose provides would read like an affixed column', () => {
    const parent: SheetDoc = notACircuit({
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'table', doc: sizedDoc({ provides: ['gm'] }) }],
    });
    expect(validateSheet(parent).filter((w) => w.severity === 'error')).toEqual([
      expect.objectContaining({
        rule: 'sheet-block',
        location: 'table',
        message:
          'block name "table" is reserved: a table column whose own name the sheet already uses ' +
          'is read as "table__<column>", and a block of this name would provide names of the same form',
      }),
    ]);
    const renamed = { ...parent, blocks: [{ ...parent.blocks![0], name: 'tbl' }] };
    expect(validateSheet(renamed).filter((w) => w.severity === 'error')).toEqual([]);
  });
});

describe('validateSheet — hand-tuned assumptions about a device operating point', () => {
  // A child whose given vds comes from a parent param, and which provides its own vgs back.
  const withCheck = (lhs: string, biasExpr = 'guess'): SheetDoc =>
    notACircuit({
      title: 'p',
      polarity: 'n',
      params: [
        { name: 'guess', value: 0.7 },
        { name: 'V_node', value: 0.9 },
      ],
      equations: [],
      checks: [{ id: 'check', kind: 'advisory', lhs, op: '<=', rhs: '0.05' }],
      blocks: [
        {
          name: 'k',
          doc: {
            title: 'c',
            polarity: 'n',
            params: [
              { name: 'L', value: 0.5e-6 },
              { name: 'id', value: 10e-6 },
              { name: 'gm_id', value: 10 },
              { name: 'vd', value: 0.7 },
            ],
            givens: { L: 'L', id: 'id', gm_id: 'gm_id', vds: 'vd' },
            equations: [],
            checks: [],
            provides: ['vgs', 'vdsat'],
          },
          params: { vd: biasExpr },
        },
      ],
    });
  const assumptionFindings = (d: SheetDoc): string[] =>
    validateSheet(d)
      .filter((w) => w.rule === 'sheet-assumption')
      .map((w) => w.message);

  it('flags a param that biases a block while a check asserts it equals that block’s own vgs', () => {
    const w = assumptionFindings(withCheck('abs(k__vgs - guess)'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/"guess" biases block "k" \(vds\)/);
    // The bias IS the assumption and it is tied to vgs, so this is the diode identity.
    expect(w[0]).toMatch(/diode-connected/);
  });

  it('does NOT flag a headroom advisory check that merely mentions both names', () => {
    // The discriminator: this asserts nothing about the two being equal. Before the abs(...)
    // requirement this shape produced a false finding on a third of the library.
    expect(assumptionFindings(withCheck('V_node - k__vdsat'))).toEqual([]);
    // Nor does an abs() elsewhere in the same expression create a pairing.
    expect(assumptionFindings(withCheck('abs(k__vdsat) - V_node + guess'))).toEqual([]);
  });

  it('calls a compound bias expression a node voltage, not a diode connection', () => {
    const w = assumptionFindings(withCheck('abs(k__vgs - guess)', 'V_node - guess'));
    expect(w).toHaveLength(1);
    expect(w[0]).not.toMatch(/diode-connected/);
    expect(w[0]).toMatch(/node voltage/);
  });

  it('a scaled or offset bias is not a diode either — the identity must be the bare param', () => {
    // `2*guess` and `guess - 0.1` say the drop is NOT the vgs, and "declare the connection"
    // would change those designs. Counting free names (one) cannot see that; only the bare
    // identifier earns the diode advice.
    for (const bias of ['2*guess', 'guess - 0.1', 'guess*1.0']) {
      const w = assumptionFindings(withCheck('abs(k__vgs - guess)', bias));
      expect(w).toHaveLength(1);
      expect(w[0]).not.toMatch(/diode-connected/);
    }
  });

  it('sees the call, not the letters: a space before the paren does not hide the pattern', () => {
    // The parser treats `abs (x)` and `abs(x)` identically, so a literal "abs(" scan let a
    // one-space reformat silently switch the lint off.
    expect(assumptionFindings(withCheck('abs (k__vgs - guess)'))).toHaveLength(1);
    // …and a name merely ENDING in abs is not a call.
    expect(assumptionFindings(withCheck('fabs(k__vgs - guess)'))).toEqual([]);
  });

  it('does not flag a declared bias paired with a symmetric headroom check', () => {
    // `abs(bias - dev__vdsat) <= margin` is the format docs' own recommended shape: a real
    // declared bias plus a margin check. Only a LEVEL the assumption could stand in for — vgs,
    // vth — closes the round trip; a saturation margin does not.
    expect(assumptionFindings(withCheck('abs(V_node - k__vdsat)', 'V_node'))).toEqual([]);
  });

  it('an estimate already classed "assumed" raises no assumption finding', () => {
    // The author has said in the sheet's own words that this level is typed rather than solved,
    // and the check tying it back is how that assumption is checked — so there is no advice left
    // to give. The run lists the param among its assumptions instead; no finding repeats it.
    // A compound bias (a node written as a difference), so this is not the diode case below.
    const doc = withCheck('abs(k__vgs - guess)', 'V_node - guess');
    doc.params[0] = { ...doc.params[0], class: 'assumed' };
    expect(validateSheet(doc).filter((x) => x.symbol === 'guess')).toEqual([]);
    // `guess` reaches k's drain through the override, so it is one of the run's assumptions.
    expect(runSheet(doc, devBias).assumptions).toEqual(['guess']);
  });

  it('a diode-connected estimate keeps its advice even when classed "assumed"', () => {
    // The class says the value is typed; the diode advice says it need not exist at all — the
    // connection can be declared and the table read on its diagonal. That fix outranks the label.
    const doc = withCheck('abs(k__vgs - guess)');
    doc.params[0] = { ...doc.params[0], class: 'assumed' };
    const w = assumptionFindings(doc);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/diode-connected/);
  });

  it('the diode advice on an "assumed" estimate does not depend on which check comes first', () => {
    // The first check sums three names in one abs — a loop of drops, not the diode identity — so on
    // an assumed param it earns nothing. The second compares exactly the bare drain bias and the
    // block's own vgs: the diode identity, whose advice the class does not suppress. One warning,
    // naming the second check.
    const doc = withCheck('abs(k__vgs - guess - V_node)');
    doc.checks.push({
      id: 'diode-check',
      kind: 'advisory',
      lhs: 'abs(k__vgs - guess)',
      op: '<=',
      rhs: '0.05',
    });
    doc.params[0] = { ...doc.params[0], class: 'assumed' };
    const w = assumptionFindings(doc);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/check "diode-check"/);
    expect(w[0]).toMatch(/diode-connected/);
  });

  it('an estimate classed "independent" keeps the assumption advice — the class contradicts it', () => {
    const doc = withCheck('abs(k__vgs - guess)', 'V_node - guess');
    doc.params[0] = { ...doc.params[0], class: 'independent' };
    expect(assumptionFindings(doc)).toHaveLength(1);
  });

  it('is advisory — a sheet carrying the pattern still validates without errors', () => {
    expect(
      validateSheet(withCheck('abs(k__vgs - guess)')).some((w) => w.severity === 'error'),
    ).toBe(false);
  });
});

describe('validateSheet — composition', () => {
  it('flags a separator in a block name, a duplicate name, and a stray override', () => {
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [{ name: 'L', value: 1e-6 }],
      equations: [],
      checks: [],
      provides: [],
    };
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        { name: 'a__b', doc: child },
        { name: 'x', doc: child, params: { nope: '1' } },
        { name: 'x', doc: child },
      ],
    };
    const w = validateSheet(doc);
    expect(w.some((x) => x.rule === 'sheet-block' && /must not contain/.test(x.message))).toBe(
      true,
    );
    expect(w.some((x) => x.rule === 'sheet-block' && /duplicate/.test(x.message))).toBe(true);
    expect(w.some((x) => x.rule === 'sheet-block-param')).toBe(true);
  });

  it('warns when a parent param/equation name collides with a child-provided scalar', () => {
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [{ name: 'L', value: 1e-6 }],
      equations: [],
      checks: [],
      provides: ['av0'],
    };
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'cs__av0', value: 1 }], // collides with the injected cs__av0
      equations: [{ name: 'cs__id', expr: '1' }], // child provides only av0, so this does NOT collide
      checks: [],
      blocks: [{ name: 'cs', doc: child }],
    };
    const w = validateSheet(doc);
    expect(w.some((x) => x.rule === 'sheet-collision' && /cs__av0/.test(x.message))).toBe(true);
    expect(w.some((x) => x.rule === 'sheet-collision' && /cs__id/.test(x.message))).toBe(false);
  });

  it('distinguishes an undeclared child scalar from a name whose block does not exist', () => {
    const child = boundDoc({ provides: ['gm'] });
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      equations: [
        { name: 'a', expr: 'kid__gm' }, // provided — fine
        { name: 'b', expr: 'kid__gds' }, // the block exists but does not provide it
        { name: 'c', expr: 'kdi__gm' }, // no such block: a transposed block name
      ],
      checks: [],
      blocks: [{ name: 'kid', doc: child }],
    };
    const w = validateSheet(doc).filter((x) => x.rule === 'sheet-provide-coverage');
    expect(w.map((x) => x.symbol)).toEqual(['kid__gds', 'kdi__gm']);
    expect(w[0].message).toMatch(/block "kid" does not provide/);
    expect(w[1].message).toMatch(/no block is named "kdi"/);
  });

  it('says so when a sheet with no givens claims to expose a name that does not exist', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'L', value: 1e-6 }],
      equations: [{ name: 'Rout', expr: '1/kid__gds' }],
      checks: [],
      blocks: [{ name: 'kid', doc: boundDoc({ provides: ['gds'] }) }],
      // L and Rout are declared right here and T and w come from the table metadata; R_out is
      // a typo for the equation and exposes nothing.
      provides: ['Rout', 'L', 'T', 'w', 'R_out'],
    };
    const w = validateSheet(doc).filter((x) => x.rule === 'sheet-provide-coverage');
    expect(w.map((x) => x.location)).toEqual(['R_out']);
    expect(w[0].message).toMatch(/nothing of that name exists to expose/);
  });

  it('lets a sheet that sizes a device name any table quantity it exposes', () => {
    // Sizing publishes the whole table at the operating point, and a table may carry columns
    // no static list knows about — so a sizing sheet's provides are taken at their word. The
    // upward half of the check still catches a parent reading a name the child never provides.
    const doc = boundDoc({ provides: ['gds', 'W', 'some_foundry_column'] });
    expect(validateSheet(doc).filter((x) => x.rule === 'sheet-provide-coverage')).toEqual([]);
  });

  it('follows a grandchild re-export through both separators', () => {
    const grand = boundDoc({ provides: ['id'] });
    const mid: SheetDoc = {
      title: 'm',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'g', doc: grand }],
      provides: ['g__id'],
    };
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      equations: [
        { name: 'a', expr: 'm__g__id' }, // re-exported all the way up — resolves
        { name: 'b', expr: 'm__g__gm' }, // the grandchild provides id only
      ],
      checks: [],
      blocks: [{ name: 'm', doc: mid }],
    };
    const w = validateSheet(doc).filter((x) => x.rule === 'sheet-provide-coverage');
    expect(w.map((x) => x.symbol)).toEqual(['m__g__gm']);
  });

  it('says nothing about names under a ref-only block, whose provides arrive at resolution', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      equations: [{ name: 'a', expr: 'later__gm + later__whatever' }],
      checks: [],
      blocks: [{ name: 'later', ref: 'stages/cs-amp-resistive-load' }],
    };
    expect(validateSheet(doc).filter((x) => x.rule === 'sheet-provide-coverage')).toEqual([]);
  });

  it('recurses into a child and attributes its structural error to the block', () => {
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [{ name: 'p', value: Number.NaN }], // non-finite param ⇒ child structural error
      equations: [],
      checks: [],
    };
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'kid', doc: child }],
    };
    const w = validateSheet(doc);
    expect(w.some((x) => x.rule === 'sheet-param' && x.message.includes('block "kid":'))).toBe(
      true,
    );
  });
});

describe('table temperature in the sheet scope', () => {
  const tDoc: SheetDoc = {
    title: 't',
    polarity: 'n',
    params: [],
    equations: [{ name: 'tk', expr: 'T' }],
    checks: [],
  };

  it('seeds T from the table so temperature-aware author math tracks the data', () => {
    const hot = { ...dev, meta: { ...dev.meta, temp: 125 } };
    expect(evaluateSheet(tDoc, hot).values.tk).toBeCloseTo(398.15, 12);
  });

  it('falls back to the 27 °C engine default without a table (or at default temp)', () => {
    expect(evaluateSheet(tDoc).values.tk).toBeCloseTo(300.15, 12);
    expect(evaluateSheet(tDoc, dev).values.tk).toBeCloseTo(300.15, 12);
  });

  it('a same-named author param deliberately wins over the seeded constant', () => {
    const doc: SheetDoc = { ...tDoc, params: [{ name: 'T', value: 42 }] };
    const hot = { ...dev, meta: { ...dev.meta, temp: 125 } };
    expect(evaluateSheet(doc, hot).values.tk).toBe(42);
  });
});

describe('fail-closed hardening', () => {
  it('a non-finite tolPct reads na (never pass) and the validator names it', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [
        { name: 'a', value: 1000 },
        { name: 'b', value: 1 },
      ],
      equations: [],
      checks: [{ id: 'eq', kind: 'spec', lhs: 'a', op: '==', rhs: 'b', tolPct: NaN }],
    };
    const res = evaluateSheet(doc);
    expect(res.checks[0].status).toBe('na');
    expect(res.feasible).toBe(false);
    const pre = validateSheet(doc);
    expect(pre.some((w) => w.rule === 'sheet-tol' && w.severity === 'error')).toBe(true);
  });

  it('snaps a floating-point-noise margin to zero: a spec parked on its boundary reads amber deterministically', () => {
    // 0.1 + 0.2 overshoots 0.3 by ~5.5e-17 in doubles; without the snap this check's
    // verdict is a coin flip on the rounding direction of the two sides.
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'x', value: 0.3 }],
      equations: [{ name: 'y', expr: '0.1 + 0.2' }],
      checks: [{ id: 'parked', kind: 'spec', lhs: 'x', op: '>=', rhs: 'y' }],
    };
    const res = evaluateSheet(doc);
    expect(res.checks[0].margin).toBe(0);
    expect(res.checks[0].status).toBe('amber');
    expect(res.feasible).toBe(true);
  });

  it('an equation that computes non-finite from resolved inputs is an error, even if only an advisory check reads it', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'x', value: -1 }],
      equations: [{ name: 'bad', expr: 'sqrt(x)' }],
      checks: [{ id: 'g', kind: 'advisory', lhs: 'bad', op: '>=', rhs: '0' }],
    };
    const res = evaluateSheet(doc);
    expect(res.warnings.some((w) => w.rule === 'sheet-nonfinite' && w.severity === 'error')).toBe(
      true,
    );
    expect(res.feasible).toBe(false);
  });

  it('an unphysical given (negative gm) fails closed instead of sizing a negative width', () => {
    const doc = boundDoc({ givens: { L: 'L', gm: '0 - 1e-3', gm_id: 'gm_id', vds: '0.6' } });
    const res = evaluateSheet(doc, dev);
    expect(res.sizing?.ok).toBe(false);
    expect(res.values.W).toBeUndefined();
    expect(res.feasible).toBe(false);
  });

  it('sweeping a param whose stored default is non-finite does not poison the sweep', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'k', value: NaN, min: 1, max: 2 }],
      equations: [],
      checks: [{ id: 'r', kind: 'spec', lhs: 'k', op: '>=', rhs: '0.5' }],
    };
    const sw = sweepSheet(doc, 'k', undefined, 3);
    expect(sw.x).toHaveLength(3);
    expect(sw.feasible).toEqual([true, true, true]);
  });
});

describe('bias declared in the givens (vds/vsb)', () => {
  // A demo table with a live vds axis — sizing must collapse it to a point first.
  const dev3 = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });

  it('a declared vds slices the table at that point and is reported', () => {
    const doc = boundDoc({
      givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
    });
    const res = evaluateSheet(doc, dev3);
    expect(res.sizing?.ok).toBe(true);
    expect(res.sizing?.bias).toEqual({ vds: 0.6 });
    // equals sizing on a hand-sliced table
    const ref = sizeBound(fixTable(dev3, { vds: 0.6 }));
    expect(res.sizing?.W).toBeCloseTo(ref.W, 12);
    expect(res.values.gds).toBeCloseTo(ref.quantities.gds, 15);
  });

  it('the declaration accepts an expression over params', () => {
    const doc = boundDoc({
      params: [...boundDoc().params, { name: 'vds_op', value: 0.6 }],
      givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: 'vds_op' },
    });
    const res = evaluateSheet(doc, dev3);
    expect(res.sizing?.ok).toBe(true);
    expect(res.sizing?.bias).toEqual({ vds: 0.6 });
  });

  it('an undeclared vds fails closed and flags the axis for the in-place fixer', () => {
    const res = evaluateSheet(given({}), dev3); // no drain voltage stated
    expect(res.sizing?.ok).toBe(false);
    expect(res.sizing?.error).toMatch(/^the givens state no drain voltage/);
    expect(res.sizing?.needs).toEqual(['vds']);
    expect(res.feasible).toBe(false);
  });

  it('an undeclared body bias (vsb) defaults to 0 — the body-grounded case sizes cleanly', () => {
    // A table with BOTH a vds and a vsb axis; declare only vds and let vsb default.
    const dev4 = generateDemoDevice({
      vds: { min: 0, max: 1.2, step: 0.3 },
      vsb: { min: 0, max: 0.6, step: 0.2 },
    });
    const doc = boundDoc({
      givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
    });
    const res = evaluateSheet(doc, dev4);
    expect(res.sizing?.ok).toBe(true);
    expect(res.sizing?.bias).toEqual({ vds: 0.6, vsb: 0 });
    expect(res.sizing?.needs).toBeUndefined();
  });

  it('an undeclared vsb fails closed (not a silent clamp) when the table never characterizes 0', () => {
    // A back-biased-only table: the vsb sweep starts above 0, so "body-grounded" is unavailable.
    const dev4 = generateDemoDevice({
      vds: { min: 0, max: 1.2, step: 0.3 },
      vsb: { min: 0.2, max: 0.6, step: 0.2 },
    });
    const doc = boundDoc({
      givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
    });
    const res = evaluateSheet(doc, dev4);
    expect(res.sizing?.ok).toBe(false);
    expect(res.sizing?.needs).toEqual(['vsb']);
    expect(res.sizing?.error).toMatch(/the table has that axis and sizing must fix it at a value$/);
    expect(res.feasible).toBe(false);
  });

  it('a declaration the table cannot honor (no vds sweep) refuses the device, with the reason', () => {
    const doc = boundDoc({
      givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
    });
    const res = evaluateSheet(doc, generateDemoDevice()); // sweeps only l and vgs: no vds axis
    // Not sized on the table as it stands: that would answer for whatever drain voltage the
    // table happened to be taken at, under a report that says 0.6 V.
    expect(res.sizing?.ok).toBe(false);
    expect(res.sizing?.bias).toBeUndefined();
    expect(res.feasible).toBe(false);
    expect(res.sizing?.error).toMatch(/given vds = 0\.6/);
    expect(res.sizing?.error).toMatch(/no vds sweep/);
    // A failed sizing like any other: one error on the givens, carrying the same words.
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([
      { rule: 'sheet-givens', severity: 'error', message: res.sizing?.error, location: 'givens' },
    ]);
    // And nothing is read off the table as it is any more.
    expect(res.warnings.some((w) => /as-is/.test(w.message))).toBe(false);
  });

  it('an out-of-hull declaration is clamped with a warning, mirroring the L policy', () => {
    const doc = boundDoc({
      givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '5' },
    });
    const res = evaluateSheet(doc, dev3);
    expect(res.sizing?.ok).toBe(true);
    expect(res.warnings.some((w) => /outside the table's vds range/.test(w.message))).toBe(true);
  });

  it('a child fails closed on its own undeclared bias — the parent never lends it one', () => {
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'cs', doc: given({}, { provides: ['id'] }) }], // child's givens omit vds
    };
    const res = evaluateSheet(parent, dev3);
    expect(res.blocks?.[0].feasible).toBe(false);
    expect(res.blocks?.[0].sizing?.needs).toEqual(['vds']);
    expect(res.feasible).toBe(false);
    // The one error is the child's, under its block's name.
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([
      {
        rule: 'sheet-givens',
        severity: 'error',
        message: `block "cs": ${res.blocks?.[0].sizing?.error}`,
        location: 'cs.givens',
      },
    ]);
    expect(res.blocks?.[0].sizing?.error).toMatch(/^the givens state no drain voltage/);
  });

  it('a child that declares its own vds sizes cleanly through composition', () => {
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        {
          name: 'cs',
          doc: boundDoc({
            givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
            provides: ['id'],
          }),
        },
      ],
    };
    const res = evaluateSheet(parent, dev3);
    expect(res.blocks?.[0].feasible).toBe(true);
    expect(res.blocks?.[0].sizing?.bias).toEqual({ vds: 0.6 });
    expect(res.values.cs__id).toBeGreaterThan(0);
  });
});

describe('a device is sized only on a table that carries what its givens use', () => {
  // The rule, branch by branch. For each of vds, vsb and L that the givens state:
  //  - the table SWEEPS the axis: read where the given says, as before;
  //  - the table has the axis with ONE value: that is where it was taken, and the device is
  //    sized there when the given states that value and refused when it states another;
  //  - the table has NO such axis: a missing vsb column is a body-grounded characterization
  //    (vsb = 0), a missing vds column says nothing at all.
  // A refusal is a failed sizing — an error on the givens and a report that is not ok — never
  // numbers with a warning beside them.
  //
  // The drain voltage is always stated, as `vds` or as a diode connection: a device whose givens
  // state neither is not sized on any of those tables, and its report asks for `vds`.
  const errorsOf = (res: SheetResult): string[] =>
    res.warnings.filter((w) => w.severity === 'error').map((w) => w.message);
  /** Refused: not sized, fails closed, and the one error is the sizing's own reason. */
  const expectRefused = (res: SheetResult, ...says: RegExp[]): void => {
    expect(res.sizing?.ok).toBe(false);
    expect(Number.isNaN(res.sizing?.W)).toBe(true);
    expect(res.feasible).toBe(false);
    expect(errorsOf(res)).toEqual([res.sizing?.error]);
    for (const re of says) expect(res.sizing?.error).toMatch(re);
  };
  /** Sized with nothing said about it — no warning, no error, no note. */
  const expectSilent = (res: SheetResult): void => {
    expect(res.sizing?.ok, res.sizing?.error).toBe(true);
    expect(res.warnings).toEqual([]);
  };

  // One table per shape. A sweep written with min = max generates an axis with a single node —
  // the shape a file holding one drain voltage (or one body bias) on every row imports to. The
  // tables that are about the body bias sweep the drain voltage, so a device can state one.
  const VDS = { min: 0, max: 1.2, step: 0.3 };
  const noVds = generateDemoDevice();
  const vdsSwept = generateDemoDevice({ vds: VDS });
  const vdsOnce = generateDemoDevice({ vds: { min: 0.6, max: 0.6, step: 0.1 } });
  const vsbOnce = generateDemoDevice({ vds: VDS, vsb: { min: 0.3, max: 0.3, step: 0.1 } });
  const vsbZero = generateDemoDevice({ vds: VDS, vsb: { min: 0, max: 0, step: 0.1 } });
  const bothSwept = generateDemoDevice({ vds: VDS, vsb: { min: 0, max: 0.6, step: 0.3 } });

  it('the fixtures have the shapes the cases below name', () => {
    const axes = (t: DeviceTable): string =>
      t.grid.axes.map((a) => `${a.name}×${a.values.length}`).join(' ');
    expect(axes(noVds)).toBe('l×4 vgs×121');
    expect(axes(vdsOnce)).toBe('l×4 vds×1 vgs×121');
    expect(axes(vsbOnce)).toBe('l×4 vds×5 vsb×1 vgs×121');
    expect(axes(vsbZero)).toBe('l×4 vds×5 vsb×1 vgs×121');
    expect(axes(vdsSwept)).toBe('l×4 vds×5 vgs×121');
    expect(axes(bothSwept)).toBe('l×4 vds×5 vsb×3 vgs×121');
  });

  describe('a drain voltage the givens do not state', () => {
    // Neither a `vds` nor a diode connection. What the table holds makes no difference: a sweep
    // cannot be collapsed without a value, and a table taken at one drain voltage, or with no
    // vds column, would answer from a point nobody wrote down.
    for (const [shape, table] of [
      ['sweeps vds', vdsSwept],
      ['was taken at one drain voltage', vdsOnce],
      ['has no vds column', noVds],
    ] as const) {
      it(`is not sized on a table that ${shape}, and the report asks for vds`, () => {
        const res = evaluateSheet(given({}), table);
        expectRefused(res, /^the givens state no drain voltage, so the device is not sized/);
        // What to state, both ways of stating it.
        expect(res.sizing?.error).toMatch(
          /give vds, or declare a diode connection \(diode: true\)/,
        );
        expect('W' in res.values).toBe(false);
        // Asked for, so the fix can be offered in place — and not a refusal of the table, which
        // is a verdict only a stated drain voltage can earn.
        expect(res.sizing?.needs).toEqual(['vds']);
        expect(res.sizing?.unswept).toBeUndefined();
      });
    }

    it('says the same on every table, in the words validation uses', () => {
      const said = [vdsSwept, vdsOnce, noVds].map((t) => evaluateSheet(given({}), t).sizing?.error);
      expect(new Set(said).size).toBe(1);
      expect(validateSheet(given({})).map((w) => w.message)).toEqual([said[0]]);
    });

    it('is still unstated beside a body bias, or a diode connection switched off', () => {
      for (const extra of [{ vsb: '0' }, { diode: false }]) {
        const res = evaluateSheet(given(extra), vdsSwept);
        expectRefused(res, /^the givens state no drain voltage/);
        expect(res.sizing?.needs).toEqual(['vds']);
      }
    });

    it('is stated by a vds or by a diode connection, and the device then sizes', () => {
      expectSilent(evaluateSheet(given({ vds: '0.6' }), vdsSwept));
      const diode = evaluateSheet(given({ diode: true }), vdsSwept);
      expect(diode.sizing?.ok, diode.sizing?.error).toBe(true);
      expect(diode.sizing?.needs).toBeUndefined();
    });
  });

  describe('an axis the table sweeps', () => {
    it('is read where the given says, exactly as before', () => {
      const res = evaluateSheet(given({ vds: '0.6', vsb: '0.3' }), bothSwept);
      expectSilent(res);
      expect(res.sizing?.bias).toEqual({ vds: 0.6, vsb: 0.3 });
      // The same numbers as the table sliced by hand at that point.
      const ref = sizeBound(fixTable(bothSwept, { vds: 0.6, vsb: 0.3 }));
      expect(res.sizing?.W).toBe(ref.W);
      expect(res.sizing?.vgs).toBe(ref.vgs);
    });

    it('still clamps a value past the swept range with a warning — a clamp, not a refusal', () => {
      const res = evaluateSheet(given({ vds: '0.6', vsb: '0.9' }), bothSwept);
      expect(res.sizing?.ok).toBe(true);
      expect(res.sizing?.bias).toEqual({ vds: 0.6, vsb: 0.6 });
      expect(res.sizing?.clamped).toEqual(['vsb']);
      expect(errorsOf(res)).toEqual([]);
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0].severity).toBe('warning');
      expect(res.warnings[0].message).toMatch(/given vsb 0\.9 is outside the table's vsb range/);
    });
  });

  describe('an axis the table has with a single value', () => {
    it('sizes a device given that value, silently, on the table as it stands', () => {
      const res = evaluateSheet(given({ vds: '0.6' }), vdsOnce);
      expectSilent(res);
      // Nothing was sliced, so nothing is reported as sliced; and the answer is the one the
      // sizer gives on that same table, read as it stands.
      expect(res.sizing?.bias).toBeUndefined();
      const ref = sizeBound(vdsOnce);
      expect(res.sizing?.W).toBe(ref.W);
      expect(res.sizing?.vgs).toBe(ref.vgs);

      // The same on the body-bias axis: only the swept drain voltage is sliced.
      const body = evaluateSheet(given({ vds: '0.6', vsb: '0.3' }), vsbOnce);
      expectSilent(body);
      expect(body.sizing?.bias).toEqual({ vds: 0.6 });
    });

    it('takes float rounding for the value it was aiming at', () => {
      // 0.4 + 0.2 is one ULP above 0.6, and 0.1 + 0.2 one above 0.3.
      expect(0.4 + 0.2).not.toBe(0.6);
      expectSilent(evaluateSheet(given({ vds: '0.4 + 0.2' }), vdsOnce));
      expectSilent(evaluateSheet(given({ vds: '0.6', vsb: '0.1 + 0.2' }), vsbOnce));
    });

    it('refuses a device given any other value', () => {
      expectRefused(
        evaluateSheet(given({ vds: '0.9' }), vdsOnce),
        /given vds = 0\.9/,
        /no vds sweep/,
      );
      // A source tied to its body is no better off on a table taken with the body biased.
      expectRefused(
        evaluateSheet(given({ vds: '0.6', vsb: '0' }), vsbOnce),
        /given vsb = 0 /,
        /no vsb sweep/,
      );
      // Close is not equal: a millivolt away is a different operating point, and so is ten
      // nanovolts — the allowance is float rounding, nothing wider.
      expectRefused(evaluateSheet(given({ vds: '0.601' }), vdsOnce), /given vds = 0\.601/);
      expectRefused(evaluateSheet(given({ vds: '0.6 + 1e-8' }), vdsOnce), /no vds sweep/);
    });

    it('quotes the value the author wrote, not the float it rounded to', () => {
      expect(String(0.1 + 0.2)).toBe('0.30000000000000004');
      const res = evaluateSheet(given({ vds: '0.1 + 0.2' }), vdsOnce);
      expectRefused(res, /given vds = 0\.3 asks/, /a vds sweep that covers 0\.3,/);
    });

    it('holds a signed axis to its signed value', () => {
      // A PMOS export keeps its swept axes signed: taken at vds = -0.6, it answers for -0.6.
      const pmos = signedMirrorDemo(vdsOnce);
      expect([...pmos.grid.axes.find((a) => a.name === 'vds')!.values]).toEqual([-0.6]);
      expectSilent(evaluateSheet(given({ vds: '-0.6' }), pmos));
      expectSilent(evaluateSheet(given({ vds: '-(0.4 + 0.2)' }), pmos));
      expectRefused(
        evaluateSheet(given({ vds: '0.6' }), pmos),
        /given vds = 0\.6 asks/,
        /a single value, vds = -0\.6\)/,
      );
    });

    it('takes a zero reached through volt-scale arithmetic for zero', () => {
      // A supply expression cancels to zero only up to rounding at the size of its terms, which
      // is larger than rounding at zero itself.
      expect(Math.abs(3.3 - 1.1 * 3)).toBeGreaterThan(Number.EPSILON);
      const body = (vsb: string): SheetDoc => given({ vds: '0.6', vsb });
      expectSilent(evaluateSheet(body('3.3 - 1.1*3'), vsbZero));
      expectSilent(evaluateSheet(body('3.3 - 1.1*3'), vdsSwept));
      // A microvolt is not rounding.
      expectRefused(evaluateSheet(body('1e-6'), vsbZero), /given vsb = 0\.000001/);
      expectRefused(evaluateSheet(body('1e-6'), vdsSwept), /given vsb = 0\.000001/);
    });

    it('asks for a body bias the givens leave out when the table was taken away from the default', () => {
      // Left out, vsb takes its default — a source at the body. A table taken at vsb = 0.3 on
      // every row does not answer for that, and sizing on it as it stands would put the device
      // at a body bias nobody wrote down. So the author states it, and deleting a correct
      // `vsb` line can never turn a refusal into a result.
      const res = evaluateSheet(boundDoc(), vsbOnce);
      expect(res.sizing?.ok).toBe(false);
      expect(res.feasible).toBe(false);
      expect(res.sizing?.needs).toEqual(['vsb']);
      expect(errorsOf(res)).toEqual([res.sizing?.error]);
      expect(res.sizing?.error).toMatch(/^declare the operating point \(vsb\) in the givens/);
      expect(res.sizing?.error).toMatch(/taken at vsb = 0\.3, not at the default vsb = 0$/);
      // A declaration answers it, so it is not a refusal: stated where the table was taken, the
      // device sizes; stated at the body, the table cannot give it.
      expect(res.sizing?.unswept).toBeUndefined();
      expectSilent(evaluateSheet(given({ vds: '0.6', vsb: '0.3' }), vsbOnce));
      expectRefused(evaluateSheet(given({ vds: '0.6', vsb: '0' }), vsbOnce), /no vsb sweep/);
      // A table taken AT the default needs nothing said.
      expectSilent(evaluateSheet(boundDoc(), vsbZero));

      // Beside a drain voltage that is also left out, both are asked for, each in its words.
      const both = evaluateSheet(given({}), vsbOnce);
      expect(both.sizing?.needs).toEqual(['vds', 'vsb']);
      expect(errorsOf(both)).toEqual([both.sizing?.error]);
      expect(both.sizing?.error).toMatch(/^the givens state no drain voltage/);
      expect(both.sizing?.error).toMatch(
        /; declare the operating point \(vsb\) in the givens — the table was taken at vsb = 0\.3,/,
      );
    });
  });

  describe('a table with no vsb column', () => {
    it('is taken as characterized with the source at the body: vsb = 0 sizes silently', () => {
      const res = evaluateSheet(given({ vds: '0.6', vsb: '0' }), vdsSwept);
      expectSilent(res);
      // Only the drain voltage was sliced, and the answer is the one a device that says nothing
      // about its body gets.
      expect(res.sizing?.bias).toEqual({ vds: 0.6 });
      expect(res.sizing?.W).toBe(evaluateSheet(boundDoc(), vdsSwept).sizing?.W);
      // An expression that rounds to a few ULP off zero is still a source at the body.
      expect(0.3 - (0.1 + 0.2)).not.toBe(0);
      expectSilent(evaluateSheet(given({ vds: '0.6', vsb: '0.3 - (0.1 + 0.2)' }), vdsSwept));
    });

    it('refuses a device whose source sits above its body', () => {
      expectRefused(
        evaluateSheet(given({ vds: '0.6', vsb: '0.3' }), vdsOnce),
        /given vsb = 0\.3/,
        /no vsb sweep/,
      );
      // The drain sweep being there does not stand in for the body sweep.
      expectRefused(
        evaluateSheet(given({ vds: '0.6', vsb: '0.3' }), vdsSwept),
        /given vsb = 0\.3/,
        /no vsb sweep/,
      );
    });
  });

  describe('a table with no vds column', () => {
    it('refuses a device given a drain voltage — there is no default to take it at', () => {
      const res = evaluateSheet(given({ vds: '0.6' }), noVds);
      expectRefused(res, /given vds = 0\.6/, /no vds sweep/);
      expect(res.sizing?.unswept).toEqual(['vds']);
      expect(res.sizing?.needs).toBeUndefined();
      // Zero is a drain voltage like any other: nothing says the table was taken there.
      expectRefused(evaluateSheet(given({ vds: '0' }), noVds), /given vds = 0 /, /no vds sweep/);
    });

    it('sizes no device at all: stated, the drain voltage is refused; left out, it is asked for', () => {
      // So no design sheet sizes a device from such a table. The sizer on its own still does —
      // it is handed a table and reads it as it stands.
      for (const extra of [{ vds: '0.6' }, { diode: true }, {}, { vsb: '0' }])
        expect(evaluateSheet(given(extra), noVds).sizing?.ok).toBe(false);
      expect(sizeBound(noVds).W).toBeGreaterThan(0);
    });

    it('refuses a diode connection, which is read along a sweep the table does not have', () => {
      expectRefused(
        evaluateSheet(given({ diode: true }), noVds),
        /diode connection/,
        /no vds sweep/,
      );
      // One characterized drain voltage is one point of the diagonal, not the diagonal.
      expectRefused(
        evaluateSheet(given({ diode: true }), vdsOnce),
        /diode connection/,
        /no vds sweep/,
      );
      // With the sweep, the same givens size.
      expect(evaluateSheet(given({ diode: true }), vdsSwept).sizing?.ok).toBe(true);
    });
  });

  it('says everything the table lacks in one refusal', () => {
    const res = evaluateSheet(given({ vds: '0.6', vsb: '0.3' }), noVds);
    expectRefused(res, /given vds = 0\.6/, /no vds sweep/, /given vsb = 0\.3/, /no vsb sweep/);
  });

  it('keeps an axis that still needs declaring on offer beside a refusal', () => {
    // These givens leave the drain voltage out, and ask for a body bias the table has no sweep
    // for. No declaration would make the table answer, so the refusal is the error; the axis to
    // declare still rides along for the in-place fixer — whatever the table holds on it.
    for (const table of [vdsSwept, vdsOnce, noVds]) {
      const res = evaluateSheet(given({ vsb: '0.3' }), table);
      expectRefused(res, /^given vsb = 0\.3/, /no vsb sweep/);
      expect(res.sizing?.unswept).toEqual(['vsb']);
      expect(res.sizing?.needs).toEqual(['vds']);
    }
  });

  describe('the length', () => {
    const oneLength = generateDemoDevice({ lengths: [0.5e-6], vds: VDS });

    it('on a table taken at one length: that length sizes silently, any other is refused', () => {
      expect(oneLength.grid.axes.find((a) => a.name === 'l')?.values).toHaveLength(1);
      const at = (L: number): SheetResult =>
        evaluateSheet(
          boundDoc({
            params: boundDoc().params.map((p) => (p.name === 'L' ? { ...p, value: L } : p)),
          }),
          oneLength,
        );
      const same = at(0.5e-6);
      expectSilent(same);
      expect(same.sizing?.W).toBe(evaluateSheet(boundDoc(), dev).sizing?.W);
      // One name for the length throughout, the one the givens use.
      expectRefused(
        at(1e-6),
        /given L = 0\.000001/,
        /no length sweep \(a single value, L = 5e-7\)/,
      );
    });

    it('on a table that sweeps length: a length past the range is still clamped with a warning', () => {
      const res = evaluateSheet(
        boundDoc({
          params: boundDoc().params.map((p) => (p.name === 'L' ? { ...p, value: 5e-6 } : p)),
        }),
        dev,
      );
      expect(res.sizing?.ok).toBe(true);
      expect(res.sizing?.clamped).toEqual(['l']);
      expect(errorsOf(res)).toEqual([]);
      expect(res.warnings.some((w) => /outside the table's L range/.test(w.message))).toBe(true);
    });

    it('sizes on the length nodes it reads, and judges and quotes the length against them all', () => {
      // The engine cuts a table to the one or two length nodes a length reads before it slices
      // the bias axes. The warning about a length off the table still names the table's whole
      // range — not the single node the cut kept — and the numbers are the uncut table's.
      const lengths = dev.grid.axes.find((a) => a.name === 'l')!.values;
      expect(lengths.length).toBeGreaterThan(2);
      const lo = lengths[0];
      const hi = lengths[lengths.length - 1];
      const at = (L: number): SheetResult =>
        evaluateSheet(
          boundDoc({
            params: boundDoc().params.map((p) => (p.name === 'L' ? { ...p, value: L } : p)),
          }),
          dev,
        );
      const direct = (L: number) =>
        sizeDevice({ table: devAt, L, gm: 2 * Math.PI * 10e6 * 2e-12, gm_id: 12 });
      for (const L of [hi * 2.5, lo / 2]) {
        const res = at(L);
        expect(res.sizing?.clamped).toEqual(['l']);
        const said = res.warnings.filter((w) => /outside the table's L range/.test(w.message));
        expect(said.map((w) => w.message)).toEqual([
          `requested L ${L} m is outside the table's L range [${lo}, ${hi}] m; clamped to the nearest characterized length`,
        ]);
        expect(direct(L).warnings).toContain(said[0].message);
        expect(res.sizing?.W).toBe(direct(L).W);
      }
      // Between two nodes, and on one: no warning, and the uncut table's numbers to the bit.
      for (const L of [0.77e-6, 0.5e-6]) {
        const res = at(L);
        expect(res.sizing?.clamped).toBeUndefined();
        expect(res.warnings.some((w) => /L range/.test(w.message))).toBe(false);
        expect(res.sizing?.W).toBe(direct(L).W);
        expect(res.sizing?.vgs).toBe(direct(L).vgs);
        expect(res.values.gm_gds).toBe(direct(L).quantities.gm_gds);
      }
    });

    it('on a table with no length axis: the sizing fails in the lookup, as it always has', () => {
      // Nothing on such a table records a length — no axis, and no metadata the importer reads
      // — so there is no value to hold the given against. The lookup has always refused it.
      const noLength = fixTable(dev, { l: 0.5e-6 });
      expect(noLength.grid.axes.map((a) => a.name)).toEqual(['vds', 'vgs']);
      const res = evaluateSheet(boundDoc(), noLength);
      expect(res.sizing?.ok).toBe(false);
      expect(res.feasible).toBe(false);
      expect(res.sizing?.error).toMatch(/table has no "l" axis/);
    });
  });

  describe('in a composed sheet', () => {
    // Two devices on one table. `pair` stands on a node the parent names; `load` is tied to
    // its body. Only the first uses the body-bias sweep.
    const device = (source: string): SheetDoc => ({
      title: 'device',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'I', value: 20e-6 },
        { name: 'V_s', value: 0 },
      ],
      givens: { L: 'L', id: 'I', gm_id: '12', vds: '0.6', vsb: source },
      equations: [],
      checks: [],
      provides: ['id', 'vstar'],
    });
    const composed = (over: Partial<SheetDoc> = {}): SheetDoc =>
      notACircuit({
        title: 'pair on a tail node',
        polarity: 'n',
        params: [{ name: 'V_tail', value: 0.3, unit: 'V', class: 'independent' }],
        equations: [],
        checks: [
          { id: 'pair-headroom', kind: 'physical', lhs: 'pair__vstar', op: '>=', rhs: '0.1' },
          { id: 'load-headroom', kind: 'physical', lhs: 'load__vstar', op: '>=', rhs: '0.1' },
        ],
        blocks: [
          { name: 'pair', doc: device('V_s'), params: { V_s: 'V_tail' } },
          { name: 'load', doc: device('0') },
        ],
        ...over,
      });

    it('a refused block fails the sheet closed and is named; the other block still sizes', () => {
      const res = runSheet(composed(), vdsSwept);
      expect(res.feasible).toBe(false);
      const [pair, load] = res.blocks!;
      expect(pair.feasible).toBe(false);
      expect(pair.sizing?.ok).toBe(false);
      expect(load.feasible).toBe(true);
      expect(load.sizing?.ok).toBe(true);
      // One error, attributed to the block, in the sizing's own words.
      expect(errorsOf(res)).toEqual([`block "pair": ${pair.sizing?.error}`]);
      expect(errorsOf(res)[0]).toMatch(/block "pair": given vsb = 0\.3/);
      expect(errorsOf(res)[0]).toMatch(/no vsb sweep/);
      // What the refused block would have provided is withheld, so the check that reads it has
      // nothing to judge — it is not passed on a stale or invented number.
      expect('pair__vstar' in res.values).toBe(false);
      expect(res.checks.find((c) => c.id === 'pair-headroom')?.status).toBe('na');
      expect(res.checks.find((c) => c.id === 'load-headroom')?.status).toBe('pass');
    });

    it('the same sheet runs on a table that carries the sweep', () => {
      const res = runSheet(composed(), bothSwept);
      expect(errorsOf(res)).toEqual([]);
      expect(res.feasible).toBe(true);
      expect(res.blocks?.map((b) => b.sizing?.bias)).toEqual([
        { vds: 0.6, vsb: 0.3 },
        { vds: 0.6, vsb: 0 },
      ]);
    });

    it('a sheet that does not use the missing sweep still runs on that table', () => {
      const res = runSheet(
        composed({ params: [{ name: 'V_tail', value: 0, unit: 'V', class: 'independent' }] }),
        vdsSwept,
      );
      expect(res.warnings.filter((w) => w.rule === 'sheet-givens')).toEqual([]);
      expect(res.feasible).toBe(true);
    });

    it('at a range end that asks for the missing sweep, the held design has no answer', () => {
      // Sized with the tail node at the body, where the table answers. The claimed range then
      // lifts the node: that end asks the table for a body bias it does not carry, so it is
      // neither a pass nor a failure — and the end that stays at the body is still answered.
      const doc = composed({
        params: [{ name: 'V_tail', value: 0, unit: 'V', class: 'independent' }],
        operatingRange: [
          { name: 'tail-up', set: { V_tail: '0.3' } },
          { name: 'tail-down', set: { V_tail: '0' } },
        ],
      });
      const res = runSheet(doc, vdsSwept);
      expect(errorsOf(res)).toEqual([]);
      expect(res.feasible).toBe(true);
      const [up, down] = res.rangeEnds!;
      expect(up.state).toBe('no-answer');
      expect(up.error).toMatch(/block "pair": given vsb = 0\.3/);
      expect(up.error).toMatch(/no vsb sweep/);
      expect(down.state).toBe('complies');
      expect(down.error).toBeUndefined();
      expect(res.complies).toBe(false);

      // On a table with the sweep both ends are answered.
      const full = runSheet(doc, bothSwept);
      expect(full.rangeEnds?.map((e) => e.state)).toEqual(['complies', 'complies']);
      expect(full.complies).toBe(true);
    });

    it('holds a block to the table that block is bound to', () => {
      const onItsOwn = (doc: SheetDoc): SheetDoc => ({
        ...doc,
        blocks: doc.blocks!.map((b) => (b.name === 'pair' ? { ...b, device: 'own' } : b)),
      });
      const resolveTo =
        (t: DeviceTable) =>
        (id: string): DeviceTable | undefined =>
          id === 'own' ? t : undefined;
      // The sheet's table has the body-bias sweep; the pair's own table does not.
      const lacking = runSheet(onItsOwn(composed()), bothSwept, resolveTo(vdsSwept));
      expect(lacking.blocks?.map((b) => b.sizing?.ok)).toEqual([false, true]);
      expect(lacking.blocks?.[0].sizing?.unswept).toEqual(['vsb']);
      expect(errorsOf(lacking)).toEqual([`block "pair": ${lacking.blocks?.[0].sizing?.error}`]);
      // The other way round, the sheet's table would refuse it and the pair's own answers.
      const carried = runSheet(onItsOwn(composed()), vdsSwept, resolveTo(bothSwept));
      expect(errorsOf(carried)).toEqual([]);
      expect(carried.feasible).toBe(true);
    });

    it('says a device was not sized where that is why a constrained node did not evaluate', () => {
      // The engine searches the tail node in its range. Everywhere in it the pair's source sits
      // above its body, which this table cannot answer for — so no range would do, and the
      // solver's message carries the refusal as its reason.
      const constrainedTail = composed({
        params: [
          {
            name: 'V_tail',
            value: 0.3,
            unit: 'V',
            min: 0.2,
            max: 0.4,
            designConstraint: { lhs: 'pair__vstar', rhs: '0.15' },
          },
        ],
      });
      const solve = (res: SheetResult): string[] =>
        res.warnings
          .filter((w) => w.rule === 'sheet-solve' && w.severity === 'error')
          .map((w) => w.message);
      const [said, ...rest] = solve(runSheet(constrainedTail, vdsSwept));
      expect(rest).toEqual([]);
      expect(said).toMatch(
        /^solved param "V_tail" in \[0\.2, 0\.4\] V did not settle: nothing of the range could be evaluated: pair__vstar - \(0\.15\) does not evaluate at either end of it or at its middle — block "pair": given vsb = 0\.2 asks/,
      );
      // With the device sized, an end that does not evaluate is stepped past: sqrt(V_tail - 0.3)
      // first evaluates at 0.3, and reads 0.1 at V_tail = 0.31.
      const stepped = runSheet(
        composed({
          params: [
            {
              name: 'V_tail',
              value: 0.3,
              unit: 'V',
              min: 0.2,
              max: 0.4,
              designConstraint: { lhs: 'sqrt(V_tail - 0.3)', rhs: '0.1' },
            },
          ],
        }),
        bothSwept,
      );
      expect(solve(stepped)).toEqual([]);
      expect(stepped.values.V_tail).toBeCloseTo(0.31, 5);
    });

    it('gives no answer where a held node would be followed onto a body bias the table lacks', () => {
      // A device whose source node is held under its gate: sized with the node at the body, and
      // re-solved at each range end with the gate where the sizing put it. Less current lowers
      // the gate-source voltage, so the node rises — off the one body bias this table was
      // taken at. Stepping in from the top of the range finds nothing but the body itself
      // that evaluates — which shows nothing about the rest of the range, so the solve says it did
      // not settle, and why: a device was not sized anywhere above it. The end is unanswered
      // rather than failed.
      const follower = notACircuit({
        title: 'follower',
        polarity: 'n',
        params: [
          { name: 'L', value: 0.5e-6 },
          { name: 'I', value: 20e-6, unit: 'A' },
          { name: 'X', value: 0, unit: 'V', min: 0, max: 0.4, hold: 'X + vgs' },
        ],
        givens: { L: 'L', id: 'I', gm_id: '12', vds: '0.6', vsb: 'X' },
        equations: [],
        checks: [],
        operatingRange: [{ name: 'less-current', set: { I: '5e-6' } }],
      });
      const res = runSheet(follower, vdsSwept);
      expect(errorsOf(res)).toEqual([]);
      expect(res.feasible).toBe(true);
      const [end] = res.rangeEnds!;
      expect(end.state).toBe('no-answer');
      const solve = end.warnings.filter((w) => w.rule === 'sheet-solve' && w.severity === 'error');
      expect(solve.map((w) => w.message)).toEqual([
        expect.stringMatching(
          /^held param "X" in \[0, 0\.4\] V did not settle: nothing of the range but X = 0 V could be evaluated, and X \+ vgs - \(\S+\) reads \S+ there — the relation does not evaluate above X = 0 V: given vsb = 0\.0015625 asks for a body bias the table cannot give/,
        ),
      ]);
      expect(end.error).toBe(solve[0].message);
      // On a table with the sweep the same end is answered.
      expect(runSheet(follower, bothSwept).rangeEnds?.[0].state).toBe('complies');
    });

    it('gives no answer at a range end with a refused device, whatever else failed there', () => {
      // At `both` the pair is refused AND the load, held at its width, is asked for a thousand
      // times its current — more than its table reaches. Alone, that second failure is a verdict
      // on the design. Beside a device that was never sized it is not, and which of the two the
      // run reports last depends only on the order the blocks are written in.
      const [pair, load] = composed().blocks!;
      const driven = { ...load, params: { I: 'I_load' } };
      const doc = (blocks: NonNullable<SheetDoc['blocks']>): SheetDoc =>
        composed({
          params: [
            { name: 'V_tail', value: 0, unit: 'V', class: 'independent' },
            { name: 'I_load', value: 20e-6, unit: 'A' },
          ],
          blocks,
          operatingRange: [
            { name: 'load-only', set: { I_load: '20e-3' } },
            { name: 'both', set: { V_tail: '0.3', I_load: '20e-3' } },
          ],
        });
      for (const blocks of [
        [pair, driven],
        [driven, pair],
      ]) {
        const res = runSheet(doc(blocks), vdsSwept);
        expect(errorsOf(res)).toEqual([]);
        const [loadOnly, both] = res.rangeEnds!;
        expect(loadOnly.state).toBe('does-not-comply');
        expect(loadOnly.error).toMatch(/cannot carry its current/);
        expect(both.state).toBe('no-answer');
        expect(both.error).toMatch(/^block "pair": given vsb = 0\.3 asks/);
        expect(both.error).not.toMatch(/cannot carry its current/);
      }
    });
  });
});

describe('composition semantics (ratified)', () => {
  /** A minimal providing leaf: sizes at a fixed current and exposes its outputs. */
  const leaf = (I: string): SheetDoc => ({
    title: 'leaf',
    polarity: 'n',
    params: [
      { name: 'I_bias', value: 20e-6 },
      { name: 'L', value: 0.5e-6 },
      { name: 'gm_id', value: 12 },
    ],
    givens: { L: 'L', id: I, gm_id: 'gm_id', vds: '0.6' },
    equations: [],
    checks: [],
    provides: ['id', 'gm', 'W'],
  });

  it('a LATER sibling may reference an EARLIER sibling provide (document order)', () => {
    const doc = notACircuit({
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        { name: 'a', doc: leaf('I_bias') },
        { name: 'b', doc: leaf('I_bias'), params: { I_bias: 'a__id / 2' } },
      ],
    });
    const res = runSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(res.values.b__id).toBeCloseTo(res.values.a__id / 2, 12);
    // the ratified direction produces no validator noise
    expect(validateSheet(doc).some((w) => w.rule === 'sheet-block-param')).toBe(false);
  });

  it('a FORWARD sibling reference fails closed at eval and is named statically by the validator', () => {
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        { name: 'b', doc: leaf('I_bias'), params: { I_bias: 'a__id / 2' } },
        { name: 'a', doc: leaf('I_bias') },
      ],
    };
    const res = runSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.blocks?.[0].feasible).toBe(false);
    expect(
      validateSheet(doc).some(
        (w) => w.rule === 'sheet-block-param' && /document order/.test(w.message),
      ),
    ).toBe(true);
  });

  it('a child referencing the parent SIZED device fails closed (reverse coupling stays off)', () => {
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'gm_id', value: 12 },
        { name: 'I_bias', value: 20e-6 },
      ],
      givens: { L: 'L', id: 'I_bias', gm_id: 'gm_id', vds: '0.6' },
      equations: [],
      checks: [],
      blocks: [{ name: 'c', doc: leaf('I_bias'), params: { I_bias: 'W * 1e-3' } }],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.blocks?.[0].feasible).toBe(false); // W is sized AFTER children — not in scope
    expect(res.feasible).toBe(false);
  });

  it('duplicate block names are skipped fail-closed even via the unvalidated entrypoint', () => {
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        { name: 'a', doc: leaf('I_bias') },
        { name: 'a', doc: leaf('I_bias / 2') },
      ],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.blocks?.[1].feasible).toBe(false);
    // the first block's provides are intact, not overwritten by the duplicate
    expect(res.values.a__id).toBeCloseTo(20e-6, 18);
  });

  it('re-exporting a grandchild provide is warning-free; a stray separator key still warns', () => {
    const mid: SheetDoc = {
      title: 'mid',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'g', doc: leaf('I_bias') }],
      provides: ['g__id'],
    };
    const top: SheetDoc = {
      title: 'top',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'm', doc: mid }],
    };
    expect(validateSheet(top).filter((w) => w.rule === 'sheet-provide')).toHaveLength(0);
    const res = runSheet(top, dev);
    expect(res.values.m__g__id).toBeCloseTo(20e-6, 18);
    // a separator key that matches nothing injectable is still flagged
    const bad: SheetDoc = { ...top, blocks: [{ name: 'm', doc: { ...mid, provides: ['x__y'] } }] };
    expect(validateSheet(bad).some((w) => w.rule === 'sheet-provide')).toBe(true);
  });

  it('a composed sweep traces descendant HARD checks with path-prefixed ids', () => {
    const cascode = EXAMPLES.find((e) => e.title === 'NMOS cascode (gain-boosted output)')!;
    const sw = sweepSheet(cascode, 'gm_id', devBias, 5);
    const ids = sw.checks.map((r) => r.id);
    expect(ids).toContain('cs-headroom'); // top-level check, untouched
    expect(ids).toContain('cs.feasible-inversion'); // the child's own physical check, path-prefixed
    const child = sw.checks.find((r) => r.id === 'cs.feasible-inversion')!;
    expect(child.marginPct.filter((m) => m !== null).length).toBeGreaterThan(0);
  });
});

describe('a solve starved by a SIBLING is not accused of failing', () => {
  // The evaluation budget is shared so nesting cannot multiply the work without bound. The cost
  // of that is real: a solve that NESTS another re-solves the child on every one of its own
  // probes, and the product can spend the pool before a later sibling probes at all. What must
  // not happen is the innocent sibling being told IT has no solution — an author would go and
  // rewrite a sheet that is fine.
  const solved = (name: string, blocks?: SheetDoc['blocks']): SheetDoc => ({
    title: name,
    polarity: 'n',
    params: [{ name: 'x', value: 1, min: 0, max: 2, solveFor: 'fx' }],
    equations: [{ name: 'fx', expr: '0.1*x^3 + 1' }],
    checks: [],
    provides: ['fx'],
    ...(blocks ? { blocks } : {}),
  });
  let eater = solved('eater');
  for (let i = 0; i < 6; i++) eater = solved('eater', [{ name: `sub${i}`, doc: eater }]);

  const res = evaluateSheet(
    {
      title: 'root',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [
        { name: 'eater', doc: eater },
        // Alone this lands in a handful of probes.
        { name: 'victim', doc: solved('victim') },
      ],
    },
    dev,
  );
  const victim = res.warnings.find(
    (w) => w.rule === 'sheet-solve' && w.message.startsWith('block "victim"'),
  )?.message;

  it('is told the budget went elsewhere, not that it has no solution or did not settle', () => {
    // The message must not ACCUSE a specific spender: an expensive sibling and a solve nesting
    // this one under its probes are indistinguishable here.
    expect(victim).toBeDefined();
    expect(victim).toMatch(/evaluation budget \(\d+ evaluations\) ran out/);
    expect(victim).toMatch(/It was not shown to be unsolvable/);
    expect(victim).not.toMatch(/has no solution/);
    expect(victim).not.toMatch(/did not settle in/);
  });

  it('solves alone', () => {
    expect(evaluateSheet(solved('victim'), dev).feasible).toBe(true);
  });

  it('is evaluated again, and told the budget ran out, when it was read back earlier at plenty', () => {
    // The same child, with the same inputs, before and after the eater. The first is evaluated;
    // the second could be read back, but the budget can no longer pay for what evaluating it
    // costs, so it is evaluated again and stops where a fresh evaluation stops — reading the
    // first result back would report a solve this tree has no budget left to make.
    const victim = solved('victim');
    const twice = evaluateSheet(
      {
        title: 'root',
        polarity: 'n',
        params: [],
        equations: [],
        checks: [],
        blocks: [
          { name: 'first', doc: victim },
          { name: 'eater', doc: eater },
          { name: 'again', doc: victim },
        ],
      },
      dev,
    );
    const said = (name: string) =>
      twice.warnings.filter(
        (w) => w.rule === 'sheet-solve' && w.message.startsWith(`block "${name}"`),
      );
    expect(said('first')).toEqual([]);
    expect(twice.blocks![0].solve).toEqual({ kind: 'settled' });
    expect(said('again')).toHaveLength(1);
    expect(said('again')[0].message).toMatch(/evaluation budget \(\d+ evaluations\) ran out/);
  });
});

describe('a composed child read back from its tree', () => {
  // A parent search evaluates its blocks again on every probe; a block whose inputs did not move
  // is read back from what the tree evaluated before, and reading it back costs no evaluation.
  // A child whose input is the parent's own solved param is asked for again at the points a
  // search probes first, whichever parent search asks — so a nest of four of them, which used to
  // spend the whole budget, now settles on the evaluations it actually makes.
  const level = (k: number): SheetDoc => {
    const reads = k < 3 ? `(c${k}__X*0.5 + IN*0.3)` : '(0.2 + IN/3)';
    return {
      title: `L${k}`,
      polarity: 'n',
      params: [
        { name: 'IN', value: 0.5 },
        {
          name: 'X',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: {
            lhs: 'exp(4*X) + X^3',
            rhs: `exp(4*${reads}*0.9) + (${reads}*0.9)^3`,
          },
        },
      ],
      blocks: k < 3 ? [{ name: `c${k}`, doc: level(k + 1), params: { IN: 'X' } }] : [],
      equations: [],
      checks: [],
      provides: ['X'],
    };
  };

  it('settles a nest that re-asks its children the same questions, every level verified', () => {
    const res = evaluateSheet(level(0), dev);
    expect(res.solve).toEqual({ kind: 'settled' });
    expect(res.feasible).toBe(true);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    let blocks = res.blocks;
    for (let k = 0; k < 3; k++) {
      expect(blocks![0].solve).toEqual({ kind: 'settled' });
      blocks = blocks![0].blocks;
    }
  });
});

describe('duplicate check ids', () => {
  it('are a validation error — results are keyed by id, so one would shadow the other', () => {
    // Two checks named "same": indexTreeResults Map.set-collapses them, the sweep charts one
    // curve where two exist, and bindingCheck can name the WRONG worst check.
    const doc: SheetDoc = {
      title: 'dup',
      polarity: 'n',
      params: [{ name: 'a', value: 1 }],
      equations: [],
      checks: [
        { id: 'same', kind: 'spec', lhs: 'a', op: '>=', rhs: '100' },
        { id: 'same', kind: 'spec', lhs: 'a', op: '>=', rhs: '1' },
      ],
    };
    expect(
      validateSheet(doc).some(
        (w) => w.severity === 'error' && /duplicate check id "same"/.test(w.message),
      ),
    ).toBe(true);
  });
});

describe('bindingCheck — naming the cause of one verdict', () => {
  const ex = EXAMPLES.find((e) => e.title === 'NMOS noise & matching')!;
  // Force the noise spec check to fail hard, and the matching one to fail harder.
  const at = (o: Record<string, number>): SheetDoc => ({
    ...ex,
    params: ex.params.map((p) => (o[p.name] !== undefined ? { ...p, value: o[p.name] } : p)),
  });

  it('names the worst-margin failing hard check, ignoring advisory checks', () => {
    const res = runSheet(at({ vn_target: 1e-12, vos_target: 1e-9 }), devBias);
    expect(res.feasible).toBe(false);
    const b = bindingCheck(res);
    const named = res.checks.find((r) => r.id === b?.id);
    expect(named?.status).toBe('fail');
    expect(isHardCheck(named!.kind)).toBe(true);
    // It is the WORST one, not merely a failing one.
    const worst = Math.min(
      ...res.checks
        .filter((r) => isHardCheck(r.kind) && r.status === 'fail')
        .map((r) => r.marginPct),
    );
    expect(b?.marginPct).toBe(worst);
  });

  it('is undefined when no hard check fails — never a feasibility verdict of its own', () => {
    expect(bindingCheck(runSheet(ex, devBias))).toBeUndefined();
    // A tree with no checks at all is the degenerate case, not an error.
    expect(bindingCheck({ checks: [] })).toBeUndefined();
  });

  it('attributes a block check by its block path, and outranks a milder top-level one', () => {
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [{ name: 'x', value: 1 }],
      equations: [],
      // Fails by 90%: the worst check in the tree, and it lives below the top sheet.
      checks: [{ id: 'child-floor', kind: 'physical', lhs: 'x', op: '>=', rhs: '10' }],
      provides: [],
    };
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [{ name: 'y', value: 9 }],
      equations: [],
      // Fails by only 10%, so a walk that stopped at the top would name this one.
      checks: [{ id: 'top-floor', kind: 'spec', lhs: 'y', op: '>=', rhs: '10' }],
      blocks: [{ name: 'k', doc: child }],
    };
    const b = bindingCheck(runSheet(parent, dev));
    expect(b?.id).toBe('k.child-floor');
    expect(b?.marginPct).toBeCloseTo(-0.9, 6);
  });
});

describe('sweepSheet2 — the design-plane feasibility map', () => {
  const ex = EXAMPLES.find((e) => e.title === 'NMOS noise & matching')!;

  it('agrees pointwise with runSheet and names the binding hard check per infeasible cell', () => {
    const sw = sweepSheet2(ex, 'gm_id', 'L', devBias, 5);
    expect(sw.x).toHaveLength(5);
    expect(sw.y).toHaveLength(5);
    for (const [yi, xi] of [
      [0, 0],
      [2, 2],
      [4, 4],
      [0, 4],
    ] as const) {
      const at: SheetDoc = {
        ...ex,
        params: ex.params.map((p) =>
          p.name === 'gm_id'
            ? { ...p, value: sw.x[xi] }
            : p.name === 'L'
              ? { ...p, value: sw.y[yi] }
              : p,
        ),
      };
      const ref = runSheet(at, devBias);
      expect(sw.feasible[yi][xi]).toBe(ref.feasible);
      if (!ref.feasible && sw.binding[yi][xi] !== null) {
        // the named binding check really is a failing hard check at that point
        const named = ref.checks.find((r) => r.id === sw.binding[yi][xi]);
        expect(named?.status).toBe('fail');
        expect(named?.kind).not.toBe('advisory');
      }
    }
    // the map is not degenerate: both regions exist on this example
    const flat = sw.feasible.flat();
    expect(flat.some((f) => f)).toBe(true);
    expect(flat.some((f) => !f)).toBe(true);
  });

  it('returns an empty map for identical or unbounded params', () => {
    expect(sweepSheet2(ex, 'gm_id', 'gm_id', dev, 5).x).toHaveLength(0);
    expect(sweepSheet2(ex, 'gm_id', 'I_bias', dev, 5).x).toHaveLength(0); // I_bias has no min/max
  });
});

describe('override and bias reporting fail closed (adversarial review regressions)', () => {
  it('a misspelled child override key fails the composition closed, never the child default', () => {
    const child: SheetDoc = {
      title: 'leaf',
      polarity: 'n',
      params: [
        { name: 'I_bias', value: 20e-6 },
        { name: 'L', value: 0.5e-6 },
        { name: 'gm_id', value: 12 },
      ],
      givens: { L: 'L', id: 'I_bias', gm_id: 'gm_id', vds: '0.6' },
      equations: [],
      checks: [],
      provides: ['id'],
    };
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [{ name: 'I_tail', value: 40e-6 }],
      equations: [],
      checks: [],
      blocks: [{ name: 'cs', doc: child, params: { I_bais: 'I_tail / 2' } }], // typo: I_bais
    };
    const res = runSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.blocks?.[0].feasible).toBe(false);
    expect(res.values.cs__id).toBeUndefined(); // provides withheld, not the 20µA default
    expect(
      res.warnings.some(
        (w) => w.rule === 'sheet-block-param' && w.severity === 'error' && /I_bais/.test(w.message),
      ),
    ).toBe(true);
    // and the validator names it statically as an error too
    expect(
      validateSheet(doc).some((w) => w.rule === 'sheet-block-param' && w.severity === 'error'),
    ).toBe(true);
  });

  it('an out-of-range given bias reports the APPLIED clamped coordinate, not the request', () => {
    const dev3 = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });
    const doc = boundDoc({
      givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '5' },
    });
    const res = evaluateSheet(doc, dev3);
    expect(res.sizing?.ok).toBe(true);
    expect(res.sizing?.bias).toEqual({ vds: 1.2 }); // the slice actually used
    expect(res.warnings.some((w) => /vds 5 is outside/.test(w.message))).toBe(true);
  });
});

describe('diode-connected givens', () => {
  const diodeDoc = (extra: Record<string, unknown> = {}): SheetDoc =>
    notACircuit({
      title: 'd',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'I', value: 10e-6 },
        { name: 'gm_id', value: 10 },
      ],
      givens: { L: 'L', id: 'I', gm_id: 'gm_id', diode: true, ...extra },
      equations: [],
      checks: [],
    });

  it('lands on the vds = vgs diagonal, matching a fixed slice taken at the answer', () => {
    const res = runSheet(diodeDoc(), devBias);
    expect(res.sizing?.ok).toBe(true);
    const vgs = res.sizing!.vgs;
    // Re-size the SAME device with vds pinned to the drop the diagonal produced. If the fold is
    // right the two agree; a diagonal that silently used some other vds would not.
    const fixed = runSheet(
      {
        ...diodeDoc(),
        params: [...diodeDoc().params, { name: 'v', value: vgs }],
        givens: { L: 'L', id: 'I', gm_id: 'gm_id', vds: 'v' },
      },
      devBias,
    );
    expect(fixed.sizing?.ok).toBe(true);
    const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30);
    expect(rel(fixed.sizing!.vgs, vgs)).toBeLessThan(1e-3);
    expect(rel(fixed.sizing!.W, res.sizing!.W)).toBeLessThan(1e-3);
  });

  it('reports no single vds coordinate, because the diagonal has none', () => {
    // The applied vds moves with vgs across the fold, so one number in the report would be a
    // coordinate that is true nowhere. It must not be silently invented either.
    const res = runSheet(diodeDoc(), devBias);
    expect(res.sizing?.bias?.vds).toBeUndefined();
    expect(res.sizing?.assumed ?? []).not.toContain('vds');
  });

  it('reports the coordinate it SAMPLED at, and says so when the diagonal had to clamp', () => {
    // Where the vgs sweep runs past the characterized vds range the fold reads the table's edge.
    // Reporting the raw vgs there would name an operating point the quantities beside it were
    // never measured at — a silent repair, which is precisely what this project does not do.
    const wide = makeGrid(
      [
        { name: 'vds', values: new Float64Array([0.2, 0.5, 0.8]) },
        { name: 'vgs', values: new Float64Array([0.2, 0.5, 0.8, 1.1]) },
      ],
      new Map([
        ['gm', Float64Array.from({ length: 12 }, (_, k) => [0.2, 0.5, 0.8][Math.floor(k / 4)])],
      ]),
    );
    const fold = diodeGrid(wide);
    expect(fold.clamped).toBe(true);
    const vds = fold.grid.quantities.get('vds')!;
    const gm = fold.grid.quantities.get('gm')!;
    // At vgs = 1.1 the axis stops at 0.8: both the coordinate and the data say 0.8.
    expect(vds[3]).toBeCloseTo(0.8, 12);
    expect(gm[3]).toBeCloseTo(0.8, 12);
    // And a table whose vds covers the whole vgs sweep does not claim a clamp.
    const covered = makeGrid(
      [
        { name: 'vds', values: new Float64Array([0.2, 0.5, 0.8, 1.1]) },
        { name: 'vgs', values: new Float64Array([0.2, 0.5, 0.8, 1.1]) },
      ],
      new Map([['gm', new Float64Array(16)]]),
    );
    expect(diodeGrid(covered).clamped).toBe(false);
  });

  it('refuses givens that declare both the connection and a vds', () => {
    const errs = validateSheet(diodeDoc({ vds: '0.5' })).filter((w) => w.severity === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/both a diode connection and a vds/);
  });

  it('refuses the device when the table has no vds sweep to read the diagonal from', () => {
    // The connection is read where vds = vgs. A table with no vds column has no diagonal at all,
    // and one taken at a single drain voltage meets it at one gate voltage only — neither can
    // answer, and the table as it stands would be a different connection.
    const oneDrain = generateDemoDevice({ vds: { min: 0.9, max: 0.9, step: 0.1 } });
    expect(oneDrain.grid.axes.find((a) => a.name === 'vds')?.values).toHaveLength(1);
    for (const table of [withoutColumns(fixTable(dev, { vds: 0.9 }), []), oneDrain]) {
      const res = runSheet(diodeDoc(), table);
      expect(res.sizing?.ok).toBe(false);
      expect(res.feasible).toBe(false);
      expect(res.sizing?.error).toMatch(/diode connection/);
      expect(res.sizing?.error).toMatch(/no vds sweep/);
      expect(
        res.warnings.some((w) => w.severity === 'error' && w.message === res.sizing?.error),
      ).toBe(true);
      expect(res.warnings.some((w) => /as-is/.test(w.message))).toBe(false);
    }
  });
});

describe('constrained params — a one-unknown search inside the stated range', () => {
  const mk = (
    expr: string,
    constraint: { lhs: string; rhs: string },
    bounds: { min?: number; max?: number } = { min: 0, max: 10 },
  ): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    params: [
      { name: 'x', value: 1, ...bounds, designConstraint: constraint },
      { name: 'T', value: 5 },
    ],
    equations: [{ name: 'y', expr }],
    checks: [],
  });

  // Precision below is SOLVE_TOL_REL x the range's span (1e-6 x 10): the root lands anywhere
  // inside the final bracket, so 4 digits is what a volt-scale range honestly guarantees.
  it('inverts an increasing relation to the root, from no starting guess at all', () => {
    const res = evaluateSheet(mk('2*x + 1', { lhs: 'y', rhs: 'T' }), dev);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(2, 4);
  });

  it('handles a DECREASING relation identically — the search only needs a sign change', () => {
    const res = evaluateSheet(mk('9 - x', { lhs: 'y', rhs: 'T' }), dev);
    expect(res.values.x).toBeCloseTo(4, 4);
  });

  it('accepts a correct root written in RESIDUAL form (rhs = 0)', () => {
    // The residual scale is the relation's range over the searched range, not |lhs| at the root —
    // scaling by |lhs| rejected every design constraint whose lhs IS the residual (it vanishes at
    // the root).
    const res = evaluateSheet(mk('2*x + 1', { lhs: 'y - T', rhs: '0' }), dev);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(2, 4);
  });

  it('closes on a root at ZERO — the width test is span-relative, not iterate-relative', () => {
    // A width test relative to |lo|,|hi| never fires when the root is 0 (the ratio stays ~1
    // while the width shrinks); a symmetric node whose answer is 0 V is not exotic.
    const doc = mk('2*x', { lhs: 'y', rhs: 'T' }, { min: -10, max: 9.5 });
    doc.params[1].value = 0; // T = 0 → root at x = 0, deliberately off the first midpoint
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(0, 4);
  });

  it('still refuses a jump riding a large DC offset', () => {
    // Scaling the residual by |lhs| (~1e6 here) would call a 10-unit step "converged".
    const doc = mk('1e6 + (x < 3 ? 0 : 10)', { lhs: 'y', rhs: 'T' });
    doc.params[1].value = 1000005;
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(
      /steps across the target/,
    );
  });

  it('fails closed on a HALF-WRITTEN design constraint instead of silently freezing the param', () => {
    // {lhs} without {rhs} fails the constrained() shape guard: without this check the param would be
    // neither swept nor solved — stuck at its authored value with the sheet reading feasible.
    const doc = mk('2*x + 1', { lhs: 'y' } as unknown as { lhs: string; rhs: string });
    expect(
      validateSheet(doc).some(
        (w) => w.severity === 'error' && /design constraint needs both lhs and rhs/.test(w.message),
      ),
    ).toBe(true);
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(
      res.warnings.some((w) => /design constraint needs both lhs and rhs/.test(w.message)),
    ).toBe(true);
  });

  it('fails closed when the range does not straddle the target', () => {
    const res = evaluateSheet(mk('x + 20', { lhs: 'y', rhs: 'T' }), dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(
      /does not change sign/,
    );
  });

  it('refuses a JUMP: the bracket closes but nothing in it produces the target', () => {
    // A discontinuity steps across the target; the search converges to the step, and shipping
    // that point would size the design at an operating point that does not exist.
    const res = evaluateSheet(mk('x < 3 ? 0 : 10', { lhs: 'y', rhs: 'T' }), dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(
      /steps across the target/,
    );
  });

  it('steps in from a range end where the relation does not evaluate, and finds the root there', () => {
    // sqrt(x - 1) does not evaluate below x = 1, so the low end of [0, 10] says the design has no
    // operating point there, not that the search failed. The search halves its way in to the
    // nearest point that evaluates and searches what is left: sqrt(x - 1) = 0.5 at x = 1.25.
    const res = evaluateSheet(mk('sqrt(x - 1)', { lhs: 'y', rhs: '0.5' }), dev);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(1.25, 4);
  });

  it('reports the range it actually searched, and why an end moved', () => {
    // No x in [0, 10] gives sqrt(x - 1) = 5. Eight halvings from 0 toward 10 find the nearest
    // point that evaluates on a grid of 10/2^8: 1.015625, the first point of it above 1. The
    // message quotes that range and the reason the low end moved.
    const res = evaluateSheet(mk('sqrt(x - 1)', { lhs: 'y', rhs: '5' }), dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve').map((w) => w.message)).toEqual([
      'solved param "x" found no solution in the searched range [1.015625, 10] (the relation ' +
        'does not evaluate below x = 1.015625: equation "y" evaluated to a non-finite number from ' +
        'resolved inputs): y - (5) does not change sign across it (-4.875e+0 at 1.015625, ' +
        '-2.000e+0 at 10) — none, or an even number, of roots there. Move or widen min/max to ' +
        'bracket one, or the relation does not reach its target on this table',
    ]);
  });

  it('is not sweepable, and its min/max are the search range rather than slider bounds', () => {
    const p = mk('2*x + 1', { lhs: 'y', rhs: 'T' }).params[0];
    expect(sweepable(p)).toBe(false);
  });

  it('validation refuses a missing range and a constrained param that also carries solveFor', () => {
    const noBracket = mk('2*x + 1', { lhs: 'y', rhs: 'T' }, {});
    expect(
      validateSheet(noBracket).some(
        (w) => w.severity === 'error' && /the range it is searched in/.test(w.message),
      ),
    ).toBe(true);
    const both: SheetDoc = {
      ...noBracket,
      params: [
        {
          name: 'x',
          value: 1,
          min: 0,
          max: 1,
          designConstraint: { lhs: 'y', rhs: 'T' },
          solveFor: 'y',
        },
        { name: 'T', value: 5 },
      ],
    };
    expect(
      validateSheet(both).some(
        (w) => w.severity === 'error' && /keep one relation/.test(w.message),
      ),
    ).toBe(true);
  });

  /** Two design constraints on one sheet. `z` is written first, so document order is the wrong
   *  solve order. */
  const pair = (zConstraint: { lhs: string; rhs: string }): SheetDoc => ({
    title: 'pair',
    polarity: 'n',
    params: [
      { name: 'z', value: 1, min: 0, max: 10, designConstraint: zConstraint },
      { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'a', rhs: 'T' } },
      { name: 'T', value: 5 },
    ],
    equations: [
      { name: 'a', expr: '2*x + 1' },
      { name: 'b', expr: 'a + z' },
      { name: 'c', expr: 'x - z' },
    ],
    checks: [],
  });

  it('solves two design constraints one after the other when one relation reads the other constrained param', () => {
    // a = 2x + 1 = T = 5 gives x = 2. b = a + z = 8 then gives z = 3. The second relation reads
    // x through a, the first reads no z, so x is solved first whatever the document order. Solved
    // the other way round, z would be fitted against the unsolved a = 3 and land on 5, leaving
    // b = 10.
    const doc = pair({ lhs: 'b', rhs: '8' });
    expect(validateSheet(doc).filter((w) => w.severity === 'error')).toEqual([]);
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(2, 4);
    expect(res.values.z).toBeCloseTo(3, 4);
    expect(res.values.b).toBeCloseTo(8, 4);
  });

  it('settles two solved params that depend on each other by repeated sweeps, to the closed form', () => {
    // x is constrained to 1 + 0.01*y and y solves for 2 + 0.01*x: one design constraint and one
    // solveFor, the one kind of solved param, each reading the other. Together
    // x = (1 + 0.02)/(1 - 0.0001) and y = 2 + 0.01*x. A single pass of one search each leaves x
    // fitted against a y that then moved by about 0.01, so only repeated sweeps reach it.
    const doc: SheetDoc = {
      title: 'pair',
      polarity: 'n',
      params: [
        { name: 'x', value: 1, min: 0, max: 4, designConstraint: { lhs: 'x', rhs: '1 + 0.01*y' } },
        { name: 'y', value: 7, min: 0, max: 4, solveFor: 'fy' },
      ],
      equations: [{ name: 'fy', expr: '2 + 0.01*x' }],
      checks: [],
    };
    expect(validateSheet(doc).filter((w) => w.severity === 'error')).toEqual([]);
    const res = evaluateSheet(doc, dev);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    expect(res.feasible).toBe(true);
    const x = 1.02 / 0.9999;
    expect(Math.abs(res.values.x - x)).toBeLessThanOrEqual(1e-5);
    expect(Math.abs(res.values.y - (2 + 0.01 * x))).toBeLessThanOrEqual(1e-5);
  });

  it('reports a pair too strongly dependent to settle, naming both and the last move', () => {
    // x - (c*x - s*y + 1) and y - (s*x + c*y + 1), with c = 0.9 cos 0.9 and s = 0.9 sin 0.9, have
    // one answer — x = (1 - c - s)/((1 - c)^2 + s^2), y = (1 - c + s)/((1 - c)^2 + s^2) — but each
    // one-unknown search moves its own unknown by s/(1 - c), about 1.6 times the other's last move,
    // so the sweeps grow instead of settling. Outcome 3: the members did not settle, never a
    // value presented as an answer. (The substitution solver this engine replaced converged this
    // pair; repeating one-unknown searches a fixed number of times does not, and says so.)
    const C = 0.9 * Math.cos(0.9);
    const S = 0.9 * Math.sin(0.9);
    const doc: SheetDoc = {
      title: 'rotating',
      polarity: 'n',
      params: [
        { name: 'x', value: 3, min: -1000, max: 1000, unit: 'V', solveFor: 'fx' },
        { name: 'y', value: -2, min: -1000, max: 1000, unit: 'V', solveFor: 'fy' },
      ],
      equations: [
        { name: 'fx', expr: `${C}*x - ${S}*y + 1` },
        { name: 'fy', expr: `${S}*x + ${C}*y + 1` },
      ],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    const solve = res.warnings.filter((w) => w.rule === 'sheet-solve').map((w) => w.message);
    expect(solve).toEqual([
      expect.stringMatching(
        new RegExp(
          `^solved params "x" in \\[-1000, 1000\\] V and "y" in \\[-1000, 1000\\] V did not ` +
            `settle in ${SOLVE_SWEEPS} sweeps: in the last one ` +
            `[xy] still moved by \\S+ V — they depend on each other too strongly`,
        ),
      ),
    ]);
    // The answer exists, inside both ranges; it is the method that did not reach it, which is what
    // the message says — so this is outcome 3, never "no solution".
    const det = (1 - C) ** 2 + S ** 2;
    const [x, y] = [(1 - C - S) / det, (1 - C + S) / det];
    expect([Math.abs(x) < 1000, Math.abs(y) < 1000]).toEqual([true, true]);
    expect(Math.abs(x - (C * x - S * y + 1))).toBeLessThan(1e-12);
    expect(Math.abs(y - (S * x + C * y + 1))).toBeLessThan(1e-12);
  });

  /** A parent's design constraint over a child's: P + c__Q = 1 above, Q = A/2 below, A wired by the
   *  parent. */
  const nested = (wireA: string): SheetDoc => ({
    title: 'parent',
    polarity: 'n',
    params: [
      { name: 'P', value: 0.5, min: 0, max: 1, designConstraint: { lhs: 'P + c__Q', rhs: '1' } },
      { name: 'A0', value: 0.8 },
    ],
    equations: [],
    checks: [],
    blocks: [
      {
        name: 'c',
        params: { A: wireA },
        doc: {
          title: 'child',
          polarity: 'n',
          provides: ['Q'],
          params: [
            { name: 'Q', value: 0.5, min: 0, max: 1, designConstraint: { lhs: 'Q', rhs: 'A/2' } },
            { name: 'A', value: 0 },
          ],
          equations: [],
          checks: [],
        },
      },
    ],
  });

  it("solves a child's design constraint inside its parent's when the child does not read the parent", () => {
    // A = 0.8 is fixed, so Q = 0.4 whatever P is, and P = 1 - Q = 0.6: a triangular pair.
    const res = evaluateSheet(nested('A0'), dev);
    expect(res.feasible).toBe(true);
    expect(res.values.c__Q).toBeCloseTo(0.4, 4);
    expect(res.values.P).toBeCloseTo(0.6, 4);
  });

  it("solves a parent's and a child's design constraints that depend on each other, across levels", () => {
    // Wire A = P and the child's Q = P/2 reads the parent's unknown while the parent's
    // P = 1 - Q reads the child's. The child solves Q inside every probe of P, which is exact:
    // P + P/2 = 1, so P = 2/3 and Q = 1/3. Nothing is refused, in validation or in evaluation.
    const doc = nested('P');
    expect(validateSheet(doc).filter((w) => w.severity === 'error')).toEqual([]);
    const res = evaluateSheet(doc, dev);
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(res.feasible).toBe(true);
    expect(res.values.P).toBeCloseTo(2 / 3, 5);
    expect(res.values.c__Q).toBeCloseTo(1 / 3, 5);
  });

  it('solves the parent and child on a sheet that claims a range, too', () => {
    // A range claim sends the base run down a different path, and each range end re-solves both.
    const doc: SheetDoc = { ...nested('P'), operatingRange: [{ name: 'e', set: { A0: '0.9' } }] };
    const res = runSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(res.values.P).toBeCloseTo(2 / 3, 5);
    expect(res.rangeEnds?.map((e) => [e.state, e.solved.P])).toEqual([
      ['complies', expect.closeTo(2 / 3, 5)],
    ]);
  });

  it('names the missing name a relation reads, and does not call it no solution', () => {
    // x is fitted through b = a + z, so it really does wait on z, and z's relation — failing
    // closed on a name it cannot place — waits on x: one set. z's relation reads a name nothing
    // provides: validation has nothing to refuse — a table column could supply it — and the solve
    // says nothing of the range could be evaluated, naming the name. Inside a set that is the set
    // not settling.
    const doc = pair({ lhs: 'z + nope', rhs: '1' });
    doc.params[1] = {
      name: 'x',
      value: 1,
      min: 0,
      max: 10,
      designConstraint: { lhs: 'b', rhs: 'T' },
    };
    expect(validateSheet(doc).filter((w) => w.severity === 'error')).toEqual([]);
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve').map((w) => w.message)).toEqual([
      expect.stringMatching(
        /^solved params "z" in \[0, 10\] and "x" in \[0, 10\] did not settle: solved param "z" in \[0, 10\] did not settle: nothing of the range could be evaluated: z \+ nope - \(1\) does not evaluate at either end of it or at its middle — relation z: "nope" is not defined \(searched with x = 5\)$/,
      ),
    ]);
  });

  it('reports a set whose member reads its own param only through another as not settling — never as no solution', () => {
    // The pair x = 4, e = 8 exists, and the solver this one replaced found it by solving e inside
    // every probe of x. Here each member is searched with its own relation: x is constrained by
    // y = T, but y = fe - x + 1 = 0.5*e + 1 does not move with x while e stands still — it reads x
    // only through e. So x's search, with e at the middle of its range, finds a relation that
    // does not depend on x. Where x was searched depended on where e happened to stand, so the
    // outcome is the SET not settling (with x's reason, and e's value, inside it), not x having
    // no solution. Pairing x with e's relation and e with x's would settle it; the pairing is the
    // author's.
    const doc: SheetDoc = {
      title: 'both',
      polarity: 'n',
      params: [
        { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
        { name: 'e', value: 0, min: 0, max: 20, solveFor: 'fe' },
      ],
      equations: [
        { name: 'fe', expr: '0.5*e + x' },
        { name: 'y', expr: 'fe - x + 1' },
      ],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve').map((w) => w.message)).toEqual([
      expect.stringMatching(
        /^solved params "x" in \[0, 10\] and "e" in \[0, 20\] did not settle: solved param "x" is not determined by its relation: y - \(T\) reads 1\.000e\+0 at both ends of \[0, 10\] and at its middle — it does not appear to depend on x, so no value of it is singled out \(searched with e = 10\)$/,
      ),
    ]);
  });
});

describe('solved params — what the search guarantees', () => {
  /** One constrained param x on [lo, hi] whose relation is y = T, with y the expression given. */
  const one = (expr: string, T: number, lo: number, hi: number, value = 1): SheetDoc => ({
    title: 'one',
    polarity: 'n',
    params: [
      { name: 'x', value, min: lo, max: hi, designConstraint: { lhs: 'y', rhs: 'T' } },
      { name: 'T', value: T },
    ],
    equations: [{ name: 'y', expr }],
    checks: [],
  });
  /** Plain bisection of f on [lo, hi] until the bracket is `width` wide, the midpoint returned —
   *  the method the search replaced, written out so the two can be compared. */
  const bisect = (f: (x: number) => number, lo: number, hi: number, width: number): number => {
    const up = f(lo) < 0;
    while (hi - lo > width) {
      const mid = (lo + hi) / 2;
      if (f(mid) < 0 === up) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  it('lands where bisection does, to the tolerance, on a curved relation', () => {
    // x^3 + x = 3 has one real root; the search's interpolation steps and halving bisection both
    // close on it, the search in far fewer probes. Both answers sit within the final bracket of
    // SOLVE_TOL_REL x the 4-wide range around the same root.
    const res = evaluateSheet(one('x^3 + x', 3, -1, 3), dev);
    expect(res.feasible).toBe(true);
    const ref = bisect((x) => x ** 3 + x - 3, -1, 3, SOLVE_TOL_REL * 4);
    expect(Math.abs(res.values.x - ref)).toBeLessThanOrEqual(2 * SOLVE_TOL_REL * 4);
    // The closed form (Cardano) agrees with both.
    const q = 1.5;
    const root =
      Math.cbrt(q + Math.sqrt(q * q + 1 / 27)) + Math.cbrt(q - Math.sqrt(q * q + 1 / 27));
    expect(Math.abs(res.values.x - root)).toBeLessThanOrEqual(SOLVE_TOL_REL * 4);
  });

  it('does not read the stored value of a constrained param either', () => {
    // A design constraint is searched from its range alone: any stored value, in the range or
    // outside it, gives the same number to the last bit.
    const at = (v: number): number => evaluateSheet(one('x^3 + x', 3, -1, 3, v), dev).values.x;
    const answer = at(1);
    for (const v of [-0.9, 0, 2.9, 100]) expect(at(v)).toBe(answer);
  });

  it("verifies the answer it returns, in the param's terms: a dependency the plan could not see is reported, never returned settled", () => {
    // The param `gm` is overwritten by the sized device's own gm (10 x I) once the device is
    // sized, so A's relation exp(20*A) = exp(10 + 50*gm) reads the device — which reads I — while
    // the structural plan reads the param and sees no edge from A to I. A is searched first, with
    // I at the middle of its range (5.05e-5 A, so A lands at 0.5 + 50*5.05e-4/20 = 0.50126); I
    // then lands at 2e-5 A, which moves A's root to 0.5005. A is 7.6e-4 of its range off — and
    // the relation, an exponential, reads about 3.4e2 there against a whole-range spread of
    // 4.9e8, which a tolerance in the relation's own units would wave through. In the param's
    // terms (its slope at the root times 1e-6 of its range, about 0.45) it is far off, and the
    // solve says it did not settle instead of returning it.
    const doc: SheetDoc = {
      title: 'shadow',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'gm', value: 1 },
        {
          name: 'A',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: { lhs: 'exp(20*A)', rhs: 'exp(10 + 50*gm)' },
        },
        { name: 'I', value: 0, min: 1e-6, max: 1e-4, designConstraint: { lhs: 'I*1e5', rhs: '2' } },
      ],
      givens: { L: 'L', id: 'I', gm_id: '10', vds: '0.6' },
      equations: [],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    const solve = res.warnings.filter((w) => w.rule === 'sheet-solve').map((w) => w.message);
    expect(solve).toEqual([
      expect.stringMatching(
        /^solved param "A" in \[0, 1\] did not settle: read from the final evaluation, exp\(20\*A\) - \(exp\(10 \+ 50\*gm\)\) reads 3\.\d{3}e\+2 against a tolerance of 4\.\d{3}e-1 \(its slope there times 0\.000001 of its range\) — the values it was solved with moved after it landed$/,
      ),
    ]);
  });

  it("settles a dependent pair to its root in the param's terms, even on a steep relation", () => {
    // a: exp(20a) = exp(10 + 0.7b), b: b = 0.3 + 0.01*a, so a = 0.5 + 0.035b and the pair's
    // root is a = (0.5 + 0.035*0.3)/(1 - 0.035*0.01). After two sweeps a still sits about 2.5e-6
    // of its range off that root, which only the tolerance — SOLVE_TOL_REL of the range by the
    // slope — sends round a third sweep: three times looser and the set stops there, short of the
    // 1e-6 a must land within. A tolerance in the relation's units (a fraction of the
    // exponential's spread across the range) let a stop percent-level away.
    const doc: SheetDoc = {
      title: 'steep pair',
      polarity: 'n',
      params: [
        {
          name: 'a',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: { lhs: 'exp(20*a)', rhs: 'exp(10 + 0.7*b)' },
        },
        {
          name: 'b',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: { lhs: 'b', rhs: '0.3 + 0.01*a' },
        },
      ],
      equations: [],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    expect(res.feasible).toBe(true);
    const a = (0.5 + 0.035 * 0.3) / (1 - 0.035 * 0.01);
    expect(Math.abs(res.values.a - a)).toBeLessThanOrEqual(SOLVE_TOL_REL);
    expect(Math.abs(res.values.b - (0.3 + 0.01 * a))).toBeLessThanOrEqual(SOLVE_TOL_REL);
  });

  it('settles a set that needs five sweeps, inside the fixed six', () => {
    // a = 0.05 + k(b - 0.5) and b = 0.95 + k(a - 0.5) with k = 0.2236: each sweep shrinks what is
    // left by k^2 = 0.05, from a start about 0.4 of the range off. Five sweeps settle it; the
    // fixed SOLVE_SWEEPS leaves that margin over the library's worst case of four.
    const k = 0.2236;
    const doc: SheetDoc = {
      title: 'five sweeps',
      polarity: 'n',
      params: [
        {
          name: 'a',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: { lhs: 'a', rhs: `0.05 + ${k}*(b - 0.5)` },
        },
        {
          name: 'b',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: { lhs: 'b', rhs: `0.95 + ${k}*(a - 0.5)` },
        },
      ],
      equations: [],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    expect(res.feasible).toBe(true);
    const a = (0.05 + 0.45 * k - 0.5 * k * k) / (1 - k * k);
    expect(Math.abs(res.values.a - a)).toBeLessThanOrEqual(2 * SOLVE_TOL_REL);
    expect(Math.abs(res.values.b - (0.95 + k * (a - 0.5)))).toBeLessThanOrEqual(2 * SOLVE_TOL_REL);
  });

  it('reads the slope at an exact root from just beside it, not from the bracket around it', () => {
    // A's relation 100(A - r)^3 + 0.01(A - r) is hit exactly at A = r = 0.5 by the search's first
    // halving, while the bracket still spans half the range — across it the slope is 25, at the
    // root it is 0.01. r reads the shadowed `gm` (10 x I, see the verification test), which I
    // then moves, so r ends 1.0e-4 lower and A sits that far off its root. By the slope at the
    // root that is far outside A's tolerance and the solve says it did not settle; by the slope
    // across the bracket it would pass, and a design 1e-4 of the range off would read settled.
    const I0 = (1e-6 + 1e-4) / 2; // where I sits while A is searched: the middle of its range
    const doc: SheetDoc = {
      title: 'exact root',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'gm', value: 1 },
        { name: 'I0', value: I0 },
        {
          name: 'A',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: { lhs: '100*(A - r)^3 + 0.01*(A - r)', rhs: '0' },
        },
        { name: 'I', value: 0, min: 1e-6, max: 1e-4, designConstraint: { lhs: 'I*1e5', rhs: '2' } },
      ],
      givens: { L: 'L', id: 'I', gm_id: '10', vds: '0.6' },
      equations: [{ name: 'r', expr: '0.5 + (gm - 10*I0)/3' }],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.values.A).toBe(0.5);
    expect(res.feasible).toBe(false);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve').map((w) => w.message)).toEqual([
      expect.stringMatching(
        /^solved param "A" in \[0, 1\] did not settle: read from the final evaluation, .* reads 1\.017e-6 against a tolerance of 1\.000e-8/,
      ),
    ]);
  });

  it('settles a solvable set the same way whichever member the document lists first', () => {
    // Each set has one answer inside every range, and in each some member finds nothing on the
    // first sweep while members it reads still sit at the middle of their ranges: a = 2b - 1.5
    // has no root with b at 0.5; V's relation none with s at 0.5 (a tail node and split shaped
    // like the 5T's); sqrt(b - 0.7) does not evaluate at all with b at 0.5; and in the set of
    // three, c = 3a - 0.2 has none with a at 0.5 either. A member that finds nothing is searched
    // again once others have landed, so every order settles, and settles to the rule: each
    // member's relation, read from the result, within SOLVE_TOL_REL of its range (every relation
    // here has a slope of 1 in its own param).
    const P = (name: string, min: number, max: number, lhs: string, rhs: string): SheetVar => ({
      name,
      value: 0,
      min,
      max,
      designConstraint: { lhs, rhs },
    });
    type Case = [SheetVar[], Record<string, (v: Record<string, number>) => number>];
    const cases: Case[] = [
      [
        [P('a', 0, 1, 'a', '2*b - 1.5'), P('b', 0, 1, 'b', '0.8 + 0.001*a')],
        { a: (v) => v.a - (2 * v.b - 1.5), b: (v) => v.b - (0.8 + 0.001 * v.a) },
      ],
      [
        [P('V', 0.1, 0.8, 'V + 0.5*(s - 0.5)*10', '0.9'), P('s', 0, 1, 's', '0.6 + 0.01*V')],
        { V: (v) => v.V + 5 * (v.s - 0.5) - 0.9, s: (v) => v.s - (0.6 + 0.01 * v.V) },
      ],
      [
        [P('a', 0, 1, 'sqrt(b - 0.7) + a', '0.4'), P('b', 0, 1, 'b', '0.8 + 0.01*a')],
        { a: (v) => Math.sqrt(v.b - 0.7) + v.a - 0.4, b: (v) => v.b - (0.8 + 0.01 * v.a) },
      ],
      [
        [
          P('a', 0, 1, 'a', '2*b - 1.5'),
          P('b', 0, 1, 'b', '0.8 + 0.001*a + 0.001*c'),
          P('c', 0, 1, 'c', '3*a - 0.2'),
        ],
        {
          a: (v) => v.a - (2 * v.b - 1.5),
          b: (v) => v.b - (0.8 + 0.001 * v.a + 0.001 * v.c),
          c: (v) => v.c - (3 * v.a - 0.2),
        },
      ],
    ];
    const orders = <T>(xs: T[]): T[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]),
          );
    for (const [params, relation] of cases)
      for (const order of orders(params)) {
        const r = evaluateSheet(
          { title: 'set', polarity: 'n', params: order, equations: [], checks: [] },
          dev,
        );
        const label = order.map((q) => q.name).join('');
        expect([label, r.warnings.filter((w) => w.rule === 'sheet-solve')]).toEqual([label, []]);
        expect([label, r.feasible]).toEqual([label, true]);
        for (const q of order)
          expect([
            label,
            q.name,
            Math.abs(relation[q.name](r.values)) <=
              SOLVE_TOL_REL * ((q.max as number) - (q.min as number)),
          ]).toEqual([label, q.name, true]);
      }
  });

  it('reports a member that finds nothing inside a set as the set not settling, in either document order', () => {
    // a = 2b - 1.5 and b = 0.8 + 0.1a have one answer inside both ranges (a = 0.125, b = 0.8125).
    // With a listed first, a is searched with b at the middle of its range and finds no root; with
    // b first, the sweeps contract by 0.2 each and run out. Neither says a has no solution: both
    // are the set not settling, because where a was searched depended on where b stood.
    const a = {
      name: 'a',
      value: 0,
      min: 0,
      max: 1,
      designConstraint: { lhs: 'a', rhs: '2*b - 1.5' },
    };
    const b = {
      name: 'b',
      value: 0,
      min: 0,
      max: 1,
      designConstraint: { lhs: 'b', rhs: '0.8 + 0.1*a' },
    };
    for (const params of [
      [a, b],
      [b, a],
    ]) {
      const res = evaluateSheet(
        { title: 'pair', polarity: 'n', params, equations: [], checks: [] },
        dev,
      );
      expect(res.feasible).toBe(false);
      const solve = res.warnings.filter((w) => w.rule === 'sheet-solve').map((w) => w.message);
      expect(solve).toHaveLength(1);
      expect(solve[0]).toMatch(
        new RegExp(
          `^solved params "${params[0].name}" in \\[0, 1\\] and "${params[1].name}" in \\[0, 1\\] did not settle`,
        ),
      );
    }
  });

  it('takes a root that sits on an end of the range, a rounding error to the wrong side, as the root', () => {
    // x + 0.2 - 0.3 reads 5.6e-17 at x = 0.1, the same sign as at the other end: the sign test
    // alone calls that no solution. Within its tolerance of zero by the slope there, it is the root.
    const res = evaluateSheet(one('x + 0.2', 0.3, 0.1, 1), dev);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    expect(res.values.x).toBe(0.1);
  });

  it('refuses a jump however large one end of the range reads', () => {
    // A step of 2e-3 across the target, with the far end reading 1e3: a tolerance scaled by the
    // relation's range would call the step a root. Beside the step the relation is flat, so the
    // slope just outside the final bracket gives no room for its height.
    const res = evaluateSheet(
      one('(x < 0.5 ? -0.001 : 0.001) + (x > 0.99 ? 1000 : 0)', 0, 0, 1),
      dev,
    );
    expect(res.feasible).toBe(false);
    expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(
      /steps across the target without touching it/,
    );
  });

  it('tells a symmetric relation from one that does not depend on its param by its middle', () => {
    // (x - 0.5)^2 - 0.01 reads 0.24 at both ends, to the last bit, but -0.01 at the middle: it
    // depends on x — it has two roots — and is reported as not changing sign across the range,
    // never as not depending on x.
    const msg = evaluateSheet(one('(x - 0.5)^2 - 0.01', 0, 0, 1), dev).warnings.find(
      (w) => w.rule === 'sheet-solve',
    )?.message;
    expect(msg).toMatch(/does not change sign across it/);
    expect(msg).not.toMatch(/does not appear to depend/);
  });

  it('takes a root on either end of the range, whichever reads nearer zero', () => {
    // min(1e4(1.0000001 - x), 1e-4 + 0.01x) reads 1e-4 at x = 0 and 1e-3 at x = 1, the same sign,
    // but it is steep at x = 1 and its root lies 1e-7 beyond it: within the tolerance there. The
    // end reading the smaller value is not the one that holds the root.
    const res = evaluateSheet(one('min(1e4*(1.0000001 - x), 1e-4 + 0.01*x)', 0, 0, 1), dev);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    expect(res.values.x).toBe(1);
  });

  it('accepts a root beside a kink, where one side of the crossing is ten times shallower', () => {
    // y = x - r above the kink at 0.3 and 0.1(x - 0.3) + (0.3 - r) below it, with the root r
    // 0.2 of a tolerance above the kink. Read only on the shallow side, the slope beside the
    // crossing would leave the root no room and call the kink a step; read on both sides, the
    // steep one is the relation's own.
    const r = 0.3 + 0.2e-6;
    const res = evaluateSheet(
      one(`x < 0.3 ? 0.1*(x - 0.3) + (0.3 - ${r}) : (x - ${r})`, 0, 0, 1),
      dev,
    );
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    expect(Math.abs(res.values.x - r)).toBeLessThanOrEqual(SOLVE_TOL_REL);
  });

  it('steps round a stretch that does not evaluate on either side, or over two, and finds the root', () => {
    // Each relation changes sign across [0, 1] and does not evaluate on the stretches named. The
    // first: the search's first probe lands in (0.8, 0.87), and only the half toward x = 0 still
    // changes sign, with the root at 0.3. The other two have the root between two stretches; the
    // halving from the first probe steps over the gap that holds it, and the search between the
    // two points it found then lands in it.
    const NaN_ = 'sqrt(-1)';
    const holes = (stretches: [number, number][], expr: string): string =>
      `${stretches.map(([a, b]) => `(x > ${a} && x < ${b})`).join(' || ')} ? ${NaN_} : (${expr})`;
    for (const [stretches, expr, root] of [
      [[[0.8, 0.87]], 'x < 0.3 ? (x - 0.3)/0.3 : 0.2*(x - 0.3)/0.7', 0.3],
      [
        [
          [0.2, 0.3],
          [0.45, 0.55],
        ],
        'x < 0.4 ? (x - 0.4)/0.4 : (x - 0.4)/0.6',
        0.4,
      ],
      [
        [
          [0.45, 0.55],
          [0.7, 0.8],
        ],
        'x < 0.6 ? (x - 0.6)/0.6 : (x - 0.6)/0.4',
        0.6,
      ],
    ] as [[number, number][], string, number][]) {
      const res = evaluateSheet(one(holes(stretches, expr), 0, 0, 1), dev);
      expect([root, res.warnings.filter((w) => w.rule === 'sheet-solve')]).toEqual([root, []]);
      expect([root, Math.abs(res.values.x - root) <= SOLVE_TOL_REL]).toEqual([root, true]);
    }
  });

  it('says it could not follow a crossing inside a stretch that does not evaluate, naming the stretch', () => {
    // The root 0.45 lies inside (0.4, 0.5), where the relation does not evaluate. The sign change
    // across the range is evidence of a root, so this is not no solution; the search could not
    // reach it, and says between which points it lies.
    const res = evaluateSheet(one('x > 0.4 && x < 0.5 ? sqrt(-1) : (x - 0.45)', 0, 0, 1), dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve').map((w) => w.message)).toEqual([
      expect.stringMatching(
        /^solved param "x" in \[0, 1\] did not settle: y - \(T\) changes sign across \[0, 1\], but the crossing could not be followed: it lies between x = 0\.399\d+ and 0\.500\d+, where the points tried do not evaluate/,
      ),
    ]);
  });

  it('accepts a kink less than a tolerance from a range end, where only its shallow side can be read', () => {
    // The kink sits 0.8 of a tolerance below x = 1 and the root 0.2 above the kink, on the steep
    // side; below the kink the relation is five times shallower. The bracket closes against the
    // end, so beside it only the shallow side can be read, and that slope alone would call the
    // crossing a step. Halving the bracket a few more times brings the reading within tolerance,
    // as it never would beside a step.
    const k = 1 - 0.8e-6;
    const r = k + 0.2e-6;
    const res = evaluateSheet(
      one(`x < ${k} ? 0.2*(x - ${k}) + (${k} - ${r}) : (x - ${r})`, 0, 0, 1),
      dev,
    );
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toEqual([]);
    expect(Math.abs(res.values.x - r)).toBeLessThanOrEqual(SOLVE_TOL_REL);
  });

  it('refuses a step right at either end of the range, where one side of the bracket lies outside it', () => {
    for (const expr of ['x < 3e-7 ? -0.5 : 1', 'x < 0.9999997 ? -1 : 0.5']) {
      const res = evaluateSheet(one(expr, 0, 0, 1), dev);
      expect(res.feasible).toBe(false);
      expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(
        /steps across the target without touching it/,
      );
    }
  });

  it('says what an even number of roots shows: no sign change, none or an even number of roots', () => {
    // Two roots, 0.2 and 0.7: the relation has one sign at both ends.
    const res = evaluateSheet(one('(x - 0.2)*(x - 0.7)', 0, 0, 1), dev);
    expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(
      /does not change sign across it \(.*\) — none, or an even number, of roots there/,
    );
  });

  it('reports a range that evaluates only between its probes as not shown, never as no solution', () => {
    // The relation evaluates only on [0.3, 0.45], with a root at 0.4. The ends and the middle all
    // fail, which shows nothing about the stretch between them.
    const res = evaluateSheet(one('x >= 0.3 && x <= 0.45 ? x - 0.4 : sqrt(-1)', 0, 0, 1), dev);
    expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(
      /^solved param "x" in \[0, 1\] did not settle: nothing of the range could be evaluated/,
    );
  });

  it('prints the relation with its right-hand side in parentheses', () => {
    // Q = A/2 + 0.8 is Q - (A/2 + 0.8); without the parentheses it would read Q - A/2 + 0.8.
    const res = evaluateSheet(one('x', 0, 0, 1, 1), dev);
    expect(res.warnings).toEqual([]);
    const doc = one('x', 0, 0, 1);
    doc.params[0].designConstraint = { lhs: 'x', rhs: 'T/2 + 5' };
    const msg = evaluateSheet(doc, dev).warnings.find((w) => w.rule === 'sheet-solve')?.message;
    expect(msg).toMatch(/: x - \(T\/2 \+ 5\) does not change sign/);
  });

  it('validation refuses a relation that does not read the param it solves', () => {
    // T - 1 never reads x; neither does an equation chain that stops at a param. Whatever they
    // read is the same at every x, so a search would land on min and call it found.
    const doc = one('T', 1, 0, 1);
    expect(
      validateSheet(doc)
        .filter((w) => w.severity === 'error')
        .map((w) => w.message),
    ).toEqual([
      'param "x": its relation y - (T) does not read x, so it cannot single x out — write the ' +
        'relation in terms of the param it solves',
    ]);
    // A relation that reads x, even one that cancels it, is left to the search, which says so.
    const cancels = one('x - x + T', 1, 0, 1);
    expect(validateSheet(cancels).filter((w) => w.severity === 'error')).toEqual([]);
    expect(
      evaluateSheet(cancels, dev).warnings.find((w) => w.rule === 'sheet-solve')?.message,
    ).toMatch(/is not determined by its relation: .* it does not appear to depend on x/);
  });
});

describe('a solve reads only a child whose own solve landed', () => {
  it('steps round a band where a child does not solve, and finds the root beyond it', () => {
    // The child solves Q = 0.5 except for A in (0.45, 0.55), where it has no solution and so
    // publishes nothing. The parent's relation changes sign across [0, 1] with its root at
    // P = 0.8; the search's first halving lands on 0.5, inside the band. A sign change is evidence
    // of a root, so the search halves from that point toward each end to where the relation
    // evaluates again, keeps the half that still changes sign, and lands on 0.8.
    const child: SheetDoc = {
      title: 'child',
      polarity: 'n',
      params: [
        { name: 'A', value: 0 },
        {
          name: 'Q',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: { lhs: 'Q', rhs: 'A > 0.45 && A < 0.55 ? 5 : 0.5' },
        },
      ],
      equations: [],
      checks: [],
      provides: ['Q'],
    };
    const doc: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [
        {
          name: 'P',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: {
            lhs: '(P < 0.8 ? (P - 0.8)/0.8 : (P - 0.8)/0.2) + 2*(c__Q - 0.5)',
            rhs: '0',
          },
        },
      ],
      blocks: [{ name: 'c', doc: child, params: { A: 'P' } }],
      equations: [],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(res.feasible).toBe(true);
    expect(Math.abs(res.values.P - 0.8)).toBeLessThanOrEqual(SOLVE_TOL_REL);
  });

  it('reports the budget, not no solution, when it runs out inside the last probe a decision rests on', () => {
    // P + 1 has no root in [0, 1], and the search's last probe reads the slope beside the far end
    // to see whether that end is a root. The child chain under P is cheap everywhere (each level's
    // root sits exactly at its low end) except within 0.1 of P = 1, where it nests a real solve
    // four levels deep — so that one probe runs the budget out inside the child, which then
    // publishes nothing. That probe says nothing about the far end, and the search says the budget
    // ran out; it does not report the no-root it had nearly shown. Each level hands its child a
    // HOT that moves with its own probe, so no child is ever asked the same thing twice and the
    // nest costs what it would cost without remembered child results.
    const level = (k: number): SheetDoc => {
      const reads = k < 3 ? `(c${k}__X*0.5 + 0.3)` : '0.4';
      return {
        title: `L${k}`,
        polarity: 'n',
        params: [
          { name: 'HOT', value: 0 },
          {
            name: 'X',
            value: 0,
            min: 0,
            max: 1,
            designConstraint: {
              lhs: 'exp(4*X) + X^3',
              rhs: `HOT > 0 ? exp(4*${reads}*0.9) + (${reads}*0.9)^3 : 1`,
            },
          },
        ],
        blocks:
          k < 3
            ? [{ name: `c${k}`, doc: level(k + 1), params: { HOT: 'HOT > 0 ? HOT + X : 0' } }]
            : [],
        equations: [],
        checks: [],
        provides: ['X'],
      };
    };
    const doc: SheetDoc = {
      title: 'top',
      polarity: 'n',
      params: [
        {
          name: 'P',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: { lhs: 'P + 1 + 0*c__X', rhs: '0' },
        },
      ],
      blocks: [{ name: 'c', doc: level(0), params: { HOT: 'P > 0.9 && P < 1 ? P : 0' } }],
      equations: [],
      checks: [],
    };
    const solve = evaluateSheet(doc, dev)
      .warnings.filter((w) => w.rule === 'sheet-solve')
      .map((w) => w.message);
    expect(solve.length).toBeGreaterThan(0);
    for (const m of solve) {
      expect(m).toMatch(/shared evaluation budget \(\d+ evaluations\) ran out/);
      expect(m).not.toMatch(/found no solution/);
    }
  });

  it('reports a budget that runs out in a nested chain as the budget, at every level', () => {
    // Four levels, each solving X with a relation that reads its child's X; the child's input is
    // the parent's X. The nesting multiplies past the shared budget. Every level says the budget
    // ran out and that it was not shown to be unsolvable — none says it found no solution, though
    // the children it read stopped publishing when they ran out. The child's input carries a trace
    // of the parent's own input, so no child input recurs from one search to the next: a child
    // result read back would charge nothing, and the nest has to cost what it costs evaluated.
    const level = (k: number): SheetDoc => {
      const reads = k < 3 ? `(c${k}__X*0.5 + IN*0.3)` : '(0.2 + IN/3)';
      return {
        title: `L${k}`,
        polarity: 'n',
        params: [
          { name: 'IN', value: 0.5 },
          {
            name: 'X',
            value: 0,
            min: 0,
            max: 1,
            designConstraint: {
              lhs: 'exp(4*X) + X^3',
              rhs: `exp(4*${reads}*0.9) + (${reads}*0.9)^3`,
            },
          },
        ],
        blocks: k < 3 ? [{ name: `c${k}`, doc: level(k + 1), params: { IN: 'X + IN/1000' } }] : [],
        equations: [],
        checks: [],
        provides: ['X'],
      };
    };
    const res = evaluateSheet(level(0), dev);
    expect(res.feasible).toBe(false);
    const solve = res.warnings.filter((w) => w.rule === 'sheet-solve').map((w) => w.message);
    expect(solve).toHaveLength(4);
    for (const m of solve) {
      expect(m).toMatch(/shared evaluation budget \(\d+ evaluations\) ran out/);
      expect(m).toMatch(/It was not shown to be unsolvable$/);
      expect(m).not.toMatch(/found no solution|could not be followed/);
    }
    expect(heldOutcome(res).state).toBe('no-answer');
  });

  it('finds the real root where a failed child would have shown it phantom ones', () => {
    // The child solves Q = P/2 + 0.8 in [0, 1], which has no solution for P > 0.4. The parent's
    // relation c__Q + (P < 0.4 ? P/2 - 1 : (0.6 - P)(0.8 - P) - 1) has a real root at P = 0.2 and
    // two more at 0.6 and 0.8 that exist only on the numbers a failed child solve left behind. The
    // failed child publishes nothing, so the parent's relation does not evaluate there, the search
    // steps in from that end, and lands on 0.2.
    const child: SheetDoc = {
      title: 'child',
      polarity: 'n',
      params: [
        { name: 'A', value: 0 },
        { name: 'Q', value: 0, min: 0, max: 1, designConstraint: { lhs: 'Q', rhs: 'A/2 + 0.8' } },
      ],
      equations: [],
      checks: [],
      provides: ['Q'],
    };
    const doc: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [
        {
          name: 'P',
          value: 0,
          min: 0,
          max: 1,
          designConstraint: {
            lhs: 'c__Q + (P < 0.4 ? P/2 - 1 : (0.6 - P)*(0.8 - P) - 1)',
            rhs: '0',
          },
        },
      ],
      blocks: [{ name: 'c', doc: child, params: { A: 'P' } }],
      equations: [],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(res.feasible).toBe(true);
    expect(res.values.P).toBeCloseTo(0.2, 5);
    expect(res.values.c__Q).toBeCloseTo(0.9, 5);
  });
});

describe('givens region — the saturation or triode check a device declares', () => {
  /** A device at gm/ID `gmId` with its drain at `vds`, declaring `region`. */
  const device = (
    region: unknown,
    vds: string,
    gmId = '12',
    extra: Partial<SheetDoc> = {},
  ): SheetDoc =>
    boundDoc({
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'I', value: 10e-6 },
        { name: 'V_d', value: Number(vds), class: 'independent', unit: 'V' },
      ],
      givens: { L: 'L', id: 'I', gm_id: gmId, vds: 'V_d', region: region as 'saturation' },
      ...extra,
    });
  const region = (res: SheetResult) => res.checks.find((c) => c.id === 'region');

  it('adds a physical check that |vds| clears vdsat, read from the sizing, and it passes in saturation', () => {
    const res = runSheet(device('saturation', '0.6'), dev);
    const r = region(res);
    expect(r).toMatchObject({
      kind: 'physical',
      op: '>=',
      text: 'abs(vds) >= vdsat',
      status: 'pass',
    });
    expect(r?.lhsValue).toBe(0.6);
    expect(r?.rhsValue).toBe(res.values.vdsat);
    expect(r?.margin).toBeCloseTo(0.6 - res.values.vdsat, 12);
    expect(res.feasible).toBe(true);
    // Only the device's own check list carries it; the document's checks are untouched.
    expect(device('saturation', '0.6').checks).toEqual([]);
  });

  it('fails a drain-source voltage that points against the table’s vds axis, in either region', () => {
    // A table whose vds axis starts above zero, as a coarse export's does: a drain stated below the
    // source is read at the axis's first value with a warning, and its magnitude clearing vdsat
    // says nothing about saturation — the device is reverse-biased.
    const above = generateDemoDevice({ vds: { min: 0.05, max: 1.2, step: 0.05 } });
    for (const which of ['saturation', 'triode']) {
      const res = runSheet(device(which, '-0.5'), above);
      const r = region(res);
      expect([which, r?.status]).toEqual([which, 'fail']);
      expect(r?.margin).toBe(-0.5);
      expect(r?.lhsValue).toBe(-0.5);
      expect(r?.detail).toMatch(/points against this table's vds axis/);
      expect(res.feasible).toBe(false);
    }
    // The same magnitude the right way round is the ordinary comparison.
    expect(region(runSheet(device('saturation', '0.5'), above))?.status).toBe('pass');
    // On a signed PMOS export the axis runs negative, so a negative drain voltage is the right
    // way round there and a positive one is the reversed device.
    const signed = signedMirrorDemo(above);
    expect(
      region(runSheet(device('saturation', '-0.5', '12', { polarity: 'p' }), signed))?.status,
    ).toBe('pass');
    expect(
      region(runSheet(device('saturation', '0.5', '12', { polarity: 'p' }), signed))?.status,
    ).toBe('fail');
  });

  it('fails, and the design with it, where the given drain voltage pushes the device out of saturation', () => {
    const res = runSheet(device('saturation', '0.1'), dev);
    const r = region(res);
    expect(r?.status).toBe('fail');
    expect(r?.margin).toBeCloseTo(0.1 - res.values.vdsat, 12);
    expect(res.feasible).toBe(false);
    expect(bindingCheck(res)?.id).toBe('region');
  });

  it('checks a switch the other way: |vds| at or under vdsat in triode', () => {
    // At gm/ID 4 the device is in strong inversion, with a vdsat far above the 50 mV it is asked
    // to drop.
    const res = runSheet(device('triode', '0.05', '4'), dev);
    const r = region(res);
    expect(r).toMatchObject({ op: '<=', text: 'abs(vds) <= vdsat', status: 'pass' });
    expect(r?.margin).toBeCloseTo(res.values.vdsat - 0.05, 12);
    expect(res.feasible).toBe(true);
    // The same switch asked to sit in saturation fails.
    expect(region(runSheet(device('saturation', '0.05', '4'), dev))?.status).toBe('fail');
  });

  it('compares the drain voltage the givens state, not the one a short table was read at', () => {
    // This table's vds axis starts at 0.3 V, so a stated 0.05 V is read at 0.3 V and the clamp is
    // reported. Judged at 0.3 V the device would pass; at the 0.05 V the design asks for it is out
    // of saturation, and that is what the check says.
    const short = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.3 } });
    const res = runSheet(device('saturation', '0.05'), short);
    expect(res.sizing?.clamped).toContain('vds');
    expect(res.sizing?.bias?.vds).toBe(0.3);
    const r = region(res);
    expect(r?.lhsValue).toBe(0.05);
    expect(r?.status).toBe('fail');
    expect(0.3 >= (r?.rhsValue ?? Infinity)).toBe(true); // the clamped value would have passed
  });

  it('reads the magnitude of a signed drain voltage', () => {
    // A signed-export PMOS sweeps vds negative; -0.6 V is as far from saturation's edge as 0.6.
    const signed = signedMirrorDemo(dev);
    const res = runSheet(device('saturation', '-0.6'), signed);
    expect(region(res)?.lhsValue).toBe(0.6);
    expect(region(res)?.status).toBe('pass');
  });

  it('reads na on a table with no vdsat column, which a hard check fails closed on', () => {
    // An na hard check makes the design infeasible, as any physical check that cannot be read
    // does; the run itself completes.
    const res = runSheet(device('saturation', '0.6'), withoutColumns(dev, ['vdsat']));
    const r = region(res);
    expect(r?.status).toBe('na');
    expect(r?.detail).toBe('the table has no vdsat column');
    expect(res.feasible).toBe(false);
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  });

  it('rides a sweep and a range end like an authored physical check', () => {
    const swept = device('saturation', '0.6');
    swept.params[2] = { ...swept.params[2], min: 0.05, max: 1.2 };
    const sw = sweepSheet(swept, 'V_d', dev, 5);
    const curve = sw.checks.find((c) => c.id === 'region');
    expect(curve?.kind).toBe('physical');
    expect(curve?.marginPct.map((m) => (m ?? NaN) > 0)).toEqual([false, true, true, true, true]);
    // Held at the design point's hardware, a drain moved to 0.1 V takes the device out of
    // saturation there: that end does not comply, and the region check is why.
    const doc = device('saturation', '0.6', '12', {
      operatingRange: [{ name: 'low-drain', set: { V_d: '0.1' } }],
    });
    const res = runSheet(doc, dev);
    expect(res.feasible).toBe(true);
    const [end] = res.rangeEnds!;
    expect(end.state).toBe('does-not-comply');
    expect(end.checks.find((c) => c.id === 'region')?.status).toBe('fail');
  });

  it('validation refuses another word, a region beside a diode connection, and an authored check named region', () => {
    const errors = (doc: SheetDoc): string[] =>
      validateSheet(doc)
        .filter((w) => w.severity === 'error')
        .map((w) => w.message);
    expect(errors(device('saturation', '0.6'))).toEqual([]);
    expect(errors(device('triode', '0.6'))).toEqual([]);
    expect(errors(device('linear', '0.6'))).toEqual([
      'given region must be "saturation" or "triode"',
    ]);
    const diode = boundDoc({
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'I', value: 10e-6 },
      ],
      givens: { L: 'L', id: 'I', gm_id: '12', diode: true, region: 'saturation' },
    });
    expect(errors(diode)).toEqual([
      expect.stringMatching(/^the givens declare a region beside a diode connection/),
    ]);
    // Evaluated anyway, the region reads na — a hard check that cannot be read — never a pass.
    expect(region(evaluateSheet(diode, dev))?.status).toBe('na');
    const named = device('saturation', '0.6', '12', {
      checks: [{ id: 'region', kind: 'advisory', lhs: '1', op: '>=', rhs: '0' }],
    });
    expect(errors(named)).toEqual([
      expect.stringMatching(/^check id "region" is the id of the check/),
    ]);
  });
});

describe('operating range — the held design asked at each range end, apart from feasibility', () => {
  // Mirrors the library's CM idiom: x is the internal node the design constraint solves, y = 2x + 1
  // the produced output, T the typed spec, [T_lo, T_hi] the claimed range the range ends check.
  const mk = (over: Partial<SheetDoc> = {}): SheetDoc => ({
    title: 'e',
    polarity: 'n',
    params: [
      { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'T' } },
      { name: 'T', value: 5 },
      { name: 'T_lo', value: 3 },
      { name: 'T_hi', value: 7 },
      // max deliberately OFF the lo range end's landing point (x = 1): a sweep sample exactly on
      // a bound would coin-flip on the constraint's ~1e-5 landing tolerance.
      { name: 'x_floor', value: 0.5, min: 0, max: 1.6 },
    ],
    equations: [{ name: 'y', expr: '2*x + 1' }],
    checks: [{ id: 'node-floor', kind: 'physical', lhs: 'x', op: '>=', rhs: 'x_floor' }],
    operatingRange: [
      { name: 'lo', set: { T: 'T_lo' } },
      { name: 'hi', set: { T: 'T_hi' } },
    ],
    ...over,
  });

  it('re-solves the design constraint at each range end and reports where it landed', () => {
    const res = runSheet(mk(), dev);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(2, 4); // base: y = 5 → x = 2
    expect(res.rangeEnds?.map((e) => e.name)).toEqual(['lo', 'hi']);
    expect(res.rangeEnds?.map((e) => e.state)).toEqual(['complies', 'complies']);
    expect(res.complies).toBe(true);
    expect(res.rangeEnds?.[0].solved.x).toBeCloseTo(1, 4); // y = 3 → x = 1
    expect(res.rangeEnds?.[1].solved.x).toBeCloseTo(3, 4); // y = 7 → x = 3
  });

  it('never throws on malformed range ends — half-written or mistyped shapes degrade', () => {
    // evaluate's contract is never-throw; curated JSON bypasses the sanitizer, so a
    // half-written range end (no set) or a mistyped range ends field must not TypeError.
    expect(() =>
      evaluateSheet(mk({ operatingRange: [{ name: 'lo' } as never] }), dev),
    ).not.toThrow();
    expect(() => evaluateSheet(mk({ operatingRange: 'garbage' as never }), dev)).not.toThrow();
    const res = evaluateSheet(mk({ operatingRange: 'garbage' as never }), dev);
    expect(res.rangeEnds).toBeUndefined(); // degrades to a plain evaluation
  });

  it('the report says WHICH point was checked, and never fabricates a landing', () => {
    const ok = evaluateSheet(mk(), dev);
    expect(ok.rangeEnds?.[0].set).toEqual({ T: 3 }); // the resolved override, not the expression
    expect(ok.rangeEnds?.[0].warnings).toEqual([]);
    const doc = mk();
    doc.params.find((p) => p.name === 'T_lo')!.value = 0.5; // unreachable range end
    const bad = evaluateSheet(doc, dev);
    expect(bad.rangeEnds?.[0].solved).toEqual({}); // a bracket end is not a landing
  });

  it('a check failing ONLY at a range end leaves the design feasible, and is named with its end', () => {
    const doc = mk();
    doc.params.find((p) => p.name === 'x_floor')!.value = 1.5; // base x=2 passes; lo end x=1 fails
    const res = evaluateSheet(doc, dev);
    expect(res.checks.every((r) => r.status === 'pass' || r.status === 'amber')).toBe(true);
    // Two questions, two answers: the design meets its spec where it was sized, and does not
    // hold at one end of the range it claims.
    expect(res.feasible).toBe(true);
    expect(res.complies).toBe(false);
    expect(res.rangeEnds?.map((e) => e.state)).toEqual(['does-not-comply', 'complies']);
    // Nothing binds where the design was sized, so the feasibility question names no check...
    expect(bindingCheck(res)).toBeUndefined();
    // ...and the range end's failure is named with its end, or by asking that run itself.
    expect(rangeEndCheck(res)?.id).toBe('lo@node-floor');
    expect(bindingCheck(res.rangeEnds![0])?.id).toBe('node-floor');
  });

  it('a range end the bracket cannot reach is no answer, with the solver reason verbatim', () => {
    const doc = mk();
    doc.params.find((p) => p.name === 'T_lo')!.value = 0.5; // y spans [1, 21]: unreachable
    const res = evaluateSheet(doc, dev);
    // The solve did not land, so nothing was measured at that end: not a failure of the design,
    // and never a pass. The design itself is untouched by it.
    expect(res.feasible).toBe(true);
    expect(res.rangeEnds?.[0].state).toBe('no-answer');
    expect(res.complies).toBe(false);
    expect(res.rangeEnds?.[0].error).toMatch(/does not change sign/);
    // no failing CHECK anywhere — the cause is the solve, so there is no check to name
    expect(bindingCheck(res)).toBeUndefined();
    expect(rangeEndCheck(res)).toBeUndefined();
    // the failed range end does not leak error warnings into the base result
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  });

  it('set expressions evaluate against the BASE result, not just params', () => {
    const doc = mk({
      operatingRange: [{ name: 'lo', set: { T: 'y - 2' } }], // base y = 5 → range end T = 3
    });
    const res = evaluateSheet(doc, dev);
    expect(res.rangeEnds?.[0].solved.x).toBeCloseTo(1, 4);
  });

  it('a set expression that does not resolve is no answer at that end, by name', () => {
    const doc = mk({ operatingRange: [{ name: 'lo', set: { T: 'nonsense_name' } }] });
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(res.rangeEnds?.[0].state).toBe('no-answer');
    expect(res.complies).toBe(false);
    expect(res.rangeEnds?.[0].error).toMatch(/did not evaluate to a finite number/);
  });

  it('a range end that does not comply can NEVER chart non-negative — na fails it closed, on-chart', () => {
    // Hard `na` fails a range end closed while contributing no margin; without the floor a
    // passing sibling check painted the failing end at +margin. sqrt(6 - T) is finite at the
    // base (T=5) and lo end (T=3), na at the hi end (T=7).
    const doc = mk({
      checks: [
        { id: 'node-floor', kind: 'physical', lhs: 'x', op: '>=', rhs: 'x_floor' },
        { id: 'na-at-hi', kind: 'physical', lhs: 'sqrt(6 - T)', op: '>=', rhs: '0' },
      ],
    });
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(res.rangeEnds?.[1].state).toBe('does-not-comply');
    const sw = sweepSheet(doc, 'x_floor', dev, 2);
    const hiCurve = sw.checks.find((r) => r.id === 'hi@');
    expect(hiCurve!.marginPct.every((m) => m !== null && m < 0)).toBe(true);
  });

  it("a range end's error prefers the SOLVER's message over whatever error landed last", () => {
    // A child's failed design constraint rolls up mid-evaluation; a later parent equation goes
    // non-finite AFTER it. "Last error" alone would report the consequence (the equation) instead
    // of the cause (the solve).
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [
        { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'P' } },
        { name: 'P', value: 5 },
      ],
      equations: [{ name: 'y', expr: '2*x + 1' }],
      checks: [],
    };
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [
        { name: 'T', value: 5 },
        { name: 'T_hi', value: 25 }, // child y spans [1, 21]: unreachable at the range end
      ],
      equations: [{ name: 'bad', expr: 'sqrt(21 - T)' }], // non-finite at T = 25, fine at 5
      checks: [],
      blocks: [{ name: 'amp', doc: child, params: { P: 'T' } }],
      operatingRange: [{ name: 'hi', set: { T: 'T_hi' } }],
    };
    const res = evaluateSheet(parent, dev);
    expect(res.rangeEnds?.[0].state).toBe('no-answer');
    expect(res.rangeEnds?.[0].error).toMatch(/constrained param|does not change sign/);
  });

  it('a snapped zero reads amber for EVERY operator — == included', () => {
    // 1.010005 == 1 at tolPct 1 sits ~5e-6 OUTSIDE its band: genuinely failing, inside
    // the snap. Reading it full pass would silently hide the miss; amber says "on the
    // boundary". Clearly outside the snap still fails.
    const eq = (lhs: string): SheetDoc => ({
      title: 'q',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [{ id: 'eq', kind: 'spec', lhs, op: '==', rhs: '1', tolPct: 1 }],
    });
    expect(evaluateSheet(eq('1.010005'), dev).checks[0].status).toBe('amber');
    expect(evaluateSheet(eq('1.02'), dev).checks[0].status).toBe('fail');
    // The inequality face of the same coin: a sub-snap genuine shortfall reads amber.
    const ge: SheetDoc = {
      title: 'g',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [{ id: 'ge', kind: 'spec', lhs: '0.999995', op: '>=', rhs: '1' }],
    };
    expect(evaluateSheet(ge, dev).checks[0].status).toBe('amber');
  });

  it("a composed child's range ends are ignored, and validation says so", () => {
    const child = mk();
    child.params.find((p) => p.name === 'T_lo')!.value = 0.5; // its lo range end would fail hard
    child.provides = ['y'];
    const parent: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [],
      blocks: [{ name: 'amp', doc: child }],
    };
    const res = runSheet(parent, dev);
    expect(res.feasible).toBe(true); // the child's base run is feasible; its range ends never ran
    expect(res.blocks?.[0].feasible).toBe(true);
    expect(res.warnings.some((w) => /not evaluated in composition/.test(w.message))).toBe(true);
  });

  it('a swept sample agrees with the same values evaluated alone, and a range end never moves feasibility', () => {
    const doc = mk();
    const sw = sweepSheet(doc, 'x_floor', dev, 3); // samples 0, 0.8, 1.6
    // Base x = 2 clears every floor swept, so every sample is feasible — including 1.6, where the
    // lo end (x = 1) falls below it. That is a compliance finding and has its own curve.
    expect(sw.feasible).toEqual([true, true, true]);
    expect(sw.stands).toEqual([true, true, true]);
    const alone = evaluateSheet(withParams(doc, { x_floor: 1.6 }), dev);
    expect(alone.feasible).toBe(true);
    expect(alone.complies).toBe(false);
    const loCurve = sw.checks.find((r) => r.id === 'lo@');
    expect(loCurve).toBeDefined();
    expect(loCurve!.marginPct[2]).toBeLessThan(0); // where the held design stops complying there
    expect(loCurve!.marginPct[0]).toBeGreaterThan(0);
  });

  it('the 2-D map is a feasibility map: a range end cannot turn a cell, and a broken range still blocks', () => {
    const doc = mk();
    doc.params.push({ name: 'slack', value: 0, min: 0, max: 1 });
    // x_floor up to 1.6 fails the lo end (x = 1) and never the centre (x = 2).
    const map = sweepSheet2(doc, 'x_floor', 'slack', dev, 3);
    expect(map.feasible.flat()).toEqual(Array(9).fill(true));
    expect(map.binding.flat()).toEqual(Array(9).fill(null));
    // A range the validator refuses makes the sheet a broken sheet here as everywhere else.
    const broken = mk({ operatingRange: [{ name: 'bad@name', set: { T: 'T_lo' } }] });
    broken.params.push({ name: 'slack', value: 0, min: 0, max: 1 });
    expect(sweepSheet2(broken, 'x_floor', 'slack', dev, 3).feasible.flat()).toEqual(
      Array(9).fill(false),
    );
  });

  it('a structurally broken sheet has no design at any swept sample', () => {
    // The evaluator tolerates a check id the validator refuses, so the sample itself completes.
    // The sweep must still say there is no design, as runSheet does for the same document.
    const doc = mk({
      checks: [{ id: 'node.floor', kind: 'physical', lhs: 'x', op: '>=', rhs: 'x_floor' }],
    });
    const sw = sweepSheet(doc, 'x_floor', dev, 3);
    expect(sw.feasible).toEqual([false, false, false]);
    expect(sw.stands).toEqual([false, false, false]);
  });

  it('a range end with no answer leaves a gap in its curve, never a failure', () => {
    const doc = mk();
    doc.params.find((p) => p.name === 'T_lo')!.value = 0.5; // unreachable: the solve cannot land
    const sw = sweepSheet(doc, 'x_floor', dev, 2);
    expect(sw.checks.find((r) => r.id === 'lo@')!.marginPct).toEqual([null, null]);
  });

  it('block names reserve the check-path separators — a collision would shadow check results', () => {
    // Check outcomes are keyed `${blockPath}.${checkId}` and `${rangeEnd}@${checkId}` in one map;
    // a block named across either separator could silently shadow a range-end-qualified id.
    const child: SheetDoc = { title: 'c', polarity: 'n', params: [], equations: [], checks: [] };
    for (const name of ['a@b', 'a.b']) {
      const doc: SheetDoc = {
        title: 'p',
        polarity: 'n',
        params: [],
        equations: [],
        checks: [],
        blocks: [{ name, doc: child }],
      };
      const hit = validateSheet(doc).some(
        (w) => w.severity === 'error' && /tree-keyed check ids/.test(w.message),
      );
      expect(hit, name).toBe(true);
    }
  });

  it('validateSheet rejects malformed range ends and reserves the @ separator', () => {
    const errs = (doc: SheetDoc): string[] =>
      validateSheet(doc)
        .filter((w) => w.severity === 'error')
        .map((w) => w.message);
    expect(
      errs(
        mk({
          operatingRange: [
            { name: 'lo', set: { T: 'T_lo' } },
            { name: 'lo', set: { T: 'T_hi' } },
          ],
        }),
      ).join(),
    ).toMatch(/duplicate range end name/);
    expect(errs(mk({ operatingRange: [{ name: 'a@b', set: { T: 'T_lo' } }] })).join()).toMatch(
      /must not contain/,
    );
    expect(errs(mk({ operatingRange: [{ name: 'lo', set: {} }] })).join()).toMatch(/sets nothing/);
    expect(errs(mk({ operatingRange: [{ name: 'lo', set: { nope: 'T_lo' } }] })).join()).toMatch(
      /not a param/,
    );
    expect(errs(mk({ operatingRange: [{ name: 'lo', set: { x: 'T_lo' } }] })).join()).toMatch(
      /the engine solves/,
    );
    expect(errs(mk({ operatingRange: [{ name: 'lo', set: { T: 'T_lo +* 2' } }] })).join()).toMatch(
      /does not parse/,
    );
    expect(
      errs(mk({ checks: [{ id: 'a@b', kind: 'physical', lhs: 'x', op: '>=', rhs: '0' }] })).join(),
    ).toMatch(/tree-keyed check ids/);
    expect(
      errs(mk({ checks: [{ id: 'a.b', kind: 'physical', lhs: 'x', op: '>=', rhs: '0' }] })).join(),
    ).toMatch(/tree-keyed check ids/);
  });
});

describe('rawMargin — the honest distance beside the snapped one', () => {
  it('survives the near-zero snap', () => {
    const doc: SheetDoc = {
      title: 'snap',
      polarity: 'n',
      params: [{ name: 'a', value: 1 }],
      equations: [],
      checks: [{ id: 'r', kind: 'spec', lhs: 'a', op: '>=', rhs: 'a + 1e-9' }],
    };
    const r = evaluateSheet(doc).checks[0];
    // The verdict reads the boundary it is parked on; a DERIVATIVE would read zero slope from
    // that and conclude the check cannot be moved.
    expect(r.margin).toBe(0);
    expect(r.status).toBe('amber');
    expect(r.rawMargin).toBeCloseTo(-1e-9, 15);
    expect(r.rawMargin).not.toBe(0);
  });

  it('is NaN wherever the margin is', () => {
    const doc: SheetDoc = {
      title: 'na',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [{ id: 'r', kind: 'spec', lhs: 'nope', op: '>=', rhs: '0' }],
    };
    const r = evaluateSheet(doc).checks[0];
    expect(r.status).toBe('na');
    expect(Number.isNaN(r.rawMargin)).toBe(true);
  });
});

describe('limitingCheck — the check closest to breaking', () => {
  const child = (rhs: string): SheetDoc => ({
    title: 'c',
    polarity: 'n',
    params: [],
    equations: [],
    checks: [{ id: 'tightest', kind: 'physical', lhs: '1', op: '>=', rhs }],
    provides: [],
  });
  const doc = (childRhs: string, topRhs: string): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    params: [],
    equations: [],
    checks: [
      { id: 'loose', kind: 'spec', lhs: '1', op: '>=', rhs: topRhs },
      // Tighter than either hard check, and advisory — it must never be named.
      { id: 'advice', kind: 'advisory', lhs: '1', op: '>=', rhs: '0.999' },
    ],
    blocks: [{ name: 'c', doc: child(childRhs) }],
  });

  it('names the tightest hard check on a FEASIBLE tree, where nothing is failing', () => {
    const res = evaluateSheet(doc('0.99', '0.5'));
    expect(res.feasible).toBe(true);
    expect(bindingCheck(res)).toBeUndefined(); // no check to blame — nothing failed
    // Path-keyed exactly as bindingCheck would name it.
    expect(limitingCheck(res)?.id).toBe('c.tightest');
  });

  it('agrees with bindingCheck once a check fails', () => {
    const res = evaluateSheet(doc('0.99', '2'));
    expect(res.feasible).toBe(false);
    expect(bindingCheck(res)?.id).toBe('loose');
    expect(limitingCheck(res)?.id).toBe('loose');
  });

  it('looks past the boundary tautology a range end parks on', () => {
    // A range end lands the design exactly on the limit its own check compares against, so that
    // check reads margin 0 by construction. Naming it as the limiter there would be true and
    // useless — it would be the answer forever, hiding every check that can actually move.
    const res = evaluateSheet({
      title: 'range end',
      polarity: 'n',
      params: [
        { name: 'a', value: 1 },
        { name: 'A_lo', value: 0.5 },
      ],
      equations: [],
      checks: [
        { id: 'range', kind: 'spec', lhs: 'a', op: '>=', rhs: 'A_lo' },
        { id: 'tight', kind: 'spec', lhs: 'a', op: '>=', rhs: '0.49' },
      ],
      operatingRange: [{ name: 'lo', set: { a: 'A_lo' } }],
    });
    expect(res.feasible).toBe(true);
    expect(res.rangeEnds![0].checks.find((r) => r.id === 'range')!.margin).toBe(0);
    // Asked of the range end's own run. The base run is a different question with its own
    // answer: there `range` (1 vs 0.5, 100%) is tighter than `tight` (1 vs 0.49, 104%).
    const lim = limitingCheck(res.rangeEnds![0])!;
    expect(lim.id).toBe('tight');
    expect(lim.marginPct).toBeCloseTo(0.01 / 0.49, 9);
    expect(limitingCheck(res)?.id).toBe('range');
  });

  it('never names a check from a range end whose solve never landed', () => {
    // Such an end's checks were evaluated wherever its search stopped — a design point the
    // engine never landed on. Naming a check measured there points the designer at a
    // phantom. The end's own `error` is the finding; its checks are not outcomes.
    const doc: SheetDoc = {
      title: 'range end',
      polarity: 'n',
      params: [
        { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
        { name: 'T_lo', value: 0.5 }, // y spans [1, 21] over the bracket — unreachable
      ],
      equations: [{ name: 'y', expr: '2*x + 1' }],
      checks: [{ id: 'ceiling', kind: 'physical', lhs: 'x', op: '<=', rhs: '10.5' }],
      operatingRange: [{ name: 'lo', set: { T: 'T_lo' } }],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.rangeEnds![0].error).toMatch(/does not change sign/);
    expect(res.rangeEnds![0].checks[0].marginPct).toBeLessThan(res.checks[0].marginPct);
    expect(limitingCheck(res)?.id).toBe('ceiling');
    expect(bindingCheck(res)).toBeUndefined();
    expect(rangeEndCheck(res)).toBeUndefined();
  });

  it('has nothing to name when every hard check is na', () => {
    const res = evaluateSheet({
      title: 'x',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [{ id: 'r', kind: 'physical', lhs: 'nope', op: '>=', rhs: '0' }],
    });
    expect(limitingCheck(res)).toBeUndefined();
  });
});

describe('sheetSensitivities — which knob moves which margin', () => {
  /** margin = 2a - rhs, so d(margin)/da is exactly 2 and a difference scheme must reproduce it. */
  const linear = (over: Partial<SheetVar> = {}, rhs = '1', extra: Partial<SheetDoc> = {}) => ({
    title: 'lin',
    polarity: 'n' as const,
    params: [{ name: 'a', value: 1, role: 'choice' as const, min: 0, max: 10, ...over }],
    equations: [],
    checks: [{ id: 'r', kind: 'spec' as const, lhs: '2*a', op: '>=' as const, rhs }],
    ...extra,
  });

  it('reproduces an analytic slope exactly', () => {
    const s = sheetSensitivities(linear());
    expect(s).toHaveLength(1);
    expect(s[0].param).toBe('a');
    expect(s[0].step).toBeCloseTo(0.01, 12); // 1% of the value
    expect(s[0].error).toBeUndefined();
    const r = s[0].checks[0];
    expect(r.id).toBe('r');
    expect(r.baseStatus).toBe('pass');
    expect(r.baseMargin).toBeCloseTo(1, 12);
    expect(r.dMarginPerUnit).toBeCloseTo(2, 9);
    expect(r.deltaPlus).toBeCloseTo(0.02, 9);
    expect(r.deltaMinus).toBeCloseTo(-0.02, 9);
  });

  it('treats a FAILING hard check as an ordinary point — that is where direction is wanted', () => {
    const s = sheetSensitivities(linear({}, '100'));
    expect(s[0].error).toBeUndefined();
    expect(s[0].checks[0].baseStatus).toBe('fail');
    expect(s[0].checks[0].baseMargin).toBeCloseTo(-98, 9);
    expect(s[0].checks[0].dMarginPerUnit).toBeCloseTo(2, 9);
  });

  it('switches to a one-sided difference for a knob sitting on its bound', () => {
    const s = sheetSensitivities(linear({ value: 0.5, min: 0.5 }));
    expect(s[0].step).toBeCloseTo(0.005, 12);
    const r = s[0].checks[0];
    expect(r.dMarginPerUnit).toBeCloseTo(2, 9); // second-order one-sided: exact on a line
    expect(r.deltaPlus).toBeCloseTo(0.01, 9);
    expect(Number.isNaN(r.deltaMinus)).toBe(true); // no probe below the bound was taken
  });

  it('leans the other way for a knob sitting on its UPPER bound', () => {
    const s = sheetSensitivities(linear({ value: 10 })); // max is 10
    expect(s[0].step).toBeCloseTo(0.1, 12);
    const r = s[0].checks[0];
    expect(r.dMarginPerUnit).toBeCloseTo(2, 9);
    expect(r.deltaMinus).toBeCloseTo(-0.2, 9);
    expect(Number.isNaN(r.deltaPlus)).toBe(true);
  });

  it('says so when the step does not fit inside the bounds at all', () => {
    // Neither direction has room for the two probes a second-order difference needs.
    const s = sheetSensitivities(linear({ value: 1, min: 0.995, max: 1.005 }));
    expect(s[0].error).toMatch(/too narrow to difference across/);
    expect(s[0].checks).toEqual([]);
  });

  it('reports one-sided deltas and NO slope across an equality check cusp', () => {
    // margin = tol*|rhs| - |lhs - rhs| peaks where the check is satisfied, so both directions
    // move it DOWN and a central difference averages them to a flat 0 — the one number that is
    // certainly wrong.
    const s = sheetSensitivities({
      ...linear(),
      checks: [{ id: 'eq', kind: 'spec', lhs: 'a', op: '==', rhs: '1', tolPct: 10 }],
    });
    const r = s[0].checks[0];
    expect(Number.isNaN(r.dMarginPerUnit)).toBe(true);
    expect(r.deltaPlus).toBeCloseTo(-0.01, 9);
    expect(r.deltaMinus).toBeCloseTo(-0.01, 9);
  });

  it('records a probe that did not stand, and fabricates nothing from it', () => {
    // sqrt of a negative headroom at a + h: the equation is non-finite from resolved inputs, which
    // is an error-severity diagnostic, so that side of the difference does not exist.
    const s = sheetSensitivities(
      linear({}, '1', { equations: [{ name: 'q', expr: 'sqrt(1.005 - a)' }] }),
    );
    expect(s[0].error).toMatch(/did not stand/);
    expect(s[0].error).toContain('a = 1.01');
    const r = s[0].checks[0];
    expect(Number.isNaN(r.deltaPlus)).toBe(true);
    expect(Number.isNaN(r.dMarginPerUnit)).toBe(true);
    expect(r.deltaMinus).toBeCloseTo(-0.02, 9); // the surviving side is still reported
  });

  it('re-checks the range ends only for a check that lives on one', () => {
    // Every range end costs each probe another full evaluation of the whole sheet, so a readout
    // about a check at the top must not pay for range ends nobody asked about. Naming a
    // range-end-keyed check is how a caller opts in — and then the range-end outcomes are keyed
    // exactly as bindingCheck names them.
    const doc = linear({}, '1', {
      params: [
        { name: 'a', value: 1, role: 'choice', min: 0, max: 10 },
        { name: 'A_lo', value: 0.5 },
      ],
      operatingRange: [{ name: 'lo', set: { a: 'A_lo' } }],
    });
    // Unasked: the range-end runs never happen, so nothing range-end-keyed is reported at all —
    // never a row of NaNs standing in for a measurement that was deliberately skipped.
    expect(sheetSensitivities(doc)[0].checks.map((r) => r.id)).toEqual(['r']);

    const byId = new Map(
      sheetSensitivities(doc, undefined, undefined, { check: 'lo@r' })[0].checks.map((r) => [
        r.id,
        r,
      ]),
    );
    expect([...byId.keys()].sort()).toEqual(['lo@r', 'r']);
    expect(byId.get('r')!.dMarginPerUnit).toBeCloseTo(2, 9);
    // The range end pins `a` to its own value, so the knob cannot move that run at all.
    expect(byId.get('lo@r')!.dMarginPerUnit).toBeCloseTo(0, 12);
  });

  it('answers for a check at one range end while another range end has no answer', () => {
    // y = k*x + 1 is constrained to T, so x = (T - 1)/k. At the lo end T = 3: x = 2/k, and the
    // floor check's margin there is 2/k - 1.5, whose slope in k at k = 2 is -2/k^2 = -0.5. The hi
    // end asks T = 100, which x in [0, 10] cannot produce: no answer there. That is no reason to
    // refuse the readout about lo — its checks were measured.
    const doc: SheetDoc = {
      title: 'two-ends',
      polarity: 'n',
      params: [
        { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
        { name: 'T_lo', value: 3 },
        { name: 'T_hi', value: 100 },
        { name: 'k', value: 2, min: 1, max: 4, role: 'choice' },
      ],
      equations: [{ name: 'y', expr: 'k*x + 1' }],
      checks: [{ id: 'node-floor', kind: 'physical', lhs: 'x', op: '>=', rhs: '1.5' }],
      operatingRange: [
        { name: 'lo', set: { T: 'T_lo' } },
        { name: 'hi', set: { T: 'T_hi' } },
      ],
    };
    const res = evaluateSheet(doc);
    expect(res.feasible).toBe(true);
    expect(res.rangeEnds?.map((e) => e.state)).toEqual(['does-not-comply', 'no-answer']);

    const [lo] = sheetSensitivities(doc, undefined, undefined, { check: 'lo@node-floor' });
    expect(lo.error).toBeUndefined();
    expect(lo.checks.find((r) => r.id === 'lo@node-floor')!.dMarginPerUnit).toBeCloseTo(-0.5, 3);
    // Pointed at the end that has no answer, it says so in those words — the sheet itself
    // evaluates, so "the sheet does not evaluate" would be false.
    const [hi] = sheetSensitivities(doc, undefined, undefined, { check: 'hi@node-floor' });
    expect(hi.error).toMatch(/the range end "hi" has no check outcomes/);
  });

  it('probes the author choices by default and never a param the engine solves', () => {
    const doc: SheetDoc = {
      title: 'mix',
      polarity: 'n',
      params: [
        { name: 'a', value: 1, role: 'choice' },
        { name: 'spec', value: 1, role: 'spec' },
        { name: 'e', value: 1, role: 'choice', solveFor: 't' },
      ],
      equations: [{ name: 't', expr: '0.5*e + 0.5' }],
      checks: [{ id: 'r', kind: 'spec', lhs: '2*a', op: '>=', rhs: '1' }],
    };
    expect(sheetSensitivities(doc).map((s) => s.param)).toEqual(['a']);
    // Asked for by name, it is still refused — with the reason, not silently.
    const asked = sheetSensitivities(doc, undefined, undefined, { params: ['e', 'ghost'] });
    expect(asked[0].error).toMatch(/the engine solves "e"/);
    expect(asked[1].error).toMatch(/"ghost" is not a param/);
    expect(asked.every((s) => s.checks.length === 0)).toBe(true);
  });

  it('scales a zero-valued knob from its range, and refuses to invent one without a range', () => {
    const bounded = sheetSensitivities(linear({ value: 0, min: -1, max: 1 }, '-1'));
    expect(bounded[0].step).toBeCloseTo(0.02, 12); // 1% of the span
    expect(bounded[0].checks[0].dMarginPerUnit).toBeCloseTo(2, 9);

    const unbounded = sheetSensitivities(
      linear({ value: 0, min: undefined, max: undefined }, '-1'),
    );
    expect(unbounded[0].error).toMatch(/pass an absolute step/);
    expect(unbounded[0].checks).toEqual([]);

    const told = sheetSensitivities(
      linear({ value: 0, min: undefined, max: undefined }, '-1'),
      undefined,
      undefined,
      { absStep: 0.01 },
    );
    expect(told[0].checks[0].dMarginPerUnit).toBeCloseTo(2, 9);
  });

  it('refuses to differentiate a doc that does not validate', () => {
    const s = sheetSensitivities({
      ...linear(),
      checks: [
        { id: 'r', kind: 'spec', lhs: '2*a', op: '>=', rhs: '1' },
        { id: 'r', kind: 'spec', lhs: '2*a', op: '>=', rhs: '2' }, // duplicate id
      ],
    });
    expect(s[0].error).toMatch(/does not validate/);
    expect(s[0].checks).toEqual([]);
  });
});

describe('a given gate-source voltage in a sheet', () => {
  // The mirror needs a device whose current actually depends on the drain: the demo swept over
  // vds, here on a finer grid than the module's `dev`.
  const devVds = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.05 } });
  /** Early voltage of the demo model at the length these sheets use. */
  const VA = VA_PER_L * 1e-6;

  /** A mirror reference: diode-connected, sized at a current, publishing its gate voltage. */
  const reference = (): SheetDoc => ({
    title: 'ref',
    polarity: 'n',
    params: [
      { name: 'L_r', value: 1e-6 },
      { name: 'I_r', value: 20e-6 },
      { name: 'g_r', value: 10 },
    ],
    givens: { L: 'L_r', id: 'I_r', gm_id: 'g_r', diode: true },
    equations: [],
    checks: [],
    provides: ['W', 'vgs'],
  });

  /** A K:1 mirror whose output device is given `partner` as its second quantity. */
  const mirror = (partner: Record<string, string>): SheetDoc =>
    notACircuit({
      title: 'mirror',
      polarity: 'n',
      params: [
        { name: 'L', value: 1e-6 },
        { name: 'K', value: 3 },
        { name: 'V_out', value: 0.9 },
        { name: 'gm_id_m', value: 10 },
      ],
      givens: { L: 'L', W: 'K*ref__W', ...partner, vds: 'V_out' },
      equations: [{ name: 'ratio', expr: 'id/(K*20e-6)' }],
      checks: [],
      blocks: [{ name: 'ref', doc: reference() }],
    });

  it('sizes the output device at the reference gate voltage, not at a target it re-solves', () => {
    const res = runSheet(mirror({ vgs: 'ref__vgs' }), devVds);

    expect(res.sizing?.ok).toBe(true);
    // The two devices are on one wire: the sized gate voltage IS the reference's, exactly —
    // not "within an inversion level of it".
    expect(res.sizing!.vgs).toBeCloseTo(res.values.ref__vgs, 15);
    expect(res.sizing!.W).toBeCloseTo(3 * res.values.ref__W, 15);
    // vgs is a SELECTOR, never a bias axis: the sizing must not have sliced the vgs axis away.
    expect(Object.keys(res.sizing?.bias ?? {})).not.toContain('vgs');
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);

    // The demo device's channel-length modulation multiplies id by (1 + vds/VA), so two devices
    // on one gate differ only by that factor: I_out/(K·I_in) = (1 + V_out/VA)/(1 + V_ref/VA),
    // with VA = VA_PER_L·L. The reference is diode-connected, so its own drain sits at its gate
    // voltage. `ratio` is already normalised by K, so K itself drops out.
    const expected = (1 + 0.9 / VA) / (1 + res.values.ref__vgs / VA);
    // Not exact, and the residual is the grid's, not the tie's: the reference's width is read
    // off the diode diagonal, a column that is not linear in vgs, so a solved gate voltage
    // between two nodes carries an interpolation error into the width — measured at ~2e-5 here,
    // bounded an order above it. The correction itself is ~5%, so this holds the ratio to well
    // under a thousandth of it.
    //
    // What this does NOT establish is that a shared gate differs from a shared gm/ID. The demo
    // model's channel-length modulation multiplies id and gm alike, so it cancels out of the
    // ratio and both forms land on one gate voltage; separating them needs a device whose gm/ID
    // moves with the drain, which is device.test.ts's algebraic oracle. What is established
    // here is the sheet plumbing and the mirror arithmetic standing on it.
    expect(Math.abs(res.values.ratio / expected - 1)).toBeLessThan(1e-4);
    expect(expected).toBeGreaterThan(1.04); // the check is not vacuous: a real 4%+ correction
  });

  it('reports a clamped gate voltage as the one it read AT, and says that it clamped', () => {
    // The hazard the clamp is written against is a result whose vgs disagrees with the point
    // every quantity beside it came from. The demo sweeps vgs to 1.2 V, so a request for 1.5 V
    // must come back as 1.2 V everywhere it is reported — the sizing report, the merged scope, and
    // an equation reading it — with the request surviving only in the warning. And the sheet must
    // still size: a clamp is a note about where the data ends, not an infeasibility.
    const doc = notACircuit({
      title: 'c',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'W_o', value: 4e-6 },
      ],
      givens: { L: 'L', W: 'W_o', vgs: '1.5', vds: '0.6' },
      equations: [{ name: 'v_read', expr: 'vgs' }],
      checks: [],
    });
    const res = runSheet(doc, dev);

    expect(res.sizing?.ok).toBe(true);
    expect(res.sizing!.vgs).toBeCloseTo(1.2, 12);
    expect(res.values.vgs).toBeCloseTo(1.2, 12);
    expect(res.values.v_read).toBeCloseTo(1.2, 12);

    const clamps = res.warnings.filter((w) => /vgs 1\.5 .*clamped/.test(w.message));
    expect(clamps).toHaveLength(1);
    expect(clamps[0].severity).toBe('warning');
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  });

  it('refuses a gate voltage paired with another operating-point quantity', () => {
    // Two selectors over-determine the gate voltage, whichever two they are.
    const both: SheetDoc = {
      ...mirror({}),
      givens: { L: 'L', vgs: 'ref__vgs', gm_id: 'gm_id_m', vds: 'V_out' },
    };
    expect(validateSheet(both).some((w) => /both set the operating point/.test(w.message))).toBe(
      true,
    );
    expect(runSheet(both, devVds).sizing?.ok).toBe(false);

    // And a gate voltage on top of already-complete width-first givens is a third quantity.
    const three = mirror({ vgs: 'ref__vgs', gm_id: 'gm_id_m' });
    expect(validateSheet(three).some((w) => /EXACTLY two/.test(w.message))).toBe(true);
    expect(runSheet(three, devVds).sizing?.ok).toBe(false);
  });

  it('is legal alongside a diode connection: the connection picks the axis, the given vgs the point', () => {
    // A diode connection collapses vds onto the vds = vgs diagonal; naming vgs then picks the
    // point ON that diagonal. Two independent statements, both true — unlike a declared vds,
    // which would name the same coordinate twice.
    const doc = notACircuit({
      title: 'd',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'v', value: 0.7 },
        { name: 'W', value: 4e-6 },
      ],
      givens: { L: 'L', W: 'W', vgs: 'v', diode: true },
      equations: [],
      checks: [],
    });
    expect(validateSheet(doc)).toEqual([]);
    const res = runSheet(doc, devVds);
    expect(res.sizing?.ok).toBe(true);
    expect(res.sizing!.vgs).toBeCloseTo(0.7, 12);

    // The connection is not decorative here: it put the drain at 0.7 V, so the current carries
    // the demo's (1 + vds/VA) factor with VA = VA_PER_L·0.5 µm = 2.5 V. Against the same device
    // held at vds = 0 that is exactly 1 + 0.7/2.5 = 1.28x the current.
    const atZero = runSheet({ ...doc, givens: { L: 'L', W: 'W', vgs: 'v', vds: '0' } }, devVds);
    expect(res.sizing!.id / atZero.sizing!.id).toBeCloseTo(1 + 0.7 / (VA_PER_L * 0.5e-6), 9);

    // A declared vds is still refused — the ruling is about vgs only.
    expect(
      validateSheet({ ...doc, givens: { ...doc.givens!, vds: '0.5' } }).some((w) =>
        /both a diode connection and a vds/.test(w.message),
      ),
    ).toBe(true);
  });
});
