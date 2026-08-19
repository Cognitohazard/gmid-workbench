<script lang="ts">
  // A leaf design-sheet panel: pick a vetted example, tune the design variables, and
  // watch the author equations and pass/fail constraints recompute with signed margins.
  // It holds no numerics — runSheet (core) does all evaluation and never throws.
  import {
    cloneDoc,
    aggregateVariantRuns,
    clampMargin,
    measurable,
    projectingResolver,
    runVariants,
    sameVariant,
    variantAt,
    variantKeyId,
    variantKeyOf,
    variantLabel,
    sweepSheet,
    sweepSheet2,
    sweepable as isSweepable,
    torn,
    pinned as isPinned,
    engineSolved,
    bindingConstraint,
    limitingConstraint,
    sheetSensitivities,
    SENSITIVITY_REL_STEP,
    resolveSheetRefs,
    flattenSheetDoc,
    formatEng,
    formatSI,
    joinProvide,
    PROVIDE_SEP,
    BIAS_AXES,
    SWEEP_POINTS,
    SWEEP2_POINTS,
    type DeviceTable,
    type SheetDoc,
    type SheetBind,
    type SheetVar,
    type SheetRule,
    type SheetUse,
    type SheetSweep,
    type SheetSweep2,
    type SheetSensitivity,
    type SheetChildReport,
    type SheetEdgeReport,
    type SheetEdgeState,
    type QAWarning,
    type BindReport,
    type RuleResult,
    type RuleStatus,
    type SheetResult,
    type VariantKey,
    type VariantRun,
  } from '@gmid/mostab-core';
  import { describeBinding, familyLabel, type Bench } from './families';
  import { tableUid, type SheetCornerMode } from './dashboard';
  import { PALETTE, type ChartData } from './chart';
  import { chartHost } from './chartHost.svelte';
  import { axisUnit, qFormula, qLabel, mathText, mathPlain } from './labels';
  import { CONTROL_HELP } from './help';
  import { commitEng, pct } from './eng';
  import { sheetMenu, sheetRefIndex } from './sheetlib.svelte';
  import { copyText, download } from './export';

  let {
    device,
    cfg,
    sweep = '',
    sweep2 = '',
    cornerMode = 'nominal',
    cornerKeys = [],
    bench,
    styleVersion = 0,
    onChange,
    onSweep,
    onSweep2,
    onCornerMode,
    onCornerKeys,
  }: {
    device: DeviceTable;
    cfg: SheetDoc;
    sweep?: string;
    /** The second (×) sweep param: with `sweep` set too, the panel draws a 2-D feasibility map. */
    sweep2?: string;
    /** Which characterization conditions this panel evaluates at (bench state, never in `cfg`). */
    cornerMode?: SheetCornerMode;
    cornerKeys?: VariantKey[];
    bench: Bench;
    styleVersion?: number;
    onChange: (s: SheetDoc) => void;
    onSweep: (s: string) => void;
    onSweep2: (s: string) => void;
    onCornerMode: (m: SheetCornerMode) => void;
    onCornerKeys: (k: VariantKey[]) => void;
  } = $props();

  // The live sheet library (curated ∪ user-imported) and its by-reference index.
  const menu = $derived(sheetMenu());
  const refs = $derived(sheetRefIndex());

  // One unresolved or mis-parameterized child makes every parent expression that
  // reads its provides "not defined" — a ~20-line wall for one root cause. Collapse
  // the fan-out to one line per child prefix; every other warning passes through.
  /** One diagnostic line: what happened, and — where the finding needs a concept to read it —
   *  the standing explanation of what the check is, carried into the tooltip. */
  type WarnLine = { text: string; help?: string };
  /** Validation and evaluation diagnostics as one list — walked twice below (warnings, then the
   *  informational solver notes), so the concatenation is built once. */
  const allWarn = $derived.by(() => [...rr.warnings, ...(result?.warnings ?? [])]);
  const shownWarnings = $derived.by(() => {
    const ws = allWarn.filter((w) => w.severity !== 'info');
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive grouping scratch, discarded on return
    const byChild = new Map<string, { count: number; first: string }>();
    const rest: WarnLine[] = [];
    for (const w of ws) {
      // The core reports the undefined name structurally; a child-provide symbol
      // (`ld__gm`) groups under its child prefix.
      const sep = w.rule === 'sheet-undeclared' && w.symbol ? w.symbol.indexOf(PROVIDE_SEP) : -1;
      if (sep > 0) {
        const child = (w.symbol as string).slice(0, sep);
        const e = byChild.get(child) ?? { count: 0, first: w.message };
        e.count++;
        byChild.set(child, e);
      } else {
        // A gate-wiring disagreement states two voltages and nothing about WHY the tool is
        // comparing them; the concept — a node the sizing and the schematic describe
        // differently — rides along in the tooltip so the number has a meaning.
        rest.push({
          text: w.message,
          ...(w.rule === 'sheet-wiring' ? { help: CONTROL_HELP.wiringWarning } : {}),
        });
      }
    }
    const collapsed = [...byChild].map(([child, e]): WarnLine => ({
      text:
        e.count > 1
          ? `block "${child}" resolves nothing yet — ${e.count} dependent expressions read n/a (assign its device and check its params)`
          : e.first,
    }));
    return [...rest, ...collapsed];
  });

  // The solver's pass-count note is INFO, not a warning: the loop closed and the verdict stands,
  // so it must not sit among the things that went wrong — but a loop that needed that many
  // substitutions is contracting weakly, which is worth knowing before the sheet is trusted at
  // another operating point. Its own quiet line, in the core's words.
  const solveNotes = $derived(
    allWarn.filter((w) => w.severity === 'info' && w.rule === 'sheet-solve').map((w) => w.message),
  );

  // Onboarding hints lead the same list the diagnostics land in — they are the likeliest cause of
  // the diagnostics below them — and carry no help of their own (they already name the remedy).
  const warnLines = $derived.by(() => [
    ...signHints.map((text): WarnLine => ({ text })),
    ...shownWarnings,
  ]);

  // Onboarding guard: a child bound to a signed-PMOS table while its companion
  // `<child>_sign` param still reads +1 is the most common dead-on-arrival state for
  // the mirror-load sheets — every dependent row goes n/a at once. Name the root
  // cause as a hint; never auto-flip (sign params are author math, not app state).
  const signHints = $derived.by(() => {
    const out: string[] = [];
    for (const u of rr.doc.uses ?? []) {
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
  // the design CLOSES and whether it COVERS the range it claims — once per characterization
  // condition, each answer stamped with the condition it was measured at. Every run fixes ONE
  // (corner, temperature) key and projects the primary and every named child to it, because a
  // verdict assembled from a tt input pair and an ss tail describes a chip that does not exist.
  const primary = $derived(bench.primary);
  /** Every condition the primary family holds, in load order. */
  const conditions = $derived<readonly VariantKey[]>(primary?.keys ?? []);
  const activeKey = $derived(variantKeyOf(device.id));
  const nominalKey = $derived(primary?.nominal ? variantKeyOf(primary.nominal.id) : undefined);
  /** The conditions this panel is asking about. A chosen key that is no longer loaded stays in
   *  the list: it is answered as its own not-evaluated row, where pruning it would silently
   *  narrow the question. */
  const keys = $derived.by((): readonly VariantKey[] => {
    if (!primary) return [];
    if (cornerMode === 'active') return [activeKey];
    if (cornerMode === 'all') return conditions;
    if (cornerMode === 'chosen') return cornerKeys;
    return nominalKey ? [nominalKey] : [];
  });
  /** Why nothing can be evaluated, when nothing can be. `nominal` is the one that must never
   *  fall back to the active table: "the family's nominal" is a designation, and quietly
   *  substituting whatever is selected would report a verdict about a condition nobody chose. */
  const blocked = $derived.by((): 'no-device' | 'undesignated' | 'none-chosen' | null => {
    if (keys.length) return null;
    if (!primary) return 'no-device';
    return cornerMode === 'chosen' ? 'none-chosen' : 'undesignated';
  });
  const multi = $derived(keys.length > 1);
  // ONE run per condition, through the core's single transition: it preflights the families,
  // refuses before the engine ever sees a missing or ambiguous table, and only calls a run
  // evaluated when it stands. The plural form is that transition per key, with the sheet
  // resolved and validated once for the set rather than once per condition.
  const runs = $derived(primary ? runVariants(cfg, primary, keys, bench.familyOf, refs) : []);
  // Whether coverage is a question about this design AT ALL — read from the doc, because when
  // nothing was evaluated the runs cannot tell "claims no range" from "claims went unchecked".
  const hasEdges = $derived((rr.doc.edges ?? []).length > 0);
  const agg = $derived(aggregateVariantRuns(runs, hasEdges));

  // The run whose numbers the detail below belongs to: the nominal condition when it is in the
  // set, else the first that was evaluated, else the first asked about. In multi-condition mode
  // the detail is explicitly stamped with it, so no number on screen is unattributed.
  const refRun = $derived.by((): VariantRun | undefined => {
    const nk = nominalKey;
    return (
      runs.find((r) => r.state === 'evaluated' && nk !== undefined && sameVariant(r.key, nk)) ??
      runs.find((r) => r.state === 'evaluated') ??
      runs[0]
    );
  });
  const refKey = $derived(refRun?.key);
  const evaluated = $derived(refRun?.state === 'evaluated');
  /** The reference run's numbers. Absent when a condition was refused before the engine ran —
   *  and then NOTHING fabricates one: the panel shows what it could not evaluate instead. */
  const result = $derived<SheetResult | undefined>(refRun?.result);
  /** The primary table the detail was computed on: the family's member at the reference
   *  condition, which is the active table only when the panel is asking about that condition. */
  const refTable = $derived(refKey && primary ? variantAt(primary, refKey) : undefined);
  /** The projection at the reference condition — the resolver the detail body, the sweeps and
   *  the sensitivity probes all read. It is the core's own projection (the same one the runs
   *  above evaluated through), so a chart or a probe can never mix conditions the verdict above
   *  it did not. */
  const resolveDevice = $derived(refKey ? projectingResolver(bench.familyOf, refKey) : undefined);

  // ── What the aggregate may say. Closure and coverage are folded separately and neither is
  // inferred from the other, so a design that closes everywhere while one range end fails reads
  // as a coverage gap and not as a failure to close. Conditions that were not evaluated are
  // never counted as passing them — they are counted, and named, as not evaluated.
  const AGG_CLASS: Record<string, string> = {
    all: 'ok',
    fails: 'no',
    unverified: 'skip',
    'none-evaluated': 'skip',
  };
  const aggregateText = $derived.by(() => {
    const { pass, fail, unavailable } = agg.counts;
    const n = pass + fail + unavailable;
    if (agg.closes === 'all') return `closes at all ${n}`;
    if (agg.closes === 'fails')
      return `does not close — ${pass} pass / ${fail} fail / ${unavailable} not evaluated`;
    if (agg.closes === 'unverified')
      return `closure unverified — ${pass} pass, ${unavailable} not evaluated`;
    return 'not evaluated';
  });
  const COVERS_CLASS: Record<string, string> = {
    all: 'ok',
    gap: 'no',
    unchecked: 'skip',
    unverified: 'skip',
  };
  const coversText = $derived.by(() => {
    const c = agg.covers;
    if (!c) return '';
    const { covers, gap, unchecked, unavailable } = c.counts;
    if (c.state === 'all') return `covers at all ${covers}`;
    if (c.state === 'gap')
      return `coverage gap — ${gap} of ${covers + gap + unchecked + unavailable}`;
    // "not checked" and "nothing could be evaluated to check it" are different answers, and the
    // closure chip beside this one already says which of the two happened.
    if (c.state === 'unchecked')
      return unavailable
        ? `coverage not measured — ${unavailable} not evaluated`
        : 'range coverage not checked';
    return `coverage unverified — ${covers} cover, ${unchecked} not checked, ${unavailable} not evaluated`;
  });

  /** One condition's own answers, for the breakdown. Each is the run's own verdict beside its
   *  own label — the aggregate above never stands in for one of these, and none of them ever
   *  stands in for the aggregate. */
  const closesCell = (r: VariantRun): string =>
    r.state === 'evaluated'
      ? r.closes === 'pass'
        ? '✓ closes'
        : '✗ does not close'
      : '– not evaluated';
  const coversCell = (r: VariantRun): string => {
    if (r.state !== 'evaluated') return '–';
    return r.covers === 'covers' ? '✓ covers' : r.covers === 'gap' ? '✗ gap' : '– not checked';
  };
  const runClass = (r: VariantRun): string =>
    r.state !== 'evaluated' ? 'skip' : r.closes === 'pass' ? 'ok' : 'no';
  /** The one-line reason: what stopped a refused condition, else what binds (or is closest to
   *  binding) at one that ran. */
  const runDetail = (r: VariantRun): string => {
    if (r.state === 'not-evaluated') return r.issues.map((i) => i.message).join(' · ');
    const b = bindingConstraint(r.result) ?? limitingConstraint(r.result);
    return b ? `${b.id} ${pct(b.marginPct)}` : '';
  };

  // The conditions the "chosen" mode offers: everything the family holds, plus any stored
  // choice that is no longer loaded — kept visible and still selectable, because a chosen
  // condition that vanished is an answer the panel owes ("not evaluated"), not a tidy-up.
  const chosenOptions = $derived.by(() => {
    const out = conditions.map((key) => ({ key, absent: false }));
    const have = new Set(conditions.map(variantKeyId));
    for (const key of cornerKeys) if (!have.has(variantKeyId(key))) out.push({ key, absent: true });
    return out.map((o) => ({
      ...o,
      on: cornerKeys.some((k) => sameVariant(k, o.key)),
    }));
  });
  const toggleKey = (key: VariantKey): void =>
    onCornerKeys(
      cornerKeys.some((k) => sameVariant(k, key))
        ? cornerKeys.filter((k) => !sameVariant(k, key))
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

  // "infeasible" alone names no cause, and the offending rule is often a child's — not in the
  // table below at all. Core owns the definition, so the badge and the 2-D map's per-cell cause
  // can never disagree about which rule binds.
  const binding = $derived(result ? bindingConstraint(result) : undefined);

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
  // Also retired when several conditions are selected: a sensitivity readout is a statement
  // about one operating point, the same rule that disables taking a new one in multi mode.
  const shot = $derived(!multi && snap && snap.doc === cfg && snap.dev === refTable ? snap : null);
  const sens = $derived(shot?.rows ?? null);
  // A retired snapshot stops RENDERING through `shot` immediately; this drops the reference so it
  // stops holding a device table nobody is looking at any more — a switched-away table is
  // megabytes of Float64Array.
  $effect(() => {
    if (snap && snap !== shot) snap = null;
  });

  // The rule the readout points at: the one that broke the design when something did, else the
  // one closest to breaking. Both are core definitions over the whole composition, so the knobs
  // are ranked against the same rule the badge names. Taken WITH the snapshot, not derived
  // reactively: the tree walk behind the limiting constraint would otherwise run on every slider
  // frame to answer a question only this readout asks, and any design change that could move the
  // answer retires the snapshot anyway.
  const focusRule = $derived(shot?.focus);
  // One condition at a time: a ranking is a statement about the point it was taken at, and
  // there is no such point while several conditions are on screen.
  const sensReady = $derived(!multi && evaluated && result !== undefined && refTable !== undefined);
  function toggleSens(): void {
    if (shot) {
      snap = null;
      return;
    }
    if (!sensReady || !result || !refTable) return;
    const focus = binding ?? limitingConstraint(result);
    snap = {
      doc: cfg,
      dev: refTable,
      focus,
      // Naming the rule keeps the probes off the containment-edge path unless the rule in
      // question lives on an edge — the difference between 2 and 2*(1 + edges) evaluations per
      // knob.
      rows: sheetSensitivities(cfg, refTable, resolveDevice, {
        refs,
        ...(focus ? { rule: focus.id } : {}),
      }),
    };
  }

  // Knobs ranked for that rule. The ranking quantity is the margin change over ONE STEP of each
  // knob — a common fractional move — not the per-unit slope: the params are in different SI
  // units (a length against a gm/ID against a current), and a per-unit derivative would rank them
  // by how small their units are. Both directions are shown rather than one slope, because an
  // equality rule's margin has a cusp at agreement where the two sides genuinely differ.
  const KNOBS_SHOWN = 3;
  const sensLines = $derived.by(() => {
    const rows = sens;
    const id = focusRule?.id;
    if (!rows || id === undefined) return null;
    const knobs: { param: string; plus: number; minus: number; mag: number; step: number }[] = [];
    // A knob that could not be probed reports WHY (an unbounded zero, a range too narrow, an
    // evaluation that did not stand). Never a fabricated number in place of a missing one.
    const blocked: { param: string; why: string }[] = [];
    const reach = (v: number): number => (Number.isFinite(v) ? Math.abs(v) : 0);
    for (const s of rows) {
      const r = s.rules.find((x) => x.id === id);
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
          why: s.error ?? `no response to "${id}" was recorded`,
        });
    }
    knobs.sort((a, b) => b.mag - a.mag);
    return { knobs: knobs.slice(0, KNOBS_SHOWN), blocked: blocked.slice(0, KNOBS_SHOWN) };
  });

  // ── Feasibility sweep: vary one slider parameter across its range and chart every rule's
  // relative margin. Only finitely-bounded params can be swept (the sweep walks [min,max]).
  const sweepable = $derived(cfg.params.filter((p) => isSweepable(p)));
  // The active sweep param, ignoring a stale selection that no longer names a sweepable var.
  const active = $derived(sweep && sweepable.some((p) => p.name === sweep) ? sweep : '');
  // `evaluated`, not merely "there is a table": a condition refused for want of a child device
  // has no design to sweep, and sweeping it anyway would print a feasibility window — a closure
  // statement — under a header that just said the condition was not evaluated.
  const swept = $derived(
    active && !multi && evaluated && refTable
      ? sweepSheet(rr.doc, active, refTable, SWEEP_POINTS, resolveDevice)
      : null,
  );
  /** The same sweep at every EVALUATED condition — the multi-condition chart. A condition that
   *  was refused has no design to sweep, so it contributes no curve and stays visible as its
   *  breakdown row instead. */
  const sweptByKey = $derived.by(() => {
    if (!active || !multi || !primary) return [];
    const out: { key: VariantKey; sweep: ReturnType<typeof sweepSheet> }[] = [];
    for (const r of runs) {
      if (r.state !== 'evaluated') continue;
      const table = variantAt(primary, r.key);
      if (!table) continue;
      out.push({
        key: r.key,
        sweep: sweepSheet(
          rr.doc,
          active,
          table,
          SWEEP_POINTS,
          projectingResolver(bench.familyOf, r.key),
        ),
      });
    }
    return out;
  });

  /** The swept parameter's unit, from whichever sweep ran — the caption's only use of it. */
  const sweptUnit = $derived(swept?.unit ?? sweptByKey[0]?.sweep.unit ?? '');

  // ── 2-D feasibility map: a second (×) param turns the 1-D margin chart into a design-plane
  // heatmap (feasible region vs the two params). Choices are the sweepable params minus the first.
  // One design plane belongs to one condition: with several selected there is no single design
  // to map, so the control is offered again as soon as the selection narrows to one.
  const sweepable2 = $derived(sweepable.filter((p) => p.name !== active));
  const active2 = $derived(
    !multi && active && sweep2 && sweepable2.some((p) => p.name === sweep2) ? sweep2 : '',
  );
  const twoD = $derived(active2 !== ''); // active2 is only ever set while `active` is
  const swept2 = $derived(
    twoD && evaluated && refTable
      ? sweepSheet2(rr.doc, active, active2, refTable, SWEEP2_POINTS, resolveDevice)
      : null,
  );
  // The distinct hard-rule ids (tree-path) that bound the infeasible region — the caption's "what
  // limits it", so the plane is never a wall of red with no named cause.
  const bindingIds = $derived.by(() => {
    const s = swept2;
    if (!s) return [];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive dedup scratch, rebuilt per recompute
    const ids = new Set<string>();
    for (const row of s.binding) for (const id of row) if (id) ids.add(id);
    return [...ids];
  });

  // One line per rule, margin as a percentage; guardrails dashed (advisory, never gate). The
  // y = 0 gridline is the constraint boundary; PALETTE cycles the colours by default.
  //
  // The y window is FIXED at ±MARGIN_CLIP%. Rules like slew rate scale linearly with the swept
  // current and run to several thousand percent, which auto-scales every rule near its boundary
  // into one flat band at y = 0 — hiding the only thing the chart is for. No zero crossing can
  // fall outside the window, so every feasibility edge survives; the data stays true (the chart
  // clips the view, the numbers are not clamped) and the rules table carries exact values.
  const MARGIN_CLIP = 100;
  /** The least room left among a sample's HARD rules — the same reading the badge's binding
   *  constraint gives a point, and the one the core already takes for a range end's aggregate
   *  curve. `measurable` is core's own predicate for a rule outcome that carries headroom
   *  (hardness included, so a future advisory kind cannot slip in here), and the clamp is the
   *  one every margin comparison applies. An edge curve is coverage, not closure, so it stays
   *  out. `null` where no hard rule produced a number. */
  function worstHardMargin(s: SheetSweep, i: number): number | null {
    let worst: number | null = null;
    for (const r of s.rules) {
      const m = r.marginPct[i];
      if (r.edge !== undefined || m == null || !measurable(r.kind, m)) continue;
      const clamped = clampMargin(m);
      if (worst === null || clamped < worst) worst = clamped;
    }
    return worst;
  }
  const chartData = $derived.by((): ChartData | null => {
    // Several conditions: one curve each, of the worst hard-rule margin, so the chart answers
    // "where does this design close, and which condition takes it out first" instead of
    // stacking one rule set per condition into an unreadable wall.
    if (multi) {
      const set = sweptByKey.filter((e) => e.sweep.x.length > 0);
      if (!set.length) return null;
      return {
        x: set[0].sweep.x,
        lines: set.map((e) =>
          e.sweep.x.map((_, i) => {
            const m = worstHardMargin(e.sweep, i);
            return m == null ? null : m * 100;
          }),
        ),
        lineLabels: set.map((e) => variantLabel(e.key)),
        yRange: [-MARGIN_CLIP, MARGIN_CLIP],
      };
    }
    if (!swept || swept.x.length === 0) return null;
    return {
      x: swept.x,
      lines: swept.rules.map((r) => r.marginPct.map((m) => (m == null ? null : m * 100))),
      lineLabels: swept.rules.map(ruleLabel),
      lineDash: swept.rules.map((r) => (r.kind === 'guardrail' ? [4, 3] : null)),
      yRange: [-MARGIN_CLIP, MARGIN_CLIP],
    };
  });

  // The contiguous span of the swept param where the whole design closes (the feasibility window).
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
  function pickSheet(e: Event): void {
    const sel = e.currentTarget as HTMLSelectElement;
    const [gi, si] = sel.value.split(':').map(Number);
    sel.value = '';
    const src = menu[gi]?.sheets[si];
    if (src) onChange(cloneDoc(src));
  }
  /** A binding the menu does not offer. A document written before children named families
   *  stores a raw table uid; it still resolves, and is shown as the device it names rather than
   *  as something missing. A binding nothing answers to is the one that reads "not loaded". */
  const bindingOption = (binding: string): string => {
    const f = bench.familyOf(binding);
    return f ? `${familyLabel(f)} · stored by table` : `${describeBinding(binding)} (not loaded)`;
  };

  // Point a composed child at a specific loaded device (a family binding), or '' to inherit the
  // parent.
  function setUseDevice(i: number, uid: string): void {
    const uses = (cfg.uses ?? []).map((u, j) => {
      if (j !== i) return u;
      const { device: _drop, ...rest } = u;
      return uid ? { ...rest, device: uid } : rest;
    });
    onChange({ ...cfg, uses });
  }

  // ── Per-block operating point. A sheet sizes one device per bind at its OWN vds/vsb; a
  // shared dashboard slider can't speak for a stack whose devices sit at different drains.
  // So each block owns its bias here: vds must be pinned (no default), vsb defaults to 0.
  // A block's live bias axes come from its OWN sized report — the axes it sliced (bias) plus any
  // it must still pin (needs). Reading them off the report, not the panel device, keeps the control
  // correct when a composed child sizes against a different loaded table than its parent. BIAS_AXES
  // (the core's namespace-derived canonical list) fixes the display order.
  const biasAxesFor = (r: BindReport | undefined): string[] =>
    BIAS_AXES.filter((a) => (r?.bias != null && a in r.bias) || (r?.needs?.includes(a) ?? false));
  // The authored declaration string for a bias axis (SheetBind's vds/vsb are optional strings).
  const biasField = (bind: SheetBind | undefined, axis: string): string | undefined =>
    (bind as unknown as Record<string, string | undefined> | undefined)?.[axis];
  // Editable here only when absent or a plain number: an expression (a param reference) stays
  // param-controlled, so writing a literal would silently sever the knob. Those show read-only.
  const isLiteral = (s: string | undefined): boolean => s === undefined || Number.isFinite(+s);
  // Write (or clear, on empty) a bias literal into the bind at `path` — []=top sheet, [i]=child i,
  // [i,j]=grandchild — and emit a fresh doc down the same immutable onChange path as setParam.
  function setBias(path: number[], axis: string, value: number | null): void {
    const edit = (doc: SheetDoc, depth: number): SheetDoc => {
      if (depth === path.length) {
        if (!doc.bind) return doc;
        const bind = { ...doc.bind } as SheetBind & Record<string, string | undefined>;
        if (value == null || !Number.isFinite(value)) delete bind[axis];
        else bind[axis] = String(value);
        return { ...doc, bind };
      }
      const i = path[depth];
      // A docless (by-reference) use has nothing local to write into — the control is
      // not rendered for those, so this is just the fail-safe.
      const uses = (doc.uses ?? []).map((u, j) =>
        j === i && u.doc ? { ...u, doc: edit(u.doc, depth + 1) } : u,
      );
      return { ...doc, uses };
    };
    onChange(edit(cfg, 0));
  }

  // Copy-on-write escape hatch: swap the by-reference use at `path` for an embedded
  // copy of the library sheet's AUTHORED doc — not the resolved subtree, so the
  // detached block's own nested refs stay live and a nested pinned snapshot stays
  // pinned, by construction. Local and editable from then on. cloneDoc: the index
  // holds library objects that must never alias into the panel's cfg.
  function detachRef(path: number[]): void {
    const ref = cfgUseAt(path)?.ref;
    const hit = ref !== undefined ? refs.get(ref) : undefined;
    if (!hit || !('doc' in hit)) return; // unresolved — the button is not rendered here
    const inline = cloneDoc(hit.doc);
    const edit = (doc: SheetDoc, depth: number): SheetDoc => ({
      ...doc,
      uses: (doc.uses ?? []).map((c, j) => {
        if (j !== path[depth]) return c;
        if (depth === path.length - 1) {
          const { ref: _drop, ...rest } = c;
          return { ...rest, doc: inline };
        }
        return c.doc ? { ...c, doc: edit(c.doc, depth + 1) } : c;
      }),
    });
    onChange(edit(cfg, 0));
  }

  // Any by-reference use anywhere in the authored tree? Gates the flatten button.
  const docHasRefs = (d: SheetDoc): boolean =>
    (d.uses ?? []).some((u) => u.ref !== undefined || (u.doc ? docHasRefs(u.doc) : false));
  const hasRefs = $derived(docHasRefs(cfg));

  // The AUTHORED use at `path` (childCard renders the resolved tree, which cannot tell
  // a live materialized ref from a hand-authored pinned ref+doc snapshot — only the raw
  // cfg can). Undefined once the path crosses into a referenced sheet's interior.
  function cfgUseAt(path: number[]): SheetUse | undefined {
    let u: SheetUse | undefined;
    let d: SheetDoc | undefined = cfg;
    for (const i of path) {
      u = d?.uses?.[i];
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
  // notation): every computed row plus each child's, already child__-prefixed —
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

  const fmt = (v: number | undefined): string =>
    v == null || !Number.isFinite(v) ? '—' : formatSI(v);
  /** A signed change, for the sensitivity readout: an explicit '+' so the direction reads at a
   *  glance, and '—' wherever a probe produced no number — never a stand-in zero. */
  const signedFmt = (v: number): string =>
    Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${formatSI(v)}` : '—';

  const edgeSolved = (e: SheetEdgeReport): string =>
    Object.entries(e.solved)
      .map(([k, v]) => `${k} ${fmt(v)}`)
      .join(' · ');
  /** The one-line detail beside an edge chip, one wording per outcome. A range end that is
   *  covered shows where its bias landed; one that is not shows why — the solver's own message
   *  when the run could not stand at all, else its worst failing hard rule (same definition the
   *  badge uses, scoped to the edge's own tree). An UNCHECKED end must never borrow either: it
   *  is not a verdict about the range but the absence of one, so it says what is missing. */
  const edgeDetail = (e: SheetEdgeReport): string => {
    if (e.state === 'not-checked') return 'not checked — these settings produce no design';
    if (e.state === 'covers') return edgeSolved(e);
    if (e.error) return e.error;
    const b = bindingConstraint(e);
    return b ? `${b.id} ${pct(b.marginPct)}` : 'does not cover';
  };
  // Three outcomes, three appearances — a range end that was never checked must not borrow the
  // failure's mark or colour, because "we did not ask" is not "the answer is no".
  const EDGE_MARK: Record<SheetEdgeState, string> = {
    covers: '✓',
    'does-not-cover': '✗',
    'not-checked': '–',
  };
  const EDGE_CLASS: Record<SheetEdgeState, string> = {
    covers: 'ok',
    'does-not-cover': 'no',
    'not-checked': 'skip',
  };
  const edgeNote = $derived(new Map((cfg.edges ?? []).map((e) => [e.name, e.note])));
  /** The run's own non-info diagnostics — a bias clamp fires exactly at a claim's extreme,
   *  and a green chip must not hide that it rests on clamped data. */
  const edgeWarns = (e: SheetEdgeReport): QAWarning[] =>
    e.warnings.filter((w) => w.severity !== 'info');
  // The tooltip carries WHICH point was checked (the resolved overrides), the authored note,
  // any run diagnostics, and — whenever the range end is not covered — the full detail, because
  // the chip clamps long solver messages with an ellipsis. The concept-level help lives on the
  // group label.
  const edgeTitle = (e: SheetEdgeReport, detail: string): string => {
    const at = Object.entries(e.set)
      .map(([k, v]) => `${k} = ${fmt(v)}`)
      .join(' · ');
    const warns = edgeWarns(e)
      .map((w) => `⚠ ${w.message}`)
      .join('\n');
    return [at, edgeNote.get(e.name), warns, e.state === 'covers' ? '' : detail]
      .filter(Boolean)
      .join('\n\n');
  };
  /** One label for an edge's aggregate sweep curve, shared by the legend and the chart
   *  series — consumers read the field, never parse the id's trailing separator. The verb
   *  is the reading: above zero the design covers that range end, below zero it does not. */
  const ruleLabel = (r: { id: string; edge?: string }): string =>
    r.edge ? `covers ${r.edge}` : r.id;
  const CHIP: Record<RuleStatus, string> = { pass: '✓', amber: '≈', fail: '✗', na: '—' };

  // Author rule notes by id (a RuleResult carries no note — the physical-meaning note lives on the
  // authored SheetRule). Top-level result.rules mirror cfg.rules 1:1, so the id lookup is exact.
  const ruleNote = $derived(new Map(cfg.rules.map((r) => [r.id, r.note])));
  const ruleWhy = $derived(new Map(cfg.rules.map((r) => [r.id, r.justification])));
  // A rule row's tooltip carries the rule-SPECIFIC bits (its authored physical-meaning note and any
  // eval detail); the generic kind/amber/na explanations live on their own elements via CONTROL_HELP.
  // A rule's authored prose for the row tooltip. `justification` is the author's stated reason
  // for a relaxed or unusual constraint — the thing a reviewer most needs — so it is shown,
  // not just stored. A title attribute is a plain-TEXT sink: math goes through mathPlain.
  // A CHILD's rule is looked up in `childRules` — the rules of the doc it was authored in.
  // Rule ids are unique only WITHIN a sheet (ten shipped sheets carry a `feasible-inversion`),
  // so reading a child chip out of the top-level maps shows the parent's note for an unrelated
  // constraint. Absent ⇒ this sheet's own rules, which DO mirror result.rules 1:1.
  function ruleTitle(r: RuleResult, childRules?: readonly SheetRule[]): string {
    const own = childRules?.find((a) => a.id === r.id);
    const parts: string[] = [];
    const note = childRules ? own?.note : ruleNote.get(r.id);
    if (note) parts.push(note);
    const why = childRules ? own?.justification : ruleWhy.get(r.id);
    if (why) parts.push(`why: ${why}`);
    if (r.detail) parts.push(r.detail);
    return mathPlain(parts.join(' — '));
  }

  // The operating point a bind sliced at — declared, or filled from the namespace default —
  // formatted "vds 0.9V, vsb 0V", so the bias behind a sized width is never invisible. A "?"
  // marks a coordinate the engine assumed rather than the author stating it (see bindAssumed).
  const biasStr = (b: Record<string, number> | undefined, assumed?: string[]): string =>
    b
      ? Object.entries(b)
          .map(([k, v]) => `${k} ${formatSI(v)}${axisUnit(k)}${assumed?.includes(k) ? '?' : ''}`)
          .join(', ')
      : '';
  const biasText = $derived(biasStr(result?.bind?.bias, result?.bind?.assumed));
  const biasHelp = (assumed: string[] | undefined): string =>
    CONTROL_HELP.bindBias + (assumed?.length ? `\n\n${CONTROL_HELP.bindAssumed}` : '');

  // An infeasible child's failing HARD rules (advisory guardrails excluded) — so the cause of a
  // red child block is on screen, not just its ✗.
  const childFails = (c: SheetChildReport | undefined): RuleResult[] =>
    c && !c.feasible ? c.rules.filter((r) => r.kind !== 'guardrail' && r.status === 'fail') : [];

  // A pin whose bisection never landed leaves `values[name]` at the last PROBE — a bracket end,
  // not a solved node — so the field must not present it as the value the design used. The solver
  // marks that failure as an error warning naming the param (solveFailed in the core's eval).
  const pinFailed = (p: SheetVar): boolean =>
    isPinned(p) &&
    result !== undefined &&
    !result.feasible &&
    result.warnings.some((w) => w.message.includes(`pinned param "${p.name}"`));
  // The read-only field's tooltip: which mechanism owns the number, or that there is none.
  const solvedHelp = (p: SheetVar): string | undefined => {
    if (torn(p)) return CONTROL_HELP.solvedParam;
    if (!isPinned(p)) return undefined;
    return pinFailed(p) ? CONTROL_HELP.pinNotLanded : CONTROL_HELP.pinnedParam;
  };

  // Params group by role when ANY carries one (spec = the requirement, choice = the design knobs);
  // otherwise a single flat list, unchanged. Untagged params in a role-bearing doc trail ungrouped.
  const hasRoles = $derived(cfg.params.some((p) => p.role));
  const specParams = $derived(cfg.params.filter((p) => p.role === 'spec'));
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
    <!-- A tearing variable is solved, not set: show what it converged to (the authored value is
         only a starting guess) and refuse edits, rather than offering a knob the next
         evaluation discards. A pin that did not land has nothing to show, so it reads "—". -->
    <input
      class="num"
      class:solved={engineSolved(p)}
      type="text"
      inputmode="text"
      spellcheck="false"
      readonly={engineSolved(p)}
      tabindex={engineSolved(p) ? -1 : undefined}
      title={solvedHelp(p)}
      value={pinFailed(p)
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
     bind at `path`. A field the bind must pin (vds, no default) but hasn't reads "needs"; body
     bias (vsb) pre-fills its default 0. A param-driven declaration shows read-only (edit the param). -->
{#snippet biasCtl(bind: SheetBind | undefined, report: BindReport | undefined, path: number[])}
  {@const axes = biasAxesFor(report)}
  {#if bind && axes.length}
    <div class="sbiasctl">
      {#each axes as ax}
        {@const decl = biasField(bind, ax)}
        {@const need = report?.needs?.includes(ax) ?? false}
        {#if isLiteral(decl)}
          <label
            class="bx"
            class:need
            title={need ? CONTROL_HELP.bindNeeds : CONTROL_HELP.bindBias}
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
          <span class="bx ro" title={CONTROL_HELP.bindBias}
            >{@html qLabel(ax)}=<code>{@html qFormula(decl ?? '')}</code></span
          >
        {/if}
      {/each}
    </div>
  {/if}
{/snippet}

<!-- One composed block as a self-contained card: its sizing, the operating point it's pinned at,
     the scalars it hands up, its failing constraints, and — recursively — its own children, so the
     composition tree reads as nested modules. `use` is this card's block from the RESOLVED tree
     (a by-reference child carries its materialized doc plus the ref as provenance); `path` is its
     index path from the top sheet; `inRef` marks a card living INSIDE a referenced sheet, whose
     internals belong to the library sheet and are read-only here. -->
{#snippet childCard(
  c: SheetChildReport | undefined,
  use: SheetUse | undefined,
  path: number[],
  inRef: boolean = false,
)}
  <!-- An authored ref+doc pair is a PINNED snapshot: the embedded copy wins (core rule),
       so the block is local and editable — only its badge differs. A ref WITHOUT a local
       doc is live: its internals belong to the library sheet and render read-only. -->
  {@const authored = inRef ? undefined : cfgUseAt(path)}
  {@const pinned = authored?.ref !== undefined && authored?.doc !== undefined}
  {@const isRef = inRef || (use?.ref !== undefined && !pinned)}
  <!-- Three states, not two: a block whose condition was never evaluated has no verdict, and a
       ✗ would report one. It still renders — its device control is how the refusal is fixed. -->
  {@const state = c === undefined ? 'skip' : c.feasible ? 'pass' : 'fail'}
  <div class="suse st-{state}">
    <div class="suseh">
      <span class="chip">{state === 'skip' ? '–' : state === 'pass' ? '✓' : '✗'}</span>
      <b>{c?.name ?? use?.name}</b><i>{c?.title ?? use?.doc?.title}</i>
      {#if use?.ref}
        {#if pinned}
          <span
            class="refb pinned"
            title="pinned snapshot of {use.ref} — the embedded copy wins and no longer tracks the library sheet; internals are local and editable"
            >⤷ {use.ref} · pinned</span
          >
        {:else}
          <span class="refb" title={CONTROL_HELP.refBlock}>⤷ {use.ref}</span>
          <!-- Only a MATERIALIZED ref can detach (an unresolved one has nothing to copy —
               rendering the button would be a dead control). -->
          {#if !inRef && use.doc}
            <button class="detach" title={CONTROL_HELP.detachRef} onclick={() => detachRef(path)}
              >detach</button
            >
          {/if}
        {/if}
      {/if}
      {#if path.length === 1 && use && (bench.options.length > 0 || use.device)}
        <span class="dsl" title={CONTROL_HELP.useDevice}>device</span>
        <select
          class="dsel"
          title={CONTROL_HELP.useDevice}
          value={use.device ?? ''}
          onchange={(e) => setUseDevice(path[0], (e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">↳ active device</option>
          {#if use.device && !bench.options.some((o) => o.binding === use.device)}
            <option value={use.device}>{bindingOption(use.device)}</option>
          {/if}
          {#each bench.options as o}<option value={o.binding}>{o.label}</option>{/each}
        </select>
      {/if}
    </div>
    {#if use?.doc?.description}
      <p class="snote sudesc">{@html mathText(use.doc.description)}</p>
    {/if}
    {#if c?.bind?.ok}
      <div class="susebind">
        W={fmt(c.bind.W)}m · V<sub>GS</sub>={fmt(c.bind.vgs)}V · I<sub>D</sub>={fmt(c.bind.id)}A
        {#if c.bind.bias}<span class="sbias" title={biasHelp(c.bind.assumed)}
            >@ {biasStr(c.bind.bias, c.bind.assumed)}</span
          >{/if}
      </div>
    {:else if c?.bind}
      <div class="perr" title={c.bind.error}>sizing: {c.bind.error}</div>
    {/if}
    <!-- A referenced block's bind belongs to the library sheet — no in-place bias editor
         (the applied operating point still shows in the sizing line; params remain the
         customization channel, and detach makes the internals local). -->
    {#if !isRef}{@render biasCtl(use?.doc?.bind, c?.bind, path)}{/if}
    {#if c && Object.keys(c.provides).length}
      <div class="prov" title={CONTROL_HELP.provide}>
        {#each Object.entries(c.provides) as [k, v]}<code
            >{@html qFormula(joinProvide(c.name, k))}={fmt(v)}</code
          >{/each}
      </div>
    {/if}
    {#if childFails(c).length}
      <div class="cfails">
        {#each childFails(c) as r}<span class="cfail" title={ruleTitle(r, use?.doc?.rules ?? [])}
            >✗ {r.id} {pct(r.marginPct)}</span
          >{/each}
      </div>
    {/if}
    {#if c?.children?.length}
      <div class="skids">
        {#each c.children as gc, k}{@render childCard(
            gc,
            use?.doc?.uses?.[k],
            [...path, k],
            isRef,
          )}{/each}
      </div>
    {/if}
  </div>
{/snippet}

<div class="sheet">
  <div class="shead">
    <select class="rm" onchange={pickSheet} title={CONTROL_HELP.sheet}>
      <option value="" selected>sheet…</option>
      {#each menu as g, gi}
        <optgroup label={g.label}>
          {#each g.sheets as s, si}<option value={`${gi}:${si}`}>{s.title}</option>{/each}
        </optgroup>
      {/each}
    </select>
    <strong>{cfg.title}</strong>
    <!-- The headline verdict. With several conditions selected it is the AGGREGATE, never one
         condition's answer wearing no label: a bare verdict cannot render here. -->
    {#if multi}
      <span class="feasb {AGG_CLASS[agg.closes]}" title={CONTROL_HELP.cornerAggregate}
        >{aggregateText}</span
      >
      {#if agg.covers}
        <span class="feasb {COVERS_CLASS[agg.covers.state]}" title={CONTROL_HELP.edges}
          >{coversText}</span
        >
      {/if}
    {:else if evaluated && result}
      <span class="feasb {result.feasible ? 'ok' : 'no'}" title={CONTROL_HELP.feasBadge}>
        {result.feasible ? 'feasible' : 'infeasible'}{#if binding}<i
            >{binding.id} {pct(binding.marginPct)}</i
          >{/if}
      </span>
    {:else}
      <span class="feasb skip" title={CONTROL_HELP.cornerNotEvaluated}>not evaluated</span>
    {/if}
    <!-- Which condition the verdict belongs to. It is never omitted: an unstamped verdict is a
         claim about a chip that was never characterized. -->
    {#if refKey && !multi}
      <span class="scond" data-condition={variantLabel(refKey)} title={CONTROL_HELP.cornerMode}
        >at {variantLabel(refKey)}</span
      >
    {/if}
    <!-- On demand only: each knob costs two full evaluations, so this never runs with the badge. -->
    <button
      class="sensb"
      class:on={sens !== null}
      disabled={!sensReady && !shot}
      title={multi ? CONTROL_HELP.cornerOneAtATime : CONTROL_HELP.sensitivity}
      onclick={toggleSens}>sensitivities</button
    >
    {#if result?.bind && !multi}
      {#if result.bind.ok}
        <span class="bind"
          >W={fmt(result.bind.W)}m · V<sub>GS</sub>={fmt(result.bind.vgs)}V · I<sub>D</sub>={fmt(
            result.bind.id,
          )}A</span
        >
        {#if biasText}
          <span class="sbias" title={biasHelp(result.bind?.assumed)}>@ {biasText}</span>
        {/if}
      {:else}
        <span class="perr" title={result.bind.error}>sizing: {result.bind.error}</span>
      {/if}
      {@render biasCtl(cfg.bind, result.bind, [])}
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
    {#if active && sweepable2.length}
      <label
        class="swsel2"
        title={multi ? CONTROL_HELP.cornerOneAtATime : CONTROL_HELP.sheetSweep2}
      >
        ×
        <select
          value={active2}
          disabled={multi}
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
        {#each chosenOptions as c (variantKeyId(c.key))}
          <label class="ckey" class:absent={c.absent}>
            <input type="checkbox" checked={c.on} onchange={() => toggleKey(c.key)} />{variantLabel(
              c.key,
            )}{#if c.absent}<i>not loaded</i>{/if}
          </label>
        {/each}
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
        {#each primary.variants as t (tableUid(t))}
          <button onclick={() => bench.designate(primary.familyUid, tableUid(t))}
            >designate {variantLabel(t.id)}</button
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
      <p>no device family is loaded for this panel.</p>
    </div>
  {/if}

  <!-- Every selected condition, each with its own two answers and its own label. The aggregate
       in the header is a fold of exactly these rows, and never replaces them. -->
  {#if multi}
    <!-- The worst reading over the conditions that RAN, labelled as such: it is a display fold,
         and it must never be read as a margin over the set when part of the set went
         unevaluated. -->
    {#if agg.worstMargin !== null}
      <p class="scap" title={CONTROL_HELP.cornerAggregate}>
        worst hard-rule margin among the {agg.counts.pass + agg.counts.fail} condition{agg.counts
          .pass +
          agg.counts.fail ===
        1
          ? ''
          : 's'} evaluated: {pct(agg.worstMargin)}
      </p>
    {/if}
    <table class="scorntab">
      <tbody>
        {#each runs as r (variantKeyId(r.key))}
          {@const detail = runDetail(r)}
          <tr class="st-{runClass(r)}" data-corner-row={variantLabel(r.key)}>
            <td class="ccond">{variantLabel(r.key)}</td>
            <td class="ccl">{closesCell(r)}</td>
            {#if agg.covers}<td class="ccv">{coversCell(r)}</td>{/if}
            <td class="ccd" title={detail}>{detail}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <!-- A condition that was refused: the engine never ran there, so there is no verdict — only
       the named reason, which is a different thing from a design that does not close. -->
  {#if refRun && refRun.state === 'not-evaluated'}
    <div class="snotev" data-not-evaluated={variantLabel(refRun.key)}>
      <p><b>not evaluated at {variantLabel(refRun.key)}</b></p>
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
      detail below is <b>{variantLabel(refKey)}</b> — one of {keys.length} conditions
    </p>
  {/if}

  {#if sensLines}
    <div class="ssens">
      <span class="glabel" title={CONTROL_HELP.sensitivity}>sensitivities</span>
      {#if focusRule}
        <p class="scap">
          how <b>{focusRule.id}</b>’s margin moves per {SENSITIVITY_REL_STEP * 100}% step of each
          knob, in that rule’s own units — ↑ raises the knob, ↓ lowers it
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
        <div class="skline dead">no hard rule reports a finite margin to rank knobs against</div>
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
  {#if cfg.uses?.length}
    <div class="suses">
      <span class="glabel" title={CONTROL_HELP.provide}>composed blocks</span>
      {#each cfg.uses as _u, i}
        {@render childCard(result?.children?.[i], rr.doc.uses?.[i], [i], false)}
      {/each}
    </div>
  {/if}

  {#if result}
    {@const res = result}
    {#if cfg.rows.length}
      <div class="srows">
        {#each cfg.rows as row}
          <div class="srow">
            <span class="seq"
              ><b>{@html qLabel(row.name)}</b> = {@html qFormula(row.expr)} =
              <span class="sval">{fmt(res.values[row.name])}{row.unit ?? ''}</span></span
            >
            {#if row.note}<span class="snote">{@html mathText(row.note)}</span>{/if}
          </div>
        {/each}
      </div>
    {/if}

    <table class="srules">
      <tbody>
        {#each res.rules as r}
          <tr class="st-{r.status}" class:advisory={r.kind === 'guardrail'} title={ruleTitle(r)}>
            <td
              class="chip"
              title={r.status === 'amber'
                ? CONTROL_HELP.amber
                : r.status === 'na'
                  ? CONTROL_HELP.ruleNa
                  : undefined}>{CHIP[r.status]}</td
            >
            <td class="rid"
              >{r.id}<i title={CONTROL_HELP.ruleKind}
                >{r.kind === 'guardrail' ? 'guardrail · advisory' : r.kind}</i
              ></td
            >
            <td class="rtext">
              <span class="req">{@html qFormula(r.text)}</span>
              {#if ruleNote.get(r.id)}<span class="snote"
                  >{@html mathText(ruleNote.get(r.id) ?? '')}</span
                >{/if}
              {#if r.detail}<span class="snote sdetail">{r.detail}</span>{/if}
            </td>
            <td class="rnum">{fmt(r.lhsValue)} / {fmt(r.rhsValue)}</td>
            <td class="rmar">{r.status === 'na' ? '—' : pct(r.marginPct)}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    {#if res.edges?.length}
      <div class="sedges">
        <span class="glabel" title={CONTROL_HELP.edges}>range coverage</span>
        {#each res.edges as e (e.name)}
          {@const detail = edgeDetail(e)}
          <span class="sedge {EDGE_CLASS[e.state]}" title={edgeTitle(e, detail)}>
            {EDGE_MARK[e.state]}
            {e.name}{#if edgeWarns(e).length}&nbsp;⚠{/if}
            {#if detail}<i>{detail}</i>{/if}
          </span>
        {/each}
      </div>
    {/if}
  {/if}

  {#if twoD && swept2 && swept2.x.length}
    <div class="scap">
      feasibility · <b>{active}</b> × <b>{active2}</b> — green closes, red fails a hard rule (X → right,
      Y ↑)
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
        no hard rule fails across this plane
      {/if}
    </p>
  {:else if active && chartData && !twoD}
    <div class="scap">
      {#if multi}
        worst hard-rule margin (%) vs <b>{active}</b>{#if sweptUnit}
          ({sweptUnit}){/if} — one curve per condition that was evaluated; the 0 line is the constraint
        boundary, clipped at ±{MARGIN_CLIP}%. A condition that could not be evaluated draws no curve
        and stays in the table above.
      {:else}
        margin (%) vs <b>{active}</b>{#if sweptUnit}
          ({sweptUnit}){/if} — the 0 line is the constraint boundary; dashed = guardrail (advisory); clipped
        at ±{MARGIN_CLIP}%{#if (cfg.edges ?? []).length}
          · each sample checks its OWN design at the claimed range ends, so the coverage curves move
          with the sweep{/if}
      {/if}
    </div>
    <div class="pchart" bind:this={el}></div>
    <!-- Colour key: ten unlabelled lines are unreadable, and this panel has no shared footer
         legend the way a data panel does. Index order matches what ChartAdapter strokes. A
         guardrail is dashed on the chart and tagged here, since an inline-styled swatch cannot
         carry the dash. -->
    <div class="skey">
      {#if multi}
        {#each chartData.lineLabels ?? [] as label, i}
          <span class="kitem"><i style="background:{PALETTE[i % PALETTE.length]}"></i>{label}</span>
        {/each}
      {:else}
        {#each swept?.rules ?? [] as r, i}
          <span class="kitem"
            ><i style="background:{PALETTE[i % PALETTE.length]}"></i>{ruleLabel(
              r,
            )}{#if r.kind === 'guardrail'}&nbsp;·&nbsp;adv{/if}</span
          >
        {/each}
      {/if}
    </div>
    {#if feasWindow && !multi}
      <p class="feas">
        {#if feasWindow.none}
          no feasible {active} in this range
        {:else}
          feasible {active} ≈ {fmt(feasWindow.lo)}…{fmt(
            feasWindow.hi,
          )}{sweptUnit}{#if feasWindow.gap}
            (non-contiguous){/if}
        {/if}
      </p>
    {/if}
  {:else if active && refRun}
    <!-- The sweep is a statement about a design, and there is no design here yet. -->
    <p class="feas">
      {multi
        ? 'no condition in this set was evaluated, so there is nothing to sweep'
        : `nothing to sweep at ${variantLabel(refRun.key)} — this condition was not evaluated`}
    </p>
  {/if}

  <!-- Resolution failures (missing/ambiguous/cyclic refs) lead — they explain why a
       referenced block below reads infeasible. One dead child makes EVERY dependent
       row "not defined"; that fan-out is collapsed to a single line per child so the
       root cause isn't buried under its own consequences. -->
  {#each warnLines as w}
    <p class="pwarn" title={w.help ? `${w.text}\n\n${w.help}` : w.text}>⚠ {w.text}</p>
  {/each}

  <!-- Informational, and kept out of the warning list above: nothing went wrong, the loop closed
       and the verdict stands. -->
  {#each solveNotes as n}
    <p class="pinfo">{n}</p>
  {/each}
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
  /* Overall feasibility badge: the design's headline verdict, so a red advisory guardrail below
     it is never mistaken for the whole design failing. */
  /* One pill shell for the verdict badge and the edge chips; each keeps only its own
     text treatment. */
  .feasb,
  .sedge {
    padding: 0.04rem 0.4rem;
    border-radius: 999px;
    border: 1px solid currentColor;
  }
  .feasb {
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
  .sedge.ok {
    color: var(--ok);
  }
  .feasb.no,
  .sedge.no {
    color: var(--err);
  }
  /* A range end nobody checked, and a condition nobody could evaluate: the body text colour,
     dimmed. Deliberately neither status colour — both have to read as an open question, and
     green or red would each answer it. */
  .sedge.skip,
  .feasb.skip {
    color: var(--fg);
    opacity: 0.55;
    border-style: dashed;
  }
  /* The condition a verdict was measured at. Quiet, and never optional. */
  .scond {
    font-family: ui-monospace, monospace;
    font-size: calc(0.72rem * var(--text-scale));
    opacity: 0.7;
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
  /* The binding constraint rides inside the badge: same colour, but normal-case and lighter,
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
  /* A solved tearing variable reads as a reported value, not a field you can type into. */
  .num.solved {
    border-style: dashed;
    opacity: 0.75;
    cursor: default;
  }
  .sld {
    width: 100%;
    min-width: 0;
  }
  /* Intermediate/output equations: one block per row — the rendered formula and its value,
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
  /* Author comment explaining an equation or rule — the "why", not the math. */
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
  /* composed blocks: each `use` is a self-contained card (sizing, provides, failing rules),
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
  /* the left rail tints to the block's verdict — green closes, red doesn't, and neither
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
  /* On-demand knob ranking for the binding (or limiting) rule — a short block, deliberately:
     three knobs and their reasons, not a table of every rule against every param. */
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
  /* a bias the bind MUST pin but hasn't — the fail-closed remedy, flagged for the eye. */
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
  /* An infeasible child's failing hard rules — one compact line inside its card. */
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
  /* the note shares the rules cell but must not inherit its baseline nowrap siblings */
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
  /* A guardrail is advisory — it never gates feasibility — so even a failing one reads amber
     (a heads-up), not the hard-fail red an invariant/requirement earns. */
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
  /* Warnings WRAP where the inline errors do not: a wiring disagreement's whole content is the
     two voltages and the delta at the end of the sentence, which a single clipped line throws
     away. Two or three lines in a scrolling panel is the cheaper cost. */
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
</style>
