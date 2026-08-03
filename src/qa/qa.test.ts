import { describe, it, expect } from 'vitest';
import { validate, canonicalizeTable } from './index';
import { generateDemoDevice } from '../demo';
import type { Axis, DeviceTable, Grid, TableMeta } from '../types';

// --- builders ----------------------------------------------------------------

function axis(name: string, values: number[]): Axis {
  return { name, values: Float64Array.from(values) };
}

function makeTable(
  axes: Axis[],
  quantities: Record<string, number[]>,
  meta: TableMeta = {},
): DeviceTable {
  const shape = axes.map((a) => a.values.length);
  const q = new Map<string, Float64Array>();
  for (const [k, v] of Object.entries(quantities)) q.set(k, Float64Array.from(v));
  const grid: Grid = { axes, shape, quantities: q };
  return {
    id: { device: 'nch', corner: 'tt', temp: 27 },
    grid,
    meta,
  };
}

/** Build flat row-major gm/id columns from per-(l,vgs) functions. */
function fill(
  lvals: number[],
  vgsvals: number[],
  fn: (l: number, vgs: number) => number,
): number[] {
  const out: number[] = [];
  for (const l of lvals) for (const vgs of vgsvals) out.push(fn(l, vgs));
  return out;
}

// --- vgs-step ----------------------------------------------------------------

describe('validate: vgs step', () => {
  it('flags a 50 mV vgs step as a vgs-step warning', () => {
    const vgs = [0, 0.05, 0.1, 0.15]; // 50 mV spacing
    const t = makeTable([axis('vgs', vgs)], {
      gm: [1e-3, 1e-3, 1e-3, 1e-3],
      id: [1e-3, 1e-3, 1e-3, 1e-3],
    });
    const w = validate(t);
    const step = w.find((x) => x.rule === 'vgs-step');
    expect(step).toBeDefined();
    expect(step?.severity).toBe('warning');
    expect(step?.message).toMatch(/50\.0 mV/);
  });

  it('does not flag a 10 mV step', () => {
    const vgs = [0, 0.01, 0.02, 0.03];
    const t = makeTable([axis('vgs', vgs)], {
      gm: [1e-3, 1e-3, 1e-3, 1e-3],
      id: [1e-3, 1e-3, 1e-3, 1e-3],
    });
    expect(validate(t).some((x) => x.rule === 'vgs-step')).toBe(false);
  });
});

// --- gm/ID ceiling -----------------------------------------------------------

describe('validate: gm/ID ceiling', () => {
  it('flags a gm/ID peaking at 60 as a gm-id-ceiling error', () => {
    // id chosen so gm/id reaches 60 at one sample.
    const vgs = [0.2, 0.4, 0.6];
    const gm = [6e-3, 6e-3, 6e-3];
    const id = [1e-4, 6e-3, 6e-3]; // gm/id = 60 at first sample
    const t = makeTable([axis('vgs', vgs)], { gm, id });
    const w = validate(t);
    const c = w.find((x) => x.rule === 'gm-id-ceiling');
    expect(c).toBeDefined();
    expect(c?.severity).toBe('error');
  });

  it('warns (not errors) when gm/ID is between 38.7 and 45', () => {
    const vgs = [0.2, 0.4];
    const gm = [4e-3, 4e-3];
    const id = [1e-4, 4e-3]; // gm/id = 40 -> above ceiling, below unit-error
    const t = makeTable([axis('vgs', vgs)], { gm, id });
    const c = validate(t).find((x) => x.rule === 'gm-id-ceiling');
    expect(c?.severity).toBe('warning');
  });

  it('is silent for physical gm/ID values', () => {
    const vgs = [0.2, 0.4];
    const gm = [4e-3, 4e-3];
    const id = [2e-4, 4e-3]; // gm/id = 20 max
    const t = makeTable([axis('vgs', vgs)], { gm, id });
    expect(validate(t).some((x) => x.rule === 'gm-id-ceiling')).toBe(false);
  });

  it('does not flag cold-corner gm/ID that is physical at −40 °C but would error at 27 °C', () => {
    const vgs = [0.2, 0.4];
    const gm = [4.8e-3, 4.8e-3];
    const id = [1e-4, 4.8e-3]; // gm/id = 48 at the first sample
    // 48 is under the −40 °C ceiling (1/U_T ≈ 49.8), so no flag …
    const cold = makeTable([axis('vgs', vgs)], { gm, id }, { temp: -40 });
    expect(validate(cold).some((x) => x.rule === 'gm-id-ceiling')).toBe(false);
    // … but the SAME data at 27 °C exceeds the 45 unit-error line → error.
    const room = makeTable([axis('vgs', vgs)], { gm, id }, { temp: 27 });
    expect(validate(room).find((x) => x.rule === 'gm-id-ceiling')?.severity).toBe('error');
  });

  it('tightens the ceiling at hot temperature (125 °C)', () => {
    const vgs = [0.2, 0.4];
    const gm = [3.2e-3, 3.2e-3];
    const id = [1e-4, 3.2e-3]; // gm/id = 32
    // At 125 °C the ceiling drops to ~29.2 (unit-error ~34), so 32 warns …
    const hot = makeTable([axis('vgs', vgs)], { gm, id }, { temp: 125 });
    expect(validate(hot).find((x) => x.rule === 'gm-id-ceiling')?.severity).toBe('warning');
    // … while 32 is comfortably physical at 27 °C (< 38.7).
    const room = makeTable([axis('vgs', vgs)], { gm, id }, { temp: 27 });
    expect(validate(room).some((x) => x.rule === 'gm-id-ceiling')).toBe(false);
  });

  it('skips the check gracefully when gm or id is absent', () => {
    const t = makeTable([axis('vgs', [0.2, 0.4])], { gm: [1e-3, 1e-3] });
    expect(validate(t).some((x) => x.rule === 'gm-id-ceiling')).toBe(false);
  });
});

