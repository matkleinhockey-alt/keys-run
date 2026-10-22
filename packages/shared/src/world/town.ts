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
import { CASINO_LOT, CASINO_BOXES, CASINO_INTERACTS } from './casino.js';

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
  | 'pawn' | 'laundromat' | 'icecream' | 'motel' | 'convenience' | 'dive' | 'casino';

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
  { id: 'tackle', venue: 'tackle', style: 'tackle', u0: -62, u1: -32, v0: 46, v1: 72, h: 5.2, door: -47, enterable: true },
  { id: 'guns', venue: 'guns', style: 'guns', u0: -86, u1: -62, v0: 46, v1: 70, h: 4.6, door: -74, enterable: true },
  { id: 'liquor', venue: 'liquor', style: 'liquor', u0: -100, u1: -86, v0: 46, v1: 66, h: 4.2, door: -93, enterable: true },
  // Row 1, east
  { id: 'bar', venue: 'bar', style: 'bar', u0: 8, u1: 34, v0: 46, v1: 70, h: 4.8, door: 21, enterable: true },
  { id: 'club', venue: 'club', style: 'club', u0: 34, u1: 68, v0: 46, v1: 72, h: 6.6, door: 44, enterable: true },
  { id: 'gifts', venue: 'gifts', style: 'gifts', u0: 68, u1: 100, v0: 46, v1: 68, h: 4.4, door: 84, enterable: true },
  // Row 2
  { id: 'pawn', venue: 'pawn', style: 'pawn', u0: -100, u1: -70, v0: 100, v1: 122, h: 4.6, door: -85, enterable: true },
  { id: 'laundromat', venue: 'laundromat', style: 'laundromat', u0: -70, u1: -44, v0: 100, v1: 120, h: 4.2, door: -57, enterable: true },
  { id: 'dive', venue: 'dive', style: 'dive', u0: -30, u1: -8, v0: 100, v1: 120, h: 4.4, door: -19, enterable: true },
  { id: 'motel', venue: 'motel', style: 'motel', u0: 8, u1: 60, v0: 100, v1: 124, h: 7.6, door: 20, enterable: true },
  { id: 'icecream', venue: 'icecream', style: 'icecream', u0: 60, u1: 80, v0: 100, v1: 118, h: 4.0, door: 70, enterable: true },
  { id: 'stopngo', venue: 'convenience', style: 'convenience', u0: 80, u1: 100, v0: 100, v1: 122, h: 4.4, door: 90, enterable: true },
  // The Gaff & Gill Casino, in the back lot at the top of Palm Avenue (world/casino.ts says why there).
  CASINO_LOT,
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
export type CarKind = 'sedan' | 'pickup' | 'convertible' | 'suv' | 'van' | 'wagon' | 'cart';
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
  { id: 'hd-2', u: -44, v: 29.4, rot: 0, kind: 'van', color: 0xe9e6dc },
  { id: 'hd-3', u: 24, v: 29.4, rot: 0, kind: 'wagon', color: 0x8a5a36 },
  { id: 'hd-4', u: -56, v: 38.4, rot: Math.PI, kind: 'sedan', color: col(2) },
  { id: 'hd-5', u: 14, v: 38.4, rot: Math.PI, kind: 'pickup', color: col(4) },
  { id: 'hd-6', u: 51, v: 38.4, rot: Math.PI, kind: 'convertible', color: 0xe86aa8 },
  { id: 'hd-7', u: 80, v: 38.4, rot: Math.PI, kind: 'cart', color: 0xe8e2c8 },
  // Back lane behind row 1
  { id: 'bl-1', u: -50, v: 77.4, rot: 0, kind: 'pickup', color: col(6) },
  { id: 'bl-2', u: 14, v: 77.4, rot: 0, kind: 'van', color: 0x2f6f8f },
  { id: 'bl-3', u: 50, v: 77.4, rot: 0, kind: 'suv', color: col(1) },
  { id: 'bl-4', u: 78, v: 77.4, rot: Math.PI, kind: 'cart', color: 0x3f6b4d },
  // Sombrero Boulevard
  { id: 'sb-1', u: -60, v: 85.4, rot: 0, kind: 'sedan', color: col(3) },
  { id: 'sb-2', u: 30, v: 94.6, rot: Math.PI, kind: 'pickup', color: col(2) },
  { id: 'sb-3', u: 70, v: 85.4, rot: 0, kind: 'wagon', color: 0xd9d4c0 },
  // Back lot, nose to the fence in rows
  ...[-84, -66, -48, -30, 30, 48, 66, 84].map((u, i): Car => ({
    id: `bk-${i}`, u, v: 134, rot: Math.PI / 2, kind: (['sedan', 'pickup', 'suv', 'sedan'] as const)[i % 4], color: col(i + 2),
  })),
  { id: 'trailer-1', u: -60, v: 150, rot: Math.PI / 2, kind: 'pickup', color: col(1), trailer: true },
  { id: 'trailer-2', u: 60, v: 150, rot: Math.PI / 2, kind: 'pickup', color: col(4), trailer: true },
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

