// Golden suite for the leaf design-sheet evaluator. Anchors the two load-bearing
// promises: the sizing is sizeDevice verbatim (no re-inversion), and bad author input
// degrades to warnings / 'na' chips instead of throwing.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice, signedMirrorDemo, withoutColumns, VA_PER_L } from '../demo';
import { sizeDevice, integratedNoise, mismatch } from '../device';
import { fixTable } from '../series';
import { diodeGrid, makeGrid } from '../grid';
import { lookup } from '../lookup';
import {
  evaluateSheet,
  runSheet,
  validateSheet,
  sweepSheet,
  sweepSheet2,
  sweepable,
  bindingConstraint,
  limitingConstraint,
  sheetSensitivities,
  withParams,
  isHardRule,
  MAX_TORN_PARAMS,
  SOLVE_TOL_REL,
  WIRING_TOL,
} from './index';
import { EXAMPLES } from './examples';
import type { DeviceTable } from '../types';
import type { SheetDoc, SheetResult, SheetVar } from './types';

const dev = generateDemoDevice();

/** gm/gds on the 0.5 µm slice at a chosen vgs — used to pick a bind target off-node. */
const lookupAt = (vgs: number): number => lookup(dev, { l: 0.5e-6, vgs }).gm_gds;

/** A minimal bound sheet at a known in-range operating point (gm/ID = 12, L = 0.5 µm). */
function boundDoc(overrides: Partial<SheetDoc> = {}): SheetDoc {
  return {
    title: 't',
    polarity: 'n',
    params: [
      { name: 'GBW_target', value: 10e6 },
      { name: 'CL', value: 2e-12 },
      { name: 'L', value: 0.5e-6 },
      { name: 'gm_id', value: 12 },
      { name: 'vstar_floor', value: 0.15 },
    ],
    bind: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id' },
    rows: [],
    rules: [],
    ...overrides,
  };
}

describe('evaluateSheet — spec-first binds', () => {
  it('binds fT through a sheet, matching sizeDevice exactly', () => {
    // The claim that a sheet can state a speed spec directly, not just gm/ID.
    const ft = 2e9;
    const ref = sizeDevice({ table: dev, L: 0.5e-6, ft, id: 20e-6 });
    const doc = boundDoc({
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'ft_target', value: ft },
        { name: 'Ib', value: 20e-6 },
      ],
      bind: { L: 'L', ft: 'ft_target', id: 'Ib' },
      rows: [{ name: 'speed', expr: 'ft' }],
    });
    const res = evaluateSheet(doc, dev);

    expect(res.bind?.ok).toBe(true);
    expect(res.bind?.W).toBeCloseTo(ref.W, 12);
    expect(res.bind?.vgs).toBeCloseTo(ref.vgs, 12);
    // The sized device meets the spec the sheet asked for.
    expect(res.values.speed / ft).toBeCloseTo(1, 9);
  });

  it('refuses two operating-point quantities in a sheet, in validate AND in eval', () => {
    // bindProblem is the single home of the rule; both sheet paths must report it, in the
    // same words, or an author gets contradictory advice from the two.
    const doc = boundDoc({
      params: [{ name: 'L', value: 0.5e-6 }],
      bind: { L: 'L', ft: '2e9', gm_id: '12' },
    });

    const problems = validateSheet(doc);
    const invalid = problems.find((p) => p.rule === 'sheet-bind');
    expect(invalid?.message).toMatch(/both set the operating point/);
    // Named: exactly the two supplied, not the whole selector list.
    expect(invalid?.message).toContain('gm_id and ft');
    expect(invalid?.message).not.toContain('vstar');
    // The remedy points at the size quantities, never at another selector.
    expect(invalid?.message).toContain('{gm, id, W}');

    const res = evaluateSheet(doc, dev);
    expect(res.bind?.ok).toBe(false);
    expect(res.bind?.error).toBe(invalid?.message);
    expect(res.feasible).toBe(false);
  });

  it('a rule restating a bound spec reads as pinned, not as a failure against its own bind', () => {
    // A selector is recovered by inverting a node-sampled curve while the point re-derives it
    // from interpolated bases; between nodes those differ by ~0.1%, enough to drive a
    // requirement on the very quantity the bind pinned to a hard fail. Binding a gain and
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
      bind: { L: 'L', gm_gds: 'Av', id: 'Ib' },
      rules: [{ id: 'gain', kind: 'requirement', lhs: 'gm_gds', op: '>=', rhs: 'Av' }],
    });
    const res = evaluateSheet(doc, dev);

    expect(res.rules[0].status).toBe('amber'); // pinned by its own bind, not failed
    expect(res.feasible).toBe(true);
  });

  it('names the missing column when a sheet binds a quantity the table cannot compute', () => {
    const noCgg = withoutColumns(dev, ['cgg']);
    const doc = boundDoc({
      params: [{ name: 'L', value: 0.5e-6 }],
      bind: { L: 'L', ft: '2e9', id: '20e-6' },
    });
    const res = evaluateSheet(doc, noCgg);

    expect(res.bind?.ok).toBe(false);
    expect(res.bind?.error).toMatch(/carries no "cgg" column/);
    expect(res.feasible).toBe(false);
  });
});

describe('evaluateSheet — sizing reuse', () => {
  it('reproduces sizeDevice W and vgs for the same bind (no re-inversion)', () => {
    const gm = 2 * Math.PI * 10e6 * 2e-12;
    const ref = sizeDevice({ table: dev, L: 0.5e-6, gm, gm_id: 12 });
    const res = evaluateSheet(boundDoc(), dev);
    expect(res.bind?.ok).toBe(true);
    expect(res.bind?.W).toBeCloseTo(ref.W, 12);
    expect(res.bind?.vgs).toBeCloseTo(ref.vgs, 9);
    expect(res.values.W).toBeCloseTo(ref.W, 12);
    // the operating-point bag is surfaced as flat scalars, matching sizeDevice exactly
    expect(res.values.vstar).toBeCloseTo(ref.quantities.vstar, 12);
    expect(res.values.ceiling).toBeCloseTo(ref.ceiling, 12);
  });
});

describe('evaluateSheet — rules', () => {
  it('flips an invariant pass<->fail across its boundary', () => {
    const rule = {
      id: 'headroom',
      kind: 'invariant' as const,
      lhs: 'vstar',
      op: '>=' as const,
      rhs: 'vstar_floor',
    };
    // vstar = 2/12 ≈ 0.1667
    const passDoc = boundDoc({ params: [...boundDoc().params], rules: [rule] });
    passDoc.params.find((p) => p.name === 'vstar_floor')!.value = 0.15;
    expect(evaluateSheet(passDoc, dev).rules[0].status).toBe('pass');

    const failDoc = boundDoc({ rules: [rule] });
    failDoc.params.find((p) => p.name === 'vstar_floor')!.value = 0.2;
    const failed = evaluateSheet(failDoc, dev).rules[0];
    expect(failed.status).toBe('fail');
    expect(failed.margin).toBeLessThan(0);
  });

  it('reports the correct signed margin for >=, <= and ==', () => {
    const doc = boundDoc({
      params: [
        { name: 'a', value: 10 },
        { name: 'b', value: 8 },
      ],
      bind: undefined,
      rules: [
        { id: 'ge', kind: 'guardrail', lhs: 'a', op: '>=', rhs: 'b' }, // 10>=8  margin +2
        { id: 'le', kind: 'guardrail', lhs: 'a', op: '<=', rhs: 'b' }, // 10<=8  margin -2
        { id: 'eq', kind: 'guardrail', lhs: 'a', op: '==', rhs: 'b', tolPct: 10 }, // |2|>0.8 -> fail
      ],
    });
    const [ge, le, eq] = evaluateSheet(doc, dev).rules;
    expect(ge.status).toBe('pass');
    expect(ge.margin).toBeCloseTo(2, 9);
    expect(le.status).toBe('fail');
    expect(le.margin).toBeCloseTo(-2, 9);
    expect(eq.status).toBe('fail');
  });

  it('gives a passing == rule a non-negative margin so the zero line is the real boundary', () => {
    // The feasibility chart and the margin column read margin >= 0 as passing; an '==' rule that
    // holds within tolPct must sit at/above zero, not below it (it once always did, being |Δ|).
    const within = boundDoc({
      params: [
        { name: 'a', value: 10.3 },
        { name: 'b', value: 10 },
      ],
      bind: undefined,
      rules: [{ id: 'eq', kind: 'requirement', lhs: 'a', op: '==', rhs: 'b', tolPct: 5 }], // |Δ|=0.3 ≤ 0.5
    });
    const pass = evaluateSheet(within, dev).rules[0];
    expect(pass.status).toBe('pass');
    expect(pass.marginPct).toBeGreaterThanOrEqual(0);

    const outside = boundDoc({
      params: [
        { name: 'a', value: 11 },
        { name: 'b', value: 10 },
      ],
      bind: undefined,
      rules: [{ id: 'eq', kind: 'requirement', lhs: 'a', op: '==', rhs: 'b', tolPct: 5 }], // |Δ|=1 > 0.5
    });
    const fail = evaluateSheet(outside, dev).rules[0];
    expect(fail.status).toBe('fail');
    expect(fail.marginPct).toBeLessThan(0);
  });

  it('marks a non-finite rule side as na, never a false pass', () => {
    const doc = boundDoc({
      params: [
        { name: 'z', value: 0 },
        { name: 'lim', value: 1 },
      ],
      bind: undefined,
      rules: [{ id: 'div0', kind: 'guardrail', lhs: '1/z', op: '<=', rhs: 'lim' }], // 1/0 = Inf
    });
    expect(evaluateSheet(doc, dev).rules[0].status).toBe('na');
  });
});

describe('evaluateSheet — an assumed bias coordinate is reported, not invented', () => {
  // A table that actually sweeps body bias, so leaving vsb undeclared is a real choice.
  const bodySwept = generateDemoDevice({ vsb: { min: 0, max: 0.6, step: 0.2 } });

  it('marks a bias axis the bind left undeclared', () => {
    // vsb = 0 is right for a device whose source sits at its bulk and wrong for a differential
    // pair, cascode or source follower. The engine cannot tell which — a sheet describes no
    // nodes — so the coordinate it filled in must be distinguishable from one the author wrote.
    const res = evaluateSheet(boundDoc(), bodySwept);
    expect(res.bind?.ok).toBe(true);
    expect(res.bind?.bias?.vsb).toBe(0);
    expect(res.bind?.assumed).toContain('vsb');
  });

  it('does not mark a bias axis the bind declares', () => {
    const doc = boundDoc();
    const res = evaluateSheet({ ...doc, bind: { ...doc.bind!, vsb: '0.2' } }, bodySwept);
    expect(res.bind?.bias?.vsb).toBeCloseTo(0.2, 12);
    expect(res.bind?.assumed ?? []).not.toContain('vsb');
  });

  it('sizes a body-biased device differently — which is why the assumption has to be visible', () => {
    const doc = boundDoc();
    const at = (vsb: string): number =>
      evaluateSheet({ ...doc, bind: { ...doc.bind!, vsb } }, bodySwept).bind?.vgs ?? NaN;
    // Same gm/ID, same L: body bias moves the gate drive it takes to get there.
    expect(Math.abs(at('0.6') - at('0'))).toBeGreaterThan(1e-3);
  });
});

