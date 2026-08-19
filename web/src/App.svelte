<script lang="ts">
  import { tick, untrack } from 'svelte';
  import {
    plottableQuantities,
    importMostab,
    metaScalars,
    formatEng,
    formatSI,
    validate,
    validateFamilies,
    validateFamily,
    variantLabel,
    EXAMPLES,
    DERIVED_QUANTITIES,
    cloneDoc,
    withParams,
    type CornerFamily,
    type QAWarning,
    type DeviceTable,
    type Grid,
    type SheetDoc,
  } from '@gmid/mostab-core';
  import { axisUnit, baseUnit } from './labels';
  import Panel from './Panel.svelte';
  import Sizer from './Sizer.svelte';
  import Picker from './Picker.svelte';
  import Help from './Help.svelte';
  import { CONTROL_HELP } from './help';
  import {
    loadSettings,
    saveSettings,
    applySettings,
    FONT_RANGE,
    TEXT_SCALE_RANGE,
    type Settings,
  } from './settings';
  import { loadJSON, removeJSON, saveJSON, SIZER_KEY } from './storage';
  import { importSheetJSON, removeUserSheet, userSheets } from './sheetlib.svelte';
  import {
    presetDashboard,
    sanitizeDashboard,
    reseatDashboard,
    canPlot,
    deviceKey,
    tableUid,
    defaultBias,
    TEMPLATES,
    LENGTH_AXIS,
    GM_ID,
    type Dashboard,
    type PanelTemplate,
  } from './dashboard';
  import { clearTables, deleteTable, loadTables, putTable, saneTable } from './devstore';
  import {
    benchFamilies,
    familyLabel,
    familyOptions,
    familyResolver,
    familyRevision,
    migrateNominals,
    parseRegistry,
    provenanceOf,
    REGISTRY_VERSION,
  } from './families';

  // The device-level core is the single source of truth. Devices are loaded at runtime by
  // importing a mostab file; the app boots EMPTY (no built-in data) and shows a load prompt
  // until the first import.
  // The loaded devices accumulate across imports so any subset can be overlaid for comparison
  // (NMOS vs PMOS, corner vs corner). `device` is the active/primary one — it drives the
  // dashboard, the expression pickers, the bias sliders, and the sizer. It is `undefined` only in
  // the empty boot state, which the template gates behind a load prompt. The overlay set is
  // chart-only and in-memory. Loaded tables persist LOCALLY in IndexedDB (client-only — nothing
  // ever leaves the machine) so a reload restores the bench; the devices strip is the visible
  // registry of what is retained, with per-device remove and clear-all as the deletion controls.
  // QA warnings live WITH their table so the displayed QA always matches the active device and
  // can never go stale when the active device changes or a device is removed.
  type Loaded = { table: DeviceTable; warnings: readonly QAWarning[] };
  let devices = $state<Loaded[]>([]);
  let activeIdx = $state(0);
  let overlayIdx = $state<number[]>([]);
  const active = $derived(devices[activeIdx]);
  const device = $derived(active?.table);
  const overlays = $derived(
    overlayIdx.map((i) => devices[i]?.table).filter((d): d is DeviceTable => !!d),
  );
  const warnings = $derived(active?.warnings ?? []);

  // The registry sidecar: load order + active index + each family's nominal designation, so a
  // reload restores the bench exactly (IndexedDB getAll returns key order, which is not load
  // order, and holds no designations at all).
  const REG_KEY = 'gmid.devreg';
  $effect(() => {
    if (devices.length) {
      saveJSON(REG_KEY, {
        v: REGISTRY_VERSION,
        order: devices.map((d) => tableUid(d.table)),
        active: activeIdx,
        nominalByFamily,
      });
    }
  });
  // Restore locally persisted tables once at boot, MERGING with anything imported
  // while the IndexedDB read was in flight — neither side may be discarded (an early
  // import used to win outright, and the registry effect would then erase the whole
  // persisted bench on the next reload).
  //
  // The registry (synchronous localStorage) says WHAT the bench holds and in which
  // order; IndexedDB only carries the bulk data. It is read HERE, synchronously at
  // boot, and NOT inside the async restore: an import that lands while the IndexedDB
  // read is in flight rewrites the registry (the effect above), and deletion
  // decisions made against that rewrite would erase the whole prior bench. Script
  // init runs before the UI exists, so nothing can have touched the registry yet.
  // It is authoritative ONLY when it is present and parses as a list of uids: a
  // stored table it does not list is then a leftover (e.g. a clear whose IndexedDB
  // transaction was aborted by an immediate reload) and is deleted. A MISSING or
  // unreadable or malformed registry (blocked localStorage, selectively cleared or
  // corrupted site data) must not read as an intentionally empty bench — then
  // everything sound is restored and nothing is deleted.
  // Version 1 stored `{order, active}`; it parses here as a version-2 registry with no
  // designations, which is the whole migration — a bench that designated nothing has nothing
  // to carry over, and the first save writes the versioned shape.
  const bootReg = loadJSON(REG_KEY, parseRegistry, () => null);
  // familyUid → the table uid the bench designates as that family's nominal condition. Seeded
  // from the registry before the first save effect can run, so a restore never writes an empty
  // set over the stored designations.
  let nominalByFamily = $state<Record<string, string>>({ ...(bootReg?.nominalByFamily ?? {}) });
  // Corner families: the loaded tables regrouped into logical devices, one entry per
  // (process namespace, device name, declared polarity). Identity is derived from the data
  // headers, never assigned here — the bench displays, warns, and designates a nominal
  // condition, but never decides who a table is. Everything a sheet or the picker projects
  // goes through these.
  //
  // The previous grouping is kept so a family nothing touched comes back as the SAME object and
  // everything memoized on it survives. Plain state, not `$state`: it is written from inside the
  // derived purely as that derived's own memo, and nothing reads it as a value.
  let lastFamilies: readonly CornerFamily[] = [];
  const families = $derived.by(() => {
    lastFamilies = benchFamilies(
      devices.map((d) => d.table),
      nominalByFamily,
      lastFamilies,
    );
    return lastFamilies;
  });
  const familyOf = $derived(familyResolver(families));
  const primaryFamily = $derived(device ? familyOf(tableUid(device)) : undefined);
  // Data-trust checks that only exist once several tables claim to be one device (duplicate
  // conditions, disagreeing axes, ranges, widths, provenance). Derived, so they are recomputed
  // on every import, restore, removal and redesignation rather than stored and left to age —
  // but per FAMILY OBJECT, so the redesignation of one family does not re-walk the axis lattice
  // of every other. The cache is weak: a family that regrouped is unreachable and collectable.
  const qaCache = new WeakMap<CornerFamily, QAWarning[]>();
  const familyQAOf = (f: CornerFamily): QAWarning[] => {
    const hit = qaCache.get(f);
    if (hit) return hit;
    const qa = validateFamily(f);
    qaCache.set(f, qa);
    return qa;
  };
  const familyQA = $derived(new Map(families.map((f) => [f.familyUid, familyQAOf(f)])));
  // Cross-family identity warnings (a join grouping refused): bench-level, because no single
  // family can see the sibling it stayed apart from.
  const benchQA = $derived(validateFamilies(families));
  const bench = $derived({
    families,
    familyOf,
    primary: primaryFamily,
    // What a composed child's device menu offers: one entry per FAMILY, because a child is bound
    // to a logical device and projected to whichever condition the run fixed.
    options: familyOptions(families),
    revision: familyRevision(families),
    designate,
  });
  // Position of a table in `devices` — the strip renders families, but select/overlay/remove
  // still address the flat list.
  const indexOfUid = $derived(new Map(devices.map((d, i) => [tableUid(d.table), i])));
  void loadTables().then((stored) => {
    const pos = new Map(bootReg?.order.map((u, i) => [u, i]) ?? []);
    // Records whose stored key is not what the current algorithm computes. The registry names
    // tables by uid in TWO places now (the order, and every designation), so a re-key that
    // rewrote only the order would leave designations pointing at keys nothing holds.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive migration scratch, discarded below
    const rekey = new Map<string, string>();
    // Imports that raced ahead keep their position, stay active, and are never
    // treated as unlisted leftovers; restored tables append behind them, ordered by
    // the STORED key's registry slot (a recomputed uid may not match what the
    // registry recorded; without a registry every rank ties and order is kept).
    const have = new Set(devices.map((d) => tableUid(d.table)));
    const restored: { item: Loaded; rank: number }[] = [];
    for (const { key, table: dt } of stored) {
      try {
        // Trust nothing: a corrupt/stale record is skipped, not rendered.
        if (!saneTable(dt)) continue;
        const uid = tableUid(dt);
        if (have.has(uid)) {
          // A fresh import superseded this record; drop a stale-keyed copy. Both spellings are
          // in hand here, so the migration map records them: a designation naming the old key
          // would otherwise read as unresolved while the table it names is on the bench.
          if (key !== uid) {
            void deleteTable(key);
            rekey.set(key, uid);
          }
          continue;
        }
        // The registry recorded the key the table was STORED under; match and delete
        // by that key, never only by the recomputed uid — when the uid algorithm
        // changes, matching on the recomputation would silently drop the whole bench
        // and deleting by it would strand every record under its old key.
        if (bootReg && !pos.has(key) && !pos.has(uid)) {
          void deleteTable(key);
          continue;
        }
        if (key !== uid) {
          // Self-migration: the uid algorithm changed since this was stored — re-key
          // the record; the registry effect below then records the new uids.
          void putTable(uid, dt);
          void deleteTable(key);
          rekey.set(key, uid);
        }
        restored.push({
          item: { table: dt, warnings: validate(dt) },
          rank: pos.get(key) ?? pos.get(uid) ?? Number.MAX_SAFE_INTEGER,
        });
      } catch {
        // a table that no longer validates is dropped silently
      }
    }
    // In the same breath as the tables themselves: the save effect fires as soon as `devices`
    // changes below, and it would persist designations that still name the pre-migration uids.
    // A designation whose table did NOT come back is left exactly as it was — it reads as an
    // unresolved designation, which is the visible truth, where dropping it would let the
    // family quietly designate a different corner.
    if (rekey.size) nominalByFamily = migrateNominals(nominalByFamily, rekey);
    if (!restored.length) return;
    restored.sort((a, b) => a.rank - b.rank);
    const wasEmpty = devices.length === 0;
    devices = [...devices, ...restored.map((r) => r.item)];
    if (wasEmpty) select(Math.min(Math.max(bootReg?.active ?? 0, 0), restored.length - 1));
  });
  let importError = $state<string | null>(null);
  let dragging = $state(false);

  // Canonical key → display metadata (static; reused by the picker and sliders).
  const derivedExpr = new Map(DERIVED_QUANTITIES.map((q) => [q.key, q.expr]));

  // Names of the multi-value axes — the only ones worth charting or sweeping.
  const multiAxisNames = (grid: Grid) =>
    grid.axes.filter((a) => a.values.length > 1).map((a) => a.name);
  const multiAxes = $derived(device ? multiAxisNames(device.grid) : []);

  // Dashboard config (tabs → grids of panels). Restored from a saved layout when one
  // is present and valid for this device, else the device's canonical preset. A device
  // swap re-validates the live layout against the new device (in select()), preserving the
  // user's tabs and panels; panel edits never reseed it.
  // Bumped to .v2 when panels/tabs gained the `auto` origin marker: a layout saved before that
  // has no markers, so a device swap could not tell its canonical panels apart and would
  // duplicate them. Reseeding the preset once on upgrade is cleaner than half-migrating.
  const DASH_KEY = 'gmid.dash.v2';
  const loadDashboard = (dev: DeviceTable): Dashboard =>
    loadJSON(
      DASH_KEY,
      (raw) => sanitizeDashboard(raw, dev),
      () => presetDashboard(dev),
    );
  // Null until the first device loads — the dashboard can only be seeded/validated against a
  // device (sanitizeDashboard/presetDashboard both need one). The saved layout in localStorage is
  // restored at that point, so a customized dashboard still survives a reload.
  let dashboard = $state<Dashboard | null>(null);
  const activeTab = $derived(
    dashboard ? (dashboard.tabs[dashboard.activeTab] ?? dashboard.tabs[0]) : undefined,
  );
  // Persist the layout (not the device — that re-seeds on load) so a customized dashboard
  // survives a reload. Best-effort. Never clobber the saved layout with the empty-boot null.
  $effect(() => {
    if (dashboard) saveJSON(DASH_KEY, dashboard);
  });

  // Appearance settings (theme + font sizes). Applied to the document root and persisted on
  // every change. The whole UI and the canvas chart follow (both read system colours + vars).
  let settings = $state<Settings>(loadSettings());
  // Live readout while dragging the UI-zoom slider. The zoom (root font-size) drives EVERY rem
  // in the layout — including the header this popover hangs off — so applying it mid-drag would
  // move the slider under the pointer (a moving target). We commit it only on release (onchange);
  // oninput just updates this display, so the drag stays still and the zoom snaps in on release.
  // (Text size needs no such dance: it touches only panel text, never this chrome.)
  let uiZoomDrag = $state(settings.fontUi);
  // `styleVersion` signals each Panel to chart.restyle() (the chart re-reads its themed colour
  // and tick font from CSS only at construction). It is bumped INSIDE the apply effect, AFTER
  // applySettings has committed color-scheme to the DOM — so the restyle reads the just-applied
  // scheme, not the previous one. (A plain $derived recomputes the instant settings change and
  // let the child restyle effect run first, reading the stale scheme and inverting the ticks.)
  // Only the two canvas-relevant settings (theme + tick font) trigger a bump; UI/title fonts
  // are pure CSS and need no rebuild.
  let styleVersion = $state(0);
  let prevStyleKey = '';
  $effect(() => {
    applySettings(settings);
    saveSettings(settings);
    const key = `${settings.theme}|${settings.fontAxisLabel}`;
    if (key !== prevStyleKey) {
      prevStyleKey = key;
      untrack(() => (styleVersion += 1));
    }
  });

  // Operating point: sharedBias carries a value for EVERY non-sweep multi-value axis, so
  // any panel can pin the axes it doesn't fan. Seeded on a device/sweep change only (never
  // on tab/panel edits), so the operating point persists.
  const biasAxes = $derived.by(() => {
    if (!device || !dashboard) return [];
    const sweep = dashboard.sweep;
    return device.grid.axes.filter((a) => a.name !== sweep && a.values.length > 1);
  });
  // The per-axis slider bind:value={sharedBias[a.name]} needs $state's deep proxy; a
  // writable $derived yields a plain object whose per-key mutations are not reactive.
  // eslint-disable-next-line svelte/prefer-writable-derived
  let sharedBias = $state<Record<string, number>>({});
  $effect(() => {
    sharedBias = Object.fromEntries(biasAxes.map((a) => [a.name, defaultBias(a)]));
  });
  // A slider step on a 1/2/5 decade grid: the thumb then lands on values the label
  // renders exactly (a free range/100 step gives 18 mV positions that read as rounded).
  const niceStep = (lo: number, hi: number): number => {
    const raw = (hi - lo) / 150;
    const p = 10 ** Math.floor(Math.log10(raw));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  };
  // Sliders shown = bias axes that at least one panel in the ACTIVE tab actually pins (does
  // not fan into its family). An axis every visible panel fans is inert here, so it's
  // hidden — but its value is still held, and a panel that DOES pin it (single-curve, or a
  // differently-fanned panel) gets the right bias and brings its slider back.
  const shownBiasAxes = $derived(
    activeTab ? biasAxes.filter((a) => activeTab.panels.some((p) => p.family !== a.name)) : [],
  );

  // Picker for panel X/Y: every quantity THIS device resolves along the sweep,
  // including derived ones the width scalar unlocks (id/w).
  const exprOptions = $derived.by(() => {
    if (!device || !dashboard) return [];
    const pq = plottableQuantities(
      device.grid,
      dashboard.sweep,
      Object.keys(metaScalars(device.meta)),
    );
    return [
      ...pq.base.map((k) => ({ value: k, label: `${k} [${baseUnit.get(k)}]` })),
      ...pq.derived.map((k) => ({
        value: k,
        label: `${k} = ${derivedExpr.get(k)}`,
        formula: derivedExpr.get(k),
      })),
    ];
  });
  const defaultFamily = $derived(multiAxes.includes(LENGTH_AXIS) ? LENGTH_AXIS : '');

  // Offer only the templates the active device can actually plot: both axes must resolve against
  // this device + sweep (the same plottability the axis pickers and the Overview preset use), so
  // the no-typing menu never advertises a canonical plot that would open as an erroring panel
  // (e.g. fT / gm·gds on an import with no CGG / GDS column). Keeps each template's original
  // index so `addFromTemplate` still resolves it in TEMPLATES.
  const templateOptions = $derived.by(() => {
    const ok = new Set(exprOptions.map((o) => o.value));
    return TEMPLATES.map((t, i) => ({ t, i })).filter(({ t }) => canPlot(t, ok));
  });

  // Dashboard mutations. activeTab / cfg are proxied $state objects, so mutating
  // their fields (or splicing the arrays) is reactive without re-finding by id.
  // Add a panel from a template (the canonical plots) or, with no template, a blank one.
  // A template without its own family fans the device's default (L when present).
  function addPanel(tpl?: PanelTemplate): void {
    if (!activeTab) return;
    activeTab.panels.push({
      id: crypto.randomUUID(),
      xExpr: tpl?.xExpr ?? GM_ID,
      yExpr: tpl?.yExpr ?? 'id',
      family: tpl?.family ?? defaultFamily,
      render: 'chart',
    });
  }
  // Add from the template <select>, then snap it back to its placeholder.
  function addFromTemplate(e: Event): void {
    const sel = e.currentTarget as HTMLSelectElement;
    const i = Number(sel.value);
    if (Number.isInteger(i) && i >= 0 && i < TEMPLATES.length) addPanel(TEMPLATES[i]);
    sel.value = '';
  }
  // A sheet panel carries '' axes (so the chart axis guard in sanitizeDashboard keeps
  // it) and, by default, a copy of the first vetted example as its starting doc. The picker
  // hands off through here too, with a library sheet and the values it found.
  //
  // It always pushes a NEW panel, never writes into an existing one: every panel mutation is
  // persisted immediately and there is no undo, so adopting a picker result into a panel the
  // designer had tuned would destroy that work silently.
  //
  // The clone comes FIRST because withParams copies only the params array — the rules, rows and
  // child uses would stay aliased to the library literal that every other panel reads.
  function addSheetPanel(doc: SheetDoc = EXAMPLES[0], params: Record<string, number> = {}): void {
    if (!activeTab) return;
    activeTab.panels.push({
      id: crypto.randomUUID(),
      xExpr: '',
      yExpr: '',
      family: '',
      render: 'sheet',
      sheet: withParams(cloneDoc(doc), params),
    });
  }
  function removePanel(id: string): void {
    if (!activeTab) return;
    activeTab.panels = activeTab.panels.filter((p) => p.id !== id);
  }
  function addTab(): void {
    if (!dashboard) return;
    dashboard.tabs.push({
      id: crypto.randomUUID(),
      name: `Tab ${dashboard.tabs.length + 1}`,
      cols: 2,
      panels: [],
    });
    dashboard.activeTab = dashboard.tabs.length - 1;
  }
  function removeTab(i: number): void {
    if (!dashboard || dashboard.tabs.length <= 1) return;
    dashboard.tabs.splice(i, 1);
    if (dashboard.activeTab >= dashboard.tabs.length)
      dashboard.activeTab = dashboard.tabs.length - 1;
  }
  // Inline tab rename: `renaming` is the index whose label is currently an edit box (-1 = none).
  // Started by double-click or F2, committed (trimmed, non-empty) on Enter/blur, cancelled on
  // Escape. The blur guard (renaming !== i) stops Enter/Escape from committing twice as the input
  // unmounts.
  let renaming = $state(-1);
  let tabsNav = $state<HTMLElement>();
  function endRename(i: number, value: string): void {
    if (dashboard) {
      const name = value.trim();
      if (name !== '') dashboard.tabs[i].name = name;
    }
    renaming = -1;
  }
  function onRenameKey(e: KeyboardEvent, i: number): void {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    if (e.key === 'Enter') endRename(i, (e.currentTarget as HTMLInputElement).value);
    else renaming = -1; // cancel; the blur guard then skips committing
    // Commit/cancel unmounts the edit box; put focus back on the tab button that
    // replaces it, else the keyboard user lands on <body> (inactive tabs are
    // tabindex=-1). Only these keyboard paths refocus — a blur means focus
    // deliberately went elsewhere.
    void tick().then(() => focusTab(i));
  }
  const focusSelect = (node: HTMLInputElement): void => {
    node.focus();
    node.select();
  };
  // Tablist keyboard model: the arrows move the active tab (focus follows), F2 renames it. Only
  // the tab buttons drive this — the add/columns/template controls sharing the strip are reached
  // with Tab as usual.
  function focusTab(i: number): void {
    tabsNav?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus();
  }
  function onTabsKey(e: KeyboardEvent): void {
    if (!dashboard || (e.target as HTMLElement).getAttribute('role') !== 'tab') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const n = dashboard.tabs.length;
      dashboard.activeTab = (dashboard.activeTab + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
      focusTab(dashboard.activeTab);
    } else if (e.key === 'F2') {
      e.preventDefault();
      renaming = dashboard.activeTab;
    }
  }
  const setCols = (d: number) =>
    activeTab && (activeTab.cols = Math.min(4, Math.max(1, activeTab.cols + d)));

  // Monotonic token so a slow earlier file read can't clobber a newer load
  // (last-selected wins, not last-resolved).
  let importSeq = 0;

  /** One file, read and parsed but not yet committed to anything. */
  type Staged =
    | { kind: 'sheet'; name: string; text: string }
    | { kind: 'tables'; name: string; tables: readonly DeviceTable[] }
    | { kind: 'failed'; name: string; error: string };

  /**
   * Import a selection (file picker or drop): a .json is a design sheet for the library
   * (sanitized + persisted by sheetlib); anything else is a mostab CSV device table — a
   * multi-corner export is several files, since one file carries one table.
   *
   * One selection is ONE transaction. Every file is read and parsed first, mutating nothing;
   * the supersede token is checked once, immediately before a single commit; and a superseded
   * batch is discarded whole. That is what keeps "last selected wins" meaning what it says —
   * committing file by file would let a stale batch leave half a bench behind, with a load
   * order that depends on which read finished first.
   */
  async function loadFiles(files: FileList | null | undefined): Promise<void> {
    const batch = files ? [...files] : [];
    if (!batch.length) return;
    const seq = ++importSeq;
    // Read in parallel, reassembled in selection order: load order is part of the family
    // contract, and completion order is not an order at all.
    const staged: Staged[] = await Promise.all(
      batch.map(async (file): Promise<Staged> => {
        try {
          if (/\.json$/i.test(file.name))
            return { kind: 'sheet', name: file.name, text: await file.text() };
          const result = importMostab(new Uint8Array(await file.arrayBuffer()), {
            filename: file.name,
          });
          return result.ok
            ? { kind: 'tables', name: file.name, tables: result.dataset.tables }
            : {
                kind: 'failed',
                name: file.name,
                error: result.errors.map((e) => `${e.kind}: ${e.message}`).join(' · '),
              };
        } catch (e) {
          return { kind: 'failed', name: file.name, error: (e as Error).message };
        }
      }),
    );
    if (seq !== importSeq) return; // superseded: the whole batch is discarded, nothing committed

    // ── the commit, in selection order and in one pass.
    const errors: string[] = [];
    const incoming: Loaded[] = [];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive dedup scratch, discarded below
    const seen = new Set<string>();
    for (const s of staged) {
      if (s.kind === 'failed') {
        errors.push(`${s.name}: ${s.error}`);
        continue;
      }
      if (s.kind === 'sheet') {
        const err = importSheetJSON(s.name, s.text);
        if (err) errors.push(`${s.name}: ${err}`);
        continue;
      }
      for (const t of s.tables) {
        // The same table twice in one selection is one table: the first occurrence stands,
        // so the batch's order (and what "the first import" means below) is deterministic.
        const uid = tableUid(t);
        if (seen.has(uid)) continue;
        seen.add(uid);
        incoming.push({ table: t, warnings: validate(t) });
      }
    }
    // A table already loaded under the same identity is REPLACED IN PLACE (a re-import
    // refreshes it without moving its chip); the rest append in selection order.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive merge scratch, discarded below
    const fresh = new Map(incoming.map((d) => [tableUid(d.table), d]));
    const next = devices.map((d) => {
      const uid = tableUid(d.table);
      const r = fresh.get(uid);
      if (r) fresh.delete(uid);
      return r ?? d;
    });
    next.push(...fresh.values());
    devices = next;
    // Select by the first surviving imported UID, never by object identity: a batch whose
    // first file also appears later collapses to one entry, and an identity search would
    // then find nothing and select a slot that does not exist.
    const firstUid = incoming.length ? tableUid(incoming[0].table) : undefined;
    const first = next.findIndex((d) => tableUid(d.table) === firstUid);
    if (first >= 0) select(first);
    // AFTER select(), which clears the error line: a batch that loaded three files and lost
    // one must still say which one, and say it by name.
    importError = errors.length ? errors.join(' · ') : null;
    for (const d of incoming) void putTable(tableUid(d.table), d.table);
  }

  // Make device `i` active (overlays cleared). The user's authored panels and tabs are preserved
  // across the swap; only the auto-generated canonical panels are re-seeded for the new device
  // (reseatDashboard). QA follows automatically — `warnings` is derived from the active device.
  function select(i: number): void {
    importError = null;
    activeIdx = i;
    overlayIdx = [];
    // First device seeds the dashboard (restoring any saved layout); later swaps reseat the live one.
    dashboard = dashboard
      ? reseatDashboard(dashboard, devices[i].table)
      : loadDashboard(devices[i].table);
  }

  // Drop a loaded device from the registry; never remove the last or the active one.
  // Native <details> popovers (provenance, appearance) ignore Escape; close and hand
  // focus back to the summary so the key behaves like every other dismissable panel.
  function closeOnEscape(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    const d = e.currentTarget as HTMLDetailsElement;
    d.open = false;
    (d.querySelector('summary') as HTMLElement | null)?.focus();
  }

  /** Designate (or, on the condition that already holds it, un-designate) a family's nominal.
   *  A designation names a TABLE, so it survives a reload and goes visibly unresolved if that
   *  table leaves — the one thing it must never do is slide to another corner unannounced. */
  function designate(familyUid: string, uid: string): void {
    const { [familyUid]: current, ...rest } = nominalByFamily;
    nominalByFamily = current === uid ? rest : { ...rest, [familyUid]: uid };
  }

  /** The family's conditions that CAN be overlaid: every member but the active one, which is
   *  already the curve the others are drawn against. */
  const overlayable = (f: CornerFamily): number[] =>
    f.variants
      .map((t) => indexOfUid.get(tableUid(t)) ?? -1)
      .filter((i) => i >= 0 && i !== activeIdx);
  const familyOverlaid = (f: CornerFamily): boolean => {
    const idx = overlayable(f);
    return idx.length > 0 && idx.every((i) => overlayIdx.includes(i));
  };
  /** Draw the whole corner spread of one device, or clear it. */
  function toggleFamilyOverlay(f: CornerFamily): void {
    const idx = overlayable(f);
    overlayIdx = familyOverlaid(f)
      ? overlayIdx.filter((i) => !idx.includes(i))
      : [...overlayIdx, ...idx.filter((i) => !overlayIdx.includes(i))];
  }

  function removeDevice(i: number): void {
    if (devices.length <= 1 || i === activeIdx) return;
    void deleteTable(tableUid(devices[i].table));
    devices = devices.filter((_, k) => k !== i);
    // Shift every index past the removed slot down one to track the shrunk list.
    const shift = (k: number) => (k > i ? k - 1 : k);
    activeIdx = shift(activeIdx);
    overlayIdx = overlayIdx.filter((k) => k !== i).map(shift);
  }

  // Forget everything: every loaded device, its overlays, and the locally stored copies.
  // The dashboard layout (localStorage) survives — it holds no characterization data.
  function clearAll(): void {
    void clearTables();
    saveJSON(REG_KEY, { v: REGISTRY_VERSION, order: [], active: 0, nominalByFamily: {} });
    // The sizer's persisted problem is design data too: "forget everything" must
    // leave no retained record the UI can no longer show or delete.
    removeJSON(SIZER_KEY);
    devices = [];
    activeIdx = 0;
    overlayIdx = [];
    // The designations go with them: they name tables that no longer exist, and "forget
    // everything" must not leave a choice behind that nothing on screen can show or undo.
    nominalByFamily = {};
    dashboard = null;
    sizerOpen = false;
    pickerOpen = false;
    importError = null;
  }

  // Toggle device `i` into/out of the overlay set (the active device can't overlay itself).
  function toggleOverlay(i: number): void {
    if (i === activeIdx) return;
    overlayIdx = overlayIdx.includes(i) ? overlayIdx.filter((k) => k !== i) : [...overlayIdx, i];
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragging = false;
    void loadFiles(e.dataTransfer?.files);
  }

  // ── Sizing panel (the "design" workflow). The whole feature lives in <Sizer>; App
  // owns only the open/close toggle and renders it (against the active device + bias)
  // while open.
  let sizerOpen = $state(false);
  // ── Topology picker (the "which design-type" workflow). Same shape as the sizer: App owns
  // the toggle and renders it while open, inside the device guard — the search needs a table.
  let pickerOpen = $state(false);
