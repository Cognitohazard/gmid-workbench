// The item list of one evaluation (see states.ts), built once at the end of a node's evaluation from
// the evaluation's own records: the causes its searches wrote, its device's sizing, its equations
// and the names it withheld, its checks, and its blocks' own lists under their names.

import { CONSTANTS } from '../constants';
import {
  DEVICE_NAMES,
  engineSolved,
  failedParams,
  isHardCheck,
  namesOf,
  OWN_DEVICE,
  PROVIDE_SEP,
  REGION_CHECK_ID,
  unfoundIn,
  unitOfSides,
  type SheetDoc,
  type SheetResult,
  type SizingReport,
  type SolveFailure,
} from './types';
import type { QAWarning } from '../types';
import {
  failsCause,
  type NotReadData,
  memberOf,
  setOf,
  type Cause,
  type Item,
  type ItemRef,
  type WithheldOn,
} from './states';

/** The item a withheld name traces back to (SheetResult.withheld): a solved param of this sheet
 *  whose search did not find it, or a block's sheet. */
function refOfCause(res: SheetResult, cause: string): ItemRef {
  return unfoundIn(res).has(cause)
    ? { kind: 'search', path: [], name: cause }
    : { kind: 'sheet', path: cause.split('.'), name: '' };
}

/** The cause kind a withheld item's dependency failed with, where the list holds it. */
const onOf = (items: readonly Item[], ref: ItemRef): WithheldOn => {
  const hit = items.find(
    (i) => i.kind === ref.kind && i.name === ref.name && i.path.join('.') === ref.path.join('.'),
  );
  return { ...ref, cause: hit?.status === 'failed' ? hit.cause.kind : 'cannot-evaluate' };
};

/** The search items a failed solve leaves: each param a failure names, failed with its cause — or,
 *  for a declaration that cannot be solved as written, withheld on the sheet, whose item carries
 *  the cause — and each other param not found, withheld on the one it traces back to. */
export function searchItems(
  failures: readonly { failure: SolveFailure; cause: Cause }[],
  unfound: ReadonlyMap<string, string>,
): Item[] {
  const out: Item[] = [];
  const named = new Set<string>();
  for (const { failure, cause } of failures) {
    if (cause.kind === 'not-determined') {
      out.push({ kind: 'sheet', path: [], name: '', status: 'failed', cause });
      continue;
    }
    // A member of a set that failed where the others were held: the member fails with its own
    // cause, and the others of the set are withheld on it.
    const set = setOf(cause);
    const member = set ? memberOf(cause) : undefined;
    if (set && member !== undefined) {
      named.add(member);
      out.push({ kind: 'search', path: [], name: member, status: 'failed', cause });
      for (const m of set)
        if (m.unknown !== member) {
          named.add(m.unknown);
          out.push({
            kind: 'search',
            path: [],
            name: m.unknown,
            status: 'withheld',
            on: [{ kind: 'search', path: [], name: member, cause: cause.kind }],
          });
        }
      continue;
    }
    for (const n of failedParams(failure)) {
      named.add(n);
      out.push({ kind: 'search', path: [], name: n, status: 'failed', cause });
    }
  }
  for (const [n, c] of unfound) {
    if (named.has(n)) continue;
    const declared = out.find((i) => i.kind === 'sheet');
    const on: ItemRef = named.has(c)
      ? { kind: 'search', path: [], name: c }
      : declared
        ? { kind: 'sheet', path: [], name: '' }
        : { kind: 'search', path: [], name: c };
    out.push({ kind: 'search', path: [], name: n, status: 'withheld', on: [onOf(out, on)] });
  }
  return out;
}

const ownSheet = (i: ItemRef): boolean => i.kind === 'sheet' && i.path.length === 0;