describe('evaluateSheet — bias-loop closure (solveFor)', () => {
  // A loop shaped like a real one: an estimate standing in for a value only the evaluated
  // sheet knows, perturbing the operating point WEAKLY. The demo table has no live bias axes,
  // so the loop runs through a row rather than a bias declaration — `gm/ID` is nudged by the
  // estimate, and the estimate solves for the vstar that results.
  //
  // The weak coefficient is what makes it converge, and that is the honest shape: measured
  // |f'| here is ~0.12, against ~0.01 for the input-bias loop of a real 5T OTA. Coupling the
  // estimate tightly instead (`gm_id: '2/vstar_est'`, i.e. x -> vstar(2/x)) gives f' = 1.10 and
  // legitimately does not converge — covered by the divergence test below.
  function loopDoc(overrides: Partial<SheetDoc> = {}): SheetDoc {
    return {
      title: 'loop',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'id', value: 10e-6 },
        { name: 'vstar_est', value: 0.3, solveFor: 'vstar_actual' },
      ],
      bind: { L: 'L', id: 'id', gm_id: '8 + 5*vstar_est' },
      rows: [{ name: 'vstar_actual', expr: 'vstar' }],
      rules: [],
      ...overrides,
    };
  }

  it('iterates the estimate until it agrees with what it names', () => {
    const res = evaluateSheet(loopDoc(), dev);
    expect(res.feasible).toBe(true);
    // The converged estimate must equal the value it solves for — that IS the contract, held
    // to the engine's own tolerance rather than an arbitrary decimal count.
    expect(Math.abs(res.values.vstar_est - res.values.vstar_actual)).toBeLessThanOrEqual(
      SOLVE_TOL_REL * Math.abs(res.values.vstar_actual),
    );
    // ...and the sheet must actually have moved off its authored starting guess, or the test
    // would pass just as well without any solving.
    expect(Math.abs(res.values.vstar_est - 0.3)).toBeGreaterThan(1e-2);
    expect(res.warnings.filter((w) => w.severity === 'error')).toHaveLength(0);
  });

  it('lands on the same point the sized device reports, not the authored guess', () => {
    const res = evaluateSheet(loopDoc(), dev);
    // Independently re-size at the converged estimate: the engine's answer must be the true
    // fixed point of the map, not merely a value that stopped changing.
    const point = sizeDevice({
      table: dev,
      L: 0.5e-6,
      id: 10e-6,
      gm_id: 8 + 5 * res.values.vstar_est,
    });
    expect(point.quantities.vstar).toBeCloseTo(res.values.vstar_est, 6);
  });

  it('is unaffected by the authored starting guess', () => {
    const from = (v: number): number =>
      evaluateSheet(
        loopDoc({
          params: [
            { name: 'L', value: 0.5e-6 },
            { name: 'id', value: 10e-6 },
            { name: 'vstar_est', value: v, solveFor: 'vstar_actual' },
          ],
        }),
        dev,
      ).values.vstar_est;
    expect(from(0.15)).toBeCloseTo(from(0.45), 6);
  });

  it('fails closed when the estimate names something that never resolves', () => {
    const res = evaluateSheet(
      loopDoc({
        params: [
          { name: 'L', value: 0.5e-6 },
          { name: 'id', value: 10e-6 },
          { name: 'vstar_est', value: 0.2, solveFor: 'no_such_value' },
        ],
      }),
      dev,
    );
    expect(res.feasible).toBe(false);
    expect(res.warnings.some((w) => w.rule === 'sheet-solve' && w.severity === 'error')).toBe(true);
  });

  it('fails closed on a loop with no fixed point at all', () => {
    // `run = run + 1` is satisfied by no value, so the estimate walks away in ONE direction
    // forever. No step length rescues that — shortening only slows the escape — so this is the
    // shape the divergence verdict exists for, and the sheet must say so rather than return
    // whichever iterate it stopped on.
    const res = evaluateSheet(
      loopDoc({
        params: [
          { name: 'L', value: 0.5e-6 },
          { name: 'id', value: 10e-6 },
          { name: 'run', value: 1, solveFor: 'onward' },
        ],
        bind: undefined,
        rows: [{ name: 'onward', expr: 'run + 1' }],
      }),
      dev,
    );
    expect(res.feasible).toBe(false);
    expect(res.warnings.some((w) => w.rule === 'sheet-solve')).toBe(true);
    expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(/diverging/);
  });

  it('closes an OVERSHOOTING loop by shortening the step, instead of bouncing over the answer', () => {
    // `flip = -2*osc + 3` has the fixed point 3/(1+2) = 1, but a full substitution step lands
    // twice as far past it on the other side, so plain substitution oscillates with a GROWING
    // amplitude and never arrives — the answer exists, is unique, and is unreachable at that
    // step length. Shortening the step turns the overshoot into a contraction. This is the whole
    // reason the solver adapts its step, and the real bias loops it was found on behave this way
    // at weak inversion.
    const res = evaluateSheet(
      loopDoc({
        params: [
          { name: 'L', value: 0.5e-6 },
          { name: 'id', value: 10e-6 },
          { name: 'osc', value: 5, solveFor: 'flip' },
        ],
        bind: undefined,
        rows: [{ name: 'flip', expr: '-2*osc + 3' }],
      }),
      dev,
    );
    // It CLOSES — no solve failure — and the closure it needed is exactly the kind the
    // pass-count note exists to surface, damping and all.
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve' && w.severity === 'error')).toEqual(
      [],
    );
    expect(res.values.osc).toBeCloseTo(1, 6);
    const note = res.warnings.find((w) => w.rule === 'sheet-solve' && w.severity === 'info');
    expect(note?.message).toMatch(/substitution passes/);
    expect(note?.message).toMatch(/damped/);
  });

  it('refuses a param that solves for itself', () => {
    const w = validateSheet(
      loopDoc({
        params: [{ name: 'x', value: 1, solveFor: 'x' }],
        bind: undefined,
        rows: [],
      }),
    );
    expect(w.some((v) => v.rule === 'sheet-param' && /solves for itself/.test(v.message))).toBe(
      true,
    );
  });

  it('closes a loop inside a composed child', () => {
    // evalChildren recurses through evaluateSheet, so a child's own tearing variable must be
    // solved without the parent knowing anything about it.
    const parent: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'c', doc: { ...loopDoc(), provide: ['vstar_actual'] } }],
    };
    const res = evaluateSheet(parent, dev);
    const child = res.children?.[0];
    expect(child?.feasible).toBe(true);
    expect(res.values.c__vstar_actual).toBeCloseTo(
      evaluateSheet(loopDoc(), dev).values.vstar_est,
      6,
    );
  });

  it('converges a capacitance-scale estimate, not just a volt-scale one', () => {
    // The core is SI throughout, so a tearing variable is as likely to be ~1e-15 F as ~1 V.
    // Any ABSOLUTE convergence floor is met on the first comparison at that scale and would
    // report a wildly wrong estimate as converged — the exact failure solveFor exists to stop.
    // Fixed point of c = 2e-15 - 0.5*c is 4/3e-15; the authored guess is far from it.
    const doc: SheetDoc = {
      title: 'tiny',
      polarity: 'n',
      params: [{ name: 'c_est', value: 0.5e-15, solveFor: 'c_actual' }],
      rows: [{ name: 'c_actual', expr: '2e-15 - 0.5*c_est' }],
      rules: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(res.values.c_est).toBeCloseTo((4 / 3) * 1e-15, 21);
  });

  it('bounds nested fixed points with one budget for the whole tree', () => {
    // A parent iteration re-evaluates its children, each re-converging its own loop, so nested
    // tearing variables multiply. Without a shared budget the cost is cap^depth; with one, a
    // pathological nest fails closed instead of hanging.
    const leaf = (): SheetDoc => ({
      title: 'leaf',
      polarity: 'n',
      // |f'| = 0.995: converges in principle, far too slowly to finish inside the budget.
      params: [{ name: 'x', value: 1, solveFor: 'y' }],
      rows: [{ name: 'y', expr: '1 + 0.995*x' }],
      rules: [],
      provide: ['y'],
    });
    let doc = leaf();
    for (let i = 0; i < 4; i++) {
      doc = { ...leaf(), uses: [{ name: `c${i}`, doc }] };
    }
    const t0 = performance.now();
    const res = evaluateSheet(doc, dev);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(res.feasible).toBe(false);
    expect(res.warnings.some((w) => w.rule === 'sheet-solve')).toBe(true);
  });

  it('closes a period-2 oscillation, whose error neither shrinks nor grows', () => {
    // `flip = -flip` from 1 bounces 1, -1, 1, -1 … at CONSTANT amplitude. That is the case no
    // error-watching test can catch — the gap never shrinks, so it never settles, and never
    // grows, so a divergence test correctly stays quiet — and it is why the step length adapts
    // on the DIRECTION of the step reversing rather than on the size of the error moving.
    // A half step lands on 0 EXACTLY here, which matters: the convergence test is purely
    // relative, so a fixed point at zero is certifiable only when the gap reaches exactly zero.
    const res = evaluateSheet(
      loopDoc({
        params: [{ name: 'flip', value: 1, solveFor: 'negated' }],
        bind: undefined,
        rows: [{ name: 'negated', expr: '-flip' }],
      }),
      dev,
    );
    expect(res.warnings.some((w) => w.rule === 'sheet-solve')).toBe(false);
    expect(res.values.flip).toBeCloseTo(0, 6);
  });

  it('reports the disagreement, not a value compared with itself', () => {
    // The failure message is the only handle an author has on a loop that will not close, so it
    // must show the estimate AND what the sheet resolved for it — which means reading both
    // before the iterate is committed.
    const res = evaluateSheet(
      loopDoc({
        params: [{ name: 'osc', value: 1, solveFor: 'flip' }],
        bind: undefined,
        rows: [{ name: 'flip', expr: '-2*osc' }],
      }),
      dev,
    );
    const m = res.warnings.find((w) => w.rule === 'sheet-solve')?.message ?? '';
    const [, a, b] = /osc → flip: (\S+) vs (\S+)/.exec(m) ?? [];
    expect(a).toBeDefined();
    expect(Number(a)).not.toBe(Number(b));
  });

  it('converges a loop whose error rotates while it contracts', () => {
    // Two coupled unknowns — a tail node and a mirror drain are exactly that pair — give the
    // iteration complex eigenvalues, so the error SPIRALS in: one component's gap grows for
    // several passes running while the error as a whole shrinks. Judging each estimate
    // separately and OR-ing the growths declares this convergent loop divergent.
    const t = 0.9;
    const r = 0.9; // spectral radius < 1, so it genuinely converges
    const c = (Math.cos(t) * r).toFixed(12);
    const s = (Math.sin(t) * r).toFixed(12);
    const res = evaluateSheet(
      {
        title: 'rotating',
        polarity: 'n',
        params: [
          { name: 'x', value: 3, solveFor: 'fx' },
          { name: 'y', value: -2, solveFor: 'fy' },
        ],
        rows: [
          { name: 'fx', expr: `${c}*x - ${s}*y + 1` },
          { name: 'fy', expr: `${s}*x + ${c}*y + 1` },
        ],
        rules: [],
      },
      dev,
    );
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve' && w.severity === 'error')).toEqual(
      [],
    );
    expect(res.feasible).toBe(true);
    // The map's true fixed point, reached independently.
    let x = 0;
    let y = 0;
    const C = Math.cos(t) * r;
    const S = Math.sin(t) * r;
    for (let i = 0; i < 500; i++) [x, y] = [C * x - S * y + 1, S * x + C * y + 1];
    expect(res.values.x).toBeCloseTo(x, 6);
    expect(res.values.y).toBeCloseTo(y, 6);
  });

  /** Fixed point 1, contracting at exactly |f'| = k per pass. */
  const geometric = (k: number): SheetDoc => ({
    title: `contract ${k}`,
    polarity: 'n',
    params: [{ name: 'x', value: 5, solveFor: 'fx' }],
    rows: [{ name: 'fx', expr: `${k}*x + ${1 - k}` }],
    rules: [],
    provide: ['fx'],
  });

  it('converges a weak contraction that needs many passes', () => {
    // |f'| = 0.95 reaches the tolerance only after ~256 passes. Any cap chosen as the
    // divergence test rejects it and blames the author for an unstable loop.
    const res = evaluateSheet(geometric(0.95), dev);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(1, 5);
  });

  it('says a loop is converging slowly rather than blaming the author', () => {
    // Too weak to finish, but the gap shrank on every pass — reporting it as unstable, or as
    // "neither converging nor diverging", would be false. The engine holds the evidence.
    const res = evaluateSheet(geometric(0.999), dev);
    expect(res.feasible).toBe(false);
    const m = res.warnings.find((w) => w.rule === 'sheet-solve')?.message ?? '';
    expect(m).toMatch(/IS converging/);
    expect(m).not.toMatch(/diverging/);
  });

  it('does not let sibling loops starve each other', () => {
    // Feasibility must not depend on document order. With one flat budget for the tree, eight
    // siblings that each converge alone saw the last few fail for want of passes.
    const res = evaluateSheet(
      {
        title: 'eight',
        polarity: 'n',
        params: [],
        rows: [],
        rules: [],
        uses: Array.from({ length: 8 }, (_, i) => ({ name: `c${i}`, doc: geometric(0.9) })),
      },
      dev,
    );
    expect(res.children?.every((c) => c.feasible)).toBe(true);
    expect(res.feasible).toBe(true);
  });

  it('warns when a parent overrides a param the child solves for', () => {
    // The override only seeds the iteration; the fixed point decides. Silently demoting an
    // explicit wiring to a hint is the surprise the unmatched-key error already guards against.
    const res = evaluateSheet(
      {
        title: 'wired',
        polarity: 'n',
        params: [],
        rows: [],
        rules: [],
        uses: [{ name: 'c', doc: geometric(0.5), params: { x: '42' } }],
      },
      dev,
    );
    expect(res.warnings.some((w) => /only seeds the iteration/.test(w.message))).toBe(true);
    expect(res.values.c__fx).toBeCloseTo(1, 6); // solved, not 42
  });

  it('refuses more tearing variables than the scope rule allows', () => {
    const doc: SheetDoc = {
      title: 'too many',
      polarity: 'n',
      params: Array.from({ length: MAX_TORN_PARAMS + 1 }, (_, i) => ({
        name: `e${i}`,
        value: 1,
        solveFor: `t${i}`,
      })),
      rows: [],
      rules: [],
    };
    const w = validateSheet(doc);
    expect(w.some((v) => v.severity === 'error' && /not a circuit solver/.test(v.message))).toBe(
      true,
    );
  });

  it('excludes a solved param from the sweepable set', () => {
    // It is no longer a free variable, so no sweep may drive it — whatever bounds it carries.
    expect(sweepable({ min: 0.1, max: 0.3 })).toBe(true);
    expect(sweepable({ min: 0.1, max: 0.3, solveFor: 'vstar_actual' })).toBe(false);
  });
});

describe('evaluateSheet — degrades instead of throwing', () => {
  it('catches an out-of-range gm/ID as a failed bind, not an exception', () => {
    const doc = boundDoc();
    doc.params.find((p) => p.name === 'gm_id')!.value = 1000; // far above the slice ceiling
    let res!: ReturnType<typeof evaluateSheet>;
    expect(() => (res = evaluateSheet(doc, dev))).not.toThrow();
    expect(res.bind?.ok).toBe(false);
    expect(res.warnings.some((w) => w.severity === 'error')).toBe(true);
    expect(res.feasible).toBe(false);
  });

  it('skips a row with an undeclared name and warns', () => {
    const doc = boundDoc({ rows: [{ name: 'oops', expr: 'no_such_name * 2' }] });
    const res = evaluateSheet(doc, dev);
    expect('oops' in res.values).toBe(false);
    expect(res.warnings.some((w) => w.rule === 'sheet-undeclared')).toBe(true);
  });

  it('evaluates without a device: bound rows go na, param rules still check', () => {
    const doc = boundDoc({
      rules: [{ id: 'ok', kind: 'guardrail', lhs: 'gm_id', op: '<=', rhs: '20' }],
    });
    const res = evaluateSheet(doc); // no table
    expect(res.bind?.ok).toBe(false);
    expect(res.warnings.some((w) => w.severity === 'error')).toBe(true); // unsolved bind ⇒ error
    expect(res.feasible).toBe(false); // never vacuously feasible without a successful size
    expect(res.rules[0].status).toBe('pass'); // gm_id is a param, resolvable without a device
  });
});

