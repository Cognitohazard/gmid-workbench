// The item list of one evaluation (see states.ts), built once at the end of a node's evaluation from
// the evaluation's own records: the causes its searches wrote, its device's sizing, its equations
// and the names it withheld, its checks, and its blocks' own lists under their names.

import { CONSTANTS } from '../constants';
import {
  CHECK_OPS,
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
  type Region,
  type SheetBlockReport,
  type SheetDoc,
  type SheetResult,
  type SizingReport,
  type SolveFailure,
} from './types';
import type { EntryAbout, FindingAbout, NetlistAbout, QAWarning } from '../types';
import { syntaxAt } from '../expr';
import {
  failsCause,
  endEntryNotWellFormed,
  heldVerdictOf,
  sheetVerdictOf,
  type EndList,
  type HeldVerdict,
  type Verdict,
  type NotReadData,
  type RelationField,
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

  // The searches. A param whose value is not a finite number is failed here, as the list is
  // built, so that what reads it is withheld on it; validation's finding about it, which names the
  // field, takes its place (withFindings).
  for (const p of doc.params) {
    if (!engineSolved(p) && !p.hold) {
      out.push(
        typeof p.value === 'number' && Number.isFinite(p.value)
          ? { kind: 'value', path: [], name: p.name, status: 'ok' }
          : {
              kind: 'value',
              path: [],
              name: p.name,
              status: 'failed',
              // Validation's own finding, which every run of the sheet carries on this item.
              cause: {
                kind: 'not-read',
                data: {
                  why: 'field',
                  where: p.name,
                  message: `param "${p.name}" is not a finite number`,
                  entry: 'param',
                  field: { name: 'value', value: p.value, problem: 'not-a-number' },
                  stage: 'validation',
                },
              },
            },
      );
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
        withSyntax(
          equationCause(e.name, res.warnings, reading.undeclared(e.expr), {
            expr: e.expr,
            values: res.values,
          }),
          { kind: 'value', path: [], name: e.name },
          doc,
        ),
      ),
    );
  }

  // The requirements: one item for each id, so a check written twice under one id is one item,
  // which the finding that the id is doubled reaches.
  for (const r of res.checks) {
    if (out.some((i) => i.kind === 'requirement' && i.path.length === 0 && i.name === r.id))
      continue;
    // An operator the engine does not know: the check is not read, whatever its sides give, since
    // no meaning was written for it to be judged by.
    if (!CHECK_OPS.has(r.op)) {
      out.push({
        kind: 'requirement',
        path: [],
        name: r.id,
        status: 'failed',
        cause: {
          kind: 'not-read',
          data: {
            why: 'field',
            where: r.id,
            message: `check "${r.id}" has an operator the engine does not know`,
            entry: 'check',
            field: { name: 'op', value: r.op, problem: 'operator' },
            classified: r.status === 'pass' || r.status === 'amber' ? 'pass' : 'fail',
          },
        },
      });
      continue;
    }
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
        cause: failsCause({
          ...r,
          text: { lhs, op, rhs },
          // The check a declared region adds compares two voltages of the device.
          ...(r.id === REGION_CHECK_ID && isRegion(doc.givens?.region)
            ? { unit: 'V', region: doc.givens.region }
            : { unit: unitOfSides(doc, lhs, rhs) }),
        }),
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

const isRegion = (r: unknown): r is Region => r === 'saturation' || r === 'triode';

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
export const resolveWithheld = (list: readonly Item[]): Item[] => {
  const items = list.map((i) => onWhatStoppedIt(i, list));
  return resolveIn(items);
};

/** A search that nothing of its range evaluates, stopped by an item that failed in the final
 *  list, is withheld on that item: the failure is that item's, counted once. One stopped by an
 *  item that is itself withheld stays failed, since that item may be waiting on this very search. */
function onWhatStoppedIt(i: Item, list: readonly Item[]): Item {
  if (i.kind !== 'search' || i.status !== 'failed' || i.cause.kind !== 'cannot-evaluate') return i;
  const at = i.cause.data.unevaluable?.at.where;
  const by = at && at !== 'one-point' ? i.cause.data.by : undefined;
  // A requirement stops nothing from evaluating: a search is never withheld on one.
  if (!by || by.kind === 'requirement') return i;
  const target = list.find(
    (x) => x.status === 'failed' && fullName(x) === fullName(by) && x.kind === by.kind,
  );
  if (!target || target.status !== 'failed' || fullName(target) === fullName(i)) return i;
  return {
    kind: i.kind,
    path: i.path,
    name: i.name,
    status: 'withheld',
    on: [{ kind: target.kind, path: target.path, name: target.name, cause: target.cause.kind }],
  };
}

const resolveIn = (items: readonly Item[]): Item[] =>
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
function resolveOn(items: readonly Item[], o: WithheldOn, depth = 0): WithheldOn {
  const name = fullName(o);
  const hits = items.filter((i) => fullName(i) === name);
  const hit = hits.find((i) => i.status === 'failed') ?? hits[0];
  if (!hit) return o;
  const ref = { kind: hit.kind, path: hit.path, name: hit.name };
  if (hit.status === 'failed') return { ...ref, cause: hit.cause.kind };
  // A withheld item: what it waits on, resolved in turn, as the parent names it. A chain is
  // followed as far as the list goes, never round a loop.
  if (hit.status === 'withheld' && hit.on[0] && fullName(hit.on[0]) !== name) {
    const {
      frame: _frame,
      inputs: _inputs,
      ...next
    } = hit.on[0] as WithheldOn & {
      inputs?: unknown;
    };
    return depth < items.length ? resolveOn(items, next as WithheldOn, depth + 1) : hit.on[0];
  }
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
  return o.frame !== undefined ? o : { ...ref, cause: o.cause };
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
function equationCause(
  name: string,
  warnings: readonly QAWarning[],
  undeclared?: string,
  read?: { expr: string; values: Readonly<Record<string, number>> },
): Cause {
  const parse = warnings.find((w) => w.severity === 'error' && w.location === `equation "${name}"`);
  if (parse)
    return { kind: 'cannot-evaluate', data: { why: 'syntax', name, reason: parse.message } };
  if (undeclared !== undefined)
    return { kind: 'cannot-evaluate', data: { why: 'not-defined', name: undeclared, reason: '' } };
  const nonFinite = warnings.find((w) => w.rule === 'sheet-nonfinite' && w.location === name);
  const notFinite = read
    ? namesOf(read.expr).filter(
        (n) =>
          Object.prototype.hasOwnProperty.call(read.values, n) && !Number.isFinite(read.values[n]),
      )
    : undefined;
  return {
    kind: 'cannot-evaluate',
    data: {
      why: 'not-finite',
      name,
      reason: nonFinite?.message ?? '',
      ...(notFinite ? { notFinite } : {}),
    },
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
  // A table that does not sweep an axis the givens ask for: the refusal is the error, whatever
  // else the givens still leave to declare.
  if (s?.unswept?.length)
    return {
      kind: 'cannot-evaluate',
      data: { why: 'no-sweep', name: s.unswept.join(', '), reason: s.error ?? '' },
    };
  if (s?.needs?.length)
    return {
      kind: 'cannot-evaluate',
      data: { why: 'no-column', name: s.needs.join(', '), reason: s.error ?? '' },
    };
  if (s?.notPositive)
    return {
      kind: 'cannot-evaluate',
      data: {
        why: 'not-finite',
        name: s.notPositive.quantity,
        reason: s.error ?? '',
        sizing: s.notPositive,
      },
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
  // A block with no name: its own sheet item, under the empty name, holds what is wrong with it.
  if (location === 'blocks' && doc?.blocks?.some((b) => !b?.name?.trim()))
    return { kind: 'sheet', path: [''], name: '' };
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

/** The problems the netlist check raises on one placement of a part. */
const ON_A_PLACEMENT: ReadonlySet<NetlistAbout['problem']> = new Set([
  'placement',
  'short',
  'diode-flag',
]);

/** The item a finding of the netlist check names by what it is about: the sheet's own device, or
 *  a selector param of the sheet. Undefined where it names neither. */
function aboutRef(doc: SheetDoc | undefined, w: QAWarning): ItemRef | undefined {
  const a = netlistOf(w);
  if (!a || !doc) return undefined;
  // A finding the netlist check raises on a placement (a placement that is not well formed, a
  // drain and source on one wire, a diode flag its wires contradict) is a finding of the netlist
  // of the sheet that writes the placement: on that sheet's own item, its location less the last
  // segment (`nodes` for the sheet's own device, the block's name for a part it composes). The
  // part's own item is not failed by it.
  if (ON_A_PLACEMENT.has(a.problem))
    return { kind: 'sheet', path: (w.location ?? '').split('.').slice(0, -1), name: '' };
  // A selector the table contradicts is on its own item; where its value is not +1 or -1 that item
  // holds the finding that its entry is not well formed, and the contradiction is on the sheet.
  if (a.param) {
    const p = Array.isArray(doc.params) ? doc.params.find((q) => q.name === a.param) : undefined;
    if (p && (p.value === 1 || p.value === -1))
      return { kind: engineSolved(p) ? 'search' : 'value', path: [], name: p.name };
    if (p) return undefined;
  }
  if (a.devices?.length === 1 && a.devices[0] === 'givens' && doc.givens)
    return { kind: 'device', path: [], name: 'givens' };
  return undefined;
}

/** What a finding says it is about, by kind. */
const netlistOf = (w: QAWarning): NetlistAbout | undefined => {
  if (w.about?.kind !== 'netlist') return undefined;
  const { kind: _kind, ...n } = w.about;
  return n;
};
const decisionOf = (w: QAWarning): Extract<FindingAbout, { kind: 'decision' }> | undefined =>
  w.about?.kind === 'decision' ? w.about : undefined;
const entryOf = (w: QAWarning): EntryAbout | undefined =>
  w.about?.kind === 'entry' ? w.about : undefined;

/** How the table below reads a finding: the cause it gives, or why a rule never reaches it. */
type FindingRead =
  | ((w: QAWarning, ref: ItemRef, stage: { stage?: 'validation' }) => Cause)
  | 'covered'
  | 'never-an-error';

/** A field of an entry that is not well formed: the entry it names cannot be read, and the rule
 *  says what kind of entry it is; the field and its value as written, where the finding holds
 *  them. */
const entryNotWellFormed =
  (entry: NonNullable<NotReadData['entry']>) =>
  (w: QAWarning, _ref: ItemRef, stage: { stage?: 'validation' }): Cause => ({
    kind: 'not-read',
    data: {
      why: 'field',
      where: w.location ?? '',
      message: w.message,
      entry,
      ...fieldOf(w),
      ...stage,
    },
  });

/** The field a finding says is not well formed, as an item's cause holds it. */
const fieldOf = (w: QAWarning): { field?: NonNullable<NotReadData['field']> } => {
  const e = entryOf(w);
  if (!e) return {};
  const { kind: _kind, field, ...rest } = e;
  return { field: { name: field, ...rest } };
};

/** For each of `names` that more than one statement sets in `doc`: the fields that set it. */
export function twiceStatements(
  doc: SheetDoc | undefined,
  names: readonly string[],
): { name: string; fields: RelationField[] }[] {
  const params = Array.isArray(doc?.params) ? doc.params : [];
  return names.flatMap((name) => {
    const p = params.find((q) => q?.name === name);
    if (!p) return [];
    const fields = (['designConstraint', 'solveFor', 'hold'] as const).filter(
      (f) => p[f] !== undefined,
    );
    return fields.length > 1 ? [{ name, fields }] : [];
  });
}

/** A syntax error's cause with the expression and where the parser refuses it, read from the
 *  entry of `doc` the item names. Any other cause as it is. */
export function withSyntax(cause: Cause, ref: ItemRef, doc: SheetDoc | undefined): Cause {
  if (cause.kind !== 'cannot-evaluate' || cause.data.why !== 'syntax' || ref.path.length)
    return cause;
  const sources =
    ref.kind === 'requirement'
      ? (doc?.checks ?? []).filter((c) => c.id === ref.name).flatMap((c) => [c.lhs, c.rhs])
      : (doc?.equations ?? []).filter((e) => e.name === ref.name).map((e) => e.expr);
  for (const expression of sources) {
    if (typeof expression !== 'string') continue;
    const at = syntaxAt(expression);
    if (at) return { ...cause, data: { ...cause.data, syntax: { expression, ...at } } };
  }
  return cause;
}

/** A cause with the statements of a value that more than one statement sets, where the sheet
 *  shows them. Any other cause as it is. */
export function withStatements(cause: Cause, doc: SheetDoc | undefined): Cause {
  if (cause.kind !== 'not-determined' || cause.data.why !== 'decision-twice') return cause;
  const statements = twiceStatements(doc, cause.data.names);
  return statements.length ? { ...cause, data: { ...cause.data, statements } } : cause;
}

/** A finding that the sheet's statements leave a value without one decision, or with two. */
const decisionCause = (
  w: QAWarning,
  d: Extract<FindingAbout, { kind: 'decision' }>,
  stage: { stage?: 'validation' },
): Cause => ({
  kind: 'not-determined',
  data: {
    why:
      d.decision === 'twice'
        ? 'decision-twice'
        : d.decision === 'loop'
          ? 'loop'
          : 'decision-missing',
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
    data: {
      why: 'reference',
      where: w.location ?? '',
      message: w.message,
      ...fieldOf(w),
      ...stage,
    },
  }),
  'sheet-parse': (w, ref, stage) =>
    ref.kind === 'value' || ref.kind === 'requirement'
      ? { kind: 'cannot-evaluate', data: { why: 'syntax', name: ref.name, reason: w.message } }
      : entryNotWellFormed('expression')(w, ref, stage),
  'sheet-param': (w, ref, stage) => {
    const d = decisionOf(w);
    return d ? decisionCause(w, d, stage) : entryNotWellFormed('param')(w, ref, stage);
  },
  'sheet-dc-inputs': (w, ref, stage) =>
    decisionOf(w)
      ? decisionCause(w, decisionOf(w)!, stage)
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
  'sheet-nodes': (w, ref, stage) => {
    const n = netlistOf(w);
    if (!n && (ref.kind === 'value' || ref.kind === 'search'))
      return entryNotWellFormed('selector')(w, ref, stage);
    const finding: NetlistAbout = n ?? {
      problem: 'other',
      ...(w.location ? { where: w.location } : {}),
    };
    return {
      kind: 'not-determined',
      data: {
        why: 'netlist',
        names: netlistNames([finding]),
        message: w.message,
        netlist: [finding],
        ...stage,
      },
    };
  },
  'sheet-range': entryNotWellFormed('range-end'),
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
/** The causes of the findings the table calls covered, for a list no evaluation made (withFindings,
 *  `uncovered`): a block override of a name its sheet does not have reads as the block entry's
 *  field, as the evaluation gives it. */
const UNCOVERED: Readonly<
  Record<string, (w: QAWarning, ref: ItemRef, stage: { stage?: 'validation' }) => Cause>
> = {
  'sheet-block-param': entryNotWellFormed('block'),
};
const stageOf = (mode: 'evaluation' | 'validation'): { stage?: 'validation' } =>
  mode === 'validation' ? { stage: 'validation' } : {};
/** A finding no rule reads: the item it names fails, with the rule as data. */
const fallbackCause = (w: QAWarning, _ref: ItemRef, stage: { stage?: 'validation' }): Cause => ({
  kind: 'not-read',
  data: { why: 'field', where: w.location ?? '', message: w.message, rule: w.rule, ...stage },
});

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

/** The names a list of netlist findings is about: each finding's wires, else its devices, else
 *  where it is located; each name once, in the order raised. */
function netlistNames(fs: readonly NetlistAbout[]): string[] {
  const out: string[] = [];
  for (const f of fs)
    for (const n of f.wires?.length
      ? f.wires
      : f.param
        ? [f.param]
        : f.devices?.length
          ? f.devices
          : f.where
            ? [f.where]
            : [])
      if (!out.includes(n)) out.push(n);
  return out;
}

/** The cause an item takes when a finding reaches it that already failed: two findings of the
 *  netlist check on one item are one cause listing both, in the order raised; validation's finding
 *  that an entry is not well formed takes the place of a cause that came from evaluating that entry,
 *  whose result cannot be trusted, and of a design resting on an assumed level. Otherwise the
 *  item keeps its first cause. */
function nextCause(prior: Cause, found: Cause): Cause {
  if (
    prior.kind === 'not-determined' &&
    prior.data.why === 'netlist' &&
    found.kind === 'not-determined' &&
    found.data.why === 'netlist'
  ) {
    const netlist = [...(prior.data.netlist ?? []), ...(found.data.netlist ?? [])];
    return {
      kind: 'not-determined',
      data: { ...prior.data, netlist, names: netlistNames(netlist) },
    };
  }
  const assumed = prior.kind === 'not-determined' && prior.data.why === 'assumed-level';
  const fromEvaluation =
    !('stage' in prior.data) || (prior.data as { stage?: string }).stage !== 'validation';
  // A syntax error the evaluation read, with where the parser stops, is the more specific of the
  // two where validation found the same expression does not parse.
  const sameSyntax =
    prior.kind === 'cannot-evaluate' &&
    prior.data.why === 'syntax' &&
    found.kind === 'not-read' &&
    found.data.field?.problem === 'syntax';
  if (
    found.kind === 'not-read' &&
    (found.data.why === 'field' || found.data.why === 'reference') &&
    found.data.stage === 'validation' &&
    fromEvaluation &&
    !sameSyntax
  )
    return found;
  return assumed ? found : prior;
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
  /** Where no evaluation ran (a condition declined because the sheet does not validate), so no
   *  item covers a finding the table calls covered: such a finding goes on the item it names too,
   *  with the cause UNCOVERED gives its rule. */
  { uncovered = false }: { readonly uncovered?: boolean } = {},
): Item[] {
  const out = [...items];
  for (const w of warnings) {
    const covered = FINDING_CAUSES[w.rule] === 'covered';
    if (w.severity !== 'error' || (covered && !uncovered) || w.cause !== undefined) continue;
    const ref = aboutRef(doc, w) ?? locate(doc, w.location);
    // A block's own findings are on its own items, under its name.
    if (mode === 'evaluation' && ref.path.length) continue;
    const cause = withSyntax(
      withStatements(
        covered
          ? (UNCOVERED[w.rule] ?? fallbackCause)(w, ref, stageOf(mode))
          : findingCause(w, ref, mode),
        doc,
      ),
      ref,
      doc,
    );
    const at = out.findIndex(
      (i) =>
        i.kind === ref.kind &&
        i.name === ref.name &&
        i.path.length === ref.path.length &&
        i.path.every((p, k) => p === ref.path[k]),
    );
    const prior = out[at];
    if (at < 0) out.push({ ...ref, status: 'failed', cause });
    else
      out[at] = {
        ...ref,
        status: 'failed',
        cause: prior.status === 'failed' ? nextCause(prior.cause, cause) : cause,
      };
  }
  return out;
}

/** Whether a validation finding is about the sheet as a whole rather than about an entry a run
 *  evaluates: a finding of the netlist check, one about a decision, or one that names no entry. A
 *  range end's list takes the findings about the entries its run evaluates (see runSheet); one
 *  about the sheet as a whole is read in the design point's list. */
export function aboutTheSheet(doc: SheetDoc | undefined, w: QAWarning): boolean {
  if (w.about?.kind === 'netlist' || w.about?.kind === 'decision') return true;
  const ref = aboutRef(doc, w) ?? locate(doc, w.location);
  return ref.kind === 'sheet' && ref.path.length === 0;
}

/** The list of a range end the engine does not calculate, because the design point gives no
 *  design: its one sheet item, withheld on each item of the design point's list that is failed
 *  (other than a requirement that fails, which leaves the design standing) or held instead of
 *  solved. */
export function notCalculated(design: readonly Item[]): Item[] {
  const on: WithheldOn[] = design.flatMap((i): WithheldOn[] => {
    const ref = { kind: i.kind, path: i.path, name: i.name };
    return i.status === 'failed' && i.cause.kind !== 'fails'
      ? [{ ...ref, frame: 'design', cause: i.cause.kind }]
      : [];
  });
  return [{ kind: 'sheet', path: [], name: '', status: 'withheld', on }];
}

/** Whether a run gives a number for one of its named results: the item of that name at the top of
 *  the list is ok. A name with no item of its own, as a value a composed block provides is read by
 *  its parent (`amp__gain`), is read from the run's withheld record. */
export function givesValue(
  res: Pick<SheetResult, 'items' | 'values' | 'withheld'>,
  name: string,
): boolean {
  const own = res.items?.find(
    (i) => i.path.length === 0 && i.name === name && (i.kind === 'value' || i.kind === 'search'),
  );
  if (own) return own.status === 'ok' && res.values[name] !== undefined;
  return res.withheld?.[name] === undefined && res.values[name] !== undefined;
}

/** Every string a part of an entry holds, at any depth. */
const stringsIn = (x: unknown): string[] =>
  typeof x === 'string'
    ? [x]
    : Array.isArray(x)
      ? x.flatMap(stringsIn)
      : x !== null && typeof x === 'object'
        ? Object.values(x).flatMap(stringsIn)
        : [];

/** The names an expression reads, or none where it does not parse. */
const readsOf = (expr: string): readonly string[] => {
  try {
    return namesOf(expr);
  } catch {
    return [];
  }
};

/**
 * The equations of a sheet that no requirement and no output reads, directly or through other
 * equations: no check, no value it provides, no relation it solves or holds, no device, block,
 * level, element, analysis or range end reads them. Whether such a value, where it fails or is
 * withheld, makes the verdict undetermined or only shows as not calculated is not yet ruled
 * (OPEN_RULINGS.unreadValue); this is the one place that says which values it is about.
 */
export function unreadValues(doc: SheetDoc | undefined): ReadonlySet<string> {
  if (!doc || !Array.isArray(doc.equations)) return new Set();
  const list = <T>(x: readonly T[] | undefined): readonly T[] => (Array.isArray(x) ? x : []);
  const read = new Set<string>(list(doc.provides));
  const sources: unknown[] = [
    list(doc.checks).map((c) => [c?.lhs, c?.rhs]),
    list(doc.params).map((p) => [p?.designConstraint, p?.solveFor, p?.hold]),
    doc.givens,
    list(doc.blocks).map((b) => b?.params),
    doc.levels,
    doc.elements,
    doc.analyses,
    list(doc.operatingRange).map((e) => e?.set),
  ];
  for (const text of stringsIn(sources)) for (const n of readsOf(text)) read.add(n);
  // What a read equation reads is read too, as far as the equations go.
  const byName = new Map(doc.equations.map((e) => [e?.name, e?.expr]));
  const queue = [...read].filter((n) => byName.has(n));
  while (queue.length) {
    const expr = byName.get(queue.pop() as string);
    for (const n of typeof expr === 'string' ? readsOf(expr) : [])
      if (!read.has(n)) {
        read.add(n);
        if (byName.has(n)) queue.push(n);
      }
  }
  return new Set(doc.equations.map((e) => e?.name).filter((n) => !read.has(n)));
}

/** Whether a list is the one of a range end the engine does not calculate because the design point
 *  gives no design (notCalculated). */
export const isNotCalculated = (items: readonly Item[]): boolean =>
  items.length === 1 &&
  items[0].status === 'withheld' &&
  items[0].on.some((o) => o.frame === 'design');

/** The verdict of a range end, from its list, held design's words (heldVerdictOf). Absent where the
 *  engine did not calculate the end: its list is one sheet item that is not ok, withheld on the
 *  design point (notCalculated) or failed because its `set` does not resolve; or its own entry is
 *  not well formed (endEntryNotWellFormed), wherever its sheet item is in the list. */
export function endVerdict(
  items: readonly Item[] | undefined,
  doc: SheetDoc | undefined,
): Verdict<HeldVerdict> | undefined {
  if (!items?.length) return undefined;
  if (items.length === 1 && items[0].kind === 'sheet' && items[0].status !== 'ok') return undefined;
  // An end whose own entry is not well formed is not calculated, though the engine ran it.
  if (endEntryNotWellFormed(items)) return undefined;
  return heldVerdictOf(items, unreadValues(doc));
}

/** The items of the block at `path` in a list, named within the block: the list's items under that
 *  path, the path taken off them and off what each withheld one waits on. The block's own sheet item
 *  waits on its parent, named as the parent names it, so its pointers are kept as they are. */
function itemsWithin(items: readonly Item[], path: readonly string[]): Item[] {
  const inside = (r: { path: readonly string[] }): boolean =>
    r.path.length >= path.length && path.every((p, k) => r.path[k] === p);
  return items.filter(inside).map((i): Item => {
    const own = { ...i, path: i.path.slice(path.length) };
    if (own.status !== 'withheld' || ownSheet(own)) return own;
    return {
      ...own,
      on: own.on.map((o) => (inside(o) ? { ...o, path: o.path.slice(path.length) } : o)),
    };
  });
}

/**
 * Each block report of a run with its own list taken from the run's list (one list: a block's
 * card, its verdict and the sheet's list say the same), and its verdict formed from that list and
 * the block's own document. Where the block is designed (`held` false) the verdict is a design
 * verdict (`verdict`); where its hardware is held (a range end, a run that holds the design) it is
 * the held design's verdict (`heldVerdict`), formed as a range end's is. Neither where the block
 * was not calculated: its own sheet item is withheld. Nested blocks the same.
 */
export function blockLists(
  doc: SheetDoc | undefined,
  items: readonly Item[] | undefined,
  blocks: readonly SheetBlockReport[] | undefined,
  held: boolean,
  path: readonly string[] = [],
): SheetBlockReport[] | undefined {
  if (!blocks || !items) return blocks ? [...blocks] : undefined;
  return blocks.map((b) => {
    const at = [...path, b.name];
    // The block's own sheet item where its parent gives it no value: the run's list says so in the
    // parent's terms; the block's own list keeps the frame that names the inputs it was not given.
    const before = b.items?.find(ownSheet);
    const own = itemsWithin(items, at).map((i) =>
      ownSheet(i) &&
      i.status === 'withheld' &&
      before?.status === 'withheld' &&
      before.on.every((o) => o.frame === 'parent')
        ? before
        : i,
    );
    const blockDoc = Array.isArray(doc?.blocks)
      ? doc.blocks.find((x) => x?.name === b.name)?.doc
      : undefined;
    const { verdict: _v, heldVerdict: _h, ...rest } = b;
    const self = own.find(ownSheet);
    const verdict =
      !self || self.status === 'withheld'
        ? {}
        : held
          ? { heldVerdict: heldVerdictOf(own, unreadValues(blockDoc)) }
          : { verdict: designVerdict(blockDoc, own) };
    const below = blockLists(blockDoc, items, b.blocks, held, at);
    return { ...rest, items: own, ...verdict, ...(below ? { blocks: below } : {}) };
  });
}

/** The verdict of a sheet (sheetVerdictOf) from its document, its design point's list and its range
 *  ends' lists: the one place a verdict of a sheet is formed, so the values no requirement and no
 *  output reads (unreadValues) are always the document's own. */
export const designVerdict = (
  doc: SheetDoc | undefined,
  design: readonly Item[],
  ends: readonly EndList[] = [],
): Verdict => sheetVerdictOf(design, ends, unreadValues(doc));
