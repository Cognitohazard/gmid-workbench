#!/usr/bin/env python3
"""gen_gmid — standalone gm/ID dataset generator (plain ngspice; no MCP, no agent).

This is the reproducible recipe behind the shipped tables. For every
``(device, corner, temp, L, vsb)`` in the matrix below it:
  1. builds a self-running ngspice deck (``gmid_decks.build_deck(..., wrdata_to=)``)
     that sweeps the DC grid twice — the full drain-voltage range at the PDK's step,
     then 0..0.3 V at 25 mV — and runs a 1 Hz noise analysis at every grid point,
  2. runs it under ``ngspice -b`` (a project ``.spiceinit`` sets ``ngbehavior=hsa``
     so the PDKs' sectioned ``.lib`` parse correctly),
  3. parses the headerless ``wrdata`` egress positionally, merges the two sweeps into
     one drain-voltage axis, and joins each point's noise to it by its (vgs, vds),
  4. assembles one ``mostab`` table per device with Apache-2.0 attribution, and
  5. runs a generation-side sanity gate (grid, finiteness, polarity, gm/Id range,
     noise sign and noise factor).

Requires only python + ngspice + a fetched PDK. Point ``PDK_ROOT`` at it.

    PDK_ROOT=/path/to/pdks python3 tools/gen_gmid.py sky130 --out data/pdk
    PDK_ROOT=/path/to/pdks python3 tools/gen_gmid.py gf180  --out data/pdk

(Fetch the PDKs first, e.g. `volare enable --pdk sky130 <hash>` /
`--pdk gf180mcu <hash>`; see data/pdk/PROVENANCE.md for the build used.)
"""
from __future__ import annotations

import argparse
import csv
import itertools
import math
import os
import subprocess
import sys
import tempfile

from gmid_decks import (
    GF180,
    NOISE_PARAMS,
    SAVE_PARAMS,
    SKY130,
    _g,
    build_deck,
    parse_wrdata_row,
    wrdata_columns,
)
from mostab_io import write_mostab

SIM = "ngspice-42"

# Per-PDK attribution stamped into each table's meta (both PDKs are Apache-2.0;
# see data/pdk/PROVENANCE.md for the full notice). The data is DERIVED (DC sweeps
# of the compact models), which also satisfies Apache-2.0 §4(b) "state changes".
SOURCES = {
    "sky130": "SkyWater Open Source PDK sky130A (c) The SkyWater PDK Authors; "
              "Apache-2.0; derived data simulated with ngspice (not the model files)",
    "gf180mcu": "GF180MCU Open PDK gf180mcuD (c) GlobalFoundries PDK Authors; "
                "Apache-2.0; derived data simulated with ngspice (not the model files)",
}

VGS_STEP = 0.008  # 10 mV is the workbench's gm/ID-fidelity bar; 8 mV clears it with margin.

# (step, stop) of the fine drain-voltage sweep added below each PDK's coarse vds step.
# A device's current bends hardest between vds = 0 and a little above its saturation
# voltage, and interpolating a coarse grid there reads it low: for the sky130 nfet at
# L = 0.5 um, vgs = 0.81 V, vds = 0.186 V (vdsat 0.16 V), the 0.2 V grid reads id 5.6 %
# low and gds 45 % high, the 25 mV grid 0.1 % low and 3 % high.
VDS_FINE = (0.025, 0.3)

BOLTZMANN = 1.380649e-23  # J/K, for the noise-factor sanity check
# The window the noise factor is expected in at full drive (see _qa): sth/(4kT (gm + gmb)), the
# workbench's own definition of gamma, where the table carries gmb, and sth/(4kT gm) where not.
NOISE_FACTOR_LO, NOISE_FACTOR_HI = 0.01, 100
# The temperature _qa reads a table at when it carries no `# temp:` line (the generator always
# writes one); said in the warnings whenever it is used.
DEFAULT_TEMP_C = 27.0

# Noise columns a device's tables leave out, with the reason. The sky130 5 V nfet's model
# cards declare BSIM4 version 4.5, and for that version ngspice evaluates the channel
# thermal noise (tnoimod = 1) to NaN over the strong-inversion triode region at
# L <= 1 um (at L = 0.5 um, vgs above 2.3-2.8 V with vds below 1.0-1.2 V, at each of
# tt/27 C, ss/-40 C and ff/125 C); the same cards with the version set to 4.8 give finite
# values there. A mostab cell must be a finite number, so its tables carry sfl, which is
# finite everywhere, but no sth.
NOISE_OMIT = {"sky130_fd_pr__nfet_g5v0d10v5": {"sth"}}

