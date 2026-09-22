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
import { runSheet, validateSheet, WIRING_TOL } from './index';
import { resolveSheetRefs } from './resolve';
import {
  docExpressions,
  isHardRule,
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
  VGS_GMID10_L05,
  VGS_GMID12_L05,
  cggOf,
  roMirrored,
  stage2Rout,
  pelgromIrelRatio,
} from './library.fixtures';
// Test-only reach across to the picker: the searchable set is that module's curation, and the
// interface gate below is the library-side half of the same fact.
import { searchable } from '../picker';

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
        if (doc.bind) {
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
  for (const u of doc.uses ?? []) {
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
      actual[file] = sorted(doc.provide ?? []);
      // Union, not override: a sheet in the hand map still owes its reserved-name rows, so
      // one that later grows a real Rout row is required to publish it like everyone else.
      const reserved = file.startsWith(CONSUMER_GROUP)
        ? []
        : [...doc.rows.map((r) => r.name), ...doc.params.map((p) => p.name)].filter((n) =>
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
      for (const key of doc.provide ?? []) {
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
      if (!(doc.provide ?? []).includes('I_q')) missing.push(`${file}: not published`);
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
    expect(sheet('mirrors-bias/simple-mirror.json').rules.map((r) => r.id)).not.toContain(
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
  const res = runSheet(sheet('otas/five-transistor-ota.json'), table);
  // Defaults: I_tail 20 µA into CL 2 pF, input gm/ID 12, load gm/ID 8, all L 0.5 µm.

  it('slew rate and GBW follow exactly from the tail current and input gm', () => {
    expect(relErr(res.values.SR, 20e-6 / 2e-12)).toBeLessThan(1e-9);
    // Input gm = (I_tail/2)·gm/ID — both supplied to the bind, so exact.
    expect(relErr(res.values.GBW, 120e-6 / (2 * Math.PI * 2e-12))).toBeLessThan(1e-6);
  });

  it('gain matches the demo model with the two output conductances', () => {
    // The input device is biased at the OUTPUT node — it is the device whose gds sets the
    // gain — so vds = V_out_dc − (CM_dc − vgs_in), with vgs_in solved to a fixed point rather
    // than read from a stale estimate. Take the converged point from the result; the model
    // check (gds/id = 1/(VA + vds) in the demo device) is what this test owns.
    const va = VA_PER_L * 0.5e-6;
    const vdsIn = 0.9 - (1.1 - res.values.in__vgs);
    const gdsIn = 10e-6 / (va + vdsIn);
    const gdsLd = 10e-6 / (va + 0.9);
    const av = 120e-6 / (gdsIn + gdsLd);
    expect(relErr(res.values.Av, av)).toBeLessThan(1e-2);
    // Rout is the inverse of that same sum, and the gain now reads through it — a name for the
    // output node, not a second opinion about it.
    expect(relErr(res.values.Rout, 1 / (gdsIn + gdsLd))).toBeLessThan(1e-2);
    expect(relErr(res.values.Av, res.values.in__gm * res.values.Rout)).toBeLessThan(1e-12);
  });

  it('input capacitance is one input gate, at the width the bind landed on', () => {
    // Per input terminal: the pair is a half circuit, so a differential source drives one of
    // these on each side. cgg = W·L·Cox exactly in the demo model.
    expect(relErr(res.values.cgg_in, cggOf(res.values.in__W, 0.5e-6))).toBeLessThan(1e-9);
  });

  it('input noise counts both pair and both mirror devices (two-sided)', () => {
    const vn = vnthM(120e-6) * Math.sqrt(2 * (1 + 8 / 12));
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(1e-3);
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
    const ids = sheet('otas/five-transistor-ota.json').rules.map((r) => r.id);
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
