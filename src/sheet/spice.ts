// The sized netlist: one evaluated sheet read back as a circuit a simulator can be given — every
// sized device as instances on named wires with its width, length and channel type, every element
// with its value, every held level, the top sheet's ports with the level the sheet assigns them, and
// the figures the sheet reports, by their sheet names, to compare with what the simulator prints.
//
// It reads a document and its finished result and nothing else: no table, no evaluation, no
// solve. Wires are named the way the DC wiring walk names them (see docs/sheet-format.md,
// "Naming the wires"): a child that wires itself joins the top sheet's namespace through its port
// map, every other wire of it is spelt `block__wire`, and `gnd` is the same wire everywhere. Pure;
// zero DOM.

import { compileExpr } from '../derive';
import { scalarScope } from '../expr';
import { blockWires, flattened, formatOf, placementsOf } from './nodes';
import {
  GROUND,
  MAX_BLOCK_DEPTH,
  childPath,
  isObject,
  providePrefix,
  type DeviceNodes,
  type SheetBlock,
  type SheetBlockReport,
  type SheetDoc,
  type SheetElement,
  type SheetResult,
  type SizingReport,
} from './types';

/** One sized device of the tree, with every placement of it on the top sheet's wires. */
export interface NetlistDevice {
  /** The block path, dots between blocks; `''` for the top sheet's own device. */
  path: string;
  /** The channel type its document states; n where it states none (`polarityAssumed`). */
  polarity: 'n' | 'p';
  polarityAssumed?: true;
  /** The device id its table is bound through (a block's `device`, inherited down the tree);
   *  absent where it is sized on the table the run was given. */
  device?: string;
  /** Whether the sizing stood: a device that did not size has no width to give a simulator. */
  sized: boolean;
  /** Width and length [m]: one placement's, so a list of placements is that many copies. */
  W?: number;
  L?: number;
  /** Its four wires per placement, in the top sheet's namespace. */
  placements: DeviceNodes[];
  /** The operating point the sizing states for one placement: drain current (a magnitude) and
   *  the gate, drain and body biases in the table's axis convention, as sized. */
  point: { id?: number; vgs?: number; vds?: number; vsb?: number };
  /** The scalars the sheet exposes for this device: a child's `provides`, the top device's own
   *  device quantities. */
  quantities: Record<string, number>;
  /** Why it did not size. */
  error?: string;
}

/** An element of the tree on the top sheet's wires. */
export interface NetlistElement {
  /** Unique across the tree: the element's name behind its block prefix (`bias__iref`). */
  name: string;
  kind: SheetElement['kind'];
  /** `[from, to]`: current from→to inside the element; a `V` holds V(from) − V(to) = value. */
  between: [string, string];
  /** Its value in SI units, where it evaluated. */
  value?: number;
  /** As written. */
  expr: number | string;
  /** The instance path of the sheet that draws it (`''` for the top). */
  sheet: string;
}

/** A wire some sheet of the tree holds (`levels`), with the level it is held at. */
export interface NetlistLevel {
  wire: string;
  value?: number;
  expr: string;
  sheet: string;
}

/** One of the figures a sheet reports: an equation or a param, by its sheet name. */
export interface NetlistFigure {
  name: string;
  value?: number;
  /** The equation's expression; absent for a param. */
  expr?: string;
  unit?: string;
  /** A param the engine solves (solveFor, designConstraint), so its value is an answer. */
  solved?: true;
}

/** What the DC wiring walk reported, in brief, beside the netlist it walked. */
export interface NetlistWiring {
  state: string;
  closureError: number;
  floating: string[][];
  tainted: string[];
  /** The current each held wire's source supplies, and each unbalanced wire's residual [A]. */
  balance: { wire: string; residual: number; held: boolean }[];
  findings: number;
}

export interface SizedNetlist {
  title: string;
  /** False for a sheet that is not a circuit (`nodes: "none"`) or names no wiring; such a
   *  netlist carries figures and nothing else. */
  circuit: boolean;
  feasible: boolean;
  devices: NetlistDevice[];
  elements: NetlistElement[];
  levels: NetlistLevel[];
  /** The top sheet's ports: wires something outside the sheet drives, with the level the sheet's
   *  wiring derives for each (absent where the walk gives it none). */
  ports: { wire: string; level?: number }[];
  /** Every wire a device, element, level or port names, with the level the walk reports. */
  wires: Record<string, { level?: number; held: boolean }>;
  /** Every param of the top sheet at its value in this run. */
  params: Record<string, number>;
  /** The top sheet's equations and solved params, in document order. */
  figures: NetlistFigure[];
  wiring?: NetlistWiring;
  /** The run's error-severity warnings, verbatim. */
  errors: string[];
}

