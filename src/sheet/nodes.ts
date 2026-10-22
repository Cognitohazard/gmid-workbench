// The netlist a format-version-2 sheet declares — which wire each terminal of each sized device
// sits on, and which wires the sheet holds — and the DC consistency check that reads it after
// sizing. Four parts:
//
//  - the format contract: which keys a document of each version may carry;
//  - the structural lints on the netlist itself (a misspelt wire, a short, a diode flag the wires
//    contradict), raised by validation;
//  - the structural diode: a placement whose gate and drain share a wire is diode-connected, and
//    is sized on the table's vds = vgs diagonal exactly as `diode: true` is;
//  - the DC walk, run on every evaluated sheet that declares wiring: each placement states its
//    gate, drain and body voltages above its source, each held wire its level; the walk finds
//    where those statements close into loops, reports each loop's residual, and derives every
//    other wire's level FOR CHECKING. Kirchhoff's laws are stated and propagated in one bounded
//    pass: nothing here iterates, nothing is solved, and no level it derives is fed back into
//    the design. A loop that does not close is reported with both of its claims; which claim is
//    wrong is the author's to say.
//
// A format-version-2 key is read only in a document of format version 2: in the earlier format,
// where validation refuses it, it is never half-read.
//
// Pure and deterministic; zero DOM. Every verdict is independent of the order relations are
// declared in: relations are ordered by a total canonical key before anything reads them.

import type { DeviceTable, QAWarning, Scope } from '../types';
import { compileExpr } from '../derive';
import { scalarScope } from '../expr';
import { formatSI } from '../units';
import { CONSTANTS } from '../constants';
import {
  ANALYSIS_SHAPES,
  DEVICE_NAMES,
  EARLIER_BLOCK_KEYS,
  ELEMENT_KEYS,
  ELEMENT_KINDS,
  FORMAT_VERSION,
  GROUND,
  IDENTIFIER,
  MAX_BLOCK_DEPTH,
  NODE_KEYS,
  PARAM_CONVENTIONS,
  PATH_SEP,
  PROVIDE_SEP,
  TERMINALS,
  WIRING_BLOCK_KEYS,
  WIRING_DOC_KEYS,
  WIRING_VAR_KEYS,
  blockOverride,
  childPath,
  deviceName,
  isObject,
  namesOf,
  parses,
  providePrefix,
  providedNames,
  splitProvide,
  type DeviceNodes,
  type DevicePoint,
  type NodesReport,
  type SheetBlock,
  type SheetBlockReport,
  type SheetDoc,
  type SheetElement,
  type SheetGivens,
  type SheetResult,
  type SheetVar,
  type WiringValues,
} from './types';
import {
  add,
  atomPoly,
  constPoly,
  hasOpaque,
  linearForm,
  normalize,
  normalizeSrc,
  parseExpr,
  rankOf,
  scale,
  selectorRoot,
  type Poly,
} from './linear';

/**
 * How far apart two statements of one voltage may be before they disagree: 10 mV, absolute and in
 * the voltage domain. It is the resolution bias plans are written to, and an order of magnitude
 * below the disagreements a wiring check exists to catch — two gates sized hundreds of millivolts
 * apart on one wire. One constant, read by the loop residuals and by the rule that decides whether
 * several placements share one operating point.
 */
export const NODE_TOL = 0.01;

/**
 * How large a wire's current residual may be, as a fraction of the largest current meeting there,
 * before it is raised as a warning. Below about 0.1 % the sizer cannot tell two currents apart
 * — it interpolates between table nodes to roughly that resolution — so a smaller residual says
 * nothing a table can resolve. Every residual is reported in the check's data whatever its size;
 * this decides only which ones are raised.
 */
export const KCL_TOL_REL = 1e-3;

/** How a wire is spelt: an identifier, without the separator that joins a child's names to its
 *  block. */
const wireOk = (w: unknown): w is string =>
  typeof w === 'string' && IDENTIFIER.test(w) && !w.includes(PROVIDE_SEP);

/** The reference wire every held level is measured from. Spelt so it sorts before every wire name
 *  and cannot be one. */
export const REF = '(ref)';

// ---------------------------------------------------------------------------------------------
// Placements
// ---------------------------------------------------------------------------------------------

/** The placements a `nodes` value carries — one, or a list — read without trusting its shape:
 *  undefined for `"none"`, for absence, and for anything that is not an object or a list of them.
 *  Members are whatever was written; validation is what names a malformed one. */
export function placementsOf(n: unknown): DeviceNodes[] | undefined {
  if (Array.isArray(n))
    return n.every(isObject) && n.length ? (n as unknown as DeviceNodes[]) : undefined;
  return isObject(n) ? [n as unknown as DeviceNodes] : undefined;
}

/** Whether one placement puts its gate on its drain wire. */
const isDiodePlacement = (p: Record<string, unknown> | DeviceNodes): boolean =>
  typeof p.g === 'string' && p.g === p.d;

/** Whether `nodes` put every placement's gate on its drain wire — a diode connection stated by the
 *  wires themselves. False for a list that mixes the two, which validation refuses. */
export function wiredDiode(n: unknown): boolean {
  const ps = placementsOf(n);
  return !!ps && ps.every(isDiodePlacement);
}

/** A block's `nodes` as its parent's format reads them: nothing, in a parent of the earlier format. */
export const blockWires = (parent: SheetDoc, block: SheetBlock): unknown =>
  formatOf(parent) === 2 ? block.nodes : undefined;

/** The wires the device `doc` sizes sits on: its own document's `nodes`, else the composing
 *  block's (`byBlock`, read through blockWires) — the one statement of where a device's wires
 *  are written. */
function deviceWires(doc: SheetDoc, byBlock?: unknown): DeviceNodes[] | undefined {
  return (formatOf(doc) === 2 ? placementsOf(doc.nodes) : undefined) ?? placementsOf(byBlock);
}

/** Whether the device `doc` sizes is diode-connected by its wires alone: every placement puts its
 *  gate on its drain wire, and its givens say nothing about a diode connection. One predicate,
 *  read by the sizing (structuralDiodes) and by validation. */
export const structuralDiode = (doc: SheetDoc, byBlock?: unknown): boolean =>
  !!doc.givens && doc.givens.diode === undefined && wiredDiode(deviceWires(doc, byBlock));

/** Whether a document wires its own device. */
const wiresOwnDevice = (doc: SheetDoc): boolean =>
  formatOf(doc) === 2 && placementsOf(doc.nodes) !== undefined;

/** Into a wire, the sign of a device's current at one terminal: an n device draws its current in at
 *  the drain and returns it at the source, a p device the other way. */
export const currentInto = (polarity: 'n' | 'p' | undefined, t: 'd' | 's'): 1 | -1 =>
  (polarity === 'p') === (t === 'd') ? 1 : -1;

// ---------------------------------------------------------------------------------------------
// The format contract
// ---------------------------------------------------------------------------------------------

/** The format a document is written in: the earlier one (no version), 2, or one this engine does
 *  not read. */
export function formatOf(doc: { formatVersion?: unknown }): 'earlier' | 2 | 'unknown' {
  const v = doc.formatVersion;
  return v === undefined ? 'earlier' : v === FORMAT_VERSION ? 2 : 'unknown';
}

/** That a format version is not one this app reads, and which ones it does: the one sentence every
 *  refusal of a format is written in. */
export const unreadFormat = (v: unknown): string =>
  `format version ${JSON.stringify(v)} is not one this app reads (it reads documents with no ` +
  `format version, and format version ${FORMAT_VERSION})`;

/** What becomes of a document in a format this app does not read, wherever it is met. */
const KEPT_AS_STORED =
  ' — the document is not imported or evaluated; a stored copy is kept as it was stored';

/**
 * Whether a raw parsed document is in a format this app reads — before a loader rebuilds it, since
 * a format it does not read must not be rebuilt key by key (that would drop whatever the newer
 * format added and keep a version number that no longer describes the result). Such a document is
 * refused at import; a stored one is kept as it was stored, opened with the reason, and not
 * evaluated. Pure; reads the one field.
 */
export function sheetFormat(raw: unknown): {
  format: 'earlier' | 2 | 'unknown';
  reason?: string;
} {
  const format = isObject(raw) ? formatOf(raw) : 'earlier';
  if (format !== 'unknown') return { format };
  return {
    format,
    reason: `${unreadFormat((raw as Record<string, unknown>).formatVersion)}${KEPT_AS_STORED}`,
  };
}

/** The first document of a raw parsed tree — the top, or a child embedded below it — in a format
 *  this app does not read: the refusal sentence, naming the block path of a child. Undefined when
 *  every document is in a format this app reads. For an import, which refuses the whole tree. */
