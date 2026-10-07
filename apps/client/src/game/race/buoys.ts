/**
 * The course's physical marks: an inflatable race buoy at every checkpoint, plus a taller pole on
 * the start/finish so the line is unmistakable from a distance.
 *
 * One `InstancedMesh` per part rather than a group per buoy — the course is only nine marks, but
 * they are visible from most of the lap and this keeps the whole course at 3 draw calls instead of
 * ~27, which matters against docs/ARCHITECTURE.md's topside budget where the reef and fish already
 * spend most of it.
 *
 * Buoys bob on the real wave sum (`waveHBase`/`ampAt`, the same functions the hull integrator and
 * the fish use) so they sit in the water rather than hovering above a moving surface — a mark that
 * ignores the swell is the single most obvious "this is a game object" tell at close range.
 */
import * as THREE from 'three';
import { waveHBase } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { MARATHON_COURSE, buoyPos, type CourseBuoy } from '@keysrun/shared/sim/race';

export interface RaceBuoys {
  group: THREE.Group;
  /** Call once a frame while the course is shown. `nextIndex` is the buoy the player owes next —
   * it is lit differently so "where do I go" is answerable at a glance rather than by reading the
   * HUD. Pass -1 for none. */
  update(t: number, nextIndex: number): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

const BODY_R = 1.5;
const BODY_H = 2.4;
/** Start/finish gets a mast so it reads from across the channel. */
const MAST_H = 7;

export function createRaceBuoys(course: readonly CourseBuoy[] = MARATHON_COURSE): RaceBuoys {
  const group = new THREE.Group();
  group.name = 'raceBuoys';
  group.visible = false;

  const n = course.length;
  const positions = course.map(buoyPos);

  // Cone body — a racing mark is a truncated cone, not a sphere; the silhouette is what makes it
  // read as a buoy at 400 m where the colour has washed out to grey.
  const bodyGeo = new THREE.ConeGeometry(BODY_R, BODY_H, 10, 1, true);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  const body = new THREE.InstancedMesh(bodyGeo, bodyMat, n);
  body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  body.castShadow = false;

  // A dark collar at the waterline stops the cone reading as a floating traffic cone.
  const collarGeo = new THREE.CylinderGeometry(BODY_R * 1.08, BODY_R * 1.08, 0.42, 10, 1, true);
  const collarMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8, side: THREE.DoubleSide });
  const collar = new THREE.InstancedMesh(collarGeo, collarMat, n);
  collar.castShadow = false;

  const mastGeo = new THREE.CylinderGeometry(0.1, 0.12, MAST_H, 6);
  const mastMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.5 });
  const mast = new THREE.InstancedMesh(mastGeo, mastMat, 1);
  mast.castShadow = false;

  group.add(body, collar, mast);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  function update(t: number, nextIndex: number): void {
    if (!group.visible) return;
    for (let i = 0; i < n; i++) {
      const p = positions[i];
      const surf = waveHBase(p.x, p.z, t, ampAt(p.x, p.z));
      // Lean with the swell slightly — a moored mark heels, it doesn't stand bolt upright.
      const lean = Math.sin(t * 0.9 + i * 1.7) * 0.06;

      dummy.position.set(p.x, surf + BODY_H * 0.5 - 0.35, p.z);
      dummy.rotation.set(lean, 0, Math.cos(t * 0.8 + i) * 0.05);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);

      dummy.position.set(p.x, surf - 0.1, p.z);
      dummy.updateMatrix();
      collar.setMatrixAt(i, dummy.matrix);

      // Next mark pulses amber; the rest are plain orange. Deliberately a colour/brightness
      // difference rather than an arrow or a label — it stays readable at any distance and in any
      // light, and costs one instance colour write.
      if (i === nextIndex) {
        const pulse = 0.72 + 0.28 * Math.sin(t * 5);
        col.setRGB(1.0 * pulse, 0.78 * pulse, 0.12 * pulse);
      } else {
        col.setRGB(0.85, 0.30, 0.12);
      }
      body.setColorAt(i, col);
    }
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    collar.instanceMatrix.needsUpdate = true;

    const s = positions[0];
    const surf0 = waveHBase(s.x, s.z, t, ampAt(s.x, s.z));
    dummy.position.set(s.x, surf0 + MAST_H * 0.5, s.z);
    dummy.rotation.set(Math.sin(t * 0.9) * 0.05, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    mast.setMatrixAt(0, dummy.matrix);
    mast.instanceMatrix.needsUpdate = true;
  }

  function setVisible(v: boolean): void { group.visible = v; }

  function dispose(): void {
    bodyGeo.dispose(); collarGeo.dispose(); mastGeo.dispose();
    bodyMat.dispose(); collarMat.dispose(); mastMat.dispose();
    body.dispose(); collar.dispose(); mast.dispose();
  }

  return { group, update, setVisible, dispose };
}