// --- unit-vgs ----------------------------------------------------------------

describe('validate: unit-vgs', () => {
  it('flags |vgs|=300 as a unit-vgs error', () => {
    const vgs = [0, 100, 200, 300]; // looks like mV stored as V
    const t = makeTable([axis('vgs', vgs)], {
      gm: [1e-3, 1e-3, 1e-3, 1e-3],
      id: [1e-3, 1e-3, 1e-3, 1e-3],
    });
    const w = validate(t);
    const u = w.find((x) => x.rule === 'unit-vgs');
    expect(u).toBeDefined();
    expect(u?.severity).toBe('error');
  });
});

// --- non-monotonic -----------------------------------------------------------

describe('validate: monotonicity', () => {
  it('flags a non-strictly-increasing vgs axis', () => {
    const vgs = [0, 0.1, 0.1, 0.2]; // duplicate -> not strictly increasing
    const t = makeTable([axis('vgs', vgs)], {
      gm: [1e-3, 1e-3, 1e-3, 1e-3],
      id: [1e-3, 1e-3, 1e-3, 1e-3],
    });
    const m = validate(t).find((x) => x.rule === 'non-monotonic');
    expect(m).toBeDefined();
    expect(m?.severity).toBe('error');
  });
});

// --- saturation (info) -------------------------------------------------------

describe('validate: saturation', () => {
  it('emits an info when gds never falls along vds in a slice', () => {
    const l = [1e-7];
    const vds = [0.1, 0.2, 0.3];
    const vgs = [0.5];
    // axes order: l, vds, vgs -> gds rising monotonically (never saturates)
    const gdsCol = [1e-6, 2e-6, 3e-6]; // rising along vds, never falls
    const t = makeTable([axis('l', l), axis('vds', vds), axis('vgs', vgs)], {
      gds: gdsCol,
      gm: [1, 1, 1],
      id: [1, 1, 1],
    });
    const info = validate(t).find((x) => x.rule === 'no-saturation');
    expect(info).toBeDefined();
    expect(info?.severity).toBe('info');
  });

  it('does not emit no-saturation when gds falls', () => {
    const l = [1e-7];
    const vds = [0.1, 0.2, 0.3];
    const vgs = [0.5];
    const gdsCol = [3e-6, 2e-6, 1e-6]; // falls along vds
    const t = makeTable([axis('l', l), axis('vds', vds), axis('vgs', vgs)], { gds: gdsCol });
    expect(validate(t).some((x) => x.rule === 'no-saturation')).toBe(false);
  });
});

// --- per-L-slice multi-slice -------------------------------------------------

