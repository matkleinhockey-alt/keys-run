/**
 * The public fishing piers (shared world/piers.ts), drawn: a weathered plank walkway on paired
 * pilings, a rail either side once it is over the water, the T at the end with a bench and a
 * cleaning table, and a lamp post at each corner of the T. Everything is one batched geometry
 * (entities/town/batch.ts), so all of them together cost one draw call.
 */
import * as THREE from 'three';
import { PIERS, PIER_TOP, PIER_W, HEAD_W, HEAD_D } from '@keysrun/shared/world/piers';
import { landH } from '@keysrun/shared/world/depth';
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

  const mesh = new THREE.Mesh(g.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}
