/**
 * The small things that make a street look used: litter, puddles, washing on a line, newspaper boxes,
 * a bike rack, a sandwich board that tells you what the special is.
 *
 * Positions all come from world/town-life.ts (tested: on the pad, clear of every building and prop,
 * clear of the lanes people walk). This file decides only what each looks like.
 *
 * ## Why these, and why so few
 * The brief for this pass was "a few well-observed details, not clutter", and every item below is
 * there because it tells you something: the litter is where litter actually collects (kerbs,
 * doorways, the lee of the dumpsters, under the smoker's step), the puddles are where water would
 * sit (not on a crown of road), the washing is strung across the one alley in town, and the
 * sandwich boards are lettered by someone who does not care about kerning. All of it is merged into
 * the town's existing `solid` batch (zero extra draw calls) except:
 *   - puddles:   ONE glossy translucent mesh for all of them (1 draw call),
 *   - boards:    one textured quad pair per sandwich board (3 draw calls, 3 small textures).
 * Everything is static, so nothing here costs anything per frame.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PAD_Y } from '@keysrun/shared/world/town';
import { LITTER, PUDDLES, WASHING, DECOR, type Litter, type Decor } from '@keysrun/shared/world/town-life';
import type { GeoBatch } from './batch.js';
import { Zf } from './props.js';

/** Surface the litter lies on: the ground decal (PAD_Y + 0.02) plus the paint's 1 cm. */
const S = PAD_Y + 0.035;

function litter(b: GeoBatch, l: Litter): void {
  const x = l.u, z = Zf(l.v);
  // a cylinder lying on its side: `cyl` stands on y0, so lift by r - h/2 and tip it over
  const lying = (r: number, h: number, c: number): void => { b.cyl(x, S + r - h / 2, z, r, r, h, c, 7, { rz: Math.PI / 2, ry: l.rot }); };
  switch (l.kind) {
    case 'cup': lying(0.04, 0.1, 0xf4f1e8); b.cyl(x + Math.cos(l.rot) * 0.02, S + 0.04 - 0.018, z - Math.sin(l.rot) * 0.02, 0.043, 0.043, 0.03, 0xd9342b, 7, { rz: Math.PI / 2, ry: l.rot }); break;
    case 'can': lying(0.033, 0.12, Math.floor(l.rot * 10) % 2 ? 0xc6ccd1 : 0x2f8f4a); break;
    case 'bottle': lying(0.03, 0.24, Math.floor(l.rot * 10) % 2 ? 0x2f6b3a : 0x6b4a2a); break;
    case 'paper': b.box(x, S + 0.003, z, 0.28, 0.005, 0.2, 0xe9e3d2, { ry: l.rot }); b.box(x + 0.05, S + 0.007, z - 0.03, 0.2, 0.004, 0.14, 0xdad2bd, { ry: l.rot + 0.5 }); break;
    case 'butts': for (let i = 0; i < 4; i++) b.box(x + Math.sin(i * 2.1) * 0.07, S + 0.008, z + Math.cos(i * 1.7) * 0.07, 0.016, 0.014, 0.055, i % 3 ? 0xd9c8a0 : 0xe9e4d8, { ry: l.rot + i }); break;
    case 'bag': b.ball(x, S + 0.025, z, 0.13, 0xf0efe8, 0.22, 6); b.box(x + 0.1, S + 0.015, z + 0.03, 0.12, 0.012, 0.06, 0xe4e2da, { ry: l.rot }); break;
    case 'box': b.box(x, S + 0.05, z, 0.5, 0.1, 0.38, 0xa57f52, { ry: l.rot }); b.box(x + 0.18, S + 0.12, z + 0.02, 0.3, 0.012, 0.3, 0xb48d5d, { ry: l.rot + 0.3, rz: 0.4 }); break;
    case 'wrapper': b.box(x, S + 0.003, z, 0.11, 0.004, 0.07, Math.floor(l.rot * 10) % 2 ? 0xd9342b : 0xf2c14e, { ry: l.rot }); break;
  }
}

function newsBox(b: GeoBatch, d: Decor, i: number): void {
  const x = d.u, z = Zf(d.v), c = i % 2 ? 0xb3202a : 0x2a5ea8;
  b.cyl(x, PAD_Y, z, 0.04, 0.05, 0.62, 0x3a3d42, 6);
  b.span(x - 0.23, x + 0.23, PAD_Y + 0.62, PAD_Y + 1.12, z - 0.2, z + 0.2, c);
  b.span(x - 0.18, x + 0.18, PAD_Y + 0.82, PAD_Y + 1.02, z + 0.2, z + 0.215, 0x1d2a33);
  b.span(x - 0.23, x + 0.23, PAD_Y + 1.12, PAD_Y + 1.15, z - 0.22, z + 0.22, 0xd0d4d8);
  b.span(x - 0.1, x + 0.1, PAD_Y + 0.7, PAD_Y + 0.74, z + 0.2, z + 0.22, 0xe9e3d2);
}

