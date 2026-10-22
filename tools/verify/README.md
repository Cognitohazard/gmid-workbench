# Simulation cross-checks for table-driven sizing

Two kinds of ngspice check live here, both against the shipped sky130 gm/ID tables
(`data/pdk/sky130/`, characterized at W = 1 µm) and the compact models they were simulated from:

- **The library re-verified from its wiring** (below): every library sheet that is a circuit is
  evaluated on the tables, its wiring is written out as an ngspice deck with nothing driven but
  what the sheet leaves to the outside, and the sheet's figures are compared with the
  simulation. Run it after changing a sheet, the sizing or the wiring check.
- **Reference decks** (further down): a handful of hand-written decks for one device and for the
  five-transistor OTA, which measure what the tables and one sheet can and cannot be trusted for.

A library-wide check run in July 2026 drove every bias gate from an ideal voltage source at the
value the sheet computed. That checks each transistor against its table at the sheet's own
operating point, and nothing more: it cannot catch a circuit that cannot bias itself, and it
passed sheets whose bias was later found to be impossible. It is withdrawn as verification of the
sheets; the re-verification below replaces it. Its decks are not in the repository.

## Re-verifying the library from its wiring

From the repository root, with the sky130 tables generated (`tools/gen_gmid.py`) and the PDK
fetched into `.pdk/`:

    npx vite-node tools/verify/export_netlists.ts
    python3 tools/verify/gen_decks.py
    python3 tools/verify/reverify.py

Each step takes an optional list of name fragments to work on fewer sheets (with one, `reverify.py`
prints its lines and leaves `results.json` and `report.md` as they were). Everything the steps
write goes under `tools/verify/generated/`, which is derived from the sheets and is not committed:

- `netlists/<group>__<sheet>.json`: the **sized netlist** of each sheet, from `sizedNetlist` in
  `src/sheet/spice.ts`. The sheet is evaluated at its defaults on the sky130 tt 27 °C tables, every
  block whose sheet states polarity p on the pfet table and every other on the nfet table, every
  param declared `"convention": "axis-sign"` set to −1 (the pfet table is exported signed). The
  JSON lists every sized device (block path, polarity, W, L, the four wires of each placement, the
  operating point it was sized at, the quantities it exposes), every element with its value, every
  held level, the top sheet's ports with the level its wiring derives, every wire with the level
  the wiring check reports, the top sheet's params, its equations and solved params by name and
  value, and the wiring check's state, residuals and current sums. Wires are named as the wiring
  check names them: a child that wires itself joins its parent through its port map, and every
  other wire of it is spelt `block__wire`.
- `decks/<group>__<sheet>.cir` and `.json`: the ngspice deck, and how each wire was driven.
- `decks/<group>__<sheet>.log`, `results.json`, `report.md`: ngspice's output, every comparison,
  and one table per sheet.

### How a deck is written

A deck's circuit is the sheet's wiring and nothing else; what drives it, and what the analyses
add, follow these conventions (`gen_decks.py` states the same in its header, and needs no Python
package beyond the standard library):

- **Models.** sky130A tt from `.pdk/sky130A/libs.tech/ngspice/corners/tt.spice`, with
  `.param mc_mm_switch=0` and `mc_pr_switch=0`; run from the repository root.
- **Devices.** One subcircuit instance per placement, on the four wires the sheet names, body
  included. Each is the characterization device of its table (`W=1 nf=1`, microns as the model
  takes them) at the sized length, with `m` equal to the sized width in microns: the tables' own
  per-µm scaling, which keeps the comparison about the sheet's arithmetic (the reference decks'
  findings below say what a single wide finger does instead). A device whose sheet states
  polarity p is a `sky130_fd_pr__pfet_01v8`.
- **Elements** are written as the sheet draws them: `between: [from, to]` is SPICE's `n+ n-` for
  an `I` (current from→to inside the source), a `V` (V(from) − V(to) = value), an `R` and a `C`.
- **What the sheet leaves to the outside.** `gnd` is node 0. A supply wire (`vdd`, `vsup`) is an
  ideal source at its held level, else the level the wiring derives, else the sheet's `VDD`, else
  1.8 V. An input wire (`in`, `vin`, `vinp`/`vinn`) is an ideal source at the sheet's level; a pair
  is a common mode plus a difference, split evenly.
