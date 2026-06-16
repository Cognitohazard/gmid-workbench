// Vetted leaf sheets shipped as no-typing starting points. STRICTLY single-device: a
// leaf has one block and no shared node, so an example must never reference a second
// device or combine across nodes (that is the deferred coupling machinery, and it would
// pull network-reduction semantics past the scope rule). Pure data; zero DOM imports.

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
  polarity: 'n',
  params: [
    { name: 'GBW_target', value: 10e6, unit: 'Hz' },
    { name: 'CL', value: 2e-12, unit: 'F' },
    { name: 'L', value: 0.5e-6, min: 0.18e-6, max: 2e-6, unit: 'm' },
    { name: 'gm_id', value: 12, min: 6, max: 18, unit: '1/V' },
    { name: 'vstar_floor', value: 0.2, unit: 'V' },
    { name: 'vn_target', value: 20e-9, unit: 'V/sqrt(Hz)' },
  ],
  // bind-any-2: gm from the spec, gm/ID the knob; ID is derived via gm = gm/ID · ID.
  bind: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id' },
  rows: [
    { name: 'Cout', expr: 'cgg + CL', unit: 'F' },
    { name: 'GBW', expr: 'gm/(2*pi*Cout)', unit: 'Hz' },
    { name: 'vn_in', expr: 'vnth_m', unit: 'V/sqrt(Hz)' }, // γ-model thermal density from the namespace
  ],
  rules: [
    // Hard floors — checked against the LUT, never solved:
    { id: 'feasible-inversion', kind: 'invariant', lhs: 'gm_id', op: '<=', rhs: 'ceiling' },
    { id: 'headroom', kind: 'invariant', lhs: 'vstar', op: '>=', rhs: 'vstar_floor' },
    // Soft advisory:
    { id: 'gbw-margin', kind: 'guardrail', lhs: 'GBW', op: '>=', rhs: 'GBW_target' },
    // Self-adopted application spec (stands in for an absent consumer):
    { id: 'noise-spec', kind: 'requirement', lhs: 'vn_in', op: '<=', rhs: 'vn_target' },
  ],
};

export const EXAMPLES: readonly SheetDoc[] = [NMOS_GMID_SIZING];
