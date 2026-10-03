/**
 * Spearfishing — the headline new mechanic (docs/ARCHITECTURE.md "Spearfishing"). Assembles the
 * pure integrator (`@keysrun/shared/sim/spear`) with presentation: the first-person gun,
 * flying-shaft and float-line visuals, and lands a speared fish through the same catch path rod
 * fishing uses (game/catch's `landFish`).
 *
 * **Integration point for the diver agent**: this module code against `DiverAimInput` below — a
 * small, local, three.js-free interface for "where is the diver, which way are they looking, how
 * much breath do they have" — rather than importing `DiverState` directly, so it can be built and
 * tested now without blocking on that work landing. Once it exists, whatever owns the diver's
 * per-tick loop calls `update(dt, t, diverAimInput, sw, ch)` every fixed step and `tryFire`/
 * `setHauling` on the player's fire/haul input edges — mirroring exactly how game/fishing/index.ts
 * drives `stepFight` today. The diver module should derive `aimDir` from the look camera the same
 * way game/fishing/update.ts's `cast()` derives a cast direction from `camera.getWorldDirection`/
 * `fp.yaw`.
 *
 * `getTargets()` is the other integration seam: until the fish agent's tier-3 tracked-fish
 * registry exists (docs/ARCHITECTURE.md "Fish ownership — three tiers"), there is nothing to
 * wire it to, so a caller with no registry yet can return `[]` — the gun still fires, flies,
 * times out at `SPEAR_RANGE`, and reloads correctly; it just never finds a hit. The Playwright
 * test under apps/client/test/ exercises the hit path directly with a synthetic target.
 */
import * as THREE from 'three';
import { zoneAt } from '@keysrun/shared/world/depth';
import { mulberry32, type Rng } from '@keysrun/shared/rng';
import {
  createGun, canFire, stepReload, startReload,
  fire, stepSpear, spearFightParamsFor, startSpearFight, stepSpearFight,
  SPEAR_RELOAD,
  type GunState, type ShotState, type CapsuleTarget, type SpearFightState, type SpearFightParams, type Vec3,
} from '@keysrun/shared/sim/spear';
import { createGunViewModel } from './gun-viewmodel.js';
import { createShaftVisual, createFloatLineVisual } from './shaft.js';
import type { CaughtFishInfo } from '../../game/catch/catch-flow.js';

/** A fish candidate for this shot — the pure `CapsuleTarget` sim/spear.ts hit-tests against,
 * plus the species/weight this presentation layer needs once it's hit (the sim module itself
 * stays domain-agnostic about what a "fish" is; see sim/spear.ts's header). */
export type SpearTarget = CapsuleTarget & { key: string; weight: number };

/** The diver-interface integration seam — see this module's header. */
export interface DiverAimInput {
  position: Vec3;
  /** Need not be unit length; `fire()` normalizes. */
  aimDir: Vec3;
  /** 0..1 remaining fraction. docs/ARCHITECTURE.md's spearfishing envelope: "cannot fire at
   * breath <= 0" — enforced here client-side for immediate feedback, same status as the rod's
   * client-side `chooseFish` roll (see sim/fight.ts's header): a later phase's server envelope
   * check is the real authority. */
  breath: number;
}

export interface SpeargunDeps {
  scene: THREE.Scene;
  camera: THREE.Camera;
  getTargets(): readonly SpearTarget[];
  onLanded(fish: CaughtFishInfo): void;
}

export interface Speargun {
  update(dt: number, t: number, diver: DiverAimInput, sw: number, ch: number): void;
  /** Attempts a shot; returns whether it actually fired (gated on reload + breath, same shape as
   * game/fishing's `startCharge`'s speed gate returning early with a toast-worthy reason). */
  tryFire(diver: DiverAimInput): boolean;
  /** Diver is hauling the speared fish in (the spear's equivalent of the rod's `reeling`). */
  setHauling(v: boolean): void;
  /** True while a shaft is in flight or a fish is speared — callers can use this the way
   * game/fishing uses `lineOut()`. */
  isActive(): boolean;
  /** Read-only snapshot of the speared-fish fight, or `null` when nothing is on the spear —
   * for a tension/stamina HUD, same role as game/fishing's directly-readable `F` singleton
   * (`F.fight.tension`/`.stam`). */
  getFightState(): SpearFightState | null;
  dispose(): void;
}

const clientRng: Rng = mulberry32((Date.now() ^ 0x5bd1e995) >>> 0);

interface Speared {
  target: SpearTarget;
  params: SpearFightParams;
  fight: SpearFightState;
}

export function createSpeargun(deps: SpeargunDeps): Speargun {
  const gunVM = createGunViewModel(deps.camera);
  const shaftVisual = createShaftVisual(deps.scene);
  const floatLine = createFloatLineVisual(deps.scene);

  let gun: GunState = createGun();
  let shot: ShotState | null = null;
  let speared: Speared | null = null;
  let hauling = false;

  function tryFire(diver: DiverAimInput): boolean {
    if (shot || speared) return false; // one shaft out at a time — see this module's header
    if (!canFire(gun)) return false;
    if (diver.breath <= 0) return false;
    shot = fire(diver.position, diver.aimDir);
    gun = startReload(SPEAR_RELOAD);
    shaftVisual.setVisible(true);
    shaftVisual.update(shot);
    gunVM.kick();
    return true;
  }

  function setHauling(v: boolean): void { hauling = v; }

  function isActive(): boolean { return !!shot || !!speared; }

  function getFightState(): SpearFightState | null { return speared ? speared.fight : null; }

  function resolveShotMiss(): void {
    shot = null;
    shaftVisual.setVisible(false);
  }

  function update(dt: number, t: number, diver: DiverAimInput, sw: number, ch: number): void {
    gun = stepReload(gun, dt);
    if (shot) {
      const targets = deps.getTargets();
      const { shot: nextShot, hit } = stepSpear(shot, targets, dt);
      shot = nextShot;
      if (hit) {
        const target = targets.find((cand) => cand.id === hit.id);
        shaftVisual.setVisible(false);
        shot = null;
        if (target) {
          const params = spearFightParamsFor(target.key, target.weight);
          speared = { target, params, fight: startSpearFight(hit.point.x, hit.point.z) };
          floatLine.setVisible(true);
        }
      } else if (!shot.alive) {
        resolveShotMiss();
      } else {
        shaftVisual.update(shot);
      }
    }

    if (speared) {
      const next = stepSpearFight(speared.fight, { hauling }, speared.params, { diverX: diver.position.x, diverZ: diver.position.z }, clientRng, dt);
      speared.fight = next;
      floatLine.update({ x: next.x, y: diver.position.y, z: next.z }, t, sw, ch);
      if (next.outcome === 'landed') {
        deps.onLanded({ key: speared.target.key, weight: speared.target.weight, x: next.x, z: next.z, zone: zoneAt(next.x, next.z) });
        speared = null;
        floatLine.setVisible(false);
      } else if (next.outcome === 'tornFree') {
        speared = null;
        floatLine.setVisible(false);
      }
    }

    const reloadFrac = Math.min(1, 1 - gun.reloadT / SPEAR_RELOAD);
    gunVM.update(dt, reloadFrac, !!speared);
  }

  function dispose(): void {
    gunVM.dispose();
    shaftVisual.dispose();
    floatLine.dispose();
  }

  return { update, tryFire, setHauling, isActive, getFightState, dispose };
}