- **Held outputs.** Where the sheet holds an output at which currents arrive and leave (an n drain
  and a p drain) and its inputs are free ports, a **servo** holds it: an ideal integrator compares
  the output with its level and moves the input, differentially for a pair, as the five-transistor
  OTA's reference decks do. Every other held wire a drain or source touches, and a port whose
  current only a parent carries (a lone drain or diode on it), is kept at its level by a **current
  hold**: an ideal integrator that injects whatever current that takes. Both loops cross unity near
  10 µHz, so they are open for the `.ac` and `.noise` analyses. The current a hold injects is
  compared with what the sheet's wiring check says an ideal source supplies there.
- **Partly pinned.** A wire only gates touch that the sheet holds or leaves as a port, other than
  an input, has no generator on the sheet: it is an ideal source at the sheet's own level, and the
  sheet is reported as partly pinned on that wire. So is a port kept by a current hold, other than
  an output. A held wire other than an output that a current hold keeps is reported as held
  inside: the sheet's levels say the application holds it, by a circuit the sheet does not draw.
- **Loads the figures read and the wiring does not draw.** No library sheet draws a capacitor: the
  load and compensation capacitors the bandwidth and phase-margin figures read (`CL`, a Miller
  `Cc` with its `Rz`), and the assumed load resistances some figures read (`gds_load_est`,
  `R_load`, `R_L`), are params. `gen_decks.py` adds them per sheet from its `AC_LOADS` table: a
  capacitor carries no DC current, and a resistor is put in series with 1 F, so it is ac-only, and
  is noiseless (`noisy=0`), so it adds nothing the sheet's noise figure leaves out.
- **Analyses.** `.op`; `.ac` from the input (differential for a pair) to the output (differential
  for a pair) with the servo and holds open; `.noise` to the same output, referred to the same
  source; a second `.ac` that injects 1 A at the output (differentially for a pair) with the input
  at ac ground.

Three sheets also get a **diagnostic variant**, a second deck in which a partly pinned piece is
replaced by the loop the application closes around it, to say what level the circuit needs where
the sheet pins it: both fully differential OTAs with an ideal common-mode loop on `vbp` holding
the mean of their outputs (`[cmfb]`), and the gain-boosted OTA with ideal booster amplifiers, of
the gain the sheet reads (`boost__av0`), driving the cascode gates from the nodes the sheet holds
(`[boosters]`).

### What is compared, and how close counts as agreeing

| Figure | Simulated as | Band |
| ------ | ------------ | ---- |
| Each placement's drain current | the instance's `id` at the operating point | 5 % |
| Each wire level the sheet derives or solves | the node voltage (a wire the deck drives is not compared) | 10 mV |
| An input a servo moves | the node voltage, against the level the sheet derives for it | 10 mV |
| `vos_sys` | the input difference the servo settles at | 10 % or 0.5 mV |
| The current a held wire's source supplies | a current hold's injected current, a held supply's current | 5 % of the largest current on the wire |
| `Av` | the low-frequency gain magnitude (1 Hz) | 10 % |
| `GBW` | the low-frequency gain times the −3 dB frequency | 10 % |
| `PM` | 180° less the phase lost from 1 Hz to the unity-gain crossing | 5° |
| `vn_in` | the thermal part of the input-referred density at 1 kHz: the total less every device's flicker term | 10 % |
| `Rout` | the impedance at the output at 1 Hz (per side, for a pair) | 10 % |

Why these bands:

- **Currents, 5 %.** At a table point the model and the table agree to 0.1 %. Between points the
  sheet interpolates, and the body-bias axis is the coarse one (0, 0.3, 0.6, 0.9 V): a device whose
  source sits between those nodes reads up to about 3 % off (the beta multiplier's degenerated
  device, −2.7 % at 0.11 V; the reference decks' input pair, −1.7 % at 0.27 V). 5 % admits that and
  nothing a wiring or sizing mistake would produce.
- **Voltages, 10 mV.** The tolerance the sheet's own wiring check closes loops to (the
  loop-closure tolerance in "What the check reports" of docs/sheet-format.md): the resolution its
  bias plans are written to. The interpolation above moves a gate-source voltage by up to about
  3 mV.
