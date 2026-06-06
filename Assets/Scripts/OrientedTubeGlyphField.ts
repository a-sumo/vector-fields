// OrientedTubeGlyphField.ts
// ----------------------------------------------------------------------
// A 2D vector-field visualization made from small tubes that rotate in place.
//
// Unlike particle trails, each glyph is anchored to a grid sample. On every
// refresh the tube rotates to align with F(x, z), so it can sit cleanly on top
// of planes such as gravity slices, wind maps, or analytical field panels.

type TubeGlyphPresetId = "expansion" | "contraction" | "curl" | "saddle" | "uniform";

type FieldVector2 = {
    x: number;
    z: number;
    intensity?: number;
    speed?: number;
};

type GlyphSample = {
    x: number;
    z: number;
    phase: number;
};

type TubeColor = {
    r: number;
    g: number;
    b: number;
    a: number;
};

const DEFAULT_MATERIAL: Material = requireAsset("../Materials/FlatMaterial.mat") as Material;
const TWO_PI = Math.PI * 2.0;

@component
export class OrientedTubeGlyphField extends BaseScriptComponent {
    @input
    @allowUndefined
    @hint("Optional material. Use an OrientedTubeGlyph material for per-tube flat palette colors.")
    material: Material = null as any;

    @input
    @allowUndefined
    @hint("Optional source object exposing sampleTubeGlyphField(x,z,time), such as GravityField.gravityApi or CarFlowStreamlines.windApi.")
    fieldSourceObject: SceneObject = null as any;

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Analytical", 0),
        new ComboBoxItem("Gravity Source", 1),
        new ComboBoxItem("Car Wind Source", 2),
    ]))
    @hint("Analytical uses the local animated presets. Source modes sample a sibling GravityField or CarFlowStreamlines API.")
    fieldSourceMode: number = 0;

    @input
    @hint("When a source exposes planeWidth/planeDepth, keep this glyph grid aligned to that source.")
    syncLayoutFromSource: boolean = true;

    @input
    @hint("When a source object is provided, copy its world position/rotation/scale so this is a true alternate renderer for the same slice.")
    syncTransformFromSource: boolean = true;

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("X/Z plane", 0),
        new ComboBoxItem("X/Y plane", 1),
    ]))
    @hint("Geometry plane. Gravity/analytical fields use X/Z. Car-flow slices use X/Y.")
    dataPlane: number = 0;

    @input
    @widget(new SliderWidget(-1.0, 1.0, 0.005))
    @hint("Small offset along the plane normal to avoid z-fighting with the source slice.")
    normalLift: number = 0.035;

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Expansion", 0),
        new ComboBoxItem("Contraction", 1),
        new ComboBoxItem("Curl", 2),
        new ComboBoxItem("Saddle", 3),
        new ComboBoxItem("Uniform", 4),
    ]))
    fieldPreset: number = 0;

    @input
    @widget(new SliderWidget(2.0, 80.0, 0.5))
    planeWidth: number = 24.0;

    @input
    @widget(new SliderWidget(2.0, 60.0, 0.5))
    planeDepth: number = 14.0;

    @input
    @widget(new SliderWidget(3, 33, 1))
    columns: number = 13;

    @input
    @widget(new SliderWidget(3, 25, 1))
    rows: number = 9;

    @input
    @widget(new SliderWidget(0.08, 3.5, 0.02))
    tubeLength: number = 0.82;

    @input
    @widget(new SliderWidget(0.01, 0.35, 0.005))
    tubeRadius: number = 0.055;

    @input
    @widget(new SliderWidget(4, 14, 1))
    radialSegments: number = 7;

    @input
    @widget(new SliderWidget(0.0, 2.0, 0.05))
    fieldScale: number = 1.0;

    @input
    @widget(new SliderWidget(0.0, 2.0, 0.05))
    animationSpeed: number = 0.45;

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("jet", 13),
        new ComboBoxItem("viridis", 17),
        new ComboBoxItem("plasma", 18),
    ]))
    @hint("Matplotlib-style colormap for tube magnitude/intensity.")
    private _colorMap: number = 17;

    @input
    @widget(new SliderWidget(0.05, 4.0, 0.01))
    @hint("Multiplies the normalized value before sampling the selected color gradient.")
    private _colorMapScale: number = 1.0;

    @input
    @widget(new SliderWidget(-1.0, 1.0, 0.01))
    @hint("Adds to the normalized value before sampling the selected color gradient.")
    private _colorMapOffset: number = 0.0;

    @input
    @widget(new SliderWidget(0.0, 1.0, 0.01))
    @hint("0 keeps tubes opaque. Higher values make magnitude affect alpha.")
    magnitudeAlpha: number = 0.0;

    @input
    @widget(new SliderWidget(0, 120, 1))
    renderOrder: number = 42;

    @input
    @widget(new SliderWidget(1, 60, 1))
    rebuildFps: number = 20;

    private visual: RenderMeshVisual | null = null;
    private materialInstance: Material | null = null;
    private samples: GlyphSample[] = [];
    private initialized: boolean = false;
    private meshAccumulator: number = 0.0;
    private topologyKey: string = "";
    private lastSourceSignature: string = "";
    private activeSourceApi: any = null;

    onAwake(): void {
        this.createApi();
        this.createEvent("OnStartEvent").bind(() => this.initialize());
        this.createEvent("UpdateEvent").bind(() => this.tick());
    }

    public show(): void {
        this.initialize();
        this.sceneObject.enabled = true;
    }

    public hide(): void {
        this.sceneObject.enabled = false;
    }

    public rebuild(): void {
        this.topologyKey = "";
        this.seedSamples();
        this.rebuildMesh();
    }

    public setPreset(mode: number | string): void {
        this.fieldPreset = this.presetIndex(mode);
        this.rebuild();
    }

    public setFieldMode(mode: number | string): void {
        this.setPreset(mode);
    }

    public setVisualizationMode(mode: number | string): void {
        // Compatibility with older guide code. This component now has one mode:
        // anchored tubes that rotate in place.
        this.rebuild();
    }

    public setTubeMode(mode: number | string): void {
        this.setVisualizationMode(mode);
    }

    private createApi(): void {
        const self = this;
        (this as any).tubeGlyphFieldApi = {
            show: () => self.show(),
            hide: () => self.hide(),
            rebuild: () => self.rebuild(),
            refresh: () => self.rebuild(),
            setPreset: (mode: number | string) => self.setPreset(mode),
            setFieldMode: (mode: number | string) => self.setFieldMode(mode),
            setVisualizationMode: (mode: number | string) => self.setVisualizationMode(mode),
            setTubeMode: (mode: number | string) => self.setTubeMode(mode),
            setColorMap: (value: number | string) => self.setColorMap(value),
            setPalette: (value: number | string) => self.setColorMap(value),
            setColorMapScale: (value: number) => self.setColorMapScale(value),
            setGradientScale: (value: number) => self.setColorMapScale(value),
            setColorMapOffset: (value: number) => self.setColorMapOffset(value),
            setGradientOffset: (value: number) => self.setColorMapOffset(value),
            get colorMap(): number { return self.colorMap; },
            set colorMap(value: number) { self.colorMap = value; },
            get colorMapScale(): number { return self.colorMapScale; },
            set colorMapScale(value: number) { self.colorMapScale = value; },
            get colorMapOffset(): number { return self.colorMapOffset; },
            set colorMapOffset(value: number) { self.colorMapOffset = value; },
        };
    }

    get colorMap(): number { return this._colorMap; }
    set colorMap(value: number) { this.setColorMap(value); }

    get colorMapScale(): number { return this._colorMapScale; }
    set colorMapScale(value: number) { this.setColorMapScale(value); }

    get colorMapOffset(): number { return this._colorMapOffset; }
    set colorMapOffset(value: number) { this.setColorMapOffset(value); }

    public setColorMap(value: number | string): void {
        this._colorMap = this.normalizeColorMap(value);
        this.rebuild();
    }

    public setColorMapScale(value: number): void {
        if (isNaN(value)) return;
        this._colorMapScale = this.clamp(value, -8.0, 8.0);
        this.rebuild();
    }

    public setColorMapOffset(value: number): void {
        if (isNaN(value)) return;
        this._colorMapOffset = this.clamp(value, -8.0, 8.0);
        this.rebuild();
    }

    private initialize(): void {
        if (this.initialized) return;
        this.initialized = true;

        this.visual = this.sceneObject.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        if (!this.visual) {
            this.visual = this.sceneObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        }

        const source = this.material || DEFAULT_MATERIAL;
        this.materialInstance = source ? source.clone() : null;
        if (this.materialInstance) {
            this.visual.mainMaterial = this.materialInstance;
            this.applyMaterialStyle();
        }
        this.setRenderOrder(this.visual, this.renderOrder);
        this.seedSamples();
        this.rebuildMesh();
        print("OrientedTubeGlyphField: ready");
    }

    private tick(): void {
        this.initialize();
        this.applyMaterialStyle();
        const sourceChanged = this.syncSourceState();

        const fps = Math.max(1, this.rebuildFps);
        this.meshAccumulator += getDeltaTime();
        if (!sourceChanged && this.meshAccumulator < 1.0 / fps) return;
        this.meshAccumulator = 0.0;

        const key = this.currentTopologyKey();
        if (key !== this.topologyKey) {
            this.seedSamples();
            this.topologyKey = key;
        }
        this.rebuildMesh();
    }

    private syncSourceState(): boolean {
        if (this.fieldSourceMode <= 0) {
            this.lastSourceSignature = "";
            this.activeSourceApi = null;
            return false;
        }
        const api = this.findSourceApi();
        this.activeSourceApi = api;
        if (!api) return false;

        let changed = false;
        if (this.syncLayoutFromSource && typeof api.getTubeGlyphFieldState === "function") {
            try {
                const state = api.getTubeGlyphFieldState();
                if (state) {
                    if (typeof state.planeWidth === "number" && Math.abs(this.planeWidth - state.planeWidth) > 0.001) {
                        this.planeWidth = state.planeWidth;
                        changed = true;
                    }
                    if (typeof state.planeDepth === "number" && Math.abs(this.planeDepth - state.planeDepth) > 0.001) {
                        this.planeDepth = state.planeDepth;
                        changed = true;
                    }
                    if (typeof state.plane === "string") {
                        const nextPlane = state.plane.toUpperCase() === "XY" ? 1 : 0;
                        if (nextPlane !== Math.floor(this.dataPlane)) {
                            this.dataPlane = nextPlane;
                            changed = true;
                        }
                    }
                }
            } catch (e) {}
        }

        if (this.syncTransformFromSource) {
            this.syncTransformToSource();
        }

        if (typeof api.getTubeGlyphFieldSignature === "function") {
            try {
                const nextSignature = "" + api.getTubeGlyphFieldSignature();
                if (nextSignature !== this.lastSourceSignature) {
                    this.lastSourceSignature = nextSignature;
                    changed = true;
                }
            } catch (e) {}
        }
        return changed;
    }

    private syncTransformToSource(): void {
        const source = this.fieldSourceObject;
        if (!source || source === this.sceneObject) return;
        try {
            const sourceTransform = source.getTransform();
            const ownTransform = this.sceneObject.getTransform();
            ownTransform.setWorldPosition(sourceTransform.getWorldPosition());
            ownTransform.setWorldRotation(sourceTransform.getWorldRotation());
            ownTransform.setLocalScale(sourceTransform.getLocalScale());
        } catch (e) {}
    }

    private seedSamples(): void {
        this.samples = [];
        const cols = Math.max(1, Math.floor(this.columns));
        const rows = Math.max(1, Math.floor(this.rows));
        const hw = this.planeWidth * 0.5;
        const hd = this.planeDepth * 0.5;
        for (let rz = 0; rz < rows; rz++) {
            const z = rows === 1 ? 0.0 : -hd + (rz / (rows - 1)) * this.planeDepth;
            for (let cx = 0; cx < cols; cx++) {
                const x = cols === 1 ? 0.0 : -hw + (cx / (cols - 1)) * this.planeWidth;
                const phase = this.hash01(cx * 31.0 + rz * 17.0) * TWO_PI;
                this.samples.push({ x, z, phase });
            }
        }
    }

    private rebuildMesh(): void {
        if (!this.visual) return;
        const mb = this.makeBuilder();
        const sourceMode = this.fieldSourceMode > 0;
        const time = sourceMode ? getTime() : getTime() * Math.max(0.0, this.animationSpeed);
        this.activeSourceApi = sourceMode ? this.findSourceApi() : null;
        for (let i = 0; i < this.samples.length; i++) {
            const sample = this.samples[i];
            const field = this.sampleField(sample.x, sample.z, sourceMode ? time : time + sample.phase);
            const speed = Math.sqrt(field.x * field.x + field.z * field.z);
            if (speed < 0.01) continue;
            const dirX = field.x / speed;
            const dirZ = field.z / speed;
            const lengthScale = this.clamp(0.62 + speed * 0.28, 0.55, 1.35);
            const color = this.colorForMagnitude(field.intensity === undefined ? speed : field.intensity);
            this.appendTube(mb, sample.x, sample.z, dirX, dirZ, this.tubeLength * lengthScale, this.tubeRadius, color);
        }
        if (mb.isValid()) {
            this.visual.mesh = mb.getMesh();
            mb.updateMesh();
            this.visual.enabled = true;
        }
    }

    private sampleField(x: number, z: number, time: number): FieldVector2 {
        if (this.fieldSourceMode > 0) {
            const sourced = this.sampleExternalField(x, z, time);
            if (sourced) return sourced;
        }

        const hw = Math.max(0.001, this.planeWidth * 0.5);
        const hd = Math.max(0.001, this.planeDepth * 0.5);
        const nx = x / hw;
        const nz = z / hd;
        const pulse = this.fieldScale * (0.94 + 0.06 * Math.sin(time));
        const preset = this.presetId();
        if (preset === "expansion") return { x: nx * pulse, z: nz * pulse };
        if (preset === "contraction") return { x: -nx * pulse, z: -nz * pulse };
        if (preset === "curl") return { x: -nz * pulse, z: nx * pulse };
        if (preset === "saddle") return { x: nx * pulse, z: -nz * pulse };
        return { x: pulse, z: 0.18 * Math.sin(nx * Math.PI + time) };
    }

    private sampleExternalField(x: number, z: number, time: number): FieldVector2 | null {
        const api = this.activeSourceApi || this.findSourceApi();
        if (!api || typeof api.sampleTubeGlyphField !== "function") return null;
        try {
            const result = api.sampleTubeGlyphField(x, z, time);
            return this.normalizeExternalSample(result);
        } catch (e) {
            return null;
        }
    }

    private normalizeExternalSample(result: any): FieldVector2 | null {
        if (!result) return null;
        if (result instanceof vec3) {
            return { x: result.x, z: result.z, speed: result.length, intensity: this.clamp(result.length, 0.0, 1.0) };
        }
        if (result.field instanceof vec3) {
            const field = result.field as vec3;
            return {
                x: field.x,
                z: field.z,
                speed: result.speed === undefined ? field.length : result.speed,
                intensity: result.intensity === undefined ? this.clamp(field.length, 0.0, 1.0) : result.intensity,
            };
        }
        if (typeof result.x === "number" && typeof result.z === "number") {
            const speed = result.speed === undefined ? Math.sqrt(result.x * result.x + result.z * result.z) : result.speed;
            return {
                x: result.x,
                z: result.z,
                speed: speed,
                intensity: result.intensity === undefined ? this.clamp(speed, 0.0, 1.0) : result.intensity,
            };
        }
        return null;
    }

    private findSourceApi(): any {
        const root = this.fieldSourceObject || this.sceneObject;
        const own = this.findApiOnObject(root);
        if (own) return own;
        const parent = root ? root.getParent() : null;
        return this.findApiInChildren(parent || root);
    }

    private findApiInChildren(root: SceneObject | null): any {
        if (!root) return null;
        const direct = this.findApiOnObject(root);
        if (direct) return direct;
        const count = root.getChildrenCount();
        for (let i = 0; i < count; i++) {
            const found = this.findApiInChildren(root.getChild(i));
            if (found) return found;
        }
        return null;
    }

    private findApiOnObject(object: SceneObject | null): any {
        if (!object) return null;
        const scripts = object.getComponents("Component.ScriptComponent") as any[];
        for (let i = 0; i < scripts.length; i++) {
            const script = scripts[i] as any;
            const api = script.tubeGlyphSourceApi || script.gravityApi || script.windApi || script.fieldApi || script;
            if (api && typeof api.sampleTubeGlyphField === "function") return api;
        }
        return null;
    }

    private appendTube(mb: MeshBuilder, x: number, z: number, dx: number, dz: number, length: number, radius: number, color: TubeColor): void {
        const radial = Math.max(4, Math.floor(this.radialSegments));
        const start = mb.getVerticesCount();
        const px = -dz;
        const pz = dx;
        const half = length * 0.5;
        const ax = x - dx * half;
        const az = z - dz * half;
        const bx = x + dx * half;
        const bz = z + dz * half;

        for (let ring = 0; ring < 2; ring++) {
            const cx = ring === 0 ? ax : bx;
            const cz = ring === 0 ? az : bz;
            const v = ring;
            for (let k = 0; k < radial; k++) {
                const a = (k / radial) * TWO_PI;
                const ca = Math.cos(a);
                const sa = Math.sin(a);
                this.appendPlaneVertex(mb, cx, cz, px, pz, ca, sa, radius, k / radial, v, color);
            }
        }

        for (let k = 0; k < radial; k++) {
            const a = start + k;
            const b = start + ((k + 1) % radial);
            const c = start + radial + k;
            const d = start + radial + ((k + 1) % radial);
            mb.appendIndices([a, b, c, b, d, c]);
        }

        const capA = mb.getVerticesCount();
        this.appendPlaneCapVertex(mb, ax, az, -dx, -dz, 0.5, 0.0, color);
        const capB = mb.getVerticesCount();
        this.appendPlaneCapVertex(mb, bx, bz, dx, dz, 0.5, 1.0, color);
        for (let k = 0; k < radial; k++) {
            const a = start + k;
            const b = start + ((k + 1) % radial);
            const c = start + radial + k;
            const d = start + radial + ((k + 1) % radial);
            mb.appendIndices([capA, a, b, capB, d, c]);
        }
    }

    private appendPlaneVertex(
        mb: MeshBuilder,
        u: number,
        vCoord: number,
        perpU: number,
        perpV: number,
        radialPlane: number,
        radialNormal: number,
        radius: number,
        uvx: number,
        uvy: number,
        color: TubeColor
    ): void {
        const r = Math.max(0.0001, radius);
        const planeOffset = radialPlane * r;
        const normalOffset = radialNormal * r;
        const lift = this.normalLift;
        const nxPlane = perpU * radialPlane;
        const nvPlane = perpV * radialPlane;
        const nn = radialNormal;

        if (this.isXYPlane()) {
            mb.appendVerticesInterleaved([
                u + perpU * planeOffset,
                vCoord + perpV * planeOffset,
                lift + normalOffset,
                nxPlane, nvPlane, nn,
                uvx, uvy,
                color.r, color.g,
                color.b, color.a,
            ]);
        } else {
            mb.appendVerticesInterleaved([
                u + perpU * planeOffset,
                lift + normalOffset,
                vCoord + perpV * planeOffset,
                nxPlane, nn, nvPlane,
                uvx, uvy,
                color.r, color.g,
                color.b, color.a,
            ]);
        }
    }

    private appendPlaneCapVertex(mb: MeshBuilder, u: number, vCoord: number, normalU: number, normalV: number, uvx: number, uvy: number, color: TubeColor): void {
        if (this.isXYPlane()) {
            mb.appendVerticesInterleaved([u, vCoord, this.normalLift, normalU, normalV, 0.0, uvx, uvy, color.r, color.g, color.b, color.a]);
        } else {
            mb.appendVerticesInterleaved([u, this.normalLift, vCoord, normalU, 0.0, normalV, uvx, uvy, color.r, color.g, color.b, color.a]);
        }
    }

    private makeBuilder(): MeshBuilder {
        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
            { name: "texture1", components: 2 },
            { name: "texture2", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;
        return mb;
    }

    private isXYPlane(): boolean {
        return Math.floor(this.dataPlane) === 1;
    }

    private applyMaterialStyle(): void {
        if (!this.materialInstance) return;
        const pass = this.materialInstance.mainPass as any;
        const color = new vec4(0.46, 0.82, 1.0, 1.0);
        try { pass.FlatColor = color; } catch (e) {}
        try { pass.baseColor = color; } catch (e) {}
        try { pass.Port_FinalColor_N004 = color; } catch (e) {}
        try { pass.depthTest = true; } catch (e) {}
        try { pass.depthWrite = true; } catch (e) {}
    }

    private currentTopologyKey(): string {
        return [
            Math.floor(this.columns),
            Math.floor(this.rows),
            this.planeWidth.toFixed(2),
            this.planeDepth.toFixed(2),
            Math.floor(this.radialSegments),
            Math.floor(this.fieldSourceMode),
        ].join(":");
    }

    private presetId(): TubeGlyphPresetId {
        const idx = Math.floor(this.fieldPreset);
        if (idx === 1) return "contraction";
        if (idx === 2) return "curl";
        if (idx === 3) return "saddle";
        if (idx === 4) return "uniform";
        return "expansion";
    }

    private presetIndex(mode: number | string): number {
        if (typeof mode === "number") return Math.max(0, Math.min(4, Math.floor(mode)));
        const key = (mode || "").toLowerCase();
        if (key === "contraction") return 1;
        if (key === "curl" || key === "rotation") return 2;
        if (key === "saddle") return 3;
        if (key === "uniform") return 4;
        return 0;
    }

    private normalizeColorMap(value: number | string): number {
        if (typeof value === "string") {
            const key = value.toLowerCase();
            if (key === "jet") return 13;
            if (key === "turbo") return 14;
            if (key === "viridis") return 17;
            if (key === "plasma") return 18;
            return 17;
        }
        return Math.floor(this.clamp(value, 0, 18));
    }

    private colorForMagnitude(value: number): TubeColor {
        const scale = Math.abs(this._colorMapScale) < 0.0001 ? 1.0 : this._colorMapScale;
        const t = this.clamp(value * scale + this._colorMapOffset, 0.0, 1.0);
        const rgb = this.boostColor(this.sampleColorMap(t));
        const magnitudeA = this.clamp(0.32 + t * 0.68, 0.0, 1.0);
        const a = this.clamp(1.0 + (magnitudeA - 1.0) * this.clamp(this.magnitudeAlpha, 0.0, 1.0), 0.0, 1.0);
        return { r: rgb.x, g: rgb.y, b: rgb.z, a: a };
    }

    private sampleColorMap(t: number): vec3 {
        const m = this.normalizeColorMap(this._colorMap);
        if (m === 13) return this.mapJet(t);
        if (m === 14) return this.mapTurbo(t);
        if (m === 18) return this.mapPlasma(t);
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

    private mapTurbo(t: number): vec3 {
        const x = this.clamp(t, 0.0, 1.0);
        const x2 = x * x;
        const x3 = x2 * x;
        const x4 = x3 * x;
        const x5 = x4 * x;
        return new vec3(
            this.clamp(0.13572138 + 4.61539260 * x - 42.66032258 * x2 + 132.13108234 * x3 - 152.94239396 * x4 + 59.28637943 * x5, 0.0, 1.0),
            this.clamp(0.09140261 + 2.19418839 * x + 4.84296658 * x2 - 14.18503333 * x3 + 4.27729857 * x4 + 2.82956604 * x5, 0.0, 1.0),
            this.clamp(0.10667330 + 12.64194608 * x - 60.58204836 * x2 + 110.36276771 * x3 - 89.90310912 * x4 + 27.34824973 * x5, 0.0, 1.0)
        );
    }

    private mapViridis(t: number): vec3 {
        return this.stops5(
            t,
            new vec3(0.99, 0.91, 0.15),
            new vec3(0.37, 0.79, 0.38),
            new vec3(0.13, 0.57, 0.55),
            new vec3(0.23, 0.32, 0.55),
            new vec3(0.27, 0.01, 0.33)
        );
    }

    private mapPlasma(t: number): vec3 {
        return this.stops7(
            t,
            new vec3(0.94, 0.98, 0.13),
            new vec3(0.99, 0.65, 0.21),
            new vec3(0.88, 0.39, 0.38),
            new vec3(0.70, 0.16, 0.56),
            new vec3(0.42, 0.00, 0.66),
            new vec3(0.23, 0.06, 0.50),
            new vec3(0.05, 0.03, 0.53)
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
        const sat = new vec3(
            luma + (color.x - luma) * 1.22,
            luma + (color.y - luma) * 1.22,
            luma + (color.z - luma) * 1.22
        );
        return new vec3(
            this.clamp(sat.x * 1.18 + 0.055, 0.0, 1.0),
            this.clamp(sat.y * 1.18 + 0.055, 0.0, 1.0),
            this.clamp(sat.z * 1.18 + 0.055, 0.0, 1.0)
        );
    }

    private mixVec3(a: vec3, b: vec3, t: number): vec3 {
        return new vec3(
            a.x + (b.x - a.x) * t,
            a.y + (b.y - a.y) * t,
            a.z + (b.z - a.z) * t
        );
    }

    private smoothstep(t: number): number {
        const x = this.clamp(t, 0.0, 1.0);
        return x * x * (3.0 - 2.0 * x);
    }

    private setRenderOrder(visual: RenderMeshVisual, renderOrder: number): void {
        const v = visual as any;
        try { v.renderOrder = renderOrder; } catch (e) {}
        try { v.RenderOrder = renderOrder; } catch (e) {}
        try {
            if (typeof v.setRenderOrder === "function") v.setRenderOrder(renderOrder);
        } catch (e) {}
    }

    private hash01(value: number): number {
        const s = Math.sin(value * 12.9898) * 43758.5453;
        return s - Math.floor(s);
    }

    private clamp(value: number, minValue: number, maxValue: number): number {
        return Math.max(minValue, Math.min(maxValue, value));
    }
}
