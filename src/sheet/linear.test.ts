// The normal form the wiring check counts constraints in: canonical spellings, the selector
// shape, and the rank count. Every expectation is worked by hand from the expression.

import { describe, it, expect } from 'vitest';
import {
  atomPoly,
  canon,
  isLinear,
  linearForm,
  normalizeSrc,
  parseExpr,
  rankOf,
  selectorRoot,
  type Poly,
} from './linear';

// Every name an atom, except the expression constants, which a sheet's resolver also leaves alone.
const CONST_NAMES = new Set(['pi', 'k', 'q', 'T', 'eps']);
const plain = (n: string): Poly | undefined => (CONST_NAMES.has(n) ? undefined : atomPoly(n));
const form = (src: string): Poly => normalizeSrc(src, plain);
const poly = (o: Record<string, number>): Poly => new Map(Object.entries(o));

describe('the normal form', () => {
  it('spells p*r and r*p, and a - (b - c) and a + c - b, the same', () => {
    expect(canon(form('p*r'))).toBe(canon(form('r*p')));
    expect(canon(form('a - (b - c)'))).toBe(canon(form('a + c - b')));
    // (a + b)*c expands to a*c + b*c: two monomials, each a product of two atoms.
    expect(canon(form('(a + b)*c'))).toBe('1*a * c + 1*b * c');
  });

  it('folds constants and a division by a number, and reads a constant name as its value', () => {
    expect(canon(form('2*(x/4) + 3 - 1'))).toBe('2 + 0.5*x');
    expect(canon(form('pi - pi'))).toBe('0');
    // `q` is the electron charge, a constant, not an atom.
    expect(canon(form('q/q'))).toBe('1');
  });

  it('is linear only over plain atoms: a product of two atoms or a call is not', () => {
    expect(isLinear(form('VDD - V_out + 0.2'))).toBe(true);
    expect(isLinear(form('p_sign*(VDD - V_out)'))).toBe(false);
    expect(isLinear(form('VDD - abs(x)'))).toBe(false);
  });

  it('interns a non-linear value as one opaque atom, the same for p*r and r*p, and for its negative', () => {
    const a = linearForm(form('p*r'));
    const b = linearForm(form('r*p'));
    expect([...a.keys()]).toEqual([...b.keys()]);
    expect([...a.keys()][0].startsWith('~')).toBe(true);
    const neg = linearForm(form('-(r*p)'));
    expect([...neg.keys()]).toEqual([...a.keys()]);
    expect([...neg.values()]).toEqual([-1]);
  });

  it('keeps an opaque factor that spells a product whole, so its spelling stays canonical', () => {
    // 1/(a*c) is one factor whose own spelling holds a product; split on the product's ' * ' it
    // came apart into '1*c) * inv(1*a * x'.
    expect(canon(form('x/(a*c)'))).toBe('1*inv(1*a * c) * x');
    expect(canon(form('x/(c*a)'))).toBe(canon(form('x/(a*c)')));
    expect(canon(form('y*abs(a*b)'))).toBe(canon(form('abs(b*a)*y')));
  });

  it('reads an engineering literal as the number it is, as the engine does', () => {
    // 100m is 0.1, so VDD - 100m is a number subtracted from an atom: linear, nothing opaque.
    expect(canon(form('VDD - 100m'))).toBe('-0.1 + 1*VDD');
    expect(isLinear(form('VDD - 100m'))).toBe(true);
    expect(canon(form('100n*x'))).toBe(canon(form('1e-7*x')));
  });

  it('reads an expression the parser refuses as one opaque term', () => {
    expect(parseExpr('VDD - (')).toBeUndefined();
    expect(isLinear(form('VDD - ('))).toBe(false);
  });

  it("folds a constant call of any function the engine evaluates, through the engine's own table", () => {
    expect(canon(form('par(2, 2)'))).toBe('1');
    expect(canon(form('max(1, 3) + x'))).toBe('3 + 1*x');
    // A call the engine would refuse — par of one argument — stays a term.
    expect(isLinear(form('par(2)'))).toBe(false);
  });
});

// Every test below declares `s` (and nothing else) a selector.
const sel = (node: NonNullable<ReturnType<typeof parseExpr>>) =>
  selectorRoot(node, (n) => n === 's');

describe('the axis-sign selector shape', () => {
  it('tries both operands, so a bare name on the left does not hide the selector on the right', () => {
    expect(sel(parseExpr('V_x*s')!)?.name).toBe('s');
    expect(sel(parseExpr('V_x*s')!)?.inner).toEqual(parseExpr('V_x'));
    expect(sel(parseExpr('V_x*w')!)).toBeUndefined();
  });

  it('is a whole-expression product, on either side, under at most one minus', () => {
    expect(sel(parseExpr('s*(VDD - V_out)')!)?.name).toBe('s');
    expect(sel(parseExpr('(VDD - V_out)*s')!)?.name).toBe('s');
    expect(sel(parseExpr('-(s*(VDD - V_out))')!)?.sign).toBe(-1);
    expect(sel(parseExpr('-s*(VDD - V_out)')!)?.sign).toBe(-1);
  });

  it('is not a selector distributed over a sum', () => {
    expect(sel(parseExpr('s*VDD - s*V_out')!)).toBeUndefined();
    expect(sel(parseExpr('VDD - V_out')!)).toBeUndefined();
  });
});

describe('the rank count', () => {
  it('counts p - q and 2p - 2q as one constraint', () => {
    expect(rankOf([poly({ p: 1, q: -1 }), poly({ p: 2, q: -2 })]).rank).toBe(1);
  });

  it('counts two levels that contradict — a row that reduces to a constant — as a constraint', () => {
    // a = 1 and a = 2: subtracting leaves 0 = 1, which is a constraint no value meets.
    const r = rankOf([poly({ a: 1, '': -1 }), poly({ a: 1, '': -2 })]);
    expect(r.rank).toBe(2);
    expect(r.independent).toEqual([0, 1]);
  });

  it('treats what rounding leaves of a cancellation as zero', () => {
    // 0.3x + 0.9y is three times 0.1x + 0.3y; eliminating it in floating point leaves about 1e-16.
    expect(rankOf([poly({ x: 0.1, y: 0.3 }), poly({ x: 0.3, y: 0.9 })]).rank).toBe(1);
  });

  it('keeps the first maximal independent set in the order given', () => {
    const rows = [poly({ x: 1 }), poly({ x: 2 }), poly({ y: 1 }), poly({ x: 1, y: 1 })];
    expect(rankOf(rows)).toEqual({ rank: 2, independent: [0, 2] });
  });
});