describe('feasibility is fail-closed', () => {
  it('a non-finite bind expression is infeasible even when a param-only invariant passes', () => {
    const doc = boundDoc({
      bind: { L: '1/0', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id' }, // L = Infinity → bind fails
      rules: [{ id: 'param-inv', kind: 'invariant', lhs: 'gm_id', op: '<=', rhs: '20' }], // 12<=20 would pass
    });
    const res = evaluateSheet(doc, dev);
    expect(res.bind?.ok).toBe(false);
    expect(res.warnings.some((w) => w.rule === 'sheet-bind' && w.severity === 'error')).toBe(true);
    expect(res.feasible).toBe(false);
  });

  it('a failed requirement is infeasible, but a failed guardrail is only advisory', () => {
    const base = boundDoc({
      params: [
        { name: 'a', value: 10 },
        { name: 'lim', value: 5 },
      ],
      bind: undefined,
    });
    const req = evaluateSheet(
      { ...base, rules: [{ id: 'spec', kind: 'requirement', lhs: 'a', op: '<=', rhs: 'lim' }] },
      dev,
    );
    expect(req.rules[0].status).toBe('fail');
    expect(req.feasible).toBe(false);
    const soft = evaluateSheet(
      { ...base, rules: [{ id: 'soft', kind: 'guardrail', lhs: 'a', op: '<=', rhs: 'lim' }] },
      dev,
    );
    expect(soft.rules[0].status).toBe('fail');
    expect(soft.feasible).toBe(true); // guardrails never block
  });

  it('runSheet folds a validation error (non-finite param) into feasibility', () => {
    const doc = boundDoc({
      params: [{ name: 'x', value: Number.NaN }],
      bind: undefined,
      rules: [],
    });
    const res = runSheet(doc, dev);
    expect(res.warnings.some((w) => w.rule === 'sheet-param')).toBe(true);
    expect(res.feasible).toBe(false);
  });
});

describe('validateSheet', () => {
  it('flags a non-finite param and a wrong bind arity', () => {
    const doc = boundDoc({
      params: [{ name: 'x', value: Number.NaN }],
      bind: { L: 'L', gm: '1', gm_id: '1', id: '1' }, // three of three
    });
    const w = validateSheet(doc);
    expect(w.some((x) => x.rule === 'sheet-param')).toBe(true);
    expect(w.some((x) => x.rule === 'sheet-bind')).toBe(true);
  });
});

describe('the shipped example', () => {
  it('runs on the demo device with a mix of pass and fail', () => {
    const res = runSheet(EXAMPLES[0], dev);
    expect(res.bind?.ok).toBe(true);
    const statuses = res.rules.map((r) => r.status);
    expect(statuses).toContain('pass');
    expect(statuses).toContain('fail'); // headroom fails at the default gm/ID = 12
  });
});

describe('the noise & matching example', () => {
  const ex = EXAMPLES.find((e) => e.title === 'NMOS noise & matching')!;

  it('its author formulas reproduce the core noise/mismatch oracles (no drift from the trusted impls)', () => {
    const res = runSheet(ex, dev);
    expect(res.bind?.ok).toBe(true);
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
    const v = runSheet(ex, dev).values;
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
    const sw = sweepSheet(ex, 'gm_id', dev, 13);
    const margins = (id: string) =>
      sw.rules.find((r) => r.id === id)!.marginPct.filter((x): x is number => x != null);
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

describe('sweepSheet — feasibility curve', () => {
  it('traces a rule margin across a parameter range and bounds the feasible window', () => {
    const doc = structuredClone(EXAMPLES[0]);
    const sw = sweepSheet(doc, 'gm_id', dev, 21);

    expect(sw.x.length).toBe(21);
    expect(sw.x[0]).toBeCloseTo(6, 9); // the example's gm/ID slider spans 6..18
    expect(sw.x[20]).toBeCloseTo(18, 9);
    expect(sw.rules.map((r) => r.id)).toEqual(doc.rules.map((r) => r.id)); // parallel, in order

    // V* ≈ 2/(gm/ID) falls as gm/ID rises, so the headroom margin shrinks monotonically and
    // crosses zero — the whole point of the view (the efficiency↔headroom trade made visible).
    const head = sw.rules.find((r) => r.id === 'headroom')!;
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

describe('composition — scalar provide/use', () => {
  const cascode = EXAMPLES.find((e) => e.title.startsWith('NMOS cascode'))!;

  it('evaluates children first, exposes provides as name__key, and reports each child', () => {
    const res = runSheet(cascode, dev);
    expect(res.bind?.ok).toBe(true);
    expect(res.children).toHaveLength(1);
    const cs = res.children![0];
    expect(cs.name).toBe('cs');
    expect(cs.feasible).toBe(true);
    // the provided scalars are visible in the parent scope as cs__*
    expect(res.values['cs__av0']).toBeCloseTo(cs.provides.av0, 12);
    // the parent's author math composed them: Av == av0 · cs__av0 (the cascode gain)
    expect(res.values.Av).toBeCloseTo(res.values.av0 * res.values['cs__av0'], 9);
    // and the parent bound its OWN device to the child's current (the series stack)
    expect(res.values.id).toBeCloseTo(cs.provides.id, 15);
  });

  it('a leaf reports no children', () => {
    expect(runSheet(EXAMPLES[0], dev).children).toBeUndefined();
  });

  it('is fail-closed: an infeasible child drags the parent infeasible, attributed to the use site', () => {
    const badChild: SheetDoc = {
      title: 'bad',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'gm_id', value: 999 },
        { name: 'I_bias', value: 20e-6 },
      ],
      bind: { L: 'L', id: 'I_bias', gm_id: 'gm_id' }, // gm/ID 999 ≫ ceiling ⇒ the child cannot size
      rows: [],
      rules: [],
      provide: ['id'],
    };
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'c', doc: badChild }],
    };
    const res = runSheet(parent, dev);
    expect(res.children![0].feasible).toBe(false);
    expect(res.feasible).toBe(false);
    expect(res.warnings.some((w) => w.message.includes('use "c":'))).toBe(true);
  });

  it('sweeping the shared knob bounds a feasible window over the whole tree', () => {
    const sw = sweepSheet(cascode, 'gm_id', dev, 13);
    expect(sw.feasible[0]).toBe(false); // gain too low at low gm/ID
    expect(sw.feasible.at(-1)).toBe(false); // headroom gone at high gm/ID
    expect(sw.feasible.some((f) => f)).toBe(true);
    const gain = sw.rules
      .find((r) => r.id === 'gain-spec')!
      .marginPct.filter((x): x is number => x != null);
    expect(gain.at(-1)!).toBeGreaterThan(gain[0]!); // gain improves with gm/ID
  });

  it('a child sizes against the device its `use` names (resolver), or inherits the parent table', () => {
    const child: SheetDoc = {
      title: 'k',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'gm_id', value: 10 },
        { name: 'I_bias', value: 20e-6 },
      ],
      bind: { L: 'L', id: 'I_bias', gm_id: 'gm_id' },
      rows: [],
      rules: [],
      provide: ['id'],
    };
    const parent = (device?: string): SheetDoc => ({
      title: 'p',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'k', doc: child, ...(device ? { device } : {}) }],
    });
    const resolve = (id: string) => (id === 'wide' ? generateDemoDevice({ W: 40e-6 }) : undefined);
    expect(runSheet(parent('wide'), dev, resolve).children![0].feasible).toBe(true); // resolved
    expect(runSheet(parent(undefined), dev, resolve).children![0].feasible).toBe(true); // inherited

    // A named device the resolver cannot supply fails closed with a clear, attributed message.
    const missing = runSheet(parent('missing'), dev, resolve);
    expect(missing.children![0].feasible).toBe(false);
    expect(missing.feasible).toBe(false);
    expect(
      missing.warnings.some(
        (w) => w.severity === 'error' && /device "missing" did not resolve/.test(w.message),
      ),
    ).toBe(true);
  });

  it('a named-but-unresolved device fails even a BINDLESS child closed (not vacuously feasible)', () => {
    // The regression this guards: without the unresolved-device branch, a bindless child sized
    // against no table is vacuously feasible (no bind ⇒ no error), so the parent reads feasible
    // while its child's named device silently does not exist. A child WITH a bind would fail on
    // the bind regardless, so only a bindless child distinguishes the branch.
    const bindless: SheetDoc = {
      title: 'k0',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      provide: [],
    };
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'k', doc: bindless, device: 'missing' }],
    };
    const res = runSheet(parent, dev, () => undefined);
    expect(res.children![0].feasible).toBe(false);
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
      bind: { L: 'L', id: 'I_bias', gm_id: 'gm_id' },
      rows: [],
      rules: [],
      provide: ['id'],
    };
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [{ name: 'I_budget', value: 30e-6 }],
      rows: [{ name: 'echo', expr: 'c__id' }],
      rules: [],
      uses: [{ name: 'c', doc: child, params: { I_bias: 'I_budgett' } }], // typo ⇒ unresolvable
    };
    const res = runSheet(parent, dev);
    expect(
      res.warnings.some((w) => w.severity === 'error' && /override "I_bias"/.test(w.message)),
    ).toBe(true);
    expect(res.children![0].feasible).toBe(false); // wiring broke ⇒ child infeasible
    expect(res.feasible).toBe(false); // ⇒ parent infeasible
    // the child's provides are withheld, so dependent parent math is `na`, not a stale number
    expect('c__id' in res.values).toBe(false);
    expect('echo' in res.values).toBe(false);
  });
});

describe('validateSheet — hand-tuned stand-ins for a device operating point', () => {
  // A child that binds vds from a parent param, and provides its own vgs back.
  const withRule = (lhs: string, biasExpr = 'guess'): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    params: [
      { name: 'guess', value: 0.7 },
      { name: 'V_node', value: 0.9 },
    ],
    rows: [],
    rules: [{ id: 'check', kind: 'guardrail', lhs, op: '<=', rhs: '0.05' }],
    uses: [
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
          bind: { L: 'L', id: 'id', gm_id: 'gm_id', vds: 'vd' },
          rows: [],
          rules: [],
          provide: ['vgs', 'vdsat'],
        },
        params: { vd: biasExpr },
      },
    ],
  });
  const standins = (d: SheetDoc): string[] =>
    validateSheet(d)
      .filter((w) => w.rule === 'sheet-standin')
      .map((w) => w.message);

  it('flags a param that biases a block while a rule asserts it equals that block’s own vgs', () => {
    const w = standins(withRule('abs(k__vgs - guess)'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/"guess" biases block "k" \(vds\)/);
    // The bias IS the stand-in and it is tied to vgs, so this is the diode identity.
    expect(w[0]).toMatch(/diode-connected/);
  });

  it('does NOT flag a headroom guardrail that merely mentions both names', () => {
    // The discriminator: this asserts nothing about the two being equal. Before the abs(...)
    // requirement this shape produced a false finding on a third of the library.
    expect(standins(withRule('V_node - k__vdsat'))).toEqual([]);
    // Nor does an abs() elsewhere in the same expression create a pairing.
    expect(standins(withRule('abs(k__vdsat) - V_node + guess'))).toEqual([]);
  });

  it('calls a compound bias expression a node voltage, not a diode connection', () => {
    const w = standins(withRule('abs(k__vgs - guess)', 'V_node - guess'));
    expect(w).toHaveLength(1);
    expect(w[0]).not.toMatch(/diode-connected/);
    expect(w[0]).toMatch(/node voltage/);
  });

  it('a scaled or offset bias is not a diode either — the identity must be the bare param', () => {
    // `2*guess` and `guess - 0.1` say the drop is NOT the vgs, and "bind the connection"
    // would change those designs. Counting free names (one) cannot see that; only the bare
    // identifier earns the diode advice.
    for (const bias of ['2*guess', 'guess - 0.1', 'guess*1.0']) {
      const w = standins(withRule('abs(k__vgs - guess)', bias));
      expect(w).toHaveLength(1);
      expect(w[0]).not.toMatch(/diode-connected/);
    }
  });

  it('sees the call, not the letters: a space before the paren does not hide the pattern', () => {
    // The parser treats `abs (x)` and `abs(x)` identically, so a literal "abs(" scan let a
    // one-space reformat silently switch the lint off.
    expect(standins(withRule('abs (k__vgs - guess)'))).toHaveLength(1);
    // …and a name merely ENDING in abs is not a call.
    expect(standins(withRule('fabs(k__vgs - guess)'))).toEqual([]);
  });

  it('does not flag a declared bias paired with a symmetric headroom check', () => {
    // `abs(bias - dev__vdsat) <= margin` is the format docs' own recommended shape: a real
    // declared bias plus a margin check. Only a LEVEL the stand-in could stand in for — vgs,
    // vth — closes the round trip; a saturation margin does not.
    expect(standins(withRule('abs(V_node - k__vdsat)', 'V_node'))).toEqual([]);
  });

  it('is advisory — a sheet carrying the pattern still validates without errors', () => {
    expect(validateSheet(withRule('abs(k__vgs - guess)')).some((w) => w.severity === 'error')).toBe(
      false,
    );
  });
});

describe('validateSheet — composition', () => {
  it('flags a separator in a use name, a duplicate name, and a stray override', () => {
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [{ name: 'L', value: 1e-6 }],
      rows: [],
      rules: [],
      provide: [],
    };
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [
        { name: 'a__b', doc: child },
        { name: 'x', doc: child, params: { nope: '1' } },
        { name: 'x', doc: child },
      ],
    };
    const w = validateSheet(doc);
    expect(w.some((x) => x.rule === 'sheet-use' && /must not contain/.test(x.message))).toBe(true);
    expect(w.some((x) => x.rule === 'sheet-use' && /duplicate/.test(x.message))).toBe(true);
    expect(w.some((x) => x.rule === 'sheet-use-param')).toBe(true);
  });

  it('warns when a parent param/row name collides with a child-provided scalar', () => {
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [{ name: 'L', value: 1e-6 }],
      rows: [],
      rules: [],
      provide: ['av0'],
    };
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'cs__av0', value: 1 }], // collides with the injected cs__av0
      rows: [{ name: 'cs__id', expr: '1' }], // child provides only av0, so this does NOT collide
      rules: [],
      uses: [{ name: 'cs', doc: child }],
    };
    const w = validateSheet(doc);
    expect(w.some((x) => x.rule === 'sheet-collision' && /cs__av0/.test(x.message))).toBe(true);
    expect(w.some((x) => x.rule === 'sheet-collision' && /cs__id/.test(x.message))).toBe(false);
  });

  it('distinguishes an undeclared child scalar from a name whose block does not exist', () => {
    const child = boundDoc({ provide: ['gm'] });
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      rows: [
        { name: 'a', expr: 'kid__gm' }, // provided — fine
        { name: 'b', expr: 'kid__gds' }, // the block exists but does not provide it
        { name: 'c', expr: 'kdi__gm' }, // no such block: a transposed use name
      ],
      rules: [],
      uses: [{ name: 'kid', doc: child }],
    };
    const w = validateSheet(doc).filter((x) => x.rule === 'sheet-provide-coverage');
    expect(w.map((x) => x.symbol)).toEqual(['kid__gds', 'kdi__gm']);
    expect(w[0].message).toMatch(/block "kid" does not provide/);
    expect(w[1].message).toMatch(/no child block is named "kdi"/);
  });

  it('says so when a sheet with no bind claims to expose a name that does not exist', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'L', value: 1e-6 }],
      rows: [{ name: 'Rout', expr: '1/kid__gds' }],
      rules: [],
      uses: [{ name: 'kid', doc: boundDoc({ provide: ['gds'] }) }],
      // L and Rout are declared right here and T and w come from the table metadata; R_out is
      // a typo for the row and exposes nothing.
      provide: ['Rout', 'L', 'T', 'w', 'R_out'],
    };
    const w = validateSheet(doc).filter((x) => x.rule === 'sheet-provide-coverage');
    expect(w.map((x) => x.location)).toEqual(['R_out']);
    expect(w[0].message).toMatch(/nothing of that name exists to expose/);
  });

  it('lets a sheet that sizes a device name any table quantity it exposes', () => {
    // Sizing publishes the whole table at the operating point, and a table may carry columns
    // no static list knows about — so a bound sheet's provide list is taken at its word. The
    // upward half of the check still catches a parent reading a name the child never provides.
    const doc = boundDoc({ provide: ['gds', 'W', 'some_foundry_column'] });
    expect(validateSheet(doc).filter((x) => x.rule === 'sheet-provide-coverage')).toEqual([]);
  });

  it('follows a grandchild re-export through both separators', () => {
    const grand = boundDoc({ provide: ['id'] });
    const mid: SheetDoc = {
      title: 'm',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'g', doc: grand }],
      provide: ['g__id'],
    };
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      rows: [
        { name: 'a', expr: 'm__g__id' }, // re-exported all the way up — resolves
        { name: 'b', expr: 'm__g__gm' }, // the grandchild provides id only
      ],
      rules: [],
      uses: [{ name: 'm', doc: mid }],
    };
    const w = validateSheet(doc).filter((x) => x.rule === 'sheet-provide-coverage');
    expect(w.map((x) => x.symbol)).toEqual(['m__g__gm']);
  });

  it('says nothing about names under a ref-only block, whose provides arrive at resolution', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      rows: [{ name: 'a', expr: 'later__gm + later__whatever' }],
      rules: [],
      uses: [{ name: 'later', ref: 'stages/cs-amp-resistive-load' }],
    };
    expect(validateSheet(doc).filter((x) => x.rule === 'sheet-provide-coverage')).toEqual([]);
  });

  it('recurses into a child and attributes its structural error to the use site', () => {
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [{ name: 'p', value: Number.NaN }], // non-finite param ⇒ child structural error
      rows: [],
      rules: [],
    };
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'kid', doc: child }],
    };
    const w = validateSheet(doc);
    expect(w.some((x) => x.rule === 'sheet-param' && x.message.includes('use "kid":'))).toBe(true);
  });
});