/** A child's items as its parent lists them: under the block's name. */
export const under = (block: string, items: readonly Item[]): Item[] =>
  items.map((i) =>
    i.status === 'withheld'
      ? {
          ...i,
          path: [block, ...i.path],
          // A block's own sheet item is withheld on what its parent passes it: an item of the
          // parent, named as the parent names it.
          on: ownSheet(i) ? i.on : i.on.map((o) => ({ ...o, path: [block, ...o.path] })),
        }
      : { ...i, path: [block, ...i.path] },
  );

/**
 * The full item list of one node's evaluation, the sheet first. The search items a failed solve
 * already wrote (`res.items`) are kept; every solved param they do not name is a search that landed.
 */
export function itemsOf(doc: SheetDoc, res: SheetResult): Item[] {
  const written = res.items ?? [];
  const sheetWritten = written.find((i) => i.kind === 'sheet' && i.path.length === 0);
  const out: Item[] = [sheetWritten ?? { kind: 'sheet', path: [], name: '', status: 'ok' }];
  const withheldOn = (name: string): WithheldOn[] | undefined => {
    const c = res.withheld?.[name];
    return c === undefined ? undefined : [onOf(written, refOfCause(res, c))];
  };

  // The searches.
  for (const p of doc.params) {
    if (!engineSolved(p) && !p.hold) {
      out.push({ kind: 'value', path: [], name: p.name, status: 'ok' });
      continue;
    }
    const w = written.find((i) => i.kind === 'search' && i.path.length === 0 && i.name === p.name);
    if (w) out.push(w);
    else if (engineSolved(p)) {
      const range = res.ranges?.find((r) => r.param === p.name);
      out.push({
        kind: 'search',
        path: [],
        name: p.name,
        status: 'ok',
        ...(range && Number.isFinite(res.values[p.name])
          ? {
              attributes: {
                kind: 'search',
                value: res.values[p.name],
                range,
                inFirstRange: range.outside === undefined,
                settledInSet: false,
              },
            }
          : {}),
      });
    } else out.push({ kind: 'value', path: [], name: p.name, status: 'ok' });
  }

  // The device.
  if (doc.givens) {
    const s = res.sizing;
    // Withheld on what its givens read; a device withheld on itself (OWN_DEVICE) is its own
    // failure, read beyond its table.
    const from = res.withheld?.W;
    const on =
      s && !s.ok && from !== undefined && from !== OWN_DEVICE ? withheldOn('W') : undefined;
    const item: Item =
      s?.ok && res.values.feasible !== 0
        ? {
            kind: 'device',
            path: [],
            name: 'givens',
            status: 'ok',
            ...(s.fallbacks?.length
              ? {
                  attributes: {
                    kind: 'device',
                    fallbacks: s.fallbacks.map((f) => ({
                      quantity: f.quantity,
                      missing: f.missing,
                      form: f.form,
                    })),
                  },
                }
              : {}),
          }
        : on
          ? { kind: 'device', path: [], name: 'givens', status: 'withheld', on }
          : {
              kind: 'device',
              path: [],
              name: 'givens',
              status: 'failed',
              cause: deviceCause(s, doc),
            };
    out.push(item);
  }

  // The blocks' items, under their names: what an equation or a check of this sheet reads of a
  // block is found among them.
  const blockItems = (res.blocks ?? []).flatMap((b) => under(b.name, b.items ?? []));
  const reading = readerOf(doc, res, out, blockItems);

  // The equations, in document order, so what one reads of another is already listed.
  for (const e of doc.equations) {
    if (Number.isFinite(res.values[e.name])) {
      out.push({ kind: 'value', path: [], name: e.name, status: 'ok' });
      continue;
    }
    out.push(
      reading.noNumber({ kind: 'value', path: [], name: e.name }, [e.expr], () =>
        equationCause(e.name, res.warnings, reading.undeclared(e.expr)),
      ),
    );
  }

  // The requirements.
  for (const r of res.checks) {
    if (r.status === 'pass' || r.status === 'amber') {
      out.push({
        kind: 'requirement',
        path: [],
        name: r.id,
        status: 'ok',
        attributes: {
          kind: 'requirement',
          lhs: r.lhsValue,
          rhs: r.rhsValue,
          margin: r.margin,
          marginPct: r.marginPct,
          narrow: r.status === 'amber',
          onLimit: r.margin === 0,
          hard: isHardCheck(r.kind),
        },
      });
      continue;
    }
    if (r.status === 'fail') {
      const [lhs, op, rhs] = splitCheckText(r.text, r.op);
      out.push({
        kind: 'requirement',
        path: [],
        name: r.id,
        status: 'failed',
        cause: failsCause({ ...r, text: { lhs, op, rhs }, unit: unitOfSides(doc, lhs, rhs) }),
      });
      continue;
    }
    // A check that gave no number. The check a declared region adds reads the device.
    const check = doc.checks.find((c) => c.id === r.id);
    const region = r.id === REGION_CHECK_ID && doc.givens?.region !== undefined;
    const ref: ItemRef = { kind: 'requirement', path: [], name: r.id };
    out.push(
      region
        ? reading.onDevice(ref, () => requirementCause(r, doc, res.sizing?.ok === true, reading))
        : reading.noNumber(ref, check ? [check.lhs, check.rhs] : [], () =>
            requirementCause(r, doc, res.sizing?.ok === true, reading),
          ),
    );
  }

  out.push(...blockItems);
  return out;
}

