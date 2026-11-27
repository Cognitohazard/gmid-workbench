// The corner selection: which conditions, which axes of the operating range and which named range
// ends a bench asks about, and the one function that turns it into the list of corners.
//
// One selection serves every operation on a bench — the corner run, the sweep, the feasibility map
// and the sensitivity view — so they cannot disagree about which points are corners. A corner is a
// condition the primary device holds, taken alone or at one point of the sheet's operating range.
// The design is sized at the base condition, which is always evaluated, because every held corner
// needs its design.
//
// Pure; zero DOM.

import type { ConditionKey } from '../types';
import { conditionKeyId, conditionKeyOf, sameCondition } from '../condition';
import { rangePoints, type RangePoint, type SheetDoc } from '../sheet/types';
import type { CharacterizedDevice } from './index';

/**
 * What a bench asks about. Each list names what counts; `'all'` counts everything there is.
 *  - `conditions`: the characterization conditions. An empty list asks about the base alone.
 *  - `axes`: the operating axes (by param) whose two ends count. An axis left out stays at its
 *    design value, so two of four axes give 4 corners in place of 16.
 *  - `ends`: the named range ends (by name) that count.
 *  - `base`: where the design is sized; absent, the primary device's nominal condition.
 */
export interface CornerSelection {
  readonly conditions: 'all' | readonly ConditionKey[];
  readonly axes: 'all' | readonly string[];
  readonly ends: 'all' | readonly string[];
  readonly base?: ConditionKey;
}

/** Every condition, every axis, every named end, sized at the nominal condition. */
export const ALL_CORNERS: CornerSelection = { conditions: 'all', axes: 'all', ends: 'all' };

/** One corner: a condition alone (`point` absent), or a condition at one range point. */
export interface Corner {
  readonly key: ConditionKey;
  readonly point?: RangePoint;
}

/**
 * The sheet with its operating range cut to the axes and named ends the selection counts. An axis
 * left out is dropped from `operatingAxes`, so its param keeps its design value at every corner,
 * including in the ends of an axis that reads it. With everything selected the doc is returned
 * as it is.
 */
export function selectedRange(doc: SheetDoc, selection: CornerSelection): SheetDoc {
  const { axes, ends } = selection;
  if (axes === 'all' && ends === 'all') return doc;
  const { operatingAxes, operatingRange, ...rest } = doc;
  const keptAxes =
    axes === 'all' ? operatingAxes : operatingAxes?.filter((a) => axes.includes(a?.param));
  const keptEnds =
    ends === 'all' ? operatingRange : operatingRange?.filter((e) => ends.includes(e?.name));
  return {
    ...rest,
    ...(keptAxes?.length ? { operatingAxes: keptAxes } : {}),
    ...(keptEnds?.length ? { operatingRange: keptEnds } : {}),
  };
}

/** The condition the design is sized at: the selection's base, else the device's nominal. */
export function baseOf(
  device: CharacterizedDevice | undefined,
  selection: CornerSelection,
): ConditionKey | undefined {
  if (selection.base) return selection.base;
  return device?.nominal ? conditionKeyOf(device.nominal.id) : undefined;
}

/** The conditions the selection names, each once and in the selection's order (`'all'`: the
 *  device's own order), and of those the ones the device holds and the ones it does not. An empty
 *  list names the base. */
export function selectedConditions(
  device: CharacterizedDevice | undefined,
  selection: CornerSelection,
): { named: ConditionKey[]; held: ConditionKey[]; absent: ConditionKey[] } {
  const have = device?.keys ?? [];
  if (selection.conditions === 'all') return { named: [...have], held: [...have], absent: [] };
  const base = baseOf(device, selection);
  const named = selection.conditions.length ? selection.conditions : base ? [base] : [];
  const seen = new Set<string>();
  const once = named.filter((key) => {
    const id = conditionKeyId(key);
    return !seen.has(id) && !!seen.add(id);
  });
  const holds = (key: ConditionKey) => have.some((k) => sameCondition(k, key));
  return {
    named: once,
    held: once.filter(holds),
    absent: once.filter((k) => !holds(k)),
  };
}

/**
 * Every corner the selection asks about, in the order of the conditions and then of the range
 * points: each selected condition the primary device holds, alone and at each range point the
 * selection counts (rangePoints of the selected range). A condition no table holds is not a
 * corner (see selectedConditions). The base counts only when the selection names it, or when the
 * selection names no condition at all.
 */
export function cornersOf(
  device: CharacterizedDevice | undefined,
  doc: SheetDoc,
  selection: CornerSelection,
): Corner[] {
  const points = rangePoints(selectedRange(doc, selection));
  return selectedConditions(device, selection).held.flatMap((key) => [
    { key },
    ...points.map((point) => ({ key, point })),
  ]);
}

/** What a corner run asks the engine: the sheet with its range cut to the selection, every
 *  condition named (a condition no table holds is answered as not evaluated, never dropped), and
 *  the base the design is sized at. The arguments `runConditions` takes. */
export interface SelectionRun {
  readonly doc: SheetDoc;
  readonly keys: readonly ConditionKey[];
  readonly base?: ConditionKey;
  /** The named conditions no table of the primary device holds. */
  readonly absent: readonly ConditionKey[];
}

/** The corner run of a selection (see SelectionRun). */
export function selectionRun(
  device: CharacterizedDevice | undefined,
  doc: SheetDoc,
  selection: CornerSelection,
): SelectionRun {
  const { named, absent } = selectedConditions(device, selection);
  const base = baseOf(device, selection);
  return { doc: selectedRange(doc, selection), keys: named, ...(base ? { base } : {}), absent };
}
