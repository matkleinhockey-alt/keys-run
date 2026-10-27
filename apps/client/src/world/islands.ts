/**
 * Islands and mainland terrain, with beaches and winding creeks; palms, conch houses and
 * mangroves; the Marathon airport runway.
 *
 * Ported faithfully from legacy/index.html:731-796. Miami's *skyline* (towers, port, causeways,
 * index.html:828-904) is explicitly out of Phase 0 scope (see docs/ARCHITECTURE.md) and is not
 * ported — but the Miami mainland *landform* (terrain shape/colour, including its "city" grey
 * tint) is literally part of this in-scope block and is kept, since skipping it would leave a
 * blank patch of ocean where the mainland should be.
 *
 * Seeded placement: legacy drew palms/houses/mangroves with raw `Math.random()` — an
 * iteration-order stream shared across every object in the scene, so adding one tree anywhere
 * shifts every later object's roll (see docs/ARCHITECTURE.md "Seeding"). Here each candidate's
 * position (and, for fidelity, its cosmetic height/tilt/rotation) is instead
 * `hashCell(WORLD_SEED, islandIndex, candidateIndex, salt)` — a pure function of the island and
 * that candidate's own slot, never of anything else placed before or after it. The legacy
 * rejection-sampling *shape* (try up to N candidates, keep until you have enough) is kept
 * unchanged — only the random draws inside it are now position/index-derived instead of drawn
 * from a shared stream.
 *
 * Real outlines: every island but the mainland has its OpenStreetMap shoreline (shared world/coast.ts;
 * coastline data © OpenStreetMap contributors, ODbL). Their land is a 3 m grid over the outline's box
 * (fine enough for the finger canals), coarsened to 12 m quads deep inland and skipped at sea (see
 * coastMesh). Scenery candidates are drawn uniformly in that box and kept on the land, and the
 * mangroves walk the real shoreline; the mainland keeps legacy's ellipse sampling.
 */
import * as THREE from 'three';
import { hashCell } from '@keysrun/shared/rng';
import { islands, islandWorld, islandLocal, islandBox, islandDist, chainZ, type Island } from '@keysrun/shared/world/chain';
import { landH, onCourse, creekDist, CREEKS, RUNWAY, GOLF, MARINAS } from '@keysrun/shared/world/depth';
import { inTownFootprint } from '@keysrun/shared/world/town';
import { lerp, rand } from '../core/math.js';
import { grainTex, normalTex } from '../core/textures.js';
import { WORLD_SEED, SALT } from '../state/constants.js';

const CITY = { x0: 250, x1: 3900, zMin: -3600 };
const inCity = (x: number, z: number): boolean => x > CITY.x0 && x < CITY.x1 && z < -2560 && z > CITY.zMin;

const hash2 = (x: number, z: number): number => {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

interface Palm { x: number; z: number; y: number; h: number; lx: number; lz: number }
interface House { I: Island; x: number; z: number; y: number; r: number }
interface Mangrove { x: number; z: number; y: number; s: number }

function landMat(): THREE.MeshStandardMaterial {
  // Part 2 item 6: procedural normal map for real-reading sand/grass micro-relief under the sun
  // instead of a perfectly flat vertex-coloured plane.
  return new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, map: grainTex([1, 1], 0.8, 1.08),
    normalMap: normalTex([24, 24], 0.5), normalScale: new THREE.Vector2(0.4, 0.4),
  });
}

/** Wet sand at the water's edge, and the dry sand further up. */
const SAND_WET: readonly [number, number, number] = [0.70, 0.635, 0.48];
const SAND_DRY: readonly [number, number, number] = [0.95, 0.89, 0.69];
/** Elevation over which sand dries out. Below this the beach is a continuous gradient, not bands. */
const BEACH_TOP = 1.25;

function landColor(I: Island, x: number, z: number, h: number): [number, number, number] {
  const cd = creekDist(x, z), n = hash2(x * 0.13, z * 0.11);
  if (h < BEACH_TOP) {
    // The beach used to be the one part of the land with no variation in it at all: two flat
    // constants, [0.78,0.72,0.56] below half a metre and [0.93,0.86,0.66] above it, while every
    // vegetation band carried a noise term. So a shoreline read as two slabs of poster paint
    // meeting along a contour line, which is the one place the eye is most likely to be looking.
    //
    // It is one continuous beach now: wet at the water and drying as the ground lifts, with the
    // damp line wandering rather than following a height contour exactly, and two octaves of
    // grain over it — a coarse one for patchy damp and a fine one for the sand itself. The
    // vertical gradient does the work the two constants were doing; the noise is what stops it
    // reading as an airbrush.
    const damp = hash2(x * 0.047, z * 0.041);
    const grain = hash2(x * 0.83, z * 0.79);
    // The waterline wanders +/- ~12 cm, so the damp edge is not a contour of the heightfield.
    const u = Math.max(0, Math.min(1, (h - 0.08 - (damp - 0.5) * 0.24) / (BEACH_TOP - 0.2)));
    const dry = u * u * (3 - 2 * u); // smoothstep: flat at the water, flat up the top of the beach
    const shade = 0.93 + 0.09 * grain + 0.05 * (n - 0.5);
    return [
      (SAND_WET[0] + (SAND_DRY[0] - SAND_WET[0]) * dry) * shade,
      (SAND_WET[1] + (SAND_DRY[1] - SAND_WET[1]) * dry) * shade,
      (SAND_WET[2] + (SAND_DRY[2] - SAND_WET[2]) * dry) * shade,
    ];
  }
  if (cd < 16 || I.small) return [0.17 + 0.05 * n, 0.33 + 0.05 * n, 0.15];
  if (I.mainland && inCity(x, z)) return [0.52 + 0.06 * n, 0.53 + 0.06 * n, 0.5 + 0.05 * n];
  return [0.27 + 0.08 * n, 0.47 + 0.07 * n, 0.22 + 0.04 * n];
}

