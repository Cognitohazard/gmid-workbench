// User appearance settings: theme + three independent font sizes. Persisted to localStorage
// and applied as `color-scheme` + CSS custom properties on the document root — the whole UI
// and the canvas chart follow, since both read system colours and these vars. Web-only; the
// pure core is unaware of any of this.

import { loadJSON, saveJSON } from './storage';

export type Theme = 'auto' | 'light' | 'dark';

export interface Settings {
  theme: Theme;
  fontUi: number; // px — root/UI text
  fontAxisTitle: number; // px — DOM axis titles (.xlabel/.ylabel, colorbar label)
  fontAxisLabel: number; // px — uPlot tick labels (drawn on the canvas)
}

export const DEFAULTS: Settings = {
  theme: 'auto',
  fontUi: 15,
  fontAxisTitle: 14,
  fontAxisLabel: 13,
};

/** Per-field font clamp [min, max] in px — bounds both a stored value and the UI sliders. */
export const FONT_RANGE = { min: 9, max: 24 } as const;

const KEY = 'gmid.settings';

const clampFont = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(FONT_RANGE.max, Math.max(FONT_RANGE.min, Math.round(v)))
    : fallback;

/** Coerce an untrusted parsed object into valid Settings (each field falls back to its default). */
export function sanitizeSettings(v: unknown): Settings {
  if (!v || typeof v !== 'object') return { ...DEFAULTS };
  const o = v as Record<string, unknown>;
  const theme: Theme = o.theme === 'light' || o.theme === 'dark' ? o.theme : 'auto';
  return {
    theme,
    fontUi: clampFont(o.fontUi, DEFAULTS.fontUi),
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

/** Apply settings to the document root: `color-scheme` (theme) + the three font CSS vars. */
export function applySettings(s: Settings): void {
  const r = document.documentElement;
  r.style.colorScheme = s.theme === 'auto' ? 'light dark' : s.theme;
  r.style.setProperty('--font-ui', `${s.fontUi}px`);
  r.style.setProperty('--font-axis-title', `${s.fontAxisTitle}px`);
  r.style.setProperty('--font-axis-label', `${s.fontAxisLabel}px`);
}
