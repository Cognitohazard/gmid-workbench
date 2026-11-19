// Characterized devices: one logical device characterized at several (corner, temperature)
// conditions, and the single transition that evaluates a design sheet at exactly one of them.
//
// Two rules shape everything here.
//
// Identity lives in the DATA. A device is derived from the headers its tables carry — process
// namespace, device name, declared polarity — never minted, remembered, or assigned by a bench.
// The derivation reads the loaded set as a whole: an under-declared header resolves against the
// declared ones loaded beside it (see groupDevices), so the same blank-header file can land in
// a blank device on one bench and beside its declared siblings on another — but on any given
// bench the result is a pure function of the loaded headers. A wrong grouping is corrected by
// fixing the file rather than by a click, and there is no membership lifecycle to migrate or
// orphan.
//
// One run, one condition key. Every evaluation first fixes exactly one ConditionKey and projects
// the primary AND every explicitly bound child to that same key. A child device's own nominal
// never substitutes a different key inside a run, because a verdict assembled from a tt@27
// input pair and a tt@85 tail describes a chip that does not exist. When any required device
// has no usable table at the key, the run is NOT EVALUATED — a fourth outcome, never folded
// into "infeasible".
//
// One design across the conditions. A set of conditions is one question about ONE design: it is
// sized once, at the base condition, and every other condition is asked about that same
// hardware — the widths and lengths the base run produced, its currents, and the gate biases it
// needed — with only the operating point re-settled (see holdHardware). A run that re-sized the
// design at each condition would describe one chip per corner; only one of them is built.
//
// Two questions, never one. FEASIBILITY is asked once, where the design is sized: can this
// design type meet its spec. COMPLIANCE is asked of that one design at every point it is
// promised to work — each condition, at its centre and at each end of the sheet's operating
// range — and is reported as a count of points, with the ones that were not run or could not
// be answered counted apart from the ones that fail.
//
// Pure; zero DOM. Corner is categorical: nothing here interpolates, resamples, clips, or
// merges tables across corners.

import type { DeviceTable, OutsideTable, QAWarning, TableId } from '../types';
import { DEFAULT_TEMP_C } from '../constants';
import type {
  CheckKind,
  CheckResult,
  CheckStatus,
  DeviceResolver,
  NamedBinding,
  NodesReport,
  RunOptions,
  SheetBlockReport,
  SheetDoc,
  PointState,
  SheetRefIndex,
  SheetResult,
  SheetSweep,
  Settings,
  SweepOptions,
  SweepSample,
  DesignVerdict,
  HeldVerdict,
  Verdict,
} from '../sheet';
import {
  SWEEP_POINTS,
  clampMargin,
  dcInputs,
  evaluateSheet,
  inheritedPolarityWarnings,
  limitingCheck,
  namedBindings,
  outsideIn,
  resolvedSheet,
  sweepOf,
  sweepable,
  treeCheckResults,
  unfinishedBecause,
  withParams,
  withValidation,
  withoutRange,
  validateSheet,
} from '../sheet';
import { isHardCheck } from '../sheet/types';
import { incompleteOn, isComplete, marginReadable, type Item, type ItemRef } from '../sheet/states';
import { withFindings } from '../sheet/items';
import {
  assumedLevelRefusal,
  holdHardware,
  withNominalRange,
  type HeldHardware,
} from '../sheet/coverage';
import { unwalkedReport } from '../sheet/nodes';

// --- condition identity --------------------------------------------------------

/**
 * The canonical identity of one characterization condition. `corner` is trimmed and
 * lower-cased so a file written `TT` and one written `tt` name the same condition; the source
 * spelling stays on the table for display (see `conditionLabel`).
 */
export interface ConditionKey {
  readonly corner: string;
  readonly temp: number; // [°C]
}

/** The canonical key of a table's identity. Accepts a table's own identity or a bare key, like
 *  `conditionLabel`, so a caller canonicalizing a stored selection has no device name to invent. */
export function conditionKeyOf(
  id: TableId | { readonly corner: string; readonly temp: number },
): ConditionKey {
  // `+ 0` folds -0 onto 0, so a table written `# temp: -0` is not its own condition.
  return { corner: id.corner.trim().toLowerCase(), temp: id.temp + 0 };
}

/** Key equality — the ONE comparison every consumer shares, so grouping, projection,
 *  duplicate detection and persisted selections can never disagree about what one condition
 *  is. `Object.is` on the temperature so a table carrying a non-finite temperature still
 *  matches itself rather than fragmenting into a key nothing can select. */
export function sameCondition(a: ConditionKey, b: ConditionKey): boolean {
  return a.corner === b.corner && Object.is(a.temp, b.temp);
}

/** A key as a map/set key. JSON, not a joined string: a corner spelling is arbitrary text and
 *  an unescaped delimiter would let one condition impersonate another. The temperature goes in
 *  as text because JSON writes every non-finite number as `null`, which would collapse
 *  conditions `sameCondition` calls distinct into one id — a phantom duplicate. */
export function conditionKeyId(k: ConditionKey): string {
  return JSON.stringify([k.corner, String(k.temp)]);
}

/**
 * The condition as a designer writes it: source spelling preserved, and the temperature elided at
 * the 27 °C default so the common case reads `tt`, not `tt@27`. Accepts a table, a table's own
 * identity or a bare key, so a selected condition with no table loaded still labels.
 *
 * A table also brings its record of what its file did not declare (TableMeta.filled). A field
 * filled in is marked, never elided: a temperature taken as the default reads `tt@27 °C
 * (assumed)` and a corner taken as `tt` reads `tt (assumed)`, so a label never presents a
 * default as a declaration. Label a table by the table, not by its `id`, wherever one is at hand.
 */
export function conditionLabel(
  of: { readonly corner: string; readonly temp: number } | DeviceTable,
): string {
  const id = 'grid' in of ? of.id : of;
  const filled = 'grid' in of ? (of.meta.filled ?? []) : [];
  const corner = id.corner.trim();
  const noCorner = filled.includes('corner');
  if (filled.includes('temp'))
    return `${corner}@${id.temp} °C (${noCorner ? 'corner and temperature assumed' : 'assumed'})`;
  const shown = noCorner ? `${corner} (assumed)` : corner;
  return id.temp === DEFAULT_TEMP_C ? shown : `${shown}@${id.temp}`;
}

/** A condition of `device` labelled with what its table's file did not declare (conditionLabel):
 *  the member at `key` supplies the record. A key no member answers to labels bare. */
export function conditionLabelIn(
  device: CharacterizedDevice | undefined,
  key: { readonly corner: string; readonly temp: number },
): string {
  const at = conditionKeyOf(key);
  const member = device?.conditions.find((t) => sameCondition(conditionKeyOf(t.id), at));
  return member ? conditionLabel(member) : conditionLabel(key);
}

// --- device identity ---------------------------------------------------------

/** Declared channel type, or `unknown` when no table said. Unknown never claims to separate:
 *  two undeclared tables of the same name group together, because refusing to guess is not the
 *  same as knowing they differ. */
export type DevicePolarity = 'n' | 'p' | 'unknown';

/**
 * An `extra` metadata scalar by case-insensitive key. Two reasons it is not a plain property
 * read: `extra` preserves the header's original case verbatim (the strict-superset rule), and
 * a table stored before a header became first-class still carries it here.
 */
export function extraScalar(t: DeviceTable, key: string): string | number | undefined {
  const extra = t.meta.extra;
  if (!extra) return undefined;
  const want = key.toLowerCase();
  for (const [k, v] of Object.entries(extra)) if (k.toLowerCase() === want) return v;
  return undefined;
}

/** The table's process namespace as supplied, or `''` when it declares none. Falls back to the
 *  legacy `extra` entry so a table stored before `# pdk:` was promoted groups with a freshly
 *  imported copy of the same file instead of forming a second, blank-namespace device. */
export function pdkOf(t: DeviceTable): string {
  const declared = t.meta.pdk ?? extraScalar(t, 'pdk');
  return declared === undefined ? '' : String(declared).trim();
}

/** The grouping tuple: process namespace, device name, declared polarity — all normalized, so
 *  case and surrounding space never split one device into two. */
function deviceKeyOf(t: DeviceTable): [string, string, DevicePolarity] {
  return [
    pdkOf(t).toLowerCase(),
    t.id.device.trim().toLowerCase(),
    t.meta.polarity?.device ?? 'unknown',
  ];
}