type Box = { x0: number; z0: number; x1: number; z1: number };
const grow = (b: Box, m: number): Box => ({ x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m });
const meets = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

/** Islands whose land landH may raise outside their own outline (made ground: inFill in depth.ts). */
const FILL_ISLANDS = new Set<Island>([RUNWAY.I, MARINAS[0].isl, ...GOLF.map((G) => G.I)]);

/** Grid box an island's land mesh covers: its outline grown by the ~10 m wet beach, plus (for the
 * islands carrying made ground) the legacy footprint, which holds the golf/runway/town fill. */
function terrainBox(I: Island): Box {
  const b = grow(islandBox(I), 16);
  if (!FILL_ISLANDS.has(I)) return b;
  const hx = Math.hypot(I.a * I.c, I.b * I.s) * 1.09, hz = Math.hypot(I.a * I.s, I.b * I.c) * 1.09;
  return { x0: Math.min(b.x0, I.x - hx), z0: Math.min(b.z0, I.z - hz), x1: Math.max(b.x1, I.x + hx), z1: Math.max(b.z1, I.z + hz) };
}

/** True if island I is the nearest shore at (x, z), i.e. this patch of ground is I's to draw (so
 * neighbours whose grids overlap, and the mainland under Miami's islands, never draw it twice). */
function owner(I: Island, nb: Island[]): (x: number, z: number) => boolean {
  return (x, z) => {
    const d = islandDist(I, x, z);
    for (const J of nb) if (islandDist(J, x, z) < d) return false;
    return true;
  };
}

/** Land-mesh stats, for the perf log / tests. */
export const terrainStats = { vertices: 0, triangles: 0, ms: 0 };

/**
 * A real outline's island: a FINE-metre grid (fine enough for Marathon's finger canals) over its
 * box, built in BLOCK x BLOCK-cell blocks. Blocks out at sea are skipped, blocks deep inland (flat,
 * gently rolling ground) are a single quad, and the rest are fine cells. The fine vertices on the
 * edge of a coarse block are snapped onto that block's edge, so the mesh has no T-junction cracks.
 */
const FINE = 3, BLOCK = 4, BS = FINE * BLOCK, SKIRT = -1.95;

