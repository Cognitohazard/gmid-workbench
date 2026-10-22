# gm/ID Workbench (Work In Progress)

A browser-based, simulator-agnostic gm/ID characterization viewer, expression/lookup
engine, and transistor-sizing tool. It runs entirely client-side and ships in two forms:
a hosted static site, and a single self-contained HTML file for offline or air-gapped
use.

You load transistor characterization tables (DC sweeps of `id`, `gm`, `gds`, … over a
`L × VDS × VSB × VGS` operating grid, exported from any simulator), and the workbench
turns them into gm/ID design charts, operating-point lookups, and sized devices.

## Capabilities

- **Family-of-curves charts** — sweep one bias axis, fan another (typically `L`) into a
  curve family, and plot any derived quantity: `gm/ID`, `fT`, intrinsic gain `gm/gds`,
  current density `ID/W`, `V*`, combined figures of merit, and any custom expression
  over the table quantities and physical constants.
- **Forward and inverse lookup** — read any quantity at an operating point, or invert
  (e.g. gm/ID → `VGS`) on the interpolated grid.
- **Bind-any-2 sizing** — enter any two of {gm/ID, `fT`, gm/g<sub>ds</sub>} × {`ID`,
  `gm`, `W`} at a chosen `L`; everything else — the width, `VGS`, the remaining
  figures of merit, and feasibility — is solved from the table. Binding `fT` or
  intrinsic gain means stating the spec you actually have ("good to 5 GHz", "40 dB")
  instead of hand-iterating gm/ID toward it; a target out of reach at that length
  reports the lengths that do reach it.
- **Design sheets** — author variables, equations, and pass/fail checks with
  margins; sweep a variable to chart every check's margin and see where the design
  is feasible. Sheets compose: a block can be sized against a different loaded device,
  embedded inline or included **by reference** from the sheet library (with a flatten
  export for a frozen, self-contained copy). The authoring model is documented in
  [docs/sheet-format.md](docs/sheet-format.md).
- **Topology picker** — type the spec you have (supply, load, gain, gain-bandwidth, slew,
  noise, offset, common-mode range) and every amplifier and buffer sheet in the library is
  searched against it on the loaded device: which design-types close, at what quiescent
  current, with which knob settings, and what binds each one. Results carry their own
  disclosures — how much of your spec each sheet could use, whether the search ran out of
  budget rather than the design failing, and whether a reported current is really the author's
  slider floor. Picking a result opens it as a new design sheet with the values found.
- **Noise and mismatch** — input-referred thermal noise, 4kTγ·(gm + gmb) referred through gm
  (from the table's stored noise when it carries it, else a γ = 1.0 estimate, and the result
  says which, and says so too when a table without `gmb` leaves the body-effect term out),
  1/f noise and the flicker corner,
  integrated RMS noise over a band, and a Pelgrom mismatch budget on the sized geometry.
- **Data-trust QA** — gm and gds are derivatives and are exquisitely sensitive to sweep
  quality, so imports are validated (grid completeness, vgs step size, monotonicity,
  unit sanity, polarity conventions) and problems are surfaced as warnings — never
  silently repaired.

## Layout

Two packages in one repository:

| Package | Where | What |
|-|-|-|
| `@gmid/mostab-core` | repo root, `src/` | Pure TypeScript numerics: mostab parsing/import, N-D grid interpolation, expression engine, derived quantities, lookup, sizing, noise, mismatch, QA. Zero DOM imports. |
| `gmid-web` | `web/` | Svelte 5 + uPlot UI that consumes the core via `file:..`. |

## Quickstart

Core (run from the repo root):

```sh
npm ci
npm test           # Vitest — the numeric/golden suite
npm run typecheck  # tsc --noEmit
npm run build      # tsc to dist/
```

