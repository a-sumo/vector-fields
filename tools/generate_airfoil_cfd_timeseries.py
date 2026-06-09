#!/usr/bin/env python3
"""Bake a compact airfoil CFD time series for Lens Studio.

This is a dependency-free D2Q9 lattice-Boltzmann solve around a Joukowski
airfoil. It exports the same TypeScript schema used by CarFlowStreamlines.ts.
The result is intentionally "visual CFD": stable, plausible wind-tunnel flow
with animated wake shedding and slice-local obstacle masks.
"""

from __future__ import annotations

import json
import math
import os
import uuid


OUT = "Assets/Scripts/AirfoilCfdTimeSeries.ts"
META_OUT = OUT + ".meta"
PREVIEW_OUT = "tools/airfoil_cfd_mask_preview.html"

W = 96
H = 48
NT = 16
NZ = 24
N_LINES = 19
M_STEPS = 44
WARMUP = 620
STEPS_PER_FRAME = 28
U_IN = 0.082
VISC = 0.019
SMAG = 0.10

X0 = -5.35
X1 = 5.35
Y0 = -2.25
Y1 = 2.25
Z0 = -1.82
Z1 = 1.82

AOA_DEG = 8.0
THICKNESS = 0.115
CAMBER = 0.055

W9 = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36]
EX = [0, 1, 0, -1, 0, 1, -1, -1, 1]
EY = [0, 0, 1, 0, -1, 1, 1, -1, -1]
OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6]
N = W * H

f0 = [0.0] * (N * 9)
f1 = [0.0] * (N * 9)
rho = [1.0] * N
ux = [0.0] * N
uy = [0.0] * N
barrier = [0] * N


def idx(x: int, y: int) -> int:
    return x + y * W


def clamp(v: float, a: float, b: float) -> float:
    return max(a, min(b, v))


def round3(v: float) -> float:
    return round(v, 3)


def map_x(px: float) -> float:
    return X0 + (px / (W - 1)) * (X1 - X0)


def map_y(py: float) -> float:
    return Y1 - (py / (H - 1)) * (Y1 - Y0)


def grid_x(x: float) -> float:
    return ((x - X0) / (X1 - X0)) * W - 0.5


def grid_y(y: float) -> float:
    return ((Y1 - y) / (Y1 - Y0)) * H - 0.5


def feq(r: float, u: float, v: float, k: int) -> float:
    cu = 3.0 * (EX[k] * u + EY[k] * v)
    return r * W9[k] * (1.0 + cu + 0.5 * cu * cu - 1.5 * (u * u + v * v))


def airfoil_polygon(scale_factor: float = 1.0) -> list[tuple[float, float]]:
    angle = -AOA_DEG * math.pi / 180.0
    cx = -THICKNESS
    cy = CAMBER
    radius = math.sqrt((1.0 - cx) * (1.0 - cx) + cy * cy)
    center_x = W * 0.30
    center_y = H * 0.52
    base_scale = H * 0.145
    scale_x = base_scale * (0.34 + 0.66 * scale_factor)
    scale_y = base_scale * (0.18 + 0.82 * scale_factor)
    points: list[tuple[float, float]] = []
    for i in range(241):
        theta = (i / 240.0) * math.tau
        zx = cx + radius * math.cos(theta)
        zy = cy + radius * math.sin(theta)
        den = max(1e-4, zx * zx + zy * zy)
        wx = zx * (1.0 + 1.0 / den)
        wy = zy * (1.0 - 1.0 / den)
        rx = wx * math.cos(angle) - wy * math.sin(angle)
        ry = wx * math.sin(angle) + wy * math.cos(angle)
        points.append((center_x + rx * scale_x, center_y - ry * scale_y))
    return points


def point_in_poly(px: float, py: float, poly: list[tuple[float, float]]) -> bool:
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > py) != (yj > py):
            x_cross = (xj - xi) * (py - yi) / max(1e-8, yj - yi) + xi
            if px < x_cross:
                inside = not inside
        j = i
    return inside


def cells_from_polygon(poly: list[tuple[float, float]]) -> list[list[int]]:
    cells = [[0 for _ in range(W)] for _ in range(H)]
    for x in range(W):
        cells[0][x] = 1
        cells[H - 1][x] = 1
    min_x = max(0, math.floor(min(p[0] for p in poly)) - 1)
    max_x = min(W - 1, math.ceil(max(p[0] for p in poly)) + 1)
    min_y = max(1, math.floor(min(p[1] for p in poly)) - 1)
    max_y = min(H - 2, math.ceil(max(p[1] for p in poly)) + 1)
    for y in range(min_y, max_y + 1):
        for x in range(min_x, max_x + 1):
            if point_in_poly(x + 0.5, y + 0.5, poly):
                cells[y][x] = 1
    return cells


