// Structural QA for a leaf sheet, in the qa/validate() shape: init an array, push
// warning literals, skip-not-throw, return the bare array. It checks what evaluation
// cannot conveniently express — givens arity, finite params, equality tolerance, kind/op
// sanity, and a param shadowing a device quantity. It also owns the table-independent
// half of name resolution: whether a `block__key` reference names a scalar that block
// actually publishes, and whether a name a sheet claims to publish exists at all. Those
// answers need no device table, so they are structural. Resolving identifiers against
// the live value set stays evaluateSheet's job. DOM-free.

import type { QAWarning } from '../types';
import { compileExpr, metaScalars } from '../derive';
import { BINDABLE, bindProblem } from '../device';
import { BASE_KEYS, DERIVED_QUANTITIES, PER_WIDTH_KEYS } from '../namespace';
import { HELD_AT_A_RANGE_END, heldShape } from './coverage';
import {
  BIAS_AXES,
  GIVENS_FLAGS,
  RANGE_END_SEP,
  PATH_SEP,
  blockPath,
  idSepProblem,
  MAX_TORN_PARAMS,
  MAX_BLOCK_DEPTH,
  docExpressions,
  engineSolved,
  holds,
  constrained,
  torn,
  constraintProblem,
  PARAM_CLASSES,
  PROVIDE_SEP,
  CHECK_KINDS,
  CHECK_OPS,
  WIRING_KEYS,
  joinProvide,
  providedNames,
  prefixBlockWarning,
  splitProvide,
  type ParamClass,
  type SheetDoc,
  type SheetEquation,
  type SheetBlock,
  type SheetVar,
} from './types';

/** Whether an expression parses at all — distinct from namesOf, whose empty result also
 *  describes a legal literal like "0.9". */
function parses(expr: string): boolean {
  try {
    compileExpr(expr);
    return true;
  } catch {
    return false;
  }
}

/** Free identifiers of an expression, or [] when it does not parse (eval names the
 *  parse error at the failing site; the validator only needs the names). */
function namesOf(expr: string): readonly string[] {
  try {
    return compileExpr(expr).names;
  } catch {
    return [];
  }
}

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
 * Structural checks on a block's declared gate wiring — the ONLY route by which a wiring
 * declaration reaches a verdict. What the check finds at RUNTIME (an expression that will not
 * resolve, a disagreement past the tolerance) stays a warning: the declaration and the sizing
 * are two descriptions of one node, and picking a winner between them is the author's call, not
 * QA's. But a declaration that is not a declaration — half-written, misspelled, unparseable —
 * states no identity at all, and a sheet reported as wiring-checked when nothing was checked is
 * precisely the silence this mechanism exists to break.
 */
function wiringProblems(block: SheetBlock): QAWarning[] {
  // `unknown`, not SheetWiring: a persisted document arrives unverified, so the shape is what
  // is being checked here rather than what may be assumed.
  const w: unknown = block.wiring;
  if (w === undefined) return [];
  const out: QAWarning[] = [];
  const bad = (message: string): void => {
    out.push({
      rule: 'sheet-wiring',
      severity: 'error',
      message: `block "${block.name}": ${message}`,
      location: block.name,
    });
  };
  if (typeof w !== 'object' || w === null || Array.isArray(w)) {
    bad('wiring must be an object declaring the gate and source nodes');
    return out;
  }
  const decl = w as Record<string, unknown>;
  for (const k of Object.keys(decl)) {
    if (!WIRING_KEYS.has(k)) {
      bad(`wiring has unknown key "${k}" — only ${[...WIRING_KEYS].join(', ')} are declared`);
    }
  }
  for (const k of ['gate', 'source'] as const) {
    const e = decl[k];
    if (typeof e !== 'string' || !e.trim()) {
      bad(
        `wiring needs both gate and source (${k} is missing) — half-declared, it names no ` +
          `identity to check`,
      );
    } else if (!parses(e)) {
      bad(`wiring ${k} expression "${e}" does not parse`);
    }
  }
  return out;
}

