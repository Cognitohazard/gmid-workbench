// The fixed-hardware transformation: a sheet document rewritten so a range-end run re-settles the
// BIAS of the design the base run just produced, rather than sizing a fresh design at the
// endpoint. That is the difference between the two questions the engine answers — whether a
// design TYPE is feasible under a spec (which must be free to re-derive), and whether THIS design
// still works at the ends of its claimed range (which must not).
//
// Pure and structural: nothing here evaluates, and the only expressions read are the `hold`s,
// for the names of the device currents they balance (see heldOnGate). The mechanism
// is entirely "rewrite the givens, then let the existing machinery run" — the solved-param search,
// the vds subtractions, the (W, id) inversion and the (W, vgs) read all already re-settle a fixed
// device at a new bias, so no new solver appears anywhere in this file. Internal to the engine —
// the range-end runs in eval.ts and the condition runs in corners/ are the callers — and not on
// the public barrel, because a caller outside them has no doc to hand it that the engine has not
// already produced a base result for.

import type { QAWarning } from '../types';
import { BINDABLE } from '../device';
import {
  balancesOf,
  blockPath,
  constrained,
  deviceName,
  heldGateOf,
  heldOnGate,
  holdAsConstraint,
  holds,
  MAX_BLOCK_DEPTH,
  PATH_SEP,
  prefixBlockPath,
} from './types';
import type { SizingReport, SheetGivens, SheetBlockReport, SheetDoc, SheetBlock } from './types';

/** The three quantities a range end holds fixed: the geometry, and a current the author wrote. */
export const HELD_AT_A_RANGE_END: ReadonlySet<string> = new Set(['W', 'L', 'id']);

/** Every bindable quantity EXCEPT the pair transformed givens end up holding. Fixing the
 *  hardware replaces all of them with the width the base run solved, so none may survive into a
 *  range-end run — one left behind would re-size the transistor there, which is exactly what a
 *  fixed-hardware check must not do. Subtracted from the device module's own list rather than
 *  written out, so a quantity added to the namespace is dropped here by default: surviving
 *  silently is the dangerous direction, and it is the one a hand-copied list takes.
 *
 *  `vgs` is in this set although a given vgs CAN describe fixed hardware across a condition — a
 *  gate on a shared wire. Whether it does is the sheet's to declare (see heldOnGate), and where it
 *  is declared holdGivens puts it back after this set is cleared, in place of the current; dropping
 *  it here keeps the rule "nothing survives unless holdGivens says so" free of exceptions. */
const OPERATING_POINT_KEYS: readonly (keyof SheetGivens)[] = BINDABLE.filter(
  (k) => !HELD_AT_A_RANGE_END.has(k),
);

/**
 * A numeric value as an expression string that parses back to the SAME double. `String` emits
 * the shortest round-tripping form for every finite number, which is what this needs — a
 * fixed-digit reformat would hold the hardware at a value the base run never sized, and the
 * endpoint is meant to run the base's transistor to the last digit.
 */
function numExpr(v: number): string {
  return String(v);
}

/** The base run's shape this transformation reads: one sizing report per node of the tree, in the
 *  same order the document declares its blocks. Stated structurally so both `SheetResult` (the top
 *  of the tree) and `SheetBlockReport` (every node below it) satisfy it. */
interface SizingTree {
  sizing?: SizingReport;
  blocks?: readonly SheetBlockReport[];
  held?: Record<string, number>;
}

/** The transformed document plus the blocks whose current the transformation had to ASSUME (see
 *  RangeEndReport.assumedSource). Returned together because the assumption is made where the
 *  rewrite happens and is invisible afterwards — the transformed givens look exactly like
 *  authored ones. */
export interface HeldHardware {
  doc: SheetDoc;
  assumedSource: string[];
  /** The `hold` params (by block path) the base run recorded no value for, left as authored. A
   *  caller must not report a run of this document as fixed hardware while any are listed. */
  unheld: string[];
}

