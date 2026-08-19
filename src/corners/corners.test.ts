// Corner families: identity derived from the data, one run at one condition, and the four
// outcomes an aggregate is allowed to report.
//
// The device fixtures are hand-built (grouping and QA only ever read identity and shape) or
// the demo model retagged, and every numeric expectation is derived from the model's closed
// forms — gm/gds = (gm/ID)·VA with VA = VA_PER_L·L — never read back off the engine.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice, scaleQuantities, VA_PER_L } from '../demo';
import { makeGrid } from '../grid';
import { validateFamilies, validateFamily } from '../qa';
import { loadLibrary } from '../sheet/library.fixtures';
import { namedBindings, runSheet, buildSheetRefIndex } from '../sheet';
import type { RuleResult, SheetDoc, SheetResult } from '../sheet';
import type { Axis, DeviceTable, TableMeta } from '../types';
import {
  aggregateVariantRuns,
  familyIdentityOf,
  familyUidOf,
  groupFamilies,
  preflightVariant,
  runVariant,
  runVariants,
  sameVariant,
  variantAt,
  variantKeyId,
  variantKeyOf,
  variantLabel,
  type CornerFamily,
  type VariantKey,
  type VariantRun,
} from './index';

// --- fixtures ----------------------------------------------------------------

interface TableSpec {
  device?: string;
  corner?: string;
  temp?: number;
  meta?: TableMeta;
  /** Axis name → values, in grid order. */
  axes?: Record<string, number[]>;
  /** Quantity column keys (values are irrelevant to identity and shape checks). */
  quantities?: string[];
}

function table(spec: TableSpec = {}): DeviceTable {
  const axes: Axis[] = Object.entries(spec.axes ?? { vgs: [0, 0.1, 0.2] }).map(
    ([name, values]) => ({ name, values: Float64Array.from(values) }),
  );
  const size = axes.reduce((n, a) => n * a.values.length, 1);
  const quantities = new Map<string, Float64Array>();
  for (const key of spec.quantities ?? ['id', 'gm']) quantities.set(key, new Float64Array(size));
  return {
    id: {
      device: spec.device ?? 'nch',
      corner: spec.corner ?? 'tt',
      temp: spec.temp ?? 27,
    },
    grid: makeGrid(axes, quantities),
    meta: spec.meta ?? {},
  };
}

/** The one family `tables` group into — the shape most tests below assert on. */
function soleFamily(tables: DeviceTable[]): CornerFamily {
  const families = groupFamilies(tables);
  expect(families).toHaveLength(1);
  return families[0];
}

const key = (corner: string, temp = 27): VariantKey => ({ corner, temp });

const dev = generateDemoDevice();

/** The demo device presented as another condition of the same logical device. */
function retag(t: DeviceTable, corner: string, temp = 27, meta: TableMeta = {}): DeviceTable {
  return { ...t, id: { ...t.id, corner, temp }, meta: { ...t.meta, ...meta } };
}

// --- variant identity --------------------------------------------------------

describe('variant identity', () => {
  it('canonicalizes the corner spelling, so one condition is one key', () => {
    expect(sameVariant(variantKeyOf({ device: 'a', corner: ' TT ', temp: 27 }), key('tt'))).toBe(
      true,
    );
    expect(sameVariant(key('tt'), key('ss'))).toBe(false);
    expect(sameVariant(key('tt', 27), key('tt', 85))).toBe(false);
  });

  it('is one condition whichever way a zero temperature was written', () => {
    const zero = variantKeyOf({ device: 'a', corner: 'tt', temp: -0 });
    expect(sameVariant(zero, key('tt', 0))).toBe(true);
    // And the same through the map-key form, which duplicate detection and aggregation use.
    expect(variantKeyId(zero)).toBe(variantKeyId(key('tt', 0)));
  });

  it('labels with the source spelling and elides the default temperature', () => {
    expect(variantLabel({ corner: 'TT', temp: 27 })).toBe('TT');
    expect(variantLabel({ corner: 'ss', temp: -40 })).toBe('ss@-40');
  });
});

// --- membership --------------------------------------------------------------

