#!/usr/bin/env python3
"""Self-test for gen_gmid's assembly and sanity gate (no numpy/ngspice).

Run:  python3 tools/test_gen_gmid.py

Feeds _qa crafted mostab CSVs and asserts its (faults, warns) verdict: a clean table
passes; a missing column, non-finite value, incomplete grid, dead device, a
wrong-signed sweep axis (the polarity mix-up the gate exists to catch), or a noise
PSD of the wrong sign each fault; a gm/Id peak or a noise factor outside its sane
window only warns. Guards that a hard fault is reported as one, so gen_gmid's exit
code reflects it. Also checks the drain-voltage axis (dense near zero, coarse above,
a full grid when non-uniform) and the merge of the two DC sweeps with the noise.
"""
from __future__ import annotations

import math
import os
import tempfile

import gen_gmid
from gmid_decks import _g, drain_voltages, sweep_values
from mostab_io import write_mostab

HEAD = ["l", "vds", "vsb", "vgs", "id", "gm", "gds", "sth", "sfl"]

# A clean NMOS block: one L, vsb=0, a 2x2 VGS x VDS grid, gm/Id peak = 20 (in window),
# noise factor sth/(4kT gm) about 1.1 at full drive (in window).
CLEAN = [
    (1e-7, 0.5, 0.0, 0.4, 1.0e-6, 2.0e-5, 1e-7, 1e-24, 1e-18),
    (1e-7, 1.0, 0.0, 0.4, 1.1e-6, 2.2e-5, 1e-7, 1e-24, 1e-18),
    (1e-7, 0.5, 0.0, 0.8, 5.0e-6, 5.0e-5, 1e-7, 1e-24, 1e-18),
    (1e-7, 1.0, 0.0, 0.8, 5.5e-6, 5.5e-5, 1e-7, 1e-24, 1e-18),
]


def _write(path, rows, head=HEAD):
    # Format via _g exactly as gen_gmid does, so e.g. vsb=0.0 becomes the "0" that
    # _qa keys its vsb=0 block on.
    write_mostab(path, head, [[_g(c) for c in r] for r in rows], {"device": "t"})


def _with(row, **cols):
    """``row`` with the named columns replaced."""
    r = list(row)
    for name, value in cols.items():
        r[HEAD.index(name)] = value
    return tuple(r)


def check_qa(p) -> None:
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
    _write(p, [_with(CLEAN[0], id=float("nan")), *CLEAN[1:]])
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
    _write(p, [_with(r, id=1e-12, gm=2e-11, gds=1e-13, sth=1e-35, sfl=1e-35) for r in CLEAN])
    faults, warns = gen_gmid._qa(p, "n")
    assert any("dead" in m for m in faults), (faults, warns)

    # A gm/Id peak outside [5,60] is a soft warning, not a fault.
    _write(p, [_with(r, gm=r[HEAD.index("id")] * 100, sth=1e-23) for r in CLEAN])
    faults, warns = gen_gmid._qa(p, "n")
    assert not faults and any("gm/Id" in m for m in warns), (faults, warns)


def check_noise(p) -> None:
    # The noise columns are required unless the device omits one on purpose.
    _write(p, [r[:8] for r in CLEAN], head=HEAD[:8])
    faults, warns = gen_gmid._qa(p, "n")
    assert any("SFL" in m for m in faults), (faults, warns)
    _write(p, [(*r[:7], r[8]) for r in CLEAN], head=[*HEAD[:7], "sfl"])
    faults, warns = gen_gmid._qa(p, "n")
    assert any("STH" in m for m in faults), (faults, warns)
    faults, warns = gen_gmid._qa(p, "n", noise=("sfl",))   # sth omitted on purpose
    assert not faults and not warns, (faults, warns)

    # Thermal noise is present at every bias, so a zero sth is a fault.
    _write(p, [_with(CLEAN[0], sth=0.0), *CLEAN[1:]])
    faults, warns = gen_gmid._qa(p, "n")
    assert any("STH" in m and "non-positive" in m for m in faults), (faults, warns)

    # A negative flicker PSD -> fault.
    _write(p, [_with(CLEAN[0], sfl=-1e-18), *CLEAN[1:]])
    faults, warns = gen_gmid._qa(p, "n")
    assert any("SFL" in m and "negative" in m for m in faults), (faults, warns)

    # Flicker noise is 0 exactly where no current flows (vds = 0) ...
    zero_vds = [(1e-7, 0.0, 0.0, vg, 0.0, 0.0, 1e-6, 1e-25, 0.0) for vg in (0.4, 0.8)]
    _write(p, [*zero_vds, *CLEAN])
    faults, warns = gen_gmid._qa(p, "n")
    assert not faults and not warns, (faults, warns)
    # ... and nowhere else: a zero sfl at a point carrying current is a fault.
    _write(p, [_with(CLEAN[0], sfl=0.0), *CLEAN[1:]])
    faults, warns = gen_gmid._qa(p, "n")
    assert any("carry drain current" in m for m in faults), (faults, warns)

    # A density written where the PSD belongs (sth = sqrt of the PSD, about 1e-12) puts
    # the noise factor near 1e12: a soft warning, not a fault.
    _write(p, [_with(r, sth=1e-12) for r in CLEAN])
    faults, warns = gen_gmid._qa(p, "n")
    assert not faults and any("noise factor" in m for m in warns), (faults, warns)


