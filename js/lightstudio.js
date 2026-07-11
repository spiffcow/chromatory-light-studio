// Paint Buddy Light Studio (Architecture v2 §26b).
// Client-side WebGL renderer for STL light-placement reference — especially NMM painting.
// Driven imperatively from Blazor via JS interop; the service never renders anything.
import * as THREE from 'three';
import { STLLoader } from '../lib/three/STLLoader.js';
import { OrbitControls } from '../lib/three/OrbitControls.js';
import { RoomEnvironment } from '../lib/three/RoomEnvironment.js';
import { TransformControls } from '../lib/three/TransformControls.js';

let renderer, scene, camera, controls, canvasEl, hemi, ground;
let axisControl = null;      // translate gizmo (X/Y/Z arrows) for the selected light
let selectedLightId = null;
let mesh = null;

// Occlusion: whether the model blocks light. On by default; a toggle exists because cube
// shadow maps over millions of triangles can strain weak GPUs (the standalone runs anywhere).
let shadowsEnabled = true;

/// Re-renders the shadow maps on the next frame (they are frozen between scene changes).
function requestShadowUpdate() {
    if (renderer && shadowsEnabled) renderer.shadowMap.needsUpdate = true;
}

export function setShadows(on) {
    captureUndo('shadows', false);
    shadowsEnabled = !!on;
    if (!renderer) return;
    renderer.shadowMap.enabled = shadowsEnabled;
    renderer.shadowMap.needsUpdate = true;
    // Toggling the shadow system requires shader recompilation on lit materials.
    if (mesh) mesh.material.needsUpdate = true;
    if (ground) ground.material.needsUpdate = true;
}

export function getShadows() {
    return shadowsEnabled;
}

/// Marks a primary light as an occluded caster (bounce/mirror lights stay unoccluded fakes).
/// Point lights get 512px cube faces: a point shadow is SIX full-scene renders, and cube maps
/// at 1024 stack into WebGL context loss once a rig holds several casters on an 8 GB card.
function configureShadowCaster(light) {
    light.castShadow = true;
    const mapSize = light.isPointLight ? 512 : 1024;
    light.shadow.mapSize.set(mapSize, mapSize);
    light.shadow.bias = -0.0015;
    light.shadow.normalBias = 1.0; // dense print meshes shadow-acne badly without this
    if (light.isDirectionalLight) {
        const s = 160;
        light.shadow.camera.left = -s;
        light.shadow.camera.right = s;
        light.shadow.camera.top = s;
        light.shadow.camera.bottom = -s;
        light.shadow.camera.near = 1;
        light.shadow.camera.far = 800;
    }
    else {
        light.shadow.camera.near = 2;
        light.shadow.camera.far = 800;
    }
}

// The table the mini stands on: its color paints the visible ground plane AND tints every
// light's bounce (snow, lava, grass, and wood all throw different light up into the model).
// Bounce tint uses the floor's hue/saturation at a lifted luminance, so a realistically dark
// table still produces a usable under-light — strength stays the intensity control.
let floorColor = '#4a4136';

function floorBounceTint() {
    const hsl = {};
    new THREE.Color(floorColor).getHSL(hsl);
    return new THREE.Color().setHSL(hsl.h, hsl.s, Math.max(hsl.l, 0.62));
}

/// Sets the floor color; the ground plane repaints and every bounce light re-tints.
export function setFloor(options) {
    captureUndo('floor', true);
    if (options.color) floorColor = options.color;
    if (ground) ground.material.color.set(floorColor);
    for (const entry of lights.values()) {
        if (entry.bounceStrength > 0) { unmountLights(entry); mountLights(entry); }
    }
}

export function getFloorColor() {
    return floorColor;
}
let modelRadius = 50;
const lights = new Map();   // id -> { light, gizmo, type }
let nextLightId = 1;

// Handles never sink below the table: the ground plane is opaque, so a handle dragged under it
// simply vanishes (the classic "my directional light's dot disappeared"). Lighting from below
// is the bounce system's job anyway.
const HANDLE_MIN_Y = 1.5;
function clampHandle(position) {
    if (position.y < HANDLE_MIN_Y) position.y = HANDLE_MIN_Y;
    return position;
}

// ---------------------------------------------------------------------------------------------
// Undo (snapshot-based): every mutating action first pushes the CURRENT rig state (getSetup
// minus camera — undo restores the rig, not the viewpoint), and Ctrl+Z pops one. Snapshots are
// tiny (a few KB of JSON), so whole-state restore beats per-action inverse bookkeeping.
// ---------------------------------------------------------------------------------------------

const undoStack = [];
const UNDO_LIMIT = 50;
let restoringUndo = false;   // an undo restore must not capture itself
let undoSuppressDepth = 0;   // compound ops (preset, rig load) capture once, not per sub-op
let changeCallback = null;   // notifies the hosting UI of module-initiated changes (keys, undo)

/// cb is either a plain function (standalone) or a Blazor DotNetObjectReference — anything
/// with invokeMethodAsync — whose 'OnStudioChangedFromCanvas' method is invoked.
export function setChangeCallback(cb) {
    changeCallback = cb;
}

function notifyChanged() {
    if (!changeCallback) return;
    if (typeof changeCallback === 'function') changeCallback();
    else changeCallback.invokeMethodAsync('OnStudioChangedFromCanvas');
}

/// coalesce=true collapses bursts of the same tag (slider drags) into one undo step:
/// the first event of the burst captured the pre-state, which is the one worth going back to.
function captureUndo(tag, coalesce) {
    if (restoringUndo || undoSuppressDepth > 0 || !renderer) return;
    const now = performance.now();
    const top = undoStack[undoStack.length - 1];
    if (coalesce && top && top.tag === tag && now - top.time < 1200) { top.time = now; return; }
    const snapshot = JSON.parse(getSetup());
    delete snapshot.camera;
    undoStack.push({ tag, time: now, json: JSON.stringify(snapshot) });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function withUndoSuppressed(fn) {
    undoSuppressDepth++;
    try { return fn(); } finally { undoSuppressDepth--; }
}

/// Restores the rig to before the last action. Returns true when something was undone.
export function undo() {
    const top = undoStack.pop();
    if (!top) return false;
    restoringUndo = true;
    try { applySetup(top.json); } finally { restoringUndo = false; }
    return true;
}

/// Keyboard: Delete removes the selected light, Ctrl/Cmd+Z undoes. Lives on window so it works
/// wherever focus sits, but stays out of the way while the user types in a field.
function onKeyDown(event) {
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
                   target.tagName === 'SELECT' || target.isContentEditable)) return;

    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (undo()) notifyChanged();
    }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedLightId !== null) {
        event.preventDefault();
        removeLight(selectedLightId);
        notifyChanged();
    }
}