/** A node expression reduced to a comparison key. Whitespace only — no algebra: this compares
 *  how two blocks NAME a node, not what the node evaluates to. */
const nodeKey = (expr: string): string => expr.replace(/\s+/g, '');

/**
 * Two blocks that declare the same gate node AND the same source node are on one wire and one
 * source, so their gate-source voltage is a single number — whatever the table, the corner or
 * the temperature. A sheet that then sizes each of them at its OWN operating point has written
 * that identity down and left the engine free to break it: each sizing settles wherever its own
 * target lands, and the two agree only while both read the same table at the same bias. Read
 * the design at another condition and the gates drift apart with every check still green.
 *
 * What makes them agree is giving one device's `vgs` as the other's — `{ W: "K*ref__W", vgs:
 * "ref__vgs" }` — which states the shared wire AS the sizing instead of beside it. So the
 * question here is whether each block on one (gate, source) pair is sized on a vgs that names
 * ANOTHER BLOCK ON THAT SAME PAIR. A given vgs alone is not enough: `vgs: "0.7"` is a typed
 * number, and a vgs read off a block somewhere else on the schematic is a different claim; both
 * would silence the finding while coupling nothing. One block must be left over — something has
 * to settle the voltage the rest follow — so the finding is raised when TWO or more are not
 * tied to a peer, and it names those.
 *
 * The reference can be written in either of the two places an author can put it: directly in
 * the child's own givens, or as a child param the parent overrides in its block (the usual
 * shape, since only the parent knows what its children are wired to). Both are read.
 *
 * Scope worth knowing: `wiring` is declared on a BLOCK, so this compares child to child. A sheet
 * whose gate-tied pair is its OWN device plus one child — which is how the library's mirrors are
 * written — declares no gate node for the parent device and is out of this rule's reach. Giving
 * the parent's givens a node declaration is a schema change, not a check.
 *
 * Both halves of the pair are required, and the source half is what keeps the check honest. A
 * complementary pair driven by one input (the library's CMOS inverter stage) shares a gate and
 * sits on different rails, so its two gate-source voltages are genuinely different numbers; so
 * does a Widlar source, whose whole design equation is the difference between them. Matching on
 * the gate alone would report both as defects.
 *
 * A declaration is never allowed to DRIVE the sizing, only to be checked against it. Re-sizing a
 * device from its wiring would replace a coupling the author can see with one they cannot,
 * which is the silence this mechanism exists to break — so this reports and repairs nothing.
 *
 * Nodes are matched on the expression TEXT, not on a value: a declaration names a node, and two
 * blocks on one wire are written the same way. A node spelled two different ways is missed
 * rather than misreported — the right direction for an advisory, the same trade reachedGivens
 * makes.
 */
function untiedGates(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const groups = new Map<string, { gate: string; source: string; blocks: SheetBlock[] }>();
  for (const block of doc.blocks ?? []) {
    // `unknown`, as in wiringProblems: a persisted document arrives unverified. A half-written
    // or unparseable declaration names no node pair, and wiringProblems already reports it.
    const w = block.wiring as unknown as Record<string, unknown> | undefined;
    if (!w || typeof w.gate !== 'string' || typeof w.source !== 'string') continue;
    if (!w.gate.trim() || !w.source.trim()) continue;
    const key = `${nodeKey(w.gate)}\u0000${nodeKey(w.source)}`;
    const group = groups.get(key) ?? { gate: w.gate.trim(), source: w.source.trim(), blocks: [] };
    group.blocks.push(block);
    groups.set(key, group);
  }
  for (const { gate, source, blocks } of groups.values()) {
    // A block with no embedded doc has unknown givens (a ref resolves later; runSheet
    // revalidates the resolved doc), and one with no givens sizes no device. Neither can be ruled
    // on, so drop it and rule on the rest — dropping the whole GROUP instead would let one
    // unresolved sibling hide a real pair beside it.
    const sized = blocks.filter((u) => u.doc?.givens);
    if (sized.length < 2) continue;
    const untied = sized.filter((u) => !tiedToPeer(u, sized));
    if (untied.length < 2) continue;
    const named = untied.map((u) => `"${u.name}"`).join(', ');
    out.push({
      rule: 'sheet-gate-tie',
      severity: 'warning',
      message:
        `${named} declare the same gate node (${gate}) on the same source node (${source}), so ` +
        `their gate-source voltage is one number — but each is sized at its own operating ` +
        `point, so nothing holds them at it. They agree only while every one of them reads the ` +
        `same table at the same bias. Give one block the other's vgs (\`"vgs": ` +
        `"<block>__vgs"\`, with that block providing vgs) to make the shared wire the sizing`,
      location: untied[0].name,
    });
  }
  return out;
}

