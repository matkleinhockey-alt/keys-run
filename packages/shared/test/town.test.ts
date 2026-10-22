/**
 * Boot Key Harbor City, asserted against the real world functions.
 *
 * The same discipline as apps/client/test/party-boats.test.ts: a coordinate typed into world/town.ts
 * is one terrain tweak away from putting a bar in the harbour, so none of it is trusted — every
 * building, prop, lamp, car and doorstep is checked against `landH`, `shoreInfo`, `creekDist` and
 * `depthAt` as they are today. If someone nudges the island or the marina, this fails loudly
 * instead of the player discovering a strip club on the seabed.
 */
import { describe, expect, it } from 'vitest';
import { MARINAS, landH, depthAt, creekDist } from '../src/world/depth.js';
import { shoreInfo, VACA } from '../src/world/chain.js';
import {
  TOWN_FRAME, TOWN_MARINA, PAD, PAD_Y, RAMP, DECK_TOP, LOTS, PALMS, LAMPS, BENCHES, CARS, SOLID_PROPS, INTERACTS,
  WALKWAYS, NPCS, INTERIOR_BOXES, SHOP_COUNTERS, COLLIDERS, DOOR_W, WALL_T, SURFACES,
  toWorld, toLocal, worldRect, carRect, lotWalls, groundAt, marinaDecks, marinaDeckBoxes, marinaShedRect, findBerth, inTownFootprint,
  type Rect,
} from '../src/world/town.js';
import { VENUES } from '../src/content/venues.js';
import { flood, nearestReached, STEP } from './walk-grid.js';

const F = TOWN_FRAME;
const overlap = (a: Rect, b: Rect, gap = 0): boolean => a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.z0 < b.z1 + gap && a.z1 > b.z0 - gap;
const uvRect = (u0: number, u1: number, v0: number, v1: number): Rect => worldRect(F, u0, u1, v0, v1);

/** A grid of world points across a local rect, edges and corners included. */
function samples(u0: number, u1: number, v0: number, v1: number, n = 9): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) out.push(toWorld(F, u0 + (u1 - u0) * (i / n), v0 + (v1 - v0) * (j / n)));
  return out;
}

describe('the frame', () => {
  it('is hung off the marina the game already names', () => {
    expect(TOWN_MARINA.name).toBe('Boot Key Harbor City Marina');
    expect(TOWN_MARINA).toBe(MARINAS[0]);
  });

  it('round-trips local and world, for both marina directions', () => {
    for (const m of MARINAS) {
      const f = { ox: m.sx, oz: m.sz, dir: m.dir as 1 | -1 };
      for (const [u, v] of [[0, 0], [13, -7], [-40, 100]] as const) {
        const [x, z] = toWorld(f, u, v);
        const [u2, v2] = toLocal(f, x, z);
        expect(u2).toBeCloseTo(u, 9);
        expect(v2).toBeCloseTo(v, 9);
      }
    }
  });

  it('puts inland (+v) on the land side of the shoreline', () => {
    // Boot Key Harbor City faces the harbour from Vaca's south shore: sea at +z, land at -z.
    const [, seaZ] = toWorld(F, 0, -30);
    const [, landZ] = toWorld(F, 0, 60);
    expect(landH(TOWN_MARINA.sx, landZ)).toBeGreaterThan(1);
    expect(landH(TOWN_MARINA.sx, seaZ)).toBeLessThan(0);
  });
});

