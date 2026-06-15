#!/usr/bin/env python3
"""medwatt2mostab — convert a medwatt / mosplot ``.npz`` lookup table to mostab CSV.

The mosplot ``.npz`` is a pickled dict (``np.load(path, allow_pickle=True)
["lookup_table"].item()``): top-level metadata plus one entry per transistor
model. Each model entry holds the sweep vectors ``vgs / vds / vbs / length`` and
one N-D array per saved parameter (``id``, ``gm``, ``gds``, …), shaped over the
axes ``(length, vbs, vgs, vds)``.

mostab is a flat CSV — ``# key: value`` metadata lines, a header row, then one
row per grid point. ``vbs`` is converted to the mostab convention ``vsb = -vbs``;
parameter names are emitted verbatim (the mostab importer canonicalises aliases).
One CSV is written per model.

Usage::

    uv run --with numpy python3 tools/medwatt2mostab.py table.npz -o out/
    # or, with numpy on PATH:
    python3 tools/medwatt2mostab.py table.npz -o out/
"""

from __future__ import annotations

import argparse
import os
import re
import sys

import numpy as np

from mostab_io import write_mostab

# Dimension order of the mosplot 4-D parameter arrays.
ARRAY_AXES = ("length", "vbs", "vgs", "vds")
# Axis-like names that must not be re-emitted as operating-point columns.
_AXIS_LIKE = {"length", "l", "vgs", "vds", "vbs", "vsb"}


def load_table(path: str, *, trust: bool = False) -> dict:
    """Load the pickled mosplot lookup-table dict from an ``.npz``.

    A mosplot ``.npz`` stores its dict as a pickled object, so loading it runs
    arbitrary code embedded in the file (numpy's ``allow_pickle``). Loading is
    therefore refused unless ``trust`` is set — only pass it for files you
    produced or trust.
    """
    if not trust:
        raise SystemExit(
            "medwatt2mostab: refusing to load a pickled .npz without --trust-pickle.\n"
            "  mosplot .npz files are pickled; loading one executes arbitrary code from\n"
            "  the file. Only pass --trust-pickle for files you produced or trust."
        )
    return np.load(path, allow_pickle=True)["lookup_table"].item()


def _safe_name(name) -> str:
    """A filesystem-safe basename for a model key (no separators / traversal)."""
    base = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(str(name))).strip(".")
    return base or "model"


def device_entries(table: dict):
    """Yield ``(name, entry)`` for every per-model dict (has the sweep vectors)."""
    for name, entry in table.items():
        if isinstance(entry, dict) and all(k in entry for k in ARRAY_AXES):
            yield name, entry


def _find_width(table: dict, entry: dict):
    """Characterisation width [m] from the model or table metadata, if present."""
    for src in (entry.get("device_parameters"), table.get("device_parameters")):
        if isinstance(src, dict):
            for k in ("width", "w", "W"):
                if k in src:
                    return float(np.asarray(src[k]).ravel()[0])
    w = table.get("width")
    return None if w is None else float(np.asarray(w).ravel()[0])


def _num(x) -> str:
    v = float(x)
    if not np.isfinite(v):
        raise ValueError(f"non-finite value {v!r} in lookup table")
    if v == 0.0:
        v = 0.0  # normalise -0.0 (e.g. -vbs at vbs=0) to 0
    return format(v, ".10g")


def convert_entry(table: dict, name: str, entry: dict):
    """Return ``(header, rows, meta)`` for one model entry."""
    length = np.asarray(entry["length"], float).ravel()
    vbs = np.asarray(entry["vbs"], float).ravel()
    vgs = np.asarray(entry["vgs"], float).ravel()
    vds = np.asarray(entry["vds"], float).ravel()
    shape = (len(length), len(vbs), len(vgs), len(vds))

    params = [
        p
        for p in entry.get("parameter_names", [])
        if p in entry and p.lower() not in _AXIS_LIKE
    ]
    arrays = {}
    for p in params:
        a = np.asarray(entry[p], float)
        if a.shape != shape:
            if a.size != int(np.prod(shape)):
                raise ValueError(f"{name}.{p}: shape {a.shape} != sweep grid {shape}")
            a = a.reshape(shape)
        arrays[p] = a

    header = ["l", "vds", "vsb", "vgs", *params]
    rows = []
    for li in range(len(length)):
        for bi in range(len(vbs)):
            for gi in range(len(vgs)):
                for di in range(len(vds)):
                    row = [_num(length[li]), _num(vds[di]), _num(-vbs[bi]), _num(vgs[gi])]
                    row += [_num(arrays[p][li, bi, gi, di]) for p in params]
                    rows.append(row)

    meta = {
        "device": name,
        "corner": "tt",
        "simulator": _oneline(table.get("simulator")),
        "description": _oneline(table.get("description")),
        "W": _opt(_find_width(table, entry)),
    }
    return header, rows, meta


def _oneline(s) -> str | None:
    return " ".join(str(s).split()) if s else None


def _opt(v) -> str | None:
    return None if v is None else format(float(v), ".10g")


def convert(npz_path: str, out_dir: str, *, trust: bool = False, overwrite: bool = False):
    """Convert every model in ``npz_path`` to a mostab CSV under ``out_dir``.

    Model keys are reduced to a safe basename and the resolved output path is
    verified to stay under ``out_dir`` (a crafted model name cannot escape it).
    Existing files are not overwritten unless ``overwrite`` is set.
    """
    table = load_table(npz_path, trust=trust)
    out_dir_real = os.path.realpath(out_dir)
    os.makedirs(out_dir_real, exist_ok=True)
    written = []
    for name, entry in device_entries(table):
        header, rows, meta = convert_entry(table, name, entry)
        out = os.path.join(out_dir_real, f"{_safe_name(name)}.mostab.csv")
        if os.path.commonpath([os.path.realpath(out), out_dir_real]) != out_dir_real:
            raise ValueError(f"unsafe output path for model {name!r}: {out}")
        if os.path.exists(out) and not overwrite:
            raise SystemExit(f"medwatt2mostab: {out} exists; pass --force to overwrite")
        write_mostab(out, header, rows, meta)
        written.append((out, len(rows)))
    if not written:
        raise SystemExit("medwatt2mostab: no transistor-model entries found in the .npz")
    return written


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(
        description="Convert a medwatt/mosplot .npz lookup table to mostab CSV (one file per model)."
    )
    ap.add_argument("npz", help="path to the mosplot .npz lookup table")
    ap.add_argument("-o", "--out-dir", default=".", help="output directory (default: .)")
    ap.add_argument(
        "--trust-pickle",
        action="store_true",
        help="REQUIRED: confirm you trust this .npz — it is unpickled, which runs arbitrary code",
    )
    ap.add_argument("-f", "--force", action="store_true", help="overwrite existing .mostab.csv outputs")
    args = ap.parse_args(argv)
    if args.trust_pickle:
        print(
            "medwatt2mostab: --trust-pickle set; unpickling (only do this for trusted files).",
            file=sys.stderr,
        )
    for out, n in convert(args.npz, args.out_dir, trust=args.trust_pickle, overwrite=args.force):
        print(f"wrote {out} ({n} rows)")


if __name__ == "__main__":
    main()