# The matrix IS the spec: per device a valid-L grid (respecting each device's
# model-bin min L); per PDK the corner LIST, temperature LIST, char width, vsb
# sweep, and coarse vds step (VDS_FINE adds the dense points near zero). Every
# (device x corner x temp) combination yields one mostab table (named
# <device>__<corner>__<temp>C.mostab.csv).
#
# Corners: only the process corners that change the FET model (tt/ss/ff for the
# transistor itself; sky130's sf/fs are N-vs-P skew, _mm/mc are statistical, and
# ll/hh are interconnect-only — all out of scope for a per-device gm/ID table).
# Temps: the standard -40/27/125 C verification bracket. Devices: the standard
# analog-sizing flavors only; native/zero-Vt devices (nfet_*_nvt) are excluded
# because they ship as discrete fixed-geometry ESD models, not continuously
# sizable transistors, so they cannot carry a gm/ID L-sweep.
MATRIX = {
    "sky130": {
        "pdk": SKY130, "W_um": 1.0,
        "corners": ["tt", "ss", "ff"], "temps": [27.0, -40.0, 125.0],
        "vsb": [0.0, 0.3, 0.6, 0.9], "vds_step": lambda vdd: 0.2,
        "devices": [
            ("sky130_fd_pr__nfet_01v8", "n", 1.8, [0.15, 0.18, 0.25, 0.5, 1.0, 2.0]),
            ("sky130_fd_pr__pfet_01v8", "p", 1.8, [0.15, 0.18, 0.25, 0.5, 1.0, 2.0]),
            ("sky130_fd_pr__nfet_01v8_lvt", "n", 1.8, [0.15, 0.18, 0.25, 0.5, 1.0, 2.0]),
            ("sky130_fd_pr__pfet_01v8_lvt", "p", 1.8, [0.35, 0.5, 1.0, 2.0]),  # lvt pfet min L = 0.35u
            ("sky130_fd_pr__pfet_01v8_hvt", "p", 1.8, [0.15, 0.18, 0.25, 0.5, 1.0, 2.0]),  # completes the 1.8V Vt triad
            ("sky130_fd_pr__nfet_g5v0d10v5", "n", 5.0, [0.5, 0.7, 1.0, 2.0]),  # 5V-gate/10.5V-drain I/O NMOS (min L 0.5u)
            ("sky130_fd_pr__pfet_g5v0d10v5", "p", 5.0, [0.5, 0.7, 1.0, 2.0]),  # 5V-gate/10.5V-drain I/O PMOS
        ],
    },
    "gf180": {
        "pdk": GF180, "W_um": 10.0,
        "corners": ["typical", "ss", "ff"], "temps": [27.0, -40.0, 125.0],
        "vsb": [0.0, 0.3, 0.6, 0.9], "vds_step": lambda vdd: vdd / 12.0,
        "devices": [
            ("nfet_03v3", "n", 3.3, [0.28, 0.5, 1.0, 2.0]),
            ("pfet_03v3", "p", 3.3, [0.28, 0.5, 1.0, 2.0]),
            ("nfet_06v0", "n", 6.0, [0.6, 1.0, 2.0]),
            ("pfet_06v0", "p", 6.0, [0.6, 1.0, 2.0]),
        ],
    },
}


