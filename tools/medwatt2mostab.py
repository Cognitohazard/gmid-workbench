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
Every scalar ``device_parameters`` entry the converter does not read itself is
carried through as a ``# key: value`` line, as stated. One CSV is written per model.

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
# device_parameters keys that may state the process corner and the temperature [°C] the table
# was taken at. When none does (and no flag is given), neither line is written: the importer
# fills in `tt` and 27 °C and records that it did, where a written `# corner: tt` would read as
# a declaration nobody made.
_CORNER_FIELDS = ("corner", "process_corner")
_TEMP_FIELDS = ("temp", "temperature")
# device_parameters keys that may carry the characterization width [m].
_WIDTH_FIELDS = ("width", "w", "W")
# Every other scalar device_parameters entry is carried through as a `# key: value` header,
# written as stated, so the importer keeps it (or, for a key it reads, reports a value it cannot
# read) — the strict-superset rule. A key must look like a header key to be written as one.
_HEADER_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")


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


def _find_field(table: dict, entry: dict, fields):
    """The first of ``fields`` present in the model's, then the table's, ``device_parameters``."""
    for src in (entry.get("device_parameters"), table.get("device_parameters")):
        if isinstance(src, dict):
            for k in fields:
                if k in src:
                    return src[k]
    return None


def _find_corner(table: dict, entry: dict, override=None) -> str | None:
    """The process corner from an explicit override (wins) or a device_parameters field, or
    None when the source states none — never a default."""
    value = override if override is not None else _find_field(table, entry, _CORNER_FIELDS)
    text = _oneline(value)
    return text or None


# A stated temperature above this is taken to be in kelvin: no characterization runs at 200 °C,
# and 27 °C written in kelvin is 300.15.
_KELVIN_ABOVE = 200.0


def _find_temp(table: dict, entry: dict, override=None, name: str = "") -> str | None:
    """The temperature [°C] from an explicit override (wins, always °C) or a device_parameters
    field, or None when the source states none. A stated value above _KELVIN_ABOVE is read as
    kelvin and converted, with a note on stderr. A stated value that is not a number is written
    as it was stated, so the importer keeps it and says it could not be read, rather than the
    table silently reading as one that states no temperature."""
    if override is not None:
        return fmt_num(float(override), 10)
    value = _find_field(table, entry, _TEMP_FIELDS)
    if value is None:
        return None
    try:
        t = float(np.asarray(value).ravel()[0])
    except (TypeError, ValueError, IndexError):
        return _oneline(value)
    if not np.isfinite(t):
        return _oneline(value)
    if t > _KELVIN_ABOVE:
        celsius = t - 273.15
        print(
            f"medwatt2mostab: {name or 'model'}: stated temperature {fmt_num(t, 10)} read as kelvin "
            f"-> {fmt_num(celsius, 10)} °C",
            file=sys.stderr,
        )
        t = celsius
    return fmt_num(t, 10)


def _find_width(table: dict, entry: dict):
    """Characterisation width [m] from the model or table metadata, if present."""
    for src in (entry.get("device_parameters"), table.get("device_parameters")):
        if isinstance(src, dict):
            for k in _WIDTH_FIELDS:
                if k in src:
                    return float(np.asarray(src[k]).ravel()[0])
    w = table.get("width")
    return None if w is None else float(np.asarray(w).ravel()[0])


def _num(x) -> str:
    """A mostab-precision (10 sig-fig) cell; rejects a non-finite lookup-table value."""
    return fmt_num(x, 10)


def _scalar(value):
    """``value`` as one plain Python value, or None when it is not a single value (a list, a
    dict, an array of more than one element, or nothing)."""
    if isinstance(value, (str, bool, int, float, np.generic)):
        return value.item() if isinstance(value, np.generic) else value
    if isinstance(value, np.ndarray) and value.size == 1:
        return value.reshape(()).item()
    return None


