/**
 * Harbour gulls: a loose gang of gulls and terns that wheel around the player's boat.
 *
 * Why this exists. The birds that were already in the world are wonderful and nowhere near you:
 * pelican flocks cruise 150-700 m out, hotspot gulls orbit bait balls a kilometre away, and
 * Caelen is one (very opinionated) bird. A pistol with a 70 m useful range and a mode whose whole
 * premise is "shoot the birds that fly around" would have had nothing to shoot at in the open
 * water off the dock. Gulls following a boat is also simply true to the Keys - a boat with bait on
 * it is a gull magnet - so this is a gap in the ambience as much as a target list.
 *
 * They are ordinary `Bird`s (seabirds.ts), placed through `moveBird`, so everything the pistol
 * does to birds (scatter on the report, bolt when struck, fly back in later) works on them
 * without a second system.
 *
 * Orbit centre is a smoothed copy of the boat's position, not the boat itself, so a boat that
 * accelerates leaves them trailing and then catching up, the way real gulls do, instead of
 * rigidly bolted to the hull.
 */
import * as THREE from 'three';
import { makeSeabird, poseBird, moveBird, type Bird, type BirdKind } from './seabirds.js';
import { rand } from '../../core/math.js';

interface Member { B: Bird; r: number; h: number; sp: number; ph: number; }

export interface BoatGulls {
  update(dt: number, t: number, boat: { x: number; y: number; z: number; speed: number }): void;
  birds(): Bird[];
  dispose(): void;
}

const KINDS: readonly BirdKind[] = ['gull', 'gull', 'gull', 'gull', 'tern', 'tern'];

export function createBoatGulls(scene: THREE.Scene, boatSpawn: { x: number; z: number }): BoatGulls {
  const group = new THREE.Group();
  scene.add(group);
  const members: Member[] = KINDS.map((kind, i) => {
    const B = makeSeabird(kind, 1.3);
    group.add(B.g);
    // Spread orbit radii and heights so the gang reads as a scatter rather than a ring. Heights stay
    // under ~16 m: a pistol is not an anti-aircraft gun, and a bird you cannot see to aim at is no fun.
    return {
      B, r: 14 + i * 5 + rand(0, 4), h: 5 + (i % 3) * 3.5 + rand(0, 2),
      sp: (0.16 + rand(0, 0.12)) * (i % 2 ? 1 : -1), ph: Math.random() * 6.28,
    };
  });
  let cx = boatSpawn.x, cz = boatSpawn.z;

  return {
    update(dt, t, boat) {
      // The gang trails the boat; it catches up faster the faster the boat is going.
      const k = Math.min(1, dt * (0.35 + Math.min(1, Math.abs(boat.speed) / 14) * 0.5));
      cx += (boat.x - cx) * k; cz += (boat.z - cz) * k;
      for (const m of members) {
        const a = t * m.sp + m.ph;
        const x = cx + Math.cos(a) * m.r, z = cz + Math.sin(a) * m.r;
        const y = m.h + Math.sin(t * 1.1 + m.ph) * 0.9;
        poseBird(m.B, dt, Math.sin(t * 0.7 + m.ph) > -0.1 ? 1 : 0, 0, 9);
        moveBird(m.B, x, y, z, dt);
      }
    },
    birds(): Bird[] { return members.map((m) => m.B); },
    dispose(): void { scene.remove(group); },
  };
}
