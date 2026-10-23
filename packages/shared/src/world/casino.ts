/**
 * The Gaff & Gill Casino: where it stands, what is on its floor, and who works there.
 *
 * Pure placement data, in the town's local (u, v) frame — no rendering. It lives in its own file
 * rather than inside world/town.ts so that the casino is one `import` and four spread lines in that
 * file (it is edited by several agents at once), and so the cabinets, the people and their floor
 * plan sit together where one test can check them.
 *
 * ## Where it goes, and why there
 * The back lot (`back-lot`, v 126..172) is the only ground in town with room for a building this
 * size: the two street rows are packed. A casino at the top of Palm Avenue is also exactly where a
 * casino goes in a small town — at the end of the road, behind a car park. The lot is 48 x 26 m
 * centred on the avenue (u = 0), its door on the v0 face looking back down Palm Avenue to the harbour.
 * The two boat trailers that used to be parked there moved out to u = +-60 (town.ts, CARS), and the
 * three back-hedge palms at u = -30/0/30 stay where they are: they are at v = 168, behind the wall.
 *
 * ## The floor plan (everything here is a collider; client builds the meshes from the same boxes)
 *
 *   v=166  ┌──────────────── back bank (6) ───────────────┐
 *          │ W bank(4)   ISLAND W(8)  [FOUNTAIN]  ISLAND E(8)   E bank(4) │
 *          │ AQUARIUM                                           cage     │
 *          │ Go Fish table            hall (u -1..1)            booth    │
 *   v=140  └────────────────────── door (u=0) ────────────────┘
 *
 * 30 cabinets, five of which are occupied by punters (no interaction point, so you cannot play a
 * machine somebody is standing at). The entrance hall — 2 m wide, 8 m deep from the door — stays
 * clear, as test/town.test.ts requires of every enterable building.
 */
import type { InteriorBox, Interact, Lot } from './town.js';

/** Same value as WALL_T in town.ts (a test asserts they agree; importing it would be circular). */
const WALL = 0.4;

export const CASINO_LOT: Lot = {
  id: 'casino', venue: 'casino', style: 'casino', u0: -24, u1: 24, v0: 140, v1: 166, h: 8.6, door: 0, enterable: true,
};

/** The cosmetic theme names painted on the cabinets. Every machine pays the same published odds. */
export const CABINET_THEMES = [
  'Tarpon Run', 'Bonefish Flats', 'Permit Pursuit', 'Marlin Madness', 'Boot Camp', 'Chum Bucket', 'Reel Deal', 'Sea Legs',
] as const;

export interface Cabinet {
  id: string;
  /** Centre of the cabinet, local frame. */
  u: number; v: number;
  /** Width along the bank, depth into it. */
  w: number; d: number;
  /** Unit vector the screen faces (the way the player looks AT it is the opposite). */
  fu: number; fv: number;
  theme: number;
  /** Where a player stands to use it. */
  stand: { u: number; v: number };
  /** Somebody is already playing it. */
  occupied: boolean;
}

const PITCH = 2.0;
const DEPTH = 1.5;
/** How far the aquarium wall stands into the room. Everything on the west wall is set off by it. */
const TANK_D = 1.4;
const STAND = 1.0;

/** Machines the punters are playing, by cabinet id. */
const OCCUPIED = new Set(['slot-1', 'slot-6', 'slot-12', 'slot-19', 'slot-26']);

function build(): Cabinet[] {
  const out: Cabinet[] = [];
  let i = 0;
  const add = (u: number, v: number, fu: number, fv: number): void => {
    i++;
    const id = `slot-${i}`;
    out.push({
      id, u, v, w: PITCH, d: DEPTH, fu, fv, theme: i % CABINET_THEMES.length,
      stand: { u: u + fu * (DEPTH / 2 + STAND), v: v + fv * (DEPTH / 2 + STAND) }, occupied: OCCUPIED.has(id),
    });
  };
  // Island W and E: two cabinets deep, back to back; the front row looks at the door (-v), the rear row at the back wall (+v).
  for (const cu of [-15, -13, -11, -9, 9, 11, 13, 15]) {
    add(cu, 152 + DEPTH / 2, 0, -1);
    add(cu, 155 - DEPTH / 2, 0, 1);
  }
  // Back bank, flush to the back wall, looking at the door.
  for (const cu of [-5, -3, -1, 1, 3, 5]) add(cu, 166 - WALL - DEPTH / 2, 0, -1);
  // Side banks, looking into the room. The EAST bank is flush to its wall; the WEST bank stands
  // `TANK_D` off its own, because the whole west wall is now the aquarium and the machines are
  // set in front of the glass. That is the picture the room wants — a row of slots backed by a
  // lit reef — and it costs nothing but moving four cabinets a metre and a half.
  for (const cv of [156, 158, 160, 162]) {
    add(-24 + WALL + TANK_D + DEPTH / 2, cv, 1, 0);
    add(24 - WALL - DEPTH / 2, cv, -1, 0);
  }
  return out;
}
export const CABINETS: readonly Cabinet[] = build();

