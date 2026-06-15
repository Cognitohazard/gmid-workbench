<script lang="ts">
  import { untrack } from 'svelte';
  import {
    overlayCurvesXY,
    familyUnionCount,
    invertX,
    lookup,
    subsample,
    formatEng,
    parseEng,
    BASE_QUANTITIES,
    type DeviceTable,
    type OverlayCurvesXY,
    type OverlayLine,
  } from '@gmid/mostab-core';
  import { ChartAdapter, PALETTE, type ChartData, type CursorInfo } from './chart';
  import { viridis, viridisGradient, LARGE_FAMILY } from './colormap';
  import { qLabel } from './labels';
  import { QUANTITY_HELP, CONTROL_HELP } from './help';
  import Help from './Help.svelte';
  import { clampLegendCount, type Panel } from './dashboard';

  let {
    device,
    overlays = [],
    sweep,
    sharedBias,
    cfg,
    families,
    options,
    styleVersion,
    onChange,
    onRemove,
  }: {
    device: DeviceTable;
    overlays?: DeviceTable[];
    sweep: string;
    sharedBias: Record<string, number>;
    cfg: Panel;
    families: string[];
    options: { value: string; label: string }[];
    styleVersion: number;
    onChange: (patch: Partial<Panel>) => void;
    onRemove: () => void;
  } = $props();

  // Axis picker: a dropdown of the quantities this device computes, with a custom-expression
  // escape hatch. A panel is in custom mode when the user chose "ƒx custom…" OR the stored
  // expression isn't a known option (e.g. a typed expression restored from a saved layout) —
  // so a custom expression is shown in its text field and never silently dropped.
  const optionValues = $derived(new Set(options.map((o) => o.value)));
  let yCustom = $state(false);
  let xCustom = $state(false);
  const setCustom = (which: 'x' | 'y', v: boolean) => {
    if (which === 'y') yCustom = v;
    else xCustom = v;
  };
  const setExpr = (which: 'x' | 'y', v: string) =>
    onChange(which === 'y' ? { yExpr: v } : { xExpr: v });
  function onPickAxis(which: 'x' | 'y', v: string): void {
    if (v === '__custom__') {
      setCustom(which, true); // reveal the text field, keep the current expression to edit
      return;
    }
    setCustom(which, false);
    setExpr(which, v);
  }
  // Return to the dropdown: leave custom mode, snapping a non-option expression back to a
  // known quantity so the select has something to show (the typed expression is abandoned).
  function backToList(which: 'x' | 'y'): void {
    setCustom(which, false);
    const cur = which === 'y' ? cfg.yExpr : cfg.xExpr;
    if (!optionValues.has(cur)) setExpr(which, options[0]?.value ?? 'id');
  }

  const baseUnit = new Map(BASE_QUANTITIES.map((q) => [q.key, q.unit]));
  const axisUnit = (name: string) => baseUnit.get(name) ?? '';

  // Primary first, then overlays — `meta.tableIndex` indexes this list.
  const tablesAll = $derived([device, ...overlays]);
  const overlaid = $derived(overlays.length > 0);
  // Dash by device: the primary (table 0) is always solid; overlays cycle dash-only patterns so
  // no overlay can ever render solid and be mistaken for the active device (even at table 4, 8…).
  const OVERLAY_DASHES: number[][] = [[6, 3], [2, 3], [6, 3, 2, 3], [1, 2]];
  const dashFor = (tableIndex: number): number[] | null =>
    tableIndex === 0 ? null : OVERLAY_DASHES[(tableIndex - 1) % OVERLAY_DASHES.length];

  // Pin every shared-bias axis except this panel's own family (which fans into the
  // curves); the sweep axis is consumed by overlayCurvesXY itself. A panel whose
  // family sits on a bias slider simply ignores that slider — by omission.
  const pinned = $derived(
    Object.fromEntries(Object.entries(sharedBias).filter(([k]) => k !== cfg.family)),
  );

  // The overlaid family of curves across the primary + any overlay devices, on one shared X
  // lattice. A degenerate X or bad expression yields no curves and a message; the last good
  // chart stays. Phase 1 draws overlays only for a DISCRETE (small) family — with overlays and
  // a dense family, fall back to the primary alone and note it; the colorbar/sample machinery
  // below is therefore always single-device.
  const built = $derived.by(() => {
    try {
      // Gate a dense overlay from the cheap count up front, so we never build curves we'd discard.
      const famCount = overlaid ? familyUnionCount([device, ...overlays], cfg.family) : 0;
      const gated = famCount > LARGE_FAMILY ? famCount : 0;
      const tables = gated ? [device] : [device, ...overlays];
      const ov = overlayCurvesXY(tables, cfg.xExpr, cfg.yExpr, sweep, cfg.family || null, pinned);
      // Nothing drawable (a degenerate single device, or every table failed) is a blocking
      // message; a partial failure (some tables drew) surfaces per-table below instead.
      const err = ov.lines.length === 0 ? (ov.notes.find((n) => n) ?? null) : null;
      return { ov, err, gated };
    } catch (e) {
      return { ov: null as OverlayCurvesXY | null, err: (e as Error).message, gated: 0 };
    }
  });

  // Decide how a many-valued family renders: a small family always uses the discrete palette +
  // per-curve legend; a large one defaults to a colormap+colorbar, or the sampled subset chosen.
  const cbarGradient = viridisGradient();
  function resolveMode(ov: OverlayCurvesXY): 'discrete' | 'colorbar' | 'sample' {
    if (ov.famName === '' || ov.famValues.length <= LARGE_FAMILY) return 'discrete';
    return cfg.legend?.mode === 'sample' ? 'sample' : 'colorbar';
  }
  // Produces the drawn lines, their colours (family value → colour on the shared scale), their
  // dashes (device → dash), and the meta behind each drawn line (load-bearing for hover).
  const display = $derived.by(() => {
    const ov = built.ov;
    if (!ov || ov.lines.length === 0) return null;
    const nFam = ov.famValues.length;
    const mode = resolveMode(ov);
    const famUnit = axisUnit(ov.famName);
    const famMin = nFam ? ov.famValues[0] : 0;
    const famMax = nFam ? ov.famValues[nFam - 1] : 0;
    const famIndex = new Map(Array.from(ov.famValues, (v, i) => [v, i] as const));

    // Which curves to draw: sample thins a dense family; otherwise draw all. Sample mode is
    // always single-device (the dense-overlay gate), so subsample's family-value indices ARE
    // the line indices.
    const keep =
      mode === 'sample'
        ? subsample(ov.famValues, cfg.legend!.count, cfg.legend!.include)
        : ov.lines.map((_, k) => k);

    const drawnMeta = keep.map((k) => ov.meta[k]);
    const colourOf = (m: OverlayLine, pos: number): string => {
      if (mode === 'colorbar') return viridis(nFam <= 1 ? 0.5 : (m.famValue - famMin) / (famMax - famMin || 1));
      if (mode === 'sample') return PALETTE[pos % PALETTE.length]; // single device, sequential
      // discrete: colour by family-value index so the same value matches across devices
      const fi = Number.isFinite(m.famValue) ? (famIndex.get(m.famValue) ?? pos) : pos;
      return PALETTE[fi % PALETTE.length];
    };
    const labelOf = (m: OverlayLine): string => {
      const dev = tablesAll[m.tableIndex] ?? device;
      const fam = ov.famName !== '' && Number.isFinite(m.famValue) ? `${ov.famName}=${formatEng(m.famValue)}${famUnit}` : '';
      if (!overlaid) return fam || dev.id.device;
      return fam ? `${dev.id.device} ${fam}` : dev.id.device;
    };

    const lineColors = drawnMeta.map((m, p) => colourOf(m, p));
    const data: ChartData = {
      x: Array.from(ov.x),
      lines: keep.map((k) => Array.from(ov.lines[k], (v) => (Number.isFinite(v) ? v : null))),
      lineLabels: drawnMeta.map(labelOf),
      lineColors,
      lineDash: drawnMeta.map((m) => dashFor(m.tableIndex)),
    };
    return { mode, data, lineColors, drawnMeta, famName: ov.famName, famUnit, famMin, famMax };
  });

  const seriesKey = $derived(
    (display?.data.lineLabels ?? []).map((label, i) => ({ label, color: display!.lineColors[i] })),
  );

  let el = $state<HTMLDivElement>();
  let chart: ChartAdapter | undefined;
  let cursor = $state<CursorInfo | null>(null);

  // Full operating point under the cursor: recover the sweep coordinate (vgs) behind the
  // hovered X value on the focused curve (invertX), then look up the device there — the
  // same rich readout the old explore view had, now per panel. Falls back to the per-line
  // values when no curve is focused or the point can't be inverted/looked up.
  const OP_FIELDS: [string, string, string][] = [
    ['vgs', 'vgs', 'V'],
    ['gm/ID', 'gm_id', 'S/A'],
    ['V*', 'vstar', 'V'],
    ['gm/gds', 'gm_gds', ''],
    ['fT', 'ft', 'Hz'],
    ['ID', 'id', 'A'],
  ];
  const opPoint = $derived.by(() => {
    const c = cursor;
    const d = display;
    if (!c || c.focusedLine == null || !d) return null;
    // focusedLine indexes the DRAWN lines (a subset in sample mode); its meta carries the
    // source table + family value, so invert/look up against THAT device's own grid.
    const m = d.drawnMeta[c.focusedLine];
    if (!m) return null;
    const dev = tablesAll[m.tableIndex] ?? device;
    const fixed: Record<string, number> = { ...pinned };
    if (d.famName !== '' && Number.isFinite(m.famValue)) fixed[d.famName] = m.famValue;
    const v = invertX(dev, cfg.xExpr, c.x, sweep, fixed);
    if (v == null) return null;
    try {
      const q = lookup(dev, { [sweep]: v, ...fixed }, OP_FIELDS.map((f) => f[1]));
      return { label: seriesKey[c.focusedLine]?.label ?? '', color: d.lineColors[c.focusedLine] ?? '', q };
    } catch {
      return null;
    }
  });

  // Destroy the chart only when this panel stops showing one (chart → table) or unmounts.
  // Data/axis changes are handled by setData below — including a line-count or colour change,
  // which ChartAdapter rebuilds internally — so a bad expression leaves the last good chart up.
  $effect(() => {
    cfg.render;
    return () => {
      chart?.destroy();
      chart = undefined;
    };
  });
  // Create when data first arrives, else refit in place. A null build (bad expr / degenerate)
  // leaves the chart untouched.
  let builtStyle = -1; // the styleVersion the live chart was last built / restyled at
  $effect(() => {
    if (cfg.render !== 'chart' || !el || !display?.data) return;
    if (chart) chart.setData(display.data);
    else {
      chart = new ChartAdapter(el, display.data, (info) => (cursor = info));
      builtStyle = untrack(() => styleVersion); // a fresh build already reflects the current style
    }
  });
  // Rebuild the chart only when the theme or tick-font setting changed since it was last built —
  // the chart reads its colour and tick font from CSS only at construction. The version guard
  // skips redundantly rebuilding a chart just created at this style (e.g. every panel on first
  // load, where styleVersion bumps to 1 around chart creation).
  $effect(() => {
    if (chart && styleVersion !== builtStyle) {
      chart.restyle();
      builtStyle = styleVersion;
    }
  });

  const fmt = (v: number | null | undefined) =>
    v == null || Number.isNaN(v) ? '—' : formatEng(v);
  // Parse the "always include" field: comma-separated family values (engineering notation).
  const parseIncludes = (s: string): number[] =>
    s
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        try {
          return parseEng(t);
        } catch {
          return NaN;
        }
      })
      .filter((x) => Number.isFinite(x))
      .slice(0, 32);
