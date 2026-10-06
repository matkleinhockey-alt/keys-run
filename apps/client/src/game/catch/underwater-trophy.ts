/**
 * The underwater mirror of game/catch/portrait.ts's studio portrait: a diver in a wetsuit, mask
 * and snorkel holding the just-speared catch up toward camera, submerged — "display the fish
 * with a guy in a wetsuit and snorkel holding it underwater showing you the size and species
 * like the fishing above water" (the task brief, verbatim). Same offscreen-render-target ->
 * 2D-canvas approach as the surface card, reusing render-pipeline.ts's shared plumbing — see that
 * file's header for why (a second WebGL context has knocked out the main one on some devices).
 *
 * ## Procedural, not rigged — and why
 *
 * The diver figure here is built from primitives (capsule torso, sphere head, cylinder limbs),
 * not a glTF through the crew-model asset pipeline (entities/crew-model/**, which rigs Mixamo
 * skeletons onto sourced meshes for the dancing deck crew). Three reasons, in order:
 *
 * 1. This is one static hold, not a loop. The crew pipeline's whole reason to exist is a looping
 *    animation (`AnimationMixer` + a Mixamo clip) — there's no clip for "grip-and-grin a fish
 *    underwater," and authoring one means sourcing/rigging a new wetsuit mesh through Blender
 *    (packages/assets-pipeline/scripts/*.blender.py) for a single pose. That's real turnaround
 *    for a one-pose figure.
 * 2. The one thing this shot lives or dies on — hands actually meeting the fish, not floating
 *    near it — is exactly the thing procedural two-bone IK nails *by construction*: the fish's
 *    own grip points (computed from its real bounding box, below) are passed in as the IK
 *    targets, so the hand mesh is centered exactly on the fish's surface, not eyeballed into
 *    roughly the right place. A rigged hand would need the same IK-style retargeting to grip a
 *    fish whose length changes every catch anyway, at which point the mesh is doing no less work
 *    than a procedural one for the one part of the pose that matters most.
 * 3. Precedent: legacy/index.html's `makeHuman` (1214-1360) already proved procedural posed
 *    humans with two-bone IK arms work fine at this project's visual fidelity (it's how every
 *    crew member looked before the Mixamo swap). This is a trimmed, TS port of that same
 *    technique — arms only, no legs (the frame crops at the waist), ported fresh rather than
 *    copying the legacy globals (`HUMANS`/`camera`/`boat` don't exist in this codebase's module
 *    boundaries).
 *
 * The honest tradeoff: a rigged asset would have better skin/wetsuit shading (real UVs/textures
 * vs flat-shaded primitives) if one existed. It doesn't, and building one well was judged not to
 * be worth the Blender round-trip for a figure that's mostly cropped out of frame below the
 * shoulders. See this task's report for the honest look at how the pose itself reads.
 */
import * as THREE from 'three';
import { makeFishMesh } from '../fishing/fish-mesh.js';
import { buildOffscreenRig, readback, buildGradientEnv, resyncRigSize, type OffscreenRig } from './render-pipeline.js';
import { buildFigure, type Figure } from './figure.js';

export interface UnderwaterTrophy {
  show(color: string, lenM: number): void;
  render(renderer: THREE.WebGLRenderer, t: number): void;
  clear(): void;
}

// ---- underwater environment --------------------------------------------------------------------

/** Darker, blue-green, no bright "sun" patch — the whole point is that this does NOT look like
 * the surface card with a different backdrop (task brief). Cached separately from portrait.ts's
 * `sharedEnv`: a different look, not a reuse of the same texture. */
let sharedUwEnv: THREE.Texture | null = null;
function ensureUwEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  if (sharedUwEnv) return sharedUwEnv;
  sharedUwEnv = buildGradientEnv(renderer, {
    top: 0x1c4a52, horizon: 0x0c2e36, deep: 0x02090c,
    accent: { color: 0x7fd9c9, intensity: 1.6, pos: [6, 14, 4], radius: 4 },
    bounce: { color: 0x154a55, intensity: 0.9, pos: [-10, -6, 6], radius: 6 },
  });
  return sharedUwEnv;
}

