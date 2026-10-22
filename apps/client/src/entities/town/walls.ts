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
 * The Pink Flamingo Cabaret is skipped entirely (its lot is being redesigned), and so is any side that touches
 * another building: those are not visible and would just be two decals fighting over a plane.
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
  function rearDetails(l: Lot, i: number): void {
    const r = lcg(l.u0 * 3.1 + l.v1), W = l.u1 - l.u0;
    const z = Zf(l.v1);                       // the wall face; things stand off it toward -z (inland, +v)
    const off = (d: number): number => z - d;
    const doorU = l.u0 + W * (0.22 + 0.5 * r());
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
    const acU = l.u0 + W * (0.62 + 0.28 * r());
    det.span(acU - 0.5, acU + 0.5, sill + 0.05, sill + 0.17, off(0.7), off(0.0), 0x9a968a);
    det.span(acU - 0.48, acU + 0.48, sill + 0.17, sill + 0.85, off(0.64), off(0.02), 0xcfd3d6);
    det.cyl(acU, sill + 0.86, off(0.34), 0.28, 0.28, 0.03, 0x2a2d30, 10);
    det.cyl(acU + 0.3, sill + 0.4, off(0.02), 0.025, 0.025, 2.2, 0xb87333, 6);
    // downpipes at both corners and a gas meter
    for (const dx of [l.u0 + 0.35, l.u1 - 0.35]) det.cyl(dx, sill, off(0.05), 0.045, 0.045, Math.min(l.h, 5) - 0.3, 0xb9bec2, 6);
    det.span(doorU - 2.4, doorU - 1.8, sill + 0.7, sill + 1.2, off(0.25), off(0.0), 0xc9a24a);
    // a high barred window and an extractor vent: back-of-house
    const wU = l.u0 + W * (0.12 + 0.2 * r());
    det.span(wU - 0.5, wU + 0.5, sill + 2.4, sill + 3.1, off(0.05), off(0.0), 0x1d2a33);
    for (let b = -0.4; b <= 0.4; b += 0.2) det.box(wU + b, sill + 2.75, off(0.07), 0.025, 0.7, 0.025, 0x23262a);
    det.span(wU - 0.55, wU + 0.55, sill + 2.36, sill + 2.4, off(0.1), off(0.0), 0xd8d4c8);
    if (l.h > 4.3) { det.cyl(l.u0 + W * 0.45, sill + 3.2, off(0.18), 0.22, 0.22, 0.3, 0x9a9fa4, 8, { rx: Math.PI / 2 }); }
    void i;
  }

  function sideDetails(l: Lot, x: number, dir: 1 | -1, i: number): void {
    const r = lcg(l.u0 * 1.3 + l.v0 * 0.7 + i), D = l.v1 - l.v0;
    // windows are only on the upper part of a side wall: two, set back in the middle and toward the front, with sills and a drip stain
    const wh = Math.min(l.h - 1.2, 3.4);
    for (const f of [0.28, 0.7]) {
      const wz = Zf(l.v0 + D * (f + (r() - 0.5) * 0.06));
      det.span(x + dir * 0.0, x + dir * 0.06, PAD_Y + wh - 0.9, PAD_Y + wh, wz - 0.6, wz + 0.6, 0x1d2a33);
      det.span(x, x + dir * 0.12, PAD_Y + wh - 0.96, PAD_Y + wh - 0.9, wz - 0.7, wz + 0.7, 0xe0dccf);
    }
    det.cyl(x + dir * 0.05, PAD_Y, Zf(l.v1) + 0.2, 0.045, 0.045, Math.min(l.h, 5) - 0.3, 0xb9bec2, 6);
    // a meter box and a conduit run, because every wall has a conduit run
    const mz = Zf(l.v0 + D * 0.5);
    det.span(x, x + dir * 0.18, PAD_Y + 1.1, PAD_Y + 1.7, mz - 0.3, mz + 0.3, 0x8d8f91);
    det.box(x + dir * 0.03, PAD_Y + 1.4 + (l.h - 1.4) / 2 - 0.6, mz, 0.04, l.h - 1.8, 0.04, 0x4a4d52);
  }

  let n = 0;
  LOTS.forEach((l, i) => {
    if (l.style === 'club') return;
    const tint = fadeColor(LOOKS[l.style].wall, 0.1);
    const top = PAD_Y + l.h;
    // rear
    if (!LOTS.some((o) => o !== l && o.v0 < l.v1 + 0.06 && o.v1 > l.v1 - 0.06 && o.v0 > l.v1 - 0.06 && o.u0 < l.u1 && o.u1 > l.u0)) {
      wall('z', Zf(l.v1) - 0.03, l.u0, l.u1, top, -1, tint); n++;
      rearDetails(l, i);
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
