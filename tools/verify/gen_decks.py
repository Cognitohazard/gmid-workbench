#!/usr/bin/env python3
"""Write an ngspice deck for every sized netlist that export_netlists.ts wrote.

From the repository root, after ``npx vite-node tools/verify/export_netlists.ts``::

    python3 tools/verify/gen_decks.py [filter ...]

Each deck is generated from the sheet's own wiring: one subcircuit instance per placement of every
sized device, every element as the sheet draws it, and the wires the sheet holds or leaves to
something outside driven by the conventions below. Nothing else is pinned. The decks land in
``tools/verify/generated/decks/``, one per sheet, beside a ``<deck>.json`` that records how each
wire was driven, which ``reverify.py`` reads to compare the simulation with the sheet.

Conventions (README "Re-verifying the library from its wiring" says why):

* Models: sky130A tt from the repository-local ``.pdk/``; ``.param mc_mm_switch=0`` and
  ``mc_pr_switch=0``; run from the repository root.
* A device is the characterization device of its table (W = 1 um, nf = 1) with ``m`` equal to the
  sized width over that width, at the sized length; L and W are in microns, the model's units. Its
  four terminals are the four wires the sheet names; the body is wherever the wiring puts it. A
  device whose sheet states polarity p is a pfet.
* ``gnd`` is node 0. A supply wire (``vdd``, ``vsup``) is an ideal source at its level: the held
  level, else the level the sheet's wiring derives, else the sheet's ``VDD``, else 1.8 V.
* An input wire (``in``, ``vin``, ``vinp``/``vinn``, ``inp``/``inn``) is an ideal source at the
  sheet's level; a pair is driven as a common mode plus a difference, split evenly.
* An ``I`` element is an ideal current source, ``V`` an ideal voltage source, ``R`` and ``C`` as
  drawn: ``between: [from, to]`` maps to SPICE's ``n+ n-`` directly.
* A held output where currents arrive and leave (an n drain and a p drain, say), with free input
  ports, is held by a servo: an ideal integrator that compares the output with its level and moves
  the input, differentially for a pair. Its loop crosses unity near 10 uHz, so it is open for the
  ``.ac`` and ``.noise`` analyses, and at DC the input settles wherever the circuit needs it.
* Any other held wire a drain or source touches, and a port whose current only a parent can carry
  (one lone drain or diode on it), is held by a current hold: an ideal integrator that injects
  whatever current keeps the wire at its level. It is open above about 10 uHz, and the current it
  injects is printed: where the sheet's devices agree, it is the current the sheet says an ideal
  source supplies there.
* A wire only gates touch that the sheet holds or leaves as a port, other than an input, has no
  generator on the sheet: it is an ideal source at the sheet's own level, and the sheet is
  reported as partly pinned on that wire. So is a port held by a current hold, other than an output
  (``out``, ``outp``, ``outn``). A held wire other than an output that a current hold keeps is
  reported as held inside: the sheet's levels say the application holds it, by a circuit the sheet
  does not draw.
* The ac loads a figure reads and the wiring does not draw (``CL``, a Miller ``Cc``, an assumed load
  resistance) are added from the sheet's params, as listed in ``AC_LOADS``; a capacitor is DC-free,
  and a resistor is put in series with 1 F so it is ac-only, and is noiseless (``noisy=0``) so it
  adds nothing the sheet's noise figure leaves out.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GEN = ROOT / "tools" / "verify" / "generated"
NETLISTS = GEN / "netlists"
DECKS = GEN / "decks"
CORNER = ".pdk/sky130A/libs.tech/ngspice/corners/tt.spice"
W_CHAR = 1e-6  # the width the sky130 tables are characterized at
SUPPLIES = {"vdd", "vsup"}
INPUT = re.compile(r"^(in|vin|vinp|vinn|inp|inn)$")
OUTPUTS = {"out", "outp", "outn"}
NOISE_AT = 1e3  # Hz: where the thermal part of the input-referred density is read

# The ac loads each sheet's figures read and its wiring does not draw: (kind, value, a, b), where
# value is a param name or a figure name of the sheet, and kind is "C" (a capacitor), "Rac" (an
# ac-only, noiseless resistor to node b), or "RCser" (value "Rz/Cc": a noiseless resistor then a
# capacitor in series from a to b). Node "0" is ground.
AC_LOADS: dict[str, list[tuple[str, str, str, str]]] = {
    "otas/five-transistor-ota": [("C", "CL", "out", "0")],
    "otas/current-mirror-ota": [("C", "CL", "out", "0")],
    "otas/folded-cascode-ota": [("C", "CL", "out", "0")],
    "otas/telescopic-cascode-ota": [("C", "CL", "out", "0")],
    "otas/gain-boosted-cascode-ota": [("C", "CL", "out", "0")],
    "otas/inverter-based-ota": [("C", "CL", "out", "0")],
    "otas/differential-pair-tail": [
        ("C", "CL", "outp", "0"),
        ("C", "CL", "outn", "0"),
        ("Rac", "1/gds_load_est", "outp", "0"),
        ("Rac", "1/gds_load_est", "outn", "0"),
    ],
    "otas/degenerated-differential-pair": [
        ("C", "CL", "outp", "0"),
        ("C", "CL", "outn", "0"),
        ("Rac", "1/gds_load_est", "outp", "0"),
        ("Rac", "1/gds_load_est", "outn", "0"),
    ],
    "multistage/two-stage-miller-ota": [("C", "CL", "out", "0"), ("RCser", "Rz/Cc", "o1", "out")],
    "multistage/two-stage-cascode-comp-ota": [("C", "CL", "out", "0"), ("C", "Cc", "out", "xo")],
    "multistage/fd-two-stage-ota": [
        ("C", "CL", "outp", "0"),
        ("C", "CL", "outn", "0"),
        ("RCser", "Rz/Cc", "o1n", "outp"),
        ("RCser", "Rz/Cc", "o1p", "outn"),
    ],
    "stages/cs-amp-current-source-load": [("C", "CL", "out", "0")],
    "stages/cs-amp-diode-load": [("C", "CL", "out", "0")],
    "stages/cs-amp-resistive-load": [("C", "CL", "out", "0")],
    "stages/cascode-cs-amp": [("C", "CL", "out", "0")],
    "stages/cmos-inverter-amp": [("C", "CL", "out", "0")],
    "stages/common-gate": [("C", "CL", "out", "0")],
    "stages/source-degenerated-cs-amp": [("Rac", "R_load", "out", "0")],
    "stages/source-follower": [("Rac", "R_L", "out", "0")],
}


# Diagnostic variants: the same netlist with a partly pinned piece replaced by the loop the
# application closes around it, to say what level the circuit needs where the sheet pins it. A
# "cmfb" drives the gate from an integrator that holds the mean of the sensed outputs at their held
# level (the outputs are then not held); a "boost" drives the gate from an ideal amplifier of the
# named gain that holds the node at its held level (the node is then not held), as the booster
# amplifiers the sheet does not draw would.
VARIANTS: dict[str, dict[str, dict]] = {
    "multistage/fd-two-stage-ota": {"cmfb": {"cmfb": {"gate": "vbp", "sense": ["outp", "outn"]}}},
    "multistage/fd-telescopic-ota": {"cmfb": {"cmfb": {"gate": "vbp", "sense": ["outp", "outn"]}}},
    "otas/gain-boosted-cascode-ota": {
        "boosters": {
            "boost": [
                {"gate": "vgn", "node": "a", "gain": "boost__av0"},
                {"gate": "vgp", "node": "b", "gain": "boost__av0"},
            ]
        }
    },
}


def node(w: str) -> str:
    return "0" if w == "gnd" else w


def num(x: float) -> str:
    return f"{x:.6g}"


def value_of(net: dict, name: str) -> float:
    """A param or figure of the sheet by name, ``1/name``, or a device's quantity
    (``block__quantity``)."""
    if name.startswith("1/"):
        return 1.0 / value_of(net, name[2:])
    if name in net["params"]:
        return net["params"][name]
    if "__" in name:
        path, q = name.rsplit("__", 1)
        for dev in net["devices"]:
            if dev["path"] == path.replace("__", ".") and q in dev["quantities"]:
                return dev["quantities"][q]
    for f in net["figures"]:
        if f["name"] == name and "value" in f:
            return f["value"]
    raise KeyError(f"{net['sheet']}: no param or figure {name!r} for an ac load")


def physical(dev: dict, key: str) -> float | None:
    """A device's stated gate- or drain-source voltage as a physical difference."""
    v = dev["point"].get(key)
    if v is None:
        return None
    return -abs(v) if dev["polarity"] == "p" else v


