<script lang="ts">
  // A small circled "?" that exposes its help text as a native tooltip (no tooltip library).
  let { text }: { text: string } = $props();
</script>

<span class="help" title={text} aria-label={text}>?</span>

<style>
  .help {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.05em;
    height: 1.05em;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
    font-size: 0.72em;
    font-weight: 600;
    line-height: 1;
    opacity: 0.55;
    cursor: help;
    user-select: none;
    flex: none;
  }
  .help:hover {
    opacity: 1;
  }
</style>