describe('the pad stands on Vaca Key, not in the sea', () => {
  const pts = samples(PAD.u0, PAD.u1, PAD.v0, PAD.v1, 24);

  it('is entirely on the island Marathon (Vaca Key)', () => {
    for (const [x, z] of pts) expect(shoreInfo(x, z).isl?.name, `${x},${z}`).toBe(VACA.name);
  });

  it('is clear of every creek by a wide margin', () => {
    for (const [x, z] of pts) expect(creekDist(x, z), `${x},${z}`).toBeGreaterThan(40);
  });

  it('sits above the highest terrain under it, so no ground pokes through the streets', () => {
    let hi = -Infinity;
    for (const [x, z] of pts) hi = Math.max(hi, landH(x, z));
    expect(hi).toBeLessThan(PAD_Y - 0.15);
  });

  it('is built on fill that is only a few metres deep even at the seawall', () => {
    for (const [x, z] of samples(PAD.u0, PAD.u1, PAD.v0, PAD.v0 + 0.01, 24)) {
      expect(landH(x, z), `seawall at ${x},${z}`).toBeGreaterThan(-1.3);
    }
  });

  it('keeps every lot, prop and car on real dry land', () => {
    for (const l of LOTS) {
      for (const [x, z] of samples(l.u0, l.u1, l.v0, l.v1, 6)) expect(landH(x, z), `${l.id} at ${x},${z}`).toBeGreaterThan(1.1);
    }
    for (const c of CARS) {
      const r = carRect(F, c);
      for (const [x, z] of [[r.x0, r.z0], [r.x1, r.z1], [r.x0, r.z1], [r.x1, r.z0]]) expect(landH(x, z), `car ${c.id}`).toBeGreaterThan(0.5);
    }
  });

  it('is not inside the water anywhere a person can stand', () => {
    for (const [x, z] of samples(PAD.u0, PAD.u1, PAD.v0, PAD.v1, 24)) expect(groundAt(x, z)).toBe(PAD_Y);
  });
});

describe('the ramp and the docks', () => {
  it('rises from the pier head to the pad without a step the walker would refuse', () => {
    let prev = groundAt(...toWorld(F, 0, 7.9));
    expect(prev).toBe(DECK_TOP);
    for (let v = 8; v <= PAD.v0 + 0.5; v += 0.25) {
      const g = groundAt(...toWorld(F, 0, v));
      expect(g, `v=${v}`).not.toBeNull();
      expect(Math.abs(g! - prev!), `step at v=${v}`).toBeLessThan(0.1);
      prev = g;
    }
    expect(prev).toBe(PAD_Y);
  });

  it('starts at the end of the real pier', () => {
    // main pier = 56 m centred 20 seaward, so its inland end is 8 m up the beach
    const main = marinaDecks(TOWN_MARINA)[0];
    const [, zEnd] = toWorld(F, 0, RAMP.v0);
    const inland = F.dir > 0 ? main.z0 : main.z1;
    expect(Math.abs(zEnd - inland)).toBeLessThan(0.01);
  });

  it('has water under every dock and deep enough for a boat at its seaward end', () => {
    for (const m of MARINAS) {
      for (const b of marinaDeckBoxes(m)) {
        expect(landH(b.cx, b.cz), `${m.name} deck at ${b.cx},${b.cz}`).toBeLessThanOrEqual(0.2);
      }
      const T = marinaDeckBoxes(m)[1];
      // 6 m seaward of the T-head is where a boat lies alongside
      expect(depthAt(T.cx, T.cz + m.dir * 6), m.name).toBeGreaterThan(2.5);
    }
  });

  it('only lets people stand on deck at the other marinas — no phantom beach', () => {
    for (const m of MARINAS.slice(1)) {
      const [r0] = marinaDecks(m);
      const inlandEnd = m.dir > 0 ? r0.z0 - 3 : r0.z1 + 3;
      expect(groundAt(m.sx, inlandEnd), m.name).toBeNull();
      expect(groundAt(m.sx, (r0.z0 + r0.z1) / 2), m.name).toBe(DECK_TOP);
    }
  });

  it('finds a berth for a boat lying alongside, and not for one in open water', () => {
    for (const m of MARINAS) {
      const [main, T] = marinaDecks(m);
      // a boat 4 m off the side of the main pier, and 4 m off the T-head
      const side = findBerth(main.x1 + 4, (main.z0 + main.z1) / 2, 12);
      expect(side, `${m.name} side`).not.toBeNull();
      expect(groundAt(side!.x, side!.z), m.name).toBe(DECK_TOP);
      const head = findBerth((T.x0 + T.x1) / 2, m.sz + m.dir * 54, 12);
      expect(head, `${m.name} head`).not.toBeNull();
      expect(findBerth(m.sx + 400, m.sz + m.dir * 400, 12), m.name).toBeNull();
    }
  });
});

