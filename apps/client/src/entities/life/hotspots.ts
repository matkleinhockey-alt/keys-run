/**
 * Hotspots (birds working bait, with feeding frenzies that come and go), floating sargassum
 * weedlines, and offshore oil platforms — the three "follow the birds to find a bite" landmarks.
 *
 * Ported faithfully from legacy/index.html:1977-2034 (seabirds → `seabirds.ts`), 2036-2077
 * (`hotspots`/`HS_COUNTS`/`spawnHotspot`/`updateHotspots`), 2078-2090 (`WEEDS`), 2091-2133
 * (`RIGS`/`updateRigs`/`nearRig`), 2134-2143 (`nearWeed`/`updateWeeds`).
 *
 * **Determinism** (docs/ARCHITECTURE.md "Seeding"): hotspot and weedline placement is gameplay-
 * relevant world content — every player must see the same bird-and-bait spot — so it's derived
 * from `hashCell(WORLD_SEED, cell, attempt, salt)` instead of legacy's `Math.random()` rejection
 * sampling (which was also order-dependent: adding hotspot #41 would have reshuffled every one
 * after it). Rig placement needed no such treatment — legacy's 4 rig sites are already fixed
 * coordinates, not randomised at all. Per-blade jitter inside a weed patch stays `Math.random()` — purely
 * cosmetic. Frenzy *timing* is world content too (everyone races to the same boil), so it is
 * `frenzyActive(WORLD_SEED, site, wallClock)` from shared/world/frenzy.ts, not a local timer.
 *
 * Fish anchoring (legacy `ensureAnchors`) is explicitly **not** ported — it reaches into
 * `entities/fish/**`'s `groups`/`spawnGroupAt`/`VIS`, which this task does not own. `fish` counts
 * are kept on each site as inert flavour data for whoever wires that up later.
 */
import * as THREE from 'three';
import { makeSeabird, poseBird, moveBird, type Bird } from './seabirds.js';
import { beamBetween } from '../boat/hull.js';
import { glowTex } from '../boat/decor-textures.js';
import type { LightMatEntry } from '../../core/time-of-day.js';
import { WB, HUMPS, CREEKS, depthAt, zoneAt, type Zone } from '@keysrun/shared/world/depth';
import { steadyCurrentAt, chainTangent } from '@keysrun/shared/world/current';
import { chainZ, shoreInfo } from '@keysrun/shared/world/chain';
import { ampFor } from '@keysrun/shared/waves';
import { hashCell } from '@keysrun/shared/rng';
import { frenzyActive } from '@keysrun/shared/world/frenzy';
import { WORLD_SEED, SALT } from '../../state/constants.js';
import { lerp, rand } from '../../core/math.js';
import { toast } from '../../ui/toast.js';
import { compassWord } from '../../ui/hud.js';
import type { ParticleSystem } from '../../world/particles.js';
import { seaHAt } from '@keysrun/shared/sim/depth-grid';

const HS_COUNTS: Record<Zone, number> = { Creek: 3, Flats: 7, Backcountry: 6, Bridge: 4, 'Hawk Channel': 5, Reef: 6, Offshore: 9 };
const ZONE_CODE: Record<Zone, number> = { Creek: 0, Flats: 1, Backcountry: 2, Bridge: 3, 'Hawk Channel': 4, Reef: 5, Offshore: 6 };

/** Announce radius and cast-capture radius. The boil is ~11 m across, but the bobber drifts and
 * a cast is a 12-85 m lob with no aiming aid, so 40 m is generous on purpose: missing a frenzy
 * you drove a kilometre to by 20 m would feel like a bug, not a skill check. */
const HOTSPOT_CALL_M = 1500;
const HOTSPOT_CAST_M = 40;

export interface GullSite { x: number; z: number }

export interface Hotspot extends GullSite {
  zone: Zone;
  g: THREE.Group;
  birds: Array<{ B: Bird; r: number; h: number; sp: number; ph: number; dive: Record<string, number> | null }>;
  weeds: THREE.Mesh[];
  fish: number;
  amp: number;
  /** Stable id fed to `frenzyActive` — the same `cell` placement hashes from, so it never shifts. */
  site: number;
  active: boolean;
  fr: number;
  told: boolean;
}

/** legacy `spawnHotspot`'s placement half (index.html:2040-2043), restructured per this module's
 * header into a deterministic, position/index-derived pick instead of rejection-sampling against
 * the live boat position. */
function placeHotspot(zone: Zone, i: number): { x: number; z: number } | null {
  const cell = ZONE_CODE[zone] * 1000 + i;
  if (zone === 'Creek' && CREEKS.length) {
    const ci = Math.min(CREEKS.length - 1, Math.floor(hashCell(WORLD_SEED, cell, 0, SALT.HOTSPOT_CREEK_PICK) * CREEKS.length));
    const C = CREEKS[ci];
    const frac = lerp(0.2, 0.8, hashCell(WORLD_SEED, cell, 0, SALT.HOTSPOT_CREEK_FRAC));
    const q = C.pts[Math.min(C.pts.length - 1, Math.floor(frac * C.pts.length))];
    return { x: q[0], z: q[1] };
  }
  if (zone === 'Offshore' && hashCell(WORLD_SEED, cell, 0, SALT.HOTSPOT_HUMP_PICK) < 0.45) {
    const H = HUMPS[hashCell(WORLD_SEED, cell, 1, SALT.HOTSPOT_HUMP_PICK) < 0.55 ? 0 : 1];
    const x = H.x + lerp(-260, 260, hashCell(WORLD_SEED, cell, 0, SALT.HOTSPOT_X));
    const z = chainZ(H.x) + H.dz + lerp(-260, 260, hashCell(WORLD_SEED, cell, 0, SALT.HOTSPOT_Z));
    return { x, z };
  }
  for (let k = 0; k < 300; k++) {
    const x = lerp(WB.x0 + 100, WB.x1 - 100, hashCell(WORLD_SEED, cell, k, SALT.HOTSPOT_X));
    const z = lerp(WB.z0 + 100, WB.z1 - 100, hashCell(WORLD_SEED, cell, k, SALT.HOTSPOT_Z));
    if (zoneAt(x, z) === zone && shoreInfo(x, z).d > 10) return { x, z };
  }
  return null;
}

const weedMat = new THREE.MeshStandardMaterial({ color: 0xc69a33, flatShading: true, roughness: 1 });

/** Fraction of the surface current a weed raft actually makes good. Under 1: it floats in the
 * top metre and takes some of its push from the wind rather than the water. */
const DRIFT_K = 0.62;
/** How far a patch may wander from where it was laid down before it is leaned back, metres. */
const WEED_TETHER_M = 420;
/** Within this, each raft is tilted to the wave under it; beyond it nobody can see the tilt. */
const WEED_TILT_M = 260;