describe('family membership', () => {
  it('separates two devices that share a name but declare different process namespaces', () => {
    const families = groupFamilies([
      table({ device: 'nch', meta: { pdk: 'sky130A' } }),
      table({ device: 'nch', meta: { pdk: 'gf180mcuC' } }),
    ]);
    expect(families).toHaveLength(2);
    expect(families[0].familyUid).not.toBe(families[1].familyUid);
  });

  it('joins tables whose name, namespace and corner differ only in case or spacing', () => {
    const f = soleFamily([
      table({ device: 'NCH', corner: 'TT', meta: { pdk: 'Sky130A' } }),
      table({ device: ' nch ', corner: 'tt', temp: 85, meta: { pdk: 'sky130A ' } }),
    ]);
    expect(f.variants).toHaveLength(2);
    expect(f.duplicates).toEqual([]);
    // The display name is the first member's own spelling, not the normalized key.
    expect(f.device).toBe('NCH');
  });

  it('never merges a declared N device with a declared P device of the same name', () => {
    const families = groupFamilies([
      table({ device: 'dev', meta: { polarity: { device: 'n', signedInput: false } } }),
      table({
        device: 'dev',
        corner: 'ss',
        meta: { polarity: { device: 'p', signedInput: true } },
      }),
    ]);
    expect(families).toHaveLength(2);
  });

  it('does not separate two tables that declare no polarity at all', () => {
    // Undeclared is one value, not two: refusing to guess is not the same as knowing they
    // differ, and claiming a split here would be a claim the data does not support.
    const f = soleFamily([table({ device: 'dev' }), table({ device: 'dev', corner: 'ss' })]);
    expect(f.variants).toHaveLength(2);
  });

  it('joins an undeclared identity to the sole declared one of the same name', () => {
    // The ordinary upgrade path: one corner re-exported with newly stamped `# pdk:` and
    // `# polarity:` headers must not silently split away from the older corners of the same
    // device — undeclared never separates, against declared tables included. The merged family
    // carries the declared identity.
    const f = soleFamily([
      table({ device: 'dev', corner: 'ss' }),
      table({
        device: 'dev',
        meta: { pdk: 'sky130A', polarity: { device: 'n', signedInput: false } },
      }),
    ]);
    expect(f.variants).toHaveLength(2);
    expect(familyIdentityOf(f.familyUid)).toEqual({
      pdk: 'sky130a',
      device: 'dev',
      polarity: 'n',
    });
  });

  it('keeps an undeclared identity separate when several declared candidates exist', () => {
    // Joining would be a guess between them; validateFamilies is the warning surface.
    const families = groupFamilies([
      table({ device: 'dev', meta: { pdk: 'sky130A' } }),
      table({ device: 'dev', meta: { pdk: 'gf180mcuC' } }),
      table({ device: 'dev', corner: 'ss' }),
    ]);
    expect(families).toHaveLength(3);
  });

  it('never lets an unknown polarity bridge a declared N and a declared P', () => {
    const families = groupFamilies([
      table({ device: 'dev', meta: { polarity: { device: 'n', signedInput: false } } }),
      table({
        device: 'dev',
        corner: 'ff',
        meta: { polarity: { device: 'p', signedInput: true } },
      }),
      table({ device: 'dev', corner: 'ss' }),
    ]);
    expect(families).toHaveLength(3);
  });

  it('reads a process namespace still stored as a passthrough header', () => {
    // A table imported before `# pdk:` was promoted keeps it in `extra`, under whatever case
    // the file used. It must land in the same family as a freshly imported copy.
    const f = soleFamily([
      table({ meta: { pdk: 'sky130A' } }),
      table({ corner: 'ss', temp: -40, meta: { extra: { PDK: 'sky130A' } } }),
    ]);
    expect(f.variants).toHaveLength(2);
  });

  it('keeps load order within a family and between families', () => {
    const families = groupFamilies([
      table({ device: 'b', corner: 'ss' }),
      table({ device: 'a', corner: 'tt' }),
      table({ device: 'b', corner: 'tt' }),
    ]);
    expect(families.map((f) => f.device)).toEqual(['b', 'a']);
    expect(families[0].variants.map((t) => t.id.corner)).toEqual(['ss', 'tt']);
  });

  it('reads an identity back into the tuple it was built from', () => {
    // The bench shows what a stored binding NAMES while nothing loaded answers to it, so the
    // serialization needs an inverse in the same file as the forward direction — a caller
    // decoding it by position would mislabel silently the day the tuple grows.
    const t = table({
      device: 'NCH',
      meta: { pdk: 'Sky130A', polarity: { device: 'n', signedInput: false } },
    });
    expect(familyIdentityOf(familyUidOf(t))).toEqual({
      pdk: 'sky130a',
      device: 'nch',
      polarity: 'n',
    });
    expect(familyIdentityOf('nch')).toBeUndefined();
    expect(familyIdentityOf('{"pdk":"sky130a"}')).toBeUndefined();
  });

  it('derives the same identity for a recharacterized table', () => {
    // familyUid reads headers only — a table regenerated with a different lattice is the same
    // logical device, which is what lets a stored binding survive recharacterization.
    const before = table({ axes: { vgs: [0, 0.1, 0.2] } });
    const after = table({ axes: { vgs: [0, 0.05, 0.1, 0.15] } });
    expect(familyUidOf(after)).toBe(familyUidOf(before));
  });
});

// --- nominal designation -----------------------------------------------------

describe('nominal designation', () => {
  it('prefers tt at 27 °C over every other loaded condition', () => {
    const f = soleFamily([
      table({ corner: 'ss', temp: -40 }),
      table({ corner: 'tt', temp: 85 }),
      table({ corner: 'tt', temp: 27 }),
    ]);
    expect(f.nominal?.id.temp).toBe(27);
    expect(f.nominalSource).toBe('auto');
  });

  it('falls to the tt condition nearest 27 °C when none sits there', () => {
    // |85 − 27| = 58 against |125 − 27| = 98.
    const f = soleFamily([table({ corner: 'tt', temp: 125 }), table({ corner: 'tt', temp: 85 })]);
    expect(f.nominal?.id.temp).toBe(85);
  });

  it('designates nothing when two tt conditions are equidistant from 27 °C', () => {
    // |17 − 27| = |37 − 27| = 10: picking either would be picking by load order.
    const f = soleFamily([table({ corner: 'tt', temp: 17 }), table({ corner: 'tt', temp: 37 })]);
    expect(f.nominal).toBeUndefined();
    expect(f.nominalSource).toBe('none');
  });

  it('lets a sole member speak for itself, whatever condition it names', () => {
    const f = soleFamily([table({ corner: 'ss', temp: -40 })]);
    expect(f.nominal?.id.corner).toBe('ss');
    expect(f.nominalSource).toBe('auto');
  });

  it('designates nothing when the winning condition is claimed twice', () => {
    const f = soleFamily([table(), table()]);
    expect(f.duplicates.map(variantLabel)).toEqual(['tt']);
    expect(f.nominal).toBeUndefined();
  });

  it('takes a bench designation over the automatic rule', () => {
    const chosen = table({ corner: 'ss', temp: -40 });
    const [f] = groupFamilies([table({ corner: 'tt' }), chosen], {
      nominalByFamily: new Map([[familyUidOf(chosen), 'the-chosen-one']]),
      uidOf: (t) => (t === chosen ? 'the-chosen-one' : 'other'),
    });
    expect(f.nominal).toBe(chosen);
    expect(f.nominalSource).toBe('designated');
  });

  it('leaves a designation that names no loaded member visibly unresolved', () => {
    // Silently reapplying the automatic rule would slide the bench onto tt without anyone
    // choosing it, and the stale designation would never be noticed.
    const tt = table({ corner: 'tt' });
    const [f] = groupFamilies([tt], {
      nominalByFamily: new Map([[familyUidOf(tt), 'a-table-that-left']]),
      uidOf: () => 'still-here',
    });
    expect(f.nominal).toBeUndefined();
    expect(f.nominalSource).toBe('unresolved');
  });

  it('reads a designation it cannot match as unresolved, not as no designation', () => {
    // Supplying the map without `uidOf` gives core nothing to match against — the same
    // visible outcome as a designated member that left, never a silent fall-through.
    const tt = table({ corner: 'tt' });
    const [f] = groupFamilies([tt], {
      nominalByFamily: new Map([[familyUidOf(tt), 'someone']]),
    });
    expect(f.nominal).toBeUndefined();
    expect(f.nominalSource).toBe('unresolved');
  });

  it('reads a designation landing on a duplicated condition as unresolved', () => {
    // The designated table resolves, but every projection at its condition refuses — so
    // advertising it as the nominal would advertise a condition no run can use.
    const chosen = table({ corner: 'tt' });
    const [f] = groupFamilies([chosen, table({ corner: 'tt' })], {
      nominalByFamily: new Map([[familyUidOf(chosen), 'chosen']]),
      uidOf: (t) => (t === chosen ? 'chosen' : 'other'),
    });
    expect(f.nominal).toBeUndefined();
    expect(f.nominalSource).toBe('unresolved');
  });
});

