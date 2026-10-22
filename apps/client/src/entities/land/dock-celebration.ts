/**
 * The dockside trophy: when you tie up, the biggest fish of the run is strung up on a weigh
 * station on the planks and a crowd gathers round it — phones up and flashing, arms in the air,
 * clapping. The way a big fish actually comes in at a Keys marina.
 *
 * Owned by the land facade (entities/land/index.ts), which already knows the moment you step
 * ashore and where the mooring is. It gets the run's best fish through `LandDeps.getRunBest`
 * (game/catch/catch-flow.ts's `session.biggest`), so nothing here knows about fishing.
 *
 * Lifecycle:
 *   - Stepping ashore with a fish that has not been celebrated yet builds the station and a full
 *     crowd at that dock, which goes wild for ~15 s and then settles into admiring and snapping.
 *   - Stepping ashore again with the same best fish: it is still hanging there (wherever it was
 *     first shown), with a few admirers. A bigger fish later replaces it.
 *   - Going back aboard: the crowd disperses (hidden), the fish stays on display.
 * A released fish still gets its moment — the sign says it went back, so the hanging fish reads as
 * the replica mount it is rather than a carcass.
 */
import * as THREE from 'three';
import { SPECIES } from '@keysrun/shared/content/species';
import { scaledLenM } from '@keysrun/shared/sim/fight';
import { groundAt } from '@keysrun/shared/world/town';
import { makeHuman, type Human } from '../life/human.js';
import { beamBetween } from '../boat/hull.js';
import { makeFishMesh } from '../../game/fishing/fish-mesh.js';

export interface RunBest {
  key: string;
  weight: number;
  /** Identifies one landed fish, so the same best fish is only celebrated once. */
  id: number;
  released: boolean;
  boatName: string;
}

export interface DockSpot { dockX: number; dockZ: number; boatX: number; boatZ: number }

type Role = 'phone' | 'cheer' | 'clap';

interface Fan {
  h: Human;
  role: Role;
  base: THREE.Vector3;
  flash: THREE.Mesh | null;
  nextFlash: number;
  flashT: number;
  /** Admirers stay when the crowd thins out on a repeat visit. */
  core: boolean;
}

const HYPE_S = 15;
const SKINS = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0xffdbac, 0x6b4226, 0xd9a27f];
const SHIRTS = [0xffffff, 0x2f8fd8, 0xf26b5b, 0x3fb68b, 0xf4c542, 0x8a5cc2, 0x1f2f46, 0xff8c42, 0x9ad0ec];
const SHORTS = [0x2b4a6e, 0xc9b38a, 0x3b3b3b, 0x6e7f5c, 0x7a8ca3];
const _hl = new THREE.Vector3(), _hr = new THREE.Vector3();
const FEET_L = new THREE.Vector3(-0.105, 0.085, 0), FEET_R = new THREE.Vector3(0.105, 0.085, 0);

const pick = <T,>(a: readonly T[], i: number): T => a[((i % a.length) + a.length) % a.length];

/** Picks a spot on the planks a short walk from where you stepped off (far enough that the first
 * thing you see is the whole scene, not a gantry post in your face), away from the boat, with room
 * for a crowd around it. Returns null when the dock is too cramped for anything sensible. */
function findStation(spot: DockSpot): { x: number; z: number; y: number } | null {
  const boatD = Math.hypot(spot.dockX - spot.boatX, spot.dockZ - spot.boatZ);
  let best: { x: number; z: number; y: number; score: number } | null = null;
  for (let r = 7; r <= 18; r++) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const x = spot.dockX + Math.cos(a) * r, z = spot.dockZ + Math.sin(a) * r;
      const y = groundAt(x, z);
      if (y === null || Math.hypot(x - spot.boatX, z - spot.boatZ) < boatD + 1) continue;
      let room = 0;
      for (let j = 0; j < 12; j++) {
        const b = (j / 12) * Math.PI * 2;
        const g = groundAt(x + Math.cos(b) * 3, z + Math.sin(b) * 3);
        if (g !== null && Math.abs(g - y) < 0.3) room++;
      }
      const score = room * 10 - r;
      if (!best || score > best.score) best = { x, z, y, score };
    }
  }
  return best && best.score > 20 ? best : null;
}

