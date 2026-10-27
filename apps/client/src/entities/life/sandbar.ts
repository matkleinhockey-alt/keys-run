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
 * A bar is shallow water with deeper water all the way round it — that is the whole definition,
 * and it is what makes one a destination rather than a beach. So the site is chosen by scoring
 * the real bathymetry for exactly that: 0.5 m on the crest, close to a metre on every bearing at
 * 140 m out, and 360 m from the nearest shoreline. If the terrain ever changes under it, the
 * same scan finds the new one instead of leaving a raft of boats sitting on a hill.
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
/** How much deeper it has to be all round before a shallow patch counts as a BAR. */
const RELIEF_M = 0.3;
/** ...measured at this radius. */
const RING_R = 140;
/** And this far from any beach, or it is just the shallows off a shore. */
const MIN_SHORE_D = 260;
/** Radius of the sand dome, metres. */
const BAR_R = 58;
/** Boats are hidden past this; the party is a thing you come across. */
const SHOW_M = 900;

export interface Sandbar {
  group: THREE.Group;
  /** Null if the bathymetry has no bar in it — then there is simply no sandbar this world. */
  site: { x: number; z: number } | null;
  update(dt: number, t: number, camera: { x: number; y: number; z: number }): void;
  debug(): { x: number; z: number; depth: number; boats: number; visible: boolean } | null;
  dispose(): void;
}

/**
 * Score the bathymetry for a genuine bar. Exported so a test can assert the one we found really
 * is shallow, really is surrounded by deeper water, and really is off on its own.
 */
export function findSandbar(): { x: number; z: number; depth: number; relief: number } | null {
  let best: { x: number; z: number; depth: number; relief: number } | null = null;
  for (let x = -3200; x <= 3200; x += 60) {
    for (let dz = -1200; dz <= 800; dz += 40) {
      const z = chainZ(x) + dz;
      const d = depthAt(x, z);
      if (d < CREST_MIN || d > CREST_MAX) continue;
      if (landH(x, z) > 0.02) continue;
      if (shoreInfo(x, z).d < MIN_SHORE_D) continue;
      let ring = Infinity;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        ring = Math.min(ring, depthAt(x + Math.cos(th) * RING_R, z + Math.sin(th) * RING_R));
      }
      const relief = ring - d;
      if (relief < RELIEF_M) continue;
      if (!best || relief > best.relief) best = { x, z, depth: d, relief };
    }
  }
  return best;
}

