/**
 * The fishing buddy: a second boat (a different hull than whatever the player is driving) that
 * tags along at a polite distance, anchors up nearby when you stop, and fishes — with the odd
 * hookup, a jump, and a name tag over its head.
 *
 * Ported faithfully from legacy/index.html:3548-3606 (`buddyWater`, `buddyBuild`,
 * `buddyPlaceNear`, `toggleBuddy`, `updateBuddy`).
 *
 * The hooked-fish jump (legacy: `new THREE.Mesh(VGEO[BUDDY.key], vMat)`) reused the rod-fishing
 * pipeline's real fish geometry — `entities/fish/**`'s territory, not this task's. Ported here as
 * a small stand-alone silhouette tinted from `SPECIES[key].color` instead, so this module stays
 * self-contained; everything else (species roll via the real `pickSpecies`, splashes, timing) is
 * faithful.
 */
import * as THREE from 'three';
import { makeBoat, type BoatModel, type BoatBuildDeps } from '../boat/model.js';
import { BOATS, SPEED_SCALE, type Boat } from '@keysrun/shared/content/boats';
import { WB, depthAt, landH, zoneAt } from '@keysrun/shared/world/depth';
import { waveHBase } from '@keysrun/shared/waves';
import { pickSpecies } from '@keysrun/shared/sim/fight';
import { SPECIES } from '@keysrun/shared/content/species';
import type { Rng } from '@keysrun/shared/rng';
import { clamp, lerp, rand } from '../../core/math.js';
import type { ParticleSystem } from '../../world/particles.js';
import type { RemoteEngineSource } from '../../audio/interfaces.js';

const rng: Rng = () => Math.random();
const _tmpA = new THREE.Vector3();

/** legacy `buddyWater` (index.html:3550-3551): find open, deep-enough, in-bounds water near a
 * point, spiralling outward if the point itself doesn't qualify. */
function buddyWater(x: number, z: number, draft: number): [number, number] | null {
  const ok = (a: number, b: number): boolean => depthAt(a, b) > Math.max(draft + 0.9, 2.6) && landH(a, b) < -0.6 && a > WB.x0 + 50 && a < WB.x1 - 50 && b > WB.z0 + 50 && b < WB.z1 - 50;
  if (ok(x, z)) return [x, z];
  for (let r = 30; r <= 900; r += 30) for (let k = 0; k < 16; k++) {
    const a = k / 16 * Math.PI * 2, xx = x + Math.cos(a) * r, zz = z + Math.sin(a) * r;
    if (ok(xx, zz)) return [xx, zz];
  }
  return null;
}

export interface BuddyBoatLike { x: number; z: number; h: number; speed: number }

export interface FishingBuddy {
  isOn(): boolean;
  /** legacy `toggleBuddy` (index.html:3561-3562). */
  toggle(): void;
  update(dt: number, t: number, boat: BuddyBoatLike, playerBoatId: string, camera: THREE.PerspectiveCamera, viewport: { w: number; h: number }, particles: ParticleSystem): void;
  engineSource(): RemoteEngineSource | undefined;
  dispose(): void;
}

