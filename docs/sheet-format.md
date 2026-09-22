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

## Two questions: closes, and covers

A sheet answers two questions, and keeping them apart is what makes its verdicts readable.

- **Closes** — *does this design TYPE meet the spec at all?* A type-level question, so the
  evaluation is free to re-derive the design: move a knob and every device re-sizes around it.
  The base run, the sweeps and the topology picker's search all work this way.
- **Covers** — *does the design this run just produced still hold at the ends of the range it
  claims?* An instance-level question, so nothing is rebuilt: each device is held at the
  geometry this run sized it to and only the bias re-settles.
  [Containment edges](#containment-edges-edges) ask this one.

Rebuilding is the whole point of the first question and the whole error of the second. The
instance a coverage check is about is simply whatever the current settings produce — never a
frozen reference design: turn a knob and a different instance is checked, and each cell of a
sweep checks its own cell's design.

The sheet's single feasibility verdict FOLDS both answers — a design that does not cover its
claimed range is not feasible, so the badge can go red with every rule green (see
[Feasibility](#feasibility)). `covers`, reported per range end, is where the second answer reads
on its own. In results, `closes` carries the first answer before that fold, so a coverage gap
never reads as a failure to close.

**Process corners parameterize both questions; they do not add a third.** The same sheet can be
evaluated at any (corner, temperature) condition its device tables are loaded for, and every
verdict is then stamped with the condition it was measured at — "closes at tt" and "closes at
all five loaded conditions" are different claims. Which conditions to evaluate is a property of
the viewer's bench (which tables are loaded, which one is designated nominal), **never of this
document**: nothing corner-related appears in the sheet JSON, and a sheet file is portable
across benches with different corner sets.

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
| `provide` | array of string, optional | The names this sheet exposes to a parent. Inert to the engine at the top level, but load-bearing there as the sheet's declared interface (see [Port contracts](#port-contracts)). |
| `edges` | array, optional | Containment edges: the claimed range's ends, re-checked on the design this run produced; their hard verdicts gate the sheet (see [Containment edges](#containment-edges-edges)). |

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
| `solveFor` | string, optional | Makes this parameter a tearing variable and names the value it must agree with, closing a bias loop (see [Closing a bias loop](#closing-a-bias-loop-solvefor)). A solved parameter is not sweepable. |

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

The optional `bind` sizes one device by fixing **exactly two** bound quantities at a chosen
length `L`, and inverting the lookup table for the rest. Every field is an **expression
string**, so a bound quantity can be computed from the params:

```json
{ "L": "L", "gm": "2*pi*GBW_target*CL", "gm_id": "gm_id" }
```

Here `gm` is fixed from the bandwidth spec and `gm/ID` is the design knob; the drain current
follows from `gm = (gm/ID)·ID`, and the width, `VGS`, and every derived figure of merit fall
out of the table.

The bindable quantities do two different jobs:

| group | quantities | what it fixes |
|-|-|-|
| operating point | `gm_id`, `ft`, `gm_gds`, `av0`, `vstar`, `vgs` | where on the curve the device sits |
| size | `gm`, `id`, `W` | how big it is |

An **operating-point** quantity pins `VGS` on the `L` slice by itself and says nothing about
size; a **size** quantity then scales that point into a real device. The first five are ratios
of two per-width quantities, hence width-invariant. Binding `ft` or `gm_gds` is how a sheet
states the spec it actually has — a transit frequency, an intrinsic gain — instead of solving
by hand for the `gm/ID` that meets it.

`vgs` is the sixth, and the degenerate one: it *is* the coordinate the others are inverted to
find, so binding it needs no inversion at all — the table is read forward at the gate voltage
given. Its purpose is structural rather than a target. Two devices whose gates are one wire and
whose sources are one node sit at one gate-source voltage, whatever the table, the corner or
the temperature, and

```json
{ "L": "L", "W": "K*ref__W", "vgs": "ref__vgs", "vds": "V_out" }
```

is a current mirror written down exactly. Writing the same mirror as a `gm_id` shared with the
reference is an approximation that holds only while both devices read the same table at the
same bias; it drifts with the drain voltage on real data and breaks outright across a corner,
and it understates the mirror's own systematic error when it does. `vgs` is **signed in the
table's axis convention**, so on a signed PMOS export it is negative — the same convention
`vds` and `vsb` use, and the one place a bound quantity may be zero or negative.

A gate voltage outside the table's swept range is **clamped to the nearest characterized node
and warned about**, the same treatment an out-of-range `L` gets: an axis coordinate has a real
node to fall back to. (An unreachable `ft` or `gm/ID` throws instead — an inversion past the
data has no answer to fall back to.)

So a legal bind is:

- one operating-point quantity + one size quantity — e.g. `ft` + `id`, the classic
  `gm_id` + `id` (the width is sized from the current density), or `W` + `vgs` (a gate tie:
  the width is stated and the gate voltage is imposed).
- two size quantities, which pin the operating point between them: `gm` + `id` fixes
  `gm/ID`, while `W` + `gm` or `W` + `id` inverts the matching characterization-width curve
  at a transconductance or current density (width-first flows: unit devices, mirror ratios,
  layout-constrained sizing).

Two operating-point quantities is an error: they over-determine `VGS` and generally
disagree. Binding fewer or more than two quantities is likewise an authoring error and is
flagged. A target the table cannot reach at that `L` fails closed with the achievable range,
and a target the table cannot compute at all (`ft` on a table with no `cgg` column) says
which column is missing. Expression strings accept engineering-notation literals and the
full expression language (see [The expression language](#the-expression-language)).

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

If the table has a live axis the bind does not declare, the axis takes its **namespace default**
when the table characterizes that point — `vsb = 0`, source at bulk — and the coordinate is
reported as **assumed**, shown with a `?` beside it in the sizing line. `vds` has no honest
default (it is set by the circuit node, not the device), so an undeclared live `vds` fails the
sizing with guidance to declare it. A declared value always wins, and a declared value outside
the table's range is clamped to the nearest edge with a warning.

**Declare `vsb` whenever the source does not sit at the bulk.** The default is correct for a
common-source device or a rail-referenced mirror, and wrong for every differential pair, cascode
and source follower — where the source floats and body bias is a real, often large, effect. A 5T
OTA's input pair measured **80 mV** of threshold shift against the body-grounded assumption. The
engine cannot tell the cases apart, because a sheet describes devices and not nodes; it reports
what it assumed and leaves the judgement to you. That is deliberately *not* a warning: about
nine in ten of the library's binds leave `vsb` undeclared and are right to, and a warning at that
hit rate teaches authors to ignore the channel.

A device whose `vsb` depends on its own `VGS` — an input pair standing on a tail node — is a bias
loop, so declare it through a tearing variable (see [Closing a bias loop](#closing-a-bias-loop-solvefor)).

### Gate wiring (`wiring`)

A bind slices two of a device's three terminal voltages as table axes — `vds` and `vsb`. The
third, the gate, is usually an *output* of the bind: `vgs` is the answer to "what drive does
this current at this inversion level need". So a sheet can name the node a gate is tied to, size
the device, and never compare the two. That is how a design ends up sized at one voltage and
wired at another with every rule still green.

Binding `vgs` (see [The bind](#the-bind)) turns that around for one specific case — a gate on
the same wire *and* the same source node as another device, which is what a current mirror is.
There the gate voltage is an input, and the identity holds by construction rather than by
agreement. `wiring` remains the general channel: a gate tied to a rail, or to a node no other
sized device sits on, still has nothing to bind to and is declared and checked here.

The declaration therefore lives on the **use**, not on the bind — it is a fact about how the
parent wired the child in, which is knowledge only the parent has:

```json
{ "name": "s2", "doc": { }, "params": { },
  "wiring": { "gate": "V1", "source": "VDD" } }
```

| Key | Meaning |
|-|-|
| `gate` | Expression for the node the child's gate is tied to. |
| `source` | Expression for the node its source sits on. |

Both node expressions evaluate in the **parent's final scope**: unlike a param override, which
sees only earlier siblings, the check runs once on the settled result, so every sibling's
provides *and* the parent's own rows are in scope. A node the sheet derives as a row is
therefore as usable here as one it types as a param. The identity checked is

```
gate == source ± |the child's sized VGS|      (+ for an n child, - for a p one)
```

**No sign to write, and none to get wrong.** The magnitude comes from the child's own bind and
the direction from its declared `polarity`, so the check is the same on a signed PMOS export
(negative `vgs` axis) and on one in N convention (positive) — the two conventions differ only in
a sign the identity never reads. There is deliberately no author-supplied sign expression: a
wrong one would silently invert the identity and report agreement on a design wired backwards,
and the polarity the block already declares carries the same information with nothing to mistype.

Because the voltage compared against is the **bind**, not a scalar the child publishes, no
`provide` list stands between the declaration and the number: a block that sizes can always be
checked. A block with no bind has no sized gate-source voltage, and the evaluation says so
rather than reading silently clean.

**Warn, never fail.** A disagreement larger than **10 mV** (absolute, in the voltage domain —
a relative tolerance would excuse a bigger error on a bigger supply) is reported as a
`sheet-wiring` warning naming both voltages and the delta. It never changes the verdict and
never repairs anything: the declaration and the sizing are two descriptions of one node, and
which of them is wrong is a design question the author answers. An author who wants the
disagreement to *gate* writes a hard rule over the same two quantities — that is the escalation
path, and it is a deliberate one, because a sheet mid-repair should still evaluate.

**A half-declaration is a validation error.** `gate` without `source`, an unknown key, an
expression that does not parse — none of these state an identity, and a sheet reported as
wiring-checked when nothing was checked is exactly the silence this mechanism exists to break.
Structural problems are the *only* route by which wiring reaches a verdict.

A sheet may declare `wiring` on a child *and* claim operating ranges through `edges`. The
disagreement is then reported once per run — the base evaluation plus each edge — and that is
intended, not a duplicate: a range end re-settles the SAME hardware at a different bias, so its
residual is a measurement of the same identity under different conditions.

The check is local to each node of the tree: a child sheet's own uses are checked when that
child evaluates. There is no cross-tree wiring graph and no KCL — this declares one identity
per gate and checks it, nothing more.

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

### Body effect and noise-model defaults

Two quantities a sheet reaches for constantly are handled in deliberately different ways, and
the difference is worth stating once.

`gmb` is **data**. It is an optional base quantity like `gds` or `cgg`: present when the table
carries it, absent otherwise. There is no fallback. A sheet that writes `gm + gmb` on a table
without a `gmb` column gets a skipped row and a named warning, and any hard rule reading that
row goes `na`, which fails feasibility closed. That is on purpose — a `gmb = 0` stand-in would
make the same sheet compute different physics on different tables while both looked green,
and would show a model zero where the tool promises data. Wherever the body terminal is not
tied to the source, `gmb` belongs in the expression; write it, and let a table that cannot
support the sheet say so.

`gamma` is a **model default**. It is a named constant, so it is always in scope, and a table
carrying its own per-point `gamma` column shadows it — real data wins. The default is 1.0,
which is representative of the sub-micron devices this tool sees; the textbook long-channel
value 2/3 describes no table anyone ships here, and for a noise *floor* an optimistic
stand-in is the dangerous direction. Every quantity built on it is `_m`-marked (`svth_m`,
`vnth_m`) so a model estimate is never mistaken for a measurement. It remains an estimate:
against measured silicon noise on comparable topologies, γ = 1.0 closes only about half the
gap, so treat a γ-model density as a lower bound and size a real budget above it.

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

A margin within a tiny relative distance of zero — 1e-5 of the LARGER operand,
`max(|lhs|, |rhs|)` — snaps to exactly 0, and a snapped margin reads `amber` for EVERY
operator, `==` included: an equality sitting a hair outside its tolerance band must
surface as a near-miss, not silently read full pass. Two mechanisms park a rule ON its own boundary by construction. First, a rule that
tests the very quantity the bind pinned: bind `gm = 2*pi*GBW_target*CL` and then write
`GBW_target*CL*2*pi <= gm`, and the two sides are algebraically identical, landing within
floating-point rounding of the boundary. Second, a containment edge evaluated AT a claimed
range end: the pin lands `CM_in` within its landing tolerance (10⁻⁶ of the bracket span,
stretched by the relation's slope — microvolts on a volt-scale node) of the very value
`cm-not-below` compares it against. Without the snap either verdict would coin-flip; with it,
both read as a deterministic `amber`. The threshold sits two orders below the ~0.1% the sizer
resolves between grid nodes, so a rule "failing" by less than the data can distinguish is
read for what it is: sitting on the boundary.

A bound **operating-point** quantity (`gm_id`, `ft`, `gm_gds`, `av0`, `vstar`) reads back as
exactly the value you asked for, so a rule restating it behaves the same way. Be aware of what
that number means: the operating point is recovered by inverting a curve sampled at the `VGS`
grid nodes, while the rest of the point is interpolated from the raw columns and re-derived.
Between nodes those two routes differ — by around 0.1% for a ratio on a 10 mV grid — so the
sized device sits that far from the target, well inside the data's own resolution but not at
it exactly. If that margin matters for your design, characterize on a finer `VGS` step.

A bound `vgs` is the exception: it is read back as the coordinate the table was actually read
at, which is the value you asked for unless it fell outside the swept range and was clamped —
and then the clamped value is the honest one, since it is the point every other quantity beside
it came from. There is no inversion residual to repair, because there was no inversion.

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
- every declared containment edge covers — a claimed range is part of the spec, so a design
  that misses its own claim fails (see [Containment edges](#containment-edges-edges)). A range
  end that was not CHECKED never fails the sheet on its own account: that happens only where the
  run already failed the last condition below;
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
| `wiring` | object, optional | The nodes the child's gate and source are tied to, checked against the `vgs` its own bind sized to (see [Gate wiring](#gate-wiring-wiring)). |

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

### Port contracts

A library sheet declares its interface the way a datasheet does: the small-signal quantities
a neighboring stage would need are ordinary rows with reserved names, and the sheet's
top-level `provide` lists them. There is no schema field and no engine machinery — the
contract is a naming convention plus the declaration.

- **`Rout`** — the output resistance at the sheet's output node, written as the inverse of
  the very denominator the sheet's own gain row uses, so the output node has exactly one
  definition (a one-stage sheet's `Av` is a transconductance times `Rout`; in a two-stage
  sheet `Rout` is the output stage's node and `Av2` is the row that reads through it).
- **`Rin`** — the input resistance, only where the input is genuinely low-impedance (a
  common-gate stage). A gate input gets no `Rin`.
- **`cgg_in`** — the capacitance a driver sees, per input terminal, taken as the input
  device's total gate capacitance. An estimate that says so in its note, and which way it
  errs depends on the stage: on an inverting stage the Miller term needs the gate–drain
  fraction these tables do not carry, so the number is a lower bound; where the source
  follows the gate (a follower's bootstrapped input) it is instead an over-estimate. Each
  sheet's note states its direction — and `cgg_in` never appears in a hard rule.
- **`Ron`** — a switch's on-resistance, where that is the interface.
- **`I_q`** — the quiescent supply current as the sheet's own rows model the topology, which
  is the datasheet line one design is compared against another by. Estimate-grade like
  `cgg_in`: the note says which branches are counted (and, where the realization could differ
  — a pseudo-differential copy, a common mode that shuts one pair off — which reading it is),
  and it never appears in a rule. A sheet whose supply current is the designer's knob rather
  than a consequence publishes that PARAMETER under the name instead of adding a row; the
  quantity has one definition either way.

Loading expectations follow one rule: **state the claim on a quantity the sheet actually
owns.** A sheet that models its load (a drain resistor, a `gds_load_est`) already folds
loading into its gain arithmetic — the arithmetic is the contract, and no extra rule is
added. A buffer whose approximation depends on a load regime writes a guardrail on its own
load parameter (the source follower's `R_L >= 10*Rout`; ten-to-one keeps the loaded gain
within about ten percent of intrinsic — a convention, not physics). A sheet that models no
resistive load says so in its `Rout` note ("The gain assumes a capacitive load"). The
cross-stage check belongs to the **composing parent**, which is the only place that sees
both sides of a port: the interstage pole `1/(2*pi*s1__Rout*s2__cgg_in)` is one
author-written row away, and `s2__Rin >= 10*s1__Rout` one guardrail.

The `sheet-provide-coverage` warning polices both directions of the contract. Upward, every
`child__key` an expression reads must appear in that child's `provide` list — a missing
entry degrades at runtime exactly like absent data, so the validator names the slip
statically, and a prefix naming no child at all is reported as the typo it is. A
reference-only child is skipped (its provides are unknown until resolution, and the
resolved document is validated again). Downward, a `provide` key on any block without its
own `bind` — the top level or an embedded child alike — must name a param or a row of that
block; a bound block is instead taken at its word, because a bind publishes every table
quantity including pass-through columns no table-independent check can enumerate.
Re-export keys carry the `__` separator and are ruled on at the use site instead.

## Closing a bias loop (`solveFor`)

Children evaluate in document order and may only read *earlier* siblings, so the composition is
acyclic by construction. Real circuits are not — but before reaching for the solver, check
whether the loop is real. Most in this library were **parameterization artifacts**: the 5T OTA's
famous cycle (the pair's `VGS` sets the tail node it stands on) vanishes entirely when the tail
node is the declared variable, and a spec like the common mode enters through a `pin` instead.
Every sheet in the library now closes its bias that way; none tears a node-voltage loop anymore.

`solveFor` remains for the loops that survive reparameterization: a quantity defined in terms of
the device's *own* answer. The library's live example is the wide-swing mirror's node — a real
wide-swing bias generator parks the mirror node at the mirror device's own `vdsat` plus a margin,
and that `vdsat` is only known once the device is sized at that very node:

```json
{ "name": "vds_lo", "value": 0.3, "unit": "V", "role": "choice",
  "solveFor": "wideswing_node",
  "note": "the wide-swing mirror node, iterated to the mirror's own vdsat + node_margin" }
```

The target is any name resolvable in this sheet's namespace once its body has run — a row (as
here, `wideswing_node = ref__vdsat + node_margin`), a child's provided scalar, or the sheet's own
sized operating point. `value` is only the starting guess: where the loop contracts to a single
fixed point, every guess lands on the same answer. A guess still matters when it decides *which*
fixed point you reach (contraction is local, so a loop can have more than one) or whether the
iteration gets there at all, so keep it near the value you expect. Because the parameter is
solved rather than set, the GUI shows it read-only, reporting what it converged to rather than
what was authored — and there is no companion guardrail to retune, because there is no estimate
left to drift.

**Without `solveFor` the estimate is whatever the author last typed**, and nothing forces it to
agree with the design. That is not a small error: an early revision of the library's 5T OTA
shipped with a default that placed the input pair's drain 6 mV above its `vdsat`, so the sheet
evaluated `gds` on a device in triode and reported a gain of **1.8 against a target of 15**. In a
new sheet, prefer (in this order): a node parameterization that never creates the loop, a `pin`
when a spec must drive an internal node, and `solveFor` only for a genuinely self-referential
quantity.

### What it does and does not guarantee

Iteration is plain substitution: replace each estimate with the value the sheet resolved for it,
repeat until every one agrees. That converges when the loop **contracts** — when a small change in
the estimate produces a smaller change in what it names. Real bias loops do: an estimated node
voltage perturbs a drain bias, which moves the sized `VGS` only slightly.

Every failure mode is closed, never silent:

| situation | result |
|-|-|
| the named target does not resolve to a finite number | infeasible, `sheet-solve` error naming the estimate |
| the gap to the target grows for several passes running | infeasible, `sheet-solve` error reporting the loop as diverging |
| the loop runs out of passes while still closing | infeasible, `sheet-solve` error reporting how far the disagreement fell — the loop is stable, just too weakly damped to finish |
| the loop runs out of passes without a trend either way | infeasible, `sheet-solve` error asking whether each `solveFor` names the right value |
| a param solves for itself | validation error (it is a fixed point trivially, and hides the loop) |
| more than four params carry `solveFor` | validation error — see the scope note below |

Convergence is judged **relative** (to about 1e-7), deliberately with no absolute floor: the core
is SI throughout, so a tearing variable is as likely to be a capacitance near `1e-15` as a voltage
near 1, and any fixed absolute floor would be satisfied instantly at the small end and report a
wildly wrong estimate as converged.

A loop that does not converge is telling you the tearing choice is unstable, not that the circuit
is. Two fixes usually apply, in this order:

1. **Reparametrize so the loop disappears.** Many are artifacts of which variable was declared
   independent. Taking the tail node voltage as an input makes the input device's `vds` explicit
   and turns the input common-mode range into an output the rules check — same physics, no loop.
2. **Cut the cycle somewhere else**, at a quantity the rest of the design depends on more weakly.

Note that *under*-relaxation (`x + λ·(f(x) − x)` with `0 < λ ≤ 1`) cannot rescue a divergent loop:
its effective slope is `1 + λ·(f' − 1)`, still above 1 whenever `f' > 1`. Only a secant/Wegstein
step, which derives a negative `λ = 1/(1 − f')`, would — and that is deliberately not implemented,
because a divergent loop is worth reporting rather than solving around.

### Scope: a few named loops, not a circuit solver

At most **four** params per sheet may carry `solveFor`. The architecture permits "small, explicit,
designer-named fixed points" and forbids a nodal solver; tearing many unknowns at once stops being
the former and becomes relaxation over a node set. The limit makes that boundary checkable rather
than aspirational. Nested loops also share one evaluation budget for the whole composed tree,
since a parent's iteration re-converges each child's loop and the cost would otherwise multiply
with depth.

### Consequences for rules and sweeps

A `*-consistent` guardrail comparing an estimate against its target becomes an **assertion** — it
should now always pass, and a trip means the fixed point did not hold. Keeping it is cheap
confirmation; it is no longer something to retune by hand.

A solved parameter is **not sweepable**: it is no longer a free variable, so the sweep pickers and
both sweep engines exclude it however its `min`/`max` are written. Sweeping other params still
works, and each sample closes its own loop — which is what makes a composed sweep quantitatively
trustworthy, since one slider value cannot be correct across a whole plane.

Every sample is solved **independently**, from the authored starting guess; a sample is never
seeded from its neighbour's answer. That optimisation is tempting and wrong: contraction does not
imply a unique fixed point, so a carried seed makes the sweep hysteretic, and a cell could then
report a different verdict than the same parameters evaluated on their own. The honest version
costs real time — about 25 ms per sample for a three-child sheet that solves a loop and declares
both bias axes on a real PDK table, so roughly 11 s for a 21×21 map, run synchronously. Each
declared bias axis adds a slice per pass, so most of that is the cost of not assuming.

## Entering from a spec (`pin`)

`solveFor` closes a loop the author could not avoid. `pin` is the opposite move: the sheet is
already loop-free because its bias variable is an internal node the tables are indexed by — and
the designer still gets to type the external quantity the application hands them.

```json
{ "name": "V_tail", "value": 0.4, "min": 0.15, "max": 0.8, "role": "choice",
  "pin": { "lhs": "CM_in", "rhs": "CM_dc" },
  "note": "the tail node, chosen so the produced common mode equals CM_dc" }
```

The engine chooses the parameter so that `lhs == rhs`, by **bisection between `min` and `max`** —
for a pinned parameter they are the bracket, not slider bounds. Bisection needs no contraction,
cannot overshoot, and owes nothing to a starting guess, so none of the substitution solver's care
applies; its honesty conditions are stated instead: `lhs − rhs` must evaluate at both bracket ends
and change sign between them, and must actually reach zero at the root. Each violation fails
closed with the reason:

| situation | result |
|-|-|
| `lhs − rhs` does not evaluate at a bracket end | infeasible, error naming the end — tighten the bracket to where the design sizes |
| `lhs − rhs` stops evaluating INSIDE the bracket | infeasible — the relation is not defined everywhere between `min` and `max` |
| no sign change across the bracket | infeasible — the bracket does not straddle the target, or the table cannot reach it |
| the bracket closes but the residual stays large | infeasible — the relation steps across the target (a table edge or a fold) without touching it |
| the shared iteration budget runs out first | infeasible — spent by the loops each probe re-closes or by an expensive sibling; the pin itself was not shown unsolvable |
| the probe backstop (200) is hit | infeasible — cannot occur before the width tolerance on a finite bracket; a backstop, not a tuning knob |
| the parameter also carries `solveFor` | validation error — one solver per parameter |
| more than one parameter carries `pin` | validation error — bisection is a scalar method |
| `pin` missing `lhs` or `rhs` | validation error — a half-written pin would freeze the parameter without solving it |
| `min`/`max` missing or inverted | validation error — the bracket is required |

The residual test is **form-invariant**: it is scaled by the relation's range over the authored
bracket, so `lhs: "CM_in", rhs: "CM_dc"` and `lhs: "CM_in - CM_dc", rhs: "0"` get the same
verdict. The bracket closes at 10⁻⁶ of its own span (a volt-scale node resolves to a microvolt),
which also means a root sitting exactly at zero converges like any other.

If the relation folds inside the bracket there may be more than one root; the one found is
determined by the authored bracket alone, never by history, so repeated evaluations always agree.
A pinned parameter is solved rather than set: the GUI shows it read-only with the value it landed
on, and it is not sweepable — sweep the spec on the other side of the pin instead. The library's
5T OTA is the worked example: the tail node is pinned so the produced common mode equals `CM_dc`,
which makes the common-mode axis a sweep of `CM_dc` with one bisection per point.

## Containment edges (`edges`)

A sheet that claims a RANGE — "this amplifier accepts any input common mode in
`[CM_lo, CM_hi]`" — used to check the claim with linearized guardrails, which could only
estimate the ends from the evaluated point. `edges` checks them directly:

```json
"edges": [
  { "name": "cm-lo", "set": { "CM_dc": "CM_lo" } },
  { "name": "cm-hi", "set": { "CM_dc": "CM_hi" } }
]
```

Each edge re-evaluates the WHOLE sheet once more with the named params' values overridden —
each `set` expression is evaluated against the base result, so it may reference params, rows,
or provided scalars. It is a coverage check, so the run is not free to build a new design at
the range end: every device in the tree is held at the width and length the base run sized it
to, and what re-settles is the bias. That re-settling is the machinery the engine already has —
the pin solve runs again from the full authored bracket, `vds` subtractions re-evaluate against
the moved nodes, each transformed device's `vgs` comes back out of the lookup at its held width —
with its
own children and its own solver budget. Every hard rule must hold there, and a solve that fails
at an edge — the bracket cannot reach `CM_lo` because no tail-node position produces it — is
itself the honest verdict that the design does not cover that end, reported with the solver's
own message. The badge names an edge failure through the same binding-constraint definition as
everything else, with the edge name prefixed: `cm-lo@tail-saturated`. Both tree-key separators
are reserved: rule ids, edge names, AND use names may contain neither `@` nor `.` — every one of
them becomes part of a key in the single map rule outcomes share, and a name carrying a
separator could silently shadow another rule's result (validation refuses them).

**Three outcomes, never two.** Each edge reports `covers`, `does-not-cover`, or `not-checked`.
Coverage is a question about an instance, so it can only be asked where the run produced one:
when the base evaluation raised an error-severity warning — a bind that did not size, a pin that
never landed — the ends are not checked at all, and saying so is the answer. It is not a
failure and must never be displayed as one. The distinction is load-bearing rather than
cosmetic: a pin that fails leaves its last bisection probe behind in the result with every bind
still reading `ok`, so a verdict computed from that point would describe hardware the engine
never landed on. A rule FAILURE does not stop the check — a design that misses a spec is still a
design, and whether it holds across its claimed range is still a real question. The result's
aggregate `covers` is true when every edge reports `covers`, absent when nothing was checked.

What edges do and do not check: they check the **endpoints**, exactly. The interior follows
only where feasibility is monotone toward the ends — true of the saturation mechanisms that
end a CM range, not a theorem about arbitrary rules — so the sweep remains the authority on
the full landscape. Costs and semantics to know:

- Cost is `(1 + edge count)` full evaluations everywhere the sheet evaluates — sweep cells
  included, because a swept cell must never disagree with the same numbers evaluated alone —
  except where the base run did not stand, which costs one. A pinned sheet's 21-point sweep goes
  from ~0.6 s to ~1.8 s with two edges.
- A composed child's `edges` are **not evaluated** (validation warns): in composition the
  parent typically drives the child's spec params, which would make the child's own range
  claim a fiction. Re-declare the claim on the parent if it should gate there.
- `set` may not target an engine-solved param (`pin`/`solveFor`) — the solve would discard
  the override; validation refuses it.
- The report carries the full story per edge: `state` (the three-way outcome above), `set`
  (the NUMERIC point that was checked — the authored side may be an expression), `rules` and
  `children` (path-attributable outcomes), `solved` (where the engine-solved params landed;
  EMPTY when the run did not stand, so a bracket end is never reported as a landing),
  `warnings` (the run's own diagnostics, verbatim — a bias clamp fires exactly at a claim's
  extreme, and a green verdict must not rest on silently clamped data), `error` (the solver's
  message when the run could not be evaluated at all), and `assumedSource` (see the fidelity
  notes below). A `not-checked` edge carries no outcomes: nothing ran.
- A range end can push a device's required current density outside the swept `vgs` range —
  its width is no longer free to grow to meet the current, so the inverse lookup can run out
  of table. That is a failure to cover, and it is reported in those terms ("this device cannot
  carry its authored current at the endpoint bias") with the lookup's own message and reach
  numbers kept behind it.
- In the 1-D sweep each edge rides as one aggregate curve (legended `covers cm-lo`): its
  worst hard-rule margin per sample, SKIPPING margins that sit exactly on zero — the
  edge's own range rule is parked there by construction (the snap) and carries no
  headroom information. An end that was checked and does not cover draws at the bottom clip
  rather than vanishing, so an edge-driven feasibility flip always has an on-chart cause; a
  sample whose ends were never checked leaves a GAP in the curve, because there is no
  margin to draw and the bottom clip would read as a failure.
- Edge curves move along EVERY sweep, including a sweep of a param an edge overrides (the
  canonical kit sweeps `CM_dc`, which both ends pin). Each sample checks its own sample's
  design, so what the curve traces is how the coverage margin of a changing design varies —
  not a constant redrawn. The caption on the chart says so.

### What "the same design" means at a range end

"Held hardware" means held at the sheet's own level of description, which is worth stating
exactly — an author reading a green chip should know what it is and is not a statement about.

- **The geometry is pinned numerically, per bind.** A bind that names no width — the common
  `(gm/ID, I_D)` form the library is nearly all written in — becomes `(W, I_D)` for the range-end
  run, at the width and length the base run sized, keeping the authored current expression. A
  bind that already names a width is left exactly as authored, which is what makes a gate tie
  survive: a `vgs` bound to another block's gate voltage re-reads that block's newly settled
  voltage at the end, so the two devices stay on one wire. A width-first bind whose partner is
  an operating-point TARGET instead holds a ratio rather than a wire, and reproduces the tie
  only under a drain-voltage move. A bind
  that names neither a width nor a current has both pinned numerically, and the run lists those
  blocks in `assumedSource` — the sheet never said where their current comes from, so holding it
  is an ideal-source assumption, and the fix is to author the current.
- **The geometry is exact; the small-signal numbers read off it are not.** A rewritten bind
  re-reads `gm` from the table at the pinned width instead of honouring the ratio the author
  wrote, so a range-end `gm` — and every quantity derived from it — sits an interpolation
  residual below the base's, about 0.1% on the demo model, even where nothing about the condition
  changed. Read a base-against-end comparison with that floor already under it.
- **The authored current expression IS the hardware model.** `I_o = K_m*I_tail/2` re-evaluates
  at the range end, and that ratio is the mirror. What it does not model is a real tail source's
  own output resistance re-settling the current as the drain moves; network-level re-settling is
  out of scope here as everywhere else in this engine, and the sheet's authority ends where the
  lookup table's does. Comparison against fixed-netlist simulation put that divergence at ~10%
  at the far ends of the shipped range claims, without changing any of their verdicts.
- **A device whose GATE is the fixed thing has to say so.** Bind `(W, vgs)` and the gate tie
  holds under any move a range end makes — drain, body bias, supply, temperature — because the
  bind re-reads the gate voltage the partner settles to there. Written any other way, the device
  is current-driven by assumption at a range end, and two devices sharing a gate node stay at one
  voltage only while the end moves `vds` alone. Validation warns when a width-first bind sits
  under a range end that reaches it through any other path, and says so differently when the end
  reaches the bind's own `W` or `L`, because then the run is sizing a different transistor rather
  than re-biasing this one. Both are advisory. Separately, `validateSheet` names two blocks whose
  `wiring` puts them on one gate and one source while each is sized at its own operating point —
  the declaration is never allowed to drive the bind, only to point out that nothing does.
- **At a bind the transformation rewrites, the data-ceiling verdict carries no information.** For
  the same reason its `gm` drifts low, its operating point is read out of the table rather than
  requested, so `gm/ID` is at or below the data ceiling by construction — that data-trust signal,
  one of the things that gates an ordinary bind, is structurally absent there. The run's other
  diagnostics (bias clamps, an inverse lookup that runs out of table) are what carry the trust
  question instead, which is why they ride the report verbatim. A width-first bind keeps its
  authored operating-point spec, so the ceiling still gates it at a range end — unless that spec
  is a bound `vgs`, which reads the point out of the table exactly as a rewritten bind does and
  is under the ceiling by construction for the same reason. Do not author a ceiling rule on a
  gate-tied device; it can only report a pass. The
  sheet's own ceiling RULE goes quiet in the same way and less visibly: it is authored against
  the `gm/ID` param (`gm_id_in <= ceiling`), and at a range end that param no longer binds the
  device, so the rule reports the base value unchanged and passes. A green ceiling chip on a
  range end says the ceiling held at the centre, not that it was re-checked there.

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

A margin says how much room a rule has but not which knob moves it, so the core also exports
`sheetSensitivities(doc, table?, resolveDevice?, opts?)`: it re-evaluates the whole sheet a
step either side of each `choice` param and reports, per rule, how far that rule's margin
moved — the ranking a designer needs to know what to turn next.

## The author's contract

The engine evaluates what a sheet declares; it never traverses a circuit. That division of
labor puts specific responsibilities on the sheet author. They are collected here in one
place, each with the check that catches a violation. The pattern throughout: the author
states the bias plan honestly, and the engine makes a false statement loud — it never
silently repairs one.

1. **Declare the operating point of every device.** Bias axes (`vds`, `vsb`) are expressions
   over named node parameters, stated at the bind (see *The operating point*). A bias axis
   the author did not declare is taken from the namespace default and reported in the bind's
   `assumed` list — visible, never silently adopted.
2. **Name internal nodes as parameters and write every `vds` as a subtraction of nodes.**
   Node form makes branch sums checkable and inconsistencies expressible. A source sitting
   above the bulk means `vsb` is declared from the same node that sets the source — body
   effect enters through the declared coordinate, not through a corrected formula.
3. **Never bias a child with an estimate of that child's own answer.** A hand-tuned
   parameter standing in for a quantity the sheet itself computes is the retired pattern.
   Backstop: the `sheet-standin` validation rule flags a parameter that feeds a child's bias
   while a rule asserts it equals that child's output.
4. **Declare wiring identities instead of copying their consequence.** A diode-connected
   device is `diode: true` — resolved exactly on the table's `vds = vgs` diagonal — not a
   hand-copied drop that goes stale when the operating point moves. A device on another
   device's gate wire, sharing its source node, binds `vgs` to that block's own gate voltage —
   not the same inversion level typed into both, which agrees only at one table and one bias.
   (`diode: true` and a bound `vgs` are independent and may both appear: the connection chooses
   the diagonal, the bind chooses the point on it. A declared `vds` is what the connection
   excludes.) Backstop: the `sheet-gate-tie` validation rule flags two blocks whose `wiring`
   puts them on one gate and one source while each is sized at its own operating point.
5. **Close a genuine loop explicitly, or do not close it at all.** `solveFor` is for a
   quantity defined in terms of the device's own answer; `pin` is for a typed specification
   an internal node must produce, with a bracket that must size at both ends (see *Closing a
   bias loop* and *Entering from a spec*). Backstop: both solvers fail closed with named
   reasons — divergence, overshoot, a bracket that never straddles, a residual that never
   reaches zero — and a failed solve is never reported as a sized design.
6. **A claimed operating range is a claim to check.** Declare `edges` so both ends are
   re-checked on every run — on the design that run produced, with its devices held — and say
   in the note that the ends are checked exactly while the sweep owns the interior (see
   *Containment edges*). Backstop: an end the design does not cover fails the sheet hard under
   an edge-qualified rule id.
7. **Pick each rule's kind for its verdict semantics.** Requirements and invariants gate
   feasibility; guardrails advise and never block; `==` fixed points carry a tolerance (see
   *Rule kinds*). A hard rule whose side cannot compute reads `na` and fails closed — so
   hard rules may only use quantities every supported table carries; model missing data as
   explicit `*_est` parameters with notes.
8. **Say "estimate" where the sheet estimates — and never gate feasibility on one.** Stability,
   dynamics, and anything a simulator owns is labeled estimate-grade in its note. The sheet's
   authority ends where the lookup table's does. The standing case is noise: a rule computed
   from the γ-model thermal floor, on a table carrying no measured noise, ships as a
   `guardrail` with a note saying why — it advises until the table carries measured noise
   density, at which point the rule may be promoted back to a requirement. The exception
   proves the rule: a kT/C noise bound is thermodynamics, not a γ-model estimate, and stays
   a hard requirement.
9. **Respect polarity by declaration, not sign-fixing.** Signed PMOS tables pair with
   `*_sign` parameters; value columns are magnitudes, axes keep their signs (see
   *Signed-table sign parameters*). Backstop: the panel warns when a sign parameter
   disagrees with the bound table's recorded polarity.
10. **Keep identifiers plain.** `@` and `.` are reserved in rule ids, edge names, and block
    names — they become tree-keyed, edge-qualified ids in reports. Validation rejects them.
11. **A node parameter's note names its setter.** Every declared node should say who sets
    it: a solve, a derivation from another block's output, a bias network the application
    provides, or a deliberate choice checked by a rule. Writing the sentence is the point —
    "this node is set by …" has exactly one honest completion, and a node whose setter is a
    device's own gate cannot honestly be typed as a free number. Backstop: declare the
    child's `wiring` (see *Gate wiring*) and the engine checks that node against the same
    device's sized `vgs` on every evaluation, reporting a disagreement past 10 mV. The note says
    which description is authoritative; the check says whether the two still agree, so a
    gate that must sit one `vgs` below a rail, or one gate shared by two devices, no longer
    evaluates without complaint.

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
