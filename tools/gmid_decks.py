#!/usr/bin/env python3
"""gmid_decks — build ngspice gm/ID ``.dc``-sweep decks for open-PDK devices.

One deck per ``(device, corner, temp, L, vsb)``: a nested ``.dc Vg … Vd …`` (vgs
inner / fine, vds outer / coarse), the corner models loaded via the PDK's own
mechanism (``.include`` of a corner file for sky130; sectioned ``.lib file
section`` for gf180/IHP), the device subckt instance ``XM1``, and ``.save all``
plus the internal small-signal params at the hierarchical
``@<prefix>.xm1.<internal>[param]`` address.

Conventions (verified live):
- sky130: L/W in MICRONS (bare), internal device ``m<subckt>``, corner via
  ``.include corners/<corner>.spice`` (sectioned ``.lib`` works too once ngspice
  runs with ``ngbehavior=hsa`` — set via a project ``.spiceinit`` — otherwise the
  runner's LTspice-compat ``lt`` mode reads the corner name as a filename).
- gf180mcu: L/W in METERS (use ``u`` suffix), internal device ``m0``, corner via
  sectioned ``.lib '<sm141064.ngspice>' typical`` (needs the ``ngbehavior=hsa``
  ``.spiceinit``; there is no standalone corner file to ``.include``).
- IHP sg13g2: OSDI PSP103 devices (``save_prefix='n'``); deck must ``osdi`` the
  compiled ``.osdi`` first (handled by the caller), corner via sectioned ``.lib``.

PMOS is swept negative (the mostab importer canonicalises sign); vsb applies a
bulk bias (NMOS bulk below source, PMOS bulk above); temperature via ``.temp``.

Two optional additions to the self-running deck:
- ``vds_fine=(step, stop)`` runs a second nested ``dc`` over ``vd = 0 … stop`` at the
  finer step and appends it to the same ``wrdata`` file, so the drain-voltage axis is
  dense near zero (the saturation knee) and coarse above.
- ``noise_to=`` runs one single-frequency ``noise`` analysis at every (vgs, vds) point
  of that axis. ``HO`` turns the drain current into ``v(o)`` at 1 V/A, so the output
  noise is the drain noise current and its per-device parts give the thermal and the
  flicker drain-current densities in A/√Hz; their squares at 1 Hz are the mostab
  ``sth`` and ``sfl`` columns. A noise analysis cannot run inside a ``dc`` sweep, so
  the deck loops over the grid with ``alter`` and echoes one line per point.
"""
from __future__ import annotations

import math
import os
from collections.abc import Callable
from dataclasses import dataclass

from mostab_io import fmt_num

# BSIM4 small-signal op-point outputs to save. gm/gds/id are load-bearing for
# gm/ID; the rest are standard. An unrecognized name surfaces as the tool's
# unrecognized-save relay (a fake 0.0 column), so we keep to the common set.
SAVE_PARAMS = ["gm", "gds", "id", "vth", "vdsat", "gmbs", "cgg", "cgs", "cgd"]

# The noise columns, in the order the deck echoes them: the drain thermal-noise and
# flicker-noise current PSDs [A^2/Hz], both taken from a noise analysis at 1 Hz.
NOISE_PARAMS = ["sth", "sfl"]


def _device_path(pdk: "Pdk", subckt: str) -> str:
    """The device's hierarchical name: ``<prefix>.xm1.<internal>`` for a subckt device,
    bare ``m1`` otherwise. The single owner of the device addressing that the saved
    op-point params and the noise vectors share."""
    return f"{pdk.save_prefix}.xm1.{pdk.internal(subckt)}" if pdk.is_subckt else "m1"


def _op_vectors(pdk: "Pdk", subckt: str) -> list[str]:
    """The bare ``@<addr>[param]`` vector name for each saved op-point param.
    Referenced bare because the i()/v() wrappers seen in the rawfile are not nutmeg
    functions. This is the single owner of the save/wrdata addressing."""
    return [f"@{_device_path(pdk, subckt)}[{p}]" for p in SAVE_PARAMS]


