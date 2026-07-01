<script lang="ts">
  // A dropdown that renders quantity symbols/equations (native <select> can't show subscripts or
  // fractions). Trigger shows the selected quantity's rendered symbol; the open menu lists every
  // option with its rendered definition. Closes on select, Escape, or an outside pointerdown.
  import { qLabel, qFormula } from './labels';

  let {
    value,
    options,
    title,
    onPick,
  }: {
    value: string;
    options: { value: string; label: string; formula?: string }[];
    title?: string;
    onPick: (v: string) => void; // receives an option value, or '__custom__' for the escape hatch
  } = $props();

  let open = $state(false);
  let root = $state<HTMLElement>();
  const cur = $derived(options.find((o) => o.value === value));

  function pick(v: string): void {
    open = false;
    onPick(v);
  }
  // While open, dismiss on an outside click or Escape (capture phase so it beats the toggle).
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false;
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  });
</script>

<span class="qpick" bind:this={root} data-value={value}>
  <button type="button" class="qtrigger" {title} aria-expanded={open} onclick={() => (open = !open)}>
    <span class="qsym">{@html cur ? qLabel(cur.value) : value}</span>
    <span class="qcar" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <ul class="qmenu">
      {#each options as o}
        <li>
          <button type="button" class="qopt" data-value={o.value} class:sel={o.value === value} onclick={() => pick(o.value)}>
            <span class="qsym">{@html qLabel(o.value)}</span>
            {#if o.formula}<span class="qeq">= {@html qFormula(o.formula)}</span>{/if}
          </button>
        </li>
      {/each}
      <li>
        <button type="button" class="qopt qcustom" onclick={() => pick('__custom__')}>ƒx custom…</button>
      </li>
    </ul>
  {/if}
</span>

<style>
  .qpick {
    position: relative;
    display: inline-flex;
  }
  .qtrigger {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 4px;
    padding: 0.05rem 0.4rem;
    cursor: pointer;
    max-width: 11rem;
  }
  .qtrigger .qsym {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qcar {
    opacity: 0.5;
    font-size: 0.7em;
  }
  .qmenu {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    z-index: 20;
    margin: 0;
    padding: 0.15rem;
    list-style: none;
    max-height: 16rem;
    overflow-y: auto;
    background: var(--bg);
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 5px;
    box-shadow: 0 4px 14px color-mix(in srgb, currentColor 22%, transparent);
    min-width: max-content;
  }
  .qopt {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    width: 100%;
    text-align: left;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    border-radius: 3px;
    padding: 0.15rem 0.5rem;
    white-space: nowrap;
    cursor: pointer;
  }
  .qopt:hover {
    background: color-mix(in srgb, currentColor 12%, transparent);
  }
  .qopt.sel {
    background: color-mix(in srgb, currentColor 16%, transparent);
    font-weight: 600;
  }
  .qopt .qeq {
    opacity: 0.55;
    font-size: 0.9em;
  }
  .qcustom {
    opacity: 0.8;
    font-style: italic;
  }
</style>
