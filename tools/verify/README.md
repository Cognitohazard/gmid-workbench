# Simulation cross-checks for table-driven sizing

Small ngspice decks that close the loop between the shipped sky130 gm/ID tables
(`data/pdk/sky130/`, characterized at W = 1 µm) and the compact models they were
simulated from. Run them after touching the lookup or sizing math, after regenerating
the tables, or after changing the five-transistor OTA sheet. From the repository root:

    ngspice -b tools/verify/ota_op.cir

Each deck prints a short labelled list of numbers and writes no files. The header
comment of each deck states what the tables or the sheet predict for those numbers.

Each deck `.include`s the sky130A tt corner file from the PDK the table generator uses,
fetched into the repository's `.pdk/` directory
(`.pdk/sky130A/libs.tech/ngspice/corners/tt.spice`). ngspice resolves the path from the
directory it is started in, so run the decks from the repository root
(`ngspice -b tools/verify/ota_op.cir`). If your PDK lives elsewhere, edit the `.include`
line near the top of each deck. No `.spiceinit` is needed. The noise decks also print
`Source conductance reset to 1.0e3 mho` and `Drain conductance reset to 1.0e3 mho`
warnings; that is expected with these models.

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

## What the last run established

ngspice-42; sky130A as built by open_pdks `c6d73a35` (the version directory that
`.pdk/sky130A` points to is named after it); tt corner, 27 °C.

### The sheet against the simulated OTA

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
| Input-referred thermal noise density (`vn_in`)     | 28.44 nV/√Hz       | 28.24 nV/√Hz       | −0.7 %          |

Slew rate was not simulated; the sheet computes it as `tail__id/CL`, so it follows the
tail current.

Every current agrees within 0.05 %, every voltage within 1.2 mV, every gm, gm/ID and output
conductance within 1 %, the gain within 1.6 %, the offset within 0.9 %, the bandwidth within
0.8 % and the thermal noise within 0.7 %. The gate-source voltages sit about a millivolt low
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
  (0.81). With γ = 1 for both, the body effect counted, the row would read 25.1 nV/√Hz, 11 %
  low; with the body effect left out as well, 22.7 nV/√Hz, 20 % low.
  Neither γ is a constant: moving VG in the reference decks takes the nfet from 1.4 at
  gm/ID 22 to 1.9 at gm/ID 6–12, and the pfet from 0.5 at gm/ID 17 to 1.0 at gm/ID 4–8.
  This is consistent with the two models' thermal-noise parameters (`tnoimod = 1` in both;
  `rnoia` is 0.94 for the nfet and 0.69 for the pfet).

### Findings

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
