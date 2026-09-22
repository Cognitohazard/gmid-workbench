// Structural QA for a leaf sheet, in the qa/validate() shape: init an array, push
// warning literals, skip-not-throw, return the bare array. It checks what evaluation
// cannot conveniently express — bind arity, finite params, equality tolerance, kind/op
// sanity, and a param shadowing a device quantity. It also owns the table-independent
// half of name resolution: whether a `block__key` reference names a scalar that block
// actually publishes, and whether a name a sheet claims to publish exists at all. Those
// answers need no device table, so they are structural. Resolving identifiers against
// the live value set stays evaluateSheet's job. DOM-free.

import type { QAWarning } from '../types';
import { compileExpr, metaScalars } from '../derive';
import { BINDABLE, bindProblem } from '../device';
import { PINNED_AT_A_RANGE_END } from './coverage';
import {
  BIAS_AXES,
  EDGE_SEP,
  PATH_SEP,
  blockPath,
  idSepProblem,
  MAX_TORN_PARAMS,
  MAX_USE_DEPTH,
  docExpressions,
  engineSolved,
  pinned,
  torn,
  pinProblem,
  PROVIDE_SEP,
  RULE_KINDS,
  RULE_OPS,
  WIRING_KEYS,
  joinProvide,
  providedNames,
  prefixUseWarning,
  type SheetDoc,
  type SheetUse,
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
 *  absolute difference — which is what separates it from a headroom guardrail like
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
 * Quantities a bias stand-in can be a stand-in FOR: the LEVEL a device sits at. A margin
 * quantity like vdsat is not one, and letting it count made a legitimately declared bias paired
 * with a symmetric headroom check — `abs(v_bias - dev__vdsat) <= 0.15`, which the format docs
 * recommend — read as a hand-tuned estimate.
 *
 * Hand-maintained, which the BIND_KEYS comment warns against for good reason. It stays a list
 * because nothing in the namespace distinguishes a level from a margin; deriving it needs a new
 * flag on BASE_QUANTITIES. Tolerable only because the blast radius is one advisory warning.
 */
const STANDIN_TARGETS: readonly string[] = ['vgs', 'vth'];

/**
 * A param that BIASES a child block while a rule asserts that same param EQUALS the child's own
 * operating point is a hand-tuned stand-in: the author guessed a value, biased the device with the
 * guess, and added a guardrail telling themselves to retune until the guess agrees. It works, and
 * it silently makes every number downstream depend on how carefully somebody re-typed a voltage.
 *
 * Detected structurally, never by name: for each bias axis a child binds, take the free names of
 * the expression feeding it, keep the ones that are parent params, and look for a rule that puts
 * one of those params and something the same child provides inside a single absolute difference.
 * The absolute difference is the discriminator — it is the sheet asserting the two are the same
 * number. A guardrail that merely mentions both (headroom against a node voltage) is not a round
 * trip and must not be flagged.
 *
 * The message names the fix, which depends on where the stand-in is used:
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
function standInEstimates(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const paramNames = new Set(doc.params.map((p) => p.name));
  const ruleNames = doc.rules.map((r) => ({
    id: r.id,
    absArgs: [...absArgNames(r.lhs), ...absArgNames(r.rhs)],
  }));

  for (const use of doc.uses ?? []) {
    const bind = use.doc?.bind;
    if (!bind) continue;
    const provided = new Set(providedNames(use));
    for (const axis of BIAS_AXES) {
      // BIAS_AXES is namespace-derived; SheetBind's bias fields are static keys. Index
      // structurally, as eval does, rather than by the literal key union.
      const childParam = (bind as unknown as Partial<Record<string, string>>)[axis];
      const expr = childParam === undefined ? undefined : use.params?.[childParam];
      if (expr === undefined) continue;
      const exprNames = namesOf(expr);
      const standIns = exprNames.filter((n) => paramNames.has(n));
      if (standIns.length === 0) continue;
      // Both sides of the round trip must sit inside ONE absolute difference — the sheet
      // asserting they are the same number, not a guardrail that happens to mention both.
      const levels = STANDIN_TARGETS.map((q) => joinProvide(use.name, q)).filter((q) =>
        provided.has(q),
      );

      for (const r of ruleNames) {
        const pair = r.absArgs.find(
          (a) => standIns.some((n) => a.has(n)) && levels.some((q) => a.has(q)),
        );
        if (!pair) continue;
        const tiedTo = levels.filter((q) => pair.has(q));
        const hit = standIns.find((n) => pair.has(n)) as string;
        // Diode-connected requires ALL of: the bias IS the stand-in — the bare identifier, not
        // an expression over it (`2*vgs_est` or `vgs_est - 0.1` states the drop is NOT the vgs,
        // and "bind the diode" would change that design) — and the rule compares exactly those
        // two quantities. A stack's KVL check — `abs((CM - in__vgs) + vds_a + vds_b - V_out)` —
        // also puts the two inside one abs, but it sums a loop of node drops, not an identity.
        const sole = expr.trim() === hit;
        const pairwise = pair.size === 2;
        const diode =
          axis === 'vds' && sole && pairwise && tiedTo.includes(joinProvide(use.name, 'vgs'));
        const fix = diode
          ? `"${use.name}" is diode-connected — its vds IS its vgs, so bind the connection instead of estimating it`
          : axis === 'vsb'
            ? `the source of "${use.name}" sits above the bulk — parameterize by that node voltage and both of its bias coordinates follow directly`
            : `this reads as a node voltage written as an estimated difference — declare the node voltages and let ${axis} be a subtraction`;
        out.push({
          rule: 'sheet-standin',
          severity: 'warning',
          message:
            `param "${hit}" biases block "${use.name}" (${axis}) while rule "${r.id}" ties it back ` +
            `to that block's own ${tiedTo.join(', ')} — a hand-tuned stand-in for the operating ` +
            `point it is meant to produce. ${fix}`,
          location: use.name,
          symbol: hit,
        });
        break; // one finding per axis; the first rule that closes the loop names it
      }
    }
  }
  return out;
}

/**
 * Structural checks on a use's declared gate wiring — the ONLY route by which a wiring
 * declaration reaches a verdict. What the check finds at RUNTIME (an expression that will not
 * resolve, a disagreement past the tolerance) stays a warning: the declaration and the sizing
 * are two descriptions of one node, and picking a winner between them is the author's call, not
 * QA's. But a declaration that is not a declaration — half-written, misspelled, unparseable —
 * states no identity at all, and a sheet reported as wiring-checked when nothing was checked is
 * precisely the silence this mechanism exists to break.
 */
function wiringProblems(use: SheetUse): QAWarning[] {
  // `unknown`, not SheetWiring: a persisted document arrives unverified, so the shape is what
  // is being checked here rather than what may be assumed.
  const w: unknown = use.wiring;
  if (w === undefined) return [];
  const out: QAWarning[] = [];
  const bad = (message: string): void => {
    out.push({
      rule: 'sheet-wiring',
      severity: 'error',
      message: `use "${use.name}": ${message}`,
      location: use.name,
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
 * that identity down and left the engine free to break it: each bind settles wherever its own
 * target lands, and the two agree only while both read the same table at the same bias. Read
 * the design at another condition and the gates drift apart with every rule still green.
 *
 * What makes them agree is binding one device's `vgs` to the other's — `{ W: "K*ref__W", vgs:
 * "ref__vgs" }` — which states the shared wire AS the sizing instead of beside it. So the
 * question here is whether each block on one (gate, source) pair is sized on a vgs that names
 * ANOTHER BLOCK ON THAT SAME PAIR. A bound vgs alone is not enough: `vgs: "0.7"` is a typed
 * number, and a vgs read off a block somewhere else on the schematic is a different claim; both
 * would silence the finding while coupling nothing. One block must be left over — something has
 * to settle the voltage the rest follow — so the finding is raised when TWO or more are not
 * tied to a peer, and it names those.
 *
 * The reference can be written in either of the two places an author can put it: directly in
 * the child's own bind, or as a child param the parent overrides at the use site (the usual
 * shape, since only the parent knows what its children are wired to). Both are read.
 *
 * Scope worth knowing: `wiring` is declared on a USE, so this compares child to child. A sheet
 * whose gate-tied pair is its OWN bind plus one child — which is how the library's mirrors are
 * written — declares no gate node for the parent device and is out of this rule's reach. Giving
 * the parent bind a node declaration is a schema change, not a check.
 *
 * Both halves of the pair are required, and the source half is what keeps the check honest. A
 * complementary pair driven by one input (the library's CMOS inverter stage) shares a gate and
 * sits on different rails, so its two gate-source voltages are genuinely different numbers; so
 * does a Widlar source, whose whole design equation is the difference between them. Matching on
 * the gate alone would report both as defects.
 *
 * A declaration is never allowed to DRIVE the bind, only to be checked against it. Re-sizing a
 * device from its wiring would replace a coupling the author can see with one they cannot,
 * which is the silence this mechanism exists to break — so this reports and repairs nothing.
 *
 * Nodes are matched on the expression TEXT, not on a value: a declaration names a node, and two
 * blocks on one wire are written the same way. A node spelled two different ways is missed
 * rather than misreported — the right direction for an advisory, the same trade reachedBinds
 * makes.
 */
function untiedGates(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const groups = new Map<string, { gate: string; source: string; uses: SheetUse[] }>();
  for (const use of doc.uses ?? []) {
    // `unknown`, as in wiringProblems: a persisted document arrives unverified. A half-written
    // or unparseable declaration names no node pair, and wiringProblems already reports it.
    const w = use.wiring as unknown as Record<string, unknown> | undefined;
    if (!w || typeof w.gate !== 'string' || typeof w.source !== 'string') continue;
    if (!w.gate.trim() || !w.source.trim()) continue;
    const key = `${nodeKey(w.gate)}\u0000${nodeKey(w.source)}`;
    const group = groups.get(key) ?? { gate: w.gate.trim(), source: w.source.trim(), uses: [] };
    group.uses.push(use);
    groups.set(key, group);
  }
  for (const { gate, source, uses } of groups.values()) {
    // A block with no embedded doc has an unknown bind (a ref resolves later; runSheet
    // revalidates the resolved doc), and one with no bind sizes no device. Neither can be ruled
    // on, so drop it and rule on the rest — dropping the whole GROUP instead would let one
    // unresolved sibling hide a real pair beside it.
    const sized = uses.filter((u) => u.doc?.bind);
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
        `same table at the same bias. Bind one block's vgs to another's (\`"vgs": ` +
        `"<block>__vgs"\`, with that block providing vgs) to make the shared wire the sizing`,
      location: untied[0].name,
    });
  }
  return out;
}

/** Whether `use` is sized on a gate voltage that names one of its `peers` — the reference read
 *  from the child's own bind and, when that bind names a child param, from the parent's override
 *  of it, which is where the cross-block name normally lives. */
function tiedToPeer(use: SheetUse, peers: readonly SheetUse[]): boolean {
  const expr = use.doc?.bind?.vgs;
  if (expr === undefined) return false;
  const override = use.params?.[expr.trim()];
  const names = [...namesOf(expr), ...(override === undefined ? [] : namesOf(override))];
  return peers.some((p) => p !== use && names.includes(joinProvide(p.name, 'vgs')));
}

/** Scalars every evaluation seeds from the table's metadata, bind or no bind — so a sheet may
 *  name one in `provide` without declaring it. Read off metaScalars itself rather than listed
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
 * Upward (what this sheet reads): a child exposes NOTHING except what its `provide` names —
 * evaluation publishes exactly that list and silently skips the rest — so an undeclared
 * `block__key` resolves to no value, the row using it is dropped with a warning, and any hard
 * rule downstream goes `na`. That degradation is correct for absent DATA and looks identical
 * from the outside, which is why the authoring slip is named here instead. A prefix naming no
 * block at all (a typo'd use name) degrades the same way, so it gets its own message rather
 * than hiding in the same blind spot.
 *
 * Downward (what this sheet publishes): a `provide` entry matching no param and no row exposes
 * nothing, silently. For a leaf nobody composes yet there is no downstream reader to notice, so
 * the declared interface would rot unread. Two carve-outs, both because this check must stay
 * table-independent enough to run at edit time with no data loaded:
 *  - a sheet that BINDS is exempt outright. Sizing publishes the whole table at the operating
 *    point, pass-through columns included, and no static list can enumerate those. The upward
 *    half still catches a parent consuming a name the child never provides, which is where a
 *    real slip shows up.
 *  - re-export keys (which carry the separator) are left to `sheet-provide`, which rules on
 *    them from the use site.
 *
 * Only the CURRENT doc is inspected — validateSheet recurses into embedded children and
 * re-attributes their findings to the use site, so walking the tree here would report
 * everything twice. A ref-only use is skipped: its provide list arrives at resolution, and
 * runSheet revalidates the resolved doc.
 */
function provideCoverage(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const uses = new Map((doc.uses ?? []).map((u) => [u.name, u]));
  const injected = new Set((doc.uses ?? []).flatMap(providedNames));

  const reported = new Set<string>();
  for (const expr of docExpressions(doc)) {
    for (const name of namesOf(expr)) {
      const at = name.indexOf(PROVIDE_SEP);
      if (at <= 0 || injected.has(name) || reported.has(name)) continue;
      const block = name.slice(0, at);
      const use = uses.get(block);
      if (use && !use.doc) continue; // ref-only: its provides are unknown until resolution
      reported.add(name);
      out.push({
        rule: 'sheet-provide-coverage',
        severity: 'warning',
        message: use
          ? `an expression reads "${name}", which block "${block}" does not provide — a block ` +
            `exposes only the scalars its provide list names, so this resolves to no value`
          : `an expression reads "${name}", but no child block is named "${block}" — the name ` +
            `resolves to no value`,
        location: block,
        symbol: name,
      });
    }
  }

  // A sheet that sizes a device publishes the whole table at the operating point, which no
  // static list can enumerate — so the downward half does not run for it.
  if (doc.bind) return out;

  const own = new Set<string>([...doc.params.map((p) => p.name), ...doc.rows.map((r) => r.name)]);
  for (const key of doc.provide ?? []) {
    // A separator-bearing key is the re-export idiom, and `sheet-provide` already rules on
    // whether it names a real grandchild — from the USE site, so a child's bad re-export is
    // reported once there rather than twice.
    if (key.includes(PROVIDE_SEP)) continue;
    if (own.has(key) || META_PUBLISHED.has(key)) continue;
    out.push({
      rule: 'sheet-provide-coverage',
      severity: 'warning',
      message:
        `provide lists "${key}", which is no param and no row of this sheet — nothing of that ` +
        `name exists to expose to a parent`,
      location: key,
    });
  }
  return out;
}

/** The names an engine-solved param's own defining relation reads: a pinned param depends on
 *  both sides of its relation, a torn one on the name it solves for. */
function solvedDeps(p: SheetVar): readonly string[] {
  if (pinned(p)) return [...namesOf(p.pin.lhs), ...namesOf(p.pin.rhs)];
  return torn(p) ? [p.solveFor] : [];
}

/** A list of bind keys as a warning spells them. */
const quoted = (ks: string[]): string => ks.map((k) => `"${k}"`).join(', ');

/** One bind of a tree, with the names an edge's overrides can reach at the point that bind is
 *  evaluated. `path` spells the block the way warnings spell it: `bind` for the sheet's own
 *  device, the use path for anything below. */
interface ReachedBind {
  path: string;
  bind: NonNullable<SheetDoc['bind']>;
  reached: ReadonlySet<string>;
}

/**
 * Every bind in the tree paired with the names one edge MOVES at it — the params the edge sets,
 * plus everything the sheet derives from them: rows reading one, engine-solved params whose
 * defining relation reads one (a pinned node voltage is the case that matters — every containment
 * edge in the library moves one), child params a use overrides from a moved expression, and the
 * provides of a child whose own value moved. Closed to a fixed point within each document, and a
 * single in-document-order pass over the uses is that fixed point across the tree, because a use
 * override may only reference EARLIER siblings' provides.
 *
 * A reachability question, not an evaluation: it says which authored expressions could read
 * something different at the range end, which is all the coverage checks below need. It
 * UNDER-approximates in two known places, both of them on documents that are already errors
 * here: the in-order argument holds because evaluation refuses a forward reference, and a
 * composition nested past MAX_USE_DEPTH is skipped whole. An advisory check that says nothing
 * about a broken document is the right way round — a warning that fires on correct sheets is
 * worth less than no warning at all.
 */
function reachedBinds(
  doc: SheetDoc,
  moved: readonly string[],
  path: string,
  out: ReachedBind[],
  depth: number,
): ReadonlySet<string> {
  const reached = new Set(moved);
  const sources: readonly (readonly [string, readonly string[]])[] = [
    ...doc.rows.map((r) => [r.name, namesOf(r.expr)] as const),
    ...doc.params.filter(engineSolved).map((p) => [p.name, solvedDeps(p)] as const),
  ];
  const close = (): void => {
    for (let grew = true; grew;) {
      grew = false;
      for (const [name, deps] of sources) {
        if (!reached.has(name) && deps.some((n) => reached.has(n))) {
          reached.add(name);
          grew = true;
        }
      }
    }
  };
  close();
  for (const use of doc.uses ?? []) {
    if (!use.doc || depth >= MAX_USE_DEPTH) continue;
    const seed = Object.entries(use.params ?? {})
      .filter(([, e]) => typeof e === 'string' && namesOf(e).some((n) => reached.has(n)))
      .map(([k]) => k);
    const inner = reachedBinds(use.doc, seed, `${path}${use.name}${PATH_SEP}`, out, depth + 1);
    // A block publishes two kinds of scalar, and the range end moves them for different reasons.
    // Its rows and params move when the closure above says they do. Its DEVICE quantities — the
    // vgs it settled at, the gm that came out — move whenever anything feeding its sizing moved,
    // whatever the inputs happened to be called; a sibling biased off one of those (`VDD -
    // ref__vgs`) is how the library writes a stack, so stopping at the block boundary would make
    // both checks below silent on the sheets they exist for. The geometry and the authored
    // current are the exceptions: a range end holds W and L fixed by construction, and an
    // authored `id` moves only when its own expression does, which the closure already covers.
    const inputs = use.doc.bind;
    const sizingMoved =
      inputs !== undefined &&
      Object.values(inputs).some(
        (v) => typeof v === 'string' && namesOf(v).some((n) => inner.has(n)),
      );
    for (const key of use.doc.provide ?? [])
      if (inner.has(key) || (sizingMoved && !PINNED_AT_A_RANGE_END.has(key)))
        reached.add(joinProvide(use.name, key));
    close();
  }
  // Pushed last, because a block's own bind evaluates after the children it composes.
  if (doc.bind) out.push({ path: blockPath(path), bind: doc.bind, reached });
  return reached;
}

/**
 * What a containment edge cannot honestly claim about the design it re-measures. A coverage run
 * holds the hardware the base run sized and re-settles the bias; these two warnings mark the
 * places where an authored sheet takes that outside where it holds. Both are advisory: what
 * the author wrote is legal, and which of the reading and the writing is wrong is theirs to
 * decide.
 */
function coverageReach(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  for (const e of doc.edges ?? []) {
    const name = e.name?.trim();
    if (!name) continue; // shape errors are named above; this check needs a usable name
    const binds: ReachedBind[] = [];
    reachedBinds(doc, Object.keys(e.set ?? {}), '', binds, 0);
    for (const { path, bind, reached } of binds) {
      const readsMoved = (expr: unknown): boolean =>
        typeof expr === 'string' && namesOf(expr).some((n) => reached.has(n));
      const where = path === 'bind' ? "this sheet's own bind" : `the bind at "${path}"`;
      if (bind.W !== undefined) {
        // A width-first bind is left exactly as authored at a range end, which makes two
        // different things possible, and an author sent to the wrong one of them looks in the
        // wrong place. If the GEOMETRY moves, the range end is not holding the design at all —
        // it is a different transistor, and the report's claim is simply untrue. If the bias
        // reach is elsewhere, the transistor is right and its operating point is the question:
        // the authored spec still sets it there, which reproduces a gate tie only while vds is
        // the one thing that moved; naming the reach is all the engine can honestly do.
        //
        // Hence `vds` is excluded here unconditionally — a drain-only reach never warns. Holding a
        // gm/ID across a drain move is exact on the demo model and close on measured data (see the
        // width-first case in pinHardware), close enough that warning on every range claim in the
        // library would say nothing an author could act on.
        const via = Object.keys(bind).filter((k) => k !== 'vds' && readsMoved(bind[k as never]));
        const geometry = via.filter((k) => k === 'W' || k === 'L');
        if (geometry.length)
          out.push({
            rule: 'sheet-edge',
            severity: 'warning',
            message:
              `edge "${name}" moves the ${quoted(geometry)} of ${where} — the range end sizes a ` +
              `DIFFERENT transistor there, so what it reports is not this design measured at ` +
              `another condition`,
            location: name,
          });
        const bias = via.filter((k) => k !== 'W' && k !== 'L');
        if (bias.length)
          out.push({
            rule: 'sheet-edge',
            severity: 'warning',
            message:
              `edge "${name}" reaches ${where}, which fixes a width, through ${quoted(bias)} — a ` +
              `width-first bind keeps its authored operating-point spec at a range end, which ` +
              `holds the same device only when the end moves vds alone`,
            location: name,
          });
      } else if (readsMoved(bind.id)) {
        // The authored current IS the hardware description at a range end (a mirror ratio, a
        // tail split, a KCL difference), so it is re-evaluated there on purpose. A current that
        // tracks the condition being swept is a different thing wearing that shape: it re-designs
        // the device at the end instead of re-biasing it.
        out.push({
          rule: 'sheet-edge',
          severity: 'warning',
          message:
            `edge "${name}" reaches the current expression of ${where} — a range end ` +
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
 *  Recurses into composed children, attributing each child's findings to its use site. */
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

  // Pinned params: one home for the structural checks (pinProblem), so evaluation fails closed
  // on the SAME words this raises as an error — the bindProblem discipline. This also catches a
  // half-written pin ({lhs} only), which the pinned() shape guard rejects and which would
  // otherwise freeze the param: neither swept nor solved, with the sheet still reading feasible.
  const pinIssue = pinProblem(doc.params);
  if (pinIssue) {
    out.push({
      rule: 'sheet-param',
      severity: 'error',
      message: pinIssue,
      location: 'params',
    });
  }

  if (doc.bind) {
    const problem = bindProblem(BINDABLE.filter((k) => doc.bind?.[k] !== undefined));
    if (problem) {
      out.push({
        rule: 'sheet-bind',
        severity: 'error',
        message: `bind ${problem}`,
        location: 'bind',
      });
    }
  }

  // Duplicate rule ids collapse silently downstream: indexTreeResults keys results by id, so
  // the sweep charts one curve where two rules exist and bindingConstraint can name the WRONG
  // worst rule. (A child reusing a parent's id is fine — paths disambiguate across levels.)
  const ruleIds = new Set<string>();
  for (const r of doc.rules) {
    if (ruleIds.has(r.id)) {
      out.push({
        rule: 'sheet-rule',
        severity: 'error',
        message: `duplicate rule id "${r.id}" — results are keyed by id, so one of them would silently shadow the other in sweeps and the binding-constraint badge`,
        location: r.id,
      });
    }
    ruleIds.add(r.id);
  }

  for (const r of doc.rules) {
    // Reserved so a tree-keyed id (`cs.headroom`, `cm-lo@rule`) can never collide with an
    // authored one — the same silent-shadowing hazard the duplicate-id check above exists for.
    const idSep = idSepProblem(r.id);
    if (idSep) {
      out.push({
        rule: 'sheet-rule',
        severity: 'error',
        message: `rule id "${r.id}" contains "${idSep}" — reserved for tree-keyed rule ids (use paths like cs${PATH_SEP}headroom, edge-qualified ids like cm-lo${EDGE_SEP}rule)`,
        location: r.id,
      });
    }
    if (!RULE_KINDS.has(r.kind)) {
      out.push({
        rule: 'sheet-rule',
        severity: 'warning',
        message: `rule "${r.id}" has unknown kind "${r.kind}"`,
        location: r.id,
      });
    }
    if (!RULE_OPS.has(r.op)) {
      out.push({
        rule: 'sheet-rule',
        severity: 'warning',
        message: `rule "${r.id}" has unknown operator "${r.op}"`,
        location: r.id,
      });
    }
    if (r.op === '==' && r.tolPct === undefined) {
      out.push({
        rule: 'sheet-tol',
        severity: 'warning',
        message: `equality rule "${r.id}" has no tolPct (will require an exact match)`,
        location: r.id,
      });
    }
    // A non-finite tolPct poisons the '==' margin arithmetic into NaN; eval degrades that
    // to `na` (fail-closed), but the authoring mistake should be named at the source.
    if (r.tolPct !== undefined && (!Number.isFinite(r.tolPct) || r.tolPct < 0)) {
      out.push({
        rule: 'sheet-tol',
        severity: 'error',
        message: `rule "${r.id}" tolPct must be a finite number >= 0, got ${r.tolPct}`,
        location: r.id,
      });
    }
  }

  // Containment edges: structural checks only — whether the overridden evaluation closes
  // is eval's verdict, not a shape question.
  if (doc.edges?.length) {
    const edgeNames = new Set<string>();
    const paramByName = new Map(doc.params.map((p) => [p.name, p]));
    for (const e of doc.edges) {
      const name = e.name?.trim();
      if (!name) {
        out.push({
          rule: 'sheet-edge',
          severity: 'error',
          message: 'an edge has an empty name',
          location: 'edges',
        });
        continue;
      }
      if (edgeNames.has(name)) {
        out.push({
          rule: 'sheet-edge',
          severity: 'error',
          message: `duplicate edge name "${name}" — edge results are keyed by name`,
          location: name,
        });
      }
      edgeNames.add(name);
      const sep = idSepProblem(name);
      if (sep) {
        out.push({
          rule: 'sheet-edge',
          severity: 'error',
          message: `edge name "${name}" must not contain "${sep}" — it becomes part of tree-keyed rule ids`,
          location: name,
        });
      }
      const entries = Object.entries(e.set ?? {});
      if (entries.length === 0) {
        out.push({
          rule: 'sheet-edge',
          severity: 'error',
          message: `edge "${name}" sets nothing — name at least one param to override`,
          location: name,
        });
      }
      for (const [k, expr] of entries) {
        const p = paramByName.get(k);
        if (!p) {
          out.push({
            rule: 'sheet-edge',
            severity: 'error',
            message: `edge "${name}" sets "${k}", which is not a param of this sheet`,
            location: name,
          });
        } else if (engineSolved(p)) {
          out.push({
            rule: 'sheet-edge',
            severity: 'error',
            message: `edge "${name}" sets "${k}", which the engine solves — the override would be discarded by the solve`,
            location: name,
          });
        }
        if (typeof expr !== 'string' || !parses(expr)) {
          out.push({
            rule: 'sheet-edge',
            severity: 'error',
            message: `edge "${name}": the expression for "${k}" does not parse`,
            location: name,
          });
        }
      }
    }
    out.push(...coverageReach(doc));
  }

  // A diode connection already fixes vds; declaring both means one of them is a fiction, and
  // guessing which the author meant would be worse than saying so.
  //
  // `vgs` alongside a diode connection is a different case and is deliberately LEGAL — do not
  // add a symmetric check. The connection says vds FOLLOWS vgs, collapsing the table onto its
  // vds = vgs diagonal; a bound vgs then names the point on that diagonal. The two statements
  // are independent and both hold, exactly as a diode connection plus a bound gm/ID already
  // does. It is vds that cannot also be declared, because that one names the same coordinate
  // twice with two different numbers.
  if (doc.bind?.diode && doc.bind.vds !== undefined) {
    out.push({
      rule: 'sheet-bind',
      severity: 'error',
      message:
        'bind declares both a diode connection and a vds — the connection ties vds to vgs, so a ' +
        'separate vds cannot also hold. Drop one',
      location: 'bind',
    });
  }

  // The composition interface, both ways: names read across a block boundary, and names this
  // sheet declares it exposes. Runs for every doc — a leaf with no children still publishes.
  out.push(...provideCoverage(doc));

  // Composition: validate each child block and attribute its findings to the use site.
  if (doc.uses) {
    // Collision guard: a child exposes scalars into the parent scope as `name__key`. If a
    // parent param or row is named identically, the child injection silently overwrites it
    // (or the row shadows the injection) — surface it rather than resolve it by overwrite.
    // A ref-only use's provides are unknown until resolution, so these structural
    // checks cover embedded children only — run validation on the RESOLVED doc (as
    // runSheet does when given a ref index) for full coverage.
    const injected = new Set(doc.uses.flatMap(providedNames));
    for (const p of doc.params) {
      if (injected.has(p.name)) {
        out.push({
          rule: 'sheet-collision',
          severity: 'warning',
          message: `param "${p.name}" collides with a scalar a child block provides — the child's value would silently override it`,
          location: p.name,
        });
      }
    }
    for (const r of doc.rows) {
      if (injected.has(r.name)) {
        out.push({
          rule: 'sheet-collision',
          severity: 'warning',
          message: `row "${r.name}" collides with a scalar a child block provides`,
          location: r.name,
        });
      }
    }

    out.push(...standInEstimates(doc));
    out.push(...untiedGates(doc));

    // Children evaluate in document order, and a use's param overrides may reference the
    // provides of EARLIER siblings only. A forward (or self) reference is statically
    // detectable here: the joined name can never be in scope when the override resolves.
    for (let i = 0; i < doc.uses.length; i++) {
      const use = doc.uses[i];
      if (!use.params) continue;
      const later = new Set(doc.uses.slice(i).flatMap(providedNames));
      for (const [k, expr] of Object.entries(use.params)) {
        for (const n of namesOf(expr)) {
          if (later.has(n)) {
            out.push({
              rule: 'sheet-use-param',
              severity: 'warning',
              message: `use "${use.name}" override "${k}" references "${n}", which is provided by this or a LATER sibling — children evaluate in document order, so it will not resolve`,
              location: use.name,
            });
          }
        }
      }
    }

    const seen = new Set<string>();
    for (const use of doc.uses) {
      // Exactly one content source: an embedded doc, or a non-blank ref to resolve. A
      // use with neither can never evaluate; a blank ref can never match a library id.
      if (!use.doc && use.ref === undefined) {
        out.push({
          rule: 'sheet-use',
          severity: 'error',
          message: `use "${use.name}" has neither an embedded doc nor a ref`,
          location: use.name,
        });
      }
      if (use.ref !== undefined && !use.ref.trim()) {
        out.push({
          rule: 'sheet-ref',
          severity: 'error',
          message: `use "${use.name}" has an empty ref`,
          location: use.name,
        });
      }
      const name = use.name?.trim();
      if (!name) {
        out.push({
          rule: 'sheet-use',
          severity: 'error',
          message: 'a use has an empty name',
          location: 'uses',
        });
      } else {
        if (seen.has(name)) {
          out.push({
            rule: 'sheet-use',
            severity: 'error',
            message: `duplicate use name "${name}"`,
            location: name,
          });
        }
        seen.add(name);
        if (name.includes(PROVIDE_SEP)) {
          out.push({
            rule: 'sheet-use',
            severity: 'error',
            message: `use name "${name}" must not contain "${PROVIDE_SEP}" (the provide separator)`,
            location: name,
          });
        }
        const useSep = idSepProblem(name);
        if (useSep) {
          out.push({
            rule: 'sheet-use',
            severity: 'error',
            message: `use name "${name}" must not contain "${useSep}" — it becomes part of tree-keyed rule ids`,
            location: name,
          });
        }
      }
      // A provide key normally must not contain the separator — EXCEPT when it names a
      // scalar the child itself received from ITS children (`grand__key`): re-exporting a
      // grandchild value up the tree is the ratified idiom for surfacing a deep quantity,
      // so only a separator-bearing key that matches nothing injectable is flagged.
      const childInjected = new Set((use.doc?.uses ?? []).flatMap(providedNames));
      for (const key of use.doc?.provide ?? []) {
        if (key.includes(PROVIDE_SEP) && !childInjected.has(key)) {
          out.push({
            rule: 'sheet-provide',
            severity: 'warning',
            message: `provided name "${key}" in use "${use.name}" must not contain "${PROVIDE_SEP}" (unless re-exporting a child's provide)`,
            location: use.name,
          });
        }
      }
      // Override keys can only be checked against a KNOWN child param list — for a
      // ref-only use that list arrives at resolution, and revalidating the resolved
      // doc (runSheet's path) performs this same check with the doc filled in.
      if (use.params && use.doc) {
        const childParams = new Set(use.doc.params.map((p) => p.name));
        for (const k of Object.keys(use.params)) {
          // An error, not advice: the value the parent wired will never reach the child,
          // which then sizes on its embedded default — eval fails this closed too.
          if (!childParams.has(k)) {
            out.push({
              rule: 'sheet-use-param',
              severity: 'error',
              message: `use "${use.name}" overrides "${k}", which is not a param of the child`,
              location: use.name,
            });
          }
        }
      }
      out.push(...wiringProblems(use));
      if (_depth >= MAX_USE_DEPTH) {
        out.push({
          rule: 'sheet-use',
          severity: 'error',
          message: `use "${use.name}": composition nested deeper than ${MAX_USE_DEPTH}`,
          location: use.name,
        });
        continue;
      }
      if (use.doc) {
        // Edges are a top-of-tree feature: in composition the parent typically drives the
        // child's spec params, which would make the child's own range claim a fiction —
        // so the engine ignores them, and this says so rather than letting the author
        // believe the child's containment still gates.
        if (use.doc.edges?.length) {
          out.push({
            rule: 'sheet-edge',
            severity: 'warning',
            message: `use "${use.name}": the composed child declares containment edges — they are not evaluated in composition; re-declare the claim on the parent if it should gate here`,
            location: use.name,
          });
        }
        for (const w of validateSheet(use.doc, _depth + 1)) {
          out.push(prefixUseWarning(use.name, w));
        }
      }
    }
  }

  return out;
}
