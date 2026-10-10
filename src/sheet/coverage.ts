// The edge transformation: a sheet document rewritten so a containment-edge run re-settles the
// BIAS of the design the base run just produced, rather than sizing a fresh design at the
// endpoint. That is the difference between the two questions the engine answers — whether a
// design TYPE closes under a spec (which must be free to re-derive), and whether THIS design
// still works at the ends of its claimed range (which must not).
//
// Pure and structural: no expression is introspected, and nothing here evaluates. The mechanism
// is entirely "rewrite the bind, then let the existing machinery run" — the pin bisection, the
// vds subtractions and the (W, id) inversion all already re-settle a fixed device at a new bias,
// so no new solver appears anywhere in this file. Internal to the engine — the range-end runs in
// eval.ts and the condition runs in corners/ are the callers — and not on the public barrel,
// because a caller outside them has no doc to hand it that the engine has not already produced
// a base result for.

import { BINDABLE } from '../device';
import { blockPath, holdAsPin, holds, PATH_SEP } from './types';
import type { SizingReport, SheetGivens, SheetBlockReport, SheetDoc, SheetBlock } from './types';

/** The three quantities a range end holds fixed: the geometry, and a current the author wrote. */
export const HELD_AT_A_RANGE_END: ReadonlySet<string> = new Set(['W', 'L', 'id']);

/** Every bindable quantity EXCEPT the pair a transformed bind ends up holding. Fixing the
 *  hardware replaces all of them with the width the base run solved, so none may survive into a
 *  range-end run — one left behind would re-size the transistor there, which is exactly what a
 *  fixed-hardware check must not do. Subtracted from the device module's own list rather than
 *  written out, so a quantity added to the namespace is dropped here by default: surviving
 *  silently is the dangerous direction, and it is the one a hand-copied list takes.
 *
 *  `vgs` is in this set, and that is deliberate even though a bound vgs is the one thing that
 *  DOES describe fixed hardware across a condition. The bind that says so is width-first —
 *  `{ W: "K*ref__W", vgs: "ref__vgs" }` — and pinBind returns those untouched before this set
 *  is consulted, so the gate tie survives a range end intact and re-reads the reference's newly
 *  settled gate voltage there, which is the whole point of binding it. A vgs bound WITHOUT a
 *  width is a different statement: pinning that device's geometry already fixes it, and keeping
 *  a gate voltage beside a pinned W and a pinned or authored current would over-determine the
 *  transistor with three constraints where the sizer takes two. */
const OPERATING_POINT_KEYS: readonly (keyof SheetGivens)[] = BINDABLE.filter(
  (k) => !HELD_AT_A_RANGE_END.has(k),
);

/**
 * A numeric value as an expression string that parses back to the SAME double. `String` emits
 * the shortest round-tripping form for every finite number, which is what this needs — a
 * fixed-digit reformat would pin the hardware to a value the base run never sized, and the
 * endpoint is meant to run the base's transistor to the last digit.
 */
function numExpr(v: number): string {
  return String(v);
}

/** The base run's shape this transformation reads: one bind report per node of the tree, in the
 *  same order the document declares its uses. Stated structurally so both `SheetResult` (the top
 *  of the tree) and `SheetBlockReport` (every node below it) satisfy it. */
interface BindTree {
  sizing?: SizingReport;
  blocks?: readonly SheetBlockReport[];
  held?: Record<string, number>;
}

/** The transformed document plus the blocks whose current the transformation had to ASSUME (see
 *  RangeEndReport.assumedSource). Returned together because the assumption is made where the
 *  rewrite happens and is invisible afterwards — the transformed bind looks exactly like an
 *  authored one. */
export interface HeldHardware {
  doc: SheetDoc;
  assumedSource: string[];
  /** The `hold` params (by use path) the base run recorded no value for, left as authored. A
   *  caller must not report a run of this document as fixed hardware while any are listed. */
  unheld: string[];
}

