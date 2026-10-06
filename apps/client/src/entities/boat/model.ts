/**
 * `makeBoat`: builds the full visual model for one of the 5 playable center consoles — hull,
 * console, top/tower, seating, bow, rails, outboards, electronics mounts, lights, flags,
 * cooler, speakers, cabin lighting, rod holders, boat-name lettering, and (deck-mount points
 * owned by `entities/life/**`) the captain, bikini-clad crew, the Freeman's shower person, the
 * Midnight Express's dance-pole person, and the walking/dancing deck party.
 *
 * Ported faithfully from legacy/index.html:1395-1654, including the humans — this used to stand
 * them in with a zero-geometry `makeHumanStub` (docs/ARCHITECTURE.md Phase 0 scope listed
 * "humans"/"deck party" separately from the boat itself); that phase boundary is gone, so this
 * now calls the real `entities/life/human.ts` `makeHuman` and builds the `party`/`pole`/`shower`
 * descriptors `entities/life/deck-party.ts` animates every frame.
 *
 * Multiplayer scaling fix (docs/ARCHITECTURE.md's Art-direction hazards list: "`makeBoat`
 * creating fresh materials per call — every joining player instantiates one — this will not
 * scale past a handful of peers"; task brief: "Cache and share materials/geometry across boat
 * instances."). Every colour/option combination `M()` is called with, plus the big shared
 * `hullMat` and the hull loft geometry itself (`buildHullGeo` — the most expensive geometry in
 * the model, ~36 lofted stations), now goes through the module-level `sharedMaterial`/
 * `sharedGeometry` caches below, keyed by the actual parameters (materials) or by boat id
 * (geometry, since hull shape genuinely differs per boat). Calling `makeBoat()` N times for the
 * same boat type — the net-client's remote-boat renderer does exactly this, once per peer —
 * now allocates N groups of *meshes* (cheap) referencing a handful of *shared* materials/
 * geometries (the actual GPU/shader-compile cost), instead of N independent copies of both.
 * Small per-part prop geometries (seats, rails, rod holders, …) are left uncached — the doc's
 * own wording is about materials, and those are comparatively cheap CPU-side buffers, not a
 * shader recompile; see this project's report for the exact scope of this fix.
 */
import * as THREE from 'three';
import type { Boat, HullSpec, HullStyle } from '@keysrun/shared/content/boats';
import {
  hullStation, zRake, sstep, buildHullGeo, beamBetween, panelBetween, roundRectShape, makeOutboard,
  type HullStation as Station,
} from './hull.js';
import { addHelmDisplay, addScreens } from './electronics.js';
import { usFlagTex, jollyRogerTex, makeFlag, glowTex, quiltTex, type Flag } from './decor-textures.js';
import { lerp, rand } from '../../core/math.js';
import { normalTex, grainTex } from '../../core/textures.js';
import type { LightMatEntry } from '../../core/time-of-day.js';
import { makeHuman, type Human } from '../life/human.js';
import { createPath } from '../life/path.js';
import type { PartyMember, PoleRig, ShowerRig } from '../life/deck-party.js';

/** legacy `m.leds` entry (index.html:1588): the pod ring's own colour-managed material, exposed
 * through this tiny structural shape — matching `audio/music/radio.ts`'s `SpeakerSink.leds` —
 * rather than handing out the raw `THREE.MeshBasicMaterial` so this module stays the only thing
 * that knows how an LED ring is actually drawn. */
export interface LedHandle { base: { r: number; g: number; b: number }; setColor(r: number, g: number, b: number): void }

// --- shared material/geometry caches (see the multiplayer-scaling-fix doc comment above) ------
const sharedMaterials = new Map<string, THREE.Material>();
function sharedMaterial<T extends THREE.Material>(key: string, factory: () => T): T {
  const existing = sharedMaterials.get(key);
  if (existing) return existing as T;
  const made = factory();
  sharedMaterials.set(key, made);
  return made;
}

const sharedGeometries = new Map<string, THREE.BufferGeometry>();
function sharedGeometry<T extends THREE.BufferGeometry>(key: string, factory: () => T): T {
  const existing = sharedGeometries.get(key);
  if (existing) return existing as T;
  const made = factory();
  sharedGeometries.set(key, made);
  return made;
}

/** `deps.lightMats` is appended to by every `makeBoat()` call (for day/night opacity crossfade —
 * see time-of-day.ts). Once a material is shared across many boat instances, pushing it again on
 * every call would grow that list once per *instance* instead of once per *distinct material*;
 * this guard keeps it one entry per material regardless of how many boats reference it. */
function pushLightMatOnce(deps: BoatBuildDeps, entry: LightMatEntry): void {
  if (!deps.lightMats.some((e) => e.m === entry.m)) deps.lightMats.push(entry);
}

/** Hoisted out of `makeBoat` (it closed over nothing boat-specific) so every call — including
 * one for a different boat instance of the *same* type — resolves to the same cached material
 * instead of allocating a fresh `MeshStandardMaterial` per call. */
