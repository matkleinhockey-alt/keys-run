/**
 * Shipwrecks on the bottom: the hulls, their discovery, and the cast-capture query.
 *
 * Where they lie is `@keysrun/shared/world/wrecks` (computed from the real bathymetry and
 * asserted in test/wrecks.test.ts); the fish holding on them are entities/fish's wreck layer
 * (spawn.ts), driven from the same hold points; the chart symbol is ui/minimap.ts reading
 * `./wreck-chart.js`. This module is only the steel.
 *
 * **Cost model - nothing is paid for a wreck you are not near**, modelled on party-boats.ts
 * (which culls its hulls and, load-bearingly, its PointLights; see its `LIGHT_RANGE`):
 *
 *  - There are **no lights**. A wreck needs none: the scene sun and the fog override already
 *    shape it, and three.js compiles light count into every material, so a permanent point light
 *    on six wrecks would tax every material in the world for glows nobody can see through 20 m of
 *    water. Nothing here ever adds a light, so there is nothing to cull.
 *  - Geometry is built **lazily on first approach**, not at boot, and a wreck you never go near
 *    costs no geometry at all (the six together are ~25k triangles at full detail).
 *  - Three tiers by distance from the camera to the *hull's edge* (so a 120 m freighter you are
 *    standing on counts as 0, not 60), the same idea as the fish LOD's apparent-size tiers:
 *      hidden  > HIDE_M   `group.visible = false`; the renderer skips the subtree entirely
 *      mass    > FULL_M   detail 0: lofted hull + deckhouse/funnel/wing boxes, the dark silhouette
 *      full    <= FULL_M  detail 1: hatches, derricks, rails, ribs, torn plating, engines
 *    with 15% hysteresis so a boat idling on a boundary does not rebuild visibility every frame.
 *    Each tier is one or two draw calls per wreck (one per hull section, plus debris).
 *  - The per-frame work for a hidden wreck is one distance computation. Discovery runs at 2 Hz.
 *
 * Meshes are single-material (vertex colours), `castShadow` off: a hull on the seabed under 15+ m
 * of water is not in the sun's shadow cascade in any way a viewer can see.
 */
import * as THREE from 'three';
import { wrecksFor, wreckNear, wreckEdgeDist, type Wreck } from '@keysrun/shared/world/wrecks';
import { seafloorHeightAt } from '../../world/terrain/heightfield.js';
import { WORLD_SEED } from '../../state/constants.js';
import { toast } from '../../ui/toast.js';
import { chartNear, isCharted } from './wreck-chart.js';
import { buildSection, buildDebris } from './wreck-geometry.js';

/** Beyond this (metres from the hull's edge) nothing of the wreck is drawn. Underwater visibility
 * tops out near 30 m; this is generous for the surface, where a shallow wreck shows through the
 * water, and still far inside the 1.9 km horizon the rest of the world is drawn to. */
const HIDE_M = 480;
/** Inside this the full-detail hull replaces the dark-mass proxy. */
const FULL_M = 110;
const HYST = 1.15;
const DISCOVERY_PERIOD_S = 0.5;

type Tier = 0 | 1 | 2; // hidden, mass, full

interface Live {
  w: Wreck;
  root: THREE.Group;
  /** Heeled hull: the bow section, and (if snapped) the stern section in its own offset group. */
  hull: THREE.Group;
  parts: Record<1 | 2, THREE.Object3D | null>;
  tier: Tier;
}

export interface Wrecks {
  group: THREE.Group;
  /** `boat` and `diver` chart wrecks they pass near; `camera` decides the draw tier. */
  update(dt: number, camera: { x: number; z: number }, boat: { x: number; z: number }, diver: { x: number; z: number } | null): void;
  /** The wreck a cast at (x,z) landed on - fishing's `SpotQuery.nearWreck`. */
  nearWreck(x: number, z: number): { name: string } | null;
  list(): readonly Wreck[];
  /** VERIFICATION-ONLY. */
  debug(): Array<{ id: string; name: string; x: number; z: number; depth: number; heading: number; len: number; beam: number; height: number; tier: number; charted: boolean }>;
  dispose(): void;
}

