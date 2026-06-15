<script lang="ts">
  import {
    familyCurvesXY,
    invertX,
    lookup,
    subsample,
    formatEng,
    parseEng,
    BASE_QUANTITIES,
    type DeviceTable,
    type FamilyCurvesXY,
  } from '@gmid/mostab-core';
  import { ChartAdapter, PALETTE, type ChartData, type CursorInfo } from './chart';
  import { viridis, viridisGradient, LARGE_FAMILY } from './colormap';
  import { qLabel } from './labels';
  import { clampLegendCount, type Panel } from './dashboard';

  let {
    device,
    sweep,
    sharedBias,
    cfg,
    families,
    onChange,
    onRemove,
  }: {
    device: DeviceTable;
    sweep: string;
    sharedBias: Record<string, number>;
    cfg: Panel;
    families: string[];
    onChange: (patch: Partial<Panel>) => void;
    onRemove: () => void;
  } = $props();

  const baseUnit = new Map(BASE_QUANTITIES.map((q) => [q.key, q.unit]));
  const axisUnit = (name: string) => baseUnit.get(name) ?? '';

  // Pin every shared-bias axis except this panel's own family (which fans into the
  // curves); the sweep axis is consumed by familyCurvesXY itself. A panel whose
  // family sits on a bias slider simply ignores that slider — by omission.
  const pinned = $derived(
    Object.fromEntries(Object.entries(sharedBias).filter(([k]) => k !== cfg.family)),
  );

  // The raw family of curves. A degenerate X (flat / non-monotone along the sweep) or a
  // bad expression yields no curves and a message; the last good chart stays.
  const built = $derived.by(() => {
    try {
      const fc = familyCurvesXY(device, cfg.xExpr, cfg.yExpr, sweep, cfg.family || null, pinned);
      return fc.degenerate
        ? { fc: null as FamilyCurvesXY | null, err: fc.reason }
        : { fc, err: null as string | null };
    } catch (e) {
      return { fc: null as FamilyCurvesXY | null, err: (e as Error).message };
    }
  });

  // Decide how a many-valued family renders: a small family always uses the discrete
  // palette + per-curve legend; a large one defaults to a colormap+colorbar, or the
  // sampled subset the user chose. The SAME derived produces the drawn lines, their
  // colours, and the family value behind each drawn line (load-bearing for hover).
  const cbarGradient = viridisGradient();
  function resolveMode(fc: FamilyCurvesXY): 'discrete' | 'colorbar' | 'sample' {
    if (fc.famName === '' || fc.famValues.length <= LARGE_FAMILY) return 'discrete';
    return cfg.legend?.mode === 'sample' ? 'sample' : 'colorbar';
  }
  const display = $derived.by(() => {
    const fc = built.fc;
    if (!fc) return null;
    const nLines = fc.lines.length; // 1 when there's no family (famValues is then empty)
    const nFam = fc.famValues.length;
    const mode = resolveMode(fc);
    const famUnit = axisUnit(fc.famName);

    let drawIdx: number[];
    let lineColors: string[];
    if (mode === 'colorbar') {
      drawIdx = Array.from({ length: nLines }, (_, i) => i);
      lineColors = drawIdx.map((i) => viridis(nFam <= 1 ? 0.5 : i / (nFam - 1)));
    } else if (mode === 'sample') {
      drawIdx = subsample(fc.famValues, cfg.legend!.count, cfg.legend!.include);
      lineColors = drawIdx.map((_, k) => PALETTE[k % PALETTE.length]);
    } else {
      drawIdx = Array.from({ length: nLines }, (_, i) => i);
      lineColors = drawIdx.map((_, k) => PALETTE[k % PALETTE.length]);
    }

    const drawnFamValues = drawIdx.map((i) => fc.famValues[i]);
    const lineLabels =
      fc.famName === ''
        ? [device.id.device]
        : drawnFamValues.map((v) => `${fc.famName}=${formatEng(v)}${famUnit}`);
    const data: ChartData = {
      x: Array.from(fc.x),
      lines: drawIdx.map((i) => Array.from(fc.lines[i], (v) => (Number.isFinite(v) ? v : null))),
      lineLabels,
      lineColors,
    };
    return {
      mode,
      data,
      lineColors,
      drawnFamValues,
      famName: fc.famName,
      famUnit,
      famMin: nFam ? fc.famValues[0] : 0,
      famMax: nFam ? fc.famValues[nFam - 1] : 0,
    };
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
    const fixed: Record<string, number> = { ...pinned };
    // focusedLine indexes the DRAWN lines (a subset in sample mode), so map through
    // drawnFamValues — not fc.famValues — to get the correct family value.
    if (d.famName !== '') fixed[d.famName] = d.drawnFamValues[c.focusedLine];
    const v = invertX(device, cfg.xExpr, c.x, sweep, fixed);
    if (v == null) return null;
    try {
      const q = lookup(device, { [sweep]: v, ...fixed }, OP_FIELDS.map((f) => f[1]));
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
  $effect(() => {
    if (cfg.render !== 'chart' || !el || !display?.data) return;
    if (chart) chart.setData(display.data);
    else chart = new ChartAdapter(el, display.data, (info) => (cursor = info));
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

<div class="panel">
  <div class="ptools">
    <input
      class="ex"
      list="exprs"
      value={cfg.yExpr}
      onchange={(e) => onChange({ yExpr: (e.currentTarget as HTMLInputElement).value })}
      spellcheck="false"
      title="Y expression"
    />
    <span class="vs">vs</span>
    <input
      class="ex"
      list="exprs"
      value={cfg.xExpr}
      onchange={(e) => onChange({ xExpr: (e.currentTarget as HTMLInputElement).value })}
      spellcheck="false"
      title="X expression"
    />
    <select
      class="fam"
      value={cfg.family}
      onchange={(e) => onChange({ family: (e.currentTarget as HTMLSelectElement).value })}
      title="family axis"
    >
      <option value="">(none)</option>
      {#each families as f}<option value={f}>{f}</option>{/each}
    </select>
    <span class="grow"></span>
    <button
      class="rm"
      onclick={() => onChange({ render: cfg.render === 'chart' ? 'table' : 'chart' })}
      title="switch chart / table"
    >{cfg.render === 'chart' ? 'table' : 'chart'}</button>
    <button class="rm" onclick={onRemove} title="remove panel">×</button>
  </div>

  <!-- Dense-family legend control: only when the family has too many values to show
       a per-curve legend. Default colorbar; toggle to a sampled subset (N + includes). -->
  {#if built.fc && built.fc.famName !== '' && built.fc.famValues.length > LARGE_FAMILY}
    {@const lg = cfg.legend ?? { mode: 'colorbar' as const, count: 8, include: [] }}
    <div class="plegend">
      <button
        class="rm"
        onclick={() => onChange({ legend: { ...lg, mode: lg.mode === 'sample' ? 'colorbar' : 'sample' } })}
        title="legend for many curves"
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
        <span class="of">{built.fc.famValues.length} total</span>
      {/if}
    </div>
  {/if}

  {#if built.err}<p class="perr" title={built.err}>{built.err}</p>{/if}
  {#if built.fc?.warning}<p class="pwarn" title={built.fc.warning}>⚠ {built.fc.warning}</p>{/if}

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
    align-items: center;
    gap: 0.3rem;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
  }
  .ptools .grow {
    flex: 1 1 auto;
  }
  .ex {
    width: 5.5rem;
    font: inherit;
    font-family: ui-monospace, monospace;
    padding: 0.05rem 0.25rem;
  }
  .vs {
    opacity: 0.45;
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
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-top: 0.2rem;
    font-family: ui-monospace, monospace;
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
    flex: 1 1 auto;
    min-width: 5rem;
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
    display: flex;
  }
  .pchart {
    flex: 1 1 auto;
    min-height: 0;
    margin-left: 1.1em; /* room for the rotated Y-axis label strip */
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
    opacity: 0.7;
  }
  .ylabel {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 1.1em;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.82rem;
    opacity: 0.85;
  }
  .ylabel span {
    transform: rotate(-90deg);
    white-space: nowrap;
  }
  .xlabel {
    text-align: center;
    font-size: 0.82rem;
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
    background: Canvas;
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
