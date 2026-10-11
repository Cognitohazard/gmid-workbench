// The curated sheet library lives in /sheets as plain JSON documents. This suite is
// the library's vetting gate, in two layers:
//
//  1. A generic contract every library sheet must satisfy: parses as a SheetDoc,
//     validates clean, and evaluates on the synthetic EKV demo device with a working
//     sizing, no error-severity warnings, and no hard check reading `na` anywhere in the
//     tree (a hard `na` would mean the sheet references quantities the common data
//     recipe does not carry).
//
//  2. Golden tests pinning hand-derived numbers per sheet, computed from the demo
//     model's closed forms (EKV current, VA = VA_PER_L·L Early voltage, 4kTγ/gm
//     thermal density) — never by re-running the engine. Per-tier goldens live in the
//     library.tier*.test.ts files; the exemplar goldens live here. The shared table,
//     loaders, and closed-form helpers live in library.fixtures.ts.
//
// Feasibility at default params is intentionally NOT part of the generic contract:
// defaults are tuned for realistic PDK data, and the demo device's current density
// (hence sized W and Pelgrom area) differs from real tables.

import { describe, it, expect } from 'vitest';
import { createEngine } from '../expr';
import { generateDemoDevice, scaleQuantities } from '../demo';
import type { DeviceTable } from '../types';
import { runSheet, validateSheet, withParams, WIRING_TOL } from './index';
import { resolveSheetRefs } from './resolve';
import {
  clampedIn,
  docExpressions,
  isHardCheck,
  type SizingReport,
  type SheetBlockReport,
  type SheetDoc,
  type SheetResult,
} from './types';
import {
  loadLibrary,
  sheet,
  table,
  relErr,
  vnthM,
  VA_PER_L,
  REFS,
  VGS_GMID8_L05,
  VGS_GMID10_L05,
  VGS_GMID12_L05,
  sourceNodeUnder,
  cggOf,
  gdsOf,
  roMirrored,
  stage2Rout,
  pelgromIrelRatio,
} from './library.fixtures';
// Test-only reach across to the picker: the searchable set is that module's curation, and the
// interface gate below is the library-side half of the same fact.
import { searchable } from '../picker';
// Test-only reach across to the condition runs: holding one sized design at a second
// characterization is that module's transition, and one exemplar golden below asks it of a sheet.
import { groupDevices, runConditions } from '../corners';

const LIBRARY = loadLibrary();

// One evaluation of the whole library on the demo device, shared by every check below that
// needs a result — the contract per sheet and the interface check both read this.
const EVALUATED = LIBRARY.map(({ file, doc }) => {
  // Evaluated once at module scope and shared by every test below. The try keeps a sheet
  // that ever makes runSheet throw failing inside its own named test rather than as a
  // collection error that takes the whole file down with it.
  try {
    return { file, doc, res: runSheet(doc, table, undefined, REFS), error: undefined };
  } catch (e) {
    return { file, doc, res: undefined, error: e instanceof Error ? e.message : String(e) };
  }
});

function hardNaChecks(res: SheetResult): string[] {
  const out: string[] = [];
  for (const r of res.checks) if (isHardCheck(r.kind) && r.status === 'na') out.push(r.id);
  const walk = (c: SheetBlockReport, path: string): void => {
    for (const r of c.checks)
      if (isHardCheck(r.kind) && r.status === 'na') out.push(`${path}.${r.id}`);
    for (const cc of c.blocks ?? []) walk(cc, `${path}.${cc.name}`);
  };
  for (const c of res.blocks ?? []) walk(c, c.name);
  return out;
}