def set_barrier_from_cells(cells: list[list[int]]) -> None:
    for y in range(H):
        for x in range(W):
            barrier[idx(x, y)] = cells[y][x]


def init_lattice() -> None:
    for i in range(N):
        solid = barrier[i] != 0
        rho[i] = 1.0
        ux[i] = 0.0 if solid else U_IN
        uy[i] = 0.0
        off = i * 9
        for k in range(9):
            f0[off + k] = feq(1.0, 0.0 if solid else U_IN, 0.0, k)
            f1[off + k] = f0[off + k]


def step() -> None:
    tau0 = 3.0 * VISC + 0.5
    f1[:] = f0[:]
    for y in range(H):
        for x in range(W):
            i = idx(x, y)
            if barrier[i]:
                continue
            off = i * 9
            r = sum(f0[off + k] for k in range(9))
            if not math.isfinite(r) or r < 1e-6 or x == 0:
                r = 1.0
                u = U_IN
                v = 0.0
            else:
                u = sum(f0[off + k] * EX[k] for k in range(9)) / r
                v = sum(f0[off + k] * EY[k] for k in range(9)) / r
            if not math.isfinite(u) or not math.isfinite(v):
                r = 1.0
                u = U_IN
                v = 0.0
            rho[i] = r
            ux[i] = u
            uy[i] = v

            qxx = qxy = qyy = 0.0
            for k in range(9):
                noneq = f0[off + k] - feq(r, u, v, k)
                qxx += EX[k] * EX[k] * noneq
                qxy += EX[k] * EY[k] * noneq
                qyy += EY[k] * EY[k] * noneq
            pi = math.sqrt(qxx * qxx + 2.0 * qxy * qxy + qyy * qyy)
            ta = 0.5 * (math.sqrt(tau0 * tau0 + 18.0 * SMAG * SMAG * pi / max(1e-6, r)) - tau0)
            omega = 1.0 / (tau0 + ta)
            for k in range(9):
                f0[off + k] += omega * (feq(r, u, v, k) - f0[off + k])

    for y in range(H):
        for x in range(W):
            i = idx(x, y)
            if barrier[i]:
                continue
            for k in range(9):
                nx = x + EX[k]
                ny = y + EY[k]
                if nx < 0 or nx >= W or ny < 0 or ny >= H:
                    continue
                ni = idx(nx, ny)
                if barrier[ni]:
                    f1[i * 9 + OPP[k]] = f0[i * 9 + k]
                else:
                    f1[ni * 9 + k] = f0[i * 9 + k]

    for y in range(1, H - 1):
        edge = idx(W - 1, y)
        prev = idx(W - 2, y)
        for k in range(9):
            f1[edge * 9 + k] = f1[prev * 9 + k]
    f0[:], f1[:] = f1[:], f0[:]


def bilinear(arr: list[float], x: float, y: float) -> float:
    fx = clamp(x, 0.0, W - 1.001)
    fy = clamp(y, 1.0, H - 2.001)
    x0 = int(math.floor(fx))
    y0 = int(math.floor(fy))
    x1 = min(W - 1, x0 + 1)
    y1 = min(H - 1, y0 + 1)
    tx = fx - x0
    ty = fy - y0
    v00 = arr[idx(x0, y0)]
    v10 = arr[idx(x1, y0)]
    v01 = arr[idx(x0, y1)]
    v11 = arr[idx(x1, y1)]
    a = v00 * (1 - tx) + v10 * tx
    b = v01 * (1 - tx) + v11 * tx
    v = a * (1 - ty) + b * ty
    return v if math.isfinite(v) else 0.0


def solid_at(x: float, y: float) -> bool:
    gx = int(clamp(round(x), 0, W - 1))
    gy = int(clamp(round(y), 0, H - 1))
    return barrier[idx(gx, gy)] != 0


def make_line(seed_y: float, z01: float, frame_index: int) -> dict[str, list[float]]:
    xs: list[float] = []
    ys: list[float] = []
    sp: list[float] = []
    px = 1.6
    py = seed_y
    span = max(0.0, 1.0 - abs(z01 * 2.0 - 1.0) ** 1.7)
    center_weight = 0.35 + 0.65 * span
    sidewash = (z01 - 0.5) * 0.026
    for _ in range(M_STEPS):
        u = bilinear(ux, px, py)
        v_base = bilinear(uy, px, py)
        wake = math.exp(-((px - W * 0.38) / (W * 0.24)) ** 2) * math.exp(-((py - H * 0.50) / (H * 0.20)) ** 2)
        shed = math.sin(frame_index * 0.74 + px * 0.20 + z01 * 5.2) * wake * 0.030 * center_weight
        v = v_base * center_weight + shed + sidewash
        if not math.isfinite(u):
            u = U_IN
        if not math.isfinite(v):
            v = 0.0
        speed = max(0.001, math.sqrt(u * u + v * v))
        xs.append(round3(map_x(px)))
        ys.append(round3(map_y(py)))
        sp.append(round3(clamp(speed / U_IN, 0.0, 1.45)))
        inv = 1.0 / max(0.012, speed)
        px += u * inv * 2.15
        py += v * inv * 2.15
        if solid_at(px, py):
            py += -1.8 if py < H * 0.5 else 1.8
            px += 1.1
        py = clamp(py, 1.8, H - 2.8)
    return {"x": xs, "y": ys, "sp": sp}


