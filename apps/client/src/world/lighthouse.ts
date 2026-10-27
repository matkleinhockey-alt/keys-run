/**
 * Sombrero Key Light: the reef light off Marathon, and the beam that sweeps off it.
 *
 * This world already names the place twice — the town's main street is Sombrero Boulevard and
 * the reef zone reports itself as "Sombrero Reef" — so the one landmark it was missing is the
 * thing the reef is actually named for. The real light is not a white stone tower; it is a
 * 142-foot skeletal iron pyramid screwed into the coral, painted brown, with the keeper's
 * dwelling slung halfway up its legs and the lantern room on top. Built that way here, because
 * the open lattice is the whole silhouette: from the water you see sky through it.
 *
 * It stands on the reef CREST, which is where `depthAt`'s profile is shallowest (dz ~1460, about
 * 3.4 m) — a reef light marks the shoal it is standing on, so putting it in deep water would be
 * exactly backwards.
 *
 * ## The beam
 *
 * A real first-order light is a lens that rotates; the beam is the lens, not a searchlight being
 * aimed. So this is a narrow additive wedge turning at a constant rate, with the characteristic
 * period a chart would give it. It is drawn at full strength only at night (`lightMats`, the same
 * day/night crossfade the rig lamps and channel marks use) — a lighthouse beam visible in
 * daylight is the single most common way this gets done wrong.
 */
import * as THREE from 'three';
import type { LightMatEntry } from '../core/time-of-day.js';
import { chainZ } from '@keysrun/shared/world/chain';

/** On the reef crest south of Vaca Key, where the real one stands. */
export const LIGHT_X = -200;
export const LIGHT_DZ = 1455;

/** Height of the focal plane above the water, metres (the real one is 142 ft to the lantern). */
const FOCAL_H = 43;
/** Seconds for one full revolution of the lens. */
const PERIOD_S = 9;
/** How far the beam throws before it fades out, metres. */
const REACH = 620;

export interface Lighthouse {
  group: THREE.Group;
  /** One frame. `t` is sim time; the lens turns on it so every client agrees on the flash. */
  update(t: number): void;
  /** VERIFICATION ONLY. */
  debug(): { x: number; z: number; bearingDeg: number };
  dispose(): void;
}

