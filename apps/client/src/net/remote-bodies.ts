/**
 * Other players' bodies when they are off their boats: a walking person ashore (the same
 * `makeHuman` + `animateGait` the local walker uses, entities/land/index.ts) or a diver in the
 * water (entities/diver/model.ts), with a nametag. Fed by `NetClient.getRemoteBodies()`, which
 * holds what the sim relayed (apps/sim/src/world/bodies.ts) at ~10 Hz.
 *
 * Bodies arrive at 10 Hz and render at 60, so each one eases toward the last position heard
 * (SMOOTH_PER_S) rather than snapping: a walk or a swim is slow enough that ~100 ms of lag reads
 * as smooth, and nothing needs it exact — a body is cosmetic, the boat is the envelope-checked
 * entity. A body appears with the same 0.4 s scale-in as a remote boat.
 */
import * as THREE from 'three';
import { makeHuman, type Human } from '../entities/life/human.js';
import { animateGait } from '../entities/town/people.js';
import { createDiverModel, type DiverModel } from '../entities/diver/model.js';
import type { RemoteBody } from './client.js';
import './net.css';

const SMOOTH_PER_S = 10;
const FADE_S = 0.4;
/** Nametags further than this are hidden: past it a person is a few pixels tall. */
const TAG_RANGE_M = 160;

/** Shirts, by slot, so two people ashore are told apart at a glance. */
const SHIRTS = [0x2f80ed, 0xf2c94c, 0x27ae60, 0x9b51e0, 0xeb5757, 0x56ccf2, 0xf2994a, 0xbb6bd9];

interface Instance {
  mode: RemoteBody['mode'];
  group: THREE.Group;
  human: Human | null;
  diver: DiverModel | null;
  tag: HTMLDivElement;
  x: number; y: number; z: number; h: number;
  gait: number;
  age: number;
}

export interface RemoteBodyManager {
  update(dt: number, timeS: number, bodies: readonly RemoteBody[], nameOf: (slotId: number) => string | undefined): void;
  dispose(): void;
}

export function createRemoteBodyManager(scene: THREE.Scene, camera: THREE.PerspectiveCamera, wrap: HTMLElement): RemoteBodyManager {
  const instances = new Map<number, Instance>();
  const tagLayer = document.createElement('div');
  tagLayer.className = 'krNetTags';
  wrap.appendChild(tagLayer);
  const ndc = new THREE.Vector3();

  function spawn(b: RemoteBody): Instance {
    let group: THREE.Group, human: Human | null = null, diver: DiverModel | null = null;
    if (b.mode === 'walk') {
      human = makeHuman({ walker: true, skin: 0xd9a27f, shirt: SHIRTS[b.slotId % SHIRTS.length], shortSleeve: true, shorts: 0x2b4a6e, cap: 0xffffff, shoes: 0xe9e4d8, hair: 0x3b2a1e });
      group = human.group;
    } else {
      diver = createDiverModel();
      group = diver.group;
    }
    group.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = false; });
    scene.add(group);
    const tag = document.createElement('div');
    tag.className = 'krNetTag';
    tagLayer.appendChild(tag);
    const inst: Instance = { mode: b.mode, group, human, diver, tag, x: b.x, y: b.y, z: b.z, h: b.h, gait: 0, age: 0 };
    instances.set(b.slotId, inst);
    return inst;
  }

  function despawn(slotId: number): void {
    const inst = instances.get(slotId);
    if (!inst) return;
    scene.remove(inst.group);
    inst.tag.remove();
    instances.delete(slotId);
  }

  function update(dt: number, timeS: number, bodies: readonly RemoteBody[], nameOf: (slotId: number) => string | undefined): void {
    const live = new Set<number>();
    const k = 1 - Math.exp(-SMOOTH_PER_S * dt);
    for (const b of bodies) {
      live.add(b.slotId);
      let inst = instances.get(b.slotId);
      if (inst && inst.mode !== b.mode) { despawn(b.slotId); inst = undefined; }
      if (!inst) inst = spawn(b);

      // A jump of tens of metres is a teleport (a cab back to the dock), not a walk: snap.
      if (Math.hypot(b.x - inst.x, b.z - inst.z) > 30) { inst.x = b.x; inst.y = b.y; inst.z = b.z; inst.h = b.h; }
      inst.x += (b.x - inst.x) * k;
      inst.y += (b.y - inst.y) * k;
      inst.z += (b.z - inst.z) * k;
      inst.h += wrapAngle(b.h - inst.h) * k;
      inst.age += dt;

      const g = inst.group;
      if (inst.human) {
        inst.gait += b.speed * dt * 2.1; // the walker's own rate (packages/shared/src/sim/walker.ts)
        const bob = animateGait(inst.human, inst.gait, Math.min(1, b.speed / 2.4));
        g.position.set(inst.x, inst.y + bob, inst.z);
        g.rotation.y = inst.h + Math.PI;
        inst.human.update(timeS, 0);
      } else if (inst.diver) {
        g.position.set(inst.x, inst.y, inst.z);
        g.rotation.set(0, inst.h, 0, 'YXZ');
        inst.diver.animate(timeS, b.speed);
      }
      g.scale.setScalar(Math.max(0.001, easeOutCubic(Math.min(1, inst.age / FADE_S))));

      inst.tag.textContent = nameOf(b.slotId) ?? `Player ${b.slotId}`;
      ndc.set(inst.x, inst.y + (inst.human ? 2.3 : 0.9), inst.z).project(camera);
      const visible = ndc.z < 1 && Math.hypot(inst.x - camera.position.x, inst.z - camera.position.z) < TAG_RANGE_M;
      inst.tag.style.display = visible ? 'block' : 'none';
      if (visible) {
        inst.tag.style.left = `${((ndc.x + 1) / 2) * wrap.clientWidth}px`;
        inst.tag.style.top = `${((1 - ndc.y) / 2) * wrap.clientHeight}px`;
      }
    }
    for (const slotId of [...instances.keys()]) if (!live.has(slotId)) despawn(slotId);
  }

  function dispose(): void {
    for (const slotId of [...instances.keys()]) despawn(slotId);
    tagLayer.remove();
  }

  return { update, dispose };
}

function wrapAngle(a: number): number {
  return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}
