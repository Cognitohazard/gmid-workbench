// Structural QA for a leaf sheet, in the qa/validate() shape: init an array, push
// warning literals, skip-not-throw, return the bare array. It checks what evaluation
// cannot conveniently express — givens arity, finite params, equality tolerance, kind/op
// sanity, and a param shadowing a device quantity. It also owns the table-independent
// half of name resolution: whether a `block__key` reference names a scalar that block
// actually publishes, and whether a name a sheet claims to publish exists at all. Those
// answers need no device table, so they are structural. Resolving identifiers against
// the live value set stays evaluateSheet's job. DOM-free.

import type { QAWarning } from '../types';
import { compileExpr } from '../derive';
import { createEngine } from '../expr';
import { BINDABLE, bindProblem } from '../device';
import { PER_WIDTH_KEYS, TABLE_AFFIX, affixedColumn } from '../namespace';
import { HELD_AT_A_RANGE_END, heldShape } from './coverage';
import {
  blockWires,
  composedWiringProblems,
  deviceGateWires,
  formatOf,
  formatProblems,
  nodesProblems,
  structuralDiode,
  wiringRefusal,
} from './nodes';
import {
  BIAS_AXES,
  givenIsExpression,
  RANGE_END_SEP,
  PATH_SEP,
  blockPath,
  idSepProblem,
  MAX_BLOCK_DEPTH,
  docExpressions,
  engineSolved,
  holds,
  constrained,
  torn,
  constraintProblem,
  drainProblem,
  PARAM_CLASSES,
  PROVIDE_SEP,
  REGIONS,
  REGION_CHECK_ID,
  CHECK_KINDS,
  CHECK_OPS,
  joinProvide,
  providedNames,
  prefixBlockPath,
  prefixBlockWarning,
  splitProvide,
  balancedBy,
  balancesOf,
  blockOverride,
  deviceName,
  DEVICE_NAMES,
  heldGateOf,
  heldOnGate,
  isObject,
  META_PUBLISHED,
  namesOf,
  parses,
  type ParamClass,
  type SheetDoc,
  type SheetGivens,
  type SheetEquation,
  type SheetBlock,
  type SheetVar,
} from './types';

/** Free names inside each `abs(...)` call of an expression. A consistency check reads
 *  `abs(child__vgs - vgs_est) <= tol`, so the two sides of the round trip appear inside ONE
 *  absolute difference — which is what separates it from a headroom advisory check like
 *  `V_node - child__vdsat >= 0`, where the same two names appear with no claim that they are
 *  equal. The parser supplies the call sites (CompiledExpr.calls), so whitespace and nesting are
 *  its problem, not a second grammar's. */
function absArgNames(expr: string): readonly ReadonlySet<string>[] {
  try {
    return compileExpr(expr).calls.get('abs') ?? [];
  } catch {
    return [];
  }
}

/**
 * Quantities a bias assumption can be an assumption OF: the LEVEL a device sits at. A margin
 * quantity like vdsat is not one, and letting it count made a legitimately declared bias paired
 * with a symmetric headroom check — `abs(v_bias - dev__vdsat) <= 0.15`, which the format docs
 * recommend — read as a hand-tuned estimate.
 *
 * Hand-maintained, which the GIVENS_KEYS comment warns against for good reason. It stays a list
 * because nothing in the namespace distinguishes a level from a margin; deriving it needs a new
 * flag on BASE_QUANTITIES. Tolerable only because the blast radius is one advisory warning.
 */
const ASSUMPTION_TARGETS: readonly string[] = ['vgs', 'vth'];

/**
 * A param that BIASES a block while a check asserts that same param EQUALS the child's own
 * operating point is a hand-tuned assumption: the author guessed a value, biased the device with
 * the guess, and added an advisory check telling themselves to retune until the guess agrees. It
 * works, and it silently makes every number downstream depend on how carefully somebody re-typed a
 * voltage.
 *
 * Detected structurally, never by name: for each bias axis a child's givens declare, take the free
 * names of the expression feeding it, keep the ones that are parent params, and look for a check
 * that puts one of those params and something the same child provides inside a single absolute
 * difference. The absolute difference is the discriminator — it is the sheet asserting the two are
 * the same number. An advisory check that merely mentions both (headroom against a node voltage) is
 * not a round trip and must not be flagged.
 *
 * The message names the fix, which depends on where the assumption is used:
 *  - as `vds`, tied to the child's own `vgs` — the device is DIODE-CONNECTED. `vds = vgs` holds by
 *    construction; nothing needs estimating, the table can be read on that diagonal.
 *  - as `vsb` — the source sits above the bulk, so the node it sits on is the natural variable.
 *    Parameterize by that node and both of the device's bias coordinates are known outright.
 *  - anything else — usually a node voltage inside a stack, written as an estimated difference.
 *    Declare the node voltages and each bias becomes a subtraction.
 *
 * Advisory: the sheets carrying this pattern give correct answers today. It is a standing
 * invitation to reparameterize, not a defect report.
 */
function assumptionEstimates(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const paramByName = new Map(doc.params.map((p) => [p.name, p]));
  const checkNames = doc.checks.map((r) => ({
    id: r.id,
    absArgs: [...absArgNames(r.lhs), ...absArgNames(r.rhs)],
  }));

  for (const block of doc.blocks ?? []) {
    const givens = block.doc?.givens;
    if (!givens) continue;
    const provided = new Set(providedNames(block));
    for (const axis of BIAS_AXES) {
      // BIAS_AXES is namespace-derived; SheetGivens's bias fields are static keys. Index
      // structurally, as eval does, rather than by the literal key union.
      const childParam = (givens as unknown as Partial<Record<string, string>>)[axis];
      const expr = childParam === undefined ? undefined : block.params?.[childParam];
      if (expr === undefined) continue;
      const exprNames = namesOf(expr);
      const assumptions = exprNames.filter((n) => paramByName.has(n));
      if (assumptions.length === 0) continue;
      // Both sides of the round trip must sit inside ONE absolute difference — the sheet
      // asserting they are the same number, not an advisory check that happens to mention both.
      const levels = ASSUMPTION_TARGETS.map((q) => joinProvide(block.name, q)).filter((q) =>
        provided.has(q),
      );

      for (const r of checkNames) {
        const pair = r.absArgs.find(
          (a) => assumptions.some((n) => a.has(n)) && levels.some((q) => a.has(q)),
        );
        if (!pair) continue;
        const tiedTo = levels.filter((q) => pair.has(q));
        const hit = assumptions.find((n) => pair.has(n)) as string;
        // Diode-connected requires ALL of: the bias IS the assumption — the bare identifier, not
        // an expression over it (`2*vgs_est` or `vgs_est - 0.1` states the drop is NOT the vgs,
        // and "declare the diode" would change that design) — and the check compares exactly those
        // two quantities. A stack's KVL check — `abs((CM - in__vgs) + vds_a + vds_b - V_out)` —
        // also puts the two inside one abs, but it sums a loop of node drops, not an identity.
        const sole = expr.trim() === hit;
        const pairwise = pair.size === 2;
        const diode =
          axis === 'vds' && sole && pairwise && tiedTo.includes(joinProvide(block.name, 'vgs'));
        // An assumption the author has already classed `assumed` is not news: the sheet says in
        // its own words that it types this value instead of solving it, the check that ties it
        // back is how the assumption is checked, and the run lists it among the assumptions the
        // design was sized under — except for a diode, where the estimate need not exist at all
        // and the advice says how.
        if (!diode && paramByName.get(hit)?.class === 'assumed') continue;
        const fix = diode
          ? `"${block.name}" is diode-connected — its vds IS its vgs, so declare the diode connection instead of estimating it`
          : axis === 'vsb'
            ? `the source of "${block.name}" sits above the bulk — parameterize by that node voltage and both of its bias coordinates follow directly`
            : `this reads as a node voltage written as an estimated difference — declare the node voltages and let ${axis} be a subtraction`;
        out.push({
          rule: 'sheet-assumption',
          severity: 'warning',
          message:
            `param "${hit}" biases block "${block.name}" (${axis}) while check "${r.id}" ties it back ` +
            `to that block's own ${tiedTo.join(', ')} — a hand-tuned assumption about the operating ` +
            `point it is meant to produce. ${fix}`,
          location: block.name,
          symbol: hit,
        });
        break; // one finding per axis; the first check that closes the loop names it
      }
    }
  }
  return out;
}

/**
 * A device given a gate voltage, a current and no width says two things about one transistor
 * that the design point cannot tell apart and a held design has to: whether its GATE is the fixed
 * thing (a gate on a shared wire, an inverter's PMOS) or its CURRENT is (a gate voltage typed as an
 * operating point). Where the design is held it is held at its width and that current
 * (holdHardware), so its gate voltage is read separately, off whatever wire it was sized on — the
 * right reading for a current source, the wrong one for a device on a shared gate. The sheet
 * settles it with a `hold`: one that reads the device's current (`<block>__id`) balances it and
 * keeps the gate (heldOnGate); one that reads its gate-source voltage (`<block>__vgs`) keeps the
 * gate on a node by re-solving the node under it. Without either it is reported, naming both
 * remedies, because which one fits is the circuit's to say: a series partner on a shared wire
 * wants a hold that balances the two currents, and a mirror copy of a reference wants the
 * reference's width and gate voltage, so its current follows the data. A current given as a
 * number is a source by statement and draws nothing. The sheet's own device is asked about only
 * at the top of a tree: a child's own givens are checked from its parent's block, where its
 * overrides and the holds that could settle it are.
 */
function unsettledGates(doc: SheetDoc, top: boolean): QAWarning[] {
  const out: QAWarning[] = [];
  const read = new Set(doc.params.filter(holds).flatMap((p) => namesOf(p.hold)));
  /** Ask of one device: the sheet's own, or the device of `block`, read through the block — a
   *  child param the parent overrides reads what the parent wires into it, and the device's names
   *  are the ones it provides to this sheet. */
  const ask = (
    givens: SheetGivens | undefined,
    block: SheetBlock | undefined,
    who: string,
    location: string,
  ): void => {
    if (!givens || givens.W !== undefined || givens.vgs === undefined) return;
    if (typeof givens.id !== 'string') return;
    const id = ((block && blockOverride(block, givens.id.trim())) ?? givens.id).trim();
    const name = (k: string): string => (block ? joinProvide(block.name, k) : k);
    // A number reads no name: an expression of literals (and constants) is a source by statement.
    const literal = parses(id) && namesOf(id).length === 0;
    if (literal || read.has(name('id')) || read.has(name('vgs'))) return;
    out.push({
      rule: 'sheet-held-current',
      severity: 'warning',
      message:
        `${who} is given a gate voltage and a current ("${id}") and no width, so where the design ` +
        `is held it keeps its width and that current, and its gate voltage is read separately ` +
        `from the wire it was sized on. Say which it is: a series partner on a shared gate gets a ` +
        `hold that balances the two currents, on the typed current that sets them ("hold": ` +
        `"<that param> - ${name('id')}", with ${name('id')} available), and is then held on its ` +
        `gate voltage; a mirror copy of a reference gets the reference's width and gate voltage ` +
        `(W and vgs), so its current follows the data`,
      location,
    });
  };
  if (top) ask(doc.givens, undefined, deviceName('givens'), 'givens');
  for (const block of doc.blocks ?? [])
    ask(block.doc?.givens, block, `block "${block.name}"`, block.name);
  return out;
}

/**
 * A current balance (a `hold` that reads a device's current, see balancedBy) fixes its param where
 * the design is held, and the param is meant to be the current that sets the other side of the
 * balance — the bias typed into the NMOS against the PMOS's current. Checked on the held document
 * itself (heldShape), so the narrowing of which devices keep their gate is the one the run makes:
 * the param has to reach the current of a device the hold does not name. One that reaches none
 * would be solved to the balance and move nothing but its own number, and the held run would
 * report an agreement no device makes.
 */