/** The identity THIS TABLE's own headers declare: the canonical serialization of its grouping
 *  tuple. Purely derived — the same headers always produce the same value, on any machine and
 *  after any recharacterization. What a stored binding names is `CharacterizedDevice.deviceUid`, the
 *  bench-RESOLVED form of this (an under-declared table may sit in a more-declared device);
 *  the bench's resolver aliases each member's own value here to its device so bindings written
 *  before such a merge keep resolving. */
export function deviceUidOf(t: DeviceTable): string {
  return JSON.stringify(deviceKeyOf(t));
}

/** The grouping tuple a device identity was built from. */
export interface DeviceIdentity {
  /** Process namespace, normalized; `''` when the tables declared none. */
  readonly pdk: string;
  /** Device name, normalized — the grouping spelling, not a member's display spelling. */
  readonly device: string;
  readonly polarity: DevicePolarity;
}

/** Read a `deviceUid` back into the tuple it serializes, or `undefined` when the string is not
 *  one. The inverse lives beside `deviceUidOf` so the serialization has a single owner: a caller
 *  that must show what an identity NAMES while no member of it is loaded — there is no device
 *  object to read a display name off — asks here instead of destructuring the JSON by position,
 *  which would mislabel silently if the tuple ever grew or was reordered. */
export function deviceIdentityOf(uid: string): DeviceIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(uid);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const [pdk, device, polarity] = parsed as unknown[];
  if (typeof pdk !== 'string' || typeof device !== 'string') return undefined;
  return {
    pdk,
    device,
    polarity: polarity === 'n' || polarity === 'p' ? polarity : 'unknown',
  };
}

/**
 * One logical device: every loaded table that shares its identity, indexed by condition.
 */
export interface CharacterizedDevice {
  /** The bench-resolved grouping key (process namespace, device name, polarity). Usually every
   *  member's own `deviceUidOf`; blanker members that joined a declared sibling carry the
   *  declared identity (see `groupDevices`). */
  readonly deviceUid: string;
  /** The device name in its source spelling, for display. */
  readonly device: string;
  /** Members in load order. */
  readonly conditions: readonly DeviceTable[];
  /** The conditions the device holds, in load order, once each. A condition two members claim
   *  appears once: it is one condition two tables characterize, and every mode that offers it
   *  offers the condition rather than the tables. */
  readonly keys: readonly ConditionKey[];
  /** Conditions claimed by more than one member. Nothing projects at these: load order is not
   *  a choice between two characterizations, so an ambiguous condition refuses until the bench
   *  removes one or replaces it explicitly. */
  readonly duplicates: readonly ConditionKey[];
  /** The condition a run means by "nominal", or `undefined` when nothing designates one. */
  readonly nominal: DeviceTable | undefined;
  /** Where `nominal` came from: `auto` (the tt-at-27 rule), `designated` (a bench choice that
   *  resolved), `unresolved` (a bench choice naming a member that is no longer loaded — the
   *  auto rule is deliberately NOT reapplied, so a stale designation stays visible instead of
   *  silently sliding to another corner), or `none` (no rule produced one). */
  readonly nominalSource: 'auto' | 'designated' | 'unresolved' | 'none';
  /** Which way an `unresolved` designation is unusable, because the two are repaired
   *  differently: the member it names is not loaded (`absent` — designate another), or that
   *  member is loaded but two tables claim its condition (`ambiguous` — remove one). Absent
   *  unless `nominalSource` is `unresolved`. */
  readonly unresolvedNominal?: 'absent' | 'ambiguous';
  /** On an automatic nominal, the fields of its condition that its file did not declare
   *  (TableMeta.filled): its corner taken as `tt`, its temperature as 27 °C. Set only when no
   *  member of the device declares its condition, because a filled-in condition never wins the
   *  automatic rule over a declared one — so a nominal that rests on a default says so. */
  readonly nominalAssumed?: readonly ('corner' | 'temp')[];
  /** Members the automatic rule passed over because their condition was filled in while another
   *  member declares its own: a headerless file reads as tt at 27 °C, which would otherwise be
   *  the rule's first pick, so a bench that has no nominal — or a different one — says which
   *  table was set aside and why. Set only when the automatic rule ran and one was set aside. */
  readonly nominalPassedOver?: readonly DeviceTable[];
}

export interface GroupDevicesOptions {
  /** deviceUid → the identity of the member the bench designates nominal, in the CALLER's id
   *  space. Core never derives a table identity of its own: it compares whatever `uidOf`
   *  returns, so no uid scheme enters the numerics. Supplying a designation without `uidOf`
   *  leaves it unmatchable, which reads as an unresolved designation rather than as no
   *  designation at all. */
  readonly nominalByDevice?: ReadonlyMap<string, string>;
  /** The caller's identity for a table (the bench's content uid). */
  readonly uidOf?: (t: DeviceTable) => string;
}

/**
 * Group loaded tables into devices, preserving load order both between and within devices.
 *
 * Under-declared headers resolve against the declared ones on the bench before bucketing:
 * "undeclared never separates" has to hold against DECLARED tables too, or re-exporting one
 * corner with newly stamped `# pdk:` / `# polarity:` headers silently splits it away from the
 * older corners of the same device — the ordinary upgrade path, not an edge case. A blank
 * namespace or an unknown polarity therefore joins the unique declared candidate for the same
 * device name, and stays its own device only when several candidates would make the join a
 * guess (that remainder is what `validateDevices` warns about). The resulting device carries
 * the declared identity, so `CharacterizedDevice.deviceUid` is the bench-resolved key — a member's
 * own `deviceUidOf` may be blanker.
 */
export function groupDevices(
  tables: readonly DeviceTable[],
  opts?: GroupDevicesOptions,
): CharacterizedDevice[] {
  const raw = tables.map(deviceKeyOf);

  // Declared namespaces per device name; a blank one joins the sole candidate.
  const pdksByName = new Map<string, Set<string>>();
  for (const [pdk, name] of raw) {
    if (!pdk) continue;
    const set = pdksByName.get(name) ?? new Set<string>();
    set.add(pdk);
    pdksByName.set(name, set);
  }
  const effPdk = ([pdk, name]: readonly [string, string, DevicePolarity]): string => {
    if (pdk) return pdk;
    const declared = pdksByName.get(name);
    return declared?.size === 1 ? [...declared][0] : '';
  };

  // Declared polarities per (resolved namespace, name); unknown joins the sole candidate —
  // it never bridges n and p, since two candidates leave it unresolved.
  const polsByGroup = new Map<string, Set<DevicePolarity>>();
  for (const k of raw) {
    if (k[2] === 'unknown') continue;
    const group = JSON.stringify([effPdk(k), k[1]]);
    const set = polsByGroup.get(group) ?? new Set<DevicePolarity>();
    set.add(k[2]);
    polsByGroup.set(group, set);
  }
  const effKey = (k: readonly [string, string, DevicePolarity]): string => {
    const pdk = effPdk(k);
    const pols = polsByGroup.get(JSON.stringify([pdk, k[1]]));
    const pol = k[2] !== 'unknown' ? k[2] : pols?.size === 1 ? [...pols][0] : 'unknown';
    return JSON.stringify([pdk, k[1], pol]);
  };

  const order: string[] = [];
  const members = new Map<string, DeviceTable[]>();
  for (let i = 0; i < tables.length; i++) {
    const uid = effKey(raw[i]);
    const list = members.get(uid);
    if (list) list.push(tables[i]);
    else {
      members.set(uid, [tables[i]]);
      order.push(uid);
    }
  }
  return order.map((uid) => buildDevice(uid, members.get(uid) ?? [], opts));
}

function buildDevice(
  deviceUid: string,
  conditions: DeviceTable[],
  opts: GroupDevicesOptions | undefined,
): CharacterizedDevice {
  const seen = new Map<string, { key: ConditionKey; count: number }>();
  for (const t of conditions) {
    const key = conditionKeyOf(t.id);
    const id = conditionKeyId(key);
    const hit = seen.get(id);
    if (hit) hit.count++;
    else seen.set(id, { key, count: 1 });
  }
  const keys = [...seen.values()].map((e) => e.key);
  const duplicates = [...seen.values()].filter((e) => e.count > 1).map((e) => e.key);
  return {
    deviceUid,
    device: conditions[0]?.id.device ?? '',
    conditions,
    keys,
    duplicates,
    ...designate(conditions, duplicates, deviceUid, opts),
  };
}

