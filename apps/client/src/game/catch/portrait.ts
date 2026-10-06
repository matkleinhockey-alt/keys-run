/**
 * The catch-card "studio portrait": a slowly turning fish rendered with the game's own
 * `THREE.WebGLRenderer` into an offscreen `WebGLRenderTarget`, then blitted into a plain 2D
 * `<canvas>` via `readRenderTargetPixels`.
 *
 * ⚠ Preserve this approach exactly (legacy index.html:2876-2877's comment, carried forward
 * verbatim below) — do not "simplify" this into a second `THREE.WebGLRenderer`/second canvas.
 *
 * > a studio portrait of the catch in the card. It's drawn with the game's own renderer into an
 * > offscreen target and copied into a plain 2D canvas — a second WebGL context could knock out
 * > the main one on some devices and turn the screen black.
 *
 * Renders a generic `makeFishMesh` body rather than legacy's detailed per-species `VGEO` — see
 * fish-mesh.ts's header for why (entities/fish/** hadn't landed on `integration` yet).
 *
 * ## Realism pass (this file's second iteration)
 *
 * Three things made the original render read as a plastic toy rather than a photo, in order of
 * how much they mattered:
 *
 * 1. No environment map. A wet fish's realism is almost entirely specular/fresnel — with no
 *    `scene.environment`, `MeshStandardMaterial`'s reflections had nothing to reflect. `ensureEnv`
 *    below builds a tiny procedural sky/water gradient + "sun" PMREM once (cached at module scope,
 *    first catch of the session pays for it, every catch after is free) and the portrait scene
 *    uses it for IBL.
 *
 * 2. The colour pipeline was silently wrong. The main renderer runs ACES tone mapping (actually
 *    owned by `core/postfx.ts`'s composer, not `renderer.toneMapping` — see that file's header)
 *    and sRGB output. It is tempting to flip `renderer.toneMapping`/`renderer.outputColorSpace`
 *    to match before rendering the portrait and flip them back after — **that does nothing**:
 *    three.js's `WebGLRenderer` only honours `toneMapping`/`outputColorSpace` when
 *    `currentRenderTarget === null` (i.e. rendering straight to the canvas); for any other render
 *    target — ours included — it unconditionally renders with `NoToneMapping` and the *linear*
 *    `ColorManagement.workingColorSpace`, regardless of what the renderer's public properties say
 *    (see `WebGLRenderer`'s `currentRenderTarget === null ? renderer.outputColorSpace : ...`
 *    checks and the matching `toneMapping`/`NoToneMapping` branch in `WebGLPrograms`). So the
 *    bytes `readRenderTargetPixels` handed back were raw linear light values with no gamma curve
 *    at all — which is exactly "washed out and dark" (linear values read as if they were already
 *    sRGB-encoded look crushed/muddy, and nothing above 1.0 got the filmic highlight rolloff).
 *    The fix has to happen on the CPU, while we already have the pixels in hand for the row-flip:
 *    `toLDR` below ports three's own ACES filmic curve (same coefficients as
 *    `tonemapping_pars_fragment`) plus the live `renderer.toneMappingExposure`, then encodes to
 *    sRGB through a precomputed LUT (no per-pixel `Math.pow`, so the extra pass stays cheap).
 *
 * 3. Flat, shadowless three-point-ish lighting with no rim and no backdrop. `ensureRig` now wires
 *    a warm key / cool fill / cool rim (the rim is what actually separates the silhouette from the
 *    background — compare before/after with it alone disabled) and `scene.background` carries a
 *    deep-water gradient with a soft glow behind the subject and a touch of bottom-edge darkening
 *    standing in for a contact shadow, instead of flat black/transparent.
 *
 * `applyPortraitMaterial` swaps each mesh's shared, cached `fish-mesh.ts` material for a
 * **portrait-local clone** (`MeshPhysicalMaterial` with a little clearcoat + iridescence for the
 * wet-skin look) rather than mutating the cache in place — the cache is also used by the live
 * hooked-fish mesh, the jump animation and the grip-and-grin hang rig (`catch-flow.ts`'s
 * `setupPhoto`), none of which this task owns.
 *
 * The render-target/readback plumbing and the colour-pipeline fix (item 2) now live in
 * render-pipeline.ts, shared with underwater-trophy.ts's dive-caught card — extracted verbatim,
 * not rewritten, when that module needed the exact same machinery. See that file's header.
 */
