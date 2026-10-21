// The wiring proposal and the loader's carriage of the netlist. The drafts for library sheets are
// checked against what each sheet's own expressions say — `vds = V_out_dc - V_tail` puts the drain
// on the output node and the source on the tail — worked out by reading the sheet, not by running
// the tool and copying its answer.

import { describe, it, expect } from 'vitest';
import {
  applyWiringProposal,
  formatWiringProposal,
  proposeWiring,
  type WiringProposal,
} from './propose';
import { carriedBlockWiring, carriedConvention, carriedDocWiring, structuralDiodes } from './nodes';
import { loadLibrary, table, REFS } from './library.fixtures';
import { levelEligibility, runSheet, validateSheet } from './index';
import type { SheetBlock, SheetDoc, SheetGivens, SheetVar } from './types';

const wireOf = (p: WiringProposal, device: string, t: 'd' | 'g' | 's' | 'b', at = ''): string =>
  p.devices.find((d) => d.device === device && d.at === at)!.nodes[t].wire;
const markOf = (p: WiringProposal, device: string, t: 'd' | 'g' | 's' | 'b'): string =>
  p.devices.find((d) => d.device === device)!.nodes[t].mark;

describe('what the proposal infers, and how sure it is', () => {
  const doc: SheetDoc = {
    title: 'mirror',
    polarity: 'n',
    params: [
      { name: 'V_out', value: 0.9, unit: 'V', class: 'independent' },
      { name: 'I', value: 1e-5 },
    ],
    blocks: [
      {
        name: 'ref',
        doc: {
          title: 'ref',
          polarity: 'n',
          params: [{ name: 'I', value: 1e-5 }],
          givens: { L: '1e-6', id: 'I', gm_id: '8', diode: true },
          equations: [],
          checks: [],
          provides: ['W', 'vgs'],
        },
      },
    ],
    givens: { L: '1e-6', W: '4*ref__W', vgs: 'ref__vgs', vds: 'V_out' },
    equations: [],
    checks: [],
  };

  it('is certain only of a diode connection, and infers the rest', () => {
    const p = proposeWiring(doc);
    // The reference's gate and drain share a wire because diode: true says so...
    expect(wireOf(p, 'ref', 'd')).toBe(wireOf(p, 'ref', 'g'));
    // ...and the output device's gate is that wire because its vgs IS the reference's — an
    // inference, so the whole wire is marked inferred.
    expect(wireOf(p, 'givens', 'g')).toBe(wireOf(p, 'ref', 'g'));
    expect(markOf(p, 'ref', 'd')).toBe('inferred');
    // vds = V_out, one level: the drain on V_out's wire, the source at ground; the reference shares
    // that source through the vgs tie; both bodies are on their sources (vsb left at 0).
    expect(wireOf(p, 'givens', 'd')).toBe('out');
    expect(wireOf(p, 'givens', 's')).toBe('gnd');
    expect(wireOf(p, 'ref', 's')).toBe('gnd');
    expect(wireOf(p, 'ref', 'b')).toBe('gnd');
    expect(p.levels).toEqual([
      expect.objectContaining({ at: '', wire: 'out', expr: 'V_out', held: 'held' }),
    ]);
  });

  it('marks a lone diode, joined to nothing else, certain — and a wire nothing names unknown', () => {
    const lone: SheetDoc = { ...doc, givens: { L: '1e-6', id: 'I', gm_id: '8', vds: '0.6' } };
    const p = proposeWiring(lone);
    expect(markOf(p, 'ref', 'd')).toBe('certain');
    expect(markOf(p, 'ref', 'g')).toBe('certain');
    expect(markOf(p, 'givens', 'g')).toBe('unknown');
    expect(p.notes.some((n) => n.includes('givens.g'))).toBe(true);
  });

  it('writes a format-version-2 copy on apply, and leaves the input as it was', () => {
    const p = proposeWiring(doc);
    const v2 = applyWiringProposal(doc, p);
    expect(v2.formatVersion).toBe(2);
    expect(v2.nodes).toEqual({ d: 'out', g: wireOf(p, 'givens', 'g'), s: 'gnd', b: 'gnd' });
    expect(v2.blocks![0].nodes).toEqual({
      d: wireOf(p, 'ref', 'd'),
      g: wireOf(p, 'ref', 'g'),
      s: 'gnd',
      b: 'gnd',
    });
    expect(v2.levels).toEqual({ out: 'V_out' });
    expect(doc.formatVersion).toBeUndefined();
    expect(validateSheet(v2).filter((w) => w.severity === 'error')).toEqual([]);
    // The one thing the draft cannot state is where the reference current comes from: the diode's
    // drain current has nowhere to go until the author draws its source.
    const r = runSheet(v2, table);
    expect(r.nodes!.findings).toBe(1);
    expect(
      r.warnings.some((w) =>
        w.message.startsWith(`the currents at wire "${wireOf(p, 'ref', 'd')}" do not balance`),
      ),
    ).toBe(true);
  });
});