function looseBalances(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const balances = doc.params.filter(holds).map((p) => ({ p, named: balancedBy(doc, p) }));
  if (!balances.some((b) => b.named.length)) return out;
  const held = heldShape(doc);
  for (const { p, named } of balances) {
    if (!named.length) continue;
    const entries = reachedGivens(held, [p.name]);
    const skip = new Set(named.map((d) => d || 'givens'));
    const reaches = entries.some(({ path, givens, reached }) => {
      if (skip.has(path)) return false;
      const reads = (k: string): boolean => {
        const v = (givens as unknown as Record<string, unknown>)[k];
        return (
          givenIsExpression(k) && typeof v === 'string' && namesOf(v).some((n) => reached.has(n))
        );
      };
      // A held current is the device's current; without one the current is read from the table
      // wherever its held givens put the operating point.
      return givens.id !== undefined ? reads('id') : Object.keys(givens).some(reads);
    });
    if (reaches) continue;
    out.push({
      rule: 'sheet-param',
      severity: 'error',
      message:
        `param "${p.name}": its hold "${p.hold}" balances the current of ` +
        `${named.map((d) => deviceName(d || 'givens')).join(', ')}, but where the ` +
        `design is held "${p.name}" reaches no other device's current, so solving it to the ` +
        `balance would move nothing but its own number. Give it to the device it programs (that ` +
        `device's id), so the balance is between two currents`,
      location: p.name,
    });
  }
  return out;
}

/**
 * Both directions of the composition interface, which is one question asked twice: does the
 * name on each side of a block boundary exist?
 *
 * Upward (what this sheet reads): a child exposes NOTHING except what its `provides` name —
 * evaluation publishes exactly that list and silently skips the rest — so an undeclared
 * `block__key` resolves to no value, the equation using it is dropped with a warning, and any hard
 * check downstream goes `na`. That degradation is correct for absent DATA and looks identical
 * from the outside, which is why the authoring slip is named here instead. A prefix naming no
 * block at all (a typo'd block name) degrades the same way, so it gets its own message rather
 * than hiding in the same blind spot.
 *
 * Downward (what this sheet publishes): a `provides` entry matching no param and no equation
 * exposes nothing, silently. For a leaf nobody composes yet there is no downstream reader to
 * notice, so the declared interface would rot unread. Two carve-outs, both because this check must
 * stay table-independent enough to run at edit time with no data loaded:
 *  - a sheet that SIZES A DEVICE is exempt outright. Sizing publishes the whole table at the
 *    operating point, pass-through columns included, and no static list can enumerate those. The
 *    upward half still catches a parent consuming a name the child never provides, which is
 *    where a real slip shows up.
 *  - re-export keys (which carry the separator) are left to `sheet-provide`, which rules on
 *    them from the parent's block.
 *
 * Only the CURRENT doc is inspected — validateSheet recurses into embedded children and
 * re-attributes their findings to their blocks, so walking the tree here would report
 * everything twice. A ref-only block is skipped: its provides arrive at resolution, and
 * runSheet revalidates the resolved doc.
 */
function provideCoverage(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const blocks = new Map((doc.blocks ?? []).map((u) => [u.name, u]));
  const injected = new Set((doc.blocks ?? []).flatMap(providedNames));

  const reported = new Set<string>();
  for (const expr of docExpressions(doc)) {
    for (const name of namesOf(expr)) {
      const split = splitProvide(name);
      if (!split || injected.has(name) || reported.has(name)) continue;
      // A table column read under its affixed name, which no static list can enumerate.
      if (readsAffixedColumn(doc, name)) continue;
      const [blockName] = split;
      const block = blocks.get(blockName);
      if (block && !block.doc) continue; // ref-only: its provides are unknown until resolution
      reported.add(name);
      out.push({
        rule: 'sheet-provide-coverage',
        severity: 'warning',
        message: block
          ? `an expression reads "${name}", which block "${blockName}" does not provide — a block ` +
            `exposes only the scalars its provides name, so this resolves to no value`
          : `an expression reads "${name}", but no block is named "${blockName}" — the name ` +
            `resolves to no value`,
        location: blockName,
        symbol: name,
      });
    }
  }

  // A sheet that sizes a device publishes the whole table at the operating point, which no
  // static list can enumerate — so the downward half does not run for it.
  if (doc.givens) return out;

  const own = new Set<string>([
    ...doc.params.map((p) => p.name),
    ...doc.equations.map((r) => r.name),
  ]);
  for (const key of doc.provides ?? []) {
    // A separator-bearing key is the re-export idiom, and `sheet-provide` already rules on
    // whether it names a real grandchild — from the parent's BLOCK, so a child's bad re-export is
    // reported once there rather than twice.
    if (key.includes(PROVIDE_SEP)) continue;
    if (own.has(key) || META_PUBLISHED.has(key)) continue;
    out.push({
      rule: 'sheet-provide-coverage',
      severity: 'warning',
      message:
        `provides names "${key}", which is no param and no equation of this sheet — nothing of that ` +
        `name exists to expose to a parent`,
      location: key,
    });
  }
  return out;
}

/** The names an engine-solved param's own defining relation reads: a constrained param depends on
 *  both sides of its relation, a torn one on the name it solves for. */
function solvedDeps(p: SheetVar): readonly string[] {
  if (constrained(p))
    return [...namesOf(p.designConstraint.lhs), ...namesOf(p.designConstraint.rhs)];
  return torn(p) ? [p.solveFor] : [];
}

/** One document of a composition tree as the dependency walks see it: the doc, the block path that
 *  reaches it (`''` at the top, `a.b.` below — the prefix a qualified name carries), the block in
 *  the parent that embeds it, and its own embedded children by block name. */
interface Level {
  doc: SheetDoc;
  path: string;
  parent?: { level: Level; block: SheetBlock };
  kids: Map<string, Level>;
}

/** Whether the sheet a level is embedded in balances that level's device current with a hold
 *  (see balancedBy) — what, beside the level's own holds, decides heldOnGate for a block. */
const balancedHere = (lv: Level): boolean =>
  !!lv.parent && balancesOf(lv.parent.level.doc).has(lv.parent.block.name);

/** The level `block` embeds below `lv`, with no children enrolled yet. */
const childLevel = (lv: Level, block: SheetBlock, doc: SheetDoc): Level => ({
  doc,
  path: `${lv.path}${block.name}${PATH_SEP}`,
  parent: { level: lv, block },
  kids: new Map(),
});

/** A block path (`a.b`, `''` at the top) as the prefix its level's names carry (`a.b.`). */
const levelPrefix = (level: string): string => (level === '' ? '' : `${level}${PATH_SEP}`);

/** The block path a level is at — the inverse of levelPrefix. */
const levelName = (lv: Level): string => (lv.path === '' ? '' : lv.path.slice(0, -PATH_SEP.length));

/** The level at block path `level`, if the tree has one. */
const levelAt = (levels: readonly Level[], level: string): Level | undefined =>
  levels.find((l) => l.path === levelPrefix(level));

/** Every level of the tree under `doc` in preorder: the first embedded block of each name, down to
 *  MAX_BLOCK_DEPTH. */
function levelsOf(doc: SheetDoc): Level[] {
  const levels: Level[] = [];
  const enroll = (lv: Level, depth: number): void => {
    levels.push(lv);
    if (depth >= MAX_BLOCK_DEPTH) return;
    for (const block of lv.doc.blocks ?? []) {
      if (!block.doc || lv.kids.has(block.name)) continue;
      const kid = childLevel(lv, block, block.doc);
      lv.kids.set(block.name, kid);
      enroll(kid, depth + 1);
    }
  };
  enroll({ doc, path: '', kids: new Map() }, 0);
  return levels;
}

/** The names a bare identifier can take when it reads the doc's OWN sized device: the namespace
 *  quantities, the bindable selectors, and what the sizer adds beside them. A table's unknown
 *  pass-through columns are not enumerable and are left out, so a name the walk cannot place
 *  (a typo, a column only some tables carry) resolves to nothing rather than to the device —
 *  which would read as the device depending on itself. The table's metadata scalars
 *  (META_PUBLISHED) are taken out for the same reason: before the sizing runs they are the
 *  table's, so a given reading one does not read its own device. That holds ONLY before the
 *  sizing: once a level is sized, its `w` is the sized width (SIZED_META). The provenance walk
 *  reads `w` as the table's everywhere, so it misses a dependence through an equation or solve
 *  relation of a sized level that reads `w`; the cost is a loop reported by evaluation (which
 *  refuses it) rather than here — never a wrong verdict. The residual walk resolves `w` by phase
 *  instead. */
const DEVICE_QUANTITIES: ReadonlySet<string> = new Set(
  [...DEVICE_NAMES].filter((k) => !META_PUBLISHED.has(k)),
);

/** The metadata scalars sizing writes over with the sized device's own — the per-width ones,
 *  which is the width `w` (eval.ts, runSizing). Read after a level's sizing, such a name is that
 *  level's device. */
const SIZED_META: ReadonlySet<string> = new Set(
  [...META_PUBLISHED].filter((k) => PER_WIDTH_KEYS.has(k)),
);

/**
 * One dependency link of a sheet tree: the names something reads, the level they are read in, and
 * the kind of link —
 *  - `equation`: an equation's expression;
 *  - `solved`: the relation of an engine-solved param `p` (both constraint sides, or the name a
 *    solveFor targets);
 *  - `override`: a parent's override of a child param, read in the parent's scope;
 *  - `set`: a range end's expression for the top-level param it replaces;
 *  - `provide`: a child's provided scalar, read inside the child;
 *  - `device`: the quantity `key` of a level's sized device, which reads that device's givens;
 *  - `given`: one given expression, `key` the quantity it gives.
 * `root` marks a param nothing above replaces and `meta` a table metadata scalar: neither reads
 * anything further.
 */
type Edge =
  | Reads
  | { kind: 'solved'; lv: Level; names: readonly string[]; p: SheetVar }
  | { kind: 'device'; lv: Level; key: string }
  | { kind: 'root'; p: SheetVar }
  | { kind: 'meta' };
type Reads = {
  kind: 'equation' | 'override' | 'set' | 'provide' | 'given';
  lv: Level;
  names: readonly string[];
  key?: string;
};

/** How a traversal reads the edges. One set of edges answers three questions — the policies below
 *  — and every way their answers differ is one of these fields; an absent one is off. */
interface TraversalPolicy {
  /** Follow a parent's override of a child param the engine solves. The engine discards it (the
   *  param is searched in its own range whatever the parent wires), so following it
   *  over-approximates. */
  solvedOverrides?: boolean;
  /** Follow a range end's `set` from the top-level param it replaces. */
  rangeEndSets?: boolean;
  /** Read every provide of a sizing child as its device's too — its own param or equation as well —
   *  so that anything feeding the child's sizing moves it. */
  sizingProvides?: boolean;
  /** Given quantities a range end holds fixed: a sizing child's provide of one does not move. */
  held?: ReadonlySet<string>;
  /** Follow a device quantity its givens name explicitly through that one expression. */
  givenQuantities?: boolean;
  /** Resolve a name in the phase it is evaluated in: after its level's sizing, `w` is the sized
   *  device's, not the table's. */
  phased?: boolean;
  /** Read the walk's own level (`self`'s) the way that level is solved: its params are inputs
   *  whatever a parent wires into them, so an override there is not followed, and an engine-solved
   *  param of that level is recorded and stopped at instead of followed through its relation. A
   *  solved param of any OTHER level is followed: a child solves its own inside every evaluation
   *  of its parent, so it is a function of what its relation reads. */
  ownLevel?: boolean;
}

