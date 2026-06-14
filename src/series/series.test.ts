import { describe, it, expect } from 'vitest';
import { familyCurves, plottableQuantities, fixTable } from './index';
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
    const dev3 = generateDemoDevice({ vds: { min: 0.3, max: 1.2, step: 0.3 } });
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
