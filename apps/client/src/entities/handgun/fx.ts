/**
 * World-space effects for the boat pistol: spent brass, bullet streaks, and the stunned fish that
 * floats up when a shot connects. Kept out of the view model (viewmodel.ts is camera-space and
 * knows nothing of the world) and out of the facade (index.ts is already the mode machine).
 *
 * ## Brass
 * Ejected from the view model's port in the camera's right/up/back frame, ballistic under gravity,
 * lands on a floor a deck's height below the eye and lies there a moment before vanishing. A
 * `tink` is asked for through `onLand` rather than played here, so this file has no audio import.
 * Rejected: leaving brass out ("spent brass" is on the brief for a reason - a gun that fires
 * nothing but a flash looks like a laser pointer), and rejected: keeping every casing forever,
 * which is a slow leak of meshes in a mode people will sit in for a long time.
 *
 * ## Streaks
 * A bullet moves 11 m per 30 Hz tick, i.e. it is invisible, and a shot with no visible path gives
 * no feedback about where it went (which, in a mode about aiming, is the whole point). A brief
 * additive line along each tick's segment is a tracer: cartoonish and honest about being one.
 *
 * ## The stunned fish
 * DECISION (the brief asks for one): a fish hit by the pistol is NOT collectable. It floats up
 * belly-up for a few seconds, then wakes and darts off. Reasons:
 *  1. Economy. Rounds cost ~$1.50; a landed fish pays by weight. If a bullet were a free landing,
 *     the pistol would dominate the rod and the speargun as an income source, and the $75 box would
 *     be a money printer. The speargun has a fight, a tether and a limited shaft supply for exactly
 *     this reason.
 *  2. Hands. Landing a fish through game/catch means a catch card, a cooler and a weigh-in, all of
 *     which assume the player is at the rail with a rod or in the water with a spear. A pistol
 *     mode has neither, and collecting from it would mean a gaff/net mechanic nobody asked for.
 *  3. Tone. "Plinking" stays plinking: the fish is stunned by the shockwave and wakes up
 *     offended; nothing is hurt.
 * The floater is a visual proxy: the school member it came from cannot be pulled out of the
 * instanced pools (entities/fish/pool.ts) without editing the fish module, so the school is
 * spooked instead (index.ts) and bolts, which leaves the floater alone in the water.
 */
import * as THREE from 'three';
import { SPECIES } from '@keysrun/shared/content/species';
import { scaledLenM } from '@keysrun/shared/sim/fight';
import { waveHBase } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { makeFishMesh } from '../../game/fishing/fish-mesh.js';
import { clamp, lerp } from '../../core/math.js';

/* ------------------------------------------------------------------------------------------ *
 * Brass
 * ------------------------------------------------------------------------------------------ */

interface Casing { m: THREE.Mesh; vx: number; vy: number; vz: number; sx: number; sy: number; sz: number; life: number; landed: boolean }
const CASING_FLOOR_BELOW_EYE = 1.55;
const REST_S = 1.6;

export interface Brass {
  eject(origin: THREE.Vector3, camera: THREE.Camera, eyeY: number): void;
  update(dt: number): void;
  clear(): void;
  count(): number;
  dispose(): void;
}

