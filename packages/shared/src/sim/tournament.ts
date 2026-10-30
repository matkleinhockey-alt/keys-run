/**
 * Fishing tournament: fifteen minutes to boat one of each of five species drawn at random, then
 * run them back to Boot Key Harbor. First boat in with all five wins, and gets the trophy and the
 * ceremony on the pier. If nobody makes it back before the horn, nobody wins.
 *
 * Pure (no three.js, no DOM, no clock of its own — every function takes `now`, in seconds, on
 * whatever clock the caller keeps) because two different hosts run it:
 *   - offline, the client runs it for you against the AI boats;
 *   - online, apps/sim runs it for everyone connected and broadcasts the result (proto TOURNEY),
 *     and each client rebuilds the same `Tourney` from that message.
 *
 * Everything the AI boats do is derived from the tournament's seed (`npcPlan`), so every client
 * and the server agree on where each of them stands at any moment without a single extra message.
 * The same seed picks the five species (`drawSpecies`) — a new seed every tournament, so the list
 * is different every time you play.
 *
 * What a human entrant has caught is the client's word (as the catch itself is today — rod
 * fishing runs on the client). Delivery is not: `tryDeliver` takes the boat's position and speed,
 * and the server passes its own copy of those, not the client's report.
 */
import { SPECIES, ZONE_TABLE } from '../content/species.js';
import { isCatchable } from '../content/creatures.js';
import { MARINAS, depthAt } from '../world/depth.js';
import { MARATHON_COURSE, buoyPos } from './race.js';
import { mulberry32 } from '../rng/index.js';

/** Species to catch. */
export const TOURNEY_SPECIES = 5;
/** Fishing time, seconds. */
export const TOURNEY_DURATION_S = 15 * 60;
/** Countdown between the start button and lines in, seconds: the intro — every boat in the field,
 * captain's name on screen, before they head out. Long enough for a shot each. */
export const TOURNEY_COUNTDOWN_S = 15;
/** The ceremony on the pier, seconds. */
export const TOURNEY_CEREMONY_S = 10;

/**
 * Release-only in Florida, so they can't be kept and brought in — never drawn. Mirrors the
 * client's cooler rules (apps/client/src/game/catch/cooler.ts CR_ONLY); a species on that list
 * here would be a tournament nobody can finish.
 */
const RELEASE_ONLY = new Set(['goliath', 'hammerhead', 'lemonshark', 'bonefish', 'tarpon']);
/** A species has to be at least this common (ZONE_TABLE weight) somewhere to be drawn. Rarities
 * like marlin or bluefin could take a whole session on their own, never mind fifteen minutes. */
const MIN_ZONE_WEIGHT = 2;

/** Every species a tournament can ask for. */
export const TOURNEY_POOL: readonly string[] = (() => {
  const best = new Map<string, number>();
  for (const table of Object.values(ZONE_TABLE)) {
    for (const [key, w] of table) best.set(key, Math.max(best.get(key) ?? 0, w));
  }
  return [...best]
    .filter(([key, w]) => w >= MIN_ZONE_WEIGHT && SPECIES[key] && isCatchable(key) && !RELEASE_ONLY.has(key))
    .map(([key]) => key)
    .sort();
})();

