<script lang="ts">
  // A leaf design-sheet panel: pick a vetted example, tune the design variables, and
  // watch the author equations and pass/fail constraints recompute with signed margins.
  // It holds no numerics — runSheet (core) does all evaluation and never throws.
  import { untrack } from 'svelte';
  import {
    runSheet,
    sweepSheet,
    formatEng,
    joinProvide,
    EXAMPLES,
    type DeviceTable,
    type SheetDoc,
    type RuleStatus,
  } from '@gmid/mostab-core';
  import { ChartAdapter, type ChartData } from './chart';
  import { CONTROL_HELP } from './help';

  let {
    device,
    cfg,
    sweep = '',
    styleVersion = 0,
    onChange,
    onSweep,
  }: {
    device: DeviceTable;
    cfg: SheetDoc;
    sweep?: string;
    styleVersion?: number;
    onChange: (s: SheetDoc) => void;
    onSweep: (s: string) => void;
  } = $props();

  const result = $derived(runSheet(cfg, device));

  // ── Feasibility sweep: vary one slider parameter across its range and chart every rule's
  // relative margin. Only finitely-bounded params can be swept (the sweep walks [min,max]).
  const sweepable = $derived(
    cfg.params.filter(
      (p) =>
        p.min !== undefined && p.max !== undefined && Number.isFinite(p.min) && Number.isFinite(p.max) && p.max > p.min,
    ),
  );
  // The active sweep param, ignoring a stale selection that no longer names a sweepable var.
  const active = $derived(sweep && sweepable.some((p) => p.name === sweep) ? sweep : '');
  const swept = $derived(active ? sweepSheet(cfg, active, device) : null);

  // One line per rule, margin as a percentage; guardrails dashed (advisory, never gate). The
  // y = 0 gridline is the constraint boundary; PALETTE cycles the colours by default.
  const chartData = $derived.by((): ChartData | null => {
    if (!swept || swept.x.length === 0) return null;
    return {
      x: swept.x,
      lines: swept.rules.map((r) => r.marginPct.map((m) => (m == null ? null : m * 100))),
      lineLabels: swept.rules.map((r) => r.id),
      lineDash: swept.rules.map((r) => (r.kind === 'guardrail' ? [4, 3] : null)),
    };
  });

  // The contiguous span of the swept param where the whole design closes (the feasibility window).
  const feasWindow = $derived.by(() => {
    if (!swept || swept.feasible.length === 0) return null;
    const idx = swept.feasible.flatMap((f, i) => (f ? [i] : []));
    if (idx.length === 0) return { none: true as const };
    const lo = idx[0];
    const hi = idx[idx.length - 1];
    return { none: false as const, lo: swept.x[lo], hi: swept.x[hi], gap: idx.length !== hi - lo + 1 };
  });

  // The embedded uPlot chart, owned outside Svelte (mirrors Panel.svelte's lifecycle): rebuilt on
  // entering/leaving sweep mode, refit in place on data edits, restyled on a theme/font change.
  let el: HTMLDivElement | undefined = $state();
  let chart: ChartAdapter | undefined;
  let builtStyle = 0;
  $effect(() => {
    void active; // destroy when the sweep is turned off or the panel unmounts
    return () => {
      chart?.destroy();
      chart = undefined;
    };
  });
  $effect(() => {
    if (!active || !el || !chartData) return;
    if (chart) chart.setData(chartData);
    else {
      chart = new ChartAdapter(el, chartData);
      builtStyle = untrack(() => styleVersion);
    }
  });
  $effect(() => {
    if (chart && styleVersion !== builtStyle) {
      chart.restyle();
      builtStyle = styleVersion;
    }
  });

  // Immutable edits: every change emits a fresh doc so the parent's Object.assign + persist
  // path (identical to every other panel) carries it. structuredClone on example-switch so a
  // panel never aliases the shared EXAMPLES literal.
  function setParam(name: string, value: number): void {
    if (!Number.isFinite(value)) return;
    onChange({ ...cfg, params: cfg.params.map((p) => (p.name === name ? { ...p, value } : p)) });
  }
  function pickExample(e: Event): void {
    const sel = e.currentTarget as HTMLSelectElement;
    const i = Number(sel.value);
    if (Number.isInteger(i) && i >= 0 && i < EXAMPLES.length) onChange(structuredClone(EXAMPLES[i]));
    sel.value = '';
  }

  const fmt = (v: number | undefined): string =>
    v == null || !Number.isFinite(v) ? '—' : formatEng(v);
  const pct = (v: number): string =>
    Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : '—';
  const CHIP: Record<RuleStatus, string> = { pass: '✓', amber: '≈', fail: '✗', na: '—' };
</script>