- **Gain and output resistance, 10 %.** Each rests on output conductances, a derivative the table
  stores at nodes 25 mV apart up to 0.3 V of drain voltage and 100 to 200 mV apart above it. Read
  between the upper nodes it is up to about 13 % off (examples below); 10 % admits one device's
  interpolation error, and not a term missing from a formula (the body effect is 15 to 25 % of a
  cascode's transconductance here). The earlier device-level check used 5 % on gain, which the
  five-transistor OTA meets (1.6 %) and an output conductance read between the upper drain-voltage
  nodes does not.
- **Bandwidth and noise, 10 %**, as the earlier check used: each is a transconductance, read to
  about 3 %, against a capacitance (several sheets add a drain-capacitance estimate of their own)
  or against the table's own noise column.
- **Phase margin, 5°.** A 10 % error in a non-dominant pole at or above the unity-gain frequency
  moves the margin by about 3°; a pole or zero the formula leaves out moves it by more.
- **Systematic offset, 10 % or 0.5 mV.** It is a difference of two gate-source voltages, each read
  to about 1 mV where the body bias falls between table nodes.

### What the last run established

ngspice-42; sky130A as built by open_pdks `c6d73a35`; tt corner, 27 °C; every sheet at its
defaults (no range end, no other corner). All 37 library sheets that are circuits produced a deck
and converged; the 8 that declare `"nodes": "none"` are not circuits and are not simulated. 396 of
the 408 figures compared are within their band, and 34 sheets have every figure within band
(the run before the formula corrections it found read 384 and 28). The
deck generated for the five-transistor OTA agrees with the hand-written reference decks below to
0.05 % (tail current 18.095 µA, offset 4.744 mV against their 4.743, gain 53.90, unity-gain
frequency 8.42 MHz, thermal noise 28.24 nV/√Hz; those decks round the widths to five figures),
which is the check that the generator writes the circuit those decks were written for.

| Sheet | Within band | Partly pinned | Held inside | Out of band |
| ----- | ----------- | ------------- | ----------- | ----------- |
| `mirrors-bias/beta-multiplier-bias` | 5/5 | ngate | dm2 | — |
| `mirrors-bias/cascode-current-mirror` | 10/10 | — | — | — |
| `mirrors-bias/degenerated-current-mirror` | 7/7 | — | — | — |
| `mirrors-bias/matched-mirror-bank` | 4/4 | — | — | — |
| `mirrors-bias/nmos-bias-reference` | 2/2 | — | — | — |
| `mirrors-bias/nmos-cascode-bias` | 4/4 | — | — | — |
| `mirrors-bias/nmos-mirror-output` | 2/2 | vb | — | — |
| `mirrors-bias/pmos-bias-diode` | 2/2 | vb | — | — |
| `mirrors-bias/pmos-bias-reference` | 2/2 | — | — | — |
| `mirrors-bias/pmos-cascode-bias` | 4/4 | — | — | — |
| `mirrors-bias/simple-mirror` | 5/5 | — | — | — |
| `mirrors-bias/wide-swing-cascode-mirror` | 11/12 | — | — | — |
| `mirrors-bias/widlar-current-source` | 6/6 | — | — | — |
| `multistage/class-ab-output-monticelli` | 5/5 | gn, gp | — | — |
| `multistage/fd-telescopic-ota` | 30/30 | vbp | — | — |
| `multistage/fd-two-stage-ota` | 12/21 | vbp | — | — |
| `multistage/flipped-voltage-follower` | 6/6 | — | — | — |
| `multistage/stage2-current-source-load` | 2/2 | vb | — | — |
| `multistage/super-source-follower` | 6/6 | — | — | — |
| `multistage/two-stage-cascode-comp-ota` | 24/24 | vcas | — | — |
| `multistage/two-stage-miller-ota` | 20/20 | — | — | — |
| `otas/current-mirror-ota` | 24/24 | — | — | — |
| `otas/degenerated-differential-pair` | 15/15 | — | — | — |
| `otas/differential-pair-tail` | 13/13 | — | — | — |
| `otas/five-transistor-ota` | 18/18 | — | — | — |
| `otas/folded-cascode-ota` | 34/34 | — | — | — |
| `otas/gain-boosted-cascode-ota` | 22/24 | bi, vgn, vgp | a, b, bo | — |
| `otas/inverter-based-ota` | 8/8 | — | — | — |
| `otas/telescopic-cascode-ota` | 31/31 | — | — | — |
| `stages/cascode-cs-amp` | 12/12 | vbp | — | — |
| `stages/cmos-inverter-amp` | 8/8 | — | — | — |
| `stages/common-gate` | 7/7 | vg | — | — |
| `stages/cs-amp-current-source-load` | 8/8 | vbp | — | — |
| `stages/cs-amp-diode-load` | 8/8 | — | — | — |
| `stages/cs-amp-resistive-load` | 7/7 | — | — | — |
| `stages/source-degenerated-cs-amp` | 6/6 | — | — | — |
| `stages/source-follower` | 6/6 | — | — | — |

The variants are not counted in the totals. What lies outside a band, largest disagreement first;
each was traced to its cause with the per-device gm, gds and gmb the decks also print
(`results.json`, `diag`):

- **Two-stage OTA with cascode compensation: `Av` 1093 on the sheet, 8555 simulated (7.8×).** The
  sheet's first-stage gain is `gm1/(ino__gds + ld1o__gds)`, the input device's own output
  conductance, but the sheet draws a cascode (`casco`) on that device, which raises the impedance
  on that side by its intrinsic gain; the simulated first-stage gain is set by the mirror's output
  device alone. `PM` reads 75.3° on the sheet and 116.6° simulated: the two-pole formula leaves out
  the left-half-plane zero this compensation makes. The simulated loop gain also holds at about
  0.78 from 10 to 50 MHz before its phase passes −180° near 72 MHz, a gain margin of 4.3 dB, which
  no figure on the sheet reports.
- **Gain-boosted cascode OTA: `Av` 1.2·10⁵ on the sheet, 2107 simulated.** The booster amplifiers
  are not drawn: the cascode gates are ports (`vgn`, `vgp`), so the deck pins them and the
  simulation is of the unboosted cascode. With ideal boosters of the sheet's gain in their place
  (`[boosters]`) the simulated output resistance is within 0.9 % of the sheet's own formula worked
  from the simulated devices; the sheet's figures read 12.8 % (`Rout`) and 16.8 % (`Av`) low for
  the table's output conductances where the devices sit between table nodes (the cascode at 0.35 V
  of drain and 0.55 V of body bias, −7.9 % in simulation; the input device, −5.3 %).
