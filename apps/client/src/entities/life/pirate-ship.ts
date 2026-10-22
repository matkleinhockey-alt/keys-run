/**
 * The pirates' boat: a tired wooden gaff-rigged sloop, built to look *wrong* next to the game's
 * eight fibreglass center consoles — which is the whole joke, so every choice below is the
 * opposite of what a Grady-White does.
 *
 * - **Hull**: the same lofting (`buildHullGeo`) the fibreglass boats use, fed a very different
 *   `HullSpec`: a deep keel and steep deadrise, a full round bow, a hard sheer spring and a long
 *   raked stem. Dark planks come from a canvas texture sampled in side projection (z,y) on top of
 *   the vertex colours, so the lofted geometry stays one cheap draw call and the seams still
 *   curve with the sheer. Reading as "wood" at 100 m was the bar; a flat brown hull read as a
 *   brown Grady.
 * - **Deck**: laid by hand from the same stations (`hullStation`) because `buildHullGeo`'s own
 *   `deck: true` cuts a fibreglass cockpit well, which is exactly the wrong silhouette.
 * - **Rig**: a mast, a gaff and a boom (so the sail is a four-sided gaff main, not the Bermudan
 *   triangle every ambient sailboat in traffic.ts has), a jib and a bowsprit, shrouds and stays
 *   from `beamBetween`. Sails are gridded and billowed, patched with off-colour panels, and have
 *   two cells knocked out so you can see sky through them.
 * - **No PointLight.** The lantern is an emissive mesh plus an additive halo sprite. A real light
 *   would change the scene's light count, which three.js compiles into every material (see
 *   party-boats.ts's `LIGHT_RANGE` for the measured cost of getting that wrong): the pirates are
 *   away 29 minutes in 30, and a light that exists only while they are here would recompile the
 *   whole world twice a visit.
 */
import * as THREE from 'three';
import { HULLS, type HullSpec } from '@keysrun/shared/content/boats';
import { beamBetween, buildHullGeo, hullStation, panelBetween, zRake } from '../boat/hull.js';
import { createHumanRegistry, type Human } from './human.js';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const NS = 28;

/** Hull length / beam, metres. 14.5 m is a real working gaff sloop; the biggest Grady-class
 * center console in the fleet is under 12. */
export const SHIP_L = 14.5;
export const SHIP_B = 4.4;

const SPEC: HullSpec = {
  ...HULLS.grady,
  F: 1.45, spring: 1.0, yk: 0.95, dr0: 40, dr1: 62, rake: 2.6, entry: 0.5, steps: [],
  // Brighter than "dark planking" reads on paper: the first pass (hull 0x5c4431) multiplied by the
  // grey plank texture and a low sun came out solid black in the browser, seams invisible.
  colors: {
    bottom: 0x3f4a38, boot: 0x4a3a28, hull: 0xb8905f, cove: 0xb8402f,
    rub: 0x3a2c1e, cap: 0x8a6a48, liner: 0x6a5238, deck: 0x8a7352,
  },
};

// ---------------------------------------------------------------- textures (canvas, cached)

let _planks: THREE.CanvasTexture | null | undefined;
let _roger: THREE.CanvasTexture | null | undefined;
let _halo: THREE.CanvasTexture | null | undefined;

function canvas2d(w: number, h: number): CanvasRenderingContext2D | null {
  try {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas') as HTMLCanvasElement;
    c.width = w; c.height = h;
    return typeof c.getContext === 'function' ? c.getContext('2d') : null;
  } catch { return null; }
}

/** Eight planks per tile: dark caulked seams, a couple of butt joints, and grain streaks so a
 * 14 m side of hull has something to look at. Mid-grey on purpose: it multiplies the vertex
 * colour, so the palette in `SPEC.colors` stays in charge. */
function plankTexture(): THREE.CanvasTexture | null {
  if (_planks !== undefined) return _planks;
  const ctx = canvas2d(256, 256);
  if (!ctx) return (_planks = null);
  let s = 7;
  const rnd = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let p = 0; p < 8; p++) {
    const y0 = p * 32, tone = 205 + Math.floor(rnd() * 45);
    ctx.fillStyle = `rgb(${tone},${tone - 6},${tone - 14})`;
    ctx.fillRect(0, y0, 256, 32);
    for (let g = 0; g < 14; g++) {
      ctx.fillStyle = `rgba(40,28,16,${0.05 + rnd() * 0.09})`;
      ctx.fillRect(rnd() * 256, y0 + 2 + rnd() * 28, 30 + rnd() * 120, 1);
    }
    ctx.fillStyle = 'rgba(14,9,5,0.85)';
    ctx.fillRect(0, y0, 256, 2.5);
    ctx.fillRect(Math.floor(rnd() * 240) + 4, y0, 2.5, 32); // butt joint
  }
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return (_planks = t);
}

