// MagneticFieldTubes.ts
// Tube geometry that visualizes magnetic field from two dipole magnets
// Magnet orientation: +X axis points from S to N pole (aligned with capsule mesh)
// Rotate magnet to change pole direction

const MANIPULATOR_AFFORDANCE_MATERIAL: Material = requireAsset("../Materials/FlatMaterial.mat") as Material;

enum MagneticTubeMode {
    Trails = 0,    // Flowing tubes that bend along field lines
    Particles = 1, // Camera-facing billboard point sprites
    Arrows = 2     // Static arrows: orient + scale by field, cone tip
}

@component
export class MagneticFieldTubes extends BaseScriptComponent {
    private static readonly FIELD_RENDER_ORDER: number = 40;
    private static readonly PARTICLE_FAN_SEGMENTS: number = 8;

    // ============ PERFORMANCE ============

    private static readonly MIN_LENGTH_SEGMENTS: number = 2;
    private static readonly MAX_LENGTH_SEGMENTS: number = 64;

    // LOD presets: [radialSegments, maxLengthSegments, gridSize]
    private static readonly LOD_PRESETS: number[][] = [
        [4, 6, 4],    // 0: Low - 64 tubes
        [5, 10, 5],   // 1: Medium - 125 tubes
        [6, 16, 6],   // 2: High - 216 tubes
        [8, 24, 7],   // 3: Ultra - 343 tubes
    ];

    private _lod: number = 1;  // Default to Medium
    private _radialSegments: number = 5;

    @input
    @widget(new SliderWidget(10000, 100000, 5000))
    @hint("Maximum vertex count budget - geometry adapts to stay below this")
    private _maxVertexCount: number = 40000;