<div class="sheet">
  <div class="shead">
    <select class="rm" onchange={pickExample} title={CONTROL_HELP.sheet}>
      <option value="" selected>example…</option>
      {#each EXAMPLES as ex, i}<option value={i}>{ex.title}</option>{/each}
    </select>
    <strong>{cfg.title}</strong>
    {#if result.bind}
      {#if result.bind.ok}
        <span class="bind">W={fmt(result.bind.W)}m · V<sub>GS</sub>={fmt(result.bind.vgs)}V · I<sub>D</sub>={fmt(result.bind.id)}A</span>
      {:else}
        <span class="perr" title={result.bind.error}>sizing: {result.bind.error}</span>
      {/if}
    {/if}
    {#if sweepable.length}
      <label class="swsel" title={CONTROL_HELP.sheetSweep}>
        sweep
        <select value={active} onchange={(e) => onSweep((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">off</option>
          {#each sweepable as p}<option value={p.name}>{p.name}</option>{/each}
        </select>
      </label>
    {/if}
  </div>

  <div class="svars">
    {#each cfg.params as p}
      <label class="svar">
        <span class="vn">{p.name}{#if p.unit}<i>{p.unit}</i>{/if}</span>
        <input
          class="num"
          type="number"
          value={p.value}
          onchange={(e) => setParam(p.name, +(e.currentTarget as HTMLInputElement).value)}
        />
        {#if p.min !== undefined && p.max !== undefined}
          <input
            class="sld"
            type="range"
            min={p.min}
            max={p.max}
            step={(p.max - p.min) / 100}
            value={p.value}
            oninput={(e) => setParam(p.name, +(e.currentTarget as HTMLInputElement).value)}
          />
        {/if}
      </label>
    {/each}
  </div>

  {#if result.children?.length}
    <div class="suses">
      {#each result.children as c}
        <div class="suse st-{c.feasible ? 'pass' : 'fail'}" title={c.title}>
          <span class="chip">{c.feasible ? '✓' : '✗'}</span>
          <b>{c.name}</b><i>{c.title}</i>
          <span class="prov">{#each Object.entries(c.provides) as [k, v]}<code>{joinProvide(c.name, k)}={fmt(v)}</code>{/each}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if cfg.rows.length}
    <div class="srows">
      {#each cfg.rows as row}
        <span class="srow"><b>{row.name}</b> = <code>{row.expr}</code> = {fmt(result.values[row.name])}{row.unit ?? ''}</span>
      {/each}
    </div>
  {/if}

  <table class="srules">
    <tbody>
      {#each result.rules as r}
        <tr class="st-{r.status}" title={r.detail ?? ''}>
          <td class="chip">{CHIP[r.status]}</td>
          <td class="rid">{r.id}<i>{r.kind}</i></td>
          <td class="rtext"><code>{r.text}</code></td>
          <td class="rnum">{fmt(r.lhsValue)} / {fmt(r.rhsValue)}</td>
          <td class="rmar">{r.status === 'na' ? '—' : pct(r.marginPct)}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  {#if active && chartData}
    <div class="scap">margin (%) vs <b>{active}</b>{#if swept?.unit} ({swept.unit}){/if} — the 0 line is the constraint boundary; dashed = guardrail (advisory)</div>
    <div class="pchart" bind:this={el}></div>
    {#if feasWindow}
      <p class="feas">
        {#if feasWindow.none}
          no feasible {active} in this range
        {:else}
          feasible {active} ≈ {fmt(feasWindow.lo)}…{fmt(feasWindow.hi)}{swept?.unit ?? ''}{#if feasWindow.gap} (non-contiguous){/if}
        {/if}
      </p>
    {/if}
  {/if}

  {#each result.warnings.filter((w) => w.severity !== 'info') as w}
    <p class="pwarn" title={w.message}>⚠ {w.message}</p>
  {/each}
</div>

<style>
  .sheet {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.3rem;
    font-size: 0.82rem;
  }
  .shead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .bind {
    font-family: ui-monospace, monospace;
    opacity: 0.8;
  }
  .swsel {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.78rem;
    opacity: 0.85;
  }
  .scap {
    font-size: 0.76rem;
    opacity: 0.7;
  }
  .pchart {
    height: 220px;
    min-width: 0;
  }
  .feas {
    margin: 0;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    opacity: 0.85;
  }
  .svars {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 0.25rem 0.8rem;
  }
  .svar {
    display: grid;
    grid-template-columns: 9rem 5rem 1fr;
    align-items: center;
    gap: 0.3rem;
  }
  .vn {
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vn i {
    opacity: 0.5;
    font-style: normal;
    margin-left: 0.25rem;
  }
  .num {
    width: 5rem;
    font: inherit;
    font-family: ui-monospace, monospace;
  }
  .sld {
    width: 100%;
    min-width: 0;
  }
  .srows {
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 1rem;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    opacity: 0.8;
  }
  .srows code {
    opacity: 0.75;
  }
  .srules {
    border-collapse: collapse;
    width: 100%;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
  }
  .srules td {
    padding: 0.12rem 0.4rem;
    border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
    white-space: nowrap;
  }
  .chip {
    width: 1.2rem;
    text-align: center;
    font-weight: 700;
  }
  .rid i {
    opacity: 0.5;
    font-style: normal;
    margin-left: 0.4rem;
    font-size: 0.72rem;
  }
  /* composed-child summary: one row per `use`, its feasibility chip + exposed scalars */
  .suses {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin: 0.2rem 0;
  }
  .suse {
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
    font-size: 0.8rem;
    white-space: nowrap;
    overflow: hidden;
  }
  .suse i {
    opacity: 0.5;
    font-style: normal;
    font-size: 0.72rem;
  }
  .suse .prov {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .suse .prov code {
    opacity: 0.85;
    margin-left: 0.5rem;
  }
  .rtext {
    width: 99%;
    white-space: normal;
  }
  .rtext code {
    opacity: 0.85;
  }
  .rnum,
  .rmar {
    text-align: right;
  }
  /* status colours read on both themes (system canvas backgrounds). */
  .st-pass .chip,
  .st-pass .rmar {
    color: #3a9e5c;
  }
  .st-amber .chip,
  .st-amber .rmar {
    color: #d98e00;
  }
  .st-fail .chip,
  .st-fail .rmar {
    color: #d2596a;
  }
  .st-na {
    opacity: 0.55;
  }
  .perr,
  .pwarn {
    margin: 0;
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
</style>