/** Whether `block` is sized on a gate voltage that names one of its `peers` — the reference read
 *  from the child's own givens and, when they name a child param, from the parent's override
 *  of it, which is where the cross-block name normally lives. */
function tiedToPeer(block: SheetBlock, peers: readonly SheetBlock[]): boolean {
  const expr = block.doc?.givens?.vgs;
  if (expr === undefined) return false;
  const override = block.params?.[expr.trim()];
  const names = [...namesOf(expr), ...(override === undefined ? [] : namesOf(override))];
  return peers.some((p) => p !== block && names.includes(joinProvide(p.name, 'vgs')));
}

/** Scalars every evaluation seeds from the table's metadata, givens or no givens — so a sheet may
 *  name one in `provides` without declaring it. Read off metaScalars itself rather than listed
 *  again here. The probe must supply EVERY metadata field, because the key set follows the
 *  fields present: thermalScalars yields nothing for a missing temp and `w` needs `W`, so a
 *  slimmer probe would silently shrink the published-name set. The expression constants
 *  (pi, k, gamma, …) are deliberately absent: they are in every scope already, so
 *  publishing one exposes nothing to a parent and stays worth saying. */
const META_PUBLISHED: ReadonlySet<string> = new Set(Object.keys(metaScalars({ W: 1, temp: 27 })));

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

/** The level `block` embeds below `lv`, with no children enrolled yet. */
const childLevel = (lv: Level, block: SheetBlock, doc: SheetDoc): Level => ({
  doc,
  path: `${lv.path}${block.name}${PATH_SEP}`,
  parent: { level: lv, block },
  kids: new Map(),
});

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
  [
    ...BASE_KEYS,
    ...DERIVED_QUANTITIES.map((d) => d.key),
    ...BINDABLE,
    'w0',
    'ceiling',
    'feasible',
  ].filter((k) => !META_PUBLISHED.has(k)),
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
  /** Follow a parent's override of a child param the engine solves. The engine discards it (a
   *  design constraint chooses from its own bracket, a solveFor only seeds from it), so following
   *  it over-approximates. */
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
  /** Stop at a constrained param and record it, instead of following its relation. */
  stopAtConstraints?: boolean;
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

/** Which other constrained params a constraint's residual depends on — the order in which
 *  constraints can be solved one at a time. A device quantity its givens name (`in__id` with `id`
 *  given as `I_tail/2`) depends on that expression alone; a constrained param is a stop, while a
 *  torn one is followed through the name it solves for. A range end's `set` is evaluated against a
 *  finished run, never inside one, so it is not followed. */
const RESIDUAL: TraversalPolicy = { givenQuantities: true, phased: true, stopAtConstraints: true };

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
  if (policy.sizingProvides) return policy.held?.has(key) ? [inside] : [inside, device];
  const own =
    key.includes(PROVIDE_SEP) ||
    kid.doc.params.some((q) => q.name === key) ||
    kid.doc.equations.some((r) => r.name === key);
  return own ? [inside] : [device];
}