def noise_vectors(pdk: "Pdk", subckt: str) -> list[str]:
    """The noise-plot vectors behind ``NOISE_PARAMS``, in that order: the device's
    channel thermal noise (``.id``) and flicker noise (``.1overf``), each the
    output-referred density in A/rtHz at the analysis frequency."""
    dev = _device_path(pdk, subckt)
    return [f"onoise.{dev}.id", f"onoise.{dev}.1overf"]


def sweep_values(stop: float, step: float) -> list[float]:
    """The magnitudes a ``dc`` sweep from 0 to ``stop`` at ``step`` visits: ``k*step``
    for k = 0, 1, …, up to and including ``stop`` (ngspice keeps an end point the
    accumulated step reaches within rounding, and stops short of one it overshoots,
    so 0..3.3 at 8 mV ends at 3.296)."""
    n = math.floor(stop / step + 1e-6)
    return [k * step for k in range(n + 1)]


def drain_voltages(vdd: float, vds_step: float,
                   vds_fine: tuple[float, float] | None = None) -> list[float]:
    """The drain-voltage axis magnitudes: the coarse ``0..vdd`` sweep at ``vds_step``,
    plus, with ``vds_fine=(step, stop)``, the fine ``0..stop`` sweep, merged in order.
    Two values that format to the same table coordinate are one point, and the coarse
    one is kept, matching the generator's merge of the two sweeps."""
    axis = {_g(v): v for v in sweep_values(vdd, vds_step)}
    if vds_fine:
        for v in sweep_values(vds_fine[1], vds_fine[0]):
            axis.setdefault(_g(v), v)
    return sorted(axis.values())


def wrdata_signals(pdk: "Pdk", subckt: str) -> list[str]:
    """Ordered `wrdata` signal tokens: v(d) (=vds) then each saved op-point param.
    Column order is fixed by this list (wrdata is headerless), so `parse_wrdata_row`
    maps columns positionally — no name-munging."""
    return ["v(d)", *_op_vectors(pdk, subckt)]


def wrdata_columns() -> int:
    """Column count of a `wrdata_signals` row: wrdata writes (scale, value) per signal."""
    return 2 * (1 + len(SAVE_PARAMS))


def parse_wrdata_row(values: list[float]) -> tuple[float, float, list[float]]:
    """Decode one wrdata row (in `wrdata_signals` order) -> (vgs, vds, [params...]).
    wrdata writes (scale, value) per signal with the scale (=vgs, the ``.dc`` inner
    axis) repeated; the signal order is [v(d), *SAVE_PARAMS], so vgs=col0, vds=col1,
    and SAVE_PARAMS[i]=col 3+2i. Kept beside `wrdata_signals` so producer and consumer
    of the column layout can never drift."""
    return values[0], values[1], [values[3 + 2 * i] for i in range(len(SAVE_PARAMS))]


@dataclass(frozen=True)
class Pdk:
    """A PDK's deck recipe."""

    name: str
    corner_lines: Callable[[str], list[str]]   # corner -> directive lines that load its models
    pre_params: tuple = ()                      # `.param` lines emitted before the corner load
    is_subckt: bool = True                      # True: X-instance + @<prefix>.xm1.<internal>; False: bare M1
    internal: Callable[[str], str] = lambda subckt: f"m{subckt}"   # internal device name from subckt
    si_units: bool = False                      # False: L/W bare microns (sky130); True: SI, `u`-suffixed (gf180/IHP)
    save_prefix: str = "m"                      # device-letter for @<prefix>.<path>[param] (m=BSIM, n=OSDI)
    extra_head: tuple = ()                      # lines emitted FIRST (e.g. `osdi <path>` for IHP)


def save_line(pdk: Pdk, subckt: str) -> str:
    return "all " + " ".join(_op_vectors(pdk, subckt))


