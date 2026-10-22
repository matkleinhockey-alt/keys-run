/**
 * The casino's set dressing outside: a carpet and rope from the car park to the door, a lit canopy,
 * a ring of bulbs along the parapet and two searchlights. Called once from build.ts's `buildLot`
 * (one branch there, so the busy shared file only gains a line); everything goes into the
 * street's existing batches, so it costs geometry but no draw calls except the two beam cones.
 *
 * Lights: none. The glow batch is additive quads gated by the sunset blend (kit.ts), the beams are
 * `kit.glowFlat` cones on the same blend; the town's four PointLights are untouched (lights.ts).
 */
import * as THREE from 'three';
import { PAD_Y, type Lot } from '@keysrun/shared/world/town';
import type { GeoBatch } from './batch.js';
import type { TownKit } from './kit.js';
import { Zf } from './props.js';

export interface ExteriorCtx {
  solid: GeoBatch; glow: GeoBatch; kit: TownKit; near: THREE.Group;
  track<T extends THREE.BufferGeometry>(g: T): T;
  mats: THREE.Material[];
}

const GOLD = 0xe0b34a, CYAN = 0x35e0ff, PINK = 0xff3fa4;

export function casinoExterior(lot: Lot, c: ExteriorCtx): void {
  const { solid, glow, kit, near } = c;
  const door = lot.door, fz = Zf(lot.v0), top = PAD_Y + lot.h;

  // a teal carpet with a gold border from the car park to the door, and a rope on gold posts either side
  solid.span(door - 2.0, door + 2.0, PAD_Y, PAD_Y + 0.035, fz + 0.1, fz + 6.2, 0xe0b34a);
  solid.span(door - 1.7, door + 1.7, PAD_Y + 0.035, PAD_Y + 0.05, fz + 0.1, fz + 6.2, 0x0e6d78);
  for (const dx of [-2.3, 2.3]) for (let k = 0; k < 3; k++) {
    solid.cyl(door + dx, PAD_Y, fz + 1.0 + k * 2.4, 0.04, 0.07, 0.9, GOLD, 8);
    solid.ball(door + dx, PAD_Y + 0.95, fz + 1.0 + k * 2.4, 0.07, GOLD, 1, 6);
    if (k < 2) solid.span(door + dx - 0.015, door + dx + 0.015, PAD_Y + 0.7, PAD_Y + 0.76, fz + 1.0 + k * 2.4, fz + 3.4 + k * 2.4 - 0.02, 0x0e6d78);
  }

  // canopy: a cantilevered slab over the doorway with a bulb line under its lip
  const cy = PAD_Y + 3.05; // just under the sign band (it starts at 3.5 m): at 4.1 the canopy hid the word CASINO
  solid.span(door - 4.2, door + 4.2, cy, cy + 0.3, fz - 0.0, fz + 3.2, 0x0b1a22);
  solid.span(door - 4.3, door + 4.3, cy + 0.3, cy + 0.42, fz - 0.05, fz + 3.3, GOLD);
  for (let i = 0; i < 9; i++) {
    const bx = door - 4.0 + i;
    solid.ball(bx, cy - 0.03, fz + 3.15, 0.08, 0xfff3b0, 1, 5);
    glow.halo(bx, cy - 0.03, fz + 3.15, 0.55, 0xffd23f);
  }
  glow.pool(door, PAD_Y + 0.06, fz + 3.4, 7, CYAN);
  glow.pool(door, PAD_Y + 0.07, fz + 3.4, 3.4, 0xffd96a);

  // two big planters either side of the door, because it is a casino and that is what they have
  for (const dx of [-5.2, 5.2]) {
    solid.cyl(door + dx, PAD_Y, fz + 1.4, 0.55, 0.7, 0.85, 0x0b3340, 10);
    solid.cyl(door + dx, PAD_Y + 0.85, fz + 1.4, 0.45, 0.5, 0.06, 0x3b2a1c, 10);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      solid.box(door + dx + Math.sin(a) * 0.5, PAD_Y + 1.5, fz + 1.4 + Math.cos(a) * 0.5, 0.25, 1.2, 0.08, 0x3f9a4a, { ry: a, rz: Math.sin(a) * 0.25 });
    }
    glow.halo(door + dx, PAD_Y + 1.9, fz + 1.4, 1.2, CYAN);
  }

  // a chase of bulbs along the parapet and a halo every few metres: from the harbour it reads as a lit crown
  const py = top + 0.62;
  for (let u = lot.u0 + 1.5; u <= lot.u1 - 1.5; u += 3) {
    glow.halo(u, py, fz - 0.1, 0.9, u % 6 < 3 ? CYAN : PINK);
    solid.ball(u, py - 0.05, fz - 0.06, 0.08, 0xfff3b0, 1, 5);
  }
  // vertical neon fins either side of the front, like the strip's old casinos
  for (const ux of [lot.u0 + 0.9, lot.u1 - 0.9]) {
    solid.span(ux - 0.12, ux + 0.12, PAD_Y, top + 0.6, fz + 0.0, fz + 0.5, 0x0b1a22);
    for (let y = 1.2; y < lot.h; y += 1.6) glow.halo(ux, PAD_Y + y, fz + 0.6, 0.9, y % 3.2 < 1.6 ? GOLD : CYAN);
  }

  // searchlights: additive cones, brighter at the base, crossed over the roof
  for (const [dx, tilt, col] of [[-12, 0.3, CYAN], [12, -0.3, 0xffd96a]] as const) {
    const g = c.track(new THREE.ConeGeometry(2.4, 40, 12, 1, true).translate(0, 20, 0));
    const mat = kit.glowFlat(col, 0.15);
    const m = new THREE.Mesh(g, mat);
    m.name = 'casino-beam'; m.renderOrder = 3; m.castShadow = false; m.receiveShadow = false;
    m.position.set((lot.u0 + lot.u1) / 2 + dx, top + 0.7, fz - 1.5);
    m.rotation.z = tilt;
    near.add(m);
    c.mats.push(mat);
  }
}