/** What a device's sizing — or any expression — rests on: dcInputs, and exprRoots's
 *  `provenance`. Overrides are read as the engine reads them, and a value a range end
 *  substitutes is an input exactly as the centre it replaces is. */
const PROVENANCE: TraversalPolicy = { rangeEndSets: true };

/** What moves when a range end moves its params: reachedGivens, asked forward from the
 *  moved names in one document-order pass. Advisory, so it over-approximates where the engine
 *  would not; a range end holds W, L and the authored current fixed. */
const MOVEMENT: TraversalPolicy = {
  solvedOverrides: true,
  sizingProvides: true,
  held: HELD_AT_A_RANGE_END,
};

/** Which other solved params of its own level a solved param's relation depends on — the edges
 *  solvePlan orders and groups that level's solves by. A device quantity its givens name
 *  (`in__id` with `id` given as `I_tail/2`) depends on that expression alone. A range end's `set`
 *  is evaluated against a finished run, never inside one, so it is not followed. */
const RESIDUAL: TraversalPolicy = { givenQuantities: true, phased: true, ownLevel: true };

const equationEdge = (lv: Level, r: SheetEquation): Edge => ({
  kind: 'equation',
  lv,
  names: namesOf(r.expr),
});
const solvedEdge = (lv: Level, p: SheetVar): Edge => ({
  kind: 'solved',
  lv,
  names: solvedDeps(p),
  p,
});

/** The parent's override of `name` at `lv`, read in the parent's scope — absent when it overrides
 *  a param the engine solves and the policy reads overrides as the engine does. Any override
 *  replaces the child's value whatever its shape; a literal (or malformed) one simply names
 *  nothing. Own keys only, so a param named `constructor` is not read as overridden by every
 *  override object. */
function overrideEdge(lv: Level, name: string, policy: TraversalPolicy): Edge | undefined {
  const given = lv.parent?.block.params;
  if (!lv.parent || !given || !Object.prototype.hasOwnProperty.call(given, name)) return undefined;
  const src: unknown = given[name];
  const p = lv.doc.params.find((q) => q.name === name);
  if (src === undefined || (p && engineSolved(p) && !policy.solvedOverrides)) return undefined;
  const names = typeof src === 'string' ? namesOf(src) : [];
  return { kind: 'override', lv: lv.parent.level, names };
}

/** What the scalar `key` a child provides reads, inside the child. A sizing child publishes
 *  everything its sizing put in scope, pass-through columns included, so a provided key that is
 *  none of its params, equations or re-exports is its device's own — whether or not the name is one
 *  DEVICE_QUANTITIES can list. Under `sizingProvides`, any provide of a sizing child reads its
 *  device too, unless the key is `held`. */
function provideEdges(kid: Level, key: string, policy: TraversalPolicy): Edge[] {
  const inside: Edge = { kind: 'provide', lv: kid, names: [key] };
  const device: Edge = { kind: 'device', lv: kid, key };
  if (!kid.doc.givens) return [inside];
  if (policy.sizingProvides) {
    // A quantity a range end holds does not move — with one exception. A device whose held givens
    // carry no current has its current READ from the table, so that current moves with whatever
    // moves its operating point, and everything derived from it too: one given its width and no
    // current (tied to another's gate), and one held on its gate voltage because a hold balances
    // its current (heldOnGate), whatever current it was sized at.
    const givens = kid.doc.givens;
    const readCurrent =
      key === 'id' &&
      (givens.W !== undefined ? givens.id === undefined : heldOnGate(kid.doc, balancedHere(kid)));
    return policy.held?.has(key) && !readCurrent ? [inside] : [inside, device];
  }
  const own =
    key.includes(PROVIDE_SEP) ||
    kid.doc.params.some((q) => q.name === key) ||
    kid.doc.equations.some((r) => r.name === key);
  return own ? [inside] : [device];
}

/** A device's own links: each given expression, keyed by the quantity it gives. */
const givensEdges = (lv: Level): Reads[] =>
  Object.entries(lv.doc.givens ?? {}).flatMap(([k, v]): Reads[] =>
    givenIsExpression(k) && typeof v === 'string'
      ? [{ kind: 'given', lv, names: namesOf(v), key: k }]
      : [],
  );

/**
 * The names `name` reads at `lv`, each with its kind of edge — the one definition of a sheet's
 * dependency links, which every traversal policy reads. A name means the first of: a param, an
 * equation, a scalar a child provides, a quantity of the level's own sized device, a table metadata
 * scalar; anything else resolves to nothing (`[]`). A param continues into its parent's override
 * when it has one; otherwise it is a root, which carries on through its relation when the engine
 * solves it and — at the top, under `rangeEndSets` — through each range end's substitute for it. A
 * solved param keeps its relation whatever the parent writes, so an override the policy follows
 * is read beside it rather than instead. `sized` marks a SIZED_META name read after `lv`'s sizing,
 * which is then the device's.
 */
function edgesOf(lv: Level, name: string, sized: boolean, policy: TraversalPolicy): Edge[] {
  const p = lv.doc.params.find((q) => q.name === name);
  if (p) {
    const override = overrideEdge(lv, name, policy);
    if (override && !engineSolved(p)) return [override];
    const out: Edge[] = override ? [override, { kind: 'root', p }] : [{ kind: 'root', p }];
    if (engineSolved(p)) out.push(solvedEdge(lv, p));
    // Range ends are a top-of-tree feature; a composed child's are never run.
    if (policy.rangeEndSets && lv.path === '')
      for (const e of lv.doc.operatingRange ?? []) {
        const sub: unknown = e.set?.[name];
        if (typeof sub === 'string') out.push({ kind: 'set', lv, names: namesOf(sub) });
      }
    return out;
  }
  const equation = lv.doc.equations.find((r) => r.name === name);
  if (equation) return [equationEdge(lv, equation)];
  const split = splitProvide(name);
  const kid = split && lv.kids.get(split[0]);
  if (split && kid && (kid.doc.provides ?? []).includes(split[1]))
    return provideEdges(kid, split[1], policy);
  if (lv.doc.givens && (DEVICE_QUANTITIES.has(name) || sized))
    return [{ kind: 'device', lv, key: name }];
  return META_PUBLISHED.has(name) ? [{ kind: 'meta' }] : [];
}

/** The roots a walk reaches, by qualified name: the param, and the devices whose givens the paths
 *  to it most recently left. */
type Roots = Map<string, { p: SheetVar; devices: Set<string> }>;

/**
 * Walk the edges back under one policy from wherever the caller starts it — a device, or the names
 * of an expression — recording each root reached in `roots` and everything else in `found`: names
 * qualified by block path, devices named as warnings name them, and in `loop` the first open path
 * back to `origin`, as the names on it.
 *
 * A path is CLOSED once it has crossed a solved relation or a range end's `set`: past a solve, the
 * solve is what closes a loop, and a `set` is evaluated against the finished run, not inside it.
 * Each name and device is entered once per mode, open or closed, so a loop on an open path is never
 * hidden behind the same node reached closed first. Reaching a node already on the path is a
 * cycle, recorded with whether a solved relation or `set` lies on it, and not followed; reaching
 * `origin` again is a loop, kept only when the path is open. `self`, the solved param's own
 * unknown, sets `selfRead` wherever it is reached in its own level — before any override of it is
 * looked at — and is followed no further.
 */
