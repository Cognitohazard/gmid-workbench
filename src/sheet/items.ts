// The item list of one evaluation (see states.ts), built once at the end of a node's evaluation from
// the evaluation's own records: the causes its searches wrote, its device's sizing, its equations
// and the names it withheld, its checks, and its blocks' own lists under their names.

import {
  engineSolved,
  failedParams,
  isHardCheck,
  namesOf,
  unfoundIn,
  type SheetDoc,
  type SheetResult,
  type SizingReport,
  type SolveFailure,
} from './types';
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

/** A child's items as its parent lists them: under the block's name. */
const under = (block: string, items: readonly Item[]): Item[] =>
  items.map((i) =>
    i.status === 'withheld'
      ? {
          ...i,
          path: [block, ...i.path],
          on: i.on.map((o) => ({ ...o, path: [block, ...o.path] })),
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
    const w = written.find((i) => i.kind === 'search' && i.name === p.name);
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
    const on =
      s && !s.ok ? (res.withheld?.W !== undefined ? withheldOn('W') : undefined) : undefined;
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
              cause: {
                kind: 'cannot-evaluate',
                data: {
                  why: e.name in res.values ? 'not-finite' : 'not-defined',
                  name: e.name,
                  reason:
                    e.name in res.values
                      ? `equation "${e.name}" evaluated to a non-finite number from resolved inputs`
                      : `equation "${e.name}" did not resolve`,
                },
              },
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
        cause: failsCause({ ...r, text: { lhs, op, rhs } }),
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
            cause: {
              kind: 'cannot-evaluate',
              data: { why: 'not-finite', name: r.id, reason: r.detail ?? '' },
            },
          },
    );
  }

  // The blocks, each under its name.
  for (const b of res.blocks ?? []) out.push(...under(b.name, b.items ?? []));
  return out;
}

/** A check's two sides as the sheet writes them, read back from its text. */
function splitCheckText(
  text: string,
  op: '>=' | '<=' | '==',
): [string, '>=' | '<=' | '==', string] {
  const i = text.indexOf(` ${op} `);
  return i < 0 ? [text, op, ''] : [text.slice(0, i), op, text.slice(i + op.length + 2)];
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
