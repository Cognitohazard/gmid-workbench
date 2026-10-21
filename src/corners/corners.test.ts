// Characterized devices: identity derived from the data, one run at one condition, and the four
// outcomes an aggregate is allowed to report.
//
// The device fixtures are hand-built (grouping and QA only ever read identity and shape) or
// the demo model retagged, and every numeric expectation is derived from the model's closed
// forms — gm/gds = (gm/ID)·VA with VA = VA_PER_L·L — never read back off the engine.

import { describe, it, expect } from 'vitest';
import { generateDemoDevice, scaleQuantities, VA_PER_L } from '../demo';
import { makeGrid } from '../grid';
import { validateDevices, validateDeviceConditions } from '../qa';
import { loadLibrary, REFS, table as libTable } from '../sheet/library.fixtures';
import { clampedIn, evaluateSheet, namedBindings, buildSheetRefIndex } from '../sheet';
import type { CheckResult, SheetDoc, RangeEndReport, SheetResult } from '../sheet';
import type { Axis, DeviceTable, TableMeta } from '../types';
import {
  aggregateConditionRuns,
  deviceIdentityOf,
  deviceUidOf,
  groupDevices,
  preflightCondition,
  runCondition,
  runConditions,
  sameCondition,
  tableAt,
  conditionKeyId,
  conditionKeyOf,
  conditionLabel,
  type CharacterizedDevice,
  type ConditionKey,
  type ConditionRun,
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

/** The one device `tables` group into — the shape most tests below assert on. */
function soleDevice(tables: DeviceTable[]): CharacterizedDevice {
  const devices = groupDevices(tables);
  expect(devices).toHaveLength(1);
  return devices[0];
}

const key = (corner: string, temp = 27): ConditionKey => ({ corner, temp });

// The demo device characterized over drain voltage. Every sized device states its drain voltage,
// so the documents below state one — 0.5 V, unless the test is about another — and the
// conditions they run at carry a vds sweep that holds it.
const dev = generateDemoDevice({ vds: { min: 0, max: 1, step: 0.5 } });

/** The demo device presented as another condition of the same logical device. */
function retag(t: DeviceTable, corner: string, temp = 27, meta: TableMeta = {}): DeviceTable {
  return { ...t, id: { ...t.id, corner, temp }, meta: { ...t.meta, ...meta } };
}

// --- condition identity --------------------------------------------------------

describe('condition identity', () => {
  it('canonicalizes the corner spelling, so one condition is one key', () => {
    expect(
      sameCondition(conditionKeyOf({ device: 'a', corner: ' TT ', temp: 27 }), key('tt')),
    ).toBe(true);
    expect(sameCondition(key('tt'), key('ss'))).toBe(false);
    expect(sameCondition(key('tt', 27), key('tt', 85))).toBe(false);
  });

  it('is one condition whichever way a zero temperature was written', () => {
    const zero = conditionKeyOf({ device: 'a', corner: 'tt', temp: -0 });
    expect(sameCondition(zero, key('tt', 0))).toBe(true);
    // And the same through the map-key form, which duplicate detection and aggregation use.
    expect(conditionKeyId(zero)).toBe(conditionKeyId(key('tt', 0)));
  });

  it('labels with the source spelling and elides the default temperature', () => {
    expect(conditionLabel({ corner: 'TT', temp: 27 })).toBe('TT');
    expect(conditionLabel({ corner: 'ss', temp: -40 })).toBe('ss@-40');
  });
});

// --- membership --------------------------------------------------------------

describe('device membership', () => {
  it('separates two devices that share a name but declare different process namespaces', () => {
    const devices = groupDevices([
      table({ device: 'nch', meta: { pdk: 'sky130A' } }),
      table({ device: 'nch', meta: { pdk: 'gf180mcuC' } }),
    ]);
    expect(devices).toHaveLength(2);
    expect(devices[0].deviceUid).not.toBe(devices[1].deviceUid);
  });

  it('joins tables whose name, namespace and corner differ only in case or spacing', () => {
    const f = soleDevice([
      table({ device: 'NCH', corner: 'TT', meta: { pdk: 'Sky130A' } }),
      table({ device: ' nch ', corner: 'tt', temp: 85, meta: { pdk: 'sky130A ' } }),
    ]);
    expect(f.conditions).toHaveLength(2);
    expect(f.duplicates).toEqual([]);
    // The display name is the first member's own spelling, not the normalized key.
    expect(f.device).toBe('NCH');
  });

  it('never merges a declared N device with a declared P device of the same name', () => {
    const devices = groupDevices([
      table({ device: 'dev', meta: { polarity: { device: 'n', signedInput: false } } }),
      table({
        device: 'dev',
        corner: 'ss',
        meta: { polarity: { device: 'p', signedInput: true } },
      }),
    ]);
    expect(devices).toHaveLength(2);
  });

  it('does not separate two tables that declare no polarity at all', () => {
    // Undeclared is one value, not two: refusing to guess is not the same as knowing they
    // differ, and claiming a split here would be a claim the data does not support.
    const f = soleDevice([table({ device: 'dev' }), table({ device: 'dev', corner: 'ss' })]);
    expect(f.conditions).toHaveLength(2);
  });

  it('joins an undeclared identity to the sole declared one of the same name', () => {
    // The ordinary upgrade path: one corner re-exported with newly stamped `# pdk:` and
    // `# polarity:` headers must not silently split away from the older corners of the same
    // device — undeclared never separates, against declared tables included. The merged device
    // carries the declared identity.
    const f = soleDevice([
      table({ device: 'dev', corner: 'ss' }),
      table({
        device: 'dev',
        meta: { pdk: 'sky130A', polarity: { device: 'n', signedInput: false } },
      }),
    ]);
    expect(f.conditions).toHaveLength(2);
    expect(deviceIdentityOf(f.deviceUid)).toEqual({
      pdk: 'sky130a',
      device: 'dev',
      polarity: 'n',
    });
  });

  it('keeps an undeclared identity separate when several declared candidates exist', () => {
    // Joining would be a guess between them; validateDevices is the warning surface.
    const devices = groupDevices([
      table({ device: 'dev', meta: { pdk: 'sky130A' } }),
      table({ device: 'dev', meta: { pdk: 'gf180mcuC' } }),
      table({ device: 'dev', corner: 'ss' }),
    ]);
    expect(devices).toHaveLength(3);
  });

  it('never lets an unknown polarity bridge a declared N and a declared P', () => {
    const devices = groupDevices([
      table({ device: 'dev', meta: { polarity: { device: 'n', signedInput: false } } }),
      table({
        device: 'dev',
        corner: 'ff',
        meta: { polarity: { device: 'p', signedInput: true } },
      }),
      table({ device: 'dev', corner: 'ss' }),
    ]);
    expect(devices).toHaveLength(3);
  });

  it('reads a process namespace still stored as a passthrough header', () => {
    // A table imported before `# pdk:` was promoted keeps it in `extra`, under whatever case
    // the file used. It must land in the same device as a freshly imported copy.
    const f = soleDevice([
      table({ meta: { pdk: 'sky130A' } }),
      table({ corner: 'ss', temp: -40, meta: { extra: { PDK: 'sky130A' } } }),
    ]);
    expect(f.conditions).toHaveLength(2);
  });

  it('keeps load order within a device and between devices', () => {
    const devices = groupDevices([
      table({ device: 'b', corner: 'ss' }),
      table({ device: 'a', corner: 'tt' }),
      table({ device: 'b', corner: 'tt' }),
    ]);
    expect(devices.map((f) => f.device)).toEqual(['b', 'a']);
    expect(devices[0].conditions.map((t) => t.id.corner)).toEqual(['ss', 'tt']);
  });

  it('reads an identity back into the tuple it was built from', () => {
    // The bench shows what a stored binding NAMES while nothing loaded answers to it, so the
    // serialization needs an inverse in the same file as the forward direction — a caller
    // decoding it by position would mislabel silently the day the tuple grows.
    const t = table({
      device: 'NCH',
      meta: { pdk: 'Sky130A', polarity: { device: 'n', signedInput: false } },
    });
    expect(deviceIdentityOf(deviceUidOf(t))).toEqual({
      pdk: 'sky130a',
      device: 'nch',
      polarity: 'n',
    });
    expect(deviceIdentityOf('nch')).toBeUndefined();
    expect(deviceIdentityOf('{"pdk":"sky130a"}')).toBeUndefined();
  });

  it('derives the same identity for a recharacterized table', () => {
    // deviceUid reads headers only — a table regenerated with a different lattice is the same
    // logical device, which is what lets a stored binding survive recharacterization.
    const before = table({ axes: { vgs: [0, 0.1, 0.2] } });
    const after = table({ axes: { vgs: [0, 0.05, 0.1, 0.15] } });
    expect(deviceUidOf(after)).toBe(deviceUidOf(before));
  });
});

// --- nominal designation -----------------------------------------------------

describe('nominal designation', () => {
  it('prefers tt at 27 °C over every other loaded condition', () => {
    const f = soleDevice([
      table({ corner: 'ss', temp: -40 }),
      table({ corner: 'tt', temp: 85 }),
      table({ corner: 'tt', temp: 27 }),
    ]);
    expect(f.nominal?.id.temp).toBe(27);
    expect(f.nominalSource).toBe('auto');
  });

  it('falls to the tt condition nearest 27 °C when none sits there', () => {
    // |85 − 27| = 58 against |125 − 27| = 98.
    const f = soleDevice([table({ corner: 'tt', temp: 125 }), table({ corner: 'tt', temp: 85 })]);
    expect(f.nominal?.id.temp).toBe(85);
  });

  it('designates nothing when two tt conditions are equidistant from 27 °C', () => {
    // |17 − 27| = |37 − 27| = 10: picking either would be picking by load order.
    const f = soleDevice([table({ corner: 'tt', temp: 17 }), table({ corner: 'tt', temp: 37 })]);
    expect(f.nominal).toBeUndefined();
    expect(f.nominalSource).toBe('none');
  });

  it('lets a sole member speak for itself, whatever condition it names', () => {
    const f = soleDevice([table({ corner: 'ss', temp: -40 })]);
    expect(f.nominal?.id.corner).toBe('ss');
    expect(f.nominalSource).toBe('auto');
  });

  it('designates nothing when the winning condition is claimed twice', () => {
    const f = soleDevice([table(), table()]);
    expect(f.duplicates.map(conditionLabel)).toEqual(['tt']);
    expect(f.nominal).toBeUndefined();
  });

  it('takes a bench designation over the automatic rule', () => {
    const chosen = table({ corner: 'ss', temp: -40 });
    const [f] = groupDevices([table({ corner: 'tt' }), chosen], {
      nominalByDevice: new Map([[deviceUidOf(chosen), 'the-chosen-one']]),
      uidOf: (t) => (t === chosen ? 'the-chosen-one' : 'other'),
    });
    expect(f.nominal).toBe(chosen);
    expect(f.nominalSource).toBe('designated');
  });

  it('leaves a designation that names no loaded member visibly unresolved', () => {
    // Silently reapplying the automatic rule would slide the bench onto tt without anyone
    // choosing it, and the stale designation would never be noticed.
    const tt = table({ corner: 'tt' });
    const [f] = groupDevices([tt], {
      nominalByDevice: new Map([[deviceUidOf(tt), 'a-table-that-left']]),
      uidOf: () => 'still-here',
    });
    expect(f.nominal).toBeUndefined();
    expect(f.nominalSource).toBe('unresolved');
  });

  it('reads a designation it cannot match as unresolved, not as no designation', () => {
    // Supplying the map without `uidOf` gives core nothing to match against — the same
    // visible outcome as a designated member that left, never a silent fall-through.
    const tt = table({ corner: 'tt' });
    const [f] = groupDevices([tt], {
      nominalByDevice: new Map([[deviceUidOf(tt), 'someone']]),
    });
    expect(f.nominal).toBeUndefined();
    expect(f.nominalSource).toBe('unresolved');
  });

  it('reads a designation landing on a duplicated condition as unresolved', () => {
    // The designated table resolves, but every projection at its condition refuses — so
    // advertising it as the nominal would advertise a condition no run can use.
    const chosen = table({ corner: 'tt' });
    const [f] = groupDevices([chosen, table({ corner: 'tt' })], {
      nominalByDevice: new Map([[deviceUidOf(chosen), 'chosen']]),
      uidOf: (t) => (t === chosen ? 'chosen' : 'other'),
    });
    expect(f.nominal).toBeUndefined();
    expect(f.nominalSource).toBe('unresolved');
  });
});

// --- projection --------------------------------------------------------------

describe('projection to one condition', () => {
  it('resolves the unique member at a condition, and nothing at an unclaimed one', () => {
    const f = soleDevice([table({ corner: 'tt' }), table({ corner: 'ss', temp: -40 })]);
    expect(tableAt(f, key('tt'))?.id.corner).toBe('tt');
    expect(tableAt(f, key('ff'))).toBeUndefined();
  });

  it('refuses a condition two tables claim, rather than picking the later one', () => {
    const first = table({ corner: 'ss', temp: -40 });
    const f = soleDevice([first, table({ corner: 'ss', temp: -40 })]);
    expect(tableAt(f, key('ss', -40))).toBeUndefined();
  });

  it('keeps a duplicate at one condition from poisoning the others', () => {
    // The refusal is scoped to the ambiguous condition — the device's unambiguous conditions
    // keep projecting, so one bad re-import does not take the whole device off the bench.
    const f = soleDevice([
      table({ corner: 'tt' }),
      table({ corner: 'ss', temp: -40 }),
      table({ corner: 'ss', temp: -40 }),
    ]);
    expect(tableAt(f, key('ss', -40))).toBeUndefined();
    expect(tableAt(f, key('tt'))?.id.corner).toBe('tt');
  });

  it('lists the conditions it holds once each, in load order', () => {
    // A condition two tables claim is still ONE condition: a mode that offers it offers the
    // condition, and the ambiguity is answered where the condition is projected, not by
    // hiding it from the list.
    const f = soleDevice([
      table({ corner: 'ss', temp: -40 }),
      table({ corner: 'tt' }),
      table({ corner: 'ss', temp: -40 }),
    ]);
    expect(f.keys).toEqual([key('ss', -40), key('tt')]);
  });
});

// --- device QA ---------------------------------------------------------------

describe('validateFamily', () => {
  const rules = (f: CharacterizedDevice): string[] =>
    validateDeviceConditions(f).map((w) => w.rule);

  it('says nothing about a single-condition device', () => {
    expect(validateDeviceConditions(soleDevice([table()]))).toEqual([]);
  });

  it('says nothing about tables that agree on everything but their condition', () => {
    const meta = { W: 1e-5, simulator: 'ngspice', pdk: 'sky130A' };
    expect(
      validateDeviceConditions(
        soleDevice([table({ meta }), table({ corner: 'ss', temp: -40, meta })]),
      ),
    ).toEqual([]);
  });

  it('reports a duplicated condition as an error, naming it and the count', () => {
    const w = validateDeviceConditions(
      soleDevice([table({ corner: 'ss', temp: -40 }), table({ corner: 'ss', temp: -40 })]),
    );
    expect(w).toHaveLength(1);
    expect(w[0].rule).toBe('device-duplicate-condition');
    expect(w[0].severity).toBe('error');
    // The condition and how many tables claim it: what a bench needs to find and remove one.
    expect(w[0].message).toContain('ss@-40');
    expect(w[0].message).toMatch(/\b2\b/);
  });

  it('reports conditions that sweep different axes as an error', () => {
    const w = validateDeviceConditions(
      soleDevice([
        table({ axes: { l: [1e-7], vgs: [0, 0.1] } }),
        table({ corner: 'ss', axes: { l: [1e-7], vds: [0.5], vgs: [0, 0.1] } }),
      ]),
    );
    expect(w.map((x) => x.rule)).toEqual(['device-axes']);
    expect(w[0].severity).toBe('error');
    expect(w[0].message).toContain('vds');
  });

  it('reports a different sweep range over the same axes as a warning, not a blocker', () => {
    // Coverage is legitimately corner-specific; gating on it would refuse valid data.
    const w = validateDeviceConditions(
      soleDevice([
        table({ axes: { vgs: [0, 0.1, 0.2] } }),
        table({ corner: 'ss', axes: { vgs: [0, 0.1] } }),
      ]),
    );
    expect(w.map((x) => x.rule)).toEqual(['device-sweep-range']);
    expect(w[0].severity).toBe('warning');
  });

  it('sees a sweep that shares its ends and its count but not its sample points', () => {
    // Both run 0…0.4 in three points; only the middle one moves.
    expect(
      rules(
        soleDevice([
          table({ axes: { vgs: [0, 0.2, 0.4] } }),
          table({ corner: 'ss', axes: { vgs: [0, 0.1, 0.4] } }),
        ]),
      ),
    ).toEqual(['device-sweep-range']);
  });

  it('reports differing characterization widths and quantity columns', () => {
    const f = soleDevice([
      table({ meta: { W: 1e-5 }, quantities: ['id', 'gm', 'gds'] }),
      table({ corner: 'ss', meta: { W: 2e-5 }, quantities: ['id', 'gm'] }),
    ]);
    expect(rules(f).sort()).toEqual(['device-quantities', 'device-width']);
  });

  it('warns that a name-only device may not be one device when its provenance disagrees', () => {
    const w = validateDeviceConditions(
      soleDevice([
        table({ meta: { simulator: 'ngspice', extra: { source: 'lab-a' } } }),
        table({ corner: 'ss', meta: { simulator: 'ngspice', extra: { source: 'lab-b' } } }),
      ]),
    );
    expect(w.map((x) => x.rule)).toEqual(['device-provenance']);
    expect(w[0].message).toContain('lab-a');
    expect(w[0].message).toContain('# pdk:');
  });

  it('keeps doubting an inferred membership, whichever file arrived first', () => {
    // Grouping joined the undeclared file to the declared one, so this device's membership is
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
      const w = validateDeviceConditions(soleDevice(order));
      expect(w.map((x) => x.rule)).toContain('device-provenance');
    }
  });

  it('does not doubt the identity of a device whose namespace is declared', () => {
    // The same disagreement, with `pdk` present: identity is settled, so the finding is about
    // the data instead — different simulators, reported as such.
    const w = validateDeviceConditions(
      soleDevice([
        table({ meta: { pdk: 'sky130A', simulator: 'ngspice' } }),
        table({ corner: 'ss', meta: { pdk: 'sky130A', simulator: 'spectre' } }),
      ]),
    );
    expect(w.map((x) => x.rule)).toEqual(['device-simulator']);
    expect(w[0].severity).toBe('warning');
  });
});

