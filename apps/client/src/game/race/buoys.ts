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

/**
 * Marks are deliberately far larger than a real race buoy (a real one is ~1 m and would be a
 * single pixel at the distances this course is run at). The first pass used a 1.5 m cone and it
 * vanished against the chop past about 150 m — on a 6.3 km lap that meant driving on the HUD
 * text instead of on the course, which is the opposite of what a marked course is for.
 *
 * Every mark now carries the same three cues, because each one fails in a different condition:
 *  - a **tall mast** (silhouette survives at range, where colour has washed to grey)
 *  - a **flag** at the top (breaks the vertical line so it doesn't read as a piling)
 *  - an **emissive band** (holds up at dusk and under the sunset tint, when unlit geometry goes
 *    flat — `toneMapped: false` so the sunset grade can't crush it)
 */
const BODY_R = 2.6;
const BODY_H = 4.2;
/** Every mark gets a mast now, not just the start/finish — see the note above. */
const MAST_H = 11;
/** The start/finish mast is taller again so the line is unmistakable from anywhere on the lap. */
const START_MAST_H = 17;

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

  // One mast per mark, plus a taller one on the start/finish (instance n).
  const mastGeo = new THREE.CylinderGeometry(0.16, 0.2, 1, 6);
  const mastMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.45 });
  const mast = new THREE.InstancedMesh(mastGeo, mastMat, n + 1);
  mast.castShadow = false;

  // Emissive band around the cone. Unlit geometry goes flat under the sunset grade and at dusk;
  // `toneMapped: false` keeps this readable through the tone mapper rather than being crushed
  // with everything else.
  const bandGeo = new THREE.CylinderGeometry(BODY_R * 0.82, BODY_R * 0.82, 0.8, 12, 1, true);
  const bandMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide });
  const band = new THREE.InstancedMesh(bandGeo, bandMat, n);
  band.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  band.castShadow = false;

  // Flag at the masthead — a plane, double-sided, so the mark never reads as a bare piling.
  const flagGeo = new THREE.PlaneGeometry(2.2, 1.3);
  const flagMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide });
  const flag = new THREE.InstancedMesh(flagGeo, flagMat, n);
  flag.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  flag.castShadow = false;

  group.add(body, collar, mast, band, flag);

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
      const isNext = i === nextIndex;
      if (isNext) {
        const pulse = 0.72 + 0.28 * Math.sin(t * 5);
        col.setRGB(1.0 * pulse, 0.78 * pulse, 0.12 * pulse);
      } else {
        col.setRGB(0.92, 0.26, 0.06);
      }
      body.setColorAt(i, col);

      // Emissive band: the next mark burns amber, the rest glow a dim orange so the whole course
      // stays legible at dusk without competing with the one you are driving at.
      const h = MAST_H;
      if (isNext) { const p = 0.78 + 0.22 * Math.sin(t * 5); col.setRGB(1.5 * p, 1.15 * p, 0.2 * p); }
      else col.setRGB(0.95, 0.34, 0.1);
      band.setColorAt(i, col);
      dummy.position.set(p.x, surf + BODY_H * 0.55, p.z);
      dummy.rotation.set(lean, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      band.setMatrixAt(i, dummy.matrix);

      // Mast — scaled on Y so one geometry serves both heights.
      const mh = i === 0 ? START_MAST_H : h;
      dummy.position.set(p.x, surf + mh * 0.5, p.z);
      dummy.rotation.set(lean * 0.6, 0, 0);
      dummy.scale.set(1, mh, 1);
      dummy.updateMatrix();
      mast.setMatrixAt(i, dummy.matrix);

      // Flag, turned slowly so it catches the eye and never presents edge-on for long.
      dummy.position.set(p.x + 1.05, surf + mh - 0.9, p.z);
      dummy.rotation.set(0, t * 0.6 + i, Math.sin(t * 2.4 + i) * 0.12);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      flag.setMatrixAt(i, dummy.matrix);
      if (isNext) { const p2 = 0.8 + 0.2 * Math.sin(t * 5); col.setRGB(1.6 * p2, 1.25 * p2, 0.25 * p2); }
      else col.setRGB(1.0, 1.0, 1.0);
      flag.setColorAt(i, col);
    }
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    collar.instanceMatrix.needsUpdate = true;
    mast.instanceMatrix.needsUpdate = true;
    band.instanceMatrix.needsUpdate = true;
    if (band.instanceColor) band.instanceColor.needsUpdate = true;
    flag.instanceMatrix.needsUpdate = true;
    if (flag.instanceColor) flag.instanceColor.needsUpdate = true;
  }

  function setVisible(v: boolean): void { group.visible = v; }

  function dispose(): void {
    bodyGeo.dispose(); collarGeo.dispose(); mastGeo.dispose(); bandGeo.dispose(); flagGeo.dispose();
    bodyMat.dispose(); collarMat.dispose(); mastMat.dispose(); bandMat.dispose(); flagMat.dispose();
    body.dispose(); collar.dispose(); mast.dispose(); band.dispose(); flag.dispose();
  }

  return { group, update, setVisible, dispose };
}
