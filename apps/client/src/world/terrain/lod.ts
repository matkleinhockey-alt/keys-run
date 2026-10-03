/**
 * Chunk/LOD manager: builds and frees 64 m terrain chunks (./chunk.ts) around the camera,
 * assigning each one an LOD (vertex density) from its distance ring, plus one always-present
 * "far skirt" reaching the full topside horizon and a flat abyssal backstop far below everything.
 *
 * Why the near-field radius and LOD segment counts differ so much between "surfaced" and
 * "submerged": docs/ARCHITECTURE.md's depth-band table gives underwater visibility as ~10-30 m
 * depending on depth, vs. a topside horizon around 1,900 m. Rendering real chunk geometry out to
 * 1,900 m would be thousands of draw calls for no visual gain (you can't see the bottom through
 * deep water anyway — that's the water shader's job, not this module's); instead only a modest
 * near radius gets real per-chunk geometry, and the far skirt below fakes the rest for ~1 extra
 * draw call, the same "dense near camera, coarse toward the horizon" radial warp world/water.ts's
 * plane already uses.
 *
 * Neighbouring chunks can legitimately disagree on LOD (a near full-res chunk next to a half-res
 * one right at a ring boundary) — ./chunk.ts's perimeter skirt hides the resulting seam rather
 * than this module stitching matching edge topology between neighbours, which is the simpler and
 * standard fix for chunked-terrain LOD cracks.
 *
 * Budget discipline (docs/ARCHITECTURE.md "never rebuild every frame" + the draw-call budget):
 * residency is only *recomputed* when the camera has moved more than SCAN_DIST since the last
 * scan, and at most BUILD_BUDGET chunk (re)builds actually run per `update()` call — so a fast
 * teleport or a submerge/surface LOD-profile switch streams in over a handful of frames instead
 * of spiking one. The far skirt follows the same discipline: it's left alone (not even
 * repositioned) between full rebuilds, which only happen every FAR_SKIRT_RESAMPLE_DIST metres of
 * camera travel.
 */
import * as THREE from 'three';
import { buildChunkGeometry } from './chunk.js';
import { CHUNK_SIZE, seafloorHeightAt, seafloorColorAt } from './heightfield.js';
import { WORLD } from '@keysrun/shared/world/depth';
import { grainTex, normalTex } from '../../core/textures.js';

interface Ring { outer: number; segs: number }
interface Profile { rings: Ring[]; freeMargin: number }

// "Surfaced": topside draw distance is generous, but only the near rings get real geometry (see
// the far skirt below for the rest of docs/ARCHITECTURE.md's 1,900 m horizon).
const SURFACE: Profile = {
  rings: [{ outer: 90, segs: 18 }, { outer: 220, segs: 6 }],
  freeMargin: 1.3,
};
// "Submerged": ~10-30 m visibility depending on depth band means almost nothing past the first
// ring is ever seen; kept deliberately small and cheap.
const SUBMERGED: Profile = {
  rings: [{ outer: 26, segs: 16 }, { outer: 60, segs: 5 }],
  freeMargin: 1.4,
};
// Hysteresis band for the surfaced/submerged switch (metres of camera Y) — avoids flapping LOD
// profiles (and the rebuild burst that would cause) on wave bob right at the surface.
const SUBMERGE_Y = -2, SURFACE_Y = -0.3;

const SCAN_DIST = 16; // re-evaluate residency only after the camera moves this far (metres)
const BUILD_BUDGET = 3; // chunk (re)builds actually executed per update() call
const WORLD_CHUNK_MARGIN = 3; // chunks of slack outside WORLD bounds before scan stops widening

const FAR_SKIRT_RADIUS = 1900; // matches the topside horizon exactly (docs/ARCHITECTURE.md)
const FAR_SKIRT_SEGS = 44;
const FAR_SKIRT_RESAMPLE_DIST = 180;

const key = (cx: number, cz: number): string => `${cx},${cz}`;

export interface SeafloorManager {
  group: THREE.Group;
  update(cameraPos: THREE.Vector3): void;
  isReady(x: number, z: number): boolean;
  dispose(): void;
}

