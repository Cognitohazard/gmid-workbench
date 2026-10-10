// Vetted sheets shipped as no-typing starting points. Single-device leaves plus one
// COMPOSED example (the cascode below). Composition here is strictly SCALAR provide/use:
// a child block exposes named scalars and the parent writes its own author math over them
// (referenced as `child__name`). There is still NO node/port/KCL machinery and no member
// access — those remain the deferred coupling channels. Pure data; zero DOM imports.

import type { SheetDoc } from './types';

/**
 * Single-device gm/ID sizing: the canonical spec → gm → (gm/ID, L) → ID → W flow with
 * author-written constraints, on one device. gm is fixed from the bandwidth spec, gm/ID
 * is the design knob, and ID/W fall out of the lookup. Every name is a flat scalar — a
 * param, or a value the sizing surfaces at the operating point (vstar, cgg, ceiling,
 * vnth_m). The headroom floor is set so the default gm/ID = 12 (V* ≈ 167 mV) lands just
 * under it: the tool flags that the chosen efficiency costs more headroom than budgeted,
 * the classic gm/ID trade made visible. Noise uses the namespace's γ-model density
 * (vnth_m), so no formula is re-typed here.
 */
const NMOS_GMID_SIZING: SheetDoc = {
  title: 'Single NMOS gm/ID sizing',
  description:
    'Sizes one NMOS for a bandwidth spec: $g_m$ is fixed from GBW into $C_L$, $g_m/I_D$ is ' +
    'the efficiency knob, and $I_D/W$ falls out of the lookup. Change the spec params freely; ' +
    'tune the choice params ($g_m/I_D$, $L$) and watch the headroom/noise trade.',
  polarity: 'n',
  params: [
    { name: 'GBW_target', value: 10e6, unit: 'Hz', role: 'spec' },
    { name: 'CL', value: 2e-12, unit: 'F', role: 'spec', note: 'load capacitance' },
    { name: 'L', value: 0.5e-6, min: 0.18e-6, max: 2e-6, unit: 'm', role: 'choice' },
    {
      name: 'gm_id',
      value: 12,
      min: 6,
      max: 18,
      unit: '1/V',
      role: 'choice',
      note: 'inversion-level knob: high = efficient/slow, low = fast/thirsty',
    },
    {
      name: 'vstar_floor',
      value: 0.2,
      unit: 'V',
      role: 'spec',
      note: 'saturation-headroom budget; default set so gm/ID = 12 lands just under it',
    },
    { name: 'vn_target', value: 20e-9, unit: 'V/sqrt(Hz)', role: 'spec' },
    {
      name: 'V_ds',
      value: 0.6,
      unit: 'V',
      role: 'spec',
      note:
        'drain bias the sizing slices at, stated by the designer: this sheet is one device and ' +
        'nothing on it sets the drain; body-grounded, so vsb = 0',
      class: 'independent',
    },
  ],
  // bind-any-2: gm from the spec, gm/ID the knob; ID is derived via gm = gm/ID · ID.
  // The operating point is pinned here so sizing never silently borrows the panel's bias.
  givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: 'V_ds', vsb: '0' },
  equations: [
    { name: 'Cout', expr: 'cgg + CL', unit: 'F' },
    { name: 'GBW', expr: 'gm/(2*pi*Cout)', unit: 'Hz' },
    { name: 'vn_in', expr: 'vnth_m', unit: 'V/sqrt(Hz)' }, // γ-model thermal density from the namespace
  ],
  checks: [
    // Hard floors — checked against the LUT, never solved:
    { id: 'feasible-inversion', kind: 'physical', lhs: 'gm_id', op: '<=', rhs: 'ceiling' },
    { id: 'headroom', kind: 'physical', lhs: 'vstar', op: '>=', rhs: 'vstar_floor' },
    // Soft advisory:
    { id: 'gbw-margin', kind: 'advisory', lhs: 'GBW', op: '>=', rhs: 'GBW_target' },
    // Self-adopted application spec (stands in for an absent consumer):
    { id: 'noise-spec', kind: 'spec', lhs: 'vn_in', op: '<=', rhs: 'vn_target' },
  ],
};

/**
 * Single-device noise & matching at a FIXED current budget: the methodology's classic "pick
 * gm/ID for noise vs headroom" trade made visible. ID is fixed (the bias budget) and gm/ID is the
 * knob, so raising gm/ID raises gm (= gm/ID·ID) and lowers the integrated thermal noise, while the
 * saturation headroom V* = 2/(gm/ID) shrinks. Both figures are author closed-forms over the
 * device's own data quantities, NOT re-baked into the engine: integrated input noise from the
 * stored thermal/flicker PSDs (svth, svfl — `log` is natural log) and the Pelgrom input offset
 * from the sized geometry W·L and the Pelgrom coefficients. Sweep gm/ID to see a bounded feasible
 * window — noise fails at the low-gm/ID (low-gm) end, headroom at the high-gm/ID end.
 */
