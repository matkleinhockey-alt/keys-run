/**
 * The rod in the walking body's hands, for fishing off a pier or a dock in the land camera's
 * third-person view (first person uses the same camera-space rod the boat does, rod-viewmodel.ts).
 *
 * It is the boat's rod rig without the boat: a `rodPivot` group, which is all rod-bend.ts's
 * `worldRodFor` needs to grow the same flexing eight-segment blank on it, so the bend under load,
 * the kick on a head shake and the whip-back when the hook pulls are the boat rod's, not a copy.
 * The pivot rides on the body (`Human.group`), held at the hip, and the hands are posed onto the
 * grip every frame after the walking gait has posed them swinging.
 *
 * The body also turns to face its line. The walker's own yaw only changes while walking, and the
 * walker stands still with a line out (shore.ts's `shoreHoldsStill`) — without this an angler who
 * cast over their shoulder would fish with the rod pointing out of their back.
 */
import * as THREE from 'three';
import type { Human } from '../../entities/life/human.js';
import { clamp } from '../../core/math.js';

export interface ShoreRod {
  /** The pivot `worldRodFor` grows the blank on. Parented to the body once there is one. */
  rodPivot: THREE.Group;
  /**
   * Once per frame, after the land facade has posed the walking gait and before the line is drawn
   * from the tip: turn the body toward `target` (world; null = leave its facing alone), point the
   * rod at it, and put the hands on the grip. `fight` raises the rod against the fish.
   */
  hold(body: Human, target: THREE.Vector3 | null, fight: boolean, tension: number, dt: number): void;
}

/** Where the butt sits in the body's frame (forward is +z — see entities/land/index.ts). */
const BUTT = new THREE.Vector3(0.12, 0.14, 0.16);
/** Along the blank, metres from the butt: the reel hand and the fore-grip hand. */
const REEL_S = 0.02, FORE_S = 0.2;
/**
 * How the rod is held, as tilts from vertical (`rodPivot.rotation.x` is minus this). Waiting on a
 * float the tip sits low and out over the water, about 25 degrees above level; with a fish on, it
 * comes UP — an angler fights from the rod's bend, high, and lowers it only to wind — and comes a
 * little higher still the harder the fish pulls. The first version had both backwards and both
 * near vertical: from the chase camera behind the angler a 3 m blank pointing away and 45 degrees
 * up foreshortens to an upright stick.
 */
const TILT_WAIT = 1.15, TILT_FIGHT = 0.9, TILT_LOAD = 0.2;
/** The rod is carried off to the reel-hand side rather than straight down the angler's nose: it is
 * how a rod is held, and it is what lets the chase camera see the blank and the line clear of the
 * body instead of hidden behind it. Radians of yaw, toward the butt's side (+x). */
const SIDE = 0.32;

const angDiff = (a: number, b: number): number => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;

export function createShoreRod(): ShoreRod {
  const rodPivot = new THREE.Group();
  rodPivot.name = 'shoreRod';
  rodPivot.rotation.order = 'YXZ';
  rodPivot.visible = false;
  // Grip and reel only: the blank itself is worldRodFor's, grown on first use.
  const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.42, 8).translate(0, 0.12, 0), new THREE.MeshStandardMaterial({ color: 0xb8925e, roughness: 0.9 }));
  rodPivot.add(cork);
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 12), new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.7 }));
  reel.rotation.z = Math.PI / 2;
  reel.position.set(0, 0.06, -0.07);
  rodPivot.add(reel);

  const local = new THREE.Vector3(), hA = new THREE.Vector3(), hB = new THREE.Vector3();
  let facing: number | null = null;

  function hold(body: Human, target: THREE.Vector3 | null, fight: boolean, tension: number, dt: number): void {
    if (rodPivot.parent !== body.group) body.group.add(rodPivot);
    const g = body.group;
    if (target) {
      // Face the line. Eased, so a running fish swings the angler round rather than snapping them.
      const want = Math.atan2(-(target.x - g.position.x), -(target.z - g.position.z)) + Math.PI;
      facing = facing === null ? g.rotation.y : facing + angDiff(facing, want) * Math.min(1, dt * 4);
      g.rotation.y = facing;
    } else facing = null;
    g.updateMatrixWorld(true);

    rodPivot.position.set(BUTT.x, body.hipY + BUTT.y, BUTT.z);
    // Rod yaw in the body's frame, same convention as visuals.ts's `aimRod`: 0 points the blank
    // at -z, so straight ahead (+z) is PI. Kept within a comfortable swing either side of ahead.
    let yaw = Math.PI;
    if (target) {
      local.copy(target);
      g.worldToLocal(local);
      const a = Math.atan2(-(local.x - rodPivot.position.x), -(local.z - rodPivot.position.z));
      yaw = Math.PI + clamp(angDiff(Math.PI, a), -0.9, 0.9);
    }
    rodPivot.rotation.y = yaw + SIDE;
    rodPivot.rotation.x = -(fight ? TILT_FIGHT - clamp(tension, 0, 1) * TILT_LOAD : TILT_WAIT);

    // Hands on the grip: points along the blank's axis, in the body's frame.
    hA.set(0, REEL_S, 0).applyEuler(rodPivot.rotation).add(rodPivot.position);
    hB.set(0, FORE_S, 0).applyEuler(rodPivot.rotation).add(rodPivot.position);
    body.pose(hB, hA);
  }

  return { rodPivot, hold };
}
