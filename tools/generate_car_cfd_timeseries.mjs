// Offline D2Q9 LBM bake for the aerodynamic example.
// Generates a compact TS asset of time-varying streamline paths sampled from a
// 2D car-like obstacle, then fans it into depth slices for the Lens slice UI.

import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("Assets/Scripts/CarCfdTimeSeries.ts");
const MODEL = path.resolve("Assets/Meshes/Models/racecar.glb");
const PREVIEW_OUT = path.resolve("Tools/car_cfd_mask_preview.html");

const W = 96;
const H = 40;
const NT = 24;
const NZ = 24;
const N_LINES = 17;
const M_STEPS = 42;
const WARMUP = 700;
const STEPS_PER_FRAME = 28;
const U_IN = 0.075;
const VISC = 0.018;
const SMAG = 0.10;

const W9 = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];

const N = W * H;
let f0 = new Float32Array(N * 9);
let f1 = new Float32Array(N * 9);
const rho = new Float32Array(N);
const ux = new Float32Array(N);
const uy = new Float32Array(N);
const barrier = new Uint8Array(N);
let obstacleShapes = [];

function idx(x, y) {
  return x + y * W;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function feq(r, u, v, k) {
  const cu = 3 * (EX[k] * u + EY[k] * v);
  return r * W9[k] * (1 + cu + 0.5 * cu * cu - 1.5 * (u * u + v * v));
}

function addEllipse(cx, cy, rx, ry) {
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const qx = (x - cx) / rx;
      const qy = (y - cy) / ry;
      if (qx * qx + qy * qy <= 1) barrier[idx(x, y)] = 1;
    }
  }
}

function addRoundedCarObstacle() {
  barrier.fill(0);
  obstacleShapes = [];
  for (let x = 0; x < W; x++) {
    barrier[idx(x, 0)] = 1;
    barrier[idx(x, H - 1)] = 1;
  }

  const baseY = Math.floor(H * 0.58);
  const bodyX0 = Math.floor(W * 0.25);
  const bodyX1 = Math.floor(W * 0.67);
  const bodyH = Math.floor(H * 0.15);
  obstacleShapes.push({
    type: "rect",
    x0: round(mapX(bodyX0 - 0.5)),
    x1: round(mapX(bodyX1 + 0.5)),
    y0: round(mapY(baseY + bodyH + 0.5)),
    y1: round(mapY(baseY - bodyH - 0.5)),
  });
  for (let y = baseY - bodyH; y <= baseY + bodyH; y++) {
    for (let x = bodyX0; x <= bodyX1; x++) barrier[idx(x, y)] = 1;
  }

  addCarEllipse(W * 0.35, H * 0.46, W * 0.13, H * 0.11);
  addCarEllipse(W * 0.54, H * 0.48, W * 0.15, H * 0.10);
  addCarEllipse(W * 0.25, baseY, W * 0.055, H * 0.09);
  addCarEllipse(W * 0.68, baseY, W * 0.06, H * 0.08);
}

function applyMaskObstacle(maskRows) {
  barrier.fill(0);
  obstacleShapes = [];
  for (let x = 0; x < W; x++) {
    barrier[idx(x, 0)] = 1;
    barrier[idx(x, H - 1)] = 1;
  }
  for (let y = 1; y < H - 1; y++) {
    const row = maskRows[y] || "";
    for (let x = 0; x < W; x++) {
      if (row.charAt(x) === "1") barrier[idx(x, y)] = 1;
    }
  }
}

function addCarEllipse(cx, cy, rx, ry) {
  obstacleShapes.push({
    type: "ellipse",
    cx: round(mapX(cx)),
    cy: round(mapY(cy)),
    rx: round((rx / (W - 1)) * 10.7),
    ry: round((ry / (H - 1)) * 3.94),
  });
  addEllipse(cx, cy, rx, ry);
}

function initLattice() {
  for (let i = 0; i < N; i++) {
    const solid = barrier[i] !== 0;
    rho[i] = 1;
    ux[i] = solid ? 0 : U_IN;
    uy[i] = 0;
    const off = i * 9;
    for (let k = 0; k < 9; k++) {
      const v = feq(1, solid ? 0 : U_IN, 0, k);
      f0[off + k] = v;
      f1[off + k] = v;
    }
  }
}

