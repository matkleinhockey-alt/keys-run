/**
 * The sandbar: a knee-deep bank out in open water with half the island tied up on it.
 *
 * `party-boats.ts` already has the quiet version of this — a couple of hulls rafted off a beach,
 * nobody going anywhere. A sandbar is the loud one, and it is a different thing in every way
 * that matters: it is nowhere near the shore, the water is shallow enough to STAND in, and the
 * boats are not anchored off it so much as parked on it, bows in, tied to each other in a line
 * with everybody out of them and in the water.
 *
 * ## The bar is found, not invented
 *
 * A bar is shallow water with deeper water round it — that is the whole definition, and it is
 * what makes one a destination rather than a beach. So the sites are chosen by scoring the real
 * bathymetry for exactly that: knee deep on the crest, most of a metre deeper on average at 140 m
 * out, somewhere on that ring deep enough to bring a boat in through, and 200 m clear of the
 * nearest shoreline. If the terrain ever changes under them, the same scan finds the new ones
 * instead of leaving a raft of boats sitting on a hill.
 *
 * ## ...and the party moves
 *
 * The scan keeps every bar that qualifies, not just the best one, and which bar the raft-up is on
 * turns over on the wall clock. That is both truer and better to play: a sandbar party is a
 * where-is-everybody-today thing, and a fixture at one coordinate forever stops being a discovery
 * the second you have found it once. The pick is hashed off the clock period rather than rolled
 * per session, the same way the bait frenzies work, so every client finds the party in the same
 * place — and the raft only ACTUALLY moves while nobody is in sight of it, because boats and
 * fourteen people popping to a new coordinate in front of you is worse than a party that stays
 * put a little too long.
 *
 * The sand itself is a shallow dome laid on the bottom, brightest at the crest where it almost
 * dries. The boats sit in the deeper water around the rim rather than up on the crest, because
 * a boat on the crest would be aground — the people are the ones who get to stand on it.
 */
import * as THREE from 'three';
import { chainZ, shoreInfo } from '@keysrun/shared/world/chain';
import { depthAt, landH } from '@keysrun/shared/world/depth';
import { BOATS } from '@keysrun/shared/content/boats';
import { waveHBase } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { makeBoat, type BoatModel } from '../boat/model.js';
import { placeholderDeps } from './party-boats.js';
import { createHumanRegistry } from './human.js';
import { hashCell } from '@keysrun/shared/rng';
import { WORLD_SEED, SALT } from '../../state/constants.js';
import { rand } from '../../core/math.js';

/** Crest depth we are hunting for: deep enough to be water, shallow enough to stand in. */
const CREST_MIN = 0.45, CREST_MAX = 1.1;
/**
 * How much deeper it has to be AROUND a shallow patch before it counts as a BAR, averaged over
 * eight bearings.
 *
 * The first cut of this took the MINIMUM over the eight, which sounds stricter and better and is
 * neither: it demands an isolated dome with deeper water on every single bearing, and this
 * bathymetry has exactly one of those in 5457 sampled cells. A real bar is a local high, not an
 * island of water — it usually has one side where it runs off into a flat. So: deeper on average,
 * and allowed one bearing that is a hair shallower (MIN_RELIEF_M).
 */
const RELIEF_M = 0.6;
const MIN_RELIEF_M = -0.05;
/** ...measured at this radius. */
const RING_R = 140;
/** Deep enough SOMEWHERE on the ring that a boat can actually get to the party. */
const ACCESS_M = 1.6;
/** And this far from any beach, or it is just the shallows off a shore. */
const MIN_SHORE_D = 200;
/** Radius of the sand dome, metres. */
const BAR_R = 58;
/** Boats are hidden past this; the party is a thing you come across. */
const SHOW_M = 900;
/** Two candidate bars closer together than this are the same bar. */
const SITE_SPACING = 700;
/** How long the party stays on one bar, real ms. Long enough to go and find it. */
export const ROTATE_MS = 40 * 60 * 1000;

export interface BarSite {
  x: number; z: number;
  /** Water over the crest. */
  depth: number;
  /** Mean extra depth on the ring — how much of a high it is. Ranks the shortlist. */
  relief: number;
}

