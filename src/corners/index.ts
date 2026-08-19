// Corner families: one logical device characterized at several (corner, temperature)
// conditions, and the single transition that evaluates a design sheet at exactly one of them.
//
// Two rules shape everything here.
//
// Identity lives in the DATA. A family is derived from the headers its tables carry — process
// namespace, device name, declared polarity — never minted, remembered, or assigned by a bench.
// The derivation reads the loaded set as a whole: an under-declared header resolves against the
// declared ones loaded beside it (see groupFamilies), so the same blank-header file can land in
// a blank family on one bench and beside its declared siblings on another — but on any given
// bench the result is a pure function of the loaded headers. A wrong grouping is corrected by
// fixing the file rather than by a click, and there is no membership lifecycle to migrate or
// orphan.
//
// One run, one variant key. Every evaluation first fixes exactly one VariantKey and projects
// the primary AND every explicitly bound child to that same key. A child family's own nominal
// never substitutes a different key inside a run, because a verdict assembled from a tt@27
// input pair and a tt@85 tail describes a chip that does not exist. When any required family
// has no usable table at the key, the run is NOT EVALUATED — a fourth outcome, never folded
// into "does not close".
//
// Pure; zero DOM. Corner is categorical: nothing here interpolates, resamples, clips, or
// merges tables across corners.

import type { DeviceTable, QAWarning, TableId } from '../types';
import type { DeviceResolver, NamedBinding, SheetDoc, SheetRefIndex, SheetResult } from '../sheet';
import {
  clampMargin,
  edgeBroke,
  evaluateSheet,
  limitingConstraint,
  namedBindings,
  resolvedSheet,
  validateSheet,
} from '../sheet';

// --- variant identity --------------------------------------------------------

/**
 * The canonical identity of one characterization condition. `corner` is trimmed and
 * lower-cased so a file written `TT` and one written `tt` name the same condition; the source
 * spelling stays on the table for display (see `variantLabel`).
 */
export interface VariantKey {
  readonly corner: string;
  readonly temp: number; // [°C]
}

/** The canonical key of a table's identity. Accepts a table's own identity or a bare key, like
 *  `variantLabel`, so a caller canonicalizing a stored selection has no device name to invent. */
export function variantKeyOf(
  id: TableId | { readonly corner: string; readonly temp: number },
): VariantKey {
  // `+ 0` folds -0 onto 0, so a table written `# temp: -0` is not its own condition.
  return { corner: id.corner.trim().toLowerCase(), temp: id.temp + 0 };
}

/** Key equality — the ONE comparison every consumer shares, so grouping, projection,
 *  duplicate detection and persisted selections can never disagree about what one condition
 *  is. `Object.is` on the temperature so a table carrying a non-finite temperature still
 *  matches itself rather than fragmenting into a key nothing can select. */
export function sameVariant(a: VariantKey, b: VariantKey): boolean {
  return a.corner === b.corner && Object.is(a.temp, b.temp);
}

/** A key as a map/set key. JSON, not a joined string: a corner spelling is arbitrary text and
 *  an unescaped delimiter would let one condition impersonate another. The temperature goes in
 *  as text because JSON writes every non-finite number as `null`, which would collapse
 *  conditions `sameVariant` calls distinct into one id — a phantom duplicate. */
export function variantKeyId(k: VariantKey): string {
  return JSON.stringify([k.corner, String(k.temp)]);
}

/** The condition as a designer writes it: source spelling preserved, and the temperature
 *  elided at the 27 °C default so the common case reads `tt`, not `tt@27`. Accepts a table's
 *  own identity or a bare key, so a selected condition with no table loaded still labels. */
export function variantLabel(id: { readonly corner: string; readonly temp: number }): string {
  const corner = id.corner.trim();
  return id.temp === 27 ? corner : `${corner}@${id.temp}`;
}

// --- family identity ---------------------------------------------------------

/** Declared channel type, or `unknown` when no table said. Unknown never claims to separate:
 *  two undeclared tables of the same name group together, because refusing to guess is not the
 *  same as knowing they differ. */
export type FamilyPolarity = 'n' | 'p' | 'unknown';

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
 *  imported copy of the same file instead of forming a second, blank-namespace family. */