describe('validateFamilies', () => {
  it('warns when an undeclared identity had to stay apart from declared ones', () => {
    // The bench-level counterpart of the join rule: grouping refused this join (two declared
    // namespaces to choose from), and no single device can see the sibling it stayed apart
    // from, so the refusal is said here.
    const devices = groupDevices([
      table({ device: 'dev', meta: { pdk: 'sky130A' } }),
      table({ device: 'dev', meta: { pdk: 'gf180mcuC' } }),
      table({ device: 'dev', corner: 'ss' }),
    ]);
    const w = validateDevices(devices);
    expect(w).toHaveLength(1);
    expect(w[0].rule).toBe('device-split');
    expect(w[0].severity).toBe('warning');
    expect(w[0].message).toContain('# pdk:');
    expect(w[0].message).not.toContain('# polarity:');
  });

  it('says nothing about fully declared same-name devices', () => {
    // Two PDKs both shipping an `nch` is legitimate, and both files said which they are.
    const n = { polarity: { device: 'n', signedInput: false } } as const;
    const w = validateDevices(
      groupDevices([
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
    equations: [],
    checks: [],
  });

  it('collects only the children that name a device, with their block paths', () => {
    const doc: SheetDoc = {
      ...leaf('top'),
      blocks: [
        { name: 'inherits', doc: leaf('a') },
        {
          name: 'tail',
          doc: { ...leaf('b'), blocks: [{ name: 'inner', doc: leaf('c'), device: 'deep' }] },
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
        doc: { ...leaf('mirror'), blocks: [{ name: 'out', doc: leaf('o'), device: 'ref-dev' }] },
      },
    ]);
    const doc: SheetDoc = { ...leaf('top'), blocks: [{ name: 'cm', ref: 'lib/mirror' }] };
    const got = namedBindings(doc, refs);
    expect(got.warnings).toEqual([]);
    expect(got.bindings).toEqual([{ path: 'cm.out', binding: 'ref-dev' }]);
  });

  it('returns the resolution failure that makes the binding list incomplete', () => {
    const doc: SheetDoc = { ...leaf('top'), blocks: [{ name: 'cm', ref: 'lib/absent' }] };
    const got = namedBindings(doc, buildSheetRefIndex([]));
    expect(got.bindings).toEqual([]);
    expect(got.warnings.map((w) => w.severity)).toEqual(['error']);
  });
});

// --- one run, one condition --------------------------------------------------

/** The constrained-node idiom the library writes: y = 2x + 1 solved to the typed spec T, with the
 *  claimed range [T_lo, T_hi] checked as range ends. Base T = 5 lands x = 2; the lo
 *  range end (T = 3) lands x = 1 and the hi range end (T = 7) lands x = 3. */
const constrainedDoc = (over: Partial<SheetDoc> = {}): SheetDoc => ({
  title: 'constrained',
  polarity: 'n',
  params: [
    { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'T' } },
    { name: 'T', value: 5 },
    { name: 'T_lo', value: 3 },
    { name: 'T_hi', value: 7 },
    { name: 'x_floor', value: 0.5 },
  ],
  equations: [{ name: 'y', expr: '2*x + 1' }],
  checks: [{ id: 'floor', kind: 'physical', lhs: 'x', op: '>=', rhs: 'x_floor' }],
  ...over,
});

describe('runCondition', () => {
  const primary = soleDevice([retag(dev, 'tt', 27), retag(dev, 'tt', 85)]);
  const noDevices = (): undefined => undefined;

  const gainDoc = (aMin: number): SheetDoc => ({
    title: 'gain',
    polarity: 'n',
    params: [
      { name: 'L', value: 0.5e-6 },
      { name: 'A_min', value: aMin },
    ],
    givens: { L: 'L', gm_id: '12', id: '2e-5', vds: '0.5' },
    equations: [{ name: 'A', expr: 'gm_gds' }],
    checks: [{ id: 'gain', kind: 'spec', lhs: 'A', op: '>=', rhs: 'A_min' }],
  });

  /** gainDoc plus one composed child bound by name — the shape the child-projection tests
   *  share. */
  const withTail = (binding: string): SheetDoc => ({
    ...gainDoc(20),
    blocks: [
      {
        name: 'tailblk',
        device: binding,
        doc: {
          title: 'tail',
          polarity: 'n',
          params: [],
          givens: { L: '5e-7', gm_id: '10', id: '2e-5', vds: '0.5' },
          equations: [],
          checks: [],
        },
      },
    ],
  });

  /** The given tables presented as one child device named `nch_tail`. */
  const tailDevice = (...tables: DeviceTable[]): CharacterizedDevice =>
    soleDevice(tables.map((t) => ({ ...t, id: { ...t.id, device: 'nch_tail' } })));

  it('evaluates at the requested condition and reports feasibility and its points', () => {
    const run = runCondition(gainDoc(20), primary, key('tt', 85), noDevices);
    expect(run.state).toBe('evaluated');
    if (run.state !== 'evaluated') return;
    expect(run.key).toEqual(key('tt', 85));
    expect(run.design).toBe('sized');
    expect(run.feasible).toBe(true);
    // No operating range declared: the one compliance point is the design's own centre.
    expect(run.points).toEqual([{ state: 'complies' }]);
  });

  it('reports the two conditions differently when the characterizations differ', () => {
    // The demo model's intrinsic gain is closed-form. Its drain current and gm rise as
    // 1 + vds/VA with VA = VA_PER_L·L while gds stays put, so gm/gds = (gm/ID)·(VA + vds):
    // giving gm/ID = 12 at L = 0.5 µm and vds = 0.5 V gives 12 × (2.5 + 0.5) V = 36. The slow
    // condition's table carries a doubled gds column, halving that to 18 at the same sized point
    // — so a 20 V/V spec check must pass at tt and fail at ss, with no other difference between
    // the runs.
    expect(VA_PER_L * 0.5e-6).toBe(2.5);
    const slow = retag(scaleQuantities(dev, { gds: 2 }), 'ss', -40);
    const device = soleDevice([retag(dev, 'tt', 27), slow]);
    const doc = gainDoc(20);

    const fast = runCondition(doc, device, key('tt'), noDevices);
    const cold = runCondition(doc, device, key('ss', -40), noDevices);
    expect([fast.state, cold.state]).toEqual(['evaluated', 'evaluated']);
    if (fast.state !== 'evaluated' || cold.state !== 'evaluated') return;
    expect(fast.feasible).toBe(true);
    expect(cold.feasible).toBe(false);
    expect(cold.points).toEqual([{ state: 'does-not-comply' }]);
    expect(fast.result.values.A / cold.result.values.A).toBeCloseTo(2, 6);
  });

  it('refuses a condition the primary device is not characterized at', () => {
    const run = runCondition(gainDoc(20), primary, key('ff'), noDevices);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['absent-condition']);
    expect(run.issues[0].message).toContain('ff');
    expect(run.result).toBeUndefined();
  });

  it('refuses a condition two loaded tables claim', () => {
    const ambiguous = soleDevice([retag(dev, 'tt'), retag(dev, 'tt')]);
    const run = runCondition(gainDoc(20), ambiguous, key('tt'), noDevices);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['ambiguous-condition']);
  });

  it('projects every named child to the run’s condition, never to the child’s own nominal', () => {
    // The child device is characterized ONLY at tt@85 — its own nominal. A tt@27 run that
    // silently used it would report a verdict for a chip that was never at one temperature.
    const child = tailDevice(retag(dev, 'tt', 85));
    const doc = withTail('tail-binding');
    const deviceOf = (b: string): CharacterizedDevice | undefined =>
      b === 'tail-binding' ? child : undefined;

    const mixed = runCondition(doc, primary, key('tt', 27), deviceOf);
    expect(mixed.state).toBe('not-evaluated');
    if (mixed.state !== 'not-evaluated') return;
    expect(mixed.issues).toHaveLength(1);
    expect(mixed.issues[0].kind).toBe('absent-condition');
    expect(mixed.issues[0].device).toBe('nch_tail');
    expect(mixed.issues[0].message).toContain('tailblk');

    // At the condition both are characterized at, the same sheet runs.
    expect(runCondition(doc, primary, key('tt', 85), deviceOf).state).toBe('evaluated');
  });

  it('refuses a child device that is ambiguous at the run’s condition, naming the block', () => {
    const child = tailDevice(retag(dev, 'tt'), retag(dev, 'tt'));
    const run = runCondition(withTail('tail-binding'), primary, key('tt'), () => child);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['ambiguous-condition']);
    expect(run.issues[0].message).toContain('tailblk');
  });

  it('lists every missing device in one refusal, not only the first', () => {
    // Neither the primary nor the child is characterized at ff. A refusal that stopped at the
    // first hole would send the user importing tables one round trip at a time.
    const child = tailDevice(retag(dev, 'ss', -40));
    const run = runCondition(withTail('tail-binding'), primary, key('ff'), () => child);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['absent-condition', 'absent-condition']);
    expect(new Set(run.issues.map((i) => i.device)).size).toBe(2);
  });

  it('refuses a device whose members do not sweep the same axes, at every condition', () => {
    // Which member is wrongly grouped is unknowable from the data, so the refusal is
    // device-wide rather than scoped to the oddly-shaped member's own condition — the run
    // here asks for tt, whose table is the ordinary one.
    const device = soleDevice([
      table({ axes: { vgs: [0, 0.1, 0.2] } }),
      table({ corner: 'ss', temp: -40, axes: { vgs: [0, 0.1, 0.2], vds: [0, 0.9] } }),
    ]);
    const run = runCondition(gainDoc(20), device, key('tt'), noDevices);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['incompatible-table']);
  });

  it('screens a condition on the same grounds without evaluating it', () => {
    // What a search asks before spending an evaluation. It must answer with the run's own
    // refusals — the PRIMARY device's included, which is the ground a hand-written child-only
    // walk drops: a device whose members sweep different axes would then be searched and
    // ranked, and refused afterwards by every panel that tried to evaluate it.
    const mixed = soleDevice([
      table({ axes: { vgs: [0, 0.1, 0.2] } }),
      table({ corner: 'ss', temp: -40, axes: { vgs: [0, 0.1, 0.2], vds: [0, 0.9] } }),
    ]);
    const screened = preflightCondition(gainDoc(20), mixed, key('tt'), noDevices);
    expect(screened.issues.map((i) => i.kind)).toEqual(['incompatible-table']);
    expect(screened.primary).toBeUndefined();

    // A named child nothing answers to, reported in the run's words rather than the caller's.
    const missing = preflightCondition(withTail('tail-binding'), primary, key('tt'), noDevices);
    expect(missing.issues.map((i) => i.kind)).toEqual(['absent-condition']);
    expect(missing.issues[0].message).toBe(
      'block "tailblk" names device "tail-binding", which is not loaded',
    );

    // Nothing in the way: the primary's table at the condition comes back, and no evaluation
    // has happened.
    const clear = preflightCondition(gainDoc(20), primary, key('tt', 85), noDevices);
    expect(clear.issues).toEqual([]);
    expect(clear.primary?.id.temp).toBe(85);
  });

  // --- one design across a set of conditions --------------------------------------------

  /** A second characterization with half the drain current and half the transconductance at
   *  every gate voltage: gm/ID is unchanged point for point, the current density is halved. */
  const weak = (): DeviceTable => retag(scaleQuantities(dev, { id: 0.5, gm: 0.5 }), 'ss', -40);
  const twoCorners = (): CharacterizedDevice => soleDevice([retag(dev, 'tt', 27), weak()]);
  /** A run's whole answer apart from the numbers: state, verdicts, and any refusals. */
  const verdict = (r: ConditionRun): unknown =>
    r.state === 'evaluated'
      ? [r.state, r.key, r.feasible, r.points]
      : [r.state, r.key, r.issues, r.points];

  it('sizes the design at the base condition exactly as a single run does', () => {
    // The set shares the single run's state machine for the condition the design is sized at;
    // only what does not depend on the condition is lifted out of the loop.
    const device = twoCorners();
    const [base] = runConditions(
      gainDoc(20),
      device,
      [key('tt'), key('ss', -40)],
      noDevices,
      undefined,
      key('tt'),
    );
    const alone = runCondition(gainDoc(20), device, key('tt'), noDevices);
    expect(verdict(base)).toEqual(verdict(alone));
    expect(base.result?.warnings).toEqual(alone.result?.warnings);
    expect(base.state === 'evaluated' && base.design).toBe('sized');
  });

  it('holds that design at another condition instead of sizing a second one', () => {
    // The sheet asks for gm/ID = 12 at 20 µA. At the weak condition every gate voltage carries
    // half the current density at the same gm/ID, so a design sized THERE lands on the same gate
    // voltage with twice the width. The design sized at tt has the tt width; held at the weak
    // condition it must pull twice the density out of the weak table, which takes a higher gate
    // voltage and so a lower gm/ID. Same transistor, different operating point.
    const device = twoCorners();
    const doc: SheetDoc = { ...gainDoc(0), equations: [{ name: 'eff', expr: 'gm_id' }] };
    const [tt, ss] = runConditions(
      doc,
      device,
      [key('tt'), key('ss', -40)],
      noDevices,
      undefined,
      key('tt'),
    );
    const resized = runCondition(doc, device, key('ss', -40), noDevices);
    expect([tt.state, ss.state, resized.state]).toEqual(['evaluated', 'evaluated', 'evaluated']);
    if (tt.state !== 'evaluated' || ss.state !== 'evaluated' || resized.state !== 'evaluated')
      return;
    const [wTt, wHeld, wResized] = [tt, ss, resized].map((r) => r.result.sizing!.W);
    expect(wResized / wTt).toBeCloseTo(2, 6); // what a per-condition re-size would have built
    expect(resized.result.sizing!.vgs).toBeCloseTo(tt.result.sizing!.vgs, 9);
    expect(ss.design).toBe('held');
    expect(wHeld).toBe(wTt); // to the last bit: this is the tt transistor
    expect(ss.result.sizing!.id).toBe(tt.result.sizing!.id); // the authored current, unchanged
    expect(ss.result.sizing!.vgs).toBeGreaterThan(tt.result.sizing!.vgs);
    expect(tt.result.values.eff).toBeCloseTo(12, 9);
    expect(ss.result.values.eff).toBeLessThan(12);
  });

  it('holds a gate on a shared node at another condition, and solves the current it balances', () => {
    // An inverter's two halves: the NMOS sized from a typed bias and gm/ID = 12, the PMOS given
    // that current and the gate voltage the supply leaves. At the slow condition the NMOS's
    // threshold sits 40 mV higher and the PMOS's 20 mV lower. Held there, the design keeps its
    // supply: both gates stay on one node, the bias carries the `hold` that balances the two
    // currents, and the input level moves to where they agree. The supply is twice the demo's
    // gate voltage at gm/ID = 12 and the output half of it, so both halves are the same device at
    // the design point and the balance sits at V_in = (VDD + 0.04 + 0.02)/2 in closed form.
    const V0 = 0.567023; // the demo at gm/ID = 12, L = 0.5 µm, body grounded
    const VDD = 2 * V0;
    const slower = (t: DeviceTable, dv: number): DeviceTable => {
      const axisNames = new Set(t.grid.axes.map((a) => a.name));
      const axes = t.grid.axes.map((a) =>
        a.name === 'vgs' ? { name: a.name, values: a.values.map((v) => v + dv) } : a,
      );
      const quantities = new Map([...t.grid.quantities].filter(([k]) => !axisNames.has(k)));
      return retag({ ...t, grid: makeGrid(axes, quantities) }, 'ss');
    };
    const pmos: DeviceTable = {
      ...dev,
      id: { ...dev.id, device: 'pmos_demo' },
      meta: { ...dev.meta, polarity: { device: 'p', signedInput: false } },
    };
    const nDevice = soleDevice([retag(dev, 'tt'), slower(dev, 0.04)]);
    const pDevice = soleDevice([retag(pmos, 'tt'), slower(pmos, -0.02)]);
    const half = (title: string, givens: SheetDoc['givens']): SheetDoc => ({
      title,
      polarity: title === 'p' ? 'p' : 'n',
      params: [
        { name: 'I_d', value: 2e-5, unit: 'A' },
        { name: 'vgs_d', value: 0.5, unit: 'V' },
        { name: 'vds_d', value: 0.5, unit: 'V' },
      ],
      givens,
      equations: [],
      checks: [],
      provides: ['vgs', 'id'],
    });
    const doc: SheetDoc = {
      title: 'inverter',
      polarity: 'n',
      params: [
        { name: 'VDD', value: VDD, unit: 'V', class: 'independent' },
        { name: 'V_out', value: V0, unit: 'V', class: 'independent' },
        { name: 'I_bias', value: 2e-5, min: 2e-6, max: 2e-4, unit: 'A', hold: 'I_bias - p__id' },
      ],
      blocks: [
        {
          name: 'n',
          doc: half('n', { L: '5e-7', id: 'I_d', gm_id: '12', vds: 'vds_d' }),
          params: { I_d: 'I_bias', vds_d: 'V_out' },
        },
        {
          name: 'p',
          device: 'pmos',
          doc: half('p', { L: '5e-7', id: 'I_d', vgs: 'vgs_d', vds: 'vds_d' }),
          params: { I_d: 'n__id', vgs_d: 'VDD - n__vgs', vds_d: 'VDD - V_out' },
          wiring: { gate: 'V_in', source: 'VDD' },
        },
      ],
      equations: [{ name: 'V_in', expr: 'n__vgs', unit: 'V' }],
      checks: [],
    };
    const [tt, ss] = runConditions(
      doc,
      nDevice,
      [key('tt'), key('ss')],
      (b) => (b === 'pmos' ? pDevice : undefined),
      undefined,
      key('tt'),
    );
    expect([tt.state, ss.state]).toEqual(['evaluated', 'evaluated']);
    if (tt.state !== 'evaluated' || ss.state !== 'evaluated') return;
    expect(ss.design).toBe('held');
    expect(ss.points[0].state).toBe('complies');
    const v = ss.result.values;
    expect(v.n__vgs + v.p__vgs).toBeCloseTo(VDD, 12);
    expect(Math.abs(v.n__id - v.p__id) / v.n__id).toBeLessThan(1e-5);
    expect(v.V_in).toBeCloseTo((VDD + 0.04 + 0.02) / 2, 3);
    expect(v.I_bias).toBe(v.n__id);
    expect(v.I_bias).toBeLessThan(tt.result.values.I_bias);
    expect(ss.result.warnings.filter((w) => w.rule === 'sheet-wiring')).toEqual([]);
  });

  it('answers at the base first, even when the base is not one of the conditions asked about', () => {
    // Feasibility is the base condition's verdict, so its run is part of every answer: asked
    // about ss alone with tt as the base, the set is tt (sized) and then ss (held).
    const device = twoCorners();
    const doc = gainDoc(0);
    const runs = runConditions(doc, device, [key('ss', -40)], noDevices, undefined, key('tt'));
    expect(runs.map((r) => [r.key, r.design])).toEqual([
      [key('tt'), 'sized'],
      [key('ss', -40), 'held'],
    ]);
    const tt = runCondition(doc, device, key('tt'), noDevices);
    expect(runs[0]).toEqual(tt);
    expect(runs[1].result?.sizing?.W).toBe(tt.result?.sizing?.W);
  });

  it('takes a single condition as its own base', () => {
    const [only] = runConditions(gainDoc(20), twoCorners(), [key('ss', -40)], noDevices);
    expect(only.state === 'evaluated' && only.design).toBe('sized');
  });

  it('declines a set of conditions when nothing says where the design is sized', () => {
    const runs = runConditions(gainDoc(20), twoCorners(), [key('tt'), key('ss', -40)], noDevices);
    expect(runs.map((r) => r.state)).toEqual(['not-evaluated', 'not-evaluated']);
    for (const r of runs)
      expect(r.state === 'not-evaluated' && r.issues.map((i) => i.kind)).toEqual(['no-design']);
  });

  it('has nothing to hold when the base condition does not evaluate', () => {
    // ff is not characterized: the base is refused for its own reason, and the other condition
    // is told there is no design — never evaluated on its own as if it were one.
    const [ff, ss] = runConditions(
      gainDoc(20),
      twoCorners(),
      [key('ff'), key('ss', -40)],
      noDevices,
      undefined,
      key('ff'),
    );
    expect(ff.state === 'not-evaluated' && ff.issues.map((i) => i.kind)).toEqual([
      'absent-condition',
    ]);
    expect(ss.state === 'not-evaluated' && ss.issues.map((i) => i.kind)).toEqual(['no-design']);
    expect(ss.result).toBeUndefined();
  });

  it('reports what is wrong with a condition itself ahead of there being no design', () => {
    // The base (ff) is not characterized, so nothing can be held anywhere. But xx is not
    // characterized either, and that is the more useful thing to say about xx: importing the
    // missing table is its fix, whatever happens at the base.
    const [ff, ss, xx] = runConditions(
      gainDoc(20),
      twoCorners(),
      [key('ss', -40), key('xx')],
      noDevices,
      undefined,
      key('ff'),
    );
    expect(ff.design).toBe('sized');
    expect(ff.state === 'not-evaluated' && ff.issues.map((i) => i.kind)).toEqual([
      'absent-condition',
    ]);
    expect(ss.state === 'not-evaluated' && ss.issues.map((i) => i.kind)).toEqual(['no-design']);
    expect(xx.state === 'not-evaluated' && xx.issues.map((i) => i.kind)).toEqual([
      'absent-condition',
    ]);
    // None of the three was asked anything: no table, or no design to hold.
    expect([ff, ss, xx].flatMap((r) => r.points.map((p) => p.state))).toEqual([
      'not-run',
      'not-run',
      'not-run',
    ]);
  });

  it('names the blocks whose current is held as an ideal source', () => {
    // Bound by gm and gm/ID, the sheet never says where the current comes from, so holding the
    // design holds the current the base run arrived at. Bound by an authored current, it does.
    const device = twoCorners();
    const derived: SheetDoc = {
      ...gainDoc(0),
      givens: { L: 'L', gm_id: '12', gm: '2.4e-4', vds: '0.5' },
    };
    const run = (doc: SheetDoc): ConditionRun =>
      runConditions(doc, device, [key('ss', -40)], noDevices, undefined, key('tt'))[1];
    const a = run(derived);
    const b = run(gainDoc(0));
    expect(a.state === 'evaluated' && a.assumedSource).toEqual(['givens']);
    expect(b.state === 'evaluated' && b.assumedSource).toBeUndefined();
  });

  it('declines to hold a design that rests on an assumed voltage', () => {
    // V_d is classed assumed and feeds the device's sizing. At the base that is reported with
    // the result; at another condition the typed value would be held as if it were hardware, so
    // the question is declined by name. Classed independent, the same sheet is held and answered.
    const withDrain = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.05 } });
    const device = soleDevice([retag(withDrain, 'tt', 27), retag(withDrain, 'tt', 85)]);
    const drained = (cls: 'assumed' | 'independent'): SheetDoc => ({
      ...gainDoc(20),
      params: [...gainDoc(20).params, { name: 'V_d', value: 0.6, unit: 'V', class: cls }],
      givens: { L: 'L', gm_id: '12', id: '2e-5', vds: 'V_d' },
    });
    const ask = (cls: 'assumed' | 'independent'): ConditionRun[] =>
      runConditions(
        drained(cls),
        device,
        [key('tt', 27), key('tt', 85)],
        noDevices,
        undefined,
        key('tt', 27),
      );

    const [base, other] = ask('assumed');
    expect(base.state).toBe('evaluated');
    expect(base.result?.assumptions).toEqual(['V_d']);
    expect(other.state === 'not-evaluated' && other.issues.map((i) => i.kind)).toEqual([
      'assumed-level',
    ]);
    expect(other.state === 'not-evaluated' && other.issues[0].message).toContain('V_d');

    // Feasibility holds nothing fixed, so it still reports. Compliance has no answer anywhere —
    // asked and declined, which is not the same as never asked.
    const fenced = aggregateConditionRuns([base, other]);
    expect(fenced.feasibility).toBe('feasible');
    expect(fenced.compliance).toEqual({
      complies: 0,
      doesNotComply: 0,
      noAnswer: 2,
      notRun: 0,
      total: 2,
    });
    expect(base.points[0].error).toContain('V_d');

    expect(ask('independent').map((r) => r.state === 'evaluated' && r.design)).toEqual([
      'sized',
      'held',
    ]);
    expect(evaluateSheet(drained('assumed'), withDrain).assumptions).toBeUndefined();
  });

  it('calls a held device that cannot carry its current a failure, not a missing answer', () => {
    // Sized at gm/ID = 4 for 20 µA, the device sits near the top of its swept gate-voltage
    // range. At a condition where every gate voltage carries a quarter of the current, no
    // characterized gate voltage reaches 20 µA at that width (the table tops out near 12 µA):
    // the built transistor cannot do its job there. That is a verdict about the design.
    const quarter = retag(scaleQuantities(dev, { id: 0.25, gm: 0.25 }), 'ss', -40);
    const doc: SheetDoc = {
      ...gainDoc(0),
      givens: { L: 'L', gm_id: '4', id: '2e-5', vds: '0.5' },
    };
    const [tt, ss] = runConditions(
      doc,
      soleDevice([retag(dev, 'tt', 27), quarter]),
      [key('tt'), key('ss', -40)],
      noDevices,
      undefined,
      key('tt'),
    );
    expect(tt.state).toBe('evaluated');
    // The run produced no usable numbers, so it is not shown as evaluated — and its one point
    // still carries the verdict.
    expect(ss.state).toBe('not-evaluated');
    expect(ss.points).toHaveLength(1);
    expect(ss.points[0].state).toBe('does-not-comply');
    expect(ss.points[0].error).toMatch(/^this device cannot carry its current here/);
    expect(aggregateConditionRuns([tt, ss]).compliance).toEqual({
      complies: 1,
      doesNotComply: 1,
      noAnswer: 0,
      notRun: 0,
      total: 2,
    });
  });

  it("gives no answer at a condition whose table was taken at one drain voltage, not the design's", () => {
    // Both conditions carry a vds column holding a single value, so they sweep the same axes
    // and are one device. The nominal one was taken at 0.9 V, where the design sits: it is
    // sized there with nothing to say. The other was taken at 0.6 V, so the held device has no
    // table to be read from — refused, which at a compliance point is no answer, not a failure.
    const takenAt = (vds: number): DeviceTable =>
      generateDemoDevice({ vds: { min: vds, max: vds, step: 0.1 } });
    expect(takenAt(0.6).grid.axes.map((a) => a.values.length)).toEqual([4, 1, 121]);
    const doc: SheetDoc = {
      ...gainDoc(0),
      givens: { L: 'L', gm_id: '12', id: '2e-5', vds: '0.9' },
    };
    const runs = runConditions(
      doc,
      soleDevice([retag(takenAt(0.9), 'tt', 27), retag(takenAt(0.6), 'ss', -40)]),
      [key('tt'), key('ss', -40)],
      noDevices,
      undefined,
      key('tt'),
    );
    const [tt, ss] = runs;
    expect(tt.state === 'evaluated' && tt.design).toBe('sized');
    expect(tt.result?.warnings).toEqual([]);
    expect(tt.points).toEqual([{ state: 'complies' }]);

    expect(ss.state).toBe('not-evaluated');
    expect(ss.design).toBe('held');
    expect(ss.points).toHaveLength(1);
    expect(ss.points[0].state).toBe('no-answer');
    expect(ss.points[0].error).toMatch(/^given vds = 0\.9/);
    expect(ss.points[0].error).toMatch(/no vds sweep/);
    expect(ss.state === 'not-evaluated' && ss.issues.map((i) => i.kind)).toEqual([
      'runtime-evaluation',
    ]);
    expect(ss.result?.sizing?.ok).toBe(false);
    expect(aggregateConditionRuns(runs).compliance).toEqual({
      complies: 1,
      doesNotComply: 0,
      noAnswer: 1,
      notRun: 0,
      total: 2,
    });
    // Feasibility is the sized run's and is untouched by the condition that could not answer.
    expect(aggregateConditionRuns(runs).feasibility).toBe('feasible');
  });

  it('names the block a held condition cannot size, and gives no answer there', () => {
    // A composed design whose `pair` sits with its source at the body. The nominal table was
    // taken body-grounded and the other with the body biased 0.3 V — one vsb value each, so
    // one device. Held at the second, `pair` asks for vsb = 0 on a table taken at 0.3.
    const takenAt = (vsb: number): DeviceTable =>
      generateDemoDevice({
        vds: { min: 0, max: 1.2, step: 0.3 },
        vsb: { min: vsb, max: vsb, step: 0.1 },
      });
    const doc: SheetDoc = {
      title: 'composed',
      polarity: 'n',
      params: [],
      equations: [],
      checks: [{ id: 'headroom', kind: 'physical', lhs: 'pair__vstar', op: '>=', rhs: '0.1' }],
      blocks: [
        {
          name: 'pair',
          doc: {
            title: 'pair',
            polarity: 'n',
            params: [],
            givens: { L: '5e-7', gm_id: '12', id: '2e-5', vds: '0.6', vsb: '0' },
            equations: [],
            checks: [],
            provides: ['vstar'],
          },
        },
      ],
    };
    const runs = runConditions(
      doc,
      soleDevice([retag(takenAt(0), 'tt', 27), retag(takenAt(0.3), 'ss', -40)]),
      [key('tt'), key('ss', -40)],
      noDevices,
      undefined,
      key('tt'),
    );
    const [tt, ss] = runs;
    expect(tt.state === 'evaluated' && tt.feasible).toBe(true);
    expect(tt.points).toEqual([{ state: 'complies' }]);

    expect(ss.state).toBe('not-evaluated');
    expect(ss.points[0].state).toBe('no-answer');
    expect(ss.points[0].error).toMatch(/^block "pair": given vsb = 0 /);
    expect(ss.points[0].error).toMatch(/no vsb sweep/);
    expect(ss.result?.blocks?.[0].feasible).toBe(false);
    expect(aggregateConditionRuns(runs).compliance).toEqual({
      complies: 1,
      doesNotComply: 0,
      noAnswer: 1,
      notRun: 0,
      total: 2,
    });
  });

  it('gives no answer at a condition whose table does not reach the bias the design sits at', () => {
    // The design is biased at vds = 1.0 V. The second condition was characterized only to
    // 0.8 V, so the held device is read 0.2 V away from where it sits. The run completes and
    // every check passes — on the wrong data — so the point is neither a pass nor a failure.
    const wide = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.05 } });
    const narrow = generateDemoDevice({ vds: { min: 0, max: 0.8, step: 0.05 } });
    const doc: SheetDoc = {
      ...gainDoc(0),
      givens: { L: 'L', gm_id: '12', id: '2e-5', vds: '1.0' },
    };
    const runs = runConditions(
      doc,
      soleDevice([retag(wide, 'tt', 27), retag(narrow, 'ss', -40)]),
      [key('tt'), key('ss', -40)],
      noDevices,
      undefined,
      key('tt'),
    );
    const ss = runs[1];
    expect(ss.state === 'evaluated' && ss.feasible).toBe(true); // what the clamped data says
    expect(ss.points[0].state).toBe('no-answer');
    expect(ss.points[0].error).toMatch(/^the table does not reach this point \(givens vds\)/);
    const agg = aggregateConditionRuns(runs);
    expect(agg.compliance).toEqual({
      complies: 1,
      doesNotComply: 0,
      noAnswer: 1,
      notRun: 0,
      total: 2,
    });
    // And its margin is not quoted: the only measured point is the base's.
    expect(agg.worst?.key).toEqual(key('tt'));
  });

  it('asks every condition about the same range, resolved once at the base', () => {
    // The range end is written against the design's own gain: "a floor 10 below A". At the base
    // A = 36, so that end is Floor = 26. The second condition halves the gain to 18 — and the
    // end it is asked about is still Floor = 26, the application's number, not 18 - 10 = 8.
    // There the held design has A = 18 against a floor of 26 and does not comply; re-reading the
    // expression per condition would have asked 18 >= 8 and passed.
    const slow = retag(scaleQuantities(dev, { gds: 2 }), 'ss', -40);
    const doc: SheetDoc = {
      ...gainDoc(0),
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'Floor', value: 0 },
      ],
      checks: [{ id: 'gain', kind: 'spec', lhs: 'A', op: '>=', rhs: 'Floor' }],
      operatingRange: [{ name: 'tight', set: { Floor: 'A - 10' } }],
    };
    const [tt, ss] = runConditions(
      doc,
      soleDevice([retag(dev, 'tt', 27), slow]),
      [key('tt'), key('ss', -40)],
      noDevices,
      undefined,
      key('tt'),
    );
    const at = (r: ConditionRun): number | undefined => r.result?.rangeEnds?.[0].set.Floor;
    expect(at(tt)).toBeCloseTo((VA_PER_L * 0.5e-6 + 0.5) * 12 - 10, 1); // 36 - 10
    expect(at(ss)).toBe(at(tt));
    expect(ss.result?.values.A).toBeCloseTo(18, 1);
    expect(tt.points.map((p) => p.state)).toEqual(['complies', 'complies']);
    expect(ss.points.map((p) => p.state)).toEqual(['complies', 'does-not-comply']);
  });

  it('answers the same at a condition identical to the one the design was sized at', () => {
    // The whole library, each sheet asked about two conditions whose tables are the SAME table
    // under two labels. A design held at a condition identical to its base is the same circuit
    // on the same silicon, so anything that differs between the two rows is a defect in the
    // holding, not a property of the design: every transistor keeps its width to the last bit,
    // feasibility reads the same, and every point lands in the same state.
    const device = soleDevice([retag(libTable, 'tt', 27), retag(libTable, 'ss', -40)]);
    const widths = (r: ConditionRun): unknown => {
      const walk = (n: { sizing?: { W: number }; blocks?: readonly unknown[] }): unknown => [
        n.sizing?.W,
        (n.blocks ?? []).map((c) => walk(c as never)),
      ];
      return r.result ? walk(r.result as never) : undefined;
    };
    let held = 0;
    for (const { file, doc } of loadLibrary()) {
      const [sized, other] = runConditions(
        doc,
        device,
        [key('tt'), key('ss', -40)],
        noDevices,
        REFS,
        key('tt'),
      );
      expect([sized.design, other.design], file).toEqual(['sized', 'held']);
      if (sized.state !== 'evaluated') {
        // Nothing was sized, so nothing was asked of the other condition.
        expect(
          other.points.map((p) => p.state),
          file,
        ).toEqual(other.points.map(() => 'not-run'));
        continue;
      }
      held++;
      expect(other.state, file).toBe('evaluated');
      if (other.state !== 'evaluated') continue;
      expect(widths(other), file).toEqual(widths(sized));
      expect(other.feasible, file).toBe(sized.feasible);
      // One difference is by design: a bias the table does not reach is an advisory where the
      // design is sized and no answer where it is held. No shipped sheet sits off this table at
      // its own centre, and this is where that would show.
      expect(clampedIn(sized.result), file).toEqual([]);
      expect(other.points, file).toEqual(sized.points);
    }
    // Not vacuous: the library does evaluate on this table.
    expect(held).toBeGreaterThan(30);
  });

  it('fixes every range end at the base, not only the first', () => {
    // Two ends, both written against the design's own gain (36 at the base, 18 at the slow
    // condition). Each must be asked at the base's number at both conditions: 31 and 16.
    const slow = retag(scaleQuantities(dev, { gds: 2 }), 'ss', -40);
    const doc: SheetDoc = {
      ...gainDoc(0),
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'Floor', value: 0 },
      ],
      checks: [{ id: 'gain', kind: 'spec', lhs: 'A', op: '>=', rhs: 'Floor' }],
      operatingRange: [
        { name: 'near', set: { Floor: 'A - 5' } },
        { name: 'far', set: { Floor: 'A - 20' } },
      ],
    };
    const runs = runConditions(
      doc,
      soleDevice([retag(dev, 'tt', 27), slow]),
      [key('tt'), key('ss', -40)],
      noDevices,
      undefined,
      key('tt'),
    );
    const asked = (r: ConditionRun): (number | undefined)[] =>
      (r.result?.rangeEnds ?? []).map((e) => e.set.Floor);
    expect(asked(runs[0])[0]).toBeCloseTo(31, 1);
    expect(asked(runs[0])[1]).toBeCloseTo(16, 1);
    expect(asked(runs[1])).toEqual(asked(runs[0]));
    // Held at the slow condition the gain is 18: short of the near end's 31, clear of the far
    // end's 16 — and the aggregate names the end that owns the tightest margin.
    expect(runs[1].points.map((p) => [p.rangeEnd, p.state])).toEqual([
      [undefined, 'complies'],
      ['near', 'does-not-comply'],
      ['far', 'complies'],
    ]);
    const worst = aggregateConditionRuns(runs).worst;
    expect(worst).toMatchObject({ id: 'gain', key: key('ss', -40), rangeEnd: 'near' });
    expect(worst?.marginPct).toBeCloseTo((18 - 31) / 31, 2);
  });

  it('leaves the range ends of a held condition unasked when its own centre does not settle', () => {
    // A solved node whose relation reads the device: y = A + x must equal 41, with A the
    // intrinsic gain. At the base A = 36, so x lands at 5. The slow condition halves the gain to
    // 18, the held design then needs x = 23, and the search range [0, 10] does not contain it:
    // the held centre has no answer, and a centre that did not settle leaves nothing to ask at
    // the range end.
    const slow = retag(scaleQuantities(dev, { gds: 2 }), 'ss', -40);
    const doc: SheetDoc = {
      title: 'unsettled-held',
      polarity: 'n',
      params: [
        { name: 'L', value: 0.5e-6 },
        { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: '41' } },
        { name: 'Spec', value: 1 },
        { name: 'Spec_hi', value: 2 },
      ],
      givens: { L: 'L', gm_id: '12', id: '2e-5', vds: '0.5' },
      equations: [
        { name: 'A', expr: 'gm_gds' },
        { name: 'y', expr: 'A + x' },
      ],
      checks: [],
      operatingRange: [{ name: 'hi', set: { Spec: 'Spec_hi' } }],
    };
    const [tt, ss] = runConditions(
      doc,
      soleDevice([retag(dev, 'tt', 27), slow]),
      [key('tt'), key('ss', -40)],
      noDevices,
      undefined,
      key('tt'),
    );
    expect(tt.points.map((p) => p.state)).toEqual(['complies', 'complies']);
    expect(tt.result?.values.x).toBeCloseTo(5, 1);
    expect(ss.state).toBe('not-evaluated');
    expect(ss.points.map((p) => [p.rangeEnd, p.state])).toEqual([
      [undefined, 'no-answer'],
      ['hi', 'not-run'],
    ]);
    expect(ss.points[0].error).toMatch(/does not change sign/);
  });

  it('says what is wrong with a condition even when no condition is the base', () => {
    // Several conditions and no nominal: nothing is sized, so every row is declined. A row
    // whose own table is missing still says THAT, since importing it is a different fix.
    const [tt, xx] = runConditions(gainDoc(20), twoCorners(), [key('tt'), key('xx')], noDevices);
    expect(tt.state === 'not-evaluated' && tt.issues.map((i) => i.kind)).toEqual(['no-design']);
    expect(xx.state === 'not-evaluated' && xx.issues.map((i) => i.kind)).toEqual([
      'absent-condition',
    ]);
  });

  it('carries a curated library sheet across two conditions', () => {
    // A real library document, not a synthetic one: the CS amp with a current-source load
    // computes Av = gm·Rout with Rout = 1/(gds + load__gds) and gm set by its GBW spec, so
    // a slow characterization with every gds doubled halves Av exactly — the load inherits
    // the projected primary table, so both gds terms scale together.
    const entry = loadLibrary().find((s) => s.file === 'stages/cs-amp-current-source-load.json');
    expect(entry).toBeDefined();
    if (!entry) return;
    // Both of its devices state a drain voltage, so the conditions carry a vds sweep: a device
    // is sized only on a table that has the sweeps its givens use.
    const withDrain = generateDemoDevice({ vds: { min: 0, max: 1.2, step: 0.05 } });
    const device = soleDevice([
      retag(withDrain, 'tt', 27),
      retag(scaleQuantities(withDrain, { gds: 2 }), 'ss', -40),
    ]);
    const fast = runCondition(entry.doc, device, key('tt'), noDevices);
    const slow = runCondition(entry.doc, device, key('ss', -40), noDevices);
    expect([fast.state, slow.state]).toEqual(['evaluated', 'evaluated']);
    if (fast.state !== 'evaluated' || slow.state !== 'evaluated') return;
    expect(fast.result.values.Av / slow.result.values.Av).toBeCloseTo(2, 6);
    // Each condition is judged from its own numbers.
    const gainMargin = (r: typeof fast): number =>
      r.result.checks.find((x) => x.id === 'gain-spec')?.marginPct ?? NaN;
    expect(gainMargin(slow)).toBeLessThan(gainMargin(fast));
  });

  it('preflights a device named two levels down, and a device named through a reference', () => {
    // Both are blocks the top sheet never mentions: one nested inside an embedded child, one
    // materialized from the library. Neither may reach the engine unpreflighted.
    const sizing = { L: '5e-7', gm_id: '10', id: '2e-5', vds: '0.5' };
    const inner: SheetDoc = {
      title: 'inner',
      polarity: 'n',
      params: [],
      givens: sizing,
      equations: [],
      checks: [],
    };
    const nested: SheetDoc = {
      ...gainDoc(20),
      blocks: [
        {
          name: 'mid',
          doc: {
            title: 'mid',
            polarity: 'n',
            params: [],
            equations: [],
            checks: [],
            blocks: [{ name: 'deep', doc: inner, device: 'deep-binding' }],
          },
        },
      ],
    };
    const deep = runCondition(nested, primary, key('tt'), noDevices);
    expect(deep.state).toBe('not-evaluated');
    if (deep.state !== 'not-evaluated') return;
    expect(deep.issues[0].message).toContain('mid.deep');

    const refs = buildSheetRefIndex([
      {
        path: 'lib/blk',
        doc: { ...inner, blocks: [{ name: 'ref-child', doc: inner, device: 'deep-binding' }] },
      },
    ]);
    const byRef: SheetDoc = { ...gainDoc(20), blocks: [{ name: 'cm', ref: 'lib/blk' }] };
    const viaRef = runCondition(byRef, primary, key('tt'), noDevices, refs);
    expect(viaRef.state).toBe('not-evaluated');
    if (viaRef.state !== 'not-evaluated') return;
    expect(viaRef.issues[0].kind).toBe('absent-condition');
    expect(viaRef.issues[0].message).toContain('cm.ref-child');
  });

  it('refuses a sheet whose reference does not resolve, before any device is projected', () => {
    const doc: SheetDoc = { ...gainDoc(20), blocks: [{ name: 'cm', ref: 'lib/absent' }] };
    const run = runCondition(doc, primary, key('tt'), noDevices, buildSheetRefIndex([]));
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['invalid-sheet-or-ref']);
    expect(run.result).toBeUndefined();
  });

  it('names a binding that no loaded device answers to', () => {
    const doc: SheetDoc = {
      ...gainDoc(20),
      blocks: [
        {
          name: 'blk',
          device: 'nothing-loaded',
          doc: { title: 'x', polarity: 'n', params: [], equations: [], checks: [] },
        },
      ],
    };
    const run = runCondition(doc, primary, key('tt'), noDevices);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues[0].device).toBe('nothing-loaded');
  });

  it('never consults the resolver for a child that inherits its parent’s device', () => {
    const doc: SheetDoc = {
      ...gainDoc(20),
      blocks: [
        {
          name: 'inherits',
          doc: {
            title: 'x',
            polarity: 'n',
            params: [],
            givens: { L: '5e-7', gm_id: '10', id: '2e-5', vds: '0.5' },
            equations: [],
            checks: [],
          },
        },
      ],
    };
    expect(runCondition(doc, primary, key('tt'), noDevices).state).toBe('evaluated');
  });

  it('refuses a structurally broken sheet before any device is projected', () => {
    const run = runCondition(
      { ...gainDoc(20), givens: { L: 'L', gm_id: '12', ft: '2e9', vds: '0.5' } },
      primary,
      key('tt'),
      noDevices,
    );
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['invalid-sheet-or-ref']);
  });

  it('still runs a sheet whose device states no drain voltage, and returns the failed sizing', () => {
    // Validation reports the omission as a warning, so it is not a structural break: the sheet
    // is prepared and run, and the sizing is what refuses the device. The run did not complete,
    // but its result is kept — and the sizing report in it names the axis to state, which is
    // what a caller needs to offer the fix in place.
    const NO_DRAIN = /^the givens state no drain voltage, so the device is not sized/;
    const run = runCondition(
      { ...gainDoc(20), givens: { L: 'L', gm_id: '12', id: '2e-5' } },
      primary,
      key('tt'),
      noDevices,
    );
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['runtime-evaluation']);
    expect(run.issues[0].message).toMatch(NO_DRAIN);
    expect(run.result?.sizing?.ok).toBe(false);
    expect(run.result?.sizing?.error).toMatch(NO_DRAIN);
    expect(run.result?.sizing?.needs).toEqual(['vds']);
    // Asked, and not answered: neither a design that fails nor one that was never run.
    expect(run.points).toEqual([{ state: 'no-answer', error: run.issues[0].message }]);

    // The same for a block: its own report carries the axis, under the block's name.
    const tail = withTail('tail-binding');
    tail.blocks![0].doc!.givens = { L: '5e-7', gm_id: '10', id: '2e-5' };
    const inBlock = runCondition(tail, primary, key('tt'), () => primary);
    expect(inBlock.state).toBe('not-evaluated');
    expect(inBlock.result?.sizing?.ok).toBe(true);
    expect(inBlock.result?.blocks?.[0].sizing?.needs).toEqual(['vds']);
    expect(inBlock.state === 'not-evaluated' && inBlock.issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/^block "tailblk": the givens state no drain voltage/),
    ]);
  });

  it('refuses a run that did not complete, even though a hard check also failed', () => {
    // Both signals are present at once: the design constraint cannot reach T = 0.5 (y = 2x + 1
    // spans [1, 21] over the bracket), and `0 >= 1` fails outright. A run that could not be
    // completed is not an infeasible design, so the check failure must not promote it to an
    // evaluated verdict — while its diagnostics stay reachable.
    const doc = constrainedDoc({
      params: [
        { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 0.5 },
      ],
      checks: [{ id: 'impossible', kind: 'physical', lhs: '0', op: '>=', rhs: '1' }],
    });
    const run = runCondition(doc, primary, key('tt'), noDevices);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues.map((i) => i.kind)).toEqual(['runtime-evaluation']);
    expect(run.result?.checks.find((r) => r.id === 'impossible')?.status).toBe('fail');
    expect(run.result?.feasible).toBe(false);
    // Asked, and it could not be answered — with the solver's reason, never the failing check's.
    expect(run.points).toHaveLength(1);
    expect(run.points[0].state).toBe('no-answer');
    expect(run.points[0].error).toMatch(/does not change sign/);
  });

  it('separates a design that is feasible from a range end it does not comply at', () => {
    // Base T = 5 lands x = 2, clearing a 1.6 floor; the lo end holds the same hardware at
    // T = 3, landing x = 1, which does not. The design is feasible; it does not comply at one
    // end of its claimed range — and the two must never be reported as one failure.
    const doc = constrainedDoc({
      params: [
        { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
        { name: 'T_lo', value: 3 },
        { name: 'x_floor', value: 1.6 },
      ],
      operatingRange: [{ name: 'lo', set: { T: 'T_lo' } }],
    });
    const run = runCondition(doc, primary, key('tt'), noDevices);
    expect(run.state).toBe('evaluated');
    if (run.state !== 'evaluated') return;
    expect(run.feasible).toBe(true);
    expect(run.result.feasible).toBe(true);
    expect(run.points).toEqual([
      { state: 'complies' },
      { rangeEnd: 'lo', state: 'does-not-comply' },
    ]);
  });

  it('keeps feasibility when a range end cannot be answered', () => {
    // Base T = 5 lands x = 2 and the floor passes; the lo end asks for T = 0.5, which
    // y = 2x + 1 cannot reach over the bracket, so nothing is measured there. Feasibility was
    // measured and stays reported; the end is no answer — never a failure, never a pass, and
    // never a reason to drop the run.
    const doc = constrainedDoc({
      params: [
        { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
        { name: 'T_bad', value: 0.5 },
        { name: 'x_floor', value: 0.5 },
      ],
      operatingRange: [{ name: 'lo', set: { T: 'T_bad' } }],
    });
    const run = runCondition(doc, primary, key('tt'), noDevices);
    expect(run.state).toBe('evaluated');
    if (run.state !== 'evaluated') return;
    expect(run.feasible).toBe(true);
    expect(run.points.map((p) => [p.rangeEnd, p.state])).toEqual([
      [undefined, 'complies'],
      ['lo', 'no-answer'],
    ]);
    // The end's own reason travels with its point.
    expect(run.points[1].error).toMatch(/does not change sign/);
  });

  it('gives a refused condition one not-run point per point it was not asked at', () => {
    const doc = constrainedDoc({
      params: [
        { name: 'x', value: 1, min: 0, max: 10, designConstraint: { lhs: 'y', rhs: 'T' } },
        { name: 'T', value: 5 },
        { name: 'T_lo', value: 3 },
        { name: 'x_floor', value: 0.5 },
      ],
      operatingRange: [{ name: 'lo', set: { T: 'T_lo' } }],
    });
    const run = runCondition(doc, primary, key('ff'), noDevices);
    expect(run.state).toBe('not-evaluated');
    expect(run.points.map((p) => [p.rangeEnd, p.state])).toEqual([
      [undefined, 'not-run'],
      ['lo', 'not-run'],
    ]);
    expect(run.points[0].error).toBe(run.state === 'not-evaluated' ? run.issues[0].message : '');
  });

  it('does not report the primary twice when a child is bound to the primary device', () => {
    const run = runCondition(withTail('self-binding'), primary, key('ff'), () => primary);
    expect(run.state).toBe('not-evaluated');
    if (run.state !== 'not-evaluated') return;
    expect(run.issues).toHaveLength(1);
  });
});

