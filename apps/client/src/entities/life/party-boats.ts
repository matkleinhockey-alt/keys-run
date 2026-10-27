/**
 * Boats tied up off the beach with the music on — the anchorage scene every weekend in the Keys:
 * a couple of hulls rafted together in waist-deep water a short swim off the shore, bows into the
 * breeze, swinging slowly on the hook, nobody going anywhere.
 *
 * Net-new (legacy had moving traffic and nothing moored). Three deliberate decisions:
 *
 * 1. **They are real boats, not scenery props.** `makeBoat` gives each one the full hull the
 *    player drives — including its own deck party, cooler, bimini and night lighting — and
 *    `updateParty` (the exact function that animates the player's own crew) makes them dance. A
 *    hand-built low-detail stand-in would have been cheaper right up until you idled past one.
 * 2. **The sites are found, not typed in.** Each anchorage marches seaward from its island and
 *    stops at the first spot that is genuinely floatable and genuinely close to the shore, using
 *    the real `depthAt`/`landH`/`shoreInfo` — the same self-correcting approach
 *    `world/depth.ts`'s `MARINAS` uses, and the reason a terrain change can't leave a party boat
 *    sitting in a mangrove. Asserted in test/party-boats.test.ts.
 * 3. **Each one has its own tempo.** `PartySite.bpm` per boat, not one world tempo, so two boats
 *    rafted side by side drift in and out of phase with each other the way they really do. The
 *    music itself is synthesized positionally by `audio/engine.ts`'s `updateParties` — see that
 *    function's header for why a muffled kick and a crowd beats a music stream across 200 m of
 *    open water.
 *
 * "Not too many of them": four boats at three anchorages. They are a thing you come across, not
 * a feature of every shoreline.
 */
import * as THREE from 'three';
import { chainZ, shoreInfo } from '@keysrun/shared/world/chain';
import { depthAt, landH } from '@keysrun/shared/world/depth';
import { BOATS } from '@keysrun/shared/content/boats';
import { waveHBase, waveSlope } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { makeBoat, type BoatBuildDeps, type BoatModel } from '../boat/model.js';
import { updateParty } from './deck-party.js';
import { rand } from '../../core/math.js';
import type { ParticleSystem } from '../../world/particles.js';
import type { PartySite } from '../../audio/interfaces.js';

/** Shallowest water a party boat will sit in, metres. Deep enough that the hull is floating, not
 * aground — these boats are anchored, not beached. */
const MIN_DEPTH = 1.8;
/** How far off the shoreline the anchorage must be, metres: far enough to swing on the hook,
 * close enough that "tied up next to the shore" is the honest description. */
const MIN_SHORE_D = 22;
const MAX_SHORE_D = 150;

/**
 * Beyond this the hull is not drawn at all, metres. Generous — a boat on the beach is a landmark
 * you steer by — but finite, because `makeBoat` builds a fully detailed hull.
 */
const DRAW_RANGE = 1400;
/**
 * Beyond this the boat's own lights are switched off, metres.
 *
 * This one is load-bearing, not a polish detail: `makeBoat` hangs about five `PointLight`s off
 * every hull (underwater transom lights plus two cabin lights), and four party boats would put
 * twenty permanent point lights into a scene that also has the player's boat, the race field and
 * the sun. Three.js compiles the light count into every material, so that is a shader-recompile
 * and a per-fragment cost paid by the whole world, all day, for glows nobody can resolve from
 * 200 m. `visible = false` on a light removes it from the render entirely (the renderer's
 * `projectObject` skips invisible subtrees before it collects lights), which is what this does.
 */
const LIGHT_RANGE = 170;
/** Deck-party animation (per-figure IK) stops beyond this, metres. */
const PARTY_RANGE = 260;

/** An anchorage: a spot on the chain and which side of it to look on. */
interface Anchorage {
  name: string;
  /** Along-chain x to search at. */
  x: number;
  /** Offshore of `chainZ(x)` to start the search from, metres — the island this anchorage belongs
   * to. Needed because `chainZ(x)` itself is inside Vaca Key for most of the chart, so a search
   * started there walks out to Vaca's own beach no matter which islet you meant. */
  startDz: number;
  /** +1 searches seaward (ocean side, increasing z), -1 searches into the Gulf. */
  dir: 1 | -1;
  /** The island the found spot must actually be off, as `shoreInfo().isl.name` reports it —
   * asserted in test/party-boats.test.ts, because getting this wrong is silent: the boat still
   * floats, it is just not where the name says. */
  isl: string;
  /** Boats rafted up here, by `BOATS` id — see this module's header on "not too many". */
  boats: readonly string[];
}

/**
 * Three anchorages people actually use off Marathon. The `x`/`dir` pair is a search hint, not a
 * position — `findAnchorage` below decides where the water is.
 */