def _run_one(pdk, subckt, t, vdd, corner, temp, L_um, W_um, vsb, vds_step, workdir, ngspice):
    """Run one deck, return [(vgs, vds, [params..., sth, sfl])] for every grid point."""
    cir, out, nout = (os.path.join(workdir, n) for n in ("d.cir", "d.csv", "n.txt"))
    deck = build_deck(pdk, subckt=subckt, dev_type=t, vdd=vdd, corner=corner, temp=temp,
                      L_um=L_um, W_um=W_um, vsb=vsb, vgs_step=VGS_STEP, vds_step=vds_step,
                      vds_fine=VDS_FINE, wrdata_to="d.csv", noise_to="n.txt")
    with open(cir, "w") as f:
        f.write(deck)
    for path in (out, nout):  # the deck appends to both, so start each run without them
        if os.path.exists(path):
            os.remove(path)
    r = subprocess.run([ngspice, "-b", "d.cir"], cwd=workdir, capture_output=True,
                       text=True, timeout=600)
    where = f"{subckt} L={L_um} vsb={vsb}"
    if not os.path.exists(out) or not os.path.exists(nout):
        raise RuntimeError(f"{where}: ngspice wrote no output\n{r.stderr[-600:]}")
    rows, skipped = _read_rows(out, wrdata_columns(), parse_wrdata_row)
    noise, nskipped = _read_rows(nout, 2 + len(NOISE_PARAMS),
                                 lambda v: ((_g(v[0]), _g(v[1])), v[2:]))
    if not rows:
        raise RuntimeError(f"{where}: empty wrdata")
    if skipped or nskipped:  # surface silent data loss rather than shipping a short table as valid
        print(f"   note: {where}: skipped {skipped} unparseable wrdata line(s) and "
              f"{nskipped} unparseable noise line(s)", file=sys.stderr)
    return _join(rows, dict(noise), where)


def _read_rows(path, ncol, decode):
    """Parse a whitespace-separated numeric egress file: each line with at least
    ``ncol`` numbers is passed (its first ``ncol``) to ``decode``. Returns
    ``(decoded rows, count of non-blank lines that were not)``."""
    rows, skipped = [], 0
    with open(path) as f:
        for line in f:
            parts = line.split()
            if len(parts) < ncol:
                if parts:  # a non-blank but malformed line; blank lines don't count
                    skipped += 1
                continue
            try:
                v = [float(x) for x in parts[:ncol]]
            except ValueError:
                skipped += 1
                continue
            rows.append(decode(v))
    return rows, skipped


def _join(rows, noise, where=""):
    """Merge one run's DC rows into one grid and attach each point's noise.

    ``rows`` are ``(vgs, vds, params)`` in file order: the coarse sweep, then the fine
    sweep appended. A grid point is its formatted (vgs, vds) coordinate; where both
    sweeps visit one (vds = 0, and coarse values inside the fine range) the coarse row,
    which comes first, is kept, so every point of the coarse grid carries exactly the
    values a coarse-only sweep gives. ``noise`` maps each coordinate to its noise
    values. The two must cover the same points: a point with DC data and no noise, or
    the reverse, is an error, never a gap filled in. Returns the merged rows ordered by
    |vds| then |vgs| (the coarse sweep's own order), each with the noise appended.
    """
    pts = {}
    for vgs, vds, params in rows:
        pts.setdefault((_g(vgs), _g(vds)), (vgs, vds, params))
    no_noise, no_dc = pts.keys() - noise.keys(), noise.keys() - pts.keys()
    if no_noise or no_dc:
        example = min(no_noise or no_dc)
        raise RuntimeError(f"{where}: noise and DC grids disagree: {len(no_noise)} DC "
                           f"point(s) without noise, {len(no_dc)} noise point(s) without "
                           f"DC (e.g. vgs={example[0]} vds={example[1]})")
    ordered = sorted(pts.items(), key=lambda kv: (abs(kv[1][1]), abs(kv[1][0])))
    # Flicker noise is zero where no drain current flows. At a point with id exactly 0 the
    # simulator can return a non-finite flicker value instead (0/0 inside the model); that is
    # the one non-finite value with a physical reading, and it is written as 0 and counted
    # aloud. Every other non-finite value stays as it is, for the sanity gate to refuse.
    i_id, i_sfl = SAVE_PARAMS.index("id"), NOISE_PARAMS.index("sfl")
    zeroed = 0
    merged = []
    for key, (vgs, vds, params) in ordered:
        nz = list(noise[key])
        if (len(params) > i_id and len(nz) > i_sfl and params[i_id] == 0
                and not math.isfinite(nz[i_sfl])):
            nz[i_sfl] = 0.0
            zeroed += 1
        merged.append((vgs, vds, [*params, *nz]))
    if zeroed:
        print(f"   note: {where}: {zeroed} flicker value(s) at zero drain current were "
              f"non-finite and are written as 0")
    return merged