function coastMesh(I: Island, nb: Island[], mat: THREE.Material): THREE.Mesh {
  const box = terrainBox(I), mine = owner(I, nb);
  const nbx = Math.ceil((box.x1 - box.x0) / BS), nbz = Math.ceil((box.z1 - box.z0) / BS);
  const nx = nbx * BLOCK, nz = nbz * BLOCK;
  const vid = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
  const pos: number[] = [], col: number[] = [], uv: number[] = [], hs: number[] = [], own: boolean[] = [], idx: number[] = [];
  const vert = (i: number, j: number): number => {
    const k = j * (nx + 1) + i;
    if (vid[k] >= 0) return vid[k];
    const x = box.x0 + i * FINE, z = box.z0 + j * FINE, h = landH(x, z);
    vid[k] = hs.length;
    pos.push(x, h, z); col.push(...landColor(I, x, z, h)); uv.push(x / 14, z / 14); hs.push(h); own.push(mine(x, z));
    return vid[k];
  };
  // coarse corner heights decide which blocks hold any land at all (made ground can sit far out)
  const ch = new Float32Array((nbx + 1) * (nbz + 1));
  for (let j = 0; j <= nbz; j++) for (let i = 0; i <= nbx; i++) ch[j * (nbx + 1) + i] = landH(box.x0 + i * BS, box.z0 + j * BS);
  const coarse: number[] = [];
  for (let bj = 0; bj < nbz; bj++) {
    for (let bi = 0; bi < nbx; bi++) {
      const cx = box.x0 + (bi + 0.5) * BS, cz = box.z0 + (bj + 0.5) * BS, d = islandDist(I, cx, cz);
      const c0 = bj * (nbx + 1) + bi, cMax = Math.max(ch[c0], ch[c0 + 1], ch[c0 + nbx + 1], ch[c0 + nbx + 2]);
      if (d > BS * 0.71 + 12 && cMax < -1.9) continue; // open water
      if (d < -(BS * 0.71 + 24) && creekDist(cx, cz) > BS + 12 && mine(cx, cz)) {
        const a = vert(bi * BLOCK, bj * BLOCK), b = vert(bi * BLOCK + BLOCK, bj * BLOCK);
        const c = vert(bi * BLOCK, bj * BLOCK + BLOCK), e = vert(bi * BLOCK + BLOCK, bj * BLOCK + BLOCK);
        idx.push(a, c, b, b, c, e); coarse.push(bi, bj);
        continue;
      }
      for (let j = bj * BLOCK; j < bj * BLOCK + BLOCK; j++) {
        for (let i = bi * BLOCK; i < bi * BLOCK + BLOCK; i++) {
          const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), e = vert(i + 1, j + 1);
          if (!(own[a] || own[b] || own[c] || own[e])) continue;
          // down to landH's -2 sea floor (not legacy's -1.1), so the grid's ragged edge sits under
          // more water; a cell with a single wet-enough corner is cut on the diagonal (half a cell),
          // which turns the edge's 3 m staircase into chamfers
          const qa = hs[a] > SKIRT, qb = hs[b] > SKIRT, qc = hs[c] > SKIRT, qe = hs[e] > SKIRT, n = +qa + +qb + +qc + +qe;
          if (n === 0) continue;
          if (n > 1) idx.push(a, c, b, b, c, e);
          else if (qa) idx.push(a, c, b);
          else if (qe) idx.push(b, c, e);
          else if (qb) idx.push(a, e, b);
          else idx.push(a, c, e);
        }
      }
    }
  }
  // stitch: fine vertices lying on a coarse block's edge take that edge's straight-line height
  const snap = (i0: number, j0: number, di: number, dj: number) => {
    const ya = hs[vid[j0 * (nx + 1) + i0]], yb = hs[vid[(j0 + dj * BLOCK) * (nx + 1) + i0 + di * BLOCK]];
    for (let t = 1; t < BLOCK; t++) {
      const v = vid[(j0 + dj * t) * (nx + 1) + i0 + di * t];
      if (v >= 0) pos[v * 3 + 1] = ya + ((yb - ya) * t) / BLOCK;
    }
  };
  for (let k = 0; k < coarse.length; k += 2) {
    const i0 = coarse[k] * BLOCK, j0 = coarse[k + 1] * BLOCK;
    snap(i0, j0, 1, 0); snap(i0, j0, 0, 1); snap(i0 + BLOCK, j0, 0, 1); snap(i0, j0 + BLOCK, 1, 0);
  }
  return finishMesh(pos, col, uv, idx, mat);
}

/** The procedural mainland keeps legacy's plain grid over its ellipse's footprint. */
function mainlandMesh(I: Island, nb: Island[], mat: THREE.Material): THREE.Mesh {
  const step = 16, mine = owner(I, nb);
  const lx0 = -5600, lx1 = 5600, lz0 = -I.b * 1.09, lz1 = I.b * 1.09;
  const nx = Math.ceil((lx1 - lx0) / step), nz = Math.ceil((lz1 - lz0) / step);
  const pos: number[] = [], col: number[] = [], uv: number[] = [], hs: number[] = [], own: boolean[] = [], idx: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const w = islandWorld(I, lx0 + i * step, lz0 + j * step), x = w[0], z = w[1], h = landH(x, z);
      pos.push(x, h, z); col.push(...landColor(I, x, z, h)); uv.push(x / 14, z / 14); hs.push(h); own.push(h > -1.1 && mine(x, z));
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      if (Math.max(hs[a], hs[b], hs[c], hs[d]) > -1.1 && (own[a] || own[b] || own[c] || own[d])) idx.push(a, c, b, b, c, d);
    }
  }
  return finishMesh(pos, col, uv, idx, mat);
}

function finishMesh(pos: number[], col: number[], uv: number[], idx: number[], mat: THREE.Material): THREE.Mesh {
  // drop the vertices no emitted cell uses (open water around the land)
  const remap = new Int32Array(pos.length / 3).fill(-1), P: number[] = [], C: number[] = [], U: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    const v = idx[k];
    if (remap[v] < 0) {
      remap[v] = P.length / 3;
      P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); C.push(col[v * 3], col[v * 3 + 1], col[v * 3 + 2]); U.push(uv[v * 2], uv[v * 2 + 1]);
    }
    idx[k] = remap[v];
  }
  pos = P; col = C; uv = U;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  terrainStats.vertices += pos.length / 3; terrainStats.triangles += idx.length / 3;
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}

function buildTerrain(group: THREE.Group): void {
  const t0 = performance.now(), mat = landMat();
  const boxes = islands.map((I) => grow(terrainBox(I), 24));
  islands.forEach((I, i) => {
    const nb = islands.filter((_J, j) => j !== i && meets(boxes[i], boxes[j]));
    group.add(I.coast ? coastMesh(I, nb, mat) : mainlandMesh(I, nb, mat));
  });
  terrainStats.ms = performance.now() - t0;
  (window as unknown as { __islandsDebug?: unknown }).__islandsDebug = { terrain: terrainStats }; // DEV/VERIFICATION ONLY
}