/** Black flag, off-white skull and crossed bones, ragged fly edge cut out through alpha. */
function rogerTexture(): THREE.CanvasTexture | null {
  if (_roger !== undefined) return _roger;
  const ctx = canvas2d(192, 128);
  if (!ctx) return (_roger = null);
  ctx.clearRect(0, 0, 192, 128);
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(192, 0);
  // ragged, torn fly: a few irregular teeth
  const teeth: Array<[number, number]> = [[186, 14], [172, 30], [190, 44], [170, 62], [188, 80], [174, 98], [186, 114], [176, 128]];
  for (const [x, y] of teeth) ctx.lineTo(x, y);
  ctx.lineTo(0, 128); ctx.closePath();
  ctx.fillStyle = '#16140f'; ctx.fill();
  ctx.strokeStyle = '#e8e0c8'; ctx.fillStyle = '#e8e0c8'; ctx.lineCap = 'round';
  ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(48, 88); ctx.lineTo(128, 30); ctx.moveTo(128, 88); ctx.lineTo(48, 30); ctx.stroke();
  ctx.beginPath(); ctx.arc(88, 58, 24, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(76, 70, 24, 22);
  ctx.fillStyle = '#16140f';
  ctx.beginPath(); ctx.arc(79, 56, 6, 0, Math.PI * 2); ctx.arc(97, 56, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(86, 68, 4, 7);
  for (const x of [80, 86, 92]) ctx.fillRect(x, 80, 1.6, 10);
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return (_roger = t);
}

function haloTexture(): THREE.CanvasTexture | null {
  if (_halo !== undefined) return _halo;
  const ctx = canvas2d(64, 64);
  if (!ctx) return (_halo = null);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,214,130,1)'); g.addColorStop(0.25, 'rgba(255,170,70,0.55)'); g.addColorStop(1, 'rgba(255,140,40,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return (_halo = t);
}

// ---------------------------------------------------------------- sails

type P4 = readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];

interface Patch { u0: number; u1: number; v0: number; v1: number; color: number }

/**
 * A billowed four-sided sail. `c` is [tack, clew, peak, throat] (foot-forward, foot-aft, head-aft,
 * head-forward): bilinear in (u: luff to leech, v: foot to head), pushed out along +x by `belly`.
 * `holes` are (iu, iv) cells left out so the canvas is torn; `patches` are sub-rectangles laid
 * over the cloth a hair proud of it in other colours. Cloth strips alternate in tone along u the
 * way real panels do. One BufferGeometry, per-vertex colour, so the whole sail is one draw call.
 */
function sailGeo(c: P4, belly: number, nu: number, nv: number, holes: ReadonlyArray<readonly [number, number]>, patches: readonly Patch[], base: number): THREE.BufferGeometry {
  const [tack, clew, peak, throat] = c;
  const at = (u: number, v: number, lift = 0): THREE.Vector3 => {
    const foot = tack.clone().lerp(clew, u), head = throat.clone().lerp(peak, u);
    const p = foot.lerp(head, v);
    p.x += Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 1.05)) * belly + lift;
    return p;
  };
  const pos: number[] = [], col: number[] = [];
  const cc = new THREE.Color();
  const quad = (u0: number, u1: number, v0: number, v1: number, color: number, lift: number, shade = 1): void => {
    const a = at(u0, v0, lift), b = at(u1, v0, lift), d = at(u0, v1, lift), e = at(u1, v1, lift);
    cc.setHex(color).multiplyScalar(shade);
    pos.push(...a.toArray(), ...b.toArray(), ...e.toArray(), ...a.toArray(), ...e.toArray(), ...d.toArray());
    for (let i = 0; i < 6; i++) col.push(cc.r, cc.g, cc.b);
  };
  const isHole = (iu: number, iv: number): boolean => holes.some((h) => h[0] === iu && h[1] === iv);
  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) {
      if (isHole(iu, iv)) continue;
      quad(iu / nu, (iu + 1) / nu, iv / nv, (iv + 1) / nv, base, 0, iu % 2 ? 0.93 : 1.04);
    }
  }
  for (const p of patches) quad(p.u0, p.u1, p.v0, p.v1, p.color, 0.018);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- the ship

