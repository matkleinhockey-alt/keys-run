/**
 * Dogs: the boat's terrier, and every dog on the street of Boot Key Harbor City.
 *
 * The boat dog is a small terrier that rides on deck, trots about when you are idling, braces
 * when you get on the throttle, and loses its mind when a fish comes over the gunwale.
 *
 * Net-new (legacy had no dog). Built here rather than in `entities/boat/model.ts` so that
 * switching boats does not rebuild it — the dog is the player's, not the hull's. It re-parents
 * itself to whatever `BoatModel` it is handed each frame, which is also what makes it survive a
 * boat swap: `game/world.ts`'s `placeBoat` throws the old model away entirely.
 *
 * Everything is in the boat's LOCAL frame. Parenting to `model.group` means the hull's own
 * position, heading, pitch and roll come for free, so nothing here has to know about waves — the
 * dog leans against acceleration and the deck does the rest. `model.soleAt(z)` is the walkable
 * sole height at a given station, the same function the deck party stands on.
 *
 * ## One dog, many dogs
 * The street dogs (entities/town/wildlife.ts) are the SAME dog: `buildDog` takes a `DogLook`
 * (coat, markings, size, how long the body and legs are) and `poseDog` is the one trot/sit/lie/
 * sniff solver, used by the boat dog's update too. A second dog model next to this one would
 * have drifted the first time someone touched either; instead the terrier is just the default
 * look and a Lab is `scale 1.75`.
 *
 * Two build modes, because the two uses have opposite costs:
 *   - boat: one Mesh and one material per box, with animated ears. One dog, a few dozen draws
 *     is nothing, and the original construction is kept exactly.
 *   - merged (street): the body, the head (ears and eyes included) and the tail are each ONE
 *     vertex-coloured mesh, shared geometry per breed and ONE shared material, so a street dog
 *     is 7 draw calls (body, head, tail, four legs) instead of ~15, and it costs nothing in
 *     materials or shader programs. Measured: see the report in entities/town/wildlife.ts.
 */
import * as THREE from 'three';
import { rand } from '../../core/math.js';

/** Shoulder height, metres — a Jack Russell, not a labrador. Everything else scales off it. */
export const H = 0.34;
/** Deck speed (m/s) above which the dog stops trotting and braces. A planing hull is no place to
 * walk about, and a dog trotting through a 40 kn run looks like a bug. */
const BRACE_SPEED = 5;

export interface Dog {
  /** Call once a frame, after the boat model's transform is final. */
  update(dt: number, t: number, model: DogBoat, boatLen: number, boat: { speed: number; air: boolean }, excited: boolean): void;
  /** VERIFICATION-ONLY: where the dog is standing in the boat's local frame, and what it's doing. */
  debugState(): { z: number; act: string; attached: boolean };
  dispose(): void;
}

/** The slice of `BoatModel` the dog needs — structural, to avoid importing boat/model.ts (which
 * imports from life/, so a direct import would be circular). */
export interface DogBoat {
  group: THREE.Group;
  soleAt(z: number): number;
}

/** What makes one dog not another. Lengths are multipliers on the terrier's proportions. */
export interface DogLook {
  coat: number; mark: number; ear: number; nose: number;
  /** Uniform scale of the whole dog (a Lab is ~1.75 terriers). */
  scale: number;
  /** Body length multiplier (a dachshund is long). */
  body: number;
  /** Leg length multiplier (and a dachshund's is short). */
  leg: number;
  /** Ears stand up (husky) rather than hang. */
  prick: boolean;
  /** A darker patch over the shoulders; false = one flat coat. */
  saddle: boolean;
  /** How far the tail curls up over the back, radians (husky). */
  tailUp: number;
}

export type DogBreed = 'terrier' | 'lab' | 'beagle' | 'dachshund' | 'husky' | 'blacklab' | 'mutt';