/** Hides scattered scenery: conch houses for which `house` is true, palms and mangroves for which
 * `plant` is true. Each call starts again from everything shown, so pass the whole current set. */
export type ClearScenery = (house: (x: number, z: number) => boolean, plant: (x: number, z: number) => boolean) => void;

interface VegetationResult {
  uTime: { value: number };
  clear: ClearScenery;
  frondMaterial: THREE.MeshStandardMaterial;
  frondBaseCompile: THREE.MeshStandardMaterial['onBeforeCompile'];
}

/** Land area of a real outline, m^2 (a 6 m point count). */
const areaCache = new Map<Island, number>();
function landArea(I: Island): number {
  let A = areaCache.get(I);
  if (A === undefined) {
    const c = I.coast!, S = 6;
    let n = 0;
    for (let x = c.x0 + S / 2; x < c.x1; x += S) for (let z = c.z0 + S / 2; z < c.z1; z += S) if (islandDist(I, x, z) < 0) n++;
    areaCache.set(I, (A = n * S * S));
  }
  return A;
}

/** Maps u in [0,1) to a point on island I's real shoreline (by arc length over all its rings), set
 * MANGROVE_IN metres in on the land side. */
const MANGROVE_IN = 2;
/** Shore samples walked per island when looking for sheltered water to plant in. */
const INLET_WALK = 260;
function shoreWalk(I: Island): (u: number) => [number, number] {
  const segs: number[] = [], cum: number[] = [];
  let L = 0;
  for (const r of I.coast!.rings) {
    const m = r.length / 2;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m, ax = r[i * 2], az = r[i * 2 + 1], bx = r[j * 2], bz = r[j * 2 + 1], l = Math.hypot(bx - ax, bz - az);
      if (l < 1e-6) continue;
      segs.push(ax, az, bx, bz); L += l; cum.push(L);
    }
  }
  return (u) => {
    const s = u * L;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < s) lo = mid + 1; else hi = mid; }
    const o = lo * 4, ax = segs[o], az = segs[o + 1], dx = segs[o + 2] - ax, dz = segs[o + 3] - az, l = Math.hypot(dx, dz);
    const t = 1 - (cum[lo] - s) / l, px = ax + dx * t, pz = az + dz * t, nx = -dz / l, nz = dx / l;
    const sd = islandDist(I, px + nx * MANGROVE_IN, pz + nz * MANGROVE_IN) < 0 ? 1 : -1;
    return [px + nx * MANGROVE_IN * sd, pz + nz * MANGROVE_IN * sd];
  };
}

