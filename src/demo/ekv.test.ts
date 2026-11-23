import { describe, it, expect } from 'vitest';
import { generateEkvDevice, ekvPoint, EKV_DEFAULT_LENGTHS, type EkvOptions } from './ekv';
import { ekvTable, ekvTableP } from './ekv.fixtures';
import { signedMirrorDemo, toMostabCsv } from './index';
import { validate } from '../qa';
import { importMostab } from '../import';
import { strides } from '../grid';
import { metaScalars, tableScope } from '../derive';
import type { DeviceTable, Grid } from '../types';

function col(grid: Grid, key: string): Float64Array {
  const c = grid.quantities.get(key);
  if (!c) throw new Error(`missing column ${key}`);
  return c;
}

const axis = (grid: Grid, name: string): Float64Array => {
  const a = grid.axes.find((x) => x.name === name);
  if (!a) throw new Error(`missing axis ${name}`);
  return a.values;
};

/** Every grid line along axis `d`, as the flat index of its first node and the stride. */
function lines(grid: Grid, d: number): { start: number; stride: number; n: number }[] {
  const st = strides(grid.shape);
  const size = grid.shape.reduce((a, b) => a * b, 1);
  const out: { start: number; stride: number; n: number }[] = [];
  for (let flat = 0; flat < size; flat++) {
    if (Math.floor(flat / st[d]) % grid.shape[d] !== 0) continue;
    out.push({ start: flat, stride: st[d], n: grid.shape[d] });
  }
  return out;
}

/** The axis coordinates of a flat index, by axis name. */
function coords(grid: Grid, flat: number): Record<string, number> {
  const st = strides(grid.shape);
  const out: Record<string, number> = {};
  grid.axes.forEach((a, d) => {
    out[a.name] = a.values[Math.floor(flat / st[d]) % grid.shape[d]];
  });
  return out;
}