describe('table temperature in the sheet scope', () => {
  const tDoc: SheetDoc = {
    title: 't',
    polarity: 'n',
    params: [],
    rows: [{ name: 'tk', expr: 'T' }],
    rules: [],
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
      rows: [],
      rules: [{ id: 'eq', kind: 'requirement', lhs: 'a', op: '==', rhs: 'b', tolPct: NaN }],
    };
    const res = evaluateSheet(doc);
    expect(res.rules[0].status).toBe('na');
    expect(res.feasible).toBe(false);
    const pre = validateSheet(doc);
    expect(pre.some((w) => w.rule === 'sheet-tol' && w.severity === 'error')).toBe(true);
  });

  it('snaps a floating-point-noise margin to zero: a pinned spec reads amber deterministically', () => {
    // 0.1 + 0.2 overshoots 0.3 by ~5.5e-17 in doubles; without the snap this rule's
    // verdict is a coin flip on the rounding direction of the two sides.
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'x', value: 0.3 }],
      rows: [{ name: 'y', expr: '0.1 + 0.2' }],
      rules: [{ id: 'pin', kind: 'requirement', lhs: 'x', op: '>=', rhs: 'y' }],
    };
    const res = evaluateSheet(doc);
    expect(res.rules[0].margin).toBe(0);
    expect(res.rules[0].status).toBe('amber');
    expect(res.feasible).toBe(true);
  });

  it('a row that computes non-finite from resolved inputs is an error, even if only a guardrail reads it', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'x', value: -1 }],
      rows: [{ name: 'bad', expr: 'sqrt(x)' }],
      rules: [{ id: 'g', kind: 'guardrail', lhs: 'bad', op: '>=', rhs: '0' }],
    };
    const res = evaluateSheet(doc);
    expect(res.warnings.some((w) => w.rule === 'sheet-nonfinite' && w.severity === 'error')).toBe(
      true,
    );
    expect(res.feasible).toBe(false);
  });

  it('an unphysical bind (negative gm) fails closed instead of sizing a negative width', () => {
    const doc = boundDoc({ bind: { L: 'L', gm: '0 - 1e-3', gm_id: 'gm_id' } });
    const res = evaluateSheet(doc, dev);
    expect(res.bind?.ok).toBe(false);
    expect(res.values.W).toBeUndefined();
    expect(res.feasible).toBe(false);
  });

  it('sweeping a param whose stored default is non-finite does not poison the sweep', () => {
    const doc: SheetDoc = {
      title: 't',
      polarity: 'n',
      params: [{ name: 'k', value: NaN, min: 1, max: 2 }],
      rows: [],
      rules: [{ id: 'r', kind: 'requirement', lhs: 'k', op: '>=', rhs: '0.5' }],
    };
    const sw = sweepSheet(doc, 'k', undefined, 3);
    expect(sw.x).toHaveLength(3);
    expect(sw.feasible).toEqual([true, true, true]);
  });
});

describe('bind bias declaration (vds/vsb)', () => {
  // A demo table with a live vds axis — sizing must collapse it to a point first.
  const dev3 = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });

  it('a declared vds slices the table at that point and is reported', () => {
    const doc = boundDoc({
      bind: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
    });
    const res = evaluateSheet(doc, dev3);
    expect(res.bind?.ok).toBe(true);
    expect(res.bind?.bias).toEqual({ vds: 0.6 });
    // equals sizing on a hand-sliced table
    const ref = evaluateSheet(boundDoc(), fixTable(dev3, { vds: 0.6 }));
    expect(res.bind?.W).toBeCloseTo(ref.bind?.W as number, 12);
    expect(res.values.gds).toBeCloseTo(ref.values.gds, 15);
  });

  it('the declaration accepts an expression over params', () => {
    const doc = boundDoc({
      params: [...boundDoc().params, { name: 'vds_op', value: 0.6 }],
      bind: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: 'vds_op' },
    });
    const res = evaluateSheet(doc, dev3);
    expect(res.bind?.ok).toBe(true);
    expect(res.bind?.bias).toEqual({ vds: 0.6 });
  });

  it('an undeclared live vds fails closed and flags the axis for the in-place fixer', () => {
    const res = evaluateSheet(boundDoc(), dev3); // dev3 has a live vds axis, none declared
    expect(res.bind?.ok).toBe(false);
    expect(res.bind?.error).toMatch(/declare the operating point/);
    expect(res.bind?.needs).toEqual(['vds']);
    expect(res.feasible).toBe(false);
  });

  it('an undeclared body bias (vsb) defaults to 0 — the body-grounded case sizes cleanly', () => {
    // A table with BOTH a vds and a vsb axis; declare only vds and let vsb default.
    const dev4 = generateDemoDevice({
      vds: { min: 0, max: 1.2, step: 0.3 },
      vsb: { min: 0, max: 0.6, step: 0.2 },
    });
    const doc = boundDoc({
      bind: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
    });
    const res = evaluateSheet(doc, dev4);
    expect(res.bind?.ok).toBe(true);
    expect(res.bind?.bias).toEqual({ vds: 0.6, vsb: 0 });
    expect(res.bind?.needs).toBeUndefined();
  });

  it('an undeclared vsb fails closed (not a silent clamp) when the table never characterizes 0', () => {
    // A back-biased-only table: the vsb sweep starts above 0, so "body-grounded" is unavailable.
    const dev4 = generateDemoDevice({
      vds: { min: 0, max: 1.2, step: 0.3 },
      vsb: { min: 0.2, max: 0.6, step: 0.2 },
    });
    const doc = boundDoc({
      bind: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
    });
    const res = evaluateSheet(doc, dev4);
    expect(res.bind?.ok).toBe(false);
    expect(res.bind?.needs).toEqual(['vsb']);
    expect(res.feasible).toBe(false);
  });

  it('a declaration the table cannot honor (no live axis) is advisory, not fatal', () => {
    const doc = boundDoc({
      bind: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
    });
    const res = evaluateSheet(doc, dev); // 2-D demo: no vds axis
    expect(res.bind?.ok).toBe(true);
    expect(res.bind?.bias).toBeUndefined();
    expect(res.warnings.some((w) => /no live vds axis/.test(w.message))).toBe(true);
  });

  it('an out-of-hull declaration is clamped with a warning, mirroring the L policy', () => {
    const doc = boundDoc({ bind: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '5' } });
    const res = evaluateSheet(doc, dev3);
    expect(res.bind?.ok).toBe(true);
    expect(res.warnings.some((w) => /outside the table's vds range/.test(w.message))).toBe(true);
  });

  it('a child fails closed on its own undeclared bias — the parent never lends it one', () => {
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'cs', doc: boundDoc({ provide: ['id'] }) }], // child binds without vds
    };
    const res = evaluateSheet(parent, dev3);
    expect(res.children?.[0].feasible).toBe(false);
    expect(res.children?.[0].bind?.needs).toEqual(['vds']);
    expect(res.feasible).toBe(false);
  });

  it('a child that declares its own vds sizes cleanly through composition', () => {
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [
        {
          name: 'cs',
          doc: boundDoc({
            bind: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.6' },
            provide: ['id'],
          }),
        },
      ],
    };
    const res = evaluateSheet(parent, dev3);
    expect(res.children?.[0].feasible).toBe(true);
    expect(res.children?.[0].bind?.bias).toEqual({ vds: 0.6 });
    expect(res.values.cs__id).toBeGreaterThan(0);
  });
});

describe('composition semantics (ratified)', () => {
  /** A minimal providing leaf: binds at a fixed current and exposes its outputs. */
  const leaf = (I: string): SheetDoc => ({
    title: 'leaf',
    polarity: 'n',
    params: [
      { name: 'I_bias', value: 20e-6 },
      { name: 'L', value: 0.5e-6 },
      { name: 'gm_id', value: 12 },
    ],
    bind: { L: 'L', id: I, gm_id: 'gm_id' },
    rows: [],
    rules: [],
    provide: ['id', 'gm', 'W'],
  });

  it('a LATER sibling may reference an EARLIER sibling provide (document order)', () => {
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [
        { name: 'a', doc: leaf('I_bias') },
        { name: 'b', doc: leaf('I_bias'), params: { I_bias: 'a__id / 2' } },
      ],
    };
    const res = runSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(res.values.b__id).toBeCloseTo(res.values.a__id / 2, 12);
    // the ratified direction produces no validator noise
    expect(validateSheet(doc).some((w) => w.rule === 'sheet-use-param')).toBe(false);
  });

  it('a FORWARD sibling reference fails closed at eval and is named statically by the validator', () => {
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [
        { name: 'b', doc: leaf('I_bias'), params: { I_bias: 'a__id / 2' } },
        { name: 'a', doc: leaf('I_bias') },
      ],
    };
    const res = runSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.children?.[0].feasible).toBe(false);
    expect(
      validateSheet(doc).some(
        (w) => w.rule === 'sheet-use-param' && /document order/.test(w.message),
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
      bind: { L: 'L', id: 'I_bias', gm_id: 'gm_id' },
      rows: [],
      rules: [],
      uses: [{ name: 'c', doc: leaf('I_bias'), params: { I_bias: 'W * 1e-3' } }],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.children?.[0].feasible).toBe(false); // W binds AFTER children — not in scope
    expect(res.feasible).toBe(false);
  });

  it('duplicate use names are skipped fail-closed even via the unvalidated entrypoint', () => {
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [
        { name: 'a', doc: leaf('I_bias') },
        { name: 'a', doc: leaf('I_bias / 2') },
      ],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.children?.[1].feasible).toBe(false);
    // the first block's provides are intact, not overwritten by the duplicate
    expect(res.values.a__id).toBeCloseTo(20e-6, 18);
  });

  it('re-exporting a grandchild provide is warning-free; a stray separator key still warns', () => {
    const mid: SheetDoc = {
      title: 'mid',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'g', doc: leaf('I_bias') }],
      provide: ['g__id'],
    };
    const top: SheetDoc = {
      title: 'top',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'm', doc: mid }],
    };
    expect(validateSheet(top).filter((w) => w.rule === 'sheet-provide')).toHaveLength(0);
    const res = runSheet(top, dev);
    expect(res.values.m__g__id).toBeCloseTo(20e-6, 18);
    // a separator key that matches nothing injectable is still flagged
    const bad: SheetDoc = { ...top, uses: [{ name: 'm', doc: { ...mid, provide: ['x__y'] } }] };
    expect(validateSheet(bad).some((w) => w.rule === 'sheet-provide')).toBe(true);
  });

  it('a composed sweep traces descendant HARD rules with path-prefixed ids', () => {
    const cascode = EXAMPLES.find((e) => e.title === 'NMOS cascode (gain-boosted output)')!;
    const sw = sweepSheet(cascode, 'gm_id', dev, 5);
    const ids = sw.rules.map((r) => r.id);
    expect(ids).toContain('cs-headroom'); // top-level rule, untouched
    expect(ids).toContain('cs.feasible-inversion'); // the child's own invariant, path-prefixed
    const child = sw.rules.find((r) => r.id === 'cs.feasible-inversion')!;
    expect(child.marginPct.filter((m) => m !== null).length).toBeGreaterThan(0);
  });
});

describe('a loop starved by a SIBLING is not accused of failing', () => {
  // The pass budget is shared so nesting cannot multiply the work without bound. The cost of that
  // is real: a loop that NESTS another re-converges the child on every one of its own passes, and
  // the product can spend the pool before a later sibling iterates at all. What must not happen is
  // the innocent sibling being told IT failed — an author would go and rewrite a sheet that is fine.
  const torn = (name: string, f: number, uses?: SheetDoc['uses']): SheetDoc => ({
    title: name,
    polarity: 'n',
    params: [{ name: 'x', value: 1, solveFor: 'fx' }],
    // |f'| just under 1: converging, but far too slowly to finish inside any cap.
    rows: [{ name: 'fx', expr: `${f}*x + 1` }],
    rules: [],
    provide: ['fx'],
    ...(uses ? { uses } : {}),
  });

  const res = evaluateSheet(
    {
      title: 'root',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [
        { name: 'eater', doc: torn('eater', 0.999, [{ name: 'sub', doc: torn('sub', 0.999) }]) },
        // Alone this closes in a handful of passes: |f'| = 0.3.
        { name: 'victim', doc: torn('victim', 0.3) },
      ],
    },
    dev,
  );
  const victim = res.warnings.find(
    (w) => w.rule === 'sheet-solve' && w.message.includes('"victim"'),
  )?.message;

  it('is starved to zero passes by the nested loop ahead of it', () => {
    expect(victim).toBeDefined();
    expect(victim).toMatch(/stopped after 0 pass/);
  });

  it('is told the budget went elsewhere, not that it failed to converge', () => {
    // The message must not ACCUSE a specific spender: an expensive sibling and a pin nesting
    // this loop under its probes are indistinguishable here, and "another loop, not this one"
    // was provably false for the pin-over-torn case.
    expect(victim).toMatch(/budget ran out/);
    expect(victim).toMatch(/not shown to diverge/);
    expect(victim).not.toMatch(/diverging/);
    expect(victim).not.toMatch(/did not reach tolerance/);
  });
});

describe('duplicate rule ids', () => {
  it('are a validation error — results are keyed by id, so one would shadow the other', () => {
    // Two rules named "same": indexTreeResults Map.set-collapses them, the sweep charts one
    // curve where two exist, and bindingConstraint can name the WRONG worst rule.
    const doc: SheetDoc = {
      title: 'dup',
      polarity: 'n',
      params: [{ name: 'a', value: 1 }],
      rows: [],
      rules: [
        { id: 'same', kind: 'requirement', lhs: 'a', op: '>=', rhs: '100' },
        { id: 'same', kind: 'requirement', lhs: 'a', op: '>=', rhs: '1' },
      ],
    };
    expect(
      validateSheet(doc).some(
        (w) => w.severity === 'error' && /duplicate rule id "same"/.test(w.message),
      ),
    ).toBe(true);
  });
});