// The curated look presets — the SINGLE source of truth consumed by both the in-app studio
// page (via getLooksJson) and the standalone Light Studio. Values tuned on a real 3M-triangle
// print (2026-07). "color" omitted = keep the user's current color when switching looks.
export const LOOKS = {
    silvernmm: { label: 'Silver NMM', fixedReference: false,
        appearance: { shader: 'pbr', color: '#c8ccd2', metalness: 1.0, roughness: 0.3, clearcoat: 0, envIntensity: 0.75 } },
    goldnmm: { label: 'Gold NMM', fixedReference: false,
        appearance: { shader: 'pbr', color: '#d9b36c', metalness: 1.0, roughness: 0.3, clearcoat: 0, envIntensity: 0.8 } },
    realmetal: { label: 'Real metal', fixedReference: false,
        appearance: { shader: 'pbr', color: '#d8d8d8', metalness: 1.0, roughness: 0.45, clearcoat: 0, envIntensity: 0.7 } },
    gloss: { label: 'Gloss paint', fixedReference: false,
        appearance: { shader: 'pbr', metalness: 0.0, roughness: 0.18, clearcoat: 0.7, envIntensity: 0.5 } },
    satin: { label: 'Satin paint', fixedReference: false,
        appearance: { shader: 'pbr', metalness: 0.0, roughness: 0.38, clearcoat: 0, envIntensity: 0.25 } },
    matte: { label: 'Matte paint', fixedReference: false,
        appearance: { shader: 'pbr', metalness: 0.0, roughness: 0.85, clearcoat: 0, envIntensity: 0.15 } },
    bands: { label: 'Bands (practice)', fixedReference: false,
        appearance: { shader: 'toon', toonBands: 4 } },
    chrome: { label: 'Chrome', fixedReference: true,
        appearance: { shader: 'matcap', matcap: 'chrome', color: '#ffffff' } },
    gold: { label: 'Gold', fixedReference: true,
        appearance: { shader: 'matcap', matcap: 'gold', color: '#ffffff' } },
    contrast: { label: 'High contrast', fixedReference: true,
        appearance: { shader: 'matcap', matcap: 'highcontrast', color: '#ffffff' } }
};

/// The look presets for non-JS consumers (the Blazor page deserializes this).
export function getLooksJson() {
    return JSON.stringify(LOOKS);
}

// Current appearance state (kept so shader switches preserve color etc., and for getSetup()).
const appearance = {
    shader: 'pbr',          // 'pbr' | 'phong' | 'matcap' | 'toon'
    matcap: 'chrome',
    toonBands: 4,
    color: '#c8ccd2',       // Silver NMM default (matches LightStudio.razor's default look)
    specular: '#ffffff',    // phong: hotspot color
    shininess: 90,          // phong: hotspot tightness
    metalness: 1.0,
    roughness: 0.3,         // mid roughness: hotspots read as SHAPES on dense print meshes
    clearcoat: 0.0,
    envIntensity: 0.75      // studio env = the sky/ground body gradient NMM painters copy
};

// ---------------------------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------------------------

export function init(canvas) {
    canvasEl = canvas;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    // Cap the backing store: dpr beyond 2 quadruples fill cost on a 3M-triangle scene for no
    // visible gain, and VRAM headroom matters — the same GPU often hosts the local AI models.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    // A lost WebGL context (driver reset, VRAM pressure from local AI) otherwise leaves the
    // canvas permanently blank. preventDefault opts into restoration; on restore, rebuild the
    // pieces that live in GPU-only render targets (the PMREM environment) and refresh materials.
    canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        console.warn('lightstudio: WebGL context lost — waiting for restore');
    });
    canvas.addEventListener('webglcontextrestored', () => {
        console.warn('lightstudio: WebGL context restored — rebuilding environment');
        buildEnvironment();
        matcapCache.clear();
        if (mesh) { mesh.material.dispose(); mesh.material = buildMaterial(); }
        if (ground) ground.material.needsUpdate = true;
        requestShadowUpdate();
    });

    // ACES filmic: lifts midtones and rolls off hot speculars, so exaggerated metals read as
    // bright shapes instead of blown streaks. Matcap looks opt out (toneMapped=false) — they
    // are pre-authored reference images. Tuned on a real 3M-triangle print (2026-07).
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    // Shadows: the model blocks light (a lantern behind the body must not light the face).
    // Maps re-render only when the scene actually changes (requestShadowUpdate) — shadowing a
    // 3M-triangle print every frame would not be interactive on typical GPUs.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101315);

    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.position.set(0, 60, 160);

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    // Zoom bounds: past minDistance the camera enters the sculpt and the near plane clips
    // everything away — which reads as the render "going blank".
    controls.minDistance = 15;
    controls.maxDistance = 1200;

    // Precise placement: clicking a light handle shows X/Y/Z arrows; dragging an arrow moves
    // the light along that axis only. Free drag on the ball itself still works.
    axisControl = new TransformControls(camera, canvas);
    axisControl.setMode('translate');
    axisControl.setSize(0.8);
    axisControl.addEventListener('dragging-changed', event => {
        controls.enabled = !event.value;
        if (event.value) captureUndo('arrow', false); // each arrow grab is one undo step
    });
    axisControl.addEventListener('objectChange', () => {
        const entry = selectedLightId !== null ? lights.get(selectedLightId) : null;
        if (entry) {
            clampHandle(entry.gizmo.position);
            syncLightPositions(entry);
        }
    });
    scene.add(axisControl);

    // A soft sky/ground fill so unlit faces read as shape, never pure black. Hemisphere rather
    // than flat ambient: the subtle top-vs-bottom difference keeps form readable on the dark
    // NMM body without competing with the user's placed lights.
    hemi = new THREE.HemisphereLight(0x8fa3b4, 0x4a4238, 0.18);
    scene.add(hemi);

    // Neutral studio environment: PBR metals are mostly reflection — without SOMETHING to
    // reflect they render near-black no matter where the lights sit. Kept subdued so the
    // user's own lights stay the story; matcap/toon looks ignore it entirely.
    buildEnvironment();

    ground = new THREE.Mesh(
        new THREE.CircleGeometry(500, 48),
        applyStudioShaderPatches(
            new THREE.MeshStandardMaterial({ color: new THREE.Color(floorColor), roughness: 0.95 })));
    ground.rotation.x = -Math.PI / 2;
    ground.name = 'ground';
    ground.receiveShadow = true; // the model's cast shadow on the table reads light direction
    scene.add(ground);           // (never castShadow: bounce lights live beneath it)

    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);

    renderer.setAnimationLoop(() => {
        controls.update();
        syncStudioUniforms();
        renderer.render(scene, camera);
    });
}

