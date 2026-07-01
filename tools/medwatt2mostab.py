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
from pathlib import Path

import numpy as np

from mostab_io import fmt_num, write_mostab

# Dimension order of the mosplot 4-D parameter arrays.
ARRAY_AXES = ("length", "vbs", "vgs", "vds")
# Axis-like names that must not be re-emitted as operating-point columns.
_AXIS_LIKE = {"length", "l", "vgs", "vds", "vbs", "vsb"}

# Declared-value aliases for the device channel type, matching the mostab parser.
_POLARITY_ALIASES = {
    "p": "p", "pmos": "p", "pch": "p", "pfet": "p", "pmosfet": "p",
    "n": "n", "nmos": "n", "nch": "n", "nfet": "n", "nmosfet": "n",
}
# device_parameters keys that may carry a declared channel type. A small, deliberately
# inclusive set — an unrecognized value is ignored, so over-listing is harmless.
_POLARITY_FIELDS = ("polarity", "type", "device_type", "channel_type", "mos_type")


def _normalize_polarity(value) -> str | None:
    """Map a declared device-type value to 'n'|'p', or None if unrecognized."""
    if value is None:
        return None
    return _POLARITY_ALIASES.get(str(value).strip().lower())


def _find_polarity(table: dict, entry: dict, override=None) -> str | None:
    """Resolve the device polarity 'n'|'p' from an explicit override (wins) or a
    device-type field in the model/table ``device_parameters``. Returns None when
    the polarity is KNOWN nowhere — it is never guessed from the model name."""
    p = _normalize_polarity(override)
    if p is not None:
        return p
    for src in (entry.get("device_parameters"), table.get("device_parameters")):
        if isinstance(src, dict):
            for k in _POLARITY_FIELDS:
                if k in src:
                    p = _normalize_polarity(src[k])
                    if p is not None:
                        return p
    return None


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
    """A mostab-precision (10 sig-fig) cell; rejects a non-finite lookup-table value."""
    return fmt_num(x, 10)


def convert_entry(table: dict, name: str, entry: dict, *, polarity=None):
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
            # reshape assumes C-order over ARRAY_AXES (length, vbs, vgs, vds); a
            # differently-ordered flat array would reshape cleanly into wrong rows.
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
        # Emitted only when KNOWN (flag override or a device_parameters field); a
        # `# polarity: p` line lets the importer fold a signed PMOS dump to magnitude.
        "polarity": _find_polarity(table, entry, polarity),
    }
    return header, rows, meta


def _oneline(s) -> str | None:
    return " ".join(str(s).split()) if s else None


def _opt(v) -> str | None:
    return None if v is None else fmt_num(v, 10)


def convert(
    npz_path: str,
    out_dir: str,
    *,
    trust: bool = False,
    overwrite: bool = False,
    polarity=None,
):
    """Convert every model in ``npz_path`` to a mostab CSV under ``out_dir``.

    Model keys are reduced to a safe basename and the resolved output path is
    verified to stay under ``out_dir`` (a crafted model name cannot escape it).
    Existing files are not overwritten unless ``overwrite`` is set. An explicit
    ``polarity`` ('n'|'p') overrides any per-model device-type field.
    """
    table = load_table(npz_path, trust=trust)
    out_root = Path(out_dir).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    written = []
    for name, entry in device_entries(table):
        header, rows, meta = convert_entry(table, name, entry, polarity=polarity)
        out = out_root / f"{_safe_name(name)}.mostab.csv"
        # _safe_name already strips separators; re-check the resolved path stays under
        # out_dir so a crafted model name can never escape it.
        if not out.resolve().is_relative_to(out_root):
            raise ValueError(f"unsafe output path for model {name!r}: {out}")
        if out.exists() and not overwrite:
            raise SystemExit(f"medwatt2mostab: {out} exists; pass --force to overwrite")
        write_mostab(out, header, rows, meta)
        written.append((str(out), len(rows)))
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
    ap.add_argument(
        "--polarity",
        choices=("n", "p"),
        help="declare the device channel type (overrides any device_parameters field); "
        "emits a `# polarity:` line so the importer can fold a signed PMOS dump to magnitude",
    )
    args = ap.parse_args(argv)
    if args.trust_pickle:
        print(
            "medwatt2mostab: --trust-pickle set; unpickling (only do this for trusted files).",
            file=sys.stderr,
        )
    for out, n in convert(
        args.npz, args.out_dir, trust=args.trust_pickle, overwrite=args.force, polarity=args.polarity
    ):
        print(f"wrote {out} ({n} rows)")


if __name__ == "__main__":
    main()
