/**
 * Boot Key Harbor City: where the town goes, and everything you can stand on in it.
 *
 * Pure placement and walkability, no rendering — the three.js side (apps/client/src/entities/town)
 * builds meshes FROM this file, never the other way round, so a test here is a test of what the
 * player sees. That is the whole point: a hand-typed coordinate is one terrain tweak from being
 * wrong, so everything below is either derived from `MARINAS`/`landH`/`shoreInfo` or asserted
 * against them in apps/client/test/town.test.ts (the party-boats.test.ts pattern).
 *
 * ## The frame
 * The town hangs off an existing marina (`MARINAS[0]`, Boot Key Harbor City Marina — a real
 * liveaboard harbour, and the one the game already names). Positions are in the marina's own
 * frame, `(u, v)`: `u` runs across the frontage, `v` runs INLAND from the shoreline line `sz` the
 * marina already computed. Seaward is negative `v`; the pier is `v < 8`. `toWorld`/`toLocal` do the
 * mapping, including the `dir = -1` case, so a second town on a Gulf-side marina is a data change.
 *
 * ## Why a raised pad
 * `landH` is a gentle beach (water's edge ~v=15, full height ~v=40) with up to ±0.5 m of rolling
 * noise inland, and the island mesh is only sampled every 8 m. Roads and floors laid flat on that
 * either z-fight or float. So the town stands on a built-up fill pad at `PAD_Y`, 0.2 m above the
 * highest terrain under it (asserted) — which is also exactly how Keys waterfronts are built: a
 * seawall, a promenade, everything a metre or two above the harbour. A 10 m ramp carries the pier
 * up to it (DECK_TOP -> PAD_Y, 5 degrees).
 *
 * ## What is walkable
 * `groundAt` is the single answer: deck planks (any marina — you can tie up anywhere), the ramp,
 * the pad. Everything else is null, so the player cannot walk into the sea or off the edge of the
 * world, and the walker never needs a fall/swim state. At the other three marinas that means the
 * docks and nothing more; the town is Boot Key Harbor's.
 */
import { MARINAS, type Marina } from './depth.js';
import type { VenueId } from '../content/venues.js';

export interface Rect { x0: number; x1: number; z0: number; z1: number }

/** Top surface of the dock planks: `addBox(3, 0.35, ..., y = 1.25)` in world/marinas.ts. */
export const DECK_TOP = 1.425;
/** Height of the town pad. Highest terrain anywhere under it is ~2.13 (asserted in the test). */
export const PAD_Y = 2.35;

export interface Frame { ox: number; oz: number; dir: 1 | -1 }

export function frameOf(m: Marina): Frame { return { ox: m.sx, oz: m.sz, dir: m.dir as 1 | -1 }; }
export const TOWN_MARINA: Marina = MARINAS[0];
export const TOWN_FRAME: Frame = frameOf(TOWN_MARINA);

export function toWorld(f: Frame, u: number, v: number): [number, number] { return [f.ox + f.dir * u, f.oz - f.dir * v]; }
export function toLocal(f: Frame, x: number, z: number): [number, number] { return [f.dir * (x - f.ox), f.dir * (f.oz - z)]; }

/** A local (u,v) box as a world AABB. */
export function worldRect(f: Frame, u0: number, u1: number, v0: number, v1: number): Rect {
  const [xa, za] = toWorld(f, u0, v0), [xb, zb] = toWorld(f, u1, v1);
  return { x0: Math.min(xa, xb), x1: Math.max(xa, xb), z0: Math.min(za, zb), z1: Math.max(za, zb) };
}

// ---------------------------------------------------------------------------------------------
// The marina's own dock, mirrored from what world/marinas.ts draws. marinas.ts now builds its
// planks FROM `marinaDeckBoxes`, so there is exactly one source of truth for where the boards are.
// ---------------------------------------------------------------------------------------------

export interface DeckBox { w: number; d: number; cx: number; cz: number; /** Plank thickness. */ t: number; /** Centre height. */ y: number }