describe('validate: multi L-slice', () => {
  it('reports a coarse vgs step ONCE for the shared axis, not per L-slice', () => {
    const l = [1e-7, 2e-7];
    const vgs = [0, 0.05, 0.1];
    const gm = fill(l, vgs, () => 1e-3);
    const id = fill(l, vgs, () => 1e-3);
    const t = makeTable([axis('l', l), axis('vgs', vgs)], { gm, id });
    const steps = validate(t).filter((x) => x.rule === 'vgs-step');
    // One vgs values array serves every slice — one defect is one finding.
    expect(steps.length).toBe(1);
    expect(steps[0].location).toBe('vgs');
  });
});

// --- deepened data-trust checks ----------------------------------------------

describe('validate: gm consistency with d(id)/d(vgs)', () => {
  const vgs = [0.1, 0.2, 0.3, 0.4];
  const id = [1e-3, 1.1e-3, 1.2e-3, 1.3e-3]; // slope 1e-3 ⇒ FD gm = 1e-3

  it('warns when stored gm disagrees with the id derivative', () => {
    const t = makeTable([axis('vgs', vgs)], { id, gm: [5e-3, 5e-3, 5e-3, 5e-3] }); // 5× FD
    const c = validate(t).find((x) => x.rule === 'gm-consistency');
    expect(c).toBeDefined();
    expect(c?.severity).toBe('warning');
  });

  it('is silent when stored gm equals the id derivative', () => {
    const t = makeTable([axis('vgs', vgs)], { id, gm: [1e-3, 1e-3, 1e-3, 1e-3] });
    expect(validate(t).some((x) => x.rule === 'gm-consistency')).toBe(false);
  });

  it('does NOT warn on a valid signed PMOS sweep (magnitude comparison)', () => {
    // vgs ascends (signed, left untouched by canonicalization); |id| decreases, so
    // d(id)/d(vgs) is negative while magnitude gm is positive. Compared as magnitudes
    // these agree: |−5e-3| == 5e-3 — no false "mislabeled" flag.
    const t = makeTable([axis('vgs', [-0.6, -0.4, -0.2])], {
      id: [3e-3, 2e-3, 1e-3], // magnitudes, falling with ascending vgs
      gm: [5e-3, 5e-3, 5e-3], // = |d(id)/d(vgs)| = |−2e-3/0.4|
    });
    expect(validate(t).some((x) => x.rule === 'gm-consistency')).toBe(false);
    expect(validate(t).some((x) => x.rule === 'id-non-monotonic')).toBe(false);
  });

  it('catches a single corrupted bias plane (per-line, not slice-wide median)', () => {
    // 3 vds planes over the same L; gm is 10× wrong on ONLY the last plane. A pooled
    // slice median (33% bad) would miss it; a per-line bad-fraction must catch it.
    const vds = [0.4, 0.8, 1.2];
    const idLine = [1e-3, 1.1e-3, 1.2e-3, 1.3e-3]; // FD gm = 1e-3
    const id3 = [...idLine, ...idLine, ...idLine];
    const gm3 = [
      1e-3,
      1e-3,
      1e-3,
      1e-3, // plane 0 correct
      1e-3,
      1e-3,
      1e-3,
      1e-3, // plane 1 correct
      1e-2,
      1e-2,
      1e-2,
      1e-2, // plane 2 corrupted (10×)
    ];
    const t = makeTable([axis('l', [1e-7]), axis('vds', vds), axis('vgs', vgs)], {
      id: id3,
      gm: gm3,
    });
    expect(validate(t).some((x) => x.rule === 'gm-consistency')).toBe(true);
  });
});