import * as THREE from 'three';
import { makeFishMesh } from '../fishing/fish-mesh.js';
import { makeWetFishMaterial } from '../fishing/fish-skin.js';
import { buildOffscreenRig, readback, buildGradientEnv, type OffscreenRig, resyncRigSize } from './render-pipeline.js';
import { buildFigure, type Figure } from './figure.js';
import { beamBetween } from '../../entities/boat/hull.js';

interface PortraitRig extends OffscreenRig {
  pivot: THREE.Group;
  /** The fish mesh, wherever it ends up parented — directly under `pivot` (captain-hold path) or
   * nested inside `wrapper` (hang-rig path, below). Always the node `disposeMesh` is called on. */
  mesh: THREE.Group | null;
  /** Non-null only on the captain-hold path: the figure whose hands are IK-posed onto the fish. */
  figure: Figure | null;
  /** Non-null only on the hang-rig (large-fish) path: the group actually holding `mesh` as a
   * child, offset from `pivot` by the composition's own re-centring (see `show()`). Tracked
   * separately from `mesh` so removing it removes the fish too, regardless of nesting. */
  wrapper: THREE.Group | null;
  /** Non-null only on the hang-rig path: the gin-pole + hanging scale prop itself. */
  hangRigProp: THREE.Group | null;
  last: number;
}

export interface Portrait {
  show(color: string, lenM: number, elongated?: boolean): void;
  render(renderer: THREE.WebGLRenderer, t: number): void;
  clear(): void;
}

// ---- environment (see header item 1) ---------------------------------------------------------

/** Built once, lazily, the first time a portrait is ever rendered — cached for the life of the
 * page so every catch after the first one is free. A small custom sky/water gradient rather than
 * three/examples/jsm's `RoomEnvironment`: a fish held up for a photo should reflect sky and water,
 * not a grey interior, and this avoids introducing a new `three/examples/jsm` import path. */
let sharedEnv: THREE.Texture | null = null;
function ensureEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  if (sharedEnv) return sharedEnv;
  sharedEnv = buildGradientEnv(renderer, {
    top: 0xdcefec, horizon: 0x1f6f73, deep: 0x041824,
    // A bright "sun" patch gives the PMREM convolution something to turn into a soft specular
    // highlight at low roughness; a cooler bounce patch opposite it stops one flank going flat.
    accent: { color: 0xfff2d9, intensity: 5, pos: [14, 22, -8], radius: 3 },
    bounce: { color: 0x2f8aa8, intensity: 1.6, pos: [-16, -4, 10], radius: 5 },
  });
  return sharedEnv;
}

/** A deep-water gradient backdrop (brief item 4) with a soft glow behind the subject and a
 * darker lower band standing in for a contact shadow (item 3's "or gradient beneath" — cheaper
 * and more robust across camera angles than a literal ground-shadow mesh). Set as `scene.
 * background`: three.js renders a plain `Texture` background as a full-screen quad independent
 * of camera near/far, so it always fills the frame regardless of how close/far a given fish's
 * camera sits. */
function buildBackdrop(): THREE.CanvasTexture {
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#0a2b3d');
  grad.addColorStop(0.42, '#1c5064');
  grad.addColorStop(1, '#071b26');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const glow = ctx.createRadialGradient(size * 0.52, size * 0.44, size * 0.04, size * 0.52, size * 0.44, size * 0.6);
  glow.addColorStop(0, 'rgba(140,224,214,0.30)');
  glow.addColorStop(1, 'rgba(140,224,214,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  const vig = ctx.createRadialGradient(size / 2, size * 0.52, size * 0.3, size / 2, size * 0.52, size * 0.76);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Generic recursive dispose — traverses any group (a fish mesh or a primitive prop group alike)
 * freeing every mesh's geometry/material. Used for both the fish and (below) the hang-rig prop. */
function disposeMesh(mesh: THREE.Group): void {
  mesh.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose()); else mat?.dispose();
  });
}

