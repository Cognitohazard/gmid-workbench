// The solver's tolerances and caps as this bench sets them: the core's Settings, kept in $state
// so every sheet panel and the picker re-evaluate when one changes, and persisted locally so a
// reload keeps them. Only values that differ from the defaults are retained — a bench at its
// defaults stores nothing — and every retained value is shown on the settings page, where it can
// be reset alone or with the rest; clearing the bench clears them too. Nothing leaves the machine.

import {
  DEFAULT_SETTINGS,
  changedSettings,
  settingValue,
  settingsFrom,
  type Settings,
} from '@gmid/mostab-core';
import { SOLVER_HELP } from './help';
import { loadJSON, removeJSON, saveJSON } from './storage';

export const SOLVER_KEY = 'gmid.solver';

const store = $state<{ settings: Settings }>({
  settings: loadJSON(SOLVER_KEY, settingsFrom, () => ({ ...DEFAULT_SETTINGS })),
});

/** Write what differs from the defaults, or remove the key when nothing does. */
function persist(): void {
  const changed = changedSettings(store.settings);
  if (!changed.length) removeJSON(SOLVER_KEY);
  else saveJSON(SOLVER_KEY, Object.fromEntries(changed.map((k) => [k, store.settings[k]])));
}

/** The settings every evaluation on this bench runs under. A plain copy, so it can cross to the
 *  evaluation worker inside a job. */
export function solverSettings(): Settings {
  return { ...store.settings };
}

/** The settings that differ from their defaults, in display order. */
export function changedSolverSettings(): (keyof Settings)[] {
  return changedSettings(store.settings);
}

/** Set one setting, held to its limits (settingValue). */
export function setSolverSetting(key: keyof Settings, value: number): void {
  store.settings = { ...store.settings, [key]: settingValue(key, value) };
  persist();
}

/** Put one setting back to its default. */
export function resetSolverSetting(key: keyof Settings): void {
  setSolverSetting(key, DEFAULT_SETTINGS[key]);
}

/** Put every setting back to its default, and retain nothing. */
export function resetSolverSettings(): void {
  store.settings = { ...DEFAULT_SETTINGS };
  removeJSON(SOLVER_KEY);
}

/** A setting's value as the settings page and the panel marker show it: a plain number (a
 *  tolerance reads `0.000001`, not an SI prefix on a fraction), with its unit where it has one. */
export function settingText(key: keyof Settings, v: number): string {
  const unit = SOLVER_HELP[key].unit;
  return `${String(Number(v.toPrecision(6)))}${unit ? ` ${unit}` : ''}`;
}
