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
  let trigger = $state<HTMLButtonElement>();
  let menu = $state<HTMLUListElement>();
  const cur = $derived(options.find((o) => o.value === value));

  function pick(v: string): void {
    open = false;
    onPick(v);
    trigger?.focus(); // return focus to the trigger after a pick (keyboard or mouse)
  }
  // While open, dismiss on an outside pointerdown — the one interaction that genuinely
  // needs a window listener (capture phase so it beats the trigger's own toggle).
  // Keyboard handling lives on the component itself (onKey below), where bubbling
  // already scopes it to the picker; focusout (on the root) closes on Tab-out.
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  });
  // Keyboard model while open: Escape closes (returning focus to the trigger); the
  // arrows and Home/End rove focus through the option buttons, wrapping. Attached to
  // the trigger and the listbox — focus is always on one of them while open.
  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === 'Escape') {
      open = false;
      trigger?.focus();
      return;
    }
    if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? i < 0
              ? 0
              : (i + 1) % items.length
            : i <= 0
              ? items.length - 1
              : i - 1;
    items[next].focus();
  }
  // On open, move focus into the listbox — the selected option, or the first — so the arrow keys
  // have a starting point and the listbox is announced.
  $effect(() => {
    if (!open || !menu) return;
    const sel = menu.querySelector<HTMLButtonElement>('.qopt.sel');
    (sel ?? menu.querySelector<HTMLButtonElement>('button'))?.focus();
  });
</script>

<span
  class="qpick"
  bind:this={root}
  data-value={value}
  onfocusout={(e) => {
    // Close when focus leaves the picker (e.g. Tab out), per the listbox pattern —
    // a stale-open menu would otherwise keep capturing arrow keys.
    if (root && !root.contains(e.relatedTarget as Node)) open = false;
  }}
>
  <button
    type="button"
    class="qtrigger"
    {title}
    aria-haspopup="listbox"
    aria-expanded={open}
    bind:this={trigger}
    onclick={() => (open = !open)}
    onkeydown={onKey}
  >
    <span class="qsym">{@html cur ? qLabel(cur.value) : value}</span>
    <span class="qcar" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <ul class="qmenu" role="listbox" bind:this={menu} onkeydown={onKey}>
      {#each options as o}
        <!-- role=presentation: the exposed a11y tree must be listbox → option, without
             listitem wrappers in between. -->
        <li role="presentation">
          <button
            type="button"
            class="qopt"
            role="option"
            aria-selected={o.value === value}
            data-value={o.value}
            class:sel={o.value === value}
            onclick={() => pick(o.value)}
          >
            <span class="qsym">{@html qLabel(o.value)}</span>
            {#if o.formula}<span class="qeq">= {@html qFormula(o.formula)}</span>{/if}
          </button>
        </li>
      {/each}
      <li role="presentation">
        <button
          type="button"
          class="qopt qcustom"
          role="option"
          aria-selected={false}
          onclick={() => pick('__custom__')}>ƒx custom…</button
        >
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
  .qopt:focus-visible {
    background: color-mix(in srgb, currentColor 12%, transparent);
    outline: 1px solid color-mix(in srgb, currentColor 55%, transparent);
    outline-offset: -1px;
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