// --- projection --------------------------------------------------------------

describe('projection to one condition', () => {
  it('resolves the unique member at a condition, and nothing at an unclaimed one', () => {
    const f = soleFamily([table({ corner: 'tt' }), table({ corner: 'ss', temp: -40 })]);
    expect(variantAt(f, key('tt'))?.id.corner).toBe('tt');
    expect(variantAt(f, key('ff'))).toBeUndefined();
  });

  it('refuses a condition two tables claim, rather than picking the later one', () => {
    const first = table({ corner: 'ss', temp: -40 });
    const f = soleFamily([first, table({ corner: 'ss', temp: -40 })]);
    expect(variantAt(f, key('ss', -40))).toBeUndefined();
  });

  it('keeps a duplicate at one condition from poisoning the others', () => {
    // The refusal is scoped to the ambiguous condition — the family's unambiguous conditions
    // keep projecting, so one bad re-import does not take the whole family off the bench.
    const f = soleFamily([
      table({ corner: 'tt' }),
      table({ corner: 'ss', temp: -40 }),
      table({ corner: 'ss', temp: -40 }),
    ]);
    expect(variantAt(f, key('ss', -40))).toBeUndefined();
    expect(variantAt(f, key('tt'))?.id.corner).toBe('tt');
  });

  it('lists the conditions it holds once each, in load order', () => {
    // A condition two tables claim is still ONE condition: a mode that offers it offers the
    // condition, and the ambiguity is answered where the condition is projected, not by
    // hiding it from the list.
    const f = soleFamily([
      table({ corner: 'ss', temp: -40 }),
      table({ corner: 'tt' }),
      table({ corner: 'ss', temp: -40 }),
    ]);
    expect(f.keys).toEqual([key('ss', -40), key('tt')]);
  });
});

// --- family QA ---------------------------------------------------------------

describe('validateFamily', () => {
  const rules = (f: CornerFamily): string[] => validateFamily(f).map((w) => w.rule);

  it('says nothing about a single-variant family', () => {
    expect(validateFamily(soleFamily([table()]))).toEqual([]);
  });

  it('says nothing about variants that agree on everything but their condition', () => {
    const meta = { W: 1e-5, simulator: 'ngspice', pdk: 'sky130A' };
    expect(
      validateFamily(soleFamily([table({ meta }), table({ corner: 'ss', temp: -40, meta })])),
    ).toEqual([]);
  });

  it('reports a duplicated condition as an error, naming it and the count', () => {
    const w = validateFamily(
      soleFamily([table({ corner: 'ss', temp: -40 }), table({ corner: 'ss', temp: -40 })]),
    );
    expect(w).toHaveLength(1);
    expect(w[0].rule).toBe('family-duplicate-variant');
    expect(w[0].severity).toBe('error');
    // The condition and how many tables claim it: what a bench needs to find and remove one.
    expect(w[0].message).toContain('ss@-40');
    expect(w[0].message).toMatch(/\b2\b/);
  });

  it('reports variants that sweep different axes as an error', () => {
    const w = validateFamily(
      soleFamily([
        table({ axes: { l: [1e-7], vgs: [0, 0.1] } }),
        table({ corner: 'ss', axes: { l: [1e-7], vds: [0.5], vgs: [0, 0.1] } }),
      ]),
    );
    expect(w.map((x) => x.rule)).toEqual(['family-axes']);
    expect(w[0].severity).toBe('error');
    expect(w[0].message).toContain('vds');
  });

  it('reports a different sweep range over the same axes as a warning, not a blocker', () => {
    // Coverage is legitimately corner-specific; gating on it would refuse valid data.
    const w = validateFamily(
      soleFamily([
        table({ axes: { vgs: [0, 0.1, 0.2] } }),
        table({ corner: 'ss', axes: { vgs: [0, 0.1] } }),
      ]),
    );
    expect(w.map((x) => x.rule)).toEqual(['family-sweep-range']);
    expect(w[0].severity).toBe('warning');
  });

  it('sees a sweep that shares its ends and its count but not its sample points', () => {
    // Both run 0…0.4 in three points; only the middle one moves.
    expect(
      rules(
        soleFamily([
          table({ axes: { vgs: [0, 0.2, 0.4] } }),
          table({ corner: 'ss', axes: { vgs: [0, 0.1, 0.4] } }),
        ]),
      ),
    ).toEqual(['family-sweep-range']);
  });

  it('reports differing characterization widths and quantity columns', () => {
    const f = soleFamily([
      table({ meta: { W: 1e-5 }, quantities: ['id', 'gm', 'gds'] }),
      table({ corner: 'ss', meta: { W: 2e-5 }, quantities: ['id', 'gm'] }),
    ]);
    expect(rules(f).sort()).toEqual(['family-quantities', 'family-width']);
  });

  it('warns that a name-only family may not be one device when its provenance disagrees', () => {
    const w = validateFamily(
      soleFamily([
        table({ meta: { simulator: 'ngspice', extra: { source: 'lab-a' } } }),
        table({ corner: 'ss', meta: { simulator: 'ngspice', extra: { source: 'lab-b' } } }),
      ]),
    );
    expect(w.map((x) => x.rule)).toEqual(['family-provenance']);
    expect(w[0].message).toContain('lab-a');
    expect(w[0].message).toContain('# pdk:');
  });

  it('keeps doubting an inferred membership, whichever file arrived first', () => {
    // Grouping joined the undeclared file to the declared one, so this family's membership is
    // INFERRED — the provenance disagreement is identity evidence and must stay visible, and
    // which file the user happened to import first is not a fact about the data.
    const blank = table({ device: 'dev', meta: { simulator: 'ngspice' } });
    const declared = table({
      device: 'dev',
      corner: 'ss',
      meta: { pdk: 'sky130A', simulator: 'spectre' },
    });
    for (const order of [
      [blank, declared],
      [declared, blank],
    ]) {
      const w = validateFamily(soleFamily(order));
      expect(w.map((x) => x.rule)).toContain('family-provenance');
    }
  });

  it('does not doubt the identity of a family whose namespace is declared', () => {
    // The same disagreement, with `pdk` present: identity is settled, so the finding is about
    // the data instead — different simulators, reported as such.
    const w = validateFamily(
      soleFamily([
        table({ meta: { pdk: 'sky130A', simulator: 'ngspice' } }),
        table({ corner: 'ss', meta: { pdk: 'sky130A', simulator: 'spectre' } }),
      ]),
    );
    expect(w.map((x) => x.rule)).toEqual(['family-simulator']);
    expect(w[0].severity).toBe('warning');
  });
});