def touches(net: dict) -> dict[str, list[tuple[str, str, str]]]:
    """Per wire: (device path or element name, terminal, polarity or element kind)."""
    out: dict[str, list[tuple[str, str, str]]] = {}
    for dev in net["devices"]:
        for p in dev["placements"]:
            for t in "dgsb":
                out.setdefault(p[t], []).append((dev["path"], t, dev["polarity"]))
    for el in net["elements"]:
        out.setdefault(el["between"][0], []).append((el["name"], "from", el["kind"]))
        out.setdefault(el["between"][1], []).append((el["name"], "to", el["kind"]))
    return out


def directions(terms: list[tuple[str, str, str]]) -> set[int]:
    """The directions current flows into a wire through its drain and source terminals and its
    current sources: +1 in, -1 out (an n drain draws current out of its wire)."""
    dirs: set[int] = set()
    for _, t, kind in terms:
        if t in ("d", "s"):
            into = 1 if (kind == "p") == (t == "d") else -1
            dirs.add(into)
        elif kind == "I":
            dirs.add(1 if t == "to" else -1)
        elif kind in ("R", "V"):
            dirs.update((1, -1))
    return dirs


def derive_levels(net: dict, known: dict[str, float]) -> dict[str, float]:
    """Levels the walk left out, propagated from known ones through each device's stated
    gate-source and drain-source voltages (a diode's drain is its gate)."""
    levels = dict(known)
    for _ in range(len(net["devices"]) + 2):
        for dev in net["devices"]:
            vgs, vds = physical(dev, "vgs"), physical(dev, "vds")
            for p in dev["placements"]:
                rels = [(p["g"], p["s"], vgs)]
                if p["d"] == p["g"]:
                    rels.append((p["d"], p["s"], vgs))
                elif vds is not None:
                    rels.append((p["d"], p["s"], vds))
                for a, b, dv in rels:
                    if dv is None:
                        continue
                    if a in levels and b not in levels:
                        levels[b] = levels[a] - dv
                    elif b in levels and a not in levels:
                        levels[a] = levels[b] + dv
    return levels


