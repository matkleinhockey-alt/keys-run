/**
 * The commercial fleet: five working boats, out on the water doing a job.
 *
 * The ambient traffic (traffic.ts) is pleasure boating — centre consoles, go-fasts, jet skis,
 * a sailboat. Marathon is not a pleasure port. It is a stone crab and spiny lobster town with a
 * shrimp fleet, and the boats that actually pay for the fuel dock look nothing like the ones
 * already out there: open sterns piled with traps, outrigger booms raked down to the water,
 * net drums, haulers bolted to the starboard rail.
 *
 * Five of them, each a different kind of working boat so the fleet is not one hull repeated:
 *
 *   Hot Tuna    king mackerel troller — wheelhouse forward, tall poles out, lines down
 *   Dog Pound   stone crab boat — trap stacks aft, hauler on the rail, buoys over the side
 *   Pin Wheel   shrimp trawler — booms raked out and down, nets hanging, try-net on the stern
 *   No Limits   lobster boat — traps and a bait barrel, hauler, buoy sticks along the rail
 *   Fat Tuna    western-rig trawler — the big one, net drum across the stern
 *
 * The names go ON THE BOAT, painted across the transom the way a real one carries it, rather
 * than floating over it as a UI label. It costs one small canvas each and it is the difference
 * between a named boat and a boat with a tag on it.
 *
 * Motion follows traffic.ts: a looping path, speed along it, and the hull's pitch and roll taken
 * from the wave height under its bow, stern and both rails. Working speeds, not planing ones —
 * a boat towing a net makes three knots and a troller barely more.
 */
import * as THREE from 'three';
import { chainRoute, pointRoute, angLerp, type Path } from './path.js';
import { buildHullGeo } from '../boat/hull.js';
import { HULLS, type HullSpec, type HullColors } from '@keysrun/shared/content/boats';
import { seaHAt } from '@keysrun/shared/sim/depth-grid';
import { chainZ } from '@keysrun/shared/world/chain';
import { rand } from '../../core/math.js';

export type CommercialKind = 'troller' | 'crabber' | 'shrimper' | 'lobster' | 'trawler';

interface Boat {
  name: string;
  kind: CommercialKind;
  g: THREE.Group;
  L: number;
  B: number;
  R: Path;
  s: number;
  speed: number;
  h: number;
  ph: number;
}

export interface CommercialFleet {
  update(dt: number, t: number, camera: { x: number; z: number }): void;
  /** VERIFICATION ONLY: where each boat is right now. */
  debug(): Array<{ name: string; kind: CommercialKind; x: number; z: number; visible: boolean }>;
  dispose(): void;
}

