#!/usr/bin/env python3
"""Self-test for medwatt2mostab — round-trips a synthetic mosplot .npz.

Run:  uv run --with numpy python3 tools/test_medwatt2mostab.py

Builds a tiny npz with the real mosplot structure (per-model dict with
vgs/vds/vbs/length sweeps and (length, vbs, vgs, vds)-shaped parameter arrays),
converts it, and asserts the mostab CSV: metadata, header, row count, the
vsb = -vbs sign flip, and a spot value. Also writes the committed fixture that
the TypeScript importer round-trip test consumes.
"""

from __future__ import annotations

import csv
import os
import tempfile

import numpy as np

import medwatt2mostab as m2m

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.join(HERE, "__fixtures__")
MODEL = "medwatt_demo"


def build_npz(path: str, model: str = MODEL) -> None:
    length = np.array([45e-9, 100e-9])  # nL = 2
    vbs = np.array([0.0, -0.3])         # nVbs = 2  ->  vsb = [0.0, 0.3]
    vgs = np.array([0.3, 0.5, 0.7])     # nVgs = 3
    vds = np.array([0.6, 1.0])          # nVds = 2
    shape = (len(length), len(vbs), len(vgs), len(vds))

    idx = np.indices(shape)  # idx[axis][li,bi,gi,di]
    li, _, gi, _ = idx
    ida = 1e-6 * (li + 1) * (gi + 1)  # distinguishable, finite
    gm = ida * 10.0                   # gm/id = 10 everywhere
    gds = ida * 0.1
    vth = np.full(shape, 0.4)

    entry = {
        "vgs": vgs, "vds": vds, "vbs": vbs, "length": length,
        "model_name": model,
        "parameter_names": ["id", "gm", "gds", "vth"],
        "device_parameters": {"width": 1e-6},
        "id": ida, "gm": gm, "gds": gds, "vth": vth,
    }
    table = {
        "description": "synthetic test table",
        "simulator": "NgspiceSimulator",
        "parameter_names": ["id", "gm", "gds", "vth"],
        "device_parameters": {},
        model: entry,
    }
    np.savez_compressed(path, lookup_table=np.array(table, dtype=object))


def read_mostab(path: str):
    meta, header, rows = {}, None, []
    with open(path, newline="") as f:
        for line in f:
            if line.startswith("#"):
                k, _, v = line[1:].partition(":")
                meta[k.strip()] = v.strip()
                continue
            for r in csv.reader([line]):
                if header is None:
                    header = r
                elif r:
                    rows.append(dict(zip(header, r)))
    return meta, header, rows


def safety_checks() -> None:
    """Untrusted load is refused; unsafe model names stay inside out_dir; no silent overwrite."""
    with tempfile.TemporaryDirectory() as tmp:
        npz = os.path.join(tmp, "evil.npz")
        build_npz(npz, model="../../evil")
        out_dir = os.path.join(tmp, "out")

        # Refuses to unpickle without trust.
        try:
            m2m.convert(npz, out_dir)
            raise AssertionError("expected refusal without trust")
        except SystemExit:
            pass

        # A traversal model name is reduced to a safe basename inside out_dir.
        written = m2m.convert(npz, out_dir, trust=True, overwrite=True)
        assert written == [(os.path.join(os.path.realpath(out_dir), "evil.mostab.csv"), 24)], written
        assert not os.path.exists(os.path.join(tmp, "evil.mostab.csv")), "escaped out_dir!"

        # A second run without --force refuses to truncate the existing output.
        try:
            m2m.convert(npz, out_dir, trust=True)
            raise AssertionError("expected refusal to overwrite")
        except SystemExit:
            pass


def build_pmos_npz(path: str, *, with_type_field: bool, model: str = "pch_demo") -> None:
    """A signed-PMOS lookup table: negative id/gm/gds and a negative-Vgs sweep.
    ``with_type_field`` toggles a `device_parameters` channel-type field so the test
    can exercise both the field source and the --polarity override."""
    length = np.array([1e-8])             # nL = 1
    vbs = np.array([0.0])                 # nVbs = 1
    vgs = np.array([-0.7, -0.5, -0.3])    # nVgs = 3 (ascending, negative)
    vds = np.array([-1.0])               # nVds = 1
    shape = (len(length), len(vbs), len(vgs), len(vds))

    # |id| = 3e-6, 2e-6, 1e-6 along ascending vgs -> signed PMOS id is negative.
    mag = np.array([3e-6, 2e-6, 1e-6]).reshape(shape)
    ida = -mag
    gm = np.full(shape, -5e-6)            # |gm| ~ d|id|/d|vgs| = 1e-6/0.2 = 5e-6
    gds = -mag * 0.1

    entry = {
        "vgs": vgs, "vds": vds, "vbs": vbs, "length": length,
        "model_name": model,
        "parameter_names": ["id", "gm", "gds"],
        "device_parameters": {"width": 1e-6, **({"type": "pmos"} if with_type_field else {})},
        "id": ida, "gm": gm, "gds": gds,
    }
    table = {
        "description": "synthetic signed PMOS table",
        "simulator": "NgspiceSimulator",
        "parameter_names": ["id", "gm", "gds"],
        "device_parameters": {},
        model: entry,
    }
    np.savez_compressed(path, lookup_table=np.array(table, dtype=object))


