// Migrating a sheet written before the netlist — a top sheet and the sheets it includes by
// reference — to format version 2 in one step: each document loaded as the app loads it (earlier
// key spellings brought up to the current ones at every level), the references resolved, the
// wiring drafted across the whole tree (see propose.ts), and the result written back as one
// document per file, so a by-reference child stays a file of its own. What the draft cannot know is
// listed for the author to confirm: the range each solved param is searched in, the class of each
// voltage the sizing rests on, every wire the draft inferred or invented, and whatever validation
// still finds. Nothing here evaluates the design: the wiring is read from the givens, never fed
// back, so the migrated tree sizes exactly as the earlier one did. Pure; zero DOM.

import { compileExpr } from '../derive';
import { scalarScope } from '../expr';
import { sanitizeSheet } from './load';
import {
  applyWiringProposal,
  formatWiringProposal,
  proposeWiring,
  type WiringProposal,
} from './propose';
import { buildSheetRefIndex, resolvedSheet, type SheetRefEntry } from './resolve';
import { childPath, cloneDoc, engineSolved, holds, type SheetDoc } from './types';
import { dcInputs, validateSheet } from './validate';

/** One document a migration reads: its library id (`folder/name`, no extension — what a `ref`
 *  names) and its parsed JSON, untrusted. */
export interface MigrationSource {
  path: string;
  raw: unknown;
}

/** One document a migration writes: the id it was read under, its format-version-2 copy, and
 *  whether the migration changed it — a child sized as one device and wired by the block that
 *  composes it can stay as it was. */
export interface MigratedDocument {
  path: string;
  doc: SheetDoc;
  changed: boolean;
}

/** A solved or held param that had no range to be searched in, and what the migration did. */
export interface RangeNeed {
  /** The block path of the sheet that declares it (`''` for the top). */
  at: string;
  param: string;
  /** The range written into the copy, where the param is a voltage and the tree holds levels to
   *  bound it by; absent where the author has to state one. */
  written?: [number, number];
}

export interface Migration {
  /** Why nothing could be migrated, where nothing could. */
  refused?: string;
  /** The top document first, then each by-reference child it reaches, in the order first reached. */
  documents: MigratedDocument[];
  proposal?: WiringProposal;
  ranges: RangeNeed[];
  /** Everything the author should confirm or supply, one line each. */
  confirm: string[];
  /** The whole account, for a person to read. */
  report: string;
}

/** Whether a param carries a finite search range. */
const hasRange = (p: { min?: number; max?: number }): boolean =>
  Number.isFinite(p.min) && Number.isFinite(p.max) && (p.min as number) < (p.max as number);