def _qa(path, dev_type, noise=tuple(NOISE_PARAMS), lengths=None, vsbs=None):
    """Sanity-check one assembled mostab. Returns ``(faults, warns)`` — two message
    lists. Any ``faults`` is a HARD problem — a missing column, a non-finite value, a
    column that is 0 at every point, a duplicated or incomplete grid, a length or body
    bias missing from the matrix, a dead device, a sweep-axis polarity mix-up, or a
    noise PSD of the wrong sign — and fails the generator's exit code. ``warns`` are
    soft suspicions (a gm/Id peak or a noise factor outside its sane window) that a
    valid corner device can trip, and the checks that could not run or ran on a
    default, so they don't fail. The real data-trust gate is the workbench importer +
    ``qa``; this catches gross generation faults before anything ships. Severity is
    decided by which list a check appends to. ``noise`` names the noise columns the
    table must carry (all of them unless ``NOISE_OMIT`` drops one); ``lengths`` (um)
    and ``vsbs`` (V), when given, are the matrix the table was generated over, every
    pair of which must be in it.
    """
    with open(path) as f:
        lines = f.read().splitlines()
    temp = next((float(ln.split(":", 1)[1]) for ln in lines
                 if ln.lower().startswith("# temp:")), None)
    rows = [r for r in csv.reader(lines) if r and not r[0].startswith("#")]
    head, data = rows[0], rows[1:]
    col = {name: i for i, name in enumerate(head)}
    for k in ("L", "VDS", "VSB", "VGS", "ID", "GM", "GDS", *(n.upper() for n in noise)):
        if k not in col:
            return [f"missing column {k}"], []
    faults, warns = [], []
    if temp is None:
        temp = DEFAULT_TEMP_C
        warns.append(f"no # temp: line — read at {DEFAULT_TEMP_C:g} C for the noise factor")
    # finiteness
    bad = sum(1 for r in data for v in r if v in ("nan", "inf", "-inf"))
    if bad:
        faults.append(f"{bad} non-finite values")
    # A column that is 0 at every point is not data: ngspice writes 0 for an op-point
    # parameter the model does not provide (an unrecognized save), and a table would ship
    # it as a measured value.
    axes = {"L", "VDS", "VSB", "VGS"}
    for name, i in col.items():
        if name not in axes and data and all(_num(r[i]) == 0 for r in data):
            faults.append(f"{name} is 0 at every point — a parameter the model does not "
                          f"provide is written as 0, so the column is not data")
    # noise sign: channel thermal noise is present at every bias, even with no current
    # (vds = 0); flicker noise scales with the drain current, so it is 0 exactly where
    # none flows and positive everywhere else.
    if "sth" in noise:
        sth_bad = sum(1 for r in data if not float(r[col["STH"]]) > 0)
        if sth_bad:
            faults.append(f"STH has {sth_bad} non-positive value(s)")
    if "sfl" in noise:
        sfl_neg = sum(1 for r in data if float(r[col["SFL"]]) < 0)
        if sfl_neg:
            faults.append(f"SFL has {sfl_neg} negative value(s)")
        sfl_zero = sum(1 for r in data
                       if float(r[col["SFL"]]) == 0 and float(r[col["ID"]]) != 0)
        if sfl_zero:
            faults.append(f"SFL is 0 at {sfl_zero} point(s) that carry drain current")
    # grid completeness: every (L,VSB) block must be a duplicate-free, complete
    # rectangular VGS x VDS grid. Every coordinate lies in xs*ys by construction, so a
    # unique count below len(xs)*len(ys) means a missing point, and a row count above the
    # unique count means a duplicate masking one (e.g. two sweep values that collapse to
    # the same formatted coordinate).
    blocks = {}
    for r in data:
        blocks.setdefault((r[col["L"]], r[col["VSB"]]), []).append((r[col["VGS"]], r[col["VDS"]]))
    for (L, vsb), pts in blocks.items():
        xs, ys, uniq = {p[0] for p in pts}, {p[1] for p in pts}, set(pts)
        if len(uniq) != len(pts):
            faults.append(f"L={L} vsb={vsb}: {len(pts) - len(uniq)} duplicate (VGS,VDS) point(s)")
        if len(uniq) != len(xs) * len(ys):
            faults.append(f"L={L} vsb={vsb}: grid {len(xs)}x{len(ys)} incomplete "
                          f"({len(uniq)} of {len(xs) * len(ys)} points)")
    # Every (L, vsb) pair of the matrix is a block. A length whose every run failed leaves no
    # rows at all, and the table would import as one with a shorter length axis; a pair
    # missing beside its siblings leaves a grid the importer refuses. Both are said here.
    if lengths is not None and vsbs is not None:
        have = set(blocks)
        for L in lengths:
            Ls = _g(L * 1e-6)
            missing = [_g(v) for v in vsbs if (Ls, _g(v)) not in have]
            if len(missing) == len(vsbs):
                faults.append(f"L={Ls}: no rows — the length is missing from the table")
            elif missing:
                faults.append(f"L={Ls}: no rows at vsb={', '.join(missing)}")
    # physical: id/W at strong inversion, gm/Id peak, polarity. Use the smallest-L,
    # vsb=0 block at max |VGS|,|VDS|.
    v0 = [r for r in data if r[col["VSB"]] == "0"]
    if not v0:
        warns.append("no vsb = 0 rows — the full-drive checks (dead device, polarity, gm/Id "
                     "peak, noise factor) did not run")
    if v0:
        Lmin = min(v0, key=lambda r: float(r[col["L"]]))[col["L"]]
        blk = [r for r in v0 if r[col["L"]] == Lmin]
        drive = max(blk, key=lambda r: abs(float(r[col["VGS"]])) + abs(float(r[col["VDS"]])))
        idv, vgsv = float(drive[col["ID"]]), float(drive[col["VGS"]])
        # ngspice + workbench PMOS convention: MAGNITUDE id/gm/gds, SIGNED-negative vgs axis.
        # So check the device is alive (|id| sane) and the sweep axis sign matches the type.
        if abs(idv) < 1e-9:
            faults.append(f"id={idv:.2e} ~0 at full drive (dead device?)")
        if dev_type == "p" and vgsv >= 0:
            faults.append(f"PMOS vgs={vgsv} >=0 (expected signed-negative axis)")
        if dev_type == "n" and vgsv <= 0:
            faults.append(f"NMOS vgs={vgsv} <=0 (expected positive axis)")
        # gm/Id peak across the smallest-L vsb=0 sweep should land in a sane window
        ratios = [abs(float(r[col["GM"]])) / abs(float(r[col["ID"]]))
                  for r in blk if abs(float(r[col["ID"]])) > 1e-12]
        if ratios:
            pk = max(ratios)
            if not (5 < pk < 60):
                warns.append(f"gm/Id peak {pk:.1f} outside [5,60] (suspect)")
        # noise factor at full drive: between about 0.2 and 12 for these models, so a value
        # far outside the window is a unit slip (a density left unsquared is off by about
        # 1e12, a lost 4kT by about 1e20). Read as the workbench reads gamma: against
        # gm + gmb where the table carries gmb, against gm alone where it does not.
        gmv = abs(float(drive[col["GM"]]))
        gmb = abs(float(drive[col["GMBS"]])) if "GMBS" in col else None
        form = "sth/(4kT gm)" if gmb is None else "sth/(4kT (gm + gmb))"
        g = gmv + (gmb or 0.0)
        if "sth" in noise and g > 0:
            nf = float(drive[col["STH"]]) / (4 * BOLTZMANN * (temp + 273.15) * g)
            if not (NOISE_FACTOR_LO < nf < NOISE_FACTOR_HI):
                warns.append(f"noise factor {form} {nf:.3g} at full drive outside "
                             f"[{NOISE_FACTOR_LO},{NOISE_FACTOR_HI}] (suspect)")
    return faults, warns


