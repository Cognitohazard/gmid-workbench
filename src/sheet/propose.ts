// The wiring proposal: a draft of the `nodes`, `levels` and `ports` a sheet written without wiring
// would carry, read from what its givens, overrides and holds already say. It is a draft for an
// author to confirm, never something the engine adopts: only a diode connection is CERTAIN (the
// earlier format's `diode: true` asserted a physical connection); everything else is INFERRED — a
// shared gate-source voltage, a body left at the source's level, two terminals written at the same
// level — or UNKNOWN, a wire inside a stack nothing names, given a fresh name. The same level is
// not the same wire, so an inferred join is a proposal to check, not a fact. A wire the draft
// leaves with one terminal is held where the draft knows its level, and made a port otherwise, so
// the copy is a netlist validation reads.
//
// Callable from a script: proposeWiring reads a document, applyWiringProposal writes the draft
// into a format-version-2 copy, and formatWiringProposal prints it for an author to read. Pure;
// zero DOM.

import { levelEligibility, spelled } from './validate';
import { currentInto, placementsOf, unionFind } from './nodes';
import {
  DEVICE_NAMES,
  EARLIER_BLOCK_KEYS,
  FORMAT_VERSION,
  GROUND,
  IDENTIFIER,
  PATH_SEP,
  PROVIDE_SEP,
  TERMINALS,
  blockOverride,
  childPath,
  cloneDoc,
  deviceName,
  heldGateOf,
  holds,
  isObject,
  joinProvide,
  namesOf,
  splitProvide,
  type DeviceNodes,
  type SheetBlock,
  type SheetDoc,
  type SheetGivens,
} from './types';
import {
  atomPoly,
  canon,
  constantOf,
  normalizeSrc,
  parseExpr,
  selectorRoot,
  type Poly,
} from './linear';

/** How sure the draft is of one terminal's wire. */
export type WireMark = 'certain' | 'inferred' | 'unknown';

/** One terminal's drafted wire, how sure the draft is, and why. */
export interface TerminalDraft {
  wire: string;
  mark: WireMark;
  why: string[];
}

/** One sized device's drafted nodes. `device` is `givens` for a sheet's own device, else the block
 *  name; `at` is the block path of the sheet that will carry them (`''` for the top): a sheet's own
 *  device is wired by that sheet's `nodes`, a child's by the block that composes it. */
export interface DeviceDraft {
  device: string;
  at: string;
  nodes: Record<'d' | 'g' | 's' | 'b', TerminalDraft>;
}

/** One drafted `levels` entry: a wire the sheet at `at` holds, and why it may be held. */
export interface LevelDraft {
  at: string;
  wire: string;
  expr: string;
  held: 'held' | 'held-gate';
  why: string;
}

/** One drafted port: a wire of the sheet at `at` its parent or the application connects. */
export interface PortDraft {
  at: string;
  wire: string;
  why: string;
}

export interface WiringProposal {
  title: string;
  devices: DeviceDraft[];
  levels: LevelDraft[];
  ports: PortDraft[];
  /** Params that multiply a whole bias axis of a p device and look like the table's axis direction:
   *  candidates for `convention: "axis-sign"`, by block path. */
  selectors: { at: string; param: string }[];
  notes: string[];
}

type Slot = string; // `${device}.${terminal}`

/** A level a terminal is drafted at, as the expression it was written in and its canonical form. */
interface Level {
  key: string;
  text: string;
  why: string;
  /** A level derived for matching only (a gate one vgs from its source): never names a wire. */
  derived?: boolean;
}

/** One device the sheet being drafted wires: its own, or a child that sizes one and composes none. */
interface DraftDevice {
  name: string;
  givens: SheetGivens;
  /** Absent where the document declares none: drafted as n, which validation records. */
  polarity?: 'n' | 'p';
  block?: SheetBlock;
}

