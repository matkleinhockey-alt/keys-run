/**
 * First-person boat pistol: a small blocky 9 mm in the right hand, attached to the camera the way
 * entities/speargun/gun-viewmodel.ts attaches the speargun (same reasons: a camera-parented rig is
 * the only way a held object stays put under the diver/boat/wobble camera, and its lighting has to
 * be cheated with a fill light that rides along).
 *
 * It is purely a *reflection* of `sim/handgun.ts`'s GunState - none of this drives the sim. What it
 * animates, and why each one is there:
 *
 *  - **Recoil.** A shot kicks the whole gun back along the line of fire and tips the muzzle up, then
 *    a spring-damper settles it. Rejected: a pure ease-out curve, which reads as a rubber toy; the
 *    little overshoot below the rest pose is what makes it feel like mass coming back to the hand.
 *  - **The slide.** Goes back on every shot (fast, 80 ms) and STAYS back when the magazine is empty
 *    - that locked-back slide is the single clearest "you are out" signal a pistol has, and it
 *    means the player does not need the HUD to know.
 *  - **Reload.** The gun rolls over to the left and tips up so you can see the magazine well, the
 *    empty magazine drops away, a fresh one rises from below and seats with a bump, and if the
 *    gun was empty the slide is racked (back, then released forward). Driven by a 0..1 progress
 *    value taken from the sim's reload clock, so the animation is exactly as long as the reload
 *    and can be cancelled by holstering without ever being out of step.
 *  - **Muzzle flash.** Two crossed additive planes plus a point light for ~60 ms. The point light
 *    is what lights the hand and the slide orange for that instant, which sells it far more than
 *    the sprite does.
 *  - **Idle sway.** Slow breathing drift, because a held thing that is welded to the camera looks
 *    like a UI decal.
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math.js';

export interface PistolView {
  /** 0..1 through the reload that is running, or null when not reloading. */
  reload: number | null;
  /** The running reload started on an empty gun (so the slide gets racked). */
  fromEmpty: boolean;
  /** Empty and not reloading: slide held open. */
  slideLocked: boolean;
}

export interface PistolViewModel {
  group: THREE.Group;
  /** World-space muzzle, the bullet's visual origin. */
  muzzle: THREE.Object3D;
  /** World-space ejection port, where brass leaves. */
  port: THREE.Object3D;
  update(dt: number, view: PistolView, moving: number): void;
  /** Fire the recoil / slide / flash. `heat` (0..1) makes rapid fire climb. */
  kick(heat: number): void;
  /** VERIFICATION-ONLY: keep the muzzle flash lit (it is ~60 ms of sim time, i.e. one frame that a
   * screenshot never lands on at this sandbox's frame rate). */
  holdFlash(v: boolean): void;
  dispose(): void;
}

