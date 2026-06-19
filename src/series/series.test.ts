import { describe, it, expect } from 'vitest';
import {
  familyCurves,
  familyCurvesXY,
  overlayCurvesXY,
  familyUnionCount,
  invertX,
  subsample,
  plottableQuantities,
  fixTable,
} from './index';
import { generateDemoDevice } from '../demo';
import { lookup } from '../lookup';
import { UT } from '../constants';

describe('familyCurves', () => {
  const dev = generateDemoDevice();
  const vgsAxis = dev.grid.axes.find((a) => a.name === 'vgs')!;
  const lAxis = dev.grid.axes.find((a) => a.name === 'l')!;

  it('produces one aligned curve per family value', () => {
    const fc = familyCurves(dev, 'gm/id', 'vgs', 'l');
    expect(fc.lines.length).toBe(lAxis.values.length);
    expect(fc.famValues).toEqual(lAxis.values);
    expect(Array.from(fc.x)).toEqual(Array.from(vgsAxis.values));
    for (const line of fc.lines) expect(line.length).toBe(fc.x.length);
  });

  it('matches a forward lookup at exact grid nodes', () => {
    const fc = familyCurves(dev, 'gm/id', 'vgs', 'l');
    const k = 1;
    const i = 30;
    const L = fc.famValues[k];
    const expected = lookup(dev, { l: L, vgs: fc.x[i] }, ['gm_id']).gm_id;
    expect(fc.lines[k][i]).toBeCloseTo(expected, 9);
  });

  it('is physical: gm/ID is high in weak inversion, below the 1/U_T ceiling', () => {
    const fc = familyCurves(dev, 'gm/id', 'vgs', 'l');
    for (const line of fc.lines) {
      let max = -Infinity;
      for (const v of line) if (v > max) max = v;
      expect(max).toBeLessThan(1 / UT); // hard physical ceiling
      expect(max).toBeGreaterThan(15); // demo lands ~ 1/(n·U_T)
      expect(line[0]).toBeGreaterThan(line[line.length - 1]); // falls into strong inversion
    }
  });

  it('honors the fixed param for extra axes (a vds slider)', () => {
    const dev3 = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.1 } });
    const i = 90; // strong inversion
    const lo = familyCurves(dev3, 'id', 'vgs', 'l', { vds: 0.3 });
    const hi = familyCurves(dev3, 'id', 'vgs', 'l', { vds: 1.2 });
    expect(hi.lines[0][i]).toBeGreaterThan(lo.lines[0][i]); // id rises with vds (CLM)

    // gm/id is vds-independent: identical at both slider positions.
    const gmidLo = familyCurves(dev3, 'gm/id', 'vgs', 'l', { vds: 0.3 });
    const gmidHi = familyCurves(dev3, 'gm/id', 'vgs', 'l', { vds: 1.2 });
    expect(gmidHi.lines[0][i]).toBeCloseTo(gmidLo.lines[0][i], 12);

    // Default (no fixed) pins extra axes at their first node (== fixing vds=0.3).
    const def = familyCurves(dev3, 'id', 'vgs', 'l');
    expect(def.lines[0][i]).toBeCloseTo(lo.lines[0][i], 18);
  });

  it('plottableQuantities reflects the per-curve slice namespace', () => {
    // Strip the demo's noise columns so this still tests the constant-doesn't-leak
    // and measured-noise-needs-PSD semantics (the demo now ships sth/sfl/gamma).
    const full = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.3 } });
    const q = new Map(full.grid.quantities);
    for (const k of ['sth', 'sfl', 'gamma']) q.delete(k);
    const dev3 = { ...full, grid: { ...full.grid, quantities: q } };
    const { base, derived } = plottableQuantities(dev3.grid, 'vgs');
    // X axis is plottable; axes collapsed by the slice (l, vds) are not, nor is
    // an absent column (w).
    expect(base).toContain('vgs');
    expect(base).toContain('id');
    expect(base).not.toContain('l');
    expect(base).not.toContain('vds');
    expect(base).not.toContain('w');
    // `gamma` is a CONSTANT as well as a base-quantity slot; a constant must NOT
    // leak in as a flat plottable "quantity" when no gamma column is stored.
    expect(base).not.toContain('gamma');
    // Derived expressible from present columns are offered; those needing absent
    // columns (id_w⇐w, gm_cgd⇐cgd) are not.
    expect(derived).toContain('gm_id');
    expect(derived).toContain('ft');
    expect(derived).not.toContain('id_w');
    expect(derived).not.toContain('gm_cgd');
    // The γ-model thermal noise needs only gm, so it is always offered; the
    // MEASURED noise needs a stored `sth` PSD (absent here), so it is not.
    expect(derived).toContain('vnth_m');
    expect(derived).not.toContain('vnth');
  });

  it('famName=null yields a single curve over X with the other axes fixed', () => {
    const dev3 = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.3 } }); // l, vds, vgs
    const fc = familyCurves(dev3, 'gm/id', 'vgs', null, { vds: 0.6 });
    expect(fc.lines).toHaveLength(1);
    expect(fc.famName).toBe('');
    expect(fc.famValues.length).toBe(0);
    expect(fc.lines[0].length).toBe(fc.x.length);
    // The single curve sits at l = first node, vds = 0.6.
    const i = 70;
    const L = dev3.grid.axes.find((a) => a.name === 'l')!.values[0];
    const expected = lookup(dev3, { l: L, vds: 0.6, vgs: fc.x[i] }, ['gm_id']).gm_id;
    expect(fc.lines[0][i]).toBeCloseTo(expected, 9);
  });

  it('fixTable collapses an axis into a lower-D table, keeping id + meta', () => {
    const dev3 = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.3 } }); // l, vds, vgs
    const t = fixTable(dev3, { vds: 0.6 });
    expect(t.grid.axes.map((a) => a.name)).toEqual(['l', 'vgs']); // vds collapsed
    expect(t.id).toBe(dev3.id);
    expect(t.meta.W).toBe(dev3.meta.W);
    // values match the original table interpolated at vds = 0.6.
    const i = 60;
    const L = t.grid.axes[0].values[0];
    expect(lookup(t, { l: L, vgs: t.grid.axes[1].values[i] }, ['gm_id']).gm_id).toBeCloseTo(
      lookup(dev3, { l: L, vds: 0.6, vgs: t.grid.axes[1].values[i] }, ['gm_id']).gm_id,
      9,
    );
  });

  it('throws on a missing axis, identical x/family axes, or an invalid expression', () => {
    expect(() => familyCurves(dev, 'gm/id', 'vds', 'l')).toThrow(/no "vds" axis/);
    expect(() => familyCurves(dev, 'gm/id', 'vgs', 'vgs')).toThrow(/must differ/);
    expect(() => familyCurves(dev, 'gm/(')).toThrow();
  });
});

