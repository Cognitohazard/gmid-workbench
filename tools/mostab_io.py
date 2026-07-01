"""Shared writer for the mostab CSV interchange format.

One definition of how a mostab file is laid out (the `# key: value` metadata
comments, then an uppercased column header, then the data rows), reused by every
tool that emits mostab — so the converter and the example generator can never
drift apart. The core (src/) owns the single *reader*; this is its write-side twin.
"""
import csv
import math
import os


def fmt_num(x, sig: int = 10, *, allow_nonfinite: bool = False) -> str:
    """Format a number to ``sig`` significant figures, normalising -0.0 to 0.0.

    The single owner of that rule, shared by everything the tools emit — mostab CSV
    cells and the ngspice deck numbers (voltages, `.temp`, `L=..u`) — so precision and
    -0.0 handling can't drift between them. Raises ValueError on a non-finite value
    unless ``allow_nonfinite`` — then 'inf'/'nan' passes through for a downstream QA gate
    to flag, rather than crashing a long generation run.
    """
    v = float(x)
    if not allow_nonfinite and not math.isfinite(v):
        raise ValueError(f"non-finite value {v!r}")
    if v == 0.0:
        v = 0.0
    return format(v, f".{sig}g")


def write_mostab(path: "str | os.PathLike[str]", header, rows, meta) -> None:
    """Write `rows` to `path` as mostab CSV: `# k: v` for each truthy meta item,
    then the uppercased `header`, then the rows. `rows` may be tuples of numbers
    or of pre-formatted strings (written verbatim by csv)."""
    with open(path, "w", newline="") as f:
        for k, v in meta.items():
            # Emit any non-empty value, including falsey-but-valid scalars like temp=0
            # (a bare `if v` would silently drop 0 / False and shift table identity on re-import).
            if v is not None and v != "":
                f.write(f"# {k}: {v}\n")
        w = csv.writer(f)
        w.writerow([h.upper() for h in header])
        w.writerows(rows)
