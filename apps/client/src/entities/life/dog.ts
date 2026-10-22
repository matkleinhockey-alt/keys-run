/**
 * The boat dog: a small terrier that rides on deck, trots about when you are idling, braces when
 * you get on the throttle, and loses its mind when a fish comes over the gunwale.
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
 */
import * as THREE from 'three';
import { rand } from '../../core/math.js';

/** Shoulder height, metres — a Jack Russell, not a labrador. Everything else scales off it. */
const H = 0.34;
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

function mat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.74, flatShading: true });
}

interface Parts {
  g: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  tail: THREE.Group;
  ears: THREE.Group[];
  legs: THREE.Mesh[];
}

/** A blocky low-poly terrier — white with a tan saddle and tan ears, which reads at deck distance
 * where a more detailed dog would just be a smudge. */
function buildDog(): { parts: Parts; mats: THREE.Material[] } {
  const coat = mat(0xf2ece0), tan = mat(0xb5803f), nose = mat(0x26221f), eye = mat(0x1a1714);
  const mats = [coat, tan, nose, eye];
  const g = new THREE.Group();

  const body = new THREE.Group();
  g.add(body);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(H * 0.52, H * 0.48, H * 0.95), coat);
  torso.position.y = H * 0.72;
  torso.castShadow = true;
  body.add(torso);
  // Tan saddle over the shoulders.
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(H * 0.54, H * 0.26, H * 0.42), tan);
  saddle.position.set(0, H * 0.84, -H * 0.12);
  body.add(saddle);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(H * 0.46, H * 0.36, H * 0.3), coat);
  chest.position.set(0, H * 0.66, H * 0.5);
  body.add(chest);

  const head = new THREE.Group();
  head.position.set(0, H * 0.95, H * 0.56);
  body.add(head);
  const skull = new THREE.Mesh(new THREE.BoxGeometry(H * 0.38, H * 0.34, H * 0.36), coat);
  skull.castShadow = true;
  head.add(skull);
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(H * 0.2, H * 0.17, H * 0.22), coat);
  muzzle.position.set(0, -H * 0.06, H * 0.26);
  head.add(muzzle);
  const snout = new THREE.Mesh(new THREE.BoxGeometry(H * 0.1, H * 0.09, H * 0.06), nose);
  snout.position.set(0, -H * 0.04, H * 0.39);
  head.add(snout);
  const ears: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(sx * H * 0.15, H * 0.16, -H * 0.02);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(H * 0.1, H * 0.16, H * 0.05), tan);
    flap.position.y = H * 0.06;
    ear.add(flap);
    head.add(ear);
    ears.push(ear);
  }
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.BoxGeometry(H * 0.06, H * 0.06, H * 0.03), eye);
    e.position.set(sx * H * 0.1, H * 0.03, H * 0.17);
    head.add(e);
  }

  const tail = new THREE.Group();
  tail.position.set(0, H * 0.86, -H * 0.46);
  body.add(tail);
  const tailMesh = new THREE.Mesh(new THREE.BoxGeometry(H * 0.09, H * 0.3, H * 0.09), coat);
  tailMesh.position.y = H * 0.14;
  tail.add(tailMesh);

  const legs: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(H * 0.12, H * 0.5, H * 0.13), coat);
      leg.position.set(sx * H * 0.17, H * 0.25, sz * H * 0.3);
      leg.castShadow = true;
      g.add(leg);
      legs.push(leg);
    }
  }

  return { parts: { g, body, head, tail, ears, legs }, mats };
}

export interface DogDeps {
  /** A single short bark — `audio/engine.ts` has no dog voice, so the caller supplies one (or
   * omits it and the dog is silent). Kept as a callback so this module owns no audio. */
  bark?(): void;
}

export function createDog(deps: DogDeps = {}): Dog {
  const { parts, mats } = buildDog();
  const { g, body, head, tail, ears, legs } = parts;

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
      // Sitting drops the hindquarters and tips the body back; bracing crouches and splays.
      const crouch = act === 'brace' ? H * 0.22 : sitting ? H * 0.16 : 0;
      body.position.y = -crouch;
      body.rotation.x = sitting ? -0.3 : act === 'brace' ? 0.16 : 0;

      for (let i = 0; i < legs.length; i++) {
        const sz = i % 2 === 0 ? -1 : 1; // front/back within each side
        const swing = trotting ? Math.sin(step + (i < 2 ? 0 : Math.PI) + (sz > 0 ? Math.PI : 0)) * 0.22 : 0;
        legs[i].position.z = (sz * H * 0.3) + swing * H;
        legs[i].position.y = H * 0.25 - crouch + (trotting ? Math.max(0, Math.cos(step + i)) * H * 0.04 : 0);
        // Sitting folds the back legs under; bracing splays all four outward.
        legs[i].rotation.x = sitting && sz < 0 ? 0.9 : 0;
        legs[i].rotation.z = act === 'brace' ? (i < 2 ? -0.18 : 0.18) : 0;
      }

      // Tail: wags with excitement and with trotting, tucks when braced.
      wag += ((excited ? 1 : trotting ? 0.65 : sitting ? 0.3 : 0.15) - wag) * Math.min(1, dt * 3);
      if (act === 'brace') {
        tail.rotation.set(0.9, 0, 0);
      } else {
        tail.rotation.set(-0.5, Math.sin(t * (8 + 14 * wag)) * 0.7 * wag, 0);
      }

      // Head: into the wind when running, tracking the action otherwise, plus a lean against
      // acceleration so getting on the throttle visibly shoves the dog back.
      const lean = Math.max(-0.25, Math.min(0.25, -accel * 0.012));
      head.rotation.x = act === 'brace' ? -0.25 + lean : Math.sin(t * 0.8) * 0.08 + lean;
      head.rotation.y = act === 'brace' ? 0 : Math.sin(t * 0.47) * 0.5;
      for (let i = 0; i < ears.length; i++) {
        // Ears stream back at speed and prick up when something is happening.
        const back = act === 'brace' ? 1 : excited ? -0.5 : 0;
        ears[i].rotation.x = 0.1 + back * 0.9 + Math.sin(t * 2.3 + i) * 0.05;
      }

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
