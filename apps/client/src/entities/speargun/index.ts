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
import { createShaftVisual, createFloatLineVisual, createMuzzleBubbles } from './shaft.js';
import { createSpearFightUI } from './fight-ui.js';
import { createSperedFishVisual } from './speared-fish-visual.js';
import { toast } from '../../ui/toast.js';
import { SPECIES } from '@keysrun/shared/content/species';
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
  /** True exactly while `DiverState.blackedOut` (packages/shared/src/sim/diver.ts) — checked
   * separately from `breath<=0` because a shallow-water blackout can fire with `breath` still a
   * few seconds from empty. Gates `tryFire` and force-resolves an in-progress fight the instant
   * it flips true (see `update`'s header note on the breath/fight interaction). Optional only so
   * apps/client/test/spear-harness.ts's existing literal (predating this field) keeps compiling. */
  blackedOut?: boolean;
  /** Diver swim speed, m/s (`Math.hypot(vx,vy,vz)`) — purely cosmetic, sizes the view model's
   * idle sway (gun-viewmodel.ts). Optional for the same reason as `blackedOut`. */
  speed?: number;
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
  /** Unconditional cleanup for a mode exit (diver climbing back aboard) — mirrors
   * game/fishing/index.ts's `reelIn()` being called the moment the diver jumps in, the other
   * direction: hides every visual and drops any in-flight shot/speared fish without resolving it
   * through `landed`/`tornFree`. Safe to call when nothing is active. */
  reset(): void;
  /** VERIFICATION-ONLY: zeroes the reload timer. Real play never needs this (the 2.5 s reload is
   * the point) — it exists because this sandbox's fixed-dt accumulator clamps to 0.05 s of
   * simulated time per *rendered* frame (game/world.ts's `frame()`), and this sandbox's measured
   * ~2-4 fps means simulated time crawls at roughly a fifth to a tenth of real wall-clock time —
   * a Playwright script's `waitForTimeout(3000)` was observed not being enough real time for a
   * 2.5 s *simulated* reload to actually clear. Bypassing it here is simpler and more honest than
   * padding every verification script with multi-minute real-time waits to chase simulated time
   * that will never run at real speed in this environment anyway. */
  debugForceReloadReady(): void;
  /** Unlike game/fishing/rod-viewmodel.ts (which toggles between a first-person rod and a
   * boat-mounted one — see that file's header), there is no boat-mounted speargun: it's either
   * visible (diving) or not shown at all (aboard). `game/world.ts`'s `setDiveUI` calls this on
   * every dive-mode transition, the same place it toggles `diverModel.group.visible`. */
  setViewVisible(v: boolean): void;
  dispose(): void;
}

const clientRng: Rng = mulberry32((Date.now() ^ 0x5bd1e995) >>> 0);

interface Speared {
  target: SpearTarget;
  params: SpearFightParams;
  fight: SpearFightState;
}

/** Same shape as game/fishing/update.ts's `setHook` opening line, scaled off the species' own
 * min/max rather than a second, independent "how big is big" table. */
