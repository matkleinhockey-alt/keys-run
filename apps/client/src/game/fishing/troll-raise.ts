/**
 * Raising a fish: the few seconds between something deciding to eat and it getting there.
 *
 * "Raise" is the word for it offshore — you raise a fish on a bait, and whether it eats is a
 * separate question. Trolling had no such moment: the clock ran out and a fish was simply on,
 * announced by a splash and a toast. The whole appeal of dragging lures at seven knots is
 * watching something come up behind one, so this is that: a shape that lifts out of the blue,
 * tracks the lure as the boat pulls it away, lights up, pushes a boil onto the surface, and
 * takes it.
 *
 * ## It is cosmetic, and deliberately so
 *
 * Nothing here decides anything. `game/fishing/trolling.ts` has already rolled the species and
 * the weight by the time `begin` is called, and it hooks the fish when the raise finishes
 * whatever this draws. So a dropped frame, a camera pointed the wrong way or a `dispose` mid-rise
 * costs the player nothing — the hookup is on trolling.ts's clock, not on this animation. That
 * also keeps the sim pure: no shared-package code knows this exists.
 *
 * ## Why it tracks a real lure
 *
 * `lureFor(station)` is resolved every frame from the live spread (`troll-spread.ts`) rather than
 * captured once at `begin`. The boat is making seven knots through the whole raise, usually in a
 * turn, and the lure is skipping on its own beat 20-34 m astern. A fish climbing to a point
 * recorded 1.6 s ago would surface in open water a boat-length behind the bait.
 */
import * as THREE from 'three';
import { makeFishMesh } from './fish-mesh.js';
import { clamp, lerp } from '../../core/math.js';

/** Seconds from first showing to the eat. Long enough to see it coming and turn the camera, short
 * enough that the strike still arrives at speed rather than being queued. */
export const RAISE_S = 1.6;

/** How far down it starts, metres. Deep enough to be a shadow rather than a fish at first. */
const START_DEPTH = 9;

/** How far astern of the lure it starts, metres — a fish runs it down from behind and below. */
const START_BACK = 7;

export interface TrollRaise {
  /** A fish is coming up on lure `station`. `color` and `lenM` are the ones already rolled. */
  begin(color: string, lenM: number, station: number): void;
  /** True while a fish is on its way up. */
  active(): boolean;
  /**
   * One frame. `u` is how far through the raise we are, 0..1, or negative when no fish is coming
   * up — and it comes from `trolling.ts`'s own countdown rather than being timed here.
   *
   * That matters: the hookup fires on the SIM clock (a fixed 30 Hz accumulator) and rendering
   * runs on the render clock. Timing this animation separately let the two drift — in a sandbox
   * running the sim well behind real time the fish arrived at the lure and then sat on it,
   * visibly waiting, until the sim caught up. One clock, owned by the module that decides the
   * outcome, and the fish gets there exactly when it eats.
   *
   * `lureFor` gives the live world position of a station (false if the spread is stowed),
   * `waterAt` the surface height at a point. Both are passed in rather than captured so this
   * module owns no world references and can be disposed independently.
   */
  update(t: number, u: number, lureFor: (station: number, out: THREE.Vector3) => boolean, waterAt: (x: number, z: number) => number): void;
  /** Take it away now — the eat landed, or the player brought the lines in. */
  end(): void;
  /** VERIFICATION ONLY: where the fish is, and how far it still has to go. */
  debug(): { active: boolean; u: number; x: number; y: number; z: number; depth: number; toLure: number };
  dispose(): void;
}

