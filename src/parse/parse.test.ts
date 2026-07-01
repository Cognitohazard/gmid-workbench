import { describe, it, expect } from 'vitest';
import { parseMostabCsv } from './index';
import type { Dataset } from '../types';

// 2 lengths x 3 vgs = 6 rows. Columns: L, VGS, ID, GM, GDS, CGG, plus an unknown
// passthrough column "foo". Row-major over (l slowest, vgs fastest).
const CSV = `# device: nch_lvt
# corner: ss
# temp: 27
# W: 1e-6
# simulator: ngspice
# avt: 3.5e-3
# abeta: 1.2e-8
# mostab version: 9.9
L,VGS,ID,GM,GDS,CGG,foo
30e-9,0.3,1.0e-6,1.0e-5,1.0e-7,1.0e-15,11
30e-9,0.5,2.0e-6,2.0e-5,2.0e-7,2.0e-15,12
30e-9,0.7,3.0e-6,3.0e-5,3.0e-7,3.0e-15,13
60e-9,0.3,4.0e-6,4.0e-5,4.0e-7,4.0e-15,14
60e-9,0.5,5.0e-6,5.0e-5,5.0e-7,5.0e-15,15
60e-9,0.7,6.0e-6,6.0e-5,6.0e-7,6.0e-15,16
`;

function expectOk(res: ReturnType<typeof parseMostabCsv>): Dataset {
  if (!res.ok) throw new Error('expected ok=true, got: ' + JSON.stringify(res.errors));
  return res.dataset;
}

