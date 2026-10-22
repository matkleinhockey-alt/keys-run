/**
 * A person on foot: the land-mode counterpart to `sim/diver.ts`. Pure and deterministic, so the
 * server can run the same step later (docs/ARCHITECTURE.md: "diver server-authoritative"; a
 * walker is the same shape of problem and an even simpler one — no oscillator, no fluid).
 *
 * The world is described to it by an environment rather than imported: `ground(x, z)` returns the
 * height of whatever you can stand on there or `null` for "nothing" (water, the edge of the pad),
 * and `colliders` are axis-aligned world rects. world/town.ts supplies both for Boot Key Harbor
 * City. Keeping the environment injected means this file never learns where the town is, which is
 * what lets the tests below drive it across a synthetic world, and the real one.
 *
 * ## Why no fall, swim or jump
 * Nothing in the walkable set has a drop you could step off — the pad, ramp and decks are bounded
 * by `ground() === null`, and a step into null is simply refused. That is deliberate: "refuse to
 * strand the player" is cheapest when the sim cannot put them anywhere they cannot walk back from.
 * Steps are capped at `STEP_MAX` so the 5 degree ramp is fine and a kerb-height fence is a wall.
 *
 * Collision is a point-vs-inflated-rect test (the rect grown by `RADIUS`), resolved per axis so
 * you slide along a wall instead of sticking to it. A circle against a box's corner is slightly
 * generous at 45 degrees, in the player's favour.
 */
import type { Rect } from '../world/town.js';

export const WALK_SPEED = 2.4;
export const SPRINT_SPEED = 4.8;
export const WALK_RADIUS = 0.32;
export const STEP_MAX = 0.7;
/** Seconds to reach ~63% of target speed; low enough to feel snappy, high enough not to skate. */
const ACCEL_TAU = 0.08;

export interface WalkerState {
  x: number; y: number; z: number;
  /** World velocity, m/s. */
  vx: number; vz: number;
  /** The way the body faces (not the camera), radians, same convention as boat heading. */
  yaw: number;
  /** Advances with distance walked; drives the gait animation (one cycle per 2*PI). */
  gait: number;
  /** Planar speed this tick, m/s. */
  speed: number;
}

export interface WalkerInput {
  fwd: boolean; back: boolean; left: boolean; right: boolean; sprint: boolean;
  /** Camera yaw: movement is relative to where you look, like the diver. */
  lookYaw: number;
}

export interface WalkerEnv {
  ground(x: number, z: number): number | null;
  colliders: readonly Rect[];
}

export function createWalkerState(x: number, z: number, yaw: number, env: WalkerEnv): WalkerState {
  return { x, y: env.ground(x, z) ?? 0, z, vx: 0, vz: 0, yaw, gait: 0, speed: 0 };
}

/** Can a body of `WALK_RADIUS` stand centred at (x,z), coming from height `fromY`? */
export function canStand(env: WalkerEnv, x: number, z: number, fromY: number): boolean {
  const g = env.ground(x, z);
  if (g === null || Math.abs(g - fromY) > STEP_MAX) return false;
  // the body's edge must be over something too, or you could stand with half of you in the harbour
  const k = WALK_RADIUS * 0.7;
  for (const [dx, dz] of [[k, 0], [-k, 0], [0, k], [0, -k]] as const) if (env.ground(x + dx, z + dz) === null) return false;
  const r = WALK_RADIUS;
  for (const c of env.colliders) {
    if (x > c.x0 - r && x < c.x1 + r && z > c.z0 - r && z < c.z1 + r) return false;
  }
  return true;
}

const angDiff = (a: number, b: number): number => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;

export function stepWalker(s: WalkerState, input: WalkerInput, env: WalkerEnv, dt: number): WalkerState {
  // Wish direction in the camera's frame: forward is -z at yaw 0, right is +x.
  const fx = -Math.sin(input.lookYaw), fz = -Math.cos(input.lookYaw);
  const rx = Math.cos(input.lookYaw), rz = -Math.sin(input.lookYaw);
  let wx = 0, wz = 0;
  if (input.fwd) { wx += fx; wz += fz; }
  if (input.back) { wx -= fx; wz -= fz; }
  if (input.right) { wx += rx; wz += rz; }
  if (input.left) { wx -= rx; wz -= rz; }
  const wl = Math.hypot(wx, wz);
  const top = input.sprint ? SPRINT_SPEED : WALK_SPEED;
  const tx = wl > 0 ? (wx / wl) * top : 0, tz = wl > 0 ? (wz / wl) * top : 0;
  const k = 1 - Math.exp(-dt / ACCEL_TAU);
  const vx = s.vx + (tx - s.vx) * k, vz = s.vz + (tz - s.vz) * k;

  // Per-axis so a wall is slid along. A rejected axis also kills that component of velocity.
  let x = s.x, z = s.z, y = s.y, nvx = vx, nvz = vz;
  const tryX = x + vx * dt;
  if (canStand(env, tryX, z, y)) { x = tryX; y = env.ground(x, z) ?? y; } else nvx = 0;
  const tryZ = z + vz * dt;
  if (canStand(env, x, tryZ, y)) { z = tryZ; y = env.ground(x, z) ?? y; } else nvz = 0;

  const speed = Math.hypot(nvx, nvz);
  let yaw = s.yaw;
  if (speed > 0.25) yaw += angDiff(yaw, Math.atan2(-nvx, -nvz)) * Math.min(1, dt * 12);
  return { x, y, z, vx: nvx, vz: nvz, yaw, gait: s.gait + speed * dt * 2.1, speed };
}