describe('validateFamilies', () => {
  it('warns when an undeclared identity had to stay apart from declared ones', () => {
    // The bench-level counterpart of the join rule: grouping refused this join (two declared
    // namespaces to choose from), and no single family can see the sibling it stayed apart
    // from, so the refusal is said here.
    const families = groupFamilies([
      table({ device: 'dev', meta: { pdk: 'sky130A' } }),
      table({ device: 'dev', meta: { pdk: 'gf180mcuC' } }),
      table({ device: 'dev', corner: 'ss' }),
    ]);
    const w = validateFamilies(families);
    expect(w).toHaveLength(1);
    expect(w[0].rule).toBe('family-split');
    expect(w[0].severity).toBe('warning');
    expect(w[0].message).toContain('# pdk:');
    expect(w[0].message).not.toContain('# polarity:');
  });

  it('says nothing about fully declared same-name families', () => {
    // Two PDKs both shipping an `nch` is legitimate, and both files said which they are.
    const n = { polarity: { device: 'n', signedInput: false } } as const;
    const w = validateFamilies(
      groupFamilies([
        table({ device: 'dev', meta: { pdk: 'sky130A', ...n } }),
        table({ device: 'dev', meta: { pdk: 'gf180mcuC', ...n } }),
      ]),
    );
    expect(w).toEqual([]);
  });
});

// --- named bindings ----------------------------------------------------------

describe('namedBindings', () => {
  const leaf = (title: string): SheetDoc => ({
    title,
    polarity: 'n',
    params: [],
    rows: [],
    rules: [],
  });

  it('collects only the children that name a device, with their use paths', () => {
    const doc: SheetDoc = {
      ...leaf('top'),
      uses: [
        { name: 'inherits', doc: leaf('a') },
        {
          name: 'tail',
          doc: { ...leaf('b'), uses: [{ name: 'inner', doc: leaf('c'), device: 'deep' }] },
          device: 'mid',
        },
      ],
    };
    expect(namedBindings(doc).bindings).toEqual([
      { path: 'tail', binding: 'mid' },
      { path: 'tail.inner', binding: 'deep' },
    ]);
  });

  it('walks the tree as it will evaluate, materializing references first', () => {
    const refs = buildSheetRefIndex([
      {
        path: 'lib/mirror',
        doc: { ...leaf('mirror'), uses: [{ name: 'out', doc: leaf('o'), device: 'ref-dev' }] },
      },
    ]);
    const doc: SheetDoc = { ...leaf('top'), uses: [{ name: 'cm', ref: 'lib/mirror' }] };
    const got = namedBindings(doc, refs);
    expect(got.warnings).toEqual([]);
    expect(got.bindings).toEqual([{ path: 'cm.out', binding: 'ref-dev' }]);
  });

  it('returns the resolution failure that makes the binding list incomplete', () => {
    const doc: SheetDoc = { ...leaf('top'), uses: [{ name: 'cm', ref: 'lib/absent' }] };
    const got = namedBindings(doc, buildSheetRefIndex([]));
    expect(got.bindings).toEqual([]);
    expect(got.warnings.map((w) => w.severity)).toEqual(['error']);
  });
});

// --- the additive closes field ----------------------------------------------

describe('SheetResult.closes', () => {
  const edgeless = (over: Partial<SheetDoc> = {}): SheetDoc => ({
    title: 'c',
    polarity: 'n',
    params: [{ name: 'L', value: 0.5e-6 }],
    bind: { L: 'L', gm_id: '12', id: '2e-5' },
    rows: [],
    rules: [],
    ...over,
  });

  it('equals feasible on every sheet that claims no range', () => {
    const cases: Record<string, SheetDoc> = {
      closing: edgeless(),
      failing: edgeless({
        rules: [{ id: 'no', kind: 'invariant', lhs: '0', op: '>=', rhs: '1' }],
      }),
      // Two operating-point selectors: a validation error, which blocks both verdicts.
      'structurally broken': edgeless({ bind: { L: 'L', gm_id: '12', ft: '2e9' } }),
      // A pin whose relation never reaches its target: the solver marks the run infeasible
      // from inside, which must carry `closes` down with it.
      'unsolvable pin': edgeless({
        params: [
          { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: '2*x + 1', rhs: '0.5' } },
          { name: 'L', value: 0.5e-6 },
        ],
      }),
    };
    for (const [name, doc] of Object.entries(cases)) {
      const res = runSheet(doc, dev);
      expect(res.closes, name).toBe(res.feasible);
    }
    expect(runSheet(cases.closing, dev).closes).toBe(true);
    expect(runSheet(cases.failing, dev).closes).toBe(false);
    expect(runSheet(cases['structurally broken'], dev).closes).toBe(false);
  });
});