/** Main pier, T-head and the six finger piers of marina `m`, as centre + size boxes (world). */
export function marinaDeckBoxes(m: Marina): DeckBox[] {
  const { sx, sz, dir } = m;
  const Z = (o: number): number => sz + dir * o;
  const out: DeckBox[] = [
    { w: 3, d: 56, cx: sx, cz: Z(20), t: 0.35, y: 1.25 },
    { w: 26, d: 3, cx: sx, cz: Z(48), t: 0.35, y: 1.25 },
  ];
  for (const o of [14, 26, 38]) for (const s of [-1, 1]) out.push({ w: 10, d: 1.4, cx: sx + s * 6.5, cz: Z(o), t: 0.3, y: 1.2 });
  return out;
}

export function marinaDecks(m: Marina): Rect[] {
  return marinaDeckBoxes(m).map((b) => ({ x0: b.cx - b.w / 2, x1: b.cx + b.w / 2, z0: b.cz - b.d / 2, z1: b.cz + b.d / 2 }));
}

/** The harbourmaster's shed world/marinas.ts puts 9 m inland of the pier head (11 x 7 m). Not a
 * collider on the boat (it is on the beach); it IS one for a person. */
export function marinaShedRect(m: Marina): Rect {
  const cx = m.sx + 13, cz = m.sz - m.dir * 9;
  return { x0: cx - 5.5, x1: cx + 5.5, z0: cz - 3.5, z1: cz + 3.5 };
}

// ---------------------------------------------------------------------------------------------
// Pad, ramp, streets
// ---------------------------------------------------------------------------------------------

export const PAD = { u0: -104, u1: 104, v0: 18, v1: 172 } as const;
export const RAMP = { u0: -2.2, u1: 2.2, v0: 8, v1: PAD.v0 } as const;

export type SurfaceKind = 'promenade' | 'road' | 'sidewalk' | 'lot';
export interface Surface { id: string; kind: SurfaceKind; u0: number; u1: number; v0: number; v1: number }

/** Painted ground, laid over the pad's base concrete. Later entries draw on top of earlier ones. */
export const SURFACES: readonly Surface[] = [
  { id: 'promenade', kind: 'promenade', u0: PAD.u0, u1: PAD.u1, v0: PAD.v0, v1: 28 },
  { id: 'harbor-drive', kind: 'road', u0: PAD.u0, u1: PAD.u1, v0: 28, v1: 40 },
  { id: 'harbor-sidewalk', kind: 'sidewalk', u0: PAD.u0, u1: PAD.u1, v0: 40, v1: 46 },
  { id: 'palm-ave', kind: 'road', u0: -5, u1: 5, v0: 40, v1: 96 },
  { id: 'palm-ave-w', kind: 'sidewalk', u0: -8, u1: -5, v0: 46, v1: 100 },
  { id: 'palm-ave-e', kind: 'sidewalk', u0: 5, u1: 8, v0: 46, v1: 100 },
  { id: 'back-lane', kind: 'lot', u0: PAD.u0, u1: PAD.u1, v0: 72, v1: 80 },
  { id: 'blvd-sidewalk-n', kind: 'sidewalk', u0: PAD.u0, u1: PAD.u1, v0: 80, v1: 84 },
  { id: 'sombrero-blvd', kind: 'road', u0: PAD.u0, u1: PAD.u1, v0: 84, v1: 96 },
  { id: 'blvd-sidewalk-s', kind: 'sidewalk', u0: PAD.u0, u1: PAD.u1, v0: 96, v1: 100 },
  { id: 'back-lot', kind: 'lot', u0: PAD.u0, u1: PAD.u1, v0: 126, v1: PAD.v1 },
];

// ---------------------------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------------------------

/** Wall paint / sign family the client painter keys off. */
export type LotStyle =
  | 'diner' | 'tackle' | 'guns' | 'liquor' | 'bar' | 'club' | 'gifts'
  | 'pawn' | 'laundromat' | 'icecream' | 'motel' | 'convenience' | 'dive';

export interface Lot {
  id: string;
  venue: VenueId;
  style: LotStyle;
  u0: number; u1: number; v0: number; v1: number;
  /** Wall height above the pad, metres. */
  h: number;
  /** `u` of the front door on the `v0` face. */
  door: number;
  /** Walk-in building (hollow, with a door gap) rather than a solid block. */
  enterable: boolean;
}

/** Front doors are `DOOR_W` wide on a hollow building; `WALL_T` is its wall thickness. */
export const DOOR_W = 2.8;
export const WALL_T = 0.4;

