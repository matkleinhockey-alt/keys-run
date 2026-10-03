/**
 * Placeholder diver visual: a low-poly wetsuited capsule, mask and a pair of fins that kick in
 * proportion to swim speed. There is no diver asset yet (legacy has no underwater gameplay at
 * all — see docs/ARCHITECTURE.md) and a real skinned glTF is out of this task's scope (physics/
 * camera/HUD/controls are; character art is not) — this exists so the mask/chase camera and the
 * Playwright screenshots have something recognisable on screen, not to be the final art.
 *
 * Faces -Z at yaw=0, matching `BoatState.h`'s forward convention exactly (fx=-sin(yaw),
 * fz=-cos(yaw) — see sim/diver.ts) so `group.rotation.y = state.yaw` orients it correctly with
 * zero translation between the physics convention and three.js.
 */
import * as THREE from 'three';

export interface DiverModel {
  group: THREE.Group;
  animate(t: number, speed: number): void;
}

export function createDiverModel(): DiverModel {
  const group = new THREE.Group();

  const wetsuit = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.55, flatShading: true });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc98a63, roughness: 0.6, flatShading: true });
  const maskMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.15, metalness: 0.4 });
  const finMat = new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.5, flatShading: true });
  const tankMat = new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.35, metalness: 0.5 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.9, 4, 8), wetsuit);
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), skin);
  head.position.set(0, 0.04, -0.62);
  group.add(head);

  const mask = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.09, 0.05), maskMat);
  mask.position.set(0, 0.06, -0.73);
  group.add(mask);

  // A freediver wouldn't carry a tank, but a small buoyancy-compensator-ish ridge along the back
  // reads better on screen than a bare capsule and costs one extra mesh.
  const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.5, 4, 6), tankMat);
  tank.rotation.x = Math.PI / 2;
  tank.position.set(0, 0.18, 0.05);
  group.add(tank);

  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.55, 2, 6), wetsuit);
  armL.rotation.z = Math.PI / 2.3;
  armL.position.set(-0.3, 0.02, -0.25);
  group.add(armL);
  const armR = armL.clone();
  armR.rotation.z = -Math.PI / 2.3;
  armR.position.x = 0.3;
  group.add(armR);

  const finGeo = new THREE.ConeGeometry(0.13, 0.6, 4);
  const finPivotL = new THREE.Group();
  finPivotL.position.set(-0.11, 0, 0.55);
  const finL = new THREE.Mesh(finGeo, finMat);
  finL.rotation.x = Math.PI / 2;
  finL.position.z = 0.3;
  finPivotL.add(finL);
  group.add(finPivotL);

  const finPivotR = new THREE.Group();
  finPivotR.position.set(0.11, 0, 0.55);
  const finR = new THREE.Mesh(finGeo, finMat);
  finR.rotation.x = Math.PI / 2;
  finR.position.z = 0.3;
  finPivotR.add(finR);
  group.add(finPivotR);

  group.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });

  return {
    group,
    animate(t: number, speed: number) {
      const k = Math.min(1, speed / 1.8);
      const rate = 3.5 + k * 7;
      const ph = t * rate;
      finPivotL.rotation.x = Math.sin(ph) * (0.25 + k * 0.5);
      finPivotR.rotation.x = Math.sin(ph + Math.PI) * (0.25 + k * 0.5);
    },
  };
}
