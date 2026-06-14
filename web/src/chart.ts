// Owned imperative wrapper around uPlot. The chart lives OUTSIDE the framework —
// Svelte only calls create / setData / destroy — so the 60 Hz render + cursor
// path is framework-free. uPlot's own CSS must be imported or it won't lay out.
import uPlot from 'uplot';
import type { AlignedData, Options, Series } from 'uplot';
import { formatEng } from '@gmid/mostab-core';
import 'uplot/dist/uPlot.min.css';

export interface ChartData {
  /** Shared X lattice. */
  x: number[];
  /** One Y array per line; same length as x; null renders as a gap. */
  lines: (number | null)[][];
  /** One label per line (legend + cursor readout). */
  lineLabels: string[];
  xLabel: string;
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

  constructor(
    private el: HTMLElement,
    data: ChartData,
    private onCursor?: (info: CursorInfo | null) => void,
  ) {
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

  /** Replace the data. Recreates only if the line count changed; else refits in place. */
  setData(data: ChartData): void {
    if (this.u.series.length - 1 === data.lines.length) {
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
    const opts: Options = {
      width: this.el.clientWidth || 800,
      height: this.el.clientHeight || 360,
      scales: { x: { time: false } },
      legend: { show: false }, // we own the readout/color-key in the app footer
      cursor: { focus: { prox: 24 } },
      // Engineering-suffix Y ticks (70G, 8G, 25m…) — the quantity spans many
      // decades across expressions; raw integers overflow the gutter.
      axes: [{ label: data.xLabel }, { values: (_u, splits) => splits.map((v) => formatEng(v, 3)) }],
      series: [
        {},
        ...data.lineLabels.map(
          (label, i): Series => ({
            label,
            stroke: PALETTE[i % PALETTE.length],
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
        color: PALETTE[i % PALETTE.length],
      };
    });
    const fs = this.focusedSeries;
    this.onCursor({ x, focusedLine: fs != null && fs > 0 ? fs - 1 : null, perLine });
  }
}

function aligned(data: ChartData): AlignedData {
  return [data.x, ...data.lines] as AlignedData;
}
