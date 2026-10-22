/**
 * Street furniture: palms, lamps, benches, cars, the marlin statue. Everything here is drawn into
 * `GeoBatch`es (see batch.ts), in the town group's local frame: x = u across the frontage,
 * z = -v (so seaward is +z and a front facade faces +z, the three.js default), y up from the sea.
 *
 * Positions come from `world/town.ts` — this file decides what a palm looks like, never where it is.
 */
import { PAD_Y, type Car } from '@keysrun/shared/world/town';
import { palmTrunkAt } from '@keysrun/shared/world/town-life';
import type { GeoBatch } from './batch.js';

/** Local-frame helper: (u, v) -> (x, z). */
export const Zf = (v: number): number => -v;

const TRUNK = 0xaa9577, TRUNK_DARK = 0x8c7758;
const FROND = [0x4f9a3c, 0x62b04a, 0x73c15a, 0x58a443];

/**
 * A palm in a stone planter. Deterministic from (u,v) so rebuilds never reshuffle the street.
 *
 * The trunk used to be three vertical cylinders, each stepped sideways from the one below: a stack of
 * offset drums with a visible shelf at every joint (see the "alley" capture in the polish report). It
 * is now a smooth curve of six tilted segments, tapering, along `palmTrunkAt` from the shared module,
 * which is also the curve the squirrels climb, so the animal is on the trunk that is drawn.
 */
export function palm(solid: GeoBatch, u: number, v: number, h: number, planter = true): void {
  const p = { u, v, h };
  const x = u, z = Zf(v);
  let y = PAD_Y;
  if (planter) { solid.span(x - 0.9, x + 0.9, y, y + 0.45, z - 0.9, z + 0.9, 0xa49c8c); solid.span(x - 0.75, x + 0.75, y + 0.45, y + 0.5, z - 0.75, z + 0.75, 0x3b2a1c); y += 0.5; }
  const seed = Math.abs(Math.sin(u * 12.9898 + v * 78.233) * 43758.5453) % 1;
  const N = 6;
  let top = palmTrunkAt(p, 0);
  for (let i = 0; i < N; i++) {
    const a = palmTrunkAt(p, i / N), b = palmTrunkAt(p, (i + 1) / N);
    const dx = b.u - a.u, dy = b.y - a.y, dz = -(b.v - a.v), len = Math.hypot(dx, dy, dz);
    // an axis along (dx,dy,dz): about z first, then x (the batch's YXZ order)
    solid.cyl((a.u + b.u) / 2, (a.y + b.y) / 2 - len / 2, -(a.v + b.v) / 2, b.r, a.r, len * 1.04, i % 2 ? TRUNK : TRUNK_DARK, 7, { rx: Math.atan2(dz, dy), rz: -Math.asin(dx / len) });
    top = b;
  }
  void y;
  const cx = top.u, cy = top.y, cz = -top.v;
  // crown: a fan of fronds that rise off the trunk and then droop, three blades each, greens that vary frond to frond
  const n = 11;
  for (let k = 0; k < n; k++) {
    const ang = (k / n) * Math.PI * 2 + seed * 3, len = 3.2 + ((k * 7) % 3) * 0.35, seg = len / 3;
    let px = cx, py = cy - 0.02, pz = cz;
    const col = FROND[(k + Math.floor(seed * 4)) % 4];
    for (let j = 0; j < 3; j++) {
      const pitch = [0.5, 0.05, -0.55][j] - (k % 3) * 0.08; // up, level, drooping
      const dx = Math.sin(ang) * Math.cos(pitch), dy = Math.sin(pitch), dz = Math.cos(ang) * Math.cos(pitch);
      solid.box(px + dx * seg / 2, py + dy * seg / 2, pz + dz * seg / 2, [0.95, 0.8, 0.55][j], 0.05, seg * 1.04, j === 2 && k % 2 ? 0x8fa347 : col, { ry: ang, rx: -pitch });
      px += dx * seg; py += dy * seg; pz += dz * seg;
    }
  }
  // two dead fronds hanging under the crown, and the coconuts
  for (const k of [1, 5]) solid.box(cx + Math.sin(k) * 0.5, cy - 0.7, cz + Math.cos(k) * 0.5, 0.3, 1.3, 0.04, 0x8a6a3a, { ry: k, rx: 0.2 });
  solid.ball(cx - 0.1, cy - 0.22, cz + 0.1, 0.17, 0x5a4a2a, 1, 6); solid.ball(cx + 0.15, cy - 0.26, cz - 0.08, 0.15, 0x6a5a30, 1, 6); solid.ball(cx, cy - 0.3, cz + 0.2, 0.14, 0x4f4226, 1, 6);
}

