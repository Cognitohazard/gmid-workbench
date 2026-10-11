# Simulation cross-checks for table-driven sizing

Small ngspice decks that close the loop between the shipped sky130 gm/ID tables
(`data/pdk/sky130/`, characterized at W = 1 µm) and the compact models they were
simulated from. Run them after touching the lookup or sizing math, after regenerating
the tables, or after changing the five-transistor OTA sheet:

    cd tools/verify
    ngspice -b ota_op.cir

Each deck prints a short labelled list of numbers and writes no files. The header
comment of each deck states what the tables or the sheet predict for those numbers.

Each deck `.include`s the sky130A tt corner file from a volare install
(`~/.volare/sky130A/libs.tech/ngspice/corners/tt.spice`). ngspice expands the leading
`~` but not environment variables, so if your PDK lives elsewhere, edit the `.include`
line near the top of each deck. No `.spiceinit` is needed. The noise decks also print
`Source conductance reset to 1.0e3 mho` warnings; that is expected with these models.

## Decks

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

## How the OTA decks follow the sheet

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

- **Widths are multiples of the 1 µm device.** The sized widths (2.5031, 1.8066 and
  2.4740 µm) are not whole numbers of microns, so each device is the 1 µm single-finger
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

## What the last run established

ngspice-42; sky130A as built by open_pdks `c6d73a35` (the volare install records it in
`~/.volare/sky130A/SOURCES`); tt corner, 27 °C.

### The sheet against the simulated OTA

The sheet describes the OTA with its inputs balanced and its output held at `V_out_dc`.
The decks as shipped hold the output with the servo instead, which leaves the inputs
apart by the offset. The small-signal figures and the offset are compared in that state:

| Quantity                                       | Sheet        | Simulated    | Difference |
| ---------------------------------------------- | ------------ | ------------ | ---------- |
| Tail current (`tail__id`, also `I_q`)          | 17.875 µA    | 18.102 µA    | +1.3 %     |
| … as a share of the programmed 20 µA           | 89.4 %       | 90.5 %       |            |
| Tail node (`V_tail`)                           | 274.4 mV     | 272.3 mV     | −2.0 mV    |
| Bias reference VGS, shared with the tail       | 810.56 mV    | 810.59 mV    | +0.03 mV   |
| Bias reference gm/ID                           | 10.00        | 10.00        | −0.03 %    |
| Tail gm/ID                                     | 9.80         | 9.93         | +1.3 %     |
| Low-frequency gain (`Av`)                      | 53.41        | 54.12        | +1.3 %     |
| Unity-gain frequency (`GBW`)                   | 8.534 MHz    | 8.461 MHz    | −0.9 %     |
| Phase margin (`PM`)                            | 89.7°        | 90.7°        | +1.0°      |
| Input-referred thermal noise density (`vn_in`) | 22.57 nV/√Hz | 28.07 nV/√Hz | +24 %      |
| Input offset that holds `V_out_dc` (`vos_sys`) | 4.79 mV      | 4.85 mV      | +1.2 %     |

Slew rate was not simulated; the sheet computes it as `tail__id/CL`, so it follows the
tail current.

The pair and the load are compared with the inputs balanced, the state the sheet's
blocks are drawn in. The pair's two devices share a gate-source voltage there but not a
drain, for the same reason the mirror's two sides do: the diode-side drain is one PMOS
VGS below the supply (0.67 V) while the output-side drain is at `V_out_dc` (0.9 V). So
the tail current does not split in half, and the sheet solves the split (`out_share`,
reported as `pair_split`) so that the two pair currents add up to what the tail delivers.
To put the simulation in that state, replace GSV and CSV in `ota_op.cir` with a 0.9 V
source on `out` and a resistor from `os` to ground. The deck then prints the two
differences under `output held at V_out_dc`, and the current of the added source is what
the output node is short of.

