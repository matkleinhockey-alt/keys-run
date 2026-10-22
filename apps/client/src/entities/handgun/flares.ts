/**
 * Marine flares (shop item `safety.flare`), fired from the pistol grip with Z. Pure flight and burn
 * live in sim/handgun.ts (`flareAt`); this is only how one looks.
 *
 * LIGHT: none in the scene graph. entities/town keeps a pool of 4 PointLights because three.js
 * compiles the light count into every material's shader program; adding a light only while a flare
 * burns would recompile the whole scene when it lights and again when it goes out. So a flare is an
 * emissive core plus a large additive glow sprite (the same `glowTex` the boat's lamps use), which is
 * what a flare looks like from a deck and costs no shader work. The pool of lights was NOT grown.
 */
import * as THREE from 'three';
import { flareAt, flareLaunch, FLARE_BURN_S, FLARE_IGNITE_S, type FlareLaunch } from '@keysrun/shared/sim/handgun';
import { glowTex } from '../boat/decor-textures.js';
import type { ParticleSystem } from '../../world/particles.js';

interface Live { L: FlareLaunch; t: number; smokeT: number; core: THREE.Mesh; glow: THREE.Sprite }

export interface Flares {
  launch(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }): void;
  update(dt: number, t: number, surfaceY: (x: number, z: number) => number): void;
  /** Flares in the air (rising or burning), for verification and for the startled-gull check. */
  active(): Array<{ x: number; y: number; z: number; phase: string; glow: number }>;
  clear(): void;
  dispose(): void;
}

const MAX = 3;
const WIND = { x: 0.9, z: 0.35 };

export function createFlares(scene: THREE.Scene, particles: ParticleSystem): Flares {
  const coreGeo = new THREE.SphereGeometry(0.12, 8, 6);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xffe0b0 });
  const glowMat = new THREE.SpriteMaterial({ map: glowTex(), color: 0xff5a30, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const live: Live[] = [];
  const state: Array<{ x: number; y: number; z: number; phase: string; glow: number }> = [];

  function drop(f: Live): void {
    scene.remove(f.core, f.glow);
    live.splice(live.indexOf(f), 1);
  }

  return {
    launch(origin, dir) {
      if (live.length >= MAX) drop(live[0]);
      const core = new THREE.Mesh(coreGeo, coreMat);
      const glow = new THREE.Sprite(glowMat.clone());
      glow.visible = core.visible = false;
      scene.add(core, glow);
      live.push({ L: flareLaunch(origin, dir, WIND), t: 0, smokeT: 0, core, glow });
    },
    update(dt, t, surfaceY) {
      state.length = 0;
      for (const f of [...live]) {
        f.t += dt;
        const p = flareAt(f.L, f.t, surfaceY(f.L.ox, f.L.oz));
        if (p.phase === 'out' && f.t > FLARE_IGNITE_S) { drop(f); continue; }
        f.core.visible = true;
        f.core.position.set(p.x, p.y, p.z);
        f.glow.position.set(p.x, p.y, p.z);
        // Flicker: a burning flare is never steady. Size and brightness wobble on two incommensurate
        // frequencies; the rising shell is a small dull spark.
        const flick = 0.85 + 0.15 * Math.sin(t * 37 + f.t * 11) * Math.sin(t * 23);
        const g = p.phase === 'burning' ? p.glow * flick : 0.12;
        f.glow.visible = true;
        f.glow.scale.setScalar(p.phase === 'burning' ? 3 + 11 * g : 0.8);
        (f.glow.material as THREE.SpriteMaterial).opacity = p.phase === 'burning' ? Math.min(1, 0.25 + g) : 0.5;
        f.core.scale.setScalar(p.phase === 'burning' ? 0.6 + 0.6 * g : 0.5);
        // a white smoke trail behind the shell on the way up, and a thin one while it burns
        f.smokeT -= dt;
        if (f.smokeT <= 0 && (p.phase === 'rising' || f.t < FLARE_IGNITE_S + FLARE_BURN_S)) {
          f.smokeT = p.phase === 'rising' ? 0.04 : 0.35;
          particles.spawnP(p.x, p.y, p.z, (Math.random() - 0.5) * 0.4, -0.1, (Math.random() - 0.5) * 0.4, 1.6, 0.5, 0.45, false);
        }
        state.push({ x: p.x, y: p.y, z: p.z, phase: p.phase, glow: +p.glow.toFixed(2) });
      }
    },
    active: () => state.slice(),
    clear() { for (const f of [...live]) drop(f); state.length = 0; },
    dispose() { for (const f of [...live]) drop(f); coreGeo.dispose(); coreMat.dispose(); glowMat.dispose(); },
  };
}
