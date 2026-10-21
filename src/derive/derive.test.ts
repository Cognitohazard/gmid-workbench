import { describe, it, expect } from 'vitest';
import {
  derive,
  deriveColumn,
  compileExpr,
  evalColumn,
  tableScope,
  metaScalars,
  noiseSource,
  noiseSourceLabel,
  noiseLabel,
  fallbackSentences,
  derivedFallbacks,
  derivedForm,
  fallbackMessage,
} from './index';
import type { Axis, Grid } from '../types';
import { BASE_QUANTITIES, DERIVED_QUANTITIES } from '../namespace';
import { BODY_FACTOR, generateDemoDevice, scaleQuantities, withoutColumns } from '../demo';
import { makeGrid } from '../grid';
import { GAMMA_DEFAULT, PHYS, UT } from '../constants';

function col(grid: Grid, key: string): Float64Array {
  const c = grid.quantities.get(key);
  if (!c) throw new Error(`missing column ${key}`);
  return c;
}

describe('tableScope', () => {
  it('resolves stored quantities to full columns', () => {
    const { grid } = generateDemoDevice();
    const scope = tableScope(grid);
    const size = grid.shape[0] * grid.shape[1];

    for (const key of ['id', 'gm', 'gds', 'cgg', 'vth', 'vdsat']) {
      const v = scope.resolve(key);
      expect(v).toBeInstanceOf(Float64Array);
      expect((v as Float64Array).length).toBe(size);
    }
  });

  it('resolves materialized axis columns from a real makeGrid grid', () => {
    // makeGrid materializes each axis as a same-named full-length column.
    const axes: Axis[] = [
      { name: 'l', values: Float64Array.from([1e-6, 2e-6]) },
      { name: 'vgs', values: Float64Array.from([0, 0.5, 1.0]) },
    ];
    const id = Float64Array.from([1, 2, 3, 4, 5, 6]);
    const grid = makeGrid(axes, new Map([['id', id]]));
    const scope = tableScope(grid);
    const size = 6;

    for (const ax of ['l', 'vgs', 'id']) {
      const v = scope.resolve(ax);
      expect(v).toBeInstanceOf(Float64Array);
      expect((v as Float64Array).length).toBe(size);
    }
    // l varies slowest: [1,1,1, 2,2,2] over the 2×3 grid.
    expect(Array.from(scope.resolve('l') as Float64Array)).toEqual([
      1e-6, 1e-6, 1e-6, 2e-6, 2e-6, 2e-6,
    ]);
  });

  it('returns undefined for unknown names', () => {
    const { grid } = generateDemoDevice();
    expect(tableScope(grid).resolve('does_not_exist')).toBeUndefined();
  });

  it('resolves a supplied scalar (current density id/w via width); a stored column wins', () => {
    const axes: Axis[] = [{ name: 'vgs', values: Float64Array.from([0, 0.5, 1]) }];
    const id = Float64Array.from([1, 2, 3]);
    const grid = makeGrid(axes, new Map([['id', id]]));
    // Without a scalar `w` is unresolved; with one, id/w (current density) evaluates.
    expect(tableScope(grid).resolve('w')).toBeUndefined();
    expect(Array.from(evalColumn(grid, compileExpr('id/w'), { w: 2 }))).toEqual([0.5, 1, 1.5]);
    // A stored `w` column shadows the scalar (data always wins).
    const grid2 = makeGrid(
      axes,
      new Map([
        ['id', id],
        ['w', Float64Array.from([10, 10, 10])],
      ]),
    );
    expect(Array.from(evalColumn(grid2, compileExpr('id/w'), { w: 2 }))).toEqual([0.1, 0.2, 0.3]);
  });

  it('metaScalars exposes characterization width W as w (and only when finite)', () => {
    expect(metaScalars({ W: 5e-6 } as never)).toEqual({ w: 5e-6 });
    expect(metaScalars({} as never)).toEqual({});
    expect(metaScalars({ W: Number.NaN } as never)).toEqual({});
  });

  it('resolves derived quantity names by evaluating their definition', () => {
    const { grid } = generateDemoDevice();
    const scope = tableScope(grid);
    const gm = col(grid, 'gm');
    const id = col(grid, 'id');
    const ft = scope.resolve('ft') as Float64Array; // gm/(2*pi*cgg)
    const cgg = col(grid, 'cgg');
    expect(ft).toBeInstanceOf(Float64Array);
    expect(ft[10]).toBeCloseTo(gm[10] / (2 * Math.PI * cgg[10]), 18);
    // usable inside a larger expression, not just as a bare lookup
    const expr = deriveColumn(grid, 'gm_id * 2'); // gm_id is a derived name
    expect(expr[10]).toBeCloseTo((gm[10] / id[10]) * 2, 12);
  });
});

