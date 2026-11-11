// Dashboard model: a set of tabs, each a grid of panels. A panel is a single
// cross-plot — Y vs X (both expressions over the device lookup tables), one curve
// per family value, at the shared operating-point bias. The canonical preset is the
// classic gm/ID design set, auto-built for whatever device loads.
import {
  plottableQuantities,
  metaScalars,
  fixTable,
  sheetFormat,
  type DeviceTable,
  type SheetDoc,
  conditionKeyId,
  conditionKeyOf,
  type ConditionKey,
  sanitizeSheet as loadSheet,
} from '@gmid/mostab-core';

// Canonical axis names the core's import seam guarantees (the `axis: true` base
// quantities in src/namespace.ts: vgs/l/vds/vsb). The gm/ID methodology sweeps VGS and
// fans channel length L, so these are the workflow defaults (default sweep, default
// family, the sizer's [L × VGS] binding). Kept in one place rather than scattered.
export const SWEEP_AXIS = 'vgs';
export const LENGTH_AXIS = 'l';
export const DRAIN_AXIS = 'vds';
/** Default X for a canonical panel: the gm/ID efficiency coordinate. */
export const GM_ID = 'gm_id';

/**
 * Seed value for a shared-bias axis: its first grid value, EXCEPT the drain–source axis, which
 * seeds near mid-range (≈ VDD/2, in saturation). Characterization grids legitimately include
 * vds = 0, but pinning the operating point there turns the device off (id = gm = 0), so gm/ID is
 * 0/0 = NaN and every canonical gm/ID panel goes blank. Nearest-to-midpoint keeps the device in
 * saturation and works for signed PMOS axes too. Other axes keep the first value (vsb = 0 for no
 * back-bias, l = min length).
 */
export function defaultBias(axis: { name: string; values: ArrayLike<number> }): number {
  const v = axis.values;
  if (axis.name !== DRAIN_AXIS || v.length < 2) return v[0];
  const mid = (v[0] + v[v.length - 1]) / 2;
  let best = v[0];
  for (let i = 1; i < v.length; i++) if (Math.abs(v[i] - mid) < Math.abs(best - mid)) best = v[i];
  return best;
}

// Quantities that span decades and stay strictly positive (currents, transit frequency, output
// resistance, noise PSDs/densities) read better on a log axis; everything else (ratios, voltages,
// capacitances that can go negative) defaults to linear. Right-clicking an axis overrides this.
const LOG_QUANTITIES = new Set([
  'id',
  'id_w',
  'ft',
  'gm',
  'gds',
  'ro',
  'ft_eff',
  'av0_ft',
  'gm_cgd',
  'sth',
  'sfl',
  'svth',
  'svth_m',
  'svfl',
  'vnth',
  'vnth_m',
  'vnfl',
]);
export type Scale = 'lin' | 'log';
/** Preferred scale for an axis quantity when the panel hasn't pinned one. */
export function defaultScale(expr: string): Scale {
  return LOG_QUANTITIES.has(expr) ? 'log' : 'lin';
}

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
export function sizingBias(
  device: DeviceTable,
  sharedBias: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of device.grid.axes) {
    if (a.name === LENGTH_AXIS || a.name === SWEEP_AXIS) continue;
    out[a.name] =
      a.name in sharedBias ? sharedBias[a.name] : a.values[Math.floor(a.values.length / 2)];
  }
  return out;
}

/** Collapse a table's non-(l, vgs) axes to the shared bias point, yielding the [l × vgs] slice a
 *  sheet sizes on (lookupByGmId brackets gm/ID along vgs and cannot with extra live axes). The one
 *  home for the sizing reduction — the App sizer, sheet panels, and resolved child devices all use it. */
export function reduceForSizing(
  device: DeviceTable,
  sharedBias: Record<string, number>,
): DeviceTable {
  const fixed = sizingBias(device, sharedBias);
  return Object.keys(fixed).length ? fixTable(device, fixed) : device;
}

