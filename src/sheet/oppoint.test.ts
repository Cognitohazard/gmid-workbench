// What a run keeps beside its verdict for a reader: each sized device's full operating point
// (kept only by the run that asks for it) and the current the source holding each held wire
// delivers.
import { describe, it, expect } from 'vitest';
import { groupDevices, runConditions } from '../corners';
import { runSheet, operatingPointOf, withParams } from './index';
import { loadLibrary, table, REFS } from './library.fixtures';

const fiveT = loadLibrary().find((s) => s.file === 'otas/five-transistor-ota.json')!.doc;

describe('the operating point of each device', () => {
  it('is kept on every sized block of a run that asks for it, and agrees with its sizing', () => {
    const res = runSheet(fiveT, table, undefined, REFS, { operatingPoint: true });
    const blocks = res.blocks ?? [];
    expect(blocks.length).toBe(6);
    for (const b of blocks) {
      expect(b.sizing?.ok, b.name).toBe(true);
      const pt = b.point!;
      expect(pt.id).toBeCloseTo(b.sizing!.id, 15);
      expect(pt.vgs).toBeCloseTo(b.sizing!.vgs, 12);
      // The small-signal quantities and the derived figures are there with them.
      for (const k of ['gm', 'gds', 'gmb', 'cgg', 'vdsat', 'gm_id', 'ft', 'ro'])
        expect(Number.isFinite(pt[k]), `${b.name}.${k}`).toBe(true);
      expect(pt.gm_id).toBeCloseTo(pt.gm / pt.id, 9);
    }
  });

  it('is not kept by a run that does not ask, and asking moves no other number', () => {
    const plain = runSheet(fiveT, table, undefined, REFS);
    const asked = runSheet(fiveT, table, undefined, REFS, { operatingPoint: true });
    expect((plain.blocks ?? []).some((b) => b.point !== undefined)).toBe(false);
    const strip = (r: typeof plain) => JSON.stringify(r, (k, v) => (k === 'point' ? undefined : v));
    expect(strip(asked)).toBe(strip(plain));
  });

  it('is read for the sheet’s own device from its values, by the same definition', () => {
    const own = loadLibrary().find((s) => s.file === 'stages/source-follower.json')!.doc;
    const res = runSheet(own, table, undefined, REFS);
    expect(res.sizing?.ok).toBe(true);
    const pt = operatingPointOf(res.values, res.sizing!);
    expect(pt.id).toBeCloseTo(res.sizing!.id, 15);
    expect(Object.keys(pt)).not.toContain('ceiling');
  });

  it('is kept by a device that sized and by none that reads a value the solve did not find', () => {
    // Asked for a common mode the pair cannot pass, the tail voltage is not found: every device
    // whose givens read it is not sized and has no point. The bias reference reads nothing that
    // failed, and keeps both.
    const res = runSheet(withParams(fiveT, { CM_dc: 1.75 }), table, undefined, REFS, {
      operatingPoint: true,
    });
    expect(res.solve?.kind).not.toBe('settled');
    expect(res.withheld?.V_tail).toBe('V_tail');
    for (const b of res.blocks ?? []) {
      if (b.name === 'bias') {
        expect(b.sizing?.ok).toBe(true);
        expect(b.point?.id).toBeCloseTo(b.sizing!.id, 15);
      } else {
        expect(b.sizing, b.name).toBeUndefined();
        expect(b.point, b.name).toBeUndefined();
      }
    }
  });

  it('is not kept by a device read beyond its table', () => {
    // At gm/ID 12 the inverter's input sits where its PMOS is asked for a gate voltage past the
    // table: the PMOS is refused, with the read recorded, and has no point. The NMOS sized.
    const doc = loadLibrary().find((s) => s.file === 'stages/cmos-inverter-amp.json')!.doc;
    const res = runSheet(withParams(doc, { gm_id_n: 12 }), table, undefined, REFS, {
      operatingPoint: true,
    });
    const at = (name: string) => res.blocks!.find((b) => b.name === name)!;
    expect(at('p').sizing?.ok).toBe(false);
    expect(at('p').sizing?.outside?.[0]?.quantity).toBe('vgs');
    expect(at('p').point).toBeUndefined();
    expect(at('n').sizing?.ok).toBe(true);
  });

  it('is kept by the condition where the design is sized, and not where it is held', () => {
    const tt = { ...table, id: { device: table.id.device, condition: { corner: 'tt', temp: 27 } } };
    const ss = { ...table, id: { device: table.id.device, condition: { corner: 'ss', temp: 27 } } };
    const [device] = groupDevices([tt, ss]);
    const at = { corner: 'tt', temp: 27 };
    const runs = runConditions(
      fiveT,
      device,
      [at, { corner: 'ss', temp: 27 }],
      () => undefined,
      REFS,
      at,
      {
        operatingPoint: true,
      },
    );
    const [sized, held] = runs;
    expect(sized.design).toBe('sized');
    expect(held.design).toBe('held');
    expect(sized.result?.blocks?.every((b) => b.point !== undefined)).toBe(true);
    expect(held.result?.blocks?.some((b) => b.point !== undefined)).toBe(false);
  });
});

describe('the current delivered at each held wire', () => {
  it('is what the source holding the wire delivers, at a held wire every current leaves or enters', () => {
    const res = runSheet(fiveT, table, undefined, REFS);
    const balance = res.nodes?.balance ?? [];
    const at = (w: string) => balance.find((b) => b.wire === w)!;
    // The current drawn from vdd returns through ground.
    expect(at('vdd').delivered).toBeGreaterThan(0);
    expect(at('gnd').delivered).toBeLessThan(0);
    for (const b of balance) {
      const mixed = b.branches.some((x) => x.current > 0) && b.branches.some((x) => x.current < 0);
      if (b.delivered !== undefined) {
        expect(b.held && !mixed, b.wire).toBe(true);
        expect(b.delivered).toBe(-b.residual);
      } else expect(b.held && !mixed, b.wire).toBe(false);
    }
    // What vdd delivers is the tail current through the pair and the bias reference's current.
    const id = (name: string) => res.blocks!.find((b) => b.name === name)!.sizing!.id;
    expect(at('vdd').delivered!).toBeCloseTo(id('tail') + id('bias'), 12);
  });

  it('sums to zero over the held wires of a sheet whose wires all balance', () => {
    // The gain-boosted cascode holds vdd, ground and the booster's output `bo`; every current
    // the sources deliver returns through one of them.
    const doc = loadLibrary().find((s) => s.file === 'otas/gain-boosted-cascode-ota.json')!.doc;
    const balance = runSheet(doc, table, undefined, REFS).nodes?.balance ?? [];
    const delivered = balance.filter((b) => b.delivered !== undefined);
    expect(delivered.map((b) => b.wire).sort()).toEqual(['bo', 'gnd', 'vdd']);
    for (const b of balance) if (b.delivered === undefined) expect(b.residual, b.wire).toBe(0);
    const sum = delivered.reduce((t, b) => t + b.delivered!, 0);
    expect(Math.abs(sum)).toBeLessThan(
      1e-12 * Math.max(...delivered.map((b) => Math.abs(b.delivered!))),
    );
  });
});
