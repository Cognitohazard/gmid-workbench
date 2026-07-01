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
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

# BSIM4 small-signal op-point outputs to save. gm/gds/id are load-bearing for
# gm/ID; the rest are standard. An unrecognized name surfaces as the tool's
# unrecognized-save relay (a fake 0.0 column), so we keep to the common set.
SAVE_PARAMS = ["gm", "gds", "id", "vth", "vdsat", "gmbs", "cgg", "cgs", "cgd"]

def _op_vectors(pdk: "Pdk", subckt: str) -> list[str]:
    """The bare ``@<addr>[param]`` vector name for each saved op-point param. The
    address is hierarchical for a subckt device (``<prefix>.xm1.<internal>``), bare
    ``m1`` otherwise. Referenced bare because the i()/v() wrappers seen in the rawfile
    are not nutmeg functions. This is the single owner of the save/wrdata addressing."""
    dev = f"{pdk.save_prefix}.xm1.{pdk.internal(subckt)}" if pdk.is_subckt else "m1"
    return [f"@{dev}[{p}]" for p in SAVE_PARAMS]


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
    wrdata_to: str | None = None,
) -> str:
    """Return the deck string for one operating-grid sweep."""
    if dev_type not in ("n", "p"):
        raise ValueError(f"dev_type must be 'n'|'p', got {dev_type!r}")
    s = 1.0 if dev_type == "n" else -1.0       # polarity: PMOS sweeps negative
    vmax = _g(s * vdd)
    gstep, dstep = _g(s * vgs_step), _g(s * vds_step)
    vb = _g(-s * vsb)                           # NMOS bulk -vsb; PMOS bulk +vsb
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
        "vg g 0 0",
        f".dc vg 0 {vmax} {gstep} vd 0 {vmax} {dstep}",
        f".save {save_line(pdk, subckt)}",
    ]
    if wrdata_to:
        # Self-running deck for standalone `ngspice -b`: run the .dc, then dump the
        # signals to a headerless CSV the generator parses positionally.
        lines += [".control", "run",
                  f"wrdata {wrdata_to} {' '.join(wrdata_signals(pdk, subckt))}", ".endc"]
    lines.append(".end")
    return "\n".join(lines) + "\n"


def _g(x: float) -> str:
    v = float(x)
    if v == 0.0:
        v = 0.0
    return format(v, ".6g")


# ---- PDK registry (sky130 + gf180 verified; IHP pending OSDI build) ----
# PDK_ROOT locates the fetched PDKs so the recipe is portable; defaults to the
# repo-local `.pdk/` used during development.
import os as _os

_PDK_ROOT = _os.environ.get("PDK_ROOT", ".pdk")
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
    print("ok: sky130 (bare-um, .include, m<subckt>) + gf180 (SI-u, sectioned .lib, m0) decks build correctly")


if __name__ == "__main__":
    _selftest()
