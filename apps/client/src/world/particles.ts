/**
 * Wake and spray particles. Ported faithfully from legacy/index.html:971-1000.
 *
 * `splash()`'s `AUD.splash(...)` call is dropped — audio is out of Phase 0 scope (see
 * docs/ARCHITECTURE.md and this project's report's stub list).
 *
 * `updateParticles` takes a `waveHeight(x,z,t,amp)` callback rather than calling a module-level
 * `waveH` directly, because the real wave height now depends on the boat's own wake ring
 * (`BoatState.wakeRing`, packages/shared/src/sim/boat.ts) — a pure value the game loop owns, not
 * something this module should reach into. See entities/boat/visuals.ts.
 */
import * as THREE from 'three';
import { rand } from '../core/math.js';
import { waterNoiseTex } from '../core/textures.js';

const PMAX = 2600;

interface Particle {
  on: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number;
  size: number; a0: number;
  grav: boolean; amp: number;
}

export interface ParticleSystem {
  points: THREE.Points;
  spawnP(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, alpha: number, grav: boolean, amp?: number): void;
  splash(x: number, z: number, n: number, power: number): void;
  update(dt: number, t: number, waveHeight: (x: number, z: number, t: number, amp: number) => number): void;
}

export function createParticleSystem(pixelRatio = 1): ParticleSystem {
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(PMAX * 3), pAlpha = new Float32Array(PMAX), pSize = new Float32Array(PMAX);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('alpha', new THREE.BufferAttribute(pAlpha, 1));
  pGeo.setAttribute('psize', new THREE.BufferAttribute(pSize, 1));
  const pMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uPR: { value: pixelRatio }, uNoise: { value: waterNoiseTex() } },
    // r186's colour-managed pipeline blends transparent layers in correct linear light instead of
    // r128's uncorrected gamma-space blending. For many overlapping soft-white sprites (exactly
    // this wake/spray trail) that makes the *same* per-particle alpha curve read as a hard-edged,
    // faceted mass of domes instead of soft diffuse foam — caught on review against the legacy
    // screenshots (see this project's report). Nothing about particle spawning/physics changed;
    // only this shader's falloff curves did, to compensate: no flat fully-opaque core (the old
    // `smoothstep(.5,.12,d)` had one out to 24% of the radius — pure center-to-edge gradient now),
    // and a much wider, gentler noise-breakup threshold instead of a near-binary cutout.
    vertexShader: 'attribute float alpha;attribute float psize;uniform float uPR;varying float vA;varying float vSeed;void main(){vA=alpha;vSeed=fract(position.x*.071+position.z*.053);vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=psize*uPR*(420./-mv.z);gl_Position=projectionMatrix*mv;}',
    fragmentShader: 'uniform sampler2D uNoise;varying float vA;varying float vSeed;void main(){vec2 c=gl_PointCoord-.5;float d=length(c);if(d>.5)discard;float n=texture2D(uNoise,gl_PointCoord*.45+vec2(vSeed,vSeed*1.7)).a;float edge=smoothstep(.5,.0,d);float breakup=smoothstep(.0,.9,n+.35-d*.55);gl_FragColor=vec4(1.,1.,1.,vA*edge*breakup*0.75);}',
  });
  const points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  points.renderOrder = 2;

  const parts: Particle[] = [];
  for (let i = 0; i < PMAX; i++) parts.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 1, a0: 1, grav: false, amp: 0.3 });
  let cursor = 0;

  function spawnP(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, alpha: number, grav: boolean, amp = 0.3): void {
    const p = parts[cursor];
    cursor = (cursor + 1) % PMAX;
    p.on = true; p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = life; p.max = life; p.size = size; p.a0 = alpha; p.grav = grav; p.amp = amp;
  }

  function splash(x: number, z: number, n: number, power: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(0.5, 1) * power;
      spawnP(x, 0.2, z, Math.cos(a) * s, rand(2, 5) * power * 0.6, Math.sin(a) * s, rand(0.6, 1.1), rand(0.5, 1.1), 0.9, true);
    }
  }

  function update(dt: number, t: number, waveHeight: (x: number, z: number, t: number, amp: number) => number): void {
    for (let i = 0; i < PMAX; i++) {
      const p = parts[i];
      if (!p.on) { pAlpha[i] = 0; continue; }
      p.life -= dt;
      if (p.life <= 0) { p.on = false; pAlpha[i] = 0; continue; }
      p.x += p.vx * dt; p.z += p.vz * dt;
      if (p.grav) {
        p.vy -= 9.8 * dt; p.y += p.vy * dt;
        if (p.y < -0.2) p.life = 0;
      } else {
        p.vx *= 1 - dt * 0.9; p.vz *= 1 - dt * 0.9;
        p.y = waveHeight(p.x, p.z, t, p.amp) + 0.14;
        // Growth rate cut from legacy's 1.4/s: under r186's correct linear-light blending, many
        // overlapping sprites saturate to opaque white in far fewer layers than they did under
        // r128's gamma-space blending (see world/particles.ts's shader comment), so letting each
        // one balloon this large compounded a handful of giant soft-edged discs into a hard-edged
        // quilted mass. Smaller, more numerous sprites blend into a continuous mist instead.
        p.size += dt * 0.5;
      }
      pPos[i * 3] = p.x; pPos[i * 3 + 1] = p.y; pPos[i * 3 + 2] = p.z;
      pSize[i] = p.size; pAlpha[i] = p.a0 * (p.life / p.max);
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.alpha.needsUpdate = true;
    pGeo.attributes.psize.needsUpdate = true;
  }

  return { points, spawnP, splash, update };
}