function buildUwBackdrop(): THREE.CanvasTexture {
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#0f3a44');
  grad.addColorStop(0.45, '#0a2630');
  grad.addColorStop(1, '#010708');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // A soft downwelling-light column rather than a centred glow — reads as sunlight filtering
  // down through water from above, not a studio softbox.
  const beam = ctx.createRadialGradient(size * 0.42, -size * 0.1, size * 0.05, size * 0.5, size * 0.55, size * 0.95);
  beam.addColorStop(0, 'rgba(150,220,210,0.22)');
  beam.addColorStop(1, 'rgba(150,220,210,0)');
  ctx.fillStyle = beam;
  ctx.fillRect(0, 0, size, size);
  const vig = ctx.createRadialGradient(size / 2, size * 0.55, size * 0.25, size / 2, size * 0.55, size * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A sparse field of particulate drifting past the subject — cheap stand-in for marine snow in
 * this isolated scene (world/underwater/marine-snow.ts's real pooled system is wired to the main
 * camera/composer, not something this offscreen rig can reuse without that plumbing). */
function buildParticulate(): THREE.Points {
  const N = 60;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 1.6;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 1.4 + 0.1;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 1.2 + 0.1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xdcf2ee, size: 0.012, transparent: true, opacity: 0.35, depthWrite: false, sizeAttenuation: true });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

interface TrophyRig extends OffscreenRig {
  pivot: THREE.Group;
  diver: Figure | null;
  fish: THREE.Group | null;
  particulate: THREE.Points;
  key: THREE.DirectionalLight;
  last: number;
}

function disposeFishMesh(mesh: THREE.Group): void {
  mesh.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose()); else mat?.dispose();
  });
}

/** Same `MeshPhysicalMaterial` wet-skin swap portrait.ts's `applyPortraitMaterial` does — kept as
 * a local copy rather than an import since the two want slightly different parameters (less
 * clearcoat punch here; underwater light is softer/more scattered) and sharing one function
 * across two unrelated tuning knobs is the kind of "shared machinery" that actively makes future
 * changes to either harder, not easier. */
function applyWetFishMaterial(mesh: THREE.Group): void {
  mesh.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    m.material = new THREE.MeshPhysicalMaterial({
      color: src.color.clone(), roughness: 0.4, metalness: 0.05,
      clearcoat: 0.45, clearcoatRoughness: 0.3, envMapIntensity: 0.9,
    });
  });
}

/** `canvasId` is the same `#fishCanvas` the surface portrait draws into — only one of the two is
 * ever "shown" at a time (a rod catch and a speared catch can't both be the current catch), so
 * they can share the DOM canvas without stepping on each other; each keeps its own independent
 * rig/render-target. */
