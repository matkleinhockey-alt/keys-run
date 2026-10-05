/**
 * Renders every other connected player's boat into the local scene: one `makeBoat()` instance
 * per remote slot, driven each frame by `NetClient.getRemoteBoats()`'s extrapolated poses
 * (net/extrapolate.ts — "boats extrapolate, not interpolate", docs/ARCHITECTURE.md), a 0.4 s
 * spawn fade-in (task brief: "so nothing pops"), and a nametag `<div>` projected to screen space
 * the same way legacy's multiplayer ghosts did (legacy/index.html's `MP.ghosts`/`updateMultiplayer`
 * — see this project's report for the exact lines).
 *
 * Deliberately does NOT reuse `entities/boat/visuals.ts`'s `applyBoatVisuals`: that function
 * spawns wake/spray particles, writes toasts, and syncs the water shader's *own* wake uniform —
 * all tied to the *local* player's single boat and its physics events, none of which exist for a
 * remote boat (we only ever receive x/z/h/speed, never events, never a wake ring — see
 * docs/ARCHITECTURE.md's authority table: y/pitch/roll/wake are "client only, never sent
 * upstream"). This module's own, much smaller per-frame update (position/heading + a cosmetic
 * water-height bob, prop spin, wheel turn) is the right amount of visual fidelity for a boat
 * whose own owner is already rendering the authoritative version.
 *
 * Materials/geometry: `makeBoat()` itself is now cache-backed (see entities/boat/model.ts's
 * multiplayer-scaling-fix doc comment) — this module just calls it once per remote slot the same
 * way game/world.ts calls it once for the local player, and that sharing is what keeps N remote
 * boats from costing N times the shader/texture memory of one.
 */
import * as THREE from 'three';
import { BOATS } from '@keysrun/shared/content/boats';
import { waveHBase, DEFAULT_SW, DEFAULT_CH } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { makeBoat, type BoatModel, type BoatBuildDeps } from '../entities/boat/model.js';
import type { RemoteBoatSnapshot } from './client.js';
import './net.css';

interface RemoteInstance {
  model: BoatModel;
  hullIndex: number;
  tag: HTMLDivElement;
  lastUpdateMs: number;
}

export interface RemoteBoatManager {
  /** Called every rendered frame with the net client's current extrapolated snapshots. */
  update(nowMs: number, simTimeS: number, snapshots: readonly RemoteBoatSnapshot[]): void;
  dispose(): void;
}

/** Deliberately minimal deps: remote boats don't need the local player's live MFD/GPS/sonar
 * textures or day/night-reactive light opacity (see the module doc comment) — a tiny shared
 * placeholder texture and a fixed mid-day `todK` are enough for a boat someone else is driving. */
function remoteBuildDeps(): BoatBuildDeps {
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const placeholder = new THREE.CanvasTexture(c);
  return { lightMats: [], todK: 0.3, mfdTex: placeholder, gpsTex: placeholder, sonTex: placeholder };
}

export function createRemoteBoatManager(scene: THREE.Scene, camera: THREE.PerspectiveCamera, wrap: HTMLElement): RemoteBoatManager {
  const instances = new Map<number, RemoteInstance>();

  const tagLayer = document.createElement('div');
  tagLayer.className = 'krNetTags';
  wrap.appendChild(tagLayer);

  const presence = document.createElement('div');
  presence.className = 'krNetPresence hidden';
  wrap.appendChild(presence);

  const ndc = new THREE.Vector3();

  function spawnInstance(slotId: number, hullIndex: number, nowMs: number): RemoteInstance {
    const spec = BOATS[hullIndex] ?? BOATS[0];
    const model = makeBoat(spec, remoteBuildDeps());
    model.group.traverse((o) => {
      // Perf: a remote boat's own shadow contribution is not worth a shadow-pass draw call per
      // peer (docs/ARCHITECTURE.md's "< 400 draw calls" budget) — same call legacy's MP ghosts made.
      if (o instanceof THREE.Mesh) o.castShadow = false;
    });
    scene.add(model.group);

    const tag = document.createElement('div');
    tag.className = 'krNetTag';
    tag.textContent = `Player ${slotId}`;
    tagLayer.appendChild(tag);

    const inst: RemoteInstance = { model, hullIndex, tag, lastUpdateMs: nowMs };
    instances.set(slotId, inst);
    return inst;
  }

  function despawnInstance(slotId: number): void {
    const inst = instances.get(slotId);
    if (!inst) return;
    scene.remove(inst.model.group);
    inst.tag.remove();
    instances.delete(slotId);
  }

  function update(nowMs: number, simTimeS: number, snapshots: readonly RemoteBoatSnapshot[]): void {
    const liveSlots = new Set<number>();
    for (const snap of snapshots) {
      liveSlots.add(snap.slotId);
      let inst = instances.get(snap.slotId);
      if (!inst || inst.hullIndex !== snap.hullIndex) {
        if (inst) despawnInstance(snap.slotId);
        inst = spawnInstance(snap.slotId, snap.hullIndex, nowMs);
      }

      const dt = Math.max(0, Math.min(0.1, (nowMs - inst.lastUpdateMs) / 1000));
      inst.lastUpdateMs = nowMs;

      const { x, z, h, speed } = snap.pose;
      const amp = ampAt(x, z);
      const y = waveHBase(x, z, simTimeS, amp, DEFAULT_SW, DEFAULT_CH);
      const g = inst.model.group;
      g.position.set(x, y, z);
      g.rotation.set(0, h, 0, 'YXZ');

      // 0.4 s scale-in on spawn (task brief: "fade in over 0.4 s on spawn so nothing pops").
      // A geometric scale tween rather than a material-opacity fade: boat materials are now
      // shared across every instance of a boat type (see model.ts), so fading *opacity* on one
      // instance's material would visibly fade every other instance sharing it.
      const scale = snap.fade < 1 ? easeOutCubic(snap.fade) : 1;
      g.scale.setScalar(Math.max(0.001, scale));

      inst.model.props.forEach((p) => { p.rotation.z += dt * (speed * 0.8); });

      ndc.set(x, y + 5.5, z).project(camera);
      const dx = x - camera.position.x, dz = z - camera.position.z;
      const visible = ndc.z < 1 && Math.hypot(dx, dz) < 1400;
      inst.tag.style.display = visible ? 'block' : 'none';
      if (visible) {
        inst.tag.style.left = `${((ndc.x + 1) / 2) * wrap.clientWidth}px`;
        inst.tag.style.top = `${((1 - ndc.y) / 2) * wrap.clientHeight}px`;
      }
    }

    for (const slotId of instances.keys()) {
      if (!liveSlots.has(slotId)) despawnInstance(slotId);
    }

    const count = instances.size;
    presence.classList.toggle('hidden', count === 0);
    if (count > 0) presence.textContent = `👥 ${count} other boat${count === 1 ? '' : 's'} out here`;
  }

  function dispose(): void {
    for (const slotId of Array.from(instances.keys())) despawnInstance(slotId);
    tagLayer.remove();
    presence.remove();
  }

  return { update, dispose };
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}