def check_axis(p) -> None:
    # The drain-voltage axis: 25 mV steps to 0.3 V, then the coarse step; the coarse
    # points are all on it, and no two values become the same table coordinate.
    fine = gen_gmid.VDS_FINE
    sky = [_g(v) for v in drain_voltages(1.8, 0.2, fine)]
    assert sky == ["0", "0.025", "0.05", "0.075", "0.1", "0.125", "0.15", "0.175", "0.2",
                   "0.225", "0.25", "0.275", "0.3", "0.4", "0.6", "0.8", "1", "1.2", "1.4",
                   "1.6", "1.8"], sky
    for vdd, step, n in ((1.8, 0.2, 21), (5.0, 0.2, 37), (3.3, 3.3 / 12, 24), (6.0, 0.5, 25)):
        axis = [_g(v) for v in drain_voltages(vdd, step, fine)]
        assert len(axis) == len(set(axis)) == n, (vdd, axis)
        assert {_g(v) for v in sweep_values(vdd, step)} <= set(axis), (vdd, axis)
    # sweep_values keeps an end point the step reaches within rounding (0.3 at 25 mV is
    # 12 steps) and stops short of one it overshoots (3.3 at 8 mV ends at 3.296).
    assert len(sweep_values(0.3, 0.025)) == 13 and _g(sweep_values(0.3, 0.025)[-1]) == "0.3"
    assert len(sweep_values(3.3, 0.008)) == 413 and _g(sweep_values(3.3, 0.008)[-1]) == "3.296"

    # A full grid on a non-uniform vds axis passes the grid check ...
    rows = [(1e-7, vd, 0.0, vg, 1e-6 * vd + vg * 1e-6, 2e-5 * vg, 1e-7, 1e-24, 1e-18)
            for vd in (0.025, 0.05, 0.3, 1.0) for vg in (0.4, 0.8)]
    _write(p, rows)
    faults, warns = gen_gmid._qa(p, "n")
    assert not faults, (faults, warns)
    # ... and a missing dense point is a hole in it.
    _write(p, rows[1:])
    faults, warns = gen_gmid._qa(p, "n")
    assert any("incomplete" in m for m in faults), (faults, warns)


def check_join() -> None:
    # Coarse sweep (vds 0, 0.2) then the fine one appended (vds 0, 0.1, 0.2): the shared
    # coordinates keep the coarse rows, even where the fine sweep's float differs in the
    # last bits; rows come out ordered by |vds| then |vgs|, each with its noise appended.
    coarse = [(vg, vd, [f"c{vg}/{vd}"]) for vd in (0.0, 0.2) for vg in (0.0, 0.5)]
    fine = [(vg, vd, [f"f{vg}/{vd}"]) for vd in (0.0, 0.1, 0.1 + 0.1000000000000001)
            for vg in (0.0, 0.5)]
    noise = {(_g(vg), _g(vd)): [1.0, 2.0] for vd in (0.0, 0.1, 0.2) for vg in (0.0, 0.5)}
    out = gen_gmid._join(coarse + fine, noise)
    assert [(_g(vg), _g(vd), p[0]) for vg, vd, p in out] == [
        ("0", "0", "c0.0/0.0"), ("0.5", "0", "c0.5/0.0"),
        ("0", "0.1", "f0.0/0.1"), ("0.5", "0.1", "f0.5/0.1"),
        ("0", "0.2", "c0.0/0.2"), ("0.5", "0.2", "c0.5/0.2"),
    ], out
    assert all(p[1:] == [1.0, 2.0] for _, _, p in out), out

    # A signed PMOS sweep orders by magnitude, as the sweep runs.
    pm = [(vg, vd, [0]) for vd in (0.0, -0.2) for vg in (0.0, -0.5)]
    out = gen_gmid._join(pm, {(_g(vg), _g(vd)): [1.0, 2.0] for vg, vd, _ in pm})
    assert [(vg, vd) for vg, vd, _ in out] == [(0.0, 0.0), (-0.5, 0.0), (0.0, -0.2), (-0.5, -0.2)]

    # Flicker noise at a point with exactly zero drain current may come back non-finite from
    # the simulator; it is written as 0 there and nowhere else (a non-finite value at a point
    # that carries current stays as it is, for the sanity gate to refuse).
    n_save = len(gen_gmid.SAVE_PARAMS)
    i_id = gen_gmid.SAVE_PARAMS.index("id")
    params_at = lambda idv: [idv if i == i_id else 1.0 for i in range(n_save)]  # noqa: E731
    pts = [(0.0, 0.0, params_at(0.0)), (0.5, 0.0, params_at(3e-6))]
    nz = {("0", "0"): [1e-25, float("nan")], ("0.5", "0"): [1e-25, float("nan")]}
    out = gen_gmid._join(pts, nz)
    assert out[0][2][-1] == 0.0, out[0]
    assert math.isnan(out[1][2][-1]), out[1]

    # A DC point without noise, or noise without a DC point, is an error, never a gap.
    for bad in ({k: v for k, v in noise.items() if k != ("0.5", "0.1")},
                {**noise, ("0.5", "0.3"): [1.0, 2.0]}):
        try:
            gen_gmid._join(coarse + fine, bad)
        except RuntimeError as e:
            assert "disagree" in str(e), e
        else:
            raise AssertionError("mismatched noise and DC grids were joined")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "t.csv")
        check_qa(p)
        check_noise(p)
        check_axis(p)
    check_join()
    print("OK — _qa faults on column/finite/grid/dead/polarity/noise sign; gm/Id and noise "
          "factor bands are soft warns; drain axis and sweep/noise join hold")


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("run this self-test without -O; it relies on assert")
    main()
