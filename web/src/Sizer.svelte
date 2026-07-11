<script lang="ts">
  import {
    sizeDevice,
    mismatch,
    thermalNoise,
    integratedNoise,
    formatEng,
    formatSI,
    parseEng,
    type DeviceTable,
  } from '@gmid/mostab-core';
  import Help from './Help.svelte';
  import { CONTROL_HELP } from './help';
  import { axisUnit } from './labels';
  import { sizingBias, reduceForSizing, LENGTH_AXIS } from './dashboard';
  import { sizeMark } from './sizemark.svelte';
  import { untrack } from 'svelte';
  import { loadJSON, saveJSON, SIZER_KEY } from './storage';
  import { copyText } from './export';

  // The sizer reads only the active device and the dashboard's shared bias; everything
  // below (geometry, noise, matching) is a pure function of those two. The open/close
  // toggle stays in App, which renders this only while open.
  let { device, sharedBias }: { device: DeviceTable; sharedBias: Record<string, number> } =
    $props();

  // The entered sizing problem survives close/reopen and a reload alongside the bench
  // — losing three typed numbers to a refresh was a top usability friction. Inputs are
  // stored verbatim as the user's text (no numbers, no interpretation).
  const saved = loadJSON(
    SIZER_KEY,
    (r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : null),
    () => null,
  );
  const sv = (k: string, fallback: string): string =>
    typeof saved?.[k] === 'string' ? (saved[k] as string) : fallback;

  // ── Sizing panel (the "design" workflow): bind any two of {gm, gm/ID, ID} at a
  // chosen L → width, vgs, fT, and feasibility against the gm/ID ceiling.
  let inGmId = $state(sv('gmId', ''));
  let inId = $state(sv('id', ''));
  let inGm = $state(sv('gm', ''));

  const lAxis = $derived(device.grid.axes.find((a) => a.name === LENGTH_AXIS));
  // Writable derived: user picks an L freely, but a device swap (new lAxis) re-derives
  // it back to the table's first characterized length.
  let sizeL = $derived(lAxis ? lAxis.values[0] : NaN);
  // Restore the chosen L only while it is still a node of this table's L axis
  // (a one-time init read, hence untrack — a device swap later re-derives sizeL).
  const savedL = saved?.L;
  if (typeof savedL === 'number' && untrack(() => lAxis)?.values.includes(savedL)) sizeL = savedL;

  // Bias for sizing: every axis except l/vgs, fixed at the dashboard's shared-bias slider value
  // (so you size at the operating point you're viewing), else a mid node. Shown in the panel so
  // the operating point of W/vgs/fT/gm-gds is never implicit.
  const sizingFixed = $derived(sizingBias(device, sharedBias)); // shown in the bias readout

  // sizeDevice/lookupByGmId need an [l × vgs] table; collapse the extra axes at the bias.
  const sizingTable = $derived(reduceForSizing(device, sharedBias));

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
  let inAvth = $state('5'); // mV·µm — generic placeholder, matches the library sheets' default
  let inAbeta = $state('1'); // %·µm
  // Noise band + 1/f corner (Hz, engineering notation). Corner seeds from meta.FCO.
  let inFco = $state('1meg'); // flicker 1/f corner
  let inFlo = $state(sv('flo', '1')); // integration band low
  let inFhi = $state(sv('fhi', '1g')); // integration band high

  // Persist the entered problem whenever a field changes. Only the USER-owned fields:
  // A_Vth/A_beta/f_co re-seed from the device metadata on every swap (the effect
  // below), so persisting them would just be overwritten.
  $effect(() => {
    saveJSON(SIZER_KEY, { gmId: inGmId, id: inId, gm: inGm, flo: inFlo, fhi: inFhi, L: sizeL });
  });

  // Seed the coefficients from the imported device's metadata when it carries them
  // (meta.AVT [V·m], meta.ABETA [·m], meta.FCO [Hz]) instead of silently using generic
  // defaults; fall back to typical values (shown as such) otherwise. Re-seeds on swap.
  const matchFromMeta = $derived(device.meta.AVT !== undefined || device.meta.ABETA !== undefined);
  const noiseFromMeta = $derived(device.meta.FCO !== undefined);
  const toUi = (si: number, k: number) => String(+(si * k).toPrecision(6));
  $effect(() => {
    const m = device.meta;
    inAvth = m.AVT !== undefined ? toUi(m.AVT, AVT_UI_PER_SI) : '5';
    inAbeta = m.ABETA !== undefined ? toUi(m.ABETA, ABETA_UI_PER_SI) : '1';
    inFco = m.FCO !== undefined ? formatEng(m.FCO) : '1meg';
  });

  const mism = $derived.by(() => {
    const r = sizing.result;
    if (!r) return null;
    // Parse like every sibling field (engineering notation); undefined = not provided → hide.
    const avthUi = parseNum(inAvth);
    const abetaUi = parseNum(inAbeta);
    if (avthUi === undefined || abetaUi === undefined) return null;
    // The core owns the preconditions (positive geometry/bias, non-negative coefficients)
    // and throws on violation — e.g. a degenerate bind sizing W to 0, or a negative A
    // typed in. Catch → hide the budget, same style as the sizing derived above.
    try {
      return mismatch(r.W, sizeL, r.gm_id, {
        avth: avthUi / AVT_UI_PER_SI, // mV·µm → V·m
        abeta: abetaUi / ABETA_UI_PER_SI, // %·µm → ·m
      });
    } catch {
      return null;
    }
  });

  // Input-referred thermal-noise density (at the sized gm) and the total integrated
  // RMS over the band share the thermal floor, so compute it once. rms is null on an
  // invalid band; the whole object is null until a geometry is sized.
  const noise = $derived.by(() => {
    if (!sizing.result) return null;
    const density = thermalNoise(
      sizing.result.gm,
      sizing.result.quantities.gamma,
      sizingTable.meta.temp,
    );
    // The core owns the band/PSD preconditions (0 < fLo < fHi, fc ≥ 0, sth ≥ 0 — the
    // last is violable via a bad table gamma column, which QA warns about but never
    // blocks) and throws on violation. Catch → density-only readout, same style as
    // the sizing derived above; empty inputs skip the call without an exception.
    const fc = parseNum(inFco);
    const fLo = parseNum(inFlo);
    const fHi = parseNum(inFhi);
    if (fc === undefined || fLo === undefined || fHi === undefined) {
      return { density, rms: null };
    }
    try {
      return { density, rms: integratedNoise(density ** 2, fc, fLo, fHi) };
    } catch {
      return { density, rms: null };
    }
  });
  // Publish the sized gm/ID so every gm/ID-axis chart can mark the bound point;
  // cleared when the solution goes away or the sizer closes (unmount teardown).
  $effect(() => {
    sizeMark.gmId = sizing.result?.gm_id ?? null;
    return () => {
      sizeMark.gmId = null;
    };
  });

  // Numeric bias entry: a parseable value commits into the SHARED bias, so the
  // dashboard sliders and every chart follow; anything else restores the field.
  // The commit is CLAMPED to the table's swept range — the grid slice would clamp
  // silently anyway, and the readout must never claim an operating point the table
  // cannot represent (type 2 V on a 1.8 V table and every number would be the
  // 1.8 V answer labeled "2 V").
  let biasNote = $state<string | null>(null);
  function setBiasField(axis: string, el: HTMLInputElement): void {
    const v = parseNum(el.value);
    const ax = device.grid.axes.find((a) => a.name === axis);
    if (v !== undefined && Number.isFinite(v) && ax) {
      const c = Math.min(Math.max(v, ax.values[0]), ax.values[ax.values.length - 1]);
      // A clamp must be SAID, not just snapped — the field changing under the cursor
      // is easy to miss, and every readout below now answers at the clamped point.
      biasNote =
        c !== v
          ? `${axis} = ${formatEng(v)}${axisUnit(axis)} is outside the table — clamped to ${formatEng(c)}${axisUnit(axis)}`
          : null;
      sharedBias[axis] = c;
      el.value = formatEng(c);
    } else el.value = formatEng(sharedBias[axis] ?? 0);
  }

  // Finger realization of the sized W (the width-scaling caveat: realize table-derived
  // widths as fingers of the characterization width). The count is ROUNDED, so the
  // realized width can differ materially from the sized W at small counts — it is
  // always shown, and copied, with its deviation.
  const fingers = $derived.by(() => {
    const r = sizing.result;
    const wc = device.meta.W;
    if (!r || wc === undefined || r.W / wc < 1.5) return null;
    const nf = Math.round(r.W / wc);
    const pct = ((nf * wc) / r.W - 1) * 100;
    return { nf, wc, W: nf * wc, pctText: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` };
  });

  // One-click handoff of the sized numbers (engineering notation, one name per line —
  // pastes cleanly into a notebook, a spreadsheet, or a design review chat).
  let copied = $state(false);
  function copyReport(): void {
    const r = sizing.result;
    if (!r) return;
    const line = (k: string, v: string) => `${k}\t${v}`;
    const rows = [
      line('device', `${device.id.device} ${device.id.corner} ${device.id.temp}C`),
      line('L', `${formatEng(sizeL)}m`),
      ...Object.entries(sizingFixed).map(([k, v]) => line(k, `${formatEng(v)}${axisUnit(k)}`)),
      line('W', `${formatEng(r.W)}m`),
      ...(fingers
        ? [
            line(
              'fingers',
              `${fingers.nf} x ${formatEng(fingers.wc)}m = ${formatEng(fingers.W)}m (${fingers.pctText} vs sized W)`,
            ),
          ]
        : []),
      line('vgs', `${formatEng(r.vgs)}V`),
      line('gm/ID', formatEng(r.gm_id)),
      line('ID', `${formatEng(r.id)}A`),
      line('gm', `${formatEng(r.gm)}S`),
      line('fT', `${formatEng(r.quantities.ft)}Hz`),
      line('gm/gds', formatEng(r.quantities.gm_gds)),
      ...(noise?.density != null ? [line('vn_th', `${formatEng(noise.density)}V/rtHz`)] : []),
      ...(noise?.rms != null ? [line('vn_rms', `${formatEng(noise.rms)}V`)] : []),
      ...(mism ? [line('sigma_Vth', `${formatEng(mism.sigmaVth)}V`)] : []),
      ...(mism ? [line('sigma_Vos', `${formatEng(mism.sigmaVos)}V`)] : []),
    ];
    copyText(rows.join('\n'), (on) => (copied = on));
  }
</script>

<aside class="sizer">
  <h2>size <small>bind any two</small> <Help text={CONTROL_HELP.bind} /></h2>
  <label
    >L
    <select bind:value={sizeL}>
      {#each lAxis?.values ?? [] as L}<option value={L}>{formatSI(L)}m</option>{/each}
    </select>
  </label>
  <!-- Off-table-range L clamps and other engineering caveats from the core surface here,
       next to the L control that selects the geometry. -->
  {#if sizing.result?.warnings?.length}
    <ul class="warns">
      {#each sizing.result.warnings as w}<li>{w}</li>{/each}
    </ul>
  {/if}
  <label>gm/ID <input bind:value={inGmId} placeholder="S/A" spellcheck="false" /></label>
  <label>ID <input bind:value={inId} placeholder="A · e.g. 100u" spellcheck="false" /></label>
  <label>gm <input bind:value={inGm} placeholder="S" spellcheck="false" /></label>

  {#if Object.keys(sizingFixed).length}
    <p class="bias">
      bias
      {#each Object.entries(sizingFixed) as [k, v] (k)}
        <label class="bax"
          >{k}
          <input
            value={formatEng(v)}
            spellcheck="false"
            onchange={(e) => setBiasField(k, e.currentTarget as HTMLInputElement)}
          />{axisUnit(k)}</label
        >
      {/each}
    </p>
    {#if biasNote}
      <ul class="warns bnote"><li>{biasNote}</li></ul>
    {/if}
  {/if}

  {#if sizing.result}
    {@const r = sizing.result}
    <dl class="sz">
      <dt>W</dt>
      <dd>{formatSI(r.W)}m</dd>
      {#if fingers}
        <dt>as fingers <Help text={CONTROL_HELP.fingers} /></dt>
        <dd>{fingers.nf} × {formatSI(fingers.wc)}m = {formatSI(fingers.W)}m ({fingers.pctText})</dd>
      {/if}
      <dt>vgs</dt>
      <dd>{formatSI(r.vgs)}V</dd>
      <dt>gm/ID</dt>
      <dd>{formatSI(r.gm_id)}</dd>
      <dt>ID</dt>
      <dd>{formatSI(r.id)}A</dd>
      <dt>gm</dt>
      <dd>{formatSI(r.gm)}S</dd>
      <dt>fT</dt>
      <dd>{formatSI(r.quantities.ft)}Hz</dd>
      <dt>gm/gds</dt>
      <dd>{formatSI(r.quantities.gm_gds)}</dd>
    </dl>
    <p class="feas {r.feasible ? 'ok' : 'bad'}">
      {r.feasible ? '✓ feasible' : '✗ infeasible'} · ceiling {formatSI(r.ceiling)}
      <button class="copy" onclick={copyReport} title="copy the sized numbers as name/value lines"
        >{copied ? 'copied ✓' : 'copy'}</button
      >
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
  <!-- Help renders a <button> (a labelable element), so each label needs an explicit
       `for` — otherwise the button, being first, would steal the label's control. -->
  <label for="sz-fco"
    ><span>f<sub>co</sub> <Help text={CONTROL_HELP.fco} /></span>
    <input id="sz-fco" bind:value={inFco} placeholder="Hz · e.g. 1meg" spellcheck="false" /></label
  >
  <label for="sz-flo"
    ><span>band <Help text={CONTROL_HELP.band} /></span>
    <span class="band"
      ><input id="sz-flo" aria-label="band low, Hz" bind:value={inFlo} spellcheck="false" />–<input
        aria-label="band high, Hz"
        bind:value={inFhi}
        spellcheck="false"
      /></span
    ></label
  >
  {#if noise}
    <!-- γ-model thermal noise uses the SIZED gm (noise ∝ 1/√gm). The table's stored
         `sth`/`sfl` PSDs are at the characterization width and are shown in Explore. -->
    <dl class="noise">
      <dt>v<sub>n,th</sub> <small>γ-model</small></dt>
      <dd>{formatSI(noise.density)}V/√Hz</dd>
      {#if noise.rms !== null}
        <dt>v<sub>n,rms</sub> <small>band</small></dt>
        <dd>{formatSI(noise.rms)}V</dd>
      {/if}
    </dl>
  {/if}

  <h3>matching <Help text={CONTROL_HELP.matching} /></h3>
  <p class="match-note">A in mV·µm / %·µm{matchFromMeta ? ' · from device' : ''}</p>
  <label for="sz-avth"
    ><span>A<sub>Vth</sub> <Help text={CONTROL_HELP.avth} /></span>
    <input id="sz-avth" bind:value={inAvth} placeholder="mV·µm" spellcheck="false" /></label
  >
  <label for="sz-abeta"
    ><span>A<sub>β</sub> <Help text={CONTROL_HELP.abeta} /></span>
    <input id="sz-abeta" bind:value={inAbeta} placeholder="%·µm" spellcheck="false" /></label
  >
  {#if mism}
    <dl class="budget">
      <dt>σ(V<sub>th</sub>)</dt>
      <dd>{formatSI(mism.sigmaVth)}V</dd>
      <dt>σ(V<sub>os</sub>) pair</dt>
      <dd>{formatSI(mism.sigmaVos)}V</dd>
      <dt>σ(I)/I</dt>
      <dd>{(mism.sigmaIrel * 100).toFixed(3)}%</dd>
    </dl>
  {/if}
</aside>

<style>
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
    font-size: calc(0.95rem * var(--text-scale));
    margin: 0;
  }
  .sizer h2 small {
    opacity: 0.5;
    font-weight: 400;
  }
  .sizer h3 {
    font-size: calc(0.85rem * var(--text-scale));
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
  .bax input {
    width: 4.5rem;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid #8884;
    border-radius: 3px;
    padding: 0 0.25rem;
    margin: 0 0.15rem;
  }
  .copy {
    cursor: pointer;
    font: inherit;
    font-size: 0.85em;
    color: inherit;
    background: none;
    border: 1px solid #8884;
    border-radius: 3px;
    padding: 0 0.4rem;
    margin-left: 0.5rem;
  }
  .copy:hover {
    opacity: 0.8;
  }
  .feas.ok {
    color: var(--ok);
  }
  .feas.bad {
    color: var(--err);
  }
  .bias,
  .match-note {
    margin: 0.1rem 0 0;
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
    opacity: 0.6;
  }
  .warns {
    margin: 0;
    padding: 0.25rem 0.5rem 0.25rem 1.4rem;
    list-style: disc;
    font-size: 0.88em;
    color: var(--warn);
    border-left: 2px solid color-mix(in srgb, var(--warn) 60%, transparent);
  }
  .warns li {
    margin: 0.05rem 0;
  }
  .sizer .err {
    color: var(--err);
    font-family: ui-monospace, monospace;
  }
  .sizer .hint,
  .sizer .err {
    margin: 0.2rem 0 0;
    font-size: 0.92em;
  }
  .sizer .hint {
    opacity: 0.55;
  }
</style>