/** The five species for a seed, in display order. */
export function drawSpecies(seed: number): string[] {
  const rng = mulberry32(seed ^ 0x5eed);
  const pool = [...TOURNEY_POOL];
  const out: string[] = [];
  while (out.length < TOURNEY_SPECIES && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

/**
 * The finish: Boot Key Harbor, off the City Marina's dock (MARINAS[0]'s approach point, out in the
 * cut's open water). Inside this radius and slow enough to tie up counts as bringing them in.
 */
export const HARBOUR = { x: MARINAS[0].ex, z: MARINAS[0].ez, r: 90, maxSpeed: 2.5, name: 'Boot Key Harbor' } as const;

export function inHarbour(x: number, z: number, speed: number): boolean {
  return Math.hypot(x - HARBOUR.x, z - HARBOUR.z) <= HARBOUR.r && Math.abs(speed) <= HARBOUR.maxSpeed;
}

/** Water a boat route keeps to: deep enough for the biggest hull, with a cell of margin. */
const ROUTE_MIN_DEPTH = 2;
const ROUTE_CELL = 10;

let exitRoute: Array<[number, number]> | null = null;

/**
 * The way out of Boot Key Harbor into Hawk Channel (the race's start mark), for the AI boats to
 * head out along after the intro. The harbour is enclosed — there's no straight line out — so this
 * is a breadth-first search over a 10 m depth grid, kept a cell clear of the shallows, then
 * shortened to the fewest points that still see each other over deep water. Pure and cached:
 * every client gets the same route.
 */
export function harbourExitRoute(): ReadonlyArray<readonly [number, number]> {
  if (exitRoute) return exitRoute;
  const goal = buoyPos(MARATHON_COURSE[0]);
  const x0 = Math.min(HARBOUR.x, goal.x) - 600, z0 = Math.min(HARBOUR.z, goal.z) - 600;
  const nx = Math.ceil((Math.max(HARBOUR.x, goal.x) + 600 - x0) / ROUTE_CELL);
  const nz = Math.ceil((Math.max(HARBOUR.z, goal.z) + 600 - z0) / ROUTE_CELL);
  const deep = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) deep[j * nx + i] = depthAt(x0 + i * ROUTE_CELL, z0 + j * ROUTE_CELL) >= ROUTE_MIN_DEPTH ? 1 : 0;
  // Clear water = deep, and so are all eight neighbours.
  const ok = (i: number, j: number): boolean => {
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz || !deep[b * nx + a]) return false;
    }
    return true;
  };
  const cell = (x: number, z: number): [number, number] => [Math.round((x - x0) / ROUTE_CELL), Math.round((z - z0) / ROUTE_CELL)];
  const [si, sj] = cell(HARBOUR.x, HARBOUR.z), [gi, gj] = cell(goal.x, goal.z);
  const prev = new Int32Array(nx * nz).fill(-1);
  const q = new Int32Array(nx * nz);
  let head = 0, tail = 0;
  q[tail++] = sj * nx + si; prev[sj * nx + si] = sj * nx + si;
  while (head < tail) {
    const c = q[head++];
    if (c === gj * nx + gi) break;
    const i = c % nx, j = (c - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = i + di, b = j + dj, n = b * nx + a;
      if (a < 0 || b < 0 || a >= nx || b >= nz || prev[n] >= 0 || !ok(a, b)) continue;
      prev[n] = c;
      q[tail++] = n;
    }
  }
  if (prev[gj * nx + gi] < 0) { exitRoute = [[HARBOUR.x, HARBOUR.z]]; return exitRoute; }
  const cells: Array<[number, number]> = [];
  for (let c = gj * nx + gi; ; c = prev[c]) {
    const i = c % nx;
    cells.push([x0 + i * ROUTE_CELL, z0 + ((c - i) / nx) * ROUTE_CELL]);
    if (prev[c] === c) break;
  }
  cells.reverse();
  // Line-of-sight shortening: jump to the furthest point still reachable over clear water.
  const clearLine = (a: readonly [number, number], b: readonly [number, number]): boolean => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (ROUTE_CELL / 2));
    for (let k = 0; k <= n; k++) {
      const [i, j] = cell(a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n));
      if (!ok(i, j)) return false;
    }
    return true;
  };
  const out: Array<[number, number]> = [cells[0]];
  for (let k = 0; k < cells.length - 1;) {
    let far = k + 1;
    for (let m = cells.length - 1; m > k + 1; m--) if (clearLine(cells[k], cells[m])) { far = m; break; }
    out.push(cells[far]);
    k = far;
  }
  exitRoute = out;
  return exitRoute;
}