/**
 * Furniture you walk around inside the enterable buildings: the bar and the diner (absolute
 * coordinates, as first laid out) and then every shop, written in the SHOP's own frame by `ib`.
 *
 * Shop frame: `a` is metres along the frontage from the lot's west wall (`u0`), `b` is metres inland
 * from its front wall (`v0`). The door is at `a = door - u0`. Wall thickness is 0.4, so a box that
 * should stand against a wall starts at 0.4. Each shop follows one plan, which is what makes
 * thirteen of them affordable to design AND to test:
 *
 *   - the first 8 m inland of the door, a 2 m wide strip centred on it, is left empty (the entrance
 *     hall: the doorway has to lead somewhere, and `town.test.ts` asserts it);
 *   - a COUNTER runs across the shop with the shopkeeper behind it and the shelf wall behind them,
 *     so what you see as you step in is the stock;
 *   - racks, tables and cases stand in the customer half, off the side walls where they are deep
 *     enough to matter and against them where they are not.
 *
 * Only what a customer can walk into is a box. Things on the keeper's side of the counter, and wall
 * dressing less than 0.4 m deep (a body is 0.32 radius, so it can't be pushed visibly into those),
 * are drawn by the client and have no footprint.
 */
const ib = (lot: string, id: string, a0: number, a1: number, b0: number, b1: number): InteriorBox => {
  const l = LOTS.find((x) => x.id === lot)!;
  // Clamp to the inner wall faces with the SAME arithmetic the tests use, so a counter that runs wall to
  // wall is not rejected by a float ulp (-30 + 21.6 !== -8 - 0.4 in IEEE doubles).
  return {
    id, lot,
    u0: Math.max(l.u0 + WALL_T, l.u0 + a0), u1: Math.min(l.u1 - WALL_T, l.u0 + a1),
    v0: Math.max(l.v0 + WALL_T, l.v0 + b0), v1: Math.min(l.v1 - WALL_T, l.v0 + b1),
  };
};

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
  // The service counter just inside the door. The long bar above runs along the west WALL, i.e.
  // down v, so it cannot be the SHOP_COUNTERS counter — that convention assumes a counter spanning
  // `a` with the customer at v0-1.1 and the keeper at v1+1.3.
  { id: 'club-counter', lot: 'club', u0: 48, u1: 60, v0: 52, v1: 53.6 },
  { id: 'club-booth-owner', lot: 'club', u0: 62, u1: 66.4, v0: 58, v1: 64 },
  { id: 'club-booth-1', lot: 'club', u0: 62, u1: 66.4, v0: 50, v1: 55 },
  { id: 'club-dj', lot: 'club', u0: 61, u1: 66, v0: 66, v1: 70 },

  // --- Scuba Steve's Dive & Spear (22 x 20, door at a = 11): suits west, tanks east, masks and fins in the middle
  ib('dive', 'dive-counter', 0.4, 21.6, 11.5, 13.1),
  ib('dive', 'dive-suits', 0.4, 1.6, 3.5, 10),
  ib('dive', 'dive-tanks', 20.4, 21.6, 3.5, 10),
  ib('dive', 'dive-masks', 3.5, 7.5, 5.5, 7.5),
  ib('dive', 'dive-fins', 14.5, 18.5, 5.5, 7.5),
  // --- Hook, Line & Sinker (30 x 26, door at a = 15): rods west, bait tank east, tackle aisles, ice freezer
  ib('tackle', 'tackle-counter', 0.4, 29.6, 16, 17.6),
  ib('tackle', 'tackle-rods', 0.4, 1.6, 3, 14),
  ib('tackle', 'tackle-bait', 27.4, 29.6, 3, 9),
  ib('tackle', 'tackle-aisle-1', 4, 12, 9, 10.2),
  ib('tackle', 'tackle-aisle-2', 18, 26, 9, 10.2),
  ib('tackle', 'tackle-freezer', 24, 29.6, 12.5, 14.5),
  // --- Deadeye Guns & Ammo (24 x 24, door at a = 12): spearguns west, caged long guns east, ammo wall
  ib('guns', 'guns-counter', 0.4, 23.6, 14, 15.6),
  ib('guns', 'guns-spears', 0.4, 1.6, 3, 11),
  ib('guns', 'guns-cage', 22.4, 23.6, 3, 11),
  ib('guns', 'guns-ammo', 8, 16, 8.6, 9.8),
  // --- Cheap Beer & Lotto (14 x 20, door at a = 7): wine west, beer cooler east, register
  ib('liquor', 'liquor-counter', 0.4, 13.6, 12, 13.6),
  ib('liquor', 'liquor-wine', 0.4, 1.6, 3, 10),
  ib('liquor', 'liquor-cooler', 12.4, 13.6, 3, 10),
  // --- Conch Republic Gifts (32 x 22, door at a = 16): shirt racks, shell table, hot sauce wall
  ib('gifts', 'gifts-counter', 0.4, 31.6, 14, 15.6),
  ib('gifts', 'gifts-shirts-1', 3, 8, 5, 6.4),
  ib('gifts', 'gifts-shirts-2', 24, 29, 5, 6.4),
  ib('gifts', 'gifts-shells', 12, 20, 9.5, 11.5),
  ib('gifts', 'gifts-hotsauce', 30.4, 31.6, 3, 11),
  ib('gifts', 'gifts-shirt-wall', 0.4, 1.6, 3, 11),
  // --- Keys Pawn & Loan (30 x 22, door at a = 15): guitar wall, jewellery cases, tool shelf, caged counter
  ib('pawn', 'pawn-counter', 0.4, 29.6, 12, 13.8),
  ib('pawn', 'pawn-guitars', 0.4, 1.4, 3, 10),
  ib('pawn', 'pawn-case-1', 5, 11, 8.6, 10),
  ib('pawn', 'pawn-case-2', 19, 25, 8.6, 10),
  ib('pawn', 'pawn-tools', 28.2, 29.6, 3, 11),
  // --- Suds & Sun Coin Laundry (26 x 20, door at a = 13): washers on the walls, folding table, desk
  ib('laundromat', 'laundry-desk', 4, 22, 14, 15.6),
  ib('laundromat', 'laundry-washers-w', 0.4, 1.8, 3, 12),
  ib('laundromat', 'laundry-washers-e', 24.2, 25.6, 3, 12),
  ib('laundromat', 'laundry-folding', 16, 22, 8.6, 10.2),
  ib('laundromat', 'laundry-vending', 3, 6, 8.6, 9.6),
  ib('laundromat', 'laundry-dryers', 0.4, 25.6, 18.8, 19.6),
  // --- Cone Zone (20 x 18, door at a = 10): the freezer counter, two cafe tables
  ib('icecream', 'ice-counter', 0.4, 19.6, 10, 11.6),
  ib('icecream', 'ice-table-1', 1.2, 4.2, 3, 5.6),
  ib('icecream', 'ice-table-2', 15.8, 18.8, 3, 5.6),
  // --- Sunset Motor Lodge (52 x 24, door at a = 12): a long front desk, sofas, vending, the stairs
  ib('motel', 'motel-desk', 2, 22, 10, 11.6),
  ib('motel', 'motel-sofa-1', 25, 29.5, 4, 6.5),
  ib('motel', 'motel-sofa-2', 33, 37.5, 4, 6.5),
  ib('motel', 'motel-vending', 49, 51.6, 4, 6.4),
  ib('motel', 'motel-stairs', 42, 51.6, 14, 23.6),
  ib('motel', 'motel-keys', 3, 21, 13.6, 13.9),
  // --- Stop-N-Go (20 x 22, door at a = 10): coolers west, snack wall east, two gondolas, register
  ib('stopngo', 'conv-counter', 0.4, 19.6, 15, 16.6),
  ib('stopngo', 'conv-cooler', 0.4, 1.8, 3, 13),
  ib('stopngo', 'conv-snacks', 18.2, 19.6, 3, 13),
  ib('stopngo', 'conv-aisle-1', 2.8, 8, 8.6, 9.8),
  ib('stopngo', 'conv-aisle-2', 12, 17.2, 8.6, 9.8),
  // The casino floor: banks of cabinets, the cage, a table, a fountain (world/casino.ts).
  ...CASINO_BOXES,
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

