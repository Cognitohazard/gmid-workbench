// A failed search of the top-level sheet leaves no number for what it did not find, nor for
// anything that reads one: each such name is withheld with its cause, the way a composed block's
// outputs are withheld when the block fails. What the failure does not touch is evaluated and
// shown as before.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice } from '../demo';
import { evaluateSheet, runSheet, followOnSummary, withheldIn } from './index';
import type { SheetDoc, SheetResult, SheetVar } from './types';

const dev = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.3 } });

/** A child that sizes a device on the current it is given and provides its width. */
const child: SheetDoc = {
  title: 'child',
  polarity: 'n',
  params: [
    { name: 'L', value: 0.5e-6 },
    { name: 'I', value: 1e-5 },
  ],
  givens: { L: 'L', id: 'I', gm_id: '12', vds: '0.6' },
  equations: [],
  checks: [],
  provides: ['W'],
};

/**
 * A sheet whose solved `x` is searched over [0, 10] for y = 2x + 1 to reach `goal`. With goal = 50 there
 * is no crossing in the range. `x` is read by y, then z; by the block `reads`; and by the check
 * `zcap`. The device, the block `apart`, the equation u and the check `upos` read none of them.
 */
const sheet = (x: SheetVar): SheetDoc => ({
  title: 'one search',
  polarity: 'n',
  params: [
    { name: 'L', value: 0.5e-6 },
    { name: 'I', value: 2e-5 },
    { name: 'goal', value: 50 },
    x,
  ],
  givens: { L: 'L', id: 'I', gm_id: '10', vds: '0.6' },
  blocks: [
    { name: 'reads', doc: child, params: { I: 'x*1e-6' } },
    { name: 'apart', doc: child, params: { I: 'I/2' } },
  ],
  equations: [
    { name: 'y', expr: '2*x + 1' },
    { name: 'z', expr: 'y*3' },
    { name: 'u', expr: 'I*2 + apart__W' },
    { name: 'wr', expr: 'reads__W*2' },
  ],
  checks: [
    { id: 'zcap', kind: 'spec', lhs: 'z', op: '<=', rhs: '1000' },
    { id: 'upos', kind: 'spec', lhs: 'u', op: '>=', rhs: '0' },
  ],
});

const solved: SheetVar = {
  name: 'x',
  value: 1,
  min: 0,
  max: 10,
  designConstraint: { lhs: 'y', rhs: 'goal' },
};

const check = (r: SheetResult, id: string) => r.checks.find((c) => c.id === id);

