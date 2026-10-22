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
  NPCS, INTERIOR_BOXES, COLLIDERS, DOOR_W, WALL_T, SURFACES,
  toWorld, toLocal, worldRect, carRect, lotWalls, groundAt, marinaDecks, marinaDeckBoxes, marinaShedRect, findBerth, inTownFootprint,
  type Rect,
} from '../src/world/town.js';
import { VENUES } from '../src/content/venues.js';
import {
  PEOPLE, DOGS, SQUIRRELS, SKUNKS, CATS, GULLS, LITTER, PUDDLES, DECOR, WASHING, TRASH_CANS, BOLLARDS, STREET_PERIOD,
  sample, newPose, leashDog, gullAt, walkableAt, palmShape, palmTrunkAt,
} from '../src/world/town-life.js';

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

  it('puts every standing person on clear ground', () => {
    for (const n of NPCS) {
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

// ---------------------------------------------------------------------------------------------------------
// The street is alive: everything in world/town-life.ts, asserted against the real colliders.
//
// People are scripts (pure functions of time) whose period divides STREET_PERIOD, so sampling one
// STREET_PERIOD at 0.25 s is not a spot check: the street repeats exactly, and what holds over this window holds for
// ever. A walker is 0.6 m across, so the minimum separation tested below is 0.62 m; a 0.25 s step at 3.4 m/s (a
// jogger) is 0.85 m, and two figures closing head-on could therefore skip over a 0.62 m overlap — which is why the
// lanes themselves are checked to be at least 0.8 m apart wherever two scripts share a sidewalk (see the lane test).
// ---------------------------------------------------------------------------------------------------------
describe('the street is alive', () => {
  const lamps = LAMPS.map((l) => ({ u: l.u, v: l.v, r: 0.26 }));
  const cans = TRASH_CANS.map((c) => ({ u: c.u, v: c.v, r: 0.3 }));
  const bollards = BOLLARDS.map((c) => ({ u: c.u, v: c.v, r: 0.2 }));
  const decor = DECOR.map((d) => ({ u: d.u, v: d.v, r: d.kind === 'aframe' ? 0.45 : d.kind === 'bike-rack' ? 0.5 : 0.4 }));
  const round = [...lamps, ...cans, ...bollards, ...decor];
  const planters = PALMS.map((p) => ({ u0: p.u - 0.9, u1: p.u + 0.9, v0: p.v - 0.9, v1: p.v + 0.9 }));
  const standers = NPCS.filter((n) => !n.inside).map((n) => ({ id: n.id, u: n.at!.u, v: n.at!.v }));
  const RADIUS = 0.3;

  const colliderHit = (u: number, v: number, m: number): boolean => {
    const [x, z] = toWorld(F, u, v);
    return COLLIDERS.some((c) => x > c.x0 - m && x < c.x1 + m && z > c.z0 - m && z < c.z1 + m);
  };
  const furnitureHit = (u: number, v: number, m: number): string | null => {
    for (const o of round) if (Math.hypot(u - o.u, v - o.v) < o.r + m) return `a post at ${o.u},${o.v}`;
    for (const p of planters) if (u > p.u0 - m && u < p.u1 + m && v > p.v0 - m && v < p.v1 + m) return `a planter at ${(p.u0 + p.u1) / 2},${(p.v0 + p.v1) / 2}`;
    return null;
  };
  /** The part of the club's frontage that is the user's to design: velvet rope, carpet and bouncer. Nobody wanders across it. */
  const CLUB_DOOR = { u0: 40.2, u1: 47.8, v0: 40.2, v1: 46 };
  const benchRect = (i: number): { u0: number; u1: number; v0: number; v1: number } => ({ u0: BENCHES[i].u - 0.95 - 0.6, u1: BENCHES[i].u + 0.95 + 0.6, v0: BENCHES[i].v - 0.3 - 0.6, v1: BENCHES[i].v + 0.3 + 0.6 });

  it('gives every script a period that divides the street period, and closes it', () => {
    const all = [...PEOPLE.map((p) => p.script), ...DOGS.flatMap((d) => (d.script ? [d.script] : [])), ...SQUIRRELS.map((s) => s.script), ...SKUNKS.map((s) => s.script)];
    expect(all.length).toBeGreaterThan(40 - 1);
    for (const s of all) {
      expect(STREET_PERIOD % s.cycle, s.id).toBe(0);
      const a = sample(s, 0, newPose()), b = sample(s, s.cycle - 1e-6, newPose());
      // closed: the last instant of the loop is where the first begins
      expect(Math.hypot(a.u - b.u, a.v - b.v), `${s.id} does not close`).toBeLessThan(0.05);
    }
    expect(new Set([...PEOPLE.map((p) => p.id), ...DOGS.map((d) => d.id)]).size).toBe(PEOPLE.length + DOGS.length);
  });

  it('keeps every person on the sidewalk, the promenade, a crossing, the back lane or a doorway — and never in a wall, a post or a planter', () => {
    const bad: string[] = [];
    const pose = newPose();
    for (const p of PEOPLE) {
      const bench = p.bench === undefined ? null : benchRect(p.bench);
      for (let t = 0; t < p.script.cycle; t += 0.25) {
        sample(p.script, t, pose);
        if (pose.hidden) continue;
        const where = `${p.id} at ${pose.u.toFixed(2)},${pose.v.toFixed(2)} (t=${t}, beat ${pose.beat})`;
        if (!walkableAt(pose.u, pose.v)) { bad.push(`${where} is off the walkable ground`); break; }
        const [x, z] = toWorld(F, pose.u, pose.v);
        if (groundAt(x, z) !== PAD_Y) { bad.push(`${where} is off the pad`); break; }
        const onBench = bench && pose.u > bench.u0 && pose.u < bench.u1 && pose.v > bench.v0 && pose.v < bench.v1;
        if (!onBench && colliderHit(pose.u, pose.v, RADIUS - 0.02)) { bad.push(`${where} is in a wall or a prop`); break; }
        const f = onBench ? null : furnitureHit(pose.u, pose.v, RADIUS - 0.02);
        if (f) { bad.push(`${where} walks into ${f}`); break; }
        if (pose.u > CLUB_DOOR.u0 && pose.u < CLUB_DOOR.u1 && pose.v > CLUB_DOOR.v0 && pose.v < CLUB_DOOR.v1) { bad.push(`${where} is in the club's doorway`); break; }
      }
    }
    expect(bad).toEqual([]);
  });

  it('never lets two people overlap, over the whole repeating street', () => {
    const poses = PEOPLE.map(() => newPose());
    const bad = new Map<string, string>();
    for (let t = 0; t < STREET_PERIOD; t += 0.25) {
      PEOPLE.forEach((p, i) => sample(p.script, t, poses[i]));
      for (let i = 0; i < PEOPLE.length; i++) {
        const a = poses[i];
        if (a.hidden) continue;
        for (let j = i + 1; j < PEOPLE.length; j++) {
          const b = poses[j];
          if (b.hidden) continue;
          const together = PEOPLE[i].group && PEOPLE[i].group === PEOPLE[j].group;
          const d = Math.hypot(a.u - b.u, a.v - b.v);
          if (d < (together ? 0.5 : 0.62)) { const k = `${PEOPLE[i].id}/${PEOPLE[j].id}`; if (!bad.has(k)) bad.set(k, `${k} are ${d.toFixed(2)} m apart at t=${t} (${a.u.toFixed(1)},${a.v.toFixed(1)})`); }
        }
        for (const s of standers) {
          const d = Math.hypot(a.u - s.u, a.v - s.v);
          if (d < 0.62) { const k = `${PEOPLE[i].id}/${s.id}`; if (!bad.has(k)) bad.set(k, `${k} are ${d.toFixed(2)} m apart at t=${t}`); }
        }
      }
    }
    expect([...bad.values()]).toEqual([]);
  });

  it('only has a person disappear at a door, never in the open street', () => {
    const pose = newPose(), prev = newPose();
    for (const p of PEOPLE) {
      let was = false;
      for (let t = 0; t <= p.script.cycle; t += 0.25) {
        sample(p.script, t, pose);
        if (pose.hidden !== was) {
          // the instant before/after must be at a shop door, within a metre of it
          sample(p.script, pose.hidden ? t - 0.25 : t, prev);
          const at = pose.hidden ? prev : pose;
          const door = LOTS.find((l) => Math.abs(l.door - at.u) < 1.0 && Math.abs(at.v - l.v0) < 1.4);
          expect(door, `${p.id} vanishes at ${at.u.toFixed(1)},${at.v.toFixed(1)} t=${t}`).toBeDefined();
          was = pose.hidden;
        }
      }
    }
  });

  it('varies pace: nobody walks at one speed, and everybody stops sometimes', () => {
    const pose = newPose();
    for (const p of PEOPLE.filter((q) => q.script.segs.some((s) => s.kind === 'go'))) {
      const speeds = new Set<number>();
      let stops = 0;
      for (const s of p.script.segs) { if (s.kind === 'go') speeds.add(Math.round(s.speed * 10)); else stops++; }
      void pose;
      expect(stops, `${p.id} never pauses`).toBeGreaterThan(0);
      if (p.script.segs.filter((s) => s.kind === 'go').length > 2) expect(speeds.size, `${p.id} walks at one speed`).toBeGreaterThan(1);
    }
  });

  it('puts the person who is carrying something on the cooler job where the truck really is', () => {
    const truck = CARS.find((c) => c.id === 'bl-1')!;
    const r = carRect(F, truck);
    const loader = PEOPLE.find((p) => p.id === 'loader')!;
    // the cooler rests on the bed (inside the truck's footprint, 1 m up) for some beats and on the ground for others
    const bed = loader.rests!.filter((x) => x.y > 0.5);
    expect(bed.length).toBeGreaterThan(0);
    for (const b of bed) { const [x, z] = toWorld(F, b.u, b.v); expect(x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1, 'cooler is not on the bed').toBe(true); }
    for (const g of loader.rests!.filter((x) => x.y === 0)) expect(colliderHit(g.u, g.v, 0.1), 'cooler is on the ground inside something').toBe(false);
  });

  it('keeps every sitter on their bench, facing the water', () => {
    for (const p of PEOPLE.filter((q) => q.bench !== undefined)) {
      const b = BENCHES[p.bench!];
      const pose = sample(p.script, 0, newPose());
      expect(Math.abs(pose.u - b.u), p.id).toBeLessThan(0.95);
      expect(Math.abs(pose.v - b.v), p.id).toBeLessThan(0.3);
      expect(pose.yaw, p.id).toBeCloseTo(-Math.PI / 2, 1);
    }
  });

  it('puts dogs on clear ground, off their owner\'s heels and out of other people\'s way', () => {
    const owners = new Map(PEOPLE.map((p) => [p.id, p]));
    const op = newPose(), dp = newPose();
    const bad: string[] = [];
    for (const d of DOGS) {
      const ownerId = d.leash?.owner ?? d.tie?.owner;
      for (let t = 0; t < STREET_PERIOD; t += 0.5) {
        if (d.leash) { sample(owners.get(d.leash.owner)!.script, t, op); leashDog(op, d.leash, dp); }
        else sample(d.script!, t, dp);
        if (dp.hidden) continue;
        const where = `${d.id} at ${dp.u.toFixed(1)},${dp.v.toFixed(1)} t=${t}`;
        if (!walkableAt(dp.u, dp.v, true)) { bad.push(`${where} is off the ground`); break; }
        const bench = PEOPLE.filter((q) => q.bench !== undefined).some((q) => { const r = benchRect(q.bench!); return dp.u > r.u0 && dp.u < r.u1 && dp.v > r.v0 && dp.v < r.v1; });
        if (!bench && colliderHit(dp.u, dp.v, 0.2)) { bad.push(`${where} is in a wall or a prop`); break; }
        for (const p of PEOPLE) {
          if (p.id === ownerId) continue;
          const q = sample(p.script, t, newPose());
          if (!q.hidden && Math.hypot(q.u - dp.u, q.v - dp.v) < 0.5) { bad.push(`${where} is under ${p.id}'s feet`); break; }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps the tied dog tied: within a lead\'s length of its post, and the post is at a rack', () => {
    const dog = DOGS.find((d) => d.tie)!;
    const rack = DECOR.find((x) => x.kind === 'bike-rack' && Math.hypot(x.u - dog.tie!.u, x.v - dog.tie!.v) < 0.5);
    expect(rack, 'no rack to tie to').toBeDefined();
    const p = newPose();
    for (let t = 0; t < dog.script!.cycle; t += 1) { sample(dog.script!, t, p); expect(Math.hypot(p.u - dog.tie!.u, p.v - dog.tie!.v)).toBeLessThan(2.4); }
    // and its owner is somebody who actually goes into that shop
    const owner = PEOPLE.find((q) => q.id === dog.tie!.owner)!;
    expect(owner.script.segs.some((s) => s.kind === 'inside')).toBe(true);
  });

  it('runs the squirrels up the palm that is drawn, and across ground that exists', () => {
    for (const s of SQUIRRELS) {
      const p = newPose();
      let maxY = 0;
      for (let t = 0; t < s.script.cycle; t += 0.2) {
        sample(s.script, t, p);
        maxY = Math.max(maxY, p.y);
        expect(walkableAt(p.u, p.v, true) || p.y > 0.3 || Math.hypot(p.u - s.palm.u, p.v - s.palm.v) < 1.6, `${s.id} at ${p.u.toFixed(1)},${p.v.toFixed(1)} t=${t}`).toBe(true);
        if (p.y < 0.3) expect(colliderHit(p.u, p.v, 0.05), `${s.id} runs through a wall at ${p.u.toFixed(1)},${p.v.toFixed(1)}`).toBe(false);
        if (p.y > 0.6) {
          // on the trunk: within a trunk radius of the axis at that height
          const f = (p.y + PAD_Y - palmShape(s.palm).baseY) / palmShape(s.palm).height;
          const ax = palmTrunkAt(s.palm, Math.max(0, Math.min(1, f)));
          expect(Math.hypot(p.u - ax.u, p.v - ax.v), `${s.id} is off the trunk at y=${p.y.toFixed(2)}`).toBeLessThan(ax.r + 0.2);
        }
      }
      expect(maxY, `${s.id} never climbs`).toBeGreaterThan(2.5);
    }
  });

  it('keeps the skunks in the back lane, clear of the bins, the cars and the walls', () => {
    const bins = SOLID_PROPS.filter((q) => q.id.startsWith('dumpster'));
    for (const s of SKUNKS) {
      const p = newPose();
      for (let t = 0; t < s.script.cycle; t += 0.5) {
        sample(s.script, t, p);
        const where = `${s.id} at ${p.u.toFixed(1)},${p.v.toFixed(1)}`;
        expect(p.v > 72 && p.v < 80, `${where} left the lane`).toBe(true);
        expect(colliderHit(p.u, p.v, 0.2), `${where} is in a bin, car or wall`).toBe(false);
        for (const b of bins) expect(p.u > b.u - b.w / 2 - 0.2 && p.u < b.u + b.w / 2 + 0.2 && p.v > b.v - b.d / 2 - 0.2 && p.v < b.v + b.d / 2 + 0.2, `${where} is in a bin`).toBe(false);
      }
    }
    // one of them really does cross Palm Avenue, and stops in the middle of it
    const c = SKUNKS.find((s) => s.id === 'skunk-commuter')!;
    let crossed = false, froze = false;
    const p = newPose();
    for (let t = 0; t < c.script.cycle; t += 0.5) { sample(c.script, t, p); if (Math.abs(p.u) < 3) crossed = true; if (Math.abs(p.u) < 3 && p.stance === 'freeze') froze = true; }
    expect(crossed && froze).toBe(true);
  });

  it('keeps the cat on the dumpster lid and the gulls on real roofs and lamps', () => {
    for (const c of CATS) {
      const bin = SOLID_PROPS.find((q) => Math.abs(q.u - c.u) < q.w / 2 && Math.abs(q.v - c.v) < q.d / 2);
      expect(bin, 'the cat is not over a dumpster').toBeDefined();
      expect(c.y).toBeCloseTo(1.4, 1);
    }
    const g = { ...newPose(), flap: 0 };
    for (const gull of GULLS) {
      for (const pr of gull.perches) {
        const lot = LOTS.find((l) => pr.u > l.u0 && pr.u < l.u1 && Math.abs(pr.v - l.v0) < 0.2);
        const lamp = LAMPS.find((l) => l.u === pr.u && l.v === pr.v);
        expect(lot || lamp, `${gull.id} perches on nothing at ${pr.u},${pr.v}`).toBeTruthy();
        if (lot) expect(pr.y).toBeCloseTo(lot.h + 0.82, 3);
        if (lamp) expect(pr.y).toBeCloseTo(4.5, 1);
      }
      let flights = 0, was = false;
      for (let t = 0; t < 600; t += 0.1) { gullAt(gull, t, g); if (g.flap > 0 && !was) flights++; was = g.flap > 0; expect(g.y).toBeGreaterThan(0.5); }
      expect(flights, `${gull.id} never flies`).toBeGreaterThan(1);
    }
  });

  it('puts every scrap of litter, puddle and piece of street dressing on the pad and out of the buildings', () => {
    for (const l of LITTER) { expect(groundAt(...toWorld(F, l.u, l.v)), `litter ${l.u},${l.v}`).toBe(PAD_Y); expect(colliderHit(l.u, l.v, 0), `litter ${l.u},${l.v} is inside something`).toBe(false); }
    for (const p of PUDDLES) {
      for (const [du, dv] of [[0, 0], [p.rx, 0], [-p.rx, 0], [0, p.rz], [0, -p.rz]] as const) {
        const c = Math.cos(p.rot), s = Math.sin(p.rot), u = p.u + du * c - dv * s, v = p.v + du * s + dv * c;
        expect(groundAt(...toWorld(F, u, v)), `puddle ${p.u},${p.v}`).toBe(PAD_Y);
        expect(colliderHit(u, v, 0), `puddle ${p.u},${p.v} is under something`).toBe(false);
      }
    }
    for (const d of DECOR) { expect(groundAt(...toWorld(F, d.u, d.v)), d.id).toBe(PAD_Y); expect(colliderHit(d.u, d.v, 0.2), `${d.id} is inside a wall`).toBe(false); }
    const ids = DECOR.map((d) => d.id); expect(new Set(ids).size).toBe(ids.length);
    // a litter piece is not on top of the street dressing
    for (const l of LITTER) for (const d of DECOR) expect(Math.hypot(l.u - d.u, l.v - d.v), `litter at ${l.u},${l.v} is inside ${d.id}`).toBeGreaterThan(0.45);
  });

  it('strings the washing between two real walls, over open ground, above head height', () => {
    const laundromat = LOTS.find((l) => l.id === 'laundromat')!, dive = LOTS.find((l) => l.id === 'dive')!;
    expect(WASHING.u0).toBe(laundromat.u1);
    expect(WASHING.u1).toBe(dive.u0);
    expect(WASHING.v).toBeGreaterThan(Math.max(laundromat.v0, dive.v0));
    expect(WASHING.v).toBeLessThan(Math.min(laundromat.v1, dive.v1));
    expect(WASHING.y - WASHING.sag).toBeGreaterThan(2.2);
    expect(WASHING.y).toBeLessThan(Math.min(laundromat.h, dive.h));
    for (let u = WASHING.u0 + 0.5; u < WASHING.u1; u += 1) expect(colliderHit(u, WASHING.v, 0)).toBe(false);
  });

  it('varies the parked cars: more than one body style, more than a handful of colours', () => {
    const kinds = new Set(CARS.map((c) => c.kind));
    for (const k of ['sedan', 'pickup', 'convertible', 'suv', 'van', 'wagon', 'cart']) expect(kinds.has(k as never), k).toBe(true);
    expect(new Set(CARS.map((c) => c.color)).size).toBeGreaterThan(9);
  });
});
