// The curated sheet library lives in /sheets as plain JSON documents. This suite is
// the library's vetting gate, in two layers:
//
//  1. A generic contract every library sheet must satisfy: parses as a SheetDoc,
//     validates clean, and evaluates on the synthetic EKV demo device with a working
//     bind, no error-severity warnings, and no hard rule reading `na` anywhere in the
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
import { runSheet, validateSheet, WIRING_TOL } from './index';
import { resolveSheetRefs } from './resolve';
import {
  docExpressions,
  isHardRule,
  type BindReport,
  type SheetChildReport,
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
import { groupFamilies, runVariants } from '../corners';

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

function hardNaRules(res: SheetResult): string[] {
  const out: string[] = [];
  for (const r of res.rules) if (isHardRule(r.kind) && r.status === 'na') out.push(r.id);
  const walk = (c: SheetChildReport, path: string): void => {
    for (const r of c.rules)
      if (isHardRule(r.kind) && r.status === 'na') out.push(`${path}.${r.id}`);
    for (const cc of c.children ?? []) walk(cc, `${path}.${cc.name}`);
  };
  for (const c of res.children ?? []) walk(c, c.name);
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

      it('evaluates on the demo device: bind ok, no errors, no hard-rule na', () => {
        expect(error).toBeUndefined();
        const r = res!;
        expect(r.warnings.filter((w) => w.severity === 'error')).toEqual([]);
        if (doc.givens) {
          expect(r.bind?.ok, r.bind?.error).toBe(true);
        }
        expect(hardNaRules(r)).toEqual([]);
      });
    });
  }
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
  // Resolved docs, so a ref-only use is linted against the library sheet it names.
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
    // of step with every other noise row the moment the default or the table changes. Any
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
      const end = res.edges?.find((e) => e.name === 'cm-lo');
      expect(Object.keys(end?.solved ?? {}).sort()).toEqual(
        [...Object.keys(gates), 'V_tail'].sort(),
      );
      for (const [node, [device, sign]] of Object.entries(gates)) {
        const vgs = Math.abs(end!.children!.find((c) => c.name === device)!.bind!.vgs);
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
        const use = doc.blocks?.find((u) => u.name === device);
        const bind = device ? res.children?.find((c) => c.name === device)?.bind : res.bind;
        const pType = (use?.doc ?? doc).polarity === 'p';
        const vsb = bind!.bias!.vsb;
        const vgs = Math.abs(bind!.vgs);
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
    // shared gate — so its bind reads the first device's current (`tail__id/2`) or is tied to
    // that device's gate (`W: K*ref__W, vgs: ref__vgs`), and never the programmed number a
    // second time. A sheet that types the number into several devices leaves every one of them
    // carrying an ideal current when the design is held fixed and asked about at another
    // condition.
    //
    // The walk, per sheet: for each parameter in amperes, the devices whose bound current reads
    // it — a block's `id` followed through that block's param overrides, or the sheet's own bind
    // read directly — without reading any block's output. Rows are read through, so giving the
    // share a name (`I_half = I_tail/2`) does not hide it. A current that reads a
    // `block__quantity` is one the circuit sets, and is not counted.
    const programs = (doc: SheetDoc): string[] => {
      const rows = new Map(doc.equations.map((r) => [r.name, r.expr]));
      const reads = (exprs: readonly string[]): Set<string> => {
        const seen = new Set<string>();
        const visit = (name: string): void => {
          if (seen.has(name)) return;
          seen.add(name);
          const row = rows.get(name);
          if (row !== undefined) for (const n of exprNames(row)) visit(n);
        };
        for (const e of exprs) for (const n of exprNames(e)) visit(n);
        return seen;
      };
      const devices: [string, Set<string>][] = [];
      if (typeof doc.givens?.id === 'string') devices.push(['bind', reads([doc.givens.id])]);
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
      'multistage/fd-two-stage-ota.json',
      'multistage/two-stage-cascode-comp-ota.json',
      'multistage/two-stage-miller-ota.json',
      'otas/current-mirror-ota.json',
      'otas/differential-pair-tail.json',
      'otas/folded-cascode-ota.json',
      'otas/gain-boosted-cascode-ota.json',
      'otas/symmetrical-ota.json',
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
// names it carries — both directions, so adding the row without the provide entry (or the reverse)
// fails. I_q is the one reserved name a sheet may instead own as a PARAMETER, where the supply
// current is the designer's knob rather than a consequence, so the derivation below reads both.
const RESERVED_PORTS: readonly string[] = ['Rout', 'Rin', 'cgg_in', 'Ron', 'I_q'];

// A sheet under applications/ is the TOP of a composition: it consumes blocks and nothing
// consumes it, so a reserved name it computes is an internal number and publishing it would be
// theatre. Those publish nothing — unless they are in the map below.
const CONSUMER_GROUP = 'applications/';

// The sheets whose interface is not a reserved-name row at all: a bias generator, a spec
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
    // Accepted residual: deleting a reserved-name ROW and its provide entry together still
    // satisfies the rule, since both sides move at once. The per-sheet Rout goldens in the
    // tier suites are the mitigation — they read the row by name and fail when it goes. For
    // I_q the residual is closed outright, by the named-set test further down.
    const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
    const actual: Record<string, string[]> = {};
    const expected: Record<string, string[]> = {};
    for (const { file, doc } of LIBRARY) {
      actual[file] = sorted(doc.provides ?? []);
      // Union, not override: a sheet in the hand map still owes its reserved-name rows, so
      // one that later grows a real Rout row is required to publish it like everyone else.
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
    // A provide list is inert outside composition, so a name that has quietly stopped resolving
    // would cost nothing here and everything the first time a parent read it.
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
    // Named positively, because the rule above cannot see this one: a sheet that drops its I_q row
    // AND its provide entry together stays consistent and would vanish from a comparison silently.
    // A search that ranks designs by supply current has to be told, per sheet, that the number is
    // there — so the set is spelled out here and the count is asserted, which is what makes a new
    // amplifier sheet arriving without an I_q fail rather than quietly go unranked.
    // The set is the picker's own curation predicate, not a copy of it: a sheet that joins or
    // leaves the search has to arrive here at the same moment.
    const searched = EVALUATED.filter(({ file }) => searchable(file.replace(/\.json$/, '')));
    expect(searched).toHaveLength(25);
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

  it('binds the input device exactly from the spec', () => {
    expect(res.bind?.ok).toBe(true);
    expect(relErr(res.values.gm, gm)).toBeLessThan(1e-9);
    expect(relErr(res.values.id, gm / 12)).toBeLessThan(1e-9);
    expect(res.bind?.bias?.vds).toBe(0.9);
    // The supply-current line is that same derived branch current: on a sheet bound from a
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

  it('the interface rows are the output node and the input gate', () => {
    // Both devices carry the same current at the same L and |vds|, so the output node collapses
    // to (VA + vds)/(2·id); Rout is the inverse of the denominator Av already used, which is why
    // the gain golden above did not move when the row was named. cgg = W·L·Cox exactly in the
    // demo model, at the width the bind landed on.
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
    expect(res.bind?.ok).toBe(true);
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
    // the sheet may ask the author to reconcile a stand-in with what the device turned out to be.
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
  const block = (r: SheetResult, name: string): BindReport =>
    r.children!.find((c) => c.name === name)!.bind!;

  // Only the reference's current is typed; every other one is what the demo model gives a device
  // of that width on that gate. There id ∝ (VA + vds) at fixed vgs and W, so a 1:1 mirror
  // delivers its reference current times (VA + vds_out)/(VA + vds_ref), and a diode-connected
  // reference has vds_ref equal to its own vgs. Each gate voltage below is the model's for the
  // inversion level the sheet asks of that device, so nothing here is read back from the run:
  //   tail node    V_tail = CM_dc − vgs(12) = 0.532977 V   (the pin puts the pair's gate at CM_dc)
  //   tail mirror  (2.5 + 0.532977)/(2.5 + 0.610063) = 0.975214   (reference at vgs(10))
  //   load mirror  (2.5 + 0.9)/(2.5 + 0.668042)      = 1.073218   (diode side at vgs(8), output
  //                                                                side at VDD − V_out_dc)
  const vTail = 1.1 - VGS_GMID12_L05;
  const tailRatio = (va + vTail) / (va + VGS_GMID10_L05);
  const loadRatio = (va + (1.8 - 0.9)) / (va + VGS_GMID8_L05);
  /** What each side of the pair carries: half of what the tail delivers, 9.752 µA. */
  const iHalf = (I_TAIL / 2) * tailRatio;

  it('the tail node carries one current and each mirror is one gate wire', () => {
    // Kirchhoff at the tail node, to the last bit: the pair and the load's diode side are HANDED
    // the tail's current, halved — none of them is sized against the programmed number.
    expect(block(res, 'bias').id).toBe(I_TAIL);
    expect(res.values.tail__id).toBe(2 * res.values.in__id);
    expect(block(res, 'ldr').id).toBe(res.values.in__id);
    // A 1:1 mirror is the same width on the same gate. The width is passed through untouched;
    // the gate voltage is reported as the table's own vgs coordinate at the point it was read,
    // so two devices on one wire agree to rounding rather than always to the last bit.
    expect(block(res, 'tail').W).toBe(block(res, 'bias').W);
    expect(block(res, 'ld').W).toBe(block(res, 'ldr').W);
    expect(relErr(block(res, 'tail').vgs, block(res, 'bias').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'ld').vgs, block(res, 'ldr').vgs)).toBeLessThan(1e-12);
  });

  it('each mirror misses its reference by the drain-voltage ratio of the demo model', () => {
    // The tail node (0.533 V) sits below the reference's diode drop (0.610 V), so the tail
    // under-delivers by 1 − 0.975214 = 2.48 %. The output sits 0.9 V below the supply, further
    // than the load's diode drop (0.668 V), so the output side asks for 7.32 % more than the
    // half tail current its diode side carries. Compared as errors, the way the mirror golden
    // above compares its own: 1e-2 of them is 0.8 mV and 2.3 mV of drain-voltage difference.
    const tailErr = 1 - res.values.tail__id / I_TAIL;
    const loadErr = res.values.ld__id / (res.values.tail__id / 2) - 1;
    expect(relErr(tailErr, 1 - tailRatio)).toBeLessThan(1e-2);
    expect(relErr(loadErr, loadRatio - 1)).toBeLessThan(1e-2);
    // Referred to the input through the pair's gm = (gm/ID)·I, the half current cancels: the
    // systematic offset is the load mirror's error over the pair's gm/ID, 0.073218/12 = 6.10 mV.
    expect(relErr(res.values.vos_sys, (loadRatio - 1) / 12)).toBeLessThan(1e-2);
  });

  it('slew rate, GBW and supply current follow from the current the tail delivers', () => {
    // 20 µA × 0.975214 = 19.504 µA — not the 20 µA the reference is programmed to.
    expect(relErr(res.values.SR, (I_TAIL * tailRatio) / CL)).toBeLessThan(1e-3);
    // Input gm = (gm/ID)·(half the delivered current) — both supplied to the bind.
    expect(relErr(res.values.GBW, (12 * iHalf) / (2 * Math.PI * CL))).toBeLessThan(1e-3);
    // Which current each row reads, exactly: the tail's own, and the pair's half of it.
    expect(relErr(res.values.SR, res.values.tail__id / CL)).toBeLessThan(1e-12);
    expect(relErr(res.values.GBW, (12 * res.values.in__id) / (2 * Math.PI * CL))).toBeLessThan(
      1e-9,
    );
    // The reference branch is shared bias and is not counted.
    expect(res.values.I_q).toBe(res.values.tail__id);
  });

  it('gain matches the demo model with the two output conductances', () => {
    // Both conductances are read at the OUTPUT node. The input device carries the half current
    // at vds = V_out_dc − V_tail, so gds = I/(VA + vds) there. The load's output side copies the
    // diode side's saturation current I/(1 + vgs(8)/VA) and gds = idSat/VA in the demo model, so
    // its gds is I/(VA + vgs(8)) — the drain voltage it sits at cancels. The half current then
    // cancels out of gm/gds as well: Av = 12 / (1/(VA + vds_in) + 1/(VA + vgs(8))) = 18.06.
    const vdsIn = 0.9 - vTail;
    const av = 12 / (1 / (va + vdsIn) + 1 / (va + VGS_GMID8_L05));
    expect(relErr(res.values.Av, av)).toBeLessThan(1e-3);
    // Rout is the inverse of that same sum, and the gain reads through it — a name for the
    // output node, not a second opinion about it.
    const rout = 1 / (gdsOf(iHalf, L, vdsIn) + gdsOf(iHalf, L, VGS_GMID8_L05));
    expect(relErr(res.values.Rout, rout)).toBeLessThan(1e-3);
    expect(relErr(res.values.Av, res.values.in__gm * res.values.Rout)).toBeLessThan(1e-12);
  });

  it('input capacitance is one input gate, at the width the bind landed on', () => {
    // Per input terminal: the pair is a half circuit, so a differential source drives one of
    // these on each side. cgg = W·L·Cox exactly in the demo model.
    expect(relErr(res.values.cgg_in, cggOf(res.values.in__W, L))).toBeLessThan(1e-9);
  });

  it('input noise counts both pair and both mirror devices (two-sided)', () => {
    // Each device contributes 4kTγ·gm of current noise, referred by the pair's gm:
    // vn² = (4kTγ/gm_in)·(2 + gm_ldr/gm_in + gm_ld/gm_in). The diode side carries the pair's
    // current at gm/ID 8, so gm_ldr/gm_in = 8/12; the output side is on the same gate at a
    // higher drain voltage, and gm scales with (VA + vds) exactly as id does, so its ratio is
    // 8/12 × 1.073218.
    const vn = vnthM(12 * iHalf) * Math.sqrt(2 + (8 / 12) * (1 + loadRatio));
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(1e-3);
  });

  it('random offset refers the mirror pair through the diode side', () => {
    // Pelgrom, written out: sigma(vos) of a pair is sqrt(2)·hypot(A_VT, A_beta/(gm/ID))/sqrt(W·L).
    // The mirror pair's is referred to the input by gm_ldr/gm_in = 8/12 — the diode side's gm,
    // not the output side's, which is 7.3 % higher and would move this number by 4 %. The widths
    // are the sizer's answers, read from the result the way the capacitance golden reads its own.
    const { avt, abeta } = res.values;
    const sigma = (W: number, gmId: number): number =>
      (Math.SQRT2 * Math.hypot(avt, abeta / gmId)) / Math.sqrt(W * L);
    const vos = Math.hypot(sigma(res.values.in__W, 12), (sigma(res.values.ldr__W, 8) * 8) / 12);
    expect(relErr(res.values.vos, vos)).toBeLessThan(1e-9);
  });

  it('the mirror-node pole is the diode side gm over both mirror gates', () => {
    // gm_ldr = 8 × the half current; the two mirror devices are one width and one length, so
    // the node carries twice one gate's W·L·Cox.
    const fPole = (8 * iHalf) / (2 * Math.PI * 2 * cggOf(res.values.ldr__W, L));
    expect(relErr(res.values.f_pole, fPole)).toBeLessThan(1e-3);
  });

  it('the pin lands the common mode exactly where the spec asked', () => {
    // The tail node is solved, not typed: the engine bisects V_tail until CM_in equals CM_dc.
    // This is the whole two-door design — internal coordinate canonical, external one typed.
    // 5 decimals: the bracket closes at PIN_TOL_REL x its span (~0.7 µV on V_tail), which the
    // CM relation's slope stretches to just under a µV — 6 decimals would ride on luck.
    expect(res.values.CM_in).toBeCloseTo(1.1, 5);
  });

  it('the common-mode rules close at defaults', () => {
    for (const id of ['tail-saturated', 'cm-not-below', 'cm-not-above']) {
      const r = res.rules.find((x) => x.id === id);
      expect(r?.status === 'pass' || r?.status === 'amber', id).toBe(true);
    }
  });

  it('the claimed CM range is checked at its ENDS by containment edges', () => {
    // Structure golden: the sheet re-evaluates at CM_dc = CM_lo and CM_hi on every run, each
    // edge re-solving the tail node from the full bracket on the design the base run produced.
    // The landed nodes must bracket the base solve (CM_in is monotone in V_tail), and the
    // linearized reach guardrails the edges replaced must stay gone. Whether the demo device
    // COVERS those ends is deliberately not asserted — budgets are tuned for real tables.
    expect(res.edges?.map((e) => e.name)).toEqual(['cm-lo', 'cm-hi']);
    const [lo, hi] = res.edges!;
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
    const [family] = groupFamilies([at(table, 'tt', 27), at(weak, 'ss', -40)]);
    const tt = { corner: 'tt', temp: 27 };
    const [sized, held] = runVariants(
      doc,
      family,
      [tt, { corner: 'ss', temp: -40 }],
      () => undefined,
      REFS,
      tt,
    );
    expect([sized.design, held.design]).toEqual(['sized', 'held']);
    expect([sized.state, held.state]).toEqual(['evaluated', 'evaluated']);
    if (sized.state !== 'evaluated' || held.state !== 'evaluated') return;
    const [s, h] = [sized.result, held.result];

    for (const name of ['bias', 'tail', 'in', 'ldr', 'ld'])
      expect([name, block(h, name).W]).toEqual([name, block(s, name).W]);
    expect(block(h, 'bias').id).toBe(I_TAIL);
    expect(block(h, 'bias').vgs).toBeGreaterThan(block(s, 'bias').vgs);
    expect(relErr(block(h, 'tail').vgs, block(h, 'bias').vgs)).toBeLessThan(1e-12);
    expect(h.values.V_tail).toBeLessThan(s.values.V_tail);

    expect(h.values.tail__id).toBe(2 * h.values.in__id);
    expect(block(h, 'ldr').id).toBe(h.values.in__id);
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
    // one NMOS dataset standing in for both polarities — the NMOS bind puts the shared gate at
    // vgs(12) = 0.567 V and the PMOS bind at 1.8 - vgs(10) = 1.190 V, so both sides miss by
    // thirty times the 10 mV tolerance and both consistency guardrails read fail.
    expect(relErr(res.values.V_in_n, VGS_GMID12_L05)).toBeLessThan(1e-3);
    expect(relErr(res.values.V_in_p, 1.8 - VGS_GMID10_L05)).toBeLessThan(1e-3);
    expect(relErr(reportedDelta(res, 'n'), 0.9 - VGS_GMID12_L05)).toBeLessThan(1e-3);
    expect(relErr(reportedDelta(res, 'p'), 0.9 - (1.8 - VGS_GMID10_L05))).toBeLessThan(1e-3);
    expect(reportedDelta(res, 'n')).toBeGreaterThan(WIRING_TOL);
    expect(reportedDelta(res, 'p')).toBeLessThan(-WIRING_TOL);
    expect(wiringWarnings(res)).toEqual(['n', 'p']);
    // Closing both guardrails at once needs vgs_n + |vgs_p| = VDD, i.e. both devices near 0.9 V,
    // which on this table is gm/ID about 4-5 — below the min of 6 that both inversion params
    // declare. The declared ranges are the user's spec and are not widened to manufacture a green
    // rule; the residual IS the sheet showing the reconciliation the designer has to make.
    //
    // Both rules put V_in on the right, so both bands are 1% of the one typed input level:
    // 9 mV at the 0.9 V default, under the 10 mV wiring tolerance on BOTH sides. A '==' margin
    // is (tolPct/100)*|rhs| - |lhs - rhs|, so each is 0.009 V less the residual above.
    const rule = (id: string): { status: string; margin: number } =>
      res.rules.find((r) => r.id === id) as { status: string; margin: number };
    expect(rule('input-consistent-n').status).toBe('fail');
    expect(rule('input-consistent-p').status).toBe('fail');
    expect(relErr(rule('input-consistent-n').margin, 0.009 - (0.9 - VGS_GMID12_L05))).toBeLessThan(
      1e-3,
    );
    expect(
      relErr(rule('input-consistent-p').margin, 0.009 - (1.8 - VGS_GMID10_L05 - 0.9)),
    ).toBeLessThan(1e-3);
    expect(res.feasible).toBe(true); // guardrails and wiring warnings never move the verdict
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