/// (Re)builds the PMREM studio environment — also called after a WebGL context restore,
/// because prefiltered environments live in render targets that do not survive the loss.
function buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
}

export function dispose() {
    renderer?.setAnimationLoop(null);
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKeyDown);
    renderer?.dispose();
    lights.clear();
    undoStack.length = 0;
    changeCallback = null;
    mesh = null;
}

function resize() {
    if (!canvasEl || !renderer) return;
    const w = canvasEl.clientWidth || 800;
    const h = canvasEl.clientHeight || 600;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // OrbitControls rotation is normalized by canvas HEIGHT (a full-height drag = one turn),
    // which makes big canvases feel sluggish and small ones twitchy. Scale rotateSpeed with
    // height so the feel is constant: ~65° per 100px dragged on any screen.
    if (controls) controls.rotateSpeed = Math.min(2.5, Math.max(0.7, h / 550));
}

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

export function loadStl(bytes) {
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }

    const geometry = new STLLoader().parse(bytes.buffer ?? bytes);
    geometry.computeVertexNormals();
    geometry.center();

    // STLs come in arbitrary units/orientation; many are Z-up. Normalise: Y-up, ~80 units tall,
    // sitting on the ground plane.
    geometry.rotateX(-Math.PI / 2);
    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox.getSize(size);
    const scale = 80 / Math.max(size.x, size.y, size.z);
    geometry.scale(scale, scale, scale);
    geometry.computeBoundingBox();
    geometry.translate(0, -geometry.boundingBox.min.y, 0);
    geometry.computeBoundingSphere();
    modelRadius = geometry.boundingSphere.radius;

    mesh = new THREE.Mesh(geometry, buildMaterial());
    mesh.name = 'model';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    orientation.identity();
    requestShadowUpdate();

    controls.target.set(0, modelRadius * 0.6, 0);
    camera.position.set(0, modelRadius * 1.1, modelRadius * 2.6);

    if (lights.size === 0) applyPreset('keyrim');
    return geometry.attributes.position.count / 3; // triangle count
}

// ---------------------------------------------------------------------------------------------
// Orientation — many print STLs arrive sideways (posed for supports, or a different up-axis
// than the loader's assumption). Quarter-turn steps around world axes, always re-seated on the
// ground; the cumulative orientation persists in rigs so a saved study reloads as it looked.
// ---------------------------------------------------------------------------------------------

const orientation = new THREE.Quaternion();

/// Rotates the model a quarter turn around a world axis: 'x' tips forward/back, 'y' spins,
/// 'z' rolls. quarterTurns is +1 or -1.
export function reorient(axis, quarterTurns) {
    if (!mesh) return;
    captureUndo('orient', false);
    const axes = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
    const step = new THREE.Quaternion().setFromAxisAngle(axes[axis], quarterTurns * Math.PI / 2);
    applyOrientationDelta(step);
}

/// Back to the orientation the model loaded with.
export function resetOrientation() {
    if (!mesh) return;
    captureUndo('orient', false);
    applyOrientationDelta(orientation.clone().invert());
}

function applyOrientationDelta(delta) {
    const geometry = mesh.geometry;

    // Rotate about the model's current center so it pivots in place…
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    geometry.translate(-center.x, -center.y, -center.z);
    geometry.applyQuaternion(delta);

    // …then re-seat it on the ground, centered.
    geometry.computeBoundingBox();
    geometry.translate(
        -(geometry.boundingBox.min.x + geometry.boundingBox.max.x) / 2,
        -geometry.boundingBox.min.y,
        -(geometry.boundingBox.min.z + geometry.boundingBox.max.z) / 2);
    geometry.computeBoundingSphere(); // normals rotate with applyQuaternion; no recompute needed
    modelRadius = geometry.boundingSphere.radius;

    orientation.premultiply(delta);
    requestShadowUpdate();
}

// ---------------------------------------------------------------------------------------------
// Materials & shaders
// ---------------------------------------------------------------------------------------------

const matcapCache = new Map();