    // ============ MODE ============

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Trails", 0),
        new ComboBoxItem("Arrows", 2)
    ]))
    @hint("Trails: flowing tubes, Arrows: static oriented")
    private _tubeMode: number = 0;

    // ============ GEOMETRY ============

    @input
    @widget(new SliderWidget(2, 64, 2))
    @hint("Desired segments along tube length (may be reduced to fit vertex budget)")
    private _desiredLengthSegments: number = 32;

    private _lengthSegments: number = 32;

    @input
    @widget(new SliderWidget(0.01, 0.2, 0.01))
    @hint("Tube radius")
    private _radius: number = 0.04;

    @input
    @widget(new SliderWidget(1.0, 30.0, 0.1))
    @hint("Cone tip length multiplier for Arrow mode")
    private _coneLength: number = 4.0;

    @input
    @widget(new SliderWidget(1.0, 2.5, 0.1))
    @hint("Cone tip radius multiplier for Arrow mode")
    private _coneRadius: number = 1.7;

    @input
    @widget(new SliderWidget(0.05, 1.0, 0.05))
    @hint("Arrow length scale factor (multiplied by field magnitude)")
    private _arrowScale: number = 0.15;

    // ============ GRID ============

    @input
    @widget(new SliderWidget(1, 10, 1))
    @hint("Grid size (NxNxN)")
    private _gridSize: number = 5;

    @input
    @widget(new SliderWidget(0.1, 5.0, 0.1))
    @hint("Spacing between tube start positions")
    private _gridSpacing: number = 1.0;

    // ============ INTEGRATION ============

    @input
    @widget(new SliderWidget(0.01, 0.5, 0.01))
    @hint("Step size for field integration")
    private _stepSize: number = 0.1;

    @input
    @widget(new SliderWidget(0.1, 10.0, 0.1))
    @hint("Field strength multiplier")
    private _fieldStrength: number = 1.0;

    @input
    @widget(new SliderWidget(0.0, 50.0, 0.5))
    @hint("Speed at which tubes flow along field lines")
    private _flowSpeed: number = 2.0;

    // ============ MAGNETS ============

    @input
    @hint("First magnet object - Y rotation determines N/S orientation")
    magnet1: SceneObject;

    @input
    @hint("Second magnet object - Y rotation determines N/S orientation")
    magnet2: SceneObject;

    // ============ MATERIAL ============

    @input
    @hint("Material with MagneticFieldTubesShader.js")
    material: Material;

    private meshVisuals: RenderMeshVisual[] = [];
    private mainPass: Pass;
    private _baseFlowSpeed: number = -1;
    private manipulatorAffordanceObject: SceneObject | null = null;
    private manipulatorAffordanceVisual: RenderMeshVisual | null = null;
    private manipulatorAffordanceMaterial: Material | null = null;

    private readonly MAX_VERTICES_PER_MESH = 65000;

    // Normalized defaults: [stepSize, fieldStrength, radius, flowSpeed, lengthSegments]
    public static readonly NORMALIZED_DEFAULTS: number[] = [0.18, 0.09, 0.16, 0.04, 0.48];

    // ============ VERTEX BUDGET HELPERS ============

    private computeVertexCount(gridSize: number, lengthSegments: number, mode: number): number {
        const tubeCount = gridSize * gridSize * gridSize;
        const radial = this._radialSegments;

        if (mode === MagneticTubeMode.Particles) {
            return tubeCount * (MagneticFieldTubes.PARTICLE_FAN_SEGMENTS + 1);
        } else if (mode === MagneticTubeMode.Arrows) {
            const tubeVerts = 2 * radial;
            const coneVerts = radial + 1;
            const startCapVerts = 1;
            return tubeCount * (tubeVerts + coneVerts + startCapVerts);
        } else {
            const tubeVerts = (lengthSegments + 1) * radial;
            const capVerts = 2;
            return tubeCount * (tubeVerts + capVerts);
        }
    }

    private computeMaxLengthSegments(gridSize: number, maxVertices: number, mode: number): number {
        if (mode === MagneticTubeMode.Particles || mode === MagneticTubeMode.Arrows) {
            return MagneticFieldTubes.MIN_LENGTH_SEGMENTS;
        }

        const tubeCount = gridSize * gridSize * gridSize;
        const radial = this._radialSegments;
        const capVerts = 2;

        const budgetPerTube = Math.floor(maxVertices / tubeCount);
        const lengthSegments = Math.floor((budgetPerTube - capVerts) / radial) - 1;

        return Math.max(
            MagneticFieldTubes.MIN_LENGTH_SEGMENTS,
            Math.min(MagneticFieldTubes.MAX_LENGTH_SEGMENTS, lengthSegments)
        );
    }

    private applyLOD(): void {
        const preset = MagneticFieldTubes.LOD_PRESETS[this._lod];
        this._radialSegments = preset[0];
        this._desiredLengthSegments = preset[1];
        this._gridSize = preset[2];
    }

    private adaptGeometryToBudget(): void {
        const maxAllowed = this.computeMaxLengthSegments(
            this._gridSize,
            this._maxVertexCount,
            this._tubeMode
        );

        if (this._tubeMode === MagneticTubeMode.Particles || this._tubeMode === MagneticTubeMode.Arrows) {
            this._lengthSegments = MagneticFieldTubes.MIN_LENGTH_SEGMENTS;
        } else {
            this._lengthSegments = Math.min(this._desiredLengthSegments, maxAllowed);
        }

        const actualVerts = this.computeVertexCount(
            this._gridSize,
            this._lengthSegments,
            this._tubeMode
        );

        if (this._tubeMode === MagneticTubeMode.Trails && this._lengthSegments < this._desiredLengthSegments) {
            print("MagneticFieldTubes: Adapted lengthSegments " + this._desiredLengthSegments +
                  " → " + this._lengthSegments + " to fit vertex budget (" + actualVerts + "/" + this._maxVertexCount + ")");
        }
    }

    private normalizeTubeMode(mode: number): number {
        return Math.floor(mode) === MagneticTubeMode.Arrows ? MagneticTubeMode.Arrows : MagneticTubeMode.Trails;
    }

    onAwake(): void {
        this.setupMaterial();
        this._tubeMode = this.normalizeTubeMode(this._tubeMode);
        this.applyLOD();
        this.adaptGeometryToBudget();
        this.generateMesh();
        this.updateManipulatorAffordance();
        this.updateMaterialParams();
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));

        const tubeCount = this._gridSize * this._gridSize * this._gridSize;
        const modeNames = ["Trails", "Particles", "Arrows"];
        const lodNames = ["Low", "Medium", "High", "Ultra"];
        print("MagneticFieldTubes: Initialized " + tubeCount + " " + modeNames[this._tubeMode] + " (LOD: " + lodNames[this._lod] + ")");
    }

    private setupMaterial(): void {
        if (this.material) {
            this.mainPass = this.material.mainPass;
        } else {
            print("MagneticFieldTubes: WARNING - No material assigned!");
        }
    }

    private clearMeshVisuals(): void {
        for (const mv of this.meshVisuals) {
            if (mv) {
                mv.destroy();
            }
        }
        this.meshVisuals = [];
    }

    private createMeshVisual(): RenderMeshVisual {
        const mv = this.sceneObject.createComponent("Component.RenderMeshVisual");
        if (this.material) {
            mv.mainMaterial = this.material;
        }
        this.setVisualRenderOrder(mv, MagneticFieldTubes.FIELD_RENDER_ORDER);
        this.meshVisuals.push(mv);
        return mv;
    }

    private setVisualRenderOrder(visual: RenderMeshVisual, renderOrder: number): void {
        const anyVisual = visual as any;
        try {
            if (typeof anyVisual.setRenderOrder === "function") anyVisual.setRenderOrder(renderOrder);
            if (anyVisual.renderOrder !== undefined) anyVisual.renderOrder = renderOrder;
            if (anyVisual.RenderOrder !== undefined) anyVisual.RenderOrder = renderOrder;
        } catch (e) {}
    }

    private getForwardVector(obj: SceneObject): vec3 {
        if (!obj) {
            return new vec3(1, 0, 0);
        }
        const transform = obj.getTransform();
        const rotation = transform.getWorldRotation();
        const localForward = new vec3(1, 0, 0);
        return rotation.multiplyVec3(localForward);
    }

    private getMagnetLocalPosition(obj: SceneObject): vec3 {
        if (!obj) {
            return new vec3(0, 0, 0);
        }
        const worldPos = obj.getTransform().getWorldPosition();
        const invWorld = this.sceneObject.getTransform().getInvertedWorldTransform();
        return invWorld.multiplyPoint(worldPos);
    }

    private getMagnetLocalForward(obj: SceneObject): vec3 {
        if (!obj) {
            return new vec3(0, 0, 1);
        }
        const worldForward = this.getForwardVector(obj);
        const parentRotation = this.sceneObject.getTransform().getWorldRotation();
        const invRotation = parentRotation.invert();
        const localForward = invRotation.multiplyVec3(worldForward);
        const len = localForward.length;
        if (len < 0.001) {
            return new vec3(0, 0, 1);
        }
        return localForward.normalize();
    }

    private updateMaterialParams(): void {
        if (!this.mainPass) return;

        this.mainPass.TubeRadius = this._radius;
        this.mainPass.StepSize = this._stepSize;
        this.mainPass.NumSteps = this._lengthSegments;
        this.mainPass.FieldStrength = this._fieldStrength;
        this.mainPass.Time = getTime();
        this.mainPass.FlowSpeed = this._flowSpeed;
        this.mainPass.ArrowScale = this._arrowScale;
        this.mainPass.ConeLength = this._coneLength;
        this.mainPass.ConeRadius = this._coneRadius;

        if (this.magnet1) {
            this.mainPass.Magnet1Position = this.getMagnetLocalPosition(this.magnet1);
            this.mainPass.Magnet1Forward = this.getMagnetLocalForward(this.magnet1);
        } else {
            this.mainPass.Magnet1Position = new vec3(-2, 0, 0);
            this.mainPass.Magnet1Forward = new vec3(1, 0, 0);
        }

        if (this.magnet2) {
            this.mainPass.Magnet2Position = this.getMagnetLocalPosition(this.magnet2);
            this.mainPass.Magnet2Forward = this.getMagnetLocalForward(this.magnet2);
        } else {
            this.mainPass.Magnet2Position = new vec3(2, 0, 0);
            this.mainPass.Magnet2Forward = new vec3(-1, 0, 0);
        }
    }

    private generateMesh(): void {
        // Encoding (position/normal get distorted, use UVs for all data):
        //   texture0 = (localX, localY) unit circle coords for cross-section
        //   texture1 = (startX, startZ) starting position in XZ plane
        //   texture2 = (startY, t) starting Y position and t parameter
        //   texture3 = (geoType) geometry type:
        //     0=trailCap, 1=trail, 3=particle (short trail), 4=arrow, 5=arrowCone, 6=arrowCap

        this.clearMeshVisuals();

        const pathLength = this._lengthSegments + 1;
        const circleSegments = this._radialSegments;

        let vertsPerTube: number;
        if (this._tubeMode === MagneticTubeMode.Particles) {
            vertsPerTube = MagneticFieldTubes.PARTICLE_FAN_SEGMENTS + 1;
        } else if (this._tubeMode === MagneticTubeMode.Arrows) {
            vertsPerTube = 2 * circleSegments + circleSegments + 1 + 1;
        } else {
            vertsPerTube = pathLength * circleSegments + 2;
        }

        const maxTubesPerMesh = Math.floor(this.MAX_VERTICES_PER_MESH / vertsPerTube);

        const tubePositions: { x: number, y: number, z: number }[] = [];
        const halfExtent = (this._gridSize - 1) * this._gridSpacing / 2;
        for (let gx = 0; gx < this._gridSize; gx++) {
            for (let gy = 0; gy < this._gridSize; gy++) {
                for (let gz = 0; gz < this._gridSize; gz++) {
                    tubePositions.push({
                        x: -halfExtent + gx * this._gridSpacing,
                        y: -halfExtent + gy * this._gridSpacing,
                        z: -halfExtent + gz * this._gridSpacing
                    });
                }
            }
        }

        const totalTubes = tubePositions.length;
        const numMeshes = Math.ceil(totalTubes / maxTubesPerMesh);
        let tubeIndex = 0;
        let meshCount = 0;

        for (let meshIdx = 0; meshIdx < numMeshes; meshIdx++) {
            const meshBuilder = new MeshBuilder([
                { name: "position", components: 3 },
                { name: "normal", components: 3 },
                { name: "texture0", components: 2 },
                { name: "texture1", components: 2 },
                { name: "texture2", components: 2 },
                { name: "texture3", components: 1 },
            ]);
            meshBuilder.topology = MeshTopology.Triangles;
            meshBuilder.indexType = MeshIndexType.UInt16;

            let tubesInThisMesh = 0;

            while (tubeIndex < totalTubes && tubesInThisMesh < maxTubesPerMesh) {
                const pos = tubePositions[tubeIndex];

                if (this._tubeMode === MagneticTubeMode.Particles) {
                    this.generateParticle(meshBuilder, pos.x, pos.y, pos.z, circleSegments);
                } else if (this._tubeMode === MagneticTubeMode.Arrows) {
                    this.generateArrow(meshBuilder, pos.x, pos.y, pos.z, circleSegments);
                } else {
                    this.generateTrail(meshBuilder, pos.x, pos.y, pos.z, pathLength, circleSegments);
                }

                tubesInThisMesh++;
                tubeIndex++;
            }

            if (meshBuilder.isValid()) {
                const mv = this.createMeshVisual();
                mv.mesh = meshBuilder.getMesh();
                meshBuilder.updateMesh();
                meshCount++;
            }
        }

        const modeNames = ["Trails", "Particles", "Arrows"];
        print("MagneticFieldTubes: Generated " + totalTubes + " " + modeNames[this._tubeMode] + " across " + meshCount + " mesh(es)");
    }

    private generateTrail(meshBuilder: MeshBuilder, startX: number, startY: number, startZ: number, pathLength: number, circleSegments: number): void {
        const startVertexIndex = meshBuilder.getVerticesCount();

        for (let i = 0; i < pathLength; i++) {
            const t = i / (pathLength - 1);

            for (let j = 0; j < circleSegments; j++) {
                const theta = (j / circleSegments) * Math.PI * 2;
                const localX = Math.cos(theta);
                const localY = Math.sin(theta);

                meshBuilder.appendVerticesInterleaved([
                    0.0, 0.0, 0.0,
                    0.0, 0.0, 0.0,
                    localX, localY,
                    startX, startZ,
                    startY, t,
                    1.0
                ]);
            }
        }

        for (let segment = 0; segment < pathLength - 1; segment++) {
            for (let i = 0; i < circleSegments; i++) {
                const current = startVertexIndex + segment * circleSegments + i;
                const next = startVertexIndex + segment * circleSegments + ((i + 1) % circleSegments);
                const currentNext = startVertexIndex + (segment + 1) * circleSegments + i;
                const nextNext = startVertexIndex + (segment + 1) * circleSegments + ((i + 1) % circleSegments);

                meshBuilder.appendIndices([
                    current, next, currentNext,
                    next, nextNext, currentNext
                ]);
            }
        }

        this.generateTrailCaps(meshBuilder, startX, startY, startZ, startVertexIndex, pathLength, circleSegments);
    }

    private generateTrailCaps(meshBuilder: MeshBuilder, startX: number, startY: number, startZ: number, startVertexIndex: number, pathLength: number, circleSegments: number): void {
        const startCapIndex = meshBuilder.getVerticesCount();
        meshBuilder.appendVerticesInterleaved([
            0.0, 0.0, 0.0,
            0.0, 0.0, 0.0,
            0.0, 0.0,
            startX, startZ,
            startY, 0.0,
            0.0
        ]);

        for (let i = 0; i < circleSegments; i++) {
            const current = startVertexIndex + i;
            const next = startVertexIndex + (i + 1) % circleSegments;
            meshBuilder.appendIndices([startCapIndex, next, current]);
        }

        const endCapIndex = meshBuilder.getVerticesCount();
        meshBuilder.appendVerticesInterleaved([
            0.0, 0.0, 0.0,
            0.0, 0.0, 0.0,
            0.0, 0.0,
            startX, startZ,
            startY, 1.0,
            0.0
        ]);

        const lastRingStart = startVertexIndex + (pathLength - 1) * circleSegments;
        for (let i = 0; i < circleSegments; i++) {
            const current = lastRingStart + i;
            const next = lastRingStart + (i + 1) % circleSegments;
            meshBuilder.appendIndices([endCapIndex, current, next]);
        }
    }

    private generateArrow(meshBuilder: MeshBuilder, startX: number, startY: number, startZ: number, circleSegments: number): void {
        const startVertexIndex = meshBuilder.getVerticesCount();

        for (let i = 0; i < 2; i++) {
            const t = i;

            for (let j = 0; j < circleSegments; j++) {
                const theta = (j / circleSegments) * Math.PI * 2;
                const localX = Math.cos(theta);
                const localY = Math.sin(theta);

                meshBuilder.appendVerticesInterleaved([
                    0.0, 0.0, 0.0,
                    0.0, 0.0, 0.0,
                    localX, localY,
                    startX, startZ,
                    startY, t,
                    4.0
                ]);
            }
        }

        for (let i = 0; i < circleSegments; i++) {
            const current = startVertexIndex + i;
            const next = startVertexIndex + (i + 1) % circleSegments;
            const currentNext = startVertexIndex + circleSegments + i;
            const nextNext = startVertexIndex + circleSegments + (i + 1) % circleSegments;

            meshBuilder.appendIndices([
                current, next, currentNext,
                next, nextNext, currentNext
            ]);
        }

        const startCapIndex = meshBuilder.getVerticesCount();
        meshBuilder.appendVerticesInterleaved([
            0.0, 0.0, 0.0,
            0.0, 0.0, 0.0,
            0.0, 0.0,
            startX, startZ,
            startY, 0.0,
            6.0
        ]);

        for (let i = 0; i < circleSegments; i++) {
            const current = startVertexIndex + i;
            const next = startVertexIndex + (i + 1) % circleSegments;
            meshBuilder.appendIndices([startCapIndex, next, current]);
        }

        const coneBaseStart = meshBuilder.getVerticesCount();
        for (let j = 0; j < circleSegments; j++) {
            const theta = (j / circleSegments) * Math.PI * 2;
            const localX = Math.cos(theta) * this._coneRadius;
            const localY = Math.sin(theta) * this._coneRadius;

            meshBuilder.appendVerticesInterleaved([
                0.0, 0.0, 0.0,
                0.0, 0.0, 0.0,
                localX, localY,
                startX, startZ,
                startY, 1.0,
                5.0
            ]);
        }

        const coneTipIndex = meshBuilder.getVerticesCount();
        meshBuilder.appendVerticesInterleaved([
            0.0, 0.0, 0.0,
            0.0, 0.0, 0.0,
            0.0, 0.0,
            startX, startZ,
            startY, 2.0,
            5.0
        ]);

        for (let i = 0; i < circleSegments; i++) {
            const current = coneBaseStart + i;
            const next = coneBaseStart + (i + 1) % circleSegments;
            meshBuilder.appendIndices([current, next, coneTipIndex]);
        }

        const bodyEndRing = startVertexIndex + circleSegments;
        for (let i = 0; i < circleSegments; i++) {
            const tubeVert = bodyEndRing + i;
            const tubeNext = bodyEndRing + (i + 1) % circleSegments;
            const coneVert = coneBaseStart + i;
            const coneNext = coneBaseStart + (i + 1) % circleSegments;

            meshBuilder.appendIndices([
                tubeVert, tubeNext, coneVert,
                tubeNext, coneNext, coneVert
            ]);
        }
    }

    private generateParticle(meshBuilder: MeshBuilder, startX: number, startY: number, startZ: number, circleSegments: number): void {
        const startVertexIndex = meshBuilder.getVerticesCount();
        const segments = MagneticFieldTubes.PARTICLE_FAN_SEGMENTS;

        meshBuilder.appendVerticesInterleaved([
            0.0, 0.0, 0.0,
            0.0, 0.0, 0.0,
            0.0, 0.0,
            startX, startZ,
            startY, 0.0,
            3.0
        ]);

        for (let j = 0; j < segments; j++) {
            const theta = (j / segments) * Math.PI * 2;
            meshBuilder.appendVerticesInterleaved([
                0.0, 0.0, 0.0,
                0.0, 0.0, 0.0,
                Math.cos(theta), Math.sin(theta),
                startX, startZ,
                startY, 1.0,
                3.0
            ]);
        }

        for (let j = 0; j < segments; j++) {
            const current = startVertexIndex + 1 + j;
            const next = startVertexIndex + 1 + ((j + 1) % segments);
            meshBuilder.appendIndices([startVertexIndex, current, next]);
        }
    }

    private onUpdate(): void {
        this.updateMaterialParams();
    }

    public refresh(): void {
        this.adaptGeometryToBudget();
        this.generateMesh();
        this.updateManipulatorAffordance();
        this.updateMaterialParams();
    }

    private updateManipulatorAffordance(): void {
        const visual = this.ensureManipulatorAffordanceVisual();
        if (!visual) return;

        const halfExtent = Math.max(0.35, (this._gridSize - 1) * this._gridSpacing * 0.5 + 0.52);
        const y = -halfExtent - 0.12;
        const bracketLength = Math.max(0.55, halfExtent * 0.34);
        const width = Math.max(0.018, this._radius * 0.42);
        const bendRadius = Math.max(width * 3.2, bracketLength * 0.28);
        const meshBuilder = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
        ]);
        meshBuilder.topology = MeshTopology.Triangles;
        meshBuilder.indexType = MeshIndexType.UInt16;

        this.addAffordanceCorner(meshBuilder, -halfExtent, y, -halfExtent, 1.0, 1.0, bracketLength, width, bendRadius);
        this.addAffordanceCorner(meshBuilder, halfExtent, y, -halfExtent, -1.0, 1.0, bracketLength, width, bendRadius);
        this.addAffordanceCorner(meshBuilder, halfExtent, y, halfExtent, -1.0, -1.0, bracketLength, width, bendRadius);
        this.addAffordanceCorner(meshBuilder, -halfExtent, y, halfExtent, 1.0, -1.0, bracketLength, width, bendRadius);

        if (meshBuilder.isValid()) {
            visual.mesh = meshBuilder.getMesh();
            meshBuilder.updateMesh();
        }
    }

    private ensureManipulatorAffordanceVisual(): RenderMeshVisual | null {
        if (!this.manipulatorAffordanceObject) {
            this.manipulatorAffordanceObject = global.scene.createSceneObject("__MagneticManipulatorAffordance");
            this.manipulatorAffordanceObject.setParent(this.sceneObject);
            this.manipulatorAffordanceObject.getTransform().setLocalPosition(vec3.zero());
            this.manipulatorAffordanceObject.getTransform().setLocalRotation(quat.quatIdentity());
            this.manipulatorAffordanceObject.getTransform().setLocalScale(vec3.one());
        }
        if (!this.manipulatorAffordanceVisual && this.manipulatorAffordanceObject) {
            this.manipulatorAffordanceVisual = this.manipulatorAffordanceObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        }
        if (!this.manipulatorAffordanceVisual) return null;

        if (!this.manipulatorAffordanceMaterial) {
            try {
                this.manipulatorAffordanceMaterial = (MANIPULATOR_AFFORDANCE_MATERIAL as any).clone() as Material;
            } catch (e) {
                this.manipulatorAffordanceMaterial = MANIPULATOR_AFFORDANCE_MATERIAL;
            }
            this.applyAffordanceMaterialColor(this.manipulatorAffordanceMaterial, new vec4(0.22, 0.96, 1.0, 0.82));
        }
        this.manipulatorAffordanceVisual.mainMaterial = this.manipulatorAffordanceMaterial;
        try { this.manipulatorAffordanceVisual.renderOrder = MagneticFieldTubes.FIELD_RENDER_ORDER + 4; } catch (e) {}
        return this.manipulatorAffordanceVisual;
    }

    private addAffordanceCorner(mb: MeshBuilder, x: number, y: number, z: number, sx: number, sz: number, length: number, width: number, bendRadius: number): void {
        const bend = Math.min(Math.max(width * 2.0, bendRadius), length * 0.48);
        const path: vec3[] = [];
        path.push(new vec3(x + sx * length, y, z));
        path.push(new vec3(x + sx * bend, y, z));

        const steps = 6;
        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            const inv = 1.0 - t;
            const px = inv * inv * (x + sx * bend) + 2.0 * inv * t * x + t * t * x;
            const pz = inv * inv * z + 2.0 * inv * t * z + t * t * (z + sz * bend);
            path.push(new vec3(px, y, pz));
        }

        path.push(new vec3(x, y, z + sz * bend));
        path.push(new vec3(x, y, z + sz * length));
        this.addAffordanceTubePath(mb, path, width, 6);
    }

    private addAffordanceSegment(mb: MeshBuilder, a: vec3, b: vec3, width: number): void {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.001) return;
        const px = -dz / len * width;
        const pz = dx / len * width;
        const i = mb.getVerticesCount();
        this.appendAffordanceVertex(mb, new vec3(a.x + px, a.y, a.z + pz), 0.0, 0.0);
        this.appendAffordanceVertex(mb, new vec3(a.x - px, a.y, a.z - pz), 0.0, 1.0);
        this.appendAffordanceVertex(mb, new vec3(b.x - px, b.y, b.z - pz), 1.0, 1.0);
        this.appendAffordanceVertex(mb, new vec3(b.x + px, b.y, b.z + pz), 1.0, 0.0);
        mb.appendIndices([i, i + 1, i + 2, i, i + 2, i + 3]);
    }

    private addAffordanceTubePath(mb: MeshBuilder, path: vec3[], radius: number, radialSegments: number): void {
        if (!path || path.length < 2) return;
        const radial = Math.max(4, Math.floor(radialSegments));
        const base = mb.getVerticesCount();

        for (let ring = 0; ring < path.length; ring++) {
            const prev = path[Math.max(0, ring - 1)];
            const center = path[ring];
            const next = path[Math.min(path.length - 1, ring + 1)];
            const tangent = this.normalizeXZ(next.x - prev.x, next.z - prev.z);
            const side = new vec3(-tangent.z, 0.0, tangent.x);
            const up = new vec3(0.0, 1.0, 0.0);

            for (let i = 0; i < radial; i++) {
                const a = (i / radial) * Math.PI * 2.0;
                const normal = new vec3(
                    side.x * Math.cos(a) + up.x * Math.sin(a),
                    side.y * Math.cos(a) + up.y * Math.sin(a),
                    side.z * Math.cos(a) + up.z * Math.sin(a)
                );
                this.appendAffordanceVertex(
                    mb,
                    new vec3(center.x + normal.x * radius, center.y + normal.y * radius, center.z + normal.z * radius),
                    ring / Math.max(1, path.length - 1),
                    i / radial
                );
            }
        }

        for (let ring = 0; ring < path.length - 1; ring++) {
            for (let i = 0; i < radial; i++) {
                const nextI = (i + 1) % radial;
                const a = base + ring * radial + i;
                const b = base + ring * radial + nextI;
                const c = base + (ring + 1) * radial + i;
                const d = base + (ring + 1) * radial + nextI;
                mb.appendIndices([a, c, b, b, c, d]);
            }
        }
    }

    private normalizeXZ(x: number, z: number): vec3 {
        const len = Math.sqrt(x * x + z * z);
        if (len < 0.0001) return new vec3(1.0, 0.0, 0.0);
        return new vec3(x / len, 0.0, z / len);
    }

    private appendAffordanceVertex(mb: MeshBuilder, position: vec3, u: number, v: number): void {
        mb.appendVerticesInterleaved([
            position.x, position.y, position.z,
            0.0, 1.0, 0.0,
            u, v,
        ]);
    }

    private applyAffordanceMaterialColor(material: Material | null, color: vec4): void {
        if (!material) return;
        const pass = material.mainPass as any;
        if (!pass) return;
        try { pass.FlatColor = color; } catch (e) {}
        try { pass.BaseColor = color; } catch (e) {}
        try { pass.baseColor = color; } catch (e) {}
        try { pass.Port_FlatColor_N000 = color; } catch (e) {}
        try { pass.opacity = color.w; } catch (e) {}
        try { pass.Opacity = color.w; } catch (e) {}
        try { pass.blendMode = BlendMode.PremultipliedAlphaAuto; } catch (e) {}
        try { pass.BlendMode = BlendMode.PremultipliedAlphaAuto; } catch (e) {}
        try { pass.DepthWrite = false; } catch (e) {}
        try { pass.depthWrite = false; } catch (e) {}
    }

    // ============================================
    // PUBLIC API
    // ============================================

    public setFieldStrengthNormalized(value: number): void {
        this._fieldStrength = 0.1 + value * 9.9;
    }

    public setStepSizeNormalized(value: number): void {
        this._stepSize = 0.01 + value * 0.49;
    }

    public setRadiusNormalized(value: number): void {
        this._radius = 0.01 + value * 0.19;
    }

    public setFlowSpeedNormalized(value: number): void {
        this._flowSpeed = value * 50.0;
    }

    public setLengthSegmentsNormalized(value: number): void {
        this._desiredLengthSegments = Math.floor(2 + value * 62);
        this.refresh();
    }

    public setTubeMode(mode: number): void {
        this._tubeMode = this.normalizeTubeMode(mode);
        this.refresh();
    }

    get lengthSegments(): number { return this._lengthSegments; }
    get desiredLengthSegments(): number { return this._desiredLengthSegments; }
    set desiredLengthSegments(value: number) {
        this._desiredLengthSegments = Math.max(MagneticFieldTubes.MIN_LENGTH_SEGMENTS, Math.floor(value));
        this.refresh();
    }

    get radialSegments(): number { return this._radialSegments; }

    get lod(): number { return this._lod; }
    set lod(value: number) {
        this._lod = Math.max(0, Math.min(MagneticFieldTubes.LOD_PRESETS.length - 1, Math.floor(value)));
        this.applyLOD();
        this.refresh();
    }

    public setLOD(level: number): void {
        this.lod = level;
    }

    public setLODNormalized(value: number): void {
        const maxIndex = MagneticFieldTubes.LOD_PRESETS.length - 1;
        this.lod = Math.round(value * maxIndex);
    }

    get maxVertexCount(): number { return this._maxVertexCount; }
    set maxVertexCount(value: number) {
        this._maxVertexCount = Math.max(1000, Math.floor(value));
        this.refresh();
    }

    get tubeMode(): number { return this._tubeMode; }
    set tubeMode(value: number) {
        this._tubeMode = this.normalizeTubeMode(value);
        this.refresh();
    }

    get coneLength(): number { return this._coneLength; }
    set coneLength(value: number) {
        this._coneLength = Math.max(0.1, value);
        this.refresh();
    }

    get coneRadius(): number { return this._coneRadius; }
    set coneRadius(value: number) {
        this._coneRadius = Math.max(1.0, value);
        this.refresh();
    }

    get arrowScale(): number { return this._arrowScale; }
    set arrowScale(value: number) {
        this._arrowScale = Math.max(0.1, value);
    }

    get radius(): number { return this._radius; }
    set radius(value: number) { this._radius = value; }

    get gridSize(): number { return this._gridSize; }
    set gridSize(value: number) {
        this._gridSize = Math.max(1, Math.floor(value));
        this.refresh();
    }

    get gridSpacing(): number { return this._gridSpacing; }
    set gridSpacing(value: number) {
        this._gridSpacing = value;
        this.refresh();
    }

    get stepSize(): number { return this._stepSize; }
    set stepSize(value: number) { this._stepSize = value; }

    get fieldStrength(): number { return this._fieldStrength; }
    set fieldStrength(value: number) { this._fieldStrength = value; }

    get flowSpeed(): number { return this._flowSpeed; }
    set flowSpeed(value: number) { this._flowSpeed = value; }

    public syncFromPhysicsStrength(physicsForceStrength: number): void {
        if (this._baseFlowSpeed < 0) {
            this._baseFlowSpeed = this._flowSpeed;
        }
        const normalized = (physicsForceStrength - 1) / 499;
        const speedMultiplier = 1.0 + normalized * 4.0;
        this._flowSpeed = this._baseFlowSpeed * speedMultiplier;
        this._fieldStrength = 1.0 + normalized * 2.0;
    }
}
