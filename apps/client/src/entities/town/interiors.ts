/**
 * The twelve buildings you can walk into: the Rusty Anchor (bar), the Salty Dog Diner, and ten shops
 * (shops.ts holds what is on their shelves; this file builds the room around it).
 *
 * Built lazily and separately from the street. The exterior walls, door gap and roof already exist
 * (build.ts, from `lotWalls`); this adds what is behind the door — floor, wall skins, ceiling,
 * furniture, bottles, staff — and is only constructed the first time the camera comes within
 * `INTERIOR_BUILD_RANGE`, and only drawn within `INTERIOR_RANGE`. Furniture footprints come from
 * `INTERIOR_BOXES` in world/town.ts, the same boxes the walker collides with, so a booth you see is a
 * booth you walk around.
 *
 * Lighting: one merged halo batch (night only, `lightMats`) for glow, plus two `LightSource`s the
 * town's light pool may hand a real PointLight to when you are inside — a windowless room under a
 * solid roof is otherwise lit by nothing but the hemisphere term, which is flat and grey at noon.
 */
import * as THREE from 'three';
import { PAD_Y, INTERIOR_BOXES, NPCS, WALL_T, DOOR_W, type Lot } from '@keysrun/shared/world/town';
import { GeoBatch } from './batch.js';
import type { TownKit } from './kit.js';
import { floorTexture, type FloorKind } from './paint.js';
import { furnishShop } from './shops.js';
import { makePerson, type Person } from './people.js';
import { Zf } from './props.js';
import type { LightSource } from './build.js';
import { buildCasinoInterior } from './casino-interior.js';

/**
 * When to build a room and when to draw it, as distance from the camera to the lot's DOORWAY (not its
 * centre: a 52 m motel's centre is 26 m from the door that is the only way to see into it).
 *
 * These were 140 / 95 m from the lot centre when there were two interiors. At twelve that is most of the
 * street. Counted from the lot table: standing at the middle of Harbor Drive, 9 of the 12 rooms have
 * their centre inside 95 m, and 12 of 12 from Sombrero Boulevard; with this file's 36 m-from-the-door
 * rule it is 2 in both places. A room costs (measured, test/capture-town.mjs perf, same camera with the
 * town forced out vs. in): +30 draw calls and +38k triangles for the dive shop and for the motel lobby
 * with one shopkeeper each, so the old rule at twelve rooms would have put roughly +250 draw calls on a
 * street that measures +176 in total today. Nothing is lost by the tighter rule: a facade's windows are
 * painted on an opaque decal, and the only way to see in is the 2.8 m door gap.
 * Build is nearer still (70 m) and one room per frame (town.ts), so walking along the street never
 * stacks two floor textures, two batches and two shopkeepers (a `makeHuman` is ~15 meshes) into one frame.
 */
export const INTERIOR_BUILD_RANGE = 70;
export const INTERIOR_RANGE = 36;

/**
 * The look of each room's shell: walls, trim band, ceiling, floor pattern, and the albedo lift that
 * stands in for sunlight a windowless room never gets (see GeoBatch). The bar and diner rows are the
 * values this file always used; the rest were chosen against the same two rules: dark rooms (guns,
 * pawn) get the biggest lift because they start darkest, and nothing is pure white (a lifted
 * white clips to a flat sheet under the hemisphere light).
 */