export function createLighthouse(lightMats: LightMatEntry[]): Lighthouse {
  const group = new THREE.Group();
  group.name = 'lighthouse';
  const x = LIGHT_X, z = chainZ(LIGHT_X) + LIGHT_DZ;
  group.position.set(x, 0, z);

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };
  const keepM = <T extends THREE.Material>(m: T): T => { mats.push(m); return m; };

  // Brown-red ironwork, gone chalky in the salt.
  const iron = keepM(new THREE.MeshStandardMaterial({ color: 0x6e4232, roughness: 0.82, metalness: 0.35, flatShading: true }));
  const white = keepM(new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.7, flatShading: true }));
  const dark = keepM(new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.6, metalness: 0.4, flatShading: true }));

  const V = (a: number, b: number, c: number): THREE.Vector3 => new THREE.Vector3(a, b, c);
  const strut = (a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material): void => {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length() || 0.001;
    const g = keep(new THREE.CylinderGeometry(r, r, len, 6));
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(V(0, 1, 0), d.divideScalar(len));
    mesh.castShadow = true;
    group.add(mesh);
  };

  // Eight legs on a disc of screw piles, raking in to the gallery. An octagonal pyramid: the
  // footprint is wide enough to stand in surf, the top tight enough to carry one lantern.
  const SIDES = 8, BASE_R = 13, TOP_R = 3.2;
  const leg = (i: number, r: number, y: number): THREE.Vector3 => {
    const a = (i / SIDES) * Math.PI * 2;
    return V(Math.cos(a) * r, y, Math.sin(a) * r);
  };
  for (let i = 0; i < SIDES; i++) {
    // The screw pile itself, disappearing into the coral.
    strut(leg(i, BASE_R, -3.2), leg(i, BASE_R, 1.2), 0.42, dark);
    strut(leg(i, BASE_R, 1.2), leg(i, TOP_R, FOCAL_H - 5), 0.34, iron);
  }
  // Horizontal rings and the diagonal bracing between them — what makes it read as a lattice
  // rather than a cone.
  const RINGS = [1.2, 9, 17, 25, 32, FOCAL_H - 5];
  const rAt = (y: number): number => BASE_R + (TOP_R - BASE_R) * ((y - 1.2) / (FOCAL_H - 6.2));
  for (const y of RINGS) {
    const r = rAt(y);
    for (let i = 0; i < SIDES; i++) strut(leg(i, r, y), leg((i + 1) % SIDES, r, y), 0.16, iron);
  }
  for (let k = 0; k < RINGS.length - 1; k++) {
    const y0 = RINGS[k], y1 = RINGS[k + 1], r0 = rAt(y0), r1 = rAt(y1);
    for (let i = 0; i < SIDES; i++) {
      strut(leg(i, r0, y0), leg((i + 1) % SIDES, r1, y1), 0.11, iron);
    }
  }
  // Central stair column, which a skeletal light always has — the legs carry nothing but load.
  strut(V(0, 1.2, 0), V(0, FOCAL_H - 4.6, 0), 0.62, iron);

  // Keeper's dwelling, slung in the legs partway up. White, because it always is.
  const house = new THREE.Mesh(keep(new THREE.CylinderGeometry(6.4, 6.4, 4.2, SIDES)), white);
  house.position.y = 19; house.castShadow = true; group.add(house);
  const hRoof = new THREE.Mesh(keep(new THREE.ConeGeometry(7.2, 2.2, SIDES)), dark);
  hRoof.position.y = 22.2; group.add(hRoof);
  // Gallery rail round it.
  for (let i = 0; i < SIDES; i++) strut(leg(i, 7.4, 21.2), leg((i + 1) % SIDES, 7.4, 21.2), 0.08, dark);

  // Lantern room: gallery deck, glazed drum, domed cap, finial.
  const gallery = new THREE.Mesh(keep(new THREE.CylinderGeometry(4.6, 4.6, 0.5, SIDES * 2)), dark);
  gallery.position.y = FOCAL_H - 4.4; group.add(gallery);
  for (let i = 0; i < SIDES * 2; i++) {
    const a = (i / (SIDES * 2)) * Math.PI * 2;
    strut(V(Math.cos(a) * 4.4, FOCAL_H - 4.1, Math.sin(a) * 4.4), V(Math.cos(a) * 4.4, FOCAL_H - 3, Math.sin(a) * 4.4), 0.06, dark);
  }
  const glassM = keepM(new THREE.MeshStandardMaterial({
    color: 0xcfe6f2, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.42, side: THREE.DoubleSide,
  }));
  const drum = new THREE.Mesh(keep(new THREE.CylinderGeometry(3.1, 3.1, 4.4, SIDES * 2, 1, true)), glassM);
  drum.position.y = FOCAL_H - 1.9; group.add(drum);
  const cap = new THREE.Mesh(keep(new THREE.ConeGeometry(3.6, 2.4, SIDES * 2)), dark);
  cap.position.y = FOCAL_H + 1.5; group.add(cap);
  strut(V(0, FOCAL_H + 2.5, 0), V(0, FOCAL_H + 4.2, 0), 0.1, dark);

  /*
   * The lens. A narrow additive wedge, not a cone: a rotating first-order lens throws a flat
   * fan, and a cone reads as a party spotlight. Two overlapping blades a few degrees apart give
   * it a core and a softer edge without needing a texture.
   *
   * Hung on its own pivot so `update` only has to set one rotation.
   */
  const lens = new THREE.Group();
  lens.position.y = FOCAL_H;
  group.add(lens);
  const beamMats: THREE.MeshBasicMaterial[] = [];
  for (const [halfW, op, far] of [[2.6, 0.26, REACH], [6.5, 0.1, REACH * 0.78]] as const) {
    const g = keep(new THREE.BufferGeometry());
    // A flat triangle fan from the lantern out to `far`, slightly tapered in height so it reads
    // as a beam spreading rather than a wall.
    const verts = new Float32Array([
      0, 0, 0, far, 3.2, -halfW, far, 3.2, halfW,
      0, 0, 0, far, -3.2, halfW, far, -3.2, -halfW,
      0, 0, 0, far, 3.2, halfW, far, -3.2, halfW,
      0, 0, 0, far, -3.2, -halfW, far, 3.2, -halfW,
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.computeVertexNormals();
    const m = keepM(new THREE.MeshBasicMaterial({
      color: 0xfff2cf, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: true,
    }));
    beamMats.push(m);
    // Night only. A beam you can see at noon is the usual way this is done wrong.
    lightMats.push({ m, day: 0, night: op });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 2;
    lens.add(mesh);
  }

  // The lamp itself, so the lantern is a bright point from any angle even when the beam is
  // pointing away from you.
  const lampM = keepM(new THREE.SpriteMaterial({
    map: glow(), color: 0xfff0c8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.25,
  }));
  lightMats.push({ m: lampM, day: 0.12, night: 1 });
  const lamp = new THREE.Sprite(lampM);
  lamp.scale.setScalar(13);
  lamp.position.y = FOCAL_H;
  group.add(lamp);

  let bearing = 0;

  function update(t: number): void {
    bearing = (t / PERIOD_S) * Math.PI * 2;
    lens.rotation.y = bearing;
    // The lamp blooms as the lens comes round toward the viewer. Cheap stand-in for the flash a
    // real one gives you: brightest on the beam, never fully out.
    const flash = 0.55 + 0.45 * Math.pow(Math.max(0, Math.cos(bearing * 2)), 6);
    lamp.scale.setScalar(11 + flash * 5);
  }

  return {
    group,
    update,
    debug: () => ({ x, z, bearingDeg: +((bearing * 180 / Math.PI) % 360).toFixed(1) }),
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      void beamMats;
    },
  };
}

/** Soft radial sprite for the lamp — same trick the rigs and the channel marks use. */
function glow(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,245,210,.5)');
  grd.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
