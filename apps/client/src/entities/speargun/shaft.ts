/**
 * Visuals for the two things sim/spear.ts's pure integrator produces: the flying shaft
 * (`ShotState`, while `alive`) and, once it lands, the float-line running from the speared fish
 * up to a small surface float — a common real-spearfishing rig (a breakaway/float line keeps a
 * hard-fighting fish from towing the diver into the reef) and this port's visual distinguisher
 * from rod fishing's bobber-on-a-rod-tip line.
 */
import * as THREE from 'three';
import { waveHBase } from '@keysrun/shared/waves';
import type { ShotState } from '@keysrun/shared/sim/spear';
import type { Vec3 } from '@keysrun/shared/sim/spear';

export interface ShaftVisual {
  mesh: THREE.Mesh;
  setVisible(v: boolean): void;
  update(shot: ShotState): void;
  dispose(): void;
}

const SHAFT_LEN = 0.6;

export function createShaftVisual(scene: THREE.Scene): ShaftVisual {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, SHAFT_LEN, 6).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xc9ced3, metalness: 0.8, roughness: 0.3 }),
  );
  mesh.visible = false;
  scene.add(mesh);

  function setVisible(v: boolean): void { mesh.visible = v; }

  function update(shot: ShotState): void {
    // The shaft's *tail* trails `SHAFT_LEN` behind its leading point (`shot.dist`) rather than
    // centering on it, so the tip — not the midpoint — is what actually reaches `shot.dist`
    // (and so a hit at `atDist` looks like the point, not the middle of the shaft, struck home).
    const tipDist = shot.dist, tailDist = Math.max(0, shot.dist - SHAFT_LEN);
    const midDist = (tipDist + tailDist) / 2;
    mesh.position.set(shot.ox + shot.dx * midDist, shot.oy + shot.dy * midDist, shot.oz + shot.dz * midDist);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(shot.dx, shot.dy, shot.dz));
  }

  function dispose(): void { scene.remove(mesh); mesh.geometry.dispose(); }

  return { mesh, setVisible, update, dispose };
}

export interface FloatLineVisual {
  group: THREE.Group;
  setVisible(v: boolean): void;
  /** `fishPos` is the speared fish's current position (`SpearFightState.x/z` plus a cosmetic
   * depth); `t`/`sw`/`ch` feed the float's bob, same wave function the surface bobber/hull use
   * (`waveHBase` — no boat wake term here; see this module's header, a diver away from the boat
   * doesn't need that contribution). */
  update(fishPos: Vec3, t: number, sw: number, ch: number): void;
  dispose(): void;
}

const LSEG = 16;

export function createFloatLineVisual(scene: THREE.Scene): FloatLineVisual {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((LSEG + 1) * 3), 3));
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
  line.frustumCulled = false;
  group.add(line);

  const float = new THREE.Group();
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshStandardMaterial({ color: 0xf2c14e }));
  top.position.y = 0.07;
  float.add(top);
  const bot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  bot.position.y = -0.06;
  float.add(bot);
  group.add(float);

  function setVisible(v: boolean): void { group.visible = v; }

  function update(fishPos: Vec3, t: number, sw: number, ch: number): void {
    const surfaceY = waveHBase(fishPos.x, fishPos.z, t, 0.3, sw, ch);
    float.position.set(fishPos.x, surfaceY, fishPos.z);
    const arr = lineGeo.attributes.position.array as Float32Array;
    for (let i = 0; i <= LSEG; i++) {
      const u = i / LSEG;
      arr[i * 3] = fishPos.x;
      arr[i * 3 + 1] = fishPos.y + (surfaceY - fishPos.y) * u;
      arr[i * 3 + 2] = fishPos.z;
    }
    lineGeo.attributes.position.needsUpdate = true;
  }

  function dispose(): void {
    scene.remove(group);
    lineGeo.dispose();
  }

  return { group, setVisible, update, dispose };
}