describe('parseMostabCsv', () => {
  it('parses a small mostab CSV onto a 2x3 grid', () => {
    const ds = expectOk(parseMostabCsv(CSV));
    expect(ds.tables).toHaveLength(1);
    const t = ds.tables[0];

    // identity from metadata
    expect(t.id.device).toBe('nch_lvt');
    expect(t.id.corner).toBe('ss');
    expect(t.id.temp).toBe(27);

    // grid shape: l (2) x vgs (3)
    expect(t.grid.shape).toEqual([2, 3]);
    expect(t.grid.axes.map((a) => a.name)).toEqual(['l', 'vgs']);
    expect([...t.grid.axes[0].values]).toEqual([30e-9, 60e-9]);
    expect([...t.grid.axes[1].values]).toEqual([0.3, 0.5, 0.7]);

    // a quantity value: id at (l=60e-9 idx1, vgs=0.5 idx1) -> flat 1*3+1 = 4 -> 5.0e-6
    const id = t.grid.quantities.get('id')!;
    expect(id).toBeInstanceOf(Float64Array);
    expect(id).toHaveLength(6);
    expect(id[4]).toBeCloseTo(5.0e-6, 18);
    // gm at flat 0 (l idx0, vgs idx0)
    expect(t.grid.quantities.get('gm')![0]).toBeCloseTo(1.0e-5, 18);
    // gds and cgg present
    expect(t.grid.quantities.has('gds')).toBe(true);
    expect(t.grid.quantities.has('cgg')).toBe(true);

    // metadata W carried through
    expect(t.meta.W).toBe(1e-6);
    expect(t.meta.AVT).toBe(3.5e-3);
    expect(t.meta.ABETA).toBe(1.2e-8);
    expect(t.meta.simulator).toBe('ngspice');

    // unknown column landed in passthrough (and as a quantity column)
    expect(t.passthrough).toBeDefined();
    expect(t.passthrough!.has('foo')).toBe(true);
    expect(t.grid.quantities.has('foo')).toBe(true);
    expect(t.grid.quantities.get('foo')![5]).toBe(16);

    // axis columns are NOT passthrough; canonical id is not passthrough
    expect(t.passthrough!.has('l')).toBe(false);
    expect(t.passthrough!.has('id')).toBe(false);
  });

  it('preserves unrecognized metadata scalars in meta.extra (strict-superset)', () => {
    const csv = `# device: d
# mostab: 0.1
# license: Apache-2.0
# Source: SomePDK
L,VGS,ID,GM
1e-8,0.3,1e-6,1e-5
1e-8,0.5,2e-6,2e-5
`;
    const t = expectOk(parseMostabCsv(csv)).tables[0];
    // Original-case keys preserved (verbatim), so `Source` doesn't collapse into `source`.
    expect(t.meta.extra).toEqual({ mostab: '0.1', license: 'Apache-2.0', Source: 'SomePDK' });
  });

  it('honors hints over metadata for device/corner', () => {
    const ds = expectOk(parseMostabCsv(CSV, { device: 'override', corner: 'ff' }));
    expect(ds.tables[0].id.device).toBe('override');
    expect(ds.tables[0].id.corner).toBe('ff');
  });

  it('falls back to defaults when no device/corner present', () => {
    const csv = `L,VGS,ID,GM
1e-8,0.3,1e-6,1e-5
1e-8,0.5,2e-6,2e-5
`;
    const ds = expectOk(parseMostabCsv(csv));
    expect(ds.tables[0].id.device).toBe('dev0');
    expect(ds.tables[0].id.corner).toBe('tt');
    expect(ds.tables[0].id.temp).toBe(27);
    // no passthrough columns -> undefined
    expect(ds.tables[0].passthrough).toBeUndefined();
  });

  it('derives device from filename hint when metadata absent', () => {
    const csv = `L,VGS,ID,GM
1e-8,0.3,1e-6,1e-5
1e-8,0.5,2e-6,2e-5
`;
    const ds = expectOk(parseMostabCsv(csv, { filename: '/data/nmos_x.csv' }));
    expect(ds.tables[0].id.device).toBe('nmos_x');
  });

  it('auto-detects a semicolon delimiter', () => {
    const csv = `L;VGS;ID;GM
1e-8;0.3;1e-6;1e-5
1e-8;0.5;2e-6;2e-5
`;
    const ds = expectOk(parseMostabCsv(csv));
    expect(ds.tables[0].grid.shape).toEqual([1, 2]);
    expect(ds.tables[0].grid.quantities.get('id')![1]).toBeCloseTo(2e-6, 18);
  });

  it('auto-detects a tab delimiter', () => {
    const csv = 'L\tVGS\tID\tGM\n1e-8\t0.3\t1e-6\t1e-5\n1e-8\t0.5\t2e-6\t2e-5\n';
    const ds = expectOk(parseMostabCsv(csv));
    expect(ds.tables[0].grid.shape).toEqual([1, 2]);
  });

  it('maps aliased headers to canonical keys', () => {
    const csv = `length,vgs,ids,gm,gout
1e-8,0.3,1e-6,1e-5,1e-7
1e-8,0.5,2e-6,2e-5,2e-7
`;
    const ds = expectOk(parseMostabCsv(csv));
    const q = ds.tables[0].grid.quantities;
    expect(q.has('id')).toBe(true); // ids -> id
    expect(q.has('gds')).toBe(true); // gout -> gds
    expect(ds.tables[0].grid.axes.map((a) => a.name)).toEqual(['l', 'vgs']);
  });

  it('sorts axis values ascending regardless of row order', () => {
    const csv = `L,VGS,ID,GM
6e-8,0.5,9,9
3e-8,0.5,1,1
3e-8,0.3,2,2
6e-8,0.3,8,8
`;
    const ds = expectOk(parseMostabCsv(csv));
    const t = ds.tables[0];
    expect([...t.grid.axes[0].values]).toEqual([3e-8, 6e-8]);
    expect([...t.grid.axes[1].values]).toEqual([0.3, 0.5]);
    // id at (l=3e-8 idx0, vgs=0.5 idx1) -> flat 1 -> 1
    expect(t.grid.quantities.get('id')![1]).toBe(1);
    // id at (l=6e-8 idx1, vgs=0.3 idx0) -> flat 2 -> 8
    expect(t.grid.quantities.get('id')![2]).toBe(8);
  });

  it('decodes Uint8Array input as UTF-8', () => {
    const bytes = new TextEncoder().encode(CSV);
    const ds = expectOk(parseMostabCsv(bytes));
    expect(ds.tables[0].grid.shape).toEqual([2, 3]);
  });

  it('fails with ok:false on an incomplete grid', () => {
    // 2 lengths x 2 vgs = 4 expected, but a cell is missing (only 3 rows).
    const csv = `L,VGS,ID,GM
3e-8,0.3,1,1
3e-8,0.5,2,2
6e-8,0.3,3,3
`;
    const res = parseMostabCsv(csv);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0].kind).toBe('incomplete-grid');
    }
  });

  it('fails on a header with no axis columns', () => {
    const res = parseMostabCsv('ID,GM\n1,2\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].kind).toBe('no-axes');
  });

  it('fails on a ragged data row', () => {
    const res = parseMostabCsv('L,VGS,ID\n1e-8,0.3,1\n1e-8,0.5\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].kind).toBe('ragged-row');
  });

  it('fails on empty input (no header)', () => {
    const res = parseMostabCsv('# only: metadata\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].kind).toBe('empty');
  });

  it('strips a UTF-8 BOM before the metadata block', () => {
    const ds = expectOk(parseMostabCsv('﻿' + CSV));
    expect(ds.tables[0].id.device).toBe('nch_lvt');
  });

  it('flips the sign of a vbs column to vsb (vsb = -vbs)', () => {
    const csv = `L,VGS,VBS,ID,GM
1e-8,0.3,0,1e-6,1e-5
1e-8,0.3,-0.6,1.1e-6,1.0e-5
`;
    const t = expectOk(parseMostabCsv(csv)).tables[0];
    const vsb = t.grid.axes.find((a) => a.name === 'vsb')!;
    expect(vsb).toBeDefined();
    expect([...vsb.values]).toEqual([0, 0.6]); // {0, -0.6} -> {0, 0.6}
  });

  it('records a declared `# polarity: p` as signed PMOS for the fold', () => {
    const csv = `# device: pch_lvt
# polarity: p
L,VGS,ID,GM
1e-8,-0.3,-1e-6,-1e-5
1e-8,-0.5,-2e-6,-2e-5
`;
    const t = expectOk(parseMostabCsv(csv)).tables[0];
    expect(t.meta.polarity).toEqual({ device: 'p', signedInput: true });
  });

  it('accepts polarity aliases (pmos, pch) and the `type:` key', () => {
    const mk = (kv: string) =>
      expectOk(parseMostabCsv(`${kv}\nL,VGS,ID,GM\n1e-8,0.3,1e-6,1e-5\n1e-8,0.5,2e-6,2e-5\n`))
        .tables[0].meta.polarity;
    expect(mk('# polarity: pmos')).toEqual({ device: 'p', signedInput: true });
    expect(mk('# polarity: PCH')).toEqual({ device: 'p', signedInput: true });
    expect(mk('# type: p')).toEqual({ device: 'p', signedInput: true });
    expect(mk('# type: nmos')).toEqual({ device: 'n', signedInput: false });
  });

  it('records a declared `# polarity: n` with nothing to fold', () => {
    const csv = `# polarity: n
L,VGS,ID,GM
1e-8,0.3,1e-6,1e-5
1e-8,0.5,2e-6,2e-5
`;
    const t = expectOk(parseMostabCsv(csv)).tables[0];
    expect(t.meta.polarity).toEqual({ device: 'n', signedInput: false });
  });

  it('leaves polarity undefined when absent and when the value is unrecognized', () => {
    // No polarity line (the device NAME is never sniffed for type).
    const absent = expectOk(parseMostabCsv(CSV)).tables[0];
    expect(absent.meta.polarity).toBeUndefined();
    // An unrecognized value is ignored, same as a missing line.
    const bad = `# polarity: depletion
L,VGS,ID,GM
1e-8,0.3,1e-6,1e-5
1e-8,0.5,2e-6,2e-5
`;
    expect(expectOk(parseMostabCsv(bad)).tables[0].meta.polarity).toBeUndefined();
  });

  it('rejects a blank or non-numeric quantity cell', () => {
    const blank = parseMostabCsv('L,VGS,ID,GM\n1e-8,0.3,,1e-5\n1e-8,0.5,2e-6,2e-5\n');
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.errors[0].kind).toBe('bad-cell');
    const nan = parseMostabCsv('L,VGS,ID,GM\n1e-8,0.3,1e-6,1e-5\n1e-8,0.5,2e-6,abc\n');
    expect(nan.ok).toBe(false);
    if (!nan.ok) expect(nan.errors[0].kind).toBe('bad-cell');
  });
});
