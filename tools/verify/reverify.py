#!/usr/bin/env python3
"""Run the decks gen_decks.py wrote and compare each sheet's figures with the simulation.

From the repository root, after export_netlists.ts and gen_decks.py::

    python3 tools/verify/reverify.py [filter ...]

Writes ``tools/verify/generated/results.json`` (every figure, sheet against simulation) and
``tools/verify/generated/report.md`` (one table per sheet), and prints one line per sheet.

What is compared, and the band each figure kind passes within (README, "Re-verifying the library
from its wiring", says why each band is what it is):

* every placement's drain current, 5 %;
* every wire level the sheet derives or solves (not one the deck drives), 10 mV;
* an input a servo moves, against the level the sheet derives for it, 10 mV, and the systematic
  offset ``vos_sys`` against the input difference the servo settles at, 10 % or 0.5 mV;
* the current a held wire's source supplies (a current hold, or a held supply), against what the
  sheet's wiring check says that source supplies, 5 % of the largest current on the wire;
* ``Av``, ``Rout``, ``GBW`` and the thermal part of the input-referred noise density ``vn_in`` at
  1 kHz, 10 %; ``PM``, 5 degrees.
"""

from __future__ import annotations

import contextlib
import json
import math
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from gen_decks import inst  # the instance names the decks give each placement

ROOT = Path(__file__).resolve().parents[2]
GEN = ROOT / "tools" / "verify" / "generated"
NETLISTS = GEN / "netlists"
DECKS = GEN / "decks"
RESULT = re.compile(r"^(r_\w+)\s*=\s*(\S+)")

BAND_I = 0.05  # currents, relative
BAND_V = 0.010  # voltages, absolute [V]
BAND_REL = 0.10  # gain, output resistance, bandwidth, noise
BAND_PM = 5.0  # degrees
BAND_VOS_ABS = 0.5e-3  # [V]


