// ProxyVisualTransformController.ts
// Uses one docked interaction plane to transform the currently staged visual root.

type ProxyPose = {
    position: vec3;
    rotation: quat;
    scale: vec3;
};

type ProxyWorldBounds = {
    min: vec3;
    max: vec3;
    center: vec3;
    size: vec3;
};

const PROXY_RECTANGLE_MATERIAL: Material = requireAsset("../Materials/ProxyInteractionDots.mat") as Material;
const PROXY_OUTLINE_MATERIAL: Material = requireAsset("../Materials/FlatMaterial.mat") as Material;
const PROXY_OUTLINE_CHILD_NAME = "__ProxyActiveTubeOutline";
const PROXY_OUTLINE_RADIUS = 0.018;
const PROXY_OUTLINE_LIFT = 0.055;
const PROXY_OUTLINE_SEGMENTS = 8;
const PROXY_DOCK_AUTO = 0;
const PROXY_DOCK_TABLETOP = 1;
const PROXY_DOCK_HAND_REACH = 2;
const PROXY_DOCK_DISTANCE_REACH = 3;

@component
export class ProxyVisualTransformController extends BaseScriptComponent {
    @input
    @allowUndefined
    @hint("Menu root used as the docking reference. Empty searches for Story Chapter Guide UI.")
    menuRoot: SceneObject = null as any;

    @input
    @allowUndefined
    @hint("Story Step Director root that reports the active visual root.")
    directorRoot: SceneObject = null as any;

    @input
    @allowUndefined
    @hint("Optional camera fallback when no menu root is available.")
    cameraRoot: SceneObject = null as any;

    @input
    @hint("Menu-local dock offset while the guide is unfolded.")
    unfoldedDockOffset: vec3 = new vec3(0.0, 14.0, 0.6);

    @input
    @hint("Menu-local dock offset while the guide is folded.")
    foldedDockOffset: vec3 = new vec3(17.1, 12.2, 0.6);

    @input
    @hint("Local scale used when the proxy returns to its dock.")
    dockScale: vec3 = new vec3(4.8, 4.8, 4.8);

