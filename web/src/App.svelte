<script lang="ts">
  import {
    generateDemoDevice,
    familyCurves,
    plottableQuantities,
    lookup,
    importMostab,
    formatEng,
    BASE_QUANTITIES,
    DERIVED_QUANTITIES,
    type QAWarning,
    type DeviceTable,
  } from '@gmid/mostab-core';
  import { ChartAdapter, PALETTE, type ChartData, type CursorInfo } from './chart';

  // The device-level core is the single source of truth. The active device is
  // swappable at runtime by importing a mostab file; the demo (with a vds axis so
  // the N-D sliders have something to navigate) stands in until then.
  const X_AXIS = 'vgs';
  const FAM_AXIS = 'l';
  const newDemo = () => generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.05 } });

  let device = $state(newDemo());
  let warnings = $state<readonly QAWarning[]>([]);
  let importError = $state<string | null>(null);
  let dragging = $state(false);

  // Axes the chart neither plots (X) nor fans out (family) get a slider — skip
  // degenerate (single-node) axes; familyCurves pins those at their only value.
  const fixedAxes = $derived(
    device.grid.axes.filter(
      (a) => a.name !== X_AXIS && a.name !== FAM_AXIS && a.values.length > 1,
    ),
  );
  // Canonical key → display metadata (static; reused by the picker and sliders).
  const baseUnit = new Map(BASE_QUANTITIES.map((q) => [q.key, q.unit]));
  const derivedExpr = new Map(DERIVED_QUANTITIES.map((q) => [q.key, q.expr]));
  const axisUnit = (name: string) => baseUnit.get(name) ?? '';

  let expr = $state('gm/id');
  // Slider coordinate per fixed axis (interpolated). Re-seeded to the new axes'
  // first nodes on every device swap — familyCurves ignores any stale keys.
  const freshFixed = () => Object.fromEntries(fixedAxes.map((a) => [a.name, a.values[0]]));
  let fixedVals = $state<Record<string, number>>(freshFixed());
  $effect(() => {
    fixedVals = freshFixed(); // reads fixedAxes ⇒ re-runs when the device swaps
  });

  let el: HTMLDivElement;
  let chart: ChartAdapter | undefined;
  let cursor = $state<CursorInfo | null>(null);

  // Family of curves (one per L) + chart-ready data for the current expression.
  // A bad expression keeps `err` and leaves the last good chart untouched.
  const built = $derived.by(() => {
    try {
      const fc = familyCurves(device, expr, X_AXIS, FAM_AXIS, { ...fixedVals });
      const data: ChartData = {
        x: Array.from(fc.x),
        lines: fc.lines.map((line) => Array.from(line, (v) => (Number.isFinite(v) ? v : null))),
        lineLabels: Array.from(fc.famValues, (L) => `${fc.famName}=${formatEng(L)}m`),
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
    try {
      const q = lookup(device, { l: fc.famValues[c.focusedLine], vgs: c.x, ...fixedVals }, ['vgs', 'id', 'gm_id', 'vstar', 'gm_gds', 'ft']);
      return { label: key.label, color: key.color, q };
    } catch {
      return null;
    }
  });

  // Effect A — tear the chart down when the device swaps (its axis set / line
  // count can change, which uPlot fixes at construction) and on unmount. Effect B
  // rebuilds it for the new device. NOT triggered by expr/slider changes.
  $effect(() => {
    device; // dependency: destroy on swap, then let Effect B rebuild
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
  const plottable = $derived(plottableQuantities(device.grid, X_AXIS));
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
  <span class="note">X = vgs · family = L</span>
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
  <button class="demo" onclick={loadDemo}>demo</button>
</header>

{#if importError}
  <div class="qa error">import failed — {importError}</div>
{:else if warnings.length}
  <div class="qa">
    <strong>QA</strong>
    {#each warnings as w}<span class="w {w.severity}" title={w.location ?? ''}>{w.rule}: {w.message}</span>{/each}
  </div>
{/if}

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
  .note {
    opacity: 0.55;
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
  .demo {
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
  .chart-wrap {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    display: flex;
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