function step() {
  const tau0 = 3 * VISC + 0.5;
  f1.set(f0);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      if (barrier[i]) continue;
      const off = i * 9;
      let r = 0;
      let u = 0;
      let v = 0;
      for (let k = 0; k < 9; k++) r += f0[off + k];
      if (!Number.isFinite(r) || r < 1e-6) {
        r = 1;
        u = U_IN;
        v = 0;
        for (let k = 0; k < 9; k++) f0[off + k] = feq(r, u, v, k);
      } else if (x === 0) {
        u = U_IN;
        v = 0;
        r = 1;
      } else {
        for (let k = 0; k < 9; k++) {
          u += f0[off + k] * EX[k];
          v += f0[off + k] * EY[k];
        }
        u /= Math.max(1e-6, r);
        v /= Math.max(1e-6, r);
      }
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        u = U_IN;
        v = 0;
        r = 1;
        for (let k = 0; k < 9; k++) f0[off + k] = feq(r, u, v, k);
      }
      rho[i] = r;
      ux[i] = u;
      uy[i] = v;

      let qxx = 0;
      let qxy = 0;
      let qyy = 0;
      for (let k = 0; k < 9; k++) {
        const noneq = f0[off + k] - feq(r, u, v, k);
        qxx += EX[k] * EX[k] * noneq;
        qxy += EX[k] * EY[k] * noneq;
        qyy += EY[k] * EY[k] * noneq;
      }
      const pi = Math.sqrt(qxx * qxx + 2 * qxy * qxy + qyy * qyy);
      const ta = 0.5 * (Math.sqrt(tau0 * tau0 + 18 * SMAG * SMAG * pi / Math.max(1e-6, r)) - tau0);
      const omega = 1 / (tau0 + ta);
      for (let k = 0; k < 9; k++) f0[off + k] += omega * (feq(r, u, v, k) - f0[off + k]);
    }
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      if (barrier[i]) continue;
      for (let k = 0; k < 9; k++) {
        const nx = x + EX[k];
        const ny = y + EY[k];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = idx(nx, ny);
        if (barrier[ni]) f1[i * 9 + OPP[k]] = f0[i * 9 + k];
        else f1[ni * 9 + k] = f0[i * 9 + k];
      }
    }
  }

  for (let y = 1; y < H - 1; y++) {
    const edge = idx(W - 1, y);
    const prev = idx(W - 2, y);
    for (let k = 0; k < 9; k++) f1[edge * 9 + k] = f1[prev * 9 + k];
  }

  const t = f0;
  f0 = f1;
  f1 = t;
}

function bilinear(arr, x, y) {
  const fx = clamp(x, 0, W - 1.001);
  const fy = clamp(y, 1, H - 2.001);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = finiteOr(arr[idx(x0, y0)], 0);
  const v10 = finiteOr(arr[idx(x1, y0)], 0);
  const v01 = finiteOr(arr[idx(x0, y1)], 0);
  const v11 = finiteOr(arr[idx(x1, y1)], 0);
  const a = v00 * (1 - tx) + v10 * tx;
  const b = v01 * (1 - tx) + v11 * tx;
  return finiteOr(a * (1 - ty) + b * ty, 0);
}

function finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function solidAt(x, y) {
  return barrier[idx(clamp(Math.round(x), 0, W - 1), clamp(Math.round(y), 0, H - 1))] !== 0;
}

