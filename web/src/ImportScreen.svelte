<script lang="ts">
  // The import screen: one row per table, with its device and its value in each of the bench's
  // condition dimensions. Opened on a batch of new files before they join the bench, and reopened
  // on the tables already loaded. A value the importer filled in by itself is marked assumed; one
  // the designer types, or one read from the file's own header when a dimension is added, is
  // declared. Nothing here is stored or sent anywhere: the bench applies the result.
  import { dimensionName, type ConditionDimension, type DeviceTable } from '@gmid/mostab-core';
  import {
    addDimension,
    applyRows,
    deviceFit,
    isAssumed,
    removeDimension,
    typed,
    type ImportRow,
  } from './importscreen';

  let {
    mode,
    rows: initialRows,
    dimensions: initialDimensions,
    failed = [],
    bench = [],
    onconfirm,
    oncancel,
  }: {
    /** 'new': a batch of files about to be imported; 'stored': the tables already loaded. */
    mode: 'new' | 'stored';
    rows: ImportRow[];
    dimensions: readonly ConditionDimension[];
    /** Files in the batch that could not be read, by name, with why. */
    failed?: readonly { name: string; error: string }[];
    /** The tables on the bench: their devices are offered when a row's device is changed, and
     *  a row named as one of them says whether it joins it. */
    bench?: readonly DeviceTable[];
    /** Apply the screen. Returns, per row, why the bench refuses that row's new table (or
     *  undefined); when none is refused the bench has applied every row. */
    onconfirm: (
      dimensions: ConditionDimension[],
      rows: ImportRow[],
      tables: DeviceTable[],
    ) => (string | undefined)[];
    oncancel: () => void;
  } = $props();

  // The screen edits copies; nothing reaches the bench until the designer confirms.
  // svelte-ignore state_referenced_locally
  let rows = $state<ImportRow[]>(initialRows.map((r) => ({ ...r })));
  // svelte-ignore state_referenced_locally
  let dimensions = $state<ConditionDimension[]>([...initialDimensions]);
  let removed = $state<string[]>([]);
  let newName = $state('');
  let newKind = $state<ConditionDimension['kind']>('text');
  let addError = $state<string | null>(null);

  const dimNames = $derived(dimensions.map((d) => dimensionName(d.name)));
  /** Every device a row can be assigned to without typing it: the bench's and the batch's, as
   *  their files name them (not as a row is being retyped). */
  const deviceChoices = $derived([
    ...new Set([...bench.map((t) => t.id.device), ...rows.map((r) => r.table.id.device)]),
  ]);
  /** A row named as a device on the bench that it does not join, because its process namespace
   *  or polarity differs: said on the row, since the two would otherwise read as one name. */
  const apart = (r: ImportRow): boolean =>
    r.declared.includes('device') && deviceFit(r.table, r.cells.device ?? '', bench) === 'apart';
  /** Headers the files declared that are not dimensions yet: what a designer is likely to add. */
  const offered = $derived(
    [
      ...new Set(
        rows.flatMap((r) => Object.keys(r.table.meta.extra ?? {}).map((k) => dimensionName(k))),
      ),
    ].filter((n) => n !== '' && n !== 'device' && !dimNames.includes(n)),
  );

  function add(name: string, kind: ConditionDimension['kind']): void {
    const r = addDimension(dimensions, rows, name, kind);
    if (!r.ok) {
      addError = r.error;
      return;
    }
    addError = null;
    dimensions = r.dimensions;
    rows = r.rows;
    removed = removed.filter((n) => n !== dimensionName(name));
    newName = '';
  }

  /** A header offered as a dimension is a number when every file that declares it writes one. */
  function kindOfHeader(name: string): ConditionDimension['kind'] {
    const vals = rows
      .map((r) => Object.entries(r.table.meta.extra ?? {}).find(([k]) => dimensionName(k) === name))
      .filter((e) => e !== undefined)
      .map(([, v]) => String(v).trim());
    return vals.length && vals.every((v) => v !== '' && Number.isFinite(Number(v)))
      ? 'number'
      : 'text';
  }

  function remove(name: string): void {
    const r = removeDimension(dimensions, rows, name);
    dimensions = r.dimensions;
    rows = r.rows;
    if (!removed.includes(name)) removed = [...removed, name];
  }

  function confirm(): void {
    const applied = applyRows(rows, dimensions, removed);
    rows = applied.rows;
    if (applied.tables.some((t) => t === undefined)) return;
    const refused = onconfirm(
      $state.snapshot(dimensions) as ConditionDimension[],
      rows,
      applied.tables as DeviceTable[],
    );
    if (refused.some((e) => e)) rows = rows.map((r, i) => ({ ...r, error: refused[i] }));
  }

  function onkey(e: KeyboardEvent): void {
    if (e.key === 'Escape') oncancel();
  }
</script>

<div
  class="importscreen"
  role="dialog"
  aria-modal="true"
  tabindex="-1"
  aria-label={mode === 'new' ? 'import tables' : 'table conditions'}
  data-import-screen={mode}
  onkeydown={onkey}
