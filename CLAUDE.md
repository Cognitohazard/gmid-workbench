# gm/ID Workbench

A browser-based, simulator-agnostic gm/ID characterization viewer, expression/lookup
engine, and transistor-sizing tool. Runs entirely client-side; ships as a hosted static
site and as a single self-contained HTML file for offline/air-gapped use.

Two packages in one repo:
- **`@gmid/mostab-core`** (repo root, `src/`) — pure TypeScript numerics. **Zero DOM imports.**
- **`gmid-web`** (`web/`) — Svelte 5 + uPlot UI that consumes the core via `file:..`.

## Commands

Core (run from repo root):
- `npm test` — Vitest (the numeric/golden suite; run this on any `src/` change)
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — `tsc` to `dist/`
- `npm run lint` — ESLint over `src/`, `web/src/`, `web/e2e/`
- `npm run format:check` — Prettier check (`npm run format` to fix)

Web (run from `web/`):
- `npm run dev` — Vite dev server
- `npm run check` — `svelte-check` (treat warnings as failures)
- `npm run test:e2e` — Playwright (auto-starts the dev server; writes screenshots under `e2e/__screens__/`)
- `npm run build` — Vite single-file offline build (`dist/index.html`, fully inlined)

Tools (`tools/`, no system numpy):
- `uv run --with numpy python3 tools/medwatt2mostab.py --trust-pickle <file.npz> -o out/` — convert medwatt/mosplot `.npz` to mostab CSV
- `uv run --with numpy python3 tools/test_medwatt2mostab.py` — converter self-test

Before declaring web work done, the bar is: core tests pass, typecheck, `npm run lint` and `npm run format:check` are clean, `svelte-check` is clean, e2e passes, and the offline build succeeds (this is what CI enforces).

## Layout

`src/` modules (each independently testable, all pure):
- `types.ts` — shared types (`DeviceTable`, `Grid`, `TableMeta`, …); `index.ts` — public barrel
- `constants.ts` — physical constants + the expression-engine constant scope
- `namespace.ts` — canonical base quantities + standard derived-quantity definitions + header aliases
- `parse/` → `import/` — mostab CSV parsing and the single import seam (`importMostab`)
- `grid/` — N-D dense grid on `Float64Array`, slicing, multilinear interpolation
- `expr/` — small expression engine (jsep-backed); `derive/` — derived quantities (dogfoods `expr/`)
- `lookup/` — forward + inverse (gm/ID → vgs) operating-point lookup
- `device/` — bind-any-2 sizing, mismatch (Pelgrom), thermal/integrated noise
- `qa/` — data-trust validation + PMOS sign canonicalization
- `series/` — family-of-curves charting prep; `demo/` — synthetic EKV device; `units/` — engineering notation

`web/src/`: `App.svelte` (the cockpit), `chart.ts` (the owned uPlot `ChartAdapter`).

## Architecture rules (load-bearing — do not violate)

