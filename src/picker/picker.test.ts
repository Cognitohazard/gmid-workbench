// The picker's contract, pinned against the synthetic demo device so every number here is
// reproducible on any machine: the tests inject the EVALUATION budget and never a clock, so
// the wall-clock cap — the UI's default budget — is out of play and the search is a pure
// function of the library and the spec.
//
// The goldens are deliberately behavioural rather than structural. Three of them exist for the
// measured ways a picker of this shape lies: a spec matched by name alone applies a noise DENSITY
// as an integrated budget; a sheet whose containment edge cannot bracket reports "did not close
// within N evaluations" for a search that never ran; a back-off that hits the author's slider
// floor reports the floor as if it were the design's answer.

import { describe, it, expect } from 'vitest';
import { libraryEntries, loadLibrary, sheet, table, REFS } from '../sheet/library.fixtures';
import {
  runSheet,
  bindingConstraint,
  withParams,
  type SheetDoc,
  type SheetRefEntry,
  type SheetVar,
} from '../sheet';
import {
  marginSpeaksFor,
  NOT_SEARCHABLE,
  pickTopology,
  rankCandidates,
  searchable,
  SEARCHABLE_GROUPS,
  SPEC_FIELDS,
  type PickerCandidate,
  type PickerSpec,
} from './index';

// The searchable set, read through the core's own curation predicate rather than restated here:
// the amplifier and buffer classes, minus the composable leaf with no supply branch and the
// sampling switch (a passive element between two nodes, with no quiescent current to report).
const SEARCHABLE: SheetRefEntry[] = libraryEntries().filter((e) => searchable(e.path));

/** One library sheet through the picker, by its on-disk `group/file.json` path, budgeted by
 *  evaluations only. The candidate reports the library id — the same path without the
 *  extension — which is what the app and the ref index key sheets by. */
const pick = (file: string, spec: PickerSpec, evalBudget?: number) =>
  pickTopology(spec, { path: file.replace(/\.json$/, ''), doc: sheet(file) }, table, undefined, {
    refs: REFS,
    ...(evalBudget === undefined ? {} : { evalBudget }),
  });

// The sheets that carry a vocabulary NAME under a different unit — the whole reason the match
// key is a pair. Both are `vn_target` as an integrated RMS in volts rather than a density:
// the sampling switch's kT/C budget, and the filter pole's. Listed rather than filtered out,
// so a THIRD such sheet fails the gate below instead of quietly joining them.
const KNOWN_UNIT_CLASHES: readonly string[] = [
  'applications/gm-c-filter-pole.json',
  'stages/sampling-switch.json',
];

describe('the searchable set', () => {
  // A tripwire, deliberately: a new sheet under stages/, otas/ or multistage/ has to be
  // decided about — searchable or not — rather than joining the search by being filed there.
  it('is the set the picker is specified against', () => {
    expect(SEARCHABLE).toHaveLength(25);
  });

  // The curation is written in library ids, and nothing about a string forces one to exist.
  // A group renamed or a sheet moved would leave a line here quietly doing nothing: the group
  // would contribute no candidates, and the exclusion would stop excluding.
  it('names groups and exclusions that are really in the library', () => {
    const paths = libraryEntries().map((e) => e.path);
    expect(NOT_SEARCHABLE.filter((p) => !paths.includes(p))).toEqual([]);
    expect(SEARCHABLE_GROUPS.filter((g) => !paths.some((p) => p.startsWith(g)))).toEqual([]);
  });
});

describe('the spec vocabulary', () => {
  // The gate that keeps authoring drift from becoming a silent wrong answer. `vn_target` is a
  // noise density on the amplifier sheets and an integrated RMS on two others; a picker
  // matching on name alone would apply one as the other, ~5000x out, and report the design as
  // failing its own noise spec.
  //
  // This walks the WHOLE library rather than the searchable set, which is the point: a name
  // that means two things is a hazard wherever it is authored, and the searchable set is
  // exactly the filter that would hide the two sheets already doing it.
  it('gives each spec name one unit library-wide, save the clashes it names', () => {
    for (const field of SPEC_FIELDS) {
      for (const { file, doc } of loadLibrary()) {
        const p = doc.params.find((q) => q.name === field.name);
        if (!p || KNOWN_UNIT_CLASHES.includes(file)) continue;
        expect(p.unit ?? '', `${file} declares ${field.name} in an unexpected unit`).toBe(
          field.unit,
        );
      }
    }
  });

  // The exception list has to stay true, or it silently becomes a blanket exemption for two
  // sheets: each listed file must really carry a vocabulary name under a different unit.
  it('lists only sheets that really do clash', () => {
    for (const file of KNOWN_UNIT_CLASHES) {
      const doc = sheet(file);
      const clashing = SPEC_FIELDS.filter((f) => {
        const p = doc.params.find((q) => q.name === f.name);
        return p !== undefined && (p.unit ?? '') !== f.unit;
      });
      expect(
        clashing.map((f) => f.name),
        `${file} no longer clashes`,
      ).not.toHaveLength(0);
    }
  });
});