/** A fish too big for a captain to plausibly hold (see `show()`'s `HOLDABLE_MAX_LEN_M`) gets
 * catch-flow.ts's real-world answer instead: a gin pole off the gunwale with a hanging scale
 * (legacy `hangRig`, index.html:2914-2919; ported here to `catch-flow.ts`'s `hangRig` for the real
 * boat-deck rig). This is a standalone re-build for this isolated studio scene — not a reuse of
 * that function, which is wired to a live `BoatModel`/deck-Y/gunwale position this card has none
 * of — reusing only `beamBetween` (entities/boat/hull.ts), the one piece that's genuinely a pure
 * geometry helper with no boat dependency.
 *
 * Deliberately NOT paired with a human figure: a standing figure with no grip on a fish hanging
 * from a hook has no natural two-hand IK target, and a static figure next to (not touching) the
 * fish is exactly the "mannequin with a fish floating nearby" failure this project already hit
 * once (figure.ts's header / underwater-trophy.ts's original header). Fish-only, hung from the
 * scale, is the honest version of this shot for a fish nobody is lifting by hand.
 *
 * Coordinate convention: the fish hangs from local `(0, 0, 0)` — the caller positions the actual
 * fish mesh relative to that point (see `show()`). `totalLen` (the fish's own measured length)
 * only scales the rig's proportions so a 600 lb marlin doesn't hang from a gin pole sized for an
 * 80 lb tarpon. */
function buildHangRigProp(totalLen: number): THREE.Group {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 0.85, roughness: 0.25 });
  const cable = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 });
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  // More separation and noticeably fatter beams than a literal gin pole would have — a big fish's
  // own frame-fit camera distance grows with it (`show()`'s `dv`), so a realistically thin pole
  // shrinks to a near-invisible 1-2 px sliver against the dark backdrop at this card's small
  // rendered size (measured in an earlier pass: present in the scene, invisible in the screenshot
  // for a 600 lb marlin). Legible beats literal here — the scale/hook read as "hung from a scale"
  // either way, but the pole itself should actually be visible proving the structure.
  const postX = -0.8 - totalLen * 0.08;
  const postTop = Math.max(0.55, totalLen * 0.2);
  const postBottom = -Math.max(0.45, totalLen * 0.38);

  group.add(beamBetween(V(postX, postBottom, 0), V(postX, postTop, 0), 0.08, steel));
  group.add(beamBetween(V(postX, postTop, 0), V(0, postTop + 0.05, 0), 0.06, steel));
  group.add(beamBetween(V(postX, postTop - 0.3, 0), V(postX + 0.3, postTop, 0), 0.045, steel));
  // cable from the arm tip down to the scale
  group.add(beamBetween(V(0, postTop, 0), V(0, 0.22, 0), 0.01, cable));

  const scale = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 20), new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.4 }));
  scale.rotation.z = Math.PI / 2;
  scale.position.set(0, 0.17, 0);
  group.add(scale);
  const dial = new THREE.Mesh(new THREE.CircleGeometry(0.08, 20), new THREE.MeshBasicMaterial({ color: 0xf4f4f2 }));
  dial.position.set(0.031, 0.17, 0);
  dial.rotation.y = Math.PI / 2;
  group.add(dial);
  // short hook link down to local (0,0,0), where the fish itself attaches
  group.add(beamBetween(V(0, 0.1, 0), V(0, 0, 0), 0.01, steel));

  return group;
}

/** Replaces each child mesh's shared `fish-mesh.ts` material (flat-shaded, cached per colour —
 * also used by the live hooked-fish mesh / jump animation / hang rig) with a portrait-local
 * `MeshPhysicalMaterial` clone: smooth shading (the shared material forces `flatShading`) plus a
 * little clearcoat + iridescence for the wet-skin look (brief item 6). Never touches the cached
 * original. */
function applyPortraitMaterial(mesh: THREE.Group, lenM: number): void {
  mesh.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    // `vertexColors` MUST be carried over. entities/fish/body.ts's `bodyColor` bakes
    // countershading (dark dorsal, pale belly), shark banding and species patterning into the
    // geometry's colour attribute, and the shared fish-mesh.ts material enables it. Omitting it
    // here silently discarded all of that and rendered every fish as one flat species colour —
    // a mahi came out a uniform neon-green blank with none of its gradient or spotting.
    m.material = makeWetFishMaterial(src.color.clone(), { lengthM: lenM });
  });
}

/** Removes and disposes whatever `show()` last built — the fish, and (depending which path it
 * took) the captain figure or the hang-rig prop + its wrapper. Used both at the top of `show()`
 * (clearing the previous catch) and by `clear()`. */
