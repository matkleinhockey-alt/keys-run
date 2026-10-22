/**
 * Builds Boot Key Harbor City's static geometry from `world/town.ts`, in stages.
 *
 * A generator on purpose. Painting a dozen 1024-px facades, merging a few thousand primitives and
 * allocating the textures is tens of milliseconds in total but would land as one frame hitch if it
 * ran in one go, in the middle of a player cruising past. `buildTown` yields after every logical
 * piece (pad, each building, props, cars), and `town.ts` pumps one stage per frame while the camera
 * is within `BUILD_RANGE` — or all of them at once via `ensureBuilt()` when land mode needs the
 * town now. Until the first stage runs the town does not exist: nothing is allocated, nothing is in
 * the scene, nothing is drawn. That is the whole "costs nothing at sea" guarantee, and the test of
 * it is in test/capture-town.mjs (draw calls with the boat 3 km out vs. in the harbour).
 *
 * ## Two outputs, two costs
 * `near` is the full town: facade decals, signs, awnings, props, the lot. `far` is the same
 * buildings as bare coloured boxes plus one glow quad per storefront, a handful of draws, for the
 * 300-1,500 m band where the town is a skyline you steer by and not something you can read. They
 * are swapped by distance (town.ts), never shown together.
 *
 * Everything is in the town's local frame (x = u, z = -v, y absolute); the caller positions the
 * root at the marina and rotates it for a `dir = -1` marina.
 */
import * as THREE from 'three';
import {
  PAD, PAD_Y, RAMP, DECK_TOP, LOTS, SURFACES, PALMS, LAMPS, BENCHES, CARS, WALL_T, DOOR_W, INTERIOR_BOXES, lotWalls, type Lot,
} from '@keysrun/shared/world/town';
import { VENUES } from '@keysrun/shared/content/venues';
import { GeoBatch } from './batch.js';
import { createKit, type TownKit } from './kit.js';
import { paintFacade, paintHero, fadeColor, LOOKS, type HeroKind } from './paint.js';
import { createNotices } from './notices.js';
import { buildWalls } from './walls.js';
import { palm, lamp, bench, trashCan, car, marlinStatue, Zf } from './props.js';
import { buildGround } from './ground.js';
import { buildStreetLife } from './streetlife.js';
import { TRASH_CANS } from '@keysrun/shared/world/town-life';
import type { LightMatEntry } from '../../core/time-of-day.js';

export interface LightSource { x: number; y: number; z: number; color: number; kind: 'lamp' | 'neon'; lot?: string }

export interface TownBuild {
  near: THREE.Group;
  far: THREE.Group;
  lights: LightSource[];
  kit: TownKit;
  /** Every mesh whose material wants cascaded-shadow setup is already under `near`; this is for the caller's sweep. */
  triangleCount: number;
  /** The sky blend (0 day .. 1 dusk), for the ground's day lift. Cheap; call when it changes. */
  setTod(k: number): void;
  dispose(): void;
}

const hex = (css: string): number => parseInt(css.replace('#', '').slice(0, 6), 16);

function addMesh(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, opts: { cast?: boolean; receive?: boolean; name?: string; order?: number } = {}): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = !!opts.cast; m.receiveShadow = opts.receive !== false;
  if (opts.name) m.name = opts.name;
  if (opts.order !== undefined) m.renderOrder = opts.order;
  group.add(m);
  return m;
}