/** A loaded device's display identity — `device · corner · temp°C`, each field its file did not
 *  declare marked `(assumed)` (TableMeta.filled). Human-readable but NOT unique (two
 *  metadata-less or same-corner imports can collide), so it is for DISPLAY only. */
export function deviceKey(t: DeviceTable): string {
  const filled = t.meta.filled ?? [];
  const mark = (field: 'device' | 'corner' | 'temp', text: string): string =>
    filled.includes(field) ? `${text} (assumed)` : text;
  return [
    mark('device', t.id.device),
    mark('corner', t.id.corner),
    mark('temp', `${t.id.temp}°C`),
  ].join(' · ');
}

/**
 * A content-stable, collision-resistant unique id for a loaded table: the display label plus a
 * short FNV-1a hash of the table's identity, geometry, and the FULL contents of every axis and
 * quantity column (sampling would let two regenerated tables that differ only in the interior
 * collide — and dedupe would then silently swap one for the other). This is the resolver /
 * persisted block `device` key (the label is only for display). Two imports of the SAME file get
 * the same uid (so a persisted child→device binding survives a re-import); two DIFFERENT tables
 * that happen to share a label get DISTINCT uids (so each is individually selectable and the
 * resolver targets the right one — fixing the non-unique-label ambiguity). Tables are immutable
 * after import, so the hash is memoized per table object.
 */
const uidMemo = new WeakMap<DeviceTable, string>();
export function tableUid(t: DeviceTable): string {
  const hit = uidMemo.get(t);
  if (hit !== undefined) return hit;
  let h = 0x811c9dc5;
  const step = (x: number): void => {
    h ^= x;
    h = Math.imul(h, 0x01000193);
  };
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) step(s.charCodeAt(i));
  };
  const mixData = (a: Float64Array): void => {
    // byteLength is a multiple of 8, so a u32 view covers every byte; one step per
    // 32-bit word instead of per byte keeps the megabyte-scale hash cheap at boot.
    const w = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >>> 2);
    for (let i = 0; i < w.length; i++) step(w[i]);
  };
  // ALL metadata participates: two tables with identical grids but different scalar
  // metadata (W, AVT, ABETA, fco, polarity, …) size and budget differently, so they
  // must not dedupe into one uid. Property order is stable for parsed and
  // structured-clone-restored tables, so the JSON text is deterministic here.
  // Except the record of which identity fields were filled in: two copies of one file, one that
  // declares the corner `tt` (or the device name) it is read as and one that leaves it to the
  // default, hold the same table, so a re-import of the declared one replaces the other in place;
  // and a table stored before the record existed keeps the uid it was stored under. A declared
  // temperature is different: it is metadata of its own (`meta.temp`), so a copy that declares
  // `# temp: 27` is another uid, and loaded beside the headerless one the two claim one condition,
  // which device QA reports as a duplicate. In one selection the import says which file of two
  // holding one table it set aside.
  const { filled: _filled, ...meta } = t.meta;
  mix(`${t.id.device}|${t.id.corner}|${t.id.temp}|${JSON.stringify(meta)}`);
  for (const a of t.grid.axes) {
    mix(`${a.name}:${a.values.length}`);
    mixData(a.values);
  }
  for (const [k, col] of t.grid.quantities) {
    mix(`${k}:${col.length}`);
    mixData(col);
  }
  // The label part is the bare identity, never deviceKey's marked one: a uid is a stored key.
  const uid = `${t.id.device} · ${t.id.corner} · ${t.id.temp}°C#${(h >>> 0).toString(36)}`;
  uidMemo.set(t, uid);
  return uid;
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

/**
 * Which characterization conditions a sheet panel is evaluated at. `nominal` is the device's
 * designated condition (and refuses, rather than substituting one, when nothing designates it);
 * `active` follows the active table's own condition; `chosen` is an explicit set; `all` is every
 * condition the primary device holds.
 */
