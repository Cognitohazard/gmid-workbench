<script lang="ts">
  // How each result of a sheet moves with each decision of the designer: one row per named result
  // and per requirement's left side, one column per knob, and in each cell the relative change of
  // the row for a 1 % larger knob (SheetSensitivityResult.relPerPct). Every cell is a difference of
  // full evaluations of the design, sized and solved again. A cell with no number is empty and says
  // why under the pointer.
  import type { SheetSensitivity } from '@gmid/mostab-core';
  import { CONTROL_HELP } from './help';
  import { signedRatio } from './labels';

  let { rows }: { rows: SheetSensitivity[] } = $props();

  /** The knobs that were probed, and the row names in the order the sheet writes them. */
  const knobs = $derived(rows.filter((r) => r.results.length || r.checks.length));
  const results = $derived(knobs[0]?.results.map((r) => r.name) ?? []);
  const checks = $derived(knobs[0]?.checks.map((c) => c.id) ?? []);

  /** A pure number with its sign. */
  const signed = signedRatio;

  function resultCell(k: SheetSensitivity, name: string): { text: string; why: string } {
    const r = k.results.find((x) => x.name === name);
    if (r?.relPerPct !== undefined)
      return {
        text: signed(r.relPerPct),
        why: `${name} moves ${signed(r.relPerPct)} % for 1 % of ${k.param}.`,
      };
    return { text: '', why: r?.why ?? k.error ?? `${name} has no value against ${k.param}.` };
  }
  function checkCell(k: SheetSensitivity, id: string): { text: string; why: string } {
    const c = k.checks.find((x) => x.id === id);
    if (c?.relPerPct !== undefined)
      return {
        text: signed(c.relPerPct),
        why: `The left side of ${id} moves ${signed(c.relPerPct)} % for 1 % of ${k.param}.`,
      };
    return {
      text: '',
      why: c?.why ?? k.error ?? `The left side of ${id} has no value against ${k.param}.`,
    };
  }
</script>

{#if knobs.length && (results.length || checks.length)}
  <div class="sview" data-decisions-view>
    <span class="glabel" title={CONTROL_HELP.decisionsView}>results by decision</span>
    <p class="scap">
      Each cell gives how many percent a result moves when the decision above it is 1 % larger. The
      design is sized and solved again for every cell.
    </p>
    <div class="stable">
      <table>
        <thead>
          <tr>
            <th></th>
            {#each knobs as k}<th title={k.error ?? ''}>{k.param}</th>{/each}
          </tr>
        </thead>
        <tbody>
          {#each results as name}
            <tr>
              <th>{name}</th>
              {#each knobs as k}
                {@const c = resultCell(k, name)}
                <td class:none={!c.text} title={c.why}>{c.text}</td>
              {/each}
            </tr>
          {/each}
          {#each checks as id}
            <tr>
              <th>left side of {id}</th>
              {#each knobs as k}
                {@const c = checkCell(k, id)}
                <td class:none={!c.text} title={c.why}>{c.text}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}

<style>
  .sview {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.25rem 0.45rem;
    border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    border-radius: 4px;
    min-width: 0;
  }
  .glabel {
    font-size: calc(0.66rem * var(--text-scale));
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.6;
  }
  .scap {
    margin: 0;
    font-size: calc(0.76rem * var(--text-scale));
    opacity: 0.75;
  }
  .stable {
    overflow-x: auto;
    max-width: 100%;
  }
  table {
    border-collapse: collapse;
    font-family: ui-monospace, monospace;
    font-size: calc(0.72rem * var(--text-scale));
  }
  th,
  td {
    padding: 0.08rem 0.4rem;
    text-align: right;
    white-space: nowrap;
    border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent);
  }
  tbody th {
    text-align: left;
    font-weight: normal;
  }
  thead th {
    font-weight: 600;
  }
  td.none {
    background: color-mix(in srgb, currentColor 5%, transparent);
  }
</style>