// --- aggregation -------------------------------------------------------------

const hardCheck = (marginPct: number, id = 'r'): CheckResult => ({
  id,
  kind: 'physical',
  op: '>=',
  text: id,
  lhsValue: 0,
  rhsValue: 0,
  // The SI distance is a different quantity from the relative margin; keeping them distinct
  // here makes visible that the folds under test read only the relative one.
  margin: marginPct * 3,
  marginPct,
  rawMargin: marginPct,
  status: marginPct >= 0 ? 'pass' : 'fail',
});

/** One range end's report: measured (a check at `marginPct`), or — given an `error` — not. */
const end = (
  name: string,
  state: RangeEndReport['state'],
  marginPct = 0.5,
  error?: string,
): RangeEndReport => ({
  name,
  state,
  set: {},
  checks: [hardCheck(marginPct, 'e')],
  solved: {},
  warnings: [],
  ...(error === undefined ? {} : { error }),
});

/** A run built the way the runner builds one: the centre first, then a point per range end,
 *  each mirroring its report. `centre` is the centre point's state; the run's own check sits at
 *  `marginPct`. */
const ran = (
  corner: string,
  design: 'sized' | 'held',
  centre: RangeEndReport['state'],
  marginPct = 0.5,
  ends: RangeEndReport[] = [],
  centreError?: string,
): ConditionRun => ({
  state: 'evaluated',
  key: key(corner),
  design,
  feasible: marginPct >= 0,
  points: [
    { state: centre, ...(centreError === undefined ? {} : { error: centreError }) },
    ...ends.map((e) => ({
      rangeEnd: e.name,
      state: e.state,
      ...(e.error === undefined ? {} : { error: e.error }),
    })),
  ],
  result: {
    values: {},
    checks: [hardCheck(marginPct)],
    feasible: marginPct >= 0,
    warnings: [],
    ...(ends.length ? { rangeEnds: ends } : {}),
  },
});