function fightLabelFor(key: string, weight: number): string {
  const S = SPECIES[key];
  const sizeT = S ? clampSizeT((weight - S.min) / (S.max - S.min)) : 0.5;
  return sizeT > 0.7 ? 'Something heavy is on the spear' : sizeT > 0.35 ? 'Solid fish on the spear' : 'Fish on the spear';
}
function clampSizeT(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

const tmpMuzzle = new THREE.Vector3();

export function createSpeargun(deps: SpeargunDeps): Speargun {
  const gunVM = createGunViewModel(deps.camera);
  const shaftVisual = createShaftVisual(deps.scene);
  const floatLine = createFloatLineVisual(deps.scene);
  const muzzleBubbles = createMuzzleBubbles(deps.scene);
  const speredVisual = createSperedFishVisual(deps.scene);
  const fightUI = createSpearFightUI();

  let gun: GunState = createGun();
  let shot: ShotState | null = null;
  let speared: Speared | null = null;
  let hauling = false;

  function tryFire(diver: DiverAimInput): boolean {
    if (shot || speared) return false; // one shaft out at a time — see this module's header
    if (!canFire(gun)) return false;
    if (diver.breath <= 0 || diver.blackedOut) return false;
    // The shot's visual origin is the view model's actual muzzle, not the diver's body position
    // (`diver.position` is still what the fight env below ties the tether to) — same convention
    // as game/fishing/update.ts's `cast()` reading `rodVM.tip`'s world position for `F.from`
    // rather than the boat's own origin.
    gunVM.muzzle.getWorldPosition(tmpMuzzle);
    const origin = { x: tmpMuzzle.x, y: tmpMuzzle.y, z: tmpMuzzle.z };
    shot = fire(origin, diver.aimDir);
    gun = startReload(SPEAR_RELOAD);
    shaftVisual.setVisible(true);
    shaftVisual.update(shot);
    gunVM.kick();
    // A loaded band snapping forward through water visibly exhausts a puff of air out the
    // muzzle — see shaft.ts's createMuzzleBubbles header for why this owns its own tiny particle
    // system rather than reaching into world/particles.ts's shared one.
    muzzleBubbles.burst(origin, diver.aimDir);
    return true;
  }

  function setHauling(v: boolean): void { hauling = v; }

  function isActive(): boolean { return !!shot || !!speared; }

  function getFightState(): SpearFightState | null { return speared ? speared.fight : null; }

  function resolveShotMiss(): void {
    shot = null;
    shaftVisual.setVisible(false);
  }

  function endFight(): void {
    speared = null;
    floatLine.setVisible(false);
    fightUI.hide();
  }

  function update(dt: number, t: number, diver: DiverAimInput, sw: number, ch: number): void {
    gun = stepReload(gun, dt);
    muzzleBubbles.update(dt);
    speredVisual.tick(dt, t);
    if (shot) {
      const targets = deps.getTargets();
      // `clientRng` rolls sim/spear.ts's `holdChance` against the impact speed — a shot that
      // geometrically connects at the ragged edge of SPEAR_RANGE (water drag has already bled off
      // most of its speed, see that module's SPEAR_DRAG_K) can still come back `held: false`: the
      // "unreliable rather than binary" edge-of-range behaviour the task brief asks for.
      const { shot: nextShot, hit } = stepSpear(shot, targets, dt, clientRng);
      shot = nextShot;
      if (hit) {
        const target = targets.find((cand) => cand.id === hit.id);
        shaftVisual.setVisible(false);
        shot = null;
        if (target && hit.held) {
          const params = spearFightParamsFor(target.key, target.weight);
          speared = { target, params, fight: startSpearFight(hit.point.x, hit.point.z) };
          floatLine.setVisible(true);
          fightUI.show(fightLabelFor(target.key, target.weight));
          speredVisual.spawnAt(target.key, target.weight, hit.point.x, hit.point.y, hit.point.z);
        } else if (target) {
          // Geometric hit, but too weak to hold (see `holdChance`'s doc comment) — the shaft
          // glances off rather than anchoring. No fight starts; the fish swims on unharmed.
          toast("The shot doesn't have enough force left to hold — it glances off.");
        }
      } else if (!shot.alive) {
        resolveShotMiss();
      } else {
        shaftVisual.update(shot);
      }
    }

    if (speared) {
      // Breath is a second clock on this fight, and the brief wants that interaction deliberate
      // rather than left to fall out by accident: a blackout (airOut or shallow-water, either
      // way — see DiverAimInput.blackedOut's doc comment) ends the fight right here, same as
      // dropping the rod would. Surfacing *without* blacking out is deliberately left alone — the
      // tether only ever reads the diver's x/z (see `env` below), never depth, so ascending with
      // a fish still on the spear (a real, valid way to buy air mid-fight) just works: floatLine's
      // own line-to-the-surface visual already reads correctly regardless of the diver's depth.
      if (diver.blackedOut) {
        toast("Blacked out — the shaft tears free. You lose the fish, and the gear's lucky to float back to you.");
        speredVisual.flee(diver.position.x, diver.position.z);
        endFight();
      } else {
        const next = stepSpearFight(speared.fight, { hauling }, speared.params, { diverX: diver.position.x, diverZ: diver.position.z }, clientRng, dt);
        speared.fight = next;
        floatLine.update({ x: next.x, y: diver.position.y, z: next.z }, t, sw, ch, next.tension);
        speredVisual.setTarget(next.x, diver.position.y - 0.3, next.z, next.tension, next.stam);
        fightUI.update(next, diver.breath);
        if (next.outcome === 'landed') {
          deps.onLanded({ key: speared.target.key, weight: speared.target.weight, x: next.x, z: next.z, zone: zoneAt(next.x, next.z), source: 'spear' });
          // The trophy card (game/catch/underwater-trophy.ts) takes over showing this catch —
          // vanish rather than fade, so there's never a moment with both a line-side fish and a
          // trophy-card fish on screen at once.
          speredVisual.vanish();
          endFight();
        } else if (next.outcome === 'tornFree') {
          toast('The shaft tears free — it got away.');
          speredVisual.flee(diver.position.x, diver.position.z);
          endFight();
        }
      }
    }

    const reloadFrac = Math.min(1, 1 - gun.reloadT / SPEAR_RELOAD);
    gunVM.update(dt, reloadFrac, !!speared, diver.speed ?? 0);
  }

  function reset(): void {
    shot = null;
    shaftVisual.setVisible(false);
    speredVisual.vanish();
    if (speared) endFight();
  }

  function setViewVisible(v: boolean): void { gunVM.group.visible = v; }

  function debugForceReloadReady(): void { gun = createGun(); }

  function dispose(): void {
    gunVM.dispose();
    shaftVisual.dispose();
    floatLine.dispose();
    muzzleBubbles.dispose();
    speredVisual.dispose();
  }

  return { update, tryFire, setHauling, isActive, getFightState, reset, debugForceReloadReady, setViewVisible, dispose };
}
