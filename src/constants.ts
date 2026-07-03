// Physical constants and the default expression-engine constant scope.

export const PHYS = {
  pi: Math.PI,
  k: 1.380649e-23, // Boltzmann constant [J/K]
  q: 1.602176634e-19, // elementary charge [C]
  T: 300.15, // 27 °C in kelvin (methodology default temperature)
  eps: 8.8541878128e-12, // vacuum permittivity [F/m]
} as const;

/** Thermal voltage U_T = kT/q at the default temperature (~25.85 mV). */
export const UT: number = (PHYS.k * PHYS.T) / PHYS.q;

/**
 * Default channel thermal-noise factor γ (Sid = 4kTγ·gm). 2/3 is the long-channel
 * saturation value; short devices run higher. It is only a default: a table that
 * carries a per-point `gamma` LUT column shadows this (stored data wins in
 * tableScope), so noise tracks the real bias-dependent γ when the sim provides it.
 */
export const GAMMA_DEFAULT = 2 / 3;

/** Named constants available to every expression (pi, k, q, T, eps, UT, gamma). */
export const CONSTANTS: Readonly<Record<string, number>> = {
  ...PHYS,
  UT,
  gamma: GAMMA_DEFAULT,
};

/** Absolute temperature [K] for a table temperature in °C. */
export const kelvin = (tempC: number): number => tempC + 273.15;

/**
 * Temperature-dependent constant overrides {T, UT} for a table characterized at
 * `tempC` [°C], for seeding an evaluation scope. A scope binding shadows the
 * engine's constant map, so expressions like the γ-model noise (4·k·T·γ/gm)
 * evaluate at the table's own temperature instead of the 27 °C default. Returns
 * {} when `tempC` is absent/non-finite, leaving the defaults untouched.
 */
export function thermalScalars(tempC: number | undefined): Record<string, number> {
  if (tempC === undefined || !Number.isFinite(tempC)) return {};
  const T = kelvin(tempC);
  return { T, UT: (PHYS.k * T) / PHYS.q };
}