export function createPistolViewModel(camera: THREE.Camera): PistolViewModel {
  const group = new THREE.Group();
  group.visible = false;
  camera.add(group);

  const base = new THREE.Group();
  // 1.0 reads as a held pistol; the first cut at 0.8 (to stop a reload pose filling the frame) made
  // it a toy in the corner of the screen. The reload pose below is what stays out of the way.
  base.scale.setScalar(1.0);
  group.add(base);

  // Fill light riding with the camera - same trick and same reason as the speargun's (a held object
  // that goes black against a sunlit sea is unreadable), but warm, to sit with the sun.
  const fill = new THREE.PointLight(0xfff0dc, 1.6, 1.6, 2);
  fill.position.set(0.1, 0.12, -0.1);
  group.add(fill);

  const metal = new THREE.MeshStandardMaterial({ color: 0x5b646d, roughness: 0.32, metalness: 0.75 });
  const poly = new THREE.MeshStandardMaterial({ color: 0x2c3136, roughness: 0.7, metalness: 0.1 });
  const sightMat = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.5, emissive: 0x444444 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a27f, roughness: 0.8 });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0xf26b5b, roughness: 0.9 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.9 });

  // --- the gun, built along -Z (the muzzle points away from the viewer), origin at the top of the grip
  const SLIDE_LEN = 0.19;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.024, 0.17), poly);
  frame.position.set(0, -0.004, -0.085);
  base.add(frame);

  const slide = new THREE.Group();
  const slideBody = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.03, SLIDE_LEN), metal);
  slideBody.position.set(0, 0.0, -SLIDE_LEN / 2 + 0.01);
  slide.add(slideBody);
  // serrations: a few thin dark boxes across the back of the slide
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.0355, 0.026, 0.004), poly);
    s.position.set(0, 0, 0.0 - i * 0.008 + 0.002);
    slide.add(s);
  }
  const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.008, 0.006), poly);
  rearSight.position.set(0, 0.019, 0.003);
  slide.add(rearSight);
  const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.01, 0.006), sightMat);
  frontSight.position.set(0, 0.02, -SLIDE_LEN + 0.016);
  slide.add(frontSight);
  const port = new THREE.Object3D();
  port.position.set(0.019, 0.006, -0.05);
  slide.add(port);
  slide.position.set(0, 0.026, 0);
  base.add(slide);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.1, 0.052), poly);
  grip.position.set(0, -0.058, -0.012);
  grip.rotation.x = 0.2;
  base.add(grip);

  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.0035, 5, 10, Math.PI), poly);
  guard.rotation.set(0, Math.PI / 2, Math.PI);
  guard.position.set(0, -0.026, -0.06);
  base.add(guard);
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.02, 0.006), metal);
  trigger.position.set(0, -0.022, -0.056);
  trigger.rotation.x = -0.25;
  base.add(trigger);

  // magazine: rides in the grip, drops out on reload; a fresh one comes up from below
  const MAG_Y = -0.118;
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.027, 0.034, 0.042), metal);
  mag.position.set(0, MAG_Y, -0.004);
  mag.rotation.x = 0.2;
  base.add(mag);
  const freshMag = new THREE.Mesh(new THREE.BoxGeometry(0.027, 0.05, 0.042), metal);
  freshMag.visible = false;
  base.add(freshMag);
  // a visible round on top of the fresh magazine, so "a new mag" reads in a split second
  const topRound = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.01, 6), brass);
  topRound.position.y = 0.03;
  freshMag.add(topRound);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.026, -SLIDE_LEN + 0.004);
  base.add(muzzle);

  // --- the hand that holds it: a fist round the grip, thumb along the frame, forearm to the corner
  const fist = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.06, 0.06), skin);
  fist.position.set(0.004, -0.062, 0.004);
  fist.rotation.x = 0.2;
  base.add(fist);
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.0095, 0.045, 3, 6).rotateX(Math.PI / 2), skin);
  thumb.position.set(-0.024, -0.012, -0.03);
  base.add(thumb);
  const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.2, 4, 8), sleeve);
  forearm.position.set(0.03, -0.17, 0.12);
  forearm.rotation.set(1.15, 0.12, 0.12);
  base.add(forearm);

  // --- muzzle flash: two crossed additive planes (a star from any angle) + a short-lived light
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd48a, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const flash = new THREE.Group();
  const plane = new THREE.PlaneGeometry(0.1, 0.1);
  const p1 = new THREE.Mesh(plane, flashMat);
  const p2 = new THREE.Mesh(plane, flashMat);
  p2.rotation.z = Math.PI / 2;
  flash.add(p1, p2);
  flash.position.set(0, 0, -0.02);
  // Planes face the shooter (a flash seen from behind the gun is a star, not an edge-on sliver; the first
  // version laid them along the line of fire and the flash was invisible in every screenshot).
  const flashHolder = new THREE.Group();
  flashHolder.add(flash);
  muzzle.add(flashHolder);
  flashHolder.visible = false;
  const flashLight = new THREE.PointLight(0xffa850, 0, 3, 2);
  flashLight.position.set(0, 0.03, -0.2);
  base.add(flashLight);

  // --- state ---
  let kickV = 0, kickX = 0;       // spring: position and velocity of the recoil
  let slideT = 0;                 // 1 right after a shot, falling to 0 in ~80 ms
  let flashT = 0;
  let swayT = 0;
  let reloadPose = 0;             // eased 0..1 weight of the reload pose
  let seatT = 0;                  // the bump when the fresh mag seats
  let lastReload: number | null = null;
  let holdFlashOn = false;

  const READY_POS = new THREE.Vector3(0.105, -0.128, -0.31);
  const READY_ROT = new THREE.Euler(0.04, 0.03, 0, 'YXZ');
  const RELOAD_POS = new THREE.Vector3(0.03, -0.1, -0.3);
  const RELOAD_ROT = new THREE.Euler(0.5, 0.34, -0.62, 'YXZ');

  function update(dt: number, v: PistolView, moving: number): void {
    swayT += dt;

    // --- recoil spring (critically-ish damped with a little overshoot)
    const K = 260, C = 19;
    kickV += (-K * kickX - C * kickV) * dt;
    kickX += kickV * dt;
    slideT = Math.max(0, slideT - dt / 0.08);
    if (flashT > 0 || holdFlashOn) {
      flashT -= dt;
      const on = flashT > 0 || holdFlashOn;
      flashHolder.visible = on;
      flashLight.intensity = on ? 7 * (holdFlashOn ? 1 : clamp(flashT / 0.06, 0, 1)) : 0;
      if (on) { flashHolder.rotation.z = Math.random() * Math.PI; flashHolder.scale.setScalar(0.8 + Math.random() * 0.7); }
    }

    // --- reload choreography
    const p = v.reload;
    const want = p === null ? 0 : p < 0.9 ? 1 : 1 - (p - 0.9) / 0.1;
    reloadPose += (want - reloadPose) * Math.min(1, dt * 11);
    let magOut = 0;        // 0 = in the gun .. 1 = fully dropped
    let freshT = -1;       // -1 = not shown, else 0..1 travel from below to seated
    let rack = 0;          // slide drawn back by the off-hand, 0..1
    if (p !== null) {
      magOut = clamp((p - 0.1) / 0.14, 0, 1);
      if (p > 0.34 && p < 0.62) freshT = (p - 0.34) / 0.28;
      if (p >= 0.62) freshT = 1;
      if (lastReload !== null && lastReload < 0.62 && p >= 0.62) seatT = 1;
      if (v.fromEmpty && p > 0.7 && p < 0.92) {
        const q = (p - 0.7) / 0.22;
        // pull back over the first 60%, then let it go with a snap
        rack = q < 0.6 ? q / 0.6 : 1 - (q - 0.6) / 0.4;
      }
    }
    lastReload = p;
    mag.position.y = p !== null && freshT < 1 ? MAG_Y - 0.16 * magOut : MAG_Y;
    // while the old mag is falling it is shown dropping; once clear of the grip it disappears
    mag.visible = p === null || freshT >= 1 || (magOut < 1 && p < 0.34);
    freshMag.visible = freshT >= 0 && freshT < 1;
    if (freshMag.visible) {
      const e = freshT * freshT * (3 - 2 * freshT);
      freshMag.position.set(lerp(-0.045, 0, e), lerp(-0.3, MAG_Y - 0.008, e), lerp(0.09, -0.004, e));
      freshMag.rotation.set(0.2, 0, lerp(0.5, 0, e));
    }
    seatT = Math.max(0, seatT - dt / 0.16);

    // slide: back on a shot, locked open when empty, drawn by the off-hand while racking
    const slideBack = Math.max(slideT * 0.034, v.slideLocked ? 0.032 : 0, rack * 0.034);
    slide.position.z = slideBack;
    trigger.rotation.x = -0.25 + slideT * 0.4;

    // --- pose
    const amt = 0.0035 + Math.min(1, moving / 3) * 0.003;
    const swayX = Math.sin(swayT * 1.1) * amt, swayY = Math.sin(swayT * 1.7 + 1.3) * amt * 0.8;
    const seat = seatT > 0 ? Math.sin(seatT * Math.PI) * 0.012 : 0;
    base.position.set(
      lerp(READY_POS.x, RELOAD_POS.x, reloadPose) + swayX,
      lerp(READY_POS.y, RELOAD_POS.y, reloadPose) + swayY - seat,
      lerp(READY_POS.z, RELOAD_POS.z, reloadPose) + 0.045 * kickX,
    );
    base.rotation.set(
      lerp(READY_ROT.x, RELOAD_ROT.x, reloadPose) + 0.34 * kickX,
      lerp(READY_ROT.y, RELOAD_ROT.y, reloadPose),
      lerp(READY_ROT.z, RELOAD_ROT.z, reloadPose) + swayX * 2,
      'YXZ',
    );
  }

  function kick(heat: number): void {
    // Impulse into the spring; follow-up shots climb a little more (heat) so a string of fast shots
    // walks the muzzle up the way it really does, instead of being N identical bounces.
    kickV += 5.2 + 2.4 * clamp(heat, 0, 1);
    slideT = 1;
    flashT = 0.06;
  }

  function holdFlash(v: boolean): void { holdFlashOn = v; }

  function dispose(): void { camera.remove(group); }

  return { group, muzzle, port, update, kick, holdFlash, dispose };
}