/** The device quantities read for the top sheet's own device, where its scope has them. */
const OWN_QUANTITIES = ['id', 'gm', 'gds', 'gmb', 'vgs', 'vdsat', 'cgg', 'vnth_m', 'W', 'L'];

/** An expression in a finished scope; undefined where it does not evaluate to a finite number. */
function evalIn(src: number | string, values: Record<string, number>): number | undefined {
  if (typeof src === 'number') return Number.isFinite(src) ? src : undefined;
  try {
    const v = compileExpr(src).eval(scalarScope(values));
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The finite members of a record. */
const finite = (r: Record<string, number> | undefined): Record<string, number> =>
  Object.fromEntries(Object.entries(r ?? {}).filter(([, v]) => Number.isFinite(v)));

/** One sheet of the tree whose wires the netlist names: the top, or a child that wires itself. */
interface Level {
  doc: SheetDoc;
  chain: SheetBlock[];
  inst: string;
  report: Pick<SheetBlockReport, 'blocks' | 'sizing' | 'wiringValues' | 'provides'> & {
    values?: Record<string, number>;
  };
  rename: (w: string) => string;
  device?: string;
}

/**
 * The sized netlist of `doc` — the document the run evaluated, with every `ref` resolved (pass
 * what `resolveSheetRefs` returns, bound the way the run was) — read from its result `res`.
 */
export function sizedNetlist(doc: SheetDoc, res: SheetResult): SizedNetlist {
  const errors = res.warnings.filter((w) => w.severity === 'error').map((w) => w.message);
  const params = finite(Object.fromEntries(doc.params.map((p) => [p.name, res.values[p.name]])));
  const figures: NetlistFigure[] = [
    ...doc.params
      .filter((p) => p.solveFor !== undefined || p.designConstraint !== undefined)
      .map((p) => ({
        name: p.name,
        ...(Number.isFinite(res.values[p.name]) ? { value: res.values[p.name] } : {}),
        ...(p.unit ? { unit: p.unit } : {}),
        solved: true as const,
      })),
    ...doc.equations.map((e) => ({
      name: e.name,
      ...(Number.isFinite(res.values[e.name]) ? { value: res.values[e.name] } : {}),
      expr: e.expr,
      ...(e.unit ? { unit: e.unit } : {}),
    })),
  ];
  const base = { title: doc.title, feasible: res.feasible, params, figures, errors };
  if (formatOf(doc) !== 2 || doc.nodes === 'none' || !res.nodes)
    return {
      ...base,
      circuit: false,
      devices: [],
      elements: [],
      levels: [],
      ports: [],
      wires: {},
    };

  const devices: NetlistDevice[] = [];
  const elements: NetlistElement[] = [];
  const levels: NetlistLevel[] = [];

  const deviceOf = (
    d: SheetDoc,
    path: string,
    device: string | undefined,
    placements: DeviceNodes[],
    sizing: SizingReport | undefined,
    quantities: Record<string, number>,
  ): void => {
    const ok = sizing?.ok === true;
    devices.push({
      path,
      polarity: d.polarity === 'p' ? 'p' : 'n',
      ...(d.polarity === 'p' || d.polarity === 'n' ? {} : { polarityAssumed: true as const }),
      ...(device !== undefined ? { device } : {}),
      sized: ok,
      ...(ok ? { W: sizing.W, L: sizing.L } : {}),
      placements,
      point: ok
        ? {
            id: sizing.id,
            vgs: sizing.vgs,
            ...(sizing.bias?.vds !== undefined ? { vds: sizing.bias.vds } : {}),
            ...(sizing.bias?.vsb !== undefined ? { vsb: sizing.bias.vsb } : {}),
          }
        : {},
      quantities,
      ...(sizing?.error ? { error: sizing.error } : {}),
    });
  };
  const renamed = (ps: DeviceNodes[], rename: (w: string) => string): DeviceNodes[] =>
    ps.map((n) => ({
      d: rename(n.d),
      g: rename(n.g),
      s: rename(n.s),
      b: rename(n.b),
      ...(n.intent ? { intent: n.intent } : {}),
    }));

  // The walk's levels, top down: each sheet that names wires, with how it names them.
  const visit = (lv: Level, depth: number): void => {
    const { doc: d, report } = lv;
    const values = lv.report.values;
    // The sheet's own device, where it wires it itself (only format version 2 reads `nodes`).
    const own = formatOf(d) === 2 ? placementsOf(d.nodes) : undefined;
    if (d.givens && own)
      deviceOf(
        d,
        lv.inst,
        lv.device,
        renamed(own, lv.rename),
        report.sizing,
        lv.inst === ''
          ? finite(Object.fromEntries(OWN_QUANTITIES.map((k) => [k, values?.[k] as number])))
          : finite(report.provides),
      );
    const wiring = lv.inst === '' ? undefined : report.wiringValues;
    const levelsIn: unknown = d.levels;
    for (const [w, e] of Object.entries(isObject(levelsIn) ? levelsIn : {})) {
      if (typeof e !== 'string') continue;
      const v = values ? evalIn(e, values) : wiring?.levels[w];
      levels.push({
        wire: lv.rename(w),
        ...(v !== undefined ? { value: v } : {}),
        expr: e,
        sheet: lv.inst,
      });
    }
    for (const el of Array.isArray(d.elements) ? d.elements : []) {
      const v = values ? evalIn(el.value, values) : wiring?.elements[el.name];
      elements.push({
        name: `${providePrefix(lv.chain)}${el.name}`,
        kind: el.kind,
        between: [lv.rename(el.between[0]), lv.rename(el.between[1])],
        ...(v !== undefined ? { value: v } : {}),
        expr: el.value,
        sheet: lv.inst,
      });
    }
    if (depth >= MAX_BLOCK_DEPTH) return;
    (Array.isArray(d.blocks) ? d.blocks : []).forEach((b, i) => {
      const kid = b?.doc;
      const kidReport = report.blocks?.[i];
      if (!kid || !kidReport) return;
      const device = b.device ?? lv.device;
      const chain = [...lv.chain, b];
      const inst = childPath(lv.inst, b.name);
      // A child the block wires: its device on the parent's wires.
      const byBlock = placementsOf(blockWires(d, b));
      if (byBlock && kid.givens)
        deviceOf(
          kid,
          inst,
          device,
          renamed(byBlock, lv.rename),
          kidReport.sizing,
          finite(kidReport.provides),
        );
      if (!flattened(kid)) return;
      // A child that wires itself joins the walk through its port map.
      const prefix = providePrefix(chain);
      const declared = new Set(Array.isArray(kid.ports) ? kid.ports : []);
      const map = isObject(b.ports) ? b.ports : {};
      const rename = (w: string): string => {
        if (w === GROUND) return GROUND;
        const to = declared.has(w) ? map[w] : undefined;
        return typeof to === 'string' ? lv.rename(to) : `${prefix}${w}`;
      };
      visit({ doc: kid, chain, inst, report: kidReport, rename, device }, depth + 1);
    });
  };
  visit(
    {
      doc,
      chain: [],
      inst: '',
      report: { ...res, provides: {} },
      rename: (w) => w,
    },
    0,
  );

  const walked = res.nodes.levels;
  const held = new Set(levels.map((l) => l.wire));
  const wires: SizedNetlist['wires'] = {};
  const name = (w: string): void => {
    if (wires[w]) return;
    const lvl = walked[w]?.level;
    wires[w] = { ...(lvl !== undefined ? { level: lvl } : {}), held: held.has(w) || w === GROUND };
  };
  for (const dev of devices) for (const p of dev.placements) [p.d, p.g, p.s, p.b].forEach(name);
  for (const el of elements) el.between.forEach(name);
  for (const l of levels) name(l.wire);
  const ports = (Array.isArray(doc.ports) ? doc.ports : []).map((w) => {
    name(w);
    const lvl = walked[w]?.level;
    return { wire: w, ...(lvl !== undefined ? { level: lvl } : {}) };
  });
  devices.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  return {
    ...base,
    circuit: true,
    devices,
    elements,
    levels,
    ports,
    wires: Object.fromEntries(Object.entries(wires).sort(([x], [y]) => (x < y ? -1 : 1))),
    wiring: {
      state: res.nodes.state,
      closureError: res.nodes.closureError,
      floating: res.nodes.floating,
      tainted: res.nodes.tainted,
      balance: res.nodes.balance.map((b) => ({
        wire: b.wire,
        residual: b.residual,
        held: b.held,
      })),
      findings: res.nodes.findings,
    },
  };
}