- **Cascode output resistance: `Rout` and `Av` 32–35 % low on the telescopic and fully
  differential telescopic OTAs, 23–25 % low on the folded cascode.** Each sheet writes a cascode's
  output resistance as `casc__av0/lower__gds`, the cascode's gm/gds times the lower device's
  output resistance. That leaves out the body effect of the cascode, whose source sits above its
  body (gm + gmb, not gm), and the cascode's own output resistance in series. Worked from the
  simulated devices, the complete form `ro_lo·(1 + (gm + gmb)·ro_c) + ro_c` gives the simulated
  output resistance to 0.1 % on both telescopic OTAs, where the sheets' form gives 18.5 % and
  20 % less; the rest is table interpolation of the output conductances (−4 to −5 % on the input
  and cascode devices). On the folded cascode the sheet's form also leaves out the input pair's
  output conductance at the fold node, which partly cancels the body effect: with it the complete
  form gives the simulated output resistance to 0.0 %, and the table reads the folding current
  source's output conductance 12 % high at its 0.38 V of drain voltage, between the 0.3 and 0.4 V
  nodes.
- **Fully differential two-stage OTA, with its common-mode gate pinned: second-stage current 32 %
  low, the first-stage outputs 30 mV high.** The first-stage outputs are high-impedance nodes set
  by the balance between the pair and a load whose gate (`vbp`) is pinned at the sheet's number;
  the pinned gate is 0.3 mV from the level the circuit needs, which moves those nodes by 30 mV and
  the second stage's current with them. With an ideal common-mode loop on `vbp` (`[cmfb]`) every
  figure is within band and `vbp` settles 0.3 mV from the sheet's value. The sheet's numbers are
  right; the sheet cannot hold its operating point without the common-mode loop it leaves to the
  application.
- **Degenerated differential pair: `Rout` and `Av` 22 % low.** The sheet writes the output
  resistance as `1/(in__gds + gds_load_est)`, but each input device is degenerated by its source
  resistor, which multiplies its output resistance to `ro·(1 + (gm + gmb)·R_s) + R_s`; with that
  form the simulated devices give the simulated output resistance exactly.
