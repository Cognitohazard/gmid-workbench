import { describe, it, expect } from 'vitest';
import { importMostab } from './index';

const SAMPLE = `# mostab: 0.1
# device: nch_lvt
# corner: tt
# temp: 27
# W: 1e-6
# simulator: ngspice
# AVT: 3.5e-3
L,VGS,ID,GM,GDS,CGG
30e-9,0.3,1.0e-6,1.0e-5,1.0e-7,1.0e-15
30e-9,0.5,2.0e-6,2.0e-5,2.0e-7,2.0e-15
30e-9,0.7,3.0e-6,3.0e-5,3.0e-7,3.0e-15
60e-9,0.3,4.0e-6,4.0e-5,4.0e-7,4.0e-15
60e-9,0.5,5.0e-6,5.0e-5,5.0e-7,5.0e-15
60e-9,0.7,6.0e-6,6.0e-5,6.0e-7,6.0e-15
`;

describe('importMostab', () => {
  it('parses, builds an [l × vgs] grid, and attaches QA warnings', () => {
    const r = importMostab(SAMPLE, { filename: 'nch_lvt.csv' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dataset.tables).toHaveLength(1);
    const t = r.dataset.tables[0];
    expect(t.id.device).toBe('nch_lvt');
    expect(new Set(t.grid.axes.map((a) => a.name))).toEqual(new Set(['l', 'vgs']));
    expect(t.grid.shape.reduce((a, b) => a * b, 1)).toBe(6);
    // The 200mV vgs step (0.3→0.5→0.7) trips the QA step rule.
    expect(r.dataset.warnings.some((w) => w.rule === 'vgs-step')).toBe(true);
  });

  it('returns the parser errors on malformed input', () => {
    const r = importMostab('not,a,table\n1,2,3');
    expect(r.ok).toBe(false);
  });

  it('rejects a parseable table missing a required column (gm / vgs)', () => {
    // Parses fine (axes l,vgs; id present) but no gm column.
    const noGm = importMostab('L,VGS,ID\n30e-9,0.3,1e-6\n30e-9,0.5,2e-6\n');
    expect(noGm.ok).toBe(false);
    if (!noGm.ok) {
      expect(noGm.errors[0].kind).toBe('missing-required');
      expect(noGm.errors[0].message).toContain('gm');
    }
    // l axis present but no vgs column at all.
    const noVgs = importMostab('L,ID,GM\n30e-9,1e-6,1e-5\n60e-9,2e-6,2e-5\n');
    expect(noVgs.ok).toBe(false);
    if (!noVgs.ok) expect(noVgs.errors[0].message).toContain('vgs');
  });

  it('accepts a table that lacks an OPTIONAL axis (single-L: vgs/id/gm, no l)', () => {
    const r = importMostab('VGS,ID,GM\n0.3,1e-6,1e-5\n0.5,2e-6,2e-5\n');
    expect(r.ok).toBe(true); // l is optional; the family chart handles its absence
  });

  // A hand-written signed PMOS dump: negative id/gm/gds/cgg/vth, a signed cross-cap
  // cgd, and a negative-Vgs sweep axis (ascending -0.7 < -0.5 < -0.3).
  const PMOS_BODY = `L,VGS,ID,GM,GDS,CGG,CGD,VTH
1e-8,-0.7,-3e-6,-5e-6,-3e-7,-3e-15,-1e-15,-0.4
1e-8,-0.5,-2e-6,-5e-6,-2e-7,-2e-15,-1e-15,-0.4
1e-8,-0.3,-1e-6,-5e-6,-1e-7,-1e-15,-1e-15,-0.4
`;
  const SIGN_RULES = new Set(['gm-sign', 'gds-sign', 'cap-sign']);

  it('folds a DECLARED signed PMOS dump to magnitude before QA (no sign warnings)', () => {
    const r = importMostab(`# device: pch_lvt\n# polarity: p\n${PMOS_BODY}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.dataset.tables[0];
    const q = t.grid.quantities;

    // Value columns folded to magnitude (positive).
    for (const key of ['id', 'gm', 'gds', 'cgg', 'vth']) {
      const col = q.get(key)!;
      expect([...col].every((x) => x > 0)).toBe(true);
    }
    // The cross-cap cgd is left signed (NOT folded).
    expect([...q.get('cgd')!].every((x) => x < 0)).toBe(true);

    // The vgs sweep axis is untouched: still negative and ascending.
    const vgs = t.grid.axes.find((a) => a.name === 'vgs')!;
    expect([...vgs.values]).toEqual([-0.7, -0.5, -0.3]);

    // Polarity recorded, input no longer signed.
    expect(t.meta.polarity).toEqual({ device: 'p', signedInput: false });

    // Folded before QA, so no sign-rule warnings survive.
    expect(r.dataset.warnings.some((w) => SIGN_RULES.has(w.rule))).toBe(false);
  });

  it('leaves an UNDECLARED signed PMOS dump signed and flags it (regression)', () => {
    const r = importMostab(`# device: pch_lvt\n${PMOS_BODY}`); // no polarity line
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.dataset.tables[0];
    // Not folded: id stays signed (negative).
    expect([...t.grid.quantities.get('id')!].every((x) => x < 0)).toBe(true);
    expect(t.meta.polarity).toBeUndefined();
    // QA carries the sign warnings the declared case suppressed.
    const rules = new Set(r.dataset.warnings.map((w) => w.rule));
    expect(rules.has('gm-sign')).toBe(true);
    expect(rules.has('gds-sign')).toBe(true);
    expect(rules.has('cap-sign')).toBe(true);
  });
});