/** Street lamp: returns the world-ish (local) position of the lamp head for the light pool. */
export function lamp(solid: GeoBatch, glow: GeoBatch, u: number, v: number, color = 0xffe2a8): { x: number; y: number; z: number } {
  const x = u, z = Zf(v), y0 = PAD_Y;
  solid.cyl(x, y0, z, 0.07, 0.11, 4.4, 0x4b5158, 6);
  solid.cyl(x, y0, z, 0.22, 0.26, 0.4, 0x4b5158, 8);
  solid.box(x, y0 + 4.45, z, 0.7, 0.1, 0.22, 0x4b5158);
  solid.box(x, y0 + 4.34, z, 0.5, 0.14, 0.18, 0xf2f0e6);
  glow.halo(x, y0 + 4.2, z, 1.7, color);
  glow.pool(x, y0 + 0.05, z, 6.5, color);
  return { x, y: y0 + 4.2, z };
}

export function bench(solid: GeoBatch, u: number, v: number): void {
  const x = u, z = Zf(v), y = PAD_Y;
  solid.box(x, y + 0.45, z, 1.8, 0.07, 0.45, 0x8a5a36);
  solid.box(x, y + 0.8, z - 0.2, 1.8, 0.4, 0.07, 0x8a5a36); // back, toward the inland side
  for (const dx of [-0.8, 0.8]) solid.box(x + dx, y + 0.22, z, 0.08, 0.44, 0.4, 0x2d3136);
}

export function trashCan(solid: GeoBatch, u: number, v: number): void {
  solid.cyl(u, PAD_Y, Zf(v), 0.3, 0.26, 0.9, 0x5d7364, 8);
  solid.cyl(u, PAD_Y + 0.9, Zf(v), 0.32, 0.32, 0.06, 0x3a4044, 8);
}

/** Moored-looking bollard along the seawall. */
export function bollard(solid: GeoBatch, u: number, v: number): void {
  solid.cyl(u, PAD_Y, Zf(v), 0.14, 0.17, 0.55, 0x2f3438, 8);
  solid.cyl(u, PAD_Y + 0.55, Zf(v), 0.2, 0.14, 0.1, 0x2f3438, 8);
}

// ---------------------------------------------------------------------------------------------

const GLASS = 0x1d2a33, TYRE = 0x16171a, CHROME = 0xd4d8dc;

interface Placer { box(lx: number, ly: number, lz: number, w: number, h: number, d: number, c: number): void; cyl(lx: number, ly: number, lz: number, r: number, w: number, c: number): void }

/** Primitive placer in a car's own frame (nose +x, width along z), rotated by `rot` into the local frame. */
function placer(b: GeoBatch, cx: number, cz: number, rot: number, y0: number): Placer {
  const cs = Math.cos(rot), sn = Math.sin(rot);
  // (u,v)-plane angle `rot` -> local-frame (x, z=-v): the nose points along (cos, -sin)
  const to = (lx: number, lz: number): [number, number] => [cx + lx * cs + lz * sn, cz - lx * sn + lz * cs];
  return {
    box(lx, ly, lz, w, h, d, c) { const [x, z] = to(lx, lz); b.box(x, y0 + ly, z, w, h, d, c, { ry: rot }); },
    cyl(lx, ly, lz, r, w, c) { const [x, z] = to(lx, lz); b.cyl(x, y0 + ly - w / 2, z, r, r, w, c, 10, { ry: rot, rx: Math.PI / 2 }); },
  };
}

