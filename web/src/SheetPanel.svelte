<script lang="ts">
  // A leaf design-sheet panel: pick a vetted example, tune the design variables, and
  // watch the author equations and pass/fail checks recompute with signed margins.
  // It holds no numerics — the core does all evaluation and never throws, in this panel's
  // evaluation worker (sheetEvaluator.svelte.ts), off the page's thread.
  import {
    cloneDoc,
    aggregateConditionRuns,
    projectingResolver,
    sameCondition,
    tableAt,
    conditionKeyId,
    conditionKeyOf,
    conditionLabelIn,
    sweepable as isSweepable,
    torn,
    constrained as isConstrained,
    engineSolved,
    bindingCheck,
    limitingCheck,
    rangeEndCheck,
    rangeEndNames,
    namingRangeEnds,
    worstPointByCheck,
    RANGE_END_SEP,
    DEFAULT_SETTINGS,
    SENSITIVITY_REL_STEP,
    resolveSheetRefs,
    flattenSheetDoc,
    sheetFormat,
    unreadFormat,
    formatEng,
    formatSI,
    fallbackSentences,
    noiseLabel,
    noiseSourcesIn,
    devicesIn,
    deviceName,
    joinProvide,
    PROVIDE_SEP,
    BIAS_AXES,
    SWEEP_POINTS,
    SWEEP2_POINTS,
    type DeviceTable,
    type SheetDoc,
    type SheetGivens,
    type SheetVar,
    type SheetCheck,
    type SheetBlock,
    type SheetSweep2,
    type SheetSensitivity,
    type SheetBlockReport,
    type RangeEndReport,
    type PointState,
    type QAWarning,
    type SizingReport,
    type CheckResult,
    type CheckStatus,
    type SheetResult,
    type ConditionAggregate,
    type ConditionKey,
    type ConditionRun,
    type ConditionSweep,
    type CompliancePoint,
  } from '@gmid/mostab-core';
  import { describeBinding, deviceLabel, type Bench } from './families';
  import { tableUid, type SheetCornerMode } from './dashboard';
  import { PALETTE, type ChartData } from './chart';
  import { chartHost } from './chartHost.svelte';
  import { axisUnit, qFormula, qLabel, mathText, mathPlain } from './labels';
  import { CONTROL_HELP, SOLVER_HELP } from './help';
  import { changedSolverSettings, settingText, solverSettings } from './solver.svelte';
  import { commitEng, pct } from './eng';
  import { sheetMenu, sheetRefIndex } from './sheetlib.svelte';
  import { copyText, download } from './export';
  import { SheetEvaluator, type Answered, type JobOf } from './sheetEvaluator.svelte';
  import type { JobKind, JobResults } from './sheetjobs';

  let {
    device,
    cfg: stored,
    sweep = '',
    sweep2 = '',
    cornerMode = 'nominal',
    cornerKeys = [],
    cornerHold = false,
    restoreLost = undefined,
    unrestored = false,
    bench,
    styleVersion = 0,
    onChange,
    onSweep,
    onSweep2,
    onCornerMode,
    onCornerKeys,
    onCornerHold,
  }: {
    device: DeviceTable;
    cfg: SheetDoc;
    sweep?: string;
    /** The second (×) sweep param: with `sweep` set too, the panel draws a 2-D feasibility map. */
    sweep2?: string;
    /** Which characterization conditions this panel evaluates at (bench state, never in `cfg`). */
    cornerMode?: SheetCornerMode;
    cornerKeys?: ConditionKey[];
    /** With one condition asked about that is not the nominal one: hold the nominal design there
     *  instead of sizing the design there (bench state, like the two above). */
    cornerHold?: boolean;
    /** What restoring this panel's stored document lost (the loader's `lost` paths), when the
     *  restore lost anything. The stored copy is kept until the sheet is edited. */
    restoreLost?: readonly string[];
    /** The stored document could not be restored at all: `cfg` is a placeholder, and the panel
     *  opens refused with the reason in `restoreLost`. */
    unrestored?: boolean;
    bench: Bench;
    styleVersion?: number;
    onChange: (s: SheetDoc) => void;
    onSweep: (s: string) => void;
    onSweep2: (s: string) => void;
    onCornerMode: (m: SheetCornerMode) => void;
    onCornerKeys: (k: ConditionKey[]) => void;
    onCornerHold: (hold: boolean) => void;
  } = $props();

  // A document in a format this app does not read is kept as it was stored and shown only as the
  // reason it is refused. Nothing else is read from it — its keys may mean what this build does
  // not know — so the panel works on an empty sheet in its place, evaluates nothing, and offers
  // the picker; picking a sheet replaces it.
  // A stored document that could not be restored at all is refused the same way, with the reason
  // the loader gave, and kept as stored until a picked sheet replaces it.
  const REFUSED: SheetDoc = { title: '', polarity: 'n', params: [], equations: [], checks: [] };
  const refusal = $derived(
    unrestored
      ? `the stored sheet could not be restored (${(restoreLost ?? []).join('; ')}) — it is kept as stored and not evaluated; pick a sheet to replace it`
      : sheetFormat(stored).reason,
  );
  /** What a restore dropped from a document it could read, said where the verdict is read: the
   *  checks or givens it names are missing from what is evaluated here. */
  const restoreNote = $derived(
    !unrestored && restoreLost?.length
      ? `restored without ${restoreLost.length} ${restoreLost.length === 1 ? 'piece' : 'pieces'} of the stored sheet, which this build could not read: ${restoreLost.join(', ')} — the result below is evaluated without ${restoreLost.length === 1 ? 'it' : 'them'}; the stored sheet is kept unchanged until you edit this one`
      : undefined,
  );
  const cfg = $derived<SheetDoc>(refusal ? REFUSED : stored);

  // The live sheet library (curated ∪ user-imported) and its by-reference index.
  const menu = $derived(sheetMenu());
  const refs = $derived(sheetRefIndex());

  // Every evaluation — the verdict, the sweeps, the sensitivities — runs in this panel's
  // evaluation worker, never on the page's thread: a large sheet takes seconds per run. Each
  // answer is stored in a $state.raw below (results are plain data, so they are not wrapped in
  // reactive proxies), and the last answer stays on screen beside the busy indicator until the
  // next one arrives.
  const evaluator = new SheetEvaluator();
  $effect(() => () => evaluator.dispose());
  // The solver settings every job here runs under (the header's solver page). They are part of
  // each job, so a changed setting is a new job and everything on the panel is evaluated again.
  const solver = $derived(solverSettings());
  /** The settings that differ from their defaults — the header marks the panel while any does. */
  const solverChanged = $derived(changedSolverSettings());
  const solverTitle = $derived(
    [
      CONTROL_HELP.solverNonDefault,
      ...solverChanged.map(
        (k) =>
          `${SOLVER_HELP[k].label}: ${settingText(k, solver[k])} (default ${settingText(k, DEFAULT_SETTINGS[k])})`,
      ),
    ].join('\n'),
  );
  /** The error from a job that could not run at all, shown with the warnings. */
  let evalError = $state<string | null>(null);
  const failed = (e: string): void => {
    evalError = `evaluation failed: ${e}`;
  };
  /** Used by every evaluation below: request `job` and pass its answer to `answer`, with the
   *  request it answers — what each site reads to tell whether the answer still belongs on screen.
   *  `about` is what the request is about beyond its job (see SheetEvaluator.request). When there is
   *  no job (nothing to evaluate), withdraw the request and clear the answer. */
  function ask<K extends JobKind, A = undefined>(
    kind: K,
    job: JobOf<K> | undefined,
    answer: (r: { result: JobResults[K]; answered: Answered<K, A> } | null) => void,
    about?: A,
  ): void {
    if (!job || !primary || refusal) {
      evaluator.cancel(kind);
      answer(null);
      return;
    }
    evaluator.request(
      job,
      { bench, primary, refs, about },
      (result, answered) => answer({ result, answered }),
      failed,
    );
  }

  /** Which sheet this panel holds: a new number each time a sheet is picked into it, while an edit
   *  keeps it. A verdict belongs on screen only while it answers this sheet, so picking another
   *  sheet does not show the previous one's verdict while the new one is evaluated — however the
   *  two are titled. */
  let sheetSlot = $state(0);

  // One unresolved or mis-parameterized child makes every parent expression that
  // reads its provides "not defined" — a ~20-line wall for one root cause. Collapse
  // the fan-out to one line per child prefix; every other warning passes through.
  /** Validation and evaluation diagnostics as one list — walked twice below (warnings, then the
   *  informational range-end notes), so the concatenation is built once. */
  const allWarn = $derived.by(() => [...rr.warnings, ...(result?.warnings ?? [])]);
  const shownWarnings = $derived.by(() => {
    // A warning that quotes a range end says where that end is (rangeEndNames).
    const ws = allWarn
      .filter((w) => w.severity !== 'info')
      .map((w) => ({ ...w, message: namingRangeEnds(w.message, endNames) }));
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive grouping scratch, discarded on return
    const byChild = new Map<string, { count: number; first: string }>();
    const rest: string[] = [];
    for (const w of ws) {
      // The core reports the undefined name structurally; a child-provide symbol
      // (`ld__gm`) groups under its child prefix.
      const sep = w.rule === 'sheet-undeclared' && w.symbol ? w.symbol.indexOf(PROVIDE_SEP) : -1;
      if (sep > 0) {
        const child = (w.symbol as string).slice(0, sep);
        const e = byChild.get(child) ?? { count: 0, first: w.message };
        e.count++;
        byChild.set(child, e);
      } else rest.push(w.message);
    }
    const collapsed = [...byChild].map(([child, e]) =>
      e.count > 1
        ? `block "${child}" resolves nothing yet — ${e.count} dependent expressions read n/a (assign its device and check its params)`
        : e.first,
    );
    return [...rest, ...collapsed];
  });

  // The range-end notes are INFO, not warnings: a mirrored current that is different at a
  // range end is the circuit behaving as drawn, not a fault — and an author claiming that range
  // should still see it. Their own quiet line, in the core's words.
  const rangeNotes = $derived(
    allWarn
      .filter((w) => w.severity === 'info' && w.rule === 'sheet-range')
      .map((w) => namingRangeEnds(w.message, endNames)),
  );

  // Onboarding hints lead the same list the diagnostics land in — they are the likeliest cause of
  // the diagnostics below them, and they already name the remedy.
  const warnLines = $derived.by((): string[] => [
    ...(evalError ? [evalError] : []),
    ...signHints,
    ...shownWarnings,
  ]);

  // Onboarding guard: a child bound to a signed-PMOS table while its companion
  // `<child>_sign` param still reads +1 is the most common dead-on-arrival state for
  // the mirror-load sheets — every dependent equation goes n/a at once. Name the root
  // cause as a hint; never auto-flip (sign params are author math, not app state).
  const signHints = $derived.by(() => {
    const out: string[] = [];
    for (const u of rr.doc.blocks ?? []) {
      if (!u.device || !resolveDevice) continue;
      const t = resolveDevice(u.device);
      if (!t) continue;
      // The parser's RECORDED polarity is authoritative and never overridden; the
      // axis shape is only a fallback for tables that declared none — and then only
      // when the WHOLE sweep is non-positive, since a valid NMOS may legitimately
      // sweep from a negative subthreshold vgs up through positive values.
      const vgs = t.grid.axes.find((a) => a.name === 'vgs');
      const signedAxis = !!vgs && vgs.values[vgs.values.length - 1] <= 0;
      if (!signedAxis || t.meta.polarity?.device === 'n') continue;
      const sp = rr.doc.params.find((p) => p.name === `${u.name}_sign`);
      if (sp && sp.value === 1)
        out.push(
          `"${u.name}" is bound to a signed-PMOS table but ${sp.name} = 1 — set ${sp.name} = -1`,
        );
    }
    return out;
  });

  // Materialize by-reference children ONCE per edit: eval, both sweeps, and the child
  // cards all read the resolved tree, while every edit keeps targeting the raw cfg (so
  // a ref stays a ref in the persisted doc — that is what makes it live).
  const rr = $derived(resolveSheetRefs(cfg, refs));

  // ── Conditions. Corners do not add a third question to this panel: it still answers whether
  // the design is FEASIBLE where it is sized and whether that one design COMPLIES everywhere it
  // is promised to work — each answer stamped with the condition it belongs to. Every run fixes ONE
  // (corner, temperature) key and projects the primary and every named child to it, because a
  // verdict assembled from a tt input pair and an ss tail describes a chip that does not exist.
  const primary = $derived(bench.primary);
  /** A condition as the panel names it: the primary device's table there says which of its
   *  corner and temperature its file declared, and a filled-in one is marked (conditionLabel). */
  const condLabel = (key: ConditionKey | { corner: string; temp: number }): string =>
    conditionLabelIn(primary, key);
  /** Every condition the primary device holds, in load order. */
  const conditions = $derived<readonly ConditionKey[]>(primary?.keys ?? []);
  const activeKey = $derived(conditionKeyOf(device.id));
  const nominalKey = $derived(primary?.nominal ? conditionKeyOf(primary.nominal.id) : undefined);
  /** The conditions this panel is asking about. A chosen key that is no longer loaded stays in
   *  the list: it is answered as its own not-evaluated row, where pruning it would silently
   *  narrow the question. */
  const keys = $derived.by((): readonly ConditionKey[] => {
    if (!primary) return [];
    if (cornerMode === 'active') return [activeKey];
    if (cornerMode === 'all') return conditions;
    if (cornerMode === 'chosen') return cornerKeys;
    return nominalKey ? [nominalKey] : [];
  });
  /** Several conditions asked about: one design, sized at the nominal condition, held at the rest. */
  const multi = $derived(keys.length > 1);
  /** The one condition asked about, when there is one. */
  const single = $derived(keys.length === 1 ? keys[0] : undefined);
  /** One condition asked about that is not the nominal one, while a nominal one exists: it can be
   *  asked about two ways, and the control beside the mode offers both. */
  const offNominal = $derived(
    single !== undefined && nominalKey !== undefined && !sameCondition(single, nominalKey),
  );
  /** That condition is asked about with the nominal design held there, not with a design sized
   *  there — the same two-condition question several conditions are, with one of them asked. */
  const holding = $derived(cornerHold && offNominal);
  /** Why nothing can be evaluated, when nothing can be. `nominal` is the one that must never
   *  fall back to the active table: "the device's nominal" is a designation, and quietly
   *  substituting whatever is selected would report a verdict about a condition nobody chose. */
  const blocked = $derived.by((): 'no-device' | 'undesignated' | 'none-chosen' | null => {
    if (keys.length) return null;
    if (!primary) return 'no-device';
    return cornerMode === 'chosen' ? 'none-chosen' : 'undesignated';
  });
  // ONE run per condition, through the core's single transition: it preflights the devices,
  // refuses before the engine ever sees a missing or ambiguous table, and only calls a run
  // evaluated when it stands. The sheet is resolved and validated once for the set.
  //
  // One DESIGN across a set. A single condition is its own question: the design is sized there,
  // whichever condition it is, and every one-condition tool below works on it. Several
  // conditions are asked about one design — sized at the nominal condition and held at every
  // other, same widths, lengths, currents and gate biases, operating point re-settled — and the
  // nominal condition's run comes back first even when it was not asked for: the design is
  // sized there, so its home is always on the page, and feasibility is its verdict.
  //
  // The answer is kept with the request it answers, and shown while that request was about the
  // sheet in this panel now: the same sheet slot, and the same title — a slot is minted where a
  // sheet is picked here, and the title still catches a sheet replaced from outside the panel. So
  // picking another sheet does not show the previous one's verdict while the new one is
  // evaluated, while an edit keeps the last verdict on screen until the next arrives.
  let runsAnswer = $state.raw<{
    runs: ConditionRun[];
    answered: Answered<'run', number>;
  } | null>(null);
  $effect(() => {
    const base = multi || holding ? nominalKey : undefined;
    ask(
      'run',
      keys.length
        ? { kind: 'run', doc: cfg, keys: [...keys], ...(base ? { base } : {}), settings: solver }
        : undefined,
      (r) => {
        runsAnswer = r && { runs: r.result, answered: r.answered };
        if (r) evalError = null;
      },
      sheetSlot,
    );
  });
  const runs = $derived(
    primary &&
      runsAnswer &&
      runsAnswer.answered.about === sheetSlot &&
      runsAnswer.answered.job.doc.title === cfg.title
      ? runsAnswer.runs
      : [],
  );
  /** Nothing to show yet: the first verdict for this sheet is still being evaluated. */
  const firstRun = $derived(runs.length === 0 && evaluator.busy('run'));
  /** A sweep or a design-plane map is being taken. */
  const sweeping = $derived(evaluator.busy('sweep') || evaluator.busy('sweep2'));
  /** What the worker is doing while the page shows its last answer. The first verdict needs no
   *  line of its own: the badge says it is being evaluated. */
  const busyText = $derived.by(() => {
    if (evaluator.busy('run')) return runs.length ? 'updating…' : '';
    if (sweeping) return 'sweeping…';
    return evaluator.busy('sens') ? 'computing sensitivities…' : '';
  });
  // Two questions, answered apart: is the design feasible where it is sized, and at how many of
  // the points it is promised to work at does that one design comply.
  const agg = $derived(aggregateConditionRuns(runs));

  // The run whose numbers the detail below belongs to: the one that SIZED the design — the
  // run feasibility is read from, evaluated or not, so its diagnostics are the ones on screen
  // when it did not complete. Only a set with nowhere to size (several conditions, none
  // nominal) has no such run, and then the first row stands in. In multi-condition mode the
  // detail is explicitly stamped with it, so no number on screen is unattributed. Holding the
  // nominal design at one condition asks about THAT condition, so its held run is the detail.
  const refRun = $derived.by((): ConditionRun | undefined =>
    holding && single
      ? runs.find((r) => sameCondition(r.key, single))
      : (runs.find((r) => r.design === 'sized') ?? runs[0]),
  );
  const refKey = $derived(refRun?.key);
  const evaluated = $derived(refRun?.state === 'evaluated');
  /** The reference run's numbers. Absent when a condition was refused before the engine ran —
   *  and then NOTHING fabricates one: the panel shows what it could not evaluate instead. */
  const result = $derived<SheetResult | undefined>(refRun?.result);
  /** The primary table the detail was computed on: the device's table at the reference
   *  condition, which is the active table only when the panel is asking about that condition. */
  const refTable = $derived(refKey && primary ? tableAt(primary, refKey) : undefined);
  /** The sized devices of the reference run, with where each one's noise figures come from. */
  const noiseDevices = $derived(result ? noiseSourcesIn(result) : []);
  /** Where the sized devices' thermal-noise figures come from, in one line — each device's source
   *  and the figures its table made fall back (noiseLabel): the label alone when every device
   *  agrees, else each label with the devices that carry it. Empty with nothing sized. */
  const noiseLine = (sized: ReturnType<typeof noiseSourcesIn>): string => {
    const devices = sized.map((d) => ({
      device: d.device,
      label: noiseLabel(d.source, d.fallbacks),
    }));
    const labels = devices.map((d) => d.label).filter((l, i, all) => all.indexOf(l) === i);
    if (labels.length <= 1) return labels.join('');
    const carrying = (label: string): string =>
      devices
        .filter((d) => d.label === label)
        .map((d) => d.device)
        .join(', ');
    return labels.map((label) => `${label} (${carrying(label)})`).join(' · ');
  };
  const noiseText = $derived(noiseLine(noiseDevices));
  /** A condition row's own noise line where it differs from the detail's: a corner table without
   *  `sth` or `gmb` reads its noise figures — and the noise checks — by the estimate or the
   *  no-gmb form there, which the line above the detail does not say. The fallbacks in full are
   *  in the row's tooltip. */
  const rowNoiseNotes = (r: ConditionRun): string[] => {
    const sized = r.result ? noiseSourcesIn(r.result) : [];
    const line = noiseLine(sized);
    if (!line || line === noiseText) return [];
    return [
      `⚠ noise at ${condLabel(r.key)}: ${line}`,
      ...fallbackSentences(sized.flatMap((d) => d.fallbacks)),
    ];
  };
  /** The pass-through columns the sized devices read, each once: numbers at the characterization
   *  width rather than the sized one, which the line beside the noise line names. */
  const unscaled = $derived(
    result
      ? devicesIn(result, (s) => s.passthrough ?? []).filter((k, i, all) => all.indexOf(k) === i)
      : [],
  );
  /** The noise line's tooltip: what the sources mean, then every fallback that fired on any sized
   *  device, each in full — the quantity, the missing column, the form used and what it costs —
   *  said once and grouped by quantity. */
  const noiseTitle = $derived.by((): string =>
    [CONTROL_HELP.noiseSource, ...fallbackSentences(noiseDevices.flatMap((d) => d.fallbacks))].join(
      '\n\n',
    ),
  );
  /** The projection at the reference condition, for what the panel itself reads off a child's
   *  bound table (the sign hints). The evaluations project in the worker through the same core
   *  function, so nothing on the panel can mix conditions the verdict above it did not. */
  const resolveDevice = $derived(refKey ? projectingResolver(bench.deviceOf, refKey) : undefined);

  // ── What the header may say. FEASIBILITY is one answer about the design where it was sized;
  // COMPLIANCE is a count of points. Neither is inferred from the other, and a point that was
  // not run or could not be answered is counted as exactly that — never as a pass, never as a
  // failure.
  /** A compliance point's state as a mark, in words, and as a colour class. */
  const POINT_MARK: Record<PointState, string> = {
    complies: '✓',
    'does-not-comply': '✗',
    'no-answer': '?',
    'not-run': '–',
  };
  const POINT_TEXT: Record<PointState, string> = {
    complies: 'complies',
    'does-not-comply': 'does not comply',
    'no-answer': 'no answer',
    'not-run': 'not run',
  };
  const POINT_CLASS: Record<PointState, string> = {
    complies: 'ok',
    'does-not-comply': 'no',
    'no-answer': 'skip',
    'not-run': 'skip',
  };
  const FEAS_TEXT: Record<ConditionAggregate['feasibility'], string> = {
    feasible: 'feasible',
    infeasible: 'infeasible',
    'no-answer': 'no answer',
    'not-run': 'not evaluated',
  };
  const FEAS_CLASS: Record<ConditionAggregate['feasibility'], string> = {
    feasible: 'ok',
    infeasible: 'no',
    'no-answer': 'skip',
    'not-run': 'skip',
  };
  /** The held design's own centre, while the nominal design is held at one condition. */
  const heldCentre = $derived(holding ? refRun?.points[0] : undefined);
  /** The feasibility badge's words — stamped with the condition it was asked at whenever more
   *  than one condition is on the page, so no verdict there is unattributed; saying where the
   *  design was sized whenever that is not the nominal condition, so a design sized at a corner
   *  never reads as the nominal one; and, while the nominal design is held at one condition,
   *  saying so with the compliance answer there in place of a feasibility it was not asked. */
  const feasText = $derived.by((): string => {
    if (firstRun) return 'evaluating…';
    if (holding && single)
      return (
        `nominal design held at ${condLabel(single)}` +
        (heldCentre ? `: ${POINT_TEXT[heldCentre.state]}` : '')
      );
    const verdict = FEAS_TEXT[agg.feasibility];
    if (!agg.base) return verdict;
    if (multi) return `${verdict} at ${condLabel(agg.base)}`;
    return nominalKey && sameCondition(agg.base, nominalKey)
      ? verdict
      : `${verdict} · sized at ${condLabel(agg.base)}`;
  });
  const feasClass = $derived(
    holding ? POINT_CLASS[heldCentre?.state ?? 'not-run'] : FEAS_CLASS[agg.feasibility],
  );
  /** Whether the badge names the check that binds: on a verdict that fails — the design
   *  infeasible where it is sized, or the held design not complying where it is held. */
  const namesBinding = $derived(
    holding ? heldCentre?.state === 'does-not-comply' : agg.feasibility === 'infeasible',
  );
  /** The DC wiring check's verdict on the run shown, in a few words and the badge's class — none
   *  for a sheet that says it is not a circuit or names no wiring (see NodesReport.state). */
  const wiring = $derived.by((): { text: string; cls: string } | null => {
    const n = result?.nodes;
    if (!n || n.state === 'not-applicable') return null;
    if (n.state === 'not-evaluated') return { text: 'wiring: not evaluated', cls: 'skip' };
    if (n.state === 'checked-clean') return { text: 'wiring: clean', cls: 'ok' };
    return {
      text: `wiring: ${n.findings} ${n.findings === 1 ? 'finding' : 'findings'}`,
      cls: 'warn',
    };
  });
  /** Whether the sheet claims an operating range at all — read from the doc, so the range
   *  column is there even when no condition could be evaluated. */
  const hasRange = $derived((rr.doc.operatingRange ?? []).length > 0);
  /** Compliance is a question only once there is more than one point to ask it at: several
   *  conditions, or a declared operating range. A lone centre is feasibility under another name. */
  const hasCompliance = $derived(agg.compliance.total > 1);
  const complianceClass = $derived(
    agg.compliance.doesNotComply > 0
      ? 'no'
      : agg.compliance.complies === agg.compliance.total
        ? 'ok'
        : 'skip',
  );
  const complianceText = $derived.by(() => {
    const { complies, doesNotComply, noAnswer, notRun, total } = agg.compliance;
    const rest = [
      doesNotComply ? `${doesNotComply} fail` : '',
      noAnswer ? `${noAnswer} no answer` : '',
      notRun ? `${notRun} not run` : '',
    ].filter(Boolean);
    return [`complies at ${complies} of ${total} points`, ...rest].join(' · ');
  });

  // ── Range ends, in words. Every place a range end is shown names it the one way the core puts
  // it (rangeEndNames): the quantity and value its `set` fixes and which end of the claimed range
  // it is, read from the run on screen — never the end's bare name.
  const endNames = $derived(rangeEndNames(rr.doc, result?.rangeEnds ?? []));
  const endName = (name: string): string => endNames.get(name) ?? name;
  /** A point as a reader is told it: its condition, then the range end or the design's own
   *  operating point. */
  const pointName = (key: ConditionKey, rangeEnd: string | undefined): string =>
    `${condLabel(key)}, ${rangeEnd === undefined ? 'its own operating point' : endName(rangeEnd)}`;
  /** A check id as shown: one qualified by a range end (`cm-lo@sr-spec`) names the end. */
  const checkIdText = (id: string): string => {
    const at = id.indexOf(RANGE_END_SEP);
    return at < 0 ? id : `${id.slice(at + RANGE_END_SEP.length)} at ${endName(id.slice(0, at))}`;
  };
  /** One point's state in words, with why where it has no check outcomes to read. */
  const pointText = (pt: CompliancePoint): string =>
    POINT_TEXT[pt.state] + (pt.error ? ` — ${namingRangeEnds(pt.error, endNames)}` : '');
  /** The compliance badge's tooltip: what compliance is, then every point that does not comply,
   *  has no answer or was not run, each named where it is. */
  const complianceTitle = $derived(
    [
      CONTROL_HELP.compliance,
      ...runs.flatMap((r) =>
        r.points
          .filter((pt) => pt.state !== 'complies')
          .map((pt) => `${pointName(r.key, pt.rangeEnd)}: ${pointText(pt)}`),
      ),
    ].join('\n\n'),
  );
  /** Where each check comes closest to failing, over every point measured — a column of the
   *  check rows whenever there is more than one point to read. */
  const worstByCheck = $derived(hasCompliance ? worstPointByCheck(runs) : null);

  /** One condition's own answers, for the breakdown. Each is the run's own verdict beside its
   *  own label — the header never stands in for one of these, and none of them ever stands in
   *  for the header. */
  /** Whose hardware the row measured: the run that sized the design, or that design held. */
  const designCell = (r: ConditionRun): string =>
    r.state !== 'evaluated' ? '' : r.design === 'sized' ? 'sized here' : 'held';
  /** The centre: the sized run answers feasibility in its own words, a held one compliance. */
  const centreCell = (r: ConditionRun): string => {
    const at = r.points[0].state;
    if (r.state === 'evaluated' && r.design === 'sized' && at !== 'no-answer')
      return r.feasible ? '✓ feasible' : '✗ infeasible';
    return `${POINT_MARK[at]} ${POINT_TEXT[at]}`;
  };
  /** The range ends, as a count with the worst outcome's mark — the chips below carry each one. */
  const rangeCell = (r: ConditionRun): string => {
    const ends = r.points.slice(1);
    if (!ends.length) return '';
    const worst = (['does-not-comply', 'no-answer', 'not-run', 'complies'] as const).find((st) =>
      ends.some((e) => e.state === st),
    )!;
    const ok = ends.filter((e) => e.state === 'complies').length;
    return `${POINT_MARK[worst]} range ${ok}/${ends.length}`;
  };
  /** The range cell's tooltip: each range end of the row, named, with its answer. */
  const rangeTitle = (r: ConditionRun): string =>
    r.points
      .slice(1)
      .map((pt) => `${endName(pt.rangeEnd ?? '')}: ${pointText(pt)}`)
      .join('\n');
  const runClass = (r: ConditionRun): string => POINT_CLASS[r.points[0].state];
  /** The note a run that held the design carries for each device whose current it held as an
   *  ideal source (RangeEndReport / ConditionRun `assumedSource`): that device's givens name
   *  neither a width nor a current, so the current is held by assumption, not by anything the
   *  sheet authors. */
  const assumedSourceNotes = (paths: readonly string[] | undefined): string[] =>
    paths?.length
      ? [
          `⚠ the current of ${paths.map(deviceName).join(', ')} is held as an ideal source: ` +
            `${paths.length === 1 ? 'its givens name' : 'their givens name'} neither a width nor ` +
            `a current, so nothing on the sheet says where the current comes from — state one ` +
            `to hold the real source`,
        ]
      : [];
  /** A row's notes. On a held row: that its figures rest on a gate held at its nominal value — the
   *  warning a range-end chip carries in its tooltip, here on the row of the condition it was held
   *  at — and on a current held as an ideal source. On any row: where its noise figures come from,
   *  when that is not what the noise line above the detail says (rowNoiseNotes). */
  const rowNotes = (r: ConditionRun): string[] =>
    r.design === 'held'
      ? [
          ...(r.result?.warnings ?? [])
            .filter((w) => w.rule === 'sheet-held-gate')
            .map((w) => `⚠ ${w.message}`),
          ...assumedSourceNotes(r.state === 'evaluated' ? r.assumedSource : undefined),
          ...rowNoiseNotes(r),
        ]
      : rowNoiseNotes(r);
  /** The one-line reason: what stopped a refused condition, else why its centre has no check to
   *  read, else what binds (or is closest to binding) there, else the first range end that is
   *  not complying. */
  const runDetail = (r: ConditionRun): string => {
    if (r.state === 'not-evaluated' && r.points[0].state !== 'does-not-comply')
      return r.issues.map((i) => namingRangeEnds(i.message, endNames)).join(' · ');
    if (r.points[0].error) return namingRangeEnds(r.points[0].error, endNames);
    const b = r.result && (bindingCheck(r.result) ?? limitingCheck(r.result));
    const centre = b ? `${b.id} ${pct(b.marginPct)}` : '';
    const end = r.points.find((pt) => pt.rangeEnd !== undefined && pt.state !== 'complies');
    return [centre, end ? `${endName(end.rangeEnd ?? '')}: ${pointText(end)}` : '']
      .filter(Boolean)
      .join(' · ');
  };

  // The conditions the "chosen" mode offers: everything the device holds, plus any stored
  // choice that is no longer loaded — kept visible and still selectable, because a chosen
  // condition that vanished is an answer the panel owes ("not evaluated"), not a tidy-up.
  const chosenOptions = $derived.by(() => {
    const out = conditions.map((key) => ({ key, absent: false }));
    const have = new Set(conditions.map(conditionKeyId));
    for (const key of cornerKeys)
      if (!have.has(conditionKeyId(key))) out.push({ key, absent: true });
    return out.map((o) => ({
      ...o,
      on: cornerKeys.some((k) => sameCondition(k, o.key)),
    }));
  });
  const toggleKey = (key: ConditionKey): void =>
    onCornerKeys(
      cornerKeys.some((k) => sameCondition(k, key))
        ? cornerKeys.filter((k) => !sameCondition(k, key))
        : [...cornerKeys, key],
    );
  // The control appears once there is a choice to make, and stays visible whenever a panel is
  // in a non-default mode — a saved mode the user cannot see is a setting they cannot undo.
  const showCornerCtl = $derived(conditions.length > 1 || cornerMode !== 'nominal');

  // The picker deliberately does NOT preview feasibility. A verdict at a sheet's shipped
  // defaults says nothing about whether that topology can meet YOUR spec — the defaults are
  // someone else's operating point — so a ✓/✗ there reads as a recommendation while
  // carrying no information about the design in front of you. Answering it honestly means
  // searching each sheet's choice space against the entered spec, which is a different
  // feature (see the topology picker in the roadmap), not a decoration on a dropdown.

  // "infeasible" alone names no cause, and the offending check is often a child's — not in the
  // table below at all. Core owns the definition, so the badge and the 2-D map's per-cell cause
  // can never disagree about which check binds.
  const binding = $derived(result ? bindingCheck(result) : undefined);

  // ── Sensitivity readout: the missing half of a margin. A margin says how much room is left;
  // this says which knob moves it and how far, so an infeasible design comes with somewhere to
  // turn. Each knob costs TWO full evaluations, so it is never part of the reactive path — it is
  // a snapshot taken on click, against the doc and device it was taken at. When the design moves
  // under it the snapshot stops describing what is on screen, so it simply stops rendering rather
  // than ageing silently; one more click re-takes it. $state.raw: the snapshot holds the device
  // table, which must never be deep-proxied (megabytes of Float64Array), and identity comparison
  // against the props is the freshness test.
  type Snapshot = {
    doc: SheetDoc;
    dev: DeviceTable;
    focus: { id: string; marginPct: number } | undefined;
    rows: SheetSensitivity[];
  };
  let snap = $state.raw<Snapshot | null>(null);
  // Also retired when several conditions are selected, or the design is held: a sensitivity
  // readout is a statement about one operating point the design was sized at, the same rule that
  // disables taking a new one there.
  const oneSized = $derived(!multi && !holding);
  const shot = $derived(
    oneSized && snap && snap.doc === cfg && snap.dev === refTable ? snap : null,
  );
  const sens = $derived(shot?.rows ?? null);
  // A retired snapshot stops RENDERING through `shot` immediately; this drops the reference so it
  // stops holding a device table nobody is looking at any more — a switched-away table is
  // megabytes of Float64Array.
  $effect(() => {
    if (snap && snap !== shot) snap = null;
  });

  // The check the readout points at: the one that broke the design when something did; else, on
  // a feasible design that fails a range end, the check failing there; else the one closest to
  // breaking. All are core definitions over the whole composition, so the knobs are ranked
  // against the same check the badge or the chip names. Taken WITH the snapshot, not derived
  // reactively: the tree walk behind the limiting check would otherwise run on every slider
  // frame to answer a question only this readout asks, and any design change that could move the
  // answer retires the snapshot anyway.
  const focusCheck = $derived(shot?.focus);
  // One condition at a time: a ranking is a statement about the point it was taken at, and
  // there is no such point while several conditions are on screen.
  const sensReady = $derived(
    oneSized && evaluated && result !== undefined && refTable !== undefined,
  );
  /** The design being probed. It is set only while the request is pending, so it is also the
   *  busy state. */
  let sensFor = $state.raw<{ doc: SheetDoc; dev: DeviceTable } | null>(null);
  const sensBusy = $derived(sensFor !== null);
  function stopSens(): void {
    evaluator.cancel('sens');
    sensFor = null;
  }
  // A snapshot of a design that has since changed would not be shown, so stop computing it: the
  // worker runs one job at a time, and the verdict for the new design is waiting behind it.
  $effect(() => {
    if (sensFor && (sensFor.doc !== cfg || sensFor.dev !== refTable)) stopSens();
  });
  function toggleSens(): void {
    if (shot) {
      snap = null;
      return;
    }
    if (sensBusy) {
      stopSens();
      return;
    }
    if (!sensReady || !result || !refTable || !refKey || !primary) return;
    const focus = binding ?? rangeEndCheck(result) ?? limitingCheck(result);
    const doc = cfg;
    const dev = refTable;
    sensFor = { doc, dev };
    evaluator.request(
      // Naming the check keeps the probes off the range-end runs unless the check in question
      // lives on one — the difference between 2 and 2*(1 + range ends) evaluations per knob.
      { kind: 'sens', doc, at: refKey, ...(focus ? { check: focus.id } : {}), settings: solver },
      // The design the readout is about: the snapshot is shown while it is the one on screen.
      { bench, primary, refs, about: { doc, dev, focus } },
      (rows, answered) => {
        sensFor = null;
        snap = { ...answered.about, rows: rows ?? [] };
      },
      (e) => {
        sensFor = null;
        failed(e);
      },
    );
  }

  // Knobs ranked for that check. The ranking quantity is the margin change over ONE STEP of each
  // knob — a common fractional move — not the per-unit slope: the params are in different SI
  // units (a length against a gm/ID against a current), and a per-unit derivative would rank them
  // by how small their units are. Both directions are shown rather than one slope, because an
  // equality check's margin has a cusp at agreement where the two sides genuinely differ.
  const KNOBS_SHOWN = 3;
  const sensLines = $derived.by(() => {
    const rows = sens;
    const id = focusCheck?.id;
    if (!rows || id === undefined) return null;
    const knobs: { param: string; plus: number; minus: number; mag: number; step: number }[] = [];
    // A knob that could not be probed reports WHY (an unbounded zero, a range too narrow, an
    // evaluation that did not stand). Never a fabricated number in place of a missing one.
    const blocked: { param: string; why: string }[] = [];
    const reach = (v: number): number => (Number.isFinite(v) ? Math.abs(v) : 0);
    for (const s of rows) {
      const r = s.checks.find((x) => x.id === id);
      if (r && (Number.isFinite(r.deltaPlus) || Number.isFinite(r.deltaMinus)))
        knobs.push({
          param: s.param,
          plus: r.deltaPlus,
          minus: r.deltaMinus,
          mag: Math.max(reach(r.deltaPlus), reach(r.deltaMinus)),
          step: s.step,
        });
      else
        blocked.push({
          param: s.param,
          why: namingRangeEnds(
            s.error ?? `no response to "${checkIdText(id)}" was recorded`,
            endNames,
          ),
        });
    }
    knobs.sort((a, b) => b.mag - a.mag);
    return { knobs: knobs.slice(0, KNOBS_SHOWN), blocked: blocked.slice(0, KNOBS_SHOWN) };
  });

  // ── Feasibility sweep: vary one slider parameter across its range and chart every check's
  // relative margin. Only finitely-bounded params can be swept (the sweep walks [min,max]).
  const sweepable = $derived(cfg.params.filter((p) => isSweepable(p)));
  // The active sweep param, ignoring a stale selection that no longer names a sweepable var.
  const active = $derived(sweep && sweepable.some((p) => p.name === sweep) ? sweep : '');
  // The chart is drawn at ONE condition: the one asked about, or — with several on the page —
  // the one picked beside the sweep control, the condition the design is sized at until another
  // is picked. Where the design is sized at that condition, each sample re-sizes it there with the
  // knob at its value. Where the panel holds the nominal design at it (several conditions, or the
  // hold mode of a single one), each sample sizes the design at the nominal condition with the
  // knob at its value and holds it there, so the curves are that one design's margins at the
  // condition — the same question the condition rows answer, asked along the knob. A condition
  // that was not evaluated has no design to sweep and draws nothing; its row says why.
  let sweepPick = $state<string | null>(null);
  const sweepKey = $derived.by((): ConditionKey | undefined => {
    if (!multi) return single;
    const picked = runs.find((r) => conditionKeyId(r.key) === sweepPick)?.key;
    return picked ?? agg.base ?? runs[0]?.key;
  });
  /** Where each sample's design is sized, when that is not the chart's own condition. */
  const sweepBase = $derived(
    sweepKey && nominalKey && (multi || holding) && !sameCondition(sweepKey, nominalKey)
      ? nominalKey
      : undefined,
  );
  const sweepRun = $derived(sweepKey && runs.find((r) => sameCondition(r.key, sweepKey)));
  /** Whether there is a design to sweep: one sized at the chart's condition that was evaluated
   *  there, or — when it is held — one sized at the nominal condition that was evaluated, and held
   *  here far enough to have run. A held design that fails here still sweeps: along the knob it
   *  may come back. */
  const sweepReady = $derived.by((): boolean => {
    if (!sweepRun) return false;
    if (!sweepBase) return sweepRun.state === 'evaluated';
    const base = sweepBase;
    const sized = runs.find((r) => sameCondition(r.key, base));
    return sized?.state === 'evaluated' && sweepRun.result !== undefined;
  });
  let sweptAnswer = $state.raw<{
    answered: Answered<'sweep'>;
    sweep: ConditionSweep | null;
  } | null>(null);
  $effect(() => {
    ask(
      'sweep',
      active && sweepKey && sweepReady
        ? {
            kind: 'sweep',
            doc: rr.doc,
            param: active,
            at: sweepKey,
            ...(sweepBase ? { base: sweepBase } : {}),
            points: SWEEP_POINTS,
            settings: solver,
          }
        : undefined,
      (r) => (sweptAnswer = r && { answered: r.answered, sweep: r.result }),
    );
  });
  // Shown only while it answers the chart now asked for: the same param, at the same condition,
  // sized in the same place — a sweep of the previous one stays off the chart rather than being
  // drawn under the new caption.
  const swept = $derived.by((): ConditionSweep | null => {
    const job = sweptAnswer?.answered.job;
    if (!job || !sweepKey || job.param !== active || !sameCondition(job.at, sweepKey)) return null;
    if ((job.base === undefined) !== (sweepBase === undefined)) return null;
    return sweptAnswer?.sweep ?? null;
  });

  /** The swept parameter's unit — the caption's only use of it. */
  const sweptUnit = $derived(swept?.unit ?? '');

  // ── 2-D feasibility map: a second (×) param turns the 1-D margin chart into a design-plane
  // heatmap (feasible region vs the two params). Choices are the sweepable params minus the first.
  // One design plane belongs to one condition the design is sized at: with several selected, or
  // the nominal design held at one, there is no such plane, so the control is offered again as
  // soon as the panel sizes the design at the one condition it asks about.
  const sweepable2 = $derived(sweepable.filter((p) => p.name !== active));
  const active2 = $derived(
    oneSized && active && sweep2 && sweepable2.some((p) => p.name === sweep2) ? sweep2 : '',
  );
  const twoD = $derived(active2 !== ''); // active2 is only ever set while `active` is
  let swept2Answer = $state.raw<{ answered: Answered<'sweep2'>; map: SheetSweep2 | null } | null>(
    null,
  );
  $effect(() => {
    ask(
      'sweep2',
      twoD && evaluated && refKey
        ? {
            kind: 'sweep2',
            doc: rr.doc,
            param: active,
            param2: active2,
            at: refKey,
            points: SWEEP2_POINTS,
            settings: solver,
          }
        : undefined,
      (r) => (swept2Answer = r && { answered: r.answered, map: r.result }),
    );
  });
  const swept2 = $derived(
    swept2Answer?.answered.job.param === active && swept2Answer.answered.job.param2 === active2
      ? swept2Answer.map
      : null,
  );
  // The distinct hard-check ids (tree-path) that bound the infeasible region — the caption's "what
  // limits it", so the plane is never a wall of red with no named cause.
  const bindingIds = $derived.by(() => {
    const s = swept2;
    if (!s) return [];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive dedup scratch, rebuilt per recompute
    const ids = new Set<string>();
    for (const row of s.binding) for (const id of row) if (id) ids.add(id);
    return [...ids];
  });

  // One line per check, margin as a percentage; advisory checks dashed (never gate). The
  // y = 0 gridline is where a check sits exactly on its limit; PALETTE cycles the colours by default.
  //
  // The y window is FIXED at ±MARGIN_CLIP%. Checks like slew rate scale linearly with the swept
  // current and run to several thousand percent, which auto-scales every check near its boundary
  // into one flat band at y = 0 — hiding the only thing the chart is for. No zero crossing can
  // fall outside the window, so every feasibility edge survives; the data stays true (the chart
  // clips the view, the numbers are not clamped) and the checks table carries exact values.
  const MARGIN_CLIP = 100;
  const chartData = $derived.by((): ChartData | null => {
    if (!swept || swept.x.length === 0) return null;
    return {
      x: swept.x,
      lines: swept.checks.map((r) => r.marginPct.map((m) => (m == null ? null : m * 100))),
      lineLabels: swept.checks.map(checkLabel),
      lineDash: swept.checks.map((r) => (r.kind === 'advisory' ? [4, 3] : null)),
      yRange: [-MARGIN_CLIP, MARGIN_CLIP],
    };
  });

  // The contiguous span of the swept param where the design is feasible (the feasibility window)
  // — or, on a held sweep, where the held design complies at its own operating point.
  const feasWindow = $derived.by(() => {
    if (!swept || swept.feasible.length === 0) return null;
    const idx = swept.feasible.flatMap((f, i) => (f ? [i] : []));
    if (idx.length === 0) return { none: true as const };
    const lo = idx[0];
    const hi = idx[idx.length - 1];
    return {
      none: false as const,
      lo: swept.x[lo],
      hi: swept.x[hi],
      gap: idx.length !== hi - lo + 1,
    };
  });

  // The embedded uPlot chart, owned outside Svelte via the shared host: destroyed on
  // leaving sweep mode, refit in place on data edits, restyled on a theme/font change.
  let el: HTMLDivElement | undefined = $state();
  chartHost({
    el: () => el,
    data: () => chartData,
    active: () => active !== '' && !twoD,
    styleVersion: () => styleVersion,
  });

  // Immutable edits: every change emits a fresh doc so the parent's Object.assign + persist
  // path (identical to every other panel) carries it. Sheet-switch deep-copies so a panel
  // never aliases the shared menu literals.
  function setParam(name: string, value: number): void {
    if (!Number.isFinite(value)) return;
    onChange({ ...cfg, params: cfg.params.map((p) => (p.name === name ? { ...p, value } : p)) });
  }
  /** A menu entry's label: a sheet in a format this app does not read is named by that alone. */
  const menuLabel = (s: SheetDoc): string =>
    sheetFormat(s).format === 'unknown' ? unreadFormat(s.formatVersion) : s.title;
  function pickSheet(e: Event): void {
    const sel = e.currentTarget as HTMLSelectElement;
    const [gi, si] = sel.value.split(':').map(Number);
    sel.value = '';
    const src = menu[gi]?.sheets[si];
    if (!src) return;
    sheetSlot += 1;
    onChange(cloneDoc(src));
  }
  /** A binding the menu does not offer. A document written before children named devices
   *  stores a raw table uid; it still resolves, and is shown as the device it names rather than
   *  as something missing. A binding nothing answers to is the one that reads "not loaded". */
  const bindingOption = (binding: string): string => {
    const f = bench.deviceOf(binding);
    return f ? `${deviceLabel(f)} · stored by table` : `${describeBinding(binding)} (not loaded)`;
  };

  // Point the composed block at `path` — []=top sheet is never one, [i]=child i, [i,j]=grandchild
  // — at a specific loaded device (a device binding), or '' to inherit its parent's. The binding
  // lives in the block entry of the doc that holds the block, so any block whose entry is local
  // can be rebound; one inside a by-reference sheet belongs to that library sheet and has no
  // control (detach the reference to make it local).
  function setBlockDevice(path: number[], uid: string): void {
    onChange(
      updateBlockAt(cfg, path, (u) => {
        const { device: _drop, ...rest } = u;
        return uid ? { ...rest, device: uid } : rest;
      }),
    );
  }

  // ── Per-block operating point. A sheet sizes each device at its OWN vds/vsb; a
  // shared dashboard slider can't speak for a stack whose devices sit at different drains.
  // So each block owns its bias here: vds must be stated (no default), vsb defaults to 0.
  // A block's live bias axes come from its OWN sized report — the axes it sliced (bias) plus any
  // it must still state (needs). Reading them off the report, not the panel device, keeps the
  // control correct when a composed child sizes against a different loaded table than its parent.
  // BIAS_AXES (the core's namespace-derived canonical list) fixes the display order.
  // An axis the table does not sweep stays listed too (unswept): a value typed there that the
  // table cannot answer for must remain editable, not vanish with the refusal.
  const biasAxesFor = (r: SizingReport | undefined): string[] =>
    BIAS_AXES.filter(
      (a) =>
        (r?.bias != null && a in r.bias) ||
        (r?.needs?.includes(a) ?? false) ||
        (r?.unswept?.includes(a) ?? false),
    );
  // The authored declaration string for a bias axis (SheetGivens's vds/vsb are optional strings).
  const biasField = (givens: SheetGivens | undefined, axis: string): string | undefined =>
    (givens as unknown as Record<string, string | undefined> | undefined)?.[axis];
  // Editable here only when absent or a plain number: an expression (a param reference) stays
  // param-controlled, so writing a literal would silently sever the knob. Those show read-only.
  const isLiteral = (s: string | undefined): boolean => s === undefined || Number.isFinite(+s);
  // Write (or clear, on empty) a bias literal into the givens at `path` — []=top sheet, [i]=child
  // i, [i,j]=grandchild — and emit a fresh doc down the same immutable onChange path as setParam.
  function setBias(path: number[], axis: string, value: number | null): void {
    const edit = (doc: SheetDoc): SheetDoc => {
      if (!doc.givens) return doc;
      const givens = { ...doc.givens } as SheetGivens & Record<string, string | undefined>;
      if (value == null || !Number.isFinite(value)) delete givens[axis];
      else givens[axis] = String(value);
      return { ...doc, givens };
    };
    // A docless (by-reference) block has nothing local to write into — the control is not
    // rendered for those, so this is just the fail-safe.
    onChange(
      path.length
        ? updateBlockAt(cfg, path, (u) => (u.doc ? { ...u, doc: edit(u.doc) } : u))
        : edit(cfg),
    );
  }

  // Copy-on-write escape hatch: swap the by-reference block at `path` for an embedded
  // copy of the library sheet's AUTHORED doc — not the resolved subtree, so the
  // detached block's own nested refs stay live and a nested pinned snapshot stays
  // pinned, by construction. Local and editable from then on. cloneDoc: the index
  // holds library objects that must never alias into the panel's cfg.
  function detachRef(path: number[]): void {
    const ref = cfgBlockAt(path)?.ref;
    const hit = ref !== undefined ? refs.get(ref) : undefined;
    if (!hit || !('doc' in hit)) return; // unresolved — the button is not rendered here
    const inline = cloneDoc(hit.doc);
    onChange(
      updateBlockAt(cfg, path, (c) => {
        const { ref: _drop, ...rest } = c;
        return { ...rest, doc: inline };
      }),
    );
  }

  // Any by-reference block anywhere in the authored tree? Gates the flatten button.
  const docHasRefs = (d: SheetDoc): boolean =>
    (d.blocks ?? []).some((u) => u.ref !== undefined || (u.doc ? docHasRefs(u.doc) : false));
  const hasRefs = $derived(docHasRefs(cfg));

  // `doc` with the block at `path` (a non-empty index path from the top sheet) replaced by
  // `fn(block)`, copying each doc on the way down; every block control edits the sheet this way. A
  // path through a block with no local doc (a live reference) changes nothing past that block.
  function updateBlockAt(
    doc: SheetDoc,
    path: number[],
    fn: (block: SheetBlock) => SheetBlock,
    depth = 0,
  ): SheetDoc {
    return {
      ...doc,
      blocks: (doc.blocks ?? []).map((u, j) => {
        if (j !== path[depth]) return u;
        if (depth === path.length - 1) return fn(u);
        return u.doc ? { ...u, doc: updateBlockAt(u.doc, path, fn, depth + 1) } : u;
      }),
    };
  }

  // The AUTHORED block at `path` (childCard renders the resolved tree, which cannot tell
  // a live materialized ref from a hand-authored pinned ref+doc snapshot — only the raw
  // cfg can). Undefined once the path crosses into a referenced sheet's interior.
  function cfgBlockAt(path: number[]): SheetBlock | undefined {
    let u: SheetBlock | undefined;
    let d: SheetDoc | undefined = cfg;
    for (const i of path) {
      u = d?.blocks?.[i];
      d = u?.doc;
    }
    return u;
  }

  // A resolution error means flatten cannot inline every ref — the "self-contained"
  // promise would be silently broken, so the flat export is blocked (the same errors
  // are already on screen in the warning list).
  const flatBlocked = $derived(rr.warnings.some((w) => w.severity === 'error'));

  // Download the sheet as a JSON file: as-authored (refs stay refs — the shareable
  // source), or flattened through the library index (every ref inlined — the frozen,
  // self-contained deliverable).
  // One-click handoff of the EVALUATED numbers (name/value lines, engineering
  // notation): every computed value plus each child's, already child__-prefixed —
  // the recipe exports as JSON, the answers copy as text.
  let copied = $state(false);
  function copyResults(): void {
    if (!result) return;
    const rows = Object.entries(result.values)
      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
      .map(([k, v]) => `${k}\t${formatEng(v as number)}`);
    copyText([`# ${cfg.title}`, ...rows].join('\n'), (on) => (copied = on));
  }

  function exportSheet(flat: boolean): void {
    if (flat && flatBlocked) return; // fail-safe; the button is disabled in this state
    const doc = flat ? flattenSheetDoc(cfg, refs).doc : cfg;
    const name =
      cfg.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'sheet';
    const href = URL.createObjectURL(
      new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' }),
    );
    download(`${name}.json`, href, true);
  }

  /** The words the check table and its help use for the three check kinds. */
  const KIND_LABEL: Record<SheetCheck['kind'], string> = {
    physical: 'physical',
    spec: 'spec',
    advisory: 'advisory',
  };
  const fmt = (v: number | undefined): string =>
    v == null || !Number.isFinite(v) ? '—' : formatSI(v);
  /** A signed change, for the sensitivity readout: an explicit '+' so the direction reads at a
   *  glance, and '—' wherever a probe produced no number — never a stand-in zero. */
  const signedFmt = (v: number): string =>
    Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${formatSI(v)}` : '—';

  const rangeEndSolved = (e: RangeEndReport): string =>
    Object.entries(e.solved)
      .map(([k, v]) => `${k} ${fmt(v)}`)
      .join(' · ');
  /** The one-line detail beside a range-end chip, one wording per outcome. An end the held
   *  design complies at shows where its bias landed; one it does not shows why — its worst
   *  failing hard check (the same definition the badge uses, asked of that end's own run), or the
   *  reason a held device cannot work there. An end with NO ANSWER says what stopped the
   *  question, and one that was NOT RUN says what is missing: neither is a verdict about the
   *  range, and neither may borrow one's words. */
  const rangeEndDetail = (e: RangeEndReport): string => {
    if (e.state === 'not-run') return 'not run — these settings produce no design';
    if (e.state === 'complies') return rangeEndSolved(e);
    if (e.error) {
      const error = namingRangeEnds(e.error, endNames);
      return e.state === 'no-answer' ? `no answer — ${error}` : error;
    }
    const b = bindingCheck(e);
    return b ? `${b.id} ${pct(b.marginPct)}` : POINT_TEXT[e.state];
  };
  const rangeEndNote = $derived(new Map((cfg.operatingRange ?? []).map((e) => [e.name, e.note])));
  /** The run's own non-info diagnostics — a bias clamp fires exactly at a claim's extreme,
   *  and a green chip must not hide that it rests on clamped data. */
  const rangeEndWarns = (e: RangeEndReport): QAWarning[] =>
    e.warnings.filter((w) => w.severity !== 'info');
  // The tooltip carries WHICH point was checked (the resolved overrides), the authored note,
  // any run diagnostics, and — whenever the held design does not comply there — the full detail, because
  // the chip clamps long solver messages with an ellipsis. The concept-level help lives on the
  // group label.
  const rangeEndTitle = (e: RangeEndReport, detail: string): string => {
    const warns = rangeEndWarns(e)
      .map((w) => `⚠ ${namingRangeEnds(w.message, endNames)}`)
      .join('\n');
    // The name the sheet gives the end comes first: it is how a warning or an export refers to it.
    const at = `range end "${e.name}": ${endName(e.name)}`;
    return [
      at,
      rangeEndNote.get(e.name),
      warns,
      ...assumedSourceNotes(e.assumedSource),
      e.state === 'complies' ? '' : detail,
    ]
      .filter(Boolean)
      .join('\n\n');
  };
  /** One label for a range end's aggregate sweep curve, shared by the legend and the chart
   *  series — consumers read the field, never parse the id's trailing separator. The words are
   *  the reading: above zero the held design complies at that range end, below zero it does not. */
  const checkLabel = (r: { id: string; rangeEnd?: string }): string =>
    r.rangeEnd ? `complies at ${endName(r.rangeEnd)}` : r.id;
  const CHIP: Record<CheckStatus, string> = { pass: '✓', amber: '≈', fail: '✗', na: '—' };

  // Author check notes by id (a CheckResult carries no note — the physical-meaning note lives on
  // the authored SheetCheck). Top-level result.checks are cfg.checks in order, then the checks the
  // engine adds (engineChecks), whose ids an authored check may not take — so the id lookup is
  // exact, and an engine check simply has no note.
  const checkNote = $derived(new Map(cfg.checks.map((r) => [r.id, r.note])));
  const checkWhy = $derived(new Map(cfg.checks.map((r) => [r.id, r.justification])));
  // A check row's tooltip carries the check-SPECIFIC bits (its authored physical-meaning note and
  // any eval detail); the generic kind/amber/na explanations live on their own elements via
  // CONTROL_HELP. A check's authored prose for the row tooltip. `justification` is the author's
  // stated reason for a relaxed or unusual constraint — the thing a reviewer most needs — so it is
  // shown, not just stored. A title attribute is a plain-TEXT sink: math goes through mathPlain.
  // A CHILD's check is looked up in `childChecks` — the checks of the doc it was authored in.
  // Check ids are unique only WITHIN a sheet (ten shipped sheets carry a `feasible-inversion`),
  // so reading a child chip out of the top-level maps shows the parent's note for an unrelated
  // constraint. Absent ⇒ this sheet's own checks, which result.checks carry under the same ids.
  function checkTitle(r: CheckResult, childChecks?: readonly SheetCheck[]): string {
    const own = childChecks?.find((a) => a.id === r.id);
    const parts: string[] = [];
    const note = childChecks ? own?.note : checkNote.get(r.id);
    if (note) parts.push(note);
    const why = childChecks ? own?.justification : checkWhy.get(r.id);
    if (why) parts.push(`why: ${why}`);
    if (r.detail) parts.push(r.detail);
    return mathPlain(parts.join(' — '));
  }

  // The operating point a sizing sliced at — declared, or filled from the namespace default —
  // formatted "vds 0.9V, vsb 0V", so the bias behind a sized width is never invisible. A "?"
  // marks a coordinate the engine assumed rather than the author stating it (see givensAssumed).
  const biasStr = (b: Record<string, number> | undefined, assumed?: string[]): string =>
    b
      ? Object.entries(b)
          .map(([k, v]) => `${k} ${formatSI(v)}${axisUnit(k)}${assumed?.includes(k) ? '?' : ''}`)
          .join(', ')
      : '';
  const biasText = $derived(biasStr(result?.sizing?.bias, result?.sizing?.assumed));
  const biasHelp = (assumed: string[] | undefined): string =>
    CONTROL_HELP.givensBias + (assumed?.length ? `\n\n${CONTROL_HELP.givensAssumed}` : '');

  // An infeasible child's failing HARD checks (advisory ones excluded) — so the cause of a
  // red block is on screen, not just its ✗.
  const childFails = (c: SheetBlockReport | undefined): CheckResult[] =>
    c && !c.feasible ? c.checks.filter((r) => r.kind !== 'advisory' && r.status === 'fail') : [];

  // A design constraint whose search never landed leaves `values[name]` at whatever its last probe
  // tried, not a solved node — so the field must not present it as the value the design used.
  // The solver marks that failure as an error warning naming the param (solveFailed in the core's
  // eval).
  const constraintFailed = (p: SheetVar): boolean =>
    isConstrained(p) &&
    result !== undefined &&
    !result.feasible &&
    result.warnings.some((w) => w.message.includes(`constrained param "${p.name}"`));
  // The read-only field's tooltip: which mechanism owns the number, or that there is none.
  const solvedHelp = (p: SheetVar): string | undefined => {
    if (torn(p)) return CONTROL_HELP.solvedParam;
    if (!isConstrained(p)) return undefined;
    return constraintFailed(p) ? CONTROL_HELP.constraintNotMet : CONTROL_HELP.constrainedParam;
  };

  // Params group by role when ANY carries one (spec = the requirement, choice = the design knobs);
  // otherwise a single flat list, unchanged. Untagged params in a role-bearing doc trail ungrouped.
  const hasRoles = $derived(cfg.params.some((p) => p.role));
  /** A spec param named `*_target` is a target of the example specification the sheet opens
   *  with: a plausible number for its class, not a requirement — grouped and labelled as such. */
  const isTarget = (p: SheetVar): boolean => p.role === 'spec' && p.name.endsWith('_target');
  const targetParams = $derived(cfg.params.filter(isTarget));
  const specParams = $derived(cfg.params.filter((p) => p.role === 'spec' && !isTarget(p)));
  const choiceParams = $derived(cfg.params.filter((p) => p.role === 'choice'));
  const otherParams = $derived(cfg.params.filter((p) => !p.role));

  // ── The 2-D map is imperative (uPlot draws XY lines only): paint it by hand on a canvas,
  // reading --ok/--err/grid colours from CSS at draw time so it tracks the light/dark theme.
  let mapEl: HTMLCanvasElement | undefined = $state();
  function drawMap(canvas: HTMLCanvasElement, s: SheetSweep2): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cs = getComputedStyle(canvas);
    const ok = cs.getPropertyValue('--ok').trim() || '#3a9e5c';
    const err = cs.getPropertyValue('--err').trim() || '#d2596a';
    const grid = cs.color;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const nx = s.x.length;
    const ny = s.y.length;
    if (nx === 0 || ny === 0) return;
    const cw = w / nx;
    const ch = h / ny;
    // Feasible = green-ish, infeasible = red-ish (the status tokens, softened). paramY min sits at
    // the BOTTOM (yi = 0 → last drawn row), the usual design-plane orientation.
    for (let yi = 0; yi < ny; yi++) {
      const py = (ny - 1 - yi) * ch;
      for (let xi = 0; xi < nx; xi++) {
        const feas = s.feasible[yi][xi];
        ctx.fillStyle = feas ? ok : err;
        ctx.globalAlpha = feas ? 0.55 : 0.4;
        // +1 hides the seam between adjacent same-colour cells under sub-pixel rounding.
        ctx.fillRect(xi * cw, py, cw + 1, ch + 1);
      }
    }
    // A faint reference grid (quintiles) + border, light enough that the cells stay dominant.
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 5; i++) {
      const gx = Math.round((w * i) / 5) + 0.5;
      const gy = Math.round((h * i) / 5) + 0.5;
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Two effects, deliberately split: the observer lives as long as the CANVAS (its
  // callback reads the current sweep at fire time), while repaints key on the data and
  // the theme/font epoch. One combined effect would tear down and rebuild the observer
  // on every slider tick — and double-paint, since observe() fires synchronously.
  $effect(() => {
    const canvas = mapEl;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const s = swept2;
      if (s && s.x.length > 0) drawMap(canvas, s);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  });
  // styleVersion is read (always ≥ 0) only to register the dependency, so a theme flip
  // that changes --ok/--err triggers a redraw.
  $effect(() => {
    const canvas = mapEl;
    const s = swept2;
    if (styleVersion >= 0 && canvas && s && s.x.length > 0) drawMap(canvas, s);
  });
</script>

{#snippet paramRow(p: SheetVar)}
  <label class="svar" title={p.note && mathPlain(p.note)} data-param={p.name}>
    <span class="vn"
      >{@html qLabel(p.name)}{#if p.unit}<i>{p.unit}</i>{/if}</span
    >
    <!-- A solved param is found, not set: show where the search landed (the authored value is
         never read) and refuse edits, rather than offering a knob the next evaluation ignores.
         A solve that did not land has nothing to show, so it reads "—". -->
    <input
      class="num"
      class:solved={engineSolved(p)}
      type="text"
      inputmode="text"
      spellcheck="false"
      readonly={engineSolved(p)}
      tabindex={engineSolved(p) ? -1 : undefined}
      title={solvedHelp(p)}
      value={constraintFailed(p)
        ? '—'
        : formatEng(engineSolved(p) ? (result?.values[p.name] ?? p.value) : p.value)}
      onchange={(e) => commitEng(e.currentTarget, p.value, (v) => v != null && setParam(p.name, v))}
    />
    {#if isSweepable(p)}
      <input
        class="sld"
        type="range"
        min={p.min}
        max={p.max}
        step={(p.max - p.min) / 100}
        value={p.value}
        oninput={(e) => setParam(p.name, +(e.currentTarget as HTMLInputElement).value)}
      />
    {/if}
  </label>
{/snippet}

<!-- Per-block operating point: one editable field per live bias axis, writing into THIS block's
     givens at `path`. A field the givens must state (vds, no default) but haven't reads "needs"; body
     bias (vsb) pre-fills its default 0. A param-driven declaration shows read-only (edit the param). -->
{#snippet biasCtl(
  givens: SheetGivens | undefined,
  report: SizingReport | undefined,
  path: number[],
)}
  {@const axes = biasAxesFor(report)}
  {#if givens && axes.length}
    <div class="sbiasctl">
      {#each axes as ax}
        {@const decl = biasField(givens, ax)}
        {@const need = report?.needs?.includes(ax) ?? false}
        {#if isLiteral(decl)}
          <label
            class="bx"
            class:need
            title={need ? CONTROL_HELP.givensNeeds : CONTROL_HELP.givensBias}
          >
            <span>{@html qLabel(ax)}</span>
            <input
              class="num"
              type="text"
              inputmode="text"
              spellcheck="false"
              placeholder={need ? 'set' : ''}
              value={decl !== undefined ? formatEng(+decl) : (report?.bias?.[ax] ?? '')}
              onchange={(e) =>
                commitEng(e.currentTarget, report?.bias?.[ax], (v) => setBias(path, ax, v), true)}
            /><i>V</i>
          </label>
        {:else}
          <span class="bx ro" title={CONTROL_HELP.givensBias}
            >{@html qLabel(ax)}=<code>{@html qFormula(decl ?? '')}</code></span
          >
        {/if}
      {/each}
    </div>
  {/if}
{/snippet}

<!-- One composed block as a self-contained card: its sizing, the operating point it's sized at,
     the scalars it hands up, its failing constraints, and — recursively — its own children, so the
     composition tree reads as nested modules. `block` is this card's entry from the RESOLVED tree
     (a by-reference child carries its materialized doc plus the ref as provenance); `path` is its
     index path from the top sheet; `inRef` marks a card living INSIDE a referenced sheet, whose
     internals belong to the library sheet and are read-only here. -->
{#snippet childCard(
  c: SheetBlockReport | undefined,
  block: SheetBlock | undefined,
  path: number[],
  inRef: boolean = false,
)}
  <!-- An authored ref+doc pair is a PINNED snapshot: the embedded copy wins (core rule),
       so the block is local and editable — only its badge differs. A ref WITHOUT a local
       doc is live: its internals belong to the library sheet and render read-only. -->
  {@const authored = inRef ? undefined : cfgBlockAt(path)}
  {@const pinned = authored?.ref !== undefined && authored?.doc !== undefined}
  {@const isRef = inRef || (block?.ref !== undefined && !pinned)}
  <!-- Three states, not two: a block whose condition was never evaluated has no verdict, and a
       ✗ would report one. It still renders — its device control is how the refusal is fixed. -->
  {@const state = c === undefined ? 'skip' : c.feasible ? 'pass' : 'fail'}
  <div class="suse st-{state}">
    <div class="suseh">
      <span class="chip">{state === 'skip' ? '–' : state === 'pass' ? '✓' : '✗'}</span>
      <b>{c?.name ?? block?.name}</b><i>{c?.title ?? block?.doc?.title}</i>
      {#if block?.ref}
        {#if pinned}
          <span
            class="refb pinned"
            title="pinned snapshot of {block.ref} — the embedded copy wins and no longer tracks the library sheet; internals are local and editable"
            >⤷ {block.ref} · pinned</span
          >
        {:else}
          <span class="refb" title={CONTROL_HELP.refBlock}>⤷ {block.ref}</span>
          <!-- Only a MATERIALIZED ref can detach (an unresolved one has nothing to copy —
               rendering the button would be a dead control). -->
          {#if !inRef && block.doc}
            <button class="detach" title={CONTROL_HELP.detachRef} onclick={() => detachRef(path)}
              >detach</button
            >
          {/if}
        {/if}
      {/if}
      <!-- Any block whose entry is local gets the control, at any depth: the binding is written
           into the doc that holds it. A block inside a live reference has none (authored is
           undefined there) — its entry belongs to the library sheet. -->
      {#if authored && (bench.options.length > 0 || authored.device)}
        <span class="dsl" title={CONTROL_HELP.blockDevice}>device</span>
        <select
          class="dsel"
          title={CONTROL_HELP.blockDevice}
          value={authored.device ?? ''}
          onchange={(e) => setBlockDevice(path, (e.currentTarget as HTMLSelectElement).value)}
        >
          <option value=""
            >{path.length === 1 ? '↳ active device' : '↳ parent block’s device'}</option
          >
          {#if authored.device && !bench.options.some((o) => o.binding === authored.device)}
            <option value={authored.device}>{bindingOption(authored.device)}</option>
          {/if}
          {#each bench.options as o}<option value={o.binding}>{o.label}</option>{/each}
        </select>
      {/if}
    </div>
    {#if block?.doc?.description}
      <p class="snote sudesc">{@html mathText(block.doc.description)}</p>
    {/if}
    {#if c?.sizing?.ok}
      <div class="susebind">
        W={fmt(c.sizing.W)}m · V<sub>GS</sub>={fmt(c.sizing.vgs)}V · I<sub>D</sub>={fmt(
          c.sizing.id,
        )}A
        {#if c.sizing.bias}<span class="sbias" title={biasHelp(c.sizing.assumed)}
            >@ {biasStr(c.sizing.bias, c.sizing.assumed)}</span
          >{/if}
      </div>
    {:else if c?.sizing}
      <div class="perr" title={c.sizing.error}>sizing: {c.sizing.error}</div>
    {/if}
    <!-- A referenced block's givens belong to the library sheet — no in-place bias editor
         (the applied operating point still shows in the sizing line; params remain the
         customization channel, and detach makes the internals local). -->
    {#if !isRef}{@render biasCtl(block?.doc?.givens, c?.sizing, path)}{/if}
    {#if c && Object.keys(c.provides).length}
      <div class="prov" title={CONTROL_HELP.provide}>
        {#each Object.entries(c.provides) as [k, v]}<code
            >{@html qFormula(joinProvide(c.name, k))}={fmt(v)}</code
          >{/each}
      </div>
    {/if}
    {#if childFails(c).length}
      <div class="cfails">
        {#each childFails(c) as r}<span
            class="cfail"
            title={checkTitle(r, block?.doc?.checks ?? [])}>✗ {r.id} {pct(r.marginPct)}</span
          >{/each}
      </div>
    {/if}
    {#if c?.blocks?.length}
      <div class="skids">
        {#each c.blocks as gc, k}{@render childCard(
            gc,
            block?.doc?.blocks?.[k],
            [...path, k],
            isRef,
          )}{/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet picker()}
  <select class="rm" onchange={pickSheet} title={CONTROL_HELP.sheet}>
    <option value="" selected>sheet…</option>
    {#each menu as g, gi}
      <optgroup label={g.label}>
        {#each g.sheets as s, si}<option value={`${gi}:${si}`}>{menuLabel(s)}</option>{/each}
      </optgroup>
    {/each}
  </select>
{/snippet}

<div class="sheet">
  {#if refusal}
    <!-- A document in a format this app does not read: the reason, and the picker that replaces
       it. Nothing else is read from it. -->
    <div class="shead">{@render picker()}</div>
    <p class="perr prefused" data-refused>{refusal}</p>
  {:else}
    {#if restoreNote}
      <p class="perr srestore" data-restore-lost>{restoreNote}</p>
    {/if}
    <div class="shead">
      {@render picker()}
      <strong>{cfg.title}</strong>
      <!-- Two answers, never one. FEASIBILITY: the design where it was sized — stamped with that
         condition whenever more than one is on the page. COMPLIANCE: how many of the points the
         design is promised to work at it was found to comply at, with the ones that failed, the
         ones that could not be answered and the ones never run each counted apart. -->
      <span
        class="feasb {feasClass}"
        title={holding ? CONTROL_HELP.cornerHold : CONTROL_HELP.feasBadge}
        data-feasibility
      >
        {feasText}{#if binding && namesBinding}<i>{binding.id} {pct(binding.marginPct)}</i>{/if}
      </span>
      {#if hasCompliance}
        <span class="compb {complianceClass}" title={complianceTitle} data-compliance
          >{complianceText}</span
        >
      {/if}
      <!-- The solver ran under settings other than its defaults: these numbers are not the ones
         the same sheet gives at the defaults, and the tooltip lists what differs. -->
      {#if solverChanged.length}
        <span class="ssolver" title={solverTitle} data-solver-nondefault
          >solver settings: non-default</span
        >
      {/if}
      {#if wiring}
        <span class="wireb {wiring.cls}" title={CONTROL_HELP.wiringState} data-wiring
          >{wiring.text}</span
        >
      {/if}
      {#if busyText}
        <span class="sbusy" role="status" data-busy title={CONTROL_HELP.evaluating}>{busyText}</span
        >
      {/if}
      {#if refKey && !multi}
        <span class="scond" data-condition={condLabel(refKey)} title={CONTROL_HELP.cornerMode}
          >at {condLabel(refKey)}</span
        >
      {/if}
      <!-- What the verdict rests on: a doc-level fact carried on the result, so it costs nothing
         here and reads the same whichever condition the reference run is. -->
      {#if evaluated && result?.assumptions?.length}
        <span class="sassume" title={CONTROL_HELP.assumptions}
          >sized under {result.assumptions.length}
          {result.assumptions.length === 1 ? 'assumption' : 'assumptions'}: {result.assumptions.join(
            ', ',
          )}</span
        >
      {/if}
      <!-- Which noise the noise rows are: the table's own, or the γ = 1.0 estimate, and any figure a
         missing column made fall back to a lesser form (the tooltip spells each one out). -->
      {#if evaluated && noiseText}
        <span class="snoise" title={noiseTitle}>noise: {noiseText}</span>
      {/if}
      <!-- Which numbers are read at the characterization width: the pass-through columns. -->
      {#if evaluated && unscaled.length}
        <span class="snoise" data-passthrough title={CONTROL_HELP.passthrough}
          >at w0, not scaled: {unscaled.join(', ')}</span
        >
      {/if}
      <!-- What each held expression came to at this run: the gate bias a node under a gate needs,
         or the zero a current balance reads. -->
      {#if evaluated && result?.held && Object.keys(result.held).length}
        <span class="sassume" data-held title={CONTROL_HELP.held}
          >holds {Object.entries(result.held)
            .map(
              ([name, v]) =>
                `${cfg.params.find((p) => p.name === name)?.hold ?? name} at ${fmt(v)}`,
            )
            .join(' · ')}</span
        >
      {/if}
      <!-- On demand only: each knob costs two full evaluations, so this never runs with the badge. -->
      <button
        class="sensb"
        class:on={sens !== null || sensBusy}
        disabled={!sensReady && !shot && !sensBusy}
        title={oneSized ? CONTROL_HELP.sensitivity : CONTROL_HELP.cornerOneAtATime}
        onclick={toggleSens}>{sensBusy ? 'sensitivities…' : 'sensitivities'}</button
      >
      {#if result?.sizing && !multi}
        {#if result.sizing.ok}
          <span class="bind"
            >W={fmt(result.sizing.W)}m · V<sub>GS</sub>={fmt(result.sizing.vgs)}V · I<sub>D</sub
            >={fmt(result.sizing.id)}A</span
          >
          {#if biasText}
            <span class="sbias" title={biasHelp(result.sizing?.assumed)}>@ {biasText}</span>
          {/if}
        {:else}
          <span class="perr" title={result.sizing.error}>sizing: {result.sizing.error}</span>
        {/if}
        {@render biasCtl(cfg.givens, result.sizing, [])}
      {/if}
      {#if sweepable.length}
        <label class="swsel" title={CONTROL_HELP.sheetSweep}>
          sweep
          <select
            value={active}
            onchange={(e) => onSweep((e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">off</option>
            {#each sweepable as p}<option value={p.name}>{p.name}</option>{/each}
          </select>
        </label>
      {/if}
      <!-- With several conditions on the page the chart still draws one: this one. -->
      {#if active && multi && runs.length}
        <label class="swsel" title={CONTROL_HELP.sweepAt}>
          at
          <select
            data-sweep-at
            value={sweepKey ? conditionKeyId(sweepKey) : ''}
            onchange={(e) => (sweepPick = (e.currentTarget as HTMLSelectElement).value)}
          >
            {#each runs as r (conditionKeyId(r.key))}
              <option value={conditionKeyId(r.key)}
                >{condLabel(r.key)}{r.design === 'sized' ? ' (sized)' : ' (held)'}</option
              >
            {/each}
          </select>
        </label>
      {/if}
      {#if active && sweepable2.length}
        <label
          class="swsel2"
          title={oneSized ? CONTROL_HELP.sheetSweep2 : CONTROL_HELP.cornerOneAtATime}
        >
          ×
          <select
            value={active2}
            disabled={!oneSized}
            onchange={(e) => onSweep2((e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">off</option>
            {#each sweepable2 as p}<option value={p.name}>{p.name}</option>{/each}
          </select>
        </label>
      {/if}
      <span class="sexp">
        <button title={CONTROL_HELP.copyResults} disabled={!result} onclick={copyResults}
          >{copied ? 'copied ✓' : 'copy results'}</button
        >
        <button title={CONTROL_HELP.exportSheet} onclick={() => exportSheet(false)}>⤓ json</button>
        {#if hasRefs}
          <button
            disabled={flatBlocked}
            title={flatBlocked
              ? 'a reference did not resolve (see warnings) — a flattened export could not be self-contained'
              : CONTROL_HELP.exportFlat}
            onclick={() => exportSheet(true)}>⤓ flat</button
          >
        {/if}
      </span>
    </div>

    <!-- Which conditions this panel asks about. Bench state, never written into the document:
       the sheet describes the design; which corners are loaded is a property of this bench. -->
    {#if showCornerCtl}
      <div class="scorners">
        <span class="glabel" title={CONTROL_HELP.cornerMode}>conditions</span>
        <select
          data-corner-mode
          value={cornerMode}
          onchange={(e) =>
            onCornerMode((e.currentTarget as HTMLSelectElement).value as SheetCornerMode)}
        >
          <option value="nominal">nominal</option>
          <option value="active">active table</option>
          <option value="chosen">chosen</option>
          <option value="all">all ({conditions.length})</option>
        </select>
        {#if cornerMode === 'chosen'}
          {#each chosenOptions as c (conditionKeyId(c.key))}
            <label class="ckey" class:absent={c.absent}>
              <input type="checkbox" checked={c.on} onchange={() => toggleKey(c.key)} />{condLabel(
                c.key,
              )}{#if c.absent}<i>not loaded</i>{/if}
            </label>
          {/each}
        {/if}
        <!-- One condition that is not the nominal one is two questions: a design sized there, or
           the nominal design held there. Sized where asked is the default. -->
        {#if offNominal}
          <select
            data-corner-hold
            title={CONTROL_HELP.cornerHold}
            value={holding ? 'hold' : 'size'}
            onchange={(e) => onCornerHold((e.currentTarget as HTMLSelectElement).value === 'hold')}
          >
            <option value="size">sized where asked</option>
            <option value="hold">hold the nominal design here</option>
          </select>
        {/if}
      </div>
    {/if}

    <!-- Nothing to evaluate. Each of these states says which choice is missing and offers the
       control that makes it — never a quiet substitution of some other condition. -->
    {#if blocked === 'undesignated' && primary}
      <div class="snotev" data-blocked="nominal">
        <p>
          <b>{primary.device}</b> is loaded at {conditions.length}
          {conditions.length === 1 ? 'condition' : 'conditions'} and none of them is designated nominal{#if primary.nominalSource === 'unresolved'}
            — the designated table is no longer loaded{/if}. This panel evaluates at the nominal
          condition, so it needs one named.
        </p>
        <div class="snomctl">
          {#each primary.conditions as t (tableUid(t))}
            <button onclick={() => bench.designate(primary.deviceUid, tableUid(t))}
              >designate {condLabel(t.id)}</button
            >
          {/each}
        </div>
      </div>
    {:else if blocked === 'none-chosen'}
      <div class="snotev" data-blocked="chosen">
        <p>no condition is chosen — tick one above, or switch back to nominal.</p>
      </div>
    {:else if blocked === 'no-device'}
      <div class="snotev" data-blocked="device">
        <p>no device is loaded for this panel.</p>
      </div>
    {/if}

    <!-- Every selected condition, each with its own two answers and its own label. The aggregate
       in the header is a fold of exactly these rows, and never replaces them. Holding the nominal
       design at one condition is two of them: where it was sized, and where it is held. -->
    {#if multi || holding}
      <!-- The tightest reading over the points that were MEASURED, labelled as such and naming
         where it was read: it is a display fold, and it must never be read as a margin over
         points that were not run or returned no answer. -->
      {#if agg.worst}
        <p class="scap" title={CONTROL_HELP.compliance} data-worst>
          tightest hard check over every point measured: {agg.worst.id}
          {pct(agg.worst.marginPct)} at {pointName(agg.worst.key, agg.worst.rangeEnd)}
        </p>
      {/if}
      <table class="scorntab">
        <tbody>
          {#each runs as r (conditionKeyId(r.key))}
            {@const detail = runDetail(r)}
            {@const notes = rowNotes(r)}
            <tr class="st-{runClass(r)}" data-corner-row={condLabel(r.key)}>
              <td class="ccond">{condLabel(r.key)}</td>
              <td class="cdes" title={CONTROL_HELP.cornerDesign}>{designCell(r)}</td>
              <td class="ccl">{centreCell(r)}</td>
              {#if hasRange}<td class="ccv" title={rangeTitle(r)}>{rangeCell(r)}</td>{/if}
              <td class="ccd" title={[detail, ...notes].filter(Boolean).join('\n\n')}
                >{#if notes.length}⚠&nbsp;{/if}{detail}</td
              >
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <!-- A condition with no verdict — refused before the engine ran, or started and not completed:
       only the named reason, which is a different thing from a design that is infeasible. The
       words match the badge: "no answer" when a run started, "not evaluated" when none did. -->
    {#if refRun && refRun.state === 'not-evaluated'}
      <div class="snotev" data-not-evaluated={condLabel(refRun.key)}>
        <p>
          <b>{refRun.result ? 'no answer' : 'not evaluated'} at {condLabel(refRun.key)}</b>
        </p>
        {#each refRun.issues as issue}
          <p class="sissue">{issue.message}</p>
        {/each}
        {#if refRun.result}
          <p class="sissue">
            The numbers below are what the run produced before it stopped — diagnostics, not a
            verdict.
          </p>
        {/if}
      </div>
    {/if}

    {#if multi && result && refKey}
      <p class="scap sstamp">
        detail below is <b>{condLabel(refKey)}</b> — one of {runs.length} conditions
      </p>
    {:else if holding && result && refKey && agg.base}
      <p class="scap sstamp">
        detail below is the design sized at <b>{condLabel(agg.base)}</b>, held at
        <b>{condLabel(refKey)}</b>
      </p>
    {/if}

    {#if sensLines}
      <div class="ssens">
        <span class="glabel" title={CONTROL_HELP.sensitivity}>sensitivities</span>
        {#if focusCheck}
          <p class="scap">
            how <b>{checkIdText(focusCheck.id)}</b>’s margin moves per {SENSITIVITY_REL_STEP * 100}%
            step of each knob, in that check’s own units — ↑ raises the knob, ↓ lowers it
          </p>
          {#each sensLines.knobs as k}
            <div class="skline" title="step {fmt(k.step)} on {k.param}">
              <code>{k.param}</code>
              <span>↑ {signedFmt(k.plus)}</span>
              <span>↓ {signedFmt(k.minus)}</span>
            </div>
          {/each}
          {#each sensLines.blocked as b}
            <div class="skline dead"><code>{b.param}</code><span>{b.why}</span></div>
          {/each}
          {#if !sensLines.knobs.length && !sensLines.blocked.length}
            <div class="skline dead">this sheet has no free design knob to probe</div>
          {/if}
        {:else}
          <div class="skline dead">no hard check reports a finite margin to rank knobs against</div>
        {/if}
      </div>
    {/if}

    {#if cfg.description}
      <p class="sdesc">{@html mathText(cfg.description)}</p>
    {/if}

    {#if hasRoles}
      {#if specParams.length}
        <div class="sgroup">
          <span class="glabel" title={CONTROL_HELP.paramRole}>spec</span>
          <div class="svars">
            {#each specParams as p}{@render paramRow(p)}{/each}
          </div>
        </div>
      {/if}
      {#if targetParams.length}
        <div class="sgroup" data-example-spec>
          <span class="glabel" title={CONTROL_HELP.exampleSpec}
            >example spec — replace with your design’s</span
          >
          <div class="svars">
            {#each targetParams as p}{@render paramRow(p)}{/each}
          </div>
        </div>
      {/if}
      {#if choiceParams.length}
        <div class="sgroup">
          <span class="glabel" title={CONTROL_HELP.paramRole}>choice</span>
          <div class="svars">
            {#each choiceParams as p}{@render paramRow(p)}{/each}
          </div>
        </div>
      {/if}
      {#if otherParams.length}
        <div class="svars">
          {#each otherParams as p}{@render paramRow(p)}{/each}
        </div>
      {/if}
    {:else}
      <div class="svars">
        {#each cfg.params as p}{@render paramRow(p)}{/each}
      </div>
    {/if}

    <!-- The evaluated detail. It exists only when a run produced numbers: a condition that was
       refused before the engine ran has none, and nothing here invents them. -->
    <!-- Outside the evaluated gate: these carry each block's device choice, which is exactly what
       a designer reaches for when a condition was refused for want of one. -->
    {#if cfg.blocks?.length}
      <div class="suses">
        <span class="glabel" title={CONTROL_HELP.provide}>composed blocks</span>
        {#each cfg.blocks as _u, i}
          {@render childCard(result?.blocks?.[i], rr.doc.blocks?.[i], [i], false)}
        {/each}
      </div>
    {/if}

    {#if result}
      {@const res = result}
      {#if cfg.equations.length}
        <div class="srows">
          {#each cfg.equations as eq}
            <div class="srow">
              <span class="seq"
                ><b>{@html qLabel(eq.name)}</b> = {@html qFormula(eq.expr)} =
                <span class="sval">{fmt(res.values[eq.name])}{eq.unit ?? ''}</span></span
              >
              {#if eq.note}<span class="snote">{@html mathText(eq.note)}</span>{/if}
            </div>
          {/each}
        </div>
      {/if}

      <table class="srules" class:worsted={worstByCheck !== null}>
        <tbody>
          {#each res.checks as r}
            <tr class="st-{r.status}" class:advisory={r.kind === 'advisory'} title={checkTitle(r)}>
              <td
                class="chip"
                title={r.status === 'amber'
                  ? CONTROL_HELP.amber
                  : r.status === 'na'
                    ? CONTROL_HELP.checkNa
                    : undefined}>{CHIP[r.status]}</td
              >
              <td class="rid"
                ><b>{r.id}</b><i title={CONTROL_HELP.checkKind}>{KIND_LABEL[r.kind]}</i></td
              >
              <td class="rtext">
                <span class="req">{@html qFormula(r.text)}</span>
                {#if checkNote.get(r.id)}<span class="snote"
                    >{@html mathText(checkNote.get(r.id) ?? '')}</span
                  >{/if}
                {#if r.detail}<span class="snote sdetail">{r.detail}</span>{/if}
              </td>
              <td class="rnum">{fmt(r.lhsValue)} / {fmt(r.rhsValue)}</td>
              <td class="rmar">{r.status === 'na' ? '—' : pct(r.marginPct)}</td>
              <!-- Where this check is tightest over every point measured: the condition, and the
                 range end or the design's own operating point. -->
              {#if worstByCheck}
                {@const w = worstByCheck.get(r.id)}
                <td class="rworst" title={CONTROL_HELP.worstAt} data-worst-at={r.id}
                  >{#if w}worst {pct(w.marginPct)} at {pointName(
                      w.key,
                      w.rangeEnd,
                    )}{:else}—{/if}</td
                >
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>

      {#if res.rangeEnds?.length}
        <div class="sedges">
          <span class="glabel" title={CONTROL_HELP.operatingRange}>operating range</span>
          {#each res.rangeEnds as e (e.name)}
            {@const detail = rangeEndDetail(e)}
            <span
              class="sedge {POINT_CLASS[e.state]}"
              title={rangeEndTitle(e, detail)}
              data-range-end={e.name}
            >
              {POINT_MARK[e.state]}
              {endName(e.name)}{#if rangeEndWarns(e).length || e.assumedSource?.length}&nbsp;⚠{/if}
              {#if detail}<i>{detail}</i>{/if}
            </span>
          {/each}
        </div>
      {/if}
    {/if}

    {#if twoD && swept2 && swept2.x.length}
      <div class="scap">
        feasibility · <b>{active}</b> × <b>{active2}</b> — green is feasible, red fails a hard check (X
        → right, Y ↑)
      </div>
      <div class="smap">
        <div class="smy">
          {active2}
          {fmt(swept2.y[0])}…{fmt(swept2.y[swept2.y.length - 1])}{swept2.unitY}
        </div>
        <canvas class="smapc" bind:this={mapEl}></canvas>
        <div class="smx">
          {active}
          {fmt(swept2.x[0])}…{fmt(swept2.x[swept2.x.length - 1])}{swept2.unitX}
        </div>
      </div>
      <p class="feas">
        {#if bindingIds.length}
          region bounded by: {bindingIds.join(', ')}
        {:else}
          no hard check fails across this plane
        {/if}
      </p>
    {:else if active && chartData && !twoD && swept}
      {@const at = condLabel(swept.key)}
      <!-- Which of the two curves this is: the design sized at the chart's condition at every
         sample, or the nominal design held there. -->
      <div class="scap" data-sweep-caption data-sweep-design={swept.design}>
        margin (%) vs <b>{active}</b>{#if sweptUnit}
          ({sweptUnit}){/if} at <b>{at}</b> —
        {#if swept.design === 'held'}
          the nominal design held there: each sample sizes the design at {condLabel(swept.base)} with
          {active} at that value and holds it at {at} — widths, lengths, currents and gate biases fixed
          — so the curves are that design’s margins at {at}{#if (cfg.operatingRange ?? []).length},
            its own range ends included{/if}.
        {:else}
          sized there: each sample re-sizes the design at {at} with {active} at that value{#if (cfg.operatingRange ?? []).length}
            · each sample holds its OWN design at the range ends, so the range-end curves move with
            the sweep and never change what is feasible{/if}.
        {/if}
        The 0 line is where a check sits exactly on its limit; dashed = advisory; clipped at ±{MARGIN_CLIP}%.
      </div>
      <div class="pchart" bind:this={el}></div>
      <!-- Colour key: ten unlabelled lines are unreadable, and this panel has no shared footer
         legend the way a data panel does. Index order matches what ChartAdapter strokes. An
         advisory check is dashed on the chart and tagged here, since an inline-styled swatch cannot
         carry the dash. -->
      <div class="skey">
        {#each swept.checks as r, i}
          <span class="kitem"
            ><i style="background:{PALETTE[i % PALETTE.length]}"></i>{checkLabel(
              r,
            )}{#if r.kind === 'advisory'}&nbsp;·&nbsp;adv{/if}</span
          >
        {/each}
      </div>
      {#if feasWindow}
        <p class="feas">
          {#if swept.design === 'held'}
            {#if feasWindow.none}
              the held design complies at {at} nowhere in this range of {active}
            {:else}
              the held design complies at {at} for {active} ≈ {fmt(feasWindow.lo)}…{fmt(
                feasWindow.hi,
              )}{sweptUnit}{#if feasWindow.gap}
                (non-contiguous){/if}
            {/if}
          {:else if feasWindow.none}
            no feasible {active} in this range
          {:else}
            feasible {active} ≈ {fmt(feasWindow.lo)}…{fmt(
              feasWindow.hi,
            )}{sweptUnit}{#if feasWindow.gap}
              (non-contiguous){/if}
          {/if}
        </p>
      {/if}
    {:else if active && sweeping}
      <!-- The sweep is running in the background; the chart appears here when it is done. -->
      <p class="feas sbusy" data-sweeping>sweeping {active}…</p>
    {:else if active && sweepKey && sweepRun && !sweepReady}
      <!-- The sweep is a statement about a design, and there is no design here yet. -->
      <p class="feas">
        nothing to sweep at {condLabel(sweepKey)} — {sweepBase
          ? 'the nominal design could not be held there'
          : 'this condition was not evaluated'}
      </p>
    {/if}

    <!-- Resolution failures (missing/ambiguous/cyclic refs) lead — they explain why a
       referenced block below reads infeasible. One dead child makes EVERY dependent
       equation "not defined"; that fan-out is collapsed to a single line per child so the
       root cause isn't buried under its own consequences. -->
    {#each warnLines as w}
      <p class="pwarn" title={w}>⚠ {w}</p>
    {/each}

    <!-- Informational, and kept out of the warning list above: nothing went wrong — a range end
       reads a current the circuit as drawn moves there — and the verdict stands. -->
    {#each rangeNotes as n}
      <p class="pinfo">{n}</p>
    {/each}
  {/if}
</div>

<style>
  .sheet {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.3rem;
    font-size: calc(0.82rem * var(--text-scale));
  }
  .shead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .bind {
    font-family: ui-monospace, monospace;
    opacity: 0.8;
  }
  /* The two headline badges — feasibility, and compliance beside it — so a red advisory
     check below them is never mistaken for the whole design failing. */
  /* One pill shell for the badges and the range-end chips; each keeps only its own text
     treatment. */
  .feasb,
  .compb,
  .wireb,
  .sedge {
    padding: 0.04rem 0.4rem;
    border-radius: 999px;
    border: 1px solid currentColor;
  }
  .feasb,
  .compb {
    font-size: calc(0.66rem * var(--text-scale));
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .sedges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem 0.5rem;
  }
  .sedge {
    font-size: calc(0.72rem * var(--text-scale));
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sedge i {
    font-style: normal;
    opacity: 0.85;
  }
  .feasb.ok,
  .compb.ok,
  .wireb.ok,
  .sedge.ok {
    color: var(--ok);
  }
  /* The wiring chip beside the two verdicts: its words, smaller, and a finding in the warning
     colour — a wiring finding never decides feasibility, so it is never the failure red. */
  .wireb {
    font-size: calc(0.66rem * var(--text-scale));
    letter-spacing: 0.03em;
  }
  .wireb.warn {
    color: var(--warn);
  }
  .feasb.no,
  .compb.no,
  .sedge.no {
    color: var(--err);
  }
  /* A point that was not run, or that could not be answered: the body text colour, dimmed.
     Deliberately neither status colour — both have to read as an open question, and green or
     red would each answer it. */
  .sedge.skip,
  .compb.skip,
  .wireb.skip,
  .feasb.skip {
    color: var(--fg);
    opacity: 0.55;
    border-style: dashed;
  }
  /* Work in progress behind the numbers on screen: quiet, and pulsing so it reads as live. */
  .sbusy {
    font-size: calc(0.72rem * var(--text-scale));
    font-style: italic;
    opacity: 0.75;
    animation: sbusy 1.2s ease-in-out infinite alternate;
  }
  @keyframes sbusy {
    from {
      opacity: 0.35;
    }
    to {
      opacity: 0.85;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sbusy {
      animation: none;
    }
  }
  /* Evaluated under solver settings other than the defaults: quiet, like the condition stamp, but
     marked, since every number on the panel rests on it. */
  .ssolver {
    font-size: calc(0.72rem * var(--text-scale));
    padding: 0.02rem 0.35rem;
    border-radius: 4px;
    border: 1px dashed currentColor;
    opacity: 0.85;
  }
  /* The condition a verdict was measured at. Quiet, and never optional. */
  .scond {
    font-family: ui-monospace, monospace;
    font-size: calc(0.72rem * var(--text-scale));
    opacity: 0.7;
  }
  /* The assumed levels the verdict rests on. Quiet like the condition stamp, but never hidden. */
  .sassume,
  .snoise {
    font-size: calc(0.72rem * var(--text-scale));
    opacity: 0.75;
    font-style: italic;
  }
  .scorners {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem 0.5rem;
    font-size: calc(0.78rem * var(--text-scale));
  }
  .ckey {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    font-family: ui-monospace, monospace;
  }
  .ckey.absent {
    opacity: 0.6;
  }
  .ckey i {
    font-style: normal;
    opacity: 0.7;
  }
  /* A condition that was refused, and why. Not a verdict colour: nothing was measured here. */
  .snotev {
    border: 1px dashed color-mix(in srgb, currentColor 35%, transparent);
    border-radius: 5px;
    padding: 0.3rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .snotev p {
    margin: 0;
  }
  .sissue {
    opacity: 0.8;
    font-size: calc(0.78rem * var(--text-scale));
  }
  .snomctl {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .snomctl button {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    border-radius: 4px;
    padding: 0.05rem 0.4rem;
  }
  /* Per-condition breakdown: one row per selected condition, each carrying its own two answers
     beside its own label. */
  .scorntab {
    border-collapse: collapse;
    font-size: calc(0.78rem * var(--text-scale));
  }
  .scorntab td {
    padding: 0.05rem 0.5rem 0.05rem 0;
    vertical-align: top;
  }
  /* Which hardware the row measured — quiet, because it qualifies the verdict beside it. */
  .scorntab .cdes {
    opacity: 0.7;
    font-style: italic;
    white-space: nowrap;
  }
  .scorntab .ccond {
    font-family: ui-monospace, monospace;
    font-weight: 600;
  }
  .scorntab .ccd {
    opacity: 0.75;
    max-width: 34rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scorntab tr.st-ok .ccl {
    color: var(--ok);
  }
  .scorntab tr.st-no .ccl {
    color: var(--err);
  }
  .scorntab tr.st-skip {
    opacity: 0.7;
  }
  .sstamp {
    opacity: 0.75;
  }
  /* The binding check rides inside the badge: same colour, but normal-case and lighter,
     so the verdict still reads as the headline and the cause as its subtitle. */
  .feasb i {
    font-style: normal;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.85;
    margin-left: 0.34rem;
  }
  .sbias {
    font-family: ui-monospace, monospace;
    font-size: calc(0.76rem * var(--text-scale));
    opacity: 0.68;
  }
  .sdesc {
    margin: 0;
    font-size: calc(0.78rem * var(--text-scale));
    opacity: 0.72;
  }
  .swsel {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: calc(0.78rem * var(--text-scale));
    opacity: 0.85;
  }
  /* The 2-D map's × param select — same look as .swsel but no auto-margin (it trails the first). */
  .swsel2 {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: calc(0.78rem * var(--text-scale));
    opacity: 0.85;
  }
  /* spec/choice param grouping (only when the doc tags roles). */
  .sgroup {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .glabel {
    font-size: calc(0.66rem * var(--text-scale));
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.5;
  }
  /* 2-D feasibility heatmap: axis labels frame an imperative canvas painted from the status tokens. */
  .smap {
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: 1fr auto;
    gap: 0.2rem;
    height: 220px;
    min-width: 0;
  }
  .smy {
    grid-column: 1;
    grid-row: 1;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    justify-self: center;
    align-self: center;
    font-size: calc(0.72rem * var(--text-scale));
    opacity: 0.7;
    white-space: nowrap;
  }
  .smapc {
    grid-column: 2;
    grid-row: 1;
    width: 100%;
    height: 100%;
    min-width: 0;
    border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    border-radius: 3px;
  }
  .smx {
    grid-column: 2;
    grid-row: 2;
    text-align: center;
    font-size: calc(0.72rem * var(--text-scale));
    opacity: 0.7;
    white-space: nowrap;
  }
  .scap {
    font-size: calc(0.76rem * var(--text-scale));
    opacity: 0.7;
  }
  .pchart {
    height: 220px;
    min-width: 0;
  }
  /* Colour key for the margin chart — the chart canvas carries no legend of its own. */
  .skey {
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 0.7rem;
    font-size: calc(0.72rem * var(--text-scale));
    font-family: ui-monospace, monospace;
  }
  .kitem {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    opacity: 0.85;
  }
  .kitem i {
    width: 0.7rem;
    height: 0.24rem;
    border-radius: 1px;
  }
  .feas {
    margin: 0;
    font-family: ui-monospace, monospace;
    font-size: calc(0.78rem * var(--text-scale));
    opacity: 0.85;
  }
  .svars {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 0.25rem 0.8rem;
  }
  .svar {
    display: grid;
    grid-template-columns: 9rem 5rem 1fr;
    align-items: center;
    gap: 0.3rem;
  }
  .vn {
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vn i {
    opacity: 0.5;
    font-style: normal;
    margin-left: 0.25rem;
  }
  .num {
    width: 5rem;
    font: inherit;
    font-family: ui-monospace, monospace;
  }
  /* A param the engine solves reads as a reported value, not a field you can type into. */
  .num.solved {
    border-style: dashed;
    opacity: 0.75;
    cursor: default;
  }
  .sld {
    width: 100%;
    min-width: 0;
  }
  /* Intermediate/output equations: one block per equation — the rendered formula and its value,
     with the author's derivation note beneath so the sheet explains itself in place. */
  .srows {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.2rem 0;
  }
  /* Equation on the left, its author note filling the space to the RIGHT (wrapping onto its
     own line only when the row is too narrow) — so a short "name = formula = value" no longer
     leaves the block half-empty. */
  .srow {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 1rem;
    row-gap: 0.05rem;
  }
  .seq {
    flex: 0 1 auto;
    font-family: ui-monospace, monospace;
    font-size: calc(0.78rem * var(--text-scale));
    opacity: 0.9;
  }
  .seq .sval {
    opacity: 0.75;
  }
  /* Author comment explaining an equation or check — the "why", not the math. */
  .snote {
    font-size: calc(0.72rem * var(--text-scale));
    opacity: 0.6;
    white-space: normal;
    margin-top: 0.05rem;
  }
  .srow .snote {
    flex: 1 1 14rem;
    margin-top: 0;
  }
  .sdetail {
    font-style: italic;
  }
  /* A composed block's own description: what this device IS in the topology. Authored on every
     library sheet and, until now, never shown — the card read as three anonymous devices. */
  .sudesc {
    margin: 0.1rem 0 0.2rem;
  }
  .srules {
    border-collapse: collapse;
    width: 100%;
    font-family: ui-monospace, monospace;
    font-size: calc(0.8rem * var(--text-scale));
  }
  .srules td {
    padding: 0.12rem 0.4rem;
    border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
    white-space: nowrap;
  }
  /* Where the check is tightest: long words in a narrow column, so it wraps and stays quiet. */
  .srules td.rworst {
    white-space: normal;
    font-size: calc(0.72rem * var(--text-scale));
    opacity: 0.75;
    min-width: 6rem;
  }
  /* Beside that column the check's text stops taking every spare pixel, so the two share it. */
  .srules.worsted .rtext {
    width: auto;
  }
  /* With the column above on a narrow panel, the check's kind may drop under its id rather than
     push the row past the panel's edge; the id itself never breaks. */
  .srules td.rid {
    white-space: normal;
  }
  .rid b,
  .rid i {
    white-space: nowrap;
    font-weight: inherit;
  }
  .chip {
    width: 1.2rem;
    text-align: center;
    font-weight: 700;
  }
  .rid i {
    opacity: 0.5;
    font-style: normal;
    margin-left: 0.4rem;
    font-size: calc(0.72rem * var(--text-scale));
  }
  /* composed blocks: each block is a self-contained card (sizing, provides, failing checks),
     children nest as indented cards so the composition tree reads as modules within modules. */
  .suses {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0.2rem 0;
  }
  .suse {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.3rem 0.45rem;
    border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    border-left-width: 3px;
    border-radius: 4px;
    font-size: calc(0.8rem * var(--text-scale));
  }
  /* the left rail tints to the block's verdict — green is feasible, red is not, and neither
     colour is borrowed by a block whose condition was never evaluated */
  .suse.st-pass {
    border-left-color: var(--ok);
  }
  .suse.st-fail {
    border-left-color: var(--err);
  }
  .suse.st-skip {
    border-left-style: dashed;
    opacity: 0.8;
  }
  .suseh {
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .suseh i {
    opacity: 0.55;
    font-style: normal;
    font-size: calc(0.72rem * var(--text-scale));
  }
  .suseh .dsl {
    margin-left: auto;
    font-size: calc(0.68rem * var(--text-scale));
    opacity: 0.6;
  }
  .suseh .dsel {
    font-size: calc(0.72rem * var(--text-scale));
    max-width: 12rem;
  }
  /* by-reference badge: the block's library id, pill-shaped so it reads as provenance */
  .refb {
    font-family: ui-monospace, monospace;
    font-size: calc(0.68rem * var(--text-scale));
    opacity: 0.7;
    border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    border-radius: 999px;
    padding: 0 0.35rem;
    white-space: nowrap;
  }
  /* a pinned snapshot is local content — dashed rim to read as "was a ref, now frozen" */
  .refb.pinned {
    border-style: dashed;
    opacity: 0.55;
  }
  .detach,
  .sensb,
  .sexp button {
    font: inherit;
    font-size: calc(0.68rem * var(--text-scale));
    font-family: ui-monospace, monospace;
    cursor: pointer;
    background: none;
    color: inherit;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 3px;
    padding: 0 0.3rem;
    opacity: 0.7;
  }
  .detach:hover,
  .sensb:hover,
  .sexp button:hover {
    opacity: 1;
  }
  /* The toggle stays lit while its snapshot is on screen, so it reads as a mode rather than a
     one-shot action — and goes dark by itself when a design edit retires the snapshot. */
  .sensb.on {
    opacity: 1;
    border-color: currentColor;
  }
  /* On-demand knob ranking for the binding (or limiting) check — a short block, deliberately:
     three knobs and their reasons, not a table of every check against every param. */
  .ssens {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.25rem 0.45rem;
    border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    border-radius: 4px;
  }
  .skline {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.15rem 0.9rem;
    font-family: ui-monospace, monospace;
    font-size: calc(0.76rem * var(--text-scale));
  }
  .skline code {
    min-width: 7rem;
  }
  /* A knob that could not be probed states the reason in prose — no number, so no monospace
     column to line up with. */
  .skline.dead {
    opacity: 0.6;
    font-family: inherit;
  }
  .sexp button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .sexp {
    display: inline-flex;
    gap: 0.25rem;
  }
  .sexp button {
    font-size: calc(0.72rem * var(--text-scale));
    padding: 0.05rem 0.4rem;
  }
  /* the block's own sized operating point — the module's "output pins" made concrete */
  .susebind {
    font-family: ui-monospace, monospace;
    font-size: calc(0.74rem * var(--text-scale));
    opacity: 0.85;
  }
  .susebind .sbias {
    opacity: 0.7;
    margin-left: 0.3rem;
  }
  /* per-block operating-point editor: one compact field per live bias axis (vds/vsb). */
  .sbiasctl {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.15rem 0.5rem;
    font-family: ui-monospace, monospace;
    font-size: calc(0.72rem * var(--text-scale));
  }
  .bx {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    opacity: 0.85;
  }
  .bx .num {
    width: 4rem;
  }
  .bx i {
    opacity: 0.5;
    font-style: normal;
  }
  .bx.ro code {
    opacity: 0.75;
  }
  /* a bias the givens MUST state but haven't — the fail-closed remedy, flagged for the eye. */
  .bx.need {
    color: var(--err);
    opacity: 1;
  }
  .bx.need .num {
    border-color: var(--err);
  }
  .prov {
    display: flex;
    flex-wrap: wrap;
    gap: 0.1rem 0.6rem;
  }
  .prov code {
    opacity: 0.85;
  }
  /* nested children: indent + a rail so the hierarchy is visible at a glance */
  .skids {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-top: 0.15rem;
    padding-left: 0.5rem;
    border-left: 1px dashed color-mix(in srgb, currentColor 20%, transparent);
  }
  /* An infeasible child's failing hard checks — one compact line inside its card. */
  .cfails {
    display: flex;
    flex-wrap: wrap;
    gap: 0.1rem 0.6rem;
    font-family: ui-monospace, monospace;
    font-size: calc(0.72rem * var(--text-scale));
    color: var(--err);
    opacity: 0.9;
  }
  .rtext {
    width: 99%;
    white-space: normal;
  }
  .rtext .req {
    opacity: 0.85;
  }
  /* the note shares the checks cell but must not inherit its baseline nowrap siblings */
  .rtext .snote {
    display: block;
  }
  .rnum,
  .rmar {
    text-align: right;
  }
  /* status colours read on both themes (system canvas backgrounds). */
  .st-pass .chip,
  .st-pass .rmar {
    color: var(--ok);
  }
  .st-amber .chip,
  .st-amber .rmar {
    color: var(--warn);
  }
  .st-fail .chip,
  .st-fail .rmar {
    color: var(--err);
  }
  /* An advisory check never gates feasibility — so even a failing one reads amber
     (a heads-up), not the hard-fail red a physical or spec check earns. */
  .srules tr.advisory.st-fail .chip,
  .srules tr.advisory.st-fail .rmar {
    color: var(--warn);
  }
  .st-na {
    opacity: 0.55;
  }
  .perr,
  .pwarn,
  .pinfo {
    margin: 0;
    /* .sheet is a height-constrained flex column: without this a warning at the
       bottom is squashed to zero height (invisible) instead of scrolling. */
    flex-shrink: 0;
    color: var(--warn);
    font-family: ui-monospace, monospace;
    font-size: calc(0.78rem * var(--text-scale));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Warnings WRAP where the inline errors do not: a wiring finding's whole content is often the
     numbers at the end of the sentence — a loop's residual, a wire's unbalanced current — which a
     single clipped line throws away. Two or three lines in a scrolling panel is the cheaper cost. */
  .pwarn {
    opacity: 0.8;
    white-space: normal;
  }
  /* A note, not a warning: the design closed. Same line treatment, none of the alarm colour. */
  .pinfo {
    color: inherit;
    opacity: 0.6;
    white-space: normal;
  }
  /* The one line a document in a format this app does not read gets: the whole reason, wrapped. */
  .prefused {
    white-space: normal;
  }
</style>