/** legacy `spawnHotspot` (index.html:2039-2051). */
function spawnHotspot(scene: THREE.Scene, zone: Zone, i: number): Hotspot | null {
  const p = placeHotspot(zone, i);
  if (!p) return null;
  const { x, z } = p;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const birds: Hotspot['birds'] = [];
  for (let k = 0; k < 11; k++) {
    const B = makeSeabird(k % 4 === 3 ? 'tern' : 'gull', 1.25);
    g.add(B.g);
    birds.push({ B, r: rand(6, 13), h: rand(10, 18), sp: rand(0.5, 0.9) * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * 6.28, dive: null });
  }
  const weeds: THREE.Mesh[] = [];
  if (zone === 'Offshore') {
    const ang = Math.random() * Math.PI;
    for (let k = 0; k < 14; k++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(rand(4, 8), 0.12, rand(1, 2)), weedMat);
      const t = (k - 7) * 5.5;
      w.position.set(Math.cos(ang) * t + rand(-1.5, 1.5), 0, Math.sin(ang) * t + rand(-1.5, 1.5));
      w.rotation.y = -ang + rand(-0.3, 0.3);
      g.add(w);
      weeds.push(w);
    }
  }
  scene.add(g);
  return { zone, x, z, g, birds, weeds, fish: 2 + Math.floor(Math.random() * 3), amp: ampFor(depthAt(x, z)), site: ZONE_CODE[zone] * 1000 + i, active: false, fr: 0, told: false };
}

export interface WeedPatch extends GullSite {
  ang: number; len: number; wid: number;
  /** Where the patch was laid down. It drifts with the water, but is tethered to this so a
   * weedline is still roughly where the chart says an hour later. */
  x0: number; z0: number;
  im: THREE.InstancedMesh;
  off: Array<[number, number, number, number]>;
  bg: THREE.Group;
  birds: Array<{ B: Bird; r: number; h: number; sp: number; ph: number }>;
  amp: number;
  told: boolean;
}

function spawnWeedPatches(scene: THREE.Scene): WeedPatch[] {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1 });
  const WC = [0xc69a33, 0xb4862a, 0xd8b04a, 0x9c7424, 0xe0bf5a, 0xa98a3a];
  const col = new THREE.Color();
  const spots: Array<[number, number]> = [];
  for (let k = 0; k < 400 && spots.length < 18; k++) {
    const x = lerp(-3800, 3800, hashCell(WORLD_SEED, k, 0, SALT.WEED_X));
    const z = chainZ(x) + lerp(1550, 3700, hashCell(WORLD_SEED, k, 0, SALT.WEED_Z));
    if (depthAt(x, z) > 35) spots.push([x, z]);
  }
  HUMPS.filter((H) => !H.patch).forEach((H, hi) => {
    for (let k = 0; k < 2; k++) {
      spots.push([
        H.x + lerp(-300, 300, hashCell(WORLD_SEED, hi * 2 + k, 0, SALT.WEED_HUMP_OFFX)),
        chainZ(H.x) + H.dz + lerp(-300, 300, hashCell(WORLD_SEED, hi * 2 + k, 0, SALT.WEED_HUMP_OFFZ)),
      ]);
    }
  });
  return spots.map(([x, z], si) => {
    const len = lerp(50, 170, hashCell(WORLD_SEED, si, 0, SALT.WEED_LEN));
    const wid = lerp(3, 9, hashCell(WORLD_SEED, si, 0, SALT.WEED_WID));
    // A weedline is not laid down on a random bearing: sargassum collects along the convergence
    // and shear lines in the surface flow, so the windrow runs WITH the current. The prevailing
    // direction is the steady one (the stream up the chain tangent), not the tide, which reverses
    // twice a cycle — the same argument the wrecks' sea fans are oriented on. A little scatter on
    // top, because a real one wanders.
    const tg = chainTangent(x);
    const ang = Math.atan2(tg.tz, tg.tx) + (hashCell(WORLD_SEED, si, 0, SALT.WEED_ANG) - 0.5) * 0.5;
    const n = Math.round(len / 2.2);
    const im = new THREE.InstancedMesh(geo, mat, n);
    const off: Array<[number, number, number, number]> = [];
    // Clumps and gaps, not an even row of beads. A real windrow is ragged: dense rafts with open
    // water between them, which is also why you run along one looking for the thick bits.
    const clumps = 3 + Math.floor(hashCell(WORLD_SEED, si, 1, SALT.WEED_LEN) * 4);
    for (let i = 0; i < n; i++) {
      // Per-blade placement within an already-deterministic patch — pure visual jitter, stays Math.random().
      const cu = (Math.floor((i / n) * clumps) + 0.5) / clumps - 0.5;
      const u = (cu + (Math.random() - 0.5) * (0.85 / clumps)) * len;
      const v = (Math.random() - 0.5) * wid * (1 - Math.abs(u / len) * 1.2), s = rand(0.7, 2.2);
      off.push([Math.cos(ang) * u - Math.sin(ang) * v, Math.sin(ang) * u + Math.cos(ang) * v, s, Math.random() * 6]);
      im.setColorAt(i, col.setHex(WC[i % WC.length]));
    }
    im.frustumCulled = false;
    scene.add(im);
    const birds: WeedPatch['birds'] = [];
    const bg = new THREE.Group();
    scene.add(bg);
    for (let i = 0; i < 3; i++) {
      const B = makeSeabird(i === 2 ? 'gull' : 'frigate', 1.2);
      bg.add(B.g);
      birds.push({ B, r: rand(15, 30), h: rand(18, 30), sp: rand(0.3, 0.5) * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * 6 });
    }
    return { x, z, x0: x, z0: z, ang, len, wid, im, off, bg, birds, amp: ampFor(depthAt(x, z)), told: false };
  });
}

export interface Rig extends GullSite {
  /** `undefined` on a `twin` marker (legacy `RIGS.push({...,twin:true})`, index.html:2128) — a
   * second fishable point near the platform with no geometry of its own; never visible and never
   * matched by `nearRig` (legacy's own `R.g&&...`), kept only as inert anchor data for whoever
   * wires fish-group anchoring (`ensureAnchors`) up later — see this module's header. */
  g?: THREE.Group;
  fl?: THREE.Mesh;
  fish: number;
  twin: boolean;
  told: boolean;
}

/** What sort of structure stands at a site. The field used to be four copies of one production
 * platform, distinguishable only by `rotation.y = ri * 0.6`; running the chain offshore showed you
 * the same silhouette four times. These are the three things that actually stand in a field:
 * the big manned production platform, a small unmanned wellhead that just caps a well, and a
 * jack-up drilling rig whose legs run right through its hull and tower above the deck. */