export interface PirateShip {
  group: THREE.Group;
  L: number;
  B: number;
  /** Deck height at a hull-local z, for placing things (and for the camera's idea of a deck). */
  deckAt(z: number): number;
  /**
   * Per-frame cosmetics, only called while the boat is within draw range.
   * `wind` is the wind *vector* in the boat's own frame (lx: toward starboard, lz: toward the
   * stern), `speedFrac` 0..1, `todK` the day/sunset blend, `waving` while someone is talking.
   * Returns the heel the hull should add to its roll.
   */
  animate(t: number, dt: number, wind: { lx: number; lz: number }, speedFrac: number, todK: number, waving: boolean, humansNear: boolean): number;
  /** Where the world-space name tag hangs, hull-local. */
  tagAnchor: THREE.Vector3;
  dispose(): void;
}

export function buildPirateShip(): PirateShip {
  const L = SHIP_L, B = SHIP_B;
  const g = new THREE.Group();
  g.name = 'pirateShip';
  const wood = (c: number, rough = 0.95): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: c, roughness: rough, flatShading: true });
  const plank = plankTexture();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const mat = <T extends THREE.Material>(m: T): T => { mats.push(m); return m; };

  // ---- hull, with side-projected plank UVs
  const hull = buildHullGeo(SPEC, L, B, { deck: false });
  {
    const p = hull.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getZ(i) / 6; uv[i * 2 + 1] = p.getY(i) / 2.64; }
    hull.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  geos.push(hull);
  g.add(new THREE.Mesh(hull, mat(new THREE.MeshStandardMaterial({ vertexColors: true, map: plank, roughness: 0.92, flatShading: true, side: THREE.DoubleSide, emissive: 0x4a3826, emissiveIntensity: 1 }))));

  // ---- deck, laid along the stations
  const st = Array.from({ length: NS + 1 }, (_, i) => hullStation(SPEC, L, B, i / NS));
  const deckY = (s: (typeof st)[number]): number => s.ys - 0.1;
  const deckAt = (z: number): number => {
    const t = Math.min(1, Math.max(0, (L / 2 - z) / (L - SPEC.rake * 0.5)));
    return hullStation(SPEC, L, B, t).ys - 0.1;
  };
  {
    const P: number[] = [], U: number[] = [];
    const vtx = (s: (typeof st)[number], sx: number): void => {
      const y = deckY(s), x = sx * (s.bs - 0.04), z = zRake(SPEC, s, y);
      P.push(x, y, z); U.push(z / 6, x / 2.64);
    };
    for (let i = 0; i < NS; i++) {
      const A = st[i], Z = st[i + 1];
      vtx(A, -1); vtx(A, 1); vtx(Z, 1);
      vtx(A, -1); vtx(Z, 1); vtx(Z, -1);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    dg.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    dg.computeVertexNormals();
    geos.push(dg);
    g.add(new THREE.Mesh(dg, mat(new THREE.MeshStandardMaterial({ color: 0xb59a6e, map: plank, roughness: 0.96, side: THREE.DoubleSide }))));
  }

  // ---- bulwarks and cap rail: short planked wall along the gunwale, both sides
  const wall = mat(wood(0x7a5c40));
  const capRail = mat(wood(0x4a3826));
  for (let i = 0; i < NS; i += 1) {
    const A = st[i], Z = st[i + 1];
    for (const sx of [-1, 1]) {
      const a = V(sx * A.bs, A.ys + 0.22, zRake(SPEC, A, A.ys)), b = V(sx * Z.bs, Z.ys + 0.22, zRake(SPEC, Z, Z.ys));
      g.add(panelBetween(a, b, 0.09, 0.46, wall));
      g.add(beamBetween(V(a.x, a.y + 0.24, a.z), V(b.x, b.y + 0.24, b.z), 0.05, capRail));
    }
  }

  // ---- stem, bowsprit, stern details
  const bowZ = zRake(SPEC, st[NS], st[NS].ys);
  const bowY = st[NS].ys;
  const spar = mat(wood(0x3a2a1c));
  const sprit = V(0, bowY + 0.85, bowZ - 3.3);
  g.add(beamBetween(V(0, bowY + 0.1, bowZ + 0.7), sprit, 0.1, spar));
  const stern = st[0], sternZ = zRake(SPEC, stern, stern.ys);
  g.add(beamBetween(V(0.1, deckAt(sternZ) + 0.5, sternZ - 0.4), V(0.45, deckAt(sternZ - 2.4) + 0.62, sternZ - 2.5), 0.045, mat(wood(0x2c2016)))); // tiller

  // ---- doghouse (cabin top), aft of the mast
  const mastZ = -2.2;
  const hz = 1.3;
  const dh = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.8, 3.3), mat(wood(0x7a5e42)));
  dh.position.set(0, deckAt(hz) + 0.4, hz); dh.castShadow = true; g.add(dh);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.1, 3.6), mat(wood(0x92704c)));
  roof.position.set(0, deckAt(hz) + 0.85, hz); roof.castShadow = true; g.add(roof);
  const glass = mat(new THREE.MeshStandardMaterial({ color: 0x14100a, roughness: 0.3 }));
  for (const sx of [-1, 1]) for (const dz of [-0.9, 0.9]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.55), glass);
    w.position.set(sx * 1.06, deckAt(hz) + 0.45, hz + dz); g.add(w);
  }
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.8), mat(wood(0x3a2a1c)));
  hatch.position.set(0, deckAt(-4) + 0.06, -4.4); g.add(hatch);

  // ---- mast, spreaders, standing rigging
  const rigMat = mat(new THREE.MeshStandardMaterial({ color: 0x1b140d, roughness: 1 }));
  const mastTop = 12.2;
  const dm = deckAt(mastZ);
  const mastM = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.15, mastTop, 10), spar);
  mastM.position.set(0, dm + mastTop / 2 - 0.2, mastZ); mastM.castShadow = true; g.add(mastM);
  const headY = dm + mastTop - 0.4;
  g.add(beamBetween(V(-1.05, dm + 6.4, mastZ), V(1.05, dm + 6.4, mastZ), 0.045, spar));
  for (const sx of [-1, 1]) {
    for (const dz of [-0.4, 0.5]) {
      const cs = st[Math.round((L / 2 - (mastZ + dz)) / (L - SPEC.rake * 0.5) * NS)];
      g.add(beamBetween(V(sx * 1.05, dm + 6.4, mastZ), V(sx * (cs.bs - 0.05), cs.ys + 0.3, mastZ + dz), 0.016, rigMat));
      g.add(beamBetween(V(sx * (cs.bs - 0.05), cs.ys + 0.3, mastZ + dz), V(sx * 0.06, headY - 0.3, mastZ), 0.014, rigMat));
    }
  }
  g.add(beamBetween(V(0, headY, mastZ), sprit, 0.02, rigMat));
  g.add(beamBetween(V(0, headY, mastZ), V(0, deckAt(sternZ - 0.3) + 0.5, sternZ - 0.3), 0.02, rigMat));

  // ---- the gaff main, on a group that swings about the mast
  const rig = new THREE.Group();
  rig.position.set(0, dm, mastZ);
  g.add(rig);
  const boomY = 1.65, boomLen = 7.4;
  rig.add(beamBetween(V(0, boomY, 0.12), V(0, boomY, boomLen), 0.07, spar));
  rig.add(beamBetween(V(0, 7.6, 0.1), V(0, 9.9, 4.8), 0.06, spar));
  rig.add(beamBetween(V(0, 7.6, 0.1), V(0, boomY + 0.2, boomLen - 0.2), 0.012, rigMat)); // topping lift-ish leech line
  const canvasTone = 0xd6c79c;
  const mainGeo = sailGeo(
    [V(0, boomY + 0.08, 0.2), V(0, boomY + 0.08, boomLen - 0.1), V(0, 9.8, 4.75), V(0, 7.55, 0.2)],
    0.55, 7, 6, [[5, 4], [1, 0]],
    [
      { u0: 0.14, u1: 0.4, v0: 0.12, v1: 0.34, color: 0x8a3b2c }, // rust-red patch, lower luff
      { u0: 0.58, u1: 0.8, v0: 0.46, v1: 0.66, color: 0x6c7a80 }, // grey sailcloth
      { u0: 0.3, u1: 0.5, v0: 0.62, v1: 0.84, color: 0x3d5f78 }, // faded blue (a former spinnaker, probably)
      { u0: 0.82, u1: 0.97, v0: 0.14, v1: 0.3, color: 0xb59a5c }, // tan
    ],
    canvasTone,
  );
  geos.push(mainGeo);
  // Emissive because canvas is translucent: backlit (the usual view of a sail, sun behind it) the
  // first pass came out olive and dead. A little self-light keeps it reading as old canvas.
  const sailMat = mat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide, emissive: 0x5a5038, emissiveIntensity: 0.55 }));
  const mainSail = new THREE.Mesh(mainGeo, sailMat);
  mainSail.castShadow = true;
  rig.add(mainSail);

  // ---- the jib, off the forestay (hull frame, not the boom's)
  const jibGeo = sailGeo(
    [V(0, bowY + 1.1, bowZ - 3.0), V(0, dm + 1.9, mastZ - 0.9), V(0, headY - 0.5, mastZ - 0.15), V(0, headY - 0.5, mastZ - 0.15)],
    0.4, 5, 6, [[3, 3]],
    [{ u0: 0.2, u1: 0.5, v0: 0.1, v1: 0.3, color: 0x7d6a4a }],
    0xc9bb92,
  );
  geos.push(jibGeo);
  const jib = new THREE.Mesh(jibGeo, sailMat);
  jib.castShadow = true;
  g.add(jib);

  // ---- Jolly Roger at the masthead, hinged so it streams downwind
  const flagPivot = new THREE.Group();
  flagPivot.position.set(0, headY + 0.1, mastZ);
  g.add(flagPivot);
  const rt = rogerTexture();
  const FW = 1.7, FH = 1.15, FSEG = 8;
  const flagGeo = new THREE.PlaneGeometry(FW, FH, FSEG, 3);
  flagGeo.translate(FW / 2, -FH / 2 + 0.05, 0);
  geos.push(flagGeo);
  const flagBase = Float32Array.from(flagGeo.attributes.position.array as ArrayLike<number>);
  const flag = new THREE.Mesh(flagGeo, mat(new THREE.MeshStandardMaterial({ color: rt ? 0xffffff : 0x16140f, map: rt, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 })));
  flagPivot.add(flag);

  // ---- lantern on a stern post: emissive mesh + additive halo, never a light
  const lanternPos = V(0.78, deckAt(sternZ - 0.7) + 1.35, sternZ - 0.7);
  g.add(beamBetween(V(lanternPos.x, deckAt(sternZ - 0.7), lanternPos.z), V(lanternPos.x, lanternPos.y - 0.18, lanternPos.z), 0.045, spar));
  const lanternMat = mat(new THREE.MeshStandardMaterial({ color: 0xffd48a, emissive: 0xffa43c, emissiveIntensity: 0.25, roughness: 0.4 }));
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.26, 8), lanternMat);
  lantern.position.copy(lanternPos); g.add(lantern);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.12, 8), mat(wood(0x15100a)));
  cap.position.set(lanternPos.x, lanternPos.y + 0.18, lanternPos.z); g.add(cap);
  let halo: THREE.Sprite | null = null;
  const ht = haloTexture();
  if (ht) {
    halo = new THREE.Sprite(mat(new THREE.SpriteMaterial({ map: ht, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 })));
    halo.scale.set(3.4, 3.4, 1);
    halo.position.copy(lanternPos);
    halo.visible = false;
    g.add(halo);
  }

  // ---- crew: captain on the tiller, mate on the rail doing the waving
  const humans = createHumanRegistry();
  const captain: Human = humans.makeHuman({ shirt: 0x8a2a2a, shorts: 0x23201c, shortsLong: true, hair: 0x2a1d14, skin: 0xb98462, shoes: 0x15100a });
  const cz = sternZ - 1.5;
  captain.group.position.set(0.35, deckAt(cz), cz);
  captain.group.rotation.y = Math.PI;
  captain.pose(V(-0.15, 0.95, 0.34), V(0.2, 0.98, 0.32));
  g.add(captain.group);
  {
    const hatM = mat(wood(0x15120d, 0.8));
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.085, 12), hatM);
    crown.position.set(0, 0.095, 0);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.022, 3), hatM);
    brim.position.set(0, 0.052, 0.01); brim.rotation.y = Math.PI;
    const patch = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.012), hatM);
    patch.position.set(0.037, 0.024, 0.098);
    const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.1135, 0.1135, 0.012, 18), hatM);
    strap.position.set(0, 0.03, 0); strap.rotation.z = 0.28;
    captain.head.add(crown, brim, patch, strap);
  }
  const mate: Human = humans.makeHuman({ shirt: 0xcfc6a8, shorts: 0x3b4a5a, shortsLong: true, cap: 0x8a2a2a, hair: 0x6b4a2a, shoes: 0x15100a });
  const mz = -0.4;
  const mateCs = st[Math.round((L / 2 - mz) / (L - SPEC.rake * 0.5) * NS)];
  mate.group.position.set(mateCs.bs - 0.55, deckAt(mz), mz);
  mate.group.rotation.y = Math.PI / 2; // facing starboard, i.e. at whoever is alongside
  g.add(mate.group);
  const armIdle = [V(-0.2, 1.02, 0.12), V(0.22, 1.0, 0.18)] as const;
  mate.pose(armIdle[0], armIdle[1]);
  // a parrot, because there was always going to be a parrot
  {
    const bird = new THREE.Group();
    const red = mat(new THREE.MeshStandardMaterial({ color: 0xc8302e, roughness: 0.7 }));
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), red); body.scale.set(0.8, 1.2, 0.9);
    const wing = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), mat(new THREE.MeshStandardMaterial({ color: 0x2b6fb0, roughness: 0.7 }))); wing.scale.set(0.35, 1.1, 0.8); wing.position.set(0.07, -0.02, 0.02);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 6), mat(new THREE.MeshStandardMaterial({ color: 0xf2c14e }))); beak.rotation.x = Math.PI / 2; beak.position.set(0, 0.07, -0.1);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.22), red); tail.position.set(0, -0.12, 0.12); tail.rotation.x = -0.5;
    bird.add(body, wing, beak, tail);
    bird.position.set(-0.78, deckAt(sternZ - 1) + 0.95, sternZ - 1.1);
    g.add(bird);
  }

  g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });

  // ---------------------------------------------------------------- animation
  let boom = 0.2;
  let belly = 1;

  function animate(t: number, dt: number, wind: { lx: number; lz: number }, speedFrac: number, todK: number, waving: boolean, humansNear: boolean): number {
    const wm = Math.hypot(wind.lx, wind.lz) || 1;
    const lx = wind.lx / wm, lz = wind.lz / wm;
    // Boom out on the side the wind is blowing toward; swung wide when it is behind us, hauled in
    // when it is ahead. The sign flip at lx ~ 0 is a gybe and is allowed to look like one.
    const side = lx >= 0 ? 1 : -1;
    const sheet = 0.12 + 1.15 * (0.5 + 0.5 * lz);
    const target = side * sheet + Math.sin(t * 0.7) * 0.025;
    boom += (target - boom) * Math.min(1, dt * 0.9);
    rig.rotation.y = boom;
    const bs = boom >= 0 ? 1 : -1;
    belly += (bs - belly) * Math.min(1, dt * 2);
    rig.scale.x = Math.abs(belly) < 0.15 ? 0.15 : belly;
    jib.scale.x = bs;

    // Flag: points downwind in the hull frame, flutters along its length.
    flagPivot.rotation.y = Math.atan2(-lz, lx);
    const pa = flagGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      const x = flagBase[i * 3], y = flagBase[i * 3 + 1];
      const k = x / FW;
      pa.setZ(i, Math.sin(t * 7.5 - x * 5.2 + y * 1.5) * 0.11 * k + Math.sin(t * 3.1 - x * 2) * 0.05 * k);
      pa.setY(i, y - Math.sin(t * 5 - x * 4) * 0.025 * k);
    }
    pa.needsUpdate = true;

    // Lantern: dim in daylight, properly lit toward sunset, with a slow flicker.
    const night = Math.min(1, Math.max(0, (todK - 0.1) / 0.5));
    const flick = 1 + Math.sin(t * 9.1) * 0.05 + Math.sin(t * 23.3) * 0.03;
    lanternMat.emissiveIntensity = (0.25 + 2.4 * night) * flick;
    if (halo) {
      halo.visible = night > 0.05;
      (halo.material as THREE.SpriteMaterial).opacity = Math.min(0.85, night * 0.85) * flick;
    }

    if (humansNear) {
      humans.updateHumans(t, { x: g.position.x, y: g.position.y, z: g.position.z }, speedFrac * 6);
      const wv = waving ? 1 : 0;
      mate.pose(armIdle[0], V(0.28 + wv * 0.1, 1.0 + wv * (0.78 + Math.sin(t * 7) * 0.1), 0.12 + wv * 0.08 + Math.sin(t * 7) * wv * 0.1));
    }
    // Heel away from the wind, more with way on.
    return -lx * 0.14 * (0.35 + 0.65 * speedFrac);
  }

  return {
    group: g, L, B, deckAt, animate,
    tagAnchor: V(0, headY + 1.2, mastZ),
    dispose(): void {
      for (const x of geos) x.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