// Per-metal matcap recipes, authored in DISK space (see matcapTexture): a bright sky band up
// top, a dark ground band below, a sharp horizon between them, and a punchy specular hotspot —
// the bold, high-contrast reflection NMM painters actually copy. horizon in [-1,1] sets where
// sky meets ground (negative = more sky visible); horizonSoft its sharpness.
const MATCAPS = {
    chrome: {
        skyTop: [0.97, 0.99, 1.0], skyHorizon: [0.42, 0.52, 0.66],
        groundHorizon: [0.02, 0.03, 0.05], groundBottom: [0.18, 0.21, 0.27],
        horizon: -0.05, horizonSoft: 0.035, spec: 1.0, specPower: 70, bounce: 0.35, edge: 0.4
    },
    steel: {
        skyTop: [0.84, 0.87, 0.9], skyHorizon: [0.40, 0.44, 0.5],
        groundHorizon: [0.05, 0.06, 0.08], groundBottom: [0.20, 0.22, 0.26],
        horizon: -0.02, horizonSoft: 0.08, spec: 0.85, specPower: 34, bounce: 0.25, edge: 0.35
    },
    gold: {
        skyTop: [1.0, 0.94, 0.68], skyHorizon: [0.68, 0.46, 0.12],
        groundHorizon: [0.10, 0.05, 0.01], groundBottom: [0.42, 0.27, 0.06],
        horizon: -0.05, horizonSoft: 0.04, spec: 1.0, specPower: 60, bounce: 0.4,
        specColor: [1.0, 0.97, 0.82], edge: 0.4
    },
    bronze: {
        skyTop: [0.94, 0.74, 0.5], skyHorizon: [0.5, 0.31, 0.15],
        groundHorizon: [0.08, 0.04, 0.02], groundBottom: [0.3, 0.18, 0.08],
        horizon: -0.03, horizonSoft: 0.06, spec: 0.85, specPower: 40, bounce: 0.3,
        specColor: [1.0, 0.9, 0.72], edge: 0.38
    },
    highcontrast: {
        skyTop: [1.0, 1.0, 1.0], skyHorizon: [0.5, 0.5, 0.5],
        groundHorizon: [0.0, 0.0, 0.0], groundBottom: [0.12, 0.12, 0.12],
        horizon: 0.0, horizonSoft: 0.02, spec: 1.0, specPower: 90, bounce: 0.2, edge: 0.45
    }
};

// Sphere-shaded matcap in DISK space: the surface normal's screen y maps up-facing pixels to
// the top of the disk (sky) and down-facing to the bottom (ground). This authored parameter-
// isation reads far bolder on dense sculpts than a physically-reflected one, which collapses
// most normals into a muddy mid-tone. Key specular lobe upper-left, small fill lower-right.
function matcapTexture(name) {
    if (matcapCache.has(name)) return matcapCache.get(name);
    const p = MATCAPS[name] ?? MATCAPS.chrome;

    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const image = g.createImageData(size, size);
    const data = image.data;

    const key = normalize([-0.4, 0.5, 0.75]);
    const fill = normalize([0.45, -0.3, 0.84]);
    const specColor = p.specColor ?? [1, 1, 1];
    const horizonSoft = p.horizonSoft ?? 0.05;
    const edgeAmt = p.edge ?? 0.35;
    const smooth = (a, b, x) => {
        const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    };

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const nx = (x + 0.5) / (size / 2) - 1;
            const ny = 1 - (y + 0.5) / (size / 2);
            const r2 = nx * nx + ny * ny;
            const i = (y * size + x) * 4;
            if (r2 > 1) { data[i + 3] = 255; continue; }
            const nz = Math.sqrt(1 - r2);

            // Disk-space vertical: ny in [-1,1], up = sky, down = ground, split at the horizon.
            const sky = smooth(p.horizon - horizonSoft, p.horizon + horizonSoft, ny);
            const skyPos = smooth(p.horizon, 1, ny);
            const groundPos = smooth(p.horizon, -1, ny);
            const base = [0, 0, 0];
            for (let ch = 0; ch < 3; ch++) {
                const skyCol = p.skyHorizon[ch] + (p.skyTop[ch] - p.skyHorizon[ch]) * skyPos;
                const groundCol = p.groundHorizon[ch] + (p.groundBottom[ch] - p.groundHorizon[ch]) * groundPos;
                base[ch] = groundCol + (skyCol - groundCol) * sky;
            }

            const dKey = Math.max(0, nx * key[0] + ny * key[1] + nz * key[2]);
            const dFill = Math.max(0, nx * fill[0] + ny * fill[1] + nz * fill[2]);
            const specKey = Math.pow(dKey, p.specPower) * p.spec;
            const specFill = Math.pow(dFill, p.specPower * 1.5) * p.bounce;
            const edge = Math.pow(1 - nz, 3) * edgeAmt; // darken the silhouette

            for (let ch = 0; ch < 3; ch++) {
                let v = base[ch] * (1 - edge) + (specKey + specFill) * specColor[ch];
                data[i + ch] = Math.round(255 * Math.min(1, Math.max(0, v)));
            }
            data[i + 3] = 255;
        }
    }

    g.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    matcapCache.set(name, texture);
    return texture;
}

function normalize(v) {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
}

function toonGradient(bands) {
    const data = new Uint8Array(bands);
    for (let i = 0; i < bands; i++) data[i] = Math.round((i / (bands - 1)) * 255);
    const texture = new THREE.DataTexture(data, bands, 1, THREE.RedFormat);
    texture.needsUpdate = true;
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    return texture;
}

// ---------------------------------------------------------------------------------------------
// Studio shader patches — lock-specular and painterly shadows.
//
// Lock specular: painted highlights don't move — NMM is painted from ONE chosen viewpoint.
// Locking captures the camera position and substitutes it into the specular/reflection view
// direction (diffuse shading has no view term and stays live), so the painter can orbit to
// reach the far side of the mini while the hotspots stay where they will be painted.
//
// Shadow tint: painters shade toward a COLOUR (usually cool blue-violet), almost never black.
// Strength backs the occlusion off; tint is what the light fades to where it is blocked.
// Black at full strength is bit-identical to the stock behavior.
// ---------------------------------------------------------------------------------------------

const specLock = { on: false, camPos: new THREE.Vector3() };
let shadowTintColor = '#000000';
let shadowStrength = 1.0;

const _lockedCamView = new THREE.Vector3();

