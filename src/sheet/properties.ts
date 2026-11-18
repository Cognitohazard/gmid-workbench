// Which device property each formula of a sheet leans on, and how hard. For each sized device and
// each small-signal property its table holds (SMALL_SIGNAL_KEYS), the property is taken 1 % larger
// and 1 % smaller with everything else held — the sizing, every voltage and current, every solved
// value — and each named result and each requirement's left side is read again. The sheet is not
// sized or solved again, so this is a reading of the sheet's formulas, not of the hardware: a real
// change of gds moves the operating point, and that is not in these numbers. Pure, deterministic,
// never throws.

import { createEngine } from '../expr';
import { DERIVED_FORMS } from '../derive';
import { SMALL_SIGNAL_KEYS } from '../namespace';
import type { DeviceTable } from '../types';
import { evaluateSheet, operatingPointOf, type DeviceResolver } from './eval';
import { namedResults } from './sensitivity';
import type { Settings } from './settings';
import {
  childPath,
  devicesIn,
  engineSolved,
  OWN_DEVICE,
  outsideIn,
  outsideMessage,
  solvedValuesIn,
  stands,
  treeCheckResults,
  withoutRange,
  type SheetDoc,
  type SheetBlockReport,
  type SheetResult,
} from './types';
import { resolvedSheet, type SheetRefIndex } from './resolve';
import { solvedRelation, validateSheet } from './validate';

/** The factor a property is moved by each way: 1 % up, and down by the same ratio. */
export const PROPERTY_FACTOR = 1.01;

export interface PropertyOptions {
  refs?: SheetRefIndex;
  settings?: Settings;
}

/** One cell: the relative change of a row for a 1 % larger property — 1 meaning 1 % for 1 % — or
 *  the reason there is none. Exactly 0 means the row's formula does not read the property. */
export interface PropertyCell {
  relPerPct?: number;
  why?: string;
}

/** One column: one small-signal property of one device (`device` as findings name it, see
 *  devicesIn), and how each row moves with it. `error` says why the column has no cells. */
export interface PropertyColumn {
  device: string;
  key: string;
  /** The property at the design, where the sheet reads it as a value; absent otherwise. */
  base?: number;
  /** How many places one sizing of this device stands in, where its block places it more than once
   *  (a matched pair written once, see SheetNodes): the property moves in all of them together, so
   *  the column cannot answer for one side of the pair. */
  placements?: number;
  results: ({ name: string } & PropertyCell)[];
  /** A requirement's cell is for its left side, or for its right side (`side: 'right'`) where only
   *  that side moves with the property. */
  checks: ({ id: string; side?: 'right' } & PropertyCell)[];
  error?: string;
}

/** The device-property view of one sheet. `rows` names the results and requirement left sides
 *  the columns give cells for; `refused` the rows that would mislead, each with why. `solvedReads`
 *  lists each solved value whose own relation reads a small-signal property: held here, it would
 *  move with the property in the hardware, so on such a sheet every row is a reading of a formula
 *  alone, and the whole view says so. `error` says why there is no view at all. */
export interface PropertySensitivities {
  columns: PropertyColumn[];
  rows: { results: string[]; checks: string[] };
  refused: { name: string; why: string }[];
  solvedReads: string[];
  error?: string;
}

/**
 * How each named result and each requirement's left side moves when one small-signal property of
 * one device is 1 % larger, for every sized device and every such property its table holds: a
 * central difference of two evaluations with the property `PROPERTY_FACTOR` times larger and
 * smaller, every solved value of the design pinned (EvaluateOptions.pinned) so nothing is searched
 * again. Two evaluations per column on top of the base one; an on-demand readout.
 *
 * One sizing placed twice is one device here: its property moves in both placements together, so
 * the view cannot answer for one side of a pair.
 */