function walkBack(
  policy: TraversalPolicy,
  roots: Roots,
  origin?: Level,
  self?: { lv: Level; name: string },
) {
  const found = {
    unresolved: new Set<string>(),
    device: new Set<string>(),
    equation: new Set<string>(),
    solved: new Set<string>(),
    constraints: new Set<string>(),
    cycles: [] as { via: string[]; closed: boolean }[],
    selfRead: false,
    loop: undefined as string[] | undefined,
  };
  const seen = new Set<string>();
  // One frame per name or device on the current path, plus a `crossed` marker while a solved
  // relation or a range end's `set` is being followed.
  const path: { key: string; name?: string; crossed?: boolean }[] = [];
  const names = (frames: readonly { name?: string }[]): string[] =>
    frames.flatMap((f) => (f.name ? [f.name] : []));

  const enter = (node: string, closed: boolean, name?: string): boolean => {
    const key = `${closed ? 1 : 0}|${node}`;
    const at = path.findIndex((f) => f.key === key);
    if (at >= 0) {
      const via = names([...path.slice(at), { name }]);
      found.cycles.push({ via, closed: path.slice(at).some((f) => f.crossed) });
      return false;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    path.push({ key, name });
    return true;
  };

  // `post` is whether `name` is read after its level's sizing: a given, and a parent's override of
  // a child, are evaluated before the sizing they belong to; an equation, a relation, a range end's
  // `set` and a child's provided value after it. Under `phased`, a SIZED_META name read after the
  // sizing means the device, so it is a different node from the same name read before. `sizer` is
  // the device whose givens the path most recently left — the one a root is reported against.
  const visit = (lv: Level, name: string, closed: boolean, post: boolean, sizer: string): void => {
    if (self && lv === self.lv && name === self.name) {
      found.selfRead = true;
      return;
    }
    const qualified = `${lv.path}${name}`;
    const sized = !!policy.phased && post && SIZED_META.has(name);
    if (!enter(`${sized ? 's' : 'n'}${qualified}`, closed, qualified)) return;
    const own = !!policy.ownLevel && lv === self?.lv;
    let edges = edgesOf(lv, name, sized, policy);
    // The own level's params are inputs to its solve: what a parent wires into one is a number by
    // the time the level is solved, so the param is a root there.
    if (own && edges.some((e) => e.kind === 'override')) {
      const p = lv.doc.params.find((q) => q.name === name) as SheetVar;
      edges = edges.filter((e) => e.kind !== 'override');
      if (!edges.some((e) => e.kind === 'root')) edges.unshift({ kind: 'root', p });
    }
    if (edges.length === 0) found.unresolved.add(qualified);
    for (const e of edges) {
      if (e.kind === 'meta') continue;
      if (e.kind === 'root') {
        const entry = roots.get(qualified) ?? { p: e.p, devices: new Set<string>() };
        entry.devices.add(sizer);
        roots.set(qualified, entry);
      } else if (e.kind === 'device') {
        device(e.lv, policy.givenQuantities ? e.key : undefined, closed);
      } else if (e.kind === 'solved' && own) {
        found.constraints.add(qualified);
      } else {
        const cross = e.kind === 'solved' || e.kind === 'set';
        if (e.kind === 'equation') found.equation.add(qualified);
        if (cross) path.push({ key: '', crossed: true });
        if (e.kind === 'solved') found.solved.add(qualified);
        for (const n of e.names) visit(e.lv, n, closed || cross, e.kind !== 'override', sizer);
        if (cross) path.pop();
      }
    }
    path.pop();
  };

  // `key`, when the givens name that quantity, narrows the device to the one expression giving it.
  const device = (lv: Level, key: string | undefined, closed: boolean): void => {
    if (lv === origin && path.length > 0) {
      if (!closed) found.loop ??= names(path);
      return;
    }
    const all = givensEdges(lv);
    const one = all.filter((e) => e.key === key);
    if (!enter(one.length ? `d${lv.path}#${key}` : `d${lv.path}`, closed)) return;
    const at = blockPath(lv.path);
    found.device.add(at);
    for (const e of one.length ? one : all)
      for (const n of e.names) visit(lv, n, closed, false, at);
    path.pop();
  };

  return { visit, device, found };
}

/** The class a root is reported under: `solved` when the engine solves it, `held` when it carries
 *  a `hold` (stated at the nominal run, re-solved where the hardware is held), else its authored
 *  class, else `unclassified`. */
export type RootClass = ParamClass | 'solved' | 'held' | 'unclassified';

const classOf = (p: SheetVar): RootClass =>
  engineSolved(p)
    ? 'solved'
    : holds(p)
      ? 'held'
      : PARAM_CLASSES.has(p.class ?? '')
        ? (p.class as ParamClass)
        : 'unclassified';

/** `roots` in document order: the tree in preorder, each doc's params as written. */
const inDocumentOrder = (levels: readonly Level[], roots: Roots) =>
  levels.flatMap((lv) =>
    lv.doc.params.flatMap((p) => {
      const name = `${lv.path}${p.name}`;
      const r = roots.get(name);
      return r ? [[name, r] as const] : [];
    }),
  );

/**
 * A sheet's DC inputs: the root params its device biases and givens are built from, by class —
 * the two authored ones, plus `solved`, which is derived from the param's own design constraint or
 * solveFor. Names are qualified by block path below the top sheet (`stage1.V_out`) and listed in
 * document order. `unclassified` holds only the voltage roots (unit exactly `V`) that carry no
 * class — the ones the `sheet-dc-inputs` rule refuses — each with the devices whose sizing reads it
 * directly. `cycles` holds each device whose own sizing depends on its own operating point with no
 * engine-solved param on the loop.
 */
export interface DcInputs {
  independent: string[];
  assumed: string[];
  solved: string[];
  held: string[];
  unclassified: { param: string; devices: string[] }[];
  cycles: { device: string; via: string[] }[];
}

/**
 * The DC-input walk — the reachability the `sheet-dc-inputs` rule, SheetResult.assumptions and
 * any later consumer of "which voltages does this design's sizing rest on" all read. It is the
 * PROVENANCE walk run back from every device's givens — the bias axes and the rest alike, so a
 * `vgs` tie is followed too — across the whole tree (edgesOf says what each name reads):
 *  - a child param the parent overrides continues into the override's names, in the parent's
 *    scope — unless the engine solves it: the param is searched in its own range and the
 *    override is ignored, so it stays a root;
 *  - a `child__key` is an alias into that child, never a root: it continues into the child's
 *    equation, its param, or — for a quantity its sizing publishes — its own givens;
 *  - an equation continues into its expression;
 *  - an engine-solved param is a root classed solved, and the walk carries on through the
 *    relation that solves it, so the spec on the far side of a design constraint is a DC input too;
 *  - a top-level param a range end overrides continues into that range end's `set`
 *    expression, so a range end (`CM_lo`) is a DC input exactly as the centre it replaces is.
 * What is left are the ROOTS: params nobody overrides.
 *
 * A walk that comes back to the device it started from is a loop in the design's own bias. It is
 * legal only when an engine-solved param sits on it — the solve is what closes the loop — so only
 * the loops on an open path are reported. A range end's `set` is evaluated against the finished
 * base run, not inside it, so it cannot close a loop in that run and is walked as closed too.
 *
 * Structural and table-free: a bare name that is no param, equation or published child scalar is
 * read as the doc's own device quantity when the doc sizes a device and the name is one a sized
 * device carries (DEVICE_QUANTITIES). Pure: it reads the doc and returns a report.
 */
export function dcInputs(doc: SheetDoc): DcInputs {
  const levels = levelsOf(doc);
  const roots: Roots = new Map();
  const cycles: DcInputs['cycles'] = [];
  for (const start of levels) {
    if (!start.doc.givens) continue;
    const { device, found } = walkBack(PROVENANCE, roots, start);
    device(start, undefined, false);
    if (found.loop) cycles.push({ device: blockPath(start.path), via: found.loop });
  }

  const out: DcInputs = {
    independent: [],
    assumed: [],
    solved: [],
    held: [],
    unclassified: [],
    cycles,
  };
  for (const [name, r] of inDocumentOrder(levels, roots)) {
    const cls = classOf(r.p);
    if (cls !== 'unclassified') out[cls].push(name);
    // An invalid authored class is reported on the param itself, so it is not double-counted.
    else if (r.p.class === undefined && r.p.unit?.trim() === 'V')
      out.unclassified.push({ param: name, devices: [...r.devices] });
  }
  return out;
}

/** The two readings exprRoots offers: the DC-input walk's, or the relation of the named solved
 *  param of the level the expression is read at. */
export type RootsPolicy = 'provenance' | { residual: string };

/** What an expression rests on (see exprRoots). Every name is qualified by block path; devices are
 *  named as warnings name them. */
export interface ExprRoots {
  roots: Record<RootClass, string[]>;
  unresolved: string[];
  crossings: { device: string[]; equation: string[]; solved: string[] };
  cycles: { via: string[]; closed: boolean }[];
  constraints: string[];
  selfRead: boolean;
}

/**
 * The roots an expression read at `level` (a block path, `''` for the top) transitively rests on,
 * by class, under one policy: `provenance`, or `{ residual: X }` for the relation that solves that
 * level's param X. The expression is read where a relation is evaluated: after the level's
 * sizing. Also reported: the names that resolve to nothing, the devices, equations (`equation`) and
 * solved relations crossed on the way, and each cycle reached, with whether a solved relation lies
 * on it. Under `residual` the level is read as it is solved — its params are inputs, whatever a
 * parent wires into them — and `constraints` holds the OTHER solved params of that level reached
 * (constrained, or carrying solveFor): the relation's ordering edges, never X. A solved param of a
 * child is crossed rather than stopped at, because the child solves it inside every evaluation of
 * the level. `selfRead` says whether X itself was reached in its own level. A name that resolves to
 * nothing may be one only the live value set can place, such as a table's pass-through column, so
 * it fails closed: `constraints` then holds every other solved param of the level. Structural and
 * table-free, like dcInputs.
 */
export function exprRoots(
  doc: SheetDoc,
  level: string,
  expr: string,
  policy: RootsPolicy,
): ExprRoots {
  const levels = levelsOf(doc);
  const path = levelPrefix(level);
  const lv = levelAt(levels, level);
  const roots: Roots = new Map();
  const self = typeof policy === 'object' && lv ? { lv, name: policy.residual } : undefined;
  const { visit, found } = walkBack(
    policy === 'provenance' ? PROVENANCE : RESIDUAL,
    roots,
    undefined,
    self,
  );
  for (const n of namesOf(expr)) {
    if (lv) visit(lv, n, false, true, '');
    else found.unresolved.add(`${path}${n}`);
  }

  const { unresolved, device, equation, solved, constraints, cycles, selfRead } = found;
  const every = (lv?.doc.params ?? []).filter(engineSolved).map((p) => `${path}${p.name}`);
  const own = typeof policy === 'object' ? `${path}${policy.residual}` : undefined;
  const out: ExprRoots = {
    roots: { independent: [], assumed: [], solved: [], held: [], unclassified: [] },
    unresolved: [...unresolved],
    crossings: { device: [...device], equation: [...equation], solved: [...solved] },
    cycles,
    constraints:
      own !== undefined && unresolved.size ? every.filter((q) => q !== own) : [...constraints],
    selfRead,
  };
  for (const [name, r] of inDocumentOrder(levels, roots)) out.roots[classOf(r.p)].push(name);
  return out;
}

/** What one expression rests on, for deciding where it may be written (see exprProvenance). Every
 *  name is qualified by block path; devices are named as warnings name them. */
export interface ExprProvenance {
  /** The root params reached, by class — `unclassified` holds every root that carries no class,
   *  whatever its unit, never dropped. */
  roots: Record<RootClass, string[]>;
  /** Names that resolve to nothing on the sheet (distinct from constants, which are not names). */
  unresolved: string[];
  /** What the paths crossed: a sized device's published quantity, an equation, the relation of a
   *  solved param, an analysis. */
  crossings: { device: string[]; equation: string[]; solved: string[]; analysis: string[] };
  /** Every dependency cycle reached, as the names on it. The walk terminates on every input; a
   *  cycle is a result, not a silent cut. */
  cycles: { via: string[]; closed: boolean }[];
}

/**
 * The provenance of ONE expression read at `level` (a block path, `''` for the top): the root
 * params it rests on by class, the names it cannot resolve, and the crossings on any path to them
 * — answered by the same dependency edges the DC-input walk reads (params, a parent's overrides, a
 * child's provides, equations, solved relations), but for an expression no device need read, and
 * without dropping the fact that a path crossed a device. Two documents whose bias override is
 * `VDD` and `producer__vgs` have the same roots under dcInputs and different provenance here: the
 * second crosses a device. Structural and table-free.
 */
export function exprProvenance(doc: SheetDoc, level: string, expr: string): ExprProvenance {
  const r = exprRoots(doc, level, expr, 'provenance');
  // A name an analysis carries resolves to nothing for the dependency edges, which know no
  // analyses; it is a crossing, not an unknown name.
  const analyses = new Set(
    levelsOf(doc).flatMap((lv) =>
      (Array.isArray(lv.doc.analyses) ? lv.doc.analyses : []).flatMap((a) =>
        typeof a?.name === 'string' ? [`${lv.path}${a.name}`] : [],
      ),
    ),
  );
  return {
    roots: r.roots,
    unresolved: r.unresolved.filter((n) => !analyses.has(n)),
    crossings: { ...r.crossings, analysis: r.unresolved.filter((n) => analyses.has(n)) },
    cycles: r.cycles,
  };
}

/** The reasons an expression's provenance keeps it out of a place that admits only the root
 *  classes in `admit`, and the crossings not in `cross`. */
function provenanceProblems(
  p: ExprProvenance,
  admit: readonly RootClass[],
  cross: readonly (keyof ExprProvenance['crossings'])[],
): string[] {
  const out: string[] = [];
  const why: Record<RootClass, string> = {
    independent: 'is classed independent',
    assumed: 'is classed assumed — a typed guess held fixed becomes a fact',
    solved: 'is solved by the engine, so what it sets is derived',
    held:
      'is the node under a gate that a hold re-solves where the design is held — that wire is ' +
      'derived; hold the gate wire at the hold expression instead',
    unclassified: 'carries no class — say whether it is independent',
  };
  for (const cls of Object.keys(p.roots) as RootClass[])
    if (!admit.includes(cls))
      for (const n of p.roots[cls]) out.push(`it reads "${n}", which ${why[cls]}`);
  for (const n of p.unresolved) out.push(`it reads "${n}", which names nothing on the sheet`);
  for (const c of p.cycles) out.push(`its dependencies loop (${c.via.join(' → ')})`);
  if (!cross.includes('device'))
    for (const d of p.crossings.device)
      out.push(
        `it reads a quantity of ${deviceName(d)}, and a level derived from a device is never held`,
      );
  if (!cross.includes('equation'))
    for (const e of p.crossings.equation) out.push(`it reads equation "${e}"`);
  if (!cross.includes('solved'))
    for (const q of p.crossings.solved)
      if (!p.roots.solved.includes(q)) out.push(`it reads through the relation that solves "${q}"`);
  if (!cross.includes('analysis'))
    for (const a of p.crossings.analysis) out.push(`it reads analysis "${a}"`);
  return out;
}

/** An expression with its whitespace removed — how a held level is compared with a hold. */
export const spelled = (e: string): string => e.replace(/\s+/g, '');

/**
 * Whether `expr` may hold a wire in the `levels` of the sheet at `level` — the HOLD filter. A held
 * level is one the designer states: its roots are independent params only (an unclassified root
 * is refused by name), it names nothing unresolved, it reaches no cycle, and its paths cross
 * nothing — no device, equation, solved relation or analysis. So a solved node (`V_tail`), an
 * assumed param, a param a parent overrides from a device's quantity, and an equation are each
 * refused by name, and a wire whose level a device sets is never held. `class: "assumed"` alone
 * never creates a hold.
 *
 * One exception, which is exactly what `hold` does today: the gate of a device whose source node
 * carries a `hold` is held, where the design is held, at the value its hold expression took at the
 * design point. So the gate's wire may be held at that expression (`"vbn": "V_a + casc_n__vgs"`),
 * written as the hold itself — a level derived at the design point and held fixed elsewhere, which
 * the report names as such — and only that wire: the verdict names the device whose gate-source
 * voltage the hold reads, and validation admits the level only on that device's gate wire. The node
 * under the gate stays derived. A hold that balances currents holds no wire and admits nothing.
 */
export function levelEligibility(
  doc: SheetDoc,
  level: string,
  expr: string,
):
  | { kind: 'held' }
  | { kind: 'held-gate'; hold: string; device: string }
  | { kind: 'refused'; problems: string[] } {
  const lv = levelAt(levelsOf(doc), level);
  // The device whose gate-source voltage the hold reads: a block's (`casc__vgs`), or the sheet's
  // own (`vgs`).
  for (const p of lv?.doc.params ?? []) {
    if (!holds(p) || spelled(p.hold) !== spelled(expr)) continue;
    const device = heldGateOf((lv as Level).doc, p);
    if (device) return { kind: 'held-gate', hold: p.name, device };
  }
  const problems = provenanceProblems(exprProvenance(doc, level, expr), ['independent'], []);
  return problems.length ? { kind: 'refused', problems } : { kind: 'held' };
}

/**
 * Whether `expr` may configure an analysis or an element at `level` — its frequency, a component
 * value. Its roots are independent or assumed params (unclassified refused by name), it names
 * nothing unresolved, reaches no cycle, and crosses no device, solved relation or analysis
 * anywhere in its transitive reach; equations are allowed, taken once over the whole reach. So
 * neither a configuration nor an element value can read an analysis, directly or through an
 * equation. Returns the reasons it may not; none when it may.
 */
export function configEligibility(doc: SheetDoc, level: string, expr: string): string[] {
  return provenanceProblems(
    exprProvenance(doc, level, expr),
    ['independent', 'assumed'],
    ['equation'],
  );
}

/** The netlist questions validation asks of a whole tree at its top: whether each held level may
 *  be held, and whether each element value and analysis frequency reads only configuration. A
 *  child's are asked here rather than in the child, because a parent's overrides decide what the
 *  child's expressions rest on. Each problem is attributed to the block path it belongs to. */
function treeNodesProblems(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  for (const lv of levelsOf(doc)) {
    if (formatOf(lv.doc) !== 2) continue;
    const level = levelName(lv);
    const found: QAWarning[] = [];
    const levels: unknown = lv.doc.levels;
    if (isObject(levels))
      for (const [w, e] of Object.entries(levels)) {
        if (typeof e !== 'string') continue;
        const verdict = levelEligibility(doc, level, e);
        if (verdict.kind === 'refused')
          found.push({
            rule: 'sheet-nodes',
            severity: 'error',
            message:
              `levels "${w}": "${e}" cannot hold the wire — ${verdict.problems.join('; ')}. A held ` +
              `level is stated by the designer: a number, or params classed independent`,
            location: 'levels',
          });
        else if (verdict.kind === 'held-gate') {
          // The hold keeps one device's gates: only that device's gate wires may be held at it —
          // each placement's, for a device placed several times (the placement rule shows them at
          // one operating point, so one gate voltage holds them all) — as this sheet names them,
          // through the port map of a child that wires itself.
          const who = deviceName(verdict.device);
          const gates = deviceGateWires(lv.doc, verdict.device) ?? [];
          if (!gates.includes(w))
            found.push({
              rule: 'sheet-nodes',
              severity: 'error',
              message:
                `levels "${w}": "${e}" is the gate voltage the hold on ${verdict.hold} keeps fixed ` +
                `for ${who}, so it may hold only that device's gate ` +
                (gates.length > 1 ? 'wires' : 'wire') +
                ' — ' +
                (gates.length
                  ? `${who} has its gate${gates.length > 1 ? 's' : ''} on ${quoted(gates)}`
                  : `${who} names no wires`),
              location: 'levels',
            });
        }
      }
    const config = (expr: unknown, where: string): void => {
      if (typeof expr !== 'string') return;
      const problems = configEligibility(doc, level, expr);
      if (problems.length)
        found.push({
          rule: 'sheet-nodes',
          severity: 'error',
          message:
            `${where}: "${expr}" cannot configure it — ${problems.join('; ')}. A configuration reads ` +
            `params classed independent or assumed, and equations of them`,
          location: where.startsWith('element') ? 'elements' : 'analyses',
        });
    };
    for (const e of Array.isArray(lv.doc.elements) ? lv.doc.elements : [])
      config(e?.value, `element "${String(e?.name)}" value`);
    for (const a of Array.isArray(lv.doc.analyses) ? lv.doc.analyses : [])
      config(a?.at, `analysis "${String(a?.name)}" at`);
    const segments = level === '' ? [] : level.split(PATH_SEP);
    for (const w of found) out.push(prefixBlockPath(segments, w));
  }
  return out;
}

/** The relation that solves `p`, as one expression that reads zero at the answer: `lhs - rhs` for
 *  a design constraint, the param less the value it names for a solveFor. */
export function solvedRelation(p: SheetVar): { lhs: string; rhs: string } | undefined {
  if (constrained(p)) return { lhs: p.designConstraint.lhs, rhs: p.designConstraint.rhs };
  return torn(p) ? { lhs: p.name, rhs: p.solveFor } : undefined;
}

/**
 * How one level of a tree solves its own solved params (the top level of `doc`): grouped into the
 * sets that depend on each other, in an order where every set comes after the ones its relations
 * read. Each set is a list of param names in document order; a set of one is solved by one search,
 * a set of several by repeated sweeps (see solveNode in eval.ts).
 *
 * The edges are the RESIDUAL reading of each relation (exprRoots): which other solved params of
 * this level it reaches. Children are not part of it — a child solves its own params inside every
 * evaluation of this level, so they are functions of this level's values, never unknowns beside
 * them. The sets are the strongly connected components of those edges; with no edge between two
 * sets, document order decides, so the plan is a function of the document alone.
 */
export function solvePlan(doc: SheetDoc): string[][] {
  const solved = doc.params.filter(engineSolved);
  const names = solved.map((p) => p.name);
  const reads = new Map<string, string[]>();
  for (const p of solved) {
    const rel = solvedRelation(p) as { lhs: string; rhs: string };
    const { constraints } = exprRoots(doc, '', `(${rel.lhs}) - (${rel.rhs})`, {
      residual: p.name,
    });
    const deps = new Set(constraints);
    // Document order, so the walk below visits neighbours deterministically.
    reads.set(
      p.name,
      names.filter((n) => deps.has(n)),
    );
  }
  // Tarjan's algorithm. A component is emitted once everything it reads has been, which is the
  // order to solve in.
  const out: string[][] = [];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const connect = (v: string): void => {
    index.set(v, index.size);
    low.set(v, index.get(v) as number);
    stack.push(v);
    onStack.add(v);
    for (const w of reads.get(v) ?? []) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
    }
    if (low.get(v) === index.get(v)) {
      const set = new Set<string>();
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        set.add(w);
      } while (w !== v);
      out.push(names.filter((n) => set.has(n)));
    }
  };
  for (const n of names) if (!index.has(n)) connect(n);
  return out;
}