// --- one run, one condition --------------------------------------------------

/** The pinned-node idiom the library writes: y = 2x + 1 solved to the typed spec T, with the
 *  claimed range [T_lo, T_hi] checked as containment edges. Base T = 5 lands x = 2; the lo
 *  edge (T = 3) lands x = 1 and the hi edge (T = 7) lands x = 3. */
const pinnedDoc = (over: Partial<SheetDoc> = {}): SheetDoc => ({
  title: 'pinned',
  polarity: 'n',
  params: [
    { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'T' } },
    { name: 'T', value: 5 },
    { name: 'T_lo', value: 3 },
    { name: 'T_hi', value: 7 },
    { name: 'x_floor', value: 0.5 },
  ],
  rows: [{ name: 'y', expr: '2*x + 1' }],
  rules: [{ id: 'floor', kind: 'invariant', lhs: 'x', op: '>=', rhs: 'x_floor' }],
  ...over,
});

describe('runVariant', () => {
  const primary = soleFamily([retag(dev, 'tt', 27), retag(dev, 'tt', 85)]);
  const noFamilies = (): undefined => undefined;

  const gainDoc = (aMin: number): SheetDoc => ({
    title: 'gain',
    polarity: 'n',
    params: [
      { name: 'L', value: 0.5e-6 },
      { name: 'A_min', value: aMin },
    ],
    bind: { L: 'L', gm_id: '12', id: '2e-5' },
    rows: [{ name: 'A', expr: 'gm_gds' }],
    rules: [{ id: 'gain', kind: 'requirement', lhs: 'A', op: '>=', rhs: 'A_min' }],
  });

  /** gainDoc plus one composed child bound by name — the shape the child-projection tests
   *  share. */
  const withTail = (binding: string): SheetDoc => ({
    ...gainDoc(20),
    uses: [
      {
        name: 'tailblk',
        device: binding,
        doc: {
          title: 'tail',
          polarity: 'n',
          params: [],
          bind: { L: '5e-7', gm_id: '10', id: '2e-5' },
          rows: [],
          rules: [],
        },
      },
    ],
  });

  /** The given tables presented as one child family named `nch_tail`. */
  const tailFamily = (...tables: DeviceTable[]): CornerFamily =>
    soleFamily(tables.map((t) => ({ ...t, id: { ...t.id, device: 'nch_tail' } })));

  it('evaluates at the requested condition and reports both verdicts', () => {
    const run = runVariant(gainDoc(20), primary, key('tt', 85), noFamilies);
    expect(run.state).toBe('evaluated');
    if (run.state !== 'evaluated') return;
    expect(run.key).toEqual(key('tt', 85));
    expect(run.closes).toBe('pass');
    // No containment edges: coverage was never asked, which is not a gap.
    expect(run.covers).toBe('unchecked');
  });

  it('reports the two conditions differently when the characterizations differ', () => {
    // The demo model's intrinsic gain is closed-form: gm/gds = (gm/ID)·VA with VA = VA_PER_L·L,
    // so binding gm/ID = 12 at L = 0.5 µm gives 12 × 2.5 V = 30. The slow variant carries a
    // doubled gds column, halving that to 15 at the same sized point — so a 20 V/V requirement
    // must pass at tt and fail at ss, with no other difference between the runs.
    expect(VA_PER_L * 0.5e-6).toBe(2.5);
    const slow = retag(scaleQuantities(dev, { gds: 2 }), 'ss', -40);
    const family = soleFamily([retag(dev, 'tt', 27), slow]);
    const doc = gainDoc(20);

    const fast = runVariant(doc, family, key('tt'), noFamilies);
    const cold = runVariant(doc, family, key('ss', -40), noFamilies);
    expect([fast.state, cold.state]).toEqual(['evaluated', 'evaluated']);
    if (fast.state !== 'evaluated' || cold.state !== 'evaluated') return;
    expect(fast.closes).toBe('pass');
    expect(cold.closes).toBe('fail');
    expect(fast.result.values.A / cold.result.values.A).toBeCloseTo(2, 6);

    const agg = aggregateVariantRuns([fast, cold], false);
    expect(agg.closes).toBe('fails');
    expect(agg.counts).toEqual({ pass: 1, fail: 1, unavailable: 0 });
  });

  it('refuses a condition the primary device is not characterized at', () => {
    const run = runVariant(gainDoc(20), primary, key('ff'), noFamilies);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['absent-variant']);
    expect(run.issues[0].message).toContain('ff');
    expect(run.result).toBeUndefined();
  });

  it('refuses a condition two loaded tables claim', () => {
    const ambiguous = soleFamily([retag(dev, 'tt'), retag(dev, 'tt')]);
    const run = runVariant(gainDoc(20), ambiguous, key('tt'), noFamilies);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['ambiguous-variant']);
  });

  it('projects every named child to the run’s condition, never to the child’s own nominal', () => {
    // The child family is characterized ONLY at tt@85 — its own nominal. A tt@27 run that
    // silently used it would report a verdict for a chip that was never at one temperature.
    const child = tailFamily(retag(dev, 'tt', 85));
    const doc = withTail('tail-binding');
    const familyOf = (b: string): CornerFamily | undefined =>
      b === 'tail-binding' ? child : undefined;

    const mixed = runVariant(doc, primary, key('tt', 27), familyOf);
    expect(mixed.state).toBe('not-evaluated');
    if (mixed.state !== 'not-evaluated') return;
    expect(mixed.issues).toHaveLength(1);
    expect(mixed.issues[0].kind).toBe('absent-variant');
    expect(mixed.issues[0].device).toBe('nch_tail');
    expect(mixed.issues[0].message).toContain('tailblk');

    // At the condition both are characterized at, the same sheet runs.
    expect(runVariant(doc, primary, key('tt', 85), familyOf).state).toBe('evaluated');
  });

  it('refuses a child family that is ambiguous at the run’s condition, naming the block', () => {
    const child = tailFamily(retag(dev, 'tt'), retag(dev, 'tt'));
    const run = runVariant(withTail('tail-binding'), primary, key('tt'), () => child);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['ambiguous-variant']);
    expect(run.issues[0].message).toContain('tailblk');
  });

  it('lists every missing device in one refusal, not only the first', () => {
    // Neither the primary nor the child is characterized at ff. A refusal that stopped at the
    // first hole would send the user importing tables one round trip at a time.
    const child = tailFamily(retag(dev, 'ss', -40));
    const run = runVariant(withTail('tail-binding'), primary, key('ff'), () => child);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['absent-variant', 'absent-variant']);
    expect(new Set(run.issues.map((i) => i.device)).size).toBe(2);
  });

  it('refuses a family whose members do not sweep the same axes, at every condition', () => {
    // Which member is wrongly grouped is unknowable from the data, so the refusal is
    // family-wide rather than scoped to the oddly-shaped member's own condition — the run
    // here asks for tt, whose table is the ordinary one.
    const family = soleFamily([
      table({ axes: { vgs: [0, 0.1, 0.2] } }),
      table({ corner: 'ss', temp: -40, axes: { vgs: [0, 0.1, 0.2], vds: [0, 0.9] } }),
    ]);
    const run = runVariant(gainDoc(20), family, key('tt'), noFamilies);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['incompatible-table']);
  });

  it('screens a condition on the same grounds without evaluating it', () => {
    // What a search asks before spending an evaluation. It must answer with the run's own
    // refusals — the PRIMARY family's included, which is the ground a hand-written child-only
    // walk drops: a family whose members sweep different axes would then be searched and
    // ranked, and refused afterwards by every panel that tried to evaluate it.
    const mixed = soleFamily([
      table({ axes: { vgs: [0, 0.1, 0.2] } }),
      table({ corner: 'ss', temp: -40, axes: { vgs: [0, 0.1, 0.2], vds: [0, 0.9] } }),
    ]);
    const screened = preflightVariant(gainDoc(20), mixed, key('tt'), noFamilies);
    expect(screened.issues.map((i) => i.kind)).toEqual(['incompatible-table']);
    expect(screened.primary).toBeUndefined();

    // A named child nothing answers to, reported in the run's words rather than the caller's.
    const missing = preflightVariant(withTail('tail-binding'), primary, key('tt'), noFamilies);
    expect(missing.issues.map((i) => i.kind)).toEqual(['absent-variant']);
    expect(missing.issues[0].message).toBe(
      'block "tailblk" names device "tail-binding", which is not loaded',
    );

    // Nothing in the way: the primary's table at the condition comes back, and no evaluation
    // has happened.
    const clear = preflightVariant(gainDoc(20), primary, key('tt', 85), noFamilies);
    expect(clear.issues).toEqual([]);
    expect(clear.primary?.id.temp).toBe(85);
  });

  it('runs a set of conditions exactly as it runs them one at a time', () => {
    // The plural form shares the singular's state machine; only the work that does not depend
    // on the condition (resolving and validating the sheet, collecting its bindings) is lifted
    // out of the loop, so no verdict may move.
    const family = soleFamily([
      retag(dev, 'tt', 27),
      retag(scaleQuantities(dev, { gds: 2 }), 'ss', -40),
    ]);
    const keys = [key('tt'), key('ss', -40), key('ff')];
    /** A run's whole answer apart from the numbers: state, verdicts, and any refusals. */
    const verdict = (r: VariantRun): unknown =>
      r.state === 'evaluated' ? [r.state, r.key, r.closes, r.covers] : [r.state, r.key, r.issues];
    const many = runVariants(gainDoc(20), family, keys, noFamilies);
    expect(many.map(verdict)).toEqual(
      keys.map((k) => verdict(runVariant(gainDoc(20), family, k, noFamilies))),
    );
    // And the same warnings on the results themselves — validating once must not drop the
    // validation's own findings from what a panel displays.
    expect(many[0].result?.warnings).toEqual(
      runVariant(gainDoc(20), family, key('tt'), noFamilies).result?.warnings,
    );
  });

  it('carries a curated library sheet across two conditions', () => {
    // A real library document, not a synthetic one: the CS amp with a current-source load
    // computes Av = gm·Rout with Rout = 1/(gds + load__gds) and gm pinned by its GBW spec, so
    // a slow characterization with every gds doubled halves Av exactly — the load inherits
    // the projected primary table, so both gds terms scale together.
    const entry = loadLibrary().find((s) => s.file === 'stages/cs-amp-current-source-load.json');
    expect(entry).toBeDefined();
    if (!entry) return;
    const family = soleFamily([
      retag(dev, 'tt', 27),
      retag(scaleQuantities(dev, { gds: 2 }), 'ss', -40),
    ]);
    const fast = runVariant(entry.doc, family, key('tt'), noFamilies);
    const slow = runVariant(entry.doc, family, key('ss', -40), noFamilies);
    expect([fast.state, slow.state]).toEqual(['evaluated', 'evaluated']);
    if (fast.state !== 'evaluated' || slow.state !== 'evaluated') return;
    expect(fast.result.values.Av / slow.result.values.Av).toBeCloseTo(2, 6);
    // Each condition is judged from its own numbers.
    const gainMargin = (r: typeof fast): number =>
      r.result.rules.find((x) => x.id === 'gain-spec')?.marginPct ?? NaN;
    expect(gainMargin(slow)).toBeLessThan(gainMargin(fast));
  });

  it('preflights a device named two levels down, and a device named through a reference', () => {
    // Both are blocks the top sheet never mentions: one nested inside an embedded child, one
    // materialized from the library. Neither may reach the engine unpreflighted.
    const sizing = { L: '5e-7', gm_id: '10', id: '2e-5' };
    const inner: SheetDoc = {
      title: 'inner',
      polarity: 'n',
      params: [],
      bind: sizing,
      rows: [],
      rules: [],
    };
    const nested: SheetDoc = {
      ...gainDoc(20),
      uses: [
        {
          name: 'mid',
          doc: {
            title: 'mid',
            polarity: 'n',
            params: [],
            rows: [],
            rules: [],
            uses: [{ name: 'deep', doc: inner, device: 'deep-binding' }],
          },
        },
      ],
    };
    const deep = runVariant(nested, primary, key('tt'), noFamilies);
    expect(deep.state).toBe('not-evaluated');
    if (deep.state !== 'not-evaluated') return;
    expect(deep.issues[0].message).toContain('mid.deep');

    const refs = buildSheetRefIndex([
      {
        path: 'lib/blk',
        doc: { ...inner, uses: [{ name: 'ref-child', doc: inner, device: 'deep-binding' }] },
      },
    ]);
    const byRef: SheetDoc = { ...gainDoc(20), uses: [{ name: 'cm', ref: 'lib/blk' }] };
    const viaRef = runVariant(byRef, primary, key('tt'), noFamilies, refs);
    expect(viaRef.state).toBe('not-evaluated');
    if (viaRef.state !== 'not-evaluated') return;
    expect(viaRef.issues[0].kind).toBe('absent-variant');
    expect(viaRef.issues[0].message).toContain('cm.ref-child');
  });

  it('refuses a sheet whose reference does not resolve, before any device is projected', () => {
    const doc: SheetDoc = { ...gainDoc(20), uses: [{ name: 'cm', ref: 'lib/absent' }] };
    const run = runVariant(doc, primary, key('tt'), noFamilies, buildSheetRefIndex([]));
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['invalid-sheet-or-ref']);
    expect(run.result).toBeUndefined();
  });

  it('names a binding that no loaded device answers to', () => {
    const doc: SheetDoc = {
      ...gainDoc(20),
      uses: [
        {
          name: 'blk',
          device: 'nothing-loaded',
          doc: { title: 'x', polarity: 'n', params: [], rows: [], rules: [] },
        },
      ],
    };
    const run = runVariant(doc, primary, key('tt'), noFamilies);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues[0].device).toBe('nothing-loaded');
  });

  it('never consults the resolver for a child that inherits its parent’s device', () => {
    const doc: SheetDoc = {
      ...gainDoc(20),
      uses: [
        {
          name: 'inherits',
          doc: {
            title: 'x',
            polarity: 'n',
            params: [],
            bind: { L: '5e-7', gm_id: '10', id: '2e-5' },
            rows: [],
            rules: [],
          },
        },
      ],
    };
    expect(runVariant(doc, primary, key('tt'), noFamilies).state).toBe('evaluated');
  });

  it('refuses a structurally broken sheet before any device is projected', () => {
    const run = runVariant(
      { ...gainDoc(20), bind: { L: 'L', gm_id: '12', ft: '2e9' } },
      primary,
      key('tt'),
      noFamilies,
    );
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['invalid-sheet-or-ref']);
  });

  it('refuses a run that did not complete, even though a hard rule also failed', () => {
    // Both signals are present at once: the pin cannot reach T = 0.5 (y = 2x + 1 spans [1, 21]
    // over the bracket), and `0 >= 1` fails outright. A run that could not be completed is not
    // a design that does not close, so the rule failure must not promote it to an evaluated
    // verdict — while its diagnostics stay reachable.
    const doc = pinnedDoc({
      params: [
        { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 0.5 },
      ],
      rules: [{ id: 'impossible', kind: 'invariant', lhs: '0', op: '>=', rhs: '1' }],
    });
    const run = runVariant(doc, primary, key('tt'), noFamilies);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['runtime-evaluation']);
    expect(run.result?.rules.find((r) => r.id === 'impossible')?.status).toBe('fail');
    expect(run.result?.feasible).toBe(false);
  });

  it('separates a design that closes from a range end it does not cover', () => {
    // Base T = 5 lands x = 2, clearing a 1.6 floor; the lo edge holds the same hardware at
    // T = 3, landing x = 1, which does not. The design closes; the claimed range is not
    // covered — and the two must never be reported as one failure.
    const doc = pinnedDoc({
      params: [
        { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
        { name: 'T_lo', value: 3 },
        { name: 'x_floor', value: 1.6 },
      ],
      edges: [{ name: 'lo', set: { T: 'T_lo' } }],
    });
    const run = runVariant(doc, primary, key('tt'), noFamilies);
    expect(run.state).toBe('evaluated');
    if (run.state !== 'evaluated') return;
    expect(run.closes).toBe('pass');
    expect(run.covers).toBe('gap');
    expect(run.result.feasible).toBe(false); // the whole claim, closure AND coverage
  });

  it('keeps a measured closure verdict when only a range end breaks', () => {
    // Base T = 5 lands x = 2 and the floor passes; the lo edge asks for T = 0.5, which
    // y = 2x + 1 cannot reach over the bracket, so the range CHECK breaks — a coverage
    // non-answer, not a closure event. Closure was measured and must stay reported; coverage
    // reads unchecked — never a measured gap, and never an erased run.
    const doc = pinnedDoc({
      params: [
        { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
        { name: 'T_bad', value: 0.5 },
        { name: 'x_floor', value: 0.5 },
      ],
      edges: [{ name: 'lo', set: { T: 'T_bad' } }],
    });
    const run = runVariant(doc, primary, key('tt'), noFamilies);
    expect(run.state).toBe('evaluated');
    if (run.state !== 'evaluated') return;
    expect(run.closes).toBe('pass');
    expect(run.covers).toBe('unchecked');
    // The end's own failure stays visible in its report.
    expect(run.result.edges?.[0].error).toBeDefined();
  });

  it('does not report the primary twice when a child binds its own family', () => {
    const run = runVariant(withTail('self-binding'), primary, key('ff'), () => primary);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues).toHaveLength(1);
  });
});

