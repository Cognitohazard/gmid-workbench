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
import { runSheet, validateSheet, WIRING_TOL } from './index';
import { resolveSheetRefs } from './resolve';
import { isHardRule, type SheetChildReport, type SheetResult } from './types';
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
} from './library.fixtures';

const LIBRARY = loadLibrary();

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

  for (const { file, doc } of LIBRARY) {
    describe(file, () => {
      it('resolves refs and validates clean', () => {
        const r = resolveSheetRefs(doc, REFS);
        expect(r.warnings).toEqual([]);
        const errs = validateSheet(r.doc).filter((w) => w.severity === 'error');
        expect(errs).toEqual([]);
      });

      it('evaluates on the demo device: bind ok, no errors, no hard-rule na', () => {
        const res = runSheet(doc, table, undefined, REFS);
        expect(res.warnings.filter((w) => w.severity === 'error')).toEqual([]);
        if (doc.bind) {
          expect(res.bind?.ok, res.bind?.error).toBe(true);
        }
        expect(hardNaRules(res)).toEqual([]);
      });
    });
  }
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

  it('the K-times-larger output device carries half the reference current spread', () => {
    // pelgrom_irel ∝ 1/sqrt(W·L): W_out = 4·W_ref at the same L ⇒ ratio exactly 1/2.
    expect(relErr(res.values.irel_out / res.values.irel_ref, 0.5)).toBeLessThan(1e-9);
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

  it('the claimed CM range is proven at its ENDS by containment edges', () => {
    // Structure golden: the sheet re-evaluates at CM_dc = CM_lo and CM_hi on every run,
    // each edge re-solving the tail node from the full bracket. The landed nodes must
    // bracket the base solve (CM_in is monotone in V_tail), and the linearized reach
    // guardrails the edges replaced must stay gone. Edge FEASIBILITY on the demo device
    // is deliberately not asserted — budgets are tuned for real tables.
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

// Two library sheets ship with a gate-wiring disagreement, and the engine now says so on
// every evaluation. Neither is a defect in the check: both sheets offer a knob their own
// schematic does not leave free — one shared gate cannot satisfy two independently chosen
// inversion levels — and repairing that changes which quantities the sheet asks a designer
// for. That is a change to the sheets' contract, not a number to slip under a golden, so the
// finding stays loud while it waits. Locked here as ASSERTED intent, the same way the
// containment-honesty golden locks a claim the demo table refutes: if one of these stops
// firing, either someone repaired the sheet — and should replace this test with its golden —
// or the check quietly stopped working.
describe('gate-wiring disagreements the library reports at its shipped defaults', () => {
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

  it('the CMOS inverter sizes its two devices for gates 0.62 V apart', () => {
    const res = runSheet(sheet('stages/cmos-inverter-amp.json'), table);
    // One gate, two binds: the NMOS puts it at its own vgs above ground, the PMOS its own vgs
    // below VDD. On the demo table (one NMOS dataset standing in for both polarities) that is
    // vgs(12) = 0.567023 against 1.8 - vgs(10) = 1.189937, so the node is over-determined by
    // -0.622914 V — sixty times the 10 mV tolerance, and the sheet still reads feasible.
    const delta = reportedDelta(res, 'p');
    expect(relErr(delta, VGS_GMID12_L05 - (1.8 - VGS_GMID10_L05))).toBeLessThan(1e-3);
    expect(delta).toBeLessThan(-WIRING_TOL);
    // The NMOS side is the one that DEFINES the node, so only the PMOS can disagree.
    expect(wiringWarnings(res)).toEqual(['p']);
    expect(res.feasible).toBe(true); // a wiring warning never moves the verdict
  });

  it('the flipped voltage follower puts its feedback gate 0.89 V off the node it assumes', () => {
    const res = runSheet(sheet('multistage/flipped-voltage-follower.json'), table);
    // The feedback device's gate is the input device's drain, which the sheet places at
    // V_out + vds_in = 1.5 V; its own bind needs vgs(10) = 0.610063 V above its grounded
    // source, so the gate is reported +0.889937 V above the node the bind asks for. Typing the
    // drain-source voltage and the inversion level as two free choices is exactly what leaves
    // the node claiming two values at once.
    const delta = reportedDelta(res, 'fb');
    expect(relErr(delta, 1.5 - VGS_GMID10_L05)).toBeLessThan(1e-3);
    expect(delta).toBeGreaterThan(WIRING_TOL);
    expect(wiringWarnings(res)).toEqual(['fb']);
    expect(res.feasible).toBe(true);
  });
});
