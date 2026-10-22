// The sized netlist read back from an evaluated sheet: the devices a simulator is given, on the
// wires the DC walk names, with the widths, levels and element values the run produced. Every
// expected number is the run's own (its sizing, its values, its wiring report) — the export adds no
// arithmetic, so the tests pin what it reads and how it names it.

import { describe, it, expect } from 'vitest';
import { resolveSheetRefs, runSheet } from './index';
import { sizedNetlist } from './spice';
import { REFS, sheet, table } from './library.fixtures';
import type { SheetDoc, SheetResult } from './types';

const run = (path: string): { doc: SheetDoc; res: SheetResult } => {
  const doc = resolveSheetRefs(sheet(path), REFS).doc;
  return { doc, res: runSheet(doc, table) };
};

describe('sizedNetlist', () => {
  it('lists every device of a composed sheet on the top sheet’s wires, with the sizing’s geometry', () => {
    const { doc, res } = run('otas/five-transistor-ota.json');
    const net = sizedNetlist(doc, res);
    expect(net.circuit).toBe(true);
    expect(net.devices.map((d) => d.path)).toEqual(['bias', 'in', 'inr', 'ld', 'ldr', 'tail']);
    // The bias reference wires itself; its port vb is the parent's vbn through the port map.
    const bias = net.devices.find((d) => d.path === 'bias')!;
    expect(bias.placements).toEqual([{ d: 'vbn', g: 'vbn', s: 'gnd', b: 'gnd' }]);
    const tail = net.devices.find((d) => d.path === 'tail')!;
    const tailReport = res.blocks!.find((b) => b.name === 'tail')!.sizing!;
    expect(tail).toMatchObject({ polarity: 'n', sized: true, W: tailReport.W, L: tailReport.L });
    expect(tail.point.id).toBe(tailReport.id);
    expect(tail.point.vds).toBe(tailReport.bias?.vds);
    expect(net.devices.find((d) => d.path === 'ld')!.polarity).toBe('p');
    // The child's element, prefixed so it is unique across the tree, at the value the run gave it.
    expect(net.elements).toEqual([
      {
        name: 'bias__iref',
        kind: 'I',
        between: ['vdd', 'vbn'],
        value: res.values.I_tail,
        expr: 'I_ref',
        sheet: 'bias',
      },
    ]);
  });

  it('carries the held levels, the ports at the level the walk derives, and the figures by name', () => {
    const { doc, res } = run('otas/five-transistor-ota.json');
    const net = sizedNetlist(doc, res);
    expect(net.levels.map((l) => [l.wire, l.value])).toEqual([
      ['vdd', res.values.VDD],
      ['out', res.values.V_out_dc],
    ]);
    expect(net.ports).toEqual([
      { wire: 'vinp', level: res.nodes!.levels.vinp.level },
      { wire: 'vinn', level: res.nodes!.levels.vinn.level },
    ]);
    expect(net.wires.tail).toEqual({ level: res.nodes!.levels.tail.level, held: false });
    expect(net.wires.out.held).toBe(true);
    const fig = (n: string) => net.figures.find((f) => f.name === n);
    expect(fig('Av')).toEqual({
      name: 'Av',
      value: res.values.Av,
      expr: 'gm_pair*Rout',
      unit: 'V/V',
    });
    expect(fig('V_tail')).toMatchObject({ value: res.values.V_tail, solved: true });
    expect(net.params.CL).toBe(res.values.CL);
    expect(net.wiring?.state).toBe(res.nodes!.state);
  });

  it('names a grandchild’s internal wire behind both block names, and places a list once per member', () => {
    const { doc, res } = run('otas/telescopic-cascode-ota.json');
    const net = sizedNetlist(doc, res);
    const base = net.devices.find((d) => d.path === 'cbn.base')!;
    expect(base.placements).toEqual([{ d: 'cbn__m', g: 'cbn__m', s: 'gnd', b: 'gnd' }]);
    expect(net.wires).toHaveProperty('cbn__m');

    const pair = run('otas/differential-pair-tail.json');
    const inp = sizedNetlist(pair.doc, pair.res).devices.find((d) => d.path === 'in')!;
    expect(inp.placements.map((p) => p.d)).toEqual(['outn', 'outp']);
  });

  it('gives a sheet that is not a circuit its figures and nothing else', () => {
    const { doc, res } = run('applications/gm-c-filter-pole.json');
    const net = sizedNetlist(doc, res);
    expect(net.circuit).toBe(false);
    expect(net.devices).toEqual([]);
    expect(net.figures.length).toBe(doc.equations.length);
  });

  it('marks a device that did not size, with no geometry to give a simulator', () => {
    const doc: SheetDoc = {
      title: 'one device',
      formatVersion: 2,
      polarity: 'n',
      params: [{ name: 'VDD', value: 1.8, class: 'independent' }],
      givens: { L: '0.5e-6', id: '10e-6', gm_id: '999', diode: true },
      nodes: { d: 'x', g: 'x', s: 'gnd', b: 'gnd' },
      levels: { vdd: 'VDD' },
      elements: [{ name: 'ib', kind: 'I', between: ['vdd', 'x'], value: 10e-6 }],
      equations: [],
      checks: [],
    };
    const net = sizedNetlist(doc, runSheet(doc, table));
    expect(net.devices).toHaveLength(1);
    expect(net.devices[0]).toMatchObject({ path: '', sized: false, point: {} });
    expect(net.devices[0]).not.toHaveProperty('W');
    expect(net.devices[0].error).toBeTruthy();
  });
});