describe('bindingConstraint — naming the cause of one verdict', () => {
  const ex = EXAMPLES.find((e) => e.title === 'NMOS noise & matching')!;
  // Force the noise requirement to fail hard, and the matching one to fail harder.
  const at = (o: Record<string, number>): SheetDoc => ({
    ...ex,
    params: ex.params.map((p) => (o[p.name] !== undefined ? { ...p, value: o[p.name] } : p)),
  });

  it('names the worst-margin failing hard rule, ignoring advisory guardrails', () => {
    const res = runSheet(at({ vn_target: 1e-12, vos_target: 1e-9 }), dev);
    expect(res.feasible).toBe(false);
    const b = bindingConstraint(res);
    const named = res.rules.find((r) => r.id === b?.id);
    expect(named?.status).toBe('fail');
    expect(isHardRule(named!.kind)).toBe(true);
    // It is the WORST one, not merely a failing one.
    const worst = Math.min(
      ...res.rules.filter((r) => isHardRule(r.kind) && r.status === 'fail').map((r) => r.marginPct),
    );
    expect(b?.marginPct).toBe(worst);
  });

  it('is undefined when no hard rule fails — never a feasibility verdict of its own', () => {
    expect(bindingConstraint(runSheet(ex, dev))).toBeUndefined();
    // A tree with no rules at all is the degenerate case, not an error.
    expect(bindingConstraint({ rules: [] })).toBeUndefined();
  });

  it('attributes a child block rule by its use path, and outranks a milder top-level one', () => {
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [{ name: 'x', value: 1 }],
      rows: [],
      // Fails by 90%: the worst rule in the tree, and it lives below the top sheet.
      rules: [{ id: 'child-floor', kind: 'invariant', lhs: 'x', op: '>=', rhs: '10' }],
      provide: [],
    };
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [{ name: 'y', value: 9 }],
      rows: [],
      // Fails by only 10%, so a walk that stopped at the top would name this one.
      rules: [{ id: 'top-floor', kind: 'requirement', lhs: 'y', op: '>=', rhs: '10' }],
      uses: [{ name: 'k', doc: child }],
    };
    const b = bindingConstraint(runSheet(parent, dev));
    expect(b?.id).toBe('k.child-floor');
    expect(b?.marginPct).toBeCloseTo(-0.9, 6);
  });
});

describe('sweepSheet2 — the design-plane feasibility map', () => {
  const ex = EXAMPLES.find((e) => e.title === 'NMOS noise & matching')!;

  it('agrees pointwise with runSheet and names the binding hard rule per infeasible cell', () => {
    const sw = sweepSheet2(ex, 'gm_id', 'L', dev, 5);
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
      const ref = runSheet(at, dev);
      expect(sw.feasible[yi][xi]).toBe(ref.feasible);
      if (!ref.feasible && sw.binding[yi][xi] !== null) {
        // the named binding rule really is a failing hard rule at that point
        const named = ref.rules.find((r) => r.id === sw.binding[yi][xi]);
        expect(named?.status).toBe('fail');
        expect(named?.kind).not.toBe('guardrail');
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
      bind: { L: 'L', id: 'I_bias', gm_id: 'gm_id' },
      rows: [],
      rules: [],
      provide: ['id'],
    };
    const doc: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [{ name: 'I_tail', value: 40e-6 }],
      rows: [],
      rules: [],
      uses: [{ name: 'cs', doc: child, params: { I_bais: 'I_tail / 2' } }], // typo: I_bais
    };
    const res = runSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.children?.[0].feasible).toBe(false);
    expect(res.values.cs__id).toBeUndefined(); // provides withheld, not the 20µA default
    expect(
      res.warnings.some(
        (w) => w.rule === 'sheet-use-param' && w.severity === 'error' && /I_bais/.test(w.message),
      ),
    ).toBe(true);
    // and the validator names it statically as an error too
    expect(
      validateSheet(doc).some((w) => w.rule === 'sheet-use-param' && w.severity === 'error'),
    ).toBe(true);
  });

  it('an out-of-range bind bias reports the APPLIED clamped coordinate, not the request', () => {
    const dev3 = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });
    const doc = boundDoc({
      bind: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '5' },
    });
    const res = evaluateSheet(doc, dev3);
    expect(res.bind?.ok).toBe(true);
    expect(res.bind?.bias).toEqual({ vds: 1.2 }); // the slice actually used
    expect(res.warnings.some((w) => /vds 5 is outside/.test(w.message))).toBe(true);
  });
});

describe('diode-connected bind', () => {
  const diodeDoc = (extra: Record<string, unknown> = {}): SheetDoc => ({
    title: 'd',
    polarity: 'n',
    params: [
      { name: 'L', value: 0.5e-6 },
      { name: 'I', value: 10e-6 },
      { name: 'gm_id', value: 10 },
    ],
    bind: { L: 'L', id: 'I', gm_id: 'gm_id', diode: true, ...extra },
    rows: [],
    rules: [],
  });

  it('lands on the vds = vgs diagonal, matching a fixed slice taken at the answer', () => {
    const res = runSheet(diodeDoc(), dev);
    expect(res.bind?.ok).toBe(true);
    const vgs = res.bind!.vgs;
    // Re-size the SAME device with vds pinned to the drop the diagonal produced. If the fold is
    // right the two agree; a diagonal that silently used some other vds would not.
    const fixed = runSheet(
      {
        ...diodeDoc(),
        params: [...diodeDoc().params, { name: 'v', value: vgs }],
        bind: { L: 'L', id: 'I', gm_id: 'gm_id', vds: 'v' },
      },
      dev,
    );
    expect(fixed.bind?.ok).toBe(true);
    const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30);
    expect(rel(fixed.bind!.vgs, vgs)).toBeLessThan(1e-3);
    expect(rel(fixed.bind!.W, res.bind!.W)).toBeLessThan(1e-3);
  });

  it('reports no single vds coordinate, because the diagonal has none', () => {
    // The applied vds moves with vgs across the fold, so one number in the report would be a
    // coordinate that is true nowhere. It must not be silently invented either.
    const res = runSheet(diodeDoc(), dev);
    expect(res.bind?.bias?.vds).toBeUndefined();
    expect(res.bind?.assumed ?? []).not.toContain('vds');
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

  it('refuses a bind that declares both the connection and a vds', () => {
    const errs = validateSheet(diodeDoc({ vds: '0.5' })).filter((w) => w.severity === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/both a diode connection and a vds/);
  });

  it('warns rather than fails when the table has no vds axis to fold', () => {
    const res = runSheet(diodeDoc(), withoutColumns(fixTable(dev, { vds: 0.9 }), []));
    expect(res.bind?.ok).toBe(true);
    expect(res.warnings.some((w) => /no live vds axis to fold/.test(w.message))).toBe(true);
  });
});

describe('pinned params — bracketed inversion of a monotone relation', () => {
  const mk = (
    expr: string,
    pin: { lhs: string; rhs: string },
    bounds: { min?: number; max?: number } = { min: 0, max: 10 },
  ): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    params: [
      { name: 'x', value: 1, ...bounds, pin },
      { name: 'T', value: 5 },
    ],
    rows: [{ name: 'y', expr }],
    rules: [],
  });

  // Precision below is PIN_TOL_REL x the bracket's span (1e-6 x 10): the root lands anywhere
  // inside the final bracket, so 4 digits is what a volt-scale bracket honestly guarantees.
  it('inverts an increasing relation to the root, from no starting guess at all', () => {
    const res = evaluateSheet(mk('2*x + 1', { lhs: 'y', rhs: 'T' }), dev);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(2, 4);
  });

  it('handles a DECREASING relation identically — bisection only needs a sign change', () => {
    const res = evaluateSheet(mk('9 - x', { lhs: 'y', rhs: 'T' }), dev);
    expect(res.values.x).toBeCloseTo(4, 4);
  });

  it('accepts a correct root written in RESIDUAL form (rhs = 0)', () => {
    // The residual scale is the relation's range over the bracket, not |lhs| at the root —
    // scaling by |lhs| rejected every pin whose lhs IS the residual (it vanishes at the root).
    const res = evaluateSheet(mk('2*x + 1', { lhs: 'y - T', rhs: '0' }), dev);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(2, 4);
  });

  it('closes on a root at ZERO — the bracket test is span-relative, not iterate-relative', () => {
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

  it('fails closed on a HALF-WRITTEN pin instead of silently freezing the param', () => {
    // {lhs} without {rhs} fails the pinned() shape guard: without this check the param would be
    // neither swept nor solved — stuck at its authored value with the sheet reading feasible.
    const doc = mk('2*x + 1', { lhs: 'y' } as unknown as { lhs: string; rhs: string });
    expect(
      validateSheet(doc).some(
        (w) => w.severity === 'error' && /pin needs both lhs and rhs/.test(w.message),
      ),
    ).toBe(true);
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.some((w) => /pin needs both lhs and rhs/.test(w.message))).toBe(true);
  });

  it('fails closed when the bracket does not straddle the target', () => {
    const res = evaluateSheet(mk('x + 20', { lhs: 'y', rhs: 'T' }), dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(
      /does not change sign/,
    );
  });

  it('refuses a JUMP: the bracket closes but nothing in it produces the target', () => {
    // A discontinuity steps across the target; bisection converges to the step, and shipping
    // that point would size the design at an operating point that does not exist.
    const res = evaluateSheet(mk('x < 3 ? 0 : 10', { lhs: 'y', rhs: 'T' }), dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(
      /steps across the target/,
    );
  });

  it('names the bracket end where the relation stops evaluating', () => {
    const res = evaluateSheet(mk('sqrt(x - 1)', { lhs: 'y', rhs: '0.5' }), dev);
    expect(res.feasible).toBe(false);
    expect(res.warnings.find((w) => w.rule === 'sheet-solve')?.message).toMatch(/low end/);
  });

  it('is not sweepable, and its min/max are the bracket rather than slider bounds', () => {
    const p = mk('2*x + 1', { lhs: 'y', rhs: 'T' }).params[0];
    expect(sweepable(p)).toBe(false);
  });

  it('validation refuses a missing bracket, a second pin, and a pin that is also torn', () => {
    const noBracket = mk('2*x + 1', { lhs: 'y', rhs: 'T' }, {});
    expect(
      validateSheet(noBracket).some(
        (w) => w.severity === 'error' && /bisection bracket/.test(w.message),
      ),
    ).toBe(true);
    const two: SheetDoc = {
      ...noBracket,
      params: [
        { name: 'x', value: 1, min: 0, max: 1, pin: { lhs: 'y', rhs: 'T' } },
        { name: 'z', value: 1, min: 0, max: 1, pin: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
      ],
    };
    expect(
      validateSheet(two).some((w) => w.severity === 'error' && /scalar method/.test(w.message)),
    ).toBe(true);
    const both: SheetDoc = {
      ...noBracket,
      params: [
        { name: 'x', value: 1, min: 0, max: 1, pin: { lhs: 'y', rhs: 'T' }, solveFor: 'y' },
        { name: 'T', value: 5 },
      ],
    };
    expect(
      validateSheet(both).some((w) => w.severity === 'error' && /keep one solver/.test(w.message)),
    ).toBe(true);
  });

  it('solves the pin AND an inner torn loop together, off one budget', () => {
    // The pin is the outer solver; each probe re-closes the substitution loop inside.
    const doc: SheetDoc = {
      title: 'both',
      polarity: 'n',
      params: [
        { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
        { name: 'e', value: 0, solveFor: 'fe' },
      ],
      rows: [
        { name: 'fe', expr: '0.5*e + x' }, // fixed point: e = 2x
        { name: 'y', expr: 'fe - x + 1' }, // = x + 1 at the fixed point → x = 4
      ],
      rules: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(4, 4);
    expect(res.values.e).toBeCloseTo(8, 4);
  });
});

describe('containment edges — exact range checks folded into the verdict', () => {
  // Mirrors the library's CM idiom: x is the internal node the pin solves, y = 2x + 1 the
  // produced output, T the typed spec, [T_lo, T_hi] the claimed range the edges check.
  const mk = (over: Partial<SheetDoc> = {}): SheetDoc => ({
    title: 'e',
    polarity: 'n',
    params: [
      { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'T' } },
      { name: 'T', value: 5 },
      { name: 'T_lo', value: 3 },
      { name: 'T_hi', value: 7 },
      // max deliberately OFF the lo edge's landing point (x = 1): a sweep sample exactly on
      // a bound would coin-flip on the pin's ~1e-5 landing tolerance.
      { name: 'x_floor', value: 0.5, min: 0, max: 1.6 },
    ],
    rows: [{ name: 'y', expr: '2*x + 1' }],
    rules: [{ id: 'node-floor', kind: 'invariant', lhs: 'x', op: '>=', rhs: 'x_floor' }],
    edges: [
      { name: 'lo', set: { T: 'T_lo' } },
      { name: 'hi', set: { T: 'T_hi' } },
    ],
    ...over,
  });

  it('re-solves the pin at each edge and reports where it landed', () => {
    const res = runSheet(mk(), dev);
    expect(res.feasible).toBe(true);
    expect(res.values.x).toBeCloseTo(2, 4); // base: y = 5 → x = 2
    expect(res.edges?.map((e) => e.name)).toEqual(['lo', 'hi']);
    expect(res.edges?.[0].feasible).toBe(true);
    expect(res.edges?.[0].solved.x).toBeCloseTo(1, 4); // y = 3 → x = 1
    expect(res.edges?.[1].solved.x).toBeCloseTo(3, 4); // y = 7 → x = 3
  });

  it('never throws on malformed edges — half-written or mistyped shapes degrade', () => {
    // evaluate's contract is never-throw; curated JSON bypasses the sanitizer, so a
    // half-written edge (no set) or a mistyped edges field must not TypeError.
    expect(() => evaluateSheet(mk({ edges: [{ name: 'lo' } as never] }), dev)).not.toThrow();
    expect(() => evaluateSheet(mk({ edges: 'garbage' as never }), dev)).not.toThrow();
    const res = evaluateSheet(mk({ edges: 'garbage' as never }), dev);
    expect(res.edges).toBeUndefined(); // degrades to a plain evaluation
  });

  it('the report says WHICH point was checked, and never fabricates a landing', () => {
    const ok = evaluateSheet(mk(), dev);
    expect(ok.edges?.[0].set).toEqual({ T: 3 }); // the resolved override, not the expression
    expect(ok.edges?.[0].warnings).toEqual([]);
    const doc = mk();
    doc.params.find((p) => p.name === 'T_lo')!.value = 0.5; // unreachable edge
    const bad = evaluateSheet(doc, dev);
    expect(bad.edges?.[0].solved).toEqual({}); // a bracket end is not a landing
  });

  it('a rule failing ONLY at an edge fails the sheet, and the binding id names the edge', () => {
    const doc = mk();
    doc.params.find((p) => p.name === 'x_floor')!.value = 1.5; // base x=2 passes; lo edge x=1 fails
    const res = evaluateSheet(doc, dev);
    expect(res.rules.every((r) => r.status === 'pass' || r.status === 'amber')).toBe(true);
    expect(res.feasible).toBe(false);
    expect(res.edges?.[0].feasible).toBe(false);
    expect(bindingConstraint(res)?.id).toBe('lo@node-floor');
  });

  it('an edge the bracket cannot reach fails with the solver reason, verbatim', () => {
    const doc = mk();
    doc.params.find((p) => p.name === 'T_lo')!.value = 0.5; // y spans [1, 21]: unreachable
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.edges?.[0].error).toMatch(/does not change sign/);
    // no failing RULE anywhere — the cause is the solve, so there is no rule to name
    expect(bindingConstraint(res)).toBeUndefined();
    // the failed edge does not leak error warnings into the base result
    expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  });

  it('set expressions evaluate against the BASE result, not just params', () => {
    const doc = mk({
      edges: [{ name: 'lo', set: { T: 'y - 2' } }], // base y = 5 → edge T = 3
    });
    const res = evaluateSheet(doc, dev);
    expect(res.edges?.[0].solved.x).toBeCloseTo(1, 4);
  });

  it('a set expression that does not resolve fails that edge closed, by name', () => {
    const doc = mk({ edges: [{ name: 'lo', set: { T: 'nonsense_name' } }] });
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.edges?.[0].error).toMatch(/did not evaluate to a finite number/);
  });

  it('an infeasible edge can NEVER chart non-negative — na fails it closed, on-chart', () => {
    // Hard `na` fails an edge closed while contributing no margin; without the floor a
    // passing sibling rule painted the broken edge at +margin — a feasibility flip with
    // no on-chart cause. sqrt(6 - T) is finite at the base (T=5) and lo edge (T=3), na
    // at the hi edge (T=7).
    const doc = mk({
      rules: [
        { id: 'node-floor', kind: 'invariant', lhs: 'x', op: '>=', rhs: 'x_floor' },
        { id: 'na-at-hi', kind: 'invariant', lhs: 'sqrt(6 - T)', op: '>=', rhs: '0' },
      ],
    });
    const res = evaluateSheet(doc, dev);
    expect(res.feasible).toBe(false);
    expect(res.edges?.[1].feasible).toBe(false);
    const sw = sweepSheet(doc, 'x_floor', dev, 2);
    const hiCurve = sw.rules.find((r) => r.id === 'hi@');
    expect(hiCurve!.marginPct.every((m) => m !== null && m < 0)).toBe(true);
  });

  it("edge.error prefers the SOLVER's message over whatever error landed last", () => {
    // A child's pin failure rolls up mid-evaluation; a later parent row goes non-finite
    // AFTER it. "Last error" alone would report the consequence (the row) instead of the
    // cause (the solve).
    const child: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [
        { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'P' } },
        { name: 'P', value: 5 },
      ],
      rows: [{ name: 'y', expr: '2*x + 1' }],
      rules: [],
    };
    const parent: SheetDoc = {
      title: 'p',
      polarity: 'n',
      params: [
        { name: 'T', value: 5 },
        { name: 'T_hi', value: 25 }, // child y spans [1, 21]: unreachable at the edge
      ],
      rows: [{ name: 'bad', expr: 'sqrt(21 - T)' }], // non-finite at T = 25, fine at 5
      rules: [],
      uses: [{ name: 'amp', doc: child, params: { P: 'T' } }],
      edges: [{ name: 'hi', set: { T: 'T_hi' } }],
    };
    const res = evaluateSheet(parent, dev);
    expect(res.edges?.[0].feasible).toBe(false);
    expect(res.edges?.[0].error).toMatch(/pinned param|does not change sign/);
  });

  it('a snapped zero reads amber for EVERY operator — == included', () => {
    // 1.010005 == 1 at tolPct 1 sits ~5e-6 OUTSIDE its band: genuinely failing, inside
    // the snap. Reading it full pass would silently hide the miss; amber says "on the
    // boundary". Clearly outside the snap still fails.
    const eq = (lhs: string): SheetDoc => ({
      title: 'q',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [{ id: 'eq', kind: 'requirement', lhs, op: '==', rhs: '1', tolPct: 1 }],
    });
    expect(evaluateSheet(eq('1.010005'), dev).rules[0].status).toBe('amber');
    expect(evaluateSheet(eq('1.02'), dev).rules[0].status).toBe('fail');
    // The inequality face of the same coin: a sub-snap genuine shortfall reads amber.
    const ge: SheetDoc = {
      title: 'g',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [{ id: 'ge', kind: 'requirement', lhs: '0.999995', op: '>=', rhs: '1' }],
    };
    expect(evaluateSheet(ge, dev).rules[0].status).toBe('amber');
  });

  it("a composed child's edges are ignored, and validation says so", () => {
    const child = mk();
    child.params.find((p) => p.name === 'T_lo')!.value = 0.5; // its lo edge would fail hard
    child.provide = ['y'];
    const parent: SheetDoc = {
      title: 'parent',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [],
      uses: [{ name: 'amp', doc: child }],
    };
    const res = runSheet(parent, dev);
    expect(res.feasible).toBe(true); // the child's base run closes; its edges never ran
    expect(res.children?.[0].feasible).toBe(true);
    expect(res.warnings.some((w) => /not evaluated in composition/.test(w.message))).toBe(true);
  });

  it('a swept cell agrees with the same values evaluated alone, and the edge curve shows why', () => {
    const doc = mk();
    const sw = sweepSheet(doc, 'x_floor', dev, 3); // samples 0, 0.8, 1.6
    expect(sw.feasible).toEqual([true, true, false]); // at 1.6: lo edge x=1 < 1.6
    const alone = evaluateSheet(withParams(doc, { x_floor: 1.6 }), dev);
    expect(alone.feasible).toBe(false);
    const loCurve = sw.rules.find((r) => r.id === 'lo@');
    expect(loCurve).toBeDefined();
    expect(loCurve!.marginPct[2]).toBeLessThan(0); // the on-chart cause of the flip
    expect(loCurve!.marginPct[0]).toBeGreaterThan(0);
  });

  it('use names reserve the rule-path separators — a collision would shadow rule results', () => {
    // Rule outcomes are keyed `${usePath}.${ruleId}` and `${edgeName}@${ruleId}` in one map;
    // a use named across either separator could silently shadow an edge-qualified id.
    const child: SheetDoc = { title: 'c', polarity: 'n', params: [], rows: [], rules: [] };
    for (const name of ['a@b', 'a.b']) {
      const doc: SheetDoc = {
        title: 'p',
        polarity: 'n',
        params: [],
        rows: [],
        rules: [],
        uses: [{ name, doc: child }],
      };
      const hit = validateSheet(doc).some(
        (w) => w.severity === 'error' && /tree-keyed rule ids/.test(w.message),
      );
      expect(hit, name).toBe(true);
    }
  });

  it('validateSheet rejects malformed edges and reserves the @ separator', () => {
    const errs = (doc: SheetDoc): string[] =>
      validateSheet(doc)
        .filter((w) => w.severity === 'error')
        .map((w) => w.message);
    expect(
      errs(
        mk({
          edges: [
            { name: 'lo', set: { T: 'T_lo' } },
            { name: 'lo', set: { T: 'T_hi' } },
          ],
        }),
      ).join(),
    ).toMatch(/duplicate edge name/);
    expect(errs(mk({ edges: [{ name: 'a@b', set: { T: 'T_lo' } }] })).join()).toMatch(
      /must not contain/,
    );
    expect(errs(mk({ edges: [{ name: 'lo', set: {} }] })).join()).toMatch(/sets nothing/);
    expect(errs(mk({ edges: [{ name: 'lo', set: { nope: 'T_lo' } }] })).join()).toMatch(
      /not a param/,
    );
    expect(errs(mk({ edges: [{ name: 'lo', set: { x: 'T_lo' } }] })).join()).toMatch(
      /the engine solves/,
    );
    expect(errs(mk({ edges: [{ name: 'lo', set: { T: 'T_lo +* 2' } }] })).join()).toMatch(
      /does not parse/,
    );
    expect(
      errs(mk({ rules: [{ id: 'a@b', kind: 'invariant', lhs: 'x', op: '>=', rhs: '0' }] })).join(),
    ).toMatch(/tree-keyed rule ids/);
    expect(
      errs(mk({ rules: [{ id: 'a.b', kind: 'invariant', lhs: 'x', op: '>=', rhs: '0' }] })).join(),
    ).toMatch(/tree-keyed rule ids/);
  });
});

