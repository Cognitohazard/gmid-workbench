#!/usr/bin/env python3
"""Generate clean example mostab CSVs for trying the device-overlay feature.

Emits three process corners (TT / SS / FF) of one synthetic nMOS over an
[L x VGS x VDS] grid, all sharing the same axes so they overlay cleanly: a given
length is the same colour across corners, the corner is the dash pattern. Pure
standard library (no numpy). ID comes from an EKV-style interpolation with a
triode->saturation VDS dependence; GM and GDS are the on-grid central differences
of ID, so both the gm-consistency and the saturation QA checks stay clean.

This is a standalone illustrative model, deliberately independent of the in-app EKV
demo device (src/demo): it only needs to produce plausible importable data, so the
two are not meant to match and need not be kept in sync.

    python3 tools/make_examples.py            # writes to ./examples/
    python3 tools/make_examples.py -o out/

Load them in the app via "Load .csv", then use the device strip to make one the
active device and tick the others as overlays.
"""
import argparse
import math
import os

from mostab_io import write_mostab

UT = 0.025852  # thermal voltage [V] at ~300 K
N = 1.3  # subthreshold slope factor (dimensionless)
COX = 0.01  # gate-oxide capacitance per area [F/m^2]
MUCOX_TT = 50e-6  # mobility * Cox at the typical corner [A/V^2]
VA_PER_L = 5e6  # Early voltage slope: V_A = VA_PER_L * L [V]
W = 1e-6  # characterization width [m]

LENGTHS = [60e-9, 120e-9, 250e-9, 500e-9]
# 0.0 .. 1.2 V in 8 mV steps (under the 10 mV QA threshold; rounded so the grid stays clean).
VGS = [round(i * 0.008, 5) for i in range(151)]
# Drain sweep: denser near the triode knee where gds changes fastest.
VDS = [0.05, 0.1, 0.18, 0.3, 0.45, 0.65, 0.9, 1.2]

# (corner, threshold [V], mobility scale) — SS is weaker/slower, FF stronger/faster.
CORNERS = [("tt", 0.40, 1.00), ("ss", 0.46, 0.78), ("ff", 0.34, 1.25)]


def softplus(x: float) -> float:
    """ln(1 + e^x), numerically stable for large |x|."""
    return x + math.log1p(math.exp(-x)) if x > 0 else math.log1p(math.exp(x))


def deriv(vals, xs, k: int) -> float:
    """Central difference of vals(xs) at index k; one-sided at the ends."""
    n = len(xs)
    if n == 1:
        return 0.0
    if k == 0:
        return (vals[1] - vals[0]) / (xs[1] - xs[0])
    if k == n - 1:
        return (vals[n - 1] - vals[n - 2]) / (xs[n - 1] - xs[n - 2])
    return (vals[k + 1] - vals[k - 1]) / (xs[k + 1] - xs[k - 1])


def id_grid(vth: float, mu_scale: float):
    """ID over the full [L][VGS][VDS] grid. Saturation: tanh knee at vdsat, then
    a gentle channel-length-modulation rise (1 + VDS/V_A)."""
    mucox = MUCOX_TT * mu_scale
    grid = []
    for L in LENGTHS:
        ispec = 2 * N * mucox * (W / L) * UT * UT  # specific current at this geometry
        va = VA_PER_L * L
        plane = []
        for vgs in VGS:
            vov = vgs - vth
            s = softplus(vov / (2 * N * UT))
            id_sat = ispec * s * s
            vdsat = 2 * UT + max(vov, 0.0)
            plane.append([id_sat * math.tanh(vds / vdsat) * (1 + vds / va) for vds in VDS])
        grid.append(plane)
    return grid


def rows_for(vth: float, mu_scale: float):
    """(L, VGS, VDS, ID, GM, GDS, CGG) with GM = dID/dVGS and GDS = dID/dVDS on the grid."""
    grid = id_grid(vth, mu_scale)
    for li, L in enumerate(LENGTHS):
        cgg = COX * W * L
        for gi, vgs in enumerate(VGS):
            for di, vds in enumerate(VDS):
                idd = grid[li][gi][di]
                gm = deriv([grid[li][g][di] for g in range(len(VGS))], VGS, gi)
                gds = deriv(grid[li][gi], VDS, di)
                yield (L, vgs, vds, idd, gm, gds, cgg)


HEADER = ["L", "VGS", "VDS", "ID", "GM", "GDS", "CGG"]


def write_csv(path: str, corner: str, vth: float, mu_scale: float) -> None:
    meta = {
        "mostab": "0.1",
        "device": "nch",
        "corner": corner,
        "temp": 27,
        "W": f"{W:g}",
        "simulator": "synthetic-ekv",
        "AVT": "3.5e-9",
        "ABETA": "2e-8",
        "FCO": "2e6",
    }
    rows = [
        (f"{L:g}", f"{vgs:g}", f"{vds:g}", f"{idd:.6e}", f"{gm:.6e}", f"{gds:.6e}", f"{cgg:.6e}")
        for L, vgs, vds, idd, gm, gds, cgg in rows_for(vth, mu_scale)
    ]
    write_mostab(path, HEADER, rows, meta)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-o", "--out", default="examples", help="output directory (default: examples/)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for corner, vth, mu in CORNERS:
        path = os.path.join(args.out, f"nch_{corner}.mostab.csv")
        write_csv(path, corner, vth, mu)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
