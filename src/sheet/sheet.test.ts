// Golden suite for the leaf design-sheet evaluator. Anchors the two load-bearing
// promises: the sizing is sizeDevice verbatim (no re-inversion), and bad author input
// degrades to warnings / 'na' chips instead of throwing.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import { sizeDevice } from '../device';
import { evaluateSheet, runSheet, validateSheet, sweepSheet } from './index';
import { EXAMPLES } from './examples';
import type { SheetDoc } from './types';

const dev = generateDemoDevice();

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
    const rule = { id: 'headroom', kind: 'invariant' as const, lhs: 'vstar', op: '>=' as const, rhs: 'vstar_floor' };
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
      params: [{ name: 'a', value: 10 }, { name: 'b', value: 8 }],
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
      params: [{ name: 'a', value: 10.3 }, { name: 'b', value: 10 }],
      bind: undefined,
      rules: [{ id: 'eq', kind: 'requirement', lhs: 'a', op: '==', rhs: 'b', tolPct: 5 }], // |Δ|=0.3 ≤ 0.5
    });
    const pass = evaluateSheet(within, dev).rules[0];
    expect(pass.status).toBe('pass');
    expect(pass.marginPct).toBeGreaterThanOrEqual(0);

    const outside = boundDoc({
      params: [{ name: 'a', value: 11 }, { name: 'b', value: 10 }],
      bind: undefined,
      rules: [{ id: 'eq', kind: 'requirement', lhs: 'a', op: '==', rhs: 'b', tolPct: 5 }], // |Δ|=1 > 0.5
    });
    const fail = evaluateSheet(outside, dev).rules[0];
    expect(fail.status).toBe('fail');
    expect(fail.marginPct).toBeLessThan(0);
  });

  it('marks a non-finite rule side as na, never a false pass', () => {
    const doc = boundDoc({
      params: [{ name: 'z', value: 0 }, { name: 'lim', value: 1 }],
      bind: undefined,
      rules: [{ id: 'div0', kind: 'guardrail', lhs: '1/z', op: '<=', rhs: 'lim' }], // 1/0 = Inf
    });
    expect(evaluateSheet(doc, dev).rules[0].status).toBe('na');
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
    const base = boundDoc({ params: [{ name: 'a', value: 10 }, { name: 'lim', value: 5 }], bind: undefined });
    const req = evaluateSheet({ ...base, rules: [{ id: 'spec', kind: 'requirement', lhs: 'a', op: '<=', rhs: 'lim' }] }, dev);
    expect(req.rules[0].status).toBe('fail');
    expect(req.feasible).toBe(false);
    const soft = evaluateSheet({ ...base, rules: [{ id: 'soft', kind: 'guardrail', lhs: 'a', op: '<=', rhs: 'lim' }] }, dev);
    expect(soft.rules[0].status).toBe('fail');
    expect(soft.feasible).toBe(true); // guardrails never block
  });

  it('runSheet folds a validation error (non-finite param) into feasibility', () => {
    const doc = boundDoc({ params: [{ name: 'x', value: Number.NaN }], bind: undefined, rules: [] });
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