| Quantity                                           | Sheet              | Simulated          | Difference      |
| -------------------------------------------------- | ------------------ | ------------------ | --------------- |
| Output side's share of the tail (`pair_split`)     | 0.5104             | 0.5103             | −0.02 %         |
| Pair current, output side (`in__id`)               | 9.124 µA           | 9.238 µA           | +1.2 %          |
| Pair current, diode side (`inr__id`), also `ldr`'s | 8.751 µA           | 8.864 µA           | +1.3 %          |
| Pair VGS, both sides (`in__vgs`)                   | 825.6 mV           | 827.6 mV           | +2.0 mV         |
| Pair gm, output side / diode side                  | 109.49 / 105.09 µS | 111.34 / 107.04 µS | +1.7 % / +1.9 % |
| Pair gm/ID, output side / diode side               | 12.00 / 12.01      | 12.05 / 12.08      | +0.4 % / +0.6 % |
| The two in series, doubled (`gm_pair`)             | 107.25 µS          | 109.15 µS          | +1.8 %          |
| Load current, output side (`ld__id`)               | 8.611 µA           | 8.722 µA           | +1.3 %          |
| Load VGS, both sides (`ldr__vgs`)                  | −1132.2 mV         | −1133.8 mV         | −1.6 mV         |
| Load gm/ID, diode side / output side               | 8.00 / 8.01        | 7.95 / 7.97        | −0.6 % / −0.5 % |
| Pair, output side over diode side                  | 0.373 µA           | 0.374 µA           | +0.2 %          |
| Load mirror, diode side over output side           | 0.140 µA           | 0.142 µA           | +1.1 %          |
| Current the output node is short of                | 0.514 µA           | 0.516 µA           | +0.5 %          |

Every current, voltage, gm and gm/ID agrees within 1.9 %, gain and bandwidth within
1.3 %, and the systematic offset within 1.2 %. The currents in the second table sit
1.2–1.3 % under the simulated ones because the tail current does; how the tail current
splits, and the two differences `vos_sys` is built from, agree more closely than that.
`vos_sys` is the current the output node is short of, divided by `gm_pair`: the sheet's
0.514 µA over 107.25 µS is 4.79 mV where the servo applies 4.85 mV. One line does not
agree, and it comes from what the sheet models rather than from the tables:

- **The thermal-noise figure reads 20 % low, because of the nfet.** The simulated
  thermal floor is 28.07 nV/√Hz, flat from 1 Hz to beyond 10 MHz. It is read at 1 kHz as
  the total less every device's flicker term, because the total itself is
  flicker-dominated there. The reference decks trace the gap to one device type. At the
  output-side pair device's bias point the nfet's own density is 17.18 nV/√Hz where the
  tables' γ = 1 model gives 12.31: an effective γ of 1.95. With VD in that deck lowered
  to the diode-side pair device's 393.43 mV it is 17.44 against 12.56, γ 1.93. At the
  load's bias point the pfet's is 15.40 nV/√Hz against 15.39: an effective γ of 1.00.
  Putting the simulated densities into the sheet's own formula gives 28.3 nV/√Hz, so
  the formula is right and the nfet's γ is not. Neither γ is a constant: moving VG in
  the reference decks takes the nfet from 1.4 at gm/ID 22 to 1.9 at gm/ID 6–12, and the
  pfet from 0.5 at gm/ID 17 to 1.0 at gm/ID 4–8. This is consistent with the two
  models' thermal-noise parameters (`tnoimod = 1` in both; `rnoia` is 0.94 for the nfet
  and 0.69 for the pfet).

### Findings

- **The tail delivers less than it is programmed to, as the sheet says.** The tail
  device shares the bias reference's gate, but its drain sits at 0.27 V where the
  reference's sits at its 0.81 V diode drop, so it delivers 18.10 µA of the programmed
  20 µA. The sheet predicts 17.87 µA. The 1.3 % between them comes from the tables'
  0.2 V VDS grid: the tail's drain falls between the 0.2 V and 0.4 V nodes, just above
  its 0.16 V saturation voltage, where the curve still bends and straight-line
  interpolation reads the current low and the output conductance high (`tail__gds` is
  11.5 µS against a simulated 7.5 µS). Nothing on the sheet reads that conductance. The
  tail and the bias reference together add 0.07 % to the input-referred thermal noise
  power, so the sheet is right to leave them out of `vn_in`.