/** The transom board. Painted, not a label: a real boat carries her name and her port. */
function nameTex(name: string, port = 'MARATHON, FL'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#10161c'; g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#f4f1e6';
  g.textAlign = 'center';
  g.font = 'bold 34px Georgia, serif';
  g.fillText(name.toUpperCase(), 128, 36);
  g.fillStyle = '#cfc6ae';
  g.font = '15px Georgia, serif';
  g.fillText(port, 128, 55);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

export function createCommercialFleet(scene: THREE.Scene): CommercialFleet {
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };
  const M = (c: number, o: { rough?: number; metal?: number } = {}): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: o.rough ?? 0.8, metalness: o.metal ?? 0.05, flatShading: true });
    mats.push(m);
    return m;
  };

  const steel = M(0x8d949b, { rough: 0.6, metal: 0.4 });
  const rust = M(0x7a4a2a, { rough: 0.95 });
  const timber = M(0x8a6b45, { rough: 0.95 });
  const netM = M(0x3d4a3a, { rough: 1 });
  const buoyM = M(0xe4572e, { rough: 0.7 });

  /** A working hull: the grady loft, re-proportioned and painted as a commercial boat. */
  function hull(L: number, B: number, F: number, colors: Partial<HullColors>): THREE.Mesh {
    const base = HULLS.grady;
    const H: HullSpec = { ...base, F, spring: 0.42, dr0: 18, dr1: 42, rake: 1.1, steps: [], colors: { ...base.colors, ...colors } };
    const geo = keep(buildHullGeo(H, L, B, { deck: true }));
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.68, side: THREE.DoubleSide });
    mats.push(m);
    const mesh = new THREE.Mesh(geo, m);
    mesh.castShadow = true;
    return mesh;
  }

  const box = (g: THREE.Group, w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material, rx = 0, rz = 0): THREE.Mesh => {
    const b = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), m);
    b.position.set(x, y, z); b.rotation.set(rx, 0, rz); b.castShadow = true; g.add(b);
    return b;
  };
  const tube = (g: THREE.Group, r: number, len: number, x: number, y: number, z: number, m: THREE.Material, rx = 0, rz = 0): void => {
    const c = new THREE.Mesh(keep(new THREE.CylinderGeometry(r, r, len, 7)), m);
    c.position.set(x, y, z); c.rotation.set(rx, 0, rz); c.castShadow = true; g.add(c);
  };
  /** A stack of traps — wire boxes, the whole reason a crab boat's deck is full. */
  const trapStack = (g: THREE.Group, x: number, y: number, z: number, cols: number, rows: number): void => {
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        box(g, 0.78, 0.5, 0.78, x, y + 0.27 + r * 0.54, z + c * 0.86, r % 2 ? timber : rust);
      }
    }
  };
  /** The name board on the transom, and her port under it. */
  const transom = (g: THREE.Group, name: string, w: number, y: number, z: number): void => {
    const tex = nameTex(name);
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
    mats.push(m);
    const plate = new THREE.Mesh(keep(new THREE.PlaneGeometry(w, w * 0.25)), m);
    plate.position.set(0, y, z);
    // A plane's face points +z, the hull's bow is -z, so astern is +z and the board needs NO
    // rotation to be read from behind. Turning it 180 degrees — which is what this did first —
    // points the lettering into the fish hold and shows the viewer a back face.
    g.add(plate);
  };

  function build(kind: CommercialKind, name: string): { g: THREE.Group; L: number; B: number } {
    const g = new THREE.Group();
    let L = 14, B = 4.4;

    if (kind === 'troller') {
      L = 13; B = 4.1;
      g.add(hull(L, B, 1.25, { hull: 0xe9e6dc, boot: 0x1f4f8c, cove: 0x1f4f8c, deck: 0xcdc7b6 }));
      box(g, 3.0, 2.3, 3.6, 0, 2.1, -2.6, M(0xf2efe6));      // wheelhouse forward
      box(g, 2.4, 0.9, 2.0, 0, 3.6, -2.6, M(0xf2efe6));
      tube(g, 0.09, 6, 0, 5.6, -2.6, steel);                  // mast
      // The poles: raked out and down, which is the whole silhouette of a troller.
      for (const s of [-1, 1]) {
        tube(g, 0.11, 13, s * 2.6, 4.2, -1.4, steel, 0, s * 1.05);
        // Tag lines down to the water from each pole tip.
        tube(g, 0.02, 5.2, s * 7.4, 1.6, -1.0, steel, 0, s * 0.12);
      }
      box(g, 1.6, 0.7, 1.2, 0, 1.1, 4.2, rust);               // fish box on the stern
      transom(g, name, 3.4, 1.35, L / 2 - 0.05);
    } else if (kind === 'crabber') {
      L = 12; B = 4.6;
      g.add(hull(L, B, 1.15, { hull: 0xdfe6e2, boot: 0x2c5a3a, cove: null, deck: 0xc9c2ae }));
      box(g, 3.2, 2.2, 3.0, 0, 2.0, -3.2, M(0xeef0ea));
      trapStack(g, -1.3, 1.0, 0.4, 3, 3);
      trapStack(g, 1.3, 1.0, 0.4, 3, 2);
      // Hydraulic hauler on the starboard rail, where every crabber has one.
      tube(g, 0.12, 1.6, B / 2 - 0.3, 1.8, -0.8, steel);
      tube(g, 0.34, 0.26, B / 2 - 0.3, 2.5, -0.8, steel, Math.PI / 2);
      box(g, 0.9, 0.9, 0.9, -1.5, 1.4, -1.6, buoyM);          // bait barrel
      transom(g, name, 3.6, 1.25, L / 2 - 0.05);
    } else if (kind === 'shrimper') {
      L = 17; B = 5.4;
      g.add(hull(L, B, 1.55, { hull: 0xe3dccb, boot: 0x7a2c1c, cove: 0x7a2c1c, deck: 0xbfb8a4 }));
      box(g, 3.6, 2.6, 4.2, 0, 2.6, -4.4, M(0xf0ece0));
      box(g, 2.8, 1.0, 2.4, 0, 4.4, -4.4, M(0xf0ece0));
      // A-frame and the two booms, raked out and down with the nets on them.
      for (const s of [-1, 1]) {
        tube(g, 0.16, 20, s * 3.0, 4.6, -2.0, steel, 0, s * 1.22);
        const net = new THREE.Mesh(keep(new THREE.ConeGeometry(1.5, 7, 7, 1, true)), netM);
        net.position.set(s * 9.2, 2.1, -0.6); net.rotation.set(0.25, 0, s * 0.5); g.add(net);
      }
      tube(g, 0.14, 7.5, 0, 4.4, 5.2, steel, 0.5);            // stern A-frame
      const tryNet = new THREE.Mesh(keep(new THREE.ConeGeometry(0.8, 3.2, 6, 1, true)), netM);
      tryNet.position.set(0, 2.2, 7.4); tryNet.rotation.x = 0.4; g.add(tryNet);
      transom(g, name, 4.4, 1.6, L / 2 - 0.05);
    } else if (kind === 'lobster') {
      L = 11.5; B = 4.2;
      g.add(hull(L, B, 1.1, { hull: 0xf0ead8, boot: 0xc8a24a, cove: null, deck: 0xcac3af }));
      box(g, 3.0, 2.0, 2.6, 0, 1.9, -3.0, M(0xf4f1e6));
      trapStack(g, -1.2, 0.95, 1.0, 4, 2);
      trapStack(g, 1.2, 0.95, 1.6, 3, 2);
      tube(g, 0.11, 1.5, B / 2 - 0.3, 1.7, -0.6, steel);
      tube(g, 0.3, 0.24, B / 2 - 0.3, 2.35, -0.6, steel, Math.PI / 2);
      // Buoy sticks racked along the port rail.
      for (let i = 0; i < 5; i++) tube(g, 0.05, 1.4, -B / 2 + 0.25, 1.5, -1.6 + i * 0.7, buoyM, Math.PI / 2);
      transom(g, name, 3.2, 1.2, L / 2 - 0.05);
    } else {
      L = 19; B = 6.0;
      g.add(hull(L, B, 1.7, { hull: 0xd8d2c2, boot: 0x2a3d52, cove: 0x2a3d52, deck: 0xb9b2a0 }));
      box(g, 4.0, 3.0, 5.0, 0, 2.9, -5.0, M(0xeae6da));
      box(g, 3.0, 1.1, 2.8, 0, 4.9, -5.0, M(0xeae6da));
      tube(g, 0.1, 5.5, 0, 6.6, -5.0, steel);
      for (const s of [-1, 1]) tube(g, 0.18, 22, s * 3.4, 5.0, -2.4, steel, 0, s * 1.26);
      // The net drum across the stern: the one fitting that says western rig at any distance.
      const drum = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.5, 1.5, 4.6, 12)), rust);
      drum.rotation.z = Math.PI / 2; drum.position.set(0, 2.5, 6.4); drum.castShadow = true; g.add(drum);
      const wrap = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.75, 1.75, 4.0, 12)), netM);
      wrap.rotation.z = Math.PI / 2; wrap.position.set(0, 2.5, 6.4); g.add(wrap);
      transom(g, name, 5.0, 1.75, L / 2 - 0.05);
    }
    return { g, L, B };
  }

  // Working grounds, not commuting lanes: the crab and lobster boats work the bank inside the
  // reef, the shrimper and the trawler tow further out, and the troller runs the reef line.
  const DEF: ReadonlyArray<readonly [string, CommercialKind, Path, number]> = [
    ['Hot Tuna', 'troller', chainRoute(1250, 1420), 3.5],
    ['Dog Pound', 'crabber', pointRoute([[-2400, chainZ(-2400) + 620], [-900, chainZ(-900) + 540], [200, chainZ(200) + 700], [-1400, chainZ(-1400) + 820]]), 2.4],
    ['Pin Wheel', 'shrimper', chainRoute(2050, 2400), 2.2],
    ['No Limits', 'lobster', pointRoute([[900, chainZ(900) + 560], [2300, chainZ(2300) + 700], [3200, chainZ(3200) + 520], [1700, chainZ(1700) + 460]]), 2.6],
    ['Fat Tuna', 'trawler', chainRoute(2650, 3050), 2.0],
  ];

  const fleet: Boat[] = DEF.map(([name, kind, R, speed]) => {
    const b = build(kind, name);
    scene.add(b.g);
    return { name, kind, g: b.g, L: b.L, B: b.B, R, s: Math.random() * R.total, speed, h: 0, ph: rand(0, 6.28) };
  });

  function update(dt: number, t: number, camera: { x: number; z: number }): void {
    for (const r of fleet) {
      r.s += r.speed * dt;
      const P = r.R.at(r.s);
      const x = P.x, z = P.z;
      r.h = angLerp(r.h, Math.atan2(-P.tx, -P.tz), dt * 1.4);

      // Pitch and roll off the wave under bow, stern and both rails — same as traffic.ts. A
      // working boat is slow and heavily loaded, so it wallows rather than planing.
      const fx = -Math.sin(r.h), fz = -Math.cos(r.h), hl = r.L * 0.45;
      const hb = seaHAt(x + fx * hl, z + fz * hl, t), hs = seaHAt(x - fx * hl, z - fz * hl, t);
      const rxv = Math.cos(r.h), rzv = -Math.sin(r.h);
      const hp = seaHAt(x - rxv * r.B * 0.5, z - rzv * r.B * 0.5, t);
      const hst = seaHAt(x + rxv * r.B * 0.5, z + rzv * r.B * 0.5, t);
      r.g.position.set(x, (hb + hs) / 2, z);
      r.g.rotation.set(Math.atan2(hb - hs, r.L), r.h, Math.atan2(hp - hst, r.B) * 0.9, 'YXZ');
      r.g.visible = Math.hypot(x - camera.x, z - camera.z) < 1700;
    }
  }

  return {
    update,
    debug: () => fleet.map((r) => ({
      name: r.name, kind: r.kind,
      x: +r.g.position.x.toFixed(0), z: +r.g.position.z.toFixed(0), visible: r.g.visible,
    })),
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