export function devicePropertySensitivities(
  doc: SheetDoc,
  table?: DeviceTable,
  resolveDevice?: DeviceResolver,
  opts: PropertyOptions = {},
): PropertySensitivities {
  const empty = (error: string): PropertySensitivities => ({
    columns: [],
    rows: { results: [], checks: [] },
    refused: [],
    solvedReads: [],
    error,
  });
  const r = resolvedSheet(doc, opts.refs);
  if (
    r.warnings.some((w) => w.severity === 'error') ||
    validateSheet(r.doc).some((w) => w.severity === 'error')
  )
    return empty('The sheet does not validate, so it has no formulas to read.');
  const probeDoc = withoutRange(r.doc);
  const settings = opts.settings;
  const base = evaluateSheet(probeDoc, table, resolveDevice, { settings, operatingPoint: true });
  const baseOutside = outsideIn(base);
  if (baseOutside.length)
    return empty(
      `The sheet reads a device beyond its table at its own values (${baseOutside.map(outsideMessage).join('; ')}).`,
    );
  if (!stands(base)) return empty('The sheet does not evaluate at its own values.');
  const pinned = solvedValuesIn(r.doc, base);

  // Rows. The solved values are held, so they cannot move; a requirement whose two sides no
  // property moves is a requirement on voltages or regions, refused below once the probes show it.
  const refused: { name: string; why: string }[] = [];
  const results: string[] = [];
  for (const { name } of namedResults(r.doc, base)) {
    const p = r.doc.params.find((q) => q.name === name);
    if (p && engineSolved(p))
      refused.push({
        name,
        why: `${name} is a solved value, which this view holds; it does not show how it moves.`,
      });
    else results.push(name);
  }
  const baseChecks = treeCheckResults(base);
  const checkIds = [...baseChecks.keys()];

  const columns: PropertyColumn[] = [];
  const moved = new Set<string>();
  for (const { device, point, placements } of sizedDevices(r.doc, base)) {
    const placed = placements > 1 ? { placements } : {};
    for (const key of SMALL_SIGNAL_KEYS) {
      if (!(key in point)) {
        columns.push({
          device,
          key,
          ...placed,
          results: [],
          checks: [],
          error: `The table of ${deviceWords(device)} holds no ${key} column.`,
        });
        continue;
      }
      const at = (factor: number): SheetResult =>
        evaluateSheet(probeDoc, table, resolveDevice, {
          settings,
          pinned,
          perturb: { device, key, factor },
        });
      const up = at(PROPERTY_FACTOR);
      const down = at(1 / PROPERTY_FACTOR);
      const span = PROPERTY_FACTOR - 1 / PROPERTY_FACTOR;
      if (!stands(up) || !stands(down)) {
        columns.push({
          device,
          key,
          ...placed,
          results: [],
          checks: [],
          error: `The sheet does not evaluate with ${key} of ${deviceWords(device)} moved.`,
        });
        continue;
      }
      // A perturbation that did not reach the device would read as "does not read" everywhere:
      // the column is taken only where both runs' sizing of this device says it moved this key.
      const movedIn = (res: SheetResult): boolean =>
        devicesIn(res, (z, d) => (d === device && z.perturbed?.key === key ? [true] : [])).length >
        0;
      if (!movedIn(up) || !movedIn(down)) {
        columns.push({
          device,
          key,
          ...placed,
          results: [],
          checks: [],
          error: `${key} of ${deviceWords(device)} could not be moved, so this column is not read.`,
        });
        continue;
      }
      const cell = (v0: number, v1?: number, v2?: number, what = ''): PropertyCell => {
        if (v1 === undefined || v2 === undefined)
          return { why: `${what} has no value with ${key} of ${deviceWords(device)} moved.` };
        if (!Number.isFinite(v0) || v0 === 0)
          return { why: `${what} is zero at the design, so it has no relative change.` };
        return { relPerPct: (v2 === v1 ? 0 : (v1 - v2) / v0) / span };
      };
      const value = (res: SheetResult, name: string): number | undefined =>
        res.withheld?.[name] !== undefined ? undefined : res.values[name];
      const col: PropertyColumn = {
        device,
        key,
        ...placed,
        ...(Number.isFinite(point[key]) ? { base: point[key] } : {}),
        results: results.map((name) => {
          if (base.withheld?.[name] !== undefined || base.values[name] === undefined)
            return { name, why: `${name} is withheld at the design.` };
          return {
            name,
            ...cell(base.values[name], value(up, name), value(down, name), name),
          };
        }),
        checks: [],
      };
      const upChecks = treeCheckResults(up);
      const downChecks = treeCheckResults(down);
      for (const id of checkIds) {
        const c0 = baseChecks.get(id)!;
        const c1 = upChecks.get(id);
        const c2 = downChecks.get(id);
        if (c1 && c2 && (c1.lhsValue !== c0.lhsValue || c1.rhsValue !== c0.rhsValue)) moved.add(id);
        if (c1 && c2 && (c2.lhsValue !== c0.lhsValue || c2.rhsValue !== c0.rhsValue)) moved.add(id);
        // The side that moves: the left, as everywhere else, unless only the right one does.
        const rightOnly =
          c1 !== undefined &&
          c2 !== undefined &&
          c1.lhsValue === c0.lhsValue &&
          c2.lhsValue === c0.lhsValue &&
          (c1.rhsValue !== c0.rhsValue || c2.rhsValue !== c0.rhsValue);
        col.checks.push(
          rightOnly
            ? {
                id,
                side: 'right',
                ...cell(c0.rhsValue, c1.rhsValue, c2.rhsValue, `The right side of ${id}`),
              }
            : { id, ...cell(c0.lhsValue, c1?.lhsValue, c2?.lhsValue, `The left side of ${id}`) },
        );
      }
      columns.push(col);
    }
  }
  // A requirement no property moves, on either side, reads none: a requirement on voltages or
  // regions. A 0 there would say the hardware does not care, so the row is refused.
  const checks: string[] = [];
  for (const id of checkIds) {
    if (moved.has(id)) checks.push(id);
    else
      refused.push({
        name: id,
        why: `${id} reads no small-signal property; it is a requirement on voltages or regions, and a 0 here would say the hardware does not care.`,
      });
  }
  for (const c of columns) c.checks = c.checks.filter((k) => moved.has(k.id));
  return { columns, rows: { results, checks }, refused, solvedReads: solvedReads(r.doc) };
}