/**
 * Two rows facing two streets. Row 1 fronts Harbor Drive (v0 = 46, sidewalk behind it); row 2
 * fronts Sombrero Boulevard (v0 = 100). Palm Avenue (|u| < 8) splits each row, running straight
 * inland from the pier ramp. Every lot is >= 1 m inside the pad edge.
 */
export const LOTS: readonly Lot[] = [
  // Row 1, west of Palm Avenue, from the avenue outward
  { id: 'diner', venue: 'diner', style: 'diner', u0: -32, u1: -8, v0: 46, v1: 70, h: 4.4, door: -20, enterable: true },
  { id: 'tackle', venue: 'tackle', style: 'tackle', u0: -62, u1: -32, v0: 46, v1: 72, h: 5.2, door: -47, enterable: false },
  { id: 'guns', venue: 'guns', style: 'guns', u0: -86, u1: -62, v0: 46, v1: 70, h: 4.6, door: -74, enterable: false },
  { id: 'liquor', venue: 'liquor', style: 'liquor', u0: -100, u1: -86, v0: 46, v1: 66, h: 4.2, door: -93, enterable: false },
  // Row 1, east
  { id: 'bar', venue: 'bar', style: 'bar', u0: 8, u1: 34, v0: 46, v1: 70, h: 4.8, door: 21, enterable: true },
  { id: 'club', venue: 'club', style: 'club', u0: 34, u1: 68, v0: 46, v1: 72, h: 6.6, door: 44, enterable: true },
  { id: 'gifts', venue: 'gifts', style: 'gifts', u0: 68, u1: 100, v0: 46, v1: 68, h: 4.4, door: 84, enterable: false },
  // Row 2
  { id: 'pawn', venue: 'pawn', style: 'pawn', u0: -100, u1: -70, v0: 100, v1: 122, h: 4.6, door: -85, enterable: false },
  { id: 'laundromat', venue: 'laundromat', style: 'laundromat', u0: -70, u1: -44, v0: 100, v1: 120, h: 4.2, door: -57, enterable: false },
  { id: 'dive', venue: 'dive', style: 'dive', u0: -30, u1: -8, v0: 100, v1: 120, h: 4.4, door: -19, enterable: false },
  { id: 'motel', venue: 'motel', style: 'motel', u0: 8, u1: 60, v0: 100, v1: 124, h: 7.6, door: 20, enterable: false },
  { id: 'icecream', venue: 'icecream', style: 'icecream', u0: 60, u1: 80, v0: 100, v1: 118, h: 4.0, door: 70, enterable: false },
  { id: 'stopngo', venue: 'convenience', style: 'convenience', u0: 80, u1: 100, v0: 100, v1: 122, h: 4.4, door: 90, enterable: false },
];

export function lotRect(f: Frame, l: Lot): Rect { return worldRect(f, l.u0, l.u1, l.v0, l.v1); }

/**
 * The collision footprint of a lot in local (u,v) boxes: one solid block, or for a walk-in
 * building four walls with the door gap cut out of the front. Returned local so the client can
 * build wall geometry from the very same boxes the player collides with.
 */
export function lotWalls(l: Lot): Array<{ u0: number; u1: number; v0: number; v1: number }> {
  if (!l.enterable) return [{ u0: l.u0, u1: l.u1, v0: l.v0, v1: l.v1 }];
  const t = WALL_T, g = DOOR_W / 2;
  return [
    { u0: l.u0, u1: l.door - g, v0: l.v0, v1: l.v0 + t },
    { u0: l.door + g, u1: l.u1, v0: l.v0, v1: l.v0 + t },
    { u0: l.u0, u1: l.u1, v0: l.v1 - t, v1: l.v1 },
    { u0: l.u0, u1: l.u0 + t, v0: l.v0, v1: l.v1 },
    { u0: l.u1 - t, u1: l.u1, v0: l.v0, v1: l.v1 },
  ];
}

// ---------------------------------------------------------------------------------------------
// Props and furniture
// ---------------------------------------------------------------------------------------------