describe('the full-range EKV device', () => {
  it('has the documented grid and the nine value columns', () => {
    const t = ekvTable();
    expect(t.grid.axes.map((a) => a.name)).toEqual(['l', 'vds', 'vsb', 'vgs']);
    expect(t.grid.shape).toEqual([4, 37, 21, 181]);
    const vgs = axis(t.grid, 'vgs');
    const vds = axis(t.grid, 'vds');
    expect([vgs[0], vgs[vgs.length - 1]]).toEqual([0, 1.8]);
    expect([vds[0], vds[vds.length - 1]]).toEqual([0, 1.8]);
    expect(axis(t.grid, 'vsb')[20]).toBeCloseTo(1, 12);
    const values = [...t.grid.quantities.keys()].filter(
      (k) => !['l', 'vds', 'vsb', 'vgs'].includes(k),
    );
    expect(values.sort()).toEqual(
      ['cgg', 'gds', 'gm', 'gmb', 'id', 'sfl', 'sth', 'vdsat', 'vth'].sort(),
    );
  });

  it('validates with no errors, no warnings and no no-saturation finding, on both polarities', () => {
    for (const t of [ekvTable(), ekvTableP()]) {
      const qa = validate(t);
      expect(qa.filter((w) => w.severity !== 'info')).toEqual([]);
      // The simpler device raises this once per length because its gds never falls along vds;
      // its absence is the evidence that this one saturates.
      expect(qa.filter((w) => w.rule === 'no-saturation')).toEqual([]);
    }
  });

  it('holds id and gm at exactly 0 at vds = 0, gds positive, and thermal noise of the conductance', () => {
    const t = ekvTable();
    const [id, gm, gmb, gds, sth] = ['id', 'gm', 'gmb', 'gds', 'sth'].map((k) => col(t.grid, k));
    const kT4 = 4 * 1.380649e-23 * 300.15;
    let seen = 0;
    for (let i = 0; i < id.length; i++) {
      if (coords(t.grid, i).vds !== 0) continue;
      seen++;
      expect(id[i]).toBe(0);
      expect(gm[i]).toBe(0);
      expect(gmb[i]).toBe(0);
      expect(gds[i]).toBeGreaterThan(0);
      // The channel's thermal noise at vds = 0 is that of its conductance.
      expect(sth[i] / (kT4 * gds[i])).toBeCloseTo(1, 12);
    }
    expect(seen).toBe(4 * 21 * 181);
  });

  it('gives sheets the stored thermal noise, in saturation and in triode', () => {
    // The table stores no gamma column, so the namespace reads γ back from sth and the γ-model
    // figures a sheet reads (svth_m, vnth_m) are the stored noise itself wherever gm is nonzero.
    const t = ekvTable();
    const scope = tableScope(t.grid, metaScalars(t.meta));
    const svth = scope.resolve('svth_m') as Float64Array;
    const vnth = scope.resolve('vnth_m') as Float64Array;
    const sth = col(t.grid, 'sth');
    const gm = col(t.grid, 'gm');
    const vdsat = col(t.grid, 'vdsat');
    let worst = 0;
    let triode = 0;
    let saturated = 0;
    for (let i = 0; i < sth.length; i++) {
      if (gm[i] === 0) continue;
      const vds = coords(t.grid, i).vds;
      if (vds < vdsat[i]) triode++;
      else saturated++;
      worst = Math.max(
        worst,
        Math.abs(svth[i] / (sth[i] / gm[i] ** 2) - 1),
        Math.abs(vnth[i] / (Math.sqrt(sth[i]) / gm[i]) - 1),
      );
    }
    expect(triode).toBeGreaterThan(1000);
    expect(saturated).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(1e-12);
  });

  // Fine-grid tables, each fine along the axis the derivative is taken in. A central difference
  // of the stored id column must match the stored derivative to the difference's own O(h²)
  // truncation error.
  const FINE: { col: string; along: string; sign: number; opts: EkvOptions }[] = [
    {
      col: 'gm',
      along: 'vgs',
      sign: 1,
      opts: {
        vgs: { min: 0, max: 1.8, step: 0.001 },
        vds: { min: 0, max: 1.8, step: 0.3 },
        vsb: { min: 0, max: 0.9, step: 0.3 },
      },
    },
    {
      col: 'gds',
      along: 'vds',
      sign: 1,
      opts: {
        vgs: { min: 0, max: 1.8, step: 0.2 },
        vds: { min: 0, max: 1.8, step: 0.001 },
        vsb: { min: 0, max: 0.9, step: 0.3 },
      },
    },
    {
      // gmb = ∂id/∂vbs = −∂id/∂vsb.
      col: 'gmb',
      along: 'vsb',
      sign: -1,
      opts: {
        vgs: { min: 0, max: 1.8, step: 0.2 },
        vds: { min: 0, max: 1.8, step: 0.3 },
        vsb: { min: 0, max: 0.9, step: 0.001 },
      },
    },
  ];
  for (const f of FINE) {
    it(`stores ${f.col} as the analytic derivative of id along ${f.along}`, () => {
      const t = generateEkvDevice(f.opts);
      const d = t.grid.axes.findIndex((a) => a.name === f.along);
      const x = t.grid.axes[d].values;
      const id = col(t.grid, 'id');
      const g = col(t.grid, f.col);
      let worst = 0;
      let checked = 0;
      for (const ln of lines(t.grid, d)) {
        let scale = 0;
        for (let j = 0; j < ln.n; j++)
          scale = Math.max(scale, Math.abs(g[ln.start + j * ln.stride]));
        for (let j = 1; j < ln.n - 1; j++) {
          const at = ln.start + j * ln.stride;
          const fd = (f.sign * (id[at + ln.stride] - id[at - ln.stride])) / (x[j + 1] - x[j - 1]);
          // Relative to the point, with a floor of 1e-6 of the line's largest value so a
          // derivative near zero is not judged on rounding. A line on which the derivative is
          // 0 throughout (gm and gmb at vds = 0) must read 0 from the difference too.
          const floor = Math.max(Math.abs(g[at]), 1e-6 * scale);
          const err = floor > 0 ? Math.abs(fd - g[at]) / floor : Math.abs(fd) + Math.abs(g[at]);
          worst = Math.max(worst, err);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(1000);
      expect(worst).toBeLessThan(1e-3);
    });
  }

  it('has id rising with vgs and vds and falling with vsb at every node', () => {
    const t = ekvTable();
    const id = col(t.grid, 'id');
    const vdsAt = (i: number): number => coords(t.grid, i).vds;
    const bad: string[] = [];
    for (const [name, dir] of [
      ['vgs', 1],
      ['vds', 1],
      ['vsb', -1],
    ] as const) {
      const d = t.grid.axes.findIndex((a) => a.name === name);
      for (const ln of lines(t.grid, d)) {
        // Along vgs and vsb a line at vds = 0 carries no current anywhere: id is 0, not rising.
        const flat = name !== 'vds' && vdsAt(ln.start) === 0;
        for (let j = 1; j < ln.n; j++) {
          const a = id[ln.start + (j - 1) * ln.stride];
          const b = id[ln.start + j * ln.stride];
          const ok = flat ? a === 0 && b === 0 : dir * (b - a) > 0;
          if (!ok && bad.length < 5)
            bad.push(`${name} at ${JSON.stringify(coords(t.grid, ln.start + j * ln.stride))}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  /** The vgs, by linear interpolation on the vgs axis, where gm/ID first falls to `target` on
   *  the line of (L index, vds index, vsb index), or undefined. */
  function vgsAtGmId(t: DeviceTable, li: number, di: number, si: number, target: number) {
    const [, nVds, nVsb, nVgs] = t.grid.shape;
    const vgs = axis(t.grid, 'vgs');
    const id = col(t.grid, 'id');
    const gm = col(t.grid, 'gm');
    const base = ((li * nVds + di) * nVsb + si) * nVgs;
    for (let j = 1; j < nVgs; j++) {
      const r0 = gm[base + j - 1] / id[base + j - 1];
      const r1 = gm[base + j] / id[base + j];
      if (r0 >= target && r1 < target)
        return vgs[j - 1] + ((r0 - target) / (r0 - r1)) * (vgs[j] - vgs[j - 1]);
    }
    return undefined;
  }

  it('at fixed gm/ID, needs more vgs as vds rises in triode and less as it rises in saturation', () => {
    // The designed exception to "gm/ID fixes vgs": in triode a larger vds needs more overdrive
    // for the same gm/ID, and in saturation barrier lowering lowers the threshold, so the same
    // gm/ID is found at a lower vgs. Read off the table at L = 0.5 µm, body grounded, gm/ID = 8.
    const t = ekvTable();
    const vds = axis(t.grid, 'vds');
    const at = vds.map((_, di) => (di === 0 ? NaN : (vgsAtGmId(t, 1, di, 0, 8) ?? NaN)));
    // Triode: the first few vds steps, where vds is well below the overdrive.
    for (let di = 2; di <= 4; di++) expect(at[di]).toBeGreaterThan(at[di - 1]);
    // Saturation: from 0.6 V up, well past vdsat at this inversion level.
    for (let di = 13; di < vds.length; di++) expect(at[di]).toBeLessThan(at[di - 1]);
  });

  it('has a threshold that falls with vds and rises with vsb', () => {
    const t = ekvTable();
    const vth = col(t.grid, 'vth');
    let bad = 0;
    for (const [name, dir] of [
      ['vds', -1],
      ['vsb', 1],
    ] as const) {
      const d = t.grid.axes.findIndex((a) => a.name === name);
      for (const ln of lines(t.grid, d))
        for (let j = 1; j < ln.n; j++) {
          const a = vth[ln.start + (j - 1) * ln.stride];
          const b = vth[ln.start + j * ln.stride];
          if (!(dir * (b - a) > 0)) bad++;
        }
    }
    expect(bad).toBe(0);
  });

  it('has output conductance in saturation that falls as length grows, and gm/ID that moves with vds', () => {
    const t = ekvTable();
    const [nL, nVds, nVsb, nVgs] = t.grid.shape;
    const id = col(t.grid, 'id');
    const gm = col(t.grid, 'gm');
    const gds = col(t.grid, 'gds');
    const vdsat = col(t.grid, 'vdsat');
    const vds = axis(t.grid, 'vds');
    const flat = (li: number, di: number, si: number, vi: number) =>
      ((li * nVds + di) * nVsb + si) * nVgs + vi;
    // gds/ID, the inverse of the effective Early voltage, at vds = 1.2 V wherever every length is
    // in saturation there.
    const di = vds.findIndex((v) => Math.abs(v - 1.2) < 1e-9);
    let compared = 0;
    let rising = 0;
    for (let si = 0; si < nVsb; si++)
      for (let vi = 0; vi < nVgs; vi++) {
        let saturated = true;
        for (let li = 0; li < nL; li++) if (vdsat[flat(li, di, si, vi)] >= 1.2) saturated = false;
        if (!saturated) continue;
        compared++;
        for (let li = 1; li < nL; li++) {
          const prev = gds[flat(li - 1, di, si, vi)] / id[flat(li - 1, di, si, vi)];
          const cur = gds[flat(li, di, si, vi)] / id[flat(li, di, si, vi)];
          if (!(cur < prev)) rising++;
        }
      }
    expect(rising).toBe(0);
    expect(compared).toBeGreaterThan(nVsb * nVgs * 0.5);
    // gm/ID at one gate voltage in moderate inversion changes by more than 20 % between a triode
    // drain voltage and a saturated one.
    const vi = 70; // vgs = 0.7 V
    const ratio = (d: number) => gm[flat(1, d, 0, vi)] / id[flat(1, d, 0, vi)];
    const tri = ratio(1); // vds = 0.05 V
    const sat = ratio(vds.length - 1); // vds = 1.8 V
    expect(Math.abs(tri - sat) / sat).toBeGreaterThan(0.2);
  });

  it('puts vdsat where the reverse current has fallen to under 2.5 % of the forward one', () => {
    // At vds = vdsat the current with the channel-length-modulation factor taken out,
    // F(vp − vsb) − F(vp − vsb − vds), is within 2.5 % of its saturated value F(vp − vsb), at
    // every vgs, vsb and length of the table, with vdsat read from the table at every vds it
    // holds (barrier lowering moves it a little).
    const t = ekvTable();
    const vdsat = col(t.grid, 'vdsat');
    const W = t.meta.W as number;
    let worst = 0;
    for (let i = 0; i < vdsat.length; i++) {
      const c = coords(t.grid, i);
      const p = ekvPoint(c.l, W, c.vgs, vdsat[i], c.vsb);
      worst = Math.max(worst, p.iR / p.iF);
    }
    expect(worst).toBeLessThan(0.025);
    expect(worst).toBeGreaterThan(0.015); // the bound is near tight, not vacuous
  });

  it('round-trips through mostab CSV with the same table and the same QA, on both polarities', () => {
    // A coarser grid of the same model: the full one is some 140 MB of CSV text.
    const n = generateEkvDevice({
      vgs: { min: 0, max: 1.8, step: 0.01 },
      vds: { min: 0, max: 1.8, step: 0.3 },
      vsb: { min: 0, max: 0.9, step: 0.3 },
    });
    for (const t of [n, signedMirrorDemo(n)]) {
      const r = importMostab(toMostabCsv(t));
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      const back = r.dataset.tables[0];
      // CSV text has no negative zero, so the mirrored axis's -0 reads back as 0.
      const plain = (c: Float64Array) => Array.from(c, (v) => (v === 0 ? 0 : v));
      expect(back.grid.axes.map((a) => [a.name, plain(a.values)])).toEqual(
        t.grid.axes.map((a) => [a.name, plain(a.values)]),
      );
      for (const [k, c] of t.grid.quantities) expect(plain(col(back.grid, k))).toEqual(plain(c));
      expect(r.dataset.warnings).toEqual(validate(t));
      expect(back.meta.polarity?.device).toBe(t.meta.polarity?.device);
    }
  });

  it('is deterministic: the same options give identical arrays', () => {
    const opts: EkvOptions = {
      lengths: [...EKV_DEFAULT_LENGTHS],
      vds: { min: 0, max: 1.8, step: 0.1 },
      vsb: { min: 0, max: 0.9, step: 0.1 },
    };
    const a = generateEkvDevice(opts);
    const b = generateEkvDevice(opts);
    for (const [k, c] of a.grid.quantities) {
      const d = col(b.grid, k);
      let differ = 0;
      for (let i = 0; i < c.length; i++) if (!Object.is(c[i], d[i])) differ++;
      expect(differ, k).toBe(0);
    }
  });
});

describe('the full-range EKV device at a second condition', () => {
  // A smaller grid of the same model for the comparisons, which read node against node.
  const GRID: EkvOptions = {
    vds: { min: 0, max: 1.8, step: 0.15 },
    vsb: { min: 0, max: 0.9, step: 0.3 },
  };
  const make = (o: EkvOptions = {}) => generateEkvDevice({ ...GRID, ...o });

  it('is the nominal table exactly when the condition is given at its defaults', () => {
    const a = make();
    const b = make({ vtShift: 0, ispecFactor: 1, tempC: 27, corner: 'tt' });
    for (const [k, c] of a.grid.quantities) {
      const d = col(b.grid, k);
      let differ = 0;
      for (let i = 0; i < c.length; i++) if (!Object.is(c[i], d[i])) differ++;
      expect(differ, k).toBe(0);
    }
    expect(b.id).toEqual({ device: 'nmos_ekv', condition: { corner: 'tt', temp: 27 } });
  });

  it('records the condition in the table identity', () => {
    const t = make({ corner: 'ss', vtShift: 0.05, ispecFactor: 0.85, tempC: 125 });
    expect(t.id).toEqual({ device: 'nmos_ekv', condition: { corner: 'ss', temp: 125 } });
    expect(t.meta.temp).toBe(125);
  });

  it('lowers id at every conducting node with a positive threshold shift, and moves gm/ID along vgs', () => {
    // 50 mV is five vgs steps, so the shifted gm/ID curve at node j + 5 is the nominal one at j.
    const nom = make();
    const up = make({ vtShift: 0.05 });
    const [idN, idU] = [col(nom.grid, 'id'), col(up.grid, 'id')];
    const [gmN, gmU] = [col(nom.grid, 'gm'), col(up.grid, 'gm')];
    let notLower = 0;
    for (let i = 0; i < idN.length; i++) {
      if (idN[i] === 0) continue; // vds = 0: no current at either condition
      if (!(idU[i] < idN[i])) notLower++;
    }
    expect(notLower).toBe(0);
    const d = nom.grid.axes.findIndex((a) => a.name === 'vgs');
    let worst = 0;
    for (const ln of lines(nom.grid, d)) {
      if (idN[ln.start + ln.stride] === 0) continue;
      for (let j = 0; j + 5 < ln.n; j++) {
        const a = gmN[ln.start + j * ln.stride] / idN[ln.start + j * ln.stride];
        const b = gmU[ln.start + (j + 5) * ln.stride] / idU[ln.start + (j + 5) * ln.stride];
        worst = Math.max(worst, Math.abs(b - a) / a);
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('scales id, gm and gds together with the current factor and leaves gm/ID unchanged', () => {
    const nom = make();
    const fast = make({ ispecFactor: 1.2 });
    let worst = 0;
    for (const k of ['id', 'gm', 'gds']) {
      const [a, b] = [col(nom.grid, k), col(fast.grid, k)];
      for (let i = 0; i < a.length; i++)
        if (a[i] !== 0) worst = Math.max(worst, Math.abs(b[i] / a[i] - 1.2));
    }
    expect(worst).toBeLessThan(1e-12);
    const [idN, gmN, idF, gmF] = [
      col(nom.grid, 'id'),
      col(nom.grid, 'gm'),
      col(fast.grid, 'id'),
      col(fast.grid, 'gm'),
    ];
    let gmId = 0;
    for (let i = 0; i < idN.length; i++)
      if (idN[i] !== 0) gmId = Math.max(gmId, Math.abs(gmF[i] / idF[i] - gmN[i] / idN[i]));
    expect(gmId).toBeLessThan(1e-9);
  });

  it('carries less current hot in strong inversion and more in weak, so the curves cross', () => {
    // L = 0.5 µm, vds = 1.2 V, body grounded: one vgs sweep at 27 °C and at 125 °C.
    const nom = make();
    const hot = make({ tempC: 125 });
    const [nL, nVds, nVsb, nVgs] = nom.grid.shape;
    expect(nL).toBe(4);
    const di = Math.round(1.2 / 0.15);
    const base = ((1 * nVds + di) * nVsb + 0) * nVgs;
    const idN = col(nom.grid, 'id').subarray(base, base + nVgs);
    const idH = col(hot.grid, 'id').subarray(base, base + nVgs);
    expect(idH[30]).toBeGreaterThan(idN[30]); // vgs = 0.3 V, weak inversion
    expect(idH[nVgs - 1]).toBeLessThan(idN[nVgs - 1]); // vgs = 1.8 V, strong inversion
    let crossings = 0;
    for (let j = 1; j < nVgs; j++)
      if (Math.sign(idH[j] - idN[j]) !== Math.sign(idH[j - 1] - idN[j - 1])) crossings++;
    expect(crossings).toBe(1);
  });

  it('validates with no errors and no warnings at slow-hot and fast-cold, on both polarities', () => {
    for (const o of [
      { corner: 'ss', vtShift: 0.05, ispecFactor: 0.85, tempC: 125 },
      { corner: 'ff', vtShift: -0.05, ispecFactor: 1.15, tempC: -40 },
    ]) {
      const n = generateEkvDevice(o);
      for (const t of [n, signedMirrorDemo(n)]) {
        const qa = validate(t);
        expect(
          qa.filter((w) => w.severity !== 'info'),
          o.corner,
        ).toEqual([]);
        expect(qa.filter((w) => w.rule === 'no-saturation')).toEqual([]);
      }
    }
  });
});