export const DOG_LOOKS: Readonly<Record<DogBreed, DogLook>> = {
  terrier:   { coat: 0xf2ece0, mark: 0xb5803f, ear: 0xb5803f, nose: 0x26221f, scale: 1,    body: 1,    leg: 1,    prick: false, saddle: true,  tailUp: 0 },
  lab:       { coat: 0xd8b068, mark: 0xd8b068, ear: 0xc4994f, nose: 0x1d1a17, scale: 1.75, body: 1.05, leg: 1.05, prick: false, saddle: false, tailUp: 0 },
  beagle:    { coat: 0xf4efe4, mark: 0x8a5a2e, ear: 0x5f3d20, nose: 0x1d1a17, scale: 1.25, body: 1,    leg: 0.88, prick: false, saddle: true,  tailUp: 0.35 },
  dachshund: { coat: 0x7a4a2a, mark: 0x7a4a2a, ear: 0x55301a, nose: 0x1d1a17, scale: 1.15, body: 1.6,  leg: 0.5,  prick: false, saddle: false, tailUp: 0 },
  husky:     { coat: 0xe6e8ea, mark: 0x5f656b, ear: 0x5f656b, nose: 0x1d1a17, scale: 1.8,  body: 1.05, leg: 1.1,  prick: true,  saddle: true,  tailUp: 1.1 },
  blacklab:  { coat: 0x2f2b29, mark: 0x2f2b29, ear: 0x2f2b29, nose: 0x0d0c0b, scale: 1.8,  body: 1.08, leg: 1.08, prick: false, saddle: false, tailUp: 0 },
  mutt:      { coat: 0xb0875a, mark: 0x6e5238, ear: 0x6e5238, nose: 0x26221f, scale: 1.4,  body: 1.1,  leg: 1,    prick: false, saddle: true,  tailUp: 0.2 },
};

function mat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.74, flatShading: true });
}

export interface Parts {
  g: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  tail: THREE.Group;
  ears: THREE.Group[];
  legs: THREE.Mesh[];
  look: DogLook;
}

/** One box of the dog, before it is either a Mesh (boat) or a slab of a merged geometry (street). */
interface Box { part: 'body' | 'head' | 'tail'; w: number; h: number; d: number; x: number; y: number; z: number; color: number; cast?: boolean }

/** The dog's boxes, in the terrier's own proportions stretched by the look. This is the one definition. */
function dogBoxes(L: DogLook): { boxes: Box[]; headAt: [number, number, number]; tailAt: [number, number, number]; legs: { w: number; h: number; d: number; x: number; y: number; z: number }[]; earAt: [number, number, number]; earFlap: { w: number; h: number; d: number; y: number }; } {
  const B = L.body, dy = -H * 0.5 * (1 - L.leg);
  const boxes: Box[] = [];
  const b = (part: Box['part'], w: number, h: number, d: number, x: number, y: number, z: number, color: number, cast = false): void => { boxes.push({ part, w, h, d, x, y, z, color, cast }); };
  b('body', H * 0.52, H * 0.48, H * 0.95 * B, 0, H * 0.72 + dy, 0, L.coat, true);                       // torso
  if (L.saddle) b('body', H * 0.54, H * 0.26, H * 0.42 * B, 0, H * 0.84 + dy, -H * 0.12 * B, L.mark);   // saddle over the shoulders
  b('body', H * 0.46, H * 0.36, H * 0.3, 0, H * 0.66 + dy, H * 0.5 * B, L.coat);                       // chest
  b('head', H * 0.38, H * 0.34, H * 0.36, 0, 0, 0, L.coat, true);                                       // skull
  b('head', H * 0.2, H * 0.17, H * 0.22, 0, -H * 0.06, H * 0.26, L.coat);                               // muzzle
  b('head', H * 0.1, H * 0.09, H * 0.06, 0, -H * 0.04, H * 0.39, L.nose);                               // nose
  for (const sx of [-1, 1]) b('head', H * 0.06, H * 0.06, H * 0.03, sx * H * 0.1, H * 0.03, H * 0.17, 0x1a1714); // eyes
  b('tail', H * 0.09, H * 0.3, H * 0.09, 0, H * 0.14, 0, L.coat);
  const legs = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) legs.push({ w: H * 0.12, h: H * 0.5 * L.leg, d: H * 0.13, x: sx * H * 0.17, y: H * 0.25 * L.leg, z: sz * H * 0.3 * B });
  return {
    boxes,
    headAt: [0, H * 0.95 + dy, H * 0.56 * B],
    tailAt: [0, H * 0.86 + dy, -H * 0.46 * B],
    legs,
    earAt: [H * 0.15, H * 0.16, -H * 0.02],
    earFlap: L.prick ? { w: H * 0.08, h: H * 0.22, d: H * 0.05, y: H * 0.1 } : { w: H * 0.1, h: H * 0.16, d: H * 0.05, y: H * 0.06 },
  };
}

