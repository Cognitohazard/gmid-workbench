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
  // characterized devices: one logical device characterized at several (corner, temperature)
  // conditions
  deviceConditions:
    'One device, characterized at several conditions. Tables group by process namespace (# pdk:), device name and declared polarity — all read from the files, never assigned here. A grouping you disagree with is corrected in the data: add # pdk: to the exports and re-import.',
  cornerOverlay:
    'Draw every condition of this device alongside the active one, so the corner spread shows on every panel at once.',
  nominal:
    'The condition this bench means by “nominal”. Sheets evaluate there by default and the topology picker always searches there. Marked “auto” when the tt-at-27 °C rule picked it and nothing has been chosen — click to pin that choice, so a later import cannot move it; click a pinned one to release it back to the rule.',
  cornerMode:
    'Which conditions this sheet is evaluated at. Every run fixes ONE condition and evaluates the whole composition there — the primary device and every named block — because a verdict assembled from a fast input pair and a slow tail describes a chip that does not exist. nominal = the device’s designated condition; active table = whichever table is selected; chosen = the ones you tick; all = every condition loaded for this device. With one condition the design is sized there. With several it is one design: sized at the nominal condition — which joins the set if you left it out — and held at the others.',
  cornerDesign:
    'One design, asked about at every condition. “sized here” is the run that chose the widths — the nominal condition, or the only one asked about. “held” is that same hardware at another condition: its widths, lengths, currents and gate biases fixed, only the operating point re-settled. A corner is never allowed to re-size the design, because only one chip gets built.',
  compliance:
    'The second of two questions. Feasibility asks whether this design type can meet the spec, and is answered once, where the design is sized. Compliance asks whether that ONE design — its widths, lengths, currents and gate biases held fixed — still works everywhere it is promised to: at each condition selected, at its own operating point and at each end of the sheet’s operating range. Each of those is a point, and the badge counts them. A point either complies, fails, has no answer (it was asked and could not be answered: a solve did not land, the table does not reach that bias, or the design rests on an assumed voltage), or was not run (nothing to ask: no table at that condition, or no design to hold). The four are counted apart and never folded together, so “complies at 5 of 9” always says what happened to the other four. The tightest margin quoted below the badge is read only over points that were measured, and names the check and the point that own it.',
  cornerOneAtATime:
    'Only with a single condition selected. A design plane and a knob ranking are statements about one operating point, and there is no single point while several conditions are on screen.',
  sheet:
    'Load a design sheet — a small example or a curated library topology — with variables, author equations, and pass/fail checks with margins, sized on the active device.',
  assumptions:
    'Voltages this design was sized under rather than solved for: the ones the sheet marks “assumed” — an internal stack node, a guessed gate-source drop — that feed at least one device’s sizing. The sheet’s own parts determine each of them, but the sheet types a value for now instead of deriving it. The verdict holds only while those typed values are right, so they are listed with it. A voltage nothing on the sheet determines — a supply, an input level, an output held by a feedback loop outside the sheet, a voltage across a device whose surroundings are not on the sheet — is one you state, and is not listed here.',
  held: 'Node voltages that hang under a transistor’s gate — a cascode’s source, a pair’s tail. The sheet states each node at this design point, and this is the gate voltage that puts it there: the node plus the device’s gate-source voltage. Where the design is held fixed and re-checked — at a range end — that gate voltage is what stays put, and the node is re-solved under it.',
  feasBadge:
    'Can this design type meet the spec — on the device and at the condition the design is sized at, with the current variables? Feasible = every hard check (physical + spec) passes there; advisory checks never gate it. When it is not, the badge names the binding check: the failing hard check with the worst margin, anywhere in the composition (a child’s check is shown by path). Nothing that happens at another condition or at an end of the operating range moves this badge — that is compliance, counted beside it. “No answer” means the evaluation started and did not complete; “not evaluated” means it never started.',
  sensitivity:
    'Which knob to turn. For the check the badge names (or, on a feasible design, the check failing at a range end if one is, else the one with the least room left), this ranks the design choices by how far each moves that check’s margin over one small step of its own value — up and down shown separately, since a knob is rarely symmetric and an equality check genuinely differs on the two sides. It is a snapshot: each knob costs two full re-evaluations of the whole sheet, so it is taken when you ask and retired as soon as you change the design.',
  wiringWarning:
    'A block declares which node its gate and source are tied to, and the sizing says what its V_GS came out at. Those describe the same wire, so they must agree — this says by how much they do not. Nothing is repaired and no verdict moves: which of the two is wrong (the declared node, or the givens that implied a different one) is a design decision. It is the failure that lets two blocks be sized at gate voltages hundreds of millivolts apart with every check still green. To make it gate the design, write a hard check on the same two numbers.',
  sheetSweep:
    'Sweep one variable across its range and chart every check’s margin — the region where the design is feasible.',
  sheetSweep2:
    'Add a second variable to sweep the design plane: a feasibility heatmap (green = feasible, red = a hard check fails) instead of the 1-D margin chart.',
  blockDevice:
    'Size this block against a specific loaded device — load the other table first (devices accumulate in the bar below the toolbar), then pick it here (e.g. the PMOS table for a mirror load); “active device” inherits the parent’s.',
  // design-sheet vocabulary (check kinds, statuses, composition, bias, param roles)
  checkKind:
    'physical = a hard physical floor; spec = a hard application spec — both must hold for a feasible design. advisory = shown, never blocks.',
  amber:
    'The check holds but by under 5% margin — a near-miss worth a look. A spec set by its own givens snaps to amber instead of coin-flipping pass/fail on rounding.',
  checkNa:
    'na = a side could not be computed (an undeclared name or a non-finite value). Never a silent pass: a hard check reading na fails the design closed.',
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
  givensBias:
    'The operating point (vds/vsb, signed) this block is sized at. gds shifts ~4–5× across vds, so each device states its own; body bias (vsb) defaults to 0. Edit to override. Clearing the body bias reverts it to 0; the drain bias cannot be left empty.',
  givensAssumed:
    'A coordinate marked ? was not declared by this block — the engine filled it in. That is right for a common-source device or a rail-referenced mirror, and wrong for a differential pair, cascode or source follower, where the source floats above the bulk. Declare vsb in the givens if this device is one of those.',
  givensNeeds:
    'This block must state this bias but hasn’t, so sizing fails closed. A drain bias (vds) has no default on any table: every sized device states one, or declares a diode connection. A body bias (vsb) left out means 0, and the table was not taken there. Set a value here; the table has to sweep that bias, or have been taken at exactly that value.',
  solvedParam:
    'Solved, not set. This estimate stands in for a value only the evaluated sheet knows, closing a bias loop the block order cannot express: it is iterated until the two agree. The stored number is just a starting guess, so the field is read-only and the parameter cannot be swept.',
  constrainedParam:
    'Solved, not set. This is an internal bias node the engine chooses so a sheet output equals a spec you typed (e.g. the tail node placed so the common mode lands exactly on CM_dc). Solved by bisection between the parameter\u2019s min and max — its bracket, not slider bounds. Sweep the spec on the other side of the design constraint instead; the shown value is where the node landed.',
  constraintNotMet:
    'This design constraint was not met, so there is no solved value to show. The engine found no point in the parameter’s [min, max] bracket where the constraint holds — the warnings below name which way its solve failed (the bracket does not straddle the target, or the design stopped evaluating inside it). Move or widen the bracket, or relax the spec the constraint chases.',
  operatingRange:
    'Two different questions get asked of a sheet, and this strip answers the second one. Is the design FEASIBLE — can this design type meet the spec at all? The sweeps and the picker’s search work that way, free to re-size the devices while they look. Does it COMPLY — does the design you have right now still work at the ends of the range it claims (e.g. CM_dc = CM_lo, then CM_hi)? Every transistor is held exactly as this run sized it and only the bias re-settles, so a chip describes THIS instance and moves as you turn the knobs. Every hard check must hold at each end. The two answers are never folded: a range end that does not comply leaves the feasibility badge green and is counted in the compliance badge beside it. A ✓ chip shows where the bias landed; a ✗ chip names the check that fails there — and that often yields to re-centering rather than to a bigger device, so read the sensitivity ranking before spending area. A ? chip is no answer: the question was asked and could not be answered — a solve did not land, the table does not reach that bias, or the design rests on an assumed voltage — and it says which. A – chip was not run: the current settings produce no design to hold.',
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
  // topology picker (design-type search)
  picker:
    'Which design-type to start from. Type the spec you have — supply, load, gain, bandwidth, slew, noise, offset, common-mode range — and every amplifier and buffer sheet in the library is searched against it on the active device: does it close, at what quiescent current, with which knob settings, and what binds it. A screening instrument, not an optimizer — it finds feasible starting points and names their costs; the design still happens in the sheet. It answers feasibility only: whether a design you pick then holds across its operating range, or at other process conditions, is checked on its own sheet, where that one design is held fixed. Each field is optional: an empty box means "not my requirement", and the sheet keeps its own default.',
  pickerMargin:
    'The worst hard-check margin at the point reported — how much room the design has left where it is tightest, or how far it is from closing. A margin quoted on a sheet that did not close belongs to the last point the search reached, not to the design: it moves when the budget moves, so read the cause beside it before chasing the number.',
  pickerCoverage:
    'How many of the fields you typed this sheet actually has a parameter for and treats as a requirement you set. A sheet that consumed two of your ten is answering a smaller question than one that consumed ten, so the two are not comparable and are never ranked against each other. Hover for what was dropped and why — including a field whose name matches but whose unit does not (a noise density is not an integrated RMS), and one the sheet chooses for itself rather than taking from you.',
  fingers:
    'The table is characterized at ONE width; sizing scales it per-µm, and width effects (model bins, narrow-width V_th shifts) are NOT captured — a single wide finger can be off by tens of percent in moderate inversion. Realize the result as this many fingers of the characterization width, which tracks the table. The count is rounded, so the realized total (shown with its deviation) can differ from the sized W — materially at small counts.',
  avth: 'Pelgrom V_th matching coefficient A_Vth (mV·µm): σ(V_th) ≈ A_Vth/√(W·L). The default is a generic placeholder — replace it with your PDK\u2019s measured value.',
  abeta: 'Pelgrom current-factor matching coefficient A_β (%·µm).',
};