export function car(b: GeoBatch, c: Car): void {
  const P = placer(b, c.u, Zf(c.v), c.rot, PAD_Y);
  const body = c.color;
  const wheel = (lx: number, lz: number, r = 0.36): void => { P.cyl(lx, r, lz, r, 0.26, TYRE); P.cyl(lx, r, lz + Math.sign(lz) * 0.14, r * 0.55, 0.04, CHROME); };
  if (c.kind === 'pickup') {
    P.box(0, 0.62, 0, 4.8, 0.5, 1.95, body);
    P.box(0.55, 1.1, 0, 1.9, 0.62, 1.8, body); P.box(0.55, 1.12, 0, 1.75, 0.5, 1.84, GLASS);
    P.box(-1.4, 0.95, 0, 1.9, 0.12, 1.85, 0x23262a);
    wheel(1.5, 0.95); wheel(1.5, -0.95); wheel(-1.45, 0.95); wheel(-1.45, -0.95);
  } else if (c.kind === 'suv') {
    P.box(0, 0.7, 0, 4.7, 0.62, 1.95, body);
    P.box(-0.1, 1.28, 0, 3.4, 0.62, 1.85, body); P.box(-0.1, 1.3, 0, 3.3, 0.48, 1.88, GLASS);
    wheel(1.45, 0.95); wheel(1.45, -0.95); wheel(-1.4, 0.95); wheel(-1.4, -0.95);
  } else if (c.kind === 'convertible') {
    P.box(0, 0.58, 0, 5.0, 0.46, 1.95, body);
    P.box(0.5, 0.98, 0, 0.12, 0.45, 1.7, GLASS); // windscreen
    P.box(-0.5, 0.86, 0.5, 1.0, 0.3, 0.6, 0xe9d6c0); P.box(-0.5, 0.86, -0.5, 1.0, 0.3, 0.6, 0xe9d6c0);
    P.box(-2.4, 0.95, 0, 0.35, 0.18, 1.7, body); // tail fins: it is a Cadillac
    wheel(1.55, 0.95); wheel(1.55, -0.95); wheel(-1.5, 0.95); wheel(-1.5, -0.95);
  } else if (c.kind === 'van') {
    // a work van: tall, square, a ladder on the roof and a sliding door line down the side
    P.box(0, 1.0, 0, 4.9, 1.35, 1.95, body);
    P.box(2.0, 1.45, 0, 0.9, 0.55, 1.9, GLASS);
    P.box(1.3, 1.1, 0.985, 0.04, 0.9, 0.02, 0x00000a); P.box(1.3, 1.1, -0.985, 0.04, 0.9, 0.02, 0x00000a);
    P.box(-0.2, 0.5, 0, 4.9, 0.08, 1.99, 0x2a2d30);
    for (const lz of [-0.55, 0.55]) P.box(-0.2, 1.74, lz, 3.6, 0.05, 0.05, 0xb9bec2);
    for (let i = 0; i < 7; i++) P.box(-1.8 + i * 0.55, 1.745, 0, 0.04, 0.04, 1.15, 0xb9bec2);
    wheel(1.55, 0.95); wheel(1.55, -0.95); wheel(-1.5, 0.95); wheel(-1.5, -0.95);
  } else if (c.kind === 'wagon') {
    // an old woodie: long roof, wood panels down the flanks
    P.box(0, 0.62, 0, 4.9, 0.5, 1.9, body);
    P.box(-0.35, 1.12, 0, 3.0, 0.5, 1.78, body); P.box(-0.35, 1.14, 0, 2.9, 0.4, 1.82, GLASS);
    for (const lz of [-0.96, 0.96]) { P.box(0, 0.66, lz, 4.6, 0.28, 0.03, 0xc9a063); P.box(-0.35, 1.16, lz * 0.94, 2.8, 0.06, 0.03, 0xc9a063); }
    P.box(-0.35, 1.42, 0, 2.6, 0.04, 1.5, 0x6b4a2b);
    wheel(1.5, 0.92); wheel(1.5, -0.92); wheel(-1.45, 0.92); wheel(-1.45, -0.92);
  } else if (c.kind === 'cart') {
    // a golf cart: the only legal way to get anywhere in the lower Keys at 15 mph
    P.box(0.1, 0.42, 0, 2.5, 0.28, 1.15, body);
    P.box(-0.55, 0.78, 0, 0.8, 0.5, 1.05, 0xe9d6c0); P.box(0.4, 0.62, 0, 0.8, 0.14, 1.05, 0xe9d6c0);
    for (const lx of [-0.9, 0.95]) for (const lz of [-0.55, 0.55]) P.box(lx, 1.12, lz, 0.04, 1.0, 0.04, 0xe8ebee);
    P.box(0.0, 1.66, 0, 2.2, 0.06, 1.3, 0xf2f2ee);
    P.box(1.3, 0.55, 0, 0.12, 0.3, 0.9, body);
    for (const [lx, lz] of [[0.85, 0.6], [0.85, -0.6], [-0.75, 0.6], [-0.75, -0.6]] as const) { P.cyl(lx, 0.22, lz, 0.22, 0.14, TYRE); }
  } else {
    P.box(0, 0.6, 0, 4.7, 0.5, 1.85, body);
    P.box(-0.2, 1.1, 0, 2.5, 0.5, 1.7, body); P.box(-0.2, 1.12, 0, 2.4, 0.4, 1.74, GLASS);
    wheel(1.45, 0.9); wheel(1.45, -0.9); wheel(-1.4, 0.9); wheel(-1.4, -0.9);
  }
  // what every car has and these did not: a plate, a bumper, and (on some) a kayak on the roof, because Marathon
  const hash = [...c.id].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  if (c.kind !== 'cart') {
    P.box(-2.41, 0.5, 0, 0.02, 0.15, 0.34, 0xf4f1e6); P.box(-2.415, 0.55, 0, 0.02, 0.025, 0.3, 0xe48a2c);
    P.box(-2.4, 0.32, 0, 0.09, 0.12, 1.8, 0x2a2d30); P.box(2.4, 0.32, 0, 0.09, 0.12, 1.8, 0x2a2d30);
    P.box(2.41, 0.5, 0, 0.02, 0.15, 0.34, 0xf4f1e6);
  }
  if ((c.kind === 'suv' || c.kind === 'wagon') && hash % 2 === 0) {
    for (const lx of [-0.9, 0.8]) P.box(lx, c.kind === 'suv' ? 1.66 : 1.46, 0, 0.06, 0.05, 1.2, 0x2a2d30);
    P.box(-0.1, c.kind === 'suv' ? 1.78 : 1.58, 0.1, 3.4, 0.17, 0.56, [0xe4572e, 0xf2c14e, 0x2bb3a8][hash % 3]);
    P.box(1.5, c.kind === 'suv' ? 1.78 : 1.58, 0.1, 0.3, 0.12, 0.3, [0xe4572e, 0xf2c14e, 0x2bb3a8][hash % 3]);
  }
  P.box(2.38, 0.62, 0.7, 0.06, 0.16, 0.34, 0xfff4c8); P.box(2.38, 0.62, -0.7, 0.06, 0.16, 0.34, 0xfff4c8);
  P.box(-2.38, 0.62, 0.7, 0.06, 0.14, 0.3, 0xa11b1b); P.box(-2.38, 0.62, -0.7, 0.06, 0.14, 0.3, 0xa11b1b);
  if (c.trailer) {
    // A boat on a trailer behind the truck: the most Keys thing in the parking lot.
    const T = placer(b, c.u, Zf(c.v), c.rot, PAD_Y);
    T.box(-6.2, 0.55, 0, 7.4, 0.12, 1.7, 0x3a3d42);
    T.box(-3.2, 0.5, 0, 2.0, 0.07, 0.07, 0x3a3d42);
    T.cyl(-6.6, 0.4, 1.0, 0.4, 0.2, TYRE); T.cyl(-6.6, 0.4, -1.0, 0.4, 0.2, TYRE);
    T.box(-6.4, 1.1, 0, 6.6, 0.9, 2.3, 0xf2f2ee);       // hull
    T.box(-6.4, 1.0, 0, 6.7, 0.18, 2.35, 0x23466e);      // boot stripe
    T.box(-3.1, 1.15, 0, 1.2, 0.7, 1.3, 0xf2f2ee);       // bow, narrowed
    T.box(-6.9, 1.8, 0, 1.4, 0.7, 1.1, 0xdfe6ea);        // console
    T.box(-9.8, 1.2, 0, 0.5, 0.9, 0.7, 0x15171a);        // outboard
  }
}