export function unreadFormatIn(raw: unknown, path = '', depth = 0): string | undefined {
  if (!isObject(raw)) return undefined;
  if (formatOf(raw) === 'unknown')
    return `${path ? `block "${path}": ` : ''}${unreadFormat(raw.formatVersion)}`;
  if (depth > MAX_BLOCK_DEPTH || !Array.isArray(raw.blocks)) return undefined;
  for (const b of raw.blocks) {
    if (!isObject(b)) continue;
    const name = typeof b.name === 'string' ? b.name : '?';
    const found = unreadFormatIn(b.doc, childPath(path, name), depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** How a script drafts the netlist a sheet written without one needs: named in the messages that
 *  ask for it, since the app itself has no control that does it. */
const MIGRATION_HINT =
  'a script can draft the nodes from the givens with proposeWiring and write them into a ' +
  'format-version-2 copy with applyWiringProposal (see "Scripting the core" in the README)';

/** Why a block key no format reads is refused, and what replaces it: the gate `wiring` of
 *  documents written before the netlist. The same words reach validation and the loader. */
export const earlierKeyFix = (k: string): string =>
  `"${k}" is not read in any format — the wires a block's device sits on are its "nodes" in ` +
  `format version ${FORMAT_VERSION}; ${MIGRATION_HINT}`;

/** The keys of `keys` an object carries. */
const present = (obj: unknown, keys: readonly string[]): string[] =>
  isObject(obj) ? keys.filter((k) => obj[k] !== undefined) : [];

/**
 * The format contract for one document (not its children — validation recurses into those, and
 * each document states its own version). No version: the earlier format, and every key format 2
 * adds is an error naming the fix. In either format, a block that still carries the gate `wiring`
 * written before the netlist is an error naming the migration: that key is read by no format. Any
 * other version: refused (see sheetFormat).
 */
export function formatProblems(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const err = (message: string, location: string): void => {
    out.push({ rule: 'sheet-format', severity: 'error', message, location });
  };
  const format = formatOf(doc);
  if (format === 'unknown') {
    err(`${unreadFormat(doc.formatVersion)}${KEPT_AS_STORED}`, 'formatVersion');
    return out;
  }
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  const params = Array.isArray(doc.params) ? doc.params : [];
  for (const b of blocks)
    for (const k of present(b, EARLIER_BLOCK_KEYS))
      err(`block "${b.name}": ${earlierKeyFix(k)}`, b.name);
  if (format === 'earlier') {
    const later = (key: string, where: string, location: string): void =>
      err(
        `${where}"${key}" belongs to format version ${FORMAT_VERSION} — add "formatVersion": ` +
          `${FORMAT_VERSION} to this document to use it`,
        location,
      );
    for (const k of present(doc, WIRING_DOC_KEYS)) later(k, '', k);
    for (const b of blocks)
      for (const k of present(b, WIRING_BLOCK_KEYS)) later(k, `block "${b.name}": `, b.name);
    for (const p of params)
      for (const k of present(p, WIRING_VAR_KEYS)) later(k, `param "${p.name}": `, p.name);
  }
  return out;
}

/**
 * The document with every structural diode stated as one: a device whose placements all put the
 * gate on the drain wire — its own `nodes`, or its block's — and whose givens say nothing about a
 * diode connection gets `diode: true`, so the sizing reads its table along the vds = vgs diagonal
 * BEFORE sizing, on the existing diode path. Only an absent flag is filled in: one the author
 * wrote stays as written, and validation reports it where it contradicts the wires. Returns the
 * same object where there is nothing to fill in, so a document without wiring — or in the earlier
 * format, which has none — passes through untouched. Structural, and applied wherever a document
 * is evaluated.
 */
export function structuralDiodes(doc: SheetDoc): SheetDoc {
  const walk = (d: SheetDoc, byBlock: unknown): SheetDoc => {
    const givens =
      d.givens && structuralDiode(d, byBlock) ? { ...d.givens, diode: true } : undefined;
    let changed = givens !== undefined;
    const blocks = Array.isArray(d.blocks)
      ? d.blocks.map((b) => {
          if (!b?.doc) return b;
          const kid = walk(b.doc, blockWires(d, b));
          if (kid === b.doc) return b;
          changed = true;
          return { ...b, doc: kid };
        })
      : d.blocks;
    if (!changed) return d;
    return { ...d, ...(givens ? { givens } : {}), ...(blocks ? { blocks } : {}) };
  };
  return walk(doc, undefined);
}

/** The bias-axis givens — the expressions a selector multiplies. */
const AXIS_GIVENS = ['vgs', 'vds', 'vsb'] as const;

/** Whether `p`, a param of `doc`, is a declared axis-sign selector (format version 2 only). */
const isSelector = (doc: SheetDoc, p: SheetVar | undefined): boolean =>
  !!p && p.convention === 'axis-sign' && formatOf(doc) === 2;

/** Whether a document carries wiring keys of its own: its own device's wires, a held level, an
 *  element, or a block it wires (`nodes`) or connects through ports — read without regard to its
 *  format. */
function carriesWiring(doc: SheetDoc): boolean {
  return (
    placementsOf(doc.nodes) !== undefined ||
    (isObject(doc.levels) && Object.keys(doc.levels).length > 0) ||
    (Array.isArray(doc.elements) && doc.elements.length > 0) ||
    (Array.isArray(doc.blocks) &&
      doc.blocks.some((b) => b?.nodes !== undefined || b?.ports !== undefined))
  );
}

/** Whether a document states wiring of its own (see carriesWiring) in the format that has it. */
const statesWiring = (doc: SheetDoc): boolean => formatOf(doc) === 2 && carriesWiring(doc);

/**
 * Whether a child's wiring joins its parent's walk — one statement of the rule, read by the
 * evaluation and by the walk (which reads the child's wires as its own). It does wherever the
 * child states wiring: the child's declared ports are the parent wires its block's port map names,
 * and every other wire of the child is its own, spelt `block__wire`. A child never runs a walk of
 * its own — only the top of a tree does — so a parent that composes one states wiring itself and
 * connects it through ports, or validation refuses it (composedWiringProblems); in a refused tree
 * the child's wiring joins a walk that does not run. A document in any format but version 2 states
 * no wiring and is never joined.
 */
export const flattened = (child: SheetDoc | undefined): boolean => !!child && statesWiring(child);

// ---------------------------------------------------------------------------------------------
// Carrying the netlist through a loader
// ---------------------------------------------------------------------------------------------

/** A JSON-shaped value copied, so the loaded document shares nothing with the parsed one. */
const copied = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** An object's members whose key is allowed, copied; every other key is recorded in `lost` as
 *  `at.key` and dropped. */
function keptKeys(
  obj: Record<string, unknown>,
  allowed: (k: string) => boolean,
  at: string,
  lost?: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (allowed(k)) out[k] = copied(v);
    else lost?.push(`${at}.${k}`);
  }
  return out;
}

/** A map's values that pass `ok`; every other one is recorded in `lost` as `at.key` and dropped. */
function keptValues<T>(
  obj: Record<string, unknown>,
  ok: (v: unknown) => v is T,
  at: string,
  lost?: string[],
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (ok(v)) out[k] = v;
    else lost?.push(`${at}.${k}`);
  }
  return out;
}

/** A list's items that pass `keep` (which may reshape them); every other one is recorded in `lost`
 *  as `at[i]` and dropped. */
function keptItems<T>(
  list: readonly unknown[],
  keep: (x: unknown, i: number) => T | undefined,
  at: string,
  lost?: string[],
): T[] {
  return list.flatMap((x, i) => {
    const kept = keep(x, i);
    if (kept !== undefined) return [kept];
    lost?.push(`${at}[${i}]`);
    return [];
  });
}

const isString = (v: unknown): v is string => typeof v === 'string';

function carriedNodes(raw: unknown, at: string, lost: string[] | undefined): unknown {
  if (raw === undefined) return undefined;
  const one = (p: Record<string, unknown>, where: string) =>
    keptKeys(p, (k) => NODE_KEYS.has(k), where, lost);
  if (isObject(raw)) return one(raw, at);
  if (Array.isArray(raw) && raw.every(isObject)) return raw.map((p, i) => one(p, `${at}[${i}]`));
  lost?.push(at);
  return undefined;
}

/**
 * For a loader that rebuilds a sheet document field by field: the format-version-2 keys of one raw
 * document, carried over as written — validation is what names a malformed member, so a document
 * never reloads cleaner than the core reads it. A piece of the wrong shape to carry at all (a
 * `levels` that is not an object, an element that is not one) is recorded in `lost` and dropped,
 * so an import that collects losses refuses the document instead of quietly rewriting it.
 */
export function carriedDocWiring(o: Record<string, unknown>, lost?: string[]): Partial<SheetDoc> {
  const out: Partial<SheetDoc> = {};
  if (typeof o.formatVersion === 'number' && Number.isFinite(o.formatVersion))
    out.formatVersion = o.formatVersion;
  else if (o.formatVersion !== undefined) lost?.push('formatVersion');
  const nodes = o.nodes === 'none' ? 'none' : carriedNodes(o.nodes, 'nodes', lost);
  if (nodes !== undefined) out.nodes = nodes as SheetDoc['nodes'];
  if (isObject(o.levels)) out.levels = keptValues(o.levels, isString, 'levels', lost);
  else if (o.levels !== undefined) lost?.push('levels');
  if (Array.isArray(o.elements))
    out.elements = keptItems(
      o.elements,
      (e, i) =>
        isObject(e)
          ? (keptKeys(
              e,
              (k) => ELEMENT_KEYS.has(k),
              `elements[${i}]`,
              lost,
            ) as unknown as SheetElement)
          : undefined,
      'elements',
      lost,
    );
  else if (o.elements !== undefined) lost?.push('elements');
  if (Array.isArray(o.ports))
    out.ports = keptItems(o.ports, (w) => (isString(w) ? w : undefined), 'ports', lost);
  else if (o.ports !== undefined) lost?.push('ports');
  if (Array.isArray(o.analyses))
    out.analyses = keptItems(
      o.analyses,
      (a, i) => {
        if (!isObject(a)) return undefined;
        const shape = ANALYSIS_SHAPES[a.kind as string];
        const allowed = (k: string): boolean =>
          !shape || shape.required.includes(k) || shape.optional.includes(k);
        return keptKeys(a, allowed, `analyses[${i}]`, lost) as unknown as NonNullable<
          SheetDoc['analyses']
        >[number];
      },
      'analyses',
      lost,
    );
  else if (o.analyses !== undefined) lost?.push('analyses');
  return out;
}

/** The format-version-2 keys of one raw block, carried as carriedDocWiring carries a document's,
 *  and the keys a block no longer carries in any format (EARLIER_BLOCK_KEYS), copied as they are
 *  so validation can say how to migrate them; `at` is the block's path in the loader's loss report
 *  (`blocks[2].`). */
export function carriedBlockWiring(
  o: Record<string, unknown>,
  at: string,
  lost?: string[],
): Partial<SheetBlock> {
  const out: Partial<SheetBlock> = {};
  const nodes = carriedNodes(o.nodes, `${at}nodes`, lost);
  if (nodes !== undefined) out.nodes = nodes as SheetBlock['nodes'];
  if (isObject(o.ports))
    out.ports = keptValues(
      o.ports,
      (v): v is string | null => typeof v === 'string' || v === null,
      `${at}ports`,
      lost,
    );
  else if (o.ports !== undefined) lost?.push(`${at}ports`);
  for (const k of EARLIER_BLOCK_KEYS)
    if (o[k] !== undefined) (out as Record<string, unknown>)[k] = copied(o[k]);
  return out;
}

/** A raw param's axis-sign marker, carried where it is one of the words it may be. */
export function carriedConvention(
  o: Record<string, unknown>,
  at: string,
  lost?: string[],
): { convention?: 'axis-sign' } {
  if (o.convention === undefined) return {};
  if (typeof o.convention === 'string' && PARAM_CONVENTIONS.has(o.convention))
    return { convention: o.convention as 'axis-sign' };
  lost?.push(`${at}convention`);
  return {};
}

// ---------------------------------------------------------------------------------------------
// The structural lints
// ---------------------------------------------------------------------------------------------

/** What the lints of one document share: where they report, and every wire the document names. */
interface LintContext {
  doc: SheetDoc;
  blocks: SheetBlock[];
  say: (severity: 'error' | 'warning', message: string, location: string) => void;
  err: (message: string, location: string) => void;
  /** Every wire named at this level, with what names it and how — the incidence rule counts
   *  terminals, element ends and a block's port map, and exempts held wires and ports; the gate
   *  rule asks whether anything but gates touches a wire. */
  touches: Map<string, { by: string; gate: boolean }[]>;
  touch: (w: string, by: string, gate?: boolean) => void;
  /** Reports a misspelt wire and says so; false for a wire spelt as one. */
  badWire: (w: unknown, where: string, location: string) => boolean;
  held: Set<string>;
  ports: Set<string>;
  elementNames: Set<string>;
}

/** A key of the document that must be a list: reported when it is anything else, and its items. */
function listAt(
  ctx: LintContext,
  key: 'elements' | 'ports' | 'analyses',
  message: string,
): unknown[] {
  const raw: unknown = ctx.doc[key];
  if (raw !== undefined && !Array.isArray(raw)) ctx.err(message, key);
  return Array.isArray(raw) ? raw : [];
}

/** One device's `nodes`: shape, spelling, shorts, and agreement with the device's diode flag. */
function placementProblems(
  ctx: LintContext,
  raw: unknown,
  who: string,
  location: string,
  givens: SheetGivens | undefined,
): void {
  const { err, say } = ctx;
  const list = placementsOf(raw);
  if (!list) {
    err(
      `${who}: nodes must be one placement {d, g, s, b} or a non-empty list of them` +
        (location === 'nodes' ? ', or "none"' : ''),
      location,
    );
    return;
  }
  list.forEach((placement, i) => {
    const p = placement as unknown as Record<string, unknown>;
    const at = list.length > 1 ? `${who}, placement ${i}` : who;
    for (const k of Object.keys(p))
      if (!NODE_KEYS.has(k))
        err(`${at}: nodes has unknown key "${k}" — a placement names d, g, s and b`, location);
    for (const t of TERMINALS) {
      if (p[t] === undefined)
        err(`${at}: nodes names no ${t} — every terminal sits on a wire`, location);
      else if (!ctx.badWire(p[t], at, location)) ctx.touch(p[t] as string, `${at} ${t}`, t === 'g');
    }
    if (p.intent !== undefined && p.intent !== 'off')
      err(`${at}: intent may only be "off", got ${JSON.stringify(p.intent)}`, location);
    if (typeof p.d === 'string' && p.d === p.s)
      err(`${at}: drain and source are both on wire "${p.d}", which shorts the device`, location);
    if (typeof p.g === 'string' && p.g === p.s && p.intent !== 'off')
      say(
        'warning',
        `${at}: gate and source are both on wire "${p.g}", which holds vgs at 0 — a device that ` +
          `is off. Say so with intent: "off" if that is meant`,
        location,
      );
  });
  const diodes = list.filter(isDiodePlacement).length;
  if (diodes && diodes < list.length)
    err(
      `${who}: some placements put the gate on the drain wire and some do not — one sizing is one ` +
        `operating point, so a diode-connected device and a device that is not are separate blocks`,
      location,
    );
  if (!givens) return;
  const diodeFlag: unknown = givens.diode;
  if (diodes === list.length && diodeFlag === false)
    err(
      `${who}: the nodes put the gate on the drain wire, which is a diode connection, but the ` +
        `givens say diode: false — drop the flag, or move the gate`,
      location,
    );
  if (diodes === 0 && diodeFlag === true)
    err(
      `${who}: the givens say diode: true, but the nodes put the gate on wire "${String(list[0]?.g)}" ` +
        `and the drain on "${String(list[0]?.d)}" — a diode connection is the gate on the drain ` +
        `wire. Drop the flag, or wire it`,
      location,
    );
}

/** The sheet's own device's `nodes`, and each block's: what wires which device, never twice. */
function blockWiringProblems(ctx: LintContext): void {
  const { doc, err } = ctx;
  if (doc.nodes !== undefined && doc.nodes !== 'none') {
    if (!doc.givens)
      err(
        `nodes on a document name the wires its own device sits on, and this document sizes no ` +
          `device — wire a child's device from its block instead`,
        'nodes',
      );
    placementProblems(ctx, doc.nodes, deviceName('givens'), 'nodes', doc.givens);
  }
  for (const b of ctx.blocks) {
    if (!b) continue;
    const who = `block "${b.name}"`;
    // A child that wires itself joins this sheet's walk through its ports, and must say where each
    // goes; one that does not is wired by its block's nodes. Never both.
    if (b.nodes !== undefined && b.ports !== undefined)
      err(
        `${who}: carries both nodes and ports — nodes wire a child that does not wire itself, ports ` +
          `connect one that does; keep the one that fits the child`,
        b.name,
      );
    // (A sheet that states no wiring of its own, or declares "none", is refused for composing such
    // a child by composedWiringProblems, which names the ports itself.)
    const theirs: unknown = b.doc?.ports;
    if (
      b.nodes === undefined &&
      b.ports === undefined &&
      statesWiring(doc) &&
      doc.nodes !== 'none' &&
      flattened(b.doc) &&
      Array.isArray(theirs) &&
      theirs.length
    )
      err(
        `${who}: the child wires itself and declares ports ${theirs.map((w) => `"${String(w)}"`).join(', ')}, ` +
          `so its wiring joins this sheet's — map each port in ports, to a wire here or to null for ` +
          `one left open`,
        b.name,
      );
    if (b.nodes === undefined) continue;
    if (b.doc && !b.doc.givens)
      err(
        `${who}: nodes name the wires a child's device sits on, and this child sizes no device`,
        b.name,
      );
    if (b.doc && wiresOwnDevice(b.doc))
      err(
        `${who}: the child wires its own device (its own nodes), so this block cannot wire it ` +
          `again — connect the child through its ports instead`,
        b.name,
      );
    placementProblems(ctx, b.nodes, who, b.name, b.doc?.givens);
  }
}

/** Elements: each end is a terminal for the incidence rule; values are checked for shape here and
 *  for what they read by validation (see configEligibility). */
function elementProblems(ctx: LintContext): void {
  const { err } = ctx;
  for (const [i, e] of listAt(ctx, 'elements', 'elements must be a list').entries()) {
    const where = `element ${isObject(e) && typeof e.name === 'string' ? `"${e.name}"` : i}`;
    if (!isObject(e)) {
      err(`${where}: an element is an object {name, kind, between, value}`, 'elements');
      continue;
    }
    for (const k of Object.keys(e))
      if (!ELEMENT_KEYS.has(k)) err(`${where}: unknown key "${k}"`, 'elements');
    if (typeof e.name !== 'string' || !IDENTIFIER.test(e.name))
      err(`${where}: name must be an identifier`, 'elements');
    else if (ctx.elementNames.has(e.name)) err(`${where}: the name is used twice`, 'elements');
    else ctx.elementNames.add(e.name);
    if (!ELEMENT_KINDS.has(e.kind as string))
      err(
        `${where}: kind must be one of ${[...ELEMENT_KINDS].join(', ')}, got ${JSON.stringify(e.kind)}`,
        'elements',
      );
    if (!Array.isArray(e.between) || e.between.length !== 2)
      err(`${where}: between must name two wires [from, to]`, 'elements');
    else
      for (const w of e.between)
        if (!ctx.badWire(w, where, 'elements')) ctx.touch(w as string, where);
    const v = e.value;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) err(`${where}: value must be finite`, 'elements');
      else if (e.kind === 'R' && !(v > 0))
        err(`${where}: a resistance must be greater than 0`, 'elements');
      else if (e.kind === 'C' && !(v >= 0))
        err(`${where}: a capacitance must not be negative`, 'elements');
    } else if (typeof v !== 'string' || !parses(v))
      err(`${where}: value must be a number or an expression that parses`, 'elements');
  }
}

