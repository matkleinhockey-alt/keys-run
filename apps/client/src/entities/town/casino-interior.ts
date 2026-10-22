/**
 * The inside of the Gaff & Gill Casino: carpet, neon, thirty slot cabinets, a change booth, a Go
 * Fish table, a marlin fountain, and the people who work there.
 *
 * ## The lighting budget (the point of this file)
 * A casino is the room that wants twenty lights. It gets none. three.js compiles the PointLight
 * count into EVERY lit material (that is why entities/town/lights.ts caps the whole town at four),
 * so a real light per cabinet would recompile the sea, the sky and every fish each time the player
 * stepped through the door. Everything that glows here is instead one of:
 *   - an UNLIT vertex-coloured batch (`neon`, `flashA`, `flashB`): tubes, bulbs, screen frames,
 *     always full bright whatever the time of day, because there is no sun in a windowless room;
 *   - an ADDITIVE halo/pool batch (`glow`) of soft quads in the same colours, which is what makes a
 *     lit sign look like it is lighting the carpet in front of it;
 *   - a few animated emissive materials: four slot-screen textures that scroll (so 30 screens show
 *     four different "attract" spins for four draw calls), and two bulb batches that swap at 3 Hz.
 * The five real LightSources it registers (`lights`) are the usual interior lamps: the town's pool
 * of four PointLights picks the nearest four when the player is in the room, same as the bar.
 *
 * ## Draw calls (measured in apps/client/test/capture-town.mjs, reported with the commit)
 * solid + neon + glow + flashA + flashB + 4 screens + signs + floor + ceiling + fountain water = 13,
 * plus three for the aquarium wall's fish, their tails and its glass (casino-aquarium.ts — the tank
 * itself is in the batches above and so is free), plus one mesh per person (a person is 15-20
 * meshes; the crowd is therefore built only when the camera first comes near, and hidden unless the
 * camera is inside the building or at its door).
 *
 * ## Why the people are not in world/town.ts's `NPCS`
 * `NPCS` is the street's cast and `people.ts` (another agent's file) turns each `NpcLook` into a
 * figure. The casino's cast lives in world/casino.ts with its own looks, and casino-people.ts builds
 * them, so neither file had to change for this one to exist.
 */
import * as THREE from 'three';
import { PAD_Y, WALL_T, DOOR_W, type Lot } from '@keysrun/shared/world/town';
import { CABINETS, CASINO_BOXES, CASINO_NPCS, type Cabinet } from '@keysrun/shared/world/casino';
import { GeoBatch } from './batch.js';
import type { TownKit } from './kit.js';
import { Zf } from './props.js';
import type { LightSource } from './build.js';
import type { Interior } from './interiors.js';
import { makeCasinoPerson, type CasinoPerson } from './casino-people.js';
import { buildAquarium } from './casino-aquarium.js';
import { paintSymbol } from '../../game/casino/art.js';

const GOLD = 0xe0b34a, CYAN = 0x35e0ff, PINK = 0xff3fa4, LIME = 0x7dff8a, AMBER = 0xffb23f, VIOLET = 0x8a3cff;
const THEME_COLORS = [CYAN, PINK, AMBER, LIME, VIOLET, 0xff5a4a, 0x46d9ff, 0xffd23f];
const box = (id: string): { u0: number; u1: number; v0: number; v1: number } => CASINO_BOXES.find((b) => b.id === id)!;

// ---------------------------------------------------------------------------------------------
// Canvas art: the carpet, the sign atlas, the reel-screen texture
// ---------------------------------------------------------------------------------------------

function carpetTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b4a58'; g.fillRect(0, 0, 256, 256);
  // gold diamond lattice
  g.strokeStyle = 'rgba(224,179,74,0.55)'; g.lineWidth = 2;
  for (let i = -256; i <= 512; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 256, 256); g.moveTo(i, 256); g.lineTo(i + 256, 0); g.stroke(); }
  // a tiny fish in the middle of every diamond, as every casino carpet has a tiny something
  for (const [x, y] of [[64, 0], [192, 0], [0, 64], [128, 64], [64, 128], [192, 128], [0, 192], [128, 192], [256, 64], [256, 192]] as const) {
    g.save(); g.translate(x, y + 32); g.fillStyle = 'rgba(53,224,255,0.45)';
    g.beginPath(); g.ellipse(0, 0, 14, 6, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(-12, 0); g.lineTo(-22, -7); g.lineTo(-22, 7); g.closePath(); g.fill();
    g.restore();
  }
  g.fillStyle = 'rgba(0,0,0,0.18)';
  for (let i = 0; i < 400; i++) g.fillRect((i * 97) % 256, (i * 57) % 256, 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Where each sign lives in the atlas (pixels), and how big it is on the wall (metres). */
const ATLAS = { w: 2048, h: 1024 };
const REGION = {
  back: { x: 0, y: 0, w: 2048, h: 390 },
  side: { x: 0, y: 400, w: 1024, h: 200 },
  change: { x: 1024, y: 400, w: 512, h: 200 },
  fish: { x: 1536, y: 400, w: 512, h: 200 },
  house: { x: 0, y: 610, w: 1024, h: 240 },
  poster: { x: 1024, y: 610, w: 512, h: 240 },
} as const;
type RegionName = keyof typeof REGION;

function neon(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, size: number, color: string): void {
  g.save();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `800 ${size}px "Big Shoulders Display", Impact, "Arial Narrow", sans-serif`;
  const w = g.measureText(text).width;
  if (w > maxW) g.font = `800 ${Math.floor(size * (maxW / w))}px "Big Shoulders Display", Impact, "Arial Narrow", sans-serif`;
  g.shadowColor = color; g.shadowBlur = size * 0.45; g.fillStyle = color; g.fillText(text, x, y);
  g.shadowBlur = 0; g.globalAlpha = 0.85; g.fillStyle = '#ffffff'; g.fillText(text, x, y);
  g.restore();
}

function glowFish(g: CanvasRenderingContext2D, sym: 'marlin' | 'tarpon' | 'bonefish' | 'permit', x: number, y: number, s: number, color: string, flip = false): void {
  g.save();
  g.translate(x, y); g.scale(flip ? -s : s, s);
  g.shadowColor = color; g.shadowBlur = 22;
  paintSymbol(g, sym, 1);
  g.restore();
}

function signAtlas(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = ATLAS.w; c.height = ATLAS.h;
  const g = c.getContext('2d')!;
  const panel = (r: { x: number; y: number; w: number; h: number }, fill: string, rim: string): void => {
    g.fillStyle = fill; g.fillRect(r.x, r.y, r.w, r.h);
    g.strokeStyle = rim; g.lineWidth = 8; g.strokeRect(r.x + 8, r.y + 8, r.w - 16, r.h - 16);
  };
  // back wall: the big one
  let r: { x: number; y: number; w: number; h: number } = REGION.back; panel(r, '#07202b', '#e0b34a');
  glowFish(g, 'marlin', r.x + 250, r.y + 205, 3.0, '#35e0ff');
  glowFish(g, 'marlin', r.x + r.w - 250, r.y + 205, 3.0, '#35e0ff', true);
  neon(g, 'MARLIN MILLIONS', r.x + r.w / 2, r.y + 130, 1050, 150, '#ffd96a');
  neon(g, 'TOP PRIZE  200x  YOUR BET', r.x + r.w / 2, r.y + 255, 900, 78, '#35e0ff');
  neon(g, 'ODDS POSTED ON EVERY MACHINE · PLEASE READ THEM', r.x + r.w / 2, r.y + 340, 1100, 40, '#ffffff');
  // side murals: a school of tarpon going somewhere with purpose
  r = REGION.side; panel(r, '#071a24', '#35e0ff');
  for (let i = 0; i < 6; i++) glowFish(g, i % 3 === 0 ? 'bonefish' : 'tarpon', r.x + 110 + i * 160, r.y + 100 + ((i * 37) % 40) - 20, 1.05, i % 2 ? '#ff3fa4' : '#35e0ff');
  // the change booth
  r = REGION.change; panel(r, '#07202b', '#ffd23f');
  neon(g, 'CHANGE', r.x + r.w / 2, r.y + 96, 420, 120, '#ffd96a');
  neon(g, 'NOTES · COINS · BAIT (NO BAIT)', r.x + r.w / 2, r.y + 165, 440, 30, '#ffffff');
  // go fish
  r = REGION.fish; panel(r, '#07202b', '#ff3fa4');
  neon(g, 'GO FISH', r.x + r.w / 2, r.y + 90, 420, 112, '#ff7ac0');
  neon(g, 'NO WAGERS · NO DEAL · NO MERCY', r.x + r.w / 2, r.y + 163, 440, 30, '#ffffff');
  // over the door, on the inside
  r = REGION.house; panel(r, '#07202b', '#e0b34a');
  neon(g, 'THE HOUSE ALWAYS WINS.', r.x + r.w / 2, r.y + 90, 940, 92, '#ffd96a');
  neon(g, 'THE HOUSE IS A FISH.', r.x + r.w / 2, r.y + 175, 760, 70, '#35e0ff');
  // the responsible-play poster
  r = REGION.poster; panel(r, '#0a2e3a', '#7dff8a');
  neon(g, 'SET A LIMIT.', r.x + r.w / 2, r.y + 78, 420, 66, '#7dff8a');
  neon(g, 'THE FISH PAY BETTER.', r.x + r.w / 2, r.y + 150, 440, 48, '#ffffff');
  neon(g, 'PIT BOSS CHUM IS WATCHING', r.x + r.w / 2, r.y + 205, 440, 26, '#ffd96a');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Eight symbols stacked in three columns: what the cabinets' screens scroll through while nobody is playing. */
function reelScreenTexture(): THREE.CanvasTexture {
  const cw = 64, ch = 64, rows = 8;
  const c = document.createElement('canvas'); c.width = cw * 3; c.height = ch * rows;
  const g = c.getContext('2d')!;
  const order = ['marlin', 'shrimp', 'tarpon', 'boot', 'permit', 'shrimp', 'bonefish', 'tarpon'] as const;
  for (let col = 0; col < 3; col++) for (let r = 0; r < rows; r++) {
    g.fillStyle = (col + r) % 2 ? '#f6f2e4' : '#efe9d6'; g.fillRect(col * cw, r * ch, cw, ch);
    g.save(); g.translate(col * cw + cw / 2, r * ch + ch / 2); g.scale(0.5, 0.5);
    paintSymbol(g, order[(r + col * 3) % order.length], 1);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------------------------
// A tiny textured-quad collector (one BufferGeometry per texture; no per-sign draw call)
// ---------------------------------------------------------------------------------------------

class Quads {
  private pos: number[] = []; private uv: number[] = []; private idx: number[] = [];
  /** A vertical sign centred at (cx, cy, cz), `w` x `h` metres, facing along `fx`/`fz` (unit vector in the xz plane). */
  sign(region: RegionName, cx: number, cy: number, cz: number, w: number, h: number, fx: number, fz: number, flip = false): void {
    const r = REGION[region], base = this.pos.length / 3;
    const rx = fz, rz = -fx; // the viewer's right-hand direction on a sign facing (fx, fz)
    const u0 = r.x / ATLAS.w, u1 = (r.x + r.w) / ATLAS.w, v1 = 1 - r.y / ATLAS.h, v0 = 1 - (r.y + r.h) / ATLAS.h;
    for (const [s, t, u, v] of [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]] as const) {
      this.pos.push(cx + rx * (w / 2) * s, cy + (h / 2) * t, cz + rz * (w / 2) * s);
      this.uv.push(flip ? (u === u0 ? u1 : u0) : u, v);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------------------------

export function buildCasinoInterior(lot: Lot, kit: TownKit): Interior {
  const group = new THREE.Group();
  group.name = 'interior-casino';
  const solid = new GeoBatch(false, 2.0), neonB = new GeoBatch(false, 1), flashA = new GeoBatch(false, 1), flashB = new GeoBatch(false, 1), glow = new GeoBatch(true);
  const lights: LightSource[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const y0 = PAD_Y + 0.04, H = lot.h, ceilY = PAD_Y + H - 0.1;
  const x0 = lot.u0 + WALL_T, x1 = lot.u1 - WALL_T, v0 = lot.v0 + WALL_T, v1 = lot.v1 - WALL_T;
  const cx = (x0 + x1) / 2;
  const own = <T extends THREE.Material>(m: T): T => { mats.push(m); return m; };

  // ---- floor: carpet, with a gold-bordered runner from the door to the fountain
  {
    const w = x1 - x0, d = v1 - v0;
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 4), uv.getY(i) * (d / 4));
    const tex = carpetTexture();
    const mat = own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const m = new THREE.Mesh(g, mat); m.position.set(cx, y0, Zf((v0 + v1) / 2)); group.add(m);
    geos.push(g); texs.push(tex);
  }
  // raised 2-4 cm: at 0-1 cm it z-fought the carpet plane's polygon offset (noisy edge in the first capture)
  solid.span(-1.5, 1.5, y0 + 0.02, y0 + 0.034, Zf(160.6), Zf(lot.v0), 0xe0b34a);
  solid.span(-1.2, 1.2, y0 + 0.034, y0 + 0.048, Zf(160.6), Zf(lot.v0), 0x9b1b30);

  // ---- walls (skins over the exterior boxes), gold dado, neon cove at the top
  const wall = 0x0a2c38, sk = 0.03, top = PAD_Y + H - 0.1;
  solid.span(x0, x1, y0, top, Zf(v1) + sk, Zf(v1) + sk * 2, wall);
  solid.span(x0, x0 + sk, y0, top, Zf(v1), Zf(v0), wall);
  solid.span(x1 - sk, x1, y0, top, Zf(v1), Zf(v0), wall);
  const dl = lot.door - DOOR_W / 2, dr = lot.door + DOOR_W / 2;
  solid.span(x0, dl, y0, top, Zf(v0) - sk * 2, Zf(v0) - sk, wall);
  solid.span(dr, x1, y0, top, Zf(v0) - sk * 2, Zf(v0) - sk, wall);
  solid.span(dl, dr, PAD_Y + 2.5, top, Zf(v0) - sk * 2, Zf(v0) - sk, wall); // above the doorway
  for (const [a, b, za, zb] of [[x0 + sk, x1 - sk, Zf(v1) + 0.04, Zf(v1) + 0.06], [x0 + sk, x0 + sk * 2, Zf(v1), Zf(v0)], [x1 - sk * 2, x1 - sk, Zf(v1), Zf(v0)]] as const) {
    solid.span(a, b, y0, y0 + 1.0, za, zb, 0x0f5a6a);
    solid.span(a, b, y0 + 1.0, y0 + 1.08, za, zb, GOLD);
  }
  // neon cove: a tube along the top of the walls, pink on the back, cyan along the sides, with halos every 4 m
  neonB.span(x0 + 0.05, x1 - 0.05, top - 0.5, top - 0.42, Zf(v1) + 0.07, Zf(v1) + 0.09, PINK);
  neonB.span(x0 + 0.05, x0 + 0.08, top - 0.5, top - 0.42, Zf(v1), Zf(v0), CYAN);
  neonB.span(x1 - 0.08, x1 - 0.05, top - 0.5, top - 0.42, Zf(v1), Zf(v0), CYAN);
  for (let u = x0 + 2; u < x1; u += 4) glow.halo(u, top - 0.46, Zf(v1) + 0.3, 1.8, PINK);
  for (let v = v0 + 2; v < v1; v += 4) { glow.halo(x0 + 0.3, top - 0.46, Zf(v), 1.8, CYAN); glow.halo(x1 - 0.3, top - 0.46, Zf(v), 1.8, CYAN); }

  // ---- ceiling: unlit dark navy (a lit ceiling banded, see interiors.ts), with rows of light bars
  {
    const g = new THREE.PlaneGeometry(x1 - x0, v1 - v0).rotateX(Math.PI / 2);
    const mat = own(new THREE.MeshBasicMaterial({ color: 0x0d2635 }));
    const m = new THREE.Mesh(g, mat); m.position.set(cx, ceilY, Zf((v0 + v1) / 2)); group.add(m);
    geos.push(g);
  }
  for (const v of [143, 149.5, 156, 162.5]) {
    // (a soft pool under each bar read as a cream swirl on the ceiling in the first capture: the bars alone, and a floor pool far below, do the job)
    for (let u = -18; u <= 18; u += 9) { neonB.span(u - 1.6, u + 1.6, ceilY - 0.04, ceilY - 0.01, Zf(v) - 0.12, Zf(v) + 0.12, 0xfff3d0); glow.pool(u, y0 + 0.04, Zf(v), 4.5, 0x9ad8ff); }
  }

  // ---- cabinets
  const screensByPhase: Array<number[]> = [[], [], [], []];
  const flashPhase = (i: number): GeoBatch => (i % 2 ? flashA : flashB);
  CABINETS.forEach((c, ci) => cabinet(c, ci));
  function cabinet(c: Cabinet, ci: number): void {
    const wu = -c.fv, wv = c.fu; // width axis in (u, v)
    const P = (a: number, b: number): [number, number] => [c.u + wu * a + c.fu * b, -(c.v + wv * a + c.fv * b)];
    const along = Math.abs(c.fu) > 0.5; // faces +-u: width runs along z
    const cb = (b: GeoBatch, a: number, d: number, ya: number, yb: number, wA: number, dB: number, color: number): void => {
      const [x, z] = P(a, d);
      b.box(x, (ya + yb) / 2, z, along ? dB : wA, yb - ya, along ? wA : dB, color);
    };
    const col = THEME_COLORS[c.theme % THEME_COLORS.length];
    const Y = y0;
    cb(solid, 0, 0, Y, Y + 1.0, 1.8, 1.4, 0x12394a);                       // cabinet body
    cb(solid, 0, 0.45, Y + 1.0, Y + 1.12, 1.7, 0.62, 0x1b2630);          // button deck
    cb(solid, 0, 0.18, Y + 1.12, Y + 2.2, 1.7, 0.92, 0x0f2e3c);          // screen housing
    cb(solid, 0, 0.0, Y + 2.2, Y + 2.78, 1.8, 1.1, 0x12394a);             // topper
    // side panels in the body colour (the first capture had a 3 m wall of gold on the end of every island); gold only as a front edge
    for (const s of [-1, 1]) { cb(solid, s * 0.9, 0, Y, Y + 2.78, 0.04, 1.4, 0x0e6d78); cb(solid, s * 0.9, 0.7, Y, Y + 2.78, 0.06, 0.06, GOLD); }
    cb(neonB, 0, 0.71, Y + 0.34, Y + 0.6, 1.5, 0.02, col);               // front strip
    cb(neonB, 0, 0.56, Y + 2.3, Y + 2.68, 1.5, 0.02, col);               // marquee panel
    cb(solid, 0, 0.7, Y + 0.5, Y + 0.56, 0.7, 0.2, 0x8a9096);            // coin tray
    // five buttons and a lever
    for (let k = 0; k < 5; k++) { const [x, z] = P(-0.56 + k * 0.28, 0.5); neonB.ball(x, Y + 1.17, z, 0.05, [0xff5a4a, 0xffd23f, 0x7dff8a, 0x46d9ff, 0xff3fa4][k], 0.6, 6); }
    { const [x, z] = P(0.98, 0.3); solid.cyl(x, Y + 0.95, z, 0.025, 0.025, 0.55, 0x9aa0a6, 5); neonB.ball(x, Y + 1.52, z, 0.07, 0xff3b30, 1, 6); }
    // topper bulbs, two alternating phases
    for (let k = 0; k < 3; k++) { const [x, z] = P(-0.55 + k * 0.55, 0.3); flashPhase(ci + k).ball(x, Y + 2.86, z, 0.06, 0xfff3b0, 1, 5); }
    // the screen: recorded as a quad on the front of the housing, grouped into four scroll phases
    screensByPhase[ci % 4].push(ci);
    // light on the carpet and a halo on the topper
    const [hx, hz] = P(0, 0.4);
    glow.halo(hx, Y + 2.45, hz, 0.65, col);
    const [px, pz] = P(0, 1.5);
    glow.pool(px, Y + 0.05, pz, 1.4, col);
  }
  // screens (one merged geometry per phase, each with its own scrolling texture)
  const reelTex = reelScreenTexture(); texs.push(reelTex);
  const screenTex: THREE.Texture[] = [];
  const screenMeshes: THREE.Mesh[] = [];
  screensByPhase.forEach((list) => {
    if (!list.length) return;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (const ci of list) {
      const c = CABINETS[ci], wu = -c.fv, wv = c.fu;
      const P = (a: number, b: number, y: number): [number, number, number] => [c.u + wu * a + c.fu * b, y, -(c.v + wv * a + c.fv * b)];
      const base = pos.length / 3;
      for (const [a, y, u, v] of [[-0.68, 1.3, 0, 0], [0.68, 1.3, 1, 0], [0.68, 2.1, 1, 1], [-0.68, 2.1, 0, 1]] as const) {
        const [x, yy, z] = P(a, 0.645, y0 + y);
        pos.push(x, yy, z); uv.push(u, v);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3); // double-sided material: winding does not matter
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    g.computeBoundingSphere(); geos.push(g);
    const tex = reelTex.clone(); tex.needsUpdate = true; tex.repeat.set(1, 3 / 8); screenTex.push(tex); texs.push(tex);
    const mat = own(new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    const m = new THREE.Mesh(g, mat); group.add(m); screenMeshes.push(m);
  });

  // ---- the change booth
  {
    const b = box('casino-cage');
    solid.span(b.u0, b.u1, y0, y0 + 1.12, Zf(b.v1), Zf(b.v0), 0x13404f);
    solid.span(b.u0 - 0.08, b.u1 + 0.02, y0 + 1.12, y0 + 1.2, Zf(b.v1 + 0.1), Zf(b.v0 - 0.1), GOLD);
    solid.span(b.u0 - 0.02, b.u0 + 0.02, y0 + 0.2, y0 + 0.8, Zf(b.v1 - 0.4), Zf(b.v0 + 0.4), 0x0e6d78);
    // brass grille above the counter: bars every 14 cm, a rail top and bottom
    for (let v = b.v0 + 0.1; v < b.v1; v += 0.14) solid.cyl(b.u0 + 0.12, y0 + 1.2, Zf(v), 0.012, 0.012, 1.5, GOLD, 4);
    solid.span(b.u0 + 0.08, b.u0 + 0.16, y0 + 2.7, y0 + 2.8, Zf(b.v1), Zf(b.v0), GOLD);
    solid.span(b.u0 + 0.08, b.u1, y0 + 2.8, y0 + 3.0, Zf(b.v1), Zf(b.v0), 0x13404f);
    // behind it: a bank of cash drawers and a stack of ones
    solid.span(b.u1 - 0.1, b.u1, y0 + 1.2, y0 + 2.6, Zf(b.v1), Zf(b.v0), 0x0a2c38);
    for (const v of [144.2, 145.6, 147.6, 149.0]) { solid.span(b.u0 + 0.3, b.u0 + 0.7, y0 + 1.2, y0 + 1.34, Zf(v) - 0.3, Zf(v) + 0.3, 0x3fa05a); solid.ball(b.u0 + 0.5, y0 + 1.4, Zf(v + 0.4), 0.05, GOLD, 1, 5); }
    glow.halo(b.u0 + 0.3, y0 + 2.2, Zf(147), 2.0, GOLD);
    glow.pool(b.u0 - 1.2, y0 + 0.06, Zf(147), 2.8, GOLD);
  }

  // ---- the Go Fish table
  {
    const b = box('casino-table');
    solid.span(b.u0 + 0.5, b.u1 - 0.5, y0, y0 + 0.78, Zf(b.v1 - 0.5), Zf(b.v0 + 0.5), 0x2a1a10);
    solid.span(b.u0, b.u1, y0 + 0.78, y0 + 0.9, Zf(b.v1), Zf(b.v0), 0x5a3a20);
    solid.span(b.u0 + 0.12, b.u1 - 0.12, y0 + 0.9, y0 + 0.93, Zf(b.v1 - 0.12), Zf(b.v0 + 0.12), 0x0e7a6a);
    solid.span(b.u0 + 0.06, b.u1 - 0.06, y0 + 0.9, y0 + 0.935, Zf(b.v0 + 0.1), Zf(b.v0 + 0.14), GOLD);
    for (let k = 0; k < 7; k++) solid.box(b.u0 + 1.2 + k * 0.5, y0 + 0.95, Zf(b.v1 - 1.3 + (k % 2) * 0.1), 0.18, 0.012, 0.26, 0xf7f4ec, { ry: -0.3 + k * 0.1 });
    for (let k = 0; k < 4; k++) solid.cyl(b.u1 - 1.0, y0 + 0.93 + k * 0.03, Zf(b.v0 + 1.1), 0.1, 0.1, 0.028, [0xc4262e, 0x1f6fb0, 0xffd23f, 0x2f8f5a][k], 10);
    solid.ball((b.u0 + b.u1) / 2, y0 + 1.1, Zf((b.v0 + b.v1) / 2), 0.17, 0xbfe9ff, 1, 8);  // the fishbowl
    solid.ball((b.u0 + b.u1) / 2, y0 + 1.08, Zf((b.v0 + b.v1) / 2), 0.055, 0xff7a2a, 0.7, 6); // the fish in it
    glow.pool((b.u0 + b.u1) / 2, y0 + 0.97, Zf((b.v0 + b.v1) / 2), 4, 0x35e0ff);
  }

  // ---- the marlin fountain
  const waterG = new THREE.CircleGeometry(2.05, 28).rotateX(-Math.PI / 2);
  geos.push(waterG);
  {
    const b = box('casino-fountain'), fx = (b.u0 + b.u1) / 2, fz = Zf((b.v0 + b.v1) / 2);
    solid.cyl(fx, y0, fz, 2.4, 2.45, 0.62, 0x13404f, 28);
    solid.cyl(fx, y0 + 0.62, fz, 2.45, 2.45, 0.08, GOLD, 28);
    const wm = own(new THREE.MeshBasicMaterial({ color: 0x1a7fb0 }));
    const w = new THREE.Mesh(waterG, wm); w.position.set(fx, y0 + 0.6, fz); group.add(w);
    solid.cyl(fx, y0 + 0.6, fz, 0.5, 0.7, 0.5, 0x2a3a46, 12);
    // the marlin: a leap of tapering balls out of the water, bill up, tail down
    // Colours are bright on purpose: this room has no sun, the lift is only 2x, and the first capture's navy balls read as a skewer.
    const body: Array<[number, number, number]> = [[-1.0, 1.2, 0.3], [-0.66, 1.62, 0.37], [-0.3, 2.04, 0.41], [0.1, 2.46, 0.42], [0.5, 2.84, 0.38], [0.88, 3.16, 0.31], [1.2, 3.4, 0.22]];
    body.forEach(([dx, dy, r], i) => { solid.ball(fx + dx, y0 + dy, fz, r, i % 2 ? 0x5ab4ff : 0x3d9bec, 1, 12); solid.ball(fx + dx + 0.05, y0 + dy - r * 0.45, fz + r * 0.35, r * 0.62, 0xeaf6ff, 0.8, 8); });
    solid.cyl(fx + 1.75, y0 + 3.62, fz, 0.004, 0.09, 1.15, 0x9fd6ff, 8, { rz: -1.1 });
    solid.box(fx + 0.25, y0 + 3.15, fz, 0.05, 0.8, 0.7, 0x3a78e0, { rz: 0.4 });
    solid.box(fx - 1.3, y0 + 0.95, fz, 0.05, 0.6, 0.45, 0x3d9bec, { rz: 0.5 });
    solid.box(fx - 1.2, y0 + 0.62, fz, 0.05, 0.6, 0.4, 0x3d9bec, { rz: -0.4 });
    solid.ball(fx + 1.05, y0 + 3.3, fz + 0.2, 0.07, 0xffffff, 1, 6);
    solid.ball(fx + 1.08, y0 + 3.3, fz + 0.25, 0.035, 0x10202c, 1, 5);
    // water arcs: eight jets as thin pale cylinders leaning out, with a halo in the spray
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      solid.cyl(fx + Math.cos(a) * 1.3, y0 + 0.7, fz + Math.sin(a) * 1.3, 0.02, 0.035, 1.1, 0xbfe9ff, 5, { rx: -Math.sin(a) * 0.5, rz: Math.cos(a) * 0.5 });
      glow.halo(fx + Math.cos(a) * 1.5, y0 + 1.5, fz + Math.sin(a) * 1.5, 0.6, 0x9ad8ff);
    }
    glow.halo(fx, y0 + 2.4, fz, 4.2, CYAN);
    glow.pool(fx, y0 + 0.08, fz, 6.5, CYAN);
  }

  // ---- the aquarium wall (its own module: the fish in it are animated, everything else is batched here)
  const aquarium = buildAquarium(group, box('casino-aquarium'), y0, solid, neonB, glow);

  // ---- pillars with neon rings, and potted palms because the carpet needs something living to argue with
  for (const id of ['casino-pillar-w', 'casino-pillar-e']) {
    const p = box(id);
    solid.span(p.u0, p.u1, y0, ceilY, Zf(p.v1), Zf(p.v0), 0x0f4a5a);
    solid.span(p.u0 - 0.06, p.u1 + 0.06, y0, y0 + 0.3, Zf(p.v1) - 0.06, Zf(p.v0) + 0.06, GOLD);
    for (const y of [1.6, 3.2, 5.0]) { neonB.span(p.u0 - 0.03, p.u1 + 0.03, y0 + y, y0 + y + 0.07, Zf(p.v1) - 0.03, Zf(p.v0) + 0.03, y === 3.2 ? PINK : CYAN); glow.halo((p.u0 + p.u1) / 2, y0 + y, Zf((p.v0 + p.v1) / 2), 1.5, y === 3.2 ? PINK : CYAN); }
  }

  // ---- islands: each gets a neon spine and a hanging sign pole so the rows read from the door
  for (const id of ['casino-island-w', 'casino-island-e']) {
    const b = box(id);
    solid.span(b.u0, b.u1, y0 + 2.78, y0 + 2.9, Zf(b.v1), Zf(b.v0), 0x12394a);
    neonB.span(b.u0, b.u1, y0 + 2.9, y0 + 2.96, Zf(b.v0) - 0.0, Zf(b.v0) + 0.06, GOLD);
    neonB.span(b.u0, b.u1, y0 + 2.9, y0 + 2.96, Zf(b.v1) - 0.06, Zf(b.v1) + 0.0, GOLD);
    for (let u = b.u0 + 1; u < b.u1; u += 2) glow.halo(u, y0 + 3.0, Zf((b.v0 + b.v1) / 2), 1.1, GOLD);
  }

  // ---- the signs
  const atlas = signAtlas(); texs.push(atlas);
  const q = new Quads();
  q.sign('back', 0, PAD_Y + 5.6, Zf(166 - WALL_T) + 0.08, 22, 4.2, 0, 1);
  q.sign('side', x0 + 0.1, PAD_Y + 5.4, Zf(152), 20, 3.9, 1, 0);
  q.sign('side', x1 - 0.1, PAD_Y + 5.4, Zf(152), 20, 3.9, -1, 0, true);
  q.sign('change', 19.3, PAD_Y + 4.4, Zf(147), 5.6, 2.2, -1, 0);
  q.sign('fish', x0 + 0.1, PAD_Y + 3.5, Zf(146), 4.6, 1.8, 1, 0);
  q.sign('house', 0, PAD_Y + 4.8, Zf(lot.v0 + WALL_T) - 0.12, 9, 2.1, 0, -1);
  q.sign('poster', x1 - 0.12, PAD_Y + 2.3, Zf(142), 2.4, 1.1, -1, 0);
  {
    const g = q.build(); geos.push(g);
    const mat = own(new THREE.MeshBasicMaterial({ map: atlas, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide }));
    const m = new THREE.Mesh(g, mat); m.renderOrder = 1; group.add(m);
  }

  // ---- real lamps (the town's pool of four picks the nearest when you are in here): over the islands, the cage and the floor
  for (const [u, v] of [[-12, 153.5], [12, 153.5], [0, 146], [0, 162], [18, 147], [-19, 146]] as const) {
    lights.push({ x: u, y: PAD_Y + H - 1.2, z: Zf(v), color: 0xcfeaff, kind: 'lamp', lot: 'casino' });
  }

  // ---- merge and add the meshes
  const solidMesh = new THREE.Mesh(solid.build(), kit.solid); solidMesh.castShadow = false; solidMesh.receiveShadow = false; group.add(solidMesh);
  const neonMat = own(new THREE.MeshBasicMaterial({ vertexColors: true }));
  const nm = new THREE.Mesh(neonB.build(), neonMat); group.add(nm);
  const fa = new THREE.Mesh(flashA.build(), neonMat), fb = new THREE.Mesh(flashB.build(), neonMat); group.add(fa, fb);
  // Always-on halos: NOT registered with the sunset blend (kit.glowQuad is, and would be invisible by day), because there is no day in here.
  const glowMat = own(new THREE.MeshBasicMaterial({ map: kit.radial, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: 0.6 }));
  const gm = new THREE.Mesh(glow.build(), glowMat); gm.renderOrder = 2; group.add(gm);
  geos.push(solidMesh.geometry, nm.geometry, fa.geometry, fb.geometry, gm.geometry);

  // ---- people: built the first time the camera comes near, shown only when it is inside or at the door
  let people: CasinoPerson[] | null = null;
  const crowd = new THREE.Group(); crowd.name = 'casino-crowd'; crowd.visible = false; group.add(crowd);
  const inside = (p: THREE.Vector3, m: number): boolean => {
    // the interior group sits in the town's local frame (x = u, z = -v) and so does the camera passed in
    return p.x > lot.u0 - m && p.x < lot.u1 + m && -p.z > lot.v0 - m && -p.z < lot.v1 + m;
  };

  return {
    // `people`/`dancers` both empty: the casino's own figures are its own system (casino-people.ts,
    // driven from `animate` below), not the shared box-person list the shops use.
    lot, group, people: [], dancers: [], lights,
    animate(t, cam) {
      // slot attract screens: four textures scrolling at different rates, with a stop-and-go so they read as spins
      screenTex.forEach((tx, i) => {
        const k = t * (0.55 + i * 0.17) + i * 1.7;
        tx.offset.y = (k + 0.15 * Math.sin(k * 2.1)) * 0.375;
      });
      const ph = Math.floor(t * 3) % 2 === 0;
      fa.visible = ph; fb.visible = !ph;
      const near = inside(cam, 3) || (Math.abs(cam.x - lot.door) < 14 && -cam.z > lot.v0 - 16 && -cam.z <= lot.v0 + 3);
      // the tank swims only while somebody is in the room to see it; the shell is batched and costs
      // nothing whether it moves or not, and the fish are a closed form of `t`, so they are in the
      // right place the frame the player walks back in rather than resuming where they left off
      if (near) aquarium.update(t);
      if (near && !people) {
        people = CASINO_NPCS.map((n) => makeCasinoPerson(n, PAD_Y));
        for (const p of people) {
          crowd.add(p.human.group);
          // No shadows from people in here: the room has no sun, and each caster is a draw call in EVERY cascade
          // (the first capture counted 1,000-1,300 draw calls with the crowd in view against ~230 without).
          p.human.group.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
        }
      }
      crowd.visible = !!people && near;
      if (people && near) {
        const within = inside(cam, 0.2);
        for (const p of people) {
          const g = p.human.group;
          // Outside, the doorway is a 2.8 m slot: only people the line of sight through it can reach are worth a draw
          // (a figure is ~18 meshes, and frustum culling cannot tell that a wall is in the way).
          let seen = within;
          if (!within) {
            const k = (-g.position.z - cam.z * -1) / Math.max(0.5, lot.v0 - -cam.z); // fraction of the way from the camera to the person, along v
            const uAtDoor = cam.x + (g.position.x - cam.x) / Math.max(1e-3, k);
            seen = Math.abs(uAtDoor - lot.door) < DOOR_W / 2 + 0.8;
          }
          g.visible = seen;
          if (seen) p.update(t);
        }
      }
    },
    dispose() {
      aquarium.dispose();
      geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); texs.forEach((tx) => tx.dispose());
      people?.forEach((p) => p.human.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }));
      group.clear();
    },
  };
}