def mask_rows(cells: list[list[int]]) -> list[str]:
    return ["".join("1" if v else "0" for v in row) for row in cells]


def outline_segments(cells: list[list[int]]) -> list[list[float]]:
    segs: list[list[float]] = []

    def solid(x: int, y: int) -> bool:
        return 0 <= x < W and 0 <= y < H and cells[y][x] != 0

    def add(gx0: float, gy0: float, gx1: float, gy1: float) -> None:
        segs.append([round3(map_x(gx0)), round3(map_y(gy0)), round3(map_x(gx1)), round3(map_y(gy1))])

    for y in range(H):
        for x in range(W):
            if not solid(x, y):
                continue
            if y == 0 or y == H - 1:
                continue
            left, right = x - 0.5, x + 0.5
            top, bottom = y - 0.5, y + 0.5
            if not solid(x - 1, y):
                add(left, top, left, bottom)
            if not solid(x + 1, y):
                add(right, bottom, right, top)
            if not solid(x, y - 1):
                add(right, top, left, top)
            if not solid(x, y + 1):
                add(left, bottom, right, bottom)
    return segs


def make_slice_obstacles() -> list[dict[str, object]]:
    slices: list[dict[str, object]] = []
    for k in range(NZ):
        z01 = 0.0 if NZ <= 1 else k / (NZ - 1)
        z = Z0 + z01 * (Z1 - Z0)
        span_factor = max(0.0, math.sqrt(max(0.0, 1.0 - ((z01 - 0.5) / 0.5) ** 2)))
        if span_factor < 0.08:
            cells = [[0 for _ in range(W)] for _ in range(H)]
            for x in range(W):
                cells[0][x] = 1
                cells[H - 1][x] = 1
        else:
            cells = cells_from_polygon(airfoil_polygon(span_factor))
        slices.append(
            {
                "z": round3(z),
                "spanFactor": round3(span_factor),
                "clipMode": "elliptic_span_airfoil",
                "maskRows": mask_rows(cells),
                "outlineSegments": outline_segments(cells),
            }
        )
    return slices


def write_meta_if_missing() -> None:
    if os.path.exists(META_OUT):
        return
    imported = str(uuid.uuid4())
    asset_data = str(uuid.uuid4())
    component = str(uuid.uuid4())
    body = f"""- !<AssetImportMetadata/c4170b61-247d-492c-b803-f01cfd94d431>
  ImportedAssetIds:
    TypeScriptAsset: !<reference> {imported}
  ImporterName: TypeScriptAssetImporter
  PrimaryAsset: !<reference> {imported}
  PackageType: NotAPackage
  LegacyPackagePolicy: ~
  ExtraData:
    {{}}
  AssetDataMap:
    TypeScriptAsset: !<own> {asset_data}
  DependentFiles:
    []
  ImporterSettings: !<AssetImporterSettings>
    {{}}
  CompressionSettings: !<own> 00000000-0000-0000-0000-000000000000
- !<TypeScriptAssetData/{asset_data}>
  SvgIcon: ""
  SetupScript:
    code: ""
  Description: ""
  VersionMajor: 0
  VersionMinor: 0
  VersionPatch: 0
  ComponentUid: {component}
  ExportUid: 00000000-0000-0000-0000-000000000000
  PackagePolicy: CanBeUnpacked
  ScriptInputsHidden:
    {{}}
  ScriptTypesHidden:
    {{}}
  ReadMe: !<reference> 00000000-0000-0000-0000-000000000000
  DeclarationFile: !<reference> 00000000-0000-0000-0000-000000000000
  Tags:
    []
  Attachments:
    []
  DefaultScriptInputs:
    -
      {{}}
  ScriptTypes:
    -
      {{}}
  InputLines:
    []
"""
    with open(META_OUT, "w", encoding="utf-8") as f:
        f.write(body)