const NMOS_NOISE_MATCHING: SheetDoc = {
  title: 'NMOS noise & matching',
  description:
    'One device at a fixed current budget: raise $g_m/I_D$ and the integrated input noise ' +
    'falls ($g_m$ grows) while the saturation headroom shrinks — sweep $g_m/I_D$ to see the ' +
    'bounded feasible window. Pelgrom offset is set by the sized $W*L$ area.',
  polarity: 'n',
  params: [
    { name: 'I_bias', value: 10e-6, unit: 'A', role: 'spec', note: 'fixed current budget' },
    { name: 'L', value: 0.5e-6, min: 0.18e-6, max: 2e-6, unit: 'm', role: 'choice' },
    { name: 'gm_id', value: 12, min: 6, max: 18, unit: '1/V', role: 'choice' },
    { name: 'f_lo', value: 1, unit: 'Hz', role: 'spec', note: 'noise integration band, low edge' },
    {
      name: 'f_hi',
      value: 1e6,
      unit: 'Hz',
      role: 'spec',
      note: 'noise integration band, high edge',
    },
    {
      name: 'avt',
      value: 5e-9,
      unit: 'V*m',
      role: 'spec',
      note: 'Pelgrom A_VT (~5 mV*um); from the PDK',
    },
    {
      name: 'abeta',
      value: 1e-8,
      unit: 'm',
      role: 'spec',
      note: 'Pelgrom A_beta (~1%*um); from the PDK',
    },
    { name: 'vstar_floor', value: 0.12, unit: 'V', role: 'spec' },
    {
      name: 'vn_target',
      value: 45e-6,
      unit: 'V',
      role: 'spec',
      note: 'integrated input noise, RMS',
    },
    { name: 'vos_target', value: 15e-3, unit: 'V', role: 'spec', note: 'input offset, 1 sigma' },
    {
      name: 'V_ds',
      value: 0.6,
      unit: 'V',
      role: 'spec',
      note:
        'drain bias the sizing slices at, stated by the designer: this sheet is one device and ' +
        'nothing on it sets the drain; body-grounded, so vsb = 0',
      class: 'independent',
    },
  ],
  // bind-any-2: fix ID (budget) and gm/ID (knob); gm is derived via gm = gm/ID · ID.
  givens: { L: 'L', id: 'I_bias', gm_id: 'gm_id', vds: 'V_ds', vsb: '0' },
  equations: [
    // The sizing reports every quantity at the SIZED width (svth/svfl included — the
    // parallel-composition rescale is the sizer's job, not author math), so the stored
    // input-referred PSDs are used directly. fco is intensive either way.
    // Integrated input-referred noise: thermal floor over the band + the 1/f tail (∫ 1/f = ln).
    {
      name: 'vn_int',
      expr: 'sqrt(svth*(f_hi - f_lo) + svfl*log(f_hi/f_lo))',
      unit: 'V',
      note: 'thermal floor over the band + 1/f tail; equals noise_rms(svth, fco, f_lo, f_hi)',
    },
    { name: 'corner', expr: 'fco', unit: 'Hz' }, // flicker corner, for display
    // Pelgrom random mismatch, referred to the input. σ ∝ 1/√(W·L); the β-term refers through gm/ID.
    { name: 'sigma_vth', expr: 'avt/sqrt(W*L)', unit: 'V' },
    { name: 'sigma_beta', expr: 'abeta/sqrt(W*L)', unit: '1' },
    { name: 'sigma_vos', expr: 'sqrt(2)*sqrt(sigma_vth^2 + (sigma_beta/gm_id)^2)', unit: 'V' },
  ],
  checks: [
    { id: 'feasible-inversion', kind: 'physical', lhs: 'gm_id', op: '<=', rhs: 'ceiling' },
    { id: 'headroom', kind: 'physical', lhs: 'vstar', op: '>=', rhs: 'vstar_floor' },
    { id: 'noise-spec', kind: 'spec', lhs: 'vn_int', op: '<=', rhs: 'vn_target' },
    { id: 'offset-spec', kind: 'spec', lhs: 'sigma_vos', op: '<=', rhs: 'vos_target' },
  ],
};

/**
 * The child block of the cascode: a common-source NMOS input device sized at a fixed
 * current. It exposes the scalars a parent needs to compose a cascode — the intrinsic
 * gain av0 = gm/gds (intensive, so width-scale-free), the transconductance, the
 * saturation headroom V*, and its drain current (which the cascode device carries in
 * series). A leaf in its own right; it ships physical validity as an invariant.
 */
const COMMON_SOURCE_INPUT: SheetDoc = {
  title: 'Common-source input device',
  polarity: 'n',
  params: [
    { name: 'L', value: 0.5e-6, unit: 'm' },
    { name: 'gm_id', value: 12, unit: '1/V' },
    { name: 'I_bias', value: 20e-6, unit: 'A' },
    {
      name: 'V_ds',
      value: 0.3,
      unit: 'V',
      note:
        'drain bias, stated: on its own this block has nothing above it to set the drain. A ' +
        'parent that stacks a device on it wires its own node in',
      class: 'independent',
    },
  ],
  // vds is the (low) input-device drain; body-grounded ⇒ vsb = 0.
  givens: { L: 'L', id: 'I_bias', gm_id: 'gm_id', vds: 'V_ds', vsb: '0' },
  equations: [],
  checks: [{ id: 'feasible-inversion', kind: 'physical', lhs: 'gm_id', op: '<=', rhs: 'ceiling' }],
  provides: ['gm', 'av0', 'vstar', 'id'],
};

