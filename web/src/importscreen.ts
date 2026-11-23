// The import screen's rows: one per table, holding the device and each condition value as the
// designer sees and edits it, and how an edit becomes the table's new condition. Pure — the
// screen component and the bench call these, and the e2e suite pins what they produce.
//
// A value the designer types, or one the screen prefills from the file's own `# key: value`
// header when a dimension is added, is declared. A value the importer filled in by itself stays
// marked assumed until the designer types over it. The table's condition only ever changes
// through core's `withCondition`, so the screen and a script give a table the same identity.

import {
  conditionKeyOf,
  conditionOf,
  dimensionName,
  extraScalar,
  sameCondition,
  valueIn,
  withCondition,
  type ConditionDimension,
  type ConditionKey,
  type ConditionValue,
  type DeviceTable,
  type SheetDoc,
} from '@gmid/mostab-core';

export interface ImportRow {
  /** The file the table came from, or the stored table's label when the screen is reopened. */
  readonly name: string;
  /** The table as imported or stored. */
  readonly table: DeviceTable;
  /** Each dimension's value as text, by dimension name; '' when the table has none. */
  cells: Record<string, string>;
  /** The dimensions whose value the designer typed, or the screen read from the file's header. */
  declared: string[];
  /** Why this row's values cannot be applied; set by `applyRows`. */
  error?: string;
}

const names = (dims: readonly ConditionDimension[]): string[] =>
  dims.map((d) => dimensionName(d.name));

/** A table's row: its condition's value in each bench dimension, as text. */
export function rowOf(
  name: string,
  table: DeviceTable,
  dimensions: readonly ConditionDimension[],
): ImportRow {
  const cond = conditionOf(table.id);
  const cells: Record<string, string> = {};
  for (const n of names(dimensions)) {
    const v = valueIn(cond, n);
    cells[n] = v === undefined ? '' : String(v);
  }
  return { name, table, cells, declared: [] };
}

/** Whether a row's value in one dimension was filled in by the importer and not typed since. */
export const isAssumed = (row: ImportRow, dim: string): boolean =>
  !row.declared.includes(dim) && (row.table.meta.filled ?? []).includes(dim);

/** The designer typed `text` into a row's cell: the value is now declared. */
export function typed(row: ImportRow, dim: string, text: string): ImportRow {
  return {
    ...row,
    cells: { ...row.cells, [dim]: text },
    declared: row.declared.includes(dim) ? row.declared : [...row.declared, dim],
    error: undefined,
  };
}

/**
 * Add a condition dimension to the screen. Each row takes the value its table's condition
 * already holds in that dimension, else the value its file declared in a `# name: value` header
 * (declared, since the file said it), else nothing. Refused: an empty name, `device`, a name
 * already in the list, and a `temp` that is not a number.
 */
export function addDimension(
  dimensions: readonly ConditionDimension[],
  rows: readonly ImportRow[],
  raw: string,
  kind: ConditionDimension['kind'],
):
  { ok: true; dimensions: ConditionDimension[]; rows: ImportRow[] } | { ok: false; error: string } {
  const name = dimensionName(raw);
  if (name === '') return { ok: false, error: 'a dimension needs a name' };
  if (name === 'device') return { ok: false, error: 'the device is not a condition dimension' };
  if (names(dimensions).includes(name)) return { ok: false, error: `${name} is already listed` };
  if (name === 'temp' && kind !== 'number')
    return { ok: false, error: 'temp is a temperature in °C, a number' };
  const dim: ConditionDimension =
    name === 'temp' ? { name, kind, unit: '°C', fill: 27 } : { name, kind };
  return {
    ok: true,
    dimensions: [...dimensions, dim],
    rows: rows.map((r) => {
      const held = valueIn(conditionOf(r.table.id), name);
      if (held !== undefined) return { ...r, cells: { ...r.cells, [name]: String(held) } };
      const header = name === 'temp' ? declaredTemp(r.table) : extraScalar(r.table, name);
      return header === undefined
        ? { ...r, cells: { ...r.cells, [name]: '' } }
        : { ...r, cells: { ...r.cells, [name]: String(header) }, declared: [...r.declared, name] };
    }),
  };
}