const box = (id: string, u0: number, u1: number, v0: number, v1: number): InteriorBox => ({ id, lot: 'casino', u0, u1, v0, v1 });

/** Colliders: each bank is ONE box (a wall of cabinets you walk around), plus the furniture. */
export const CASINO_BOXES: readonly InteriorBox[] = [
  box('casino-island-w', -16, -8, 152, 155),
  box('casino-island-e', 8, 16, 152, 155),
  box('casino-bank-back', -6, 6, 166 - WALL - DEPTH, 166 - WALL),
  box('casino-bank-w', -24 + WALL + TANK_D, -24 + WALL + TANK_D + DEPTH, 155, 163),
  box('casino-bank-e', 24 - WALL - DEPTH, 24 - WALL, 155, 163),
  // the change booth: a counter two metres thick against the east wall's front half, cashiers behind it
  box('casino-cage', 19, 21, 143, 151),
  // the Go Fish table (decor, and a dealer who will not deal you in)
  box('casino-table', -21.5, -16.5, 144, 148),
  // the marlin fountain in the middle of the floor
  box('casino-fountain', -2.6, 2.6, 155.6, 160.4),
  // THE AQUARIUM WALL — the whole west side of the room, end to end.
  //
  // It used to be a 6.4 m tank squeezed into the one gap between the Go Fish table and the west
  // cabinet bank. Making it the entire wall meant deciding what happens to the things that were
  // against that wall, and the answer is that they stand in FRONT of the glass: the cabinets moved
  // `TANK_D` into the room (see `build` above), which is the better picture anyway.
  //
  // It stops 1 m short of the back wall and 1.5 m short of the front so the corners read as corners
  // rather than the glass running into the brick. The entrance hall is untouched — that is a 2 m
  // strip on the centreline, twenty-two metres away.
  box('casino-aquarium', -24 + WALL, -24 + WALL + TANK_D, 141.5, 165),
  box('casino-pillar-w', -6.45, -5.55, 146, 147),
  box('casino-pillar-e', 5.55, 6.45, 146, 147),
];

export const CASINO_INTERACTS: readonly Interact[] = [
  ...CABINETS.filter((c) => !c.occupied).map((c): Interact => ({
    id: c.id, kind: 'venue', venue: 'casino', u: c.stand.u, v: c.stand.v, r: 1.15, prompt: 'F  Play the slots',
  })),
  { id: 'counter-casino', kind: 'venue', venue: 'casino', u: 17.9, v: 147, r: 2.4, prompt: 'F  Visit the change booth' },
];

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

export type CasinoLook = 'dealer' | 'cashier' | 'pitboss' | 'mascot' | 'punter';
export interface CasinoNpc {
  id: string;
  look: CasinoLook;
  /** Local-frame spot; `yaw` 0 faces +u, PI/2 faces +v (the same convention as world/town.ts Npc.at). */
  at: { u: number; v: number; yaw: number };
  /** Which of a look's costumes (shirt print, hat). */
  variant: number;
}

const faceing = (c: Cabinet): number => Math.atan2(-c.fv, -c.fu);

export const CASINO_NPCS: readonly CasinoNpc[] = [
  // Change booth: two cashiers behind the counter, looking west across it into the room
  { id: 'cashier-1', look: 'cashier', variant: 0, at: { u: 22.3, v: 145.2, yaw: Math.PI } },
  { id: 'cashier-2', look: 'cashier', variant: 1, at: { u: 22.3, v: 148.8, yaw: Math.PI } },
  // Go Fish: the dealer stands at the table's far side, looking at the door
  { id: 'dealer-1', look: 'dealer', variant: 0, at: { u: -19, v: 149.4, yaw: -Math.PI / 2 } },
  { id: 'dealer-2', look: 'dealer', variant: 1, at: { u: -19, v: 142.6, yaw: Math.PI / 2 } },
  // The pit boss walks the middle of the floor; the mascot works the door
  { id: 'pitboss', look: 'pitboss', variant: 0, at: { u: 3.8, v: 153.2, yaw: -Math.PI / 2 } },
  { id: 'mascot', look: 'mascot', variant: 0, at: { u: 3.4, v: 143.4, yaw: -Math.PI / 2 - 0.5 } },
  // Punters at the five occupied cabinets
  ...CABINETS.filter((c) => c.occupied).map((c, i): CasinoNpc => ({ id: `punter-${i + 1}`, look: 'punter', variant: i, at: { u: c.stand.u, v: c.stand.v, yaw: faceing(c) } })),
];
