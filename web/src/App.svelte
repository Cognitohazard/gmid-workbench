<script lang="ts">
  import { untrack } from 'svelte';
  import {
    generateDemoDevice,
    plottableQuantities,
    importMostab,
    sizeDevice,
    mismatch,
    thermalNoise,
    integratedNoise,
    metaScalars,
    fixTable,
    formatEng,
    parseEng,
    validate,
    EXAMPLES,
    BASE_QUANTITIES,
    DERIVED_QUANTITIES,
    type QAWarning,
    type DeviceTable,
    type Grid,
  } from '@gmid/mostab-core';
  import Panel from './Panel.svelte';
  import Help from './Help.svelte';
  import { CONTROL_HELP } from './help';
  import { loadSettings, saveSettings, applySettings, FONT_RANGE, type Settings } from './settings';
  import { loadJSON, saveJSON } from './storage';
  import {
    presetDashboard,
    sanitizeDashboard,
    canPlot,
    sizingBias,
    TEMPLATES,
    SWEEP_AXIS,
    LENGTH_AXIS,
    GM_ID,
    type Dashboard,
    type PanelTemplate,
  } from './dashboard';

  // The device-level core is the single source of truth. The active device is
  // swappable at runtime by importing a mostab file; the demo (with a vds axis so
  // the N-D sliders have something to navigate) stands in until then.
  const newDemo = () => generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.05 } });

  const INITIAL_DEVICE = newDemo();
  // The loaded devices accumulate across imports so any subset can be overlaid for comparison
  // (NMOS vs PMOS, corner vs corner). `device` is the active/primary one — it drives the
  // dashboard, the expression pickers, the bias sliders, and the sizer, all unchanged. The
  // overlay set is chart-only and in-memory (device data is NDA-sensitive, never persisted).
  // QA warnings live WITH their table so the displayed QA always matches the active device and
  // can never go stale when the active device changes or a device is removed. The synthetic demo
  // carries none (its QA notes are noise on teaching data); real imports carry validate(table).
  type Loaded = { table: DeviceTable; warnings: readonly QAWarning[] };
  let devices = $state<Loaded[]>([{ table: INITIAL_DEVICE, warnings: [] }]);
  let activeIdx = $state(0);
  let overlayIdx = $state<number[]>([]);
  const active = $derived(devices[activeIdx] ?? devices[0]);
  const device = $derived(active.table);
  const overlays = $derived(overlayIdx.map((i) => devices[i]?.table).filter((d): d is DeviceTable => !!d));
  const warnings = $derived(active.warnings);
  let importError = $state<string | null>(null);
  let dragging = $state(false);

  // Canonical key → display metadata (static; reused by the picker and sliders).
  const baseUnit = new Map(BASE_QUANTITIES.map((q) => [q.key, q.unit]));
  const derivedExpr = new Map(DERIVED_QUANTITIES.map((q) => [q.key, q.expr]));
  const axisUnit = (name: string) => baseUnit.get(name) ?? '';

  // Names of the multi-value axes — the only ones worth charting or sweeping.
  const multiAxisNames = (grid: Grid) =>
    grid.axes.filter((a) => a.values.length > 1).map((a) => a.name);
  const multiAxes = $derived(multiAxisNames(device.grid));

  // Dashboard config (tabs → grids of panels). Restored from a saved layout when one
  // is present and valid for this device, else the device's canonical preset. A new
  // device import re-seeds the preset (in select()); panel edits never reseed it.
  const DASH_KEY = 'gmid.dash';
  const loadDashboard = (dev: DeviceTable): Dashboard =>
    loadJSON(DASH_KEY, (raw) => sanitizeDashboard(raw, dev), () => presetDashboard(dev));
  let dashboard = $state<Dashboard>(loadDashboard(INITIAL_DEVICE));
  const activeTab = $derived(dashboard.tabs[dashboard.activeTab] ?? dashboard.tabs[0]);
  // Persist the layout (not the device — that re-seeds on load) so a customized
  // dashboard survives a reload. Best-effort: a write failure is silently ignored.
  $effect(() => saveJSON(DASH_KEY, dashboard));

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
  const biasAxes = $derived(
    device.grid.axes.filter((a) => a.name !== dashboard.sweep && a.values.length > 1),
  );
  let sharedBias = $state<Record<string, number>>({});
  $effect(() => {
    sharedBias = Object.fromEntries(biasAxes.map((a) => [a.name, a.values[0]]));
  });
  // Sliders shown = bias axes that at least one panel in the ACTIVE tab actually pins (does
  // not fan into its family). An axis every visible panel fans is inert here, so it's
  // hidden — but its value is still held, and a panel that DOES pin it (single-curve, or a
  // differently-fanned panel) gets the right bias and brings its slider back.
  const shownBiasAxes = $derived(
    biasAxes.filter((a) => activeTab.panels.some((p) => p.family !== a.name)),
  );

  // Picker for panel X/Y: every quantity THIS device resolves along the sweep,
  // including derived ones the width scalar unlocks (id/w).
  const exprOptions = $derived.by(() => {
    const pq = plottableQuantities(device.grid, dashboard.sweep, Object.keys(metaScalars(device.meta)));
    return [
      ...pq.base.map((k) => ({ value: k, label: `${k} [${baseUnit.get(k)}]` })),
      ...pq.derived.map((k) => ({ value: k, label: `${k} = ${derivedExpr.get(k)}` })),
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
    activeTab.panels = activeTab.panels.filter((p) => p.id !== id);
  }
  function addTab(): void {
    dashboard.tabs.push({ id: crypto.randomUUID(), name: `Tab ${dashboard.tabs.length + 1}`, cols: 2, panels: [] });
    dashboard.activeTab = dashboard.tabs.length - 1;
  }
  function removeTab(i: number): void {
    if (dashboard.tabs.length <= 1) return;
    dashboard.tabs.splice(i, 1);
    if (dashboard.activeTab >= dashboard.tabs.length) dashboard.activeTab = dashboard.tabs.length - 1;
  }
  function renameTab(i: number): void {
    const name = prompt('Tab name', dashboard.tabs[i].name);
    if (name != null && name.trim() !== '') dashboard.tabs[i].name = name.trim();
  }
  const setCols = (d: number) => (activeTab.cols = Math.min(4, Math.max(1, activeTab.cols + d)));

  // Monotonic token so a slow earlier file read can't clobber a newer load/demo
  // (last-selected wins, not last-resolved).
  let importSeq = 0;

  // Import a mostab CSV (file picker or drag-drop) and swap it in as the device.
  async function loadFiles(files: FileList | null | undefined): Promise<void> {
    const file = files?.[0];
    if (!file) return;
    const seq = ++importSeq;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (seq !== importSeq) return; // superseded by a newer load/demo
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

  // Make device `i` active and reset the view around it (overlays cleared, dashboard re-seeded).
  // QA follows automatically — `warnings` is derived from the active device.
  function select(i: number): void {
    importError = null;
    activeIdx = i;
    overlayIdx = [];
    dashboard = presetDashboard(devices[i].table); // canonical panels for the newly active device
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

  function loadDemo(): void {
    importSeq++; // invalidate any in-flight import
    devices = [{ table: newDemo(), warnings: [] }];
    select(0);
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragging = false;
    void loadFiles(e.dataTransfer?.files);
  }

  // ── Sizing panel (the "design" workflow): bind any two of {gm, gm/ID, ID} at a
  // chosen L → width, vgs, fT, and feasibility against the gm/ID ceiling.
  let sizerOpen = $state(false);
  let sizeL = $state(NaN);
  let inGmId = $state('');
  let inId = $state('');
  let inGm = $state('');

  const lAxis = $derived(device.grid.axes.find((a) => a.name === LENGTH_AXIS));
  $effect(() => {
    sizeL = lAxis ? lAxis.values[0] : NaN; // reset to the first L on a device swap
  });

  // Bias for sizing: every axis except l/vgs, fixed at the dashboard's shared-bias slider value
  // (so you size at the operating point you're viewing), else a mid node. Shown in the panel so
  // the operating point of W/vgs/fT/gm-gds is never implicit.
  const sizingFixed = $derived(sizingBias(device, sharedBias));

  // sizeDevice/lookupByGmId need an [l × vgs] table; collapse the extra axes at the bias.
  const sizingTable = $derived(
    Object.keys(sizingFixed).length === 0 ? device : fixTable(device, sizingFixed),
  );

  const parseNum = (s: string): number | undefined => {
    if (s.trim() === '') return undefined;
    try {
      return parseEng(s); // accepts engineering notation: 100u, 1m, 2.5n …
    } catch {
      return undefined;
    }
  };

  const sizing = $derived.by(() => {
    if (!lAxis) return { hint: 'this table has no L axis to size against' };
    const supplied: { gm_id?: number; id?: number; gm?: number } = {};
    const gmId = parseNum(inGmId);
    const id = parseNum(inId);
    const gm = parseNum(inGm);
    if (gmId !== undefined) supplied.gm_id = gmId;
    if (id !== undefined) supplied.id = id;
    if (gm !== undefined) supplied.gm = gm;
    if (Object.keys(supplied).length !== 2) {
      return { hint: 'enter exactly two of gm/ID, ID, gm' };
    }
    try {
      return { result: sizeDevice({ table: sizingTable, L: sizeL, ...supplied }) };
    } catch (e) {
      return { err: (e as Error).message };
    }
  });

  // Matching/offset budget on the sized geometry. A_Vth / A_β are PDK constants the
  // UI takes in conventional units (mV·µm, %·µm) but the core wants in SI (V·m, ·m).
  // One factor each way: UI = SI × K (display), SI = UI ÷ K (binding) — reciprocal.
  const AVT_UI_PER_SI = 1e9; // V·m → mV·µm
  const ABETA_UI_PER_SI = 1e8; // ·m → %·µm (1% = 0.01)
  let inAvth = $state('4'); // mV·µm
  let inAbeta = $state('1'); // %·µm
  // Noise band + 1/f corner (Hz, engineering notation). Corner seeds from meta.FCO.
  let inFco = $state('1meg'); // flicker 1/f corner
  let inFlo = $state('1'); // integration band low
  let inFhi = $state('1g'); // integration band high

  // Seed the coefficients from the imported device's metadata when it carries them
  // (meta.AVT [V·m], meta.ABETA [·m], meta.FCO [Hz]) instead of silently using generic
  // defaults; fall back to typical values (shown as such) otherwise. Re-seeds on swap.
  const matchFromMeta = $derived(device.meta.AVT !== undefined || device.meta.ABETA !== undefined);
  const noiseFromMeta = $derived(device.meta.FCO !== undefined);
  const toUi = (si: number, k: number) => String(+(si * k).toPrecision(6));
  $effect(() => {
    const m = device.meta;
    inAvth = m.AVT !== undefined ? toUi(m.AVT, AVT_UI_PER_SI) : '4';
    inAbeta = m.ABETA !== undefined ? toUi(m.ABETA, ABETA_UI_PER_SI) : '1';
    inFco = m.FCO !== undefined ? formatEng(m.FCO) : '1meg';
  });

  const mism = $derived.by(() => {
    if (!sizing.result) return null;
    const avth = Number(inAvth) / AVT_UI_PER_SI; // mV·µm → V·m
    const abeta = Number(inAbeta) / ABETA_UI_PER_SI; // %·µm → ·m
    if (!(avth >= 0) || !(abeta >= 0)) return null; // NaN/negative → hide
    return mismatch(sizing.result.W, sizeL, sizing.result.gm_id, { avth, abeta });
  });

  // Input-referred thermal-noise density (at the sized gm) and the total integrated
  // RMS over the band share the thermal floor, so compute it once. rms is null on an
  // invalid band; the whole object is null until a geometry is sized.
  const noise = $derived.by(() => {
    if (!sizing.result) return null;
    const density = thermalNoise(sizing.result.gm, sizing.result.quantities.gamma);
    const fc = parseNum(inFco);
    const fLo = parseNum(inFlo);
    const fHi = parseNum(inFhi);
    if (fc === undefined || fLo === undefined || fHi === undefined || !(fLo > 0) || !(fHi > fLo) || !(fc >= 0)) {
      return { density, rms: null };
    }
    return { density, rms: integratedNoise(density ** 2, fc, fLo, fHi) };
  });

</script>

<header>
  <h1>gm/ID Workbench</h1>
  <datalist id="exprs">
    {#each exprOptions as o}
      <option value={o.value} label={o.label}></option>
    {/each}
  </datalist>
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
  <span class="grow"></span>
  <span class="device" title="active device">{device.id.device} · {device.id.corner} · {device.id.temp}°C</span>
  <label class="load">
    Load .csv
    <input
      type="file"
      accept=".csv,.txt,text/csv"
      onchange={(e) => loadFiles((e.currentTarget as HTMLInputElement).files)}
    />
  </label>
  <button class="btn demo" onclick={loadDemo}>demo</button>
  <button class="btn size" class:on={sizerOpen} onclick={() => (sizerOpen = !sizerOpen)} title={CONTROL_HELP.size}>size</button>
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
        >{d.table.id.device} · {d.table.id.corner} · {d.table.id.temp}°C</button>
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

  <nav class="tabs">
    {#each dashboard.tabs as tab, i}
      <button
        class="tab"
        class:on={i === dashboard.activeTab}
        onclick={() => (dashboard.activeTab = i)}
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
    {#if dashboard.tabs.length > 1}
      <button class="btn" onclick={() => removeTab(dashboard.activeTab)}>remove tab</button>
    {/if}
  </nav>

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
  <div class="grid" style:--cols={activeTab.cols}>
    {#each activeTab.panels as cfg (cfg.id)}
      <Panel
        {device}
        {overlays}
        sweep={dashboard.sweep}
        {sharedBias}
        {cfg}
        families={multiAxes}
        options={exprOptions}
        {styleVersion}
        onChange={(patch) => Object.assign(cfg, patch)}
        onRemove={() => removePanel(cfg.id)}
      />
    {/each}
    {#if activeTab.panels.length === 0}
      <p class="empty">no panels — use <strong>+ panel</strong> above</p>
    {/if}
  </div>
  {#if dragging}<div class="drophint">drop a mostab .csv</div>{/if}

  {#if sizerOpen}
    <aside class="sizer">
      <h2>size <small>bind any two</small> <Help text={CONTROL_HELP.bind} /></h2>
      <label>L
        <select bind:value={sizeL}>
          {#each lAxis?.values ?? [] as L}<option value={L}>{formatEng(L)}m</option>{/each}
        </select>
      </label>
      <label>gm/ID <input bind:value={inGmId} placeholder="S/A" spellcheck="false" /></label>
      <label>ID <input bind:value={inId} placeholder="A · e.g. 100u" spellcheck="false" /></label>
      <label>gm <input bind:value={inGm} placeholder="S" spellcheck="false" /></label>

      {#if Object.keys(sizingFixed).length}
        <p class="bias">
          bias · {Object.entries(sizingFixed)
            .map(([k, v]) => `${k}=${formatEng(v)}${axisUnit(k)}`)
            .join(' · ')}
        </p>
      {/if}

      {#if sizing.result}
        {@const r = sizing.result}
        <dl class="sz">
          <dt>W</dt><dd>{formatEng(r.W)}m</dd>
          <dt>vgs</dt><dd>{formatEng(r.vgs)}V</dd>
          <dt>gm/ID</dt><dd>{formatEng(r.gm_id)}</dd>
          <dt>ID</dt><dd>{formatEng(r.id)}A</dd>
          <dt>gm</dt><dd>{formatEng(r.gm)}S</dd>
          <dt>fT</dt><dd>{formatEng(r.quantities.ft)}Hz</dd>
          <dt>gm/gds</dt><dd>{formatEng(r.quantities.gm_gds)}</dd>
        </dl>
        <p class="feas {r.feasible ? 'ok' : 'bad'}">
          {r.feasible ? '✓ feasible' : '✗ infeasible'} · ceiling {formatEng(r.ceiling)}
        </p>
      {:else if sizing.err}
        <p class="err">{sizing.err}</p>
      {:else}
        <p class="hint">{sizing.hint}</p>
      {/if}

      <!-- Noise + matching params are device/PDK properties (seeded from metadata), so
           they show whenever the sizer is open; the budgets fill in once a geometry is
           sized. The 1/f corner is width-independent; the band sets the integration. -->
      <h3>noise <Help text={CONTROL_HELP.noise} /></h3>
      <p class="match-note">1/f corner · band, Hz{noiseFromMeta ? ' · corner from device' : ''}</p>
      <label><span>f<sub>co</sub> <Help text={CONTROL_HELP.fco} /></span> <input bind:value={inFco} placeholder="Hz · e.g. 1meg" spellcheck="false" /></label>
      <label><span>band <Help text={CONTROL_HELP.band} /></span> <span class="band"><input bind:value={inFlo} spellcheck="false" />–<input bind:value={inFhi} spellcheck="false" /></span></label>
      {#if noise}
        <!-- γ-model thermal noise uses the SIZED gm (noise ∝ 1/√gm). The table's stored
             `sth`/`sfl` PSDs are at the characterization width and are shown in Explore. -->
        <dl class="noise">
          <dt>v<sub>n,th</sub> <small>γ-model</small></dt>
          <dd>{formatEng(noise.density)}V/√Hz</dd>
          {#if noise.rms !== null}
            <dt>v<sub>n,rms</sub> <small>band</small></dt><dd>{formatEng(noise.rms)}V</dd>
          {/if}
        </dl>
      {/if}

      <h3>matching <Help text={CONTROL_HELP.matching} /></h3>
      <p class="match-note">A in mV·µm / %·µm{matchFromMeta ? ' · from device' : ''}</p>
      <label><span>A<sub>Vth</sub> <Help text={CONTROL_HELP.avth} /></span> <input bind:value={inAvth} placeholder="mV·µm" spellcheck="false" /></label>
      <label><span>A<sub>β</sub> <Help text={CONTROL_HELP.abeta} /></span> <input bind:value={inAbeta} placeholder="%·µm" spellcheck="false" /></label>
      {#if mism}
        <dl class="budget">
          <dt>σ(V<sub>th</sub>)</dt><dd>{formatEng(mism.sigmaVth)}V</dd>
          <dt>σ(V<sub>os</sub>) pair</dt><dd>{formatEng(mism.sigmaVos)}V</dd>
          <dt>σ(I)/I</dt><dd>{(mism.sigmaIrel * 100).toFixed(3)}%</dd>
        </dl>
      {/if}
    </aside>
  {/if}
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
  .err {
    color: #e6194b;
    font-family: ui-monospace, monospace;
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
  .sizer {
    width: 17rem;
    flex: none;
    overflow: auto;
    border-left: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    padding: 0.6rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .sizer h2 {
    font-size: 0.95rem;
    margin: 0;
  }
  .sizer h2 small {
    opacity: 0.5;
    font-weight: 400;
  }
  .sizer h3 {
    font-size: 0.85rem;
    margin: 0.5rem 0 0;
    padding-top: 0.5rem;
    border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  }
  .sizer label {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }
  .sizer input,
  .sizer select {
    width: 9rem;
    font: inherit;
    font-family: ui-monospace, monospace;
    padding: 0.1rem 0.3rem;
  }
  .band {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
  }
  .band input {
    width: 4rem;
  }
  .sz,
  .budget,
  .noise {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.12rem 0.6rem;
    margin: 0.3rem 0 0;
    font-family: ui-monospace, monospace;
  }
  .sz dt,
  .budget dt,
  .noise dt {
    opacity: 0.6;
  }
  .noise dt small {
    opacity: 0.7;
  }
  .sz dd,
  .budget dd,
  .noise dd {
    margin: 0;
    text-align: right;
  }
  .feas {
    margin: 0.2rem 0 0;
    font-family: ui-monospace, monospace;
  }
  .feas.ok {
    color: #3cb44b;
  }
  .feas.bad {
    color: #e6194b;
  }
  .bias,
  .match-note {
    margin: 0.1rem 0 0;
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
    opacity: 0.6;
  }
  .sizer .hint,
  .sizer .err {
    margin: 0.2rem 0 0;
    font-size: 0.92em;
  }
  .sizer .hint {
    opacity: 0.55;
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
