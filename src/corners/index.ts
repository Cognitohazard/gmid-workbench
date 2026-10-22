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

import type { DeviceTable, QAWarning, TableId } from '../types';
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
} from '../sheet';
import {
  SWEEP_POINTS,
  clampMargin,
  dcInputs,
  evaluateSheet,
  limitingCheck,
  namedBindings,
  resolvedSheet,
  stands,
  sweepOf,
  sweepable,
  treeCheckResults,
  unfinishedBecause,
  withParams,
  withValidation,
  validateSheet,
} from '../sheet';
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

/** The condition as a designer writes it: source spelling preserved, and the temperature
 *  elided at the 27 °C default so the common case reads `tt`, not `tt@27`. Accepts a table's
 *  own identity or a bare key, so a selected condition with no table loaded still labels. */
export function conditionLabel(id: { readonly corner: string; readonly temp: number }): string {
  const corner = id.corner.trim();
  return id.temp === 27 ? corner : `${corner}@${id.temp}`;
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

/** The nominal rule: a bench designation if there is one, else a sole member speaking for
 *  itself, else the tt member closest to 27 °C. Every ambiguity — two tt temperatures
 *  equidistant from 27, or two tables claiming the winning condition — yields no designation
 *  rather than a load-order winner, because which characterization is nominal is a statement
 *  about the bench, not about which file arrived first. A designation that lands on a
 *  duplicated condition is unusable the same way a vanished one is: every projection at that
 *  condition refuses, so it reads as unresolved rather than advertising a nominal no run can
 *  use. */
function designate(
  conditions: readonly DeviceTable[],
  duplicates: readonly ConditionKey[],
  deviceUid: string,
  opts: GroupDevicesOptions | undefined,
): Pick<CharacterizedDevice, 'nominal' | 'nominalSource' | 'unresolvedNominal'> {
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
  if (conditions.length === 1) return { nominal: conditions[0], nominalSource: 'auto' };
  const tt = conditions.filter((t) => conditionKeyOf(t.id).corner === 'tt');
  if (tt.length) {
    const near = nearestTo27(tt);
    return near
      ? { nominal: near, nominalSource: 'auto' }
      : { nominal: undefined, nominalSource: 'none' };
  }
  return { nominal: undefined, nominalSource: 'none' };
}

/** The single closest member to 27 °C, or `undefined` when the closest distance is shared —
 *  which covers both an exact straddle (17 and 37) and a duplicated winning condition. */
function nearestTo27(tt: readonly DeviceTable[]): DeviceTable | undefined {
  let best: DeviceTable | undefined;
  let bestDist = Infinity;
  let atBest = 0;
  for (const t of tt) {
    const dist = Math.abs(conditionKeyOf(t.id).temp - 27);
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

export interface ConditionIssue {
  readonly kind: ConditionIssueKind;
  /** The device the issue is about, when it is about one. */
  readonly device?: string;
  readonly message: string;
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
      /** Kept when an evaluation ran and did not stand, so its diagnostics survive the
       *  refusal — the numbers are how an author finds out why. */
      readonly result?: SheetResult;
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
        message: `block "${b.path}" names device "${b.binding}", which is not loaded`,
      });
      continue;
    }
    // A child bound to the primary's own device was already preflighted above; a second
    // issue for the same missing condition would list one problem twice.
    if (device.deviceUid === primaryDevice.deviceUid) continue;
    memberFor(device, key, `block "${b.path}"`, issues);
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
  readonly bindings: readonly NamedBinding[];
  /** The assumed DC inputs of the resolved tree — a fact about the document, so it is the same
   *  for every condition and attached to each result as `runSheet` attaches it. */
  readonly assumptions: readonly string[];
}