/// Patches a lit material's lights chunk. Applied to the model and the ground — the only lit
/// materials in the scene (gizmos and arrows are unlit).
function applyStudioShaderPatches(material) {
    material.onBeforeCompile = shader => {
        shader.uniforms.uSpecLock = { value: specLock.on ? 1 : 0 };
        shader.uniforms.uLockedCamPosView = { value: new THREE.Vector3() };
        shader.uniforms.uShadowTint = { value: new THREE.Color(shadowTintColor) };
        shader.uniforms.uShadowStrength = { value: shadowStrength };

        // The targets live inside lights_fragment_begin, which is still an unexpanded
        // #include at this point — expand that one chunk and patch the expansion.
        const chunk = THREE.ShaderChunk.lights_fragment_begin
            .replace(
                'vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );',
                'vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : ' +
                'normalize( mix( vViewPosition, uLockedCamPosView + vViewPosition, uSpecLock ) );')
            .replace(
                /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? (get(?:Point)?Shadow\( [^;]*?) : 1\.0;/g,
                'directLight.color *= mix( uShadowTint, vec3( 1.0 ), ' +
                'mix( 1.0, ( ( directLight.visible && receiveShadow ) ? $1 : 1.0 ), uShadowStrength ) );');

        shader.fragmentShader = shader.fragmentShader
            .replace('#include <lights_fragment_begin>', chunk)
            .replace('void main() {',
                'uniform float uSpecLock;\nuniform vec3 uLockedCamPosView;\n' +
                'uniform vec3 uShadowTint;\nuniform float uShadowStrength;\nvoid main() {');

        material.userData.studioShader = shader;
    };
    // Without a distinct key three.js reuses the unpatched program compiled for other
    // materials of the same class.
    material.customProgramCacheKey = () => 'studio-patch-v1';
    return material;
}

/// Per-frame: feed the patched programs the lock/tint state. The locked camera position must
/// be re-expressed in the CURRENT view space every frame — that is what keeps the frozen
/// world-space view direction constant while the live camera orbits.
function syncStudioUniforms() {
    _lockedCamView.copy(specLock.camPos).applyMatrix4(camera.matrixWorldInverse);
    for (const material of [mesh?.material, ground?.material]) {
        const shader = material?.userData?.studioShader;
        if (!shader) continue;
        shader.uniforms.uSpecLock.value = specLock.on ? 1 : 0;
        shader.uniforms.uLockedCamPosView.value.copy(_lockedCamView);
        shader.uniforms.uShadowTint.value.set(shadowTintColor);
        shader.uniforms.uShadowStrength.value = shadowStrength;
    }
}

/// Locking captures the highlights as seen RIGHT NOW; unlocking goes back to live reflections.
export function setSpecularLock(on) {
    captureUndo('speclock', false);
    specLock.on = !!on;
    if (specLock.on && camera) specLock.camPos.copy(camera.position);
}

export function getSpecularLock() {
    return specLock.on;
}

export function setShadowTint(options) {
    captureUndo('shadowtint', true);
    if (options.color !== undefined) shadowTintColor = options.color;
    if (options.strength !== undefined) shadowStrength = Math.min(1, Math.max(0, options.strength));
}

/// JSON {color, strength} — a string so the Blazor page can consume it without a DTO.
export function getShadowTint() {
    return JSON.stringify({ color: shadowTintColor, strength: shadowStrength });
}

function buildMaterial() {
    const color = new THREE.Color(appearance.color);
    switch (appearance.shader) {
        case 'matcap': {
            // Fixed idealized reflection — deliberately IGNORES the scene lights, and skips tone
            // mapping so the authored reference colors arrive on screen untouched.
            const material = new THREE.MeshMatcapMaterial({ color, matcap: matcapTexture(appearance.matcap) });
            material.toneMapped = false;
            return material;
        }
        case 'toon': {
            // Half the color internally: physically-bright lights would otherwise push every
            // band to the top and the band edges — the whole point of this look — vanish.
            const dimmed = color.clone().multiplyScalar(0.5);
            return applyStudioShaderPatches(
                new THREE.MeshToonMaterial({ color: dimmed, gradientMap: toonGradient(appearance.toonBands) }));
        }
        case 'phong':
            // Exaggerated NMM metal that FOLLOWS the user's lights: dark metal body with big
            // punchy painterly hotspots — the classic look NMM tutorials paint from.
            return applyStudioShaderPatches(new THREE.MeshPhongMaterial({
                color,
                specular: new THREE.Color(appearance.specular ?? '#ffffff'),
                shininess: appearance.shininess ?? 90
            }));
        default:
            return applyStudioShaderPatches(new THREE.MeshPhysicalMaterial({
                color,
                metalness: appearance.metalness,
                roughness: appearance.roughness,
                clearcoat: appearance.clearcoat,
                // Scaled by the ambient "room light" level — metals show the room, not the fill.
                envMapIntensity: (appearance.envIntensity ?? 0.4) * ambientEnvScale()
            }));
    }
}

// The "room light" level. Hemisphere fill alone only reaches DIFFUSE materials — the metal
// looks (metalness 1) ignore it entirely — so ambient also scales the studio environment's
// reflection intensity, which is what metal bodies actually show. Factor 1.0 at the default
// level, so the tuned looks are unchanged until the user moves the slider.
const DEFAULT_AMBIENT = 0.18;
let ambientLevel = DEFAULT_AMBIENT;

function ambientEnvScale() {
    return Math.min(2.5, ambientLevel / DEFAULT_AMBIENT);
}

/// Tone mapping control (dev/tuning hook). ACES lifts midtones and rolls off blown highlights.
export function setToneMapping(mode, exposure) {
    if (!renderer) return;
    renderer.toneMapping = mode === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = exposure ?? 1.0;
    if (mesh) mesh.material.needsUpdate = true;
}

/// Adjusts the always-on ambient fill (user-facing; saved in rigs since setup v2). Drives the
/// hemisphere (diffuse looks) AND the environment reflection scale (metal looks) together.
export function setEnvironmentLight(options) {
    if (!hemi) return;
    captureUndo('ambient', true);
    if (options.intensity !== undefined) {
        ambientLevel = Math.max(0, options.intensity);
        hemi.intensity = ambientLevel;
        if (mesh && mesh.material.envMapIntensity !== undefined) {
            mesh.material.envMapIntensity = (appearance.envIntensity ?? 0.4) * ambientEnvScale();
            mesh.material.needsUpdate = true;
        }
    }
    if (options.sky !== undefined) hemi.color.set(options.sky);
    if (options.ground !== undefined) hemi.groundColor.set(options.ground);
}

export function setAppearance(update) {
    captureUndo('appearance', true);
    Object.assign(appearance, update);
    if (mesh) {
        mesh.material.dispose();
        mesh.material = buildMaterial();
    }
}

// ---------------------------------------------------------------------------------------------
// Lights (with draggable gizmos)
// ---------------------------------------------------------------------------------------------

// three r155+ physical lighting: point-light intensity is candela with distance falloff, so
// raw slider values (0-4) vanish at this scene's ~100-unit light distances. UI and saved rigs
// keep the friendly 0-4 scale; converted here so a point light at the reference distance hits
// the model with exactly its slider value REGARDLESS of its falloff exponent — the falloff
// slider then only changes the curve shape (how fast it dims), not overall brightness.
const POINT_REFERENCE_DISTANCE = 100;
const pointCandela = (ui, decay) => ui * Math.pow(POINT_REFERENCE_DISTANCE, decay);
const clampDecay = value => Math.min(3, Math.max(0.5, value ?? 2));

// Near→far color gradient (OSL: candle flame yellow up close, red glow farther out).
// Emulated with a co-located PAIR of point lights: the near color decays faster, the far color
// slower, so their mix shifts with distance — the same trick painters use in paint. The two are
// balanced so their contributions CROSS at ~a third of the reference distance (i.e. within the
// model, where the gradient is actually visible) while the pair still totals the slider value
// at the reference distance, keeping brightness semantics identical to a plain light.
const GRADIENT_NEAR_EXTRA = 1.0;  // near light decays this much faster
const GRADIENT_FAR_LESS = 0.6;    // far light decays this much slower
// Where the two colors meet, as a fraction of the reference distance — user-adjustable per
// light ("gradient start"): small = the far tint takes over almost immediately (tight inner
// glow), large = the near color carries far before shifting.
const DEFAULT_GRADIENT_START = 0.35;
const clampGradientStart = value => Math.min(1.0, Math.max(0.08, value ?? DEFAULT_GRADIENT_START));

// Source size: a physical light has AREA — bigger sources give broader speculars and soft
// shadow edges (softbox vs candle). Three.js area lights cannot cast shadows, so size > 0
// expands each emitter into a tetrahedral cluster of four sub-lights spread over that radius,
// each at quarter intensity: highlights merge into a broader shape and the four overlapping
// shadow maps form a real penumbra.
const CLUSTER_OFFSETS = [
    new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, -1, -1),
    new THREE.Vector3(-1, 1, -1), new THREE.Vector3(-1, -1, 1)
].map(v => v.normalize());