/**
 * The `sheet-dc-inputs` rule over a whole tree: every voltage the design's sizing rests on must
 * say whether the designer states it or the sheet assumes it, and no device may depend on its own
 * operating point without a solve closing the loop. Run once, at the top — the walk spans the
 * tree, so running it per level would report a child's overridden param as a root.
 */
function dcInputProblems(doc: SheetDoc): QAWarning[] {
  const { unclassified, cycles } = dcInputs(doc);
  return [
    ...unclassified.map(({ param, devices }): QAWarning => ({
      rule: 'sheet-dc-inputs',
      severity: 'error',
      message:
        `voltage "${param}" feeds the sizing of ${devices.map(deviceName).join(', ')} but ` +
        `carries no class — mark it "independent" (nothing on this sheet determines it, so the ` +
        `designer states it: a supply, a reference, an input common mode, an applied bias, a ` +
        `probe, an output held by a feedback loop outside the sheet, a voltage across a device ` +
        `whose surroundings are not on the sheet) or "assumed" (this ` +
        `sheet's own parts determine it, but it types a value for now instead of deriving it)`,
      location: param,
      symbol: param,
    })),
    ...cycles.map(({ device, via }): QAWarning => ({
      rule: 'sheet-dc-inputs',
      severity: 'error',
      message:
        `the sizing of ${deviceName(device)} depends on its own operating point ` +
        `(${via.join(' → ')}) and nothing solves the loop — name the estimate as a param and ` +
        `close it with solveFor`,
      location: device,
    })),
  ];
}

/** A list of givens keys as a warning spells them. */
const quoted = (ks: string[]): string => ks.map((k) => `"${k}"`).join(', ');

/** A `sheet-collision` warning for each param, then each equation, of `doc` whose name is in
 *  `names` — something else writes that name into the sheet's scope — in the words `param` and
 *  `equation` give. `exempt` spares a param. */
function collisions(
  doc: SheetDoc,
  names: ReadonlySet<string>,
  param: (name: string) => string,
  equation: (name: string) => string,
  exempt: (p: SheetVar) => boolean = () => false,
): QAWarning[] {
  const warning = (name: string, message: string): QAWarning => ({
    rule: 'sheet-collision',
    severity: 'warning',
    message,
    location: name,
  });
  return [
    ...doc.params
      .filter((p) => names.has(p.name) && !exempt(p))
      .map((p) => warning(p.name, param(p.name))),
    ...doc.equations.filter((r) => names.has(r.name)).map((r) => warning(r.name, equation(r.name))),
  ];
}

/** One device's givens in a tree, with the names a range end's overrides can reach at the point
 *  they are evaluated. `path` spells the block the way warnings spell it: `givens` for the sheet's
 *  own device, the block path for anything below. */
export interface ReachedGivens {
  path: string;
  givens: NonNullable<SheetDoc['givens']>;
  reached: ReadonlySet<string>;
}

/**
 * Every device's givens in the tree paired with the names one range end MOVES at them — the params
 * the range end sets, plus everything the sheet derives from them: equations reading one,
 * engine-solved params whose defining relation reads one (a constrained node voltage is the case
 * that matters — every range end in the library moves one), child params a block overrides from a
 * moved expression, and the provides of a child whose own value moved. The MOVEMENT policy, asked
 * forward over the same edges the backward walks read: closed to a fixed point within each
 * document and, by repeating the pass over the blocks until nothing more is reached, across the
 * tree.
 *
 * A reachability question, not an evaluation: it says which authored expressions could read
 * something different at the range end, which is all the range-end checks below need. It
 * UNDER-approximates in one known place, on documents that are already errors here: a
 * composition nested past MAX_BLOCK_DEPTH is skipped whole. An advisory check that says nothing
 * about a broken document is the right way round — a warning that fires on correct sheets is
 * worth less than no warning at all.
 *
 * Exported for the test that holds it and dcInputs to the same reach; not part of the public
 * API (the package index does not re-export it).
 */
export function reachedGivens(doc: SheetDoc, moved: readonly string[]): ReachedGivens[] {
  const out: ReachedGivens[] = [];
  movedBy({ doc, path: '', kids: new Map() }, moved, out, 0);
  return out;
}