export interface Sandbar {
  group: THREE.Group;
  /** Where the party is right now. Null if the bathymetry has no bar in it at all. */
  site(): BarSite | null;
  update(dt: number, t: number, camera: { x: number; y: number; z: number }): void;
  debug(): { x: number; z: number; depth: number; boats: number; visible: boolean; sites: number; index: number } | null;
  dispose(): void;
}

/**
 * Every bar in the world worth tying up on, best relief first and spread out.
 *
 * Exported so a test can assert they really are shallow, really are surrounded by deeper water,
 * and really are off on their own — and so the party has somewhere else to go.
 */
export function findSandbars(limit = 8): BarSite[] {
  const all: BarSite[] = [];
  for (let x = -3200; x <= 3200; x += 60) {
    for (let dz = -1200; dz <= 800; dz += 40) {
      const z = chainZ(x) + dz;
      const d = depthAt(x, z);
      if (d < CREST_MIN || d > CREST_MAX) continue;
      if (landH(x, z) > 0.02) continue;
      if (shoreInfo(x, z).d < MIN_SHORE_D) continue;
      let sum = 0, lo = Infinity, hi = -Infinity;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        const q = depthAt(x + Math.cos(th) * RING_R, z + Math.sin(th) * RING_R);
        sum += q; lo = Math.min(lo, q); hi = Math.max(hi, q);
      }
      const relief = sum / 8 - d;
      if (relief < RELIEF_M) continue;
      if (lo - d < MIN_RELIEF_M) continue;
      if (hi < ACCESS_M) continue;
      all.push({ x, z, depth: d, relief });
    }
  }
  all.sort((a, b) => b.relief - a.relief);
  // Thin them out. Two crests 200 m apart are one bar as far as a boat is concerned, and keeping
  // both would spend the whole shortlist on neighbouring squares of the same bank.
  const picked: BarSite[] = [];
  for (const c of all) {
    if (picked.some((q) => Math.hypot(q.x - c.x, q.z - c.z) < SITE_SPACING)) continue;
    picked.push(c);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * Which bar the party is on at a given wall-clock time.
 *
 * Hashed off the clock period, not rolled — this is world content, so every client has to agree
 * about where everybody is. Same reasoning as `frenzyActive` in shared/world/frenzy.ts.
 */
export function sandbarIndexAt(wallMs: number, count: number): number {
  if (count <= 1) return 0;
  const period = Math.floor(wallMs / ROTATE_MS);
  return Math.min(count - 1, Math.floor(hashCell(WORLD_SEED, period, 77, SALT.HOUSE_ROT) * count));
}

/**
 * The live site, for anything outside the scene graph that needs to know where the party is —
 * the minimap draws a beer can on it. Module-level accessor rather than plumbing, matching how
 * `chartedWrecks()` hands the chart to the same map.
 */
let liveSite: BarSite | null = null;
export function sandbarSite(): BarSite | null { return liveSite; }

export function createSandbar(scene: THREE.Scene): Sandbar {
  const group = new THREE.Group();
  group.name = 'sandbar';
  scene.add(group);

  const sites = findSandbars();
  const humans = createHumanRegistry();
  /** Boat placements are LOCAL to the bar centre, so relocating is one `group.position` write. */
  const boats: Array<{ model: BoatModel; lx: number; lz: number; yaw: number; ph: number; len: number; beam: number }> = [];
  const floats: THREE.Mesh[] = [];
  /** Standing people, with the radial fraction that decides how deep they are in it. */
  const people: Array<{ g: THREE.Group; rr: number }> = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };
  const M = (c: number, o: { rough?: number } = {}): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: o.rough ?? 0.95, flatShading: true });
    mats.push(m);
    return m;
  };

  let cur = sites.length ? sandbarIndexAt(Date.now(), sites.length) : -1;
  let site: BarSite | null = cur >= 0 ? sites[cur] : null;
  liveSite = site;

  let sand: THREE.Mesh | null = null;
  /** Normalised dome profile per vertex, so a new depth is a multiply rather than a rebuild. */
  let domeProfile: Float32Array | null = null;

  if (site) {
    // ---- the bank itself: a shallow dome, palest where it almost dries.
    const seg = 28;
    const dome = keep(new THREE.CircleGeometry(BAR_R, seg).rotateX(-Math.PI / 2));
    const pos = dome.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    domeProfile = new Float32Array(pos.count);
    const c0 = new THREE.Color(0xe8dcb8), c1 = new THREE.Color(0x9fb098);
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), pz = pos.getZ(i);
      const r = Math.min(1, Math.hypot(px, pz) / BAR_R);
      // Dome: proud in the middle, feathered to nothing at the rim so there is no visible edge.
      domeProfile[i] = Math.cos(r * Math.PI / 2);
      const c = c1.clone().lerp(c0, Math.pow(1 - r, 1.4));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    dome.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const sandM = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    mats.push(sandM);
    sand = new THREE.Mesh(dome, sandM);
    sand.receiveShadow = true;
    group.add(sand);

    // ---- the raft: bows in to the bank, tied to each other in a line along the rim.
    const deps = placeholderDeps();
    const PICK = ['robalo', 'grady', 'freeman', 'contender', 'yellowfin', 'robalo', 'grady', 'contender'];
    const arc0 = hashCell(WORLD_SEED, 1, 0, SALT.HOUSE_ROT) * Math.PI * 2;
    PICK.forEach((id, i) => {
      const spec = BOATS.find((b) => b.id === id);
      if (!spec) return;
      // Spread along an arc of the rim, in the deeper water just off the crest — a boat ON the
      // crest is a boat aground, and the whole point is that it is the PEOPLE who stand there.
      const a = arc0 + (i - (PICK.length - 1) / 2) * 0.17;
      const r = BAR_R * 0.92 + ((i % 2) * 4.5);
      const model = makeBoat(spec, deps);
      group.add(model.group);
      boats.push({
        model, lx: Math.cos(a) * r, lz: Math.sin(a) * r,
        yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) + Math.PI / 2,
        ph: rand(0, 6.28), len: spec.len, beam: spec.beam,
      });
    });

    // ---- the people, standing in it. This is the whole picture: everybody out of the boats.
    for (let i = 0; i < 14; i++) {
      const a = arc0 + (hashCell(WORLD_SEED, i, 3, SALT.HOUSE_ROT) - 0.5) * 2.4;
      const r = BAR_R * (0.15 + hashCell(WORLD_SEED, i, 4, SALT.HOUSE_ROT) * 0.66);
      const h = humans.makeHuman({ bikini: i % 2 === 0 } as never);
      h.group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      h.group.rotation.y = hashCell(WORLD_SEED, i, 5, SALT.HOUSE_ROT) * Math.PI * 2;
      group.add(h.group);
      people.push({ g: h.group, rr: Math.min(1, r / BAR_R) });
    }

    // ---- floats and a cooler or two drifting between the boats.
    for (let i = 0; i < 9; i++) {
      const a = arc0 + (hashCell(WORLD_SEED, i, 6, SALT.HOUSE_ROT) - 0.5) * 2.2;
      const r = BAR_R * (0.45 + hashCell(WORLD_SEED, i, 7, SALT.HOUSE_ROT) * 0.6);
      const ring = i % 3 === 2
        ? new THREE.Mesh(keep(new THREE.BoxGeometry(0.9, 0.5, 0.6)), M(0xf2f2f2, { rough: 0.6 }))
        : new THREE.Mesh(keep(new THREE.TorusGeometry(0.62, 0.21, 7, 14).rotateX(-Math.PI / 2)),
          M([0xf2c14e, 0xe4572e, 0x2bb3a8, 0xf07aa0][i % 4], { rough: 0.55 }));
      ring.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      group.add(ring);
      floats.push(ring);
    }

    applySite(site);
  }

  /**
   * Put the whole party on a bar. Everything above is built around a local origin, so this is a
   * group move plus the two things that genuinely depend on how deep THIS bar is: how proud the
   * sand stands off the bottom, and how far down the people standing on it are.
   */
  function applySite(s: BarSite): void {
    group.position.set(s.x, 0, s.z);
    if (sand && domeProfile) {
      sand.position.y = -s.depth;
      const pos = sand.geometry.attributes.position as THREE.BufferAttribute;
      const h = s.depth - 0.12;
      for (let i = 0; i < pos.count; i++) pos.setY(i, domeProfile[i] * h);
      pos.needsUpdate = true;
      sand.geometry.computeVertexNormals();
    }
    for (const p of people) {
      // Waist deep: the dome's own height under them decides how far down they are standing.
      p.g.position.y = -s.depth + Math.cos(p.rr * Math.PI / 2) * (s.depth - 0.12);
    }
    site = s;
    liveSite = s;
  }

  function update(dt: number, t: number, camera: { x: number; y: number; z: number }): void {
    if (!site) return;
    const seen = (s: BarSite): boolean => Math.hypot(s.x - camera.x, s.z - camera.z) < SHOW_M;

    /*
     * Move it only out of sight. The clock says where the party SHOULD be; if the player is
     * standing in the middle of the old one, the clock waits. A raft of boats teleporting in
     * front of you is a worse bug than a party that hangs on past its hour.
     */
    if (!seen(site) && sites.length > 1) {
      const want = sandbarIndexAt(Date.now(), sites.length);
      if (want !== cur) { cur = want; applySite(sites[want]); }
    }

    // Re-tested against the site we ended up on: on a relocating frame the old distance is a
    // different bar's, and using it blanks the party for a frame after it has already arrived.
    const near = seen(site);
    group.visible = near;
    if (!near) return;
    humans.updateHumans(t, new THREE.Vector3(camera.x, camera.y, camera.z), 0);
    const amp = ampAt(site.x, site.z);
    for (const b of boats) {
      /*
       * Attitude off the WATER, not off a clock.
       *
       * The first version rocked these on canned sines, which looks fine until two hulls tied
       * beam to beam roll out of step with the wave that is passing under both of them. Pitch
       * comes from the height difference between bow and stern and roll from the difference
       * between the rails — the same four samples traffic.ts and the commercial fleet take — so
       * a swell running through the raft lifts each boat as it reaches it, and two boats
       * alongside each other move together because they are on the same water.
       *
       * They fidget rather than swing: bows are against the bank and there is no room.
       */
      const yaw = b.yaw + Math.sin(t * 0.21 + b.ph) * 0.05;
      const wx = site.x + b.lx, wz = site.z + b.lz;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), hl = b.len * 0.45;
      const hbow = waveHBase(wx + fx * hl, wz + fz * hl, t, amp);
      const hstern = waveHBase(wx - fx * hl, wz - fz * hl, t, amp);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw), hw = b.beam * 0.5;
      const hport = waveHBase(wx - rx * hw, wz - rz * hw, t, amp);
      const hstbd = waveHBase(wx + rx * hw, wz + rz * hw, t, amp);
      b.model.group.position.set(b.lx, (hbow + hstern) / 2, b.lz);
      b.model.group.rotation.set(
        Math.atan2(hbow - hstern, b.len),
        yaw,
        Math.atan2(hport - hstbd, b.beam) * 0.85,
        'YXZ',
      );
    }
    for (let i = 0; i < floats.length; i++) {
      const f = floats[i];
      f.position.y = waveHBase(site.x + f.position.x, site.z + f.position.z, t, amp) + 0.06;
      f.rotation.y += dt * 0.12 * (i % 2 ? 1 : -1);
    }
  }

  return {
    group,
    site: () => site,
    update,
    debug: () => (site ? {
      x: site.x, z: site.z, depth: +site.depth.toFixed(2), boats: boats.length,
      visible: group.visible, sites: sites.length, index: cur,
      // Where the raft REALLY ended up, which is the thing that can disagree with `site`.
      gx: +group.position.x.toFixed(1), gz: +group.position.z.toFixed(1),
      b0: boats[0] ? [+(group.position.x + boats[0].lx).toFixed(1), +(group.position.z + boats[0].lz).toFixed(1)] : null,
    } : null),
    dispose() {
      liveSite = null;
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
