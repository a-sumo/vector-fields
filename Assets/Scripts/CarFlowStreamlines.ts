import { FLOW_PATHS } from "./FlowPaths";

const DEFAULT_TUBE_MATERIAL: Material = requireAsset("../OrientedTubeGlyph.mat") as Material;

// CarFlowStreamlines — slice-local car-flow geometry for the baked field.
// The fast path uses small ribbon glyphs anchored on the current slice. Full
// streamline ribbons and old radial tubes remain as fallbacks/debug modes.
@component
export class CarFlowStreamlines extends BaseScriptComponent {
  @input material: Material;
  @input
  @allowUndefined
  @hint("Separate material for fast car-flow ribbon glyphs. Use a CarFlowRibbonGlyph shader material here.")
  glyphMaterial: Material = DEFAULT_TUBE_MATERIAL;
  @input
  @widget(new ComboBoxWidget([
    new ComboBoxItem("Ribbon Glyphs", 0),
    new ComboBoxItem("Streamline Ribbons", 1),
    new ComboBoxItem("Debug Tubes", 2),
  ]))
  renderMode: number = 0;

  @input('float') planeWidth: number = 24;      // local width the field X-domain maps to
  @input('float') planeHeight: number = 9.27;   // local height the field Y-domain maps to
  @input('float') ribbonWidth: number = 0.10;
  @input('int') tubeColumns: number = 26;
  @input('int') tubeRows: number = 11;
  @input('float') tubeLength: number = 0.52;
  @input('float') tubeRadius: number = 0.055;
  @input('int') tubeRadialSegments: number = 4;
  @input('float') tubeNormalLift: number = 0.045;
  @input('float') phaseSpeed: number = 0.4;
  @input('float') speedScaleRef: number = 1.5;
  @input('float') tubeGlyphPulseStrength: number = 0.0;
  @input('float') tubeGlyphTemporalBend: number = 0.0;
  @input('bool') animateRibbonGlyphs: boolean = false;
  @input
  @widget(new ColorWidget())
  @hint("Constant glyph color used when useSpeedColorMap is off.")
  glyphColor: vec4 = new vec4(0.0, 0.95, 1.0, 1.0);
  @input('bool')
  @hint("Optional diagnostic mode. Off keeps all glyphs a constant color so orientation is the primary cue.")
  useSpeedColorMap: boolean = true;
  @input
  @widget(new ComboBoxWidget([
    new ComboBoxItem("jet", 13),
    new ComboBoxItem("viridis", 17),
    new ComboBoxItem("plasma", 18),
  ]))
  colorMap: number = 18;
  @input('float') colorMapScale: number = 1.0;
  @input('float') colorMapOffset: number = 0.0;

  // slice control — which baked Z-slice's geo is built
  @input('bool') autoScroll: boolean = false;
  @input('float') autoScrollSpeed: number = 0.2;
  @input('bool') driveFromPosition: boolean = true;
  @input('int') axis: number = 2;
  @input('float') travel: number = 3.635;

  private pass: any;
  private rmv: RenderMeshVisual;
  private glyphMaterialInstance: Material | null = null;
  private nz: number = 1;
  private builtSlice: number = -1;          // which slice the current mesh holds
  private home: vec3 = new vec3(0, 0, 0);   // aligned rest position; slide is relative to this
  private readonly smoothSamplesPerSegment: number = 4;

  onAwake(): void {
    this.nz = FLOW_PATHS.NZ;
    this.home = this.getTransform().getLocalPosition();
    this.createScriptApi();

    let rmv = this.sceneObject.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    if (!rmv) rmv = this.sceneObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    this.rmv = rmv;
    this.applyMaterialForMode();

    // build the starting slice so something shows before the first drag
    this.buildSlice(Math.round(0.5 * (this.nz - 1)));
    print("[CarFlowStreamlines] ready, " + this.nz + " slices (geo rebuilt on slice change)");
    this.createEvent('UpdateEvent').bind(() => this.tick());
  }