def polarity_checks() -> None:
    """The converter emits `# polarity: p` from a device_parameters type field and
    from the --polarity override, omits it when neither is known, and the emitted
    signed-PMOS CSV folds (abs of value columns) to a magnitude table with the
    Vgs sweep axis left untouched — exactly the importer's contract."""
    model = "pch_demo"
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = os.path.join(tmp, "out")

        # 1) Polarity learned from the device_parameters type field.
        npz_field = os.path.join(tmp, "pmos_field.npz")
        build_pmos_npz(npz_field, with_type_field=True)
        m2m.convert(npz_field, out_dir, trust=True, overwrite=True)
        meta, _, rows = read_mostab(os.path.join(out_dir, f"{model}.mostab.csv"))
        assert meta.get("polarity") == "p", meta

        # The emitted CSV is signed (converter never folds) and the Vgs axis stays
        # negative; abs-folding the value columns yields the magnitude table.
        assert {float(r["VGS"]) for r in rows} == {-0.7, -0.5, -0.3}, rows
        assert all(float(r["ID"]) < 0 and float(r["GM"]) < 0 for r in rows), rows
        assert {abs(float(r["ID"])) for r in rows} == {1e-6, 2e-6, 3e-6}, rows
        assert {abs(float(r["GM"])) for r in rows} == {5e-6}, rows

        # 2) No type field, but the --polarity override supplies it (and wins).
        npz_bare = os.path.join(tmp, "pmos_bare.npz")
        build_pmos_npz(npz_bare, with_type_field=False)
        m2m.convert(npz_bare, out_dir, trust=True, overwrite=True, polarity="p")
        meta2, _, _ = read_mostab(os.path.join(out_dir, f"{model}.mostab.csv"))
        assert meta2.get("polarity") == "p", meta2

        # 3) Neither field nor flag -> no polarity line (today's behavior, no fold).
        m2m.convert(npz_bare, out_dir, trust=True, overwrite=True)
        meta3, _, _ = read_mostab(os.path.join(out_dir, f"{model}.mostab.csv"))
        assert "polarity" not in meta3, meta3

    print("OK — polarity emitted from field and --polarity, omitted when unknown")


def main() -> None:
    safety_checks()
    polarity_checks()

    with tempfile.TemporaryDirectory() as tmp:
        npz = os.path.join(tmp, "lut.npz")
        build_npz(npz)
        written = m2m.convert(npz, FIXTURE_DIR, trust=True, overwrite=True)  # committed fixture

    out = os.path.join(FIXTURE_DIR, f"{MODEL}.mostab.csv")
    assert written == [(out, 24)], written  # 2*2*3*2 grid points
    meta, header, rows = read_mostab(out)

    assert meta["device"] == MODEL, meta
    assert meta["W"] == "1e-06", meta
    assert meta["simulator"] == "NgspiceSimulator", meta
    assert header == ["L", "VDS", "VSB", "VGS", "ID", "GM", "GDS", "VTH"], header
    assert len(rows) == 24, len(rows)

    # vsb = -vbs: vbs [0, -0.3] -> vsb {0, 0.3}
    assert {r["VSB"] for r in rows} == {"0", "0.3"}, sorted({r["VSB"] for r in rows})

    # spot value: length=100e-9 (li=1), vsb=0 (bi=0), vgs=0.7 (gi=2), vds=1.0
    # id = 1e-6 * (1+1) * (2+1) = 6e-6, gm = 6e-5 -> gm/id = 10
    hit = [
        r for r in rows
        if float(r["L"]) == 100e-9 and float(r["VSB"]) == 0.0
        and float(r["VGS"]) == 0.7 and float(r["VDS"]) == 1.0
    ]
    assert len(hit) == 1, hit
    assert abs(float(hit[0]["ID"]) - 6e-6) < 1e-18, hit[0]
    assert abs(float(hit[0]["GM"]) / float(hit[0]["ID"]) - 10.0) < 1e-9, hit[0]

    print(f"OK — converted 24 rows, wrote {out}")


if __name__ == "__main__":
    main()