/**
 * The rule for an item that gives no number, over the names its expressions read: failed as not
 * defined where a name it reads is declared by no entry of the sheet; else withheld on the items it
 * reads that are not ok; else failed with the cause its own evaluation gives.
 */
function readerOf(
  doc: SheetDoc,
  res: SheetResult,
  own: readonly Item[],
  blocks: readonly Item[],
): {
  undeclared: (expr: string) => string | undefined;
  noNumber: (ref: ItemRef, exprs: readonly string[], cause: () => Cause) => Item;
  onDevice: (ref: ItemRef, cause: () => Cause) => Item;
} {
  const params = new Map(doc.params.map((p) => [p.name, p]));
  const equations = new Set(doc.equations.map((e) => e.name));
  const declared = (n: string): boolean =>
    Object.prototype.hasOwnProperty.call(CONSTANTS, n) ||
    params.has(n) ||
    equations.has(n) ||
    (doc.givens !== undefined && DEVICE_NAMES.has(n)) ||
    Object.prototype.hasOwnProperty.call(res.values, n) ||
    Object.prototype.hasOwnProperty.call(res.withheld ?? {}, n);
  const find = (ref: ItemRef): Item | undefined =>
    [...own, ...blocks].find(
      (i) => i.kind === ref.kind && i.name === ref.name && i.path.join('.') === ref.path.join('.'),
    );
  /** The item the withheld map traces a name to: a search of this sheet, its device, or a
   *  block's device where it failed, else that block's sheet item. */
  const tracedBy = (n: string): Item | undefined => {
    const c = res.withheld?.[n];
    if (c === undefined) return undefined;
    if (c === OWN_DEVICE) return find({ kind: 'device', path: [], name: OWN_DEVICE });
    const p = params.get(c);
    if (p) return find({ kind: engineSolved(p) || p.hold ? 'search' : 'value', path: [], name: c });
    const path = c.split('.');
    const at = (i: Item): boolean => i.path.join('.') === path.join('.');
    return (
      blocks.find((i) => i.kind === 'device' && at(i) && i.status !== 'ok') ??
      blocks.find((i) => i.kind === 'sheet' && at(i))
    );
  };
  /** The item a name of this sheet's scope is. */
  const itemOfName = (n: string): Item | undefined => {
    const p = params.get(n);
    if (p) return find({ kind: engineSolved(p) || p.hold ? 'search' : 'value', path: [], name: n });
    if (equations.has(n)) return find({ kind: 'value', path: [], name: n });
    if (doc.givens !== undefined && DEVICE_NAMES.has(n))
      return find({ kind: 'device', path: [], name: OWN_DEVICE });
    // A block's output: the item of the block it is, else, for a quantity of the block's device,
    // that device; else what the withheld map traces it to; else the block's sheet item.
    const parts = n.split(PROVIDE_SEP);
    if (parts.length >= 2 && doc.blocks?.some((b) => b.name === parts[0])) {
      const b = parts[0];
      const key = parts.slice(1).join(PROVIDE_SEP);
      const inBlock = (pred: (i: Item) => boolean): Item | undefined =>
        blocks.find((i) => i.path.length === 1 && i.path[0] === b && pred(i));
      return (
        inBlock((i) => i.kind !== 'sheet' && i.kind !== 'device' && i.name === key) ??
        (DEVICE_NAMES.has(key) ? inBlock((i) => i.kind === 'device') : undefined) ??
        tracedBy(n) ??
        inBlock((i) => i.kind === 'sheet')
      );
    }
    return undefined;
  };
  const dependency = (i: Item): WithheldOn =>
    i.status === 'failed'
      ? { kind: i.kind, path: i.path, name: i.name, cause: i.cause.kind }
      : i.status === 'withheld' && i.on[0]
        ? i.on[0]
        : { kind: i.kind, path: i.path, name: i.name, cause: 'cannot-evaluate' };
  const undeclared = (expr: string): string | undefined => namesIn(expr).find((n) => !declared(n));
  return {
    undeclared,
    noNumber: (ref, exprs, cause) => {
      if (exprs.some((x) => undeclared(x) !== undefined))
        return { ...ref, status: 'failed', cause: cause() };
      const on: WithheldOn[] = [];
      for (const x of exprs)
        for (const n of namesIn(x)) {
          const i = itemOfName(n);
          if (
            i &&
            i.status !== 'ok' &&
            !on.some(
              (o) =>
                o.name === i.name && o.kind === i.kind && o.path.join('.') === i.path.join('.'),
            )
          )
            on.push(dependency(i));
        }
      return on.length
        ? { ...ref, status: 'withheld', on }
        : { ...ref, status: 'failed', cause: cause() };
    },
    onDevice: (ref, cause) => {
      const d = find({ kind: 'device', path: [], name: OWN_DEVICE });
      return d && d.status !== 'ok'
        ? { ...ref, status: 'withheld', on: [dependency(d)] }
        : { ...ref, status: 'failed', cause: cause() };
    },
  };
}

