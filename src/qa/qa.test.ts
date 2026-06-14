import { describe, it, expect } from 'vitest';
import { validate, canonicalizeTable } from './index';
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
    const t = makeTable(
      [axis('l', l), axis('vds', vds), axis('vgs', vgs)],
      { gds: gdsCol, gm: [1, 1, 1], id: [1, 1, 1] },
    );
    const info = validate(t).find((x) => x.rule === 'no-saturation');
    expect(info).toBeDefined();
    expect(info?.severity).toBe('info');
  });

  it('does not emit no-saturation when gds falls', () => {
    const l = [1e-7];
    const vds = [0.1, 0.2, 0.3];
    const vgs = [0.5];
    const gdsCol = [3e-6, 2e-6, 1e-6]; // falls along vds
    const t = makeTable(
      [axis('l', l), axis('vds', vds), axis('vgs', vgs)],
      { gds: gdsCol },
    );
    expect(validate(t).some((x) => x.rule === 'no-saturation')).toBe(false);
  });
});

// --- per-L-slice multi-slice -------------------------------------------------

describe('validate: multi L-slice', () => {
  it('reports vgs-step once per L-slice (axis shared)', () => {
    const l = [1e-7, 2e-7];
    const vgs = [0, 0.05, 0.1];
    const gm = fill(l, vgs, () => 1e-3);
    const id = fill(l, vgs, () => 1e-3);
    const t = makeTable([axis('l', l), axis('vgs', vgs)], { gm, id });
    const steps = validate(t).filter((x) => x.rule === 'vgs-step');
    expect(steps.length).toBe(2);
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
