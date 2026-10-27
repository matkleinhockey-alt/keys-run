/**
 * The fish cam: a two-second cut to the water the moment a fish is on.
 *
 * ## When it fires, and why not earlier
 *
 * On the HOOKSET, not on the bite. The bite is the middle of the strike window — the one moment
 * in rod fishing where the player is doing something with timing — and taking the camera off them
 * there would be the game sabotaging the only skill check it has. By the hookset the fish is on,
 * the input that mattered has happened, and a cut is drama rather than interference. A trolling
 * strike has no window at all (the fish hooks itself at seven knots), so there it fires on the
 * strike, which is the same instant.
 *
 * ## Making it read as footage rather than a camera move
 *
 * Four things, and they are all about the camera being a physical object in the water:
 *
 *  - It sits LOW and looks slightly UP, so the surface is in frame. Underwater footage without
 *    the surface in it has no up, and a shot with no up reads as a tech demo.
 *  - It DOLLIES rather than cutting — a slow arc around the fish with a push in, so the
 *    parallax tells you how big the thing is. A static underwater shot of a fish is a photograph.
 *  - HANDHELD noise on top, two octaves of it, falling off as the shot settles. A perfectly
 *    smooth underwater camera is a drone, and there are no drones down there.
 *  - It EASES in and out over a few tenths rather than cutting hard, because the alternative is
 *    two jump cuts per fish and the player losing which way the boat is pointing.
 *
 * It never lasts long. The fight is the game; this is a beat, not a cutscene, and a camera the
 * player cannot steer has to give the controls back before they notice they have lost them.
 */
import * as THREE from 'three';

/** Seconds the whole shot lasts, including both eases. */
const SHOT_S = 2.3;
/** Seconds of ease at each end. */
const EASE_IN_S = 0.28, EASE_OUT_S = 0.45;
/** Metres: how far the camera starts and ends from the fish. It pushes in across the shot. */
const RANGE_START = 5.6, RANGE_END = 3.1;
/** Radians swung around the fish over the shot — enough for parallax, not a full orbit. */
const ARC = 0.85;

export interface FishCamShot {
  /** Where the fish is right now. Re-read every frame: it is running, and the camera tracks it. */
  fx: number;
  fz: number;
  /** Water surface height at the fish, and the sea floor under it. */
  surfaceY: number;
  floorY: number;
  /**
   * The fish's own height, for a fish that is not where a hooked one always is.
   *
   * A hooked fish rides just under the surface for the whole fight, so the shot below pins
   * itself near the top of the column and never needed to be told. A fish climbing to a trolled
   * lure starts nine metres down — framing the surface filmed nothing but blue water. Omit it
   * and the original surface-hugging framing is used unchanged.
   */
  fy?: number;
  /** The boat. The shot is composed AROUND it — see `apply`. */
  bx: number;
  bz: number;
}

export interface FishCam {
  /**
   * Start a shot on a fish at `(x, z)`. Ignored if one is already running.
   *
   * `holdS` lengthens it, and exists only so a harness can SEE the shot: this sandbox renders at
   * about two frames a second, so the real 2.3 s shot is five frames and a Playwright round trip
   * eats one of them — every screenshot landed after the camera had already been handed back.
   * Nothing in normal play passes it.
   */
  trigger(x: number, z: number, holdS?: number): void;
  /** Advance. Returns true while the camera is being driven by this module. */
  update(dt: number, shot: FishCamShot): boolean;
  /**
   * Place the camera for this frame. Only meaningful while `update` returned true.
   *
   * `blend` is 0..1 — how much of this shot to apply. The caller lerps from wherever the chase
   * rig put the camera, which is what makes the eases eases rather than cuts.
   */
  apply(camera: THREE.PerspectiveCamera, shot: FishCamShot): void;
  active(): boolean;
  cancel(): void;
  debug(): { active: boolean; t: number; blend: number };
}

