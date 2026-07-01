<script lang="ts">
  import { untrack } from 'svelte';
  import {
    plottableQuantities,
    importMostab,
    metaScalars,
    formatEng,
    validate,
    EXAMPLES,
    DERIVED_QUANTITIES,
    type QAWarning,
    type DeviceTable,
    type Grid,
  } from '@gmid/mostab-core';
  import { axisUnit, baseUnit } from './labels';
  import Panel from './Panel.svelte';
  import Sizer from './Sizer.svelte';
  import Help from './Help.svelte';
  import { CONTROL_HELP } from './help';
  import { loadSettings, saveSettings, applySettings, FONT_RANGE, type Settings } from './settings';
  import { loadJSON, saveJSON } from './storage';
  import {
    presetDashboard,
    sanitizeDashboard,
    reseatDashboard,
    canPlot,
    deviceKey,
    tableUid,
    defaultBias,
    TEMPLATES,
    SWEEP_AXIS,
    LENGTH_AXIS,
    GM_ID,
    type Dashboard,
    type PanelTemplate,
  } from './dashboard';

  // The device-level core is the single source of truth. Devices are loaded at runtime by
  // importing a mostab file; the app boots EMPTY (no built-in data) and shows a load prompt
  // until the first import.
  // The loaded devices accumulate across imports so any subset can be overlaid for comparison
  // (NMOS vs PMOS, corner vs corner). `device` is the active/primary one — it drives the
  // dashboard, the expression pickers, the bias sliders, and the sizer. It is `undefined` only in
  // the empty boot state, which the template gates behind a load prompt. The overlay set is
  // chart-only and in-memory (device data is NDA-sensitive, never persisted). QA warnings live
  // WITH their table so the displayed QA always matches the active device and can never go stale
  // when the active device changes or a device is removed.
  type Loaded = { table: DeviceTable; warnings: readonly QAWarning[] };
  let devices = $state<Loaded[]>([]);
  let activeIdx = $state(0);
  let overlayIdx = $state<number[]>([]);
  const active = $derived(devices[activeIdx]);
  const device = $derived(active?.table);
  const overlays = $derived(overlayIdx.map((i) => devices[i]?.table).filter((d): d is DeviceTable => !!d));
  const warnings = $derived(active?.warnings ?? []);
  // Loaded devices for the per-child device picker in composed sheets: a unique stable uid (the
  // resolver/persistence key), a human label, and the raw table (reduced to an [l × vgs] sizing
  // slice inside Panel, like the active device).
  const sheetDevices = $derived(
    devices.map((d) => ({ uid: tableUid(d.table), label: deviceKey(d.table), table: d.table })),
  );
  let importError = $state<string | null>(null);
  let dragging = $state(false);

  // Canonical key → display metadata (static; reused by the picker and sliders).
  const derivedExpr = new Map(DERIVED_QUANTITIES.map((q) => [q.key, q.expr]));

  // Names of the multi-value axes — the only ones worth charting or sweeping.
  const multiAxisNames = (grid: Grid) =>
    grid.axes.filter((a) => a.values.length > 1).map((a) => a.name);
  const multiAxes = $derived(device ? multiAxisNames(device.grid) : []);

  // Dashboard config (tabs → grids of panels). Restored from a saved layout when one
  // is present and valid for this device, else the device's canonical preset. A device
  // swap re-validates the live layout against the new device (in select()), preserving the
  // user's tabs and panels; panel edits never reseed it.
  // Bumped to .v2 when panels/tabs gained the `auto` origin marker: a layout saved before that
  // has no markers, so a device swap could not tell its canonical panels apart and would
  // duplicate them. Reseeding the preset once on upgrade is cleaner than half-migrating.
  const DASH_KEY = 'gmid.dash.v2';
  const loadDashboard = (dev: DeviceTable): Dashboard =>
    loadJSON(DASH_KEY, (raw) => sanitizeDashboard(raw, dev), () => presetDashboard(dev));
  // Null until the first device loads — the dashboard can only be seeded/validated against a
  // device (sanitizeDashboard/presetDashboard both need one). The saved layout in localStorage is
  // restored at that point, so a customized dashboard still survives a reload.
  let dashboard = $state<Dashboard | null>(null);
  const activeTab = $derived(dashboard ? (dashboard.tabs[dashboard.activeTab] ?? dashboard.tabs[0]) : undefined);
  // Persist the layout (not the device — that re-seeds on load) so a customized dashboard
  // survives a reload. Best-effort. Never clobber the saved layout with the empty-boot null.
  $effect(() => {
    if (dashboard) saveJSON(DASH_KEY, dashboard);
  });

  // Appearance settings (theme + font sizes). Applied to the document root and persisted on
  // every change. The whole UI and the canvas chart follow (both read system colours + vars).
  let settings = $state<Settings>(loadSettings());
  // `styleVersion` signals each Panel to chart.restyle() (the chart re-reads its themed colour
  // and tick font from CSS only at construction). It is bumped INSIDE the apply effect, AFTER
  // applySettings has committed color-scheme to the DOM — so the restyle reads the just-applied
  // scheme, not the previous one. (A plain $derived recomputes the instant settings change and
  // let the child restyle effect run first, reading the stale scheme and inverting the ticks.)
  // Only the two canvas-relevant settings (theme + tick font) trigger a bump; UI/title fonts
  // are pure CSS and need no rebuild.
  let styleVersion = $state(0);
  let prevStyleKey = '';
  $effect(() => {
    applySettings(settings);
    saveSettings(settings);
    const key = `${settings.theme}|${settings.fontAxisLabel}`;
    if (key !== prevStyleKey) {
      prevStyleKey = key;
      untrack(() => (styleVersion += 1));
    }
  });

  // Operating point: sharedBias carries a value for EVERY non-sweep multi-value axis, so
  // any panel can pin the axes it doesn't fan. Seeded on a device/sweep change only (never
  // on tab/panel edits), so the operating point persists.
  const biasAxes = $derived.by(() => {
    if (!device || !dashboard) return [];
    const sweep = dashboard.sweep;
    return device.grid.axes.filter((a) => a.name !== sweep && a.values.length > 1);
  });
  let sharedBias = $state<Record<string, number>>({});
  $effect(() => {
    sharedBias = Object.fromEntries(biasAxes.map((a) => [a.name, defaultBias(a)]));
  });
  // Sliders shown = bias axes that at least one panel in the ACTIVE tab actually pins (does
  // not fan into its family). An axis every visible panel fans is inert here, so it's
  // hidden — but its value is still held, and a panel that DOES pin it (single-curve, or a
  // differently-fanned panel) gets the right bias and brings its slider back.
  const shownBiasAxes = $derived(
    activeTab ? biasAxes.filter((a) => activeTab.panels.some((p) => p.family !== a.name)) : [],
  );

  // Picker for panel X/Y: every quantity THIS device resolves along the sweep,
  // including derived ones the width scalar unlocks (id/w).
  const exprOptions = $derived.by(() => {
    if (!device || !dashboard) return [];
    const pq = plottableQuantities(device.grid, dashboard.sweep, Object.keys(metaScalars(device.meta)));
    return [
      ...pq.base.map((k) => ({ value: k, label: `${k} [${baseUnit.get(k)}]` })),
      ...pq.derived.map((k) => ({ value: k, label: `${k} = ${derivedExpr.get(k)}`, formula: derivedExpr.get(k) })),
    ];
  });
  const defaultFamily = $derived(multiAxes.includes(LENGTH_AXIS) ? LENGTH_AXIS : '');

  // Offer only the templates the active device can actually plot: both axes must resolve against
  // this device + sweep (the same plottability the axis pickers and the Overview preset use), so
  // the no-typing menu never advertises a canonical plot that would open as an erroring panel
  // (e.g. fT / gm·gds on an import with no CGG / GDS column). Keeps each template's original
  // index so `addFromTemplate` still resolves it in TEMPLATES.
  const templateOptions = $derived.by(() => {
    const ok = new Set(exprOptions.map((o) => o.value));
    return TEMPLATES.map((t, i) => ({ t, i })).filter(({ t }) => canPlot(t, ok));
  });

  // Dashboard mutations. activeTab / cfg are proxied $state objects, so mutating
  // their fields (or splicing the arrays) is reactive without re-finding by id.
  // Add a panel from a template (the canonical plots) or, with no template, a blank one.
  // A template without its own family fans the device's default (L when present).
  function addPanel(tpl?: PanelTemplate): void {
    if (!activeTab) return;
    activeTab.panels.push({
      id: crypto.randomUUID(),
      xExpr: tpl?.xExpr ?? GM_ID,
      yExpr: tpl?.yExpr ?? 'id',
      family: tpl?.family ?? defaultFamily,
      render: 'chart',
    });
  }
  // Add from the template <select>, then snap it back to its placeholder.
  function addFromTemplate(e: Event): void {
    const sel = e.currentTarget as HTMLSelectElement;
    const i = Number(sel.value);
    if (Number.isInteger(i) && i >= 0 && i < TEMPLATES.length) addPanel(TEMPLATES[i]);
    sel.value = '';
  }
  // A sheet panel carries '' axes (so the chart axis guard in sanitizeDashboard keeps
  // it) and a copy of the first vetted example as its starting doc.
  function addSheetPanel(): void {
    if (!activeTab) return;
    activeTab.panels.push({
      id: crypto.randomUUID(),
      xExpr: '',
      yExpr: '',
      family: '',
      render: 'sheet',
      sheet: structuredClone(EXAMPLES[0]),
    });
  }
  function removePanel(id: string): void {
    if (!activeTab) return;
    activeTab.panels = activeTab.panels.filter((p) => p.id !== id);
  }
  function addTab(): void {
    if (!dashboard) return;
    dashboard.tabs.push({ id: crypto.randomUUID(), name: `Tab ${dashboard.tabs.length + 1}`, cols: 2, panels: [] });
    dashboard.activeTab = dashboard.tabs.length - 1;
  }
  function removeTab(i: number): void {
    if (!dashboard || dashboard.tabs.length <= 1) return;
    dashboard.tabs.splice(i, 1);
    if (dashboard.activeTab >= dashboard.tabs.length) dashboard.activeTab = dashboard.tabs.length - 1;
  }
  function renameTab(i: number): void {
    if (!dashboard) return;
    const name = prompt('Tab name', dashboard.tabs[i].name);
    if (name != null && name.trim() !== '') dashboard.tabs[i].name = name.trim();
  }
  const setCols = (d: number) => activeTab && (activeTab.cols = Math.min(4, Math.max(1, activeTab.cols + d)));

  // Monotonic token so a slow earlier file read can't clobber a newer load
  // (last-selected wins, not last-resolved).
  let importSeq = 0;

  // Import a mostab CSV (file picker or drag-drop) and swap it in as the device.
  async function loadFiles(files: FileList | null | undefined): Promise<void> {
    const file = files?.[0];
    if (!file) return;
    const seq = ++importSeq;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (seq !== importSeq) return; // superseded by a newer load
    const result = importMostab(bytes, { filename: file.name });
    if (!result.ok) {
      importError = result.errors.map((e) => `${e.kind}: ${e.message}`).join(' · ');
      return;
    }
    // Append every table in the dataset (a multi-corner export brings TT/SS/FF in at once),
    // make the first newly-loaded one active, and reset the overlay selection.
    const first = devices.length;
    devices = [...devices, ...result.dataset.tables.map((t) => ({ table: t, warnings: validate(t) }))];
    select(first);
  }

  // Make device `i` active (overlays cleared). The user's authored panels and tabs are preserved
  // across the swap; only the auto-generated canonical panels are re-seeded for the new device
  // (reseatDashboard). QA follows automatically — `warnings` is derived from the active device.
  function select(i: number): void {
    importError = null;
    activeIdx = i;
    overlayIdx = [];
    // First device seeds the dashboard (restoring any saved layout); later swaps reseat the live one.
    dashboard = dashboard
      ? reseatDashboard(dashboard, devices[i].table)
      : loadDashboard(devices[i].table);
  }

  // Drop a loaded device from the registry; never remove the last or the active one.
  function removeDevice(i: number): void {
    if (devices.length <= 1 || i === activeIdx) return;
    devices = devices.filter((_, k) => k !== i);
    // Shift every index past the removed slot down one to track the shrunk list.
    const shift = (k: number) => (k > i ? k - 1 : k);
    activeIdx = shift(activeIdx);
    overlayIdx = overlayIdx.filter((k) => k !== i).map(shift);
  }

  // Toggle device `i` into/out of the overlay set (the active device can't overlay itself).
  function toggleOverlay(i: number): void {
    if (i === activeIdx) return;
    overlayIdx = overlayIdx.includes(i) ? overlayIdx.filter((k) => k !== i) : [...overlayIdx, i];
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragging = false;
    void loadFiles(e.dataTransfer?.files);
  }

  // ── Sizing panel (the "design" workflow). The whole feature lives in <Sizer>; App
  // owns only the open/close toggle and renders it (against the active device + bias)
  // while open.
  let sizerOpen = $state(false);

