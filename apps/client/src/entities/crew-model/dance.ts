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
   * index.ts's spawnFigure. This module only ever touches its `.rotation` (the lean overlay);
   * position/scale are the placement's, untouched here. */
  object: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  /** The placement slot's resting yaw (`FigureSlot.rotationY`), captured once at spawn since this
   * module overwrites `.rotation` wholesale each frame (to add the lean's X/Z without drifting). */
  restRotY: number;
  /** Smoothed 0..1 "how much is the dance actually playing" — see this module's header. */
  drive: number;
}

export function createAnimatedFigure(object: THREE.Object3D, mixer: THREE.AnimationMixer, action: THREE.AnimationAction, restRotY: number): AnimatedFigure {
  return { object, mixer, action, restRotY, drive: 0 };
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

export function updateFigure(f: AnimatedFigure, simTime: number, dt: number, motion: CrewMotionInput, beat: BeatSource): void {
  const behavior = behaviorFor(motion, beat);
  const targetDrive = behavior === 'dancing' ? 1 : 0;
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
}