/**
 * A held design with its claimed operating range fixed at the numbers the base run resolved it
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
 * Rewrite every device's givens in `doc` to the fixed-hardware form of the design `base` reports,
 * so a re-evaluation at another condition moves the operating point and nothing else.
 *
 * The rule is a decision on which givens are present, and for a device given a gate voltage, on
 * whether the sheet DECLARES that gate to be the fixed thing — no other expression is read, so a
 * sheet cannot author its way into a different classification:
 *
 *  - **an authored `W`** ⇒ the givens are left ALONE. They are already width-first, and W's partner
 *    is how the sheet states the device's operating point. When that partner is `vgs` — the
 *    form the library's mirrors use — the givens ARE the gate tie, and leaving them alone is what
 *    makes it hold: re-evaluating `ref__vgs` at the new condition reads the gate voltage the
 *    reference settles to THERE, so the two devices stay on one wire under any move at all,
 *    corner, temperature, supply or body bias.
 *    Width-first givens whose partner is an operating-point TARGET instead (a gm/ID, an fT) are
 *    left alone by the same rule and do not have that property: they hold a ratio rather than
 *    a wire, so under a move they re-settle to whatever gate voltage that ratio now takes.
 *    validateSheet warns where a sheet reaches that, and `vgs` is the fix.
 *  - **no `W`, an authored `vgs`, and a hold that balances its current** ⇒ hold the geometry
 *    numerically and KEEP the gate voltage expression; whatever else was given — a current, a
 *    transconductance — goes, and the current is read from the table at the held width and the
 *    gate voltage the expression gives there. The engine cannot tell a gate on a shared wire
 *    (`VDD - n__vgs`, an inverter's PMOS) from a gate voltage typed as an operating point, so the
 *    sheet says which: a `hold` on its sheet that reads this device's current (`I_bias - p__id`,
 *    on the typed current that sets the branch) is that declaration, and it is also what fixes
 *    the current there — zero at the design point by construction, and solved back to zero where
 *    the design is held (see heldOnGate, balancedBy). Without one, a gate voltage is an
 *    operating-point spec like any other, and the device falls under the next rule.
 *  - **no `W`, an authored `id`** ⇒ hold the geometry (W and L) numerically, drop the operating-
 *    point spec, and KEEP the authored current. The current expression is the hardware in the
 *    sheet's own algebra — a mirror ratio, a tail split, a KCL difference — so re-evaluating it
 *    is describing the same circuit at the new condition, not re-designing it.
 *  - **neither a width nor a current, nor a balanced gate** ⇒ hold the geometry AND the current
 *    numerically. The sheet never said where this device's current comes from, so holding it is
 *    the only reading available; it amounts to an ideal source, which is reported rather than
 *    assumed silently.
 *
 * `L` is held alongside `W` because both are the transistor: an L that referenced a param a
 * range end overrides would otherwise hand the endpoint a different device while the report
 * claimed fixed hardware.
 *
 * The held geometry is exact; what is read off it is not. Rewritten givens read their operating
 * point back off the table at the held width, whereas givens that named a gm/ID had that ratio
 * honoured arithmetically — so the endpoint reports a gm a fraction under the base's even where
 * nothing about the condition moved, and every quantity derived from gm inherits the shift. It is
 * an interpolation residual, of order 0.1% on the demo model; coverage.test.ts pins the magnitude
 * so it cannot grow unnoticed.
 *
 * Nodes are matched by INDEX, never by block name: the evaluator pushes exactly one child report
 * per block — including the ones it killed — so the indices align, while names can duplicate on a
 * document that reached the engine without validation.
 */
export function holdHardware(doc: SheetDoc, base: SizingTree): HeldHardware {
  const out: HeldHardware = { doc, assumedSource: [], unheld: [] };
  out.doc = holdNode(doc, base, '', out);
  return out;
}

/**
 * The document a fixed-hardware run of `doc` would evaluate, in SHAPE only: every device's givens
 * and every `hold` rewritten exactly as holdHardware rewrites them, against placeholder numbers.
 * For asking a structural question of that document before any run exists — validation reads it
 * to check that a current balance's param reaches a current where the design is held. Not for
 * evaluation.
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

/**
 * What a held run says about each gate a `hold` keeps where the design is held (see heldGateOf —
 * not a current balance, which holds no gate): the gate stays at the value its hold expression
 * took at the design point, standing in for a bias line that does not move, while the bias branch
 * of a real circuit would move it with the corner. One warning per held gate anywhere in the tree,
 * attributed to the block path of the sheet that declares the hold. Read off the held document
 * (holdHardware), where each hold is the design constraint `held` marks and its `rhs` is the
 * nominal value; a document no hold was rewritten in yields none, so the design point never
 * carries one.
 */