/** A condition nothing was evaluated at, with `points` points all in one state. */
const refusedAt = (
  corner: string,
  state: 'not-run' | 'no-answer',
  points = 1,
  design: 'sized' | 'held' = 'held',
  result?: SheetResult,
): ConditionRun => ({
  state: 'not-evaluated',
  key: key(corner),
  design,
  issues: [{ kind: 'absent-condition', message: 'not characterized' }],
  points: Array.from({ length: points }, () => ({ state, error: 'not characterized' })),
  ...(result ? { result } : {}),
});

describe('aggregateVariantRuns — feasibility', () => {
  it('is the sized run and nothing else', () => {
    // One answer, read off the condition the design was sized at. A held condition failing
    // every check it has is a compliance finding and cannot move it.
    const agg = aggregateConditionRuns([
      ran('tt', 'sized', 'complies', 0.4),
      ran('ss', 'held', 'does-not-comply', -0.3),
    ]);
    expect(agg.feasibility).toBe('feasible');
    expect(agg.base).toEqual(key('tt'));
    expect(aggregateConditionRuns([ran('tt', 'sized', 'does-not-comply', -0.1)]).feasibility).toBe(
      'infeasible',
    );
  });

  it('tells a base that was never run from one that ran and did not complete', () => {
    const empty: SheetResult = { values: {}, checks: [], feasible: false, warnings: [] };
    expect(aggregateConditionRuns([refusedAt('tt', 'not-run', 1, 'sized')]).feasibility).toBe(
      'not-run',
    );
    expect(
      aggregateConditionRuns([refusedAt('tt', 'no-answer', 1, 'sized', empty)]).feasibility,
    ).toBe('no-answer');
    // Nothing was sized anywhere: several conditions, none of them the base.
    const none = aggregateConditionRuns([refusedAt('tt', 'not-run'), refusedAt('ss', 'not-run')]);
    expect(none.feasibility).toBe('not-run');
    expect(none.base).toBeUndefined();
  });
});

