// Dashboard model: a set of tabs, each a grid of panels. A panel is a single
// cross-plot — Y vs X (both expressions over the device lookup tables), one curve
// per family value, at the shared operating-point bias. The canonical preset is the
// classic gm/ID design set, auto-built for whatever device loads.
import { plottableQuantities, metaScalars, type DeviceTable } from '@gmid/mostab-core';

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
  xExpr: string; // X axis as an expression (the gm/ID view uses 'gm_id')
  yExpr: string; // Y axis as an expression / derived-quantity name
  family: string; // axis whose values fan into curves; '' = a single curve
  render: 'chart' | 'table';
  legend?: LegendConfig; // dense-family display; absent ⇒ colorbar
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
  }));
  return { id: uid(), name: 'Overview', cols: 2, panels };
}

/** A fresh dashboard around a device: the canonical tab, swept over VGS. */
export function presetDashboard(dev: DeviceTable): Dashboard {
  return { tabs: [presetTab(dev)], activeTab: 0, sweep: SWEEP_AXIS };
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
      panels.push({
        id: str(pp.id, uid()),
        xExpr: pp.xExpr,
        yExpr: pp.yExpr,
        family: typeof pp.family === 'string' && axes.has(pp.family) ? pp.family : '',
        render: pp.render === 'table' ? 'table' : 'chart',
        ...(legend ? { legend } : {}),
      });
    }
    const cols = tt.cols;
    tabs.push({
      id: str(tt.id, uid()),
      name: str(tt.name, 'Tab'),
      cols: typeof cols === 'number' && cols >= 1 && cols <= 4 ? Math.floor(cols) : 2,
      panels,
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
