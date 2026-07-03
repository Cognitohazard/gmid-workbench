// Golden suite for the leaf design-sheet evaluator. Anchors the two load-bearing
// promises: the sizing is sizeDevice verbatim (no re-inversion), and bad author input
// degrades to warnings / 'na' chips instead of throwing.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import { sizeDevice, integratedNoise, mismatch } from '../device';
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
    // Integrated input noise == core integratedNoise on the W-referred thermal PSD (svth·w0/W)
    // and the intensive flicker corner fco. (svth·fco == svfl, so the flicker term matches too.)
    const expectedVn = integratedNoise((v.svth * v.w0) / v.W, v.fco, v.f_lo, v.f_hi);
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
    const svth_w = (v.svth * v.w0) / v.W;
    const svfl_w = (v.svfl * v.w0) / v.W;
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
