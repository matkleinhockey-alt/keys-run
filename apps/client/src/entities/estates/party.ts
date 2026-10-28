/**
 * The #1 angler's party: whoever tops the leaderboard throws it at their best estate (the registry
 * says which — `Registry.party`, packages/shared/src/content/estates.ts `partyLot`). Lights up on
 * the lawn, a DJ on the deck, a crowd dancing in front of the house, and boats rafted up three
 * deep along the dock, their own deck parties going.
 *
 * Built by index.ts only while the party lot is near the camera, and torn down with the estate.
 *
 * Cost, deliberately bounded: two point lights (the string lights are emissive bulbs in one
 * InstancedMesh, so they read at night without lighting anything), ~16 guests, and real boats
 * from `makeBoat` — the anchorage parties in entities/life/party-boats.ts made the case that a
 * stand-in hull is cheaper only until you idle past it.
 */
import * as THREE from 'three';
import { SPECIES } from '@keysrun/shared/content/species';
import { BOATS } from '@keysrun/shared/content/boats';
import { estateGround, pointInPoly, type Party } from '@keysrun/shared/content/estates';
import { seaHAt, seaSlopeAt } from '@keysrun/shared/sim/depth-grid';
import { makeHuman, type Human } from '../life/human.js';
import { makeBoat, type BoatModel } from '../boat/model.js';
import { updateParty } from '../life/deck-party.js';
import type { ParticleSystem } from '../../world/particles.js';
import { box, cyl, mats, signMesh } from './materials.js';
import type { EstateSite } from './grounds.js';

/** What the rafted boats' own deck parties need (entities/life/deck-party.ts's `updateParty`).
 * Without it the boats still float and their guests stand about. */
export interface BoatFx { particles: ParticleSystem; todK(): number; bpm(): number }

const BPM = 122;
const RAFT = ['midnight', 'freeman', 'yellowfin', 'contender'];
const SKINS = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0xffdbac, 0x6b4226, 0xd9a27f];
const SHIRTS = [0xffffff, 0x2f8fd8, 0xf26b5b, 0x3fb68b, 0xf4c542, 0x8a5cc2, 0xff8c42, 0x9ad0ec];
const SUITS = [0xe86a92, 0x2bb3a8, 0xf2c14e, 0x15171a, 0xe4572e, 0xffffff];
const BULBS = [0xffd98a, 0xff6fb5, 0x6fe8ff, 0xb6ff6f, 0xffffff];
const pick = <T,>(a: readonly T[], i: number): T => a[((i % a.length) + a.length) % a.length];

type Move = 'hands' | 'sway' | 'step' | 'wave' | 'shimmy';
const MOVES: readonly Move[] = ['hands', 'sway', 'step', 'wave', 'shimmy'];

interface Guest { h: Human; base: THREE.Vector3; ph: number; move: Move; moveT: number; face: number }
interface Rafted { model: BoatModel; x: number; z: number; yaw: number; ph: number }

const _l = new THREE.Vector3(), _r = new THREE.Vector3(), _fl = new THREE.Vector3(), _fr = new THREE.Vector3();

function placeholderBoatDeps() {
  // Same trick as party-boats.ts: a moored boat's screens are never legible from the water.
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const t = new THREE.CanvasTexture(c);
  return { lightMats: [], todK: 0.3, mfdTex: t, gpsTex: t, sonTex: t, wealth: { partyCount: 5, underglow: true } };
}

export interface EstateParty {
  group: THREE.Group;
  update(dt: number, t: number, cam: THREE.Vector3): void;
  dispose(): void;
}

