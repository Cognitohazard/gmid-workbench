// The bench's view of corner families: how a loaded table is named, how a sheet's device
// binding is matched to a family, and what the localStorage registry keeps between sessions.
//
// The numerics are the core's (groupFamilies, variantAt, runVariant). What lives here is the
// part the core deliberately refuses to know: the bench's table identity (`tableUid`) and the
// syntax of a binding string. Core takes both as injected functions, so nothing below is a
// second definition of a family — only of how this app addresses one.

import {
  extraScalar,
  familyIdentityOf,
  familyUidOf,
  groupFamilies,
  pdkOf,
  type CornerFamily,
  type DeviceTable,
  type FamilyResolver,
} from '@gmid/mostab-core';
import { tableUid } from './dashboard';

/**
 * What the bench hands a panel: the loaded families, how to match a binding to one, which
 * family the active table belongs to, the menu a composed child picks from, a token that
 * changes whenever any of it does, and the one control that changes a designation.
 */
export interface Bench {
  readonly families: readonly CornerFamily[];
  readonly familyOf: FamilyResolver;
  /** The family of the active table — the primary of every sheet panel on the dashboard. */
  readonly primary: CornerFamily | undefined;
  readonly options: readonly { binding: string; label: string }[];
  readonly revision: string;
  readonly designate: (familyUid: string, uid: string) => void;
}

/** The discriminator a composed child's `device` string carries when it names a FAMILY rather
 *  than one table. Legacy documents store a raw table uid instead; both are read (see
 *  `familyResolver`), and only this form is ever written. */
const FAMILY_PREFIX = 'family:';

const familyBinding = (f: CornerFamily): string => FAMILY_PREFIX + f.familyUid;

/**
 * Group the loaded tables, with the bench's designations and its table identity.
 *
 * `previous` is the last grouping, and every family it already holds unchanged comes back as
 * the SAME object (the whole array too, when nothing moved). Grouping is cheap, but what hangs
 * off a family is not — its QA is memoized per family object, and the bench regroups on every
 * import, removal and designation — so handing back a fresh object for a family nobody touched
 * would re-derive all of it to reach the same answer.
 */
export function benchFamilies(
  tables: readonly DeviceTable[],
  nominalByFamily: Readonly<Record<string, string>>,
  previous: readonly CornerFamily[] = [],
): readonly CornerFamily[] {
  const next = groupFamilies(tables, {
    nominalByFamily: new Map(Object.entries(nominalByFamily)),
    uidOf: tableUid,
  });
  const kept = new Map(previous.map((f) => [familySignature(f), f]));
  const merged = next.map((f) => kept.get(familySignature(f)) ?? f);
  return merged.length === previous.length && merged.every((f, i) => f === previous[i])
    ? previous
    : merged;
}

/**
 * A device binding as written in a sheet → the family that answers to it.
 *
 * An exact loaded table uid wins FIRST, before the `family:` form is parsed at all: a table
 * whose device name happens to begin `family:` produces a raw uid that begins with the
 * discriminator, and a prefix test taken first would stop resolving it. Only then is the
 * remainder read as a family identity, and only when that family is actually loaded — so an
 * unrecognized string stays unresolved rather than half-matching.
 */
export function familyResolver(families: readonly CornerFamily[]): FamilyResolver {
  const byTable = new Map<string, CornerFamily>();
  const byFamily = new Map<string, CornerFamily>();
  for (const f of families) {
    byFamily.set(f.familyUid, f);
    for (const t of f.variants) {
      byTable.set(tableUid(t), f);
      // Each member's OWN identity aliases to its family too: a binding stored before an
      // under-declared member merged into a declared sibling names the pre-merge identity,
      // and the device it means is still loaded. Safe — identical own-identities always land
      // in one family, so an alias can never be claimed by two.
      byFamily.set(familyUidOf(t), f);
    }
  }
  return (binding: string) =>
    byTable.get(binding) ??
    (binding.startsWith(FAMILY_PREFIX)
      ? byFamily.get(binding.slice(FAMILY_PREFIX.length))
      : undefined);
}

/** The family's process namespace as declared, or '' when its tables declare none. */
const familyPdk = (f: CornerFamily): string => (f.variants[0] ? pdkOf(f.variants[0]) : '');

/** A family in a menu: the device name, its namespace when it has one, and how many
 *  conditions it holds — the fact that decides whether a corner mode has anything to choose. */
export function familyLabel(f: CornerFamily): string {
  const pdk = familyPdk(f);
  const n = f.variants.length;
  return `${f.device}${pdk ? ` · ${pdk}` : ''}${n > 1 ? ` · ${n} conditions` : ''}`;
}

/** The composed-child device menu: one entry per loaded family, bound by family identity, with
 *  a `#n` suffix where two families would otherwise read the same — two undeclared-namespace
 *  processes shipping one device name. Built where the labels are, so a menu can never show a
 *  duplicate the labelling knew how to tell apart. */
