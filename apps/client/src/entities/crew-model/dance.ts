/**
 * Drives each cloned crew figure's `THREE.AnimationMixer` (the "Hip Hop Dancing" clip baked onto
 * Mixamo's `mixamorig:` skeleton — see asset.ts) plus a small lean/brace overlay on the figure's
 * own root transform, picking one of three behaviours every frame from the boat's own state and
 * the radio's tempo (`beat.ts`):
 *
 *  - **Dancing** — boat slow/stopped, music on: the clip plays, tempo-scaled to the radio's bpm.
 *  - **Hanging on** — boat running fast (or airborne): the clip's progress eases to a stop (not a
 *    hard pause — see `DRIVE_SMOOTH_RATE`) and a lean proportional to the current steering input
 *    braces into turns, same `fast` threshold `entities/life/deck-party.ts` (feat/audio-life,
 *    unmerged) uses for its own "hang on in silence" state.
 *  - **Idle** — boat slow/stopped, music off (unreachable with `beat.ts`'s fallback, which is
 *    always "on" — this exists for when the real `MusicController` is wired in and the radio is
 *    off): the clip likewise eases to a stop, with a gentle independent weight-shift sway instead
 *    of a turn-lean, per the brief's "subtle weight shifts, not frozen."
 *
 * All three states share one continuous "drive" scalar (0 = fully stopped, 1 = fully dancing)
 * that eases toward whichever the current behaviour wants, rather than snapping — this is what
 * keeps a sudden speed-up from freeze-framing mid-move and keeps the lean overlay from fighting a
 * clip that's still mid-transition. Swapping in a different clip, or driving several mixers per
 * figure (blended by `drive`) is a localized change here; nothing in index.ts or placements.ts
 * needs to know how the pose is produced.
 */
import * as THREE from 'three';
import { clamp } from '../../core/math.js';
import type { BeatSource } from './beat.js';
import { applySeaLegs, createSeaLegsRig, createSeaLegsState, type SeaLegsRig, type SeaLegsState } from './sea-legs.js';

export type CrewBehavior = 'dancing' | 'hanging-on' | 'idle';

/** Everything the dance driver needs from the boat each frame — deliberately just these three
 * primitive fields (not the whole `BoatState`) so this module stays decoupled from
 * `@keysrun/shared/sim/boat`'s shape. */
export interface CrewMotionInput {
  /** Signed boat speed, m/s (BoatState.speed). */
  speed: number;
  /** Current steering input, -1..1 (BoatState.steer) — used only as a lean-into-the-turn cue
   * while hanging on, not as a true heading-rate; see index.ts's call site for why. */
  steer: number;
  /** Airborne (BoatState.air) — treated the same as "running fast": no dancing. */
  air: boolean;
}

export interface AnimatedFigure {
  /** The SkeletonUtils-cloned figure's root — already positioned at its placement slot by
   * index.ts's spawnFigure. This module sets its `.rotation` (the lean overlay); sea-legs.ts
   * lowers its `.position.y` while the knees are bent. Scale is the placement's, untouched. */
  object: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  /** The placement slot's resting yaw (`FigureSlot.rotationY`), captured once at spawn since this
   * module overwrites `.rotation` wholesale each frame (to add the lean's X/Z without drifting). */
  restRotY: number;
  /** Smoothed 0..1 "how much is the dance actually playing" — see this module's header. */
  drive: number;
  /** The body's response to the deck moving under it — see sea-legs.ts. */
  seaLegs: SeaLegsRig;
  seaLegsState: SeaLegsState;
  /** Seconds of celebration left. Set by `startCheer`; counts down in `updateFigure`. */
  cheerLeft: number;
  /** Total length of the cheer that is running, so the envelope knows where it is in it. */
  cheerSpan: number;
  /** Smoothed 0..1 hands-up amount actually applied, so the arms rise and fall instead of
   * snapping to and from overhead. */
  cheer: number;
}

/** Call after `object` is at its slot position — sea-legs.ts keeps its feet on that deck height. */
export function createAnimatedFigure(object: THREE.Object3D, mixer: THREE.AnimationMixer, action: THREE.AnimationAction, restRotY: number): AnimatedFigure {
  return {
    object, mixer, action, restRotY, drive: 0,
    seaLegs: createSeaLegsRig(object), seaLegsState: createSeaLegsState(),
    cheerLeft: 0, cheerSpan: 0, cheer: 0,
  };
}

// Same "fast" threshold entities/life/deck-party.ts (feat/audio-life) uses for its own party —
// kept numerically identical on purpose so the whole game's crew agrees on what "running" means.
const HANG_ON_SPEED_MS = 6;
// 1/s — how fast `drive` eases toward its target. ~0.3s to fully stop/resume.
const DRIVE_SMOOTH_RATE = 3.5;
// The clip plays at its authored (Mixamo-recorded) speed when bpm == this — matches
// MusicController's own "radio off" fallback bpm, so idle/fallback playback never looks
// unnaturally fast or slow relative to what the real audio system will eventually drive.
const REFERENCE_BPM = 100;
// rad — lean-into-the-turn amplitude at full lock while hanging on.
const HANG_LEAN_MAX = 0.22;
// Idle weight-shift: slow, independent of any beat (there's no beat to follow with the radio
// off), just enough motion that a stopped boat's crew doesn't read as frozen statues.
const IDLE_SWAY_PERIOD_S = 4.3;
const IDLE_SWAY_AMPLITUDE_RAD = 0.035;

