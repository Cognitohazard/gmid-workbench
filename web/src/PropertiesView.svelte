<script lang="ts">
  // Which device property each formula of a sheet leans on, and how hard: one row per named result
  // and per requirement's left side, one column per small-signal property of each sized device,
  // and in each cell the relative change of the row for a 1 % larger property with the design
  // held (devicePropertySensitivities). The view says, beside the table, what it is not: it reads
  // the formulas and does not size or solve the circuit again.
  import {
    deviceWords,
    OWN_DEVICE,
    type PropertyColumn,
    type PropertySensitivities,
  } from '@gmid/mostab-core';
  import { CONTROL_HELP } from './help';
  import { signedRatio } from './labels';

  let { view }: { view: PropertySensitivities } = $props();

  const held = $derived(view.columns.filter((c) => !c.error));
  /** The columns some formula reads; the others are named in one sentence per device. */
  const read = $derived(
    held.filter(
      (c) =>
        c.results.some((r) => r.relPerPct !== 0 && r.relPerPct !== undefined) ||
        c.checks.some((r) => r.relPerPct !== 0 && r.relPerPct !== undefined),
    ),
  );
  /** Column groups by device, in tree order. */
  const groups = $derived.by(() => {
    const out: { device: string; columns: PropertyColumn[] }[] = [];
    for (const c of read) {
      const g = out.find((x) => x.device === c.device);
      if (g) g.columns.push(c);
      else out.push({ device: c.device, columns: [c] });
    }
    return out;
  });
  /** One sentence per device listing what nothing reads, what its table lacks, or that one sizing
   *  stands in several places. */
  const notes = $derived.by(() => {
    const out: string[] = [];
    const devices = [...new Set(view.columns.map((c) => c.device))];
    for (const d of devices) {
      const of = view.columns.filter((c) => c.device === d);
      const unread = of.filter((c) => !c.error && !read.includes(c)).map((c) => c.key);
      const missing = of.filter((c) => c.error?.includes('holds no')).map((c) => c.key);
      const broken = of.filter((c) => c.error && !c.error.includes('holds no'));
      const who = deviceWords(d);
      if (unread.length) out.push(`No formula reads ${list(unread)} of ${who}.`);
      if (missing.length) out.push(`The table of ${who} holds no ${list(missing)} column.`);
      for (const c of broken) out.push(c.error as string);
      const placed = of.find((c) => c.placements)?.placements;
      if (placed)
        out.push(
          `One sizing of ${who} stands in ${placed} places, so its properties move in all of them together; this view cannot answer for one side of the pair.`,
        );
    }
    return out;
  });
  const list = (keys: string[]): string =>
    keys.length > 1 ? `${keys.slice(0, -1).join(', ')} or ${keys[keys.length - 1]}` : keys[0];
  const head = (d: string): string => (d === OWN_DEVICE ? 'this sheet' : d);
  const signed = signedRatio;

  function cell(
    c: PropertyColumn,
    row: { relPerPct?: number; why?: string } | undefined,
    what: string,
  ): { text: string; why: string; zero: boolean } {
    const of = `${c.key} of ${deviceWords(c.device)}`;
    if (row?.relPerPct === 0) return { text: '·', why: `${what} does not read ${of}.`, zero: true };
    if (row?.relPerPct !== undefined)
      return {
        text: signed(row.relPerPct),
        why: `${what} moves ${signed(row.relPerPct)} % for 1 % of ${of}.`,
        zero: false,
      };
    return { text: '', why: row?.why ?? `${what} has no value with ${of} moved.`, zero: false };
  }
</script>

<div class="sview" data-properties-view>
  <span class="glabel" title={CONTROL_HELP.propertiesView}>results by device property</span>
  <p class="scap" data-properties-statement>
    This view reads the sheet’s formulas. It does not size or solve the circuit again, so it is not
    what the hardware does when a property changes: a real change of gds moves the operating point,
    and that is not in these numbers. Each cell gives how many percent a result moves when that one
    property of that one device is 1 % larger; a dot marks a formula that does not read it.
  </p>
  {#if view.error}
    <p class="snote">{view.error}</p>
  {:else}
    {#each view.solvedReads as name}
      <p class="snote warn" data-solved-reads>
        {name} is solved by a relation that reads a small-signal property, and this view holds it; in
        the hardware it would move with that property, so every number here is a reading of the formulas
        alone.
      </p>
    {/each}
    {#if groups.length}
      <div class="stable">
        <table>
          <thead>
            <tr>
              <th></th>
              {#each groups as g}<th colspan={g.columns.length} class="dev">{head(g.device)}</th
                >{/each}
            </tr>
            <tr>
              <th></th>
              {#each groups as g}{#each g.columns as c}<th>{c.key}</th>{/each}{/each}
            </tr>
          </thead>
          <tbody>
            {#each view.rows.results as name}
              <tr>
                <th>{name}</th>
                {#each read as c}
                  {@const x = cell(
                    c,
                    c.results.find((r) => r.name === name),
                    name,
                  )}
                  <td class:none={!x.text} class:zero={x.zero} title={x.why}>{x.text}</td>
                {/each}
              </tr>
            {/each}
            {#each view.rows.checks as id}
              <tr>
                <th>left side of {id}</th>
                {#each read as c}
                  {@const x = cell(
                    c,
                    c.checks.find((r) => r.id === id),
                    `The left side of ${id}`,
                  )}
                  <td class:none={!x.text} class:zero={x.zero} title={x.why}>{x.text}</td>
                {/each}
              </tr>
            {/each}
            {#each view.refused as r}
              <tr class="refused">
                <th>{r.name}</th>
                {#each read as _c}<td class="none" title={r.why}></td>{/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="snote">No formula on this sheet reads a small-signal property of any device.</p>
    {/if}
    {#each notes as n}<p class="snote">{n}</p>{/each}
  {/if}
</div>

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
  .scap,
  .snote {
    margin: 0;
    font-size: calc(0.76rem * var(--text-scale));
    opacity: 0.75;
  }
  .snote.warn {
    opacity: 1;
    color: var(--warn, inherit);
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
  thead th.dev {
    text-align: center;
    border-bottom: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  }
  td.none {
    background: color-mix(in srgb, currentColor 5%, transparent);
  }
  td.zero {
    opacity: 0.4;
    text-align: center;
  }
  tr.refused th {
    opacity: 0.55;
  }
</style>
