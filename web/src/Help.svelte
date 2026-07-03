<script lang="ts">
  // A small circled "?" that exposes its help text as a native tooltip (no tooltip library).
  // CONSUMER CONSTRAINT: this renders a <button>, which is a labelable element — placed
  // inside a <label> before the input, it would become the label's implicit control and
  // steal the click/name association. Inside a label, either put it after the input or
  // give the label an explicit for/id pair (see Sizer.svelte).
  let { text }: { text: string } = $props();
</script>

<button type="button" class="help" title={text} aria-label={text}>?</button>

<style>
  /* A button (not a span) so it is keyboard-reachable; the native title/aria-label is the whole
     tooltip — no custom tooltip framework. Button chrome is reset to keep the circled-"?" look. */
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
  .help:focus-visible {
    opacity: 1;
    outline: 1px solid color-mix(in srgb, currentColor 55%, transparent);
    outline-offset: 1px;
  }
</style>
