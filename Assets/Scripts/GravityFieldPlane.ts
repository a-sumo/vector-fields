// GravityFieldPlane.ts
// GPU-driven gravity field on a flat XZ plane.
//
// Builds one dense plane mesh at startup and pushes the live Earth/Moon
// positions into shader uniforms each frame. No CPU rebuilds. The vertex
// shader displaces Y by the gravitational potential to produce the well
// shape, draws formal iso-potential contours, and overlays static field-line
// strokes. Directional glyph tubes are built as separate geometry.

const DEFAULT_SURFACE_GLYPH_MATERIAL: Material = requireAsset("../OrientedTubeGlyph.mat") as Material;
const DEFAULT_PLANE_MATERIAL: Material = requireAsset("../Materials/GravityFieldPlane.mat") as Material;

@component
export class GravityFieldPlane extends BaseScriptComponent {

    @input
    @allowUndefined
    @hint("Earth SceneObject. The script reads its world position into the EarthPos uniform.")
    earthObject: SceneObject = null as any;

    @input
    @allowUndefined
    @hint("Moon SceneObject. The script reads its world position into the MoonPos uniform.")
    moonObject: SceneObject = null as any;

    @input
    @hint("Material instanced from GravityFieldPlane.mat. The script clones it so multiple plane instances stay independent.")
    planeMaterial: Material = DEFAULT_PLANE_MATERIAL;

    @input
    @widget(new SliderWidget(6.0, 72.0, 0.5))
    @hint("Plane width/depth in cm.")
    planeSize: number = 56.0;

    @input
    @widget(new SliderWidget(24, 192, 4))
    @hint("Vertices per side of the plane mesh. Higher = smoother well and contours; 96 is a safe Spectacles default.")
    resolution: number = 56;

    @input
    @widget(new SliderWidget(1.0, 30.0, 0.5))
    @hint("Earth mass (relative units).")
    earthMass: number = 18.0;

    @input
    @widget(new SliderWidget(0.25, 8.0, 0.25))
    @hint("Moon mass multiplier vs. real Earth/Moon ratio.")
    moonMass: number = 4.0;

    @input
    @widget(new SliderWidget(0.05, 1.5, 0.05))
    @hint("Softening radius. Caps the 1/r singularity at body centers.")
    softening: number = 1.5;

    @input
    @widget(new SliderWidget(0.05, 4.0, 0.05))
    @hint("Vertical scale of the gravity well displacement.")
    wellDepth: number = 3.9;

    @input
    @widget(new SliderWidget(0.01, 0.5, 0.01))
    @hint("Multiplier inside the shader; tune with wellDepth for the visual look.")
    depthScale: number = 0.26;

    @input
    @widget(new SliderWidget(2.0, 24.0, 0.5))
    @hint("Number of iso-potential contour rings drawn across the plane.")
    contourCount: number = 5.0;

    @input
    @widget(new SliderWidget(0.0, 0.5, 0.01))
    @hint("Contour line half-width (relative to ring spacing).")
    contourThickness: number = 0.08;

    @input
    @widget(new SliderWidget(0.0, 4.0, 0.05))
    @hint("Animation speed for the flow stripes along the field direction.")
    flowSpeed: number = 0.0;

    @input
    @widget(new SliderWidget(0.2, 8.0, 0.1))
    @hint("Spatial frequency of the flow stripes.")
    flowScale: number = 1.1;

    @input
    @hint("Overall plane opacity scale.")
    @widget(new SliderWidget(0.0, 1.0, 0.05))
    opacityScale: number = 1.0;

    @input
    @hint("Low-potential heatmap color (far from masses).")
    @widget(new ColorWidget())
    colorLow: vec4 = new vec4(0.018, 0.024, 0.070, 1.0);

    @input
    @hint("High-potential heatmap color (near masses).")
    @widget(new ColorWidget())
    colorHigh: vec4 = new vec4(0.070, 0.090, 0.180, 1.0);