/** A one-device child of a replica: its givens over its own params, publishing what a parent
 *  reads. The values do not matter — the proposal reads expressions. */
const dev = (polarity: 'n' | 'p', givens: SheetGivens, params: string[]): SheetDoc => ({
  title: polarity,
  polarity,
  params: params.map((name) => ({ name, value: 1 })),
  givens,
  equations: [],
  checks: [],
  provides: ['W', 'vgs', 'id', 'gm', 'gds'],
});
const blk = (name: string, doc: SheetDoc, params: Record<string, string>): SheetBlock => ({
  name,
  doc,
  params,
});
const v = (name: string, extra: Partial<SheetVar> = {}): SheetVar => ({
  name,
  value: 0.9,
  unit: 'V',
  ...extra,
});
const indep = (name: string): SheetVar => v(name, { class: 'independent' });
const sheetOf = (
  title: string,
  params: SheetVar[],
  blocks: SheetBlock[],
  extra: Partial<SheetDoc> = {},
): SheetDoc => ({
  title,
  polarity: 'n',
  params,
  blocks,
  equations: [],
  checks: [],
  ...extra,
});

// Frozen replicas of three library sheets' device expressions, as they stood before they were
// wired: what each device's givens and its parent's overrides say. The library itself moves.
const fiveT = sheetOf(
  '5T OTA',
  [
    indep('VDD'),
    indep('V_out_dc'),
    indep('CM_dc'),
    v('V_tail', { min: 0.1, max: 0.8, designConstraint: { lhs: 'CM_in', rhs: 'CM_dc' } }),
    { name: 'ld_sign', value: 1 },
  ],
  [
    blk('bias', dev('n', { L: 'L', id: 'I', gm_id: 'g', diode: true }, ['L', 'I', 'g']), {}),
    blk('tail', dev('n', { L: 'L', W: 'w', vgs: 'vg', vds: 'vd' }, ['L', 'w', 'vg', 'vd']), {
      w: 'bias__W',
      vg: 'bias__vgs',
      vd: 'V_tail',
    }),
    blk(
      'in',
      dev('n', { L: 'L', id: 'I', gm_id: 'g', vds: 'vd', vsb: 'vs' }, ['L', 'I', 'g', 'vd', 'vs']),
      {
        vd: 'V_out_dc - V_tail',
        vs: 'V_tail',
      },
    ),
    blk('ldr', dev('p', { L: 'L', id: 'I', gm_id: 'g', diode: true }, ['L', 'I', 'g']), {}),
    blk(
      'inr',
      dev('n', { L: 'L', W: 'w', id: 'I', vds: 'vd', vsb: 'vs' }, ['L', 'w', 'I', 'vd', 'vs']),
      {
        w: 'in__W',
        vd: 'VDD - abs(ldr__vgs) - V_tail',
        vs: 'V_tail',
      },
    ),
    blk('ld', dev('p', { L: 'L', W: 'w', vgs: 'vg', vds: 'vd' }, ['L', 'w', 'vg', 'vd']), {
      w: 'ldr__W',
      vg: 'ldr__vgs',
      vd: 'ld_sign*(VDD - V_out_dc)',
    }),
  ],
  { equations: [{ name: 'CM_in', expr: 'V_tail + (in__vgs + inr__vgs)/2' }] },
);

