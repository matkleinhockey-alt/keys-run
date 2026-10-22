/**
 * Where the pirates start from and how they find water on the way to you. Pure: no three.js, no
 * DOM, no clock, so test/pirates.test.ts can run the whole approach in a few milliseconds.
 *
 * ## Why this is not a `Path` like the rest of the traffic
 *
 * Every other boat in `traffic.ts` rides a closed loop that was routed once at boot. The pirates
 * have to end up *next to the player*, wherever the player happens to be that minute, so a fixed
 * route is wrong and "steer at them" is right — but a dumb steer-at-them drives straight over a
 * key. So: the spawn point is chosen by walking candidate bearings and demanding that the whole
 * straight line to the player is open water (`depthAt`, the same bathymetry the hull physics
 * uses), and each frame the heading is nudged off the straight line only as far as it takes to
 * keep the next ~45 m wet. Measured on the real chart in test/pirates.test.ts, not argued.
 *
 * ## Why the spawn is picked out of the camera cone
 *
 * "Must not pop into existence inside your field of view." At 1000 m a 14 m hull is a third of a
 * degree wide, which is below what the fog leaves at the lowest quality tier anyway, but that is a
 * property of the quality setting and not of this code. So candidates inside the camera's cone
 * (plus a margin for turning your head) are tried last, and only if every bearing out of the cone
 * is blocked by land. A harbour dweller gets the pirates from the only direction there is.
 */
import { depthAt } from '@keysrun/shared/world/depth';
import type { PirateSea } from '@keysrun/shared/world/pirates';

/** Cruising speed, m/s (~12.6 kn). A tired gaff sloop in a fresh breeze: faster than the old
 * 4 m/s the ambient sailboats do, slower than anything with an engine, which is the point. */
export const SAIL_SPEED = 6.5;
/** How far out they first appear, metres. Beyond the lowest quality tier's fog (950 m) and about
 * 2.5 minutes of sailing, long enough that the bell is the first thing you hear. */
export const SPAWN_DIST = 1050;
/** Where they stop relative to the player's boat, metres: close enough to hail, far enough that
 * the hull and the rigging are not in your lap. */
export const HAIL_DIST = 44;
/** Shallowest water the sloop will sail in, metres: ~1 m of keel plus a wave trough. Measured
 * against the chart rather than guessed: the Gulf side is 1.5-4 m of flats between keys (the
 * player's own boat floats in 1.5 m of it), so the 3.5 m first tried left a Gulf visit with no
 * water at all and 2.2 m left it with almost none. */
export const MIN_DEPTH = 1.6;
/** Look-ahead used when steering around shoals, metres. */
const LOOK = 46;
/** Metres at the player's end of the spawn line that are not required to be open water. */
const END_SLACK = HAIL_DIST * 1.4;

export const clearWater = (x: number, z: number): boolean => depthAt(x, z) >= MIN_DEPTH;

/** Whether the straight segment a->b is open water, sampled every `step` metres. */
export function lineClear(ax: number, az: number, bx: number, bz: number, step = 28): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    if (!clearWater(ax + (bx - ax) * u, az + (bz - az) * u)) return false;
  }
  return true;
}

/** Heading that faces `(dx,dz)`. The boats in this codebase point their bow down local -z, so
 * forward at heading h is `(-sin h, -cos h)` (traffic.ts, hull.ts). */
export const headingTo = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

export interface ViewCone {
  /** Camera forward on the ground plane, unit length. */
  fx: number;
  fz: number;
  /** Half of the horizontal field of view plus a margin, radians. */
  half: number;
}

const inCone = (dx: number, dz: number, c: ViewCone): boolean => {
  const d = Math.hypot(dx, dz) || 1;
  const cos = (dx * c.fx + dz * c.fz) / d;
  return Math.acos(Math.max(-1, Math.min(1, cos))) < c.half;
};