/** A device path as a sentence names it: the sheet's own device, or a block by its path. */
export const deviceWords = (device: string): string =>
  device === OWN_DEVICE ? 'the sheet’s own device' : device;

/** Every device the base run sized, by path as findings name it, with its operating point (the
 *  quantities its table gave, see operatingPointOf) and how many places its block puts it. */
function sizedDevices(
  doc: SheetDoc,
  base: SheetResult,
): { device: string; point: Record<string, number>; placements: number }[] {
  const out: { device: string; point: Record<string, number>; placements: number }[] = [];
  if (base.sizing?.ok)
    out.push({
      device: OWN_DEVICE,
      point: operatingPointOf(base.values, base.sizing),
      placements: 1,
    });
  const walk = (
    d: SheetDoc | undefined,
    reports: readonly SheetBlockReport[] | undefined,
    path: string,
  ): void => {
    for (const rep of reports ?? []) {
      const block = d?.blocks?.find((b) => b.name === rep.name);
      const at = childPath(path, rep.name);
      if (rep.sizing?.ok && rep.point)
        out.push({
          device: at,
          point: rep.point,
          placements: Array.isArray(block?.nodes) ? block.nodes.length : 1,
        });
      walk(block?.doc, rep.blocks, at);
    }
  };
  walk(doc, base.blocks, '');
  return out;
}

/** An engine with no constants, for the names an expression reads. */
const NAMES = createEngine({});

/** The names one expression reads, or none where it does not parse. */
function namesOf(expr: string): readonly string[] {
  try {
    return NAMES.compile(expr).names;
  } catch {
    return [];
  }
}

/** The device quantities that read a small-signal property: the properties themselves and every
 *  derived quantity any of whose forms reads one, directly or through another. */
const SMALL_SIGNAL_READERS: ReadonlySet<string> = (() => {
  const out = new Set(SMALL_SIGNAL_KEYS);
  for (let grew = true; grew;) {
    grew = false;
    for (const [key, forms] of DERIVED_FORMS)
      if (!out.has(key) && forms.some((f) => f.compiled.names.some((n) => out.has(n)))) {
        out.add(key);
        grew = true;
      }
  }
  return out;
})();

/**
 * Each solved value anywhere in the tree whose own relation reads a small-signal property — a
 * device's directly, or through the sheet's equations, or through a block's provided value — by
 * path (`amp.L_x`). Held in this view, such a value would move with the property in the hardware.
 */
export function solvedReads(doc: SheetDoc, path = ''): string[] {
  const out: string[] = [];
  const reads = (d: SheetDoc, name: string, seen: Set<string>): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    if (SMALL_SIGNAL_READERS.has(name)) return true;
    const eq = d.equations?.find((e) => e.name === name);
    if (eq) return namesOf(eq.expr).some((n) => reads(d, n, seen));
    const sep = name.indexOf('__');
    if (sep > 0) {
      const child = d.blocks?.find((b) => b.name === name.slice(0, sep))?.doc;
      if (child) return reads(child, name.slice(sep + 2), new Set());
    }
    return false;
  };
  for (const p of doc.params) {
    if (!engineSolved(p)) continue;
    const rel = solvedRelation(p);
    if (!rel) continue;
    const seen = new Set<string>();
    if ([...namesOf(rel.lhs), ...namesOf(rel.rhs)].some((n) => reads(doc, n, seen)))
      out.push(childPath(path, p.name));
  }
  for (const b of doc.blocks ?? [])
    if (b.doc) out.push(...solvedReads(b.doc, childPath(path, b.name)));
  return out;
}