function makeLine(seedY, z01, frameIndex) {
  const x = [];
  const y = [];
  const sp = [];
  let px = 1.5;
  let py = seedY;
  const centerWeight = 0.50 + 0.50 * Math.cos((z01 - 0.5) * Math.PI);
  const sideBias = (z01 - 0.5) * 0.018;

  for (let i = 0; i < M_STEPS; i++) {
    let u = bilinear(ux, px, py);
    const vBase = bilinear(uy, px, py);
    const wake = Math.exp(-Math.pow((px - W * 0.68) / (W * 0.22), 2)) * Math.exp(-Math.pow((py - H * 0.55) / (H * 0.22), 2));
    const shed = Math.sin(frameIndex * 0.62 + px * 0.18 + z01 * 5.8) * wake * 0.026 * centerWeight;
    let v = vBase * (0.54 + 0.46 * centerWeight) + shed + sideBias;
    if (!Number.isFinite(u)) u = U_IN;
    if (!Number.isFinite(v)) v = 0;
    const speed = Math.max(0.001, Math.sqrt(u * u + v * v));

    x.push(round(mapX(px)));
    y.push(round(mapY(py)));
    sp.push(round(clamp(speed / U_IN, 0, 1.35)));

    const inv = 1 / Math.max(0.012, speed);
    px += u * inv * 2.08;
    py += v * inv * 2.08;
    if (solidAt(px, py)) {
      py += py < H * 0.5 ? -1.6 : 1.6;
      px += 1.0;
    }
    py = clamp(py, 1.6, H - 2.6);
  }
  return { x, y, sp };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

function mapX(px) {
  return -5.35 + (px / (W - 1)) * 10.7;
}

function mapY(py) {
  return 1.97 - (py / (H - 1)) * 3.94;
}

function makeObstacleOutlineSegments() {
  const segments = [];
  const solid = (x, y) => x >= 0 && x < W && y >= 1 && y < H - 1 && barrier[idx(x, y)] !== 0;
  const add = (x0, y0, x1, y1) => {
    segments.push([round(mapX(x0)), round(mapY(y0)), round(mapX(x1)), round(mapY(y1))]);
  };

  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      if (!solid(x, y)) continue;
      const left = x - 0.5;
      const right = x + 0.5;
      const top = y - 0.5;
      const bottom = y + 0.5;
      if (!solid(x - 1, y)) add(left, top, left, bottom);
      if (!solid(x + 1, y)) add(right, bottom, right, top);
      if (!solid(x, y - 1)) add(right, top, left, top);
      if (!solid(x, y + 1)) add(left, bottom, right, bottom);
    }
  }
  return segments;
}

function readGlb(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.toString("ascii", 0, 4) !== "glTF") throw new Error(`Not a GLB file: ${filePath}`);
  const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.slice(20, 20 + jsonLength).toString("utf8"));
  const binOffset = 20 + jsonLength + 8;
  return { json, bin: data.slice(binOffset) };
}

function componentSize(componentType) {
  if (componentType === 5126 || componentType === 5125) return 4;
  if (componentType === 5123) return 2;
  if (componentType === 5121) return 1;
  throw new Error(`Unsupported GLB component type ${componentType}`);
}

function componentCount(type) {
  if (type === "SCALAR") return 1;
  if (type === "VEC2") return 2;
  if (type === "VEC3") return 3;
  if (type === "VEC4") return 4;
  throw new Error(`Unsupported GLB accessor type ${type}`);
}

function readAccessor(gltf, accessorIndex) {
  const { json, bin } = gltf;
  const accessor = json.accessors[accessorIndex];
  const view = json.bufferViews[accessor.bufferView];
  const count = componentCount(accessor.type);
  const size = componentSize(accessor.componentType);
  const stride = view.byteStride || count * size;
  const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const out = [];
  for (let i = 0; i < accessor.count; i++) {
    const tuple = [];
    for (let c = 0; c < count; c++) {
      const p = offset + i * stride + c * size;
      if (accessor.componentType === 5126) tuple.push(bin.readFloatLE(p));
      else if (accessor.componentType === 5125) tuple.push(bin.readUInt32LE(p));
      else if (accessor.componentType === 5123) tuple.push(bin.readUInt16LE(p));
      else if (accessor.componentType === 5121) tuple.push(bin.readUInt8(p));
    }
    out.push(count === 1 ? tuple[0] : tuple);
  }
  return out;
}

function matIdentity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function matMul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    }
  }
  return out;
}

function matFromNode(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0];
  const s = node.scale || [1, 1, 1];
  const q = node.rotation || [0, 0, 0, 1];
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  const m = [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    t[0], t[1], t[2], 1,
  ];
  m[0] *= s[0]; m[1] *= s[0]; m[2] *= s[0];
  m[4] *= s[1]; m[5] *= s[1]; m[6] *= s[1];
  m[8] *= s[2]; m[9] *= s[2]; m[10] *= s[2];
  return m;
}

