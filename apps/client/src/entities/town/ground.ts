/**
 * The ground of Boot Key Harbor City: asphalt, sidewalk, the lots, the kerbs and the paint.
 *
 * ## What was wrong
 * The streets were boxes laid on the pad at `PAD_Y + 0.02`, in the order of `SURFACES`, sorted only by
 * painter's-algorithm luck: where Palm Avenue crossed the harbor sidewalk, or the back lane crossed
 * the avenue, two coplanar tops fought for the pixel and the junction shimmered (a jagged notch
 * visible in the first street capture). The road markings were 1.2 cm boxes standing on top of
 * that, so they fought too beyond ~60 m. And the surfaces were flat vertex colour, so a 12 m wide
 * road was one featureless navy slab.
 *
 * ## What it is now
 *   - One decal mesh per surface, DRAWN IN `SURFACES` ORDER (`renderOrder`), depthWrite OFF. Nothing
 *     is sorted by depth any more, so nothing can z-fight: a later surface simply paints over an
 *     earlier one, which is exactly what `SURFACES` has always meant ("later entries draw on top").
 *     Each depth-TESTS against the world (the pad slab, cars, walls, people), so a car still occludes
 *     the road under it. Cost: 11 draw calls for the ground (was 0, they were in the merged solid
 *     mesh): measured in the perf report, it is the price of removing the shimmer.
 *   - Textures instead of flat colour: asphalt with patched seams, hairline cracks and oil stains;
 *     sidewalk with expansion joints and gum; the lot with aggregate. Tiled in world metres, so a
 *     joint every 3 m on every sidewalk. Generated once, deterministically (no Math.random: a rebuild
 *     never reshuffles the street), 256 px tiles.
 *   - Kerbs: a pale lip and a dark gutter where a sidewalk meets a road, so the edge of the street is
 *     drawn instead of implied.
 *   - Markings (centre lines, edge lines, zebra crossings, parking bays) are flat quads in ONE
 *     merged mesh drawn after the surfaces, again by order, never by depth.
 *
 * The ground gets a day emissive lift (the street faces away from a low sun, see GeoBatch's `lift`)
 * that fades at dusk (`setTod`), because a lit road under a sunset sky is the opposite of dusk.
 */
import * as THREE from 'three';
import { PAD, PAD_Y, SURFACES, CARS, type Surface } from '@keysrun/shared/world/town';

/** Metres per texture tile. */
const TILE = { road: 6, sidewalk: 3, lot: 5 } as const;

/** A deterministic hash-noise, so the same street comes out the same every build. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function tex(draw: (g: CanvasRenderingContext2D, n: number) => void, size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function speckle(g: CanvasRenderingContext2D, n: number, rnd: () => number, count: number, lo: number, hi: number, a: number): void {
  for (let i = 0; i < count; i++) {
    const v = lo + rnd() * (hi - lo);
    g.fillStyle = `rgba(${v},${v},${v},${a})`;
    g.fillRect(rnd() * n, rnd() * n, 1 + rnd() * 2, 1 + rnd() * 2);
  }
}

/** Sun-bleached asphalt: grey, not black. Patched seam, hairline cracks, an oil drip. */
function asphaltTexture(): THREE.CanvasTexture {
  return tex((g, n) => {
    const r = lcg(11);
    g.fillStyle = '#7b7f84'; g.fillRect(0, 0, n, n);
    speckle(g, n, r, 2600, 40, 70, 0.28);
    speckle(g, n, r, 1800, 150, 210, 0.2);
    // a tar-filled seam running across the tile, and the patch beside it
    g.strokeStyle = 'rgba(25,26,30,0.55)'; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(0, n * 0.34); g.bezierCurveTo(n * 0.3, n * 0.31, n * 0.6, n * 0.4, n, n * 0.36); g.stroke();
    // (a patched rectangle was drawn here first and repeated into an obvious checkerboard on a 12 m road: seams stay, blocks go)
    g.strokeStyle = 'rgba(25,26,30,0.3)'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(n * 0.52, 0); g.bezierCurveTo(n * 0.5, n * 0.3, n * 0.58, n * 0.6, n * 0.54, n); g.stroke();
    // hairline cracks
    g.strokeStyle = 'rgba(20,22,26,0.4)'; g.lineWidth = 0.9;
    for (let k = 0; k < 4; k++) {
      let x = r() * n, y = r() * n;
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0; s < 6; s++) { x += (r() - 0.4) * 22; y += (r() - 0.5) * 22; g.lineTo(x, y); }
      g.stroke();
    }
    // oil: a dark ellipse with a faint rainbow rim, where a car has sat for years
    const gr = g.createRadialGradient(n * 0.2, n * 0.78, 2, n * 0.2, n * 0.78, 26);
    gr.addColorStop(0, 'rgba(12,14,18,0.26)'); gr.addColorStop(1, 'rgba(12,14,18,0)');
    g.fillStyle = gr; g.fillRect(0, n * 0.55, n * 0.5, n * 0.45);
  });
}