function textTexture(lines: string[], w: number, h: number, bg: string, fg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = fg; g.lineWidth = 6; g.strokeRect(10, 10, w - 20, h - 20);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((t, i) => { g.font = `800 ${i === 0 ? h * 0.38 : h * 0.2}px "Big Shoulders Display", Impact, sans-serif`; g.fillText(t, w / 2, h * (i === 0 ? 0.4 : 0.76), w - 40); });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Which roof-mounted hero sign, if any, each building gets. */
const HERO: Partial<Record<Lot['style'], { kind: HeroKind; size: number; w?: number }>> = {
  club: { kind: 'flamingo', size: 6.4 },
  guns: { kind: 'target', size: 4.4 },
  tackle: { kind: 'marlin', size: 6.2 },
  diner: { kind: 'dinerRoof', size: 3.4, w: 9.5 },
  bar: { kind: 'beer', size: 3.6 },
};

export function* buildTown(lightMats: LightMatEntry[], todK: () => number): Generator<void, TownBuild> {
  const kit = createKit(lightMats, todK);
  const near = new THREE.Group(); near.name = 'townNear';
  const far = new THREE.Group(); far.name = 'townFar';
  const solid = new GeoBatch(false, 'street'), cars = new GeoBatch(false, 'street'), glow = new GeoBatch(true), farB = new GeoBatch(false, 'street'), farGlow = new GeoBatch(true);
  // palms are seen from every side, so they cannot use the street lift (which brightens the south-facing frontage only)
  const palms = new GeoBatch(false, 1.7);
  const notices = createNotices();
  const lights: LightSource[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };

  // ------------------------------------------------------------------ the pad, streets, seawall
  solid.span(PAD.u0, PAD.u1, -1.8, PAD_Y, Zf(PAD.v1), Zf(PAD.v0), 0xa9a69d);
  // seawall face a shade darker, with a coping line along the top edge facing the harbour
  solid.span(PAD.u0, PAD.u1, -1.8, PAD_Y - 0.05, Zf(PAD.v0) + 0.08, Zf(PAD.v0) + 0.1, 0x7e8085);
  solid.span(PAD.u0 - 0.2, PAD.u1 + 0.2, PAD_Y - 0.35, PAD_Y, Zf(PAD.v0) + 0.25, Zf(PAD.v0) - 0.0, 0xcfcbc0);
  // The roads, sidewalks and lots are decals drawn in SURFACES order, not slabs that fight for the same pixel: see ground.ts.
  const ground = buildGround();
  ground.setTod(todK());
  for (const m of ground.meshes) near.add(m);
  // promenade: real planks
  {
    const p = SURFACES.find((s) => s.kind === 'promenade')!;
    const w = p.u1 - p.u0, d = p.v1 - p.v0;
    const g = track(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2));
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 2), uv.getY(i) * (d / 2));
    const mat = new THREE.MeshStandardMaterial({ map: kit.plank, roughness: 0.9, emissive: 0xffffff, emissiveMap: kit.plank, emissiveIntensity: 0.35, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const m = addMesh(near, g, mat, { receive: true, name: 'promenade' });
    m.position.set((p.u0 + p.u1) / 2, PAD_Y + 0.03, Zf((p.v0 + p.v1) / 2));
    mats.push(mat);
  }
  // (road paint, kerbs and zebra crossings are in ground.ts, as flat quads drawn by order rather than 1 cm boxes)
  const PA = PAD_Y + 0.025; // the life ring's height on the rail, below
  // rails: harbour front (with a gap at the ramp), then sides; hedge across the back
  for (let u = PAD.u0 + 1; u <= PAD.u1 - 1; u += 4) {
    if (Math.abs(u) < 3.4) continue;
    solid.cyl(u, PAD_Y, Zf(PAD.v0 + 0.4), 0.045, 0.05, 1.05, 0xe8ebee, 6);
  }
  solid.span(PAD.u0, -2.9, PAD_Y + 0.55, PAD_Y + 0.6, Zf(PAD.v0 + 0.42), Zf(PAD.v0 + 0.38), 0xe8ebee);
  solid.span(PAD.u0, -2.9, PAD_Y + 1.0, PAD_Y + 1.05, Zf(PAD.v0 + 0.42), Zf(PAD.v0 + 0.38), 0xe8ebee);
  solid.span(2.9, PAD.u1, PAD_Y + 0.55, PAD_Y + 0.6, Zf(PAD.v0 + 0.42), Zf(PAD.v0 + 0.38), 0xe8ebee);
  solid.span(2.9, PAD.u1, PAD_Y + 1.0, PAD_Y + 1.05, Zf(PAD.v0 + 0.42), Zf(PAD.v0 + 0.38), 0xe8ebee);
  for (let u = PAD.u0 + 12; u <= PAD.u1 - 12; u += 24) {
    if (Math.abs(u) < 10) continue;
    solid.cyl(u, PA, Zf(PAD.v0 + 0.55), 0.3, 0.3, 0.08, 0xd9342b, 12, { rx: Math.PI / 2 }); // a life ring hung on the rail
    solid.cyl(u + 6, PAD_Y, Zf(PAD.v0 + 1.6), 0.15, 0.18, 0.5, 0x2f3438, 8);                // bollard
  }
  solid.span(PAD.u0, PAD.u1, PAD_Y, PAD_Y + 1.15, Zf(PAD.v1), Zf(PAD.v1 - 1.1), 0x2f6b34);
  solid.span(PAD.u0, PAD.u0 + 1.1, PAD_Y, PAD_Y + 1.15, Zf(PAD.v1), Zf(PAD.v0 + 0.6), 0x2f6b34);
  solid.span(PAD.u1 - 1.1, PAD.u1, PAD_Y, PAD_Y + 1.15, Zf(PAD.v1), Zf(PAD.v0 + 0.6), 0x2f6b34);
  yield;

  // ------------------------------------------------------------------ the ramp up from the pier
  {
    const run = RAMP.v1 - RAMP.v0, rise = PAD_Y - DECK_TOP, th = Math.atan2(rise, run), len = Math.hypot(run, rise);
    const midV = (RAMP.v0 + RAMP.v1) / 2, midY = (DECK_TOP + PAD_Y) / 2;
    const wd = RAMP.u1 - RAMP.u0;
    solid.box(0, midY - 0.14, Zf(midV), wd, 0.26, len, 0x9c7a55, { rx: th });
    for (const sx of [-1, 1]) {
      solid.box(sx * (wd / 2 - 0.05), midY + 0.95, Zf(midV), 0.07, 0.07, len, 0xe8ebee, { rx: th });
      for (let v = RAMP.v0 + 0.5; v <= RAMP.v1 - 0.4; v += 2.5) {
        const y = DECK_TOP + rise * ((v - RAMP.v0) / run);
        solid.cyl(sx * (wd / 2 - 0.05), y, Zf(v), 0.04, 0.045, 1.0, 0xe8ebee, 6);
      }
    }
    for (const v of [9.5, 13, 16.5]) for (const sx of [-1, 1]) solid.cyl(sx * 1.9, -1.2, Zf(v), 0.17, 0.2, DECK_TOP + 1.0, 0x6e5a44, 6);
    // the welcome banner over the head of the ramp, readable from the dock and from the pad
    const tex = textTexture(['WELCOME TO BOOT KEY HARBOR CITY', 'Please tie up your boat. Please do not tie up the seagull.'], 1024, 192, '#0d4a63', '#fff6e0');
    const bm = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.4, side: THREE.DoubleSide });
    mats.push(bm); texs.push(tex);
    const bg = track(new THREE.PlaneGeometry(7.6, 1.4));
    const banner = addMesh(near, bg, bm, { name: 'banner' }); banner.position.set(0, PAD_Y + 3.9, Zf(PAD.v0 + 1.2));
    // ...and a second face for the street side: one double-sided plane read mirrored from the avenue (polish pass)
    const bmBack = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.4 });
    mats.push(bmBack);
    const banner2 = addMesh(near, bg, bmBack, { name: 'banner-back' }); banner2.position.set(0, PAD_Y + 3.9, Zf(PAD.v0 + 1.2) - 0.02); banner2.rotation.y = Math.PI;
    for (const sx of [-1, 1]) solid.box(sx * 3.9, PAD_Y + 2.2, Zf(PAD.v0 + 1.2), 0.18, 4.4, 0.18, 0x2d3136);
  }
  yield;

  // ------------------------------------------------------------------ buildings
  for (const lot of LOTS) {
    buildLot(lot);
    yield;
  }
  // the backs and open sides of the buildings (walls.ts): one merged decal mesh, a batch of door/AC/pipe geometry, and the wall lamps' night glow
  const walls = buildWalls(near, glow, kit);
  yield;

  function buildLot(lot: Lot): void {
    const look = LOOKS[lot.style], venue = VENUES[lot.venue];
    const W = lot.u1 - lot.u0, D = lot.v1 - lot.v0, cx = (lot.u0 + lot.u1) / 2, cz = Zf((lot.v0 + lot.v1) / 2);
    const top = PAD_Y + lot.h;
    // mass
    // sun-bleached to match the facade decal (paint.ts `fadeColor`); the club's paint is not ours to change
    const wallC = lot.style === 'club' ? look.wall : fadeColor(look.wall);
    for (const w of lotWalls(lot)) solid.span(w.u0, w.u1, PAD_Y, top, Zf(w.v1), Zf(w.v0), wallC);
    // roof
    const roofC = look.roof;
    if (lot.style === 'bar') {
      solid.span(lot.u0 - 0.3, lot.u1 + 0.3, top, top + 0.25, Zf(lot.v1) - 0.3, Zf(lot.v0) + 0.3, 0x3a2a1c);
      solid.gable(cx, top + 0.25, cz, W + 0.8, D + 0.6, 2.4, roofC, true);
    } else {
      solid.span(lot.u0 - 0.12, lot.u1 + 0.12, top, top + 0.22, Zf(lot.v1) - 0.12, Zf(lot.v0) + 0.12, look.trim);
      // parapet ring
      const pt = top + 0.22, ph = 0.6;
      solid.span(lot.u0 - 0.12, lot.u1 + 0.12, pt, pt + ph, Zf(lot.v0) + 0.12, Zf(lot.v0) + 0.0, look.trim);
      solid.span(lot.u0 - 0.12, lot.u1 + 0.12, pt, pt + ph, Zf(lot.v1) - 0.12, Zf(lot.v1) - 0.0, look.trim);
      solid.span(lot.u0 - 0.12, lot.u0, pt, pt + ph, Zf(lot.v1), Zf(lot.v0), look.trim);
      solid.span(lot.u1, lot.u1 + 0.12, pt, pt + ph, Zf(lot.v1), Zf(lot.v0), look.trim);
      solid.span(lot.u0, lot.u1, top + 0.2, top + 0.24, Zf(lot.v1), Zf(lot.v0), roofC);
      const seed = Math.abs(Math.sin(lot.u0 * 3.1 + lot.v0)) ;
      solid.box(cx + (seed - 0.5) * W * 0.5, pt + 0.5, cz + 1, 1.8, 0.9, 1.2, 0xb9bec2);
      solid.box(cx + (0.5 - seed) * W * 0.4, pt + 0.4, cz - 1.5, 1.2, 0.7, 1.0, 0xa8aeb3);
    }
    // facade decal + its night layer
    const f = paintFacade(lot);
    notices.add(lot, f.layout);
    const fg = track(new THREE.PlaneGeometry(W, lot.h));
    const dm = kit.decal(f.day); const day = addMesh(near, fg, dm, { name: `facade-${lot.id}` });
    day.position.set(cx, PAD_Y + lot.h / 2, Zf(lot.v0) + 0.035);
    const gm = kit.glowDecal(f.glow, lot.style === 'club' ? 1 : 0.9); const gl = addMesh(near, fg, gm, { name: `facade-glow-${lot.id}`, order: 2 });
    gl.position.set(cx, PAD_Y + lot.h / 2, Zf(lot.v0) + 0.06);

    // awning: stripes sloping out over the sidewalk
    if (look.awning && !lot.enterable) {
      const [c1, c2] = look.awning, y = PAD_Y + 2.95;
      const n = Math.floor((W - 1) / 0.9);
      for (let i = 0; i < n; i++) solid.box(lot.u0 + 0.5 + 0.45 + i * 0.9, y, Zf(lot.v0) + 0.85, 0.9, 0.06, 1.7, i % 2 ? c2 : c1, { rx: 0.26 });
      solid.box(cx, y - 0.32, Zf(lot.v0) + 1.7, W - 1, 0.18, 0.05, c1);
    }
    if (lot.enterable) {
      // diner gets a striped awning over the door only; the bar gets a hanging lantern
      if (lot.style === 'diner') for (let i = 0; i < 6; i++) solid.box(lot.door - 2.5 + 0.5 + i * 0.83, PAD_Y + 2.95, Zf(lot.v0) + 0.8, 0.83, 0.06, 1.6, i % 2 ? 0xf4f4f2 : 0xc23a3a, { rx: 0.26 });
    }

    // the hero sign: the one thing that identifies the venue from across the street
    const hero = HERO[lot.style];
    if (hero) {
      const tex = paintHero(hero.kind);
      const hw = hero.w ?? hero.size * tex.aspect, hh = hero.size;
      const geo = track(new THREE.PlaneGeometry(hw, hh));
      const hx = lot.style === 'diner' ? cx : lot.style === 'bar' ? lot.u0 + 4.2 : cx;
      const baseY = lot.style === 'bar' ? PAD_Y + lot.h + 1.0 : top + 0.8;
      const hm = addMesh(near, geo, kit.decal(tex.day), { name: `hero-${lot.id}`, receive: false });
      hm.position.set(hx, baseY + hh / 2, Zf(lot.v0) - 0.6);
      const hg = addMesh(near, geo, kit.glowDecal(tex.glow), { name: `hero-glow-${lot.id}`, receive: false, order: 2 });
      hg.position.set(hx, baseY + hh / 2, Zf(lot.v0) - 0.55);
      if (lot.style !== 'bar') for (const dx of [-hw * 0.3, hw * 0.3]) solid.box(hx + dx, top + 0.4, Zf(lot.v0) - 0.62, 0.12, 1.0, 0.12, 0x2d3136);
      glow.halo(hx, baseY + hh / 2, Zf(lot.v0) - 0.4, hh * 0.62, hex(look.neon));
    }

    // venue-specific set dressing
    const door = lot.door, fz = Zf(lot.v0);
    if (lot.style === 'club') {
      // velvet rope and red carpet to the kerb, gold stanchions, door lamps
      solid.span(door - 1.2, door + 1.2, PAD_Y, PAD_Y + 0.035, fz + 0.1, fz + 5.6, 0x9b1b30);
      for (const dx of [-1.9, 1.9]) {
        solid.cyl(door + dx, PAD_Y, fz + 2.3, 0.04, 0.07, 0.9, 0xe0b34a, 8);
        solid.ball(door + dx, PAD_Y + 0.95, fz + 2.3, 0.07, 0xe0b34a, 1, 6);
      }
      solid.box(door - 1.9, PAD_Y + 0.8, fz + 2.3, 0.05, 0.05, 0.05, 0x9b1b30);
      solid.span(door - 1.9, door - 0.45, PAD_Y + 0.74, PAD_Y + 0.8, fz + 2.28, fz + 2.32, 0x9b1b30);
      solid.span(door + 0.45, door + 1.9, PAD_Y + 0.74, PAD_Y + 0.8, fz + 2.28, fz + 2.32, 0x9b1b30);
      for (const dx of [-1.9, 1.9]) glow.halo(door + dx, PAD_Y + 2.7, fz + 0.5, 1.4, 0xff3fa4);
      glow.pool(door, PAD_Y + 0.06, fz + 3.0, 5, 0xff3fa4);
      spotlights(lot);
    } else if (lot.style === 'tackle') {
      // crab traps, buoys and a rod rack: the front of a Keys bait shop
      for (let i = 0; i < 3; i++) solid.span(-56.2 + (i % 2) * 0.6, -54 + (i % 2) * 0.6, PAD_Y + i * 0.55, PAD_Y + 0.5 + i * 0.55, Zf(42.9), Zf(41.5), 0x6b5a3a);
      const BU = [0xe4572e, 0xf2c14e, 0xffffff, 0x2bb3a8];
      for (let i = 0; i < 9; i++) solid.ball(lot.u0 + 2 + i * 1.1, PAD_Y + 2.45 - (i % 3) * 0.1, fz + 0.55, 0.22, BU[i % 4], 1.15, 8);
      for (let i = 0; i < 7; i++) solid.cyl(lot.u1 - 1.2 - i * 0.28, PAD_Y, fz + 0.45, 0.025, 0.025, 2.6 - (i % 2) * 0.25, 0x23262a, 5, { rz: 0.1 });
    } else if (lot.style === 'guns') {
      // flagpole and sandbag-grey bollards; the flag is three stripes and a blue canton
      const px = lot.u1 - 1.0, pz = fz + 1.4;
      solid.cyl(px, PAD_Y, pz, 0.05, 0.08, 7.5, 0xd0d4d8, 6);
      for (let i = 0; i < 7; i++) solid.box(px - 1.0, PAD_Y + 7.2 - i * 0.2, pz, 1.9, 0.2, 0.03, i % 2 ? 0xf4f4f4 : 0xb22234);
      solid.box(px - 0.45, PAD_Y + 6.8, pz + 0.02, 0.8, 0.8, 0.03, 0x3c3b6e);
      for (const dx of [-3.4, 3.4]) solid.cyl(door + dx, PAD_Y, fz + 0.9, 0.17, 0.17, 0.85, 0x3a3d40, 8);
    } else if (lot.style === 'icecream') {
      solid.cyl(cx, PAD_Y + lot.h + 0.9, Zf(lot.v0) - 2.2, 1.6, 0.05, 3.4, 0xd9a85c, 10);
      solid.ball(cx, PAD_Y + lot.h + 4.7, Zf(lot.v0) - 2.2, 1.7, 0xf7a7c6, 1, 10);
      solid.ball(cx + 0.1, PAD_Y + lot.h + 6.1, Zf(lot.v0) - 2.2, 1.2, 0xfff3e0, 1, 10);
      solid.ball(cx + 0.1, PAD_Y + lot.h + 7.2, Zf(lot.v0) - 2.2, 0.28, 0xc0172b, 1, 6);
    } else if (lot.style === 'pawn') {
      solid.box(lot.u1 - 1.4, PAD_Y + 3.2, fz + 0.9, 0.08, 0.08, 1.6, 0x2d3136);
      for (let i = 0; i < 3; i++) solid.ball(lot.u1 - 1.4 + (i - 1) * 0.0, PAD_Y + 2.9, fz + 0.9 + (i - 1) * 0.5, 0.24, 0xe0b34a, 1, 8);
    } else if (lot.style === 'dive') {
      const px = lot.u1 - 1.3;
      solid.cyl(px, PAD_Y, fz + 1.2, 0.05, 0.07, 3.8, 0xd0d4d8, 6);
      solid.box(px + 0.5, PAD_Y + 3.4, fz + 1.2, 1.0, 0.7, 0.03, 0xd9342b);
      solid.box(px + 0.5, PAD_Y + 3.4, fz + 1.22, 1.0, 0.1, 0.03, 0xffffff, { rz: 0.6 });
      for (let i = 0; i < 4; i++) { solid.cyl(lot.u0 + 1.0 + i * 0.5, PAD_Y, fz + 0.4, 0.16, 0.16, 1.2, [0xf2c14e, 0x2bb3a8, 0xf2c14e, 0xdfe6ea][i], 8, { rz: 0.05 }); solid.ball(lot.u0 + 1.0 + i * 0.5, PAD_Y + 1.25, fz + 0.4, 0.15, 0xc0c4c8, 1, 6); }
    } else if (lot.style === 'bar') {
      // string lights along the eave
      for (let i = 0; i < 20; i++) {
        const bx = lot.u0 + 1 + i * (W - 2) / 19, by = PAD_Y + lot.h - 0.25 - Math.sin((i / 19) * Math.PI * 3) * 0.1;
        solid.ball(bx, by, fz + 0.5, 0.07, 0xfff0b0, 1, 5);
        glow.halo(bx, by, fz + 0.5, 0.45, 0xffd070);
      }
      solid.box(lot.u0 + 1.0, PAD_Y + 0.5, fz + 1.6, 1.2, 0.08, 0.8, 0x6b4a2b); // a stool-height crate by the door
    } else if (lot.style === 'liquor' || lot.style === 'convenience') {
      solid.span(lot.u0 + 0.7, lot.u0 + 2.3, PAD_Y, PAD_Y + 0.9, fz + 0.2, fz + 0.8, 0xe8edf1); // ice chest
      solid.span(lot.u0 + 0.7, lot.u0 + 2.3, PAD_Y + 0.9, PAD_Y + 0.95, fz + 0.18, fz + 0.82, 0x2b6cb0);
    }
    if (lot.style === 'diner') {
      // a short chrome-and-red skirt and a row of stools you can see through the glass at night
      solid.span(lot.u0 - 0.05, lot.u1 + 0.05, PAD_Y, PAD_Y + 0.5, fz + 0.0, fz + 0.12, 0xc23a3a);
    }
    if (lot.style !== 'club') glow.pool(door, PAD_Y + 0.06, fz + 2.2, 3.4, 0xffd9a0);

    // neon light source for the pool: one per storefront, hung just outside the door
    lights.push({ x: door, y: PAD_Y + 3.2, z: fz + 1.8, color: hex(look.neon), kind: 'neon', lot: lot.id });

    // far silhouette: bare box + roof, and a glow quad the colour of the sign
    farB.span(lot.u0, lot.u1, PAD_Y, top, Zf(lot.v1), Zf(lot.v0), look.wall);
    farB.span(lot.u0 - 0.12, lot.u1 + 0.12, top, top + 0.8, Zf(lot.v1) - 0.12, Zf(lot.v0) + 0.12, lot.style === 'bar' ? 0x8f959b : look.trim);
    farGlow.quad(cx, PAD_Y + Math.min(lot.h, 4.4) * 0.6, fz + 0.3, W * 0.5, 0, 0, 0, Math.min(lot.h, 4.4) * 0.55, 0, hex(look.neon));
    void venue; void D;
  }

  function spotlights(lot: Lot): void {
    // two searchlight beams over the club: additive cones, brighter at the base
    const top = PAD_Y + lot.h + 0.6;
    for (const [dx, tilt] of [[-7, 0.28], [7, -0.28]] as const) {
      const g = track(new THREE.ConeGeometry(2.2, 34, 12, 1, true).translate(0, 17, 0));
      const mat = kit.glowFlat(0xff5fb8, 0.16);
      const m = addMesh(near, g, mat, { receive: false, name: 'club-beam', order: 3 });
      m.position.set((lot.u0 + lot.u1) / 2 + dx, top, Zf(lot.v0) - 1.5);
      m.rotation.z = tilt;
      mats.push(mat);
    }
  }
  yield;

  // ------------------------------------------------------------------ street furniture
  for (const p of PALMS) palm(palms, p.u, p.v, p.h);
  for (const l of LAMPS) {
    const head = lamp(solid, glow, l.u, l.v);
    lights.push({ x: head.x, y: head.y, z: head.z, color: 0xffe2a8, kind: 'lamp' });
  }
  for (const b of BENCHES) bench(solid, b.u, b.v);
  for (const c of TRASH_CANS) trashCan(solid, c.u, c.v);
  marlinStatue(solid, 16, 24);
  const streetLife = buildStreetLife(solid, near);
  // dumpsters behind the bar and the diner
  for (const [u, v] of [[-24, 77.4], [30, 77.4]] as const) { solid.span(u - 1.6, u + 1.6, PAD_Y, PAD_Y + 1.25, Zf(v) - 0.8, Zf(v) + 0.8, 0x2f6b3a); solid.span(u - 1.65, u + 1.65, PAD_Y + 1.25, PAD_Y + 1.35, Zf(v) - 0.85, Zf(v) + 0.85, 0x23282a); }
  // motel pole sign: 9 m up, on the boulevard
  {
    const tex = paintHero('vacancy'); const hh = 3.8, hw = hh * tex.aspect;
    const geo = track(new THREE.PlaneGeometry(hw, hh));
    solid.cyl(40, PAD_Y, Zf(98.5), 0.16, 0.2, 7.2, 0x2d3136, 8);
    const d = addMesh(near, geo, kit.decal(tex.day), { name: 'motel-sign', receive: false }); d.position.set(40, PAD_Y + 9.1, Zf(98.5) + 0.2);
    const g = addMesh(near, geo, kit.glowDecal(tex.glow), { name: 'motel-sign-glow', receive: false, order: 2 }); g.position.set(40, PAD_Y + 9.1, Zf(98.5) + 0.24);
    glow.halo(40, PAD_Y + 9.1, Zf(98.5) + 0.5, 3.2, 0xff6a3a);
    lights.push({ x: 40, y: PAD_Y + 8, z: Zf(98.5) + 1, color: 0xff7a4a, kind: 'neon', lot: 'motel' });
  }
  yield;

  // ------------------------------------------------------------------ cars
  for (const c of CARS) car(cars, c);
  yield;

  // ------------------------------------------------------------------ merge to meshes
  const solidMesh = addMesh(near, track(solid.build()), kit.solid, { cast: true, receive: true, name: 'townSolid' });
  const carMesh = addMesh(near, track(cars.build()), kit.car, { cast: true, receive: true, name: 'townCars' });
  addMesh(near, track(palms.build()), kit.solid, { cast: true, receive: true, name: 'townPalms' });
  const noticeMesh = notices.build(near);
  const glowMesh = addMesh(near, track(glow.build()), kit.glowQuad, { receive: false, name: 'townGlow', order: 1 });
  void solidMesh; void carMesh; void glowMesh;

  // the far silhouette: pad as one slab, palms as green blobs
  farB.span(PAD.u0, PAD.u1, -1.8, PAD_Y, Zf(PAD.v1), Zf(PAD.v0), 0xa9a69d);
  for (const p of PALMS) farB.ball(p.u, PAD_Y + 6 * p.h, Zf(p.v), 1.8, 0x3f8a35, 0.6, 5);
  addMesh(far, track(farB.build()), kit.solid, { receive: false, name: 'townFarSolid' });
  addMesh(far, track(farGlow.build()), kit.glowQuad, { receive: false, name: 'townFarGlow', order: 1 });

  void WALL_T; void DOOR_W; void INTERIOR_BOXES;
  const triangleCount = solid.triangleCount + cars.triangleCount + glow.triangleCount + palms.triangleCount + walls.triangles;
  return {
    near, far, lights, kit, triangleCount,
    setTod: (k) => ground.setTod(k),
    dispose() {
      ground.dispose(); streetLife.dispose(); noticeMesh.dispose(); walls.dispose();
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      texs.forEach((t) => t.dispose());
      kit.dispose();
    },
  };
}