    @input
    @hint("Contour ring color (alpha controls strength).")
    @widget(new ColorWidget())
    contourColor: vec4 = new vec4(1.0, 0.250, 0.180, 0.98);

    @input
    @hint("Tint applied where Earth dominates the field.")
    @widget(new ColorWidget())
    earthTint: vec4 = new vec4(1.0, 0.28, 0.22, 1.0);

    @input
    @hint("Tint applied where the Moon dominates the field.")
    @widget(new ColorWidget())
    moonTint: vec4 = new vec4(0.22, 0.60, 1.0, 1.0);

    @input
    @hint("Field-line overlay color.")
    @widget(new ColorWidget())
    fieldLineColor: vec4 = new vec4(0.36, 0.44, 1.0, 0.92);

    @input
    @widget(new SliderWidget(0.1, 2.5, 0.05))
    @hint("Field line density in local plane space.")
    fieldLineDensity: number = 1.25;

    @input
    @widget(new SliderWidget(0.01, 0.25, 0.005))
    @hint("Field line width relative to spacing.")
    fieldLineWidth: number = 0.09;

    @input
    @hint("Draw real straight tube glyphs on the deformed gravity surface.")
    useSurfaceTubeGlyphs: boolean = true;

    @input
    @hint("Material for the surface-following tube glyph mesh.")
    surfaceTubeMaterial: Material = DEFAULT_SURFACE_GLYPH_MATERIAL;

    @input
    @widget(new SliderWidget(5, 35, 1))
    @hint("Tube glyph columns across the gravity plane.")
    tubeColumns: number = 7;

    @input
    @widget(new SliderWidget(5, 27, 1))
    @hint("Tube glyph rows across the gravity plane.")
    tubeRows: number = 11;

    @input
    @widget(new SliderWidget(2, 10, 1))
    @hint("Number of points along each straight projected glyph; higher follows the well deformation more smoothly.")
    tubeLengthSegments: number = 3;

    @input
    @widget(new SliderWidget(4, 12, 1))
    @hint("Radial segments per tube.")
    tubeRadialSegments: number = 4;

    @input
    @widget(new SliderWidget(0.05, 3.0, 0.05))
    @hint("Projected straight glyph length in X/Z plane.")
    tubeLength: number = 1.35;

    @input
    @widget(new SliderWidget(0.01, 0.22, 0.005))
    @hint("Tube radius.")
    tubeRadius: number = 0.045;

    @input
    @widget(new SliderWidget(-0.5, 0.8, 0.005))
    @hint("Lift above the deformed gravity plane to avoid z-fighting.")
    tubeSurfaceLift: number = 0.055;

    @input
    @widget(new SliderWidget(1, 30, 1))
    @hint("How often dynamic glyph geometry is rebuilt while bodies move.")
    tubeRebuildFps: number = 4;

