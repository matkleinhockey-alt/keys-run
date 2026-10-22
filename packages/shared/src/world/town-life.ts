/**
 * Boot Key Harbor City, alive: who is on the street, what they are doing, and where the animals,
 * litter, puddles and washing are. Pure data and closed-form motion, no rendering (the three.js side
 * is apps/client/src/entities/town/{people,wildlife,streetlife}.ts and builds FROM this file).
 *
 * ## Why every figure is a pure function of time
 * The first crowd was a position integrated each frame (`s += speed * dt`). That has three problems
 * this file exists to remove:
 *   1. It cannot be tested. "Never clip a wall or each other" is the one promise a crowd must keep,
 *      and a stateful crowd can only be checked by running it. A script here is `pose(t)`, so the
 *      test samples EVERY figure through a whole period of the street and asserts the promise
 *      against the real colliders (packages/shared/test/town.test.ts, 'the street is alive').
 *   2. It cannot be culled for free. A stateful walker that is off-screen must still be advanced
 *      or it teleports when you come back. A closed-form one costs nothing until you look at it,
 *      and resumes exactly where the clock says it is.
 *   3. It cannot loop. Ping-pong between two ends is the single biggest tell of a fake crowd
 *      (everyone walks the same line at the same speed and turns round at the same spot).
 *
 * ## Scripts
 * A script is a start point and a list of beats: walk through these points at this speed, hold
 * here for this long doing this, step through a door and be gone for this long. It is closed (the
 * last beat ends where the first started) and its period is stretched to a number of seconds that
 * divides `STREET_PERIOD`, so the whole street repeats exactly every STREET_PERIOD seconds and a
 * collision check over that one period is a proof for all time, not a sample.
 *
 * Pace is varied per leg and every walk starts and stops with a short ramp (a person does not go
 * from standing to 1.4 m/s in one frame). Uniform speed and instant turns are what make a crowd
 * read as a conveyor belt.
 *
 * ## Where people may be
 * On the sidewalks and promenade, the zebra crossings, the back lane and back lot, and in a
 * doorway. `LIFE_WALKABLE` is that union and the test asserts every sample against it. Each
 * walking script owns a lane (a fixed offset across the sidewalk) so two walkers going opposite
 * ways cannot meet, and lanes are chosen clear of lamp posts, planters, bins and bollards, which
 * the old strollers walked straight through.
 *
 * Nothing here is random at runtime: every number is typed, so a reshuffle cannot happen.
 */
import { LOTS, PALMS, BENCHES, PAD, PAD_Y, type Lot, type Palm, type Rect } from './town.js';

/** The street repeats exactly this often (seconds). Every script period divides it. */
export const STREET_PERIOD = 3600;

export type Pt = readonly [number, number] | readonly [number, number, number];

export type Stance =
  // people
  | 'walk' | 'jog' | 'stand' | 'look' | 'phone' | 'talk' | 'sit' | 'sitphone' | 'carry' | 'load' | 'knock' | 'stretch'
  // animals
  | 'trot' | 'sniff' | 'lie' | 'wag' | 'run' | 'climb' | 'hop' | 'perch' | 'flick' | 'freeze' | 'amble' | 'groom' | 'loaf';

export type PropKind = 'rod' | 'cooler' | 'bags' | 'coffee' | 'cone' | 'basket' | 'suitcase' | 'phone' | 'newspaper' | 'beer';

export interface GoBeat { go: readonly Pt[]; speed: number; stance?: Stance; carrying?: boolean }
export interface StayBeat { stay: number; stance: Stance; yaw?: number; carrying?: boolean }
export interface InsideBeat { inside: number }
export type BeatSpec = GoBeat | StayBeat | InsideBeat;

interface Seg {
  kind: 'go' | 'stay' | 'inside';
  t0: number; t1: number;
  pts: Pt[]; cum: number[]; len: number; speed: number;
  stance: Stance; yaw: number; carrying: boolean; idx: number;
  /** Seconds spent accelerating (and again decelerating) on a walk. */
  ramp: number;
}

export interface Script {
  id: string;
  /** Seconds the script takes to come back to where it started. Divides STREET_PERIOD. */
  cycle: number;
  /** Where in its own cycle it is at street time 0. */
  offset: number;
  segs: Seg[];
  start: Pt;
}

/** What a script says about a figure at one moment. */
export interface LifePose {
  u: number; v: number;
  /** Height above the pad, metres (a squirrel up a palm, a gull on a roof). */
  y: number;
  /** Heading in the (u, v) plane, radians: 0 faces +u, PI/2 faces +v (inland). */
  yaw: number;
  /** Current speed, m/s (drives the gait cadence). */
  speed: number;
  stance: Stance;
  /** Indoors, not drawn. */
  hidden: boolean;
  carrying: boolean;
  /** Index of the beat in the script, and seconds into it. */
  beat: number; bt: number;
}

export function newPose(): LifePose { return { u: 0, v: 0, y: 0, yaw: 0, speed: 0, stance: 'stand', hidden: false, carrying: false, beat: 0, bt: 0 }; }

const RAMP = 0.55;

function lenOf(pts: Pt[]): { cum: number[]; len: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] ?? 0) - (a[2] ?? 0)));
  }
  return { cum, len: cum[cum.length - 1] };
}

/** Every period a script may have: the divisors of STREET_PERIOD from half a minute up. */
const PERIODS: readonly number[] = (() => { const o: number[] = []; for (let d = 30; d <= STREET_PERIOD; d++) if (STREET_PERIOD % d === 0) o.push(d); return o; })();

/**
 * Turn beats into a script. Its period is the divisor of STREET_PERIOD nearest the natural length of the beats; all
 * speeds and holds are stretched by that ratio, which must stay within [0.8, 1.45] or the author has drawn a route
 * that fits no period (add a beat, or take one away). Throws if the script does not end where it starts.
 */
export function compile(id: string, start: Pt, beats: readonly BeatSpec[], offset: number): Script {
  const raw: Seg[] = [];
  let cur: Pt = start, yaw = 0, t = 0;
  beats.forEach((b, idx) => {
    if ('go' in b) {
      const pts: Pt[] = [cur, ...b.go];
      const { cum, len } = lenOf(pts);
      const dur = len / b.speed + RAMP;
      const last = pts[pts.length - 1], prev = pts[pts.length - 2];
      if (len > 1e-6) yaw = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
      raw.push({ kind: 'go', t0: t, t1: t + dur, pts, cum, len, speed: b.speed, stance: b.stance ?? 'walk', yaw, carrying: !!b.carrying, idx, ramp: 0 });
      t += dur; cur = last;
    } else if ('stay' in b) {
      if (b.yaw !== undefined) yaw = b.yaw;
      raw.push({ kind: 'stay', t0: t, t1: t + b.stay, pts: [cur], cum: [0], len: 0, speed: 0, stance: b.stance, yaw, carrying: !!b.carrying, idx, ramp: 0 });
      t += b.stay;
    } else {
      raw.push({ kind: 'inside', t0: t, t1: t + b.inside, pts: [cur], cum: [0], len: 0, speed: 0, stance: 'stand', yaw, carrying: false, idx, ramp: 0 });
      t += b.inside;
    }
  });
  if (Math.hypot(cur[0] - start[0], cur[1] - start[1]) > 0.02) throw new Error(`${id}: script ends at ${cur[0]},${cur[1]}, not where it started (${start[0]},${start[1]})`);
  const cycle = PERIODS.reduce((best, d) => (Math.abs(d / t - 1) < Math.abs(best / t - 1) ? d : best), PERIODS[0]);
  const k = cycle / t;
  if (k < 0.8 || k > 1.45) throw new Error(`${id}: natural period ${t.toFixed(1)} s fits no period (nearest ${cycle}, stretch ${k.toFixed(2)})`);
  const segs = raw.map((s) => ({ ...s, t0: s.t0 * k, t1: s.t1 * k, speed: s.speed / k, ramp: Math.min(RAMP * k, ((s.t1 - s.t0) * k) / 3) }));
  return { id, cycle, offset, segs, start };
}