const M = (c: number, o?: Partial<THREE.MeshStandardMaterialParameters>): THREE.MeshStandardMaterial =>
  sharedMaterial(`M:${c}:${o ? JSON.stringify(o) : ''}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, flatShading: true, ...o }));

export interface BoatBuildDeps {
  lightMats: LightMatEntry[];
  todK: number;
  mfdTex: THREE.Texture;
  gpsTex: THREE.Texture;
  sonTex: THREE.Texture;
}

export interface Tower { pos: THREE.Vector3; wheel: THREE.Mesh }

export interface BoatModel {
  group: THREE.Group;
  deckY: number;
  props: THREE.Group[];
  helmPos: THREE.Vector3;
  /** legacy `helmPose` (index.html:1530): the captain's resting two-hand-on-the-wheel pose,
   * reused by `entities/life/luigi.ts` for the one-hand-up beer pose's other (wheel) hand. */
  helmPose: [THREE.Vector3, THREE.Vector3];
  fishSpot: THREE.Vector3;
  soleAt(z: number): number;
  wheel: THREE.Mesh;
  tower: Tower | null;
  outboards: THREE.Group[];
  lights: THREE.Group | null;
  flags: Flag[];
  /** Dark-blue cockpit mood lighting (legacy's `m.cabin`/`cabinLight`/`cabinLight2`), dimmed in
   * from TOD.k>0.5 (sunset) — see legacy/index.html:3289 and entities/boat/visuals.ts. */
  cabin: THREE.Group;
  cabinLight: THREE.PointLight;
  cabinLight2: THREE.PointLight;
  /**
   * Rod/fishing-station rig (legacy `boat.model.rodPivot`/`.tip`/`.stations`/`.station`/
   * `.fishSpot`/`.captain`) — geometry already existed in Phase 0b but was inert (nothing ever
   * set `rodPivot.visible`). Wired up by game/fishing (Keys Run fishing port), see
   * docs/ARCHITECTURE.md "Rod fishing, server-authoritative".
   */
  rodPivot: THREE.Group;
  rodTip: THREE.Object3D;
  stations: Array<{ pos: THREE.Vector3; out: THREE.Vector3; spot: THREE.Vector3 }>;
  /** Mutable: which station (index into `stations`) the angler is currently fishing from. */
  station: number;
  captain: Human;
  /** legacy `crew` (index.html:1533-1536): the bikini-clad passenger lounging/seated near the
   * bow or sunpad. */
  crew: Human;
  /** legacy `party` (index.html:1646-1650): the deck party, empty on boats too small for one
   * (legacy still builds 3-5 on every hull; kept as-is for fidelity). Animated by
   * `entities/life/deck-party.ts`'s `updateParty`. */
  party: PartyMember[];
  /** legacy `pole` (index.html:1619-1624): the Midnight Express's dance pole, `null` on every
   * other boat. */
  pole: PoleRig | null;
  /** legacy `shower` (index.html:1609-1617): the Freeman's pull-down shower, `null` on every
   * other boat. */
  shower: ShowerRig | null;
  /** legacy `leds` (index.html:1583-1591): the speaker pods' LED rings, pulsed on the music's
   * beat level by `audio/music/radio.ts`'s `MusicController.update` via `SpeakerSink.leds`. */
  leds: LedHandle[];
  /** legacy `uwLights` (index.html:1544): the subset of underwater lights whose intensity rides
   * the day/sunset blend (updated by `entities/life/deck-party.ts`'s `updatePole`, which also
   * carries legacy's same-call cabin-light TOD boost — see that module's `DeckLifeDeps.todK`). */
  uwLights: THREE.PointLight[];
  /** legacy `speakerPos` (index.html:1651): local-space mount point the radio HRTF panner tracks
   * (`audio/music/radio.ts`'s `SpeakerSink.position`). */
  speakerPos: THREE.Vector3;
}

export function makeBoat(S: Boat, deps: BoatBuildDeps): BoatModel {
  const H = S.hp, st = H.style, L = S.len, B = S.beam;
  const g = new THREE.Group();
  const props: THREE.Group[] = [];
  const add = <T extends THREE.Object3D>(m: T, x?: number, y?: number, z?: number): T => {
    if (x !== undefined) m.position.set(x, y ?? 0, z ?? 0);
    if (m instanceof THREE.Mesh) { m.castShadow = true; m.receiveShadow = true; }
    g.add(m);
    return m;
  };
  const box = (w: number, h: number, d: number, c: number, x: number, y: number, z: number, o?: Partial<THREE.MeshStandardMaterialParameters>) =>
    add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(c, o)), x, y, z);

  // Part 2 item 6 ("Materials"): the hull was flat vertex-colour with no texture at all — a
  // procedural gelcoat micro-bump + roughness grain (same noise field world/water.ts's ripples use)
  // reads as a real painted/moulded surface under the CSM-lit sun instead of a uniform plastic flat.
  // This material's parameters (roughness/normalMap/roughnessMap) don't vary by boat id at all —
  // the actual per-boat colour comes from the geometry's baked vertex colours — so it's one true
  // singleton shared by every boat on the client, built (and its procedural textures generated)
  // only once ever, not once per instance.
  const hullMat = sharedMaterial('hullMat', () => new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.28, metalness: 0.08, side: THREE.DoubleSide,
    normalMap: normalTex([6, 18], 0.7), normalScale: new THREE.Vector2(0.12, 0.12),
    roughnessMap: grainTex([6, 18], 0.75, 1.05),
  }));
  // Hull loft geometry (buildHullGeo) depends only on the boat's HullSpec/L/B, so it's cached per
  // boat id (+ sub-part, for the catamaran's two sponsons + upper deck) — every instance of the
  // same boat type shares one geometry instead of re-lofting ~36 stations per joining player.
  if (H.cat) {
    const Bs = B * 0.33;
    const Hs: HullSpec = { ...H, F: H.tunnel! + 0.2, spring: 0, entry: 0.55, dr0: H.dr0 + 4, dr1: H.dr1 };
    const Hu: HullSpec = { ...H, yk: -H.tunnel!, dr0: 0, dr1: 0, steps: [], entry: 0.5 };
    for (const sx of [-1, 1]) {
      const geo = sharedGeometry(`hull:${S.id}:sponson:${sx}`, () => buildHullGeo(Hs, L * 0.99, Bs, { xo: sx * (B / 2 - Bs / 2) }));
      add(new THREE.Mesh(geo, hullMat));
    }
    const upperGeo = sharedGeometry(`hull:${S.id}:upper`, () => buildHullGeo(Hu, L, B, { deck: true }));
    add(new THREE.Mesh(upperGeo, hullMat));
  } else {
    const geo = sharedGeometry(`hull:${S.id}:main`, () => buildHullGeo(H, L, B, { deck: true }));
    add(new THREE.Mesh(geo, hullMat));
  }

  const D = 0.55 + L * 0.012, cap = 0.14 + B * 0.02;
  const stAt = (z: number): Station => hullStation(H, L, B, Math.max(0, Math.min(1, (L / 2 - z) / (L - H.rake * 0.5))));
  const soleAt = (z: number): number => { const s = stAt(z); return s.ys - D * (1 - 0.4 * sstep(0.55, 0.85, s.t)); };

  // console with angled dash
  const cz = L * (L > 11 ? -0.01 : 0.03), cw = B * 0.42, cl = L * 0.13, ch = 1.12, cs = soleAt(cz);
  const sh = new THREE.Shape();
  sh.moveTo(cl / 2, 0); sh.lineTo(cl / 2, ch * 0.72); sh.lineTo(-cl * 0.05, ch); sh.lineTo(-cl / 2, ch); sh.lineTo(-cl / 2 * 0.92, 0); sh.lineTo(cl / 2, 0);
  const cg = new THREE.ExtrudeGeometry(sh, { depth: cw, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1 });
  cg.rotateY(-Math.PI / 2); cg.translate(cw / 2, 0, 0);
  add(new THREE.Mesh(cg, M(H.colors.liner, { roughness: 0.3 })), 0, cs, cz);
  const dark = M(0x0e1114, { roughness: 0.15, metalness: 0.4 });
  g.add(panelBetween(new THREE.Vector3(0, cs + ch * 0.72 + 0.02, cz + cl / 2 + 0.035), new THREE.Vector3(0, cs + ch + 0.02, cz - cl * 0.05 + 0.03), cw * 0.86, 0.03, dark));
  const helmWheel = add(new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.025, 6, 18), M(0x1a1c20)), cw * 0.18, cs + ch * 0.78, cz + cl / 2 + 0.12);
  helmWheel.rotation.x = -0.55;

  // glass helm: one big display standing on the dash, leaned back toward the driver
  {
    const w = Math.max(0.7, cw * 0.96), h = w * 256 / 640, lean = 0.5, f = 0.18;
    const bz = cz + cl / 2 - f * cl * 0.55, by = cs + ch * (0.72 + 0.28 * f) + 0.02;
    const ctr = new THREE.Vector3(0, by + Math.cos(lean) * h / 2, bz - Math.sin(lean) * h / 2);
    const nrm = new THREE.Vector3(0, Math.sin(lean), Math.cos(lean));
    const pod = addHelmDisplay(g, ctr, ctr.clone().add(nrm), w, deps.mfdTex);
    const hous = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.09), M(H.colors.liner, { roughness: 0.3 }));
    hous.position.z = -0.07;
    pod.add(hous);
  }
  box(0.08, 0.18, 0.1, 0x22262b, -cw * 0.2, cs + ch * 0.78, cz + cl / 2 + 0.08);
  if (st.seat === 'leaning' || st.top === 'ttop') {
    box(cw * 0.85, 0.14, 0.42, st.uph, 0, cs + 0.45, cz - cl / 2 - 0.24);
    box(cw * 0.85, 0.42, 0.1, st.uph, 0, cs + 0.75, cz - cl / 2 - 0.05);
  }

  // top: hardtop or T-top with tube frame
  const TH = 2.15 + L * 0.01, topY = cs + TH, tz = cz + L * 0.02, tl = L * (st.wideTop ? 0.31 : 0.27), tw = B * (st.wideTop ? 0.88 : 0.74);
  const tg = new THREE.ExtrudeGeometry(roundRectShape(tw, tl, 0.25, 0.86), { depth: st.top === 'hardtop' ? 0.11 : 0.05, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2, curveSegments: 6 });
  tg.rotateX(-Math.PI / 2);
  add(new THREE.Mesh(tg, M(st.topc, { roughness: 0.35 })), 0, topY, tz);
  const frame = M(st.frame, { metalness: 0.6, roughness: 0.25, flatShading: false });
  const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const legs: Array<[number, number, number, number]> = [[cw / 2 + 0.05, cz - cl * 0.25, tw * 0.4, tz - tl * 0.38], [cw / 2 + 0.3, cz + cl / 2 + 0.95, tw * 0.4, tz + tl * 0.4]];
  for (const sx of [-1, 1]) for (const [bx, bz, ux, uz] of legs) g.add(beamBetween(V3(sx * bx, cs, bz), V3(sx * ux, topY, uz), 0.042, frame));
  for (const sx of [-1, 1]) g.add(beamBetween(V3(sx * tw * 0.4, topY - 0.02, tz - tl * 0.38), V3(sx * tw * 0.4, topY - 0.02, tz + tl * 0.4), 0.035, frame));
  const glass = sharedMaterial('glass', () => new THREE.MeshStandardMaterial({ color: 0x6f97a8, transparent: true, opacity: 0.38, roughness: 0.05, metalness: 0.3 }));
  if (st.top === 'hardtop') {
    const ws = panelBetween(V3(0, cs + ch + 0.02, cz - cl / 2 + 0.04), V3(0, topY - 0.04, tz - tl / 2 + 0.18), st.enclosed ? tw * 0.82 : cw * 1.25, 0.025, glass);
    ws.castShadow = false; g.add(ws);
  }
  if (st.enclosed) {
    const blk = M(0x111316, { roughness: 0.3 });
    for (const sx of [-1, 1]) {
      const sg = panelBetween(V3(sx * tw * 0.42, cs + ch * 0.75, cz - cl * 0.3), V3(sx * tw * 0.43, topY - 0.06, tz - tl * 0.12), 0.02, cl * 1.5, glass);
      sg.castShadow = false; g.add(sg);
      g.add(panelBetween(V3(sx * tw * 0.41, cs + ch + 0.02, cz - cl / 2 + 0.04), V3(sx * tw * 0.41, topY - 0.04, tz - tl / 2 + 0.18), 0.05, 0.05, blk));
    }
    box(tw * 0.93, 0.13, 0.07, 0x111316, 0, topY - 0.03, tz - tl / 2 + 0.05);
    for (const sx of [-1, 1]) box(0.07, 0.13, tl * 0.96, 0x111316, sx * tw * 0.46, topY - 0.03, tz);
    box(tw * 0.82, 0.05, 0.06, 0x111316, 0, cs + ch + 0.04, cz - cl / 2 + 0.02);
  }
  if (st.rodRack) {
    const rodM = M(0x2a2d31, { flatShading: false }), reelM = M(0xc9a227, { metalness: 0.7, roughness: 0.2 });
    for (let i = 0; i < 8; i++) {
      const x = (i - 3.5) * tw * 0.105;
      g.add(beamBetween(V3(x, topY - 0.02, tz + tl / 2 - 0.08), V3(x, topY + 0.32, tz + tl / 2 + 0.06), 0.03, M(0x15171a)));
      g.add(beamBetween(V3(x, topY + 0.1, tz + tl / 2), V3(x, topY + 2.5, tz + tl / 2 + 0.95), 0.013, rodM));
      const r = add(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.07, 10), reelM), x, topY + 0.3, tz + tl / 2 + 0.12);
      r.rotation.z = Math.PI / 2;
    }
  }
  if (st.dome) {
    const dm = add(new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), M(0xf7f7f5, { roughness: 0.25, flatShading: false })), 0, topY + 0.12, tz + tl * 0.1);
    dm.scale.set(1, 0.75, 1);
  } else {
    const ws = panelBetween(V3(0, cs + ch, cz - cl / 2 + 0.06), V3(0, cs + ch + 0.5, cz - cl * 0.15), cw * 1.05, 0.025, glass);
    ws.castShadow = false; g.add(ws);
  }
  for (const sx of [-1, 1]) g.add(beamBetween(V3(sx * tw * 0.32, topY + 0.12, tz + tl * 0.3), V3(sx * tw * 0.32, topY + 2.4, tz + tl * 0.3 + 0.9), 0.022, M(0xf4f4f4)));
  if (st.radar) { box(0.18, 0.18, 0.18, 0xe9e9e9, 0, topY + 0.22, tz); box(1.3, 0.1, 0.16, 0xf2f2f2, 0, topY + 0.36, tz); }
  if (st.outriggers && !st.bigTower) for (const sx of [-1, 1]) g.add(beamBetween(V3(sx * tw * 0.45, topY + 0.08, tz), V3(sx * (tw * 0.45 + 0.9), topY + 4.6, tz + 2.2), 0.028, frame));

  // tuna tower with an upper helm on the offshore fishing boats
  let tower: Tower | null = null;
  if (S.id === 'freeman' || S.id === 'grady') {
    const tY = topY + (st.bigTower ? 3.3 : 2.5), w2 = Math.min(1.15, tw * 0.5), l2 = 1.05, fr = frame;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(beamBetween(V3(sx * tw * 0.38, topY + 0.08, tz + sz * tl * 0.36), V3(sx * w2 * 0.5, tY, tz + sz * l2 * 0.45), 0.04, fr));
    box(w2 + 0.12, 0.06, l2 + 0.12, st.topc, 0, tY, tz);
    for (const sx of [-1, 1]) {
      g.add(beamBetween(V3(sx * w2 * 0.55, tY + 0.9, tz - l2 * 0.5), V3(sx * w2 * 0.55, tY + 0.9, tz + l2 * 0.5), 0.025, fr));
      for (const sz of [-1, 1]) g.add(beamBetween(V3(sx * w2 * 0.55, tY, tz + sz * l2 * 0.5), V3(sx * w2 * 0.55, tY + 0.9, tz + sz * l2 * 0.5), 0.025, fr));
    }
    g.add(beamBetween(V3(-w2 * 0.55, tY + 0.9, tz - l2 * 0.5), V3(w2 * 0.55, tY + 0.9, tz - l2 * 0.5), 0.025, fr));
    box(0.56, 0.72, 0.3, H.colors.liner, 0, tY + 0.39, tz - l2 * 0.3);
    g.add(panelBetween(V3(0, tY + 0.68, tz - l2 * 0.3 + 0.15), V3(0, tY + 0.78, tz - l2 * 0.3 - 0.05), 0.46, 0.02, M(0x0e1114, { roughness: 0.15, metalness: 0.4 })));
    const tw3 = add(new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.022, 6, 18), M(0x1a1c20)), 0, tY + 0.82, tz - l2 * 0.3 + 0.24);
    tw3.rotation.x = -0.6;
    box(0.6, 0.16, 0.3, st.uph, 0, tY + 0.78, tz + l2 * 0.3);
    box(0.6, 0.4, 0.08, st.uph, 0, tY + 1.02, tz + l2 * 0.45);
    box(w2 + 0.4, 0.05, l2 + 0.5, st.topc, 0, tY + 2.05, tz);
    if (st.bigTower) {
      const wht = M(0xf2f2f2, { metalness: 0.5, roughness: 0.25, flatShading: false });
      box(w2 + 0.42, 0.12, 0.06, 0x111316, 0, tY + 1.98, tz - (l2 + 0.5) / 2);
      box(w2 + 0.42, 0.05, l2 + 0.52, 0x111316, 0, tY + 2.0, tz);
      g.add(beamBetween(V3(-w2 * 0.55, tY - 1.3, tz - l2 * 0.45), V3(w2 * 0.55, tY - 1.3, tz - l2 * 0.45), 0.03, fr));
      box(w2 * 1.1, 0.18, 0.12, 0xf2f2f2, 0, tY - 1.35, tz - l2 * 0.45);
      const dm2 = add(new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M(0xf7f7f5, { roughness: 0.25, flatShading: false })), 0, tY + 2.08, tz);
      dm2.scale.set(1, 0.7, 1);
      for (const sx of [-1, 1]) {
        g.add(beamBetween(V3(sx * w2 * 0.5, tY - 1.6, tz + 0.1), V3(sx * (w2 * 0.5 + 1.6), tY + 7.2, tz + 2.6), 0.045, wht));
        g.add(beamBetween(V3(sx * w2 * 0.52, tY - 1.6, tz + 0.1), V3(sx * w2 * 0.52, tY - 0.6, tz + 0.1), 0.07, wht));
        g.add(beamBetween(V3(sx * tw * 0.3, topY + 0.12, tz + tl * 0.42), V3(sx * tw * 0.3, topY + 5.4, tz + tl * 0.42 + 0.4), 0.025, M(0xf4f4f4)));
      }
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(beamBetween(V3(sx * w2 * 0.5, tY, tz + sz * l2 * 0.45), V3(sx * (w2 * 0.5 + 0.1), tY + 2.03, tz + sz * (l2 * 0.5 + 0.15)), 0.025, fr));
    for (let k = 1; k < 6; k++) {
      const y = topY + k * 0.42, zz = tz + tl * 0.36 + (l2 * 0.45 - tl * 0.36) * k / 6, xx = lerp(tw * 0.38, w2 * 0.5, k / 6);
      g.add(beamBetween(V3(-xx, y, zz), V3(xx, y, zz), 0.02, fr));
    }
    addScreens(g, V3(0, tY + 0.9, tz - l2 * 0.3 + 0.05), V3(0, tY + 1.65, tz + l2 * 0.12), 0.27, deps.gpsTex, deps.sonTex);
    tower = { pos: V3(0, tY + 0.03, tz + l2 * 0.12), wheel: tw3 };
  }

  // seating
  const pz = cz + cl / 2 + 0.72, ps = soleAt(pz);
  if (st.seat === 'leaning') {
    box(B * 0.38, 0.82, 0.58, H.colors.liner, 0, ps + 0.41, pz);
    box(B * 0.4, 0.2, 0.36, st.uph, 0, ps + 0.92, pz - 0.05);
    const br = box(B * 0.38, 0.36, 0.09, st.uph, 0, ps + 1.22, pz + 0.26);
    br.rotation.x = 0.12;
    const rodM = M(0x2a2d31, { flatShading: false }), reelM = M(0xc9a227, { metalness: 0.7, roughness: 0.2 });
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * B * 0.085;
      g.add(beamBetween(V3(x, ps + 1.1, pz + 0.3), V3(x, ps + 3.4, pz + 1.05), 0.014, rodM));
      const r = add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 10), reelM), x, ps + 1.25, pz + 0.36);
      r.rotation.z = Math.PI / 2;
    }
    box(B * 0.3, 0.45, 0.48, 0xf4f4f2, 0, ps + 0.23, pz + 0.62);
  } else {
    const n = st.rodRack ? 4 : B > 3.6 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * 0.64;
      box(0.12, 0.45, 0.12, 0x2a2d31, x, ps + 0.23, pz);
      box(0.56, 0.16, 0.55, st.uph, x, ps + 0.52, pz);
      const bk = box(0.56, 0.7, 0.13, st.uph, x, ps + 0.95, pz + 0.27);
      bk.rotation.x = 0.13;
      for (const s2 of [-1, 1]) box(0.08, 0.28, 0.5, st.uph, x + s2 * 0.27, ps + 0.68, pz);
    }
    if (S.id === 'freeman') {
      const pz2 = pz + 1.05, ps2 = soleAt(pz2);
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * 0.64;
        box(0.12, 0.45, 0.12, 0x2a2d31, x, ps2 + 0.23, pz2);
        box(0.56, 0.16, 0.55, st.uph, x, ps2 + 0.52, pz2);
        const bk2 = box(0.56, 0.7, 0.13, st.uph, x, ps2 + 0.95, pz2 + 0.27);
        bk2.rotation.x = 0.13;
        for (const s2 of [-1, 1]) box(0.08, 0.28, 0.5, st.uph, x + s2 * 0.27, ps2 + 0.68, pz2);
      }
    }
    const az = L / 2 - cap - 0.38, as = soleAt(az);
    box(B * 0.78, 0.45, 0.62, st.uph, 0, as + 0.23, az);
    const ab = box(B * 0.78, 0.5, 0.12, st.uph, 0, as + 0.65, az + 0.27);
    ab.rotation.x = 0.15;
  }

  // bow
  if (st.sunpad) {
    const bz = -L * 0.26, bs = soleAt(bz);
    box(B * 0.52, 0.22, L * 0.17, st.uph, 0, bs + 0.11, bz);
  } else if (st.bowLounge) {
    const lz = cz - cl / 2 - 0.95, ls = soleAt(lz);
    box(cw * 1.45, 0.42, 1.5, H.colors.liner, 0, ls + 0.21, lz);
    for (const sx of [-1, 1]) box(cw * 0.7, 0.16, 1.45, st.uph, sx * cw * 0.36, ls + 0.5, lz);
    const bk = box(cw * 1.45, 0.5, 0.16, st.uph, 0, ls + 0.62, cz - cl / 2 - 0.12);
    bk.rotation.x = -0.12;
    for (const sx of [-1, 1]) {
      let prev: [number, number, number] | null = null;
      for (let t = 0.58; t <= 0.95; t += 0.0925) {
        const st2 = hullStation(H, L, B, t), x = sx * (st2.bs - cap - 0.24), z = zRake(H, st2, st2.ys), y = st2.ys - (0.55 + L * 0.012) * 0.6 + 0.16;
        if (prev) {
          const dx = x - prev[0], dz2 = z - prev[1], len = Math.hypot(dx, dz2);
          const cu = box(0.42, 0.26, len + 0.05, st.uph, (x + prev[0]) / 2, (y + prev[2]) / 2, (z + prev[1]) / 2);
          cu.rotation.y = Math.atan2(dx, dz2);
        }
        prev = [x, z, y];
      }
    }
  } else {
    const bz = -L * 0.27, bs = soleAt(bz), w = stAt(bz).bs - cap;
    for (const sx of [-1, 1]) box(0.38, 0.32, L * 0.12, st.uph, sx * (w - 0.22), bs + 0.16, bz);
    box(B * 0.25, 0.06, L * 0.08, H.colors.liner, 0, bs + 0.03, bz - 0.3);
  }
  if (st.bowRail) {
    const pts: THREE.Vector3[] = [];
    for (const sx of [-1, 1]) {
      const arr: THREE.Vector3[] = [];
      for (let t = 0.56; t <= 0.985; t += 0.035) {
        const s = hullStation(H, L, B, t);
        arr.push(V3(sx * Math.max(0.04, s.bs - cap * 0.5), s.ys + 0.62, zRake(H, s, s.ys)));
      }
      if (sx === -1) pts.push(...arr); else pts.push(...arr.reverse());
    }
    const rail = M(0xd9dde2, { metalness: 0.85, roughness: 0.15, flatShading: false });
    add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.022, 6, false), rail));
    for (const sx of [-1, 1]) {
      for (const t of [0.6, 0.72, 0.84, 0.94]) {
        const s = hullStation(H, L, B, t), x = sx * (s.bs - cap * 0.5), z = zRake(H, s, s.ys);
        g.add(beamBetween(V3(x, s.ys, z), V3(x, s.ys + 0.62, z), 0.018, rail));
      }
    }
  }
  for (const sx of [-1, 1]) for (const t of [0.08, 0.15, 0.22]) {
    const s = hullStation(H, L, B, t);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 10), M(0x1a1c20)), sx * (s.bs - cap * 0.5), s.ys + 0.012, s.z);
  }

  // propulsion
  const n = S.engines, esp = Math.min(0.85, B * 0.8 / n), drop = H.F + H.yk * 0.8 - 0.1;
  let ez = L / 2 + 0.38;
  if (st.mount === 'bracket') {
    ez = L / 2 + 1.1;
    box(B * 0.82, 0.32, 1.0, H.colors.hull, 0, 0.25, L / 2 + 0.48, { roughness: 0.28 });
    box(B * 0.8, 0.04, 0.98, H.colors.deck, 0, 0.43, L / 2 + 0.48);
  }
  const outboards: THREE.Group[] = [];
  for (let i = 0; i < n; i++) {
    const ob = makeOutboard(st, drop, props);
    ob.position.set((i - (n - 1) / 2) * esp, H.F - 0.1, ez);
    g.add(ob);
    outboards.push(ob);
  }

  // fishing rod at the starboard aft gunwale — hidden until game/fishing's setRod(true) shows it
  // (legacy index.html:2632 `setRod`).
  const rs = hullStation(H, L, B, 0.2);
  const rodPivot = new THREE.Group();
  rodPivot.position.set(rs.bs - cap * 0.5, rs.ys + 0.05, rs.z);
  rodPivot.rotation.order = 'YXZ';
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.04, 3, 6).translate(0, 1.5, 0), M(0x1c1f24));
  rodPivot.add(rod);
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.12, 10), M(0xc9a227));
  reel.rotation.z = Math.PI / 2; reel.position.y = 0.45;
  rodPivot.add(reel);
  const tip = new THREE.Object3D();
  tip.position.y = 3;
  rodPivot.add(tip);
  rodPivot.visible = false;
  g.add(rodPivot);

  const captain = makeHuman({ shirt: 0x9cc8e0, shorts: 0xb9a77c, shortsLong: true, hair: 0x4a3020, cap: 0x1d3557, shoes: 0xf2f2f2, glasses: true });
  const helmPos = V3(cw * 0.18, cs, cz + cl / 2 + 0.4);
  const helmPose: [THREE.Vector3, THREE.Vector3] = [V3(-0.1, 0.92, 0.3), V3(0.16, 0.94, 0.28)];
  captain.group.position.copy(helmPos);
  captain.group.rotation.y = Math.PI;
  captain.pose(helmPose[0], helmPose[1]);
  g.add(captain.group);

  const suit = ({ robalo: 0x2bb3a8, grady: 0xe4572e, freeman: 0xe86a92, midnight: 0xf2c14e, mti: 0x2f6fd0 } as Record<string, number>)[S.id] ?? 0xe4572e;
  let crew: Human;
  if (st.sunpad) {
    const bz = -L * 0.26, bs = soleAt(bz);
    crew = makeHuman({ pose: 'lounge', bikini: true, shorts: suit, skin: 0xe9b48f, hair: 0xead27f, longHair: true, glasses: true });
    crew.group.position.set(0, bs + 0.27 - crew.hipY, bz - 0.55);
  } else {
    crew = makeHuman({ pose: 'seated', bikini: true, shorts: suit, skin: 0xe9b48f, hair: 0xead27f, longHair: true, glasses: true });
    crew.group.position.set(0, cs + 0.52 - crew.hipY, cz - cl / 2 - 0.3);
    crew.group.rotation.y = Math.PI;
  }
  g.add(crew.group);

  const S0 = hullStation(H, L, B, 0.02), rp = rodPivot.position;
  const stations = [
    { pos: V3(rp.x, rp.y, rp.z), out: V3(1, 0, 0), spot: V3(rp.x - 0.5, soleAt(rp.z), rp.z + 0.15) },
    { pos: V3(-rp.x, rp.y, rp.z), out: V3(-1, 0, 0), spot: V3(-rp.x + 0.5, soleAt(rp.z), rp.z + 0.15) },
    { pos: V3(B * 0.22, S0.ys + 0.05, S0.z - cap * 0.5), out: V3(0, 0, 1), spot: V3(B * 0.22, soleAt(S0.z - cap - 0.6), S0.z - cap - 0.6) },
  ];
  const fishSpot = stations[0].spot.clone();

  // underwater + navigation lights
  let lights: THREE.Group | null = null;
  const uwLights: THREE.PointLight[] = [];
  const UWC = 0x25e8d2;
  lights = new THREE.Group();
  g.add(lights);
  {
    // r186's colour-managed additive blending composites noticeably hotter than r128's pre-
    // color-management pipeline did for the same opacity (8 overlapping glow planes, summed in
    // correct linear light instead of naive gamma space) — opacity trimmed down to match the old,
    // subtler glow instead of a flood-lit patch of water.
    const gm = sharedMaterial(`uwGlow:${UWC}`, () => new THREE.MeshBasicMaterial({ map: glowTex(), color: UWC, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.22 }));
    const pm = sharedMaterial(`uwPuck:${UWC}`, () => new THREE.MeshBasicMaterial({ color: new THREE.Color(UWC).lerp(new THREE.Color(0xffffff), 0.65) }));
    pushLightMatOnce(deps, { m: gm, day: 0.22, night: 0.5 });
    gm.opacity = lerp(0.22, 0.5, deps.todK);
    const spots: Array<[number, number]> = [];
    for (const t of [0.08, 0.32, 0.58]) for (const sx of [-1, 1]) { const st3 = hullStation(H, L, B, t); spots.push([sx * (st3.b + 0.05), st3.z]); }
    const S0b = hullStation(H, L, B, 0);
    for (const x of [-0.5, 0.5]) spots.push([x * B * 0.6, S0b.z + 0.3]);
    // r186's shadow-map-free point-light attenuation is now always the physically-correct inverse-
    // square/decay curve (legacy r128 defaulted to a softer, non-physical cutoff) — these read much
    // dimmer at the same nominal intensity than they did pre-upgrade, so they're boosted ~3x here to
    // match the old glow radius/brightness at night and underwater.
    for (const sx of H.cat ? [-1, 1] : [0]) {
      const pl = new THREE.PointLight(UWC, 6, 7, 1.4);
      pl.position.set(sx * B * 0.3, -0.45, S0b.z + 0.7);
      lights.add(pl);
      uwLights.push(pl);
    }
    { const pl = new THREE.PointLight(UWC, 4.2, 6, 1.6); pl.position.set(0, -0.9, S0b.z - L * 0.18); lights.add(pl); uwLights.push(pl); }
    spots.forEach(([x, z]) => {
      const pk = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), pm);
      pk.position.set(x, -0.25, z);
      lights!.add(pk);
      const gl = new THREE.Mesh(new THREE.PlaneGeometry(7, 7).rotateX(-Math.PI / 2), gm);
      gl.position.set(x * 1.6, -0.35, z); gl.renderOrder = 0;
      lights!.add(gl);
    });
  }
  {
    const nav = (color: number, x: number, y: number, z: number, size: number) => {
      const bulbMat = sharedMaterial(`navBulb:${color}`, () => new THREE.MeshBasicMaterial({ color }));
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), bulbMat);
      bulb.position.set(x, y, z);
      g.add(bulb);
      const sm = sharedMaterial(`navSprite:${color}`, () => new THREE.SpriteMaterial({ map: glowTex(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.2 }));
      pushLightMatOnce(deps, { m: sm, day: 0.18, night: 1 });
      sm.opacity = lerp(0.18, 1, deps.todK);
      const sp = new THREE.Sprite(sm);
      sp.scale.setScalar(size);
      sp.position.set(x, y, z);
      g.add(sp);
    };
    const sb = hullStation(H, L, B, 0.8), bz = zRake(H, sb, sb.ys);
    nav(0xff2a2a, -(sb.bs + 0.02), sb.ys - 0.12, bz, 0.9);
    nav(0x2aff5a, sb.bs + 0.02, sb.ys - 0.12, bz, 0.9);
    const mastY = tower ? tower.pos.y + 2.2 : topY + 0.75;
    nav(0xffffff, 0, mastY, tower ? tower.pos.z - 0.2 : tz + tl * 0.3, 1.1);
    if (!tower) g.add(beamBetween(V3(0, topY + 0.1, tz + tl * 0.3), V3(0, mastY, tz + tl * 0.3), 0.02, M(0xf4f4f4)));
  }
  if (st.quilt) {
    const qt = quiltTex();
    g.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial && !o.material.map && !o.material.vertexColors && o.material.color.getHex() === st.uph) {
        o.material.map = qt;
        o.material.needsUpdate = true;
      }
    });
  }

  // rods: trolling rods standing in the gunwale holders, a rocket launcher on the tower
  {
    const rodM = M(0x24272b, { flatShading: false, roughness: 0.3 }), corkM = M(0xb8925e), reelM = M(0xc9a227, { metalness: 0.75, roughness: 0.2, flatShading: false }), guideM = M(0xd9dde2, { metalness: 0.8 });
    const rodFn = (base: THREE.Vector3, dir: THREE.Vector3, len: number, big: boolean) => {
      const tipP = base.clone().addScaledVector(dir, len);
      g.add(beamBetween(base, tipP, big ? 0.016 : 0.012, rodM));
      g.add(beamBetween(base.clone().addScaledVector(dir, -0.05), base.clone().addScaledVector(dir, 0.35), big ? 0.03 : 0.024, corkM));
      const r = add(new THREE.Mesh(new THREE.CylinderGeometry(big ? 0.075 : 0.055, big ? 0.075 : 0.055, big ? 0.1 : 0.07, 12), reelM));
      r.position.copy(base).addScaledVector(dir, 0.45);
      r.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(dir.z, 0, -dir.x).normalize());
      for (let k = 1; k <= 4; k++) {
        const gp = base.clone().addScaledVector(dir, 0.6 + k * (len - 0.7) / 4.5);
        const gd = add(new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.004, 4, 8), guideM));
        gd.position.copy(gp);
      }
    };
    for (const sx of [-1, 1]) for (const t of [0.08, 0.15, 0.22]) {
      const s4 = hullStation(H, L, B, t);
      rodFn(V3(sx * (s4.bs - cap * 0.5), s4.ys - 0.25, s4.z), V3(sx * 0.42, 0.85, 0.32).normalize(), 2.3, t < 0.1);
    }
    if (tower) for (let i = 0; i < 5; i++) { const x = (i - 2) * 0.22; rodFn(V3(x, tower.pos.y + 0.65, tower.pos.z + 0.45), V3(x * 0.15, 0.92, 0.38).normalize(), 2.2, false); }
  }

  // cooler
  {
    const coolerZ = st.seat === 'helm' ? L / 2 - cap - 0.38 - 0.95 : L / 2 - cap - 0.62;
    const cs2 = soleAt(coolerZ), CW = 1.0, CD = 0.47, CH = 0.42;
    const blue = M(0x2f84c6, { roughness: 0.55, flatShading: false }), blk = M(0x15171a, { roughness: 0.7 });
    const rr = (w: number, d: number, r: number) => {
      const shp = new THREE.Shape(), hw = w / 2, hd = d / 2;
      shp.moveTo(-hw + r, -hd); shp.lineTo(hw - r, -hd); shp.quadraticCurveTo(hw, -hd, hw, -hd + r); shp.lineTo(hw, hd - r); shp.quadraticCurveTo(hw, hd, hw - r, hd);
      shp.lineTo(-hw + r, hd); shp.quadraticCurveTo(-hw, hd, -hw, hd - r); shp.lineTo(-hw, -hd + r); shp.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
      return shp;
    };
    const body = new THREE.ExtrudeGeometry(rr(CW, CD, 0.07), { depth: CH, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
    body.rotateX(-Math.PI / 2);
    add(new THREE.Mesh(body, blue), 0, cs2 + 0.04, coolerZ);
    const lid = new THREE.ExtrudeGeometry(rr(CW + 0.03, CD + 0.03, 0.08), { depth: 0.06, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
    lid.rotateX(-Math.PI / 2);
    add(new THREE.Mesh(lid, blue), 0, cs2 + 0.06 + CH, coolerZ);
    for (const sx of [-1, 1]) {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.03), blk), sx * CW * 0.28, cs2 + CH - 0.02, coolerZ - CD / 2 - 0.03);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.025, 0.03), blk), sx * CW * 0.28, cs2 + CH + 0.05, coolerZ - CD / 2 - 0.03);
      const h2 = add(new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 12, Math.PI), blk), sx * (CW / 2 + 0.03), cs2 + CH - 0.06, coolerZ);
      h2.rotation.set(0, Math.PI / 2, Math.PI);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.08), blk), sx * (CW / 2 - 0.08), cs2 + 0.02, coolerZ + sz * (CD / 2 - 0.08));
  }

  // marine speaker pods with LED rings — `leds` collects a handle per ring so
  // audio/music/radio.ts's SpeakerSink can pulse them on the beat level.
  const leds: LedHandle[] = [];
  {
    const podM = M(0x15171a, { roughness: 0.35, flatShading: false }), grill = M(0x2a2d31, { roughness: 0.8 });
    const pod = (x: number, y: number, z: number, ry: number, rx: number) => {
      const p = new THREE.Group();
      p.position.set(x, y, z); p.rotation.set(rx, ry, 0, 'YXZ');
      const can = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.26, 16), podM);
      can.rotation.x = Math.PI / 2; p.add(can);
      const gr = new THREE.Mesh(new THREE.CircleGeometry(0.12, 16), grill);
      gr.position.z = 0.131; p.add(gr);
      // Deliberately NOT from `sharedMaterial`: the radio beat mutates this colour every frame
      // (`leds` below, driven by audio/music), so every boat needs its own instance or they would
      // all write over one shared material. Two tiny MeshBasicMaterials per boat is far below the
      // cost the caching note above is about (the hull loft and its shader).
      const ledColor = st.engAcc === 0xf4f4f4 ? 0x2f7bff : 0x2bd4c4;
      const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(ledColor) });
      const base = lm.color.clone();
      leds.push({ base: { r: base.r, g: base.g, b: base.b }, setColor(r, gg, b) { lm.color.setRGB(r, gg, b); } });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.012, 6, 24), lm);
      ring.position.z = 0.132; p.add(ring);
      g.add(p);
    };
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) pod(sx * tw * 0.36, topY - 0.2, tz + sz * tl * 0.32, sx * 0.9 + (sz > 0 ? Math.PI * 0.15 * sx : 0), 0.35);
    if (tower) for (const sx of [-1, 1]) pod(sx * 0.62, tower.pos.y - 0.6, tower.pos.z + 0.35, Math.PI + sx * 0.5, 0.1);
  }

  // cockpit "cabin" lights in the same colour as the underwater lights (legacy ties their
  // visibility to the same 'L' key as the underwater lights; starts off either way).
  const cabin = new THREE.Group();
  g.add(cabin);
  cabin.visible = false;
  let cabinLight!: THREE.PointLight;
  let cabinLight2!: THREE.PointLight;
  {
    const lm = sharedMaterial('cabinLine1', () => new THREE.MeshBasicMaterial({ color: 0x1d48c8 }));
    for (const sx of [-1, 1]) {
      let prev: THREE.Vector3 | null = null;
      for (let k = 0; k <= 8; k++) {
        const t2 = 0.04 + k * 0.07, st5 = hullStation(H, L, B, t2), p2 = V3(sx * (st5.bs - cap - 0.04), soleAt(st5.z) + 0.36, st5.z);
        if (prev) cabin.add(beamBetween(prev, p2, 0.01, lm));
        prev = p2;
      }
    }
    for (const dx of [-0.3, 0, 0.3]) for (const dz of [-0.3, 0.3]) {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.05, 14), lm);
      d.rotation.x = Math.PI / 2;
      d.position.set(dx * tw, topY - 0.07, tz + dz * tl);
      cabin.add(d);
    }
    cabinLight = new THREE.PointLight(0x2a5cff, 1.5, Math.max(7, L * 0.8), 1.8);
    cabinLight.position.set(0, topY - 0.4, tz);
    cabin.add(cabinLight);
  }
  {
    const dm = sharedMaterial('cabinLine2', () => new THREE.MeshBasicMaterial({ color: 0x1530b8 }));
    for (const sx of [-1, 1]) for (let k = 0; k < 7; k++) {
      const st6 = hullStation(H, L, B, 0.06 + k * 0.085), z6 = st6.z;
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.03, 12), dm);
      d.position.set(sx * (st6.bs - cap - 0.03), soleAt(z6) + 0.14, z6);
      d.rotation.y = -sx * Math.PI / 2;
      cabin.add(d);
    }
    const cy0 = soleAt(cz) + 0.03, hw = cw / 2 + 0.04, hl = cl / 2 + 0.04;
    ([[V3(-hw, cy0, -hl), V3(hw, cy0, -hl)], [V3(hw, cy0, -hl), V3(hw, cy0, hl)], [V3(hw, cy0, hl), V3(-hw, cy0, hl)], [V3(-hw, cy0, hl), V3(-hw, cy0, -hl)]] as const)
      .forEach(([a, b]) => cabin.add(beamBetween(a, b, 0.012, dm)));
    const sz3 = cz + cl / 2 + 0.72, sy3 = soleAt(sz3) + 0.12;
    cabin.add(beamBetween(V3(-cw * 0.6, sy3, sz3 - 0.32), V3(cw * 0.6, sy3, sz3 - 0.32), 0.01, dm));
    const S0d = hullStation(H, L, B, 0.02);
    for (const sx of [-1, 1]) {
      const stepLight = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.03), dm);
      stepLight.position.set(sx * S0d.bs * 0.45, soleAt(S0d.z) + 0.2, S0d.z - 0.12);
      stepLight.rotation.y = Math.PI;
      cabin.add(stepLight);
    }
    cabinLight2 = new THREE.PointLight(0x1a3cff, 1.2, Math.max(6, L * 0.6), 2);
    cabinLight2.position.set(0, soleAt(L * 0.18) + 0.35, L * 0.18);
    cabin.add(cabinLight2);
  }

  // stern flags: Old Glory on the Freeman, a Jolly Roger on the Robalo
  const flags: Flag[] = [];
  if (S.id === 'freeman' || S.id === 'robalo') {
    const fs = hullStation(H, L, B, 0.03), px = fs.bs - cap * 0.6, pz2 = fs.z - 0.15, py = fs.ys + 0.02;
    const top = V3(px + 0.1, py + (S.id === 'freeman' ? 3.1 : 2.4), pz2 + 0.55);
    g.add(beamBetween(V3(px, py, pz2), top, 0.025, M(0xd9dde2, { metalness: 0.8, roughness: 0.2, flatShading: false })));
    add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), M(0xd8b84a, { metalness: 0.8, roughness: 0.2 })), top.x, top.y + 0.04, top.z);
    const fl = makeFlag(S.id === 'freeman' ? usFlagTex() : jollyRogerTex(), S.id === 'freeman' ? 1.5 : 1.2, S.id === 'freeman' ? 0.79 : 0.8);
    const fg = new THREE.Group();
    fg.position.set(top.x, top.y - (S.id === 'freeman' ? 0.42 : 0.43), top.z);
    fg.rotation.y = -Math.PI / 2;
    fg.add(fl.mesh);
    g.add(fg);
    flags.push(fl);
  }

  // boat name lettered on the transom and both sides of the stern. The canvas draw + texture
  // only depends on S.nickname (constant per boat id), so it's cached per boat id rather than
  // re-rasterized (a real 2D canvas font-render) for every instance of the same boat.
  if (S.nickname) {
    const nm = sharedMaterial(`nameplate:${S.id}`, () => {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 160;
      const x = c.getContext('2d') as CanvasRenderingContext2D;
      x.font = 'italic 900 104px Georgia, "Times New Roman", serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.lineWidth = 10; x.strokeStyle = '#c8a24a'; x.strokeText(S.nickname!, 512, 84);
      x.fillStyle = '#14233d'; x.fillText(S.nickname!, 512, 84);
      x.font = '600 30px Georgia, serif'; x.fillStyle = '#14233d'; x.fillText('MARATHON, FL', 512, 148);
      const tex = new THREE.CanvasTexture(c);
      return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    });
    const S0c = hullStation(H, L, B, 0), ty = lerp(S0c.yc, S0c.ys, 0.45), tnw = Math.min(S0c.bs * 1.6, 3);
    const tr = new THREE.Mesh(new THREE.PlaneGeometry(tnw, tnw * 0.156), nm);
    tr.position.set(0, ty - 0.05, S0c.z + 0.012);
    g.add(tr);
    const sS = hullStation(H, L, B, 0.14), sy = lerp(sS.yc, sS.ys, 0.55), sw = Math.min(L * 0.28, 3.4);
    for (const sx of [-1, 1]) {
      const sd = new THREE.Mesh(new THREE.PlaneGeometry(sw, sw * 0.156), nm);
      sd.position.set(sx * (sS.bs + B * 0.008 + 0.02), sy, sS.z);
      sd.rotation.y = sx * Math.PI / 2;
      g.add(sd);
    }
  }

  // Freeman shower / Midnight Express dance pole.
  let shower: ShowerRig | null = null;
  if (S.id === 'freeman') {
    const sx = tw * 0.42, sz2 = tz + tl / 2 - 0.14, sy = topY - 0.08;
    const chrome = M(0xe8ebef, { metalness: 0.95, roughness: 0.12, flatShading: false });
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 10), chrome), sx, sy - 0.09, sz2);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.045, 0.04, 16), chrome), sx, sy - 0.22, sz2);
    const cap2 = add(new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), M(0x9aa0a6, { flatShading: false })), sx, sy - 0.243, sz2);
    cap2.rotation.x = Math.PI / 2;
    const coil = add(new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 16), M(0xd9dde2, { flatShading: false })), sx + 0.16, sy - 0.12, sz2);
    coil.rotation.y = Math.PI / 2;
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.06, 10), M(0x2a2d31)), sx + 0.16, sy - 0.04, sz2);
    const sh2 = makeHuman({ walker: true, bikini: true, shorts: 0x9fd8ff, glasses: false });
    sh2.group.position.set(sx, soleAt(sz2), sz2);
    sh2.group.visible = false;
    g.add(sh2.group);
    shower = { x: sx, y: sy - 0.25, z: sz2, h: sh2, on: false, t: rand(8, 18), forced: null };
  }
  let pole: PoleRig | null = null;
  if (S.id === 'midnight') {
    const pzp = (cz + cl / 2 + 0.72 + (L / 2 - cap - 0.38 - 0.95)) / 2, psp = soleAt(pzp);
    const pm2 = M(0xe8ebef, { metalness: 0.95, roughness: 0.12, flatShading: false });
    const pl = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, topY - psp, 14), pm2);
    pl.position.set(0, (topY + psp) / 2, pzp);
    g.add(pl);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.04, 18), pm2), 0, psp + 0.02, pzp);
    const dn = makeHuman({ walker: true, bikini: true, shorts: 0xc8a24a, glasses: false });
    dn.group.position.set(0.35, psp, pzp);
    g.add(dn.group);
    pole = { h: dn, z: pzp, y: psp, top: topY, ang: 0 };
  }

  // the deck party: a few bikini-clad crew walking a loop around the cockpit (lane width derived
  // from the hull's own beam-at-z, same as legacy's inline `lane`) or dancing in place together.
  // `coolerZ` is recomputed here (same formula the cooler block above used) rather than hoisted
  // out of that block's scope, to keep this addition a pure insertion at the bottom of the
  // function rather than a change to code above it.
  const coolerZForParty = st.seat === 'helm' ? L / 2 - cap - 0.38 - 0.95 : L / 2 - cap - 0.62;
  const lane = (z: number): number => Math.max(0.35, stAt(z).bs - cap - 0.42);
  const zc = Math.min(L * 0.33, coolerZForParty - 0.85);
  const partyPath = createPath([[lane(zc), zc], [lane(-L * 0.1), -L * 0.1], [0, -L * 0.19], [-lane(-L * 0.1), -L * 0.1], [-lane(zc), zc], [0, coolerZForParty - 0.7]]);
  const PARTY_SUITS = [0xe86a92, 0x2bb3a8, 0xf2c14e, 0x15171a, 0xe4572e, 0xffffff];
  const party: PartyMember[] = [];
  const nP = L > 12 ? 5 : L > 8.5 ? 4 : 3;
  for (let k = 0; k < nP; k++) {
    const h = makeHuman({ walker: true, bikini: true, shorts: PARTY_SUITS[k % PARTY_SUITS.length], glasses: k % 2 === 0 });
    g.add(h.group);
    party.push({ h, path: partyPath, s: k / nP * partyPath.total, ph: Math.random() * 6, mode: k % 3 === 0 ? 'walk' : 'dance', modeT: rand(5, 10) });
  }

  return {
    group: g, deckY: cs, props, helmPos, helmPose, fishSpot, soleAt,
    wheel: helmWheel, tower, outboards, lights, flags,
    cabin, cabinLight, cabinLight2,
    rodPivot, rodTip: tip, stations, station: 0, captain, crew,
    party, pole, shower, leds, uwLights, speakerPos: V3(0, topY - 0.3, tz),
  };
}

export type { HullStyle };