function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function collectModelTriangles(filePath) {
  const gltf = readGlb(filePath);
  const { json } = gltf;
  const parents = new Map();
  (json.nodes || []).forEach((node, index) => (node.children || []).forEach((child) => parents.set(child, index)));
  const worldCache = new Map();
  const worldMat = (index) => {
    if (worldCache.has(index)) return worldCache.get(index);
    const chain = [];
    for (let current = index; current !== undefined; current = parents.get(current)) chain.push(current);
    let m = matIdentity();
    for (let i = chain.length - 1; i >= 0; i--) m = matMul(m, matFromNode(json.nodes[chain[i]]));
    worldCache.set(index, m);
    return m;
  };

  const triangles = [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const pushBounds = (p) => {
    for (let i = 0; i < 3; i++) {
      bounds.min[i] = Math.min(bounds.min[i], p[i]);
      bounds.max[i] = Math.max(bounds.max[i], p[i]);
    }
  };

  (json.nodes || []).forEach((node, nodeIndex) => {
    if (node.mesh === undefined) return;
    const matrix = worldMat(nodeIndex);
    const mesh = json.meshes[node.mesh];
    for (const primitive of mesh.primitives || []) {
      const positions = readAccessor(gltf, primitive.attributes.POSITION).map((p) => transformPoint(matrix, p));
      for (const p of positions) pushBounds(p);
      const indices = primitive.indices !== undefined ? readAccessor(gltf, primitive.indices) : null;
      if (indices) {
        for (let i = 0; i + 2 < indices.length; i += 3) triangles.push([positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]]]);
      } else {
        for (let i = 0; i + 2 < positions.length; i += 3) triangles.push([positions[i], positions[i + 1], positions[i + 2]]);
      }
    }
  });

  return { triangles, bounds };
}

function makeModelObstacleSlices() {
  const X0 = -5.35, X1 = 5.35, Y0 = -1.97, Y1 = 1.97, Z0 = -1.82, Z1 = 1.82;
  const { triangles, bounds } = collectModelTriangles(MODEL);
  const center = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
  const toData = (p) => ({
    // Lens rotates the imported car root so the GLB length axis becomes slice-local X.
    x: p[2] - center[2],
    y: p[1] - center[1],
    z: p[0] - center[0],
  });
  const dataTriangles = triangles.map((tri) => tri.map(toData));
  const slices = [];
  for (let k = 0; k < NZ; k++) {
    const z = Z0 + (k / Math.max(1, NZ - 1)) * (Z1 - Z0);
    const segments = [];
    for (const tri of dataTriangles) {
      const points = [];
      for (let e = 0; e < 3; e++) {
        const a = tri[e];
        const b = tri[(e + 1) % 3];
        const da = a.z - z;
        const db = b.z - z;
        if (Math.abs(da) < 1e-5 && Math.abs(db) < 1e-5) continue;
        if ((da <= 0 && db >= 0) || (da >= 0 && db <= 0)) {
          const t = Math.abs(da - db) < 1e-6 ? 0 : da / (da - db);
          if (t >= -1e-5 && t <= 1.00001) {
            points.push({
              x: a.x + (b.x - a.x) * t,
              y: a.y + (b.y - a.y) * t,
            });
          }
        }
      }
      if (points.length >= 2) {
        const a = points[0], b = points[1];
        if (Math.hypot(a.x - b.x, a.y - b.y) > 0.004) segments.push([a.x, a.y, b.x, b.y]);
      }
    }
    const mask = rasterizeCrossSection(segments, X0, X1, Y0, Y1, W, H);
    slices.push({
      z: round(z),
      maskRows: mask.rows,
      outlineSegments: outlineSegmentsFromMask(mask.cells, X0, X1, Y0, Y1, W, H),
    });
  }
  return {
    source: "racecar.glb mesh slice raster",
    bounds: {
      min: bounds.min.map(round),
      max: bounds.max.map(round),
      center: center.map(round),
    },
    slices,
  };
}