interface RoomLook { wall: number; trim: number; ceil: number; floor: FloorKind; rep: number; lift: number; shade: number; ceilMax: number }
const ROOMS: Readonly<Record<string, RoomLook>> = {
  bar:        { wall: 0x9a7048, trim: 0x4a3524, ceil: 0x4a3826, floor: 'boards',   rep: 2.2, lift: 2.5, shade: 0x2f6b4a, ceilMax: 99 },
  diner:      { wall: 0xf1e8d6, trim: 0xc23a3a, ceil: 0xe6e2d6, floor: 'checker',  rep: 1.6, lift: 1.6, shade: 0xc23a3a, ceilMax: 99 },
  dive:       { wall: 0x4aa6b8, trim: 0xf1f4f5, ceil: 0xe6f0f2, floor: 'tile',     rep: 2.0, lift: 1.7, shade: 0x1ea5b8, ceilMax: 4.4 },
  tackle:     { wall: 0xd8c9a0, trim: 0x1f4f8c, ceil: 0xe9e4d4, floor: 'boards',   rep: 2.4, lift: 1.9, shade: 0x1f4f8c, ceilMax: 4.6 },
  guns:       { wall: 0x7a4a3c, trim: 0x16110f, ceil: 0x3a3532, floor: 'concrete', rep: 2.4, lift: 2.2, shade: 0x2a2d31, ceilMax: 4.4 },
  liquor:     { wall: 0xe8c868, trim: 0xb3202a, ceil: 0xeee6c8, floor: 'checker',  rep: 1.8, lift: 1.7, shade: 0xb3202a, ceilMax: 4.0 },
  gifts:      { wall: 0xf6b8a8, trim: 0x2bb3a8, ceil: 0xfff2dc, floor: 'boards',   rep: 2.6, lift: 1.7, shade: 0x2bb3a8, ceilMax: 4.2 },
  pawn:       { wall: 0x8a8860, trim: 0xf0c64a, ceil: 0x6a665a, floor: 'concrete', rep: 2.4, lift: 2.1, shade: 0xb3202a, ceilMax: 4.4 },
  laundromat: { wall: 0xcfe6f4, trim: 0x1d6fb3, ceil: 0xf2f6f8, floor: 'checker',  rep: 1.8, lift: 1.5, shade: 0xdff3ff, ceilMax: 4.0 },
  icecream:   { wall: 0xf7c6d6, trim: 0x7fd8d0, ceil: 0xfff6ee, floor: 'tile',     rep: 1.8, lift: 1.6, shade: 0xf7a7c6, ceilMax: 3.8 },
  motel:      { wall: 0xe6d3b0, trim: 0x7a3a2c, ceil: 0xd8d0be, floor: 'carpet',   rep: 2.4, lift: 1.9, shade: 0xe0b34a, ceilMax: 4.6 },
  stopngo:    { wall: 0xeef1f2, trim: 0xd9342b, ceil: 0xf4f6f6, floor: 'lino',     rep: 1.6, lift: 1.4, shade: 0xdff3ff, ceilMax: 4.2 },
  // The Pink Flamingo keeps its full height — the room is the one place in town where the ceiling
  // being far away is the point, and the stage lighting plays against it.
  club:       { wall: 0x1a0d18, trim: 0x5a1340, ceil: 0x120812, floor: 'boards',   rep: 2.2, lift: 2.3, shade: 0xff3ea5, ceilMax: 99 },
};

/**
 * Floor textures are 256 px canvases; twelve rooms need at most six distinct ones. They are shared
 * across rooms and reference-counted, so building the whole street costs six uploads, not twelve,
 * and the last room to go takes the texture with it.
 */
const floorCache = new Map<FloorKind, { tex: THREE.CanvasTexture; refs: number }>();
function acquireFloor(kind: FloorKind): THREE.CanvasTexture {
  let e = floorCache.get(kind);
  if (!e) { e = { tex: floorTexture(kind), refs: 0 }; floorCache.set(kind, e); }
  e.refs++;
  return e.tex;
}
function releaseFloor(kind: FloorKind): void {
  const e = floorCache.get(kind);
  if (e && --e.refs <= 0) { e.tex.dispose(); floorCache.delete(kind); }
}

export interface Interior {
  lot: Lot;
  group: THREE.Group;
  people: Person[];
  lights: LightSource[];
  /** Optional per-frame hook while the room is drawn: `cam` is the camera in the town's local frame (x = u, z = -v). */
  animate?(t: number, cam: THREE.Vector3): void;
  dispose(): void;
}