/**
 * Where you stand to deal with each shopkeeper: a metre in front of the counter, `a` metres along the
 * frontage (the shopkeeper stands at the same `a`, behind it). One per shop; the bar and the diner keep
 * their own, listed below. Keeping them as data next to `INTERIOR_BOXES` means the reachability test
 * walks the real walker from the doorstep to every one of them.
 */
export const SHOP_COUNTERS: ReadonlyArray<{ lot: string; counter: string; a: number; prompt: string }> = [
  { lot: 'dive', counter: 'dive-counter', a: 11, prompt: 'F  Talk to Steve at the counter' },
  { lot: 'tackle', counter: 'tackle-counter', a: 15, prompt: 'F  Ask about tackle' },
  { lot: 'guns', counter: 'guns-counter', a: 12, prompt: 'F  Step up to the counter' },
  { lot: 'liquor', counter: 'liquor-counter', a: 7, prompt: 'F  Pay at the register' },
  { lot: 'gifts', counter: 'gifts-counter', a: 16, prompt: 'F  Ring up at the till' },
  { lot: 'pawn', counter: 'pawn-counter', a: 15, prompt: 'F  Talk to the pawnbroker' },
  { lot: 'laundromat', counter: 'laundry-desk', a: 13, prompt: 'F  Ask the attendant' },
  { lot: 'icecream', counter: 'ice-counter', a: 10, prompt: 'F  Order a cone' },
  { lot: 'motel', counter: 'motel-desk', a: 12, prompt: 'F  Ring the front desk' },
  { lot: 'stopngo', counter: 'conv-counter', a: 10, prompt: 'F  Pay at the register' },
  // You own the Pink Flamingo, so nothing here charges you — the counter is where the staff are.
  { lot: 'club', counter: 'club-counter', a: 20, prompt: 'F  Lean on the bar' },
];

