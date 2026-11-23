// The identity of one characterization condition: a record of named values, and the three
// functions that canonicalize, compare and name it. A leaf module (types and constants only), so
// every module that reads a table's condition or temperature can import it.
//
// Pure; zero DOM.

import type {
  ConditionDimension,
  ConditionKey,
  ConditionValue,
  DeviceTable,
  TableId,
} from './types';
import { DEFAULT_CORNER, DEFAULT_TEMP_C } from './constants';

/** The condition dimensions a bench uses when the designer names none: the corner, filled as
 *  `tt`, and the temperature in °C, filled as 27. */
export const DEFAULT_DIMENSIONS: readonly ConditionDimension[] = [
  { name: 'corner', kind: 'text', fill: DEFAULT_CORNER },
  { name: 'temp', kind: 'number', unit: '°C', fill: DEFAULT_TEMP_C },
];

/** A dimension name as keys compare it: trimmed and lower-cased, so `Vdd` and `vdd` are one
 *  dimension. */
export const dimensionName = (name: string): string => name.trim().toLowerCase();

/** A header, hint or typed value as a dimension of `kind` reads it, or undefined when it cannot:
 *  any value reads as text; a number, or text that is a finite number, reads as a number. Blank
 *  text is never a number. */
export function asDimensionValue(
  v: ConditionValue | undefined,
  kind: ConditionDimension['kind'],
): ConditionValue | undefined {
  if (v === undefined) return undefined;
  if (kind === 'text') return String(v);
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return typeof v === 'string' && v.trim() === '' ? undefined : Number.isFinite(n) ? n : undefined;
}

/** A condition's value in one dimension, by name as keys compare it, in its source spelling. */
export function valueIn(cond: ConditionKey, name: string): ConditionValue | undefined {
  for (const [n, v] of Object.entries(cond)) if (dimensionName(n) === name) return v;
  return undefined;
}

/** One dimension of a condition as a display identity writes it: the corner as its file spells
 *  it, the temperature with its unit (`27°C`), any other dimension as `name value`. */
export function conditionPart(name: string, v: ConditionValue): string {
  const n = dimensionName(name);
  return n === 'corner' ? String(v) : n === 'temp' ? `${v}°C` : `${name} ${v}`;
}

/**
 * The condition a table's identity holds, as its file spelled it — the ONE reader of both
 * identity shapes: a table imported now carries `condition`; one stored before conditions were
 * records carries `corner` and `temp`, which read as that same two-dimension condition.
 */
export function conditionOf(id: TableId): ConditionKey {
  if (id.condition !== undefined) return id.condition;
  return { corner: id.corner, temp: id.temp };
}

/** Whether `of` is a table identity rather than a bare key. `device` is never a dimension name
 *  (the importer refuses it), so a key cannot pass for an identity. */
export const isTableId = (of: object): of is TableId =>
  'device' in of &&
  typeof of.device === 'string' &&
  (('condition' in of && typeof of.condition === 'object' && of.condition !== null) ||
    'corner' in of);

/**
 * The canonical key of a condition: each dimension name trimmed and lower-cased, each text value
 * trimmed and lower-cased (a file written `TT` and one written `tt` name one condition), each
 * number with -0 folded onto 0. Accepts a table's identity or a bare key, so a caller
 * canonicalizing a stored selection has no device name to invent. The source spelling stays on
 * the table for display (see `conditionLabel`).
 */
export function conditionKeyOf(of: TableId | ConditionKey): ConditionKey {
  const raw = isTableId(of) ? conditionOf(of) : of;
  const out: Record<string, ConditionValue> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[dimensionName(name)] = v.trim().toLowerCase();
    else if (typeof v === 'number') out[dimensionName(name)] = v + 0;
  }
  return out;
}

/**
 * One stored condition key, read from untrusted data (a saved layout), canonicalized; undefined
 * when it cannot name a condition. An array is not a key. A `corner` that is not text, or a
 * `temp` that is not a finite number, can never match a table, so the key is dropped. Any other
 * field whose value is not text or a finite number is left out and the rest of the key kept; a
 * `device` field is left out too, since a device is never a dimension of a condition.
 */
export function sanitizeConditionKey(raw: unknown): ConditionKey | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const fields: Record<string, ConditionValue> = {};
  for (const [name, v] of Object.entries(raw)) {
    const n = dimensionName(name);
    if (n === 'device') continue;
    if (n === 'corner' && typeof v !== 'string') return undefined;
    if (n === 'temp' && !(typeof v === 'number' && Number.isFinite(v))) return undefined;
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) fields[name] = v;
  }
  return Object.keys(fields).length ? conditionKeyOf(fields) : undefined;
}

/** Key equality — the ONE comparison every consumer shares, so grouping, projection,
 *  duplicate detection and persisted selections can never disagree about what one condition
 *  is. Two keys are one condition when they name the same dimensions and hold the same value,
 *  of the same type, in each; nothing is inferred for a dimension one of them lacks. `Object.is`
 *  on numbers so a table carrying a non-finite value still matches itself rather than
 *  fragmenting into a key nothing can select. */
export function sameCondition(a: ConditionKey, b: ConditionKey): boolean {
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;
  return names.every((n) => {
    if (!Object.hasOwn(b, n)) return false;
    const x = a[n];
    const y = b[n];
    return typeof x === typeof y && (typeof x === 'number' ? Object.is(x, y) : x === y);
  });
}