export type RigKind = 'platform' | 'satellite' | 'jackup' | 'semisub' | 'spar' | 'derelict';

/**
 * The platforms' (x, dz-from-chain, kind) sites, exported so test/wrecks.test.ts can assert a
 * wreck never overlaps one. Every site is checked for >= 20 m of water by `spawnRigs`, which
 * silently skips any that is too shallow — see test/rigs.test.ts, which asserts none are.
 *
 * Sites must also sit inside `WB`, the box the boat is clamped to. A rig outside it is built and
 * drawn and completely unreachable — you steer at it and stop dead on an invisible wall a few
 * hundred metres short. The first western satellite sat at x -4400 against a limit of -4150 and
 * had been in that state since the field was built; test/rigs.test.ts now asserts it cannot
 * happen again.
 */
export const RIG_SITES: ReadonlyArray<readonly [number, number, RigKind]> = [
  // The inshore row: everything here stands on the bottom, which is what limits it. A jack-up
  // jacks its hull up its own legs and a jacket is welded to the seabed, so both run out of
  // reach past about 120 m — and this row is in 46-144 m.
  [-3950, 2900, 'satellite'], [-3250, 2950, 'platform'], [-2100, 2650, 'jackup'], [-900, 3150, 'platform'],
  [400, 3250, 'satellite'], [1550, 2800, 'jackup'], [2500, 2700, 'satellite'], [3350, 3100, 'platform'],
  // The deep row, further offshore, where standing on the bottom stops being an option and the
  // structures float and are moored instead — which is why they look nothing like the row inside
  // them. Plus two wrecks of the industry: jackets left to rust after the well came up dry.
  [-3980, 3950, 'spar'], [-3300, 3780, 'semisub'], [-2600, 3700, 'derelict'],
  [-1450, 3800, 'semisub'], [950, 3900, 'derelict'], [2950, 3850, 'semisub'],
];

/** legacy `RIGS` (index.html:2091-2129): 4 fixed offshore platforms — no randomness at all, so
 * no `hashCell` treatment is needed (see this module's header). */