function makePointEmitter(objects, color, candela, decay, size, castShadows = true) {
    if (size <= 0) {
        const light = new THREE.PointLight(color, candela, 0, decay);
        if (castShadows) configureShadowCaster(light);
        objects.push(light);
        return;
    }
    // ONE shadow caster per emitter, not four: every point caster is a six-render cube map,
    // and two "large" lights used to mean 8-16 of them — reliable context loss on 8 GB GPUs.
    // Softness now comes from the caster's PCF radius scaling with the source size.
    let needsCaster = castShadows;
    for (const offset of CLUSTER_OFFSETS) {
        const light = new THREE.PointLight(color, candela / CLUSTER_OFFSETS.length, 0, decay);
        light.userData.clusterOffset = offset.clone().multiplyScalar(size);
        if (needsCaster) {
            configureShadowCaster(light);
            light.shadow.radius = 2 + size * 0.4;
            needsCaster = false;
        }
        objects.push(light);
    }
}

function buildLightObjects(entry) {
    const objects = [];
    if (entry.type === 'directional') {
        // Parallel rays from infinity — "source size" has no meaning here, so directional lights
        // are always a single sharp caster (size applies to point lights only).
        const light = new THREE.DirectionalLight(new THREE.Color(entry.color), entry.uiIntensity);
        light.target.position.set(0, modelRadius * 0.6, 0);
        configureShadowCaster(light);
        objects.push(light);
    }
    else if (entry.farColor) {
        const dNear = Math.min(4, entry.decay + GRADIENT_NEAR_EXTRA);
        const dFar = Math.max(0.3, entry.decay - GRADIENT_FAR_LESS);
        // Equal contribution A at the crossover distance x; the pair totals the slider value at
        // the reference distance: A = ui / (t^dNear + t^dFar) with t = x/REF, candela = A·x^d.
        const t = clampGradientStart(entry.gradientStart);
        const x = t * POINT_REFERENCE_DISTANCE;
        const A = entry.uiIntensity / (Math.pow(t, dNear) + Math.pow(t, dFar));
        // The near emitter casts the shadow; the far tint shares its position, so a second
        // cube map would buy nothing but VRAM pressure.
        makePointEmitter(objects, new THREE.Color(entry.color), A * Math.pow(x, dNear), dNear, entry.size, true);
        makePointEmitter(objects, new THREE.Color(entry.farColor), A * Math.pow(x, dFar), dFar, entry.size, false);
    }
    else {
        makePointEmitter(objects, new THREE.Color(entry.color),
            pointCandela(entry.uiIntensity, entry.decay), entry.decay, entry.size);
    }

    // Ground bounce (NMM's reflected under-light): light returned by the floor into the
    // model's undersides — the secondary highlight painters place under jaws, arms, and
    // shield rims. Tinted by the FLOOR's color. The scene casts no shadows, so below-ground
    // lights reach the model unobstructed while the ground itself (normals up) ignores them.
    if (entry.bounceStrength > 0) {
        let bounce;
        if (entry.type === 'directional') {
            // Uniform incident light bounces uniformly: straight back up, everywhere.
            bounce = new THREE.DirectionalLight(floorBounceTint(), entry.uiIntensity * entry.bounceStrength);
            bounce.position.set(0, -100, 0);
            bounce.target.position.set(0, 0, 0);
        }
        else {
            // A point light bounces from the bright patch on the table under it.
            bounce = new THREE.PointLight(floorBounceTint(),
                pointCandela(entry.uiIntensity * entry.bounceStrength, entry.decay), 0, entry.decay);
        }
        bounce.userData.groundMirror = true;
        objects.push(bounce);
    }
    return objects;
}