/** The condition fields of a table its file did not declare (TableMeta.filled). */
const assumedCondition = (t: DeviceTable): ('corner' | 'temp')[] =>
  (t.meta.filled ?? []).filter((f): f is 'corner' | 'temp' => f === 'corner' || f === 'temp');

/** An automatic nominal, with the fields of its condition that were filled in when there are any. */
function autoNominal(
  t: DeviceTable,
): Pick<CharacterizedDevice, 'nominal' | 'nominalSource' | 'nominalAssumed'> {
  const assumed = assumedCondition(t);
  return assumed.length
    ? { nominal: t, nominalSource: 'auto', nominalAssumed: assumed }
    : { nominal: t, nominalSource: 'auto' };
}

/** The nominal rule: a bench designation if there is one, else a sole member speaking for
 *  itself, else the tt member closest to 27 °C. Every ambiguity — two tt temperatures
 *  equidistant from 27, or two tables claiming the winning condition — yields no designation
 *  rather than a load-order winner, because which characterization is nominal is a statement
 *  about the bench, not about which file arrived first. A designation that lands on a
 *  duplicated condition is unusable the same way a vanished one is: every projection at that
 *  condition refuses, so it reads as unresolved rather than advertising a nominal no run can
 *  use.
 *
 *  The automatic rule reads DECLARED conditions only while the device has any: a file that
 *  declares no corner is `tt`, and one that declares no temperature is at 27 °C, by default
 *  rather than by statement, so such a member never wins over a declared one — with a declared
 *  `ss` beside it, the device has no automatic nominal at all. Only a device whose every member
 *  fills its condition in reads them, and its nominal then says which fields were assumed. */
function designate(
  conditions: readonly DeviceTable[],
  duplicates: readonly ConditionKey[],
  deviceUid: string,
  opts: GroupDevicesOptions | undefined,
): Pick<
  CharacterizedDevice,
  'nominal' | 'nominalSource' | 'unresolvedNominal' | 'nominalAssumed' | 'nominalPassedOver'
> {
  const wanted = opts?.nominalByDevice?.get(deviceUid);
  if (wanted !== undefined) {
    const uidOf = opts?.uidOf;
    const hit = uidOf && conditions.find((t) => uidOf(t) === wanted);
    if (!hit)
      return { nominal: undefined, nominalSource: 'unresolved', unresolvedNominal: 'absent' };
    if (duplicates.some((d) => sameCondition(d, conditionKeyOf(hit.id))))
      return { nominal: undefined, nominalSource: 'unresolved', unresolvedNominal: 'ambiguous' };
    return { nominal: hit, nominalSource: 'designated' };
  }
  if (conditions.length === 1) return autoNominal(conditions[0]);
  const declared = conditions.filter((t) => assumedCondition(t).length === 0);
  const pool = declared.length ? declared : conditions;
  // Set aside: the filled-in members the rule would have read, had it read them.
  const setAside = declared.length
    ? conditions.filter((t) => !declared.includes(t) && conditionKeyOf(t.id).corner === 'tt')
    : [];
  const passed = setAside.length ? { nominalPassedOver: setAside } : {};
  const tt = pool.filter((t) => conditionKeyOf(t.id).corner === 'tt');
  const near = tt.length ? nearestTo27(tt) : undefined;
  return near
    ? { ...autoNominal(near), ...passed }
    : { nominal: undefined, nominalSource: 'none', ...passed };
}

/** The single closest member to 27 °C, or `undefined` when the closest distance is shared —
 *  which covers both an exact straddle (17 and 37) and a duplicated winning condition. */
function nearestTo27(tt: readonly DeviceTable[]): DeviceTable | undefined {
  let best: DeviceTable | undefined;
  let bestDist = Infinity;
  let atBest = 0;
  for (const t of tt) {
    const dist = Math.abs(conditionKeyOf(t.id).temp - DEFAULT_TEMP_C);
    if (!Number.isFinite(dist)) continue;
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
      atBest = 1;
    } else if (dist === bestDist) atBest++;
  }
  return atBest === 1 ? best : undefined;
}

/** The device's unique table at one condition — the ONE projection rule. `undefined` when no
 *  member claims the condition AND when several do: an ambiguous condition never resolves to a
 *  winner, here or anywhere else. */
export function tableAt(f: CharacterizedDevice, key: ConditionKey): DeviceTable | undefined {
  if (f.duplicates.some((d) => sameCondition(d, key))) return undefined;
  return f.conditions.find((t) => sameCondition(conditionKeyOf(t.id), key));
}

/** One table's swept-axis signature — the shape fact device QA and projection both compare.
 *  Conditions that disagree on it are not one device in any sense a sheet can rely on: a design
 *  pinned on one is not pinned on the other. */
export function axisSignature(t: DeviceTable): string {
  return t.grid.axes.map((a) => a.name).join(', ');
}

// --- the run transition ------------------------------------------------------

/** Why a condition could not be evaluated. Kinds, not prose, so a UI can group and act on
 *  them: `absent-condition` and `ambiguous-condition` are fixed at the bench (import the missing
 *  corner, remove the duplicate), `invalid-sheet-or-ref` in the sheet, and
 *  `runtime-evaluation` reports an evaluation that started and did not complete.
 *  `incompatible-table` refuses a device whose members do not sweep the same axes: its
 *  conditions cannot serve one sheet interchangeably, so no condition of it projects until the
 *  imports agree — the same fact device QA reports as an error.
 *
 *  Two are about holding one design across conditions. `no-design` says there is nothing to
 *  hold: the base condition was not evaluated, or several conditions were asked about and none
 *  is the base. `assumed-level` says the design rests on a voltage its sheet types although its
 *  own parts determine it (class `assumed`): held fixed at another condition, a typed guess
 *  proves nothing about the hardware, so the question is declined rather than answered. */
export type ConditionIssueKind =
  | 'absent-condition'
  | 'ambiguous-condition'
  | 'incompatible-table'
  | 'invalid-sheet-or-ref'
  | 'runtime-evaluation'
  | 'no-design'
  | 'assumed-level';

/**
 * Why a condition was not evaluated, as data a text can be written from. `message` is the old
 * sentence, kept until the fields that read it are removed; nothing new reads it.
 *  - `absent-condition`: a device the run needs is not there. `missing: 'device'` — a block names a
 *    device that is not loaded (`block` is the block's path); `missing: 'condition'` — the device
 *    has no table at this condition (`block`, where a block asked for it).
 *  - `ambiguous-condition`: two or more tables of `device` claim this condition.
 *  - `incompatible-table`: the tables of `device` do not sweep the same axes, so none projects.
 *  - `invalid-sheet-or-ref`: validation found an error; `on` is the item it is on, in the item list
 *    the declined run carries (ConditionRun.items), the same list and cause the sheet shows.
 *  - `runtime-evaluation`: the run did not complete; `on` is the failed items whose number is not
 *    there (incompleteOn). Its text is the items' own.
 *  - `no-design`: there is no design to hold. `reason: 'no-base'` — several conditions are asked
 *    about and none is the one the design is sized at; `'base-not-evaluated'` — the design was not
 *    evaluated at `base`, where it is sized.
 *  - `assumed-level`: the design rests on the levels `names`, classed assumed.
 */
export type ConditionIssue = { readonly message: string } & (
  | {
      readonly kind: 'absent-condition';
      readonly device: string;
      readonly missing: 'device' | 'condition';
      readonly block?: string;
    }
  | { readonly kind: 'ambiguous-condition'; readonly device: string; readonly block?: string }
  | { readonly kind: 'incompatible-table'; readonly device: string; readonly block?: string }
  | { readonly kind: 'invalid-sheet-or-ref'; readonly on: readonly ItemRef[] }
  | { readonly kind: 'runtime-evaluation'; readonly on: readonly ItemRef[] }
  | { readonly kind: 'no-design'; readonly reason: 'no-base' }
  | {
      readonly kind: 'no-design';
      readonly reason: 'base-not-evaluated';
      readonly base: ConditionKey;
    }
  | { readonly kind: 'assumed-level'; readonly names: readonly ItemRef[] }
);

/** An item's reference, without its status. */
const refOf = (i: ItemRef): ItemRef => ({ kind: i.kind, path: i.path, name: i.name });