describe('spec application', () => {
  // A sheet that does not carry a field cannot answer for it, and the designer has to be able
  // to see that: a candidate consuming one of nine fields is answering a different question.
  it('discloses the fields a sheet has no parameter for', () => {
    const c = pick('multistage/two-stage-miller-ota.json', { vn_target: 2e-8 });
    expect(c.specApplied).toEqual([]);
    expect(c.specCoverage).toEqual({ consumed: 0, supplied: 1 });
    expect(c.specIgnored).toHaveLength(1);
    expect(c.specIgnored[0].name).toBe('vn_target');
    expect(c.specIgnored[0].reason).toContain('no "vn_target" parameter');
  });

  // The false friend, pinned on the sheet that carries it. The sampling switch's `vn_target` is
  // an INTEGRATED kT/C budget in volts; typing 20 nV/sqrt(Hz) must not be read as a 20 nV total
  // noise budget. The verdict stays `closed` — the sheet is feasible at its own defaults — and
  // the ignored field says why the number was not used.
  it('refuses a name match whose unit is a different quantity', () => {
    const c = pick('stages/sampling-switch.json', { vn_target: 2e-8 });
    expect(c.specApplied).toEqual([]);
    expect(c.specIgnored[0].reason).toContain('is in V, not V/sqrt(Hz)');
    expect(c.verdict).toBe('closed');
  });

  // The remaining refusals have no example in the library today, which is the argument FOR
  // pinning them: they exist to catch authoring drift, so the drift they catch must not be
  // able to arrive without a test failing. A minimal synthetic document is enough — the
  // picker takes any SheetDoc.
  const minimal = (param: SheetVar): SheetRefEntry => ({
    path: 'synthetic/probe',
    doc: {
      title: 'probe',
      polarity: 'n',
      params: [param],
      rows: [],
      rules: [],
    },
  });
  const ignoredReason = (param: SheetVar): string =>
    pickTopology({ CL: 1e-12 }, minimal(param), table, undefined, { refs: REFS }).specIgnored[0]
      .reason;

  it('refuses a spec name a sheet declares as an implementation knob', () => {
    expect(ignoredReason({ name: 'CL', value: 2e-12, unit: 'F', role: 'choice' })).toContain(
      'implementation knob',
    );
  });

  // Distinct from the above on purpose: an undeclared role is the sheet saying nothing, and
  // `knobsOf` does not treat it as a knob either — so calling it one would make the two halves
  // of the same candidate contradict each other.
  it('refuses a spec name whose role the sheet never declared, without calling it a knob', () => {
    const reason = ignoredReason({ name: 'CL', value: 2e-12, unit: 'F' });
    expect(reason).toContain('declares no role');
    expect(reason).not.toContain('implementation knob');
  });

  it('refuses a spec name the engine solves', () => {
    const reason = ignoredReason({
      name: 'CL',
      value: 2e-12,
      unit: 'F',
      role: 'spec',
      solveFor: 'something',
    });
    expect(reason).toContain('the engine solves');
  });

  // A field outside the vocabulary is disclosed rather than dropped. TypeScript blocks it at
  // this module's boundary, but the spec arrives from an entry form and from persisted layout.
  it('discloses a spec field it has no vocabulary for', () => {
    const c = pickTopology(
      { VDD: 1.8, nonsense: 1 } as PickerSpec,
      { path: 'otas/five-transistor-ota', doc: sheet('otas/five-transistor-ota.json') },
      table,
      undefined,
      { refs: REFS, evalBudget: 1 },
    );
    expect(c.specIgnored.map((m) => m.name)).toEqual(['nonsense']);
    expect(c.specIgnored[0].reason).toContain('not one of the spec fields');
  });
});

