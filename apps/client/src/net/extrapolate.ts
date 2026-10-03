/**
 * Remote-boat motion model — docs/ARCHITECTURE.md's "Remote entity motion": "Boats: extrapolate.
 * They are near-constant-turn-rate bodies and we replicate speed + heading, so forward-
 * extrapolating 100 ms is accurate to centimetres. Visual lag ~30 ms instead of 150 ms."
 *
 * Deliberately NOT interpolation (that's the fish/school rule — different module, different
 * entities). A `RemoteBoatTrack` keeps the last two SNAPSHOT samples for a slot, derives a turn
 * rate from the heading delta between them (clamped — see `MAX_TURN_RATE`, a wrapped-angle sign
 * flip or one noisy snapshot must never register as a 180 deg/s spin), and `poseAt(nowMs)`
 * forward-integrates position along the *curving* path (not a straight line) using that turn
 * rate, which is what gets "near-constant-turn-rate bodies" accurate to centimetres rather than
 * just "roughly right" — a boat mid-turn keeps turning through the extrapolation window instead
 * of running tangent to its last heading.
 *
 * Pure math, no three.js: inputs/outputs are plain numbers, matching
 * docs/ARCHITECTURE.md's "Conventions" (`packages/shared`'s own rule, applied here by the same
 * logic even though this file is client-only).
 */
import { wrapAngle } from '@keysrun/shared/sim/boat-shadow';

/** One decoded SNAPSHOT boat entry, timestamped with the local clock at which it was received
 * (not the server's tick — see client.ts; we extrapolate against wall-clock arrival time). */
export interface BoatSample {
  x: number;
  z: number;
  h: number;
  speed: number;
  receivedAtMs: number;
}

export interface BoatPose {
  x: number;
  z: number;
  h: number;
  speed: number;
}

/** Hard clamp on the turn-rate estimate (rad/s). Generous (~4x the fastest hull's actual max
 * turn rate — see packages/shared/src/content/boats.ts's `turn` field, all well under 1.5 rad/s)
 * so it only ever bites on a genuinely bad sample (packet loss gap, wraparound noise), not real
 * steering. */
const MAX_TURN_RATE = 6;

/** Extrapolation is only trustworthy for a short window — docs/ARCHITECTURE.md's "100 ms" figure.
 * Past this, clamp the forward-integration time so a stalled connection (no snapshot for seconds)
 * freezes the boat in place rather than running it in slow circles or off into the distance —
 * this is also exactly the "freeze remote entities" behaviour the reconnect-and-resume section
 * asks for during a dropped connection, for free, with no special-case code. */
const MAX_EXTRAPOLATION_MS = 400;

export interface RemoteBoatTrack {
  slotId: number;
  hullIndex: number;
  prev: BoatSample | null;
  last: BoatSample;
  /** Estimated turn rate (rad/s), signed, derived from the last two samples. 0 until a second
   * sample arrives. */
  turnRate: number;
  /** Wall-clock ms this slot was first seen — drives the 0.4 s spawn fade-in (see remote-boats.ts). */
  spawnedAtMs: number;
}

export function createTrack(slotId: number, hullIndex: number, sample: BoatSample): RemoteBoatTrack {
  return { slotId, hullIndex, prev: null, last: sample, turnRate: 0, spawnedAtMs: sample.receivedAtMs };
}

/** Feed a newly-decoded SNAPSHOT entry into the track, updating the turn-rate estimate. */
export function pushSample(track: RemoteBoatTrack, sample: BoatSample): void {
  const dtS = (sample.receivedAtMs - track.last.receivedAtMs) / 1000;
  if (dtS > 0.001) {
    const dh = wrapAngle(sample.h - track.last.h);
    const rate = dh / dtS;
    track.turnRate = Math.max(-MAX_TURN_RATE, Math.min(MAX_TURN_RATE, rate));
  }
  track.prev = track.last;
  track.last = sample;
}

/**
 * Forward-extrapolated pose at wall-clock `nowMs`, curving at the track's estimated turn rate.
 * Matches the sign convention `entities/boat/visuals.ts` uses for heading (`fx=-sin(h), fz=-cos(h)`).
 */
export function poseAt(track: RemoteBoatTrack, nowMs: number): BoatPose {
  const dtS = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, nowMs - track.last.receivedAtMs)) / 1000;
  const { x, z, h, speed } = track.last;
  if (dtS <= 0) return { x, z, h, speed };

  const turnRate = track.turnRate;
  const hNow = h + turnRate * dtS;
  // Curving dead-reckoning: integrate the heading linearly over [0,dtS] rather than freezing it,
  // so a boat mid-turn arcs through the extrapolation window instead of running tangent to its
  // last-known heading (the "accurate to centimetres" claim for a near-constant-turn-rate body).
  if (Math.abs(turnRate) < 1e-4) {
    const fx = -Math.sin(h), fz = -Math.cos(h);
    return { x: x + fx * speed * dtS, z: z + fz * speed * dtS, h: hNow, speed };
  }
  // Closed-form arc integral of (-sin(h+wt), -cos(h+wt))*speed dt from 0..dtS:
  // x(t) = x0 + speed/w * (cos(h+w*dtS) - cos(h)); z(t) = z0 - speed/w * (sin(h+w*dtS) - sin(h))
  const k = speed / turnRate;
  const nx = x + k * (Math.cos(hNow) - Math.cos(h));
  const nz = z - k * (Math.sin(hNow) - Math.sin(h));
  return { x: nx, z: nz, h: hNow, speed };
}
