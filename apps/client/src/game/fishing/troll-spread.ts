/**
 * The trolling spread: the lines actually in the water behind the boat, and the lures skipping
 * along on them.
 *
 * Trolling swung the riggers out and splashed when something ate, but between those two moments
 * nothing was being dragged — the mode was a timer with a sound. The spread is the part you
 * watch: four lines fanned astern, each with a lure riding the surface, popping in and out of the
 * face of the wake.
 *
 * Geometry, not simulation. Each lure holds station at a fixed distance and angle astern in the
 * boat's own frame, so the spread swings with the hull and trails properly through a turn
 * without needing its own physics. What varies is the ride: a lure skips, so it tracks the water
 * surface and lifts clear of it on a beat of its own, and the line slackens as the lure rises and
 * comes taut as it digs back in.
 *
 * The two long lines hang off the rigger tips (entities/boat/model.ts's `outriggerTips`) and the
 * two short ones straight off the transom, which is how a spread is actually set: the riggers
 * hold the outside baits wide of the wake, the flat lines run down the prop wash.
 */
import * as THREE from 'three';
import type { BoatModel } from '../../entities/boat/model.js';

/** Lure stations, in the boat's own frame: metres astern, and metres to one side. */
const STATIONS: ReadonlyArray<{ back: number; side: number; rigger: 0 | 1 | null }> = [
  { back: 34, side: -14, rigger: 0 },
  { back: 30, side: 13, rigger: 1 },
  { back: 20, side: -4.5, rigger: null },
  { back: 23, side: 4.5, rigger: null },
];

/** Points down each line. Enough to bend, few enough to be free. */
const SEG = 10;

export interface TrollSpread {
  group: THREE.Group;
  /**
   * `out` is how far the spread is deployed, 0..1 — the same number the riggers swing on, so
   * the lines come out with the poles instead of appearing fully set.
   * `sample(x, z)` is the water height there.
   */
  update(t: number, model: BoatModel, out: number, sample: (x: number, z: number) => number): void;
}

export function createTrollSpread(scene: THREE.Scene): TrollSpread {
  const group = new THREE.Group();
  group.name = 'trollSpread';
  group.visible = false;
  scene.add(group);

  const lineMat = new THREE.LineBasicMaterial({ color: 0xe8eef2, transparent: true, opacity: 0.55 });
  const lures: THREE.Mesh[] = [];
  const lines: THREE.Line[] = [];
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0xe04a2a, roughness: 0.45, metalness: 0.25 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.3, metalness: 0.7 });

  for (let i = 0; i < STATIONS.length; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
    const line = new THREE.Line(geo, lineMat);
    line.frustumCulled = false;
    group.add(line);
    lines.push(line);

    // A skirted trolling lure: a weighted head with a skirt streaming off it.
    const lure = new THREE.Group() as unknown as THREE.Mesh;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.22, 8), headMat);
    head.rotation.x = Math.PI / 2;
    lure.add(head);
    const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.34, 8, 1, true), skirtMat);
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.z = 0.24;
    lure.add(skirt);
    group.add(lure);
    lures.push(lure);
  }

  const _tip = new THREE.Vector3(), _lure = new THREE.Vector3(), _p = new THREE.Vector3();

  function update(t: number, model: BoatModel, out: number, sample: (x: number, z: number) => number): void {
    group.visible = out > 0.02;
    if (!group.visible) return;

    model.group.updateMatrixWorld(true);
    const h = model.group.rotation.y;
    // Boat frame: forward is (-sin h, -cos h), so astern is the negation and starboard is across.
    const fx = -Math.sin(h), fz = -Math.cos(h);
    const rx = Math.cos(h), rz = -Math.sin(h);
    const bx = model.group.position.x, bz = model.group.position.z;

    for (let i = 0; i < STATIONS.length; i++) {
      const st = STATIONS[i];
      // The spread opens as the gear goes out rather than snapping to full length.
      const back = st.back * out, side = st.side * out;
      const lx = bx - fx * back + rx * side;
      const lz = bz - fz * back + rz * side;
      const water = sample(lx, lz);

      // The skip. A lure does not sit on the surface, it porpoises: mostly in the face of a wave
      // and clear of it for a moment each beat. Each station gets its own beat so they do not
      // pop in unison, which would read as one object repeated.
      const beat = Math.sin(t * (3.1 + i * 0.37) + i * 1.9);
      const air = Math.max(0, beat) ** 2;
      const ly = water + 0.06 + air * 0.5;

      _lure.set(lx, ly, lz);
      lures[i].position.copy(_lure);
      // Nose down the line of travel, rolling a little as it digs in.
      lures[i].rotation.set(-0.25 + air * 0.5, h, Math.sin(t * 2.3 + i) * 0.25, 'YXZ');

      // Where the line leaves the boat.
      if (st.rigger !== null && model.outriggerTips[st.rigger]) {
        model.outriggerTips[st.rigger].getWorldPosition(_tip);
      } else {
        _tip.set(bx - fx * 1.2 + rx * st.side * 0.22, model.group.position.y + 1.5, bz - fz * 1.2 + rz * st.side * 0.22);
      }

      // Slack follows the ride: taut while the lure is digging, bowed while it is in the air.
      const slack = 0.1 + air * 0.5;
      const pos = lines[i].geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let s = 0; s <= SEG; s++) {
        const u = s / SEG;
        _p.lerpVectors(_tip, _lure, u);
        // Catenary-ish bow, pinned at both ends, never dipping below the water it rides on.
        const sag = Math.sin(Math.PI * u) * slack;
        _p.y = Math.max(sample(_p.x, _p.z) - 0.02, _p.y - sag);
        pos.setXYZ(s, _p.x, _p.y, _p.z);
      }
      pos.needsUpdate = true;
      lines[i].geometry.computeBoundingSphere();
    }
  }

  return { group, update };
}
