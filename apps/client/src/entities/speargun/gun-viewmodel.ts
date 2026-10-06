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
  /** `speed` (diver swim speed, m/s — index.ts passes `Math.hypot(diver's vx,vy,vz)`) sizes the
   * idle sway: a small breathing/treading-water drift at rest, more pronounced while swimming,
   * same "weapon isn't welded to the camera" idea as a held weapon in any first-person game. */
  update(dt: number, reloadFrac: number, speared: boolean, speed?: number): void;
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
  // third-person "speargun on a model" at all — it's either the diver's own first-person view or
  // nothing. Starts hidden (there's no dive in progress at boot): `Speargun.setViewVisible`
  // (index.ts) is the one thing that ever flips this, called by game/world.ts's `setDiveUI` on
  // every dive-mode transition, the same place `diverModel.group.visible` gets toggled.
  group.visible = false;
  camera.add(group);

  const base = new THREE.Group();
  base.position.set(0.26, -0.32, -0.62);
  base.rotation.set(-0.04, 0.03, 0, 'YXZ');
  group.add(base);

  // A small fixed-to-camera fill light — the "most games cheat their view-model lighting" move
  // this module's own header already called out as the standard fix but didn't actually apply.
  // Verification screenshots (this task's report) showed the gun reading as a flat black
  // silhouette even at 1 m depth whenever the main scene's key light wasn't hitting it face-on
  // (e.g. looking toward open water with the sun behind it). A light riding along with the camera,
  // rather than one fixed in world space, guarantees the gun stays readable from every look
  // direction without touching the real underwater extinction model (out of this task's scope).
  // Parented to `group` (not `camera` directly) specifically so it only exists while the gun is
  // actually shown — three.js skips an invisible object's light contribution the same way it
  // skips its mesh, so `setViewVisible(false)` (aboard the boat) turns this off for free rather
  // than leaving a stray light glowing in camera space with nothing attached to it. Negative z
  // (camera looks down -Z) — level with and just above the barrel, the same side of the camera
  // the gun actually sits on.
  const viewFill = new THREE.PointLight(0xbfe6ea, 2.5, 2.2, 2);
  viewFill.position.set(0.15, 0.05, -0.35);
  group.add(viewFill);

  // Lighter than a real gunmetal/rubber black on purpose — this view model is lit by whatever the
  // *main scene's* lighting is (unlike the trophy card's own dedicated rig in underwater-
  // trophy.ts), and that dims hard with depth (the real underwater extinction model, which this
  // task does not own/touch), on top of which `viewFill` above now rides along with the camera.
  // A near-black held object measured as essentially invisible by ~8 m depth in testing — exactly
  // the "at rest" shot this is for. A held tool staying legible regardless of ambient light is a
  // standard first-person convention (most games cheat their view-model lighting for this
  // reason), not a claim that gear doesn't darken underwater.
  const dark = new THREE.MeshStandardMaterial({ color: 0x3c4a54, roughness: 0.4, metalness: 0.5 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc7ced4, roughness: 0.25, metalness: 0.85 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x262b2f, roughness: 0.8 });

  const BARREL_LEN = 0.78;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, BARREL_LEN, 10).rotateX(Math.PI / 2), dark);
  barrel.position.z = -BARREL_LEN / 2;
  base.add(barrel);

  const muzzleRing = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.006, 6, 12), steel);
  muzzleRing.position.z = -BARREL_LEN;
  base.add(muzzleRing);

  // bands (two, either side) — animate with reload (see `update`'s BAND_SHORT/BAND_LONG): a real
  // speargun band's front loop stays hooked near the muzzle while the diver draws its tail back
  // toward the grip to load, so each band's geometry is built unit-length/unit-radius and scaled
  // per-frame rather than baked at a fixed size.
  const BAND_ANCHOR_Z = -BARREL_LEN + 0.06;
  const bands: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6).rotateX(Math.PI / 2), rubber);
    // Offset far enough past the barrel's own ~0.02 radius to read as a separate element rather
    // than overlapping it in silhouette (an earlier, tighter 0.025 offset — barely past the
    // barrel's radius at all — measured as visually indistinguishable from the barrel in this
    // task's verification screenshots).
    band.position.set(side * 0.042, 0.012, BAND_ANCHOR_Z);
    base.add(band);
    bands.push(band);
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
  let kickYaw = 0, kickRoll = 0; // per-shot random jitter, picked fresh in kick() — see its comment
  let seatT = 0; // the "click" pulse when a reload finishes — see update()'s crossing check
  let prevFrac = 1;
  let swayT = 0;
  // `group` carries the kick/reload transforms (base's own position/rotation, above); sway is
  // applied one level up on `group` itself so it never fights with the kick's base.position.z
  // write — the two compose cleanly as separate transforms on separate nodes.
  const swaySway = new THREE.Vector3();

  // Loaded (frac=1): band drawn long and thin, tail hauled back near the grip. Just fired
  // (frac=0): band relaxed short and fat, bunched up near its muzzle anchor. See the bands'
  // construction comment above for why the anchor end is fixed and the tail end is what moves.
  const BAND_SHORT = 0.26, BAND_LONG = 0.6;
  const BAND_RADIUS_RELAXED = 0.015, BAND_RADIUS_DRAWN = 0.008;

  function update(dt: number, reloadFrac: number, speared: boolean, speed = 0): void {
    const frac = clamp(reloadFrac, 0, 1);
    loadedShaft.visible = !speared;
    // fully loaded: tip sits just past the muzzle ring; fully empty: tip withdrawn to the muzzle.
    loadedShaft.position.z = -BARREL_LEN - SHAFT_POKE * 0.5 * frac;

    const bandLen = lerp(BAND_SHORT, BAND_LONG, frac);
    const bandRadius = lerp(BAND_RADIUS_RELAXED, BAND_RADIUS_DRAWN, frac);
    for (const band of bands) {
      band.scale.set(bandRadius, bandRadius, bandLen);
      band.position.z = BAND_ANCHOR_Z - bandLen / 2;
    }

    // The reload just completed this frame — a reloading act should have a felt "seated" moment,
    // not just a timer running out silently. `debugForceReloadReady` (index.ts) also crosses this
    // same 1.0 threshold, so a verification script sees the same visual beat a real reload does.
    if (prevFrac < 1 && frac >= 1) seatT = 1;
    prevFrac = frac;

    if (kickT > 0) {
      kickT = Math.max(0, kickT - dt / 0.22);
      // Sharper near the start of the impulse than a plain sine — a band snapping forward is a
      // snap, not a smooth swing: squaring the envelope front-loads the motion into the first
      // third of the recovery.
      const envelope = Math.sin(kickT * Math.PI);
      const snap = envelope * envelope;
      base.position.z = -0.62 + 0.1 * snap;
      base.rotation.x = -0.04 - 0.16 * snap; // muzzle rise
      base.rotation.y = kickYaw * snap;
      base.rotation.z = kickRoll * snap;
    } else {
      base.position.z = lerp(base.position.z, -0.62, Math.min(1, dt * 10));
      base.rotation.x = lerp(base.rotation.x, -0.04, Math.min(1, dt * 10));
      base.rotation.y = lerp(base.rotation.y, 0, Math.min(1, dt * 8));
      base.rotation.z = lerp(base.rotation.z, 0, Math.min(1, dt * 8));
    }

    if (seatT > 0) {
      seatT = Math.max(0, seatT - dt / 0.12);
      loadedShaft.position.z += 0.012 * Math.sin(seatT * Math.PI);
    }

    // Idle sway: a slow fin-kick-paced bob at rest (treading water), widening and quickening with
    // swim speed — capped so sprinting doesn't fling the gun out of frame.
    swayT += dt * (1 + Math.min(1, speed / 2) * 1.6);
    const amt = 0.012 + Math.min(1, speed / 2.2) * 0.02;
    swaySway.set(Math.sin(swayT * 1.1) * amt, Math.sin(swayT * 1.7 + 1.3) * amt * 0.7, 0);
    group.position.lerp(swaySway, Math.min(1, dt * 8));
    group.rotation.z = Math.sin(swayT * 1.1) * amt * 0.6;
    group.rotation.x = Math.sin(swayT * 1.7 + 1.3) * amt * 0.4;
  }

  /** `kick()` fires the recoil impulse (see `update`'s `kickT` ramp) — purely cosmetic, same
   * status as the rest of this view model (this module's own header), so the fresh per-shot
   * jitter below is plain `Math.random()` rather than a seeded `Rng`: nothing here feeds back
   * into `sim/spear.ts`'s aim or hit test, it only decides which way *this model* wobbles. */
  function kick(): void {
    kickT = 1;
    kickYaw = (Math.random() - 0.5) * 0.05;
    kickRoll = (Math.random() - 0.5) * 0.07;
  }

  function dispose(): void { camera.remove(group); }

  return { group, muzzle, update, kick, dispose };
}