export function buildParty(site: EstateSite, party: Party, fx: BoatFx | undefined): EstateParty {
  const M = mats(), group = new THREE.Group();
  group.name = `estate-party-${site.parcel.id}`;
  const L = site.layout;
  const harbor = site.parcel.tier === 'harbor';
  // Harbor Row houses are drawn turned round, opening onto the lot (index.ts): the party follows.
  const flip = harbor ? -1 : 1;
  const sx = L.sea[0] * flip, sz = L.sea[1] * flip, ax = -sz, az = sx;
  const onLot = (x: number, z: number) => harbor ? pointInPoly(site.parcel.poly, x, z) : estateGround(site.parcel, L, x, z) !== null;

  // The dance floor: out in front of the house, walked back toward it until it is on the lot.
  // (clear of the 7 m pool terrace villa and glass houses carry across their fronts)
  let out = L.house.d / 2 + (site.estate.build.res === 'villa' || site.estate.build.res === 'glass' ? 12.5 : 9);
  let cx = L.house.x + sx * out, cz = L.house.z + sz * out;
  for (let i = 0; i < 8 && !onLot(cx, cz); i++) { out *= 0.75; cx = L.house.x + sx * out; cz = L.house.z + sz * out; }
  const cy = site.groundY(cx, cz);
  const heading = L.heading + (harbor ? Math.PI : 0);

  // DJ: booth with decks and speaker stacks, house-side of the floor, facing the water and crowd.
  const dj = new THREE.Group();
  const djx = cx - sx * 4.5, djz = cz - sz * 4.5;
  dj.position.set(djx, site.groundY(djx, djz), djz);
  dj.rotation.y = heading;
  dj.add(box(4, 0.4, 2.4, M.trim, 0, 0, 0));
  dj.add(box(2.4, 1.05, 0.8, M.trim, 0, 0.4, 0.5));
  for (const x of [-0.6, 0.6]) dj.add(cyl(0.22, 0.22, 0.04, M.steel, x, 1.45, 0.5, 16));
  for (const x of [-2.6, 2.6]) { dj.add(box(1, 1.8, 0.9, M.trim, x, 0, 0.2)); dj.add(cyl(0.3, 0.3, 0.05, M.steel, x, 1.2, 0.66, 12).rotateX(Math.PI / 2)); }
  const djHuman = makeHuman({ walker: true, skin: 0x6b4226, shirt: 0x15171a, shorts: 0x2b4a6e, cap: 0xff3fa4, glasses: true });
  djHuman.group.position.set(0, 0.4, -0.3);
  dj.add(djHuman.group);
  group.add(dj);

  // Banner on two tall posts behind the DJ.
  const banner = signMesh([
    ['bold 40px system-ui, sans-serif', '#1 ON THE LEADERBOARD'],
    ['bold 56px system-ui, sans-serif', party.displayName],
    ['32px system-ui, sans-serif', `${SPECIES[party.speciesKey]?.name ?? party.speciesKey} · ${party.weightLb.toFixed(1)} lb`],
  ], 6, 2.4, 512 / 205);
  const bx = djx - sx * 2.2, bz = djz - sz * 2.2;
  const bg = new THREE.Group();
  bg.position.set(bx, site.groundY(bx, bz), bz);
  bg.rotation.y = heading;
  for (const s of [-1, 1]) bg.add(box(0.2, 6, 0.2, M.darkWood, s * 3.1, 0, 0));
  banner.position.set(0, 4.6, 0.12);
  bg.add(banner);
  group.add(bg);

  // String lights: four poles round the floor, bulbs strung pole to pole with a sag.
  const half = { a: 8, s: 6 };
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, s]) => {
    const x = cx + ax * a * half.a + sx * s * half.s, z = cz + az * a * half.a + sz * s * half.s;
    return new THREE.Vector3(x, site.groundY(x, z), z);
  });
  for (const c of corners) group.add(cyl(0.08, 0.1, 4.2, M.darkWood, c.x, c.y, c.z, 6));
  const PER = 14;
  const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 6, 4), M.bulb.clone(), corners.length * PER);
  bulbs.material.userData.own = true;
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  let bi = 0;
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % corners.length];
    for (let k = 0; k < PER; k++) {
      const u = (k + 0.5) / PER;
      m4.makeTranslation(a.x + (b.x - a.x) * u, a.y + 4.2 + (b.y - a.y) * u - Math.sin(u * Math.PI) * 0.9, a.z + (b.z - a.z) * u);
      bulbs.setMatrixAt(bi, m4);
      bulbs.setColorAt(bi++, col.setHex(pick(BULBS, k + i)));
    }
  });
  group.add(bulbs);

  const lightA = new THREE.PointLight(0xff3fa4, 0, 28, 1.6);
  const lightB = new THREE.PointLight(0x3fe0ff, 0, 28, 1.6);
  lightA.position.set(cx + ax * 3, cy + 5, cz + az * 3);
  lightB.position.set(cx - ax * 3, cy + 5, cz - az * 3);
  group.add(lightA, lightB);

  // The crowd: two loose rings on the floor, everyone facing in toward the DJ end.
  const guests: Guest[] = [];
  let n = 0;
  for (const [r, count] of [[2.6, 6], [5, 10]] as const) {
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + r;
      const x = cx + Math.cos(a) * r * 1.3, z = cz + Math.sin(a) * r;
      if (!onLot(x, z)) continue;
      const y = site.groundY(x, z);
      if (Math.abs(y - cy) > 1.2) continue;
      const woman = n % 2 === 0;
      const h = woman
        ? makeHuman({ walker: true, bikini: true, shorts: pick(SUITS, n), glasses: n % 4 === 0 }, n)
        : makeHuman({ walker: true, skin: pick(SKINS, n), shirt: pick(SHIRTS, n * 3), shortSleeve: true, shorts: pick(SUITS, n + 2), cap: n % 3 === 1 ? pick(SHIRTS, n) : undefined, glasses: n % 3 === 0 });
      h.group.position.set(x, y, z);
      const face = Math.atan2(djx - x, djz - z) * 0.5 + Math.atan2(cx - x, cz - z) * 0.5;
      h.group.rotation.y = face;
      group.add(h.group);
      guests.push({ h, base: new THREE.Vector3(x, y, z), ph: n * 1.7, move: pick(MOVES, n), moveT: 3 + (n % 5), face });
      n++;
    }
  }

  // Boats rafted up: alongside the dock's seaward half (the side away from the gallows), each
  // further one tied to the last; no dock, and they lie at anchor off the beach.
  const rafted: Rafted[] = [];
  const deps = placeholderBoatDeps();
  const d = L.dock;
  // (Harbor Row is on the town pad, a street from the water: no boats.)
  RAFT.slice(0, harbor ? 0 : d ? 4 : 3).forEach((id, i) => {
    const spec = BOATS.find((b) => b.id === id);
    if (!spec) return;
    const model = makeBoat(spec, deps);
    model.group.traverse((o) => { o.userData.keep = true; }); // makeBoat may share geometry with the player's hull
    let x: number, z: number;
    if (d) {
      const side = i < 3 ? -1 : 1, k = i < 3 ? i : 0;
      const across = side * (d.w / 2 + spec.beam / 2 + 0.5 + k * (spec.beam + 0.7));
      const along = Math.max(d.len - spec.len / 2 - 1 - (i === 3 ? spec.len + 2 : 0), spec.len / 2 + 9);
      x = d.x0 + sx * along + ax * across; z = d.z0 + sz * along + az * across;
    } else {
      x = site.shore[0] + sx * 28 + ax * i * (spec.beam + 0.7); z = site.shore[1] + sz * 28 + az * i * (spec.beam + 0.7);
    }
    group.add(model.group);
    rafted.push({ model, x, z, yaw: heading + Math.PI, ph: i * 1.3 });
  });

  function danceGuest(g: Guest, dt: number, t: number): void {
    const h = g.h, hy = h.hipY;
    g.ph += dt * (BPM / 60) * Math.PI;
    g.moveT -= dt;
    if (g.moveT <= 0) { g.move = pick(MOVES, Math.floor(t * 7 + g.base.x)); g.moveT = 4 + ((g.base.z * 13) % 4 + 4) % 4; }
    const beat = Math.sin(g.ph), halfB = Math.sin(g.ph * 0.5), down = Math.abs(beat);
    let bounce = -down * 0.05, sway = 0;
    _fl.set(-0.13, 0.085, 0.02); _fr.set(0.13, 0.085, -0.02);
    switch (g.move) {
      case 'hands': _l.set(-0.22 + 0.08 * halfB, hy + 1.0 + 0.06 * beat, 0.08); _r.set(0.22 + 0.08 * halfB, hy + 1.0 - 0.06 * beat, 0.08); sway = halfB * 0.04; break;
      case 'sway': _l.set(-0.2, hy + 0.06, 0.02); _r.set(0.32, hy + 0.85 + 0.12 * beat, 0.12); sway = halfB * 0.07; bounce = -0.03 - down * 0.03; break;
      case 'step': { const st = halfB * 0.11; _fl.x -= Math.max(0, -st); _fr.x += Math.max(0, st); _l.set(-0.24, hy + 0.45 + 0.08 * down, 0.2); _r.set(0.24, hy + 0.45 + 0.08 * down, 0.2); sway = st * 0.6; break; }
      case 'wave': _l.set(-0.18 + 0.22 * halfB, hy + 1.02, 0.06); _r.set(0.18 + 0.22 * halfB, hy + 1.02, 0.06); sway = halfB * 0.05; break;
      case 'shimmy': { const f = Math.sin(g.ph * 4) * 0.035; _l.set(-0.3, hy + 0.48 + f, 0.18); _r.set(0.3, hy + 0.48 - f, 0.18); sway = f * 0.4; bounce = -0.05 - down * 0.02; break; }
    }
    h.update(t, 0);
    h.poseLegs(_fl, _fr);
    h.pose(_l, _r);
    h.group.rotation.set(0.04, g.face + Math.sin(t * 0.3 + g.ph * 0.1) * 0.4, sway * 0.8, 'YXZ');
    h.group.position.set(g.base.x + Math.cos(g.face) * sway, g.base.y + bounce + 0.05, g.base.z - Math.sin(g.face) * sway);
    h.head.rotation.x = down * 0.12 - 0.04;
  }

  return {
    group,
    update(dt, t, cam): void {
      const near = cam.distanceToSquared(lightA.position) < 400 * 400;
      // The beat drives the lights: a pulse on every kick, the two colours trading off by the bar.
      const kick = Math.pow(1 - ((t * BPM / 60) % 1), 3);
      const bar = Math.sin(t * BPM / 60 * Math.PI / 2);
      lightA.intensity = near ? 30 + 70 * kick * (0.5 + 0.5 * bar) : 0;
      lightB.intensity = near ? 30 + 70 * kick * (0.5 - 0.5 * bar) : 0;
      (bulbs.material as THREE.MeshBasicMaterial).color.setScalar(0.75 + 0.25 * kick);
      if (cam.distanceToSquared(lightA.position) > 600 * 600) return; // too far to see anyone dance
      for (const g of guests) danceGuest(g, dt, t);
      // the DJ: head down, one hand on the mixer, the other in the air on the drop
      const dh = djHuman, hy = dh.hipY;
      dh.update(t, 0);
      _l.set(-0.25, hy + 0.55, 0.45);
      _r.set(0.2, kick > 0.6 && bar > 0.5 ? hy + 1.05 : hy + 0.55, kick > 0.6 && bar > 0.5 ? 0.1 : 0.45);
      dh.pose(_l, _r);
      dh.head.rotation.x = 0.25 + Math.abs(Math.sin(t * BPM / 60 * Math.PI)) * 0.12;

      for (const b of rafted) {
        const surf = seaHAt(b.x, b.z, t);
        const [wx, wz] = seaSlopeAt(b.x, b.z, t);
        const g = b.model.group;
        g.position.set(b.x, surf, b.z);
        g.rotation.set(0, 0, 0);
        g.rotateY(b.yaw + Math.sin(t * 0.05 + b.ph) * 0.03);
        g.rotateX(-wz * 0.5);
        g.rotateZ(wx * 0.4);
        if (fx) {
          updateParty(dt, t, b.model, { x: b.x, z: b.z, speed: 0, air: false }, { particles: fx.particles, cameraPos: cam, bpm: fx.bpm, todK: fx.todK, luigiOn: () => false });
        }
        b.model.captain.update(t, 0);
        b.model.crew.update(t, 0);
        for (const P of b.model.party) P.h.update(t, 0);
      }
    },
    dispose(): void {
      (bulbs.material as THREE.Material).dispose();
      deps.mfdTex.dispose();
    },
  };
}