export interface Palm { u: number; v: number; h: number }
export interface Lamp { u: number; v: number }
export interface Bench { u: number; v: number }
export type CarKind = 'sedan' | 'pickup' | 'convertible' | 'suv';
/** `rot`: radians about vertical in the local frame; 0 = nose toward +u. */
export interface Car { id: string; u: number; v: number; rot: number; kind: CarKind; color: number; trailer?: boolean }
export interface SolidProp { id: string; u: number; v: number; w: number; d: number }

/** Palms stand in planters on the promenade and in the verge strips between lots and streets. */
export const PALMS: readonly Palm[] = [
  ...[-98, -76, -54, -34, 34, 54, 76, 98].map((u): Palm => ({ u, v: 22, h: 1.15 })),
  ...[-60, 60].map((u): Palm => ({ u, v: 22, h: 0.95 })),
  // the avenue's two ends
  { u: -9.5, v: 97.5, h: 1.0 }, { u: 9.5, v: 97.5, h: 1.0 },
  // behind the back lane and along the back lot
  ...[-90, -60, -30, 0, 30, 60, 90].map((u): Palm => ({ u, v: 168, h: 1.2 })),
  ...[-100, -88, 88, 100].map((u): Palm => ({ u, v: 140, h: 1.05 })),
  { u: -38, v: 110, h: 0.9 }, { u: 38, v: 130, h: 1.1 },
];

export const LAMPS: readonly Lamp[] = [
  ...[-90, -60, -30, 30, 60, 90].flatMap((u): Lamp[] => [{ u, v: 27 }, { u, v: 41.2 }]),
  ...[-60, -30, 30, 60].map((u): Lamp => ({ u, v: 82 })),
  { u: -9, v: 20 }, { u: 9, v: 20 },
  { u: 6.5, v: 60 }, { u: -6.5, v: 60 },
];

export const BENCHES: readonly Bench[] = [-88, -64, -40, 40, 64, 88].map((u): Bench => ({ u, v: 19.8 }));

/** Things a person cannot walk through that are not buildings. Axis-aligned in the local frame. */
export const SOLID_PROPS: readonly SolidProp[] = [
  { id: 'marlin-plinth', u: 16, v: 24, w: 2.6, d: 2.6 },
  { id: 'dumpster-a', u: -24, v: 77.4, w: 3.2, d: 1.6 },
  { id: 'dumpster-b', u: 30, v: 77.4, w: 3.2, d: 1.6 },
  { id: 'crab-traps', u: -55, v: 42.2, w: 2.4, d: 1.4 },
  { id: 'motel-pole', u: 40, v: 98.5, w: 0.8, d: 0.8 },
  ...BENCHES.map((b, i): SolidProp => ({ id: `bench-${i}`, u: b.u, v: b.v, w: 1.9, d: 0.6 })),
];

const CAR_COLORS = [0xd9d9d6, 0x2b4a6e, 0xa22b2b, 0x1f1f23, 0xe6e0c8, 0x3f6b4d, 0xc9a24a, 0x7a7d82];
const col = (i: number): number => CAR_COLORS[i % CAR_COLORS.length];

/** Parked cars: kerbside on both streets, the back lane, and the back lot (two of them hauling boats). */
export const CARS: readonly Car[] = [
  // Harbor Drive, parallel to the kerb (rot 0 / PI for direction of travel)
  { id: 'hd-1', u: -78, v: 29.4, rot: 0, kind: 'sedan', color: col(0) },
  { id: 'hd-2', u: -44, v: 29.4, rot: 0, kind: 'pickup', color: col(1) },
  { id: 'hd-3', u: 24, v: 29.4, rot: 0, kind: 'suv', color: col(3) },
  { id: 'hd-4', u: -56, v: 38.4, rot: Math.PI, kind: 'sedan', color: col(2) },
  { id: 'hd-5', u: 14, v: 38.4, rot: Math.PI, kind: 'pickup', color: col(4) },
  { id: 'hd-6', u: 51, v: 38.4, rot: Math.PI, kind: 'convertible', color: 0xe86aa8 },
  { id: 'hd-7', u: 80, v: 38.4, rot: Math.PI, kind: 'sedan', color: col(5) },
  // Back lane behind row 1
  { id: 'bl-1', u: -50, v: 77.4, rot: 0, kind: 'pickup', color: col(6) },
  { id: 'bl-2', u: 14, v: 77.4, rot: 0, kind: 'sedan', color: col(7) },
  { id: 'bl-3', u: 50, v: 77.4, rot: 0, kind: 'suv', color: col(1) },
  { id: 'bl-4', u: 78, v: 77.4, rot: Math.PI, kind: 'sedan', color: col(0) },
  // Sombrero Boulevard
  { id: 'sb-1', u: -60, v: 85.4, rot: 0, kind: 'sedan', color: col(3) },
  { id: 'sb-2', u: 30, v: 94.6, rot: Math.PI, kind: 'pickup', color: col(2) },
  { id: 'sb-3', u: 70, v: 85.4, rot: 0, kind: 'suv', color: col(5) },
  // Back lot, nose to the fence in rows
  ...[-84, -66, -48, -30, 30, 48, 66, 84].map((u, i): Car => ({
    id: `bk-${i}`, u, v: 134, rot: Math.PI / 2, kind: (['sedan', 'pickup', 'suv', 'sedan'] as const)[i % 4], color: col(i + 2),
  })),
  { id: 'trailer-1', u: -12, v: 150, rot: Math.PI / 2, kind: 'pickup', color: col(1), trailer: true },
  { id: 'trailer-2', u: 14, v: 150, rot: Math.PI / 2, kind: 'pickup', color: col(4), trailer: true },
];