export function createFishingBuddy(scene: THREE.Scene, deps: BoatBuildDeps): FishingBuddy {
  let on = false;
  let spec: Boat | null = null;
  let model: BoatModel | null = null;
  let x = 0, z = 0, h = 0, speed = 0, y = 0, pitch = 0, roll = 0;
  let state: 'follow' | 'moving' | 'fishing' = 'follow';
  let spot: [number, number] | null = null;
  let stillT = 0;
  let hookT = rand(35, 70);
  let fight = 0;
  let key = 'mangrove';
  let fx = 0, fz = 0; // where the buddy's hooked fish splashes/jumps
  let jump: { m: THREE.Mesh; t: number; x: number; z: number; a: number } | null = null;
  let wt = 0;
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.textContent = '\u{1F91D} Buddy';
  tag.style.display = 'none';
  document.getElementById('tags')?.appendChild(tag);
  const projV = new THREE.Vector3();

  function pickSpec(playerBoatId: string): Boat {
    const id = ['freeman', 'grady', 'midnight', 'mti', 'robalo'].find((bid) => bid !== playerBoatId) ?? 'grady';
    return BOATS.find((b) => b.id === id) ?? BOATS[0];
  }

  function build(playerBoatId: string): void {
    const want = pickSpec(playerBoatId);
    if (model && spec === want) return;
    if (model) scene.remove(model.group);
    spec = want;
    model = makeBoat(spec, deps);
    model.group.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = false; });
    scene.add(model.group);
  }

  function placeNear(boat: BuddyBoatLike): void {
    if (!spec) return;
    const pfx = -Math.sin(boat.h), pfz = -Math.cos(boat.h);
    const p = buddyWater(boat.x - pfx * 450 + Math.cos(boat.h) * 180, boat.z - pfz * 450 - Math.sin(boat.h) * 180, spec.draft) ?? buddyWater(boat.x, boat.z, spec.draft);
    if (p) { x = p[0]; z = p[1]; }
    h = boat.h; speed = 0; spot = null;
  }

  return {
    isOn(): boolean { return on; },
    toggle(): void {
      on = !on;
      if (model) model.group.visible = on;
      if (!on) { tag.style.display = 'none'; }
    },
    update(dt, t, boat, playerBoatId, camera, viewport, particles) {
      const cameraPos = camera.position;
      if (!on) return;
      if (!model || !spec || spec.id === playerBoatId) { build(playerBoatId); placeNear(boat); }
      if (!model || !spec) return;
      const S = spec, topMs = S.top * 0.5144 * SPEED_SCALE;
      const ps = Math.abs(boat.speed), pfx = -Math.sin(boat.h), pfz = -Math.cos(boat.h), prx = Math.cos(boat.h), prz = -Math.sin(boat.h);
      let dist = Math.hypot(x - boat.x, z - boat.z);
      if (dist > 2200) { placeNear(boat); dist = Math.hypot(x - boat.x, z - boat.z); }
      // where to be: trailing off your quarter while you run; anchored up nearby (not too near) when you stop
      let tx: number, tz: number, stop = false;
      if (ps > 2.2) { spot = null; tx = boat.x - pfx * 380 + prx * 160; tz = boat.z - pfz * 380 + prz * 160; state = 'follow'; }
      else {
        if (!spot || Math.hypot(spot[0] - boat.x, spot[1] - boat.z) > 600) {
          const side = Math.random() < 0.5 ? 1 : -1;
          spot = buddyWater(boat.x + prx * side * 330 - pfx * 80, boat.z + prz * side * 330 - pfz * 80, S.draft) ?? [x, z];
        }
        tx = spot[0]; tz = spot[1];
        stop = Math.hypot(tx - x, tz - z) < 18;
        state = stop ? 'fishing' : 'moving';
      }
      const dx = tx - x, dz = tz - z, e = Math.hypot(dx, dz);
      let want = Math.atan2(-dx, -dz), v = stop ? 0 : clamp((e - 15) * 0.12 + (ps > 2.2 ? ps * 0.95 : 0), 0, topMs * 0.9);
      if (dist < 220) { want = Math.atan2(-(x - boat.x), -(z - boat.z)) + Math.PI; v = Math.min(v, 6); } // give you room
      const bfx = -Math.sin(h), bfz = -Math.cos(h), look = 20 + speed * 1.5;
      if (depthAt(x + bfx * look, z + bfz * look) < S.draft + 0.6 || landH(x + bfx * look, z + bfz * look) > -0.6) { want = h + 1.4; v = Math.min(v, 5); }
      const wrap = (a: number): number => ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      h += clamp(wrap(want - h), -1, 1) * Math.min(1, dt * (0.6 + Math.min(1, speed / 10)));
      speed += clamp(v - speed, -4 * dt, 3 * dt);
      x += -Math.sin(h) * speed * dt; z += -Math.cos(h) * speed * dt;
      // ride the water
      const fxv = -Math.sin(h), fzv = -Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h), amp = 0.3, hl = S.len * 0.45, hb2 = S.beam * 0.5;
      const hb = waveHBase(x + fxv * hl, z + fzv * hl, t, amp), hs = waveHBase(x - fxv * hl, z - fzv * hl, t, amp);
      const hp = waveHBase(x - rx * hb2, z - rz * hb2, t, amp), hst = waveHBase(x + rx * hb2, z + rz * hb2, t, amp), fr = Math.min(1, speed / topMs);
      y = lerp(y, (hb + hs + hp + hst) / 4 + fr * 0.3, Math.min(1, dt * 4));
      pitch = lerp(pitch, Math.atan2(hb - hs, S.len) + fr * 0.07, Math.min(1, dt * 4));
      roll = lerp(roll, Math.atan2(hp - hst, S.beam) * 0.7, Math.min(1, dt * 3));
      const gg = model.group;
      gg.position.set(x, y, z);
      gg.rotation.set(pitch, h, roll, 'YXZ');
      model.props.forEach((p) => { p.rotation.z += dt * speed * 1.5; });
      model.flags.forEach((fl) => { fl.update(t, speed + 4); });
      wt += dt;
      if (wt > 0.4 && speed > 2.5) wt = 0; // (legacy's shared-pool emitWake dropped; see racers.ts's header)
      if (speed > 3 && Math.hypot(x - cameraPos.x, z - cameraPos.z) < 500 && Math.random() < dt * speed * 0.6) {
        const sx = x - fxv * S.len * 0.52, sz = z - fzv * S.len * 0.52;
        for (const sg of [-1, 1]) particles.spawnP(sx + rx * S.beam * 0.4 * sg, 0.1, sz + rz * S.beam * 0.4 * sg, rx * sg * 2 - fxv * 2, 0, rz * sg * 2 - fzv * 2, rand(2, 3.5), rand(1.2, 2), 0.5, false, amp);
      }
      // fishing while parked: rod out, the odd hookup with a jump
      const fishing = state === 'fishing';
      stillT = fishing ? stillT + dt : 0;
      model.rodPivot.visible = stillT > 4;
      model.rodPivot.rotation.set(-0.9 - (fight > 0 ? 0.3 + Math.sin(t * 14) * 0.08 : 0), -Math.PI / 2, 0, 'YXZ');
      if (stillT > 4) {
        hookT -= dt;
        if (hookT <= 0 && fight <= 0) {
          fight = rand(14, 30); hookT = rand(45, 110);
          const rp = model.group.localToWorld(_tmpA.set(model.rodPivot.position.x + 18, 0, model.rodPivot.position.z));
          fx = rp.x; fz = rp.z;
          particles.splash(rp.x, rp.z, 18, 1.1);
          key = pickSpecies(zoneAt(rp.x, rp.z), { x: rp.x, z: rp.z }, { hotspot: false, hump: null }, rng);
        }
        if (fight > 0) {
          fight -= dt;
          if (Math.random() < dt * 1.2) particles.splash(fx + rand(-3, 3), fz + rand(-3, 3), 6, 0.6);
          if (!jump && SPECIES[key]?.jump && Math.random() < dt * 0.25) {
            const mm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.3, 4, 8), new THREE.MeshStandardMaterial({ color: new THREE.Color(SPECIES[key].color), roughness: 0.3, metalness: 0.1 }));
            mm.rotation.z = Math.PI / 2;
            scene.add(mm);
            jump = { m: mm, t: 0, x: fx, z: fz, a: Math.random() * 6.28 };
            particles.splash(fx, fz, 16, 1.2);
          }
        }
      }
      if (jump) {
        const j = jump;
        j.t += dt;
        const p = j.t / 1.2;
        if (p >= 1) { particles.splash(j.x + Math.cos(j.a) * 3, j.z + Math.sin(j.a) * 3, 16, 1.1); scene.remove(j.m); jump = null; }
        else {
          j.m.position.set(j.x + Math.cos(j.a) * 3 * p, -0.4 + 4 * 2 * p * (1 - p), j.z + Math.sin(j.a) * 3 * p);
          j.m.rotation.set((1 - 2 * p) * 1.1, Math.atan2(-Math.cos(j.a), -Math.sin(j.a)), Math.sin(p * 20) * 0.4, 'YXZ');
        }
      }
      // idle animation (head bob/blink/hair) for the humans aboard — legacy's generic per-human
      // `updateHumans(t)` ran over every human including the buddy's; the buddy-specific walking/
      // dancing/pole/shower animation never did (legacy never called those with `BUDDY.model`).
      model.captain.update(t, speed);
      model.crew.update(t, speed);
      for (const P of model.party) P.h.update(t, speed);
      // name tag (legacy index.html:3604-3605)
      projV.set(x, y + 6, z).project(camera);
      const dc = Math.hypot(x - cameraPos.x, z - cameraPos.z);
      const vis = projV.z < 1 && dc < 900 && dc > 25;
      tag.style.display = vis ? 'block' : 'none';
      if (vis) {
        tag.style.left = ((projV.x + 1) / 2 * viewport.w) + 'px';
        tag.style.top = ((1 - projV.y) / 2 * viewport.h) + 'px';
        tag.textContent = '\u{1F91D} Buddy' + (fight > 0 ? ' · \u{1F3A3} fish on!' : stillT > 4 ? ' · fishing' : '');
      }
    },
    engineSource(): RemoteEngineSource | undefined {
      if (!on || !model || !spec) return undefined;
      return { id: 'buddy', x, z, speed, engineProfile: spec.id, engineCount: spec.engines, audible: model.group.visible, topMs: spec.top * 0.5144 * SPEED_SCALE };
    },
    dispose(): void {
      tag.remove();
      if (model) scene.remove(model.group);
    },
  };
}
