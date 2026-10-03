/**
 * US-1 and the Seven Mile Bridge (current + old bridge), including collidable pilings.
 *
 * Ported faithfully from legacy/index.html:798-826. Piling positions here are already fully
 * deterministic in legacy (stepped directly from world x, no `Math.random()` at all), so no
 * seeding change was needed — see docs/ARCHITECTURE.md "Seeding" and this project's report.
 *
 * Legacy collected pilings into a `PGRID` spatial hash (`Map<string, Piling[]>`) purely as a
 * performance optimisation for the boat's collision loop. The pure `stepBoat`
 * (packages/shared/src/sim/boat.ts) instead takes a flat `Piling[]` and scans it directly —
 * behaviourally identical (the grid never changes *which* pilings are within collision range,
 * only how fast you find them), and simpler to keep in lockstep with the physics oracle. So
 * this module just returns the flat list; nothing here builds a grid.
 */
import * as THREE from 'three';
import { chainZ, shoreInfo } from '@keysrun/shared/world/chain';
import { landH, OLDBR, WB } from '@keysrun/shared/world/depth';
import type { Piling } from '@keysrun/shared/sim/boat';
import { grainTex, normalTex } from '../core/textures.js';

interface Deck { mx: number; mz: number; ang: number; len: number; h: number; old: boolean }
interface Rail { mx: number; mz: number; ang: number; h: number }
interface Road { mx: number; mz: number; ang: number; len: number; y: number }
/** Piling plus the deck height at its position, for the mesh's vertical extent only — not part
 * of the physics `Piling` shape (packages/shared/src/sim/boat.ts), which doesn't need it. */
interface VisualPiling { x: number; z: number; h: number; old: boolean }

const ss0 = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface BridgeResult {
  group: THREE.Group;
  pilings: Piling[];
}

export function createBridge(): BridgeResult {
  const group = new THREE.Group();
  const dummy = new THREE.Object3D();
  const decks: Deck[] = [], rails: Rail[] = [], piles: VisualPiling[] = [], roads: Road[] = [];
  const STEP = 24;

  const build = (x0: number, x1: number, dzOff: number, deckH: number, old: boolean, gap: [number, number] | null) => {
    for (let x = x0; x < x1; x += STEP) {
      const xa = x, xb = x + STEP;
      if (gap && xb > gap[0] && xa < gap[1]) continue;
      const za = chainZ(xa) + dzOff, zb = chainZ(xb) + dzOff, mx = (xa + xb) / 2, mz = (za + zb) / 2;
      const ang = Math.atan2(zb - za, xb - xa), len = Math.hypot(xb - xa, zb - za);
      const sd = shoreInfo(mx, mz).d, lh = landH(mx, mz);
      if (lh > 0.9 && sd < -4) { if (!old) roads.push({ mx, mz, ang, len, y: lh }); continue; }
      if (old && sd < 1) continue;
      const h = old ? deckH : sd < 0 ? 5.6 : 2.6 + (deckH - 2.6) * ss0(0, 70, sd);
      decks.push({ mx, mz, ang, len, h, old });
      if (!old) rails.push({ mx, mz, ang, h });
      if (sd > 1 && (x / STEP) % (old ? 2 : 1) === 0) {
        const px = -Math.sin(ang), pz = Math.cos(ang);
        for (const sg of old ? [0] : [-1, 1]) {
          piles.push({ x: xa + px * 3.2 * sg, z: za + pz * 3.2 * sg, h, old });
        }
      }
    }
  };
  build(WB.x0, WB.x1, 0, 7.2, false, null);
  build(OLDBR.x0, OLDBR.x1, OLDBR.dz, 6.2, true, OLDBR.gap);

  // Part 2 item 6: concrete deck/piling bump so the bridge doesn't read as a flat-shaded extrusion
  // even at the 1,900 m vantage a boat running Hawk Channel sees it from.
  const concreteNormal = normalTex([8, 2], 0.55);
  const dm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 10), new THREE.MeshStandardMaterial({ color: 0xe2dccb, flatShading: true, roughness: 0.9, map: grainTex([4, 1], 0.85, 1.05), normalMap: concreteNormal, normalScale: new THREE.Vector2(0.5, 0.5) }), decks.length);
  const col = new THREE.Color();
  decks.forEach((d, i) => {
    dummy.position.set(d.mx, d.h, d.mz); dummy.rotation.set(0, -d.ang, 0); dummy.scale.set(d.len + 0.4, d.old ? 0.8 : 1, d.old ? 0.75 : 1); dummy.updateMatrix();
    dm.setMatrixAt(i, dummy.matrix);
    dm.setColorAt(i, col.setHex(d.old ? 0xb9ad98 : 0xe2dccb));
  });

  const rlm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.6, 0.3), new THREE.MeshStandardMaterial({ color: 0xf3efe4 }), rails.length * 2);
  rails.forEach((r, i) => {
    const px = -Math.sin(r.ang), pz = Math.cos(r.ang);
    [-1, 1].forEach((sg, k) => {
      dummy.position.set(r.mx + px * 4.8 * sg, r.h + 0.8, r.mz + pz * 4.8 * sg); dummy.rotation.set(0, -r.ang, 0); dummy.scale.set(STEP + 0.4, 1, 1); dummy.updateMatrix();
      rlm.setMatrixAt(i * 2 + k, dummy.matrix);
    });
  });

  const roadM = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.1, 9), new THREE.MeshStandardMaterial({ color: 0x3e4146, roughness: 0.95, map: grainTex([4, 1], 0.8, 1.05) }), roads.length);
  roads.forEach((r, i) => {
    dummy.position.set(r.mx, r.y + 0.12, r.mz); dummy.rotation.set(0, -r.ang, 0); dummy.scale.set(r.len + 0.3, 1, 1); dummy.updateMatrix();
    roadM.setMatrixAt(i, dummy.matrix);
  });

  const pm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.65, 0.8, 1, 8), new THREE.MeshStandardMaterial({ color: 0xd6cfbd, flatShading: true, roughness: 0.92, normalMap: concreteNormal, normalScale: new THREE.Vector2(0.4, 0.4) }), piles.length);
  piles.forEach((p, i) => {
    const top = p.h - 0.4, bot = -3;
    dummy.position.set(p.x, (top + bot) / 2, p.z); dummy.rotation.set(0, 0, 0); dummy.scale.set(p.old ? 1.6 : 1, top - bot, p.old ? 1.6 : 1); dummy.updateMatrix();
    pm.setMatrixAt(i, dummy.matrix);
  });

  dm.castShadow = dm.receiveShadow = true;
  group.add(dm, rlm, roadM, pm);

  const pilings: Piling[] = piles.map((p) => ({ x: p.x, z: p.z, old: p.old }));
  return { group, pilings };
}
