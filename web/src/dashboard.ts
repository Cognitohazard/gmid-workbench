// Dashboard model: a set of tabs, each a grid of panels. A panel is a single
// cross-plot — Y vs X (both expressions over the device lookup tables), one curve
// per family value, at the shared operating-point bias. The canonical preset is the
// classic gm/ID design set, auto-built for whatever device loads.
import {
  plottableQuantities,
  metaScalars,
  fixTable,
  EXAMPLES,
  RULE_KINDS,
  RULE_OPS,
  type DeviceTable,
  type SheetDoc,
  type SheetVar,
  type SheetRow,
  type SheetRule,
  type SheetBind,
  type SheetUse,
  type RuleKind,
  type RuleOp,
} from '@gmid/mostab-core';

// Canonical axis names the core's import seam guarantees (the `axis: true` base
// quantities in src/namespace.ts: vgs/l/vds/vsb). The gm/ID methodology sweeps VGS and
// fans channel length L, so these are the workflow defaults (default sweep, default
// family, the sizer's [L × VGS] binding). Kept in one place rather than scattered.
export const SWEEP_AXIS = 'vgs';
export const LENGTH_AXIS = 'l';
/** Default X for a canonical panel: the gm/ID efficiency coordinate. */
export const GM_ID = 'gm_id';

/** Clamp a sampled-legend curve count to the UI's [2, 32] range; non-finite ⇒ default 8.
 *  Single source of truth for the bound, shared by the panel input and the save sanitizer. */
export function clampLegendCount(n: number): number {
  return Number.isFinite(n) ? Math.min(32, Math.max(2, Math.floor(n))) : 8;
}

/**
 * The non-(l, vgs) axes pinned for sizing, each fixed at the dashboard's shared-bias value being
 * viewed (so you size at the operating point on screen) else a mid node. sizeDevice/lookupByGmId
 * need an [l × vgs] table, so the caller collapses these axes (via fixTable) before sizing. One
 * home for this policy, shared by the sizer and every design-sheet panel.
 */
export function sizingBias(device: DeviceTable, sharedBias: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of device.grid.axes) {
    if (a.name === LENGTH_AXIS || a.name === SWEEP_AXIS) continue;
    out[a.name] = a.name in sharedBias ? sharedBias[a.name] : a.values[Math.floor(a.values.length / 2)];
  }
  return out;
}

/** Collapse a table's non-(l, vgs) axes to the shared bias point, yielding the [l × vgs] slice a
 *  sheet sizes on (lookupByGmId brackets gm/ID along vgs and cannot with extra live axes). The one
 *  home for the sizing reduction — the App sizer, sheet panels, and resolved child devices all use it. */
export function reduceForSizing(device: DeviceTable, sharedBias: Record<string, number>): DeviceTable {
  const fixed = sizingBias(device, sharedBias);
  return Object.keys(fixed).length ? fixTable(device, fixed) : device;
}

/** A loaded device's display identity — `device · corner · temp°C`. Human-readable but NOT
 *  unique (two metadata-less or same-corner imports can collide), so it is for DISPLAY only. */
export function deviceKey(t: DeviceTable): string {
  return `${t.id.device} · ${t.id.corner} · ${t.id.temp}°C`;
}

/**
 * A content-stable, collision-resistant unique id for a loaded table: the display label plus a
 * short FNV-1a hash of the table's identity, geometry, and per-column sentinels. This is the
 * resolver / persisted `use.device` key (the label is only for display). Two imports of the SAME
 * file get the same uid (so a persisted child→device binding survives a re-import); two DIFFERENT
 * tables that happen to share a label get DISTINCT uids (so each is individually selectable and
 * the resolver targets the right one — fixing the non-unique-label ambiguity). Hash collisions
 * between genuinely different tables are negligible and would only degrade to a first-match, never
 * a crash.
 */
export function tableUid(t: DeviceTable): string {
  let h = 0x811c9dc5;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(`${t.id.device}|${t.id.corner}|${t.id.temp}|${t.meta.W ?? ''}`);
  for (const a of t.grid.axes) mix(`${a.name}:${a.values.length}:${a.values[0]}:${a.values[a.values.length - 1]}`);
  for (const [k, col] of t.grid.quantities) mix(`${k}:${col.length}:${col[0]}:${col[col.length >> 1]}:${col[col.length - 1]}`);
  return `${deviceKey(t)}#${(h >>> 0).toString(36)}`;
}

/**
 * How a panel renders a MANY-valued family (small families always use the discrete
 * palette + per-curve legend). Absent ⇒ colorbar. `include` is a list of family VALUES
 * to always keep when sampling (snapped to the nearest node, so it survives device swaps).
 */
