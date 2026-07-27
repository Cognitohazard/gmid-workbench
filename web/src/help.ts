// Plain-language help text for the UI: what a quantity is and why it matters, and what each
// control does. Presentation only — it lives in the web layer (not the pure core) and is keyed
// by the same canonical quantity keys as labels.ts / namespace.ts. Surfaced via <Help> (a small
// "?" with a native title tooltip), so any key missing here simply shows no icon.

/** Design + measured quantities, keyed by canonical quantity key. */
export const QUANTITY_HELP: Readonly<Record<string, string>> = {
  // the gm/ID design axis and its first-order trade-offs
  gm_id:
    'Transconductance efficiency gm/I_D (1/V) — the gm/ID design axis. High = weak inversion (efficient, low overdrive); low = strong inversion (fast).',
  id_w: 'Current density I_D/W (A/m). Read width for a target current at a chosen gm/ID.',
  ft: 'Transit frequency f_T = gm/(2π·C_gg) (Hz) — intrinsic speed. Falls as you trade for efficiency.',
  gm_gds: 'Intrinsic gain gm/g_ds (V/V) — self-gain of one transistor. Rises with channel length.',
  av0: 'Intrinsic gain A_v0 = gm/g_ds (V/V) — same as gm/g_ds.',
  ro: 'Output resistance r_o = 1/g_ds (Ω).',
  vstar:
    'V* = 2·I_D/gm = 2/(gm/ID) (V) — an overdrive-like efficiency metric. Small V* = efficient. L-independent, so family curves coincide — one visible curve is correct, not a plot fault.',
  ft_eff: '(gm/ID)·f_T (Hz/V) — a combined efficiency-and-speed figure of merit.',
  av0_ft: 'Gain·f_T (Hz) — a combined gain-and-bandwidth figure of merit.',
  gm_cgd: 'gm/C_gd (rad/s).',
  cgd_cgg: 'C_gd/C_gg — the feedback-capacitance fraction.',
  gmb_gm: 'Body-effect ratio g_mb/gm.',
  // input-referred noise (measured from stored PSDs, and the γ-model estimate)
  vnth: 'Input-referred thermal-noise density √S_id/gm (V/√Hz), from the stored drain-noise PSD (measured).',
  vnth_m:
    'Input-referred thermal-noise density (γ-model): √(4kTγ/gm) (V/√Hz). Always available; falls as 1/√gm.',
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
  sweep:
    'The bias axis every curve runs along; the panel X is computed from it. gm/ID work sweeps V_GS.',
  family: 'The axis fanned into one curve per value (e.g. L). (none) draws a single curve.',
  bias: 'Operating-point value for an axis no visible panel fans. Shared across the dashboard.',
  overlay:
    'Draw this device on every panel alongside the active one (dashed) — compare corners, or NMOS vs PMOS, on shared gm/ID axes.',
  active:
    'Make this the active device: it drives the dashboard, the pickers, the bias sliders, and the sizer.',
  template: 'Add a panel pre-set to a canonical plot — no expression typing.',
  sheet:
    'Load a design sheet — a small example or a curated library topology — with variables, author equations, and pass/fail constraints with margins, sized on the active device.',
  feasBadge:
    'Does the design close on the active device at the current variables? Feasible = every hard rule (invariant + requirement) passes; guardrails are advisory and never gate it. When it does not close, the badge names the binding constraint: the failing hard rule with the worst margin, anywhere in the composition (a child’s rule is shown by path).',
  sheetSweep:
    'Sweep one variable across its range and chart every rule’s margin — the feasibility region where the design closes.',
  sheetSweep2:
    'Add a second variable to sweep the design plane: a feasibility heatmap (green = the design closes, red = a hard rule fails) instead of the 1-D margin chart.',
  useDevice:
    'Size this child block against a specific loaded device — load the other table first (devices accumulate in the bar below the toolbar), then pick it here (e.g. the PMOS table for a mirror load); “active device” inherits the parent’s.',
  // design-sheet vocabulary (rule kinds, statuses, composition, bias, param roles)
  ruleKind:
    'invariant = a hard physical floor; requirement = a hard application spec — both must hold for a feasible design. guardrail = advisory only: shown, never blocks.',
  amber:
    'The rule holds but by under 5% margin — a near-miss worth a look. A spec pinned by its own bind snaps to amber instead of coin-flipping pass/fail on rounding.',
  ruleNa:
    'na = a side could not be computed (an undeclared name or a non-finite value). Never a silent pass: a hard rule reading na fails the design closed.',
  provide:
    'Names this block exposes to a parent sheet. The parent reads each as child__name and writes its own math over it — scalar composition, no circuit solving.',
  copyResults:
    'Copy every computed value of this sheet (and its children, child__-prefixed) as name/value text — the numbers, where the ⤓ json export is the recipe.',
  refBlock:
    'This block is included by reference from the sheet library — its internals live on the referenced sheet and track its edits (unless the document also embeds a pinned copy, which then wins). Param overrides still apply; detach to make a local editable copy.',
  detachRef:
    'Replace the reference with an embedded copy of the resolved sheet. Locally editable from then on, but edits to the library sheet no longer flow in.',
  exportSheet:
    'Download this sheet as JSON, exactly as authored — references stay references (share it alongside the sheets it refers to).',
  exportFlat:
    'Download a flattened copy: every referenced block inlined. Self-contained and frozen — later edits to the library sheets it referenced no longer change it.',
  userSheets:
    'Sheets you imported (.json). They join the picker and the reference library: a sheet can name one as user/<name> (or its bare name) in a `ref`. Kept across reloads.',
  bindBias:
    'The operating point (vds/vsb, signed) this block is sized at. gds shifts ~4–5× across vds, so each device pins its own; body bias (vsb) defaults to 0. Edit to override; clear to revert.',
  bindAssumed:
    'A coordinate marked ? was not declared by this block — the engine filled it in. That is right for a common-source device or a rail-referenced mirror, and wrong for a differential pair, cascode or source follower, where the source floats above the bulk. Declare vsb in the bind if this device is one of those.',
  bindNeeds:
    'This block must pin its drain bias (vds) but hasn’t — the table has a vds axis and there is no safe default, so sizing fails closed. Set a value here to size it in place.',
  solvedParam:
    'Solved, not set. This estimate stands in for a value only the evaluated sheet knows, closing a bias loop the block order cannot express: it is iterated until the two agree. The stored number is just a starting guess, so the field is read-only and the parameter cannot be swept.',
  pinnedParam:
    'Solved, not set. This is an internal bias node the engine chooses so a sheet output equals a spec you typed (e.g. the tail node placed so the common mode lands exactly on CM_dc). Solved by bisection between the parameter\u2019s min and max — its bracket, not slider bounds. Sweep the spec on the other side of the pin instead; the shown value is where the node landed.',
  pinNotLanded:
    'This pin did not land, so there is no solved value to show. The engine found no point in the parameter’s [min, max] bracket where the pinned equation holds — the warnings below name which way it failed (the bracket does not straddle the target, or the design stopped evaluating inside it). Move or widen the bracket, or relax the spec the pin chases.',
  edges:
    'Containment edges: the sheet re-evaluates in full at each claimed range end (e.g. CM_dc = CM_lo, then CM_hi) — its own bias solve, its own devices — and every hard rule must hold there, so the claimed range is proven at its ENDPOINTS on every evaluation, not estimated. A red chip names what failed at that edge; the shown values are where the solved bias landed. The sweep remains the authority on the full interior landscape.',
  paramRole:
    'spec = the requirement (supply, load, targets) an adopter retargets freely; choice = the author’s knobs (gm/ID, L, bias current) tuned to meet it.',
  custom: 'Type any expression over the device quantities and constants (e.g. gm/(2*pi*cgg)).',
  size: 'Sizing: bind an operating point (gm/ID, f_T, or gm/g_ds) and a size (I_D, gm, or W) at a chosen L → width, V_GS, the remaining figures of merit, and feasibility.',
  bind: 'Enter exactly two of gm/ID, f_T, gm/g_ds, I_D, gm, W; everything else — including the geometry — is solved at this L.',
  bindPoint:
    'Where on the curve the device sits. Each of these is width-independent, so any ONE of them pins the operating point (and the other two follow) without saying how big the device is. Enter the spec you actually have: f_T for a speed target, gm/g_ds for a gain target, gm/ID to work the efficiency axis directly. If the target is out of reach at this L, the lengths that do reach it are listed.',
  bindSize:
    'How big the device is. Pick ONE to scale the operating point above into a real device — or two of these on their own, which pins the operating point between them (gm and I_D fix gm/ID; W with either fixes a current or transconductance density).',
  noise:
    'Input-referred noise at the sized gm: thermal density (γ-model) and the total RMS over the band.',
  fco: 'Flicker (1/f) noise corner frequency f_co (Hz).',
  band: 'Integration band [f_lo, f_hi] (Hz) for the total RMS input-referred noise.',
  matching: 'Pelgrom mismatch budget on the sized geometry: σ(V_th), pair offset, and σ(I)/I.',
  fingers:
    'The table is characterized at ONE width; sizing scales it per-µm, and width effects (model bins, narrow-width V_th shifts) are NOT captured — a single wide finger can be off by tens of percent in moderate inversion. Realize the result as this many fingers of the characterization width, which tracks the table. The count is rounded, so the realized total (shown with its deviation) can differ from the sized W — materially at small counts.',
  avth: 'Pelgrom V_th matching coefficient A_Vth (mV·µm): σ(V_th) ≈ A_Vth/√(W·L). The default is a generic placeholder — replace it with your PDK\u2019s measured value.',
  abeta: 'Pelgrom current-factor matching coefficient A_β (%·µm).',
};