  private createScriptApi(): void {
    const self = this;
    (this as any).windApi = {
      sampleTubeGlyphField: (x: number, z: number, time?: number) => self.sampleTubeGlyphField(x, z, time),
      getCurrentSlice: () => self.sliceFromControl(),
      getTubeGlyphFieldState: () => self.getTubeGlyphFieldState(),
      getTubeGlyphFieldSignature: () => self.getTubeGlyphFieldSignature(),
      setRenderMode: (mode: number | string) => self.setRenderMode(mode),
      setTubeMode: () => self.setRenderMode(0),
      setRibbonGlyphMode: () => self.setRenderMode(0),
      setRibbonMode: () => self.setRenderMode(1),
      setColorMap: (value: number | string) => self.setColorMap(value),
      setPalette: (value: number | string) => self.setColorMap(value),
      setColorMapScale: (value: number) => self.setColorMapScale(value),
      setGradientScale: (value: number) => self.setColorMapScale(value),
      setColorMapOffset: (value: number) => self.setColorMapOffset(value),
      setGradientOffset: (value: number) => self.setColorMapOffset(value),
      setUseSpeedColorMap: (enabled: boolean) => self.setUseSpeedColorMap(enabled),
      setGlyphColor: (color: vec4) => self.setGlyphColor(color),
      getColorMap: () => self.colorMap,
      getColorMapScale: () => self.colorMapScale,
      getColorMapOffset: () => self.colorMapOffset,
    };
  }

  public setColorMap(value: number | string): void {
    this.colorMap = this.normalizeColorMap(value);
    this.rebuildCurrentSlice();
  }

  public setColorMapScale(value: number): void {
    if (isNaN(value)) return;
    this.colorMapScale = this.clamp(value, -8.0, 8.0);
    this.rebuildCurrentSlice();
  }

  public setColorMapOffset(value: number): void {
    if (isNaN(value)) return;
    this.colorMapOffset = this.clamp(value, -2.0, 2.0);
    this.rebuildCurrentSlice();
  }

  public setUseSpeedColorMap(enabled: boolean): void {
    this.useSpeedColorMap = !!enabled;
    this.rebuildCurrentSlice();
  }

  public setGlyphColor(color: vec4): void {
    if (!color) return;
    this.glyphColor = color;
    this.rebuildCurrentSlice();
  }

  private rebuildCurrentSlice(): void {
    this.builtSlice = -1;
    this.buildSlice(this.sliceFromControl());
  }

  private normalizeColorMap(value: number | string): number {
    if (typeof value === "string") {
      const key = value.toLowerCase();
      if (key.indexOf("jet") >= 0) return 13;
      if (key.indexOf("plasma") >= 0) return 18;
      if (key.indexOf("aero") >= 0 || key.indexOf("cyan") >= 0 || key.indexOf("teal") >= 0) return 19;
      return 17;
    }
    const map = Math.floor(value);
    if (map === 13 || map === 17 || map === 18 || map === 19) return map;
    return 18;
  }

  public setRenderMode(mode: number | string): void {
    if (typeof mode === "string") {
      const key = mode.toLowerCase();
      if (key === "tube" || key === "tubes" || key === "debug_tubes") this.renderMode = 2;
      else if (key === "streamline" || key === "streamlines" || key === "ribbon" || key === "ribbons" || key === "legacy") this.renderMode = 1;
      else this.renderMode = 0;
    } else {
      this.renderMode = Math.max(0, Math.min(2, Math.floor(mode)));
    }
    this.applyMaterialForMode();
    this.builtSlice = -1;
    this.buildSlice(this.sliceFromControl());
  }

  public getTubeGlyphFieldState(): { slice: number, slice01: number, planeWidth: number, planeDepth: number, plane: string, phase: number, phaseSpeed: number } {
    const slice = this.sliceFromControl();
    return {
      slice: slice,
      slice01: this.nz <= 1 ? 0.0 : slice / (this.nz - 1),
      planeWidth: this.planeWidth,
      planeDepth: this.planeHeight,
      plane: "XY",
      phase: getTime() * this.phaseSpeed,
      phaseSpeed: this.phaseSpeed,
    };
  }

  public getTubeGlyphFieldSignature(): string {
    const state = this.getTubeGlyphFieldState();
    return [
      state.slice,
      state.planeWidth.toFixed(2),
      state.planeDepth.toFixed(2),
      this.phaseSpeed.toFixed(3),
      this.speedScaleRef.toFixed(3),
    ].join(":");
  }