describe('the buildings', () => {
  const rects = LOTS.map((l) => ({ l, r: worldRect(F, l.u0, l.u1, l.v0, l.v1) }));

  it('has every venue the brief asked for, each a distinct building', () => {
    const venues = new Set(LOTS.map((l) => l.venue));
    for (const v of ['tackle', 'guns', 'bar', 'club', 'diner'] as const) expect(venues.has(v), v).toBe(true);
    expect(new Set(LOTS.map((l) => l.id)).size).toBe(LOTS.length);
    for (const l of LOTS) expect(VENUES[l.venue], l.id).toBeDefined();
  });

  it('keeps every lot inside the pad with a metre to spare, and out of the streets', () => {
    for (const l of LOTS) {
      expect(l.u0, l.id).toBeGreaterThanOrEqual(PAD.u0 + 1);
      expect(l.u1, l.id).toBeLessThanOrEqual(PAD.u1 - 1);
      expect(l.v0, l.id).toBeGreaterThanOrEqual(PAD.v0 + 1);
      expect(l.v1, l.id).toBeLessThanOrEqual(PAD.v1 - 1);
      for (const s of SURFACES.filter((s) => s.kind === 'road' || s.kind === 'sidewalk' || s.kind === 'promenade')) {
        const clear = l.u1 <= s.u0 || l.u0 >= s.u1 || l.v1 <= s.v0 || l.v0 >= s.v1;
        expect(clear, `${l.id} is on ${s.id}`).toBe(true);
      }
    }
  });

  it('does not overlap any other lot', () => {
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      expect(overlap(rects[i].r, rects[j].r), `${rects[i].l.id} / ${rects[j].l.id}`).toBe(false);
    }
  });

  it('puts each front door on its own frontage, wide enough to walk through', () => {
    for (const l of LOTS) {
      expect(l.door, l.id).toBeGreaterThan(l.u0 + DOOR_W / 2 + 0.5);
      expect(l.door, l.id).toBeLessThan(l.u1 - DOOR_W / 2 - 0.5);
    }
  });

  it('leaves the enterable buildings genuinely open at the door', () => {
    for (const l of LOTS.filter((x) => x.enterable)) {
      const [x, z] = toWorld(F, l.door, l.v0 + WALL_T / 2);
      expect(COLLIDERS.some((c) => x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1), `${l.id} door is blocked`).toBe(false);
      // and the walls that are there cover the rest of the front
      const front = lotWalls(l).filter((w) => w.v0 === l.v0 && w.v1 === l.v0 + WALL_T);
      expect(front).toHaveLength(2);
      expect(front[0].u1 + DOOR_W / 2).toBeCloseTo(l.door + 0, 6);
    }
  });

  it('is solid wall-to-wall for the buildings you cannot enter', () => {
    for (const l of LOTS.filter((x) => !x.enterable)) expect(lotWalls(l)).toHaveLength(1);
  });

  it('can be walked into only through the door gap', () => {
    for (const l of LOTS.filter((x) => x.enterable)) {
      // a line across the front wall at the door is clear; 2 m to either side of it is not
      const at = (du: number): boolean => { const [x, z] = toWorld(F, l.door + du, l.v0 + WALL_T / 2); return COLLIDERS.some((c) => x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1); };
      expect(at(0)).toBe(false);
      expect(at(DOOR_W / 2 + 0.5)).toBe(true);
      expect(at(-(DOOR_W / 2 + 0.5))).toBe(true);
    }
  });

  it('keeps the interior furniture inside its own building, off the walls and off the doorway', () => {
    for (const b of INTERIOR_BOXES) {
      const l = LOTS.find((x) => x.id === b.lot)!;
      expect(l.enterable, b.id).toBe(true);
      expect(b.u0, b.id).toBeGreaterThanOrEqual(l.u0 + WALL_T);
      expect(b.u1, b.id).toBeLessThanOrEqual(l.u1 - WALL_T);
      expect(b.v0, b.id).toBeGreaterThanOrEqual(l.v0 + WALL_T);
      expect(b.v1, b.id).toBeLessThanOrEqual(l.v1 - WALL_T);
      // the doorway runs straight in: a 2 m corridor from the door to mid-room stays clear
      const hall = { u0: l.door - 1, u1: l.door + 1, v0: l.v0, v1: l.v0 + 8 };
      expect(b.u1 <= hall.u0 || b.u0 >= hall.u1 || b.v1 <= hall.v0 || b.v0 >= hall.v1, `${b.id} blocks the entrance hall`).toBe(true);
    }
  });
});