function clearRigContents(r: PortraitRig): void {
  if (r.figure) { r.pivot.remove(r.figure.group); r.figure.dispose(); r.figure = null; }
  if (r.hangRigProp) { r.pivot.remove(r.hangRigProp); disposeMesh(r.hangRigProp); r.hangRigProp = null; }
  // The fish is either a direct pivot child (captain-hold path) or nested inside `wrapper` (hang-
  // rig path) — remove whichever one is actually parented to the pivot, then dispose the fish
  // itself either way.
  if (r.wrapper) { r.pivot.remove(r.wrapper); r.wrapper = null; } else if (r.mesh) { r.pivot.remove(r.mesh); }
  if (r.mesh) { disposeMesh(r.mesh); r.mesh = null; }
}

/** legacy `fishPortrait`/`renderPortrait` (index.html:2878-2906). `canvasId` is the `<canvas>`
 * inside the catch card (`#fishCanvas`). */
export function createPortrait(canvasId: string): Portrait {
  let rig: PortraitRig | null = null;

  function ensureRig(): PortraitRig | null {
    if (rig) return rig;
    const scene = new THREE.Scene();
    scene.background = buildBackdrop();
    // Weak ambient floor — the environment map (added lazily, first render) carries most of the
    // soft fill/specular now; this just keeps unlit backsides off pure black on the first frame
    // before that's ready.
    scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x08202c, 0.32));
    const key = new THREE.DirectionalLight(0xfff0d8, 1.25); key.position.set(3, 4, 2.2); scene.add(key);
    // Water-bounce fill from below rather than the camera side — a hand-held fish over open
    // water picks up soft cool light reflecting up off the surface more than a lateral fill.
    const fill = new THREE.DirectionalLight(0x6fc9d9, 0.4); fill.position.set(0.8, -3, 1.6); scene.add(fill);
    // Rim/kicker (brief item 3) — placed behind the subject from the camera's point of view so
    // it grazes the silhouette/dorsal edge instead of flooding the face the camera sees.
    const rim = new THREE.DirectionalLight(0xeaffff, 1.0); rim.position.set(-3, 3.2, -2.2); scene.add(rim);
    // Aspect is corrected from the rig's real dimensions immediately below — `buildOffscreenRig`
    // is what resizes the backing store for the display, so reading cv.width here would use the
    // pre-resize value.
    const camera = new THREE.PerspectiveCamera(28, 640 / 300, 0.01, 200);
    const base = buildOffscreenRig(canvasId, scene, camera);
    if (base) { camera.aspect = base.w / base.h; camera.updateProjectionMatrix(); }
    if (!base) return null;
    const pivot = new THREE.Group();
    scene.add(pivot);
    rig = { ...base, pivot, mesh: null, figure: null, wrapper: null, hangRigProp: null, last: -1 };
    return rig;
  }

  // Above this length (the fish mesh's own `lenM` parameter, same units `catch-flow.ts` passes
  // in from `scaledLenM`), a captain holding the catch up at chest height stops being plausible
  // and starts looking broken — the brief's own example: nobody chest-holds a 600 lb marlin.
  // 1.5 m is chosen from this task's own screenshot range (test/screenshots/captain/): a 25 lb
  // mahi (lenM ~1.17 m) and a 20 lb barracuda (~1.21 m) both still read fine held up two-handed;
  // an 80 lb tarpon (~1.70 m) — already a 5-6 ft fish — does not, and is exactly the kind of
  // catch real anglers hang from a scale rather than lift overhead. A 600 lb marlin (~3.6 m)
  // clears the threshold by more than 2x, proving the fallback path below.
  const HOLDABLE_MAX_LEN_M = 1.5;

  function show(color: string, lenM: number, elongated = false): void {
    const r = ensureRig();
    if (!r) return;
    // The card is display:none until the first catch, so the rig was very likely built against a
    // zero clientWidth — this is the first moment the real display size exists. See
    // `resyncRigSize`.
    if (resyncRigSize(r, canvasId)) { r.camera.aspect = r.w / r.h; r.camera.updateProjectionMatrix(); }
    clearRigContents(r);
    const mesh = makeFishMesh(color, lenM);
    applyPortraitMaterial(mesh, lenM);
    const cam = r.camera;
    const hf = 2 * Math.atan(Math.tan(cam.fov * Math.PI / 360) * cam.aspect);

    // Frame from the composition's ACTUAL bounds, not from `lenM`.
    //
    // The pre-captain fit assumed the subject spanned exactly `lenM` horizontally and at most
    // `lenM * 0.4` vertically. Neither held even for the fish alone: `makeFishMesh` scales the
    // *body loft* to `lenM` (fish-mesh.ts: `g.scale.setScalar(lenM / V.len)`), and
    // `buildCreatureGeo` then hangs a tail *past* the peduncle and, for billfish, a bill *in
    // front* of the nose — so a real mahi is ~1.3x `lenM` long. Now that the subject is a figure
    // (or rig) *plus* the fish, `size`/`center` below come from the union of the figure's own
    // frame points (or the rig's bbox) with the fish's measured bbox — see each branch.
    let size: THREE.Vector3;

    if (lenM <= HOLDABLE_MAX_LEN_M) {
      // --- the captain holds it up, broadside toward camera — same pose/IK machinery
      // underwater-trophy.ts's diver uses (figure.ts's `buildFigure`/`poseArms`/`framePoints`),
      // unchanged, so the one thing this shot lives or dies on (hands actually meeting the fish)
      // inherits the fix that machinery already got. ---
      const figure = buildFigure('captain');
      r.pivot.add(figure.group);
      r.figure = figure;

      const fishBox = new THREE.Box3().setFromObject(mesh);
      const totalLen = Math.max(0.05, fishBox.max.z - fishBox.min.z);
      const midZLocal = (fishBox.max.z + fishBox.min.z) / 2;
      // Both hands land within comfortable IK reach regardless of species length — capped
      // half-span rather than the fish's actual nose/tail extremes, so a bigger fish is held
      // mid-body with its ends extending past the hands (how a real grip-and-grin photo holds
      // anything bigger than an armspan), while a small fish gets both hands spread across most
      // of its own length.
      const halfSpanLocal = Math.min(totalLen * 0.41, 0.34);

      // Nose-to-tail axis running mostly left-right (classic "look how big" broadside read), a
      // touch of upward tilt, held out in front of the chest toward camera.
      const fishAxis = new THREE.Vector3(1, 0.14, 0).normalize();
      const fishPos = new THREE.Vector3(0, -0.04, 0.34);
      const fishQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fishAxis);
      mesh.position.copy(fishPos);
      mesh.quaternion.copy(fishQuat);
      r.pivot.add(mesh);
      r.mesh = mesh;

      const toPivotSpace = (localZ: number): THREE.Vector3 =>
        new THREE.Vector3(0, 0, localZ).applyQuaternion(fishQuat).add(fishPos);
      figure.poseArms(toPivotSpace(midZLocal - halfSpanLocal), toPivotSpace(midZLocal + halfSpanLocal));

      const frameBox = new THREE.Box3();
      for (const p of figure.framePoints()) frameBox.expandByPoint(p);
      frameBox.union(new THREE.Box3().setFromObject(mesh));
      // Re-centre the whole composition (figure + fish, as a rigid unit — both shifted by the
      // same vector, so the IK-posed hands stay exactly on the fish) on the pivot's own origin.
      // Without this the subject orbits the origin as `render()` yaws the pivot, drifting in and
      // out of frame — same reasoning as the original single-mesh `mesh.position.sub(centre)`.
      const center = frameBox.getCenter(new THREE.Vector3());
      figure.group.position.sub(center);
      mesh.position.sub(center);
      size = frameBox.getSize(new THREE.Vector3());
    } else {
      // --- too big to hold (see HOLDABLE_MAX_LEN_M above) — catch-flow.ts's real-world answer,
      // `hangRig`: a gin pole off the gunwale with a hanging scale. Rebuilt standalone for this
      // isolated studio scene (see `buildHangRigProp`'s header for why it's not a reuse of
      // `catch-flow.ts`'s version) with no human figure — a static figure not actually gripping
      // the fish is the known "mannequin with a fish floating nearby" failure mode. ---
      const fishBox = new THREE.Box3().setFromObject(mesh);
      const totalLen = Math.max(0.05, fishBox.max.z - fishBox.min.z);
      const prop = buildHangRigProp(totalLen);
      r.pivot.add(prop);
      r.hangRigProp = prop;

      // Hang by the tail, vertical — legacy's `setupPhoto` convention (catch-flow.ts's
      // `setupPhoto`), ported: rotate the fish onto the vertical axis and let it hang from the
      // rig's hook point, which is local `(0,0,0)` by `buildHangRigProp`'s own convention.
      const wrapper = new THREE.Group();
      mesh.rotation.set(-Math.PI / 2, 0, 0);
      mesh.position.set(0, -totalLen / 2, 0);
      wrapper.add(mesh);
      r.pivot.add(wrapper);
      r.wrapper = wrapper;
      r.mesh = mesh;

      const frameBox = new THREE.Box3().setFromObject(wrapper);
      frameBox.union(new THREE.Box3().setFromObject(prop));
      const center = frameBox.getCenter(new THREE.Vector3());
      prop.position.sub(center);
      wrapper.position.sub(center);
      size = frameBox.getSize(new THREE.Vector3());
    }

    // The pivot yaws +/-0.45 rad every frame (`render()`), so the on-screen width is not simply
    // the Z extent — at some point in the cycle the X extent swings into view. The XZ diagonal is
    // the worst case over *any* yaw, which keeps the fit rotation-proof for one cheap hypot.
    const hHalf = 0.5 * Math.hypot(size.x, size.z);
    const vHalf = 0.5 * size.y;
    // Breathing room so nothing kisses the edge, and cover for the small pitch/roll wobble.
    const PAD = 1.16;
    const dH = (hHalf * PAD) / Math.tan(hf / 2);
    const dV = (vHalf * PAD) / Math.tan(cam.fov * Math.PI / 360);
    const dv = Math.max(dH, dV, 1e-3);

    cam.near = Math.max(dv / 100, 1e-4); cam.far = Math.max(dv * 10, 40);
    // A slight three-quarter angle reads more like a photo than a dead-on profile; long/billfish
    // shapes foreshorten badly at that angle, so they stay nearer profile. Side-stepping (holding
    // the perpendicular distance at `dv` and only offsetting sideways) rather than orbiting keeps
    // the near tip from creeping closer than the fit allows.
    const azimuth = elongated ? 0.12 : 0.40;
    // Which world axis the fish's nose-to-tail length actually runs along differs by path: the
    // plain (pre-captain) framing never rotated the mesh, so length ran along its native Z: a
    // small azimuth (X-dominant camera offset, below) sits perpendicular to that — the least-
    // foreshortened "profile" view, correctly matching "elongated -> small azimuth". The captain-
    // hold path above rotates the fish onto `fishAxis` (mostly +X, matching the diver trophy
    // card's own broadside pose) — length now runs along X, so an X-dominant camera looks nearly
    // *down* the fish's own length instead of across it, foreshortening every species and making
    // elongated ones (small azimuth = even more X-dominant) nearly edge-on invisible. The hang-rig
    // path, in turn, rotates the fish onto Y (vertical) — azimuth barely matters there either way,
    // since neither X nor Z viewing foreshortens a vertical length. Swapping which axis `dv`/
    // `tan(azimuth)` land on for the captain-hold path restores "small azimuth = profile,
    // perpendicular to the fish's actual length" for the axis that path actually uses.
    if (lenM <= HOLDABLE_MAX_LEN_M) {
      cam.position.set(dv * Math.tan(azimuth), vHalf * 0.10, dv);
    } else {
      cam.position.set(dv, vHalf * 0.10, dv * Math.tan(azimuth));
    }
    // Aim a touch above centre so the subject sits slightly low in frame (headroom).
    cam.lookAt(0, vHalf * 0.10, 0);
    cam.updateProjectionMatrix();
    r.last = -1;
  }

  function render(renderer: THREE.WebGLRenderer, t: number): void {
    const r = rig;
    if (!r || !r.mesh) return;
    if (t - r.last < 0.12) return; // ~8fps is plenty for a slowly turning fish
    r.last = t;
    if (!r.scene.environment) r.scene.environment = ensureEnv(renderer);
    r.pivot.rotation.set(Math.sin(t * 1.3) * 0.05, Math.sin(t * 0.7) * 0.45, Math.sin(t * 1.1) * 0.06);
    readback(renderer, r);
  }

  function clear(): void {
    if (rig) clearRigContents(rig);
  }

  return { show, render, clear };
}