  public sampleTubeGlyphField(x: number, z: number, time?: number): { x: number, z: number, speed: number, intensity: number } {
    const D = FLOW_PATHS;
    const k = Math.max(0, Math.min(D.NZ - 1, this.sliceFromControl()));
    return this.sampleSliceVector(k, x, z, time === undefined ? getTime() : time, true);
  }

  private tick(): void {
    this.applyMaterialForMode();
    const k = this.sliceFromControl();
    if (k !== this.builtSlice) this.buildSlice(k);   // update the geo when the slice changes
    if (this.pass) {
      try { this.pass.Time = getTime(); } catch (e) {}
      try { this.pass.PhaseSpeed = this.phaseSpeed; } catch (e) {}
      try { this.pass.PulseStrength = this.animateRibbonGlyphs ? this.tubeGlyphPulseStrength : 0.0; } catch (e) {}
      try { this.pass.TemporalBend = this.animateRibbonGlyphs ? this.tubeGlyphTemporalBend : 0.0; } catch (e) {}
    }
  }

  // Resolve the active slice index from auto-scroll or the draggable position,
  // keeping the object locked to its slide axis through home.
  private sliceFromControl(): number {
    let s = 0.5;
    const half = this.travel * 0.5;
    const h = this.home;
    if (this.autoScroll) {
      const ph = getTime() * this.autoScrollSpeed;
      const c = (Math.abs((ph % 2.0) - 1.0) * 2.0 - 1.0) * half;   // -half..+half
      this.setSlide(h, c);
      s = c / this.travel + 0.5;
    } else if (this.driveFromPosition) {
      const p = this.getTransform().getLocalPosition();
      let c = this.axis === 0 ? p.x - h.x : this.axis === 1 ? p.y - h.y : p.z - h.z;
      c = Math.max(-half, Math.min(half, c));
      this.setSlide(h, c);
      s = c / this.travel + 0.5;
    }
    return Math.max(0, Math.min(this.nz - 1, Math.round(s * (this.nz - 1))));
  }

  // Build geo for ONE slice. The primary path is ribbon glyphs: 4 verts per
  // sample, no caps, no per-frame rebuild, and still aligned to the slice data.
  private buildSlice(k: number): void {
    if (this.isDebugTubeMode()) {
      this.buildTubeSlice(k);
    } else if (this.isStreamlineRibbonMode()) {
      this.buildRibbonSlice(k);
    } else {
      this.buildRibbonGlyphSlice(k);
    }
  }