def plan(net: dict, variant: dict | None = None) -> dict:
    """How every wire is driven, and what the deck measures."""
    terms = touches(net)
    held = {lv["wire"]: lv.get("value") for lv in net["levels"]}
    ports = {p["wire"]: p.get("level") for p in net["ports"]}
    known = {w: i["level"] for w, i in net["wires"].items() if "level" in i}
    known.update({w: v for w, v in held.items() if v is not None})
    vdd = net["params"].get("VDD", 1.8)
    for w in SUPPLIES:
        if w in terms and w not in known:
            known[w] = vdd
    levels = derive_levels(net, known)

    drive: dict[str, dict] = {}
    problems: list[str] = []
    for w in sorted(set(held) | set(ports)):
        if w == "gnd":
            continue
        t = terms.get(w, [])
        current = [x for x in t if x[1] in ("d", "s", "from", "to") and x[2] != "C"]
        lvl = levels.get(w)
        if w in SUPPLIES:
            kind = "supply"
        elif INPUT.match(w):
            kind = "input"
        elif not current:
            kind = "pin"
        elif w in held:
            kind = "hold"
        elif len(current) == 1:
            kind = "hold"  # a port whose current only a parent carries
        else:
            continue  # a port the circuit on the sheet drives itself
        if lvl is None:
            problems.append(f'wire "{w}" ({kind}) has no level on the sheet to drive it at')
            continue
        drive[w] = {"kind": kind, "level": lvl, "held": w in held}

    inputs = sorted(w for w, d in drive.items() if d["kind"] == "input")
    free = [w for w in inputs if not drive[w]["held"]]
    outs = [w for w, d in drive.items() if d["kind"] == "hold" and w == "out"]
    servo = None
    if outs and free and len(free) == len(inputs) and len(directions(terms.get("out", []))) == 2:
        servo = "out"
        drive["out"]["kind"] = "servo"
    variant = variant or {}
    if "cmfb" in variant:
        loop = variant["cmfb"]
        drive[loop["gate"]] = {
            "kind": "cmfb",
            "level": levels[loop["gate"]],
            "sense": loop["sense"],
            "ref": levels[loop["sense"][0]],
            "held": False,
        }
        for w in loop["sense"]:
            drive.pop(w, None)
    for b in variant.get("boost", []):
        drive[b["gate"]] = {
            "kind": "boost",
            "level": levels[b["gate"]],
            "node": b["node"],
            "ref": levels[b["node"]],
            "gain": value_of(net, b["gain"]),
            "held": False,
        }
        drive.pop(b["node"], None)
    # Pinned: a wire with no generator on the sheet, driven at the sheet's own level. Held inside:
    # a wire other than an output that the sheet's levels hold, where the application's circuit
    # that holds it is not drawn.
    pinned = sorted(
        w
        for w, d in drive.items()
        if d["kind"] == "pin" or (d["kind"] == "hold" and not d["held"] and w not in OUTPUTS)
    )
    inside = sorted(w for w, d in drive.items() if d["kind"] == "hold" and d["held"] and w not in OUTPUTS)
    # The analysis ports: the input pair or single input, the output pair or single output.
    pair = [w for w in ("vinp", "vinn") if w in drive] or [w for w in ("inp", "inn") if w in drive]
    if len(pair) == 2:
        stim = {"pair": pair}
    elif len(inputs) == 1:
        stim = {"single": inputs[0]}
    else:
        stim = None
    if "outp" in terms and "outn" in terms:
        out = {"pair": ["outp", "outn"]}
    elif "out" in terms:
        out = {"single": "out"}
    else:
        out = None
    return {
        "drive": drive,
        "servo": servo,
        "pinned": pinned,
        "inside": inside,
        "stim": stim,
        "out": out,
        "levels": levels,
        "problems": problems,
    }


