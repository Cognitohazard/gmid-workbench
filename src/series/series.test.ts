import { describe, it, expect } from 'vitest';
import { familyCurves, plottableQuantities } from './index';
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
    // Derived expressible from present columns are offered; those needing absent
    // columns (id_w⇐w, gm_cgd⇐cgd) are not.
    expect(derived).toContain('gm_id');
    expect(derived).toContain('ft');
    expect(derived).not.toContain('id_w');
    expect(derived).not.toContain('gm_cgd');
  });

  it('throws on a missing axis, identical x/family axes, or an invalid expression', () => {
    expect(() => familyCurves(dev, 'gm/id', 'vds', 'l')).toThrow(/no "vds" axis/);
    expect(() => familyCurves(dev, 'gm/id', 'vgs', 'vgs')).toThrow(/must differ/);
    expect(() => familyCurves(dev, 'gm/(')).toThrow();
  });
});