function buildVegetation(group: THREE.Group): VegetationResult {
  const dummy = new THREE.Object3D();
  const palms: Palm[] = [], houses: House[] = [], mg: Mangrove[] = [];

  islands.forEach((I, idx) => {
    // Counts keep legacy's density: they scale with land area (a real outline's, or the ellipse's pi*a*b).
    const ab = I.coast ? landArea(I) / Math.PI : I.a * I.b;
    const np = Math.min(340, Math.round(ab / 1300) + 4);
    const nh = I.name.startsWith('Bay') || I.name === 'Molasses Keys' || I.name === 'Money Key' ? 0 : Math.min(220, Math.round(ab / 2400) + 1);
    const nm = Math.min(140, Math.round((I.a + I.b) / 10) + 8);
    const box = islandBox(I), bw = box.x1 - box.x0, bd = box.z1 - box.z0;
    const fill = I.coast ? Math.max(0.05, landArea(I) / (bw * bd)) : 1;
    // A candidate spot on the island: a uniform draw in the real outline's box (rejected off the land
    // by the callers' landH tests and `inland`), or legacy's polar draw in the mainland's ellipse.
    const spot = (k: number, s1: number, s2: number, rMax: number): [number, number] => {
      if (!I.coast) {
        const ang = hashCell(WORLD_SEED, idx, k, s1) * Math.PI * 2, r = Math.sqrt(hashCell(WORLD_SEED, idx, k, s2)) * rMax;
        return islandWorld(I, Math.cos(ang) * r * I.a, Math.sin(ang) * r * I.b);
      }
      return [box.x0 + hashCell(WORLD_SEED, idx, k, s1) * bw, box.z0 + hashCell(WORLD_SEED, idx, k, s2) * bd];
    };
    // metres inside I's own shore (legacy kept to r < 0.8 / 0.7 of the ellipse; a real key can be
    // 60 m wide, so the rule is a fixed setback from the water instead)
    const inland = (x: number, z: number, m: number): boolean => !I.coast || islandDist(I, x, z) < -m;
    const onUS1 = (x: number, z: number): boolean => !I.miami && !I.mainland && Math.abs(z - chainZ(x)) < 14;

    let pc = 0;
    for (let k = 0, tries = Math.min(8000, Math.ceil((np * 2) / fill)); k < tries && pc < np && palms.length < 9000; k++) {
      const w = spot(k, SALT.PALM_ANG, SALT.PALM_R, 0.8), l = islandLocal(I, w[0], w[1]);
      if (!inland(w[0], w[1], 6)) continue;
      if (onCourse(I, l[0], l[1]) && hashCell(WORLD_SEED, idx, k, SALT.PALM_SKIP) < 0.85) continue;
      const h = landH(w[0], w[1]);
      if (h < 1.2 || (I.mainland && (Math.abs(w[0]) > 5200 || w[1] < -3900))) continue;
      if (inTownFootprint(w[0], w[1], 6)) continue; // Boot Key Harbor City's streets (entities/town)
      if (I.mainland && inCity(w[0], w[1]) && hashCell(WORLD_SEED, idx, k, SALT.PALM_SKIP_CITY) < 0.7) continue;
      palms.push({
        x: w[0], z: w[1], y: h - 0.1,
        h: lerp(0.8, 1.3, hashCell(WORLD_SEED, idx, k, SALT.PALM_HEIGHT)),
        lx: lerp(-0.22, 0.22, hashCell(WORLD_SEED, idx, k, SALT.PALM_TILT_X)),
        lz: lerp(-0.22, 0.22, hashCell(WORLD_SEED, idx, k, SALT.PALM_TILT_Z)),
      });
      pc++;
    }

    let hc = 0;
    for (let k = 0, tries = Math.min(8000, Math.ceil((nh * 3) / fill)); k < tries && hc < nh; k++) {
      const w = spot(k, SALT.HOUSE_ANG, SALT.HOUSE_R, 0.7), l = islandLocal(I, w[0], w[1]);
      // US-1 runs down the keys (world/bridge.ts lays its road wherever the line is on land); legacy
      // kept houses off the long islands' centreline, which was the same line on its ellipses
      if (onCourse(I, l[0], l[1]) || onUS1(w[0], w[1]) || (!I.coast && Math.abs(l[1]) < 14 && I.b > 150)) continue;
      if (!inland(w[0], w[1], 8)) continue;
      const h = landH(w[0], w[1]);
      if (inTownFootprint(w[0], w[1], 10) || h < 1.3 || creekDist(w[0], w[1]) < 12 || I.noHouses || (I.mainland && (inCity(w[0], w[1]) || Math.abs(w[0]) > 5200 || w[1] < -3900))) continue;
      houses.push({ I, x: w[0], z: w[1], y: h, r: -I.th + (hashCell(WORLD_SEED, idx, k, SALT.HOUSE_ROT) < 0.5 ? 0 : Math.PI / 2) });
      hc++;
    }

    const rim = I.coast ? shoreWalk(I) : null;
    for (let k = 0; k < nm; k++) {
      const u = hashCell(WORLD_SEED, idx, k, SALT.MANGROVE_ANG);
      // on the real shoreline, a couple of metres in; legacy's ellipse at 0.985 for the mainland
      const w = rim ? rim(u) : islandWorld(I, Math.cos(u * Math.PI * 2) * I.a * 0.985, Math.sin(u * Math.PI * 2) * I.b * 0.985);
      if (I.mainland && (Math.abs(w[0]) > 5200 || inCity(w[0], w[1]))) continue;
      // the rim in front of Boot Key Harbor City is its beach and seawall, not a mangrove thicket: they stood right against
      // the promenade rail as black boulders and were the first thing you saw from the water (the polish pass's skyline capture)
      if (inTownFootprint(w[0], w[1], 34)) continue;
      mg.push({ x: w[0], z: w[1], y: Math.max(0.2, landH(w[0], w[1])), s: lerp(3, 6, hashCell(WORLD_SEED, idx, k, SALT.MANGROVE_SIZE)) });
    }

    /*
     * The inlets.
     *
     * The pass above walks the shoreline at even spacing, so mangroves came out spread evenly
     * around an island — the same thin fringe on an exposed headland as in a sheltered cove.
     * That is backwards. A mangrove needs still water to hold onto: the surf side of a point is
     * beach and rock, and the thicket is in the bights and inlets behind it, which on these real
     * OSM coastlines is most of the north shores.
     *
     * Shelter is measured rather than guessed: count how much of a ring around a shore point is
     * land. In a cove the land wraps round you and most of the ring is dry; on a headland you
     * are sticking out into water and almost none of it is. Plant in proportion, and the fringe
     * thickens into the inlets and thins on the points on its own.
     */
    if (rim) {
      const RING_R = 46, RING_N = 12;
      for (let k = 0; k < INLET_WALK; k++) {
        const u = (k + 0.5) / INLET_WALK;
        const w = rim(u);
        if (I.mainland && (Math.abs(w[0]) > 5200 || inCity(w[0], w[1]))) continue;
        if (inTownFootprint(w[0], w[1], 34)) continue;
        if (onCourse(I, ...islandLocal(I, w[0], w[1]))) continue;
        let land = 0;
        for (let a = 0; a < RING_N; a++) {
          const th = (a / RING_N) * Math.PI * 2;
          if (landH(w[0] + Math.cos(th) * RING_R, w[1] + Math.sin(th) * RING_R) > 0) land++;
        }
        // Half the ring is land everywhere on a straight shore; above that is a bight.
        const shelter = Math.max(0, land / RING_N - 0.52) / 0.38;
        if (shelter <= 0.02) continue;
        const n = Math.round(shelter * 3.2);
        for (let j = 0; j < n; j++) {
          // Scattered back into the still water behind the shore line, not on it.
          const jx = (hashCell(WORLD_SEED, idx, k * 7 + j, SALT.MANGROVE_ANG) - 0.5) * 26;
          const jz = (hashCell(WORLD_SEED, idx, k * 7 + j, SALT.MANGROVE_SIZE) - 0.5) * 26;
          const mx = w[0] + jx, mz = w[1] + jz;
          if (inTownFootprint(mx, mz, 30) || creekDist(mx, mz) < 6) continue;
          const h = landH(mx, mz);
          // Mangroves stand IN the water at their own edge, so a little below zero is right;
          // well inland is somebody's back garden and well offshore is open water.
          if (h < -0.5 || h > 1.6) continue;
          mg.push({
            x: mx, z: mz, y: Math.max(0.15, h),
            s: lerp(2.2, 5.4, hashCell(WORLD_SEED, idx, k * 7 + j, SALT.MANGROVE_SIZE)),
          });
        }
      }
    }
  });

  CREEKS.forEach((C, ci) => {
    for (let i = 0; i < C.pts.length; i += 3) {
      for (const sd of [-1, 1]) {
        const p = C.pts[i], q = C.pts[Math.min(C.pts.length - 1, i + 1)];
        const dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1;
        const x = p[0] - (dz / l) * sd * (C.w / 2 + 3), z = p[1] + (dx / l) * sd * (C.w / 2 + 3);
        const h = landH(x, z);
        if (h > 0 && !inCity(x, z)) {
          const sKey = sd < 0 ? 0 : 1;
          mg.push({ x, z, y: h, s: lerp(2.5, 5, hashCell(WORLD_SEED, ci, i * 2 + sKey, SALT.MANGROVE_CREEK_SIZE)) });
        }
      }
    }
  });

  const trunkG = new THREE.CylinderGeometry(0.16, 0.3, 7, 6).translate(0, 3.5, 0);
  const frondG = new THREE.BoxGeometry(1, 0.06, 4).translate(0, 0, 2);
  const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x8a6d4b, flatShading: true }), palms.length);
  const frondMat = new THREE.MeshStandardMaterial({ color: 0x3f8a35, flatShading: true, side: THREE.DoubleSide });
  // Part 2 item 7 ("Vegetation + clouds"): palms didn't move at all. A per-instance-phased wind
  // bend in the vertex shader animates the whole InstancedMesh for free (no CPU per-instance work,
  // no extra draw calls) — `instanceMatrix[3].xyz` (the per-instance world position three bakes
  // into the instance attribute) seeds a hash so fronds don't all sway in lockstep, and the bend
  // scales with distance from the frond's base (position.z, 0 at the trunk) for a believable
  // cantilever whip rather than a rigid rock.
  const windUniforms = { uTime: { value: 0 } };
  // Named (not an inline arrow assigned straight to onBeforeCompile) for the same reason
  // world/water.ts's baseOnBeforeCompile is — core/shadows.ts's CSM integration needs a stable,
  // CSM-agnostic function to re-wrap from on every quality-tier switch.
  const frondBaseCompile: THREE.MeshStandardMaterial['onBeforeCompile'] = (sh) => {
    Object.assign(sh.uniforms, windUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  float windPhase=fract(sin(dot(instanceMatrix[3].xyz,vec3(12.9898,78.233,37.719)))*43758.5453)*6.2832;
  float windLever=(position.z*.25)*(position.z*.25);
  float sway=sin(uTime*1.7+windPhase)*.16+sin(uTime*3.1+windPhase*1.7)*.07;
  transformed.x+=sway*windLever;
  transformed.y-=abs(sway)*windLever*.25;
#endif`);
  };
  frondMat.onBeforeCompile = frondBaseCompile;
  const fronds = new THREE.InstancedMesh(frondG, frondMat, palms.length * 7);
  const up = new THREE.Vector3();
  let fi = 0;
  palms.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(p.lx, 0, p.lz); dummy.scale.set(1, p.h, 1); dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    up.set(0, 7 * p.h, 0).applyEuler(new THREE.Euler(p.lx, 0, p.lz));
    const tx = p.x + up.x, ty = p.y + up.y, tz = p.z + up.z;
    // Frond fan jitter is purely cosmetic sub-object detail (not placement) — left as Math.random().
    for (let k = 0; k < 7; k++) {
      dummy.position.set(tx, ty, tz);
      dummy.rotation.set(rand(0.35, 0.65), (k / 7) * Math.PI * 2 + rand(-0.2, 0.2), 0, 'YXZ');
      dummy.scale.set(1, 1, rand(0.8, 1.15));
      dummy.updateMatrix();
      fronds.setMatrixAt(fi++, dummy.matrix);
    }
  });
  trunks.castShadow = fronds.castShadow = true;
  group.add(trunks, fronds);

  /*
   * Conch houses. The colours were already varied per instance, but every one of them was the
   * same 6 x 3.4 x 7 box under the same roof, so a street of them read as a row of filing
   * cabinets in different colours.
   *
   * Four things, all per-instance and all free — same geometry, same two draw calls, plus two
   * more for the porch and the piers:
   *
   *  - SIZE. Each house gets its own footprint and wall height, and the roof follows it.
   *  - A PORCH on the front, which is the single most Key West thing a small house has.
   *  - PIERS. A good third of them stand on short concrete piers with an open skirt under the
   *    floor, because that is what you do on a key that floods.
   *  - ROOF PITCH and overhang vary, so the ridge line is not identical down the row.
   *
   * Everything derives from the house's own position, so a rebuild is identical and nothing
   * depends on the order houses were generated in.
   */
  const PASTEL = [0xf7c6d0, 0xfde2a7, 0xa8e0d8, 0xb9d4f5, 0xf9f3e3, 0xd8c6f0, 0xffffff, 0xc9e8c2];
  const hm = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 3.4, 7), new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true }), houses.length);
  const rm = new THREE.InstancedMesh(new THREE.ConeGeometry(5.4, 2.4, 4).rotateY(Math.PI / 4), new THREE.MeshStandardMaterial({ color: 0xb8bcc2, flatShading: true, metalness: 0.3, roughness: 0.5 }), houses.length);
  const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(5.6, 0.22, 2.3), new THREE.MeshStandardMaterial({ color: 0xf4f2ec, flatShading: true, roughness: 0.85 }), houses.length);
  const sm = new THREE.InstancedMesh(new THREE.BoxGeometry(5.4, 1.2, 6.4), new THREE.MeshStandardMaterial({ color: 0x8e8b82, flatShading: true, roughness: 0.95 }), houses.length);
  const col = new THREE.Color();
  const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
  houses.forEach((h, i) => {
    // Hashed off the house's own metre position, not its index: adding one house must not
    // re-roll every house after it.
    const hx = Math.round(h.x), hz = Math.round(h.z);
    const r1 = hashCell(WORLD_SEED, hx, hz, SALT.HOUSE_ROT);
    const r2 = hashCell(WORLD_SEED, hz, hx, SALT.HOUSE_ROT);
    const r3 = hashCell(WORLD_SEED, hx + 7919, hz, SALT.HOUSE_ROT);
    const r4 = hashCell(WORLD_SEED, hx, hz + 7919, SALT.HOUSE_ROT);

    const sx = lerp(0.82, 1.3, r1), sz = lerp(0.86, 1.26, r2), sy = lerp(0.88, 1.38, r3);
    const onPiers = r4 < 0.34;
    const lift = onPiers ? 1.15 : 0;
    const wallH = 3.4 * sy;
    const base = h.y + lift;                       // underside of the floor

    dummy.position.set(h.x, base + wallH / 2, h.z); dummy.rotation.set(0, h.r, 0);
    dummy.scale.set(sx, sy, sz); dummy.updateMatrix();
    hm.setMatrixAt(i, dummy.matrix);
    hm.setColorAt(i, col.setHex(PASTEL[Math.abs(hx * 31 + hz) % PASTEL.length]));

    // Roof: follows the walls, with its own pitch and a little extra overhang.
    const pitch = lerp(0.82, 1.35, r2), over = lerp(1.0, 1.12, r1);
    dummy.position.set(h.x, base + wallH + 1.2 * pitch, h.z);
    dummy.scale.set(sx * over, pitch, sz * 1.3 * over); dummy.updateMatrix();
    rm.setMatrixAt(i, dummy.matrix);

    // Porch deck across the front (local +z), at floor level.
    const pz = (7 * sz) / 2 + 1.15;
    dummy.position.set(h.x + Math.sin(h.r) * pz, base + 0.11, h.z + Math.cos(h.r) * pz);
    dummy.rotation.set(0, h.r, 0); dummy.scale.set(sx, 1, 1); dummy.updateMatrix();
    pm.setMatrixAt(i, dummy.matrix);

    // The pier skirt, only under the raised ones. A zero matrix is how the rest of this file
    // hides an instance, and `clearScenery` restores to exactly this, so it stays hidden.
    if (onPiers) {
      dummy.position.set(h.x, h.y + lift / 2, h.z);
      dummy.rotation.set(0, h.r, 0); dummy.scale.set(sx, lift / 1.2, sz); dummy.updateMatrix();
      sm.setMatrixAt(i, dummy.matrix);
    } else {
      sm.setMatrixAt(i, ZERO_M);
    }
  });
  hm.castShadow = rm.castShadow = pm.castShadow = sm.castShadow = true;
  group.add(hm, rm, pm, sm);

  const mm = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x2c5a2a, flatShading: true }), mg.length);
  mg.forEach((m, i) => {
    // Tilt jitter is cosmetic only — left as Math.random(), same call site as legacy.
    dummy.position.set(m.x, m.y + 0.6, m.z); dummy.rotation.set(Math.random(), Math.random(), 0); dummy.scale.set(m.s, m.s * 0.6, m.s); dummy.updateMatrix();
    mm.setMatrixAt(i, dummy.matrix);
  });
  group.add(mm);

  // Owned estates (entities/estates) clear the procedural scenery inside their lots, or the
  // buyer's villa would stand on top of a stranger's cottage. Instances are hidden by a zero-scale
  // matrix and restored from a copy of the original, so nothing is rebuilt.
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const keep = (m: THREE.InstancedMesh) => Float32Array.from(m.instanceMatrix.array as Float32Array);
  const orig = { hm: keep(hm), rm: keep(rm), pm: keep(pm), sm: keep(sm), trunks: keep(trunks), fronds: keep(fronds), mm: keep(mm) };
  const show = (m: THREE.InstancedMesh, a: Float32Array, i: number, on: boolean) => {
    if (on) m.instanceMatrix.array.set(a.subarray(i * 16, i * 16 + 16), i * 16);
    else m.setMatrixAt(i, ZERO);
  };
  const clear: ClearScenery = (house, plant) => {
    // Every part of a house has to go together, or clearing a lot leaves a porch and a set of
    // piers standing in the buyer's garden.
    houses.forEach((h, i) => {
      const on = !house(h.x, h.z);
      show(hm, orig.hm, i, on); show(rm, orig.rm, i, on);
      show(pm, orig.pm, i, on); show(sm, orig.sm, i, on);
    });
    palms.forEach((p, i) => {
      const on = !plant(p.x, p.z);
      show(trunks, orig.trunks, i, on);
      for (let k = 0; k < 7; k++) show(fronds, orig.fronds, i * 7 + k, on);
    });
    mg.forEach((m, i) => show(mm, orig.mm, i, !plant(m.x, m.z)));
    for (const m of [hm, rm, trunks, fronds, mm]) { m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); }
  };
  return { uTime: windUniforms.uTime, clear, frondMaterial: frondMat, frondBaseCompile };
}