def inst(dev: dict, i: int) -> str:
    base = "x" + (dev["path"].replace(".", "_") or "self")
    return f"{base}_{i}" if len(dev["placements"]) > 1 else base


def model_of(net: dict, dev: dict) -> str:
    return net["models"][dev["device"]] if "device" in dev else net["models"]["top"]


def deck(net: dict, pl: dict) -> str:
    sheet = net["sheet"]
    lines = [
        f"* {net['title']} ({sheet}.json): generated from its wiring by tools/verify/gen_decks.py",
        f"* from the sized netlist the sheet evaluates to on {net['condition']}. Do not edit; regenerate.",
    ]
    if pl["pinned"]:
        lines.append(f"* partly pinned: {', '.join(pl['pinned'])} (no generator on the sheet)")
    if pl["inside"]:
        lines.append(f"* held where the sheet's levels hold them, by a circuit not drawn: {', '.join(pl['inside'])}")
    lines += [
        ".param mc_mm_switch=0",
        ".param mc_pr_switch=0",
        f".include {CORNER}",
        "",
        "* devices: the characterization device (W = 1 um, nf = 1) times m = W / 1 um",
    ]
    for dev in net["devices"]:
        for i, p in enumerate(dev["placements"]):
            nodes = " ".join(node(p[t]) for t in "dgsb")
            lines.append(
                f"{inst(dev, i)} {nodes} {model_of(net, dev)} "
                f"L={num(dev['L'] * 1e6)} W=1 nf=1 m={num(dev['W'] / W_CHAR)}"
            )
    if net["elements"]:
        lines += ["", "* elements as drawn"]
    for el in net["elements"]:
        a, b = (node(w) for w in el["between"])
        letter = el["kind"].lower()
        val = num(el["value"])
        lines.append(f"{letter}{el['name']} {a} {b} {'dc ' + val if el['kind'] in 'IV' else val}")

    lines += ["", "* wires driven from outside the sheet"]
    stim = pl["stim"]
    for w, d in sorted(pl["drive"].items()):
        if d["kind"] == "input" and stim:
            continue
        if d["kind"] in ("supply", "pin", "input"):
            lines.append(f"v{w} {node(w)} 0 dc {num(d['level'])}")
        elif d["kind"] == "cmfb":
            a, b = (node(x) for x in d["sense"])
            lines += [
                f"vcmref_{w} cmref_{w} 0 dc {num(d['ref'])}",
                f"bcms_{w} cms_{w} 0 v=(v({a})+v({b}))/2",
                f"gcm_{w} 0 cmi_{w} cms_{w} cmref_{w} 1u",
                f"ccm_{w} cmi_{w} 0 1",
                f"rcm_{w} cmi_{w} 0 1e15",
                f"v0_{w} g0_{w} 0 dc {num(d['level'])}",
                f"e_{w} {node(w)} g0_{w} cmi_{w} 0 1",
            ]
        elif d["kind"] == "boost":
            lines += [
                f"v0_{w} g0_{w} 0 dc {num(d['level'])}",
                f"vbref_{w} bref_{w} 0 dc {num(d['ref'])}",
                f"e_{w} {node(w)} g0_{w} bref_{w} {node(d['node'])} {num(d['gain'])}",
            ]
        elif d["kind"] == "hold":
            lines += [
                f"vhref_{w} href_{w} 0 dc {num(d['level'])}",
                f"ghin_{w} 0 hint_{w} href_{w} {node(w)} 1u",
                f"chin_{w} hint_{w} 0 1",
                f"rhin_{w} hint_{w} 0 1e15",
                f"ghout_{w} 0 {node(w)} hint_{w} 0 1u",
            ]
    if stim:
        lv = pl["levels"]
        if "pair" in stim:
            p, n = stim["pair"]
            cm = (lv[p] + lv[n]) / 2
            diff = lv[p] - lv[n]
            lines += [
                f"vcm cm 0 dc {num(cm)}",
                "vid dif os dc 0 ac 1",
                f"ep {p} cm dif 0 0.5",
                f"en {n} cm dif 0 -0.5",
            ]
        else:
            w = stim["single"]
            diff = 0.0
            lines += [f"vcm cm 0 dc {num(lv[w])}", "vid dif os dc 0 ac 1", f"ein {w} cm dif 0 1"]
        if pl["servo"]:
            lines += [
                f"vref ref 0 dc {num(pl['drive'][pl['servo']]['level'])}",
                f"gsv 0 os ref {pl['servo']} 1u",
                "csv os 0 1",
            ]
        else:
            lines.append(f"vos os 0 dc {num(diff)}")

    out = pl["out"]
    if out:
        a = out["pair"][0] if "pair" in out else out["single"]
        lines += ["", "* output impedance probe (ac 0 until the impedance run)", f"izp 0 {a} dc 0 ac 0"]
        if "pair" in out:
            lines.append(f"izn {out['pair'][1]} 0 dc 0 ac 0")
    loads = AC_LOADS.get(sheet, [])
    if loads:
        lines += ["", "* ac loads the figures read and the wiring does not draw"]
    for k, (kind, val, a, b) in enumerate(loads):
        if kind == "C":
            lines.append(f"cload{k} {node(a)} {node(b)} {num(value_of(net, val))}")
        elif kind == "Rac":
            lines += [
                f"rload{k} {node(a)} rl{k} {num(value_of(net, val))} noisy=0",
                f"cblk{k} rl{k} {node(b)} 1",
            ]
        elif kind == "RCser":
            rname, cname = val.split("/")
            lines += [
                f"rz{k} {node(a)} rz{k} {num(value_of(net, rname))} noisy=0",
                f"cc{k} rz{k} {node(b)} {num(value_of(net, cname))}",
            ]

    lines += ["", ".control", "op"]
    res: list[str] = []

    def let(name: str, expr: str) -> None:
        res.append(f"let r_{name} = {expr}")

    for w in sorted(net["wires"]):
        if w != "gnd":
            let(f"v_{w}", f"v({node(w)})")
    for dev in net["devices"]:
        mdl = model_of(net, dev)
        for i in range(len(dev["placements"])):
            nm = inst(dev, i)
            for q in ("id", "gm", "gds", "gmbs"):
                let(f"{q}_{nm}", f"@m.{nm}.m{mdl}[{q}]")
    for w, d in sorted(pl["drive"].items()):
        if d["kind"] == "hold":
            let(f"hold_{w}", f"1e-6*v(hint_{w})")
        if d["kind"] == "supply":
            let(f"isup_{w}", f"-i(v{w})")
    lines += res
    lines.append("print " + " ".join(r.split()[1] for r in res))
    if stim and out:
        oexpr = f"v({out['pair'][0]})-v({out['pair'][1]})" if "pair" in out else f"v({out['single']})"
        onoise = f"v({out['pair'][0]},{out['pair'][1]})" if "pair" in out else f"v({out['single']})"
        lines += [
            "ac dec 50 1 10g",
            f"let vo = {oexpr}",
            "let gmag = mag(vo)",
            "let gph = cph(vo)*180/pi",
            "let r_av = gmag[0]",
            "let r_ph0 = gph[0]",
            "print r_av r_ph0",
            "let lim3db = r_av/sqrt(2)",
            "meas ac r_f3db when gmag=lim3db",
            "meas ac r_ugf when gmag=1",
            "meas ac r_phu find gph when gmag=1",
            "let ph180 = r_ph0 - 180",
            "meas ac r_f180 when gph=ph180",
            "meas ac r_g180 find gmag when gph=ph180",
        ]
        devs = [(inst(d, i), model_of(net, d)) for d in net["devices"] for i in range(len(d["placements"]))]
        flick = " + ".join(f"onoise.m.{nm}.m{mdl}.1overf^2" for nm, mdl in devs)
        lines += [
            f"noise {onoise} vid dec 10 1 1e6 1",
            "setplot noise1",
            "let gain = onoise_spectrum/inoise_spectrum",
            f"let flick = {flick}",
            "let vth = sqrt(onoise_spectrum^2 - flick)/gain",
            f"let r_vn_total = inoise_spectrum[{noise_index(NOISE_AT)}]",
            f"let r_vn_thermal = vth[{noise_index(NOISE_AT)}]",
            "print r_vn_total r_vn_thermal",
            "setplot ac1",
        ]
    if out:
        lines += [
            "alter vid acmag = 0" if stim else "",
            "alter izp acmag = 1",
            "alter izn acmag = 1" if "pair" in out else "",
            "ac dec 10 1 100",
        ]
        if "pair" in out:
            lines.append(f"let r_rout = mag(v({out['pair'][0]})-v({out['pair'][1]}))[0]/2")
        else:
            lines.append(f"let r_rout = mag(v({out['single']}))[0]")
        lines.append("print r_rout")
    lines += [".endc", ".end", ""]
    return "\n".join(x for x in lines if x is not None)


