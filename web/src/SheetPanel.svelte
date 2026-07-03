<script lang="ts">
  // A leaf design-sheet panel: pick a vetted example, tune the design variables, and
  // watch the author equations and pass/fail constraints recompute with signed margins.
  // It holds no numerics — runSheet (core) does all evaluation and never throws.
  import {
    runSheet,
    sweepSheet,
    sweepSheet2,
    sweepable as isSweepable,
    formatEng,
    joinProvide,
    SWEEP_POINTS,
    SWEEP2_POINTS,
    type DeviceTable,
    type DeviceResolver,
    type SheetDoc,
    type SheetVar,
    type SheetSweep2,
    type SheetChildReport,
    type RuleResult,
    type RuleStatus,
  } from '@gmid/mostab-core';
  import { type ChartData } from './chart';
  import { chartHost } from './chartHost.svelte';
  import { axisUnit } from './labels';
  import { CONTROL_HELP } from './help';
  import { SHEET_MENU } from './library';

  let {
    device,
    cfg,
    sweep = '',
    sweep2 = '',
    fallbackBias = {},
    resolveDevice = undefined,
    deviceOptions = [],
    styleVersion = 0,
    onChange,
    onSweep,
    onSweep2,
  }: {
    device: DeviceTable;
    cfg: SheetDoc;
    sweep?: string;
    /** The second (×) sweep param: with `sweep` set too, the panel draws a 2-D feasibility map. */
    sweep2?: string;
    /** Panel bias for live axes the bind leaves undeclared (core warns per assumption). */
    fallbackBias?: Record<string, number>;
    resolveDevice?: DeviceResolver;
    deviceOptions?: { uid: string; label: string }[];
    styleVersion?: number;
    onChange: (s: SheetDoc) => void;
    onSweep: (s: string) => void;
    onSweep2: (s: string) => void;
  } = $props();

  const result = $derived(runSheet(cfg, device, resolveDevice, { fallbackBias }));

  // ── Feasibility sweep: vary one slider parameter across its range and chart every rule's
  // relative margin. Only finitely-bounded params can be swept (the sweep walks [min,max]).
  const sweepable = $derived(cfg.params.filter((p) => isSweepable(p)));
  // The active sweep param, ignoring a stale selection that no longer names a sweepable var.
  const active = $derived(sweep && sweepable.some((p) => p.name === sweep) ? sweep : '');
  const swept = $derived(
    active ? sweepSheet(cfg, active, device, SWEEP_POINTS, resolveDevice, { fallbackBias }) : null,
  );

  // ── 2-D feasibility map: a second (×) param turns the 1-D margin chart into a design-plane
  // heatmap (feasible region vs the two params). Choices are the sweepable params minus the first.
  const sweepable2 = $derived(sweepable.filter((p) => p.name !== active));
  const active2 = $derived(
    active && sweep2 && sweepable2.some((p) => p.name === sweep2) ? sweep2 : '',
  );
  const twoD = $derived(active2 !== ''); // active2 is only ever set while `active` is
  const swept2 = $derived(
    twoD
      ? sweepSheet2(cfg, active, active2, device, SWEEP2_POINTS, resolveDevice, { fallbackBias })
      : null,
  );
  // The distinct hard-rule ids (tree-path) that bound the infeasible region — the caption's "what
  // limits it", so the plane is never a wall of red with no named cause.
  const bindingIds = $derived.by(() => {
    const s = swept2;
    if (!s) return [];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive dedup scratch, rebuilt per recompute
    const ids = new Set<string>();
    for (const row of s.binding) for (const id of row) if (id) ids.add(id);
    return [...ids];
  });

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
    return {
      none: false as const,
      lo: swept.x[lo],
      hi: swept.x[hi],
      gap: idx.length !== hi - lo + 1,
    };
  });

  // The embedded uPlot chart, owned outside Svelte via the shared host: destroyed on
  // leaving sweep mode, refit in place on data edits, restyled on a theme/font change.
  let el: HTMLDivElement | undefined = $state();
  chartHost({
    el: () => el,
    data: () => chartData,
    active: () => active !== '' && !twoD,
    styleVersion: () => styleVersion,
  });

  // Immutable edits: every change emits a fresh doc so the parent's Object.assign + persist
  // path (identical to every other panel) carries it. structuredClone on sheet-switch so a
  // panel never aliases the shared menu literals.
  function setParam(name: string, value: number): void {
    if (!Number.isFinite(value)) return;
    onChange({ ...cfg, params: cfg.params.map((p) => (p.name === name ? { ...p, value } : p)) });
  }
  function pickSheet(e: Event): void {
    const sel = e.currentTarget as HTMLSelectElement;
    const [gi, si] = sel.value.split(':').map(Number);
    sel.value = '';
    const src = SHEET_MENU[gi]?.sheets[si];
    if (src) onChange(structuredClone(src) as SheetDoc);
  }
  // Point a composed child at a specific loaded device (a table uid), or '' to inherit the parent.
  function setUseDevice(i: number, uid: string): void {
    const uses = (cfg.uses ?? []).map((u, j) => {
      if (j !== i) return u;
      const { device: _drop, ...rest } = u;
      return uid ? { ...rest, device: uid } : rest;
    });
    onChange({ ...cfg, uses });
  }

  const fmt = (v: number | undefined): string =>
    v == null || !Number.isFinite(v) ? '—' : formatEng(v);
  const pct = (v: number): string =>
    Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : '—';
  const CHIP: Record<RuleStatus, string> = { pass: '✓', amber: '≈', fail: '✗', na: '—' };

  // Author rule notes by id (a RuleResult carries no note — the physical-meaning note lives on the
  // authored SheetRule). Top-level result.rules mirror cfg.rules 1:1, so the id lookup is exact.
  const ruleNote = $derived(new Map(cfg.rules.map((r) => [r.id, r.note])));
  // A rule row's tooltip carries the rule-SPECIFIC bits (its authored physical-meaning note and any
  // eval detail); the generic kind/amber/na explanations live on their own elements via CONTROL_HELP.
  function ruleTitle(r: RuleResult): string {
    const parts: string[] = [];
    const note = ruleNote.get(r.id);
    if (note) parts.push(note);
    if (r.detail) parts.push(r.detail);
    return parts.join(' — ');
  }

  // The operating point the sizing sliced at (declared in the bind, or assumed from the panel
  // bias) — shown so the bias behind the sized width is never an invisible assumption.
  const biasText = $derived.by(() => {
    const b = result.bind?.bias;
    if (!b) return '';
    return Object.entries(b)
      .map(([k, v]) => `${k} ${formatEng(v)}${axisUnit(k)}`)
      .join(', ');
  });

  // An infeasible child's failing HARD rules (advisory guardrails excluded) — so the cause of a
  // red child block is on screen, not just its ✗.
  const childFails = (c: SheetChildReport | undefined): RuleResult[] =>
    c && !c.feasible ? c.rules.filter((r) => r.kind !== 'guardrail' && r.status === 'fail') : [];

  // Params group by role when ANY carries one (spec = the requirement, choice = the design knobs);
  // otherwise a single flat list, unchanged. Untagged params in a role-bearing doc trail ungrouped.
  const hasRoles = $derived(cfg.params.some((p) => p.role));
  const specParams = $derived(cfg.params.filter((p) => p.role === 'spec'));
  const choiceParams = $derived(cfg.params.filter((p) => p.role === 'choice'));
  const otherParams = $derived(cfg.params.filter((p) => !p.role));

  // ── The 2-D map is imperative (uPlot draws XY lines only): paint it by hand on a canvas,
  // reading --ok/--err/grid colours from CSS at draw time so it tracks the light/dark theme.
  let mapEl: HTMLCanvasElement | undefined = $state();
  function drawMap(canvas: HTMLCanvasElement, s: SheetSweep2): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cs = getComputedStyle(canvas);
    const ok = cs.getPropertyValue('--ok').trim() || '#3a9e5c';
    const err = cs.getPropertyValue('--err').trim() || '#d2596a';
    const grid = cs.color;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const nx = s.x.length;
    const ny = s.y.length;
    if (nx === 0 || ny === 0) return;
    const cw = w / nx;
    const ch = h / ny;
    // Feasible = green-ish, infeasible = red-ish (the status tokens, softened). paramY min sits at
    // the BOTTOM (yi = 0 → last drawn row), the usual design-plane orientation.
    for (let yi = 0; yi < ny; yi++) {
      const py = (ny - 1 - yi) * ch;
      for (let xi = 0; xi < nx; xi++) {
        const feas = s.feasible[yi][xi];
        ctx.fillStyle = feas ? ok : err;
        ctx.globalAlpha = feas ? 0.55 : 0.4;
        // +1 hides the seam between adjacent same-colour cells under sub-pixel rounding.
        ctx.fillRect(xi * cw, py, cw + 1, ch + 1);
      }
    }
    // A faint reference grid (quintiles) + border, light enough that the cells stay dominant.
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 5; i++) {
      const gx = Math.round((w * i) / 5) + 0.5;
      const gy = Math.round((h * i) / 5) + 0.5;
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Two effects, deliberately split: the observer lives as long as the CANVAS (its
  // callback reads the current sweep at fire time), while repaints key on the data and
  // the theme/font epoch. One combined effect would tear down and rebuild the observer
  // on every slider tick — and double-paint, since observe() fires synchronously.
  $effect(() => {
    const canvas = mapEl;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const s = swept2;
      if (s && s.x.length > 0) drawMap(canvas, s);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  });
  // styleVersion is read (always ≥ 0) only to register the dependency, so a theme flip
  // that changes --ok/--err triggers a redraw.
  $effect(() => {
    const canvas = mapEl;
    const s = swept2;
    if (styleVersion >= 0 && canvas && s && s.x.length > 0) drawMap(canvas, s);
  });
</script>

{#snippet paramRow(p: SheetVar)}
  <label class="svar" title={p.note}>
    <span class="vn"
      >{p.name}{#if p.unit}<i>{p.unit}</i>{/if}</span
    >
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
{/snippet}

<div class="sheet">
  <div class="shead">
    <select class="rm" onchange={pickSheet} title={CONTROL_HELP.sheet}>
      <option value="" selected>sheet…</option>
      {#each SHEET_MENU as g, gi}
        <optgroup label={g.label}>
          {#each g.sheets as s, si}<option value={`${gi}:${si}`}>{s.title}</option>{/each}
        </optgroup>
      {/each}
    </select>
    <strong>{cfg.title}</strong>
    <span class="feasb {result.feasible ? 'ok' : 'no'}"
      >{result.feasible ? 'feasible' : 'infeasible'}</span
    >
    {#if result.bind}
      {#if result.bind.ok}
        <span class="bind"
          >W={fmt(result.bind.W)}m · V<sub>GS</sub>={fmt(result.bind.vgs)}V · I<sub>D</sub>={fmt(
            result.bind.id,
          )}A</span
        >
        {#if biasText}
          <span class="sbias" title={CONTROL_HELP.bindBias}>@ {biasText}</span>
        {/if}
      {:else}
        <span class="perr" title={result.bind.error}>sizing: {result.bind.error}</span>
      {/if}
    {/if}
    {#if sweepable.length}
      <label class="swsel" title={CONTROL_HELP.sheetSweep}>
        sweep
        <select
          value={active}
          onchange={(e) => onSweep((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">off</option>
          {#each sweepable as p}<option value={p.name}>{p.name}</option>{/each}
        </select>
      </label>
    {/if}
    {#if active && sweepable2.length}
      <label class="swsel2" title={CONTROL_HELP.sheetSweep2}>
        ×
        <select
          value={active2}
          onchange={(e) => onSweep2((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">off</option>
          {#each sweepable2 as p}<option value={p.name}>{p.name}</option>{/each}
        </select>
      </label>
    {/if}
  </div>

  {#if cfg.description}
    <p class="sdesc">{cfg.description}</p>
  {/if}

  {#if hasRoles}
    {#if specParams.length}
      <div class="sgroup">
        <span class="glabel" title={CONTROL_HELP.paramRole}>spec</span>
        <div class="svars">
          {#each specParams as p}{@render paramRow(p)}{/each}
        </div>
      </div>
    {/if}
    {#if choiceParams.length}
      <div class="sgroup">
        <span class="glabel" title={CONTROL_HELP.paramRole}>choice</span>
        <div class="svars">
          {#each choiceParams as p}{@render paramRow(p)}{/each}
        </div>
      </div>
    {/if}
    {#if otherParams.length}
      <div class="svars">
        {#each otherParams as p}{@render paramRow(p)}{/each}
      </div>
    {/if}
  {:else}
    <div class="svars">
      {#each cfg.params as p}{@render paramRow(p)}{/each}
    </div>
  {/if}

  {#if cfg.uses?.length}
    <div class="suses">
      {#each cfg.uses as u, i}
        {@const c = result.children?.[i]}
        <div class="suse st-{c?.feasible ? 'pass' : 'fail'}" title={u.doc.title}>
          <span class="chip">{c?.feasible ? '✓' : '✗'}</span>
          <b>{u.name}</b><i>{u.doc.title}</i>
          {#if deviceOptions.length > 1 || u.device}
            <select
              class="dsel"
              title={CONTROL_HELP.useDevice}
              value={u.device ?? ''}
              onchange={(e) => setUseDevice(i, (e.currentTarget as HTMLSelectElement).value)}
            >
              <option value="">↳ active device</option>
              {#if u.device && !deviceOptions.some((o) => o.uid === u.device)}
                <option value={u.device}>{u.device} (not loaded)</option>
              {/if}
              {#each deviceOptions as o}<option value={o.uid}>{o.label}</option>{/each}
            </select>
          {/if}
          <span class="prov" title={CONTROL_HELP.provide}
            >{#each Object.entries(c?.provides ?? {}) as [k, v]}<code
                >{joinProvide(u.name, k)}={fmt(v)}</code
              >{/each}</span
          >
        </div>
        {#if childFails(c).length}
          <div class="cfails">
            {#each childFails(c) as r}<span class="cfail" title={ruleTitle(r)}
                >✗ {r.id} {pct(r.marginPct)}</span
              >{/each}
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if cfg.rows.length}
    <div class="srows">
      {#each cfg.rows as row}
        <span class="srow"
          ><b>{row.name}</b> = <code>{row.expr}</code> = {fmt(result.values[row.name])}{row.unit ??
            ''}</span
        >
      {/each}
    </div>
  {/if}

  <table class="srules">
    <tbody>
      {#each result.rules as r}
        <tr class="st-{r.status}" class:advisory={r.kind === 'guardrail'} title={ruleTitle(r)}>
          <td
            class="chip"
            title={r.status === 'amber'
              ? CONTROL_HELP.amber
              : r.status === 'na'
                ? CONTROL_HELP.ruleNa
                : undefined}>{CHIP[r.status]}</td
          >
          <td class="rid"
            >{r.id}<i title={CONTROL_HELP.ruleKind}
              >{r.kind === 'guardrail' ? 'guardrail · advisory' : r.kind}</i
            ></td
          >
          <td class="rtext"><code>{r.text}</code></td>
          <td class="rnum">{fmt(r.lhsValue)} / {fmt(r.rhsValue)}</td>
          <td class="rmar">{r.status === 'na' ? '—' : pct(r.marginPct)}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  {#if twoD && swept2 && swept2.x.length}
    <div class="scap">
      feasibility · <b>{active}</b> × <b>{active2}</b> — green closes, red fails a hard rule (X → right,
      Y ↑)
    </div>
    <div class="smap">
      <div class="smy">
        {active2}
        {fmt(swept2.y[0])}…{fmt(swept2.y[swept2.y.length - 1])}{swept2.unitY}
      </div>
      <canvas class="smapc" bind:this={mapEl}></canvas>
      <div class="smx">
        {active}
        {fmt(swept2.x[0])}…{fmt(swept2.x[swept2.x.length - 1])}{swept2.unitX}
      </div>
    </div>
    <p class="feas">
      {#if bindingIds.length}
        region bounded by: {bindingIds.join(', ')}
      {:else}
        no hard rule fails across this plane
      {/if}
    </p>
  {:else if active && chartData && !twoD}
    <div class="scap">
      margin (%) vs <b>{active}</b>{#if swept?.unit}
        ({swept.unit}){/if} — the 0 line is the constraint boundary; dashed = guardrail (advisory)
    </div>
    <div class="pchart" bind:this={el}></div>
    {#if feasWindow}
      <p class="feas">
        {#if feasWindow.none}
          no feasible {active} in this range
        {:else}
          feasible {active} ≈ {fmt(feasWindow.lo)}…{fmt(feasWindow.hi)}{swept?.unit ??
            ''}{#if feasWindow.gap}
            (non-contiguous){/if}
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
  /* Overall feasibility badge: the design's headline verdict, so a red advisory guardrail below
     it is never mistaken for the whole design failing. */
  .feasb {
    font-size: 0.66rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.04rem 0.4rem;
    border-radius: 999px;
    border: 1px solid currentColor;
  }
  .feasb.ok {
    color: var(--ok);
  }
  .feasb.no {
    color: var(--err);
  }
  .sbias {
    font-family: ui-monospace, monospace;
    font-size: 0.76rem;
    opacity: 0.68;
  }
  .sdesc {
    margin: 0;
    font-size: 0.78rem;
    opacity: 0.72;
    max-width: 72ch;
  }
  .swsel {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.78rem;
    opacity: 0.85;
  }
  /* The 2-D map's × param select — same look as .swsel but no auto-margin (it trails the first). */
  .swsel2 {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.78rem;
    opacity: 0.85;
  }
  /* spec/choice param grouping (only when the doc tags roles). */
  .sgroup {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .glabel {
    font-size: 0.66rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.5;
  }
  /* 2-D feasibility heatmap: axis labels frame an imperative canvas painted from the status tokens. */
  .smap {
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: 1fr auto;
    gap: 0.2rem;
    height: 220px;
    min-width: 0;
  }
  .smy {
    grid-column: 1;
    grid-row: 1;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    justify-self: center;
    align-self: center;
    font-size: 0.72rem;
    opacity: 0.7;
    white-space: nowrap;
  }
  .smapc {
    grid-column: 2;
    grid-row: 1;
    width: 100%;
    height: 100%;
    min-width: 0;
    border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    border-radius: 3px;
  }
  .smx {
    grid-column: 2;
    grid-row: 2;
    text-align: center;
    font-size: 0.72rem;
    opacity: 0.7;
    white-space: nowrap;
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
  .suse .dsel {
    font-size: 0.72rem;
    max-width: 12rem;
  }
  .suse .prov {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .suse .prov code {
    opacity: 0.85;
    margin-left: 0.5rem;
  }
  /* An infeasible child's failing hard rules — one compact line under its summary row. */
  .cfails {
    display: flex;
    flex-wrap: wrap;
    gap: 0.1rem 0.6rem;
    margin: 0 0 0.15rem 1.5rem;
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
    color: var(--err);
    opacity: 0.9;
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
    color: var(--ok);
  }
  .st-amber .chip,
  .st-amber .rmar {
    color: var(--warn);
  }
  .st-fail .chip,
  .st-fail .rmar {
    color: var(--err);
  }
  /* A guardrail is advisory — it never gates feasibility — so even a failing one reads amber
     (a heads-up), not the hard-fail red an invariant/requirement earns. */
  .srules tr.advisory.st-fail .chip,
  .srules tr.advisory.st-fail .rmar {
    color: var(--warn);
  }
  .st-na {
    opacity: 0.55;
  }
  .perr,
  .pwarn {
    margin: 0;
    color: var(--warn);
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