describe('familyCurvesXY (X as an expression, parametric in a sweep)', () => {
  const dev = generateDemoDevice(); // l, vgs
  const lAxis = dev.grid.axes.find((a) => a.name === 'l')!;

  it('X=gm/ID family=l: shared ascending lattice, distinct curves, id/w via meta.W', () => {
    const fc = familyCurvesXY(dev, 'gm/id', 'id/w', 'vgs', 'l');
    expect(fc.degenerate).toBe(false);
    expect(fc.famName).toBe('l');
    expect(fc.xLabel).toBe('gm/id');
    expect(fc.lines.length).toBe(lAxis.values.length);
    for (let j = 1; j < fc.x.length; j++) expect(fc.x[j]).toBeGreaterThan(fc.x[j - 1]); // ascending
    for (const line of fc.lines) expect(line.length).toBe(fc.x.length);
    // id/w differs per L (specific current ∝ W/L) — the curves are not collapsed.
    const mid = fc.x.length >> 1;
    expect(fc.lines[0][mid]).not.toBeCloseTo(fc.lines[fc.lines.length - 1][mid], 6);
  });

  it('degenerate when X is ~constant along the sweep (gm/ID vs a vds sweep)', () => {
    const dev3 = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.1 } });
    const fc = familyCurvesXY(dev3, 'gm/id', 'id', 'vds', 'l');
    expect(fc.degenerate).toBe(true);
    expect(fc.reason).toMatch(/constant|monoton/i);
  });

  it('warns (non-fatally) when X is nearly constant along the sweep', () => {
    const dev3 = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.1 } });
    // Sweep L (gm/ID barely depends on length at a fixed bias) → near-constant X.
    const fc = familyCurvesXY(dev3, 'gm/id', 'ft', 'l', 'vds');
    expect(fc.degenerate).toBe(false); // still drawable
    expect(fc.warning).toMatch(/nearly constant|varies only/i);
    expect(fc.lines.length).toBeGreaterThan(0);
    // A proper VGS sweep spans weak→strong inversion → no warning.
    expect(familyCurvesXY(dev, 'gm/id', 'ft', 'vgs', 'l').warning).toBe('');
  });

  it('identity: X = the sweep axis reproduces familyCurves within float tolerance', () => {
    const fc = familyCurvesXY(dev, 'vgs', 'gm/id', 'vgs', 'l');
    const ref = familyCurves(dev, 'gm/id', 'vgs', 'l');
    expect(fc.degenerate).toBe(false);
    expect(fc.x.length).toBe(ref.x.length);
    for (let j = 0; j < ref.x.length; j++) expect(fc.x[j]).toBeCloseTo(ref.x[j], 12);
    for (let k = 0; k < ref.lines.length; k++)
      for (let j = 0; j < ref.x.length; j++) expect(fc.lines[k][j]).toBeCloseTo(ref.lines[k][j], 9);
  });

  it('resamples Y onto the shared lattice by linear interpolation, NaN outside range', () => {
    const fc = familyCurvesXY(dev, 'gm/id', 'ft', 'vgs', 'l');
    const natX = familyCurves(dev, 'gm/id', 'vgs', 'l'); // native gm/id along vgs
    const natY = familyCurves(dev, 'ft', 'vgs', 'l'); // native ft along vgs
    const k = 1;
    const pairs = Array.from(natX.lines[k], (x, i) => [x, natY.lines[k][i]] as [number, number])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
      .sort((a, b) => a[0] - b[0]);
    const lo = pairs[0][0];
    const hi = pairs[pairs.length - 1][0];
    // a lattice point strictly inside curve k's native range → linear interpolant
    const j = fc.x.findIndex((g) => g > lo && g < hi);
    const g = fc.x[j];
    let b = 1;
    while (pairs[b][0] < g) b++;
    const [x0, y0] = pairs[b - 1];
    const [x1, y1] = pairs[b];
    expect(fc.lines[k][j]).toBeCloseTo(y0 + ((y1 - y0) * (g - x0)) / (x1 - x0), 9);
    // a lattice point below curve k's native range is a NaN gap (never extrapolated)
    const out = fc.x.findIndex((gg) => gg < lo);
    if (out >= 0) expect(Number.isNaN(fc.lines[k][out])).toBe(true);
  });

  it('curves sharing an X range have no spurious float-boundary gaps', () => {
    const dev3 = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.1 } });
    // gm/ID is vds-independent, so every vds curve shares the same gm/ID range; none may
    // drop its first/last lattice point to a 1-ULP rounding mismatch at the boundary.
    const fc = familyCurvesXY(dev3, 'gm/id', 'ft', 'vgs', 'vds');
    for (const ln of fc.lines) {
      expect(Number.isFinite(ln[0]), 'leading gap').toBe(true);
      expect(Number.isFinite(ln[ln.length - 1]), 'trailing gap').toBe(true);
    }
  });

  it('famName=null yields a single resampled curve', () => {
    const fc = familyCurvesXY(dev, 'gm/id', 'ft', 'vgs', null);
    expect(fc.lines).toHaveLength(1);
    expect(fc.famName).toBe('');
    expect(fc.famValues.length).toBe(0);
    expect(fc.degenerate).toBe(false);
  });

  it('plottableQuantities advertises id_w only when the width scalar is supplied', () => {
    expect(plottableQuantities(dev.grid, 'vgs').derived).not.toContain('id_w');
    const pqw = plottableQuantities(dev.grid, 'vgs', ['w']);
    expect(pqw.derived).toContain('id_w');
    expect(pqw.base).not.toContain('w'); // a scalar enables a derived but is not a flat line
  });

  it('throws on a missing sweep axis or sweep == family', () => {
    expect(() => familyCurvesXY(dev, 'gm/id', 'ft', 'nope')).toThrow(/no "nope" sweep axis/);
    expect(() => familyCurvesXY(dev, 'gm/id', 'ft', 'vgs', 'vgs')).toThrow(/must differ/);
  });

  it('subsample thins a dense family, honoring evenly-spaced fill + always-include', () => {
    const f = Float64Array.from({ length: 101 }, (_, i) => i / 100); // 0..1 step .01
    expect(subsample(f, 5, [])).toEqual([0, 25, 50, 75, 100]); // endpoints + even fill
    expect(subsample(f, 5, [0.5])).toEqual([0, 25, 50, 75, 100]); // 0.5 already a fill node
    expect(subsample(f, 4, [0.53])).toEqual([0, 33, 53, 67]); // include snaps to 53, 100 dropped
    expect(subsample(f, 2, [0.5])).toEqual([0, 50]);
    expect(subsample(f, 200, []).length).toBe(101); // count ≥ length keeps all
    expect(subsample(new Float64Array(0), 5)).toEqual([]);
    // includes beyond count are honored (3 forced > count 2)
    expect(subsample(f, 2, [0, 0.5, 1])).toEqual([0, 50, 100]);
    // count 1 must not divide by zero → a single valid index, never [NaN] (untrusted save)
    expect(subsample(f, 1, [])).toEqual([0]);
    expect(subsample(f, 1, [0.5])).toEqual([50]);
    expect(subsample(f, 1).every(Number.isInteger)).toBe(true);
  });

  it('invertX recovers the sweep coordinate where X hits a value (gm/ID → vgs)', () => {
    const L = lAxis.values[0];
    const vgsNode = dev.grid.axes.find((a) => a.name === 'vgs')!.values[40];
    const gmid = lookup(dev, { l: L, vgs: vgsNode }, ['gm_id']).gm_id;
    expect(invertX(dev, 'gm/id', gmid, 'vgs', { l: L })).toBeCloseTo(vgsNode, 6);
    // Out of range → null (never extrapolates).
    expect(invertX(dev, 'gm/id', 1e6, 'vgs', { l: L })).toBeNull();
  });
});