def noise_index(f: float) -> int:
    """Index of frequency f in a `dec 10` sweep from 1 Hz."""
    return round(10 * math.log10(f))


def main(argv: list[str]) -> int:
    only = [a for a in argv if not a.startswith("-")]
    DECKS.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in sorted(NETLISTS.glob("*.json")):
        net = json.loads(f.read_text())
        if not net["circuit"] or (only and not any(o in net["sheet"] for o in only)):
            continue
        unsized = [d["path"] or "(own device)" for d in net["devices"] if not d["sized"]]
        for vname, variant in [("", None), *VARIANTS.get(net["sheet"], {}).items()]:
            stem = f"{f.stem}__{vname}" if vname else f.stem
            pl = plan(net, variant)
            meta = {"sheet": net["sheet"], "netlist": f.stem, "variant": vname, "plan": pl, "ac_loads": AC_LOADS.get(net["sheet"], [])}
            if unsized:
                pl["problems"].append(f"devices that did not size: {', '.join(unsized)}")
            text = None
            if not pl["problems"]:
                try:
                    text = deck(net, pl)
                except KeyError as e:
                    pl["problems"].append(str(e))
            if text is None:
                meta["deck"] = None
                print(f"{net['sheet']}: NO DECK: {'; '.join(pl['problems'])}")
            else:
                path = DECKS / f"{stem}.cir"
                path.write_text(text)
                meta["deck"] = str(path.relative_to(ROOT))
                n += 1
            (DECKS / f"{stem}.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"{n} decks in {DECKS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