function makeModelSideObstacle() {
  const X0 = -5.35, X1 = 5.35, Y0 = -1.97, Y1 = 1.97, Z0 = -1.82, Z1 = 1.82;
  const { triangles, bounds } = collectModelTriangles(MODEL);
  const center = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
  const toData = (p) => ({
    // Side-view projection: GLB length -> field X, GLB height -> field Y.
    x: p[2] - center[2],
    y: p[1] - center[1],
    z: p[0] - center[0],
  });
  const projected = triangles.map((tri) => tri.map(toData));
  let cells = cleanSilhouetteMask(rasterizeProjectedPolygons(projected, X0, X1, Y0, Y1, W, H));
  const rows = maskRowsFromCells(cells);
  const outlineSegments = outlineSegmentsFromMask(cells, X0, X1, Y0, Y1, W, H);
  const slices = makeCoherentSymmetricSlices(cells, X0, X1, Y0, Y1, Z0, Z1);
  return {
    source: "racecar.glb coherent clipped side-view silhouette projection",
    bounds: {
      min: bounds.min.map(round),
      max: bounds.max.map(round),
      center: center.map(round),
    },
    maskRows: rows,
    outlineSegments,
    slices,
  };
}

function makeCoherentSymmetricSlices(fullCells, x0, x1, y0, y1, z0, z1) {
  const slices = [];
  for (let k = 0; k < NZ; k++) {
    const z = z0 + (k / Math.max(1, NZ - 1)) * (z1 - z0);
    const z01 = k / Math.max(1, NZ - 1);
    const factor = 1.0 - Math.abs(z01 * 2.0 - 1.0);
    const symmetricLimit = Math.max(0.0, Math.min(Math.abs(z0), Math.abs(z1)) * factor);
    const sliceCells = coherentCenterOutMask(fullCells, smoothstep01(factor));
    slices.push({
      z: round(z),
      symmetricDepthLimit: round(symmetricLimit),
      clipMode: "coherent_symmetric_side_projection",
      maskRows: maskRowsFromCells(sliceCells),
      outlineSegments: outlineSegmentsFromMask(sliceCells, x0, x1, y0, y1, W, H),
    });
  }
  return slices;
}

function coherentCenterOutMask(fullCells, factor) {
  const f = clamp(factor, 0, 1);
  if (f <= 0.001) return Array.from({ length: H }, () => Array(W).fill(0));
  if (f >= 0.999) return cloneMask(fullCells);
  const out = Array.from({ length: H }, () => Array(W).fill(0));
  for (let y = 1; y < H - 1; y++) {
    let x = 0;
    while (x < W) {
      while (x < W && !fullCells[y][x]) x++;
      if (x >= W) break;
      const start = x;
      while (x < W && fullCells[y][x]) x++;
      const end = x - 1;
      const center = (start + end) * 0.5;
      const half = Math.max(0.0, (end - start + 1) * 0.5 * f);
      const a = Math.max(start, Math.floor(center - half));
      const b = Math.min(end, Math.ceil(center + half));
      for (let i = a; i <= b; i++) out[y][i] = 1;
    }
  }
  return smoothMask(fillMaskHoles(closeMask(out, 1)), 1);
}

function smoothstep01(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function cleanSilhouetteMask(cells) {
  let out = closeMask(cells, 1);
  out = fillMaskHoles(out);
  out = smoothMask(out, 2);
  return out;
}

function clipPolygonZMax(polygon, zMax) {
  const out = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const aInside = a.z <= zMax;
    const bInside = b.z <= zMax;
    if (aInside && bInside) {
      out.push(b);
    } else if (aInside && !bInside) {
      out.push(intersectZ(a, b, zMax));
    } else if (!aInside && bInside) {
      out.push(intersectZ(a, b, zMax));
      out.push(b);
    }
  }
  return dedupePolygon(out);
}

function clipPolygonZMin(polygon, zMin) {
  const out = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const aInside = a.z >= zMin;
    const bInside = b.z >= zMin;
    if (aInside && bInside) {
      out.push(b);
    } else if (aInside && !bInside) {
      out.push(intersectZ(a, b, zMin));
    } else if (!aInside && bInside) {
      out.push(intersectZ(a, b, zMin));
      out.push(b);
    }
  }
  return dedupePolygon(out);
}

function clipPolygonAbsZMax(polygon, zLimit) {
  if (zLimit <= 0.0001) return [];
  return clipPolygonZMax(clipPolygonZMin(polygon, -zLimit), zLimit);
}