export function heldGateWarnings(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const visit = (d: SheetDoc, path: string[]): void => {
    for (const p of Array.isArray(d.params) ? d.params : []) {
      if (!constrained(p) || p.designConstraint.held !== true) continue;
      const { lhs, rhs } = p.designConstraint;
      const device = heldGateOf(d, { ...p, hold: lhs });
      if (!device) continue;
      const v = Number(rhs);
      out.push(
        prefixBlockPath(path, {
          rule: 'sheet-held-gate',
          severity: 'warning',
          message:
            `the gate of ${deviceName(device)} is held at its nominal value, ` +
            `${Number.isFinite(v) ? `${Number(v.toPrecision(4))} V` : rhs} (the hold of ` +
            `"${p.name}", ${lhs}) — a real bias branch would move it with the corner or ` +
            `condition, so the figures at this point are approximate`,
          location: p.name,
        }),
      );
    }
    if (path.length >= MAX_BLOCK_DEPTH) return;
    for (const b of Array.isArray(d.blocks) ? d.blocks : [])
      if (b?.doc) visit(b.doc, [...path, b.name]);
  };
  visit(doc, []);
  return out;
}

function holdNode(
  doc: SheetDoc,
  base: SizingTree,
  path: string,
  out: HeldHardware,
  parentBalances = false,
): SheetDoc {
  const givens = doc.givens
    ? holdGivens(doc.givens, base.sizing, path, out.assumedSource, heldOnGate(doc, parentBalances))
    : undefined;
  const balanced = balancesOf(doc);
  const blocks = doc.blocks?.map((block, i) =>
    holdBlock(block, base.blocks?.[i], path, out, balanced.has(block.name)),
  );
  // A node under a gate: the gate voltage the base run needed is part of the hardware, so the
  // held expression becomes a design constraint against that value and the node is re-solved
  // (SheetVar.hold). A current balance becomes one the same way, against the zero it read.
  const params = doc.params.map((p) => {
    if (!holds(p)) return p;
    const v = base.held?.[p.name];
    if (v === undefined || !Number.isFinite(v)) {
      out.unheld.push(`${path}${p.name}`);
      return p;
    }
    return holdAsConstraint(p, numExpr(v));
  });
  return {
    ...doc,
    params,
    ...(givens ? { givens } : {}),
    ...(blocks ? { blocks } : {}),
  };
}

function holdBlock(
  block: SheetBlock,
  child: SheetBlockReport | undefined,
  path: string,
  out: HeldHardware,
  balanced: boolean,
): SheetBlock {
  // A block with no embedded doc never sized (validation names it); there is nothing to hold and
  // no report to hold it from.
  if (!block.doc) return block;
  return {
    ...block,
    doc: holdNode(block.doc, child ?? {}, `${path}${block.name}${PATH_SEP}`, out, balanced),
  };
}

function holdGivens(
  b: SheetGivens,
  report: SizingReport | undefined,
  path: string,
  assumedSource: string[],
  onGate: boolean,
): SheetGivens {
  if (b.W !== undefined) return b;
  // No usable report means no hardware to hold it AT. Reachable only through the public
  // evaluateSheet on a doc whose base run did not stand, which the caller gates on; leaving the
  // givens authored is the same "degrade, never invent" the rest of the engine takes.
  if (!report?.ok) return b;
  // Dropped by key rather than by a written-out list of fields: OPERATING_POINT_KEYS is derived
  // from the device module's own selector list, so a selector added to the namespace is dropped
  // here automatically instead of surviving into a fixed-hardware run because a hand-copied list
  // went stale.
  const out: SheetGivens = { ...b };
  for (const k of OPERATING_POINT_KEYS) delete out[k];
  out.L = numExpr(report.L);
  out.W = numExpr(report.W);
  if (onGate && b.vgs !== undefined) {
    // Declared on its wire: the gate stays there and the current follows — (W, vgs), read.
    delete out.id;
    out.vgs = b.vgs;
  } else if (b.id === undefined) {
    out.id = numExpr(report.id);
    assumedSource.push(blockPath(path));
  }
  return out;
}