export function createFishCam(): FishCam {
  let t = -1;              // seconds into the shot, or <0 when idle
  let seed = 0;            // per-shot, so two fish in a row are not the same camera move
  let side = 1;            // which way it arcs
  let blend = 0;
  /** This shot's length — `SHOT_S` in play; see `trigger`'s `holdS`. */
  let shotS = SHOT_S;
  const from = new THREE.Vector3();
  const look = new THREE.Vector3();
  const pos = new THREE.Vector3();

  /** Smoothstep — the ease on both ends. */
  const ss = (x: number): number => { const k = Math.max(0, Math.min(1, x)); return k * k * (3 - 2 * k); };

  return {
    trigger(x, z, holdS) {
      if (t >= 0) return;
      t = 0; blend = 0; shotS = holdS && holdS > 0 ? holdS : SHOT_S;
      seed = Math.random() * 1000;
      side = Math.random() < 0.5 ? -1 : 1;
      from.set(x, 0, z);
    },
    update(dt, shot) {
      if (t < 0) return false;
      t += dt;
      if (t >= shotS) { t = -1; blend = 0; return false; }
      // Ease in, hold, ease out. Separate ends because the cut away from the fight wants to be
      // quicker than the cut back to it — you want to arrive at the fish, and you want to be
      // handed the boat back gently.
      blend = Math.min(ss(t / EASE_IN_S), ss((shotS - t) / EASE_OUT_S));
      void shot;
      return true;
    },
    apply(camera, shot) {
      const k = Math.min(1, t / shotS);
      // Track the fish: it is running, and a camera that stayed where the bait was would be
      // filming empty water within a second.
      look.set(shot.fx, 0, shot.fz);
      // Low in the column, looking a little up so the surface is in frame — but never below the
      // sea floor, which in six feet of backcountry is a real constraint rather than a nicety.
      const lo = shot.floorY + 0.7, hi = shot.surfaceY - 0.5;
      let deep: number;
      if (shot.fy === undefined) {
        deep = Math.max(lo, shot.surfaceY - 1.9);
        look.y = Math.min(hi, deep + 0.6);
      } else {
        // Told where the fish is: look straight at it and sit a little under it, so a fish on its
        // way up is climbing across frame with the surface above it rather than away from a
        // camera parked at the top of the water.
        look.y = Math.min(hi, Math.max(lo, shot.fy));
        deep = Math.min(hi, Math.max(lo, shot.fy - 0.9));
      }

      // Composed around the BOAT, not around wherever the bait happened to be when it was eaten.
      // The camera sits on the far side of the fish from the hull and looks back along the line,
      // so the fish is between the lens and open water with the boat behind it. The first version
      // placed it on the bait's own bearing and the fight promptly dragged the fish back under
      // the transom — every shot came out as a close-up of the hull with the fish somewhere off
      // frame. Swinging through `ARC` around that bearing keeps the parallax.
      let ax = look.x - shot.bx, az = look.z - shot.bz;
      const al = Math.hypot(ax, az);
      if (al < 0.5) { ax = look.x - from.x; az = look.z - from.z; }       // fish on top of the boat
      const base = Math.atan2(ax, az) || 0;
      const ang = base + side * (ARC * (k - 0.5));
      const range = RANGE_START + (RANGE_END - RANGE_START) * ss(k);
      pos.set(look.x + Math.sin(ang) * range, deep, look.z + Math.cos(ang) * range);

      // Handheld. Two octaves, the fast one fading as the shot settles — a camera being carried
      // by water, not flown.
      const n = (f: number, p: number): number => Math.sin(t * f + seed + p);
      const jitter = 0.14 * (1 - 0.6 * k);
      pos.x += n(2.1, 0) * jitter + n(5.7, 1.1) * jitter * 0.4;
      pos.y += n(1.7, 2.0) * jitter * 0.8 + n(6.3, 0.4) * jitter * 0.3;
      pos.z += n(1.9, 4.0) * jitter + n(5.1, 2.6) * jitter * 0.4;

      // Blend from wherever the chase rig left the camera this frame.
      camera.position.lerp(pos, blend);
      const was = camera.quaternion.clone();
      camera.lookAt(look);
      camera.quaternion.slerp(was, 1 - blend);
      camera.updateMatrixWorld(true);
    },
    active: () => t >= 0,
    cancel() { t = -1; blend = 0; },
    debug: () => ({ active: t >= 0, t: +Math.max(0, t).toFixed(2), blend: +blend.toFixed(3) }),
  };
}