/** A value named with its block path (`stage1.V_out`) as the reference of its item. */
function valueRef(qualified: string): ItemRef {
  const parts = qualified.split('.');
  return { kind: 'value', path: parts.slice(0, -1), name: parts[parts.length - 1] };
}

/**
 * One compliance point: one condition, at the design's own operating point (the centre) or at
 * one end of the sheet's claimed operating range. The states are the range-end vocabulary (see
 * RangeEndReport.state), because it is the same question — does this one design, held fixed,
 * still work here — and the two that are not verdicts are kept apart for the same reason:
 * `not-run` was never asked (no design to hold, no table loaded at the condition), `no-answer`
 * was asked and could not be answered (the run did not complete, the data does not reach).
 */
export interface CompliancePoint {
  /** The range end's name. Absent at the centre. */
  readonly rangeEnd?: string;
  readonly state: PointState;
  /** Why the point has no check outcomes to read, when it has none: the refusal, the solver's
   *  message, the table's reach. Absent where the point's checks were measured — a point that
   *  does not comply because a check fails names the check in its run's result instead. */
  readonly error?: string;
  /** The devices this point read beyond their tables (see OutsideTable): the same records the
   *  run's result carries, so a reader decides from the fields and never from `error`. Absent
   *  where every device was read on its table. Such a point is `no-answer`. */
  readonly outside?: readonly OutsideTable[];
  /** What the design is at this point, from the run's items: at the centre of the condition the
   *  design is sized at, its design verdict; at the centre of a held condition and at every range
   *  end, the held verdict. Absent where the engine calculated nothing here (a point not run, an
   *  end the engine did not calculate). `state` is still written beside it. */
  readonly verdict?: Verdict<DesignVerdict> | Verdict<HeldVerdict>;
}

export type ConditionRun =
  | {
      readonly state: 'evaluated';
      readonly key: ConditionKey;
      /** Whose hardware this run measured. `sized`: the run sized the design here, free to choose
       *  every width — the base condition. `held`: the design the base run sized, re-biased at
       *  this condition with its geometry, currents and gate biases fixed. */
      readonly design: 'sized' | 'held';
      /** On a `held` run: the blocks whose current the base run did not author, so it is held
       *  here as an ideal source (see HeldHardware.assumedSource). */
      readonly assumedSource?: readonly string[];
      /** This run's own verdict on its hard checks. On the `sized` run that is FEASIBILITY — the
       *  one answer to "can this design type meet the spec". On a `held` run it is the same
       *  reading of a design that was not free to change, which the centre point restates as
       *  compliance. */
      readonly feasible: boolean;
      /** The centre first, then one point per range end the sheet declares, in document order. */
      readonly points: readonly CompliancePoint[];
      /** The held design over this run's range ends (heldVerdictOver). Absent where the run has no
       *  range end the engine calculated. */
      readonly endsVerdict?: HeldVerdictOver;
      readonly result: SheetResult;
    }
  | {
      readonly state: 'not-evaluated';
      readonly key: ConditionKey;
      /** `sized` on the base condition's own attempt, `held` everywhere else. */
      readonly design: 'sized' | 'held';
      readonly issues: readonly ConditionIssue[];
      /** The same points an evaluated run carries, none of them `complies`. */
      readonly points: readonly CompliancePoint[];
      /** The held design over this run's range ends, as on an evaluated run. */
      readonly endsVerdict?: HeldVerdictOver;
      /** Kept when an evaluation ran and did not stand, so its diagnostics survive the
       *  refusal — the numbers are how an author finds out why. */
      readonly result?: SheetResult;
      /** On a condition declined because the sheet does not validate: the sheet's item list built
       *  from validation's findings (withFindings), which the issues point into. */
      readonly items?: readonly Item[];
      /** On a condition asked about and declined with no answer, before anything ran: the DC
       *  wiring report saying the check did not run (see unwalkedReport), as a range end declined
       *  the same way carries it. */
      readonly nodes?: NodesReport;
    };

/** A device binding as written in a sheet → the device it names, or `undefined` when nothing
 *  loaded answers to it. Injected, exactly like `DeviceResolver`: how a binding string is
 *  matched (exact table identity first, the `family:` form second) is the bench's business, and
 *  core never parses one. */
export type DeviceLookup = (binding: string) => CharacterizedDevice | undefined;

/** Project every device binding to ONE condition: each binding answers with its device's table
 *  at `key`, and with nothing when no device answers to it or the condition does not project.
 *  The one place a binding becomes a table, so a verdict, a chart and a probe taken under it can
 *  never be reading different conditions of the same design. */
export function projectingResolver(deviceOf: DeviceLookup, key: ConditionKey): DeviceResolver {
  return (binding) => {
    const device = deviceOf(binding);
    return device && tableAt(device, key);
  };
}

/** What a condition's preflight found: the primary device's table at it, and everything that
 *  stops it from being evaluated. */
export interface ConditionPreflight {
  /** `undefined` exactly when the primary device contributed a refusal. */
  readonly primary: DeviceTable | undefined;
  readonly issues: readonly ConditionIssue[];
}

/**
 * Ask whether one condition can be evaluated at all — the primary device and every explicitly
 * bound child, in that order — WITHOUT evaluating it. This is step 2 of `runCondition`, exported
 * because a caller that must screen conditions before spending an evaluation on them (the picker
 * searching a catalog) has to refuse on the same grounds, in the same order, in the same words:
 * a second copy kept in step by hand is how a picker comes to rank a candidate the sheet panel
 * then refuses.
 *
 * Structural sheet problems are NOT in here: they are not about a condition, and `runCondition`
 * reports them before any device is asked.
 */
export function preflightCondition(
  doc: SheetDoc,
  primaryDevice: CharacterizedDevice,
  key: ConditionKey,
  deviceOf: DeviceLookup,
  refs?: SheetRefIndex,
): ConditionPreflight {
  return preflightBindings(namedBindings(doc, refs).bindings, primaryDevice, key, deviceOf);
}

function preflightBindings(
  bindings: readonly NamedBinding[],
  primaryDevice: CharacterizedDevice,
  key: ConditionKey,
  deviceOf: DeviceLookup,
): ConditionPreflight {
  const issues: ConditionIssue[] = [];
  const primary = memberFor(primaryDevice, key, 'the primary device', issues);
  const bound = new Set<string>();
  for (const b of bindings) {
    if (bound.has(b.binding)) continue;
    bound.add(b.binding);
    const device = deviceOf(b.binding);
    if (!device) {
      issues.push({
        kind: 'absent-condition',
        device: b.binding,
        missing: 'device',
        block: b.path,
        message: `block "${b.path}" names device "${b.binding}", which is not loaded`,
      });
      continue;
    }
    // A child bound to the primary's own device was already preflighted above; a second
    // issue for the same missing condition would list one problem twice.
    if (device.deviceUid === primaryDevice.deviceUid) continue;
    memberFor(device, key, `block "${b.path}"`, issues, primaryDevice, b.path);
  }
  return { primary, issues };
}

/** Everything a run needs that does not depend on WHICH condition it is: the materialized tree,
 *  its validation warnings, the structural errors that stop every condition alike, and the
 *  bindings to preflight. Computed once per sheet rather than once per condition — a set of
 *  conditions is one question about one sheet. */
interface PreparedRun {
  /** References materialized. */
  readonly doc: SheetDoc;
  /** `validateSheet` on the resolved tree — folded into every result, which is what `runSheet`
   *  does with them, and read here for the blockers so the sheet is validated once, not twice. */
  readonly warnings: readonly QAWarning[];
  readonly blockers: readonly ConditionIssue[];
  /** The item list validation's findings make (withFindings), where there are blockers. */
  readonly items?: readonly Item[];
  readonly bindings: readonly NamedBinding[];
  /** The assumed DC inputs of the resolved tree — a fact about the document, so it is the same
   *  for every condition and attached to each result as `runSheet` attaches it. */
  readonly assumptions: readonly string[];
}