const ANCHORAGES: readonly Anchorage[] = [
  // Off Sombrero Beach on the Vaca Key ocean side: the big weekend raft-up. The Midnight Express
  // brings the dance pole (entities/boat/model.ts builds one for that hull only).
  { name: 'Sombrero Beach', x: -300, startDz: 0, dir: 1, isl: 'Marathon (Vaca Key)', boats: ['midnight', 'grady'] },
  // East Sister Rock — a real anchorage off a private islet out in Hawk Channel (world/chain.ts
  // places it at dz 560). The Freeman has the pull-down deck shower, which is what it is for.
  { name: 'East Sister Rock', x: 900, startDz: 560, dir: 1, isl: 'East Sister Rock', boats: ['freeman'] },
  // Gulf side off Bamboo Key: shallow, flat, nobody around.
  { name: 'Bamboo Key', x: 350, startDz: -1350, dir: -1, isl: 'Bamboo Key', boats: ['robalo'] },
];

/**
 * Walks outward from the chain line at `x` until the water is both deep enough to float a hull
 * and close enough to a shoreline to be an anchorage rather than open water. Returns the first
 * such spot, or `null` if this stretch has nowhere suitable — a caller with a null simply has one
 * fewer anchorage, which is better than parking a boat on a flat.
 */
export function findAnchorage(x: number, dir: 1 | -1, startDz = 0): { x: number; z: number } | null {
  const z0 = chainZ(x) + startDz;
  for (let k = 0; k < 1400; k++) {
    const z = z0 + dir * k;
    if (landH(x, z) > 0.05) continue;
    const sd = shoreInfo(x, z).d;
    if (sd < MIN_SHORE_D) continue;
    if (sd > MAX_SHORE_D) break; // walked past the shoreline band entirely — nothing out here
    if (depthAt(x, z) < MIN_DEPTH) continue;
    return { x, z };
  }
  return null;
}

/** One moored boat. */
interface MooredBoat {
  id: string;
  site: PartySite;
  model: BoatModel;
  /** Anchorage centre this boat swings around. */
  ax: number;
  az: number;
  /** Heading the bow settles on (away from the shore), radians. */
  baseYaw: number;
  /** Phase offset so rafted boats don't swing in lockstep. */
  swingPh: number;
  /** Hull length, metres — where the bow cleat is. */
  len: number;
  /** The mooring line to the piling, rebuilt in place each frame as the boat swings. */
  rope: THREE.Mesh;
  ropeFrom: THREE.Vector3;
  /** Where the line is made fast — a piling driven into the shallows. */
  tieX: number;
  tieZ: number;
}

export interface PartyBoats {
  group: THREE.Group;
  update(dt: number, t: number, camera: { x: number; y: number; z: number }, particles: ParticleSystem, todK: () => number): void;
  /** What `audio/engine.ts`'s `updateParties` needs — one entry per moored boat. */
  sites(): readonly PartySite[];
  /** VERIFICATION-ONLY: where each boat ended up, and the water under it. */
  debugPlacement(): Array<{ id: string; x: number; z: number; depth: number; shoreD: number; land: number }>;
  dispose(): void;
}

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();

/** Re-aims a unit-height cylinder so it spans `from`→`to`. One mesh, reused every frame — the
 * alternative (rebuilding geometry as the boat swings) allocates a BufferGeometry per frame. */
function spanRope(rope: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
  _dir.subVectors(to, from);
  const len = _dir.length() || 0.001;
  _mid.copy(from).addScaledVector(_dir, 0.5);
  rope.position.copy(_mid);
  rope.quaternion.setFromUnitVectors(UP, _dir.divideScalar(len));
  rope.scale.set(1, len, 1);
}

/** Switches a moored boat's own lighting in or out of the render — see `LIGHT_RANGE`. */
function setLights(model: BoatModel, on: boolean): void {
  if (model.lights) model.lights.visible = on;
  model.cabinLight.visible = on;
  model.cabinLight2.visible = on;
}

/** Shared with entities/life/sandbar.ts, which builds the same real hulls for the same reason. */
export function placeholderDeps(): BoatBuildDeps {
  // Same trick game/race/opponents.ts uses: a moored boat's MFD/GPS/sounder screens are never
  // legible from the water, so they get a 2x2 texture instead of three render targets each.
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const placeholder = new THREE.CanvasTexture(c);
  return { lightMats: [], todK: 0.3, mfdTex: placeholder, gpsTex: placeholder, sonTex: placeholder };
}

