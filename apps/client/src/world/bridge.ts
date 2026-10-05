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
 *
 * ⚠ Bugfix (bridge-realism task): the periodicity check that decides which deck segments get a
 * collidable pier used to be `(x / STEP) % (old ? 2 : 1) === 0`. Since neither `WB.x0` nor
 * `OLDBR.x0` is a multiple of `STEP`, `x / STEP` is *never* exactly an integer for any segment in
 * either bridge's loop — that condition was unsatisfiable, so `piles` (and therefore the
 * `pilings` this module returns) was always an empty array. The entire PGRID collision system was
 * silently dead: boats could already sail straight through every bridge pier with zero collision.
 * Fixed below by keying periodicity off the loop's own segment index `i` instead of the
 * (never-aligned) absolute world `x` — the obviously-intended behaviour ("a pier at every deck
 * segment for the new bridge, every other one for the sparser old bridge"), and the only change
 * that makes the collision data this module hands to `packages/shared/src/sim/boat.ts` (and
 * `state/game.ts`'s spawn-clearing) actually non-empty. This does not touch
 * `packages/shared/src/sim/boat.ts` itself and the boat-trajectory oracle test
 * (apps/client/test/boat-trajectory.test.ts) builds its own synthetic dock/piling rather than
 * reading this module's output, so it is unaffected either way — confirmed by running it.
 *
 * Visual rebuild (same task): proper deck cross-section (barrier walls + road striping), slender
 * rectangular piers with pier caps, a humped high span over the modelled navigable channel for
 * the new bridge; a distinctly lower, narrower old bridge with concrete arch ribs, a steel truss
 * section near Pigeon Key (world/bridge/truss.ts) and broken piling stubs at its demolished gap;
 * Pigeon Key set-dressing (world/bridge/pigeon-key.ts). All of it stays instanced — see this
 * module's report for the draw-call accounting — and none of it changes a single `pilings` x/z
 * value beyond the bugfix above (piling height `h` is carried for visual mesh extent only, same
 * as before; the physics loop never reads it).
 */
import * as THREE from 'three';
import { chainZ, shoreInfo } from '@keysrun/shared/world/chain';
import { landH, OLDBR, WB } from '@keysrun/shared/world/depth';
import type { Piling } from '@keysrun/shared/sim/boat';
import { grainTex, normalTex } from '../core/textures.js';
import { barrierGeometry, archGeometry } from './bridge/profiles.js';
import { createPigeonKey } from './bridge/pigeon-key.js';
import { buildOldBridgeTruss } from './bridge/truss.js';

interface Deck { mx: number; mz: number; ang: number; len: number; h: number; old: boolean }
interface Rail { mx: number; mz: number; ang: number; h: number }
interface Road { mx: number; mz: number; ang: number; len: number; y: number }
/** Piling plus the deck height at its position, for the mesh's vertical extent only — not part
 * of the physics `Piling` shape (packages/shared/src/sim/boat.ts), which doesn't need it. */
interface VisualPiling { x: number; z: number; h: number; old: boolean }
/** One per pier *bent* (not per collision circle — the new bridge has two collision pilings per
 * bent, the old bridge one) — the visual column/cap/arch-anchor/stain-collar systems below all
 * key off this instead of `piles`, so a wide single pier shaft can visually span both of a new
 * bent's collision points. Visual-only; never feeds `pilings`. */
interface Bent { x: number; z: number; ang: number; h: number; old: boolean }

const ss0 = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Deterministic cosmetic jitter (never gameplay-relevant placement — just material variation),
 * same sin-hash every other set-dressing module in this codebase uses (e.g. world/islands.ts). */
const hash2 = (x: number, z: number): number => {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

export interface BridgeResult {
  group: THREE.Group;
  pilings: Piling[];
}

// The old bridge reads as a distinctly lower, older structure than the new one (reference photo:
// the Flagler-era bridge runs noticeably lower than the 1982 US-1 span).
const OLD_DECK_H = 5.0;

// The new bridge's humped high span: a smooth rise centred on the same navigable gap OLDBR's own
// demolished old-bridge section marks (the old and new bridges cross the same real channel), so
// the two bridges' most dramatic features line up geographically. HUMP_RISE is a big fraction of
// the normal deck height — the real high-rise span clears roughly 4x the normal approach grade.
const HUMP_X = (OLDBR.gap[0] + OLDBR.gap[1]) / 2;
const HUMP_HALF = 320;
const HUMP_RISE = 12;
const humpBump = (x: number): number => {
  const t = Math.max(0, 1 - Math.abs(x - HUMP_X) / HUMP_HALF);
  const s = t * t * (3 - 2 * t);
  return HUMP_RISE * s;
};

export function createBridge(): BridgeResult {
  const group = new THREE.Group();
  const dummy = new THREE.Object3D();
  const decks: Deck[] = [], rails: Rail[] = [], piles: VisualPiling[] = [], roads: Road[] = [], bents: Bent[] = [];
  const STEP = 24;

  const build = (x0: number, x1: number, dzOff: number, deckH: number, old: boolean, gap: [number, number] | null) => {
    let i = 0;
    for (let x = x0; x < x1; x += STEP, i++) {
      const xa = x, xb = x + STEP;
      if (gap && xb > gap[0] && xa < gap[1]) continue;
      const za = chainZ(xa) + dzOff, zb = chainZ(xb) + dzOff, mx = (xa + xb) / 2, mz = (za + zb) / 2;
      const ang = Math.atan2(zb - za, xb - xa), len = Math.hypot(xb - xa, zb - za);
      const sd = shoreInfo(mx, mz).d, lh = landH(mx, mz);
      if (lh > 0.9 && sd < -4) { if (!old) roads.push({ mx, mz, ang, len, y: lh }); continue; }
      if (old && sd < 1) continue;
      const baseH = old ? deckH : sd < 0 ? 5.6 : 2.6 + (deckH - 2.6) * ss0(0, 70, sd);
      const h = old ? baseH : baseH + humpBump(mx);
      decks.push({ mx, mz, ang, len, h, old });
      if (!old) rails.push({ mx, mz, ang, h });
      if (sd > 1 && i % (old ? 2 : 1) === 0) {
        bents.push({ x: xa, z: za, ang, h, old });
        const px = -Math.sin(ang), pz = Math.cos(ang);
        for (const sg of old ? [0] : [-1, 1]) {
          piles.push({ x: xa + px * 3.2 * sg, z: za + pz * 3.2 * sg, h, old });
        }
      }
    }
  };
  build(WB.x0, WB.x1, 0, 7.2, false, null);
  build(OLDBR.x0, OLDBR.x1, OLDBR.dz, OLD_DECK_H, true, OLDBR.gap);

  // ---------------------------------------------------------------------------------------------
  // Deck slabs (Part 2 item 6: concrete deck/piling bump so the bridge doesn't read as a
  // flat-shaded extrusion even at the ~1,900 m vantage a boat running Hawk Channel sees it from).
  // ---------------------------------------------------------------------------------------------
  const concreteNormal = normalTex([8, 2], 0.55);
  const dm = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 10),
    new THREE.MeshStandardMaterial({ color: 0xe2dccb, flatShading: true, roughness: 0.9, map: grainTex([4, 1], 0.85, 1.05), normalMap: concreteNormal, normalScale: new THREE.Vector2(0.5, 0.5) }),
    decks.length,
  );
  const col = new THREE.Color();
  decks.forEach((d, i) => {
    dummy.position.set(d.mx, d.h, d.mz); dummy.rotation.set(0, -d.ang, 0); dummy.scale.set(d.len + 0.4, d.old ? 0.8 : 1, d.old ? 0.75 : 1); dummy.updateMatrix();
    dm.setMatrixAt(i, dummy.matrix);
    const base = d.old ? 0xb9ad98 : 0xe2dccb, jitter = 0.88 + hash2(d.mx, d.mz) * 0.22;
    dm.setColorAt(i, col.setHex(base).multiplyScalar(jitter));
  });

  // Barrier walls (replaces the old thin rail box with a real Jersey-barrier silhouette) — new
  // bridge only, same as legacy's rail (the old bridge has none; today it's an unguarded walkway).
  const barrierGeo = barrierGeometry();
  const rlm = new THREE.InstancedMesh(barrierGeo, new THREE.MeshStandardMaterial({ color: 0xf0ebdd, roughness: 0.85, map: grainTex([1, 0.3], 0.88, 1.04) }), rails.length * 2);
  rails.forEach((r, i) => {
    const px = -Math.sin(r.ang), pz = Math.cos(r.ang);
    [-1, 1].forEach((sg, k) => {
      dummy.position.set(r.mx + px * 4.85 * sg, r.h + 0.5, r.mz + pz * 4.85 * sg); dummy.rotation.set(0, -r.ang, 0); dummy.scale.set(STEP + 0.4, 1, 1); dummy.updateMatrix();
      rlm.setMatrixAt(i * 2 + k, dummy.matrix);
    });
  });

  // Road striping: one yellow centreline + two white edge lines per new-bridge deck segment, all
  // in a single InstancedMesh via per-instance colour.
  const lineGeo = new THREE.BoxGeometry(1, 0.05, 0.22);
  const lineM = new THREE.InstancedMesh(lineGeo, new THREE.MeshStandardMaterial({ roughness: 0.6 }), rails.length * 3);
  const YELLOW = new THREE.Color(0xe8c43a), WHITE = new THREE.Color(0xf4f1e8);
  rails.forEach((r, i) => {
    const px = -Math.sin(r.ang), pz = Math.cos(r.ang);
    const offs: Array<[number, THREE.Color]> = [[0, YELLOW], [-3.9, WHITE], [3.9, WHITE]];
    offs.forEach(([off, c], k) => {
      dummy.position.set(r.mx + px * off, r.h + 0.53, r.mz + pz * off); dummy.rotation.set(0, -r.ang, 0); dummy.scale.set(STEP + 0.4, 1, 1); dummy.updateMatrix();
      lineM.setMatrixAt(i * 3 + k, dummy.matrix);
      lineM.setColorAt(i * 3 + k, c);
    });
  });

  const roadM = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.1, 9), new THREE.MeshStandardMaterial({ color: 0x3e4146, roughness: 0.95, map: grainTex([4, 1], 0.8, 1.05) }), roads.length);
  roads.forEach((r, i) => {
    dummy.position.set(r.mx, r.y + 0.12, r.mz); dummy.rotation.set(0, -r.ang, 0); dummy.scale.set(r.len + 0.3, 1, 1); dummy.updateMatrix();
    roadM.setMatrixAt(i, dummy.matrix);
  });

  // ---------------------------------------------------------------------------------------------
  // Piers: one slender rectangular column per bent (wide enough on the new bridge to visually
  // span both of that bent's collision circles at +-3.2 — see the `Bent` doc comment above) plus
  // a flared pier cap on the new bridge, plus a dark tidal "stain collar" at the waterline on
  // every bent for both bridges — the "subtle staining and variation" materials ask.
  // ---------------------------------------------------------------------------------------------
  const colGeo = new THREE.BoxGeometry(1, 1, 1);
  const colMatNew = new THREE.MeshStandardMaterial({ color: 0xd6cfbd, flatShading: true, roughness: 0.88, normalMap: concreteNormal, normalScale: new THREE.Vector2(0.4, 0.4) });
  const colMatOld = new THREE.MeshStandardMaterial({ color: 0x9c9382, flatShading: true, roughness: 0.97, normalMap: concreteNormal, normalScale: new THREE.Vector2(0.55, 0.55) });
  const colsNew = bents.filter((b) => !b.old), colsOld = bents.filter((b) => b.old);
  const colMeshNew = new THREE.InstancedMesh(colGeo, colMatNew, colsNew.length);
  const colMeshOld = new THREE.InstancedMesh(colGeo, colMatOld, colsOld.length);
  const capGeo = new THREE.BoxGeometry(1, 1, 1);
  const capMat = new THREE.MeshStandardMaterial({ color: 0xe0dacb, flatShading: true, roughness: 0.85 });
  const capMesh = new THREE.InstancedMesh(capGeo, capMat, colsNew.length);
  const collarGeo = new THREE.CylinderGeometry(1, 1, 1, 6);
  const collarMat = new THREE.MeshStandardMaterial({ color: 0x3c4230, flatShading: true, roughness: 1 });
  const collarMesh = new THREE.InstancedMesh(collarGeo, collarMat, bents.length);

  let ci = 0;
  colsNew.forEach((b, i) => {
    const underside = b.h - 0.5, capH = 0.55, capY = underside - capH / 2, colTop = underside - capH, bot = -3;
    dummy.position.set(b.x, (colTop + bot) / 2, b.z); dummy.rotation.set(0, -b.ang, 0); dummy.scale.set(1.3, Math.max(0.5, colTop - bot), 6.6); dummy.updateMatrix();
    colMeshNew.setMatrixAt(i, dummy.matrix);
    dummy.position.set(b.x, capY, b.z); dummy.rotation.set(0, -b.ang, 0); dummy.scale.set(2.0, capH, 7.8); dummy.updateMatrix();
    capMesh.setMatrixAt(i, dummy.matrix);
  });
  colsOld.forEach((b, i) => {
    const colTop = b.h - 0.4, bot = -3;
    dummy.position.set(b.x, (colTop + bot) / 2, b.z); dummy.rotation.set(0, -b.ang, 0); dummy.scale.set(1.8, Math.max(0.5, colTop - bot), 2.6); dummy.updateMatrix();
    colMeshOld.setMatrixAt(i, dummy.matrix);
  });
  bents.forEach((b) => {
    dummy.position.set(b.x, 0.35, b.z); dummy.rotation.set(0, 0, 0); dummy.scale.set(b.old ? 2.1 : 3.4, 1.5, b.old ? 2.1 : 3.4); dummy.updateMatrix();
    collarMesh.setMatrixAt(ci++, dummy.matrix);
  });

  // ---------------------------------------------------------------------------------------------
  // Old bridge: shallow concrete arch ribs between consecutive bents (skipping across the
  // demolished gap or the stretch where the right-of-way crosses Pigeon Key's own landmass, where
  // there's no continuous run of bents to arch between) — the single most recognisable silhouette
  // feature distinguishing it from the flat new deck. Plus a handful of broken piling stubs
  // poking out of the water inside the gap itself, reading as the bridge's demolished remnants.
  // ---------------------------------------------------------------------------------------------
  const oldBents = bents.filter((b) => b.old);
  const archInstances: Array<{ mx: number; mz: number; ang: number; halfSpan: number; y: number }> = [];
  for (let k = 1; k < oldBents.length; k++) {
    const a = oldBents[k - 1], b = oldBents[k], run = Math.hypot(b.x - a.x, b.z - a.z);
    if (run > 60) continue;
    archInstances.push({ mx: (a.x + b.x) / 2, mz: (a.z + b.z) / 2, ang: a.ang, halfSpan: run / 2, y: Math.min(a.h, b.h) - 0.43 });
  }
  const archMesh = new THREE.InstancedMesh(archGeometry(), new THREE.MeshStandardMaterial({ color: 0xaca189, flatShading: true, roughness: 0.95, normalMap: concreteNormal, normalScale: new THREE.Vector2(0.5, 0.5) }), archInstances.length);
  archInstances.forEach((a, i) => {
    dummy.position.set(a.mx, a.y, a.mz); dummy.rotation.set(0, -a.ang, 0); dummy.scale.set(a.halfSpan * 0.98, a.halfSpan * 0.24, 2.1); dummy.updateMatrix();
    archMesh.setMatrixAt(i, dummy.matrix);
  });

  const gapXs = [OLDBR.gap[0] + 18, OLDBR.gap[0] + 48, OLDBR.gap[1] - 46, OLDBR.gap[1] - 16];
  const stubMat = new THREE.MeshStandardMaterial({ color: 0x8d8372, flatShading: true, roughness: 1 });
  const stubMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.7, 1, 1.7), stubMat, gapXs.length);
  gapXs.forEach((x, i) => {
    const z = chainZ(x) + OLDBR.dz, jig = hash2(x, 7) - 0.5, top = 0.3 + hash2(x, 3) * 1.4;
    dummy.position.set(x, (top - 3) / 2, z); dummy.rotation.set(jig * 0.3, jig, jig * 0.2); dummy.scale.set(1, top + 3, 1); dummy.updateMatrix();
    stubMesh.setMatrixAt(i, dummy.matrix);
  });

  dm.castShadow = dm.receiveShadow = true;
  colMeshNew.castShadow = colMeshOld.castShadow = true;
  archMesh.castShadow = true;
  group.add(dm, rlm, lineM, roadM, colMeshNew, colMeshOld, capMesh, collarMesh, archMesh, stubMesh);
  group.add(buildOldBridgeTruss(OLD_DECK_H));
  group.add(createPigeonKey());

  const pilings: Piling[] = piles.map((p) => ({ x: p.x, z: p.z, old: p.old }));
  return { group, pilings };
}