function spawnRigs(scene: THREE.Scene, lightMats: LightMatEntry[]): Rig[] {
  const spots = RIG_SITES;
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.55, metalness: 0.4 });
  const rust = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, roughness: 0.8, metalness: 0.2 });
  const deckM = new THREE.MeshStandardMaterial({ color: 0x6b7178, roughness: 0.7, metalness: 0.3 });
  const whiteM = new THREE.MeshStandardMaterial({ color: 0xeef0f1, roughness: 0.6 });
  const orangeM = new THREE.MeshStandardMaterial({ color: 0xe4572e, roughness: 0.6 });
  const heliM = new THREE.MeshStandardMaterial({ color: 0x2f6e4a, roughness: 0.7 });
  const flameM = new THREE.MeshBasicMaterial({ map: glowTex(), color: 0xff8a2a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const lampM = new THREE.SpriteMaterial({ map: glowTex(), color: 0xffe6a8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.2 });
  lightMats.push({ m: lampM, day: 0.15, night: 1 });
  const V = (a: number, b: number, c: number): THREE.Vector3 => new THREE.Vector3(a, b, c);
  const beam = (g: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material): void => { g.add(beamBetween(a, b, r, m)); };

  const rigs: Rig[] = [];
  spots.forEach(([x, dz, kind], ri) => {
    const z = chainZ(x) + dz;
    if (depthAt(x, z) < 20) return;
    const g = new THREE.Group();
    g.position.set(x, 0, z); g.rotation.y = ri * 0.6;
    scene.add(g);
    const box = (w: number, h: number, d: number, m: THREE.Material, px: number, py: number, pz: number): THREE.Mesh => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(px, py, pz); b.castShadow = true; g.add(b);
      return b;
    };
    /**
     * The lifeboats, and the handrail that makes a deck look finished.
     *
     * A manned platform's most recognisable fitting after the flare is the escape capsule: a
     * bright orange free-fall boat sitting nose-down on a steep ramp cantilevered off the deck
     * edge, pointed away from the structure. You abandon by dropping it, bow first, clear of
     * everything — which is why it hangs out over nothing at that angle.
     *
     * Only the manned structures get one. The satellite is an unmanned wellhead with nobody to
     * evacuate, and the derelict's was taken off with the topsides years ago — a lifeboat still
     * hanging on an abandoned jacket would say the opposite of what that structure is for.
     */
    const freefall = (px: number, py: number, pz: number, yaw: number, scale = 1): void => {
      const hullM = new THREE.MeshStandardMaterial({ color: 0xf06a16, roughness: 0.45, metalness: 0.1, flatShading: true });
      const ramp = new THREE.Group();
      ramp.position.set(px, py, pz); ramp.rotation.y = yaw; ramp.scale.setScalar(scale); g.add(ramp);
      // The ramp: two rails raked down and out, with cross-ties.
      const RAKE = -0.62, LEN = 11;
      for (const o of [-1.5, 1.5]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, LEN), steel);
        rail.position.set(o, -Math.sin(-RAKE) * LEN * 0.5, Math.cos(RAKE) * LEN * 0.5);
        rail.rotation.x = RAKE; ramp.add(rail);
      }
      for (const t of [0.2, 0.5, 0.8]) {
        const tie = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.16, 0.16), steel);
        tie.position.set(0, -Math.sin(-RAKE) * LEN * t, Math.cos(RAKE) * LEN * t);
        tie.rotation.x = RAKE; ramp.add(tie);
      }
      // The capsule, nose down the ramp.
      const cap = new THREE.Group();
      cap.position.set(0, -Math.sin(-RAKE) * LEN * 0.46 + 0.8, Math.cos(RAKE) * LEN * 0.46);
      cap.rotation.x = RAKE; ramp.add(cap);
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.25, 4.2, 4, 10), hullM);
      body.rotation.x = Math.PI / 2; cap.add(body);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(1.25, 2.1, 10), hullM);
      nose.rotation.x = Math.PI / 2; nose.position.z = 3.4; cap.add(nose);
      // Canopy hatch and the two windows that make it read as a boat and not a buoy.
      const hatch = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 1.4), new THREE.MeshStandardMaterial({ color: 0xf4f4f2, flatShading: true }));
      hatch.position.set(0, 1.1, -0.4); cap.add(hatch);
      for (const o of [-1.2, 1.2]) {
        const win = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 1.6), new THREE.MeshStandardMaterial({ color: 0x1a2a40, flatShading: true }));
        win.position.set(o, 0.5, 0.6); cap.add(win);
      }
      ramp.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
    };

    /**
     * A davit-launched enclosed boat: the older arrangement, swung out on two curved arms over
     * the side. Kept alongside the free-fall ones so the field is not one fitting repeated.
     */
    const davitBoat = (px: number, py: number, pz: number, yaw: number): void => {
      const d = new THREE.Group();
      d.position.set(px, py, pz); d.rotation.y = yaw; g.add(d);
      const hullM = new THREE.MeshStandardMaterial({ color: 0xf06a16, roughness: 0.45, flatShading: true });
      for (const o of [-2.4, 2.4]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 4.4, 7), steel);
        post.position.set(o, 2.2, 0); d.add(post);
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 3.4, 7), steel);
        arm.position.set(o, 4.1, 1.5); arm.rotation.x = Math.PI / 2.6; d.add(arm);
        const fall = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 4), steel);
        fall.position.set(o, 3, 2.7); d.add(fall);
      }
      const boat = new THREE.Mesh(new THREE.CapsuleGeometry(1.05, 4.4, 4, 10), hullM);
      boat.rotation.z = Math.PI / 2; boat.position.set(0, 1.9, 2.7); d.add(boat);
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.9, 1.5), hullM);
      canopy.position.set(0, 2.7, 2.7); d.add(canopy);
      d.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
    };

    /** A handrail round a deck edge. Cheap, and it is most of what makes a deck read as finished
     * rather than as a slab somebody left floating. */
    const rail = (cx: number, cz: number, w: number, d2: number, y: number, post = 3.4): void => {
      const hw = w / 2, hd = d2 / 2;
      const corners: ReadonlyArray<readonly [number, number]> = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      for (let i = 0; i < 4; i++) {
        const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
        for (const h of [0.55, 1.1]) beam(g, V(cx + ax, y + h, cz + az), V(cx + bx, y + h, cz + bz), 0.055, steel);
        const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / post));
        for (let k = 0; k <= n; k++) {
          const t = k / n, sx2 = cx + ax + (bx - ax) * t, sz2 = cz + az + (bz - az) * t;
          beam(g, V(sx2, y, sz2), V(sx2, y + 1.1, sz2), 0.05, steel);
        }
      }
    };

    const lamp = (px: number, py: number, pz: number, scale = 5): void => {
      const sp = new THREE.Sprite(lampM); sp.scale.setScalar(scale); sp.position.set(px, py, pz); g.add(sp);
    };
    const seabed = -Math.min(40, depthAt(x, z));
    let fl: THREE.Mesh | undefined;

    if (kind === 'platform') {
      // The full manned production platform: two decks, accommodation block, derrick, helipad and
      // a flare boom out on an outrigger. Unchanged from when this was the only kind of rig.
      const H = 12, base = seabed, top = 18;
      const legs: ReadonlyArray<readonly [number, number]> = [[-H, -H], [H, -H], [H, H], [-H, H]];
      legs.forEach(([lx, lz]) => {
        beam(g, V(lx * 1.25, base, lz * 1.25), V(lx * 1.04, -0.6, lz * 1.04), 0.95, rust);
        beam(g, V(lx * 1.04, -0.6, lz * 1.04), V(lx, top, lz), 0.9, steel);
      });
      for (const y of [-16, -6, 6, 13]) {
        const k = y < 0 ? 1.04 + (-0.6 - y) / (-0.6 - base) * 0.21 : 1.0;
        const P = legs.map(([lx, lz]) => V(lx * k, y, lz * k));
        for (let i = 0; i < 4; i++) beam(g, P[i], P[(i + 1) % 4], 0.35, y < 0 ? rust : steel);
      }
      for (let i = 0; i < 4; i++) {
        const [ax, az] = legs[i], [bx, bz] = legs[(i + 1) % 4];
        beam(g, V(ax * 1.02, 1, az * 1.02), V(bx, 12.5, bz), 0.25, steel);
        beam(g, V(bx * 1.02, 1, bz * 1.02), V(ax, 12.5, az), 0.25, steel);
      }
      box(34, 1.2, 34, deckM, 0, top, 0);
      box(30, 1, 30, deckM, 0, top + 6.5, 0);
      for (const [px, pz] of [[-14, -14], [14, -14], [14, 14], [-14, 14]] as const) beam(g, V(px, top + 0.6, pz), V(px, top + 6, pz), 0.45, steel);
      box(14, 5.5, 10, whiteM, -6, top + 3.3, -8);
      box(14, 1, 10, orangeM, -6, top + 6.2, -8);
      box(8, 4, 8, orangeM, 8, top + 2.6, 6);
      box(6, 9, 6, whiteM, 9, top + 11, -9);
      const heli = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 0.5, 24), heliM);
      heli.position.set(-8, top + 12.6, 6); g.add(heli);
      beam(g, V(-8, top + 7, 6), V(-8, top + 12.3, 6), 0.6, steel);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(5, 0.18, 6, 32), new THREE.MeshBasicMaterial({ color: 0xf2c14e }));
      ring.rotation.x = Math.PI / 2; ring.position.set(-8, top + 12.9, 6); g.add(ring);
      beam(g, V(12, top + 7, 12), V(12, top + 12, 12), 0.7, steel);
      beam(g, V(12, top + 12, 12), V(-4, top + 22, 20), 0.35, orangeM);
      beam(g, V(17, top + 6, -6), V(36, top + 16, -12), 0.4, steel);
      fl = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), flameM);
      fl.position.set(37, top + 17.5, -12.5); g.add(fl);
      box(6, 0.4, 3, deckM, H + 3, 1.6, 0);
      beam(g, V(H + 3, 1.8, -1.5), V(H, top, -1.5), 0.15, steel);
      beam(g, V(H + 3, 1.8, 1.5), V(H, top, 1.5), 0.15, steel);
      for (const [px, pz] of [[-16, -16], [16, -16], [16, 16], [-16, 16], [0, 0]] as const) lamp(px, top + 7.5, pz);
      // Escape: a free-fall boat raked off one corner and a pair of davits over the far side, so
      // there is a way off whichever end the fire is not at — which is the entire reason a
      // platform carries two sets in two places.
      freefall(-17, top + 1.2, -14, Math.PI * 0.82);
      davitBoat(16.5, top + 1.2, 13, -Math.PI / 2);
      rail(0, 0, 34, 34, top + 0.6);
      rail(0, 0, 30, 30, top + 7.1);
    } else if (kind === 'satellite') {
      // An unmanned wellhead: four short legs, one small deck, a cluster of capped wells and a
      // nav light. Nobody lives here and nothing burns — it just caps the well and blinks.
      const H = 5, top = 9;
      const legs: ReadonlyArray<readonly [number, number]> = [[-H, -H], [H, -H], [H, H], [-H, H]];
      legs.forEach(([lx, lz]) => {
        beam(g, V(lx * 1.18, seabed, lz * 1.18), V(lx * 1.03, -0.6, lz * 1.03), 0.5, rust);
        beam(g, V(lx * 1.03, -0.6, lz * 1.03), V(lx, top, lz), 0.46, steel);
      });
      for (const y of [-9, -2, 5]) {
        const k = y < 0 ? 1.03 + (-0.6 - y) / (-0.6 - seabed) * 0.15 : 1.0;
        const P = legs.map(([lx, lz]) => V(lx * k, y, lz * k));
        for (let i = 0; i < 4; i++) beam(g, P[i], P[(i + 1) % 4], 0.2, y < 0 ? rust : steel);
      }
      box(14, 0.9, 14, deckM, 0, top, 0);
      // Wellhead cluster: capped christmas trees in a row, the whole point of the structure.
      for (const wx of [-3.4, 0, 3.4]) {
        beam(g, V(wx, top + 0.4, 0), V(wx, top + 3.4, 0), 0.34, steel);
        box(1.5, 0.7, 1.5, orangeM, wx, top + 3.7, 0);
      }
      box(3.6, 2.4, 2.6, whiteM, -4.6, top + 1.6, 4.4);
      // Handrail round the deck edge, which is most of what reads as "platform" at this size.
      // No lifeboat here: an unmanned wellhead has nobody aboard to evacuate.
      rail(0, 0, 14, 14, top + 0.5, 3);
      beam(g, V(6, top + 0.5, -6), V(6, top + 6, -6), 0.22, steel);
      lamp(6, top + 6.4, -6, 3.4);
    } else if (kind === 'semisub') {
      /**
       * A semi-submersible. It does not stand on anything: two long pontoons are ballasted down
       * below the wave zone, four fat columns carry the deck above it, and the whole thing is
       * held over the well on mooring chains. That is the entire reason it looks the way it does
       * — the gap of open water under the deck is the structure's defining feature, and no fixed
       * platform has one.
       */
      const top = 15, colR = 3.4, px = 15, pz = 9;
      // Pontoons, ballasted under the surface. Visible as dark hulls through the water.
      for (const sz of [-1, 1] as const) {
        const pon = new THREE.Mesh(new THREE.BoxGeometry(44, 6, 9), rust);
        pon.position.set(0, -9, sz * pz * 1.5); g.add(pon);
        // Columns up from the pontoons to the deck.
        for (const sx of [-1, 1] as const) {
          // The column has to run from inside the pontoon (which spans y -12..-6) right up into
          // the underside of the deck at y 13.4, or the deck floats detached above a gap — which
          // is exactly what the first version drew, columns stopping 4.4 m short of it.
          const c = new THREE.Mesh(new THREE.CylinderGeometry(colR, colR, 25, 14), steel);
          c.position.set(sx * px, 2.5, sz * pz * 1.5); g.add(c);
          // The boot-top band every floater carries at its waterline.
          const bt = new THREE.Mesh(new THREE.CylinderGeometry(colR + 0.12, colR + 0.12, 2.2, 14), orangeM);
          bt.position.set(sx * px, 0, sz * pz * 1.5); g.add(bt);
          // Diagonal bracing between the columns — the lattice that makes it read as a floater.
          beam(g, V(sx * px, 4, sz * pz * 1.5), V(sx * px * 0.1, -6, sz * pz * 0.2), 0.42, steel);
        }
      }
      box(42, 3.2, 30, deckM, 0, top, 0);
      box(38, 1.1, 26, deckM, 0, top + 7, 0);
      for (const [cx2, cz2] of [[-17, -12], [17, -12], [17, 12], [-17, 12]] as const) beam(g, V(cx2, top + 1.6, cz2), V(cx2, top + 6.6, cz2), 0.5, steel);
      // Accommodation forward, derrick over the moonpool amidships.
      box(16, 6, 12, whiteM, -12, top + 6.2, 0);
      box(16, 1, 12, orangeM, -12, top + 9.7, 0);
      const dTop2 = top + 30;
      const dfeet: ReadonlyArray<readonly [number, number]> = [[5, -5], [13, -5], [13, 5], [5, 5]];
      dfeet.forEach(([fx, fz]) => beam(g, V(fx, top + 1.6, fz), V(9 + (fx - 9) * 0.2, dTop2, (fz) * 0.2), 0.32, steel));
      for (const y of [top + 10, top + 18, top + 25]) {
        const k = 1 - ((y - (top + 1.6)) / (dTop2 - (top + 1.6))) * 0.8;
        const P = dfeet.map(([fx, fz]) => V(9 + (fx - 9) * k, y, fz * k));
        for (let i = 0; i < 4; i++) beam(g, P[i], P[(i + 1) % 4], 0.15, steel);
      }
      box(3, 1.2, 3, orangeM, 9, dTop2 + 0.6, 0);
      const heli2 = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 0.5, 22), heliM);
      heli2.position.set(-14, top + 10.4, 0); g.add(heli2);
      // Mooring chains, angling down and away to the anchors that actually hold it on station.
      for (const [mx, mz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        beam(g, V(mx * px, -8, mz * pz * 1.5), V(mx * 46, seabed, mz * 40), 0.16, rust);
      }
      for (const [lx2, lz2] of [[-20, -14], [20, -14], [20, 14], [-20, 14]] as const) lamp(lx2, top + 2.5, lz2);
      lamp(9, dTop2 + 1.4, 0, 3.6);
      freefall(20, top + 2, -14, Math.PI * 1.15);
      davitBoat(-19, top + 2, 13, Math.PI / 2);
      rail(0, 0, 42, 30, top + 1.6);
      rail(0, 0, 38, 26, top + 7.6);
    } else if (kind === 'spar') {
      /**
       * A spar: one enormous vertical cylinder, most of it under water, with the deck balanced on
       * top of it. It is the simplest silhouette in the field and the most unmistakable — a
       * lighthouse with a drilling rig on it, standing in water far too deep to build in.
       */
      const top = 20, R2 = 7.5;
      const hull = new THREE.Mesh(new THREE.CylinderGeometry(R2, R2, 62, 20), steel);
      hull.position.set(0, -12, 0); g.add(hull);
      // Strakes: the helical fins up a real spar that stop it shedding vortices and humming.
      for (let i = 0; i < 3; i++) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(R2 * 2.3, 20, 0.5), rust);
        st.position.set(0, -6 - i * 0.5, 0); st.rotation.y = i * 1.05; g.add(st);
      }
      const boot = new THREE.Mesh(new THREE.CylinderGeometry(R2 + 0.15, R2 + 0.15, 3, 20), orangeM);
      boot.position.set(0, 0, 0); g.add(boot);
      box(26, 2.6, 26, deckM, 0, top, 0);
      box(22, 1, 22, deckM, 0, top + 6, 0);
      for (const [cx3, cz3] of [[-10, -10], [10, -10], [10, 10], [-10, 10]] as const) beam(g, V(cx3, top + 1.3, cz3), V(cx3, top + 5.6, cz3), 0.42, steel);
      box(12, 5, 9, whiteM, -6, top + 5.5, -6);
      box(12, 1, 9, orangeM, -6, top + 8.5, -6);
      const dTop3 = top + 26;
      const sfeet: ReadonlyArray<readonly [number, number]> = [[2, -3], [8, -3], [8, 3], [2, 3]];
      sfeet.forEach(([fx, fz]) => beam(g, V(fx, top + 1.3, fz), V(5 + (fx - 5) * 0.22, dTop3, fz * 0.22), 0.3, steel));
      for (const y of [top + 9, top + 16, top + 22]) {
        const k = 1 - ((y - (top + 1.3)) / (dTop3 - (top + 1.3))) * 0.78;
        const P = sfeet.map(([fx, fz]) => V(5 + (fx - 5) * k, y, fz * k));
        for (let i = 0; i < 4; i++) beam(g, P[i], P[(i + 1) % 4], 0.14, steel);
      }
      box(2.6, 1, 2.6, orangeM, 5, dTop3 + 0.5, 0);
      // Flare boom out one side, well clear of the deck.
      beam(g, V(11, top + 5, 8), V(27, top + 13, 16), 0.34, steel);
      fl = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), flameM);
      fl.position.set(28, top + 14, 16.6); g.add(fl);
      const heli3 = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 0.5, 20), heliM);
      heli3.position.set(7, top + 9.6, 6); g.add(heli3);
      for (const [mx, mz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        beam(g, V(mx * R2 * 0.8, -26, mz * R2 * 0.8), V(mx * 40, seabed, mz * 36), 0.16, rust);
      }
      for (const [lx3, lz3] of [[-12, -12], [12, -12], [12, 12], [-12, 12]] as const) lamp(lx3, top + 1.8, lz3);
      lamp(5, dTop3 + 1.2, 0, 3.4);
      freefall(-12, top + 1.3, -11, Math.PI * 0.78);
      rail(0, 0, 26, 26, top + 1.3);
      rail(0, 0, 22, 22, top + 6.5);
    } else if (kind === 'derelict') {
      /**
       * A jacket nobody came back for. The well came up dry, the topsides were cut away and
       * barged off, and what is left is four legs and their bracing going quietly orange.
       *
       * It is the best fishing structure out here for exactly that reason — no lights, no flare,
       * no noise, and twenty years of growth on the steel. The lean is the tell: it is the only
       * thing in the field that is not plumb.
       */
      const H = 9, base = seabed, top = 7;
      g.rotation.z = 0.085;                       // settled on one side
      g.rotation.x = -0.05;
      const legs: ReadonlyArray<readonly [number, number]> = [[-H, -H], [H, -H], [H, H], [-H, H]];
      legs.forEach(([lx, lz], li) => {
        beam(g, V(lx * 1.22, base, lz * 1.22), V(lx * 1.03, -0.6, lz * 1.03), 0.8, rust);
        // One leg is sheared off below the waterline — the structure is visibly incomplete.
        const cut = li === 2 ? -2.5 : top;
        beam(g, V(lx * 1.03, -0.6, lz * 1.03), V(lx, cut, lz), 0.74, rust);
      });
      for (const y of [-14, -5, 3]) {
        const k = y < 0 ? 1.03 + (-0.6 - y) / (-0.6 - base) * 0.19 : 1.0;
        const P = legs.map(([lx, lz]) => V(lx * k, y, lz * k));
        // A couple of braces have gone: the ring is not closed any more.
        for (let i = 0; i < 4; i++) {
          if (y === 3 && i === 1) continue;
          if (y === -5 && i === 3) continue;
          beam(g, P[i], P[(i + 1) % 4], 0.3, rust);
        }
      }
      // Stub of the deck that was cut away, and a crumpled piece of it hanging off.
      box(17, 0.9, 17, rust, 0, top, 0);
      box(5, 0.5, 7, rust, 11, top - 2.2, 3);
      beam(g, V(8, top, 2), V(13, top - 2, 4), 0.2, rust);
      // One dead nav light, unlit, left on a pole. Nothing here blinks.
      beam(g, V(-6, top + 0.5, 6), V(-6, top + 5, 6), 0.18, rust);
    } else {
      // A jack-up: the legs run through the hull and tower well above the deck, which is the one
      // silhouette nobody mistakes for a fixed platform. Three legs, a drilling derrick, and the
      // cantilever that slides out over the well.
      const R = 13, top = 16;
      const legs: ReadonlyArray<readonly [number, number]> = [[0, -R], [R * 0.87, R * 0.5], [-R * 0.87, R * 0.5]];
      legs.forEach(([lx, lz]) => {
        beam(g, V(lx, seabed, lz), V(lx, top + 26, lz), 1.05, steel);
        // Spud can: the broad foot a jack-up stands on.
        const can = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.2, 2.2, 12), rust);
        can.position.set(lx, seabed + 1.1, lz); g.add(can);
        // Rack teeth up the leg, which is what makes it read as a leg and not a mast.
        for (let y = -2; y < top + 24; y += 4) beam(g, V(lx - 1.2, y, lz), V(lx + 1.2, y, lz), 0.18, steel);
      });
      for (let i = 0; i < 3; i++) {
        const [ax, az] = legs[i], [bx, bz] = legs[(i + 1) % 3];
        beam(g, V(ax, top + 2, az), V(bx, top + 2, bz), 0.3, steel);
      }
      // Triangular hull, approximated as a slab with the corners carried by the legs.
      box(30, 3.2, 30, deckM, 0, top, 0);
      box(26, 1.2, 26, deckM, 0, top + 2.4, 0);
      box(10, 4.5, 7, whiteM, -8, top + 4.4, 7);
      box(10, 1, 7, orangeM, -8, top + 7, 7);
      // Derrick: a lattice tower over the drill floor.
      const dx = 4, dz2 = -5, dTop = top + 24;
      const feet: ReadonlyArray<readonly [number, number]> = [[dx - 3.2, dz2 - 3.2], [dx + 3.2, dz2 - 3.2], [dx + 3.2, dz2 + 3.2], [dx - 3.2, dz2 + 3.2]];
      feet.forEach(([fx, fz]) => beam(g, V(fx, top + 2.4, fz), V(dx + (fx - dx) * 0.22, dTop, dz2 + (fz - dz2) * 0.22), 0.3, steel));
      for (const y of [top + 8, top + 14, top + 19]) {
        const k = 1 - (y - (top + 2.4)) / (dTop - (top + 2.4)) * 0.78;
        const P = feet.map(([fx, fz]) => V(dx + (fx - dx) * k, y, dz2 + (fz - dz2) * k));
        for (let i = 0; i < 4; i++) beam(g, P[i], P[(i + 1) % 4], 0.14, steel);
      }
      box(3, 1.2, 3, orangeM, dx, dTop + 0.6, dz2);
      // Cantilever out over the stern, where the drill string actually goes down.
      box(9, 1.4, 14, deckM, 4, top + 1.2, -18);
      const heli = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 6.5, 0.5, 20), heliM);
      heli.position.set(-9, top + 4.2, -7); g.add(heli);
      lamp(0, top + 28, -R, 3.6);
      lamp(R * 0.87, top + 28, R * 0.5, 3.6);
      lamp(-R * 0.87, top + 28, R * 0.5, 3.6);
      lamp(0, top + 6, 0);
      freefall(-14, top + 3, 11, Math.PI * 0.25);
      rail(0, 0, 30, 30, top + 3.2);
    }

    g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
    rigs.push({ x, z, g, fl, fish: 999, twin: false, told: false });
    rigs.push({ x: x + 18, z: z - 14, fish: 999, twin: true, told: false });
  });
  return rigs;
}

