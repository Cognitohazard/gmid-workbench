<script lang="ts">
  import {
    generateDemoDevice,
    familyCurves,
    plottableQuantities,
    lookup,
    formatEng,
    BASE_QUANTITIES,
    DERIVED_QUANTITIES,
  } from '@gmid/mostab-core';
  import { untrack } from 'svelte';
  import { ChartAdapter, PALETTE, type ChartData, type CursorInfo } from './chart';

  // The device-level core is the single source of truth. The demo device stands
  // in until import lands; everything below is simulator-agnostic. A vds axis is
  // included so the N-D axis sliders have something to navigate.
  const X_AXIS = 'vgs';
  const FAM_AXIS = 'l';
  const device = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.05 } });

  // Axes the chart neither plots (X) nor fans out (family) get a slider — skip
  // degenerate (single-node) axes; familyCurves pins those at their only value.
  const fixedAxes = device.grid.axes.filter(
    (a) => a.name !== X_AXIS && a.name !== FAM_AXIS && a.values.length > 1,
  );
  const axisUnit = (name: string) => BASE_QUANTITIES.find((q) => q.key === name)?.unit ?? '';

  let expr = $state('gm/id');
  // Slider coordinate per fixed axis (interpolated; starts at the first node).
  let fixedVals = $state<Record<string, number>>(
    Object.fromEntries(fixedAxes.map((a) => [a.name, a.values[0]])),
  );
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

  // Effect A — create the chart once (depends only on the bound node).
  $effect(() => {
    const initial = untrack(() => built.data);
    if (!el || !initial) return;
    chart = new ChartAdapter(el, initial, (info) => (cursor = info));
    return () => {
      chart?.destroy();
      chart = undefined;
    };
  });

  // Effect B — push new data whenever the expression yields a valid build.
  $effect(() => {
    if (chart && built.data) chart.setData(built.data);
  });

  // The picker reflects what THIS table can chart as Y — core decides, accounting
  // for the family/fixed axes the per-curve slice collapses. Labels come from the
  // canonical namespace.
  const baseUnit = new Map(BASE_QUANTITIES.map((q) => [q.key, q.unit]));
  const derivedExpr = new Map(DERIVED_QUANTITIES.map((q) => [q.key, q.expr]));
  const plottable = plottableQuantities(device.grid, X_AXIS);
  const exprOptions = [
    ...plottable.base.map((k) => ({ value: k, label: `${k} [${baseUnit.get(k)}]` })),
    ...plottable.derived.map((k) => ({ value: k, label: `${k} = ${derivedExpr.get(k)}` })),
  ];

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
  <span class="note">X = vgs · family = L · device: demo nMOS (EKV)</span>
  {#if built.err}<span class="err">{built.err}</span>{/if}
</header>

<div class="chart" bind:this={el}></div>

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
  .chart {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
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