def run(deck: Path) -> tuple[dict[str, float], str]:
    p = subprocess.run(
        ["ngspice", "-b", str(deck.relative_to(ROOT))],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    out: dict[str, float] = {}
    for line in p.stdout.splitlines():
        m = RESULT.match(line.strip())
        if m:
            with contextlib.suppress(ValueError):
                out[m.group(1)[2:]] = float(m.group(2))
    return out, p.stdout + p.stderr


def figure(net: dict, name: str) -> float | None:
    for f in net["figures"]:
        if f["name"] == name:
            return f.get("value")
    return None


def row(fig: str, sheet: float | None, sim: float | None, kind: str, note: str = "", scale: float | None = None) -> dict:
    """One comparison. kind: 'rel' (band relative), 'abs-v', 'pm', 'vos', 'abs-i' (band times scale)."""
    r: dict = {"figure": fig, "sheet": sheet, "sim": sim, "kind": kind, "note": note}
    if sheet is None or sim is None or not (math.isfinite(sheet) and math.isfinite(sim)):
        r["pass"] = None
        return r
    if kind == "rel":
        band = BAND_I if fig.startswith("I(") else BAND_REL
        r["err"] = (sim - sheet) / sheet if sheet else math.inf
        r["pass"] = abs(r["err"]) <= band
    elif kind == "abs-v":
        r["err"] = sim - sheet
        r["pass"] = abs(r["err"]) <= BAND_V
    elif kind == "pm":
        r["err"] = sim - sheet
        r["pass"] = abs(r["err"]) <= BAND_PM
    elif kind == "vos":
        r["err"] = sim - sheet
        r["pass"] = abs(r["err"]) <= max(BAND_REL * abs(sheet), BAND_VOS_ABS)
    elif kind == "abs-i":
        r["err"] = (sim - sheet) / scale if scale else math.inf
        r["pass"] = abs(r["err"]) <= BAND_I
    elif kind == "diag":
        r["err"] = (sim - sheet) / sheet if sheet else math.inf
        r["pass"] = None
    return r


def into(polarity: str, t: str) -> int:
    """The sign of a device's drain current flowing into the wire at terminal t."""
    return 1 if (polarity == "p") == (t == "d") else -1


def sheet_balance(net: dict, w: str, levels: dict[str, float]) -> float | None:
    """The sum of the sheet's currents into wire w — what its wiring check reports at a wire it
    sums, worked out here for a port, which the check leaves to the sheet outside."""
    total = 0.0
    for dev in net["devices"]:
        for p in dev["placements"]:
            for t in ("d", "s"):
                if p[t] == w:
                    total += into(dev["polarity"], t) * (dev["point"].get("id") or 0)
    for el in net["elements"]:
        a, b = el["between"]
        if w not in (a, b) or el["kind"] == "C":
            continue
        if el["kind"] == "I":
            total += el.get("value", 0) * (1 if w == b else -1)
        elif el["kind"] == "R" and a in levels and b in levels:
            i = (levels[a] - levels[b]) / el["value"]
            total += i if w == b else -i
        else:
            return None
    return total


def compare(net: dict, meta: dict, sim: dict[str, float]) -> tuple[list[dict], list[dict]]:
    """The judged rows, and diagnostic ones: each placement's gm, gds and gmb against the
    quantities the sheet exposes for it."""
    pl = meta["plan"]
    drive = pl["drive"]
    rows: list[dict] = []
    diag: list[dict] = []
    wiring = net.get("wiring") or {}
    tainted = set(wiring.get("tainted", []))
    floating = {w for g in wiring.get("floating", []) for w in g}
    # Device currents, per placement.
    for dev in net["devices"]:
        for i, _ in enumerate(dev["placements"]):
            nm = inst(dev, i)
            label = (dev["path"] or "own device") + (f"#{i}" if len(dev["placements"]) > 1 else "")
            s = sim.get(f"id_{nm}")
            rows.append(row(f"I({label})", dev["point"].get("id"), abs(s) if s is not None else None, "rel"))
            for q, key in (("gm", "gm"), ("gds", "gds"), ("gmb", "gmbs")):
                if f"{key}_{nm}" in sim:
                    diag.append(row(f"{q}({label})", dev["quantities"].get(q), abs(sim[f"{key}_{nm}"]), "diag"))
    # Wire levels the deck does not drive: derived or solved by the sheet.
    for w, info in net["wires"].items():
        if w == "gnd":
            continue
        d = drive.get(w)
        s = sim.get(f"v_{w}")
        if d and d["kind"] in ("supply", "pin", "hold"):
            continue
        if d and d["kind"] == "input" and not pl["servo"]:
            continue
        if d and d["kind"] == "servo":
            continue
        note = "moved by the servo" if d and d["kind"] == "input" else ""
        level = info.get("level")
        if d and d["kind"] in ("cmfb", "boost"):
            note = "where the sheet pins it; here the loop sets it"
            level = d["level"]
        elif level is None and w in floating and w in pl["levels"]:
            level = pl["levels"][w]
            note = "the walk gives it no level: read from the sheet's device voltages and the deck's supply"
        elif level is None:
            note = "the walk gives this wire no level" + (" (tainted: a loop it hangs off does not close)" if w in tainted else "")
        vdd = net["params"].get("VDD", 1.8)
        if any(v is not None and (v < -1e-3 or v > vdd + 1e-3) for v in (level, s)):
            note = (note + "; " if note else "") + "outside the rails"
        rows.append(row(f"V({w})", level, s, "abs-v", note))
    # Currents the held wires' sources supply.
    resid = {b["wire"]: b["residual"] for b in wiring.get("balance", [])}
    for w, d in sorted(drive.items()):
        if d["kind"] == "supply":
            # A held supply's current, as the wiring check sums it; a supply port is not summed.
            if w in resid:
                rows.append(row(f"I(supply {w})", -resid[w], sim.get(f"isup_{w}"), "rel"))
            continue
        if d["kind"] != "hold":
            continue
        s = sim.get(f"hold_{w}")
        own = sheet_balance(net, w, pl["levels"])
        sheet = -resid[w] if w in resid else (-own if own is not None else None)
        largest = max(
            [abs(dev["point"].get("id") or 0) for dev in net["devices"] for p in dev["placements"] if w in (p["d"], p["s"])]
            + [abs(e.get("value") or 0) for e in net["elements"] if e["kind"] == "I" and w in e["between"]]
            + [abs(sheet or 0), 1e-12]
        )
        note = "" if w in resid else "a port: summed here from the sheet's currents"
        rows.append(row(f"I(hold {w})", sheet, s, "abs-i", note, scale=largest))
    # The offset a servo settles at.
    stim = pl["stim"]
    if pl["servo"] and stim and "pair" in stim:
        p, n = stim["pair"]
        if f"v_{p}" in sim and f"v_{n}" in sim:
            vos = figure(net, "vos_sys")
            if vos is not None:
                rows.append(row("vos_sys", vos, abs(sim[f"v_{p}"] - sim[f"v_{n}"]), "vos"))
    # Small-signal figures.
    if "av" in sim and "f3db" in sim:
        sim["gbw"] = sim["av"] * sim["f3db"]
    for name, key, kind in (("Av", "av", "rel"), ("Rout", "rout", "rel"), ("GBW", "gbw", "rel"), ("vn_in", "vn_thermal", "rel")):
        val = figure(net, name)
        if val is None:
            continue
        s = sim.get(key)
        if name == "Av":
            val = abs(val)
        rows.append(row(name, val, s, kind, "" if s is not None else "not simulated"))
    pm = figure(net, "PM")
    if pm is not None:
        s = None
        if "phu" in sim and "ph0" in sim:
            s = 180 - abs(sim["ph0"] - sim["phu"])
        rows.append(row("PM", pm, s, "pm", "" if s is not None else "not simulated"))
    return rows, diag


def fmt(x: float | None, fig: str) -> str:
    if x is None:
        return "—"
    if fig == "PM":
        return f"{x:.1f}°"
    unit = "A" if fig.startswith("I(") else "V" if fig.startswith(("V(", "vos")) else ""
    if fig == "Rout":
        unit = "Ω"
    elif fig == "GBW":
        unit = "Hz"
    elif fig == "vn_in":
        unit = "V/√Hz"
    return eng(x, unit)


def eng(x: float, unit: str) -> str:
    if x == 0:
        return f"0 {unit}".strip()
    exp = int(math.floor(math.log10(abs(x)) / 3) * 3)
    exp = max(-15, min(9, exp))
    prefix = {-15: "f", -12: "p", -9: "n", -6: "µ", -3: "m", 0: "", 3: "k", 6: "M", 9: "G"}[exp]
    if not unit:
        return f"{x:.4g}"
    return f"{x / 10**exp:.4g} {prefix}{unit}"


def err_text(r: dict) -> str:
    if "err" not in r:
        return "—"
    if r["kind"] == "rel":
        return f"{100 * r['err']:+.1f} %"
    if r["kind"] == "vos":
        return f"{1e6 * r['err']:+.0f} µV"
    if r["kind"] == "abs-v":
        return f"{1e3 * r['err']:+.1f} mV"
    if r["kind"] == "pm":
        return f"{r['err']:+.1f}°"
    return f"{100 * r['err']:+.1f} % of I"


def main(argv: list[str]) -> int:
    only = [a for a in argv if not a.startswith("-")]
    metas = []
    for f in sorted(DECKS.glob("*.json")):
        meta = json.loads(f.read_text())
        if only and not any(o in meta["sheet"] for o in only):
            continue
        metas.append((f.stem, meta))

    def one(item: tuple[str, dict]) -> dict:
        stem, meta = item
        net = json.loads((NETLISTS / f"{meta['netlist']}.json").read_text())
        out = {
            "sheet": meta["sheet"],
            "variant": meta["variant"],
            "title": net["title"],
            "feasible": net["feasible"],
            "pinned": meta["plan"]["pinned"],
            "inside": meta["plan"].get("inside", []),
            "problems": meta["plan"]["problems"],
        }
        if not meta.get("deck"):
            out["ran"] = False
            return out
        sim, log = run(ROOT / meta["deck"])
        (DECKS / f"{stem}.log").write_text(log)
        out["ran"] = True
        out["converged"] = any(k.startswith("id_") for k in sim)
        out["sim"] = sim
        out["rows"], out["diag"] = compare(net, meta, sim) if out["converged"] else ([], [])
        return out

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(one, metas))

    if not only:
        (GEN / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    md: list[str] = []
    for r in results:
        rows = r.get("rows", [])
        judged = [x for x in rows if x["pass"] is not None]
        ok = sum(1 for x in judged if x["pass"])
        name = r["sheet"] + (f" [{r['variant']}]" if r["variant"] else "")
        head = f"{name}: {ok}/{len(judged)} within band"
        if r["pinned"]:
            head += f"; partly pinned: {', '.join(r['pinned'])}"
        if r["inside"]:
            head += f"; held inside: {', '.join(r['inside'])}"
        if not r.get("ran"):
            head = f"{name}: not run ({'; '.join(r['problems'])})"
        elif not r.get("converged"):
            head = f"{name}: DID NOT CONVERGE"
        print(head)
        md += [f"### {name}", "", head, ""]
        if rows:
            md += ["| figure | sheet | sim | error | pass |", "|-|-|-|-|-|"]
            for x in rows:
                p = "—" if x["pass"] is None else ("yes" if x["pass"] else "**no**")
                note = f" ({x['note']})" if x["note"] else ""
                md.append(f"| {x['figure']}{note} | {fmt(x['sheet'], x['figure'])} | {fmt(x['sim'], x['figure'])} | {err_text(x)} | {p} |")
            md.append("")
    if not only:
        (GEN / "report.md").write_text("\n".join(md) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