function signTexture(lines: Array<[string, string]>): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0d2a44'; g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#f4c542'; g.lineWidth = 10; g.strokeRect(8, 8, 496, 240);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach(([font, text], i) => {
    g.font = font;
    g.fillStyle = i === 1 ? '#f4c542' : '#ffffff';
    g.fillText(text, 256, 52 + i * 66, 470);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createDockCelebration(deps: { scene: THREE.Scene; onBuilt(root: THREE.Object3D): void; toast(msg: string): void }) {
  let station: THREE.Group | null = null;
  let crowd: THREE.Group | null = null;
  let fans: Fan[] = [];
  let shownId = -1;
  let hypeT = Infinity;
  let fishCenter = new THREE.Vector3();
  let where: { x: number; z: number; y: number } | null = null;

  function disposeGeometry(root: THREE.Object3D): void {
    root.traverse((o) => { if (o instanceof THREE.Mesh && !o.userData.keep) o.geometry.dispose(); });
  }

  function clear(): void {
    if (station) { deps.scene.remove(station); disposeGeometry(station); station = null; }
    if (crowd) { deps.scene.remove(crowd); disposeGeometry(crowd); crowd = null; }
    fans = [];
    where = null;
  }

  function buildStation(best: RunBest, at: { x: number; z: number; y: number }, face: { x: number; z: number }): void {
    const S = SPECIES[best.key];
    const lenM = scaledLenM(best.key, best.weight);
    const g = new THREE.Group();
    g.position.set(at.x, at.y, at.z);
    // Local +x faces the crowd (and the fish's flank with it); the crossbar runs along local z.
    g.rotation.y = Math.atan2(-face.z, face.x);

    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.85 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 0.85, roughness: 0.25 });
    const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
    // Hung high enough that the fish clears the crowd's heads from where you walk up.
    const top = Math.max(3.6, lenM + 2.2);
    const half = Math.max(1.1, lenM * 0.35);
    g.add(beamBetween(V(0, 0, -half), V(0, top, -half), 0.08, wood));
    g.add(beamBetween(V(0, 0, half), V(0, top, half), 0.08, wood));
    g.add(beamBetween(V(0, top, -half - 0.15), V(0, top, half + 0.15), 0.07, wood));

    // Scale and hook, then the fish hung by the tail (same convention as catch-flow's gin pole).
    const scale = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 20), new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.4 }));
    scale.rotation.z = Math.PI / 2; scale.position.set(0, top - 0.3, 0);
    g.add(scale);
    g.add(beamBetween(V(0, top, 0), V(0, top - 0.24, 0), 0.01, steel));
    g.add(beamBetween(V(0, top - 0.36, 0), V(0, top - 0.6, 0), 0.01, steel));
    const fish = makeFishMesh(S.color, lenM);
    fish.traverse((o) => { o.userData.keep = true; }); // shared creature geometry — see clear()
    fish.rotation.set(-Math.PI / 2, 0, 0);
    fish.position.set(0, top - 0.6 - lenM / 2, 0);
    g.add(fish);

    const tex = signTexture([
      ['bold 40px system-ui, sans-serif', S.name.toUpperCase()],
      ['bold 64px system-ui, sans-serif', `${best.weight.toFixed(1)} LB`],
      ['28px system-ui, sans-serif', best.released ? `Caught & released · ${best.boatName}` : `Biggest of the run · ${best.boatName}`],
    ]);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    sign.rotation.y = Math.PI / 2;
    sign.position.set(0.02, top + 0.62, 0);
    g.add(sign);

    fishCenter = new THREE.Vector3(at.x, at.y + top - 0.6 - lenM / 2, at.z);
    deps.scene.add(g);
    deps.onBuilt(g);
    station = g;
  }

  function buildCrowd(at: { x: number; z: number; y: number }, face: { x: number; z: number }, lenM: number, seed: number, clearOf: { x: number; z: number }): void {
    const g = new THREE.Group();
    const toward = Math.atan2(face.z, face.x);
    const rows: Array<[number, number]> = [[Math.max(2.4, lenM * 0.5 + 1.6), 7], [Math.max(3.4, lenM * 0.5 + 2.6), 9]];
    let i = 0;
    for (const [row, [radius, n]] of rows.entries()) {
      for (let k = 0; k < n; k++) {
        const spread = (Math.PI * 1.25) * (k / (n - 1) - 0.5) + (row ? 0.12 : 0);
        if (row === 0 && Math.abs(spread) < 0.35) continue; // a gap in the front row to see through
        const a = toward + spread;
        const x = at.x + Math.cos(a) * radius, z = at.z + Math.sin(a) * radius;
        const y = groundAt(x, z);
        if (y === null || Math.abs(y - at.y) > 0.6) continue;
        if (Math.hypot(x - clearOf.x, z - clearOf.z) < 2) continue; // leave the plank you step onto free
        const s = seed + i * 7;
        const h = makeHuman({
          walker: true, skin: pick(SKINS, s), shirt: pick(SHIRTS, s * 3 + 1), shortSleeve: true, shorts: pick(SHORTS, s + 2),
          cap: s % 3 === 0 ? pick(SHIRTS, s + 5) : undefined, glasses: s % 4 === 1, hair: pick([0x3b2a1e, 0x1a1a1a, 0x8a6a3a, 0xc9a66b], s),
        });
        h.group.position.set(x, y, z);
        h.group.rotation.y = Math.atan2(at.x - x, at.z - z); // face the fish (humans face local +z)
        const role: Role = i % 3 === 0 ? 'phone' : i % 3 === 1 ? 'cheer' : 'clap';
        let flash: THREE.Mesh | null = null;
        if (role === 'phone' || i % 4 === 2) {
          const hand = h.hands[h.hands.length - 1];
          const phone = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.15, 0.012), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.3 }));
          phone.position.set(0, 0.06, 0.02);
          hand.add(phone);
          flash = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }));
          flash.position.set(0, 0.05, 0.03);
          flash.visible = false;
          phone.add(flash);
        }
        g.add(h.group);
        fans.push({ h, role: flash ? 'phone' : role, base: h.group.position.clone(), flash, nextFlash: Math.random() * 2, flashT: 0, core: i < 4 });
        i++;
      }
    }
    deps.scene.add(g);
    deps.onBuilt(g);
    crowd = g;
  }

  /** Called the moment you step ashore. */
  function onAshore(best: RunBest | null, spot: DockSpot): void {
    if (!best) return;
    const fresh = best.id !== shownId;
    if (fresh) {
      const at = findStation(spot);
      if (!at) return;
      clear();
      const d = Math.hypot(spot.dockX - at.x, spot.dockZ - at.z) || 1;
      const face = { x: (spot.dockX - at.x) / d, z: (spot.dockZ - at.z) / d };
      buildStation(best, at, face);
      buildCrowd(at, face, scaledLenM(best.key, best.weight), best.id * 13, { x: spot.dockX, z: spot.dockZ });
      where = at;
      shownId = best.id;
      hypeT = 0;
      deps.toast(`Word got round the docks — a crowd is gathering to see your ${best.weight.toFixed(1)} lb ${SPECIES[best.key].name}!`);
    } else if (crowd) {
      // Same fish as last time: still on display, just the regulars hanging around it.
      crowd.visible = true;
      for (const f of fans) f.h.group.visible = f.core;
      hypeT = HYPE_S;
    }
  }

  function onLeaveShore(): void {
    if (crowd) crowd.visible = false;
  }

  function update(dt: number, t: number): void {
    if (!crowd || !crowd.visible) return;
    hypeT += dt;
    const hype = Math.max(0, 1 - hypeT / HYPE_S);
    for (const f of fans) {
      if (!f.h.group.visible) continue;
      const h = f.h, hy = h.hipY, ph = h.ph;
      h.update(t, 0);
      h.poseLegs(FEET_L, FEET_R);
      let bounce = 0;
      if (f.role === 'phone') {
        // Phone up at eye height, pointed at the fish; the other hand steadies or hangs.
        _hr.set(0.08, hy + 0.62, 0.36); _hl.set(-0.22, hy + 0.05, 0.1);
        f.nextFlash -= dt;
        if (f.nextFlash <= 0) { f.flashT = 0.09; f.nextFlash = (0.6 + Math.random() * 2.5) * (hype > 0 ? 1 : 2.5); }
        if (f.flash) { f.flashT -= dt; f.flash.visible = f.flashT > 0; }
      } else if (f.role === 'cheer' && hype > 0) {
        const w = Math.sin(t * 7 + ph);
        _hl.set(-0.2 - w * 0.04, hy + 1.0, 0.05); _hr.set(0.2 + w * 0.04, hy + 1.0, 0.05);
        bounce = Math.abs(Math.sin(t * 5.5 + ph)) * 0.09 * hype;
      } else {
        // Clapping (and what cheerers settle into once the hype passes).
        const c = Math.abs(Math.sin(t * (hype > 0 ? 9 : 4) + ph));
        const gap = 0.03 + c * 0.12;
        _hl.set(-gap, hy + 0.42, 0.3); _hr.set(gap, hy + 0.42, 0.3);
      }
      h.pose(_hl, _hr);
      h.head.rotation.x = -0.12 - (fishCenter.y - f.base.y > 2 ? 0.12 : 0);
      h.head.rotation.y *= 0.3;
      h.group.position.y = f.base.y + bounce;
    }
  }

  return { onAshore, onLeaveShore, update, clear, get where() { return where; } };
}

export type DockCelebration = ReturnType<typeof createDockCelebration>;