def build_deck(
    pdk: Pdk,
    *,
    subckt: str,
    dev_type: str,          # 'n' | 'p'
    vdd: float,
    corner: str,
    L_um: float,
    W_um: float,
    vsb: float = 0.0,
    temp: float = 27.0,
    nf: int = 1,
    vgs_step: float = 0.025,
    vds_step: float = 0.15,
    vds_fine: tuple[float, float] | None = None,
    wrdata_to: str | None = None,
    noise_to: str | None = None,
) -> str:
    """Return the deck string for one operating-grid sweep. ``vds_fine`` and
    ``noise_to`` (see the module docstring) apply only to a self-running deck, so
    they need ``wrdata_to``."""
    if dev_type not in ("n", "p"):
        raise ValueError(f"dev_type must be 'n'|'p', got {dev_type!r}")
    if (vds_fine or noise_to) and not wrdata_to:
        raise ValueError("vds_fine and noise_to need a self-running deck (wrdata_to)")
    s = 1.0 if dev_type == "n" else -1.0       # polarity: PMOS sweeps negative
    vmax = _g(s * vdd)
    gstep, dstep = _g(s * vgs_step), _g(s * vds_step)
    vb = _g(-s * vsb)                           # NMOS bulk -vsb; PMOS bulk +vsb

    def dc_args(vd_stop: str, vd_step: str) -> str:
        # The nested sweep both DC analyses run: the gate over the supply, inside the drain to
        # `vd_stop` in steps of `vd_step`.
        return f"vg 0 {vmax} {gstep} vd 0 {vd_stop} {vd_step}"

    inst = "XM1" if pdk.is_subckt else "M1"
    lw = (lambda x: f"{_g(x)}u") if pdk.si_units else _g   # gf180/IHP: SI; sky130: bare microns

    lines = [f"* {pdk.name} {subckt} gm/ID  corner={corner} L={L_um}u W={W_um}u "
             f"vsb={vsb} temp={temp} ({'NMOS' if dev_type == 'n' else 'PMOS'})"]
    lines += list(pdk.extra_head)
    lines += [f".param {p}" for p in pdk.pre_params]
    lines += list(pdk.corner_lines(corner))
    if temp != 27.0:
        lines.append(f".temp {_g(temp)}")
    lines += [
        f"vb b 0 {vb}",
        f"{inst} d g 0 b {subckt} L={lw(L_um)} W={lw(W_um)} nf={nf}",
        "vd d 0 0",
        # The noise analysis takes its input at vg and reads the drain current as v(o).
        "vg g 0 0 ac 1" if noise_to else "vg g 0 0",
        *(["ho o 0 vd 1"] if noise_to else []),
        f".dc {dc_args(vmax, dstep)}",
        f".save {save_line(pdk, subckt)}",
    ]
    if wrdata_to:
        # Self-running deck for standalone `ngspice -b`: run the .dc, then dump the
        # signals to a headerless CSV the generator parses positionally.
        wrdata = f"wrdata {wrdata_to} {' '.join(wrdata_signals(pdk, subckt))}"
        lines += [".control", "run", wrdata]
        if vds_fine:
            # The fine sweep is appended after the coarse one, so where the two share a
            # drain voltage the coarse rows come first in the file.
            fstep, fstop = vds_fine
            lines += ["set appendwrite",
                      f"dc {dc_args(_g(s * fstop), _g(s * fstep))}", wrdata]
        if noise_to:
            # One 1 Hz noise analysis per grid point. A single-frequency noise analysis
            # makes one plot, the spectrum, and leaves it current, so the vectors are read
            # from it directly; `destroy all` then drops it so the plots do not pile up.
            th, fl = noise_vectors(pdk, subckt)
            gates = " ".join(_g(s * v) for v in sweep_values(vdd, vgs_step))
            drains = " ".join(_g(s * v) for v in drain_voltages(vdd, vds_step, vds_fine))
            lines += [
                f"foreach dv {drains}",
                "alter vd dc = $dv",
                f"foreach gv {gates}",
                "alter vg dc = $gv",
                "noise v(o) vg lin 1 1 1 1",
                f"let sth = {th}^2",
                f"let sfl = {fl}^2",
                f'echo "$gv $dv $&sth $&sfl" >> {noise_to}',
                "destroy all",
                "end",
                "end",
            ]
        lines.append(".endc")
    lines.append(".end")
    return "\n".join(lines) + "\n"


