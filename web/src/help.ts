// Plain-language help text for the UI: what a quantity is and why it matters, and what each
// control does. Presentation only — it lives in the web layer (not the pure core) and is keyed
// by the same canonical quantity keys as labels.ts / namespace.ts. Surfaced via <Help> (a small
// "?" with a native title tooltip), so any key missing here simply shows no icon.

/** Design + measured quantities, keyed by canonical quantity key. */
export const QUANTITY_HELP: Readonly<Record<string, string>> = {
  // the gm/ID design axis and its first-order trade-offs
  gm_id: 'Transconductance efficiency gm/I_D (1/V) — the gm/ID design axis. High = weak inversion (efficient, low overdrive); low = strong inversion (fast).',
  id_w: 'Current density I_D/W (A/m). Read width for a target current at a chosen gm/ID.',
  ft: 'Transit frequency f_T = gm/(2π·C_gg) (Hz) — intrinsic speed. Falls as you trade for efficiency.',
  gm_gds: 'Intrinsic gain gm/g_ds (V/V) — self-gain of one transistor. Rises with channel length.',
  av0: 'Intrinsic gain A_v0 = gm/g_ds (V/V) — same as gm/g_ds.',
  ro: 'Output resistance r_o = 1/g_ds (Ω).',
  vstar: 'V* = 2·I_D/gm = 2/(gm/ID) (V) — an overdrive-like efficiency metric. Small V* = efficient.',
  ft_eff: '(gm/ID)·f_T (Hz/V) — a combined efficiency-and-speed figure of merit.',
  av0_ft: 'Gain·f_T (Hz) — a combined gain-and-bandwidth figure of merit.',
  gm_cgd: 'gm/C_gd (rad/s).',
  cgd_cgg: 'C_gd/C_gg — the feedback-capacitance fraction.',
  gmb_gm: 'Body-effect ratio g_mb/gm.',
  // input-referred noise (measured from stored PSDs, and the γ-model estimate)
  vnth: 'Input-referred thermal-noise density √S_id/gm (V/√Hz), from the stored drain-noise PSD (measured).',
  vnth_m: 'Input-referred thermal-noise density (γ-model): √(4kTγ/gm) (V/√Hz). Always available; falls as 1/√gm.',
  vnfl: 'Input-referred 1/f (flicker) noise density at 1 Hz (V/√Hz), from the stored flicker PSD (measured).',
  svth: 'Input-referred thermal-noise PSD S_id/gm² (V²/Hz), measured.',
  svth_m: 'Input-referred thermal-noise PSD (γ-model) 4kTγ/gm (V²/Hz).',
  svfl: 'Input-referred 1/f noise PSD at 1 Hz (V²/Hz), measured.',
  // base quantities
  vgs: 'Gate-source voltage (V) — the usual sweep axis.',
  vds: 'Drain-source voltage (V).',
  vsb: 'Source-body voltage (V); vsb = -vbs.',
  id: 'Drain current (A).',
  gm: 'Transconductance ∂I_D/∂V_GS (S).',
  gds: 'Output conductance ∂I_D/∂V_DS (S).',
  gmb: 'Body transconductance ∂I_D/∂V_BS (S).',
  vth: 'Threshold voltage (V).',
  vdsat: 'Saturation voltage (V).',
  l: 'Channel length (m) — the usual family axis. Longer L = more gain, less speed.',
  w: 'Channel width (m).',
  cgg: 'Total gate capacitance (F).',
};

/** Controls and workflow concepts, keyed by an arbitrary control id. */
export const CONTROL_HELP: Readonly<Record<string, string>> = {
  sweep: 'The bias axis every curve runs along; the panel X is computed from it. gm/ID work sweeps V_GS.',
  family: 'The axis fanned into one curve per value (e.g. L). (none) draws a single curve.',
  bias: 'Operating-point value for an axis no visible panel fans. Shared across the dashboard.',
  overlay: 'Draw this device on every panel alongside the active one (dashed) — compare corners, or NMOS vs PMOS, on shared gm/ID axes.',
  active: 'Make this the active device: it drives the dashboard, the pickers, the bias sliders, and the sizer.',
  template: 'Add a panel pre-set to a canonical plot — no expression typing.',
  sheet: 'Add a design sheet: variables, author equations, and pass/fail constraints with margins, sized on the active device.',
  sheetSweep: 'Sweep one variable across its range and chart every rule’s margin — the feasibility region where the design closes.',
  custom: 'Type any expression over the device quantities and constants (e.g. gm/(2*pi*cgg)).',
  size: 'Sizing: bind any two of {gm/ID, I_D, gm} at a chosen L → width, V_GS, f_T, gain, and feasibility.',
  bind: 'Enter exactly two of gm/ID, I_D, gm; the third and the geometry are solved at this L.',
  noise: 'Input-referred noise at the sized gm: thermal density (γ-model) and the total RMS over the band.',
  fco: 'Flicker (1/f) noise corner frequency f_co (Hz).',
  band: 'Integration band [f_lo, f_hi] (Hz) for the total RMS input-referred noise.',
  matching: 'Pelgrom mismatch budget on the sized geometry: σ(V_th), pair offset, and σ(I)/I.',
  avth: 'Pelgrom V_th matching coefficient A_Vth (mV·µm): σ(V_th) ≈ A_Vth/√(W·L).',
  abeta: 'Pelgrom current-factor matching coefficient A_β (%·µm).',
};