describe('aggregateVariantRuns — compliance', () => {
  it('counts every point once, in exactly one bucket', () => {
    // Three conditions × (the centre + two range ends) = nine points.
    const agg = aggregateConditionRuns([
      ran('tt', 'sized', 'complies', 0.4, [end('lo', 'complies'), end('hi', 'complies')]),
      ran('ss', 'held', 'complies', 0.2, [
        end('lo', 'does-not-comply', -0.1),
        end('hi', 'no-answer', 0.5, 'did not land'),
      ]),
      refusedAt('ff', 'not-run', 3),
    ]);
    expect(agg.compliance).toEqual({
      complies: 4,
      doesNotComply: 1,
      noAnswer: 1,
      notRun: 3,
      total: 9,
    });
  });

  it('never counts a point that was not run or not answered as complying or failing', () => {
    const agg = aggregateConditionRuns([
      ran('tt', 'sized', 'complies'),
      refusedAt('ss', 'no-answer'),
      refusedAt('ff', 'not-run'),
    ]);
    expect(agg.compliance).toEqual({
      complies: 1,
      doesNotComply: 0,
      noAnswer: 1,
      notRun: 1,
      total: 3,
    });
  });

  it('denominates in unique conditions, not in runs handed over', () => {
    const agg = aggregateConditionRuns([
      ran('tt', 'sized', 'complies'),
      ran('tt', 'sized', 'complies'),
    ]);
    expect(agg.compliance.total).toBe(1);
  });
});

