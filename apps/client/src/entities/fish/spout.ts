/**
 * The whale "blow" visual tell — a brief rising plume at the surface when a whale's 'blow' act
 * (behavior.ts/school.ts) reaches its surfacing peak. `stepSchool` reports the moment/location as
 * a `SchoolEvent` of type 'blow' rather than drawing it itself (school.ts is pure simulation, no
 * three.js — see that file's header); `index.ts` consumes the event and calls `spawn()` here,
 * same split as every other three.js-touching piece of this module (render.ts, pool.ts).
 *
 * Deliberately simple: one small shared `InstancedMesh` of tapering cones. Whale sightings are
 * rare by design (creatures.ts's tiny ZONE_LIFE weights), so there is never more than a handful of
 * blows in flight at once — no pooling machinery beyond a flat free-list is warranted.
 */
import * as THREE from 'three';

const BLOW_CAPACITY = 12;
const BLOW_LIFETIME_S = 1.8;
const BLOW_RISE_M = 7;

interface ActiveBlow {
  slot: number;
  x: number;
  y: number;
  z: number;
  age: number;
}

export interface SpoutSystem {
  /** Called once per 'blow' `SchoolEvent` — grabs a free slot (or silently drops if all are
   * somehow in use, which given the rarity above should never happen in practice) and starts it
   * rising from `(x, y, z)`. */
  spawn(x: number, y: number, z: number): void;
  /** Call once per frame regardless of whether anything spawned this frame. */
  update(dt: number): void;
  dispose(): void;
}

export function createSpoutSystem(group: THREE.Group): SpoutSystem {
  const geo = new THREE.ConeGeometry(0.9, 1, 8, 1, true);
  geo.translate(0, 0.5, 0); // base at the origin so scaling the Y axis grows it upward from the water
  // A near-white plume disappears against this game's pale, hazy sky (confirmed against an actual
  // screenshot) — a slightly darker, more saturated grey-blue reads against both sky and water.
  // Sized generously (a humpback is seen from tens of meters out) — a blow is the one tell meant
  // to read "whale" before the animal itself is even clearly resolved, so it should be unmissable,
  // not a polite wisp.
  const mat = new THREE.MeshBasicMaterial({
    color: 0x9fb0b8, transparent: true, opacity: 0.88, depthWrite: false, fog: true,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, BLOW_CAPACITY);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;

  const dummy = new THREE.Object3D();
  const park = (slot: number): void => {
    dummy.position.set(0, -50, 0);
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  };
  for (let i = 0; i < BLOW_CAPACITY; i++) park(i);

  const active: ActiveBlow[] = [];
  const free: number[] = [];
  for (let i = BLOW_CAPACITY - 1; i >= 0; i--) free.push(i);
  let inScene = false;

  function spawn(x: number, y: number, z: number): void {
    const slot = free.pop();
    if (slot === undefined) return;
    active.push({ slot, x, y, z, age: 0 });
    if (!inScene) { group.add(mesh); inScene = true; }
  }

  function update(dt: number): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const b = active[i];
      b.age += dt;
      const frac = b.age / BLOW_LIFETIME_S;
      if (frac >= 1) {
        park(b.slot);
        free.push(b.slot);
        active.splice(i, 1);
        continue;
      }
      // Fast initial rise, then lingers and thins — a vapor plume dispersing, not a bouncing ball.
      const rise = Math.min(1, frac * 2.2) * BLOW_RISE_M;
      const girth = (1 - frac * 0.5) * Math.min(1, frac * 5 + 0.15);
      dummy.position.set(b.x, b.y + rise * 0.5, b.z);
      dummy.scale.set(girth, Math.max(0.05, rise), girth);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(b.slot, dummy.matrix);
    }
    if (active.length > 0) {
      mesh.count = BLOW_CAPACITY; // trivial at this capacity — no high-water-mark bookkeeping needed
      mesh.instanceMatrix.needsUpdate = true;
    } else if (inScene) {
      mesh.count = 0;
      group.remove(mesh);
      inScene = false;
    }
  }

  function dispose(): void {
    geo.dispose();
    mat.dispose();
  }

  return { spawn, update, dispose };
}