/** Pose of `s` at street time `t` (seconds). Allocation-free: writes into `out`. */
export function sample(s: Script, t: number, out: LifePose): LifePose {
  let tt = (t + s.offset) % s.cycle;
  if (tt < 0) tt += s.cycle;
  // few segments per script: a linear scan is as fast as a binary search
  let seg = s.segs[s.segs.length - 1];
  for (let i = 0; i < s.segs.length; i++) if (tt < s.segs[i].t1) { seg = s.segs[i]; break; }
  out.stance = seg.stance; out.carrying = seg.carrying; out.beat = seg.idx; out.bt = tt - seg.t0;
  out.hidden = seg.kind === 'inside';
  if (seg.kind !== 'go') {
    const p = seg.pts[0];
    out.u = p[0]; out.v = p[1]; out.y = p[2] ?? 0; out.yaw = seg.yaw; out.speed = 0;
    return out;
  }
  // Trapezoid velocity profile: ramp up, cruise, ramp down. compile() gave the leg `len / speed + ramp` seconds, so
  // cruising at `len / (T - ramp)` covers exactly `len`, and that cruise speed IS the nominal speed.
  const T = seg.t1 - seg.t0, x = tt - seg.t0, ramp = seg.ramp;
  const cruise = seg.len > 0 ? seg.len / Math.max(1e-6, T - ramp) : 0;
  let d: number, spd: number;
  if (x < ramp) { d = cruise * x * x / (2 * ramp); spd = cruise * x / ramp; }
  else if (x > T - ramp) { const rem = T - x; d = seg.len - cruise * rem * rem / (2 * ramp); spd = cruise * rem / ramp; }
  else { d = cruise * ramp / 2 + cruise * (x - ramp); spd = cruise; }
  d = Math.max(0, Math.min(seg.len, d));
  // locate the point
  let i = 1;
  while (i < seg.cum.length - 1 && seg.cum[i] < d) i++;
  const a = seg.pts[i - 1], b = seg.pts[i], sl = seg.cum[i] - seg.cum[i - 1] || 1, f = (d - seg.cum[i - 1]) / sl;
  out.u = a[0] + (b[0] - a[0]) * f; out.v = a[1] + (b[1] - a[1]) * f; out.y = (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * f;
  const hl = Math.hypot(b[0] - a[0], b[1] - a[1]);
  out.yaw = hl > 1e-6 ? Math.atan2(b[1] - a[1], b[0] - a[0]) : seg.yaw;
  out.speed = spd;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Where a person may stand
// ---------------------------------------------------------------------------------------------

const LOT = (id: string): Lot => LOTS.find((l) => l.id === id)!;

/** Sidewalk, promenade, crossings, and the two service areas: the ground a figure may be on (local u,v). */
export const LIFE_WALKABLE: ReadonlyArray<{ id: string; u0: number; u1: number; v0: number; v1: number; animalsOnly?: boolean }> = [
  { id: 'promenade', u0: -102, u1: 102, v0: 19.2, v1: 27.6 },
  { id: 'zebra-drive', u0: -6.3, u1: 6.3, v0: 27.6, v1: 40.4 },
  { id: 'harbor-sidewalk', u0: -102, u1: 102, v0: 40, v1: 46 },
  { id: 'palm-ave-w', u0: -8, u1: -5, v0: 46, v1: 100 },
  { id: 'palm-ave-e', u0: 5, u1: 8, v0: 46, v1: 100 },
  { id: 'blvd-sidewalk-n', u0: -102, u1: 102, v0: 80, v1: 84 },
  { id: 'zebra-blvd', u0: -6.3, u1: 6.3, v0: 84, v1: 96 },
  { id: 'blvd-sidewalk-s', u0: -102, u1: 102, v0: 96, v1: 100 },
  { id: 'back-lane', u0: -102, u1: 102, v0: 72, v1: 80 },
  { id: 'back-lot', u0: -102, u1: 102, v0: 126, v1: 171 },
  // the alley between the laundromat and the dive, and the road itself: animals only
  { id: 'alley', u0: -44, u1: -30, v0: 100, v1: 120, animalsOnly: true },
  { id: 'avenue', u0: -5, u1: 5, v0: 40, v1: 96, animalsOnly: true },
  { id: 'blvd-road', u0: -102, u1: 102, v0: 84, v1: 96, animalsOnly: true },
  // the doorway of every walk-in building, so a person can be seen stepping in
  ...LOTS.filter((l) => l.enterable).map((l) => ({ id: `door-${l.id}`, u0: l.door - 1.2, u1: l.door + 1.2, v0: l.v0, v1: l.v0 + 1.0 })),
];

/** Street bins (drawn by entities/town/build.ts at these spots): kept here so the walkers can be tested clear of them. */
export const TRASH_CANS: ReadonlyArray<{ u: number; v: number }> = [-96, -70, -20, 20, 70, 96].map((u) => ({ u, v: 42.4 }));
/** The seawall bollards: every 24 m from the west end, 6 m east of each life ring, none at the ramp. */
export const BOLLARDS: ReadonlyArray<{ u: number; v: number }> = (() => {
  const out: Array<{ u: number; v: number }> = [];
  for (let u = PAD.u0 + 12; u <= PAD.u1 - 12; u += 24) if (Math.abs(u) >= 10) out.push({ u: u + 6, v: PAD.v0 + 1.6 });
  return out;
})();

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

export type CrowdLook = 'tourist' | 'angler' | 'local' | 'woman' | 'jogger' | 'jogger-m' | 'kid' | 'worker' | 'granny';

export interface LifePerson {
  id: string;
  look: CrowdLook;
  script: Script;
  /** Body scale: a child is 0.62. */
  scale?: number;
  /** What they hold while `pose.carrying` (and `prop` hand). */
  prop?: PropKind;
  /** Items that rest somewhere for a span of beats (the cooler on the tailgate, then on the ground). */
  rests?: ReadonlyArray<{ kind: PropKind; u: number; v: number; y: number; beats: readonly [number, number] }>;
  /** Part of a pair/group that walks together: the test lets companions stand closer. */
  group?: string;
  /** Sits on this bench (index into BENCHES), so the test lets them be inside it. */
  bench?: number;
}

const Lw = (id: string): { u: number; front: number; hide: number } => {
  const l = LOT(id);
  // `hide` is where the door swallows them: through the doorway for a walk-in building, flat against the wall otherwise
  return { u: l.door, front: l.v0 - 0.95, hide: l.enterable ? l.v0 + 0.62 : l.v0 - 0.36 };
};

interface VisitOpts {
  id: string; look: CrowdLook; lot: string; from: number; to: number; lane: number; back: number;
  secs: number; offset: number; prop?: PropKind; speed?: number;
  /** Stop to look in a window on the way in: [u, seconds]. */
  window?: [number, number];
  /** Time spent on the phone / looking about after coming out. */
  after?: number; group?: string; scale?: number;
}

/** Walk to a shop, step in, spend a while, come out, hang about, walk back. */
function visit(o: VisitOpts): LifePerson {
  const d = Lw(o.lot), sp = o.speed ?? 1.25;
  const l = LOT(o.lot);
  const faceWall = Math.PI / 2; // +v: the buildings are inland of every sidewalk we use
  const south = l.v0 > 90; // row 2 fronts face seaward from the south sidewalk; the shop is still inland of the lane
  void south;
  const beats: BeatSpec[] = [];
  if (o.window) {
    beats.push({ go: [[o.window[0], o.lane]], speed: sp });
    beats.push({ stay: o.window[1], stance: 'look', yaw: faceWall });
  }
  beats.push({ go: [[d.u, o.lane]], speed: sp * 0.9 });
  beats.push({ stay: 1.4, stance: 'knock', yaw: faceWall });
  beats.push({ go: [[d.u, d.front], [d.u, d.hide]], speed: 0.8 });
  beats.push({ inside: o.secs });
  beats.push({ go: [[d.u, d.front], [d.u + (o.to > d.u ? 1.0 : -1.0), o.back]], speed: 0.9 });
  beats.push({ go: [[o.to, o.back]], speed: sp * 1.1, stance: o.prop ? 'carry' : 'walk', carrying: !!o.prop });
  beats.push({ stay: o.after ?? 5, stance: o.prop ? 'carry' : 'phone', carrying: !!o.prop, yaw: faceWall });
  beats.push({ go: [[o.from, o.back], [o.from, o.lane]], speed: sp * 1.05, stance: o.prop ? 'carry' : 'walk', carrying: !!o.prop });
  const script = compile(o.id, [o.from, o.lane], beats, o.offset);
  return { id: o.id, look: o.look, script, prop: o.prop, group: o.group, scale: o.scale };
}

/** Two people walking together: the second is offset across the path by `lat`, same timing. */
function lateral(pts: readonly Pt[], lat: number): Pt[] { return pts.map((p) => (p.length === 3 ? [p[0], p[1] + lat, p[2]] : [p[0], p[1] + lat]) as Pt); }
function shifted(beats: readonly BeatSpec[], lat: number): BeatSpec[] {
  return beats.map((b) => ('go' in b ? { ...b, go: lateral(b.go, lat) } : b));
}
function pair(id: string, look: CrowdLook, look2: CrowdLook, start: [number, number], beats: readonly BeatSpec[], lat: number, offset: number, group: string, extra?: Partial<LifePerson>, extra2?: Partial<LifePerson>): LifePerson[] {
  return [
    { id: `${id}-a`, look, script: compile(`${id}-a`, start, beats, offset), group, ...extra },
    { id: `${id}-b`, look: look2, script: compile(`${id}-b`, [start[0], start[1] + lat], shifted(beats, lat), offset), group, ...extra2 },
  ];
}

const SEA = -Math.PI / 2;   // facing the water
const LAND = Math.PI / 2;

/** Lane constants (v across a street, or u along an avenue) shared by the scripts below. */
const HS_A = 44.9, HS_B = 43.7;   // harbor sidewalk, row 1 fronts
const SS_A = 98.7, SS_B = 97.3;   // south blvd sidewalk, row 2 fronts

const visits: LifePerson[] = [
  visit({ id: 'v-tackle', look: 'angler', lot: 'tackle', from: -36, to: -58, lane: HS_A, back: HS_B, secs: 40, offset: 10, prop: 'bags', window: [-41, 6] }),
  visit({ id: 'v-diner', look: 'woman', lot: 'diner', from: -27, to: -11, lane: HS_A, back: HS_B, secs: 55, offset: 80, prop: 'coffee' }),
  visit({ id: 'v-liquor', look: 'local', lot: 'liquor', from: -80, to: -98, lane: HS_A, back: HS_B, secs: 28, offset: 40, prop: 'bags', speed: 1.1 }),
  visit({ id: 'v-bar', look: 'local', lot: 'bar', from: 12, to: 36, lane: HS_A, back: HS_B, secs: 75, offset: 150, window: [16, 5] }),
  visit({ id: 'v-gifts', look: 'tourist', lot: 'gifts', from: 70, to: 96, lane: HS_A, back: HS_B, secs: 50, offset: 20, prop: 'bags', window: [76, 7], speed: 1.05 }),
  visit({ id: 'v-pawn', look: 'local', lot: 'pawn', from: -96, to: -78, lane: SS_A, back: SS_B, secs: 35, offset: 100 }),
  visit({ id: 'v-laundromat', look: 'woman', lot: 'laundromat', from: -68, to: -48, lane: SS_A, back: SS_B, secs: 45, offset: 200, prop: 'basket' }),
  visit({ id: 'v-dive', look: 'angler', lot: 'dive', from: -40, to: -16, lane: SS_A, back: SS_B, secs: 38, offset: 60 }),
  visit({ id: 'v-motel', look: 'tourist', lot: 'motel', from: 14, to: 40, lane: SS_A, back: SS_B, secs: 42, offset: 140, prop: 'suitcase' }),
  visit({ id: 'v-icecream', look: 'woman', lot: 'icecream', from: 62, to: 78, lane: SS_A, back: SS_B, secs: 30, offset: 90, prop: 'cone', after: 12 }),
  visit({ id: 'v-stopngo', look: 'local', lot: 'stopngo', from: 82, to: 98, lane: SS_A, back: SS_B, secs: 32, offset: 30, prop: 'beer' }),
];

// Promenade: a jogger who owns the far lane, a couple who stop to photograph the water, an angler on his way to a friend.
const joggerBeats: BeatSpec[] = [
  { go: [[-30, 25.9]], speed: 3.3, stance: 'jog' },
  { go: [[40, 25.9]], speed: 2.8, stance: 'jog' },
  { go: [[88, 25.9]], speed: 3.1, stance: 'jog' },
  { stay: 12, stance: 'stretch', yaw: 0 },
  { go: [[50, 25.9]], speed: 3.0, stance: 'jog' },
  { go: [[-88, 25.9]], speed: 3.4, stance: 'jog' },
  { stay: 12, stance: 'stretch', yaw: Math.PI },
];

const coupleBeats: BeatSpec[] = [
  { go: [[-70, 23.5]], speed: 0.95 },
  { stay: 9, stance: 'phone', yaw: SEA },
  { go: [[-44, 23.5]], speed: 1.15 },
  { stay: 14, stance: 'look', yaw: SEA },
  { go: [[-16, 23.5]], speed: 0.85 },
  { stay: 6, stance: 'talk', yaw: LAND },
  { go: [[-60, 23.5]], speed: 1.25 },
  { go: [[-86, 23.5]], speed: 1.0 },
];

const anglerBeats: BeatSpec[] = [
  { go: [[62.6, 23.4], [62.6, 21.8]], speed: 1.3, stance: 'carry', carrying: true },
  { go: [[68.2, 21.8]], speed: 1.0, stance: 'carry', carrying: true },
  { stay: 40, stance: 'stand', yaw: SEA, carrying: true },
  { go: [[62.6, 21.8], [62.6, 23.4]], speed: 1.1, stance: 'carry', carrying: true },
  { go: [[28, 23.4]], speed: 1.35, stance: 'carry', carrying: true },
  { stay: 10, stance: 'look', yaw: SEA, carrying: true },
  { go: [[42, 23.4]], speed: 1.2, stance: 'carry', carrying: true },
];

const dogwalkABeats: BeatSpec[] = [
  { go: [[50, 25.1]], speed: 1.1 },
  { stay: 12, stance: 'look', yaw: SEA },
  { go: [[88, 25.1]], speed: 1.0 },
  { stay: 8, stance: 'phone', yaw: SEA },
  { go: [[30, 25.1]], speed: 1.3 },
  { stay: 10, stance: 'stand', yaw: 0 },
];

// the tourist who reads the marlin plaque (it says "released"; the town got embarrassed)
const plaqueBeats: BeatSpec[] = [
  { go: [[23.5, 24.5], [23.5, 21.4]], speed: 1.2 },
  { go: [[16.0, 21.4]], speed: 0.9 },
  { stay: 16, stance: 'look', yaw: LAND },
  { stay: 7, stance: 'phone', yaw: LAND },
  { stay: 5, stance: 'look', yaw: SEA },
  { go: [[23.5, 21.4], [23.5, 24.5]], speed: 1.15 },
  { go: [[26.5, 24.5]], speed: 0.9 },
  { stay: 9, stance: 'talk', yaw: SEA },
];

const zebraBeats = (u: number, top: number, bottom: number): BeatSpec[] => [
  { stay: 7, stance: 'look', yaw: LAND },
  { go: [[u, bottom]], speed: 1.55 },
  { stay: 6, stance: 'phone', yaw: LAND },
  { go: [[u, bottom - 0.6]], speed: 0.7 },
  { stay: 5, stance: 'look', yaw: SEA },
  { go: [[u, top]], speed: 1.6 },
];

// Palm Avenue: single file, 3 m wide, lamps at u = +-6.5
const crossBeats: BeatSpec[] = [
  { go: [[-5.7, 79.4]], speed: 1.35 },
  { go: [[-5.7, 83.2]], speed: 1.0 },
  { stay: 8, stance: 'look', yaw: LAND },   // waits for the light that does not exist
  { go: [[-5.7, 96.6]], speed: 1.7 },
  { go: [[-5.7, 98.2], [-7.4, 99.2]], speed: 1.0 },
  { go: [[-14, 99.2]], speed: 1.3 },
  { stay: 7, stance: 'look', yaw: LAND },    // window
  { go: [[-7.4, 99.2], [-5.7, 98.2]], speed: 1.25 },
  { go: [[-5.7, 96.6]], speed: 1.0 },
  { stay: 6, stance: 'look', yaw: LAND },
  { go: [[-5.7, 83.6]], speed: 1.6 },
  { go: [[-5.7, 48]], speed: 1.15 },
];

const avePhoneBeats: BeatSpec[] = [
  { go: [[-7.3, 74]], speed: 0.8, stance: 'phone' },
  { stay: 9, stance: 'phone', yaw: LAND },
  { go: [[-7.3, 52]], speed: 0.9, stance: 'phone' },
  { stay: 14, stance: 'talk', yaw: SEA },
  { go: [[-7.3, 48]], speed: 0.8 },
];

const aveEastBeats: BeatSpec[] = [
  { go: [[7.3, 92]], speed: 1.2, stance: 'carry', carrying: true },
  { go: [[7.3, 70]], speed: 1.0, stance: 'carry', carrying: true },
  { stay: 7, stance: 'look', yaw: LAND, carrying: true },
  { go: [[7.3, 52]], speed: 1.35, stance: 'carry', carrying: true },
  { go: [[7.3, 98]], speed: 1.15, stance: 'carry', carrying: true },
];

const momBeats: BeatSpec[] = [
  { go: [[64, 44.8]], speed: 0.85 },
  { stay: 6, stance: 'look', yaw: LAND },
  { go: [[53, 44.8]], speed: 1.1 },
  { stay: 8, stance: 'talk', yaw: SEA },
  { go: [[56, 44.8]], speed: 0.9 },
];

const dogwalkBBeats: BeatSpec[] = [
  { go: [[46, 83.1]], speed: 1.05 },
  { stay: 10, stance: 'stand', yaw: LAND },
  { go: [[78, 83.1]], speed: 1.25 },
  { stay: 14, stance: 'phone', yaw: LAND },
  { go: [[36, 83.1]], speed: 1.2 },
  { go: [[20, 83.1]], speed: 0.9 },
];

const blvdWalkBeats: BeatSpec[] = [
  { go: [[-60, 83.1]], speed: 0.9, stance: 'phone' },
  { stay: 8, stance: 'phone', yaw: LAND },
  { go: [[-24, 83.1]], speed: 1.3 },
  { go: [[-70, 83.1]], speed: 1.15 },
  { go: [[-96, 83.1]], speed: 1.0 },
  { go: [[-80, 83.1]], speed: 1.0 },
];

const jogMBeats: BeatSpec[] = [
  { go: [[-16, 80.9]], speed: 2.9, stance: 'jog' },
  { go: [[-96, 80.9]], speed: 2.6, stance: 'jog' },
  { go: [[-60, 80.9]], speed: 3.0, stance: 'jog' },
  { stay: 14, stance: 'stretch', yaw: 0 },
  { go: [[-96, 80.9]], speed: 2.8, stance: 'jog' },
];

// The man loading a cooler into his truck (bl-1: 4.8 m pickup nose +u at u = -50). He lifts it into the bed,
// leans on the tailgate, then thinks better of it and unloads it again. He is in the back lane, which is
// where a truck gets loaded.
const loaderBeats: BeatSpec[] = [
  { stay: 3, stance: 'stand', yaw: 0 },                                              // 0  beside the cooler on the ground
  { go: [[-56.6, 77.4]], speed: 0.8 },                                                // 1  steps up to it
  { stay: 1, stance: 'stand', yaw: 0, carrying: true },                              // 2  lifts it
  { go: [[-53.6, 77.4]], speed: 0.8, stance: 'carry', carrying: true },              // 3  to the tailgate
  { stay: 2.5, stance: 'load', yaw: 0 },                                              // 4  into the bed
  { stay: 10, stance: 'phone', yaw: 0 },                                              // 5  checks his phone
  { stay: 2.5, stance: 'load', yaw: 0, carrying: true },                              // 6  thinks better of it: out again
  { go: [[-56.6, 77.4]], speed: 0.8, stance: 'carry', carrying: true },              // 7  back to where it was
  { stay: 2, stance: 'stand', yaw: 0 },                                               // 8  puts it down
  { go: [[-57.6, 75.6]], speed: 1.0 },                                                // 9
  { stay: 5, stance: 'talk', yaw: 0 },                                                // 10
  { go: [[-56.6, 75.4]], speed: 0.9 },                                                // 11
];

// someone who simply stands about, so that not everybody is going somewhere
const talkers = (id: string, a: [number, number], b: [number, number], yawA: number, looks: [CrowdLook, CrowdLook], off: number): LifePerson[] => [
  { id: `${id}-a`, look: looks[0], script: compile(`${id}-a`, a, [{ stay: 20, stance: 'talk', yaw: yawA }, { stay: 12, stance: 'look', yaw: yawA + 0.6 }, { stay: 18, stance: 'talk', yaw: yawA }], off), group: id },
  { id: `${id}-b`, look: looks[1], script: compile(`${id}-b`, b, [{ stay: 20, stance: 'talk', yaw: yawA + Math.PI }, { stay: 12, stance: 'phone', yaw: yawA + Math.PI - 0.5 }, { stay: 18, stance: 'talk', yaw: yawA + Math.PI }], off + 3), group: id },
];

/** Bench seats: person i of bench b sits `dx` along it, facing the water. */
export const BENCH_SEAT_V = 19.78;
const seat = (id: string, look: CrowdLook, bench: number, dx: number, beats: BeatSpec[], off: number, prop?: PropKind): LifePerson => ({
  id, look, bench, prop, script: compile(id, [BENCHES[bench].u + dx, BENCH_SEAT_V], beats, off),
});

export const PEOPLE: readonly LifePerson[] = [
  ...visits,
  { id: 'jog-w', look: 'jogger', script: compile('jog-w', [-88, 25.9], joggerBeats, 0) },
  ...pair('couple', 'tourist', 'woman', [-86, 23.5], coupleBeats, 0.95, 40, 'couple'),
  { id: 'angler-w', look: 'angler', prop: 'rod', script: compile('angler-w', [42, 23.4], anglerBeats, 60) },
  { id: 'dogwalk-a', look: 'woman', script: compile('dogwalk-a', [30, 25.1], dogwalkABeats, 25), group: 'dogwalk-a' },
  { id: 'plaque', look: 'tourist', script: compile('plaque', [26.5, 24.5], plaqueBeats, 130) },
  { id: 'zebra-drive', look: 'tourist', script: compile('zebra-drive', [2.8, 27.0], zebraBeats(2.8, 27.0, 40.9), 15) },
  { id: 'ave-cross', look: 'local', script: compile('ave-cross', [-5.7, 48], crossBeats, 70) },
  { id: 'ave-phone', look: 'woman', script: compile('ave-phone', [-7.3, 48], avePhoneBeats, 5) },
  { id: 'ave-coffee', look: 'angler', prop: 'coffee', script: compile('ave-coffee', [7.3, 98], aveEastBeats, 100) },
  ...pair('mom', 'woman', 'kid', [56, 44.8], momBeats, -0.85, 50, 'mom', {}, { scale: 0.62 }),
  { id: 'dogwalk-b', look: 'granny', script: compile('dogwalk-b', [20, 83.1], dogwalkBBeats, 175), group: 'dogwalk-b' },
  { id: 'blvd-phone', look: 'tourist', script: compile('blvd-phone', [-80, 83.1], blvdWalkBeats, 110) },
  { id: 'jog-m', look: 'jogger-m', script: compile('jog-m', [-96, 80.9], jogMBeats, 20) },
  { id: 'loader', look: 'worker', prop: 'cooler', script: compile('loader', [-56.6, 75.4], loaderBeats, 0),
    rests: [
      { kind: 'cooler', u: -57.8, v: 77.4, y: 0, beats: [0, 1] },
      { kind: 'cooler', u: -51.4, v: 77.4, y: 1.0, beats: [4, 5] },
      { kind: 'cooler', u: -57.8, v: 77.4, y: 0, beats: [8, 11] },
    ] },
  ...talkers('talk-south', [46.2, 97.4], [47.4, 97.6], 0.2, ['local', 'woman'], 30),
  ...talkers('talk-tackle', [-52.6, 42.2], [-51.4, 42.4], 0.3, ['local', 'granny'], 60),
  seat('bench-reader', 'local', 1, -0.42, [{ stay: 50, stance: 'sit', yaw: SEA }, { stay: 20, stance: 'sitphone', yaw: SEA }, { stay: 30, stance: 'sit', yaw: SEA }], 0, 'newspaper'),
  seat('bench-couple-a', 'tourist', 3, -0.42, [{ stay: 40, stance: 'sit', yaw: SEA }, { stay: 25, stance: 'talk', yaw: SEA + 0.8 }, { stay: 25, stance: 'sit', yaw: SEA }], 0, 'cone'),
  seat('bench-couple-b', 'woman', 3, 0.42, [{ stay: 40, stance: 'sit', yaw: SEA }, { stay: 25, stance: 'talk', yaw: SEA - 0.8 }, { stay: 25, stance: 'sit', yaw: SEA }], 5, 'cone'),
  seat('bench-phone', 'woman', 5, 0.35, [{ stay: 60, stance: 'sitphone', yaw: SEA }, { stay: 30, stance: 'sit', yaw: SEA }, { stay: 30, stance: 'sitphone', yaw: SEA }], 40),
];

// The tied dog's owner is the stop-n-go visitor; everything about the dogs refers to people by id.
export const DOG_OWNERS = { 'dog-a': 'dogwalk-a', 'dog-b': 'dogwalk-b', 'dog-tied': 'v-stopngo' } as const;

// ---------------------------------------------------------------------------------------------
// Dogs
// ---------------------------------------------------------------------------------------------

export type DogVariant = 'terrier' | 'lab' | 'beagle' | 'dachshund' | 'husky' | 'blacklab' | 'mutt';

export interface LifeDog {
  id: string;
  variant: DogVariant;
  /** On a lead: follows the owner's pose at this offset (ahead along the heading, across in world v). */
  leash?: { owner: string; ahead: number; dv: number };
  /** Loose or tied: its own script. */
  script?: Script;
  /** Tied to a post: the lead runs here (local u, v), and the dog lies down while `owner` is hidden. */
  tie?: { u: number; v: number; owner: string };
}

const dogWander = (id: string, start: [number, number], beats: BeatSpec[], off: number): Script => compile(id, start, beats, off);

export const DOGS: readonly LifeDog[] = [
  { id: 'dog-a', variant: 'terrier', leash: { owner: 'dogwalk-a', ahead: 0.7, dv: -0.5 } },
  { id: 'dog-b', variant: 'lab', leash: { owner: 'dogwalk-b', ahead: 0.8, dv: 0.0 } },
  { id: 'dog-bench', variant: 'beagle', script: dogWander('dog-bench', [-65.9, 20.9], [
    { stay: 25, stance: 'lie', yaw: LAND }, { stay: 8, stance: 'wag', yaw: LAND }, { stay: 20, stance: 'sit', yaw: 0 }, { stay: 17, stance: 'lie', yaw: LAND },
  ], 0) },
  { id: 'dog-tied', variant: 'blacklab', tie: { u: 95.6, v: 99.3, owner: 'v-stopngo' }, script: dogWander('dog-tied', [94.2, 98.9], [
    { stay: 60, stance: 'lie', yaw: SEA }, { stay: 20, stance: 'sit', yaw: SEA }, { stay: 40, stance: 'lie', yaw: LAND }, { stay: 20, stance: 'sniff', yaw: 0.5 },
  ], 0) },
  { id: 'dog-loose-lot', variant: 'mutt', script: dogWander('dog-loose-lot', [0, 128], [
    { go: [[1, 138]], speed: 1.4, stance: 'trot' }, { stay: 6, stance: 'sniff', yaw: LAND },
    { go: [[-6, 146]], speed: 1.1, stance: 'walk' }, { stay: 9, stance: 'sniff', yaw: 0 },
    { go: [[5, 156]], speed: 1.6, stance: 'trot' }, { stay: 5, stance: 'sit', yaw: LAND },
    { go: [[-3, 164]], speed: 1.3, stance: 'trot' }, { stay: 7, stance: 'sniff', yaw: SEA },
    { go: [[0, 152]], speed: 1.8, stance: 'run' }, { go: [[0, 128]], speed: 1.5, stance: 'trot' },
  ], 30) },
  { id: 'dog-loose-lane', variant: 'dachshund', script: dogWander('dog-loose-lane', [-10, 74.2], [
    { go: [[-30, 74.2]], speed: 0.9, stance: 'walk' }, { stay: 8, stance: 'sniff', yaw: Math.PI },
    { go: [[-40, 74.2]], speed: 1.1, stance: 'trot' }, { stay: 6, stance: 'sniff', yaw: LAND },
    { go: [[-14, 74.2]], speed: 1.5, stance: 'trot' }, { stay: 10, stance: 'groom', yaw: LAND },
    { go: [[-10, 74.2]], speed: 0.8, stance: 'walk' },
  ], 55) },
  { id: 'dog-husky-lot', variant: 'husky', script: dogWander('dog-husky-lot', [40, 160], [
    { go: [[56, 160]], speed: 1.2, stance: 'walk' }, { stay: 8, stance: 'sniff', yaw: 0 },
    { go: [[66, 148]], speed: 1.5, stance: 'trot' }, { stay: 12, stance: 'lie', yaw: SEA },
    { go: [[40, 160]], speed: 1.4, stance: 'trot' }, { stay: 6, stance: 'sit', yaw: 0 },
  ], 10) },
];

/** The dog's pose for a leash: ahead of its owner along their heading, offset across in world v. */
export function leashDog(owner: LifePose, l: { ahead: number; dv: number }, out: LifePose): LifePose {
  out.u = owner.u + Math.cos(owner.yaw) * l.ahead * (owner.speed > 0.05 ? 1 : 0.35);
  out.v = owner.v + Math.sin(owner.yaw) * l.ahead * (owner.speed > 0.05 ? 1 : 0.35) + l.dv;
  out.y = 0; out.yaw = owner.yaw; out.speed = owner.speed; out.hidden = owner.hidden;
  out.stance = owner.speed > 1.7 ? 'trot' : owner.speed > 0.05 ? 'walk' : (Math.floor(owner.bt / 6) % 2 ? 'sniff' : 'sit');
  out.carrying = false; out.beat = owner.beat; out.bt = owner.bt;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Squirrels, skunks, a cat, gulls
// ---------------------------------------------------------------------------------------------

/** Where a palm trunk is at fraction `f` of its height, in local (u, v), and how thick. Shared so the squirrels climb the palm that is drawn. */
export function palmShape(p: Palm): { lean: number; height: number; baseY: number } {
  const seed = Math.abs(Math.sin(p.u * 12.9898 + p.v * 78.233) * 43758.5453) % 1;
  return { lean: (seed - 0.5) * 0.9, height: 6.4 * p.h, baseY: PAD_Y + 0.5 };
}
export function palmTrunkAt(p: Palm, f: number): { u: number; v: number; y: number; r: number } {
  const s = palmShape(p);
  return { u: p.u + s.lean * 1.65 * f * f, v: p.v - s.lean * 0.75 * f * f, y: s.baseY + s.height * f, r: 0.3 - 0.14 * f };
}
const palmAt = (u: number, v: number): Palm => PALMS.find((p) => p.u === u && p.v === v)!;

/** A path up (or down) the +v face of a palm trunk, as (u, v, y above the pad) points. */
function climbPts(p: Palm, f0: number, f1: number, n = 4): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = palmTrunkAt(p, f0 + ((f1 - f0) * i) / n);
    out.push([t.u, t.v + t.r + 0.04, t.y - PAD_Y]);
  }
  return out;
}

export type SquirrelDef = { id: string; script: Script; palm: Palm };

function squirrelLoop(id: string, a: Palm, b: Palm | null, dartFrom: [number, number], dartTo: [number, number], off: number, f1 = 0.42): SquirrelDef {
  const A = climbPts(a, 0, f1, 5), Ad = [...A].reverse();
  const foot: [number, number] = [a.u, a.v + 1.45]; // on the ground in front of the planter
  const lip: Pt = [a.u, a.v + 1.05, 0.5];
  const beats: BeatSpec[] = [
    { stay: 4, stance: 'sit', yaw: -LAND },
    { go: [lip], speed: 2.4, stance: 'hop' },
    { go: A, speed: 2.1, stance: 'climb' },
    { stay: 5, stance: 'flick', yaw: LAND },
    { go: Ad.slice(0, -1).concat([[A[0][0], A[0][1], A[0][2] ?? 0] as Pt]), speed: 1.6, stance: 'climb' },
    { go: [[a.u, a.v + 1.45, 0]], speed: 2.4, stance: 'hop' },
    { stay: 2.5, stance: 'sit', yaw: LAND },
    { go: [dartFrom, dartTo], speed: 5.8, stance: 'run' },
    { stay: 6, stance: 'flick', yaw: LAND },
    { go: [dartFrom, foot], speed: 5.4, stance: 'run' },
  ];
  void b;
  return { id, script: compile(id, foot, beats, off), palm: a };
}

export const SQUIRRELS: readonly SquirrelDef[] = [
  // the promenade palm: up, a flick, down, and a dash across the promenade to the next planter
  squirrelLoop('squirrel-prom', palmAt(-54, 22), null, [-54, 24.2], [-76, 24.2], 10),
  // the blvd's west palm: dashes across the whole boulevard to the north sidewalk and back
  squirrelLoop('squirrel-blvd', palmAt(-9.5, 97.5), null, [-9.5, 99.0], [-9.5, 83.0], 35, 0.38),
  // the alley palm, between the laundromat and the dive
  squirrelLoop('squirrel-alley', palmAt(-38, 110), null, [-38, 111.6], [-33, 117.5], 60),
];

export interface SkunkDef { id: string; script: Script; /** Only out at dusk and after. */ night: true }

/** A ring round a dumpster with stops to nose at things. Dumpsters are 3.2 x 1.6 centred at (u, 77.4). */
function skunkRing(id: string, u: number, off: number): SkunkDef {
  const a = u - 2.9, b = u + 2.9, n = 75.3, s = 79.5;
  const beats: BeatSpec[] = [
    { go: [[a + 1, n]], speed: 0.38, stance: 'amble' },
    { stay: 9, stance: 'sniff', yaw: LAND },
    { go: [[b, n + 0.2]], speed: 0.4, stance: 'amble' },
    { stay: 6, stance: 'sniff', yaw: 0 },
    { go: [[b + 0.6, 77.4], [b, s]], speed: 0.36, stance: 'amble' },
    { stay: 12, stance: 'sniff', yaw: Math.PI },
    { go: [[u, s]], speed: 0.4, stance: 'amble' },
    { stay: 4, stance: 'freeze', yaw: Math.PI },
    { go: [[a - 0.6, 77.4], [a, n]], speed: 0.37, stance: 'amble' },
    { stay: 7, stance: 'sniff', yaw: LAND },
    { go: [[a + 1, n]], speed: 0.3, stance: 'amble' },
  ];
  return { id, night: true, script: compile(id, [a + 1, n], beats, off) };
}

/** The one that crosses Palm Avenue between the two dumpsters, unhurried, because nothing bothers a skunk. */
const skunkCommuter = (): SkunkDef => ({
  id: 'skunk-commuter', night: true,
  script: compile('skunk-commuter', [-19.5, 79.3], [
    { go: [[-6, 79.3]], speed: 0.55, stance: 'amble' },
    { stay: 10, stance: 'sniff', yaw: LAND },
    { go: [[-1.5, 79.3]], speed: 0.5, stance: 'amble' },
    { stay: 16, stance: 'freeze', yaw: 0 }, // mid-avenue, deciding
    { go: [[8, 79.3]], speed: 0.62, stance: 'amble' },
    { stay: 8, stance: 'sniff', yaw: SEA },
    { go: [[24.4, 79.3]], speed: 0.5, stance: 'amble' },
    { stay: 12, stance: 'sniff', yaw: 0 },
    { go: [[8, 79.3]], speed: 0.6, stance: 'amble' },
    { go: [[-6, 79.3]], speed: 0.55, stance: 'amble' },
    { stay: 7, stance: 'sniff', yaw: Math.PI },
    { go: [[-19.5, 79.3]], speed: 0.5, stance: 'amble' },
  ], 90),
});

export const SKUNKS: readonly SkunkDef[] = [
  skunkRing('skunk-diner', -24, 0),
  skunkRing('skunk-bar', 30, 120),
  skunkCommuter(),
];

export interface CatDef { id: string; u: number; v: number; y: number; yaw: number; /** Asleep or out of sight by night. */ day: true }
/** The cat on the bar's dumpster lid (1.35 m up) by day. At dusk it leaves it to the skunks. */
export const CATS: readonly CatDef[] = [{ id: 'cat-lid', u: 30.9, v: 77.4, y: 1.4, yaw: LAND, day: true }];

export interface GullDef { id: string; perches: ReadonlyArray<{ u: number; v: number; y: number; yaw: number }>; hold: readonly number[]; offset: number }
const parapetY = (l: Lot): number => l.h + 0.22 + 0.6;
const roof = (id: string, u: number, yaw = SEA): { u: number; v: number; y: number; yaw: number } => { const l = LOT(id); return { u, v: l.v0 + 0.06, y: parapetY(l), yaw }; };
const lampTop = (u: number, v: number, yaw = SEA): { u: number; v: number; y: number; yaw: number } => ({ u, v, y: 4.5, yaw });

export const GULLS: readonly GullDef[] = [
  { id: 'gull-1', perches: [roof('tackle', -50), lampTop(-60, 27)], hold: [38, 55], offset: 0 },
  { id: 'gull-2', perches: [roof('tackle', -49), roof('diner', -28)], hold: [52, 30, 44], offset: 20 },
  { id: 'gull-3', perches: [roof('pawn', -88), roof('laundromat', -48)], hold: [61, 47], offset: 10 },
  { id: 'gull-4', perches: [roof('stopngo', 96), roof('icecream', 62)], hold: [42, 58], offset: 33 },
  { id: 'gull-5', perches: [lampTop(30, 41.2), lampTop(60, 27)], hold: [70, 45], offset: 15 },
  { id: 'gull-6', perches: [roof('bar', 30), roof('gifts', 90)], hold: [49, 63], offset: 5 },
];

/** One gull's pose: perched, or on the wing between two perches (a short arc, flapping). */
export function gullAt(g: GullDef, t: number, out: LifePose & { flap: number }): LifePose & { flap: number } {
  const n = g.perches.length, FLY = 3.2;
  const cycle = g.hold.reduce((a, b) => a + b, 0) + FLY * n;
  let tt = (t + g.offset) % cycle;
  for (let i = 0; i < n; i++) {
    const hold = g.hold[i % g.hold.length], p = g.perches[i], q = g.perches[(i + 1) % n];
    if (tt < hold) { out.u = p.u; out.v = p.v; out.y = p.y; out.yaw = p.yaw; out.flap = 0; out.speed = 0; out.stance = 'perch'; return out; }
    tt -= hold;
    if (tt < FLY) {
      const f = tt / FLY, e = f * f * (3 - 2 * f);
      out.u = p.u + (q.u - p.u) * e; out.v = p.v + (q.v - p.v) * e;
      out.y = p.y + (q.y - p.y) * e + Math.sin(f * Math.PI) * 3.4;
      out.yaw = Math.atan2(q.v - p.v, q.u - p.u); out.flap = 1; out.speed = 6; out.stance = 'run';
      return out;
    }
    tt -= FLY;
  }
  out.u = g.perches[0].u; out.v = g.perches[0].v; out.y = g.perches[0].y; out.yaw = g.perches[0].yaw; out.flap = 0; out.stance = 'perch';
  return out;
}

// ---------------------------------------------------------------------------------------------
// Litter, puddles, washing, street dressing
// ---------------------------------------------------------------------------------------------

export type LitterKind = 'cup' | 'can' | 'bottle' | 'paper' | 'butts' | 'bag' | 'box' | 'wrapper';
export interface Litter { u: number; v: number; kind: LitterKind; rot: number }

/** Placed where litter collects: kerbs, doorways, bins, and the lee of the dumpsters. */
export const LITTER: readonly Litter[] = [
  { u: 7.6, v: 44.9, kind: 'butts', rot: 0.4 }, { u: 5.6, v: 44.3, kind: 'butts', rot: 1.9 },
  { u: 23.4, v: 45.3, kind: 'cup', rot: 0.5 }, { u: 18.8, v: 45.6, kind: 'wrapper', rot: 2.2 },
  { u: -11.4, v: 40.5, kind: 'can', rot: 1.1 }, { u: -33.0, v: 40.6, kind: 'paper', rot: 0.3 },
  { u: 72.4, v: 40.7, kind: 'bottle', rot: 2.6 }, { u: -70.5, v: 40.5, kind: 'cup', rot: 0.9 },
  { u: -88.6, v: 41.4, kind: 'bag', rot: 0.0 }, { u: -45.4, v: 45.4, kind: 'butts', rot: 0.8 },
  { u: -22.4, v: 75.0, kind: 'box', rot: 0.35 }, { u: -26.4, v: 78.9, kind: 'wrapper', rot: 1.4 },
  { u: -21.3, v: 79.3, kind: 'bag', rot: 0.8 }, { u: 28.6, v: 79.3, kind: 'cup', rot: 2.9 },
  { u: 32.9, v: 75.4, kind: 'can', rot: 0.6 }, { u: 12.0, v: 79.5, kind: 'paper', rot: 1.2 },
  { u: -7.3, v: 70.2, kind: 'wrapper', rot: 2.0 }, { u: 6.4, v: 55.0, kind: 'can', rot: 1.7 },
  { u: 18.0, v: 26.6, kind: 'paper', rot: 0.7 }, { u: -60.3, v: 20.9, kind: 'cup', rot: 1.0 },
  { u: 41.6, v: 21.0, kind: 'wrapper', rot: 2.4 }, { u: 87.0, v: 20.7, kind: 'butts', rot: 0.2 },
  { u: 82.2, v: 97.7, kind: 'cup', rot: 0.4 }, { u: 84.5, v: 99.2, kind: 'butts', rot: 1.3 },
  { u: -16.3, v: 99.0, kind: 'butts', rot: 2.1 }, { u: -82.0, v: 99.1, kind: 'bag', rot: 0.5 },
  { u: 88.0, v: 140.0, kind: 'can', rot: 1.4 }, { u: -20.0, v: 160.0, kind: 'box', rot: 0.9 },
  { u: -36.2, v: 112.4, kind: 'bottle', rot: 0.7 }, { u: -41.0, v: 104.0, kind: 'wrapper', rot: 1.8 },
  { u: -33.2, v: 118.0, kind: 'paper', rot: 0.4 }, { u: 14.2, v: 98.9, kind: 'cup', rot: 2.7 },
  { u: 52.0, v: 97.9, kind: 'wrapper', rot: 0.9 }, { u: 64.6, v: 99.0, kind: 'butts', rot: 0.1 },
  { u: -3.2, v: 88.0, kind: 'paper', rot: 1.0 }, { u: 3.6, v: 33.0, kind: 'wrapper', rot: 2.3 },
];

export interface Puddle { u: number; v: number; rx: number; rz: number; rot: number }
/** Wet patches where water would sit: the lee of the dumpsters, a leaking downpipe, the gutters. */
export const PUDDLES: readonly Puddle[] = [
  { u: -27.6, v: 74.0, rx: 1.5, rz: 0.8, rot: 0.2 }, { u: 25.8, v: 79.0, rx: 1.2, rz: 0.7, rot: -0.3 },
  { u: -36.8, v: 108.6, rx: 1.8, rz: 1.0, rot: 0.5 }, { u: -45.0, v: 39.5, rx: 2.4, rz: 0.4, rot: 0.0 },
  { u: 21.5, v: 39.4, rx: 1.7, rz: 0.4, rot: 0.0 }, { u: -30.0, v: 28.6, rx: 2.6, rz: 0.45, rot: 0.0 },
  { u: 60.0, v: 28.7, rx: 1.4, rz: 0.4, rot: 0.0 }, { u: 4.4, v: 62.0, rx: 0.9, rz: 1.5, rot: 0.1 },
  { u: 76.0, v: 87.0, rx: 2.2, rz: 0.6, rot: 0.0 }, { u: -12.4, v: 135.0, rx: 2.0, rz: 1.2, rot: 0.4 },
];

/** A washing line across the alley between the laundromat and the dive, wall bracket to wall bracket. */
export const WASHING = { u0: -44, u1: -30, v: 106.5, y: 3.5, sag: 0.45 } as const;

export type DecorKind = 'news-box' | 'bike-rack' | 'aframe' | 'ice-chest' | 'crate-stack';
export interface Decor { id: string; kind: DecorKind; u: number; v: number; rot: number; text?: readonly string[] }
export const DECOR: readonly Decor[] = [
  { id: 'news-1', kind: 'news-box', u: -10.0, v: 45.7, rot: 0 },
  { id: 'news-2', kind: 'news-box', u: 77.0, v: 99.5, rot: 0 },
  { id: 'rack-stopngo', kind: 'bike-rack', u: 95.6, v: 99.4, rot: 0 },
  { id: 'rack-gifts', kind: 'bike-rack', u: 92.0, v: 45.75, rot: 0 },
  { id: 'aframe-diner', kind: 'aframe', u: -16.4, v: 45.7, rot: 0, text: ['TODAY', 'CONCH FRITTERS', '$9', 'KEY LIME PIE', 'YES REAL'] },
  { id: 'aframe-ice', kind: 'aframe', u: 66.0, v: 99.62, rot: 0, text: ['SOFT SERVE', 'FLAVOR OF THE DAY', 'KEY LIME', 'CASH ONLY'] },
  { id: 'aframe-dive', kind: 'aframe', u: -22.5, v: 99.62, rot: 0, text: ['AIR FILLS', '$8', 'WE ALSO HAVE', 'A PARROT'] },
  { id: 'chest-liquor', kind: 'ice-chest', u: -96.5, v: 45.7, rot: 0 },
  { id: 'crates-tackle', kind: 'crate-stack', u: -34.6, v: 45.7, rot: 0 },
];

// ---------------------------------------------------------------------------------------------
// Shared checks the client and the tests both use
// ---------------------------------------------------------------------------------------------

export function walkableAt(u: number, v: number, animal = false): boolean {
  for (const r of LIFE_WALKABLE) if ((animal || !r.animalsOnly) && u >= r.u0 && u <= r.u1 && v >= r.v0 && v <= r.v1) return true;
  return false;
}

export type { Rect };
