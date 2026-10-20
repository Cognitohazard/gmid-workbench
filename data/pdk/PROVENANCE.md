# gm/ID dataset — provenance & licensing

These CSV tables are **simulated** transistor gm/ID characterization data (id, gm, gds,
vth, vdsat, gmbs, gate capacitances, and the drain thermal- and flicker-noise current
PSDs `sth` and `sfl`, versus a `L · VSB · VDS · VGS` operating grid). They were produced
by running **ngspice-42** DC operating-point sweeps, and a noise analysis at every grid
point, over the SPICE compact models shipped in two open-source Process Design Kits. They
are **derived data**, not the original PDK model files — the upstream models are used
unmodified.

Each table is in the `mostab` interchange format (a metadata comment block, then a column
header, then one row per grid point; SI units; `vsb = -vbs`). Regenerate them from scratch
with `tools/gen_gmid.py` — a standalone recipe driving plain `ngspice -b` (no extra tooling;
needs only python + ngspice + a fetched PDK):

    PDK_ROOT=/path/to/pdks python3 tools/gen_gmid.py sky130 --out data/pdk
    PDK_ROOT=/path/to/pdks python3 tools/gen_gmid.py gf180  --out data/pdk

## Coverage

One `mostab` table per `(device, process corner, temperature)` — 99 tables total,
named `<device>__<corner>__<temp>C.mostab.csv`:

- **Process corners:** the three that move the transistor model — `tt`/`ss`/`ff`
  for sky130, `typical`/`ss`/`ff` for gf180mcu.
- **Temperatures:** −40, 27, and 125 °C (the standard verification bracket).
- **Devices (11):**
  - sky130 (W = 1 µm): `nfet_01v8`, `pfet_01v8`, `nfet_01v8_lvt`, `pfet_01v8_lvt`,
    `pfet_01v8_hvt` (1.8 V core, standard/low/high-Vt), plus the `nfet_g5v0d10v5` /
    `pfet_g5v0d10v5` 5 V-gate I/O pair.
  - gf180mcu (W = 10 µm): `nfet_03v3`, `pfet_03v3` (3.3 V) and `nfet_06v0`,
    `pfet_06v0` (6 V).

Native/zero-Vt and ESD devices are intentionally excluded: they ship as discrete
fixed-geometry models and cannot carry a continuous gm/ID length sweep.

Each table is a full grid over:

- **`vgs`:** from 0 up to the device's supply in 8 mV steps (negative for PMOS).
- **`vds`:** 0 to 0.3 V in 25 mV steps, where the drain current bends into saturation,
  then the coarser step to the supply: 0.2 V for sky130, VDD/12 for gf180mcu (0.275 V
  for the 3.3 V devices, 0.5 V for the 6 V ones). Negative for PMOS.
- **`vsb`:** 0, 0.3, 0.6 and 0.9 V.
- **`L`:** per device, from its minimum length to 2 µm.

**Noise.** `sth` and `sfl` come from a single-frequency ngspice noise analysis at 1 Hz at
every grid point: the squares of the device's channel thermal-noise and flicker-noise
drain-current densities. `sfl` is 0 where no drain current flows (`vds = 0`); at one such point (`nfet_01v8_lvt`,
ss, −40 °C, L = 2 µm, every terminal at 0 V) the simulator returns not-a-number for it, and
the generator writes 0 there, which it reports when it does. The sky130
`nfet_g5v0d10v5` tables carry `sfl` but no `sth`: that model's cards declare BSIM4
version 4.5, for which ngspice evaluates the channel thermal noise to not-a-number over
part of the strong-inversion triode region at L ≤ 1 µm, and a table cell must be a
finite number.

## Sources & attribution

Both PDKs are licensed under the **Apache License, Version 2.0** (full text in
`Apache-2.0.txt`). Apache-2.0 §2 grants the right to reproduce and distribute the work and
derivative works, including commercially; this dataset is redistributed under that grant
with the attribution below. The statement that the data was produced by DC sweeps and
noise analyses (rather than being the original files) also satisfies Apache-2.0 §4(b)
("state changes").

### sky130 (`data/pdk/sky130/`)
- **SkyWater Open Source PDK**, variant `sky130A`.
- © **The SkyWater PDK Authors** (incl. Google LLC, SkyWater Technology, Efabless). Apache-2.0.
- Upstream: https://github.com/google/skywater-pdk and the
  `skywater-pdk-libs-sky130_fd_pr` device-model library.
- PDK build used: open_pdks / volare commit `c6d73a35f524070e85faff4a6a9eef49553ebc2b`.

### gf180mcu (`data/pdk/gf180mcu/`)
- **GlobalFoundries 180nm MCU Open PDK**, variant `gf180mcuD`.
- © **GlobalFoundries PDK Authors** (incl. GlobalFoundries, Google LLC, Efabless, Mabrains). Apache-2.0.
- Upstream: https://github.com/google/gf180mcu-pdk
- PDK build used: open_pdks / volare commit `c6d73a35f524070e85faff4a6a9eef49553ebc2b`.

## Disclaimers

- **Simulated, not measured.** These are model-predicted values from compact-model DC
  sweeps, for design exploration — not silicon measurements and not a substitute for foundry
  characterization data.
- **AS-IS, no warranty**, consistent with Apache-2.0 §7/§8 of the source PDKs.
- The **gf180mcu** PDK is published by its authors as *not intended for production* use; that
  caveat carries through to data derived from it.

First generated 2026-06-30 with ngspice-42; regenerated with ngspice-42 to add the noise
columns and the 25 mV drain-voltage steps.