def _carried_parameters(table: dict, entry: dict, meta: dict, consumed: set, name: str) -> dict:
    """The device_parameters entries no header of the converter's own reads, as headers: the
    model's, then the table's for a key the model does not state. Each value is written as
    stated; one that is not a single value, a key the converter writes from elsewhere, and a key
    that cannot be a header key are left out, each with a note on stderr."""
    out: dict = {}
    own = {k.lower() for k in meta}
    for src in (entry.get("device_parameters"), table.get("device_parameters")):
        if not isinstance(src, dict):
            continue
        for key, value in src.items():
            k = str(key)
            if k.lower() in consumed or k in out:
                continue
            why = None
            v = _scalar(value)
            # As stated, on one line; a zero or a False is a value like any other.
            text = "" if v is None else " ".join(str(v).split())
            if not _HEADER_KEY.match(k):
                why = "the key cannot be written as a header key"
            elif k.lower() in own:
                why = f"the header writes its own {k.lower()}"
            elif not text:
                why = "it is not a single value"
            if why:
                print(f"medwatt2mostab: {name or 'model'}: device_parameters {k!r} not carried: "
                      f"{why}", file=sys.stderr)
                continue
            out[k] = text
    return out


def convert_entry(table: dict, name: str, entry: dict, *, polarity=None, corner=None, temp=None):
    """Return ``(header, rows, meta)`` for one model entry."""
    length = np.asarray(entry["length"], float).ravel()
    vbs = np.asarray(entry["vbs"], float).ravel()
    vgs = np.asarray(entry["vgs"], float).ravel()
    vds = np.asarray(entry["vds"], float).ravel()
    shape = (len(length), len(vbs), len(vgs), len(vds))

    listed = [p for p in entry.get("parameter_names", []) if p.lower() not in _AXIS_LIKE]
    params = [p for p in listed if p in entry]
    absent = [p for p in listed if p not in entry]
    if absent:
        print(f"medwatt2mostab: {name}: listed parameter(s) {', '.join(map(str, absent))} not in "
              f"the model's entry, so not written", file=sys.stderr)
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

    resolved_polarity = _find_polarity(table, entry, polarity)
    meta = {
        "mostab": "0.1",
        "device": name,
        # Written only when the source (or a flag) states it; see _CORNER_FIELDS.
        "corner": _find_corner(table, entry, corner),
        "temp": _find_temp(table, entry, temp, name),
        "simulator": _oneline(table.get("simulator")),
        "description": _oneline(table.get("description")),
        "W": _opt(_find_width(table, entry)),
        # Emitted only when KNOWN (flag override or a device_parameters field); a
        # `# polarity: p` line lets the importer fold a signed PMOS dump to magnitude.
        "polarity": resolved_polarity,
    }
    # The fields read above are consumed; a channel-type field is consumed only when a polarity
    # was resolved, so one this converter cannot read reaches the importer as stated (under its
    # own key), which reports it rather than reading the table as one that declares none.
    consumed = {k.lower() for k in (*_CORNER_FIELDS, *_TEMP_FIELDS, *_WIDTH_FIELDS)}
    if resolved_polarity is not None:
        consumed |= {k.lower() for k in _POLARITY_FIELDS}
    meta.update(_carried_parameters(table, entry, meta, consumed, name))
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
    corner=None,
    temp=None,
):
    """Convert every model in ``npz_path`` to a mostab CSV under ``out_dir``.

    Model keys are reduced to a safe basename and the resolved output path is
    verified to stay under ``out_dir`` (a crafted model name cannot escape it).
    Existing files are not overwritten unless ``overwrite`` is set. An explicit
    ``polarity`` ('n'|'p'), ``corner`` or ``temp`` [°C] overrides the matching
    device_parameters field; a corner or temperature stated by neither is left out.
    """
    table = load_table(npz_path, trust=trust)
    out_root = Path(out_dir).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    written = []
    for name, entry in device_entries(table):
        header, rows, meta = convert_entry(
            table, name, entry, polarity=polarity, corner=corner, temp=temp
        )
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
    ap.add_argument(
        "--corner",
        help="declare the process corner the table was taken at (overrides any device_parameters "
        "field); without it, and without such a field, no `# corner:` line is written",
    )
    ap.add_argument(
        "--temp",
        type=float,
        help="declare the temperature in °C the table was taken at (overrides any "
        "device_parameters field); without it, and without such a field, no `# temp:` line is written",
    )
    args = ap.parse_args(argv)
    if args.trust_pickle:
        print(
            "medwatt2mostab: --trust-pickle set; unpickling (only do this for trusted files).",
            file=sys.stderr,
        )
    for out, n in convert(
        args.npz,
        args.out_dir,
        trust=args.trust_pickle,
        overwrite=args.force,
        polarity=args.polarity,
        corner=args.corner,
        temp=args.temp,
    ):
        print(f"wrote {out} ({n} rows)")


if __name__ == "__main__":
    main()