export interface LegendConfig {
  mode: 'colorbar' | 'sample';
  count: number; // sample: how many curves to draw
  include: number[]; // sample: family values to always include
}

export interface Panel {
  id: string;
  xExpr: string; // X axis as an expression (the gm/ID view uses 'gm_id'); '' on a sheet panel
  yExpr: string; // Y axis as an expression / derived-quantity name; '' on a sheet panel
  family: string; // axis whose values fan into curves; '' = a single curve
  render: 'chart' | 'table' | 'sheet';
  legend?: LegendConfig; // dense-family display; absent ⇒ colorbar
  sheet?: SheetDoc; // render === 'sheet': the authored leaf design-sheet, stored verbatim
  sheetSweep?: string; // render === 'sheet': the param the feasibility view sweeps; '' = card only
  auto?: boolean; // an auto-generated canonical panel — regenerated per device on a swap, not
  // user-authored; absent on every panel the user adds, so user work survives a device swap.
}

/** A named starting point for a panel, so the user picks a canonical plot instead of
 *  typing expressions. `family` absent ⇒ the device's default family (L when present). */
export interface PanelTemplate {
  name: string;
  xExpr: string;
  yExpr: string;
  family?: string;
}

// The canonical plots offered in the "add panel" menu: the gm/ID design FOMs (X = gm/ID,
// fan L) followed by the classic device characteristic curves (swept over VGS / ID). The
// gm/ID subset (xExpr === GM_ID) doubles as the freshly-loaded "Overview" preset, so there
// is one source of truth for "the canonical charts".
export const TEMPLATES: readonly PanelTemplate[] = [
  { name: 'I_D/W vs gm/ID', xExpr: GM_ID, yExpr: 'id_w' },
  { name: 'f_T vs gm/ID', xExpr: GM_ID, yExpr: 'ft' },
  { name: 'gain (gm/g_ds) vs gm/ID', xExpr: GM_ID, yExpr: 'gm_gds' },
  { name: 'V* vs gm/ID', xExpr: GM_ID, yExpr: 'vstar' },
  { name: 'noise (v_n,th) vs gm/ID', xExpr: GM_ID, yExpr: 'vnth_m' },
  { name: 'I_D vs V_GS', xExpr: SWEEP_AXIS, yExpr: 'id' },
  { name: 'g_m vs V_GS', xExpr: SWEEP_AXIS, yExpr: 'gm' },
  { name: 'gm/ID vs V_GS', xExpr: SWEEP_AXIS, yExpr: GM_ID },
  { name: 'f_T vs I_D', xExpr: 'id', yExpr: 'ft' },
];

// The gm/ID design set, in preset order — the Overview tab is exactly these (filtered to
// what the device can compute). Derived from TEMPLATES so the menu and the preset agree.
const CANON_TEMPLATES = TEMPLATES.filter((t) => t.xExpr === GM_ID);

/** A template is plottable when BOTH its axes resolve for a device. `resolvable` is the set of
 *  quantity keys plottableQuantities reports (base ∪ derived) for that device + sweep. One rule
 *  behind both the Overview preset and the "+ panel" template menu, so they never diverge. */
export function canPlot(t: PanelTemplate, resolvable: Set<string>): boolean {
  return resolvable.has(t.xExpr) && resolvable.has(t.yExpr);
}

export interface Tab {
  id: string;
  name: string;
  cols: number; // CSS-grid column count
  panels: Panel[];
  auto?: boolean; // the canonical Overview tab — located by this marker (not by index) so a device
  // swap re-seeds its auto panels wherever it sits, and never if the user has deleted it.
}

export interface Dashboard {
  tabs: Tab[];
  activeTab: number;
  sweep: string; // bias axis parameterizing every panel's curves (default 'vgs')
}

const uid = (): string => crypto.randomUUID();

/** Coerce an untrusted saved legend config, or undefined (⇒ default colorbar). */
function sanitizeLegend(v: unknown): LegendConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  // clamp to the UI's [2, 32], never 1 (a count of 1 would make subsample divide by zero)
  const count = clampLegendCount(typeof o.count === 'number' ? o.count : NaN);
  const include = Array.isArray(o.include)
    ? o.include.filter((x): x is number => Number.isFinite(x)).slice(0, 32)
    : [];
  return { mode: o.mode === 'sample' ? 'sample' : 'colorbar', count, include };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Coerce an untrusted saved leaf design-sheet (e.g. from localStorage) into a valid
 * SheetDoc, dropping malformed entries but keeping every author expression verbatim —
 * an unresolvable one surfaces as a per-rule 'na' chip at evaluation, never a silent
 * drop. A bind is kept only when well-formed (L + exactly two of {gm,gm_id,id}); else
 * it is dropped and its rules go 'na'. Returns undefined only when `v` is not an object.
 */
