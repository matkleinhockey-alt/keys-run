/**
 * Loads the deck-crew glTF — the realistic `bikini_girl` Sketchfab figure, now actually rigged
 * and dancing (see docs/ASSET-LICENCES.md for the full licence entry: this derived asset combines
 * that CC-BY-4.0 model with a Mixamo animation, and needs attribution for the former).
 *
 * This replaces the PREVIOUS `dance-01.glb` (Mixamo's own generic "X Bot" mannequin — a
 * flat-reddish-brown, textureless stand-in baked into `raw/hiphop_dancing.fbx` itself) with the
 * project's actual textured crew figure (`raw/bikini_girl.glb`, 49,860 tris, CC-BY-4.0, no
 * skeleton of its own) bound to that same Mixamo `mixamorig:` skeleton + "Hip Hop Dancing" clip.
 * The bind was done locally with Blender's heat-map "Automatic Weights" — the same class of
 * technique Mixamo's own web auto-rigger uses — by
 * packages/assets-pipeline/scripts/rig-dancer.blender.py; see that script's header for the full
 * alignment/pose/topology debugging history (scale+orientation matching, bending the T-pose rig's
 * arms to roughly match the girl's actual "hands at her hair" rest pose, and the one genuinely
 * load-bearing fix: merging 11,686 duplicate/overlapping vertices that otherwise left the heat-
 * weight solver unable to solve the mesh at all). The bind was judged by rendering it in Blender
 * across the whole dance, not guessed at — see test/screenshots/crew-rigged/ and this task's
 * report for that render and the honest call on quality, including its one known limitation:
 * Mixamo's generic bone-chain lengths aren't rescaled to the girl's actual limb proportions, which
 * shows as visible-but-bounded arm elongation on the dance's biggest reach beats (not torn or
 * exploded geometry).
 *
 * Built by packages/assets-pipeline/scripts/build-dance.sh: the Blender rig step above, then
 * `gltf-transform optimize` (meshopt geometry+animation compression, WebP textures). Unlike the
 * previous build, simplify is now ENABLED — confirmed safe for this skinned mesh by direct
 * before/after render comparison (see the script header and this task's report), so the earlier
 * blanket caution against simplifying a skinned character no longer applies here.
 *
 * Loaded exactly once (module-level singleton promise) and **skeleton-cloned** per placed figure
 * via `SkeletonUtils.clone` (see index.ts's `spawnFigure`) — a skinned mesh's plain
 * `Object3D.clone()`/`THREE.LOD.clone()` does NOT duplicate its skeleton, so naively cloning N
 * instances would have them all sharing (and fighting over) one skeleton's bone transforms.
 *
 * LOD: build-dance.sh now also writes a far LOD (`dance-01.lod1.glb`, ~5k tris) alongside this
 * near one (~12k tris, down from the source's 49,860) — same two-tier split as the static figure's
 * `crew-01.lod{0,1}.glb`. Neither this module nor index.ts wires that second file into a
 * `THREE.LOD` yet (matching crew-01's own current status: built, not yet consumed) — a future
 * LOD1 would just be a second glTF level added to a `THREE.LOD` the same way the old static asset
 * did; nothing here structurally prevents it.
 *
 * Loading is async and is never awaited by the boot path (apps/client/src/game/world.ts calls
 * `loadCrewAsset` without blocking on it) — the game starts and is playable immediately, and
 * figures pop onto whatever boat is current the moment the asset resolves.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Served from apps/client/public/ — see packages/assets-pipeline/scripts/build-dance.sh for how
// this is produced, and docs/ASSET-LICENCES.md for the source/licence.
const DANCE_URL = '/models/crew/dance-01.glb';

// Measured directly in Blender at rest pose (pose_position='REST') on the built dance-01.glb:
// bboxMin (-0.2954, -0.2067, 0.0000) to bboxMax (0.2957, 0.2067, 1.8298) — feet at z≈0 (the rig
// script places them there explicitly; see rig-dancer.blender.py), height ≈1.830 m. This is
// bikini_girl's own body scaled uniformly to match the Mixamo rig's natural height (not the old
// X-Bot mesh's height, though the two happen to be within 2mm of each other). Like the previous
// asset, this mesh is already in real-world-ish metres (not unit-height) — index.ts's spawnFigure
// divides each placement's target `heightM` by this constant to get the actual scale factor, so
// placements.ts stays unchanged either way.
export const TEMPLATE_HEIGHT_M = 1.8298;

export interface CrewAsset {
  /** Unparented template — never added to the scene directly. index.ts clones it per figure with
   * `SkeletonUtils.clone`, never plain `.clone()` (see this module's header). */
  template: THREE.Object3D;
  /** The "Hip Hop Dancing" clip (glTF calls it `mixamo.com`, Mixamo's own export-time name for
   * every clip regardless of which animation it actually is — not used by name, just taken as
   * `gltf.animations[0]`). ~7 s, loops cleanly. One `THREE.AnimationMixer` + clip action gets
   * built per cloned figure in index.ts, not shared — mixers carry per-instance playback time. */
  clip: THREE.AnimationClip;
}

let pending: Promise<CrewAsset> | null = null;

function disableShadows(root: THREE.Object3D): void {
  // Budget call, not a quality-tier knob: this project's own profiling already found 312-583
  // draw calls in use topside before any of this (terrain/reef/shadows), against a 400 budget —
  // see this project's report. A boat can carry up to 3 figures; letting them cast shadows would
  // add up to 3 extra draw calls *per shadow cascade* per boat for a cosmetic detail, which is the
  // wrong trade against that headroom. They still *receive* shadows (receiveShadow stays on — it
  // doesn't cost a draw call, just a sample against the existing shadow map), so they aren't flat
  // lit while the deck around them is properly shadowed.
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = false;
      o.receiveShadow = true;
    }
  });
}

/** Loads (once) and returns the shared crew template + its dance clip. Safe to call repeatedly —
 * every call after the first returns the same in-flight/resolved promise. */
export function loadCrewAsset(): Promise<CrewAsset> {
  if (pending) return pending;

  const manager = new THREE.LoadingManager();
  const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);

  pending = loader.loadAsync(DANCE_URL).then((gltf) => {
    disableShadows(gltf.scene);
    const clip = gltf.animations[0];
    if (!clip) throw new Error(`[crew-model] ${DANCE_URL} has no animations — expected the baked "Hip Hop Dancing" clip`);
    return { template: gltf.scene, clip };
  });
  return pending;
}