function bikeRack(b: GeoBatch, d: Decor): void {
  const x = d.u, z = Zf(d.v);
  for (const dx of [-0.55, 0, 0.55]) {
    b.cyl(x + dx - 0.12, PAD_Y, z, 0.018, 0.018, 0.78, 0x3a3d42, 6);
    b.cyl(x + dx + 0.12, PAD_Y, z, 0.018, 0.018, 0.78, 0x3a3d42, 6);
    b.box(x + dx, PAD_Y + 0.78, z, 0.26, 0.036, 0.036, 0x3a3d42);
    b.box(x + dx, PAD_Y + 0.01, z, 0.3, 0.012, 0.09, 0x2b2e32);
  }
}

function iceChest(b: GeoBatch, d: Decor): void {
  const x = d.u, z = Zf(d.v);
  b.span(x - 0.7, x + 0.7, PAD_Y, PAD_Y + 0.85, z - 0.25, z + 0.25, 0xe8edf1);
  b.span(x - 0.72, x + 0.72, PAD_Y + 0.85, PAD_Y + 0.9, z - 0.27, z + 0.27, 0x2b6cb0);
  b.span(x - 0.5, x - 0.2, PAD_Y + 0.5, PAD_Y + 0.7, z + 0.25, z + 0.26, 0xd9342b); // the "ICE" decal, near enough
}

function crateStack(b: GeoBatch, d: Decor): void {
  const x = d.u, z = Zf(d.v);
  const cols = [0x7a5a36, 0x8f6a3f, 0x6b4a2b];
  for (let i = 0; i < 3; i++) b.box(x + (i - 1) * 0.06, PAD_Y + 0.15 + i * 0.3, z, 0.55, 0.3, 0.4, cols[i], { ry: (i - 1) * 0.12 });
  b.box(x + 0.5, PAD_Y + 0.15, z + 0.05, 0.4, 0.3, 0.4, 0x2f6b8a, { ry: 0.3 });
}

/** A chalkboard sandwich board's face, lettered by someone in a hurry. */
function boardTexture(lines: readonly string[]): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 256; c.height = 384;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1f2b26'; g.fillRect(0, 0, 256, 384);
  // chalk ghosting of yesterday's special
  g.fillStyle = 'rgba(255,255,255,0.05)'; for (let i = 0; i < 5; i++) g.fillRect(14, 40 + i * 62, 220, 22);
  g.strokeStyle = '#f0eadb'; g.lineWidth = 4; g.strokeRect(10, 10, 236, 364);
  g.fillStyle = '#f0eadb'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const n = lines.length, step = 330 / n;
  lines.forEach((s, i) => {
    const size = i === 0 ? 44 : 36;
    g.font = `800 ${size}px "Big Shoulders Display", Impact, "Arial Narrow", sans-serif`;
    g.save(); g.translate(128, 40 + step * (i + 0.5)); g.rotate((((i * 37) % 7) - 3) * 0.012);
    g.fillText(s, 0, 0, 220);
    g.restore();
  });
  // a smudge where a sleeve has been
  const sm = g.createRadialGradient(190, 300, 4, 190, 300, 60); sm.addColorStop(0, 'rgba(255,255,255,0.1)'); sm.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sm; g.fillRect(100, 240, 156, 120);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export interface StreetLife { dispose(): void }