export function createWrecks(scene: THREE.Scene, seed: number = WORLD_SEED): Wrecks {
  const group = new THREE.Group();
  group.name = 'wrecks';
  scene.add(group);

  // Rough, dark, a little metallic: reads as plating, and the per-vertex rust does the rest.
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0.12, flatShading: true, side: THREE.DoubleSide });
  const geos: THREE.BufferGeometry[] = [];
  const wrecks = wrecksFor(seed);
  const lives: Live[] = wrecks.map((w) => {
    const root = new THREE.Group();
    root.name = `wreck:${w.id}`;
    root.rotation.order = 'YXZ';
    // Sit on the seabed the terrain mesh actually draws (not the smooth depthAt floor): sampled
    // once, here, since neither the wreck nor the seabed moves.
    root.position.set(w.x, seafloorHeightAt(w.x, w.z), w.z);
    root.rotation.y = w.heading;
    root.rotation.x = -w.pitch;
    root.visible = false;
    group.add(root);
    const hull = new THREE.Group();
    // Heel about the keel line, and settle a tenth of the height into the sand: a hull on a list
    // digs its low side in rather than balancing on the turn of the bilge.
    hull.rotation.z = w.list;
    hull.position.y = -0.1 * w.height - 0.25 * (w.beam / 2) * Math.abs(Math.sin(w.list));
    root.add(hull);
    return { w, root, hull, parts: { 1: null, 2: null }, tier: 0 as Tier };
  });

  function meshOf(g: THREE.BufferGeometry | null): THREE.Mesh | null {
    if (!g) return null;
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = false; m.receiveShadow = false; m.matrixAutoUpdate = true;
    return m;
  }

  /** Builds a tier's meshes (once) as a Group under the hull, hidden until selected. */
  function build(L: Live, tier: 1 | 2): THREE.Object3D {
    const { w } = L;
    const detail = tier === 2 ? 1 : 0;
    const g = new THREE.Group();
    const bow = meshOf(buildSection(w, 0, detail));
    if (bow) g.add(bow);
    if (w.broken) {
      const stern = meshOf(buildSection(w, 1, detail));
      if (stern) {
        // Same offset and yaw `wreckPoint` uses for the stern section, so steel and fish agree.
        const sg = new THREE.Group();
        sg.position.z = w.gap;
        sg.rotation.y = -w.breakYaw;
        sg.add(stern);
        g.add(sg);
      }
    }
    L.hull.add(g);
    if (tier === 2) {
      // Debris lies flat on the actual seabed (not heeled with the hull): ground height is
      // sampled at the world position each piece lands at, relative to the root.
      const c = Math.cos(w.heading), s = Math.sin(w.heading), y0 = L.root.position.y;
      const deb = meshOf(buildDebris(w, (lx, lz) => seafloorHeightAt(w.x + lx * c + lz * s, w.z - lx * s + lz * c) - y0 - L.hull.position.y));
      if (deb) { deb.rotation.z = -w.list; g.add(deb); }
    }
    g.visible = false;
    return g;
  }

  function setTier(L: Live, tier: Tier): void {
    L.tier = tier;
    L.root.visible = tier !== 0;
    if (tier === 0) return;
    for (const t of [1, 2] as const) {
      if (tier === t && !L.parts[t]) L.parts[t] = build(L, t);
      const p = L.parts[t];
      if (p) p.visible = tier === t;
    }
  }

  let discoverT = 0;
  const announce = (found: Wreck[]): void => {
    for (const w of found) toast(`Wreck charted: ${w.name}, ${Math.round(w.seaDepth * 3.28)} ft. Big fish hold on the steel.`);
  };

  return {
    group,
    update(dt, camera, boat, diver) {
      for (const L of lives) {
        const d = wreckEdgeDist(L.w, camera.x, camera.z);
        // hysteresis: a boundary is crossed outward only after d clears it by HYST
        const hideAt = L.tier === 0 ? HIDE_M : HIDE_M * HYST;
        const fullAt = L.tier === 2 ? FULL_M * HYST : FULL_M;
        const want: Tier = d > hideAt ? 0 : d > fullAt ? 1 : 2;
        if (want !== L.tier) setTier(L, want);
      }
      discoverT -= dt;
      if (discoverT <= 0) {
        discoverT = DISCOVERY_PERIOD_S;
        announce(chartNear(boat.x, boat.z, seed));
        if (diver) announce(chartNear(diver.x, diver.z, seed));
      }
    },
    nearWreck(x, z) {
      const w = wreckNear(seed, x, z);
      return w ? { name: w.name } : null;
    },
    list() { return wrecks; },
    debug() {
      return lives.map((L) => ({ id: L.w.id, name: L.w.name, x: L.w.x, z: L.w.z, depth: L.w.seaDepth, heading: L.w.heading, len: L.w.len, beam: L.w.beam, height: L.w.height, tier: L.tier, charted: isCharted(L.w.id) }));
    },
    dispose() {
      scene.remove(group);
      for (const g of geos) g.dispose();
      mat.dispose();
    },
  };
}