export function pdkOf(t: DeviceTable): string {
  const declared = t.meta.pdk ?? extraScalar(t, 'pdk');
  return declared === undefined ? '' : String(declared).trim();
}

/** The grouping tuple: process namespace, device name, declared polarity — all normalized, so
 *  case and surrounding space never split one device into two families. */
function familyKeyOf(t: DeviceTable): [string, string, FamilyPolarity] {
  return [
    pdkOf(t).toLowerCase(),
    t.id.device.trim().toLowerCase(),
    t.meta.polarity?.device ?? 'unknown',
  ];
}

/** The identity THIS TABLE's own headers declare: the canonical serialization of its grouping
 *  tuple. Purely derived — the same headers always produce the same value, on any machine and
 *  after any recharacterization. What a stored binding names is `CornerFamily.familyUid`, the
 *  bench-RESOLVED form of this (an under-declared table may sit in a more-declared family);
 *  the bench's resolver aliases each member's own value here to its family so bindings written
 *  before such a merge keep resolving. */
export function familyUidOf(t: DeviceTable): string {
  return JSON.stringify(familyKeyOf(t));
}

/** The grouping tuple a family identity was built from. */
export interface FamilyIdentity {
  /** Process namespace, normalized; `''` when the tables declared none. */
  readonly pdk: string;
  /** Device name, normalized — the grouping spelling, not a member's display spelling. */
  readonly device: string;
  readonly polarity: FamilyPolarity;
}

/** Read a `familyUid` back into the tuple it serializes, or `undefined` when the string is not
 *  one. The inverse lives beside `familyUidOf` so the serialization has a single owner: a caller
 *  that must show what an identity NAMES while no member of it is loaded — there is no family
 *  object to read a display name off — asks here instead of destructuring the JSON by position,
 *  which would mislabel silently if the tuple ever grew or was reordered. */