describe('derive', () => {
  it('gm_id equals elementwise gm/id', () => {
    const table = generateDemoDevice();
    const out = derive(table, 'gm_id');
    const gm = col(table.grid, 'gm');
    const id = col(table.grid, 'id');

    expect(out).toBeInstanceOf(Float64Array);
    expect(out.length).toBe(gm.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(gm[i] / id[i], 12);
    }
  });

  it('vstar equals 2*id/gm', () => {
    const table = generateDemoDevice();
    const out = derive(table, 'vstar');
    const gm = col(table.grid, 'gm');
    const id = col(table.grid, 'id');

    expect(out.length).toBe(gm.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo((2 * id[i]) / gm[i], 12);
    }
  });

  it('av0 equals gm/gds', () => {
    const table = generateDemoDevice();
    const out = derive(table, 'av0');
    const gm = col(table.grid, 'gm');
    const gds = col(table.grid, 'gds');
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(gm[i] / gds[i], 6);
    }
  });

  it('throws on an unknown derived key', () => {
    const table = generateDemoDevice();
    expect(() => derive(table, 'not_a_quantity')).toThrow(/unknown derived quantity/);
  });
});

describe('deriveColumn', () => {
  it('matches a manual elementwise gm*gds', () => {
    const { grid } = generateDemoDevice();
    const out = deriveColumn(grid, 'gm*gds');
    const gm = col(grid, 'gm');
    const gds = col(grid, 'gds');

    expect(out).toBeInstanceOf(Float64Array);
    expect(out.length).toBe(gm.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(gm[i] * gds[i], 18);
    }
  });

  it('broadcasts a scalar expression into a full-length column', () => {
    const { grid } = generateDemoDevice();
    const size = grid.shape[0] * grid.shape[1];
    const out = deriveColumn(grid, '2*pi');
    expect(out.length).toBe(size);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(2 * Math.PI, 12);
    }
  });

  it('resolves constants (UT) alongside grid columns', () => {
    const { grid } = generateDemoDevice();
    const out = deriveColumn(grid, 'gm/id * UT');
    const gm = col(grid, 'gm');
    const id = col(grid, 'id');
    expect(out.length).toBe(gm.length);
    expect(out[10]).toBeCloseTo((gm[10] / id[10]) * UT, 12);
  });

  it('compileExpr + evalColumn evaluate a precompiled expression (compile once)', () => {
    const { grid } = generateDemoDevice();
    const compiled = compileExpr('gm/id');
    const out = evalColumn(grid, compiled);
    const gm = col(grid, 'gm');
    const id = col(grid, 'id');
    expect(out.length).toBe(gm.length);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(gm[i] / id[i], 12);
    // same compiled expr reused over another grid yields that grid's column
    const dev2 = generateDemoDevice({ W: 5e-6 });
    expect(evalColumn(dev2.grid, compiled).length).toBe(dev2.grid.shape[0] * dev2.grid.shape[1]);
  });
});

describe('metaScalars temperature', () => {
  it('exposes T/UT from meta.temp so the γ-model noise tracks the table temperature', () => {
    const dev = generateDemoDevice();
    const hot = { ...dev, meta: { ...dev.meta, temp: 125 } };
    const base = derive(dev, 'svth_m');
    const hotCol = derive(hot, 'svth_m');
    // svth_m = 4kTγ·(gm + gmb)/gm² is linear in T at a fixed point.
    expect(hotCol[10] / base[10]).toBeCloseTo((125 + 273.15) / PHYS.T, 12);
  });

  it('emits T/UT only when meta carries a finite temp', () => {
    expect(metaScalars({})).not.toHaveProperty('T');
    const s = metaScalars({ temp: 125 });
    expect(s.T).toBeCloseTo(398.15, 12);
    expect(s.UT).toBeCloseTo((PHYS.k * 398.15) / PHYS.q, 18);
  });
});

