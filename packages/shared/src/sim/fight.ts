/**
 * Rod-and-reel fight resolution, plus the species/weight roll that feeds it.
 *
 * Ported from legacy/index.html's `updateFishing`'s `F.state==='fight'` branch (2778-2810),
 * `setHook` (2664-2678, the fight's initial conditions) and `chooseFish`/`pickSpecies`
 * (2650-2660, the species and weight roll). Faithful to every constant and evaluation order;
 * the only real change is structural, per docs/ARCHITECTURE.md ("Rod fishing,
 * server-authoritative") and the task brief:
 *
 * ⚠ Today `chooseFish()` rolls species *and* weight client-side with `Math.random()` and writes
 * straight to the leaderboard — the exact vulnerability docs/ARCHITECTURE.md is built around
 * ("The leaderboard is reachable only through server-generated catch rows"). `pickSpecies`,
 * `rollWeight` and `stepFight` below take an injected `Rng` instead of calling `Math.random()`
 * directly, and are pure (no DOM, no three.js, no `Date.now()`) — exactly the shape phase 3
 * needs to move this code onto the server unchanged. **This module does not call the server and
 * does not write a leaderboard row** — apps/client/src/game/fishing calls it today with a
 * client-local `Rng` purely for immediate feedback (the existing single-player behaviour); the
 * net agent wires an authoritative server roll on top of the exact same function later. Do not
 * read "the client calls `chooseFish`" as "the client is trusted" — it isn't, yet; nothing here
 * decides that.
 *
 * Presentation (hooked-fish mesh, line, bobber, jump animation, splash particles, camera shake,
 * toasts) stays client-side, same split as `sim/boat.ts`'s `events` convention: this module
 * reports discrete happenings via `FightState.events` instead of causing them.
 */

import { SPECIES, SOUNDERS, BILLFISH, ZONE_TABLE } from '../content/species.js';
import { VIS, isCatchable } from '../content/creatures.js';
import { offshoreF, depthAt, landH, type Zone, type Hump } from '../world/depth.js';
import { weightedPick, type Rng } from '../rng/index.js';
import { clamp, lerp } from '../internal/math.js';

// re-exported so callers don't need a second import just for the zone key union
export type { Zone };

/** Spool radius with a full load of line, metres — a 50-size conventional reel's arbor plus
 * ~300 m of 30 lb mono. */
export const SPOOL_FULL_R = 0.045;
/** Bare-arbor radius, metres: the floor `spoolRadiusFor` approaches as line runs out. */
export const SPOOL_ARBOR_R = 0.019;
/** Line length (m) at which the spool is treated as down to the arbor. Past this the radius stays
 * at `SPOOL_ARBOR_R` rather than going imaginary. */
export const SPOOL_EMPTY_AT = 260;

/**
 * Effective spool radius for `lineOut` metres of line already paid out.
 *
 * Line lies on the spool in layers, so the radius falls as the square root of the remaining line,
 * not linearly — that is why the pitch of a screaming drag climbs slowly at first and then runs
 * away near the end of a long run.
 */
export function spoolRadiusFor(lineOut: number): number {
  const remaining = clamp(1 - lineOut / SPOOL_EMPTY_AT, 0, 1);
  const r2 = SPOOL_ARBOR_R * SPOOL_ARBOR_R + remaining * (SPOOL_FULL_R * SPOOL_FULL_R - SPOOL_ARBOR_R * SPOOL_ARBOR_R);
  return Math.sqrt(r2);
}

/** legacy `rand(a,b)` (index.html:323) — uniform draw from the injected stream, not `Math.random()`. */
function rand(rng: Rng, a: number, b: number): number {
  return a + (b - a) * rng();
}

/* ------------------------------------------------------------------------------------------ *
 * The species + weight roll (legacy `pickSpecies`/`chooseFish`, index.html:2650-2660)
 * ------------------------------------------------------------------------------------------ */

export interface ChooseFishOpts {
  /** Is the cast landing inside a hotspot (bird/bait school, weedline, rig)? legacy `F.hs`. */
  hotspot: boolean;
  /** legacy `nearHump(F.bob.x,F.bob.z)` — boosts amberjack/blackfin/kingfish near an offshore hump. */
  hump: Hump | null;
}