/** The street dogs are lit like the rest of the street (a low sun behind the buildings): without this a white terrier read as blue-grey. The boat dog is in full sun and is not lifted. */
const STREET_LIFT = 1.35;

/** Merge boxes into one vertex-coloured geometry (a handful of boxes: no need for BufferGeometryUtils). */
function mergeBoxes(list: readonly Box[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const c = new THREE.Color();
  for (const bx of list) {
    const g = new THREE.BoxGeometry(bx.w, bx.h, bx.d);
    g.translate(bx.x, bx.y, bx.z);
    const base = pos.length / 3, p = g.attributes.position, n = g.attributes.normal;
    c.setHex(bx.color).multiplyScalar(STREET_LIFT);
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(c.r, c.g, c.b); }
    for (let i = 0; i < g.index!.count; i++) idx.push(base + g.index!.getX(i));
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  return out;
}

const STREET_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.74, flatShading: true });
const STREET_GEO = new Map<DogLook, { body: THREE.BufferGeometry; head: THREE.BufferGeometry; tail: THREE.BufferGeometry; leg: THREE.BufferGeometry }>();

/**
 * A blocky low-poly dog. Default look: a terrier — white with a tan saddle and tan ears, which
 * reads at deck distance where a more detailed dog would just be a smudge.
 *
 * `merge: true` is the street build (see the header): shared geometry per look, one shared
 * material, and static ears (the street pose never twitches them).
 */
export function buildDog(look: DogLook = DOG_LOOKS.terrier, merge = false): { parts: Parts; mats: THREE.Material[] } {
  const D = dogBoxes(look);
  const mats: THREE.Material[] = [];
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const head = new THREE.Group();
  head.position.set(...D.headAt);
  body.add(head);
  const tail = new THREE.Group();
  tail.position.set(...D.tailAt);
  body.add(tail);
  const ears: THREE.Group[] = [];
  const legs: THREE.Mesh[] = [];

  if (merge) {
    let geo = STREET_GEO.get(look);
    if (!geo) {
      const earBoxes: Box[] = [-1, 1].map((sx) => ({ part: 'head' as const, w: D.earFlap.w, h: D.earFlap.h, d: D.earFlap.d, x: sx * D.earAt[0], y: D.earAt[1] + D.earFlap.y, z: D.earAt[2], color: look.ear }));
      const leg = D.legs[0];
      geo = {
        body: mergeBoxes(D.boxes.filter((x) => x.part === 'body')),
        head: mergeBoxes([...D.boxes.filter((x) => x.part === 'head'), ...earBoxes]),
        tail: mergeBoxes(D.boxes.filter((x) => x.part === 'tail')),
        leg: mergeBoxes([{ part: 'body', w: leg.w, h: leg.h, d: leg.d, x: 0, y: 0, z: 0, color: look.coat }]),
      };
      STREET_GEO.set(look, geo);
    }
    const mk = (geom: THREE.BufferGeometry, parent: THREE.Object3D, cast = false): THREE.Mesh => { const m = new THREE.Mesh(geom, STREET_MAT); m.castShadow = cast; parent.add(m); return m; };
    mk(geo.body, body, true); mk(geo.head, head, true); mk(geo.tail, tail);
    for (const l of D.legs) { const m = mk(geo.leg, g, true); m.position.set(l.x, l.y, l.z); legs.push(m); }
  } else {
    const ms = new Map<number, THREE.MeshStandardMaterial>();
    const M = (c: number): THREE.MeshStandardMaterial => { let m = ms.get(c); if (!m) { m = mat(c); ms.set(c, m); mats.push(m); } return m; };
    const parent = { body, head, tail } as const;
    for (const bx of D.boxes) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bx.w, bx.h, bx.d), M(bx.color));
      m.position.set(bx.x, bx.y, bx.z);
      if (bx.cast) m.castShadow = true;
      // the tail box hangs from its pivot, as it always did: its centre sits `y` up the pivot
      parent[bx.part].add(m);
    }
    for (const sx of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(sx * D.earAt[0], D.earAt[1], D.earAt[2]);
      const flap = new THREE.Mesh(new THREE.BoxGeometry(D.earFlap.w, D.earFlap.h, D.earFlap.d), M(look.ear));
      flap.position.y = D.earFlap.y;
      ear.add(flap);
      head.add(ear);
      ears.push(ear);
    }
    for (const l of D.legs) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(l.w, l.h, l.d), M(look.coat));
      leg.position.set(l.x, l.y, l.z);
      leg.castShadow = true;
      g.add(leg);
      legs.push(leg);
    }
  }
  g.scale.setScalar(look.scale);
  return { parts: { g, body, head, tail, ears, legs, look }, mats };
}

