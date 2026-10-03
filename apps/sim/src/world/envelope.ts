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

  // Asymmetric on purpose: stepBoat's collision response (beaching/piling/dock — see
  // packages/shared/src/sim/boat.ts) *multiplies* speed down by up to 90% in a single tick
  // (e.g. `speed *= 0.1` on a hard beaching), which is a real, frequent, entirely legitimate
  // event — a player running aground near a dock is normal play, not a cheat signal, and no
  // collision response in stepBoat ever *increases* speed discontinuously. So only a sudden
  // speed *increase* is checked against a physically-possible accel bound; a sudden decrease is
  // always accepted. This was found empirically by test/load.ts — see the Phase 2 handoff
  // report — not predicted by envelope.test.ts's property tests, which sampled only deep,
  // collision-free water.
  const accel = (reportSpeed - prevSpeed) / dt;
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

  // Hard leash exceeded: reject *this tick's* report for replication (other players still see
  // the shadow's conservative position, not the unverified one), and flag it as a violation —
  // but still pull the shadow toward the report at the same rate as the soft/hard band above,
  // rather than freezing it in place forever.
  //
  // This was NOT the original design — see the Phase 2 handoff report. A freeze-in-place shadow
  // that never moves toward an out-of-leash report sounds like the conservative choice, but
  // test/load.ts found a real failure mode it causes: the shadow model has no land-collision
  // handling (by design — "no buoyancy, no substeps", see boat-shadow.ts), so a legitimate
  // client that bounces off a beach/piling/dock can end up on a genuinely different path than
  // the shadow predicts. Once that gap exceeds 12 m, a frozen shadow never recovers — the gap
  // only grows, and the player is corrected (and flagged as a violation) on literally every
  // subsequent tick, forever. A client that keeps self-consistently reporting a plausible
  // trajectory (every absolute check above still passes) is exactly what a real, if unlucky,
  // player looks like after a bad bounce, so the system self-heals by continuing to close the
  // gap instead of latching it open. The violation score still accumulates every tick this is
  // happening, which is what actually distinguishes "bad bounce, recovers in ~10s" from "sustained
  // exploit" for anti-cheat review — not an unrecoverable freeze.
  const pull = Math.min(1, LEASH_PULL_RATE_PER_S * input.dt);
  const pulled: ShadowBoatState = {
    ...shadow,
    x: shadow.x + (input.reportX - shadow.x) * pull,
    z: shadow.z + (input.reportZ - shadow.z) * pull,
  };
  return {
    x: shadow.x,
    z: shadow.z,
    h: shadow.h,
    speed: shadow.speed,
    corrected: true,
    violated: true,
    reason: 'leash',
    newShadow: pulled,
  };
}
