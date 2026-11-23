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

/**
 * The condition a table's identity holds, as its file spelled it — the ONE reader of both
 * identity shapes: a table imported now carries `condition`; one stored before conditions were
 * records carries `corner` and `temp`, which read as that same two-dimension condition.
 */
export function conditionOf(id: TableId): ConditionKey {
  if ('condition' in id) return id.condition;
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
