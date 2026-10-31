/**
 * Waterfront estates: the houses people actually keep boats at.
 *
 * The islands were scattered with one conch house — a 6 x 3.4 m box with a cone on it,
 * instanced, identical everywhere — and nothing else. No pools, no docks, and so nowhere in the
 * whole world that a private boat was kept, which is strange in a place where every house on the
 * water has a lift at the end of its dock and something hanging in it.
 *
 * So: a handful of proper waterfront places, each one a house, a pool, a dock out to water deep
 * enough to float a boat, a lift at the end of it with a centre console sitting up out of the
 * water, and often a speedboat tied off alongside.
 *
 * ## Where they go
 *
 * Deterministically, by walking each coastal island's real OSM shoreline and testing candidates
 * the way `islands.ts` tests its own scenery: off the town footprint, off US-1 and the golf
 * courses, clear of the creeks, on ground that is actually above water, and — the one that
 * matters here and nowhere else — with enough depth off the end of the dock to keep a boat.
 * A house with its lift in six inches of water is a house nobody would have built.
 *
 * The outward direction comes from the gradient of `islandDist`, which is signed (negative
 * inside), so the dock runs down the steepest way out of the land rather than away from the
 * island's centre. On a real coastline with bays and spits those are not the same direction, and
 * using the centre puts docks through the neighbour's garden.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hashCell } from '@keysrun/shared/rng';
import { islands, islandDist, chainZ, type Island } from '@keysrun/shared/world/chain';
import { landH, depthAt, onCourse, creekDist } from '@keysrun/shared/world/depth';
import { inTownFootprint, type Rect } from '@keysrun/shared/world/town';
import { PIERS } from '@keysrun/shared/world/piers';
import type { WalkDock } from '../entities/land/ground.js';
import type { DockRect } from '@keysrun/shared/sim/boat';
import { islandLocal } from '@keysrun/shared/world/chain';
import { makeBoat } from '../entities/boat/model.js';
import { placeholderDeps } from '../entities/life/party-boats.js';
import { BOATS, type Boat } from '@keysrun/shared/content/boats';
import { grainTex, normalTex } from '../core/textures.js';
import { lerp } from '../core/math.js';
import { WORLD_SEED, SALT } from '../state/constants.js';

/** Estates per island, at most. Rare on purpose: these are the big places, not every lot. */
const PER_ISLAND = 7;
/** Candidate shore samples walked per island. */
const TRIES = 320;
/** Metres between estates — enough that two never share a garden. */
const SPACING_M = 150;
/** How far the house sits back from the water. */
const SETBACK_M = 26;
/** The dock has to reach water at least this deep, or the lift is pointless. */
const MIN_DOCK_DEPTH = 1.15;
/** ...and it will not run further than this looking for it. */
const MAX_DOCK_M = 46;
/**
 * Hulls are built when you get this close, once, and kept.
 *
 * There are 31 estates. Building a real boat for every one at load — plus the one tied off
 * alongside — is fifty full models standing in the scene forever for the two or three you will
 * ever be near. The lift structure itself is a handful of boxes and goes up with the house; it
 * is only the hulls that wait.
 */
const BOAT_BUILD_M = 520;
/** ...and hidden again past this, so a built estate behind you costs nothing to draw. */
const BOAT_SHOW_M = 900;
/** Clearance between the water and the hoisted keel. */
const HOIST_M = 0.55;

export interface WaterfrontResult {
  group: THREE.Group;
  /** Solid footprints (house, dock, lift) for the boat's collision, same as the marinas'. */
  dockRects: DockRect[];
  /** Hulls that should ride the swell — the ones in the water, never the one up on the lift. */
  floating: THREE.Group[];
  /**
   * Where an estate stands, so `islands.ts`'s scattered conch houses can be cleared off them.
   * `lx/lz` is the lift at the end of its dock — the far end of the whole arrangement, and the
   * only part a verification shot actually needs to aim at.
   */
  sites: Array<{ x: number; z: number; r: number; lx: number; lz: number }>;
  /** Each estate's dock, to walk on and tie up at (entities/land/ground.ts). */
  walkDocks: WalkDock[];
  /** The houses, solid to a person on foot: a square the size of the house's short side. */
  houseRects: Rect[];
  /** Builds the nearby estates' hulls and hides the far ones. See `BOAT_BUILD_M`. */
  update(boat: { x: number; z: number }): void;
  /** VERIFICATION ONLY: what is on each lift, and whether it has been built yet. */
  debug(): Array<{ x: number; z: number; boat: string; len: number; beam: number; depth: number; built: boolean; visible: boolean }>;
  dispose(): void;
}