// --- aggregation -------------------------------------------------------------

const hardRule = (marginPct: number): RuleResult => ({
  id: 'r',
  kind: 'invariant',
  op: '>=',
  text: 'r',
  lhsValue: 0,
  rhsValue: 0,
  // The SI distance is a different quantity from the relative margin; keeping them distinct
  // here makes visible that the folds under test read only the relative one.
  margin: marginPct * 3,
  marginPct,
  rawMargin: marginPct,
  status: marginPct >= 0 ? 'pass' : 'fail',
});

/** A minimal evaluated result carrying one hard rule at `marginPct` — enough for the margin
 *  and verdict folds, which read nothing else. */
function resultWith(marginPct: number, closes = true): SheetResult {
  return { values: {}, rules: [hardRule(marginPct)], feasible: closes, closes, warnings: [] };
}

/** The same result plus one range end that stood and covered, carrying its own rule margin. */
function withCoveredEdge(res: SheetResult, edgeMarginPct: number): SheetResult {
  return {
    ...res,
    covers: true,
    edges: [
      {
        name: 'lo',
        feasible: true,
        state: 'covers',
        set: {},
        rules: [hardRule(edgeMarginPct)],
        solved: {},
        warnings: [],
      },
    ],
  };
}

const evaluated = (
  corner: string,
  closes: 'pass' | 'fail',
  covers: 'covers' | 'gap' | 'unchecked' = 'unchecked',
  marginPct = 0.5,
): VariantRun => ({
  state: 'evaluated',
  key: key(corner),
  closes,
  covers,
  result: resultWith(marginPct, closes === 'pass'),
});