</script>

{#snippet sw(color: string)}<i class="sw" style:background={color}></i>{/snippet}

<!-- One axis control: a dropdown of computable quantities + a "ƒx custom…" entry that
     swaps to a datalist-backed text field for a typed expression. -->
{#snippet axis(which: 'x' | 'y', label: string)}
  {@const expr = which === 'y' ? cfg.yExpr : cfg.xExpr}
  {@const custom = (which === 'y' ? yCustom : xCustom) || !optionValues.has(expr)}
  <span class="axl">{label}</span>
  {#if custom}
    <input
      class="ex"
      list="exprs"
      value={expr}
      onchange={(e) => setExpr(which, (e.currentTarget as HTMLInputElement).value)}
      spellcheck="false"
      title={`${label}: ${CONTROL_HELP.custom}`}
    />
    <button class="rm tiny" onclick={() => backToList(which)} title="back to the list">↩</button>
  {:else}
    <select
      class="exsel"
      value={expr}
      onchange={(e) => onPickAxis(which, (e.currentTarget as HTMLSelectElement).value)}
      title="{label} quantity"
    >
      {#each options as o}<option value={o.value}>{o.label}</option>{/each}
      <option value="__custom__">ƒx custom…</option>
    </select>
  {/if}
  {#if QUANTITY_HELP[expr]}<Help text={QUANTITY_HELP[expr]} />{/if}
{/snippet}

<div class="panel">
  <div class="ptools">
    {@render axis('y', 'Y')}
    {@render axis('x', 'X')}
    <select
      class="fam"
      value={cfg.family}
      onchange={(e) => onChange({ family: (e.currentTarget as HTMLSelectElement).value })}
      title="family axis"
    >
      <option value="">(none)</option>
      {#each families as f}<option value={f}>{f}</option>{/each}
    </select>
    <Help text={CONTROL_HELP.family} />
    <!-- Legend control for a dense family — lives in the toolbar (not its own row) so it
         never steals height from the plot. Only shown when the family has too many values
         for a per-curve legend; default colorbar, toggle to a sampled subset (N + includes). -->
    {#if built.ov && built.ov.famName !== '' && built.ov.famValues.length > LARGE_FAMILY}
      {@const lg = cfg.legend ?? { mode: 'colorbar' as const, count: 8, include: [] }}
      <span class="plegend">
        <button
          class="rm"
          onclick={() => onChange({ legend: { ...lg, mode: lg.mode === 'sample' ? 'colorbar' : 'sample' } })}
          title="many curves: a colour scale + colorbar, or a sampled subset with a legend"
        >{lg.mode === 'sample' ? 'sample' : 'colorbar'}</button>
        {#if lg.mode === 'sample'}
          <label
            >N
            <input
              class="num"
              type="number"
              min="2"
              max="32"
              value={lg.count}
              onchange={(e) =>
                onChange({ legend: { ...lg, count: clampLegendCount(+(e.currentTarget as HTMLInputElement).value) } })}
            /></label
          >
          <input
            class="inc"
            placeholder="include e.g. 0.5, 0.7"
            title="family values to always show"
            value={lg.include.map((v) => formatEng(v)).join(', ')}
            onchange={(e) =>
              onChange({ legend: { ...lg, include: parseIncludes((e.currentTarget as HTMLInputElement).value) } })}
          />
          <span class="of">{built.ov.famValues.length} total</span>
        {/if}
      </span>
    {/if}
    <span class="grow"></span>
    <button
      class="rm"
      onclick={() => onChange({ render: cfg.render === 'chart' ? 'table' : 'chart' })}
      title="switch chart / table"
    >{cfg.render === 'chart' ? 'table' : 'chart'}</button>
    <button class="rm" onclick={onRemove} title="remove panel">×</button>
  </div>

  {#if built.err}<p class="perr" title={built.err}>{built.err}</p>{/if}
  {#if built.ov?.warning}<p class="pwarn" title={built.ov.warning}>⚠ {built.ov.warning}</p>{/if}
  {#if built.gated}<p class="pwarn">⚠ overlay hidden — {built.gated} family values exceed {LARGE_FAMILY}; showing the active device only</p>{/if}
  <!-- Per-table failures (e.g. one overlay degenerate) — only while others still draw; a fully
       undrawable panel reports through .perr above. -->
  {#if display}
    {#each built.ov?.notes ?? [] as note, t}
      {#if note}<p class="pwarn" title={note}>⚠ {tablesAll[t]?.id.device ?? `table ${t}`}: {note}</p>{/if}
    {/each}
  {/if}

  {#if cfg.render === 'chart'}
    <div class="plotwrap">
      <div class="ylabel"><span>{@html qLabel(cfg.yExpr)}</span></div>
      <div class="pchart" bind:this={el}></div>
      {#if display && display.mode === 'colorbar'}
        <div class="cbar" aria-hidden="true">
          <span class="ct">{formatEng(display.famMax)}{display.famUnit}</span>
          <div class="cstrip" style:background={cbarGradient}></div>
          <span class="ct">{formatEng(display.famMin)}{display.famUnit}</span>
          <div class="clabel">{@html qLabel(display.famName)}</div>
        </div>
      {/if}
    </div>
    <div class="xlabel">{@html qLabel(cfg.xExpr)}</div>
  {:else if display?.data}
    <div class="ptable">
      <table>
        <thead>
          <tr>
            <th>{@html qLabel(cfg.xExpr)}</th>
            {#each seriesKey as s}<th>{@render sw(s.color)}{s.label}</th>{/each}
          </tr>
        </thead>
        <tbody>
          {#each display.data.x as xv, r}
            <tr>
              <td>{fmt(xv)}</td>
              {#each display.data.lines as line}<td>{fmt(line[r])}</td>{/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="pfoot">
    {#if opPoint}
      <strong>{@render sw(opPoint.color)}{opPoint.label}</strong>
      {#each OP_FIELDS as [label, key, unit]}<span>{label} {fmt(opPoint.q[key])}{unit}</span>{/each}
    {:else if display && display.mode === 'colorbar'}
      <span class="hint">hover a curve · color = {@html qLabel(display.famName)}</span>
    {:else if cursor}
      <span class="x">{cfg.xExpr} {fmt(cursor.x)}</span>
      {#each cursor.perLine as p}<span>{@render sw(p.color)}{fmt(p.value)}</span>{/each}
    {:else}
      {#each seriesKey as s}<span>{@render sw(s.color)}{s.label}</span>{/each}
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 300px;
    min-width: 0;
    border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    border-radius: 5px;
    padding: 0.35rem 0.45rem;
  }
  .ptools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
  }
  .ptools .grow {
    flex: 1 1 auto;
  }
  .axl {
    opacity: 0.55;
    font-weight: 600;
  }
  .exsel {
    font: inherit;
    max-width: 9rem;
  }
  .ex {
    width: 8rem;
    font: inherit;
    font-family: ui-monospace, monospace;
    padding: 0.05rem 0.25rem;
  }
  .tiny {
    padding: 0 0.3rem;
  }
  .fam {
    font: inherit;
  }
  .rm {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 4px;
    padding: 0 0.35rem;
    line-height: 1.4;
  }
  .perr,
  .pwarn {
    margin: 0.15rem 0 0;
    color: #d98e00;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pwarn {
    opacity: 0.8;
  }
  .plegend {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    opacity: 0.9;
  }
  .plegend label {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }
  .num {
    width: 2.8rem;
    font: inherit;
    font-family: ui-monospace, monospace;
  }
  .inc {
    width: 9rem;
    font: inherit;
    font-family: ui-monospace, monospace;
    padding: 0.05rem 0.25rem;
  }
  .of {
    opacity: 0.55;
    white-space: nowrap;
  }
  .plotwrap {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
  }
  .pchart {
    flex: 1 1 auto;
    min-height: 0;
    /* min-width:0 lets the chart shrink below the uPlot canvas's current width when the column
       count grows (else a chart sized in 1-col can't shrink back and overflows its neighbor). */
    min-width: 0;
    /* room for the rotated Y-axis label strip; tracks the axis-title font so a larger title
       can't overlap the plot. */
    margin-left: calc(var(--font-axis-title) + 0.5rem);
  }
  .cbar {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    width: 2.6rem;
    padding-left: 0.2rem;
    font-size: 0.68rem;
    opacity: 0.85;
  }
  .cstrip {
    flex: 1 1 auto;
    width: 0.7rem;
    border-radius: 2px;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  }
  .ct {
    white-space: nowrap;
  }
  .clabel {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: var(--font-axis-title);
    opacity: 0.7;
  }
  .ylabel {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: calc(var(--font-axis-title) + 0.5rem);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--font-axis-title);
    opacity: 0.85;
  }
  .ylabel span {
    transform: rotate(-90deg);
    white-space: nowrap;
  }
  .xlabel {
    text-align: center;
    font-size: var(--font-axis-title);
    opacity: 0.85;
    padding-top: 0.05rem;
  }
  .ptable {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    margin-top: 0.25rem;
  }
  .ptable table {
    border-collapse: collapse;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    width: 100%;
  }
  .ptable th,
  .ptable td {
    padding: 0.05rem 0.5rem;
    text-align: right;
    white-space: nowrap;
  }
  .ptable th {
    position: sticky;
    top: 0;
    background: var(--bg);
    text-align: right;
    font-weight: 600;
    border-bottom: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  }
  .ptable th:first-child,
  .ptable td:first-child {
    text-align: left;
    opacity: 0.6;
  }
  .pfoot {
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 0.7rem;
    align-items: center;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    opacity: 0.85;
    padding-top: 0.2rem;
  }
  .pfoot span {
    display: inline-flex;
    align-items: center;
  }
  .pfoot .x {
    opacity: 0.6;
  }
  .sw {
    display: inline-block;
    width: 0.65em;
    height: 0.65em;
    border-radius: 2px;
    margin-right: 0.3em;
  }
</style>