export type SheetCornerMode = 'nominal' | 'active' | 'chosen' | 'all';
const CORNER_MODES: readonly SheetCornerMode[] = ['nominal', 'active', 'chosen', 'all'];

/** Coerce an untrusted persisted list of conditions (a panel's chosen set). Keys are stored
 *  structured, never as a joined string, and re-canonicalized on the way in so a hand-edited
 *  `TT` still selects the condition `tt` names. */
export function sanitizeConditionKeys(v: unknown): ConditionKey[] {
  if (!Array.isArray(v)) return [];
  const out: ConditionKey[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.corner !== 'string' || typeof o.temp !== 'number' || !Number.isFinite(o.temp))
      continue;
    const key = conditionKeyOf({ device: '', corner: o.corner, temp: o.temp });
    const id = conditionKeyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}

export interface Panel {
  id: string;
  xExpr: string; // X axis as an expression (the gm/ID view uses 'gm_id'); '' on a sheet panel
  yExpr: string; // Y axis as an expression / derived-quantity name; '' on a sheet panel
  family: string; // axis whose values fan into curves; '' = a single curve
  render: 'chart' | 'table' | 'sheet';
  xScale?: Scale; // axis scale; absent ⇒ defaultScale(xExpr)
  yScale?: Scale; // axis scale; absent ⇒ defaultScale(yExpr)
  legend?: LegendConfig; // dense-family display; absent ⇒ colorbar
  sheet?: SheetDoc; // render === 'sheet': the authored leaf design-sheet, stored verbatim
  sheetSweep?: string; // render === 'sheet': the param the feasibility view sweeps; '' = card only
  sheetSweep2?: string; // render === 'sheet': the second (×) param; with sheetSweep set ⇒ a 2-D map
  // Which characterization conditions this sheet is evaluated at. Bench state, never written
  // into `sheet`: the document describes the design, while which corners are loaded and which
  // of them a panel asks about is a property of this bench. Absent ⇒ 'nominal'.
  sheetCornerMode?: SheetCornerMode;
  sheetCornerKeys?: ConditionKey[]; // mode 'chosen': the conditions selected, structured
  // How a single condition other than the nominal one is asked about: absent ⇒ the design is
  // sized there; true ⇒ the nominal design is held there. Bench state, like the two above.
  sheetCornerHold?: boolean;
  // render === 'sheet', restored from storage with a loss: the document exactly as it was stored,
  // and what the restore could not carry into `sheet` (sanitizeSheet's `lost` paths, or the
  // reason nothing could be read). Until the user edits the sheet, the stored copy is what is
  // persisted (persistedDashboard), so a restore never writes its loss over the user's document.
  // Absent when the restore lost nothing. Bench state, never written into `sheet`.
  sheetStored?: unknown;
  sheetLost?: string[];
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

/**
 * The core's sheet loader (see sanitizeSheet in the core), naming a check written without an id
 * with a fresh unique one, as the app always has.
 */
export function sanitizeSheet(v: unknown, lost?: string[]): SheetDoc | undefined {
  return loadSheet(v, 0, lost, uid);
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
 * is preserved and re-validated against it (a family it lacks is kept and drawn as a single
 * curve, design sheets kept verbatim). This is what lets a device swap keep the user's work
 * instead of wiping it. The Overview tab is found by its `auto` marker, not by position, so it
 * re-seeds wherever it sits — and not at all if the user has deleted it (their choice is
 * respected).
 */
export function reseatDashboard(dash: Dashboard, dev: DeviceTable): Dashboard {
  const san = sanitizeDashboard(dash);
  if (!san) return presetDashboard(dev);
  const fresh = presetTab(dev).panels;
  san.tabs = san.tabs.map((t) =>
    t.auto ? { ...t, panels: [...fresh, ...t.panels.filter((p) => !p.auto)] } : t,
  );
  return san;
}

/**
 * A sheet panel's document restored from what was stored, with what the restore lost. The stored
 * copy is the panel's own while it carries one (a live panel re-validated on a device swap), so
 * the loss is always measured against what the user saved, not against a copy already restored.
 * A document that cannot be read at all is NOT replaced by another: the panel keeps the stored
 * copy, opens refused with the reason and evaluates nothing, as it does for a document in a
 * format this app does not read — which is kept whole by sanitizeSheet and refused by its own
 * reason, so it records no loss here.
 */
function restoredSheet(pp: Record<string, unknown>): {
  sheet?: SheetDoc;
  sheetStored?: unknown;
  sheetLost?: string[];
} {
  const stored = 'sheetStored' in pp ? pp.sheetStored : pp.sheet;
  const lost: string[] = [];
  const sheet = sanitizeSheet(stored, lost);
  if (sheet && sheetFormat(sheet).format === 'unknown') return { sheet };
  if (sheet && !lost.length) return { sheet };
  return {
    ...(sheet ? { sheet } : {}),
    sheetStored: stored,
    sheetLost: lost.length ? lost : ['the stored sheet is not a sheet document'],
  };
}

/** The keys of a sheet that only describe it — its title and the prose beside its pieces. A
 *  restore that could not read one of these loses nothing an evaluation reads. */
const DESCRIPTIVE_KEYS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'note',
  'justification',
]);

