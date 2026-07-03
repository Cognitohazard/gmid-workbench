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
- **Client-only, no network after load.** Characterization data is NDA-sensitive; the offline single-file build is a first-class release artifact. Never add a runtime network dependency.
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