/** The AI boats. Same boats and names as the race field (apps/client/src/game/race/opponents.ts). */
export const TOURNEY_NPCS: ReadonlyArray<{ boat: string; hull: string; captain: string }> = [
  { boat: 'Reel Deal', hull: 'mti', captain: 'Capt. Ray Pinder' },
  { boat: 'Sand Bar', hull: 'midnight', captain: 'Capt. Lou Albury' },
  { boat: 'Conch Runner', hull: 'freeman', captain: 'Capt. Dee Sawyer' },
];

export interface NpcPlan {
  /** Seconds after the start each of the five species is boated, by species index. */
  catchAt: number[];
  weights: number[];
  /** Seconds after the start the boat ties up in the harbour with all five. Can be past the end
   * of the tournament: that boat doesn't make it back in time. */
  homeAt: number;
}

// Each AI boat's pace: a catch takes ~3.6 min on average at skill 1, the run home 1-2.3 min.
// Measured over 3,000 seeds, the three-boat field gets someone home in time in ~57% of
// tournaments, with a median winning time of ~12.6 min — so a player who fishes well beats them,
// and one who wanders doesn't. test/tournament.test.ts holds the rate inside a band.
const NPC_CATCH_MEAN_S = 215;
const NPC_RUN_HOME_S = [60, 140] as const;

/** Deterministic for (seed, index): every client and the server compute the same plan. */
export function npcPlan(seed: number, i: number): NpcPlan {
  const rng = mulberry32((seed + 0x9e3779b9 * (i + 1)) >>> 0);
  const species = drawSpecies(seed);
  const skill = 0.8 + rng() * 0.45;
  // Order they find them in: a shuffle.
  const order = species.map((_, k) => k);
  for (let k = order.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [order[k], order[j]] = [order[j], order[k]];
  }
  const catchAt = new Array<number>(species.length).fill(0);
  let t = 0;
  for (const k of order) {
    // Sum of two exponentials: a run to the right water, then the bite. Never instant.
    const step = (-Math.log(1 - rng()) - Math.log(1 - rng())) * 0.5 * NPC_CATCH_MEAN_S / skill;
    t += Math.max(25, step);
    catchAt[k] = t;
  }
  const weights = species.map((key) => {
    const S = SPECIES[key];
    return Math.round((S.min + (S.max - S.min) * rng() * 0.6) * 10) / 10;
  });
  const homeAt = t + NPC_RUN_HOME_S[0] + rng() * (NPC_RUN_HOME_S[1] - NPC_RUN_HOME_S[0]);
  return { catchAt, weights, homeAt };
}

export const npcId = (i: number): string => `npc${i}`;
export const isNpcId = (id: string): boolean => id.startsWith('npc');

export interface TourneyEntry {
  id: string;
  /** Bit k set = species k caught. */
  mask: number;
  /** Weight of each caught species, lb (0 where not caught). */
  weights: number[];
}

export interface TourneyWinner {
  id: string;
  /** Seconds after the start. */
  at: number;
  weights: number[];
}

export interface Tourney {
  seed: number;
  species: string[];
  /** When lines go in (end of the countdown), on the host's clock, seconds. */
  t0: number;
  /** Human entrants. AI boats are not stored — see `npcEntry`. */
  entries: TourneyEntry[];
  winner: TourneyWinner | null;
}

export type TourneyPhase = 'countdown' | 'live' | 'ceremony' | 'over';

export const ALL_CAUGHT = (1 << TOURNEY_SPECIES) - 1;

export function createTourney(seed: number, now: number): Tourney {
  return { seed: seed >>> 0, species: drawSpecies(seed >>> 0), t0: now + TOURNEY_COUNTDOWN_S, entries: [], winner: null };
}

export function phaseOf(t: Tourney, now: number): TourneyPhase {
  if (now < t.t0) return 'countdown';
  if (t.winner) return now < t.t0 + t.winner.at + TOURNEY_CEREMONY_S ? 'ceremony' : 'over';
  return now < t.t0 + TOURNEY_DURATION_S ? 'live' : 'over';
}

/** Seconds of fishing left (0 outside the live phase's end). */
export function timeLeft(t: Tourney, now: number): number {
  return Math.max(0, Math.min(TOURNEY_DURATION_S, t.t0 + TOURNEY_DURATION_S - now));
}

