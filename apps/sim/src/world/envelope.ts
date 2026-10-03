/**
 * Envelope validation + position leash — docs/ARCHITECTURE.md's "Authority model" section B:
 * the client simulates and self-reports x/z/h/speed; this module decides whether to trust that
 * report, blend it against the server's shadow model, or reject it outright.
 *
 * Two independent layers, applied in order:
 *  1. Absolute envelope checks (speed cap, position delta, accel, turn rate, landH, depthAt).
 *     Any failure is treated exactly like a hard-leash violation below: the report is rejected
 *     outright this tick.
 *  2. The position leash, measured between the client's report and the server's independently-
 *     stepped shadow: <3 m trust verbatim and resync the shadow to it; 3-12 m trust the report
 *     but pull the shadow 50%/s toward it; >12 m reject and correct from the shadow.
 *
 * `reconcileBoat` never reads or writes y/pitch/roll — those fields don't exist on its inputs or
 * outputs at all, which is what makes "corrections only ever write x, z, h, speed" a property of
 * the type signature rather than something a caller could get wrong.
 */
import { depthAt, landH } from '@keysrun/shared/world/depth';
import type { BoatHull } from '@keysrun/shared/sim/boat';
import { wrapAngle, type ShadowBoatState } from '@keysrun/shared/sim/boat-shadow';
import {
  ENVELOPE_ACCEL_SLACK,
  ENVELOPE_DRAFT_SLACK,
  ENVELOPE_MAX_LAND_H,
  ENVELOPE_POS_DELTA_SLACK,
  ENVELOPE_SPEED_HEADROOM,
  ENVELOPE_TURN_RATE_SLACK,
  ENVELOPE_WAVE_SURGE_MARGIN_MS,
  LEASH_HARD_M,
  LEASH_PULL_RATE_PER_S,
  LEASH_SOFT_M,
} from '../constants.js';
import { SPEED_SCALE } from '@keysrun/shared/content/boats';

export interface EnvelopeInput {
  prevX: number;
  prevZ: number;
  prevH: number;
  prevSpeed: number;
  reportX: number;
  reportZ: number;
  reportH: number;
  reportSpeed: number;
  shadow: ShadowBoatState;
  hull: BoatHull;
  dt: number;
}

export interface EnvelopeOutput {
  x: number;
  z: number;
  h: number;
  speed: number;
  corrected: boolean;
  violated: boolean;
  reason: string | null;
  newShadow: ShadowBoatState;
}

function speedCapFor(hull: BoatHull): number {
  const topMs = hull.top * 0.5144 * SPEED_SCALE;
  return topMs * ENVELOPE_SPEED_HEADROOM + ENVELOPE_WAVE_SURGE_MARGIN_MS;
}

function checkAbsoluteEnvelope(input: EnvelopeInput): string | null {
  const { prevX, prevZ, prevH, prevSpeed, reportX, reportZ, reportH, reportSpeed, hull, dt } = input;
  const speedCap = speedCapFor(hull);

  if (Math.abs(reportSpeed) > speedCap) return 'speed';

  const posDelta = Math.hypot(reportX - prevX, reportZ - prevZ);
  if (posDelta > speedCap * dt * ENVELOPE_POS_DELTA_SLACK) return 'position-delta';

  const accel = Math.abs(reportSpeed - prevSpeed) / dt;
  // Physically-possible accel is bounded by how fast speed can approach a target that is itself
  // capped at speedCap; hull.accel is a rate constant (~0.4-0.6 /s), so a generous bound is the
  // speed cap crossed in a fraction of a second, with slack for a single noisy tick.
  const maxAccel = (speedCap / Math.max(hull.accel, 0.3)) * ENVELOPE_ACCEL_SLACK;
  if (accel > maxAccel) return 'acceleration';

  const turnRate = Math.abs(wrapAngle(reportH - prevH)) / dt;
  const maxTurnRate = hull.turn * 1.4 * ENVELOPE_TURN_RATE_SLACK;
  if (turnRate > maxTurnRate) return 'turn-rate';

  if (landH(reportX, reportZ) > ENVELOPE_MAX_LAND_H) return 'land';
  if (depthAt(reportX, reportZ) < hull.draft - ENVELOPE_DRAFT_SLACK) return 'aground';

  return null;
}

export function reconcileBoat(input: EnvelopeInput): EnvelopeOutput {
  const violation = checkAbsoluteEnvelope(input);
  const { shadow } = input;

  if (violation) {
    return {
      x: shadow.x,
      z: shadow.z,
      h: shadow.h,
      speed: shadow.speed,
      corrected: true,
      violated: true,
      reason: violation,
      newShadow: shadow,
    };
  }

  const dist = Math.hypot(input.reportX - shadow.x, input.reportZ - shadow.z);

  if (dist <= LEASH_SOFT_M) {
    const resynced: ShadowBoatState = { ...shadow, x: input.reportX, z: input.reportZ, h: input.reportH, speed: input.reportSpeed };
    return {
      x: input.reportX,
      z: input.reportZ,
      h: input.reportH,
      speed: input.reportSpeed,
      corrected: false,
      violated: false,
      reason: null,
      newShadow: resynced,
    };
  }

  if (dist <= LEASH_HARD_M) {
    const pull = Math.min(1, LEASH_PULL_RATE_PER_S * input.dt);
    const blended: ShadowBoatState = {
      ...shadow,
      x: shadow.x + (input.reportX - shadow.x) * pull,
      z: shadow.z + (input.reportZ - shadow.z) * pull,
    };
    return {
      x: input.reportX,
      z: input.reportZ,
      h: input.reportH,
      speed: input.reportSpeed,
      corrected: false,
      violated: false,
      reason: null,
      newShadow: blended,
    };
  }

  // Hard leash exceeded: reject the report, correct from the shadow, do not pull the shadow
  // toward a position we just decided not to trust.
  return {
    x: shadow.x,
    z: shadow.z,
    h: shadow.h,
    speed: shadow.speed,
    corrected: true,
    violated: true,
    reason: 'leash',
    newShadow: shadow,
  };
}