/** World-AABB footprint of a car (4.8 x 2.0, or 12.8 long with a boat trailer), after rotation. */
export function carRect(f: Frame, c: Car): Rect {
  const len = c.trailer ? 12.8 : 4.8, wid = 2.0;
  const cs = Math.abs(Math.cos(c.rot)), sn = Math.abs(Math.sin(c.rot));
  const hu = (len * cs + wid * sn) / 2, hv = (len * sn + wid * cs) / 2;
  // a trailer rig trails behind the truck (toward -nose), so its centre is offset
  const off = c.trailer ? 4.0 : 0;
  const cu = c.u - Math.cos(c.rot) * off, cv = c.v - Math.sin(c.rot) * off;
  return worldRect(f, cu - hu, cu + hu, cv - hv, cv + hv);
}

// ---------------------------------------------------------------------------------------------
// Interiors and interaction
// ---------------------------------------------------------------------------------------------

export interface InteriorBox { id: string; lot: string; u0: number; u1: number; v0: number; v1: number }

/** Furniture you walk around inside the two enterable buildings. */
export const INTERIOR_BOXES: readonly InteriorBox[] = [
  // The Rusty Anchor: the bar runs along the back, booths against the east wall, a pool table.
  { id: 'bar-counter', lot: 'bar', u0: 11, u1: 31, v0: 60.4, v1: 62.4 },
  { id: 'bar-booth-1', lot: 'bar', u0: 30, u1: 33.4, v0: 50, v1: 54 },
  { id: 'bar-booth-2', lot: 'bar', u0: 30, u1: 33.4, v0: 55.5, v1: 59.5 },
  { id: 'bar-pool', lot: 'bar', u0: 10.5, u1: 15.5, v0: 50, v1: 54.4 },
  // Salty Dog Diner: counter and stools down the middle-back, booths along both side walls.
  { id: 'diner-counter', lot: 'diner', u0: -29, u1: -14, v0: 60, v1: 61.8 },
  { id: 'diner-booth-w1', lot: 'diner', u0: -31.6, u1: -28.4, v0: 50, v1: 54 },
  { id: 'diner-booth-w2', lot: 'diner', u0: -31.6, u1: -28.4, v0: 55.5, v1: 59.5 },
  { id: 'diner-booth-e1', lot: 'diner', u0: -11.6, u1: -8.4, v0: 50, v1: 54 },
  { id: 'diner-booth-e2', lot: 'diner', u0: -11.6, u1: -8.4, v0: 55.5, v1: 59.5 },
  // Pink Flamingo Cabaret: a stage along the back wall, the owner's booth on the east side where
  // it can see the whole room, a bar on the west, and the DJ tucked in the back corner. The door
  // is at u=44, so the whole front-left quarter stays clear as the entrance hall the walker and
  // test/town.test.ts both require.
  { id: 'club-stage', lot: 'club', u0: 42, u1: 60, v0: 64, v1: 70 },
  { id: 'club-bar', lot: 'club', u0: 36, u1: 40, v0: 56, v1: 68 },
  { id: 'club-booth-owner', lot: 'club', u0: 62, u1: 66.4, v0: 58, v1: 64 },
  { id: 'club-booth-1', lot: 'club', u0: 62, u1: 66.4, v0: 50, v1: 55 },
  { id: 'club-dj', lot: 'club', u0: 61, u1: 66, v0: 66, v1: 70 },
];

