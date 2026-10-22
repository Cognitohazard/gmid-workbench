// The structural analysis, on synthetic graphs with known parts and on the sheets that
// motivate it. The library census at the end pins what the whole library looks like through it:
// which sheets solve, which solved params read each other, and in what order they settle.

import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './examples';
import { REFS, loadLibrary, sheet } from './library.fixtures';
import {
  analyzeStructure,
  decomposeGraph,
  widthInvariant,
  type StructureAssumption,
  type StructureMode,
  type StructureReport,
} from './structure';
import type { SheetDoc, SheetGivens } from './types';

describe('decomposeGraph', () => {
  it('a square chain: every unknown matched, no parts, one component per unknown in order', () => {
    const d = decomposeGraph({
      unknowns: ['a', 'b', 'c'],
      relations: [
        { id: 'r1', reads: ['a'] },
        { id: 'r2', reads: ['b', 'a'] },
        { id: 'r3', reads: ['c', 'b'] },
      ],
    });
    expect(d.over).toEqual([]);
    expect(d.under).toEqual([]);
    expect(d.components).toEqual([['a'], ['b'], ['c']]);
    expect([...d.matching]).toEqual([
      ['a', 'r1'],
      ['b', 'r2'],
      ['c', 'r3'],
    ]);
  });

  it('over-determined by one: both relations of the one unknown are in the over part', () => {
    const d = decomposeGraph({
      unknowns: ['a'],
      relations: [
        { id: 'r1', reads: ['a'] },
        { id: 'r2', reads: ['a'] },
      ],
    });
    expect(d.over).toEqual(['r1', 'r2']);
    expect(d.under).toEqual([]);
    expect(d.components).toEqual([]);
  });

  it('over-determined by two, beside a well-determined unknown the conflict does not reach', () => {
    const d = decomposeGraph({
      unknowns: ['a', 'b'],
      relations: [
        { id: 'r1', reads: ['a'] },
        { id: 'r2', reads: ['a'] },
        { id: 'r3', reads: ['a'] },
        { id: 'r4', reads: ['b'] },
      ],
    });
    expect(d.over).toEqual(['r1', 'r2', 'r3']);
    expect(d.components).toEqual([['b']]);
  });

  it('under-determined: two unknowns sharing one relation are both free', () => {
    const d = decomposeGraph({
      unknowns: ['a', 'b', 'c'],
      relations: [
        { id: 'r1', reads: ['a'] },
        { id: 'r2', reads: ['b', 'c'] },
      ],
    });
    expect(d.over).toEqual([]);
    expect(d.under).toEqual(['b', 'c']);
    expect(d.components).toEqual([['a']]);
  });

  it('a loop of two, after the unknown it depends on', () => {
    const d = decomposeGraph({
      unknowns: ['a', 'b', 'c'],
      relations: [
        { id: 'r1', reads: ['a'] },
        { id: 'r2', reads: ['b', 'c', 'a'] },
        { id: 'r3', reads: ['c', 'b'] },
      ],
    });
    expect(d.components).toEqual([['a'], ['b', 'c']]);
  });

  it('a loop of three', () => {
    const d = decomposeGraph({
      unknowns: ['a', 'b', 'c'],
      relations: [
        { id: 'r1', reads: ['a', 'b'] },
        { id: 'r2', reads: ['b', 'c'] },
        { id: 'r3', reads: ['c', 'a'] },
      ],
    });
    expect(d.components).toEqual([['a', 'b', 'c']]);
  });

  it('the preferred pairs seed the matching where a maximum matching allows', () => {
    const g = {
      unknowns: ['a', 'b'],
      relations: [
        { id: 'r1', reads: ['a', 'b'] },
        { id: 'r2', reads: ['a', 'b'] },
      ],
    };
    const plain = decomposeGraph(g);
    expect(plain.matching.get('a')).toBe('r1');
    const seeded = decomposeGraph(
      g,
      new Map([
        ['r1', 'b'],
        ['r2', 'a'],
      ]),
    );
    expect(seeded.matching.get('a')).toBe('r2');
    expect(seeded.matching.get('b')).toBe('r1');
    expect(seeded.components).toEqual(plain.components);
  });
});

