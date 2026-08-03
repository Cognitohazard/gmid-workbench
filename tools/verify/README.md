# Simulation cross-checks for table-driven sizing

Small ngspice decks that close the loop between the shipped sky130 gm/ID tables
(`data/pdk/sky130/`, characterized at W = 1 µm) and the compact models they were
derived from. Run them after touching the lookup/sizing math or regenerating data:

    cd tools/verify
    ngspice -b dana_op.cir

Each deck hardcodes an `.include` of the sky130A tt corner file from a volare
install (`~/.volare/sky130A/libs.tech/ngspice/corners/tt.spice`) — ngspice does
not expand environment variables, so point the `.include` line at the top of
each deck at your own PDK before running.

## Decks

- `dana_op.cir` — one nfet_01v8 at a bind-any-2 solution read off the app
  (gm = 1 mS, gm/ID = 15, L = 0.5 µm, VDS = 0.9 V → W = 25.77 µm, VGS = 718.4 mV).
- `ota_op.cir` / `ota_ac.cir` / `ota_noise.cir` — a 5T OTA sized from the library
  sheet (nfet pair 5.7/0.5, pfet mirror 9.26/1, ideal 35.86 µA tail — the sheet's
  noise row has no tail term, so the testbench matches that assumption; CL = 2 pF).
- `cs_n_noise.cir` / `cs_p_noise.cir` — single-device noise references at the OTA
  bias points (noiseless resistor loads), used to separate per-device density from
  topology factors.

## What the last run established (ngspice-42, sky130A c6d73a35)

- **Interpolation is exact at the characterization width.** Table lookup at
  W = 1 µm matches `.op` within 0.5 % on id/gm/gds.
- **Width scaling is the dominant sizing error.** A single-finger W = 25.77 µm
  device conducts up to 1.9× more per µm than the W = 1 µm table (worst in
  moderate inversion, gm/ID 13–18) — sky130 bins and width effects are real.
  Realized as fingers of the characterization width (nf = 26 × ~1 µm) the same
  W tracks the table to 0.2 %. **Realize table-derived W as N fingers of the
  characterization width.** Current-biased circuits self-correct most of the
  residual error (the 5T pair landed at gm/ID 14.7 vs the designed 14, gm +5 %).
- **5T OTA meets its sheet spec in simulation**: unity-gain crossing 20.6 MHz
  vs the 20 MHz GBW target; mirror gm/ID 8.1 vs 8.
- **Input-referred noise is two-sided.** Across the flicker-dominated band the
  simulated OTA input noise is ≥ 2.25× the one-side per-device composition —
  the differential pair and mirror each contribute twice. Sheet noise rows must
  carry the factor 2 inside the sqrt.
- **Model reality checks**: the pfet_01v8 thermal floor implies γ ≈ 1.0 (now the
  derived quantities' default; the long-channel 2/3 understates it), and sky130 flicker dominates the nfet input
  noise to ~100 MHz at these gate areas — thermal-only densities are optimistic
  in-band. Treat table-derived noise as a floor, not a budget.