function movedBy(
  lv: Level,
  moved: readonly string[],
  out: ReachedGivens[],
  depth: number,
): ReadonlySet<string> {
  const reached = new Set(moved);
  const reads = (e: Edge | undefined, from: ReadonlySet<string>): boolean =>
    e !== undefined && 'names' in e && e.names.some((n) => from.has(n));
  const sources: readonly (readonly [string, Edge])[] = [
    ...lv.doc.equations.map((r) => [r.name, equationEdge(lv, r)] as const),
    ...lv.doc.params.filter(engineSolved).map((p) => [p.name, solvedEdge(lv, p)] as const),
    // A held node is re-solved at a range end from the expression it holds, so it moves with
    // whatever that expression reads.
    ...lv.doc.params
      .filter(holds)
      .map((p) => [p.name, { kind: 'equation', lv, names: namesOf(p.hold) } as Edge] as const),
  ];
  const close = (): void => {
    for (let grew = true; grew;) {
      grew = false;
      for (const [name, e] of sources) {
        if (!reached.has(name) && reads(e, reached)) {
          reached.add(name);
          grew = true;
        }
      }
    }
  };
  close();
  // The blocks, repeated until nothing more is reached. One pass in document order is enough
  // while every link runs forward — a block's override may only read EARLIER siblings' provides.
  // A solved or held param of this sheet is the link that runs backward: its relation can read a
  // LATER block's provide (a tail node solved from the pair's gate voltage) and feed an EARLIER
  // block (the tail device's drain). Each pass re-collects the blocks' own entries, and the last
  // pass's are the ones kept.
  let below: ReachedGivens[] = [];
  for (let grew = true; grew;) {
    const before = reached.size;
    below = [];
    for (const block of lv.doc.blocks ?? []) {
      if (!block.doc || depth >= MAX_BLOCK_DEPTH) continue;
      const kid = childLevel(lv, block, block.doc);
      const seed = Object.keys(block.params ?? {}).filter((k) =>
        reads(overrideEdge(kid, k, MOVEMENT), reached),
      );
      const inner = movedBy(kid, seed, below, depth + 1);
      // A block publishes two kinds of scalar, and the range end moves them for different
      // reasons. Its equations and params move when the closure above says they do. Its DEVICE
      // quantities — the vgs it settled at, the gm that came out — move whenever anything feeding
      // its sizing moved, whatever the inputs happened to be called; a sibling biased off one of
      // those (`VDD - ref__vgs`) is how the library writes a stack, so stopping at the block
      // boundary would make the checks below silent on the sheets they exist for. The geometry
      // and an authored current are the exceptions (MOVEMENT's `held`): a range end holds W and L
      // fixed by construction, and an authored `id` moves only when its own expression does,
      // which the closure already covers. A current nobody authored is not an exception (see
      // provideEdges).
      const sizingMoved = givensEdges(kid).some((e) => reads(e, inner));
      for (const key of block.doc.provides ?? [])
        if (
          provideEdges(kid, key, MOVEMENT).some((e) =>
            e.kind === 'device' ? sizingMoved : reads(e, inner),
          )
        )
          reached.add(joinProvide(block.name, key));
      close();
    }
    grew = reached.size > before;
  }
  out.push(...below);
  // Pushed last, because a block's own givens evaluate after the children it composes.
  if (lv.doc.givens) out.push({ path: blockPath(lv.path), givens: lv.doc.givens, reached });
  return reached;
}

/**
 * What an author should know about how a range end reads the design it re-measures. A range-end
 * run holds the hardware the base run sized and re-settles the bias. Two WARNINGS mark the places
 * where an authored sheet takes that outside where it holds — what the author wrote is legal, and
 * which of the reading and the writing is wrong is theirs to decide. Two NOTES (severity `info`)
 * say where a device's CURRENT is different at the range end. That is the circuit behaving as
 * drawn — a mirrored current follows its drain, and whatever is derived from it follows that —
 * so it is nothing to fix, and still something the author of a claim about the range should see.
 */
function complianceReach(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  // The devices a range end holds on their gate voltage (heldOnGate), by the path reachedGivens
  // reports them under.
  const onGate = new Set(
    levelsOf(doc)
      .filter((lv) => heldOnGate(lv.doc, balancedHere(lv)))
      .map((lv) => blockPath(lv.path)),
  );
  for (const e of doc.operatingRange ?? []) {
    const name = e.name?.trim();
    if (!name) continue; // shape errors are named above; this check needs a usable name
    for (const { path, givens, reached } of reachedGivens(doc, Object.keys(e.set ?? {}))) {
      const readsMoved = (expr: unknown): boolean =>
        typeof expr === 'string' && namesOf(expr).some((n) => reached.has(n));
      const keyMoved = (k: string): boolean =>
        givenIsExpression(k) && readsMoved(givens[k as never]);
      const where = path === 'givens' ? "this sheet's own givens" : `the givens at "${path}"`;
      /** The note for a device whose current the range end reads from the table rather than
       *  holds, and moves the operating point of through `point`. */
      const readCurrentMoves = (point: string[]): QAWarning => ({
        rule: 'sheet-range',
        severity: 'info',
        message:
          `range end "${name}" moves the ${quoted(point)} of ${where}, whose current is read ` +
          `from the table rather than given — that current is different there, and so is any ` +
          `current derived from it`,
        location: name,
      });
      if (givens.W !== undefined) {
        // Width-first givens are left exactly as authored at a range end, which makes two
        // different things possible, and an author sent to the wrong one of them looks in the
        // wrong place. If the GEOMETRY moves, the range end is not holding the design at all —
        // it is a different transistor, and the report's claim is simply untrue. If the bias
        // reach is elsewhere, the transistor is right and its operating point is the question:
        // the authored spec still sets it there, which reproduces a gate tie only while vds is
        // the one thing that moved; naming the reach is all the engine can honestly do.
        //
        // Hence `vds` is excluded here unconditionally — a drain-only reach never warns. Holding a
        // gm/ID across a drain move is exact on the demo model and close on measured data (see the
        // width-first case in holdHardware), close enough that warning on every range claim in the
        // library would say nothing an author could act on.
        //
        // A given GATE voltage is excluded for the opposite reason: it is the tie itself. A device
        // given its width and its partner's gate voltage is read at exactly that voltage, so a
        // partner that settles somewhere else at the range end is the mirror working, and the
        // note below says what follows from it.
        const via = Object.keys(givens).filter((k) => k !== 'vds' && k !== 'vgs' && keyMoved(k));
        const geometry = via.filter((k) => k === 'W' || k === 'L');
        if (geometry.length)
          out.push({
            rule: 'sheet-range',
            severity: 'warning',
            message:
              `range end "${name}" moves the ${quoted(geometry)} of ${where} — it sizes a ` +
              `DIFFERENT transistor there, so what it reports is not this design measured at ` +
              `another condition`,
            location: name,
          });
        // The warning below is about an operating-point SPEC kept across the move — a gm/ID held
        // where a gate-tied device would keep its voltage. Givens that state the gate voltage keep
        // no such spec: the table is read at that gate voltage — the partner's, re-read at the
        // range end, where the device is tied to one, or the number the author stated — and at
        // the new bias, body bias included. Givens that state the current as an expression the
        // range end reaches keep none either: the current follows what it reads (a share of what
        // a tail delivers), and the table is read at it. The note below still says it moved.
        const bias = via.filter((k) => k !== 'W' && k !== 'L');
        const currentFollows = givens.id !== undefined && readsMoved(givens.id);
        if (bias.length && givens.vgs === undefined && !currentFollows)
          out.push({
            rule: 'sheet-range',
            severity: 'warning',
            message:
              `range end "${name}" reaches ${where}, which fix a width, through ${quoted(bias)} — ` +
              `width-first givens keep their authored operating-point spec at a range end, which ` +
              `holds the same device only when the end moves vds alone`,
            location: name,
          });
        // Given a width and no current, the device's current is whatever the table says at its
        // operating point — a mirror's output device. Where the range end moves that point, the
        // current is different there. `vds` counts here: a drain move is exactly how a tail's
        // current follows the tail node.
        const point = Object.keys(givens).filter((k) => k !== 'W' && k !== 'L' && keyMoved(k));
        if (givens.id === undefined && point.length && !geometry.length)
          out.push(readCurrentMoves(point));
      } else if (onGate.has(path)) {
        // Held on its gate voltage because a hold balances its current (holdHardware): its
        // authored current is the design point's and is not kept, so the note above applies
        // through whatever the held givens still read — the gate voltage and the bias axes. The
        // geometry is held as numbers, so it cannot move.
        const point = ['vgs', ...BIAS_AXES].filter(keyMoved);
        if (point.length) out.push(readCurrentMoves(point));
      } else if (readsMoved(givens.id)) {
        // The authored current IS the hardware description at a range end (a mirror ratio, a
        // tail split, a share of another device's current), so it is re-evaluated there on
        // purpose, and the held device is re-biased to carry the new value.
        const through = namesOf(givens.id as string).filter((n) => reached.has(n));
        out.push({
          rule: 'sheet-range',
          severity: 'info',
          message:
            `range end "${name}" changes the current in ${where}: its expression reads ` +
            `${quoted(through)}, which ${through.length > 1 ? 'move' : 'moves'} there, so the ` +
            `device is held at its width and carries a different current`,
          location: name,
        });
      }
    }
  }
  return out;
}

/** Whether `name` is how a sheet reads one of its table's columns under the affixed name
 *  (`table__k`, see passthroughName and the sheet's sizing): it sizes a device, and the name joins
 *  to the reserved block name. Such a column is not enumerable, like any pass-through column. */
const readsAffixedColumn = (doc: SheetDoc, name: string): boolean =>
  !!doc.givens && splitProvide(name)?.[0] === TABLE_AFFIX;

/** Surface authoring problems as warnings; never throws, never mutates the doc. Structural
 *  and device-independent — identifier resolution against the live values is eval's job.
 *  Recurses into composed children, attributing each child's findings to its block. */
export function validateSheet(doc: SheetDoc, _depth = 0, _wiredBy?: unknown): QAWarning[] {
  // A document in a format this app does not read is kept as stored and read no further: anything
  // said about its keys would be said in the wrong format's terms.
  if (formatOf(doc) === 'unknown') return formatProblems(doc);
  const out: QAWarning[] = [];
  // A device whose wires put its gate on its drain is diode-connected whether or not its givens
  // say so — its own `nodes`, or the parent block's (`_wiredBy`) — and is sized on the diagonal.
  const wiredAsDiode = structuralDiode(doc, _wiredBy);

  out.push(...paramProblems(doc));
  out.push(...givensProblems(doc, wiredAsDiode));
  out.push(...checkProblems(doc));
  out.push(...rangeProblems(doc));
  out.push(...noiseFormProblems(doc));

  // A diode connection already fixes vds; declaring both means one of them is a fiction, and
  // guessing which the author meant would be worse than saying so.
  //
  // `vgs` alongside a diode connection is a different case and is deliberately LEGAL — do not
  // add a symmetric check. The connection says vds FOLLOWS vgs, collapsing the table onto its
  // vds = vgs diagonal; a given vgs then names the point on that diagonal. The two statements
  // are independent and both hold, exactly as a diode connection plus a given gm/ID already
  // does. It is vds that cannot also be declared, because that one names the same coordinate
  // twice with two different numbers.
  if ((doc.givens?.diode || wiredAsDiode) && doc.givens?.vds !== undefined) {
    out.push({
      rule: 'sheet-givens',
      severity: 'error',
      message: !wiredAsDiode
        ? 'the givens declare both a diode connection and a vds — the connection ties vds to vgs, so a ' +
          'separate vds cannot also hold. Drop one'
        : 'the wires put the gate on the drain — a diode connection, which ties vds to vgs — and the ' +
          'givens declare a vds, which cannot also hold. Drop the vds, or move the gate',
      location: 'givens',
    });
  }

  // The format contract, and the netlist's own structure where the document is in the format
  // that has one. The questions about the whole tree — what a held level rests on, whether every
  // device is wired — are asked once, at the top. Whether a child that states wiring is composed
  // by a sheet that states its own is asked of every document, in either format; a child that is
  // only referenced is judged once resolved (runSheet validates the resolved document).
  out.push(...formatProblems(doc));
  if (formatOf(doc) === 2) out.push(...nodesProblems(doc));
  out.push(...composedWiringProblems(doc));
  if (_depth === 0)
    out.push(...treeNodesProblems(doc), ...wiringRefusal(doc), ...dcInputProblems(doc));
  out.push(...unsettledGates(doc, _depth === 0));
  out.push(...looseBalances(doc));

  // The composition interface, both ways: names read across a block boundary, and names this
  // sheet declares it exposes. Runs for every doc — a leaf with no children still publishes.
  out.push(...provideCoverage(doc));

  // Composition: validate each block and attribute its findings to it.
  out.push(...blockProblems(doc, _depth));
  return out;
}