/** Ports — the wires a parent may connect, exempt from incidence since the other end is outside —
 *  and each block's port map, which is exact: every port the child declares, mapped to a wire here
 *  or to null. */
function portProblems(ctx: LintContext): void {
  const { err } = ctx;
  for (const w of listAt(ctx, 'ports', 'ports must be a list of wires')) {
    if (ctx.badWire(w, 'ports', 'ports')) continue;
    if (ctx.ports.has(w as string)) err(`ports: "${w}" is listed twice`, 'ports');
    ctx.ports.add(w as string);
  }
  for (const b of ctx.blocks) {
    if (!b || b.ports === undefined) continue;
    const who = `block "${b.name}"`;
    const map: unknown = b.ports;
    if (!isObject(map)) {
      err(`${who}: ports must map each of the child's ports to a wire, or to null`, b.name);
      continue;
    }
    for (const v of Object.values(map))
      if (v !== null && !ctx.badWire(v, who, b.name)) ctx.touch(v as string, `${who} port`);
    if (!b.doc) continue; // a reference: its ports arrive with it, and are checked then
    const declared: unknown = b.doc.ports;
    const theirs = new Set(
      Array.isArray(declared) ? declared.filter((x) => typeof x === 'string') : [],
    );
    for (const k of Object.keys(map))
      if (!theirs.has(k))
        err(`${who}: ports maps "${k}", which the child does not declare as a port`, b.name);
    for (const k of theirs)
      if (!Object.prototype.hasOwnProperty.call(map, k))
        err(
          `${who}: ports does not map the child's port "${k}" — every port is mapped, to a wire or to ` +
            `null for one left open`,
          b.name,
        );
  }
}

/** Held wires: spelt, not gnd, and named by something on the sheet. */
function levelProblems(ctx: LintContext): void {
  const { err } = ctx;
  const levels: unknown = ctx.doc.levels;
  if (levels !== undefined && !isObject(levels))
    err('levels must map each held wire to an expression', 'levels');
  for (const [w, e] of Object.entries(isObject(levels) ? levels : {})) {
    if (w === GROUND) {
      err(`levels: "${GROUND}" is the reference at 0 and is not listed`, 'levels');
      continue;
    }
    if (ctx.badWire(w, 'levels', 'levels')) continue;
    ctx.held.add(w);
    if (typeof e !== 'string' || !parses(e))
      err(`levels "${w}": the level must be an expression that parses`, 'levels');
    if (!ctx.touches.has(w) && !ctx.ports.has(w))
      err(
        `levels holds wire "${w}", which no terminal, element or port of this sheet names`,
        'levels',
      );
  }
}

/** Incidence: a wire joins two terminals, or is held, or is a port — one terminal on a wire of its
 *  own is nearly always a misspelt name. And a wire only gates touch draws no current and is set by
 *  nothing on the sheet: the walk would read its level off one gate's vgs and report it clean, so
 *  something holds it, drives it (a diode, a bias device, a port to whatever does), or the sheet is
 *  missing that device. */
function incidenceProblems(ctx: LintContext): void {
  const open = (w: string): boolean => w !== GROUND && !ctx.held.has(w) && !ctx.ports.has(w);
  for (const [w, by] of ctx.touches)
    if (open(w) && by.length < 2)
      ctx.err(
        `wire "${w}" is named by one terminal only (${by[0].by}) — a wire joins two terminals or ` +
          `more, or is held in levels, or is a port; a misspelt name is the usual cause`,
        'nodes',
      );
  for (const [w, by] of ctx.touches)
    if (open(w) && by.length > 1 && by.every((t) => t.gate))
      ctx.say(
        'warning',
        `wire "${w}" is touched only by gates (${by.map((t) => t.by).join(', ')}), so nothing on the ` +
          `sheet sets its level — hold it in levels, make it a port, or wire the device that drives it`,
        'nodes',
      );
}

/** An abstract sheet has no wiring at all. */
function noneExclusivity(ctx: LintContext): void {
  const { doc } = ctx;
  if (doc.nodes !== 'none') return;
  const also = [
    ...(['levels', 'elements', 'analyses'] as const).filter((k) => doc[k] !== undefined),
    ...ctx.blocks.filter((b) => b?.nodes !== undefined).map((b) => `block "${b.name}" nodes`),
  ];
  if (also.length)
    ctx.err(
      `nodes: "none" says this sheet is not a circuit, so it carries no wiring — drop ${also.join(', ')}, ` +
        `or drop "none"`,
      'nodes',
    );
}

/** Analyses: shapes, and names that collide with nothing else in the sheet's namespace. */
function analysisProblems(ctx: LintContext): void {
  const { doc, err } = ctx;
  const analyses = listAt(ctx, 'analyses', 'analyses must be a list');
  const taken = new Set<string>([
    ...(Array.isArray(doc.params) ? doc.params : []).map((p) => p.name),
    ...(Array.isArray(doc.equations) ? doc.equations : []).map((e) => e.name),
    ...ctx.elementNames,
    ...Object.keys(CONSTANTS),
    ...(doc.givens ? DEVICE_NAMES : []),
    ...ctx.blocks.flatMap((b) => (b ? providedNames(b) : [])),
  ]);
  const wires = new Set([...ctx.touches.keys(), ...ctx.held, ...ctx.ports, GROUND]);
  for (const [i, a] of analyses.entries()) {
    const where = `analysis ${isObject(a) && typeof a.name === 'string' ? `"${a.name}"` : i}`;
    if (!isObject(a)) {
      err(`${where}: an analysis is an object with a name and a kind`, 'analyses');
      continue;
    }
    const shape = ANALYSIS_SHAPES[a.kind as string];
    if (!shape) {
      err(
        `${where}: kind must be one of ${Object.keys(ANALYSIS_SHAPES).join(', ')}, got ${JSON.stringify(a.kind)}`,
        'analyses',
      );
      continue;
    }
    for (const k of Object.keys(a))
      if (!shape.required.includes(k) && !shape.optional.includes(k))
        err(`${where}: a ${a.kind} analysis has no key "${k}"`, 'analyses');
    for (const k of shape.required)
      if (a[k] === undefined) err(`${where}: ${k} is required`, 'analyses');
    if (typeof a.name !== 'string' || !IDENTIFIER.test(a.name))
      err(`${where}: name must be an identifier`, 'analyses');
    else if (taken.has(a.name))
      err(
        `${where}: the name is already a param, equation, device quantity, provided name, constant or element`,
        'analyses',
      );
    else taken.add(a.name);
    for (const k of ['in', 'out'] as const) {
      if (a[k] === undefined || !shape.required.includes(k)) continue;
      const m = a[k];
      if (!isObject(m) || Object.keys(m).length === 0) {
        err(`${where}: ${k} maps at least one wire to a number`, 'analyses');
        continue;
      }
      for (const [w, c] of Object.entries(m)) {
        if (!wires.has(w))
          err(`${where}: ${k} names wire "${w}", which this sheet does not`, 'analyses');
        if (typeof c !== 'number' || !Number.isFinite(c))
          err(`${where}: ${k}["${w}"] must be a finite number`, 'analyses');
      }
    }
    if (a.kind === 'impedance' && a.node !== undefined && !wires.has(a.node as string))
      err(`${where}: node "${String(a.node)}" is not a wire of this sheet`, 'analyses');
    if (a.at !== undefined) {
      const ok =
        typeof a.at === 'number'
          ? Number.isFinite(a.at) && a.at > 0
          : typeof a.at === 'string' && parses(a.at);
      if (!ok)
        err(`${where}: at must be a positive frequency, a number or an expression`, 'analyses');
    }
    if (a.as !== undefined && !(shape.as ?? []).includes(a.as as string))
      err(`${where}: as must be one of ${(shape.as ?? []).join(', ')}`, 'analyses');
    if (a.breakdown !== undefined && typeof a.breakdown !== 'boolean')
      err(`${where}: breakdown must be true or false`, 'analyses');
  }
}

/** Axis-sign selectors: declared, exactly +1 or -1, and read by a bias axis. */
function selectorDeclProblems(ctx: LintContext): void {
  const { doc, err } = ctx;
  const params = Array.isArray(doc.params) ? doc.params : [];
  // The selectors of this sheet some bias axis reads: its own device's, or a child's through the
  // child's override.
  const read = new Set(
    [
      ...selectorReads(doc, [], doc.givens),
      ...ctx.blocks.flatMap((b) => (b?.doc ? selectorReads(doc, [b], b.doc.givens) : [])),
    ]
      .filter((r) => r.chain.length === 0)
      .map((r) => r.name),
  );
  for (const p of params) {
    const c: unknown = p.convention;
    if (c === undefined) continue;
    if (typeof c !== 'string' || !PARAM_CONVENTIONS.has(c)) {
      err(`param "${p.name}": convention must be "axis-sign", got ${JSON.stringify(c)}`, p.name);
      continue;
    }
    if (p.value !== 1 && p.value !== -1)
      err(
        `param "${p.name}" is an axis-sign selector, so its value is exactly +1 (an N-style table) or ` +
          `-1 (a signed p export), got ${p.value}`,
        p.name,
      );
    if (!read.has(p.name))
      err(
        `param "${p.name}" is declared an axis-sign selector, but no bias-axis expression (a vgs, vds ` +
          `or vsb given) reads it`,
        p.name,
      );
  }
}

/**
 * The structural lints on one document's netlist (format version 2 only; validation recurses
 * into children). Shapes and spelling only — every wire named, nothing misspelt, no short, the
 * diode flag agreeing with the wires — so a sheet is never reported as wiring-checked when its
 * wiring could not be read. Whether a held level may be held at all is a question about the
 * whole tree and is asked by validation (see levelEligibility); everything that needs numbers is
 * the DC walk's.
 */