export function createTrollRaise(scene: THREE.Scene): TrollRaise {
  let mesh: THREE.Group | null = null;
  let station = 0;
  let lastU = 0;
  let running = false;

  // The boil: the patch of water a fish pushes up ahead of itself as it comes shallow. A flat
  // disc that swells and fades, which at the 20-34 m the spread sits astern is all the surface
  // disturbance reads as anyway.
  const boilGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
  const boilMat = new THREE.MeshBasicMaterial({ color: 0xcfe8e4, transparent: true, opacity: 0, depthWrite: false });
  const boil = new THREE.Mesh(boilGeo, boilMat);
  boil.renderOrder = 2;
  boil.visible = false;
  scene.add(boil);

  const _lure = new THREE.Vector3();

  function clear(): void {
    if (mesh) { scene.remove(mesh); mesh = null; }
    boil.visible = false;
    boilMat.opacity = 0;
    running = false;
    lastU = 0;
  }

  return {
    begin(color, lenM, st) {
      clear();
      station = st;
      // Big fish are the ones worth watching come up, so the mesh is the real rolled length.
      mesh = makeFishMesh(color, lenM);
      scene.add(mesh);
      running = true;
      lastU = 0;
    },

    active: () => running,

    update(t, rawU, lureFor, waterAt) {
      if (!running || !mesh) return;
      if (rawU < 0) { clear(); return; }
      const u = clamp(rawU, 0, 1);
      lastU = u;

      if (!lureFor(station, _lure)) { clear(); return; }

      // A fish does not drift up, it winds up and accelerates: cubic ease-in, so the first half
      // of the raise covers a quarter of the distance and the last moment is a lunge.
      const k = u * u * u;
      const depth = START_DEPTH * (1 - k);
      const back = START_BACK * (1 - k);

      // Astern of the lure along the lure's own line of travel. The spread is dragged, so the
      // direction from the boat to the lure IS that line to within the slew of a turn.
      const water = waterAt(_lure.x, _lure.z);
      const fx = mesh.position.x - _lure.x, fz = mesh.position.z - _lure.z;
      const d = Math.hypot(fx, fz);
      // First frame there is no previous position to take a heading from; come up from dead
      // astern of the boat's wake instead, which is where the lure has just been.
      const ux = d > 0.05 ? fx / d : 0, uz = d > 0.05 ? fz / d : 1;

      const x = _lure.x + ux * back;
      const z = _lure.z + uz * back;
      const y = water - depth - 0.25;
      mesh.position.set(x, y, z);

      // Nose at the lure, climbing: yaw onto it, pitch up by however steep the climb is.
      mesh.rotation.set(0, 0, 0, 'YXZ');
      mesh.rotation.y = Math.atan2(_lure.x - x, _lure.z - z);
      mesh.rotation.x = -Math.atan2(depth, Math.max(0.5, back)) * 0.8;
      // Lit up and tracking: a fish on a bait rolls onto it rather than swimming dead level.
      mesh.rotation.z = Math.sin(t * 9) * 0.12 * u;

      // The boil only exists once it is shallow enough to move water, and it sits over the fish
      // rather than over the lure — that offset is the tell that something is behind the bait.
      const shallow = clamp(1 - depth / 3.2, 0, 1);
      boil.visible = shallow > 0.01;
      if (boil.visible) {
        boil.position.set(x, water + 0.03, z);
        const r = lerp(0.6, 2.4, shallow);
        boil.scale.set(r, 1, r);
        boilMat.opacity = 0.34 * shallow * shallow;
      }
    },

    end: clear,

    debug() {
      if (!running || !mesh) return { active: false, u: 0, x: 0, y: 0, z: 0, depth: 0, toLure: 0 };
      const d = Math.hypot(mesh.position.x - _lure.x, mesh.position.z - _lure.z);
      return {
        active: true,
        u: +lastU.toFixed(3),
        x: +mesh.position.x.toFixed(2), y: +mesh.position.y.toFixed(2), z: +mesh.position.z.toFixed(2),
        depth: +(_lure.y - mesh.position.y).toFixed(2),
        toLure: +d.toFixed(2),
      };
    },

    dispose() {
      clear();
      scene.remove(boil);
      boilGeo.dispose();
      boilMat.dispose();
    },
  };
}