def _g(x: float) -> str:
    """A 6 sig-fig number for decks and generated tables (-0.0 normalised); a
    non-finite value passes through as 'inf'/'nan' for the QA gate to catch."""
    return fmt_num(x, 6, allow_nonfinite=True)


# ---- PDK registry (sky130 + gf180 verified; IHP pending OSDI build) ----
# PDK_ROOT locates the fetched PDKs so the recipe is portable; defaults to the
# repo-local `.pdk/` (two levels up from this file) used during development.
_DEFAULT_PDK_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".pdk")
_PDK_ROOT = os.environ.get("PDK_ROOT", _DEFAULT_PDK_ROOT)
_SKY_NG = f"{_PDK_ROOT}/sky130A/libs.tech/ngspice"
_GF_NG = f"{_PDK_ROOT}/gf180mcuD/libs.tech/ngspice"

SKY130 = Pdk(
    name="sky130",
    corner_lines=lambda c: [f".include {_SKY_NG}/corners/{c}.spice"],
    pre_params=("mc_mm_switch=0", "mc_pr_switch=0"),
    is_subckt=True,
    si_units=False,
)

GF180 = Pdk(
    name="gf180mcu",
    # design.ngspice sets the model-selection switches (fnoicor, sw_stat_*, skews) the
    # corner cards assume are already defined; include it before the sectioned corner .lib.
    corner_lines=lambda c: [f".include {_GF_NG}/design.ngspice",
                            f".lib '{_GF_NG}/sm141064.ngspice' {c}"],
    is_subckt=True,
    internal=lambda _subckt: "m0",   # gf180 wrapper's inner BSIM device is literally m0
    si_units=True,                   # gf180 subckts take L/W in METERS -> use `u`
)