function intersectZ(a, b, z) {
  const denom = b.z - a.z;
  const t = Math.abs(denom) < 1e-6 ? 0.0 : (z - a.z) / denom;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z,
  };
}

function dedupePolygon(points) {
  const out = [];
  for (const p of points) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.0001 || Math.abs(p.z - last.z) > 0.0001) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 0.0001 && Math.abs(a.z - b.z) <= 0.0001) out.pop();
  }
  return out;
}

function rasterizeProjectedPolygons(polygons, x0, x1, y0, y1, width, height) {
  const triangles = [];
  for (const polygon of polygons) {
    if (!polygon || polygon.length < 3) continue;
    for (let i = 1; i + 1 < polygon.length; i++) triangles.push([polygon[0], polygon[i], polygon[i + 1]]);
  }
  return rasterizeProjectedTriangles(triangles, x0, x1, y0, y1, width, height);
}

function rasterizeProjectedTriangles(triangles, x0, x1, y0, y1, width, height) {
  const cells = Array.from({ length: height }, () => Array(width).fill(0));
  const toGridX = (x) => ((x - x0) / (x1 - x0)) * width - 0.5;
  const toGridY = (y) => ((y1 - y) / (y1 - y0)) * height - 0.5;
  for (const tri of triangles) {
    const p = tri.map((v) => ({ x: toGridX(v.x), y: toGridY(v.y) }));
    const minX = Math.max(0, Math.floor(Math.min(p[0].x, p[1].x, p[2].x) - 1));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(p[0].x, p[1].x, p[2].x) + 1));
    const minY = Math.max(1, Math.floor(Math.min(p[0].y, p[1].y, p[2].y) - 1));
    const maxY = Math.min(height - 2, Math.ceil(Math.max(p[0].y, p[1].y, p[2].y) + 1));
    if (maxX < minX || maxY < minY) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (pointInTriangle(x, y, p[0], p[1], p[2])) cells[y][x] = 1;
      }
    }
  }
  return cells;
}

function pointInTriangle(x, y, a, b, c) {
  const v0x = c.x - a.x, v0y = c.y - a.y;
  const v1x = b.x - a.x, v1y = b.y - a.y;
  const v2x = x - a.x, v2y = y - a.y;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const inv = 1 / Math.max(1e-8, dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= -0.01 && v >= -0.01 && u + v <= 1.01;
}

function closeMask(cells, radius) {
  return erodeMask(dilateMask(cells, radius), radius);
}

function smoothMask(cells, passes) {
  let out = cells;
  for (let pass = 0; pass < passes; pass++) {
    const next = cloneMask(out);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        let n = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) n += out[y + oy][x + ox] ? 1 : 0;
        next[y][x] = n >= 5 ? 1 : 0;
      }
    }
    out = next;
  }
  return out;
}

function dilateMask(cells, radius) {
  const out = cloneMask(cells);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      if (!cells[y][x]) continue;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const nx = x + ox, ny = y + oy;
          if (nx >= 0 && nx < W && ny > 0 && ny < H - 1) out[ny][nx] = 1;
        }
      }
    }
  }
  return out;
}

function erodeMask(cells, radius) {
  const out = cloneMask(cells);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      let keep = 1;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || nx >= W || ny <= 0 || ny >= H - 1 || !cells[ny][nx]) keep = 0;
        }
      }
      out[y][x] = keep;
    }
  }
  return out;
}

function fillMaskHoles(cells) {
  const seen = Array.from({ length: H }, () => Array(W).fill(0));
  const queue = [];
  const push = (x, y) => {
    if (x < 0 || x >= W || y < 1 || y >= H - 1 || seen[y][x] || cells[y][x]) return;
    seen[y][x] = 1;
    queue.push([x, y]);
  };
  for (let x = 0; x < W; x++) {
    push(x, 1);
    push(x, H - 2);
  }
  for (let y = 1; y < H - 1; y++) {
    push(0, y);
    push(W - 1, y);
  }
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  const out = cloneMask(cells);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      if (!seen[y][x]) out[y][x] = 1;
    }
  }
  return out;
}

function cloneMask(cells) {
  return cells.map((row) => row.slice());
}

function maskRowsFromCells(cells) {
  return cells.map((row) => row.map((v) => v ? "1" : "0").join(""));
}