/** The list with each of this sheet's withheld items, and each of its blocks' own sheet items,
 *  pointing at the item its withheld name traces back to, once every item and finding is in the
 *  list: a search, the device, or an item of a block. A block's other items were pointed when its
 *  list was made. */
export const resolveWithheld = (items: readonly Item[]): Item[] =>
  items.map((i) =>
    i.status === 'withheld' && (i.path.length === 0 || (i.kind === 'sheet' && i.path.length === 1))
      ? { ...i, on: distinct(i.on.map((o) => resolveOn(items, o))) }
      : i,
  );

/** Dependencies once each: several names an item reads can trace back to one failed item. */
const distinct = (on: readonly WithheldOn[]): WithheldOn[] =>
  on.filter(
    (o, k) =>
      on.findIndex(
        (p) => p.kind === o.kind && p.name === o.name && p.path.join('.') === o.path.join('.'),
      ) === k,
  );

/** The full name of an item: its blocks' path and its own name, joined by dots. */
const fullName = (r: ItemRef): string => [...r.path, r.name].filter(Boolean).join('.');

/** A dependency resolved against the full list: the item whose full name is the one the withheld
 *  name traced back to, a failed one first, with its cause. Kept as it was where none is. */
function resolveOn(items: readonly Item[], o: WithheldOn): WithheldOn {
  const name = fullName(o);
  const hits = items.filter((i) => fullName(i) === name);
  const hit = hits.find((i) => i.status === 'failed') ?? hits[0];
  if (!hit) return o;
  const ref = { kind: hit.kind, path: hit.path, name: hit.name };
  if (hit.status === 'failed') return { ...ref, cause: hit.cause.kind };
  if (hit.status === 'withheld' && hit.on[0] && fullName(hit.on[0]) !== name) return hit.on[0];
  // A block whose own sheet item is not failed: the first failed item inside it, other than a
  // requirement that fails, which withholds nothing.
  if (hit.kind === 'sheet') {
    const inside = items.find(
      (i) =>
        i.status === 'failed' &&
        i.cause.kind !== 'fails' &&
        i.path.length >= hit.path.length &&
        hit.path.every((p, k) => i.path[k] === p),
    );
    if (inside && inside.status === 'failed')
      return { kind: inside.kind, path: inside.path, name: inside.name, cause: inside.cause.kind };
  }
  return o.frame === 'parent' ? o : { ...ref, cause: o.cause };
}