/**
 * legacy `pickSpecies(zone,hs)` (index.html:2650-2653). `zone` takes `Zone | (string & {})` —
 * loosened past `world/depth.ts`'s `Zone` union deliberately: `ZONE_TABLE` (content/species.ts)
 * also has `'Weedline'`/`'Oil Rig'` entries that `zoneAt()` never returns (those come from
 * WEEDS/RIGS/hotspots — stubbed empty in src/stubs.ts, owned by the fish/world agents). This
 * function doesn't need to know that; it just looks the string up in `ZONE_TABLE`, so whichever
 * agent wires hotspot detection back up can pass `'Weedline'`/`'Oil Rig'` straight through.
 */
export function pickSpecies(zone: Zone | (string & {}), bob: { x: number; z: number }, opts: ChooseFishOpts, rng: Rng): string {
  const tbl = ZONE_TABLE[zone] ?? [];
  const f = zone === 'Offshore' ? offshoreF(bob.x, bob.z) : 0;
  const BIG: Record<string, number> = { marlin: 1, swordfish: 1, bluefin: 1, yellowfin: 0.6, wahoo: 0.5, sailfish: 0.3 };
  // `isCatchable` filters defensively (docs/ARCHITECTURE.md "Fish ownership — three tiers": a
  // species with `catchable: false` — marine mammals today — "has no server representation at
  // all"): ZONE_TABLE should never contain one in the first place, but this is the one place the
  // roll actually happens, so it's also the one place that must refuse to produce one even if a
  // future edit mistakenly adds one to a zone table. See test/catchable.test.ts.
  const weighted: Array<[string, number]> = tbl.filter(([k]) => isCatchable(k)).map(([k, v]) => {
    let x = opts.hotspot && v < 2.5 ? v * 2.5 : v;
    x *= BIG[k] ? 1 + 4 * f * BIG[k] : 1 - 0.45 * f;
    if (opts.hump && (k === 'amberjack' || k === 'blackfin' || k === 'kingfish')) x *= 4;
    return [k, x];
  });
  return weightedPick(rng, weighted);
}

/** legacy `chooseFish`'s weight roll (index.html:2657). */
export function rollWeight(key: string, bob: { x: number; z: number }, hotspot: boolean, rng: Rng): number {
  const S = SPECIES[key];
  const of = offshoreF(bob.x, bob.z);
  const w = S.min + (S.max - S.min) * Math.min(1, Math.pow(rng(), 1.8 - 1.2 * of) * (hotspot ? 1.2 : 1) * (1 + 0.3 * of));
  return +w.toFixed(1);
}

export interface HookedFish {
  key: string;
  weight: number;
  /** Where the fish actually sits, offset from the bobber (legacy `F.fx`/`F.fz`). */
  x: number;
  z: number;
  /** Station-keeping offset from the bobber while waiting (legacy `F.ofx`/`F.ofz`). */
  ofx: number;
  ofz: number;
}

/** legacy `chooseFish()` (index.html:2655-2660), fully: species, weight, and spawn position. */
export function chooseFish(zone: Zone | (string & {}), bob: { x: number; z: number }, opts: ChooseFishOpts, rng: Rng): HookedFish {
  const key = pickSpecies(zone, bob, opts, rng);
  const weight = rollWeight(key, bob, opts.hotspot, rng);
  const a = rng() * Math.PI * 2;
  return { key, weight, x: bob.x + Math.cos(a) * 11, z: bob.z + Math.sin(a) * 11, ofx: Math.cos(a) * 1.3, ofz: Math.sin(a) * 1.3 };
}

/* ------------------------------------------------------------------------------------------ *
 * The fight itself (legacy `setHook` + `updateFishing`'s fight branch)
 * ------------------------------------------------------------------------------------------ */

/** Derived, constant for the whole fight (legacy `F.str`/`F.maxLine` + the species flags its
 * jump/sound logic reads). Computed once by `startFight`, passed back into every `stepFight`. */