describe('the search', () => {
  // The five-transistor OTA is INFEASIBLE at its shipped defaults on the demo device, binding
  // `cm-lo@offset-spec` at -69.4%: at the bottom of the claimed common-mode range the input
  // pair's Pelgrom offset comes out at 16.94 mV against a 10 mV budget. `vos_target` is the
  // only relaxing field here — probed, the sheet still fails at 16.9 mV and closes at 17 mV,
  // and this spec asks 40 mV. Every other field of the spec is at or below the sheet's own
  // default, so nothing else in it can be doing the work.
  const RELAXED: PickerSpec = {
    VDD: 1.8,
    CL: 2e-12,
    Av_target: 10,
    GBW_target: 5e6,
    SR_target: 2e6,
    vn_target: 1e-7,
    vos_target: 0.04,
  };

  it('closes the five-transistor OTA on a relaxed offset budget, with no repair needed', () => {
    const c = pick('otas/five-transistor-ota.json', RELAXED);
    expect(c.verdict).toBe('closed');
    expect(c.specCoverage).toEqual({ consumed: 7, supplied: 7 });
    expect(c.specIgnored).toEqual([]);
    // One screening evaluation plus the current back-off's bisection: the repair stage never
    // ran, which is the point of this golden — the spec closed the sheet, not the search.
    expect(c.evals).toBe(8);
    expect(c.bindingConstraint).toBeUndefined();
    expect(c.knobs).toEqual({ I_tail: 4.25e-6 });
  });

  // The same sheet at the tight spec — which is its shipped default — is the repair case. The
  // search ranks the knobs against `cm-lo@offset-spec`, scans the winner across its authored
  // range, and closes on tail current: more current buys gm, gm buys back the offset margin.
  // The endpoint is then backed off by stage 2, so the recorded value is below the scan sample
  // the repair landed on. Pinned after the algorithm was frozen; the assertion below
  // re-evaluates that value standalone rather than trusting the search's own verdict.
  it('repairs the five-transistor OTA at its tight spec, and the endpoint stands alone', () => {
    const c = pick('otas/five-transistor-ota.json', {
      VDD: 1.8,
      CL: 2e-12,
      Av_target: 15,
      GBW_target: 8e6,
      SR_target: 5e6,
      vn_target: 3e-8,
      vos_target: 0.01,
      CM_lo: 1.0,
      CM_hi: 1.35,
    });
    expect(c.verdict).toBe('closed');
    expect(c.specCoverage).toEqual({ consumed: 9, supplied: 9 });
    expect(Object.keys(c.knobs)).toEqual(['I_tail']);
    expect(c.knobs.I_tail).toBeCloseTo(5.9234375e-5, 12);
    expect(c.atRangeFloor).toEqual([]);
    // Every evaluation accounted for: 1 screening, then a first round that ranks all 7 knobs
    // (1 + 2 each) and scans the winner without finding a move, then a second round that reads
    // the same ranking back from the point it was taken at — free, because the point did not
    // move — and scans the next knob, 1 to confirm the move it found, and 7 for the back-off
    // (a probe at the floor plus 6 bisections). 1 + 15 + 7 + 0 + 7 + 1 + 7.
    expect(c.evals).toBe(38);

    const hand = runSheet(
      withParams(sheet('otas/five-transistor-ota.json'), { I_tail: c.knobs.I_tail }),
      table,
      undefined,
      REFS,
    );
    expect(hand.feasible).toBe(true);
    expect(bindingConstraint(hand)).toBeUndefined();
  });

  // A sheet that ran out of budget says so with the numbers that bounded it, and never says
  // "cannot close". The cascode CS amp is sub-millisecond per evaluation, so the golden is
  // cheap. 20 evaluations buys one ranking pass (1 + 2 per knob) and leaves no room to scan —
  // so nothing but the sheet's own point was ever evaluated, and the cause must say THAT
  // rather than leaving a bare rule miss standing as the answer.
  it('reports a starved search as did-not-close, with the budget it was given', () => {
    const c = pick('stages/cascode-cs-amp.json', {}, 20);
    expect(c.verdict).toBe('did-not-close');
    expect(c.budgetExhausted).toBe(true);
    expect(c.budget.evalBudget).toBe(20);
    expect(c.budget.msBudget).toBeGreaterThan(0);
    expect(c.evals).toBe(16);
    expect(c.evals).toBeLessThanOrEqual(c.budget.evalBudget);
    // No clock was supplied, so the wall-clock cap was never in play and must not be reported
    // as if it had been.
    expect(c.elapsedMs).toBe(0);
    expect(c.knobs).toEqual({});
    // The WHOLE disclosure, pinned verbatim. A `toContain` on the rule name would pass on a
    // cause that reads as a design property, which is the exact failure this golden exists to
    // catch: the stop has to come first, both budget numbers have to be quotable, and the
    // margin has to be labelled as belonging to the last point the search reached.
    expect(c.cause).toBe(
      'the budget admitted no search round — no knob was ever scanned, so no design point ' +
        "other than the sheet's own was tried (the limits were 20 evaluations and 1500 ms); " +
        'at the last point searched, gain-spec fails by -80.3%',
    );
  });

  // A budget too small to rank must still buy the search something. Ranking a 7-knob sheet
  // reserves 15 evaluations; a scan costs 7. At a budget of 8 the ranking cannot be afforded,
  // and the search falls back to scanning unranked rather than giving up — which is the common
  // case on a real PDK table, where one evaluation costs ~180 ms and a wall-clock budget buys
  // a scan but not a ranking.
  it('falls back to an unranked scan when the budget cannot afford a ranking', () => {
    const c = pick('stages/cascode-cs-amp.json', {}, 8);
    expect(c.verdict).toBe('did-not-close');
    expect(c.budgetExhausted).toBe(true);
    expect(c.evals).toBe(8); // 1 screening + one 7-point scan, no ranking
    expect(c.cause).toContain('the search stopped when its budget ran out, after 8 evaluations');
    expect(c.cause).toContain('the limits were 8 evaluations and 1500 ms');
    // A scan DID happen here, so the no-round wording would be false.
    expect(c.cause).not.toContain('admitted no search round');
  });

  // The wall-clock half of the budget contract. An injected counting clock is as deterministic
  // as the evaluation cap, so the branch that produces the app's own default behaviour is not
  // left to the UI to discover.
  it('honours a wall-clock budget through the injected clock, deterministically', () => {
    const run = () => {
      let t = 0;
      return pickTopology(
        {},
        { path: 'stages/cascode-cs-amp', doc: sheet('stages/cascode-cs-amp.json') },
        table,
        undefined,
        { refs: REFS, msBudget: 10, now: () => (t += 4) },
      );
    };
    const c = run();
    expect(c.verdict).toBe('did-not-close');
    expect(c.budgetExhausted).toBe(true);
    expect(c.budget.msBudget).toBe(10);
    expect(c.elapsedMs).toBeGreaterThan(0);
    expect(c.cause).toContain('its budget ran out');
    expect(c.cause).toContain('the limits were 200 evaluations and 10 ms');
    // The clock stopped it well inside the evaluation cap — the two budgets are independent,
    // and whichever trips first ends the search.
    expect(c.evals).toBeLessThan(c.budget.evalBudget);
    expect(run()).toEqual(c);
  });

  // The pair that makes the doctrine concrete: ONE
  // sheet at ONE spec, closing or not depending only on which budget bounds it. Whatever the
  // clock-cut run reports is therefore a fact about the clock — so its cause must lead with
  // that, and its margin must never stand alone as the design's answer.
  it('closes a sheet under the evaluation cap that a tight clock cuts short', () => {
    const withEvals = pick('otas/five-transistor-ota.json', {});
    expect(withEvals.verdict).toBe('closed');
    expect(withEvals.evals).toBe(38); // the same trajectory as the tight-spec golden above

    // 60 ms of a 20-ms-per-read clock: enough to scan, not enough to close. The clock has to be
    // tighter than the evaluation cap by more than the search costs — every evaluation this
    // sheet no longer spends is time it does not spend either, so a budget that once cut the
    // search short can stop doing so.
    let t = 0;
    const withClock = pickTopology(
      {},
      { path: 'otas/five-transistor-ota', doc: sheet('otas/five-transistor-ota.json') },
      table,
      undefined,
      { refs: REFS, msBudget: 60, now: () => (t += 20) },
    );
    expect(withClock.verdict).toBe('did-not-close');
    expect(withClock.budgetExhausted).toBe(true);
    expect(withClock.cause).toContain('the search stopped when its budget ran out');
    expect(withClock.cause).toContain('the limits were 200 evaluations and 60 ms');
    expect(withClock.cause).toContain('at the last point searched, cm-hi@offset-spec fails by');
    // Not "cannot close": the same sheet and the same spec close when the clock is not the
    // thing bounding the search.
    expect(withClock.evals).toBeLessThan(withEvals.evals);
  });

  // The margin at a cut is an artifact OF the cut. Two budgets on one sheet and one spec give
  // two different "fails by X%" numbers, ~3x apart, because the search stopped in two
  // different places. Neither may be read as the design's property — which is why both causes
  // lead with the stop rather than the number.
  it('never lets a margin quoted at a search cut stand as the design property', () => {
    const tight = pick('otas/folded-cascode-ota.json', {}, 30);
    const looser = pick('otas/folded-cascode-ota.json', {}, 80);
    expect(tight.verdict).toBe('did-not-close');
    expect(looser.verdict).toBe('did-not-close');
    expect(tight.worstMargin?.marginPct).toBeCloseTo(-1.744, 2);
    expect(looser.worstMargin?.marginPct).toBeCloseTo(-0.592, 2);
    for (const c of [tight, looser]) {
      expect(c.cause?.startsWith('the search stopped when its budget ran out')).toBe(true);
      expect(c.cause).toContain('at the last point searched');
    }
  });

  // A search that stops on its own terms owes two facts, not one: what binds the design, and
  // what stopped the search. Reporting only the constraint reads as though the search had
  // established something about it; reporting only the stop hides what to go and fix.
  it('names both the binding constraint and the reason the search stopped', () => {
    const c = pick('stages/cascode-cs-amp.json', {});
    expect(c.verdict).toBe('did-not-close');
    expect(c.budgetExhausted).toBe(false);
    expect(c.cause).toContain('reached its cap of 8 rounds');
    expect(c.cause).toContain('at the last point searched, gain-spec fails by');
    // The search got the gain within a few percent of closing without reaching it — a
    // statement about this search, and about nothing else.
    expect(c.bindingConstraint?.id).toBe('gain-spec');
    expect(c.bindingConstraint?.marginPct).toBeGreaterThan(-0.05);
  });

  // The combination case, and the one most likely to regress into a confident-sounding lie.
  // At this budget the folded cascode never leaves its own defaults, a point carrying BOTH a
  // failing rule and a range end whose pin cannot bracket. A cause that stopped at the first
  // fact would send the designer after 42% of offset margin — which they could buy in full and
  // still not close, because the uncovered range end gates the sheet whatever the rules say.
  // Every fact, not the first.
  it('names a range end the design does not cover even when a rule is failing too', () => {
    const c = pick('otas/folded-cascode-ota.json', {}, 25);
    expect(c.verdict).toBe('did-not-close');
    expect(c.bindingConstraint?.id).toBe('offset-spec');
    expect(c.cause).toContain('offset-spec fails by');
    expect(c.cause).toContain('stops covering its claimed range at "cm-hi"');
    expect(c.cause).toContain('does not change sign');
  });

  // The other way a checked range end fails, and the one that must NOT borrow the sentence above.
  // This edge overrides a name that is not in scope, so it returns before anything is evaluated:
  // nothing about the design was measured, and saying it stops covering its range would be
  // inventing a result. Nothing else catches this — the base run stands, every rule passes,
  // validation is silent (it checks that a `set` expression parses, never that its names
  // resolve), so the cause string is the only place a mis-authored edge surfaces at all.
  it('does not call a range end uncovered when its override never resolved', () => {
    const doc: SheetDoc = {
      title: 'typo',
      polarity: 'n',
      params: [
        { name: 'Target', value: 5 },
        { name: 'k', value: 5, min: 1, max: 9, role: 'choice' },
      ],
      rows: [{ name: 'y', expr: '2*k' }],
      rules: [{ id: 'k-floor', kind: 'requirement', lhs: 'k', op: '>=', rhs: '1' }],
      edges: [{ name: 'hi', set: { Target: 'Target_hi' } }], // Target_hi is declared nowhere
    };
    const c = pickTopology({}, { path: 'synthetic/typo', doc }, table, undefined, {});
    expect(c.verdict).toBe('could-not-be-searched');
    expect(c.bindingConstraint).toBeUndefined();
    expect(c.cause).toContain('set Target = "Target_hi" did not evaluate to a finite number');
    expect(c.cause).not.toContain('stops covering its claimed range');
    // The message names its own edge, so wrapping it would print "hi" twice.
    expect(c.cause?.match(/"hi"/g)).toHaveLength(1);
  });

  // Both halves of how the objective treats a point that produced no design, on the sheet where
  // it bites. The telescopic OTA's own defaults do not settle on this table — its tail pin has
  // no root there — so at the start the search is standing on nothing, and every neighbouring
  // point in that region is in the same state.
  //
  // If such points scored the objective's floor, the whole region would read alike, the scan
  // would find no move, and the search would stop where it began. If they scored on equal terms
  // with real designs, the opposite failure: margins read off a bracket-end probe are not worse
  // than a real design's, so the search would settle on a point that does not exist and quote
  // its numbers. Ordered within their own band instead, the search climbs out and closes — and
  // the point it reports stands on its own, at the ends of its claimed range as well.
  it('searches out of a region with no design at all, and lands on one that exists', () => {
    const c = pick('otas/telescopic-cascode-ota.json', {});
    expect(c.verdict).toBe('closed');
    const hand = runSheet(
      withParams(sheet('otas/telescopic-cascode-ota.json'), c.knobs),
      table,
      undefined,
      REFS,
    );
    expect(hand.feasible).toBe(true);
    expect(hand.covers).toBe(true);
  });

  // The descent has to keep a gradient across the region where the centre does not settle —
  // measurably a third of a slider on the library's OTAs. A range check is a question about a
  // design, so it goes unanswered everywhere in that region; scoring the unanswered question at
  // the objective's floor would make every point there read the same, `beats` would never fire
  // (it is strict), and the search would report "ran out of knobs" without having moved. Scored
  // on the only question that IS answerable there — the design's own worst margin — the same
  // scan walks the knob to the far end of its range.
  it('keeps a gradient across a region where no point has a design', () => {
    const doc: SheetDoc = {
      title: 'stuck',
      polarity: 'n',
      params: [
        { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'Target' } },
        { name: 'Target', value: 100 }, // y spans [1, 21]: the pin never lands, anywhere
        { name: 'Target_hi', value: 120 },
        { name: 'k', value: 1, min: 1, max: 9, role: 'choice' },
      ],
      rows: [{ name: 'y', expr: '2*x + 1' }],
      rules: [{ id: 'need-k', kind: 'requirement', lhs: 'k', op: '>=', rhs: '8' }],
      edges: [{ name: 'hi', set: { Target: 'Target_hi' } }],
    };
    const c = pickTopology({}, { path: 'synthetic/stuck', doc }, table, undefined, {});
    expect(c.verdict).toBe('did-not-close');
    expect(c.knobs).toEqual({ k: 9 });
    // And the candidate still says the range question was never put, so a reader cannot take
    // the rule it now passes for a design that works.
    expect(c.cause).toContain('the claimed range was not checked ("hi")');
  });

  // The other half of that: the incumbent is scored from a full result and a move from a sweep,
  // so the two readings of the objective must agree about what they can see. A sheet claiming NO
  // range gives neither of them a skipped range check to read, so neither may demote — if only
  // one did, every sample would outrank the point the search is standing on and it would accept a
  // move that makes the design worse. Here nothing ever settles, and the sheet's own k = 4 misses
  // its floor by less than any point the scan visits misses one of the two bounds (the samples
  // land at 1, 2.33, 3.67, 5, …), so the honest answer is to move nothing at all.
  it('scores a sheet with no range claim the same way from a result and from a sweep', () => {
    const doc: SheetDoc = {
      title: 'no-range',
      polarity: 'n',
      params: [
        { name: 'x', value: 1, min: 0, max: 10, pin: { lhs: 'y', rhs: 'Target' } },
        { name: 'Target', value: 100 }, // y spans [1, 21]: the pin never lands, anywhere
        { name: 'k', value: 4, min: 1, max: 9, role: 'choice' },
      ],
      rows: [{ name: 'y', expr: '2*x + 1' }],
      rules: [
        { id: 'k-floor', kind: 'requirement', lhs: 'k', op: '>=', rhs: '4.2' },
        { id: 'k-ceiling', kind: 'requirement', lhs: 'k', op: '<=', rhs: '4.5' },
      ],
    };
    const c = pickTopology({}, { path: 'synthetic/no-range', doc }, table, undefined, {});
    expect(c.verdict).toBe('did-not-close');
    expect(c.knobs).toEqual({});
  });

  // A sheet with nothing to turn cannot be searched — but the reason it fails is still the
  // most useful thing anyone can be told about it, so the stop does not displace it.
  it('keeps the binding constraint when a sheet has no knobs to search', () => {
    const c = pickTopology(
      {},
      {
        path: 'synthetic/knobless',
        doc: {
          title: 'knobless',
          polarity: 'n',
          params: [{ name: 'A', value: 1, unit: 'V', role: 'spec' }],
          rows: [],
          rules: [{ id: 'impossible', kind: 'requirement', lhs: 'A', op: '<=', rhs: '0.02' }],
        },
      },
      table,
      undefined,
      { refs: REFS },
    );
    expect(c.verdict).toBe('could-not-be-searched');
    expect(c.cause).toContain('no adjustable design knobs');
    expect(c.cause).toContain('impossible fails by');
    // Nothing was searched, so there is no "last point searched" to speak of.
    expect(c.cause).not.toContain('at the last point searched');
  });

  // The distinct third verdict. This OTA is infeasible on the demo device with NO failing rule
  // anywhere: at its `cm-hi` range end the pinned tail node cannot bracket, so nothing there
  // resolves into a margin and the rules that did evaluate all pass. A search here would descend
  // on interior margins that were never the problem and report progress, so it does not run at
  // all — and the outcome must not borrow the language of a search that did. The cause has to
  // name the claimed range as the thing the design misses; "the edge could not be evaluated"
  // would read as a gap in the run and send a designer looking for a setting to fix.
  it('says a sheet could not be searched when nothing failing can be named', () => {
    const c = pick('otas/current-mirror-ota.json', {});
    expect(c.verdict).toBe('could-not-be-searched');
    expect(c.bindingConstraint).toBeUndefined();
    expect(c.cause).toContain('stops covering its claimed range at "cm-hi"');
    expect(c.cause).toContain('does not change sign');
    expect(c.evals).toBe(1);
    expect(c.budgetExhausted).toBe(false);
  });
});