export function createPartyBoats(scene: THREE.Scene): PartyBoats {
  const group = new THREE.Group();
  group.name = 'partyBoats';
  scene.add(group);

  const deps = placeholderDeps();
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.9 });
  const pileMat = new THREE.MeshStandardMaterial({ color: 0x5c4a38, roughness: 0.95, flatShading: true });
  const moored: MooredBoat[] = [];

  for (const anc of ANCHORAGES) {
    const spot = findAnchorage(anc.x, anc.dir, anc.startDz);
    if (!spot) continue;
    // The shore lies back along -dir, so the bow settles pointing the other way (into the breeze
    // that pushes a boat onto a lee shore — which is also what keeps the line tight).
    const baseYaw = anc.dir > 0 ? 0 : Math.PI;
    // The piling: inshore of the raft, in the shallows between the boats and the beach.
    const tieX = spot.x + 6, tieZ = spot.z - anc.dir * 16;

    const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 3.4, 7), pileMat);
    pile.position.set(tieX, 0.7, tieZ);
    pile.castShadow = true;
    group.add(pile);

    anc.boats.forEach((boatId, i) => {
      const spec = BOATS.find((b) => b.id === boatId);
      if (!spec) return;
      const model = makeBoat(spec, deps);
      group.add(model.group);
      // Rafted alongside: each boat sits a beam-and-a-bit off the last one, which is how you tie
      // up to a friend rather than to the bottom.
      const ax = spot.x + i * 5.2;
      const az = spot.z + i * 1.4;
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 5), ropeMat);
      group.add(rope);
      moored.push({
        id: `party-${anc.name.replace(/\s+/g, '-').toLowerCase()}-${boatId}`,
        site: { id: `party-${anc.name}-${boatId}`, x: ax, z: az, bpm: Math.round(rand(112, 126)) },
        model, ax, az, baseYaw, swingPh: Math.random() * 6.28, len: spec.len,
        rope, ropeFrom: new THREE.Vector3(), tieX, tieZ,
      });
    });
  }

  const sites: PartySite[] = moored.map((m) => m.site);

  return {
    group,

    update(dt, t, camera, particles, todK): void {
      for (const m of moored) {
        // Culling by distance would mean a boat that pops into a frozen pose as you approach, so
        // instead everything cheap (the hull transform, the rope) runs always and the expensive
        // part — the deck party's per-figure IK — is what gets skipped far away. `updateParty`
        // itself is the cost; `Human.update` is already distance-culled inside `makeHuman`'s
        // registry for the player's boat, but these humans aren't in one.
        const d2 = (m.ax - camera.x) ** 2 + (m.az - camera.z) ** 2;
        const draw = d2 < DRAW_RANGE * DRAW_RANGE;
        m.model.group.visible = draw;
        m.rope.visible = draw;
        setLights(m.model, draw && d2 < LIGHT_RANGE * LIGHT_RANGE);
        if (!draw) continue;

        // Swinging on the hook: a slow yaw wander around the settled heading, plus a touch of
        // surge back and forth as the line comes up tight and goes slack again.
        const swing = Math.sin(t * 0.07 + m.swingPh) * 0.22 + Math.sin(t * 0.031 + m.swingPh * 1.7) * 0.11;
        const surge = Math.sin(t * 0.09 + m.swingPh) * 0.9;
        const yaw = m.baseYaw + swing;
        const x = m.ax + Math.sin(yaw) * surge;
        const z = m.az + Math.cos(yaw) * surge;

        const amp = ampAt(x, z);
        const surf = waveHBase(x, z, t, amp);
        const [sx, sz] = waveSlope(x, z, t, amp);
        const g = m.model.group;
        g.position.set(x, surf, z);
        g.rotation.set(0, 0, 0);
        g.rotateY(yaw);
        g.rotateX(-sz * 0.6);
        g.rotateZ(sx * 0.5);

        // Bow line to the piling. Taken from the boat's own bow in its *current* attitude, so it
        // visibly tightens and slackens as the hull swings and rolls.
        m.ropeFrom.set(0, 0.7, -m.len * 0.47);
        g.localToWorld(m.ropeFrom);
        spanRope(m.rope, m.ropeFrom, new THREE.Vector3(m.tieX, 1.4, m.tieZ));

        if (d2 > PARTY_RANGE * PARTY_RANGE) continue;
        updateParty(dt, t, m.model, { x, z, speed: 0, air: false }, {
          particles, cameraPos: camera, bpm: () => m.site.bpm, todK, luigiOn: () => false,
        });
        m.model.captain.update(t, 0);
        m.model.crew.update(t, 0);
        for (const P of m.model.party) P.h.update(t, 0);
      }
    },

    sites(): readonly PartySite[] { return sites; },

    debugPlacement() {
      return moored.map((m) => ({
        id: m.id, x: +m.ax.toFixed(1), z: +m.az.toFixed(1),
        depth: +depthAt(m.ax, m.az).toFixed(2),
        shoreD: +shoreInfo(m.ax, m.az).d.toFixed(1),
        land: +landH(m.ax, m.az).toFixed(3),
      }));
    },

    dispose(): void {
      scene.remove(group);
      ropeMat.dispose();
      pileMat.dispose();
    },
  };
}

/** The anchorage table, for tests — see this module's header, point 2. */
export const PARTY_ANCHORAGES = ANCHORAGES;
