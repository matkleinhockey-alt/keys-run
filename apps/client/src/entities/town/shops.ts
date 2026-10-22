/**
 * What is on the shelves: the ten shops that are not the bar, the diner or the cabaret (the cabaret's interior is
 * built elsewhere; its lot stays solid).
 *
 * `interiors.ts` builds the shell every room shares (floor, wall skins, ceiling, wainscot, pendant
 * lamps, the shopkeeper) and then hands the room to `furnishShop` here. Everything is drawn into the
 * two `GeoBatch`es the shell owns (one solid, one additive glow), so a shop is two draw calls however
 * much stock it shows. That is the whole performance story of this file: a rack of fifteen
 * wetsuits and a wall of lures cost vertices (a shop is ~5-12k triangles, built once, drawn only
 * while you are at its door), never draw calls, never materials, never lights.
 *
 * ## What this file decides and what it does not
 * Where a counter, rack or case STANDS is `INTERIOR_BOXES` in packages/shared/src/world/town.ts, the
 * very boxes the walker collides with, found here by id. This file decides what each of those boxes
 * LOOKS like and what hangs on the walls around it. Anything drawn without a box (wall dressing under
 * 0.4 m deep, everything on the keeper's side of a counter) is not solid, on purpose: a body is
 * 0.32 m in radius, so a pegboard that thin cannot be walked visibly into, and a collider on the far
 * side of a counter would be one you could never meet.
 *
 * ## Conventions
 * Every helper takes ABSOLUTE local (u, v) like the rest of the town and heights relative to the
 * floor. `A(a)` / `B(b)` convert the shop-frame numbers used in town.ts (metres along the frontage /
 * inland from the front wall). The west wall is `x0` (faces +u), the east wall `x1` (faces -u), the
 * back wall is `v1` (faces -v, toward the door).
 *
 * Colours are written dark-to-light on purpose: `GeoBatch`'s room lift multiplies them (a windowless
 * room under a solid roof gets only the hemisphere term), so a swatch here reads about 1.6-2x brighter
 * on screen than the hex suggests.
 */
import type { InteriorBox, Lot } from '@keysrun/shared/world/town';
import { INTERIOR_BOXES } from '@keysrun/shared/world/town';
import type { GeoBatch, Xform } from './batch.js';

export interface Room {
  lot: Lot;
  solid: GeoBatch;
  glow: GeoBatch;
  /** Floor height (world y). */
  y0: number;
  /** Underside of the ceiling (world y). */
  top: number;
  /** Inner faces of the four walls, local (u, v). */
  x0: number; x1: number; v0: number; v1: number;
  /** A ceiling lamp that also becomes a real PointLight candidate while you are in this room. */
  pend(u: number, v: number, color: number, kind?: 'bell' | 'tube'): void;
}

const pick = <T,>(a: readonly T[], i: number): T => a[((i % a.length) + a.length) % a.length];
const GLASS = 0xcfe8f0;
const STEEL = 0xb8bec4;
const DARK = 0x1c1f24;

