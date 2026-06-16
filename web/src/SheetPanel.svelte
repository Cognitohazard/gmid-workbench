<script lang="ts">
  // A leaf design-sheet panel: pick a vetted example, tune the design variables, and
  // watch the author equations and pass/fail constraints recompute with signed margins.
  // It holds no numerics — runSheet (core) does all evaluation and never throws.
  import {
    runSheet,
    formatEng,
    EXAMPLES,
    type DeviceTable,
    type SheetDoc,
    type RuleStatus,
  } from '@gmid/mostab-core';
  import { CONTROL_HELP } from './help';

  let {
    device,
    cfg,
    onChange,
  }: {
    device: DeviceTable;
    cfg: SheetDoc;
    onChange: (s: SheetDoc) => void;
  } = $props();

  const result = $derived(runSheet(cfg, device));

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