export function createBrass(scene: THREE.Scene, onLand: () => void): Brass {
  const geo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.019, 6);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.9 });
  const pool: Casing[] = [];
  const free: Casing[] = [];
  let floorY = -1;
  const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    scene.add(m);
    const c: Casing = { m, vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, life: 0, landed: false };
    pool.push(c); free.push(c);
  }
  return {
    eject(origin, camera, eyeY) {
      const c = free.pop();
      if (!c) return;
      camera.matrixWorld.extractBasis(right, up, fwd); // basis: right, up, +z (= backwards)
      const r = 1.5 + Math.random() * 0.7, u = 1.1 + Math.random() * 0.6, b = 0.2 + Math.random() * 0.5;
      c.vx = right.x * r + up.x * u + fwd.x * b;
      c.vy = right.y * r + up.y * u + fwd.y * b;
      c.vz = right.z * r + up.z * u + fwd.z * b;
      c.sx = (Math.random() - 0.5) * 30; c.sy = (Math.random() - 0.5) * 30; c.sz = (Math.random() - 0.5) * 30;
      c.m.position.copy(origin);
      c.m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      c.m.scale.setScalar(1);
      c.m.visible = true; c.life = 0; c.landed = false;
      floorY = eyeY - CASING_FLOOR_BELOW_EYE;
    },
    update(dt) {
      for (const c of pool) {
        if (!c.m.visible) continue;
        c.life += dt;
        if (!c.landed) {
          c.vy -= 9.81 * dt;
          c.m.position.x += c.vx * dt; c.m.position.y += c.vy * dt; c.m.position.z += c.vz * dt;
          c.m.rotation.x += c.sx * dt; c.m.rotation.y += c.sy * dt; c.m.rotation.z += c.sz * dt;
          if (c.m.position.y <= floorY && c.vy < 0) {
            if (c.vy < -1.4) { c.vy *= -0.28; c.vx *= 0.4; c.vz *= 0.4; onLand(); } else { c.landed = true; c.life = 0; }
          }
        } else if (c.life > REST_S) {
          c.m.scale.setScalar(Math.max(0, 1 - (c.life - REST_S) / 0.3));
          if (c.life > REST_S + 0.3) { c.m.visible = false; free.push(c); }
        }
        if (!c.landed && c.life > 3) { c.m.visible = false; free.push(c); } // fell overboard, forget it
      }
    },
    clear() { for (const c of pool) if (c.m.visible) { c.m.visible = false; free.push(c); } },
    count() { return pool.filter((c) => c.m.visible).length; },
    dispose() { for (const c of pool) scene.remove(c.m); geo.dispose(); mat.dispose(); },
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Streaks
 * ------------------------------------------------------------------------------------------ */

export interface Streaks {
  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void;
  update(dt: number): void;
  clear(): void;
  dispose(): void;
}

export function createStreaks(scene: THREE.Scene): Streaks {
  const LIFE = 0.09;
  const lines: Array<{ l: THREE.Line; t: number; mat: THREE.LineBasicMaterial }> = [];
  for (let i = 0; i < 10; i++) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const mat = new THREE.LineBasicMaterial({ color: 0xfff1c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const l = new THREE.Line(g, mat);
    l.frustumCulled = false; l.visible = false;
    scene.add(l);
    lines.push({ l, t: 0, mat });
  }
  let next = 0;
  return {
    add(ax, ay, az, bx, by, bz) {
      const s = lines[next++ % lines.length];
      const p = s.l.geometry.attributes.position as THREE.BufferAttribute;
      p.setXYZ(0, ax, ay, az); p.setXYZ(1, bx, by, bz); p.needsUpdate = true;
      s.t = LIFE; s.l.visible = true; s.mat.opacity = 0.9;
    },
    update(dt) {
      for (const s of lines) {
        if (!s.l.visible) continue;
        s.t -= dt;
        if (s.t <= 0) { s.l.visible = false; continue; }
        s.mat.opacity = 0.9 * clamp(s.t / LIFE, 0, 1);
      }
    },
    clear() { for (const s of lines) s.l.visible = false; },
    dispose() { for (const s of lines) { scene.remove(s.l); s.l.geometry.dispose(); s.mat.dispose(); } },
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Stunned fish
 * ------------------------------------------------------------------------------------------ */

const FLOAT_S = 9;
const WAKE_S = 0.6;
const DART_S = 1.9;
const MAX_FLOATERS = 5;

interface Floater {
  mesh: THREE.Group; x: number; z: number; t: number; yaw: number; drift: number; key: string;
  /** Where the fish was facing when hit, so waking up and swimming off reads as continuous. */
  heading: number;
}

export interface Floaters {
  spawn(key: string, weight: number, x: number, z: number, awayX: number, awayZ: number): void;
  update(dt: number, t: number): void;
  clear(): void;
  count(): number;
  states(): Array<{ key: string; phase: 'float' | 'wake' | 'dart'; t: number }>;
  dispose(): void;
}

export function createFloaters(scene: THREE.Scene): Floaters {
  const live: Floater[] = [];
  function drop(f: Floater): void {
    scene.remove(f.mesh);
    f.mesh.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry?.dispose(); }); // materials are shared per species (fish-mesh.ts), not ours
    live.splice(live.indexOf(f), 1);
  }
  const phaseOf = (f: Floater): 'float' | 'wake' | 'dart' => f.t < FLOAT_S ? 'float' : f.t < FLOAT_S + WAKE_S ? 'wake' : 'dart';
  return {
    spawn(key, weight, x, z, awayX, awayZ) {
      if (live.length >= MAX_FLOATERS) drop(live[0]);
      const S = SPECIES[key];
      const mesh = makeFishMesh(S?.color ?? '#9aa', scaledLenM(key, weight));
      scene.add(mesh);
      const dx = x - awayX, dz = z - awayZ, l = Math.hypot(dx, dz) || 1;
      // Wakes up and swims AWAY from the boat, not toward it.
      const heading = Math.atan2(-dx / l, -dz / l);
      live.push({ mesh, x, z, t: 0, yaw: heading + (Math.random() - 0.5) * 1.2, drift: (Math.random() - 0.5) * 0.3, key, heading });
    },
    update(dt, t) {
      for (const f of [...live]) {
        f.t += dt;
        const ph = phaseOf(f);
        const surf = waveHBase(f.x, f.z, t, ampAt(f.x, f.z));
        if (ph === 'float') {
          f.x += Math.sin(f.yaw) * -0.03 * dt + f.drift * dt * 0.2;
          f.z += Math.cos(f.yaw) * -0.03 * dt;
          f.mesh.position.set(f.x, surf - 0.03 + Math.sin(t * 2.1 + f.x) * 0.02, f.z);
          // belly-up (roll pi), rocking a little on the swell
          f.mesh.rotation.set(Math.sin(t * 1.3 + f.z) * 0.08, f.yaw, Math.PI + Math.sin(t * 1.7 + f.x) * 0.12, 'YXZ');
        } else if (ph === 'wake') {
          const q = (f.t - FLOAT_S) / WAKE_S;
          f.mesh.position.set(f.x, surf - 0.03 - 0.05 * q, f.z);
          // flips upright with a shudder
          f.mesh.rotation.set(0, f.yaw + Math.sin(q * 40) * 0.25, lerp(Math.PI, 0, q * q * (3 - 2 * q)) + Math.sin(q * 30) * 0.15, 'YXZ');
        } else {
          const q = f.t - FLOAT_S - WAKE_S;
          const sp = 2.8;
          f.x += -Math.sin(f.yaw) * sp * dt; f.z += -Math.cos(f.yaw) * sp * dt;
          f.mesh.position.set(f.x, surf - 0.1 - q * 0.45, f.z);
          f.mesh.rotation.set(0.15, f.yaw + Math.sin(t * 14) * 0.1, Math.sin(t * 14 + 0.5) * 0.12, 'YXZ');
          if (q > DART_S) drop(f);
        }
      }
    },
    clear() { for (const f of [...live]) drop(f); },
    count() { return live.length; },
    states() { return live.map((f) => ({ key: f.key, phase: phaseOf(f), t: +f.t.toFixed(2) })); },
    dispose() { for (const f of [...live]) drop(f); },
  };
}