const telescopic = sheetOf(
  'Telescopic cascode OTA',
  [
    indep('VDD'),
    indep('V_out_dc'),
    v('V_tail', { min: 0.1, max: 0.8, designConstraint: { lhs: 'V_tail', rhs: '0.4' } }),
    v('V_a', { min: 0.3, max: 1, hold: 'V_a + casc_n__vgs' }),
    v('V_b', { min: 0.8, max: 1.6, hold: 'V_b - abs(casc_p__vgs)' }),
    { name: 'sign_p', value: 1 },
  ],
  [
    blk('bias', dev('n', { L: 'L', id: 'I', gm_id: 'g', diode: true }, ['L', 'I', 'g']), {}),
    blk('tail', dev('n', { L: 'L', W: 'w', vgs: 'vg', vds: 'vd' }, ['L', 'w', 'vg', 'vd']), {
      w: 'bias__W',
      vg: 'bias__vgs',
      vd: 'V_tail',
    }),
    blk(
      'in',
      dev('n', { L: 'L', id: 'I', gm_id: 'g', vds: 'vd', vsb: 'vs' }, ['L', 'I', 'g', 'vd', 'vs']),
      {
        vd: 'V_a - V_tail',
        vs: 'V_tail',
      },
    ),
    blk(
      'casc_n',
      dev('n', { L: 'L', id: 'I', gm_id: 'g', vds: 'vd', vsb: 'vs' }, ['L', 'I', 'g', 'vd', 'vs']),
      {
        vd: 'V_out_dc - V_a',
        vs: 'V_a',
      },
    ),
    blk(
      'casc_p',
      dev('p', { L: 'L', id: 'I', gm_id: 'g', vds: 'vd', vsb: 'vs' }, ['L', 'I', 'g', 'vd', 'vs']),
      {
        vd: 'sign_p*(V_b - V_out_dc)',
        vs: 'VDD - V_b',
      },
    ),
    blk('mir', dev('p', { L: 'L', id: 'I', gm_id: 'g', vds: 'vd' }, ['L', 'I', 'g', 'vd']), {
      vd: 'sign_p*(VDD - V_b)',
    }),
  ],
);

const cascodeMirror = sheetOf(
  'Cascode current mirror',
  [
    indep('V_out'),
    { name: 'k_x', value: 1, min: 0.5, max: 2, solveFor: 'k_casc' },
    { name: 'K', value: 1 },
  ],
  [
    blk('ref', dev('n', { L: 'L', id: 'I', gm_id: 'g', diode: true }, ['L', 'I', 'g']), {}),
    blk(
      'ref_casc',
      dev('n', { L: 'L', id: 'I', gm_id: 'g', diode: true, vsb: 'vs' }, ['L', 'I', 'g', 'vs']),
      {
        vs: 'ref__vgs',
      },
    ),
    blk('out', dev('n', { L: 'L', W: 'w', vgs: 'vg', vds: 'vd' }, ['L', 'w', 'vg', 'vd']), {
      w: 'K*ref__W',
      vg: 'ref__vgs',
      vd: 'k_x*ref__vgs',
    }),
  ],
  {
    givens: {
      L: 'L',
      W: 'K*ref_casc__W',
      id: 'out__id',
      vds: 'V_out - k_x*ref__vgs',
      vsb: 'k_x*ref__vgs',
    },
    equations: [{ name: 'k_casc', expr: '(ref__vgs + ref_casc__vgs - vgs)/ref__vgs' }],
  },
);