/** A person standing at `door` on the sidewalk is ~1 m off the wall; reach covers the whole frontage step. */
export const INTERACTS: readonly Interact[] = [
  // Buildings that are still solid get a door prompt (the doorman at the cabaret, the counter at the gun shop);
  // every walk-in building is served from the counter INSIDE it instead (see SHOP_COUNTERS below).
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
  ...SHOP_COUNTERS.map((c): Interact => {
    const l = LOTS.find((x) => x.id === c.lot)!, b = INTERIOR_BOXES.find((x) => x.id === c.counter)!;
    return { id: `counter-${l.venue}`, kind: 'venue', venue: l.venue, u: l.u0 + c.a, v: b.v0 - 1.1, r: 2.6, prompt: c.prompt };
  }),
  // The casino: one point per free cabinet, plus the change booth (world/casino.ts).
  ...CASINO_INTERACTS,
  { id: 'marlin', kind: 'plaque', u: 16, v: 22.2, r: 2.4, prompt: 'F  Read the plaque',
    text: 'BLUE MARLIN, 612 LB. Boated 1957 off Sombrero Reef. The plaque says "released" because the town got embarrassed.' },
];

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

// The people who WALK the street (and sit, queue, jog, load trucks) live in world/town-life.ts as scripts: pure
// functions of time, so the test can prove they stay on the sidewalks. What is left here are the figures that
// stand at a fixed spot, and the interior staff.