describe('a failed top-level search withholds what it did not find', () => {
  it('withholds the unknown that found no crossing, and everything that reads it, with its cause', () => {
    const res = evaluateSheet(sheet(solved), dev);
    expect(res.solve).toMatchObject({ kind: 'no-solution', unknown: 'x', because: 'no-crossing' });
    expect(res.feasible).toBe(false);
    for (const n of ['x', 'y', 'z', 'wr', 'reads__W']) {
      expect(res.values[n], n).toBeUndefined();
      expect(res.withheld?.[n], n).toBe('x');
    }
    // A check that reads it is not evaluated: neither pass nor fail.
    expect(check(res, 'zcap')?.status).toBe('na');
    // The block whose override reads it is not evaluated: nothing sized, nothing provided.
    const reads = res.blocks?.find((b) => b.name === 'reads');
    expect(reads).toMatchObject({ feasible: false, provides: {}, checks: [] });
    expect(reads?.sizing).toBeUndefined();
    // The failure's own message is unchanged and stays the first error.
    const first = res.warnings.find((w) => w.severity === 'error');
    expect(first?.rule).toBe('sheet-solve');
    expect(first?.cause).toBeUndefined();
  });

  it('keeps what the failure does not touch, at the numbers it reads with the search taken away', () => {
    const res = evaluateSheet(sheet(solved), dev);
    // The same sheet with x typed rather than solved: everything evaluates.
    const ref = evaluateSheet(sheet({ name: 'x', value: 1 }), dev);
    expect(ref.solve).toBeUndefined();
    for (const n of ['L', 'I', 'goal', 'u', 'apart__W', 'W', 'vgs', 'gm']) {
      expect(res.values[n], n).toBe(ref.values[n]);
      expect(withheldIn(res, n), n).toBe(false);
    }
    expect(res.sizing).toEqual(ref.sizing);
    expect(check(res, 'upos')).toEqual(check(ref, 'upos'));
    const apart = (r: SheetResult) => r.blocks?.find((b) => b.name === 'apart');
    expect(apart(res)?.sizing).toEqual(apart(ref)?.sizing);
    expect(apart(res)?.provides).toEqual(apart(ref)?.provides);
  });

  it('withholds every member of a set that did not settle, and keeps an unknown found before it', () => {
    // c is found first (2c = 3); a and b read each other with no common answer in their ranges,
    // and a reads c. e reads only c, f reads a member.
    const doc: SheetDoc = {
      title: 'set',
      polarity: 'n',
      params: [
        { name: 'c', value: 0, min: 0, max: 10, designConstraint: { lhs: '2*c', rhs: '3' } },
        { name: 'a', value: 0, min: 0, max: 10, designConstraint: { lhs: 'a', rhs: 'b + c' } },
        { name: 'b', value: 0, min: 0, max: 10, designConstraint: { lhs: 'b', rhs: 'a + 1' } },
      ],
      equations: [
        { name: 'e', expr: 'c*2' },
        { name: 'f', expr: 'a + c' },
      ],
      checks: [
        { id: 'ec', kind: 'spec', lhs: 'e', op: '<=', rhs: '10' },
        { id: 'fc', kind: 'spec', lhs: 'f', op: '<=', rhs: '100' },
      ],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.solve).toMatchObject({ kind: 'not-settled' });
    expect(res.solve?.kind === 'not-settled' && [...res.solve.unknowns].sort()).toEqual(['a', 'b']);
    expect(res.values.a).toBeUndefined();
    expect(res.values.b).toBeUndefined();
    expect(res.values.f).toBeUndefined();
    expect(res.withheld).toMatchObject({ a: 'a', b: 'b' });
    expect(['a', 'b']).toContain(res.withheld?.f);
    expect(check(res, 'fc')?.status).toBe('na');
    // c landed before the set failed: it, and what reads only it, stay.
    expect(res.values.c).toBeCloseTo(1.5, 6);
    expect(res.values.e).toBeCloseTo(3, 6);
    expect(withheldIn(res, 'c')).toBe(false);
    expect(check(res, 'ec')?.status).toBe('pass');
  });

  it('withholds an unknown never searched because the search before it failed', () => {
    // p fails (no crossing); q comes after it in the plan, reads p, and is never searched.
    const doc: SheetDoc = {
      title: 'chain',
      polarity: 'n',
      params: [
        { name: 'p', value: 0, min: 0, max: 1, designConstraint: { lhs: 'p', rhs: '5' } },
        { name: 'q', value: 0, min: 0, max: 10, designConstraint: { lhs: 'q', rhs: 'p*2' } },
      ],
      equations: [],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.solve).toMatchObject({ kind: 'no-solution', unknown: 'p' });
    expect(res.values.p).toBeUndefined();
    expect(res.values.q).toBeUndefined();
    expect(res.withheld).toMatchObject({ p: 'p', q: 'p' });
  });

  it('withholds a param that landed by reading one read off its tolerance', () => {
    // A reads r, which reads gm — the device's, sized on I, which is searched after A: a
    // dependency the plan cannot see, so A lands, I moves, and A is read off its tolerance. B is
    // searched after A and reads it: it landed on A's trial value, and is not found either. I
    // reads neither, and keeps where it landed.
    const I0 = (1e-6 + 1e-4) / 2;
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
        { name: 'B', value: 0, min: 0, max: 1, designConstraint: { lhs: 'B', rhs: 'A*0.5' } },
      ],
      givens: { L: 'L', id: 'I', gm_id: '10', vds: '0.6' },
      equations: [{ name: 'r', expr: '0.5 + (gm - 10*I0)/3' }],
      checks: [],
    };
    const res = evaluateSheet(doc, dev);
    expect(res.solve).toMatchObject({ kind: 'not-settled', why: 'verification', unknowns: ['A'] });
    expect(res.values.A).toBeUndefined();
    expect(res.values.B).toBeUndefined();
    expect(res.withheld).toMatchObject({ A: 'A', B: 'A' });
    expect(res.values.I).toBeCloseTo(2e-5, 9);
    expect(res.sizing?.ok).toBe(true);
  });

  it('says what follows from the failed search apart from what follows from a block', () => {
    const res = runSheet(sheet(solved), dev);
    const line = res.warnings.find((w) => w.rule === 'sheet-follow-on');
    expect(line?.message).toMatch(/from a solved param whose search did not land — "x" \(\d+\)/);
    expect(line?.message).not.toMatch(/blocks? whose outputs were withheld/);
    // A block cause keeps its own words.
    expect(
      followOnSummary([{ rule: 'r', severity: 'error', message: 'm', cause: 'bias' }])?.message,
    ).toBe(
      '1 finding follows from a block whose outputs were withheld — "bias" (1): fix what that ' +
        'block reports and this goes with it',
    );
  });
});

describe('withheldIn — the structured guard a display blanks a field by', () => {
  it('reads the result, never the wording of a message', () => {
    const res = runSheet(sheet(solved), dev);
    expect(withheldIn(res, 'x')).toBe(true);
    // Rewording every message changes nothing.
    const reworded: SheetResult = {
      ...res,
      warnings: res.warnings.map((w) => ({ ...w, message: 'reworded' })),
    };
    expect(withheldIn(reworded, 'x')).toBe(true);
    // And a message that names the param does not blank it where the result holds its number.
    const ref = runSheet(sheet({ name: 'x', value: 1 }), dev);
    const named: SheetResult = {
      ...ref,
      warnings: [
        ...ref.warnings,
        { rule: 'sheet-solve', severity: 'error', message: 'solved param "x" did not settle' },
        { rule: 'sheet-solve', severity: 'error', message: 'constrained param "x" failed' },
      ],
    };
    expect(withheldIn(named, 'x')).toBe(false);
    expect(withheldIn(undefined, 'x')).toBe(false);
  });
});