export interface FightParams {
  key: string;
  weight: number;
  /** legacy `F.str = S.str*(.8+.55*sizeT)` — size-scaled fight strength. */
  str: number;
  /** legacy `F.maxLine = S.str>1.2?320:200`. */
  maxLine: number;
  /** legacy `S.jump`. */
  jump: boolean;
  /** legacy's one-off `F.key==='kingfish'` jump case — kingfish isn't `S.jump` but gets its own
   * (lower-odds, single-jump) roll in `setHook`. */
  kingfish: boolean;
  billfish: boolean;
  sounder: boolean;
  /** Scaled fish length in meters (legacy `VIS[key].len*s`, `s` from `showHooked`/`setupPhoto`'s
   * `clamp(Math.cbrt(weight/avgWeight),.75,1.5)`), used only to flavor jump duration/height. */
  lenM: number;
  drag: number;
}

/** legacy `showHooked`/`setupPhoto`'s `clamp(Math.cbrt(weight/avgWeight),.75,1.5)` size scale,
 * applied to `VIS[key].len` — how big to draw/size a given catch relative to its species'
 * average. Exported so presentation code (the hooked-fish mesh, the catch portrait) can size a
 * mesh identically to how `fightParamsFor` derives `lenM`, without duplicating the formula. */
export function scaledLenM(key: string, weight: number): number {
  const S = SPECIES[key];
  const scale = clamp(Math.cbrt(weight / ((S.min + S.max) / 2)), 0.75, 1.5);
  return VIS[key].len * scale;
}

export function fightParamsFor(key: string, weight: number, drag: number): FightParams {
  const S = SPECIES[key];
  const sizeT = (weight - S.min) / (S.max - S.min);
  const str = S.str * (0.8 + 0.55 * sizeT);
  return {
    key, weight, str,
    maxLine: S.str > 1.2 ? 320 : 200,
    jump: !!S.jump,
    kingfish: key === 'kingfish',
    billfish: BILLFISH.has(key),
    sounder: SOUNDERS.has(key),
    lenM: scaledLenM(key, weight),
    drag,
  };
}

export type FightOutcome = 'fighting' | 'landed' | 'snapped' | 'slack' | 'spooled' | 'mangrove';

export type FightEvent =
  | { type: 'splash'; x: number; z: number; big: boolean }
  | { type: 'startRun' }
  | { type: 'startJump'; low: boolean }
  | { type: 'sounding' };

export interface FightState {
  x: number;
  z: number;
  tension: number;
  stam: number;
  running: boolean;
  runT: number;
  runAng: number;
  pull: number;
  slackT: number;
  overT: number;
  /** legacy `F.shake` — hook-mesh wiggle intensity, cosmetic but kept for presentation parity. */
  shake: number;
  shakeT: number;
  jumpQ: number;
  /** True while the fish is "airborne" for tension-modeling purposes (legacy `jumpFish`
   * existing). Deterministic here — timed out by `airT` — rather than driven by a client-only
   * three.js animation object, so server and client agree on when the tension/stamina "air"
   * bonus applies. */
  airborne: boolean;
  airT: number;
  deep: number;
  deepT: number;
  dist: number;
  /**
   * Rate of change of `dist`, m/s, signed: **positive = line paying off the spool**, negative =
   * line coming back on. This is not a cosmetic number — it is literally `d(dist)/dt`, and line
   * length *is* the fish-to-boat distance, so it is the physically correct line speed with no
   * extra model needed.
   *
   * Exists because a reel's drag clicker ticks at a rate proportional to spool RPM, and RPM is
   * line speed over spool radius. Before this the clicker had three hardcoded rates switched by
   * a mode enum, which is why it read as a synth buzz rather than a drag: a fish screaming off at
   * 8 m/s and one easing away at 0.5 m/s made the identical sound.
   */
  lineSpeed: number;
  /**
   * Effective spool radius, metres, shrinking as line pays out — see `SPOOL_FULL_R`.
   * `rpm = lineSpeed / (2*PI*spoolR)`, which is what gives a long run its rising scream: the
   * further the fish goes the smaller the spool gets and the faster it has to spin for the same
   * line speed. Purely a function of `dist`, so it needs no state of its own.
   */
  spoolR: number;
  outcome: FightOutcome;
  events: FightEvent[];
}