/**
 * A COMPOSED example: an NMOS cascode whose output resistance (and hence gain) is boosted
 * by stacking a cascode device on a common-source input. It instantiates the input device
 * as a child `use`, passes down the shared length / efficiency / current, and sizes its own
 * cascode device in series (carrying the child's drain current `cs__id`). The cascode gain
 * is the classic product of the two stages' intrinsic gains, Av ≈ av0_input · av0_cascode —
 * ordinary author math over the child's exposed `av0`, no circuit traversal. Sweep gm/ID to
 * see the gain↔headroom trade across the whole composition: gain (∝ gm/ID per stage, squared)
 * grows with gm/ID while both stages' V* shrink, so a bounded feasible window emerges.
 */
const NMOS_CASCODE: SheetDoc = {
  title: 'NMOS cascode (gain-boosted output)',
  description:
    'A composed sheet: a common-source input device (child block "cs") with a cascode ' +
    'device stacked in series, carrying the child-provided current $I_{D,cs}$. Gain is the ' +
    'product of the two intrinsic gains — author math over the child provides, no ' +
    'circuit solving. Sweep $g_m/I_D$ for the gain vs headroom window.',
  polarity: 'n',
  params: [
    { name: 'I_bias', value: 20e-6, unit: 'A', role: 'spec', note: 'branch current budget' },
    {
      name: 'L',
      value: 0.5e-6,
      min: 0.18e-6,
      max: 2e-6,
      unit: 'm',
      role: 'choice',
      note: 'shared by both devices',
    },
    {
      name: 'gm_id',
      value: 12,
      min: 6,
      max: 18,
      unit: '1/V',
      role: 'choice',
      note: 'shared efficiency knob',
    },
    { name: 'CL', value: 2e-12, unit: 'F', role: 'spec' },
    { name: 'GBW_target', value: 10e6, unit: 'Hz', role: 'spec' },
    {
      name: 'Av_target',
      value: 600,
      unit: 'V/V',
      role: 'spec',
      note: 'roughly av0^2 must clear this',
    },
    {
      name: 'vstar_floor',
      value: 0.12,
      unit: 'V',
      role: 'spec',
      note: 'per-stage saturation floor',
    },
    {
      name: 'V_out',
      value: 1.2,
      unit: 'V',
      role: 'spec',
      note: 'output DC level, stated: whatever loads the cascode sets it, and that is not on this sheet',
      class: 'independent',
    },
    {
      name: 'V_x',
      value: 0.3,
      min: 0.1,
      max: 0.8,
      unit: 'V',
      role: 'choice',
      note:
        'the node between the two devices: the input drain and the cascode source. Stated at ' +
        'this design point; the cascode gate bias (this node plus its gate-source voltage) is ' +
        'what stays put where the design is held, and the node is re-solved under it',
      hold: 'V_x + vgs',
    },
  ],
  blocks: [
    {
      name: 'cs',
      doc: COMMON_SOURCE_INPUT,
      // Share the design knobs with the input device (param overrides resolve in this scope),
      // and put its drain on the node the cascode's source sits on.
      params: { L: 'L', gm_id: 'gm_id', I_bias: 'I_bias', V_ds: 'V_x' },
    },
  ],
  // The cascode device sits in series with the input device, so it carries the same drain
  // current cs__id (a child-provided scalar referenced right here in the parent's bind). Its
  // It sits between the output and that node, with its body grounded, so its source — and
  // with it its body bias — is the node voltage.
  givens: { L: 'L', id: 'cs__id', gm_id: 'gm_id', vds: 'V_out - V_x', vsb: 'V_x' },
  equations: [
    // Cascode gain ≈ product of the two stages' intrinsic gains (av0 is width-independent).
    { name: 'Av', expr: 'av0 * cs__av0', unit: 'V/V' },
    { name: 'GBW', expr: 'cs__gm/(2*pi*CL)', unit: 'Hz' }, // input gm over the load cap
  ],
  checks: [
    { id: 'feasible-inversion', kind: 'physical', lhs: 'gm_id', op: '<=', rhs: 'ceiling' },
    { id: 'cs-headroom', kind: 'physical', lhs: 'cs__vstar', op: '>=', rhs: 'vstar_floor' },
    { id: 'cascode-headroom', kind: 'physical', lhs: 'vstar', op: '>=', rhs: 'vstar_floor' },
    { id: 'gain-spec', kind: 'spec', lhs: 'Av', op: '>=', rhs: 'Av_target' },
    { id: 'gbw-margin', kind: 'advisory', lhs: 'GBW', op: '>=', rhs: 'GBW_target' },
  ],
};

export const EXAMPLES: readonly SheetDoc[] = [NMOS_GMID_SIZING, NMOS_NOISE_MATCHING, NMOS_CASCODE];