describe('gate wiring — the node a child sits on, declared and checked', () => {
  /** A child that SIZES. The identity is checked against the voltage the BIND resolved to, so
   *  the number under test is the sizing's own answer — a `provide` list is deliberately absent
   *  here, because nothing the child publishes upward takes part in the check. */
  const boundChild = (polarity: 'n' | 'p' = 'n', gmId = 10): SheetDoc => ({
    title: 'dev',
    polarity,
    params: [
      { name: 'L', value: 0.5e-6 },
      { name: 'gm_id', value: gmId },
      { name: 'Ib', value: 20e-6 },
    ],
    bind: { L: 'L', id: 'Ib', gm_id: 'gm_id' },
    rows: [],
    rules: [],
  });

  /** A parent tying one such child between two nodes. */
  const wired = (
    gate: string,
    source: string,
    child: SheetDoc,
    extra: Partial<SheetDoc> = {},
    device?: string,
  ): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    params: [{ name: 'VDD', value: 1.8 }],
    rows: [],
    rules: [],
    uses: [{ name: 'm', doc: child, ...(device ? { device } : {}), wiring: { gate, source } }],
    ...extra,
  });

  const wiringWarnings = (r: SheetResult): string[] =>
    r.warnings.filter((w) => w.rule === 'sheet-wiring').map((w) => w.message);

  /** The vgs the child's bind actually landed on — the quantity the check reads. */
  const sizedVgs = (doc: SheetDoc, table = dev, resolve?: (id: string) => DeviceTable): number =>
    evaluateSheet(doc, table, resolve).children![0].bind!.vgs;

  it('passes just inside the tolerance and reports just outside it', () => {
    // 10 mV absolute (WIRING_TOL): the real disagreements this catches are tens to hundreds of
    // millivolts, and a bias plan is written to about this resolution.
    expect(WIRING_TOL).toBe(0.01);
    const child = boundChild();
    const v = sizedVgs(wired('0', '0', child));
    expect(v).toBeGreaterThan(0.4);

    expect(wiringWarnings(evaluateSheet(wired(`${v + 0.0099}`, '0', child), dev))).toEqual([]);

    const off = evaluateSheet(wired(`${v + 0.0101}`, '0', child), dev);
    expect(wiringWarnings(off)).toHaveLength(1);
    // Both numbers AND the delta — a warning that only says "disagrees" cannot be acted on.
    expect(wiringWarnings(off)[0]).toContain((v + 0.0101).toExponential(4));
    expect(wiringWarnings(off)[0]).toContain(v.toExponential(4));
    expect(wiringWarnings(off)[0]).toContain('delta 1.010e-2 V');
  });

  it('checks a child that publishes NOTHING — the bind is what it reads', () => {
    // The identity used to be arithmetic over a `<use>__vgs` scalar, which quietly made the check
    // depend on an author remembering to add 'vgs' to that block's provide list. This child
    // provides nothing at all, and is checked anyway.
    const child = boundChild();
    expect(child.provide).toBeUndefined();
    const v = sizedVgs(wired('0', '0', child));
    expect(wiringWarnings(evaluateSheet(wired(`${v}`, '0', child), dev))).toEqual([]);
    expect(wiringWarnings(evaluateSheet(wired(`${v + 0.5}`, '0', child), dev))).toHaveLength(1);
  });

  it('reads the same node in all four polarity/table-convention combinations', () => {
    // The direction comes from the child's declared polarity and the magnitude from its bind, so
    // a signed PMOS export (negative vgs axis) and one in N convention (positive) check
    // identically. That is the whole reason no author-written sign expression exists: a wrong one
    // would silently INVERT the identity and report agreement on a design wired backwards.
    const pmos = signedMirrorDemo(dev);
    const resolve = (id: string): DeviceTable => (id === 'signed' ? pmos : dev);
    for (const polarity of ['n', 'p'] as const) {
      for (const device of [undefined, 'signed'] as const) {
        const where = `${polarity} child, ${device ?? 'N-convention'} table`;
        const child = boundChild(polarity);
        const v = sizedVgs(wired('0', 'VDD', child, {}, device), dev, resolve);
        // The four cells really are different data: only the signed export returns a negative
        // axis value, and the identity below never looks at that sign.
        expect(`${where}: ${v < 0}`).toBe(`${where}: ${device === 'signed'}`);

        const dir = polarity === 'p' ? -1 : 1;
        const node = 1.8 + dir * Math.abs(v);
        const agrees = evaluateSheet(wired(`${node}`, 'VDD', child, {}, device), dev, resolve);
        expect(`${where}: ${wiringWarnings(agrees).length}`).toBe(`${where}: 0`);
        // Wired the other way — the error the removed sign expression made possible — is reported.
        const flipped = evaluateSheet(
          wired(`${1.8 - dir * Math.abs(v)}`, 'VDD', child, {}, device),
          dev,
          resolve,
        );
        expect(`${where}: ${wiringWarnings(flipped).length}`).toBe(`${where}: 1`);
      }
    }
  });

  it('never touches the verdict — a disagreement is a warning, never a feasibility flip', () => {
    // The escalation path is documented instead: an author who wants it to gate writes a hard
    // rule on the same two numbers.
    const res = evaluateSheet(wired('1.2', '0', boundChild()), dev);
    expect(wiringWarnings(res)).toHaveLength(1);
    expect(res.warnings.every((w) => w.severity !== 'error')).toBe(true);
    expect(res.feasible).toBe(true);
  });

  it('reaches a gate node the sheet defines as a ROW, not only as a param', () => {
    // Rows run AFTER children, so a node the parent derives from a child's own output only
    // exists at the end of the evaluation. The check runs there for exactly this reason.
    const child = { ...boundChild(), provide: ['vgs'] };
    const doc = wired('V_in', '0', child, { rows: [{ name: 'V_in', expr: 'm__vgs' }] });
    const res = evaluateSheet(doc, dev);
    expect(wiringWarnings(res)).toEqual([]);
    expect(res.values.V_in).toBeCloseTo(sizedVgs(doc), 12);
  });

  it('says the block has no sized gate-source voltage when it declares no bind', () => {
    const bindless: SheetDoc = {
      title: 'dev',
      polarity: 'n',
      params: [],
      rows: [{ name: 'vgs', expr: '0.65' }],
      rules: [],
      provide: ['vgs'],
    };
    // The block publishes a `vgs` scalar and is STILL not checked against it: a row named vgs is
    // an author's arithmetic, not a sized operating point.
    const res = evaluateSheet(wired('0.65', '0', bindless), dev);
    expect(wiringWarnings(res)[0]).toMatch(/no bind, so it has no sized gate-source voltage/);
    expect(res.values.m__vgs).toBeCloseTo(0.65, 12);
  });

  it('stays silent about a block whose own evaluation already failed', () => {
    // A child that could not size has no operating point to check against, and the bind error
    // says so already — under the child's PATH (`m.bind`), not the bare use name. Advising the
    // author about the wiring here would stack a second, wrong finding on the real one.
    const broken: SheetDoc = { ...boundChild(), bind: { L: 'L', id: 'Ib', gm_id: 'nope' } };
    const res = evaluateSheet(wired('0.65', '0', broken), dev);
    expect(res.warnings.some((w) => w.severity === 'error' && w.location === 'm.bind')).toBe(true);
    expect(wiringWarnings(res)).toEqual([]);
  });

  it('reports an unresolvable wiring expression instead of failing the sheet', () => {
    const res = evaluateSheet(wired('nope', '0', boundChild()), dev);
    expect(wiringWarnings(res)[0]).toMatch(/gate "nope" did not resolve/);
    // The dedicated evaluator emits ONLY sheet-wiring warnings — no undeclared-name error
    // leaks out of it to fail the design closed.
    expect(res.warnings.every((w) => w.severity === 'warning')).toBe(true);
    expect(res.feasible).toBe(true);
  });

  it('degrades instead of throwing on malformed wiring', () => {
    const half = wired('0.65', '0', boundChild());
    half.uses![0].wiring = { gate: 5 } as unknown as { gate: string; source: string };
    expect(() => evaluateSheet(half, dev)).not.toThrow();
    expect(wiringWarnings(evaluateSheet(half, dev))[0]).toMatch(/gate is not an expression/);

    const garbage = wired('0.65', '0', boundChild());
    garbage.uses![0].wiring = 'garbage' as unknown as { gate: string; source: string };
    expect(() => evaluateSheet(garbage, dev)).not.toThrow();
    expect(wiringWarnings(evaluateSheet(garbage, dev))).toEqual([]); // nothing to check
    expect(validateSheet(garbage).some((w) => /wiring must be an object/.test(w.message))).toBe(
      true,
    );
  });

  it('reports the LANDED design once, not a bracket end and not every probe', () => {
    // A pinned parent bisects its whole tree ~20 times. Wiring the gate to the pinned node makes
    // the reported numbers say WHERE the check ran: at the landing (0.4713) the delta is the
    // distance from there to the sized vgs, where the bracket ends (0 and 1) would give a very
    // different pair. So this pins the placement, not merely the count — a check running inside
    // the solve would report a probe's voltage.
    const doc = wired('x', '0', boundChild(), {
      params: [{ name: 'x', value: 0.5, min: 0, max: 1, pin: { lhs: 'x2', rhs: '0.4713' } }],
      rows: [{ name: 'x2', expr: 'x' }],
    });
    const res = evaluateSheet(doc, dev);
    expect(res.values.x).toBeCloseTo(0.4713, 5);
    expect(wiringWarnings(res)).toHaveLength(1);
    expect(wiringWarnings(res)[0]).toMatch(/gate reads 4\.713\de-1 V/);
    expect(wiringWarnings(res)[0]).toContain((0.4713 - sizedVgs(doc)).toExponential(3));
  });

  it('reports once per RUN when the sheet also claims a range through edges', () => {
    // Base plus one edge = two lines about the same declaration, and that is the intent: a range
    // end re-settles the same hardware at a different bias, so its residual is a measurement of
    // the same wire under different conditions. An edge run's warnings ride its own report
    // verbatim, so the second copy is not a duplicate of the first — it belongs to a different
    // evaluation.
    const doc = wired('0', '0', boundChild(), {
      params: [
        { name: 'VDD', value: 1.8 },
        { name: 'I_lo', value: 10e-6 },
      ],
      edges: [{ name: 'lo', set: { VDD: 'I_lo' } }],
    });
    const res = evaluateSheet(doc, dev);
    expect(wiringWarnings(res)).toHaveLength(1);
    expect(res.edges![0].warnings.filter((w) => w.rule === 'sheet-wiring')).toHaveLength(1);
  });

  it('makes structural wiring problems validation ERRORS', () => {
    const errs = (w: unknown): string[] =>
      validateSheet(
        wired('0.65', '0', boundChild(), {
          uses: [{ name: 'm', doc: boundChild(), wiring: w as { gate: string; source: string } }],
        }),
      )
        .filter((v) => v.rule === 'sheet-wiring' && v.severity === 'error')
        .map((v) => v.message);

    // Half-declared: the pin discipline — a declaration missing a side checks nothing while
    // looking like it does.
    expect(errs({ gate: 'VDD' }).join()).toMatch(
      /needs both gate and source \(source is missing\)/,
    );
    expect(errs({ source: 'VDD' }).join()).toMatch(/\(gate is missing\)/);
    // Strict keys, like BIND_KEYS/EDGE_KEYS: a typo must not silently drop half the identity —
    // and a `sign` expression, which this check deliberately does not take, is named rather
    // than ignored.
    expect(errs({ gate: 'VDD', source: '0', polarity: 'p' }).join()).toMatch(
      /unknown key "polarity"/,
    );
    expect(errs({ gate: 'VDD', source: '0', sign: '-1' }).join()).toMatch(/unknown key "sign"/);
    expect(errs({ gate: '1 +', source: '0' }).join()).toMatch(
      /gate expression "1 \+" does not parse/,
    );
    // A well-formed declaration raises none of them.
    expect(errs({ gate: 'VDD', source: '0' })).toEqual([]);
  });
});