function prepareRun(doc: SheetDoc, refs?: SheetRefIndex): PreparedRun {
  const resolved = resolvedSheet(doc, refs);
  const warnings = validateSheet(resolved.doc);
  const blockers = [...resolved.warnings, ...warnings]
    .filter((w) => w.severity === 'error')
    .map((w): ConditionIssue => ({ kind: 'invalid-sheet-or-ref', message: w.message }));
  return {
    doc: resolved.doc,
    warnings,
    blockers,
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
  return runPrepared(prepareRun(doc, refs), primaryDevice, key, deviceOf, undefined, opts.settings);
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
  return runSet(prepareRun(doc, refs), primaryDevice, keys, deviceOf, base, opts.settings);
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
        message:
          'several conditions are asked about and none is designated nominal — the design ' +
          'has to be sized at one condition before it can be held at the others',
      }),
    );

  const sized = runPrepared(prepared, primaryDevice, at, deviceOf, undefined, settings);
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
        message: `the design was not evaluated at ${conditionLabel(at)}, where it is sized, so there is nothing to hold here`,
      },
    };
  else if (prepared.assumptions.length)
    refusal = {
      state: 'no-answer',
      issue: { kind: 'assumed-level', message: assumedLevelRefusal(prepared.assumptions) },
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
  opts: RunOptions & { readonly base?: ConditionKey; readonly points?: number } = {},
): ConditionSweep {
  const base = opts.base ?? key;
  const design = sameCondition(base, key) ? 'sized' : 'held';
  const v = doc.params.find((p) => p.name === param);
  // Prepared once, at the stand-in value sweepOf validates with; each sample swaps in its own
  // document, which differs from it only in the swept value.
  const prepared = prepareRun(sweepable(v) ? withParams(doc, { [param]: v.min }) : doc, refs);
  const sweep = sweepOf(doc, param, opts.points ?? SWEEP_POINTS, refs, (d) => {
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
    const evaluated = run.state === 'evaluated';
    return {
      ...(run.result ? { res: run.result } : {}),
      feasible: design === 'sized' ? evaluated && run.feasible : run.points[0].state === 'complies',
      stands: evaluated,
    };
  });
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
        message: `no gate bias was recorded for the held ${held.unheld.join(', ')}`,
      },
    ]);

  // `runSheet`'s two halves, with its validation pass already in hand: the doc is resolved and
  // validated above, so this is exactly what it would return — an error-free validation neither
  // blocks the verdict nor changes a warning.
  const evaluated = evaluateSheet(
    held?.doc ?? prepared.doc,
    primary,
    projectingResolver(deviceOf, key),
    { held: held !== undefined, assumed: prepared.assumptions, settings },
  );
  const result: SheetResult = {
    ...withValidation(prepared.warnings, evaluated),
    assumptions: [...prepared.assumptions],
  };
  const completed = stands(result);

  // The centre, classified once by the engine (pointOutcome): a design resting on an assumed level
  // has no compliance answer anywhere (the engine has already declined its range ends for the same
  // reason); a held design is read like a range end; the sized design answers for itself — it
  // complies where it is feasible.
  const outcome = evaluated.point;
  const centre: CompliancePoint = outcome
    ? { state: outcome.state, ...(outcome.error === undefined ? {} : { error: outcome.error }) }
    : { state: 'no-answer', error: runtimeIssues(result)[0].message };
  const points: CompliancePoint[] = [
    centre,
    ...(result.rangeEnds ?? []).map((e): CompliancePoint => ({
      rangeEnd: e.name,
      state: e.state,
      ...(e.error === undefined ? {} : { error: e.error }),
    })),
  ];

  if (!completed)
    return {
      state: 'not-evaluated',
      key,
      design,
      issues: runtimeIssues(result),
      points,
      result,
    };
  return {
    state: 'evaluated',
    key,
    design,
    ...(held?.assumedSource.length ? { assumedSource: [...held.assumedSource] } : {}),
    feasible: result.feasible,
    points,
    result,
  };
}

/** Whether one condition of a device can project at all, and why not when it cannot — the ONE
 *  statement of the three projection refusals, shared by the run transition and by any caller
 *  that must ask the question before evaluating (the picker preflights with it, so it never
 *  ranks a candidate the sheet panel would then refuse). `undefined` means the device has a
 *  unique, compatible table at the condition. */