describe('the drafts for library sheets', () => {
  it('drafts the five-transistor OTA from its node expressions', () => {
    const p = proposeWiring(fiveT);
    // in: vds = V_out_dc - V_tail, vsb = V_tail. ld: vds = ld_sign*(VDD - V_out_dc), a p device.
    expect(wireOf(p, 'in', 'd')).toBe('out_dc');
    expect(wireOf(p, 'ld', 'd')).toBe('out_dc');
    expect(wireOf(p, 'in', 's')).toBe('tail');
    expect(wireOf(p, 'in', 'b')).toBe('gnd');
    // inr: vds = VDD - abs(ldr__vgs) - V_tail — its drain is the level the p diode's gate sits at,
    // one |vgs| below VDD.
    expect(wireOf(p, 'inr', 's')).toBe('tail');
    expect(wireOf(p, 'inr', 'd')).toBe(wireOf(p, 'ldr', 'g'));
    // tail: vds = V_tail over ground, on the bias diode's gate (vgs tie).
    expect(wireOf(p, 'tail', 'd')).toBe('tail');
    expect(wireOf(p, 'tail', 'g')).toBe(wireOf(p, 'bias', 'g'));
    expect(wireOf(p, 'bias', 's')).toBe('gnd');
    // ld is the p diode's mirror: same gate and source, the source at VDD.
    expect(wireOf(p, 'ld', 'g')).toBe(wireOf(p, 'ldr', 'g'));
    expect(wireOf(p, 'ld', 's')).toBe('vdd');
    expect(wireOf(p, 'ldr', 's')).toBe('vdd');
    // Nothing places the two input gates.
    expect(markOf(p, 'in', 'g')).toBe('unknown');
    expect(markOf(p, 'inr', 'g')).toBe('unknown');
    // Held: the supply, and the output the application holds — whose current is reported. Not
    // held: the tail node, which the engine solves.
    expect(p.levels.map((l) => [l.wire, l.expr, l.held])).toEqual([
      ['out_dc', 'V_out_dc', 'held'],
      ['vdd', 'VDD', 'held'],
    ]);
    expect(p.notes).toContain(
      'wire "out_dc" is held at V_out_dc, and currents arrive and leave there: the check will report ' +
        'the current at that wire, as what an ideal source holding it supplies',
    );
    expect(p.notes.some((n) => n.startsWith('wire "vdd" is held'))).toBe(false);
    expect(p.notes.some((n) => n.includes('wire "tail" sits at V_tail, which is derived'))).toBe(
      true,
    );
    expect(p.selectors).toEqual([{ at: '', param: 'ld_sign' }]);
  });

  it('drafts the telescopic OTA, holding each cascode gate at its hold expression', () => {
    const p = proposeWiring(telescopic);
    expect(wireOf(p, 'in', 'd')).toBe('a');
    expect(wireOf(p, 'casc_n', 's')).toBe('a');
    expect(wireOf(p, 'casc_n', 'd')).toBe('out_dc');
    expect(wireOf(p, 'casc_p', 'd')).toBe('out_dc');
    expect(wireOf(p, 'casc_p', 's')).toBe('b');
    expect(wireOf(p, 'mir', 'd')).toBe('b');
    expect(wireOf(p, 'casc_p', 'b')).toBe('vdd');
    const held = Object.fromEntries(p.levels.map((l) => [l.wire, [l.expr, l.held]]));
    expect(held[wireOf(p, 'casc_n', 'g')]).toEqual(['V_a + casc_n__vgs', 'held-gate']);
    expect(held[wireOf(p, 'casc_p', 'g')]).toEqual(['V_b - abs(casc_p__vgs)', 'held-gate']);
    expect(held.a).toBeUndefined();
    expect(held.b).toBeUndefined();
  });

  it('drafts the cascode current mirror, and leaves a drain written as a product unplaced', () => {
    const p = proposeWiring(cascodeMirror);
    // ref_casc: vsb = ref__vgs, read whole, puts its source one reference vgs above a grounded body.
    expect(wireOf(p, 'ref_casc', 'b')).toBe('gnd');
    expect(markOf(p, 'ref_casc', 'd')).toBe('certain');
    expect(wireOf(p, 'out', 'g')).toBe(wireOf(p, 'ref', 'g'));
    // The sheet's own device: vds = V_out - k_x*ref__vgs puts its drain on V_out's wire and its
    // source at k_x*ref__vgs, which its vsb confirms over a grounded body.
    expect(wireOf(p, 'givens', 'd')).toBe('out');
    expect(wireOf(p, 'givens', 'b')).toBe('gnd');
    // out: vds = k_x*ref__vgs is one value but not a bare name or number, so it places nothing.
    expect(markOf(p, 'out', 'd')).toBe('unknown');
    expect(p.notes).toContain(
      '"out": vds = k_x*ref__vgs is not a difference of two levels, so where its drain and source ' +
        'sit is left for the author',
    );
    expect(p.levels.map((l) => [l.wire, l.expr])).toEqual([['out', 'V_out']]);
  });

  it('drafts a source follower without shorting its output: a compound vds places nothing', () => {
    // The library's source follower: vds = VDD - V_in + vgs_est has a sum at its top, so it is not a
    // difference of two levels; read as one level, it put the source on gnd.
    const follower = sheetOf(
      'follower',
      [indep('VDD'), indep('V_in'), { name: 'vgs_est', value: 0.6 }],
      [],
      {
        givens: { L: 'L', id: 'I', gm_id: 'g', vds: 'VDD - V_in + vgs_est' },
        params: [
          indep('VDD'),
          indep('V_in'),
          { name: 'vgs_est', value: 0.6, solveFor: 'vgs', min: 0.2, max: 1.5 },
          { name: 'L', value: 1 },
          { name: 'I', value: 1 },
          { name: 'g', value: 1 },
        ],
      },
    );
    const p = proposeWiring(follower);
    expect(wireOf(p, 'givens', 's')).not.toBe('gnd');
    expect(markOf(p, 'givens', 's')).not.toBe('certain');
    expect(p.notes).toContain(
      "this sheet's own device: vds = VDD - V_in + vgs_est is not a difference of two levels, so " +
        'where its drain and source sit is left for the author',
    );
  });

  it("drafts the cascode-compensated OTA's cascode on the source its vsb names, its drain a drop above", () => {
    // casc: vds = V_casc is a drain-source drop and vsb = VDD - abs(ld1__vgs) - V_casc the source
    // level over a grounded body; in: its drain at VDD - abs(ld1__vgs) - V_casc. Read before the
    // fix, casc's source landed on gnd and its body on the casc wire.
    const comp = sheetOf(
      'cascode-comp',
      [indep('VDD'), v('V_casc', { class: 'independent' }), v('V_tail', { class: 'independent' })],
      [
        blk('ld1', dev('p', { L: 'L', id: 'I', gm_id: 'g', diode: true }, ['L', 'I', 'g']), {}),
        blk(
          'in',
          dev('n', { L: 'L', id: 'I', gm_id: 'g', vds: 'vd', vsb: 'vs' }, [
            'L',
            'I',
            'g',
            'vd',
            'vs',
          ]),
          {
            vd: 'VDD - abs(ld1__vgs) - V_casc - V_tail',
            vs: 'V_tail',
          },
        ),
        blk(
          'casc',
          dev('n', { L: 'L', id: 'I', gm_id: 'g', vds: 'vd', vsb: 'vs' }, [
            'L',
            'I',
            'g',
            'vd',
            'vs',
          ]),
          {
            vd: 'V_casc',
            vs: 'VDD - abs(ld1__vgs) - V_casc',
          },
        ),
      ],
    );
    const p = proposeWiring(comp);
    expect(wireOf(p, 'casc', 's')).toBe(wireOf(p, 'in', 'd'));
    expect(wireOf(p, 'casc', 'b')).toBe('gnd');
    expect(wireOf(p, 'casc', 's')).not.toBe('gnd');
    const why = p.devices.find((d) => d.device === 'casc')!.nodes.d.why;
    expect(
      why.some((w) =>
        w.startsWith(
          'vds = V_casc is a drop above the source the vsb places, so the drain is at ' +
            '(VDD - abs(ld1__vgs) - V_casc) + V_casc',
        ),
      ),
      why.join(' | '),
    ).toBe(true);
    // The drain is a different wire from the source and from ground.
    expect(new Set([wireOf(p, 'casc', 'd'), wireOf(p, 'casc', 's'), 'gnd']).size).toBe(3);
  });

  it('prints a draft for an author to read', () => {
    const text = formatWiringProposal(proposeWiring(fiveT));
    expect(text.split('\n')[0]).toBe('Wiring proposal for "5T OTA"');
    expect(text).toContain(
      '"in": d=out_dc (inferred)  g=in_g (unknown)  s=tail (inferred)  b=gnd (inferred)',
    );
  });
});

