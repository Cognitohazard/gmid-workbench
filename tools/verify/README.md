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
  all three OTA decks, with `CM_dc` on VCM, `V_out_dc` on VREF and `I_tail` on IB;
- `in__W` to the `m=` of `cs_n_noise.cir`, with `in__vgs`, `V_out_dc − V_tail` and
  `V_tail` on its VG, VD and VB (VB is negative: the body sits below the source);
- `ldr__W` to the `m=` of `cs_p_noise.cir`, with `ldr__vgs` on both its VG and VD;
- the values each deck quotes in its header comment.

Two choices in the OTA decks go beyond what the sheet states:

- **Widths are multiples of the 1 µm device.** The sized widths (2.5031, 1.7696 and
  2.5268 µm) are not whole numbers of microns, so each device is the 1 µm single-finger
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

| Quantity                                       | Sheet        | Simulated    | Difference |
| ---------------------------------------------- | ------------ | ------------ | ---------- |
| Tail current (`tail__id`, also `I_q`)          | 17.875 µA    | 18.091 µA    | +1.2 %     |
| … as a share of the programmed 20 µA           | 89.4 %       | 90.5 %       |            |
| Tail node (`V_tail`)                           | 274.4 mV     | 271.0 mV     | −3.4 mV    |
| Bias reference VGS, shared with the tail       | 810.56 mV    | 810.59 mV    | +0.03 mV   |
| Bias reference gm/ID                           | 10.00        | 10.00        | −0.03 %    |
| Tail gm/ID                                     | 9.80         | 9.93         | +1.3 %     |
| Pair current, output side (`in__id`)           | 8.937 µA     | 8.973 µA     | +0.4 %     |
| Pair current, diode side                       | 8.937 µA     | 9.119 µA     | +2.0 %     |
| Pair VGS, output side (`in__vgs`)              | 825.6 mV     | 826.6 mV     | +1.0 mV    |
| Pair gm, output side (`in__gm`)                | 107.25 µS    | 108.49 µS    | +1.2 %     |
| Pair gm/ID, output side                        | 12.00        | 12.09        | +0.8 %     |
| Load current, diode side                       | 8.937 µA     | 9.119 µA     | +2.0 %     |
| Load current, output side (`ld__id`)           | 8.794 µA     | 8.973 µA     | +2.0 %     |
| Load VGS, both sides (`ldr__vgs`)              | −1132.2 mV   | −1134.7 mV   | −2.5 mV    |
| Load gm/ID, diode side / output side           | 8.00 / 8.01  | 7.93 / 7.94  | −0.9 %     |
| Low-frequency gain (`Av`)                      | 53.78        | 53.83        | +0.1 %     |
| Unity-gain frequency (`GBW`)                   | 8.535 MHz    | 8.396 MHz    | −1.6 %     |
| Phase margin (`PM`)                            | 89.7°        | 90.7°        | +1.0°      |
| Input-referred thermal noise density (`vn_in`) | 22.67 nV/√Hz | 28.25 nV/√Hz | +25 %      |
| Current the load mirror's two sides differ by  | 0.143 µA     | 0.146 µA     | +2 %       |
| Input offset that holds `V_out_dc` (`vos_sys`) | 1.33 mV      | 4.81 mV      | 3.6×       |

Slew rate was not simulated; the sheet computes it as `tail__id/CL`, so it follows the
tail current.

Every current, voltage, gm and gm/ID agrees within 2.6 %, and gain and bandwidth within
2 %. Two lines do not agree, and both come from what the sheet models rather than from
the tables:

- **The thermal-noise figure reads 20 % low, because of the nfet.** The simulated
  thermal floor is 28.25 nV/√Hz, flat from 1 Hz to beyond 10 MHz. It is read at 1 kHz as
  the total less every device's flicker term, because the total itself is
  flicker-dominated there. The reference decks trace the gap to one device type. At the
  pair's bias point the nfet's own density is 17.36 nV/√Hz where the tables' γ = 1
  model gives 12.44: an effective γ of 1.95. At the load's bias point the pfet's is
  15.24 nV/√Hz against 15.23: an effective γ of 1.00. Putting the simulated densities
  into the sheet's own formula gives 28.4 nV/√Hz, so the formula is right and the nfet's
  γ is not. Neither γ is a constant: moving VG in the reference decks takes the nfet
  from 1.4 at gm/ID 22 to 1.9 at gm/ID 6–12, and the pfet from 0.5 at gm/ID 17 to 1.0 at
  gm/ID 4–8. This is consistent with the two models' thermal-noise parameters
  (`tnoimod = 1` in both; `rnoia` is 0.94 for the nfet and 0.69 for the pfet).