/** The numeric value of `expr` over `values`, where it has one. */
function valueOf(expr: string, values: Record<string, number>): number | undefined {
  try {
    const v = compileExpr(expr).eval(scalarScope(values));
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The value of every level a tree holds, each read with its sheet's params as its parent sets
 *  them — an override that evaluates over the parent's params, else the stored value. Params only:
 *  nothing is sized, so a level that reads a device quantity is left out. */
function heldValues(doc: SheetDoc, given: Record<string, number> = {}): number[] {
  const values: Record<string, number> = {};
  for (const p of doc.params) values[p.name] = given[p.name] ?? p.value;
  const own = Object.values(doc.levels ?? {}).flatMap((e) => {
    const v = valueOf(e, values);
    return v === undefined ? [] : [v];
  });
  return [
    ...own,
    ...(doc.blocks ?? []).flatMap((b) => {
      if (!b.doc) return [];
      const set: Record<string, number> = {};
      for (const [k, e] of Object.entries(b.params ?? {})) {
        const v = valueOf(e, values);
        if (v !== undefined) set[k] = v;
      }
      return heldValues(b.doc, set);
    }),
  ];
}

/** Every document of a tree with its block path, the top first. */
function docsIn(doc: SheetDoc, at = ''): { at: string; doc: SheetDoc }[] {
  return [
    { at, doc },
    ...(doc.blocks ?? []).flatMap((b) => (b.doc ? docsIn(b.doc, childPath(at, b.name)) : [])),
  ];
}

/**
 * Migrate `top` and the library it includes by reference to format version 2. Each source is
 * loaded the way the app loads a file; `library` holds every document a `ref` may name. Returns
 * the migrated documents — the top and each by-reference child it reaches, each with the path it
 * was read under — and what the author should confirm.
 */
export function migrateSheet(top: MigrationSource, library: readonly MigrationSource[]): Migration {
  const confirm: string[] = [];
  const empty = (refused: string): Migration => ({
    refused,
    documents: [],
    ranges: [],
    confirm: [],
    report: `Could not migrate "${top.path}": ${refused}`,
  });

  // Loading: what each file could not carry over is said, never dropped unsaid.
  const load = (src: MigrationSource): SheetDoc | undefined => {
    const lost: string[] = [];
    const doc = sanitizeSheet(src.raw, 0, lost);
    for (const l of lost) confirm.push(`${src.path}: the loader could not carry "${l}"`);
    return doc;
  };
  const original = load(top);
  if (!original) return empty('it is not a sheet document, or writes one key in two spellings');
  const entries: SheetRefEntry[] = library.flatMap((src) => {
    const doc = load(src);
    if (!doc)
      confirm.push(`${src.path}: not read — not a sheet document, or a key in two spellings`);
    return doc ? [{ path: src.path, doc }] : [];
  });
  const refs = buildSheetRefIndex(entries);
  const resolved = resolvedSheet(original, refs);
  for (const w of resolved.warnings) confirm.push(`${top.path}: ${w.message}`);

  // The draft, across the whole tree at once, so a child's wires can be joined to its parent's.
  const proposal = proposeWiring(resolved.doc);
  const copy = applyWiringProposal(resolved.doc, proposal);

  // Search ranges. A voltage is bounded by the levels the tree holds — every wire lies between the
  // lowest and the highest of them, ground among them — and the wiring's own range is searched
  // after the author's wherever the param is a wire's level, so the span is a safe start; anything
  // else is the author's to state.
  const held = heldValues(copy);
  const span: [number, number] | undefined = held.length
    ? [Math.min(0, ...held), Math.max(0, ...held)]
    : undefined;
  const ranges: RangeNeed[] = [];
  for (const { at, doc } of docsIn(copy))
    for (const p of doc.params) {
      if (!(engineSolved(p) || holds(p)) || hasRange(p)) continue;
      if (p.unit === 'V' && span && span[0] < span[1]) {
        [p.min, p.max] = span;
        ranges.push({ at, param: p.name, written: span });
      } else ranges.push({ at, param: p.name });
    }
  const where = (at: string): string => (at ? `"${at}"` : 'the top sheet');
  for (const r of ranges)
    confirm.push(
      r.written
        ? `${where(r.at)}: solved param "${r.param}" had no range; written as [${r.written[0]}, ${r.written[1]}] V, the span of the levels the sheet holds, ground included — narrow it if you know better`
        : `${where(r.at)}: solved param "${r.param}" needs min and max — the range it is searched in`,
    );

  // Voltages the sizing rests on that say neither independent nor assumed.
  for (const u of dcInputs(copy).unclassified)
    confirm.push(
      `voltage "${u.param}" feeds the sizing of ${u.devices.join(', ')} and carries no class — ` +
        `mark it "independent" or "assumed"`,
    );

  // The draft's own uncertainty.
  for (const d of proposal.devices)
    for (const t of ['d', 'g', 's', 'b'] as const)
      if (d.nodes[t].mark === 'unknown')
        confirm.push(
          `${where(d.at)}: ${d.device === 'givens' ? "the sheet's own device" : `"${d.device}"`} ` +
            `${t} is on a new wire "${d.nodes[t].wire}" — name the wire it is on`,
        );
  for (const m of proposal.portMaps)
    if (m.mark === 'unknown')
      confirm.push(
        `${where(m.at)}: block "${m.block}" port ${m.port} is mapped to a new wire "${m.wire}" — ` +
          `connect it to the wire it is on`,
      );
  const inferred = proposal.devices.reduce(
    (n, d) => n + Object.values(d.nodes).filter((x) => x.mark === 'inferred').length,
    0,
  );
  if (inferred)
    confirm.push(
      `${inferred} terminals were joined by inference — read the draft below and confirm`,
    );

  // What validation still finds once the above is in place, apart from what is listed already.
  for (const w of validateSheet(copy))
    if (w.severity === 'error' && !/needs? finite min < max/.test(w.message))
      confirm.push(`still refused: ${w.message}`);

  // Back to one document per file: each child that was included by reference is written to the
  // file it came from, and its block names it again by reference.
  const pathOf = new Map(entries.map((e) => [e.doc, e.path]));
  const documents: MigratedDocument[] = [{ path: top.path, doc: copy, changed: true }];
  const split = (into: SheetDoc, from: SheetDoc, at: string): void => {
    (into.blocks ?? []).forEach((b, i) => {
      const was = from.blocks?.[i];
      if (!b.doc || !was) return;
      if (was.doc === undefined && was.ref !== undefined) {
        const hit = refs.get(was.ref);
        const source = hit && 'doc' in hit ? hit.doc : undefined;
        const path = (source && pathOf.get(source)) ?? was.ref;
        if (source) split(b.doc, source, childPath(at, b.name));
        const child = b.doc;
        delete b.doc;
        const seen = documents.find((d) => d.path === path);
        if (!seen)
          documents.push({
            path,
            doc: child,
            changed: !source || JSON.stringify(source) !== JSON.stringify(child),
          });
        else if (JSON.stringify(seen.doc) !== JSON.stringify(child))
          confirm.push(
            `${path} is included in more than one place and the draft wired it differently ` +
              `there; the first is written — compare it with the one at ${where(childPath(at, b.name))}`,
          );
      } else if (was.doc) split(b.doc, was.doc, childPath(at, b.name));
    });
  };
  split(copy, original, '');
  for (const d of documents) d.doc = cloneDoc(d.doc);

  const report = [
    `Migration of "${top.path}" to format version 2`,
    '',
    'Documents written:',
    ...documents.map((d) => `  ${d.path}${d.changed ? '' : ' (unchanged)'}`),
    '',
    confirm.length ? 'To confirm or supply:' : 'Nothing to confirm beyond the draft below.',
    ...confirm.map((c) => `  - ${c}`),
    '',
    formatWiringProposal(proposal),
  ].join('\n');
  return { documents, proposal, ranges, confirm, report };
}