describe('sheet library: generic contract', () => {
  it('has sheets to test and no duplicate titles', () => {
    expect(LIBRARY.length).toBeGreaterThanOrEqual(3);
    const titles = LIBRARY.map((s) => s.doc.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  for (const { file, doc, res, error } of EVALUATED) {
    describe(file, () => {
      it('resolves refs and validates clean', () => {
        const r = resolveSheetRefs(doc, REFS);
        expect(r.warnings).toEqual([]);
        const errs = validateSheet(r.doc).filter((w) => w.severity === 'error');
        expect(errs).toEqual([]);
      });

      it('evaluates on the demo device: sizing ok, no errors, no hard-check na', () => {
        expect(error).toBeUndefined();
        const r = res!;
        expect(r.warnings.filter((w) => w.severity === 'error')).toEqual([]);
        if (doc.givens) {
          expect(r.sizing?.ok, r.sizing?.error).toBe(true);
        }
        expect(hardNaChecks(r)).toEqual([]);
      });
    });
  }

  it('is evaluated on a table that reaches every bias the library asks for', () => {
    // The goldens read each device where its sheet puts it. A bias the table has no sweep for
    // refuses the device outright, and a drain or body bias past the swept range is read at the
    // table's edge — a number from somewhere else. The engine says so each time, in the refusal
    // or with a warning on the givens and the coordinate listed as clamped, so the shared table
    // is held to it here: at every sheet's defaults and at every end of its operating range, no
    // device asks for a sweep the table lacks or is read off its hull.
    const elsewhere =
      /it has no \w+ sweep|is outside the table's \w+ range|does not reach this point/;
    const off: string[] = [];
    const bodyBiased = new Set<string>();
    const walk = (
      file: string,
      n: { sizing?: SizingReport; blocks?: SheetBlockReport[] },
    ): void => {
      if ((n.sizing?.bias?.vsb ?? 0) > 0) bodyBiased.add(file);
      for (const c of n.blocks ?? []) walk(file, c);
    };
    for (const { file, res } of EVALUATED) {
      if (!res) continue; // an evaluation that threw already fails its own contract test
      walk(file, res);
      const runs = [
        { at: 'defaults', said: res.warnings.map((w) => w.message), clamped: clampedIn(res) },
        ...(res.rangeEnds ?? []).map((e) => ({
          at: e.name,
          said: [...e.warnings.map((w) => w.message), ...(e.error ? [e.error] : [])],
          clamped: clampedIn(e),
        })),
      ];
      for (const { at, said, clamped } of runs) {
        for (const m of said) if (elsewhere.test(m)) off.push(`${file} @ ${at}: ${m}`);
        for (const c of clamped) off.push(`${file} @ ${at}: read at the table's edge (${c})`);
      }
    }
    expect(off).toEqual([]);
    // Not vacuous: the table has both bias axes live, and the library does put sources above
    // their bodies.
    expect(table.grid.axes.map((a) => a.name)).toEqual(['l', 'vds', 'vsb', 'vgs']);
    expect(bodyBiased.size).toBeGreaterThan(0);
  });
});

// An engine with an EMPTY constant map, so `k`, `T`, `pi` and `gamma` come back as ordinary
// free identifiers instead of being resolved away. The lints below need to see which
// expressions reach for a constant, which the evaluation engine deliberately hides.
const BARE = createEngine({});

/** Free identifiers of an expression, constants included; [] when it does not parse
 *  (a parse error is a validation error, and validateSheet already reports it by name). */
function exprNames(expr: string): readonly string[] {
  try {
    return BARE.compile(expr).names;
  } catch {
    return [];
  }
}

/** Walk a doc and every embedded child, calling `visit` with each doc and its path. */
function walkDocs(doc: SheetDoc, path: string, visit: (d: SheetDoc, p: string) => void): void {
  visit(doc, path);
  for (const u of doc.blocks ?? []) {
    if (u.doc) walkDocs(u.doc, `${path}.${u.name}`, visit);
  }
}

describe('sheet library: vetting lints', () => {
  // Resolved docs, so a ref-only block is linted against the library sheet it names.
  const RESOLVED = LIBRARY.map(({ file, doc }) => ({
    file,
    doc: resolveSheetRefs(doc, REFS).doc,
  }));

  it('every name crossing a block boundary exists on both sides', () => {
    // The check itself lives in validateSheet, so an app author hears about a missing provide
    // entry while typing rather than only when the library suite runs. What stays here is the
    // library's own verdict: nothing curated may ship with a dangling interface name. The
    // check's two diagnostics are exercised directly in sheet.test.ts.
    const offenders: string[] = [];
    for (const { file, doc } of RESOLVED) {
      for (const w of validateSheet(doc)) {
        if (w.rule === 'sheet-provide-coverage') offenders.push(`${file}: ${w.message}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no sheet spells the thermal-noise factor as a number', () => {
    // gamma is a named constant that a table's own `gamma` column shadows, so a sheet that
    // types its value freezes one device's noise physics into an expression — and drifts out
    // of step with every other noise equation the moment the default or the table changes. Any
    // expression built on k and T therefore takes gamma by name; the only literals it may
    // carry are the integer counts of the 4kT form and of the devices being summed.
    // Deliberately overmatched: a legitimate fractional coefficient in a kT expression
    // (a half-circuit 0.5, say) will flag here — name it, or keep it out of the kT
    // product. And a factor written as a bare integer slips through; the lint guards
    // against the fractional-γ idiom, not against every possible way to hardcode one.
    const literal = /(?<![\w.])\d+\s*\/\s*\d+|\d*\.\d+/;
    const offenders: string[] = [];
    for (const { file, doc } of RESOLVED) {
      walkDocs(doc, file, (d, path) => {
        for (const expr of docExpressions(d)) {
          const names = exprNames(expr);
          if (!names.includes('k') || !names.includes('T')) continue;
          if (literal.test(expr)) offenders.push(`${path}: ${expr}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('a range end holds each cascode gate where the design put it', () => {
    // The two cascoded OTAs claim an input common-mode range. At a range end every device keeps
    // its size and the tail node is re-solved for the new common mode; the cascode nodes are
    // re-solved too, each under its own gate. The check is the definition: node plus (for an
    // N cascode) or minus (for a P one) the cascode's gate-source voltage at the range end
    // equals what that expression came to at the design point.
    const cases: [string, Record<string, [string, 1 | -1]>][] = [
      ['otas/telescopic-cascode-ota.json', { V_a: ['casc_n', 1], V_b: ['casc_p', -1] }],
      ['otas/folded-cascode-ota.json', { V_c: ['ncasc', 1], V_fold: ['pcasc', -1] }],
    ];
    for (const [file, gates] of cases) {
      const res = runSheet(sheet(file), table, undefined, REFS);
      const end = res.rangeEnds?.find((e) => e.name === 'cm-lo');
      expect(Object.keys(end?.solved ?? {}).sort()).toEqual(
        [...Object.keys(gates), 'V_tail'].sort(),
      );
      for (const [node, [device, sign]] of Object.entries(gates)) {
        const vgs = Math.abs(end!.blocks!.find((c) => c.name === device)!.sizing!.vgs);
        expect(end!.solved[node] + sign * vgs).toBeCloseTo(res.held![node], 5);
      }
    }
  });

  it('every held expression is the gate of the device whose source is that node', () => {
    // Written down from each schematic, not read off the sheets: the node, and the device it is
    // the source of ('' for the sheet's own device). On a table with a body axis the device
    // reports the body bias it was sized at, which places its source without reading the held
    // expression at all: an N device with its body at ground has its source at vsb, a P device
    // with its body at the supply has it at VDD - vsb. The gate is one gate-source voltage above
    // an N source and one below a P source. A hold on the wrong device, or with the wrong sign,
    // misses that number.
    const HELD_UNDER: Record<string, Record<string, string>> = {
      'otas/telescopic-cascode-ota.json': { V_a: 'casc_n', V_b: 'casc_p' },
      'otas/folded-cascode-ota.json': { V_c: 'ncasc', V_fold: 'pcasc' },
      'stages/cascode-cs-amp.json': { V_x: '' },
      'multistage/fd-telescopic-ota.json': { V_s: 'in', V_a: 'cascn', V_b: 'cascp' },
      'multistage/flipped-voltage-follower.json': { V_out: 'in' },
      'multistage/super-source-follower.json': { vds_fb: 'in' },
      'multistage/two-stage-cascode-comp-ota.json': { V_casc: 'casc' },
    };
    const withBody = generateDemoDevice({
      vds: { min: 0, max: 1.8, step: 0.05 },
      vsb: { min: 0, max: 1.2, step: 0.05 },
    });
    for (const { file, doc } of LIBRARY) {
      const holds = doc.params.filter((p) => p.hold !== undefined).map((p) => p.name);
      expect([file, holds.sort()]).toEqual([file, Object.keys(HELD_UNDER[file] ?? {}).sort()]);
      if (!holds.length) continue;
      const res = runSheet(doc, withBody, undefined, REFS);
      for (const [node, device] of Object.entries(HELD_UNDER[file])) {
        const block = doc.blocks?.find((u) => u.name === device);
        const sizing = device ? res.blocks?.find((c) => c.name === device)?.sizing : res.sizing;
        const pType = (block?.doc ?? doc).polarity === 'p';
        const vsb = sizing!.bias!.vsb;
        const vgs = Math.abs(sizing!.vgs);
        const gate = pType ? res.values.VDD - vsb - vgs : vsb + vgs;
        expect([file, node, relErr(res.held![node], gate) < 1e-9]).toEqual([file, node, true]);
      }
    }
  });

  it('no sheet types a voltage that its own parts determine', () => {
    // `assumed` marks a value a sheet has yet to derive from its own devices; the library has
    // none. A voltage the sheet cannot determine — a supply, an input level, an output held by a
    // feedback loop outside the sheet, the bias of a device whose surroundings are not on the
    // sheet — is `independent`; one its own parts determine is computed, solved, or held under
    // the gate that sets it. The walk reads each file as authored, inline children included.
    const assumed: string[] = [];
    for (const { file, doc } of LIBRARY) {
      walkDocs(doc, file, (d, path) => {
        for (const p of d.params) if (p.class === 'assumed') assumed.push(`${path}: ${p.name}`);
      });
    }
    expect(assumed).toEqual([]);
  });

  it('a current parameter programs at most one device', () => {
    // A programmed current sets ONE device. Every other device that carries it gets it from the
    // circuit — it sits in the same branch, takes its share at a node, or mirrors it through a
    // shared gate — so its givens read the first device's current (`tail__id/2`) or is tied to
    // that device's gate (`W: K*ref__W, vgs: ref__vgs`), and never the programmed number a
    // second time. A sheet that types the number into several devices leaves every one of them
    // carrying an ideal current when the design is held fixed and asked about at another
    // condition.
    //
    // The walk, per sheet: for each parameter in amperes, the devices whose given current reads
    // it — a block's `id` followed through that block's param overrides, or the sheet's own givens
    // read directly — without reading any block's output. Equations are read through, so giving the
    // share a name (`I_half = I_tail/2`) does not hide it. A current that reads a
    // `block__quantity` is one the circuit sets, and is not counted.
    const programs = (doc: SheetDoc): string[] => {
      const equations = new Map(doc.equations.map((r) => [r.name, r.expr]));
      const reads = (exprs: readonly string[]): Set<string> => {
        const seen = new Set<string>();
        const visit = (name: string): void => {
          if (seen.has(name)) return;
          seen.add(name);
          const equation = equations.get(name);
          if (equation !== undefined) for (const n of exprNames(equation)) visit(n);
        };
        for (const e of exprs) for (const n of exprNames(e)) visit(n);
        return seen;
      };
      const devices: [string, Set<string>][] = [];
      if (typeof doc.givens?.id === 'string') devices.push(['givens', reads([doc.givens.id])]);
      for (const u of doc.blocks ?? []) {
        const id = u.doc?.givens?.id;
        if (typeof id !== 'string') continue;
        // The child's own names mean nothing up here; what the parent wrote for each one does.
        devices.push([u.name, reads(exprNames(id).map((n) => u.params?.[n] ?? ''))]);
      }
      return doc.params
        .filter((p) => p.unit?.trim() === 'A')
        .map((p): [string, string[]] => [
          p.name,
          devices
            .filter(([, ns]) => ns.has(p.name) && ![...ns].some((n) => n.includes('__')))
            .map(([device]) => device),
        ])
        .filter(([, into]) => into.length > 1)
        .map(([name, into]) => `${name} into ${into.join(', ')}`);
    };

    // The sheets that still type one current into several devices, by name. The comparison is an
    // equality, so it fails both ways: on a sheet that starts doing it, and on a listed sheet
    // that has stopped and is still listed.
    const TYPED_INTO_SEVERAL: readonly string[] = [
      'multistage/fd-telescopic-ota.json',
      'otas/folded-cascode-ota.json',
      'otas/telescopic-cascode-ota.json',
    ];
    const found = RESOLVED.map(({ file, doc }) => ({ file, typed: programs(doc) })).filter(
      ({ typed }) => typed.length > 0,
    );
    expect(
      found.map(({ file }) => file),
      found.map(({ file, typed }) => `${file}: ${typed.join('; ')}`).join('\n'),
    ).toEqual(TYPED_INTO_SEVERAL);
    // The five-transistor OTA is the worked example of the rule: one programmed current, into
    // its bias reference and nowhere else.
    expect(found.map(({ file }) => file)).not.toContain('otas/five-transistor-ota.json');
  });
});

// The interface a sheet publishes to a parent is a naming convention, not a schema field, so
// nothing in the engine can keep it from decaying: a sheet may quietly stop declaring its output
// resistance and still evaluate perfectly. What follows is the convention stated as a rule rather
// than as a list of every sheet's answer.
//
// The reserved names are the terminals a composing parent reaches for: Rout/Rin the impedance it
// loads or is loaded by, cgg_in the capacitance one input terminal presents, Ron the resistance a
// switch inserts, I_q the quiescent supply current. A block sheet publishes exactly the reserved
// names it carries — both directions, so adding the equation without the provide entry (or the
// reverse) fails. I_q is the one reserved name a sheet may instead own as a PARAMETER, where the
// supply current is the designer's knob rather than a consequence, so the derivation below reads
// both.
const RESERVED_PORTS: readonly string[] = ['Rout', 'Rin', 'cgg_in', 'Ron', 'I_q'];

// A sheet under applications/ is the TOP of a composition: it consumes blocks and nothing
// consumes it, so a reserved name it computes is an internal number and publishing it would be
// theatre. Those publish nothing — unless they are in the map below.
const CONSUMER_GROUP = 'applications/';

// The sheets whose interface is not a reserved-name equation at all: a bias generator, a spec
// translator, a stage published for its device-level quantities. Each publishes the thing it
// exists to produce, so there is nothing to derive and the list is the claim.
const NAMED_INTERFACE: Readonly<Record<string, readonly string[]>> = {
  'applications/sc-settling-to-ota-spec.json': ['GBW_req', 'A_req', 'SR_req', 'CL_eff'],
  'mirrors-bias/beta-multiplier-bias.json': ['gm_target'],
  'multistage/rail-to-rail-input-stage.json': ['gm_min', 'gm_mid', 'gm_max'],
  'multistage/stage2-current-source-load.json': ['gds', 'vdsat'],
};

describe('sheet library: the published interface', () => {
  it('every sheet publishes exactly the interface the convention gives it', () => {
    // Accepted residual: deleting a reserved-name EQUATION and its provide entry together still
    // satisfies the rule, since both sides move at once. The per-sheet Rout goldens in the
    // tier suites are the mitigation — they read the equation by name and fail when it goes. For
    // I_q the residual is closed outright, by the named-set test further down.
    const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
    const actual: Record<string, string[]> = {};
    const expected: Record<string, string[]> = {};
    for (const { file, doc } of LIBRARY) {
      actual[file] = sorted(doc.provides ?? []);
      // Union, not override: a sheet in the hand map still owes its reserved-name equations, so
      // one that later grows a real Rout equation is required to publish it like everyone else.
      const reserved = file.startsWith(CONSUMER_GROUP)
        ? []
        : [...doc.equations.map((r) => r.name), ...doc.params.map((p) => p.name)].filter((n) =>
            RESERVED_PORTS.includes(n),
          );
      expected[file] = sorted(new Set([...(NAMED_INTERFACE[file] ?? []), ...reserved]));
    }
    expect(actual).toEqual(expected);
    // A stale key in the hand map names a sheet that no longer exists.
    expect(Object.keys(NAMED_INTERFACE).filter((f) => !(f in actual))).toEqual([]);
  });

  it('every published name resolves to a value on the demo device', () => {
    // A sheet's provides are inert outside composition, so a name that has quietly stopped
    // resolving would cost nothing here and everything the first time a parent read it.
    const dangling: string[] = [];
    for (const { file, doc, res } of EVALUATED) {
      if (!res) continue; // an evaluation that threw already fails its own contract test
      for (const key of doc.provides ?? []) {
        if (!Number.isFinite(res.values[key])) dangling.push(`${file}: ${key}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('every searchable sheet reports a quiescent supply current on the demo device', () => {
    // Named positively, because the rule above cannot see this one: a sheet that drops its I_q
    // equation AND its provide entry together stays consistent and would vanish from a comparison
    // silently. A search that ranks designs by supply current has to be told, per sheet, that the
    // number is there — so the set is spelled out here and the count is asserted, which is what
    // makes a new amplifier sheet arriving without an I_q fail rather than quietly go unranked.
    // The set is the picker's own curation predicate, not a copy of it: a sheet that joins or
    // leaves the search has to arrive here at the same moment.
    const searched = EVALUATED.filter(({ file }) => searchable(file.replace(/\.json$/, '')));
    expect(searched).toHaveLength(24);
    const missing: string[] = [];
    for (const { file, doc, res } of searched) {
      if (!(doc.provides ?? []).includes('I_q')) missing.push(`${file}: not published`);
      else if (!Number.isFinite(res?.values.I_q)) missing.push(`${file}: does not resolve`);
    }
    expect(missing).toEqual([]);
  });
});

describe('exemplar goldens: CS amp, current-source load', () => {
  const res = runSheet(sheet('stages/cs-amp-current-source-load.json'), table);
  // Defaults: GBW 10 MHz into 2 pF with a 1.25 over-design factor, gm/ID 12,
  // load gm/ID 8, both L = 0.5 µm, V_out = 0.9 V.
  const gm = 2 * Math.PI * 10e6 * 2e-12 * 1.25;

  it('sizes the input device exactly from the spec', () => {
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    expect(relErr(res.values.id, gm / 12)).toBeLessThan(1e-9);
    expect(res.sizing?.bias?.vds).toBe(0.9);
    // The supply-current line is that same derived branch current: on a sheet sized from a
    // bandwidth spec, what it costs to run is an OUTPUT of the sizing rather than a knob.
    expect(relErr(res.values.I_q, gm / 12)).toBeLessThan(1e-9);
  });

  it('gain matches the demo model: Av = (gm/id)·(VA + vds)/2 for equal branches', () => {
    // gds/id = 1/(VA + vds) in the demo model; both devices sit at vds 0.9, L 0.5 µm.
    const av = (12 * (VA_PER_L * 0.5e-6 + 0.9)) / 2;
    expect(relErr(res.values.Av, av)).toBeLessThan(1e-3);
  });

  it('input noise is the γ-model density times the load contribution', () => {
    // Load gm/input gm = 8/12 exactly (same current).
    const vn = vnthM(gm) * Math.sqrt(1 + 8 / 12);
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(1e-3);
  });

  it('the interface equations are the output node and the input gate', () => {
    // Both devices carry the same current at the same L and |vds|, so the output node collapses
    // to (VA + vds)/(2·id); Rout is the inverse of the denominator Av already used, which is why
    // the gain golden above did not move when the equation was named. cgg = W·L·Cox exactly in the
    // demo model, at the width the sizing landed on.
    const id = gm / 12;
    expect(relErr(res.values.Rout, stage2Rout(id, 0.5e-6, 0.9))).toBeLessThan(1e-9);
    expect(relErr(res.values.Av, gm * res.values.Rout)).toBeLessThan(1e-12);
    expect(relErr(res.values.cgg_in, cggOf(res.values.W, 0.5e-6))).toBeLessThan(1e-9);
  });

  it('is feasible at defaults on the demo device', () => {
    expect(res.feasible).toBe(true);
  });
});

describe('exemplar goldens: simple current mirror', () => {
  const res = runSheet(sheet('mirrors-bias/simple-mirror.json'), table);
  // Defaults: I_in 20 µA, K = 4, gm/ID 8, L = 1 µm, output at V_out 0.9 V. The reference
  // needs no bias default — it is diode-connected, so the table's vds = vgs diagonal fixes it.

  it('sizes the output device at exactly K times the reference width', () => {
    expect(res.sizing?.ok).toBe(true);
    expect(relErr(res.values.W / res.values.ref__W, 4)).toBeLessThan(1e-9);
  });

  it('systematic error is the demo CLM ratio between the two vds points', () => {
    // id ∝ (1 + vds/VA) at fixed vgs, so err = (1 + V_out/VA)/(1 + vds_ref/VA) − 1, VA = 5 V.
    // The reference is diode-connected, so its vds is its own vgs — read the converged drop from
    // the result rather than a hand-typed estimate; the model check is what this test owns.
    const va = VA_PER_L * 1e-6;
    const err = (1 + 0.9 / va) / (1 + res.values.ref__vgs / va) - 1;
    expect(relErr(res.values.sys_err, err)).toBeLessThan(1e-2);
  });

  it('the reference sits at its own diode drop, with no estimate to retune', () => {
    // The whole point of the connection: the operating point is wiring, not a guess. Nothing in
    // the sheet may ask the author to reconcile an assumption with what the device turned out to
    // be.
    expect(res.values.ref__vgs).toBeGreaterThan(0);
    expect(sheet('mirrors-bias/simple-mirror.json').params.map((p) => p.name)).not.toContain(
      'vgs_est',
    );
    expect(sheet('mirrors-bias/simple-mirror.json').checks.map((r) => r.id)).not.toContain(
      'diode-bias-consistent',
    );
  });

  it('the K-times-larger output device halves the AREA term of the reference current spread', () => {
    // W_out = 4*W_ref at the same L, so the AREA term contributes exactly 1/2 — but no longer
    // the whole ratio. The output device is sized on the reference's GATE now, so its inversion
    // level is read off the table instead of being the authored 8, and the threshold term
    // carries the difference.
    const expected = pelgromIrelRatio(res.values.gm_id, 8, 4, res.values.avt, res.values.abeta);
    expect(relErr(res.values.irel_out / res.values.irel_ref, expected)).toBeLessThan(1e-12);
    // On this table the two levels agree to the grid's own interpolation resolution, so the
    // ratio still sits within 4e-4 of 1/2. A real drift between the two gate-source voltages
    // would show up here as a far larger departure.
    expect(relErr(res.values.irel_out / res.values.irel_ref, 0.5)).toBeLessThan(1e-3);
  });

  it('output resistance is the output device r_o, and the output vds cancels out of it', () => {
    // The reference fixes the saturation current idSat = I_in/(1 + vgs_ref/VA); the output copies
    // that density at K times the width and gds = idSat/VA in the demo model, so r_o =
    // (VA + vgs_ref)/(K·I_in) — independent of where the output node happens to sit. That is the
    // whole interface of a simple mirror: no cascode, no degeneration, just one device's r_o.
    expect(relErr(res.values.Rout, roMirrored(res.values.ref__vgs, 4, 20e-6))).toBeLessThan(1e-3);
  });
});

describe('exemplar goldens: 5T OTA', () => {
  const doc = sheet('otas/five-transistor-ota.json');
  const res = runSheet(doc, table);
  // Defaults: the bias reference programmed to I_tail = 20 µA, CL 2 pF, reference gm/ID 10,
  // input gm/ID 12, load gm/ID 8, all L 0.5 µm, VDD 1.8 V, common mode 1.1 V, output at 0.9 V.
  const I_TAIL = 20e-6;
  const CL = 2e-12;
  const L = 0.5e-6;
  const va = VA_PER_L * L;
  /** One block's sizing report, by block name. */
  const block = (r: SheetResult, name: string): SizingReport =>
    r.blocks!.find((c) => c.name === name)!.sizing!;

  // Only the reference's current is typed; every other one is what the demo model gives a device
  // of that width on that gate. There id ∝ (VA + vds) at fixed vgs and W, so a 1:1 mirror
  // delivers its reference current times (VA + vds_out)/(VA + vds_ref), and a diode-connected
  // reference has vds_ref equal to its own vgs. Each gate voltage below is the model's for the
  // inversion level the sheet asks of that device, so nothing here is read back from the run.
  // The pair's source is the tail node and its body is at ground, so the tail node is its body
  // bias too and its gate needs BODY_FACTOR·V_tail more than vgs(12): the node is solved so that
  // CM_dc = V_tail + vgs(12) + 0.2·V_tail.
  //   tail node    V_tail = (CM_dc − vgs(12))/1.2 = (1.1 − 0.567023)/1.2 = 0.444148 V
  //   tail mirror  (2.5 + 0.444148)/(2.5 + 0.610063) = 0.946652   (reference at vgs(10))
  //   load mirror  (2.5 + 0.9)/(2.5 + 0.668042)      = 1.073218   (diode side at vgs(8), output
  //                                                                side at VDD − V_out_dc)
  // The pair is the same law once more. Its two transistors are one width on one gate-source
  // voltage with their bodies on the same tail node, and their drains are different nodes: the
  // output on one side, the load's diode node — one vgs(8) below the supply — on the other.
  //   pair         (2.5 + 0.687810)/(2.5 + 0.455852) = 1.078474   (diode side at VDD − vgs(8) −
  //                                                                V_tail, output side at
  //                                                                V_out_dc − V_tail)
  // With the inputs balanced the two pair currents add up to what the tail delivers, so they
  // split it in that ratio and not in half: the output side takes 1/(1 + 1.078474) = 48.11 %.
  // The load's diode side is in the diode-side pair transistor's branch and carries its current.
  //   tail         20 µA × 0.946652                  = 18.933 µA
  //   pair, output side   18.933 µA × 0.481122       =  9.109 µA
  //   pair, diode side    18.933 µA × 0.518878       =  9.824 µA   (also the load's diode side)
  //   load, output side    9.824 µA × 1.073218       = 10.543 µA
  const vTail = sourceNodeUnder(1.1, VGS_GMID12_L05);
  const tailRatio = (va + vTail) / (va + VGS_GMID10_L05);
  const loadRatio = (va + (1.8 - 0.9)) / (va + VGS_GMID8_L05);
  const vdsOut = 0.9 - vTail;
  const vdsDiode = 1.8 - VGS_GMID8_L05 - vTail;
  const pairRatio = (va + vdsDiode) / (va + vdsOut);
  const iTail = I_TAIL * tailRatio;
  /** What the pair's output-side transistor carries. */
  const iOut = iTail / (1 + pairRatio);
  /** What the pair's diode-side transistor carries, and the load's diode side with it. */
  const iDiode = iTail - iOut;
  // The model's gm/ID does not depend on the drain voltage, so both pair transistors sit at the
  // gm/ID the output-side one is sized for and each has 12 × its own current. A differential
  // input sees the two in series: 2·gm_a·gm_b/(gm_a + gm_b), 113.4 µS against 109.3 and 117.9.
  const gmPair = (2 * (12 * iOut) * (12 * iDiode)) / (12 * iTail);

  it('the tail node carries one current and each mirror is one gate wire', () => {
    // Only the reference is handed the programmed number. The pair's output side and the load's
    // diode side are handed the two shares of what the tail delivers, which add up to it.
    expect(block(res, 'bias').id).toBe(I_TAIL);
    const { tail__id, in__id, inr__id } = res.values;
    expect(relErr(in__id + block(res, 'ldr').id, tail__id)).toBeLessThan(1e-12);
    // The share is solved until the diode-side pair transistor, read from the table on its
    // partner's gate-source voltage, carries the rest: the pair's two currents add up to the
    // tail current and the load's diode side carries its own pair transistor's. Where the
    // output-side transistor is sized for its inversion level, both pair currents scale with
    // its width, so the share the table reads back does not depend on the share that was
    // tried and the node's current law holds to rounding.
    expect(relErr(in__id + inr__id, tail__id)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'ldr').id, inr__id)).toBeLessThan(1e-12);
    expect(relErr(res.values.out_share, res.values.pair_split)).toBeLessThan(1e-12);
    // For the same reason the stored value is only a starting guess: from 0.3 or from 0.7 the
    // split lands where it does from one half.
    for (const guess of [0.3, 0.7]) {
      const from = runSheet(withParams(doc, { out_share: guess }), table);
      expect(relErr(from.values.pair_split, res.values.pair_split)).toBeLessThan(1e-12);
      expect(relErr(from.values.in__W, res.values.in__W)).toBeLessThan(1e-12);
    }
    // A 1:1 mirror is the same width on the same gate. The width is passed through untouched;
    // the gate voltage is reported as the table's own vgs coordinate at the point it was read,
    // so two devices on one wire agree to rounding rather than always to the last bit.
    expect(block(res, 'tail').W).toBe(block(res, 'bias').W);
    expect(block(res, 'ld').W).toBe(block(res, 'ldr').W);
    expect(relErr(block(res, 'tail').vgs, block(res, 'bias').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'ld').vgs, block(res, 'ldr').vgs)).toBeLessThan(1e-12);
  });

  it('the pair is two transistors of one width on one gate-source voltage, each at its own drain', () => {
    // The output-side transistor is the sized one. Its partner copies its width and its
    // gate-source voltage, which is what a matched pair with balanced inputs on a common source
    // is; the width is passed through untouched and the voltage is the table's own coordinate.
    expect(block(res, 'inr').W).toBe(block(res, 'in').W);
    expect(relErr(block(res, 'inr').vgs, block(res, 'in').vgs)).toBeLessThan(1e-12);
    // Both sources are the tail node, so both bodies see it. The drains are not one node: the
    // output-side drain is the output, and the diode-side drain is the load's diode node, read
    // off the load device the run sized.
    const node = res.values.V_tail;
    expect(block(res, 'in').bias?.vsb).toBe(node);
    expect(block(res, 'inr').bias?.vsb).toBe(node);
    expect(block(res, 'in').bias?.vds).toBeCloseTo(0.9 - node, 12);
    expect(block(res, 'inr').bias?.vds).toBeCloseTo(1.8 - block(res, 'ldr').vgs - node, 12);
    // Where the model puts them: 0.456 V and 0.688 V. 1e-3 of either is under a millivolt.
    expect(relErr(block(res, 'in').bias!.vds, vdsOut)).toBeLessThan(1e-3);
    expect(relErr(block(res, 'inr').bias!.vds, vdsDiode)).toBeLessThan(1e-3);
  });

  it('each mirror misses its reference by the drain-voltage ratio of the demo model', () => {
    // The tail node (0.444 V) sits below the reference's diode drop (0.610 V), so the tail
    // under-delivers by 1 − 0.946652 = 5.33 %. The output sits 0.9 V below the supply, further
    // than the load's diode drop (0.668 V), so the output side asks for 7.32 % more than its
    // diode side carries. Compared as errors, the way the mirror golden above compares its
    // own: 1e-2 of them is 1.7 mV and 2.3 mV of drain-voltage difference.
    const tailErr = 1 - res.values.tail__id / I_TAIL;
    const loadErr = res.values.ld__id / block(res, 'ldr').id - 1;
    expect(relErr(tailErr, 1 - tailRatio)).toBeLessThan(1e-2);
    expect(relErr(loadErr, loadRatio - 1)).toBeLessThan(1e-2);
  });

  it('the pair transistors differ by the same ratio, so the tail current does not split in half', () => {
    // The load's diode node (1.8 − 0.668 = 1.132 V) sits above the output (0.9 V), so the
    // diode-side transistor has the larger drain-source voltage and carries 7.85 % more than
    // its partner. 1e-2 of that error is 2.3 mV of drain voltage.
    const pairErr = res.values.inr__id / res.values.in__id - 1;
    expect(relErr(pairErr, pairRatio - 1)).toBeLessThan(1e-2);
    // The two add up to the tail current, so the output side's share is 1/(1 + 1.078474). It is
    // compared as its distance from one half, 0.018878 — the part the drains decide.
    expect(relErr(0.5 - res.values.pair_split, 0.5 - 1 / (1 + pairRatio))).toBeLessThan(1e-2);
    // Each device is then sized for the share it carries: the output-side pair transistor for
    // 9.109 µA, and the load's diode side for the 9.824 µA its own pair transistor passes.
    expect(relErr(res.values.in__id, iOut)).toBeLessThan(1e-3);
    expect(relErr(res.values.inr__id, iDiode)).toBeLessThan(1e-3);
    expect(relErr(block(res, 'ldr').id, iDiode)).toBeLessThan(1e-3);
  });

  it('the pair transconductance is its two transistors in series', () => {
    // 2·gm_a·gm_b/(gm_a + gm_b): what a differential input sees through the common source. The
    // two transistors carry 9.109 and 9.824 µA at gm/ID 12, so it is 113.4 µS — neither one's
    // own gm, and 0.14 % under the 113.6 µS that half the tail current would give.
    const { gm_pair, in__gm, inr__gm } = res.values;
    expect(relErr(gm_pair, (2 * in__gm * inr__gm) / (in__gm + inr__gm))).toBeLessThan(1e-12);
    expect(relErr(gm_pair, gmPair)).toBeLessThan(1e-3);
    expect(gm_pair).toBeGreaterThan(in__gm);
    expect(gm_pair).toBeLessThan(inr__gm);
    expect(relErr(in__gm, 12 * iOut)).toBeLessThan(1e-3);
    // The diode-side transistor's gm is read back off the table between two drain-voltage
    // nodes, 0.13 % under the 12 × its current the model gives it.
    expect(relErr(inr__gm, 12 * iDiode)).toBeLessThan(2e-3);
  });

  it('systematic offset is the current missing at the output over the pair transconductance', () => {
    // With the inputs balanced the output-side transistor takes 9.109 µA and the mirror returns
    // loadRatio times the 9.824 µA its diode side carries, 10.543 µA. The output is below the
    // load's diode node here, so both differences — the pair's and the mirror's — leave the
    // output node with current it has nowhere to send: 1.434 µA, which is the output-side
    // current times (1.078474 × 1.073218 − 1). Over the pair's 113.4 µS that is 12.64 mV. The
    // mirror alone, on an even split, would be 6.10 mV: a sheet that left the pair out is 2.07
    // times short.
    const missing = iOut * (pairRatio * loadRatio - 1);
    expect(relErr(res.values.vos_sys, missing / gmPair)).toBeLessThan(2e-3);
    const { in__id, ld__id, gm_pair } = res.values;
    expect(relErr(Math.abs(in__id - ld__id), missing)).toBeLessThan(2e-3);
    expect(relErr(res.values.vos_sys, Math.abs(in__id - ld__id) / gm_pair)).toBeLessThan(1e-12);
  });

  it('the offset vanishes and the split is even when the output sits one load vgs below the supply', () => {
    // There the output is the load's diode node: the pair's two drains are one voltage and so
    // are the mirror's, so neither pair of devices has anything to differ by. Nothing else on
    // the sheet reads the output level, so the tail node stays where it was. What is left is
    // the table's own resolution: the two tied devices are read between drain-voltage nodes and
    // their partners on a node or along the diode diagonal.
    const level = runSheet(withParams(doc, { V_out_dc: 1.8 - VGS_GMID8_L05 }), table);
    expect(level.values.V_tail).toBeCloseTo(res.values.V_tail, 9);
    expect(Math.abs(level.values.vos_sys)).toBeLessThan(1e-2 * res.values.vos_sys);
    expect(Math.abs(level.values.pair_split - 0.5)).toBeLessThan(
      1e-2 * Math.abs(res.values.pair_split - 0.5),
    );
    // Past that level both differences change sign together, so they still add, and the
    // output side takes the larger share. At 1.3 V the output is 0.168 V above the diode node;
    // the model gives
    //   pair    (2.5 + 0.687810)/(2.5 + 0.855852) = 0.949926   (diode side over output side)
    //   mirror  (2.5 + 0.5)/(2.5 + 0.668042)      = 0.946957
    // so the output side takes 1/(1 + 0.949926) = 51.28 % of the tail current and the output
    // node is short of that current times (1 − 0.949926 × 0.946957) = 10.05 %.
    const above = runSheet(withParams(doc, { V_out_dc: 1.3 }), table);
    const pairAbove = (va + vdsDiode) / (va + (1.3 - vTail));
    const loadAbove = (va + (1.8 - 1.3)) / (va + VGS_GMID8_L05);
    const outAbove = iTail / (1 + pairAbove);
    const gmAbove = (2 * (12 * outAbove) * (12 * (iTail - outAbove))) / (12 * iTail);
    expect(above.values.pair_split).toBeGreaterThan(0.5);
    expect(relErr(above.values.pair_split - 0.5, 1 / (1 + pairAbove) - 0.5)).toBeLessThan(1e-2);
    expect(
      relErr(above.values.vos_sys, (outAbove * (1 - pairAbove * loadAbove)) / gmAbove),
    ).toBeLessThan(1e-2);
  });

  it('slew rate, GBW and supply current follow from the current the tail delivers', () => {
    // 20 µA × 0.946652 = 18.933 µA — not the 20 µA the reference is programmed to.
    expect(relErr(res.values.SR, iTail / CL)).toBeLessThan(1e-3);
    // The bandwidth is the pair's transconductance into the load, 113.4 µS over 2π × 2 pF.
    expect(relErr(res.values.GBW, gmPair / (2 * Math.PI * CL))).toBeLessThan(1e-3);
    // Which quantity each equation reads, exactly: the tail's own current, and the pair's
    // transconductance row.
    expect(relErr(res.values.SR, res.values.tail__id / CL)).toBeLessThan(1e-12);
    expect(relErr(res.values.GBW, res.values.gm_pair / (2 * Math.PI * CL))).toBeLessThan(1e-12);
    // The reference branch is shared bias and is not counted.
    expect(res.values.I_q).toBe(res.values.tail__id);
  });

  it('gain is the pair transconductance into the two output conductances', () => {
    // Both conductances are read at the OUTPUT node. The output-side pair transistor carries
    // 9.109 µA at vds = V_out_dc − V_tail = 0.455852 V, so its gds is I/(VA + vds) there. The
    // load's output side copies the diode side's saturation current I/(1 + vgs(8)/VA) and
    // gds = idSat/VA in the demo model, so its gds is the diode side's 9.824 µA over
    // (VA + vgs(8)) — the drain voltage it sits at cancels.
    // Rout = 1/(9.109 µA/2.955852 V + 9.824 µA/3.168042 V) = 161.7 kΩ, and the gain is the pair's
    // 113.4 µS into it, 18.35.
    const rout = 1 / (gdsOf(iOut, L, vdsOut) + gdsOf(iDiode, L, VGS_GMID8_L05));
    expect(relErr(res.values.Rout, rout)).toBeLessThan(1e-3);
    expect(relErr(res.values.Av, gmPair * rout)).toBeLessThan(1e-3);
    // The gain reads through both rows — a name for the output node and a name for the pair,
    // not second opinions about either.
    expect(relErr(res.values.Av, res.values.gm_pair * res.values.Rout)).toBeLessThan(1e-12);
    // The output node's own conductance is the output-side transistor's, whatever its partner
    // does.
    const { in__gds, ld__gds } = res.values;
    expect(relErr(res.values.Rout, 1 / (in__gds + ld__gds))).toBeLessThan(1e-12);
    expect(relErr(in__gds, gdsOf(iOut, L, vdsOut))).toBeLessThan(1e-3);
  });

  it('input capacitance is one input gate, at the width the sizing landed on', () => {
    // Per input terminal: a differential source drives one pair transistor on each side, and
    // the row is the mean of the two. cgg = W·L·Cox exactly in the demo model, with no bias
    // dependence, so here the two are one number.
    expect(relErr(res.values.cgg_in, cggOf(res.values.in__W, L))).toBeLessThan(1e-9);
    const { inr__cgg, in__cgg } = res.values;
    expect(relErr(res.values.cgg_in, (inr__cgg + in__cgg) / 2)).toBeLessThan(1e-12);
  });

  it('input noise counts both pair and both mirror devices, each where it sits', () => {
    // A pair transistor's noise is in series with its own input, so it enters at its own
    // density 4kTγ/gm, each at its own gm: 12 × 9.109 µA on the output side and 12 × 9.824 µA
    // on the diode side. A mirror device's 4kTγ·gm of current noise is a current at the output,
    // referred through the pair's transconductance: its density times its gm over the pair's.
    // The load's diode side carries 9.824 µA at gm/ID 8; its output side is on the same gate at
    // a higher drain voltage, and gm scales with (VA + vds) exactly as id does, so it has
    // 1.073218 times that. Counting the output-side pair transistor twice instead would read
    // 1.1 % high, and referring the mirror through that transistor's own gm 1.6 % high.
    const referred = (gm: number): number => (vnthM(gm) * gm) / gmPair;
    const vn = Math.hypot(
      vnthM(12 * iDiode),
      vnthM(12 * iOut),
      referred(8 * iDiode),
      referred(8 * iDiode * loadRatio),
    );
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(1e-3);
  });

  it('random offset counts each pair transistor and refers the mirror pair through the diode side', () => {
    // Pelgrom, written out: sigma(vos) of a pair is sqrt(2)·hypot(A_VT, A_beta/(gm/ID))/sqrt(W·L),
    // and each of its two transistors carries half of that variance at its own gm/ID.
    // The mirror pair's is a current at the output, referred to the input through the pair's
    // transconductance by gm_ldr/gm_pair — the diode side's gm, 8 × 9.824 µA, not the output
    // side's, which is 7.3 % higher and would move this number by 4 %. The widths are the
    // sizer's answers, read from the result the way the capacitance golden reads its own.
    const { avt, abeta, in__W, ldr__W, ldr__gm, gm_pair } = res.values;
    const sigma = (W: number, gmId: number): number =>
      (Math.SQRT2 * Math.hypot(avt, abeta / gmId)) / Math.sqrt(W * L);
    // In the model the two pair transistors share a gm/ID as well as a width — it does not
    // depend on the drain voltage — so the pair's two halves are one figure. The diode-side one
    // is read back off the table between two drain-voltage nodes, 0.13 % under the 12 it has
    // in the model; that moves its own term by parts per million and the pair's
    // transconductance, which the mirror term divides by, by 0.06 %.
    const model = Math.hypot(sigma(in__W, 12), (sigma(ldr__W, 8) * 8 * iDiode) / gmPair);
    expect(relErr(res.values.vos, model)).toBeLessThan(1e-3);
    // At the gm/ID and the transconductances the run reports, the row is exact to rounding.
    const gmId = (name: string): number => res.values[`${name}__gm`] / res.values[`${name}__id`];
    const pair = Math.hypot(sigma(in__W, gmId('inr')), sigma(in__W, gmId('in'))) / Math.SQRT2;
    const mirror = (sigma(ldr__W, 8) * ldr__gm) / gm_pair;
    expect(relErr(res.values.vos, Math.hypot(pair, mirror))).toBeLessThan(1e-9);
  });

  it('every row reads the pair where it is about the pair and one transistor where it is about a node', () => {
    // The demo model cannot tell the pair's two transistors apart in gate capacitance (no bias
    // dependence at all) or in inversion level (no drain-voltage dependence), so the value
    // goldens above would pass on a capacitance or a random offset that read one transistor
    // twice. What each row reads is therefore pinned here as well.
    const names = (row: string): readonly string[] =>
      exprNames(doc.equations.find((r) => r.name === row)!.expr);
    const reads = (row: string, device: string): boolean =>
      names(row).some((n) => n.startsWith(`${device}__`));
    // About the pair as a whole: both transistors, each at its own operating point.
    for (const row of ['pair_split', 'gm_pair', 'vn_in', 'vos', 'cgg_in'])
      expect([row, reads(row, 'inr'), reads(row, 'in')]).toEqual([row, true, true]);
    // Through the pair's transconductance: the one row for it, and neither transistor's own gm.
    for (const row of ['Av', 'GBW', 'vos_sys', 'vn_in'])
      expect([
        row,
        names(row).includes('gm_pair'),
        names(row).some((n) => /^inr?__gm$/.test(n)),
      ]).toEqual([row, true, false]);
    expect(names('vos')).toContain('gm_pair');
    // About the output node: the output-side transistor and the mirror's output device only.
    expect([...names('Rout')].sort()).toEqual(['in__gds', 'ld__gds']);
    expect([...names('vos_sys')].sort()).toEqual(['gm_pair', 'in__id', 'ld__id']);
  });

  it('the saturation margin watches whichever pair drain has less to spare', () => {
    // Each transistor is held against its own saturation voltage at its own drain. With the
    // output at 0.9 V, below the load's diode node (1.132 V), the output side is the one with
    // less: 0.9 V less the tail node less its saturation voltage.
    const margin = (r: SheetResult): number =>
      r.checks.find((c) => c.id === 'input-sat-margin')!.lhsValue!;
    const { V_tail, in__vdsat, inr__vdsat, ldr__vgs } = res.values;
    expect(margin(res)).toBeCloseTo(0.9 - V_tail - in__vdsat, 12);
    // Raise the output past the diode node and the diode side becomes the one that binds; the
    // output level then drops out of the margin altogether.
    const raised = runSheet(withParams(doc, { V_out_dc: 1.3 }), table);
    const v = raised.values;
    expect(margin(raised)).toBeCloseTo(1.8 - v.ldr__vgs - v.V_tail - v.inr__vdsat, 12);
    expect(margin(raised)).toBeLessThan(1.3 - v.V_tail - v.in__vdsat);
    // In the model that is the same margin the default would have had on its diode side.
    expect(margin(raised)).toBeCloseTo(1.8 - ldr__vgs - V_tail - inr__vdsat, 9);
  });

  it('the mirror-node pole is the diode side gm over both mirror gates', () => {
    // gm_ldr = 8 × the 9.824 µA the diode side carries; the two mirror devices are one width
    // and one length, so the node carries twice one gate's W·L·Cox.
    const fPole = (8 * iDiode) / (2 * Math.PI * 2 * cggOf(res.values.ldr__W, L));
    expect(relErr(res.values.f_pole, fPole)).toBeLessThan(1e-3);
  });

  it('the design constraint lands the common mode exactly where the spec asked', () => {
    // The tail node is solved, not typed: the engine bisects V_tail until CM_in equals CM_dc.
    // This is the whole two-door design — internal coordinate canonical, external one typed.
    // 5 decimals: the bracket closes at CONSTRAINT_TOL_REL x its span (~0.7 µV on V_tail), which
    // the CM relation's slope stretches to just under a µV — 6 decimals would ride on luck.
    expect(res.values.CM_in).toBeCloseTo(1.1, 5);
  });

  it('the common-mode checks hold at defaults', () => {
    for (const id of ['tail-saturated', 'cm-not-below', 'cm-not-above']) {
      const r = res.checks.find((x) => x.id === id);
      expect(r?.status === 'pass' || r?.status === 'amber', id).toBe(true);
    }
  });

  it('the claimed CM range is checked at its ENDS by its range ends', () => {
    // Structure golden: the sheet re-evaluates at CM_dc = CM_lo and CM_hi on every run, each
    // range end re-solving the tail node from the full bracket on the design the base run produced.
    // The landed nodes must bracket the base solve (CM_in is monotone in V_tail), and the
    // linearized reach advisory checks the range ends replaced must stay gone. Whether the demo
    // device COMPLIES at those ends is deliberately not asserted — budgets are tuned for real
    // tables.
    expect(res.rangeEnds?.map((e) => e.name)).toEqual(['cm-lo', 'cm-hi']);
    const [lo, hi] = res.rangeEnds!;
    expect(lo.solved.V_tail).toBeLessThan(res.values.V_tail);
    expect(hi.solved.V_tail).toBeGreaterThan(res.values.V_tail);
    const ids = doc.checks.map((r) => r.id);
    expect(ids).not.toContain('cm-lo-reach');
    expect(ids).not.toContain('cm-hi-reach');
  });

  it('PM pays the mirror node as a pole-zero DOUBLET, not a lone pole', () => {
    // A structure golden: the doublet's zero (at twice the pole) must be OBSERVABLE, so
    // deleting it cannot pass. Reconstructed from the sheet's own GBW/f_pole to isolate the
    // PM algebra — the value goldens above own the underlying quantities.
    const v = res.values;
    const doublet =
      90 - ((Math.atan(v.GBW / v.f_pole) - Math.atan(v.GBW / (2 * v.f_pole))) * 180) / Math.PI;
    expect(relErr(v.PM, doublet)).toBeLessThan(1e-9);
    const lonePole = 90 - (Math.atan(v.GBW / v.f_pole) * 180) / Math.PI;
    expect(v.PM - lonePole).toBeGreaterThan(1e-4);
  });

  it('held at another condition, the tail follows its reference instead of a typed current', () => {
    // A second characterization with half the current and half the transconductance at every
    // gate voltage, and the design sized on the first asked about on the second. Every width is
    // the sized one. The reference keeps the current it is programmed to, so at half the current
    // density it needs a higher gate voltage; the tail device is that width on that gate, so it
    // follows the reference there rather than being handed 20 µA. The pair, at its own fixed
    // width, needs a higher gate voltage too, which lowers the tail node the common mode leaves
    // it. Both moves push the mirror ratio down, so the tail delivers less than it did where the
    // design was sized — the closed form is the same one, read at this condition's two voltages
    // (scaling the current column by a constant leaves its (VA + vds) dependence alone).
    const at = (t: DeviceTable, corner: string, temp: number): DeviceTable => ({
      ...t,
      id: { ...t.id, corner, temp },
    });
    const weak = scaleQuantities(table, { id: 0.5, gm: 0.5 });
    const [device] = groupDevices([at(table, 'tt', 27), at(weak, 'ss', -40)]);
    const tt = { corner: 'tt', temp: 27 };
    const [sized, held] = runConditions(
      doc,
      device,
      [tt, { corner: 'ss', temp: -40 }],
      () => undefined,
      REFS,
      tt,
    );
    expect([sized.design, held.design]).toEqual(['sized', 'held']);
    expect([sized.state, held.state]).toEqual(['evaluated', 'evaluated']);
    if (sized.state !== 'evaluated' || held.state !== 'evaluated') return;
    const [s, h] = [sized.result, held.result];

    for (const name of ['bias', 'tail', 'in', 'ldr', 'inr', 'ld'])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    expect(block(h, 'bias').id).toBe(I_TAIL);
    expect(block(h, 'bias').vgs).toBeGreaterThan(block(s, 'bias').vgs);
    expect(relErr(block(h, 'tail').vgs, block(h, 'bias').vgs)).toBeLessThan(1e-12);
    expect(h.values.V_tail).toBeLessThan(s.values.V_tail);
    // The pair stays one gate-source voltage there: the output-side transistor needs more of it
    // at half the current density, and its partner is read at whatever that comes to.
    expect(block(h, 'in').vgs).toBeGreaterThan(block(s, 'in').vgs);
    expect(relErr(block(h, 'inr').vgs, block(h, 'in').vgs)).toBeLessThan(1e-12);

    // The split is solved again there, on the held widths: the pair's two currents add up to
    // what the tail delivers at this condition and the load's diode side carries its own pair
    // transistor's, to the solve's 1e-7.
    expect(relErr(h.values.in__id + h.values.inr__id, h.values.tail__id)).toBeLessThan(1e-6);
    expect(relErr(block(h, 'ldr').id, h.values.inr__id)).toBeLessThan(1e-6);
    expect(relErr(h.values.out_share, h.values.pair_split)).toBeLessThan(1e-6);
    expect(h.values.tail__id).toBeLessThan(s.values.tail__id);
    const ratio = (va + h.values.V_tail) / (va + block(h, 'bias').vgs);
    expect(relErr(1 - h.values.tail__id / I_TAIL, 1 - ratio)).toBeLessThan(1e-2);
  });
});

// The two shapes a gate-wiring declaration can take, one library sheet each.
//
// Where a node is DERIVED from the device that owns it, the declaration re-states an identity
// and can never fire — the flipped voltage follower is now that case, and its declaration is
// kept precisely so the identity stays checked if anyone types the node back in.
//
// Where a node is STATED as a spec and two devices are sized against it independently, the
// declaration is a real comparison and may disagree. The CMOS inverter is that case and
// disagrees on both sides at its defaults: one shared gate carrying one shared current leaves a
// single real degree of freedom between the two inversion levels, so the sheet asks for the
// input level, reports where each device's sizing actually lands, and leaves the reconciliation
// to the designer. Locked here so that a sheet losing either behaviour shows up as a test
// failure rather than as silence.
describe('what the gate-wiring check reports on the library at its shipped defaults', () => {
  const wiringWarnings = (res: SheetResult): string[] =>
    res.warnings.filter((w) => w.rule === 'sheet-wiring').map((w) => w.location ?? '');

  /** The residual the engine ITSELF reported for one block, in volts — read back out of the
   *  finding rather than recomputed alongside it, so what is asserted is the number a designer
   *  reads, arithmetic and all. */
  const reportedDelta = (res: SheetResult, block: string): number => {
    const found = res.warnings.filter((w) => w.rule === 'sheet-wiring' && w.location === block);
    expect(found).toHaveLength(1);
    const m = /delta (-?[\d.]+e[+-]\d+) V/.exec(found[0].message);
    expect(m).not.toBeNull();
    return Number((m as RegExpExecArray)[1]);
  };

  it('the CMOS inverter reports both devices missing the input level it was given', () => {
    const res = runSheet(sheet('stages/cmos-inverter-amp.json'), table);
    // V_in is a spec, 0.9 V (mid-supply, where an inverting stage is biased). On the demo table —
    // one NMOS dataset standing in for both polarities — the NMOS sizing puts the shared gate at
    // vgs(12) = 0.567 V and the PMOS sizing at 1.8 - vgs(10) = 1.190 V, so both sides miss by
    // thirty times the 10 mV tolerance and both consistency advisory checks read fail.
    expect(relErr(res.values.V_in_n, VGS_GMID12_L05)).toBeLessThan(1e-3);
    expect(relErr(res.values.V_in_p, 1.8 - VGS_GMID10_L05)).toBeLessThan(1e-3);
    expect(relErr(reportedDelta(res, 'n'), 0.9 - VGS_GMID12_L05)).toBeLessThan(1e-3);
    expect(relErr(reportedDelta(res, 'p'), 0.9 - (1.8 - VGS_GMID10_L05))).toBeLessThan(1e-3);
    expect(reportedDelta(res, 'n')).toBeGreaterThan(WIRING_TOL);
    expect(reportedDelta(res, 'p')).toBeLessThan(-WIRING_TOL);
    expect(wiringWarnings(res)).toEqual(['n', 'p']);
    // Closing both advisory checks at once needs vgs_n + |vgs_p| = VDD, i.e. both devices near 0.9
    // V, which on this table is gm/ID about 4-5 — below the min of 6 that both inversion params
    // declare. The declared ranges are the user's spec and are not widened to manufacture a green
    // check; the residual IS the sheet showing the reconciliation the designer has to make.
    //
    // Both checks put V_in on the right, so both bands are 1% of the one typed input level:
    // 9 mV at the 0.9 V default, under the 10 mV wiring tolerance on BOTH sides. A '==' margin
    // is (tolPct/100)*|rhs| - |lhs - rhs|, so each is 0.009 V less the residual above.
    const check = (id: string): { status: string; margin: number } =>
      res.checks.find((r) => r.id === id) as { status: string; margin: number };
    expect(check('input-consistent-n').status).toBe('fail');
    expect(check('input-consistent-p').status).toBe('fail');
    expect(relErr(check('input-consistent-n').margin, 0.009 - (0.9 - VGS_GMID12_L05))).toBeLessThan(
      1e-3,
    );
    expect(
      relErr(check('input-consistent-p').margin, 0.009 - (1.8 - VGS_GMID10_L05 - 0.9)),
    ).toBeLessThan(1e-3);
    expect(res.feasible).toBe(true); // advisory checks and wiring warnings never move the verdict
  });

  it('the flipped voltage follower derives its internal node instead of declaring one', () => {
    const res = runSheet(sheet('multistage/flipped-voltage-follower.json'), table);
    // Node X is the feedback device's gate above its grounded source, so the node IS that
    // device's own sized gate-source voltage — vgs(10) on the demo table — and the input device's
    // drain-source voltage is what is left of it above the output. Nothing is typed, so the
    // declaration re-states an identity and reports nothing.
    expect(relErr(res.values.V_x, VGS_GMID10_L05)).toBeLessThan(1e-3);
    expect(wiringWarnings(res)).toEqual([]);
    expect(res.feasible).toBe(true);
  });
});