function buildRunway(group: THREE.Group): void {
  const R = RUNWAY, I = R.I;
  const g = new THREE.Group();
  g.position.set(I.x, -0.6, I.z);
  g.rotation.y = -I.th;
  group.add(g);
  const len = R.lx1 - R.lx0, cx = (R.lx0 + R.lx1) / 2;
  const rw = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, R.w), new THREE.MeshStandardMaterial({ color: 0x3b3e42, roughness: 0.95, map: grainTex([30, 2], 0.8, 1.05) }));
  rw.position.set(cx, 2.6, R.lz); rw.receiveShadow = true; g.add(rw);
  const stripeM = new THREE.MeshStandardMaterial({ color: 0xf2f2f2 });
  for (let x = R.lx0 + 20; x < R.lx1 - 20; x += 34) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(14, 0.04, 1), stripeM);
    s.position.set(x, 2.67, R.lz);
    g.add(s);
  }
  const apron = new THREE.Mesh(new THREE.BoxGeometry(160, 0.1, 60), new THREE.MeshStandardMaterial({ color: 0x6d7075, roughness: 1 }));
  apron.position.set(cx - 120, 2.59, R.lz + 55); g.add(apron);
  const term = new THREE.Mesh(new THREE.BoxGeometry(40, 7, 16), new THREE.MeshStandardMaterial({ color: 0xf3efe4, flatShading: true }));
  term.position.set(cx - 150, 6, R.lz + 80); term.castShadow = true; g.add(term);
  const plane = new THREE.Group();
  const wm = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, flatShading: true });
  const bm = new THREE.MeshStandardMaterial({ color: 0x1f4f8c, flatShading: true });
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.6, 11, 10), wm); fus.rotation.z = Math.PI / 2; plane.add(fus);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.15, 13), wm); wing.position.set(-0.5, 0.7, 0); plane.add(wing);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.2, 0.15), bm); tail.position.set(4.8, 1.3, 0); plane.add(tail);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 4.2), wm); stab.position.set(4.9, 0.5, 0); plane.add(stab);
  plane.position.set(cx - 100, 4.2, R.lz + 50); plane.rotation.y = 0.4; g.add(plane);
}

export interface IslandsResult {
  group: THREE.Group;
  /** Drives the palm-frond wind sway shader (see buildVegetation) — call once per frame. */
  update(t: number): void;
  /** The frond material + its CSM-agnostic onBeforeCompile — core/shadows.ts needs both to give
   * the wind-animated fronds cascaded shadows without clobbering the wind shader (same reasoning
   * as world/water.ts's baseOnBeforeCompile). */
  frondMaterial: THREE.MeshStandardMaterial;
  frondBaseCompile: THREE.MeshStandardMaterial['onBeforeCompile'];
  /** Hide conch houses / palms / mangroves (entities/estates clears owned lots with it). */
  clearScenery: ClearScenery;
}

export function createIslands(): IslandsResult {
  const group = new THREE.Group();
  buildTerrain(group);
  const veg = buildVegetation(group);
  buildRunway(group);
  return {
    group,
    update(t) { veg.uTime.value = t; },
    frondMaterial: veg.frondMaterial,
    frondBaseCompile: veg.frondBaseCompile,
    clearScenery: veg.clear,
  };
}

/** Exposed for world/bridge.ts and world/marinas.ts, which also need to skip Miami's city area. */
export { inCity };
