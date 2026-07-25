<script lang="ts">
  // A small circled "?" that opens a PINNED help bubble: it stays until dismissed (Escape, a
  // click outside, or clicking "?" again), so the text can be read while working the control it
  // describes — and selected and copied, which a native tooltip cannot be. Hover still shows the
  // one-line native tooltip, suppressed while the bubble is open so the two never stack.
  //
  // The bubble is a NATIVE popover, not an absolutely-positioned child: help icons sit inside
  // scrolling panels (.sizer, .sheet, the panel grid) whose overflow would clip an in-flow
  // bubble. The top layer is immune to that and brings light dismiss with it. The cost is manual
  // placement — the top layer is not laid out relative to the trigger — so the bubble is placed
  // against the trigger's rect on open and dismissed on scroll/resize rather than chasing a
  // moving anchor (CSS anchor positioning is not portable enough to lean on yet).
  //
  // CONSUMER CONSTRAINT: this renders a <button>, which is a labelable element — placed inside a
  // <label> before the input, it would become the label's implicit control and steal the
  // click/name association. Inside a label, either put it after the input or give the label an
  // explicit for/id pair (see Sizer.svelte).
  let { text }: { text: string } = $props();

  const id = $props.id();
  let trigger = $state<HTMLButtonElement>();
  let bubble = $state<HTMLDivElement>();
  let open = $state(false);

  function onToggle(e: Event): void {
    open = (e as ToggleEvent).newState === 'open';
    if (!open || !bubble || !trigger) return;
    // Place below the icon, clamped into the viewport: a "?" can sit hard against any edge of
    // a dense panel, and the top layer will happily render the bubble off-screen. Below is
    // preferred, but an icon low in a tall aside flips above rather than opening off the fold.
    const r = trigger.getBoundingClientRect();
    const xLimit = Math.max(4, window.innerWidth - bubble.offsetWidth - 4);
    const below = r.bottom + 4;
    const fitsBelow = below + bubble.offsetHeight + 4 <= window.innerHeight;
    const top = fitsBelow ? below : Math.max(4, r.top - bubble.offsetHeight - 4);
    bubble.style.left = `${Math.round(Math.min(Math.max(r.left, 4), xLimit))}px`;
    bubble.style.top = `${Math.round(top)}px`;
  }

  // A top-layer bubble does not travel with its trigger, so close it rather than let it drift
  // away from the control it explains.
  $effect(() => {
    if (!open) return;
    const hide = (): void => bubble?.hidePopover();
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  });
</script>

<button
  type="button"
  class="help"
  bind:this={trigger}
  popovertarget={id}
  title={open ? undefined : text}
  aria-expanded={open}
  aria-label={text}>?</button
>
<div class="bubble" {id} popover="auto" bind:this={bubble} ontoggle={onToggle}>{text}</div>

<style>
  /* A button (not a span) so it is keyboard-reachable; it carries the short native tooltip and
     toggles the pinned bubble. Button chrome is reset to keep the circled-"?" look. */
  .help {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.05em;
    height: 1.05em;
    padding: 0;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
    font: inherit;
    font-size: 0.72em;
    font-weight: 600;
    line-height: 1;
    color: inherit;
    background: none;
    opacity: 0.55;
    cursor: help;
    user-select: none;
    flex: none;
  }
  .help:hover {
    opacity: 1;
  }
  .help:focus-visible,
  .help:has(+ :popover-open) {
    opacity: 1;
    outline: 1px solid color-mix(in srgb, currentColor 55%, transparent);
    outline-offset: 1px;
  }

  /* Same chrome as the dashboard's other popovers. `inset: auto` overrides the popover UA
     default (auto margins centering it in the viewport) so the placement above takes effect. */
  .bubble {
    position: fixed;
    inset: auto;
    margin: 0;
    max-width: min(42ch, 80vw);
    padding: 0.45rem 0.6rem;
    color: inherit;
    background: var(--bg, canvas);
    border: 1px solid #8884;
    border-radius: 4px;
    box-shadow: 0 2px 10px #0004;
    font-size: 0.85em;
    line-height: 1.45;
    /* Selectable: being able to copy a formula or a term out of the help is half the point. */
    user-select: text;
  }
</style>
