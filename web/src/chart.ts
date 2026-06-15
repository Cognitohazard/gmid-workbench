// Owned imperative wrapper around uPlot. The chart lives OUTSIDE the framework —
// Svelte only calls create / setData / destroy — so the 60 Hz render + cursor
// path is framework-free. uPlot's own CSS must be imported or it won't lay out.
import uPlot from 'uplot';
import type { AlignedData, Options, Series } from 'uplot';
import { formatSI } from '@gmid/mostab-core';
import 'uplot/dist/uPlot.min.css';

export interface ChartData {
  /** Shared X lattice. */
  x: number[];
  /** One Y array per line; same length as x; null renders as a gap. */
  lines: (number | null)[][];
  /** One label per line (legend + cursor readout). */
  lineLabels: string[];
  /** Optional per-line stroke colours (e.g. a colormap gradient); else PALETTE cycles. */
  lineColors?: string[];
  /** Optional per-line dash pattern (uPlot `[on, off]`); null/absent ⇒ a solid line.
   *  Used to distinguish overlaid devices (solid = primary, dashed = overlays). */
  lineDash?: (number[] | null)[];
}

export interface CursorInfo {
  /** X value under the pointer. */
  x: number;
  /** Index into `lines` of the y-proximity-focused curve, or null. */
  focusedLine: number | null;
  /** Each line's value at the hovered X. */
  perLine: { label: string; value: number | null; color: string }[];
}

export const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#bfef45', '#f032e6'];

export class ChartAdapter {
  private u: uPlot;
  private ro: ResizeObserver;
  private focusedSeries: number | null = null;
  private colors: string[] = [];
  private dashes: (number[] | null)[] = [];

  /** Stroke colour for line `i`: the supplied per-line colour, else the PALETTE cycle. */
  private colorAt(i: number): string {
    return this.colors[i] ?? PALETTE[i % PALETTE.length];
  }

  /** Dash pattern for line `i`, or undefined (solid). */
  private dashAt(i: number): number[] | undefined {
    return this.dashes[i] ?? undefined;
  }

  constructor(
    private el: HTMLElement,
    data: ChartData,
    private onCursor?: (info: CursorInfo | null) => void,
  ) {
    this.colors = data.lineColors ?? [];
    this.dashes = data.lineDash ?? [];
    this.u = this.build(data);
    this.ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      // ponytail: skip 0-size (hidden tab / pre-layout) — uPlot.setSize(0,0) breaks its canvas.
      if (r.width > 0 && r.height > 0) {
        this.u.setSize({ width: Math.round(r.width), height: Math.round(r.height) });
      }
    });
    this.ro.observe(el);
  }

  /** Replace the data. Recreates if the line count OR the per-line colours OR dashes changed
   * (uPlot fixes all three at construction); else refits in place. */
  setData(data: ChartData): void {
    const next = data.lineColors ?? [];
    const nextDash = data.lineDash ?? [];
    const sameColors = next.length === this.colors.length && next.every((c, i) => c === this.colors[i]);
    const sameDash = sameDashes(nextDash, this.dashes);
    this.colors = next;
    this.dashes = nextDash;
    if (sameColors && sameDash && this.u.series.length - 1 === data.lines.length) {
      this.u.setData(aligned(data)); // resetScales: true — refit to the new quantity's range
    } else {
      this.u.destroy();
      this.u = this.build(data);
    }
  }

  destroy(): void {
    this.ro.disconnect();
    this.u.destroy();
  }

  private build(data: ChartData): uPlot {
    // uPlot paints axis labels/ticks/grid on the canvas with its own (light-theme)
    // defaults, ignoring `color-scheme`. Resolve the container's current text colour
    // so the chart tracks light/dark like the rest of the UI. (Re-read on rebuild.)
    const fg = getComputedStyle(this.el).color || '#888';
    const faint = fg.startsWith('rgb(') ? fg.replace('rgb(', 'rgba(').replace(')', ', 0.15)') : fg;
    const axis = { stroke: fg, grid: { stroke: faint }, ticks: { stroke: faint } };
    // SI-suffix ticks (200G, 8M, 25m…) — quantities span many decades, so raw integers
    // overflow the gutter. Axis *labels* are rendered as DOM by the Panel (so they can
    // carry subscripts), not drawn here on the canvas.
    const fmtTicks = (_u: uPlot, splits: number[]) => splits.map((v) => formatSI(v, 3));
    const opts: Options = {
      width: this.el.clientWidth || 800,
      height: this.el.clientHeight || 360,
      scales: { x: { time: false } },
      legend: { show: false }, // we own the readout/color-key in the app footer
      cursor: { focus: { prox: 24 } },
      axes: [
        { values: fmtTicks, ...axis },
        { values: fmtTicks, ...axis },
      ],
      series: [
        {},
        ...data.lineLabels.map(
          (label, i): Series => ({
            label,
            stroke: this.colorAt(i),
            dash: this.dashAt(i),
            width: 1.5,
            points: { show: false },
          }),
        ),
      ],
      hooks: {
        setSeries: [
          (_self: uPlot, idx: number | null, sopts: Series) => {
            const focus = (sopts as { focus?: boolean | null }).focus;
            if (focus != null) this.focusedSeries = focus ? idx : null;
          },
        ],
        setCursor: [(self: uPlot) => this.emitCursor(self)],
      },
    };
    return new uPlot(opts, aligned(data), this.el);
  }

  private emitCursor(self: uPlot): void {
    if (!this.onCursor) return;
    const idx = self.cursor.idx;
    if (idx == null) {
      this.onCursor(null);
      return;
    }
    const x = self.data[0][idx] as number;
    const perLine = self.series.slice(1).map((s, i) => {
      const di = self.cursor.idxs?.[i + 1] ?? idx;
      const raw = self.data[i + 1][di];
      return {
        label: String(s.label ?? ''),
        value: raw == null ? null : (raw as number),
        color: this.colorAt(i),
      };
    });
    const fs = this.focusedSeries;
    this.onCursor({ x, focusedLine: fs != null && fs > 0 ? fs - 1 : null, perLine });
  }
}

function aligned(data: ChartData): AlignedData {
  return [data.x, ...data.lines] as AlignedData;
}

/** Per-line dash arrays equal? (null === solid; compared structurally.) */
function sameDashes(a: (number[] | null)[], b: (number[] | null)[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x == null || y == null) {
      if (x !== y) return false;
    } else if (x.length !== y.length || x.some((v, k) => v !== y[k])) {
      return false;
    }
  }
  return true;
}
