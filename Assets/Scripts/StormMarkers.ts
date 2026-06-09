// Spawns markers at every active tropical cyclone in StormsData.ts. Markers
// are positioned via the WindGlobeCalibration's latLonToWorld helper, then
// pulsed in scale via a sin wave for visibility.
//
// Setup:
//   - calibrationObject: the Globe Calibration SceneObject.
//   - markerPrefab (optional): a prefab spawned per storm. If empty, the
//     script creates a small unlit sphere child instead.
//   - markerScale: base local scale for each marker.

import { STORMS, STORMS_FETCHED_AT, Storm } from "./StormsData";

const DEFAULT_STORM_MARKER_MATERIAL: Material = requireAsset("../Materials/FlatMaterial 2.mat") as Material;

@component
export class StormMarkers extends BaseScriptComponent {
  @input
  @hint("Globe Calibration SceneObject (its WindGlobeCalibration script is read).")
  calibrationObject!: SceneObject;

  @input
  @allowUndefined
  @hint("Optional prefab to instantiate per storm. Leave empty to use auto sphere markers.")
  markerPrefab: ObjectPrefab | null = null;

  @input
  @allowUndefined
  @hint("Optional template SceneObject — duplicated per storm if no prefab is supplied.")
  markerTemplate: SceneObject | null = null;

  @input
  markerScale: number = 0.8;

  @input('int')
  @hint("Generated marker sphere horizontal segments.")
  markerSegments: number = 24;

  @input('int')
  @hint("Generated marker sphere vertical rings.")
  markerRings: number = 14;

  @input
  @allowUndefined
  @hint("Flat material for generated/selectable storm markers.")
  markerMaterial: Material = DEFAULT_STORM_MARKER_MATERIAL;

  @input
  @widget(new ColorWidget())
  @hint("Marker color for unselected weather events.")
  markerColor: vec4 = new vec4(0.15, 0.95, 1.0, 0.9);

  @input
  @widget(new ColorWidget())
  @hint("Theme fallback color for the selected weather event when wind speed is unavailable.")
  selectedMarkerColor: vec4 = new vec4(0.24, 0.70, 1.0, 1.0);

  @input
  @hint("Color selected markers from the same wind-speed scale used by the legend.")
  useWindSpeedPalette: boolean = true;

  @input
  @widget(new SliderWidget(1.0, 3.0, 0.05))
  @hint("Scale multiplier for the selected marker.")
  selectedScaleMultiplier: number = 1.85;

  @input
  @hint("Multiplier on the pulse amplitude. 0 = static, 1 = breathing.")
  pulseAmount: number = 0.35;

  @input
  @hint("Pulse frequency in Hz.")
  pulseHz: number = 1.4;

  @input
  @widget(new SliderWidget(0.0, 2.0, 0.05))
  @hint("Tiny outward lift from the globe surface, in cm. Keep low so the marker remains on the storm location.")
  surfaceLiftCm: number = 0.0;

  private cal: any = null;
  private markers: { obj: SceneObject; storm: Storm; baseScale: vec3; visual: RenderMeshVisual | null; material: Material | null }[] = [];
  private selectedIndex: number = -1;

  onAwake() {
    this.createScriptApi();
    this.createEvent("OnStartEvent").bind(() => this.init());
    this.createEvent("UpdateEvent").bind(() => this.tick());
  }

  private createScriptApi(): void {
    const self = this;
    const api = {
      selectWeatherEvent: (index: number) => self.selectWeatherEvent(index),
      selectStormIndex: (index: number) => self.selectWeatherEvent(index),
      clearWeatherEventSelection: () => self.clearWeatherEventSelection(),
      getSelectedStormIndex: () => self.selectedIndex,
    };
    (this as any).stormMarkersApi = api;
    (this as any).weatherEventsApi = api;
  }

  public selectWeatherEvent(index: number): boolean {
    if (index < 0 || index >= this.markers.length) return false;
    this.selectedIndex = Math.floor(index);
    this.applyMarkerStyles();
    return true;
  }

  public clearWeatherEventSelection(): void {
    this.selectedIndex = -1;
    this.applyMarkerStyles();
  }

