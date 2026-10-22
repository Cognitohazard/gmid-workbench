<script lang="ts">
  // The solver settings page: every tolerance and cap the sheet engine and the topology picker
  // evaluate under, each with its default, what it decides, and a field to change it. A changed
  // value is kept in this browser (solver.svelte.ts) and shown here as changed, with a reset for it
  // and one for all of them; the sheet panels mark their headers while any differs.
  import { DEFAULT_SETTINGS, SETTING_KEYS, parseEng, type Settings } from '@gmid/mostab-core';
  import { CONTROL_HELP, SOLVER_HELP } from './help';
  import {
    changedSolverSettings,
    resetSolverSetting,
    resetSolverSettings,
    setSolverSetting,
    settingText,
    solverSettings,
  } from './solver.svelte';

  const settings = $derived(solverSettings());
  const changed = $derived(changedSolverSettings());
  /** A number as the field shows it: plain, without the unit the field carries beside it. */
  const plain = (v: number): string => String(Number(v.toPrecision(6)));
  const byDefault = (k: keyof Settings): string => settingText(k, DEFAULT_SETTINGS[k]);

  /** Commit a field: a number (plain, exponent or SI-prefixed) is set, held to its limits, and the
   *  field then shows the value it became; anything else restores the value in force. */
  function commit(k: keyof Settings, el: HTMLInputElement): void {
    try {
      setSolverSetting(k, parseEng(el.value.trim()));
    } catch {
      // not a number: nothing is set
    }
    el.value = plain(solverSettings()[k]);
  }

  function closeOnEscape(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    const d = e.currentTarget as HTMLDetailsElement;
    d.open = false;
    (d.querySelector('summary') as HTMLElement | null)?.focus();
  }
</script>

<!-- Escape-to-dismiss is a keyboard ENHANCEMENT on a natively interactive disclosure -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<details class="solver" onkeydown={closeOnEscape}>
  <summary class="btn" class:on={changed.length > 0} title={CONTROL_HELP.solverSettings}
    >solver{#if changed.length}&nbsp;•{/if}</summary
  >
  <div class="solver-pop" data-solver-settings>
    <p class="lead">{CONTROL_HELP.solverSettings}</p>
    {#each SETTING_KEYS as k (k)}
      {@const off = changed.includes(k)}
      <div class="srow" class:off data-setting={k}>
        <label class="shead" for="solver-{k}">
          <b>{SOLVER_HELP[k].label}</b>
          {#if off}<span class="mark" data-changed>changed</span>{/if}
        </label>
        <div class="sctl">
          <input
            id="solver-{k}"
            class="num"
            type="text"
            inputmode="text"
            spellcheck="false"
            value={plain(settings[k])}
            onchange={(e) => commit(k, e.currentTarget)}
          />{#if SOLVER_HELP[k].unit}<i>{SOLVER_HELP[k].unit}</i>{/if}
          <span class="dflt">default {byDefault(k)}</span>
          <button
            class="reset"
            disabled={!off}
            title="put {SOLVER_HELP[k].label} back to {byDefault(k)}"
            onclick={() => resetSolverSetting(k)}>reset</button
          >
        </div>
        <p class="what">{SOLVER_HELP[k].text}</p>
      </div>
    {/each}
    <div class="sfoot">
      <span
        >{changed.length
          ? `${changed.length} changed, kept in this browser: ${changed
              .map((k) => `${SOLVER_HELP[k].label} ${settingText(k, settings[k])}`)
              .join(', ')}`
          : 'all at their defaults — nothing is stored'}</span
      >
      <button disabled={!changed.length} onclick={resetSolverSettings} data-reset-all
        >reset all</button
      >
    </div>
  </div>
</details>

<style>
  .solver {
    position: relative;
    display: inline-block;
  }
  .solver summary {
    list-style: none;
  }
  .solver summary::-webkit-details-marker {
    display: none;
  }
  .btn {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
  }
  .btn.on {
    border-style: dashed;
    border-color: currentColor;
  }
  /* Sized in px like the appearance panel, so it does not grow with the UI zoom. */
  .solver-pop {
    position: absolute;
    left: 0;
    top: calc(100% + 5px);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(420px, calc(100vw - 32px));
    max-height: 70vh;
    overflow: auto;
    padding: 10px 12px;
    font-size: 13px;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 6px;
    background: var(--bg);
    box-shadow: 0 4px 16px color-mix(in srgb, currentColor 22%, transparent);
  }
  .lead,
  .what {
    margin: 0;
    opacity: 0.8;
    font-size: 12px;
  }
  .srow {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 6px;
    border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  }
  .shead {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .mark {
    font-size: 11px;
    padding: 0 4px;
    border: 1px dashed currentColor;
    border-radius: 3px;
  }
  .sctl {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .num {
    width: 7em;
    font: inherit;
    font-family: ui-monospace, monospace;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 3px;
    padding: 1px 4px;
  }
  .sctl i {
    font-style: normal;
    opacity: 0.7;
  }
  .dflt {
    flex: 1 1 auto;
    opacity: 0.65;
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .reset,
  .sfoot button {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    border-radius: 4px;
    padding: 0 6px;
  }
  .reset:disabled,
  .sfoot button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .sfoot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 6px;
    border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
    font-size: 12px;
  }
</style>