</script>

<header>
  <h1>gm/ID Workbench</h1>
  <datalist id="exprs">
    {#each exprOptions as o}
      <option value={o.value} label={o.label}></option>
    {/each}
  </datalist>
  {#if dashboard}
    <label class="axis"
      >sweep
      <select bind:value={dashboard.sweep}>
        {#each multiAxes as ax}<option value={ax}>{ax}</option>{/each}
      </select>
    </label>
    <Help text={CONTROL_HELP.sweep} />
    {#each shownBiasAxes as a}
      <label class="slider">
        {a.name}
        <input
          type="range"
          min={a.values[0]}
          max={a.values[a.values.length - 1]}
          step={niceStep(a.values[0], a.values[a.values.length - 1])}
          bind:value={sharedBias[a.name]}
        />
        <span class="val">{formatEng(sharedBias[a.name])}{axisUnit(a.name)}</span>
        <Help text={CONTROL_HELP.bias} />
      </label>
    {/each}
  {/if}
  <span class="grow"></span>
  {#if device}
    <!-- Escape-to-dismiss is a keyboard ENHANCEMENT on a natively interactive disclosure -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <details class="device" onkeydown={closeOnEscape}>
      <summary title="active device — open for the table's provenance">{deviceKey(device)}</summary>
      <dl class="prov">
        <dt>device</dt>
        <dd>{device.id.device}</dd>
        <dt>corner</dt>
        <dd>{device.id.corner}</dd>
        <dt>temp</dt>
        <dd>{device.id.temp}°C</dd>
        {#if device.meta.W !== undefined}<dt>char. W</dt>
          <dd>{formatSI(device.meta.W)}m</dd>{/if}
        {#if device.meta.simulator}<dt>simulator</dt>
          <dd>{device.meta.simulator}</dd>{/if}
        {#if device.meta.date}<dt>date</dt>
          <dd>{device.meta.date}</dd>{/if}
        {#if device.meta.polarity}<dt>polarity</dt>
          <dd>{device.meta.polarity}</dd>{/if}
        {#each Object.entries(device.meta.extra ?? {}) as [k, v]}
          <dt>{k}</dt>
          <dd>{v}</dd>
        {/each}
      </dl>
    </details>
  {/if}
  <!-- `multiple`: one file carries one table, so a device's corners arrive as a selection of
       files — which is imported as ONE transaction (see loadFiles). -->
  <label
    class="load"
    title="load mostab .csv characterization tables (several at once — one per corner), or a design-sheet .json"
  >
    Load .csv / .json
    <input
      type="file"
      multiple
      accept=".csv,.txt,text/csv,.json,application/json"
      onchange={(e) => loadFiles((e.currentTarget as HTMLInputElement).files)}
    />
  </label>
  {#if device}<button
      class="btn size"
      class:on={sizerOpen}
      onclick={() => (sizerOpen = !sizerOpen)}
      title={CONTROL_HELP.size}>size</button
    ><button
      class="btn pick"
      class:on={pickerOpen}
      onclick={() => (pickerOpen = !pickerOpen)}
      title={CONTROL_HELP.picker}>pick</button
    >{/if}
  <!-- Escape-to-dismiss is a keyboard ENHANCEMENT on a natively interactive disclosure -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <details class="prefs" onkeydown={closeOnEscape}>
    <summary class="btn" title="appearance: theme and font sizes">⚙</summary>
    <div class="prefs-pop">
      <label class="prow"
        >theme
        <select bind:value={settings.theme}>
          <option value="auto">auto</option>
          <option value="light">light</option>
          <option value="dark">dark</option>
        </select>
      </label>
      <label class="prow" title="zoom the whole interface — layout, controls, and charts together"
        >UI zoom
        <input
          type="range"
          min={FONT_RANGE.min}
          max={FONT_RANGE.max}
          value={settings.fontUi}
          oninput={(e) => (uiZoomDrag = +e.currentTarget.value)}
          onchange={(e) => (settings.fontUi = +e.currentTarget.value)}
        />
        <span class="pval">{uiZoomDrag}px</span>
      </label>
      <label class="prow" title="panel text size, independent of the UI zoom (charts unaffected)"
        >Text size
        <input
          type="range"
          min={TEXT_SCALE_RANGE.min}
          max={TEXT_SCALE_RANGE.max}
          step="0.05"
          bind:value={settings.textScale}
        />
        <span class="pval">{Math.round(settings.textScale * 100)}%</span>
      </label>
      <label class="prow"
        >axis titles
        <input
          type="range"
          min={FONT_RANGE.min}
          max={FONT_RANGE.max}
          bind:value={settings.fontAxisTitle}
        />
        <span class="pval">{settings.fontAxisTitle}px</span>
      </label>
      <label class="prow"
        >axis labels
        <input
          type="range"
          min={FONT_RANGE.min}
          max={FONT_RANGE.max}
          bind:value={settings.fontAxisLabel}
        />
        <span class="pval">{settings.fontAxisLabel}px</span>
      </label>
    </div>
  </details>
</header>

{#if importError}
  <!-- One selection can partly succeed: the files that failed are named here even when the
       rest of the batch loaded, so the line says "not imported", not "the import failed". -->
  <div class="qa error">not imported — {importError}</div>
{:else if warnings.length}
  <div class="qa">
    <strong>QA</strong>
    {#each warnings as w}<span class="w {w.severity}" title={w.location ?? ''}
        >{w.rule}: {w.message}</span
      >{/each}
  </div>
{/if}

{#if devices.length > 0}
  <nav class="devices" aria-label="loaded devices">
    <span class="dlabel">devices ({devices.length})</span>
    <Help text={CONTROL_HELP.overlay} />
    <!-- One group per logical device; its characterization conditions sit inside it. A device
         loaded at a single condition looks exactly as it did before families existed — the
         group chrome only appears once there is more than one condition to tell apart. -->
    {#each families as f (f.familyUid)}
      {@const multi = f.variants.length > 1}
      {@const qa = familyQA.get(f.familyUid) ?? []}
      <!-- A designation whose table has left is shown (and fixable) whatever the family's size:
           the auto rule is deliberately not re-applied over it, so without this the bench would
           have no nominal and no word about why. -->
      {@const stale = f.nominalSource === 'unresolved'}
      <!-- An unusable designation has two causes, and they are fixed differently: the table it
           named has left, or the condition it named is claimed by two tables. Core made the
           distinction when it resolved the designation; re-deriving it here would be a second
           copy of its matching rule. -->
      {@const ambiguous = f.unresolvedNominal === 'ambiguous'}
      <span class="fam" class:multi={multi || stale} data-family={f.device}>
        {#if multi}
          <span class="fname" title={CONTROL_HELP.cornerFamily}>{familyLabel(f)}</span>
          <label class="fov" title={CONTROL_HELP.cornerOverlay}>
            <input
              type="checkbox"
              checked={familyOverlaid(f)}
              onchange={() => toggleFamilyOverlay(f)}
            />corners
          </label>
        {/if}
        {#each f.variants as t (tableUid(t))}
          {@const i = indexOfUid.get(tableUid(t)) ?? -1}
          {@const nominal = f.nominal === t}
          <span
            class="dev"
            class:active={i === activeIdx}
            data-variant={variantLabel(t.id)}
            title={provenanceOf(t)}
          >
            <button
              class="dname"
              class:active={i === activeIdx}
              onclick={() => select(i)}
              title={CONTROL_HELP.active}>{multi ? variantLabel(t.id) : deviceKey(t)}</button
            >
            {#if multi || stale}
              <!-- Which condition the bench means by "nominal". Marked here and changed here,
                   because it is a statement about this bench, not about the file. -->
              <button
                class="dnom"
                class:on={nominal}
                data-nominal={nominal ? '' : undefined}
                onclick={() => designate(f.familyUid, tableUid(t))}
                title={CONTROL_HELP.nominal}
                >{nominal
                  ? f.nominalSource === 'designated'
                    ? '★ nominal'
                    : '★ nominal · auto'
                  : 'nominal'}</button
              >
            {/if}
            {#if multi}
              <!-- Where this condition came from. A family grouped on the device name alone is
                   only an informed grouping if what it was grouped from is on screen. -->
              <i class="dprov">{provenanceOf(t) || 'no provenance declared'}</i>
            {/if}
            <label class="dov" title={CONTROL_HELP.overlay}>
              <input
                type="checkbox"
                checked={overlayIdx.includes(i)}
                disabled={i === activeIdx}
                onchange={() => toggleOverlay(i)}
              />overlay
            </label>
            <button
              class="drm"
              onclick={() => removeDevice(i)}
              title="remove from registry"
              aria-label="remove device">×</button
            >
          </span>
        {/each}
        {#if stale}
          <span class="fw error" data-nominal-state="unresolved"
            >{ambiguous
              ? 'the designated nominal condition is claimed by two tables — remove one'
              : 'the designated nominal condition is not loaded — choose one'}</span
          >
        {:else if multi && f.nominalSource === 'none'}
          <span class="fw warning" data-nominal-state="none"
            >no nominal condition — designate one</span
          >
        {/if}
        {#each qa as w}
          <span class="fw {w.severity}" title={w.location ?? ''}>{w.rule}: {w.message}</span>
        {/each}
      </span>
    {/each}
    {#each benchQA as w}
      <span class="fw {w.severity}" title={w.location ?? ''}>{w.rule}: {w.message}</span>
    {/each}
    <button
      class="dclear"
      onclick={clearAll}
      title="remove every loaded device and delete the locally stored copies">clear all</button
    >
  </nav>
{/if}

{#if userSheets().length}
  <nav class="devices usheets" aria-label="imported sheets">
    <span class="dlabel">sheets</span>
    <Help text={CONTROL_HELP.userSheets} />
    {#each userSheets() as s (s.name)}
      <span class="dev">
        <span class="dname" title={s.doc.title}>{s.name}</span>
        <button
          class="drm"
          onclick={() => removeUserSheet(s.name)}
          title="remove from the sheet library (designs referencing it read infeasible)"
          aria-label="remove sheet">×</button
        >
      </span>
    {/each}
  </nav>
{/if}

{#if dashboard && activeTab}
  {@const d = dashboard}
  <div
    class="tabs"
    role="tablist"
    aria-label="dashboard tabs"
    tabindex={-1}
    bind:this={tabsNav}
    onkeydown={onTabsKey}
  >
    {#each d.tabs as tab, i}
      {#if renaming === i}
        <input
          class="tab tabedit"
          value={tab.name}
          onkeydown={(e) => onRenameKey(e, i)}
          onblur={(e) => {
            if (renaming === i) endRename(i, (e.currentTarget as HTMLInputElement).value);
          }}
          use:focusSelect
        />
      {:else}
        <button
          class="tab"
          class:on={i === d.activeTab}
          role="tab"
          aria-selected={i === d.activeTab}
          tabindex={i === d.activeTab ? 0 : -1}
          onclick={() => (d.activeTab = i)}
          ondblclick={() => (renaming = i)}
          title="double-click or F2 to rename">{tab.name}</button
        >
      {/if}
    {/each}
    <button class="tab add" onclick={addTab} title="add tab">+</button>
    <span class="grow"></span>
    <span class="cols">
      <button class="btn" onclick={() => setCols(-1)} title="fewer columns">−</button>
      {activeTab.cols} col
      <button class="btn" onclick={() => setCols(1)} title="more columns">+</button>
    </span>
    <select class="btn tpl" onchange={addFromTemplate} title={CONTROL_HELP.template}>
      <option value="" selected>+ panel from…</option>
      {#each templateOptions as { t, i }}<option value={i}>{t.name}</option>{/each}
    </select>
    <button class="btn" onclick={() => addPanel()} title="add a blank panel">+ panel</button>
    <button class="btn" onclick={() => addSheetPanel()} title={CONTROL_HELP.sheet}>+ sheet</button>
    {#if d.tabs.length > 1}
      <button class="btn" onclick={() => removeTab(d.activeTab)}>remove tab</button>
    {/if}
  </div>
{/if}

<div
  class="main"
  class:dragging
  role="region"
  aria-label="drop a mostab CSV or a sheet JSON here to load"
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  {#if device && dashboard && activeTab}
    <div class="grid" style:--cols={activeTab.cols}>
      {#each activeTab.panels as cfg (cfg.id)}
        <Panel
          {device}
          {overlays}
          {bench}
          sweep={dashboard.sweep}
          {sharedBias}
          {cfg}
          families={multiAxes}
          options={exprOptions}
          {styleVersion}
          onChange={(patch) => {
            // Editing a canonical (auto) panel makes it the user's own, so it survives a device
            // swap instead of being regenerated away (reseatDashboard preserves non-auto panels).
            Object.assign(cfg, patch);
            if (cfg.auto) cfg.auto = false;
          }}
          onRemove={() => removePanel(cfg.id)}
        />
      {/each}
      {#if activeTab.panels.length === 0}
        <p class="empty">no panels — use <strong>+ panel</strong> above</p>
      {/if}
    </div>
    {#if sizerOpen}
      <Sizer {device} {sharedBias} />
    {/if}
    {#if pickerOpen}
      <Picker {bench} onOpen={(doc, params) => addSheetPanel(doc, params)} />
    {/if}
  {:else}
    <div class="welcome">
      <h2>No device loaded</h2>
      <p>
        Import a mostab <code>.csv</code> to begin — use <strong>Load .csv</strong> above, or drop a file
        here.
      </p>
      <p class="hint">
        The app ships with no built-in data. Load your team's characterization tables, or generate
        open-PDK ones (sky130, gf180mcu) with the repository's generator script.
      </p>
    </div>
  {/if}
  {#if dragging}<div class="drophint">drop a mostab .csv or a sheet .json</div>{/if}
</div>

<style>
  header {
    position: relative; /* anchors the appearance panel (⚙), pinned top-right below */
    display: flex;
    align-items: baseline;
    gap: 1rem;
    flex-wrap: wrap;
    /* right padding reserves the corner the absolutely-positioned ⚙ occupies, so wrapping
       toolbar items never slide under it. */
    padding: 0.5rem 3rem 0.5rem 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  }
  h1 {
    font-size: 1rem;
    margin: 0;
  }
  .axis {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
    opacity: 0.85;
  }
  .axis select {
    font: inherit;
  }
  .slider {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .slider input {
    width: 8rem;
  }
  .slider .val {
    font-family: ui-monospace, monospace;
    min-width: 3.5rem;
  }
  .grow {
    flex: 1 1 auto;
  }
  .device {
    position: relative;
    font-family: ui-monospace, monospace;
  }
  .device summary {
    cursor: pointer;
    list-style: none;
    opacity: 0.75;
  }
  .device[open] summary {
    opacity: 1;
  }
  .device .prov {
    position: absolute;
    right: 0;
    top: 100%;
    z-index: 30;
    display: grid;
    grid-template-columns: auto auto;
    gap: 0.15rem 0.7rem;
    margin: 0.3rem 0 0;
    padding: 0.5rem 0.7rem;
    background: var(--bg, canvas);
    border: 1px solid #8884;
    border-radius: 4px;
    box-shadow: 0 2px 10px #0004;
    white-space: nowrap;
  }
  .device .prov dt {
    opacity: 0.6;
  }
  .device .prov dd {
    margin: 0;
    max-width: 24rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .load,
  .btn {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
  }
  .load input {
    display: none;
  }
  .qa {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.9rem;
    align-items: baseline;
    padding: 0.3rem 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    font-family: ui-monospace, monospace;
    font-size: 0.92em;
  }
  .qa.error {
    color: var(--err);
  }
  .qa .w::before {
    content: '';
    display: inline-block;
    width: 0.6em;
    height: 0.6em;
    border-radius: 50%;
    margin-right: 0.35em;
    background: currentColor;
    vertical-align: middle;
  }
  .qa .w.error {
    color: var(--err);
  }
  .qa .w.warning {
    color: var(--warn);
  }
  .qa .w.info {
    opacity: 0.6;
  }
  .btn.on {
    background: color-mix(in srgb, currentColor 15%, transparent);
  }
  /* Appearance popover: a native <details> disclosure so there's no popover/positioning JS. */
  /* Pinned to the header's top-right corner (out of the wrapping flex flow) so the ⚙ never
     wraps onto a second line at the left — which would make its right-anchored popover open
     off the left edge of the screen. Fixed here, the panel always opens down-and-left, on-screen. */
  .prefs {
    position: absolute;
    top: 0.5rem;
    right: 0.75rem;
  }
  .prefs summary {
    list-style: none;
  }
  .prefs summary::-webkit-details-marker {
    display: none;
  }
  /* Fixed-size island: sized in px, not rem, so the appearance panel does NOT zoom with the
     UI-scale control it hosts. Otherwise raising the scale would grow this popover (and its
     sliders) without bound — the settings that set the zoom must stay put while you use them. */
  .prefs-pop {
    position: absolute;
    right: 0;
    top: calc(100% + 5px);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 240px;
    padding: 10px 12px;
    font-size: 13px;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 6px;
    background: var(--bg);
    box-shadow: 0 4px 16px color-mix(in srgb, currentColor 22%, transparent);
  }
  .prow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .prow input[type='range'] {
    flex: 1 1 auto;
    min-width: 90px;
  }
  .pval {
    font-family: ui-monospace, monospace;
    min-width: 42px;
    text-align: right;
  }
  .main {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .main.dragging {
    outline: 2px dashed color-mix(in srgb, currentColor 50%, transparent);
    outline-offset: -4px;
  }
  .grid {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
    gap: 0.5rem;
    padding: 0.5rem;
    overflow: auto;
  }
  .empty {
    grid-column: 1 / -1;
    opacity: 0.5;
    text-align: center;
    padding: 2rem;
  }
  .welcome {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    text-align: center;
    opacity: 0.75;
    padding: 2rem;
  }
  .welcome h2 {
    margin: 0;
    font-weight: 600;
    font-size: 1.1rem;
  }
  .welcome .hint {
    opacity: 0.7;
    font-size: 0.9em;
  }
  .welcome code {
    font-family: ui-monospace, monospace;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
    padding: 0.3rem 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  }
  .tab {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 4px 4px 0 0;
    padding: 0.1rem 0.6rem;
  }
  .tab.on {
    background: color-mix(in srgb, currentColor 15%, transparent);
    font-weight: 600;
  }
  .tab:focus-visible {
    outline: 1px solid color-mix(in srgb, currentColor 55%, transparent);
    outline-offset: 1px;
  }
  /* The inline rename box replaces the tab button in place; match its metrics so the strip
     does not reflow while editing. */
  .tabedit {
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid color-mix(in srgb, currentColor 45%, transparent);
    border-radius: 4px 4px 0 0;
    padding: 0.1rem 0.6rem;
    width: 7rem;
  }
  .cols {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
    opacity: 0.85;
  }
  .devices {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    padding: 0.3rem 0.75rem;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  }
  .devices .dlabel {
    opacity: 0.55;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.72rem;
  }
  .dev {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    border-radius: 5px;
    padding: 0.05rem 0.3rem;
  }
  /* A family groups its conditions; with only one it adds nothing and draws nothing. */
  .fam {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem 0.4rem;
  }
  .fam.multi {
    border: 1px dashed color-mix(in srgb, currentColor 22%, transparent);
    border-radius: 7px;
    padding: 0.1rem 0.35rem;
  }
  .fname {
    font-weight: 600;
  }
  .fov {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    opacity: 0.85;
  }
  .dprov {
    font-style: normal;
    opacity: 0.5;
    font-size: 0.92em;
  }
  .fw {
    max-width: 42rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fw.error {
    color: var(--err);
  }
  .fw.warning {
    color: var(--warn);
  }
  .dnom {
    cursor: pointer;
    font: inherit;
    font-size: 0.92em;
    color: inherit;
    background: none;
    border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    border-radius: 999px;
    padding: 0 0.35rem;
    opacity: 0.55;
  }
  .dnom.on {
    opacity: 1;
    border-color: color-mix(in srgb, currentColor 55%, transparent);
  }
  .dev.active {
    border-color: color-mix(in srgb, currentColor 45%, transparent);
    background: color-mix(in srgb, currentColor 8%, transparent);
  }
  .dname {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0.05rem 0.1rem;
  }
  .dname.active {
    font-weight: 600;
  }
  .dov {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    opacity: 0.85;
  }
  .dov input:disabled {
    opacity: 0.3;
  }
  .dclear {
    cursor: pointer;
    font: inherit;
    font-size: calc(0.72rem * var(--text-scale, 1));
    color: inherit;
    background: none;
    border: 1px solid #8884;
    border-radius: 999px;
    padding: 0 0.5rem;
    opacity: 0.6;
    margin-left: 0.4rem;
  }
  .dclear:hover {
    opacity: 1;
  }
  .drm {
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    opacity: 0.5;
    padding: 0 0.15rem;
  }
  .drm:hover {
    opacity: 1;
  }
  /* imported-sheet chips reuse the device-chip look; the name is a label, not a button */
  .usheets .dname {
    cursor: default;
  }
  .drophint {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font:
      600 1rem system-ui,
      sans-serif;
    background: color-mix(in srgb, Canvas 70%, transparent);
    pointer-events: none;
  }
</style>