export interface Interact {
  id: string;
  kind: 'venue' | 'plaque';
  venue?: VenueId;
  /** Flavour text for a 'plaque'. */
  text?: string;
  u: number; v: number;
  /** Reach, metres. */
  r: number;
  prompt: string;
}

/** A person standing at `door` on the sidewalk is ~1 m off the wall; reach covers the whole frontage step. */
export const INTERACTS: readonly Interact[] = [
  ...LOTS.filter((l) => !l.enterable).map((l): Interact => ({
    id: `door-${l.id}`, kind: 'venue', venue: l.venue, u: l.door, v: l.v0 - 0.9, r: 2.6,
    prompt: l.venue === 'club' ? 'F  Talk to the doorman' : l.venue === 'guns' ? 'F  Step up to the counter' : 'F  Go to the door',
  })),
  // The walk-in venues are served from inside, not the door. Dropping out of the generated list
  // above is why `enterable` has to come with an interior interaction point: the club went
  // enterable and its only way to interact vanished with it, which test/town.test.ts caught by
  // asserting every interaction point is somewhere a person can actually stand.
  { id: 'counter-bar', kind: 'venue', venue: 'bar', u: 21, v: 59.3, r: 2.6, prompt: 'F  Order at the bar' },
  { id: 'counter-diner', kind: 'venue', venue: 'diner', u: -21.5, v: 58.8, r: 2.6, prompt: 'F  Sit at the counter' },
  // The club is served from the owner's booth: you walk in past the rope and sit down.
  { id: 'booth-club', kind: 'venue', venue: 'club', u: 60.2, v: 61, r: 2.8, prompt: 'F  Take the owner\'s booth' },
  { id: 'marlin', kind: 'plaque', u: 16, v: 22.2, r: 2.4, prompt: 'F  Read the plaque',
    text: 'BLUE MARLIN, 612 LB. Boated 1957 off Sombrero Reef. The plaque says "released" because the town got embarrassed.' },
];

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

export interface Walkway { id: string; pts: ReadonlyArray<readonly [number, number]> }

/** Lines people stroll back and forth along. All on sidewalk or promenade, clear of lamp posts. */
export const WALKWAYS: readonly Walkway[] = [
  { id: 'promenade', pts: [[-92, 25.2], [-24, 25.2], [-24, 26.4], [92, 26.4]] },
  { id: 'harbor-sidewalk', pts: [[-95, 44.2], [95, 44.2]] },
  { id: 'palm-ave-w', pts: [[-6.5, 48], [-6.5, 98]] },
  { id: 'palm-ave-e', pts: [[6.5, 98], [6.5, 48]] },
  { id: 'blvd-sidewalk', pts: [[-96, 82], [96, 82]] },
];

export type NpcLook =
  | 'tourist' | 'angler' | 'local' | 'woman' | 'bouncer' | 'bartender' | 'cook' | 'patron'
  // Pink Flamingo staff. 'dancer' is a performer on the stage, dressed the same way the boat's
  // own pole dancer and deck party already are (entities/boat/model.ts) — this game's register,
  // not a different one.
  | 'dancer' | 'mc' | 'dj';
export interface Npc {
  id: string;
  look: NpcLook;
  /** Walkway to follow; absent = stands still at `at`. */
  route?: string;
  speed?: number;
  /** Starting fraction along the route, 0..1. */
  phase?: number;
  /** Fixed spot (standers). `yaw` is local-frame: 0 faces +u, PI/2 faces +v (inland). */
  at?: { u: number; v: number; yaw: number };
  /** The interior group (by lot id) this person lives in, drawn only when it is. */
  inside?: string;
  /**
   * Stands ON a piece of interior furniture rather than beside it — an `INTERIOR_BOXES` id.
   *
   * Needed because a collider is a solid box: "inside the stage" and "on top of the stage" are
   * the same rectangle from above, and the placement test rightly refuses anyone standing inside
   * furniture. Naming the box makes the difference explicit, and the test still checks the person
   * is on that box and nothing else.
   */
  onBox?: string;
}