/// Positions an entry's light objects at its gizmo — bounce lights sit SHALLOW below the
/// ground under the light's footprint (where the bright reflected patch on a real table is),
/// which puts them close to the model's undersides for a readable grazing under-light.
function syncLightPositions(entry) {
    const p = entry.gizmo.position;
    for (const light of entry.lights) {
        if (light.userData.groundMirror) {
            // Point bounce tracks the bright patch under its parent; directional bounce is
            // uniform up-light whose position (hence direction) is fixed.
            if (light.isPointLight) light.position.set(p.x, -modelRadius * 0.3, p.z);
        }
        else if (light.userData.clusterOffset) light.position.copy(p).add(light.userData.clusterOffset);
        else light.position.copy(p);
    }
    requestShadowUpdate();
}

function mountLights(entry) {
    entry.lights = buildLightObjects(entry);
    for (const light of entry.lights) {
        scene.add(light);
        if (light.target) scene.add(light.target);
    }
    syncLightPositions(entry);
    requestShadowUpdate();
}

function unmountLights(entry) {
    for (const light of entry.lights ?? []) {
        scene.remove(light);
        if (light.target) scene.remove(light.target);
    }
    entry.lights = [];
}

export function addLight(type, options) {
    captureUndo('lights', false);
    const id = nextLightId++;

    // The draggable handle: an unlit glowing ball where the light sits.
    const gizmoMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(options?.color ?? '#ffffff') });
    gizmoMaterial.toneMapped = false; // handles keep their exact marker color
    const gizmo = new THREE.Mesh(new THREE.SphereGeometry(3.2, 16, 16), gizmoMaterial);
    clampHandle(gizmo.position.set(options?.x ?? 40, options?.y ?? 90, options?.z ?? 60));
    gizmo.userData.lightId = id;
    scene.add(gizmo);

    const entry = {
        type, gizmo,
        color: options?.color ?? '#ffffff',
        farColor: type === 'point' ? (options?.farColor ?? null) : null,
        uiIntensity: options?.intensity ?? 1.0,
        decay: clampDecay(options?.decay),
        gradientStart: clampGradientStart(options?.gradientStart),
        bounceStrength: Math.min(1, Math.max(0, options?.bounceStrength ?? 0)),
        size: type === 'point' ? Math.min(24, Math.max(0, options?.size ?? 0)) : 0,
        enabled: options?.enabled !== false // switched off but kept: the dimmed handle stays put
    };
    entry.gizmo.scale.setScalar(1 + entry.size / 8); // the handle hints at the source size
    applyGizmoEnabledLook(entry);
    if (entry.enabled) mountLights(entry);
    else entry.lights = [];
    lights.set(id, entry);
    return id;
}

/// A switched-off light keeps its handle as a dim ghost so it can still be selected and moved.
function applyGizmoEnabledLook(entry) {
    entry.gizmo.material.transparent = !entry.enabled;
    entry.gizmo.material.opacity = entry.enabled ? 1 : 0.3;
}

export function updateLight(id, update) {
    const entry = lights.get(id);
    if (!entry) return;
    captureUndo('update:' + id, true);

    if (update.color !== undefined) {
        entry.color = update.color;
        entry.gizmo.material.color.set(update.color);
    }
    if (update.farColor !== undefined) entry.farColor = entry.type === 'point' ? update.farColor : null;
    if (update.intensity !== undefined) entry.uiIntensity = update.intensity;
    if (update.decay !== undefined) entry.decay = clampDecay(update.decay);
    if (update.gradientStart !== undefined) entry.gradientStart = clampGradientStart(update.gradientStart);
    if (update.bounceStrength !== undefined)
        entry.bounceStrength = Math.min(1, Math.max(0, update.bounceStrength));
    if (update.size !== undefined) {
        entry.size = entry.type === 'point' ? Math.min(24, Math.max(0, update.size)) : 0;
        entry.gizmo.scale.setScalar(1 + entry.size / 8);
    }
    if (update.enabled !== undefined) {
        entry.enabled = !!update.enabled;
        applyGizmoEnabledLook(entry);
    }
    if (update.x !== undefined) clampHandle(entry.gizmo.position.set(update.x, update.y, update.z));

    // Rebuild rather than mutate: color/decay/gradient changes can change the NUMBER of
    // underlying lights, and ≤4 rig lights make this trivially cheap.
    unmountLights(entry);
    if (entry.enabled) mountLights(entry);
    else requestShadowUpdate(); // a removed caster leaves its shadow behind otherwise
}

export function removeLight(id) {
    const entry = lights.get(id);
    if (!entry) return;
    captureUndo('lights', false);
    if (selectedLightId === id) selectLight(null);
    unmountLights(entry);
    scene.remove(entry.gizmo);
    lights.delete(id);
    requestShadowUpdate();
}

export function clearLights() {
    captureUndo('lights', false);
    withUndoSuppressed(() => {
        for (const id of [...lights.keys()]) removeLight(id);
    });
}

/// Duplicates a light with all its settings, placed beside the original and selected.
export function cloneLight(id) {
    const entry = lights.get(id);
    if (!entry) return null;
    const newId = addLight(entry.type, {
        x: entry.gizmo.position.x + Math.max(10, modelRadius * 0.3),
        y: entry.gizmo.position.y,
        z: entry.gizmo.position.z,
        color: entry.color,
        farColor: entry.farColor,
        intensity: entry.uiIntensity,
        decay: entry.decay,
        gradientStart: entry.gradientStart,
        bounceStrength: entry.bounceStrength,
        size: entry.size
    });
    selectLight(newId);
    return newId;
}