function rasterizeCrossSection(segments, x0, x1, y0, y1, width, height) {
  const rows = [];
  const cells = [];
  for (let gy = 0; gy < height; gy++) {
    const row = [];
    const y = y1 - ((gy + 0.5) / height) * (y1 - y0);
    for (let gx = 0; gx < width; gx++) {
      const x = x0 + ((gx + 0.5) / width) * (x1 - x0);
      let inside = false;
      for (const s of segments) {
        const ax = s[0], ay = s[1], bx = s[2], by = s[3];
        if ((ay > y) !== (by > y)) {
          const ix = ax + ((y - ay) / Math.max(1e-6, by - ay)) * (bx - ax);
          if (ix > x) inside = !inside;
        }
      }
      row.push(inside ? 1 : 0);
    }
    cells.push(row);
    rows.push(row.map((v) => v ? "1" : "0").join(""));
  }
  return { rows, cells };
}

function outlineSegmentsFromMask(cells, x0, x1, y0, y1, width, height) {
  const segments = [];
  const solid = (x, y) => x >= 0 && x < width && y >= 0 && y < height && cells[y][x] !== 0;
  const mx = (gx) => x0 + (gx / width) * (x1 - x0);
  const my = (gy) => y1 - (gy / height) * (y1 - y0);
  const add = (a, b, c, d) => segments.push([round(a), round(b), round(c), round(d)]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!solid(x, y)) continue;
      if (!solid(x - 1, y)) add(mx(x), my(y), mx(x), my(y + 1));
      if (!solid(x + 1, y)) add(mx(x + 1), my(y + 1), mx(x + 1), my(y));
      if (!solid(x, y - 1)) add(mx(x + 1), my(y), mx(x), my(y));
      if (!solid(x, y + 1)) add(mx(x), my(y + 1), mx(x + 1), my(y + 1));
    }
  }
  return segments;
}

const modelObstacle = makeModelSideObstacle();
applyMaskObstacle(modelObstacle.maskRows);
initLattice();
for (let i = 0; i < WARMUP; i++) step();

const frames = [];
for (let t = 0; t < NT; t++) {
  for (let i = 0; i < STEPS_PER_FRAME; i++) step();
  const slices = [];
  for (let z = 0; z < NZ; z++) {
    const z01 = NZ <= 1 ? 0 : z / (NZ - 1);
    const slice = [];
    for (let line = 0; line < N_LINES; line++) {
      const y01 = (line + 0.5) / N_LINES;
      const seedY = 1.5 + y01 * (H - 3.0);
      slice.push(makeLine(seedY, z01, t));
    }
    slices.push(slice);
  }
  frames.push(slices);
  console.log(`baked frame ${t + 1}/${NT}`);
}

const payload = {
  source: "offline D2Q9 LBM around racecar.glb side-view silhouette",
  NX: W,
  NY: H,
  NZ,
  NT,
  X0: -5.35,
  X1: 5.35,
  Y0: -1.97,
  Y1: 1.97,
  Z0: -1.82,
  Z1: 1.82,
  M: M_STEPS,
  N: N_LINES,
  fps: 8,
  secondsPerFrame: 1 / 8,
  inletSpeed: U_IN,
  viscosity: VISC,
  obstacle: {
    space: "data",
    renderSource: modelObstacle.source,
    raster: { nx: W, ny: H },
    shapes: obstacleShapes,
    solverOutlineSegments: makeObstacleOutlineSegments(),
    modelBounds: modelObstacle.bounds,
    sideMaskRows: modelObstacle.maskRows,
    sideOutlineSegments: modelObstacle.outlineSegments,
    slices: modelObstacle.slices,
  },
  frames,
};

const body = JSON.stringify(payload);
const header = [
  "// Generated by Tools/generate_car_cfd_timeseries.mjs.",
  "// External unsteady CFD data for the aerodynamic slice renderer.",
  "// Do not hand-edit the numeric payload; rerun the generator instead.",
  "",
  `export const CAR_CFD_TIME_SERIES: any = ${body};`,
  "",
].join("\n");

fs.writeFileSync(OUT, header);
console.log(`wrote ${OUT} (${(header.length / 1024 / 1024).toFixed(2)} MiB)`);
writeMaskPreview(payload.obstacle);
console.log(`wrote ${PREVIEW_OUT}`);

