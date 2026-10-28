/**
 * Engine RPM: one model, read by both the ear and the eye.
 *
 * The revs were worked out inside `audio/engine.ts` and used only to drive the synth. The dash
 * needs the same number — a tachometer that disagrees with the engine note is worse than no
 * tachometer — and it has to keep working with the sound muted or before the AudioContext has
 * been allowed to start. So the model lives here, pure, and both sides step their own copy of it
 * from the same boat state.
 *
 * It is not a torque curve. RPM follows the throttle, climbs a little further as the boat comes
 * onto plane at a fixed lever (the prop unloads), rises with trim out, and flares when the prop
 * ventilates in a turn or over a wake. That is the behaviour you can hear, which is the point.
 */

/** Mercury Racing 450R: idles at 700, redlines at 6400. Every boat in the game runs these. */
export const IDLE_RPM = 700;
export const MAX_RPM = 6400;
/** Where the band on the dial goes red. */
export const REDLINE_RPM = 6000;

export interface TachInputs {
  /** Throttle lever, -1..1. Negative is astern. */
  throttle: number;
  /** |speed| / top speed, 0..1 — how far the prop has unloaded. */
  speedFrac: number;
  /** Trim, 0..1. */
  trimV: number;
  /** How hard the prop is ventilating, 0..1. */
  trimVent: number;
  /** Blip on engaging gear, 0..1. */
  gearRev: number;
}

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** Where the revs are heading right now. */
export function rpmTarget(i: TachInputs, idle = IDLE_RPM, max = MAX_RPM): number {
  const thr = Math.abs(i.throttle);
  const f = clamp(i.speedFrac, 0, 1);
  const span = max - idle;
  let target = idle + span * clamp(thr * 0.82 + f * 0.25 + (i.trimV - 0.4) * 0.08 * thr + i.trimVent * 0.22, 0, 1.1);
  // Astern is a quarter of the band however hard you pull the lever back.
  if (i.throttle < 0) target = idle + span * 0.25 * (thr / 0.35);
  if (i.gearRev > 0.01) target = Math.max(target, idle + span * 0.72 * i.gearRev);
  // A ventilating prop has nothing to push against, so the revs run away.
  if (i.trimVent > 0.01) target = Math.min(max * 1.12, target * 1.18);
  return target;
}

/** One step towards `target`. Falls slower than it climbs, as a big V8 does. */
export function stepRpm(rpm: number, target: number, dt: number): number {
  return rpm + (target - rpm) * Math.min(1, dt * (target > rpm ? 2.6 : 1.6));
}
