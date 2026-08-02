// By-reference sheet composition: a use may carry `ref` (a library id) instead of an
// embedded `doc`. Resolution is a pure pre-pass that materializes every ref into its
// target doc — validation and evaluation then run on the resolved tree and stay
// ref-unaware except for a fail-closed guard. Fail-closed throughout: a missing,
// ambiguous, cyclic, or too-deep ref surfaces as an error warning and the use is left
// unresolved, which evaluation refuses to size. Zero DOM; the library map is injected.

import type { QAWarning } from '../types';
import { MAX_USE_DEPTH, type SheetDoc, type SheetUse } from './types';

/** One sheet the resolver can hand out: `path` is its library id — `folder/name`, no
 *  extension (curated sheets use their on-disk location; runtime-loaded sheets live
 *  under an implicit `user/` folder). */
export interface SheetRefEntry {
  path: string;
  doc: SheetDoc;
}

/** An index hit: the target doc, or the collision marker naming the qualified
 *  candidates a bare name matched (so the error can say how to disambiguate). */
export type SheetRefHit = { doc: SheetDoc } | { ambiguous: readonly string[] };

/** The ref → sheet lookup `resolveSheetRefs` consults. Keys are full paths plus each
 *  bare filename that is globally unique (folder-qualification is only needed on
 *  collision, mirroring the filesystem guarantee that inspired the scheme). */
export type SheetRefIndex = ReadonlyMap<string, SheetRefHit>;

/**
 * Build the ref index from library entries. Every entry is addressable by its full
 * `folder/name` path; a bare `name` is added as an alias when exactly one entry carries
 * it, and becomes an {ambiguous} marker when several do — never a silent winner. An
 * exact full path always beats a bare alias, and a repeated full path takes the LAST
 * entry (re-importing an updated user sheet replaces the old one).
 */
export function buildSheetRefIndex(entries: readonly SheetRefEntry[]): SheetRefIndex {
  const index = new Map<string, SheetRefHit>();
  for (const e of entries) index.set(e.path, { doc: e.doc });
  const byBare = new Map<string, string[]>();
  for (const e of entries) {
    const bare = e.path.slice(e.path.lastIndexOf('/') + 1);
    if (bare === e.path) continue; // no folder — the full path IS the bare name
    const paths = byBare.get(bare) ?? [];
    if (!paths.includes(e.path)) paths.push(e.path);
    byBare.set(bare, paths);
  }
  for (const [bare, paths] of byBare) {
    if (index.has(bare)) continue; // an exact full path owns this key
    // A full-path key is always a doc hit (ambiguous markers only ever land on bare keys).
    index.set(
      bare,
      paths.length === 1 ? (index.get(paths[0]) as { doc: SheetDoc }) : { ambiguous: paths },
    );
  }
  return index;
}

/** The resolved doc plus every resolution failure (all severity 'error' — an authored
 *  reference that cannot be honored must block feasibility, never degrade silently). */
export interface ResolveResult {
  doc: SheetDoc;
  warnings: QAWarning[];
}

const refError = (where: string, message: string): QAWarning => ({
  rule: 'sheet-ref',
  severity: 'error',
  message: `${where}: ${message}`,
  location: where,
});

/**
 * Ceiling on TOTAL materialized refs per resolution. The chain-depth cap alone bounds
 * only one path: a fan-out DAG (each level's every use referencing the next sheet) is
 * acyclic yet expands as width^depth, so a handful of tiny hostile imports could pin
 * the tab. Any real composition is tens of blocks; past this, resolution stops and the
 * remaining refs stay unresolved (fail closed), with one error naming the ceiling.
 */
export const MAX_REF_EXPANSION = 256;

/**
 * Materialize every `ref` use in `doc` (recursively — a ref target or an embedded child
 * may itself carry refs) against the index. Pure and zero-copy where possible: subtrees
 * without refs are shared, not cloned, so callers that persist the result (flatten,
 * detach) must deep-copy before mutating. A resolved use keeps its `ref` alongside the
 * materialized `doc` as provenance — the UI renders such a child read-only. Failures
 * (missing id, ambiguous bare name, reference cycle, chain deeper than MAX_USE_DEPTH,
 * total expansion past MAX_REF_EXPANSION) push an error warning and leave the use
 * docless, which evaluateSheet fails closed.
 */