export function createSeafloorManager(): SeafloorManager {
  const group = new THREE.Group();
  group.name = 'seafloor-terrain';

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 1,
    // Chunk perimeter skirts (./chunk.ts) can end up back-facing depending on which way a given
    // chunk's border loop winds; DoubleSide means a winding slip there dims, not vanishes.
    side: THREE.DoubleSide,
    map: grainTex([700, 700], 0.8, 1.1), normalMap: normalTex([300, 300], 0.45),
    normalScale: new THREE.Vector2(0.3, 0.3),
  });

  const chunkGroup = new THREE.Group();
  group.add(chunkGroup);

  const resident = new Map<string, { mesh: THREE.Mesh; lod: number }>();
  const buildQueue: Array<{ cx: number; cz: number; lod: number }> = [];
  const queued = new Set<string>();

  let submerged = false;
  let lastScanX = Infinity, lastScanZ = Infinity;

  const minCX = Math.floor(WORLD.x0 / CHUNK_SIZE) - WORLD_CHUNK_MARGIN;
  const maxCX = Math.ceil((WORLD.x0 + WORLD.size) / CHUNK_SIZE) + WORLD_CHUNK_MARGIN;
  const minCZ = Math.floor(WORLD.z0 / CHUNK_SIZE) - WORLD_CHUNK_MARGIN;
  const maxCZ = Math.ceil((WORLD.z0 + WORLD.size) / CHUNK_SIZE) + WORLD_CHUNK_MARGIN;

  function ringLodFor(dist: number, profile: Profile): number {
    for (let i = 0; i < profile.rings.length; i++) if (dist <= profile.rings[i].outer) return i;
    return -1; // beyond every ring — should not be resident
  }

  function enqueue(cx: number, cz: number, lod: number): void {
    const k = key(cx, cz);
    if (queued.has(k)) return;
    queued.add(k);
    buildQueue.push({ cx, cz, lod });
  }

  function scan(camX: number, camZ: number, profile: Profile): void {
    const maxOuter = profile.rings[profile.rings.length - 1].outer;
    const cMinX = Math.max(minCX, Math.floor((camX - maxOuter) / CHUNK_SIZE));
    const cMaxX = Math.min(maxCX, Math.ceil((camX + maxOuter) / CHUNK_SIZE));
    const cMinZ = Math.max(minCZ, Math.floor((camZ - maxOuter) / CHUNK_SIZE));
    const cMaxZ = Math.min(maxCZ, Math.ceil((camZ + maxOuter) / CHUNK_SIZE));
    const wanted = new Set<string>();

    for (let cz = cMinZ; cz <= cMaxZ; cz++) {
      for (let cx = cMinX; cx <= cMaxX; cx++) {
        const centerX = cx * CHUNK_SIZE + CHUNK_SIZE / 2, centerZ = cz * CHUNK_SIZE + CHUNK_SIZE / 2;
        const dist = Math.hypot(centerX - camX, centerZ - camZ);
        const lod = ringLodFor(dist, profile);
        if (lod < 0) continue;
        const k = key(cx, cz);
        wanted.add(k);
        const have = resident.get(k);
        if (!have || have.lod !== lod) enqueue(cx, cz, lod);
      }
    }

    // Free anything that's drifted well outside every ring — hysteresis margin, same spirit as
    // docs/ARCHITECTURE.md's interest-management "subscribe at R, unsubscribe at R*1.15" pattern,
    // so a chunk right at the boundary doesn't build/free every scan.
    for (const [k, v] of resident) {
      if (wanted.has(k)) continue;
      const [cx, cz] = k.split(',').map(Number);
      const centerX = cx * CHUNK_SIZE + CHUNK_SIZE / 2, centerZ = cz * CHUNK_SIZE + CHUNK_SIZE / 2;
      const dist = Math.hypot(centerX - camX, centerZ - camZ);
      if (dist > maxOuter * profile.freeMargin) {
        chunkGroup.remove(v.mesh);
        v.mesh.geometry.dispose();
        resident.delete(k);
      }
    }
  }

  function processQueue(): void {
    const profile = submerged ? SUBMERGED : SURFACE;
    let n = 0;
    while (n < BUILD_BUDGET && buildQueue.length > 0) {
      const job = buildQueue.shift();
      if (!job) break;
      const k = key(job.cx, job.cz);
      queued.delete(k);
      const segs = profile.rings[Math.min(job.lod, profile.rings.length - 1)].segs;
      const geo = buildChunkGeometry(job.cx, job.cz, segs);
      const existing = resident.get(k);
      if (existing) {
        chunkGroup.remove(existing.mesh);
        existing.mesh.geometry.dispose();
      }
      const mesh = new THREE.Mesh(geo, material);
      mesh.matrixAutoUpdate = false; // positions are baked in world space; the mesh never moves
      mesh.updateMatrix();
      chunkGroup.add(mesh);
      resident.set(k, { mesh, lod: job.lod });
      n++;
    }
  }

  // ---- far skirt: one cheap, always-present mesh reaching the full topside horizon. Positions
  // and colours are baked in absolute world space (not relative to a moving mesh transform), so
  // it's simply left alone between rebuilds rather than needing a per-frame recenter.
  function buildSkirtGeometry(camX: number, camZ: number): THREE.BufferGeometry {
    const geo = new THREE.PlaneGeometry(2, 2, FAR_SKIRT_SEGS, FAR_SKIRT_SEGS);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    const WA = 0.08;
    const f = (s: number): number => Math.sign(s) * FAR_SKIRT_RADIUS * (WA * Math.abs(s) + (1 - WA) * Math.abs(s) ** 3);
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const wx = camX + f(p.getX(i)), wz = camZ + f(p.getZ(i));
      const y = seafloorHeightAt(wx, wz);
      p.setX(i, wx); p.setY(i, y); p.setZ(i, wz);
      const c = seafloorColorAt(wx, wz, -y);
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    return geo;
  }
  const skirtMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  let skirtGeo = buildSkirtGeometry(0, 0);
  const skirtMesh = new THREE.Mesh(skirtGeo, skirtMaterial);
  skirtMesh.matrixAutoUpdate = false;
  skirtMesh.renderOrder = -1;
  group.add(skirtMesh);
  let lastSkirtX = Infinity, lastSkirtZ = Infinity;

  // ---- abyssal backstop: a flat, dark, always-present plane far below everything, purely so a
  // camera glitch or an unstreamed gap at the very edge of view distance shows dark water instead
  // of the sky dome shining through from underneath.
  const backstop = new THREE.Mesh(
    new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x040a14 }),
  );
  backstop.position.y = -300;
  backstop.matrixAutoUpdate = false;
  backstop.updateMatrix();
  group.add(backstop);

  function update(cameraPos: THREE.Vector3): void {
    const { x: camX, y: camY, z: camZ } = cameraPos;
    if (camY < SUBMERGE_Y) submerged = true;
    else if (camY > SURFACE_Y) submerged = false;
    const profile = submerged ? SUBMERGED : SURFACE;

    if (Math.hypot(camX - lastScanX, camZ - lastScanZ) > SCAN_DIST) {
      lastScanX = camX; lastScanZ = camZ;
      scan(camX, camZ, profile);
    }
    processQueue();

    skirtMesh.visible = !submerged;
    if (!submerged && Math.hypot(camX - lastSkirtX, camZ - lastSkirtZ) > FAR_SKIRT_RESAMPLE_DIST) {
      lastSkirtX = camX; lastSkirtZ = camZ;
      const next = buildSkirtGeometry(camX, camZ);
      skirtGeo.dispose();
      skirtGeo = next;
      skirtMesh.geometry = skirtGeo;
    }
  }

  function isReady(x: number, z: number): boolean {
    return resident.has(key(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
  }

  function dispose(): void {
    for (const v of resident.values()) v.mesh.geometry.dispose();
    resident.clear();
    buildQueue.length = 0;
    queued.clear();
    material.dispose();
    skirtGeo.dispose();
    skirtMaterial.dispose();
    backstop.geometry.dispose();
    (backstop.material as THREE.Material).dispose();
  }

  return { group, update, isReady, dispose };
}