describe('a derived node', () => {
  it('is never held: V1 = VDD - abs(s2__vgs), set by the stage-2 device', () => {
    // The fully differential two-stage OTA's V1.
    const doc = sheetOf(
      'fd',
      [indep('VDD')],
      [blk('s2', dev('p', { L: 'L', id: 'I', gm_id: 'g', vds: 'vd' }, ['L', 'I', 'g', 'vd']), {})],
      { equations: [{ name: 'V1', expr: 'VDD - abs(s2__vgs)' }] },
    );
    const verdict = levelEligibility(doc, '', 'V1');
    expect(verdict.kind).toBe('refused');
    const problems = verdict.kind === 'refused' ? verdict.problems : [];
    expect(problems).toContain('it reads equation "V1"');
    expect(problems).toContain(
      'it reads a quantity of "s2", and a level derived from a device is never held',
    );
  });
});

/** A document with every netlist key taken off, and the diode connections its wires stated made
 *  explicit — the same design with nothing said about its wiring. */
function unwired(doc: SheetDoc): SheetDoc {
  const strip = (d: SheetDoc): SheetDoc => {
    const out = { ...d } as Record<string, unknown>;
    for (const k of ['nodes', 'levels', 'elements', 'ports', 'analyses']) delete out[k];
    const rest = out as unknown as SheetDoc;
    if (rest.blocks)
      rest.blocks = rest.blocks.map((b) => {
        const { nodes: _n, ports: _p, ...kept } = b;
        return kept.doc ? { ...kept, doc: strip(kept.doc) } : kept;
      });
    return rest;
  };
  return strip(structuralDiodes(doc));
}