/** A check's two sides as the sheet writes them, read back from its text. */
function splitCheckText(
  text: string,
  op: '>=' | '<=' | '==',
): [string, '>=' | '<=' | '==', string] {
  const i = text.indexOf(` ${op} `);
  return i < 0 ? [text, op, ''] : [text.slice(0, i), op, text.slice(i + op.length + 2)];
}

/** Why an equation gives no number, from what its evaluation found: a syntax error, a name it
 *  reads that no entry declares (that name, as data), or a number that is not finite. */
function equationCause(name: string, warnings: readonly QAWarning[], undeclared?: string): Cause {
  const parse = warnings.find((w) => w.severity === 'error' && w.location === `equation "${name}"`);
  if (parse)
    return { kind: 'cannot-evaluate', data: { why: 'syntax', name, reason: parse.message } };
  if (undeclared !== undefined)
    return { kind: 'cannot-evaluate', data: { why: 'not-defined', name: undeclared, reason: '' } };
  const nonFinite = warnings.find((w) => w.rule === 'sheet-nonfinite' && w.location === name);
  return {
    kind: 'cannot-evaluate',
    data: { why: 'not-finite', name, reason: nonFinite?.message ?? '' },
  };
}

/** Why a check gives no number: which side gave none; where a side reads a name that no entry
 *  declares, that name; and for the check a declared region adds, what left it without two
 *  numbers. */
function requirementCause(
  r: { id: string; lhsValue: number; rhsValue: number; detail?: string },
  doc: SheetDoc,
  sized: boolean,
  reading: { undeclared: (expr: string) => string | undefined },
): Cause {
  const l = Number.isFinite(r.lhsValue);
  const rr = Number.isFinite(r.rhsValue);
  const side = !l && !rr ? 'both' : !l ? 'lhs' : !rr ? 'rhs' : undefined;
  const check = doc.checks.find((c) => c.id === r.id);
  const sides = {
    lhs: check ? reading.undeclared(check.lhs) : undefined,
    rhs: check ? reading.undeclared(check.rhs) : undefined,
  };
  const undeclared = sides.lhs ?? sides.rhs;
  // The check a declared region adds: what left it without two numbers.
  const region =
    r.id === REGION_CHECK_ID && doc.givens?.region !== undefined
      ? {
          device: OWN_DEVICE,
          missing: !sized ? ('device' as const) : !l ? ('vds' as const) : ('vdsat' as const),
        }
      : undefined;
  return {
    kind: 'cannot-evaluate',
    data: {
      why: undeclared !== undefined ? 'not-defined' : 'not-finite',
      name: undeclared ?? r.id,
      reason: r.detail ?? '',
      ...(side ? { side } : {}),
      ...(sides.lhs || sides.rhs
        ? {
            sides: {
              ...(sides.lhs ? { lhs: sides.lhs } : {}),
              ...(sides.rhs ? { rhs: sides.rhs } : {}),
            },
          }
        : {}),
      ...(region ? { region } : {}),
    },
  };
}