/** Poured concrete in 3 m slabs: a joint each way, a stain, a dropped lollipop. */
function sidewalkTexture(): THREE.CanvasTexture {
  return tex((g, n) => {
    const r = lcg(23);
    g.fillStyle = '#d3cdbf'; g.fillRect(0, 0, n, n);
    speckle(g, n, r, 2200, 120, 170, 0.2);
    speckle(g, n, r, 1600, 225, 250, 0.22);
    // each slab a hair different
    g.fillStyle = 'rgba(0,0,0,0.035)'; g.fillRect(0, 0, n / 2, n); g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(n / 2, 0, n / 2, n * 0.5);
    // the joints (the tile wraps, so a joint on the edge is a joint on every edge)
    g.fillStyle = 'rgba(70,66,58,0.62)';
    g.fillRect(0, 0, n, 2); g.fillRect(0, 0, 2, n);
    g.fillStyle = 'rgba(255,250,240,0.25)'; g.fillRect(0, 2, n, 1); g.fillRect(2, 0, 1, n);
    // mid-slab control cut
    g.fillStyle = 'rgba(70,66,58,0.28)'; g.fillRect(0, n / 2, n, 1);
    // salt and damp: a stain near one corner, gum and a leaf
    const st = g.createRadialGradient(n * 0.7, n * 0.7, 3, n * 0.7, n * 0.7, 46);
    st.addColorStop(0, 'rgba(90,80,60,0.12)'); st.addColorStop(1, 'rgba(90,80,60,0)');
    g.fillStyle = st; g.fillRect(n * 0.4, n * 0.4, n * 0.6, n * 0.6);
    g.fillStyle = 'rgba(70,64,58,0.7)';
    for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(20 + r() * (n - 40), 20 + r() * (n - 40), 1.0 + r() * 1.0, 0, 7); g.fill(); }
  });
}