/** The temperature a table's file declared, if it did: the importer moves `# temp:` out of the
 *  headers it keeps as text, and fills it only when the file is silent. */
const declaredTemp = (t: DeviceTable): number | undefined =>
  t.meta.filled?.includes('temp') ? undefined : t.meta.temp;

/** Take a dimension out of the screen: no row's condition will hold it. */
export function removeDimension(
  dimensions: readonly ConditionDimension[],
  rows: readonly ImportRow[],
  name: string,
): { dimensions: ConditionDimension[]; rows: ImportRow[] } {
  return {
    dimensions: dimensions.filter((d) => dimensionName(d.name) !== name),
    rows: rows.map((r) => {
      const { [name]: _, ...cells } = r.cells;
      return { ...r, cells, declared: r.declared.filter((d) => d !== name) };
    }),
  };
}

/**
 * Each row's table under the condition the screen shows: every declared value set (a blank one
 * taken out), and every dimension removed on the screen taken out, through `withCondition`
 * against the screen's dimension list. A row the change is refused for carries the reason and
 * gives no table; the caller applies nothing while any row does.
 */
export function applyRows(
  rows: readonly ImportRow[],
  dimensions: readonly ConditionDimension[],
  removed: readonly string[],
): { rows: ImportRow[]; tables: (DeviceTable | undefined)[] } {
  const live = names(dimensions);
  const tables: (DeviceTable | undefined)[] = [];
  const out = rows.map((r) => {
    const changes: Record<string, ConditionValue | null> = {};
    for (const n of removed) if (!live.includes(n)) changes[n] = null;
    for (const n of r.declared) {
      if (!live.includes(n)) continue;
      const text = (r.cells[n] ?? '').trim();
      changes[n] = text === '' ? null : text;
    }
    const res = withCondition(r.table, changes, dimensions);
    tables.push(res.ok ? res.table : undefined);
    return res.ok ? { ...r, error: undefined } : { ...r, error: res.error };
  });
  return { rows: out, tables };
}

/**
 * A panel's chosen conditions after one table's condition changed from `from` to `to`. A key
 * naming the old condition is replaced by the new one when no table on the bench still holds the
 * old condition, and joined by it when one does. A list that never named the old condition is
 * returned as it was.
 */
export function followCornerKeys(
  keys: readonly ConditionKey[],
  from: ConditionKey,
  to: ConditionKey,
  oldStillHeld: boolean,
): ConditionKey[] {
  const old = conditionKeyOf(from);
  const next = conditionKeyOf(to);
  const named = (k: ConditionKey, c: ConditionKey): boolean => sameCondition(conditionKeyOf(k), c);
  if (sameCondition(old, next) || !keys.some((k) => named(k, old))) return [...keys];
  const hasNext = keys.some((k) => named(k, next));
  if (oldStillHeld) return hasNext ? [...keys] : [...keys, next];
  const out: ConditionKey[] = [];
  for (const k of keys) {
    if (!named(k, old)) out.push(k);
    else if (!hasNext && !out.some((o) => named(o, next))) out.push(next);
  }
  return out;
}

/**
 * The composed blocks in a sheet, at any depth, whose device binding names one table by its
 * uid: written before bindings named devices, such a binding is to the table, and a table under
 * a new condition has a new uid. Each is given by its path of block names.
 */
export function blocksNamingTable(doc: SheetDoc | undefined, uid: string, at = ''): string[] {
  const out: string[] = [];
  for (const b of doc?.blocks ?? []) {
    const path = at ? `${at}.${b.name}` : b.name;
    if (b.device === uid) out.push(path);
    out.push(...blocksNamingTable(b.doc, uid, path));
  }
  return out;
}