describe('validate: non-finite / id-monotonic / gm-sign', () => {
  it('flags a NaN/Inf island as a non-finite error', () => {
    const vgs = [0.1, 0.2, 0.3];
    const t = makeTable([axis('vgs', vgs)], {
      gm: [1e-3, 1e-3, 1e-3],
      id: [1e-3, 2e-3, 3e-3],
      gds: [1e-6, NaN, 1e-6],
    });
    const f = validate(t).find((x) => x.rule === 'non-finite');
    expect(f?.severity).toBe('error');
    expect(f?.message).toMatch(/gds/);
  });

  it('flags id that both rises and falls along vgs', () => {
    const t = makeTable([axis('vgs', [0.1, 0.2, 0.3, 0.4])], {
      id: [1e-3, 2e-3, 1.5e-3, 3e-3], // up, down, up
      gm: [1e-3, 1e-3, 1e-3, 1e-3],
    });
    const m = validate(t).find((x) => x.rule === 'id-non-monotonic');
    expect(m?.severity).toBe('warning');
  });

  it('flags a negative gm value', () => {
    const t = makeTable([axis('vgs', [0.1, 0.2, 0.3])], {
      gm: [1e-3, -1e-3, 1e-3],
      id: [1e-3, 2e-3, 3e-3],
    });
    const s = validate(t).find((x) => x.rule === 'gm-sign');
    expect(s?.severity).toBe('warning');
  });

  it('does NOT flag id rising in one bias plane and falling in another (per-line)', () => {
    // Two vds planes, each individually monotonic (one up, one down). Tracking
    // up/down slice-wide would falsely cry "glitch"; per-line must not.
    const t = makeTable(
      [axis('l', [1e-7]), axis('vds', [0.4, 0.8]), axis('vgs', [0.1, 0.2, 0.3, 0.4])],
      {
        id: [
          1e-3, 2e-3, 3e-3, 4e-3, /* plane 1 rising */ 4e-3, 3e-3, 2e-3, 1e-3 /* plane 2 falling */,
        ],
        gm: new Array(8).fill(1e-2), // = |central FD| on both planes ⇒ no gm-consistency noise
      },
    );
    expect(validate(t).some((x) => x.rule === 'id-non-monotonic')).toBe(false);
  });
});

describe('validate: clean demo triggers none of the deepened checks', () => {
  it('the analytic EKV demo is consistent, finite, monotonic, and noise-clean', () => {
    const w = validate(generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.05 } }));
    // Including the noise/sign checks: the demo ships a constant gamma, sth>0, sfl>0, gds>0, cgg>0.
    const noisy = new Set([
      'gm-consistency',
      'id-non-monotonic',
      'non-finite',
      'gm-sign',
      'gds-sign',
      'cap-sign',
      'noise-psd',
      'gamma-range',
    ]);
    expect(w.filter((x) => noisy.has(x.rule))).toEqual([]);
  });
});

describe('validate: deepened sign / noise / gamma checks', () => {
  it('flags a negative gds value', () => {
    const t = makeTable([axis('vgs', [0.1, 0.2, 0.3])], {
      gm: [1e-3, 1e-3, 1e-3],
      id: [1e-3, 2e-3, 3e-3],
      gds: [1e-6, -1e-6, 1e-6],
    });
    expect(validate(t).find((x) => x.rule === 'gds-sign')?.severity).toBe('warning');
  });

  it('flags a negative cgg but NOT a legitimately-signed cross-capacitance', () => {
    const badCgg = makeTable([axis('vgs', [0.1, 0.2, 0.3])], {
      gm: [1e-3, 1e-3, 1e-3],
      id: [1e-3, 2e-3, 3e-3],
      cgg: [1e-15, -1e-15, 1e-15],
    });
    expect(validate(badCgg).find((x) => x.rule === 'cap-sign')?.severity).toBe('warning');
    // cross/trans-caps (cgd, …) are legitimately negative by convention → must NOT warn.
    const signedCgd = makeTable([axis('vgs', [0.1, 0.2, 0.3])], {
      gm: [1e-3, 1e-3, 1e-3],
      id: [1e-3, 2e-3, 3e-3],
      cgg: [1e-15, 1e-15, 1e-15],
      cgd: [-1e-16, -1e-16, -1e-16],
    });
    expect(validate(signedCgd).some((x) => x.rule === 'cap-sign')).toBe(false);
  });

  it('flags a non-positive noise PSD as an error (it poisons input-referred noise)', () => {
    const t = makeTable([axis('vgs', [0.1, 0.2, 0.3])], {
      gm: [1e-3, 1e-3, 1e-3],
      id: [1e-3, 2e-3, 3e-3],
      sth: [1e-20, 0, 1e-20],
      sfl: [1e-20, 1e-20, -1e-20],
    });
    const w = validate(t).filter((x) => x.rule === 'noise-psd');
    expect(w.length).toBe(2); // one for sth, one for sfl
    expect(w.every((x) => x.severity === 'error')).toBe(true);
  });

  it('flags an out-of-band gamma but allows a high short-channel gamma', () => {
    const bad = makeTable([axis('vgs', [0.1, 0.2, 0.3])], {
      gm: [1e-3, 1e-3, 1e-3],
      id: [1e-3, 2e-3, 3e-3],
      gamma: [0.7, 5.0, 0.7], // 5.0 > 4.0 → unit/model error
    });
    expect(validate(bad).find((x) => x.rule === 'gamma-range')?.severity).toBe('warning');
    // Valid deep-submicron γ (up to ~3) must NOT be flagged.
    const shortChan = makeTable([axis('vgs', [0.1, 0.2, 0.3])], {
      gm: [1e-3, 1e-3, 1e-3],
      id: [1e-3, 2e-3, 3e-3],
      gamma: [0.7, 2.5, 3.5],
    });
    expect(validate(shortChan).some((x) => x.rule === 'gamma-range')).toBe(false);
  });
});