/**
 * A held design with its claimed operating range pinned to the numbers the base run resolved it
 * to. The range describes the APPLICATION — the input levels and loads the circuit is promised
 * to work across — which does not move with the silicon, so an end written as an expression
 * (`V_out - 0.2`) is the same voltage at every process condition, not re-read from each
 * condition's own operating point. An end the base run could not resolve keeps its expression
 * and fails to resolve the same way everywhere.
 */
export function withNominalRange(
  held: HeldHardware,
  base: { rangeEnds?: readonly { set: Record<string, number> }[] },
): HeldHardware {
  const ends = held.doc.operatingRange;
  if (!Array.isArray(ends) || !base.rangeEnds) return held;
  const operatingRange = ends.map((e, i) => {
    const at = base.rangeEnds?.[i]?.set ?? {};
    const set = Object.fromEntries(
      Object.entries(e.set ?? {}).map(([k, expr]) => [k, k in at ? numExpr(at[k]) : expr]),
    );
    return { ...e, set };
  });
  return { ...held, doc: { ...held.doc, operatingRange } };
}

/** Why a design sized under assumed voltages is not asked whether it still works anywhere else.
 *  An `assumed` level is one the sheet's own parts determine and the author typed instead: held
 *  fixed while the conditions around it move, it stops being even an estimate, so every answer
 *  that rests on it is declined rather than given. One wording, for a range end and for another
 *  process condition alike. */
export const assumedLevelRefusal = (assumed: readonly string[]): string =>
  `the design is sized under assumed ${assumed.length === 1 ? 'level' : 'levels'} ` +
  `${assumed.join(', ')} — a typed value held fixed says nothing about the hardware. Derive ` +
  `it, or class it independent if nothing on the sheet sets it`;

/**
 * Rewrite every bind in `doc` to the fixed-hardware form of the design `base` reports, so a
 * re-evaluation at another condition moves the operating point and nothing else.
 *
 * The rule is a decision on two booleans — no expression is read, so a sheet cannot author its
 * way into a different classification:
 *
 *  - **an authored `W`** ⇒ the bind is left ALONE. It is already width-first, and its partner
 *    is how the sheet states the device's operating point. When that partner is `vgs` — the
 *    form the library's mirrors use — the bind IS the gate tie, and leaving it alone is what
 *    makes it hold: re-evaluating `ref__vgs` at the new condition reads the gate voltage the
 *    reference settles to THERE, so the two devices stay on one wire under any move at all,
 *    corner, temperature, supply or body bias.
 *    A width-first bind whose partner is an operating-point TARGET instead (a gm/ID, an fT) is
 *    left alone by the same rule and does not have that property: it holds a ratio rather than
 *    a wire, so under a move it re-settles to whatever gate voltage that ratio now takes.
 *    validateSheet warns where a sheet reaches that, and `vgs` is the fix.
 *  - **no `W`, an authored `id`** ⇒ pin the geometry (W and L) numerically, drop the operating-
 *    point spec, and KEEP the authored current. The current expression is the hardware in the
 *    sheet's own algebra — a mirror ratio, a tail split, a KCL difference — so re-evaluating it
 *    is describing the same circuit at the new condition, not re-designing it.
 *  - **neither** ⇒ pin the geometry AND the current numerically. The sheet never said where this
 *    device's current comes from, so holding it is the only reading available; it amounts to an
 *    ideal source, which is reported rather than assumed silently.
 *
 * `L` is pinned alongside `W` because both are the transistor: an L that referenced an
 * edge-overridden param would otherwise hand the endpoint a different device while the report
 * claimed fixed hardware.
 *
 * The pinned geometry is exact; what is read off it is not. A rewritten bind reads its operating
 * point back off the table at the pinned width, whereas a bind that named a gm/ID had that ratio
 * honoured arithmetically — so the endpoint reports a gm a fraction under the base's even where
 * nothing about the condition moved, and every quantity derived from gm inherits the shift. It is
 * an interpolation residual, of order 0.1% on the demo model; coverage.test.ts pins the magnitude
 * so it cannot grow unnoticed.
 *
 * Nodes are matched by INDEX, never by use name: the evaluator pushes exactly one child report
 * per use — including the ones it killed — so the indices align, while names can duplicate on a
 * document that reached the engine without validation.
 */