/** legacy `setHook` (index.html:2664-2678), minus the DOM/audio/camera-shake side effects
 * (reported as `events` instead — see `FightState.events`). */
export function startFight(params: FightParams, fishX: number, fishZ: number, rng: Rng): FightState {
  const state: FightState = {
    x: fishX, z: fishZ,
    tension: 0.55, stam: 1,
    running: true, runT: rand(rng, 2, 4), runAng: rand(rng, -0.7, 0.7), pull: params.str * 1.05,
    slackT: 0, overT: 0,
    shake: 0.5, shakeT: rand(rng, 0.6, 1.4),
    jumpQ: 0, airborne: false, airT: 0,
    deep: 0, deepT: 0,
    dist: 0, lineSpeed: 0, spoolR: SPOOL_FULL_R,
    outcome: 'fighting',
    events: [{ type: 'splash', x: fishX, z: fishZ, big: true }],
  };
  if (params.jump && rng() < 0.85) state.jumpQ = params.billfish ? 2 + Math.floor(rng() * 3) : 1;
  else if (params.kingfish && rng() < 0.6) state.jumpQ = 1;
  else if (params.sounder) state.deepT = rand(rng, 3, 7);
  return state;
}

export interface FightInput {
  reeling: boolean;
}

export interface FightEnv {
  boatX: number;
  boatZ: number;
}

/** legacy `updateFishing`'s `F.state==='fight'` branch (index.html:2778-2810). Pure: returns a
 * new `FightState`, never mutates `state`/`input`/`env`/`params`. `dt` should be the fixed-step
 * timestep per docs/ARCHITECTURE.md's netcode table (30 Hz server-side); the function itself is
 * timestep-agnostic. `rng` must be the same stream across calls for a given fight (seeded once
 * at `startFight`) for determinism — see fight.test.ts. */