export interface HotspotWorld {
  update(dt: number, t: number, boat: { x: number; z: number; h?: number }, camera: { x: number; z: number }, particles: ParticleSystem): void;
  /** `audio/engine.ts`'s `AudioFrameInputs.gullSites` — legacy `AUD.gull`'s nearest-hotspot pick
   * (index.html:3214). Hotspots only (rigs/weeds carry their own, much sparser bird life). */
  gullSites(): GullSite[];
  /** Read-only query helpers for whoever wires rod/spear fishing's zone bonuses — legacy
   * `nearRig`/`nearWeed` (index.html:2133-2134). */
  nearRig(x: number, z: number, r?: number): Rig | null;
  nearWeed(x: number, z: number, extra?: number): WeedPatch | null;
  /** The nearest bird/bait frenzy that is on right now within `r` m of (x,z) — what a cast
   * landing there is "into". `fr` is the (eased) frenzy strength. */
  nearHotspot(x: number, z: number, r?: number): { fr: number } | null;
  /** Raw snapshots for `stubs.ts`'s `installWorldLife` — see that module's header; membership is
   * fixed after construction (only each site's internal position/animation state mutates in
   * place), so a one-time call after `createHotspotWorld` stays accurate. */
  listRigs(): readonly Rig[];
  listWeeds(): readonly WeedPatch[];
  listHotspots(): readonly Hotspot[];
  /** Every gull, tern and frigatebird at the bait spots and weedlines, for the boat pistol's target
   * list (game/handgun). The array is rebuilt on each call, so call it per shot, not per frame. */
  birds(): Bird[];
}

