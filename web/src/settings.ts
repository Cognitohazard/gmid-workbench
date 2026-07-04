// User appearance settings: theme, a UI-zoom (root size, scales the whole interface via rem), a
// content text-scale (multiplies panel text only, independent of the zoom), and two axis-font
// sizes for the chart. Persisted to localStorage and applied as `color-scheme` + CSS custom
// properties on the document root — the whole UI and the canvas chart follow, since both read
// system colours and these vars. Web-only; the pure core is unaware of any of this.

import { loadJSON, saveJSON } from './storage';

export type Theme = 'auto' | 'light' | 'dark';

export interface Settings {
  theme: Theme;
  fontUi: number; // px — root size; the UI-zoom knob (scales all rem: layout, controls, charts)
  textScale: number; // unitless — extra multiplier on panel text only, independent of the zoom
  fontAxisTitle: number; // px — DOM axis titles (.xlabel/.ylabel, colorbar label)
  fontAxisLabel: number; // px — uPlot tick labels (drawn on the canvas)
}

export const DEFAULTS: Settings = {
  theme: 'auto',
  fontUi: 16,
  textScale: 1,
  fontAxisTitle: 14,
  fontAxisLabel: 13,
};

/** Per-field font clamp [min, max] in px — bounds both a stored value and the UI sliders. */
export const FONT_RANGE = { min: 9, max: 24 } as const;
/** Text-scale clamp [min, max] as a unitless multiplier — bounds the value and the slider. */
export const TEXT_SCALE_RANGE = { min: 0.8, max: 1.6 } as const;

const KEY = 'gmid.settings';

// Clamp an untrusted value into [min, max], falling back on non-numbers; `round` snaps to an
// integer (px fonts) while the text-scale multiplier keeps its fractional step.
const clampTo = (
  v: unknown,
  { min, max }: { min: number; max: number },
  fallback: number,
  round = false,
): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, round ? Math.round(v) : v))
    : fallback;

const clampFont = (v: unknown, fallback: number): number => clampTo(v, FONT_RANGE, fallback, true);
const clampScale = (v: unknown, fallback: number): number => clampTo(v, TEXT_SCALE_RANGE, fallback);

/** Coerce an untrusted parsed object into valid Settings (each field falls back to its default). */
export function sanitizeSettings(v: unknown): Settings {
  if (!v || typeof v !== 'object') return { ...DEFAULTS };
  const o = v as Record<string, unknown>;
  const theme: Theme = o.theme === 'light' || o.theme === 'dark' ? o.theme : 'auto';
  return {
    theme,
    fontUi: clampFont(o.fontUi, DEFAULTS.fontUi),
    textScale: clampScale(o.textScale, DEFAULTS.textScale),
    fontAxisTitle: clampFont(o.fontAxisTitle, DEFAULTS.fontAxisTitle),
    fontAxisLabel: clampFont(o.fontAxisLabel, DEFAULTS.fontAxisLabel),
  };
}

/** Load saved settings, or the defaults (corrupt/unavailable storage ⇒ defaults). */
export function loadSettings(): Settings {
  return loadJSON(KEY, sanitizeSettings, () => ({ ...DEFAULTS }));
}

/** Persist settings (best-effort; a write failure is non-fatal). */
export function saveSettings(s: Settings): void {
  saveJSON(KEY, s);
}

/** Apply settings to the document root: `color-scheme` (theme), the UI-zoom root size, the
 *  content text-scale multiplier, and the two axis-font CSS vars. */
export function applySettings(s: Settings): void {
  const r = document.documentElement;
  r.style.colorScheme = s.theme === 'auto' ? 'light dark' : s.theme;
  r.style.setProperty('--font-ui', `${s.fontUi}px`);
  r.style.setProperty('--text-scale', `${s.textScale}`);
  r.style.setProperty('--font-axis-title', `${s.fontAxisTitle}px`);
  r.style.setProperty('--font-axis-label', `${s.fontAxisLabel}px`);
}