describe('the current back-off', () => {
  // One scale factor across every current knob, so the topology's authored branch ratios
  // survive: the Miller OTA's two stages sit at 1:3 before and after.
  it('scales all current knobs by a single factor', () => {
    const c = pick('multistage/two-stage-miller-ota.json', {});
    expect(c.verdict).toBe('closed');
    expect(c.knobs.I1).toBeCloseTo(1.5e-5, 12);
    expect(c.knobs.I2).toBeCloseTo(4.5e-5, 12);
    expect(c.knobs.I2 / c.knobs.I1).toBeCloseTo(3, 9); // the shipped 6e-5 : 2e-5
    expect(c.I_q).toBeCloseTo(6e-5, 12); // I1 + I2, down from 8e-5
    expect(c.atRangeFloor).toEqual([]);
  });

  // When the back-off runs all the way to the author's slider floor, the current is a bound on
  // the SEARCH, not the design's answer — the same doctrine as a starved budget. Both of this
  // sheet's currents land on their authored 4 µA minimum.
  it('marks a back-off that stopped at the authored floor', () => {
    const c = pick('multistage/rail-to-rail-input-stage.json', {});
    expect(c.verdict).toBe('closed');
    expect(c.knobs).toEqual({ I_n: 4e-6, I_p: 4e-6 });
    expect(c.atRangeFloor).toEqual(['I_n', 'I_p']);
    expect(c.I_q).toBeCloseTo(8e-6, 12);
  });

  // A sheet whose current is an OUTPUT of the sizing rather than a knob has nothing to back
  // off; that is a no-op, not an error.
  it('is a no-op on a sheet with no current knob', () => {
    const c = pick('stages/cs-amp-current-source-load.json', {});
    expect(c.verdict).toBe('closed');
    expect(c.knobs).toEqual({});
    expect(c.evals).toBe(1);
  });
});