describe('overlayCurvesXY (several devices on one shared X lattice)', () => {
  const dev = generateDemoDevice(); // l = [0.18, 0.5, 1, 2]µm, vgs 0..1.2

  it('single table is identical to familyCurvesXY (no second resample)', () => {
    const fc = familyCurvesXY(dev, 'gm/id', 'id/w', 'vgs', 'l');
    const ov = overlayCurvesXY([dev], 'gm/id', 'id/w', 'vgs', 'l');
    // Exact (not close) — a double-resample would perturb the last ULP.
    expect(Array.from(ov.x)).toEqual(Array.from(fc.x));
    expect(ov.lines.length).toBe(fc.lines.length);
    for (let k = 0; k < fc.lines.length; k++)
      expect(Array.from(ov.lines[k])).toEqual(Array.from(fc.lines[k])); // NaN gaps preserved too
    expect(Array.from(ov.famValues)).toEqual(Array.from(fc.famValues));
    expect(ov.meta.map((m) => m.tableIndex)).toEqual(Array.from(fc.famValues, () => 0));
    expect(ov.meta.map((m) => m.famValue)).toEqual(Array.from(fc.famValues));
    expect(ov.notes).toEqual([null]);
  });

  it('single table with no family is one curve tagged famValue NaN', () => {
    const ov = overlayCurvesXY([dev], 'gm/id', 'ft', 'vgs', null);
    expect(ov.lines).toHaveLength(1);
    expect(ov.famName).toBe('');
    expect(ov.meta).toEqual([{ tableIndex: 0, famValue: NaN }]);
  });

  it('two tables share a union lattice and union family-value set', () => {
    const a = generateDemoDevice({ lengths: [0.1e-6, 0.5e-6] });
    const b = generateDemoDevice({ lengths: [0.2e-6, 1e-6] });
    const ov = overlayCurvesXY([a, b], 'gm/id', 'id/w', 'vgs', 'l');
    for (let j = 1; j < ov.x.length; j++) expect(ov.x[j]).toBeGreaterThan(ov.x[j - 1]); // ascending
    expect(ov.lines.length).toBe(4); // 2 L values per table
    expect(ov.meta.map((m) => m.tableIndex)).toEqual([0, 0, 1, 1]); // table-major
    // famValues is the sorted union of both tables' L sets.
    expect(Array.from(ov.famValues)).toEqual([0.1e-6, 0.2e-6, 0.5e-6, 1e-6]);
    expect(ov.notes).toEqual([null, null]);
    for (const ln of ov.lines) expect(ln.length).toBe(ov.x.length);
  });

  it('a narrower table keeps NaN gaps outside its native range; union spans both', () => {
    const wide = generateDemoDevice({ vgs: { min: 0.0, max: 1.2, step: 0.01 }, lengths: [0.5e-6] });
    const narrow = generateDemoDevice({ vgs: { min: 0.4, max: 0.8, step: 0.01 }, lengths: [0.5e-6] });
    const fcW = familyCurvesXY(wide, 'gm/id', 'ft', 'vgs', 'l');
    const ov = overlayCurvesXY([wide, narrow], 'gm/id', 'ft', 'vgs', 'l');
    // Union X spans at least the wider table's full range.
    expect(ov.x[0]).toBeLessThanOrEqual(fcW.x[0] + 1e-12);
    expect(ov.x[ov.x.length - 1]).toBeGreaterThanOrEqual(fcW.x[fcW.x.length - 1] - 1e-12);
    const narrowLine = ov.lines[ov.meta.findIndex((m) => m.tableIndex === 1)];
    expect(narrowLine.some((v) => Number.isFinite(v))).toBe(true); // finite where it overlaps
    expect(narrowLine.some((v) => Number.isNaN(v))).toBe(true); // gap where the wide table extends past it
  });

  it('isolates a failing table to notes[t] without dropping the others', () => {
    const a = generateDemoDevice({ lengths: [0.5e-6] });
    const bRaw = generateDemoDevice({ lengths: [0.5e-6] });
    const b = { ...bRaw, meta: { ...bRaw.meta, W: undefined } }; // no width ⇒ X = id/w can't resolve
    const ov = overlayCurvesXY([a, b], 'id/w', 'gm/id', 'vgs', 'l');
    expect(ov.notes[0]).toBeNull();
    expect(ov.notes[1]).toBeTruthy(); // throw or degenerate — either way, isolated
    expect(ov.meta.every((m) => m.tableIndex === 0)).toBe(true); // only the good table drew
    for (const ln of ov.lines) expect(ln.some(Number.isFinite)).toBe(true);
  });

  it('familyUnionCount unions the family-axis values across tables (cheap dense-overlay gate)', () => {
    const a = generateDemoDevice({ lengths: [0.1e-6, 0.5e-6] });
    const b = generateDemoDevice({ lengths: [0.2e-6, 0.5e-6] }); // 0.5µm shared
    expect(familyUnionCount([a, b], 'l')).toBe(3); // {0.1, 0.2, 0.5}µm
    expect(familyUnionCount([a], 'l')).toBe(2);
    expect(familyUnionCount([a, b], '')).toBe(0); // no family axis requested
    expect(familyUnionCount([a], 'vds')).toBe(0); // axis absent on the table
  });

  it('all tables failing returns empty curves with notes, never throws', () => {
    // gm/ID against a vds sweep is degenerate (vds-independent) for both tables.
    const a = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.1 }, lengths: [0.5e-6] });
    const b = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.1 }, lengths: [1e-6] });
    const ov = overlayCurvesXY([a, b], 'gm/id', 'id', 'vds', 'l');
    expect(ov.lines).toEqual([]);
    expect(ov.notes).toHaveLength(2);
    expect(ov.notes.every((n) => typeof n === 'string')).toBe(true);
  });
});
