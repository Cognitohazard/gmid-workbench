// A small normal form for sheet expressions, for the two places that compare expressions by what
// they say rather than by how they are spelled: the degree-of-freedom count of the DC wiring walk
// (nodes.ts), which needs each relation as a linear form over params and device quantities, and
// the wiring proposal (propose.ts), which matches node levels written in different words.
//
// An expression becomes a polynomial over FACTORS: a factor is an atom the caller names (a param,
// a device quantity) or an opaque term (a function call, a quotient by something that is not a
// number). Products are expanded and constants folded, so `p*q` and `q*p`, or `a - (b - c)` and
// `a + c - b`, have one canonical spelling. This is limited normalization, not algebra: nothing is
// solved and no identity beyond expansion and folding is used. Pure; zero DOM.

import { CONSTANTS } from '../constants';
import { parse, scalarFunction, type ExprNode } from '../expr';
import { IDENTIFIER } from './types';

type Node = ExprNode;

/** A polynomial: each monomial's key mapped to its coefficient. The key is `''` for the constant,
 *  the factor itself for a monomial of one factor, and the sorted factors as a JSON list for a
 *  product — so a key is never taken apart by splitting a string, and an opaque factor that itself
 *  spells a product stays whole. */
export type Poly = Map<string, number>;

/** The factors a monomial key stands for (see Poly): no factor spelling starts with `[`. */
const factorsOf = (key: string): string[] =>
  key === '' ? [] : key.startsWith('[') ? (JSON.parse(key) as string[]) : [key];

/** The key of a monomial with these factors. */
const keyOf = (factors: readonly string[]): string => {
  const sorted = [...factors].sort();
  return sorted.length <= 1 ? (sorted[0] ?? '') : JSON.stringify(sorted);
};

/** How the normal form reads one identifier: as a polynomial (an atom, a number, or an alias the
 *  caller expanded), or undefined for a name the caller does not know — which is then an
 *  expression constant where it names one (a sheet's own names shadow the constants, as they do
 *  in evaluation) and an opaque unresolved term otherwise. */
export type Resolver = (name: string) => Poly | undefined;

// Parses by source string. A parse is read-only to every reader here (normalize, selectorRoot and
// the proposal's sourceOf only walk it), so one per distinct source is shared; the sources are a
// document's own expressions, a small author-fixed set.
const PARSE_CACHE = new Map<string, Node | null>();

/** Parse an expression as the engine does — an engineering-notation literal (`100m`) is a number —
 *  or undefined where the parser refuses it. */
export function parseExpr(src: string): Node | undefined {
  let node = PARSE_CACHE.get(src);
  if (node === undefined) {
    try {
      node = parse(src);
    } catch {
      node = null;
    }
    PARSE_CACHE.set(src, node);
  }
  return node ?? undefined;
}

/** A factor that names an atom the caller resolved — an identifier — rather than an opaque term. */
const PLAIN_FACTOR = IDENTIFIER;

/** A number at twelve significant digits, as a canonical spelling or a message shows it. */
export const shown = (c: number): string => String(Number(c.toPrecision(12)));

export const constPoly = (c: number): Poly => new Map(c === 0 ? [] : [['', c]]);
export const atomPoly = (name: string): Poly => new Map([[name, 1]]);

/** The polynomial a + k·b, with every monomial that cancels to zero dropped. */
export function add(a: Poly, b: Poly, k = 1): Poly {
  const out = new Map(a);
  for (const [m, c] of b) {
    const v = (out.get(m) ?? 0) + k * c;
    if (v === 0) out.delete(m);
    else out.set(m, v);
  }
  return out;
}

/** The polynomial k·a. */
export const scale = (a: Poly, k: number): Poly => add(new Map(), a, k);

/** Past this many monomials a product is not expanded further: it becomes one opaque term. */
const MAX_MONOMIALS = 64;

function mul(a: Poly, b: Poly): Poly | undefined {
  let out: Poly = new Map();
  for (const [ma, ca] of a)
    for (const [mb, cb] of b)
      out = add(out, new Map([[keyOf([...factorsOf(ma), ...factorsOf(mb)]), ca * cb]]));
  return out.size > MAX_MONOMIALS ? undefined : out;
}