</script>

<header>
  <h1>gm/ID Workbench</h1>
  <datalist id="exprs">
    {#each exprOptions as o}
      <option value={o.value} label={o.label}></option>
    {/each}
  </datalist>
  {#if dashboard}
    <label class="axis">sweep
      <select bind:value={dashboard.sweep}>
        {#each multiAxes as ax}<option value={ax}>{ax}</option>{/each}
      </select>
    </label>
    <Help text={CONTROL_HELP.sweep} />
    {#each shownBiasAxes as a}
      <label class="slider">
        {a.name}
        <input
          type="range"
          min={a.values[0]}
          max={a.values[a.values.length - 1]}
          step={(a.values[a.values.length - 1] - a.values[0]) / 100}
          bind:value={sharedBias[a.name]}
        />
        <span class="val">{formatEng(sharedBias[a.name])}{axisUnit(a.name)}</span>
        <Help text={CONTROL_HELP.bias} />
      </label>
    {/each}
  {/if}
  <span class="grow"></span>
  {#if device}<span class="device" title="active device">{deviceKey(device)}</span>{/if}
  <label class="load">
    Load .csv
    <input
      type="file"
      accept=".csv,.txt,text/csv"
      onchange={(e) => loadFiles((e.currentTarget as HTMLInputElement).files)}
    />
  </label>
  {#if device}<button class="btn size" class:on={sizerOpen} onclick={() => (sizerOpen = !sizerOpen)} title={CONTROL_HELP.size}>size</button>{/if}
  <details class="prefs">
    <summary class="btn" title="appearance: theme and font sizes">⚙</summary>
    <div class="prefs-pop">
      <label class="prow">theme
        <select bind:value={settings.theme}>
          <option value="auto">auto</option>
          <option value="light">light</option>
          <option value="dark">dark</option>
        </select>
      </label>
      <label class="prow">UI font
        <input type="range" min={FONT_RANGE.min} max={FONT_RANGE.max} bind:value={settings.fontUi} />
        <span class="pval">{settings.fontUi}px</span>
      </label>
      <label class="prow">axis titles
        <input type="range" min={FONT_RANGE.min} max={FONT_RANGE.max} bind:value={settings.fontAxisTitle} />
        <span class="pval">{settings.fontAxisTitle}px</span>
      </label>
      <label class="prow">axis labels
        <input type="range" min={FONT_RANGE.min} max={FONT_RANGE.max} bind:value={settings.fontAxisLabel} />
        <span class="pval">{settings.fontAxisLabel}px</span>
      </label>
    </div>
  </details>
</header>

{#if importError}
  <div class="qa error">import failed — {importError}</div>
{:else if warnings.length}
  <div class="qa">
    <strong>QA</strong>
    {#each warnings as w}<span class="w {w.severity}" title={w.location ?? ''}>{w.rule}: {w.message}</span>{/each}
  </div>
{/if}

{#if devices.length > 1}
  <nav class="devices" aria-label="loaded devices">
    <span class="dlabel">devices</span>
    <Help text={CONTROL_HELP.overlay} />
    {#each devices as d, i}
      <span class="dev" class:active={i === activeIdx}>
        <button
          class="dname"
          class:active={i === activeIdx}
          onclick={() => select(i)}
          title={CONTROL_HELP.active}
        >{deviceKey(d.table)}</button>
        <label class="dov" title={CONTROL_HELP.overlay}>
          <input
            type="checkbox"
            checked={overlayIdx.includes(i)}
            disabled={i === activeIdx}
            onchange={() => toggleOverlay(i)}
          />overlay
        </label>
        <button class="drm" onclick={() => removeDevice(i)} title="remove from registry" aria-label="remove device">×</button>
      </span>
    {/each}
  </nav>
{/if}

  {#if dashboard && activeTab}
  {@const d = dashboard}
  <nav class="tabs">
    {#each d.tabs as tab, i}
      <button
        class="tab"
        class:on={i === d.activeTab}
        onclick={() => (d.activeTab = i)}
        ondblclick={() => renameTab(i)}
        title="double-click to rename"
      >{tab.name}</button>
    {/each}
    <button class="tab add" onclick={addTab} title="add tab">+</button>
    <span class="grow"></span>
    <span class="cols">
      <button class="btn" onclick={() => setCols(-1)} title="fewer columns">−</button>
      {activeTab.cols} col
      <button class="btn" onclick={() => setCols(1)} title="more columns">+</button>
    </span>
    <select class="btn tpl" onchange={addFromTemplate} title={CONTROL_HELP.template}>
      <option value="" selected>+ panel from…</option>
      {#each templateOptions as { t, i }}<option value={i}>{t.name}</option>{/each}
    </select>
    <button class="btn" onclick={() => addPanel()} title="add a blank panel">+ panel</button>
    <button class="btn" onclick={addSheetPanel} title={CONTROL_HELP.sheet}>+ sheet</button>
    {#if d.tabs.length > 1}
      <button class="btn" onclick={() => removeTab(d.activeTab)}>remove tab</button>
    {/if}
  </nav>
  {/if}

<div
  class="main"
  class:dragging
  role="region"
  aria-label="drop a mostab CSV here to load"
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  {#if device && dashboard && activeTab}
    <div class="grid" style:--cols={activeTab.cols}>
      {#each activeTab.panels as cfg (cfg.id)}
        <Panel
          {device}
          {overlays}
          {sheetDevices}
          sweep={dashboard.sweep}
          {sharedBias}
          {cfg}
          families={multiAxes}
          options={exprOptions}
          {styleVersion}
          onChange={(patch) => {
            // Editing a canonical (auto) panel makes it the user's own, so it survives a device
            // swap instead of being regenerated away (reseatDashboard preserves non-auto panels).
            Object.assign(cfg, patch);
            if (cfg.auto) cfg.auto = false;
          }}
          onRemove={() => removePanel(cfg.id)}
        />
      {/each}
      {#if activeTab.panels.length === 0}
        <p class="empty">no panels — use <strong>+ panel</strong> above</p>
      {/if}
    </div>
    {#if sizerOpen}
      <Sizer {device} {sharedBias} />
    {/if}
  {:else}
    <div class="welcome">
      <h2>No device loaded</h2>
      <p>Import a mostab <code>.csv</code> to begin — use <strong>Load .csv</strong> above, or drop a file here.</p>
      <p class="hint">Generate open-PDK tables with <code>tools/gen_gmid.py</code> (see <code>data/pdk/PROVENANCE.md</code>).</p>
    </div>
  {/if}
  {#if dragging}<div class="drophint">drop a mostab .csv</div>{/if}
</div>

<style>
  header {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  }
  h1 {
    font-size: 1rem;
    margin: 0;
  }
  .axis {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
    opacity: 0.85;
  }
  .axis select {
    font: inherit;
  }
  .slider {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .slider input {
    width: 8rem;
  }
  .slider .val {
    font-family: ui-monospace, monospace;
    min-width: 3.5rem;
  }
  .grow {
    flex: 1 1 auto;
  }
  .device {
    font-family: ui-monospace, monospace;
    opacity: 0.75;
  }
  .load,
  .btn {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
  }
  .load input {
    display: none;
  }
  .qa {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.9rem;
    align-items: baseline;
    padding: 0.3rem 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    font-family: ui-monospace, monospace;
    font-size: 0.92em;
  }
  .qa.error {
    color: #e6194b;
  }
  .qa .w::before {
    content: '';
    display: inline-block;
    width: 0.6em;
    height: 0.6em;
    border-radius: 50%;
    margin-right: 0.35em;
    background: currentColor;
    vertical-align: middle;
  }
  .qa .w.error {
    color: #e6194b;
  }
  .qa .w.warning {
    color: #d98e00;
  }
  .qa .w.info {
    opacity: 0.6;
  }
  .btn.on {
    background: color-mix(in srgb, currentColor 15%, transparent);
  }
  /* Appearance popover: a native <details> disclosure so there's no popover/positioning JS. */
  .prefs {
    position: relative;
  }
  .prefs summary {
    list-style: none;
  }
  .prefs summary::-webkit-details-marker {
    display: none;
  }
  .prefs-pop {
    position: absolute;
    right: 0;
    top: calc(100% + 0.35rem);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    min-width: 14rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 6px;
    background: var(--bg);
    box-shadow: 0 4px 16px color-mix(in srgb, currentColor 22%, transparent);
  }
  .prow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .prow input[type='range'] {
    flex: 1 1 auto;
    min-width: 5rem;
  }
  .pval {
    font-family: ui-monospace, monospace;
    min-width: 2.8rem;
    text-align: right;
  }
  .main {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .main.dragging {
    outline: 2px dashed color-mix(in srgb, currentColor 50%, transparent);
    outline-offset: -4px;
  }
  .grid {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
    gap: 0.5rem;
    padding: 0.5rem;
    overflow: auto;
  }
  .empty {
    grid-column: 1 / -1;
    opacity: 0.5;
    text-align: center;
    padding: 2rem;
  }
  .welcome {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    text-align: center;
    opacity: 0.75;
    padding: 2rem;
  }
  .welcome h2 {
    margin: 0;
    font-weight: 600;
    font-size: 1.1rem;
  }
  .welcome .hint {
    opacity: 0.7;
    font-size: 0.9em;
  }
  .welcome code {
    font-family: ui-monospace, monospace;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
    padding: 0.3rem 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  }
  .tab {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 4px 4px 0 0;
    padding: 0.1rem 0.6rem;
  }
  .tab.on {
    background: color-mix(in srgb, currentColor 15%, transparent);
    font-weight: 600;
  }
  .cols {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
    opacity: 0.85;
  }
  .devices {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    padding: 0.3rem 0.75rem;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  }
  .devices .dlabel {
    opacity: 0.55;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.72rem;
  }
  .dev {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    border-radius: 5px;
    padding: 0.05rem 0.3rem;
  }
  .dev.active {
    border-color: color-mix(in srgb, currentColor 45%, transparent);
    background: color-mix(in srgb, currentColor 8%, transparent);
  }
  .dname {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0.05rem 0.1rem;
  }
  .dname.active {
    font-weight: 600;
  }
  .dov {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    opacity: 0.85;
  }
  .dov input:disabled {
    opacity: 0.3;
  }
  .drm {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    opacity: 0.5;
    padding: 0 0.15rem;
  }
  .drm:hover {
    opacity: 1;
  }
  .drophint {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 600 1rem system-ui, sans-serif;
    background: color-mix(in srgb, Canvas 70%, transparent);
    pointer-events: none;
  }
</style>