    private visual: RenderMeshVisual | null = null;
    private tubeVisual: RenderMeshVisual | null = null;
    private materialInstance: Material | null = null;
    private tubeMaterialInstance: Material | null = null;
    private earthBasePos: vec3 = new vec3(-4.2, 0.82, 0.0);
    private moonBasePos: vec3 = new vec3(5.1, 0.42, 0.0);
    private builtPlaneSize: number = -1.0;
    private builtResolution: number = -1;
    private tubeAccumulator: number = 999.0;
    private lastEarthLocal: vec3 = this.earthBasePos;
    private lastMoonLocal: vec3 = this.moonBasePos;
    private builtTubeSignature: string = "";

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.initialize());
        this.createEvent("UpdateEvent").bind(() => this.updateUniforms());
    }

    private initialize(): void {
        if (!this.planeMaterial) {
            print("GravityFieldPlane: planeMaterial not assigned");
            return;
        }
        this.materialInstance = (this.planeMaterial as any).clone() as Material;
        this.tubeMaterialInstance = this.surfaceTubeMaterial ? (this.surfaceTubeMaterial as any).clone() as Material : null;
        this.buildMesh();
        this.ensureTubeVisual();
        this.applyStaticUniforms();
        this.updateUniforms();
    }

    private buildMesh(): void {
        const res = Math.max(8, Math.floor(this.resolution));
        const half = this.planeSize * 0.5;
        const step = this.planeSize / (res - 1);

        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;

        const verts: number[] = new Array(res * res * 8);
        let vi = 0;
        for (let iz = 0; iz < res; iz++) {
            const z = -half + iz * step;
            const v = iz / (res - 1);
            for (let ix = 0; ix < res; ix++) {
                const x = -half + ix * step;
                const u = ix / (res - 1);
                verts[vi++] = x;       // px
                verts[vi++] = 0.0;     // py — shader rewrites this
                verts[vi++] = z;       // pz
                verts[vi++] = 0.0;     // nx
                verts[vi++] = 1.0;     // ny
                verts[vi++] = 0.0;     // nz
                verts[vi++] = u;
                verts[vi++] = v;
            }
        }
        mb.appendVerticesInterleaved(verts);

        const inds: number[] = new Array((res - 1) * (res - 1) * 6);
        let ii = 0;
        for (let iz = 0; iz < res - 1; iz++) {
            const rowA = iz * res;
            const rowB = rowA + res;
            for (let ix = 0; ix < res - 1; ix++) {
                const a = rowA + ix;
                const b = a + 1;
                const c = rowB + ix;
                const d = c + 1;
                inds[ii++] = a; inds[ii++] = c; inds[ii++] = b;
                inds[ii++] = b; inds[ii++] = c; inds[ii++] = d;
            }
        }
        mb.appendIndices(inds);

        if (!this.visual) {
            this.visual = this.sceneObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        }
        this.visual.mesh = mb.getMesh();
        this.visual.mainMaterial = this.materialInstance!;
        mb.updateMesh();
        this.builtPlaneSize = this.planeSize;
        this.builtResolution = res;
    }

    private applyStaticUniforms(): void {
        if (!this.materialInstance) return;
        const pass = this.materialInstance.mainPass as any;
        pass.EarthMass = this.earthMass;
        pass.MoonMass = Math.max(0.001, this.earthMass * 0.0123 * this.moonMass);
        pass.Softening = this.softening;
        pass.WellDepth = this.wellDepth;
        pass.DepthScale = this.depthScale;
        pass.ContourCount = this.contourCount;
        pass.ContourThickness = this.contourThickness;
        pass.FlowSpeed = this.flowSpeed;
        pass.FlowScale = this.flowScale;
        pass.OpacityScale = this.opacityScale;
        pass.ContourColor = this.contourColor;
        pass.ColorLow = this.colorLow;
        pass.ColorHigh = this.colorHigh;
        pass.EarthTint = this.earthTint;
        pass.MoonTint = this.moonTint;
        pass.FieldLineColor = this.fieldLineColor;
        pass.FieldLineDensity = this.fieldLineDensity;
        pass.FieldLineWidth = this.fieldLineWidth;
    }

    private updateUniforms(): void {
        if (!this.materialInstance) return;
        this.rebuildMeshIfNeeded();
        const pass = this.materialInstance.mainPass as any;

        // Push live body positions, expressed in the plane SceneObject's local space.
        const inv = this.sceneObject.getTransform().getInvertedWorldTransform();
        const earthLocal = this.earthObject
            ? inv.multiplyPoint(this.earthObject.getTransform().getWorldPosition())
            : this.earthBasePos;
        const moonLocal = this.moonObject
            ? inv.multiplyPoint(this.moonObject.getTransform().getWorldPosition())
            : this.moonBasePos;
        this.lastEarthLocal = earthLocal;
        this.lastMoonLocal = moonLocal;

        pass.EarthPos = earthLocal;
        pass.MoonPos = moonLocal;

        // Inspector tweaks should still take effect at runtime without a reload.
        pass.EarthMass = this.earthMass;
        pass.MoonMass = Math.max(0.001, this.earthMass * 0.0123 * this.moonMass);
        pass.Softening = this.softening;
        pass.WellDepth = this.wellDepth;
        pass.DepthScale = this.depthScale;
        pass.ContourCount = this.contourCount;
        pass.ContourThickness = this.contourThickness;
        pass.FlowSpeed = this.flowSpeed;
        pass.FlowScale = this.flowScale;
        pass.OpacityScale = this.opacityScale;
        pass.FieldLineColor = this.fieldLineColor;
        pass.FieldLineDensity = this.fieldLineDensity;
        pass.FieldLineWidth = this.fieldLineWidth;
        this.rebuildTubeGlyphsIfNeeded();
    }

    private rebuildMeshIfNeeded(): void {
        const res = Math.max(8, Math.floor(this.resolution));
        const sizeChanged = Math.abs(this.planeSize - this.builtPlaneSize) > 0.001;
        if (sizeChanged || res !== this.builtResolution) {
            this.buildMesh();
        }
    }

    private ensureTubeVisual(): void {
        if (this.tubeVisual) return;
        this.tubeVisual = this.sceneObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        if (this.tubeMaterialInstance) {
            this.tubeVisual.mainMaterial = this.tubeMaterialInstance;
            this.applyTubeMaterialStyle();
        }
        this.setRenderOrder(this.tubeVisual, 43);
    }

    private applyTubeMaterialStyle(): void {
        if (!this.tubeMaterialInstance) return;
        const pass = this.tubeMaterialInstance.mainPass as any;
        const fallbackColor = new vec4(0.45, 0.95, 1.0, 1.0);
        try { pass.FlatColor = fallbackColor; } catch (e) {}
        try { pass.baseColor = fallbackColor; } catch (e) {}
        try { pass.Port_FinalColor_N004 = fallbackColor; } catch (e) {}
        try { pass.depthTest = true; } catch (e) {}
        try { pass.depthWrite = true; } catch (e) {}
    }

    private rebuildTubeGlyphsIfNeeded(): void {
        this.ensureTubeVisual();
        if (!this.tubeVisual) return;
        this.tubeVisual.enabled = this.useSurfaceTubeGlyphs;
        if (!this.useSurfaceTubeGlyphs) return;

        this.tubeAccumulator += getDeltaTime();
        const fps = Math.max(1, this.tubeRebuildFps);
        const signature = [
            this.planeSize.toFixed(2),
            Math.floor(this.tubeColumns),
            Math.floor(this.tubeRows),
            Math.floor(this.tubeLengthSegments),
            Math.floor(this.tubeRadialSegments),
            this.tubeLength.toFixed(3),
            this.tubeRadius.toFixed(3),
            this.tubeSurfaceLift.toFixed(3),
            this.earthMass.toFixed(3),
            this.moonMass.toFixed(3),
            this.softening.toFixed(3),
            this.wellDepth.toFixed(3),
            this.depthScale.toFixed(3),
            this.lastEarthLocal.x.toFixed(3),
            this.lastEarthLocal.z.toFixed(3),
            this.lastMoonLocal.x.toFixed(3),
            this.lastMoonLocal.z.toFixed(3),
        ].join(":");

        if (signature === this.builtTubeSignature && this.tubeAccumulator < 1.0 / fps) return;
        this.tubeAccumulator = 0.0;
        this.builtTubeSignature = signature;
        this.buildSurfaceTubeGlyphMesh();
    }

    private buildSurfaceTubeGlyphMesh(): void {
        if (!this.tubeVisual) return;
        const cols = Math.max(3, Math.floor(this.tubeColumns));
        const rows = Math.max(3, Math.floor(this.tubeRows));
        const half = this.planeSize * 0.5;
        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
            { name: "texture1", components: 2 },
            { name: "texture2", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;

        const spacing = this.planeSize / Math.max(cols - 1, rows - 1);
        const baseLength = Math.min(Math.max(0.05, this.tubeLength), spacing * 0.92);
        const radius = Math.min(Math.max(0.006, this.tubeRadius), spacing * 0.18);

        for (let iz = 0; iz < rows; iz++) {
            const z = rows === 1 ? 0.0 : -half + (iz / (rows - 1)) * this.planeSize;
            for (let ix = 0; ix < cols; ix++) {
                const x = cols === 1 ? 0.0 : -half + (ix / (cols - 1)) * this.planeSize;
                if (this.isNearGravityBody(x, z, spacing * 0.42)) continue;
                const sample = this.gravitySampleAt(x, z);
                if (sample.speed < 0.01) continue;
                const dirX = sample.fx / sample.speed;
                const dirZ = sample.fz / sample.speed;
                const length = baseLength * this.clamp(0.62 + sample.intensity * 0.46, 0.58, 1.16);
                const color = this.tubeColor(sample.intensity);
                this.appendSurfaceTube(mb, x, z, dirX, dirZ, length, radius, color);
            }
        }

        if (mb.isValid()) {
            this.tubeVisual.mesh = mb.getMesh();
            mb.updateMesh();
        } else {
            this.tubeVisual.mesh = null;
        }
    }

    private appendSurfaceTube(mb: MeshBuilder, x: number, z: number, dx: number, dz: number, length: number, radius: number, color: vec4): void {
        const path: vec3[] = [];
        const segments = Math.max(2, Math.floor(this.tubeLengthSegments));
        for (let i = 0; i <= segments; i++) {
            const u = i / segments - 0.5;
            const px = x + dx * length * u;
            const pz = z + dz * length * u;
            path.push(this.pointOnGravitySurface(px, pz, this.tubeSurfaceLift));
        }
        this.appendTubePath(mb, path, radius, Math.max(4, Math.floor(this.tubeRadialSegments)), color);
    }

    private appendTubePath(mb: MeshBuilder, path: vec3[], radius: number, radial: number, color: vec4): void {
        if (path.length < 2) return;
        const ringStart = mb.getVerticesCount();
        for (let i = 0; i < path.length; i++) {
            const prev = path[Math.max(0, i - 1)];
            const next = path[Math.min(path.length - 1, i + 1)];
            const tangent = this.normalize(next.sub(prev), new vec3(1.0, 0.0, 0.0));
            let side = new vec3(-tangent.z, 0.0, tangent.x);
            if (side.length < 0.0001) side = new vec3(1.0, 0.0, 0.0);
            side = side.normalize();
            const normal = this.normalize(side.cross(tangent), new vec3(0.0, 1.0, 0.0));
            for (let r = 0; r < radial; r++) {
                const a = (r / radial) * Math.PI * 2.0;
                const ca = Math.cos(a);
                const sa = Math.sin(a);
                const offset = side.uniformScale(ca * radius).add(normal.uniformScale(sa * radius));
                const p = path[i].add(offset);
                const n = this.normalize(offset, normal);
                mb.appendVerticesInterleaved([
                    p.x, p.y, p.z,
                    n.x, n.y, n.z,
                    r / radial, i / Math.max(1, path.length - 1),
                    color.x, color.y,
                    color.z, color.w,
                ]);
            }
        }

        for (let i = 0; i < path.length - 1; i++) {
            const a0 = ringStart + i * radial;
            const b0 = a0 + radial;
            for (let r = 0; r < radial; r++) {
                const a = a0 + r;
                const b = a0 + ((r + 1) % radial);
                const c = b0 + r;
                const d = b0 + ((r + 1) % radial);
                mb.appendIndices([a, b, c, b, d, c]);
            }
        }
    }

    private gravitySampleAt(x: number, z: number): { fx: number, fz: number, speed: number, intensity: number } {
        const soft = Math.max(this.softening, 0.01);
        const softE2 = soft * soft;
        const softM = soft * 0.45;
        const softM2 = softM * softM;
        const moonMassLocal = Math.max(0.001, this.earthMass * 0.0123 * this.moonMass);

        const dEx = this.lastEarthLocal.x - x;
        const dEz = this.lastEarthLocal.z - z;
        const rE2 = dEx * dEx + dEz * dEz + softE2;
        const rE = Math.sqrt(rE2);
        const dMx = this.lastMoonLocal.x - x;
        const dMz = this.lastMoonLocal.z - z;
        const rM2 = dMx * dMx + dMz * dMz + softM2;
        const rM = Math.sqrt(rM2);
        const eScale = this.earthMass / Math.max(0.0001, rE2 * rE);
        const mScale = moonMassLocal / Math.max(0.0001, rM2 * rM);
        const fx = dEx * eScale + dMx * mScale;
        const fz = dEz * eScale + dMz * mScale;
        const speed = Math.sqrt(fx * fx + fz * fz);
        const intensity = this.clamp(speed / (speed + 0.06), 0.0, 1.0);
        return { fx, fz, speed, intensity };
    }

    private pointOnGravitySurface(x: number, z: number, lift: number): vec3 {
        return new vec3(x, this.surfaceHeightAt(x, z) + lift, z);
    }

    private surfaceHeightAt(x: number, z: number): number {
        const soft = Math.max(this.softening, 0.01);
        const softE2 = soft * soft;
        const softM = soft * 0.45;
        const softM2 = softM * softM;
        const moonMassLocal = Math.max(0.001, this.earthMass * 0.0123 * this.moonMass);
        const dEx = x - this.lastEarthLocal.x;
        const dEz = z - this.lastEarthLocal.z;
        const dMx = x - this.lastMoonLocal.x;
        const dMz = z - this.lastMoonLocal.z;
        const rE = Math.sqrt(dEx * dEx + dEz * dEz + softE2);
        const rM = Math.sqrt(dMx * dMx + dMz * dMz + softM2);
        const potential = this.earthMass / rE + moonMassLocal / rM;
        return -potential * this.wellDepth * this.depthScale;
    }

    private isNearGravityBody(x: number, z: number, padding: number): boolean {
        const e = Math.sqrt((x - this.lastEarthLocal.x) * (x - this.lastEarthLocal.x) + (z - this.lastEarthLocal.z) * (z - this.lastEarthLocal.z));
        const m = Math.sqrt((x - this.lastMoonLocal.x) * (x - this.lastMoonLocal.x) + (z - this.lastMoonLocal.z) * (z - this.lastMoonLocal.z));
        return e < 0.95 + padding || m < 0.42 + padding;
    }

    private tubeColor(value: number): vec4 {
        const t = this.clamp(value, 0.0, 1.0);
        const cold = new vec3(0.14, 0.52, 1.0);
        const mid = new vec3(0.30, 1.0, 0.84);
        const hot = new vec3(1.0, 0.92, 0.18);
        const rgb = t < 0.55
            ? this.mixVec3(cold, mid, this.smoothstep(t / 0.55))
            : this.mixVec3(mid, hot, this.smoothstep((t - 0.55) / 0.45));
        return new vec4(rgb.x, rgb.y, rgb.z, 1.0);
    }

    private mixVec3(a: vec3, b: vec3, t: number): vec3 {
        return new vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
    }

    private smoothstep(t: number): number {
        const x = this.clamp(t, 0.0, 1.0);
        return x * x * (3.0 - 2.0 * x);
    }

    private normalize(v: vec3, fallback: vec3): vec3 {
        return v.length < 0.0001 ? fallback : v.normalize();
    }

    private clamp(value: number, minValue: number, maxValue: number): number {
        return Math.max(minValue, Math.min(maxValue, value));
    }

    private setRenderOrder(visual: RenderMeshVisual, renderOrder: number): void {
        const v = visual as any;
        try { v.renderOrder = renderOrder; } catch (e) {}
        try { v.RenderOrder = renderOrder; } catch (e) {}
        try {
            if (typeof v.setRenderOrder === "function") v.setRenderOrder(renderOrder);
        } catch (e) {}
    }
}