def _selftest() -> None:
    # sky130 NMOS: positive sweep, bulk -vsb, hierarchical save, .include corner, bare microns.
    d = build_deck(SKY130, subckt="sky130_fd_pr__nfet_01v8", dev_type="n", vdd=1.8,
                   corner="tt", L_um=0.15, W_um=1.0, vsb=0.6)
    assert ".param mc_mm_switch=0" in d and f".include {_SKY_NG}/corners/tt.spice" in d
    assert "vb b 0 -0.6" in d
    assert "XM1 d g 0 b sky130_fd_pr__nfet_01v8 L=0.15 W=1 nf=1" in d   # bare microns
    assert ".dc vg 0 1.8 0.025 vd 0 1.8 0.15" in d
    assert "@m.xm1.msky130_fd_pr__nfet_01v8[gm]" in d and d.strip().endswith(".end")
    # sky130 PMOS: negative sweep, bulk +vsb.
    p = build_deck(SKY130, subckt="sky130_fd_pr__pfet_01v8", dev_type="p", vdd=1.8,
                   corner="tt", L_um=0.15, W_um=1.0, vsb=0.3)
    assert "vb b 0 0.3" in p and ".dc vg 0 -1.8 -0.025 vd 0 -1.8 -0.15" in p
    # gf180: sectioned .lib, SI units (u-suffixed), internal m0, sw_stat switches.
    g = build_deck(GF180, subckt="nfet_03v3", dev_type="n", vdd=3.3, corner="typical",
                   L_um=0.28, W_um=10.0, vsb=0.0)
    assert f".include {_GF_NG}/design.ngspice" in g
    assert f".lib '{_GF_NG}/sm141064.ngspice' typical" in g
    assert "XM1 d g 0 b nfet_03v3 L=0.28u W=10u nf=1" in g          # SI: u-suffixed
    assert "@m.xm1.m0[gm]" in g                                      # gf180 inner device m0
    assert ".dc vg 0 3.3 0.025 vd 0 3.3 0.15" in g
    # Without noise_to the deck is the plain DC sweep: no AC input, no HO, no loop.
    assert "vg g 0 0\n" in d and "ho o" not in d and "noise" not in d
    # Self-running deck with the fine vds sweep and the per-point noise loop.
    n = build_deck(SKY130, subckt="sky130_fd_pr__nfet_01v8", dev_type="n", vdd=1.8,
                   corner="tt", L_um=0.5, W_um=1.0, vgs_step=0.008, vds_step=0.2,
                   vds_fine=(0.025, 0.3), wrdata_to="d.csv", noise_to="n.txt")
    assert "vg g 0 0 ac 1" in n and "ho o 0 vd 1" in n
    assert ".dc vg 0 1.8 0.008 vd 0 1.8 0.2" in n                    # coarse sweep unchanged
    assert n.index("wrdata d.csv") < n.index("set appendwrite") < n.index(
        "dc vg 0 1.8 0.008 vd 0 0.3 0.025") < n.rindex("wrdata d.csv")   # fine sweep appended
    assert ("foreach dv 0 0.025 0.05 0.075 0.1 0.125 0.15 0.175 0.2 0.225 0.25 0.275 0.3 "
            "0.4 0.6 0.8 1 1.2 1.4 1.6 1.8\n") in n
    assert "foreach gv 0 0.008 0.016 " in n and " 1.792 1.8\n" in n
    assert "let sth = onoise.m.xm1.msky130_fd_pr__nfet_01v8.id^2" in n
    assert "let sfl = onoise.m.xm1.msky130_fd_pr__nfet_01v8.1overf^2" in n
    assert 'echo "$gv $dv $&sth $&sfl" >> n.txt' in n
    # PMOS: the fine sweep and the loop run negative.
    pn = build_deck(SKY130, subckt="sky130_fd_pr__pfet_01v8", dev_type="p", vdd=1.8,
                    corner="tt", L_um=0.5, W_um=1.0, vgs_step=0.008, vds_step=0.2,
                    vds_fine=(0.025, 0.3), wrdata_to="d.csv", noise_to="n.txt")
    assert "dc vg 0 -1.8 -0.008 vd 0 -0.3 -0.025" in pn
    assert "foreach dv 0 -0.025 -0.05 " in pn and "foreach gv 0 -0.008 " in pn
    assert noise_vectors(GF180, "nfet_03v3") == ["onoise.m.xm1.m0.id", "onoise.m.xm1.m0.1overf"]
    try:
        build_deck(SKY130, subckt="sky130_fd_pr__nfet_01v8", dev_type="n", vdd=1.8,
                   corner="tt", L_um=0.5, W_um=1.0, noise_to="n.txt")
    except ValueError:
        pass
    else:
        raise AssertionError("noise_to without wrdata_to built a deck")
    # temp directive only when != 27
    assert ".temp" not in d and ".temp 125" in build_deck(
        SKY130, subckt="sky130_fd_pr__nfet_01v8", dev_type="n", vdd=1.8, corner="tt",
        L_um=0.15, W_um=1.0, temp=125.0)
    # wrdata decode round-trips the (scale,value)-pair layout in [v(d), *SAVE_PARAMS] order.
    pv = [1e-3, 2e-6, 1e-4, 0.5, 0.06, 1e-5, 1e-15, 5e-16, 4e-16][: len(SAVE_PARAMS)]
    row = [0.5, 1.8]
    for val in pv:
        row += [0.5, val]
    assert len(row) == wrdata_columns()
    vgs, vds, ps = parse_wrdata_row(row)
    assert vgs == 0.5 and vds == 1.8 and ps == pv
    print("ok: sky130 (bare-um, .include, m<subckt>) + gf180 (SI-u, sectioned .lib, m0) decks "
          "build correctly, with the fine vds sweep and the noise loop")


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("run this self-test without -O; it relies on assert")
    _selftest()