- **Common gate: `vn_in` 15 % high, `GBW` 10.1 % low.** The sheet refers the channel noise to the
  input by gm (`vn_in = vnth_m`, the gate-referred density), but the input is the source, where
  the transconductance is gm + gmb: gm/(gm + gmb) is 0.842 here. `GBW` divides by `CL + cdd_est`,
  and the 0.2 pF drain-capacitance estimate is about ten times what the simulated device adds; the
  other common-source stages that add the same estimate read 9 to 10 % low, just inside the band.
- **Wide-swing cascode mirror: `Rout` 11 % low.** The output device sits at 0.35 V of drain voltage,
  between the 0.3 and 0.4 V table nodes, where the table reads its output conductance 10.7 % high.

Within band but worth knowing:

- **Two levels the sheets solve sit outside the rails, and the simulation agrees with both.** The
  cascode current mirror's reference stack needs 1.807 V under a 1.8 V supply, so its reference
  current source would need −7 mV of headroom (the sheet's own `ref-stack-headroom` check says so);
  the fully differential telescopic OTA's PMOS cascode bias puts its gate wire `vcp` at −51 mV, so
  its current sink would sit below ground (its own `cbp.stack-fits` check fails). An ideal current
  element goes there; a transistor would not.
- **The source-degenerated common-source stage's `vn_in`** (+4.7 %) counts the degeneration
  resistor's noise as `4·k·T·R_s`, where the degenerated differential pair counts it with the factor
  ((gm + gmb)/gm)² that the body effect gives it.
- **Each partly pinned wire is a bias the sheet leaves to the application**: the load gate `vbp`
  of the two common-source stages with a current-source load, the common-mode gate `vbp` of both
  fully differential OTAs, the gain-boosted OTA's cascode gates and booster input, the beta
  multiplier's top-mirror node `ngate` (its PMOS mirror is not drawn, so the drain it holds,
  `dm2`, is held inside), the class-AB stage's two output gates, the cascode-compensated OTA's
  cascode gate `vcas`, the common-gate stage's gate `vg`, and `vb` on three building blocks whose
  parents supply it (the PMOS bias diode, the NMOS mirror output, the second-stage current-source
  load).

## Reference decks

Small hand-written decks that close the loop between the tables and the models for one device and
for the five-transistor OTA of `sheets/otas/five-transistor-ota.json`. Run them after touching the
lookup or sizing math, after regenerating the tables, or after changing that sheet. From the
repository root:

    ngspice -b tools/verify/ota_op.cir

Each deck prints a short labelled list of numbers and writes no files. The header comment of each
deck states what the tables or the sheet predict for those numbers.

Each deck `.include`s the sky130A tt corner file from the PDK the table generator uses,
fetched into the repository's `.pdk/` directory
(`.pdk/sky130A/libs.tech/ngspice/corners/tt.spice`). ngspice resolves the path from the
directory it is started in, so run the decks from the repository root
(`ngspice -b tools/verify/ota_op.cir`). If your PDK lives elsewhere, edit the `.include`
line near the top of each deck. No `.spiceinit` is needed. The noise decks also print
`Source conductance reset to 1.0e3 mho` and `Drain conductance reset to 1.0e3 mho`
warnings; that is expected with these models.

### Decks

- `nfet_width_op.cir` — one nfet_01v8 at a table point sized from two requirements
  (gm = 1 mS at gm/ID = 15, with L = 0.5 µm and VDS = 0.9 V, gives W = 25.77 µm at
  VGS = 718.4 mV), with that width realized three ways: as 25.77 parallel copies of the
  1 µm device, as 26 fingers, and as one wide finger. Prints the operating point of
  each, then sweeps the gate to show how far the fingered and single-finger devices
  depart from the copies.
- `ota_op.cir` / `ota_ac.cir` / `ota_noise.cir` — the five-transistor OTA of
  `sheets/otas/five-transistor-ota.json` at its shipped defaults: an ideal 20 µA into a
  diode-connected bias reference, the tail device on that reference's gate, the input
  pair, and a PMOS mirror load (diode side and output side), with CL = 2 pF and
  VDD = 1.8 V. The three decks share one circuit and differ only in the analysis:
  operating point, differential gain and bandwidth, input-referred noise.
- `cs_n_noise.cir` / `cs_p_noise.cir` — one nfet and one pfet held at the bias points
  of the OTA's input pair and mirror load, with no load and no surrounding circuit.
  They give each device's own noise density, which separates what the device model
  contributes from what the OTA topology contributes.

