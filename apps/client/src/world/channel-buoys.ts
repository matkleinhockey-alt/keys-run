/**
 * The channel markers: a red nun and a green can down each side of every dredged cut.
 *
 * Placement is `@keysrun/shared/world/channel-marks` — pure data, so where a mark stands is
 * testable without a renderer. This module is only the geometry, and it follows
 * `game/race/buoys.ts`'s approach for the same reason that file gives: one `InstancedMesh` per
 * part rather than a group per buoy, so fifty marks cost a handful of draw calls.
 *
 * Shape carries the meaning as much as colour does, which is the point of the lateral system: a
 * red mark is a nun (conical) and a green one is a can (flat-topped cylinder), so the pair is
 * still readable at a distance where both have washed out to grey, and to anyone who cannot
 * separate the two colours. Each carries a short mast and a light that comes up at dusk.
 */
import * as THREE from 'three';
import { channelMarks, type ChannelMark } from '@keysrun/shared/world/channel-marks';

export interface ChannelBuoys {
  group: THREE.Group;
  marks: readonly ChannelMark[];
  /** Ride the swell. `sample(x, z)` is the water height under that point. */
  update(sample: (x: number, z: number) => number): void;
}

// Bigger than the real thing, for the same reason game/race/buoys.ts gives: a 1 m buoy is a
// pixel at the range you first need to see it, and a mark you only notice once you are level
// with it has not marked anything. Still small enough beside a 9 m hull to read as a buoy.
const BODY_R = 1.3;
const BODY_H = 3.2;
const MAST_H = 3.2;

export function createChannelBuoys(marks: readonly ChannelMark[] = channelMarks()): ChannelBuoys {
  const group = new THREE.Group();
  group.name = 'channelBuoys';

  const reds = marks.filter((m) => m.hand === 'red');
  const greens = marks.filter((m) => m.hand === 'green');

  // A nun is conical, a can is a flat drum — the silhouette is half the signal.
  const nunGeo = new THREE.ConeGeometry(BODY_R, BODY_H, 9);
  const canGeo = new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H * 0.78, 9);
  const redMat = new THREE.MeshStandardMaterial({ color: 0xb8322a, roughness: 0.62, metalness: 0.05 });
  const greenMat = new THREE.MeshStandardMaterial({ color: 0x1f7a46, roughness: 0.62, metalness: 0.05 });
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.7, metalness: 0.2 });

  const nun = new THREE.InstancedMesh(nunGeo, redMat, Math.max(1, reds.length));
  const can = new THREE.InstancedMesh(canGeo, greenMat, Math.max(1, greens.length));
  const mastGeo = new THREE.CylinderGeometry(0.1, 0.12, MAST_H, 6);
  const mast = new THREE.InstancedMesh(mastGeo, mastMat, Math.max(1, marks.length));
  for (const m of [nun, can, mast]) { m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; group.add(m); }

  // Lights, lit by the same additive-sprite trick the rigs use. Red over red, green over green,
  // so a mark reads the same way at night as it does by day.
  const lightTex = makeGlow();
  const lights = marks.map((m) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: lightTex, color: m.hand === 'red' ? 0xff5a4a : 0x4affa0,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55,
    }));
    sp.scale.setScalar(1.6);
    group.add(sp);
    return sp;
  });

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();

  function update(sample: (x: number, z: number) => number): void {
    let ri = 0, gi = 0;
    for (let i = 0; i < marks.length; i++) {
      const k = marks[i];
      const y = sample(k.x, k.z);
      // Buoys lean with the chop and the current rather than standing like posts.
      const lean = 0.07 * Math.sin(k.x * 0.08 + y * 1.7) + 0.05 * Math.cos(k.z * 0.06);
      _q.setFromEuler(new THREE.Euler(lean, 0, lean * 0.6, 'XYZ'));
      const body = k.hand === 'red' ? nun : can;
      const idx = k.hand === 'red' ? ri++ : gi++;
      _p.set(k.x, y + BODY_H * 0.34, k.z);
      body.setMatrixAt(idx, _m.compose(_p, _q, _s));
      _p.set(k.x, y + BODY_H * 0.55 + MAST_H * 0.5, k.z);
      mast.setMatrixAt(i, _m.compose(_p, _q, _s));
      lights[i].position.set(k.x, y + BODY_H * 0.55 + MAST_H, k.z);
    }
    nun.instanceMatrix.needsUpdate = true;
    can.instanceMatrix.needsUpdate = true;
    mast.instanceMatrix.needsUpdate = true;
    nun.count = reds.length; can.count = greens.length; mast.count = marks.length;
  }

  return { group, marks, update };
}

/** Small radial glow, same idea as the rigs' lamp sprites. */
function makeGlow(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
