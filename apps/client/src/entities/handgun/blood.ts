/**
 * A bit of blood: when a round connects with a fish, a small dark-red cloud blooms at the impact
 * point, drifts off with the current, thins out and is gone in a few seconds. It is a cloud in the
 * water, not a spray - underwater, a wound does not squirt, it clouds - and it is deliberately
 * brief and small so it reads as matter-of-fact rather than lingering (this is a fishing game in
 * which the speargun has always killed fish; the register is the same).
 *
 * ## Why its own tiny particle system
 * world/particles.ts's shared system is spray and foam: every particle is white and falls under
 * gravity, with no per-particle colour. Teaching it colour would have meant editing a hot shared
 * module for one effect. This is the same call entities/speargun/shaft.ts made for its muzzle
 * bubbles (a ~60-line pool owned by the feature), and it follows the same current: each particle
 * relaxes toward `waterVelocity` (the field the diver, the fish and the seep bubbles already lean
 * downstream with) rather than toward rest, so a cloud on a running tide trails away downstream.
 *
 * ## Cost when nothing has been shot
 * One fixed pool (`MAX` points), allocated once. While no particle is alive `update` returns on its
 * first line and the Points object is hidden, so an unfired pistol costs one boolean per frame. A
 * burst reuses the oldest slots, so the cloud cannot accumulate however fast the gun is emptied.
 */
import * as THREE from 'three';
import { waterVelocity } from '@keysrun/shared/sim/diver';
import { seafloorHeightAt } from '../../world/seafloor.js';
import { clamp, rand } from '../../core/math.js';

const MAX = 56;
const PER_BURST = 8;

export interface Blood {
  /** A puff at (x, y, z) world space. `t` is sim time, for the current. */
  burst(x: number, y: number, z: number, t: number): void;
  update(dt: number): void;
  /** Particles currently alive, for verification. */
  active(): number;
  clear(): void;
  dispose(): void;
}

export function createBlood(scene: THREE.Scene): Blood {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAX * 3);
  const alpha = new Float32Array(MAX);
  const size = new Float32Array(MAX);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('psize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    // A soft round blot, dark red, that thins toward its edge so overlapping blots read as one cloud
    // rather than a pile of discs.
    vertexShader: 'attribute float alpha;attribute float psize;varying float vA;void main(){vA=alpha;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=psize*(380./-mv.z);gl_Position=projectionMatrix*mv;}',
    fragmentShader: 'varying float vA;void main(){vec2 c=gl_PointCoord-.5;float d=length(c);if(d>.5)discard;float soft=smoothstep(.5,.05,d);gl_FragColor=vec4(0.46,0.03,0.05,vA*soft);}',
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  points.renderOrder = 3;
  scene.add(points);

  interface P { on: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; s0: number; s1: number; t: number }
  const parts: P[] = [];
  for (let i = 0; i < MAX; i++) parts.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, s0: 0.1, s1: 0.4, t: 0 });
  let cursor = 0;
  let alive = 0;

  function burst(x: number, y: number, z: number, t: number): void {
    for (let i = 0; i < PER_BURST; i++) {
      const p = parts[cursor];
      cursor = (cursor + 1) % MAX;
      if (!p.on) alive++;
      p.on = true;
      // A little scatter around the wound, not a jet: a few tenths of a metre per second, which the
      // water's own motion takes over from within a second (see `update`).
      p.x = x + rand(-0.08, 0.08); p.y = y + rand(-0.06, 0.06); p.z = z + rand(-0.08, 0.08);
      p.vx = rand(-0.35, 0.35); p.vy = rand(-0.12, 0.2); p.vz = rand(-0.35, 0.35);
      p.max = p.life = rand(2.4, 3.6);
      p.s0 = rand(0.1, 0.18); p.s1 = rand(0.4, 0.62);
      p.t = t;
    }
    points.visible = true;
  }

  function update(dt: number): void {
    if (alive === 0) { if (points.visible) points.visible = false; return; }
    for (let i = 0; i < MAX; i++) {
      const p = parts[i];
      if (!p.on) { alpha[i] = 0; continue; }
      p.life -= dt;
      if (p.life <= 0) { p.on = false; alive--; alpha[i] = 0; continue; }
      p.t += dt;
      // Relax toward the local current (not toward rest): the cloud is carried, and thins as it goes.
      const f = waterVelocity(p.x, p.y, p.z, p.t, seafloorHeightAt(p.x, p.z));
      const k = Math.min(1, dt * 1.4);
      p.vx += (f.x - p.vx) * k; p.vz += (f.z - p.vz) * k;
      p.vy += (0.02 - p.vy) * k; // neutrally buoyant, faint upward drift
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const age = 1 - p.life / p.max; // 0 fresh .. 1 gone
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      // Blooms quickly, then thins: alpha peaks early and eases to zero.
      alpha[i] = clamp(age < 0.08 ? age / 0.08 : (1 - age) / 0.92, 0, 1) * 0.62;
      size[i] = p.s0 + (p.s1 - p.s0) * Math.sqrt(age);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
    geo.attributes.psize.needsUpdate = true;
    if (alive === 0) points.visible = false;
  }

  return {
    burst, update,
    active: () => alive,
    clear() { for (const p of parts) p.on = false; alive = 0; alpha.fill(0); points.visible = false; geo.attributes.alpha.needsUpdate = true; },
    dispose() { scene.remove(points); geo.dispose(); mat.dispose(); },
  };
}