/** What the dog is doing, as the pose solver needs it. */
export interface DogPoseIn {
  act: 'trot' | 'sit' | 'brace' | 'lie' | 'sniff';
  /** Actually moving its feet (a `trot` act that has arrived is not trotting). */
  trotting: boolean;
  /** Trot cycle phase. */
  step: number;
  /** Tail wag amount, 0..1. */
  wag: number;
  excited: boolean;
  /** Lean against acceleration, radians. */
  lean: number;
  t: number;
  /** A per-dog phase so a street of dogs does not twitch in unison. */
  ph?: number;
}

/**
 * The one trot / sit / brace solver (moved here out of `createDog.update` unchanged, plus `lie` and
 * `sniff` for the street). Writes rotations and offsets onto `parts`; owns no state.
 */
export function poseDog(parts: Parts, p: DogPoseIn): void {
  const { body, head, tail, ears, legs, look } = parts;
  const { act, trotting, step, wag, excited, lean, t } = p;
  const ph = p.ph ?? 0;
  const sitting = act === 'sit' && !trotting;
  const lying = act === 'lie';
  const sniffing = act === 'sniff' && !trotting;
  const legK = look.leg;
  // Sitting drops the hindquarters and tips the body back; bracing crouches and splays; lying flops it down.
  const crouch = act === 'brace' ? H * 0.22 : sitting ? H * 0.16 * legK : lying ? H * 0.36 * legK : 0;
  body.position.y = -crouch;
  body.rotation.x = sitting ? -0.3 : act === 'brace' ? 0.16 : sniffing ? 0.1 : 0;

  for (let i = 0; i < legs.length; i++) {
    const sz = i % 2 === 0 ? -1 : 1; // front/back within each side
    const swing = trotting ? Math.sin(step + (i < 2 ? 0 : Math.PI) + (sz > 0 ? Math.PI : 0)) * 0.22 : 0;
    legs[i].position.z = (sz * H * 0.3 * look.body) + swing * H + (lying && sz > 0 ? H * 0.22 : 0);
    legs[i].position.y = H * 0.25 * legK - crouch + (trotting ? Math.max(0, Math.cos(step + i)) * H * 0.04 : 0);
    // Sitting folds the back legs under; bracing splays all four outward; lying tucks them out to the sides.
    legs[i].rotation.x = sitting && sz < 0 ? 0.9 : 0;
    legs[i].rotation.z = act === 'brace' ? (i < 2 ? -0.18 : 0.18) : lying ? (i < 2 ? -0.7 : 0.7) : 0;
  }

  // Tail: wags with excitement and with trotting, tucks when braced, curls over the back if the breed does.
  if (act === 'brace') {
    tail.rotation.set(0.9, 0, 0);
  } else {
    tail.rotation.set(-0.5 - look.tailUp, Math.sin(t * (8 + 14 * wag) + ph) * 0.7 * wag, 0);
  }

  // Head: into the wind when running, tracking the action otherwise, plus a lean against
  // acceleration so getting on the throttle visibly shoves the dog back. Sniffing puts the nose on the ground.
  if (act === 'brace') {
    head.rotation.x = -0.25 + lean;
    head.rotation.y = 0;
  } else if (sniffing) {
    head.rotation.x = 0.85 + Math.sin(t * 5 + ph) * 0.07;
    head.rotation.y = Math.sin(t * 1.3 + ph) * 0.45;
  } else if (lying) {
    head.rotation.x = 0.28 + Math.sin(t * 0.5 + ph) * 0.05;
    head.rotation.y = Math.sin(t * 0.31 + ph) * 0.4;
  } else {
    head.rotation.x = Math.sin(t * 0.8 + ph) * 0.08 + lean;
    head.rotation.y = Math.sin(t * 0.47 + ph) * 0.5;
  }
  for (let i = 0; i < ears.length; i++) {
    // Ears stream back at speed and prick up when something is happening.
    const back = act === 'brace' ? 1 : excited ? -0.5 : 0;
    ears[i].rotation.x = 0.1 + back * 0.9 + Math.sin(t * 2.3 + i) * 0.05;
  }
}

