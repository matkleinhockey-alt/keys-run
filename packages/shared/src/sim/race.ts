/**
 * Buoy-course racing: the course itself, and the pure lap/checkpoint state machine that scores it.
 *
 * Pure (no three.js, no DOM, no `Date.now()`) for the usual reason — docs/ARCHITECTURE.md's
 * authority model puts anything that could reach a leaderboard on the server, and a race time is
 * exactly that kind of number. The client runs this today for immediate feedback; when racing goes
 * multiplayer the server runs the identical function over the same buoy table and the two agree on
 * who rounded what and when, instead of trusting a reported lap time.
 *
 * Checkpoints are **ordered and mandatory**: you must round buoy N before buoy N+1 counts. That is
 * what stops the obvious cheat (drive straight at the finish, or cut the whole back half of the
 * lap) without needing any geometry beyond a distance test, and it is why `stepRace` tracks a
 * `next` index per racer rather than just asking "which buoy am I near".
 */
import { chainZ } from '../world/chain.js';

/** A course buoy, stored in chain-relative coordinates — `x` along the island chain, `dz` offshore
 * of `chainZ(x)`. Stored this way (rather than as world z) so the course sits at a fixed offset
 * from the reef line and the Keys' own curve, which is what makes it read as "around the Keys"
 * rather than an arbitrary polygon. */
export interface CourseBuoy {
  /** Along-chain position, metres. Negative = west (toward the Seven Mile Bridge). */
  x: number;
  /** Offshore of the chain line, metres. Larger = further out toward the reef. */
  dz: number;
  /** Short label for the HUD / minimap ("Sombrero", "Hawk 2"). */
  name: string;
}

/**
 * The Marathon lap, anticlockwise: out of Boot Key Harbour, east down Hawk Channel, out to the
 * Sombrero reef line, then back west along the reef and inshore to the finish.
 *
 * Every buoy is in open water with enough depth for a planing hull — asserted in
 * test/race.test.ts against the real `depthAt`/`landH`, not eyeballed, because a buoy placed on a
 * flat or inside an island would be an unreachable checkpoint and would soft-lock the lap.
 */
export const MARATHON_COURSE: readonly CourseBuoy[] = [
  // dz 640 here would put the line inside Boot Key itself (the island spans dz 390-730 around
  // x=-1050) — checked against the real shoreInfo, not eyeballed. Pushed out into open Hawk
  // Channel water south of it.
  { x: -1350, dz: 900, name: 'Start / Finish' },
  { x: -600, dz: 800, name: 'Hawk 1' },
  { x: 250, dz: 900, name: 'Hawk 2' },
  { x: 1100, dz: 1080, name: 'East Turn' },
  { x: 1450, dz: 1330, name: 'Reef East' },
  { x: 650, dz: 1395, name: 'Sombrero' },
  { x: -250, dz: 1330, name: 'Reef West' },
  { x: -1050, dz: 1120, name: 'West Turn' },
  { x: -1600, dz: 1010, name: 'Inshore' },
];

/** Radius (m) within which a boat counts as having rounded a buoy. Generous: this is a powerboat
 * course on open water, and a tight gate would mean repeatedly circling back for a checkpoint the
 * player believes they already made — far more annoying than a slightly loose line. */
export const BUOY_RADIUS = 55;

/** Laps in a standard race. */
export const RACE_LAPS = 2;

/** Seconds of countdown after the start button before the field is released. */
export const RACE_COUNTDOWN_S = 3;

/** World position of a buoy. */
export function buoyPos(b: CourseBuoy): { x: number; z: number } {
  return { x: b.x, z: chainZ(b.x) + b.dz };
}

/** The whole course as world points, in order — what the path/visual layers consume. */
export function coursePoints(course: readonly CourseBuoy[] = MARATHON_COURSE): Array<[number, number]> {
  return course.map((b) => { const p = buoyPos(b); return [p.x, p.z] as [number, number]; });
}

/** Total lap length (m), summed around the closed loop. Used for progress estimates and to sanity
 * check the course is a real lap rather than a few metres of jitter. */
