// The engine's tolerances and caps, as one value a caller hands to every evaluation. Nothing in
// the engine reads a mutable global: an evaluation that is not given settings uses
// DEFAULT_SETTINGS, and every golden is pinned at those defaults. A caller that changes one (the
// app's settings view) passes the whole object down each public entry — evaluateSheet, runSheet,
// the sweeps, the sensitivity readout, the condition runs — and nothing else changes.
//
// Pure; no imports, so the engine modules that read a field can all import it.

/**
 * How closely the engine solves, how long it may search, and where its checks draw their lines.
 * Each field's default is the value the engine used before it was adjustable; the reason for that
 * value is given with the field.
 */
export interface Settings {
  /**
   * How close a solved param must be to its root, relative to the param's STATED range — not to
   * its value, which never closes a relative test when the root sits at 0. 1e-6 resolves a
   * volt-scale node to a microvolt. It is one tolerance, in the param's own terms, everywhere it
   * is used: the search's bracket closes to it, and "the relation reads within tolerance" means
   * the relation reads no more than its local slope times it — the param is within this fraction
   * of the span of its root. Measuring in the param's terms rather than the relation's is what
   * keeps a steep relation honest: an exponential reads a large number a hair off its root, and a
   * small one on a flat stretch far from it. The search's interpolation steps converge faster
   * than halving near the root, so these last digits cost a probe or two, not one probe each.
   */
  readonly solveTolRel: number;
  /**
   * How many sweeps a set of solved params that depend on each other gets. One sweep searches
   * each member in turn, with the others at their current values; the set has settled when every
   * member's relation, read from the sweep's last evaluation, is within its tolerance. The
   * library's dependent pairs — a tail node and the split of the pair standing on it, in the 5T
   * and the two-stage Miller OTA — settle in one sweep at the design point and in two or three
   * where the hardware is held: each relation reads the other unknown only through a weak
   * second-order effect, so every sweep shrinks what is left by orders of magnitude. The most any
   * library case needs is four: the 5T on sky130's low-threshold device, held at 125 C and asked
   * at the top of its common-mode range. Six leaves that case a margin without changing what the
   * number means.
   *
   * It is a CAP stated before the solve starts, never "until it converges", because that is the
   * line the scope rule draws: a set still moving after this many sweeps depends on itself
   * strongly enough that repeating searches until something gives would be iterating a coupled
   * system to convergence, and the engine reports it instead. SETTINGS_LIMITS keeps it small.
   */
  readonly solveSweeps: number;
  /**
   * The evaluations one composed tree may spend, counted per evaluation of any document in it — a
   * probe of a three-child sheet costs four, less any child whose inputs the probe did not move,
   * which is read back from earlier in the tree and costs none. A search costs a few tens of
   * evaluations, a set that depends on each other a few searches per sweep, and a child solves
   * inside every evaluation of its parent, so nesting multiplies: the ceiling is there so a deep
   * tree of solved params stops with a reason instead of running for minutes. The library's
   * costliest tree (the folded-cascode OTA, at the sky130 process conditions) spends about 1,500.
   */
  readonly solveEvaluations: number;
  /**
   * How many times a search halves its way in from an end of the stated range where the relation
   * does not evaluate — a device with no headroom there, a lookup out of range, a refused device —
   * toward a point where it does. Such an end says the circuit has no operating point there, not
   * that the search failed, so the search moves to the nearest point that evaluates and searches
   * what is left. Eight halvings place that point within 1/256 of the range of the edge — a few
   * millivolts on a volt-scale node, finer than any author states a range to — for at most eight
   * evaluations per end.
   */
  readonly inwardSteps: number;
  /**
   * How large a wire's current residual may be, as a fraction of the largest current meeting
   * there, before the wiring check raises it as a warning. Below about 0.1 % the sizer cannot tell
   * two currents apart — it interpolates between table nodes to roughly that resolution — so a
   * smaller residual says nothing a table can resolve. Every residual is reported in the check's
   * data whatever its size; this decides only which ones are raised.
   */
  readonly kclTolRel: number;
  /**
   * How far apart two statements of one voltage may be before they disagree [V]: 10 mV, absolute
   * and in the voltage domain. It is the resolution bias plans are written to, and an order of
   * magnitude below the disagreements a wiring check exists to catch — two gates sized hundreds of
   * millivolts apart on one wire. One tolerance, read by the loop residuals and by the rule that
   * decides whether several placements share one operating point.
   */
  readonly closureTol: number;
  /** A check passing by a smaller relative margin than this reads as a near miss (amber): 5 % of
   *  its bound. */
  readonly nearMiss: number;
}

/** The settings every evaluation uses unless it is handed others — the values each golden is
 *  pinned at. Frozen: a caller that wants other settings builds its own object. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  solveTolRel: 1e-6,
  solveSweeps: 6,
  solveEvaluations: 10000,
  inwardSteps: 8,
  kclTolRel: 1e-3,
  closureTol: 0.01,
  nearMiss: 0.05,
});

/** The fields of Settings, in the order a settings view lists them. */
export const SETTING_KEYS: readonly (keyof Settings)[] = Object.freeze([
  'solveTolRel',
  'solveSweeps',
  'solveEvaluations',
  'inwardSteps',
  'kclTolRel',
  'closureTol',
  'nearMiss',
]);

/**
 * The values each setting may take: `integer` ones are counts. The bounds keep every value one
 * the engine can run with — a positive tolerance, at least one sweep and one evaluation — and keep
 * the sweep cap small, so raising it can never turn the bounded repetition into iterating a
 * coupled set until it gives (see Settings.solveSweeps).
 */
export const SETTINGS_LIMITS: Readonly<
  Record<keyof Settings, { readonly min: number; readonly max: number; readonly integer: boolean }>
> = Object.freeze({
  solveTolRel: { min: 1e-12, max: 1e-2, integer: false },
  solveSweeps: { min: 1, max: 20, integer: true },
  solveEvaluations: { min: 100, max: 1_000_000, integer: true },
  inwardSteps: { min: 0, max: 30, integer: true },
  kclTolRel: { min: 0, max: 1, integer: false },
  closureTol: { min: 0, max: 1, integer: false },
  nearMiss: { min: 0, max: 1, integer: false },
});

/** One setting held to its limits: a non-number reads the default, a number outside the limits
 *  is clamped to the nearer one, and a count is rounded. */
export function settingValue(key: keyof Settings, v: unknown): number {
  const { min, max, integer } = SETTINGS_LIMITS[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS[key];
  const n = integer ? Math.round(v) : v;
  return Math.min(max, Math.max(min, n));
}

/**
 * Settings from anything — a partial object, a stored value read back, nothing at all: every
 * field held to its limits (settingValue), and every missing or unusable one at its default. The
 * engine reads its settings through this once per evaluation, so a caller handing it a value out
 * of range gets the nearest one it can run with rather than a solve that cannot start.
 */
export function settingsFrom(raw: unknown): Settings {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<keyof Settings, number>;
  for (const k of SETTING_KEYS) out[k] = settingValue(k, o[k]);
  return out;
}

/** The fields of `s` that differ from their defaults, in SETTING_KEYS order. */
export function changedSettings(s: Settings): (keyof Settings)[] {
  return SETTING_KEYS.filter((k) => !Object.is(s[k], DEFAULT_SETTINGS[k]));
}
