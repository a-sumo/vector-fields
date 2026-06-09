const FLAT_MATERIAL: Material = requireAsset("../Materials/FlatMaterial 2.mat") as Material;
const FLOW_MATERIAL: Material = requireAsset("../Materials/CarFlowStream.mat") as Material;

type FlowSample = { x: number, z: number, speed: number, intensity: number };

@component
export class LiveFoilFlow2D extends BaseScriptComponent {
  @input("bool")
  @hint("Show the minimal live foil flow preview.")
  liveEnabled: boolean = true;

  @input
  @allowUndefined
  @hint("Optional transformable foil object. Its local XY position and local Z rotation drive the preview.")
  foilObject: SceneObject;

  @input("float", "24")
  planeWidth: number = 24.0;

  @input("float", "9.27")
  planeHeight: number = 9.27;

  @input("float", "15")
  @widget(new SliderWidget(5, 30, 1))
  updateHz: number = 15.0;

  @input("float", "1.15")
  @widget(new SliderWidget(0.2, 3.0, 0.05))
  flowSpeed: number = 1.15;

  @input("bool")
  @hint("Reverse the airflow direction without rotating the foil object.")
  invertFlowDirection: boolean = true;

  @input("float", "0")
  @widget(new SliderWidget(-35, 35, 1))
  foilAngleDeg: number = 0.0;

  @input("float", "0")
  @widget(new SliderWidget(-8, 8, 0.1))
  foilCenterX: number = 0.0;

  @input("float", "0")
  @widget(new SliderWidget(-3, 3, 0.1))
  foilCenterY: number = 0.0;

  @input("float", "0.64")
  @widget(new SliderWidget(0.2, 0.9, 0.02))
  foilChord01: number = 0.64;

  @input("int", "9")
  @widget(new SliderWidget(3, 14, 1))
  lineCount: number = 9;

  @input("int", "48")
  @widget(new SliderWidget(18, 72, 1))
  lineSegments: number = 48;

  @input("float", "0.055")
  @widget(new SliderWidget(0.02, 0.14, 0.005))
  lineWidth: number = 0.055;

  @input("float", "1.6")
  @widget(new SliderWidget(0.2, 4.0, 0.1))
  @hint("Speed of dotted flow packets along the streamlines.")
  dotScrollSpeed: number = 1.6;

  @input
  @widget(new ColorWidget())
  flowColor: vec4 = new vec4(0.18, 1.0, 0.50, 0.78);

  @input
  @widget(new ColorWidget())
  foilColor: vec4 = new vec4(0.12, 0.88, 1.0, 0.96);

  private flowVisual: RenderMeshVisual | null = null;
  private foilVisual: RenderMeshVisual | null = null;
  private flowMaterial: Material | null = null;
  private foilMaterial: Material | null = null;
  private accumulator: number = 0.0;
  private lastTime: number = 0.0;
  private lastGeometrySignature: string = "";
  private solverW: number = 40;
  private solverH: number = 20;
  private solverPhi: Float32Array = new Float32Array(0);
  private solverNext: Float32Array = new Float32Array(0);
  private solverSolid: Uint8Array = new Uint8Array(0);
  private solverU: Float32Array = new Float32Array(0);
  private solverV: Float32Array = new Float32Array(0);
  private solverReady: boolean = false;

  onAwake(): void {
    this.ensureVisuals();
    this.createEvent("UpdateEvent").bind(() => this.tick());
    (this as any).windApi = {
      sampleTubeGlyphField: (x: number, z: number, time?: number) => this.sampleTubeGlyphField(x, z, time),
      getTubeGlyphFieldState: () => this.getTubeGlyphFieldState(),
      getTubeGlyphFieldSignature: () => this.getTubeGlyphFieldSignature(),
      refresh: () => this.refresh(),
    };
    this.refresh();
    print("[LiveFoilFlow2D] minimal analytic preview ready");
  }

  public refresh(): void {
    this.ensureVisuals();
    if (!this.liveEnabled) {
      this.setVisible(false);
      return;
    }
    this.setVisible(true);
    this.updateMaterials();
    this.rebuildPotentialSolver();
    this.rebuildMeshes();
    this.lastGeometrySignature = this.geometrySignature();
  }

