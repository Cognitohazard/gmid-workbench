// Golden suite for the leaf design-sheet evaluator. Anchors the two load-bearing
// promises: the sizing is sizeDevice verbatim (no re-inversion), and bad author input
// degrades to warnings / 'na' chips instead of throwing.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice, withoutColumns } from '../demo';
import { sizeDevice, integratedNoise, mismatch } from '../device';
import { fixTable } from '../series';
import { lookup } from '../lookup';
import {
  evaluateSheet,
  runSheet,
  validateSheet,
  sweepSheet,
  sweepSheet2,
  sweepable,
  bindingConstraint,
  isHardRule,
  MAX_TORN_PARAMS,
  SOLVE_TOL_REL,
} from './index';
import { EXAMPLES } from './examples';
import type { SheetDoc } from './types';

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
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toHaveLength(0);
    expect(res.values.osc).toBeCloseTo(1, 6);
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
    expect(res.warnings.filter((w) => w.rule === 'sheet-solve')).toHaveLength(0);
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