export interface DogDeps {
  /** A single short bark — `audio/engine.ts` has no dog voice, so the caller supplies one (or
   * omits it and the dog is silent). Kept as a callback so this module owns no audio. */
  bark?(): void;
}

export function createDog(deps: DogDeps = {}): Dog {
  const { parts, mats } = buildDog();
  const { g } = parts;

  /** Where along the boat the dog currently is, and where it wants to be. Local z, metres. */
  let z = 0, wantZ = 0;
  let act: 'trot' | 'sit' | 'brace' = 'sit';
  let actT = rand(2, 5);
  let step = 0;          // trot cycle phase
  let wag = 0;           // tail wag amount, 0..1
  let barkT = rand(6, 18);
  let attached: THREE.Group | null = null;
  /** Smoothed boat speed, for leaning into acceleration without jitter. */
  let lastSpeed = 0;

  return {
    update(dt, t, model, boatLen, boat, excited): void {
      // The cockpit, aft of the console. +z is the bow (entities/boat/model.ts places the anchor
      // locker at +L/2 and the console at z~0), so the walkable sole is negative z — the first
      // version roamed -1.4..2.2 and parked the dog standing inside the console.
      const aft = -boatLen * 0.30, fwd = -boatLen * 0.09;
      // Re-parent on a boat swap — `placeBoat` discards the old model, and a dog left on it would
      // vanish with the hull it was standing on.
      if (attached !== model.group) {
        model.group.add(g);
        attached = model.group;
        z = wantZ = (aft + fwd) / 2;
      }

      const sp = Math.abs(boat.speed);
      const accel = (sp - lastSpeed) / Math.max(dt, 1e-3);
      lastSpeed = sp;

      // --- pick what to do -------------------------------------------------
      if (sp > BRACE_SPEED || boat.air) {
        act = 'brace';
      } else {
        actT -= dt;
        if (act === 'brace') { act = 'sit'; actT = rand(1.5, 3); }
        if (actT <= 0) {
          act = act === 'trot' ? 'sit' : 'trot';
          actT = act === 'trot' ? rand(2.5, 6) : rand(3, 9);
          // Somewhere else on the sole: forward of the console, aft by the transom, either way
          // along the centreline so it never clips the gunwale.
          if (act === 'trot') wantZ = rand(aft, fwd);
        }
      }
      // A fish coming aboard beats whatever it was doing — it goes to the transom where the fish
      // is, which is the aft end of its range.
      if (excited) { act = 'trot'; wantZ = aft; actT = Math.max(actT, 1.5); }

      // --- move ------------------------------------------------------------
      const trotting = act === 'trot' && Math.abs(wantZ - z) > 0.05;
      if (trotting) {
        const dir = Math.sign(wantZ - z);
        const v = excited ? 1.9 : 1.1;
        z += dir * v * dt;
        if ((dir > 0 && z > wantZ) || (dir < 0 && z < wantZ)) z = wantZ;
        step += dt * (excited ? 15 : 9);
        g.rotation.y = dir > 0 ? 0 : Math.PI;
      } else if (act === 'trot') {
        act = 'sit'; actT = rand(3, 9);
      }

      const sole = model.soleAt(z);
      g.position.set(0, sole, z);

      // --- pose --------------------------------------------------------------
      const sitting = act === 'sit' && !trotting;
      wag += ((excited ? 1 : trotting ? 0.65 : sitting ? 0.3 : 0.15) - wag) * Math.min(1, dt * 3);
      const lean = Math.max(-0.25, Math.min(0.25, -accel * 0.012));
      poseDog(parts, { act, trotting, step, wag, excited, lean, t });

      // --- bark --------------------------------------------------------------
      barkT -= dt * (excited ? 4 : 1);
      if (barkT <= 0) {
        barkT = excited ? rand(1.2, 2.6) : rand(14, 40);
        if (sp < BRACE_SPEED) deps.bark?.();
      }
    },

    debugState(): { z: number; act: string; attached: boolean } {
      return { z: +z.toFixed(2), act, attached: attached !== null };
    },

    dispose(): void {
      g.removeFromParent();
      g.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
      for (const m of mats) m.dispose();
    },
  };
}
