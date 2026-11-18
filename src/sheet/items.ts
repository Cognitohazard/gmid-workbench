// The item list of one evaluation (see states.ts), built once at the end of a node's evaluation from
// the evaluation's own records: the causes its searches wrote, its device's sizing, its equations
// and the names it withheld, its checks, and its blocks' own lists under their names.

import {
  engineSolved,
  failedParams,
  isHardCheck,
  namesOf,
  OWN_DEVICE,
  unfoundIn,
  unitOfSides,
  type SheetDoc,
  type SheetResult,
  type SizingReport,
  type SolveFailure,
} from './types';
import type { QAWarning } from '../types';
import { causeOfFailure } from './derived';
import { failsCause, type Cause, type Item, type ItemRef, type WithheldOn } from './states';

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
  failures: readonly { failure: SolveFailure }[],
  unfound: ReadonlyMap<string, string>,
): Item[] {
  const out: Item[] = [];
  const named = new Set<string>();
  for (const { failure } of failures) {
    const cause = causeOfFailure(failure);
    if (!cause) continue;
    if (cause.kind === 'not-determined') {
      out.push({ kind: 'sheet', path: [], name: '', status: 'failed', cause });
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
              cause: deviceCause(s),
            };
    out.push(item);
  }

  // The equations.
  for (const e of doc.equations) {
    const on = withheldOn(e.name);
    out.push(
      Number.isFinite(res.values[e.name])
        ? { kind: 'value', path: [], name: e.name, status: 'ok' }
        : on
          ? { kind: 'value', path: [], name: e.name, status: 'withheld', on }
          : {
              kind: 'value',
              path: [],
              name: e.name,
              status: 'failed',
              cause: equationCause(e.name, res.warnings),
            },
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
    // A check that gave no number: withheld where what it reads was withheld, else failed.
    const check = doc.checks.find((c) => c.id === r.id);
    const reads = check ? [check.lhs, check.rhs] : [];
    const on = reads.flatMap((x) => namesIn(x).flatMap((n) => withheldOn(n) ?? []));
    out.push(
      on.length
        ? { kind: 'requirement', path: [], name: r.id, status: 'withheld', on: [on[0]] }
        : {
            kind: 'requirement',
            path: [],
            name: r.id,
            status: 'failed',
            cause: requirementCause(r, res.warnings),
          },
    );
  }

  // The blocks, each under its name.
  for (const b of res.blocks ?? []) out.push(...under(b.name, b.items ?? []));
  return out;
}

/** The list with each of this sheet's withheld items, and each of its blocks' own sheet items,
 *  pointing at the item its withheld name traces back to, once every item and finding is in the
 *  list: a search, the device, or an item of a block. A block's other items were pointed when its
 *  list was made. */
export const resolveWithheld = (items: readonly Item[]): Item[] =>
  items.map((i) =>
    i.status === 'withheld' && (i.path.length === 0 || (i.kind === 'sheet' && i.path.length === 1))
      ? { ...i, on: i.on.map((o) => resolveOn(items, o)) }
      : i,
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
  return { ...ref, cause: o.cause };
}

/** A check's two sides as the sheet writes them, read back from its text. */
function splitCheckText(
  text: string,
  op: '>=' | '<=' | '==',
): [string, '>=' | '<=' | '==', string] {
  const i = text.indexOf(` ${op} `);
  return i < 0 ? [text, op, ''] : [text.slice(0, i), op, text.slice(i + op.length + 2)];
}

/** Why an equation gives no number, from what its evaluation found: a number that is not finite
 *  from inputs that all resolved, or a name it reads that is not defined (that name, as data). */
function equationCause(name: string, warnings: readonly QAWarning[]): Cause {
  const nonFinite = warnings.find((w) => w.rule === 'sheet-nonfinite' && w.location === name);
  if (nonFinite)
    return {
      kind: 'cannot-evaluate',
      data: { why: 'not-finite', name, reason: nonFinite.message },
    };
  const parse = warnings.find((w) => w.severity === 'error' && w.location === `equation "${name}"`);
  if (parse)
    return { kind: 'cannot-evaluate', data: { why: 'syntax', name, reason: parse.message } };
  const undeclared = warnings.find(
    (w) => w.rule === 'sheet-undeclared' && w.location === `equation "${name}"`,
  );
  return {
    kind: 'cannot-evaluate',
    data: {
      why: 'not-defined',
      name: undeclared?.symbol ?? name,
      reason: undeclared?.message ?? '',
    },
  };
}

/** Why a check gives no number: which side gave none, and, where a side reads a name that is
 *  not defined, that name. */
function requirementCause(
  r: { id: string; lhsValue: number; rhsValue: number; detail?: string },
  warnings: readonly QAWarning[],
): Cause {
  const l = Number.isFinite(r.lhsValue);
  const rr = Number.isFinite(r.rhsValue);
  const side = !l && !rr ? 'both' : !l ? 'lhs' : !rr ? 'rhs' : undefined;
  const undeclared = warnings.find(
    (w) => w.rule === 'sheet-undeclared' && (w.location ?? '').startsWith(`check "${r.id}" `),
  );
  return {
    kind: 'cannot-evaluate',
    data: {
      why: undeclared ? 'not-defined' : 'not-finite',
      name: undeclared?.symbol ?? r.id,
      reason: undeclared?.message ?? r.detail ?? '',
      ...(side ? { side } : {}),
    },
  };
}

/** The names an expression reads. */
const namesIn = (expr: string): string[] => [...namesOf(expr)];

/** Why a device did not size: read beyond its table, a table that lacks what it needs, or
 *  anything else the sizer said. */
function deviceCause(s: SizingReport | undefined): Cause {
  if (s?.outside?.length) return { kind: 'outside-table', data: s.outside[0] };
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

/** Rules whose errors already have their item, written where the error was raised: a failed
 *  search (sheet-solve), an equation that gives no number (sheet-nonfinite), a block whose
 *  values from its parent did not resolve (sheet-block-param). */
const COVERED = new Set(['sheet-solve', 'sheet-nonfinite', 'sheet-block-param']);

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

/** The cause an error finding gives the item it is about, by its rule. A finding of the netlist
 *  check (`sheet-nodes`) is about the sheet's wiring; one of declared assumed levels is about the
 *  sheet; anything else is a field of the entry it names that is not well formed. */
function findingCause(w: QAWarning, ref: ItemRef, mode: 'evaluation' | 'validation'): Cause {
  const stage = mode === 'validation' ? { stage: 'validation' as const } : {};
  const names = w.location ? [w.location] : [];
  if (ref.kind === 'sheet' && (w.rule === 'sheet-dc-inputs' || w.rule === 'sheet-nodes'))
    return {
      kind: 'not-determined',
      data: {
        why: w.rule === 'sheet-nodes' ? 'netlist' : 'assumed-level',
        names,
        message: w.message,
        ...stage,
      },
    };
  const why =
    w.rule === 'sheet-format' || w.rule === 'sheet-parse'
      ? 'format'
      : w.rule === 'sheet-ref'
        ? 'reference'
        : 'field';
  return { kind: 'not-read', data: { why, where: w.location ?? '', message: w.message, ...stage } };
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
    if (w.severity !== 'error' || COVERED.has(w.rule) || w.cause !== undefined) continue;
    const ref = locate(doc, w.location);
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