describe('aggregateVariantRuns — the worst margin, and where', () => {
  it('names the check, the condition and the range end that own it', () => {
    // The tightest point anywhere is the ss corner's lo end, at -0.1.
    const agg = aggregateConditionRuns([
      ran('tt', 'sized', 'complies', 0.4, [end('lo', 'complies', 0.05)]),
      ran('ss', 'held', 'complies', 0.12, [end('lo', 'does-not-comply', -0.1)]),
    ]);
    expect(agg.worst).toEqual({ id: 'e', marginPct: -0.1, key: key('ss'), rangeEnd: 'lo' });
  });

  it('names no range end when the centre owns it', () => {
    const agg = aggregateConditionRuns([
      ran('tt', 'sized', 'complies', 0.4, [end('lo', 'complies', 0.3)]),
      ran('ss', 'held', 'complies', 0.12, [end('lo', 'complies', 0.3)]),
    ]);
    expect(agg.worst).toEqual({ id: 'r', marginPct: 0.12, key: key('ss') });
  });

  it('reads no margin from a point whose checks were not measured there', () => {
    // The ss centre was read off the table's hull and its lo end did not land: both carry check
    // outcomes that are tighter than anything real, and neither may be quoted.
    const agg = aggregateConditionRuns([
      ran('tt', 'sized', 'complies', 0.4),
      ran(
        'ss',
        'held',
        'no-answer',
        -0.9,
        [end('lo', 'no-answer', -0.8, 'did not land')],
        'off-hull',
      ),
    ]);
    expect(agg.worst).toEqual({ id: 'r', marginPct: 0.4, key: key('tt') });
  });

  it('is null when nothing was measured anywhere', () => {
    expect(aggregateConditionRuns([refusedAt('tt', 'not-run', 1, 'sized')]).worst).toBeNull();
  });
});