  private init() {
    if (!this.calibrationObject) {
      print("[StormMarkers] missing calibrationObject");
      return;
    }
    const comps = this.calibrationObject.getComponents("Component.ScriptComponent") as ScriptComponent[];
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i] as any;
      if (typeof c.latLonToWorld === "function") { this.cal = c; break; }
    }
    if (!this.cal) {
      print("[StormMarkers] No WindGlobeCalibration found.");
      return;
    }

    print(`[StormMarkers] ${STORMS.length} storms (data fetched ${STORMS_FETCHED_AT})`);
    for (let i = 0; i < STORMS.length; i++) this.spawnMarker(STORMS[i], i);
    this.applyMarkerStyles();
  }

  private spawnMarker(s: Storm, index: number) {
    if (s.lat === null || s.lon === null || isNaN(s.lat) || isNaN(s.lon)) {
      print(`[StormMarkers] ${s.name} has no valid coordinate — skipping marker.`);
      return;
    }
    let obj: SceneObject | null = null;
    let visual: RenderMeshVisual | null = null;
    let material: Material | null = null;
    if (this.markerPrefab) {
      obj = this.markerPrefab.instantiate(this.sceneObject);
    } else if (this.markerTemplate) {
      // A raw SceneObject cannot be cloned through script. Use it as the first
      // marker only; generated markers cover additional simultaneous events.
      obj = index === 0 ? this.markerTemplate : null;
    }
    if (!obj) {
      obj = this.createGeneratedMarker(index);
    }
    obj.name = `Storm · ${s.name}`;
    visual = obj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    if (!visual) visual = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    if (!this.markerPrefab || !visual.mesh) {
      const mb = this.buildMarkerMesh();
      visual.mesh = mb.getMesh();
      mb.updateMesh();
    }
    material = visual.mainMaterial;
    if (!material) {
      material = this.cloneMarkerMaterial();
      if (material) visual.mainMaterial = material;
    }
    try { visual.renderOrder = 690 + index; } catch (e) {}
    const t = obj.getTransform();
    const baseScale = new vec3(this.markerScale, this.markerScale, this.markerScale);
    t.setLocalScale(baseScale);

    const marker = { obj, storm: s, baseScale, visual, material };
    this.placeMarker(marker);
    this.markers.push(marker);
  }

  private tick() {
    if (this.markers.length === 0) return;
    const t = getTime();
    const phase = t * this.pulseHz * 2 * Math.PI;
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i];
      this.placeMarker(m);
      const selected = i === this.selectedIndex;
      const basePulse = selected ? Math.max(this.pulseAmount, 0.22) : this.pulseAmount * 0.45;
      const selectedScale = selected ? this.selectedScaleMultiplier : 1.0;
      const f = selectedScale * (1 + basePulse * Math.sin(phase + i));
      m.obj.getTransform().setLocalScale(new vec3(
        m.baseScale.x * f,
        m.baseScale.y * f,
        m.baseScale.z * f,
      ));
    }
  }

  private placeMarker(m: { obj: SceneObject; storm: Storm; baseScale: vec3; visual: RenderMeshVisual | null; material: Material | null }) {
    if (!this.cal || typeof this.cal.latLonToWorld !== "function") return;
    if (m.storm.lat === null || m.storm.lon === null || isNaN(m.storm.lat) || isNaN(m.storm.lon)) return;
    const world = this.cal.latLonToWorld(m.storm.lat, m.storm.lon) as vec3;
    let placed = world;
    const idx = this.markerIndex(m);
    const extraLift = idx === this.selectedIndex ? 0.45 : 0.0;
    if ((this.surfaceLiftCm > 0 || extraLift > 0) && this.cal.earthSphere) {
      const center = this.cal.earthSphere.getTransform().getWorldPosition() as vec3;
      const normal = world.sub(center);
      const len = normal.length;
      if (len > 0.0001) placed = world.add(normal.uniformScale((this.surfaceLiftCm + extraLift) / len));
    }
    m.obj.getTransform().setWorldPosition(placed);
  }

  private markerIndex(marker: { obj: SceneObject }): number {
    for (let i = 0; i < this.markers.length; i++) {
      if (this.markers[i].obj === marker.obj) return i;
    }
    return -1;
  }

  private applyMarkerStyles(): void {
    for (let i = 0; i < this.markers.length; i++) {
      const marker = this.markers[i];
      const selected = i === this.selectedIndex;
      const color = selected ? this.selectedColorForStorm(marker.storm) : this.markerColor;
      this.applyMaterialColor(marker.material, color);
      if (marker.visual) {
        try { marker.visual.renderOrder = selected ? 720 : 690 + i; } catch (e) {}
      }
      marker.obj.enabled = true;
    }
  }

  private createGeneratedMarker(index: number): SceneObject {
    const obj = global.scene.createSceneObject(`StormMarker_${index}`);
    obj.setParent(this.sceneObject);
    const visual = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    const mb = this.buildMarkerMesh();
    visual.mesh = mb.getMesh();
    mb.updateMesh();
    const material = this.cloneMarkerMaterial();
    if (material) visual.mainMaterial = material;
    return obj;
  }

  private cloneMarkerMaterial(): Material | null {
    const source = this.markerMaterial || DEFAULT_STORM_MARKER_MATERIAL;
    if (!source) return null;
    try {
      return (source as any).clone() as Material;
    } catch (e) {
      return source;
    }
  }

  private applyMaterialColor(material: Material | null, color: vec4): void {
    if (!material) return;
    const pass = material.mainPass as any;
    if (!pass) return;
    try { pass.FlatColor = color; } catch (e) {}
    try { pass.BaseColor = color; } catch (e) {}
    try { pass.baseColor = color; } catch (e) {}
    try { pass.Port_FlatColor_N000 = color; } catch (e) {}
    try { pass.Opacity = color.w; } catch (e) {}
    try { pass.opacity = color.w; } catch (e) {}
    try { pass.blendMode = BlendMode.PremultipliedAlphaAuto; } catch (e) {}
    try { pass.BlendMode = BlendMode.PremultipliedAlphaAuto; } catch (e) {}
    try { pass.DepthWrite = false; } catch (e) {}
    try { pass.depthWrite = false; } catch (e) {}
  }

  private selectedColorForStorm(storm: Storm): vec4 {
    if (!this.useWindSpeedPalette) return this.selectedMarkerColor;
    const speed = this.stormSpeedMps(storm);
    if (speed < 0.0) return this.selectedMarkerColor;
    return this.windSpeedPalette(speed);
  }

  private stormSpeedMps(storm: Storm): number {
    if (storm.windMps !== null && storm.windMps !== undefined && !isNaN(storm.windMps)) return storm.windMps;
    if (storm.windKmh !== null && storm.windKmh !== undefined && !isNaN(storm.windKmh)) return storm.windKmh / 3.6;
    return -1.0;
  }

  private windSpeedPalette(speedMps: number): vec4 {
    // Matches the visible legend thresholds: 0, 10, 20, 33, 45, 70+ m/s.
    const stops = [0.0, 10.0, 20.0, 33.0, 45.0, 70.0];
    const colors = [
      new vec4(0.16, 0.62, 1.0, 1.0),  // blue
      new vec4(0.00, 0.95, 1.0, 1.0),  // cyan
      new vec4(0.20, 1.00, 0.45, 1.0), // green
      new vec4(1.00, 0.92, 0.20, 1.0), // yellow
      new vec4(1.00, 0.45, 0.12, 1.0), // orange
      new vec4(1.00, 0.08, 0.22, 1.0), // red
    ];
    if (speedMps <= stops[0]) return colors[0];
    for (let i = 1; i < stops.length; i++) {
      if (speedMps <= stops[i]) {
        const t = (speedMps - stops[i - 1]) / Math.max(0.001, stops[i] - stops[i - 1]);
        return this.mixColor(colors[i - 1], colors[i], t);
      }
    }
    return new vec4(1.0, 0.0, 0.55, 1.0);
  }

  private mixColor(a: vec4, b: vec4, t: number): vec4 {
    const u = Math.max(0.0, Math.min(1.0, t));
    return new vec4(
      a.x + (b.x - a.x) * u,
      a.y + (b.y - a.y) * u,
      a.z + (b.z - a.z) * u,
      a.w + (b.w - a.w) * u
    );
  }

  private buildMarkerMesh(): MeshBuilder {
    const mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "normal", components: 3 },
      { name: "texture0", components: 2 },
    ]);
    mb.topology = MeshTopology.Triangles;
    mb.indexType = MeshIndexType.UInt16;
    this.addSphere(
      mb,
      0.5,
      Math.max(8, Math.min(48, Math.floor(this.markerSegments))),
      Math.max(4, Math.min(32, Math.floor(this.markerRings)))
    );
    return mb;
  }

  private addSphere(mb: MeshBuilder, radius: number, segments: number, rings: number): void {
    const start = mb.getVerticesCount();
    for (let r = 0; r <= rings; r++) {
      const v = r / rings;
      const phi = -Math.PI * 0.5 + v * Math.PI;
      const y = Math.sin(phi) * radius;
      const rr = Math.cos(phi) * radius;
      for (let s = 0; s <= segments; s++) {
        const u = s / segments;
        const theta = u * Math.PI * 2.0;
        const x = Math.cos(theta) * rr;
        const z = Math.sin(theta) * rr;
        const normal = new vec3(x, y, z).normalize();
        mb.appendVerticesInterleaved([x, y, z, normal.x, normal.y, normal.z, u, v]);
      }
    }
    const row = segments + 1;
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segments; s++) {
        const i0 = start + r * row + s;
        const i1 = i0 + 1;
        const i2 = i0 + row;
        const i3 = i2 + 1;
        mb.appendIndices([i0, i2, i1, i1, i2, i3]);
      }
    }
  }
}