- **Scope rule.** In scope: anything that is a pointwise or family-wise function of the device lookup tables plus a few PDK constants. Out of scope: anything requiring topology-level network solving. The sizing engine **evaluates author-written expressions and checks author-written rules — it never traverses or solves a circuit.** There is no nodal solver; the only operating-point solving allowed is small, explicit, designer-named fixed points. The lookup-table substrate is the guardrail.
- **Core is pure and DOM-free.** All numerics live in `src/`, reusable outside the UI. Bulk data is `Float64Array`. Functions are deterministic. The chart system is imperative and lives *outside* Svelte, behind the owned `ChartAdapter`.
- **Store raw, derive everything.** Tables hold raw simulator outputs only; every figure of merit is derived through the expression engine. Each derived quantity has exactly one definition in `namespace.ts` — add there, don't hand-roll the formula elsewhere.
- **QA surfaces warnings, never silent fixes.** Data trust is a core differentiator: gm/gds are derivatives, exquisitely sensitive to sweep quality, so bad inputs must be flagged, not quietly repaired. New checks go in `qa/validate()` and should not false-flag valid data (including signed PMOS).
- **Importing loses nothing.** Unknown columns pass through as normalized (lower-cased) numeric quantity columns; unrecognized `# key: value` metadata scalars are preserved in `meta.extra` (strict-superset rule). The required columns are `vgs`, `id`, `gm`.
- **SI units throughout.** Sign convention: `vsb = -vbs`. PMOS exports are accepted signed; the **value columns** (id/gm/gds/…) are canonicalized to magnitudes with polarity recorded, while the swept **axis** columns (e.g. a negative `vgs`) stay signed.
- **Client-only, no network after load.** Characterization data is NDA-sensitive; the offline single-file build is a first-class release artifact. Never add a runtime network dependency. Data may be stored locally in the browser (IndexedDB/localStorage) so a reload restores the bench — but what is retained must stay visible and deletable in the UI, and nothing ever leaves the machine.
- **medwatt `.npz` is converted out-of-browser only.** Its `.npz` is a pickled dict; the Python converter refuses to unpickle without `--trust-pickle` (arbitrary-code-execution risk). Keep that guard.

## Committed-text hygiene

Commit messages, code comments, and committed docs are external-facing. Scrub internal jargon
and process shorthand from anything that gets committed; describe the change in plain technical
language a new contributor would understand.

Avoid in committed text:
- Release shorthand as if it were product language — say "the initial milestone" / "the first
  release," not "v0"; describe the feature, not the roadmap slot.
- Internal mode or workflow names (e.g. effort/agent-mode labels) and strategy framing
  (positioning, "white space," "moat," competitor-vs-us narrative).
- Codenames or shorthand that only makes sense inside this conversation.

Competitor/library names used as concrete technical references (e.g. "mostab format,"
"medwatt `.npz`") are fine — they identify real artifacts.

## Project tour (the maintainer's read surface)

The maintainer reads this project through a guided tour of its *decisions* — source at
`[.claude/artifacts/project_tour.html]`, published as a private page whose address is in
`[.claude/artifacts/project_tour.url]` (that file is gitignored; this one is public).
Republish with the Artifact tool passing that address as `url` so the page keeps it; a
publish without it mints a new URL and orphans the one the maintainer has open.

Its layout is expected to change — it is a live document, not a template. What must not
change:

- **Decisions, not code.** Each entry is a question a returning reader would not know to
  ask ("why is the dependency's kill-all function deliberately never called?"), answered
  in a paragraph, with a path to open. They can read the code; they cannot read the
  reasons.
- **One sitting.** Reading it end to end is what surfaces the questions, so it has to
  stay readable end to end. That is the size limit — there is no correct number of
  sections. When it stops fitting, cut what has stopped being surprising: a doctrine now
  taken for granted has earned its way out, and the archive for it is the plan docs.
- **Sequence carries meaning.** Ordered, with a next link. A reader who knew where to
  click would not need the page.
- **A view, never a source.** When it disagrees with the code, the code is right.
- **Monospace is machine-checkable fact; serif is judgement the maintainer may overrule.**
- **`#calls` is their authority surface.** Every judgement call you make that they would
  plausibly overrule gets a block there: the call, and the position currently in force,
  so their silence is a real answer rather than a default nobody chose. Delete a block
  when they rule on it — resolved decisions belong in a commit message or a plan doc.
  Reference that section by its `#calls` anchor, never by ordinal.

**Maintain it at commit-batch time, not per commit** — after the cleanup pass and the
test gate, before reporting done. Refresh when the batch changed a doctrine, a contract,
a headline number, or the known-broken list; a batch of leaf fixes needs no edit. To find
out whether you have drifted:
`git rev-list --count --since="@$(stat -c %Y [.claude/artifacts/project_tour.html])" HEAD`
prints the commits since the last refresh — a number to judge against what those commits
did, not a threshold to clear.