/**
 * The paths of `lost` (sanitizeSheet's record) that can change what an evaluation of the sheet
 * reports: everything but a descriptive key (DESCRIPTIVE_KEYS). A check, a given, a parameter or
 * any of its fields, a range end, a block, a wiring key, the polarity, and a key this build does
 * not know at all are all in it: a dropped one can turn a verdict around, so the panel declines
 * to give one until the user evaluates without them.
 */
export function verdictLoss(lost: readonly string[]): string[] {
  return lost.filter((path) => !DESCRIPTIVE_KEYS.has(path.slice(path.lastIndexOf('.') + 1)));
}

/** What a sheet panel whose stored document could not be restored holds in its place: nothing to
 *  read or evaluate. The panel opens refused with the reason (Panel.sheetLost). */
export const UNRESTORED_SHEET: SheetDoc = {
  title: '',
  polarity: 'n',
  params: [],
  equations: [],
  checks: [],
};

/** The dashboard as it is written to storage: a sheet panel restored with a loss writes back the
 *  document as it was stored (Panel.sheetStored), not the restored copy, until the user edits it. */
export function persistedDashboard(d: Dashboard): Dashboard {
  return {
    ...d,
    tabs: d.tabs.map((t) => ({
      ...t,
      panels: t.panels.map((p) => {
        if (!p.sheetLost) return p;
        const { sheetStored, sheetLost: _lost, ...rest } = p;
        return { ...rest, sheet: sheetStored as SheetDoc };
      }),
    })),
  };
}

/**
 * Coerce an untrusted parsed object (e.g. a saved layout from localStorage) into a
 * valid Dashboard, or null if it isn't salvageable (caller falls back to the preset). Nothing
 * here depends on the device: a family or sweep axis the active device does not sweep is kept as
 * stored — the panel draws one curve and the bench sweeps vgs there, each saying so — so a device
 * swap does not erase the choice. Cols clamp to 1..4; ids/render/activeTab are normalized.
 * Expressions are kept verbatim — an unresolvable one surfaces as a per-panel error, never a
 * silent drop of the user's work.
 * Every tab and panel this pass cannot carry, a render it does not know and a corner mode it
 * does not read are recorded in `lost` (a sheet's own losses stay on its panel, see
 * restoredSheet), so a restore that loses them can keep the stored layout instead of saving
 * over it.
 */