/** A key as a map/set key: its entries sorted by name, each `[name, 't' | 'n', value as text]`,
 *  as JSON. JSON, not a joined string: a value is arbitrary text and an unescaped delimiter
 *  would let one condition impersonate another. The type tag keeps the text `'1.8'` apart from
 *  the number 1.8, and a number goes in as text because JSON writes every non-finite number as
 *  `null`, which would collapse conditions `sameCondition` calls distinct into one id. */
export function conditionKeyId(k: ConditionKey): string {
  return JSON.stringify(
    Object.keys(k)
      .sort()
      .map((n) => [n, typeof k[n] === 'number' ? 'n' : 't', String(k[n])]),
  );
}

/**
 * The temperature [°C] the engine reads a table at: the one its file or the import declared
 * (TableMeta.temp), else 27 °C — which the importer marks assumed (TableMeta.filled lists
 * `temp`). The ONE reader, whether or not temperature is one of the bench's condition
 * dimensions.
 */
export function tableTempC(table: Pick<DeviceTable, 'meta'>): number {
  return table.meta.temp ?? DEFAULT_TEMP_C;
}

/** What `withCondition` returns: the table under its new condition, or why the change was
 *  refused. */
export type WithConditionResult =
  | { readonly ok: true; readonly table: DeviceTable }
  | { readonly ok: false; readonly error: string };

/**
 * The same table under a changed condition — the one way a table's condition changes after
 * import. Pure: the table passed in is not touched, and the grid is shared.
 *
 * `changes` maps a dimension name to its new value, or to `null` to take the dimension out of
 * the condition. A value set here is declared: it leaves the record of filled-in identity
 * (`meta.filled`) and of dimensions left out (`meta.unset`). Setting `temp` also sets the
 * temperature the engine reads the table at (`meta.temp`). Taking `temp` out of the condition
 * leaves that temperature as it was — and, when it was assumed, still marked assumed.
 *
 * `dimensions` is the bench's list. When given, a value is read as its dimension's kind (text
 * `1.62` for a number dimension is the number 1.62), and `meta.unset` becomes exactly the
 * bench dimensions the new condition lacks. Without it, values are taken as given and
 * `meta.unset` only loses the dimensions now set. `meta.extra` is never touched: a header the
 * file declared stays on record whatever condition the table is given.
 *
 * Refused: the name `device` or an empty name, an empty text value, a number that is not finite,
 * a value its dimension's kind cannot read, and a `temp` that is not a number.
 */
export function withCondition(
  table: DeviceTable,
  changes: Readonly<Record<string, ConditionValue | null>>,
  dimensions?: readonly ConditionDimension[],
): WithConditionResult {
  const kindOf = new Map(dimensions?.map((d) => [dimensionName(d.name), d.kind]));
  const condition: Record<string, ConditionValue> = { ...conditionKeyNames(conditionOf(table.id)) };
  const set = new Set<string>();
  const removed = new Set<string>();
  let temp = table.meta.temp;
  for (const [raw, v] of Object.entries(changes)) {
    const name = dimensionName(raw);
    if (name === '' || name === 'device')
      return { ok: false, error: `"${raw}" cannot be a dimension of a condition` };
    if (v === null) {
      delete condition[name];
      removed.add(name);
      continue;
    }
    const kind = kindOf.get(name) ?? (name === 'temp' ? 'number' : undefined);
    const value = kind ? asDimensionValue(v, kind) : v;
    if (value === undefined || (typeof value === 'string' && value.trim() === ''))
      return { ok: false, error: `${raw}: "${String(v)}" is not a ${kind ?? 'condition'} value` };
    if (typeof value === 'number' && !Number.isFinite(value))
      return { ok: false, error: `${raw}: ${value} is not a finite number` };
    if (name === 'temp') {
      if (typeof value !== 'number')
        return { ok: false, error: `temp: "${value}" is not a number` };
      temp = value;
    }
    condition[name] = typeof value === 'string' ? value.trim() : value;
    set.add(name);
  }
  // A removed temperature that was never declared stays assumed: the engine still reads 27 °C.
  const filled = (table.meta.filled ?? []).filter(
    (f) => !set.has(f) && !(removed.has(f) && !(f === 'temp' && temp === undefined)),
  );
  const unset = dimensions
    ? dimensions.map((d) => dimensionName(d.name)).filter((n) => !(n in condition))
    : (table.meta.unset ?? []).filter((n) => !(n in condition));
  // Edited in place on a copy, so the fields keep their order: a change that changes nothing
  // gives a table that serializes exactly as the one passed in.
  const meta: Record<string, unknown> = { ...table.meta };
  const put = (key: string, value: unknown, keep: boolean): void => {
    if (keep) meta[key] = value;
    else delete meta[key];
  };
  put('temp', temp, temp !== undefined);
  put('filled', filled, filled.length > 0);
  put('unset', unset, unset.length > 0);
  return {
    ok: true,
    table: {
      ...table,
      id: { device: table.id.device, condition },
      meta: meta as DeviceTable['meta'],
    },
  };
}

/** A condition with each dimension name as keys compare it, values in their source spelling. */
function conditionKeyNames(cond: ConditionKey): Record<string, ConditionValue> {
  const out: Record<string, ConditionValue> = {};
  for (const [n, v] of Object.entries(cond)) out[dimensionName(n)] = v;
  return out;
}