describe('widthInvariant', () => {
  it('reads the width law off the namespace', () => {
    expect(widthInvariant('vgs')).toBe(true);
    expect(widthInvariant('gm_id')).toBe(true);
    expect(widthInvariant('vstar')).toBe(true);
    expect(widthInvariant('av0')).toBe(true);
    expect(widthInvariant('ft')).toBe(true);
    expect(widthInvariant('W')).toBe(false);
    expect(widthInvariant('gm')).toBe(false);
    expect(widthInvariant('cgg')).toBe(false);
    expect(widthInvariant('vnth_m')).toBe(false);
  });

  it('reads a quantity the namespace does not know as width-dependent, the safe direction', () => {
    expect(widthInvariant('some_column')).toBe(false);
  });
});

const relation = (r: StructureReport, id: string) => {
  const hit = r.relations.find((x) => x.id === id);
  if (!hit) throw new Error(`no relation ${id}`);
  return hit;
};

describe('analyzeStructure', () => {
  const nmos = EXAMPLES[0];

  it('the single-device example is square with nothing to solve, in both modes', () => {
    for (const mode of ['size', 'verify'] as const) {
      const r = analyzeStructure(nmos, { mode });
      expect(r.over).toEqual([]);
      expect(r.under).toEqual([]);
      expect(r.sets).toEqual([]);
      expect(r.cycles).toEqual([]);
      expect(r.unresolved).toEqual([]);
      expect(r.dof).toBe(0);
    }
  });

  it('a device coordinate nothing places is free: a drain voltage left unstated', () => {
    const givens: SheetGivens = { ...(nmos.givens as SheetGivens) };
    delete givens.vds;
    const r = analyzeStructure({ ...nmos, givens });
    expect(r.under).toEqual(['d:vds']);
    expect(r.dof).toBe(1);
  });

  it('a table relation reads the width only for a quantity that scales with it', () => {
    const r = analyzeStructure(nmos);
    // The capacitance the output pole reads scales with the width; the noise density too.
    expect(relation(r, 't:cgg').reads).toContain('d:W');
    expect(relation(r, 't:vnth_m').reads).toContain('d:W');
    // The gate voltage of a device bound by its selector reads the selector and the bias.
    expect(relation(r, 't:vgs').reads).toEqual(['d:vgs', 'd:L', 'd:vds', 'd:vsb', 'd:gm_id']);
    // The width reads the gate voltage, the bias and the extensive given.
    expect(relation(r, 't:W').reads).toEqual(['d:W', 'd:vgs', 'd:L', 'd:vds', 'd:vsb', 'd:gm']);
  });

  it('one design constraint is one inversion, paired with the param that carries it', () => {
    const r = analyzeStructure(sheet('otas/differential-pair-tail.json'), { refs: REFS });
    expect(r.sets).toEqual([{ params: ['p:V_tail'], relations: ['c:V_tail'] }]);
    expect(r.pairing).toEqual({ 'c:V_tail': 'p:V_tail' });
    expect(r.depends['c:V_tail']).toEqual(['p:V_tail']);
    expect(r.suggestions).toEqual([]);
  });

  it('a constraint that reads no solved param is a conflict, and its param is free', () => {
    const doc: SheetDoc = {
      title: 'conflict',
      polarity: 'n',
      params: [
        { name: 'A', value: 1, unit: 'V', role: 'spec' },
        { name: 'B', value: 2, unit: 'V', role: 'spec' },
        {
          name: 'x',
          value: 0.5,
          min: 0,
          max: 1,
          unit: 'V',
          role: 'choice',
          designConstraint: { lhs: 'A', rhs: 'B' },
        },
      ],
      equations: [],
      checks: [],
    };
    const r = analyzeStructure(doc);
    expect(r.over).toEqual(['c:x']);
    expect(r.under).toEqual(['p:x']);
    expect(r.depends['c:x']).toEqual([]);
    expect(r.sets).toEqual([]);
    expect(r.dof).toBe(1);
  });

  describe('the five-transistor OTA', () => {
    const doc = sheet('otas/five-transistor-ota.json');

    it('its two solved params read each other, in both modes: one loop of two', () => {
      for (const mode of ['size', 'verify'] as const) {
        const r = analyzeStructure(doc, { mode, refs: REFS });
        expect(r.over).toEqual([]);
        expect(r.under).toEqual([]);
        expect(r.sets).toEqual([
          { params: ['p:V_tail', 'p:out_share'], relations: ['c:V_tail', 'c:out_share'] },
        ]);
        expect(r.depends).toEqual({
          'c:V_tail': ['p:V_tail', 'p:out_share'],
          'c:out_share': ['p:V_tail', 'p:out_share'],
        });
        expect(r.pairing).toEqual({
          'c:V_tail': 'p:V_tail+p:out_share',
          'c:out_share': 'p:V_tail+p:out_share',
        });
      }
    });

    it('the gate voltage of the selector-bound side reads no current; the mirrored side, placed by its width and its current, reads both', () => {
      const r = analyzeStructure(doc, { refs: REFS });
      const vgs = relation(r, 't:in.vgs').reads;
      expect(vgs).toContain('d:in.gm_id');
      expect(vgs).not.toContain('d:in.id');
      expect(vgs).not.toContain('d:in.W');
      const mirrored = relation(r, 't:inr.vgs').reads;
      expect(mirrored).toContain('d:inr.W');
      expect(mirrored).toContain('d:inr.id');
    });

    it('held, the pair keeps its width and its authored current, so its gate voltage reads both', () => {
      const r = analyzeStructure(doc, { mode: 'verify', refs: REFS });
      expect(relation(r, 'f:in.W').kind).toBe('fixed');
      const vgs = relation(r, 't:in.vgs').reads;
      expect(vgs).toContain('d:in.W');
      expect(vgs).toContain('d:in.id');
      expect(r.relations.find((x) => x.id === 't:in.W')).toBeUndefined();
    });

    it('offers the re-pairing that frees the loop, and never a convention', () => {
      const r = analyzeStructure(doc, { refs: REFS });
      expect(r.suggestions).toContainEqual({ decide: 'V_tail', derive: 'CM_dc', loops: [] });
      expect(r.suggestions.map((s) => s.derive)).not.toContain('ld_sign');
    });

    it('reports the implementation knobs left at their defaults', () => {
      const r = analyzeStructure(doc, { refs: REFS });
      expect(r.defaulted).toEqual([
        'I_tail',
        'gm_id_in',
        'gm_id_ld',
        'gm_id_tail',
        'L_in',
        'L_ld',
        'L_tail',
      ]);
    });
  });

  it('a hold is a residual only where the design is held: the differential telescopic stage', () => {
    const doc = sheet('multistage/fd-telescopic-ota.json');
    const sized = analyzeStructure(doc, { refs: REFS });
    expect(sized.sets).toEqual([]);
    const held = analyzeStructure(doc, { mode: 'verify', refs: REFS });
    expect(held.sets.map((s) => s.params)).toEqual([['p:V_s', 'p:V_a'], ['p:V_b']]);
    expect(held.sets.map((s) => s.relations)).toEqual([['h:V_s', 'h:V_a'], ['h:V_b']]);
    expect(held.suggestions).toContainEqual({ decide: 'V_s', derive: 'V_out', loops: [] });
  });

  it('the cascode OTAs as authored are loops of more than two', () => {
    const sizes = (file: string, mode: StructureMode): number[] =>
      analyzeStructure(sheet(file), { mode, refs: REFS })
        .sets.filter((s) => s.params.length > 1)
        .map((s) => s.params.length);
    expect(sizes('otas/telescopic-cascode-ota.json', 'size')).toEqual([4]);
    expect(sizes('otas/telescopic-cascode-ota.json', 'verify')).toEqual([6]);
    expect(sizes('otas/folded-cascode-ota.json', 'size')).toEqual([4]);
    expect(sizes('otas/folded-cascode-ota.json', 'verify')).toEqual([6]);
    expect(sizes('multistage/two-stage-cascode-comp-ota.json', 'size')).toEqual([3]);
    expect(sizes('otas/current-mirror-ota.json', 'size')).toEqual([2]);
    expect(sizes('otas/current-mirror-ota.json', 'verify')).toEqual([3]);
  });
});