### How the OTA decks follow the sheet

The decks carry numbers copied from one evaluation of the sheet, so they have to be
re-derived when the sheet's defaults or the tables change. Evaluate the sheet with
`runSheet` ("Scripting the core" in the repository README shows how) on the
`sky130_fd_pr__nfet_01v8` tt 27 °C table, with the `ldr` and `ld` blocks read from the
`sky130_fd_pr__pfet_01v8` tt 27 °C table (give both blocks a `device` key and pass a
resolver that maps it to that table) and the `ld_sign` parameter set to −1, because that
table is exported signed. Then copy from the result's values:

- `bias__W`, `in__W`, `ldr__W` (in µm) to the `m=` of XMB/XMT, XM1/XM2 and XM3/XM4 in
  all three OTA decks, with `CM_dc` on VCM, `V_out_dc` on VREF and `I_tail` on IB. The
  sheet draws the pair as two blocks, `in` (XM2, drain on the output) and `inr` (XM1,
  drain on the load's diode node); `inr` copies the width of `in`, so one number serves
  both;
- `in__W` to the `m=` of `cs_n_noise.cir`, with `in__vgs`, `V_out_dc − V_tail` and
  `V_tail` on its VG, VD and VB (VB is negative: the body sits below the source);
- `ldr__W` to the `m=` of `cs_p_noise.cir`, with `ldr__vgs` on both its VG and VD;
- the values each deck quotes in its header comment.

Two choices in the OTA decks go beyond what the sheet states:

- **Widths are multiples of the 1 µm device.** The sized widths (2.5031, 1.7808 and
  2.5797 µm) are not whole numbers of microns, so each device is the 1 µm single-finger
  device the tables were made from with a fractional multiplier `m`. That is the
  tables' own per-µm scaling rather than a layout, and it keeps the comparison about
  the sheet's arithmetic. What a layout does instead is measured below.
- **A servo holds the output.** Nothing inside a 5T OTA fixes its output level, and the
  sheet assumes the feedback around the amplifier holds it at `V_out_dc`. An ideal
  integrator compares the output with `V_out_dc` and applies its result as a
  differential input offset, split evenly about `CM_dc`. At DC the output therefore
  sits at `V_out_dc` exactly and the integrator's output is the input offset that
  takes; the loop's unity-gain frequency is about 10 µHz, so it is open for the `.ac`
  and `.noise` analyses.

### What the reference decks established

ngspice-42; sky130A as built by open_pdks `c6d73a35` (the version directory that
`.pdk/sky130A` points to is named after it); tt corner, 27 °C.

#### The sheet against the simulated OTA

The sheet draws the OTA at rest, the state the servo puts the decks in: the output held at
`V_out_dc`, the two inputs apart by the offset that takes. The two pair devices are one
width, each carrying its own share of the tail current; the share is solved so that the
output-side device takes exactly the current the mirror's output side returns, and the
systematic offset `vos_sys` is the difference of the two devices' gate-source voltages. So
every row below is compared directly, in one state, with nothing forced:

| Quantity                                           | Sheet              | Simulated          | Difference      |
| -------------------------------------------------- | ------------------ | ------------------ | --------------- |
| Tail current (`tail__id`, also `I_q`)              | 18.103 µA          | 18.095 µA          | −0.04 %         |
| … as a share of the programmed 20 µA               | 90.5 %             | 90.5 %             |                 |
| Tail node (`V_tail`)                               | 272.57 mV          | 271.41 mV          | −1.2 mV         |
| Bias reference VGS, shared with the tail           | 810.56 mV          | 810.59 mV          | +0.03 mV        |
| Bias reference gm/ID / tail gm/ID                  | 10.00 / 9.93       | 10.00 / 9.93       | 0.0 %           |
| Output side's share of the tail (`out_share`)      | 0.4960             | 0.4960             | 0.0 %           |
| Pair current, output side (`in__id`), also `ld`'s  | 8.978 µA           | 8.975 µA           | −0.04 %         |
| Pair current, diode side (`inr__id`), also `ldr`'s | 9.124 µA           | 9.120 µA           | −0.05 %         |
| Pair VGS, output side / diode side                 | 825.04 / 829.82 mV | 826.22 / 830.96 mV | +1.2 / +1.1 mV  |
| Input offset that holds `V_out_dc` (`vos_sys`)     | 4.785 mV           | 4.743 mV           | −0.9 %          |
| Pair gm, output side / diode side                  | 107.74 / 107.29 µS | 108.76 / 108.34 µS | +0.9 % / +1.0 % |
| Pair gm/ID, output side / diode side               | 12.00 / 11.76      | 12.12 / 11.88      | +1.0 % / +1.0 % |
| Pair transconductance into the output (`gm_pair`) | 106.71 µS          | 107.77 µS          | +1.0 %          |
| Load VGS, both sides (`ldr__vgs`)                  | −1132.19 mV        | −1132.15 mV        | +0.04 mV        |
| Load gm/ID, diode side / output side               | 8.00 / 8.01        | 8.00 / 8.01        | 0.0 %           |
| Output gds, pair / load (`in__gds`, `ld__gds`)     | 1.3346 / 0.6774 µS | 1.3240 / 0.6714 µS | −0.8 % / −0.9 % |
| Low-frequency gain (`Av`)                          | 53.04              | 53.90              | +1.6 %          |
| Unity-gain frequency (`GBW`)                       | 8.492 MHz          | 8.420 MHz          | −0.8 %          |
| Phase margin (`PM`)                                | 89.7°              | 90.7°              | +1.0°           |
| Input-referred thermal noise density (`vn_in`)     | 28.39 nV/√Hz       | 28.24 nV/√Hz       | −0.5 %          |

Slew rate was not simulated; the sheet computes it as `tail__id/CL`, so it follows the
tail current.

Every current agrees within 0.05 %, every voltage within 1.2 mV, every gm, gm/ID and output
conductance within 1 %, the gain within 1.6 %, the offset within 0.9 %, the bandwidth within
0.8 % and the thermal noise within 0.5 %. The gate-source voltages sit about a millivolt low
and the pair's gm/ID 1 % low for one reason, the pair's body bias (below). The
thermal-noise row is read from the noise the tables store for each device, which is the
simulator's own:

- **The thermal-noise figure agrees because it is the simulator's noise.** The simulated
  thermal floor is 28.24 nV/√Hz, flat from 1 Hz to beyond 10 MHz. It is read at 1 kHz as
  the total less every device's flicker term, because the total itself is
  flicker-dominated there. The reference decks show why a γ = 1 estimate, which is what a
  table without stored noise gets, would not: at the output-side pair device's bias point
  the nfet's own density is 17.32 nV/√Hz, an effective γ of 1.95 against gm alone (1.63
  against the channel's noise conductance gm + gmb), where the table's stored noise reads
  17.31; at the load's bias point the pfet's is 15.08 nV/√Hz against the table's 15.08, γ 1.00
  (0.81). With γ = 1 for both, the body effect counted, the row would read 25.0 nV/√Hz, 11 %
  low; with the body effect left out as well, 22.7 nV/√Hz, 20 % low.
  Neither γ is a constant: moving VG in the reference decks takes the nfet from 1.4 at
  gm/ID 22 to 1.9 at gm/ID 6–12, and the pfet from 0.5 at gm/ID 17 to 1.0 at gm/ID 4–8.
  This is consistent with the two models' thermal-noise parameters (`tnoimod = 1` in both;
  `rnoia` is 0.94 for the nfet and 0.69 for the pfet).

