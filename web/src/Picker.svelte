<script lang="ts">
  // The topology picker: type the spec you have, and the catalog answers which design-types
  // close on the loaded table, at what current, at what margin, and what binds each one. It
  // holds no numerics and no rules — pickTopology searches one sheet and never throws, and
  // rankCandidates owns the order and the honesty rules that go with showing results in one.
  // What is here is the entry form, the queue that keeps the page responsive, and the cell text.
  import {
    marginSpeaksFor,
    pickTopology,
    rankCandidates,
    SPEC_FIELDS,
    PICKER_MS_BUDGET,
    PICKER_EVAL_BUDGET,
    formatEng,
    formatSI,
    type DeviceTable,
    type PickerCandidate,
    type PickerSortKey,
    type PickerSpec,
    type PickerVerdict,
    type SheetDoc,
    type SpecName,
  } from '@gmid/mostab-core';
  import Help from './Help.svelte';
  import { CONTROL_HELP } from './help';
  import { commitEng, pct } from './eng';
  import { SEARCHABLE_SHEETS } from './library';
  import { tableUid } from './dashboard';
  import { sheetRefIndex } from './sheetlib.svelte';

  // The picker reads the active device and the curated library; `onOpen` hands a chosen
  // candidate to the dashboard. The open/close toggle stays in App, which renders this only
  // while open (and only once a device is loaded — the search needs a table).
  let {
    device,
    onOpen,
  }: {
    device: DeviceTable;
    onOpen: (doc: SheetDoc, overrides: Record<string, number>) => void;
  } = $props();

  const refs = $derived(sheetRefIndex());

  // The spec being typed. A field is absent, never zero, when the designer has not stated it:
  // an empty box means "not my requirement, keep the sheet's own default".
  let spec = $state<PickerSpec>({});
  // Both per-sheet bounds, editable, because either one can be the one that stops a search and
  // a designer who cannot move the binding one cannot buy a deeper search. The clock binds on a
  // real PDK table (~180 ms an evaluation, so 1.5 s buys under ten); the evaluation cap binds
  // on a small one (~0.1 ms an evaluation, so 200 of them go by in a fraction of the clock).
  let msBudget = $state(PICKER_MS_BUDGET);
  let evalBudget = $state(PICKER_EVAL_BUDGET);
  let sortKey = $state<PickerSortKey>('margin');

  // `$state.raw`: results are replaced wholesale as each sheet lands, and a candidate is
  // read-only plain data — nothing here mutates one, so the deep proxy would be pure cost.
  let results = $state.raw<PickerCandidate[]>([]);
  let running = $state(false);
  let cancelled = $state(false);
  let elapsed = $state(0);
  /** The spec the CURRENT results were searched against — frozen at run start, so editing a
   *  field mid-run cannot make the table a mix of two questions or restate the coverage
   *  denominator under rows that were scored against a different one. */
  let ranSpec = $state.raw<PickerSpec>({});
  /** The device the current results were searched on, for the same reason. */
  let ranTable = $state('');
  /** Sheets whose evaluation threw — only reachable if the core ever breaks its never-throws
   *  contract. Listed by name so a run that is missing a design type says which one and why,
   *  rather than quietly returning 24 answers to a 25-sheet question. */
  let crashed = $state.raw<{ path: string; why: string }[]>([]);
  /** The last candidate handed to the dashboard. The new panel is appended at the end of a grid
   *  this panel is sitting on top of, so without a word here a click can look like nothing. */
  let opened = $state<string | null>(null);

  // One run is identified by a token. Cancelling, restarting, or unmounting bumps it, and
  // every queue step checks it before doing anything — the search itself is synchronous and
  // cannot be interrupted mid-sheet, so a cancel takes effect at the next sheet boundary.
  let token = 0;

  const total = SEARCHABLE_SHEETS.length;

  /** A budget box: the entered number when it is at or above the floor, and the last good value
   *  otherwise (restoring the box), so a cleared or nonsense entry never becomes the bound. */
  function budgetValue(el: HTMLInputElement, floor: number, current: number): number {
    const v = Number(el.value);
    if (Number.isFinite(v) && v >= floor) return v;
    el.value = String(current);
    return current;
  }

  function setField(name: SpecName, v: number | null): void {
    if (v === null) {
      const { [name]: _drop, ...rest } = spec;
      spec = rest;
    } else spec = { ...spec, [name]: v };
  }

  function run(): void {
    const mine = ++token;
    // Everything the run is an answer ABOUT is frozen here: the spec, the reference index,
    // the budgets, and the device table. `device` is a prop, so reading it inside the queue
    // would let a device switch mid-run produce one table of rows answered on two different
    // devices, ranked against each other with nothing saying so.
    const frozen = { ...$state.snapshot(spec) } as PickerSpec;
    const index = refs;
    const table = device;
    const budget = { msBudget, evalBudget };
    ranSpec = frozen;
    ranTable = tableUid(table);
    results = [];
    cancelled = false;
    crashed = [];
    running = true;
    elapsed = 0;
    const t0 = performance.now();
    let i = 0;
    // One sheet per slice, handed back to the event loop between sheets. That is what keeps
    // the cancel button (and the rest of the page) alive during a run: the per-sheet budget
    // bounds how long a single slice can hold the thread. Deliberately not a Web Worker — the
    // offline single-file build inlines every asset, and a worker adds a build risk this
    // avoids for the same result.
    const step = (): void => {
      if (mine !== token) return;
      const s = SEARCHABLE_SHEETS[i];
      if (!s) {
        running = false;
        elapsed = performance.now() - t0;
        return;
      }
      let c: PickerCandidate | undefined;
      try {
        c = pickTopology(frozen, s, table, undefined, {
          refs: index,
          ...budget,
          now: () => performance.now(),
        });
      } catch (e) {
        // The core's contract is that it never throws. If that ever stops holding, ONE bad
        // sheet must not cost the designer the other 24: the failure is recorded against the
        // sheet that caused it and the queue keeps draining. It is reported separately from
        // the verdicts because "the search crashed here" is not one of the three answers a
        // candidate can give — folding it into `did not close` would be the exact conflation
        // the three verdicts exist to prevent.
        crashed = [...crashed, { path: s.path, why: e instanceof Error ? e.message : String(e) }];
      }
      if (mine !== token) return;
      i += 1;
      if (c) results = [...results, c];
      elapsed = performance.now() - t0;
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  function cancel(): void {
    token += 1;
    running = false;
    cancelled = true;
  }

  // A closed panel must not leave a queue evaluating sheets nobody is watching.
  $effect(() => () => {
    token += 1;
  });

  /** The results on screen answer the spec the run STARTED with. Editing a field afterwards
   *  leaves a table that reads as an answer to the question now on the form, so say it. */
  const stale = $derived(
    results.length > 0 &&
      (tableUid(device) !== ranTable ||
        SPEC_FIELDS.some((f) => (spec[f.name] ?? null) !== (ranSpec[f.name] ?? null))),
  );

  // The ordering, the partition and the coverage denominator are the core's: they are rules
  // about the results, not about the page, and they are pinned by the core suite.
  const view = $derived(rankCandidates(results, sortKey));

  // ── Cell text.
  const VERDICT: Record<PickerVerdict, string> = {
    closed: 'closed',
    'did-not-close': 'did not close',
    'could-not-be-searched': 'not searched',
  };

  /** The cause column, which is never blank: an infeasible candidate always carries the core's
   *  composed cause, and a closed one names the rule with the least room left. */
  function why(c: PickerCandidate): string {
    if (c.cause) return c.cause;
    return c.worstMargin
      ? `tightest rule: ${c.worstMargin.id}`
      : 'no hard rule could be measured at this point';
  }

  /** The margin column, and the one case where it must refuse to print a number: when the core
   *  says the margin does not speak for this candidate, the cell prints "—" and puts the number,
   *  with what it does and does not cover, in the tooltip. */
  function margin(c: PickerCandidate): string {
    return c.worstMargin && marginSpeaksFor(c) ? pct(c.worstMargin.marginPct) : '—';
  }

  function marginTitle(c: PickerCandidate): string {
    if (!c.worstMargin) return 'no hard rule could be measured at this point';
    if (marginSpeaksFor(c)) return `worst hard-rule margin at this point: ${c.worstMargin.id}`;
    return `the rules that could be evaluated read ${pct(c.worstMargin.marginPct)} (${c.worstMargin.id}), but they do not speak for this sheet — it is infeasible for a reason no rule measures`;
  }

  /** Quiescent current, qualified when the back-off ended on the author's slider floor: that
   *  value is a limit of the SEARCH, not a property of the design, and must not read as one. */
  function iq(c: PickerCandidate): string {
    if (c.I_q === undefined) return 'not published';
    const v = `${formatSI(c.I_q)}A`;
    return c.currentAtRangeFloor ? `≤ ${v} (range floor)` : v;
  }

  /** How much of the typed spec this sheet answers. With nothing typed there is no fraction to
   *  report — every sheet was screened at its own defaults, and saying "0 of your 0" would read
   *  as a failure to consume something. */
  function coverage(c: PickerCandidate): string {
    const { consumed, supplied: n } = c.specCoverage;
    return n === 0 ? 'defaults' : `${consumed} of your ${n}`;
  }

  /** Everything the sheet could not use, for the coverage cell's tooltip — this is where the
   *  name-and-unit match discloses itself. */
  function ignoredText(c: PickerCandidate): string {
    if (c.specCoverage.supplied === 0)
      return 'no spec was typed, so this sheet was searched at its own authored values';
    if (!c.specIgnored.length) return 'every field you supplied was used by this sheet';
    return c.specIgnored.map((m) => `${m.name}: ${m.reason}`).join('\n');
  }

  function open(c: PickerCandidate): void {
    const doc = SEARCHABLE_SHEETS.find((s) => s.path === c.path)?.doc;
    if (!doc) return;
    // The knobs the search found, plus the spec fields this sheet consumed — the spec values
    // are read from the run's own frozen spec, never from trusting that an override landed.
    // `specApplied` names are vocabulary fields by construction, but the core reports them as
    // plain strings, so the frozen spec is read through a widened view rather than asserted.
    const values: Record<string, number | undefined> = ranSpec;
    const overrides: Record<string, number> = { ...c.knobs };
    for (const name of c.specApplied) {
      const v = values[name];
      if (v !== undefined) overrides[name] = v;
    }
    onOpen(doc, overrides);
    opened = c.title;
  }
</script>

{#snippet head()}
  <thead>
    <tr>
      <th>design type</th>
      <th>verdict</th>
      <th>margin <Help text={CONTROL_HELP.pickerMargin} /></th>
      <th>what binds it</th>
      <th>I<sub>q</sub></th>
      <th>spec <Help text={CONTROL_HELP.pickerCoverage} /></th>
    </tr>
  </thead>
{/snippet}

<!-- One row markup for both tables: a partitioned candidate is shown exactly what a ranked
     one is, because clicking either applies the same knobs. -->
{#snippet resultRow(c: PickerCandidate)}
  {@const w = why(c)}
  <tr class="row v-{c.verdict}" data-path={c.path}>
    <td class="name">
      <button class="open" onclick={() => open(c)} title="open this sheet with the values found"
        >{c.title}</button
      >
      <span class="grp">{c.group}</span>
      {#if Object.keys(c.knobs).length}
        <span class="knobs"
          >{#each Object.entries(c.knobs) as [k, v], i (k)}{i ? ', ' : ''}<code data-knob={k}
              >{k}={formatEng(v)}</code
            >{/each}</span
        >
      {/if}
    </td>
    <td class="verdict">
      <span class="chip">{VERDICT[c.verdict]}</span>
      <span class="sub">{c.evals} evals</span>
    </td>
    <td class="mar" title={marginTitle(c)}>{margin(c)}</td>
    <td class="why" title={w}>{w}</td>
    <td class="iq">{iq(c)}</td>
    <td class="cov" title={ignoredText(c)}>{coverage(c)}</td>
  </tr>
{/snippet}

<aside class="picker">
  <h2>pick a topology <Help text={CONTROL_HELP.picker} /></h2>
  <p class="lede">
    Type the spec you have. Every amplifier and buffer sheet in the library is searched against it,
    and each says whether it closes, at what current, and what binds it.
  </p>

  <div class="spec">
    {#each SPEC_FIELDS as f (f.name)}
      {@const v = spec[f.name]}
      <label title="{f.note} ({f.unit})">
        <span>{f.name}</span>
        <input
          class="num"
          data-spec={f.name}
          placeholder={f.unit}
          spellcheck="false"
          value={v === undefined ? '' : formatEng(v)}
          onchange={(e) => commitEng(e.currentTarget, v, (x) => setField(f.name, x), true)}
        />
      </label>
    {/each}
  </div>

  <div class="go">
    {#if running}
      <button class="pbtn" onclick={cancel}>stop</button>
    {:else}
      <button class="pbtn" onclick={run}>search {total} sheets</button>
    {/if}
    <label class="budget" title="wall clock allowed per sheet before the search stops and says so"
      >ms/sheet
      <input
        class="num"
        type="number"
        min="10"
        step="100"
        data-budget="ms"
        value={msBudget}
        onchange={(e) => (msBudget = budgetValue(e.currentTarget, 10, msBudget))}
      /></label
    >
    <label
      class="budget"
      title="sheet evaluations allowed per sheet — the other bound, and the
one that stops the search first on a small table"
      >evals/sheet
      <input
        class="num"
        type="number"
        min="1"
        step="50"
        data-budget="evals"
        value={evalBudget}
        onchange={(e) => (evalBudget = budgetValue(e.currentTarget, 1, evalBudget))}
      /></label
    >
    <span class="prog" data-progress
      >{results.length} of {total}{elapsed ? ` · ${(elapsed / 1000).toFixed(1)} s` : ''}{cancelled
        ? ' · stopped'
        : ''}</span
    >
  </div>
  {#each crashed as c (c.path)}
    <p class="fail">{c.path} could not be evaluated at all: {c.why}</p>
  {/each}
  {#if opened}
    <p class="hint" data-opened>{opened} — added as a new panel on the dashboard.</p>
  {/if}

  {#if results.length}
    <div class="sortbar">
      <label
        >sort by
        <select bind:value={sortKey} data-sort>
          <option value="margin">margin</option>
          <option value="current">current</option>
        </select>
      </label>
      <span class="hint" data-stale={stale ? '' : undefined}
        >{stale
          ? 'the spec has been edited — these rows answer the previous one; search again'
          : `feasible first · ${view.supplied} field${view.supplied === 1 ? '' : 's'} supplied`}</span
      >
    </div>

    <table class="res" data-section="ranked">
      {@render head()}
      <tbody>
        {#each view.ranked as c (c.path)}{@render resultRow(c)}{/each}
      </tbody>
    </table>

    {#if view.other.length}
      <h3>answers a different question</h3>
      <p class="hint">
        These consumed fewer than {view.threshold} of the {view.supplied} field{view.supplied === 1
          ? ''
          : 's'} you supplied, so they are not comparable with the results above and are not ranked against
        them.
      </p>
      <table class="res" data-section="partition">
        {@render head()}
        <tbody>
          {#each view.other as c (c.path)}{@render resultRow(c)}{/each}
        </tbody>
      </table>
    {/if}
  {/if}

  <div class="honesty">
    <p>
      Each sheet gets a bounded search — {msBudget} ms of wall clock or {evalBudget} evaluations, whichever
      runs out first (on a small table it is the evaluations; on a full PDK table, the clock). A design
      type that did not close was not shown to be impossible: it means no closing point was found inside
      that budget, and a longer budget or a different starting point may find one.
    </p>
    <p>
      Searched: the {total} amplifier and buffer sheets. Application sheets translate a spec into amplifier
      requirements rather than answering one, and mirror and bias sheets answer a different question in
      a different vocabulary — neither is searched here.
    </p>
    <p>
      The search moves the author's design choices only. The input common mode (CM_dc) is a spec the
      engine solves around, not a knob: when a common-mode rule binds, the first thing a designer
      would move is out of the search's reach, and yours to change in the sheet.
    </p>
  </div>
</aside>

<style>
  .picker {
    width: min(48rem, 62vw);
    flex: none;
    overflow: auto;
    border-left: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    padding: 0.6rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .picker h2 {
    font-size: calc(0.95rem * var(--text-scale));
    margin: 0;
  }
  .picker h3 {
    font-size: calc(0.85rem * var(--text-scale));
    margin: 0.6rem 0 0;
    padding-top: 0.5rem;
    border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  }
  .lede,
  .hint {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.65;
  }
  .spec {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    gap: 0.3rem 0.6rem;
  }
  .spec label {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.4rem;
  }
  .picker input,
  .picker select {
    font: inherit;
    font-size: calc(0.85rem * var(--text-scale));
    width: 5.5rem;
    min-width: 0;
    background: transparent;
    color: inherit;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 3px;
    padding: 0.1rem 0.25rem;
  }
  .pbtn {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
  }
  .go {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-top: 0.2rem;
  }
  .go .budget {
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
    font-size: 0.85em;
    opacity: 0.75;
  }
  .go .budget input {
    width: 4rem;
  }
  .fail {
    margin: 0;
    font-size: 0.85em;
    color: var(--err);
  }
  .prog {
    font-size: 0.85em;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
  .sortbar {
    display: flex;
    align-items: baseline;
    gap: 0.8rem;
    font-size: 0.85em;
  }
  .res {
    width: 100%;
    border-collapse: collapse;
    font-size: calc(0.8rem * var(--text-scale));
  }
  .res th {
    text-align: left;
    font-weight: 500;
    opacity: 0.6;
    white-space: nowrap;
    padding: 0.15rem 0.3rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  }
  .res td {
    padding: 0.2rem 0.3rem;
    vertical-align: top;
    border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent);
  }
  .res .name {
    min-width: 11rem;
  }
  .res .open {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    cursor: pointer;
    text-decoration: underline dotted;
  }
  .res .open:hover {
    text-decoration: underline;
  }
  .res .grp,
  .res .sub,
  .res .knobs {
    display: block;
    font-size: 0.85em;
    opacity: 0.55;
  }
  .res .knobs code {
    font-size: inherit;
  }
  .res .mar,
  .res .iq,
  .res .cov {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  /* The cause runs long (it names every fact that applies); two lines here, the whole of it
     in the cell's tooltip. */
  .res .why {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    max-width: 20rem;
  }
  .res .cov {
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  .chip {
    display: inline-block;
    border-radius: 3px;
    padding: 0 0.3rem;
    white-space: nowrap;
    background: color-mix(in srgb, currentColor 12%, transparent);
  }
  .v-closed .chip {
    color: var(--ok);
    background: color-mix(in srgb, var(--ok) 16%, transparent);
  }
  .v-did-not-close .chip {
    color: var(--err);
    background: color-mix(in srgb, var(--err) 16%, transparent);
  }
  /* "Not searched" is deliberately neutral, not red: the sheet made no claim either way. */
  .v-could-not-be-searched .chip {
    background: color-mix(in srgb, currentColor 14%, transparent);
  }
  .honesty {
    margin-top: 0.6rem;
    padding-top: 0.5rem;
    border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    font-size: 0.8em;
    opacity: 0.7;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .honesty p {
    margin: 0;
  }
</style>
