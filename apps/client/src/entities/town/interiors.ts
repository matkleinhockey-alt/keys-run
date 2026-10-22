/**
 * The two buildings you can walk into: The Rusty Anchor (bar) and the Salty Dog Diner.
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
import { floorTexture } from './paint.js';
import { makePerson, type Person } from './people.js';
import { Zf } from './props.js';
import type { LightSource } from './build.js';

export const INTERIOR_BUILD_RANGE = 140;
export const INTERIOR_RANGE = 95;

export interface Interior {
  lot: Lot;
  group: THREE.Group;
  people: Person[];
  lights: LightSource[];
  dispose(): void;
}

/** No sun reaches a windowless room under a solid roof, so its albedo is lifted uniformly (see GeoBatch). */
const isBarLift = (lot: Lot): number => (lot.id === 'bar' ? 2.5 : 1.6);

export function buildInterior(lot: Lot, kit: TownKit): Interior {
  const group = new THREE.Group();
  group.name = `interior-${lot.id}`;
  const solid = new GeoBatch(false, isBarLift(lot)), glow = new GeoBatch(true);
  const lights: LightSource[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const isBar = lot.id === 'bar';
  const isClub = lot.id === 'club';
  const y0 = PAD_Y + 0.04, H = lot.h;
  const x0 = lot.u0 + WALL_T, x1 = lot.u1 - WALL_T, v0 = lot.v0 + WALL_T, v1 = lot.v1 - WALL_T;
  const cx = (x0 + x1) / 2;

  // floor
  {
    const w = x1 - x0, d = v1 - v0;
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    const rep = isBar ? 2.2 : 1.6;
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / rep), uv.getY(i) * (d / rep));
    const tex = floorTexture(isBar || isClub ? 'boards' : 'checker');
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: isClub ? 0.22 : isBar ? 0.85 : 0.35, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    // no receiveShadow in here: the sun never reaches a room under a solid roof, and a cascade lookup on the
    // ceiling just paints shadow-acne blotches over it (seen in the first interior captures)
    const m = new THREE.Mesh(g, mat); m.position.set(cx, y0, Zf((v0 + v1) / 2)); group.add(m);
    geos.push(g); mats.push(mat); texs.push(tex);
  }
  // wall skins and ceiling, in the room's own colours (the exterior boxes are the outside paint)
  const wall = isClub ? 0x1a0d18 : isBar ? 0x9a7048 : 0xf1e8d6;
  const trim = isClub ? 0x5a1340 : isBar ? 0x4a3524 : 0xc23a3a;
  const ceil = isClub ? 0x120812 : isBar ? 0x4a3826 : 0xe6e2d6;
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

  const pend = (u: number, v: number, c: number): void => {
    solid.cyl(u, PAD_Y + H - 1.15, Zf(v), 0.02, 0.02, 1.0, 0x1f160e, 4);
    solid.cyl(u, PAD_Y + H - 1.7, Zf(v), 0.1, 0.36, 0.55, isBar ? 0x2f6b4a : 0xc23a3a, 10);
    glow.halo(u, PAD_Y + H - 1.75, Zf(v), 2.1, c);
    glow.pool(u, y0 + 0.05, Zf(v), 4.6, c);
    lights.push({ x: u, y: PAD_Y + H - 1.8, z: Zf(v), color: c, kind: 'lamp', lot: lot.id });
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
  } else {
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
  }

  const solidMesh = new THREE.Mesh(solid.build(), kit.solid); solidMesh.castShadow = false; solidMesh.receiveShadow = false; group.add(solidMesh);
  const glowMesh = new THREE.Mesh(glow.build(), kit.glowQuad); glowMesh.renderOrder = 1; group.add(glowMesh);
  geos.push(solidMesh.geometry, glowMesh.geometry);

  // staff and regulars live in the room, so they hide with it
  const people: Person[] = NPCS.filter((n) => n.inside === lot.id).map((n, i) => makePerson(n, 20 + i, PAD_Y));
  for (const p of people) group.add(p.human.group);

  return {
    lot, group, people, lights,
    dispose() { geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); texs.forEach((t) => t.dispose()); people.forEach((p) => p.human.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); })); group.clear(); },
  };
}