#### Findings

- **The tail delivers less than it is programmed to, as the sheet says.** The tail
  device shares the bias reference's gate, but its drain sits at 0.27 V where the
  reference's sits at its 0.81 V diode drop, so it delivers 18.10 µA of the programmed
  20 µA. The sheet predicts the same to 0.04 %. The tables step the drain voltage by
  25 mV up to 0.3 V, so the tail's drain falls between two close nodes, and the sheet
  reads its output conductance as 7.53 µS against a simulated 7.56 µS. Nothing on the
  sheet reads that conductance. The tail and the bias reference together add 0.07 % to
  the input-referred thermal noise power, so the sheet is right to leave them out of
  `vn_in`.
- **The tail current does not split in half, and the sheet's split is the simulated
  one.** At rest the output-side pair device carries 49.60 % of the tail current, in the
  sheet and in simulation: it takes what the mirror's output side returns, and the mirror,
  its output side 0.23 V further from the supply than its diode side, returns less than
  the diode side carries. The diode-side device carries the rest at a drain 0.23 V lower,
  and needs 4.74 mV more gate-source voltage for it in simulation (4.78 mV in the sheet):
  that is the input offset the servo applies.
- **Interpolation is exact at the characterization width.** At the `nfet_width_op.cir`
  point the 1 µm device, scaled by its multiplier, matches the table lookup to −0.06 %
  on id, +0.01 % on gm and −0.5 % on gds. The pfet at the load's bias point matches to
  0.02 % on id and gm. The grid shows in one place in the OTA: the pair's 0.27 V body
  bias, which falls between the 0 V and 0.3 V VSB nodes. At the sheet's exact coordinates
  the model gives 8.822 µA where the table reads 8.978 µA (−1.7 %), with gm within
  0.12 %; `cs_n_noise.cir` prints both. In the OTA that costs the pair about a millivolt
  of gate-source voltage and 1 % of gm/ID, which is the largest difference in the table
  above.