/** Back-lane and lot: oily patched asphalt gone to gravel at the edges. */
function lotTexture(): THREE.CanvasTexture {
  return tex((g, n) => {
    const r = lcg(37);
    g.fillStyle = '#85827a'; g.fillRect(0, 0, n, n);
    speckle(g, n, r, 3000, 50, 90, 0.3);
    speckle(g, n, r, 2400, 160, 215, 0.3);
    g.strokeStyle = 'rgba(25,26,30,0.4)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, n * 0.62); g.bezierCurveTo(n * 0.3, n * 0.58, n * 0.7, n * 0.67, n, n * 0.6); g.stroke();
    for (let i = 0; i < 4; i++) {
      const x = r() * n, y = r() * n, rad = 12 + r() * 14;
      const o = g.createRadialGradient(x, y, 1, x, y, rad);
      o.addColorStop(0, 'rgba(14,16,20,0.22)'); o.addColorStop(1, 'rgba(14,16,20,0)');
      g.fillStyle = o; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  });
}

export interface Ground {
  /** Surface decals (in order) then the kerbs and markings: add them all to the near group. */
  meshes: THREE.Mesh[];
  /** 0 = noon, 1 = dusk: fades the day emissive lift so the road does not glow under a sunset. */
  setTod(k: number): void;
  dispose(): void;
}

/** A flat quad on the pad with an explicit orientation-free rectangle, pushed into position/uv arrays. */
function rectInto(pos: number[], uv: number[], idx: number[], u0: number, u1: number, v0: number, v1: number, y: number, tile: number): void {
  const base = pos.length / 3;
  // local frame: x = u, z = -v. Wound so the normal is +y.
  const x0 = u0, x1 = u1, z0 = -v1, z1 = -v0;
  pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
  // UVs in world metres: a joint every 3 m on every sidewalk, whichever way it runs, and a seam never lines up with a surface edge by accident
  uv.push(x0 / tile, z0 / tile, x1 / tile, z0 / tile, x1 / tile, z1 / tile, x0 / tile, z1 / tile);
  idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

export function buildGround(): Ground {
  const textures = { road: asphaltTexture(), sidewalk: sidewalkTexture(), lot: lotTexture() };
  const mkMat = (map: THREE.Texture, lift: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({
    map, roughness: 0.95, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: lift,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const LIFT = { road: 0.34, sidewalk: 0.3, lot: 0.3 };
  const mats = { road: mkMat(textures.road, LIFT.road), sidewalk: mkMat(textures.sidewalk, LIFT.sidewalk), lot: mkMat(textures.lot, LIFT.lot) };
  const meshes: THREE.Mesh[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const make = (pos: number[], uv: number[], idx: number[]): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: pos.length }, (_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    geos.push(g);
    return g;
  };

  // 1. the surfaces, one decal each, drawn in SURFACES order
  const Y = PAD_Y + 0.02;
  SURFACES.forEach((s: Surface, i) => {
    if (s.kind === 'promenade') return; // real planks, built by build.ts
    const kind = s.kind as 'road' | 'sidewalk' | 'lot';
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    rectInto(pos, uv, idx, s.u0, s.u1, s.v0, s.v1, Y, TILE[kind]);
    const m = new THREE.Mesh(make(pos, uv, idx), mats[kind]);
    m.renderOrder = 1 + i; m.receiveShadow = true; m.name = `ground-${s.id}`;
    meshes.push(m);
  });

  // 2. kerbs and markings, flat quads in one flat-colour mesh drawn after every surface
  const mpos: number[] = [], mcol: number[] = [], midx: number[] = [], mnor: number[] = [];
  const col = new THREE.Color();
  const quad = (u0: number, u1: number, v0: number, v1: number, color: number, dy = 0): void => {
    const base = mpos.length / 3, y = PAD_Y + 0.03 + dy;
    mpos.push(u0, y, -v1, u1, y, -v1, u1, y, -v0, u0, y, -v0);
    col.setHex(color);
    for (let k = 0; k < 4; k++) { mcol.push(col.r, col.g, col.b); mnor.push(0, 1, 0); }
    midx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const WHITE = 0xe9e7df, YEL = 0xe3b92f, KERB = 0xd9d4c7, GUTTER = 0x55585d;
  const uline = (v: number, u0: number, u1: number, c: number, w = 0.14): void => quad(u0, u1, v - w / 2, v + w / 2, c, 0.002);
  const vline = (u: number, v0: number, v1: number, c: number, w = 0.14): void => quad(u - w / 2, u + w / 2, v0, v1, c, 0.002);

  // kerbs: a pale lip on the sidewalk side and a dark gutter on the road side, along every sidewalk/road boundary
  for (const [v, side] of [[40, -1], [84, 1], [96, -1]] as const) {
    // v is the boundary; `side` is which way the ROAD lies from it (+1 inland)
    quad(PAD.u0, PAD.u1, side > 0 ? v : v - 0.18, side > 0 ? v + 0.18 : v, KERB, 0.004);
    quad(PAD.u0, PAD.u1, side > 0 ? v - 0.42 : v + 0.18, side > 0 ? v : v + 0.6, GUTTER, 0.001);
  }
  for (const u of [-5, 5]) { quad(u - 0.09, u + 0.09, 46, 100, KERB, 0.004); }
  // Harbor Drive and Sombrero Boulevard: double yellow centre (broken at the avenue), white edge lines, zebra crossings
  for (const [vc, e0, e1] of [[34, 28.5, 39.5], [90, 84.5, 95.5]] as const) {
    uline(vc - 0.15, PAD.u0, -7.5, YEL); uline(vc + 0.15, PAD.u0, -7.5, YEL);
    uline(vc - 0.15, 7.5, PAD.u1, YEL); uline(vc + 0.15, 7.5, PAD.u1, YEL);
    uline(e0, PAD.u0, PAD.u1, WHITE); uline(e1, PAD.u0, PAD.u1, WHITE);
    for (let u = -6; u <= 6; u += 1.2) vline(u, e0 + 0.4, e1 - 0.4, WHITE, 0.55);
  }
  for (let v = 47; v < 94; v += 5) vline(0, v, v + 2.4, WHITE, 0.14);
  // the back lot's parking bays
  CARS.filter((c) => c.id.startsWith('bk-')).forEach((c) => { vline(c.u - 1.45, 130.4, 138, WHITE, 0.1); vline(c.u + 1.45, 130.4, 138, WHITE, 0.1); });
  // a faded handicap bay and a stop bar at each end of the avenue
  quad(-4.8, 4.8, 40.6, 41.1, WHITE, 0.003); quad(-4.8, 4.8, 83.6, 84.1, WHITE, 0.003);

  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.Float32BufferAttribute(mpos, 3));
  mg.setAttribute('normal', new THREE.Float32BufferAttribute(mnor, 3));
  mg.setAttribute('color', new THREE.Float32BufferAttribute(mcol, 3));
  mg.setIndex(midx);
  geos.push(mg);
  // Paint is unlit: lines under a low sun sink into the road otherwise (it is the same shade problem as the surfaces), and its
  // brightness follows the sky blend in `setTod` instead.
  const mmat = new THREE.MeshBasicMaterial({ vertexColors: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const mm = new THREE.Mesh(mg, mmat);
  mm.renderOrder = 1 + SURFACES.length + 1; mm.name = 'ground-markings';
  meshes.push(mm);

  return {
    meshes,
    setTod(k: number): void {
      const day = 1 - k;
      mats.road.emissiveIntensity = LIFT.road * day; mats.sidewalk.emissiveIntensity = LIFT.sidewalk * day; mats.lot.emissiveIntensity = LIFT.lot * day;
      const b = 0.92 - 0.55 * k;
      mmat.color.setRGB(b, b, b);
    },
    dispose(): void {
      geos.forEach((g) => g.dispose());
      Object.values(mats).forEach((m) => m.dispose());
      mmat.dispose();
      Object.values(textures).forEach((t) => t.dispose());
    },
  };
}