export function furnishShop(r: Room): void {
  const { lot, solid, glow } = r;
  const Y = r.y0;
  const A = (a: number): number => lot.u0 + a;
  const B = (b: number): number => lot.v0 + b;
  const box = (id: string): InteriorBox => INTERIOR_BOXES.find((q) => q.id === id)!;
  // helpers: absolute (u, v), heights above the floor
  const S = (u0: number, u1: number, y0: number, y1: number, v0: number, v1: number, c: number): void => { solid.span(u0, u1, Y + y0, Y + y1, -v1, -v0, c); };
  const Bx = (u: number, y: number, v: number, w: number, h: number, d: number, c: number, t?: Xform): void => { solid.box(u, Y + y, -v, w, h, d, c, t); };
  const Cy = (u: number, v: number, y: number, rt: number, rb: number, h: number, c: number, seg = 7, t?: Xform): void => { solid.cyl(u, Y + y, -v, rt, rb, h, c, seg, t); };
  const Ba = (u: number, y: number, v: number, rad: number, c: number, sy = 1, seg = 6): void => { solid.ball(u, Y + y, -v, rad, c, sy, seg); };
  const Hl = (u: number, y: number, v: number, rad: number, c: number): void => { glow.halo(u, Y + y, -v, rad, c); };
  const counter = (b: InteriorBox, body: number, topC: number, h = 1.05, kick?: number): void => {
    S(b.u0, b.u1, 0, h, b.v0, b.v1, body);
    S(b.u0 - 0.06, b.u1 + 0.06, h, h + 0.07, b.v0 - 0.14, b.v1 + 0.06, topC);
    if (kick !== undefined) S(b.u0, b.u1, 0, 0.2, b.v0 - 0.05, b.v0, kick);
  };
  /** Boards across the back wall with stock on them. `stock(u, y, i)` places one item standing on a board at height y. */
  const backShelves = (u0: number, u1: number, tiers: readonly number[], step: number, board: number, stock: (u: number, y: number, v: number, i: number) => void): void => {
    let n = 0;
    for (const y of tiers) {
      S(u0, u1, y, y + 0.04, r.v1 - 0.38, r.v1, board);
      for (let u = u0 + step / 2; u < u1; u += step) stock(u, y + 0.04, r.v1 - 0.2, n++);
    }
    S(u0, u0 + 0.05, tiers[0], tiers[tiers.length - 1] + 0.7, r.v1 - 0.38, r.v1, board);
    S(u1 - 0.05, u1, tiers[0], tiers[tiers.length - 1] + 0.7, r.v1 - 0.38, r.v1, board);
  };
  /** Boards along the west (dir +1) or east (dir -1) wall, `b0..b1` inland, items standing on them. */
  const sideShelves = (dir: 1 | -1, b0: number, b1: number, tiers: readonly number[], step: number, depth: number, board: number, stock: (u: number, y: number, v: number, i: number) => void): void => {
    const wall = dir === 1 ? r.x0 : r.x1;
    let n = 0;
    for (const y of tiers) {
      S(Math.min(wall, wall + dir * depth), Math.max(wall, wall + dir * depth), y, y + 0.04, b0, b1, board);
      for (let v = b0 + step / 2; v < b1; v += step) stock(wall + dir * depth * 0.5, y + 0.04, v, n++);
    }
  };

  switch (lot.id) {
    // ---------------------------------------------------------------------------------------------
    // SCUBA STEVE'S: tanks, suits on racks, fins on the wall, masks under glass
    // ---------------------------------------------------------------------------------------------
    case 'dive': {
      const FIN = [0xf2c14e, 0x15171a, 0x2bb3a8, 0xe86aa8, 0x3a6ea5, 0xd9342b];
      const ct = box('dive-counter');
      counter(ct, 0xf1f4f5, 0x1ea5b8, 1.05, 0x1ea5b8);
      // glass case on the counter: dive computers, a register
      S(A(2), A(7), 1.12, 1.32, ct.v0 + 0.2, ct.v1 - 0.2, GLASS);
      for (let i = 0; i < 5; i++) Bx(A(2.6 + i * 0.9), 1.38, (ct.v0 + ct.v1) / 2, 0.22, 0.1, 0.22, pick([0xd9342b, 0xf2c14e, 0x15171a], i));
      S(A(14), A(15), 1.12, 1.4, ct.v0 + 0.3, ct.v1 - 0.3, DARK); Hl(A(14.5), 1.34, ct.v0 + 0.35, 0.3, 0x7bf0ff);
      // the venue sells a slung pony bottle and reg (the big-ticket item): one on a stand on the counter, hose coiled beside it
      Cy(A(18.2), (ct.v0 + ct.v1) / 2, 1.12, 0.09, 0.09, 0.5, 0xf2c14e, 8); Ba(A(18.2), 1.64, (ct.v0 + ct.v1) / 2, 0.09, 0xf2c14e, 0.7, 8); Cy(A(18.2), (ct.v0 + ct.v1) / 2, 1.66, 0.025, 0.03, 0.12, 0xd8b04a, 5);
      Cy(A(18.75), (ct.v0 + ct.v1) / 2, 1.14, 0.2, 0.2, 0.03, 0x15171a, 10); Cy(A(18.75), (ct.v0 + ct.v1) / 2, 1.14, 0.12, 0.12, 0.05, 0x1c1f24, 10);
      // the fin wall: two rows of long-blade fins hung blade-down, colours alternating
      for (let row = 0; row < 2; row++) for (let i = 0; i < 18; i++) {
        const u = A(1.3 + i * 1.12);
        // foot pocket (small, dark) at the top, the blade (long, wide, bright) hanging from it
        Bx(u, 1.78 + row * 0.95 - 0.55, r.v1 - 0.06, 0.2, 0.22, 0.06, 0x1d2430);
        Bx(u, 1.2 + row * 0.95 - 0.55 + 0.12, r.v1 - 0.06, 0.3, 0.7, 0.04, pick(FIN, i + row * 2));
        Bx(u, 1.2 + row * 0.95 - 0.55 + 0.12, r.v1 - 0.05, 0.05, 0.64, 0.045, pick(FIN, i + row * 2 + 3));
      }
      // mask shelf above the fins, and a rolled dive flag over the counter
      backShelves(A(1), A(21), [2.95], 0.9, 0xf1f4f5, (u, y, v, i) => { Bx(u, y + 0.1, v, 0.24, 0.16, 0.12, pick(FIN, i)); Bx(u, y + 0.11, v + 0.07, 0.2, 0.1, 0.02, 0x1d2430); });
      S(A(10.2), A(11.8), 2.75, 4.05, r.v1 - 0.08, r.v1 - 0.03, 0xd9342b);
      Bx(A(11), 3.4, r.v1 - 0.1, 1.45, 0.16, 0.02, 0xffffff, { rz: 0.72 });
      // behind the counter: the fill station (a compressor and three banks of tanks in a cage)
      S(A(15.5), A(19.5), 0, 1.0, B(15.2), B(17.4), 0x3a3f46); Cy(A(17.5), B(16.3), 1.0, 0.45, 0.45, 0.5, STEEL, 8);
      for (let i = 0; i < 5; i++) Cy(A(4 + i * 0.5), B(16.8), 0, 0.15, 0.15, 1.0, pick([0xf2c14e, 0xdfe6ea], i), 8);
      // wetsuit rack along the west wall: a rail and ten suits in black with a coloured chest stripe
      const su = box('dive-suits');
      S(su.u0 + 0.1, su.u0 + 0.16, 0, 2.15, su.v0, su.v0 + 0.06, STEEL); S(su.u0 + 0.1, su.u0 + 0.16, 0, 2.15, su.v1 - 0.06, su.v1, STEEL);
      S(su.u0 + 0.06, su.u0 + 0.22, 2.1, 2.16, su.v0, su.v1, STEEL);
      for (let i = 0; i < 9; i++) {
        const v = su.v0 + 0.4 + i * 0.7, c = pick([0x1d2430, 0x23262a, 0x203a52], i);
        S(su.u0 + 0.28, su.u0 + 1.0, 1.2, 2.05, v - 0.22, v + 0.22, c);
        S(su.u0 + 0.28, su.u0 + 1.0, 1.55, 1.7, v - 0.225, v + 0.225, pick([0xf2c14e, 0x2bb3a8, 0xe86aa8, 0xd9342b], i));
        S(su.u0 + 0.32, su.u0 + 0.5, 0.35, 1.2, v - 0.2, v - 0.02, c); S(su.u0 + 0.32, su.u0 + 0.5, 0.35, 1.2, v + 0.02, v + 0.2, c);
      }
      S(su.u0, su.u0 + 1.2, 0, 0.3, su.v0, su.v1, 0x3a3f46); // shoe/boot bench under the rail
      // tank rack along the east wall: seven cylinders strapped upright, yellow and silver, valves on top
      const tk = box('dive-tanks');
      S(tk.u0, tk.u1, 0, 0.18, tk.v0, tk.v1, 0x3a3f46); S(tk.u0 + 0.9, tk.u1, 0.85, 0.95, tk.v0, tk.v1, 0x3a3f46);
      for (let i = 0; i < 8; i++) {
        const v = tk.v0 + 0.4 + i * 0.8, c = pick([0xf2c14e, 0xdfe6ea, 0x2bb3a8], i);
        Cy(tk.u0 + 0.62, v, 0.18, 0.15, 0.15, 1.0, c, 8); Ba(tk.u0 + 0.62, 1.2, v, 0.15, c, 0.7, 8);
        Cy(tk.u0 + 0.62, v, 1.25, 0.04, 0.05, 0.2, 0xd8b04a, 5); S(tk.u0 + 0.5, tk.u0 + 0.74, 1.4, 1.46, v - 0.05, v + 0.05, DARK);
      }
      // mask & snorkel table, fins island: the middle of the floor
      const mk = box('dive-masks');
      S(mk.u0, mk.u1, 0, 0.85, mk.v0, mk.v1, 0xf1f4f5); S(mk.u0 - 0.05, mk.u1 + 0.05, 0.85, 0.92, mk.v0 - 0.05, mk.v1 + 0.05, 0x1ea5b8);
      for (let i = 0; i < 6; i++) { Bx(mk.u0 + 0.5 + i * 0.6, 1.0, mk.v0 + 0.5, 0.3, 0.2, 0.14, pick(FIN, i)); Bx(mk.u0 + 0.5 + i * 0.6, 1.02, mk.v0 + 0.57, 0.24, 0.13, 0.02, 0x1d2430); }
      for (let i = 0; i < 6; i++) { Cy(mk.u0 + 0.5 + i * 0.6, mk.v1 - 0.5, 0.92, 0.015, 0.015, 0.55, pick(FIN, i + 2), 4, { rz: 0.15 }); }
      const fn = box('dive-fins');
      for (let i = 0; i < 4; i++) {
        const u = fn.u0 + 0.5 + i * 1.0;
        S(u - 0.4, u + 0.4, 0, 0.55, fn.v0, fn.v1, 0x3a3f46);
        for (let k = 0; k < 4; k++) Bx(u - 0.25 + k * 0.17, 0.95, (fn.v0 + fn.v1) / 2, 0.14, 0.7, 0.05, pick(FIN, i + k), { rx: 0.18 });
      }
      // a wall of surf-and-dive posters: flat coloured panels (the sea, a shark, a dive flag)
      S(r.x0 + 0.01, r.x0 + 0.04, 2.3, 3.3, B(12), B(15.5), 0x2a7fbf); S(r.x0 + 0.04, r.x0 + 0.06, 2.55, 2.8, B(12.6), B(14), 0xdfe6ea);
      r.pend(A(5), B(8), 0xe6fbff, 'tube'); r.pend(A(16), B(8), 0xe6fbff, 'tube'); r.pend(A(11), B(15), 0xd8f6ff, 'tube');
      break;
    }

    // ---------------------------------------------------------------------------------------------
    // HOOK, LINE & SINKER: rods on the wall, a live bait tank, lures, reels, the freezer
    // ---------------------------------------------------------------------------------------------
    case 'tackle': {
      const LURE = [0xe4572e, 0xf2c14e, 0x2bb3a8, 0xffffff, 0x7bc96f, 0xe86aa8];
      const ct = box('tackle-counter');
      counter(ct, 0x7a5a38, 0xd8c9a0, 1.05, 0x1f4f8c);
      // reel case under glass on the counter: 12 reels on their sides
      S(A(2), A(9), 1.12, 1.3, ct.v0 + 0.2, ct.v1 - 0.2, GLASS);
      for (let i = 0; i < 12; i++) Cy(A(2.5 + (i % 6) * 1.0), ct.v0 + 0.5 + Math.floor(i / 6) * 0.5, 1.32, 0.12, 0.12, 0.1, pick([STEEL, 0xd8b04a, 0x23262a], i), 8);
      Cy(A(22), (ct.v0 + ct.v1) / 2, 1.12, 0.14, 0.14, 0.22, GLASS, 8); Ba(A(22), 1.36, (ct.v0 + ct.v1) / 2, 0.15, 0xe4572e, 1, 6); // candy jar
      S(A(25), A(26.2), 1.12, 1.4, ct.v0 + 0.3, ct.v1 - 0.3, DARK); Hl(A(25.6), 1.34, ct.v0 + 0.35, 0.3, 0x7bf0ff);
      // back wall: pegboard of lures (a grid of coloured pegs), line spools above, a mounted marlin over all
      S(A(1), A(29), 1.0, 2.7, r.v1 - 0.07, r.v1 - 0.02, 0xcdbd8c);
      for (let row = 0; row < 7; row++) for (let i = 0; i < 40; i++) if ((i * 5 + row * 3) % 4 !== 0) {
        Bx(A(1.4 + i * 0.7), 1.2 + row * 0.22, r.v1 - 0.12, 0.08, 0.16, 0.05, pick(LURE, i + row));
      }
      // leader and line spools: the 80 lb fluorocarbon the venue sells is the clear/green ones
      backShelves(A(1), A(29), [2.85], 0.5, 0x7a5a38, (u, y, v, i) => Cy(u, v, y, 0.1, 0.1, 0.18, pick([0xd9342b, 0x2b6cb0, 0xf2c14e, 0x23262a, 0xcfeee0], i), 8));
      // mounted marlin: a tapering body, a long bill, a forked tail and a dorsal fin. The cylinders are tilted
      // about their CENTRES (GeoBatch.cyl takes the base), so the base is the centre height minus half the length.
      Cy(A(15), r.v1 - 0.2, 3.5 - 1.3, 0.06, 0.34, 2.6, 0x2b6cb0, 8, { rz: Math.PI / 2 });
      Cy(A(13.1), r.v1 - 0.2, 3.5 - 0.6, 0.0, 0.03, 1.2, 0xdfe6ea, 5, { rz: Math.PI / 2 });
      S(A(15.6), A(16.6), 3.4, 3.75, r.v1 - 0.3, r.v1 - 0.12, 0xdfe6ea);
      Bx(A(16.8), 3.85, r.v1 - 0.2, 0.7, 0.5, 0.05, 0x2b6cb0, { rz: 0.6 }); Bx(A(16.8), 3.2, r.v1 - 0.2, 0.7, 0.5, 0.05, 0x2b6cb0, { rz: -0.6 });
      Bx(A(15.2), 3.95, r.v1 - 0.2, 0.9, 0.35, 0.05, 0x1f4f8c, { rz: 0.3 });
      // west wall: the rod rack, 14 rods leaning in a rail, tips toward the ceiling
      const rk = box('tackle-rods');
      S(rk.u0, rk.u0 + 0.14, 0.9, 1.0, rk.v0, rk.v1, 0x23262a); S(rk.u0, rk.u0 + 0.14, 1.9, 2.0, rk.v0, rk.v1, 0x23262a);
      for (let i = 0; i < 16; i++) {
        const v = rk.v0 + 0.35 + i * 0.67;
        Cy(rk.u0 + 0.9, v, 0.1, 0.012, 0.03, 2.6, pick([0x23262a, 0x4a3a2a, 0x2b6cb0, 0x23262a], i), 5, { rz: -0.32 });
        Cy(rk.u0 + 0.55, v, 0.98, 0.07, 0.07, 0.12, pick([STEEL, 0xd8b04a], i), 6);
      }
      // live-bait tank, east: a cabinet, a glowing water box, a pump, bubbles and a few shrimp
      const bt = box('tackle-bait');
      S(bt.u0, bt.u1, 0, 0.8, bt.v0, bt.v1, 0xdfe6ea);
      S(bt.u0 + 0.1, bt.u1 - 0.1, 0.8, 1.75, bt.v0 + 0.1, bt.v1 - 0.1, 0x6fc8d8);
      S(bt.u0 + 0.1, bt.u1 - 0.1, 1.75, 1.8, bt.v0 + 0.1, bt.v1 - 0.1, 0xdfe6ea);
      for (let i = 0; i < 14; i++) Bx(bt.u0 + 0.35 + (i % 4) * 0.4, 0.95 + (i * 0.13) % 0.7, bt.v0 + 0.4 + Math.floor(i / 4) * 1.2, 0.12, 0.05, 0.05, 0xf4c5a8);
      Cy(bt.u1 - 0.4, bt.v0 + 0.4, 0.82, 0.06, 0.06, 0.4, DARK, 5);
      Hl((bt.u0 + bt.u1) / 2, 1.3, (bt.v0 + bt.v1) / 2, 2.2, 0x58e0ff);
      // gondolas: lure boards and tackle boxes, goods both faces
      for (const id of ['tackle-aisle-1', 'tackle-aisle-2']) {
        const g = box(id);
        S(g.u0, g.u1, 0, 1.5, g.v0, g.v1, 0x2f8f9d); S(g.u0, g.u1, 1.5, 1.56, g.v0 - 0.04, g.v1 + 0.04, 0xf4f1e8);
        for (let k = 0; k < 4; k++) for (let i = 0; i < 12; i++) {
          const u = g.u0 + 0.3 + i * 0.62, y = 0.35 + k * 0.28;
          Bx(u, y, g.v0 - 0.03, 0.34, 0.18, 0.06, pick([...LURE, 0xf2c14e], i + k * 2));
          Bx(u, y, g.v1 + 0.03, 0.34, 0.18, 0.06, pick(LURE, i * 2 + k));
        }
        for (let i = 0; i < 5; i++) Bx(g.u0 + 0.8 + i * 1.3, 1.72, (g.v0 + g.v1) / 2, 0.55, 0.26, 0.4, pick([0xf2c14e, 0xe4572e, 0x2bb3a8], i)); // tackle boxes on top
      }
      // ice & bait freezer by the east wall; bagged ice stacked beside it
      const fz = box('tackle-freezer');
      S(fz.u0, fz.u1, 0, 0.95, fz.v0, fz.v1, 0xeef2f4); S(fz.u0 - 0.04, fz.u1 + 0.04, 0.95, 1.02, fz.v0 - 0.04, fz.v1 + 0.04, 0x1f4f8c);
      for (let i = 0; i < 3; i++) S(fz.u0 + 0.3 + i * 1.7, fz.u0 + 1.7 + i * 1.7 - 0.4, 1.02, 1.05, fz.v0 + 0.2, fz.v1 - 0.2, 0xcfe8f0);
      for (let i = 0; i < 6; i++) Bx(fz.u0 - 0.8 - (i % 2) * 0.55, 0.15 + Math.floor(i / 2) * 0.28, fz.v0 + 0.8, 0.5, 0.26, 0.3, pick([0xdfe6ea, 0x6fb3e0], i));
      // rigged ballyhoo laid out on a tray of ice on the lid: slim silver fish, a dark back, a bill, a rigging wire
      S(fz.u0 + 1.0, fz.u0 + 4.0, 1.05, 1.1, fz.v0 + 0.3, fz.v1 - 0.3, 0xcfe8f0);
      for (let i = 0; i < 6; i++) { const u = fz.u0 + 1.6 + (i % 3) * 0.9, v = fz.v0 + 0.6 + Math.floor(i / 3) * 0.7; Cy(u, v, 1.12, 0.03, 0.05, 0.5, 0xc9d3da, 5, { rx: Math.PI / 2 }); Cy(u, v, 1.16, 0.015, 0.03, 0.45, 0x2b6cb0, 4, { rx: Math.PI / 2 }); }
      // buoys and floats strung from the ceiling over the whole shop
      for (let i = 0; i < 22; i++) {
        const u = A(2 + (i * 5.3) % 26), v = B(3 + (i * 7.1) % 12);
        Cy(u, v, 3.55, 0.008, 0.008, r.top - r.y0 - 3.55, 0x23262a, 3); Ba(u, 3.3, v, 0.2, pick([0xe4572e, 0xf2c14e, 0xffffff, 0x2bb3a8], i), 1.15, 7);
      }
      r.pend(A(7), B(5), 0xffe8bb, 'bell'); r.pend(A(22), B(5), 0xffe8bb, 'bell'); r.pend(A(15), B(13), 0xffe0a8, 'bell'); r.pend(A(6), B(21), 0xffe0a8, 'bell'); r.pend(A(24), B(21), 0xffe0a8, 'bell');
      break;
    }

    // ---------------------------------------------------------------------------------------------
    // DEADEYE GUNS & AMMO: spearguns on the left, the caged side on the right, ammunition, flare kits
    // ---------------------------------------------------------------------------------------------
    case 'guns': {
      const ct = box('guns-counter');
      counter(ct, 0x1b1b1e, 0x4a3a2c, 1.05, 0x6a2f29);
      // glass-top display on the counter: flare guns (orange) and a row of folding knives; a till
      S(A(2), A(9), 1.12, 1.3, ct.v0 + 0.2, ct.v1 - 0.2, GLASS);
      for (let i = 0; i < 5; i++) { Bx(A(2.6 + i * 1.3), 1.36, (ct.v0 + ct.v1) / 2, 0.6, 0.1, 0.12, 0xff6a2a); Bx(A(2.35 + i * 1.3), 1.28, (ct.v0 + ct.v1) / 2 - 0.1, 0.12, 0.2, 0.12, 0xff6a2a); }
      S(A(17), A(18.4), 1.12, 1.4, ct.v0 + 0.3, ct.v1 - 0.3, DARK); Hl(A(17.7), 1.34, ct.v0 + 0.35, 0.3, 0xffd070);
      // back wall: a rack of long guns on pegs (black and walnut), a flag, and two target sheets
      for (let row = 0; row < 3; row++) {
        S(A(2), A(22), 1.4 + row * 0.7, 1.45 + row * 0.7, r.v1 - 0.12, r.v1 - 0.04, 0x16110f);
        for (let i = 0; i < 8; i++) {
          const u = A(2.6 + i * 2.4);
          S(u - 0.9, u + 0.8, 1.5 + row * 0.7, 1.58 + row * 0.7, r.v1 - 0.2, r.v1 - 0.12, 0x16110f);
          S(u + 0.4, u + 1.0, 1.46 + row * 0.7, 1.64 + row * 0.7, r.v1 - 0.22, r.v1 - 0.12, pick([0x6b4a2b, 0x4a3a2c], i));
        }
      }
      for (const [tu, tc] of [[A(6), 0xd9342b], [A(18), 0xd9342b]] as const) {
        Cy(tu, r.v1 - 0.08, 3.0, 0.5, 0.5, 0.02, 0xf4f1e8, 14, { rx: Math.PI / 2 });
        Cy(tu, r.v1 - 0.1, 3.0, 0.34, 0.34, 0.02, tc, 14, { rx: Math.PI / 2 }); Cy(tu, r.v1 - 0.12, 3.0, 0.18, 0.18, 0.02, 0xf4f1e8, 14, { rx: Math.PI / 2 }); Cy(tu, r.v1 - 0.14, 3.0, 0.06, 0.06, 0.02, tc, 10, { rx: Math.PI / 2 });
      }
      for (let i = 0; i < 6; i++) S(A(10), A(14), 3.55 - i * 0.12, 3.67 - i * 0.12, r.v1 - 0.1, r.v1 - 0.06, i % 2 ? 0xf4f4f4 : 0xb22234);
      S(A(10), A(11.6), 2.95, 3.7, r.v1 - 0.1, r.v1 - 0.05, 0x3c3b6e);
      // west: spearguns. A pegboard, eight guns hung at an angle (steel barrels, coloured handles), and a drum of shafts
      const sp = box('guns-spears');
      S(sp.u0, sp.u0 + 0.06, 0.8, 2.7, sp.v0, sp.v1, 0xcdbd8c);
      for (let i = 0; i < 9; i++) {
        const v = sp.v0 + 0.5 + i * 0.85;
        Cy(sp.u0 + 0.4, v, 1.0, 0.03, 0.03, 1.5, STEEL, 5, { rx: 0 });
        S(sp.u0 + 0.28, sp.u0 + 0.55, 0.9, 1.15, v - 0.05, v + 0.05, pick([0x2bb3a8, 0xf2c14e, 0x23262a], i));
        Cy(sp.u0 + 0.4, v + 0.1, 1.45, 0.02, 0.02, 1.0, 0x8c9298, 4);
      }
      S(sp.u0, sp.u0 + 0.9, 0, 0.7, sp.v1 - 1.0, sp.v1 - 0.1, 0x23262a); // shaft barrel
      for (let i = 0; i < 7; i++) Cy(sp.u0 + 0.2 + (i % 3) * 0.24, sp.v1 - 0.8 + Math.floor(i / 3) * 0.25, 0.7, 0.012, 0.012, 1.0, STEEL, 4);
      // east: the caged side. Floor-to-ceiling bars with a gate, rifles racked behind them in the dark
      const cg = box('guns-cage');
      for (let v = cg.v0; v <= cg.v1; v += 0.28) S(cg.u0, cg.u0 + 0.04, 0, 2.6, v, v + 0.035, 0x2a2d31);
      S(cg.u0, cg.u0 + 0.05, 2.55, 2.62, cg.v0, cg.v1, 0x2a2d31); S(cg.u0, cg.u0 + 0.05, 1.2, 1.25, cg.v0, cg.v1, 0x2a2d31); S(cg.u0, cg.u0 + 0.05, 0, 0.05, cg.v0, cg.v1, 0x2a2d31);
      S(cg.u0 + 0.1, cg.u1, 0.05, 2.5, cg.v0, cg.v1, 0x15120f);
      for (let i = 0; i < 8; i++) {
        const v = cg.v0 + 0.5 + i * 0.95;
        S(cg.u0 + 0.5, cg.u0 + 0.62, 0.9, 2.4, v - 0.04, v + 0.04, 0x30302f); S(cg.u0 + 0.5, cg.u0 + 0.7, 0.9, 1.35, v - 0.06, v + 0.06, 0x5a3f27);
      }
      // ammunition island: boxes in the colours a gun shop is made of, both faces, and flare kits on top
      const am = box('guns-ammo');
      S(am.u0, am.u1, 0, 1.4, am.v0, am.v1, 0x3a2f27); S(am.u0, am.u1, 1.4, 1.46, am.v0 - 0.04, am.v1 + 0.04, 0x16110f);
      for (let k = 0; k < 4; k++) for (let i = 0; i < 12; i++) {
        const u = am.u0 + 0.35 + i * 0.6, y = 0.3 + k * 0.3, c = pick([0xd9342b, 0xf2c14e, 0x2f6b34, 0xe9e2c8], i + k);
        Bx(u, y, am.v0 - 0.03, 0.4, 0.2, 0.06, c); Bx(u, y, am.v1 + 0.03, 0.4, 0.2, 0.06, pick([0xd9342b, 0xf2c14e, 0x2f6b34], i * 2 + k));
      }
      for (let i = 0; i < 4; i++) Bx(am.u0 + 1.2 + i * 1.7, 1.62, (am.v0 + am.v1) / 2, 0.8, 0.3, 0.5, 0xff6a2a);
      r.pend(A(6), B(6), 0xffd9a0, 'bell'); r.pend(A(18), B(6), 0xffd9a0, 'bell'); r.pend(A(12), B(18), 0xffcf90, 'bell');
      break;
    }

    // ---------------------------------------------------------------------------------------------
    // CHEAP BEER & LOTTO: wine, spirits, a lit beer cooler, the lottery counter
    // ---------------------------------------------------------------------------------------------
    case 'liquor': {
      const BOT = [0x2f6b4a, 0xb8741a, 0xc23a3a, 0x3a6ea5, 0xd9d4a0, 0x4a2a1c];
      const ct = box('liquor-counter');
      counter(ct, 0x7a1f2a, 0xf0e2b0, 1.05, 0x2a2a2a);
      // lotto: a red terminal with a lit screen, a fan of scratch-off cards in the rack beside it
      S(A(10), A(12), 1.12, 1.55, ct.v0 + 0.3, ct.v1 - 0.3, 0xb3202a); Hl(A(11), 1.4, ct.v0 + 0.3, 0.45, 0xffe27a);
      for (let i = 0; i < 12; i++) Bx(A(2.5 + i * 0.35), 1.5, ct.v1 - 0.12, 0.28, 0.5, 0.02, pick([0xf2c14e, 0xe86aa8, 0x2bb3a8, 0x7bc96f], i));
      S(A(2.3), A(6.8), 1.12, 1.25, ct.v1 - 0.2, ct.v1 - 0.08, 0x2a2a2a);
      // back wall: spirits, three tiers, a mirror strip behind, and a lit LOTTO sign
      S(A(1), A(13), 0.9, 2.9, r.v1 - 0.04, r.v1 - 0.01, 0xbfd3dc);
      backShelves(A(1), A(13), [1.1, 1.75, 2.4], 0.34, 0x4a2a1c, (u, y, v, i) => Cy(u, v, y, 0.045, 0.06, 0.34 + (i % 3) * 0.04, pick(BOT, i), 5));
      S(A(4), A(10), 3.15, 3.65, r.v1 - 0.08, r.v1 - 0.03, 0xb3202a); Hl(A(7), 3.4, r.v1 - 0.3, 1.9, 0xffe27a);
      // west: wine, floor to head height, bottles lying in cubbies
      const wn = box('liquor-wine');
      S(wn.u0, wn.u0 + 0.5, 0, 2.2, wn.v0, wn.v1, 0x4a2a1c);
      for (let k = 0; k < 6; k++) for (let i = 0; i < 9; i++) Cy(wn.u0 + 0.62, wn.v0 + 0.3 + i * 0.75 / 1.0, 0.18 + k * 0.34, 0.045, 0.05, 0.3, pick(BOT, i + k), 5, { rz: Math.PI / 2 });
      // east: the beer cooler. A black cabinet, bright interior, glass doors, cases of cans in three colours
      const cl = box('liquor-cooler');
      S(cl.u0, cl.u1, 0, 2.3, cl.v0, cl.v1, 0x15171a);
      S(cl.u0 - 0.04, cl.u0, 0.2, 2.1, cl.v0 + 0.1, cl.v1 - 0.1, 0xd8f4ff);
      for (let k = 0; k < 4; k++) for (let i = 0; i < 6; i++) Bx(cl.u0 - 0.1, 0.45 + k * 0.45, cl.v0 + 0.5 + i * 1.1 - 0.0, 0.1, 0.32, 0.8, pick([0xd9342b, 0x2b6cb0, 0xf2c14e, 0x2f6b34], i + k));
      Hl(cl.u0 - 0.5, 1.2, (cl.v0 + cl.v1) / 2, 3.0, 0xbfe9ff);
      // front window glow and a chest of ice by the door
      S(r.x0 + 0.05, r.x0 + 1.3, 0, 0.8, B(1), B(2.6), 0xeef2f4); S(r.x0 + 0.03, r.x0 + 1.33, 0.8, 0.86, B(0.97), B(2.63), 0x2b6cb0);
      r.pend(A(7), B(5), 0xfff4d8, 'tube'); r.pend(A(7), B(11), 0xfff4d8, 'tube'); r.pend(A(7), B(16), 0xfff0c8, 'tube');
      break;
    }

    // ---------------------------------------------------------------------------------------------
    // CONCH REPUBLIC GIFTS: shirts, shells, hot sauce, pennants, a postcard spinner
    // ---------------------------------------------------------------------------------------------
    case 'gifts': {
      const LOUD = [0xe4572e, 0x2bb3a8, 0xf2c14e, 0xe86aa8, 0x3a6ea5, 0x7bc96f, 0xffffff];
      const ct = box('gifts-counter');
      counter(ct, 0x2bb3a8, 0xfff2dc, 1.05, 0xe86aa8);
      Cy(A(26), (ct.v0 + ct.v1) / 2, 1.12, 0.03, 0.03, 0.8, STEEL, 5); // postcard spinner
      for (let k = 0; k < 4; k++) for (let i = 0; i < 6; i++) Bx(A(26) + Math.cos(i) * 0.18, 1.3 + k * 0.17, (ct.v0 + ct.v1) / 2 + Math.sin(i) * 0.18, 0.1, 0.12, 0.1, pick(LOUD, i + k));
      Ba(A(10), 1.3, (ct.v0 + ct.v1) / 2, 0.18, 0xf7a7c6, 1, 7); Ba(A(11), 1.28, (ct.v0 + ct.v1) / 2, 0.16, 0xfff2dc, 1, 7); // a pair of shells by the till
      S(A(20), A(21.2), 1.12, 1.4, ct.v0 + 0.3, ct.v1 - 0.3, DARK); Hl(A(20.6), 1.34, ct.v0 + 0.35, 0.3, 0x7bf0ff);
      // back wall: sunset painting, shell mirrors (discs), snow globes, a pink flamingo ornament
      S(A(4), A(12), 1.5, 3.1, r.v1 - 0.07, r.v1 - 0.03, 0xff9f43); S(A(4), A(12), 1.5, 2.1, r.v1 - 0.09, r.v1 - 0.07, 0x2b6cb0); Ba(A(8), 2.3, r.v1 - 0.12, 0.45, 0xffe27a, 0.8, 8);
      for (let i = 0; i < 4; i++) { Cy(A(15 + i * 2.1), r.v1 - 0.06, 2.3, 0.55, 0.55, 0.05, 0xfff2dc, 12, { rx: Math.PI / 2 }); Cy(A(15 + i * 2.1), r.v1 - 0.09, 2.3, 0.4, 0.4, 0.03, 0xbfd3dc, 12, { rx: Math.PI / 2 }); }
      backShelves(A(1), A(31), [1.1, 3.35], 0.7, 0xfff2dc, (u, y, v, i) => { Ba(u, y + 0.13, v, 0.13, pick([0xcfe8f0, 0xf7a7c6], i), 1, 6); S(u - 0.12, u + 0.12, y, y + 0.06, v - 0.08, v + 0.08, pick(LOUD, i)); });
      // the venue sells a Conch Republic cap: a row on its own shelf above the till, domes with a brim
      S(A(1), A(31), 2.7, 2.74, r.v1 - 0.44, r.v1, 0xfff2dc);
      for (let i = 0; i < 14; i++) { const u = A(1.6 + i * 2.0); Ba(u, 2.84, r.v1 - 0.2, 0.17, pick([0x2bb3a8, 0xfff2dc, 0xe86aa8, 0x3a6ea5], i), 0.7, 7); S(u - 0.16, u + 0.16, 2.74, 2.77, r.v1 - 0.42, r.v1 - 0.2, pick([0x2bb3a8, 0xfff2dc, 0xe86aa8, 0x3a6ea5], i)); }
      Cy(A(29), B(16.8), 0, 0.03, 0.03, 0.8, 0xf08aa8, 4); Ba(A(29), 1.0, B(16.8), 0.2, 0xf08aa8, 1.4, 6); Ba(A(29.2), 1.35, B(16.8), 0.1, 0xf08aa8, 1, 5);
      // west: the shirt wall. Folded stacks on shelves in loud colours
      const sw = box('gifts-shirt-wall');
      S(sw.u0, sw.u0 + 0.5, 0, 2.3, sw.v0, sw.v1, 0xfff2dc);
      for (let k = 0; k < 5; k++) for (let i = 0; i < 6; i++) S(sw.u0 + 0.05, sw.u0 + 0.5, 0.2 + k * 0.42, 0.55 + k * 0.42, sw.v0 + 0.15 + i * 1.28 + 0.02, sw.v0 + 0.15 + i * 1.28 + 1.18, pick(LOUD, i * 2 + k));
      // east: hot sauce. Three tiers of small bottles in red, green and yellow, both labels bright
      const hs = box('gifts-hotsauce');
      S(hs.u1 - 0.5, hs.u1, 0, 2.3, hs.v0, hs.v1, 0x5a3825);
      sideShelves(-1, hs.v0, hs.v1, [0.5, 0.95, 1.4, 1.85], 0.2, 0.5, 0x7a4a2a, (u, y, v, i) => Cy(u, v, y, 0.025, 0.04, 0.22, pick([0xd9342b, 0x2f6b34, 0xf2c14e, 0xff6a2a], i), 5));
      // two round clothing racks: a pole, a ring of hanging shirts
      for (const id of ['gifts-shirts-1', 'gifts-shirts-2']) {
        const g = box(id);
        S(g.u0, g.u1, 0, 0.12, g.v0, g.v1, 0x3a3f46); S(g.u0, g.u1, 1.5, 1.55, (g.v0 + g.v1) / 2 - 0.02, (g.v0 + g.v1) / 2 + 0.02, STEEL);
        for (const e of [g.u0 + 0.05, g.u1 - 0.05]) Cy(e, (g.v0 + g.v1) / 2, 0, 0.025, 0.025, 1.55, STEEL, 4);
        for (let i = 0; i < 11; i++) { const u = g.u0 + 0.3 + i * 0.42; S(u - 0.17, u + 0.17, 0.72, 1.45, (g.v0 + g.v1) / 2 - 0.05, (g.v0 + g.v1) / 2 + 0.05, pick(LOUD, i + g.u0)); S(u - 0.27, u + 0.27, 1.15, 1.35, (g.v0 + g.v1) / 2 - 0.045, (g.v0 + g.v1) / 2 + 0.045, pick(LOUD, i + g.u0)); }
      }
      // the shell table: a bowl of conchs and starfish, a mirror leaning on it
      const sh = box('gifts-shells');
      S(sh.u0, sh.u1, 0, 0.8, sh.v0, sh.v1, 0xfff2dc); S(sh.u0 - 0.04, sh.u1 + 0.04, 0.8, 0.86, sh.v0 - 0.04, sh.v1 + 0.04, 0x2bb3a8);
      for (let i = 0; i < 16; i++) { Ba(sh.u0 + 0.5 + (i % 8) * 0.9, 0.95, sh.v0 + 0.5 + Math.floor(i / 8) * 1.0, 0.14, pick([0xf7a7c6, 0xfff2dc, 0xf2c14e, 0xff9f43], i), 0.8, 6); }
      Cy(sh.u0 + 4, (sh.v0 + sh.v1) / 2, 0.86, 0.0, 0.26, 0.5, 0xf7a7c6, 7);
      // pennants strung across the shop
      for (let row = 0; row < 3; row++) for (let i = 0; i < 24; i++) Bx(A(1 + i * 1.3), 3.6 - Math.sin((i / 24) * Math.PI) * 0.15, B(5 + row * 5), 0.22, 0.3, 0.02, pick(LOUD, i + row), { rz: Math.PI / 4 });
      r.pend(A(6), B(8), 0xfff0c8, 'bell'); r.pend(A(16), B(7), 0xfff0c8, 'bell'); r.pend(A(26), B(8), 0xfff0c8, 'bell'); r.pend(A(16), B(17), 0xffe8bb, 'bell');
      break;
    }

    // ---------------------------------------------------------------------------------------------
    // KEYS PAWN & LOAN: a caged counter, guitars on the wall, jewellery cases, a shelf of tools
    // ---------------------------------------------------------------------------------------------
    case 'pawn': {
      const ct = box('pawn-counter');
      counter(ct, 0x4a3a28, 0x23262a, 1.05, 0xf0c64a);
      // the cage over the counter: bars from the countertop to head height, with a service window in front of the clerk
      for (let u = ct.u0 + 0.1; u < ct.u1 - 0.1; u += 0.22) if (u < A(13.4) || u > A(16.6)) S(u, u + 0.03, 1.12, 2.6, ct.v0 + 0.08, ct.v0 + 0.12, 0x23262a);
      S(ct.u0, ct.u1, 2.55, 2.62, ct.v0 + 0.06, ct.v0 + 0.14, 0x23262a); S(ct.u0, ct.u1, 1.12, 1.18, ct.v0 + 0.06, ct.v0 + 0.14, 0x23262a);
      Hl(A(15), 2.9, ct.v0 - 0.2, 1.3, 0xffe27a);
      // back wall: a safe (steel box, dial), a row of TVs, a pegged shelf of rods and a bicycle on the wall
      S(A(2), A(5), 0, 1.8, r.v1 - 1.2, r.v1 - 0.1, 0x3a3f46); Cy(A(3.5), r.v1 - 1.28, 1.0, 0.18, 0.18, 0.04, STEEL, 10, { rx: Math.PI / 2 }); S(A(2.1), A(4.9), 1.78, 1.84, r.v1 - 1.22, r.v1 - 0.08, 0x23262a);
      for (let i = 0; i < 4; i++) { S(A(7 + i * 2.1), A(8.8 + i * 2.1), 1.1 + (i % 2) * 0.8, 1.9 + (i % 2) * 0.8, r.v1 - 0.2, r.v1 - 0.06, 0x15171a); S(A(7.1 + i * 2.1), A(8.7 + i * 2.1), 1.2 + (i % 2) * 0.8, 1.8 + (i % 2) * 0.8, r.v1 - 0.21, r.v1 - 0.2, pick([0x2b6cb0, 0x7bc96f, 0x1d2430], i)); }
      for (let i = 0; i < 6; i++) Cy(A(17 + i * 0.4), r.v1 - 0.12, 0.2, 0.014, 0.03, 2.3, pick([0x23262a, 0x4a3a2a], i), 5, { rz: -0.1 });
      Cy(A(26), r.v1 - 0.1, 1.9, 0.5, 0.5, 0.05, 0x23262a, 12, { rx: Math.PI / 2 }); Cy(A(27.6), r.v1 - 0.1, 1.9, 0.5, 0.5, 0.05, 0x23262a, 12, { rx: Math.PI / 2 }); Bx(A(26.8), 2.2, r.v1 - 0.1, 1.6, 0.05, 0.05, 0xd9342b, { rz: 0.1 });
      // west: the guitar wall. Eight guitars hung neck-up on a slatwall, each a different body colour
      const gt = box('pawn-guitars');
      S(gt.u0, gt.u0 + 0.06, 0.6, 3.0, gt.v0, gt.v1, 0x5a3f27);
      for (let i = 0; i < 8; i++) {
        const v = gt.v0 + 0.5 + i * 0.85, c = pick([0xd9342b, 0xf2c14e, 0x2b6cb0, 0x6b4a2b, 0x15171a, 0xe9e2c8], i);
        Ba(gt.u0 + 0.2, 1.1, v, 0.3, c, 1.0, 8); Ba(gt.u0 + 0.2, 1.55, v, 0.22, c, 0.9, 8);
        S(gt.u0 + 0.12, gt.u0 + 0.25, 1.6, 2.7, v - 0.04, v + 0.04, 0x3a2412); S(gt.u0 + 0.1, gt.u0 + 0.27, 2.7, 2.9, v - 0.06, v + 0.06, 0x15171a);
      }
      S(gt.u0, gt.u0 + 0.7, 0, 0.9, gt.v1 - 1.6, gt.v1 - 0.6, 0x15171a); Cy(gt.u0 + 0.5, gt.v1 - 1.1, 0.5, 0.2, 0.2, 0.04, 0x3a3f46, 8, { rz: Math.PI / 2 }); // an amp
      // jewellery cases: a wooden base, glass top, gold and silver trinkets, lit from inside
      for (const id of ['pawn-case-1', 'pawn-case-2']) {
        const g = box(id);
        S(g.u0, g.u1, 0, 0.8, g.v0, g.v1, 0x4a3a28); S(g.u0, g.u1, 0.8, 1.1, g.v0, g.v1, GLASS); S(g.u0 - 0.04, g.u1 + 0.04, 1.1, 1.14, g.v0 - 0.04, g.v1 + 0.04, 0x23262a);
        for (let i = 0; i < 10; i++) Ba(g.u0 + 0.4 + i * 0.55, 0.88, (g.v0 + g.v1) / 2, 0.07, pick([0xf0c64a, 0xdfe6ea, 0xe0b34a, 0x58e0ff], i), 0.7, 5);
        Hl((g.u0 + g.u1) / 2, 1.0, (g.v0 + g.v1) / 2, 2.2, 0xffe27a);
      }
      // east: tool wall. Power tools and boxes in hazard colours on three shelves
      const tl = box('pawn-tools');
      S(tl.u1 - 0.5, tl.u1, 0, 2.2, tl.v0, tl.v1, 0x5a5a4a);
      sideShelves(-1, tl.v0, tl.v1, [0.4, 0.9, 1.4, 1.9], 0.55, 0.5, 0x3a3f46, (u, y, v, i) => { Bx(u, y + 0.15, v, 0.3, 0.26, 0.4, pick([0xf2c14e, 0xd9342b, 0x2b6cb0, 0xff6a2a], i)); });
      // a pile of mixed junk against the front-left of the room: boxes, a stool, a lamp
      r.pend(A(8), B(6), 0xffe0a0, 'bell'); r.pend(A(22), B(6), 0xffe0a0, 'bell'); r.pend(A(15), B(16), 0xffd890, 'bell');
      break;
    }

    // ---------------------------------------------------------------------------------------------
    // SUDS & SUN COIN LAUNDRY: front-loaders, a dryer bank, a folding table, a change machine
    // ---------------------------------------------------------------------------------------------
    case 'laundromat': {
      const BASKET = [0xe4572e, 0x2bb3a8, 0xf2c14e, 0x3a6ea5];
      const washer = (u: number, v: number, wall: 1 | -1, c: number): void => {
        // a front-loader facing into the room: white box, dark porthole with a blue ring, a coloured control strip
        const f = wall === 1 ? u + 0.45 : u - 0.45;
        S(u - 0.45, u + 0.45, 0, 1.0, v - 0.42, v + 0.42, 0xf1f4f5);
        S(u - 0.45, u + 0.45, 0.88, 1.0, v - 0.42, v + 0.42, c);
        Cy(f, v, 0.5, 0.26, 0.26, 0.03, 0x3a6ea5, 12, { rz: Math.PI / 2 }); Cy(f + wall * 0.02, v, 0.5, 0.2, 0.2, 0.03, 0x1d2430, 12, { rz: Math.PI / 2 });
      };
      // west and east banks, 6 washers each, alternating strip colours
      const ww = box('laundry-washers-w'), we = box('laundry-washers-e');
      for (let i = 0; i < 7; i++) { washer(ww.u0 + 0.5, ww.v0 + 0.45 + i * 0.9, 1, pick(BASKET, i)); washer(we.u1 - 0.5, we.v0 + 0.45 + i * 0.9, -1, pick(BASKET, i + 1)); }
      // back wall: the dryer bank, two stacks high, round doors, and the attendant's desk in front of it
      const dr = box('laundry-dryers');
      for (let i = 0; i < 13; i++) for (let k = 0; k < 2; k++) {
        const u = dr.u0 + 0.5 + i * 1.9, y = k * 1.05;
        if (u > dr.u1 - 0.6) continue;
        S(u - 0.8, u + 0.8, y, y + 1.0, dr.v0, dr.v1, 0xdfe6ea); S(u - 0.8, u + 0.8, y + 0.85, y + 1.0, dr.v0 - 0.02, dr.v1, pick(BASKET, i + k));
        Cy(u, dr.v0 - 0.02, y + 0.42, 0.3, 0.3, 0.03, 0x3a3f46, 12, { rx: Math.PI / 2 }); Cy(u, dr.v0 - 0.04, y + 0.42, 0.22, 0.22, 0.03, 0x1d2430, 12, { rx: Math.PI / 2 });
      }
      const dk = box('laundry-desk');
      counter(dk, 0xf1f4f5, 0x1d6fb3, 1.0, 0x1d6fb3);
      for (let i = 0; i < 3; i++) { Bx(dk.u0 + 1 + i * 0.7, 1.15, (dk.v0 + dk.v1) / 2, 0.55, 0.15, 0.4, pick([0xffffff, 0xd9e6f0, 0xfff2dc], i)); }
      Bx(dk.u1 - 1.2, 1.2, (dk.v0 + dk.v1) / 2, 0.5, 0.3, 0.3, 0x1d2430); Hl(dk.u1 - 1.2, 1.35, dk.v0 + 0.2, 0.4, 0x7bf0ff);
      // folding table with a stack of towels, three wheeled baskets
      const fd = box('laundry-folding');
      S(fd.u0, fd.u1, 0.85, 0.92, fd.v0, fd.v1, 0xdfe6ea); for (const e of [fd.u0 + 0.1, fd.u1 - 0.1]) for (const w of [fd.v0 + 0.1, fd.v1 - 0.1]) S(e - 0.04, e + 0.04, 0, 0.85, w - 0.04, w + 0.04, STEEL);
      for (let i = 0; i < 5; i++) S(fd.u0 + 0.4 + i * 1.0, fd.u0 + 1.1 + i * 1.0, 0.92, 0.92 + 0.07 * (1 + i % 3), fd.v0 + 0.3, fd.v1 - 0.3, pick([0xffffff, 0xf7a7c6, 0x8fc4e8, 0xf2c14e], i));
      // three baskets of laundry under the table: inside its footprint, so they are never a floor object you could walk through
      // (the first version stood them in the entrance hall, where a collider-less 0.6 m crate is a bug waiting for a walker)
      for (let i = 0; i < 3; i++) { const u = fd.u0 + 1.2 + i * 1.9, v = (fd.v0 + fd.v1) / 2; S(u - 0.55, u + 0.55, 0.12, 0.62, v - 0.4, v + 0.4, pick(BASKET, i)); S(u - 0.5, u + 0.5, 0.62, 0.74, v - 0.36, v + 0.36, pick([0xffffff, 0xf7a7c6, 0x8fc4e8], i)); }
      // the soap & change machine by the front-left: a red front with coin slot glow and bright product windows
      const vd = box('laundry-vending');
      S(vd.u0, vd.u1, 0, 1.85, vd.v0, vd.v1, 0x1d6fb3); S(vd.u0 + 0.1, vd.u1 - 0.1, 0.8, 1.7, vd.v0 - 0.03, vd.v0, 0xdff3ff); Hl((vd.u0 + vd.u1) / 2, 1.4, vd.v0 - 0.3, 1.6, 0xbfe9ff);
      for (let i = 0; i < 6; i++) Bx(vd.u0 + 0.35 + (i % 3) * 0.75, 1.0 + Math.floor(i / 3) * 0.45, vd.v0 - 0.05, 0.3, 0.3, 0.04, pick([0xf2c14e, 0xe86aa8, 0x2bb3a8], i));
      // a wall clock and a "no dyeing" sign: round, red
      Cy(r.x1 - 0.05, B(14), 2.4, 0.3, 0.3, 0.04, 0xffffff, 12, { rz: Math.PI / 2 }); Cy(r.x1 - 0.08, B(14), 2.4, 0.02, 0.02, 0.2, DARK, 4);
      r.pend(A(6), B(7), 0xf2fbff, 'tube'); r.pend(A(20), B(7), 0xf2fbff, 'tube'); r.pend(A(13), B(13), 0xf2fbff, 'tube');
      break;
    }

    // ---------------------------------------------------------------------------------------------
    // CONE ZONE: a glass freezer counter of tubs, a soft-serve machine, a menu board, cafe tables
    // ---------------------------------------------------------------------------------------------
    case 'icecream': {
      const TUB = [0xf7a7c6, 0xfff3e0, 0x9ae0b0, 0x6b4a2b, 0xf2c14e, 0xb48ae8, 0xff7a6a, 0x7fd8d0];
      const ct = box('ice-counter');
      counter(ct, 0xf7a7c6, 0xfff3e0, 1.0, 0x7fd8d0);
      // the glass freezer well on top: eight tubs in a row with scoops showing
      S(A(1.5), A(11.5), 1.07, 1.12, ct.v0 + 0.15, ct.v1 - 0.15, 0xdfe6ea);
      for (let i = 0; i < 8; i++) { const u = A(2 + i * 1.2); Cy(u, (ct.v0 + ct.v1) / 2, 1.12, 0.26, 0.24, 0.28, TUB[i], 9); Ba(u, 1.44, (ct.v0 + ct.v1) / 2, 0.22, pick(TUB, i + 3), 0.8, 7); }
      S(A(1.5), A(11.5), 1.42, 1.47, ct.v0 + 0.15, ct.v1 - 0.15, GLASS);
      // register and tip jar on the right of the counter
      S(A(15), A(16.2), 1.07, 1.35, ct.v0 + 0.3, ct.v1 - 0.3, DARK); Hl(A(15.6), 1.3, ct.v0 + 0.3, 0.3, 0x7bf0ff);
      Cy(A(17.8), (ct.v0 + ct.v1) / 2, 1.07, 0.13, 0.13, 0.28, GLASS, 8);
      // cone rack: waffle cones standing in a tray, point-down in holes
      for (let i = 0; i < 6; i++) Cy(A(12.6 + i * 0.35), (ct.v0 + ct.v1) / 2, 1.1, 0.14, 0.02, 0.42, 0xd9a85c, 7);
      // back wall: soft-serve machine (chrome), a menu board with coloured bars, a neon cone
      S(A(3), A(6.4), 0, 1.7, r.v1 - 1.2, r.v1 - 0.1, STEEL); S(A(3.3), A(6.1), 1.7, 2.0, r.v1 - 1.1, r.v1 - 0.2, 0xf7a7c6);
      Cy(A(4), r.v1 - 0.65, 0.9, 0.08, 0.08, 0.5, 0xfff3e0, 6); Cy(A(5.4), r.v1 - 0.65, 0.9, 0.08, 0.08, 0.5, 0x6b4a2b, 6);
      S(A(8), A(16), 1.5, 3.3, r.v1 - 0.07, r.v1 - 0.03, 0x1d2430);
      for (let i = 0; i < 6; i++) { S(A(8.4), A(8.4 + 3.0 + (i % 3) * 1.2), 3.0 - i * 0.26, 3.1 - i * 0.26, r.v1 - 0.09, r.v1 - 0.07, pick(TUB, i)); S(A(13.2), A(14.4 + (i % 2) * 0.8), 3.0 - i * 0.26, 3.1 - i * 0.26, r.v1 - 0.09, r.v1 - 0.07, 0xffffff); }
      Cy(A(10), r.v1 - 0.12, 3.5, 0.2, 0.02, 0.5, 0xd9a85c, 7); Ba(A(10), 4.15, r.v1 - 0.12, 0.24, 0xf7a7c6, 1, 7); Hl(A(10), 3.9, r.v1 - 0.3, 1.1, 0xff7ccb);
      // stools along the counter front
      for (let i = 0; i < 6; i++) { const u = A(2.5 + i * 3.0); Cy(u, ct.v0 - 0.7, 0, 0.05, 0.06, 0.62, STEEL, 5); Cy(u, ct.v0 - 0.7, 0.62, 0.2, 0.2, 0.09, pick([0xf7a7c6, 0x7fd8d0], i), 8); }
      // cafe tables in the front corners, each with two chairs
      for (const id of ['ice-table-1', 'ice-table-2']) {
        const t = box(id), u = (t.u0 + t.u1) / 2, v = (t.v0 + t.v1) / 2;
        Cy(u, v, 0, 0.06, 0.2, 0.72, STEEL, 6); Cy(u, v, 0.72, 0.5, 0.5, 0.05, 0xfff3e0, 12);
        for (const [du, dv, c] of [[-0.95, 0, 0x7fd8d0], [0.95, 0, 0xf7a7c6]] as const) { S(u + du - 0.2, u + du + 0.2, 0, 0.45, v + dv - 0.2, v + dv + 0.2, c); S(u + du - 0.2, u + du + 0.2, 0.45, 0.95, v + dv + (du < 0 ? -0.2 : 0.16), v + dv + (du < 0 ? -0.16 : 0.2), c); }
        Ba(u, 0.86, v, 0.08, pick(TUB, u), 1, 6);
      }
      // hearts and pastel bunting along the side walls: just coloured diamonds
      for (let i = 0; i < 14; i++) { Bx(r.x0 + 0.05, 2.7, B(1.5 + i * 1.1), 0.01, 0.3, 0.3, pick(TUB, i), { rx: Math.PI / 4 }); Bx(r.x1 - 0.05, 2.7, B(1.5 + i * 1.1), 0.01, 0.3, 0.3, pick(TUB, i + 1), { rx: Math.PI / 4 }); }
      r.pend(A(5), B(6), 0xffe6f0, 'bell'); r.pend(A(15), B(6), 0xffe6f0, 'bell'); r.pend(A(10), B(13.5), 0xfff0f6, 'bell');
      break;
    }

    // ---------------------------------------------------------------------------------------------
    // SUNSET MOTOR LODGE: a lobby with a long desk, a key board, sofas, vending, the stairs to the rooms
    // ---------------------------------------------------------------------------------------------
    case 'motel': {
      const dk = box('motel-desk');
      counter(dk, 0x5a3a2c, 0xd8c9a0, 1.05, 0x2b1d14);
      Cy(A(8), (dk.v0 + dk.v1) / 2, 1.12, 0.07, 0.09, 0.07, 0xe0b34a, 8); // brass bell
      S(A(15), A(16.4), 1.12, 1.4, dk.v0 + 0.3, dk.v1 - 0.3, DARK); Hl(A(15.7), 1.34, dk.v0 + 0.35, 0.3, 0x7bf0ff);
      S(A(18.5), A(20.5), 1.12, 1.3, dk.v0 + 0.3, dk.v1 - 0.3, 0xf2c14e); // a brochure stack
      // the key board behind the desk: 6 x 10 pigeonholes with a brass key hanging in some of them
      // -- back wall of the lobby: room doors, numbered by a brass plate, down the whole length
      for (let i = 0; i < 11; i++) {
        const u = A(3 + i * 3.4);
        if (u > A(40)) break;
        S(u - 0.5, u + 0.5, 0, 2.2, r.v1 - 0.06, r.v1 - 0.02, pick([0x7a3a2c, 0x2f6b8c, 0x7a3a2c], i));
        Ba(u + 0.35, 1.05, r.v1 - 0.1, 0.05, 0xe0b34a, 1, 4); S(u - 0.12, u + 0.12, 1.75, 1.9, r.v1 - 0.09, r.v1 - 0.06, 0xe0b34a);
      }
      S(A(1), A(41), 2.35, 2.45, r.v1 - 0.1, r.v1 - 0.01, 0x2b1d14);
      // key pigeonholes on the partition behind the desk
      const kp = B(13.6);
      S(A(3), A(21), 0, 3.0, kp, kp + 0.3, 0x8a6a4c);
      for (let k = 0; k < 6; k++) for (let i = 0; i < 12; i++) { const u = A(3.4 + i * 1.45); S(u, u + 0.9, 1.15 + k * 0.3, 1.4 + k * 0.3, kp - 0.02, kp + 0.0, 0x5a4030); if ((i + k) % 3) Bx(u + 0.4, 1.3 + k * 0.3, kp - 0.04, 0.05, 0.12, 0.02, 0xe0b34a); }
      Hl(A(12), 3.3, kp - 0.3, 2.2, 0xff7a4a); S(A(8), A(16), 3.2, 3.5, kp - 0.02, kp + 0.04, 0xb3202a);
      // sofas and a coffee table in the lounge, plants in pots
      for (const id of ['motel-sofa-1', 'motel-sofa-2']) {
        const sf = box(id);
        S(sf.u0, sf.u1, 0, 0.45, sf.v0, sf.v1, 0x2f6b8c); S(sf.u0, sf.u1, 0.45, 1.05, sf.v1 - 0.4, sf.v1, 0x3a7aa0); S(sf.u0, sf.u0 + 0.35, 0.45, 0.75, sf.v0, sf.v1, 0x3a7aa0); S(sf.u1 - 0.35, sf.u1, 0.45, 0.75, sf.v0, sf.v1, 0x3a7aa0);
      }
      S(A(28), A(33), 0, 0.4, B(8.2), B(9.4), 0x5a3a2c); S(A(28.1), A(32.9), 0.4, 0.45, B(8.3), B(9.3), 0xd8c9a0);
      for (const [u, v] of [[A(23), B(2)], [A(40), B(2)], [A(2), B(21)], [A(23), B(21)]] as const) { Cy(u, v, 0, 0.3, 0.22, 0.5, 0xc9742e, 8); for (let k = 0; k < 5; k++) Ba(u + Math.cos(k * 1.3) * 0.2, 0.9 + k * 0.18, v + Math.sin(k * 1.3) * 0.2, 0.28 - k * 0.03, 0x2f8a35, 1.3, 6); }
      // vending machine and ice machine by the east end, a rack of tourist brochures
      const vd = box('motel-vending');
      S(vd.u0, vd.u1, 0, 1.9, vd.v0, vd.v1, 0xb3202a); S(vd.u0 + 0.15, vd.u1 - 0.15, 0.7, 1.75, vd.v0 - 0.03, vd.v0, 0xdff3ff); Hl((vd.u0 + vd.u1) / 2, 1.3, vd.v0 - 0.3, 1.8, 0xbfe9ff);
      for (let i = 0; i < 12; i++) Bx(vd.u0 + 0.4 + (i % 4) * 0.5, 0.95 + Math.floor(i / 4) * 0.28, vd.v0 - 0.05, 0.28, 0.2, 0.04, pick([0xf2c14e, 0x2b6cb0, 0xe4572e, 0xffffff], i));
      S(A(45), A(47.4), 0, 1.5, B(0.6), B(2), 0xdfe6ea); S(A(45.1), A(47.3), 1.2, 1.4, B(0.58), B(0.6), 0x2b6cb0);
      for (let i = 0; i < 5; i++) Bx(A(43.2 + i * 0.28), 1.3, B(0.7), 0.2, 0.34, 0.03, pick([0xf2c14e, 0x2bb3a8, 0xe86aa8, 0xe4572e], i));
      // the stairs: nine steps rising east along the box, a landing slab above, a rail. The box is solid under them.
      const sr = box('motel-stairs');
      for (let i = 0; i < 9; i++) S(sr.u0 + i * 1.0, sr.u0 + (i + 1) * 1.0, 0, 0.35 * (i + 1), sr.v0, sr.v1, pick([0x8a7a60, 0x7a6a52], i));
      S(sr.u0 + 9.0, sr.u1, 0, 3.15, sr.v0, sr.v1, 0x8a7a60);
      S(sr.u0, sr.u1, 3.15, 3.25, sr.v0 - 1.2, sr.v0, 0x7a6a52); // the balcony walkway above, overhanging the lobby
      for (let u = sr.u0; u <= sr.u1; u += 0.6) S(u, u + 0.03, 3.25, 4.1, sr.v0 - 1.2, sr.v0 - 1.17, 0xe0b34a);
      S(sr.u0, sr.u1, 4.05, 4.1, sr.v0 - 1.22, sr.v0 - 1.15, 0xe0b34a);
      r.pend(A(8), B(5), 0xffe6b8, 'bell'); r.pend(A(24), B(6), 0xffe6b8, 'bell'); r.pend(A(38), B(8), 0xffe6b8, 'bell'); r.pend(A(12), B(18), 0xffe6b8, 'bell');
      glow.pool(A(30), Y + 0.06, -B(8), 6, 0xffb070);
      break;
    }

    // ---------------------------------------------------------------------------------------------
    // STOP-N-GO: coolers, a snack wall, two gondolas of chips, jerry cans of fuel, the register
    // ---------------------------------------------------------------------------------------------
    case 'stopngo': {
      const SNACK = [0xd9342b, 0xf2c14e, 0x2b6cb0, 0x2f6b34, 0xff6a2a, 0xe86aa8, 0x7bc96f];
      const ct = box('conv-counter');
      counter(ct, 0xdfe6ea, 0x23262a, 1.05, 0xd9342b);
      // register, hot-dog roller (steel cylinders turning on a heated deck), lighters and lotto under glass
      S(A(14), A(15.4), 1.12, 1.4, ct.v0 + 0.3, ct.v1 - 0.3, DARK); Hl(A(14.7), 1.34, ct.v0 + 0.35, 0.3, 0x7bf0ff);
      S(A(3), A(7), 1.12, 1.2, ct.v0 + 0.25, ct.v1 - 0.25, STEEL); for (let i = 0; i < 5; i++) Cy(A(3.5 + i * 0.7), (ct.v0 + ct.v1) / 2, 1.25, 0.06, 0.06, 0.5, pick([0xb8541a, 0xa04a1a], i), 6, { rz: Math.PI / 2 });
      Hl(A(5), 1.35, (ct.v0 + ct.v1) / 2, 0.9, 0xffb060);
      for (let i = 0; i < 10; i++) Bx(A(9.4 + i * 0.28), 1.3, ct.v1 - 0.15, 0.14, 0.4, 0.03, pick(SNACK, i));
      // behind: a slush machine (two lit tanks), the drinks shelf and a wall of snack bags
      for (const [u, c] of [[A(2.5), 0x2b6cb0], [A(4.1), 0xd9342b]] as const) { S(u - 0.55, u + 0.55, 0, 1.1, r.v1 - 1.1, r.v1 - 0.2, 0x23262a); Cy(u, r.v1 - 0.65, 1.1, 0.4, 0.4, 0.7, c, 9); Hl(u, 1.45, r.v1 - 0.65, 1.0, c); }
      backShelves(A(6), A(19), [1.1, 1.65, 2.2, 2.75], 0.33, 0xdfe6ea, (u, y, v, i) => Bx(u, y + 0.15, v, 0.26, 0.3, 0.1, pick(SNACK, i * 3)));
      // west: three upright coolers with lit glass doors and rows of bottles; east: the snack wall
      const cw = box('conv-cooler');
      S(cw.u0, cw.u1, 0, 2.3, cw.v0, cw.v1, 0x2a2d31);
      S(cw.u1, cw.u1 + 0.03, 0.15, 2.2, cw.v0 + 0.1, cw.v1 - 0.1, 0xd8f4ff);
      for (let k = 0; k < 5; k++) for (let i = 0; i < 18; i++) Cy(cw.u1 + 0.06, cw.v0 + 0.3 + i * 0.52 * 1.0, 0.25 + k * 0.4, 0.05, 0.05, 0.28, pick([0xd9342b, 0x2b6cb0, 0xf2c14e, 0x2f6b34, 0xffffff], i + k), 5);
      Hl(cw.u1 + 0.5, 1.3, (cw.v0 + cw.v1) / 2, 4.0, 0xcfeeff);
      const sn = box('conv-snacks');
      S(sn.u0, sn.u1, 0, 2.3, sn.v0, sn.v1, 0x5a5f66);
      for (let k = 0; k < 5; k++) for (let i = 0; i < 16; i++) Bx(sn.u0 - 0.03, 0.3 + k * 0.4, sn.v0 + 0.3 + i * 0.6, 0.06, 0.3, 0.28, pick(SNACK, i + k * 2));
      // gondolas: chips and cereal, both faces, with a wire basket of fireworks-colored boxes at the end
      for (const id of ['conv-aisle-1', 'conv-aisle-2']) {
        const g = box(id);
        S(g.u0, g.u1, 0, 1.55, g.v0, g.v1, 0x5a5f66); S(g.u0, g.u1, 1.55, 1.6, g.v0 - 0.03, g.v1 + 0.03, 0xdfe6ea);
        for (let k = 0; k < 4; k++) for (let i = 0; i < 9; i++) { const u = g.u0 + 0.3 + i * 0.55; Bx(u, 0.3 + k * 0.33, g.v0 - 0.04, 0.4, 0.28, 0.08, pick(SNACK, i + k)); Bx(u, 0.3 + k * 0.33, g.v1 + 0.04, 0.4, 0.28, 0.08, pick(SNACK, i * 2 + k)); }
      }
      // jerry cans of fuel racked by the east side of the register: the thing the shelf sells
      for (let i = 0; i < 5; i++) { S(A(16.5) + i * 0.0, A(16.5) + 0.35, 0, 0.5, B(10 + i * 0.5), B(10.4 + i * 0.5), 0xd9342b); S(A(16.5) + 0.05, A(16.5) + 0.2, 0.5, 0.58, B(10.1 + i * 0.5), B(10.3 + i * 0.5), 0x23262a); }
      // front window ice chest (the door-side one outside has its twin here), and a trash can
      S(r.x0 + 2.6, r.x0 + 4.2, 0, 0.9, B(0.9), B(1.7), 0xe8edf1); S(r.x0 + 2.55, r.x0 + 4.25, 0.9, 0.95, B(0.86), B(1.74), 0x2b6cb0);
      r.pend(A(5), B(6), 0xf2fbff, 'tube'); r.pend(A(15), B(6), 0xf2fbff, 'tube'); r.pend(A(5), B(13), 0xf2fbff, 'tube'); r.pend(A(15), B(13), 0xf2fbff, 'tube');
      break;
    }
  }
}
