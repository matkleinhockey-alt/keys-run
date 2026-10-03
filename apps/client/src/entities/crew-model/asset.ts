/**
 * Loads the deck-crew glTF — the project's first external 3D asset (see docs/ASSET-LICENCES.md
 * for the licence entry; read it before this ships publicly). Built by
 * packages/assets-pipeline/scripts/build-crew.sh from a Sketchfab export: two LODs, meshopt-
 * compressed geometry, WebP textures (not KTX2/Basis — see that script's header for why: KTX2's
 * Basis transcoder runs in a Worker+WASM and that worker never finished initialising in this
 * project's sandboxed/software-WebGL test environment, so the figures silently never appeared;
 * WebP has no such runtime risk and, empirically, compressed smaller for this asset anyway).
 *
 * Loaded exactly once (module-level singleton promise) and cloned per placed figure — see
 * index.ts's `spawnFigure`. Cloning a `THREE.LOD` deep-clones the node hierarchy but each level's
 * `Mesh.clone()` shares the same `BufferGeometry`/`Material` instances (three's default, cheap)
 * rather than duplicating GPU buffers — correct here because the source has no skeleton to clone
 * per-instance. See this module's header-comment continuation in index.ts for what a rigged
 * version would need instead (`SkeletonUtils.clone`).
 *
 * Loading is async and is never awaited by the boot path (apps/client/src/game/world.ts calls
 * `loadCrewAsset` without blocking on it) — the game starts and is playable immediately, and
 * figures pop onto whatever boat is current the moment the asset resolves.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Served from apps/client/public/ — see packages/assets-pipeline/scripts/build-crew.sh for how
// these are produced, and docs/ASSET-LICENCES.md for the source/licence.
const LOD0_URL = '/models/crew/crew-01.lod0.glb'; // ~12k tris — the figure nearest the camera
const LOD1_URL = '/models/crew/crew-01.lod1.glb'; // ~5k tris — other figures on the same boat
// entities/camera.ts's chase cam sits at `(hullLen * 1.5 + 11) * zoom` behind the boat *origin* —
// 21.5 m for the 7 m Robalo up to 30.6 m for the 13.1 m Midnight at default zoom, and a figure up
// near the bow or back at the transom adds another ~half the hull length on top of that. So on
// this project's own default chase view, every figure on your own boat is already 15-37 m from
// the camera — comfortably past a naive "10 m is far" guess (confirmed by measurement: at 10 m
// every figure was rendering at the ~5k LOD the moment the boat was boarded). Set high enough that
// the player's own crew always render at full detail in every topside camera (chase/helm/tower),
// and a figure only drops to the cheap LOD once genuinely distant — which is exactly the case this
// LOD split is really for: once other players' boats are visible (docs/ARCHITECTURE.md's 260 m
// boat interest radius), this same THREE.LOD swaps a whole distant boat's crew down to the ~5k
// mesh for free, with no extra code.
const LOD1_DISTANCE = 50;

// The source mesh is normalised to ~1 unit tall with feet at y=0 (packages/assets-pipeline
// centres it there — see build-crew.sh's `center --pivot below` step). Placements in index.ts
// scale each clone to a real height in metres, so this constant should stay 1.
export const TEMPLATE_UNIT_HEIGHT = 1;

export interface CrewAsset {
  /** Unparented template — never added to the scene directly. index.ts clones it per figure. */
  template: THREE.LOD;
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

/** Loads (once) and returns the shared crew template. Safe to call repeatedly — every call after
 * the first returns the same in-flight/resolved promise.
 *
 * No renderer parameter: a KTX2 build would need one (`KTX2Loader.detectSupport(renderer)`); the
 * current WebP build doesn't touch the renderer at all. If KTX2 is reinstated later (see this
 * file's header), thread a `THREE.WebGLRenderer` back through from
 * entities/crew-model/index.ts's `createCrewSystem` call site in game/world.ts. */
export function loadCrewAsset(): Promise<CrewAsset> {
  if (pending) return pending;

  const manager = new THREE.LoadingManager();
  const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);

  const loadLevel = (url: string): Promise<THREE.Object3D> =>
    loader.loadAsync(url).then((gltf) => {
      disableShadows(gltf.scene);
      return gltf.scene;
    });

  pending = Promise.all([loadLevel(LOD0_URL), loadLevel(LOD1_URL)]).then(([near, far]) => {
    const template = new THREE.LOD();
    template.addLevel(near, 0);
    template.addLevel(far, LOD1_DISTANCE);
    return { template };
  });
  return pending;
}
