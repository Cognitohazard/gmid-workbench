#!/usr/bin/env python3
"""gen_gmid — standalone gm/ID dataset generator (plain ngspice; no MCP, no agent).

This is the reproducible recipe behind the shipped tables. For every
``(device, corner, temp, L, vsb)`` in the matrix below it:
  1. builds a self-running ngspice deck (``gmid_decks.build_deck(..., wrdata_to=)``),
  2. runs it under ``ngspice -b`` (a project ``.spiceinit`` sets ``ngbehavior=hsa``
     so the PDKs' sectioned ``.lib`` parse correctly),
  3. parses the headerless ``wrdata`` egress positionally,
  4. assembles one ``mostab`` table per device with Apache-2.0 attribution, and
  5. runs a generation-side sanity gate (grid, finiteness, polarity, gm/Id range).

Requires only python + ngspice + a fetched PDK. Point ``PDK_ROOT`` at it.

    PDK_ROOT=/path/to/pdks python3 tools/gen_gmid.py sky130 --out data/pdk
    PDK_ROOT=/path/to/pdks python3 tools/gen_gmid.py gf180  --out data/pdk

(Fetch the PDKs first, e.g. `volare enable --pdk sky130 <hash>` /
`--pdk gf180mcu <hash>`; see data/pdk/PROVENANCE.md for the build used.)
"""
from __future__ import annotations

import argparse
import csv
import os
import subprocess
import sys
import tempfile

