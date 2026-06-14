// jsep-backed expression engine for the gm/ID namespace. Pure, deterministic,
// zero DOM imports.
//
// Values are scalars or flat numeric columns (number | Float64Array). Binary
// arithmetic (+ - * / ^) and unary minus are ELEMENTWISE with scalar<->array
// broadcast; array⊗array requires equal length. Comparison and logical operators
// are SCALAR-only (they drive ternary conditions). A small fixed set of math
// functions is supported. Identifiers resolve via the Scope, then the engine's
// constant map, else ExprError. Eng-notation numeric literals (e.g. "100n") are
// rewritten to plain numbers before parsing.

import jsep from 'jsep';
import type { CompiledExpr, ExprEngine, Scope, Value } from '../types';
import { ExprError } from '../types';
import { CONSTANTS } from '../constants';
import { parseEng } from '../units';

// Register '^' as a right-handed power operator. jsep is a module singleton;
// adding the same op twice is idempotent, so this is safe at module load.
jsep.addBinaryOp('^', 11);

// --- minimal jsep AST shapes (we only touch the node kinds we emit) ----------

interface Literal {
  type: 'Literal';
  value: number | boolean | string | null;
  raw: string;
}
interface Identifier {
  type: 'Identifier';
  name: string;
}
interface UnaryExpression {
  type: 'UnaryExpression';
  operator: string;
  argument: Node;
  prefix: boolean;
}
interface BinaryExpression {
  type: 'BinaryExpression';
  operator: string;
  left: Node;
  right: Node;
}
interface CallExpression {
  type: 'CallExpression';
  arguments: Node[];
  callee: Node;
}
interface ConditionalExpression {
  type: 'ConditionalExpression';
  test: Node;
  consequent: Node;
  alternate: Node;
}
type Node =
  | Literal
  | Identifier
  | UnaryExpression
  | BinaryExpression
  | CallExpression
  | ConditionalExpression;

// --- known function names ----------------------------------------------------

const UNARY_FNS = new Set(['sqrt', 'log10', 'log', 'exp', 'abs', 'atan', 'sign']);
const VARIADIC_FNS = new Set(['min', 'max']);
const FUNCTION_NAMES: ReadonlySet<string> = new Set([...UNARY_FNS, ...VARIADIC_FNS, 'par']);

// --- eng-notation literal preprocessing --------------------------------------