/** The constant a polynomial is, or undefined when it carries any other monomial. */
export function constantOf(p: Poly): number | undefined {
  if (p.size === 0) return 0;
  return p.size === 1 && p.has('') ? (p.get('') as number) : undefined;
}

/** The canonical spelling of a polynomial: its monomials in sorted order with their coefficients
 *  at twelve significant digits, so a rounding difference in the last place spells the same. */
export function canon(p: Poly): string {
  const terms = [...p]
    .filter(([, c]) => Number(c.toPrecision(12)) !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([m, c]) => (m === '' ? shown(c) : `${shown(c)}*${factorsOf(m).join(' * ')}`));
  return terms.length ? terms.join(' + ') : '0';
}

/** A polynomial as one opaque factor. */
const opaque = (tag: string, ...parts: Poly[]): Poly =>
  atomPoly(`${tag}(${parts.map(canon).join(', ')})`);

/** Functions whose arguments may be written in any order. */
const SYMMETRIC: ReadonlySet<string> = new Set(['min', 'max', 'par']);

/** The polynomial `node` stands for, reading each identifier through `resolve`. */
export function normalize(node: Node, resolve: Resolver): Poly {
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'number') return constPoly(node.value);
      if (typeof node.value === 'boolean') return constPoly(node.value ? 1 : 0);
      return atomPoly(`lit(${node.raw})`);
    case 'Identifier':
      return (
        resolve(node.name) ??
        (Object.prototype.hasOwnProperty.call(CONSTANTS, node.name)
          ? constPoly(CONSTANTS[node.name])
          : atomPoly(`unresolved(${node.name})`))
      );
    case 'UnaryExpression': {
      const a = normalize(node.argument, resolve);
      if (node.operator === '-') return scale(a, -1);
      if (node.operator === '+') return a;
      return opaque(`op${node.operator}`, a);
    }
    case 'BinaryExpression': {
      const a = normalize(node.left, resolve);
      const b = normalize(node.right, resolve);
      const ca = constantOf(a);
      const cb = constantOf(b);
      switch (node.operator) {
        case '+':
          return add(a, b);
        case '-':
          return add(a, b, -1);
        case '*':
          return mul(a, b) ?? opaque('mul', a, b);
        case '/':
          if (cb !== undefined && cb !== 0) return scale(a, 1 / cb);
          return mul(a, opaque('inv', b)) ?? opaque('div', a, b);
        case '^': {
          if (ca !== undefined && cb !== undefined) return constPoly(Math.pow(ca, cb));
          if (cb !== undefined && Number.isInteger(cb) && cb >= 0 && cb <= 4) {
            let out: Poly | undefined = constPoly(1);
            for (let i = 0; i < cb && out; i++) out = mul(out, a);
            if (out) return out;
          }
          return opaque('pow', a, b);
        }
        default:
          return opaque(`op${node.operator}`, a, b);
      }
    }
    case 'ConditionalExpression':
      return opaque(
        'cond',
        normalize(node.test, resolve),
        normalize(node.consequent, resolve),
        normalize(node.alternate, resolve),
      );
    case 'CallExpression': {
      const fn = node.callee.type === 'Identifier' ? node.callee.name : '?';
      const args = node.arguments.map((a) => normalize(a, resolve));
      const consts = args.map(constantOf);
      // A call of a function the engine evaluates, on constant arguments, is the number it returns.
      const fold = scalarFunction(fn);
      if (fold && consts.every((c) => c !== undefined)) {
        const v = fold(...(consts as number[]));
        if (Number.isFinite(v)) return constPoly(v);
      }
      const parts = args.map(canon);
      if (SYMMETRIC.has(fn)) parts.sort();
      return atomPoly(`${fn}(${parts.join(', ')})`);
    }
    default:
      return atomPoly(`?(${JSON.stringify(node)})`);
  }
}

/** The polynomial an expression stands for, or one opaque factor spelling the source when the
 *  parser refuses it. */
export function normalizeSrc(src: string, resolve: Resolver): Poly {
  const node = parseExpr(src);
  return node ? normalize(node, resolve) : atomPoly(`src(${src.replace(/\s+/g, '')})`);
}