>
  <h2>{mode === 'new' ? 'Import tables' : 'Conditions of the loaded tables'}</h2>
  <p class="lead">
    One row per table: the device it characterizes — pick one on the bench or name a new one — and
    the condition it was characterized at. A value marked
    <span class="assumed-tag">assumed</span> was filled in because the file does not declare it; type
    a value to declare it.
  </p>
  <div class="grid">
    <table>
      <thead>
        <tr>
          <th>{mode === 'new' ? 'file' : 'table'}</th>
          <th>device</th>
          {#each dimensions as d (dimensionName(d.name))}
            {@const n = dimensionName(d.name)}
            <th data-dim={n}>
              {n}{d.unit ? ` (${d.unit})` : ''}
              <span class="kind">{d.kind}</span>
              <button
                class="dimrm"
                onclick={() => remove(n)}
                title="take {n} out of every table's condition"
                aria-label="remove dimension {n}">×</button
              >
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as r, i (i)}
          <tr data-row={r.name} class:bad={!!r.error}>
            <td class="file">{r.name}</td>
            <td class="device">
              <input
                data-cell="device"
                class:assumed={isAssumed(r, 'device')}
                list="import-devices"
                value={r.cells.device ?? ''}
                placeholder="device"
                aria-label="{r.name} device"
                oninput={(e) =>
                  (rows[i] = typed(r, 'device', (e.currentTarget as HTMLInputElement).value))}
              />{#if isAssumed(r, 'device')}<span class="assumed-tag" data-assumed="device"
                  >assumed</span
                >{:else if apart(r)}<span class="device-apart" data-device-apart
                  >a device of its own: the {r.cells.device.trim()} on the bench declares another process
                  or polarity</span
                >{/if}
            </td>
            {#each dimNames as n (n)}
              {@const assumed = isAssumed(r, n)}
              <td>
                <input
                  data-cell={n}
                  class:assumed
                  value={r.cells[n] ?? ''}
                  placeholder="not set"
                  aria-label="{r.name} {n}"
                  oninput={(e) =>
                    (rows[i] = typed(r, n, (e.currentTarget as HTMLInputElement).value))}
                />{#if assumed}<span class="assumed-tag" data-assumed={n}>assumed</span>{/if}
              </td>
            {/each}
          </tr>
          {#if r.error}
            <tr class="rowerr"
              ><td colspan={dimNames.length + 2} data-row-error={r.name}>{r.error}</td></tr
            >
          {/if}
        {/each}
      </tbody>
    </table>
    <datalist id="import-devices">
      {#each deviceChoices as d (d)}<option value={d}></option>{/each}
    </datalist>
  </div>
  {#if failed.length}
    <ul class="failed">
      {#each failed as f (f.name)}
        <li data-failed={f.name}>{f.name}: {f.error} — not imported</li>
      {/each}
    </ul>
  {/if}
  <div class="adddim">
    <span>add a dimension</span>
    {#each offered as n (n)}
      <button
        data-offer={n}
        onclick={() => add(n, kindOfHeader(n))}
        title="from the files' # {n}: header">+ {n}</button
      >
    {/each}
    <input bind:value={newName} placeholder="name" aria-label="new dimension name" data-new-dim />
    <select bind:value={newKind} aria-label="new dimension kind" data-new-kind>
      <option value="text">text</option>
      <option value="number">number</option>
    </select>
    <button onclick={() => add(newName, newKind)} data-add-dim>add</button>
    {#if addError}<span class="err" data-add-error>{addError}</span>{/if}
  </div>
  <div class="actions">
    <button class="primary" onclick={confirm} data-import-confirm
      >{mode === 'new'
        ? `import ${rows.length} ${rows.length === 1 ? 'table' : 'tables'}`
        : 'apply'}</button
    >
    <button onclick={oncancel} data-import-cancel>cancel</button>
  </div>
</div>

<style>
  .importscreen {
    position: fixed;
    inset: 5vh 5vw auto;
    max-height: 90vh;
    overflow: auto;
    z-index: 50;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid #8886;
    border-radius: 8px;
    box-shadow: 0 8px 32px #0005;
    padding: 1rem 1.25rem;
    font-size: calc(0.85rem * var(--text-scale, 1));
  }
  h2 {
    margin: 0 0 0.4rem;
    font-size: 1.1em;
  }
  .lead {
    margin: 0 0 0.75rem;
    opacity: 0.85;
  }
  .grid {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    padding: 0.2rem 0.5rem;
    border-bottom: 1px solid #8883;
    white-space: nowrap;
  }
  th .kind {
    opacity: 0.6;
    font-weight: normal;
    font-size: 0.85em;
  }
  td.file {
    font-family: monospace;
  }
  input {
    font: inherit;
    width: 7rem;
  }
  input.assumed {
    font-style: italic;
    opacity: 0.75;
  }
  .device-apart {
    display: block;
    font-size: 0.75rem;
    color: var(--warn);
  }
  .assumed-tag {
    margin-left: 0.3rem;
    font-size: 0.8em;
    color: var(--warn);
  }
  tr.bad td {
    background: #f003;
  }
  .rowerr td,
  .err,
  .failed {
    color: var(--err);
  }
  .adddim,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
    margin-top: 0.75rem;
  }
  .adddim input {
    width: 8rem;
  }
  button {
    font: inherit;
    cursor: pointer;
  }
  .dimrm {
    border: none;
    background: none;
    color: inherit;
    padding: 0 0.2rem;
  }
  .primary {
    font-weight: 600;
  }
</style>