export function canProjectAt(
  device: CharacterizedDevice,
  key: ConditionKey,
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
      message: `several loaded tables claim "${device.device}" at ${conditionLabel(key)} — remove one or replace it explicitly`,
    };
  }
  if (!tableAt(device, key)) {
    return {
      kind: 'absent-condition',
      device: device.device,
      message: `"${device.device}" is not characterized at ${conditionLabel(key)}`,
    };
  }
  return undefined;
}

/** The device's table at `key`, or `undefined` with the refusal appended to `issues`, said in
 *  terms of `where` the sheet asked for it. */
function memberFor(
  device: CharacterizedDevice,
  key: ConditionKey,
  where: string,
  issues: ConditionIssue[],
): DeviceTable | undefined {
  const issue = canProjectAt(device, key);
  if (issue) {
    issues.push({ ...issue, message: `${where}: ${issue.message}` });
    return undefined;
  }
  return tableAt(device, key);
}

/** Why an evaluation did not complete, from the result itself (see unfinishedBecause). */
const runtimeIssues = (res: SheetResult): ConditionIssue[] =>
  unfinishedBecause(res).map((message) => ({ kind: 'runtime-evaluation', message }));

// --- aggregation -------------------------------------------------------------

export interface ConditionAggregate {
  /**
   * FEASIBILITY — one answer, about the design where it was sized: can this design type meet
   * its spec at the base condition. Never a count and never moved by another condition or a
   * range end. `no-answer`: the base run started and did not complete. `not-run`: nothing was
   * sized — no base condition, or its tables are not there.
   */
  readonly feasibility: 'feasible' | 'infeasible' | 'no-answer' | 'not-run';
  /** The condition feasibility was asked at. Absent when the design was sized nowhere. */
  readonly base?: ConditionKey;
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
    readonly key: ConditionKey;
    readonly rangeEnd?: string;
  } | null;
}

/**
 * Fold per-condition runs into what a header can honestly say: feasibility and compliance,
 * answered apart, neither inferred from the other. A design that is feasible and loses a range
 * end at one corner is feasible and does not comply there — two facts, two places.
 */
export function aggregateConditionRuns(runs: readonly ConditionRun[]): ConditionAggregate {
  const unique = uniqueRuns(runs);

  const sized = unique.find((r) => r.design === 'sized');
  const feasibility: ConditionAggregate['feasibility'] = !sized
    ? 'not-run'
    : sized.state === 'evaluated'
      ? sized.feasible
        ? 'feasible'
        : 'infeasible'
      : sized.result
        ? 'no-answer'
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
  let worst: ConditionAggregate['worst'] = null;
  for (const { run, point, at } of measuredPoints(unique)) {
    const limiting = limitingCheck(at);
    if (!limiting) continue;
    const marginPct = clampMargin(limiting.marginPct);
    if (worst === null || marginPct < worst.marginPct)
      worst = {
        id: limiting.id,
        marginPct,
        key: run.key,
        ...(point.rangeEnd === undefined ? {} : { rangeEnd: point.rangeEnd }),
      };
  }
  return { feasibility, ...(sized ? { base: sized.key } : {}), compliance, worst };
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
 *  ends, with the evaluation that measured it — the one walk every margin fold reads. A point with
 *  an `error`, or one that is not a verdict, is left out: its outcomes were read somewhere other
 *  than the point asked about, or not at all. */
function measuredPoints(runs: readonly ConditionRun[]): {
  run: ConditionRun;
  point: CompliancePoint;
  at: { checks: readonly CheckResult[]; blocks?: readonly SheetBlockReport[] };
}[] {
  const out: ReturnType<typeof measuredPoints> = [];
  for (const run of runs)
    run.points.forEach((point, i) => {
      if (point.error !== undefined) return;
      if (point.state !== 'complies' && point.state !== 'does-not-comply') return;
      // points[0] is the run's own tree; points[i] mirrors result.rangeEnds[i - 1].
      const at = i === 0 ? run.result : run.result?.rangeEnds?.[i - 1];
      if (at) out.push({ run, point, at });
    });
  return out;
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