  private tick(): void {
    if (!this.liveEnabled || !this.sceneObject.enabled) {
      this.setVisible(false);
      return;
    }
    const now = getTime();
    const dt = this.lastTime > 0.0 ? Math.min(0.12, Math.max(0.0, now - this.lastTime)) : 0.0;
    this.lastTime = now;
    this.updateFlowUniforms(now);
    this.accumulator += dt;
    const interval = 1.0 / Math.max(1.0, this.updateHz);
    if (this.accumulator < interval) return;
    this.accumulator = 0.0;
    const signature = this.geometrySignature();
    if (signature === this.lastGeometrySignature) return;
    this.refresh();
  }

  public sampleTubeGlyphField(x: number, z: number, time?: number): FlowSample {
    const v = this.flowAt(x, z, time === undefined ? getTime() : time);
    const speed = Math.sqrt(v.x * v.x + v.y * v.y);
    return {
      x: v.x,
      z: v.y,
      speed: speed,
      intensity: this.clamp(speed / Math.max(0.001, this.flowSpeed * 1.8), 0.0, 1.0),
    };
  }

  public getTubeGlyphFieldState(): { planeWidth: number, planeDepth: number, plane: string, phase: number, phaseSpeed: number } {
    return {
      planeWidth: this.planeWidth,
      planeDepth: this.planeHeight,
      plane: "XY",
      phase: getTime(),
      phaseSpeed: 1.0,
    };
  }

  public getTubeGlyphFieldSignature(): string {
    return this.signature() + ":" + getTime().toFixed(1);
  }

  private rebuildMeshes(): void {
    this.rebuildFlowMesh();
    this.rebuildFoilMesh();
  }