/** A single vds the draft reads as a level: a bare name or a number. */
const SINGLE = /^(?:[A-Za-z_][A-Za-z0-9_]*|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;

/** A name that reads as a sign parameter — a guess the draft labels as one, for the author. */
const SIGN_NAME = /(^|_)sign(_|$)/i;

const isBareParam = (text: string, doc: SheetDoc): boolean =>
  IDENTIFIER.test(text.trim()) && doc.params.some((p) => p.name === text.trim());

/** A wire name drafted from the param a level is written as: lower case, a leading `v_` dropped. */
function wireFromParam(name: string): string {
  const lower = name.toLowerCase();
  const short = lower.startsWith('v_') && lower.length > 2 ? lower.slice(2) : lower;
  return short === GROUND || short.includes(PROVIDE_SEP) ? `${short}_w` : short;
}

/** The draft of one sheet's wiring while it is built: the joins between terminals, the levels each
 *  is written at, and why. */
interface Draft {
  top: SheetDoc;
  doc: SheetDoc;
  /** The block path of the sheet drafted (`''` for the top). */
  level: string;
  /** How a note names where it is: `in "a.b": `, or nothing at the top. */
  where: string;
  out: WiringProposal;
  devices: DraftDevice[];
  names: Set<string>;
  uf: ReturnType<typeof unionFind>;
  why: Map<Slot, string[]>;
  marks: Map<Slot, WireMark[]>;
  levels: Map<Slot, Level[]>;
}

const note = (s: Draft, x: Slot, mark: WireMark, reason: string): void => {
  s.why.set(x, [...(s.why.get(x) ?? []), reason]);
  s.marks.set(x, [...(s.marks.get(x) ?? []), mark]);
};

const join = (
  s: Draft,
  x: Slot,
  y: Slot,
  mark: WireMark,
  reason: string,
  theirs = reason,
): void => {
  note(s, x, mark, reason);
  note(s, y, mark, theirs);
  s.uf.union(x, y);
};

/** Whether `n` is a name of `d` the canonical form keeps as an atom. */
const known = (d: SheetDoc, n: string): boolean =>
  d.params.some((q) => q.name === n) ||
  d.equations.some((e) => e.name === n) ||
  splitProvide(n) !== undefined ||
  (!!d.givens && DEVICE_NAMES.has(n));

/** The canonical form of an expression in the drafted sheet's namespace: a child's own names are
 *  qualified by its block, a child param this sheet overrides reads as the override. */
function formOf(s: Draft, src: string, block?: SheetBlock): Poly {
  return normalizeSrc(src, (n) => {
    if (!block) return known(s.doc, n) ? atomPoly(n) : undefined;
    const over = blockOverride(block, n);
    if (over !== undefined) return formOf(s, over);
    return block.doc && known(block.doc, n) ? atomPoly(joinProvide(block.name, n)) : undefined;
  });
}

/** A bias expression as this sheet writes it: through the override when it is a bare child param
 *  this sheet sets, and the block it is written in otherwise (none for the sheet's own). */
function written(
  src: string | undefined,
  block?: SheetBlock,
): { text: string; block?: SheetBlock } | undefined {
  if (src === undefined) return undefined;
  const over = block ? blockOverride(block, src.trim()) : undefined;
  if (over !== undefined) return { text: over };
  return { text: src, ...(block ? { block } : {}) };
}

/** Draft terminal `x` at the level `text`. */
function at(
  s: Draft,
  x: Slot,
  text: string,
  reason: string,
  block?: SheetBlock,
  derived = false,
): void {
  const key = canon(formOf(s, text, block));
  s.levels.set(x, [
    ...(s.levels.get(x) ?? []),
    { key, text: text.trim(), why: reason, ...(derived ? { derived } : {}) },
  ]);
  if (!derived) note(s, x, 'inferred', reason);
}

/** Split an axis expression into the two levels it subtracts, after any sign parameter that
 *  multiplies it whole (recorded as a selector candidate). */
function split(
  s: Draft,
  text: string,
  block?: SheetBlock,
): { a?: string; b?: string; whole: string } {
  const node = parseExpr(text);
  if (!node) return { whole: text };
  let inner = node;
  const owner = block?.doc ?? s.doc;
  const root = selectorRoot(node, (n) =>
    owner.params.some((q) => q.name === n && (q.convention === 'axis-sign' || SIGN_NAME.test(n))),
  );
  if (root) {
    inner = root.inner;
    if (!s.out.selectors.some((x) => x.at === s.level && x.param === root.name))
      s.out.selectors.push({ at: s.level, param: root.name });
  }
  if (inner.type === 'BinaryExpression' && inner.operator === '-')
    return { a: sourceOf(inner.left), b: sourceOf(inner.right), whole: sourceOf(inner) };
  return { whole: sourceOf(inner) };
}

/** A difference of two levels `said` places both ends: `upper` at its first level, `lower` at its
 *  second. True where it did. */
function placeDifference(
  s: Draft,
  said: string,
  sp: { a?: string; b?: string },
  upper: [Slot, string],
  lower: [Slot, string],
  block?: SheetBlock,
): boolean {
  if (sp.a === undefined || sp.b === undefined) return false;
  at(s, upper[0], sp.a, `${said} puts the ${upper[1]} at ${sp.a}`, block);
  at(s, lower[0], sp.b, `${said} puts the ${lower[1]} at ${sp.b}`, block);
  return true;
}

/** What each device's givens say about its wires: the diode connection, the body, the drain and
 *  the gate. */
function draftFromGivens(s: Draft): void {
  for (const d of s.devices) {
    const slot = (t: string): Slot => `${d.name}.${t}`;
    const g = d.givens;
    const p = d.polarity === 'p';
    if (g.diode === true)
      join(s, slot('d'), slot('g'), 'certain', 'diode: true — the gate is on the drain wire');

    // The body first: an n device's vsb, read whole, is its source's level above a grounded body,
    // so a single vds after it is a drop above that source rather than a level over ground.
    const vsb = written(g.vsb, d.block);
    let source: string | undefined;
    if (vsb === undefined || constantOf(formOf(s, vsb.text, vsb.block)) === 0)
      join(
        s,
        slot('b'),
        slot('s'),
        'inferred',
        vsb
          ? `vsb = ${vsb.text.trim()}: the body is on the source wire`
          : 'vsb is left at its default 0: the body is on the source wire',
      );
    else {
      const sp = split(s, vsb.text, vsb.block);
      const said = `vsb = ${vsb.text.trim()}`;
      if (!p) {
        source = sp.whole;
        at(
          s,
          slot('s'),
          sp.whole,
          `${said} puts the source at ${sp.whole} above a body at ground`,
          vsb.block,
        );
        at(s, slot('b'), '0', `${said} is read whole, so the body is at ground`, vsb.block);
      } else placeDifference(s, said, sp, [slot('b'), 'body'], [slot('s'), 'source'], vsb.block);
    }

    // vds: a difference of two levels places both ends; one value is a level only where it is a
    // bare name or a number; anything else places nothing and says so.
    const vds = written(g.vds, d.block);
    if (vds) {
      const sp = split(s, vds.text, vds.block);
      const said = `vds = ${vds.text.trim()}`;
      const top: [Slot, string] = p ? [slot('s'), 'source'] : [slot('d'), 'drain'];
      const bottom: [Slot, string] = p ? [slot('d'), 'drain'] : [slot('s'), 'source'];
      if (placeDifference(s, said, sp, top, bottom, vds.block)) {
        // placed
      } else if (!p && SINGLE.test(sp.whole.trim()) && source !== undefined) {
        at(
          s,
          slot('d'),
          `(${source}) + ${sp.whole}`,
          `${said} is a drop above the source the vsb places, so the drain is at (${source}) + ${sp.whole}`,
          vds.block,
        );
      } else if (!p && SINGLE.test(sp.whole.trim())) {
        at(s, slot('d'), sp.whole, `${said} puts the drain at ${sp.whole}, over ground`, vds.block);
        at(s, slot('s'), '0', `${said} is one level, so the source is at ground`, vds.block);
      } else
        s.out.notes.push(
          `${s.where}${deviceName(d.name)}: ${said} is not a difference of two levels, so where its ` +
            `drain and source sit is left for the author`,
        );
    }

    const vgs = written(g.vgs, d.block);
    if (vgs) {
      const t = vgs.text.trim();
      const tie = splitProvide(t);
      if (tie && tie[1] === 'vgs' && s.names.has(tie[0]) && tie[0] !== d.name) {
        const reason = `vgs = ${t}: the same gate-source voltage as "${tie[0]}", read as a shared gate and source`;
        const theirs = `"${d.name}" is given this device's gate-source voltage (vgs = ${t}), read as a shared gate and source`;
        join(s, slot('g'), `${tie[0]}.g`, 'inferred', reason, theirs);
        join(s, slot('s'), `${tie[0]}.s`, 'inferred', reason, theirs);
      } else {
        const sp = split(s, vgs.text, vgs.block);
        const top: [Slot, string] = p ? [slot('s'), 'source'] : [slot('g'), 'gate'];
        const bottom: [Slot, string] = p ? [slot('g'), 'gate'] : [slot('s'), 'source'];
        placeDifference(s, `vgs = ${t}`, sp, top, bottom, vgs.block);
      }
    }
  }
}

/** A hold on a node under a gate (see heldGateOf): the node is that device's source, and its gate
 *  is held at the hold expression where the design is held — a block's device or the sheet's own. */
function draftFromHolds(s: Draft): void {
  for (const q of s.doc.params) {
    const dev = heldGateOf(s.doc, q);
    if (!dev || !holds(q) || !s.names.has(dev)) continue;
    const read = namesOf(q.hold);
    if (read.length !== 2 || !read.includes(q.name)) continue;
    const who = deviceName(dev);
    at(s, `${dev}.s`, q.name, `the hold on ${q.name} makes it the node under ${who}'s gate`);
    at(
      s,
      `${dev}.g`,
      q.hold,
      `the hold on ${q.name} keeps ${who}'s gate at ${q.hold} where the design is held`,
    );
  }
}

/** Two terminals written at the same level are drafted onto one wire; then, once, a gate is drafted
 *  one gate-source voltage from its source, which joins a gate to a drain written that way. */
function joinByLevel(s: Draft): void {
  const byLevel = (): void => {
    const first = new Map<string, Slot>();
    for (const [x, ls] of s.levels)
      for (const l of ls) {
        const y = first.get(l.key);
        if (y === undefined) first.set(l.key, x);
        else if (s.uf.find(x) !== s.uf.find(y))
          join(s, y, x, 'inferred', `both sit at ${l.key === '0' ? 'ground' : l.text}`);
      }
  };
  byLevel();
  for (const d of s.devices) {
    const src = [...s.levels].find(
      ([x, ls]) => s.uf.find(x) === s.uf.find(`${d.name}.s`) && ls.some((l) => !l.derived),
    );
    const lv = src?.[1].find((l) => !l.derived);
    if (!lv) continue;
    const vgs = d.name === 'givens' ? 'vgs' : joinProvide(d.name, 'vgs');
    const text =
      lv.key === '0'
        ? d.polarity === 'p'
          ? `-abs(${vgs})`
          : vgs
        : d.polarity === 'p'
          ? `${lv.text} - abs(${vgs})`
          : `${lv.text} + ${vgs}`;
    at(
      s,
      `${d.name}.g`,
      text,
      `its source sits at ${lv.key === '0' ? 'ground' : lv.text}, so its gate sits one gate-source voltage ${d.polarity === 'p' ? 'below' : 'above'} it`,
      undefined,
      true,
    );
  }
  byLevel();
}

/** The drafted wires: each class of joined terminals, in the order its first terminal is listed,
 *  with the name it is given. */
interface Wires {
  slots: Slot[];
  classes: Map<Slot, Slot[]>;
  ordered: Slot[][];
  wire: Map<Slot, string>;
  classLevels: (members: Slot[]) => Level[];
}

/** Name each wire: ground, the param its level is written as, or a fresh name. */
function nameWires(s: Draft): Wires {
  const slots = s.devices.flatMap((d) => TERMINALS.map((t) => `${d.name}.${t}`));
  const classes = new Map<Slot, Slot[]>();
  for (const x of slots) classes.set(s.uf.find(x), [...(classes.get(s.uf.find(x)) ?? []), x]);
  const wire = new Map<Slot, string>();
  const used = new Set<string>([GROUND]);
  const ordered = [...classes.values()].sort((a, b) => slots.indexOf(a[0]) - slots.indexOf(b[0]));
  const classLevels = (members: Slot[]): Level[] =>
    members.flatMap((x) => s.levels.get(x) ?? []).filter((l) => !l.derived);
  for (const members of ordered) {
    const ls = classLevels(members);
    const distinct = [...new Set(ls.map((l) => l.key))];
    let name: string;
    if (distinct.includes('0')) name = GROUND;
    else {
      const param = ls.find((l) => isBareParam(l.text, s.doc));
      const pick = members.find((x) => !x.startsWith('givens.')) ?? members[0];
      name = param
        ? wireFromParam(param.text.trim())
        : pick.replace('givens.', 'own_').replace('.', '_');
      for (let k = 2; used.has(name); k++) name = `${name.replace(/_\d+$/, '')}_${k}`;
      used.add(name);
    }
    if (distinct.length > 1)
      s.out.notes.push(
        `${s.where}wire "${name}" joins terminals drafted at different levels ` +
          `(${[...new Set(ls.map((l) => l.text))].join(', ')}) — check which joins are real`,
      );
    for (const x of members) wire.set(x, name);
  }
  return { slots, classes, ordered, wire, classLevels };
}

/** Each device's four drafted wires, with how sure the draft is of each and why. */
function deviceDrafts(s: Draft, w: Wires): void {
  for (const d of s.devices) {
    const nodes = {} as DeviceDraft['nodes'];
    for (const t of TERMINALS) {
      const x = `${d.name}.${t}`;
      const members = w.classes.get(s.uf.find(x)) as Slot[];
      const every = members.flatMap((m) => s.marks.get(m) ?? []);
      const mark: WireMark =
        members.length === 1 && !w.classLevels(members).length
          ? 'unknown'
          : every.length && every.every((m) => m === 'certain')
            ? 'certain'
            : 'inferred';
      const own = s.marks.get(x) ?? [];
      const others = members.filter((m) => m !== x).map((m) => m.replace('givens.', 'own.'));
      const reasons = [...new Set(s.why.get(x) ?? [])];
      // A terminal certain of its own join can still sit on a wire the draft joined by inference.
      if (mark === 'inferred' && own.length && own.every((m) => m === 'certain'))
        reasons.push(`its wire is also ${others.join(', ')}'s, a join that is inferred`);
      nodes[t] = {
        wire: w.wire.get(x) as string,
        mark,
        why:
          mark === 'unknown'
            ? ['nothing on the sheet names this wire: a new name, to confirm or replace']
            : reasons,
      };
    }
    s.out.devices.push({ device: d.name, at: s.level, nodes });
  }
}

/** Held wires: a class written at a param the designer states, or at a hold expression. */
function heldLevelDrafts(s: Draft, w: Wires): void {
  for (const members of w.ordered) {
    const name = w.wire.get(members[0]) as string;
    if (name === GROUND) continue;
    for (const l of w.classLevels(members)) {
      const text = l.text.trim();
      const isHold = s.doc.params.some((q) => holds(q) && spelled(q.hold) === spelled(text));
      if (!isBareParam(text, s.doc) && !isHold) continue;
      if (s.out.levels.some((x) => x.at === s.level && x.wire === name)) break;
      const verdict = levelEligibility(s.top, s.level, text);
      if (verdict.kind === 'held') {
        s.out.levels.push({
          at: s.level,
          wire: name,
          expr: text,
          held: 'held',
          why: `${text} is classed independent, and a held level is the designer's to state`,
        });
        // An output the application holds: currents arrive and leave there, and the check reports
        // what the source holding it supplies — which is the circuit's own balance at that wire.
        const flows = members.flatMap((x) => {
          const [dev, t] = x.split('.');
          const pol = s.devices.find((q) => q.name === dev)?.polarity;
          return t === 'd' || t === 's' ? [currentInto(pol, t)] : [];
        });
        if (flows.includes(1) && flows.includes(-1))
          s.out.notes.push(
            `${s.where}wire "${name}" is held at ${text}, and currents ` +
              `arrive and leave there: the check will report the current at that wire, as what an ` +
              `ideal source holding it supplies`,
          );
      } else if (verdict.kind === 'held-gate')
        s.out.levels.push({
          at: s.level,
          wire: name,
          expr: text,
          held: 'held-gate',
          why: `the gate a hold on ${verdict.hold} keeps fixed where the design is held, derived at the design point`,
        });
      else
        s.out.notes.push(
          `${s.where}wire "${name}" sits at ${text}, which is derived, not held: ${verdict.problems[0]}`,
        );
      break;
    }
  }
}

/**
 * A wire the draft leaves with one terminal is a misspelt name to validation unless it is held or a
 * port, so each is made one: held at the level the draft placed it at — a number, or the drain or
 * body voltage that placed it — where that level may be held, and a port otherwise, the wire a
 * parent or the application connects. Ports are drafted for the top sheet only; on a sheet below
 * it, a port would need its parent's port map as well, so the wire is left to the author with a
 * note. Each choice is noted with its reason.
 */
function singleTerminalDrafts(s: Draft, w: Wires): void {
  for (const members of w.ordered) {
    const name = w.wire.get(members[0]) as string;
    if (name === GROUND || members.length > 1) continue;
    if (s.out.levels.some((x) => x.at === s.level && x.wire === name)) continue;
    const level = w.classLevels(members)[0];
    const terminal = members[0].replace('givens.', 'own.');
    if (level) {
      const verdict = levelEligibility(s.top, s.level, level.text);
      if (verdict.kind === 'held') {
        s.out.levels.push({
          at: s.level,
          wire: name,
          expr: level.text,
          held: 'held',
          why: `${terminal} is the only terminal on it, and the draft places it at ${level.text}, which may be held`,
        });
        s.out.notes.push(
          `${s.where}wire "${name}" has one terminal (${terminal}): held at ${level.text}, the level ` +
            `the draft placed it at, so it is not read as a misspelt name`,
        );
        continue;
      }
    }
    const why = level
      ? `it sits at ${level.text}, which cannot be held`
      : 'nothing on the sheet places its level';
    if (s.level !== '') {
      s.out.notes.push(
        `${s.where}wire "${name}" has one terminal (${terminal}) and ${why} — make it a port of ` +
          `this sheet, mapped in its parent block's ports, or hold it`,
      );
      continue;
    }
    s.out.ports.push({
      at: s.level,
      wire: name,
      why: `${terminal} is the only terminal on it, and ${why}`,
    });
    s.out.notes.push(
      `${s.where}wire "${name}" has one terminal (${terminal}) and ${why}: drafted as a port, the ` +
        `wire a parent or the application connects`,
    );
  }
}

/** Draft the wiring of the sheet at `level` (and of every sub-sheet below it that composes devices
 *  of its own). */
function proposeLevel(top: SheetDoc, doc: SheetDoc, level: string, out: WiringProposal): void {
  const where = level === '' ? '' : `in "${level}": `;
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  // The devices this sheet wires: its own, and each child that sizes a device and composes none.
  const devices: DraftDevice[] = [];
  if (doc.givens) devices.push({ name: 'givens', givens: doc.givens, polarity: doc.polarity });
  for (const b of blocks) {
    if (!b.doc) continue;
    if (b.doc.blocks?.length) proposeLevel(top, b.doc, childPath(level, b.name), out);
    else if (b.doc.givens && placementsOf(b.doc.nodes))
      out.notes.push(
        `${where}block "${b.name}" wires its own device, so it is connected through its ports, not ` +
          `drafted here`,
      );
    else if (b.doc.givens)
      devices.push({ name: b.name, givens: b.doc.givens, polarity: b.doc.polarity, block: b });
  }
  if (!devices.length) return;
  const s: Draft = {
    top,
    doc,
    level,
    where,
    out,
    devices,
    names: new Set(devices.map((d) => d.name)),
    uf: unionFind(),
    why: new Map(),
    marks: new Map(),
    levels: new Map(),
  };
  draftFromGivens(s);
  draftFromHolds(s);
  joinByLevel(s);
  const w = nameWires(s);
  deviceDrafts(s, w);
  heldLevelDrafts(s, w);
  singleTerminalDrafts(s, w);
}

type Parsed = NonNullable<ReturnType<typeof parseExpr>>;

/** How tightly a binary operator binds, for rebuilding source with no more parentheses than it
 *  needs; comparisons and logic bind loosest. */
const PRECEDENCE: Readonly<Record<string, number>> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
const bindOf = (n: Parsed): number =>
  n.type === 'BinaryExpression'
    ? (PRECEDENCE[n.operator] ?? 0)
    : n.type === 'ConditionalExpression'
      ? -1
      : 9;

/** The source text of a parsed node, rebuilt: what the draft quotes where it names a level. */
function sourceOf(n: Parsed): string {
  switch (n.type) {
    case 'Literal':
      return n.raw;
    case 'Identifier':
      return n.name;
    case 'UnaryExpression':
      return `${n.operator}${bindOf(n.argument) < 9 ? `(${sourceOf(n.argument)})` : sourceOf(n.argument)}`;
    case 'BinaryExpression': {
      const p = PRECEDENCE[n.operator] ?? 0;
      // `-` and `/` do not associate to the right, and `^` does not to the left.
      const left = bindOf(n.left) < p || (n.operator === '^' && bindOf(n.left) === p);
      const right =
        bindOf(n.right) < p ||
        (bindOf(n.right) === p && (n.operator === '-' || n.operator === '/'));
      const side = (x: Parsed, wrap: boolean): string => (wrap ? `(${sourceOf(x)})` : sourceOf(x));
      return `${side(n.left, left)} ${n.operator} ${side(n.right, right)}`;
    }
    case 'CallExpression':
      return `${sourceOf(n.callee)}(${n.arguments.map(sourceOf).join(', ')})`;
    case 'ConditionalExpression':
      return `(${sourceOf(n.test)}) ? (${sourceOf(n.consequent)}) : (${sourceOf(n.alternate)})`;
  }
}

/** Every block of a tree still carrying a key no format reads (the gate `wiring` of the earlier
 *  format), by block path. */
function retiredKeysIn(doc: SheetDoc, path = ''): string[] {
  return (Array.isArray(doc.blocks) ? doc.blocks : []).filter(isObject).flatMap((b) => {
    const here = childPath(path, b.name);
    const raw = b as unknown as Record<string, unknown>;
    return [
      ...(EARLIER_BLOCK_KEYS.some((k) => raw[k] !== undefined) ? [here] : []),
      ...(b.doc ? retiredKeysIn(b.doc, here) : []),
    ];
  });
}

/** A draft of the wiring `doc` would carry in format version 2 (see the module comment). */
export function proposeWiring(doc: SheetDoc): WiringProposal {
  const out: WiringProposal = {
    title: doc.title,
    devices: [],
    levels: [],
    ports: [],
    selectors: [],
    notes: [],
  };
  proposeLevel(doc, doc, '', out);
  const unknown = out.devices.flatMap((d) =>
    TERMINALS.filter((t) => d.nodes[t].mark === 'unknown').map(
      (t) => `${d.at ? `${d.at}${PATH_SEP}` : ''}${d.device}.${t}`,
    ),
  );
  if (unknown.length)
    out.notes.push(
      `terminals no declaration places, given new wires to name: ${unknown.join(', ')}`,
    );
  for (const s of out.selectors)
    out.notes.push(
      `${s.at ? `in "${s.at}": ` : ''}"${s.param}" multiplies a whole bias axis like the table's axis direction — ` +
        `mark it convention: "axis-sign" if that is what it is`,
    );
  const retired = retiredKeysIn(doc);
  if (retired.length)
    out.notes.push(
      `the earlier gate wiring on ${retired.map((b) => `block "${b}"`).join(', ')} is read by no ` +
        `format: the copy drops it, and the nodes drafted here say where each device sits`,
    );
  out.notes.push(
    'only a diode connection is certain; every inferred wire is a proposal to confirm or correct',
  );
  return out;
}

/** The document at a block path below `doc`. */
function docAt(doc: SheetDoc, at: string): SheetDoc | undefined {
  let d: SheetDoc | undefined = doc;
  for (const seg of at === '' ? [] : at.split(PATH_SEP))
    d = d?.blocks?.find((b) => b.name === seg)?.doc;
  return d;
}

/**
 * A format-version-2 copy of `doc` carrying the proposal: each device's nodes (a sheet's own on
 * its `nodes`, a child's on its block), the held levels, the ports and the selector marks, with no
 * block keeping the earlier gate `wiring` no format reads. What an author confirms; the input is
 * untouched.
 */
export function applyWiringProposal(doc: SheetDoc, proposal: WiringProposal): SheetDoc {
  const out = cloneDoc(doc);
  const host = (at: string): SheetDoc | undefined => {
    const d = docAt(out, at);
    if (d) d.formatVersion = FORMAT_VERSION;
    return d;
  };
  for (const d of proposal.devices) {
    const h = host(d.at);
    if (!h) continue;
    const nodes: DeviceNodes = {
      d: d.nodes.d.wire,
      g: d.nodes.g.wire,
      s: d.nodes.s.wire,
      b: d.nodes.b.wire,
    };
    if (d.device === 'givens') h.nodes = nodes;
    else {
      const block = h.blocks?.find((b) => b.name === d.device);
      if (block) block.nodes = nodes;
    }
  }
  for (const l of proposal.levels) {
    const h = host(l.at);
    if (h) h.levels = { ...(h.levels ?? {}), [l.wire]: l.expr };
  }
  for (const p of proposal.ports ?? []) {
    const h = host(p.at);
    if (h && !(h.ports ?? []).includes(p.wire)) h.ports = [...(h.ports ?? []), p.wire];
  }
  for (const s of proposal.selectors) {
    const p = host(s.at)?.params.find((q) => q.name === s.param);
    if (p && (p.value === 1 || p.value === -1)) p.convention = 'axis-sign';
  }
  const drop = (d: SheetDoc): void => {
    for (const b of Array.isArray(d.blocks) ? d.blocks : []) {
      for (const k of EARLIER_BLOCK_KEYS) delete (b as unknown as Record<string, unknown>)[k];
      if (b.doc) drop(b.doc);
    }
  };
  drop(out);
  return out;
}

/** The proposal as text for an author to read: each device's four wires with how sure the draft is and why,
 *  the held levels, the ports, and the notes. */
export function formatWiringProposal(p: WiringProposal): string {
  const lines = [`Wiring proposal for "${p.title}"`];
  for (const d of p.devices) {
    lines.push(
      `  ${d.at ? `${d.at}: ` : ''}${deviceName(d.device)}: ${TERMINALS.map((t) => `${t}=${d.nodes[t].wire} (${d.nodes[t].mark})`).join('  ')}`,
    );
    for (const t of TERMINALS) for (const w of d.nodes[t].why) lines.push(`      ${t}: ${w}`);
  }
  lines.push('  levels:');
  if (!p.levels.length) lines.push('      (none)');
  for (const l of p.levels)
    lines.push(`      ${l.at ? `${l.at}: ` : ''}${l.wire} = ${l.expr} (${l.held}: ${l.why})`);
  lines.push('  ports:');
  if (!(p.ports ?? []).length) lines.push('      (none)');
  for (const q of p.ports ?? []) lines.push(`      ${q.at ? `${q.at}: ` : ''}${q.wire} (${q.why})`);
  lines.push('  notes:');
  for (const n of p.notes) lines.push(`      - ${n}`);
  return lines.join('\n');
}