function behaviorFor(motion: CrewMotionInput, beat: BeatSource): CrewBehavior {
  if (Math.abs(motion.speed) > HANG_ON_SPEED_MS || motion.air) return 'hanging-on';
  return beat.isPlaying() ? 'dancing' : 'idle';
}

/**
 * Put this figure's hands up for `seconds`. Used when the deck has something to celebrate — see
 * index.ts's `cheer`. Re-calling it restarts the cheer rather than extending it, so a second
 * reason to celebrate reads as a fresh one.
 */
export function startCheer(f: AnimatedFigure, seconds: number): void {
  f.cheerLeft = seconds;
  f.cheerSpan = seconds;
}

/** Seconds the arms take to go up, and to come back down. Up is quicker: a cheer is a reaction. */
const CHEER_RISE_S = 0.22, CHEER_FALL_S = 0.75;

export function updateFigure(f: AnimatedFigure, simTime: number, dt: number, motion: CrewMotionInput, beat: BeatSource): void {
  const behavior = behaviorFor(motion, beat);
  // A celebrating deck dances, whatever the boat is doing — that is the point of celebrating.
  const targetDrive = behavior === 'dancing' || f.cheerLeft > 0 ? 1 : 0;
  f.drive += (targetDrive - f.drive) * Math.min(1, dt * DRIVE_SMOOTH_RATE);

  // Ease timeScale to/from 0 instead of toggling `action.paused` — the action keeps its `.time`
  // either way, but easing avoids a hard, visible freeze-frame snap the instant the boat crosses
  // the speed threshold, and resuming continues the clip rather than restarting it.
  f.mixer.timeScale = f.drive * (beat.bpm() / REFERENCE_BPM);
  f.mixer.update(dt);

  // Lean/brace overlay. A skeletal clip alone never reacts to the boat's own motion, so this is
  // what actually sells "hanging on" (brace into the turn) and "idle" (not a frozen statue) — it
  // fades out as `drive` fades in so it never fights the dance pose mid-transition.
  let lean = 0;
  if (behavior === 'hanging-on') {
    lean = clamp(motion.steer, -1, 1) * HANG_LEAN_MAX * (1 - f.drive);
  } else if (behavior === 'idle') {
    lean = Math.sin((2 * Math.PI * simTime) / IDLE_SWAY_PERIOD_S) * IDLE_SWAY_AMPLITUDE_RAD * (1 - f.drive);
  }
  f.object.rotation.set(0, f.restRotY, lean, 'YXZ');

  // Whatever the clip is doing, the deck is still moving under it: balance, knees and the soft
  // secondary motion go on top (sea-legs.ts). The clip drives the arms hard mid-dance, so the
  // arms' share of that eases off as the dance comes in.
  // Hands up, if there is something to cheer. The envelope is asymmetric (see CHEER_RISE_S):
  // arms snap up and come down slowly, which is what a real celebration looks like and what
  // keeps a short cheer from reading as a twitch.
  if (f.cheerLeft > 0) {
    f.cheerLeft = Math.max(0, f.cheerLeft - dt);
    const elapsed = f.cheerSpan - f.cheerLeft;
    const target = Math.min(1, elapsed / CHEER_RISE_S) * Math.min(1, f.cheerLeft / CHEER_FALL_S);
    f.cheer += (target - f.cheer) * Math.min(1, dt * 14);
  } else if (f.cheer > 0.001) {
    f.cheer += (0 - f.cheer) * Math.min(1, dt * 6);
  } else {
    f.cheer = 0;
  }
  applySeaLegs(f.seaLegs, f.seaLegsState, f.restRotY, dt, 1 - 0.6 * f.drive, f.cheer);
}

// ---------------------------------------------------------------------------------------------
// A figure on solid ground (the Pink Flamingo's stage dancers).
//
// DECISION: sea-legs is OFF here, not fed a still parent. `applySeaLegs` is the body's answer to a
// deck accelerating under its feet; a club floor never does, so with a still parent it would
// finite-difference a zero acceleration every frame and write no-op rotations onto bones for
// nothing. It also looks bones up by Mixamo's `mixamorig:` names, which one of the two dancers
// (annie, a VRM-style `J_Bip_*` skeleton) does not have. Likewise the boat's lean/brace overlay
// and its hanging-on state are about boat speed and steering and are dropped: a stage dancer is
// either dancing or, with the music off, held. So this is just the clip, tempo-scaled, on the
// figure's own root, which the caller owns (position, yaw, scale).
// ---------------------------------------------------------------------------------------------

export interface StageFigure {
  object: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  /** Smoothed 0..1, same meaning as `AnimatedFigure.drive`. */
  drive: number;
}

/** `object` must be a `SkeletonUtils.clone` of the template (never `.clone()`), already placed. `startFraction`
 * (0..1) offsets the clip so two dancers are never in lockstep. */
export function createStageFigure(object: THREE.Object3D, clip: THREE.AnimationClip, startFraction: number): StageFigure {
  const mixer = new THREE.AnimationMixer(object);
  const action = mixer.clipAction(clip);
  action.play();
  action.time = clip.duration * (startFraction - Math.floor(startFraction));
  mixer.update(0); // pose it now, do not pop in as a T-pose for a frame
  return { object, mixer, action, drive: 1 };
}

export function updateStageFigure(f: StageFigure, dt: number, beat: BeatSource): void {
  const target = beat.isPlaying() ? 1 : 0;
  f.drive += (target - f.drive) * Math.min(1, dt * DRIVE_SMOOTH_RATE);
  f.mixer.timeScale = f.drive * (beat.bpm() / REFERENCE_BPM);
  f.mixer.update(dt);
}