  private rebuildFlowMesh(): void {
    if (!this.flowVisual) return;
    const mb = this.flowBuilder();
    const count = Math.max(1, Math.floor(this.lineCount));
    const hh = this.planeHeight * 0.5;
    const span = this.planeHeight * 0.72;
    const margin = this.planeWidth * 0.45;
    const startX = this.invertFlowDirection ? margin : -margin;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const y = -span * 0.5 + t * span;
      const phase = this.fract(i * 0.38196601125);
      this.appendStreamline(mb, startX, this.clamp(y, -hh + 0.2, hh - 0.2), phase);
    }
    mb.updateMesh();
    this.flowVisual.mesh = mb.getMesh();
    this.updateFlowUniforms(getTime());
  }

  private rebuildFoilMesh(): void {
    if (!this.foilVisual) return;
    const mb = this.flatBuilder();
    const pose = this.foilPose();
    const chord = this.chord();
    const thickness = chord * 0.10;
    let px = 0.0;
    let py = 0.0;
    const steps = 72;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2.0;
      const lx = Math.cos(a) * chord * 0.5;
      const ly = Math.sin(a) * thickness * (0.64 + 0.28 * Math.cos(a));
      const p = this.localToWorld(lx, ly, pose);
      if (i > 0) {
        const dx = p.x - px;
        const dy = p.y - py;
        const len = Math.sqrt(dx * dx + dy * dy);
        this.appendDash(mb, (p.x + px) * 0.5, (p.y + py) * 0.5, dx / Math.max(0.001, len), dy / Math.max(0.001, len), len, 0.075);
      }
      px = p.x;
      py = p.y;
    }
    mb.updateMesh();
    this.foilVisual.mesh = mb.getMesh();
  }

  private flowAt(x: number, y: number, time: number): { x: number, y: number } {
    if (!this.solverReady) this.rebuildPotentialSolver();
    const solver = this.sampleSolverVelocity(x, y);
    const pose = this.foilPose();
    const dir = this.invertFlowDirection ? -1.0 : 1.0;
    const windAngle = this.invertFlowDirection ? Math.PI : 0.0;
    const aoa = this.wrapAngle(pose.angle - windAngle);
    const stall = this.clamp(1.0 - Math.max(0.0, Math.abs(aoa) - 0.34) * 1.7, 0.25, 1.0);
    const cl = this.clamp(2.0 * Math.PI * aoa, -1.35, 1.35) * stall;
    const cd = 0.05 + 0.10 * cl * cl;
    const c = Math.cos(-pose.angle);
    const s = Math.sin(-pose.angle);
    const ca = Math.cos(pose.angle);
    const sa = Math.sin(pose.angle);
    const dx = x - pose.x;
    const dy = y - pose.y;
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    const chord = this.chord();
    const a = chord * 0.52;
    const b = chord * 0.105;
    const sx = lx / Math.max(0.001, a);
    const sy = ly / Math.max(0.001, b);
    const r = Math.max(0.001, Math.sqrt(sx * sx + sy * sy));
    const sdf = r - 1.0;
    const near = Math.exp(-Math.max(0.0, sdf) * 2.6);

    let nx = lx / Math.max(0.001, a * a);
    let ny = ly / Math.max(0.001, b * b);
    const nl = Math.max(0.001, Math.sqrt(nx * nx + ny * ny));
    nx /= nl;
    ny /= nl;

    let vx = solver.x * c - solver.y * s;
    let vy = solver.x * s + solver.y * c;
    const intoFoil = vx * nx + vy * ny;
    if (intoFoil < 0.0) {
      vx -= nx * intoFoil * near * 1.25;
      vy -= ny * intoFoil * near * 1.25;
    }

    const tx = -ny;
    const ty = nx;
    const tangentSign = (vx * tx + vy * ty) >= 0.0 ? 1.0 : -1.0;
    vx += tx * tangentSign * this.flowSpeed * near * 0.42;
    vy += ty * tangentSign * this.flowSpeed * near * 0.42;
    vy += -cl * this.flowSpeed * near * 0.24;

    const windLocalX = dir * c;
    const windLocalY = dir * s;
    const downstream = lx * windLocalX + ly * windLocalY;
    const cross = -lx * windLocalY + ly * windLocalX;
    const wake = Math.exp(-Math.max(0.0, downstream - chord * 0.12) / Math.max(0.001, chord * 0.38)) * Math.exp(-(cross * cross) / Math.max(0.001, chord * chord * 0.045));
    vx *= 1.0 - wake * (0.22 + cd);
    vy += Math.sin(downstream * 1.05 + time * 1.7) * wake * 0.12 * (aoa >= 0.0 ? 1.0 : -1.0);

    return {
      x: vx * ca - vy * sa,
      y: vx * sa + vy * ca,
    };
  }

  private rebuildPotentialSolver(): void {
    const w = this.solverW;
    const h = this.solverH;
    const n = w * h;
    if (this.solverPhi.length !== n) {
      this.solverPhi = new Float32Array(n);
      this.solverNext = new Float32Array(n);
      this.solverSolid = new Uint8Array(n);
      this.solverU = new Float32Array(n);
      this.solverV = new Float32Array(n);
    }

    const dir = this.invertFlowDirection ? -1.0 : 1.0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = this.solverIndex(x, y);
        const wx = this.solverWorldX(x);
        const wy = this.solverWorldY(y);
        const solid = this.foilSdf(wx, wy) < 0.0;
        this.solverSolid[i] = solid ? 1 : 0;
        this.solverPhi[i] = dir * wx * this.flowSpeed;
      }
    }

    const iterations = 14;
    for (let iter = 0; iter < iterations; iter++) {
      this.solverNext.set(this.solverPhi);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = this.solverIndex(x, y);
          if (this.solverSolid[i] !== 0) continue;
          this.solverNext[i] = 0.25 * (
            this.neighborPhi(x - 1, y, i) +
            this.neighborPhi(x + 1, y, i) +
            this.neighborPhi(x, y - 1, i) +
            this.neighborPhi(x, y + 1, i)
          );
        }
      }
      const tmp = this.solverPhi;
      this.solverPhi = this.solverNext;
      this.solverNext = tmp;
    }

    const dx = this.planeWidth / Math.max(1, w - 1);
    const dy = this.planeHeight / Math.max(1, h - 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = this.solverIndex(x, y);
        if (this.solverSolid[i] !== 0) {
          this.solverU[i] = 0.0;
          this.solverV[i] = 0.0;
          continue;
        }
        const l = this.neighborPhi(Math.max(0, x - 1), y, i);
        const r = this.neighborPhi(Math.min(w - 1, x + 1), y, i);
        const b = this.neighborPhi(x, Math.min(h - 1, y + 1), i);
        const t = this.neighborPhi(x, Math.max(0, y - 1), i);
        this.solverU[i] = (r - l) / Math.max(0.001, 2.0 * dx);
        this.solverV[i] = (b - t) / Math.max(0.001, 2.0 * dy);
      }
    }
    this.solverReady = true;
  }

  private neighborPhi(x: number, y: number, fallbackIndex: number): number {
    const i = this.solverIndex(x, y);
    if (this.solverSolid[i] !== 0) return this.solverPhi[fallbackIndex];
    return this.solverPhi[i];
  }

  private sampleSolverVelocity(x: number, y: number): { x: number, y: number } {
    if (!this.solverReady || this.solverU.length === 0) {
      return { x: this.flowSpeed * (this.invertFlowDirection ? -1.0 : 1.0), y: 0.0 };
    }
    const gx = this.clamp((x / this.planeWidth + 0.5) * (this.solverW - 1), 0.0, this.solverW - 1.001);
    const gy = this.clamp((0.5 - y / this.planeHeight) * (this.solverH - 1), 0.0, this.solverH - 1.001);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(this.solverW - 1, x0 + 1);
    const y1 = Math.min(this.solverH - 1, y0 + 1);
    const tx = gx - x0;
    const ty = gy - y0;
    return {
      x: this.bilerp(this.solverU, x0, y0, x1, y1, tx, ty),
      y: this.bilerp(this.solverV, x0, y0, x1, y1, tx, ty),
    };
  }

  private bilerp(field: Float32Array, x0: number, y0: number, x1: number, y1: number, tx: number, ty: number): number {
    const a = field[this.solverIndex(x0, y0)] * (1.0 - tx) + field[this.solverIndex(x1, y0)] * tx;
    const b = field[this.solverIndex(x0, y1)] * (1.0 - tx) + field[this.solverIndex(x1, y1)] * tx;
    return a * (1.0 - ty) + b * ty;
  }

  private solverIndex(x: number, y: number): number {
    return x + y * this.solverW;
  }

  private solverWorldX(x: number): number {
    return (x / Math.max(1, this.solverW - 1) - 0.5) * this.planeWidth;
  }

  private solverWorldY(y: number): number {
    return (0.5 - y / Math.max(1, this.solverH - 1)) * this.planeHeight;
  }

  private foilSdf(x: number, y: number): number {
    const pose = this.foilPose();
    const c = Math.cos(-pose.angle);
    const s = Math.sin(-pose.angle);
    const dx = x - pose.x;
    const dy = y - pose.y;
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    const a = this.chord() * 0.5;
    const b = this.chord() * 0.10;
    const qx = lx / Math.max(0.001, a);
    const qy = ly / Math.max(0.001, b);
    return Math.sqrt(qx * qx + qy * qy) - 1.0;
  }

  private foilPose(): { x: number, y: number, angle: number } {
    if (this.foilObject) {
      const tr = this.foilObject.getTransform();
      const p = tr.getLocalPosition();
      const axis = tr.getLocalRotation().multiplyVec3(new vec3(1.0, 0.0, 0.0));
      return { x: p.x, y: p.y, angle: Math.atan2(axis.y, axis.x) };
    }
    return { x: this.foilCenterX, y: this.foilCenterY, angle: this.foilAngleDeg * Math.PI / 180.0 };
  }

  private localToWorld(x: number, y: number, pose: { x: number, y: number, angle: number }): { x: number, y: number } {
    const c = Math.cos(pose.angle);
    const s = Math.sin(pose.angle);
    return { x: pose.x + x * c - y * s, y: pose.y + x * s + y * c };
  }

  private appendStreamline(mb: MeshBuilder, startX: number, startY: number, phase: number): void {
    const segments = Math.max(4, Math.floor(this.lineSegments));
    const step = this.planeWidth / segments * (this.invertFlowDirection ? -1.0 : 1.0);
    let x = startX;
    let y = startY;
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments;
      const flow = this.flowAt(x, y, 0.0);
      const speed = Math.max(0.001, Math.sqrt(flow.x * flow.x + flow.y * flow.y));
      const dx = flow.x / speed;
      const dy = flow.y / speed;
      let nx = x + dx * Math.abs(step);
      let ny = y + dy * Math.abs(step);
      const cleared = this.clearFoil(nx, ny);
      nx = cleared.x;
      ny = cleared.y;
      if (this.foilSdf((x + nx) * 0.5, (y + ny) * 0.5) > 0.04) {
        const t1 = (i + 1) / segments;
        const speedRatio = this.clamp(speed / Math.max(0.001, this.flowSpeed * 1.8), 0.0, 1.0);
        this.appendFlowSegment(mb, x, y, nx, ny, this.lineWidth, t0, t1, phase, speedRatio);
      }
      x = nx;
      y = ny;
    }
  }

  private fract(v: number): number {
    return v - Math.floor(v);
  }

  private clearFoil(x: number, y: number): { x: number, y: number } {
    const sdf = this.foilSdf(x, y);
    if (sdf > 0.08) return { x: x, y: y };
    const n = this.foilNormal(x, y);
    const push = (0.10 - sdf) * this.chord() * 0.09;
    return { x: x + n.x * push, y: y + n.y * push };
  }

  private foilNormal(x: number, y: number): { x: number, y: number } {
    const pose = this.foilPose();
    const c = Math.cos(-pose.angle);
    const s = Math.sin(-pose.angle);
    const dx = x - pose.x;
    const dy = y - pose.y;
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    const a = this.chord() * 0.5;
    const b = this.chord() * 0.10;
    let nx = lx / Math.max(0.001, a * a);
    let ny = ly / Math.max(0.001, b * b);
    const len = Math.max(0.001, Math.sqrt(nx * nx + ny * ny));
    nx /= len;
    ny /= len;
    const ca = Math.cos(pose.angle);
    const sa = Math.sin(pose.angle);
    return { x: nx * ca - ny * sa, y: nx * sa + ny * ca };
  }

  private appendDash(mb: MeshBuilder, x: number, y: number, dx: number, dy: number, length: number, width: number): void {
    const nx = -dy;
    const ny = dx;
    const hx = dx * length * 0.5;
    const hy = dy * length * 0.5;
    const wx = nx * width * 0.5;
    const wy = ny * width * 0.5;
    const base = mb.getVerticesCount();
    this.vertex(mb, x - hx - wx, y - hy - wy, 0.08, 0.0, 0.0);
    this.vertex(mb, x - hx + wx, y - hy + wy, 0.08, 0.0, 1.0);
    this.vertex(mb, x + hx - wx, y + hy - wy, 0.08, 1.0, 0.0);
    this.vertex(mb, x + hx + wx, y + hy + wy, 0.08, 1.0, 1.0);
    mb.appendIndices([base, base + 1, base + 2, base + 1, base + 3, base + 2]);
  }

  private appendFlowSegment(mb: MeshBuilder, x0: number, y0: number, x1: number, y1: number, width: number, t0: number, t1: number, phase: number, speedRatio: number): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
    const nx = -dy / len;
    const ny = dx / len;
    const wx = nx * width * 0.5;
    const wy = ny * width * 0.5;
    const base = mb.getVerticesCount();
    this.flowVertex(mb, x0 - wx, y0 - wy, 0.08, 1.0 - t0, phase, speedRatio, -1.0);
    this.flowVertex(mb, x0 + wx, y0 + wy, 0.08, 1.0 - t0, phase, speedRatio, 1.0);
    this.flowVertex(mb, x1 - wx, y1 - wy, 0.08, 1.0 - t1, phase, speedRatio, -1.0);
    this.flowVertex(mb, x1 + wx, y1 + wy, 0.08, 1.0 - t1, phase, speedRatio, 1.0);
    mb.appendIndices([base, base + 1, base + 2, base + 1, base + 3, base + 2]);
  }

  private vertex(mb: MeshBuilder, x: number, y: number, z: number, u: number, v: number): void {
    mb.appendVerticesInterleaved([x, y, z, 0.0, 0.0, 1.0, u, v]);
  }

  private flowVertex(mb: MeshBuilder, x: number, y: number, z: number, pathT: number, phase: number, speedRatio: number, crossSection: number): void {
    mb.appendVerticesInterleaved([x, y, z, pathT, phase, speedRatio, 0.0, crossSection, -1.0]);
  }

  private flatBuilder(): MeshBuilder {
    const mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "normal", components: 3 },
      { name: "texture0", components: 2 },
    ]);
    mb.topology = MeshTopology.Triangles;
    mb.indexType = MeshIndexType.UInt16;
    return mb;
  }

  private flowBuilder(): MeshBuilder {
    const mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "texture0", components: 2 },
      { name: "texture1", components: 2 },
      { name: "texture2", components: 2 },
    ]);
    mb.topology = MeshTopology.Triangles;
    mb.indexType = MeshIndexType.UInt16;
    return mb;
  }

  private ensureVisuals(): void {
    if (!this.flowVisual) {
      const flowObject = global.scene.createSceneObject("__LiveFoilFlowLines");
      flowObject.name = "__LiveFoilFlowLines";
      flowObject.setParent(this.sceneObject);
      this.flowVisual = flowObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    }
    if (!this.foilVisual) {
      const foilObject = global.scene.createSceneObject("__LiveFoilOutline");
      foilObject.name = "__LiveFoilOutline";
      foilObject.setParent(this.sceneObject);
      this.foilVisual = foilObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    }
    if (!this.flowMaterial) this.flowMaterial = FLOW_MATERIAL.clone();
    if (!this.foilMaterial) this.foilMaterial = this.makeMaterial(this.foilColor);
    this.flowVisual.mainMaterial = this.flowMaterial;
    this.foilVisual.mainMaterial = this.foilMaterial;
    try { this.flowVisual.renderOrder = 710; } catch (e) {}
    try { this.foilVisual.renderOrder = 711; } catch (e) {}
  }

  private makeMaterial(color: vec4): Material {
    const material = FLAT_MATERIAL.clone();
    this.setMaterialColor(material, color);
    return material;
  }

  private updateMaterials(): void {
    this.updateFlowUniforms(getTime());
    if (this.foilMaterial) this.setMaterialColor(this.foilMaterial, this.foilColor);
  }

  private updateFlowUniforms(time: number): void {
    if (!this.flowMaterial) return;
    const pass = this.flowMaterial.mainPass as any;
    try { pass.Time = time; } catch (e) {}
    try { pass.PhaseSpeed = this.dotScrollSpeed; } catch (e) {}
  }

  private setMaterialColor(material: Material, color: vec4): void {
    const pass = material.mainPass as any;
    try { pass.baseColor = color; } catch (e) {}
    try { pass.baseColorFactor = color; } catch (e) {}
    try { pass.FlatColor = color; } catch (e) {}
  }

  private setVisible(visible: boolean): void {
    if (this.flowVisual) this.flowVisual.enabled = visible;
    if (this.foilVisual) this.foilVisual.enabled = visible;
  }

  private chord(): number {
    return Math.max(0.1, this.planeWidth * this.clamp(this.foilChord01, 0.05, 0.95));
  }

  private signature(): string {
    return this.geometrySignature() + ":" + this.dotScrollSpeed.toFixed(2);
  }

  private geometrySignature(): string {
    const pose = this.foilPose();
    return [
      this.liveEnabled ? "1" : "0",
      this.planeWidth.toFixed(2), this.planeHeight.toFixed(2),
      pose.x.toFixed(2), pose.y.toFixed(2), pose.angle.toFixed(3),
      this.foilChord01.toFixed(3), this.flowSpeed.toFixed(2), this.invertFlowDirection ? "R" : "F",
      Math.floor(this.lineCount), Math.floor(this.lineSegments), this.lineWidth.toFixed(3),
    ].join(":");
  }

  private wrapAngle(a: number): number {
    while (a > Math.PI) a -= Math.PI * 2.0;
    while (a < -Math.PI) a += Math.PI * 2.0;
    return a;
  }

  private clamp(v: number, a: number, b: number): number {
    return Math.max(a, Math.min(b, v));
  }
}