Web (run from `web/`; run `npm ci` at the repo root first — `gmid-web` links the core
via `file:..`, and the core's dependencies resolve from the root `node_modules`):

```sh
npm ci
npm run dev        # Vite dev server
npm run check      # svelte-check
npx playwright install chromium   # one-time: the e2e browser
npm run test:e2e   # Playwright (auto-starts the dev server)
npm run build      # single-file offline build -> dist/index.html, fully inlined
```

The offline build produces one self-contained `index.html` with everything inlined —
copy it anywhere and open it in a browser; no server or network access is needed.

## Loading data

The app boots empty. Data comes in as **mostab CSV** files — drag-and-drop them onto
the app or use **Load .csv**. The format is a plain UTF-8 CSV with a `# key: value`
metadata block; it is specified in [docs/mostab-format.md](docs/mostab-format.md),
which includes everything needed to write an exporter for your own simulator.

Required columns are `vgs`, `id`, `gm`; everything else (axes `l`, `vds`, `vsb`;
`gds`, capacitances, noise PSDs, and any unknown columns) is optional and carried
through. One table per (device, corner, temperature).

Any accepted table plots. What else it can be used for depends on the sweeps it
carries: a design sheet sizes a device only from a table that can answer for the
bias the device states, and refuses the device otherwise. Every device on a sheet
states its drain voltage, so a design sheet always needs drain-voltage data: a `vds`
sweep, or a table taken at exactly the stated value. A source above the body needs a
`vsb` sweep in the same way, and a diode connection needs a `vds` sweep. A table
with no `vds` column still plots and sizes a single device. The format document
sets out [what each use needs](docs/mostab-format.md#what-each-use-needs).

### Converting a medwatt / mosplot `.npz`

`tools/medwatt2mostab.py` converts a medwatt/mosplot `.npz` lookup table to mostab CSV,
one file per transistor model:

```sh
uv run --with numpy python3 tools/medwatt2mostab.py --trust-pickle table.npz -o out/
```

The conversion happens out-of-browser only: the `.npz` is a pickled dict, and
unpickling can execute arbitrary code, so the converter refuses to run without
`--trust-pickle` — pass it only for a file you produced or trust. A process corner or
temperature is written only when the table's `device_parameters` state one or you do
(`--corner ss --temp -40`); left out, the app reads the table as `tt` at 27 °C and says,
wherever the table is used, that both were assumed. A stated temperature above 200 is
read as kelvin and converted, and one that is not a number is written as stated, for the
app to report. Every other single-valued entry of `device_parameters` is carried through as a
`# key: value` line, as stated; an entry that is not a single value, or whose key cannot be a
header key, is named on the console instead, as is a listed parameter the model's entry does not
hold. A self-test is included:

```sh
uv run --with numpy python3 tools/test_medwatt2mostab.py
```

### Generating tables from an open PDK

`tools/gen_gmid.py` is a standalone recipe (plain `ngspice -b`, no extra tooling) that
generates a full characterization matrix — 11 devices × 3 process corners × 3
temperatures — from the SkyWater sky130 and GlobalFoundries gf180mcu open PDKs:

```sh
PDK_ROOT=/path/to/pdks python3 tools/gen_gmid.py sky130 --out data/pdk
PDK_ROOT=/path/to/pdks python3 tools/gen_gmid.py gf180  --out data/pdk
```

It needs only Python, ngspice, and a fetched PDK. See
[data/pdk/PROVENANCE.md](data/pdk/PROVENANCE.md) for the exact PDK builds, device
list, and reproduction details.

### Model limits worth knowing

A table is characterized at **one width** (`# W:` in the metadata), and sizing scales
it per-µm. Width effects — model bins, narrow-width V<sub>th</sub> shifts — are not
captured, and they are not small: on sky130, a single-finger device 25× the
characterization width conducts up to 1.9× more per µm in moderate inversion.
Realized as **fingers of the characterization width** the table tracks simulation to
a fraction of a percent, so treat a sized W as "N fingers of W<sub>char</sub>" (the
sizer suggests the finger count). Cross-check decks and measured numbers live in
[tools/verify/](tools/verify/README.md). The thermal-noise density reads the
table's own drain noise (`sth`) where the table carries it — the tables the
generator produces do, and the five-transistor OTA then reads about 28 nV/√Hz
against its simulated 28.24 — and falls back to γ = 1.0 where it does not, which
understates a device that runs
hotter (in simulation sky130's NMOS sits at about γ = 1.6 at gm/ID 12 once its body effect is
separated out); every result says which it used. It is thermal noise only, and flicker can dominate far past the
audio band — treat table-derived noise as a floor, not a budget.

## Scripting the core

The core (`@gmid/mostab-core`) is a pure library — you can import tables, size devices, and
run design sheets from Node without the UI. It is TypeScript-first (the package entry is
`src/index.ts`), so run these under a TypeScript-aware loader such as `tsx`, or build once
with `npm run build` and import from `dist/`.

```js
import { importMostab, runSheet, sweepSheet } from '@gmid/mostab-core';
import { readFileSync } from 'node:fs';

const res = importMostab(readFileSync('nch_1v8__tt__27C.mostab.csv', 'utf8'));
if (!res.ok) throw new Error(res.errors.map((e) => e.message).join('; '));

// res.dataset.tables is DeviceTable[]; res.dataset.warnings holds the QA findings.
const table = res.dataset.tables[0];

const sheet = {
  formatVersion: 2,
  title: 'Single NMOS gm/ID sizing',
  polarity: 'n',
  params: [
    { name: 'GBW_target', value: 10e6, unit: 'Hz', role: 'spec' },
    { name: 'CL', value: 2e-12, unit: 'F', role: 'spec' },
    { name: 'gm_id', value: 12, min: 6, max: 18, unit: '1/V', role: 'choice' },
    { name: 'L', value: 0.5e-6, unit: 'm', role: 'choice' },
  ],
  givens: { L: 'L', gm: '2*pi*GBW_target*CL', gm_id: 'gm_id', vds: '0.9' },
  // The wires the device sits on, the wire whose voltage is stated, and the wire left open
  // for whatever drives the gate. A sheet that is not a circuit declares `nodes: 'none'`.
  nodes: { d: 'out', g: 'in', s: 'gnd', b: 'gnd' },
  levels: { out: '0.9' },
  ports: ['in'],
  equations: [{ name: 'GBW', expr: 'gm/(2*pi*(cgg + CL))', unit: 'Hz' }],
  checks: [{ id: 'inversion', kind: 'physical', lhs: 'gm_id', op: '<=', rhs: 'ceiling' }],
};

const out = runSheet(sheet, table);
console.log(out.feasible, out.values.W, out.checks);

// Trace the gm_id knob across its [min, max] to map the feasibility region.
const sweep = sweepSheet(sheet, 'gm_id', table);
```

A composed sheet's block names its device by a resolver key (the block's `device`); pass a
resolver — `(id) => DeviceTable | undefined` — as the third argument to map those keys to
tables. In a script you choose the key, so long as each child's `device` matches; the app reads
only the forms it writes itself (see "Naming a block's device" in the sheet format), so a sheet
meant to open there should use those. A child included **by reference** (the block's `ref`) needs a
sheet library to resolve against — build an index and pass it fourth; `flattenSheetDoc`
inlines every reference into a self-contained document:

```js
const byKey = new Map(res.dataset.tables.map((t) => [t.id.device, t]));
const refs = buildSheetRefIndex([{ path: 'blocks/cs-load', doc: loadSheet }]);
runSheet(sheet, table, (id) => byKey.get(id), refs);
```

A sheet saved before the format carried wiring (no `formatVersion`) is still read, but a
transistor in it is refused until the sheet names the wires it sits on. The core drafts that
wiring from the givens; the author reads the draft, corrects what it marks as inferred or
unknown, and imports the copy:

```js
import { proposeWiring, applyWiringProposal, formatWiringProposal } from '@gmid/mostab-core';
import { writeFileSync } from 'node:fs';

const proposal = proposeWiring(oldSheet);
console.log(formatWiringProposal(proposal)); // each wire marked certain, inferred or unknown
const migrated = applyWiringProposal(oldSheet, proposal); // a format-version-2 copy; oldSheet is untouched
writeFileSync('sheet.v2.json', JSON.stringify(migrated, null, 2));
```

See [docs/sheet-format.md](docs/sheet-format.md) for the full design-sheet model.

## Dataset licensing

The generated open-PDK tables are **derived data** (simulated DC sweeps of the PDK
compact models, not the model files) and are distributed under **Apache-2.0**, the
license of both source PDKs — see [data/pdk/PROVENANCE.md](data/pdk/PROVENANCE.md)
and `data/pdk/Apache-2.0.txt`. They are simulated, not measured, and are not a
substitute for foundry characterization data.

## Privacy

Characterization data is often NDA-sensitive, so the workbench is strictly
client-only: after the page loads, it makes no network requests and collects no
telemetry. Your tables never leave the browser. The single-file offline build exists
precisely so the tool can run on air-gapped machines.

Loaded tables are kept locally in the browser (IndexedDB) so a reload restores your
bench. What is retained is always visible in the devices strip; the × on a chip
deletes that table's stored copy and **clear all** wipes everything. On a shared
machine, clear before you walk away.

## License

The application and library code are licensed under the [GNU General Public License v3.0](LICENSE).
The bundled/generated PDK datasets are Apache-2.0 as described above.