export function createUnderwaterTrophy(canvasId: string): UnderwaterTrophy {
  let rig: TrophyRig | null = null;

  function ensureRig(): TrophyRig | null {
    if (rig) return rig;
    const scene = new THREE.Scene();
    scene.background = buildUwBackdrop();
    // Brighter overall than a strictly "moody" underwater grade would be — legible species/size
    // is the functional point of this card (task brief), and the first render pass (dark key +
    // near-black wetsuit/gloves) measured as the hands/arms being essentially unreadable against
    // the backdrop. Still blue-green shifted throughout, just not under-lit.
    scene.add(new THREE.HemisphereLight(0x4a7e82, 0x061015, 0.55));
    // Downwelling "sunlight through water" key, blue-green shifted and from almost directly
    // above — the single biggest thing that keeps this from reading as the surface card with a
    // different backdrop.
    const key = new THREE.DirectionalLight(0xcdf0e6, 1.5);
    key.position.set(1.5, 5, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x2a7382, 0.55);
    fill.position.set(-1.5, -0.5, 2.2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0x9ee8da, 0.9);
    rim.position.set(-2, 1.5, -2.5);
    scene.add(rim);
    // A dedicated front-fill aimed at roughly where the hands/fish always are (chestZ..+0.4 in Z)
    // — the key/rim above are both grazing/top-down by design (that's what reads as "underwater"),
    // which left the one thing this shot lives or dies on relatively dim.
    const handFill = new THREE.DirectionalLight(0xdfffe8, 0.5);
    handFill.position.set(0.5, 0.6, 3);
    scene.add(handFill);

    // Aspect corrected from the rig's real dimensions below — `buildOffscreenRig` resizes the
    // backing store for the display, so cv.width here is the pre-resize value.
    const camera = new THREE.PerspectiveCamera(34, 640 / 300, 0.05, 50);
    const base = buildOffscreenRig(canvasId, scene, camera);
    if (base) { camera.aspect = base.w / base.h; camera.updateProjectionMatrix(); }
    if (!base) return null;
    const pivot = new THREE.Group();
    scene.add(pivot);
    const particulate = buildParticulate();
    pivot.add(particulate);
    rig = { ...base, pivot, diver: null, fish: null, particulate, key, last: -1 };
    return rig;
  }

  function show(color: string, lenM: number): void {
    // This rig and the surface portrait's share `#fishCanvas`, so either one resizing it leaves
    // the other's cached render target and ImageData stale — both re-sync on show. (It is also
    // where the real display size first exists; the card is display:none until a catch.)
    if (rig && resyncRigSize(rig, canvasId)) { rig.camera.aspect = rig.w / rig.h; rig.camera.updateProjectionMatrix(); }
    const r = ensureRig();
    if (!r) return;
    // A previous catch's render() may have left the pivot mid-sway (see render()'s gentle float)
    // — reset before measuring anything below, so the camera-fit math sees the same identity
    // transform the next render() call starts from, not a stale offset from the last catch.
    r.pivot.position.set(0, 0, 0);
    r.pivot.rotation.set(0, 0, 0);
    if (r.diver) { r.pivot.remove(r.diver.group); r.diver.dispose(); r.diver = null; }
    if (r.fish) { r.pivot.remove(r.fish); disposeFishMesh(r.fish); r.fish = null; }

    const diver = buildFigure('diver');
    r.pivot.add(diver.group);
    r.diver = diver;

    const fish = makeFishMesh(color, lenM);
    const box = new THREE.Box3().setFromObject(fish);
    const totalLen = Math.max(0.05, box.max.z - box.min.z);
    const midZLocal = (box.max.z + box.min.z) / 2;
    // Both hands land within comfortable IK reach regardless of species length (see this file's
    // header, point 2) — capped half-span rather than the fish's actual nose/tail extremes, so a
    // big fish is held mid-body with its ends extending past the hands (how a real grip-and-grin
    // photo holds anything bigger than an armspan), while a small fish still gets both hands
    // spread across most of its own length.
    const halfSpanLocal = Math.min(totalLen * 0.41, 0.34);

    // Pose: nose-to-tail axis running mostly left-right (classic "look how big" broadside read),
    // a touch of upward tilt, held out in front of the chest toward camera.
    const fishAxis = new THREE.Vector3(1, 0.14, 0).normalize();
    const fishPos = new THREE.Vector3(0, -0.04, 0.34);
    const fishQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fishAxis);
    fish.position.copy(fishPos);
    fish.quaternion.copy(fishQuat);
    applyWetFishMaterial(fish);
    r.pivot.add(fish);
    r.fish = fish;

    const toPivotSpace = (localZ: number): THREE.Vector3 =>
      new THREE.Vector3(0, 0, localZ).applyQuaternion(fishQuat).add(fishPos);
    const gripA = toPivotSpace(midZLocal - halfSpanLocal);
    const gripB = toPivotSpace(midZLocal + halfSpanLocal);
    diver.poseArms(gripA, gripB);

    // Camera: fit the REAL extents of what the shot should actually show — head/snorkel/
    // shoulders/hands (`framePoints()`, deliberately NOT the torso — see TORSO_BOTTOM_Y's comment,
    // the torso is meant to run out the bottom of frame, not shrink everything else to fit it)
    // plus the fish's own full bounding box (it usually reaches past the capped hand-grip span —
    // see `halfSpanLocal` above). Measured from real geometry, not a guessed coefficient — a
    // snorkel sticking up above the head is exactly the kind of extent a hand-picked constant
    // would silently crop or, as happened here first, silently over-crop everything else to fit.
    const frameBox = new THREE.Box3();
    for (const p of diver.framePoints()) frameBox.expandByPoint(p);
    frameBox.union(new THREE.Box3().setFromObject(fish));
    const size = frameBox.getSize(new THREE.Vector3());
    const center = frameBox.getCenter(new THREE.Vector3());

    const cam = r.camera;
    const fovV = cam.fov * Math.PI / 180;
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * cam.aspect);
    const MARGIN = 1.2; // a little headroom/sideroom rather than an edge-to-edge crop
    const dH = (size.y / 2) / Math.tan(fovV / 2);
    const dW = (size.x / 2) / Math.tan(fovH / 2);
    const dv = Math.max(dH, dW, 0.3) * MARGIN;
    cam.near = 0.03; cam.far = dv + size.z + 4;
    // Headroom: aim slightly above the box's true vertical centre so the subject sits a touch
    // low in frame instead of dead-centre (same convention portrait.ts's `show()` uses).
    const lookY = center.y + size.y * 0.08;
    cam.position.set(center.x, lookY, center.z + dv);
    cam.lookAt(center.x, lookY, center.z);
    cam.updateProjectionMatrix();

    r.particulate.scale.setScalar(Math.max(0.6, dv * 0.6));
    r.particulate.position.set(center.x, center.y, center.z);
    r.last = -1;
  }

  function render(renderer: THREE.WebGLRenderer, t: number): void {
    const r = rig;
    if (!r || !r.diver) return;
    if (t - r.last < 0.12) return;
    r.last = t;
    if (!r.scene.environment) r.scene.environment = ensureUwEnv(renderer);
    // Gentle float (never fully still underwater) plus a cheap caustics stand-in: a shimmering
    // key-light intensity rather than a true projected pattern — a real caustic projection (see
    // world/underwater/caustics.ts) reconstructs world position from this scene's own depth
    // buffer, which this isolated offscreen rig would need its own copy of the main composer's
    // plumbing to do; the brief's "caustics if cheap" qualifier is exactly why that wasn't built.
    r.pivot.position.y = Math.sin(t * 0.9) * 0.025;
    r.pivot.rotation.y = Math.sin(t * 0.5) * 0.09;
    // Shimmer around the same baseline `ensureRig` set the key to (1.5) — this was previously
    // hardcoded back down to ~1.0 every frame here, quietly undoing that light's own intensity
    // the instant the first render() call ran (which, in real play, is every frame — see
    // catch-flow.ts's `renderPortrait`, called continuously while a catch card is up).
    r.key.intensity = 1.5 + Math.sin(t * 3.1) * 0.12 + Math.sin(t * 7.3 + 1) * 0.06;

    const pos = r.particulate.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) arr[i + 1] += Math.sin(t * 0.6 + i) * 0.0003;
    pos.needsUpdate = true;

    readback(renderer, r);
  }

  function clear(): void {
    if (!rig) return;
    if (rig.diver) { rig.pivot.remove(rig.diver.group); rig.diver.dispose(); rig.diver = null; }
    if (rig.fish) { rig.pivot.remove(rig.fish); disposeFishMesh(rig.fish); rig.fish = null; }
  }

  return { show, render, clear };
}