describe('wiring changes no number', () => {
  it('gives every library sheet the same values and checks with its netlist as without it', () => {
    for (const { file, doc } of loadLibrary()) {
      const wired = runSheet(doc, table, () => table, REFS);
      const bare = runSheet(unwired(doc), table, () => table, REFS);
      expect(wired.values, file).toEqual(bare.values);
      expect(wired.checks, file).toEqual(bare.checks);
    }
  });
});

describe('carrying the netlist through a loader', () => {
  const raw = {
    formatVersion: 2,
    nodes: { d: 'o', g: 'i', s: 'gnd', b: 'gnd' },
    levels: { i: 'V_in' },
    elements: [{ name: 'R1', kind: 'R', between: ['o', 'vdd'], value: 1e3 }],
    ports: ['o'],
    analyses: [{ name: 'G', kind: 'gain', in: { i: 1 }, out: { o: 1 }, at: 1e3 }],
  };

  it('keeps every netlist key as written', () => {
    const lost: string[] = [];
    expect(carriedDocWiring(raw, lost)).toEqual(raw);
    expect(lost).toEqual([]);
  });

  it('records a piece it cannot carry instead of dropping it silently', () => {
    const lost: string[] = [];
    const out = carriedDocWiring(
      { nodes: { d: 'o', g: 'i', s: 'gnd', b: 'gnd', x: 1 }, levels: [] },
      lost,
    );
    expect(out.nodes).toEqual({ d: 'o', g: 'i', s: 'gnd', b: 'gnd' });
    expect(lost).toEqual(['nodes.x', 'levels']);
    const blockLost: string[] = [];
    expect(
      carriedBlockWiring(
        { nodes: [{ d: 'a', g: 'a', s: 'gnd', b: 'gnd' }], ports: { p: 3 } },
        'blocks[0].',
        blockLost,
      ),
    ).toEqual({
      nodes: [{ d: 'a', g: 'a', s: 'gnd', b: 'gnd' }],
      ports: {},
    });
    expect(blockLost).toEqual(['blocks[0].ports.p']);
    const paramLost: string[] = [];
    expect(carriedConvention({ convention: 'axis-sign' }, 'params[0].', paramLost)).toEqual({
      convention: 'axis-sign',
    });
    expect(carriedConvention({ convention: 'sign' }, 'params[0].', paramLost)).toEqual({});
    expect(paramLost).toEqual(['params[0].convention']);
  });
});