export function nodesProblems(doc: SheetDoc): QAWarning[] {
  const out: QAWarning[] = [];
  const say = (severity: 'error' | 'warning', message: string, location: string): void => {
    out.push({ rule: 'sheet-nodes', severity, message, location });
  };
  const err = (message: string, location: string): void => say('error', message, location);
  const touches = new Map<string, { by: string; gate: boolean }[]>();
  const ctx: LintContext = {
    doc,
    blocks: Array.isArray(doc.blocks) ? doc.blocks : [],
    say,
    err,
    touches,
    touch: (w, by, gate = false) => {
      if (!wireOk(w)) return;
      const list = touches.get(w) ?? [];
      list.push({ by, gate });
      touches.set(w, list);
    },
    badWire: (w, where, location) => {
      if (wireOk(w)) return false;
      err(
        typeof w === 'string' && w.includes(PROVIDE_SEP)
          ? `${where}: wire "${w}" contains "${PROVIDE_SEP}", which joins a child's names to its block`
          : `${where}: a wire is named by an identifier (letters, digits, _), got ${JSON.stringify(w)}`,
        location,
      );
      return true;
    },
    held: new Set(),
    ports: new Set(),
    elementNames: new Set(),
  };
  blockWiringProblems(ctx);
  elementProblems(ctx);
  portProblems(ctx);
  levelProblems(ctx);
  incidenceProblems(ctx);
  noneExclusivity(ctx);
  analysisProblems(ctx);
  selectorDeclProblems(ctx);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The devices of a tree, and the refusal of a tree that names no wiring
// ---------------------------------------------------------------------------------------------

/** One sized device of a sheet tree, and the wires it sits on as they are written. */
interface TreeDevice {
  /** `givens` for the top sheet's own device, else its block path (PATH_SEP between blocks). */
  name: string;
  givens: SheetGivens;
  /** The blocks from the top sheet down to the sheet that sizes the device. */
  chain: SheetBlock[];
  /** The index of each of those blocks in its parent's `blocks` — where its evaluation report is. */
  at: number[];
  /** The placements: the sizing sheet's own `nodes`, else the composing block's (see deviceWires). */
  placements?: DeviceNodes[];
  /** The block path of the sheet the placements are written in: the sizing sheet's own for its own
   *  `nodes`, the composing sheet's for a block's. For a device that names none, the sheet whose
   *  walk asks after it: its own where it is the top or joins its parent's walk, else its parent. */
  placedIn: string;
}

/** Every sized device of `doc`'s tree in preorder (see TreeDevice) — the one enumeration of "a
 *  device's wires are its own `nodes`, otherwise its block's", read by the refusal of an unwired
 *  tree, by the walk, and by validation's held-gate rule. A document that declares
 *  `nodes: "none"` is not a circuit: nothing below it is listed, nor its own device unless the
 *  block composing it wires it. */
function treeDevices(doc: SheetDoc): TreeDevice[] {
  const out: TreeDevice[] = [];
  const visit = (d: SheetDoc, chain: SheetBlock[], at: number[], parent?: SheetDoc): void => {
    const none = formatOf(d) === 2 && d.nodes === 'none';
    const path = chain.map((b) => b.name).join(PATH_SEP);
    const block = chain[chain.length - 1];
    const byBlock = parent && block ? placementsOf(blockWires(parent, block)) : undefined;
    if (d.givens && !(none && !byBlock)) {
      const own = formatOf(d) === 2 ? placementsOf(d.nodes) : undefined;
      const ownWalk = !parent || flattened(d);
      out.push({
        name: path || 'givens',
        givens: d.givens,
        chain,
        at,
        ...((own ?? byBlock) ? { placements: own ?? byBlock } : {}),
        placedIn:
          own || (!byBlock && ownWalk)
            ? path
            : chain
                .slice(0, -1)
                .map((b) => b.name)
                .join(PATH_SEP),
      });
    }
    if (none || chain.length >= MAX_BLOCK_DEPTH) return;
    (Array.isArray(d.blocks) ? d.blocks : []).forEach((b, i) => {
      if (b?.doc) visit(b.doc, [...chain, b], [...at, i], d);
    });
  };
  visit(doc, [], []);
  return out;
}

/** Every sized device in `doc`'s tree that names no wires, by block path (`givens` for the sheet's
 *  own; see treeDevices). */
export const unwiredDevices = (doc: SheetDoc): string[] =>
  treeDevices(doc)
    .filter((d) => !d.placements)
    .map((d) => d.name);

/**
 * The refusal of a sheet that names no wiring, raised at the top of a tree. A sheet either names
 * the wires every sized device sits on, or declares `nodes: "none"` when it is not a circuit; there
 * is no third state in which wiring is simply not checked, and the rule has no off switch.
 */
export function wiringRefusal(doc: SheetDoc): QAWarning[] {
  const unwired = unwiredDevices(doc);
  if (!unwired.length) return [];
  return [
    {
      rule: 'sheet-nodes',
      severity: 'error',
      message:
        `this sheet names no wiring for ${unwired.map(deviceName).join(', ')} — every sized device ` +
        `names the wires it sits on (nodes), or the sheet declares nodes: "none" when it is not a ` +
        `circuit; ${MIGRATION_HINT}` +
        (formatOf(doc) === 'earlier' ? `; wiring needs "formatVersion": ${FORMAT_VERSION}` : ''),
      location: 'nodes',
    },
  ];
}

/** The ports a child declares, as written (strings only). */
const declaredPorts = (child: SheetDoc): string[] =>
  Array.isArray(child.ports) ? child.ports.filter((w): w is string => typeof w === 'string') : [];

/**
 * The refusal of a sheet that composes a child stating wiring without stating its own. A child's
 * wiring is checked only as part of its parent's walk, through the port map that says which wire
 * of the parent each of its ports is; a parent that states no wiring, or declares
 * `nodes: "none"` — though it contains the child's circuit — leaves that check with nothing to
 * read. So a document that composes such a child states wiring itself, in format version 2, and
 * connects the child through the block's `ports`, each port mapped (portProblems holds a written
 * map to exactly that). One error per such block, naming the child and the ports left unmapped.
 *
 * A block that references a library sheet and has not been resolved carries no child to judge:
 * the rule is applied where the reference is resolved — runSheet and the condition runs validate
 * the resolved document.
 */
export function composedWiringProblems(doc: SheetDoc): QAWarning[] {
  const format = formatOf(doc);
  if (format === 'unknown') return [];
  const none = format === 2 && doc.nodes === 'none';
  const own = statesWiring(doc);
  if (own && !none) return [];
  const out: QAWarning[] = [];
  for (const b of Array.isArray(doc.blocks) ? doc.blocks : []) {
    if (!b?.doc || !statesWiring(b.doc)) continue;
    const map = isObject(b.ports) ? b.ports : {};
    const unmapped = declaredPorts(b.doc).filter(
      (w) => !Object.prototype.hasOwnProperty.call(map, w),
    );
    // How to connect the child, where its block does not yet: every port it declares mapped, or
    // an empty map for a child that declares none. Nothing to add where its ports are all mapped.
    const many = unmapped.length > 1;
    const connect = unmapped.length
      ? `: connect it through the block's ports, mapping its ${many ? 'ports' : 'port'} ` +
        `${unmapped.map((w) => `"${w}"`).join(', ')} to ${many ? 'wires' : 'a wire'} here ` +
        `(or to null for one left open)`
      : b.ports === undefined
        ? `: connect it through the block's ports (an empty map, {}, where it declares none)`
        : '';
    out.push({
      rule: 'sheet-nodes',
      severity: 'error',
      message: none
        ? `block "${b.name}": the child states wiring, so this sheet contains a circuit and ` +
          `cannot declare nodes: "none" — state this sheet's wiring instead${connect}`
        : `block "${b.name}": the child states wiring and this sheet states none, so the child's ` +
          `wiring would be checked against nothing — a child's wiring is checked as part of its ` +
          `parent's${connect}` +
          (format === 'earlier' ? `; wiring needs "formatVersion": ${FORMAT_VERSION}` : ''),
      location: b.name,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The devices a walk reads
// ---------------------------------------------------------------------------------------------

/** The value of an expression in a scope, or undefined where it is not a string, does not
 *  evaluate, or is not finite. */
function valueIn(src: unknown, scope: Scope): number | undefined {
  if (typeof src !== 'string') return undefined;
  try {
    const v = compileExpr(src).eval(scope);
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The directions of a table's axes, read once per table (they depend on nothing else). */
/** Each table's axis directions by axis name, worked out once per table (see axisDirection). */
const AXIS_DIRECTION = new WeakMap<DeviceTable, Map<string, 1 | -1 | undefined>>();

/** The direction of a table's axis `name`: +1 where it holds no negative value, -1 where it holds
 *  no positive one (a signed p export), undefined where it holds both or is absent. The one rule
 *  the wiring walk reads the vgs axis by (DevicePoint.axis) and the region check the vds axis. */
export function axisDirection(table: DeviceTable, name: string): 1 | -1 | undefined {
  let byAxis = AXIS_DIRECTION.get(table);
  if (!byAxis) AXIS_DIRECTION.set(table, (byAxis = new Map()));
  if (byAxis.has(name)) return byAxis.get(name);
  const values = table.grid.axes.find((a) => a.name === name)?.values;
  let dir: 1 | -1 | undefined;
  if (values?.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    dir = lo >= 0 ? 1 : hi <= 0 ? -1 : undefined;
  }
  byAxis.set(name, dir);
  return dir;
}

const AXIS_CACHE = new WeakMap<DeviceTable, { axis?: 1 | -1; bodyAxis: 1 | -1 }>();

/** The direction of a table's vgs axis (axisDirection; see DevicePoint.axis), and of its vsb axis
 *  (-1 where it holds a negative value, +1 otherwise — a magnitude, or no vsb axis at all; see
 *  DevicePoint.bodyAxis). */
function axesOf(table: DeviceTable | undefined): { axis?: 1 | -1; bodyAxis: 1 | -1 } {
  if (!table) return { bodyAxis: 1 };
  const cached = AXIS_CACHE.get(table);
  if (cached) return cached;
  const axis = axisDirection(table, 'vgs');
  const vsb = table.grid.axes.find((a) => a.name === 'vsb')?.values;
  let bodyAxis: 1 | -1 = 1;
  if (vsb) for (const v of vsb) if (v < 0) bodyAxis = -1;
  const out = { ...(axis !== undefined ? { axis } : {}), bodyAxis };
  AXIS_CACHE.set(table, out);
  return out;
}

/**
 * One sized device as the wiring walk reads it (see DevicePoint), from its sheet's finished
 * evaluation: the sized gate-source voltage, the drain and body voltages the givens state —
 * evaluated against the finished scope — and its current and sensitivities. Undefined when the
 * device did not size or a stated voltage does not evaluate. A diode connection's drain voltage is
 * its gate-source voltage.
 */
function devicePoint(
  doc: SheetDoc,
  res: SheetResult,
  table: DeviceTable | undefined,
): DevicePoint | undefined {
  const s = res.sizing;
  const g = doc.givens;
  if (!g || !s?.ok || !Number.isFinite(s.vgs) || !Number.isFinite(s.id)) return undefined;
  const scope = scalarScope(res.values);
  const vds = g.diode === true ? s.vgs : valueIn(g.vds, scope);
  const vsb = g.vsb === undefined ? 0 : valueIn(g.vsb, scope);
  if (vds === undefined || vsb === undefined) return undefined;
  const sensitivities: Partial<Record<'gm' | 'gds' | 'gmb', number>> = {};
  for (const q of ['gm', 'gds', 'gmb'] as const)
    if (Number.isFinite(res.values[q])) sensitivities[q] = res.values[q];
  return {
    vgs: s.vgs,
    vds,
    vsb,
    id: Math.abs(s.id),
    ...sensitivities,
    ...axesOf(table),
    polarity: doc.polarity === 'p' ? 'p' : 'n',
  };
}

// ---------------------------------------------------------------------------------------------
// The DC walk
// ---------------------------------------------------------------------------------------------

/** The canonical order of relation kinds: the synthetic ground relation first. */
export const RELATION_KINDS = { ground: 0, placement: 1, element: 2, anchor: 3 } as const;

/**
 * One relation of the walk: V(a) - V(b) = value, its two wires in sorted order (the value's sign
 * normalized to that orientation; a == b for a relation from a wire to itself). Its key — the wire
 * pair, the kind, the instance path of the sheet that declares it, then the tie (a placement's
 * device, index and terminal pair; an element's name; an anchor's wire as authored) — is total, so
 * nothing anywhere falls back to the order relations were written in.
 */
export interface WalkRelation {
  a: string;
  b: string;
  value: number;
  kind: number;
  inst: string;
  tie: string;
  label: string;
  /** The value as a linear form over params and device quantities (see linearForm). */
  sym: Poly;
  /** For a placement relation: whose, which pair, and the sensitivity that converts a voltage
   *  error on it to a fractional current error (gm/ID, gds/ID or gmb/ID). */
  terminal?: { device: string; pair: 'gs' | 'ds' | 'bs'; sensitivity?: number };
}

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
const relCmp = (x: WalkRelation, y: WalkRelation): number =>
  cmp(x.a, y.a) || cmp(x.b, y.b) || x.kind - y.kind || cmp(x.inst, y.inst) || cmp(x.tie, y.tie);

/** A relation V(from) - V(to) = value, oriented to its sorted wire pair. */
export function relation(
  from: string,
  to: string,
  value: number,
  sym: Poly,
  rest: Omit<WalkRelation, 'a' | 'b' | 'value' | 'sym'>,
): WalkRelation {
  if (cmp(from, to) <= 0) return { a: from, b: to, value, sym, ...rest };
  return { a: to, b: from, value: -value, sym: scale(sym, -1), ...rest };
}

/** One biconnected block of the relation graph, with its canonical spanning tree. */
export interface WalkBlock {
  wires: string[];
  relations: WalkRelation[];
  /** Local potentials, for residuals inside this block only. */
  phi: Map<string, number>;
  /** Each tree wire's parent and the relation to it. */
  parent: Map<string, { wire: string; rel: WalkRelation }>;
  chords: { rel: WalkRelation; residual: number; row: Poly; cycle: WalkRelation[] }[];
  consistent: boolean;
  closureError: number;
}

/** What the walk found: its blocks, the level of every wire a seed reaches through blocks that
 *  close, the wires reached only through a block that does not, and the groups no seed reaches. */
export interface WalkResult {
  blocks: WalkBlock[];
  levels: Map<string, { level: number; seed: boolean; via: string[] }>;
  tainted: string[];
  floating: string[][];
}

/** A linear form with every coefficient below this size dropped: what is left of a cancellation
 *  that rounding did not quite finish. */
const SYM_ZERO = 1e-12;

/** The weighted sum of linear forms, less what rounding left of a cancellation. */
function combine(terms: [Poly, number][]): Poly {
  let out: Poly = new Map();
  for (const [p, k] of terms) out = add(out, p, k);
  for (const [m, c] of out) if (Math.abs(c) < SYM_ZERO) out.delete(m);
  return out;
}

/** A union-find over string keys: each key's representative, and the join of two sets. */
export function unionFind(): {
  find: (x: string) => string;
  union: (x: string, y: string) => void;
} {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as string;
    for (let y = x; y !== r;) {
      const next = parent.get(y) as string;
      parent.set(y, r);
      y = next;
    }
    return r;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(ry, rx);
  };
  return { find, union };
}

/** The relation graph the walk reads: relations in key order, wires sorted, and each wire's
 *  relations to other wires in key order. */
interface WalkGraph {
  rels: WalkRelation[];
  wires: string[];
  adj: Map<string, number[]>;
  other: (i: number, w: string) => string;
}

/** The biconnected blocks of the graph (Tarjan), each as its relation indices in key order, in
 *  order of each block's first relation. Parallel relations are distinct edges, so a pair of wires
 *  joined twice is one block with a chord; a relation from a wire to itself is a block of its own:
 *  one chord, no tree. */
function biconnectedBlocks(g: WalkGraph): number[][] {
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: number[] = [];
  const edgeBlocks: number[][] = [];
  let time = 0;
  const dfs = (u: string, via: number): void => {
    disc.set(u, ++time);
    low.set(u, time);
    for (const i of g.adj.get(u) ?? []) {
      if (i === via) continue;
      const v = g.other(i, u);
      if (!disc.has(v)) {
        stack.push(i);
        dfs(v, i);
        low.set(u, Math.min(low.get(u) as number, low.get(v) as number));
        if ((low.get(v) as number) >= (disc.get(u) as number)) {
          const block: number[] = [];
          let e: number;
          do {
            e = stack.pop() as number;
            block.push(e);
          } while (e !== i);
          edgeBlocks.push(block);
        }
      } else if ((disc.get(v) as number) < (disc.get(u) as number)) {
        stack.push(i);
        low.set(u, Math.min(low.get(u) as number, disc.get(v) as number));
      }
    }
  };
  for (const w of g.wires) if (!disc.has(w)) dfs(w, -1);
  g.rels.forEach((r, i) => {
    if (r.a === r.b) edgeBlocks.push([i]);
  });
  for (const b of edgeBlocks) b.sort((x, y) => x - y);
  return edgeBlocks.sort((x, y) => x[0] - y[0]);
}

/** Breadth-first from `start` over wires and blocks: each block a wire belongs to is offered to
 *  `enter` (with the wire it is reached through), and the wires of every block it accepts are
 *  queued once. */
function bfsBlocks(
  start: string,
  wireBlocks: ReadonlyMap<string, number[]>,
  blockWires: readonly string[][],
  enter: (k: number, from: string) => boolean,
): void {
  const queued = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const u = queue.shift() as string;
    for (const k of wireBlocks.get(u) ?? []) {
      if (!enter(k, u)) continue;
      for (const w of blockWires[k])
        if (!queued.has(w)) {
          queued.add(w);
          queue.push(w);
        }
    }
  }
}

/** The relations of a spanning tree on the path between two of its wires, from `from` up to their
 *  common ancestor and down to `to`. */
function treePathRels(
  parent: ReadonlyMap<string, { wire: string; rel: WalkRelation }>,
  from: string,
  to: string,
): WalkRelation[] {
  const up = (w: string): string[] => {
    const out = [w];
    for (let x = w; parent.has(x); x = (parent.get(x) as { wire: string }).wire)
      out.push((parent.get(x) as { wire: string }).wire);
    return out;
  };
  const a = up(from);
  const b = up(to);
  const common = a.find((w) => b.includes(w)) as string;
  const relOf = (w: string): WalkRelation => (parent.get(w) as { rel: WalkRelation }).rel;
  return [
    ...a.slice(0, a.indexOf(common)).map(relOf),
    ...b.slice(0, b.indexOf(common)).map(relOf).reverse(),
  ];
}

/** One block's spanning tree, grown breadth-first from `root` taking relations in key order, with
 *  every chord's residual and fundamental cycle. */
function spanBlock(g: WalkGraph, edges: number[], wires: string[], root: string): WalkBlock {
  const phi = new Map<string, number>([[root, 0]]);
  const phiSym = new Map<string, Poly>([[root, new Map()]]);
  const parent = new Map<string, { wire: string; rel: WalkRelation }>();
  const tree = new Set<number>();
  const inBlock = new Set(edges);
  const queue = [root];
  while (queue.length) {
    const u = queue.shift() as string;
    for (const i of g.adj.get(u) ?? []) {
      if (!inBlock.has(i) || tree.has(i)) continue;
      const v = g.other(i, u);
      if (phi.has(v)) continue;
      const r = g.rels[i];
      // V(a) - V(b) = value: stepping from a to b subtracts it, from b to a adds it.
      const k = u === r.a ? -1 : 1;
      phi.set(v, (phi.get(u) as number) + k * r.value);
      phiSym.set(
        v,
        combine([
          [phiSym.get(u) as Poly, 1],
          [r.sym, k],
        ]),
      );
      parent.set(v, { wire: u, rel: r });
      tree.add(i);
      queue.push(v);
    }
  }
  const chords = edges
    .filter((i) => !tree.has(i))
    .map((i) => {
      const rel = g.rels[i];
      const residual = (phi.get(rel.a) ?? 0) - (phi.get(rel.b) ?? 0) - rel.value;
      const row = combine([
        [phiSym.get(rel.a) ?? new Map(), 1],
        [phiSym.get(rel.b) ?? new Map(), -1],
        [rel.sym, -1],
      ]);
      // The fundamental cycle: the chord and the tree path between its ends.
      return {
        rel,
        residual,
        row,
        cycle: [...treePathRels(parent, rel.a, rel.b), rel].sort(relCmp),
      };
    });
  const closureError = Math.max(0, ...chords.map((c) => Math.abs(c.residual)));
  return {
    wires,
    relations: edges.map((i) => g.rels[i]),
    phi,
    parent,
    chords,
    consistent: closureError <= NODE_TOL,
    closureError,
  };
}

/**
 * The walk over a set of relations and seeds (gnd and each held wire, at the level it is held
 * at). Pure, and independent of the order the relations arrive in.
 *
 * The relation graph (wires plus the virtual reference) is decomposed into biconnected blocks —
 * unique, so membership depends on nothing but the graph. In each block a spanning tree is grown
 * breadth-first, taking relations in key order, from the block's canonically first seed; a block
 * with no seed grows from the wire through which it attaches toward a seed, and a block in a
 * component with no seed from its first wire. Every relation not in the tree is a chord, and its
 * residual r = V(a) - V(b) - value, read off the tree's local potentials, is that loop's misfit. A
 * block is consistent when every chord is within NODE_TOL; its closure error is its largest |r|.
 *
 * Levels are then reported, never fitted: a seed at its authored level, whatever its block's tree
 * says; every other wire by walking the trees from the canonically first seed that reaches it
 * through consistent blocks, entering each block at the reported level of the wire it shares with
 * the last. A wire a seed reaches only through a block that does not close is tainted and gets no
 * value; a component with no seed is one floating degree of freedom.
 */
export function dcWalk(
  input: readonly WalkRelation[],
  seeds: ReadonlyMap<string, number>,
): WalkResult {
  const rels = [...input].sort(relCmp);
  const wires = [...new Set([...rels.flatMap((r) => [r.a, r.b]), ...seeds.keys()])].sort(cmp);
  const seedOrder = [...seeds.keys()].sort(cmp);
  // Adjacency over the relations that join two different wires, in key order.
  const adj = new Map<string, number[]>(wires.map((w) => [w, []]));
  rels.forEach((r, i) => {
    if (r.a === r.b) return;
    adj.get(r.a)?.push(i);
    adj.get(r.b)?.push(i);
  });
  const g: WalkGraph = {
    rels,
    wires,
    adj,
    other: (i, w) => (rels[i].a === w ? rels[i].b : rels[i].a),
  };
  const edgeBlocks = biconnectedBlocks(g);

  // Components, for seeds and floating groups.
  const comps = unionFind();
  for (const r of rels) comps.union(r.a, r.b);
  const find = comps.find;

  const blockWires = edgeBlocks.map((b) =>
    [...new Set(b.flatMap((i) => [rels[i].a, rels[i].b]))].sort(cmp),
  );
  const wireBlocks = new Map<string, number[]>(wires.map((w) => [w, []]));
  edgeBlocks.forEach((b, k) => {
    if (rels[b[0]].a === rels[b[0]].b) return; // a self-relation joins nothing
    for (const w of blockWires[k]) wireBlocks.get(w)?.push(k);
  });

  // The wire each seedless block is entered through, walking the block-cut tree from each
  // component's canonically first seed.
  const entry = new Map<number, string>();
  const reachedFirst = new Set<string>();
  for (const s of seedOrder) {
    if (reachedFirst.has(find(s))) continue;
    reachedFirst.add(find(s));
    const seen = new Set<number>();
    bfsBlocks(s, wireBlocks, blockWires, (k, u) => {
      if (seen.has(k)) return false;
      seen.add(k);
      entry.set(k, u);
      return true;
    });
  }

  const blocks = edgeBlocks.map((b, k) => {
    const ws = blockWires[k];
    return spanBlock(g, b, ws, ws.find((w) => seeds.has(w)) ?? entry.get(k) ?? ws[0]);
  });

  // Reported levels.
  const levels = new Map<string, { level: number; seed: boolean; via: string[] }>();
  for (const s of seedOrder) levels.set(s, { level: seeds.get(s) as number, seed: true, via: [] });
  const entered = new Set<number>();
  for (const s of seedOrder)
    bfsBlocks(s, wireBlocks, blockWires, (k, u) => {
      const blk = blocks[k];
      if (entered.has(k) || !blk.consistent) return false;
      entered.add(k);
      const at = levels.get(u) as { level: number; via: string[] };
      for (const w of blk.wires)
        if (!levels.has(w))
          levels.set(w, {
            level: at.level + (blk.phi.get(w) as number) - (blk.phi.get(u) as number),
            seed: false,
            via: [...at.via, ...treePathRels(blk.parent, u, w).map((r) => r.label)],
          });
      return true;
    });

  const seededComps = new Set(seedOrder.map(find));
  const visible = wires.filter((w) => w !== REF);
  const tainted = visible.filter((w) => seededComps.has(find(w)) && !levels.has(w));
  const groups = new Map<string, string[]>();
  for (const w of visible)
    if (!seededComps.has(find(w))) groups.set(find(w), [...(groups.get(find(w)) ?? []), w]);
  levels.delete(REF);
  return { blocks, levels, tainted, floating: [...groups.values()] };
}

/** The constraints a walk's loops state beyond the sizing, counted by rank (see NodesReport.dof).
 *  A row that reduces to zero is a symbolic identity and is dropped; a row that merely holds at
 *  this point is kept and reported as satisfied. An undecided term is named by `display` where it
 *  has a name for a reader, by its canonical spelling otherwise. */
export function dofOf(
  walk: WalkResult,
  display: (atom: string) => string | undefined = () => undefined,
): NodesReport['dof'] {
  const rows = walk.blocks.flatMap((b) =>
    b.chords.filter((c) => c.row.size > 0).map((c) => ({ ...c, opaque: hasOpaque(c.row) })),
  );
  const ordered = [...rows.filter((r) => !r.opaque), ...rows.filter((r) => r.opaque)];
  const { independent } = rankOf(ordered.map((r) => r.row));
  const kept = independent.map((i) => ordered[i]);
  const undecided = [
    ...new Set(
      kept
        .filter((r) => r.opaque)
        .flatMap((r) => [...r.row.keys()].filter((m) => m.startsWith('~'))),
    ),
  ].map((m) => display(m) ?? m.slice(2, -1));
  return {
    proven: kept.filter((r) => !r.opaque).length,
    bound: kept.length,
    constraints: kept.map((r) => ({
      relations: r.cycle.map((c) => c.label),
      residual: r.residual,
      satisfied: Math.abs(r.residual) <= NODE_TOL,
      proven: !r.opaque,
    })),
    undecided,
  };
}

/** What a reader is told about the closure error, in these words wherever it is reported. */
export const CLOSURE_NOTE =
  'The closure error is the largest residual of a loop in this canonical basis of the relations, ' +
  'and nothing more: it is not an uncertainty on any level. A loop that uses k chords can sum to ' +
  'k times the tolerance, so inside a block that closes, a level read along another path, or two ' +
  'held wires compared along a path through several chords, can differ by more than the ' +
  'tolerance; each derived level is reported with the path it was derived along.';

const volts = (v: number): string => `${Number(v.toPrecision(4))} V`;

/** A current as a reader reads one: an SI prefix, `10 µA` rather than `0.00001 A`. */
export function amps(i: number): string {
  const s = formatSI(i);
  const m = /^(-?[\d.]+(?:e[+-]?\d+)?)(\D*)$/.exec(s);
  return m ? `${m[1]} ${m[2]}A` : `${s} A`;
}

/** A device the walk reads, at any level of the walk. */
interface WiredDevice {
  /** `givens` for the walk's own device; else the block path, dots between blocks. */
  name: string;
  /** Its placements' wires as the walk names them, through the port maps of the sheets it sits
   *  in. */
  wires: DeviceNodes[];
  givens: SheetGivens;
  point?: DevicePoint;
  why?: string;
  /** The blocks from the walk's sheet down to the sheet that sizes the device: where its own names
   *  resolve. */
  chain: SheetBlock[];
  /** The instance path of the sheet that declares the device's wires. */
  inst: string;
}

/** One sheet of the walk: the walk's own, or one whose wiring joins it (see flattened). */
interface WalkLevel {
  chain: SheetBlock[];
  doc: SheetDoc;
  report?: {
    blocks?: SheetBlockReport[];
    terminals?: DevicePoint;
    wiringValues?: WiringValues;
    sizing?: SheetResult['sizing'];
  };
  /** The instance path, dots between blocks; `''` for the walk's own sheet. */
  inst: string;
  /** A wire of this sheet as the walk names it. */
  rename: (w: string) => string;
}

/**
 * Read an expression anywhere in the walk as a polynomial over canonical atoms — the normalization
 * the rank count needs. `chain` is the path of blocks from the walk's sheet to the sheet the
 * expression is written in. A param of the walk's own sheet is itself (an input there, whatever a
 * parent wires into it); a param a parent overrides is the override, read where the parent writes
 * it; any other param is `block__name` along its path; a device quantity is the device's
 * (`vgs`, `block__vgs`), except a gate, drain or body voltage the device's givens state, which is
 * the stated expression; an equation, and anything else, is an opaque term. Constants fold.
 */
function symbolsOf(root: SheetDoc, rootValues: Record<string, number>) {
  const docAt = (chain: readonly SheetBlock[]): SheetDoc =>
    chain.length ? (chain[chain.length - 1].doc as SheetDoc) : root;
  /** A parent's override of `name` at the end of `chain` (see blockOverride). */
  const overrideOf = (chain: readonly SheetBlock[], name: string): string | undefined =>
    chain.length ? blockOverride(chain[chain.length - 1], name) : undefined;
  const visiting = new Set<string>();
  const guarded = (key: string, read: () => Poly): Poly => {
    if (visiting.has(key)) return atomPoly(`cycle(${key})`);
    visiting.add(key);
    try {
      return read();
    } finally {
      visiting.delete(key);
    }
  };
  const srcIn = (src: string, chain: readonly SheetBlock[]): Poly =>
    normalizeSrc(src, (n) => resolve(n, chain));
  const resolve = (name: string, chain: readonly SheetBlock[]): Poly | undefined => {
    const d = docAt(chain);
    const pre = providePrefix(chain);
    if (d.params.some((q) => q.name === name)) {
      const over = overrideOf(chain, name);
      return over !== undefined
        ? guarded(`${pre}${name}`, () => srcIn(over, chain.slice(0, -1)))
        : atomPoly(`${pre}${name}`);
    }
    if (d.equations.some((e) => e.name === name)) return atomPoly(`eq(${pre}${name})`);
    const split = splitProvide(name);
    if (split) {
      const kid = (Array.isArray(d.blocks) ? d.blocks : []).find((b) => b.name === split[0]);
      if (kid?.doc && (kid.doc.provides ?? []).includes(split[1]))
        return resolve(split[1], [...chain, kid]);
      return atomPoly(`sub(${pre}${name})`);
    }
    if (d.givens && DEVICE_NAMES.has(name)) {
      const given = (d.givens as unknown as Record<string, unknown>)[name];
      if ((AXIS_GIVENS as readonly string[]).includes(name) && typeof given === 'string')
        return guarded(`${pre}#${name}`, () => srcIn(given, chain));
      return atomPoly(`${pre}${name}`);
    }
    // Not a name of this sheet: an expression constant, or an unresolved term (see Resolver).
    return Object.prototype.hasOwnProperty.call(CONSTANTS, name)
      ? undefined
      : atomPoly(`unresolved(${pre}${name})`);
  };
  /** A param's value where `chain` ends: through each override up to the walk's sheet, whose
   *  evaluated values are known; a param nothing overrides below it is its own value. */
  const valueAt = (name: string, chain: readonly SheetBlock[]): number | undefined => {
    const p = docAt(chain).params.find((q) => q.name === name);
    if (!p) return undefined;
    const over = overrideOf(chain, name);
    if (over !== undefined) {
      const up = chain.slice(0, -1);
      return valueIn(over, {
        resolve: (n) => (up.length ? valueAt(n, up) : rootValues[n]),
      });
    }
    return chain.length ? p.value : (rootValues[name] ?? p.value);
  };
  return { srcIn, resolve, valueAt, docAt, overrideOf };
}

/**
 * Every declared axis-sign selector the bias axes of the device sized at the end of `chain` read —
 * anywhere in them, and through each parent's override up to `root` — with the chain of the sheet
 * that declares it. The one statement of which selectors a device reads: validation asks whether
 * each declared one is read, the evaluation whether a device reads its parent's, and the walk what
 * value each takes.
 */
function selectorReads(
  root: SheetDoc,
  chain: readonly SheetBlock[],
  givens: SheetGivens | undefined,
): { name: string; chain: readonly SheetBlock[] }[] {
  const docAt = (c: readonly SheetBlock[]): SheetDoc =>
    c.length ? (c[c.length - 1].doc as SheetDoc) : root;
  const reads = (
    src: unknown,
    c: readonly SheetBlock[],
  ): { name: string; chain: readonly SheetBlock[] }[] =>
    namesOf(src).flatMap((n) => {
      const d = docAt(c);
      const p = (Array.isArray(d.params) ? d.params : []).find((q) => q.name === n);
      if (!p) return [];
      if (isSelector(d, p)) return [{ name: n, chain: c }];
      const over = c.length ? blockOverride(c[c.length - 1], n) : undefined;
      return over !== undefined ? reads(over, c.slice(0, -1)) : [];
    });
  return givens ? AXIS_GIVENS.flatMap((k) => reads(givens[k], chain)) : [];
}

/**
 * Every declared axis-sign selector a device's bias axes read, with the value it takes there:
 * each must be the axis direction of the table the device is sized on. One error per selector and
 * device.
 */
function selectorProblems(
  devices: readonly {
    name: string;
    givens: SheetGivens;
    point?: DevicePoint;
    chain: SheetBlock[];
  }[],
  root: SheetDoc,
  sym: ReturnType<typeof symbolsOf>,
): QAWarning[] {
  const out: QAWarning[] = [];
  for (const dev of devices) {
    const pt = dev.point;
    if (!pt) continue;
    const seen = new Set<string>();
    for (const r of selectorReads(root, dev.chain, dev.givens)) {
      const v = sym.valueAt(r.name, r.chain);
      if (v === pt.axis || seen.has(r.name)) continue;
      seen.add(r.name);
      out.push({
        rule: 'sheet-nodes',
        severity: 'error',
        message:
          `param "${r.name}" is an axis-sign selector, so its value is the axis direction of the ` +
          `table every device using it is sized on (+1 N-style, -1 a signed p export) — it is ${v}, ` +
          `and ${deviceName(dev.name)} is sized on a table whose vgs axis runs ` +
          `${pt.axis === 1 ? 'positive (+1)' : pt.axis === -1 ? 'negative (-1)' : 'both ways'}`,
        location: 'nodes',
      });
    }
  }
  return out;
}

/** The levels of one walk: its own sheet and, recursively, every sheet whose wiring joins it.
 *  `res` gives each sheet's evaluation report; without it the levels say only how the walk names
 *  each sheet's wires. */
function walkLevels(doc: SheetDoc, res?: WalkLevel['report']): WalkLevel[] {
  const out: WalkLevel[] = [];
  const enroll = (lv: WalkLevel, depth: number): void => {
    out.push(lv);
    if (depth >= MAX_BLOCK_DEPTH) return;
    (Array.isArray(lv.doc.blocks) ? lv.doc.blocks : []).forEach((b, i) => {
      if (!b?.doc || !flattened(b.doc)) return;
      const chain = [...lv.chain, b];
      const prefix = providePrefix(chain);
      const declared: unknown = b.doc.ports;
      const ports = new Set(Array.isArray(declared) ? declared : []);
      const map = isObject(b.ports) ? b.ports : {};
      const rename = (w: string): string => {
        if (w === GROUND) return GROUND;
        const to = ports.has(w) ? map[w] : undefined;
        return typeof to === 'string' ? lv.rename(to) : `${prefix}${w}`;
      };
      enroll(
        {
          chain,
          doc: b.doc,
          report: lv.report?.blocks?.[i],
          inst: childPath(lv.inst, b.name),
          rename,
        },
        depth + 1,
      );
    });
  };
  enroll({ chain: [], doc, report: res, inst: '', rename: (w) => w }, 0);
  return out;
}

/** The evaluation report at an index path below a result. */
const reportAt = (res: WalkLevel['report'], at: readonly number[]): WalkLevel['report'] =>
  at.reduce<WalkLevel['report']>((r, i) => r?.blocks?.[i], res);

/** Why a device's relations could not be formed. */
const whyUnread = (givens: SheetGivens, sized: boolean | undefined): string =>
  sized === false
    ? 'the device did not size'
    : givens.vds === undefined && givens.diode !== true
      ? 'its givens state no drain voltage'
      : 'a drain or body voltage its givens state did not evaluate';

/**
 * The devices one walk reads — the walk's own sheet's and every sheet whose wiring joins it, each
 * device on the wires it is placed on, renamed into the walk's names — and the devices among them
 * that name no wires, both in name order. Each device's point comes from the evaluation report at
 * its block, the walk's own from `res` itself.
 */
function collectDevices(
  doc: SheetDoc,
  levels: readonly WalkLevel[],
  res?: WalkLevel['report'],
): { devices: WiredDevice[]; unwired: string[] } {
  const renameOf = new Map(levels.map((lv) => [lv.inst, lv.rename]));
  const devices: WiredDevice[] = [];
  const unwired: string[] = [];
  for (const td of treeDevices(doc)) {
    const rename = renameOf.get(td.placedIn);
    // Placed in a sheet this walk does not read: one that states no wiring under a parent that
    // does, which composedWiringProblems or wiringRefusal refuses.
    if (!rename) continue;
    if (!td.placements) {
      unwired.push(td.name);
      continue;
    }
    const report = reportAt(res, td.at);
    const point = report?.terminals;
    devices.push({
      name: td.name,
      wires: td.placements.map((n) => ({
        d: rename(n.d),
        g: rename(n.g),
        s: rename(n.s),
        b: rename(n.b),
      })),
      givens: td.givens,
      point,
      why: point ? undefined : whyUnread(td.givens, report?.sizing?.ok),
      chain: td.chain,
      inst: td.placedIn,
    });
  }
  // Every list below follows the devices, so they are taken in name order, never document order.
  devices.sort((x, y) => cmp(x.name, y.name));
  unwired.sort(cmp);
  return { devices, unwired };
}

/** The gate wires of the device `device` (`givens`, or a block of `doc`) as `doc` names them — a
 *  child that wires itself through its port map — or undefined where its wires are not written in
 *  `doc`'s walk. */
export function deviceGateWires(doc: SheetDoc, device: string): string[] | undefined {
  const { devices } = collectDevices(doc, walkLevels(doc));
  const dev = devices.find((d) => d.name === device);
  return dev ? [...new Set(dev.wires.map((n) => n.g))] : undefined;
}

/** How an opaque term the rank count could not read is named to a reader: the expression it was
 *  read from, where it was written, rather than its canonical spelling. */
class OpaqueNames {
  private readonly display = new Map<string, string>();
  named(p: Poly, src: string, where: string): Poly {
    for (const m of p.keys())
      if (m.startsWith('~') && !this.display.has(m)) this.display.set(m, `${src} (${where})`);
    return p;
  }
  get(atom: string): string | undefined {
    return this.display.get(atom);
  }
}

/** The physical sign of a device's vgs and vds values — a p device on a table in N-style convention
 *  stores magnitudes, so its physical terminal differences are the negatives — or why it cannot be
 *  read. */
function physicalSign(pt: DevicePoint, who: string): 1 | -1 | string {
  if (pt.polarity === 'p') {
    if (pt.axis === undefined)
      return (
        `${who}: its table's vgs axis holds both signs, so the direction of a p ` +
        `device's voltages on it cannot be read`
      );
    return pt.axis === -1 ? 1 : -1;
  }
  if (pt.axis === -1)
    return (
      `${who}: it declares polarity n, but its table's vgs axis holds no ` +
      `positive value — a signed p export`
    );
  return 1;
}

/** A bias axis as the rank count reads it: through a declared axis-sign selector multiplying the
 *  whole expression, replaced by its validated value where it matches the table's axis direction
 *  `axis` (see SheetVar.convention). */
function axisForm(
  sym: ReturnType<typeof symbolsOf>,
  names: OpaqueNames,
  axis: 1 | -1 | undefined,
  src: string | undefined,
  chain: readonly SheetBlock[],
  where: string,
): Poly {
  if (src === undefined) return new Map();
  const node = parseExpr(src);
  if (!node) return names.named(linearForm(sym.srcIn(src, chain)), src, where);
  if (node.type === 'Identifier') {
    const over = sym.overrideOf(chain, node.name);
    if (over !== undefined) return axisForm(sym, names, axis, over, chain.slice(0, -1), where);
  }
  const owner = sym.docAt(chain);
  const root = selectorRoot(node, (n) =>
    isSelector(
      owner,
      owner.params.find((q) => q.name === n),
    ),
  );
  if (root) {
    const v = sym.valueAt(root.name, chain);
    if ((v === 1 || v === -1) && v === axis) {
      const inner = normalize(root.inner, (n) => sym.resolve(n, chain));
      return names.named(linearForm(scale(inner, v * root.sign)), src, where);
    }
  }
  return names.named(linearForm(sym.srcIn(src, chain)), src, where);
}

/** A device's three relations per placement — its gate, drain and body voltage above its source —
 *  or, where they cannot be formed, why not. */
function deviceRelations(
  dev: WiredDevice,
  sym: ReturnType<typeof symbolsOf>,
  names: OpaqueNames,
): WalkRelation[] | string {
  const pt = dev.point;
  if (!pt) return `${deviceName(dev.name)}: ${dev.why}`;
  const m = physicalSign(pt, deviceName(dev.name));
  if (typeof m === 'string') return m;
  // The body's direction, from the table's own vsb axis: a magnitude puts a p device's body
  // above its source and an n device's below it; a signed vsb axis follows the vgs one.
  const k: 1 | -1 = pt.bodyAxis === -1 ? (-m as 1 | -1) : pt.polarity === 'p' ? 1 : -1;
  const at = (key: string): string => `${deviceName(dev.name)} ${key}`;
  const form = (src: string | undefined, key: string): Poly =>
    axisForm(sym, names, pt.axis, src, dev.chain, at(key));
  const vgsForm =
    dev.givens.vgs !== undefined
      ? form(dev.givens.vgs, 'vgs')
      : atomPoly(`${providePrefix(dev.chain)}vgs`);
  const vdsForm = dev.givens.diode === true ? vgsForm : form(dev.givens.vds, 'vds');
  const vsbForm = form(dev.givens.vsb, 'vsb');
  const sens = (q: number | undefined): number | undefined =>
    q !== undefined && pt.id > 0 ? q / pt.id : undefined;
  return dev.wires.flatMap((n, idx) => {
    const tag = dev.wires.length > 1 ? `[${idx}]` : '';
    const rel = (
      x: string,
      y: string,
      value: number,
      sform: Poly,
      pair: 'gs' | 'ds' | 'bs',
      sensitivity: number | undefined,
    ): WalkRelation =>
      relation(x, y, value, sform, {
        kind: RELATION_KINDS.placement,
        inst: dev.inst,
        tie: `${dev.name}#${String(idx).padStart(4, '0')}:${pair}`,
        label: `${dev.name}${tag}.${pair}`,
        terminal: {
          device: dev.name,
          pair,
          ...(sensitivity !== undefined ? { sensitivity } : {}),
        },
      });
    return [
      rel(n.g, n.s, m * pt.vgs, scale(vgsForm, m), 'gs', sens(pt.gm)),
      rel(n.d, n.s, m * pt.vds, scale(vdsForm, m), 'ds', sens(pt.gds)),
      rel(n.b, n.s, k * pt.vsb, scale(vsbForm, k), 'bs', sens(pt.gmb)),
    ];
  });
}

/** A current-carrying element, read once the walk has given its ends a level. */
interface Carrier {
  kind: 'I' | 'R';
  from: string;
  to: string;
  value?: number;
  name: string;
}

/** What the walk's sheets hold: each held level as an anchor to the reference, each voltage
 *  element as a relation, the current-carrying elements for the balance, and the ports. */
interface Anchors {
  anchors: WalkRelation[];
  elementRels: WalkRelation[];
  heldWires: Set<string>;
  /** Wires a voltage element holds against another. */
  sourced: Set<string>;
  carriers: Carrier[];
  /** Every port, for the floating rule. */
  openPorts: Set<string>;
  /** The walk's own ports, which the balance leaves out. */
  ownPorts: Set<string>;
}

/** Held levels, voltage sources, and what the current balance needs to know of the elements, each
 *  level and element value read from the evaluation report of the sheet that has it. */
function levelAnchors(
  levels: readonly WalkLevel[],
  sym: ReturnType<typeof symbolsOf>,
  names: OpaqueNames,
  unresolved: string[],
): Anchors {
  const out: Anchors = {
    anchors: [],
    elementRels: [],
    heldWires: new Set([GROUND]),
    sourced: new Set(),
    carriers: [],
    openPorts: new Set(),
    ownPorts: new Set(),
  };
  for (const lv of levels) {
    const root = lv.inst === '';
    const where = (x: string): string => (root ? x : childPath(lv.inst, x));
    const declared: unknown = lv.doc.ports;
    for (const w of Array.isArray(declared) ? declared : [])
      if (typeof w === 'string') {
        out.openPorts.add(lv.rename(w));
        if (root) out.ownPorts.add(w);
      }
    const held: unknown = lv.doc.levels;
    for (const [w, e] of Object.entries(isObject(held) ? held : {})) {
      if (w === GROUND || !wireOk(w)) continue;
      const wire = lv.rename(w);
      out.heldWires.add(wire);
      const v = lv.report?.wiringValues?.levels[w];
      if (v === undefined) {
        unresolved.push(
          `${where(`levels "${w}"`)}: its level did not evaluate, so the wire is not held`,
        );
        continue;
      }
      const form =
        typeof e === 'string'
          ? names.named(linearForm(sym.srcIn(e, lv.chain)), e, where(`levels.${w}`))
          : new Map();
      out.anchors.push(
        relation(wire, REF, v, form, {
          kind: RELATION_KINDS.anchor,
          inst: lv.inst,
          tie: w,
          label: where(`levels.${w}`),
        }),
      );
    }
    for (const e of Array.isArray(lv.doc.elements) ? lv.doc.elements : []) {
      if (!isObject(e) || !Array.isArray(e.between) || e.between.length !== 2) continue;
      const [a, b] = e.between as unknown[];
      if (!wireOk(a) || !wireOk(b)) continue;
      const from = lv.rename(a);
      const to = lv.rename(b);
      const value =
        typeof e.value === 'number' ? e.value : lv.report?.wiringValues?.elements[e.name as string];
      const known = value !== undefined && Number.isFinite(value) ? value : undefined;
      const kind = e.kind as SheetElement['kind'];
      switch (kind) {
        case 'V': {
          out.sourced.add(from).add(to);
          if (known === undefined) {
            unresolved.push(`${where(`element "${String(e.name)}"`)}: its value did not evaluate`);
            break;
          }
          const form =
            typeof e.value === 'string'
              ? names.named(
                  linearForm(sym.srcIn(e.value, lv.chain)),
                  e.value,
                  where(String(e.name)),
                )
              : constPoly(known);
          out.elementRels.push(
            relation(from, to, known, form, {
              kind: RELATION_KINDS.element,
              inst: lv.inst,
              tie: String(e.name),
              label: where(String(e.name)),
            }),
          );
          break;
        }
        case 'R':
        case 'I':
          out.carriers.push({ kind, from, to, value: known, name: where(String(e.name)) });
          break;
        case 'C':
          // A capacitor carries no current at DC.
          break;
        default: {
          // A kind validation does not accept is no element; a kind added to the set must be read here.
          const unread: never = kind;
          void unread;
        }
      }
    }
  }
  return out;
}

/** Each block that does not close: both claims of each failing loop, and the held wires it
 *  disputes — the report's entries and the warning that says it. */
function closureWarnings(
  walk: WalkResult,
  seeds: ReadonlyMap<string, number>,
): { disputes: NodesReport['disputes']; messages: string[] } {
  const show = (w: string): string => (w === REF ? 'ref' : w);
  const disputes: NodesReport['disputes'] = [];
  const messages: string[] = [];
  for (const blk of walk.blocks) {
    if (blk.consistent) continue;
    const failing = blk.chords.filter((c) => Math.abs(c.residual) > NODE_TOL);
    const seedsIn = blk.wires.filter((w) => seeds.has(w));
    disputes.push({
      relations: blk.relations.map((r) => r.label),
      closureError: blk.closureError,
      chords: blk.chords.map((c) => ({ relation: c.rel.label, residual: c.residual })),
      seeds: seedsIn,
    });
    const claims = failing.map((c) => {
      const loop = c.cycle.filter((r) => r !== c.rel).map((r) => r.label);
      const path = c.rel.value + c.residual;
      const one = c.cycle.filter((r) => r.terminal);
      const t = one.length === 1 ? one[0].terminal : undefined;
      const estimate =
        t?.sensitivity !== undefined
          ? ` Read as a current, that is about ${Number((100 * t.sensitivity * Math.abs(c.residual)).toPrecision(3))}% ` +
            `of ${deviceName(t.device)}'s current (${t.pair === 'gs' ? 'gm' : t.pair === 'ds' ? 'gds' : 'gmb'}/ID times ` +
            `the residual — a linearization).`
          : '';
      // A held level is read as the wire it holds; any other relation as the difference it states.
      const claim =
        c.rel.a === REF
          ? `${c.rel.label} holds ${c.rel.b} at ${volts(-c.rel.value)}, while ${loop.join(', ')} put it at ${volts(-path)}`
          : `${c.rel.label} states V(${show(c.rel.a)}) - V(${show(c.rel.b)}) = ${volts(c.rel.value)}, while ` +
            `${loop.join(', ')} put it at ${volts(path)}`;
      return `${claim} (residual ${volts(c.residual)}).${estimate}`;
    });
    const held = seedsIn.length
      ? ` Held ${seedsIn.map((w) => `${show(w)} at ${volts(seeds.get(w) as number)}`).join(', ')}, disputed by ` +
        `${failing.map((c) => c.rel.label).join(', ')}.`
      : '';
    messages.push(
      `the wiring does not close around ${blk.relations.map((r) => r.label).join(', ')}: closure error ` +
        `${volts(blk.closureError)} against a tolerance of ${volts(NODE_TOL)}. ${claims.join(' ')}${held} ` +
        `The netlist and the sizing describe the same wires, so one of these statements is not the ` +
        `circuit: give a device on a shared gate wire the other's vgs, solve the node with a ` +
        `designConstraint or solveFor, or keep the relation as an explicit check`,
    );
  }
  return { disputes, messages };
}

/** The current balance at every wire a drain or source terminal sits on — the report's sums, the
 *  warnings for those raised, and the notes for wires left unbalanced. */
function currentBalance(
  devices: readonly WiredDevice[],
  held: Anchors,
  walk: WalkResult,
): { balance: NodesReport['balance']; messages: string[]; notes: string[] } {
  const branchesAt = new Map<string, { terminal: string; current?: number }[]>();
  const branch = (w: string, terminal: string, current: number | undefined): void => {
    const list = branchesAt.get(w) ?? [];
    list.push({ terminal, current });
    branchesAt.set(w, list);
  };
  for (const dev of devices)
    dev.wires.forEach((n, idx) => {
      const tag = dev.wires.length > 1 ? `[${idx}]` : '';
      const id = dev.point?.id;
      for (const t of ['d', 's'] as const)
        branch(
          n[t],
          `${dev.name}${tag}.${t}`,
          id === undefined ? undefined : currentInto(dev.point?.polarity, t) * id,
        );
    });
  // Elements, by the direction their `between` states: current flows from `from` to `to` inside
  // the element, so it leaves the `from` wire and arrives at the `to` wire. An ideal current source
  // carries its value; a resistor carries the difference of its ends' levels over its resistance,
  // where the walk gave both ends a level, and an unknown current otherwise, which leaves both of
  // its wires unbalanced.
  const unknownAt = new Map<string, string>();
  for (const el of held.carriers) {
    let current = el.value;
    if (el.kind === 'R') {
      const vf = walk.levels.get(el.from)?.level;
      const vt = walk.levels.get(el.to)?.level;
      current =
        el.value !== undefined && el.value > 0 && vf !== undefined && vt !== undefined
          ? (vf - vt) / el.value
          : undefined;
      if (current === undefined)
        for (const w of [el.from, el.to])
          unknownAt.set(
            w,
            `resistor ${el.name} has an end with no trusted level, so its current is unknown`,
          );
    }
    branch(el.from, el.name, current === undefined ? undefined : -current);
    branch(el.to, el.name, current);
  }
  const balance: NodesReport['balance'] = [];
  const messages: string[] = [];
  const notes: string[] = [];
  for (const [w, list] of [...branchesAt].sort(([x], [y]) => cmp(x, y))) {
    if (held.ownPorts.has(w)) continue;
    if (list.some((b) => b.current === undefined)) {
      const why = unknownAt.get(w);
      if (why) notes.push(`Wire "${w}" is not balanced: ${why}.`);
      continue;
    }
    const branches = list
      .map((b) => ({ terminal: b.terminal, current: b.current as number }))
      .sort((x, y) => cmp(x.terminal, y.terminal));
    const residual = branches.reduce((sum, b) => sum + b.current, 0);
    // A wire a level or a voltage element holds: what does not balance is what its source supplies.
    const isHeld = held.heldWires.has(w) || held.sourced.has(w);
    balance.push({ wire: w, residual, held: isHeld, branches });
    const largest = Math.max(...branches.map((b) => Math.abs(b.current)));
    if (!(Math.abs(residual) > KCL_TOL_REL * largest)) continue;
    const listed = branches.map((b) => `${b.terminal} ${amps(b.current)}`).join(', ');
    const share = `${Number(((100 * Math.abs(residual)) / largest).toPrecision(3))}% of the largest; reported past ${100 * KCL_TOL_REL}%`;
    if (!isHeld)
      messages.push(
        `the currents at wire "${w}" do not balance: ${listed} sum to ${amps(residual)} ` +
          `flowing into the wire (${share}) — a current with nowhere to go, or one current given to ` +
          `two devices`,
      );
    // A held wire where currents arrive and leave — an output the application holds — hides an
    // imbalance in the source holding it. A rail, where every current flows the same way, is the
    // supply current, and a wire a voltage element sets is that element's current: both are
    // reported above and not raised.
    else if (
      !held.sourced.has(w) &&
      branches.some((b) => b.current > 0) &&
      branches.some((b) => b.current < 0)
    )
      messages.push(
        `wire "${w}" is held, and the currents its devices meet there do not balance: an ideal source ` +
          `supplies ${amps(-residual)} (${listed}; ${share}) — the source holding ` +
          `the wire makes up a current the devices do not agree on`,
      );
  }
  return { balance, messages, notes };
}

/** Placements of one sizing share one operating point only where the walk shows it — the report's
 *  verdicts and the warnings for those that do not. */
function placementRule(
  devices: readonly WiredDevice[],
  walk: WalkResult,
): { placements: NodesReport['placements']; messages: string[] } {
  const placements: NodesReport['placements'] = [];
  const messages: string[] = [];
  for (const dev of devices) {
    if (dev.wires.length < 2 || !dev.point) continue;
    const at = (w: string): number | undefined => walk.levels.get(w)?.level;
    const points = dev.wires.map((n) => {
      const [d, g, s0, b] = TERMINALS.map((t) => at(n[t]));
      return d === undefined || g === undefined || s0 === undefined || b === undefined
        ? undefined
        : [g - s0, d - s0, s0 - b];
    });
    const lost = points.findIndex((p) => p === undefined);
    if (lost >= 0) {
      placements.push({
        device: dev.name,
        shared: false,
        reason: `placement ${lost} has a terminal on a wire with no trusted level, so the placements cannot be shown to share one operating point`,
      });
      continue;
    }
    const first = points[0] as number[];
    const off = points.findIndex((p) =>
      (p as number[]).some((v, j) => Math.abs(v - first[j]) > NODE_TOL),
    );
    if (off < 0) {
      placements.push({ device: dev.name, shared: true });
      continue;
    }
    const words = (p: number[]): string =>
      `vgs ${volts(p[0])}, vds ${volts(p[1])}, vsb ${volts(p[2])}`;
    const reason = `placement ${off} sits at ${words(points[off] as number[])} and placement 0 at ${words(first)}`;
    placements.push({ device: dev.name, shared: false, reason });
    messages.push(
      `the placements of ${deviceName(dev.name)} are not at one operating point: ${reason} — one ` +
        `sizing is one operating point, so devices at different voltages are separate blocks, tied ` +
        `by W and vgs`,
    );
  }
  return { placements, messages };
}

/** The findings the blocks below a result reported in their own wiring checks. */
export const childFindingsOf = (res: { blocks?: readonly SheetBlockReport[] }): number =>
  (res.blocks ?? []).reduce((sum, b) => sum + (b.nodes?.findings ?? 0), 0);

/**
 * The walk over one sheet and every sheet whose wiring joins it: their relations, the walk, then
 * the warnings, the rank count, the current balance and the placement rule, as one report.
 * `ownPoint` is the walk's own device as its own evaluation read it; every other device's point,
 * held level and element value comes from the evaluation report of the sheet that has it. The
 * walk's own sheet is read the same way, through a report carrying its device point and its held
 * levels and element values (wiringValuesOf) — which reads an element only by its name, as
 * validation requires every element to have.
 */
export function nodesCheck(
  doc: SheetDoc,
  res: SheetResult,
  ownPoint: DevicePoint | undefined,
): { report: NodesReport; warnings: QAWarning[] } {
  const warnings: QAWarning[] = [];
  const raise = (message: string, severity: 'warning' | 'error' = 'warning'): void => {
    warnings.push({ rule: 'sheet-nodes', severity, message, location: 'nodes' });
  };
  const own = {
    ...res,
    ...(ownPoint ? { terminals: ownPoint } : {}),
    wiringValues: wiringValuesOf(doc, res),
  };
  const levels = walkLevels(doc, own);
  const sym = symbolsOf(doc, res.values);
  const { devices, unwired } = collectDevices(doc, levels, own);
  const names = new OpaqueNames();
  const unresolved: string[] = [];
  const rels: WalkRelation[] = [];
  for (const dev of devices) {
    const formed = deviceRelations(dev, sym, names);
    if (typeof formed === 'string') unresolved.push(formed);
    else rels.push(...formed);
  }
  warnings.push(...selectorProblems(devices, doc, sym));

  const held = levelAnchors(levels, sym, names, unresolved);
  rels.push(...held.elementRels, ...held.anchors);
  const grounded = rels.some((r) => r.a === GROUND || r.b === GROUND);
  if (grounded)
    rels.push(
      relation(REF, GROUND, 0, new Map(), {
        kind: RELATION_KINDS.ground,
        inst: '',
        tie: '',
        label: GROUND,
      }),
    );
  // Seeds: gnd at 0 where it is in the walk, and each held wire at its level — the canonically
  // first statement of it, where several sheets hold one wire.
  const seeds = new Map<string, number>();
  if (grounded) seeds.set(GROUND, 0);
  for (const a of [...held.anchors].sort(relCmp)) if (!seeds.has(a.b)) seeds.set(a.b, -a.value);

  const walk = dcWalk(rels, seeds);
  const closure = closureWarnings(walk, seeds);
  for (const m of closure.messages) raise(m);
  // A group that reaches a port is not floating: its other end is outside the sheet.
  for (const group of walk.floating) {
    if (group.some((w) => held.openPorts.has(w))) continue;
    raise(
      `${group.length > 1 ? `wires ${group.map((w) => `"${w}"`).join(', ')} float` : `wire "${group[0]}" floats`}: ` +
        `no held wire (gnd, or one in levels) reaches ${group.length > 1 ? 'them' : 'it'}, so ` +
        `${group.length > 1 ? 'their levels are' : 'its level is'} one missing statement — hold one in ` +
        `levels, or connect ${group.length > 1 ? 'them' : 'it'} to a held wire`,
    );
  }
  for (const u of unresolved) raise(`a relation is not formed — ${u}`);
  const currents = currentBalance(devices, held, walk);
  for (const m of currents.messages) raise(m);
  const shared = placementRule(devices, walk);
  for (const m of shared.messages) raise(m);

  const dof = dofOf(walk, (atom) => names.get(atom));
  const notes: string[] = [];
  if (walk.blocks.some((b) => b.chords.length)) notes.push(CLOSURE_NOTE);
  if (dof.proven > 0)
    notes.push(
      `The wiring states ${dof.proven} constraint${dof.proven > 1 ? 's' : ''} beyond the sizing ` +
        `(over-determined by ${dof.proven}, counted from the linear equations alone)` +
        `${dof.constraints.every((c) => c.satisfied) ? ', each holding at this design point' : ''}. ` +
        `Each is resolved by giving a device on a shared gate wire the other's vgs, by solving the ` +
        `node with a designConstraint or solveFor, or by keeping it as an explicit check.`,
    );
  if (dof.bound > dof.proven)
    notes.push(
      `Up to ${dof.bound - dof.proven} further constraint${dof.bound - dof.proven > 1 ? 's' : ''} could ` +
        `not be decided: ${dof.undecided.join('; ')}.`,
    );
  notes.push(...currents.notes);

  // One warning per message: a selector that fails its check is read by several bias axes.
  const unique = warnings.filter(
    (w, i) => warnings.findIndex((v) => v.message === w.message) === i,
  );
  const findings = unique.length + childFindingsOf(res);
  const report: NodesReport = {
    state: findings ? 'checked-with-findings' : 'checked-clean',
    levels: Object.fromEntries([...walk.levels].sort(([x], [y]) => cmp(x, y))),
    tainted: walk.tainted,
    floating: walk.floating,
    disputes: closure.disputes,
    closureError: Math.max(0, ...walk.blocks.map((b) => b.closureError)),
    dof,
    balance: currents.balance,
    placements: shared.placements,
    unresolved,
    unwired,
    findings,
    notes,
  };
  return { report, warnings: unique };
}

// ---------------------------------------------------------------------------------------------
// The wiring part of an evaluation
// ---------------------------------------------------------------------------------------------

/** A report for a sheet with nothing to walk: `nodes: "none"`. */
const notApplicable = (childFindings: number): NodesReport => ({
  state: 'not-applicable',
  levels: {},
  tainted: [],
  floating: [],
  disputes: [],
  closureError: 0,
  dof: { proven: 0, bound: 0, constraints: [], undecided: [] },
  balance: [],
  placements: [],
  unresolved: [],
  unwired: [],
  findings: childFindings,
  notes: [],
});

/** What a `not-evaluated` wiring report says. */
export const NO_ANSWER_NOTE =
  'this point has no answer — there is no sized design for the wiring check to read, so it did ' +
  'not run';

/** What the wiring report of a document in the earlier format that carries wiring keys says. */
export const EARLIER_FORMAT_NOTE =
  'this document has no format version, so its wiring keys are not read and the check did not ' +
  `run — add "formatVersion": ${FORMAT_VERSION} to read them`;

const notEvaluated = (childFindings: number, note: string): NodesReport => ({
  ...notApplicable(childFindings),
  state: 'not-evaluated',
  notes: [note],
});

/**
 * The wiring report of a point with no answer (see NodesState): the walk does not run, and a sheet
 * that states wiring reports `not-evaluated` — the same reason a block that did not size is
 * skipped. A sheet that declares `nodes: "none"` reports as it always does; one in the earlier
 * format that carries wiring keys says it was not read; one that states no wiring has nothing to
 * report. `childFindings` counts what the blocks below reported.
 */
export function unwalkedReport(doc: SheetDoc, childFindings = 0): NodesReport | undefined {
  const format = formatOf(doc);
  if (format === 'earlier')
    return carriesWiring(doc) ? notEvaluated(childFindings, EARLIER_FORMAT_NOTE) : undefined;
  if (format !== 2) return undefined;
  if (doc.nodes === 'none') return notApplicable(childFindings);
  return statesWiring(doc) ? notEvaluated(childFindings, NO_ANSWER_NOTE) : undefined;
}

/** The wiring part of a node's evaluation where its point has no answer: the run with the report
 *  unwalkedReport gives in place of a walk — none where the report is its parent's to give (see
 *  parentReports). */
export function withoutWalk<
  T extends { blocks?: readonly SheetBlockReport[]; nodes?: NodesReport },
>(doc: SheetDoc, res: T, mode: WiringMode = STANDALONE): T {
  if (parentReports(doc, mode)) return res;
  const nodes = unwalkedReport(doc, childFindingsOf(res));
  return nodes ? { ...res, nodes } : res;
}

/** Whether a block's device reads a declared axis-sign selector of its parent through the block's
 *  overrides — so the parent asks for the device's operating point, to check the selector against
 *  the table the device is sized on. */
export const readsParentSelector = (parent: SheetDoc, block: SheetBlock): boolean =>
  !!block.doc?.givens &&
  selectorReads(parent, [block], block.doc.givens).some((r) => r.chain.length === 0);

/** How a node's parent asks for its wiring: `wired` — the parent's walk reads this sheet's device
 *  (the block names its wires, or the parent checks a selector against it); `flattened` — this
 *  sheet's wiring joins the parent's walk (see flattened). */
export interface WiringMode {
  wired: boolean;
  flattened: boolean;
}

/** How the top of a tree asks for its wiring: it runs its own walk, the only one in the tree. */
export const STANDALONE: WiringMode = { wired: false, flattened: false };

/** Whether a node's own wiring report is its parent's to give: its wiring joins the parent's walk,
 *  or it is in the earlier format, which reads no wiring key, and the parent reads only its device
 *  point. The one rule withNodes and withoutWalk both leave a node's report out by. */
const parentReports = (doc: SheetDoc, mode: WiringMode): boolean =>
  mode.flattened || (mode.wired && formatOf(doc) === 'earlier');

/**
 * The wiring part of one node's evaluation, run on its finished result. Where its parent reads it,
 * the result carries this sheet's device point; where its wiring joins the parent's walk, its held
 * levels and element values too, and it runs no walk of its own. Otherwise, a sheet that states
 * wiring is walked here, with every descendant whose wiring joins it — only ever the top of a
 * tree, since a child that states wiring always joins its parent's walk (see flattened); one that
 * declares `nodes: "none"`, states none, or is read by its parent has its declared selectors held
 * to the tables they are read on — every device of its own (the parent checks the one it reads)
 * and every child device it reads. A document in the earlier format reads no wiring key: one that
 * carries some is reported not evaluated. Warnings are appended; nothing else in the result moves,
 * except that a refusal — a selector the table contradicts — closes feasibility.
 */
export function withNodes(
  doc: SheetDoc,
  res: SheetResult,
  table: DeviceTable | undefined,
  mode: WiringMode,
): SheetResult {
  const format = formatOf(doc);
  if (format === 'unknown') return res;
  const selectors =
    format === 2 && (Array.isArray(doc.params) ? doc.params : []).some((p) => isSelector(doc, p));
  const point =
    doc.givens && (mode.wired || mode.flattened || wiresOwnDevice(doc) || selectors)
      ? devicePoint(doc, res, table)
      : undefined;
  let out: SheetResult =
    (mode.wired || mode.flattened) && point ? { ...res, terminals: point } : res;
  if (mode.flattened) return { ...out, wiringValues: wiringValuesOf(doc, res) };
  if (format === 'earlier') return withoutWalk(doc, out, mode);
  let warnings: QAWarning[];
  if (statesWiring(doc) && doc.nodes !== 'none') {
    const checked = nodesCheck(doc, res, point);
    out = { ...out, nodes: checked.report };
    warnings = checked.warnings;
  } else {
    if (doc.nodes === 'none') out = { ...out, nodes: notApplicable(childFindingsOf(res)) };
    const devices: {
      name: string;
      givens: SheetGivens;
      point?: DevicePoint;
      chain: SheetBlock[];
    }[] = [];
    if (doc.givens && point && !mode.wired)
      devices.push({ name: 'givens', givens: doc.givens, point, chain: [] });
    (Array.isArray(doc.blocks) ? doc.blocks : []).forEach((b, i) => {
      const t = res.blocks?.[i]?.terminals;
      if (b?.doc?.givens && t)
        devices.push({ name: b.name, givens: b.doc.givens, point: t, chain: [b] });
    });
    warnings = devices.length ? selectorProblems(devices, doc, symbolsOf(doc, res.values)) : [];
  }
  if (!warnings.length) return out;
  return {
    ...out,
    warnings: [...out.warnings, ...warnings],
    ...(warnings.some((w) => w.severity === 'error') ? { feasible: false } : {}),
  };
}

/** A sheet's held levels and element values, evaluated in its own finished scope (see
 *  WiringValues). */
function wiringValuesOf(doc: SheetDoc, res: SheetResult): WiringValues {
  const scope = scalarScope(res.values);
  const levels: Record<string, number> = {};
  const raw: unknown = doc.levels;
  for (const [w, e] of Object.entries(isObject(raw) ? raw : {})) {
    const v = valueIn(e, scope);
    if (v !== undefined) levels[w] = v;
  }
  const elements: Record<string, number> = {};
  for (const e of Array.isArray(doc.elements) ? doc.elements : []) {
    if (!isObject(e) || typeof e.name !== 'string') continue;
    const v = typeof e.value === 'number' ? e.value : valueIn(e.value, scope);
    if (v !== undefined && Number.isFinite(v)) elements[e.name] = v;
  }
  return { levels, elements };
}