export function familyOptions(
  families: readonly CornerFamily[],
): { binding: string; label: string }[] {
  const seen = new Map<string, number>();
  return families.map((f) => {
    const label = familyLabel(f);
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return { binding: familyBinding(f), label: n > 1 ? `${label} #${n}` : label };
  });
}

/** What one variant records about where it came from, for the strip: the fact that makes a
 *  grouping by name alone an informed one rather than an invisible guess. Reads `source` through
 *  core's `extraScalar`, so the strip and family QA's provenance check can never disagree about
 *  what a table declares. */
export function provenanceOf(t: DeviceTable): string {
  const source = extraScalar(t, 'source');
  return [
    pdkOf(t),
    source === undefined ? '' : String(source),
    t.meta.simulator ?? '',
    t.meta.date ?? '',
  ]
    .filter((s) => s !== '')
    .join(' · ');
}

/** A stored binding rendered for a human — used where the thing it names is NOT loaded, so
 *  there is no table or family to read a display name off. A family binding carries its device
 *  name inside its identity; a legacy uid already starts with the table's display label. */
export function describeBinding(binding: string): string {
  if (!binding.startsWith(FAMILY_PREFIX)) return binding;
  // Core owns both directions of the identity's serialization; reading the tuple by position
  // here would mislabel silently the day it grows a field.
  const id = familyIdentityOf(binding.slice(FAMILY_PREFIX.length));
  if (!id?.device) return binding; // not our serialization after all — show it as written
  return id.pdk ? `${id.device} · ${id.pdk}` : id.device;
}

/** Everything about one family that a projection or a designation display reads: its identity,
 *  its members, and what it calls nominal — the condition AND how it came by it, because pinning
 *  the condition the automatic rule had already chosen changes nothing but the answer to "who
 *  chose this", which is exactly what the strip is reporting. Every other field is a function of
 *  the members. */
function familySignature(f: CornerFamily): string {
  const nominal = f.nominal ? tableUid(f.nominal) : '';
  const source = `${f.nominalSource}:${f.unresolvedNominal ?? ''}`;
  return `${f.familyUid}@${f.variants.map(tableUid).join('~')}#${source}#${nominal}`;
}

/**
 * A token that changes whenever anything a projected run reads has changed: which families
 * exist, which tables are in them, and which condition each calls nominal. A saved search
 * result is an answer about that state, so this is what tells it it has gone stale — the
 * active table's uid cannot, because a bench edit can change every projection without the
 * active table moving at all.
 */
export function familyRevision(families: readonly CornerFamily[]): string {
  return families.map(familySignature).join('|');
}

// --- the registry sidecar ----------------------------------------------------

/**
 * What localStorage keeps about the bench: load order, which table is active, and which
 * member each family designates as its nominal condition. Version 1 stored `{order, active}`
 * only; it parses here as a v2 with no designations, which IS the migration — a bench that
 * never designated anything has nothing to carry over.
 */
export interface Registry {
  order: string[];
  active: number;
  /** familyUid → the designated member's table uid. A uid that is no longer in its family is
   *  NOT dropped: it reads as an unresolved designation, so a bench that lost the table it
   *  named says so instead of quietly designating a different corner. */
  nominalByFamily: Record<string, string>;
}

export const REGISTRY_VERSION = 2;

export function parseRegistry(raw: unknown): Registry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const order = o.order;
  if (!Array.isArray(order) || order.some((u) => typeof u !== 'string')) return null;
  const nominalByFamily: Record<string, string> = {};
  const nom = o.nominalByFamily;
  if (nom && typeof nom === 'object' && !Array.isArray(nom))
    for (const [k, v] of Object.entries(nom)) if (typeof v === 'string') nominalByFamily[k] = v;
  const active = o.active;
  return {
    order: order as string[],
    active: typeof active === 'number' && Number.isFinite(active) ? Math.trunc(active) : 0,
    nominalByFamily,
  };
}

/**
 * Rewrite the designations through the boot restore's `storedKey → effectiveUid` map.
 *
 * The restore re-keys any record whose uid the current algorithm computes differently — a
 * changed hash, or a metadata key promoted out of `extra` — and the registry names tables by
 * uid, so a rewrite that missed this would turn a valid designation into stale state naming a
 * key nothing holds. The stored ORDER needs no equivalent pass: it is recomputed from the live
 * bench on every save, and the restore already ranks a record by either spelling of its key.
 *
 * A uid that is not in the map is left alone, including one whose table never came back: that
 * is an unresolved designation, which the family reports as such.
 */
export function migrateNominals(
  nominalByFamily: Readonly<Record<string, string>>,
  rekey: ReadonlyMap<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(nominalByFamily).map(([f, u]) => [f, rekey.get(u) ?? u]),
  );
}