/** The names an expression reads. */
const namesIn = (expr: string): string[] => [...namesOf(expr)];

/** Why a device did not size: read beyond its table, a table that lacks what it needs, or
 *  anything else the sizer said. */
function deviceCause(s: SizingReport | undefined, doc: SheetDoc): Cause {
  if (s?.outside?.length) {
    const o = s.outside[0];
    const setBy = typedSetter(doc, o.quantity);
    return { kind: 'outside-table', data: setBy ? { ...o, setBy } : o };
  }
  if (s?.needs?.length)
    return {
      kind: 'cannot-evaluate',
      data: { why: 'no-column', name: s.needs.join(', '), reason: s.error ?? '' },
    };
  return {
    kind: 'cannot-evaluate',
    data: { why: 'not-finite', name: 'givens', reason: s?.error ?? 'the device was not sized' },
  };
}

/** The value on the sheet that sets the quantity a device was sized at, where the given is that
 *  one name and the designer types its value: a param that is neither solved nor held. */
function typedSetter(doc: SheetDoc, quantity: string): string | undefined {
  const key = quantity === 'l' ? 'L' : quantity;
  const given = (doc.givens as Record<string, string | undefined> | undefined)?.[key]?.trim();
  if (!given) return undefined;
  const p = doc.params.find((q) => q.name === given);
  return p && !engineSolved(p) && !p.hold ? p.name : undefined;
}

/** The item a finding's `location` names: a path of block names through `doc`, then an entry of
 *  the sheet it reaches — a param, an equation, a check, its device (`givens`) — or the sheet. */
function locate(doc: SheetDoc | undefined, location: string | undefined): ItemRef {
  // Where an expression is named as the evaluation names it: `equation "x"`, `check "c" lhs`,
  // `given vds`.
  const quoted = /^(equation|check) "([^"]+)"/.exec(location ?? '');
  if (quoted)
    return { kind: quoted[1] === 'check' ? 'requirement' : 'value', path: [], name: quoted[2] };
  if (/^given /.test(location ?? '')) return { kind: 'device', path: [], name: 'givens' };
  const parts = (location ?? '').split('.').filter(Boolean);
  const path: string[] = [];
  let d = doc;
  while (parts.length && d?.blocks?.some((b) => b.name === parts[0])) {
    const b = d.blocks.find((x) => x.name === parts[0]);
    path.push(parts.shift() as string);
    d = b?.doc;
  }
  const name = parts.join('.');
  if (!name || !d) return { kind: 'sheet', path, name: '' };
  if (name === 'givens') return { kind: 'device', path, name: 'givens' };
  const p = d.params.find((x) => x.name === name);
  if (p) return { kind: engineSolved(p) ? 'search' : 'value', path, name };
  if (d.equations.some((e) => e.name === name)) return { kind: 'value', path, name };
  if (d.checks.some((c) => c.id === name)) return { kind: 'requirement', path, name };
  return { kind: 'sheet', path, name: '' };
}

/** The item a finding of the netlist check names by what it is about: the sheet's own device, or
 *  a selector param of the sheet. Undefined where it names neither. */
function aboutRef(doc: SheetDoc | undefined, w: QAWarning): ItemRef | undefined {
  const a = w.about;
  if (!a || !doc) return undefined;
  if (a.param) {
    const p = Array.isArray(doc.params) ? doc.params.find((q) => q.name === a.param) : undefined;
    if (p) return { kind: engineSolved(p) ? 'search' : 'value', path: [], name: p.name };
  }
  if (a.devices?.length === 1 && a.devices[0] === 'givens' && doc.givens)
    return { kind: 'device', path: [], name: 'givens' };
  return undefined;
}