/** An AI boat's standing at `now`. */
export function npcEntry(t: Tourney, i: number, now: number): TourneyEntry & { home: boolean } {
  const plan = npcPlan(t.seed, i);
  // The clock stops for everyone when the tournament is decided.
  const el = Math.min(now - t.t0, t.winner ? t.winner.at : TOURNEY_DURATION_S);
  let mask = 0;
  const weights = plan.weights.map((w, k) => {
    if (plan.catchAt[k] <= el) { mask |= 1 << k; return w; }
    return 0;
  });
  return { id: npcId(i), mask, weights, home: plan.homeAt <= el };
}

function entry(t: Tourney, id: string): TourneyEntry {
  let e = t.entries.find((x) => x.id === id);
  if (!e) {
    e = { id, mask: 0, weights: new Array<number>(t.species.length).fill(0) };
    t.entries.push(e);
  }
  return e;
}

/** Joins an entrant (a player who comes online mid-tournament, say). Idempotent. */
export function join(t: Tourney, id: string): void {
  entry(t, id);
}

/**
 * Records a kept fish. Counts only while lines are in, and only the first of each species — a
 * bigger one later doesn't replace it. Returns the species index it counted for, or -1.
 */
export function recordCatch(t: Tourney, id: string, key: string, weight: number, now: number): number {
  if (phaseOf(t, now) !== 'live') return -1;
  const k = t.species.indexOf(key);
  if (k < 0) return -1;
  const e = entry(t, id);
  if (e.mask & (1 << k)) return -1;
  e.mask |= 1 << k;
  e.weights[k] = weight;
  return k;
}

/**
 * Settles an AI win: the earliest AI boat home before `now` (and before the horn) takes it, if
 * nobody has won yet. Call before reading the result, and `tryDeliver` calls it itself so a player
 * arriving after an AI boat doesn't steal a win that already happened.
 */
export function stepTourney(t: Tourney, now: number): void {
  if (t.winner) return;
  const el = Math.min(now - t.t0, TOURNEY_DURATION_S);
  let best = -1, bestAt = Infinity;
  for (let i = 0; i < TOURNEY_NPCS.length; i++) {
    const p = npcPlan(t.seed, i);
    if (p.homeAt <= el && p.homeAt < bestAt) { best = i; bestAt = p.homeAt; }
  }
  if (best >= 0) t.winner = { id: npcId(best), at: bestAt, weights: npcPlan(t.seed, best).weights };
}

/**
 * A boat at (x, z) doing `speed` asks to bring its fish in. Wins if: lines are in, it holds all
 * five, it's in the harbour and slow enough to tie up, and nobody (AI included) got there first.
 */
export function tryDeliver(t: Tourney, id: string, boat: { x: number; z: number; speed: number }, now: number): boolean {
  stepTourney(t, now);
  if (phaseOf(t, now) !== 'live') return false;
  const e = t.entries.find((x) => x.id === id);
  if (!e || e.mask !== ALL_CAUGHT) return false;
  if (!inHarbour(boat.x, boat.z, boat.speed)) return false;
  t.winner = { id, at: now - t.t0, weights: [...e.weights] };
  return true;
}

export const countCaught = (mask: number): number => {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
};

export interface Standing { id: string; caught: number; home: boolean; won: boolean }

/** Everyone, best first: the winner, then by species caught. */
export function standings(t: Tourney, now: number): Standing[] {
  const rows: Standing[] = t.entries.map((e) => ({ id: e.id, caught: countCaught(e.mask), home: false, won: t.winner?.id === e.id }));
  for (let i = 0; i < TOURNEY_NPCS.length; i++) {
    const n = npcEntry(t, i, now);
    rows.push({ id: n.id, caught: countCaught(n.mask), home: n.home, won: t.winner?.id === n.id });
  }
  return rows.sort((a, b) => Number(b.won) - Number(a.won) || b.caught - a.caught);
}
