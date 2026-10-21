import { describe, it, expect } from 'vitest';
import { validate, canonicalizeTable } from './index';
import { generateDemoDevice, scaleQuantities, signedMirrorDemo } from '../demo';
import { makeGrid } from '../grid';
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

  // A step is a difference of floats, so an axis at exactly 10 mV measures a hair either side of
  // 0.01 — 0.07 - 0.06 is 0.010000000000000009. None of these is a coarse sweep.
  const flatTable = (vgs: number[]): DeviceTable =>
    makeTable([axis('vgs', vgs)], {
      gm: vgs.map(() => 1e-3),
      id: vgs.map(() => 1e-3),
    });
  const stepWarning = (vgs: number[]) =>
    validate(flatTable(vgs)).find((x) => x.rule === 'vgs-step');

  it('does not flag a 10 mV axis built from floats', () => {
    const n = 121; // 0 … 1.2 V
    // As the demo device and most exporters build it: start + i·step.
    const scaled = Array.from({ length: n }, (_, i) => i * 0.01);
    // As a running sum, which drifts further from the decimal values with every step.
    const summed: number[] = [];
    for (let i = 0, v = 0; i < n; i++, v += 0.01) summed.push(v);
    // As parsed from decimal text ("0.07", …): the nearest double to each value.
    const parsed = scaled.map((v) => Number(v.toFixed(2)));
    // Far from zero too, where one ULP is larger: a PMOS sweep from -1.8 V.
    const negative = Array.from({ length: n }, (_, i) => -1.8 + i * 0.01);
    for (const vgs of [scaled, summed, parsed, negative]) {
      expect(Math.max(...vgs.slice(1).map((v, i) => v - vgs[i]))).toBeGreaterThan(0.01); // past it in floats
      expect(stepWarning(vgs)).toBeUndefined();
    }
  });

  it('still flags a step just past 10 mV, and says by how much', () => {
    const w = stepWarning([0, 0.01, 0.02004, 0.03]);
    expect(w).toBeDefined();
    expect(w?.message).toMatch(/10\.04 mV exceeds 10 mV/);
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

describe('validate: the bias sweeps a table does not carry', () => {
  // What a table can be used for, said at import: information about valid data, so never a
  // warning, and never said of a table that has the sweep.
  const VDS = { min: 0, max: 1.2, step: 0.3 };
  const VSB = { min: 0, max: 0.6, step: 0.3 };
  const sweepFindings = (t: DeviceTable) =>
    validate(t).filter((w) => w.rule === 'no-vds-sweep' || w.rule === 'no-vsb-sweep');

  it('is silent on a table that sweeps both, in either polarity', () => {
    const swept = generateDemoDevice({ vds: VDS, vsb: VSB });
    expect(sweepFindings(swept)).toEqual([]);
    // A signed PMOS table sweeps vds downward from zero; a negative sweep is still a sweep.
    const pmos = signedMirrorDemo(swept);
    expect(pmos.grid.axes.find((a) => a.name === 'vds')?.values[0]).toBeLessThan(0);
    expect(sweepFindings(pmos)).toEqual([]);
    expect(sweepFindings(canonicalizeTable(pmos))).toEqual([]);
  });

  it('says what a table with no vds column cannot size — as information, not a warning', () => {
    const w = sweepFindings(generateDemoDevice({ vsb: VSB }));
    expect(w.map((x) => [x.rule, x.severity, x.location])).toEqual([
      ['no-vds-sweep', 'info', 'vds'],
    ]);
    // What it rules out: every device a design sheet sizes, since each one states its drain
    // voltage and the table records none.
    expect(w[0].message).toMatch(/no vds sweep \(no vds column\): it plots, but no design sheet/);
    expect(w[0].message).toMatch(/can size a device from it/);
    expect(w[0].message).toMatch(/drain voltage/);
  });

  it('says a table with no vsb column is taken as vsb = 0, and what that rules out', () => {
    const w = sweepFindings(generateDemoDevice({ vds: VDS }));
    expect(w.map((x) => [x.rule, x.severity, x.location])).toEqual([
      ['no-vsb-sweep', 'info', 'vsb'],
    ]);
    expect(w[0].message).toMatch(/no vsb sweep/);
    expect(w[0].message).toMatch(/vsb = 0(?![.\d])/);
  });

  it('raises both on a table that sweeps only length and gate voltage', () => {
    expect(sweepFindings(generateDemoDevice()).map((x) => x.rule)).toEqual([
      'no-vds-sweep',
      'no-vsb-sweep',
    ]);
  });

  it('names the one value of an axis that is there but not swept', () => {
    const once = generateDemoDevice({
      vds: { min: 0.9, max: 0.9, step: 0.1 },
      vsb: { min: 0.3, max: 0.3, step: 0.1 },
    });
    const w = sweepFindings(once);
    expect(w.map((x) => [x.rule, x.severity])).toEqual([
      ['no-vds-sweep', 'info'],
      ['no-vsb-sweep', 'info'],
    ]);
    expect(w[0].message).toMatch(/no vds sweep/);
    expect(w[0].message).toMatch(/vds = 0\.9/);
    // One drain voltage is one a device can state, so the message excludes only the others.
    expect(w[0].message).toMatch(/any other drain voltage, or connects as a diode/);
    expect(w[0].message).not.toMatch(/no design sheet/);
    // A table taken with the body biased is not a body-grounded table, and is not called one.
    expect(w[1].message).toMatch(/no vsb sweep/);
    expect(w[1].message).toMatch(/vsb = 0\.3/);
    expect(w[1].message).not.toMatch(/vsb = 0(?![.\d])/);
    // Nor does it answer for a sheet that says nothing about the body, which means vsb = 0.
    expect(w[1].message).toMatch(/leaves the body bias out has to state it/);
    const atBody = sweepFindings(generateDemoDevice({ vsb: { min: 0, max: 0, step: 0.1 } }));
    expect(atBody.at(-1)?.message).not.toMatch(/has to state it/);
  });

  it('says what a table with one length, or none, can size', () => {
    const lengthFindings = (t: DeviceTable) => validate(t).filter((w) => w.rule === 'no-l-sweep');
    expect(lengthFindings(generateDemoDevice())).toEqual([]);
    const one = lengthFindings(generateDemoDevice({ lengths: [0.5e-6] }));
    expect(one.map((x) => [x.severity, x.location])).toEqual([['info', 'l']]);
    expect(one[0].message).toMatch(/l = 5e-7\): it plots, and .* at that length only/);
    const none = lengthFindings(
      makeTable([axis('vgs', [0.1, 0.2, 0.3])], { gm: [1e-3, 1e-3, 1e-3] }),
    );
    expect(none.map((x) => x.severity)).toEqual(['info']);
    expect(none[0].message).toMatch(/no l column\): it plots, but no device can be sized from it/);
  });

  it('adds nothing above information severity to a table that lacks the sweeps', () => {
    const bare = validate(generateDemoDevice());
    const swept = validate(generateDemoDevice({ vds: VDS, vsb: VSB }));
    const loud = (ws: readonly { severity: string; rule: string }[]): string[] =>
      ws.filter((w) => w.severity !== 'info').map((w) => w.rule);
    expect(loud(bare)).toEqual(loud(swept));
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

  it('allows flicker noise of exactly 0 where no drain current flows, and nowhere else', () => {
    // A table swept from vds = 0 carries points with id = 0, where a simulator's flicker noise
    // is exactly 0. That is the data, not a defect; thermal noise never reads 0.
    const atZero = makeTable([axis('vgs', [0.1, 0.2, 0.3])], {
      gm: [1e-3, 1e-3, 1e-3],
      id: [0, 2e-3, 3e-3],
      sth: [1e-25, 1e-25, 1e-25],
      sfl: [0, 1e-20, 1e-20],
    });
    expect(validate(atZero).filter((x) => x.rule === 'noise-psd')).toEqual([]);
    // Zero flicker noise where current flows is still an error, as is zero thermal noise at id 0.
    const flowing = makeTable([axis('vgs', [0.1, 0.2, 0.3])], {
      gm: [1e-3, 1e-3, 1e-3],
      id: [0, 2e-3, 3e-3],
      sth: [0, 1e-25, 1e-25],
      sfl: [0, 0, 1e-20],
    });
    expect(
      validate(flowing)
        .filter((x) => x.rule === 'noise-psd')
        .map((x) => x.location),
    ).toEqual(['sth', 'sfl']);
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

  it('flags a thermal-noise column whose γ at full drive no transistor reaches', () => {
    // The demo's sth is 4kT·gm with γ = 1. Scaled by 1e6 — a µ-prefixed export — it reads γ = 1e6
    // at the full-drive point (shortest L, largest vgs and vds, body at the source), which is a
    // unit error and nothing a device does.
    const dev = generateDemoDevice({
      vds: { min: 0, max: 1.2, step: 0.3 },
      vsb: { min: 0, max: 0.6, step: 0.3 },
    });
    expect(validate(dev).filter((x) => x.rule === 'noise-factor')).toEqual([]);
    // Where gm collapses and the channel noise does not — the low-vds triode corner of real data —
    // γ runs far out of any band, and that is the device, not the unit: those points are not read.
    const vds = dev.grid.quantities.get('vds') as Float64Array;
    const sth = dev.grid.quantities.get('sth') as Float64Array;
    const triode = new Map(dev.grid.quantities);
    triode.set(
      'sth',
      sth.map((x, i) => (vds[i] < 0.6 ? x * 1e6 : x)),
    );
    const noisyTriode = { ...dev, grid: makeGrid([...dev.grid.axes], triode) };
    expect(validate(noisyTriode).filter((x) => x.rule === 'noise-factor')).toEqual([]);
    const slipped = validate(scaleQuantities(dev, { sth: 1e6 })).filter(
      (x) => x.rule === 'noise-factor',
    );
    expect(slipped.map((x) => x.severity)).toEqual(['warning']);
    expect(slipped[0].message).toMatch(
      /γ = sth\/\(4kT·gm\) = 1\.00e\+6 at the table's full-drive point \(l = 1\.8e-7, vds = 1\.2, vsb = 0, vgs = 1\.2\)/,
    );
    // Low by the same factor is the same slip.
    expect(validate(scaleQuantities(dev, { sth: 1e-6 })).map((x) => x.rule)).toContain(
      'noise-factor',
    );
    // A signed PMOS export is read at its most negative gate and drain voltages.
    expect(validate(signedMirrorDemo(dev)).filter((x) => x.rule === 'noise-factor')).toEqual([]);
    const pSlip = validate(scaleQuantities(signedMirrorDemo(dev), { sth: 1e6 })).find(
      (x) => x.rule === 'noise-factor',
    );
    expect(pSlip?.message).toMatch(/vds = -1\.2, vsb = 0, vgs = -1\.2/);
  });

  it('names a stored column that shadows a derived quantity, but not a stored gamma', () => {
    // `gamma` is a base quantity the namespace also derives from sth. A stored column of it is the
    // documented input, kept as read by the charts and the sizer alike, so there is no
    // disagreement to name; a stored `ft` is read by charts and re-derived by the sizer.
    const cols = { gm: [1e-3, 2e-3, 3e-3], id: [1e-4, 2e-4, 3e-4], sth: [1e-24, 2e-24, 3e-24] };
    const ownGamma = makeTable([axis('vgs', [0.1, 0.2, 0.3])], {
      ...cols,
      gamma: [1.2, 1.2, 1.2],
    });
    expect(validate(ownGamma).filter((x) => x.rule === 'derived-shadow')).toEqual([]);
    const ownFt = makeTable([axis('vgs', [0.1, 0.2, 0.3])], { ...cols, ft: [1e9, 2e9, 3e9] });
    expect(validate(ownFt).map((x) => x.rule)).toContain('derived-shadow');
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