export function holdHardware(doc: SheetDoc, base: BindTree): HeldHardware {
  const out: HeldHardware = { doc, assumedSource: [], unheld: [] };
  out.doc = pinNode(doc, base, '', out);
  return out;
}

/**
 * The document a fixed-hardware run of `doc` would evaluate, in SHAPE only: every bind and every
 * `hold` rewritten exactly as holdHardware rewrites them, against placeholder numbers. For asking
 * a structural question of that document — which params its pins read — before any run exists.
 * Not for evaluation.
 */
export function heldShape(doc: SheetDoc): SheetDoc {
  const shape = (d: SheetDoc | undefined, name = ''): SheetBlockReport => ({
    name,
    title: '',
    feasible: true,
    provides: {},
    checks: [],
    ...(d?.givens ? { sizing: { ok: true, W: 1, L: 1, vgs: 0, id: 1 } } : {}),
    held: Object.fromEntries((d?.params ?? []).filter(holds).map((p) => [p.name, 0])),
    blocks: (d?.blocks ?? []).map((u) => shape(u.doc, u.name)),
  });
  return holdHardware(doc, shape(doc)).doc;
}

function pinNode(doc: SheetDoc, base: BindTree, path: string, out: HeldHardware): SheetDoc {
  const bind = doc.givens ? pinBind(doc.givens, base.sizing, path, out.assumedSource) : undefined;
  const uses = doc.blocks?.map((use, i) => pinUse(use, base.blocks?.[i], path, out));
  // A node under a gate: the gate voltage the base run needed is part of the hardware, so the
  // held expression becomes a pin against that value and the node is re-solved (SheetVar.hold).
  const params = doc.params.map((p) => {
    if (!holds(p)) return p;
    const v = base.held?.[p.name];
    if (v === undefined || !Number.isFinite(v)) {
      out.unheld.push(`${path}${p.name}`);
      return p;
    }
    return holdAsPin(p, numExpr(v));
  });
  return {
    ...doc,
    params,
    ...(bind ? { givens: bind } : {}),
    ...(uses ? { blocks: uses } : {}),
  };
}

function pinUse(
  use: SheetBlock,
  child: SheetBlockReport | undefined,
  path: string,
  out: HeldHardware,
): SheetBlock {
  // A use with no embedded doc never sized (validation names it); there is nothing to pin and
  // no report to pin it from.
  if (!use.doc) return use;
  return {
    ...use,
    doc: pinNode(use.doc, child ?? {}, `${path}${use.name}${PATH_SEP}`, out),
  };
}

function pinBind(
  b: SheetGivens,
  report: SizingReport | undefined,
  path: string,
  assumedSource: string[],
): SheetGivens {
  if (b.W !== undefined) return b;
  // No usable report means no hardware to pin TO. Reachable only through the public
  // evaluateSheet on a doc whose base run did not stand, which the caller gates on; leaving the
  // bind authored is the same "degrade, never invent" the rest of the engine takes.
  if (!report?.ok) return b;
  // Dropped by key rather than by a written-out list of fields: OPERATING_POINT_KEYS is derived
  // from the device module's own selector list, so a selector added to the namespace is dropped
  // here automatically instead of surviving into a coverage run because a hand-copied list went
  // stale.
  const out: SheetGivens = { ...b };
  for (const k of OPERATING_POINT_KEYS) delete out[k];
  out.L = numExpr(report.L);
  out.W = numExpr(report.W);
  if (b.id === undefined) {
    out.id = numExpr(report.id);
    assumedSource.push(blockPath(path));
  }
  return out;
}
