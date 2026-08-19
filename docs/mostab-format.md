# The mostab CSV interchange format

`mostab` is the flat-file interchange format the gm/ID Workbench reads (and its tools
write): one plain CSV per transistor characterization table, holding DC operating-point
sweeps on a dense rectangular grid. It is simulator-agnostic — any tool that can dump a
DC sweep as CSV can produce it. This document specifies the format precisely enough to
write an exporter without reading the Workbench source.

## Scope: one file, one table

One file describes **one table**: one device, at one process corner, at one
temperature. Corner and temperature variants are separate files. The viewer
groups files by `pdk`, device name, and polarity into one **corner family** —
one logical device selectable by (corner, temp) condition — so those three
headers are the family identity, and files that should read as one device
across corners should agree on them. A file that declares no `pdk` (or no
`polarity`) joins the sole declared family of the same device name, so
re-exporting one corner with newly stamped headers does not split it from the
others; it stays its own family only when several declared candidates would
make the join a guess. Two unrelated devices that happen to share a name are
therefore kept apart by declaring a distinct `pdk` in **both** — declaring it
in one file alone joins the other to it. A useful naming
convention (used by the bundled datasets, not required by the parser) is
`<device>__<corner>__<temp>C.mostab.csv`.

## File container

- **Encoding:** UTF-8 text. A leading byte-order mark is tolerated and stripped.
- **Line endings:** `\n`, `\r\n`, or `\r`. Blank lines are ignored anywhere.
- **Comment/metadata lines:** any line whose first non-whitespace character is `#`.
- **Header row:** the first non-comment, non-blank line.
- **Data rows:** every following non-comment, non-blank line.
- **Delimiter:** auto-detected from the header row among comma, semicolon, and tab
  (the candidate occurring most often wins). Use a comma; never quote cells or embed
  the delimiter in a value.

## Metadata lines

Metadata lines have the form `# key: value` (whitespace around key and value is
trimmed; keys are matched case-insensitively; a line with an empty value is ignored).
They conventionally form a block at the top of the file, though the parser accepts
them anywhere.

Keys the importer interprets:

| Key | Meaning | Type / unit | Default if absent |
|-|-|-|-|
| `device` | Device name (table identity) | string | filename stem, else `dev0` |
| `corner` | Process corner (table identity) | string | `tt` |
| `temp` (alias `temperature`) | Simulation temperature | number, °C | 27 |
| `pdk` | Process/technology namespace (family identity) | string | undeclared |
| `W` (alias `width`) | Characterization channel width | number, m | — |
| `polarity` (alias `type`) | Declared channel type; see [Sign conventions](#sign-conventions) | `n`/`nmos`/`nch`/`nfet`/`nmosfet` or `p`/`pmos`/`pch`/`pfet`/`pmosfet` | undeclared |
| `simulator` | Producing simulator, free-form | string | — |
| `date` | Export date, free-form | string | — |
| `AVT` | Pelgrom threshold-mismatch constant | number, V·m | — |
| `ABETA` | Pelgrom current-factor mismatch constant | number, m | — |
| `FCO` | 1/f (flicker) noise corner frequency | number, Hz | — |

Polarity is honored **only** from this explicit declaration — it is never inferred
from the device name or sniffed from data signs. An unrecognized polarity value is
ignored, exactly as a missing line would be.

**Strict-superset rule:** any other `# key: value` line (for example `# mostab: 0.1`,
`# license: …`, `# source: …`) is preserved verbatim through import, under its
original-case key. Nothing is dropped. The bundled tools stamp `# mostab: 0.1` as a
format-version marker; the importer preserves it but does not interpret it.

## Header row and column names

Column names are trimmed, lower-cased, and mapped through an alias table, so `VGS`,
`vgs`, and ` Vgs ` are the same column. Two columns that map to the same canonical
key make the file ambiguous and the import is rejected.

Alias map (source header → canonical key):

| Source header | Canonical key | Note |
|-|-|-|
| `ids`, `i_d`, `id` | `id` | |
| `length`, `lch`, `l` | `l` | |
| `width`, `w` | `w` | |
| `gout`, `go`, `gds` | `gds` | |
| `gm` | `gm` | |
| `gmbs`, `gmb` | `gmb` | |
| `cgg`, `cgs`, `cgd`, `cgb` | themselves | |
| `cdd`, `cdb` | `cdb` | |
| `css`, `csb` | `csb` | |
| `vt`, `vt0`, `vth` | `vth` | |
| `vdssat`, `vdsat` | `vdsat` | |
| `vgs`, `vds`, `vsb` | themselves | |
| `vbs` | `vsb` | values negated: `vsb = -vbs` |
| `sth`, `sfl`, `gamma`, `igd`, `igs` | themselves | |

**Unknown columns pass through.** Any header not in the table above becomes a
first-class numeric quantity under its lower-cased name — available to charts, the
expression engine, and lookup like any built-in quantity. Its cells must still be
numeric.

## Columns

### Axis columns

Columns named `l`, `vds`, `vsb`, `vgs` are sweep axes. At least one must be present;
`vgs` is required (below). Together they define an N-dimensional rectangular grid:
the unique sorted values of each axis, with **exactly one data row per grid point**.
Row order in the file does not matter — each row is placed by its axis coordinates —
but the grid must be complete: missing points, duplicate points, or ragged sweeps
(e.g. a different vgs range per length) are rejected.

### Value columns

| Column | Unit | Status |
|-|-|-|
| `vgs` | V | **required** (axis) |
| `id` | A | **required** |
| `gm` | S | **required** |
| `l`, `vds`, `vsb` | m, V, V | optional axes (strongly recommended for real design work) |
| `gds` | S | recommended (intrinsic gain, ro) |
| `cgg` | F | recommended (fT) |
| `cgs`, `cgd`, `cgb`, `cdb`, `csb` | F | optional capacitances |
| `vth`, `vdsat` | V | optional |
| `gmb` | S | optional (body effect) |
| `sth` | A²/Hz | optional: drain thermal-noise current PSD |
| `sfl` | A²/Hz | optional: drain flicker-noise current PSD at 1 Hz |
| `gamma` | 1 | optional: thermal-noise factor γ |
| `igd`, `igs` | A | optional gate leakage |
| `w` | m | optional (usually `# W:` metadata instead) |

### Data cells

Every cell must parse as a finite number: decimal or scientific notation (`1.5e-07`).
Empty cells, `NaN`, `inf`, text, and rows with the wrong cell count all reject the
import — corruption is refused, not silently zeroed.

## Units and sign conventions

All values are **SI units**: volts, amperes, siemens, farads, meters, A²/Hz.
Temperature metadata is in °C. Do not export in mV, µA, or fF.

- **Body bias:** the canonical column is `vsb` (source-body voltage), with
  `vsb = -vbs`. A `vbs` column is accepted and negated on import.
- **NMOS:** all-positive quantities in the normal convention; declare
  `# polarity: n` (recommended, not required).
- **PMOS:** exports may be **signed** (negative `vgs`/`vds` sweep values, negative
  `id`/`gm`). Declare `# polarity: p`. On import, value columns are then folded to
  magnitudes with the polarity recorded, specifically:
  - folded to |·|: `id`, `gm`, `gds`, `gmb`, `cgg`, and non-axis voltage columns
    (`vth`, `vdsat`);
  - **not** folded: the swept axis columns (`vgs`, `vds`, `vsb`, `l`), which stay
    signed as exported;
  - **not** folded: the cross-capacitances `cgd`, `cgb`, `cdb`, `csb` — these are
    legitimately signed under the ∂Qi/∂Vj convention — and passthrough columns.

  A signed PMOS table **without** a `# polarity: p` declaration is imported as-is and
  flagged by QA warnings; it is never guessed at and silently repaired. Exporting
  PMOS data already as magnitudes (with `# polarity: p`) is equally valid.

## Grid quality expectations

`gm` and `gds` are derivatives, so table quality is dominated by sweep quality. The
importer's QA pass warns (it never edits data) when:

- the `vgs` step exceeds **10 mV** anywhere — keep the vgs step at or below 10 mV
  (the bundled open-PDK tables use 8 mV);
- gm/ID exceeds the physical weak-inversion ceiling ≈ 1/U_T (temperature-scaled from
  ~38.7 S/A at 27 °C) — usually a unit error;
- |vgs| exceeds 100 V — the axis is probably in mV, not V;
- the stored `gm` disagrees grossly with a finite difference of `id` along `vgs`;
- `id` is non-monotonic in `vgs`, or `gamma` is outside a plausible range.

## Example

A complete, valid file (grid: 2 lengths × 1 vds × 3 vgs = 6 rows):

```
# mostab: 0.1
# device: nch_1v8
# corner: tt
# temp: 27
# W: 1e-06
# polarity: n
# simulator: ngspice-42
L,VDS,VGS,ID,GM,GDS,CGG
1e-07,0.9,0.400,1.53e-06,2.81e-05,1.92e-06,9.13e-16
1e-07,0.9,0.405,1.67e-06,3.02e-05,2.01e-06,9.17e-16
1e-07,0.9,0.410,1.82e-06,3.24e-05,2.10e-06,9.21e-16
2e-07,0.9,0.400,7.61e-07,1.42e-05,4.80e-07,1.71e-15
2e-07,0.9,0.405,8.32e-07,1.53e-05,5.01e-07,1.72e-15
2e-07,0.9,0.410,9.08e-07,1.64e-05,5.24e-07,1.73e-15
```

(A real export sweeps vgs over the full operating range, not 3 points; the truncated
sweep above is only to keep the example short.)

## Writing an exporter: checklist

1. Sweep DC operating points over a rectangular `L × VDS × VSB × VGS` grid (or a
   subset of those axes), one simulation grid per (device, corner, temperature).
2. Emit UTF-8 CSV: `# key: value` metadata block, one header row, one data row per
   grid point. Comma delimiter, no quoting, no blank cells.
3. Include at least `vgs`, `id`, `gm`; add `gds` and `cgg` if at all possible, and
   any further quantities you have — unknown columns are carried through.
4. Use SI units everywhere; `vsb = -vbs`.
5. Stamp `# device:`, `# corner:`, `# temp:`, `# W:`, `# simulator:`, and — for PMOS
   especially — `# polarity:`.
6. Keep the vgs step at or below 10 mV, and make sure every axis combination is
   present exactly once (no per-length range trimming).
7. Feel free to add provenance metadata (`# source:`, `# license:`, `# date:`) — it
   is preserved through import.

Reference implementations: the reader is `src/parse/index.ts` + `src/import/index.ts`
(canonicalization and QA in `src/qa/`); the writer is `tools/mostab_io.py`, used by
both `tools/gen_gmid.py` (ngspice generation recipe) and `tools/medwatt2mostab.py`
(medwatt/mosplot `.npz` converter).