/** An engine with no constant map, whose free names are every identifier an expression reads —
 *  `gamma`, `k` and `T` among them, which the shared engine counts as constants and leaves out. */
const ALL_NAMES = createEngine({});

/** The thermal-noise figures that already carry the body effect where the table has gmb (the
 *  γ-model keys) or are the table's own noise (the measured ones). */
const NOISE_FIGURES = ['svth_m', 'vnth_m', 'svth', 'vnth'] as const;

/**
 * An expression that reads γ against gm and reads neither gmb nor a noise figure computes the
 * thermal floor as 4kTγ/gm: without body effect, so low by 1 + gmb/gm in power on any table that
 * carries gmb, where γ itself is read against gm + gmb. A warning, since a sheet may mean it; it is
 * checked per level, for the sheet's own `gamma` and for each block's published `<block>__gamma`.
 */
function noiseFormProblems(doc: SheetDoc): QAWarning[] {
  const sites: { expr: string; location: string; what: string }[] = [
    ...doc.equations.map((r) => ({ expr: r.expr, location: r.name, what: `equation "${r.name}"` })),
    ...doc.checks.flatMap((c) =>
      [c.lhs, c.rhs].map((expr) => ({ expr, location: c.id, what: `check "${c.id}"` })),
    ),
    ...(doc.blocks ?? []).flatMap((u) =>
      Object.entries(u.params ?? {}).map(([k, expr]) => ({
        expr,
        location: u.name,
        what: `block "${u.name}" param "${k}"`,
      })),
    ),
  ];
  const out: QAWarning[] = [];
  for (const { expr, location, what } of sites) {
    if (typeof expr !== 'string') continue;
    let names: ReadonlySet<string>;
    try {
      names = new Set(ALL_NAMES.compile(expr).names);
    } catch {
      continue; // an expression that does not parse is reported where it is read
    }
    for (const n of names) {
      if (n !== 'gamma' && !n.endsWith(`${PROVIDE_SEP}gamma`)) continue;
      const p = n.slice(0, -'gamma'.length);
      if (!names.has(`${p}gm`) || names.has(`${p}gmb`)) continue;
      if (NOISE_FIGURES.some((f) => names.has(`${p}${f}`))) continue;
      out.push({
        rule: 'sheet-noise-form',
        severity: 'warning',
        symbol: n,
        message:
          `${what} reads ${n} against ${p}gm without ${p}gmb, which is the thermal floor without ` +
          `body effect, low by 1 + gmb/gm in power on a table that carries gmb — read ` +
          `${p}svth_m or ${p}vnth_m, or include ${p}gmb`,
        location,
      });
    }
  }
  return out;
}

/** The params' own problems: each param on its own, then the solved params' structure. */
function paramProblems(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  for (const p of doc.params) {
    if (!Number.isFinite(p.value)) {
      out.push({
        rule: 'sheet-param',
        severity: 'error',
        message: `param "${p.name}" is not a finite number`,
        location: p.name,
      });
    }
    // `class` is the author's word on what kind of DC level the param is. `solved` is not theirs
    // to give — the engine decides that from designConstraint/solveFor — and a solved param
    // carrying a class would say two different things about one value.
    const cls: unknown = p.class;
    if (cls !== undefined && (typeof cls !== 'string' || !PARAM_CLASSES.has(cls))) {
      out.push({
        rule: 'sheet-dc-inputs',
        severity: 'error',
        message:
          cls === 'solved'
            ? `param "${p.name}": class "solved" is derived, never authored — a param is solved ` +
              `when a design constraint moves it or it carries solveFor`
            : `param "${p.name}" has unknown class "${String(cls)}" — use one of ` +
              quoted([...PARAM_CLASSES]),
        location: p.name,
      });
    } else if (cls !== undefined && (engineSolved(p) || holds(p))) {
      out.push({
        rule: 'sheet-dc-inputs',
        severity: 'error',
        message: engineSolved(p)
          ? `param "${p.name}" is solved by the engine, so its class is derived — drop class "${String(cls)}"`
          : `param "${p.name}" carries hold, so its class is derived — drop class "${String(cls)}"`,
        location: p.name,
      });
    }
    // A param that solves for itself reads zero everywhere in its range, and hides the loop it
    // was meant to close. Only the self-reference is checkable here — whether the target
    // resolves at all depends on the live value set, which is eval's job.
    if (p.solveFor === p.name) {
      out.push({
        rule: 'sheet-param',
        severity: 'error',
        message: `param "${p.name}" solves for itself — name the value it is an estimate of`,
        location: p.name,
      });
    }
    // `held` marks the constraint a held run generates from a hold (holdAsConstraint). Written in
    // a document it would make an ordinary constraint read as a node under a gate.
    const dc: unknown = p.designConstraint;
    if (isObject(dc) && Object.prototype.hasOwnProperty.call(dc, 'held')) {
      out.push({
        rule: 'sheet-param',
        severity: 'error',
        message:
          `param "${p.name}": its design constraint carries "held", which the engine sets on the ` +
          `constraint it generates from a hold where the hardware is held, and is never written — ` +
          `drop it, or write the relation as a hold`,
        location: p.name,
      });
    }
    // A relation that never reads its own param cannot single it out: whatever it reads is the
    // same at every value of the param, so a search would land on `min` and call it found. Only
    // asserted where the walk could place every name the relation reads — a table column it
    // cannot place might be the param's own device, so an unplaced name is not taken as proof.
    const rel = solvedRelation(p);
    if (rel && p.solveFor !== p.name) {
      const reads = exprRoots(doc, '', `(${rel.lhs}) - (${rel.rhs})`, { residual: p.name });
      if (!reads.selfRead && reads.unresolved.length === 0)
        out.push({
          rule: 'sheet-param',
          severity: 'error',
          message:
            `param "${p.name}": its relation ${rel.lhs} - (${rel.rhs}) does not read ${p.name}, so ` +
            `it cannot single ${p.name} out — write the relation in terms of the param it solves`,
          location: p.name,
        });
    }
  }

  // Constrained params: one home for the structural checks (constraintProblem), so evaluation fails
  // closed on the SAME words this raises as an error — the bindProblem discipline. This also
  // catches a half-written constraint ({lhs} only), which the constrained() shape guard rejects and
  // which would otherwise freeze the param: neither swept nor solved, with the sheet still reading
  // feasible.
  const constraintIssue = constraintProblem(doc.params);
  if (constraintIssue) {
    out.push({
      rule: 'sheet-param',
      severity: 'error',
      message: constraintIssue,
      location: 'params',
    });
  }
  return out;
}

/** The givens' problems, and the params and equations the sizing publishes over. `wiredAsDiode`:
 *  the wires put the device's gate on its drain (see structuralDiode). */
function givensProblems(doc: SheetDoc, wiredAsDiode: boolean): QAWarning[] {
  const out: QAWarning[] = [];
  if (doc.givens) {
    const problem = bindProblem(BINDABLE.filter((k) => doc.givens?.[k] !== undefined));
    if (problem) {
      out.push({
        rule: 'sheet-givens',
        severity: 'error',
        message: `givens ${problem}`,
        location: 'givens',
      });
    }
    // Every sized device states its drain voltage. That holds whatever table the sheet is later
    // run on, so it is said here with no table in hand, in the words the sizing fails on. A
    // warning, not an error: the sizing is what refuses the device, and a sheet that is still
    // run reaches it — where the report names the axis to state, so the fix is offered in place.
    const drain = drainProblem(wiredAsDiode ? { ...doc.givens, diode: true } : doc.givens);
    if (drain) {
      out.push({ rule: 'sheet-givens', severity: 'warning', message: drain, location: 'givens' });
    }
    // A flag that is not a boolean is not a connection either way; the sizing reads only `true`.
    if (doc.givens.diode !== undefined && typeof doc.givens.diode !== 'boolean') {
      out.push({
        rule: 'sheet-givens',
        severity: 'error',
        message: 'given diode must be true or false',
        location: 'givens',
      });
    }
    // A region names the check the engine adds; any other word would add none, silently.
    const region: unknown = doc.givens.region;
    if (region !== undefined) {
      if (typeof region !== 'string' || !REGIONS.has(region))
        out.push({
          rule: 'sheet-givens',
          severity: 'error',
          message: 'given region must be "saturation" or "triode"',
          location: 'givens',
        });
      else if (doc.givens.diode === true || wiredAsDiode)
        out.push({
          rule: 'sheet-givens',
          severity: 'error',
          message:
            (doc.givens.diode === true
              ? 'the givens declare a region beside a diode connection'
              : 'the givens declare a region, and the wires put the gate on the drain — a diode ' +
                'connection') +
            ' — the drain is the gate, so whether vds clears vdsat is not a question the design ' +
            'leaves open. Drop region',
          location: 'givens',
        });
      // The region check is reported under its own id beside the authored ones, and results are
      // keyed by id (see engineChecks).
      if (doc.checks.some((r) => r.id === REGION_CHECK_ID))
        out.push({
          rule: 'sheet-check',
          severity: 'error',
          message:
            `check id "${REGION_CHECK_ID}" is the id of the check the givens' region adds — ` +
            'rename the authored check, or drop it in favour of the region',
          location: REGION_CHECK_ID,
        });
    }
  }

  // A level that sizes a device merges everything the sizing publishes into its scope after its
  // params are seeded (eval.ts, runSizing): every namespace quantity the table supports, the
  // selectors, the ceiling, and the table scalars (`T`, `UT`, `w`) it re-reads at the sized
  // width. A param of the same name is therefore overwritten wherever a device is sized — on a
  // table that carries that quantity, which is not every table, so the same sheet reads the
  // author's number on one table and the device's on another with nothing said. An equation of the
  // same name runs after the sizing, so it replaces the device's value for every row after it. A
  // param that IS the given of the same name (`gm_id: "gm_id"`) is exempt: the sizing writes back
  // the number it was handed.
  if (doc.givens) {
    const givens = doc.givens as unknown as Record<string, unknown>;
    out.push(
      ...collisions(
        doc,
        DEVICE_NAMES,
        (n) =>
          `param "${n}": the sizing publishes a quantity named ${n}, which overwrites this param where a device is sized; rename it`,
        (n) =>
          `equation "${n}": the sizing publishes a quantity named ${n}, which this equation replaces for every row after it — the device's own value included; rename it`,
        (p) => givens[p.name] === p.name,
      ),
    );
  }
  return out;
}