/** How the table below reads a finding: the cause it gives, or why a rule never reaches it. */
type FindingRead =
  | ((w: QAWarning, ref: ItemRef, stage: { stage?: 'validation' }) => Cause)
  | 'covered'
  | 'never-an-error';

/** A field of an entry that is not well formed: the entry it names cannot be read, and the rule
 *  says what kind of entry it is. A finding that names no entry of its own, only a list of the
 *  sheet (`blocks`, `params`), stays on the sheet item, where the sheet's statements leave its
 *  design undetermined: the sheet itself was read and evaluated. */
const entryNotWellFormed =
  (entry: NonNullable<NotReadData['entry']>, onSheet: 'entry' | 'operating-range' = 'entry') =>
  (w: QAWarning, ref: ItemRef, stage: { stage?: 'validation' }): Cause =>
    ref.kind === 'sheet' && ref.path.length === 0
      ? {
          kind: 'not-determined',
          data: {
            why: onSheet,
            names: w.location ? [w.location] : [],
            message: w.message,
            ...stage,
          },
        }
      : {
          kind: 'not-read',
          data: { why: 'field', where: w.location ?? '', message: w.message, entry, ...stage },
        };

/** A finding that the sheet's statements leave a value without one decision, or with two. */
const decisionCause = (
  w: QAWarning,
  d: NonNullable<QAWarning['decision']>,
  stage: { stage?: 'validation' },
): Cause => ({
  kind: 'not-determined',
  data: {
    why: d.kind === 'twice' ? 'decision-twice' : d.kind === 'loop' ? 'loop' : 'decision-missing',
    names: d.names,
    message: w.message,
    ...stage,
  },
});

/**
 * The cause each rule's error finding gives the item it is about. One entry for every rule the
 * sheet's validation and evaluation raise, and no default: a rule added without an entry fails
 * the test that reads the rules from the source. A rule whose findings are only warnings or notes
 * never reaches here; a rule whose errors already have their item is covered where it is raised.
 */
export const FINDING_CAUSES: Readonly<Record<string, FindingRead>> = {
  'sheet-format': (w, _ref, stage) => ({
    kind: 'not-read',
    data: { why: 'format', where: w.location ?? '', message: w.message, ...stage },
  }),
  'sheet-ref': (w, _ref, stage) => ({
    kind: 'not-read',
    data: { why: 'reference', where: w.location ?? '', message: w.message, ...stage },
  }),
  'sheet-parse': (w, ref, stage) =>
    ref.kind === 'value' || ref.kind === 'requirement'
      ? { kind: 'cannot-evaluate', data: { why: 'syntax', name: ref.name, reason: w.message } }
      : entryNotWellFormed('expression')(w, ref, stage),
  'sheet-param': (w, ref, stage) =>
    w.decision ? decisionCause(w, w.decision, stage) : entryNotWellFormed('param')(w, ref, stage),
  'sheet-dc-inputs': (w, ref, stage) =>
    w.decision
      ? decisionCause(w, w.decision, stage)
      : ref.kind === 'sheet' && ref.path.length === 0
        ? {
            kind: 'not-determined',
            data: {
              why: 'assumed-level',
              names: w.location ? [w.location] : [],
              message: w.message,
              ...stage,
            },
          }
        : entryNotWellFormed('param')(w, ref, stage),
  // A finding of the netlist check about wires or devices is on the device it names, where that
  // is the sheet's own, or a selector the table contradicts; on the sheet otherwise, with the
  // wires in `names`. Without them, one located at a param is about the param's own entry: an
  // axis-sign selector whose value or convention is not one it may take.
  'sheet-nodes': (w, ref, stage) =>
    !w.about && (ref.kind === 'value' || ref.kind === 'search')
      ? entryNotWellFormed('selector')(w, ref, stage)
      : {
          kind: 'not-determined',
          data: {
            why: 'netlist',
            names: w.about?.wires?.length
              ? w.about.wires
              : w.about?.devices?.length
                ? w.about.devices
                : w.location
                  ? [w.location]
                  : [],
            message: w.message,
            ...(w.about ? { netlist: w.about } : {}),
            ...stage,
          },
        },
  'sheet-range': entryNotWellFormed('range-end', 'operating-range'),
  'sheet-block': entryNotWellFormed('block'),
  'sheet-check': entryNotWellFormed('check'),
  'sheet-tol': entryNotWellFormed('tolerance'),
  'sheet-givens': entryNotWellFormed('device'),
  // Errors that already have their item, written where they were raised: a failed search, an
  // equation that gives no number, a block whose values from its parent did not resolve.
  'sheet-solve': 'covered',
  'sheet-nonfinite': 'covered',
  'sheet-block-param': 'covered',
  'sheet-array': 'never-an-error',
  'sheet-assumption': 'never-an-error',
  'sheet-collision': 'never-an-error',
  'sheet-eval': 'never-an-error',
  'sheet-follow-on': 'never-an-error',
  'sheet-held-current': 'never-an-error',
  'sheet-held-gate': 'never-an-error',
  'sheet-noise-form': 'never-an-error',
  'sheet-passthrough': 'never-an-error',
  'sheet-pinned': 'never-an-error',
  'sheet-polarity': 'never-an-error',
  'sheet-provide': 'never-an-error',
  'sheet-provide-coverage': 'never-an-error',
  'sheet-table-temperature': 'never-an-error',
  'sheet-undeclared': 'never-an-error',
};