export const NPCS: readonly Npc[] = [
  { id: 'w1', look: 'tourist', route: 'promenade', speed: 1.25, phase: 0.1 },
  { id: 'w2', look: 'woman', route: 'promenade', speed: 1.1, phase: 0.55 },
  { id: 'w3', look: 'angler', route: 'harbor-sidewalk', speed: 1.4, phase: 0.2 },
  { id: 'w4', look: 'woman', route: 'harbor-sidewalk', speed: 1.2, phase: 0.7 },
  { id: 'w5', look: 'local', route: 'harbor-sidewalk', speed: 1.0, phase: 0.45 },
  { id: 'w6', look: 'tourist', route: 'palm-ave-w', speed: 1.3, phase: 0.3 },
  { id: 'w7', look: 'woman', route: 'palm-ave-e', speed: 1.15, phase: 0.6 },
  { id: 'w8', look: 'local', route: 'blvd-sidewalk', speed: 1.1, phase: 0.4 },
  { id: 's-bouncer', look: 'bouncer', at: { u: 41.2, v: 44.6, yaw: -Math.PI / 2 } },
  { id: 's-chat-1', look: 'tourist', at: { u: -41, v: 23.4, yaw: 0.4 } },
  { id: 's-chat-2', look: 'woman', at: { u: -39.4, v: 23.8, yaw: Math.PI + 0.4 } },
  { id: 's-smoker', look: 'local', at: { u: 6.2, v: 44.4, yaw: Math.PI } },
  { id: 's-angler', look: 'angler', at: { u: 66, v: 20.8, yaw: -Math.PI / 2 } },
  { id: 'i-bartender', look: 'bartender', inside: 'bar', at: { u: 21, v: 63.6, yaw: -Math.PI / 2 } },
  { id: 'i-patron-1', look: 'patron', inside: 'bar', at: { u: 17, v: 58.6, yaw: Math.PI / 2 } },
  { id: 'i-patron-2', look: 'woman', inside: 'bar', at: { u: 26, v: 58.6, yaw: Math.PI / 2 } },
  { id: 'i-cook', look: 'cook', inside: 'diner', at: { u: -21.5, v: 63.6, yaw: -Math.PI / 2 } },
  // The Pink Flamingo, which you own. Two performers on the poles (INTERIOR_BOXES 'club-stage'
  // spans u 42..60, v 64..70, poles at u 47 and 55), an MC at the stage edge, a bartender behind
  // the west bar, a DJ in the back corner and a few punters at the tables. Facing yaw PI/2 is
  // inland, so the stage acts face the room at -PI/2.
  { onBox: 'club-stage', id: 'i-dancer-1', look: 'dancer', inside: 'club', at: { u: 47, v: 66.6, yaw: -Math.PI / 2 } },
  { onBox: 'club-stage', id: 'i-dancer-2', look: 'dancer', inside: 'club', at: { u: 55, v: 66.6, yaw: -Math.PI / 2 } },
  { id: 'i-mc', look: 'mc', inside: 'club', at: { u: 51, v: 62.6, yaw: -Math.PI / 2 } },
  { id: 'i-club-bar', look: 'bartender', inside: 'club', at: { u: 38, v: 69.4, yaw: -Math.PI / 2 } }, // at the service end of the bar, not inside it
  { onBox: 'club-dj', id: 'i-dj', look: 'dj', inside: 'club', at: { u: 63.5, v: 67.6, yaw: Math.PI } },
  { id: 'i-club-1', look: 'patron', inside: 'club', at: { u: 46, v: 57, yaw: -Math.PI / 2 } },
  { id: 'i-club-2', look: 'woman', inside: 'club', at: { u: 49.5, v: 56.4, yaw: -Math.PI / 2 } },
  { id: 'i-club-3', look: 'local', inside: 'club', at: { u: 56, v: 57.4, yaw: -Math.PI / 2 } },
  { id: 'i-club-4', look: 'tourist', inside: 'club', at: { u: 41, v: 53, yaw: -Math.PI / 2 } },
  { id: 'i-patron-3', look: 'patron', inside: 'diner', at: { u: -25, v: 57.6, yaw: Math.PI / 2 } },
];