    @input
    @hint("Dock the proxy under the active visual instead of beside the menu.")
    dockUnderActiveVisual: boolean = true;

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Auto by active visual", 0),
        new ComboBoxItem("Tabletop / low plane", 1),
        new ComboBoxItem("Hand reach / head-height", 2),
        new ComboBoxItem("Distance cursor reach", 3),
    ]))
    @hint("Spatial placement language for the proxy dock.")
    proxyDockPlacement: number = 0;

    @input
    @widget(new SliderWidget(2, 28, 1))
    @hint("Vertical gap below the active visual bounds.")
    visualDockGapCm: number = 8.0;

    @input
    @widget(new SliderWidget(0, 36, 1))
    @hint("How far the proxy is pulled toward the camera from the active visual bounds, so it fronts the visual.")
    visualDockTowardUserCm: number = 18.0;

    @input
    @widget(new SliderWidget(0.02, 0.24, 0.01))
    @hint("How much active visual size contributes to the proxy dock scale.")
    visualDockScaleFromBounds: number = 0.10;

    @input
    @widget(new SliderWidget(0.45, 1.4, 0.05))
    @hint("Minimum multiplier applied to dockScale when adapting to the active visual bounds.")
    minVisualDockScaleMultiplier: number = 0.70;

    @input
    @widget(new SliderWidget(0.8, 2.4, 0.05))
    @hint("Maximum multiplier applied to dockScale when adapting to the active visual bounds.")
    maxVisualDockScaleMultiplier: number = 1.45;

    @input
    @widget(new SliderWidget(1, 30, 0.5))
    @hint("How quickly the proxy plane lands back on the dock.")
    dockSmoothing: number = 12.0;

    @input
    @widget(new SliderWidget(0.12, 1.2, 0.02))
    @hint("Seconds used when toggling the proxy inactive and returning it to dock.")
    dockTweenSeconds: number = 0.38;

    @input
    @hint("Hide the proxy plane when no transformable visual is active.")
    hideWhenNoActiveVisual: boolean = false;

    @input
    @hint("Automatically activate the proxy as soon as a transformable visual is selected.")
    autoActivateOnVisualSelected: boolean = false;

    @input
    @widget(new SliderWidget(1, 8, 1))
    @hint("Frames that the selected visual must have stable measurable bounds before auto-activating the proxy.")
    autoActivateReadyFrames: number = 3;

    @input('float')
    @widget(new SliderWidget(0, 6, 0.1))
    @hint("Seconds that the proxy softly blinks after activation. Set to 0 to disable the activation blink.")
    activationBlinkSeconds: number = 2.5;

    @input
    @hint("Apply proxy scale changes to the active visual root.")
    driveScale: boolean = true;

    @input
    @hint("Apply proxy rotation changes to the active visual root.")
    driveRotation: boolean = true;

    private directorApi: any = null;
    private guideApi: any = null;
    private interactable: any = null;
    private active: boolean = false;
    private returningToDock: boolean = true;
    private activeRoot: SceneObject | null = null;
    private activeKey: string = "";
    private proxyStartPose: ProxyPose | null = null;
    private baseRoots: SceneObject[] = [];
    private basePoses: ProxyPose[] = [];
    private dockTweenStartPose: ProxyPose | null = null;
    private lastDockPose: ProxyPose | null = null;
    private proxyMeshVisual: RenderMeshVisual | null = null;
    private proxyOutlineObject: SceneObject | null = null;
    private proxyOutlineVisual: RenderMeshVisual | null = null;
    private proxyMeshReady: boolean = false;
    private proxyOutlineReady: boolean = false;
    private dockTweenElapsed: number = 0.0;
    private proxyActiveVisual: number = 0.0;
    private proxyAvailableVisual: number = 1.0;
    private proxyManipulating: boolean = false;
    private proxyManipulatingVisual: number = 0.0;
    private proxyInteractableEventsBound: boolean = false;
    private proxyManipulationEventsBound: boolean = false;
    private proxyMotionHighlightSeconds: number = 0.0;
    private activationBlinkRemaining: number = 0.0;
    private lastProxyFeedbackPose: ProxyPose | null = null;
    private pendingAutoActivateKey: string = "";
    private pendingAutoActivateSignature: string = "";
    private pendingAutoActivateFrames: number = 0;
    private suppressedAutoActivateKey: string = "";
    private proxyInactiveColor: vec4 = new vec4(0.16, 0.42, 1.0, 0.10);
    private proxyActiveColor: vec4 = new vec4(0.38, 0.68, 1.0, 0.78);
    private proxyManipulatingColor: vec4 = new vec4(0.58, 0.96, 1.0, 1.0);
    private proxyDisabledColor: vec4 = new vec4(0.06, 0.12, 0.22, 0.03);
    private proxyOutlineColor: vec4 = new vec4(0.26, 0.58, 1.0, 1.0);
    private proxyManipulatingOutlineColor: vec4 = new vec4(0.72, 1.0, 1.0, 1.0);

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.start());
        this.createEvent("UpdateEvent").bind(() => this.update());
    }

    public isActive(): boolean {
        return this.active;
    }

    public canActivate(): boolean {
        return this.resolveActiveVisualRoot() !== null;
    }

    public setActive(enabled: boolean): boolean {
        if (enabled) return this.activate();
        this.deactivate();
        return false;
    }

    public toggleActive(): boolean {
        if (this.active) {
            this.deactivate();
            return false;
        }
        return this.activate();
    }

    public activate(): boolean {
        const root = this.resolveActiveVisualRoot();
        if (!root) {
            this.setProxyAvailable(false);
            return false;
        }
        if (this.active) return true;

        this.activeRoot = root;
        this.activeKey = this.resolveActiveVisualKey(root);
        this.suppressedAutoActivateKey = "";
        this.snapToDock();
        this.active = true;
        this.returningToDock = false;
        this.dockTweenStartPose = null;
        this.dockTweenElapsed = 0.0;
        this.proxyStartPose = this.capturePose(this.sceneObject);
        this.lastDockPose = this.dockPose();
        this.baseRoots = [];
        this.basePoses = [];
        this.basePoseForRoot(root);
        this.activationBlinkRemaining = Math.max(0.0, this.activationBlinkSeconds);
        this.setProxyAvailable(true);
        return true;
    }

    public deactivate(): void {
        const suppressRoot = this.activeRoot || this.resolveActiveVisualRoot();
        const suppressKey = suppressRoot ? this.resolveActiveVisualKey(suppressRoot) : "";
        this.active = false;
        this.proxyManipulating = false;
        this.proxyMotionHighlightSeconds = 0.0;
        this.activationBlinkRemaining = 0.0;
        this.lastProxyFeedbackPose = null;
        this.activeRoot = null;
        this.activeKey = "";
        this.proxyStartPose = null;
        this.lastDockPose = null;
        this.baseRoots = [];
        this.basePoses = [];
        this.pendingAutoActivateKey = "";
        this.pendingAutoActivateSignature = "";
        this.pendingAutoActivateFrames = 0;
        this.suppressedAutoActivateKey = suppressKey;
        this.setProxyAvailable(this.resolveActiveVisualRoot() !== null);
        this.beginDockTween();
    }

    public cancelAndDock(): void {
        this.deactivate();
    }

    public deactivateForContentInteraction(): void {
        if (this.active) {
            this.deactivate();
            return;
        }
        this.setProxyAvailable(this.resolveActiveVisualRoot() !== null);
    }

    public notifyContentInteractionStart(): void {
        this.deactivateForContentInteraction();
    }

    public dockSoftly(): void {
        if (this.active) return;
        this.beginDockTween();
    }

    private start(): void {
        this.directorApi = this.findDirectorApi();
        this.guideApi = this.findGuideApi();
        this.interactable = this.findInteractable(this.sceneObject);
        this.bindProxyInteractableEvents();
        this.ensureProxyMeshVisual();
        this.ensureProxyOutlineVisual();
        this.configureProxyInteractables();
        this.applyProxyVisualStyle(this.proxyInactiveColor, 880);
        this.updateProxyOutlineVisual(false, 886);
        this.setVisualsEnabled(true);
        this.snapToDock();
    }

    private update(): void {
        if (!this.proxyInteractableEventsBound) {
            this.interactable = this.findInteractable(this.sceneObject);
            this.bindProxyInteractableEvents();
        }
        if (!this.proxyManipulationEventsBound) {
            this.bindProxyManipulationEvents();
        }

        const root = this.resolveActiveVisualRoot();
        const available = root !== null;
        this.updateProxyMotionHighlight();
        if (this.autoActivateOnVisualSelected && available && !this.active && root && !this.autoActivateSuppressedFor(root)) {
            if (this.selectedVisualReadyForAutoActivate(root)) {
                this.activate();
                return;
            }
        } else if (!available || this.active) {
            if (!available) this.suppressedAutoActivateKey = "";
            this.resetPendingAutoActivate();
        }
        this.setProxyAvailable(available || this.active || this.returningToDock);
        this.updateProxyVisualState(available);

        if (this.active) {
            if (!root) {
                this.deactivate();
            } else {
                this.followDockMotionWhileActive();
                this.syncActiveRoot(root);
                this.applyProxyToActiveRoot();
                return;
            }
        }

        this.landAtDock();
        if (!available && this.hideWhenNoActiveVisual && this.isNearDock()) {
            this.setProxyAvailable(false);
        }
    }

    private syncActiveRoot(root: SceneObject): void {
        const key = this.resolveActiveVisualKey(root);
        if (this.activeRoot === root && this.activeKey === key) return;
        this.activeRoot = root;
        this.activeKey = key;
        this.basePoseForRoot(root);
    }

    private applyProxyToActiveRoot(): void {
        if (!this.activeRoot || !this.proxyStartPose) return;
        const base = this.basePoseForRoot(this.activeRoot);
        const proxy = this.capturePose(this.sceneObject);
        const translation = proxy.position.sub(this.proxyStartPose.position);
        const rotationDelta = proxy.rotation.multiply(this.proxyStartPose.rotation.invert());
        const scaleRatio = this.safeScaleRatio(proxy.scale, this.proxyStartPose.scale);

        const transform = this.activeRoot.getTransform();
        transform.setWorldPosition(base.position.add(translation));
        if (this.driveRotation) {
            transform.setWorldRotation(rotationDelta.multiply(base.rotation));
        }
        if (this.driveScale) {
            transform.setLocalScale(new vec3(
                base.scale.x * scaleRatio.x,
                base.scale.y * scaleRatio.y,
                base.scale.z * scaleRatio.z
            ));
        }
    }

    private basePoseForRoot(root: SceneObject): ProxyPose {
        for (let i = 0; i < this.baseRoots.length; i++) {
            if (this.baseRoots[i] === root) return this.basePoses[i];
        }
        const pose = this.capturePose(root);
        this.baseRoots.push(root);
        this.basePoses.push(pose);
        return pose;
    }

    private capturePose(object: SceneObject): ProxyPose {
        const transform = object.getTransform();
        const p = transform.getWorldPosition();
        const r = transform.getWorldRotation();
        const s = transform.getLocalScale();
        return {
            position: new vec3(p.x, p.y, p.z),
            rotation: new quat(r.w, r.x, r.y, r.z),
            scale: new vec3(s.x, s.y, s.z),
        };
    }

    private dockPose(): ProxyPose {
        if (this.dockUnderActiveVisual) {
            const activeRoot = this.activeRoot || this.resolveActiveVisualRoot();
            const visualPose = this.visualDockPose(activeRoot);
            if (visualPose) return visualPose;
        }

        return this.menuDockPose();
    }

    private menuDockPose(): ProxyPose {
        const menu = this.menuRoot || this.findObjectByName("Story Chapter Guide UI");
        const offset = this.menuIsFolded() ? this.foldedDockOffset : this.unfoldedDockOffset;
        if (menu) {
            const transform = menu.getTransform();
            const rotation = transform.getWorldRotation();
            const scale = transform.getLocalScale();
            const scaledOffset = new vec3(offset.x * scale.x, offset.y * scale.y, offset.z * scale.z);
            const position = transform.getWorldPosition().add(rotation.multiplyVec3(scaledOffset));
            return {
                position,
                rotation,
                scale: this.dockScale,
            };
        }

        const camera = this.cameraRoot || this.findObjectByName("Camera Object") || this.findObjectByName("Camera");
        if (camera) {
            const transform = camera.getTransform();
            const cameraRotation = transform.getWorldRotation();
            const forward = cameraRotation.multiplyVec3(new vec3(0.0, 0.0, -1.0));
            const right = cameraRotation.multiplyVec3(new vec3(1.0, 0.0, 0.0));
            const up = new vec3(0.0, 1.0, 0.0);
            return {
                position: transform.getWorldPosition()
                    .add(forward.uniformScale(58.0))
                    .add(right.uniformScale(18.0))
                    .add(up.uniformScale(-12.0)),
                rotation: quat.lookAt(forward.uniformScale(-1.0), up),
                scale: this.dockScale,
            };
        }

        return {
            position: this.sceneObject.getTransform().getWorldPosition(),
            rotation: this.sceneObject.getTransform().getWorldRotation(),
            scale: this.dockScale,
        };
    }

    private visualDockPose(root: SceneObject | null): ProxyPose | null {
        if (!root || !root.enabled) return null;
        const bounds = this.measureWorldBounds(root);
        if (!bounds) return null;

        const camera = this.cameraRoot || this.findObjectByName("Camera Object") || this.findObjectByName("Camera");
        const cameraPosition = camera ? camera.getTransform().getWorldPosition() : this.sceneObject.getTransform().getWorldPosition();
        const worldUp = new vec3(0.0, 1.0, 0.0);
        const toCamera = cameraPosition.sub(bounds.center);
        const faceDirection = this.safeHorizontalDirection(toCamera, new vec3(0.0, 0.0, 1.0));
        const towardUser = faceDirection.length > 0.0001 ? faceDirection : new vec3(0.0, 0.0, 1.0);
        const placement = this.resolveProxyPlacementMode(root);
        const largestSide = Math.max(bounds.size.x, Math.max(bounds.size.y, bounds.size.z));
        const scaleMultiplier = this.clamp(
            Math.max(0.0, largestSide) * Math.max(0.0, this.visualDockScaleFromBounds),
            Math.min(this.minVisualDockScaleMultiplier, this.maxVisualDockScaleMultiplier),
            Math.max(this.minVisualDockScaleMultiplier, this.maxVisualDockScaleMultiplier)
        );

        let belowGap = Math.max(0.0, this.visualDockGapCm);
        let towardUserCm = Math.max(0.0, this.visualDockTowardUserCm);
        let scaleBoost = 1.0;
        if (placement === PROXY_DOCK_TABLETOP) {
            belowGap = Math.min(belowGap, 2.0);
            towardUserCm = Math.min(towardUserCm, 12.0);
            scaleBoost = 1.12;
        } else if (placement === PROXY_DOCK_HAND_REACH) {
            belowGap += 6.0;
            towardUserCm += 8.0;
            scaleBoost = 1.0;
        } else if (placement === PROXY_DOCK_DISTANCE_REACH) {
            belowGap += 10.0;
            towardUserCm += 18.0;
            scaleBoost = 1.18;
        }

        const position = new vec3(bounds.center.x, bounds.min.y - belowGap, bounds.center.z)
            .add(towardUser.uniformScale(towardUserCm));
        const rotation = quat.lookAt(towardUser, worldUp);
        const finalMultiplier = this.clamp(
            scaleMultiplier * scaleBoost,
            Math.min(this.minVisualDockScaleMultiplier, this.maxVisualDockScaleMultiplier),
            Math.max(this.minVisualDockScaleMultiplier, this.maxVisualDockScaleMultiplier)
        );
        return {
            position,
            rotation,
            scale: new vec3(this.dockScale.x * finalMultiplier, this.dockScale.y * finalMultiplier, this.dockScale.z * finalMultiplier),
        };
    }

    private landAtDock(): void {
        const target = this.dockPose();
        const transform = this.sceneObject.getTransform();
        if (this.dockTweenStartPose) {
            this.dockTweenElapsed += getDeltaTime();
            const duration = Math.max(0.05, this.dockTweenSeconds);
            const t = this.clamp(this.dockTweenElapsed / duration, 0.0, 1.0);
            const eased = this.easeOutCubic(t);
            transform.setWorldPosition(this.mixVec3(this.dockTweenStartPose.position, target.position, eased));
            transform.setWorldRotation(quat.slerp(this.dockTweenStartPose.rotation, target.rotation, eased));
            transform.setLocalScale(this.mixVec3(this.dockTweenStartPose.scale, target.scale, eased));
            if (t >= 1.0) {
                this.dockTweenStartPose = null;
                this.returningToDock = false;
                this.lastDockPose = target;
            }
            return;
        }

        transform.setWorldPosition(target.position);
        transform.setWorldRotation(target.rotation);
        transform.setLocalScale(target.scale);
        this.returningToDock = false;
        this.lastDockPose = target;
    }

    private snapToDock(): void {
        const target = this.dockPose();
        const transform = this.sceneObject.getTransform();
        transform.setWorldPosition(target.position);
        transform.setWorldRotation(target.rotation);
        transform.setLocalScale(target.scale);
        this.dockTweenStartPose = null;
        this.dockTweenElapsed = 0.0;
        this.returningToDock = false;
        this.lastDockPose = target;
    }

    private isNearDock(): boolean {
        if (this.dockTweenStartPose) return false;
        const target = this.dockPose();
        const current = this.sceneObject.getTransform().getWorldPosition();
        return current.distance(target.position) < 0.35;
    }

    private beginDockTween(): void {
        this.returningToDock = true;
        this.dockTweenStartPose = this.capturePose(this.sceneObject);
        this.dockTweenElapsed = 0.0;
    }

    private followDockMotionWhileActive(): void {
        // Visual-relative docks are computed from the same root this proxy is
        // moving. Recomputing them during manipulation creates a feedback loop
        // that feels like snapping. Keep the activation baseline fixed until
        // the proxy is released back to dock.
        if (this.dockUnderActiveVisual) return;

        const previousDock = this.lastDockPose || this.dockPose();
        const nextDock = this.dockPose();
        const deltaRotation = nextDock.rotation.multiply(previousDock.rotation.invert());
        const transform = this.sceneObject.getTransform();
        const currentPosition = transform.getWorldPosition();
        const currentRotation = transform.getWorldRotation();
        const currentOffset = currentPosition.sub(previousDock.position);

        transform.setWorldPosition(nextDock.position.add(deltaRotation.multiplyVec3(currentOffset)));
        transform.setWorldRotation(deltaRotation.multiply(currentRotation));

        if (this.proxyStartPose) {
            const startOffset = this.proxyStartPose.position.sub(previousDock.position);
            this.proxyStartPose = {
                position: nextDock.position.add(deltaRotation.multiplyVec3(startOffset)),
                rotation: deltaRotation.multiply(this.proxyStartPose.rotation),
                scale: this.proxyStartPose.scale,
            };
        }
        this.lastDockPose = nextDock;
    }

    private resolveActiveVisualRoot(): SceneObject | null {
        const api = this.directorApi || this.findDirectorApi();
        this.directorApi = api;
        if (api && typeof api.getActiveVisualRoot === "function") {
            const root = api.getActiveVisualRoot() as SceneObject;
            if (root && root.enabled) {
                const key = api && typeof api.getActiveVisualKey === "function" ? api.getActiveVisualKey() : "";
                if (key && key.indexOf("theory:Vector Field Examples Root") >= 0) return null;
                return root;
            }
            return null;
        }
        return this.findFallbackActiveRoot();
    }

    private resolveActiveVisualKey(root: SceneObject): string {
        const api = this.directorApi || this.findDirectorApi();
        this.directorApi = api;
        if (api && typeof api.getActiveVisualKey === "function") {
            const key = api.getActiveVisualKey();
            if (key && key.length > 0) return key;
        }
        return root ? root.name : "";
    }

    private resolveProxyPlacementMode(root: SceneObject): number {
        const explicit = Math.floor(this.proxyDockPlacement);
        if (explicit === PROXY_DOCK_TABLETOP || explicit === PROXY_DOCK_HAND_REACH || explicit === PROXY_DOCK_DISTANCE_REACH) {
            return explicit;
        }

        const key = (this.resolveActiveVisualKey(root) || root.name || "").toLowerCase();
        if (key.indexOf("motion") >= 0 || key.indexOf("gravity") >= 0 || key.indexOf("car_flow") >= 0 || key.indexOf("aerodynamics") >= 0 || key.indexOf("car fluid") >= 0) {
            return PROXY_DOCK_TABLETOP;
        }
        if (key.indexOf("wind") >= 0 || key.indexOf("globe") >= 0 || key.indexOf("magnetic") >= 0 || key.indexOf("magnetism") >= 0) {
            return PROXY_DOCK_HAND_REACH;
        }
        return PROXY_DOCK_DISTANCE_REACH;
    }

    private selectedVisualReadyForAutoActivate(root: SceneObject): boolean {
        const bounds = this.measureRenderableWorldBounds(root);
        if (!bounds) {
            this.pendingAutoActivateSignature = "";
            this.pendingAutoActivateFrames = 0;
            return false;
        }

        const key = this.resolveActiveVisualKey(root) || root.name || "";
        const signature = key + ":" + this.boundsSignature(bounds);
        if (key !== this.pendingAutoActivateKey || signature !== this.pendingAutoActivateSignature) {
            this.pendingAutoActivateKey = key;
            this.pendingAutoActivateSignature = signature;
            this.pendingAutoActivateFrames = 1;
            return false;
        }

        this.pendingAutoActivateFrames += 1;
        return this.pendingAutoActivateFrames >= Math.max(1, Math.floor(this.autoActivateReadyFrames));
    }

    private autoActivateSuppressedFor(root: SceneObject): boolean {
        if (!this.suppressedAutoActivateKey || this.suppressedAutoActivateKey.length === 0) return false;
        const key = this.resolveActiveVisualKey(root) || root.name || "";
        if (key === this.suppressedAutoActivateKey) return true;
        this.suppressedAutoActivateKey = "";
        return false;
    }

    private resetPendingAutoActivate(): void {
        this.pendingAutoActivateKey = "";
        this.pendingAutoActivateSignature = "";
        this.pendingAutoActivateFrames = 0;
    }

    private boundsSignature(bounds: ProxyWorldBounds): string {
        const q = 0.5;
        return [
            this.quantize(bounds.center.x, q),
            this.quantize(bounds.center.y, q),
            this.quantize(bounds.center.z, q),
            this.quantize(bounds.size.x, q),
            this.quantize(bounds.size.y, q),
            this.quantize(bounds.size.z, q),
        ].join(",");
    }

    private quantize(value: number, step: number): number {
        return Math.round(value / step) * step;
    }

    private measureWorldBounds(root: SceneObject): ProxyWorldBounds | null {
        const realBounds = this.measureRenderableWorldBounds(root);
        if (realBounds) return realBounds;

        const p = root.getTransform().getWorldPosition();
        return {
            min: new vec3(p.x - 6.0, p.y - 6.0, p.z - 6.0),
            max: new vec3(p.x + 6.0, p.y + 6.0, p.z + 6.0),
            center: new vec3(p.x, p.y, p.z),
            size: new vec3(12.0, 12.0, 12.0),
        };
    }

    private measureRenderableWorldBounds(root: SceneObject): ProxyWorldBounds | null {
        const emptyMin = new vec3(1000000.0, 1000000.0, 1000000.0);
        const emptyMax = new vec3(-1000000.0, -1000000.0, -1000000.0);
        const min = new vec3(emptyMin.x, emptyMin.y, emptyMin.z);
        const max = new vec3(emptyMax.x, emptyMax.y, emptyMax.z);
        const found = this.accumulateWorldBounds(root, min, max);
        if (!found) return null;

        const center = new vec3((min.x + max.x) * 0.5, (min.y + max.y) * 0.5, (min.z + max.z) * 0.5);
        const size = new vec3(Math.max(0.0, max.x - min.x), Math.max(0.0, max.y - min.y), Math.max(0.0, max.z - min.z));
        if (Math.max(size.x, Math.max(size.y, size.z)) < 0.1) return null;
        return { min, max, center, size };
    }

    private accumulateWorldBounds(object: SceneObject, min: vec3, max: vec3): boolean {
        let found = false;
        if (object.enabled) {
            const visuals = object.getComponents("Component.RenderMeshVisual");
            for (let i = 0; i < visuals.length; i++) {
                const visual = visuals[i] as RenderMeshVisual;
                if (this.accumulateVisualWorldBounds(visual, min, max)) found = true;
            }
            for (let i = 0; i < object.getChildrenCount(); i++) {
                if (this.accumulateWorldBounds(object.getChild(i), min, max)) found = true;
            }
        }
        return found;
    }

    private accumulateVisualWorldBounds(visual: RenderMeshVisual | null, min: vec3, max: vec3): boolean {
        if (!visual || !visual.enabled || !visual.mesh) return false;
        const mesh = visual.mesh as any;
        const aabbMin = mesh.aabbMin as vec3;
        const aabbMax = mesh.aabbMax as vec3;
        if (!aabbMin || !aabbMax) return false;

        const object = visual.sceneObject || this.sceneObject;
        for (let ix = 0; ix <= 1; ix++) {
            for (let iy = 0; iy <= 1; iy++) {
                for (let iz = 0; iz <= 1; iz++) {
                    const local = new vec3(
                        ix === 0 ? aabbMin.x : aabbMax.x,
                        iy === 0 ? aabbMin.y : aabbMax.y,
                        iz === 0 ? aabbMin.z : aabbMax.z
                    );
                    this.includePoint(this.localPointToWorld(object, local), min, max);
                }
            }
        }
        return true;
    }

    private localPointToWorld(object: SceneObject, local: vec3): vec3 {
        const transform = object.getTransform();
        const position = transform.getWorldPosition();
        const rotation = transform.getWorldRotation();
        const scale = transform.getWorldScale();
        const scaled = new vec3(local.x * scale.x, local.y * scale.y, local.z * scale.z);
        return position.add(rotation.multiplyVec3(scaled));
    }

    private includePoint(point: vec3, min: vec3, max: vec3): void {
        min.x = Math.min(min.x, point.x);
        min.y = Math.min(min.y, point.y);
        min.z = Math.min(min.z, point.z);
        max.x = Math.max(max.x, point.x);
        max.y = Math.max(max.y, point.y);
        max.z = Math.max(max.z, point.z);
    }

    private findFallbackActiveRoot(): SceneObject | null {
        const names = [
            "Motion Field Root",
            "Vector Field Examples Root",
            "Gravity Field Root",
            "Magnetic Field Root",
            "Globe Calibration",
            "Car Fluid Flow",
        ];
        for (let i = 0; i < names.length; i++) {
            const object = this.findObjectByName(names[i]);
            if (object && object.enabled) return object;
        }
        return null;
    }

    private setProxyAvailable(available: boolean): void {
        const hasActiveRoot = this.resolveActiveVisualRoot() !== null;
        const canInteract = this.active && hasActiveRoot;
        this.setVisualsEnabled(available || this.active || this.returningToDock || !this.hideWhenNoActiveVisual);
        this.setCollidersEnabled(canInteract);
        this.setScriptEnabledByName("Interactable", canInteract);
        this.setScriptEnabledByName("InteractableManipulation", canInteract);
    }

    private updateProxyVisualState(available: boolean): void {
        const alpha = this.clamp(getDeltaTime() * 14.0, 0.0, 1.0);
        this.activationBlinkRemaining = Math.max(0.0, this.activationBlinkRemaining - getDeltaTime());
        const activeTarget = this.active ? 1.0 : 0.0;
        const availableTarget = available ? 1.0 : 0.0;
        const manipulatingTarget = this.isProxyManipulating() ? 1.0 : 0.0;
        this.proxyActiveVisual += (activeTarget - this.proxyActiveVisual) * alpha;
        this.proxyAvailableVisual += (availableTarget - this.proxyAvailableVisual) * alpha;
        this.proxyManipulatingVisual += (manipulatingTarget - this.proxyManipulatingVisual) * alpha;

        const resting = this.mixVec4(this.proxyDisabledColor, this.proxyInactiveColor, this.proxyAvailableVisual);
        let color = this.mixVec4(resting, this.proxyActiveColor, this.proxyActiveVisual);
        color = this.mixVec4(color, this.proxyManipulatingColor, this.proxyManipulatingVisual);
        const blinkWindow = Math.max(0.001, this.activationBlinkSeconds);
        const activationBlink = this.clamp(this.activationBlinkRemaining / blinkWindow, 0.0, 1.0);
        if (this.proxyActiveVisual > 0.01 && activationBlink > 0.0) {
            const pulse = (0.5 + 0.5 * Math.sin(getTime() * 5.2)) * 0.02 * this.proxyActiveVisual * activationBlink;
            color = new vec4(color.x, color.y, color.z, this.clamp(color.w + pulse, 0.0, 1.0));
        }

        const renderOrder = Math.round(760 + 120 * this.proxyActiveVisual + 24 * this.proxyManipulatingVisual);
        this.applyProxyVisualStyle(color, renderOrder);
        this.updateProxyOutlineVisual(this.active, renderOrder + 6);
    }

    private applyProxyVisualStyle(color: vec4, renderOrder: number): void {
        const proxyVisual = this.ensureProxyMeshVisual();
        if (proxyVisual) {
            try { proxyVisual.renderOrder = renderOrder; } catch (e) {}
            this.applyColorToMaterial(proxyVisual.mainMaterial, color);
        }
        const renderVisuals = this.sceneObject.getComponents("Component.RenderMeshVisual");
        for (let i = 0; i < renderVisuals.length; i++) {
            const visual = renderVisuals[i] as RenderMeshVisual;
            if (!visual) continue;
            try { visual.renderOrder = renderOrder; } catch (e) {}
            this.applyColorToMaterial(visual.mainMaterial, color);
        }
        const images = this.sceneObject.getComponents("Image" as any);
        for (let i = 0; i < images.length; i++) {
            const image = images[i] as Image;
            if (!image) continue;
            try { image.renderOrder = renderOrder; } catch (e) {}
            const material = (image as any).mainMaterial || (image as any).material;
            if (!material) continue;
            const pass = material.mainPass as any;
            if (!pass) continue;
            try { pass.baseColor = color; } catch (e) {}
            try { pass.BaseColor = color; } catch (e) {}
            try { pass.Port_Default_N369 = color; } catch (e) {}
            try { pass.blendMode = BlendMode.PremultipliedAlphaAuto; } catch (e) {}
            try { pass.BlendMode = BlendMode.PremultipliedAlphaAuto; } catch (e) {}
            try { pass.DepthWrite = false; } catch (e) {}
            try { pass.DepthTest = false; } catch (e) {}
            try { pass.depthWrite = false; } catch (e) {}
            try { pass.depthTest = false; } catch (e) {}
        }
    }

    private updateProxyOutlineVisual(enabled: boolean, renderOrder: number): void {
        const outline = this.ensureProxyOutlineVisual();
        if (!outline) return;
        outline.enabled = enabled;
        if (!enabled) return;
        try { outline.renderOrder = renderOrder; } catch (e) {}
        const color = this.mixVec4(this.proxyOutlineColor, this.proxyManipulatingOutlineColor, this.proxyManipulatingVisual);
        this.applyColorToMaterial(outline.mainMaterial, color);
    }

    private setVisualsEnabled(enabled: boolean): void {
        const proxyVisual = this.ensureProxyMeshVisual();
        const renderVisuals = this.sceneObject.getComponents("Component.RenderMeshVisual");
        for (let i = 0; i < renderVisuals.length; i++) {
            const visual = renderVisuals[i] as RenderMeshVisual;
            if (visual) visual.enabled = enabled;
        }
        if (proxyVisual) proxyVisual.enabled = enabled;
        this.updateProxyOutlineVisual(enabled && this.active, 886);
        const images = this.sceneObject.getComponents("Image" as any);
        for (let i = 0; i < images.length; i++) {
            const image = images[i] as Image;
            if (image) image.enabled = false;
        }
    }

    private ensureProxyMeshVisual(): RenderMeshVisual | null {
        if (!this.proxyMeshVisual) {
            this.proxyMeshVisual = this.sceneObject.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            if (!this.proxyMeshVisual) {
                this.proxyMeshVisual = this.sceneObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            }
        }
        if (!this.proxyMeshVisual) return null;

        if (!this.proxyMeshVisual.mainMaterial) {
            try {
                this.proxyMeshVisual.mainMaterial = (PROXY_RECTANGLE_MATERIAL as any).clone() as Material;
            } catch (e) {
                this.proxyMeshVisual.mainMaterial = PROXY_RECTANGLE_MATERIAL;
            }
        }

        if (!this.proxyMeshReady) {
            const meshBuilder = this.buildProxyPlaneMesh();
            if (meshBuilder.isValid()) {
                this.proxyMeshVisual.mesh = meshBuilder.getMesh();
                meshBuilder.updateMesh();
                this.proxyMeshReady = true;
            }
        }
        return this.proxyMeshVisual;
    }

    private ensureProxyOutlineVisual(): RenderMeshVisual | null {
        if (!this.proxyOutlineObject) {
            this.proxyOutlineObject = this.ensureChild(PROXY_OUTLINE_CHILD_NAME);
        }
        if (!this.proxyOutlineVisual && this.proxyOutlineObject) {
            this.proxyOutlineVisual = this.proxyOutlineObject.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            if (!this.proxyOutlineVisual) {
                this.proxyOutlineVisual = this.proxyOutlineObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            }
        }
        if (!this.proxyOutlineVisual) return null;

        if (!this.proxyOutlineVisual.mainMaterial) {
            try {
                this.proxyOutlineVisual.mainMaterial = (PROXY_OUTLINE_MATERIAL as any).clone() as Material;
            } catch (e) {
                this.proxyOutlineVisual.mainMaterial = PROXY_OUTLINE_MATERIAL;
            }
        }

        if (!this.proxyOutlineReady) {
            const meshBuilder = this.buildProxyOutlineMesh();
            if (meshBuilder.isValid()) {
                this.proxyOutlineVisual.mesh = meshBuilder.getMesh();
                meshBuilder.updateMesh();
                this.proxyOutlineReady = true;
            }
        }
        return this.proxyOutlineVisual;
    }

    private buildProxyPlaneMesh(): MeshBuilder {
        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;

        const hx = 0.5;
        const hy = 0.5;

        this.addProxyPlaneFace(
            mb,
            new vec3(-hx, -hy, 0.0),
            new vec3(hx, -hy, 0.0),
            new vec3(hx, hy, 0.0),
            new vec3(-hx, hy, 0.0)
        );
        return mb;
    }

    private buildProxyOutlineMesh(): MeshBuilder {
        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;

        const hx = 0.5;
        const hy = 0.5;
        const z = PROXY_OUTLINE_LIFT;
        const radius = PROXY_OUTLINE_RADIUS;
        const segments = PROXY_OUTLINE_SEGMENTS;

        this.appendOutlineTubeSegment(mb, new vec3(-hx, -hy, z), new vec3(hx, -hy, z), radius, segments);
        this.appendOutlineTubeSegment(mb, new vec3(hx, -hy, z), new vec3(hx, hy, z), radius, segments);
        this.appendOutlineTubeSegment(mb, new vec3(hx, hy, z), new vec3(-hx, hy, z), radius, segments);
        this.appendOutlineTubeSegment(mb, new vec3(-hx, hy, z), new vec3(-hx, -hy, z), radius, segments);
        return mb;
    }

    private appendOutlineTubeSegment(mb: MeshBuilder, start: vec3, end: vec3, radius: number, segments: number): void {
        const axis = this.subVec3(end, start);
        const length = this.lenVec3(axis);
        if (length < 0.001) return;
        const dir = this.scaleVec3(axis, 1.0 / length);
        const frame = this.frameForAxis(dir);
        const base = mb.getVerticesCount();

        for (let ring = 0; ring < 2; ring++) {
            const center = ring === 0 ? start : end;
            for (let i = 0; i < segments; i++) {
                const a = (i / segments) * Math.PI * 2.0;
                const normal = this.addVec3(
                    this.scaleVec3(frame.x, Math.cos(a)),
                    this.scaleVec3(frame.y, Math.sin(a))
                );
                const p = this.addVec3(center, this.scaleVec3(normal, radius));
                this.appendOutlineVertex(mb, p, normal, ring, i / segments);
            }
        }

        for (let i = 0; i < segments; i++) {
            const j = (i + 1) % segments;
            const a = base + i;
            const b = base + j;
            const c = base + segments + i;
            const d = base + segments + j;
            mb.appendIndices([a, c, b, b, c, d]);
        }

        const startCenter = mb.getVerticesCount();
        this.appendOutlineVertex(mb, start, this.scaleVec3(dir, -1.0), 0.5, 0.5);
        const endCenter = mb.getVerticesCount();
        this.appendOutlineVertex(mb, end, dir, 0.5, 0.5);
        for (let i = 0; i < segments; i++) {
            const j = (i + 1) % segments;
            mb.appendIndices([startCenter, base + j, base + i]);
            mb.appendIndices([endCenter, base + segments + i, base + segments + j]);
        }
    }

    private appendOutlineVertex(mb: MeshBuilder, position: vec3, normal: vec3, u: number, v: number): void {
        mb.appendVerticesInterleaved([
            position.x, position.y, position.z,
            normal.x, normal.y, normal.z,
            u, v,
        ]);
    }

    private addProxyPlaneFace(mb: MeshBuilder, a: vec3, b: vec3, c: vec3, d: vec3): void {
        const normal = new vec3(0.0, 0.0, 1.0);
        const base = mb.getVerticesCount();
        this.appendProxyVertex(mb, a, normal, 0.0, 0.0);
        this.appendProxyVertex(mb, b, normal, 1.0, 0.0);
        this.appendProxyVertex(mb, c, normal, 1.0, 1.0);
        this.appendProxyVertex(mb, d, normal, 0.0, 1.0);
        mb.appendIndices([base, base + 1, base + 2, base, base + 2, base + 3]);
    }

    private appendProxyVertex(mb: MeshBuilder, position: vec3, normal: vec3, u: number, v: number): void {
        mb.appendVerticesInterleaved([
            position.x, position.y, position.z,
            normal.x, normal.y, normal.z,
            u, v,
        ]);
    }

    private applyColorToMaterial(material: Material | null, color: vec4): void {
        if (!material) return;
        const pass = material.mainPass as any;
        if (!pass) return;
        try { pass.FlatColor = color; } catch (e) {}
        try { pass.Port_FlatColor_N000 = color; } catch (e) {}
        try { pass.baseColor = color; } catch (e) {}
        try { pass.BaseColor = color; } catch (e) {}
        try { pass.mainColor = color; } catch (e) {}
        try { pass.opacity = color.w; } catch (e) {}
        try { pass.Opacity = color.w; } catch (e) {}
        try { pass.blendMode = BlendMode.PremultipliedAlphaAuto; } catch (e) {}
        try { pass.BlendMode = BlendMode.PremultipliedAlphaAuto; } catch (e) {}
        try { pass.DepthWrite = false; } catch (e) {}
        try { pass.DepthTest = false; } catch (e) {}
        try { pass.depthWrite = false; } catch (e) {}
        try { pass.depthTest = false; } catch (e) {}
        try { pass.twoSided = true; } catch (e) {}
        try { pass.TwoSided = true; } catch (e) {}
    }

    private ensureChild(name: string): SceneObject {
        for (let i = 0; i < this.sceneObject.getChildrenCount(); i++) {
            const child = this.sceneObject.getChild(i);
            if (child.name === name) return child;
        }
        const child = global.scene.createSceneObject(name);
        child.setParent(this.sceneObject);
        child.getTransform().setLocalPosition(new vec3(0.0, 0.0, 0.0));
        child.getTransform().setLocalRotation(quat.quatIdentity());
        child.getTransform().setLocalScale(new vec3(1.0, 1.0, 1.0));
        return child;
    }

    private frameForAxis(axis: vec3): { x: vec3, y: vec3 } {
        const ref = Math.abs(axis.y) < 0.82 ? new vec3(0.0, 1.0, 0.0) : new vec3(1.0, 0.0, 0.0);
        let x = this.normVec3(this.crossVec3(ref, axis));
        if (this.lenVec3(x) < 0.001) x = new vec3(1.0, 0.0, 0.0);
        const y = this.normVec3(this.crossVec3(axis, x));
        return { x, y };
    }

    private addVec3(a: vec3, b: vec3): vec3 {
        return new vec3(a.x + b.x, a.y + b.y, a.z + b.z);
    }

    private subVec3(a: vec3, b: vec3): vec3 {
        return new vec3(a.x - b.x, a.y - b.y, a.z - b.z);
    }

    private scaleVec3(a: vec3, s: number): vec3 {
        return new vec3(a.x * s, a.y * s, a.z * s);
    }

    private lenVec3(a: vec3): number {
        return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    }

    private normVec3(a: vec3): vec3 {
        const length = this.lenVec3(a);
        return length > 0.00001 ? this.scaleVec3(a, 1.0 / length) : new vec3(0.0, 1.0, 0.0);
    }

    private crossVec3(a: vec3, b: vec3): vec3 {
        return new vec3(
            a.y * b.z - a.z * b.y,
            a.z * b.x - a.x * b.z,
            a.x * b.y - a.y * b.x
        );
    }

    private setCollidersEnabled(enabled: boolean): void {
        const colliders = this.sceneObject.getComponents("Physics.ColliderComponent");
        for (let i = 0; i < colliders.length; i++) {
            const collider = colliders[i] as ColliderComponent;
            if (collider) collider.enabled = enabled;
        }
    }

    private setScriptEnabledByName(name: string, enabled: boolean): void {
        const scripts = this.sceneObject.getComponents("Component.ScriptComponent");
        for (let i = 0; i < scripts.length; i++) {
            const script = scripts[i] as any;
            if (script && script.name === name) {
                try { script.enabled = enabled; } catch (e) {}
            }
        }
    }

    private configureProxyInteractables(): void {
        const scripts = this.sceneObject.getComponents("Component.ScriptComponent");
        for (let i = 0; i < scripts.length; i++) {
            const script = scripts[i] as any;
            if (!script) continue;
            if (script.name === "Interactable") {
                try { script.targetingMode = 3; } catch (e) {}
                try { script.targetingVisual = 1; } catch (e) {}
                try { script.ignoreInteractionPlane = true; } catch (e) {}
                try { script.keepHoverOnTrigger = false; } catch (e) {}
            } else if (script.name === "InteractableManipulation") {
                try { script.enableTranslation = true; } catch (e) {}
                try { script.enableRotation = true; } catch (e) {}
                try { script.enableScale = true; } catch (e) {}
                try { script.enableStretchZ = false; } catch (e) {}
                try { script.minimumScaleFactor = 0.35; } catch (e) {}
                try { script.maximumScaleFactor = 3.0; } catch (e) {}
            }
        }
    }

    private menuIsFolded(): boolean {
        const api = this.guideApi || this.findGuideApi();
        this.guideApi = api;
        if (api && typeof api.isFolded === "function") return api.isFolded();
        if (api && typeof api.isMenuFolded === "function") return api.isMenuFolded();
        try {
            if (api && api.folded !== undefined) return api.folded ? true : false;
        } catch (e) {}
        return false;
    }

    private findDirectorApi(): any {
        const root = this.directorRoot || this.findObjectByName("Story Step Director");
        return this.findScriptApi(root, "getActiveVisualRoot") || this.findScriptApi(root, "stageStep");
    }

    private findGuideApi(): any {
        const root = this.menuRoot || this.findObjectByName("Story Chapter Guide UI");
        return this.findScriptApi(root, "isFolded") || this.findScriptApi(root, "goTo");
    }

    private findScriptApi(root: SceneObject | null, methodName: string): any {
        if (!root) return null;
        const scripts = root.getComponents("Component.ScriptComponent");
        for (let i = 0; i < scripts.length; i++) {
            const script = scripts[i] as any;
            if (script && typeof script[methodName] === "function") return script;
        }
        return null;
    }

    private bindProxyInteractableEvents(): void {
        if (this.proxyInteractableEventsBound) return;
        if (!this.interactable) return;
        if (!this.interactable.onTriggerStart || typeof this.interactable.onTriggerStart.add !== "function") return;

        const beginManipulation = () => {
            this.proxyManipulating = true;
        };
        const endManipulation = () => {
            this.proxyManipulating = false;
        };

        this.listen(this.interactable.onTriggerStart, beginManipulation);
        this.listen(this.interactable.onInteractorTriggerStart, beginManipulation);
        this.listen(this.interactable.onTriggerUpdate, beginManipulation);
        this.listen(this.interactable.onDragStart, beginManipulation);
        this.listen(this.interactable.onDragUpdate, beginManipulation);
        this.listen(this.interactable.onTriggerEnd, endManipulation);
        this.listen(this.interactable.onTriggerEndOutside, endManipulation);
        this.listen(this.interactable.onInteractorTriggerEnd, endManipulation);
        this.listen(this.interactable.onInteractorTriggerEndOutside, endManipulation);
        this.listen(this.interactable.onTriggerCancel, endManipulation);
        this.listen(this.interactable.onTriggerCanceled, endManipulation);
        this.listen(this.interactable.onDragEnd, endManipulation);
        this.listen(this.interactable.onHoverExit, endManipulation);
        this.proxyInteractableEventsBound = true;
    }

    private bindProxyManipulationEvents(): void {
        if (this.proxyManipulationEventsBound) return;
        const manipulation = this.findScriptByName(this.sceneObject, "InteractableManipulation");
        if (!manipulation || !manipulation.onManipulationStart || typeof manipulation.onManipulationStart.add !== "function") return;

        const beginManipulation = () => {
            this.proxyManipulating = true;
        };
        const endManipulation = () => {
            this.proxyManipulating = false;
        };

        this.listen(manipulation.onManipulationStart, beginManipulation);
        this.listen(manipulation.onManipulationUpdate, beginManipulation);
        this.listen(manipulation.onTranslationStart, beginManipulation);
        this.listen(manipulation.onTranslationUpdate, beginManipulation);
        this.listen(manipulation.onRotationStart, beginManipulation);
        this.listen(manipulation.onRotationUpdate, beginManipulation);
        this.listen(manipulation.onScaleStart, beginManipulation);
        this.listen(manipulation.onScaleUpdate, beginManipulation);
        this.listen(manipulation.onManipulationEnd, endManipulation);
        this.listen(manipulation.onTranslationEnd, endManipulation);
        this.listen(manipulation.onRotationEnd, endManipulation);
        this.listen(manipulation.onScaleEnd, endManipulation);
        this.proxyManipulationEventsBound = true;
    }

    private isProxyManipulating(): boolean {
        if (!this.active) return false;
        if (this.proxyMotionHighlightSeconds > 0.0) return true;
        const triggered = this.proxyInteractableIsTriggered();
        if (triggered !== null) {
            this.proxyManipulating = triggered;
            return triggered;
        }
        return this.proxyManipulating;
    }

    private updateProxyMotionHighlight(): void {
        const dt = getDeltaTime();
        if (!this.active) {
            this.proxyMotionHighlightSeconds = 0.0;
            this.lastProxyFeedbackPose = null;
            return;
        }

        const pose = this.capturePose(this.sceneObject);
        if (this.lastProxyFeedbackPose) {
            const moved = pose.position.distance(this.lastProxyFeedbackPose.position) > 0.025;
            const scaled =
                Math.abs(pose.scale.x - this.lastProxyFeedbackPose.scale.x) > 0.005 ||
                Math.abs(pose.scale.y - this.lastProxyFeedbackPose.scale.y) > 0.005 ||
                Math.abs(pose.scale.z - this.lastProxyFeedbackPose.scale.z) > 0.005;
            const rotationDot = Math.abs(
                pose.rotation.w * this.lastProxyFeedbackPose.rotation.w +
                pose.rotation.x * this.lastProxyFeedbackPose.rotation.x +
                pose.rotation.y * this.lastProxyFeedbackPose.rotation.y +
                pose.rotation.z * this.lastProxyFeedbackPose.rotation.z
            );
            const rotated = rotationDot < 0.9995;
            if (moved || scaled || rotated) {
                this.proxyMotionHighlightSeconds = 0.22;
            }
        }
        this.lastProxyFeedbackPose = pose;
        this.proxyMotionHighlightSeconds = Math.max(0.0, this.proxyMotionHighlightSeconds - dt);
    }

    private proxyInteractableIsTriggered(): boolean | null {
        if (!this.interactable) return null;
        try {
            if (this.interactable.triggeringInteractor !== undefined) {
                return Math.floor(this.interactable.triggeringInteractor) !== 0;
            }
        } catch (e) {}
        return null;
    }

    private findInteractable(object: SceneObject): any {
        return this.findScriptByName(object, "Interactable");
    }

    private findScriptByName(object: SceneObject, name: string): any {
        const scripts = object.getComponents("Component.ScriptComponent");
        for (let i = 0; i < scripts.length; i++) {
            const candidate = scripts[i] as any;
            if (candidate && candidate.name === name) {
                return candidate;
            }
        }
        return null;
    }

    private findObjectByName(name: string): SceneObject | null {
        for (let i = 0; i < global.scene.getRootObjectsCount(); i++) {
            const found = this.findInTree(global.scene.getRootObject(i), name);
            if (found) return found;
        }
        return null;
    }

    private findInTree(root: SceneObject, name: string): SceneObject | null {
        if (root.name === name) return root;
        for (let i = 0; i < root.getChildrenCount(); i++) {
            const found = this.findInTree(root.getChild(i), name);
            if (found) return found;
        }
        return null;
    }

    private listen(eventApi: any, callback: (event?: any) => void): void {
        if (!eventApi) return;
        if (typeof eventApi.add === "function") eventApi.add(callback);
        else if (typeof eventApi === "function") eventApi(callback);
    }

    private safeScaleRatio(current: vec3, start: vec3): vec3 {
        return new vec3(
            this.safeDiv(current.x, start.x),
            this.safeDiv(current.y, start.y),
            this.safeDiv(current.z, start.z)
        );
    }

    private safeDiv(a: number, b: number): number {
        return Math.abs(b) < 0.0001 ? 1.0 : a / b;
    }

    private safeHorizontalDirection(value: vec3, fallback: vec3): vec3 {
        const horizontal = new vec3(value.x, 0.0, value.z);
        if (horizontal.length < 0.0001) {
            const fallbackHorizontal = new vec3(fallback.x, 0.0, fallback.z);
            return fallbackHorizontal.length < 0.0001 ? new vec3(0.0, 0.0, 1.0) : fallbackHorizontal.normalize();
        }
        return horizontal.normalize();
    }

    private mixVec3(a: vec3, b: vec3, t: number): vec3 {
        const k = this.clamp(t, 0.0, 1.0);
        return new vec3(
            a.x + (b.x - a.x) * k,
            a.y + (b.y - a.y) * k,
            a.z + (b.z - a.z) * k
        );
    }

    private mixVec4(a: vec4, b: vec4, t: number): vec4 {
        const k = this.clamp(t, 0.0, 1.0);
        return new vec4(
            a.x + (b.x - a.x) * k,
            a.y + (b.y - a.y) * k,
            a.z + (b.z - a.z) * k,
            a.w + (b.w - a.w) * k
        );
    }

    private easeOutCubic(t: number): number {
        const k = 1.0 - this.clamp(t, 0.0, 1.0);
        return 1.0 - k * k * k;
    }

    private clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, value));
    }
}