/** The cause an error finding gives the item it is about, by its rule (FINDING_CAUSES). */
function findingCause(w: QAWarning, ref: ItemRef, mode: 'evaluation' | 'validation'): Cause {
  const stage = mode === 'validation' ? { stage: 'validation' as const } : {};
  const read = FINDING_CAUSES[w.rule];
  // A rule the table does not list: the item it names fails, with the rule as data. The test of
  // the table fails the build before this is reached; the evaluator never throws.
  if (typeof read !== 'function')
    return {
      kind: 'not-read',
      data: { why: 'field', where: w.location ?? '', message: w.message, rule: w.rule, ...stage },
    };
  return read(w, ref, stage);
}

/**
 * The item list with every error finding in `warnings` given to the item it is about: the entry
 * its location names, failed with the cause its rule gives — the sheet where it names no entry.
 * An item that already failed keeps its cause. `mode` says where the findings come from: an
 * evaluation, whose findings from a block are already on the block's own items; or validation
 * of the whole document, whose findings name entries at any depth.
 */
export function withFindings(
  items: readonly Item[],
  warnings: readonly QAWarning[],
  doc: SheetDoc | undefined,
  mode: 'evaluation' | 'validation',
): Item[] {
  const out = [...items];
  for (const w of warnings) {
    if (w.severity !== 'error' || FINDING_CAUSES[w.rule] === 'covered' || w.cause !== undefined)
      continue;
    const ref = aboutRef(doc, w) ?? locate(doc, w.location);
    // A block's own findings are on its own items, under its name.
    if (mode === 'evaluation' && ref.path.length) continue;
    const cause = findingCause(w, ref, mode);
    const at = out.findIndex(
      (i) => i.kind === ref.kind && i.name === ref.name && i.path.join('.') === ref.path.join('.'),
    );
    // An item keeps its first cause, except a design resting on an assumed level, which a finding
    // about how the sheet is written takes the place of.
    const prior = out[at];
    const weaker =
      prior?.status === 'failed' &&
      prior.cause.kind === 'not-determined' &&
      prior.cause.data.why === 'assumed-level';
    if (at < 0) out.push({ ...ref, status: 'failed', cause });
    else if (prior.status !== 'failed' || weaker) out[at] = { ...ref, status: 'failed', cause };
  }
  return out;
}