function prepareRun(doc: SheetDoc, refs?: SheetRefIndex): PreparedRun {
  const resolved = resolvedSheet(doc, refs);
  const warnings = validateSheet(resolved.doc);
  const errors = [...resolved.warnings, ...warnings].filter((w) => w.severity === 'error');
  // Each finding on the item it is about, with the cause the sheet gives it: the same function the
  // sheet's own run uses for validation's findings, from the findings alone.
  const blockers = errors.map((w): ConditionIssue => ({
    kind: 'invalid-sheet-or-ref',
    on: withFindings([], [w], resolved.doc, 'validation').map(refOf),
    message: w.message,
  }));
  return {
    doc: resolved.doc,
    warnings,
    blockers,
    ...(errors.length ? { items: withFindings([], errors, resolved.doc, 'validation') } : {}),
    assumptions: dcInputs(resolved.doc).assumed,
    // The tree is already resolved, so this walk adds no warnings of its own.
    bindings: blockers.length ? [] : namedBindings(resolved.doc).bindings,
  };
}

/**
 * Evaluate one sheet at exactly ONE condition — the single transition, never assembled ad hoc
 * by a caller, because every honest state depends on doing these steps in this order:
 *
 * 1. resolve references and validate; a sheet that is structurally broken is not evaluated,
 * 2. preflight the primary device and every explicitly bound child AT `key`; a missing or
 *    ambiguous table refuses BEFORE the engine sees it, since an unresolved device inside the
 *    engine is an ordinary infeasibility and would read as "infeasible",
 * 3. evaluate, projecting every named binding to `key` through one resolver,
 * 4. require the run to COMPLETE (no error-severity diagnostics): a run that produced no usable
 *    numbers is not evaluated either, with its result kept for diagnostics. What happened at a
 *    range end never refuses the run — it is that end's own compliance point.
 *
 * Children that name no device inherit the already-projected parent table, so the whole tree
 * evaluates at one condition without the resolver being consulted for them.
 */
export function runCondition(
  doc: SheetDoc,
  primaryDevice: CharacterizedDevice,
  key: ConditionKey,
  deviceOf: DeviceLookup,
  refs?: SheetRefIndex,
  opts: RunOptions = {},
): ConditionRun {
  return runPrepared(
    prepareRun(doc, refs),
    primaryDevice,
    key,
    deviceOf,
    undefined,
    opts.settings,
    opts.operatingPoint === true,
  );
}

/**
 * One design asked about at a SET of conditions. The design is sized once, at `base` — or, when
 * no base is given, at the single condition asked about — by the same transition `runCondition`
 * makes. Every other condition is then asked about THAT hardware: its givens rewritten to the
 * widths, lengths and currents the base run produced and its held nodes fixed by the gate
 * biases it needed (holdHardware), evaluated on that condition's tables with the operating point
 * free to re-settle. So the run at the base reads `design: 'sized'` and every other `'held'`.
 *
 * The base condition is part of every answer — feasibility is its verdict — so its run is
 * returned first when `keys` does not ask for it.
 *
 * Refusals, each answered per condition and never folded into a verdict:
 *  - several conditions and no base: nothing says where the design is sized (`no-design`);
 *  - the base was not evaluated: there is no hardware to hold (`no-design`);
 *  - the design rests on an assumed voltage: holding a typed guess across conditions would
 *    report on a design nobody can build (`assumed-level`). The check is the sheet's own list
 *    of assumed inputs, which is every one that reaches a device's sizing — wider than the ones
 *    that reach a bias, so a guess that only scales a width declines the question too.
 * Everything that does not depend on the condition (resolving, validating, collecting bindings)
 * is done once for the set.
 */
export function runConditions(
  doc: SheetDoc,
  primaryDevice: CharacterizedDevice,
  keys: readonly ConditionKey[],
  deviceOf: DeviceLookup,
  refs?: SheetRefIndex,
  base?: ConditionKey,
  opts: RunOptions = {},
): ConditionRun[] {
  return runSet(
    prepareRun(doc, refs),
    primaryDevice,
    keys,
    deviceOf,
    base,
    opts.settings,
    opts.operatingPoint === true,
  );
}

/** runConditions on a sheet already prepared — the one place a design is sized at one condition
 *  and held at the others, shared by the condition runs and the held sweep (sweepAtCondition). */
function runSet(
  prepared: PreparedRun,
  primaryDevice: CharacterizedDevice,
  keys: readonly ConditionKey[],
  deviceOf: DeviceLookup,
  base: ConditionKey | undefined,
  settings: Settings | undefined,
  operatingPoint = false,
): ConditionRun[] {
  if (keys.length === 0) return [];
  /** A condition that cannot be asked about the held design: what is wrong with THIS condition
   *  comes first — a table missing here, or a sheet that does not validate, is a fact about the
   *  bench that stays true whatever happens to the design, and the fix is a different one. */
  const declined = (
    key: ConditionKey,
    state: 'not-run' | 'no-answer',
    issue: ConditionIssue,
  ): ConditionRun => {
    const here = prepared.blockers.length
      ? prepared.blockers
      : preflightBindings(prepared.bindings, primaryDevice, key, deviceOf).issues;
    return here.length
      ? refused(prepared, key, 'held', 'not-run', here)
      : refused(prepared, key, 'held', state, [issue]);
  };
  const at = base ?? (keys.length === 1 ? keys[0] : undefined);
  if (at === undefined)
    return keys.map((key) =>
      declined(key, 'not-run', {
        kind: 'no-design',
        reason: 'no-base',
        message:
          'several conditions are asked about and none is designated nominal — the design ' +
          'has to be sized at one condition before it can be held at the others',
      }),
    );

  // The design's own run alone keeps each device's full operating point (see
  // RunOptions.operatingPoint): a held condition reads the same devices elsewhere.
  const sized = runPrepared(
    prepared,
    primaryDevice,
    at,
    deviceOf,
    undefined,
    settings,
    operatingPoint,
  );
  const asked = keys.some((k) => sameCondition(k, at)) ? keys : [at, ...keys];
  if (asked.length === 1) return [sized];

  // What stops the design being held anywhere else, when something does. A design that was not
  // sized was never asked about (`not-run`); one resting on an assumed level was asked and is
  // declined (`no-answer`).
  let held: HeldHardware | undefined;
  let refusal: { state: 'not-run' | 'no-answer'; issue: ConditionIssue } | undefined;
  if (sized.state !== 'evaluated')
    refusal = {
      state: 'not-run',
      issue: {
        kind: 'no-design',
        reason: 'base-not-evaluated',
        base: at,
        message: `the design was not evaluated at ${conditionLabelIn(primaryDevice, at)}, where it is sized, so there is nothing to hold here`,
      },
    };
  else if (prepared.assumptions.length)
    refusal = {
      state: 'no-answer',
      issue: {
        kind: 'assumed-level',
        names: prepared.assumptions.map(valueRef),
        message: assumedLevelRefusal(prepared.assumptions),
      },
    };
  else held = withNominalRange(holdHardware(prepared.doc, sized.result), sized.result);

  return asked.map((key): ConditionRun => {
    if (sameCondition(key, at)) return sized;
    if (!refusal) return runPrepared(prepared, primaryDevice, key, deviceOf, held, settings);
    return declined(key, refusal.state, refusal.issue);
  });
}

/** A sweep taken at one condition, and whose design each sample measured (see
 *  sweepAtCondition). */
export interface ConditionSweep extends SheetSweep {
  /** The condition every sample was evaluated at. */
  readonly key: ConditionKey;
  /** Where each sample's design was sized: `key` itself, or `base`. */
  readonly base: ConditionKey;
  /** `sized`: each sample sized the design at `key` with the knob at its value, and `feasible`
   *  is that design's feasibility. `held`: each sample sized the design at `base` with the knob
   *  at its value and held it at `key` — widths, lengths, currents and gate biases fixed, the
   *  operating point re-settled — so its margins are that held design's there, and `feasible`
   *  reads whether it complies at its own operating point, which is compliance, not
   *  feasibility. */
  readonly design: 'sized' | 'held';
}

/**
 * Trace a sheet across one parameter's slider range at ONE condition, `key`. Without a `base`, or
 * with `base` the same condition, each sample sizes the design at `key` — the numbers sweepSheet
 * gives on `key`'s tables. With another `base`, each sample is the two-condition question
 * runConditions answers: the design sized at `base` with the knob at that value, then held at
 * `key` by the same hold (holdHardware), and the sample reads the held run. So the curve is where
 * the design built for each knob value keeps working at `key`, and it is twice the work of a plain
 * sweep, not one sweep per condition.
 *
 * A sample refused before anything ran — the base did not stand, a table is missing, the design
 * rests on an assumed level — carries no margins; one that ran and did not complete carries what
 * it measured with `stands` false, as a plain sweep's does. Neither is feasible, and the reason is
 * the run's, as the condition breakdown reports it. Validation and binding collection run once
 * for the sweep, as sweepOf validates once. Pure; never throws.
 */
