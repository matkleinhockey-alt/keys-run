/**
 * The backs and sides of the buildings.
 *
 * ## What was wrong
 * Every storefront had a painted face and, behind it, a flat-coloured box: the rear walls (which you walk
 * along in the back lane, where the skunks and the loader are), and the side walls facing Palm Avenue and the
 * alley, were slabs of one saturated colour with no seam, no door, no pipe and no stain, 24 m of navy blue at
 * a time. (First captures: `before-17-back-lane`, `before-20-alley`, `before-19-row1-rears`.) A town is
 * mostly its backs.
 *
 * ## What it is now
 *   - ONE merged mesh of wall decals (one draw call for every rear and open side in town) sampling a single
 *     3 m block-and-stucco tile, tinted per building through vertex colour and shaded dark at the base and
 *     bleached at the top by the same vertex colours, so ten neighbours cost one texture and one draw.
 *   - Real geometry for what hangs on a back wall, in the street's `GeoBatch` language: a steel back door
 *     with a step and a wall lamp, an air-conditioner with its refrigerant line, downpipes, a gas meter, a
 *     high barred window. Real boxes cast the small shadows that make a wall look like it has things on it.
 *   - The wall lamp has a night halo and a pool of light on the lane (the glow batch, no lights), which is the
 *     thing that lights the back lane at dusk for the skunks.
 *
 * Sides that touch another building are skipped: they are not visible and would just be two decals
 * fighting over a plane. The Pink Flamingo used to be skipped ENTIRELY while its lot was being
 * redesigned, which left the one building on the street with a reason to have an interesting back
 * — a stage door — as a flat slab of navy. The redesign landed long ago; it now has the back a
 * cabaret actually has (`clubRearDetails`). Both its sides touch neighbours (the bar at u 34, the
 * gift shop at u 68), so the rear is all it needs.
 */
import * as THREE from 'three';
import { LOTS, PAD_Y, type Lot } from '@keysrun/shared/world/town';
import { GeoBatch } from './batch.js';
import { fadeColor, LOOKS } from './paint.js';
import type { TownKit } from './kit.js';
import { Zf } from './props.js';

function lcg(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed) * 1000) + 99) >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** A 3 m tile of painted block and stucco, neutral grey so each building's colour comes from the vertex colour. */
function wallTile(): THREE.CanvasTexture {
  const n = 256, c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d')!, r = lcg(7);
  g.fillStyle = '#e4dfd2'; g.fillRect(0, 0, n, n);
  for (let i = 0; i < 2600; i++) { const v = 140 + r() * 110; g.fillStyle = `rgba(${v},${v},${v},0.16)`; g.fillRect(r() * n, r() * n, 1 + r() * 2, 1 + r() * 2); }
  // block courses: every 20 cm, staggered, the joints dark where the paint has gone
  g.strokeStyle = 'rgba(70,64,54,0.34)'; g.lineWidth = 1.4;
  for (let y = 0, row = 0; y < n; y += 17, row++) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(n, y); g.stroke();
    for (let x = (row % 2) * 17; x < n; x += 34) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 17); g.stroke(); }
  }
  // water staining and a patch of repainted block
  for (let i = 0; i < 5; i++) {
    const x = r() * n, w = 6 + r() * 20, gr = g.createLinearGradient(0, 0, 0, n);
    gr.addColorStop(0, 'rgba(60,50,40,0.20)'); gr.addColorStop(0.5, 'rgba(60,50,40,0.07)'); gr.addColorStop(1, 'rgba(60,50,40,0)');
    g.fillStyle = gr; g.fillRect(x, 0, w, n * (0.4 + r() * 0.5));
  }
  g.fillStyle = 'rgba(255,255,255,0.09)'; g.fillRect(n * 0.55, n * 0.4, n * 0.3, n * 0.22);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

