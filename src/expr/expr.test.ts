import { describe, it, expect } from 'vitest';
import { createEngine } from './index';
import { ExprError } from '../types';
import type { Scope, Value } from '../types';

/** Build a Scope from a plain record. */
function scopeOf(vars: Record<string, Value>): Scope {
  return {
    resolve(name: string): Value | undefined {
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
    },
  };
}

function arr(v: Value): Float64Array {
  if (!(v instanceof Float64Array)) {
    throw new Error('expected a Float64Array result');
  }
  return v;
}

const eng = createEngine();

describe('createEngine — elementwise arithmetic', () => {
  it('evaluates "gm/id" elementwise over arrays', () => {
    const gm = new Float64Array([1e-3, 2e-3, 4e-3]);
    const id = new Float64Array([1e-4, 1e-3, 1e-3]);
    const r = arr(eng.evaluate('gm/id', scopeOf({ gm, id })));
    expect([...r]).toEqual([10, 2, 4]);
  });

  it('broadcasts a scalar (2*pi) over an array column (cgg)', () => {
    const cgg = new Float64Array([1e-15, 2e-15]);
    const r = arr(eng.evaluate('2*pi*cgg', scopeOf({ cgg })));
    expect(r[0]).toBeCloseTo(2 * Math.PI * 1e-15, 30);
    expect(r[1]).toBeCloseTo(2 * Math.PI * 2e-15, 30);
  });

  it('handles unary minus elementwise', () => {
    const x = new Float64Array([1, -2, 3]);
    const r = arr(eng.evaluate('-x', scopeOf({ x })));
    expect([...r]).toEqual([-1, 2, -3]);
  });
});

describe('createEngine — functions', () => {
  it('sqrt(x) is elementwise', () => {
    const x = new Float64Array([4, 9, 16]);
    const r = arr(eng.evaluate('sqrt(x)', scopeOf({ x })));
    expect([...r]).toEqual([2, 3, 4]);
  });

  it('a^2 powers elementwise (^ via Math.pow)', () => {
    const a = new Float64Array([2, 3, 4]);
    const r = arr(eng.evaluate('a^2', scopeOf({ a })));
    expect([...r]).toEqual([4, 9, 16]);
  });

  it('par(a,b) = 1/(1/a + 1/b) elementwise', () => {
    const a = new Float64Array([2, 4]);
    const b = new Float64Array([2, 4]);
    const r = arr(eng.evaluate('par(a,b)', scopeOf({ a, b })));
    expect(r[0]).toBeCloseTo(1, 12); // 1/(1/2+1/2)
    expect(r[1]).toBeCloseTo(2, 12); // 1/(1/4+1/4)
  });

  it('min(a,b) is elementwise', () => {
    const a = new Float64Array([1, 5, 3]);
    const b = new Float64Array([4, 2, 3]);
    const r = arr(eng.evaluate('min(a,b)', scopeOf({ a, b })));
    expect([...r]).toEqual([1, 2, 3]);
  });

  it('max(a,b) broadcasts a scalar', () => {
    const a = new Float64Array([1, 5, 3]);
    const r = arr(eng.evaluate('max(a,2)', scopeOf({ a })));
    expect([...r]).toEqual([2, 5, 3]);
  });

  it('supports the remaining unary functions on scalars', () => {
    const s = scopeOf({ x: 100 });
    expect(eng.evaluate('log10(x)', s)).toBeCloseTo(2, 12);
    expect(eng.evaluate('exp(0)', s)).toBe(1);
    expect(eng.evaluate('abs(-5)', scopeOf({}))).toBe(5);
    expect(eng.evaluate('sign(-3)', scopeOf({}))).toBe(-1);
    expect(eng.evaluate('atan(0)', scopeOf({}))).toBe(0);
    expect(eng.evaluate('log(exp(1))', scopeOf({}))).toBeCloseTo(1, 12);
  });
});

describe('createEngine — ternary and conditions', () => {
  it('evaluates "x>0 ? a : b" on scalar condition, selecting the array branch', () => {
    const a = new Float64Array([1, 2]);
    const b = new Float64Array([9, 9]);
    const r = arr(eng.evaluate('x>0 ? a : b', scopeOf({ x: 1, a, b })));
    expect([...r]).toEqual([1, 2]);
    const r2 = arr(eng.evaluate('x>0 ? a : b', scopeOf({ x: -1, a, b })));
    expect([...r2]).toEqual([9, 9]);
  });

  it('supports logical && / || in the condition', () => {
    const s = scopeOf({ x: 1, y: 0 });
    expect(eng.evaluate('x>0 && y==0 ? 1 : 2', s)).toBe(1);
    expect(eng.evaluate('x<0 || y==0 ? 1 : 2', s)).toBe(1);
    expect(eng.evaluate('x<0 && y==0 ? 1 : 2', s)).toBe(2);
  });
});

describe('createEngine — constants and eng-notation literals', () => {
  it('"100n" parses to 1e-7', () => {
    expect(eng.evaluate('100n', scopeOf({}))).toBeCloseTo(1e-7, 18);
  });

  it('resolves named constants (pi, UT) from the constant map', () => {
    expect(eng.evaluate('pi', scopeOf({}))).toBeCloseTo(Math.PI, 12);
    expect(eng.evaluate('UT', scopeOf({}))).toBeGreaterThan(0.025);
  });

  it('eng-notation does not corrupt identifiers like cgg or x2', () => {
    const cgg = new Float64Array([5]);
    const r = arr(eng.evaluate('cgg*1', scopeOf({ cgg })));
    expect([...r]).toEqual([5]);
    expect(eng.evaluate('x2', scopeOf({ x2: 7 }))).toBe(7);
  });

  it('lets a custom constant map override defaults', () => {
    const e2 = createEngine({ k: 42 });
    expect(e2.evaluate('k', scopeOf({}))).toBe(42);
  });
});

describe('createEngine — compile metadata (names)', () => {
  it('reports free identifiers, excluding constants and function names', () => {
    const c = eng.compile('gm/id + sqrt(cgg) * pi');
    expect(c.src).toBe('gm/id + sqrt(cgg) * pi');
    expect([...c.names].sort()).toEqual(['cgg', 'gm', 'id']);
  });

  it('a compiled expr re-evaluates against different scopes', () => {
    const c = eng.compile('gm/id');
    const r1 = arr(c.eval(scopeOf({ gm: new Float64Array([2]), id: new Float64Array([1]) })));
    const r2 = arr(c.eval(scopeOf({ gm: new Float64Array([6]), id: new Float64Array([2]) })));
    expect([...r1]).toEqual([2]);
    expect([...r2]).toEqual([3]);
  });
});

describe('createEngine — errors', () => {
  it('throws ExprError on an unknown identifier', () => {
    expect(() => eng.evaluate('nope', scopeOf({}))).toThrow(ExprError);
  });

  it('throws ExprError on mismatched array lengths', () => {
    const a = new Float64Array([1, 2, 3]);
    const b = new Float64Array([1, 2]);
    expect(() => eng.evaluate('a+b', scopeOf({ a, b }))).toThrow(ExprError);
  });

  it('throws ExprError on an unknown function', () => {
    expect(() => eng.evaluate('frobnicate(x)', scopeOf({ x: 1 }))).toThrow(ExprError);
  });

  it('throws ExprError on a syntax error', () => {
    expect(() => eng.compile('gm /')).toThrow(ExprError);
  });

  it('throws ExprError when an array is used as a ternary condition', () => {
    const a = new Float64Array([1, 2]);
    expect(() => eng.evaluate('a ? 1 : 2', scopeOf({ a }))).toThrow(ExprError);
  });
});