export function sweepAtCondition(
  doc: SheetDoc,
  param: string,
  primaryDevice: CharacterizedDevice,
  key: ConditionKey,
  deviceOf: DeviceLookup,
  refs?: SheetRefIndex,
  opts: SweepOptions & { readonly base?: ConditionKey; readonly points?: number } = {},
): ConditionSweep {
  const base = opts.base ?? key;
  const design = sameCondition(base, key) ? 'sized' : 'held';
  const v = doc.params.find((p) => p.name === param);
  // Prepared once, at the stand-in value sweepOf validates with; each sample swaps in its own
  // document, which differs from it only in the swept value.
  const prepared = prepareRun(sweepable(v) ? withParams(doc, { [param]: v.min }) : doc, refs);
  const sample = (d: SheetDoc): SweepSample => {
    const runs = runSet(
      { ...prepared, doc: d },
      primaryDevice,
      [key],
      deviceOf,
      base,
      opts.settings,
    );
    const run = runs.find((r) => sameCondition(r.key, key));
    if (!run) return { feasible: false, stands: false };
    // Passing is read from the centre's verdict: feasible where the design is sized here,
    // compliant where the design sized at `base` is held here. Completeness is the run's state.
    const verdict = run.points[0]?.verdict?.verdict;
    return {
      ...(run.result ? { res: run.result } : {}),
      feasible: verdict === (design === 'sized' ? 'feasible' : 'compliant'),
      stands: run.state === 'evaluated',
      complete: run.state === 'evaluated',
      ...(verdict !== undefined ? { verdict } : {}),
    };
  };
  // An edge is pinned with the sweep's own sample, less the range ends: passing — feasible where
  // the design is sized, complying at the condition's own point where it is held — never reads them.
  const sweep = sweepOf(
    doc,
    param,
    opts.points ?? SWEEP_POINTS,
    refs,
    sample,
    opts.windows ? (d) => sample(withoutRange(d)) : undefined,
  );
  return { ...sweep, key, base, design };
}

/** A condition nothing was evaluated at: every one of its points in the one `state`, for the
 *  first reason given. */
function refused(
  prepared: PreparedRun,
  key: ConditionKey,
  design: 'sized' | 'held',
  state: 'not-run' | 'no-answer',
  issues: readonly ConditionIssue[],
): ConditionRun {
  const error = issues[0]?.message;
  const point = (limit?: string): CompliancePoint => ({
    ...(limit === undefined ? {} : { rangeEnd: limit }),
    state,
    ...(error === undefined ? {} : { error }),
  });
  const ends = Array.isArray(prepared.doc.operatingRange) ? prepared.doc.operatingRange : [];
  const nodes = state === 'no-answer' ? unwalkedReport(prepared.doc) : undefined;
  return {
    state: 'not-evaluated',
    key,
    design,
    issues,
    points: [point(), ...ends.map((e) => point(e.name))],
    ...(nodes ? { nodes } : {}),
    ...(prepared.items && issues.some((i) => i.kind === 'invalid-sheet-or-ref')
      ? { items: prepared.items }
      : {}),
  };
}

/** One condition of a prepared sheet: sized here, or — given `held` — the held design re-biased
 *  here. The two differ in which document the engine sees and in how the centre point is read:
 *  a sized design answers for itself, a held one is classified like a range end (heldOutcome). */
function runPrepared(
  prepared: PreparedRun,
  primaryDevice: CharacterizedDevice,
  key: ConditionKey,
  deviceOf: DeviceLookup,
  held?: HeldHardware,
  settings?: Settings,
  operatingPoint = false,
): ConditionRun {
  const design = held ? 'held' : 'sized';
  if (prepared.blockers.length) return refused(prepared, key, design, 'not-run', prepared.blockers);

  const { primary, issues } = preflightBindings(prepared.bindings, primaryDevice, key, deviceOf);
  if (issues.length || primary === undefined)
    return refused(prepared, key, design, 'not-run', issues);
  // A hold the base run recorded no value for has nothing to be held at (see holdHardware).
  if (held?.unheld.length)
    return refused(prepared, key, design, 'no-answer', [
      {
        kind: 'runtime-evaluation',
        on: held.unheld.map(valueRef),
        message: `no gate bias was recorded for the held ${held.unheld.join(', ')}`,
      },
    ]);

  // `runSheet`'s two halves, with its validation pass already in hand: the doc is resolved and
  // validated above, so this is exactly what it would return — an error-free validation neither
  // blocks the verdict nor changes a warning.
  const doc = held?.doc ?? prepared.doc;
  const resolve = projectingResolver(deviceOf, key);
  const evaluated = evaluateSheet(doc, primary, resolve, {
    held: held !== undefined,
    assumed: prepared.assumptions,
    settings,
    ...(operatingPoint ? { operatingPoint: true } : {}),
  });
  // As runSheet does: a block sized on a table of the other polarity is said once for this run,
  // with the tables this condition binds (see inheritedPolarityWarnings).
  const bound = inheritedPolarityWarnings(doc, primary, resolve);
  const result: SheetResult = {
    ...withValidation([...prepared.warnings, ...bound], evaluated),
    assumptions: [...prepared.assumptions],
  };
  // Whether every number of the run is there (isComplete): what a condition that was not evaluated
  // means, apart from what the design is.
  const completed = isComplete(result);

  // The centre, classified once by the engine (pointOutcome): a design resting on an assumed level
  // has no compliance answer anywhere (the engine has already declined its range ends for the same
  // reason); a held design is read like a range end; the sized design answers for itself — it
  // complies where it is feasible.
  const outcome = evaluated.point;
  const outside = outsideIn(evaluated);
  // The centre's verdict, as the engine wrote it: the design verdict where the design is sized, the
  // held verdict where the design sized elsewhere is held here.
  const verdict: Verdict<DesignVerdict> | Verdict<HeldVerdict> | undefined = !result.items
    ? undefined
    : held
      ? result.heldVerdict
      : result.verdict;
  const centre: CompliancePoint = {
    ...(outcome
      ? { state: outcome.state, ...(outcome.error === undefined ? {} : { error: outcome.error }) }
      : { state: 'no-answer' as const, error: runtimeIssues(result)[0].message }),
    ...(outside.length ? { outside } : {}),
    ...(verdict ? { verdict } : {}),
  };
  const points: CompliancePoint[] = [
    centre,
    ...(result.rangeEnds ?? []).map((e): CompliancePoint => ({
      rangeEnd: e.name,
      state: e.state,
      ...(e.error === undefined ? {} : { error: e.error }),
      ...(e.outside ? { outside: e.outside } : {}),
      ...(e.verdict ? { verdict: e.verdict } : {}),
    })),
  ];

  const endsVerdict = heldVerdictOver(points.slice(1).map((point) => ({ key, point })));
  const ends = endsVerdict ? { endsVerdict } : {};
  if (!completed)
    return {
      state: 'not-evaluated',
      key,
      design,
      issues: runtimeIssues(result),
      points,
      ...ends,
      result,
    };
  return {
    state: 'evaluated',
    key,
    design,
    ...(held?.assumedSource.length ? { assumedSource: [...held.assumedSource] } : {}),
    feasible: result.feasible,
    points,
    ...ends,
    result,
  };
}

/** Whether one condition of a device can project at all, and why not when it cannot — the ONE
 *  statement of the three projection refusals, shared by the run transition and by any caller
 *  that must ask the question before evaluating (the picker preflights with it, so it never
 *  ranks a candidate the sheet panel would then refuse). `undefined` means the device has a
 *  unique, compatible table at the condition.
 *
 *  Conditions are named as conditionLabelIn names them, so a field a file did not declare stays
 *  marked: by the device's own table there, or — where it has none — by the table of `asked`,
 *  the device whose condition the run is (the primary a child is projected for). */