def write_preview(obstacle: dict[str, object]) -> None:
    slices = obstacle["slices"]
    html = f"""<!doctype html>
<meta charset="utf-8">
<title>Airfoil CFD Mask Preview</title>
<style>
body {{ margin:0; background:#10131a; color:#eef6ff; font:14px system-ui,sans-serif; }}
header {{ padding:14px 18px; background:#151b24; border-bottom:1px solid #263141; }}
main {{ display:grid; gap:14px; place-items:center; padding:18px; }}
canvas {{ width:min(92vw,1280px); image-rendering:pixelated; border:1px solid #334155; background:#07111d; }}
.controls {{ display:flex; gap:12px; width:min(92vw,1280px); align-items:center; }}
input {{ flex:1; accent-color:#22d3ee; }}
</style>
<header><b>Airfoil CFD obstacle slices</b><br>Center slices show the largest section; tip slices shrink by an elliptic span factor.</header>
<main><div class="controls"><input id="slice" type="range" min="0" max="{NZ - 1}" value="{NZ // 2}"><output id="label"></output></div><canvas id="view" width="960" height="420"></canvas></main>
<script>
const slices = {json.dumps(slices, separators=(",", ":"))};
const canvas = document.getElementById("view"), ctx = canvas.getContext("2d");
const input = document.getElementById("slice"), label = document.getElementById("label");
const margin = 36, w = canvas.width - margin * 2, h = canvas.height - margin * 2;
function draw(i) {{
  const s = slices[i], rows = s.maskRows;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = "#07111d"; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = "rgba(0,230,255,.72)";
  const cw = w / rows[0].length, ch = h / rows.length;
  for (let y=0;y<rows.length;y++) for (let x=0;x<rows[y].length;x++) if (rows[y][x] === "1") ctx.fillRect(margin+x*cw, margin+y*ch, Math.ceil(cw), Math.ceil(ch));
  label.value = "slice " + i + "  z=" + Number(s.z).toFixed(3) + "  span=" + Number(s.spanFactor).toFixed(3);
}}
input.addEventListener("input", () => draw(Number(input.value)));
draw(Number(input.value));
</script>
"""
    with open(PREVIEW_OUT, "w", encoding="utf-8") as f:
        f.write(html)


def main() -> None:
    center_cells = cells_from_polygon(airfoil_polygon(1.0))
    set_barrier_from_cells(center_cells)
    init_lattice()
    for i in range(WARMUP):
        step()
        if (i + 1) % 200 == 0:
            print(f"warmup {i + 1}/{WARMUP}")

    frames = []
    for t in range(NT):
        for _ in range(STEPS_PER_FRAME):
            step()
        frame_slices = []
        for z in range(NZ):
            z01 = 0.0 if NZ <= 1 else z / (NZ - 1)
            lines = []
            for line in range(N_LINES):
                y01 = (line + 0.5) / N_LINES
                seed_y = 2.0 + y01 * (H - 4.0)
                lines.append(make_line(seed_y, z01, t))
            frame_slices.append(lines)
        frames.append(frame_slices)
        print(f"baked frame {t + 1}/{NT}")

    obstacle = {
        "space": "data",
        "renderSource": "Joukowski airfoil, elliptic quasi-3D span slices",
        "raster": {"nx": W, "ny": H},
        "shapes": [],
        "solverMaskRows": mask_rows(center_cells),
        "solverOutlineSegments": outline_segments(center_cells),
        "slices": make_slice_obstacles(),
    }
    payload = {
        "source": "offline pure-Python D2Q9 LBM around Joukowski airfoil",
        "NX": W,
        "NY": H,
        "NZ": NZ,
        "NT": NT,
        "X0": X0,
        "X1": X1,
        "Y0": Y0,
        "Y1": Y1,
        "Z0": Z0,
        "Z1": Z1,
        "M": M_STEPS,
        "N": N_LINES,
        "fps": 8,
        "secondsPerFrame": 1 / 8,
        "inletSpeed": U_IN,
        "viscosity": VISC,
        "airfoil": {"aoaDeg": AOA_DEG, "thickness": THICKNESS, "camber": CAMBER},
        "obstacle": obstacle,
        "frames": frames,
    }
    body = json.dumps(payload, separators=(",", ":"))
    header = "\n".join(
        [
            "// Generated by tools/generate_airfoil_cfd_timeseries.py.",
            "// External unsteady CFD data for the aerodynamic slice renderer.",
            "// Do not hand-edit the numeric payload; rerun the generator instead.",
            "",
            f"export const AIRFOIL_CFD_TIME_SERIES: any = {body};",
            "",
        ]
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(header)
    write_meta_if_missing()
    write_preview(obstacle)
    print(f"wrote {OUT} ({len(header) / 1024 / 1024:.2f} MiB)")
    print(f"wrote {PREVIEW_OUT}")


if __name__ == "__main__":
    main()