export function buildInterior(lot: Lot, kit: TownKit): Interior {
  if (lot.id === 'casino') return buildCasinoInterior(lot, kit); // its own file: a neon room that must not touch this one's lights
  const group = new THREE.Group();
  group.name = `interior-${lot.id}`;
  const look = ROOMS[lot.id];
  // No sun reaches a windowless room under a solid roof, so its albedo is lifted uniformly (see GeoBatch).
  const solid = new GeoBatch(false, look.lift), glow = new GeoBatch(true);
  const lights: LightSource[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const isBar = lot.id === 'bar';
  const isClub = lot.id === 'club';
  // The bar and diner keep their full-height rooms; a tall shop (the motel is 7.6 m, the tackle
  // store 5.2 m) gets a ceiling at a human 3.8-4.6 m instead of a barn. The outside roof does not
  // change. The cabaret opts out via its own ceilMax: see ROOMS.club.
  const y0 = PAD_Y + 0.04, H = Math.min(lot.h, look.ceilMax);
  const x0 = lot.u0 + WALL_T, x1 = lot.u1 - WALL_T, v0 = lot.v0 + WALL_T, v1 = lot.v1 - WALL_T;
  const cx = (x0 + x1) / 2;

  // floor
  {
    const w = x1 - x0, d = v1 - v0;
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    const rep = look.rep;
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / rep), uv.getY(i) * (d / rep));
    const tex = acquireFloor(look.floor);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: look.floor === 'checker' || look.floor === 'tile' ? 0.35 : 0.85, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    // no receiveShadow in here: the sun never reaches a room under a solid roof, and a cascade lookup on the
    // ceiling just paints shadow-acne blotches over it (seen in the first interior captures)
    const m = new THREE.Mesh(g, mat); m.position.set(cx, y0, Zf((v0 + v1) / 2)); group.add(m);
    geos.push(g); mats.push(mat);
  }
  // wall skins and ceiling, in the room's own colours (the exterior boxes are the outside paint)
  // Colours come from ROOMS, including the cabaret's magenta-on-near-black — one table rather
  // than a chain of per-room ternaries.
  const wall = look.wall, trim = look.trim, ceil = look.ceil;
  const sk = 0.03;
  solid.span(x0, x1, y0, PAD_Y + H - 0.1, Zf(v1) + sk, Zf(v1) + 0.0 + sk * 2, wall);
  solid.span(x0, x0 + sk, y0, PAD_Y + H - 0.1, Zf(v1), Zf(v0), wall);
  solid.span(x1 - sk, x1, y0, PAD_Y + H - 0.1, Zf(v1), Zf(v0), wall);
  // front wall skin, either side of the doorway
  const dl = lot.door - DOOR_W / 2, dr = lot.door + DOOR_W / 2;
  solid.span(x0, dl, y0, PAD_Y + H - 0.1, Zf(v0) - sk * 2, Zf(v0) - sk, wall);
  solid.span(dr, x1, y0, PAD_Y + H - 0.1, Zf(v0) - sk * 2, Zf(v0) - sk, wall);
  // The ceiling is an UNLIT plane. Lit, a 24 x 24 m flat ceiling 1.8 m above a point light showed large
  // concentric blotches of banding in the first interior captures (hemisphere ground-colour + a near
  // hotspot, quantised); an interior ceiling is never the thing to look at, so it is flat colour.
  {
    const g = new THREE.PlaneGeometry(x1 - x0, v1 - v0).rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: ceil });
    const m = new THREE.Mesh(g, mat); m.position.set(cx, PAD_Y + H - 0.1, Zf((v0 + v1) / 2)); group.add(m);
    geos.push(g); mats.push(mat);
  }
  // wainscot / red band
  solid.span(x0 + sk, x1 - sk, y0, y0 + 1.0, Zf(v1) + 0.04, Zf(v1) + 0.06, trim);
  solid.span(x0 + sk, x0 + sk * 2, y0, y0 + 1.0, Zf(v1), Zf(v0), trim);
  solid.span(x1 - sk * 2, x1 - sk, y0, y0 + 1.0, Zf(v1), Zf(v0), trim);
  if (isBar) for (let u = x0 + 3; u < x1; u += 6) solid.span(u, u + 0.35, PAD_Y + H - 0.5, PAD_Y + H - 0.12, Zf(v1), Zf(v0), 0x1f160e); // ceiling beams

  /**
   * A ceiling lamp, and (only while you stand in this room) a candidate for one of the town's four real
   * PointLights. `bell` is the pendant the bar and diner always had; `tube` is a flush fluorescent strip
   * (laundromat, liquor, convenience: a bell pendant in a gas station reads as a bar). Every kind is the same two additive quads plus one LightSource, so the
   * choice is free at runtime and the real-light budget is untouched by how many lamps a room has.
   */
  const pend = (u: number, v: number, c: number, kind: 'bell' | 'tube' = 'bell'): void => {
    const ceilY = PAD_Y + H - 0.1;
    if (kind === 'tube') {
      solid.span(u - 1.1, u + 1.1, ceilY - 0.14, ceilY - 0.06, Zf(v) - 0.14, Zf(v) + 0.14, 0xf2f6f8);
      glow.halo(u, ceilY - 0.4, Zf(v), 2.2, c); glow.pool(u, y0 + 0.05, Zf(v), 5.0, c);
      lights.push({ x: u, y: ceilY - 0.6, z: Zf(v), color: c, kind: 'lamp', lot: lot.id });
    } else {
      solid.cyl(u, PAD_Y + H - 1.15, Zf(v), 0.02, 0.02, 1.0, 0x1f160e, 4);
      solid.cyl(u, PAD_Y + H - 1.7, Zf(v), 0.1, 0.36, 0.55, look.shade, 10);
      glow.halo(u, PAD_Y + H - 1.75, Zf(v), 2.1, c);
      glow.pool(u, y0 + 0.05, Zf(v), 4.6, c);
      lights.push({ x: u, y: PAD_Y + H - 1.8, z: Zf(v), color: c, kind: 'lamp', lot: lot.id });
    }
  };

  const box = (id: string): { u0: number; u1: number; v0: number; v1: number } => INTERIOR_BOXES.find((b) => b.id === id)!;
  const stoolRow = (ua: number, ub: number, v: number, n: number, c: number): void => {
    for (let i = 0; i < n; i++) { const u = ua + ((ub - ua) * (i + 0.5)) / n; solid.cyl(u, y0, Zf(v), 0.05, 0.06, 0.62, 0x9aa0a6, 6); solid.cyl(u, y0 + 0.62, Zf(v), 0.22, 0.22, 0.1, c, 10); }
  };
  const booth = (b: { u0: number; u1: number; v0: number; v1: number }, wallSide: 'w' | 'e', seat: number): void => {
    const sd = wallSide === 'w' ? b.u0 : b.u1;
    solid.span(b.u0, b.u1, y0, y0 + 0.5, Zf(b.v0 + 0.95), Zf(b.v0), seat);
    solid.span(b.u0, b.u1, y0, y0 + 0.5, Zf(b.v1), Zf(b.v1 - 0.95), seat);
    solid.span(Math.min(sd, sd + (wallSide === 'w' ? 0.2 : -0.2)), Math.max(sd, sd + (wallSide === 'w' ? 0.2 : -0.2)), y0 + 0.5, y0 + 1.3, Zf(b.v1), Zf(b.v0), seat);
    solid.span(b.u0 + 0.35, b.u1 - 0.35, y0 + 0.74, y0 + 0.8, Zf(b.v1 - 1.05), Zf(b.v0 + 1.05), isBar ? 0x8a5a36 : 0xf4f4f2);
    solid.cyl((b.u0 + b.u1) / 2, y0, Zf((b.v0 + b.v1) / 2), 0.07, 0.07, 0.74, 0x9aa0a6, 6);
  };

  if (isClub) {
    // The Pink Flamingo, under new management: the rope is down because the player owns it.
    // Everything here is emissive rather than lit — the town's light pool is only four PointLights
    // with hysteresis (entities/town/lights.ts), and a nightclub is exactly the room that would
    // eat all of them. Magenta neon on near-black does the work for free.
    const st = box('club-stage');
    // raised stage with a lit lip
    solid.span(st.u0, st.u1, y0, y0 + 0.9, Zf(st.v1), Zf(st.v0), 0x241022);
    solid.span(st.u0, st.u1, y0 + 0.9, y0 + 0.96, Zf(st.v1), Zf(st.v0), 0x3a1a34);
    solid.span(st.u0, st.u1, y0 + 0.62, y0 + 0.72, Zf(st.v0 - 0.06), Zf(st.v0 - 0.12), 0xff3ea5);
    glow.pool((st.u0 + st.u1) / 2, y0 + 0.98, Zf((st.v0 + st.v1) / 2), 14, 0xff3ea5);
    // two poles, floor to ceiling, because the Midnight Express already has one and this is where
    // it belongs
    for (const pu of [st.u0 + 5, st.u1 - 5]) {
      solid.cyl(pu, y0 + 0.96, Zf((st.v0 + st.v1) / 2), 0.07, 0.07, H - 1.1, 0xd8d2cc, 10);
      glow.halo(pu, y0 + 2.4, Zf((st.v0 + st.v1) / 2), 2.2, 0xff6ec0);
    }
    // back-wall neon: the flamingo, plus a strip each side
    glow.halo(cx + 4, y0 + 4.2, Zf(v1) + 0.3, 5.2, 0xff3ea5);
    glow.halo(cx - 8, y0 + 3.6, Zf(v1) + 0.3, 2.0, 0x38e0ff);
    glow.halo(cx + 16, y0 + 3.6, Zf(v1) + 0.3, 2.0, 0x8a3cff);

    // bar down the west wall
    const cb = box('club-bar');
    solid.span(cb.u0, cb.u1, y0, y0 + 1.08, Zf(cb.v1), Zf(cb.v0), 0x2a1026);
    solid.span(cb.u0 - 0.1, cb.u1 + 0.1, y0 + 1.08, y0 + 1.16, Zf(cb.v1 + 0.1), Zf(cb.v0 - 0.15), 0x6a2250);
    glow.halo(cb.u1 + 0.4, y0 + 1.6, Zf((cb.v0 + cb.v1) / 2), 2.4, 0x38e0ff);
    stoolRow(cb.v0 + 1, cb.v1 - 1, cb.v0, 0, 0x000000); // no stools along v; booths carry the seating

    // the owner's booth — bigger, its own light, and it faces the stage
    const ob = box('club-booth-owner');
    booth(ob, 'e', 0x7a1f52);
    glow.pool((ob.u0 + ob.u1) / 2, y0 + 0.06, Zf((ob.v0 + ob.v1) / 2), 5.5, 0xffd36e);
    glow.halo((ob.u0 + ob.u1) / 2, y0 + 2.2, Zf((ob.v0 + ob.v1) / 2), 1.8, 0xffc24a);
    booth(box('club-booth-1'), 'e', 0x4a1636);

    // DJ booth in the back corner
    const dj = box('club-dj');
    solid.span(dj.u0, dj.u1, y0, y0 + 1.2, Zf(dj.v1), Zf(dj.v0), 0x1d0c1a);
    solid.span(dj.u0, dj.u1, y0 + 1.2, y0 + 1.26, Zf(dj.v1), Zf(dj.v0), 0x3a1a34);
    glow.halo((dj.u0 + dj.u1) / 2, y0 + 1.5, Zf((dj.v0 + dj.v1) / 2), 1.6, 0x38ff9e);
  } else if (isBar) {
    const c = box('bar-counter');
    solid.span(c.u0, c.u1, y0, y0 + 1.08, Zf(c.v1), Zf(c.v0), 0x3a2a1c);
    solid.span(c.u0 - 0.1, c.u1 + 0.1, y0 + 1.08, y0 + 1.16, Zf(c.v1 + 0.1), Zf(c.v0 - 0.15), 0x9a6a3c);
    solid.span(c.u0, c.u1, y0 + 0.25, y0 + 0.3, Zf(c.v0 - 0.18), Zf(c.v0 - 0.12), 0xe0b34a); // brass foot rail
    stoolRow(c.u0 + 0.5, c.u1 - 0.5, c.v0 - 0.7, 7, 0xa11b1b);
    // back bar: mirror, two shelves of bottles
    solid.span(c.u0, c.u1, y0 + 0.9, y0 + 2.9, Zf(v1) - 0.02, Zf(v1) - 0.0, 0xbfd3dc);
    for (const sy of [1.55, 2.2]) {
      solid.span(c.u0, c.u1, y0 + sy, y0 + sy + 0.05, Zf(v1) + 0.35, Zf(v1) + 0.0, 0x8a5a36);
      for (let i = 0; i < 18; i++) solid.cyl(c.u0 + 0.5 + i * 1.0, y0 + sy + 0.05, Zf(v1) + 0.18, 0.07, 0.09, 0.32, [0x2f6b4a, 0xb8741a, 0xc23a3a, 0x3a6ea5, 0xd9d4a0][i % 5], 6);
    }
    glow.halo(cx - 4, y0 + 3.3, Zf(v1) + 0.1, 1.8, 0x58b6ff); glow.halo(cx + 4, y0 + 3.3, Zf(v1) + 0.1, 1.8, 0xff4b3a);
    solid.span(cx - 5.2, cx - 2.8, y0 + 3.05, y0 + 3.55, Zf(v1) + 0.04, Zf(v1), 0x1a2a40); solid.span(cx + 2.8, cx + 5.2, y0 + 3.05, y0 + 3.55, Zf(v1) + 0.04, Zf(v1), 0x401a1a);
    // jukebox by the back-left corner
    const jx = x0 + 1.4, jv = v1 - 1.2;
    solid.span(jx - 0.55, jx + 0.55, y0, y0 + 1.7, Zf(jv) + 0.35, Zf(jv) - 0.35, 0x7a2c1c); solid.span(jx - 0.4, jx + 0.4, y0 + 0.9, y0 + 1.5, Zf(jv) + 0.37, Zf(jv) + 0.34, 0xffd070);
    glow.halo(jx, y0 + 1.2, Zf(jv) + 0.6, 1.6, 0xffb040);
    // pool table
    const p = box('bar-pool');
    solid.span(p.u0, p.u1, y0 + 0.78, y0 + 0.9, Zf(p.v1), Zf(p.v0), 0x1f6b3a); solid.span(p.u0 - 0.15, p.u1 + 0.15, y0 + 0.9, y0 + 1.0, Zf(p.v1 + 0.15), Zf(p.v0 - 0.15), 0x5a3a20);
    for (const [ux, vz] of [[p.u0, p.v0], [p.u1, p.v0], [p.u0, p.v1], [p.u1, p.v1]] as const) solid.span(ux - 0.15, ux + 0.15, y0, y0 + 0.78, Zf(vz) - 0.15, Zf(vz) + 0.15, 0x3a2412);
    for (let i = 0; i < 5; i++) solid.ball(p.u0 + 3 + (i % 3) * 0.2, y0 + 0.96, Zf(p.v0 + 1.6 + i * 0.2), 0.06, [0xf2c14e, 0xc23a3a, 0x2b4a9a, 0xf2f2f2, 0x15171a][i], 1, 6);
    booth(box('bar-booth-1'), 'e', 0x8e2a2a); booth(box('bar-booth-2'), 'e', 0x8e2a2a);
    pend(14, 54, 0xffc070); pend(27, 54, 0xffc070); pend(21, 64, 0xffb060);
  } else if (lot.id === 'diner') {
    const c = box('diner-counter');
    solid.span(c.u0, c.u1, y0, y0 + 1.05, Zf(c.v1), Zf(c.v0), 0xe8edf1);
    solid.span(c.u0 - 0.1, c.u1 + 0.1, y0 + 1.05, y0 + 1.12, Zf(c.v1 + 0.1), Zf(c.v0 - 0.12), 0x22262c);
    solid.span(c.u0, c.u1, y0, y0 + 0.25, Zf(c.v0), Zf(c.v0 - 0.1), 0xc23a3a);
    stoolRow(c.u0 + 0.5, c.u1 - 0.5, c.v0 - 0.65, 6, 0xc23a3a);
    // pass-through to the kitchen, a heat lamp strip and the coffee machine
    solid.span(c.u0, c.u1, y0 + 1.7, y0 + 2.4, Zf(c.v1 + 3.2), Zf(c.v1 + 3.0), 0xc9ced3);
    solid.span(c.u0 + 1, c.u0 + 2.2, y0 + 1.12, y0 + 1.7, Zf(c.v1 + 0.9), Zf(c.v1 + 0.4), 0x15171a);
    for (let i = 0; i < 4; i++) solid.cyl(c.u1 - 1.2 - i * 0.7, y0 + 1.12, Zf(c.v1 + 0.5), 0.22, 0.22, 0.28, 0xdfe3e6, 8);
    // menu board over the pass and a neon EAT on the back wall
    solid.span(cx - 3, cx + 3, y0 + 2.5, y0 + 3.5, Zf(v1) + 0.05, Zf(v1) + 0.02, 0x1d2430);
    glow.halo(cx, y0 + 3.0, Zf(v1) + 0.3, 2.6, 0xff4538);
    glow.halo(cx + 7, y0 + 2.8, Zf(v1) + 0.3, 1.2, 0x38e0ff);
    for (const [w, id, s] of [['w', 'diner-booth-w1', 0xc23a3a], ['w', 'diner-booth-w2', 0xc23a3a], ['e', 'diner-booth-e1', 0xc23a3a], ['e', 'diner-booth-e2', 0xc23a3a]] as const) booth(box(id), w, s);
    // jukebox
    const jx = x1 - 1.2, jv = v1 - 1.2;
    solid.span(jx - 0.55, jx + 0.55, y0, y0 + 1.7, Zf(jv) + 0.35, Zf(jv) - 0.35, 0xc23a3a); solid.span(jx - 0.4, jx + 0.4, y0 + 0.9, y0 + 1.5, Zf(jv) + 0.37, Zf(jv) + 0.34, 0x9ae0ff);
    glow.halo(jx, y0 + 1.2, Zf(jv) + 0.6, 1.6, 0x66d0ff);
    pend(-26, 55, 0xffe6b0); pend(-14, 55, 0xffe6b0); pend(-21, 64, 0xfff0c8);
  } else {
    // the ten shops: their stock, racks and counters are shops.ts. The shell around them is identical.
    furnishShop({ lot, solid, glow, y0, top: PAD_Y + H - 0.1, x0, x1, v0, v1, pend });
  }

  const solidMesh = new THREE.Mesh(solid.build(), kit.solid); solidMesh.castShadow = false; solidMesh.receiveShadow = false; group.add(solidMesh);
  const glowMesh = new THREE.Mesh(glow.build(), kit.glowQuad); glowMesh.renderOrder = 1; group.add(glowMesh);
  geos.push(solidMesh.geometry, glowMesh.geometry);

  // staff and regulars live in the room, so they hide with it
  const people: Person[] = NPCS.filter((n) => n.inside === lot.id).map((n, i) => makePerson(n, 20 + i, PAD_Y));
  for (const p of people) group.add(p.human.group);

  return {
    lot, group, people, lights,
    dispose() { geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); releaseFloor(look.floor); people.forEach((p) => p.human.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); })); group.clear(); },
  };
}