export type NpcLook =
  | 'tourist' | 'angler' | 'local' | 'woman' | 'bouncer' | 'bartender' | 'cook' | 'patron'
  // Pink Flamingo staff. 'dancer' is a performer on the stage, dressed the same way the boat's
  // own pole dancer and deck party already are (entities/boat/model.ts) — this game's register,
  // not a different one.
  | 'dancer' | 'mc' | 'dj'
  // behind the counter of the other shops: the person you are buying from
  | 'divemaster' | 'baitman' | 'gunsmith' | 'clerk' | 'pawnbroker' | 'scooper' | 'innkeeper' | 'attendant';
export interface Npc {
  id: string;
  look: NpcLook;
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
  /**
   * Drawn as a rigged, animated glTF figure instead of the procedural box-person. Data only (a name
   * the client maps to a model in entities/crew-model/asset.ts); shared never touches rendering.
   */
  rig?: 'stripper' | 'annie';
}

export const NPCS: readonly Npc[] = [
  { id: 's-bouncer', look: 'bouncer', at: { u: 41.2, v: 44.6, yaw: -Math.PI / 2 } },
  { id: 's-chat-1', look: 'tourist', at: { u: -41, v: 21.6, yaw: 0.4 } },
  { id: 's-chat-2', look: 'woman', at: { u: -39.4, v: 21.9, yaw: Math.PI + 0.4 } },
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
  // The two performers are the rigged models (Npc.rig); `look: 'dancer'` is what they fall back to if the
  // model cannot load. They stand 1.1 m in front of the poles (v 67), not at them: the clip swings both
  // arms wide and would pass through a pole 0.4 m behind.
  { onBox: 'club-stage', id: 'i-dancer-1', look: 'dancer', rig: 'stripper', inside: 'club', at: { u: 47, v: 65.9, yaw: -Math.PI / 2 } },
  { onBox: 'club-stage', id: 'i-dancer-2', look: 'dancer', rig: 'annie', inside: 'club', at: { u: 55, v: 65.9, yaw: -Math.PI / 2 } },
  { id: 'i-mc', look: 'mc', inside: 'club', at: { u: 51, v: 62.6, yaw: -Math.PI / 2 } },
  { onBox: 'club-dj', id: 'i-dj', look: 'dj', inside: 'club', at: { u: 63.5, v: 67.6, yaw: Math.PI } },
  { id: 'i-club-1', look: 'patron', inside: 'club', at: { u: 46, v: 57, yaw: -Math.PI / 2 } },
  { id: 'i-club-2', look: 'woman', inside: 'club', at: { u: 49.5, v: 56.4, yaw: -Math.PI / 2 } },
  { id: 'i-club-3', look: 'local', inside: 'club', at: { u: 56, v: 57.4, yaw: -Math.PI / 2 } },
  { id: 'i-club-4', look: 'tourist', inside: 'club', at: { u: 41, v: 53, yaw: -Math.PI / 2 } },
  { id: 'i-patron-3', look: 'patron', inside: 'diner', at: { u: -25, v: 57.6, yaw: Math.PI / 2 } },
  // Shopkeepers: one per shop, 1.3 m behind the counter at the same `a` as the interaction point, facing the
  // door (yaw -PI/2). Built from the SHOP_COUNTERS rows so a person cannot drift away from their counter.
  ...SHOP_COUNTERS.map((c): Npc => {
    const l = LOTS.find((x) => x.id === c.lot)!, b = INTERIOR_BOXES.find((x) => x.id === c.counter)!;
    const look = ({ dive: 'divemaster', tackle: 'baitman', guns: 'gunsmith', liquor: 'clerk', gifts: 'clerk', pawn: 'pawnbroker', laundromat: 'attendant', icecream: 'scooper', motel: 'innkeeper', stopngo: 'clerk', club: 'bartender' } as Record<string, NpcLook>)[c.lot];
    return { id: `i-keeper-${c.lot}`, look, inside: c.lot, at: { u: l.u0 + c.a, v: b.v1 + 1.3, yaw: -Math.PI / 2 } };
  }),
  // A few regulars so the busiest rooms are not staffed by one person
  { id: 'i-patron-tackle', look: 'angler', inside: 'tackle', at: { u: -41, v: 58, yaw: Math.PI / 2 } },
  { id: 'i-patron-motel', look: 'tourist', inside: 'motel', at: { u: 39, v: 108, yaw: Math.PI / 2 } },
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