function writeMaskPreview(obstacle) {
  const rows = obstacle.sideMaskRows || [];
  const outline = obstacle.sideOutlineSegments || [];
  const slices = obstacle.slices || [];
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Car CFD Mask Preview</title>
<style>
  html, body { margin: 0; height: 100%; background: #10131a; color: #eef6ff; font: 14px system-ui, sans-serif; }
  body { display: grid; grid-template-rows: auto 1fr; }
  header { padding: 14px 18px; border-bottom: 1px solid #263141; background: #151b24; }
  h1 { margin: 0 0 4px; font-size: 16px; font-weight: 700; }
  p { margin: 0; color: #a9b8c8; }
  main { display: grid; gap: 14px; place-items: center; padding: 18px; }
  .controls { display: flex; align-items: center; gap: 12px; width: min(92vw, 1280px); }
  input { flex: 1; accent-color: #22d3ee; }
  button { border: 1px solid #334155; background: #1f2937; color: #eef6ff; border-radius: 6px; padding: 7px 12px; font-weight: 700; }
  output { min-width: 190px; color: #d9f7ff; font-variant-numeric: tabular-nums; }
  canvas { width: min(92vw, 1280px); image-rendering: pixelated; border: 1px solid #334155; background: #07111d; }
</style>
<header>
  <h1>Car CFD clipped obstacle mask</h1>
  <p>Generated from racecar.glb side-view projection clipped by the vertical slice plane. Cyan is the alpha/solver mask for the selected slice; amber is the Lens outline.</p>
</header>
<main>
  <div class="controls">
    <button id="play">Pause</button>
    <input id="slice" type="range" min="0" max="${Math.max(0, slices.length - 1)}" value="0" step="1">
    <output id="label"></output>
  </div>
  <canvas id="view" width="960" height="400"></canvas>
</main>
<script>
const rows = ${JSON.stringify(rows)};
const outline = ${JSON.stringify(outline)};
const slices = ${JSON.stringify(slices)};
const domain = { x0: -5.35, x1: 5.35, y0: -1.97, y1: 1.97 };
const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const input = document.getElementById("slice");
const label = document.getElementById("label");
const play = document.getElementById("play");
let playing = true;
let sliceIndex = 0;
const margin = 36;
const w = canvas.width - margin * 2;
const h = canvas.height - margin * 2;
const cellW = w / rows[0].length;
const cellH = h / rows.length;
const sx = x => margin + ((x - domain.x0) / (domain.x1 - domain.x0)) * w;
const sy = y => margin + ((domain.y1 - y) / (domain.y1 - domain.y0)) * h;
function draw(index) {
  const slice = slices[index] || { maskRows: rows, outlineSegments: outline, z: 0 };
  const mask = slice.maskRows || rows;
  const lines = slice.outlineSegments || outline;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#07111d";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0, 230, 255, 0.74)";
  for (let y = 0; y < mask.length; y++) {
    for (let x = 0; x < mask[y].length; x++) {
      if (mask[y][x] === "1") ctx.fillRect(margin + x * cellW, margin + y * cellH, Math.ceil(cellW), Math.ceil(cellH));
    }
  }
  ctx.strokeStyle = "rgba(255, 176, 0, 0.95)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const s of lines) {
    ctx.moveTo(sx(s[0]), sy(s[1]));
    ctx.lineTo(sx(s[2]), sy(s[3]));
  }
  ctx.stroke();
  label.value = "slice " + index + " / " + Math.max(0, slices.length - 1) + "    z=" + Number(slice.z || 0).toFixed(3);
}
input.addEventListener("input", () => {
  playing = false;
  play.textContent = "Play";
  sliceIndex = Number(input.value);
  draw(sliceIndex);
});
play.addEventListener("click", () => {
  playing = !playing;
  play.textContent = playing ? "Pause" : "Play";
});
setInterval(() => {
  if (!playing || slices.length === 0) return;
  sliceIndex = (sliceIndex + 1) % slices.length;
  input.value = String(sliceIndex);
  draw(sliceIndex);
}, 260);
draw(sliceIndex);
</script>`;
  fs.writeFileSync(PREVIEW_OUT, html);
}
