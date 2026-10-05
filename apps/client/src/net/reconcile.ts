/**
 * Own-boat reconciliation — docs/ARCHITECTURE.md's authority model: "the client is authoritative
 * inside an envelope; the server sends corrections only on violation." The task brief's blend
 * rule: "<0.5 m ignore; 0.5-12 m render-offset with tau=0.35 s decay while migrating the real
 * position at 1.5 m/s; >12 m snap with a 250 ms camera ease." And non-negotiably: "Corrections
 * must only ever write x, z, heading, speed — never y/pitch/roll, or the boat will shudder."
 *
 * This module never touches y/pitch/roll — they are not even in its types — so "never write
 * y/pitch/roll" is a property of the function signatures here, the same way
 * apps/sim/src/world/envelope.ts's doc comment describes for the server side of this exact rule.
 *
 * Render-offset mechanics: there is one written pose per frame (no separate "true" vs "visual"
 * boat in this client — see game/world.ts's `applyNetCorrection`), so the offset-decay and the
 * rate-capped migration are composited into that single pose each `step()` call:
 *   - 0.5-12 m ("soft"): the boat's position migrates toward the correction at a hard-capped
 *     1.5 m/s (so a 10 m correction takes ~6.7 s to fully close, never a sudden slide), while a
 *     separate visual offset — the gap between where the boat was drawn and where migration
 *     starts from — decays with tau=0.35 s. The two together read as "glides back onto course"
 *     rather than either a pop or a dead-straight-line slide.
 *   - >12 m ("hard"): position/heading/speed snap to the correction immediately (this *is* the
 *     "snap"), but the frame-to-frame jump is hidden behind a fast (~250 ms) decaying visual
 *     offset — a stand-in for "camera ease" (this module has no camera handle; see the project
 *     report) that still avoids a single-frame teleport.
 *   - <0.5 m: ignored outright — within prediction noise, never worth a correction at all.
 */
import { wrapAngle } from '@keysrun/shared/sim/boat-shadow';

export interface BoatPose {
  x: number;
  z: number;
  h: number;
  speed: number;
}

const IGNORE_DIST_M = 0.5;
const HARD_SNAP_DIST_M = 12;
const MIGRATE_RATE_MPS = 1.5;
const SOFT_OFFSET_TAU_S = 0.35;
/** ~3 time constants settles a decaying exponential to <5% — 0.083 s * 3 ≈ 250 ms. */
const HARD_OFFSET_TAU_S = 0.25 / 3;
const SETTLE_EPS_M = 0.01;
const SETTLE_EPS_RAD = 0.001;

type Band = 'ignore' | 'soft' | 'hard';

function bandFor(distM: number): Band {
  if (distM < IGNORE_DIST_M) return 'ignore';
  if (distM <= HARD_SNAP_DIST_M) return 'soft';
  return 'hard';
}

interface ActiveCorrection {
  band: 'soft' | 'hard';
  tau: number;
  /** The migrating/snapped authoritative pose (not yet offset for display). */
  truth: BoatPose;
  target: BoatPose;
  /** Visual offset still being hidden, decaying toward zero. */
  offX: number;
  offZ: number;
  offH: number;
}

export interface Reconciler {
  /**
   * Called once per CORRECTION message. `current` is the client's own predicted pose at the
   * moment the correction arrived (i.e. `World.getLocalBoat()`, sampled then) — distance is
   * measured from here, per the doc's "<0.5 m / 0.5-12 m / >12 m" bands.
   */
  setTarget(target: BoatPose, current: BoatPose): void;
  /**
   * Called every render frame while a correction is in flight. Returns the pose to write this
   * frame (via `World.applyNetCorrection`), or `null` once fully settled — at which point the
   * caller should stop calling `step()` and let local prediction run unmodified until the next
   * CORRECTION.
   */
  step(dt: number): BoatPose | null;
  active(): boolean;
}

export function createReconciler(): Reconciler {
  let active: ActiveCorrection | null = null;

  return {
    setTarget(target, current) {
      const dist = Math.hypot(target.x - current.x, target.z - current.z);
      const band = bandFor(dist);
      if (band === 'ignore') {
        active = null;
        return;
      }
      if (band === 'soft') {
        active = {
          band,
          tau: SOFT_OFFSET_TAU_S,
          truth: { ...current },
          target,
          offX: 0,
          offZ: 0,
          offH: 0,
        };
      } else {
        // Hard band: truth snaps to target immediately; the *visual* offset carries the full gap
        // (position + heading) and decays fast instead of popping in one frame.
        active = {
          band,
          tau: HARD_OFFSET_TAU_S,
          truth: { ...target },
          target,
          offX: current.x - target.x,
          offZ: current.z - target.z,
          offH: wrapAngle(current.h - target.h),
        };
      }
    },

    step(dt) {
      if (!active) return null;
      const a = active;

      if (a.band === 'soft') {
        const dx = a.target.x - a.truth.x, dz = a.target.z - a.truth.z;
        const distRemaining = Math.hypot(dx, dz);
        const moveStep = Math.min(MIGRATE_RATE_MPS * dt, distRemaining);
        if (distRemaining > 1e-9) {
          a.truth.x += (dx / distRemaining) * moveStep;
          a.truth.z += (dz / distRemaining) * moveStep;
        }
        // Heading/speed have no leash bands of their own in the spec; approach them with the
        // same tau as the position offset so they settle on a comparable timescale rather than
        // snapping instantly (which would read as a pop in turn direction).
        const k = 1 - Math.exp(-dt / a.tau);
        a.truth.h = a.truth.h + wrapAngle(a.target.h - a.truth.h) * k;
        a.truth.speed += (a.target.speed - a.truth.speed) * k;
      }
      // Hard band: truth is already == target (snapped in setTarget); nothing to migrate.

      const decay = Math.exp(-dt / a.tau);
      a.offX *= decay;
      a.offZ *= decay;
      a.offH *= decay;

      const rendered: BoatPose = {
        x: a.truth.x + a.offX,
        z: a.truth.z + a.offZ,
        h: a.truth.h + a.offH,
        speed: a.truth.speed,
      };

      const posRemaining = Math.hypot(a.target.x - a.truth.x, a.target.z - a.truth.z);
      const offsetRemaining = Math.hypot(a.offX, a.offZ);
      if (posRemaining < SETTLE_EPS_M && offsetRemaining < SETTLE_EPS_M && Math.abs(a.offH) < SETTLE_EPS_RAD) {
        active = null;
      }
      return rendered;
    },

    active() {
      return active !== null;
    },
  };
}