describe('rawMargin — the honest distance beside the snapped one', () => {
  it('survives the near-zero snap', () => {
    const doc: SheetDoc = {
      title: 'snap',
      polarity: 'n',
      params: [{ name: 'a', value: 1 }],
      rows: [],
      rules: [{ id: 'r', kind: 'requirement', lhs: 'a', op: '>=', rhs: 'a + 1e-9' }],
    };
    const r = evaluateSheet(doc).rules[0];
    // The verdict reads the boundary it is parked on; a DERIVATIVE would read zero slope from
    // that and conclude the rule cannot be moved.
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
      rows: [],
      rules: [{ id: 'r', kind: 'requirement', lhs: 'nope', op: '>=', rhs: '0' }],
    };
    const r = evaluateSheet(doc).rules[0];
    expect(r.status).toBe('na');
    expect(Number.isNaN(r.rawMargin)).toBe(true);
  });
});

describe('solver pass count — a loop that closes slowly says so', () => {
  /** Fixed point 1, contracting at exactly |f'| = k per pass, started 0.9 away. */
  const geometric = (k: number): SheetDoc => ({
    title: 'g',
    polarity: 'n',
    params: [{ name: 'x', value: 0.1, solveFor: 'f' }],
    rows: [{ name: 'f', expr: `${k}*x + ${1 - k}` }],
    rules: [],
  });
  const note = (doc: SheetDoc) =>
    evaluateSheet(doc).warnings.find((w) => w.rule === 'sheet-solve' && w.severity === 'info');

  it('notes a weak contraction that needed many passes', () => {
    const slow = note(geometric(0.6)); // ~32 passes to SOLVE_TOL_REL
    expect(slow?.message).toMatch(/inspect weak or oscillatory closure/);
    const passes = Number(/needed (\d+) substitution/.exec(slow!.message)![1]);
    expect(passes).toBeGreaterThan(16);
    // Informational only: the design is sized and the verdict stands.
    expect(evaluateSheet(geometric(0.6)).feasible).toBe(true);
  });

  it('stays quiet about a loop that closes briskly', () => {
    expect(note(geometric(0.05))).toBeUndefined(); // ~6 passes
  });
});

describe('limitingConstraint — the rule closest to breaking', () => {
  const child = (rhs: string): SheetDoc => ({
    title: 'c',
    polarity: 'n',
    params: [],
    rows: [],
    rules: [{ id: 'tightest', kind: 'invariant', lhs: '1', op: '>=', rhs }],
    provide: [],
  });
  const doc = (childRhs: string, topRhs: string): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    params: [],
    rows: [],
    rules: [
      { id: 'loose', kind: 'requirement', lhs: '1', op: '>=', rhs: topRhs },
      // Tighter than either hard rule, and advisory — it must never be named.
      { id: 'advice', kind: 'guardrail', lhs: '1', op: '>=', rhs: '0.999' },
    ],
    uses: [{ name: 'c', doc: child(childRhs) }],
  });

  it('names the tightest hard rule on a FEASIBLE tree, where nothing is failing', () => {
    const res = evaluateSheet(doc('0.99', '0.5'));
    expect(res.feasible).toBe(true);
    expect(bindingConstraint(res)).toBeUndefined(); // no rule to blame — nothing failed
    // Path-keyed exactly as bindingConstraint would name it.
    expect(limitingConstraint(res)?.id).toBe('c.tightest');
  });

  it('agrees with bindingConstraint once a rule fails', () => {
    const res = evaluateSheet(doc('0.99', '2'));
    expect(res.feasible).toBe(false);
    expect(bindingConstraint(res)?.id).toBe('loose');
    expect(limitingConstraint(res)?.id).toBe('loose');
  });

  it('looks past the boundary tautology a containment edge parks on', () => {
    // An edge lands the design exactly on the range end its own rule compares against, so that
    // rule reads margin 0 by construction. Naming it as the limiter would be true and useless —
    // it would be the answer forever, hiding every rule that can actually move.
    const res = evaluateSheet({
      title: 'edge',
      polarity: 'n',
      params: [
        { name: 'a', value: 1 },
        { name: 'A_lo', value: 0.5 },
      ],
      rows: [],
      rules: [
        { id: 'range', kind: 'requirement', lhs: 'a', op: '>=', rhs: 'A_lo' },
        { id: 'tight', kind: 'requirement', lhs: 'a', op: '>=', rhs: '0.49' },
      ],
      edges: [{ name: 'lo', set: { a: 'A_lo' } }],
    });
    expect(res.feasible).toBe(true);
    expect(res.edges![0].rules.find((r) => r.id === 'range')!.margin).toBe(0);
    const lim = limitingConstraint(res)!;
    expect(lim.id).toBe('lo@tight');
    expect(lim.marginPct).toBeCloseTo(0.01 / 0.49, 9);
  });

  it('ignores a containment edge whose solve never landed', () => {
    // A failed edge's rules were evaluated wherever its bisection stopped — a design point the
    // engine never landed on. Naming a constraint measured there points the designer at a
    // phantom, and here the phantom is TIGHTER than anything real, so it would win the minimum.
    // The edge's own `error` is the finding; its rules are not outcomes.
    const doc: SheetDoc = {
      title: 'edge',
      polarity: 'n',
      params: [
        { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
        { name: 'T_lo', value: 0.5 }, // y spans [1, 21] over the bracket — unreachable
      ],
      rows: [{ name: 'y', expr: '2*x + 1' }],
      rules: [{ id: 'ceiling', kind: 'invariant', lhs: 'x', op: '<=', rhs: '10.5' }],
      edges: [{ name: 'lo', set: { T: 'T_lo' } }],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.edges![0].error).toMatch(/does not change sign/);
    expect(res.edges![0].rules[0].marginPct).toBeLessThan(res.rules[0].marginPct);
    expect(limitingConstraint(res)?.id).toBe('ceiling');
    expect(bindingConstraint(res)).toBeUndefined();
  });

  it('has nothing to name when every hard rule is na', () => {
    const res = evaluateSheet({
      title: 'x',
      polarity: 'n',
      params: [],
      rows: [],
      rules: [{ id: 'r', kind: 'invariant', lhs: 'nope', op: '>=', rhs: '0' }],
    });
    expect(limitingConstraint(res)).toBeUndefined();
  });
});

