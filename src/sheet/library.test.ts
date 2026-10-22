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
//     model's closed forms (EKV current, VA = VA_PER_L·L Early voltage, 4kTγ·(gm + gmb)
//     thermal noise with gmb = BODY_FACTOR·gm) — never by re-running the engine. Per-tier goldens live in the
//     library.tier*.test.ts files; the exemplar goldens live here. The shared table,
//     loaders, and closed-form helpers live in library.fixtures.ts.
//
// Feasibility at default params is intentionally NOT part of the generic contract:
// defaults are tuned for realistic PDK data, and the demo device's current density
// (hence sized W and Pelgrom area) differs from real tables.

import { describe, it, expect } from 'vitest';
import { createEngine } from '../expr';
import { BODY_FACTOR, generateDemoDevice, scaleQuantities } from '../demo';
import type { DeviceTable } from '../types';
import { runSheet, validateSheet, withParams } from './index';
import { NODE_TOL, placementsOf, wiringRefusal } from './nodes';
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
  vgsAtGmId,
  sourceNodeUnder,
  vgsForCurrentRatio,
  gmIdDemo,
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

  it('no sheet reads the thermal floor without body effect', () => {
    // Every library noise row reads a noise figure (vnth_m, svth_m, or the measured vnth), which
    // carries the body effect where the table has gmb; a row written as 4kTγ/gm would not.
    const offenders: string[] = [];
    for (const { file, doc } of RESOLVED) {
      for (const w of validateSheet(doc)) {
        if (w.rule === 'sheet-noise-form') offenders.push(`${file}: ${w.message}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('a range end hangs each cascode node under the gate its bias branch sets there', () => {
    // The two cascoded OTAs claim an input common-mode range. At a range end every device keeps
    // its size, the bias branches included, and the tail node is re-solved for the new common
    // mode; the cascode nodes are re-solved too, each under its own gate. The gates are drawn: each
    // is the level a bias branch puts its gate wire at, and that branch is re-evaluated at the
    // range end like every other device. The check is the definition: node plus (for an N cascode)
    // or minus (for a P one) the cascode's gate-source voltage at the range end equals the level
    // the bias branch publishes there. The diode side's cascodes share those two gates, so the
    // nodes under them land on the same gate voltages; the split of the tail current is solved
    // again with them. On one table the bias branches carry their programmed currents at their
    // own widths, so they sit at the range end where they sat at the design point. Nothing is
    // held: the result carries no held gate, and no warning that one stood in for a bias line.
    const cases: [string, Record<string, [string, 1 | -1, string, string]>, string[]][] = [
      [
        'otas/telescopic-cascode-ota.json',
        {
          V_a: ['casc_n', 1, 'cbn', 'V_c'],
          V_b: ['casc_p', -1, 'cbp', 'V_b'],
          V_ar: ['casc_nr', 1, 'cbn', 'V_c'],
          V_br: ['casc_pr', -1, 'cbp', 'V_b'],
        },
        [],
      ],
      [
        'otas/folded-cascode-ota.json',
        {
          V_c: ['ncasc', 1, 'cbn', 'vgs'],
          V_fold: ['pcasc', -1, 'cbp', 'V_b'],
          V_c_r: ['ncasc_r', 1, 'cbn', 'vgs'],
          V_fold_r: ['pcasc_r', -1, 'cbp', 'V_b'],
        },
        // The PMOS bias line the folding sources share is derived from the reference, and solved.
        ['V_bp'],
      ],
    ];
    for (const [file, gates, more] of cases) {
      const res = runSheet(sheet(file), table, undefined, REFS);
      expect([file, res.held]).toEqual([file, undefined]);
      const end = res.rangeEnds?.find((e) => e.name === 'cm-lo');
      expect(Object.keys(end?.solved ?? {}).sort()).toEqual(
        [...Object.keys(gates), ...more, 'V_tail', 'out_share'].sort(),
      );
      for (const [node, [device, sign, branch, level]] of Object.entries(gates)) {
        const vgs = Math.abs(end!.blocks!.find((c) => c.name === device)!.sizing!.vgs);
        const gate = end!.blocks!.find((c) => c.name === branch)!.provides[level];
        expect(end!.solved[node] + sign * vgs).toBeCloseTo(gate, 5);
        expect(gate).toBeCloseTo(res.values[`${branch}__${level}`], 9);
      }
      expect(end!.warnings.filter((w) => w.rule === 'sheet-held-gate')).toEqual([]);
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
    // The cascode gates of the telescopic, folded, fully differential telescopic and cascode
    // common-source sheets are drawn bias branches now, so the nodes under them are solved under
    // the level the branch publishes and no hold stands in for one. The cascode-compensated
    // two-stage keeps its hold: the node under its cascodes hangs from the PMOS mirror's diode drop,
    // which no single-polarity branch drawn from a rail tracks across tables.
    const HELD_UNDER: Record<string, Record<string, string>> = {
      'multistage/flipped-voltage-follower.json': { V_out: 'in' },
      'multistage/super-source-follower.json': { vds_fb: 'in' },
      'multistage/two-stage-cascode-comp-ota.json': { V_casc: 'casc' },
    };
    // The other shape a hold takes: a typed current that is the design point's choice, held where
    // the design is held as the balance of two devices' currents. It reads zero at the design point
    // by construction.
    const BALANCED: Record<string, Record<string, string>> = {
      'otas/inverter-based-ota.json': { I_bias: 'I_bias - p__id' },
      'stages/cmos-inverter-amp.json': { I_bias: 'I_bias - p__id' },
    };
    const withBody = generateDemoDevice({
      vds: { min: 0, max: 1.8, step: 0.05 },
      vsb: { min: 0, max: 1.2, step: 0.05 },
    });
    for (const [file, balances] of Object.entries(BALANCED)) {
      const doc = sheet(file);
      const res = runSheet(doc, withBody, undefined, REFS);
      for (const [param, expr] of Object.entries(balances)) {
        expect([file, doc.params.find((p) => p.name === param)?.hold]).toEqual([file, expr]);
        expect([file, param, res.held?.[param]]).toEqual([file, param, 0]);
      }
    }
    for (const { file, doc } of LIBRARY) {
      const holds = doc.params
        .filter((p) => p.hold !== undefined && !(p.name in (BALANCED[file] ?? {})))
        .map((p) => p.name);
      expect([file, holds.sort()]).toEqual([file, Object.keys(HELD_UNDER[file] ?? {}).sort()]);
      if (!holds.length) continue;
      // The netlist states the same gate: the device's gate wire is held at exactly the hold
      // expression, the level the hold keeps fixed where the design is held. A device placed twice
      // holds each placement's gate wire there — one wire for two cascodes on one gate, two for a
      // differential pair's inputs.
      for (const [node, device] of Object.entries(HELD_UNDER[file])) {
        const hold = doc.params.find((p) => p.name === node)!.hold;
        const placed = placementsOf(
          device ? doc.blocks?.find((u) => u.name === device)?.nodes : doc.nodes,
        )!;
        const held = Object.fromEntries(placed.map((n) => [n.g, hold]));
        const levels = Object.fromEntries(
          Object.entries(doc.levels ?? {}).filter(([w]) => placed.some((n) => n.g === w)),
        );
        expect([file, node, levels]).toEqual([file, node, held]);
      }
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

  it('a held current balance balances where the design is held, not only where it is sized', () => {
    // The two inverter sheets type their bias current into the NMOS and hand it to the PMOS, which
    // also takes the gate voltage the supply leaves above the input. At the design point the
    // balance reads zero by construction. Held on a second characterization — half the current
    // and half the transconductance at every gate voltage — each device keeps its width, the PMOS
    // keeps that gate voltage, and the bias current is solved again: the two devices carry one
    // current and their two gate-source voltages still add up to the supply.
    const at = (t: DeviceTable, corner: string, temp: number): DeviceTable => ({
      ...t,
      id: { ...t.id, corner, temp },
    });
    const weak = scaleQuantities(table, { id: 0.5, gm: 0.5 });
    const [device] = groupDevices([at(table, 'tt', 27), at(weak, 'ss', -40)]);
    const tt = { corner: 'tt', temp: 27 };
    for (const file of ['otas/inverter-based-ota.json', 'stages/cmos-inverter-amp.json']) {
      const doc = sheet(file);
      const [sized, held] = runConditions(
        doc,
        device,
        [tt, { corner: 'ss', temp: -40 }],
        () => undefined,
        REFS,
        tt,
      );
      expect([file, sized.state, held.state]).toEqual([file, 'evaluated', 'evaluated']);
      if (sized.state !== 'evaluated' || held.state !== 'evaluated') continue;
      const [s, h] = [sized.result, held.result];
      const dev = (r: SheetResult, name: string): SizingReport =>
        r.blocks!.find((c) => c.name === name)!.sizing!;
      for (const name of ['n', 'p'])
        expect([file, name, dev(h, name).W]).toEqual([file, name, dev(s, name).W]);
      expect([file, relErr(dev(h, 'n').id, dev(h, 'p').id) < 1e-5]).toEqual([file, true]);
      expect([file, dev(h, 'n').vgs + Math.abs(dev(h, 'p').vgs)]).toEqual([
        file,
        expect.closeTo(1.8, 9),
      ]);
      // The current did move: on the weaker characterization the same gate voltages carry less.
      expect([file, h.values.I_bias < s.values.I_bias]).toEqual([file, true]);
      expect([file, relErr(h.values.I_bias, dev(h, 'n').id) < 1e-5]).toEqual([file, true]);
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

  it('every example target says what it is an example of', () => {
    // A parameter named `*_target` is a spec the sheet ships with so that it evaluates: a value
    // plausible for the circuit's application class, which the designer replaces with their own.
    // Its note says what the number is plausible for, so a shipped default is not mistaken for a
    // requirement the library imposes. The walk reads each file as authored, inline children
    // included.
    let seen = 0;
    const bare: string[] = [];
    for (const { file, doc } of LIBRARY) {
      walkDocs(doc, file, (d, path) => {
        for (const p of d.params) {
          if (!p.name.endsWith('_target')) continue;
          seen++;
          if (!p.note?.trim()) bare.push(`${path}: ${p.name}`);
        }
      });
    }
    expect(seen).toBeGreaterThan(0);
    expect(bare).toEqual([]);
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

    // No curated sheet types one current into several devices.
    const found = RESOLVED.map(({ file, doc }) => ({ file, typed: programs(doc) })).filter(
      ({ typed }) => typed.length > 0,
    );
    expect(found.map(({ file, typed }) => `${file}: ${typed.join('; ')}`)).toEqual([]);
    // Not vacuous: the walk does see a current typed into two devices, and it sees one read from
    // another block's output as the circuit's, not the author's. A sheet whose tail current is
    // typed into the tail device and, halved, into the pair is caught, by name.
    const typedTwice: SheetDoc = {
      title: 'typed twice',
      polarity: 'n',
      params: [{ name: 'I_tail', value: 20e-6, unit: 'A', role: 'choice' }],
      blocks: [
        {
          name: 'tail',
          doc: {
            title: 'tail',
            polarity: 'n',
            params: [{ name: 'I', value: 20e-6, unit: 'A', role: 'spec' }],
            givens: { L: '0.5e-6', id: 'I', gm_id: '10', vds: '0.3' },
            equations: [],
            checks: [],
            provides: ['id'],
          },
          params: { I: 'I_tail' },
        },
        {
          name: 'in',
          doc: {
            title: 'in',
            polarity: 'n',
            params: [{ name: 'I', value: 10e-6, unit: 'A', role: 'spec' }],
            givens: { L: '0.5e-6', id: 'I', gm_id: '12', vds: '0.5' },
            equations: [],
            checks: [],
            provides: ['id'],
          },
          params: { I: 'I_tail/2' },
        },
      ],
      equations: [],
      checks: [],
    };
    expect(programs(typedTwice)).toEqual(['I_tail into tail, in']);
    const handedOn: SheetDoc = {
      ...typedTwice,
      blocks: typedTwice.blocks!.map((u) =>
        u.name === 'in' ? { ...u, params: { I: 'tail__id/2' } } : u,
      ),
    };
    expect(programs(handedOn)).toEqual([]);
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
  'mirrors-bias/nmos-bias-reference.json': ['W', 'vgs', 'id'],
  'mirrors-bias/nmos-cascode-bias.json': ['V_c', 'W', 'vgs', 'id'],
  'mirrors-bias/nmos-mirror-output.json': ['id', 'gds', 'W'],
  'mirrors-bias/pmos-bias-diode.json': ['V_b', 'W', 'vgs', 'id'],
  'mirrors-bias/pmos-bias-reference.json': ['V_b', 'W', 'vgs', 'id'],
  'mirrors-bias/pmos-cascode-bias.json': ['V_c', 'W', 'vgs', 'id'],
  'multistage/rail-to-rail-input-stage.json': ['gm_min', 'gm_mid', 'gm_max'],
  'multistage/stage2-current-source-load.json': ['id', 'gds'],
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

// Every NMOS mirror tree in the library starts from the same reference: a diode-connected device
// carrying its programmed current from an ideal source. It is drawn once, as a library sheet of its
// own, and composed by reference, so no parent carries a copy of it or a current source for it.
describe('sheet library: the NMOS bias reference is drawn once', () => {
  const CHILD = 'mirrors-bias/nmos-bias-reference';
  // Written down from the schematics, not read off the sheets: each sheet built on an NMOS
  // reference, the block that holds it, the wire its source draws from, and its gate wire.
  const USERS: Record<string, [string, string, string]> = {
    'mirrors-bias/matched-mirror-bank.json': ['unit', 'vsup', 'nref'],
    'mirrors-bias/simple-mirror.json': ['ref', 'vsup', 'nref'],
    'mirrors-bias/widlar-current-source.json': ['ref', 'vsup', 'ngate'],
    'multistage/fd-telescopic-ota.json': ['bias', 'vdd', 'vbn'],
    'multistage/fd-two-stage-ota.json': ['bias', 'vdd', 'vbn'],
    'multistage/two-stage-cascode-comp-ota.json': ['bias', 'vdd', 'vbn'],
    'multistage/two-stage-miller-ota.json': ['bias', 'vdd', 'vbn'],
    'otas/current-mirror-ota.json': ['bias', 'vdd', 'vbn'],
    'otas/degenerated-differential-pair.json': ['bias', 'vdd', 'vbn'],
    'otas/differential-pair-tail.json': ['bias', 'vdd', 'vbn'],
    'otas/five-transistor-ota.json': ['bias', 'vdd', 'vbn'],
    'otas/folded-cascode-ota.json': ['bias', 'vdd', 'vbn'],
    'otas/gain-boosted-cascode-ota.json': ['bias', 'vdd', 'vbn'],
    'otas/telescopic-cascode-ota.json': ['bias', 'vdd', 'vbn'],
  };

  // The same diode at a low inversion level is the simplest cascode gate bias, one strong-inversion
  // gate-source voltage above ground; these sheets also compose it for that, each with a current of
  // its own: the block, its supply wire and the cascode gate wire.
  const CASCODE_BIAS: Record<string, [string, string, string]> = {
    'mirrors-bias/wide-swing-cascode-mirror.json': ['cb', 'vdd', 'vbias'],
    'otas/folded-cascode-ota.json': ['cbn', 'vdd', 'vcn'],
    'stages/cascode-cs-amp.json': ['cb', 'vdd', 'vcasc'],
  };

  it('every OTA bias and every NMOS mirror reference is a reference to the one child', () => {
    const found: Record<string, [string, string, string][]> = {};
    for (const { file, doc } of LIBRARY)
      for (const b of doc.blocks ?? [])
        if (b.ref === CHILD)
          (found[file] ??= []).push([b.name, b.ports?.vdd ?? '', b.ports?.vb ?? '']);
    const expected: Record<string, [string, string, string][]> = {};
    for (const [file, use] of [...Object.entries(USERS), ...Object.entries(CASCODE_BIAS)])
      (expected[file] ??= []).push(use);
    for (const uses of Object.values(expected)) uses.sort();
    for (const uses of Object.values(found)) uses.sort();
    expect(found).toEqual(expected);
    // Every amplifier with a bias block is among them: the eleven OTAs.
    const amps = LIBRARY.filter(
      ({ file, doc }) =>
        /^(otas|multistage)\//.test(file) && doc.blocks?.some((b) => b.name === 'bias'),
    ).map(({ file }) => file);
    expect(amps).toHaveLength(11);
    expect(amps.every((f) => f in USERS)).toBe(true);
    for (const [file, [name]] of [...Object.entries(USERS), ...Object.entries(CASCODE_BIAS)]) {
      const doc = LIBRARY.find((s) => s.file === file)!.doc;
      const b = doc.blocks!.find((u) => u.name === name)!;
      // A reference, not a copy: no embedded document, the parent's current, length and inversion
      // passed in, both ports wired. The source of the programmed current lives in the child, so
      // the parent draws no current source of its own.
      expect([file, b.doc, Object.keys(b.params ?? {}).sort()]).toEqual([
        file,
        undefined,
        ['I_ref', 'L_ref', 'gm_id_ref'],
      ]);
      if (file in USERS)
        expect([file, (doc.elements ?? []).filter((e) => e.kind === 'I')]).toEqual([file, []]);
    }
  });

  it('alone, it is a diode at its programmed current with its source drawn', () => {
    // Defaults: 20 µA at gm/ID 10, L 0.5 µm. The current is the given, exactly; the drain is the
    // gate, so the device sits at vgs(10) = 0.610063 V, read along the vds = vgs diagonal.
    const doc = sheet(`${CHILD}.json`);
    const res = runSheet(doc, table);
    expect(res.feasible).toBe(true);
    expect(res.values.id).toBe(20e-6);
    expect(relErr(res.values.gm, 10 * 20e-6)).toBeLessThan(1e-9);
    expect(relErr(res.values.vgs, VGS_GMID10_L05)).toBeLessThan(1e-3);
    expect(doc.nodes).toEqual({ d: 'vb', g: 'vb', s: 'gnd', b: 'gnd' });
    expect(doc.elements).toEqual([
      { name: 'iref', kind: 'I', between: ['vdd', 'vb'], value: 'I_ref' },
    ]);
    expect(doc.ports).toEqual(['vdd', 'vb']);
    expect(res.nodes!.state).toBe('checked-clean');
  });

  it('each parent reads exactly what the inline copy it replaced gave', () => {
    // Rebuild the copy each parent used to carry — the same diode embedded in the earlier format
    // with `diode: true`, wired by the parent's own nodes, its programmed current a current source
    // of the parent's — and run both. Every value the copy produced, every check and every range
    // end comes out the same to the last bit; the reference adds its current to the interface.
    const child = sheet(`${CHILD}.json`);
    const inline = (doc: SheetDoc, name: string): SheetDoc => {
      const b = doc.blocks!.find((u) => u.name === name)!;
      const { vdd, vb } = b.ports as Record<string, string>;
      const copy = {
        title: child.title,
        polarity: child.polarity,
        params: child.params.map(({ name: n, value, unit, role }) => ({
          name: n,
          value,
          unit,
          role,
        })),
        givens: { ...child.givens!, diode: true },
        equations: [],
        checks: child.checks,
        provides: ['W', 'vgs'],
      };
      return {
        ...doc,
        blocks: doc.blocks!.map((u) =>
          u.name === name
            ? { name, doc: copy, params: b.params, nodes: { d: vb, g: vb, s: 'gnd', b: 'gnd' } }
            : u,
        ),
        elements: [
          ...(doc.elements ?? []),
          { name: 'iref', kind: 'I', between: [vdd, vb], value: b.params!.I_ref },
        ],
      };
    };
    const mismatched: string[] = [];
    for (const [file, [name]] of Object.entries(USERS)) {
      const { doc, res } = EVALUATED.find((s) => s.file === file)!;
      const was = runSheet(inline(doc, name), table, undefined, REFS);
      const now = res!;
      for (const [k, x] of Object.entries(was.values))
        if (now.values[k] !== x) mismatched.push(`${file}: ${k}`);
      const extra = Object.keys(now.values).filter((k) => !(k in was.values));
      if (extra.join() !== `${name}__id`) mismatched.push(`${file}: adds ${extra.join(', ')}`);
      const outcome = (r: SheetResult) => ({
        feasible: r.feasible,
        complies: r.complies,
        checks: r.checks.map((c) => [c.id, c.status, c.margin]),
        warnings: r.warnings.map((w) => w.message),
        ends: (r.rangeEnds ?? []).map((e) => [e.name, e.state, e.solved]),
        nodes: r.nodes?.state,
      });
      if (JSON.stringify(outcome(now)) !== JSON.stringify(outcome(was)))
        mismatched.push(`${file}: outcome`);
    }
    expect(mismatched).toEqual([]);
  });
});

// A cascode's gate is a bias line, and the sheets that use one draw the branch that sets it: a
// diode at a low inversion level carrying a programmed current, or a stacked replica — a diode on
// the rail whose drop places the node under the cascode, with a device at the cascode's inversion
// level stacked on it. Each is a library sheet of its own, composed by reference with its supply
// and its gate wire mapped, and the node under the cascode is solved under the level the branch
// publishes. Where the design is held — a range end, another process condition — the branch is held
// at its widths and carries its programmed current, so the gate moves with the devices, as a real
// bias line does, and no hold stands in for one.
describe('sheet library: the cascode bias lines are drawn', () => {
  const CHILDREN = 'mirrors-bias';
  const alone = (name: string) => {
    const doc = sheet(`${CHILDREN}/${name}.json`);
    return { doc, res: runSheet(doc, table) };
  };

  it('the NMOS cascode bias alone is a diode with a device at the cascode level stacked on it', () => {
    // Defaults: 5 µA, the bottom diode at gm/ID 16 and the top device at 12, both 0.5 µm. The
    // bottom diode sits at vgs(16) along the diagonal; the top device stands on it, so it needs
    // vgs(12) plus BODY_FACTOR times that drop; the gate wire is the sum.
    const { doc, res } = alone('nmos-cascode-bias');
    const base = vgsAtGmId(16);
    const top = vgsAtGmId(12) + BODY_FACTOR * base;
    expect(res.feasible).toBe(true);
    expect(relErr(res.values.base__vgs, base)).toBeLessThan(1e-3);
    expect(res.sizing!.bias!.vsb).toBe(res.values.base__vgs);
    expect(relErr(res.values.vgs, top)).toBeLessThan(1e-3);
    expect(res.values.V_c).toBe(res.values.base__vgs + res.values.vgs);
    expect(relErr(res.values.V_c, base + top)).toBeLessThan(1e-3);
    // One programmed current, carried by both: the top device reads the bottom diode's.
    expect(res.values.base__id).toBe(5e-6);
    expect(res.values.id).toBe(res.values.base__id);
    expect(relErr(res.values.gm, 12 * 5e-6)).toBeLessThan(1e-9);
    expect(res.checks.find((c) => c.id === 'stack-fits')!.status).toBe('pass');
    expect(doc.nodes).toEqual({ d: 'vc', g: 'vc', s: 'm', b: 'gnd' });
    expect(doc.elements).toEqual([
      { name: 'icb', kind: 'I', between: ['vdd', 'vc'], value: 'I_cb' },
    ]);
    expect(doc.ports).toEqual(['vdd', 'vc']);
    expect(res.nodes!.state).toBe('checked-clean');
  });

  it('the PMOS cascode bias alone is its mirror image, hanging from the supply', () => {
    // Defaults: 5 µA, both devices at gm/ID 18 and 0.5 µm. The gate wire sits the top diode's drop
    // and the bottom device's gate-source voltage, body effect included, below the supply. The
    // demo table serves both polarities, so the drops are the NMOS closed forms.
    const { doc, res } = alone('pmos-cascode-bias');
    const base = vgsAtGmId(18);
    const bottom = base + BODY_FACTOR * base;
    expect(res.feasible).toBe(true);
    expect(res.sizing!.bias!.vsb).toBe(Math.abs(res.values.base__vgs));
    expect(relErr(res.values.V_c, 1.8 - base - bottom)).toBeLessThan(1e-3);
    expect(res.values.id).toBe(5e-6);
    expect(res.checks.find((c) => c.id === 'stack-fits')!.status).toBe('pass');
    expect(doc.nodes).toEqual({ d: 'vc', g: 'vc', s: 'm', b: 'vdd' });
    expect(doc.elements).toEqual([
      { name: 'icb', kind: 'I', between: ['vc', 'gnd'], value: 'I_cb' },
    ]);
    expect(res.nodes!.state).toBe('checked-clean');
    // Two diode drops that do not fit between the rails are refused by the check, not reported as
    // a gate wire below ground: under a 0.9 V supply the two drops come to over a volt.
    const deep = runSheet(withParams(doc, { VDD: 0.9 }), table);
    expect(deep.values.V_c).toBeLessThan(0);
    expect(deep.checks.find((c) => c.id === 'stack-fits')!.status).toBe('fail');
    expect(deep.feasible).toBe(false);
  });

  it('the PMOS bias reference alone is a diode at its programmed current, one drop below the supply', () => {
    const { doc, res } = alone('pmos-bias-reference');
    expect(res.feasible).toBe(true);
    expect(res.values.id).toBe(20e-6);
    expect(relErr(res.values.gm, 10 * 20e-6)).toBeLessThan(1e-9);
    expect(relErr(res.values.V_b, 1.8 - VGS_GMID10_L05)).toBeLessThan(1e-3);
    expect(res.values.V_b).toBe(1.8 - Math.abs(res.values.vgs));
    expect(doc.nodes).toEqual({ d: 'vb', g: 'vb', s: 'vdd', b: 'vdd' });
    expect(doc.elements).toEqual([
      { name: 'iref', kind: 'I', between: ['vb', 'gnd'], value: 'I_ref' },
    ]);
    expect(doc.ports).toEqual(['vdd', 'vb']);
    expect(res.nodes!.state).toBe('checked-clean');
  });

  it('the PMOS bias diode alone carries the current it is handed, and draws no source of its own', () => {
    const { doc, res } = alone('pmos-bias-diode');
    expect(res.feasible).toBe(true);
    expect(res.values.id).toBe(20e-6);
    expect(relErr(res.values.V_b, 1.8 - VGS_GMID10_L05)).toBeLessThan(1e-3);
    expect(doc.elements).toBeUndefined();
    expect(doc.ports).toEqual(['vdd', 'vb']);
    expect(res.nodes!.state).toBe('checked-clean');
  });

  it('the NMOS mirror output alone copies its reference at its own drain voltage', () => {
    // Handed the NMOS bias reference's width and gate-source voltage at twice the width, with its
    // drain at 0.9 V: it carries twice the reference's 20 µA, scaled by (VA + 0.9)/(VA + vgs), the
    // reference's drain being its own gate. Its gm/ID is the reference's, which the demo model
    // does not move with the drain voltage, and its gds is its current over VA plus that voltage.
    const ref = runSheet(sheet('mirrors-bias/nmos-bias-reference.json'), table);
    const { doc } = alone('nmos-mirror-output');
    const res = runSheet(
      withParams(doc, { K: 2, W_ref: ref.values.W, vgs_ref: ref.values.vgs, vds: 0.9 }),
      table,
    );
    const VA = VA_PER_L * 0.5e-6;
    expect(res.feasible).toBe(true);
    expect(res.values.W).toBe(2 * ref.values.W);
    expect(relErr(res.values.id, (2 * 20e-6 * (VA + 0.9)) / (VA + ref.values.vgs))).toBeLessThan(
      1e-4,
    );
    expect(relErr(res.values.gds, gdsOf(res.values.id, 0.5e-6, 0.9))).toBeLessThan(1e-9);
    const region = res.checks.find((c) => c.id === 'region')!;
    expect([region.status, region.lhsValue]).toEqual(['pass', 0.9]);
    expect(doc.ports).toEqual(['out', 'vb']);
    expect(doc.levels).toBeUndefined();
  });

  // Written down from the schematics: per sheet, each bias branch, the child port that is its gate
  // wire, the parent wire that port is mapped to, the level the branch publishes for it, and the
  // nodes the sheet solves under that gate (or, for the derived PMOS bias line, solves to it).
  const DRIVEN: Record<string, [string, string, string, string, string[]][]> = {
    'mirrors-bias/wide-swing-cascode-mirror.json': [['cb', 'vb', 'vbias', 'cb__vgs', ['vds_lo']]],
    'multistage/fd-telescopic-ota.json': [
      ['cbn', 'vc', 'vcn', 'cbn__V_c', ['V_a']],
      ['cbp', 'vc', 'vcp', 'cbp__V_c', ['V_b']],
    ],
    'otas/folded-cascode-ota.json': [
      ['cbn', 'vb', 'vcn', 'cbn__vgs', ['V_c', 'V_c_r']],
      ['cbp', 'vb', 'vcp', 'cbp__V_b', ['V_fold', 'V_fold_r']],
      ['pbias', 'vb', 'vbp', 'pbias__V_b', ['V_bp']],
    ],
    'otas/gain-boosted-cascode-ota.json': [
      ['cbn', 'vc', 'vgnr', 'cbn__V_c', ['V_ar']],
      ['cbp', 'vb', 'vgpr', 'cbp__V_b', ['V_br']],
    ],
    'otas/telescopic-cascode-ota.json': [
      ['cbn', 'vc', 'vcn', 'cbn__V_c', ['V_a', 'V_ar']],
      ['cbp', 'vb', 'vcp', 'cbp__V_b', ['V_b', 'V_br']],
    ],
    'stages/cascode-cs-amp.json': [['cb', 'vb', 'vcasc', 'cb__vgs', ['V_x']]],
  };

  it('each gate a bias branch drives sits at the level the branch publishes, and nothing holds it', () => {
    for (const [file, branches] of Object.entries(DRIVEN)) {
      const { doc, res } = EVALUATED.find((s) => s.file === file)!;
      // No hold is left on the sheet, and no gate wire a branch drives is held or left a port.
      expect([file, doc.params.filter((p) => p.hold !== undefined).map((p) => p.name)]).toEqual([
        file,
        [],
      ]);
      expect([file, res!.held]).toEqual([file, undefined]);
      for (const [name, port, wire, level, nodes] of branches) {
        const b = doc.blocks!.find((u) => u.name === name)!;
        expect([file, name, b.ports?.[port]]).toEqual([file, name, wire]);
        expect([file, wire, wire in (doc.levels ?? {}), (doc.ports ?? []).includes(wire)]).toEqual([
          file,
          wire,
          false,
          false,
        ]);
        // The wiring walk derives the wire along its own tree — through the branch's devices, or
        // through a cascode on the gate and the solved node under it — and lands on the level the
        // branch publishes, to the solve's tolerance (a part in a million of the node's range).
        const walked = res!.nodes!.levels[wire]?.level;
        expect([file, wire, Math.abs(walked - res!.values[level]) < 1e-6]).toEqual([
          file,
          wire,
          true,
        ]);
        // Each node under the gate is solved under exactly that level.
        for (const node of nodes) {
          const p = doc.params.find((q) => q.name === node)!;
          expect([file, node, p.designConstraint?.rhs ?? p.solveFor]).toEqual([file, node, level]);
        }
      }
    }
  });

  it('held at another condition, no gate is held and no warning says one stood in for a bias line', () => {
    // A second characterization, 0.8 of the current and of the transconductance at every gate
    // voltage, with the design held at its widths: the bias branches carry their programmed
    // currents there too, so their gates move, and the nodes under them are solved again.
    const at = (t: DeviceTable, corner: string, temp: number): DeviceTable => ({
      ...t,
      id: { ...t.id, corner, temp },
    });
    const weak = scaleQuantities(table, { id: 0.8, gm: 0.8 });
    const [device] = groupDevices([at(table, 'tt', 27), at(weak, 'ss', -40)]);
    const tt = { corner: 'tt', temp: 27 };
    for (const file of Object.keys(DRIVEN)) {
      const [sized, held] = runConditions(
        sheet(file),
        device,
        [tt, { corner: 'ss', temp: -40 }],
        () => undefined,
        REFS,
        tt,
      );
      expect([file, sized.state, held.state]).toEqual([file, 'evaluated', 'evaluated']);
      if (held.state !== 'evaluated') continue;
      const warned = [held.result.warnings, ...(held.result.rangeEnds ?? []).map((e) => e.warnings)]
        .flat()
        .filter((w) => w.rule === 'sheet-held-gate');
      expect([file, warned]).toEqual([file, []]);
      expect([file, held.result.solve?.kind]).toEqual([file, 'settled']);
    }
  });
});

describe('exemplar goldens: CS amp, current-source load', () => {
  const res = runSheet(sheet('stages/cs-amp-current-source-load.json'), table);
  // Defaults: GBW 10 MHz into 2 pF with a 1.25 over-design factor, gm/ID 12,
  // load gm/ID 8, both L = 0.5 µm, V_out = 0.9 V.
  const gm = 2 * Math.PI * 10e6 * 2e-12 * 1.25;
  const sizingOf = (name: string) => res.blocks?.find((b) => b.name === name)?.sizing;

  it('sizes the input device exactly from the spec', () => {
    expect(sizingOf('in')?.ok).toBe(true);
    expect(relErr(res.values.in__gm, gm)).toBeLessThan(1e-9);
    expect(relErr(res.values.in__id, gm / 12)).toBeLessThan(1e-9);
    expect(sizingOf('in')?.bias?.vds).toBe(0.9);
    // The load is given the current the input device landed on, not a second copy of its formula,
    // so the branch current is typed once.
    expect(sizingOf('load')?.id).toBe(res.values.in__id);
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
    expect(relErr(res.values.cgg_in, cggOf(sizingOf('in')?.W ?? NaN, 0.5e-6))).toBeLessThan(1e-9);
  });

  it('is feasible at defaults on the demo device', () => {
    expect(res.feasible).toBe(true);
  });
});

describe('exemplar goldens: simple current mirror', () => {
  const res = runSheet(sheet('mirrors-bias/simple-mirror.json'), table, undefined, REFS);
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
  const res = runSheet(doc, table, undefined, REFS);
  // Defaults: the bias reference programmed to I_tail = 20 µA, CL 2 pF, reference gm/ID 10,
  // input gm/ID 12, load gm/ID 8, all L 0.5 µm, VDD 1.8 V, common mode 1.1 V, output at 0.9 V.
  const I_TAIL = 20e-6;
  const CL = 2e-12;
  const L = 0.5e-6;
  const va = VA_PER_L * L;
  /** One block's sizing report, by block name. */
  const block = (r: SheetResult, name: string): SizingReport =>
    r.blocks!.find((c) => c.name === name)!.sizing!;

  // The sheet is drawn at rest: the output is held at V_out_dc by feedback outside the sheet, and
  // the two inputs sit apart by whatever that takes. Only the reference's current is typed; every
  // other one is what the demo model gives. There id ∝ (VA + vds) at fixed vgs and W, so a 1:1
  // mirror delivers its reference current times (VA + vds_out)/(VA + vds_ref), a diode-connected
  // reference has vds_ref equal to its own vgs, and the model's gm/ID does not move with vds.
  //
  // The output node's current law fixes the split. The load's diode side carries the diode-side
  // pair transistor's current I_r, and its output side returns that times
  //   load mirror  rL = (2.5 + 0.9)/(2.5 + 0.668042) = 1.073218   (diode side at vgs(8), output
  //                                                                side at VDD − V_out_dc)
  // which the output-side pair transistor has to take: I_o = rL·I_r. With I_o + I_r the tail's
  // current, the output side takes rL/(1 + rL) = 51.77 % of it, whatever the tail delivers.
  //
  // The two pair transistors are one width on one source, so they carry those currents at
  // different gate-source voltages: the output-side one is sized for gm/ID 12, so it sits at
  // vgs(12) plus the body effect, and its partner carries 1/rL of its current at its own drain,
  // one vgs(8) below the supply where the output-side drain is the output. The model's current law
  // gives its gate-source voltage (vgsForCurrentRatio), and the difference is the offset. The
  // common mode is the tail node plus the mean of the two, so the tail node is a short fixed point:
  //   tail node    V_tail = (CM_dc − vgs(12) − Δ/2)/1.2 = 0.449097 V,  Δ = −11.880 mV
  //   tail mirror  (2.5 + 0.449097)/(2.5 + 0.610063) = 0.948244   (reference at vgs(10))
  //   tail         20 µA × 0.948244                  = 18.965 µA
  //   pair, output side   18.965 µA × 0.517658       =  9.817 µA
  //   pair, diode side    18.965 µA × 0.482342       =  9.148 µA   (also the load's diode side)
  const rL = (va + (1.8 - 0.9)) / (va + VGS_GMID8_L05);
  const share = rL / (1 + rL);
  /** The resting state for an output level `vOut`, from the closed forms above. */
  const atRest = (vOut: number) => {
    const rLoad = (va + (1.8 - vOut)) / (va + VGS_GMID8_L05);
    let vTail = sourceNodeUnder(1.1, VGS_GMID12_L05);
    let delta = 0;
    for (let i = 0; i < 20; i++) {
      const vdsO = vOut - vTail;
      const vdsR = 1.8 - VGS_GMID8_L05 - vTail;
      const ratio = ((1 / rLoad) * (va + vdsO)) / (va + vdsR);
      delta = vgsForCurrentRatio(VGS_GMID12_L05, ratio) - VGS_GMID12_L05;
      vTail = sourceNodeUnder(1.1 - delta / 2, VGS_GMID12_L05);
    }
    const iTail = (I_TAIL * (va + vTail)) / (va + VGS_GMID10_L05);
    const iOut = (iTail * rLoad) / (1 + rLoad);
    const iDiode = iTail - iOut;
    const gmOut = 12 * iOut;
    const gmDiode = gmIdDemo(VGS_GMID12_L05 + delta) * iDiode;
    return {
      rLoad,
      vTail,
      delta,
      iTail,
      iOut,
      iDiode,
      gmOut,
      gmDiode,
      // The diode side's half through the load mirror, whose current gain is its output
      // device's gm over its diode device's: on one gate at one width, gm scales with
      // (VA + vds) exactly as id does, so that gain is rLoad. The output side's half direct.
      gmPair: (gmDiode * rLoad + gmOut) / 2,
      vdsOut: vOut - vTail,
      vdsDiode: 1.8 - VGS_GMID8_L05 - vTail,
    };
  };
  const rest = atRest(0.9);
  const { vTail, iTail, iOut, iDiode, gmPair } = rest;

  it('the tail node carries one current and each mirror is one gate wire', () => {
    // Only the reference is handed the programmed number. The pair's two transistors are handed
    // the two shares of what the tail delivers, which add up to it, and the load's diode side the
    // diode-side transistor's.
    expect(block(res, 'bias').id).toBe(I_TAIL);
    const { tail__id, in__id, inr__id } = res.values;
    expect(relErr(in__id + inr__id, tail__id)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'ldr').id, inr__id)).toBeLessThan(1e-12);
    // A 1:1 mirror is the same width on the same gate. The width is passed through untouched;
    // the gate voltage is reported as the table's own vgs coordinate at the point it was read,
    // so two devices on one wire agree to rounding rather than always to the last bit.
    expect(block(res, 'tail').W).toBe(block(res, 'bias').W);
    expect(block(res, 'ld').W).toBe(block(res, 'ldr').W);
    expect(relErr(block(res, 'tail').vgs, block(res, 'bias').vgs)).toBeLessThan(1e-12);
    expect(relErr(block(res, 'ld').vgs, block(res, 'ldr').vgs)).toBeLessThan(1e-12);
  });

  it('the split is solved so the currents at the output node balance', () => {
    // What the output-side pair transistor takes is what the mirror's output side returns, to the
    // solve's tolerance: the current law at the output, which the feedback holding the output
    // enforces in the circuit.
    expect(relErr(res.values.in__id, res.values.ld__id)).toBeLessThan(1e-6);
    const constraint = doc.params.find((p) => p.name === 'out_share')?.designConstraint;
    expect(constraint).toEqual({ lhs: 'in__id', rhs: 'ld__id' });
    // The share is the load mirror's ratio, rL/(1 + rL), compared as its distance from one half,
    // 0.017658 — the part the drains decide.
    expect(relErr(res.values.out_share - 0.5, share - 0.5)).toBeLessThan(1e-2);
    expect(relErr(res.values.in__id, iOut)).toBeLessThan(1e-3);
    expect(relErr(res.values.inr__id, iDiode)).toBeLessThan(1e-3);
    // The stored value is never read: from 0.3 or from 0.7 the split lands exactly where it does
    // from one half.
    for (const stored of [0.3, 0.7]) {
      const from = runSheet(withParams(doc, { out_share: stored }), table, undefined, REFS);
      expect(from.values.out_share).toBe(res.values.out_share);
      expect(from.values.in__W).toBe(res.values.in__W);
    }
  });

  it('the pair is two transistors of one width, each carrying its own current at its own drain', () => {
    // The output-side transistor is sized for its inversion level; its partner copies its width,
    // untouched, and is handed the rest of the tail current — a width-and-current sizing.
    expect(block(res, 'inr').W).toBe(block(res, 'in').W);
    expect(doc.blocks!.find((u) => u.name === 'inr')!.doc!.givens).toMatchObject({
      W: 'W_i',
      id: 'I_side',
    });
    // Both sources are the tail node, so both bodies see it. The drains are not one node: the
    // output-side drain is the output, and the diode-side drain is the load's diode node, read
    // off the load device the run sized.
    const node = res.values.V_tail;
    expect(block(res, 'in').bias?.vsb).toBe(node);
    expect(block(res, 'inr').bias?.vsb).toBe(node);
    expect(block(res, 'in').bias?.vds).toBeCloseTo(0.9 - node, 12);
    expect(block(res, 'inr').bias?.vds).toBeCloseTo(1.8 - block(res, 'ldr').vgs - node, 12);
    // Where the model puts them: 0.451 V and 0.683 V. 1e-3 of either is under a millivolt.
    expect(relErr(block(res, 'in').bias!.vds, rest.vdsOut)).toBeLessThan(1e-3);
    expect(relErr(block(res, 'inr').bias!.vds, rest.vdsDiode)).toBeLessThan(1e-3);
    expect(relErr(node, vTail)).toBeLessThan(1e-3);
  });

  it('each mirror misses its reference by the drain-voltage ratio of the demo model', () => {
    // The tail node (0.449 V) sits below the reference's diode drop (0.610 V), so the tail
    // under-delivers by 1 − 0.948244 = 5.18 %. The output sits 0.9 V below the supply, further
    // than the load's diode drop (0.668 V), so the output side returns 7.32 % more than its
    // diode side carries. Compared as errors, the way the mirror golden above compares its own:
    // 1e-2 of them is 1.7 mV and 2.3 mV of drain-voltage difference.
    const tailErr = 1 - res.values.tail__id / I_TAIL;
    const loadErr = res.values.ld__id / block(res, 'ldr').id - 1;
    expect(relErr(tailErr, 1 - iTail / I_TAIL)).toBeLessThan(1e-2);
    expect(relErr(loadErr, rL - 1)).toBeLessThan(1e-2);
  });

  it('systematic offset is the difference of the two gate-source voltages at rest', () => {
    // The diode-side transistor carries 1/rL of its partner's current at a drain 232 mV higher;
    // in the model that takes 11.88 mV less gate-source voltage. The row reads the difference
    // directly — nothing estimated, no transconductance to divide by.
    const { in__vgs, inr__vgs } = res.values;
    expect(res.values.vos_sys).toBe(Math.abs(inr__vgs - in__vgs));
    expect(inr__vgs).toBeLessThan(in__vgs);
    expect(relErr(res.values.vos_sys, -rest.delta)).toBeLessThan(2e-3);
    // Two differences are in it and they add. The mirror's alone, with the pair's drains at one
    // voltage, is the 1/rL current ratio: 5.81 mV. The diode-side drain sitting 232 mV higher
    // gives its transistor more current at a given gate drive, which it has to shed too. A row
    // that counted only the mirror would read about half the offset.
    const mirrorAlone = vgsForCurrentRatio(VGS_GMID12_L05, 1 / rL) - VGS_GMID12_L05;
    expect(Math.abs(mirrorAlone)).toBeLessThan(0.55 * res.values.vos_sys);
    expect(Math.abs(mirrorAlone)).toBeGreaterThan(0.45 * res.values.vos_sys);
  });

  it('the offset vanishes and the split is even when the output sits one load vgs below the supply', () => {
    // There the output is the load's diode node: the pair's two drains are one voltage and so
    // are the mirror's, so neither pair of devices has anything to differ by. What is left is the
    // table's own resolution: the tied devices are read between drain-voltage nodes and their
    // partners on a node or along the diode diagonal.
    const level = runSheet(
      withParams(doc, { V_out_dc: 1.8 - VGS_GMID8_L05 }),
      table,
      undefined,
      REFS,
    );
    expect(Math.abs(level.values.vos_sys)).toBeLessThan(1e-2 * res.values.vos_sys);
    expect(Math.abs(level.values.out_share - 0.5)).toBeLessThan(
      1e-2 * Math.abs(res.values.out_share - 0.5),
    );
    // Past that level both differences change sign together, so they still add, the output side
    // takes the smaller share, and the diode-side transistor needs the larger gate-source voltage.
    // At 1.3 V the output is 0.168 V above the diode node; the model gives
    //   mirror  (2.5 + 0.5)/(2.5 + 0.668042) = 0.946957, so the output side takes 48.64 %
    // and the offset is 9.0 mV the other way.
    const above = runSheet(withParams(doc, { V_out_dc: 1.3 }), table, undefined, REFS);
    const restAbove = atRest(1.3);
    expect(above.values.out_share).toBeLessThan(0.5);
    expect(
      relErr(above.values.out_share - 0.5, restAbove.rLoad / (1 + restAbove.rLoad) - 0.5),
    ).toBeLessThan(1e-2);
    expect(above.values.inr__vgs).toBeGreaterThan(above.values.in__vgs);
    expect(relErr(above.values.vos_sys, restAbove.delta)).toBeLessThan(3e-3);
  });

  it('the pair transconductance takes the diode side’s half through the mirror, as the Miller OTA does', () => {
    // Each pair transistor turns half the differential input into current: the diode side's half
    // reaches the output through the load mirror at its current gain gm_ld/gm_ldr, the output
    // side's half directly. The output-side transistor carries 9.817 µA at gm/ID 12; its partner
    // 9.148 µA at the slightly weaker inversion its lower gate drive gives, gm/ID 12.64 in the
    // model; and the mirror's output side, 0.232 V further from the supply, has rL = 1.073 times
    // its diode side's gm. So gm_pair = (12.64 × 9.148 µA × 1.073 + 12 × 9.817 µA)/2 = 120.9 µS.
    const { gm_pair, in__gm, inr__gm, ld__gm, ldr__gm } = res.values;
    expect(relErr(gm_pair, (inr__gm * (ld__gm / ldr__gm) + in__gm) / 2)).toBeLessThan(1e-12);
    expect(relErr(gm_pair, gmPair)).toBeLessThan(1e-3);
    expect(relErr(ld__gm / ldr__gm, rL)).toBeLessThan(1e-3);
    // It is the two-stage Miller OTA's first-stage form, read with this sheet's names: the input
    // device on the diode side, the mirror's output and diode devices, the output-side input.
    const miller = sheet('multistage/two-stage-miller-ota.json').equations.find(
      (e) => e.name === 'gm1',
    )!.expr;
    const renamed = miller
      .replace(/\bld1o__/g, 'LD__')
      .replace(/\bld1__/g, 'LDR__')
      .replace(/\bino__/g, 'IN__')
      .replace(/\bin__/g, 'inr__')
      .replace(/\bLD__/g, 'ld__')
      .replace(/\bLDR__/g, 'ldr__')
      .replace(/\bIN__/g, 'in__');
    expect(doc.equations.find((e) => e.name === 'gm_pair')!.expr).toBe(renamed);
    expect(relErr(in__gm, 12 * iOut)).toBeLessThan(1e-3);
    // The diode-side transistor's gm is read back off the table between two drain-voltage
    // nodes, 0.13 % under the model's.
    expect(relErr(inr__gm, rest.gmDiode)).toBeLessThan(2e-3);
  });

  it('slew rate, GBW and supply current follow from the current the tail delivers', () => {
    // 20 µA × 0.948244 = 18.965 µA — not the 20 µA the reference is programmed to.
    expect(relErr(res.values.SR, iTail / CL)).toBeLessThan(1e-3);
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
    // 9.817 µA at vds = V_out_dc − V_tail, so its gds is I/(VA + vds) there. The load's output
    // side copies the diode side's saturation current I/(1 + vgs(8)/VA) and gds = idSat/VA in the
    // demo model, so its gds is the diode side's 9.148 µA over (VA + vgs(8)) — the drain voltage
    // it sits at cancels. Rout = 160.9 kΩ, and the gain is the pair's 120.9 µS into it, 19.45.
    const rout = 1 / (gdsOf(iOut, L, rest.vdsOut) + gdsOf(iDiode, L, VGS_GMID8_L05));
    expect(relErr(res.values.Rout, rout)).toBeLessThan(1e-3);
    expect(relErr(res.values.Av, gmPair * rout)).toBeLessThan(1e-3);
    expect(relErr(res.values.Av, res.values.gm_pair * res.values.Rout)).toBeLessThan(1e-12);
    const { in__gds, ld__gds } = res.values;
    expect(relErr(res.values.Rout, 1 / (in__gds + ld__gds))).toBeLessThan(1e-12);
    expect(relErr(in__gds, gdsOf(iOut, L, rest.vdsOut))).toBeLessThan(1e-3);
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
    // density 4kTγ·(gm + gmb)/gm², each at its own gm (gmb = BODY_FACTOR·gm in the model). A
    // mirror device's 4kTγ·(gm + gmb) of current noise is a current at the output, referred
    // through the pair's transconductance. The load's diode side
    // carries 9.148 µA at gm/ID 8; its output side is on the same gate at a higher drain voltage,
    // and gm scales with (VA + vds) exactly as id does, so it has rL times that — 8 × 9.817 µA.
    // The diode side's noise current reaches the output through the mirror, as the diode side's
    // half of the signal does in gm_pair, so it arrives rL times larger.
    const referred = (gm: number): number => (vnthM(gm) * gm) / gmPair;
    const vn = Math.hypot(
      vnthM(rest.gmDiode),
      vnthM(rest.gmOut),
      referred(8 * iDiode) * rL,
      referred(8 * iDiode * rL),
    );
    expect(relErr(res.values.vn_in, vn)).toBeLessThan(1e-3);
    // Which quantities the row reads, exactly: the diode side at its own density and the output
    // device's gm, which is its own gm times the mirror's gain.
    const { inr__vnth_m, in__vnth_m, ldr__vnth_m, ld__vnth_m, ld__gm, gm_pair } = res.values;
    expect(
      relErr(
        res.values.vn_in,
        Math.hypot(
          inr__vnth_m,
          in__vnth_m,
          (ldr__vnth_m * ld__gm) / gm_pair,
          (ld__vnth_m * ld__gm) / gm_pair,
        ),
      ),
    ).toBeLessThan(1e-12);
  });

  it('random offset counts each pair transistor and refers the mirror pair through the diode side', () => {
    // Pelgrom, written out: sigma(vos) of a pair is sqrt(2)·hypot(A_VT, A_beta/(gm/ID))/sqrt(W·L),
    // and each of its two transistors carries half of that variance at its own gm/ID. The mirror
    // pair's is a current at the output, referred to the input through the pair's
    // transconductance by gm_ldr/gm_pair — the diode side's gm, 8 × 9.148 µA. The widths are the
    // sizer's answers, read from the result the way the capacitance golden reads its own.
    const { avt, abeta, in__W, ldr__W, ldr__gm, gm_pair } = res.values;
    const sigma = (W: number, gmId: number): number =>
      (Math.SQRT2 * Math.hypot(avt, abeta / gmId)) / Math.sqrt(W * L);
    const gmIdDiode = gmIdDemo(VGS_GMID12_L05 + rest.delta);
    const model = Math.hypot(
      Math.hypot(sigma(in__W, 12), sigma(in__W, gmIdDiode)) / Math.SQRT2,
      (sigma(ldr__W, 8) * 8 * iDiode) / gmPair,
    );
    expect(relErr(res.values.vos, model)).toBeLessThan(1e-3);
    // At the gm/ID and the transconductances the run reports, the row is exact to rounding.
    const gmId = (name: string): number => res.values[`${name}__gm`] / res.values[`${name}__id`];
    const pair = Math.hypot(sigma(in__W, gmId('inr')), sigma(in__W, gmId('in'))) / Math.SQRT2;
    const mirror = (sigma(ldr__W, 8) * ldr__gm) / gm_pair;
    expect(relErr(res.values.vos, Math.hypot(pair, mirror))).toBeLessThan(1e-9);
  });

  it('every row reads the pair where it is about the pair and one transistor where it is about a node', () => {
    // The demo model cannot tell the pair's two transistors apart in gate capacitance (no bias
    // dependence at all), so the value goldens above would pass on a capacitance that read one
    // transistor twice. What each row reads is therefore pinned here as well.
    const names = (row: string): readonly string[] =>
      exprNames(doc.equations.find((r) => r.name === row)!.expr);
    const reads = (row: string, device: string): boolean =>
      names(row).some((n) => n.startsWith(`${device}__`));
    // About the pair as a whole: both transistors, each at its own operating point.
    for (const row of ['CM_in', 'gm_pair', 'vn_in', 'vos', 'cgg_in', 'vos_sys'])
      expect([row, reads(row, 'inr'), reads(row, 'in')]).toEqual([row, true, true]);
    // Through the pair's transconductance: the one row for it, and neither transistor's own gm.
    for (const row of ['Av', 'GBW', 'vn_in'])
      expect([
        row,
        names(row).includes('gm_pair'),
        names(row).some((n) => /^inr?__gm$/.test(n)),
      ]).toEqual([row, true, false]);
    // About the output node: the output-side transistor and the mirror's output device only.
    expect([...names('Rout')].sort()).toEqual(['in__gds', 'ld__gds']);
    // The offset is the two gate-source voltages and nothing else.
    expect([...names('vos_sys')].sort()).toEqual(['in__vgs', 'inr__vgs']);
  });

  it('every device the design needs saturated says so, and the tail declares it', () => {
    // The tail, both pair transistors and the mirror's output side declare saturation; the two
    // diode-connected devices cannot. Each declaration is a physical check on its own device.
    const declared = doc
      .blocks!.filter((u) => u.doc?.givens?.region === 'saturation')
      .map((u) => u.name);
    expect(declared).toEqual(['tail', 'in', 'inr', 'ld']);
    for (const name of declared) {
      const c = res.blocks!.find((b) => b.name === name)!.checks.find((x) => x.id === 'region')!;
      expect([name, c.kind, c.status]).toEqual([name, 'physical', 'pass']);
      expect([name, c.lhsValue]).toEqual([name, Math.abs(block(res, name).bias!.vds!)]);
    }
    // The tail's is the margin the headroom row reports.
    const tail = res.blocks!.find((b) => b.name === 'tail')!.checks.find((x) => x.id === 'region')!;
    expect(relErr(tail.lhsValue! - tail.rhsValue!, res.values.tail_headroom)).toBeLessThan(1e-12);
    expect(doc.checks.map((r) => r.id)).not.toContain('tail-saturated');
  });

  it('the saturation margin watches whichever pair drain has less to spare', () => {
    // Each transistor is held against its own saturation voltage at its own drain. With the
    // output at 0.9 V, below the load's diode node (1.132 V), the output side is the one with
    // less: 0.9 V less the tail node less its saturation voltage.
    const margin = (r: SheetResult): number =>
      r.checks.find((c) => c.id === 'input-sat-margin')!.lhsValue!;
    const { V_tail, in__vdsat } = res.values;
    expect(margin(res)).toBeCloseTo(0.9 - V_tail - in__vdsat, 12);
    // Raise the output past the diode node and the diode side becomes the one that binds.
    const raised = runSheet(withParams(doc, { V_out_dc: 1.3 }), table, undefined, REFS);
    const v = raised.values;
    expect(margin(raised)).toBeCloseTo(1.8 - v.ldr__vgs - v.V_tail - v.inr__vdsat, 12);
    expect(margin(raised)).toBeLessThan(1.3 - v.V_tail - v.in__vdsat);
  });

  it('the mirror-node pole is the diode side gm over both mirror gates', () => {
    // gm_ldr = 8 × the 9.148 µA the diode side carries; the two mirror devices are one width
    // and one length, so the node carries twice one gate's W·L·Cox.
    const fPole = (8 * iDiode) / (2 * Math.PI * 2 * cggOf(res.values.ldr__W, L));
    expect(relErr(res.values.f_pole, fPole)).toBeLessThan(1e-3);
  });

  it('the design constraint lands the common mode exactly where the spec asked', () => {
    // The tail node is solved, not typed: the engine searches V_tail until CM_in — the tail node
    // plus the mean of the two gate-source voltages — equals CM_dc. 5 decimals: the search closes
    // at SOLVE_TOL_REL x the range's span (~0.7 µV on V_tail), which the CM relation's slope
    // stretches to just under a µV — 6 decimals would ride on luck.
    expect(res.values.CM_in).toBeCloseTo(1.1, 5);
    expect(res.values.CM_in).toBeCloseTo(
      res.values.V_tail + (res.values.in__vgs + res.values.inr__vgs) / 2,
      12,
    );
  });

  it('the common-mode checks hold at defaults', () => {
    for (const id of ['cm-not-below', 'cm-not-above']) {
      const r = res.checks.find((x) => x.id === id);
      expect(r?.status === 'pass' || r?.status === 'amber', id).toBe(true);
    }
  });

  it('the claimed CM range is checked at its ENDS by its range ends', () => {
    // Structure golden: the sheet re-evaluates at CM_dc = CM_lo and CM_hi on every run, each
    // range end re-solving the tail node over its full range on the design the base run produced.
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

  it('held at another condition, the tail follows its reference and the output node still balances', () => {
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
    expect(block(h, 'in').vgs).toBeGreaterThan(block(s, 'in').vgs);

    // The split is solved again there, on the held widths: the output node balances to the
    // solve's tolerance, the pair's two currents add up to what the tail delivers, and the load's
    // diode side carries its own pair transistor's. The share is the load mirror's ratio read at
    // this condition: the diode side, at its held width and half the current density, sits at a
    // higher gate-source voltage, so the output side's drain is relatively closer to it.
    expect(relErr(h.values.in__id, h.values.ld__id)).toBeLessThan(1e-6);
    expect(relErr(h.values.in__id + h.values.inr__id, h.values.tail__id)).toBeLessThan(1e-12);
    expect(relErr(block(h, 'ldr').id, h.values.inr__id)).toBeLessThan(1e-12);
    const rHeld = (va + (1.8 - 0.9)) / (va + Math.abs(block(h, 'ldr').vgs));
    expect(relErr(h.values.out_share - 0.5, rHeld / (1 + rHeld) - 0.5)).toBeLessThan(1e-2);
    expect(Math.abs(h.values.out_share - 0.5)).toBeLessThan(Math.abs(s.values.out_share - 0.5));
    expect(h.values.tail__id).toBeLessThan(s.values.tail__id);
    const ratio = (va + h.values.V_tail) / (va + block(h, 'bias').vgs);
    expect(relErr(1 - h.values.tail__id / I_TAIL, 1 - ratio)).toBeLessThan(1e-2);
    expect(h.values.vos_sys).toBe(Math.abs(h.values.inr__vgs - h.values.in__vgs));
  });
});

// Every library sheet names its wiring in the netlist format, or says it is not a circuit. The
// netlist describes what the sheet already states — which wire each terminal of each sized device
// sits on, which wires the sheet holds — and the DC wiring check reads it after sizing: the loops
// the statements close, the currents at each wire, and whether a device placed twice sits at one
// operating point. Nothing it derives feeds back into the design, so a sheet that names its wiring
// evaluates to the numbers it would without it.
describe('sheet library: the netlist', () => {
  // The sheets that size one device inside an abstraction rather than in a circuit: a budget or
  // application sheet that stands a single device in for a block (an integrator, a pass device, a
  // comparator, a switch measured at a test bias), and the rail-to-rail input stage, which sizes its
  // two pairs at stated drain-source voltages with the tails, the common mode and the summing
  // circuit off the sheet. Written down by reading each sheet, not read off the files.
  const NOT_A_CIRCUIT = [
    'applications/gm-c-filter-pole.json',
    'applications/ldo-pass-device-error-amp.json',
    'applications/preamp-latch-comparator.json',
    'applications/sc-settling-to-ota-spec.json',
    'applications/strongarm-comparator.json',
    'applications/track-and-hold-budget.json',
    'multistage/rail-to-rail-input-stage.json',
    'stages/sampling-switch.json',
  ];
  const RESOLVED = LIBRARY.map(({ file, doc }) => ({ file, doc: resolveSheetRefs(doc, REFS).doc }));

  it('every sheet is in the netlist format, and either names its wiring or says it is not a circuit', () => {
    const off: string[] = [];
    for (const { file, doc } of LIBRARY) {
      if (doc.formatVersion !== 2) off.push(`${file}: formatVersion ${String(doc.formatVersion)}`);
      const wired = placementsOf(doc.nodes) || (doc.blocks ?? []).some((u) => u.nodes || u.ports);
      if (doc.nodes !== 'none' && !wired) off.push(`${file}: names no wiring`);
      if (doc.nodes === 'none' && (doc.levels || doc.elements || doc.ports))
        off.push(`${file}: is not a circuit and carries wiring`);
    }
    expect(off).toEqual([]);
    // The sheets that declare no circuit are exactly the abstractions listed above.
    const none = LIBRARY.filter(({ doc }) => doc.nodes === 'none').map(({ file }) => file);
    expect(none.sort()).toEqual([...NOT_A_CIRCUIT].sort());
  });

  it('no sheet carries the earlier gate wiring: a gate tie is a wire two gates share', () => {
    const carried: string[] = [];
    for (const { file, doc } of LIBRARY)
      walkDocs(doc, file, (d, path) => {
        for (const u of d.blocks ?? []) if ('wiring' in u) carried.push(`${path}.${u.name}`);
      });
    expect(carried).toEqual([]);
  });

  it('no sheet leaves a sized device unwired', () => {
    const refused = RESOLVED.flatMap(({ file, doc }) =>
      wiringRefusal(doc).map((w) => `${file}: ${w.message}`),
    );
    expect(refused).toEqual([]);
  });

  it('every circuit closes on the demo device, at its defaults and at every end of its range', () => {
    // Clean means every loop closes within NODE_TOL, every wire's currents balance, no wire
    // floats, and a device placed twice sits at one operating point. A sheet that is not a circuit
    // reports that the check does not apply, and raises nothing.
    const states: string[] = [];
    const raised: string[] = [];
    for (const { file, doc, res } of EVALUATED) {
      if (!res) continue; // an evaluation that threw already fails its own contract test
      const want = doc.nodes === 'none' ? 'not-applicable' : 'checked-clean';
      if (res.nodes?.state !== want)
        states.push(`${file}: ${res.nodes?.state ?? 'no wiring report'}`);
      // A range end re-runs the check on the design held there; what it finds rides its warnings.
      // An end the solve gives no answer at (a common mode this table cannot produce) landed
      // nowhere, so there is no operating point there to check.
      const runs = [
        { at: 'defaults', warnings: res.warnings },
        ...(res.rangeEnds ?? [])
          .filter((e) => e.state !== 'no-answer')
          .map((e) => ({ at: e.name, warnings: e.warnings })),
      ];
      for (const { at, warnings } of runs)
        for (const w of warnings)
          if (w.rule === 'sheet-nodes') raised.push(`${file} @ ${at}: ${w.message}`);
    }
    expect(states).toEqual([]);
    expect(raised).toEqual([]);
  });

  it('a wrong wire and a placement list at two operating points are each reported', () => {
    // Two breaks made on copies, never on the files. Not vacuous: the clean verdicts above come
    // from a check that does report a netlist that is not the circuit.
    const rewired = (file: string, block: string, nodes: unknown): SheetDoc => {
      const doc = sheet(file);
      return {
        ...doc,
        blocks: doc.blocks!.map((u) => (u.name === block ? { ...u, nodes } : u)),
      } as SheetDoc;
    };
    const nodesWarnings = (r: SheetResult): string[] =>
      r.warnings.filter((w) => w.rule === 'sheet-nodes').map((w) => w.message);
    // The 5T's diode-side pair transistor with its drain on the output instead of the load's diode
    // node: its drain-source voltage puts that node one load gate-source voltage below the supply,
    // and the output is held at V_out_dc, so the loop misses by the difference.
    const wrong = runSheet(
      rewired('otas/five-transistor-ota.json', 'inr', { d: 'out', g: 'vinp', s: 'tail', b: 'gnd' }),
      table,
      undefined,
      REFS,
    );
    expect(wrong.nodes!.state).toBe('checked-with-findings');
    const vdd = wrong.values.VDD;
    const miss = vdd - Math.abs(wrong.values.ldr__vgs) - wrong.values.V_out_dc;
    expect(miss).toBeGreaterThan(NODE_TOL);
    expect(relErr(wrong.nodes!.closureError, miss)).toBeLessThan(1e-6);
    expect(nodesWarnings(wrong).some((m) => m.startsWith('the wiring does not close'))).toBe(true);
    // The gain-boosted OTA's pair placed twice, with the second transistor's drain moved onto the
    // PMOS internal node: one sizing then claims two drain-source voltages. The loop through that
    // drain does not close, and the placements cannot be shown at one operating point.
    const split = runSheet(
      rewired('otas/gain-boosted-cascode-ota.json', 'in', [
        { d: 'a', g: 'vinn', s: 'tail', b: 'gnd' },
        { d: 'br', g: 'vinp', s: 'tail', b: 'gnd' },
      ]),
      table,
      undefined,
      REFS,
    );
    expect(split.nodes!.state).toBe('checked-with-findings');
    expect(split.nodes!.placements.find((p) => p.device === 'in')).toEqual({
      device: 'in',
      shared: false,
      reason: expect.stringMatching(/cannot be shown to share one operating point/),
    });
    // The diode side's PMOS internal node is solved under its bias line, so the moved drain sits
    // at V_br, where the diode-side PMOS cascode's source puts it.
    const vds = split.values.V_a - split.values.V_tail;
    const drop = split.values.V_br - split.values.V_tail;
    expect(relErr(split.nodes!.closureError, drop - vds)).toBeLessThan(1e-6);
    expect(nodesWarnings(split).some((m) => m.startsWith('the wiring does not close'))).toBe(true);
  });
});

// What the wiring check reports on the library where a sheet states one wire two ways. The CMOS
// inverter's two gates share the input wire: the NMOS's gate-source voltage is the input level,
// and the PMOS is handed the gate-source voltage the supply leaves above it, so the loop through
// the two gates and the two rails closes by construction — until the PMOS is read somewhere else.
describe('what the wiring check reports on the library at its shipped defaults', () => {
  it('the CMOS inverter ties its two gates, and reports only a gate read off the table', () => {
    const doc = sheet('stages/cmos-inverter-amp.json');
    const res = runSheet(doc, table);
    // The NMOS is sized for gm/ID 7, so its gate-source voltage is the input level; on the demo
    // table gm/ID 7 at 0.5 µm takes 0.70691 V (the model's gm/ID curve, inverted). The input wire
    // is reported at that level, derived along the NMOS's gate.
    let [lo, hi] = [VGS_GMID8_L05, 1.2];
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (gmIdDemo(mid) > 7) lo = mid;
      else hi = mid;
    }
    expect(relErr(res.values.V_in, lo)).toBeLessThan(1e-3);
    expect(relErr(res.values.V_in_p, res.values.V_in)).toBeLessThan(1e-12);
    expect(res.nodes!.state).toBe('checked-clean');
    expect(relErr(res.nodes!.levels.in.level, res.values.V_in)).toBeLessThan(1e-12);
    // The two advisory checks read V_in on the right: the trip point, where the input level
    // equals the 0.9 V output level, and the tie. A '==' margin is (tolPct/100)*|rhs| - |lhs -
    // rhs|. This table's thresholds are low, so the input sits 193 mV under the trip point and
    // that check fails; the tie holds to rounding, so its margin is the whole 1 % band.
    const check = (id: string): { status: string; margin: number } =>
      res.checks.find((r) => r.id === id) as { status: string; margin: number };
    expect(check('input-consistent-n').status).toBe('fail');
    expect(relErr(check('input-consistent-n').margin, 0.009 - (0.9 - lo))).toBeLessThan(1e-3);
    expect(check('input-consistent-p').status).toBe('pass');
    expect(relErr(check('input-consistent-p').margin, 0.01 * res.values.V_in)).toBeLessThan(1e-9);
    // Advisory checks never move the verdict; the gain spec does, and on this table it is short.
    expect(res.feasible).toBe(false);
    expect(
      res.checks.filter((c) => isHardCheck(c.kind) && c.status === 'fail').map((c) => c.id),
    ).toEqual(['gain-spec']);
    // At gm/ID 12 the input level falls to vgs(12) and the PMOS would need 1.8 − 0.567 = 1.233 V,
    // past the 1.2 V the table sweeps. It is read at the table's edge, so the loop through the two
    // gates misses by the difference between the input level and 1.8 − 1.2 V, and the check says so.
    const strong = runSheet(withParams(doc, { gm_id_n: 12 }), table);
    expect(relErr(strong.values.V_in, VGS_GMID12_L05)).toBeLessThan(1e-3);
    expect(strong.nodes!.state).toBe('checked-with-findings');
    const [dispute] = strong.nodes!.disputes;
    expect(relErr(dispute.closureError, 1.8 - 1.2 - strong.values.V_in)).toBeLessThan(1e-6);
    expect(dispute.closureError).toBeGreaterThan(NODE_TOL);
    expect(dispute.relations).toEqual(expect.arrayContaining(['n.gs', 'p.gs']));
  });

  it('the flipped voltage follower derives its internal node instead of declaring one', () => {
    const res = runSheet(sheet('multistage/flipped-voltage-follower.json'), table);
    // Node X is the feedback device's gate above its grounded source, so the node IS that
    // device's own sized gate-source voltage — vgs(10) on the demo table — and the input device's
    // drain-source voltage is what is left of it above the output. The netlist puts both on one
    // wire, and the loop through it closes.
    expect(relErr(res.values.V_x, VGS_GMID10_L05)).toBeLessThan(1e-3);
    expect(res.nodes!.state).toBe('checked-clean');
    expect(relErr(res.nodes!.levels.x.level, res.values.V_x)).toBeLessThan(1e-9);
    expect(res.feasible).toBe(true);
  });
});
