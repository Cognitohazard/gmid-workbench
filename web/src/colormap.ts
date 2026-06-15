// Sequential, perceptually-ordered colormap for swept families (many curves colored by a
// continuous family value). Viridis, sampled at 10 evenly-spaced stops and linearly
// interpolated — perceptually ordered (so adjacent curves stay distinguishable) and
// readable on both light and dark backgrounds (dark-purple → teal → yellow). Pure, DOM-free.
const STOPS: readonly (readonly [number, number, number])[] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [110, 206, 88],
  [181, 222, 43],
  [253, 231, 37],
];

/** Viridis colour at t ∈ [0, 1] (clamped), as an "rgb(r, g, b)" string. */
export function viridis(t: number): string {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const f = c * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(f));
  const u = f - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  const m = (j: number) => Math.round(a[j] + (b[j] - a[j]) * u);
  return `rgb(${m(0)}, ${m(1)}, ${m(2)})`;
}

/** A CSS linear-gradient (bottom→top) sampling the colormap — for the colorbar strip. */
export function viridisGradient(stops = 12): string {
  const parts = Array.from(
    { length: stops },
    (_, i) => `${viridis(i / (stops - 1))} ${((i / (stops - 1)) * 100).toFixed(0)}%`,
  );
  return `linear-gradient(to top, ${parts.join(', ')})`;
}

/** Above this many family curves, the discrete palette + per-curve legend stops scaling. */
export const LARGE_FAMILY = 8;
