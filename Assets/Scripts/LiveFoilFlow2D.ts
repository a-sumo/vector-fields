const FLAT_MATERIAL: Material = requireAsset("../Materials/FlatMaterial 2.mat") as Material;
const FLOW_MATERIAL: Material = requireAsset("../Materials/CarFlowStream.mat") as Material;

type FlowSample = { x: number, z: number, speed: number, intensity: number };

enum ObstacleShape {
  Airfoil = 0,
  Sphere = 1,
  Square = 2,
  FlatPlate = 3,
}

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

  @input("int", "0")
  @widget(new ComboBoxWidget([
    new ComboBoxItem("Airfoil", 0),
    new ComboBoxItem("Sphere", 1),
    new ComboBoxItem("Square", 2),
    new ComboBoxItem("Flat Plate", 3),
  ]))
  @hint("2D obstacle preset. Sphere is rendered as a circular cross-section.")
  obstacleShape: number = ObstacleShape.Airfoil;

  @input("int", "9")
  @widget(new SliderWidget(3, 14, 1))
  lineCount: number = 9;

  @input("int", "48")
  @widget(new SliderWidget(18, 72, 1))
  lineSegments: number = 48;

  @input("float", "0.055")
  @widget(new SliderWidget(0.02, 0.14, 0.005))
  lineWidth: number = 0.055;

  @input("float", "0.16")
  @widget(new SliderWidget(0.02, 0.4, 0.01))
  @hint("Speed of the background flow particles. Clamped to a slow range so drift reads as air, not noise.")
  dotScrollSpeed: number = 0.16;

  @input
  @widget(new ColorWidget())
  flowColor: vec4 = new vec4(0.18, 1.0, 0.50, 0.78);

  @input
  @widget(new ColorWidget())
  foilColor: vec4 = new vec4(0.12, 0.88, 1.0, 0.96);

  private flowVisual: RenderMeshVisual | null = null;
  private backgroundFlowVisual: RenderMeshVisual | null = null;
  private foilVisual: RenderMeshVisual | null = null;
  private flowMaterial: Material | null = null;
  private backgroundFlowMaterial: Material | null = null;
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
    this.suppressLegacyCarContent();
    this.ensureVisuals();
    this.createEvent("UpdateEvent").bind(() => this.tick());
    (this as any).windApi = {
      sampleTubeGlyphField: (x: number, z: number, time?: number) => this.sampleTubeGlyphField(x, z, time),
      getTubeGlyphFieldState: () => this.getTubeGlyphFieldState(),
      getTubeGlyphFieldSignature: () => this.getTubeGlyphFieldSignature(),
      refresh: () => this.refresh(),
      setObstacleShape: (shape: number | string) => this.setObstacleShape(shape),
      getObstacleShape: () => this.currentObstacleShape(),
      getObstacleShapeName: () => this.obstacleShapeName(this.currentObstacleShape()),
      setFoilAngleDeg: (degrees: number) => this.setFoilAngleDeg(degrees),
      getFoilAngleDeg: () => this.getFoilAngleDeg(),
      setFlowSpeed: (speed: number) => this.setFlowSpeed(speed),
      setFlowSpeedNormalized: (value: number) => this.setFlowSpeedNormalized(value),
      setVectorDensity: (value: number) => this.setVectorDensity(value),
      setVectorDensityNormalized: (value: number) => this.setVectorDensityNormalized(value),
      setLineCount: (count: number) => this.setLineCount(count),
      setAerodynamicsMode: (mode: number | string) => this.setAerodynamicsMode(mode),
      setAeroBackend: (mode: number | string) => this.setAerodynamicsMode(mode),
      setLegacyCarContentEnabled: (enabled: boolean) => this.setLegacyCarContentEnabled(enabled),
      resetFoil: () => this.resetFoil(),
      resetFoilPose: () => this.resetFoil(),
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
    if (signature !== this.lastGeometrySignature) {
      this.refresh();
      return;
    }
    this.rebuildBackgroundFlowMesh();
    this.rebuildFlowMesh();
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

  public setObstacleShape(shape: number | string): void {
    const next = this.normalizeObstacleShape(shape);
    if (next === this.currentObstacleShape()) return;
    this.obstacleShape = next;
    this.refresh();
  }

  public setFoilAngleDeg(degrees: number): void {
    if (!isFinite(degrees)) return;
    this.foilAngleDeg = this.clamp(degrees, -35.0, 35.0);
    if (this.foilObject) {
      try {
        this.foilObject.getTransform().setLocalRotation(quat.fromEulerAngles(0.0, 0.0, this.foilAngleDeg * Math.PI / 180.0));
      } catch (e) {}
    }
    this.refresh();
  }

  public getFoilAngleDeg(): number {
    const pose = this.foilPose();
    return pose.angle * 180.0 / Math.PI;
  }

  public setFlowSpeed(speed: number): void {
    if (!isFinite(speed)) return;
    this.flowSpeed = this.clamp(speed, 0.2, 3.0);
    this.refresh();
  }

  public setFlowSpeedNormalized(value: number): void {
    if (!isFinite(value)) return;
    this.setFlowSpeed(0.35 + this.clamp(value, 0.0, 1.0) * 2.65);
  }

  public setVectorDensity(value: number): void {
    if (!isFinite(value)) return;
    this.setLineCount(value);
  }

  public setVectorDensityNormalized(value: number): void {
    if (!isFinite(value)) return;
    this.setLineCount(4.0 + this.clamp(value, 0.0, 1.0) * 12.0);
  }

  public setLineCount(count: number): void {
    if (!isFinite(count)) return;
    this.lineCount = Math.floor(this.clamp(count, 3, 18));
    this.refresh();
  }

  public setAerodynamicsMode(mode: number | string): void {
    const carMode = this.isCarMode(mode);
    this.liveEnabled = !carMode;
    this.setVisible(!carMode);
    this.setLegacyCarContentEnabled(carMode);
    if (carMode) {
      const carApi = this.findLegacyCarApi();
      if (carApi) {
        if (typeof carApi.setCarDataSet === "function") carApi.setCarDataSet();
        else if (typeof carApi.setDataSet === "function") carApi.setDataSet(0);
        if (typeof carApi.refreshSliceHome === "function") carApi.refreshSliceHome();
        if (typeof carApi.refreshObstacleContour === "function") carApi.refreshObstacleContour();
        else if (typeof carApi.rebuildObstacleContour === "function") carApi.rebuildObstacleContour();
        if (typeof carApi.refresh === "function") carApi.refresh();
      }
    } else {
      this.refresh();
    }
  }

  public resetFoil(): void {
    this.foilCenterX = 0.0;
    this.foilCenterY = 0.0;
    this.foilAngleDeg = 0.0;
    if (this.foilObject) {
      try {
        const tr = this.foilObject.getTransform();
        tr.setLocalPosition(new vec3(0.0, 0.0, 0.0));
        tr.setLocalRotation(quat.quatIdentity());
      } catch (e) {}
    }
    this.refresh();
  }

  private rebuildMeshes(): void {
    this.rebuildBackgroundFlowMesh();
    this.rebuildFlowMesh();
    this.rebuildFoilMesh();
  }

  private rebuildBackgroundFlowMesh(): void {
    if (!this.backgroundFlowVisual) return;
    const mb = this.flowBuilder();
    const rows = Math.max(7, Math.floor(this.lineCount * 1.25));
    const columns = Math.max(36, Math.min(72, Math.floor(this.lineSegments * 1.0)));
    const spanX = this.planeWidth * 0.94;
    const spanY = this.planeHeight * 0.84;
    const dir = this.invertFlowDirection ? -1.0 : 1.0;
    const upstreamX = dir < 0.0 ? spanX * 0.5 : -spanX * 0.5;
    const step = spanX / Math.max(1, columns - 1);
    const lineWidth = Math.max(0.065, this.lineWidth * 1.18);
    const time = getTime();

    for (let row = 0; row < rows; row++) {
      const ty = rows === 1 ? 0.5 : row / (rows - 1);
      let x = upstreamX;
      let y = -spanY * 0.5 + ty * spanY;
      const phase = this.fract(row * 0.173 + 0.19);
      for (let column = 0; column < columns; column++) {
        const flow = this.flowAt(x, y, time);
        const speed = Math.max(0.001, Math.sqrt(flow.x * flow.x + flow.y * flow.y));
        const nx = x + flow.x / speed * step;
        const ny = this.clamp(y + flow.y / speed * step, -spanY * 0.52, spanY * 0.52);

        if (this.foilSdf(x, y) > 0.17 && this.foilSdf(nx, ny) > 0.17 && this.foilSdf((x + nx) * 0.5, (y + ny) * 0.5) > 0.14) {
          const t0 = column / Math.max(1, columns - 1);
          const t1 = (column + 1) / Math.max(1, columns - 1);
          const speedRatio = this.clamp(speed / Math.max(0.001, this.flowSpeed * 1.8), 0.0, 1.0);
          const pulse = this.backgroundPulseAt(t0, phase, time);
          if (pulse > 0.10) {
            this.appendFlowSegment(mb, x, y, nx, ny, lineWidth * (0.62 + pulse * 0.66), t0, t1, phase, speedRatio);
          }
        }
        x = nx;
        y = ny;
      }
    }

    mb.updateMesh();
    this.backgroundFlowVisual.mesh = mb.getMesh();
  }

  private rebuildFlowMesh(): void {
    if (!this.flowVisual) return;
    const mb = this.flatBuilder();
    const rows = Math.max(3, Math.floor(this.lineCount));
    const columns = Math.max(7, Math.min(18, Math.floor(this.lineSegments * 0.24)));
    const spanX = this.planeWidth * 0.86;
    const spanY = this.planeHeight * 0.72;
    const stepX = spanX / Math.max(1, columns - 1);
    const stepY = spanY / Math.max(1, rows - 1);
    const baseLength = Math.min(stepX * 0.58, stepY * 0.62);
    const time = getTime();
    for (let row = 0; row < rows; row++) {
      const ty = rows === 1 ? 0.5 : row / (rows - 1);
      const y = -spanY * 0.5 + ty * spanY;
      for (let column = 0; column < columns; column++) {
        const tx = columns === 1 ? 0.5 : column / (columns - 1);
        const x = -spanX * 0.5 + tx * spanX;
        this.appendFlowGlyph(mb, x, y, baseLength, time, row, column);
      }
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
    const shape = this.currentObstacleShape();
    let px = 0.0;
    let py = 0.0;
    const steps = shape === ObstacleShape.Square ? 4 : 72;
    for (let i = 0; i <= steps; i++) {
      const p = this.localToWorldShapePoint(i, steps, chord, shape, pose);
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

  private localToWorldShapePoint(i: number, steps: number, chord: number, shape: ObstacleShape, pose: { x: number, y: number, angle: number }): { x: number, y: number } {
    if (shape === ObstacleShape.Square) {
      const h = chord * 0.24;
      const k = i % 4;
      if (k === 0) return this.localToWorld(-h, -h, pose);
      if (k === 1) return this.localToWorld(h, -h, pose);
      if (k === 2) return this.localToWorld(h, h, pose);
      return this.localToWorld(-h, h, pose);
    }
    const a = (i / Math.max(1, steps)) * Math.PI * 2.0;
    if (shape === ObstacleShape.Sphere) {
      const r = chord * 0.24;
      return this.localToWorld(Math.cos(a) * r, Math.sin(a) * r, pose);
    }
    if (shape === ObstacleShape.FlatPlate) {
      const hx = chord * 0.38;
      const hy = chord * 0.045;
      return this.localToWorld(Math.cos(a) * hx, Math.sin(a) * hy, pose);
    }
    const lx = Math.cos(a) * chord * 0.5;
    const ly = Math.sin(a) * chord * 0.10 * (0.64 + 0.28 * Math.cos(a));
    return this.localToWorld(lx, ly, pose);
  }

  private flowAt(x: number, y: number, time: number): { x: number, y: number } {
    if (!this.solverReady) this.rebuildPotentialSolver();
    const solver = this.sampleSolverVelocity(x, y);
    const pose = this.foilPose();
    const dir = this.invertFlowDirection ? -1.0 : 1.0;
    const windWorldX = dir;
    const windWorldY = 0.0;
    const c = Math.cos(-pose.angle);
    const s = Math.sin(-pose.angle);
    const ca = Math.cos(pose.angle);
    const sa = Math.sin(pose.angle);
    const windLocalX = windWorldX * c - windWorldY * s;
    const windLocalY = windWorldX * s + windWorldY * c;
    const aoa = -this.wrapHalfAngle(Math.atan2(windLocalY, windLocalX));
    const absAoa = Math.abs(aoa);
    const stall = this.clamp(1.0 - Math.max(0.0, absAoa - 0.34) * 2.0, 0.18, 1.0);
    const shape = this.currentObstacleShape();
    const liftScale = this.shapeLiftScale(shape);
    const bluff = this.shapeBluffness(shape);
    const cl = this.clamp(2.0 * Math.PI * aoa, -1.45, 1.45) * stall * liftScale;
    const cd = 0.05 + bluff * 0.24 + 0.10 * cl * cl;
    const dx = x - pose.x;
    const dy = y - pose.y;
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    const chord = this.chord();
    const a = this.shapeHalfX(shape, chord);
    const b = this.shapeHalfY(shape, chord);
    const sdf = this.localObstacleSdf(lx, ly, chord, shape);
    const near = Math.exp(-Math.max(0.0, sdf) * 2.6);

    const n = this.localObstacleNormal(lx, ly, chord, shape);
    const nx = n.x;
    const ny = n.y;

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

    const downstream = lx * windLocalX + ly * windLocalY;
    const cross = -lx * windLocalY + ly * windLocalX;
    const suctionSide = aoa >= 0.0 ? 1.0 : -1.0;
    const upperBias = this.clamp(suctionSide * ly / Math.max(0.001, b), -1.0, 1.0);
    const attached = Math.exp(-Math.max(0.0, sdf) * 3.8) * this.clamp((lx + chord * 0.44) / Math.max(0.001, chord * 0.88), 0.0, 1.0);
    const circulation = cl * this.flowSpeed * near * 0.34;
    vx += tx * circulation;
    vy += ty * circulation;
    vx *= 1.0 + attached * Math.max(0.0, upperBias) * absAoa * 0.95;
    vy += -cl * this.flowSpeed * near * 0.13;

    const front = Math.exp(-((lx - windLocalX * chord * 0.49) * (lx - windLocalX * chord * 0.49)) / Math.max(0.001, chord * chord * 0.030))
      * Math.exp(-(cross * cross) / Math.max(0.001, chord * chord * 0.026));
    vx *= 1.0 - front * 0.42;
    vy -= suctionSide * front * absAoa * this.flowSpeed * 0.28;

    const separated = this.clamp((absAoa - 0.30) / 0.34, 0.0, 1.0);
    const wakeWidth = chord * (0.030 + separated * 0.090 + bluff * 0.085);
    const wake = Math.exp(-Math.max(0.0, downstream - chord * 0.10) / Math.max(0.001, chord * (0.34 + separated * 0.22)))
      * Math.exp(-(cross * cross) / Math.max(0.001, chord * wakeWidth));
    vx *= 1.0 - wake * (0.18 + cd + separated * 0.30 + bluff * 0.26);
    vy += Math.sin(downstream * (1.05 + bluff * 0.55) + time * 1.7) * wake * (0.08 + separated * 0.20 + bluff * 0.10) * suctionSide;

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
    return this.localObstacleSdf(lx, ly, this.chord(), this.currentObstacleShape());
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

  private hash01(v: number): number {
    return this.fract(Math.sin(v * 12.9898) * 43758.5453);
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
    const normal = this.localObstacleNormal(lx, ly, this.chord(), this.currentObstacleShape());
    const nx = normal.x;
    const ny = normal.y;
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

  private backgroundPulseAt(pathT: number, phase: number, time: number): number {
    const scroll = this.clamp(this.dotScrollSpeed, 0.02, 0.4);
    const band = this.fract(pathT * 3.15 - (time * scroll + phase) + 1.0);
    const dist = Math.abs(band - 0.5) * 2.0;
    const core = 1.0 - this.smoothstep(0.0, 0.18, dist);
    const halo = 1.0 - this.smoothstep(0.18, 0.72, dist);
    return this.clamp(core * 0.95 + halo * 0.42, 0.0, 1.0);
  }

  private appendFlowGlyph(mb: MeshBuilder, x: number, y: number, baseLength: number, time: number, row: number, column: number): void {
    const sdf = this.foilSdf(x, y);
    if (sdf < 0.055) return;

    const flow = this.flowAt(x, y, time);
    const speed = Math.max(0.001, Math.sqrt(flow.x * flow.x + flow.y * flow.y));
    let dx = flow.x / speed;
    let dy = flow.y / speed;

    if (sdf < 0.36) {
      const n = this.foilNormal(x, y);
      const into = dx * n.x + dy * n.y;
      dx -= n.x * into;
      dy -= n.y * into;
      const tangentLen = Math.sqrt(dx * dx + dy * dy);
      if (tangentLen < 0.05) {
        dx = -n.y * (this.invertFlowDirection ? -1.0 : 1.0);
        dy = n.x * (this.invertFlowDirection ? -1.0 : 1.0);
      } else {
        dx /= tangentLen;
        dy /= tangentLen;
      }
    }

    const speedRatio = this.clamp(speed / Math.max(0.001, this.flowSpeed * 1.7), 0.28, 1.0);
    const clearance = this.clamp((sdf - 0.055) / 0.22, 0.0, 1.0);
    const phase = time * (1.8 + this.flowSpeed * 1.15) + column * 0.72 + row * 0.31;
    const pulse = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(phase));
    const length = baseLength * (0.58 + speedRatio * 0.42) * (0.55 + clearance * 0.45) * pulse;
    const width = this.lineWidth * (0.55 + speedRatio * 0.30);
    const cx = x + dx * baseLength * 0.10;
    const cy = y + dy * baseLength * 0.10;
    this.appendDash(mb, cx, cy, dx, dy, length, width);
    this.appendGlyphHead(mb, cx + dx * length * 0.5, cy + dy * length * 0.5, dx, dy, width * 2.1);
  }

  private appendGlyphHead(mb: MeshBuilder, tipX: number, tipY: number, dx: number, dy: number, size: number): void {
    const nx = -dy;
    const ny = dx;
    const baseX = tipX - dx * size * 1.35;
    const baseY = tipY - dy * size * 1.35;
    const half = size * 0.58;
    const base = mb.getVerticesCount();
    this.vertex(mb, tipX, tipY, 0.09, 1.0, 0.5);
    this.vertex(mb, baseX + nx * half, baseY + ny * half, 0.09, 0.0, 1.0);
    this.vertex(mb, baseX - nx * half, baseY - ny * half, 0.09, 0.0, 0.0);
    mb.appendIndices([base, base + 1, base + 2]);
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
    if (!this.backgroundFlowVisual) {
      const backgroundObject = global.scene.createSceneObject("__LiveFoilFlowBackground");
      backgroundObject.name = "__LiveFoilFlowBackground";
      backgroundObject.setParent(this.sceneObject);
      this.backgroundFlowVisual = backgroundObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    }
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
    if (!this.backgroundFlowMaterial) this.backgroundFlowMaterial = FLOW_MATERIAL.clone();
    if (!this.flowMaterial) this.flowMaterial = this.makeMaterial(this.flowColor);
    if (!this.foilMaterial) this.foilMaterial = this.makeMaterial(this.foilColor);
    this.backgroundFlowVisual.mainMaterial = this.backgroundFlowMaterial;
    this.flowVisual.mainMaterial = this.flowMaterial;
    this.foilVisual.mainMaterial = this.foilMaterial;
    try { this.backgroundFlowVisual.renderOrder = 709; } catch (e) {}
    try { this.flowVisual.renderOrder = 710; } catch (e) {}
    try { this.foilVisual.renderOrder = 711; } catch (e) {}
  }

  private suppressLegacyCarContent(): void {
    this.setLegacyCarContentEnabled(false);
  }

  private setLegacyCarContentEnabled(enabled: boolean): void {
    for (let i = 0; i < this.sceneObject.getChildrenCount(); i++) {
      this.setLegacyCarContentEnabledInTree(this.sceneObject.getChild(i), enabled);
    }
  }

  private setLegacyCarContentEnabledInTree(root: SceneObject, enabled: boolean): void {
    const name = root.name || "";
    if (name === "Car Flow Lines" || name === "Flow Slice Gizmo") {
      root.enabled = enabled;
    } else if (name === "Sketchfab_model" || name === "GLTF_SceneRootNode" || name === "racecar") {
      root.enabled = enabled;
    }

    const scripts = root.getComponents("Component.ScriptComponent");
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as any;
      if (!script) continue;
      try {
        if (script.name === "CarFlowStreamlines" ||
            script.carDataMode !== undefined ||
            script.autoSliceControlObject !== undefined ||
            script.slicePaths !== undefined) {
          script.enabled = enabled;
        }
      } catch (e) {}
    }

    for (let i = 0; i < root.getChildrenCount(); i++) {
      this.setLegacyCarContentEnabledInTree(root.getChild(i), enabled);
    }
  }

  private findLegacyCarApi(): any {
    for (let i = 0; i < this.sceneObject.getChildrenCount(); i++) {
      const api = this.findScriptApiInTree(this.sceneObject.getChild(i), "setSlice01") ||
        this.findScriptApiInTree(this.sceneObject.getChild(i), "setDataSet");
      if (api) return api;
    }
    return null;
  }

  private findScriptApiInTree(root: SceneObject | null, methodName: string): any {
    if (!root) return null;
    const scripts = root.getComponents("Component.ScriptComponent");
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as any;
      if (!script) continue;
      const api = script.windApi || script;
      if (api && typeof api[methodName] === "function") return api;
    }
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const found = this.findScriptApiInTree(root.getChild(i), methodName);
      if (found) return found;
    }
    return null;
  }

  private isCarMode(mode: number | string): boolean {
    if (typeof mode === "number") return Math.floor(mode) === 1 || Math.floor(mode) === 4;
    const key = ("" + mode).toLowerCase();
    return key === "car" || key === "carslice" || key === "car_slice" || key === "baked" || key === "baked_car";
  }

  private makeMaterial(color: vec4): Material {
    const material = FLAT_MATERIAL.clone();
    this.setMaterialColor(material, color);
    return material;
  }

  private updateMaterials(): void {
    this.updateFlowUniforms(getTime());
    if (this.flowMaterial) this.setMaterialColor(this.flowMaterial, this.flowColor);
    if (this.foilMaterial) this.setMaterialColor(this.foilMaterial, this.foilColor);
  }

  private updateFlowUniforms(time: number): void {
    if (this.flowMaterial) {
      const pass = this.flowMaterial.mainPass as any;
      try { pass.Time = time; } catch (e) {}
      try { pass.PhaseSpeed = this.dotScrollSpeed; } catch (e) {}
    }
    if (this.backgroundFlowMaterial) {
      const pass = this.backgroundFlowMaterial.mainPass as any;
      try { pass.Time = time; } catch (e) {}
      try { pass.PhaseSpeed = this.clamp(this.dotScrollSpeed, 0.02, 0.4); } catch (e) {}
    }
  }

  private setMaterialColor(material: Material, color: vec4): void {
    const pass = material.mainPass as any;
    try { pass.baseColor = color; } catch (e) {}
    try { pass.baseColorFactor = color; } catch (e) {}
    try { pass.FlatColor = color; } catch (e) {}
  }

  private setVisible(visible: boolean): void {
    if (this.backgroundFlowVisual) this.backgroundFlowVisual.enabled = visible;
    if (this.flowVisual) this.flowVisual.enabled = visible;
    if (this.foilVisual) this.foilVisual.enabled = visible;
  }

  private chord(): number {
    return Math.max(0.1, this.planeWidth * this.clamp(this.foilChord01, 0.05, 0.95));
  }

  private currentObstacleShape(): ObstacleShape {
    const value = Math.floor(this.obstacleShape);
    if (value === ObstacleShape.Sphere || value === ObstacleShape.Square || value === ObstacleShape.FlatPlate) return value as ObstacleShape;
    return ObstacleShape.Airfoil;
  }

  private normalizeObstacleShape(shape: number | string): ObstacleShape {
    if (typeof shape === "number") {
      const value = Math.floor(shape);
      if (value === ObstacleShape.Sphere || value === ObstacleShape.Square || value === ObstacleShape.FlatPlate) return value as ObstacleShape;
      return ObstacleShape.Airfoil;
    }
    const key = ("" + shape).toLowerCase();
    if (key === "sphere" || key === "circle" || key === "cylinder") return ObstacleShape.Sphere;
    if (key === "square" || key === "box") return ObstacleShape.Square;
    if (key === "plate" || key === "flat" || key === "flatplate") return ObstacleShape.FlatPlate;
    return ObstacleShape.Airfoil;
  }

  private obstacleShapeName(shape: ObstacleShape): string {
    if (shape === ObstacleShape.Sphere) return "Sphere";
    if (shape === ObstacleShape.Square) return "Square";
    if (shape === ObstacleShape.FlatPlate) return "Flat Plate";
    return "Airfoil";
  }

  private shapeHalfX(shape: ObstacleShape, chord: number): number {
    if (shape === ObstacleShape.Sphere) return chord * 0.24;
    if (shape === ObstacleShape.Square) return chord * 0.24;
    if (shape === ObstacleShape.FlatPlate) return chord * 0.38;
    return chord * 0.52;
  }

  private shapeHalfY(shape: ObstacleShape, chord: number): number {
    if (shape === ObstacleShape.Sphere) return chord * 0.24;
    if (shape === ObstacleShape.Square) return chord * 0.24;
    if (shape === ObstacleShape.FlatPlate) return chord * 0.045;
    return chord * 0.105;
  }

  private shapeLiftScale(shape: ObstacleShape): number {
    if (shape === ObstacleShape.FlatPlate) return 0.72;
    if (shape === ObstacleShape.Sphere) return 0.16;
    if (shape === ObstacleShape.Square) return 0.08;
    return 1.0;
  }

  private shapeBluffness(shape: ObstacleShape): number {
    if (shape === ObstacleShape.Square) return 1.0;
    if (shape === ObstacleShape.Sphere) return 0.62;
    if (shape === ObstacleShape.FlatPlate) return 0.22;
    return 0.0;
  }

  private localObstacleSdf(lx: number, ly: number, chord: number, shape: ObstacleShape): number {
    if (shape === ObstacleShape.Sphere) {
      const r = chord * 0.24;
      return (Math.sqrt(lx * lx + ly * ly) - r) / Math.max(0.001, r);
    }
    if (shape === ObstacleShape.Square) {
      const h = chord * 0.24;
      const qx = Math.abs(lx) - h;
      const qy = Math.abs(ly) - h;
      const outside = Math.sqrt(Math.max(qx, 0.0) * Math.max(qx, 0.0) + Math.max(qy, 0.0) * Math.max(qy, 0.0));
      const inside = Math.min(Math.max(qx, qy), 0.0);
      return (outside + inside) / Math.max(0.001, h);
    }
    if (shape === ObstacleShape.FlatPlate) {
      const hx = chord * 0.38;
      const hy = chord * 0.045;
      const radius = chord * 0.030;
      const qx = Math.abs(lx) - hx + radius;
      const qy = Math.abs(ly) - hy + radius;
      const outside = Math.sqrt(Math.max(qx, 0.0) * Math.max(qx, 0.0) + Math.max(qy, 0.0) * Math.max(qy, 0.0));
      const inside = Math.min(Math.max(qx, qy), 0.0);
      return (outside + inside - radius) / Math.max(0.001, hy);
    }
    const a = chord * 0.52;
    const b = chord * 0.105;
    const sx = lx / Math.max(0.001, a);
    const sy = ly / Math.max(0.001, b);
    return Math.sqrt(sx * sx + sy * sy) - 1.0;
  }

  private localObstacleNormal(lx: number, ly: number, chord: number, shape: ObstacleShape): { x: number, y: number } {
    const eps = Math.max(0.002, chord * 0.0025);
    const dx = this.localObstacleSdf(lx + eps, ly, chord, shape) - this.localObstacleSdf(lx - eps, ly, chord, shape);
    const dy = this.localObstacleSdf(lx, ly + eps, chord, shape) - this.localObstacleSdf(lx, ly - eps, chord, shape);
    const len = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
    return { x: dx / len, y: dy / len };
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
      Math.floor(this.currentObstacleShape()),
      this.foilChord01.toFixed(3), this.flowSpeed.toFixed(2), this.invertFlowDirection ? "R" : "F",
      Math.floor(this.lineCount), Math.floor(this.lineSegments), this.lineWidth.toFixed(3),
    ].join(":");
  }

  private wrapAngle(a: number): number {
    while (a > Math.PI) a -= Math.PI * 2.0;
    while (a < -Math.PI) a += Math.PI * 2.0;
    return a;
  }

  private wrapHalfAngle(a: number): number {
    a = this.wrapAngle(a);
    if (a > Math.PI * 0.5) a -= Math.PI;
    if (a < -Math.PI * 0.5) a += Math.PI;
    return a;
  }

  private clamp(v: number, a: number, b: number): number {
    return Math.max(a, Math.min(b, v));
  }

  private smoothstep(edge0: number, edge1: number, value: number): number {
    const t = this.clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }
}