describe('under an assumption', () => {
  const five = sheet('otas/five-transistor-ota.json');
  const chain = (file: string, mode: StructureMode, assume: StructureAssumption[]): string[][] =>
    analyzeStructure(sheet(file), { mode, refs: REFS, assume }).sets.map((s) => s.params);

  it('without channel-length modulation the five-transistor pair is a chain, split first', () => {
    for (const mode of ['size', 'verify'] as const) {
      const r = analyzeStructure(five, {
        mode,
        refs: REFS,
        assume: ['no-channel-length-modulation'],
      });
      expect(r.assume).toEqual(['no-channel-length-modulation']);
      expect(r.sets.map((s) => s.params)).toEqual([['p:out_share'], ['p:V_tail']]);
      // The pair's gate voltage no longer reads its drain voltage; the body bias it still reads.
      const vgs = relation(r, 't:in.vgs').reads;
      expect(vgs).not.toContain('d:in.vds');
      expect(vgs).toContain('d:in.vsb');
    }
  });

  it('without body effect nothing changes: the loop runs through the drain voltages', () => {
    expect(chain('otas/five-transistor-ota.json', 'size', ['no-body-effect'])).toEqual([
      ['p:V_tail', 'p:out_share'],
    ]);
  });

  it('with ideal mirrors a copied device carries the reference current and the ratio, and the pair is a chain', () => {
    const r = analyzeStructure(five, { refs: REFS, assume: ['ideal-mirrors'] });
    expect(relation(r, 't:tail.id').reads).toEqual(['d:tail.id', 'd:bias.id']);
    expect(relation(r, 't:ld.id').reads).toEqual(['d:ld.id', 'd:ldr.id']);
    expect(r.sets.map((s) => s.params)).toEqual([['p:out_share'], ['p:V_tail']]);
  });

  it('every loop in the library runs through a mirror drain-voltage error: one assumption makes each a chain', () => {
    const looped = [
      'otas/five-transistor-ota.json',
      'multistage/two-stage-miller-ota.json',
      'otas/current-mirror-ota.json',
      'multistage/two-stage-cascode-comp-ota.json',
      'otas/telescopic-cascode-ota.json',
      'otas/folded-cascode-ota.json',
      'multistage/fd-telescopic-ota.json',
    ];
    for (const file of looped)
      for (const mode of ['size', 'verify'] as const) {
        expect(
          chain(file, mode, []).some((s) => s.length > 1) ||
            (file.includes('fd-') && mode === 'size'),
        ).toBe(true);
        for (const assume of [
          ['no-channel-length-modulation'],
          ['ideal-mirrors'],
        ] as StructureAssumption[][])
          expect(chain(file, mode, assume).every((s) => s.length === 1)).toBe(true);
      }
  });
});