export function canProjectAt(
  device: CharacterizedDevice,
  key: ConditionKey,
  asked: CharacterizedDevice = device,
): ConditionIssue | undefined {
  if (new Set(device.conditions.map(axisSignature)).size > 1) {
    return {
      kind: 'incompatible-table',
      device: device.device,
      message: `the loaded characterizations of "${device.device}" do not sweep the same axes, so no condition of this device projects until the imports agree`,
    };
  }
  if (device.duplicates.some((d) => sameCondition(d, key))) {
    return {
      kind: 'ambiguous-condition',
      device: device.device,
      message: `several loaded tables claim "${device.device}" at ${conditionLabelIn(device, key)} — remove one or replace it explicitly`,
    };
  }
  if (!tableAt(device, key)) {
    return {
      kind: 'absent-condition',
      device: device.device,
      missing: 'condition',
      message: `"${device.device}" is not characterized at ${conditionLabelIn(asked, key)}`,
    };
  }
  return undefined;
}

/** The device's table at `key`, or `undefined` with the refusal appended to `issues`, said in
 *  terms of `where` the sheet asked for it, and naming the condition as `asked` does where the
 *  device has no table there (see canProjectAt). */
function memberFor(
  device: CharacterizedDevice,
  key: ConditionKey,
  where: string,
  issues: ConditionIssue[],
  asked: CharacterizedDevice = device,
  block?: string,
): DeviceTable | undefined {
  const issue = canProjectAt(device, key, asked);
  if (issue) {
    issues.push({
      ...issue,
      ...(block === undefined ? {} : { block }),
      message: `${where}: ${issue.message}`,
    });
    return undefined;
  }
  return tableAt(device, key);
}

/** Why an evaluation did not complete, from the result itself (see unfinishedBecause). Each issue
 *  points at the failed items whose number is not there (incompleteOn), whose own text says why. */
const runtimeIssues = (res: SheetResult): ConditionIssue[] => {
  const on = incompleteOn(res.items ?? [])
    .filter((i) => i.status === 'failed')
    .map(refOf);
  return unfinishedBecause(res).map((message) => ({ kind: 'runtime-evaluation', on, message }));
};

// --- one verdict over held points --------------------------------------------

/** One point of a condition run: its condition, and its range end (absent at the centre). */
export interface PointAt {
  readonly key: ConditionKey;
  readonly rangeEnd?: string;
}

/** What one held design is over several points, and the points that decide it. */
export interface HeldVerdictOver {
  readonly verdict: HeldVerdict;
  /** The points that decide the verdict: the non-compliant ones; the ones with no operating point;
   *  for undetermined, the undetermined ones and the ones the engine did not calculate; none where
   *  the design is compliant at every point. */
  readonly decidedBy: readonly PointAt[];
}

/**
 * The order in which one held verdict over several points is decided: the first word any point
 * has decides; compliant only where every point is. A point the engine did not calculate counts as
 * undetermined. Where "no operating point" stands in this order is open; it is kept here, in one
 * place, so that a ruling changes one line.
 */
export const HELD_PRECEDENCE: readonly Exclude<HeldVerdict, 'compliant'>[] = [
  'non-compliant',
  'no-operating-point',
  'undetermined',
];

/**
 * One held verdict over a list of points (HELD_PRECEDENCE), with the points that decide it. A point
 * with no verdict was not calculated. Absent where no point in the list has a verdict. Reads only
 * each point's verdict word, and copies nothing from the points.
 */
export function heldVerdictOver(
  points: readonly { readonly key: ConditionKey; readonly point: CompliancePoint }[],
): HeldVerdictOver | undefined {
  if (!points.some((p) => p.point.verdict)) return undefined;
  const at = (p: (typeof points)[number]): PointAt => ({
    key: p.key,
    ...(p.point.rangeEnd === undefined ? {} : { rangeEnd: p.point.rangeEnd }),
  });
  const word = (p: (typeof points)[number]): HeldVerdict =>
    (p.point.verdict?.verdict as HeldVerdict | undefined) ?? 'undetermined';
  for (const verdict of HELD_PRECEDENCE) {
    const deciding = points.filter((p) => word(p) === verdict);
    if (deciding.length) return { verdict, decidedBy: deciding.map(at) };
  }
  return { verdict: 'compliant', decidedBy: [] };
}

/** The held points of a set of runs: every point but the centre of the condition the design is
 *  sized at, in run order and the centre before the range ends. */
const heldPointsOf = (
  runs: readonly ConditionRun[],
): { key: ConditionKey; point: CompliancePoint }[] =>
  runs.flatMap((r) =>
    r.points
      .filter((_, i) => !(r.design === 'sized' && i === 0))
      .map((point) => ({ key: r.key, point })),
  );

// --- aggregation -------------------------------------------------------------

export interface ConditionAggregate {
  /**
   * FEASIBILITY — one answer, about the design where it was sized: can this design type meet
   * its spec at the base condition. Never a count and never moved by another condition or a
   * range end. `no-answer`: the base run started and did not complete — except a run whose centre
   * the engine reads as not complying (a solved wire with no crossing in the range the wiring
   * gives it), which is `infeasible`. `not-run`: nothing was sized — no base condition, or its
   * tables are not there.
   */
  readonly feasibility: 'feasible' | 'infeasible' | 'no-answer' | 'not-run';
  /** The condition feasibility was asked at. Absent when the design was sized nowhere. */
  readonly base?: ConditionKey;
  /** What the design is where it was sized: the design verdict of the base run's centre, with the
   *  failed items it rests on. Absent where nothing was sized or the engine calculated nothing. */
  readonly verdict?: Verdict<DesignVerdict>;
  /** Every held point — each range end of every condition and the centre of each condition the
   *  design is held at — counted by its held verdict; a point the engine calculated nothing at is
   *  `notCalculated`. `total` is every point but the base condition's centre. */
  readonly heldPoints: {
    readonly compliant: number;
    readonly nonCompliant: number;
    readonly noOperatingPoint: number;
    readonly undetermined: number;
    readonly notCalculated: number;
    readonly total: number;
  };
  /** The held design over those same points (heldVerdictOver). Absent where the engine calculated
   *  none of them. */
  readonly heldVerdict?: HeldVerdictOver;
  /** The points the margins below are read at (measuredPoints), and every point, with what the
   *  others are: never run (`notRun`), run and not calculated (`notCalculated`), or calculated
   *  with no margin to read, because the verdict there says nothing of the design or the run is
   *  not complete (`unreadable`). */
  readonly marginPoints: {
    readonly read: number;
    readonly total: number;
    readonly notRun: number;
    readonly notCalculated: number;
    readonly unreadable: number;
  };
  /**
   * COMPLIANCE — a count over points, never a single word: `total` is conditions × (the centre
   * + every declared range end), and each point lands in exactly one bucket. Not-run and
   * no-answer are counted apart and folded into neither verdict, so "complies at 5 of 9" can
   * never hide whether the other four failed or were simply not answered.
   */
  readonly compliance: {
    readonly complies: number;
    readonly doesNotComply: number;
    readonly noAnswer: number;
    readonly notRun: number;
    readonly total: number;
  };
  /** The smallest hard-check relative margin over every point whose checks were measured, with
   *  the check and the point that own it — where the held design is closest to failing, or
   *  failing worst. `null` when no point produced a measurable margin. Clamped like every other
   *  margin comparison (see clampMargin); the clamp is monotone, so clamping the minimum is the
   *  minimum of the clamped. */
  readonly worst: {
    readonly id: string;
    readonly marginPct: number;
    /** The check's status at that point: whether the tightest hard requirement fails there. */
    readonly status: CheckStatus;
    readonly key: ConditionKey;
    readonly rangeEnd?: string;
  } | null;
  /** The hard checks that sit exactly on their limit (a relative margin of exactly 0, which the
   *  near-zero snap gives any margin within one part in 1e5 of the limit) at some measured point,
   *  each with every such point, in run order and the centre before the range ends. `worst`
   *  leaves these out (see `measurable`): it cannot tell a check that is on its limit by
   *  construction from one the design really sits on, so they are reported here instead, and a
   *  reader is never told that a larger margin elsewhere is the tightest without seeing them. */
  readonly onLimit: readonly {
    readonly id: string;
    readonly points: readonly { readonly key: ConditionKey; readonly rangeEnd?: string }[];
  }[];
}

/**
 * Fold per-condition runs into what a header can honestly say: feasibility and compliance,
 * answered apart, neither inferred from the other. A design that is feasible and loses a range
 * end at one corner is feasible and does not comply there — two facts, two places.
 */