function sanitizeSheet(v: unknown): SheetDoc | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const str = (x: unknown, fallback: string) => (typeof x === 'string' && x ? x : fallback);

  const params: SheetVar[] = Array.isArray(o.params)
    ? o.params.flatMap((p) => {
        if (!p || typeof p !== 'object') return [];
        const pp = p as Record<string, unknown>;
        if (typeof pp.name !== 'string' || !finite(pp.value)) return [];
        const out: SheetVar = { name: pp.name, value: pp.value };
        if (finite(pp.min)) out.min = pp.min;
        if (finite(pp.max)) out.max = pp.max;
        if (typeof pp.unit === 'string') out.unit = pp.unit;
        return [out];
      })
    : [];

  const rows: SheetRow[] = Array.isArray(o.rows)
    ? o.rows.flatMap((r) => {
        if (!r || typeof r !== 'object') return [];
        const rr = r as Record<string, unknown>;
        if (typeof rr.name !== 'string' || typeof rr.expr !== 'string') return [];
        const out: SheetRow = { name: rr.name, expr: rr.expr };
        if (typeof rr.unit === 'string') out.unit = rr.unit;
        return [out];
      })
    : [];

  const rules: SheetRule[] = Array.isArray(o.rules)
    ? o.rules.flatMap((r) => {
        if (!r || typeof r !== 'object') return [];
        const rr = r as Record<string, unknown>;
        if (typeof rr.lhs !== 'string' || typeof rr.rhs !== 'string') return [];
        if (!RULE_OPS.has(rr.op as string) || !RULE_KINDS.has(rr.kind as string)) return [];
        const out: SheetRule = {
          id: str(rr.id, uid()),
          kind: rr.kind as RuleKind,
          lhs: rr.lhs,
          op: rr.op as RuleOp,
          rhs: rr.rhs,
        };
        if (finite(rr.tolPct)) out.tolPct = rr.tolPct;
        if (typeof rr.justification === 'string') out.justification = rr.justification;
        return [out];
      })
    : [];

  let bind: SheetBind | undefined;
  if (o.bind && typeof o.bind === 'object') {
    const b = o.bind as Record<string, unknown>;
    if (typeof b.L === 'string') {
      const cand: SheetBind = { L: b.L };
      for (const k of ['gm', 'gm_id', 'id'] as const) if (typeof b[k] === 'string') cand[k] = b[k] as string;
      const n = (['gm', 'gm_id', 'id'] as const).filter((k) => cand[k] !== undefined).length;
      if (n === 2) bind = cand;
    }
  }

  // Composition: each child is a full SheetDoc recursively sanitized; the param-override map,
  // the provide list, and the per-child `device` (a table uid the resolver matches against the
  // loaded devices) are kept verbatim so a composed sheet round-trips intact. A persisted device
  // that is not currently loaded simply reads infeasible until re-loaded.
  const uses: SheetUse[] = Array.isArray(o.uses)
    ? o.uses.flatMap((u) => {
        if (!u || typeof u !== 'object') return [];
        const uu = u as Record<string, unknown>;
        if (typeof uu.name !== 'string' || !uu.name) return [];
        const childDoc = sanitizeSheet(uu.doc);
        if (!childDoc) return [];
        const use: SheetUse = { name: uu.name, doc: childDoc };
        if (typeof uu.device === 'string') use.device = uu.device;
        if (uu.params && typeof uu.params === 'object' && !Array.isArray(uu.params)) {
          const ov: Record<string, string> = {};
          for (const [k, val] of Object.entries(uu.params as Record<string, unknown>)) {
            if (typeof val === 'string') ov[k] = val;
          }
          if (Object.keys(ov).length) use.params = ov;
        }
        return [use];
      })
    : [];

  const provide: string[] = Array.isArray(o.provide)
    ? o.provide.filter((x): x is string => typeof x === 'string')
    : [];

  return {
    title: str(o.title, 'Sheet'),
    polarity: o.polarity === 'p' ? 'p' : 'n',
    params,
    rows,
    rules,
    ...(bind ? { bind } : {}),
    ...(uses.length ? { uses } : {}),
    ...(provide.length ? { provide } : {}),
  };
}

/**
 * The default "Overview" tab for a freshly loaded device: one panel per canonical gm/ID
 * design chart the table can actually compute (filtered by plottableQuantities, with the
 * metadata width scalar so id/w counts), family = L when the table sweeps length.
 */