describe('γ from the table where it carries thermal noise, the default where it does not', () => {
  // The demo stores a `gamma` column and an `sth` made from it; the cases below take one or both
  // away, and double `sth`, so a γ read from the data cannot pass for the default. The demo's gmb
  // is exactly BODY_FACTOR·gm, and its sth = 4kTγ·(gm + gmb).
  const dev = generateDemoDevice();
  const measured = scaleQuantities(withoutColumns(dev, ['gamma']), { sth: 2 });
  const bare = withoutColumns(dev, ['gamma', 'sth']);
  const k4T = 4 * PHYS.k * PHYS.T; // the demo is characterized at 27 °C

  it('reads γ = sth/(4kT·(gm + gmb)) off a table that carries sth, and every γ-model key follows', () => {
    const gamma = derive(measured, 'gamma');
    const sth = col(measured.grid, 'sth');
    const gm = col(measured.grid, 'gm');
    const gmb = col(measured.grid, 'gmb');
    for (const i of [10, 60, 110]) {
      expect(gamma[i]).toBeCloseTo(sth[i] / (k4T * (gm[i] + gmb[i])), 12);
      expect(gamma[i]).toBeCloseTo(2 * GAMMA_DEFAULT, 12);
    }
    // The estimate keys are then the measured ones, point for point.
    const vnthM = derive(measured, 'vnth_m');
    const vnth = derive(measured, 'vnth');
    const svthM = derive(measured, 'svth_m');
    const svth = derive(measured, 'svth');
    for (const i of [10, 60, 110]) {
      expect(vnthM[i] / vnth[i]).toBeCloseTo(1, 12);
      expect(svthM[i] / svth[i]).toBeCloseTo(1, 12);
    }
    // At another temperature the same stored noise is the same noise: kT cancels.
    const hot = { ...measured, meta: { ...measured.meta, temp: 125 } };
    expect(derive(hot, 'vnth_m')[60] / vnthM[60]).toBeCloseTo(1, 12);
    expect(derive(hot, 'gamma')[60] / gamma[60]).toBeCloseTo(PHYS.T / (125 + 273.15), 12);
    // Every quantity is read by its definition here, so the table owes no note.
    expect(derivedFallbacks(measured.grid, metaScalars(measured.meta))).toEqual([]);
  });

  it('counts the body effect in the γ-model: Sid = 4kTγ·(gm + gmb)', () => {
    const vnthM = derive(bare, 'vnth_m');
    const svthM = derive(bare, 'svth_m');
    const gm = col(bare.grid, 'gm');
    const gmb = col(bare.grid, 'gmb');
    for (const i of [10, 60, 110]) {
      expect(vnthM[i]).toBeCloseTo(Math.sqrt(k4T * GAMMA_DEFAULT * (gm[i] + gmb[i])) / gm[i], 18);
      expect(svthM[i] / vnthM[i] ** 2).toBeCloseTo(1, 12);
      // (1 + BODY_FACTOR) above the γ·gm form, in power.
      expect(svthM[i] / ((k4T * GAMMA_DEFAULT) / gm[i])).toBeCloseTo(1 + BODY_FACTOR, 12);
    }
  });

  it('falls back to GAMMA_DEFAULT on a table without sth, and says so', () => {
    const gamma = derive(bare, 'gamma');
    expect(new Set(gamma)).toEqual(new Set([GAMMA_DEFAULT]));
    // Any expression reading the name gets the same value.
    expect(deriveColumn(bare.grid, 'gamma*2')[60]).toBe(2 * GAMMA_DEFAULT);
    // A quantity with no fallback still needs its column.
    expect(() => derive(bare, 'vnth')).toThrow();
    expect(derivedFallbacks(bare.grid)).toEqual([
      {
        quantity: 'gamma',
        missing: ['sth'],
        form: '1.0',
        says: 'γ is the stand-in 1.0, not the table’s own noise',
      },
    ]);
  });

  it('drops the body-effect term without a gmb column, and every result says which forms it used', () => {
    // Without gmb, γ read back from sth carries the body factor, and the γ-model keys leave the
    // term out: the two cancel, so on a table that stores sth the figures are still its own noise.
    const noGmb = withoutColumns(measured, ['gmb']);
    const gm = col(noGmb.grid, 'gm');
    const gmb = col(measured.grid, 'gmb');
    const gamma = derive(noGmb, 'gamma');
    const vnthM = derive(noGmb, 'vnth_m');
    const vnth = derive(noGmb, 'vnth');
    for (const i of [10, 60, 110]) {
      expect(gamma[i]).toBeCloseTo(2 * GAMMA_DEFAULT * (1 + gmb[i] / gm[i]), 12);
      expect(vnthM[i] / vnth[i]).toBeCloseTo(1, 12);
    }
    const notes = derivedFallbacks(noGmb.grid);
    expect(notes.map((n) => [n.quantity, n.missing, n.form])).toEqual([
      ['gamma', ['gmb'], 'sth/(4*k*T*gm)'],
      ['svth_m', ['gmb'], '4*k*T*gamma/gm'],
      ['vnth_m', ['gmb'], 'sqrt(4*k*T*gamma/gm)'],
    ]);
    expect(fallbackMessage(notes[2])).toBe(
      'vnth_m is read as sqrt(4*k*T*gamma/gm) because the table has no gmb column — the floor ' +
        'has no body-effect term: exact where γ is read back from the stored noise, which then ' +
        'carries it, low by the factor 1 + gmb/gm in power where γ is the stand-in, and for a ' +
        'stored gamma column exact only if the column was built against gm alone',
    );
    // On a table with neither, the estimate is low by the body factor and both notes are owed.
    const neither = withoutColumns(bare, ['gmb']);
    expect(derive(neither, 'vnth_m')[60]).toBeCloseTo(
      Math.sqrt((k4T * GAMMA_DEFAULT) / gm[60]),
      18,
    );
    expect(derivedFallbacks(neither.grid).map((n) => [n.quantity, n.missing])).toEqual([
      ['gamma', ['sth']],
      ['svth_m', ['gmb']],
      ['vnth_m', ['gmb']],
    ]);
    // A stored gamma column is read as stored and owes no note of its own.
    const ownNoGmb = withoutColumns(dev, ['gmb']);
    expect(derivedFallbacks(ownNoGmb.grid).map((n) => n.quantity)).toEqual(['svth_m', 'vnth_m']);
  });

  it('declares every fallback so that it is the form a table lacking exactly its columns uses', () => {
    // A table holding every base quantity except a fallback's `without` columns, and every metadata
    // scalar, picks that fallback: the declaration and the selection agree for every quantity.
    const all = new Set([...BASE_QUANTITIES.map((q) => q.key), 'T', 'UT']);
    for (const q of DERIVED_QUANTITIES) {
      for (const f of q.fallbacks ?? []) {
        const has = (n: string): boolean => all.has(n) && !f.without.includes(n) && n !== q.key;
        expect(derivedForm(q.key, has)?.fallback, `${q.key} without ${f.without}`).toBe(f);
      }
      // With everything present, the definition itself.
      expect(derivedForm(q.key, (n) => all.has(n) && n !== q.key)?.fallback).toBeUndefined();
    }
  });

  it('keeps a stored gamma column ahead of every form', () => {
    const own = scaleQuantities(dev, { gamma: 1.5 });
    expect(derive(own, 'gamma')[60]).toBe(1.5 * GAMMA_DEFAULT);
    expect(tableScope(own.grid).resolve('gamma')).toBe(own.grid.quantities.get('gamma'));
  });

  it('says per table which of the three the noise figures are', () => {
    expect(noiseSource(measured.grid)).toBe('measured');
    expect(noiseSource(bare.grid)).toBe('estimated');
    expect(noiseSource(dev.grid)).toBe('column');
    expect(noiseSourceLabel('measured')).toBe('measured');
    expect(noiseSourceLabel('estimated')).toBe('estimated, γ = 1.0');
    expect(noiseSourceLabel('column')).toBe('γ from the table');
    // The line a panel shows: the source, then the figures each missing column made fall back.
    // The γ stand-in is the `estimated` label itself, so it is not said twice.
    const noGmb = (t: typeof dev) => withoutColumns(t, ['gmb']);
    const line = (t: typeof dev): string =>
      noiseLabel(noiseSource(t.grid), derivedFallbacks(t.grid));
    expect(line(measured)).toBe('measured');
    expect(line(bare)).toBe('estimated, γ = 1.0');
    expect(line(noGmb(measured))).toBe('measured · no gmb column: gamma, svth_m, vnth_m');
    expect(line(noGmb(bare))).toBe('estimated, γ = 1.0 · no gmb column: svth_m, vnth_m');
    expect(line(noGmb(dev))).toBe('γ from the table · no gmb column: svth_m, vnth_m');
    // Every fallback that fired is named there, a noise figure or not: the line is where a sheet's
    // panel says them.
    const other = {
      quantity: 'ft',
      missing: ['cgg'],
      form: 'gm/(2*pi*cgs)',
      says: 'gate charge only',
    };
    expect(noiseLabel('measured', [other])).toBe('measured · no cgg column: ft');
  });

  it('spells the fallbacks out once each, grouped by quantity, over several devices', () => {
    const a = derivedFallbacks(withoutColumns(bare, ['gmb']).grid);
    const b = derivedFallbacks(withoutColumns(measured, ['gmb']).grid);
    // b lists vnth_m and svth_m in the same words as a, and gamma in other words (no gmb).
    expect(fallbackSentences([...b, ...a]).map((m) => m.split(' ')[0])).toEqual([
      'gamma',
      'gamma',
      'svth_m',
      'vnth_m',
    ]);
  });
});