/** Base bearing (the direction from the player toward the pirates' home water) as an angle in
 * the x/z plane: atan2(dz, dx). The Gulf is north of the chain, -z. Hawk Channel runs east-west
 * along the ocean side, so `spread`'s sign picks which end they sail up. */
export function homeBearing(sea: PirateSea, spread: number): number {
  if (sea === 'gulf') return -Math.PI / 2 + spread * 0.5;
  const tilt = 0.12 + Math.abs(spread) * 0.1; // a little toward the ocean side (+z)
  return spread < 0 ? Math.PI - tilt : tilt;
}

export interface Spawn { x: number; z: number; dist: number; bearing: number }

/**
 * Finds where they come over the horizon. Tries the visit's home bearing first and fans out to
 * either side in 12 degree steps, all the way round the compass, at the full distance and then progressively shorter ones
 * (a player tucked into a bay has no 1 km of open water in any direction). Returns null when
 * nothing works at all, in which case the caller simply tries again next second.
 */
export function placeSpawn(player: { x: number; z: number }, sea: PirateSea, spread: number, view: ViewCone | null, dist = SPAWN_DIST): Spawn | null {
  const base = homeBearing(sea, spread);
  for (const pass of view ? [0, 1] : [1]) {
    for (const f of [1, 0.8, 0.62, 0.48, 0.34]) {
      const d = dist * f;
      for (let k = 0; k <= 29; k++) {
        const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 15);
        const a = base + off;
        const dx = Math.cos(a), dz = Math.sin(a);
        if (pass === 0 && view && inCone(dx, dz, view)) continue;
        const x = player.x + dx * d, z = player.z + dz * d;
        // The last stretch is left unchecked: a player anchored on a 2 m flat is a perfectly good
        // thing to sail up to, and `steerHeading` stops them at the edge of the shoal.
        if (!clearWater(x, z) || !lineClear(x, z, player.x + dx * END_SLACK, player.z + dz * END_SLACK)) continue;
        return { x, z, dist: d, bearing: a };
      }
    }
  }
  return null;
}

/**
 * The heading to sail this frame to make for `(tx,tz)` without leaving the water: the direct
 * heading if the next stretch is wet, otherwise the nearest one to it that is. Null means boxed
 * in on every side, and the caller should heave to rather than sail onto the bottom.
 */
export function steerHeading(x: number, z: number, want: number, look = LOOK): number | null {
  for (const off of [0, 0.3, -0.3, 0.6, -0.6, 0.95, -0.95, 1.4, -1.4, 1.9, -1.9, Math.PI]) {
    const h = want + off;
    const fx = -Math.sin(h), fz = -Math.cos(h);
    if (clearWater(x + fx * look, z + fz * look) && clearWater(x + fx * look * 0.5, z + fz * look * 0.5)) return h;
  }
  return null;
}

/** How far a boat at (x,z) can sail along heading `h` before the water runs out, metres. */
export function freeRun(x: number, z: number, h: number, max = 1500, step = 30): number {
  const fx = -Math.sin(h), fz = -Math.cos(h);
  let r = 0;
  while (r < max && clearWater(x + fx * (r + step), z + fz * (r + step))) r += step;
  return r;
}

/**
 * Where to go when leaving: the heading with the most open water ahead, nudged toward "away from
 * the player". Replaces "sail back to where you spawned" (which a summoned 300 m approach
 * circled forever, and which on a real visit can be a whole bay away) and "sail directly away"
 * (which runs onto the nearest key). Re-evaluated every few seconds by the caller, so a boat
 * that rounds a point re-plans instead of nosing the beach.
 */
export function escapeHeading(x: number, z: number, fromX: number, fromZ: number): number {
  const away = headingTo(x - fromX, z - fromZ);
  let best = away, bestScore = -Infinity;
  for (let k = 0; k < 36; k++) {
    const h = away + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 18);
    const run = freeRun(x, z, h);
    const score = run + 350 * Math.cos(h - away);
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return best;
}
