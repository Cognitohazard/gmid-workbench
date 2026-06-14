<script lang="ts">
  import {
    generateDemoDevice,
    familyCurves,
    plottableQuantities,
    lookup,
    importMostab,
    sizeDevice,
    mismatch,
    thermalNoise,
    integratedNoise,
    fixTable,
    formatEng,
    parseEng,
    BASE_QUANTITIES,
    DERIVED_QUANTITIES,
    type QAWarning,
    type DeviceTable,
    type Grid,
  } from '@gmid/mostab-core';
  import { ChartAdapter, PALETTE, type ChartData, type CursorInfo } from './chart';

  // The device-level core is the single source of truth. The active device is
  // swappable at runtime by importing a mostab file; the demo (with a vds axis so
  // the N-D sliders have something to navigate) stands in until then.
  const newDemo = () => generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.05 } });

  const INITIAL_DEVICE = newDemo();
  let device = $state(INITIAL_DEVICE);
  let warnings = $state<readonly QAWarning[]>([]);
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

  // Sensible default X / family for a device: X = vgs if swept (else the first
  // swept axis); family = l if available (≠X, else the next swept axis, else none).
  function defaultAxes(dev: DeviceTable): { x: string; fam: string } {
    const multi = multiAxisNames(dev.grid);
    const x = multi.includes('vgs') ? 'vgs' : (multi[0] ?? dev.grid.axes[0]?.name ?? 'vgs');
    const fams = multi.filter((n) => n !== x);
    return { x, fam: fams.includes('l') ? 'l' : (fams[0] ?? '') };
  }

  const seed = defaultAxes(INITIAL_DEVICE);
  let xName = $state(seed.x);
  let famName = $state(seed.fam); // '' = no family (a single curve)
  // Re-seed X/family to sensible defaults whenever the device swaps.
  $effect(() => {
    const { x, fam } = defaultAxes(device);
    xName = x;
    famName = fam;
  });
  // Effective X / family, validated against the current device every render. This
  // keeps the CHART consistent even in the sub-frame before the re-seed effect
  // runs on a device swap (no error flash), and when X would equal family. The
  // dropdowns bind the raw selection; everything downstream uses the effective ones.
  const effX = $derived(
    multiAxes.includes(xName) ? xName : (multiAxes[0] ?? device.grid.axes[0]?.name ?? 'vgs'),
  );
  const effFam = $derived(
    famName !== '' && famName !== effX && multiAxes.includes(famName) ? famName : '',
  );

  let expr = $state('gm/id');

  // Axes that are neither X nor family get a slider (multi-value only).
  const fixedAxes = $derived(
    device.grid.axes.filter((a) => a.name !== effX && a.name !== effFam && a.values.length > 1),
  );
  // Slider coordinate per fixed axis (interpolated). Re-seeded to the current
  // axes' first nodes on any device/axis-role change — stale keys are ignored.
  const freshFixed = () => Object.fromEntries(fixedAxes.map((a) => [a.name, a.values[0]]));
  let fixedVals = $state<Record<string, number>>(freshFixed());
  $effect(() => {
    fixedVals = freshFixed(); // reads fixedAxes ⇒ re-runs on device/X/family change
  });

  let el: HTMLDivElement;
  let chart: ChartAdapter | undefined;
  let cursor = $state<CursorInfo | null>(null);

  // Family of curves (one per L) + chart-ready data for the current expression.
  // A bad expression keeps `err` and leaves the last good chart untouched.
  const built = $derived.by(() => {
    try {
      const fc = familyCurves(device, expr, effX, effFam || null, { ...fixedVals });
      const famUnit = axisUnit(fc.famName);
      const lineLabels =
        fc.famName === ''
          ? [device.id.device] // single curve: label it by the device
          : Array.from(fc.famValues, (v) => `${fc.famName}=${formatEng(v)}${famUnit}`);
      const data: ChartData = {
        x: Array.from(fc.x),
        lines: fc.lines.map((line) => Array.from(line, (v) => (Number.isFinite(v) ? v : null))),
        lineLabels,
        xLabel: fc.xName,
      };
      return { fc, data, err: null as string | null };
    } catch (e) {
      return { fc: null, data: null, err: (e as Error).message };
    }
  });

  // Always-visible color key for the L family (uPlot's own legend is off). The
  // single source of the family label + palette colour.
  const seriesKey = $derived(
    (built.data?.lineLabels ?? []).map((label, i) => ({ label, color: PALETTE[i % PALETTE.length] })),
  );

  // Full operating point at the hovered vgs on the focused L curve, via the core
  // lookup() — dogfooding the same interpolation the sizing tools use. Label +
  // colour reuse seriesKey so the family identity is defined in exactly one place.
  const opPoint = $derived.by(() => {
    const c = cursor;
    const fc = built.fc;
    if (!c || c.focusedLine == null || !fc) return null;
    const key = seriesKey[c.focusedLine];
    const point: Record<string, number> = { [fc.xName]: c.x, ...fixedVals };
    if (fc.famName !== '') point[fc.famName] = fc.famValues[c.focusedLine];
    try {
      const q = lookup(device, point, ['vgs', 'id', 'gm_id', 'vstar', 'gm_gds', 'ft']);
      return { label: key.label, color: key.color, q };
    } catch {
      return null;
    }
  });

  // Effect A — tear the chart down when the device swaps (its axis set / line
  // count can change, which uPlot fixes at construction) and on unmount. Effect B
  // rebuilds it for the new device. NOT triggered by expr/slider changes.
  $effect(() => {
    device; // destroy + rebuild on a device swap or an X/family role change
    effX;
    effFam;
    return () => {
      chart?.destroy();
      chart = undefined;
    };
  });

  // Effect B — create the chart when data is available, else push an update.
  // Creating-when-missing makes recovery automatic: after a build error clears
  // (or a new device loads), the next valid build rebuilds the chart. A null
  // build (bad expr / incompatible table) leaves the last chart untouched.
  $effect(() => {
    if (!el || !built.data) return;
    if (chart) chart.setData(built.data);
    else chart = new ChartAdapter(el, built.data, (info) => (cursor = info));
  });

  // The picker reflects what THIS table can chart as Y — core decides, accounting
  // for the family/fixed axes the per-curve slice collapses. Labels come from the
  // canonical namespace (baseUnit / derivedExpr).
  const plottable = $derived(plottableQuantities(device.grid, effX));
  const exprOptions = $derived([
    ...plottable.base.map((k) => ({ value: k, label: `${k} [${baseUnit.get(k)}]` })),
    ...plottable.derived.map((k) => ({ value: k, label: `${k} = ${derivedExpr.get(k)}` })),
  ]);

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
    swap(result.dataset.tables[0], result.dataset.warnings);
  }

  // Make `dev` the active device and reset the view around it.
  function swap(dev: DeviceTable, warns: readonly QAWarning[] = []): void {
    importError = null;
    warnings = warns;
    expr = 'gm/id'; // a column every valid table has
    device = dev; // triggers the reactive cascade
  }

  function loadDemo(): void {
    importSeq++; // invalidate any in-flight import
    swap(newDemo());
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

  const lAxis = $derived(device.grid.axes.find((a) => a.name === 'l'));
  $effect(() => {
    sizeL = lAxis ? lAxis.values[0] : NaN; // reset to the first L on a device swap
  });

  // Bias for sizing: every axis except l/vgs, fixed at the explore slider value
  // when shared (so you size at the bias you're viewing), else a mid node. Shown
  // in the panel so the operating point of W/vgs/fT/gm-gds is never implicit.
  const sizingFixed = $derived.by(() => {
    const out: Record<string, number> = {};
    for (const a of device.grid.axes) {
      if (a.name === 'l' || a.name === 'vgs') continue;
      out[a.name] = a.name in fixedVals ? fixedVals[a.name] : a.values[Math.floor(a.values.length / 2)];
    }
    return out;
  });

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

  // Footer operating-point readout: [display label, lookup key, unit].
  const OP_FIELDS: [string, string, string][] = [
    ['vgs', 'vgs', 'V'],
    ['gm/ID', 'gm_id', 'S/A'],
    ['V*', 'vstar', 'V'],
    ['gm/gds', 'gm_gds', ''],
    ['fT', 'ft', 'Hz'],
    ['ID', 'id', 'A'],
  ];

  const fmt = (v: number | null | undefined) => (v == null ? '—' : formatEng(v));
</script>

<header>
  <h1>gm/ID Workbench <small>· explore</small></h1>
  <label class="expr">
    Y =
    <input list="exprs" bind:value={expr} spellcheck="false" autocomplete="off" />
  </label>
  <datalist id="exprs">
    {#each exprOptions as o}
      <option value={o.value} label={o.label}></option>
    {/each}
  </datalist>
  {#each fixedAxes as a}
    <label class="slider">
      {a.name}
      <input
        type="range"
        min={a.values[0]}
        max={a.values[a.values.length - 1]}
        step={(a.values[a.values.length - 1] - a.values[0]) / 100}
        bind:value={fixedVals[a.name]}
      />
      <span class="val">{formatEng(fixedVals[a.name])}{axisUnit(a.name)}</span>
    </label>
  {/each}
  <label class="axis">X
    <select bind:value={xName}>
      {#each multiAxes.filter((n) => n !== famName) as ax}<option value={ax}>{ax}</option>{/each}
    </select>
  </label>
  <label class="axis">family
    <select bind:value={famName}>
      <option value="">(none)</option>
      {#each multiAxes.filter((n) => n !== xName) as ax}<option value={ax}>{ax}</option>{/each}
    </select>
  </label>
  {#if built.err}<span class="err">{built.err}</span>{/if}
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
  <button class="btn size" class:on={sizerOpen} onclick={() => (sizerOpen = !sizerOpen)}>size</button>
</header>

{#if importError}
  <div class="qa error">import failed — {importError}</div>
{:else if warnings.length}
  <div class="qa">
    <strong>QA</strong>
    {#each warnings as w}<span class="w {w.severity}" title={w.location ?? ''}>{w.rule}: {w.message}</span>{/each}
  </div>
{/if}

<div class="main">
  <div
    class="chart-wrap"
    class:dragging
    role="region"
    aria-label="chart — drop a mostab CSV here to load"
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    <div class="chart" bind:this={el}></div>
    {#if dragging}<div class="drophint">drop a mostab .csv</div>{/if}
  </div>

  {#if sizerOpen}
    <aside class="sizer">
      <h2>size <small>bind any two</small></h2>
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
      <h3>noise</h3>
      <p class="match-note">1/f corner · band, Hz{noiseFromMeta ? ' · corner from device' : ''}</p>
      <label>f<sub>co</sub> <input bind:value={inFco} placeholder="Hz · e.g. 1meg" spellcheck="false" /></label>
      <label>band <span class="band"><input bind:value={inFlo} spellcheck="false" />–<input bind:value={inFhi} spellcheck="false" /></span></label>
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

      <h3>matching</h3>
      <p class="match-note">A in mV·µm / %·µm{matchFromMeta ? ' · from device' : ''}</p>
      <label>A<sub>Vth</sub> <input bind:value={inAvth} placeholder="mV·µm" spellcheck="false" /></label>
      <label>A<sub>β</sub> <input bind:value={inAbeta} placeholder="%·µm" spellcheck="false" /></label>
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

{#snippet sw(color: string)}<i class="sw" style:background={color}></i>{/snippet}

<footer>
  {#if opPoint}
    <strong>{@render sw(opPoint.color)}{opPoint.label}</strong>
    {#each OP_FIELDS as [label, key, unit]}<span>{label} {fmt(opPoint.q[key])}{unit}</span>{/each}
  {:else if cursor}
    <span>vgs {fmt(cursor.x)}V</span>
    {#each cursor.perLine as p}<span>{@render sw(p.color)}{p.label} {fmt(p.value)}</span>{/each}
  {:else}
    {#each seriesKey as s}<span>{@render sw(s.color)}{s.label}</span>{/each}
    <span class="hint">hover a curve for its operating point</span>
  {/if}
</footer>

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
  h1 small {
    opacity: 0.55;
    font-weight: 400;
  }
  .expr input {
    width: 14rem;
    font: inherit;
    font-family: ui-monospace, monospace;
    padding: 0.15rem 0.4rem;
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
  .main {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .chart-wrap {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    position: relative;
    display: flex;
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
  .chart-wrap.dragging {
    outline: 2px dashed color-mix(in srgb, currentColor 50%, transparent);
    outline-offset: -4px;
  }
  .chart {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
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
  footer {
    display: flex;
    gap: 0.9rem;
    flex-wrap: wrap;
    align-items: baseline;
    padding: 0.4rem 0.75rem;
    border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    font-family: ui-monospace, monospace;
  }
  footer span {
    display: inline-flex;
    align-items: center;
  }
  .sw {
    display: inline-block;
    width: 0.7em;
    height: 0.7em;
    border-radius: 2px;
    margin-right: 0.35em;
  }
  footer .hint {
    opacity: 0.5;
    font-family: system-ui, sans-serif;
  }
</style>