export function createSandbar(scene: THREE.Scene): Sandbar {
  const group = new THREE.Group();
  group.name = 'sandbar';
  scene.add(group);

  const found = findSandbar();
  const humans = createHumanRegistry();
  const boats: Array<{ model: BoatModel; x: number; z: number; yaw: number; ph: number; len: number; beam: number }> = [];
  const floats: THREE.Mesh[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };
  const M = (c: number, o: { rough?: number } = {}): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: o.rough ?? 0.95, flatShading: true });
    mats.push(m);
    return m;
  };

  if (found) {
    const { x: bx, z: bz } = found;

    // ---- the bank itself: a shallow dome, palest where it almost dries.
    const seg = 28;
    const dome = keep(new THREE.CircleGeometry(BAR_R, seg).rotateX(-Math.PI / 2));
    const pos = dome.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const c0 = new THREE.Color(0xe8dcb8), c1 = new THREE.Color(0x9fb098);
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), pz = pos.getZ(i);
      const r = Math.min(1, Math.hypot(px, pz) / BAR_R);
      // Dome: proud in the middle, feathered to nothing at the rim so there is no visible edge.
      pos.setY(i, Math.cos(r * Math.PI / 2) * (found.depth - 0.12));
      const c = c1.clone().lerp(c0, Math.pow(1 - r, 1.4));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    dome.setAttribute('color', new THREE.BufferAttribute(col, 3));
    dome.computeVertexNormals();
    const sandM = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    mats.push(sandM);
    const sand = new THREE.Mesh(dome, sandM);
    sand.position.set(bx, -found.depth, bz);
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
      const x = bx + Math.cos(a) * r, z = bz + Math.sin(a) * r;
      const model = makeBoat(spec, deps);
      group.add(model.group);
      boats.push({ model, x, z, yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) + Math.PI / 2, ph: rand(0, 6.28), len: spec.len, beam: spec.beam });
    });

    // ---- the people, standing in it. This is the whole picture: everybody out of the boats.
    for (let i = 0; i < 14; i++) {
      const a = arc0 + (hashCell(WORLD_SEED, i, 3, SALT.HOUSE_ROT) - 0.5) * 2.4;
      const r = BAR_R * (0.15 + hashCell(WORLD_SEED, i, 4, SALT.HOUSE_ROT) * 0.66);
      const hx = bx + Math.cos(a) * r, hz = bz + Math.sin(a) * r;
      // Waist deep: the dome's own height here decides how far down they are standing.
      const rr = Math.min(1, r / BAR_R);
      const bedY = -found.depth + Math.cos(rr * Math.PI / 2) * (found.depth - 0.12);
      const h = humans.makeHuman({ bikini: i % 2 === 0 } as never);
      h.group.position.set(hx, bedY, hz);
      h.group.rotation.y = hashCell(WORLD_SEED, i, 5, SALT.HOUSE_ROT) * Math.PI * 2;
      group.add(h.group);
    }

    // ---- floats and a cooler or two drifting between the boats.
    for (let i = 0; i < 9; i++) {
      const a = arc0 + (hashCell(WORLD_SEED, i, 6, SALT.HOUSE_ROT) - 0.5) * 2.2;
      const r = BAR_R * (0.45 + hashCell(WORLD_SEED, i, 7, SALT.HOUSE_ROT) * 0.6);
      const ring = i % 3 === 2
        ? new THREE.Mesh(keep(new THREE.BoxGeometry(0.9, 0.5, 0.6)), M(0xf2f2f2, { rough: 0.6 }))
        : new THREE.Mesh(keep(new THREE.TorusGeometry(0.62, 0.21, 7, 14).rotateX(-Math.PI / 2)),
          M([0xf2c14e, 0xe4572e, 0x2bb3a8, 0xf07aa0][i % 4], { rough: 0.55 }));
      ring.position.set(bx + Math.cos(a) * r, 0, bz + Math.sin(a) * r);
      group.add(ring);
      floats.push(ring);
    }
  }

  function update(dt: number, t: number, camera: { x: number; y: number; z: number }): void {
    if (!found) return;
    const near = Math.hypot(found.x - camera.x, found.z - camera.z) < SHOW_M;
    group.visible = near;
    if (!near) return;
    humans.updateHumans(t, new THREE.Vector3(camera.x, camera.y, camera.z), 0);
    const amp = ampAt(found.x, found.z);
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
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), hl = b.len * 0.45;
      const hbow = waveHBase(b.x + fx * hl, b.z + fz * hl, t, amp);
      const hstern = waveHBase(b.x - fx * hl, b.z - fz * hl, t, amp);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw), hw = b.beam * 0.5;
      const hport = waveHBase(b.x - rx * hw, b.z - rz * hw, t, amp);
      const hstbd = waveHBase(b.x + rx * hw, b.z + rz * hw, t, amp);
      b.model.group.position.set(b.x, (hbow + hstern) / 2, b.z);
      b.model.group.rotation.set(
        Math.atan2(hbow - hstern, b.len),
        yaw,
        Math.atan2(hport - hstbd, b.beam) * 0.85,
        'YXZ',
      );
    }
    for (let i = 0; i < floats.length; i++) {
      const f = floats[i];
      f.position.y = waveHBase(f.position.x, f.position.z, t, amp) + 0.06;
      f.rotation.y += dt * 0.12 * (i % 2 ? 1 : -1);
    }
  }

  return {
    group,
    site: found ? { x: found.x, z: found.z } : null,
    update,
    debug: () => (found ? {
      x: found.x, z: found.z, depth: +found.depth.toFixed(2), boats: boats.length, visible: group.visible,
    } : null),
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