/** One line per sheet and mode: what is solved, the parts, the loops, and the order. */
const line = (file: string, mode: StructureMode, r: StructureReport): string => {
  const solved = r.sets.reduce((n, s) => n + s.params.length, 0);
  const loops = r.sets.filter((s) => s.params.length > 1).map((s) => s.params.length);
  const order = r.sets.map((s) => s.params.map((p) => p.slice(2)).join('+')).join(' ');
  return (
    `${file.replace('.json', '')} [${mode}] solved ${solved}; over ${r.over.length}, ` +
    `under ${r.under.length}; loops [${loops.join(' ')}]; cycles ${r.cycles.length}; ` +
    `unresolved ${r.unresolved.length}; defaulted ${r.defaulted.length}; order ${order}`
  ).trimEnd();
};

const CENSUS: readonly string[] = [
  'applications/gm-c-filter-pole [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'applications/gm-c-filter-pole [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'applications/ldo-pass-device-error-amp [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'applications/ldo-pass-device-error-amp [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'applications/preamp-latch-comparator [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'applications/preamp-latch-comparator [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'applications/sc-settling-to-ota-spec [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'applications/sc-settling-to-ota-spec [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'applications/strongarm-comparator [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'applications/strongarm-comparator [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'applications/track-and-hold-budget [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'applications/track-and-hold-budget [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'mirrors-bias/beta-multiplier-bias [size] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order I_bias',
  'mirrors-bias/beta-multiplier-bias [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order I_bias',
  'mirrors-bias/cascode-current-mirror [size] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 5; order k_x',
  'mirrors-bias/cascode-current-mirror [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 5; order k_x',
  'mirrors-bias/degenerated-current-mirror [size] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order k_s',
  'mirrors-bias/degenerated-current-mirror [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order k_s',
  'mirrors-bias/matched-mirror-bank [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'mirrors-bias/matched-mirror-bank [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'mirrors-bias/simple-mirror [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'mirrors-bias/simple-mirror [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'mirrors-bias/wide-swing-cascode-mirror [size] solved 2; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 5; order vds_lo k_x',
  'mirrors-bias/wide-swing-cascode-mirror [verify] solved 2; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 5; order vds_lo k_x',
  'mirrors-bias/widlar-current-source [size] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order I_out',
  'mirrors-bias/widlar-current-source [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order I_out',
  'multistage/class-ab-output-monticelli [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 6; order',
  'multistage/class-ab-output-monticelli [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 6; order',
  'multistage/fd-telescopic-ota [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 15; order',
  'multistage/fd-telescopic-ota [verify] solved 3; over 0, under 0; loops [2]; cycles 0; unresolved 0; defaulted 15; order V_s+V_a V_b',
  'multistage/fd-two-stage-ota [size] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 14; order V_tail',
  'multistage/fd-two-stage-ota [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 14; order V_tail',
  'multistage/flipped-voltage-follower [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 7; order',
  'multistage/flipped-voltage-follower [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 7; order V_out',
  'multistage/rail-to-rail-input-stage [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 6; order',
  'multistage/rail-to-rail-input-stage [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 6; order',
  'multistage/stage2-current-source-load [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 2; order',
  'multistage/stage2-current-source-load [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 2; order',
  'multistage/super-source-follower [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 7; order',
  'multistage/super-source-follower [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 7; order vds_fb',
  'multistage/two-stage-cascode-comp-ota [size] solved 3; over 0, under 0; loops [3]; cycles 0; unresolved 0; defaulted 17; order V_tail+out_share+V_casco',
  'multistage/two-stage-cascode-comp-ota [verify] solved 4; over 0, under 0; loops [4]; cycles 0; unresolved 0; defaulted 17; order V_tail+out_share+V_casc+V_casco',
  'multistage/two-stage-miller-ota [size] solved 2; over 0, under 0; loops [2]; cycles 0; unresolved 0; defaulted 14; order V_tail+out_share',
  'multistage/two-stage-miller-ota [verify] solved 2; over 0, under 0; loops [2]; cycles 0; unresolved 0; defaulted 14; order V_tail+out_share',
  'otas/current-mirror-ota [size] solved 3; over 0, under 0; loops [2]; cycles 0; unresolved 0; defaulted 8; order V_nmir V_tail+out_share',
  'otas/current-mirror-ota [verify] solved 3; over 0, under 0; loops [3]; cycles 0; unresolved 0; defaulted 8; order V_tail+V_nmir+out_share',
  'otas/degenerated-differential-pair [size] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 6; order V_tail',
  'otas/degenerated-differential-pair [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 6; order V_tail',
  'otas/differential-pair-tail [size] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 5; order V_tail',
  'otas/differential-pair-tail [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 5; order V_tail',
  'otas/five-transistor-ota [size] solved 2; over 0, under 0; loops [2]; cycles 0; unresolved 0; defaulted 7; order V_tail+out_share',
  'otas/five-transistor-ota [verify] solved 2; over 0, under 0; loops [2]; cycles 0; unresolved 0; defaulted 7; order V_tail+out_share',
  'otas/folded-cascode-ota [size] solved 4; over 0, under 0; loops [4]; cycles 0; unresolved 0; defaulted 12; order V_tail+V_fold_r+V_c_r+out_share',
  'otas/folded-cascode-ota [verify] solved 6; over 0, under 0; loops [6]; cycles 0; unresolved 0; defaulted 12; order V_tail+V_fold+V_c+V_fold_r+V_c_r+out_share',
  'otas/gain-boosted-cascode-ota [size] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 15; order V_tail',
  'otas/gain-boosted-cascode-ota [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 15; order V_tail',
  'otas/inverter-based-ota [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'otas/inverter-based-ota [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order I_bias',
  'otas/telescopic-cascode-ota [size] solved 4; over 0, under 0; loops [4]; cycles 0; unresolved 0; defaulted 11; order V_tail+V_ar+V_br+out_share',
  'otas/telescopic-cascode-ota [verify] solved 6; over 0, under 0; loops [6]; cycles 0; unresolved 0; defaulted 11; order V_tail+V_a+V_b+V_ar+V_br+out_share',
  'stages/cascode-cs-amp [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 7; order',
  'stages/cascode-cs-amp [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 7; order V_x',
  'stages/cmos-inverter-amp [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'stages/cmos-inverter-amp [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order I_bias',
  'stages/common-gate [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'stages/common-gate [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'stages/cs-amp-current-source-load [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 5; order',
  'stages/cs-amp-current-source-load [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 5; order',
  'stages/cs-amp-diode-load [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 5; order',
  'stages/cs-amp-diode-load [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 5; order',
  'stages/cs-amp-resistive-load [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'stages/cs-amp-resistive-load [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'stages/sampling-switch [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'stages/sampling-switch [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order',
  'stages/source-degenerated-cs-amp [size] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'stages/source-degenerated-cs-amp [verify] solved 0; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 4; order',
  'stages/source-follower [size] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order vgs_est',
  'stages/source-follower [verify] solved 1; over 0, under 0; loops []; cycles 0; unresolved 0; defaulted 3; order vgs_est',
];

describe('the library census', () => {
  it('every sheet is square, with no circular definition and no unresolved name', () => {
    for (const { doc } of loadLibrary())
      for (const mode of ['size', 'verify'] as const) {
        const r = analyzeStructure(doc, { mode, refs: REFS });
        expect(r.over).toEqual([]);
        expect(r.under).toEqual([]);
        expect(r.cycles).toEqual([]);
        expect(r.unresolved).toEqual([]);
      }
  });

  it('is pinned, sheet by sheet', () => {
    const lines: string[] = [];
    for (const { file, doc } of loadLibrary())
      for (const mode of ['size', 'verify'] as const)
        lines.push(line(file, mode, analyzeStructure(doc, { mode, refs: REFS })));
    expect(lines).toEqual(CENSUS);
  });
});