export function applyPreset(name) {
    captureUndo('preset', false);
    withUndoSuppressed(() => {
        clearLights();
        const r = modelRadius;
        switch (name) {
            case 'zenithal':
                addLight('directional', { x: 0, y: r * 3, z: 0, intensity: 2.2 });
                addLight('point', { x: 0, y: r * 0.4, z: r * 2.2, color: '#8899aa', intensity: 0.35 });
                break;
            case 'candle':
                // Fire gradient: warm yellow up close shifting to deep red-orange farther out,
                // with a fast falloff — the classic OSL study. (2.6 pre-ACES blew out the core.)
                addLight('point', { x: r * 0.9, y: r * 0.5, z: r * 1.2, color: '#ffd27a',
                    farColor: '#c23f14', intensity: 1.6, decay: 2.4 });
                break;
            default: // keyrim — the key gets a ground bounce (the classic NMM under-light)
                addLight('point', { x: r * 1.6, y: r * 1.8, z: r * 1.6, intensity: 2.0, bounceStrength: 0.5 });
                addLight('point', { x: -r * 1.8, y: r * 1.2, z: -r * 1.4, color: '#7fb4ff', intensity: 1.1 });
                break;
        }
    });
    return getLightsJson();
}

export function getLightsJson() {
    const list = [];
    for (const [id, entry] of lights) {
        list.push({
            id, type: entry.type,
            x: entry.gizmo.position.x, y: entry.gizmo.position.y, z: entry.gizmo.position.z,
            color: entry.color,
            farColor: entry.farColor,
            intensity: entry.uiIntensity,
            decay: entry.decay,
            gradientStart: entry.gradientStart,
            bounceStrength: entry.bounceStrength,
            size: entry.size,
            enabled: entry.enabled,
            selected: id === selectedLightId
        });
    }
    return JSON.stringify(list);
}

// Drag handling: grab a gizmo, move it on the camera-facing plane through its position.
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const dragPlane = new THREE.Plane();
let dragging = null;

function setPointer(event) {
    const rect = canvasEl.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function onPointerDown(event) {
    if (axisControl?.dragging) return; // an arrow grab is in progress — it owns this gesture

    setPointer(event);
    raycaster.setFromCamera(pointer, camera);
    const gizmos = [...lights.values()].map(entry => entry.gizmo);
    const hit = raycaster.intersectObjects(gizmos)[0];
    if (!hit) {
        // Empty click puts the arrows away (axis grabs never reach here — see above).
        if (selectedLightId !== null) { selectLight(null); notifyChanged(); }
        return;
    }

    if (selectedLightId !== hit.object.userData.lightId) {
        selectLight(hit.object.userData.lightId);
        notifyChanged(); // the panel highlights the selected light's card
    }
    captureUndo('drag', false); // each handle grab is one undo step
    dragging = hit.object.userData.lightId;
    dragPlane.setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()).negate(), hit.object.position);
    controls.enabled = false;
    canvasEl.setPointerCapture(event.pointerId);
}

/// Shows the X/Y/Z arrows on one light's handle (null hides them).
export function selectLight(id) {
    selectedLightId = id;
    const entry = id !== null ? lights.get(id) : null;
    if (entry) axisControl.attach(entry.gizmo);
    else axisControl.detach();
}

function onPointerMove(event) {
    if (dragging === null) return;
    setPointer(event);
    raycaster.setFromCamera(pointer, camera);
    const point = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, point)) {
        const entry = lights.get(dragging);
        entry.gizmo.position.copy(point);
        clampHandle(entry.gizmo.position);
        syncLightPositions(entry);
    }
}

function onPointerUp() {
    dragging = null;
    controls.enabled = true;
}

// ---------------------------------------------------------------------------------------------
// Persistence & capture
// ---------------------------------------------------------------------------------------------

export function getSetup() {
    return JSON.stringify({
        version: 3,
        appearance,
        orientation: orientation.toArray(),
        floor: { color: floorColor },
        shadows: shadowsEnabled,
        shadowTint: { color: shadowTintColor, strength: shadowStrength },
        specularLock: { on: specLock.on, position: specLock.camPos.toArray() },
        ambient: {
            intensity: ambientLevel,
            sky: '#' + (hemi?.color.getHexString() ?? '8fa3b4'),
            ground: '#' + (hemi?.groundColor.getHexString() ?? '4a4238')
        },
        lights: JSON.parse(getLightsJson()),
        camera: { position: camera.position.toArray(), target: controls.target.toArray() }
    });
}

export function applySetup(json) {
    captureUndo('load', false);
    const setup = JSON.parse(json);
    withUndoSuppressed(() => {
        if (setup.appearance) setAppearance(setup.appearance);
        if (setup.ambient) setEnvironmentLight(setup.ambient); // v1 rigs simply keep the default
        if (setup.floor) setFloor(setup.floor);
        if (setup.shadows !== undefined) setShadows(setup.shadows);
        if (setup.shadowTint) setShadowTint(setup.shadowTint);
        if (setup.specularLock) {
            specLock.on = !!setup.specularLock.on;
            if (setup.specularLock.position) specLock.camPos.fromArray(setup.specularLock.position);
        }
        if (setup.orientation && mesh) {
            // Bring the CURRENT geometry to the saved orientation, whatever it is now.
            const target = new THREE.Quaternion().fromArray(setup.orientation);
            applyOrientationDelta(target.multiply(orientation.clone().invert()));
        }
        clearLights();
        for (const l of setup.lights ?? [])
            addLight(l.type, l);
    });
    if (setup.camera) {
        camera.position.fromArray(setup.camera.position);
        controls.target.fromArray(setup.camera.target);
    }
    return getLightsJson();
}

/// Current ambient (room light) level, for the UI slider.
export function getAmbientIntensity() {
    return ambientLevel;
}

/// How many lights are rendering shadow maps right now (diagnostics; point casters cost 6x).
export function getShadowCasterCount() {
    let count = 0;
    for (const entry of lights.values())
        for (const light of entry.lights ?? []) if (light.castShadow) count++;
    return count;
}

export function screenshot() {
    // Captures are reference images — the manipulation arrows must not appear in them.
    const arrowsVisible = axisControl?.visible ?? false;
    if (axisControl) axisControl.visible = false;
    requestShadowUpdate();
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    if (axisControl) axisControl.visible = arrowsVisible;
    return dataUrl;
}