/** The leaping blue marlin on the promenade: a curve of tapered segments climbing off a plinth. */
export function marlinStatue(b: GeoBatch, u: number, v: number): void {
  const x = u, z = Zf(v), y0 = PAD_Y;
  b.span(x - 1.3, x + 1.3, y0, y0 + 0.9, z - 1.3, z + 1.3, 0xb7b2a6);
  b.span(x - 1.1, x + 1.1, y0 + 0.9, y0 + 1.1, z - 1.1, z + 1.1, 0x8d8a82);
  // brass plaque on the sea-facing side
  b.box(x, y0 + 0.6, z + 1.32, 0.9, 0.35, 0.04, 0xc9a24a);
  const seg = 9;
  for (let i = 0; i < seg; i++) {
    const t = i / (seg - 1), ang = -0.2 + t * 1.9; // arcs up and over
    const px = x - 1.1 + t * 2.0, py = y0 + 1.7 + Math.sin(t * Math.PI * 0.85) * 3.6 + t * 0.8;
    const th = 0.55 - t * 0.3;
    b.box(px, py, z, 0.9, th, th, i < 8 ? 0x1f6fb0 : 0xdfe6ea, { rz: ang * 0.7 });
  }
  b.box(x + 1.1, y0 + 5.6, z, 1.3, 0.1, 0.1, 0x1f6fb0, { rz: 0.8 });     // bill
  b.box(x - 0.2, y0 + 4.4, z, 0.1, 1.2, 0.5, 0x134a7a);                  // dorsal sail
  b.box(x - 1.2, y0 + 1.6, z, 0.12, 1.1, 0.7, 0x134a7a, { rz: 0.5 });    // tail
}
