/**
 * Caelen the seagull: circles your boat, swoops the deck, and has opinions — a name tag with a
 * speech bubble, on a timer.
 *
 * Ported faithfully from legacy/index.html:3713-3741 (`CAELEN`, `caelenSquawk`→
 * `audio/engine.ts`'s `caelenSquawk()`, `caelenSays`→`audio/index.ts`'s `sayCaelenLine()`,
 * `updateCaelen`).
 */
import * as THREE from 'three';
import { makeSeabird, poseBird, moveBird, type Bird } from './seabirds.js';
import { rand } from '../../core/math.js';
import { toast } from '../../ui/toast.js';

export interface CaelenDeps {
  /** `audio/index.ts`'s `AudioSystem.sayCaelenLine()` — squawk synth + the speech line, both
   * already fully implemented; see this module's header. */
  sayCaelenLine(): void;
}

export interface Caelen {
  update(dt: number, t: number, boat: { x: number; y: number; z: number; speed: number }, camera: THREE.PerspectiveCamera, viewport: { w: number; h: number }): void;
  dispose(): void;
}

/** legacy `CAELEN`/`updateCaelen` (index.html:3714, 3725-3741). */
export function createCaelen(scene: THREE.Scene, deps: CaelenDeps): Caelen {
  const B: Bird = makeSeabird('gull', 1.45);
  scene.add(B.g);
  const tag = document.createElement('div');
  tag.className = 'tag';
  document.getElementById('tags')?.appendChild(tag);

  let a = Math.random() * 6.28, r = 12, h = 8, talkT = rand(20, 35), swoop = 0, bubble = 0;
  const projV = new THREE.Vector3();

  return {
    update(dt, t, boat, camera, viewport) {
      const sp = Math.abs(boat.speed);
      // keep pace with the boat: circle wider and higher when running, swoop low over the cockpit now and then
      a += dt * (0.35 + Math.min(0.5, sp * 0.012));
      r += (((sp > 8 ? 20 : 12) - r)) * Math.min(1, dt * 0.5);
      h += (((sp > 8 ? 10 : 7) - h)) * Math.min(1, dt * 0.5);
      if (swoop <= 0 && Math.random() < dt * 0.03 && sp < 6) swoop = 3.5;
      let rr = r, hh = h;
      if (swoop > 0) {
        swoop -= dt;
        const q = Math.sin(Math.PI * (1 - swoop / 3.5));
        rr = rr + (3 - rr) * q; hh = hh + (boat.y + 3.2 - hh) * q;
      }
      const x = boat.x + Math.cos(a) * rr, z = boat.z + Math.sin(a) * rr, y = boat.y + hh + Math.sin(t * 1.7) * 0.6;
      poseBird(B, dt, (Math.sin(t * 0.9) > -0.2 || sp > 10) ? 1 : 0, 0, 9);
      moveBird(B, x, y, z, dt);
      talkT -= dt;
      if (talkT <= 0) { talkT = rand(45, 90); toast('\u{1F426} Caelen: you didn’t make this… you didn’t make this'); deps.sayCaelenLine(); bubble = 4; }
      if (bubble > 0) bubble -= dt;
      // name tag (and a speech bubble while he's talking)
      projV.set(x, y + 1.2, z).project(camera);
      const dc = Math.hypot(x - camera.position.x, z - camera.position.z), vis = projV.z < 1 && dc < 160;
      tag.style.display = vis ? 'block' : 'none';
      if (vis) {
        tag.style.left = ((projV.x + 1) / 2 * viewport.w) + 'px';
        tag.style.top = ((1 - projV.y) / 2 * viewport.h) + 'px';
        tag.textContent = bubble > 0 ? '\u{1F426} Caelen: “you didn’t make this…”' : '\u{1F426} Caelen';
      }
    },
    dispose(): void {
      tag.remove();
      scene.remove(B.g);
    },
  };
}