// A number body immediately followed by a known SPICE/SI suffix at a word
// boundary. The number must not be glued to a preceding identifier/digit/dot (so
// real identifiers like `x2` or member-ish text are left alone), and the suffix
// must not be followed by further identifier characters (so `1ms`, `1gain`, the
// `2` in `cgg2` etc. are not misread). "meg" is listed first so it wins over the
// single-char `m`/`g`.
const ENG_LITERAL =
  /(^|[^A-Za-z0-9_.])((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(meg|[fpnumkgt])(?![A-Za-z0-9_])/g;

/** Rewrite eng-notation numeric literals in `src` to plain decimal numbers. */
function preprocess(src: string): string {
  return src.replace(ENG_LITERAL, (_m, pre: string, num: string, suf: string) => {
    const v = parseEng(num + suf);
    // Emit with a leading space-safe boundary char preserved; use a parenthesis
    // wrapper so a leading '-' in `pre` keeps binding as subtraction, never as a
    // sign fused into the rewritten literal.
    return `${pre}(${String(v)})`;
  });
}

// --- value helpers -----------------------------------------------------------

function isArray(v: Value): v is Float64Array {
  return v instanceof Float64Array;
}

/** Apply a scalar binary op elementwise with scalar<->array broadcast. */
function broadcast2(a: Value, b: Value, op: (x: number, y: number) => number): Value {
  if (isArray(a) && isArray(b)) {
    if (a.length !== b.length) {
      throw new ExprError(
        `array length mismatch: ${a.length} vs ${b.length}`,
      );
    }
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = op(a[i], b[i]);
    return out;
  }
  if (isArray(a)) {
    const s = b as number;
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = op(a[i], s);
    return out;
  }
  if (isArray(b)) {
    const s = a as number;
    const out = new Float64Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = op(s, b[i]);
    return out;
  }
  return op(a as number, b as number);
}

/** Apply a scalar unary op elementwise. */
function map1(a: Value, op: (x: number) => number): Value {
  if (isArray(a)) {
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = op(a[i]);
    return out;
  }
  return op(a);
}

/** Coerce a Value used as a scalar condition; arrays are not allowed here. */
function asScalar(v: Value, ctx: string): number {
  if (isArray(v)) {
    throw new ExprError(`${ctx} requires a scalar, got an array`);
  }
  return v;
}

const ARITH: Readonly<Record<string, (x: number, y: number) => number>> = {
  '+': (x, y) => x + y,
  '-': (x, y) => x - y,
  '*': (x, y) => x * y,
  '/': (x, y) => x / y,
  '^': (x, y) => Math.pow(x, y),
};

const CMP: Readonly<Record<string, (x: number, y: number) => boolean>> = {
  '>': (x, y) => x > y,
  '<': (x, y) => x < y,
  '>=': (x, y) => x >= y,
  '<=': (x, y) => x <= y,
  '==': (x, y) => x === y,
  '!=': (x, y) => x !== y,
};

const UNARY_IMPL: Readonly<Record<string, (x: number) => number>> = {
  sqrt: Math.sqrt,
  log10: Math.log10,
  log: Math.log,
  exp: Math.exp,
  abs: Math.abs,
  atan: Math.atan,
  sign: Math.sign,
};

// --- evaluation --------------------------------------------------------------

function evalNode(node: Node, scope: Scope, constants: Record<string, number>): Value {
  switch (node.type) {
    case 'Literal': {
      const v = node.value;
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      throw new ExprError(`unsupported literal: ${node.raw}`);
    }
    case 'Identifier': {
      const fromScope = scope.resolve(node.name);
      if (fromScope !== undefined) return fromScope;
      if (Object.prototype.hasOwnProperty.call(constants, node.name)) {
        return constants[node.name];
      }
      throw new ExprError(`unknown identifier: ${node.name}`);
    }
    case 'UnaryExpression': {
      if (node.operator === '-') {
        return map1(evalNode(node.argument, scope, constants), (x) => -x);
      }
      if (node.operator === '+') {
        return evalNode(node.argument, scope, constants);
      }
      if (node.operator === '!') {
        const v = asScalar(evalNode(node.argument, scope, constants), 'logical "!"');
        return v ? 0 : 1;
      }
      throw new ExprError(`unsupported unary operator: ${node.operator}`);
    }
    case 'BinaryExpression': {
      const op = node.operator;
      if (op === '&&' || op === '||') {
        const l = asScalar(evalNode(node.left, scope, constants), `logical "${op}"`);
        if (op === '&&') {
          if (!l) return 0;
          return asScalar(evalNode(node.right, scope, constants), `logical "${op}"`)
            ? 1
            : 0;
        }
        // '||'
        if (l) return 1;
        return asScalar(evalNode(node.right, scope, constants), `logical "${op}"`) ? 1 : 0;
      }
      if (op in CMP) {
        const l = asScalar(evalNode(node.left, scope, constants), `comparison "${op}"`);
        const r = asScalar(evalNode(node.right, scope, constants), `comparison "${op}"`);
        return CMP[op](l, r) ? 1 : 0;
      }
      if (op in ARITH) {
        const l = evalNode(node.left, scope, constants);
        const r = evalNode(node.right, scope, constants);
        return broadcast2(l, r, ARITH[op]);
      }
      throw new ExprError(`unsupported operator: ${op}`);
    }
    case 'ConditionalExpression': {
      const cond = asScalar(evalNode(node.test, scope, constants), 'ternary condition');
      return cond
        ? evalNode(node.consequent, scope, constants)
        : evalNode(node.alternate, scope, constants);
    }
    case 'CallExpression': {
      const callee = node.callee;
      if (callee.type !== 'Identifier') {
        throw new ExprError('only named function calls are supported');
      }
      const fn = callee.name;
      const args = node.arguments.map((a) => evalNode(a, scope, constants));

      if (UNARY_FNS.has(fn)) {
        if (args.length !== 1) {
          throw new ExprError(`${fn}() takes exactly 1 argument, got ${args.length}`);
        }
        return map1(args[0], UNARY_IMPL[fn]);
      }
      if (VARIADIC_FNS.has(fn)) {
        if (args.length === 0) {
          throw new ExprError(`${fn}() requires at least 1 argument`);
        }
        const pick = fn === 'min' ? Math.min : Math.max;
        return args.reduce((acc, cur) => broadcast2(acc, cur, pick));
      }
      if (fn === 'par') {
        if (args.length < 2) {
          throw new ExprError('par() requires at least 2 arguments');
        }
        // par(a,b,...) = 1 / sum(1/ai), elementwise.
        const recipSum = args
          .map((a) => map1(a, (x) => 1 / x))
          .reduce((acc, cur) => broadcast2(acc, cur, (x, y) => x + y));
        return map1(recipSum, (x) => 1 / x);
      }
      throw new ExprError(`unknown function: ${fn}`);
    }
    default: {
      const t = (node as { type?: string }).type ?? 'unknown';
      throw new ExprError(`unsupported expression node: ${t}`);
    }
  }
}

/** Collect free identifiers that are neither constants nor function names. */
function collectNames(
  node: Node,
  constants: Record<string, number>,
  acc: Set<string>,
): void {
  switch (node.type) {
    case 'Identifier':
      if (
        !FUNCTION_NAMES.has(node.name) &&
        !Object.prototype.hasOwnProperty.call(constants, node.name)
      ) {
        acc.add(node.name);
      }
      return;
    case 'UnaryExpression':
      collectNames(node.argument, constants, acc);
      return;
    case 'BinaryExpression':
      collectNames(node.left, constants, acc);
      collectNames(node.right, constants, acc);
      return;
    case 'ConditionalExpression':
      collectNames(node.test, constants, acc);
      collectNames(node.consequent, constants, acc);
      collectNames(node.alternate, constants, acc);
      return;
    case 'CallExpression':
      // The callee is a function name, not a free identifier; skip it.
      for (const a of node.arguments) collectNames(a, constants, acc);
      return;
    default:
      return;
  }
}

// --- public API --------------------------------------------------------------

/**
 * Create an expression engine bound to a constant map (defaults to CONSTANTS).
 */
export function createEngine(constants: Record<string, number> = { ...CONSTANTS }): ExprEngine {
  function compile(src: string): CompiledExpr {
    let ast: Node;
    try {
      ast = jsep(preprocess(src)) as unknown as Node;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ExprError(`parse error in "${src}": ${msg}`);
    }
    const nameSet = new Set<string>();
    collectNames(ast, constants, nameSet);
    const names = [...nameSet];

    return {
      src,
      names,
      eval(scope: Scope): Value {
        return evalNode(ast, scope, constants);
      },
    };
  }

  function evaluate(src: string, scope: Scope): Value {
    return compile(src).eval(scope);
  }

  return { compile, evaluate };
}