from gmid_decks import (
    GF180,
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

# The matrix IS the spec: per device a valid-L grid (respecting each device's
# model-bin min L), per PDK the corner/temp/char-width/vsb sweep and vds step.
MATRIX = {
    "sky130": {
        "pdk": SKY130, "corner": "tt", "temp": 27.0, "W_um": 1.0,
        "vsb": [0.0, 0.3, 0.6, 0.9], "vds_step": lambda vdd: 0.2,
        "devices": [
            ("sky130_fd_pr__nfet_01v8", "n", 1.8, [0.15, 0.18, 0.25, 0.5, 1.0, 2.0]),
            ("sky130_fd_pr__pfet_01v8", "p", 1.8, [0.15, 0.18, 0.25, 0.5, 1.0, 2.0]),
            ("sky130_fd_pr__nfet_01v8_lvt", "n", 1.8, [0.15, 0.18, 0.25, 0.5, 1.0, 2.0]),
            ("sky130_fd_pr__pfet_01v8_lvt", "p", 1.8, [0.35, 0.5, 1.0, 2.0]),  # lvt pfet min L = 0.35u
        ],
    },
    "gf180": {
        "pdk": GF180, "corner": "typical", "temp": 27.0, "W_um": 10.0,
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
    """Run one deck, return [(vgs, vds, [params...])] parsed from its wrdata."""
    cir, out = os.path.join(workdir, "d.cir"), os.path.join(workdir, "d.csv")
    deck = build_deck(pdk, subckt=subckt, dev_type=t, vdd=vdd, corner=corner, temp=temp,
                      L_um=L_um, W_um=W_um, vsb=vsb, vgs_step=VGS_STEP, vds_step=vds_step,
                      wrdata_to="d.csv")
    open(cir, "w").write(deck)
    if os.path.exists(out):
        os.remove(out)
    r = subprocess.run([ngspice, "-b", "d.cir"], cwd=workdir, capture_output=True,
                       text=True, timeout=600)
    if not os.path.exists(out):
        raise RuntimeError(f"{subckt} L={L_um} vsb={vsb}: ngspice wrote no output\n{r.stderr[-600:]}")
    # Decode wrdata (headerless (scale,value) pairs) via the layout owner in gmid_decks.
    ncol = wrdata_columns()
    rows = []
    for line in open(out):
        parts = line.split()
        if len(parts) < ncol:
            continue
        try:
            v = [float(x) for x in parts[:ncol]]
        except ValueError:
            continue
        rows.append(parse_wrdata_row(v))
    if not rows:
        raise RuntimeError(f"{subckt} L={L_um} vsb={vsb}: empty wrdata")
    return rows


def _qa(path, dev_type):
    """Sanity-check one assembled mostab. Returns (ok, [messages]).

    The real data-trust gate is the workbench importer + ``qa``; this catches gross
    generation faults (a collided/missing block, an off-by-1e6 unit slip, a dead
    device, a polarity-axis mix-up) before anything ships.
    """
    msgs = []
    rows = [r for r in csv.reader(open(path)) if r and not r[0].startswith("#")]
    head, data = rows[0], rows[1:]
    col = {name: i for i, name in enumerate(head)}
    for k in ("L", "VDS", "VSB", "VGS", "ID", "GM", "GDS"):
        if k not in col:
            return False, [f"missing column {k}"]
    # finiteness
    bad = sum(1 for r in data for v in r if v in ("nan", "inf", "-inf"))
    if bad:
        msgs.append(f"{bad} non-finite values")
    # grid completeness: every (L,VSB) block is a rectangular VGS x VDS grid
    blocks = {}
    for r in data:
        blocks.setdefault((r[col["L"]], r[col["VSB"]]), []).append((r[col["VGS"]], r[col["VDS"]]))
    for (L, vsb), pts in blocks.items():
        nvg, nvd = len({p[0] for p in pts}), len({p[1] for p in pts})
        if nvg * nvd != len(pts):
            msgs.append(f"L={L} vsb={vsb}: grid {nvg}x{nvd} != {len(pts)} rows (incomplete)")
    # physical: id/W at strong inversion, gm/Id peak, polarity. Use the smallest-L,
    # vsb=0 block at max |VGS|,|VDS|.
    v0 = [r for r in data if r[col["VSB"]] == "0"]
    if v0:
        Lmin = min(v0, key=lambda r: float(r[col["L"]]))[col["L"]]
        blk = [r for r in v0 if r[col["L"]] == Lmin]
        drive = max(blk, key=lambda r: abs(float(r[col["VGS"]])) + abs(float(r[col["VDS"]])))
        idv, vgsv = float(drive[col["ID"]]), float(drive[col["VGS"]])
        # ngspice + workbench PMOS convention: MAGNITUDE id/gm/gds, SIGNED-negative vgs axis.
        # So check the device is alive (|id| sane) and the sweep axis sign matches the type.
        if abs(idv) < 1e-9:
            msgs.append(f"id={idv:.2e} ~0 at full drive (dead device?)")
        if dev_type == "p" and vgsv >= 0:
            msgs.append(f"PMOS vgs={vgsv} >=0 (expected signed-negative axis)")
        if dev_type == "n" and vgsv <= 0:
            msgs.append(f"NMOS vgs={vgsv} <=0 (expected positive axis)")
        # gm/Id peak across the smallest-L vsb=0 sweep should land in a sane window
        ratios = [abs(float(r[col["GM"]])) / abs(float(r[col["ID"]]))
                  for r in blk if abs(float(r[col["ID"]])) > 1e-12]
        if ratios:
            pk = max(ratios)
            if not (5 < pk < 60):
                msgs.append(f"gm/Id peak {pk:.1f} outside [5,60] (suspect)")
    return (not any("!=" in m or "missing" in m or "non-finite" in m
                    or "dead" in m or "sign wrong" in m for m in msgs)), msgs


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("pdk", choices=list(MATRIX))
    ap.add_argument("--out", default="data/pdk")
    ap.add_argument("--ngspice", default=os.environ.get("NGSPICE", "ngspice"))
    args = ap.parse_args(argv)

    spec = MATRIX[args.pdk]
    pdk, corner, temp, W = spec["pdk"], spec["corner"], spec["temp"], spec["W_um"]
    outdir = os.path.join(args.out, pdk.name)
    os.makedirs(outdir, exist_ok=True)
    workdir = tempfile.mkdtemp(prefix="gen_gmid_")
    # ngbehavior=hsa (sourced from CWD) so sectioned `.lib file corner` parses
    # (the default ngbehavior's LTspice-compat mode reads the corner as a filename).
    open(os.path.join(workdir, ".spiceinit"), "w").write("set ngbehavior=hsa\n")

    print(f"== {pdk.name}: generating into {outdir} (ngspice={args.ngspice}) ==")
    failures = 0
    for subckt, t, vdd, LS in spec["devices"]:
        vds_step = spec["vds_step"](vdd)
        rows = []
        for L in LS:
            for vsb in spec["vsb"]:
                try:
                    pts = _run_one(pdk, subckt, t, vdd, corner, temp, L, W, vsb, vds_step,
                                   workdir, args.ngspice)
                except Exception as e:  # noqa: BLE001 — report and continue the matrix
                    print(f"   FAIL {subckt} L={L} vsb={vsb}: {e}")
                    failures += 1
                    continue
                for vgs, vds, params in pts:
                    rows.append([_g(L * 1e-6), _g(vds), _g(vsb), _g(vgs)]
                                + [_g(p) for p in params])
        meta = {"mostab": "0.1", "device": subckt, "corner": corner, "temp": temp,
                "W": W * 1e-6, "simulator": SIM, "license": "Apache-2.0",
                "source": SOURCES.get(pdk.name, pdk.name)}
        if t == "p":
            meta["polarity"] = "p"
        out = os.path.join(outdir, f"{subckt}__{corner}__{int(temp)}C.mostab.csv")
        write_mostab(out, ["l", "vds", "vsb", "vgs", *SAVE_PARAMS], rows, meta)
        ok, msgs = _qa(out, t)
        print(f"[{'ok ' if ok else 'WARN'}] {subckt:32s} {len(rows):6d} rows  {'; '.join(msgs) or 'clean'}")
    if failures:
        print(f"\n{failures} deck(s) failed — see above.")
        sys.exit(1)
    print(f"== done: {pdk.name} -> {outdir} ==")


if __name__ == "__main__":
    main()