  private buildRibbonGlyphSlice(k: number): void {
    const cols = Math.max(3, Math.floor(this.tubeColumns));
    const rows = Math.max(3, Math.floor(this.tubeRows));
    const hw = this.planeWidth * 0.5;
    const hh = this.planeHeight * 0.5;
    const mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "normal", components: 3 },
      { name: "texture0", components: 2 },
      { name: "texture1", components: 2 },
      { name: "texture2", components: 2 },
    ]);
    mb.topology = MeshTopology.Triangles;
    mb.indexType = MeshIndexType.UInt16;

    const spacing = Math.min(this.planeWidth / Math.max(1, cols - 1), this.planeHeight / Math.max(1, rows - 1));
    const length = Math.max(0.08, Math.min(this.tubeLength, spacing * 0.88));
    const width = Math.max(0.018, Math.min(this.tubeRadius * 1.6, spacing * 0.22));
    const time = getTime();
    let glyphCount = 0;

    for (let row = 0; row < rows; row++) {
      const y = rows === 1 ? 0.0 : -hh + (row / (rows - 1)) * this.planeHeight;
      for (let col = 0; col < cols; col++) {
        const x = cols === 1 ? 0.0 : -hw + (col / (cols - 1)) * this.planeWidth;
        const sample = this.sampleSliceVector(k, x, y, time, false);
        if (sample.speed < 0.018) continue;
        const waveCoord = (col / Math.max(1, cols - 1)) * 2.4 + (row / Math.max(1, rows - 1)) * 0.55;
        const dirX = sample.x / sample.speed;
        const dirY = sample.z / sample.speed;
        const len = length * this.clamp(0.74 + sample.intensity * 0.42, 0.64, 1.22);
        const color = this.colorForValue(sample.intensity);
        this.appendXYRibbonGlyph(mb, x, y, dirX, dirY, len, width, color, waveCoord);
        glyphCount++;
      }
    }

    if (glyphCount > 0) {
      mb.updateMesh();
      this.rmv.mesh = mb.getMesh();
      try { this.rmv.renderOrder = 690; } catch (e) {}
      this.rmv.enabled = true;
    } else {
      print("[CarFlowStreamlines] ribbon glyph slice " + k + " produced no visible glyphs; falling back to streamline ribbons");
      this.buildRibbonSlice(k);
      return;
    }
    this.builtSlice = k;
  }

  private buildRibbonSlice(k: number): void {
    const D = FLOW_PATHS;
    const N = D.N;
    const X0 = D.X0, X1 = D.X1, Y0 = D.Y0, Y1 = D.Y1;
    const mapX = (x: number) => ((x - X0) / (X1 - X0)) * this.planeWidth - this.planeWidth * 0.5;
    const mapY = (y: number) => ((y - Y0) / (Y1 - Y0)) * this.planeHeight - this.planeHeight * 0.5;

    const mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "texture0", components: 2 },   // (pathT, templatePhase)
      { name: "texture1", components: 2 },   // (speedColor, _)
      { name: "texture2", components: 2 },   // (crossSection, _)
    ]);
    mb.topology = MeshTopology.Triangles;
    mb.indexType = MeshIndexType.UInt16;

    const w = Math.max(0.025, this.ribbonWidth * 0.74);
    const sref = this.speedScaleRef;
    const verts: number[] = [];
    const idx: number[] = [];
    let vbase = 0;
    const slice = D.slices[k];
    for (let t = 0; t < N; t++) {
      const ln = slice[t]; const xs = ln.x, ys = ln.y, sp = ln.sp;
      const phase = (t * 0.6180339887) % 1.0;
      const smooth = this.smoothPath(xs, ys, sp, mapX, mapY);
      if (smooth.x.length < 2) continue;
      const ringStart = vbase;
      for (let i = 0; i < smooth.x.length; i++) {
        const px = smooth.x[i], py = smooth.y[i];
        const i0 = Math.max(0, i - 1), i1 = Math.min(smooth.x.length - 1, i + 1);
        let tx = smooth.x[i1] - smooth.x[i0], ty = smooth.y[i1] - smooth.y[i0];
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const nx = -ty, ny = tx;
        const pt = smooth.t[i];
        const sc = Math.min(1, smooth.speed[i] / sref);
        verts.push(px - nx * w, py - ny * w, 0, pt, phase, sc, 0, -1, 0);
        verts.push(px + nx * w, py + ny * w, 0, pt, phase, sc, 0, 1, 0);
        vbase += 2;
      }
      for (let i = 0; i < smooth.x.length - 1; i++) {
        const a = ringStart + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    mb.appendVerticesInterleaved(verts);
    mb.appendIndices(idx);
    mb.updateMesh();
    this.rmv.mesh = mb.getMesh();
    this.builtSlice = k;
  }

  private buildTubeSlice(k: number): void {
    const D = FLOW_PATHS;
    const cols = Math.max(3, Math.floor(this.tubeColumns));
    const rows = Math.max(3, Math.floor(this.tubeRows));
    const hw = this.planeWidth * 0.5;
    const hh = this.planeHeight * 0.5;
    const mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "normal", components: 3 },
      { name: "texture0", components: 2 },
      { name: "texture1", components: 2 },
      { name: "texture2", components: 2 },
    ]);
    mb.topology = MeshTopology.Triangles;
    mb.indexType = MeshIndexType.UInt16;

    const spacing = Math.min(this.planeWidth / Math.max(1, cols - 1), this.planeHeight / Math.max(1, rows - 1));
    const baseLength = Math.max(0.05, Math.min(this.tubeLength, spacing * 0.82));
    const radius = Math.max(0.006, Math.min(this.tubeRadius, spacing * 0.18));
    const time = getTime();

    for (let row = 0; row < rows; row++) {
      const y = rows === 1 ? 0.0 : -hh + (row / (rows - 1)) * this.planeHeight;
      for (let col = 0; col < cols; col++) {
        const x = cols === 1 ? 0.0 : -hw + (col / (cols - 1)) * this.planeWidth;
        const sample = this.sampleSliceVector(k, x, y, time, true);
        if (sample.speed < 0.01) continue;
        const len = baseLength * this.clamp(0.64 + sample.intensity * 0.46, 0.58, 1.18);
        const color = this.colorForValue(sample.intensity);
        this.appendXYTube(mb, x, y, sample.x / sample.speed, sample.z / sample.speed, len, radius, color);
      }
    }

    mb.updateMesh();
    this.rmv.mesh = mb.getMesh();
    this.builtSlice = k;
  }

  private sampleSliceVector(k: number, x: number, y: number, time: number, animated: boolean): { x: number, z: number, speed: number, intensity: number } {
    const D = FLOW_PATHS;
    const X0 = D.X0, X1 = D.X1, Y0 = D.Y0, Y1 = D.Y1;
    const mapX = (vx: number) => ((vx - X0) / (X1 - X0)) * this.planeWidth - this.planeWidth * 0.5;
    const mapY = (vy: number) => ((vy - Y0) / (Y1 - Y0)) * this.planeHeight - this.planeHeight * 0.5;
    const slice = D.slices[Math.max(0, Math.min(D.NZ - 1, k))];
    let bestDist = 999999.0;
    let bestDx = 1.0;
    let bestDy = 0.0;
    let bestSpeed = 0.0;
    let bestPathT = 0.0;
    let bestPhase = 0.0;

    for (let lineIndex = 0; lineIndex < D.N; lineIndex++) {
      const ln = slice[lineIndex];
      const xs = ln.x, ys = ln.y, sp = ln.sp;
      const templatePhase = (lineIndex * 0.6180339887) % 1.0;
      const stride = animated ? 1 : 2;
      for (let i = 0; i < xs.length; i += stride) {
        const px = mapX(xs[i]);
        const py = mapY(ys[i]);
        const dxp = px - x;
        const dyp = py - y;
        const d2 = dxp * dxp + dyp * dyp;
        if (d2 < bestDist) {
          const i0 = Math.max(0, i - stride);
          const i1 = Math.min(xs.length - 1, i + stride);
          let tx = mapX(xs[i1]) - mapX(xs[i0]);
          let ty = mapY(ys[i1]) - mapY(ys[i0]);
          const tl = Math.hypot(tx, ty) || 1.0;
          tx /= tl;
          ty /= tl;
          bestDist = d2;
          bestDx = tx;
          bestDy = ty;
          bestSpeed = sp[i];
          bestPathT = i / Math.max(1, xs.length - 1);
          bestPhase = templatePhase;
        }
      }
    }

    let gain = 1.0;
    let bend = 0.0;
    if (animated) {
      const phase = this.fract(time * this.phaseSpeed + bestPhase);
      const pf = 1.0 - this.clamp(bestPathT, 0.0, 1.0);
      const band = this.fract(pf * 3.15 - phase + 1.0);
      const bandDist = Math.abs(band - 0.5) * 2.0;
      const pulse = 1.0 - this.smoothstepRange(0.10, 0.92, bandDist);
      const glint = 1.0 - this.smoothstepRange(0.00, 0.20, bandDist);
      gain = 1.0 + (pulse * 0.72 + glint * 0.28) * Math.max(0.0, this.tubeGlyphPulseStrength);
      bend = (pulse - 0.5) * this.tubeGlyphTemporalBend;
    }

    const nx = -bestDy;
    const ny = bestDx;
    const vx = bestDx + nx * bend;
    const vy = bestDy + ny * bend;
    const vl = Math.hypot(vx, vy) || 1.0;
    const speed = Math.max(0.001, bestSpeed * gain);
    const intensity = this.clamp(speed / Math.max(0.001, this.speedScaleRef), 0.0, 1.0);
    return { x: (vx / vl) * speed, z: (vy / vl) * speed, speed: speed, intensity: intensity };
  }

  private appendXYTube(mb: MeshBuilder, x: number, y: number, dx: number, dy: number, length: number, radius: number, color: vec4): void {
    const radial = Math.max(4, Math.min(16, Math.floor(this.tubeRadialSegments)));
    const start = mb.getVerticesCount();
    const px = -dy;
    const py = dx;
    const half = length * 0.5;
    const ax = x - dx * half;
    const ay = y - dy * half;
    const bx = x + dx * half;
    const by = y + dy * half;

    for (let ring = 0; ring < 2; ring++) {
      const cx = ring === 0 ? ax : bx;
      const cy = ring === 0 ? ay : by;
      const v = ring;
      for (let i = 0; i < radial; i++) {
        const a = (i / radial) * Math.PI * 2.0;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const planeOffset = ca * radius;
        const normalOffset = sa * radius;
        mb.appendVerticesInterleaved([
          cx + px * planeOffset,
          cy + py * planeOffset,
          this.tubeNormalLift + normalOffset,
          px * ca,
          py * ca,
          sa,
          i / radial, v,
          color.x, color.y,
          color.z, color.w,
        ]);
      }
    }

    for (let i = 0; i < radial; i++) {
      const a = start + i;
      const b = start + ((i + 1) % radial);
      const c = start + radial + i;
      const d = start + radial + ((i + 1) % radial);
      mb.appendIndices([a, b, c, b, d, c]);
    }

    const capA = mb.getVerticesCount();
    mb.appendVerticesInterleaved([ax, ay, this.tubeNormalLift, -dx, -dy, 0.0, 0.5, 0.0, color.x, color.y, color.z, color.w]);
    const capB = mb.getVerticesCount();
    mb.appendVerticesInterleaved([bx, by, this.tubeNormalLift, dx, dy, 0.0, 0.5, 1.0, color.x, color.y, color.z, color.w]);
    for (let i = 0; i < radial; i++) {
      const a = start + i;
      const b = start + ((i + 1) % radial);
      const c = start + radial + i;
      const d = start + radial + ((i + 1) % radial);
      mb.appendIndices([capA, a, b, capB, d, c]);
    }
  }

  private appendXYRibbonGlyph(mb: MeshBuilder, x: number, y: number, dx: number, dy: number, length: number, width: number, color: vec4, phase: number): void {
    const px = -dy;
    const py = dx;
    const halfLength = length * 0.5;
    const halfWidth = width * 0.5;
    const ax = x - dx * halfLength;
    const ay = y - dy * halfLength;
    const bx = x + dx * halfLength;
    const by = y + dy * halfLength;
    const z = Math.max(this.tubeNormalLift, 0.10);
    const start = mb.getVerticesCount();
    const nx = 0.0, ny = 0.0, nz = 1.0;

    mb.appendVerticesInterleaved([
      ax - px * halfWidth, ay - py * halfWidth, z, nx, ny, nz, 0.0, phase, color.x, color.y, color.z, color.w,
      ax + px * halfWidth, ay + py * halfWidth, z, nx, ny, nz, 0.0, phase, color.x, color.y, color.z, color.w,
      bx - px * halfWidth, by - py * halfWidth, z, nx, ny, nz, 1.0, phase, color.x, color.y, color.z, color.w,
      bx + px * halfWidth, by + py * halfWidth, z, nx, ny, nz, 1.0, phase, color.x, color.y, color.z, color.w,
    ]);
    mb.appendIndices([start, start + 1, start + 2, start + 1, start + 3, start + 2]);
  }

  private colorForValue(value: number): vec4 {
    if (!this.useSpeedColorMap) {
      return new vec4(
        this.clamp(this.glyphColor.x, 0.0, 1.0),
        this.clamp(this.glyphColor.y, 0.0, 1.0),
        this.clamp(this.glyphColor.z, 0.0, 1.0),
        this.clamp(this.glyphColor.w, 0.0, 1.0)
      );
    }
    const scale = Math.abs(this.colorMapScale) < 0.0001 ? 1.0 : this.colorMapScale;
    const t = this.clamp(value * scale + this.colorMapOffset, 0.0, 1.0);
    const rgb = this.boostColor(this.sampleColorMap(t));
    return new vec4(rgb.x, rgb.y, rgb.z, 1.0);
  }

  private sampleColorMap(t: number): vec3 {
    const map = Math.floor(this.colorMap);
    if (map === 13) return this.mapJet(t);
    if (map === 18) return this.mapPlasma(t);
    if (map === 19) return this.mapAeroCyan(t);
    return this.mapViridis(t);
  }

  private mapJet(t: number): vec3 {
    const x = this.clamp(t, 0.0, 1.0);
    return new vec3(
      this.clamp(1.5 - Math.abs(4.0 * x - 3.0), 0.0, 1.0),
      this.clamp(1.5 - Math.abs(4.0 * x - 2.0), 0.0, 1.0),
      this.clamp(1.5 - Math.abs(4.0 * x - 1.0), 0.0, 1.0)
    );
  }

  private mapViridis(t: number): vec3 {
    return this.stops5(
      t,
      new vec3(0.27, 0.01, 0.33),
      new vec3(0.23, 0.32, 0.55),
      new vec3(0.13, 0.57, 0.55),
      new vec3(0.37, 0.79, 0.38),
      new vec3(0.99, 0.91, 0.15)
    );
  }

  private mapPlasma(t: number): vec3 {
    return this.stops7(
      t,
      new vec3(0.05, 0.03, 0.53),
      new vec3(0.23, 0.06, 0.50),
      new vec3(0.42, 0.00, 0.66),
      new vec3(0.70, 0.16, 0.56),
      new vec3(0.88, 0.39, 0.38),
      new vec3(0.99, 0.65, 0.21),
      new vec3(0.94, 0.98, 0.13)
    );
  }

  private mapAeroCyan(t: number): vec3 {
    return this.stops5(
      t,
      new vec3(0.03, 0.12, 0.30),
      new vec3(0.00, 0.42, 0.78),
      new vec3(0.00, 0.86, 0.94),
      new vec3(0.46, 1.00, 0.86),
      new vec3(1.00, 1.00, 1.00)
    );
  }

  private stops5(t: number, c0: vec3, c1: vec3, c2: vec3, c3: vec3, c4: vec3): vec3 {
    const x = this.clamp(t, 0.0, 1.0);
    if (x < 0.25) return this.mixVec3(c0, c1, this.smoothstep((x - 0.0) / 0.25));
    if (x < 0.50) return this.mixVec3(c1, c2, this.smoothstep((x - 0.25) / 0.25));
    if (x < 0.75) return this.mixVec3(c2, c3, this.smoothstep((x - 0.50) / 0.25));
    return this.mixVec3(c3, c4, this.smoothstep((x - 0.75) / 0.25));
  }

  private stops7(t: number, c0: vec3, c1: vec3, c2: vec3, c3: vec3, c4: vec3, c5: vec3, c6: vec3): vec3 {
    const x = this.clamp(t, 0.0, 1.0);
    const step = 1.0 / 6.0;
    if (x < step) return this.mixVec3(c0, c1, this.smoothstep(x / step));
    if (x < step * 2.0) return this.mixVec3(c1, c2, this.smoothstep((x - step) / step));
    if (x < step * 3.0) return this.mixVec3(c2, c3, this.smoothstep((x - step * 2.0) / step));
    if (x < step * 4.0) return this.mixVec3(c3, c4, this.smoothstep((x - step * 3.0) / step));
    if (x < step * 5.0) return this.mixVec3(c4, c5, this.smoothstep((x - step * 4.0) / step));
    return this.mixVec3(c5, c6, this.smoothstep((x - step * 5.0) / step));
  }

  private boostColor(color: vec3): vec3 {
    const luma = color.x * 0.299 + color.y * 0.587 + color.z * 0.114;
    return new vec3(
      this.clamp((luma + (color.x - luma) * 1.22) * 1.18 + 0.055, 0.0, 1.0),
      this.clamp((luma + (color.y - luma) * 1.22) * 1.18 + 0.055, 0.0, 1.0),
      this.clamp((luma + (color.z - luma) * 1.22) * 1.18 + 0.055, 0.0, 1.0)
    );
  }

  private mixVec3(a: vec3, b: vec3, t: number): vec3 {
    return new vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  }

  private applyMaterialForMode(): void {
    if (!this.rmv) return;
    const desired = this.isGlyphMaterialMode() ? this.getGlyphMaterialInstance() : this.material;
    if (desired && this.rmv.mainMaterial !== desired) {
      this.rmv.mainMaterial = desired;
      this.pass = desired.mainPass as any;
    } else if (desired) {
      this.pass = desired.mainPass as any;
    }
    if (this.pass) {
      const glyphMode = this.isGlyphMaterialMode();
      try { this.pass.depthTest = !glyphMode; } catch (e) {}
      try { this.pass.DepthTest = !glyphMode; } catch (e) {}
      try { this.pass.depthWrite = false; } catch (e) {}
      try { this.pass.DepthWrite = false; } catch (e) {}
      try { this.pass.twoSided = true; } catch (e) {}
      try { this.pass.TwoSided = true; } catch (e) {}
      try { this.pass.blendMode = BlendMode.PremultipliedAlphaAuto; } catch (e) {}
      try { this.pass.BlendMode = BlendMode.PremultipliedAlphaAuto; } catch (e) {}
    }
  }

  private getGlyphMaterialInstance(): Material {
    if (!this.glyphMaterialInstance) {
      const source = this.glyphMaterial || DEFAULT_TUBE_MATERIAL;
      try {
        this.glyphMaterialInstance = source.clone();
      } catch (e) {
        this.glyphMaterialInstance = source;
      }
    }
    return this.glyphMaterialInstance;
  }

  private isStreamlineRibbonMode(): boolean {
    return Math.floor(this.renderMode) === 1;
  }

  private isDebugTubeMode(): boolean {
    return Math.floor(this.renderMode) === 2;
  }

  private isRibbonGlyphMode(): boolean {
    return Math.floor(this.renderMode) === 0;
  }

  private isGlyphMaterialMode(): boolean {
    return this.isRibbonGlyphMode() || this.isDebugTubeMode();
  }

  private smoothPath(
    xs: number[],
    ys: number[],
    speeds: number[],
    mapX: (x: number) => number,
    mapY: (y: number) => number
  ): { x: number[], y: number[], speed: number[], t: number[] } {
    const n = xs.length;
    const outX: number[] = [];
    const outY: number[] = [];
    const outSpeed: number[] = [];
    const samples = Math.max(1, Math.floor(this.smoothSamplesPerSegment));

    const px = (i: number) => mapX(xs[Math.max(0, Math.min(n - 1, i))]);
    const py = (i: number) => mapY(ys[Math.max(0, Math.min(n - 1, i))]);
    const ps = (i: number) => speeds[Math.max(0, Math.min(n - 1, i))];

    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < samples; s++) {
        const u = s / samples;
        outX.push(this.catmull(px(i - 1), px(i), px(i + 1), px(i + 2), u));
        outY.push(this.catmull(py(i - 1), py(i), py(i + 1), py(i + 2), u));
        outSpeed.push(this.lerp(ps(i), ps(i + 1), this.smoothstep(u)));
      }
    }
    outX.push(px(n - 1));
    outY.push(py(n - 1));
    outSpeed.push(ps(n - 1));

    const outT: number[] = [];
    let total = 0.0;
    outT[0] = 0.0;
    for (let i = 1; i < outX.length; i++) {
      total += Math.hypot(outX[i] - outX[i - 1], outY[i] - outY[i - 1]);
      outT[i] = total;
    }
    if (total > 0.0001) {
      for (let i = 0; i < outT.length; i++) outT[i] /= total;
    }
    return { x: outX, y: outY, speed: outSpeed, t: outT };
  }

  private catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2.0 * p1) +
      (-p0 + p2) * t +
      (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
      (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
    );
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private smoothstep(t: number): number {
    const x = Math.max(0.0, Math.min(1.0, t));
    return x * x * (3.0 - 2.0 * x);
  }

  private smoothstepRange(edge0: number, edge1: number, value: number): number {
    const denom = Math.max(0.0001, edge1 - edge0);
    return this.smoothstep((value - edge0) / denom);
  }

  private fract(value: number): number {
    return value - Math.floor(value);
  }

  private clamp(value: number, minValue: number, maxValue: number): number {
    return Math.max(minValue, Math.min(maxValue, value));
  }

  private setSlide(h: vec3, c: number): void {
    this.getTransform().setLocalPosition(new vec3(
      h.x + (this.axis === 0 ? c : 0),
      h.y + (this.axis === 1 ? c : 0),
      h.z + (this.axis === 2 ? c : 0)));
  }
}