describe('over the whole searchable set', () => {
  /** Every candidate for one spec. A caller drains its own list — there is no collect-all
   *  entry point — so the suite drains one the same way the app does. */
  const pickAll = (spec: PickerSpec, sheets: readonly SheetRefEntry[], evalBudget?: number) =>
    sheets.map((s) =>
      pickTopology(spec, s, table, undefined, {
        refs: REFS,
        ...(evalBudget === undefined ? {} : { evalBudget }),
      }),
    );

  it('answers once per offered sheet, in the order offered, and repeats itself exactly', () => {
    const some = SEARCHABLE.filter(({ path }) =>
      ['otas/current-mirror-ota', 'stages/source-follower'].includes(path),
    );
    const spec: PickerSpec = { VDD: 1.8, Av_target: 4 };
    const a = pickAll(spec, some);
    expect(a.map((c) => c.path)).toEqual(some.map((s) => s.path));
    expect(a.map((c) => c.group)).toEqual(['otas', 'stages']);
    expect(a).toEqual(pickAll(spec, some));
  });

  it('leaves the offered documents untouched', () => {
    const before = JSON.stringify(SEARCHABLE.map((s) => s.doc));
    pickAll({ VDD: 1.2, CL: 5e-12 }, SEARCHABLE.slice(0, 3));
    expect(JSON.stringify(SEARCHABLE.map((s) => s.doc))).toBe(before);
  });

  // Two promises the module makes about EVERY candidate, checked across the whole library
  // rather than sheet by sheet. Both were previously only observable through rendered DOM in
  // the browser suite, where a regression on the seventeenth sheet costs a two-minute run to
  // find. A deliberately small budget: this is about what every candidate says, not about how
  // deep the search gets, and starving it is what makes all three verdicts occur at once.
  it('never leaves a cause blank, and reaches all three verdicts', () => {
    const all = pickAll({ VDD: 1.8, CL: 2e-12, Av_target: 200 }, SEARCHABLE, 20);
    expect(all).toHaveLength(25);
    const silent = all.filter((c) => c.verdict !== 'closed' && !c.cause?.trim());
    expect(silent.map((c) => c.path)).toEqual([]);
    expect([...new Set(all.map((c) => c.verdict))].sort()).toEqual([
      'closed',
      'could-not-be-searched',
      'did-not-close',
    ]);
  });

  // The partition against the REAL library rather than synthetic rows: the sheets held out of
  // the ranking are the ones that really did consume less of the spec than the threshold asks,
  // and every candidate lands in exactly one of the two sections.
  it('holds back exactly the candidates that consumed too little of the spec', () => {
    const all = pickAll({ VDD: 1.8, CL: 2e-12, Av_target: 200 }, SEARCHABLE, 20);
    const view = rankCandidates(all, 'margin');
    expect(view.threshold).toBe(2);
    expect(view.other.length).toBeGreaterThan(0);
    expect(view.other.filter((c) => c.specCoverage.consumed >= view.threshold)).toEqual([]);
    expect(view.ranked.length + view.other.length).toBe(all.length);
  });
});