- **The tail current does not split in half, and the sheet's split is the simulated
  one.** With the inputs balanced the output-side pair device has 0.23 V more
  drain-source voltage than its partner and carries 51.03 % of the tail current; the
  sheet solves 51.04 %. The servo then moves the inputs apart by 4.85 mV, which takes
  0.26 µA from the output branch and gives it to the diode branch, so as shipped the
  decks print 8.977 µA on the output side and 9.125 µA on the diode side.
- **Interpolation is exact at the characterization width.** At the `nfet_width_op.cir`
  point the 1 µm device, scaled by its multiplier, matches the table lookup to −0.06 %
  on id, +0.01 % on gm and −0.5 % on gds. The pfet at the load's bias point matches to
  0.03 % on id and gm. The grid shows in two places in the OTA: the tail's drain
  (above), and the pair's 0.27 V body bias, which falls between the 0 V and 0.3 V VSB
  nodes. At the sheet's exact coordinates the model gives 8.974 µA where the table
  reads 9.124 µA (−1.6 %), with gm within 0.13 %; `cs_n_noise.cir` prints both.
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
  `W=1.8066 nf=2`, `W=2.4740 nf=3`, plus `.option wnflag=1`) leaves every current, gm,
  the gain and the unity-gain frequency within 0.3 % of what the decks print as
  shipped; only the gate voltages move, by up to 11 mV. As single fingers (`nf=1`) the
  same widths move further: a tail current of 18.47 µA (+2.0 %), an output-side pair gm
  of 113.5 µS (+3.8 %) at gm/ID 12.4, a gain of 59.3 (+9.6 %) and a unity-gain
  frequency of 8.77 MHz (+3.7 %).
- **The 5T OTA meets its gain and bandwidth specs in simulation.** Gain is 54.1 against
  a target of 15, and the unity-gain frequency is 8.46 MHz against a target of 8 MHz.
  2π × 8.461 MHz × 2 pF is 106.3 µS of effective transconductance, and the current the
  output node is short of over the offset the servo applies gives 106.4 µS. That is
  2.6 % under the 109.1 µS the simulated pair devices have in series (108.9 and
  109.4 µS as shipped). The mirror passes on the diode side's half of the signal with a
  gain of 0.985 (70.6 µS over 71.7 µS), which accounts for 0.7 %; the rest was not
  separated out. The sheet's `gm_pair` is 107.25 µS, 1.8 % under the simulated devices
  mostly because its tail current reads 1.3 % low, so its `GBW` lands 0.9 % above the
  simulated unity-gain frequency. The devices add only about 1 fF to the 2 pF load.
- **Input-referred noise is two-sided.** The two pair devices contribute 17.09 and
  17.24 nV/√Hz of thermal noise at the input, and the two load devices 9.74 and
  10.17 nV/√Hz. All four together give 1.40× the density of one pair device and one
  load device, a factor of 2 in power, which is why the sheet's `vn_in` adds up all
  four. The same 1.40× holds in the flicker band: 1.36 µV/√Hz at 1 kHz against
  0.97 µV/√Hz composed from the two reference decks.
- **Flicker dominates in-band.** In the OTA the flicker part falls to the thermal floor
  only at 9.6 MHz, above the 8.5 MHz unity-gain frequency. The total input-referred
  density is 1.36 µV/√Hz at 1 kHz, 196 nV/√Hz at 100 kHz and still 30.1 nV/√Hz at
  100 MHz. Alone, the nfet's flicker corner is 13.9 MHz and the pfet's 0.51 MHz at
  these gate areas. Treat table-derived noise as a floor, not a budget.