describe('sheetSensitivities — which knob moves which margin', () => {
  /** margin = 2a - rhs, so d(margin)/da is exactly 2 and a difference scheme must reproduce it. */
  const linear = (over: Partial<SheetVar> = {}, rhs = '1', extra: Partial<SheetDoc> = {}) => ({
    title: 'lin',
    polarity: 'n' as const,
    params: [{ name: 'a', value: 1, role: 'choice' as const, min: 0, max: 10, ...over }],
    rows: [],
    rules: [{ id: 'r', kind: 'requirement' as const, lhs: '2*a', op: '>=' as const, rhs }],
    ...extra,
  });

  it('reproduces an analytic slope exactly', () => {
    const s = sheetSensitivities(linear());
    expect(s).toHaveLength(1);
    expect(s[0].param).toBe('a');
    expect(s[0].step).toBeCloseTo(0.01, 12); // 1% of the value
    expect(s[0].error).toBeUndefined();
    const r = s[0].rules[0];
    expect(r.id).toBe('r');
    expect(r.baseStatus).toBe('pass');
    expect(r.baseMargin).toBeCloseTo(1, 12);
    expect(r.dMarginPerUnit).toBeCloseTo(2, 9);
    expect(r.deltaPlus).toBeCloseTo(0.02, 9);
    expect(r.deltaMinus).toBeCloseTo(-0.02, 9);
  });

  it('treats a FAILING hard rule as an ordinary point — that is where direction is wanted', () => {
    const s = sheetSensitivities(linear({}, '100'));
    expect(s[0].error).toBeUndefined();
    expect(s[0].rules[0].baseStatus).toBe('fail');
    expect(s[0].rules[0].baseMargin).toBeCloseTo(-98, 9);
    expect(s[0].rules[0].dMarginPerUnit).toBeCloseTo(2, 9);
  });

  it('switches to a one-sided difference for a knob sitting on its bound', () => {
    const s = sheetSensitivities(linear({ value: 0.5, min: 0.5 }));
    expect(s[0].step).toBeCloseTo(0.005, 12);
    const r = s[0].rules[0];
    expect(r.dMarginPerUnit).toBeCloseTo(2, 9); // second-order one-sided: exact on a line
    expect(r.deltaPlus).toBeCloseTo(0.01, 9);
    expect(Number.isNaN(r.deltaMinus)).toBe(true); // no probe below the bound was taken
  });

  it('leans the other way for a knob sitting on its UPPER bound', () => {
    const s = sheetSensitivities(linear({ value: 10 })); // max is 10
    expect(s[0].step).toBeCloseTo(0.1, 12);
    const r = s[0].rules[0];
    expect(r.dMarginPerUnit).toBeCloseTo(2, 9);
    expect(r.deltaMinus).toBeCloseTo(-0.2, 9);
    expect(Number.isNaN(r.deltaPlus)).toBe(true);
  });

  it('says so when the step does not fit inside the bounds at all', () => {
    // Neither direction has room for the two probes a second-order difference needs.
    const s = sheetSensitivities(linear({ value: 1, min: 0.995, max: 1.005 }));
    expect(s[0].error).toMatch(/too narrow to difference across/);
    expect(s[0].rules).toEqual([]);
  });

  it('reports one-sided deltas and NO slope across an equality rule cusp', () => {
    // margin = tol*|rhs| - |lhs - rhs| peaks where the rule is satisfied, so both directions
    // move it DOWN and a central difference averages them to a flat 0 — the one number that is
    // certainly wrong.
    const s = sheetSensitivities({
      ...linear(),
      rules: [{ id: 'eq', kind: 'requirement', lhs: 'a', op: '==', rhs: '1', tolPct: 10 }],
    });
    const r = s[0].rules[0];
    expect(Number.isNaN(r.dMarginPerUnit)).toBe(true);
    expect(r.deltaPlus).toBeCloseTo(-0.01, 9);
    expect(r.deltaMinus).toBeCloseTo(-0.01, 9);
  });

  it('records a probe that did not stand, and fabricates nothing from it', () => {
    // sqrt of a negative headroom at a + h: the row is non-finite from resolved inputs, which is
    // an error-severity diagnostic, so that side of the difference does not exist.
    const s = sheetSensitivities(
      linear({}, '1', { rows: [{ name: 'q', expr: 'sqrt(1.005 - a)' }] }),
    );
    expect(s[0].error).toMatch(/did not stand/);
    expect(s[0].error).toContain('a = 1.01');
    const r = s[0].rules[0];
    expect(Number.isNaN(r.deltaPlus)).toBe(true);
    expect(Number.isNaN(r.dMarginPerUnit)).toBe(true);
    expect(r.deltaMinus).toBeCloseTo(-0.02, 9); // the surviving side is still reported
  });

  it('re-checks the containment edges only for a rule that lives on one', () => {
    // Every edge costs each probe another full evaluation of the whole sheet, so a readout about
    // a rule at the top must not pay for range ends nobody asked about. Naming an edge-keyed rule
    // is how a caller opts in — and then the edge outcomes are keyed exactly as bindingConstraint
    // names them.
    const doc = linear({}, '1', {
      params: [
        { name: 'a', value: 1, role: 'choice', min: 0, max: 10 },
        { name: 'A_lo', value: 0.5 },
      ],
      edges: [{ name: 'lo', set: { a: 'A_lo' } }],
    });
    // Unasked: the edge runs never happen, so nothing edge-keyed is reported at all — never a
    // row of NaNs standing in for a measurement that was deliberately skipped.
    expect(sheetSensitivities(doc)[0].rules.map((r) => r.id)).toEqual(['r']);

    const byId = new Map(
      sheetSensitivities(doc, undefined, undefined, { rule: 'lo@r' })[0].rules.map((r) => [
        r.id,
        r,
      ]),
    );
    expect([...byId.keys()].sort()).toEqual(['lo@r', 'r']);
    expect(byId.get('r')!.dMarginPerUnit).toBeCloseTo(2, 9);
    // The edge pins `a` to its own value, so the knob cannot move that run at all.
    expect(byId.get('lo@r')!.dMarginPerUnit).toBeCloseTo(0, 12);
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
      rows: [{ name: 't', expr: '0.5*e + 0.5' }],
      rules: [{ id: 'r', kind: 'requirement', lhs: '2*a', op: '>=', rhs: '1' }],
    };
    expect(sheetSensitivities(doc).map((s) => s.param)).toEqual(['a']);
    // Asked for by name, it is still refused — with the reason, not silently.
    const asked = sheetSensitivities(doc, undefined, undefined, { params: ['e', 'ghost'] });
    expect(asked[0].error).toMatch(/the engine solves "e"/);
    expect(asked[1].error).toMatch(/"ghost" is not a param/);
    expect(asked.every((s) => s.rules.length === 0)).toBe(true);
  });

  it('scales a zero-valued knob from its range, and refuses to invent one without a range', () => {
    const bounded = sheetSensitivities(linear({ value: 0, min: -1, max: 1 }, '-1'));
    expect(bounded[0].step).toBeCloseTo(0.02, 12); // 1% of the span
    expect(bounded[0].rules[0].dMarginPerUnit).toBeCloseTo(2, 9);

    const unbounded = sheetSensitivities(
      linear({ value: 0, min: undefined, max: undefined }, '-1'),
    );
    expect(unbounded[0].error).toMatch(/pass an absolute step/);
    expect(unbounded[0].rules).toEqual([]);

    const told = sheetSensitivities(
      linear({ value: 0, min: undefined, max: undefined }, '-1'),
      undefined,
      undefined,
      { absStep: 0.01 },
    );
    expect(told[0].rules[0].dMarginPerUnit).toBeCloseTo(2, 9);
  });

  it('refuses to differentiate a doc that does not validate', () => {
    const s = sheetSensitivities({
      ...linear(),
      rules: [
        { id: 'r', kind: 'requirement', lhs: '2*a', op: '>=', rhs: '1' },
        { id: 'r', kind: 'requirement', lhs: '2*a', op: '>=', rhs: '2' }, // duplicate id
      ],
    });
    expect(s[0].error).toMatch(/does not validate/);
    expect(s[0].rules).toEqual([]);
  });
});

describe('a bound gate-source voltage in a sheet', () => {
  // The mirror needs a device whose current actually depends on the drain, so the vds-swept
  // demo rather than the module's 2-D `dev`.
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
    bind: { L: 'L_r', id: 'I_r', gm_id: 'g_r', diode: true },
    rows: [],
    rules: [],
    provide: ['W', 'vgs'],
  });

  /** A K:1 mirror whose output device binds `partner` as its second quantity. */
  const mirror = (partner: Record<string, string>): SheetDoc => ({
    title: 'mirror',
    polarity: 'n',
    params: [
      { name: 'L', value: 1e-6 },
      { name: 'K', value: 3 },
      { name: 'V_out', value: 0.9 },
      { name: 'gm_id_m', value: 10 },
    ],
    bind: { L: 'L', W: 'K*ref__W', ...partner, vds: 'V_out' },
    rows: [{ name: 'ratio', expr: 'id/(K*20e-6)' }],
    rules: [],
    uses: [{ name: 'ref', doc: reference() }],
  });

  it('sizes the output device at the reference gate voltage, not at a target it re-solves', () => {
    const res = runSheet(mirror({ vgs: 'ref__vgs' }), devVds);

    expect(res.bind?.ok).toBe(true);
    // The two devices are on one wire: the sized gate voltage IS the reference's, exactly —
    // not "within an inversion level of it".
    expect(res.bind!.vgs).toBeCloseTo(res.values.ref__vgs, 15);
    expect(res.bind!.W).toBeCloseTo(3 * res.values.ref__W, 15);
    // vgs is a SELECTOR, never a bias axis: the bind must not have sliced the vgs axis away.
    expect(Object.keys(res.bind?.bias ?? {})).not.toContain('vgs');
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
    // must come back as 1.2 V everywhere it is reported — the bind report, the merged scope, and
    // a row reading it — with the request surviving only in the warning. And the sheet must
    // still size: a clamp is a note about where the data ends, not an infeasibility.
    const doc: SheetDoc = {
      title: 'c',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'W_o', value: 4e-6 },
      ],
      bind: { L: 'L', W: 'W_o', vgs: '1.5' },
      rows: [{ name: 'v_read', expr: 'vgs' }],
      rules: [],
    };
    const res = runSheet(doc, dev);

    expect(res.bind?.ok).toBe(true);
    expect(res.bind!.vgs).toBeCloseTo(1.2, 12);
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
      bind: { L: 'L', vgs: 'ref__vgs', gm_id: 'gm_id_m' },
    };
    expect(validateSheet(both).some((w) => /both set the operating point/.test(w.message))).toBe(
      true,
    );
    expect(runSheet(both, devVds).bind?.ok).toBe(false);

    // And a gate voltage on top of an already-complete width-first bind is a third quantity.
    const three = mirror({ vgs: 'ref__vgs', gm_id: 'gm_id_m' });
    expect(validateSheet(three).some((w) => /EXACTLY two/.test(w.message))).toBe(true);
    expect(runSheet(three, devVds).bind?.ok).toBe(false);
  });

  it('is legal alongside a diode connection: the connection picks the axis, the bind the point', () => {
    // A diode connection collapses vds onto the vds = vgs diagonal; naming vgs then picks the
    // point ON that diagonal. Two independent statements, both true — unlike a declared vds,
    // which would name the same coordinate twice.
    const doc: SheetDoc = {
      title: 'd',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'v', value: 0.7 },
        { name: 'W', value: 4e-6 },
      ],
      bind: { L: 'L', W: 'W', vgs: 'v', diode: true },
      rows: [],
      rules: [],
    };
    expect(validateSheet(doc)).toEqual([]);
    const res = runSheet(doc, devVds);
    expect(res.bind?.ok).toBe(true);
    expect(res.bind!.vgs).toBeCloseTo(0.7, 12);

    // The connection is not decorative here: it put the drain at 0.7 V, so the current carries
    // the demo's (1 + vds/VA) factor with VA = VA_PER_L·0.5 µm = 2.5 V. Against the same device
    // held at vds = 0 that is exactly 1 + 0.7/2.5 = 1.28x the current.
    const atZero = runSheet({ ...doc, bind: { L: 'L', W: 'W', vgs: 'v', vds: '0' } }, devVds);
    expect(res.bind!.id / atZero.bind!.id).toBeCloseTo(1 + 0.7 / (VA_PER_L * 0.5e-6), 9);

    // A declared vds is still refused — the ruling is about vgs only.
    expect(
      validateSheet({ ...doc, bind: { ...doc.bind!, vds: '0.5' } }).some((w) =>
        /both a diode connection and a vds/.test(w.message),
      ),
    ).toBe(true);
  });
});

describe('validateSheet — gates declared on one wire but sized apart', () => {
  const child = (bind: Record<string, unknown>): SheetDoc => ({
    title: 'c',
    polarity: 'n',
    params: [
      { name: 'L', value: 0.5e-6 },
      { name: 'Ib', value: 20e-6 },
      { name: 'g', value: 10 },
      { name: 'vg', value: 0.7 },
    ],
    bind: { L: 'L', ...bind } as SheetDoc['bind'],
    rows: [],
    rules: [],
    provide: ['vgs', 'W'],
  });

  const pair = (
    a: { gate: string; source: string },
    b: { gate: string; source: string },
    bindB: Record<string, unknown> = { id: 'Ib', gm_id: 'g' },
  ): SheetDoc => ({
    title: 'p',
    polarity: 'n',
    params: [{ name: 'VDD', value: 1.8 }],
    rows: [],
    rules: [],
    uses: [
      { name: 'one', doc: child({ id: 'Ib', gm_id: 'g' }), wiring: a },
      { name: 'two', doc: child(bindB), wiring: b },
    ],
  });

  const ties = (d: SheetDoc): string[] =>
    validateSheet(d)
      .filter((w) => w.rule === 'sheet-gate-tie')
      .map((w) => w.message);

  it('names two blocks that declare one gate and one source yet size independently', () => {
    const found = ties(pair({ gate: 'V_g', source: '0' }, { gate: 'V_g', source: '0' }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"one", "two"');
    expect(found[0]).toContain('V_g');
    expect(found[0]).toMatch(/each is sized at its own operating point/);
    // It advises, it does not repair: the sheet still evaluates and stays feasible.
    expect(
      validateSheet(pair({ gate: 'V_g', source: '0' }, { gate: 'V_g', source: '0' })).every(
        (w) => w.severity === 'warning',
      ),
    ).toBe(true);
  });

  /** Two on one node, the second sized on a gate voltage the parent supplies. */
  const withPartner = (): SheetDoc =>
    pair({ gate: 'V_g', source: '0' }, { gate: 'V_g', source: '0' }, { W: '2e-6', vgs: 'vg' });

  it('says nothing once one of them is sized on the OTHER block gate voltage', () => {
    // The fix, and the only thing that actually holds the two at one voltage.
    const tied = withPartner();
    tied.uses![1].params = { vg: 'one__vgs' };
    expect(ties(tied)).toEqual([]);
  });

  it('is not silenced by a gate voltage that couples nothing', () => {
    // A typed number, and a gate voltage read off a block that is NOT on this node, leave the
    // two devices exactly as unconnected as no vgs at all. Accepting any bound vgs would turn
    // the check off on the sheets that most look like they pass it.
    expect(ties(withPartner())).toHaveLength(1); // vg is the child's own param, a literal 0.7

    const elsewhere = withPartner();
    elsewhere.uses!.push({ name: 'far', doc: child({ id: 'Ib', gm_id: 'g' }) });
    elsewhere.uses![1].params = { vg: 'far__vgs' };
    expect(ties(elsewhere)).toHaveLength(1);
  });

  it('needs two loose blocks, not one: something has to settle the voltage the rest follow', () => {
    // Three on one node, the other two sized on the first: the first is the anchor, not a defect.
    const three = withPartner();
    three.uses![1].params = { vg: 'one__vgs' };
    three.uses!.push({
      name: 'third',
      doc: child({ W: '3e-6', vgs: 'vg' }),
      params: { vg: 'one__vgs' },
      wiring: { gate: 'V_g', source: '0' },
    });
    expect(ties(three)).toEqual([]);

    // Cut the third loose and it is named alongside the one it should have followed — and the
    // one that IS tied stays out of the message.
    three.uses![2] = {
      name: 'third',
      doc: child({ id: 'Ib', gm_id: 'g' }),
      wiring: { gate: 'V_g', source: '0' },
    };
    const found = ties(three);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"one", "third"');
    expect(found[0]).not.toContain('"two"');
  });

  it('says nothing when the sources differ — a shared gate is not a shared vgs there', () => {
    // A complementary pair on one input, and a Widlar source, both share a gate node while
    // sitting on different sources, so their gate-source voltages are genuinely different
    // numbers. Matching on the gate alone would report the library's own inverter stage.
    expect(ties(pair({ gate: 'V_in', source: '0' }, { gate: 'V_in', source: 'VDD' }))).toEqual([]);
    expect(ties(pair({ gate: 'V_g', source: '0' }, { gate: 'V_g', source: 'I_out*R_s' }))).toEqual(
      [],
    );
  });

  it('matches how the nodes are written, ignoring only whitespace', () => {
    expect(
      ties(pair({ gate: 'VDD - v', source: '0' }, { gate: 'VDD-v', source: ' 0' })),
    ).toHaveLength(1);
  });

  it('rules on nothing it cannot see, without letting it hide what it can', () => {
    const unresolved = pair({ gate: 'V_g', source: '0' }, { gate: 'V_g', source: '0' });
    unresolved.uses![1] = {
      name: 'two',
      ref: 'somewhere/else',
      wiring: { gate: 'V_g', source: '0' },
    };
    expect(ties(unresolved)).toEqual([]);

    const unbound = pair({ gate: 'V_g', source: '0' }, { gate: 'V_g', source: '0' });
    delete unbound.uses![1].doc!.bind;
    expect(ties(unbound)).toEqual([]);

    // But a third block nobody can rule on must not suppress the real pair beside it.
    const beside = pair({ gate: 'V_g', source: '0' }, { gate: 'V_g', source: '0' });
    beside.uses!.push({ name: 'ref_only', ref: 'x/y', wiring: { gate: 'V_g', source: '0' } });
    expect(ties(beside)).toHaveLength(1);
  });
});