/**
 * Which boat lives on this lift.
 *
 * Decided by the water under it, not at random: a boat got onto that lift by being driven onto
 * it, so a dock with 1.3 m off the end has a 23 on it and the one in 3 m of water can have the
 * 43. Within what fits, the choice is hashed off the site so it is the same for everyone and
 * does not re-roll when anything else in the world changes.
 */
export function liftBoatFor(depth: number, roll: number): Boat {
  // Enough under the keel to have floated her on, plus the squat of driving in.
  const fits = BOATS.filter((b) => depth > b.draft + 0.5);
  if (!fits.length) return BOATS.reduce((a, b) => (b.draft < a.draft ? b : a));
  return fits[Math.min(fits.length - 1, Math.floor(roll * fits.length))];
}

export function createWaterfront(): WaterfrontResult {
  const group = new THREE.Group();
  group.name = 'waterfront';
  const dockRects: DockRect[] = [];
  const walkDocks: WalkDock[] = [];
  const houseRects: Rect[] = [];
  const floating: THREE.Group[] = [];
  const sites: Array<{ x: number; z: number; r: number; lx: number; lz: number }> = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const keep = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };
  /**
   * One material per distinct look, not per call.
   *
   * This used to return a new `MeshStandardMaterial` every time, and most of the calls are inside
   * the per-estate build — the stucco, the porch trim, the roof tile, the lift motor. Every
   * estate in the world therefore had its own copy of materials identical to its neighbour's,
   * which is the same hazard docs/ARCHITECTURE.md records against `makeBoat`, and it is what
   * stops anything here from being drawn in one go: two meshes can only share a draw call if
   * they share a material.
   */
  const matCache = new Map<string, THREE.MeshStandardMaterial>();
  const M = (c: number, o: { rough?: number; metal?: number; flat?: boolean } = {}): THREE.MeshStandardMaterial => {
    const rough = o.rough ?? 0.75, metal = o.metal ?? 0, flat = o.flat ?? true;
    const key = `${c}|${rough}|${metal}|${flat}`;
    let m = matCache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal, flatShading: flat });
      matCache.set(key, m);
      mats.push(m);
    }
    return m;
  };

  /**
   * THE WATERFRONT IN A HANDFUL OF DRAW CALLS.
   *
   * Measured before this existed (test/profile-gpu-attrib.mjs): 2,100+ draw calls topside
   * against the < 400 budget in docs/ARCHITECTURE.md, 3,445 geometries, and roughly half the
   * whole bill owned by this module. The cause was that every piece of every estate was its own
   * `THREE.Mesh` with its own freshly allocated geometry — a dock alone is a piling every 5 m
   * down both sides, so a single estate spent twenty-odd draw calls before the house.
   *
   * Everything static here is now accumulated by (shape, material) and emitted as one
   * `InstancedMesh` each, world-wide. Shapes are UNIT geometries carrying the per-instance size
   * in the matrix scale, so one unit cube serves every box in every estate.
   *
   * `frustumCulled = false` on the result: an InstancedMesh culls on its base geometry's bounds,
   * which for a unit cube at the origin is meaningless, and these batches span the whole chain
   * anyway so a correct bound would never cull either. The cost is drawing every instance every
   * frame — about 100 k triangles against a 2.5 M budget — and the gain is that the number of
   * draw calls stops depending on how many estates exist at all.
   */
  interface Batch { geo: THREE.BufferGeometry; mat: THREE.Material; xf: THREE.Matrix4[]; cast: boolean; recv: boolean; }
  const batches = new Map<string, Batch>();
  const matIds = new Map<THREE.Material, number>();
  const matId = (m: THREE.Material): number => {
    let id = matIds.get(m);
    if (id === undefined) { id = matIds.size; matIds.set(m, id); }
    return id;
  };
  const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();
  function put(
    shape: string, make: () => THREE.BufferGeometry, m: THREE.Material,
    x: number, y: number, z: number, ry: number,
    sx: number, sy: number, sz: number,
    cast = true, recv = true,
  ): void {
    const key = `${shape}|${matId(m)}`;
    let b = batches.get(key);
    if (!b) { b = { geo: keep(make()), mat: m, xf: [], cast, recv }; batches.set(key, b); }
    _e.set(0, ry, 0); _q.setFromEuler(_e);
    b.xf.push(new THREE.Matrix4().compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz)));
  }

  const wood = new THREE.MeshStandardMaterial({
    color: 0x9c7a55, roughness: 0.92, flatShading: true,
    map: grainTex([2, 8], 0.75, 1.05), normalMap: normalTex([2, 8], 0.8), normalScale: new THREE.Vector2(0.5, 0.5),
  });
  mats.push(wood);
  const pileM = M(0x6e5a44, { rough: 1 });
  const railM = M(0x3a3f45, { rough: 0.5, metal: 0.4 });
  const poolM = M(0x2fa8c4, { rough: 0.12, metal: 0.1 });
  const deckM = M(0xe6e0d2, { rough: 0.9 });
  const lawnM = M(0x4e8c42, { rough: 1 });
  const cableM = M(0x8d949c, { rough: 0.4, metal: 0.6 });
  const bunkM = M(0x2b3138, { rough: 1 });

  /** One estate's lift, and the hulls that have not been built yet. */
  interface Lot {
    cx: number; cz: number; yaw: number;
    spec: Boat;
    /** Waterline height of the hoisted hull. */
    hoistY: number;
    tied: { spec: Boat; x: number; z: number } | null;
    /** The two hulls, once `buildHulls` has run. */
    g: THREE.Group | null;
  }
  const lots: Lot[] = [];

  /** One set of placeholder MFD/GPS/sounder textures for every hull out here. */
  let deps_: ReturnType<typeof placeholderDeps> | null = null;
  const deps = (): ReturnType<typeof placeholderDeps> => (deps_ ??= placeholderDeps());

  /** Outward normal: the gradient of the signed shore distance, which points out of the land. */
  function outward(I: Island, x: number, z: number): [number, number] {
    const d = 7;
    const gx = islandDist(I, x + d, z) - islandDist(I, x - d, z);
    const gz = islandDist(I, x, z + d) - islandDist(I, x, z - d);
    const l = Math.hypot(gx, gz);
    if (l < 1e-6) return [0, 1];
    return [gx / l, gz / l];
  }

  /** One unit cube, sized per instance. Returned nothing before and returns nothing now. */
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material, ry = 0): void => {
    put('box', () => new THREE.BoxGeometry(1, 1, 1), m, x, y, z, ry, w, h, d);
  };

  const coastal = islands.filter((I) => I.coast && !I.small && !I.miami);

  for (let ii = 0; ii < coastal.length; ii++) {
    const I = coastal[ii];
    let placed = 0;
    for (let k = 0; k < TRIES && placed < PER_ISLAND; k++) {
      const u = hashCell(WORLD_SEED, ii, k, SALT.HOUSE_ANG);
      const p = shorePoint(I, u);
      if (!p) continue;
      const [sx, sz] = p;
      const [nx, nz] = outward(I, sx, sz);

      // The house sits back from the water; the dock runs the other way.
      const hx = sx - nx * SETBACK_M, hz = sz - nz * SETBACK_M;
      if (inTownFootprint(hx, hz, 40)) continue;
      if (creekDist(hx, hz) < 30) continue;
      const l = islandLocal(I, hx, hz);
      if (onCourse(I, l[0], l[1])) continue;
      if (!I.miami && !I.mainland && Math.abs(hz - chainZ(hx)) < 20) continue;   // US-1's line
      if (landH(hx, hz) < 1.4) continue;
      if (islandDist(I, hx, hz) > -14) continue;                                  // genuinely inland

      // Does the dock reach water worth keeping a boat in?
      let reach = 0;
      for (let r = 10; r <= MAX_DOCK_M; r += 2) {
        if (depthAt(sx + nx * r, sz + nz * r) >= MIN_DOCK_DEPTH) { reach = r + 8; break; }
      }
      if (!reach || reach > MAX_DOCK_M) continue;

      if (sites.some((s) => Math.hypot(s.x - hx, s.z - hz) < SPACING_M)) continue;
      // keep clear of the public fishing piers (shared world/piers.ts)
      if (PIERS.some((p) => Math.hypot(p.x0 - sx, p.z0 - sz) < 120 || Math.hypot(p.x1 - sx, p.z1 - sz) < 160)) continue;

      const lift = buildEstate(I, ii, k, hx, hz, nx, nz, reach);
      sites.push({ x: hx, z: hz, r: 54, lx: lift[0], lz: lift[1] });
      placed++;
    }
  }

  /** A point on this island's shoreline at walk parameter `u`, or null if it has no rings. */
  function shorePoint(I: Island, u: number): [number, number] | null {
    const rings = I.coast?.rings;
    if (!rings || !rings.length) return null;
    const ring = rings[0];
    const m = ring.length / 2;
    if (m < 3) return null;
    const f = u * m, i = Math.floor(f) % m, j = (i + 1) % m, t = f - Math.floor(f);
    return [lerp(ring[i * 2], ring[j * 2], t), lerp(ring[i * 2 + 1], ring[j * 2 + 1], t)];
  }

  function buildEstate(I: Island, ii: number, k: number, hx: number, hz: number, nx: number, nz: number, reach: number): [number, number] {
    const y = landH(hx, hz);
    // Face the water: the house's +z looks out along the outward normal.
    const yaw = Math.atan2(nx, nz);
    const style = Math.floor(hashCell(WORLD_SEED, ii, k, SALT.HOUSE_ROT) * 3);
    const tint = hashCell(WORLD_SEED, ii, k + 11, SALT.HOUSE_ROT);

    // ---- the lot: a cut lawn and a pool deck between the house and the water
    put('box', () => new THREE.BoxGeometry(1, 1, 1), lawnM, hx + nx * 8, y - 0.1, hz + nz * 8, yaw, 44, 0.3, 54, false, true);

    // ---- the house
    const hw = 20, hd = 13;
    if (style === 0) {
      // Modern: two flat-roofed slabs, the upper one set back, glass to the water.
      const wallM = M(0xf2f1ec, { rough: 0.6 });
      const glassM = M(0x7fb6c9, { rough: 0.08, metal: 0.2 });
      box(hw, 3.6, hd, hx, y + 1.8, hz, wallM, yaw);
      box(hw * 0.74, 3.2, hd * 0.8, hx - nx * 1.6, y + 5.2, hz - nz * 1.6, wallM, yaw);
      box(hw * 0.92, 2.6, 0.3, hx + nx * (hd / 2 + 0.1), y + 1.9, hz + nz * (hd / 2 + 0.1), glassM, yaw);
      box(hw + 2.4, 0.3, hd + 2.4, hx, y + 3.7, hz, M(0xdedbd2, { rough: 0.8 }), yaw);
    } else if (style === 1) {
      // Key West conch mansion: two storeys, deep porches, metal roof, in a sweet colour.
      const body = [0xf6e7c8, 0xd9ecea, 0xf3d9dd, 0xe9f0d8][Math.floor(tint * 4)];
      const wallM = M(body, { rough: 0.85 });
      box(hw, 7.2, hd, hx, y + 3.6, hz, wallM, yaw);
      // Wrap-around porch, upper and lower, on posts.
      for (const [py, ph] of [[1.2, 0.2], [4.6, 0.2]] as const) {
        box(hw + 5, ph, hd + 5, hx, y + py, hz, M(0xf4f2ec, { rough: 0.8 }), yaw);
      }
      for (let i = -2; i <= 2; i++) {
        const ox = i * 5.2;
        const px = hx + Math.cos(yaw) * ox + nx * (hd / 2 + 2.2);
        const pz = hz - Math.sin(yaw) * ox + nz * (hd / 2 + 2.2);
        box(0.26, 3.3, 0.26, px, y + 2.9, pz, M(0xf4f2ec, { rough: 0.8 }));
        box(0.26, 3.3, 0.26, px, y + 6.3, pz, M(0xf4f2ec, { rough: 0.8 }));
      }
      const a = hw * 0.82;
      put('cone4', () => new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4), M(0xb8bcc2, { rough: 0.45, metal: 0.4 }),
        hx, y + 8.9, hz, yaw, a, 3.4, a * (hd / hw * 1.15));
    } else {
      // Mediterranean: stucco, arches, barrel tile.
      const wallM = M([0xf0e2cc, 0xeeded0, 0xf4ead9][Math.floor(tint * 3)], { rough: 0.9 });
      box(hw, 6.4, hd, hx, y + 3.2, hz, wallM, yaw);
      box(hw * 0.46, 3.4, hd * 0.6, hx - nx * 5, y + 8, hz - nz * 5, wallM, yaw);
      const tile = M(0xb4603c, { rough: 0.8 });
      box(hw + 2.2, 0.5, hd + 2.2, hx, y + 6.6, hz, tile, yaw);
      // Arcade along the water side.
      for (let i = -2; i <= 2; i++) {
        const ox = i * 4.4;
        const px = hx + Math.cos(yaw) * ox + nx * (hd / 2 + 1.6);
        const pz = hz - Math.sin(yaw) * ox + nz * (hd / 2 + 1.6);
        put('cyl8', () => new THREE.CylinderGeometry(0.3, 0.3, 1, 8), wallM, px, y + 1.8, pz, 0, 1, 3.6, 1);
      }
      box(hw * 0.9, 0.4, 3.2, hx + nx * (hd / 2 + 1.6), y + 3.7, hz + nz * (hd / 2 + 1.6), tile, yaw);
    }

    // ---- the pool, between the house and the water, with its deck
    const pxC = hx + nx * 15, pzC = hz + nz * 15;
    box(18, 0.22, 13, pxC, y + 0.12, pzC, deckM, yaw);
    put('box', () => new THREE.BoxGeometry(1, 1, 1), poolM, pxC, y + 0.08, pzC, yaw, 11, 0.6, 6);
    // Loungers, because an empty pool deck reads as a car park.
    for (const o of [-3.4, 3.4]) {
      box(0.9, 0.25, 2.1, pxC + Math.cos(yaw) * o - nx * 4.4, y + 0.42, pzC - Math.sin(yaw) * o - nz * 4.4, M(0xf4f4f2, { rough: 0.7 }), yaw);
    }

    // ---- the dock, out to water that will float a boat
    const d0 = 24;                              // where the planks start, inside the shore
    const planks = reach + d0;
    const dockW = 2.4;
    const mx = hx + nx * (d0 + planks / 2), mz = hz + nz * (d0 + planks / 2);
    box(dockW, 0.22, planks, mx, 1.05, mz, wood, yaw);
    dockRects.push({ x0: mx - planks / 2, x1: mx + planks / 2, z0: mz - planks / 2, z1: mz + planks / 2 });
    walkDocks.push({ x0: hx + nx * d0, z0: hz + nz * d0, nx, nz, len: planks, w: dockW, top: 1.05 + 0.11, name: 'a private dock' });
    houseRects.push({ x0: hx - hd / 2, x1: hx + hd / 2, z0: hz - hd / 2, z1: hz + hd / 2 });
    for (let s = 0; s <= planks; s += 5) {
      const px = hx + nx * (d0 + s), pz = hz + nz * (d0 + s);
      for (const o of [-dockW / 2, dockW / 2]) {
        // tapered (0.17 top, 0.19 foot), so this one keeps its real dimensions rather than
        // scaling a unit cylinder — every piling in the world is the same piling
        put('pile', () => new THREE.CylinderGeometry(0.17, 0.19, 5.4, 7), pileM,
          px + Math.cos(yaw) * o, -1.1, pz - Math.sin(yaw) * o, 0, 1, 1, 1);
      }
    }

    /*
     * ---- the boat lift at the end, built around the boat that lives on it
     *
     * The lift used to be one fixed 6.8 x 3.8 m frame with a 7.4 m box hull in it, turned a
     * quarter circle — which laid every boat in the world ACROSS its own lift, bow out over one
     * side and stern over the other. The hull is modelled bow-to--z, the same as the player's,
     * so a boat parallel to the dock is `yaw` (bow in) or `yaw + PI` (bow out to open water,
     * which is how you would leave).
     */
    const lx = hx + nx * (d0 + planks + 1.5), lz = hz + nz * (d0 + planks + 1.5);
    const liftDepth = depthAt(lx, lz);
    const spec = liftBoatFor(liftDepth, hashCell(WORLD_SEED, ii, k + 41, SALT.HOUSE_ROT));
    const L = spec.len, B = spec.beam;
    // Posts stand outboard of the rails; the two bents sit under the hull about where a trailer's
    // bunks would. Everything below is derived from those two, so the frame grows with the boat.
    const postHalf = B / 2 + 0.6, bentHalf = L * 0.27;
    const liftOff = dockW / 2 + postHalf + 0.6;
    const liftSide = Math.cos(yaw) * liftOff, liftSideZ = -Math.sin(yaw) * liftOff;
    const cx = lx + liftSide, cz = lz + liftSideZ;
    const hoistY = spec.draft + HOIST_M;         // waterline of the hull, hoisted clear
    const cradleY = hoistY - spec.draft - 0.1;   // the beams just under her keel
    const topY = hoistY + 3.9;                   // above the T-top, where the cables hang from
    const postH = topY + 0.5 + 2.2;

    for (const o of [-bentHalf, bentHalf]) {
      const bx = cx + nx * o, bz = cz + nz * o;
      for (const sgn of [-1, 1]) {
        const px = bx + Math.cos(yaw) * sgn * postHalf, pz = bz - Math.sin(yaw) * sgn * postHalf;
        put('post', () => new THREE.CylinderGeometry(0.15, 0.15, 1, 6), railM,
          px, topY + 0.5 - postH / 2, pz, 0, 1, postH, 1);
        // The cable from the top beam down to the cradle, which is what a lift actually is.
        put('cable', () => new THREE.CylinderGeometry(0.025, 0.025, 1, 4), cableM,
          bx + Math.cos(yaw) * sgn * (postHalf - 0.12), (topY + cradleY) / 2,
          bz - Math.sin(yaw) * sgn * (postHalf - 0.12), 0, 1, topY - cradleY, 1, false, false);
      }
      box(B + 1.5, 0.22, 0.22, bx, cradleY, bz, railM, yaw);   // cradle beam
      box(B + 1.9, 0.3, 0.3, bx, topY, bz, railM, yaw);        // top beam
    }
    // Carpeted bunks along the cradle, under where the chines land.
    for (const sgn of [-1, 1]) {
      box(0.26, 0.16, bentHalf * 2 + 0.5,
        cx + Math.cos(yaw) * sgn * B * 0.3, cradleY + 0.19, cz - Math.sin(yaw) * sgn * B * 0.3, bunkM, yaw);
    }
    // The motor and its switch, on the inboard post at the shore end.
    box(0.46, 0.5, 0.4, cx - nx * bentHalf + Math.cos(yaw) * -postHalf, topY - 0.55, cz - nz * bentHalf - Math.sin(yaw) * -postHalf, M(0x3b4046, { rough: 0.6 }), yaw);
    dockRects.push({ x0: cx - L * 0.46, x1: cx + L * 0.46, z0: cz - L * 0.46, z1: cz + L * 0.46 });

    // ---- and often something tied off on the other side, in the water
    const tiedRoll = hashCell(WORLD_SEED, ii, k + 29, SALT.HOUSE_ROT);
    let tied: Lot['tied'] = null;
    if (tiedRoll < 0.62) {
      const sxB = lx - liftSide, szB = lz - liftSideZ;
      // Whatever the water alongside the dock will take — usually the smaller of the two.
      const tSpec = liftBoatFor(Math.min(liftDepth, depthAt(sxB, szB)), hashCell(WORLD_SEED, ii, k + 53, SALT.HOUSE_ROT));
      tied = { spec: tSpec, x: sxB, z: szB };
      dockRects.push({ x0: sxB - tSpec.len * 0.46, x1: sxB + tSpec.len * 0.46, z0: szB - tSpec.len * 0.46, z1: szB + tSpec.len * 0.46 });
    }

    lots.push({ cx, cz, yaw, spec, hoistY, tied, g: null });
    void I; void tint;
    return [cx, cz];
  }

  /**
   * Put the hulls in. Called the first time the player comes within `BOAT_BUILD_M` of an estate
   * and never again — `makeBoat` is the player's own model, and building 50 of them up front for
   * the two you will visit is what the laziness is for.
   */
  /**
   * Collapse a moored boat to one mesh per material.
   *
   * `makeBoat` builds the PLAYER's boat — console, T-top, rails, cleats, screens, outboards — as
   * thirty-odd separate meshes, because on the player's own boat those parts move: props spin,
   * the wheel turns, the screens update. A boat sitting on a lift or tied alongside does none of
   * that; it is scenery. Measured (test/profile-gpu-owners.mjs): these hulls were 893 of 1,960
   * draw calls topside, far and away the biggest owner in the frame.
   *
   * Geometry is CLONED, never disposed: `makeBoat` is cache-backed, so the parts belong to every
   * other boat of that type in the world too (see entities/boat/model.ts). Materials are reused
   * as they are, which is what lets the merge group by them at all.
   */
  function flattenStatic(root: THREE.Object3D): void {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const byMat = new Map<THREE.Material, THREE.Mesh[]>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material) || !m.geometry) return;
      for (let q: THREE.Object3D | null = o; q && q !== root; q = q.parent) if (!q.visible) return;
      const mat = m.material as THREE.Material;
      const list = byMat.get(mat) ?? [];
      list.push(m);
      byMat.set(mat, list);
    });

    for (const [mat, meshes] of byMat) {
      if (meshes.length < 2) continue;
      const geos = meshes.map((m) => {
        const g = m.geometry.clone();
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        return g;
      });
      // `mergeGeometries` refuses a mixed set and returns null. The parts of a boat are a mix of
      // indexed primitives and non-indexed lathed/extruded shapes, so without this the merge
      // failed for those materials — and the first version of this function had already detached
      // the meshes by then, which silently deleted 20,220 triangles of boat (measured) rather
      // than merging them. Normalising to non-indexed costs some vertices and always succeeds.
      const mixed = geos.some((g) => !g.index) && geos.some((g) => g.index);
      const parts = mixed ? geos.map((g) => (g.index ? g.toNonIndexed() : g)) : geos;
      const merged = mergeGeometries(parts, false);
      if (mixed) for (let i = 0; i < geos.length; i++) if (parts[i] !== geos[i]) geos[i].dispose();
      if (!merged) { for (const g of parts) g.dispose(); continue; } // leave the meshes as they are
      for (const g of parts) g.dispose();

      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = meshes.some((m) => m.castShadow);
      mesh.receiveShadow = meshes.some((m) => m.receiveShadow);
      for (const m of meshes) m.parent?.remove(m);
      root.add(mesh);
    }
  }

  function buildHulls(lot: Lot): void {
    const g = new THREE.Group();
    // Bow out to open water. `makeBoat` models bow-to--z, and local +z here is the outward
    // normal, so `yaw` would park her nose against the seawall.
    const lifted = makeBoat(lot.spec, deps());
    lifted.group.position.set(lot.cx, lot.hoistY, lot.cz);
    lifted.group.rotation.y = lot.yaw + Math.PI;
    // Each hull is flattened on its OWN group, never on `g`. The tied boat's group is handed to
    // `floating`, which bobs it on the water every frame; merging the two hulls together would
    // bake that boat into the lifted one's frame and it would stop moving.
    flattenStatic(lifted.group);
    g.add(lifted.group);
    if (lot.tied) {
      const t = makeBoat(lot.tied.spec, deps());
      t.group.position.set(lot.tied.x, 0, lot.tied.z);
      t.group.rotation.y = lot.yaw + Math.PI;
      flattenStatic(t.group);
      g.add(t.group);
      floating.push(t.group);
    }
    lot.g = g;
    group.add(g);
  }

  // Every static piece of every estate, as one InstancedMesh per (shape, material).
  for (const b of batches.values()) {
    const im = new THREE.InstancedMesh(b.geo, b.mat, b.xf.length);
    for (let i = 0; i < b.xf.length; i++) im.setMatrixAt(i, b.xf[i]);
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = b.cast; im.receiveShadow = b.recv;
    im.frustumCulled = false; // see the doc comment on `put`
    group.add(im);
  }

  return {
    group,
    dockRects,
    floating,
    sites,
    walkDocks,
    houseRects,
    update(boat) {
      for (const lot of lots) {
        const d = Math.hypot(lot.cx - boat.x, lot.cz - boat.z);
        if (!lot.g && d < BOAT_BUILD_M) buildHulls(lot);
        if (lot.g) lot.g.visible = d < BOAT_SHOW_M;
      }
    },
    debug: () => lots.map((l) => ({
      x: +l.cx.toFixed(0), z: +l.cz.toFixed(0), boat: l.spec.id,
      len: l.spec.len, beam: l.spec.beam, depth: +depthAt(l.cx, l.cz).toFixed(2),
      built: !!l.g, visible: !!l.g?.visible,
    })),
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      // The lazily built hulls own geometry and materials this module never saw.
      for (const lot of lots) {
        lot.g?.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.geometry.dispose();
          for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
        });
      }
    },
  };
}