- **`vos_sys` counts the load mirror and not the pair.** The sheet's figure is the
  current by which the mirror's two sides differ, divided by the pair's gm, and the
  simulation confirms that current (0.146 µA against 0.143 µA). But the pair's two
  devices sit at different drain voltages for the same reason the mirror's do: the
  diode-side drain is one PMOS VGS below the supply (0.665 V) while the output-side
  drain is at `V_out_dc` (0.9 V). With the inputs balanced and the output forced to
  0.9 V, the output-side pair device carries 0.37 µA more than its partner, and the
  output node is short of 0.51 µA in total, not 0.14 µA. Referred to the input, that is
  the 4.81 mV the servo applies. The figure's sign and its zero (output one PMOS VGS
  below the supply) are right; its size at the shipped defaults is 3.6× too small. To
  reproduce the balanced-input numbers, replace GSV and CSV in `ota_op.cir` with a 0.9 V
  source on `out` and a resistor from `os` to ground, and read the source's current.

### Findings

- **The tail delivers less than it is programmed to, as the sheet says.** The tail
  device shares the bias reference's gate, but its drain sits at 0.27 V where the
  reference's sits at its 0.81 V diode drop, so it delivers 18.09 µA of the programmed
  20 µA. The sheet predicts 17.87 µA. The 1.2 % between them comes from the tables'
  0.2 V VDS grid: the tail's drain falls between the 0.2 V and 0.4 V nodes, just above
  its 0.16 V saturation voltage, where the curve still bends and straight-line
  interpolation reads the current low and the output conductance high (`tail__gds` is
  11.5 µS against a simulated 7.6 µS). Nothing on the sheet reads that conductance. The
  tail and the bias reference together add 0.07 % to the input-referred thermal noise
  power, so the sheet is right to leave them out of `vn_in`.
- **Interpolation is exact at the characterization width.** At the `nfet_width_op.cir`
  point the 1 µm device, scaled by its multiplier, matches the table lookup to −0.06 %
  on id, +0.01 % on gm and −0.5 % on gds. The pfet at the load's bias point matches to
  0.03 % on id and gm. The grid shows in two places in the OTA: the tail's drain
  (above), and the pair's 0.27 V body bias, which falls between the 0 V and 0.3 V VSB
  nodes. At the sheet's exact coordinates the model gives 8.790 µA where the table
  reads 8.937 µA (−1.6 %), with gm within 0.13 %; `cs_n_noise.cir` prints both.
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
  `W=1.7696 nf=2`, `W=2.5268 nf=3`, plus `.option wnflag=1`) leaves every current, gm,
  the gain and the unity-gain frequency within 0.3 % of the simulated column above;
  only the gate voltages move, by up to 10 mV. As single fingers (`nf=1`) the same
  widths move further from that column: a tail current of 18.46 µA (+2.0 %), a pair gm
  of 112.6 µS (+3.8 %) at gm/ID 12.3, a gain of 58.9 (+9 %) and a unity-gain frequency
  of 8.70 MHz (+3.6 %).
- **The 5T OTA meets its gain and bandwidth specs in simulation.** Gain is 53.8 against
  a target of 15, and the unity-gain frequency is 8.40 MHz against a target of 8 MHz.
  It is 1.6 % below the sheet's `GBW` because the mirror passes on the diode side's
  half of the signal with a gain a little under one: 2π × 8.396 MHz × 2 pF is 105.5 µS
  of effective transconductance, where the two pair devices have 108.0 and 108.5 µS
  and the sheet reads 107.25 µS. The devices add only about 1 fF to the 2 pF load.
- **Input-referred noise is two-sided.** The two pair devices contribute 17.16 and
  17.31 nV/√Hz of thermal noise at the input, and the two load devices 9.86 and
  10.30 nV/√Hz. All four together give 1.40× the density of one pair device and one
  load device, which is the factor of 2 in power that the sheet's `vn_in` carries. The
  same 1.40× holds in the flicker band: 1.37 µV/√Hz at 1 kHz against 0.98 µV/√Hz
  composed from the two reference decks.
- **Flicker dominates in-band.** In the OTA the flicker part falls to the thermal floor
  only at 9.8 MHz, above the 8.4 MHz unity-gain frequency. The total input-referred
  density is 1.37 µV/√Hz at 1 kHz, 198 nV/√Hz at 100 kHz and still 30.3 nV/√Hz at
  100 MHz. Alone, the nfet's flicker corner is 13.9 MHz and the pfet's 0.51 MHz at
  these gate areas. Treat table-derived noise as a floor, not a budget.
