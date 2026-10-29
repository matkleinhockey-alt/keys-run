/**
 * The public fishing piers (shared world/piers.ts), drawn: a weathered plank walkway on paired
 * pilings, a rail either side once it is over the water, the T at the end with a bench and a
 * cleaning table, and a lamp post at each corner of the T. Also the Old Seven Mile Bridge's
 * fishing-pier furniture (shared world/old-bridge.ts): a rail down each side of its deck, and the
 * ramps up to it. Everything is one batched geometry (entities/town/batch.ts), so all of it
 * together costs one draw call.
 */
import * as THREE from 'three';
import { PIERS, PIER_TOP, PIER_W, HEAD_W, HEAD_D } from '@keysrun/shared/world/piers';
import { landH } from '@keysrun/shared/world/depth';
import { OLD_DECK_SEGS, OLD_RAMPS, OLD_DECK_TOP } from '@keysrun/shared/world/old-bridge';
import { GeoBatch } from '../entities/town/batch.js';

const PLANK = 0x9c8a70;
const PILE = 0x5f5346;
const RAIL = 0xd8d2c4;
const STEEL = 0x8a8f94;
const DECK_T = 0.24;
const RAIL_H = 1.05;

export function createPiers(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'piers';
  const g = new GeoBatch(false, 1.15);

  for (const p of PIERS) {
    const ry = Math.atan2(p.nx, p.nz);
    // (along, across) in the pier's frame -> world
    const at = (a: number, c: number): [number, number] => [p.x0 + p.nx * a - p.nz * c, p.z0 + p.nz * a + p.nx * c];
    const top = PIER_TOP, y = top - DECK_T / 2;
    const walk = p.len - HEAD_D / 2;

    // the walkway, then the T
    const [wx, wz] = at(walk / 2, 0);
    g.box(wx, y, wz, PIER_W, DECK_T, walk, PLANK, { ry });
    const [hx, hz] = at(p.len, 0);
    g.box(hx, y, hz, HEAD_W, DECK_T, HEAD_D, PLANK, { ry });

    // pilings in pairs every 4 m, down into the bottom; none where the deck sits on the ground
    const pile = (a: number, c: number) => {
      const [x, z] = at(a, c);
      const ground = landH(x, z);
      if (ground > top - 0.6) return;
      const bottom = Math.min(ground, -0.5) - 1.5;
      g.cyl(x, bottom, z, 0.16, 0.19, top - DECK_T - bottom, PILE, 7);
    };
    for (let a = 2; a < walk; a += 4) { pile(a, -PIER_W / 2 + 0.15); pile(a, PIER_W / 2 - 0.15); }
    for (let c = -HEAD_W / 2 + 0.3; c <= HEAD_W / 2 - 0.3; c += 3.4) { pile(p.len - HEAD_D / 2 + 0.3, c); pile(p.len + HEAD_D / 2 - 0.3, c); }

    // rails over the water: posts and a top rail each side
    let railFrom = walk;
    for (let a = 0; a < walk; a += 1) { const [x, z] = at(a, 0); if (landH(x, z) < 0) { railFrom = a; break; } }
    const railLen = walk - railFrom;
    if (railLen > 1) {
      for (const side of [-1, 1]) {
        const c = side * (PIER_W / 2 - 0.06);
        const [rx, rz] = at(railFrom + railLen / 2, c);
        g.box(rx, top + RAIL_H, rz, 0.08, 0.08, railLen, RAIL, { ry });
        g.box(rx, top + RAIL_H * 0.5, rz, 0.05, 0.05, railLen, RAIL, { ry });
        for (let a = railFrom; a <= walk; a += 2.5) {
          const [px, pz] = at(a, c);
          g.box(px, top + RAIL_H / 2, pz, 0.1, RAIL_H, 0.1, RAIL, { ry });
        }
      }
    }
    // the T's rail: across the far end and round its two ends, open where the walkway joins
    {
      const [ex, ez] = at(p.len + HEAD_D / 2 - 0.06, 0);
      g.box(ex, top + RAIL_H, ez, HEAD_W, 0.08, 0.08, RAIL, { ry });
      for (const side of [-1, 1]) {
        const [sx, sz] = at(p.len, side * (HEAD_W / 2 - 0.06));
        g.box(sx, top + RAIL_H, sz, 0.08, 0.08, HEAD_D, RAIL, { ry });
        for (const da of [-HEAD_D / 2, 0, HEAD_D / 2]) {
          const [px, pz] = at(p.len + da, side * (HEAD_W / 2 - 0.06));
          g.box(px, top + RAIL_H / 2, pz, 0.1, RAIL_H, 0.1, RAIL, { ry });
        }
        // the back rail either side of the walkway
        const back = (HEAD_W - PIER_W) / 2;
        const [bx, bz] = at(p.len - HEAD_D / 2 + 0.06, side * (PIER_W / 2 + back / 2));
        g.box(bx, top + RAIL_H, bz, back, 0.08, 0.08, RAIL, { ry });
        // a lamp post at each outer corner
        const [lx, lz] = at(p.len + HEAD_D / 2 - 0.4, side * (HEAD_W / 2 - 0.4));
        g.cyl(lx, top, lz, 0.06, 0.08, 3.6, STEEL, 6);
        g.box(lx, top + 3.65, lz, 0.4, 0.18, 0.4, 0xf6efd8);
      }
      for (let c = -HEAD_W / 2 + 1; c < HEAD_W / 2 - 1; c += 3) {
        const [px, pz] = at(p.len + HEAD_D / 2 - 0.06, c);
        g.box(px, top + RAIL_H / 2, pz, 0.1, RAIL_H, 0.1, RAIL, { ry });
      }
    }
    // a bench facing out, and a fish-cleaning table
    const [bx, bz] = at(p.len - 0.6, -HEAD_W / 4);
    g.box(bx, top + 0.45, bz, 2.2, 0.08, 0.5, PLANK, { ry });
    g.box(bx, top + 0.22, bz, 2.0, 0.44, 0.1, PILE, { ry });
    const [tx, tz] = at(p.len - 0.6, HEAD_W / 4);
    g.box(tx, top + 0.9, tz, 1.6, 0.08, 0.7, 0xe9e6de, { ry });
    g.box(tx, top + 0.45, tz, 0.12, 0.9, 0.5, STEEL, { ry });
  }

  // ---- the Old Seven Mile Bridge: rails along the deck, and the ramps
  const CONCRETE = 0xb9ad98;
  for (const sgm of OLD_DECK_SEGS) {
    const ux = sgm.xb - sgm.xa, uz = sgm.zb - sgm.za, L = Math.hypot(ux, uz), ry = Math.atan2(ux / L, uz / L);
    for (const side of [-1, 1]) {
      const ox = (-uz / L) * 3.6 * side, oz = (ux / L) * 3.6 * side;
      const mx = (sgm.xa + sgm.xb) / 2 + ox, mz = (sgm.za + sgm.zb) / 2 + oz;
      g.box(mx, OLD_DECK_TOP + RAIL_H, mz, 0.09, 0.09, L + 0.4, RAIL, { ry });
      for (let a = 0; a < L; a += 3) {
        g.box(sgm.xa + (ux / L) * a + ox, OLD_DECK_TOP + RAIL_H / 2, sgm.za + (uz / L) * a + oz, 0.12, RAIL_H, 0.12, RAIL, { ry });
      }
    }
  }
  for (const r of OLD_RAMPS) {
    const ry = Math.atan2(r.dx, r.dz);
    // half-metre slabs stepping down: at 1 in 9 that reads as a smooth ramp
    for (let s = 0; s < r.len; s += 0.5) {
      const y = OLD_DECK_TOP + (r.foot - OLD_DECK_TOP) * (s + 0.25) / r.len;
      const x = r.x0 + r.dx * (s + 0.25), z = r.z0 + r.dz * (s + 0.25);
      g.box(x, y - 0.3, z, 4, 0.6, 0.52, CONCRETE, { ry });
      for (const side of [-1, 1]) {
        if (Math.round(s * 2) % 6 === 0) g.box(x - r.dz * 1.95 * side, y + RAIL_H / 2, z + r.dx * 1.95 * side, 0.1, RAIL_H, 0.1, RAIL, { ry });
      }
    }
    for (const side of [-1, 1]) {
      // the hand rail, laid along the slope
      const mx = r.x0 + r.dx * r.len / 2 - r.dz * 1.95 * side, mz = r.z0 + r.dz * r.len / 2 + r.dx * 1.95 * side;
      g.box(mx, (OLD_DECK_TOP + r.foot) / 2 + RAIL_H, mz, 0.08, 0.08, Math.hypot(r.len, OLD_DECK_TOP - r.foot), RAIL, { ry, rx: Math.atan2(OLD_DECK_TOP - r.foot, r.len) });
    }
    // columns under the high end
    for (let s = 4; s < r.len * 0.7; s += 8) {
      const y = OLD_DECK_TOP + (r.foot - OLD_DECK_TOP) * s / r.len, x = r.x0 + r.dx * s, z = r.z0 + r.dz * s;
      const gnd = Math.min(landH(x, z), y - 0.6);
      g.box(x, (gnd + y - 0.6) / 2, z, 0.5, y - 0.6 - gnd, 0.5, CONCRETE, { ry });
    }
  }

  const mesh = new THREE.Mesh(g.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}