describe('reading the results', () => {
  /** A candidate carrying only the fields the ordering rules read. Synthetic on purpose: these
   *  are data-in/data-out rules, and pinning them to real sheets would make them move whenever
   *  a sheet does. */
  const candidate = (title: string, o: Partial<PickerCandidate> = {}): PickerCandidate => ({
    path: `synthetic/${title}`,
    title,
    group: 'synthetic',
    verdict: 'closed',
    knobs: {},
    atRangeFloor: [],
    currentAtRangeFloor: false,
    specApplied: [],
    specIgnored: [],
    specCoverage: { consumed: 2, supplied: 2 },
    evals: 1,
    elapsedMs: 0,
    budget: { evalBudget: 200, msBudget: 1500 },
    budgetExhausted: false,
    ...o,
  });
  const titles = (cs: readonly PickerCandidate[]): string[] => cs.map((c) => c.title);
  const permutations = <T>(xs: readonly T[]): T[][] =>
    xs.length <= 1
      ? [[...xs]]
      : xs.flatMap((x, i) =>
          permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
        );

  it('puts every closed candidate above the rest, whatever the key', () => {
    const closedButTight = candidate('closed', { worstMargin: { id: 'r', marginPct: 0.01 } });
    const failedButRoomy = candidate('failed', {
      verdict: 'did-not-close',
      worstMargin: { id: 'r', marginPct: 0.9 },
    });
    for (const key of ['margin', 'current'] as const) {
      expect(titles(rankCandidates([failedButRoomy, closedButTight], key).ranked)).toEqual([
        'closed',
        'failed',
      ]);
    }
  });

  it('sorts by the key, and a candidate with no value for it sorts last', () => {
    const cs = [
      candidate('none'),
      candidate('thirsty', { I_q: 1e-3 }),
      candidate('frugal', { I_q: 1e-6 }),
    ];
    expect(titles(rankCandidates(cs, 'current').ranked)).toEqual(['frugal', 'thirsty', 'none']);
  });

  // The interaction between the two rules, which is where the hazard actually lives: each is
  // safe alone. A candidate gated by something no rule measures keeps a COMFORTABLE margin —
  // its interior rules all pass — so a comparator reading the number directly floats exactly
  // the rows whose margin cell prints "—" above the genuine near misses. Row position is a
  // presentation of the key, so a margin no surface may print may not order the table either.
  it('never lets a margin it refuses to print outrank one it does', () => {
    const cs = [
      candidate('near miss', {
        verdict: 'did-not-close',
        worstMargin: { id: 'gain-spec', marginPct: -0.02 },
        bindingConstraint: { id: 'gain-spec', marginPct: -0.02 },
      }),
      candidate('unchecked edge', {
        verdict: 'could-not-be-searched',
        worstMargin: { id: 'interior', marginPct: 0.056 },
      }),
    ];
    expect(titles(rankCandidates(cs, 'margin').ranked)).toEqual(['near miss', 'unchecked edge']);
    // And two of them, both silent on the key, fall through to the title rather than to the
    // hidden numbers.
    const both = [
      candidate('zulu', {
        verdict: 'could-not-be-searched',
        worstMargin: { id: 'i', marginPct: 0.9 },
      }),
      candidate('alpha', {
        verdict: 'could-not-be-searched',
        worstMargin: { id: 'i', marginPct: 0.1 },
      }),
    ];
    expect(titles(rankCandidates(both, 'margin').ranked)).toEqual(['alpha', 'zulu']);
  });

  it('answers the same whatever order the candidates land in', () => {
    // The comparator has to stay TRANSITIVE, which is what makes this test the shape it is: a
    // sort over an intransitive comparator gives an order that depends on the input permutation,
    // so a streaming table would reshuffle for no reason. The two hazards are both here — one
    // side missing the key (the difference is ±Infinity, a real answer) and BOTH sides missing
    // it (NaN, which is not an answer and must fall through to the title).
    const cs = [
      candidate('alpha', { I_q: 2e-5 }),
      candidate('bravo'),
      candidate('charlie', { I_q: 2e-5 }),
      candidate('delta', { I_q: 1e-5 }),
      candidate('echo', { verdict: 'could-not-be-searched' }),
    ];
    const orders = permutations(cs).map((p) => titles(rankCandidates(p, 'current').ranked));
    expect([...new Set(orders.map((o) => o.join(',')))]).toEqual([
      'delta,alpha,charlie,bravo,echo',
    ]);
  });

  it('partitions the candidates that answer a smaller question, and does not rank them', () => {
    const cs = [
      candidate('full', { specCoverage: { consumed: 3, supplied: 3 } }),
      candidate('zeta', { specCoverage: { consumed: 1, supplied: 3 }, I_q: 1e-9 }),
      candidate('alpha', { specCoverage: { consumed: 0, supplied: 3 } }),
    ];
    const r = rankCandidates(cs, 'current');
    expect(r.supplied).toBe(3);
    expect(r.threshold).toBe(2);
    expect(titles(r.ranked)).toEqual(['full']);
    // Alphabetical, NOT by the key: the frugal one is not "the best of the rest".
    expect(titles(r.other)).toEqual(['alpha', 'zeta']);
  });

  it('degrades the threshold with the spec, so nothing is partitioned out of nothing', () => {
    const one = rankCandidates(
      [candidate('a', { specCoverage: { consumed: 1, supplied: 1 } })],
      'margin',
    );
    expect(one.threshold).toBe(1);
    expect(one.other).toEqual([]);
    const none = rankCandidates(
      [candidate('a', { specCoverage: { consumed: 0, supplied: 0 } })],
      'margin',
    );
    expect(none.threshold).toBe(0);
    expect(none.other).toEqual([]);
  });

  it('says when the worst margin does not speak for the candidate', () => {
    expect(marginSpeaksFor(candidate('closed'))).toBe(true);
    expect(
      marginSpeaksFor(
        candidate('failed', {
          verdict: 'did-not-close',
          bindingConstraint: { id: 'r', marginPct: -0.2 },
        }),
      ),
    ).toBe(true);
    // The hazard: rules that all pass, on a sheet a range end it does not cover gates anyway.
    expect(
      marginSpeaksFor(
        candidate('unsearchable', {
          verdict: 'could-not-be-searched',
          worstMargin: { id: 'r', marginPct: 0.4 },
        }),
      ),
    ).toBe(false);
  });
});