const refused = (corner: string, result?: SheetResult): VariantRun => ({
  state: 'not-evaluated',
  key: key(corner),
  issues: [{ kind: 'absent-variant', message: 'not characterized' }],
  ...(result ? { result } : {}),
});

describe('aggregateVariantRuns — closure', () => {
  it('reaches each of the four states from the counts that define it', () => {
    const cases: [
      string,
      VariantRun[],
      string,
      { pass: number; fail: number; unavailable: number },
    ][] = [
      [
        'every condition evaluated and closing',
        [evaluated('tt', 'pass'), evaluated('ss', 'pass')],
        'all',
        { pass: 2, fail: 0, unavailable: 0 },
      ],
      [
        'one evaluated failure among passes',
        [evaluated('tt', 'pass'), evaluated('ss', 'fail'), refused('ff')],
        'fails',
        { pass: 1, fail: 1, unavailable: 1 },
      ],
      [
        'no failure, but a condition went unevaluated',
        [evaluated('tt', 'pass'), refused('ss')],
        'unverified',
        { pass: 1, fail: 0, unavailable: 1 },
      ],
      [
        'nothing evaluated at all',
        [refused('tt'), refused('ss')],
        'none-evaluated',
        { pass: 0, fail: 0, unavailable: 2 },
      ],
    ];
    for (const [name, runs, closes, counts] of cases) {
      const agg = aggregateVariantRuns(runs, false);
      expect(agg.closes, name).toBe(closes);
      expect(agg.counts, name).toEqual(counts);
    }
  });

  it('counts conditions, not runs, when a caller repeats one', () => {
    const agg = aggregateVariantRuns([evaluated('tt', 'pass'), evaluated('tt', 'pass')], false);
    expect(agg.counts.pass).toBe(1);
  });

  it('takes the worst margin over the evaluated runs only', () => {
    // The refused run carries a retained result with a far worse margin. Folding it in would
    // quote a headroom number for a condition nobody measured.
    const agg = aggregateVariantRuns(
      [
        evaluated('tt', 'pass', 'unchecked', 0.4),
        evaluated('ss', 'pass', 'unchecked', 0.12),
        refused('ff', resultWith(-0.9, false)),
      ],
      false,
    );
    expect(agg.worstMargin).toBeCloseTo(0.12, 12);
  });

  it('reports no margin when nothing measurable was evaluated', () => {
    expect(aggregateVariantRuns([refused('tt')], false).worstMargin).toBeNull();
  });

  it('never quotes a range end’s headroom as the closure margin', () => {
    // The tt run covers its range end, and that end has far less headroom (0.05) than the
    // design's own worst rule (0.4 at tt, 0.12 at ss). A range end's margin answers coverage;
    // the closure margin must come from the base designs alone.
    const tt: VariantRun = {
      state: 'evaluated',
      key: key('tt'),
      closes: 'pass',
      covers: 'covers',
      result: withCoveredEdge(resultWith(0.4), 0.05),
    };
    const agg = aggregateVariantRuns([tt, evaluated('ss', 'pass', 'unchecked', 0.12)], true);
    expect(agg.worstMargin).toBeCloseTo(0.12, 12);
  });
});

