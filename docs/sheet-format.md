# The design-sheet format

A **design sheet** is a small, declarative document that sizes one transistor (or a
composition of several) against loaded characterization tables and checks author-written
constraints. It is the workbench's authoring layer on top of bind-any-2 sizing: you state
the spec and the design knobs as named scalars, give the quantities the device is sized
from, write intermediate equations, and declare pass/fail checks with margins.

A sheet is evaluated, never *solved*. It reads the device lookup tables and a few physical
constants, evaluates the expressions you wrote, and compares the results. There is no nodal
solver — the engine never solves the node set simultaneously — and the only operating-point
solving is the explicit, designer-named sizing from the givens. This document specifies the model
precisely enough to author a sheet by hand or generate one from code — see also [Scripting the
core](../README.md#scripting-the-core).

## Two questions: feasibility, and compliance

A sheet answers two questions, and keeping them apart is what makes its verdicts readable.

- **Feasibility** — *can this design TYPE meet the spec at all?* A type-level question, so the
  evaluation is free to re-derive the design: move a knob and every device re-sizes around it.
  The sheet's own run, the sweeps and the topology picker's search all work this way. It is
  asked once, where the design is sized, and it has one answer.
- **Compliance** — *does the ONE design that run produced still work everywhere it is promised
  to?* An instance-level question, so nothing is rebuilt: each device is held at the geometry
  the run sized it to and only the bias re-settles. It is asked at **points**: the design's own
  operating point (the centre) and each end of the range the sheet claims (its
  [operating range](#the-operating-range-operatingrange)), at every process condition selected.

Rebuilding is the whole point of the first question and the whole error of the second. The
instance a compliance point is about is simply whatever the current settings produce — never a
frozen reference design: turn a knob and a different instance is held, and each sample of a
sweep holds its own sample's design.

**The two answers are never folded into one.** A design that meets every spec where it is sized
and fails at one end of its range is *feasible* and *does not comply there* — two facts, shown
in two places. Feasibility is not lowered by anything that happens at a range end or at another
condition, and compliance is not implied by feasibility. In results, `feasible` carries the
first answer; `complies` and the per-range-end `state` carry the second.

**A compliance point has four possible outcomes, and only two of them are verdicts.**

| outcome | meaning |
|---|---|
| `complies` | the held design was measured at that point and every hard check holds |
| `does-not-comply` | it was measured there and a hard check fails — or a device held at its width cannot carry its current there at all, or a solved wire finds no crossing anywhere the wiring lets it go (see [The range a wire is searched in](#the-range-a-wire-is-searched-in)) |
| `no-answer` | the question was asked and could not be answered: a solve did not land in a range that is the author's alone, or did not settle, the table does not reach the bias the design sits at, or the design rests on a voltage classed `assumed` |
| `not-run` | the question was never asked: there is no design to hold, or no table loaded at that condition |

`no-answer` and `not-run` are never shown as a pass and never as a failure. A summary over many
points is therefore a count, not a word — "complies at 5 of 9 points · 1 fail · 2 no answer · 1
not run" — so it always says what happened to the points that did not comply.

**Process corners add points; they do not add a third question.** The same sheet can be
evaluated at any (corner, temperature) condition its device tables are loaded for. Which
conditions to evaluate is a property of the viewer's bench (which tables are loaded, which one
is designated nominal), **never of this document**: nothing corner-related appears in the sheet
JSON, and a sheet file is portable across benches with different corner sets.

**One design across the conditions.** A set of conditions is asked about one design, not one
design per corner. The design is sized once — at the device's nominal condition, or at the only
condition asked about when the bench designates none — and that run answers feasibility. Every
other condition is then asked about that same hardware: the widths and lengths that run
produced, the currents the sheet authors, and the gate biases its held nodes needed, with only
the operating point re-settled on that condition's tables. This is the same fixed-hardware
reading a range end uses (see [What "the same design" means at a range
end](#what-the-same-design-means-at-a-range-end)), applied across corners. A design re-sized at
each corner would report on a different chip each time; one is built. The nominal condition is
always part of the answer, whether or not it was asked for, because the design is sized there.

The operating range describes the **application** — the input levels and loads the circuit is
promised to work across — and the application does not move with the silicon. A range end
written as an expression (`V_out - 0.2`) is therefore resolved once, against the nominal run,
and every condition is asked about that same number.

Three things leave a condition's points without a verdict: several conditions with no nominal
among the loaded tables to size at, or a nominal that did not evaluate (`not-run`: there is no
design to hold); and a design that rests on a voltage classed `assumed` (`no-answer`: a typed
guess held fixed while the conditions move says nothing about the hardware). The last applies
to range ends too: a sheet with an assumed voltage reaching a device has no compliance answer
at any point, though its feasibility still reports.

## The document model

A sheet is one JSON object (the GUI edits and persists it verbatim). Its fields:

| Field | Type | Meaning |
|-|-|-|
| `title` | string | Display name of the sheet. |
| `description` | string, optional | A few sentences on what the sheet designs, its assumptions, and how to use it — the note a designer inheriting the sheet reads first. Supports inline math in `$…$` (see [Inline math](#inline-math-in-prose)), e.g. `$g_m/I_D$`. |
| `polarity` | `"n"` \| `"p"` | A self-description label only; no contract is enforced at a leaf. |
| `params` | array | Named scalar design inputs (see [Parameters](#parameters)). |
| `givens` | object, optional | The bind-any-2 device declaration (see [The givens](#the-givens-givens)). Omit for a sheet that only does author math. |
| `equations` | array | Named intermediate/output expressions, evaluated in document order (see [Equations](#equations-equations)). |
| `checks` | array | Named comparisons the design must satisfy (see [Checks](#checks-checks)). |
| `blocks` | array, optional | Child sheets this sheet composes (see [Composition](#composition)). |
| `provides` | array of string, optional | The names this sheet exposes to a parent. Inert to the engine at the top level, but load-bearing there as the sheet's declared interface (see [Port contracts](#port-contracts)). |
| `operatingRange` | array, optional | The ends of the range the sheet claims to work across. The design this run produced is held fixed and asked at each one; the outcomes are its compliance, reported beside feasibility and never folded into it (see [The operating range](#the-operating-range-operatingrange)). |
| `formatVersion` | `2`, optional | The document format. Absent: the earlier format, still read, though a sized device in it is refused until it is migrated (see [Every sheet names its wiring](#every-sheet-names-its-wiring)). `2`: the format with a netlist — the keys below (see [Wiring](#wiring-nodes-levels)). |
| `nodes` | object, list, or `"none"`, optional | The wires the sheet's own device sits on, or `"none"` for a sheet that is not a circuit (see [Wiring](#wiring-nodes-levels)). |
| `levels` | object, optional | The wires the sheet holds, each at the level an expression gives it (see [Held wires](#held-wires-levels)). |
| `elements`, `ports`, `analyses` | optional | Passives and ideal sources, the wires a parent may connect, and small-signal analyses: accepted and shape-checked, not yet read (see [Elements, ports and analyses](#elements-ports-and-analyses)). |

Evaluation runs in one pass: seed the params, compose any children, size the device, evaluate
the equations in order, then run the checks. Everything a check or an equation can reference —
params, child provides, the sized operating point, derived quantities, and physical constants — is a
flat scalar in one shared namespace.

## Earlier key names

A file written with the earlier key names — `bind`, `rows`, `rules` with kinds `invariant`,
`requirement`, `guardrail`, `uses`, `provide`, `edges`, `pin` — still loads: the loader rewrites
them to the current ones, and what it keeps and exports carries the current keys only. A file
that writes one key in both spellings is refused, since the loader cannot know which was meant.
That rewrite belongs to the app's loader: a program that calls the core directly passes an older
document through `inCurrentKeys` first, at each level, and the core itself reads the current
keys alone.

A parameter carrying `solveFor` now needs `min` and `max`, the range it is searched in (see
[Closing a bias loop](#closing-a-bias-loop-solvefor)). An older file whose `solveFor` parameter
has neither still loads and is shown as written; nothing is filled in for it, because a range is
a statement about the circuit only its author can make. Validation refuses it, naming the
parameter and what to add — `solved param "vgs_est" needs finite min < max — they are the range
it is searched in, not slider bounds` — and the sheet does not evaluate until the range is there.

## Parameters

Each entry in `params` is a named scalar input:

| Field | Type | Meaning |
|-|-|-|
| `name` | string | The identifier used in expressions. |
| `value` | number | The current value (SI units). |
| `min`, `max` | number, optional | Bound the GUI slider **and** make the parameter sweepable. On a parameter the engine solves (`solveFor`, `designConstraint`, `hold`) they are instead the range it is searched in, and required. |
| `unit` | string, optional | Display unit. |
| `role` | `"spec"` \| `"choice"`, optional | Groups the parameter (see below). |
| `note` | string, optional | A one-line intent/derivation annotation for the next designer. Renders inline math in `$…$` (see [Inline math](#inline-math-in-prose)). |
| `solveFor` | string, optional | Makes this parameter solved: it names the value the parameter must agree with, closing a bias loop, and the engine searches the parameter between `min` and `max` until the two agree (see [Closing a bias loop](#closing-a-bias-loop-solvefor)). A solved parameter is not sweepable. |
| `hold` | string, optional | Names the quantity that stays fixed where the design is held, and makes this parameter the one re-solved to keep it there. For a node voltage that hangs under a transistor's gate it is the gate voltage, written as the node plus the device's gate-source voltage (see [A node under a gate](#a-node-under-a-gate-hold)); for a current the design point types, it is the balance of the currents that current sets (see [A current the design point chooses](#a-current-the-design-point-chooses)). The parameter stays an ordinary, sweepable input at the design point. |
| `class` | `"independent"` \| `"assumed"`, optional | What kind of DC sizing input this voltage is. `independent`: nothing on the sheet determines it, so the designer states it (a supply, a ground reference, an input common mode, an applied bias, a characterization probe, an output level that a feedback loop outside the sheet holds, a voltage across a device whose surrounding circuit is not on the sheet). `assumed`: the sheet's own parts determine it, but the sheet types a value for now instead of deriving it (an internal stack node, a guessed gate-source drop). An assumed voltage is not a permanent state: it marks a value the sheet still has to derive, and deriving it removes the assumption. Required on every param with unit exactly `V` that a device's bias axes or givens are built from, anywhere in the tree — including params a range end's `set` expressions name — and the `sheet-dc-inputs` rule refuses one without it. The same rule refuses a device whose sizing depends on its own operating point with no `designConstraint` or `solveFor` on the loop. A voltage typed as a literal in an expression is not a param and carries no class. The param that carries a `designConstraint` or `solveFor` is *solved*, and one that carries `hold` is *held*; those classes are derived and never written. Assumed inputs that reach a device are listed with the result of a sheet run. |

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

## The givens (`givens`)

The optional `givens` sizes one device by fixing **exactly two** bound quantities at a chosen
length `L`, and inverting the lookup table for the rest. Every field is an **expression
string**, so a bound quantity can be computed from the params:

```json
{ "L": "L", "gm": "2*pi*GBW_target*CL", "gm_id": "gm_id", "vds": "V_ds" }
```

Here `gm` is fixed from the bandwidth spec and `gm/ID` is the design knob; the drain current
follows from `gm = (gm/ID)·ID`, and the width, `VGS`, and every derived figure of merit fall
out of the table. `vds` is not one of the two: it states the drain voltage the device sits at,
which every sized device does (see [The operating point](#the-operating-point-vds-vsb)).

The bindable quantities do two different jobs:

| group | quantities | what it fixes |
|-|-|-|
| operating point | `gm_id`, `ft`, `gm_gds`, `av0`, `vstar`, `vgs` | where on the curve the device sits |
| size | `gm`, `id`, `W` | how big it is |

An **operating-point** quantity fixes `VGS` on the `L` slice by itself and says nothing about
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

So legal givens are:

- one operating-point quantity + one size quantity — e.g. `ft` + `id`, the classic
  `gm_id` + `id` (the width is sized from the current density), or `W` + `vgs` (a gate tie:
  the width is stated and the gate voltage is imposed).
- two size quantities, which fix the operating point between them: `gm` + `id` fixes
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
`id`, `W`, `vgs`, `vstar`, `cgg`, the intrinsic gain `av0`, the thermal-noise density `vnth_m`
(read from the table's own noise where it stores it; see
[Body effect and noise-model defaults](#body-effect-and-noise-model-defaults)), the stored noise
PSDs `svth`/`svfl`, the flicker corner `fco`, the gm/ID `ceiling`,
and so on — every base and derived quantity the table supports, reported at the **sized
width** (see [The width contract](#the-width-contract)). Equations and checks read these by name.

### The operating point (`vds`, `vsb`)

Sizing inverts `gm/ID` along `vgs`, so every *other* sweep axis of the table must be collapsed
to a single point first. The givens declare that point with a `vds` and an optional `vsb`
expression string:

```json
{ "L": "L", "id": "I_bias", "gm_id": "gm_id", "vds": "0.9", "vsb": "0" }
```

These are **signed to match the table's axis convention** — a PMOS table swept over negative
`vds` takes a negative `vds` declaration.

Declaring the bias matters because it is a real degree of freedom, not a formality. Output
conductance `gds` moves by roughly 4–5× between a low-`vds` cascode point and a mid-supply
point, so an undeclared or wrong bias can silently overstate intrinsic gain by on the order of
13 dB. Declaring `vds`/`vsb` in the givens makes the operating point an authored, persisted,
sweepable part of the design rather than a hidden host-side slice.

If the table has a live axis the givens do not declare, the axis takes its **namespace default**
when the table characterizes that point — `vsb = 0`, source at bulk — and the coordinate is
reported as **assumed**, shown with a `?` beside it in the sizing line. `vds` has no honest
default (it is set by the circuit node, not the device), so **every sized device states its
drain voltage**: as `vds`, or as a diode connection (`diode: true`), which fixes the drain at
the gate. Validation reports givens that state neither, and on any table — one that sweeps
`vds`, one taken at a single drain voltage, one with no `vds` column — leaving it out fails the
sizing with guidance to declare it. A declared value always wins, and a declared value outside
the table's range is clamped to the nearest edge with a warning.

**The table has to carry what the givens use.** A device is sized only from a table that can
answer for every value its givens state: one that sweeps that axis, or one that was taken at
exactly that value. An axis the table does not sweep was taken at one point: the single value
in that column, or `vsb = 0` for a table with no `vsb` column at all (it is read as a
characterization with the source tied to the body). A table with no `vds` column records no
drain voltage, and there is no default. On such an axis:

- a given that states the point the table was taken at is sized there, with nothing said.
  "At" means equal up to float rounding (within 10⁻⁹ V for a bias), so `3.3 - 1.1*3` is a
  source at the body and a microvolt is not;
- a given that states any other value **refuses the device**. So does `diode: true` on a table
  with no `vds` sweep, because the connection is read along the `vds = vgs` diagonal;
- a `vsb` the givens do not state means its default, a source at the body, and is held to the
  same rule. On a table with no `vsb` column, or one taken at `vsb = 0`, the device is sized. On
  a table taken at any other single body bias the sizing fails and asks for `vsb` to be stated
  — so removing a `vsb` line can never turn a refusal into a result;
- a `vds` the givens do not state has no default to fall back on: with neither a `vds` nor
  `diode: true` the device is not sized, here as on a table that sweeps `vds`, and the sizing
  asks for it. So no design sheet sizes a device from a table with no `vds` column — a stated
  `vds` is refused there, and an unstated one is asked for.

`L` follows the same rule on a table taken at a single length. A refusal is a failed sizing,
not a warning beside a result: the device gets no numbers, the sheet does not evaluate on that
table, and the message says which given asks for what, what the table has in place of the
sweep, and what to do — re-export the table with that sweep, or evaluate on a table that has
it. In a composed sheet the message names the block, the other blocks still size, and a sheet
that does not use the missing sweep runs on the same table untouched. What each kind of table
can be used for is set out in the table format:
[What each use needs](mostab-format.md#what-each-use-needs).

**Declare `vsb` whenever the source does not sit at the bulk.** The default is correct for a
common-source device or a rail-referenced mirror, and wrong for every differential pair, cascode
and source follower — where the source floats and body bias is a real, often large, effect. A 5T
OTA's input pair measured **80 mV** of threshold shift against the body-grounded assumption. From
the givens alone the engine cannot tell the cases apart, because they describe a device and not
the wires around it; it reports what it assumed and leaves the judgement to you. That is
deliberately *not* a warning: about nine in ten of the library's sized devices leave `vsb`
undeclared and are right to, and a warning at that hit rate teaches authors to ignore the channel.
A sheet that names its wiring does say where the body is (see [Wiring](#wiring-nodes-levels)): a
body on ground under a source the netlist puts above it, with `vsb` left at 0, is a loop that does
not close, and the wiring check reports it.

A device whose `vsb` depends on its own `VGS` — an input pair standing on a tail node — is a bias
loop, so close it with a solved parameter (see [Closing a bias loop](#closing-a-bias-loop-solvefor)).

### The region (`region`)

A device that must stay in saturation — or a switch that must stay in triode — can say so:

```json
{ "L": "L", "id": "I_bias", "gm_id": "gm_id", "vds": "V_out - V_x", "region": "saturation" }
```

`region` is `"saturation"` or `"triode"`, a word rather than an expression. It adds one check to
the device's own results, with the id `region` and the kind `physical`: `abs(vds) >= vdsat` in
saturation and `abs(vds) <= vdsat` in triode, where `vds` is the drain-source voltage the givens
state — not the value a table that does not reach it was read at; that clamp is reported on its
own — and `vdsat` is the sizing's own. It gates feasibility, has a margin, can be the binding or limiting
check, rides sweeps, and is asked again at every range end and process condition, exactly as an
authored physical check would. The magnitude is compared only where the stated voltage points the
way the table's own `vds` axis does: a negative `vds` on a table whose axis holds no negative
value, or a positive one on a signed-PMOS export, is the device with drain and source the other way
round. The table characterizes no such point, so the check fails, in either region, with a margin
of `-abs(vds)` and the reason. On a table with no `vdsat` column it reads `na`, which a hard check
fails closed on: the design reads infeasible until the table carries the column. Validation
refuses any other word, a `region` beside `diode: true` (the drain is the gate, so the question
does not arise), and an authored check with the id `region` on a device that declares one.

## Equations (`equations`)

Each entry in `equations` is a named author expression — an intermediate `let` or an output —
evaluated in **document order** against the params, the sized operating point, earlier equations,
and constants:

```json
{ "name": "GBW", "expr": "gm/(2*pi*Cout)", "unit": "Hz",
  "note": "single-pole GBW into the total output cap" }
```

An equation that cannot resolve (a missing quantity, a parse error) is skipped with a warning —
graceful degradation for an optional figure of merit. An equation that resolves but evaluates to a
non-finite number from finite inputs (a `sqrt` of a negative headroom, a divide by zero) means
the design math itself broke, so it is an **error** that fails feasibility closed — even if no
hard check happens to reference that equation.

## The expression language

Every expression string — the givens' fields, equations, and both sides of a check — is evaluated by
the same small engine. It works over flat scalars in the sheet's namespace.

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
`gamma` (the thermal-noise factor: at a level that sizes a device, that device's own where its
table carries thermal noise, else the default 1.0; see below). A stored or bound name of the same
spelling shadows a constant, so explicit values win — with one exception: a level that sizes a
device merges everything the sizing publishes into its scope after its params, so a param named
like one of those quantities (`T`, `gamma`, `vds`, …) is overwritten there on a table that
carries it, and validation warns about it (`sheet-collision`); rename the param.

### Body effect and noise-model defaults

Two quantities a sheet reaches for constantly are handled in deliberately different ways, and
the difference is worth stating once.

`gmb` is **data**. It is an optional base quantity like `gds` or `cgg`: present when the table
carries it, absent otherwise. A sheet's own expression that reads it has no fallback: a sheet
that writes `gm + gmb` on a table without a `gmb` column gets a skipped equation and a named
warning, and any hard check reading that equation goes `na`, which fails feasibility closed. That
is on purpose — a `gmb = 0` assumption would make the same sheet compute different physics on
different tables while both looked green, and would show a model zero where the tool promises
data. Wherever the body terminal is not tied to the source, `gmb` belongs in the expression;
write it, and let a table that cannot support the sheet say so. The namespace's thermal-noise
figures read `gmb` too, and they are the one place a fallback is declared, because they have to
resolve on every table: without the column they leave the body-effect term out, and every result
says so (below).

`gamma` is **data where the table has it, and a default where it does not**. It is a named
constant, so it is always in scope. The channel's thermal noise is `Sid = 4*k*T*gamma*(gm+gmb)`:
in saturation its noise conductance is `gm + gmb`, not `gm`. A table that stores its drain
thermal-noise PSD `sth` gives γ at every point, read back through that relation at the table's
own temperature: γ = `sth/(4*k*T*(gm+gmb))`. Every quantity a sized device publishes built on it
then follows the data — `svth_m = 4*k*T*gamma*(gm+gmb)/gm^2`, `vnth_m = sqrt(4*k*T*gamma*(gm+gmb))/gm`,
and an author's own formula written the same way at the level that sizes the device — so on such
a table `vnth_m` equals the measured `vnth = sqrt(sth)/gm` point for point, and the library's
noise rows, which read each device's `vnth_m`, read measured noise without a change to any sheet.
An author's `4*k*T*gamma/gm` leaves the body-effect term out, and reads low by the factor
`1 + gmb/gm` on any table that carries `gmb` (on one without it, γ is itself read against `gm`
alone and the formula is the fallback the γ-model uses there); validation warns about an
expression that reads `gamma` against `gm` with neither `gmb` nor a noise figure
(`sheet-noise-form`). The measured γ is a property of a sized device, so it is in scope
only where one is: an unqualified `gamma` in a parent's row — a level with no device of its own —
is the constant 1.0, and the device's value there is `<block>__gamma`, published by the block. The
current-mirror OTA's `vn_gbw` row wants the input device's own noise, so it reads it by the
block's name, as `in__svth_m*in__gm`: the device's `4*k*T*gamma*(gm+gmb)/gm`. A table that
stores a `gamma` column of its own is read from that column instead, as every stored column wins,
and against `gm + gmb` like the rest: a column built against `gm` alone reads high by
`1 + gmb/gm`, and QA compares it with `sth` where both are stored (`gamma-vs-sth`).
A table with neither gets the default, 1.0. A simulation of sky130 bears the default out for
neither device once the body effect is separated out: at the five-transistor OTA's bias points
the PMOS load reads 0.81 and the NMOS pair 1.63 (1.00 and 1.95 against `gm` alone; see
[tools/verify](../tools/verify/README.md)). The textbook long-channel value 2/3 describes no table
anyone ships here, and for a noise *floor* an optimistic assumption is the dangerous direction. On
the sky130 tables the generator writes, which carry `sth`, the five-transistor OTA's
input-referred thermal density reads about 28 nV/√Hz against 28.24 nV/√Hz simulated, where the
1.0 default reads 25.0 (22.7 with the body effect left out as well).

On a table without `gmb`, γ is read back as `sth/(4*k*T*gm)`, which carries the body factor
`1 + gmb/gm`, and `svth_m` and `vnth_m` are read as `4*k*T*gamma/gm` and `sqrt(4*k*T*gamma/gm)`.
Where the table stores `sth` the two cancel and the figures are still its own noise; where γ is
the default, the floor reads low by `1 + gmb/gm` in power, and a stored `gamma` column gives the
right floor only if it was built against `gm` alone.

Every result says which reading it used. Each sized device's report carries `noise`:
`measured` (γ from `sth`), `column` (the table's own `gamma` column) or `estimated` (the
default), and beside it `fallbacks`: every figure the table made the engine read by a lesser
form, each with the quantity, the missing column, the form used and what that costs — the γ
default among them. The sizing itself (`sizeDevice`) carries the same list, and its sentences in
its warnings. The sheet panel shows the source beside the sizing as "noise: measured" or "noise:
estimated, γ = 1.0", followed by any column a figure fell back for ("noise: measured · no gmb
column: gamma, svth_m, vnth_m"), device by device where they differ, and its tooltip spells each
fallback out. A density computed from the default is an estimate: against measured silicon noise
on comparable topologies, γ = 1.0 closes only about half the gap, so treat it as a lower bound and
set a real target above it.

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

## Checks (`checks`)

Each entry in `checks` is a named comparison `lhs op rhs`, where `lhs` and `rhs` are expression
strings and `op` is `>=`, `<=`, or `==`. The comparison is structured — it is never parsed out
of a string — and each check is evaluated into a **signed margin**: the SI distance to the
bound, positive when the check holds. A relative margin (margin over the bound) lets checks of
different units share one axis on a sweep chart.

| Field | Type | Meaning |
|-|-|-|
| `id` | string | Check identifier (shown in reports and sweeps). |
| `kind` | `"physical"` \| `"spec"` \| `"advisory"` | See below. |
| `lhs`, `rhs` | string | The two expression sides. |
| `op` | `">="` \| `"<="` \| `"=="` | The comparison. |
| `tolPct` | number, optional | Relative tolerance for `==` only (percent of \|rhs\|). |
| `note` | string, optional | The check's physical meaning, for the next designer. |
| `justification` | string, optional | A note explaining a relaxed advisory check. |

### Check kinds

The `kind` decides whether a check **gates feasibility**:

- **`physical`** — a hard physical floor (the design is unphysical if it fails), e.g.
  `gm_id <= ceiling` or a saturation-headroom floor. Gates feasibility.
- **`spec`** — a hard application spec (the design misses its purpose if it fails), e.g.
  an input-noise or offset target. Gates feasibility.
- **`advisory`** — a soft advisory (a near-miss heads-up). It is shown but **never blocks
  feasibility**. A red advisory check on an otherwise-green sheet is by design: the sheet is
  feasible and the advisory check is telling you a soft target is close or missed.

Both physical and spec checks gate; the split is documentation of *why* a check is hard.

### Status and the amber near-miss band

Each check reports one of four statuses:

| Status | Meaning |
|-|-|
| `pass` | Holds with margin. |
| `amber` | Holds, but by less than 5% relative margin (the near-miss margin, see [Solver settings](#solver-settings)) — a near-miss worth a second look. |
| `fail` | Does not hold (negative margin). |
| `na` | A side could not be computed (an undeclared name, an eval error, or a non-finite value). |

`na` is **never a silent pass**: a hard check that reads `na` fails feasibility closed, exactly
as a `fail` would. The 5% amber band applies to `>=`/`<=`; an `==` check is pass/fail only (its
`tolPct` band already defines the acceptable window, so there is no second near-miss band).

### Zero-margin snap and the fix-then-test pitfall

A margin within a tiny relative distance of zero — 1e-5 of the LARGER operand,
`max(|lhs|, |rhs|)` — snaps to exactly 0, and a snapped margin reads `amber` for EVERY
operator, `==` included: an equality sitting a hair outside its tolerance band must
surface as a near-miss, not silently read full pass. Two mechanisms park a check ON its own boundary
by construction. First, a check that tests the very quantity the givens fixed: bind
`gm = 2*pi*GBW_target*CL` and then write `GBW_target*CL*2*pi <= gm`, and the two sides are
algebraically identical, landing within floating-point rounding of the boundary. Second, a check
evaluated AT a claimed range end: the design constraint's solve lands `CM_in` within its landing
tolerance (10⁻⁶ of its stated range's span, stretched by the relation's slope — microvolts on a
volt-scale node) of the very value `cm-not-below` compares it against. Without the snap either verdict would
coin-flip; with it, both read as a deterministic `amber`. The threshold sits two orders below the
~0.1% the sizer resolves between grid nodes, so a check "failing" by less than the data can
distinguish is read for what it is: sitting on the boundary.

A bound **operating-point** quantity (`gm_id`, `ft`, `gm_gds`, `av0`, `vstar`) reads back as
exactly the value you asked for, so a check restating it behaves the same way. Be aware of what
that number means: the operating point is recovered by inverting a curve sampled at the `VGS`
grid nodes, while the rest of the point is interpolated from the raw columns and re-derived.
Between nodes those two routes differ — by around 0.1% for a ratio on a 10 mV grid — so the
sized device sits that far from the target, well inside the data's own resolution but not at
it exactly. If that margin matters for your design, characterize on a finer `VGS` step.

A bound `vgs` is the exception: it is read back as the coordinate the table was actually read
at, which is the value you asked for unless it fell outside the swept range and was clamped —
and then the clamped value is the honest one, since it is the point every other quantity beside
it came from. There is no inversion residual to repair, because there was no inversion.

The lesson is to **test a derived quantity, not the input the givens fixed.** Binding `gm` from a
target GBW and then checking `GBW >= GBW_target` is a tautology that always reads amber. Instead,
compute the *actual* GBW from the sized device — including the gate capacitance the givens did
not know about — and check that:

```json
{ "name": "Cout", "expr": "cgg + CL" },
{ "name": "GBW",  "expr": "gm/(2*pi*Cout)" }
```

Now the `GBW >= GBW_target` advisory check is meaningful: it fails by exactly the amount the sized
`cgg` loads the output, which is a real design fact the given value hid.

## Feasibility

A sheet is **feasible** only when all of the following hold (it fails closed otherwise):

- declared givens sized successfully, and the sizer's own verdict (`gm/ID` at or below the
  data `ceiling`) held;
- every **hard** check (physical and spec) is `pass` or `amber`;
- every composed child is feasible;
- no error-severity warning was raised (including structural validation errors).

Advisory checks are excluded from this aggregate. A sheet with no givens and no children is feasible
whenever its hard checks hold. Nothing that happens at an end of the sheet's operating range
enters it: that is compliance, a separate answer (see [The operating
range](#the-operating-range-operatingrange)).

## The width contract

Every quantity the sheet reports describes the **sized** device, not the characterization-width
artifact. When the givens size a device to width `W`, the extensive quantities — `id`, `gm`,
`gds`, the capacitances, the terminal charges, the noise PSDs, `w` — are rescaled from the
characterization width `w0` to `W` (the parallel-composition model: the sized device is `W/w0`
unit devices in parallel), and the derived layer (`av0`, `ft`, `vstar`, input-referred noise, …) is
re-evaluated from those scaled bases. So author math like `gm/(2*pi*cgg)` reads the device you
actually sized.

The one exception: a quantity from an **unknown pass-through column** (a header the importer
did not recognize) is *not* rescaled, because its width law is unknowable — it stays at `w0`.
The characterization width is exposed as `w0`, so if you need to refer such a column to the
sized width you can scale it yourself with `w0/W` (or `W/w0`). Each sized device's report lists
the pass-through columns it read (`passthrough`), so a result says which of its numbers are at
`w0`; the panel shows them beside the noise line.

A pass-through column is read under its lower-cased header, in the sheet's own equations and
checks and in its `provides`, like any quantity of the sized device. It never takes a name the
sheet already uses, and is never overwritten by one: a column named like a param, an equation, a
child's provide, an expression constant (`k`, `q`, `pi`, `eps`) or a scalar the sizing writes
(`w0`, `ceiling`, `feasible`) is read under its **affixed name**, `table__<name>` — the same
double-underscore join a sheet reads a child's quantity by, with the table in the child's place
— and a `sheet-passthrough` warning names it:

    the table's "k" column is read as "table__k": "k" is an expression constant, which keeps its meaning

The sheet's meaning of the name stands, and the column stays readable as `table__k`. A column
whose name collides with nothing keeps its plain name. Constants and the sizing's own scalars
are the engine's names wherever a table is read, so a column named like one of them is
`table__<name>` in a lookup, a sizing report and a chart expression as well; a column named like
a param or an equation is affixed only in the sheet that uses the name. Only where the affixed
name is taken too (a param called `table__k`) is the column left out of scope, and the warning
says so. Each sizing's `passthrough` list, and the panel's "at w0, not scaled" line, give the
names the sheet reads the columns by. A block may not be named `table` (validation refuses it):
its provides would read `table__<name>` too.

## Composition

A sheet composes children through `blocks`. Each child is either a full sheet embedded inline
(`doc`) or a **reference** to a library sheet (`ref` — see [References](#references)), and it
exposes named scalars to the parent through its `provides`.

| Field | Type | Meaning |
|-|-|-|
| `name` | string | The child's handle in the parent (used in the join, below). Must not contain `__`, and may not be `table`: a table column the sheet cannot read under its own name is read as `table__<name>` (see [The width contract](#the-width-contract)). |
| `doc` | object | The embedded child sheet. |
| `ref` | string | A library-sheet id to include by reference (resolved before evaluation). A block needs `doc` or `ref`; carrying **both** is an already-resolved snapshot — the embedded copy wins and the ref remains as provenance. |
| `device` | string, optional | The device the child sizes against; absent ⇒ the child inherits its parent's. What the string must look like depends on who evaluates the sheet — see [Naming a block's device](#naming-a-blocks-device). |
| `params` | object, optional | Overrides of the child's param values, each an expression evaluated in the **parent** scope. |
| `nodes` | object or list, optional | The wires, in this sheet's namespace, that the child's device sits on (see [Naming the wires](#naming-the-wires-nodes)). Format version 2. |
| `ports` | object, optional | How the child's declared ports connect to this sheet's wires (see [Elements, ports and analyses](#elements-ports-and-analyses)). Every port a child that wires itself declares is mapped here, and the sheet composing such a child states wiring (see [Naming the wires](#naming-the-wires-nodes)). Format version 2. |

A child's provided scalars surface in the parent namespace as flat names `name__key` (the
engine has no member access, so `child.key` cannot parse — the join is a `__` separator).
Neither the block `name` nor a provided key may contain `__`, with one exception: a child may
re-export one of *its* children's provides (a name like `s1__Cin`) up the tree, so a deep
quantity can surface at the top. The parent references these joined scalars and writes its own
author math over them. The values that cross a block boundary are scalars; which wires a child's
device sits on is a separate, checked statement (see [Wiring](#wiring-nodes-levels)). A child
that wires itself is connected through its block's `ports` by a sheet that states wiring of its
own; a sheet that states none, or declares `"nodes": "none"`, is refused for composing one.

**Document-order evaluation.** Children evaluate in the order they are listed, and each is
evaluated *before* the parent's own givens. Two consequences:

- A parent can reference a child's provides anywhere — including in its own `givens` (e.g. a
  cascode device carrying the input pair's `cs__id`).
- A child's param override can reference the provides of **earlier** siblings (a later branch
  carrying a current an earlier branch derived), but a forward reference — to a later sibling,
  or to the parent's own not-yet-sized device — **fails closed** as undeclared.

**Fail-closed overrides.** A param override is the parent explicitly supplying a value, so one
that does not resolve to a finite number is an error (it does not fall back to the child's
default — that would size a different design than authored). A child that errors or reads
infeasible drags the parent's feasibility down, and its warnings roll up attributed to its
block. Composition is depth-capped at 8.

### Naming a block's device

A block's `device` is looked up when the sheet is evaluated, by whoever evaluates it, and the two
places a sheet runs read the string differently.

**From a script**, `runSheet` and the sweeps take a resolver, `(id) => DeviceTable | undefined`,
and the string is whatever key that resolver answers to: `"pmos"`, a file name, anything (see the
README's *Scripting the core*).

**In the app**, the string must name a device that is loaded, in one of two forms:

- **`family:` followed by the device's identity** — what the app writes when you pick a device
  from a block's menu, and the form to write by hand. The identity is a JSON array of the
  table's process namespace, device name and polarity: the `# pdk:` and `# device:` headers
  trimmed and lower-cased (`""` for a table that declares no `pdk`), and `"n"`, `"p"`, or
  `"unknown"` for a table that declares no polarity. It is matched as text, so write it exactly
  as `JSON.stringify` would — no spaces:

  ```json
  { "name": "ld2", "ref": "multistage/stage2-current-source-load",
    "device": "family:[\"sky130a\",\"pch\",\"p\"]" }
  ```

  This names the device at every corner and temperature loaded for it, so the block follows the
  condition the sheet is asked at.
- **A loaded table's own id** — the form documents saved by earlier versions of the app carry.
  It is still read, and shown as *stored by table*, but it includes a hash of the table's
  contents, so it is not something to write by hand.

Any other string — a free key such as `"pmos"` that runs from a script — names nothing the app
knows. The sheet is not evaluated: it reports that the block names a device that is not loaded,
and the block's menu, where it has one (below), shows the binding as *(not loaded)*. Picking a
device from the menu rewrites the binding in the `family:` form.

**Which blocks the menu can rebind.** Every block whose entry is part of the open sheet has a
device menu, at any depth, including a block nested inside another embedded block. Left unset, a
block inherits its parent's device: the active device for a block on the sheet itself, the
enclosing block's device for one nested inside another — so rebinding a block moves every
descendant that names no device of its own. A block **inside a by-reference child** belongs to the
library sheet that child points at, like the rest of that sheet's internals, and has no menu: to
rebind it, detach the reference (the referenced block itself can always be rebound, because its
binding is part of the sheet that includes it).

### References

Instead of embedding a child, a block may point at a sheet in the **library** — the curated
sheets bundled with the app plus any sheet you have imported (a `.json` loaded through the
same control as a CSV table; imported sheets persist across reloads and appear in the picker
under *Your sheets*):

```json
{ "name": "ld2", "ref": "multistage/stage2-current-source-load",
  "params": { "Wx": "K2*bias__W", "vgsx": "bias__vgs", "Lx": "L_tail", "vx": "V_out2" },
  "ports": { "out": "out", "vb": "vbn" } }
```

Here the two-stage Miller OTA composes its second-stage load as a mirror output of its bias
diode: the load takes the reference's width times the ratio `K2` and the reference's
gate-source voltage, its gate port sits on the reference's gate wire `vbn`, and the current it
delivers at the output level sets the second stage's current.

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
per-child form when authoring. In format version 2, mark such a param `"convention": "axis-sign"`:
the wiring check then reads it as the table's axis direction where it multiplies a whole bias
axis, and holds its value to the table each device using it is sized on (see
[What the check reports](#what-the-check-reports)).

### Port contracts

A library sheet declares its interface the way a datasheet does: the small-signal quantities
a neighboring stage would need are ordinary equations with reserved names, and the sheet's
top-level `provides` lists them. There is no schema field and no engine machinery — the
contract is a naming convention plus the declaration.

- **`Rout`** — the output resistance at the sheet's output node, written as the inverse of
  the very denominator the sheet's own gain equation uses, so the output node has exactly one
  definition (a one-stage sheet's `Av` is a transconductance times `Rout`; in a two-stage
  sheet `Rout` is the output stage's node and `Av2` is the equation that reads through it).
- **`Rin`** — the input resistance, only where the input is genuinely low-impedance (a
  common-gate stage). A gate input gets no `Rin`.
- **`cgg_in`** — the capacitance a driver sees, per input terminal, taken as the input
  device's total gate capacitance. An estimate that says so in its note, and which way it
  errs depends on the stage: on an inverting stage the Miller term needs the gate–drain
  fraction these tables do not carry, so the number is a lower bound; where the source
  follows the gate (a follower's bootstrapped input) it is instead an over-estimate. Each
  sheet's note states its direction — and `cgg_in` never appears in a hard check.
- **`Ron`** — a switch's on-resistance, where that is the interface.
- **`I_q`** — the quiescent supply current as the sheet's own equations model the topology, which
  is the datasheet line one design is compared against another by. Estimate-grade like
  `cgg_in`: the note says which branches are counted (and, where the realization could differ
  — a pseudo-differential copy, a common mode that shuts one pair off — which reading it is),
  and it never appears in a check. A sheet whose supply current is the designer's knob rather
  than a consequence publishes that PARAMETER under the name instead of adding an equation; the
  quantity has one definition either way.

Loading expectations follow one rule: **state the claim on a quantity the sheet actually
owns.** A sheet that models its load (a drain resistor, a `gds_load_est`) already folds
loading into its gain arithmetic — the arithmetic is the contract, and no extra check is
added. A buffer whose approximation depends on a load regime writes an advisory check on its own
load parameter (the source follower's `R_L >= 10*Rout`; ten-to-one keeps the loaded gain
within about ten percent of intrinsic — a convention, not physics). A sheet that models no
resistive load says so in its `Rout` note ("The gain assumes a capacitive load"). The
cross-stage check belongs to the **composing parent**, which is the only place that sees
both sides of a port: the interstage pole `1/(2*pi*s1__Rout*s2__cgg_in)` is one
author-written equation away, and `s2__Rin >= 10*s1__Rout` one advisory check.

The `sheet-provide-coverage` warning polices both directions of the contract. Upward, every
`child__key` an expression reads must appear in that child's `provides` — a missing
entry degrades at runtime exactly like absent data, so the validator names the slip
statically, and a prefix naming no child at all is reported as the typo it is. A
reference-only child is skipped (its provides are unknown until resolution, and the
resolved document is validated again). Downward, a `provides` key on any block without its
own `givens` — the top level or an embedded child alike — must name a param or an equation of that
block; a block with `givens` is instead taken at its word, because a sized device publishes every
table quantity including pass-through columns no table-independent check can enumerate.
Re-export keys carry the `__` separator and are ruled on where the parent declares the block
instead.

## Wiring (`nodes`, `levels`)

The givens state each device's own operating point — the drain and body voltages it is sized at
— and nothing about which wire each terminal sits on. So a sheet can size two devices on one gate
wire at two different gate voltages, write an inverter whose two gate voltages do not add up to
the supply, or let one drawn device stand for two that sit at different drain voltages, with
every check green. A sheet in format version 2 names its wiring: which wire each terminal of each
sized device sits on, and which wires the sheet holds. The engine then checks, after sizing, that
the voltages and currents those names imply agree with each other.

The wiring is a **netlist of identities**. A wire's name says which terminals share it; a wire's
level is never written beside it. Levels are *held* (supplies, references, inputs, a bias the
application applies — listed in `levels`) or *derived*, for checking, from the devices on the wire.
Nothing the check derives is fed back into the design: the sizing is exactly what it would be
without the netlist, except that a diode connection the wires state is sized as one.

### The format version (`formatVersion`)

| `formatVersion` | read as |
|-|-|
| absent | the earlier format. It is read, but it can name no wires, so a sized device in it is refused with the migration message (see [Every sheet names its wiring](#every-sheet-names-its-wiring)); a diode is `diode: true`; every key of format 2 is refused by name, with the fix — add `"formatVersion": 2`; and `wiring` is not read |
| `2` | the format with a netlist: `nodes`, `levels`, `elements`, `ports`, `analyses`, and a param's `convention` |
| any other value | a format this app does not read. Importing it is refused — the document, or a sheet with a child embedded in that format — with a message naming its version, the versions this app reads, and the block of a child. A copy already stored is kept exactly as it was stored — not rebuilt key by key, which would drop what the newer format added — and opens with that message, not evaluated |

The version belongs to a document. An embedded child states its own, and one that states none is
read in the earlier format — so a library sheet written before the netlist composes into a new
sheet unchanged, its device wired by the `nodes` of the block that composes it.

A key of format version 2 is read only in a document of format version 2. In a document with no
version, where validation refuses it, nothing reads it: its device is not sized as a diode by its
wires, its levels hold nothing, and its wiring check does not run — the report says the document's
wiring keys were not read (`not-evaluated`). A block's `nodes` and `ports` belong to the document
that composes the block, and are read where that document is in format version 2.

A block's `wiring` — the gate and source declaration documents carried before the netlist — is read
by no format. A block that still carries one is refused in either format, by name, with the
migration: the wires a block's device sits on are its `nodes` in format version 2, which a script
can draft from the givens (see [The wiring proposal](#the-wiring-proposal)). A loader that rebuilds
a document keeps a block's `wiring` as stored rather than dropping it, so a restored copy opens with
that message and an import that carries one is refused saying what to write instead.

### Naming the wires (`nodes`)

A device sits on four wires, named in one **placement** — drain, gate, source and body:

```json
"nodes": { "d": "out", "g": "in", "s": "gnd", "b": "gnd" }
```

On a sheet that sizes a device, `nodes` names the wires of that sheet's own device. A child that
does not wire itself — a single device, typically — is wired by the block that composes it, in the
parent's namespace; the parent is the one that knows what it connected the child to:

```json
{ "name": "p", "doc": { }, "params": { }, "nodes": { "d": "out", "g": "in", "s": "vdd", "b": "vdd" } }
```

A child that **wires itself** — its own `nodes`, `levels`, elements, or blocks it wires — declares
the wires a parent may connect in `ports`, and the parent connects it through the block's `ports`
map, every declared port to one of its own wires or to `null` for one left open:

```json
{ "name": "ld2", "ref": "multistage/stage2-current-source-load",
  "params": { "Wx": "K2*bias__W", "vgsx": "bias__vgs", "vx": "V_out2" },
  "ports": { "out": "out", "vb": "vbn" } }
```

The load takes the bias reference's width times the ratio and its gate-source voltage, so it is
a mirror output of that reference, and the current it delivers sets the second stage's current.
The child's wiring then joins the parent's check as one netlist: a mapped port **is** the parent
wire it is mapped to, so the child's devices meet the parent's there — the load's gate on the
reference's gate wire `vbn` — and every other wire of the child is its own, spelt `ld2__w` (a
port mapped to `null` is `ld2__vb`, connected to nothing in the parent). `gnd` is the same wire
everywhere. A child's levels hold the wires they name — through the map, a parent's — and a
parent's override of a child param is read where the parent writes it. The child runs no check
of its own; only the top of a tree runs one, and it covers every child that wires itself. A block
carries `nodes` or `ports`, never both.

**A sheet that composes a child that wires itself states wiring itself** and maps every port the
child declares. For a sheet whose only wiring is that connection, an empty map, `{}`, connects a
child that declares no ports. A sheet that states no
wiring — one made only of blocks, with no device, levels or block wiring of its own — or that
declares `"nodes": "none"` is refused when it composes such a child: the child's ports would be
connected to nothing, and `"none"` would be false of a sheet that contains a circuit. The refusal
names the block and the ports left unmapped:

    block "ld2": the child states wiring and this sheet states none, so the child's wiring would be checked against nothing — a child's wiring is checked as part of its parent's: connect it through the block's ports, mapping its ports "out", "vb" to wires here (or to null for one left open)

A child composed by reference is judged once the reference is resolved: `runSheet` and the
condition runs validate the resolved document, so the refusal reaches every run, while
validating the unresolved document alone cannot see the child and says nothing about it.

- A wire is an identifier — letters, digits and `_`, without the `__` that joins a child's names to
  its block. `gnd` is the reference at 0 V; every other wire is an ordinary name.
- **The gate on the drain wire is a diode connection.** `g == d` reads the device's table along its
  vds = vgs diagonal before sizing, exactly as `diode: true` does, and adds no constraint of its
  own. A sheet need not say `diode: true` as well; one that does must agree with its wires, and
  `diode: false` beside `g == d`, `diode: true` beside a gate on another wire, and a stated `vds`
  beside `g == d` are each refused.
- **The gate on the source wire** holds vgs at 0 — a device that is off. It is a real constraint,
  not a missing one, and is warned about as an accidental short unless the placement says
  `"intent": "off"`.
- **The drain on the source wire** shorts the device and is refused.
- **A wire joins two terminals or more**, or is held in `levels`, or is a port. A wire one terminal
  names is refused: a misspelt name is the usual cause.
- **A wire only gates touch** draws no current and nothing on the sheet sets its level — the check
  would read it off one gate's `vgs` and call it clean. It is warned about unless it is held or a
  port: hold it, make it a port, or wire the device that drives it (a diode, a bias device).

A **list of placements** places one sizing several times — the two halves of a balanced pair
written once. One sizing is one operating point, so a list may not mix diode-connected and other
placements, and after the check every placement must sit at the same gate, drain and body voltage
within 10 mV. A list whose placements sit at different voltages is raised; one with a placement on
a wire that has no trusted level is recorded as not shown to share a point — the loop that left the
wire untrusted is what is raised. A mirror's
reference and output differ in drain voltage: they are two blocks, tied by `W: "K*ref__W"` and
`vgs: "ref__vgs"`.

A sheet that is not a circuit — an abstract budget, a block-level estimate — says so with
`"nodes": "none"`. It carries no wiring at all: no `levels`, `elements` or `analyses`, and no
block `nodes`.

### Held wires (`levels`)

```json
"levels": { "vdd": "VDD", "in": "CM_dc", "vbn": "V_a + casc_n__vgs" }
```

A held wire is one the designer states. Its level reads only numbers and params classed
`independent`, and its dependencies cross nothing — no device quantity, no equation, no solved
relation. Each way a level can fail that is refused by name:

| the level reads | result |
|-|-|
| a number, or params classed `independent` | held |
| a param the engine solves (`V_tail` under a design constraint) | refused — what a solve sets is derived |
| a param classed `assumed` | refused — a typed guess held fixed becomes a fact |
| a param with no class | refused — say whether it is independent |
| a param a parent overrides from a device's quantity (`bias: "earlier__vgs"`) | refused — a level derived from a device is never held, however the path ends |
| an equation | refused |
| the node under a gate a `hold` re-solves (`V_a`) | refused — that wire is derived; hold the gate's wire instead |
| exactly the `hold` expression of such a node (`V_a + casc_n__vgs`) | held: the gate's wire, at the level the hold keeps fixed |

The last row is what `hold` already does (see [A node under a gate](#a-node-under-a-gate-hold)):
where the design is held, the gate is kept at the value its hold expression took at the design
point and the node under it is re-solved. Written as the hold itself, the gate's wire is held at a
level derived at the design point; the node under it stays derived. It holds only a gate wire of
the device whose `vgs` the hold reads — `"vbn": "V_a + casc_n__vgs"` where `casc_n`'s gate is on
`vbn`, or each gate wire of a pair placed twice on the node — and is refused on any other wire. A hold that balances two currents holds no wire. `gnd`
is 0 and is not listed.

### What the check reports

After the sheet is evaluated, every placement states three relations — its gate, drain and body
voltage above its source, as the physical voltages its sizing and givens stand for — and every
held wire one more: its level above a virtual reference. Kirchhoff's voltage law says those
statements must agree around every loop they close. The check finds the loops, reports how far
each misses, and derives every other wire's level from the held ones. It states the laws and
propagates what they determine in one pass; it never solves for a value that would make them hold.

- **Blocks and loops.** The relations split into blocks — the parts that stay connected when any
  one wire is removed; the split is unique, so it depends on nothing but the netlist. In each
  block a spanning tree is grown from the block's first held wire (by name), taking relations in a
  fixed canonical order — the two wires, the kind, then the device and terminal pair — so the
  verdict never depends on the order anything was written in. Each relation the tree leaves out
  closes a loop, and its **residual** is that loop's misfit, in volts.
- **Closes, or does not.** A block closes when every residual is within 10 mV (the loop-closure
  tolerance, see [Solver settings](#solver-settings)) — the resolution bias plans are written to.
  Its **closure error** is its largest residual. That is all the
  closure error is: the largest misfit of a loop in this canonical basis. It is not an uncertainty
  on any level. A path through several loops can add their misfits, so inside a block that closes,
  a level read along another path can differ by more than 10 mV; each derived level is reported
  with the relations it was derived along.
- **Levels.** A held wire is always reported at the level it is held at. Every other wire is
  derived from the first held wire (by name) that reaches it through blocks that close. A wire a
  held wire reaches only through a block that does not close is **tainted** and given no value; a
  group of wires no held wire reaches at all **floats** — one missing statement.
- **Currents.** At every wire a drain or source terminal sits on, the check sums the currents
  flowing into the wire — an n device draws its current in at the drain and returns it at the
  source, a p device the other way, and an element as below — and reports the signed sum. One
  terminal alone on a wire is its whole current: a device whose current has nowhere to go. At a
  wire nothing holds, a sum past 0.1 % of the largest current there (the current-balance
  tolerance; below it is what interpolation between table nodes cannot resolve) is raised: a
  current with nowhere to go, or one current given to two
  devices, as when one drawn input transistor carries half a tail current whose other half no device
  draws. At a held wire the sum is what the ideal source holding it supplies. Where currents arrive
  and leave — an output the application holds — a sum past 0.1 % is raised as "an ideal source
  supplies X A": the devices do not agree on the current there, and holding the wire hides it.
  Where every current flows the same way — a supply rail, ground — the sum is the supply current,
  reported and not raised. A port of the sheet the check runs on is not summed; its other end is
  outside.
- **Constraints, counted by rank.** Each loop is also an equation over params and device
  quantities. An equation that reduces to zero (two relations saying the same thing, as a diode's
  gate and drain relations do, or a mirror given its reference's `vgs`) is an identity and is
  dropped. One that merely holds at this design point is kept and reported as satisfied: it holds
  because something makes it hold — a solve, a tuned value — and may stop. Two counts are reported
  and never merged: **proven**, the rank of the equations that are linear in params and device
  quantities, and **bound**, the rank of them all. "Over-determined by K" is stated only from the
  proven count; where bound exceeds it, the terms the count could not read are named. Each
  constraint is resolved by giving a device on a shared gate wire the other's `vgs`, by solving the
  node with a `designConstraint` or `solveFor`, or by keeping it as an explicit check.
- **Signs.** A p device's voltages on a table in N-style convention are magnitudes, and the check
  maps them to physical differences through the device's polarity and the table's axis direction.
  A param that multiplies a whole bias axis to follow the table's convention (`p_sign*(VDD -
  V_out)`) is read as the axis direction only where it is declared `"convention": "axis-sign"`; its
  value must then be exactly +1 or -1, must equal the axis direction of every table a device using
  it is sized on, and must appear in a bias-axis expression. An undeclared param that happens to
  equal 1 is never read as one. A declared selector is held to its table wherever it is read — on a
  sheet that declares `"nodes": "none"` too, and through a block whose device its parent reads. The
  body's direction is read from the table's own vsb axis: where
  it holds no negative value it is a magnitude — the body above the source for a p device, below it
  for an n one — whatever the gate and drain axes do (a signed p export can store vgs and vds
  negative and vsb positive); a vsb axis with negative values follows the gate axis.

Each loop that does not close, each floating group (one that reaches a port is connected outside
and is not raised), each relation the check could not form (a device that did not size), each
current imbalance and each placement list at different voltages is a `sheet-nodes` **warning**, giving both claims of a failing loop with what each was read
along. Voltages are quoted in volts and currents with an SI prefix (`10 µA`). A warning never changes feasibility, and nothing is repaired: which of the two statements
is not the circuit is the author's to say. The problems with the netlist itself — a misspelt wire,
a short, a level that may not be held, a flag the wires contradict, a selector the table
contradicts — are errors.

The result carries the check as `nodes`: `state` (`checked-clean`, `checked-with-findings`,
`not-applicable` for `"nodes": "none"`, or `not-evaluated`, below), every derived level with its
path, the tainted and floating wires, each block that did not close with its residuals, the rank
counts and their constraints, every current sum, and the placement verdicts. A composed child whose
wiring joins its parent's is covered by the parent's report; one that runs its own check (its parent
names no wiring) carries it on its block's report. Each range end's report carries its own run's
check the same way.

**The check runs once, on the settled design, and only where the sizing stood.** Every sheet's
wiring in a composed tree — a child that runs its own check included — is read once the whole tree
has settled, never at a solver's intermediate probe. And the check reads a sized design, so where a
point has none it does not run: a run that did not stand (a solve that did not land, a device that
did not size), or a range end or another process condition whose held run read a device off its
table's hull or did not complete (see [The operating range](#the-operating-range-operatingrange)) —
the same reason a block that did not size is skipped. Its report, and the report of every child in
the tree that would have run its own check, is `not-evaluated`, with no levels and no findings:
neither clean nor with findings, and nothing it would have read is reported as a wiring problem. A
design sized under an assumed level was sized: it is checked, although its compliance points have
no answer.

### Elements, ports and analyses

An element sits between two wires:

```json
"elements": [{ "name": "Iref", "kind": "I", "between": ["vdd", "bias_d"], "value": "I_tail" }]
```

`name` is an identifier, unique in the sheet; `kind` is `R`, `C`, `I` or `V`; `between` is
`[from, to]`; `value` is a number or an expression. One convention covers every kind:

- **Current flows from `between[0]` to `between[1]` inside the element** — it leaves the `from`
  wire and arrives at the `to` wire. So the element above takes `I_tail` out of the supply and
  delivers it into the diode's drain — the shape a programmed reference current is drawn in, which
  balances the diode's drain current at `bias_d`. A negative value is a current the other way.
- **Voltage is read from `between[0]` to `between[1]`**: a `V` element states V(from) − V(to) =
  value. A floating battery — a level shift between two wires, neither of them held — is a `V`
  element between them, written with `from` on the higher wire for a positive value: `"between":
  ["vg_p", "vg_n"], "value": "V_shift"` states that `vg_p` sits `V_shift` above `vg_n`.

How each kind is counted:

| kind | in the check |
|-|-|
| `I` | an ideal current source: its value, signed by the convention above — taken out of the `from` wire's sum and added to the `to` wire's |
| `V` | a relation like a placement's, V(from) − V(to) = value, in the loops; a loop through it that does not close is reported like any other. Its current is whatever the circuit needs, so the sums at its two wires are what it supplies: reported, and never raised as an imbalance |
| `R` | its current, (V(from) − V(to)) / R from `from` to `to`, where the check gives both ends a trusted level (one derived through blocks that close); otherwise its current is unknown, its wires are not summed, and a note says so. R > 0 |
| `C` | nothing at DC. C ≥ 0 |

An element's value written as an expression may read params classed `independent` or `assumed`
and equations of them, never a device quantity, a solved relation or an analysis.

`ports` are the wires a parent may connect (see [Naming the wires](#naming-the-wires-nodes)): a port
is never reported as floating, and a port of the sheet the check runs on is not summed. `analyses`
(small-signal gain, impedance and noise asked for by name) are accepted and shape-checked, and not
yet evaluated.

### The wiring proposal

Writing the netlist for a sheet that predates it starts from a draft, made by three functions of the
core that a script calls — the app has no control for them (see "Scripting the core" in the
README). `proposeWiring(doc)` reads the sheet's givens, overrides and holds and drafts each device's
four wires and the held levels; `formatWiringProposal` prints the draft for an author to read, and
`applyWiringProposal` writes it into a format-version-2 copy — the input is untouched — which the
author confirms or corrects and then imports. The draft is read from the givens alone; a block's
earlier `wiring` is not read, and the copy drops it, with a note saying so. Each wire is marked:

- **certain** — only a diode connection: `diode: true` asserted a physical connection;
- **inferred** — a shared `vgs` read as a shared gate and source, a body at its source's level (`vsb` left at 0), two terminals written at the same level (`vds = V_out -
  V_tail` puts the drain on `V_out`'s wire and the source on `V_tail`'s), a gate one gate-source
  voltage from its source, a gate a `hold` keeps fixed. The same level is not the same wire, so
  every inferred join is a proposal to confirm;
- **unknown** — a terminal nothing places, given a fresh name to confirm or replace.

The draft reads a drain voltage as a level only where it says one: a difference of two levels
places both ends; one value places the drain when it is a bare name or a number — over ground, or
above the source an n device's `vsb` places (an n device's `vsb`, read whole, is its source's level
over a grounded body); any other single expression (`VDD - V_in + vgs_est`) places nothing and is
noted. Where it holds an output the application holds — a wire where currents arrive and leave — it
notes that the check will report the current there. A hold on the node under a gate drafts that
gate's wire held at the hold expression, for a block's device and for the sheet's own alike.

A wire the draft leaves with one terminal would be a misspelt name to validation, so each is made
something: held at the level the draft placed it at — a number, or the drain or body voltage that
placed it — where that level may be held, and otherwise a port of the top sheet (`ports`), the wire
a parent or the application connects; a note says which and why. On a sheet below the top, a port
would need its parent block's port map too, so the wire is left to the author with a note. A child
that wires itself is connected through its ports, which the draft leaves to the author.

### Every sheet names its wiring

A sheet either names the wires every sized device sits on, or declares `"nodes": "none"`. There is
no third state in which wiring is simply not checked: a sheet that does neither is refused — a
validation error, so it is never evaluated as a design — with the devices it leaves unwired named.
The same holds a level up: a sheet that composes a child that wires itself states wiring itself
and maps the child's ports, and one that states none, or declares `"nodes": "none"`, is refused
with the block and its unmapped ports named (see [Naming the wires](#naming-the-wires-nodes)). A
child's wiring is checked only inside its parent's, so without that the child's ports would be
checked against nothing.

**What the earlier format now means.** A document with no format version is still read, but it
cannot name a wire, so a sized device in one is refused by this rule until the document is
migrated: the refusal says so and names the two functions a script calls to draft the migration
from the givens — `proposeWiring`, then `applyWiringProposal` for the format-version-2 copy to
confirm (see [The wiring proposal](#the-wiring-proposal)). A block's earlier `wiring` is not read in
any format. An earlier-format child composed into a
format-version-2 sheet is not refused: the block that composes it names its device's wires.

## Closing a bias loop (`solveFor`)

Children evaluate in document order and may only read *earlier* siblings, so the composition is
acyclic by construction. Real circuits are not — but before reaching for the solver, check
whether the loop is real. Most in this library were **parameterization artifacts**: the 5T OTA's
famous cycle (the pair's `VGS` sets the tail node it stands on) vanishes entirely when the tail
node is the declared variable, and a spec like the common mode enters through a `designConstraint` instead.
That is how a spec that drives an internal node is solved wherever the node's search range can be
stated as fixed numbers, as a tail node's can. A node that hangs under a gate whose bias the sheet
does not provide is stated at the design point and re-solved wherever the design is held, with a
`hold` (below). No sheet in the library types a voltage that its own parts determine; a sheet of
your own that still does labels it `assumed`, and it is listed with each result.

`solveFor` remains for the loops that survive reparameterization: a quantity defined in terms of
the device's *own* answer. One live example is the wide-swing mirror's reference node — a real
wide-swing bias generator parks the reference device's drain at its own `vdsat` plus a margin,
and that `vdsat` is only known once the device is sized at that very node:

```json
{ "name": "vds_lo", "value": 0.3, "min": 0, "max": 1.8, "unit": "V", "role": "choice",
  "solveFor": "wideswing_node",
  "note": "the reference node, solved to the reference device's own vdsat + node_margin" }
```

The target is any name resolvable in this sheet's namespace once its body has run — an equation (as
here, `wideswing_node = ref__vdsat + node_margin`), a child's provided scalar, or the sheet's own
sized operating point. The source follower is a second live example: its drain-source voltage is
`VDD - V_in + vgs_est`, and `vgs_est` solves for the device's own `vgs`. It does not put a design
constraint on its output node instead, because that node's valid range moves with the supply and a
search range is fixed numbers that cannot follow it, while a gate-source voltage stays between the
threshold region and the supply. The current-mirror OTA
is a third, with a child's provided scalar as the target: a PMOS mirror output
device has its drain on the node of an NMOS diode, the current it delivers there is the diode's,
and the diode's gate-source voltage at that current is the node, so `V_nmir` solves for
`nmir__vgs`. (The 5T OTA and the two-stage OTAs state the share of the tail current their
input pair's output-side transistor carries as a design constraint rather than a solved
parameter: the current law at the output node, the output-side transistor's current equal to
the load's.) The cascode current mirror solves the node between its output
device and the cascode above it, as a multiple of the reference device's gate-source voltage
(`k_x` solves for `k_casc`), so the two devices in series carry one current. The wide-swing
mirror solves its output-branch node the same way, as a fraction of the cascode bias (`k_x`
solves for `k_casc`), so the output device and its cascode carry one current; and the degenerated
mirror solves its output device's source as a multiple of the reference leg's drop `I_in*R_s`
(`k_s` solves for `k_src`), so the output current and the drop it makes across its resistor
agree.

A solved parameter is found the way a design constraint is (see
[Entering from a spec](#entering-from-a-spec-designconstraint)): the engine searches it between
`min` and `max` until `param − solveFor` reads zero. Both are required, and they are the range
searched, not slider bounds. State the range the answer is physically bound to lie in — a share
between 0 and 1, a node between its neighbours, a gate-source voltage between the threshold region
and the supply — and say so in the note. Where the parameter is the level of a wire, the wiring
reads that range itself, and `min` and `max` may only narrow it (see
[The range a wire is searched in](#the-range-a-wire-is-searched-in)). `value` is what the panel shows before a run and nothing
more: the search starts from the range alone, so no stored value reaches the answer, and a sheet
gives the same number whatever value it was saved with. Because the parameter is solved rather than
set, the GUI shows it read-only, reporting where it landed — and there is no companion advisory
check to retune, because there is no estimate left to drift.

**Without `solveFor` the estimate is whatever the author last typed**, and nothing forces it to
agree with the design. That is not a small error: an early revision of the library's 5T OTA
shipped with a default that placed the input pair's drain 6 mV above its `vdsat`, so the sheet
evaluated `gds` on a device in triode and reported a gain of **1.8 against a target of 15**. In a
new sheet, prefer (in this order): a node parameterization that never creates the loop, a `designConstraint`
when a spec must drive an internal node whose search range can be stated as fixed numbers, and
`solveFor` for a genuinely self-referential quantity — including a loop like the source
follower's, where the node a design constraint would solve has a range that moves with the supply.

### What it does and does not guarantee

A `solveFor` parameter is held to every rule of the search a design constraint uses — its three
outcomes, its messages, and what it does at an end of the range where the relation does not
evaluate (see [Entering from a spec](#entering-from-a-spec-designconstraint)). The rules that are
its own:

| situation | result |
|-|-|
| the named target does not resolve to a finite number at either end of the range or at its middle | infeasible, `sheet-solve` error: the solve did not settle, because nothing of the range could be evaluated, and why |
| `min`/`max` missing or inverted | validation error — the range is required, and evaluation fails closed in the same words |
| a param solves for itself by name | validation error (the relation reads zero everywhere, and hides the loop) |
| a param solves for itself through an equation, or its relation reads the same everywhere | infeasible, `sheet-solve` error: the same value at both ends of the range and at its middle — the relation does not depend on the param, so no value of it is singled out |
| the parameter also carries `designConstraint` | validation error — one relation per parameter |

The search's tolerance is relative to the stated range, never to the value, and has no absolute
floor: the core is SI throughout, so a solved parameter is as likely to be a capacitance near
`1e-15` as a voltage near 1, and the range scales the tolerance to whichever it is.

### Scope: a few named loops, not a circuit solver

The architecture finds every unknown by a one-unknown search inside a range the author states —
narrowed, for the level of a wire, to the range the wiring puts that wire in (see
[The range a wire is searched in](#the-range-a-wire-is-searched-in)) — and never solves a node set. What keeps that boundary is the search rule itself, not a count of
solved parameters: parameters that read each other are settled only by repeating their searches a
fixed number of times (six sweeps by default, below), and a set still moving after them is
reported, not iterated further. Nested solves also share one evaluation budget for the whole
composed tree (10 000 evaluations of any document in it, by default), since a parent's every probe
re-solves each child and the cost would otherwise multiply with depth; a solve that runs out of it
says so, and says that it was not shown to be unsolvable.

### Solver settings

The tolerances and caps the engine evaluates under are one `Settings` value, and every public
evaluation takes it as an option — `evaluateSheet(doc, table, resolver, { settings })`,
`runSheet(…, refs, { settings })`, `sweepSheet`, `sweepSheet2`, `runCondition`, `runConditions`,
`sweepAtCondition`, `sheetSensitivities` (`opts.settings`) and `pickTopology` (`opts.settings`).
Nothing reads a global: an evaluation given no settings uses `DEFAULT_SETTINGS`, the values every
golden is pinned at, and one given values outside their limits (`SETTINGS_LIMITS`) uses the nearest
value inside them (`settingsFrom`). In the app they are set on the solver settings page reached from
the header, kept in the browser's local storage, and reset there one at a time or all at once; a
sheet panel marks its header whenever any differs from its default.

| setting | default | limits | what it decides |
|-|-|-|-|
| `solveTolRel` | `1e-6` | `1e-12`–`1e-2` | How close a solved parameter must land to its root, as a fraction of the range it is searched in. |
| `solveSweeps` | `6` | `1`–`20` | How many sweeps a set of solved parameters that read each other gets before the solve reports that they did not settle. |
| `solveEvaluations` | `10000` | `100`–`1000000` | How many evaluations one composed tree may spend on its searches before it stops and says the budget ran out. |
| `inwardSteps` | `8` | `0`–`30` | How many times a search halves its way in from an end of its range where the relation does not evaluate. |
| `kclTolRel` | `1e-3` | `0`–`1` | How large a wire's current sum may be, as a fraction of the largest current there, before the wiring check raises it. |
| `closureTol` | `0.01` V | `0`–`1` V | How far apart two statements of one voltage may be — around a loop, or between two placements of one sizing — before the wiring check says they disagree. |
| `nearMiss` | `0.05` | `0`–`1` | The relative margin below which a passing check reads `amber`. |

The sweep cap is a cap stated before the solve starts, never "until it converges", so raising it
cannot turn the bounded repetition into iterating a coupled set until something gives; that is why
its limit is small.

### Consequences for checks and sweeps

A `*-consistent` advisory check comparing an estimate against its target becomes an **assertion** —
it should now always pass, and a trip means the solve did not land. Keeping it is cheap
confirmation; it is no longer something to retune by hand.

A solved parameter is **not sweepable**: it is no longer a free variable, so the sweep pickers and
both sweep engines exclude it however its `min`/`max` are written. Sweeping other params still
works, and each sample closes its own loop — which is what makes a composed sweep quantitatively
trustworthy, since one slider value cannot be correct across a whole plane.

Every sample is solved **independently**, from its stated ranges alone; a sample is never started
from its neighbour's answer. That optimisation is tempting and wrong: a relation with more than one
root in its range would land wherever the neighbour led it, so the sweep would be hysteretic, and a
cell could report a different verdict than the same parameters evaluated on their own. The honest
version costs real time: a 41-point common-mode sweep of the library's 5T OTA, which settles two
solved parameters that depend on each other and asks both range ends at every sample, takes about
13 s on the demo table, run synchronously. Each declared bias axis adds a table slice per
evaluation, so much of that is the cost of not assuming.

## Entering from a spec (`designConstraint`)

`solveFor` closes a loop the author could not avoid. `designConstraint` is the opposite move: the sheet is
already loop-free because its bias variable is an internal node the tables are indexed by — and
the designer still gets to type the external quantity the application hands them.

```json
{ "name": "V_tail", "value": 0.4, "min": 0.15, "max": 0.8, "role": "choice",
  "designConstraint": { "lhs": "CM_in", "rhs": "CM_dc" },
  "note": "the tail node, chosen so the produced common mode equals CM_dc" }
```

The engine chooses the parameter so that `lhs == rhs`, by a **one-unknown search between `min` and
`max`** — for a solved parameter they are the range searched, not slider bounds, narrowed to the
range the wiring puts the parameter's wire in where it is a wire's level (see
[The range a wire is searched in](#the-range-a-wire-is-searched-in)). The search is
Brent's method: bisection, with secant and inverse-quadratic steps taken only while they stay
inside the bracket and shrink it faster than halving would. The root stays enclosed from the first
probe to the last, so the search needs no contraction, cannot overshoot, and owes nothing to a
starting guess. Its honesty conditions are stated instead: `lhs − rhs` must change sign across the
range — or read within its tolerance of zero at an end, which is then the root — and must actually
reach zero at the root.

An end of the range where the relation does not evaluate — a device with no headroom there, a
lookup out of range, a device its table cannot answer for — says the design has no operating point
at that end, not that the search failed. The search halves its way in from that end toward the
other, eight times, to the nearest point that evaluates (within 1/256 of the range of the edge),
and searches what is left. This is silent: a search that then lands says nothing about it. Only a
search that fails reports the range it actually searched and, where an end moved, why: `the
searched range [0.23, 0.8] V (the relation does not evaluate below V_tail = 0.23 V: block "in":
…)`.

A point inside the bracket where the relation does not evaluate — a band where a child's own solve
finds nothing, say — is stepped round the same way. A sign change across the bracket is evidence of
a root, so the search halves from that point toward each end of the bracket to the nearest point
that evaluates, and goes on in a half that still changes sign. When neither half does, the two
points it found still bracket the crossing, and halving may have stepped over a stretch that
evaluates, so it searches between them once more. Only when a later probe falls back inside a
stretch already stepped round, and neither half changes sign again, is the crossing taken to be
out of reach; that is reported as the solve not settling, naming the stretch where the points tried
do not evaluate, never as no solution.

### The range a wire is searched in

A solved parameter that is the level of a wire — a tail node, a cascode's source, a diode's node —
is searched in the range the wiring puts that wire in, where the wiring can read one; its `min` and
`max` may only narrow it. The parameter is the level of a wire when the wiring states that wire's
level, along some path of relations from `gnd` or a held wire, as exactly the parameter: the input
pair's source whose body bias is `V_tail` on a grounded body, a diode's drain whose drain-source
voltage from the supply is `VDD - V_nmir`. The relations are the wiring check's own (a device's
gate, drain and body voltage above its source, a held wire's level, a voltage element), read from
the netlist and the givens before anything is evaluated; a p device's voltages take their direction
from the table it is sized on.

**The wires around it.** Every device conducts in the direction its polarity declares — an n
device's drain at or above its source, a p device's source at or above its drain — so the wire sits
above the source of an n device whose drain is on it and the drain of a p device whose source is on
it, and below the drain of an n device whose source is on it and the source of a p device whose
drain is on it. Its range runs from the highest of the wires below it to the lowest of those above.
A gate, a body and an element bound nothing. Each neighbour is placed by the first of:

1. a level the wiring states through parameters the sheet does not solve — `gnd` at 0, a held wire
   at its level, a wire one relation from those whose relation reads only such parameters (at the
   design point, the drain of the pair under a cascode whose source node `V_a` is a plain input) —
   at its value at the point asked about, a range end's settings included;
2. where the design is held, the level the design point's wiring walk gave it — the run whose
   hardware is held: the centre for a range end, the condition the design is sized at for another
   process condition. It is read to the millivolt and one millivolt outward, so the same design
   quotes the same range whichever run its held design was read from. A wire whose level is another
   solved parameter is placed this way too, at the design point's placing, and so is a gate wire
   held at a hold's expression (`"vbn": "V_a + casc_n__vgs"`), which is held at its design-point
   value;
3. a wire whose level is another parameter the sheet solves, where nothing above places it — at the
   design point, between two solved wires: that parameter's own `min` for a wire below, its `max`
   for one above;
4. otherwise it cannot be placed: its level is set by a device, which the wiring walk reads only once
   the design is solved.

A side is bounded by the neighbours on it that can be placed — a looser bound than all of them would
give, and still one the wire cannot cross. A side with none leaves no range to read, and so does a
wire placed below another placed above it. Degenerate cases: a wire whose only neighbours are rails
is searched between them at every point (the current-mirror OTA's `V_nmir`, between ground and the
supply); a wire between two solved wires is searched, at the design point, between the outer ends
of their `min`/`max`; a node under a held gate is solved only where the design is held, between the
design point's placings of its neighbours. Only the top sheet's own solved parameters are read this
way — its wiring walk covers every wire of the tree; a block's own solved parameters are searched in
their authors' ranges.

**The author's range narrows it.** The search runs over the intersection:

| the author's `min`/`max` | searched | `from` |
|-|-|-|
| contain the wiring's range | the wiring's range — where they reach past it, a note says so | `wiring` |
| inside it, on at least one side (or clipped to it on one side) | the intersection | `narrowed` |
| outside it | nothing: an error names both ranges, the solve fails as declarations that cannot be solved as written (`malformed`), and the point has no answer | — |
| no wiring range is read | the author's range | `author` |

The check that the author's range lies outside the wiring's is made by the evaluation, not by
validation, since the wiring's range needs the tables (a p device's direction) and, where the design
is held, the design point's walk. The tolerance is a fraction of the range searched, so a clipped
range moves a landing by no more than that fraction.

**The note.** Every result carries `ranges` — each solved parameter's range searched, `from`, the
author's range, the wires whose level it is, the wiring's range with the wire that sets each end,
or why none was read — and, for each parameter that is the level of a wire, a `sheet-range` note in
its warnings, which the panel shows with the range-end notes:

    solved param "V_tail" is searched in the author's range [0.1, 0.55] V, inside the range the wiring puts its wire "tail" in, [0, 1.191] V between "gnd" below and "mirp" above
    solved param "V_nmir" is searched in [0, 1.8] V, the range the wiring puts its wire "nmir" in, between "gnd" below and "vdd" above
    solved param "V_tail" is searched in the author's range [0.1, 0.55] V: no range is read from the wiring for its wire "tail" — the wires above it, "mirn" (through "in_f") and "mirp" (through "in"), are set by devices, and the walk places them only once the design is solved

A parameter that is no wire's level — a share, a current, a gate-source voltage — has its author's
range by nature, and no note. A failure's message names its range's source the same way, in the
parenthesis after the range.

**The tolerance is in the parameter's terms.** A parameter is settled when it is within 10⁻⁶ of
the span of its stated range of its root. Where the relation is read again — every member of a set
at the end of a sweep, every solved parameter at the final check — it must read no more than its
slope at the root times that tolerance, which is the same statement converted into the relation's
units by the slope the search read. A tolerance in the relation's own units would be loose exactly
where it matters: an exponential, the way a current behaves below threshold, reads a large number a
hair from its root, so a fraction of its spread across the range lets the parameter sit percent
level off.

Every solve ends in one of **three outcomes**, and each of the two failures is a `sheet-solve`
error that names the parameter and the range:

| outcome | when | the message |
|-|-|-|
| settled and verified | the bracket closed to 10⁻⁶ of the stated span; the relation at the accepted point — the end of the final bracket where it reads nearer zero — reads within its tolerance by the slope just outside the bracket: on that point's side, and on the other side too where that one is missing or too shallow, the steeper kept, so a kink beside the root is not taken for a step; where one side lies beyond an end of the range, the bracket is halved up to four more times first, which brings a kink's reading within tolerance and leaves a step's at its height; and every solved parameter's relation, read from the evaluation that is returned, is within its tolerance. An end of the range whose relation reads within its tolerance of zero, by the slope there, is the root, so a root on an end is not lost to a rounding error on the wrong side | none |
| no solution found in its range | `lhs − rhs` does not change sign across the searched range, and neither end reads within its tolerance of zero — none, or an even number, of roots there; the bracket closes on a step — on both sides of it the relation barely moves, so the slope there leaves no room for the step's height (a table edge or a fold); the relation reads the same at both ends and the middle, so it does not appear to depend on the parameter | `solved param "V_tail" found no solution in [0.1, 0.55] V (the author's range inside the wiring's [0, 1.191] V between "gnd" and "mirp"): …` |
| did not settle | nothing of the range could be evaluated — both ends and the middle fail, which shows nothing about the stretch between them; the sign changes across a stretch inside the bracket where the points tried do not evaluate, even after stepping round it, so the crossing could not be followed; a member of a set still found nothing when searched again, or the set still moves after six sweeps (below); a relation read from the final evaluation is out of tolerance; the shared evaluation budget ran out first, here or in a child it reads (the parameter was not shown to be unsolvable); the probe backstop of 200 per search was hit | `solved params "V_tail" in [0.15, 0.8] V and "out_share" in [0.01, 0.99] did not settle in 6 sweeps: …` |

The outcome is also on the result as data, beside the message: `solve` on the sheet's result and
on each block's report, for that sheet's own solved parameters — `{ kind: "settled" }`,
`{ kind: "no-solution", unknown, range, from, because }` with the stretch actually searched, where
the range came from (`wiring`, `narrowed` or `author`, below) and what the search showed
(`no-crossing` — no sign change and neither end within tolerance; `step`; `undetermined` — the
relation does not single the parameter out), or
`{ kind: "not-settled", unknowns, why }`, where `why` is `budget`, `probes`, `unevaluable`,
`member` (one member of a set failed where the others stood), `sweeps`, `verification` or
`malformed` (the declarations cannot be solved as written). A `hold` that does not hold where the
design is sized — it does not evaluate, or a current balance does not read zero — is
`{ kind: "declaration-false", param }`: no search failed, the declaration is false there. Each
failure carries its `message`, the same words as the error. `solve` is absent on a run with nothing
to solve. Beside it, `ranges` lists each of the sheet's own solved parameters with the range it was
searched in and where that came from (below).

What a failure means for the point depends on where the range came from:

| outcome | where the design is sized | where the design is held (a range end, another process condition) |
|-|-|-|
| settled and verified | the run stands; feasible where every hard check holds | complies where every hard check holds, else does not comply |
| no crossing in a range the wiring read, or the author narrowed from it | infeasible, and the point does not comply, with the solver's message as its error | does not comply, with the solver's message as its error |
| no crossing in a range that is the author's alone; a step; an undetermined relation | infeasible, and the point has no answer | no answer |
| did not settle — including a member of a set that found nothing where the others stood | infeasible, and the point has no answer | no answer |

A range the wiring reads is every level the circuit can put the wire at, so finding no crossing
anywhere in it — or anywhere in the part of it the author kept — is the design not reaching its
target there: a finding, said as one. A range of the author's own may simply be in the wrong place,
and a set's member that found nothing did so where the other members happened to stand, so neither
says anything about the design. A point whose search read a device off its table, or that has a
device its table cannot answer for, has no answer whatever the range (see
[The operating range](#the-operating-range-operatingrange)). Validation adds:

| situation | result |
|-|-|
| the parameter also carries `solveFor` | validation error — one relation per parameter |
| `designConstraint` missing `lhs` or `rhs` | validation error — a half-written design constraint would freeze the parameter without solving it |
| `designConstraint` carries `held` | validation error — the engine sets that flag on the constraint it generates from a `hold` where the hardware is held; it is never written |
| the relation does not read the parameter it solves at all | validation error — it cannot single the parameter out |
| `min`/`max` missing or inverted | validation error — the range is required |

Messages print the relation as `lhs - (rhs)`, so `Q = A/2 + 0.8` reads `Q - (A/2 + 0.8)`. The
tolerance is **form-invariant**: scaling the relation scales its slope with it, so `lhs: "CM_in",
rhs: "CM_dc"` and `lhs: "CM_in - CM_dc", rhs: "0"` get the same verdict, and a root sitting
exactly at zero is found like any other.

If the relation folds inside the range there may be more than one root; the one found is
determined by the stated range alone, never by history, so repeated evaluations always agree.
A constrained parameter is solved rather than set: the GUI shows it read-only with the value it
landed on, and it is not sweepable — sweep the spec on the other side of the design constraint
instead. The library's 5T OTA is the worked example: the tail node is constrained so the produced
common mode equals `CM_dc`, which makes the common-mode axis a sweep of `CM_dc` with one search
per point.


### Several solved parameters on one sheet

A sheet may solve more than one parameter — design constraints, `solveFor` parameters and, where
the hardware is held, held nodes alike. The engine reads which other solved parameters of the same
sheet each relation reads, groups the ones that read each other into sets, and solves the sets in
an order where each comes after the ones its relations read. A set of one is one search, with every
earlier set held at the values it landed on. The telescopic OTA where its design is held is the
example. Its tail node, constrained to the common mode, and the NMOS cascode node, held under its
gate, read each other: the tail current the tail node lets through is the current the input pair
and the cascodes carry (`in__id = tail__id/2`), and the cascode node sets the pair's drain. So the
two form one set and settle together. The PMOS cascode node is held under its own gate and reads
the tail node through the same current, while nothing in that set reads it back, so it is solved
after them, alone. Between sets, document order does not matter.

A set of several — parameters that read each other, like the 5T's tail node and the share of the
tail current its output-side pair transistor carries — is settled by **sweeps**. Each sweep
searches every member in turn, in document order, the others at their current values. The set has
settled when every member's relation, read from the sweep's last evaluation — where every member
sits at the value it landed on — is within its tolerance: each member within 10⁻⁶ of the span of
its range of its root, by its slope, given where the others ended up. The library's pairs settle in
one sweep at the design point and in two or three where the hardware is held; the 5T on a low-
threshold table, held at 125 °C and asked at the top of its common-mode range, takes four. The
number of sweeps is a cap stated before the solve starts — six by default (`solveSweeps`, see
[Solver settings](#solver-settings)) — never "until it converges": a set still moving after six
depends on itself too strongly for repeated one-unknown searches, and the solve says so — `did not
settle in 6 sweeps`,
naming the members and the largest move in the last sweep, in its own unit — rather than iterating
further. Every member starts at the middle of its range, never at its stored value, so the answer
does not depend on what the sheet was saved with.

A member that finds nothing inside a set — no root, or nothing that evaluates — found it with the
others wherever they happened to stand. On the first sweep, where members it reads may still sit at
the middle of their ranges, it is put back at the end of that sweep's order and searched again once
others have landed, and again after that while something new has landed since it was last put
back; each putting back needs a new landing, so this ends. So the member a document lists first is
not judged at values only its partners' starting points gave it, and the library's pairs and the
three-member sets tried settle at the same answer in any order. A member that still finds nothing
when nothing more can land says nothing about the set either, so it is reported as the set not
settling, with the member's own reason inside the message, never as that member having no
solution. A budget that ran out is never put back: nothing the others do gives it back. Each member is searched with its own relation,
and a relation that reads its parameter only through another member — one the parameter does not
move while the others stand still — cannot be searched at all: pair each parameter with a relation
it moves.

A child solves its own parameters inside every probe of its parent, which is exact, so a parent's
design constraint over a child's is solved even when the child's relation reads the parent's
parameter: `P + Q = 1` above and `Q = P/2` below land on `P = 2/3`, `Q = 1/3`. A child whose own
solve failed at a probe publishes nothing there, so the parent's relation does not evaluate at that
point rather than steering by the numbers a failed solve left behind.

## A node under a gate (`hold`)

A cascode's source, a pair's tail, a follower's output: each sits one gate-source voltage below
a gate. Two things can be stated about such a node — where it sits, or where its gate is — and
they are the same single choice. When the sheet provides the gate bias, write a `designConstraint`: the node is
solved so that node plus gate-source voltage equals the bias. When it does not, state the node
and add a `hold`:

```json
{ "name": "V_a", "value": 0.55, "min": 0.46, "max": 0.85, "unit": "V", "role": "choice",
  "hold": "V_a + casc_n__vgs",
  "note": "the input drain and the cascode source" }
```

At the design point nothing is solved. The parameter keeps its value, it can be edited and swept,
and the result reports what the held expression came to (`held`: here the cascode gate bias the
design needs). Wherever the design is **held fixed and re-checked** — a range end's
fixed-hardware run — the roles swap: the expression is held at that value and the node is
re-solved between `min` and `max` — narrowed to the range the wiring puts the node in, between the
design point's placings of its neighbours (see
[The range a wire is searched in](#the-range-a-wire-is-searched-in)) — by the same search a
`designConstraint` uses. That is what the circuit does: a bias line holds the gate, and the node
under it moves with the condition. Without the `hold`, a range end would keep the node and let the
gate voltage drift.

The expression must be a sum of terms in which the parameter appears **exactly once**, on its own
or multiplied by a number: `V_a + casc_n__vgs`, `V_b - abs(casc_p__vgs)`,
`V_mir - V_casc + casc__vgs`. The check is on the shape, with no algebra attempted, so the
parameter's own term is there to read. Any other relation is a `designConstraint`.

| situation | result |
|-|-|
| the parameter appears twice, inside a function, divided, or not at all | validation error — write the relation as a `designConstraint` |
| the parameter also carries `designConstraint`, `solveFor` or `class` | validation error — a parameter takes one of the three, and a held node's class is derived |
| `min`/`max` missing or inverted | validation error — the range is required |
| a range end sets the parameter | validation error — the range end re-solves it, so the override would be discarded |
| a parent wires a value into a node its child holds | warning — the value is used at the design point, but a range end re-solves the node inside the child and the parent's own value does not follow. Hold the node on the parent |
| the expression reads a name nothing on the sheet provides | the design point fails (nothing to hold it at), and validation names the name |
| the held expression does not evaluate at the design point | infeasible — there is nothing to hold it at |
| at a range end, the expression barely moves across the range | that end is `no-answer`, "numerically unresolved" — the rest of the expression cancels the node's own term, so no node voltage is singled out |
| at a range end, the node finds no crossing in the range the wiring puts it in (or the author's part of it) | that end does not comply, with the search's own message |
| at a range end, the node has no solution in a range that is the author's alone, or does not settle | that end is `no-answer`, with the search's own message |

A `hold` keeps the **design point's** gate voltage. A gate bias that itself moves with the
condition — a replica that tracks the device — is a provided bias: write it as an expression and
constrain the node to it with a `designConstraint`.

Because a held gate stands in for a bias line that never moves, every run of the held design —
each range end, and each process condition other than the one the design is sized at — carries
one `sheet-held-gate` warning per gate a `hold` keeps, naming the device, the value and the hold:

    the gate of "casc_n" is held at its nominal value, 0.987 V (the hold of "V_a", V_a + casc_n__vgs) — a real bias branch would move it with the corner or condition, so the figures at this point are approximate

The design point carries none, nor does a hold that balances two currents (below), which holds
no gate. A child's held gate is reported at its block path. The panel shows the warning on the
range-end chip (⚠, and in its tooltip) and on a held condition's row.

### A current the design point chooses

A device given its gate voltage, a current and no width says two things the design point cannot
tell apart and a held design has to: whether its **gate** is the fixed thing — the PMOS of an
inverter, on the NMOS's gate and carrying the NMOS's current — or its **current** is, with the gate
voltage typed as an operating point. Where the design is held it is held at its width and that
current, as a current source, unless the sheet declares otherwise. The declaration is a `hold`
that reads the device's current, with the balance as the expression:

```json
{ "name": "I_bias", "value": 20e-6, "min": 2e-6, "max": 200e-6, "unit": "A", "role": "choice",
  "hold": "I_bias - p__id",
  "note": "the bias current, typed at the design point; where the design is held, the current both devices carry" }
```

with `id` among the PMOS block's `provides` (for the sheet's own device the hold reads `id`).
That hold does two things. It declares the PMOS's gate the fixed thing, so where the design is held
the PMOS is held at its width and **its gate voltage**, and its current is read from the table (see
[What "the same design" means at a range end](#what-the-same-design-means-at-a-range-end)). And it
fixes the typed current there: at the design point the balance reads zero by construction (the
PMOS was sized to carry `n__id`) and `I_bias` is an ordinary input; wherever the design is held the
balance is held at zero and `I_bias` is searched between `min` and `max` — the NMOS, held at its
width with `I_bias` through it, settles its gate voltage, the input level, and the PMOS at the
supply less that carries what the table gives, until the two agree. The inverter keeps its supply,
and its current and input level follow the condition.

| situation | result |
|-|-|
| a hold that reads a device's current does not read zero at the design point (`2*I_bias - p__id`) | the run fails closed: a current balance must be zero where the design is sized, and the message says what it read |
| where the design is held, the held param reaches no current but the balanced device's own | validation error — solving it to the balance would move nothing but its own number; give the param to the device it programs |
| a no-width device given a gate voltage and a current that is not a number, and no hold on its sheet reads its `id` (a balance) or its `vgs` (its gate held on a node) | `sheet-held-current` warning, naming both ways out: a series partner on a shared gate gets a balance; a mirror copy of a reference gets the reference's width and gate voltage (`W`, `vgs`), so its current follows the data |

The warning is raised for blocks, through the parent's overrides, and for the sheet's own device at
the top of a tree; a child's own device is asked about from its parent's block, where the holds
that could settle it are. A current given as a number is a source by statement and draws nothing.

## The operating range (`operatingRange`)

A sheet that claims a RANGE — "this amplifier accepts any input common mode in
`[CM_lo, CM_hi]`" — used to check the claim with linearized advisory checks, which could only
estimate the ends from the evaluated point. `operatingRange` checks them directly:

```json
"operatingRange": [
  { "name": "cm-lo", "set": { "CM_dc": "CM_lo" } },
  { "name": "cm-hi", "set": { "CM_dc": "CM_hi" } }
]
```

Each range end re-evaluates the WHOLE sheet once more with the named params' values overridden
— each `set` expression is evaluated against the base result, so it may reference params, equations,
or provided scalars. It is a compliance point, so the run is not free to build a new design
there: every device in the tree is held at the width and length the base run sized it to, and
what re-settles is the bias. That re-settling is the machinery the engine already has — the
solves run again over their full stated ranges, `vds` subtractions re-evaluate
against the moved nodes, each transformed device's `vgs` — or, for a device held on its gate
voltage, its current — comes back out of the lookup at its held width — with its own children and
its own solver budget. Both tree-key separators are reserved:
check ids, range-end names, AND block names may contain neither `@` nor `.` — every one of them
becomes part of a key in the single map check outcomes share (a range end's check is named
`cm-lo@sr-spec`), and a name carrying a separator could silently shadow another check's
result (validation refuses them).

**Four outcomes, two of them verdicts.** Each range end reports a `state`:

- `complies` — the held design was measured there and every hard check holds.
- `does-not-comply` — it was measured there and a hard check fails; the failing checks are in
  the end's own `checks`. One failure leaves no check outcomes: a device held at its width whose
  required current density runs past the top of the swept `vgs` range cannot carry its current
  there at all ("this device cannot carry its current here" — or, for a device bound by its
  transconductance, "cannot reach its transconductance here"), with the lookup's own message
  and reach numbers kept behind it in `error`. Another leaves none either: a solved wire whose
  search finds no crossing anywhere in the range the wiring puts it in, or in the part of it the
  author kept — no level the circuit can put the node at produces `CM_lo` — with the solver's
  message in `error` (see [The range a wire is searched in](#the-range-a-wire-is-searched-in)).
- `no-answer` — the question was asked and could not be answered, and `error` says why:
  - a solve found no solution in a range that is the author's alone, or did not settle — no
    tail-node position inside the range its author typed produces `CM_lo`, or the solved params
    that read each other did not settle. Nothing was measured, so this is not a failure of the
    design; widen the range, or read it as the tool's limit rather than the circuit's;
  - a `set` expression did not resolve to a number;
  - the table does not reach the bias the held design sits at. A `vds`, `vsb`, length or
    supplied gate voltage off the table's hull is read at the nearest characterized value, and
    a diode-connected device whose gate voltage lies past the characterized `vds` range is read
    at that range's edge — an advisory at the design's own operating point, but at a range end
    an answer read somewhere else is no answer, however its checks came out and even when the
    lookup then failed on the clamped data. (Float rounding is not a clamp: a value within
    10⁻⁹ of the axis span of an end node reads that node.)
  - the table has no sweep for a bias the held design sits at there, and was not taken at that
    bias — a range end that lifts a source above its body on a table with no `vsb` sweep. The
    device is refused (see [The operating point](#the-operating-point-vds-vsb)), and `error`
    carries the refusal, under the block's name when the device is a block's. A refusal comes
    before anything else that went wrong at that end: with a device missing, a solve that then
    did not land, or another device that then ran out of table, is a consequence and not a
    finding. Where the refused device hangs under a node the engine re-solves, the solver's
    message among that end's `warnings` says a device was not sized there. Where the same thing
    happens at the design's own operating point the base run does not stand, and every end is
    `not-run`;
  - a held device's current density falls below the bottom of the swept `vgs` range: it would
    sit at a gate voltage nobody characterized;
  - the design rests on a voltage classed `assumed`. Then every range end is declined without
    being evaluated.
- `not-run` — the question was never asked, because the base run produced no design to hold:
  it raised an error-severity warning — givens that did not size, a solve that never landed. The
  distinction from a failure is load-bearing rather than cosmetic: a solve that fails leaves its
  last probe behind in the result with every device's
  sizing still reading `ok`, so a verdict computed from that point would describe hardware the
  engine never landed on.

A check FAILURE at the centre does not stop the range ends being run — a design that misses a
spec is still a design, and whether it holds across its claimed range is still a real question.
The result's `complies` is true when every range end reports `complies`, false when any does
not — one with no answer included — and absent when the ends were not run because there was no
design to hold. None of this moves `feasible`.

What the range ends do and do not establish: they are the **endpoints**, exactly. The interior
follows only where the outcome is monotone toward the ends — true of the saturation mechanisms
that end a CM range, not a theorem about arbitrary checks — so the sweep remains the authority on
the full landscape. Costs and semantics to know:

- Cost is `(1 + range-end count)` full evaluations wherever the sheet is evaluated with its
  range — the sheet's own run and each sample of a one-parameter sweep — except where the base
  run did not stand, which costs one. A 21-point sweep of a sheet with a design constraint goes
  from ~0.6 s to ~1.8 s with two ends. The two-parameter feasibility map and the topology picker
  answer feasibility only, so they never evaluate a range end.
- A composed child's `operatingRange` is **not evaluated** (validation warns): in composition the
  parent typically drives the child's spec params, which would make the child's own range
  claim a fiction. Re-declare the claim on the parent if it should be asked there.
- `set` may not target an engine-solved param (`designConstraint`/`solveFor`) — the solve would discard
  the override; validation refuses it.
- The report carries the full story per range end: `state` (the four-way outcome above), `set`
  (the NUMERIC point that was asked about — the authored side may be an expression), `checks`
  and `blocks` (path-attributable outcomes), `solved` (where the engine-solved params landed;
  EMPTY whenever `error` is set, so a failed solve's probe is never reported as a landing), `warnings`
  (the run's own diagnostics, verbatim), `error` (present whenever the end's check outcomes are
  not findings about that point: the solver's message, the table's reach, the refusal), and
  `assumedSource` (see the fidelity notes below). A `not-run` end carries no outcomes: nothing
  ran.
- In the 1-D sweep each range end rides as one aggregate curve (legended `complies at cm-lo`):
  the held design's worst hard-check margin there, per sample, SKIPPING margins that sit exactly
  on zero — the end's own range check is parked there by construction (the snap) and carries no
  headroom information. It is a compliance curve and never changes which samples are feasible.
  An end the design measurably fails without leaving a margin draws at the bottom clip; a
  sample whose end was not run, or returned no answer, leaves a GAP in the curve, because there
  is no margin to draw and the bottom clip would read as a failure.
- Range-end curves move along EVERY sweep, including a sweep of a param a range end overrides
  (the canonical kit sweeps `CM_dc`, which both ends set). Each sample holds its own sample's
  design, so what the curve traces is how the range-end margin of a changing design varies —
  not a constant redrawn. The caption on the chart says so.

### What "the same design" means at a range end

"Held hardware" means held at the sheet's own level of description, which is worth stating
exactly — an author reading a green chip should know what it is and is not a statement about.

- **The geometry is held numerically, per device.** Givens that name no width — the common
  `(gm/ID, I_D)` form the library is nearly all written in — become `(W, I_D)` for the range-end
  run, at the width and length the base run sized, keeping the authored current expression.
  Givens that already name a width are left exactly as authored, which is what makes a gate tie
  survive: a `vgs` bound to another block's gate voltage re-reads that block's newly settled
  voltage at the end, so the two devices stay on one wire. Width-first givens whose partner is
  an operating-point TARGET instead hold a ratio rather than a wire, and reproduce the tie
  only under a drain-voltage move. Givens that name a gate voltage and no width, where a `hold`
  on their sheet balances the device's current, become `(W, vgs)`: the gate-voltage expression is
  kept, whatever it was paired with (a current, a transconductance) goes, and the current is read
  from the table at the held width (see
  [A current the design point chooses](#a-current-the-design-point-chooses)); undeclared, a gate
  voltage is an operating-point spec like a gm/ID, and the device is held at `(W, I_D)`. Givens
  that name neither a width nor a current, and no balanced gate, have both held numerically, and
  the run lists those blocks in `assumedSource` — the sheet never said where their current comes
  from, so holding it is an ideal-source assumption, and the fix is to author the current.
- **A node under a gate is re-solved, and the gate is what is held.** A parameter that carries
  `hold` is not kept at its design-point value: the expression it names — the gate voltage — is,
  and the node is solved again under it (see [A node under a gate](#a-node-under-a-gate-hold)).
  A node typed as a plain parameter is kept as typed, which holds the node and lets the gate
  voltage drift.
- **The geometry is exact; the small-signal numbers read off it are not.** Rewritten givens
  re-read `gm` from the table at the held width instead of honouring the ratio the author
  wrote, so a range-end `gm` — and every quantity derived from it — sits an interpolation
  residual below the base's, about 0.1% on the demo model, even where nothing about the condition
  changed. Read a base-against-end comparison with that floor already under it.
- **The authored current expression IS the hardware model.** `I_f = pcs__id - in__id`
  re-evaluates at the range end, and that difference is the folding node's current law. The one
  exception is a device held on its gate voltage because a hold balances its current: its
  authored current is the design point's, and where the design is held its current is the table's
  at that gate voltage, with the balance fixing the typed current that sets the other side. What a
  typed current does not model is a real source's own output resistance re-settling the current
  as its drain moves: a device handed
  `I_tail` carries exactly `I_tail` wherever its drain goes. A device written as a copy of its
  reference — the reference's width on the reference's gate, as the 5T OTA's tail device is —
  has its current read off the table at the drain voltage it sits at, so that re-settling is in
  the answer, and a device reading its current (`tail__id/2`) follows it (see
  [The author's contract](#the-authors-contract)). Re-settling a network beyond what the
  declared connections determine is out of scope here as everywhere else in this engine, and
  the sheet's authority ends where the lookup table's does. For typed currents, comparison
  against fixed-netlist simulation put the divergence at ~10% at the far ends of the shipped
  range claims, without changing any of their verdicts.
- **A device whose GATE is the fixed thing has to say so.** Bind `(W, vgs)` — or give `vgs`
  beside a current and no width and balance that current with a hold, which is held as
  `(W, vgs)` — and the gate tie holds under any
  move a range end makes — drain, body bias, supply, temperature — because the givens re-read
  the gate voltage the partner settles to there. Written any other way, the device is
  current-driven by assumption at a range end, and two devices sharing a gate node stay at one
  voltage only while the end moves `vds` alone. Validation warns when width-first givens sit
  under a range end that reaches them through any other path — a given gate voltage excepted,
  since that is the tie itself, and a current written as an expression the end reaches, since the
  current then follows what it reads and the table is read at it — and says so differently when
  the end reaches the givens' own
  `W` or `L`, because then the run is sizing a different transistor rather than re-biasing this
  one. Both are advisory. Where a range end changes a device's CURRENT, validation says that
  too, as a note and not a warning: a device given a width and no current, or held on its gate
  voltage by a balance, reads its current from the table, so it carries a different one once the
  end moves its drain or its gate, and so does every device whose current is written as a share
  of it. That is the circuit behaving as drawn;
  the note is there because a claim about the range rests on it. Separately, where a netlist puts
  two devices on one gate wire and one source wire while each is sized at its own operating point,
  the wiring check reports the loop they leave open — the netlist is never allowed to drive the
  sizing, only to point out that nothing does.
- **Where the transformation rewrites a device's givens, the data-ceiling verdict carries no
  information.** For the same reason its `gm` drifts low, its operating point is read out of the
  table rather than requested, so `gm/ID` is at or below the data ceiling by construction — that
  data-trust signal, one of the things that gates an ordinary sizing, is structurally absent there.
  The run's other diagnostics (bias clamps, an inverse lookup that runs out of table) are what carry
  the trust question instead, which is why they ride the report verbatim. Width-first givens keep
  their authored operating-point spec, so the ceiling still gates them at a range end — unless that
  spec is a bound `vgs`, which reads the point out of the table exactly as rewritten givens do and
  is under the ceiling by construction for the same reason. Do not author a ceiling check on a
  gate-tied device; it can only report a pass. The
  sheet's own ceiling CHECK goes quiet in the same way and less visibly: it is authored against
  the `gm/ID` param (`gm_id_in <= ceiling`), and at a range end that param no longer binds the
  device, so the check reports the base value unchanged and passes. A green ceiling chip on a
  range end says the ceiling held at the centre, not that it was re-checked there.

## Sweeps

Two views trace a sheet across parameter ranges (both need finitely-bounded slider params):

- **One-parameter sweep** — walk one sweepable param across its `[min, max]` and, at each
  sample, plot every check's relative margin plus the overall feasibility. This is the classic
  feasibility-region view: wherever every hard check's curve sits at or above zero, the design
  is feasible. In a composed sweep, each descendant block's hard checks ride along with
  path-prefixed ids (`cs.headroom`), so the constraint that actually binds is on the chart wherever
  it lives.
- **One-parameter sweep at one condition** — `sweepAtCondition(doc, param, device, key,
  deviceOf, refs?, { base?, points?, settings? })` traces the same curves at one characterization
  condition. Without a `base`, or with `base` the same condition, each sample sizes the design
  there — the numbers `sweepSheet` gives on that condition's tables. With another `base`, each
  sample sizes the design at `base` with the knob at its value and holds it at `key` — widths,
  lengths, currents and gate biases fixed, the operating point re-settled, exactly as a condition
  run holds it — so the curves are the held design's margins there and its `feasible` reads
  whether that design complies at its own operating point. The result says which (`design:
  "sized" | "held"`).
- **Two-parameter sweep** — the design-plane map over two params' ranges (the `gm_id × L` plane
  is the classic), answering questions a 1-D cut cannot: "what is the minimum `L` that stays
  feasible across the whole `gm_id` range?" Each infeasible cell names the worst failing hard
  check (by tree path), so a child's constraint is attributed to the block it lives in.

A margin says how much room a check has but not which knob moves it, so the core also exports
`sheetSensitivities(doc, table?, resolveDevice?, opts?)`: it re-evaluates the whole sheet a
step either side of each `choice` param and reports, per check, how far that check's margin
moved — the ranking a designer needs to know what to turn next.

## The author's contract

The engine evaluates what a sheet declares; it never solves a circuit. That division of
labor puts specific responsibilities on the sheet author. They are collected here in one
place, each with the check that catches a violation. The pattern throughout: the author
states the bias plan honestly, and the engine makes a false statement loud — it never
silently repairs one.

1. **Declare the operating point of every device.** Bias axes (`vds`, `vsb`) are expressions
   over named node parameters, stated in the givens (see *The operating point*). The drain
   voltage is always stated, as `vds` or as `diode: true`: a device that states neither is
   reported by validation and is not sized on any table. A `vsb` the author did not declare is
   taken from the namespace default and reported in the sizing's `assumed` list — visible, never
   silently adopted. Backstop: a bias is read where it was declared, or where its default puts
   it, or not at all — on a table that does not sweep that axis and was not taken at that
   value, a declared bias refuses the device with the reason and an undeclared `vsb` fails the
   sizing until it is declared, never sized on the table as it stands. Where a device must stay
   in saturation — or, as a switch, in triode — say so with `region` in its givens, and the engine
   adds the `vds`-against-`vdsat` physical check to that device (see *The region*).
2. **Name internal nodes as parameters and write every `vds` as a subtraction of nodes.**
   Node form makes branch sums checkable and inconsistencies expressible. A source sitting
   above the bulk means `vsb` is declared from the same node that sets the source — body
   effect enters through the declared coordinate, not through a corrected formula.
3. **Never bias a child with an estimate of that child's own answer.** A hand-tuned
   parameter standing in for a quantity the sheet itself computes is the retired pattern.
   Backstop: the `sheet-assumption` validation rule flags a parameter that feeds a child's bias
   while a check asserts it equals that child's output. A parameter already classed `assumed`
   is not flagged, unless the child is diode-connected: the sheet has said it types the level,
   the check is how the assumption is tested, and the result lists it among its assumptions.
4. **Declare wiring identities instead of copying their consequence.** A diode-connected
   device is `diode: true` — resolved exactly on the table's `vds = vgs` diagonal, which takes
   a table that sweeps `vds` — not a hand-copied drop that goes stale when the operating point
   moves. A device on another device's gate wire, sharing its source node, binds `vgs` to that
   block's own gate voltage — not the same inversion level typed into both, which agrees only
   at one table and one bias.
   (`diode: true` and a bound `vgs` are independent and may both appear: the connection chooses
   the diagonal, the bound `vgs` chooses the point on it. A declared `vds` is what the connection
   excludes.) The wires say it too: a gate on its drain wire is a diode connection, and two
   devices on one gate wire and one source wire that are sized apart leave a loop the wiring check
   measures. Backstop: the wiring check reports that loop's residual.
5. **Close a genuine loop explicitly, or do not close it at all.** `solveFor` is for a
   quantity defined in terms of the device's own answer; `designConstraint` is for a typed specification
   an internal node must produce. Both state the range the answer must lie in, and the note says
   why (see *Closing a bias loop* and *Entering from a spec*). Backstop: every solve ends in one
   of three named outcomes — settled and verified, no solution in its range, did not settle — and
   only the first is ever reported as a sized design.
6. **A claimed operating range is a claim to check.** Declare `operatingRange` so both ends are
   re-checked on every run — on the design that run produced, with its devices held — and say
   in the note that the ends are checked exactly while the sweep owns the interior (see
   *The operating range*). Backstop: an end the design does not comply at is reported as
   exactly that — beside feasibility, under a check id qualified with the end's name — and an
   end that could not be answered is never counted as complying.
7. **Pick each check's kind for its verdict semantics.** Spec and physical checks gate
   feasibility; advisory checks advise and never block; `==` fixed points carry a tolerance (see
   *Check kinds*). A hard check whose side cannot compute reads `na` and fails closed — so
   hard checks may only use quantities every supported table carries; model missing data as
   explicit `*_est` parameters with notes.
8. **Say "estimate" where the sheet estimates — and never gate feasibility on one.** Stability,
   dynamics, and anything a simulator owns is labeled estimate-grade in its note. The sheet's
   authority ends where the lookup table's does. The standing case is noise: a noise row reads
   the table's own thermal noise where the table stores it and the γ = 1.0 estimate where it
   does not, and a sheet cannot know which table it will meet, so a check on that row ships as
   an `advisory` check with a note saying why; each run's result says which reading it used.
   The exception proves the rule: a kT/C noise bound is thermodynamics, not a γ-model estimate,
   and stays a hard spec check.
9. **Respect polarity by declaration, not sign-fixing.** Signed PMOS tables pair with
   `*_sign` parameters; value columns are magnitudes, axes keep their signs (see
   *Signed-table sign parameters*). Backstop: the panel warns when a sign parameter
   disagrees with the bound table's recorded polarity.
10. **Keep identifiers plain.** `@` and `.` are reserved in check ids, range-end names, and block
    names — they become tree-keyed, range-end-qualified ids in reports. Validation rejects them.
11. **A node parameter's note names its setter.** Every declared node should say who sets
    it: a solve, a derivation from another block's output, a bias network the application
    provides, or a deliberate choice a check tests. Writing the sentence is the point —
    "this node is set by …" has exactly one honest completion, and a node whose setter is a
    device's own gate cannot honestly be typed as a free number. Backstop: the node's wire
    carries the check — a node the sheet holds is in `levels`, every other is derived from the
    devices on it, and the wiring check reports wherever two of them disagree past 10 mV. The
    note says which description is authoritative; the check says whether the two still agree, so
    a gate that must sit one `vgs` below a rail, or one gate shared by two devices, no longer
    evaluates without complaint.
12. **A programmed current sets one device.** The current a bias network programs — a reference
    current, a tail current — is the `id` of exactly one device on the sheet. Every other device
    that carries it gets it from the circuit, and its givens say how: a device in the same branch,
    or taking its share at a node, reads that device's current (`tail__id/2`), and a device that
    mirrors it is tied to its gate (`W: K*ref__W, vgs: ref__vgs`) — never the programmed number
    a second time. The reason is what happens when the design is held fixed and asked about at
    another condition: every device the number was typed into then carries an ideal current,
    where the circuit would have let all but one of them follow. The library's 5T OTA is the
    worked example — its bias reference alone is programmed, the tail device is that reference's
    width on that reference's gate, the pair's output-side transistor takes its solved share of
    what the tail delivers and its partner is that transistor's width carrying the rest, the
    load's diode side carries what its pair transistor does, and the load mirror's output side
    sits on its diode side's gate. Backstop: the library's vetting suite
    counts, for each parameter in amperes, the devices whose bound current reads it without
    reading another block's output, and fails on any curated sheet where that is more than
    one; `validateSheet` does not check this.

13. **Name the wiring.** Every sized device names the four wires it sits on — the sheet's own in
    its `nodes`, a child's on the block that composes it — and the sheet holds, in `levels`, only
    the wires the designer states: supplies, references, inputs, an applied bias. A sheet that is
    not a circuit says `"nodes": "none"`. A diode connection is the gate on the drain wire; two
    devices on a shared gate are on one wire, not two wires typed at one voltage. Backstop: the
    wiring check reports every loop the netlist closes that does not close within 10 mV, with both
    claims, every wire no held wire reaches, and every current sum that does not balance (see
    [Wiring](#wiring-nodes-levels)); a sheet that names no wiring and does not say `"none"` is
    refused (see [Every sheet names its wiring](#every-sheet-names-its-wiring)).

## A complete worked example

A single-NMOS sizing sheet: fix `gm` from a bandwidth spec, use `gm/ID` as the efficiency knob,
and let `ID` and `W` fall out of the lookup. The headroom floor is a physical check, the noise
target a spec check, and the bandwidth comparison an advisory check computed from the *derived*
GBW (so it is not a tautology on a given value):

```json
{
  "formatVersion": 2,
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
    { "name": "V_ds", "value": 0.6, "unit": "V", "role": "spec", "class": "independent",
      "note": "drain bias the sizing slices at; body-grounded, so vsb = 0" }
  ],
  "givens": { "L": "L", "gm": "2*pi*GBW_target*CL", "gm_id": "gm_id", "vds": "V_ds", "vsb": "0" },
  "nodes": { "d": "out", "g": "in", "s": "gnd", "b": "gnd" },
  "levels": { "out": "V_ds" },
  "ports": ["in"],
  "equations": [
    { "name": "Cout", "expr": "cgg + CL", "unit": "F" },
    { "name": "GBW", "expr": "gm/(2*pi*Cout)", "unit": "Hz" },
    { "name": "vn_in", "expr": "vnth_m", "unit": "V/sqrt(Hz)" }
  ],
  "checks": [
    { "id": "feasible-inversion", "kind": "physical", "lhs": "gm_id", "op": "<=", "rhs": "ceiling",
      "note": "gm/ID cannot exceed the weak-inversion ceiling of the data" },
    { "id": "headroom", "kind": "physical", "lhs": "vstar", "op": ">=", "rhs": "vstar_floor" },
    { "id": "gbw-margin", "kind": "advisory", "lhs": "GBW", "op": ">=", "rhs": "GBW_target" },
    { "id": "noise-spec", "kind": "spec", "lhs": "vn_in", "op": "<=", "rhs": "vn_target" }
  ]
}
```

Reading it: `gm` is fixed from the spec and `gm/ID` chosen, so the givens size the device and
surface `vstar`, `cgg`, `ceiling`, and the thermal-noise density `vnth_m`. The givens also fix
the operating point with `vds` (from `V_ds`) and `vsb` (0, body-grounded), so the sizing
slices the table at a stated point instead of borrowing the caller's bias. Stating a drain
voltage means the sheet runs on a table that sweeps `vds`, or was taken at exactly that drain
voltage; `vsb = 0` is also what a table with no `vsb` column is read as. The netlist puts the
drain on the wire `out`, held at `V_ds`, the gate on the input port `in`, and the source and body
on ground, so the wiring check confirms that the drain voltage the sizing read is the level the
sheet holds the wire at. The two physical checks
enforce a physical `gm/ID` ceiling and a saturation-headroom floor. The spec check holds the
input noise under target. The advisory check compares the *actual* GBW — which includes the sized
`cgg` loading — against the target, so it reports how much the gate capacitance eats the
bandwidth without ever blocking feasibility. Sweeping `gm_id` traces every check's margin and
shows the feasible window between the headroom floor (at high `gm/ID`) and the point where the
device runs out of inversion ceiling.

For a composed example — a cascode that stacks a child common-source input device and carries
its provided drain current — and for evaluating any of these sheets from Node, see
[Scripting the core](../README.md#scripting-the-core).