describe('props, cars and people', () => {
  const buildingRects = LOTS.flatMap((l) => lotWalls(l).map((w) => worldRect(F, w.u0, w.u1, w.v0, w.v1)));

  it('keeps solid props and cars out of the buildings and out of each other', () => {
    const items: Array<{ id: string; r: Rect }> = [
      ...SOLID_PROPS.map((p) => ({ id: p.id, r: worldRect(F, p.u - p.w / 2, p.u + p.w / 2, p.v - p.d / 2, p.v + p.d / 2) })),
      ...CARS.map((c) => ({ id: c.id, r: carRect(F, c) })),
    ];
    for (const a of items) {
      for (const b of buildingRects) expect(overlap(a.r, b), `${a.id} is inside a building`).toBe(false);
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      expect(overlap(items[i].r, items[j].r), `${items[i].id} / ${items[j].id}`).toBe(false);
    }
  });

  it('puts every car, palm, lamp and prop inside the pad', () => {
    const inPad = (u: number, v: number): boolean => u >= PAD.u0 && u <= PAD.u1 && v >= PAD.v0 && v <= PAD.v1;
    for (const c of CARS) { const r = carRect(F, c); for (const [x, z] of [[r.x0, r.z0], [r.x1, r.z1]]) { const [u, v] = toLocal(F, x, z); expect(inPad(u, v), c.id).toBe(true); } }
    for (const p of PALMS) expect(inPad(p.u, p.v), `palm ${p.u},${p.v}`).toBe(true);
    for (const l of LAMPS) expect(inPad(l.u, l.v), `lamp ${l.u},${l.v}`).toBe(true);
    for (const b of BENCHES) expect(inPad(b.u, b.v)).toBe(true);
  });

  it('plants palms and lamps clear of the buildings', () => {
    for (const p of [...PALMS, ...LAMPS]) {
      const [x, z] = toWorld(F, p.u, p.v);
      for (const b of buildingRects) expect(x > b.x0 - 0.5 && x < b.x1 + 0.5 && z > b.z0 - 0.5 && z < b.z1 + 0.5, `${p.u},${p.v}`).toBe(false);
    }
  });

  it('does not park a car across the pier ramp or the avenue crossing', () => {
    const ramp = uvRect(RAMP.u0 - 1, RAMP.u1 + 1, RAMP.v0, RAMP.v1 + 12);
    for (const c of CARS) expect(overlap(carRect(F, c), ramp), c.id).toBe(false);
    const avenue = uvRect(-5, 5, 28, 100);
    for (const c of CARS) expect(overlap(carRect(F, c), avenue), c.id).toBe(false);
  });

  it('walks every pedestrian route over ground with nothing in the way', () => {
    for (const w of WALKWAYS) {
      for (let i = 0; i < w.pts.length - 1; i++) {
        const [u0, v0] = w.pts[i], [u1, v1] = w.pts[i + 1];
        const n = Math.ceil(Math.hypot(u1 - u0, v1 - v0) / 0.5);
        for (let k = 0; k <= n; k++) {
          const [x, z] = toWorld(F, u0 + ((u1 - u0) * k) / n, v0 + ((v1 - v0) * k) / n);
          expect(groundAt(x, z), `${w.id} off the pad`).toBe(PAD_Y);
          const blocked = COLLIDERS.some((c) => x > c.x0 - 0.3 && x < c.x1 + 0.3 && z > c.z0 - 0.3 && z < c.z1 + 0.3);
          expect(blocked, `${w.id} runs into something at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(false);
        }
      }
    }
  });

  it('puts every person on a route or on clear ground', () => {
    const routes = new Set(WALKWAYS.map((w) => w.id));
    for (const n of NPCS) {
      if (n.route) { expect(routes.has(n.route), n.id).toBe(true); continue; }
      expect(n.at, n.id).toBeDefined();
      const [x, z] = toWorld(F, n.at!.u, n.at!.v);
      const g = groundAt(x, z);
      expect(g, `${n.id} is not on the pad`).toBe(PAD_Y);
      const blocked = COLLIDERS.some((c) => x > c.x0 - 0.2 && x < c.x1 + 0.2 && z > c.z0 - 0.2 && z < c.z1 + 0.2);
      expect(blocked, `${n.id} is standing inside something`).toBe(false);
      if (n.inside) {
        const l = LOTS.find((q) => q.id === n.inside)!;
        expect(n.at!.u > l.u0 && n.at!.u < l.u1 && n.at!.v > l.v0 && n.at!.v < l.v1, `${n.id} is not inside ${n.inside}`).toBe(true);
      }
    }
  });

  it('puts every interaction point where a person can actually stand', () => {
    for (const i of INTERACTS) {
      const [x, z] = toWorld(F, i.u, i.v);
      expect(groundAt(x, z), i.id).toBe(PAD_Y);
      const inside = COLLIDERS.some((c) => x > c.x0 - 0.1 && x < c.x1 + 0.1 && z > c.z0 - 0.1 && z < c.z1 + 0.1);
      expect(inside, `${i.id} is inside a collider`).toBe(false);
      if (i.venue) expect(VENUES[i.venue], i.id).toBeDefined();
    }
    // every venue with a storefront can be reached
    for (const l of LOTS) expect(INTERACTS.some((i) => i.venue === l.venue), l.id).toBe(true);
  });

  it('lets a person reach the door of every shop (nothing walls off the sidewalk)', () => {
    for (const i of INTERACTS.filter((q) => q.id.startsWith('door-'))) {
      const [x, z] = toWorld(F, i.u, i.v);
      const blocked = COLLIDERS.some((c) => x > c.x0 - 0.32 && x < c.x1 + 0.32 && z > c.z0 - 0.32 && z < c.z1 + 0.32);
      expect(blocked, i.id).toBe(false);
    }
  });
});

describe('the island keeps out of the streets', () => {
  it('knows the footprint, with a margin', () => {
    const [x, z] = toWorld(F, 0, 90);
    expect(inTownFootprint(x, z)).toBe(true);
    expect(inTownFootprint(x, z - 2000)).toBe(false);
    const [ex, ez] = toWorld(F, PAD.u1 + 3, 90);
    expect(inTownFootprint(ex, ez)).toBe(false);
    expect(inTownFootprint(ex, ez, 6)).toBe(true);
  });

  it('has the harbourmaster\'s shed on the beach, seaward of the pad', () => {
    const shed = marinaShedRect(TOWN_MARINA);
    const [, v] = toLocal(F, (shed.x0 + shed.x1) / 2, (shed.z0 + shed.z1) / 2);
    expect(v).toBeLessThan(PAD.v0 - 3);
  });
});

describe('every walk-in venue is a room you can walk into', () => {
  type Lot = (typeof LOTS)[number];
  // Data-driven on purpose: a lot someone else turns walk-in later (the cabaret is being built separately) is
  // picked up by every test below the moment its `enterable` flips, with no edit here.
  const WALKIN = LOTS.filter((l) => l.enterable);
  const around = (l: Lot): { u0: number; u1: number; v0: number; v1: number } => ({ u0: l.u0 - 3, u1: l.u1 + 3, v0: l.v0 - 4, v1: l.v1 + 1 });
  const KEEPER = /bartender|cook|divemaster|baitman|gunsmith|clerk|pawnbroker|scooper|innkeeper|attendant/;

  it('keeps the lot, the venue table and the furniture in agreement about every door', () => {
    for (const l of LOTS) {
      expect(VENUES[l.venue].enterable, `${l.id}: venue table and lot disagree about the door`).toBe(l.enterable);
      expect(INTERIOR_BOXES.some((b) => b.lot === l.id), `${l.id}: furniture and lot disagree`).toBe(l.enterable);
    }
    // the brief's priorities: the dive shop, the tackle store and the gun counter can be walked into
    for (const id of ['dive', 'tackle', 'guns', 'bar', 'diner']) expect(LOTS.find((l) => l.id === id)!.enterable, id).toBe(true);
    expect(WALKIN.length).toBeGreaterThanOrEqual(12);
  });

  it('puts a shopkeeper behind a counter in every shop, facing the door', () => {
    for (const l of WALKIN) {
      expect(NPCS.filter((n) => n.inside === l.id && KEEPER.test(n.look)).length, `${l.id} has nobody behind the counter`).toBeGreaterThanOrEqual(1);
    }
    for (const c of SHOP_COUNTERS) {
      const box = INTERIOR_BOXES.find((b) => b.id === c.counter)!;
      expect(box.lot).toBe(c.lot);
      const keeper = NPCS.find((n) => n.id === `i-keeper-${c.lot}`)!;
      const prompt = INTERACTS.find((i) => i.id === `counter-${LOTS.find((l) => l.id === c.lot)!.venue}`)!;
      // inland of the counter, in the same column as the prompt point, looking toward the door
      expect(keeper.at!.v, c.lot).toBeGreaterThan(box.v1);
      expect(Math.abs(keeper.at!.u - prompt.u), c.lot).toBeLessThan(0.01);
      expect(keeper.at!.yaw, c.lot).toBeCloseTo(-Math.PI / 2, 6);
    }
  });

  it('puts the prompt point a metre in front of a counter the shopkeeper stands behind', () => {
    for (const c of SHOP_COUNTERS) {
      const l = LOTS.find((x) => x.id === c.lot)!;
      const i = INTERACTS.find((q) => q.id === `counter-${l.venue}`)!;
      const box = INTERIOR_BOXES.find((b) => b.id === c.counter)!;
      expect(i.u, c.lot).toBeGreaterThanOrEqual(box.u0);
      expect(i.u, c.lot).toBeLessThanOrEqual(box.u1);
      expect(box.v0 - i.v, c.lot).toBeGreaterThan(0.5);
      expect(box.v0 - i.v, c.lot).toBeLessThan(2);
      expect(i.u > l.u0 && i.u < l.u1 && i.v > l.v0 && i.v < l.v1, `${i.id} is outside its own shop`).toBe(true);
    }
  });

  it('keeps furniture from overlapping other furniture in the same room', () => {
    for (let i = 0; i < INTERIOR_BOXES.length; i++) for (let j = i + 1; j < INTERIOR_BOXES.length; j++) {
      const a = INTERIOR_BOXES[i], b = INTERIOR_BOXES[j];
      if (a.lot !== b.lot) continue;
      const clear = a.u1 <= b.u0 || a.u0 >= b.u1 || a.v1 <= b.v0 || a.v0 >= b.v1;
      expect(clear, `${a.id} / ${b.id}`).toBe(true);
    }
  });

  it('can be walked from the doorstep to the counter of every shop, by the walker\'s own rules', () => {
    for (const l of WALKIN) {
      const g = flood(l.door, l.v0 - 1.5, around(l));
      const counters = INTERACTS.filter((i) => i.venue === l.venue && i.id.startsWith('counter-'));
      expect(counters.length, l.id).toBeGreaterThan(0);
      for (const c of counters) {
        expect(nearestReached(g, c.u, c.v, 0.4), `${c.id} is walled off from the door of ${l.id}`).not.toBeNull();
      }
    }
  });

  it('leaves a real room to browse in, not a cupboard', () => {
    for (const l of WALKIN) {
      const g = flood(l.door, l.v0 - 1.5, around(l));
      let inside = 0;
      for (const k of g.seen.keys()) {
        const [i, j] = k.split(',').map(Number);
        const u = i * STEP, v = j * STEP;
        if (u > l.u0 && u < l.u1 && v > l.v0 && v < l.v1) inside++;
      }
      const m2 = inside * STEP * STEP, total = (l.u1 - l.u0) * (l.v1 - l.v0);
      expect(m2 / total, `${l.id}: ${m2.toFixed(0)} of ${total.toFixed(0)} m2 reachable`).toBeGreaterThan(0.3);
    }
  });

  it('only lets you in through the door: the street reaches the inside, and nothing leaks through the front wall', () => {
    for (const l of WALKIN) {
      const g = flood(l.door - 6, l.v0 - 1.5, around(l));
      const insideCell = [...g.seen.keys()].some((k) => {
        const [i, j] = k.split(',').map(Number);
        return i * STEP > l.u0 + WALL_T && i * STEP < l.u1 - WALL_T && j * STEP > l.v0 + WALL_T && j * STEP < l.v1 - WALL_T;
      });
      expect(insideCell, `${l.id}: the street never gets inside`).toBe(true);
      // and not through a wall: every reached cell on the front wall's line is within the door gap
      for (const k of g.seen.keys()) {
        const [i, j] = k.split(',').map(Number);
        const u = i * STEP, v = j * STEP;
        if (u > l.u0 && u < l.u1 && v > l.v0 && v < l.v0 + WALL_T) expect(Math.abs(u - l.door), `${l.id} leaks through its front wall at u=${u}`).toBeLessThan(DOOR_W / 2 + 0.01);
      }
    }
  });
});
