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

/** Named constants available to every expression (pi, k, q, T, eps, UT). */
export const CONSTANTS: Readonly<Record<string, number>> = {
  ...PHYS,
  UT,
};