export function courseLength(course: readonly CourseBuoy[] = MARATHON_COURSE): number {
  let total = 0;
  for (let i = 0; i < course.length; i++) {
    const a = buoyPos(course[i]), b = buoyPos(course[(i + 1) % course.length]);
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

export type RacePhase = 'idle' | 'countdown' | 'racing' | 'finished';

export interface RacerProgress {
  id: string;
  /** Index of the buoy this racer must round next. */
  next: number;
  /** Completed laps. */
  lap: number;
  /** Elapsed seconds at the moment this racer finished, or null while still running. */
  finishT: number | null;
  /** Finishing position, 1-based, or null. */
  place: number | null;
}

export interface RaceState {
  phase: RacePhase;
  /** Counts down during `countdown`, then counts up as elapsed race time. */
  clock: number;
  racers: RacerProgress[];
  /** How many have finished — assigns the next `place`. */
  finished: number;
  laps: number;
  events: RaceEvent[];
}

export type RaceEvent =
  | { type: 'countdown'; secondsLeft: number }
  | { type: 'go' }
  | { type: 'buoy'; id: string; buoy: number; lap: number }
  | { type: 'lap'; id: string; lap: number }
  | { type: 'finish'; id: string; place: number; time: number };

export function createRace(ids: readonly string[], laps = RACE_LAPS): RaceState {
  return {
    phase: 'idle', clock: 0, finished: 0, laps, events: [],
    racers: ids.map((id) => ({ id, next: 0, lap: 0, finishT: null, place: null })),
  };
}

/** Arms the countdown. No-op unless idle/finished, so a stray second press cannot restart a race
 * that is already under way. */
export function startRace(state: RaceState): RaceState {
  if (state.phase === 'countdown' || state.phase === 'racing') return state;
  return {
    ...state, phase: 'countdown', clock: RACE_COUNTDOWN_S, finished: 0, events: [],
    racers: state.racers.map((r) => ({ ...r, next: 0, lap: 0, finishT: null, place: null })),
  };
}

/**
 * Reconciles the entrant list with `ids`, preserving every existing racer's progress.
 *
 * Needed because the field is not fixed: other players come and go over the network mid-race
 * (net/client.ts's slot tracks), and a racer who disconnects must not keep holding a place in the
 * standings. New arrivals start from buoy 0 on the current lap count of 0 — joining late means
 * you are genuinely behind, which is the honest result and needs no special case.
 *
 * Returns the same reference when nothing changed, so the common case (a stable field, every
 * frame) allocates nothing.
 */
export function syncRacers(state: RaceState, ids: readonly string[]): RaceState {
  const have = new Set(state.racers.map((r) => r.id));
  let changed = ids.length !== state.racers.length;
  if (!changed) { for (const id of ids) if (!have.has(id)) { changed = true; break; } }
  if (!changed) return state;

  const byId = new Map(state.racers.map((r) => [r.id, r]));
  const racers = ids.map((id) => byId.get(id) ?? { id, next: 0, lap: 0, finishT: null, place: null });
  // A departing finisher frees its place; renumber so places stay 1..n with no holes.
  let place = 0;
  const renumbered = racers
    .slice()
    .sort((a, b) => (a.finishT ?? Infinity) - (b.finishT ?? Infinity))
    .map((r) => (r.finishT !== null ? { ...r, place: ++place } : r));
  const finalById = new Map(renumbered.map((r) => [r.id, r]));
  return { ...state, racers: ids.map((id) => finalById.get(id)!), finished: place };
}

export function abortRace(state: RaceState): RaceState {
  return { ...state, phase: 'idle', clock: 0, events: [] };
}

export interface RacerPose { id: string; x: number; z: number }

/**
 * Advances the race by `dt` given where every racer currently is.
 *
 * Checkpoint logic is deliberately the simplest thing that cannot be cheated: a racer only ever
 * tests against the single buoy it owes next, so skipping one leaves `next` stuck and the lap can
 * never complete. Rounding the final buoy rolls the lap and, on the last one, finishes.
 */
export function stepRace(state: RaceState, poses: readonly RacerPose[], dt: number, course: readonly CourseBuoy[] = MARATHON_COURSE): RaceState {
  if (state.phase === 'idle' || state.phase === 'finished') return state;

  const events: RaceEvent[] = [];
  let phase: RacePhase = state.phase;
  let { clock, finished } = state;

  if (phase === 'countdown') {
    const before = Math.ceil(clock);
    clock -= dt;
    const after = Math.ceil(clock);
    if (after !== before && after > 0) events.push({ type: 'countdown', secondsLeft: after });
    if (clock <= 0) { phase = 'racing'; clock = 0; events.push({ type: 'go' }); }
    return { ...state, phase, clock, events };
  }

  clock += dt;
  const byId = new Map(poses.map((p) => [p.id, p]));
  const racers = state.racers.map((r) => {
    if (r.finishT !== null) return r;
    const p = byId.get(r.id);
    if (!p) return r;
    const target = buoyPos(course[r.next]);
    if (Math.hypot(p.x - target.x, p.z - target.z) > BUOY_RADIUS) return r;

    const next = (r.next + 1) % course.length;
    events.push({ type: 'buoy', id: r.id, buoy: r.next, lap: r.lap });
    if (next !== 0) return { ...r, next };

    // Rounded the last buoy — that closes a lap.
    const lap = r.lap + 1;
    if (lap < state.laps) {
      events.push({ type: 'lap', id: r.id, lap });
      return { ...r, next, lap };
    }
    finished += 1;
    events.push({ type: 'finish', id: r.id, place: finished, time: clock });
    return { ...r, next, lap, finishT: clock, place: finished };
  });

  // The race ends when the *player* is done or everyone is — an AI field still circulating after
  // the player has finished is scenery, not a reason to keep the HUD in race mode.
  const allDone = racers.every((r) => r.finishT !== null);
  if (allDone) phase = 'finished';

  return { ...state, phase, clock, finished, racers, events };
}

/** Fraction of the whole race completed, 0..1 — for a progress bar or AI rubber-banding. */
export function raceProgress(r: RacerProgress, laps: number, course: readonly CourseBuoy[] = MARATHON_COURSE): number {
  const perLap = 1 / laps;
  return Math.min(1, r.lap * perLap + (r.next / course.length) * perLap);
}

/** Live running order: most progress first, finishers ahead of everyone still out there. */
export function standings(state: RaceState, course: readonly CourseBuoy[] = MARATHON_COURSE): RacerProgress[] {
  return [...state.racers].sort((a, b) => {
    if (a.place !== null && b.place !== null) return a.place - b.place;
    if (a.place !== null) return -1;
    if (b.place !== null) return 1;
    return raceProgress(b, state.laps, course) - raceProgress(a, state.laps, course);
  });
}
