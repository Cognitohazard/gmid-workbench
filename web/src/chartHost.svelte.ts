// Shared uPlot chart lifecycle for panels. The ChartAdapter is owned OUTSIDE Svelte
// (imperative, per the architecture rule); this hosts the effect trio every charting
// panel repeats: destroy on gate change/unmount, create-or-refit on data change, and
// restyle on a theme/tick-font change. Call once during component init (it registers
// $effect, so it must run in a component's initialization context).
import { untrack } from 'svelte';
import { ChartAdapter, type ChartData, type CursorInfo } from './chart';

export interface ChartHostOpts {
  /** Container element (a bind:this $state); the chart is created once this exists. */
  el: () => HTMLElement | undefined;
  /** Chart data; null/undefined leaves the last good chart untouched. */
  data: () => ChartData | null | undefined;
  /** Gate: while false no chart is (re)created; a CHANGE of the gate destroys the chart. */
  active: () => boolean;
  /** The app-level style epoch — bumped when the theme or tick font changes. */
  styleVersion: () => number;
  onCursor?: (info: CursorInfo | null) => void;
  onAxisToggle?: (axis: 'x' | 'y') => void;
  onScale?: (eff: { x: boolean; y: boolean }) => void;
}

export function chartHost(o: ChartHostOpts): void {
  let chart: ChartAdapter | undefined;
  let builtStyle = -1; // the styleVersion the live chart was last built / restyled at

  // Destroy on gate change (render-kind switch / sweep off) or unmount. Data/axis
  // changes are handled by setData below — including a line-count or colour change,
  // which ChartAdapter rebuilds internally — so a bad expression leaves the last
  // good chart up.
  $effect(() => {
    o.active();
    return () => {
      chart?.destroy();
      chart = undefined;
    };
  });

  // Create when data first arrives, else refit in place.
  $effect(() => {
    const el = o.el();
    const data = o.data();
    if (!o.active() || !el || !data) return;
    if (chart) chart.setData(data);
    else {
      chart = new ChartAdapter(el, data, o.onCursor, o.onAxisToggle, o.onScale);
      builtStyle = untrack(o.styleVersion); // a fresh build already reflects the current style
    }
  });

  // Rebuild only when the theme or tick-font setting changed since the chart was last
  // built — it reads its colour and tick font from CSS only at construction. The
  // version guard skips redundantly rebuilding a chart just created at this style
  // (e.g. every panel on first load, where styleVersion bumps to 1 around creation).
  $effect(() => {
    const sv = o.styleVersion();
    if (chart && sv !== builtStyle) {
      chart.restyle();
      builtStyle = sv;
    }
  });
}