export function presetTab(dev: DeviceTable): Tab {
  const ok = plottableQuantities(dev.grid, SWEEP_AXIS, Object.keys(metaScalars(dev.meta)));
  const resolvable = new Set([...ok.base, ...ok.derived]);
  const fam = dev.grid.axes.some((a) => a.name === LENGTH_AXIS && a.values.length > 1)
    ? LENGTH_AXIS
    : '';
  const panels: Panel[] = CANON_TEMPLATES.filter((t) => canPlot(t, resolvable)).map((t) => ({
    id: uid(),
    xExpr: t.xExpr,
    yExpr: t.yExpr,
    family: fam,
    render: 'chart',
    auto: true, // device-derived; regenerated on a swap (see reseatDashboard)
  }));
  return { id: uid(), name: 'Overview', cols: 2, panels, auto: true };
}

/** A fresh dashboard around a device: the canonical tab, swept over VGS. */
export function presetDashboard(dev: DeviceTable): Dashboard {
  return { tabs: [presetTab(dev)], activeTab: 0, sweep: SWEEP_AXIS };
}

/**
 * Carry a live layout onto a newly active device. Only the auto-generated canonical panels are
 * device-specific, so they are regenerated for the new device; every user-authored panel (a
 * panel the user added, or a canonical one they edited, which clears its `auto` marker) and tab
 * is preserved and re-validated against it (families it lacks relax to a single curve, design
 * sheets kept verbatim). This is what lets a device swap keep the user's work instead of wiping
 * it. The Overview tab is found by its `auto` marker, not by position, so it re-seeds wherever it
 * sits — and not at all if the user has deleted it (their choice is respected).
 */
export function reseatDashboard(dash: Dashboard, dev: DeviceTable): Dashboard {
  const san = sanitizeDashboard(dash, dev);
  if (!san) return presetDashboard(dev);
  const fresh = presetTab(dev).panels;
  san.tabs = san.tabs.map((t) =>
    t.auto ? { ...t, panels: [...fresh, ...t.panels.filter((p) => !p.auto)] } : t,
  );
  return san;
}

/**
 * Coerce an untrusted parsed object (e.g. a saved layout from localStorage) into a
 * valid Dashboard for `dev`, or null if it isn't salvageable (caller falls back to
 * the preset). Families absent on the device drop to '' (single curve); cols clamp to
 * 1..4; ids/render/sweep/activeTab are normalized. Expressions are kept verbatim — an
 * unresolvable one surfaces as a per-panel error, never a silent drop of the user's work.
 */
export function sanitizeDashboard(d: unknown, dev: DeviceTable): Dashboard | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (!Array.isArray(o.tabs)) return null;
  const axes = new Set(dev.grid.axes.filter((a) => a.values.length > 1).map((a) => a.name));
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);
  const tabs: Tab[] = [];
  for (const t of o.tabs) {
    if (!t || typeof t !== 'object' || !Array.isArray((t as Record<string, unknown>).panels)) continue;
    const tt = t as Record<string, unknown>;
    const panels: Panel[] = [];
    for (const p of tt.panels as unknown[]) {
      if (!p || typeof p !== 'object') continue;
      const pp = p as Record<string, unknown>;
      if (typeof pp.xExpr !== 'string' || typeof pp.yExpr !== 'string') continue;
      const legend = sanitizeLegend(pp.legend);
      const render = pp.render === 'table' ? 'table' : pp.render === 'sheet' ? 'sheet' : 'chart';
      // A sheet panel always carries a valid doc so it can render; a corrupt one falls
      // back to the first vetted example rather than dropping the panel.
      const sheet = render === 'sheet' ? (sanitizeSheet(pp.sheet) ?? EXAMPLES[0]) : undefined;
      const sheetSweep = render === 'sheet' && typeof pp.sheetSweep === 'string' ? pp.sheetSweep : undefined;
      panels.push({
        id: str(pp.id, uid()),
        xExpr: pp.xExpr,
        yExpr: pp.yExpr,
        family: typeof pp.family === 'string' && axes.has(pp.family) ? pp.family : '',
        render,
        ...(legend ? { legend } : {}),
        ...(sheet ? { sheet } : {}),
        ...(sheetSweep ? { sheetSweep } : {}),
        ...(pp.auto === true ? { auto: true } : {}),
      });
    }
    const cols = tt.cols;
    tabs.push({
      id: str(tt.id, uid()),
      name: str(tt.name, 'Tab'),
      cols: typeof cols === 'number' && cols >= 1 && cols <= 4 ? Math.floor(cols) : 2,
      panels,
      ...(tt.auto === true ? { auto: true } : {}),
    });
  }
  if (tabs.length === 0) return null;
  const at = o.activeTab;
  return {
    tabs,
    activeTab: typeof at === 'number' && at >= 0 && at < tabs.length ? Math.floor(at) : 0,
    sweep: typeof o.sweep === 'string' && axes.has(o.sweep) ? o.sweep : SWEEP_AXIS,
  };
}
