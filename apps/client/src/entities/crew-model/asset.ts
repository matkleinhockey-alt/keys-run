/**
 * Loads the deck-crew glTF — the project's first external 3D asset with a real skeleton and
 * animation (see docs/ASSET-LICENCES.md for the full licence entry and, importantly, a note on
 * *whose* character this is — read it before this ships publicly).
 *
 * This replaces an earlier static, unrigged figure (`raw/bikini_girl.glb`, still built by
 * packages/assets-pipeline/scripts/build-crew.sh and still sitting at
 * apps/client/public/models/crew/crew-01.lod{0,1}.glb — untouched, just no longer loaded here)
 * with a Mixamo "with skin" export: Mixamo's own default "X Bot" character mesh, rigged to a
 * standard `mixamorig:` skeleton, with the "Hip Hop Dancing" animation baked onto it. **This
 * changes the deck crew's appearance** — X Bot is a flat reddish-brown, textureless mannequin,
 * not the textured bikini_girl figure. That trade (a figure that actually dances, vs. the
 * previous figure's look) was a deliberate call made for this task; see docs/ASSET-LICENCES.md's
 * "dance-01" entry for the full reasoning and the options left open for whoever owns this next.
 *
 * Built by packages/assets-pipeline/scripts/build-dance.sh from
 * packages/assets-pipeline/raw/hiphop_dancing.fbx: FBX2glTF conversion, stripping Mixamo's
 * joint-visualization overlay mesh, then meshopt geometry+animation compression (no
 * simplify/flatten/join — not confirmed safe on a skinned character, see that script's header).
 * No textures to compress (the source has none). No KTX2 question here either, for the same
 * reason.
 *
 * Loaded exactly once (module-level singleton promise) and **skeleton-cloned** per placed figure
 * via `SkeletonUtils.clone` (see index.ts's `spawnFigure`) — a skinned mesh's plain
 * `Object3D.clone()`/`THREE.LOD.clone()` does NOT duplicate its skeleton, so naively cloning N
 * instances would have them all sharing (and fighting over) one skeleton's bone transforms.
 *
 * No LOD split (unlike the old static figure): this ships as a single ~28k-triangle mesh at
 * every distance. Mesh simplification on a skinned+animated character isn't confirmed safe by
 * this team (see build-dance.sh), so a decimated, skin-safe distant LOD is deferred rather than
 * risk a silently broken skin — see this module's `TEMPLATE_HEIGHT_M` note below for the other
 * place a future LOD1 would need updating (none — a LOD1 would just be a second glTF level added
 * to a `THREE.LOD` the same way the old asset did; nothing here structurally prevents it).
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

// Measured from the pre-quantization build/dance/pruned.glb bbox (packages/assets-pipeline's
// `gltf-transform inspect` output, this project's report has the full numbers): bboxMin
// (-0.90257, -0.00035, -0.14896) to bboxMax (0.90257, 1.80888, 0.17174) — feet already sit at
// y≈0 (Mixamo's own export convention, no `center --pivot below` step needed unlike bikini_girl),
// height ≈1.809 m. Unlike the old asset (deliberately normalised to exactly 1 unit tall so a
// placement's `heightM` doubled as its clone's uniform scale), this mesh is already in
// real-world-ish metres — index.ts's spawnFigure divides each placement's target `heightM` by
// this constant to get the actual scale factor, so placements.ts stays unchanged either way.
export const TEMPLATE_HEIGHT_M = 1.809;

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
