// What a run keeps beside its verdict for a reader: each sized device's full operating point
// (kept only by the run that asks for it) and the supply current at each rail.
import { describe, it, expect } from 'vitest';
import { groupDevices, runConditions } from '../corners';
import { runSheet, operatingPointOf } from './index';
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

  it('is kept by the condition where the design is sized, and not where it is held', () => {
    const tt = { ...table, id: { ...table.id, corner: 'tt', temp: 27 } };
    const ss = { ...table, id: { ...table.id, corner: 'ss', temp: 27 } };
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

describe('the supply current at each rail', () => {
  it('is what the source holding the rail delivers, and only rails carry it', () => {
    const res = runSheet(fiveT, table, undefined, REFS);
    const balance = res.nodes?.balance ?? [];
    const at = (w: string) => balance.find((b) => b.wire === w)!;
    // The current drawn from vdd returns through ground.
    expect(at('vdd').supply).toBeGreaterThan(0);
    expect(at('gnd').supply).toBeLessThan(0);
    expect(at('vdd').supply! + at('gnd').supply!).toBeCloseTo(0, 12);
    for (const b of balance) {
      const mixed = b.branches.some((x) => x.current > 0) && b.branches.some((x) => x.current < 0);
      if (b.supply !== undefined) {
        expect(b.held && !mixed, b.wire).toBe(true);
        expect(b.supply).toBe(-b.residual);
      } else expect(b.held && !mixed, b.wire).toBe(false);
    }
    // What vdd delivers is the tail current through the pair and the bias reference's current.
    const id = (name: string) => res.blocks!.find((b) => b.name === name)!.sizing!.id;
    expect(at('vdd').supply!).toBeCloseTo(id('tail') + id('bias'), 12);
  });
});
