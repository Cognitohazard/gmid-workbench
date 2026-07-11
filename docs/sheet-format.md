# The design-sheet format

A **design sheet** is a small, declarative document that sizes one transistor (or a
composition of several) against loaded characterization tables and checks author-written
constraints. It is the workbench's authoring layer on top of bind-any-2 sizing: you state
the spec and the design knobs as named scalars, bind the device, write intermediate
equations, and declare pass/fail rules with margins.

A sheet is evaluated, never *solved*. It reads the device lookup tables and a few physical
constants, evaluates the expressions you wrote, and compares the results. There is no nodal
solver and no circuit traversal: the only operating-point solving is the explicit,
designer-named bind. This document specifies the model precisely enough to author a sheet by
hand or generate one from code — see also [Scripting the core](../README.md#scripting-the-core).

## The document model

A sheet is one JSON object (the GUI edits and persists it verbatim). Its fields:

| Field | Type | Meaning |
|-|-|-|
| `title` | string | Display name of the sheet. |
| `description` | string, optional | A few sentences on what the sheet designs, its assumptions, and how to use it — the note a designer inheriting the sheet reads first. Supports inline math in `$…$` (see [Inline math](#inline-math-in-prose)), e.g. `$g_m/I_D$`. |
| `polarity` | `"n"` \| `"p"` | A self-description label only; no contract is enforced at a leaf. |
| `params` | array | Named scalar design inputs (see [Parameters](#parameters)). |
| `bind` | object, optional | The bind-any-2 device declaration (see [The bind](#the-bind)). Omit for a sheet that only does author math. |
| `rows` | array | Named intermediate/output expressions, evaluated in document order (see [Rows](#rows)). |
| `rules` | array | Named comparisons the design must satisfy (see [Rules](#rules)). |
| `uses` | array, optional | Child sheets this sheet composes (see [Composition](#composition)). |
| `provide` | array of string, optional | The names this sheet exposes to a parent (ignored at the top level). |

Evaluation runs in one pass: seed the params, compose any children, size the device, evaluate
the rows in order, then check the rules. Everything a rule or row can reference — params,
child provides, the sized operating point, derived quantities, and physical constants — is a
flat scalar in one shared namespace.

## Parameters

Each entry in `params` is a named scalar input:

| Field | Type | Meaning |
|-|-|-|
| `name` | string | The identifier used in expressions. |
| `value` | number | The current value (SI units). |
| `min`, `max` | number, optional | Bound the GUI slider **and** make the parameter sweepable. |
| `unit` | string, optional | Display unit. |
| `role` | `"spec"` \| `"choice"`, optional | Groups the parameter (see below). |
| `note` | string, optional | A one-line intent/derivation annotation for the next designer. Renders inline math in `$…$` (see [Inline math](#inline-math-in-prose)). |

The `role` separates *what the sheet is for* from *how it gets there*:

- **`spec`** — the requirement the sheet must meet (supply voltage, load capacitance, a
  bandwidth or noise target). An adopter changes these freely to retarget the design.
- **`choice`** — the author's implementation knobs (bias current, `gm/ID`, channel length
  `L`). Change these to re-balance the design against the same spec.

An untagged parameter renders ungrouped. Roles are organizational only — they do not change
evaluation.

A parameter with a finite `min`/`max` (where `max > min`) is what a sweep can walk; without
them, the parameter is a fixed scalar. Stored `value`s are SI throughout — the JSON holds
`2e-12` farads. In the GUI, numeric fields **display and accept engineering notation**
(`2p`, `500n`, `20u`, `1meg`, `1.8`), parsed with the SPICE/SI suffix convention
(`m` = milli, `meg` = mega, `u` = micro; case-insensitive) and normalized on entry, so a field
showing `2p` writes `2e-12` back to the JSON. A malformed entry is rejected and the field
restores its last value.

## Inline math in prose

`description` and every `note` render inline math delimited by `$…$` — a deliberate LaTeX
*subset* (no math engine, to keep the offline single-file build lean). Inside the delimiters:
`_x`/`_{…}` subscript, `^x`/`^{…}` superscript, `*` → ·, `\frac{a}{b}` → a/b, `\sqrt{x}` → √(x),
and backslash commands for Greek and comparisons (`\gamma`, `\geq`, `\leq`, `\approx`, `\cdot`,
`\parallel`, …). Prefer `_`, `^`, `*` (no backslash needed); **in JSON a backslash must be
doubled** (`$\\gamma$`, `$\\geq$`). Text outside `$…$` is plain prose. Example:

```json
"description": "Raises the output resistance to about $A_{v0,casc}/g_{ds,in}$, so the load's $g_{ds}$ sets the ceiling."
```

## The bind

The optional `bind` sizes one device by fixing **exactly two of `{gm, gm_id, id, W}`** at a
chosen length `L`, and inverting the lookup table for the rest. Every field is an
**expression string**, so a bound quantity can be computed from the params:

```json
{ "L": "L", "gm": "2*pi*GBW_target*CL", "gm_id": "gm_id" }
```

Here `gm` is fixed from the bandwidth spec and `gm/ID` is the design knob; the drain current
follows from `gm = (gm/ID)·ID`, and the width, `VGS`, and every derived figure of merit fall
out of the table. Any two of the four may be bound:

- `gm` + `gm_id`, `gm` + `id`, `gm_id` + `id` — the classic electrical binds; the width is
  sized from the current density.
- `W` + one of `{gm, gm_id, id}` — width-first flows (unit devices, mirror ratios,
  layout-constrained sizing); the operating point comes from inverting the matching
  characterization-width curve.

Binding fewer or more than two is an authoring error and is flagged. Expression strings
accept engineering-notation literals and the full expression language (see
[The expression language](#the-expression-language)).

Once sized, the operating point is merged into the namespace as flat scalars: `gm`, `gm_id`,
`id`, `W`, `vgs`, `vstar`, `cgg`, the intrinsic gain `av0`, the γ-model noise density
`vnth_m`, the stored noise PSDs `svth`/`svfl`, the flicker corner `fco`, the gm/ID `ceiling`,
and so on — every base and derived quantity the table supports, reported at the **sized
width** (see [The width contract](#the-width-contract)). Rows and rules read these by name.

### The operating point (`vds`, `vsb`)

Sizing inverts `gm/ID` along `vgs`, so every *other* sweep axis of the table must be collapsed
to a single point first. The bind declares that point with optional `vds` and `vsb`
expression strings:

```json
{ "L": "L", "id": "I_bias", "gm_id": "gm_id", "vds": "0.9", "vsb": "0" }
```

These are **signed to match the table's axis convention** — a PMOS table swept over negative
`vds` takes a negative `vds` declaration.

Declaring the bias matters because it is a real degree of freedom, not a formality. Output
conductance `gds` moves by roughly 4–5× between a low-`vds` cascode point and a mid-supply
point, so an undeclared or wrong bias can silently overstate intrinsic gain by on the order of
13 dB. Declaring `vds`/`vsb` in the bind makes the operating point an authored, persisted,
sweepable part of the design rather than a hidden host-side slice.

If the table has a live axis the bind does not declare, evaluation falls back to the caller's
operating point (the shared bias the app provides) **and raises an advisory warning naming
the assumed value** — never a silent slice. With neither a declaration nor a fallback, the
sizing fails with guidance to declare the axis. A declared value always wins, and a declared
value outside the table's range is clamped to the nearest edge with a warning.

## Rows

Each entry in `rows` is a named author expression — an intermediate `let` or an output —
evaluated in **document order** against the params, the sized operating point, earlier rows,
and constants:

```json
{ "name": "GBW", "expr": "gm/(2*pi*Cout)", "unit": "Hz",
  "note": "single-pole GBW into the total output cap" }
```

A row that cannot resolve (a missing quantity, a parse error) is skipped with a warning —
graceful degradation for an optional figure of merit. A row that resolves but evaluates to a
non-finite number from finite inputs (a `sqrt` of a negative headroom, a divide by zero) means
the design math itself broke, so it is an **error** that fails feasibility closed — even if no
hard rule happens to reference that row.

## The expression language

Every expression string — bind fields, rows, and both sides of a rule — is evaluated by the
same small engine. It works over flat scalars in the sheet's namespace.

**Operators:** `+ - * / ^` (`^` is exponentiation), unary minus, the comparison operators
`> < >= <= == !=`, the logical operators `&& || !`, and the `cond ? a : b` ternary.
Comparisons and logic are scalar.

**Engineering-notation literals:** a number glued to an SI/SPICE suffix is rewritten before
parsing — `100n`, `2p`, `1.5u`, `10meg`, `4k`, `3g`, `2t`. So `gm = "2*pi*GBW*2p"` is legal.

**Built-in functions:** `sqrt`, `log` (natural log), `log10`, `exp`, `abs`, `atan`, `sign`;
the variadic `min`/`max`; and `par(a, b, …)` — the parallel combination `1 / Σ(1/xᵢ)`, useful
for combining conductances or capacitances.

**Named constants** (always in scope): `pi`, `k` (Boltzmann), `q` (elementary charge), `T`
(the table's characterization temperature, in kelvin), `UT` (thermal voltage `kT/q`), and
`gamma` (the thermal-noise factor, the table's per-point value when it carries one, else the
model default). A stored or bound name of the same spelling shadows a constant, so explicit
values win.

### Author-callable functions

The trusted noise and mismatch closed-forms are registered as expression functions, so a sheet
calls the one implementation instead of re-typing the formula (re-typed copies drift; calls
cannot):

| Call | Returns |
|-|-|
| `noise_rms(sth, fc, fLo, fHi)` | Total input-referred RMS noise [V] over the band `[fLo, fHi]`, from a white thermal PSD `sth` [V²/Hz] plus a 1/f tail with corner `fc` [Hz]. |
| `pelgrom_vos(avt, abeta, W, L, gm_id)` | Pelgrom input offset σ(Vos) [V] of a matched pair at the sized geometry. |
| `pelgrom_irel(avt, abeta, W, L, gm_id)` | Pelgrom current spread σ(ΔI/I) [1] of one device. |

`avt` is the Pelgrom threshold coefficient [V·m] and `abeta` the current-factor coefficient
[m]. These σ scale as 1/√(W·L), so pass the **sized** `W` and `L`.

## Rules

Each entry in `rules` is a named comparison `lhs op rhs`, where `lhs` and `rhs` are expression
strings and `op` is `>=`, `<=`, or `==`. The comparison is structured — it is never parsed out
of a string — and each rule is evaluated into a **signed margin**: the SI distance to the
bound, positive when the rule holds. A relative margin (margin over the bound) lets rules of
different units share one axis on a sweep chart.

| Field | Type | Meaning |
|-|-|-|
| `id` | string | Rule identifier (shown in reports and sweeps). |
| `kind` | `"invariant"` \| `"requirement"` \| `"guardrail"` | See below. |
| `lhs`, `rhs` | string | The two expression sides. |
| `op` | `">="` \| `"<="` \| `"=="` | The comparison. |
| `tolPct` | number, optional | Relative tolerance for `==` only (percent of \|rhs\|). |
| `note` | string, optional | The rule's physical meaning, for the next designer. |
| `justification` | string, optional | An advisory note explaining a relaxed guardrail. |

### Rule kinds

The `kind` decides whether a rule **gates feasibility**:

- **`invariant`** — a hard physical floor (the design is unphysical if it fails), e.g.
  `gm_id <= ceiling` or a saturation-headroom floor. Gates feasibility.
- **`requirement`** — a hard application spec (the design misses its purpose if it fails), e.g.
  an input-noise or offset budget. Gates feasibility.
- **`guardrail`** — a soft advisory (a near-miss heads-up). It is shown but **never blocks
  feasibility**. A red guardrail on an otherwise-green sheet is by design: the sheet is
  feasible and the guardrail is telling you a soft target is close or missed.

Both invariant and requirement gate; the split is documentation of *why* a rule is hard.

### Status and the amber near-miss band

Each rule reports one of four statuses:

| Status | Meaning |
|-|-|
| `pass` | Holds with margin. |
| `amber` | Holds, but by less than 5% relative margin — a near-miss worth a second look. |
| `fail` | Does not hold (negative margin). |
| `na` | A side could not be computed (an undeclared name, an eval error, or a non-finite value). |

`na` is **never a silent pass**: a hard rule that reads `na` fails feasibility closed, exactly
as a `fail` would. The 5% amber band applies to `>=`/`<=`; an `==` rule is pass/fail only (its
`tolPct` band already defines the acceptable window, so there is no second near-miss band).

### Zero-margin snap and the pin-then-test pitfall

A margin within a tiny relative distance (1e-12) of zero snaps to exactly 0, which reads as
`amber`. This exists for the common case where a rule tests the very quantity the bind pinned.
If you bind `gm = 2*pi*GBW_target*CL` and then write a rule `GBW_target*CL*2*pi <= gm`, the two
sides are algebraically identical and land within floating-point rounding of the boundary —
without the snap, the verdict would coin-flip between pass and fail on ±1e-16 noise. The snap
makes it a deterministic `amber`: the honest description of a spec that is pinned by
construction rather than genuinely met with margin.

The lesson is to **test a derived quantity, not the pinned input.** Binding `gm` from a target
GBW and then checking `GBW >= GBW_target` is a tautology that always reads amber. Instead,
compute the *actual* GBW from the sized device — including the gate capacitance the bind did
not know about — and check that:

```json
{ "name": "Cout", "expr": "cgg + CL" },
{ "name": "GBW",  "expr": "gm/(2*pi*Cout)" }
```

Now the `GBW >= GBW_target` guardrail is meaningful: it fails by exactly the amount the sized
`cgg` loads the output, which is a real design fact the pinned value hid.

## Feasibility

A sheet is **feasible** only when all of the following hold (it fails closed otherwise):

- a declared bind sized successfully, and the sizer's own verdict (`gm/ID` at or below the
  data `ceiling`) held;
- every **hard** rule (invariant and requirement) is `pass` or `amber`;
- every composed child is feasible;
- no error-severity warning was raised (including structural validation errors).

Guardrails are excluded from this aggregate. A sheet with no bind and no children is feasible
whenever its hard rules hold.

## The width contract

Every quantity the sheet reports describes the **sized** device, not the characterization-width
artifact. When the bind sizes a device to width `W`, the extensive quantities — `id`, `gm`,
`gds`, the capacitances, the noise PSDs, `w` — are rescaled from the characterization width
`w0` to `W` (the parallel-composition model: the sized device is `W/w0` unit devices in
parallel), and the derived layer (`av0`, `ft`, `vstar`, input-referred noise, …) is
re-evaluated from those scaled bases. So author math like `gm/(2*pi*cgg)` reads the device you
actually sized.

The one exception: a quantity from an **unknown pass-through column** (a header the importer
did not recognize) is *not* rescaled, because its width law is unknowable — it stays at `w0`.
The characterization width is exposed as `w0`, so if you need to refer such a column to the
sized width you can scale it yourself with `w0/W` (or `W/w0`).

## Composition

A sheet composes children through `uses`. Each child is either a full sheet embedded inline
(`doc`) or a **reference** to a library sheet (`ref` — see [References](#references)), and it
exposes named scalars to the parent through its `provide` list.

| Field | Type | Meaning |
|-|-|-|
| `name` | string | The child's handle in the parent (used in the join, below). Must not contain `__`. |
| `doc` | object | The embedded child sheet. |
| `ref` | string | A library-sheet id to include by reference (resolved before evaluation). A use needs `doc` or `ref`; carrying **both** is a pinned snapshot — the embedded copy wins and the ref remains as provenance. |
| `device` | string, optional | The device the child sizes against (a resolver key); absent ⇒ the child inherits the parent's table. |
| `params` | object, optional | Overrides of the child's param values, each an expression evaluated in the **parent** scope. |

A child's provided scalars surface in the parent namespace as flat names `name__key` (the
engine has no member access, so `child.key` cannot parse — the join is a `__` separator).
Neither the use `name` nor a provided key may contain `__`, with one exception: a child may
re-export one of *its* children's provides (a name like `s1__Cin`) up the tree, so a deep
quantity can surface at the top. The parent references these joined scalars and writes its own
author math over them — this is scalar composition only; there is no node, port, or KCL
machinery.

**Document-order evaluation.** Children evaluate in the order they are listed, and each is
evaluated *before* the parent's own bind. Two consequences:

- A parent can reference a child's provides anywhere — including in its own `bind` (e.g. a
  cascode device carrying the input pair's `cs__id`).
- A child's param override can reference the provides of **earlier** siblings (a later branch
  carrying a current an earlier branch derived), but a forward reference — to a later sibling,
  or to the parent's own not-yet-sized device — **fails closed** as undeclared.

**Fail-closed overrides.** A param override is the parent explicitly supplying a value, so one
that does not resolve to a finite number is an error (it does not fall back to the child's
default — that would size a different design than authored). A child that errors or reads
infeasible drags the parent's feasibility down, and its warnings roll up attributed to the use
site. Composition is depth-capped at 8.

### References

Instead of embedding a child, a use may point at a sheet in the **library** — the curated
sheets bundled with the app plus any sheet you have imported (a `.json` loaded through the
same control as a CSV table; imported sheets persist across reloads and appear in the picker
under *Your sheets*):

```json
{ "name": "ld2", "ref": "multistage/stage2-current-source-load",
  "params": { "Ix": "I2", "Lx": "L_ld2", "gx": "gm_id_ld2", "vx": "V_out2" } }
```

A sheet's id is its bare filename (no `.json`). That is unambiguous exactly as long as the
name is unique across the library — on a collision, qualify it with its folder
(`multistage/stage2-current-source-load`; imported sheets live under `user/`). Sheets meant to
be shared should use the qualified form, which stays valid no matter what is loaded next to
them. Resolution is **fail-closed**: a ref that matches nothing, a bare name that has become
ambiguous, or a circular reference is an error naming the problem, and the block reads
infeasible — never a silent guess.

References resolve **live**, before every evaluation: edit the library sheet and every design
referencing it re-sizes accordingly. The parent's `params` overrides are the customization
channel — a referenced block's internals belong to the library sheet, so the app shows them
read-only (the *detach* control swaps the reference for an embedded copy when you need local
edits). Two export shapes cover sharing: *as-authored* keeps refs (ship it alongside the
sheets it names), and *flattened* inlines every reference — a self-contained document, frozen
against later library edits, for a signed-off design.

### Signed-table sign parameters

A child that may bind against a **signed-convention PMOS table** (negative vgs/vds axes)
conventionally takes a companion parameter named **`<child>_sign`** (e.g. `ld_sign` for a
child named `ld`): `+1` for an N-style axis, `-1` for a signed-PMOS axis, used by the
child's `vds` override expression. The name is a convention, not an enforced contract —
but the app's sheet panel recognizes exactly this `<child>_sign` pattern and hints when
the bound table's recorded polarity (or a fully non-positive vgs axis) says the sign is
still wrong. A few library sheets instead share one global sign param (e.g. `p_sign`)
across several same-polarity children; those get no per-child hint, so prefer the
per-child form when authoring.

## Sweeps

Two views trace a sheet across parameter ranges (both need finitely-bounded slider params):

- **One-parameter sweep** — walk one sweepable param across its `[min, max]` and, at each
  sample, plot every rule's relative margin plus the overall feasibility. This is the classic
  feasibility-region view: wherever every hard rule's curve sits at or above zero, the design
  closes. In a composed sweep, each descendant block's hard rules ride along with path-prefixed
  ids (`cs.headroom`), so the constraint that actually binds is on the chart wherever it lives.
- **Two-parameter sweep** — the design-plane map over two params' ranges (the `gm_id × L` plane
  is the classic), answering questions a 1-D cut cannot: "what is the minimum `L` that stays
  feasible across the whole `gm_id` range?" Each infeasible cell names the worst failing hard
  rule (by tree path), so a child's constraint is attributed to the block it lives in.

## A complete worked example

A single-NMOS sizing sheet: fix `gm` from a bandwidth spec, use `gm/ID` as the efficiency knob,
and let `ID` and `W` fall out of the lookup. The headroom floor is an invariant, the noise
budget a requirement, and the bandwidth check a guardrail computed from the *derived* GBW (so
it is not a pinned tautology):

```json
{
  "title": "Single NMOS gm/ID sizing",
  "description": "Sizes one NMOS for a bandwidth spec: $g_m$ is fixed from GBW into $C_L$, $g_m/I_D$ is the efficiency knob, and $I_D/W$ falls out of the lookup. Change the spec params freely; tune the choice params and watch the headroom/noise trade.",
  "polarity": "n",
  "params": [
    { "name": "GBW_target", "value": 10000000, "unit": "Hz", "role": "spec" },
    { "name": "CL", "value": 2e-12, "unit": "F", "role": "spec", "note": "load capacitance" },
    { "name": "L", "value": 5e-7, "min": 1.8e-7, "max": 2e-6, "unit": "m", "role": "choice" },
    { "name": "gm_id", "value": 12, "min": 6, "max": 18, "unit": "1/V", "role": "choice",
      "note": "inversion-level knob: high = efficient/slow, low = fast/thirsty" },
    { "name": "vstar_floor", "value": 0.2, "unit": "V", "role": "spec",
      "note": "saturation-headroom budget" },
    { "name": "vn_target", "value": 20e-9, "unit": "V/sqrt(Hz)", "role": "spec" },
    { "name": "V_ds", "value": 0.6, "unit": "V", "role": "spec",
      "note": "drain bias the sizing slices at; body-grounded, so vsb = 0" }
  ],
  "bind": { "L": "L", "gm": "2*pi*GBW_target*CL", "gm_id": "gm_id", "vds": "V_ds", "vsb": "0" },
  "rows": [
    { "name": "Cout", "expr": "cgg + CL", "unit": "F" },
    { "name": "GBW", "expr": "gm/(2*pi*Cout)", "unit": "Hz" },
    { "name": "vn_in", "expr": "vnth_m", "unit": "V/sqrt(Hz)" }
  ],
  "rules": [
    { "id": "feasible-inversion", "kind": "invariant", "lhs": "gm_id", "op": "<=", "rhs": "ceiling",
      "note": "gm/ID cannot exceed the weak-inversion ceiling of the data" },
    { "id": "headroom", "kind": "invariant", "lhs": "vstar", "op": ">=", "rhs": "vstar_floor" },
    { "id": "gbw-margin", "kind": "guardrail", "lhs": "GBW", "op": ">=", "rhs": "GBW_target" },
    { "id": "noise-spec", "kind": "requirement", "lhs": "vn_in", "op": "<=", "rhs": "vn_target" }
  ]
}
```

Reading it: `gm` is pinned from the spec and `gm/ID` chosen, so the bind sizes the device and
surfaces `vstar`, `cgg`, `ceiling`, and the γ-model noise density `vnth_m`. The bind also pins
the operating point with `vds` (from `V_ds`) and `vsb` (0, body-grounded), so on a table with
live `vds`/`vsb` axes the sizing slices at a stated point instead of borrowing the caller's
bias. The two invariants
enforce a physical `gm/ID` ceiling and a saturation-headroom floor. The requirement holds the
input noise under target. The guardrail compares the *actual* GBW — which includes the sized
`cgg` loading — against the target, so it reports how much the gate capacitance eats the
bandwidth without ever blocking feasibility. Sweeping `gm_id` traces every rule's margin and
shows the feasible window between the headroom floor (at high `gm/ID`) and the point where the
device runs out of inversion ceiling.

For a composed example — a cascode that stacks a child common-source input device and carries
its provided drain current — and for evaluating any of these sheets from Node, see
[Scripting the core](../README.md#scripting-the-core).