/** Whether a polynomial is linear in atoms the caller resolved: every monomial is the constant or
 *  one plain factor. */
export function isLinear(p: Poly): boolean {
  for (const m of p.keys()) if (m !== '' && !PLAIN_FACTOR.test(m)) return false;
  return true;
}

/**
 * A linear form for the rank count: `p` itself where it is linear in plain atoms; anything else is
 * ONE opaque atom, interned by its canonical spelling, so two relations written as the same
 * non-linear value share one unknown — and a value and its negative share it with opposite signs,
 * the spelling taken with its first monomial positive. Opaque atoms are spelled with a leading `~`
 * so a caller can tell them from plain ones.
 */
export function linearForm(p: Poly): Poly {
  if (isLinear(p)) return p;
  const first = [...p.keys()].sort()[0];
  const k = first !== undefined && (p.get(first) as number) < 0 ? -1 : 1;
  return new Map([[`~(${canon(scale(p, k))})`, k]]);
}

/** Whether a linear form carries an opaque atom (see linearForm). */
export const hasOpaque = (p: Poly): boolean => [...p.keys()].some((m) => m.startsWith('~'));

/**
 * The root shape a declared axis-sign selector is read in: `sel * (E)` or `(E) * sel`, optionally
 * under one unary minus (`-(sel * E)` or `-sel * E`). `isSelector` says which names are declared
 * selectors; both operands are tried, so `V_x * p_sign` finds `p_sign` although `V_x` is an
 * identifier too. Returns the selector's name, the expression it multiplies, and the sign the minus
 * contributes; undefined for any other shape.
 */
export function selectorRoot(
  node: Node,
  isSelector: (name: string) => boolean,
): { name: string; inner: Node; sign: 1 | -1 } | undefined {
  let outer: 1 | -1 = 1;
  let n = node;
  if (n.type === 'UnaryExpression' && n.operator === '-') {
    outer = -1;
    n = n.argument;
  }
  if (n.type !== 'BinaryExpression' || n.operator !== '*') return undefined;
  /** The selector an operand names, with the sign a minus of its own adds — only where the whole
   *  expression carries none, so at most one minus is read. */
  const named = (x: Node): { name: string; sign: 1 | -1 } | undefined => {
    if (x.type === 'Identifier' && isSelector(x.name)) return { name: x.name, sign: outer };
    if (
      outer === 1 &&
      x.type === 'UnaryExpression' &&
      x.operator === '-' &&
      x.argument.type === 'Identifier' &&
      isSelector(x.argument.name)
    )
      return { name: x.argument.name, sign: -1 };
    return undefined;
  };
  const left = named(n.left);
  if (left) return { ...left, inner: n.right };
  const right = named(n.right);
  if (right) return { ...right, inner: n.left };
  return undefined;
}

/** The relative size below which a coefficient left over by elimination is rounding, not a term. */
const RANK_TOL = 1e-9;

/**
 * The rank of a list of linear forms, by elimination in the order given, and which rows raised it
 * — the first maximal independent set in that order. The constant term is a column like any atom,
 * so a row that reduces to a nonzero constant (two levels that contradict) counts. A row is
 * treated as zero when every coefficient left is below RANK_TOL of its largest original one.
 */
export function rankOf(rows: readonly Poly[]): { rank: number; independent: number[] } {
  const basis: { pivot: string; row: Poly }[] = [];
  const independent: number[] = [];
  rows.forEach((original, i) => {
    let row = new Map(original);
    const size = Math.max(0, ...[...original.values()].map(Math.abs));
    for (const { pivot, row: b } of basis) {
      const c = row.get(pivot);
      if (c !== undefined && c !== 0) row = add(row, b, -c / (b.get(pivot) as number));
    }
    for (const [m, c] of row) if (Math.abs(c) <= RANK_TOL * size) row.delete(m);
    if (row.size === 0) return;
    let pivot = '';
    let best = -1;
    for (const [m, c] of row)
      if (Math.abs(c) > best || (Math.abs(c) === best && m < pivot)) {
        best = Math.abs(c);
        pivot = m;
      }
    basis.push({ pivot, row });
    independent.push(i);
  });
  return { rank: basis.length, independent };
}