describe('aggregateVariantRuns — coverage', () => {
  const covers = (runs: VariantRun[], hasEdges = true): unknown =>
    aggregateVariantRuns(runs, hasEdges).covers;

  it('is absent when the sheet claims no range at all', () => {
    // A sheet with no edges leaves every evaluated run `unchecked`. Including when nothing was
    // evaluated: "no range claimed" and "range claimed, none checked" are different answers,
    // and only the doc can tell them apart.
    expect(covers([evaluated('tt', 'pass', 'unchecked')], false)).toBeUndefined();
    expect(covers([refused('tt')], false)).toBeUndefined();
  });

  it('never drops a gap a run actually measured, whatever the caller says about edges', () => {
    expect(aggregateVariantRuns([evaluated('tt', 'fail', 'gap')], false).covers?.state).toBe('gap');
  });

  it('maps every mixture of the four per-run states', () => {
    const cases: [string, VariantRun[], string][] = [
      [
        'all covered',
        [evaluated('tt', 'pass', 'covers'), evaluated('ss', 'pass', 'covers')],
        'all',
      ],
      [
        'one measured gap decides it',
        [evaluated('tt', 'pass', 'covers'), evaluated('ss', 'fail', 'gap')],
        'gap',
      ],
      [
        'a gap outranks an unevaluated condition',
        [evaluated('tt', 'fail', 'gap'), refused('ss')],
        'gap',
      ],
      [
        'covered where it ran, and it did not run everywhere',
        [evaluated('tt', 'pass', 'covers'), refused('ss')],
        'unverified',
      ],
      ['edges claimed, nothing evaluated', [refused('tt'), refused('ss')], 'unchecked'],
    ];
    for (const [name, runs, state] of cases) {
      expect(aggregateVariantRuns(runs, true).covers?.state, name).toBe(state);
    }
  });

  it('always shows the counts behind the state', () => {
    const agg = aggregateVariantRuns([evaluated('tt', 'pass', 'covers'), refused('ss')], true);
    expect(agg.covers?.counts).toEqual({ covers: 1, gap: 0, unchecked: 0, unavailable: 1 });
  });
});