// --- canonicalization --------------------------------------------------------

describe('canonicalizeTable', () => {
  it('returns the same reference when not signed', () => {
    const t = makeTable([axis('vgs', [0.2, 0.4])], { gm: [1e-3, 1e-3], id: [1e-3, 1e-3] });
    expect(canonicalizeTable(t)).toBe(t);
  });

  it('folds signed PMOS quantity columns to magnitudes; leaves sweep axes signed', () => {
    const vgs = [-0.6, -0.4, -0.2]; // ascending negative
    const t = makeTable(
      [axis('vgs', vgs)],
      {
        id: [-3e-3, -2e-3, -1e-3],
        gm: [-1e-3, -1e-3, -1e-3],
        gds: [-1e-6, -1e-6, -1e-6],
        cgg: [-1e-15, -1e-15, -1e-15],
        vth: [-0.4, -0.4, -0.4],
      },
      { polarity: { device: 'p', signedInput: true } },
    );
    const c = canonicalizeTable(t);
    expect(c).not.toBe(t);

    // Sweep axis stays signed/ascending (folding it without reindexing would corrupt alignment).
    expect(Array.from(c.grid.axes[0].values)).toEqual([-0.6, -0.4, -0.2]);

    // Signed columns -> magnitude, in row order aligned to the (signed) axis.
    expect(Array.from(c.grid.quantities.get('id')!)).toEqual([3e-3, 2e-3, 1e-3]);
    expect(Array.from(c.grid.quantities.get('gm')!).every((x) => x > 0)).toBe(true);
    expect(Array.from(c.grid.quantities.get('gds')!).every((x) => x > 0)).toBe(true);
    expect(Array.from(c.grid.quantities.get('cgg')!).every((x) => x > 0)).toBe(true);
    expect(Array.from(c.grid.quantities.get('vth')!).every((x) => x > 0)).toBe(true);

    // Polarity recorded; signedInput cleared after folding.
    expect(c.meta.polarity).toEqual({ device: 'p', signedInput: false });
  });

  it('folds the self-term cgg but PRESERVES a signed cross-capacitance cgd', () => {
    const t = makeTable(
      [axis('vgs', [-0.6, -0.4, -0.2])],
      {
        id: [-3e-3, -2e-3, -1e-3],
        gm: [-1e-3, -1e-3, -1e-3],
        cgg: [-1e-15, -1e-15, -1e-15], // self-term gate cap → folded to magnitude
        cgd: [-1e-16, -1e-16, -1e-16], // cross/trans-cap → legitimately signed, left as-is
      },
      { polarity: { device: 'p', signedInput: true } },
    );
    const c = canonicalizeTable(t);
    expect(Array.from(c.grid.quantities.get('cgg')!).every((x) => x > 0)).toBe(true);
    // cgd is NOT abs-ed: its sign carries ∂Qg/∂Vd information that a fold would destroy.
    expect(Array.from(c.grid.quantities.get('cgd')!)).toEqual([-1e-16, -1e-16, -1e-16]);
  });

  it('does not mutate the source table', () => {
    const id = [-3e-3, -2e-3];
    const t = makeTable(
      [axis('vgs', [-0.4, -0.2])],
      { id, gm: [-1e-3, -1e-3] },
      { polarity: { device: 'p', signedInput: true } },
    );
    canonicalizeTable(t);
    expect(Array.from(t.grid.quantities.get('id')!)).toEqual([-3e-3, -2e-3]);
    expect(Array.from(t.grid.axes[0].values)).toEqual([-0.4, -0.2]);
  });
});