export function sanitizeDashboard(d: unknown, lost?: string[]): Dashboard | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (!Array.isArray(o.tabs)) {
    lost?.push('tabs');
    return null;
  }
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);
  const tabs: Tab[] = [];
  for (const [ti, t] of o.tabs.entries()) {
    if (!t || typeof t !== 'object' || !Array.isArray((t as Record<string, unknown>).panels)) {
      lost?.push(`tabs[${ti}]`);
      continue;
    }
    const tt = t as Record<string, unknown>;
    const panels: Panel[] = [];
    for (const [pi, p] of (tt.panels as unknown[]).entries()) {
      const at = `tabs[${ti}].panels[${pi}]`;
      if (!p || typeof p !== 'object') {
        lost?.push(at);
        continue;
      }
      const pp = p as Record<string, unknown>;
      if (typeof pp.xExpr !== 'string' || typeof pp.yExpr !== 'string') {
        lost?.push(at);
        continue;
      }
      // A render this build does not know becomes a chart, and a chart carries no sheet: that is
      // a loss, said like one.
      if (pp.render !== undefined && !['chart', 'table', 'sheet'].includes(pp.render as string))
        lost?.push(`${at}.render`);
      if (pp.sheetCornerMode !== undefined && !CORNER_MODES.some((m) => m === pp.sheetCornerMode))
        lost?.push(`${at}.sheetCornerMode`);
      const legend = sanitizeLegend(pp.legend);
      const render = pp.render === 'table' ? 'table' : pp.render === 'sheet' ? 'sheet' : 'chart';
      const restored: ReturnType<typeof restoredSheet> =
        render === 'sheet' ? restoredSheet(pp) : {};
      const { sheet, sheetStored, sheetLost } = restored;
      const sheetSweep =
        render === 'sheet' && typeof pp.sheetSweep === 'string' ? pp.sheetSweep : undefined;
      const sheetSweep2 =
        render === 'sheet' && typeof pp.sheetSweep2 === 'string' ? pp.sheetSweep2 : undefined;
      // Corner state is reconstructed like every other panel field — a field this function does
      // not name is dropped, so an unlisted addition would vanish on the next reload.
      const cornerMode = CORNER_MODES.find((m) => m === pp.sheetCornerMode);
      const sheetCornerMode = render === 'sheet' ? cornerMode : undefined;
      // A chosen condition is kept even when nothing loaded answers to it: the panel renders it
      // as its own not-evaluated row, which is the honest state — pruning it here would quietly
      // narrow the question the panel is asking.
      const cornerKeys = render === 'sheet' ? sanitizeConditionKeys(pp.sheetCornerKeys) : [];
      const cornerHold = render === 'sheet' && pp.sheetCornerHold === true;
      panels.push({
        id: str(pp.id, uid()),
        xExpr: pp.xExpr,
        yExpr: pp.yExpr,
        // Kept as stored even where this device does not sweep it: the panel draws one curve
        // there and says so, and a swap back to a device that does finds the choice intact.
        family: typeof pp.family === 'string' ? pp.family : '',
        render,
        ...(pp.xScale === 'log' || pp.xScale === 'lin' ? { xScale: pp.xScale } : {}),
        ...(pp.yScale === 'log' || pp.yScale === 'lin' ? { yScale: pp.yScale } : {}),
        ...(legend ? { legend } : {}),
        ...(sheet ? { sheet } : {}),
        ...(sheetLost ? { sheetStored, sheetLost } : {}),
        ...(sheetSweep ? { sheetSweep } : {}),
        ...(sheetSweep2 ? { sheetSweep2 } : {}),
        ...(sheetCornerMode ? { sheetCornerMode } : {}),
        ...(cornerKeys.length ? { sheetCornerKeys: cornerKeys } : {}),
        ...(cornerHold ? { sheetCornerHold: true } : {}),
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
    // Kept like a family: the bench sweeps vgs where the device lacks it, and says so.
    sweep: typeof o.sweep === 'string' && o.sweep ? o.sweep : SWEEP_AXIS,
  };
}
