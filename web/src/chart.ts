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
  /** Log-scale the X / Y axis (uPlot `distr: 3`); absent/false ⇒ linear. */
  xLog?: boolean;
  yLog?: boolean;
}

export interface CursorInfo {
  /** X value under the pointer. */
  x: number;
  /** Index into `lines` of the y-proximity-focused curve, or null. */
  focusedLine: number | null;
  /** Each line's value at the hovered X. */
  perLine: { label: string; value: number | null; color: string }[];
}

// A muted, pastel-leaning qualitative palette: soft enough to sit on the creamy paper theme,
// still saturated enough to stay distinguishable on both the light and dark backgrounds.
export const PALETTE = [
  '#d2596a',
  '#5b9e6f',
  '#5277c4',
  '#d98a4a',
  '#9a6cb0',
  '#3fa0a8',
  '#b6953f',
  '#c56fa6',
];

export class ChartAdapter {
  private u: uPlot;
  private ro: ResizeObserver;
  private focusedSeries: number | null = null;
  private colors: string[] = [];
  private dashes: (number[] | null)[] = [];
  private xLog = false;
  private yLog = false;
  private lastData: ChartData;
  private onCtx: (e: MouseEvent) => void;

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
    private onAxisToggle?: (axis: 'x' | 'y') => void,
    // Reports the EFFECTIVE log flags after every build — which can differ from the requested
    // ones when effLog downgrades a log axis to linear on non-positive data. The UI reads this
    // (not the request) so the axis label can never claim "log" while the chart renders linear.
    private onScale?: (eff: { x: boolean; y: boolean }) => void,
  ) {
    this.colors = data.lineColors ?? [];
    this.dashes = data.lineDash ?? [];
    const eff = effLog(data);
    this.xLog = eff.x;
    this.yLog = eff.y;
    this.lastData = data;
    this.u = this.build(data);
    this.emitScale();
    // Right-click a gutter (left of the plot ⇒ Y, below it ⇒ X) to toggle that axis' scale.
    // Reads `this.u` live so it keeps working across rebuilds; only pre-empts the browser menu
    // when it actually hits a gutter, so a right-click inside the plot behaves normally.
    this.onCtx = (e: MouseEvent) => {
      if (!this.onAxisToggle) return;
      const r = this.u.over.getBoundingClientRect();
      if (e.clientX < r.left) {
        e.preventDefault();
        this.onAxisToggle('y');
      } else if (e.clientY > r.bottom) {
        e.preventDefault();
        this.onAxisToggle('x');
      }
    };
    el.addEventListener('contextmenu', this.onCtx);
    this.ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      // skip 0-size (hidden tab / pre-layout) — uPlot.setSize(0,0) breaks its canvas.
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
    const sameColors =
      next.length === this.colors.length && next.every((c, i) => c === this.colors[i]);
    const sameDash = sameDashes(nextDash, this.dashes);
    const eff = effLog(data);
    const sameScale = eff.x === this.xLog && eff.y === this.yLog;
    this.colors = next;
    this.dashes = nextDash;
    this.xLog = eff.x;
    this.yLog = eff.y;
    this.lastData = data;
    if (sameColors && sameDash && sameScale && this.u.series.length - 1 === data.lines.length) {
      this.u.setData(aligned(data)); // resetScales: true — refit to the new quantity's range
    } else {
      this.u.destroy();
      this.u = this.build(data);
    }
    // Only report when the effective scale moved — the flags rarely change, but setData runs on
    // every bias-drag frame, and a fresh object would re-trigger the UI's tag/tooltip each time.
    if (!sameScale) this.emitScale();
  }

  /** Rebuild from the retained data to pick up a theme/colour or tick-font change. uPlot fixes
   *  axis font + stroke at construction (like series colour/dash), so a restyle needs a rebuild. */
  restyle(): void {
    this.u.destroy();
    this.u = this.build(this.lastData);
    this.emitScale();
  }

  /** Surface the effective (post-downgrade) log flags to the UI. */
  private emitScale(): void {
    this.onScale?.({ x: this.xLog, y: this.yLog });
  }

  destroy(): void {
    this.el.removeEventListener('contextmenu', this.onCtx);
    this.ro.disconnect();
    this.u.destroy();
  }

  private build(data: ChartData): uPlot {
    // uPlot paints axis labels/ticks/grid on the canvas with its own (light-theme)
    // defaults, ignoring `color-scheme`. Resolve the container's current text colour
    // so the chart tracks light/dark like the rest of the UI. (Re-read on rebuild.)
    const cs = getComputedStyle(this.el);
    const fg = cs.color || '#888';
    const faint = fg.startsWith('rgb(') ? fg.replace('rgb(', 'rgba(').replace(')', ', 0.15)') : fg;
    const axis = { stroke: fg, grid: { stroke: faint }, ticks: { stroke: faint } };
    // Tick-label font from the user setting (`--font-axis-label`, set on :root and inherited
    // here); numeric fallback so a missing var can't NaN the size. The x-axis gutter is then
    // sized to hug the ticks — uPlot's default reserves ~50px, far more than SI ticks need,
    // which is the empty band that read as a gap under the DOM axis title.
    const labelPx = parseFloat(cs.getPropertyValue('--font-axis-label')) || 12;
    const tickFont = `${labelPx}px system-ui, sans-serif`;
    // SI-suffix ticks (200G, 8M, 25m…) — quantities span many decades, so raw integers
    // overflow the gutter. Axis *labels* are rendered as DOM by the Panel (so they can
    // carry subscripts), not drawn here on the canvas.
    // uPlot's log axis nulls out minor-tick labels (the 2×/5× between decades) to leave them as
    // unlabelled gridlines; those null splits must map back to null, not the string "null".
    const fmtTicks = (_u: uPlot, splits: number[]) =>
      splits.map((v) => (Number.isFinite(v) ? formatSI(v, 3) : null));
    const opts: Options = {
      width: this.el.clientWidth || 800,
      height: this.el.clientHeight || 360,
      // distr 3 = log10, 1 = linear. effLog downgrades a requested log axis to linear when the
      // data isn't strictly positive, so uPlot never sees a non-positive log range.
      scales: {
        x: { time: false, distr: this.xLog ? 3 : 1 },
        y: { distr: this.yLog ? 3 : 1 },
      },
      legend: { show: false }, // we own the readout/color-key in the app footer
      cursor: { focus: { prox: 24 } },
      // On log axes we supply our own decade splits: uPlot's built-in log-tick generator
      // infinite-loops on very small magnitudes (noise PSDs ~1e-24), throwing "Invalid array
      // length". Ours is bounded and correct across the full magnitude range.
      axes: [
        {
          values: fmtTicks,
          ...(this.xLog ? { splits: logSplits } : {}),
          font: tickFont,
          size: Math.round(labelPx + 16),
          ...axis,
        },
        { values: fmtTicks, ...(this.yLog ? { splits: logSplits } : {}), font: tickFont, ...axis },
      ],
      series: [
        {},
        ...data.lineLabels.map((label, i): Series => ({
          label,
          stroke: this.colorAt(i),
          dash: this.dashAt(i),
          width: 1.5,
          points: { show: false },
        })),
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

/** A series is log-safe when it has at least one sample and every non-gap sample is finite and
 *  strictly positive. null/NaN are gaps (ignored); ±Infinity or a value ≤ 0 disqualifies it. */
function logSafe(vals: ArrayLike<number | null>): boolean {
  let pos = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null || Number.isNaN(v)) continue;
    if (!Number.isFinite(v) || v <= 0) return false;
    pos = true;
  }
  return pos;
}

/** Effective log flags: a requested log axis is honoured only if its data is log-safe (strictly
 *  positive), so uPlot never gets a non-positive log range. Tiny positive magnitudes are handled
 *  by logSplits below, not by falling back to linear. */
function effLog(data: ChartData): { x: boolean; y: boolean } {
  return {
    x: !!data.xLog && logSafe(data.x),
    y: !!data.yLog && data.lines.every(logSafe),
  };
}

/** Decade tick splits for a log axis (1×10^e, plus 2× and 5× when the span is ≤ 3 decades).
 *  Replaces uPlot's built-in generator, which infinite-loops on very small magnitudes; the
 *  count is hard-capped so no range can ever explode. uPlot clips ticks outside [min,max]. */
function logSplits(_u: uPlot, _axisIdx: number, scaleMin: number, scaleMax: number): number[] {
  if (!(scaleMin > 0) || !(scaleMax > 0)) return [scaleMin];
  const e0 = Math.floor(Math.log10(scaleMin));
  const e1 = Math.ceil(Math.log10(scaleMax));
  const mant = e1 - e0 <= 3 ? [1, 2, 5] : [1];
  const out: number[] = [];
  for (let e = e0; e <= e1 && out.length < 200; e++) for (const m of mant) out.push(m * 10 ** e);
  return out;
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
