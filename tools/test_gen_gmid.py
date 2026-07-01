#!/usr/bin/env python3
"""Self-test for gen_gmid._qa — the generation-side sanity gate (no numpy/ngspice).

Run:  python3 tools/test_gen_gmid.py

Feeds _qa crafted mostab CSVs and asserts its (ok, msgs) verdict: a clean table
passes; a missing column, non-finite value, incomplete grid, dead device, or a
wrong-signed sweep axis (the polarity mix-up the gate exists to catch) each fail
(ok False); a gm/Id peak outside the sane window only warns (ok True). Guards that
a hard fault sets ok=False so gen_gmid's exit code reflects it.
"""
from __future__ import annotations

import os
import tempfile

import gen_gmid
from gmid_decks import _g
from mostab_io import write_mostab

HEAD = ["l", "vds", "vsb", "vgs", "id", "gm", "gds"]

# A clean NMOS block: one L, vsb=0, a 2x2 VGS x VDS grid, gm/Id peak = 20 (in window).
CLEAN = [
    (1e-7, 0.5, 0.0, 0.4, 1.0e-6, 2.0e-5, 1e-7),
    (1e-7, 1.0, 0.0, 0.4, 1.1e-6, 2.2e-5, 1e-7),
    (1e-7, 0.5, 0.0, 0.8, 5.0e-6, 5.0e-5, 1e-7),
    (1e-7, 1.0, 0.0, 0.8, 5.5e-6, 5.5e-5, 1e-7),
]


def _write(path, rows, head=HEAD):
    # Format via _g exactly as gen_gmid does, so e.g. vsb=0.0 becomes the "0" that
    # _qa keys its vsb=0 block on.
    write_mostab(path, head, [[_g(c) for c in r] for r in rows], {"device": "t"})


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "t.csv")

        # Clean NMOS: no faults, no warnings.
        _write(p, CLEAN)
        faults, warns = gen_gmid._qa(p, "n")
        assert not faults and not warns, (faults, warns)

        # Same table read as PMOS: a positive vgs axis is a polarity mix-up -> fault.
        faults, warns = gen_gmid._qa(p, "p")
        assert any("PMOS" in m for m in faults), (faults, warns)

        # A missing required column -> fault.
        _write(p, [r[:6] for r in CLEAN], head=HEAD[:6])
        faults, warns = gen_gmid._qa(p, "n")
        assert any("GDS" in m for m in faults), (faults, warns)

        # A non-finite value -> fault.
        _write(p, [(1e-7, 0.5, 0.0, 0.4, float("nan"), 2.0e-5, 1e-7), *CLEAN[1:]])
        faults, warns = gen_gmid._qa(p, "n")
        assert any("non-finite" in m for m in faults), (faults, warns)

        # An incomplete VGS x VDS grid (3 of 4 points) -> fault.
        _write(p, CLEAN[:3])
        faults, warns = gen_gmid._qa(p, "n")
        assert any("incomplete" in m for m in faults), (faults, warns)

        # A duplicated point masking a missing one keeps the row count (2x2 = 4 rows)
        # but is still a hole in the grid -> fault. A row-count-only check blesses this.
        _write(p, [CLEAN[0], CLEAN[0], CLEAN[1], CLEAN[2]])
        faults, warns = gen_gmid._qa(p, "n")
        assert any("duplicate" in m for m in faults), (faults, warns)

        # A dead device (id ~ 0 at full drive) -> fault.
        _write(p, [(1e-7, vd, 0.0, vg, 1e-12, 2e-11, 1e-13)
                   for (_l, vd, _vsb, vg, *_rest) in CLEAN])
        faults, warns = gen_gmid._qa(p, "n")
        assert any("dead" in m for m in faults), (faults, warns)

        # A gm/Id peak outside [5,60] is a soft warning, not a fault.
        _write(p, [(1e-7, vd, 0.0, vg, idv, idv * 100, 1e-7)
                   for (_l, vd, _vsb, vg, idv, *_rest) in CLEAN])
        faults, warns = gen_gmid._qa(p, "n")
        assert not faults and any("outside" in m for m in warns), (faults, warns)

    print("OK — _qa faults on column/finite/grid/dead/polarity; gm/Id band is a soft warn")


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("run this self-test without -O; it relies on assert")
    main()