// ---------------------------------------------------------------------------------------------
// Walkability
// ---------------------------------------------------------------------------------------------

const inRect = (r: Rect, x: number, z: number): boolean => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
const inflate = (r: Rect, k: number): Rect => ({ x0: r.x0 - k, x1: r.x1 + k, z0: r.z0 - k, z1: r.z1 + k });

const ALL_DECKS: Array<{ r: Rect; top: number }> = MARINAS.flatMap((m) => marinaDeckBoxes(m).map((b) => ({
  r: { x0: b.cx - b.w / 2, x1: b.cx + b.w / 2, z0: b.cz - b.d / 2, z1: b.cz + b.d / 2 }, top: b.y + b.t / 2,
})));

/**
 * Height of the thing you stand on at world (x,z), or null if there is nothing to stand on (open
 * water, the edge of the pad). Deck planks win over the pad where they overlap — they never do
 * today, but the pier head meets the ramp at v = 8 exactly.
 */
export function groundAt(x: number, z: number): number | null {
  for (const d of ALL_DECKS) if (inRect(d.r, x, z)) return d.top;
  const [u, v] = toLocal(TOWN_FRAME, x, z);
  if (u >= RAMP.u0 && u <= RAMP.u1 && v >= RAMP.v0 && v <= RAMP.v1) {
    return DECK_TOP + (PAD_Y - DECK_TOP) * ((v - RAMP.v0) / (RAMP.v1 - RAMP.v0));
  }
  if (u >= PAD.u0 && u <= PAD.u1 && v >= PAD.v0 && v <= PAD.v1) return PAD_Y;
  return null;
}

/** Every solid thing a person collides with, in world AABBs. Computed once. */
export function buildColliders(): Rect[] {
  const f = TOWN_FRAME;
  const out: Rect[] = [];
  for (const l of LOTS) for (const w of lotWalls(l)) out.push(worldRect(f, w.u0, w.u1, w.v0, w.v1));
  for (const p of SOLID_PROPS) out.push(worldRect(f, p.u - p.w / 2, p.u + p.w / 2, p.v - p.d / 2, p.v + p.d / 2));
  for (const c of CARS) out.push(carRect(f, c));
  for (const b of INTERIOR_BOXES) out.push(worldRect(f, b.u0, b.u1, b.v0, b.v1));
  for (const m of MARINAS) out.push(marinaShedRect(m));
  return out;
}
export const COLLIDERS: readonly Rect[] = buildColliders();

/**
 * Closest point on any marina's deck to a world position, for tying up. `reach` is the farthest the
 * point may be from (x,z); null if the boat is nowhere near a dock. The returned point is pulled
 * 0.45 m inside the plank so a person placed there is standing on it, not on its edge.
 */
export function findBerth(x: number, z: number, reach: number): { marina: Marina; x: number; z: number; dist: number } | null {
  let best: { marina: Marina; x: number; z: number; dist: number } | null = null;
  for (const m of MARINAS) {
    for (const r of marinaDecks(m)) {
      const px = Math.max(r.x0, Math.min(r.x1, x)), pz = Math.max(r.z0, Math.min(r.z1, z));
      const dist = Math.hypot(px - x, pz - z);
      if (dist > reach || (best && dist >= best.dist)) continue;
      // inset from the plank edge, but never past the middle of a thin finger pier
      const ix = Math.min(0.45, (r.x1 - r.x0) / 2), iz = Math.min(0.45, (r.z1 - r.z0) / 2);
      const sx = Math.max(r.x0 + ix, Math.min(r.x1 - ix, px)), sz = Math.max(r.z0 + iz, Math.min(r.z1 - iz, pz));
      best = { marina: m, x: sx, z: sz, dist };
    }
  }
  return best;
}

/** True if (x,z) is inside the town pad grown by `margin`: used to keep the island's scattered
 * palms, houses and mangroves out of the streets (world/islands.ts). */
export function inTownFootprint(x: number, z: number, margin = 0): boolean {
  const [u, v] = toLocal(TOWN_FRAME, x, z);
  return u >= PAD.u0 - margin && u <= PAD.u1 + margin && v >= PAD.v0 - margin && v <= PAD.v1 + margin;
}

export { inRect, inflate };