export function resolveSheetRefs(doc: SheetDoc, refs: SheetRefIndex): ResolveResult {
  const warnings: QAWarning[] = [];
  return { doc: resolveDoc(doc, refs, [], '', warnings, { left: MAX_REF_EXPANSION }), warnings };
}

/** Materialize refs when an index is supplied; otherwise pass the doc through — the shape every
 *  entrypoint that takes an optional `refs` opens with. The resolver's failures are error
 *  warnings, so an unresolved ref rides the same fail-closed channel as a validation error
 *  wherever this is used. */
export function resolvedSheet(doc: SheetDoc, refs?: SheetRefIndex): ResolveResult {
  return refs ? resolveSheetRefs(doc, refs) : { doc, warnings: [] };
}

function resolveDoc(
  doc: SheetDoc,
  refs: SheetRefIndex,
  chain: readonly string[],
  where: string,
  warnings: QAWarning[],
  budget: { left: number },
): SheetDoc {
  if (!doc.uses?.length) return doc;
  let changed = false;
  const uses = doc.uses.map((use) => {
    const at = `${where}${use.name}`;
    // An embedded doc is authoritative — a use carrying both is an already-resolved (or
    // deliberately pinned) snapshot, and refreshing it here would silently re-size a
    // design behind the author's back. Recurse for refs deeper in the embedded tree.
    if (use.doc) {
      const inner = resolveDoc(use.doc, refs, chain, `${at}.`, warnings, budget);
      if (inner === use.doc) return use;
      changed = true;
      return { ...use, doc: inner };
    }
    if (use.ref === undefined) return use; // neither — validateSheet names this error
    const hit = refs.get(use.ref);
    if (hit === undefined) {
      warnings.push(refError(at, `ref "${use.ref}" does not match any sheet in the library`));
      return use;
    }
    if ('ambiguous' in hit) {
      warnings.push(
        refError(
          at,
          `ref "${use.ref}" is ambiguous — qualify it as one of: ${hit.ambiguous.join(', ')}`,
        ),
      );
      return use;
    }
    if (chain.includes(use.ref)) {
      warnings.push(refError(at, `circular reference: ${[...chain, use.ref].join(' -> ')}`));
      return use;
    }
    if (chain.length >= MAX_USE_DEPTH) {
      warnings.push(refError(at, `reference chain nested deeper than ${MAX_USE_DEPTH}`));
      return use;
    }
    if (budget.left <= 0) {
      // Warn ONCE per resolution — past the ceiling every remaining ref is in the same
      // boat, and one message per node would itself be the flood.
      if (budget.left === 0) {
        warnings.push(
          refError(at, `reference expansion exceeded ${MAX_REF_EXPANSION} blocks — stopping`),
        );
        budget.left = -1;
      }
      return use;
    }
    budget.left -= 1;
    changed = true;
    return {
      ...use,
      doc: resolveDoc(hit.doc, refs, [...chain, use.ref], `${at}.`, warnings, budget),
    };
  });
  return changed ? { ...doc, uses } : doc;
}

/** Strip provenance `ref` fields from a resolved tree, leaving embedded docs only. */
function stripRefs(doc: SheetDoc): SheetDoc {
  if (!doc.uses?.length) return doc;
  return {
    ...doc,
    uses: doc.uses.map((use): SheetUse => {
      if (!use.doc) return use; // unresolved — nothing to inline; the ref is the content
      const { ref: _ref, ...rest } = use;
      return { ...rest, doc: stripRefs(use.doc) };
    }),
  };
}

/**
 * Resolve + strip: the self-contained export shape — every reference inlined as an
 * embedded child, no ref left behind. The frozen-deliverable form: a flattened doc
 * never drifts when a library sheet it once referenced is later edited. Check the
 * returned warnings before persisting — an unresolved use cannot be inlined and keeps
 * its ref.
 */
export function flattenSheetDoc(doc: SheetDoc, refs: SheetRefIndex): ResolveResult {
  const r = resolveSheetRefs(doc, refs);
  return { doc: stripRefs(r.doc), warnings: r.warnings };
}