export function stepFight(state: FightState, input: FightInput, params: FightParams, env: FightEnv, rng: Rng, dt: number): FightState {
  if (state.outcome !== 'fighting') return state;
  const next: FightState = { ...state, events: [] };
  const { str, jump: jumper, billfish: bill, sounder } = params;
  const reel = input.reeling;

  next.runT -= dt;
  if (next.running && next.runT <= 0) {
    next.running = false;
    next.runT = rand(rng, 1.4, 3.2) * (1.3 - next.stam * 0.4);
  } else if (!next.running && next.runT <= 0) {
    next.running = true;
    next.runT = rand(rng, 0.9, 2.4) * (0.5 + next.stam * 0.8);
    next.runAng = rand(rng, -1.1, 1.1);
    next.pull = str * rand(rng, 0.7, 1.1) * (0.45 + 0.55 * next.stam);
    next.events.push({ type: 'splash', x: next.x, z: next.z, big: false }, { type: 'startRun' });
    if (jumper && rng() < 0.4 + 0.4 * next.stam) {
      next.jumpQ = bill ? 2 + Math.floor(rng() * 3) : 1 + (rng() < 0.3 ? 1 : 0);
    } else if (sounder && rng() < 0.6) {
      next.deepT = rand(rng, 4, 9);
      next.events.push({ type: 'sounding' });
    }
  }
  if (next.jumpQ > 0 && !next.airborne) {
    const low = bill && next.jumpQ > 1;
    next.airborne = true;
    next.airT = low ? 0.55 + params.lenM * 0.08 : 1.1 + params.lenM * 0.18;
    next.jumpQ -= 1;
    next.deepT = 0;
    next.events.push({ type: 'startJump', low }, { type: 'splash', x: next.x, z: next.z, big: !low });
  }
  if (next.airborne) {
    next.airT -= dt;
    if (next.airT <= 0) {
      next.airborne = false;
      next.events.push({ type: 'splash', x: next.x, z: next.z, big: true });
    }
  }

  next.shakeT -= dt;
  if (next.shakeT <= 0) {
    next.shakeT = rand(rng, 0.5, 1.8) * (1.4 - next.stam * 0.6);
    next.shake = 0.35;
    next.tension += (reel ? 0.08 : 0.04) * str;
    if (!(next.deepT > 0) && !next.airborne) next.events.push({ type: 'splash', x: next.x, z: next.z, big: false });
  }
  next.shake = Math.max(0, next.shake - dt);
  next.deepT = Math.max(0, next.deepT - dt);
  next.deep = lerp(next.deep, next.deepT > 0 ? Math.max(0, Math.min(depthAt(next.x, next.z) - 1, 4 + 8 * str)) : 0, Math.min(1, dt * 0.8));

  const air = next.airborne;
  const dg = params.drag;
  const pullK = (0.55 + 0.15 * dg) * (next.deepT > 0 ? 1.25 : 1);
  if (reel) {
    next.tension = clamp(next.tension + (0.36 + (next.running ? next.pull * 0.72 * pullK : 0.04) + (air ? 0.65 : 0)) * dt, 0, 1.15);
  } else {
    const tgt = air ? 0.05 : next.running ? clamp(0.28 + 0.11 * dg + 0.17 * next.pull * (next.deepT > 0 ? 1.2 : 1), 0, 0.97) : 0.08;
    next.tension += (tgt - next.tension) * Math.min(1, dt * 1.6);
  }

  let dx = next.x - env.boatX, dz = next.z - env.boatZ;
  const dist = Math.hypot(dx, dz) || 1;
  dx /= dist; dz /= dist;
  if (next.running) {
    const a = Math.atan2(dz, dx) + next.runAng;
    const sp = (3 + str * 6.5) * (0.4 + 0.6 * next.stam) * (reel ? 0.5 : 1) * (1.45 - 0.15 * dg);
    next.x += Math.cos(a) * sp * dt;
    next.z += Math.sin(a) * sp * dt;
  }
  if (reel) {
    const r = Math.max(4, 10.5 * (1 - 0.22 * str)) * (next.running ? 0.3 : 1) * (0.75 + 0.35 * (1 - next.stam)) * (0.7 + 0.1 * dg);
    next.x -= dx * r * dt;
    next.z -= dz * r * dt;
  }
  next.stam = Math.max(0, next.stam - dt * 0.1 * (0.45 + next.tension) / Math.sqrt(str));

  if (next.tension >= 1.06) {
    next.overT += dt;
    if (next.overT > 0.6) { next.outcome = 'snapped'; return next; }
  } else next.overT = Math.max(0, next.overT - dt);

  if (next.tension < 0.06) {
    next.slackT += dt;
    if (next.slackT > 2.6) { next.outcome = 'slack'; return next; }
  } else next.slackT = 0;

  const prevDist = next.dist;
  next.dist = Math.hypot(next.x - env.boatX, next.z - env.boatZ);
  // Line speed is exactly d(dist)/dt, because line length *is* fish-to-boat distance. Positive =
  // paying off the spool. `prevDist === 0` on the first tick (startFight has no distance yet), so
  // that one frame is skipped rather than reporting a spurious 30 m/s from 0 -> dist.
  const rawLineSpeed = prevDist > 0 && dt > 0 ? (next.dist - prevDist) / dt : 0;
  // Smoothed a little: the per-tick delta is noisy (the fish's run heading re-rolls, the boat
  // bobs), and an unsmoothed value makes the drag clicker chatter between rates instead of
  // sweeping. Time-constant ~80 ms — fast enough that the first scream of a run is still sudden.
  const k = Math.min(1, dt / 0.08);
  next.lineSpeed = next.lineSpeed + (rawLineSpeed - next.lineSpeed) * k;
  next.spoolR = spoolRadiusFor(next.dist);
  if (next.dist > params.maxLine) { next.outcome = 'spooled'; return next; }
  if (landH(next.x, next.z) > 0.2) { next.outcome = 'mangrove'; return next; }
  if (rng() < dt * 1.5) next.events.push({ type: 'splash', x: next.x, z: next.z, big: false });
  if (next.dist < 4.5) { next.outcome = 'landed'; return next; }

  return next;
}
