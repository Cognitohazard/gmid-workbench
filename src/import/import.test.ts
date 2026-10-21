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

  it('says at import what a file without the bias sweeps can be used for', () => {
    // The file above has no VDS and no VSB column: valid data, so the findings are information.
    const bare = importMostab(SAMPLE);
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    const sweeps = (ws: typeof bare.dataset.warnings): [string, string][] =>
      ws.filter((w) => /^no-\w+-sweep$/.test(w.rule)).map((w) => [w.rule, w.severity]);
    expect(sweeps(bare.dataset.warnings)).toEqual([
      ['no-vds-sweep', 'info'],
      ['no-vsb-sweep', 'info'],
    ]);

    // One drain voltage on every row is a column, not a sweep: the axis is kept with its one
    // value, and the finding names it. A VBS column is a body-bias sweep under its other sign.
    const oneDrain = importMostab(
      'L,VDS,VBS,VGS,ID,GM\n' +
        '1e-7,0.9,0,0.4,1e-6,1e-5\n1e-7,0.9,0,0.41,2e-6,2e-5\n' +
        '1e-7,0.9,-0.3,0.4,1e-6,1e-5\n1e-7,0.9,-0.3,0.41,2e-6,2e-5\n',
    );
    expect(oneDrain.ok).toBe(true);
    if (!oneDrain.ok) return;
    const t = oneDrain.dataset.tables[0];
    expect([...(t.grid.axes.find((a) => a.name === 'vds')?.values ?? [])]).toEqual([0.9]);
    expect([...(t.grid.axes.find((a) => a.name === 'vsb')?.values ?? [])]).toEqual([0, 0.3]);
    // It also holds a single length, which is said the same way.
    expect(sweeps(oneDrain.dataset.warnings)).toEqual([
      ['no-l-sweep', 'info'],
      ['no-vds-sweep', 'info'],
    ]);
    expect(oneDrain.dataset.warnings.find((w) => w.rule === 'no-vds-sweep')?.message).toContain(
      'vds = 0.9',
    );
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

  it('a grid failure does not mask a missing required column (both reported)', () => {
    // No gm column AND a truncated grid (3 rows over a 2x2 l/vgs grid).
    const r = importMostab('L,VGS,ID\n30e-9,0.3,1e-6\n30e-9,0.5,2e-6\n60e-9,0.3,1e-6\n');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.kind)).toContain('incomplete-grid');
      expect(r.errors.map((e) => e.kind)).toContain('missing-required');
      expect(r.errors.find((e) => e.kind === 'missing-required')?.message).toContain('gm');
    }
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

  // ── The wider namespace: each standard operating-point output under its own name ──────────

  // An NMOS export carrying the capacitance matrix's self and cross terms, both junction
  // capacitances under BSIM4's names, a terminal charge, and one output the format does not name.
  const WIDE = `# device: nch_wide
# W: 1e-6
L,VGS,ID,GM,CDD,CDB,CSS,CSB,CBB,CBD,CAPBD,CAPBS,QG,UEFF
1e-7,0.3,1e-6,1e-5,4e-15,1e-16,5e-15,2e-16,6e-15,3e-16,7e-16,8e-16,1e-15,0.04
1e-7,0.4,2e-6,2e-5,4e-15,1e-16,5e-15,2e-16,6e-15,3e-16,7e-16,8e-16,2e-15,0.04
1e-7,0.5,3e-6,3e-5,4e-15,1e-16,5e-15,2e-16,6e-15,3e-16,7e-16,8e-16,3e-15,0.04
`;

  it('names each capacitance, junction capacitance and charge, and carries only the rest', () => {
    const r = importMostab(WIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.dataset.tables[0];
    const q = t.grid.quantities;
    // cdd and css are self-capacitances, cdb and csb cross terms: four columns, four keys. (cdd
    // and css used to be read as cdb and csb, so a file carrying both pairs was refused.)
    expect(q.get('cdd')?.[0]).toBe(4e-15);
    expect(q.get('cdb')?.[0]).toBe(1e-16);
    expect(q.get('css')?.[0]).toBe(5e-15);
    expect(q.get('csb')?.[0]).toBe(2e-16);
    expect(q.get('cbb')?.[0]).toBe(6e-15);
    // cbd is the body–drain transcapacitance; the junction capacitance is cjd (capbd in BSIM4).
    expect(q.get('cbd')?.[0]).toBe(3e-16);
    expect(q.get('cjd')?.[0]).toBe(7e-16);
    expect(q.get('cjs')?.[0]).toBe(8e-16);
    expect(q.get('qg')?.[2]).toBe(3e-15);
    // Only the unnamed column passes through, and the import says so — once, as information.
    expect([...(t.passthrough ?? [])]).toEqual(['ueff']);
    const notes = r.dataset.warnings.filter((w) => w.rule === 'passthrough-columns');
    expect(notes).toHaveLength(1);
    expect(notes[0].severity).toBe('info');
    expect(notes[0].message).toMatch(/not recognized: ueff — kept under its own name/);
    expect(notes[0].message).toMatch(/not rescaled when a device is sized/);
  });

  it('says nothing about pass-through on a file whose every column is named', () => {
    const r = importMostab(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dataset.warnings.some((w) => w.rule === 'passthrough-columns')).toBe(false);
  });

  // A signed PMOS export of the same columns.
  const WIDE_PMOS = `L,VGS,ID,GM,CDD,CBD,CJD,QG
1e-7,-0.5,-3e-6,-3e-5,-4e-15,-3e-16,-7e-16,-3e-15
1e-7,-0.4,-2e-6,-2e-5,-4e-15,-3e-16,-7e-16,-2e-15
1e-7,-0.3,-1e-6,-1e-5,-4e-15,-3e-16,-7e-16,-1e-15
`;

  it('on a declared signed PMOS export, folds the magnitudes and keeps the signed terms', () => {
    const r = importMostab(`# device: pch_wide\n# polarity: p\n${WIDE_PMOS}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.dataset.tables[0].grid.quantities;
    // A self-capacitance and a junction capacitance are magnitudes: folded.
    expect([...q.get('cdd')!].every((x) => x > 0)).toBe(true);
    expect([...q.get('cjd')!].every((x) => x > 0)).toBe(true);
    // A transcapacitance and a terminal charge carry their sign as information: kept.
    expect([...q.get('cbd')!].every((x) => x < 0)).toBe(true);
    expect([...q.get('qg')!].every((x) => x < 0)).toBe(true);
    expect(r.dataset.warnings.some((w) => w.rule === 'cap-sign')).toBe(false);
  });

  it('flags a negative self- or junction capacitance on an undeclared signed export, not a transcapacitance', () => {
    const r = importMostab(`# device: pch_wide\n${WIDE_PMOS}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flagged = r.dataset.warnings.filter((w) => w.rule === 'cap-sign').map((w) => w.location);
    expect(flagged.sort()).toEqual(['cdd', 'cjd']);
  });
});
