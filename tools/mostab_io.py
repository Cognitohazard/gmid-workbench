"""Shared writer for the mostab CSV interchange format.

One definition of how a mostab file is laid out (the `# key: value` metadata
comments, then an uppercased column header, then the data rows), reused by every
tool that emits mostab — so the converter and the example generator can never
drift apart. The core (src/) owns the single *reader*; this is its write-side twin.
"""
import csv


def write_mostab(path: str, header, rows, meta) -> None:
    """Write `rows` to `path` as mostab CSV: `# k: v` for each truthy meta item,
    then the uppercased `header`, then the rows. `rows` may be tuples of numbers
    or of pre-formatted strings (written verbatim by csv)."""
    with open(path, "w", newline="") as f:
        for k, v in meta.items():
            if v:
                f.write(f"# {k}: {v}\n")
        w = csv.writer(f)
        w.writerow([h.upper() for h in header])
        w.writerows(rows)