def _num(cell):
    """A table cell as a number; a non-finite or unreadable one is NaN (the finiteness check
    reports those)."""
    try:
        return float(cell)
    except ValueError:
        return math.nan


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("pdk", choices=list(MATRIX))
    ap.add_argument("--out", default="data/pdk")
    ap.add_argument("--ngspice", default=os.environ.get("NGSPICE", "ngspice"))
    ap.add_argument("--only", default=None, metavar="SUBSTRING",
                    help="generate only the tables whose <device>__<corner>__<temp>C name "
                         "contains SUBSTRING (one table re-run after a fix)")
    args = ap.parse_args(argv)

    spec = MATRIX[args.pdk]
    pdk, W = spec["pdk"], spec["W_um"]
    corners, temps = spec["corners"], spec["temps"]
    outdir = os.path.join(args.out, pdk.name)
    os.makedirs(outdir, exist_ok=True)
    # TemporaryDirectory cleans the scratch decks/rawfiles on exit (incl. errors).
    with tempfile.TemporaryDirectory(prefix="gen_gmid_") as workdir:
        # ngbehavior=hsa (sourced from CWD) so sectioned `.lib file corner` parses
        # (the default ngbehavior's LTspice-compat mode reads the corner as a filename).
        with open(os.path.join(workdir, ".spiceinit"), "w") as f:
            f.write("set ngbehavior=hsa\n")

        ntab = len(corners) * len(temps) * len(spec["devices"])
        print(f"== {pdk.name}: {ntab} tables ({len(spec['devices'])} devices x "
              f"{len(corners)} corners x {len(temps)} temps) into {outdir} "
              f"(ngspice={args.ngspice}) ==")
        failures = 0    # decks that failed to run
        qa_faults = 0   # assembled tables that failed the sanity gate
        # product() iterates leftmost-slowest, so corner/temp stay outer and the
        # nominal (tt/typical, 27C) tables still generate first.
        for corner, temp, (subckt, t, vdd, LS) in itertools.product(corners, temps, spec["devices"]):
            if args.only and args.only not in f"{subckt}__{corner}__{int(temp)}C":
                continue
            vds_step = spec["vds_step"](vdd)
            # Every run yields SAVE_PARAMS then NOISE_PARAMS; keep all but the omitted.
            noise = [n for n in NOISE_PARAMS if n not in NOISE_OMIT.get(subckt, ())]
            cols = [*SAVE_PARAMS, *NOISE_PARAMS]
            names = [*SAVE_PARAMS, *noise]
            keep = [cols.index(c) for c in names]
            rows = []
            failed = []  # the runs of this table that did not run, said in its header
            for L in LS:
                for vsb in spec["vsb"]:
                    try:
                        pts = _run_one(pdk, subckt, t, vdd, corner, temp, L, W, vsb,
                                       vds_step, workdir, args.ngspice)
                    except Exception as e:  # noqa: BLE001 — report and continue the matrix
                        print(f"   FAIL {subckt} {corner}/{int(temp)}C L={L} vsb={vsb}: {e}",
                              file=sys.stderr)
                        failures += 1
                        failed.append(f"L={_g(L)}u vsb={_g(vsb)}")
                        continue
                    for vgs, vds, params in pts:
                        rows.append([_g(L * 1e-6), _g(vds), _g(vsb), _g(vgs)]
                                    + [_g(params[i]) for i in keep])
            # Polarity is stamped explicitly for BOTH device types, and pdk names the
            # technology: together with the device name they are the identity the app
            # groups corner variants by, so an undeclared field would fall back to
            # name-only grouping.
            meta = {"mostab": "0.1", "device": subckt, "corner": corner, "temp": temp,
                    "W": W * 1e-6, "simulator": SIM, "license": "Apache-2.0",
                    "source": SOURCES.get(pdk.name, pdk.name),
                    "pdk": pdk.name, "polarity": t}
            # A table some of whose runs failed is still written, so the runs that did finish
            # can be looked at, but its header says which are missing, and the exit code is 1.
            if failed:
                meta["note"] = (f"incomplete: {len(failed)} run(s) failed and are missing "
                                f"from this table ({'; '.join(failed)})")
            out = os.path.join(outdir, f"{subckt}__{corner}__{int(temp)}C.mostab.csv")
            write_mostab(out, ["l", "vds", "vsb", "vgs", *names], rows, meta)
            faults, warns = _qa(out, t, noise, lengths=LS, vsbs=spec["vsb"])
            if faults:
                qa_faults += 1
            tag = "FAIL" if faults else ("WARN" if warns else "ok ")
            print(f"[{tag}] {subckt:30s} {corner:8s} {int(temp):4d}C  "
                  f"{len(rows):6d} rows  {'; '.join(faults + warns) or 'clean'}")
        if failures or qa_faults:
            if failures:
                print(f"\n{failures} deck(s) failed to run — see above.", file=sys.stderr)
            if qa_faults:
                print(f"{qa_faults} table(s) failed QA — see above.", file=sys.stderr)
            sys.exit(1)
        print(f"== done: {pdk.name} -> {outdir} ==")


if __name__ == "__main__":
    main()