/** Adds everything to `solid` and `near`. Returns what must be disposed. */
export function buildStreetLife(solid: GeoBatch, near: THREE.Group): StreetLife {
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];

  for (const l of LITTER) litter(solid, l);

  DECOR.forEach((d, i) => {
    if (d.kind === 'news-box') newsBox(solid, d, i);
    else if (d.kind === 'bike-rack') bikeRack(solid, d);
    else if (d.kind === 'ice-chest') iceChest(solid, d);
    else if (d.kind === 'crate-stack') crateStack(solid, d);
    else if (d.kind === 'aframe' && d.text) {
      const x = d.u, z = Zf(d.v), tilt = 0.2;
      // two hinged panels meeting at the top (the hinge is at z), feet apart: wood, with a chalk face each way
      for (const s of [-1, 1]) solid.box(x, PAD_Y + 0.46, z + s * 0.1, 0.64, 0.96, 0.03, 0x7a5a36, { rx: -s * tilt });
      solid.box(x, PAD_Y + 0.94, z, 0.66, 0.03, 0.05, 0x5a3f25);
      const t = boardTexture(d.text); texs.push(t);
      const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.28, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      mats.push(m);
      // both faces in one geometry (one draw call a board): each plane tilted with its panel, so it leans back a little as a real one does
      const faces = [1, -1].map((s) => {
        const g = new THREE.PlaneGeometry(0.54, 0.8);
        if (s < 0) g.rotateY(Math.PI);
        g.rotateX(-s * tilt);
        g.translate(x, PAD_Y + 0.46, z + s * (0.1 + 0.019));
        return g;
      });
      const g = mergeGeometries(faces)!;
      faces.forEach((f) => f.dispose());
      geos.push(g);
      const mesh = new THREE.Mesh(g, m); mesh.name = `board-${d.id}`; mesh.receiveShadow = true;
      near.add(mesh);
    }
  });

  // washing, across the alley: a sagging line, wall brackets, and what is on it
  {
    const { u0, u1, v, y, sag } = WASHING;
    const z = Zf(v), Y = PAD_Y + y;
    const at = (f: number): [number, number] => [u0 + (u1 - u0) * f, Y - sag * 4 * f * (1 - f)];
    const N = 16;
    for (let i = 0; i < N; i++) {
      const [ax, ay] = at(i / N), [bx, by] = at((i + 1) / N);
      solid.box((ax + bx) / 2, (ay + by) / 2, z, Math.hypot(bx - ax, by - ay), 0.014, 0.014, 0xcfc9ba, { rz: Math.atan2(by - ay, bx - ax) });
    }
    for (const [bx, sx] of [[u0, 1], [u1, -1]] as const) { solid.box(bx + sx * 0.08, Y + 0.02, z, 0.16, 0.05, 0.05, 0x5a5d62); solid.box(bx + sx * 0.04, Y + 0.02, z, 0.04, 0.2, 0.1, 0x4a4d52); }
    // [position along the line, width, drop, colour, second colour (a stripe or a pair of sleeves)]
    const clothes: Array<[number, number, number, number, number]> = [
      [0.1, 0.9, 0.7, 0xf2efe6, 0xf2efe6],    // a sheet
      [0.22, 0.46, 0.62, 0x3fa6b9, 0x3fa6b9], // t-shirt
      [0.3, 0.34, 0.32, 0x5a7bd6, 0x5a7bd6],  // shorts
      [0.37, 0.5, 0.9, 0xf08a7c, 0xf2efe6],   // a striped towel
      [0.48, 0.2, 0.12, 0xe86aa8, 0xe86aa8],  // the bikini, in two pieces
      [0.54, 0.46, 0.6, 0xf2c14e, 0xf2c14e],
      [0.66, 0.46, 0.64, 0xf2efe6, 0xd9342b],
      [0.76, 0.5, 0.95, 0x6fb7d9, 0xf2efe6],
      [0.88, 0.34, 0.34, 0x4d5a4a, 0x4d5a4a],
    ];
    clothes.forEach(([f, w, drop, c1, c2], i) => {
      const [cx, cy] = at(f), sway = ((i * 53) % 7 - 3) * 0.045;
      solid.box(cx, cy - drop / 2 - 0.02, z, w, drop, 0.018, c1, { ry: sway });
      if (c2 !== c1) solid.box(cx, cy - drop * 0.3 - 0.02, z + 0.012, w * 1.01, drop * 0.18, 0.012, c2, { ry: sway });
      if (drop > 0.55 && w < 0.6) for (const sx of [-1, 1]) solid.box(cx + sx * (w / 2 + 0.1), cy - 0.14, z, 0.2, 0.1, 0.016, c1, { rz: sx * 0.5, ry: sway });
      solid.box(cx, cy - 0.005, z + 0.012, 0.03, 0.045, 0.02, 0xe9e3d2); // the peg
    });
    // a plastic basket on the ground below it, because somebody is coming back for it
    solid.span(u0 + 5.4, u0 + 6.2, PAD_Y + 0.03, PAD_Y + 0.31, z - 0.28, z + 0.28, 0x6fb7d9);
  }

  // puddles: ONE glossy mesh. A darker wet rim and a paler centre that picks up the sky.
  {
    const pos: number[] = [], col: number[] = [], idx: number[] = [], nor: number[] = [];
    const c1 = new THREE.Color(0x2a3a45), c2 = new THREE.Color(0x587588);
    const SEG = 16;
    PUDDLES.forEach((p) => {
      for (const [k, c, dy] of [[1.12, c1, 0.036], [0.88, c2, 0.039]] as const) {
        const base = pos.length / 3;
        pos.push(p.u, PAD_Y + dy, -p.v); col.push(c.r, c.g, c.b); nor.push(0, 1, 0);
        for (let i = 0; i < SEG; i++) {
          const a = (i / SEG) * Math.PI * 2, wob = 1 + Math.sin(a * 3 + p.u) * 0.12;
          const lx = Math.cos(a) * p.rx * k * wob, lz = Math.sin(a) * p.rz * k * wob;
          pos.push(p.u + lx * Math.cos(p.rot) - lz * Math.sin(p.rot), PAD_Y + dy, -(p.v + lx * Math.sin(p.rot) + lz * Math.cos(p.rot)));
          col.push(c.r, c.g, c.b); nor.push(0, 1, 0);
        }
        for (let i = 0; i < SEG; i++) idx.push(base, base + 1 + ((i + 1) % SEG), base + 1 + i);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    geos.push(g);
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.04, metalness: 0.15, transparent: true, opacity: 0.62, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
    mats.push(m);
    const mesh = new THREE.Mesh(g, m); mesh.name = 'puddles'; mesh.renderOrder = 4; mesh.receiveShadow = false;
    near.add(mesh);
  }

  return { dispose(): void { geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); texs.forEach((t) => t.dispose()); } };
}
