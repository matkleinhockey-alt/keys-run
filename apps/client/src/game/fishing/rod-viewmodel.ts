/**
 * First-person rod view model (legacy index.html:2825-2865, "Fishing Planet style"): a jointed
 * rod rendered in camera space, bending under tension and whipping on a cast.
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math.js';
import { F } from './state.js';

export interface RodViewModel {
  group: THREE.Group;
  tip: THREE.Object3D;
  update(dt: number, fpOn: boolean, reeling: boolean, actionHeld: boolean): void;
  whip(): void;
}

export function createRodViewModel(camera: THREE.Camera): RodViewModel {
  const group = new THREE.Group();
  group.visible = false;
  camera.add(group);

  const base = new THREE.Group();
  base.position.set(0.3, -0.42, -0.55);
  base.rotation.set(-1.15, 0.16, 0, 'YXZ');
  group.add(base);

  const segs: THREE.Group[] = [];
  let tip: THREE.Object3D;
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x1d2126, roughness: 0.3, metalness: 0.3 });
  const SEGL = 0.52;
  let parent: THREE.Object3D = base;
  for (let i = 0; i < 5; i++) {
    const sg = new THREE.Group();
    if (i > 0) sg.position.y = SEGL;
    parent.add(sg);
    const r0 = 0.022 - 0.0034 * i, r1 = Math.max(0.004, r0 - 0.0034);
    sg.add(new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, SEGL, 8).translate(0, SEGL / 2, 0), rodMat));
    if (i > 0) {
      const gd = new THREE.Mesh(new THREE.TorusGeometry(0.018 - 0.002 * i, 0.003, 4, 10), new THREE.MeshStandardMaterial({ color: 0xc9ced3, metalness: 0.8, roughness: 0.2 }));
      gd.position.set(0, 0.02, -0.02);
      sg.add(gd);
    }
    segs.push(sg);
    parent = sg;
  }
  tip = new THREE.Object3D();
  tip.position.y = SEGL;
  parent.add(tip);

  const s0 = segs[0];
  const cork = new THREE.MeshStandardMaterial({ color: 0xb8925e, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.35, metalness: 0.5 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.25, metalness: 0.8 });
  s0.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.032, 0.34, 10).translate(0, 0.12, 0), cork));

  const reel = new THREE.Group();
  reel.position.set(0, 0.3, -0.075);
  s0.add(reel);
  reel.add(new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.012, 0.06).translate(0, 0, 0.035), dark));
  reel.add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 14), dark));
  const spool = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.05, 14), gold);
  spool.position.y = 0.065;
  reel.add(spool);
  const handle = new THREE.Group();
  handle.position.set(0.055, 0, 0);
  reel.add(handle);
  handle.add(new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.1, 0.012).translate(0, 0.05, 0), dark));
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.04, 8), dark);
  knob.rotation.z = Math.PI / 2;
  knob.position.set(0.02, 0.1, 0);
  handle.add(knob);

  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a27f, roughness: 0.6, flatShading: true });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x9cc8e0, roughness: 0.8, flatShading: true });
  const gripHand = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.11, 0.1), skin);
  gripHand.position.set(0, 0.38, -0.02);
  s0.add(gripHand);
  const cuff1 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.45, 8), sleeve);
  cuff1.position.set(0.02, 0.3, -0.2);
  cuff1.rotation.x = 1.1;
  s0.add(cuff1);
  const crankHand = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.075), skin);
  crankHand.position.set(0.045, 0.1, 0);
  handle.add(crankHand);
  const cuff2 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.4, 8), sleeve);
  cuff2.position.set(0.16, 0.16, -0.22);
  cuff2.rotation.set(0.9, 0, -0.5);
  s0.add(cuff2);

  let whipT = 0;

  function update(dt: number, fpOn: boolean, reeling: boolean, actionHeld: boolean): void {
    group.visible = fpOn;
    if (!fpOn) return;
    let bend = 0.01;
    if (F.state === 'fight' && F.fight) bend = clamp(F.fight.tension, 0, 1.1) * 0.15 + F.fight.shake * 0.08 * Math.sin(performance.now() * 0.045);
    else if (F.state === 'bite') bend = 0.09;
    else if (F.state === 'nibble' && F.dipT > 0) bend = 0.045;
    segs.forEach((s, i) => { if (i > 0) s.rotation.x = lerp(s.rotation.x, -bend, Math.min(1, dt * 10)); });
    let rx = -1.15 + (F.charging ? F.charge * 0.7 : 0);
    if (whipT > 0) {
      whipT = Math.max(0, whipT - dt / 0.35);
      rx -= 0.45 * Math.sin(whipT * Math.PI);
    }
    base.rotation.x = lerp(base.rotation.x, rx, Math.min(1, dt * 14));
    if (reeling || (F.state === 'fight' && actionHeld)) handle.rotation.x -= dt * 22;
  }

  return { group, tip, update, whip: () => { whipT = 1; } };
}