export function aggregateConditionRuns(runs: readonly ConditionRun[]): ConditionAggregate {
  const unique = uniqueRuns(runs);

  const sized = unique.find((r) => r.design === 'sized');
  // A base run that did not complete is no answer, unless the engine read its centre as a design
  // that does not comply. A search that found no crossing is not that: its centre is no answer
  // (see pointOutcome).
  const feasibility: ConditionAggregate['feasibility'] = !sized
    ? 'not-run'
    : sized.state === 'evaluated'
      ? sized.feasible
        ? 'feasible'
        : 'infeasible'
      : sized.result
        ? sized.points[0]?.state === 'does-not-comply'
          ? 'infeasible'
          : 'no-answer'
        : 'not-run';

  const compliance = { complies: 0, doesNotComply: 0, noAnswer: 0, notRun: 0, total: 0 };
  const BUCKET = {
    complies: 'complies',
    'does-not-comply': 'doesNotComply',
    'no-answer': 'noAnswer',
    'not-run': 'notRun',
  } as const;
  for (const r of unique)
    for (const pt of r.points) {
      compliance[BUCKET[pt.state]]++;
      compliance.total++;
    }
  const heldPoints = {
    compliant: 0,
    nonCompliant: 0,
    noOperatingPoint: 0,
    undetermined: 0,
    notCalculated: 0,
    total: 0,
  };
  const HELD = {
    compliant: 'compliant',
    'non-compliant': 'nonCompliant',
    'no-operating-point': 'noOperatingPoint',
    undetermined: 'undetermined',
  } as const;
  const held = heldPointsOf(unique);
  for (const { point } of held) {
    const v = point.verdict?.verdict as HeldVerdict | undefined;
    heldPoints[v === undefined ? 'notCalculated' : HELD[v]]++;
    heldPoints.total++;
  }
  const heldVerdict = heldVerdictOver(held);
  const verdict = sized?.points[0]?.verdict as Verdict<DesignVerdict> | undefined;
  let worst: ConditionAggregate['worst'] = null;
  const onLimit = new Map<string, { key: ConditionKey; rangeEnd?: string }[]>();
  const measured = measuredPoints(unique);
  for (const { run, point, at } of measured) {
    const where = {
      key: run.key,
      ...(point.rangeEnd === undefined ? {} : { rangeEnd: point.rangeEnd }),
    };
    for (const [id, c] of treeCheckResults({ checks: at.checks, blocks: at.blocks }))
      if (isHardCheck(c.kind) && c.marginPct === 0) {
        const points = onLimit.get(id);
        if (points) points.push(where);
        else onLimit.set(id, [where]);
      }
    const limiting = limitingCheck(at);
    if (!limiting) continue;
    const marginPct = clampMargin(limiting.marginPct);
    if (worst === null || marginPct < worst.marginPct) {
      const status = treeCheckResults({ checks: at.checks, blocks: at.blocks }).get(
        limiting.id,
      )!.status;
      worst = { id: limiting.id, marginPct, status, ...where };
    }
  }
  return {
    feasibility,
    ...(sized ? { base: sized.key } : {}),
    ...(verdict ? { verdict } : {}),
    heldPoints,
    ...(heldVerdict ? { heldVerdict } : {}),
    marginPoints: unreadPoints(unique, measured),
    compliance,
    worst,
    onLimit: [...onLimit].map(([id, points]) => ({ id, points })),
  };
}

/** The aggregate's account of the points its margins are read at, and of the others. */
function unreadPoints(
  runs: readonly ConditionRun[],
  measured: readonly { readonly point: CompliancePoint }[],
): ConditionAggregate['marginPoints'] {
  const read = new Set(measured.map((m) => m.point));
  const out = { read: read.size, total: 0, notRun: 0, notCalculated: 0, unreadable: 0 };
  for (const r of runs)
    for (const p of r.points) {
      out.total++;
      if (read.has(p)) continue;
      if (p.state === 'not-run') out.notRun++;
      else if (!p.verdict) out.notCalculated++;
      else out.unreadable++;
    }
  return out;
}

/** One run per condition: the denominator of every fold is unique conditions, so a caller that
 *  passed the same key twice must not double-count it. First-wins here is a de-dup of identical
 *  repeats, not a merge policy — producing at most one run per condition is the caller's job. */
function uniqueRuns(runs: readonly ConditionRun[]): ConditionRun[] {
  const byKey = new Map<string, ConditionRun>();
  for (const r of runs) {
    const id = conditionKeyId(r.key);
    if (!byKey.has(id)) byKey.set(id, r);
  }
  return [...byKey.values()];
}

/** Every point of `runs` whose checks were measured, in run order, the centre before the range
 *  ends, with the evaluation that measured it — the one walk every margin fold reads. A point
 *  counts where its verdict says what the design is there (feasible, compliant or non-compliant)
 *  and its run is complete (isComplete, incompleteOn): elsewhere its outcomes were read somewhere
 *  other than the point asked about, or not at all. */
function measuredPoints(runs: readonly ConditionRun[]): {
  run: ConditionRun;
  point: CompliancePoint;
  at: { checks: readonly CheckResult[]; blocks?: readonly SheetBlockReport[] };
}[] {
  const out: ReturnType<typeof measuredPoints> = [];
  for (const run of runs)
    run.points.forEach((point, i) => {
      const v = point.verdict?.verdict;
      if (v !== 'feasible' && v !== 'compliant' && v !== 'non-compliant') return;
      // points[0] is the run's own tree; points[i] mirrors result.rangeEnds[i - 1].
      const at = i === 0 ? run.result : run.result?.rangeEnds?.[i - 1];
      if (!at?.items || !isComplete(at)) return;
      out.push({ run, point, at: readChecks(at, at.items) });
    });
  return out;
}

/** The check outcomes of one complete point whose requirement's margin can be read there
 *  (marginReadable): a requirement failed for any other cause than failing gives no margin, whatever
 *  number its outcome carries. */
function readChecks(
  at: { checks: readonly CheckResult[]; blocks?: readonly SheetBlockReport[] },
  items: readonly Item[],
  path: readonly string[] = [],
): { checks: CheckResult[]; blocks?: SheetBlockReport[] } {
  const said = (id: string): boolean =>
    items.some(
      (i) =>
        i.kind === 'requirement' &&
        i.name === id &&
        i.path.join('.') === path.join('.') &&
        marginReadable(i),
    );
  return {
    checks: at.checks.filter((c) => said(c.id)),
    ...(at.blocks
      ? { blocks: at.blocks.map((b) => ({ ...b, ...readChecks(b, items, [...path, b.name]) })) }
      : {}),
  };
}

/** Where one check comes closest to failing, or fails worst, over every measured point. */
export interface CheckWorstPoint {
  /** The check's tree key: its id on the sheet itself, `block.id` for a block's check. */
  readonly id: string;
  readonly kind: CheckKind;
  /** Its smallest relative margin over the points, clamped like every margin comparison
   *  (clampMargin). */
  readonly marginPct: number;
  /** Its status at that point. */
  readonly status: CheckStatus;
  /** The condition of that point. */
  readonly key: ConditionKey;
  /** The range end of that point; absent at the design's own operating point (the centre). */
  readonly rangeEnd?: string;
}

/**
 * For each check, the point where its margin is smallest — the condition, and the range end or
 * the centre — over every point of `runs` whose checks were measured (the same points the
 * aggregate's tightest margin is read over). Every check that produced a finite margin somewhere
 * is listed, whatever its kind: the question is where THIS check is tightest, not whether it
 * gates. A point where the check could not be computed (`na`) is not a reading of it. Ties go to
 * the earlier point, in run order and the centre before the range ends. Keyed by tree key.
 */
export function worstPointByCheck(runs: readonly ConditionRun[]): Map<string, CheckWorstPoint> {
  const worst = new Map<string, CheckWorstPoint>();
  for (const { run, point, at } of measuredPoints(uniqueRuns(runs)))
    for (const [id, c] of treeCheckResults({ checks: at.checks, blocks: at.blocks })) {
      if (c.status === 'na' || !Number.isFinite(c.marginPct)) continue;
      const marginPct = clampMargin(c.marginPct);
      const seen = worst.get(id);
      if (seen && seen.marginPct <= marginPct) continue;
      worst.set(id, {
        id,
        kind: c.kind,
        marginPct,
        status: c.status,
        key: run.key,
        ...(point.rangeEnd === undefined ? {} : { rangeEnd: point.rangeEnd }),
      });
    }
  return worst;
}