export function familyIdentityOf(uid: string): FamilyIdentity | undefined {
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
export interface CornerFamily {
  /** The bench-resolved grouping key (process namespace, device name, polarity). Usually every
   *  member's own `familyUidOf`; blanker members that joined a declared sibling carry the
   *  declared identity (see `groupFamilies`). */
  readonly familyUid: string;
  /** The device name in its source spelling, for display. */
  readonly device: string;
  /** Members in load order. */
  readonly variants: readonly DeviceTable[];
  /** The conditions the family holds, in load order, once each. A condition two members claim
   *  appears once: it is one condition two tables characterize, and every mode that offers it
   *  offers the condition rather than the tables. */
  readonly keys: readonly VariantKey[];
  /** Conditions claimed by more than one member. Nothing projects at these: load order is not
   *  a choice between two characterizations, so an ambiguous condition refuses until the bench
   *  removes one or replaces it explicitly. */
  readonly duplicates: readonly VariantKey[];
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

export interface GroupFamiliesOptions {
  /** familyUid → the identity of the member the bench designates nominal, in the CALLER's id
   *  space. Core never derives a table identity of its own: it compares whatever `uidOf`
   *  returns, so no uid scheme enters the numerics. Supplying a designation without `uidOf`
   *  leaves it unmatchable, which reads as an unresolved designation rather than as no
   *  designation at all. */
  readonly nominalByFamily?: ReadonlyMap<string, string>;
  /** The caller's identity for a table (the bench's content uid). */
  readonly uidOf?: (t: DeviceTable) => string;
}

/**
 * Group loaded tables into families, preserving load order both between and within families.
 *
 * Under-declared headers resolve against the declared ones on the bench before bucketing:
 * "undeclared never separates" has to hold against DECLARED tables too, or re-exporting one
 * corner with newly stamped `# pdk:` / `# polarity:` headers silently splits it away from the
 * older corners of the same device — the ordinary upgrade path, not an edge case. A blank
 * namespace or an unknown polarity therefore joins the unique declared candidate for the same
 * device name, and stays its own family only when several candidates would make the join a
 * guess (that remainder is what `validateFamilies` warns about). The resulting family carries
 * the declared identity, so `CornerFamily.familyUid` is the bench-resolved key — a member's
 * own `familyUidOf` may be blanker.
 */
export function groupFamilies(
  tables: readonly DeviceTable[],
  opts?: GroupFamiliesOptions,
): CornerFamily[] {
  const raw = tables.map(familyKeyOf);

  // Declared namespaces per device name; a blank one joins the sole candidate.
  const pdksByName = new Map<string, Set<string>>();
  for (const [pdk, name] of raw) {
    if (!pdk) continue;
    const set = pdksByName.get(name) ?? new Set<string>();
    set.add(pdk);
    pdksByName.set(name, set);
  }
  const effPdk = ([pdk, name]: readonly [string, string, FamilyPolarity]): string => {
    if (pdk) return pdk;
    const declared = pdksByName.get(name);
    return declared?.size === 1 ? [...declared][0] : '';
  };

  // Declared polarities per (resolved namespace, name); unknown joins the sole candidate —
  // it never bridges n and p, since two candidates leave it unresolved.
  const polsByGroup = new Map<string, Set<FamilyPolarity>>();
  for (const k of raw) {
    if (k[2] === 'unknown') continue;
    const group = JSON.stringify([effPdk(k), k[1]]);
    const set = polsByGroup.get(group) ?? new Set<FamilyPolarity>();
    set.add(k[2]);
    polsByGroup.set(group, set);
  }
  const effKey = (k: readonly [string, string, FamilyPolarity]): string => {
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
  return order.map((uid) => buildFamily(uid, members.get(uid) ?? [], opts));
}

function buildFamily(
  familyUid: string,
  variants: DeviceTable[],
  opts: GroupFamiliesOptions | undefined,
): CornerFamily {
  const seen = new Map<string, { key: VariantKey; count: number }>();
  for (const t of variants) {
    const key = variantKeyOf(t.id);
    const id = variantKeyId(key);
    const hit = seen.get(id);
    if (hit) hit.count++;
    else seen.set(id, { key, count: 1 });
  }
  const keys = [...seen.values()].map((e) => e.key);
  const duplicates = [...seen.values()].filter((e) => e.count > 1).map((e) => e.key);
  return {
    familyUid,
    device: variants[0]?.id.device ?? '',
    variants,
    keys,
    duplicates,
    ...designate(variants, duplicates, familyUid, opts),
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
  variants: readonly DeviceTable[],
  duplicates: readonly VariantKey[],
  familyUid: string,
  opts: GroupFamiliesOptions | undefined,
): Pick<CornerFamily, 'nominal' | 'nominalSource' | 'unresolvedNominal'> {
  const wanted = opts?.nominalByFamily?.get(familyUid);
  if (wanted !== undefined) {
    const uidOf = opts?.uidOf;
    const hit = uidOf && variants.find((t) => uidOf(t) === wanted);
    if (!hit)
      return { nominal: undefined, nominalSource: 'unresolved', unresolvedNominal: 'absent' };
    if (duplicates.some((d) => sameVariant(d, variantKeyOf(hit.id))))
      return { nominal: undefined, nominalSource: 'unresolved', unresolvedNominal: 'ambiguous' };
    return { nominal: hit, nominalSource: 'designated' };
  }
  if (variants.length === 1) return { nominal: variants[0], nominalSource: 'auto' };
  const tt = variants.filter((t) => variantKeyOf(t.id).corner === 'tt');
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
    const dist = Math.abs(variantKeyOf(t.id).temp - 27);
    if (!Number.isFinite(dist)) continue;
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
      atBest = 1;
    } else if (dist === bestDist) atBest++;
  }
  return atBest === 1 ? best : undefined;
}

/** The family's unique table at one condition — the ONE projection rule. `undefined` when no
 *  member claims the condition AND when several do: an ambiguous condition never resolves to a
 *  winner, here or anywhere else. */
export function variantAt(f: CornerFamily, key: VariantKey): DeviceTable | undefined {
  if (f.duplicates.some((d) => sameVariant(d, key))) return undefined;
  return f.variants.find((t) => sameVariant(variantKeyOf(t.id), key));
}

/** One table's swept-axis signature — the shape fact family QA and projection both compare.
 *  Variants that disagree on it are not one device in any sense a sheet can rely on: a design
 *  pinned on one is not pinned on the other. */
export function axisSignature(t: DeviceTable): string {
  return t.grid.axes.map((a) => a.name).join(', ');
}

// --- the run transition ------------------------------------------------------

/** Why a condition could not be evaluated. Kinds, not prose, so a UI can group and act on
 *  them: `absent-variant` and `ambiguous-variant` are fixed at the bench (import the missing
 *  corner, remove the duplicate), `invalid-sheet-or-ref` in the sheet, and
 *  `runtime-evaluation` reports an evaluation that started and did not complete.
 *  `incompatible-table` refuses a family whose members do not sweep the same axes: its
 *  variants cannot serve one sheet interchangeably, so no condition of it projects until the
 *  imports agree — the same fact family QA reports as an error. */
export type VariantIssueKind =
  | 'absent-variant'
  | 'ambiguous-variant'
  | 'incompatible-table'
  | 'invalid-sheet-or-ref'
  | 'runtime-evaluation';

export interface VariantIssue {
  readonly kind: VariantIssueKind;
  /** The device the issue is about, when it is about one. */
  readonly device?: string;
  readonly message: string;
}

/** One run's coverage answer. `unavailable` is not a coverage verdict — it says the run did
 *  not happen, and it exists so an aggregate can never quietly count it as either. */
export type PerRunCovers = 'covers' | 'gap' | 'unchecked' | 'unavailable';

export type VariantRun =
  | {
      readonly state: 'evaluated';
      readonly key: VariantKey;
      readonly closes: 'pass' | 'fail';
      /** Narrower than PerRunCovers: a run that happened has a coverage answer, and letting it
       *  claim `unavailable` would put one condition in the closure counts and the coverage
       *  unavailable count at once. */
      readonly covers: Exclude<PerRunCovers, 'unavailable'>;
      readonly result: SheetResult;
    }
  | {
      readonly state: 'not-evaluated';
      readonly key: VariantKey;
      readonly issues: readonly VariantIssue[];
      /** Kept when an evaluation ran and did not stand, so its diagnostics survive the
       *  refusal — the numbers are how an author finds out why. */
      readonly result?: SheetResult;
    };

/** A device binding as written in a sheet → the family it names, or `undefined` when nothing
 *  loaded answers to it. Injected, exactly like `DeviceResolver`: how a binding string is
 *  matched (exact table identity first, family form second) is the bench's business, and core
 *  never parses one. */
export type FamilyResolver = (binding: string) => CornerFamily | undefined;

/** Project every device binding to ONE condition: each binding answers with its family's table
 *  at `key`, and with nothing when no family answers to it or the condition does not project.
 *  The one place a binding becomes a table, so a verdict, a chart and a probe taken under it can
 *  never be reading different conditions of the same design. */
export function projectingResolver(familyOf: FamilyResolver, key: VariantKey): DeviceResolver {
  return (binding) => {
    const family = familyOf(binding);
    return family && variantAt(family, key);
  };
}

/** What a condition's preflight found: the primary family's table at it, and everything that
 *  stops it from being evaluated. */
export interface VariantPreflight {
  /** `undefined` exactly when the primary family contributed a refusal. */
  readonly primary: DeviceTable | undefined;
  readonly issues: readonly VariantIssue[];
}

/**
 * Ask whether one condition can be evaluated at all — the primary family and every explicitly
 * bound child, in that order — WITHOUT evaluating it. This is step 2 of `runVariant`, exported
 * because a caller that must screen conditions before spending an evaluation on them (the picker
 * searching a catalog) has to refuse on the same grounds, in the same order, in the same words:
 * a second copy kept in step by hand is how a picker comes to rank a candidate the sheet panel
 * then refuses.
 *
 * Structural sheet problems are NOT in here: they are not about a condition, and `runVariant`
 * reports them before any family is asked.
 */
export function preflightVariant(
  doc: SheetDoc,
  primaryFamily: CornerFamily,
  key: VariantKey,
  familyOf: FamilyResolver,
  refs?: SheetRefIndex,
): VariantPreflight {
  return preflightBindings(namedBindings(doc, refs).bindings, primaryFamily, key, familyOf);
}

function preflightBindings(
  bindings: readonly NamedBinding[],
  primaryFamily: CornerFamily,
  key: VariantKey,
  familyOf: FamilyResolver,
): VariantPreflight {
  const issues: VariantIssue[] = [];
  const primary = memberFor(primaryFamily, key, 'the primary device', issues);
  const bound = new Set<string>();
  for (const b of bindings) {
    if (bound.has(b.binding)) continue;
    bound.add(b.binding);
    const family = familyOf(b.binding);
    if (!family) {
      issues.push({
        kind: 'absent-variant',
        device: b.binding,
        message: `block "${b.path}" names device "${b.binding}", which is not loaded`,
      });
      continue;
    }
    // A child bound to the primary's own family was already preflighted above; a second
    // issue for the same missing condition would list one problem twice.
    if (family.familyUid === primaryFamily.familyUid) continue;
    memberFor(family, key, `block "${b.path}"`, issues);
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
  readonly blockers: readonly VariantIssue[];
  readonly bindings: readonly NamedBinding[];
}

function prepareRun(doc: SheetDoc, refs?: SheetRefIndex): PreparedRun {
  const resolved = resolvedSheet(doc, refs);
  const warnings = validateSheet(resolved.doc);
  const blockers = [...resolved.warnings, ...warnings]
    .filter((w) => w.severity === 'error')
    .map((w): VariantIssue => ({ kind: 'invalid-sheet-or-ref', message: w.message }));
  return {
    doc: resolved.doc,
    warnings,
    blockers,
    // The tree is already resolved, so this walk adds no warnings of its own.
    bindings: blockers.length ? [] : namedBindings(resolved.doc).bindings,
  };
}

/**
 * Evaluate one sheet at exactly ONE condition — the single transition, never assembled ad hoc
 * by a caller, because every honest state depends on doing these steps in this order:
 *
 * 1. resolve references and validate; a sheet that is structurally broken is not evaluated,
 * 2. preflight the primary family and every explicitly bound child AT `key`; a missing or
 *    ambiguous table refuses BEFORE the engine sees it, since an unresolved device inside the
 *    engine is an ordinary infeasibility and would read as "does not close",
 * 3. evaluate, projecting every named binding to `key` through one resolver,
 * 4. require the base run to COMPLETE (no error-severity diagnostics): a run that produced no
 *    usable numbers is not evaluated either, with its result kept for diagnostics. A broken
 *    containment edge alone does not refuse — closure was measured; the break is a coverage
 *    non-answer (see coversOf).
 *
 * Children that name no device inherit the already-projected parent table, so the whole tree
 * evaluates at one condition without the resolver being consulted for them.
 */
export function runVariant(
  doc: SheetDoc,
  primaryFamily: CornerFamily,
  key: VariantKey,
  familyOf: FamilyResolver,
  refs?: SheetRefIndex,
): VariantRun {
  return runPrepared(prepareRun(doc, refs), primaryFamily, key, familyOf);
}

/** The same transition over a SET of conditions: identical run for identical arguments, with
 *  everything that does not depend on the condition done once instead of once per key. A panel
 *  asking about several conditions asks one question about one sheet, so resolving, validating
 *  and collecting its bindings that many times is work nobody ordered. */
export function runVariants(
  doc: SheetDoc,
  primaryFamily: CornerFamily,
  keys: readonly VariantKey[],
  familyOf: FamilyResolver,
  refs?: SheetRefIndex,
): VariantRun[] {
  const prepared = prepareRun(doc, refs);
  return keys.map((key) => runPrepared(prepared, primaryFamily, key, familyOf));
}

function runPrepared(
  prepared: PreparedRun,
  primaryFamily: CornerFamily,
  key: VariantKey,
  familyOf: FamilyResolver,
): VariantRun {
  if (prepared.blockers.length) return { state: 'not-evaluated', key, issues: prepared.blockers };

  const { primary, issues } = preflightBindings(prepared.bindings, primaryFamily, key, familyOf);
  if (issues.length || primary === undefined) return { state: 'not-evaluated', key, issues };

  // `runSheet`'s two halves, with its validation pass already in hand: the doc is resolved and
  // validated above, so this is exactly what it would return — an error-free validation neither
  // blocks the verdict nor changes a warning.
  const evaluated = evaluateSheet(prepared.doc, primary, projectingResolver(familyOf, key));
  const result: SheetResult = {
    ...evaluated,
    warnings: [...prepared.warnings, ...evaluated.warnings],
  };
  // The gate is "did the base run complete", NOT `stands()`: stands() also folds in a broken
  // containment edge, whose failure is a COVERAGE non-answer — gating on it here would erase a
  // measured closure verdict (five library sheets on the demo device hit exactly that). The
  // broken edge lands in the coverage dimension instead (see coversOf).
  if (result.warnings.some((w) => w.severity === 'error'))
    return { state: 'not-evaluated', key, issues: runtimeIssues(result), result };
  return {
    state: 'evaluated',
    key,
    closes: result.closes ? 'pass' : 'fail',
    covers: coversOf(result),
    result,
  };
}

/** Whether one condition of a family can project at all, and why not when it cannot — the ONE
 *  statement of the three projection refusals, shared by the run transition and by any caller
 *  that must ask the question before evaluating (the picker preflights with it, so it never
 *  ranks a candidate the sheet panel would then refuse). `undefined` means the family has a
 *  unique, compatible table at the condition. */
export function canProjectAt(family: CornerFamily, key: VariantKey): VariantIssue | undefined {
  if (new Set(family.variants.map(axisSignature)).size > 1) {
    return {
      kind: 'incompatible-table',
      device: family.device,
      message: `the loaded characterizations of "${family.device}" do not sweep the same axes, so no condition of this family projects until the imports agree`,
    };
  }
  if (family.duplicates.some((d) => sameVariant(d, key))) {
    return {
      kind: 'ambiguous-variant',
      device: family.device,
      message: `several loaded tables claim "${family.device}" at ${variantLabel(key)} — remove one or replace it explicitly`,
    };
  }
  if (!variantAt(family, key)) {
    return {
      kind: 'absent-variant',
      device: family.device,
      message: `"${family.device}" is not characterized at ${variantLabel(key)}`,
    };
  }
  return undefined;
}

/** The family's table at `key`, or `undefined` with the refusal appended to `issues`, said in
 *  terms of `where` the sheet asked for it. */
function memberFor(
  family: CornerFamily,
  key: VariantKey,
  where: string,
  issues: VariantIssue[],
): DeviceTable | undefined {
  const issue = canProjectAt(family, key);
  if (issue) {
    issues.push({ ...issue, message: `${where}: ${issue.message}` });
    return undefined;
  }
  return variantAt(family, key);
}

/** Why an evaluation did not stand, from the result itself: its error diagnostics, plus any
 *  range end that was checked and could not be evaluated (an edge's failure is reported in its
 *  own report and never merged upward, so it needs its own pass). */
function runtimeIssues(res: SheetResult): VariantIssue[] {
  const issues: VariantIssue[] = res.warnings
    .filter((w) => w.severity === 'error')
    .map((w) => ({ kind: 'runtime-evaluation' as const, message: w.message }));
  for (const e of res.edges ?? []) {
    if (edgeBroke(e)) issues.push({ kind: 'runtime-evaluation', message: `${e.name}: ${e.error}` });
  }
  // A refusal with no reason is indistinguishable from a verdict, so this list is never empty.
  if (!issues.length)
    issues.push({ kind: 'runtime-evaluation', message: 'the evaluation did not complete' });
  return issues;
}

/** One evaluated run's coverage answer. An absent `covers` means the question was not asked —
 *  the sheet claims no range, or its edges were not checked — which is `unchecked`, never a
 *  gap. */
function coversOf(res: SheetResult): Exclude<PerRunCovers, 'unavailable'> {
  // A range end that BROKE (its pin never landed) produced no coverage answer at all, so the
  // run's coverage is unchecked — never `covers` (some end went unproven) and never `gap`
  // (nothing measured a miss; the folded `res.covers === false` cannot tell the two apart).
  // The end's own error stays visible in its edge report.
  if ((res.edges ?? []).some(edgeBroke)) return 'unchecked';
  return res.covers === undefined ? 'unchecked' : res.covers ? 'covers' : 'gap';
}

// --- aggregation -------------------------------------------------------------

export interface VariantAggregate {
  /** `all`: every selected condition was evaluated and closes. `fails`: at least one evaluated
   *  condition does not close. `unverified`: nothing failed, but conditions went unevaluated —
   *  the design is not shown to close across the set. `none-evaluated`: nothing ran. */
  readonly closes: 'all' | 'fails' | 'unverified' | 'none-evaluated';
  /** Denominated in unique conditions, never in tables. */
  readonly counts: { readonly pass: number; readonly fail: number; readonly unavailable: number };
  /** The smallest hard-rule relative margin over the EVALUATED runs only — never over the set,
   *  which is why `counts` travels with it. `null` when no evaluated run produced a measurable
   *  margin. Clamped like every other margin comparison (see clampMargin); the clamp is
   *  monotone, so clamping the minimum is the minimum of the clamped. */
  readonly worstMargin: number | null;
  /** Absent when the sheet declares no containment edges at all — coverage is then not a
   *  question about this design, which is different from a question nothing answered. */
  readonly covers?: {
    readonly state: 'all' | 'gap' | 'unchecked' | 'unverified';
    readonly counts: {
      readonly covers: number;
      readonly gap: number;
      readonly unchecked: number;
      readonly unavailable: number;
    };
  };
}

/**
 * Fold per-condition runs into what a header can honestly say. Closure and coverage aggregate
 * SEPARATELY and neither is inferred from the other: a design that closes everywhere while one
 * range end fails is a coverage gap, not a closure failure, and a set with unevaluated
 * conditions is never reported as passing them.
 *
 * `hasEdges` comes from the resolved doc rather than from the runs, because when nothing was
 * evaluated the runs cannot distinguish a sheet that claims no range from one whose range
 * claims went unchecked.
 */
export function aggregateVariantRuns(
  runs: readonly VariantRun[],
  hasEdges: boolean,
): VariantAggregate {
  // One run per condition: the denominator is unique conditions, so a caller that passed the
  // same key twice must not double-count it. First-wins here is a de-dup of identical
  // repeats, not a merge policy — producing at most one run per condition is the caller's job.
  const byKey = new Map<string, VariantRun>();
  for (const r of runs) {
    const id = variantKeyId(r.key);
    if (!byKey.has(id)) byKey.set(id, r);
  }
  const unique = [...byKey.values()];

  const evaluated = unique.filter((r) => r.state === 'evaluated');
  const pass = evaluated.filter((r) => r.closes === 'pass').length;
  const fail = evaluated.length - pass;
  const unavailable = unique.length - evaluated.length;

  let worstMargin: number | null = null;
  for (const r of evaluated) {
    // The base design's own rules and children only. `limitingConstraint` walks a standing
    // run's containment-edge outcomes too, and a range end's headroom is a coverage answer —
    // quoting it here would attribute a coverage number to closure, beside closure counts.
    const limiting = limitingConstraint({ rules: r.result.rules, children: r.result.children });
    if (limiting === undefined) continue;
    const m = clampMargin(limiting.marginPct);
    if (worstMargin === null || m < worstMargin) worstMargin = m;
  }

  const closes =
    evaluated.length === 0
      ? 'none-evaluated'
      : fail > 0
        ? 'fails'
        : unavailable > 0
          ? 'unverified'
          : 'all';

  const aggregate: VariantAggregate = {
    closes,
    counts: { pass, fail, unavailable },
    worstMargin,
  };
  // `hasEdges` is the doc's answer to "is coverage a question here at all", which the runs
  // alone cannot give when none of them was evaluated. It does not get to suppress an answer
  // a run actually measured: a coverage gap in hand outranks a flag saying there was nothing
  // to look for.
  const measured = unique.some((r) => r.state === 'evaluated' && r.covers !== 'unchecked');
  if (!hasEdges && !measured) return aggregate;

  const counts = { covers: 0, gap: 0, unchecked: 0, unavailable: 0 };
  for (const r of unique) counts[r.state === 'evaluated' ? r.covers : 'unavailable']++;
  const state =
    counts.gap > 0
      ? 'gap' // one measured gap decides it; the rest cannot argue it away
      : counts.covers > 0 && counts.unavailable === 0 && counts.unchecked === 0
        ? 'all'
        : counts.covers === 0
          ? 'unchecked' // edges are claimed, nothing measured one
          : 'unverified'; // covered where it answered; elsewhere unrun, or a check that broke
  return { ...aggregate, covers: { state, counts } };
}
