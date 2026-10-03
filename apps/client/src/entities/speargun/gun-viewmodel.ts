/**
 * First-person speargun view model — net-new (legacy has no spearfishing; see
 * docs/ARCHITECTURE.md's "Spearfishing"), styled after game/fishing/rod-viewmodel.ts's camera-
 * attached rig. Purely cosmetic: it kicks on fire and its loaded shaft slides back out as the
 * gun reloads, but none of that drives `sim/spear.ts` — it only *reflects* the pure sim state
 * (`GunState.reloadT`, whether a shot is in flight) that `index.ts` already owns.
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math.js';

export interface GunViewModel {
  group: THREE.Group;
  /** World-space muzzle, used as the shot's visual origin so the flying shaft starts exactly
   * where the model's barrel is, same convention as the rod's `tip`. */
  muzzle: THREE.Object3D;
  update(dt: number, reloadFrac: number, speared: boolean): void;
  kick(): void;
  dispose(): void;
}

/** `reloadFrac` 0 = just fired (empty), 1 = fully loaded — the caller derives it from
 * `GunState.reloadT / SPEAR_RELOAD` (clamped; `SPEAR_RELOAD_FLOOR` can make it reach 1 before
 * `reloadT` hits exactly 0, which is fine — it only drives the cosmetic slide). */
export function createGunViewModel(camera: THREE.Camera): GunViewModel {
  const group = new THREE.Group();
  // Unlike the rod (game/fishing/rod-viewmodel.ts), which toggles visible only in first-person
  // fishing mode while otherwise showing the boat-mounted third-person rod instead, there is no
  // third-person "speargun on a model" — spearfishing is inherently the diver's own first-person
  // view, so this view model is visible whenever it exists.
  group.visible = true;
  camera.add(group);

  const base = new THREE.Group();
  base.position.set(0.26, -0.32, -0.62);
  base.rotation.set(-0.04, 0.03, 0, 'YXZ');
  group.add(base);

  const dark = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.4, metalness: 0.5 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9c0c6, roughness: 0.25, metalness: 0.85 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.8 });

  const BARREL_LEN = 0.78;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, BARREL_LEN, 10).rotateX(Math.PI / 2), dark);
  barrel.position.z = -BARREL_LEN / 2;
  base.add(barrel);

  const muzzleRing = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.006, 6, 12), steel);
  muzzleRing.position.z = -BARREL_LEN;
  base.add(muzzleRing);

  // bands (two, either side) — purely decorative, don't animate with reload.
  for (const side of [-1, 1]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.5, 6).rotateX(Math.PI / 2), rubber);
    band.position.set(side * 0.025, 0.012, -0.32);
    base.add(band);
  }

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.08), dark);
  grip.position.set(0, -0.11, 0.08);
  grip.rotation.x = 0.25;
  base.add(grip);

  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.05, 0.02), steel);
  trigger.position.set(0, -0.03, 0.1);
  base.add(trigger);

  // the loaded shaft, poking out the muzzle; slides back to `reloadFrac=0` on fire and back out
  // as the gun reloads.
  const SHAFT_POKE = 0.3;
  const loadedShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, SHAFT_POKE, 6).rotateX(Math.PI / 2), steel);
  base.add(loadedShaft);

  const muzzle = new THREE.Object3D();
  muzzle.position.z = -BARREL_LEN;
  base.add(muzzle);

  let kickT = 0;

  function update(dt: number, reloadFrac: number, speared: boolean): void {
    const frac = clamp(reloadFrac, 0, 1);
    loadedShaft.visible = !speared;
    // fully loaded: tip sits just past the muzzle ring; fully empty: tip withdrawn to the muzzle.
    loadedShaft.position.z = -BARREL_LEN - SHAFT_POKE * 0.5 * frac;

    if (kickT > 0) {
      kickT = Math.max(0, kickT - dt / 0.22);
      base.position.z = -0.62 + 0.09 * Math.sin(kickT * Math.PI);
      base.rotation.x = -0.04 - 0.1 * Math.sin(kickT * Math.PI);
    } else {
      base.position.z = lerp(base.position.z, -0.62, Math.min(1, dt * 10));
      base.rotation.x = lerp(base.rotation.x, -0.04, Math.min(1, dt * 10));
    }
  }

  function kick(): void { kickT = 1; }

  function dispose(): void { camera.remove(group); }

  return { group, muzzle, update, kick, dispose };
}