const touches = (a: Lot, b: Lot, side: 'u0' | 'u1'): boolean => {
  if (a === b) return false;
  const gapOk = side === 'u0' ? Math.abs(b.u1 - a.u0) < 0.06 : Math.abs(b.u0 - a.u1) < 0.06;
  return gapOk && b.v0 < a.v1 && b.v1 > a.v0;
};

export function buildWalls(near: THREE.Group, glow: GeoBatch, kit: TownKit): { dispose(): void; triangles: number } {
  const tile = wallTile();
  const mat = new THREE.MeshStandardMaterial({
    // no emissive: it is tint-blind and washed every building's colour to the same pale block (first attempt: a blue dive and a yellow
    // gift shop both read cream). The lift is in the vertex colours instead, which keep the hue.
    map: tile, vertexColors: true, roughness: 0.95,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  // the details on the walls: lifted uniformly, since a rear wall faces away from a low sun like the rest of the street's shade
  const det = new GeoBatch(false, 1.5);
  const pos: number[] = [], uv: number[] = [], col: number[] = [], nor: number[] = [], idx: number[] = [];
  const c = new THREE.Color();

  /** A wall decal over [a0,a1] along the wall and [PAD_Y, top] up it, facing `n` (+1 / -1) along its normal axis. */
  function wall(axis: 'x' | 'z', fixed: number, a0: number, a1: number, top: number, n: 1 | -1, tint: number): void {
    // three rows so the vertex colours can darken the foot (rain splash, a century of shoes) and bleach the head
    const rows: Array<[number, number]> = [[PAD_Y, 0.8], [PAD_Y + 0.9, 1.35], [top, 1.6]];
    const base = pos.length / 3;
    c.setHex(tint);
    for (const [y, k] of rows) {
      for (const a of [a0, a1]) {
        if (axis === 'z') pos.push(a, y, fixed); else pos.push(fixed, y, a);
        uv.push(a / 3, y / 3);
        col.push(c.r * k, c.g * k, c.b * k);
        nor.push(axis === 'x' ? n : 0, 0, axis === 'z' ? n : 0);
      }
    }
    for (let r = 0; r < 2; r++) {
      const i0 = base + r * 2;
      // wind so that the front face looks along +n of the plane's normal axis
      const flip = axis === 'z' ? n < 0 : n > 0;
      if (!flip) idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2); else idx.push(i0, i0 + 3, i0 + 1, i0, i0 + 2, i0 + 3);
    }
  }

  const sill = PAD_Y;

  /**
   * How wide a stretch of back wall gets one set of fixtures. A back door, an air conditioner, a
   * gas meter and one barred window is the right amount of stuff for a 24 m storefront and
   * nothing at all for the casino's 48 m or the motel's 52: one door in the middle of half a
   * football pitch of blank block reads as unfinished, which is exactly what the first captures
   * of the back lot showed. Walls wider than this get a set per bay, each rolled from the bay's
   * own seed so the repeats are not copies of each other.
   */
  const BAY_W = 16;

  function rearDetails(l: Lot, i: number): void {
    const W = l.u1 - l.u0;
    const bays = Math.max(1, Math.round(W / BAY_W));
    for (let b = 0; b < bays; b++) {
      rearBay(l, l.u0 + (W * b) / bays, l.u0 + (W * (b + 1)) / bays, b, i);
    }
  }

  function rearBay(l: Lot, bu0: number, bu1: number, bay: number, i: number): void {
    const r = lcg(l.u0 * 3.1 + l.v1 + bay * 7.7), W = bu1 - bu0;
    const z = Zf(l.v1);                       // the wall face; things stand off it toward -z (inland, +v)
    const off = (d: number): number => z - d;
    const doorU = bu0 + W * (0.22 + 0.5 * r());
    // steel back door, frame, step, a hasp and a wall lamp
    det.span(doorU - 0.55, doorU + 0.55, sill, sill + 2.12, off(0.07), off(0.0), 0x6f767c);
    det.span(doorU - 0.6, doorU + 0.6, sill + 2.12, sill + 2.2, off(0.09), off(0.0), 0x4d5359);
    det.span(doorU - 0.6, doorU - 0.55, sill, sill + 2.2, off(0.09), off(0.0), 0x4d5359);
    det.span(doorU + 0.55, doorU + 0.6, sill, sill + 2.2, off(0.09), off(0.0), 0x4d5359);
    det.span(doorU - 0.7, doorU + 0.7, sill, sill + 0.12, off(0.55), off(0.0), 0x9a968a);
    det.box(doorU + 0.36, sill + 1.05, off(0.1), 0.08, 0.18, 0.04, 0xd8d8d8);
    det.span(doorU - 0.14, doorU + 0.14, sill + 2.45, sill + 2.6, off(0.2), off(0.0), 0x3a3d42);
    det.ball(doorU, sill + 2.42, off(0.12), 0.08, 0xfff0b0, 1, 6);
    glow.halo(doorU, sill + 2.4, off(0.35), 1.5, 0xffd070);
    glow.pool(doorU, PAD_Y + 0.06, off(1.4), 3.2, 0xffd9a0);
    // an air conditioner on a pad, with its refrigerant line up the wall and a puddle's worth of drip stain below it
    const acU = bu0 + W * (0.62 + 0.28 * r());
    det.span(acU - 0.5, acU + 0.5, sill + 0.05, sill + 0.17, off(0.7), off(0.0), 0x9a968a);
    det.span(acU - 0.48, acU + 0.48, sill + 0.17, sill + 0.85, off(0.64), off(0.02), 0xcfd3d6);
    det.cyl(acU, sill + 0.86, off(0.34), 0.28, 0.28, 0.03, 0x2a2d30, 10);
    det.cyl(acU + 0.3, sill + 0.4, off(0.02), 0.025, 0.025, 2.2, 0xb87333, 6);
    // downpipes at both corners and a gas meter
    // Downpipes belong to the BUILDING's corners, not to every bay — one per corner, so a wide
    // wall does not sprout a pipe every sixteen metres.
    for (const dx of [l.u0 + 0.35, l.u1 - 0.35]) {
      if (dx < bu0 || dx > bu1) continue;
      det.cyl(dx, sill, off(0.05), 0.045, 0.045, Math.min(l.h, 5) - 0.3, 0xb9bec2, 6);
    }
    det.span(doorU - 2.4, doorU - 1.8, sill + 0.7, sill + 1.2, off(0.25), off(0.0), 0xc9a24a);
    // a high barred window and an extractor vent: back-of-house
    const wU = bu0 + W * (0.12 + 0.2 * r());
    det.span(wU - 0.5, wU + 0.5, sill + 2.4, sill + 3.1, off(0.05), off(0.0), 0x1d2a33);
    for (let b = -0.4; b <= 0.4; b += 0.2) det.box(wU + b, sill + 2.75, off(0.07), 0.025, 0.7, 0.025, 0x23262a);
    det.span(wU - 0.55, wU + 0.55, sill + 2.36, sill + 2.4, off(0.1), off(0.0), 0xd8d4c8);
    if (l.h > 4.3) { det.cyl(bu0 + W * 0.45, sill + 3.2, off(0.18), 0.22, 0.22, 0.3, 0x9a9fa4, 8, { rx: Math.PI / 2 }); }
    void i;
  }

  /**
   * The back of the Pink Flamingo. A cabaret's rear is not a shop's: there is no delivery door and
   * no gas meter, there is a STAGE door with a light over it that is on all night, the extraction
   * for a room full of people, a dumpster nobody has emptied, and the back of a neon sign leaking
   * pink over the lane. The generic `rearDetails` would have given it a tradesman's entrance and a
   * barred window, which is the one building on this street where that is wrong.
   */
  function clubRearDetails(l: Lot): void {
    const r = lcg(l.u0 * 5.3 + l.v1);
    const W = l.u1 - l.u0, mid = (l.u0 + l.u1) / 2;
    const z = Zf(l.v1);
    const off = (d: number): number => z - d;
    const PINK = 0xff3ea5;

    // Stage door: a double steel door, a step, a grab rail, and the bare bulb in a cage above it.
    const dU = mid - W * 0.18;
    det.span(dU - 0.95, dU + 0.95, sill, sill + 2.25, off(0.08), off(0.0), 0x4a3a46);
    det.span(dU - 0.02, dU + 0.02, sill, sill + 2.25, off(0.10), off(0.0), 0x2a2030); // the leaf joint
    det.span(dU - 1.02, dU + 1.02, sill + 2.25, sill + 2.36, off(0.11), off(0.0), 0x32262e);
    for (const sx of [-1, 1]) det.span(dU + sx * 0.99, dU + sx * 1.02, sill, sill + 2.36, off(0.11), off(0.0), 0x32262e);
    det.span(dU - 1.2, dU + 1.2, sill, sill + 0.14, off(0.7), off(0.0), 0x6a6460);           // the step
    for (const sx of [-1, 1]) det.cyl(dU + sx * 0.45, sill + 1.08, off(0.12), 0.025, 0.025, 1.1, 0xc9c2bc, 6);
    det.ball(dU, sill + 2.62, off(0.14), 0.09, 0xfff0c0, 1, 6);
    det.span(dU - 0.16, dU + 0.16, sill + 2.46, sill + 2.78, off(0.26), off(0.02), 0x2a2030); // the cage
    glow.halo(dU, sill + 2.6, off(0.4), 1.7, 0xffd9a0);
    glow.pool(dU, PAD_Y + 0.06, off(1.6), 3.6, 0xffd9a0);

    // Extraction: two big roof-height fan housings and the trunking that feeds them. A room this
    // size needs real air moved, and it is the loudest thing in the lane at 2 a.m.
    for (const k of [0, 1]) {
      const fu = mid + W * (0.1 + k * 0.22);
      det.span(fu - 0.62, fu + 0.62, sill + 2.6, sill + 3.9, off(0.95), off(0.05), 0x7e7a74);
      det.cyl(fu, sill + 3.25, off(1.0), 0.46, 0.46, 0.14, 0x2e2c2a, 12, { rx: Math.PI / 2 });
      for (let b = 0; b < 4; b++) {
        const a = (b / 4) * Math.PI * 2 + r() * 0.7;
        det.box(fu + Math.cos(a) * 0.22, sill + 3.25 + Math.sin(a) * 0.22, off(1.06), 0.3, 0.1, 0.02, 0x4a4845, { rz: a });
      }
      det.span(fu - 0.3, fu + 0.3, sill + 0.5, sill + 2.6, off(0.5), off(0.08), 0x8d8982);
    }

    // The dumpster, against the wall, lid half up. Every club has one and it is always full.
    const gu = l.u0 + W * 0.16;
    det.span(gu - 1.1, gu + 1.1, sill + 0.12, sill + 1.28, off(1.35), off(0.1), 0x2e5a46);
    det.span(gu - 1.15, gu + 1.15, sill + 1.28, sill + 1.36, off(1.45), off(0.05), 0x24493a);
    det.box(gu, sill + 1.62, off(1.35), 2.2, 0.08, 1.2, 0x24493a, { rx: -0.5 });              // the raised lid
    for (const sx of [-1, 1]) for (const sz of [0.25, 1.15]) det.cyl(gu + sx * 0.95, sill + 0.06, off(sz), 0.12, 0.12, 0.12, 0x1a1a1a, 8, { rx: Math.PI / 2 });
    // bagged rubbish piled beside it, because the dumpster is full
    for (let b = 0; b < 3; b++) det.ball(gu + 1.5 + b * 0.42, sill + 0.26 + r() * 0.1, off(0.55 + r() * 0.5), 0.3, 0x22262a, 1, 6);

    // The back of the roof sign: no letters this side, just the frame, the conduit and the pink
    // spilling past it onto the lane. This is the thing that tells you what the building is from
    // the back lane at night.
    const top = PAD_Y + l.h;
    det.span(mid - W * 0.3, mid + W * 0.3, top + 0.1, top + 1.9, off(0.35), off(0.1), 0x241a22);
    for (let k = -2; k <= 2; k++) det.box(mid + k * W * 0.12, top + 1.0, off(0.42), 0.07, 1.8, 0.07, 0x3a2c36);
    det.cyl(mid - W * 0.3, top + 0.1, off(0.3), 0.03, 0.03, 1.8, 0x3a2c36, 6);
    for (let k = -1; k <= 1; k++) glow.halo(mid + k * W * 0.2, top + 1.0, off(0.6), 2.6, PINK);
    glow.pool(mid, PAD_Y + 0.05, off(2.4), 11, PINK);

    // A single high window, blacked out from the inside — a dressing room nobody can see into.
    const wu = l.u1 - W * 0.14;
    det.span(wu - 0.6, wu + 0.6, sill + 3.1, sill + 3.9, off(0.05), off(0.0), 0x120a14);
    det.span(wu - 0.66, wu + 0.66, sill + 3.04, sill + 3.1, off(0.1), off(0.0), 0x3a2c36);
  }

  /**
   * A side wall gets the same treatment by the metre that a rear one does.
   *
   * It used to place a fixed set — two windows, a downpipe, a meter — however long the wall was,
   * while `rearDetails` above bays every BAY_W and says exactly why: "one door in the middle of
   * half a football pitch of blank block reads as unfinished". Ten of the twelve exposed sides in
   * town are longer than that 16 m (the casino's is 26, the diner, the bar and the motel 24), and
   * these are the walls you walk the length of on Palm Avenue and in the alley, so they were the
   * emptiest surfaces in the town and the ones most looked at.
   *
   * Bayed now, each bay rolled from its own seed. The things a building has ONE of stay one: the
   * downpipe at the back corner and the meter, same as the rear wall keeps its downpipes to the
   * building's corners rather than sprouting one per bay.
   */
  function sideDetails(l: Lot, x: number, dir: 1 | -1, i: number): void {
    const D = l.v1 - l.v0;
    const bays = Math.max(1, Math.round(D / BAY_W));
    for (let b = 0; b < bays; b++) sideBay(l, x, dir, l.v0 + (D * b) / bays, l.v0 + (D * (b + 1)) / bays, b, i);

    // One downpipe, at the back corner where the gutter actually drains.
    det.cyl(x + dir * 0.05, PAD_Y, Zf(l.v1) + 0.2, 0.045, 0.045, Math.min(l.h, 5) - 0.3, 0xb9bec2, 6);
    // A meter box and its conduit run, because every wall has a conduit run. One per building.
    const mz = Zf(l.v0 + D * 0.5);
    det.span(x, x + dir * 0.18, PAD_Y + 1.1, PAD_Y + 1.7, mz - 0.3, mz + 0.3, 0x8d8f91);
    det.box(x + dir * 0.03, PAD_Y + 1.4 + (l.h - 1.4) / 2 - 0.6, mz, 0.04, l.h - 1.8, 0.04, 0x4a4d52);
  }

  function sideBay(l: Lot, x: number, dir: 1 | -1, bv0: number, bv1: number, bay: number, i: number): void {
    const r = lcg(l.u0 * 1.3 + l.v0 * 0.7 + i + bay * 11.3), D = bv1 - bv0;
    // Windows are only on the upper part of a side wall: two per bay, with sills.
    const wh = Math.min(l.h - 1.2, 3.4);
    for (const f of [0.28, 0.7]) {
      const wz = Zf(bv0 + D * (f + (r() - 0.5) * 0.06));
      det.span(x + dir * 0.0, x + dir * 0.06, PAD_Y + wh - 0.9, PAD_Y + wh, wz - 0.6, wz + 0.6, 0x1d2a33);
      det.span(x, x + dir * 0.12, PAD_Y + wh - 0.96, PAD_Y + wh - 0.9, wz - 0.7, wz + 0.7, 0xe0dccf);
    }
    // ...and one thing at head height, so the bottom half of the wall is not bare block. Which
    // thing is rolled per bay, so a long wall is not the same bay repeated down its length.
    const az = Zf(bv0 + D * (0.35 + 0.3 * r()));
    const pick = r();
    if (pick < 0.4) {
      // a wall vent with its louvre
      det.span(x, x + dir * 0.16, PAD_Y + 2.1, PAD_Y + 2.8, az - 0.42, az + 0.42, 0x6f7479);
      for (let k = 0; k < 3; k++) det.span(x + dir * 0.17, x + dir * 0.19, PAD_Y + 2.25 + k * 0.18, PAD_Y + 2.31 + k * 0.18, az - 0.38, az + 0.38, 0x3b3f44);
    } else if (pick < 0.72) {
      // a condenser on brackets, with its line going into the wall
      det.box(x + dir * 0.38, PAD_Y + 2.35, az, 0.68, 0.62, 0.72, 0x9aa0a4);
      for (const sz of [-0.28, 0.28]) det.box(x + dir * 0.2, PAD_Y + 2.0, az + sz, 0.36, 0.05, 0.05, 0x55595e);
      det.cyl(x + dir * 0.1, PAD_Y + 2.6, az + 0.3, 0.035, 0.035, 0.5, 0x2e3237, 6, { rz: Math.PI / 2 });
    } else {
      // a standpipe and a stain where it has been running down the block for years
      det.cyl(x + dir * 0.08, PAD_Y, az, 0.04, 0.04, Math.min(l.h, 5) - 0.6, 0xa8adb2, 6);
      det.span(x, x + dir * 0.01, PAD_Y, PAD_Y + 1.6, az - 0.14, az + 0.14, 0x6b6f66);
    }
  }

  let n = 0;
  LOTS.forEach((l, i) => {
    // 0.1 is a light sun-bleach of the building's own paint, which is right for a shop whose
    // colour wraps the whole box. The club is the exception: its frontage is near-black purple
    // (LOOKS.club.wall), and a rear wall in permanent shade painted that colour is a void — the
    // first capture of this showed a back lane where only the extractor fans were visible at all.
    // Clubs do not paint the back anyway; it is bare block. So the club fades most of the way to
    // the block tone and reads as a wall.
    const tint = fadeColor(LOOKS[l.style].wall, l.style === 'club' ? 0.74 : 0.1);
    const top = PAD_Y + l.h;
    // rear
    if (!LOTS.some((o) => o !== l && o.v0 < l.v1 + 0.06 && o.v1 > l.v1 - 0.06 && o.v0 > l.v1 - 0.06 && o.u0 < l.u1 && o.u1 > l.u0)) {
      wall('z', Zf(l.v1) - 0.03, l.u0, l.u1, top, -1, tint); n++;
      if (l.style === 'club') clubRearDetails(l); else rearDetails(l, i);
    }
    // sides, where there is air beside them
    if (!LOTS.some((o) => touches(l, o, 'u0'))) { wall('x', l.u0 - 0.03, Zf(l.v1), Zf(l.v0), top, -1, tint); sideDetails(l, l.u0 - 0.03, -1, i); n++; }
    if (!LOTS.some((o) => touches(l, o, 'u1'))) { wall('x', l.u1 + 0.03, Zf(l.v1), Zf(l.v0), top, 1, tint); sideDetails(l, l.u1 + 0.03, 1, i); n++; }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, mat); mesh.name = 'wallDecals'; mesh.receiveShadow = true;
  near.add(mesh);
  const dg = det.build();
  const dm = new THREE.Mesh(dg, kit.solid); dm.name = 'wallDetails'; dm.castShadow = true; dm.receiveShadow = true;
  near.add(dm);
  void n;
  return { triangles: idx.length / 3 + det.triangleCount, dispose(): void { geo.dispose(); dg.dispose(); mat.dispose(); tile.dispose(); } };
}