/** Builds and animates hotspots, weedlines and oil rigs — legacy's `hotspots`/`WEEDS`/`RIGS`
 * module-level arrays plus `updateHotspots`/`updateWeeds`/`updateRigs`. */
export function createHotspotWorld(scene: THREE.Scene, lightMats: LightMatEntry[]): HotspotWorld {
  const hotspots: Hotspot[] = [];
  (Object.keys(HS_COUNTS) as Zone[]).forEach((zone) => {
    for (let i = 0; i < HS_COUNTS[zone]; i++) {
      const h = spawnHotspot(scene, zone, i);
      if (h) hotspots.push(h);
    }
  });
  const weeds = spawnWeedPatches(scene);
  const rigs = spawnRigs(scene, lightMats);
  const dummy = new THREE.Object3D();

  return {
    update(dt, t, boat, camera, particles) {
      // ---- hotspots: feeding frenzies come and go; birds circle and, during a frenzy, plunge ----
      // Wall clock, not `t`: `t` is this client's sim time, so two players would never agree on
      // when a spot is boiling — and a frenzy only works as an event if everyone can race to it.
      const nowS = Date.now() / 1000;
      for (const h of hotspots) {
        h.active = frenzyActive(WORLD_SEED, h.site, nowS);
        h.fr = lerp(h.fr, h.active ? 1 : 0, Math.min(1, dt * 0.7));
        const fr = h.fr;
        // Announce from far beyond render range (the birds are culled past ~1.1 km, so without
        // this you would only learn of a frenzy by stumbling into it). 1.5 km is ~40 s at planing
        // speed: far enough to be a decision, close enough to still be on when you arrive.
        const hdx = h.x - boat.x, hdz = h.z - boat.z, hd = Math.hypot(hdx, hdz);
        if (h.active && hd < HOTSPOT_CALL_M) {
          if (!h.told) { h.told = true; toast('Birds working, ' + Math.round(hd / 10) * 10 + ' m ' + compassWord(hdx, hdz)); }
        } else if (!h.active && h.fr < 0.05) h.told = false; // re-arm so the next frenzy here is announced too
        const dCam = Math.hypot(h.x - camera.x, h.z - camera.z);
        const near = dCam < 900;
        h.g.visible = dCam < 1100;
        if (h.g.visible) {
          h.birds.forEach((b) => {
            const a = t * b.sp * (1 + fr * 0.6) + b.ph, R = b.r * (1 - 0.35 * fr), Hh = b.h * (1 - 0.4 * fr);
            const cx = Math.cos(a) * R, cy = Hh + Math.sin(t * 1.3 + b.ph), cz = Math.sin(a) * R;
            if (!b.dive && fr > 0.45 && Math.random() < dt * 0.3) b.dive = { t: 0, tx: rand(-9, 9), tz: rand(-9, 9), spl: 0 };
            if (b.dive) {
              const D = b.dive;
              D.t += dt;
              const p = D.t / 1.8;
              let x: number, y: number, z: number, flap = 0, tuck = 0;
              if (p < 0.45) { const q = p / 0.45; x = lerp(cx, D.tx, q); z = lerp(cz, D.tz, q); y = lerp(cy, 0.3, q * q); tuck = Math.min(1, q * 1.6); }
              else if (p < 0.62) {
                x = D.tx; z = D.tz; y = 0.05; tuck = 1;
                if (!D.spl) { D.spl = 1; if (near) particles.splash(h.x + D.tx, h.z + D.tz, 8, 0.8); }
              } else { const q = (p - 0.62) / 0.38; x = lerp(D.tx, cx, q); z = lerp(D.tz, cz, q); y = lerp(0.3, cy, q); flap = 1; }
              if (p >= 1) b.dive = null;
              poseBird(b.B, dt, flap, tuck, 12);
              moveBird(b.B, x, y, z, dt);
            } else {
              const flap = Math.sin(t * 0.8 + b.ph) > 0.1 || fr > 0.5 ? 1 : 0;
              poseBird(b.B, dt, flap, 0, 9 + fr * 3);
              moveBird(b.B, cx, cy, cz, dt);
            }
          });
          h.weeds.forEach((w) => { w.position.y = seaHAt(h.x + w.position.x, h.z + w.position.z, t) + 0.05; });
        }
        if (!near) continue;
        // the surface boils: fish busting bait, white water and bubbles, little silver baitfish spraying out
        if (Math.random() < dt * (0.8 + 7 * fr)) {
          const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 10;
          particles.splash(h.x + Math.cos(a) * r, h.z + Math.sin(a) * r, 4 + Math.floor(fr * 10), 0.6 + fr * 0.7);
        }
        for (let k = 0; k < fr * dt * 28; k++) {
          const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 11;
          particles.spawnP(h.x + Math.cos(a) * r, 0.1, h.z + Math.sin(a) * r, rand(-0.3, 0.3), 0, rand(-0.3, 0.3), rand(1.5, 3), rand(0.8, 2), 0.55, false, h.amp);
        }
        for (let k = 0; k < fr * dt * 24; k++) {
          const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 9, v = rand(1.5, 3.5);
          particles.spawnP(h.x + Math.cos(a) * r, 0.15, h.z + Math.sin(a) * r, Math.cos(a) * v, rand(2, 4.5), Math.sin(a) * v, rand(0.4, 0.8), rand(0.18, 0.32), 0.95, true);
        }
      }


      // ---- weedlines: drift slowly, frigatebirds circle overhead ----
      for (const w of weeds) {
        /*
         * Sargassum is a passive floater: it goes where the water goes. It used to creep along a
         * hardcoded (0.22, 0.05) m/s regardless of what the sea was doing, which meant every
         * weedline in the world drifted the same way at the same speed even while the tide was
         * running the other way past it.
         *
         * `DRIFT_K` is under 1 because a weed raft sits in the top metre and is pushed by the
         * wind as well as the water, so it does not exactly track the surface current. The
         * tether stops a long session from carrying a charted weedline off the map — it is
         * allowed to wander a few hundred metres and then leans back.
         */
        const fl = steadyCurrentAt(w.x, w.z, t);
        const ex = w.x - w.x0, ez = w.z - w.z0;
        const exr = Math.hypot(ex, ez) / WEED_TETHER_M;
        const pull = exr > 1 ? (exr - 1) * 0.35 : 0;
        w.x += (fl.vx * DRIFT_K - ex / Math.max(1, Math.hypot(ex, ez)) * pull) * dt;
        w.z += (fl.vz * DRIFT_K - ez / Math.max(1, Math.hypot(ex, ez)) * pull) * dt;
        const d = Math.hypot(w.x - camera.x, w.z - camera.z);
        const vis = d < 1100;
        w.im.visible = vis; w.bg.visible = vis;
        if (d > 800) continue;
        // Close enough to read the individual rafts: tilt each one to the wave it is sitting on,
        // from the slope of the same height function. A mat on a swell lies along it; a flat row
        // of them riding up and down with no tilt reads as floating tiles.
        const tilt = d < WEED_TILT_M;
        w.off.forEach((o, i) => {
          const x = w.x + o[0], z = w.z + o[1];
          const h0 = seaHAt(x, z, t);
          dummy.position.set(x, h0 + 0.04, z);
          if (tilt) {
            const gx = (seaHAt(x + 2, z, t) - h0) / 2;
            const gz = (seaHAt(x, z + 2, t) - h0) / 2;
            dummy.rotation.set(Math.atan(gz) * 1.4, o[3], -Math.atan(gx) * 1.4, 'YXZ');
          } else {
            dummy.rotation.set(0, o[3], 0);
          }
          dummy.scale.set(o[2], 0.18, o[2] * 0.8);
          dummy.updateMatrix();
          w.im.setMatrixAt(i, dummy.matrix);
        });
        w.im.instanceMatrix.needsUpdate = true;
        w.bg.position.set(w.x, 0, w.z);
        w.birds.forEach((b) => {
          const a = t * b.sp + b.ph;
          poseBird(b.B, dt, Math.sin(t * 0.35 + b.ph) > 0.88 ? 1 : 0, 0, b.B.kind === 'frigate' ? 5 : 9);
          moveBird(b.B, Math.cos(a) * b.r, b.h + Math.sin(t + b.ph), Math.sin(a) * b.r, dt);
        });
        if (!w.told && Math.hypot(w.x - boat.x, w.z - boat.z) < 250) { w.told = true; toast('Weedline ahead — mahi love to hang under the weeds.'); }
      }

      // ---- oil rigs: visible from far out, flare flickering, told once on approach ----
      for (const R of rigs) {
        if (!R.g || !R.fl) continue;
        const near = Math.hypot(R.x - camera.x, R.z - camera.z) < 2500;
        R.g.visible = near;
        if (!near) continue;
        R.fl.lookAt(camera.x, R.fl.position.y, camera.z);
        R.fl.scale.set(1 + 0.15 * Math.sin(t * 9 + R.x), 1 + 0.25 * Math.sin(t * 7.3), 1);
        if (!R.told && Math.hypot(R.x - boat.x, R.z - boat.z) < 450) { R.told = true; toast('Oil rig ahead — amberjack, cobia and tuna stack up around the legs.'); }
      }
    },
    gullSites(): GullSite[] { return hotspots.map((h) => ({ x: h.x, z: h.z })); },
    nearHotspot(x, z, r = HOTSPOT_CAST_M): { fr: number } | null {
      let best: Hotspot | null = null, bd = r;
      for (const h of hotspots) {
        if (!h.active) continue;
        const d = Math.hypot(h.x - x, h.z - z);
        if (d < bd) { bd = d; best = h; }
      }
      return best ? { fr: best.fr } : null;
    },
    nearRig(x, z, r = 60): Rig | null {
      // `R.g` is the test for "a real structure, not a twin anchor marker". This used to also
      // require `R.fl`, which only worked while every rig happened to be a flaring production
      // platform: a wellhead or a jack-up has no flare and would not have been fishable at all.
      for (const R of rigs) if (R.g && Math.hypot(R.x - x, R.z - z) < r) return R;
      return null;
    },
    nearWeed(x, z, extra = 25): WeedPatch | null {
      for (const w of weeds) {
        const dx = x - w.x, dz = z - w.z;
        const u = dx * Math.cos(w.ang) + dz * Math.sin(w.ang), v = -dx * Math.sin(w.ang) + dz * Math.cos(w.ang);
        if (Math.abs(u) < w.len / 2 + extra && Math.abs(v) < w.wid / 2 + extra) return w;
      }
      return null;
    },
    listRigs(): readonly Rig[] { return rigs; },
    listWeeds(): readonly WeedPatch[] { return weeds; },
    listHotspots(): readonly Hotspot[] { return hotspots; },
    birds(): Bird[] {
      return [...hotspots.flatMap((h) => h.birds.map((b) => b.B)), ...weeds.flatMap((w) => w.birds.map((b) => b.B))];
    },
  };
}