/** A device's own links: each given expression, keyed by the quantity it gives. */
const givensEdges = (lv: Level): Reads[] =>
  Object.entries(lv.doc.givens ?? {}).flatMap(([k, v]): Reads[] =>
    !GIVENS_FLAGS.has(k) && typeof v === 'string'
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
 * `origin` again is a loop, kept only when the path is open. `self`, the constraint's own unknown,
 * sets `selfRead` wherever it is reached in its own level — before any override of it is looked at
 * — and is followed no further.
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
    const edges = edgesOf(lv, name, sized, policy);
    if (edges.length === 0) found.unresolved.add(qualified);
    for (const e of edges) {
      if (e.kind === 'meta') continue;
      if (e.kind === 'root') {
        const entry = roots.get(qualified) ?? { p: e.p, devices: new Set<string>() };
        entry.devices.add(sizer);
        roots.set(qualified, entry);
      } else if (e.kind === 'device') {
        device(e.lv, policy.givenQuantities ? e.key : undefined, closed);
      } else if (e.kind === 'solved' && policy.stopAtConstraints && constrained(e.p)) {
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
 *    scope — unless the engine solves it: a design constraint ignores the override, a solveFor only
 *    seeds from it, so it stays a root;
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

/** The two readings exprRoots offers: the DC-input walk's, or the residual of a constraint on the
 *  named param of the level the expression is read at. */
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
 * by class, under one policy: `provenance`, or `{ residual: X }` for the residual of a constraint
 * on that level's param X. The expression is read where a residual is evaluated: after the level's
 * sizing. Also reported: the names that resolve to nothing, the devices, equations (`equation`) and
 * solved relations crossed on the way, and each cycle reached, with whether a solved relation lies
 * on it. Under `residual`, `constraints` holds the OTHER constrained params reached — the
 * constraint's ordering edges, never X — and `selfRead` whether X itself was reached in its own
 * level. A name that resolves to nothing may be one only the live value set can place, such as a
 * table's pass-through column, so it fails closed: `constraints` then holds every other constrained
 * param in the tree. Structural and table-free, like dcInputs.
 */
export function exprRoots(
  doc: SheetDoc,
  level: string,
  expr: string,
  policy: RootsPolicy,
): ExprRoots {
  const levels = levelsOf(doc);
  const path = level === '' ? '' : `${level}${PATH_SEP}`;
  const lv = levels.find((l) => l.path === path);
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
  const every = levels.flatMap((l) =>
    l.doc.params.filter(constrained).map((p) => `${l.path}${p.name}`),
  );
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

/**
 * The order in which a tree's constrained params can be solved one at a time: each after every
 * other constrained param its relation reads (the RESIDUAL policy's edges), names qualified by
 * block path. Solving in that order is exact — a relation never reads a param solved after it, so
 * nothing has to be revisited. When no such order exists, two or more constraints depend on each
 * other: a coupled system, which this engine reports and does not solve, at one level or across
 * levels alike. The `problem` names the params on the loop.
 *
 * `held: true` reads the document as a fixed-hardware run will (heldShape) — every `hold` a design
 * constraint and every device's givens in their fixed-width form — so that run's order can be
 * checked before any run exists. It is a different document from the authored one, not a superset
 * of it, so a caller checking a sheet asks about both.
 *
 * A relation that reads a name nothing on the sheet provides cannot be placed in the order at
 * all (exprRoots fails closed on it); the problem then names that name, not the loop it would
 * otherwise be reported as.
 */
export function constraintPlan(
  doc: SheetDoc,
  opts: { held?: boolean } = {},
): { order: string[] } | { problem: string } {
  const tree = opts.held ? heldShape(doc) : doc;
  const reads = new Map<string, string[]>();
  const unplaced = new Map<string, string[]>();
  for (const lv of levelsOf(tree)) {
    for (const p of lv.doc.params.filter(constrained)) {
      const level = lv.path.endsWith(PATH_SEP) ? lv.path.slice(0, -PATH_SEP.length) : lv.path;
      const { constraints, unresolved } = exprRoots(
        tree,
        level,
        `(${p.designConstraint.lhs}) - (${p.designConstraint.rhs})`,
        {
          residual: p.name,
        },
      );
      reads.set(`${lv.path}${p.name}`, constraints);
      if (unresolved.length) unplaced.set(`${lv.path}${p.name}`, unresolved);
    }
  }
  const order: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const visit = (name: string, trail: string[]): string[] | undefined => {
    if (state.get(name) === 'done') return undefined;
    if (state.get(name) === 'open') return [...trail.slice(trail.indexOf(name)), name];
    state.set(name, 'open');
    for (const dep of reads.get(name) ?? []) {
      const loop = visit(dep, [...trail, name]);
      if (loop) return loop;
    }
    state.set(name, 'done');
    order.push(name);
    return undefined;
  };
  for (const name of reads.keys()) {
    const loop = visit(name, []);
    if (!loop) continue;
    const lost = loop.find((n) => unplaced.has(n));
    return {
      problem: lost
        ? `the relation that solves "${lost}" reads ${quoted(unplaced.get(lost) ?? [])}, which ` +
          `nothing on the sheet provides — so the order to solve its constrained params in cannot ` +
          `be established`
        : `constrained params depend on each other (${loop.join(' → ')}) — a coupled system, which ` +
          `is not solved; give one of them a value the other does not read`,
    };
  }
  return { order };
}

/** How a DC-input finding names a device: the sheet's own, or a child by block path. */
const deviceName = (d: string): string => (d === 'givens' ? "this sheet's own device" : `"${d}"`);

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
 * document, and a single in-document-order pass over the blocks is that fixed point across the
 * tree, because a block's override may only reference EARLIER siblings' provides.
 *
 * A reachability question, not an evaluation: it says which authored expressions could read
 * something different at the range end, which is all the range-end checks below need. It
 * UNDER-approximates in two known places, both of them on documents that are already errors
 * here: the in-order argument holds because evaluation refuses a forward reference, and a
 * composition nested past MAX_BLOCK_DEPTH is skipped whole. An advisory check that says nothing
 * about a broken document is the right way round — a warning that fires on correct sheets is
 * worth less than no warning at all.
 *
 * Exported for the test that holds it and dcInputs to the same reach; not part of the public
 * API (the package index does not re-export it).
 */
export function reachedGivens(
  doc: SheetDoc,
  moved: readonly string[],
  path: string,
  out: ReachedGivens[],
  depth: number,
): ReadonlySet<string> {
  return movedBy({ doc, path, kids: new Map() }, moved, out, depth);
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
  for (const block of lv.doc.blocks ?? []) {
    if (!block.doc || depth >= MAX_BLOCK_DEPTH) continue;
    const kid = childLevel(lv, block, block.doc);
    const seed = Object.keys(block.params ?? {}).filter((k) =>
      reads(overrideEdge(kid, k, MOVEMENT), reached),
    );
    const inner = movedBy(kid, seed, out, depth + 1);
    // A block publishes two kinds of scalar, and the range end moves them for different reasons.
    // Its equations and params move when the closure above says they do. Its DEVICE quantities —
    // the vgs it settled at, the gm that came out — move whenever anything feeding its sizing
    // moved, whatever the inputs happened to be called; a sibling biased off one of those (`VDD -
    // ref__vgs`) is how the library writes a stack, so stopping at the block boundary would make
    // both checks below silent on the sheets they exist for. The geometry and the authored
    // current are the exceptions (MOVEMENT's `held`): a range end holds W and L fixed by
    // construction, and an authored `id` moves only when its own expression does, which the
    // closure already covers.
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
  // Pushed last, because a block's own givens evaluate after the children it composes.
  if (lv.doc.givens) out.push({ path: blockPath(lv.path), givens: lv.doc.givens, reached });
  return reached;
}

/**
 * What a range end cannot honestly claim about the design it re-measures. A range-end run
 * holds the hardware the base run sized and re-settles the bias; these two warnings mark the
 * places where an authored sheet takes that outside where it holds. Both are advisory: what
 * the author wrote is legal, and which of the reading and the writing is wrong is theirs to
 * decide.
 */
function complianceReach(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  for (const e of doc.operatingRange ?? []) {
    const name = e.name?.trim();
    if (!name) continue; // shape errors are named above; this check needs a usable name
    const allGivens: ReachedGivens[] = [];
    reachedGivens(doc, Object.keys(e.set ?? {}), '', allGivens, 0);
    for (const { path, givens, reached } of allGivens) {
      const readsMoved = (expr: unknown): boolean =>
        typeof expr === 'string' && namesOf(expr).some((n) => reached.has(n));
      const where = path === 'givens' ? "this sheet's own givens" : `the givens at "${path}"`;
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
        const via = Object.keys(givens).filter(
          (k) => k !== 'vds' && readsMoved(givens[k as never]),
        );
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
        const bias = via.filter((k) => k !== 'W' && k !== 'L');
        if (bias.length)
          out.push({
            rule: 'sheet-range',
            severity: 'warning',
            message:
              `range end "${name}" reaches ${where}, which fix a width, through ${quoted(bias)} — ` +
              `width-first givens keep their authored operating-point spec at a range end, which ` +
              `holds the same device only when the end moves vds alone`,
            location: name,
          });
      } else if (readsMoved(givens.id)) {
        // The authored current IS the hardware description at a range end (a mirror ratio, a
        // tail split, a KCL difference), so it is re-evaluated there on purpose. A current that
        // tracks the condition being swept is a different thing wearing that shape: it re-designs
        // the device at the end instead of re-biasing it.
        out.push({
          rule: 'sheet-range',
          severity: 'warning',
          message:
            `range end "${name}" reaches the current expression of ${where} — it ` +
            `re-evaluates that current as the design's own wiring, so a current that tracks the ` +
            `swept condition re-sizes the device there instead of re-biasing it`,
          location: name,
        });
      }
    }
  }
  return out;
}

/** Surface authoring problems as warnings; never throws, never mutates the doc. Structural
 *  and device-independent — identifier resolution against the live values is eval's job.
 *  Recurses into composed children, attributing each child's findings to its block. */
export function validateSheet(doc: SheetDoc, _depth = 0): QAWarning[] {
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
    // A tearing variable that solves for itself is a fixed point trivially, and hides the
    // loop it was meant to close. Only the self-reference is checkable here — whether the
    // target resolves at all depends on the live value set, which is eval's job.
    if (p.solveFor === p.name) {
      out.push({
        rule: 'sheet-param',
        severity: 'error',
        message: `param "${p.name}" solves for itself — name the value it is an estimate of`,
        location: p.name,
      });
    }
  }

  // The architecture allows "small, explicit, designer-named fixed points" and no nodal solver.
  // A sheet tearing many unknowns at once stops being that and becomes relaxation over a node
  // set, so the word "small" is enforced here rather than left as an aspiration.
  const unknowns = doc.params.filter(torn);
  if (unknowns.length > MAX_TORN_PARAMS) {
    out.push({
      rule: 'sheet-param',
      severity: 'error',
      message:
        `${unknowns.length} params carry solveFor (${unknowns.map((p) => p.name).join(', ')}); ` +
        `at most ` +
        `${MAX_TORN_PARAMS} are allowed — a sheet solves a few named bias loops, it is not a ` +
        `circuit solver over a node set`,
      location: 'params',
    });
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
  }

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

  // A diode connection already fixes vds; declaring both means one of them is a fiction, and
  // guessing which the author meant would be worse than saying so.
  //
  // `vgs` alongside a diode connection is a different case and is deliberately LEGAL — do not
  // add a symmetric check. The connection says vds FOLLOWS vgs, collapsing the table onto its
  // vds = vgs diagonal; a given vgs then names the point on that diagonal. The two statements
  // are independent and both hold, exactly as a diode connection plus a given gm/ID already
  // does. It is vds that cannot also be declared, because that one names the same coordinate
  // twice with two different numbers.
  if (doc.givens?.diode && doc.givens.vds !== undefined) {
    out.push({
      rule: 'sheet-givens',
      severity: 'error',
      message:
        'the givens declare both a diode connection and a vds — the connection ties vds to vgs, so a ' +
        'separate vds cannot also hold. Drop one',
      location: 'givens',
    });
  }

  if (_depth === 0) {
    out.push(...dcInputProblems(doc));
    // Tree-wide like the rule above, and for the same reason: a design constraint's relation can
    // read a constrained param of another level. Asked of the sheet as authored and as a
    // fixed-hardware run will see it — two documents, each with its own constraints and givens.
    const problems = new Set<string>();
    for (const plan of [constraintPlan(doc), constraintPlan(doc, { held: true })])
      if ('problem' in plan) problems.add(plan.problem);
    for (const message of problems)
      out.push({ rule: 'sheet-param', severity: 'error', message, location: 'params' });
  }

  // The composition interface, both ways: names read across a block boundary, and names this
  // sheet declares it exposes. Runs for every doc — a leaf with no children still publishes.
  out.push(...provideCoverage(doc));

  // Composition: validate each block and attribute its findings to it.
  if (doc.blocks) {
    // Collision guard: a child exposes scalars into the parent scope as `name__key`. If a
    // parent param or equation is named identically, the child injection silently overwrites it
    // (or the equation shadows the injection) — surface it rather than resolve it by overwrite.
    // A ref-only block's provides are unknown until resolution, so these structural
    // checks cover embedded children only — run validation on the RESOLVED doc (as
    // runSheet does when given a ref index) for full coverage.
    const injected = new Set(doc.blocks.flatMap(providedNames));
    for (const p of doc.params) {
      if (injected.has(p.name)) {
        out.push({
          rule: 'sheet-collision',
          severity: 'warning',
          message: `param "${p.name}" collides with a scalar a block provides — the block's value would silently override it`,
          location: p.name,
        });
      }
    }
    for (const r of doc.equations) {
      if (injected.has(r.name)) {
        out.push({
          rule: 'sheet-collision',
          severity: 'warning',
          message: `equation "${r.name}" collides with a scalar a block provides`,
          location: r.name,
        });
      }
    }

    out.push(...assumptionEstimates(doc));
    out.push(...untiedGates(doc));

    // Children evaluate in document order, and a block's param overrides may reference the
    // provides of EARLIER siblings only. A forward (or self) reference is statically
    // detectable here: the joined name can never be in scope when the override resolves.
    for (let i = 0; i < doc.blocks.length; i++) {
      const block = doc.blocks[i];
      if (!block.params) continue;
      const later = new Set(doc.blocks.slice(i).flatMap(providedNames));
      for (const [k, expr] of Object.entries(block.params)) {
        // The child re-solves a held node wherever the hardware is held, so the value wired in
        // here is honoured at the design point and dropped at a range end — while this sheet
        // goes on reading its own.
        if (block.doc?.params.some((p) => p.name === k && holds(p))) {
          out.push({
            rule: 'sheet-block-param',
            severity: 'warning',
            message: `block "${block.name}" override "${k}" sets a node the child holds under a gate — a range end re-solves it inside the child, and this sheet's own value for it will not follow. Hold the node on this sheet instead`,
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
        if (key.includes(PROVIDE_SEP) && !childInjected.has(key)) {
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
      out.push(...wiringProblems(block));
      if (_depth >= MAX_BLOCK_DEPTH) {
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
        for (const w of validateSheet(block.doc, _depth + 1)) {
          out.push(prefixBlockWarning(block.name, w));
        }
      }
    }
  }

  return out;
}