/** The checks' problems: duplicate ids, then each check's id, kind, operator and tolerance. */
function checkProblems(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  // Duplicate check ids collapse silently downstream: indexTreeResults keys results by id, so
  // the sweep charts one curve where two checks exist and bindingCheck can name the WRONG
  // worst check. (A child reusing a parent's id is fine — paths disambiguate across levels.)
  const checkIds = new Set<string>();
  for (const r of doc.checks) {
    if (checkIds.has(r.id)) {
      out.push({
        rule: 'sheet-check',
        severity: 'error',
        message: `duplicate check id "${r.id}" — results are keyed by id, so one of them would silently shadow the other in sweeps and the binding-check badge`,
        location: r.id,
      });
    }
    checkIds.add(r.id);
  }

  for (const r of doc.checks) {
    // Reserved so a tree-keyed id (`cs.headroom`, `cm-lo@check`) can never collide with an
    // authored one — the same silent-shadowing hazard the duplicate-id check above exists for.
    const idSep = idSepProblem(r.id);
    if (idSep) {
      out.push({
        rule: 'sheet-check',
        severity: 'error',
        message: `check id "${r.id}" contains "${idSep}" — reserved for tree-keyed check ids (block paths like cs${PATH_SEP}headroom, range-end ids like cm-lo${RANGE_END_SEP}check)`,
        location: r.id,
      });
    }
    // An error, not a warning: only the kinds the verdict knows as hard can gate it, so a check
    // under any other spelling — an earlier name included — would otherwise sit out silently.
    if (!CHECK_KINDS.has(r.kind)) {
      out.push({
        rule: 'sheet-check',
        severity: 'error',
        message: `check "${r.id}" has unknown kind "${r.kind}" — use one of ${quoted([...CHECK_KINDS])}`,
        location: r.id,
      });
    }
    if (!CHECK_OPS.has(r.op)) {
      out.push({
        rule: 'sheet-check',
        severity: 'warning',
        message: `check "${r.id}" has unknown operator "${r.op}"`,
        location: r.id,
      });
    }
    if (r.op === '==' && r.tolPct === undefined) {
      out.push({
        rule: 'sheet-tol',
        severity: 'warning',
        message: `equality check "${r.id}" has no tolPct (will require an exact match)`,
        location: r.id,
      });
    }
    // A non-finite tolPct poisons the '==' margin arithmetic into NaN; eval degrades that
    // to `na` (fail-closed), but the authoring mistake should be named at the source.
    if (r.tolPct !== undefined && (!Number.isFinite(r.tolPct) || r.tolPct < 0)) {
      out.push({
        rule: 'sheet-tol',
        severity: 'error',
        message: `check "${r.id}" tolPct must be a finite number >= 0, got ${r.tolPct}`,
        location: r.id,
      });
    }
  }
  return out;
}

/** The operating range's problems: each range end's shape, then what it reaches (see
 *  complianceReach). */
function rangeProblems(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  // The operating range: structural checks only — whether the overridden evaluation complies
  // is eval's verdict, not a shape question.
  if (doc.operatingRange?.length) {
    const rangeEndNames = new Set<string>();
    const paramByName = new Map(doc.params.map((p) => [p.name, p]));
    for (const e of doc.operatingRange) {
      const name = e.name?.trim();
      if (!name) {
        out.push({
          rule: 'sheet-range',
          severity: 'error',
          message: 'a range end has an empty name',
          location: 'operatingRange',
        });
        continue;
      }
      if (rangeEndNames.has(name)) {
        out.push({
          rule: 'sheet-range',
          severity: 'error',
          message: `duplicate range end name "${name}" — range-end results are keyed by name`,
          location: name,
        });
      }
      rangeEndNames.add(name);
      const sep = idSepProblem(name);
      if (sep) {
        out.push({
          rule: 'sheet-range',
          severity: 'error',
          message: `range end name "${name}" must not contain "${sep}" — it becomes part of tree-keyed check ids`,
          location: name,
        });
      }
      const entries = Object.entries(e.set ?? {});
      if (entries.length === 0) {
        out.push({
          rule: 'sheet-range',
          severity: 'error',
          message: `range end "${name}" sets nothing — name at least one param to override`,
          location: name,
        });
      }
      for (const [k, expr] of entries) {
        const p = paramByName.get(k);
        if (!p) {
          out.push({
            rule: 'sheet-range',
            severity: 'error',
            message: `range end "${name}" sets "${k}", which is not a param of this sheet`,
            location: name,
          });
        } else if (engineSolved(p) || holds(p)) {
          out.push({
            rule: 'sheet-range',
            severity: 'error',
            message: engineSolved(p)
              ? `range end "${name}" sets "${k}", which the engine solves — the override would be discarded by the solve`
              : `range end "${name}" sets "${k}", which carries hold — a range end re-solves it, so the override would be discarded`,
            location: name,
          });
        }
        if (typeof expr !== 'string' || !parses(expr)) {
          out.push({
            rule: 'sheet-range',
            severity: 'error',
            message: `range end "${name}": the expression for "${k}" does not parse`,
            location: name,
          });
        }
      }
    }
    out.push(...complianceReach(doc));
  }
  return out;
}

/** The composition's problems: collisions with what the blocks provide, hand-tuned assumptions,
 *  forward references, each block's shape, and each embedded child's own findings, attributed to
 *  its block. `depth` is how deep `doc` sits in the tree. */
function blockProblems(doc: SheetDoc, depth: number): QAWarning[] {
  const out: QAWarning[] = [];
  if (doc.blocks) {
    // Collision guard: a child exposes scalars into the parent scope as `name__key`. If a
    // parent param or equation is named identically, the child injection silently overwrites it
    // (or the equation shadows the injection) — surface it rather than resolve it by overwrite.
    // A ref-only block's provides are unknown until resolution, so these structural
    // checks cover embedded children only — run validation on the RESOLVED doc (as
    // runSheet does when given a ref index) for full coverage.
    out.push(
      ...collisions(
        doc,
        new Set(doc.blocks.flatMap(providedNames)),
        (n) =>
          `param "${n}" collides with a scalar a block provides — the block's value would silently override it`,
        (n) => `equation "${n}" collides with a scalar a block provides`,
      ),
    );

    out.push(...assumptionEstimates(doc));

    // Children evaluate in document order, and a block's param overrides may reference the
    // provides of EARLIER siblings only. A forward (or self) reference is statically
    // detectable here: the joined name can never be in scope when the override resolves.
    for (let i = 0; i < doc.blocks.length; i++) {
      const block = doc.blocks[i];
      if (!block.params) continue;
      const later = new Set(doc.blocks.slice(i).flatMap(providedNames));
      for (const [k, expr] of Object.entries(block.params)) {
        // The child re-solves a held param wherever the hardware is held — a node under a gate,
        // or a current its balance fixes — so the value wired in here is honoured at the design
        // point and dropped at a range end, while this sheet goes on reading its own.
        const heldParam = block.doc?.params.find((p) => p.name === k && holds(p));
        if (heldParam && block.doc) {
          const what = balancedBy(block.doc, heldParam).length
            ? ['a current the child balances', 'balance']
            : ['a node the child holds under a gate', 'node'];
          out.push({
            rule: 'sheet-block-param',
            severity: 'warning',
            message: `block "${block.name}" override "${k}" sets ${what[0]} — a range end re-solves it inside the child, and this sheet's own value for it will not follow. Hold the ${what[1]} on this sheet instead`,
            location: block.name,
          });
        }
        for (const n of namesOf(expr)) {
          if (later.has(n)) {
            out.push({
              rule: 'sheet-block-param',
              severity: 'warning',
              message: `block "${block.name}" override "${k}" references "${n}", which is provided by this or a LATER sibling — blocks evaluate in document order, so it will not resolve`,
              location: block.name,
            });
          }
        }
      }
    }

    const seen = new Set<string>();
    for (const block of doc.blocks) {
      // Exactly one content source: an embedded doc, or a non-blank ref to resolve. A
      // block with neither can never evaluate; a blank ref can never match a library id.
      if (!block.doc && block.ref === undefined) {
        out.push({
          rule: 'sheet-block',
          severity: 'error',
          message: `block "${block.name}" has neither an embedded doc nor a ref`,
          location: block.name,
        });
      }
      if (block.ref !== undefined && !block.ref.trim()) {
        out.push({
          rule: 'sheet-ref',
          severity: 'error',
          message: `block "${block.name}" has an empty ref`,
          location: block.name,
        });
      }
      const name = block.name?.trim();
      if (!name) {
        out.push({
          rule: 'sheet-block',
          severity: 'error',
          message: 'a block has an empty name',
          location: 'blocks',
        });
      } else {
        if (seen.has(name)) {
          out.push({
            rule: 'sheet-block',
            severity: 'error',
            message: `duplicate block name "${name}"`,
            location: name,
          });
        }
        seen.add(name);
        if (name.includes(PROVIDE_SEP)) {
          out.push({
            rule: 'sheet-block',
            severity: 'error',
            message: `block name "${name}" must not contain "${PROVIDE_SEP}" (the provide separator)`,
            location: name,
          });
        }
        if (name === TABLE_AFFIX) {
          out.push({
            rule: 'sheet-block',
            severity: 'error',
            message:
              `block name "${TABLE_AFFIX}" is reserved: a table column whose own name the sheet ` +
              `already uses is read as "${affixedColumn('<column>')}", and a block of this name ` +
              `would provide names of the same form`,
            location: name,
          });
        }
        const blockSep = idSepProblem(name);
        if (blockSep) {
          out.push({
            rule: 'sheet-block',
            severity: 'error',
            message: `block name "${name}" must not contain "${blockSep}" — it becomes part of tree-keyed check ids`,
            location: name,
          });
        }
      }
      // A provide key normally must not contain the separator — EXCEPT when it names a
      // scalar the child itself received from ITS children (`grand__key`): re-exporting a
      // grandchild value up the tree is the ratified idiom for surfacing a deep quantity,
      // so only a separator-bearing key that matches nothing injectable is flagged.
      const childInjected = new Set((block.doc?.blocks ?? []).flatMap(providedNames));
      for (const key of block.doc?.provides ?? []) {
        if (
          key.includes(PROVIDE_SEP) &&
          !childInjected.has(key) &&
          !(block.doc && readsAffixedColumn(block.doc, key))
        ) {
          out.push({
            rule: 'sheet-provide',
            severity: 'warning',
            message: `provided name "${key}" in block "${block.name}" must not contain "${PROVIDE_SEP}" (unless re-exporting one of a child's provides)`,
            location: block.name,
          });
        }
      }
      // Override keys can only be checked against a KNOWN child param list — for a
      // ref-only block that list arrives at resolution, and revalidating the resolved
      // doc (runSheet's path) performs this same check with the doc filled in.
      if (block.params && block.doc) {
        const childParams = new Set(block.doc.params.map((p) => p.name));
        for (const k of Object.keys(block.params)) {
          // An error, not advice: the value the parent wired will never reach the child,
          // which then sizes on its embedded default — eval fails this closed too.
          if (!childParams.has(k)) {
            out.push({
              rule: 'sheet-block-param',
              severity: 'error',
              message: `block "${block.name}" overrides "${k}", which is not a param of the child`,
              location: block.name,
            });
          }
        }
      }
      if (depth >= MAX_BLOCK_DEPTH) {
        out.push({
          rule: 'sheet-block',
          severity: 'error',
          message: `block "${block.name}": composition nested deeper than ${MAX_BLOCK_DEPTH}`,
          location: block.name,
        });
        continue;
      }
      if (block.doc) {
        // Range ends are a top-of-tree feature: in composition the parent typically drives the
        // child's spec params, which would make the child's own range claim a fiction —
        // so the engine ignores them, and this says so rather than letting the author
        // believe the child's operating range still gates.
        if (block.doc.operatingRange?.length) {
          out.push({
            rule: 'sheet-range',
            severity: 'warning',
            message: `block "${block.name}": the composed child declares an operating range — it is not evaluated in composition; re-declare the claim on the parent if it should gate here`,
            location: block.name,
          });
        }
        for (const w of validateSheet(block.doc, depth + 1, blockWires(doc, block))) {
          out.push(prefixBlockWarning(block.name, w));
        }
      }
    }
  }
  return out;
}
