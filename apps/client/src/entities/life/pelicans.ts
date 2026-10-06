/**
 * Brown pelicans: 4 flocks of 3-7, gliding low in a loose line (sometimes a shallow vee),
 * flapping in a ripple down the line, now and then one peels off and plunge-dives for bait.
 *
 * Ported faithfully from legacy/index.html:1883-1917 (`spawnPelicanFlock`, `initPelicans`,
 * `updatePelicans`).
 */
import * as THREE from 'three';
import { makeSeabird, poseBird, moveBird, type Bird } from './seabirds.js';
import { landH } from '@keysrun/shared/world/depth';
import { waveHBase } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { lerp, rand } from '../../core/math.js';
import type { ParticleSystem } from '../../world/particles.js';

interface PelicanFlock {
  birds: Bird[];
  x: number; z: number; h: number; sp: number; alt: number; vee: boolean; flapT: number; turn: number;
}

/** legacy `spawnPelicanFlock` (index.html:1885-1889). */
function spawnFlock(F: PelicanFlock, boat: { x: number; z: number }, near: boolean): void {
  const a = Math.random() * Math.PI * 2, d = near ? rand(150, 350) : rand(450, 750);
  let x = boat.x + Math.cos(a) * d, z = boat.z + Math.sin(a) * d;
  for (let k = 0; k < 12 && landH(x, z) > -0.5; k++) {
    const b = Math.random() * 6.28;
    x = boat.x + Math.cos(b) * d; z = boat.z + Math.sin(b) * d;
  }
  F.x = x; F.z = z;
  F.h = Math.atan2(boat.x - x, boat.z - z) + rand(-1.1, 1.1);
  F.sp = rand(9, 12); F.alt = rand(2.5, 5); F.vee = Math.random() < 0.4; F.flapT = rand(0, 4); F.turn = rand(-0.05, 0.05);
  F.birds.forEach((B) => { B.dive = null; B.px = null; });
}

export interface PelicanFlocks {
  update(dt: number, t: number, boat: { x: number; z: number }, camera: { x: number; z: number }, particles: ParticleSystem): void;
}

/** legacy `PELICANS`/`initPelicans` (index.html:1884, 1890): 4 flocks, 2 spawned near the boat
 * so there's always something overhead at boot. */
export function createPelicanFlocks(scene: THREE.Scene, boat: { x: number; z: number }): PelicanFlocks {
  const flocks: PelicanFlock[] = [];
  for (let f = 0; f < 4; f++) {
    const n = 3 + Math.floor(Math.random() * 5);
    const birds: Bird[] = [];
    for (let i = 0; i < n; i++) { const B = makeSeabird('pelican', 1.15); scene.add(B.g); birds.push(B); }
    const F: PelicanFlock = { birds, x: 0, z: 0, h: 0, sp: 10, alt: 3.5, vee: false, flapT: 0, turn: 0 };
    spawnFlock(F, boat, f < 2);
    flocks.push(F);
  }

  return {
    update(dt, t, boat2, camera, particles) {
      for (const F of flocks) {
        if (Math.hypot(F.x - boat2.x, F.z - boat2.z) > 1100) spawnFlock(F, boat2, false);
        const fx = Math.sin(F.h), fz = Math.cos(F.h);
        if (landH(F.x + fx * 60, F.z + fz * 60) > -0.3) F.h += dt * 0.9; else F.h += F.turn * dt;
        F.x += fx * F.sp * dt; F.z += fz * F.sp * dt;
        F.flapT -= dt;
        const flapping = F.flapT < 0;
        if (F.flapT < -2.2) F.flapT = rand(2.5, 5);
        const vis = Math.hypot(F.x - camera.x, F.z - camera.z) < 1300;
        F.birds.forEach((B, i) => {
          B.g.visible = vis;
          if (!vis) return;
          const back = i * 5.5, side = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 2.2 * (F.vee ? 1 : 0.25);
          let x = F.x - fx * back + Math.cos(F.h) * side, z = F.z - fz * back - Math.sin(F.h) * side;
          let y = F.alt + waveHBase(x, z, t, ampAt(x, z)) + Math.sin(t * 0.6 + i) * 0.3;
          let flap = flapping && t % 3 > i * 0.18 ? 1 : 0, tuck = 0;
          if (B.dive) {
            const D = B.dive;
            D.t += dt;
            const p = D.t;
            // Capture the water-landing point from the *pre-dive-effects* slot position, before
            // the p<1.9 -> p<4.2 transition below starts reading it back out as `x=D.wx` — doing
            // this capture after that branch (legacy's order, index.html:1910) means the very
            // first frame of the "sitting" phase reads back the value it is about to write,
            // landing the splash at `undefined`/NaN for one frame every single dive.
            if (p >= 1.9 && D.wx === undefined) { D.wx = x; D.wz = z; }
            if (p < 1.2) { y = lerp(y, y + 7, p / 1.2); flap = 0.6; }
            else if (p < 1.9) { const q = (p - 1.2) / 0.7; y = lerp(y + 7, 0.2, q * q); tuck = Math.min(1, q * 1.6); x += fx * q * 6; z += fz * q * 6; }
            else if (p < 4.2) {
              if (!D.spl) { D.spl = 1; particles.splash(D.wx, D.wz, 16, 1.2); }
              x = D.wx; z = D.wz;
              y = 0.15 + waveHBase(x, z, t, ampAt(x, z)); flap = 0; tuck = 0.3;
            } else if (p < 6) { const q = (p - 4.2) / 1.8; y = lerp(0.2, F.alt, q); flap = 1; }
            else B.dive = null;
          } else if (Math.random() < dt * 0.012) B.dive = { t: 0 };
          poseBird(B, dt, flap, tuck, 5.5);
          moveBird(B, x, y, z, dt);
        });
      }
    },
  };
}