- **Width scaling is the dominant sizing error.** A single-finger W = 25.77 µm device
  conducts 1.82× the current the W = 1 µm table predicts at the deck's operating point
  (gm 1.71×), and up to 1.87× across a gate sweep — worst in moderate inversion, at
  gm/ID 18.5 — falling to 0.99× at VGS = 1.8 V. Realized as 26 fingers of 0.991 µm the
  same width tracks the table to 0.2 % on id and 0.1 % on gm, and stays within 0.25 %
  of the copies across the sweep. **Realize table-derived W as N fingers of the
  characterization width.** A multi-finger instance needs `.option wnflag=1` (as the
  deck sets) or the `ngbehavior=hsa` compatibility mode: ngspice-42 otherwise picks the
  model bin from the total width and stops with `u0 … is not positive`.
- **A current-biased circuit absorbs most of what is left.** Replacing the fractional
  multipliers in the OTA decks with whole fingers nearest 1 µm (`W=2.5031 nf=3`,
  `W=1.7808 nf=2`, `W=2.5797 nf=3`, plus `.option wnflag=1`) leaves every current, gm,
  the gain and the unity-gain frequency within 0.2 % of what the decks print as
  shipped; the gate voltages move by up to 9 mV and the input offset by 0.21 mV, to
  4.53 mV. As single fingers (`nf=1`) the same widths move further: a tail current of
  18.46 µA (+2.0 %), an output-side pair gm of 112.9 µS (+3.8 %) at gm/ID 12.4, a gain
  of 58.9 (+9.4 %), a unity-gain frequency of 8.73 MHz (+3.6 %) and an offset of
  5.20 mV.
- **The 5T OTA meets its gain and bandwidth specs in simulation.** Gain is 53.9 against
  a target of 15, and the unity-gain frequency is 8.42 MHz against a target of 8 MHz.
  2π × 8.420 MHz × 2 pF is 105.8 µS of effective transconductance. The simulated pair
  devices have 108.76 and 108.34 µS, and the mirror passes on the diode side's half of the
  signal with a gain of 0.986 (71.91 µS over 72.96 µS), so the two halves give 107.77 µS,
  the form the sheet's `gm_pair` takes; the effective figure is 1.8 % under it, and the rest
  was not separated out. The sheet's `gm_pair` is 106.71 µS, 1.0 % under the simulated
  devices because of the body-bias interpolation above, so its `GBW` lands 0.8 % above the
  simulated unity-gain frequency. The devices add only about 1 fF to the 2 pF load.
- **Input-referred noise is two-sided.** The two pair devices contribute 17.14 and
  17.29 nV/√Hz of thermal noise at the input, and the two load devices 9.88 and
  10.31 nV/√Hz. All four together give 1.40× the density of one pair device and one
  load device, a factor of 2 in power, which is why the sheet's `vn_in` adds up all
  four. The same 1.40× holds in the flicker band: 1.37 µV/√Hz at 1 kHz against
  0.98 µV/√Hz composed from the two reference decks.
- **Flicker dominates in-band.** In the OTA the flicker part falls to the thermal floor
  only at 9.8 MHz, above the 8.4 MHz unity-gain frequency. The total input-referred
  density is 1.37 µV/√Hz at 1 kHz, 197 nV/√Hz at 100 kHz and still 30.3 nV/√Hz at
  100 MHz. Alone, the nfet's flicker corner is 13.9 MHz and the pfet's 0.51 MHz at
  these gate areas. Treat table-derived noise as a floor, not a budget.
