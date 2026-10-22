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
import { currentAt } from '@keysrun/shared/world/current';
import { mulberry32, type Rng } from '@keysrun/shared/rng';
import {
  createGun, canFire, stepReload, startReload,
  fire, assistAim, stepSpear, spearFightParamsFor, startSpearFight, stepSpearFight,
  SPEAR_RELOAD, drawRateFor, spearRangeFor, SPEAR_RANGE,
  type GunState, type ShotState, type CapsuleTarget, type SpearFightState, type SpearFightParams, type Vec3,
} from '@keysrun/shared/sim/spear';
import { createGunViewModel } from './gun-viewmodel.js';
import { createShaftVisual, createFloatLineVisual, createMuzzleBubbles } from './shaft.js';
import { createSpearFightUI } from './fight-ui.js';
import { createReloadHint } from './reload-hint.js';
import { createSperedFishVisual } from './speared-fish-visual.js';
import { toast } from '../../ui/toast.js';
import { takeShaft, shaftNotice, type GearPort } from '@keysrun/shared/sim/gear';
import { countOf, NO_MODIFIERS } from '@keysrun/shared/sim/shop';
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
  /** The player's inventory (spear.long / spear.reel / spear.shafts). Omitted = the stock gun with
   * unlimited shafts, i.e. exactly the pre-shop behaviour — wiring the real inventory in is
   * passing this one object. */
  gear?: GearPort;
}

export interface Speargun {
  update(dt: number, t: number, diver: DiverAimInput, sw: number, ch: number): void;
  /** Attempts a shot; returns whether it actually fired (gated on reload + breath, same shape as
   * game/fishing's `startCharge`'s speed gate returning early with a toast-worthy reason). */
  tryFire(diver: DiverAimInput): boolean;
  /** Diver is hauling the speared fish in (the spear's equivalent of the rod's `reeling`). */
  setHauling(v: boolean): void;
  /** Player's hand is on the bands (R / touch draw button). Reloading is this, held — the gun
   * never reloads itself (sim/spear.ts `stepReload`). */
  setDrawing(v: boolean): void;
  /** Reload progress for the HUD/tests: `draw` 0..1, `recoverLeft` seconds of brace remaining. */
  getReloadState(): { loaded: boolean; draw: number; recoverLeft: number };
  /** True while a shaft is in flight or a fish is speared — callers can use this the way
   * game/fishing uses `lineOut()`. */
  isActive(): boolean;
  /** Read-only snapshot of the speared-fish fight, or `null` when nothing is on the spear —
   * for a tension/stamina HUD, same role as game/fishing's directly-readable `F` singleton
   * (`F.fight.tension`/`.stam`). */
  getFightState(): SpearFightState | null;
  /** Effective range of the last shot fired (or the gun's current range before any), m. world.ts
   * sizes its near-miss spook ray from this so a stock gun does not spook fish at 24 m. */
  lastShotRangeM(): number;
  /** Bought shafts left, or null when no inventory is wired (unlimited). For a HUD pill. */
  shaftsLeft(): number | null;
  /** Target the last shot's aim assist locked onto, or null. */
  assistTargetId(): string | number | null;
  /** Target aim assist would lock onto right now — the live reticle feed, no side effects. */
  aimTargetId(diver: DiverAimInput): string | number | null;
  /** Unconditional cleanup for a mode exit (diver climbing back aboard) — mirrors
   * game/fishing/index.ts's `reelIn()` being called the moment the diver jumps in, the other
   * direction: hides every visual and drops any in-flight shot/speared fish without resolving it
   * through `landed`/`tornFree`. Safe to call when nothing is active. */
  reset(): void;
  /** VERIFICATION-ONLY: loads the gun instantly. Real play never needs this (the 4.6 s+ hauled
   * reload is the point) — it exists because this sandbox's fixed-dt accumulator clamps to 0.05 s of
   * simulated time per *rendered* frame (game/world.ts's `frame()`), and this sandbox's measured
   * ~2-4 fps means simulated time crawls at roughly a fifth to a tenth of real wall-clock time —
   * a Playwright script's `waitForTimeout(3000)` was observed not being enough real time for a
   * reload to actually clear. Bypassing it here is simpler and more honest than
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
const tmpEye = new THREE.Vector3();

export function createSpeargun(deps: SpeargunDeps): Speargun {
  const gunVM = createGunViewModel(deps.camera);
  const shaftVisual = createShaftVisual(deps.scene);
  const floatLine = createFloatLineVisual(deps.scene);
  const muzzleBubbles = createMuzzleBubbles(deps.scene);
  const speredVisual = createSperedFishVisual(deps.scene);
  const fightUI = createSpearFightUI();
  const reloadHint = createReloadHint();

  let gun: GunState = createGun();
  let shot: ShotState | null = null;
  let speared: Speared | null = null;
  let hauling = false;
  let drawing = false;
  /**
   * R is a LATCH, not a hold. Hauling the bands back is still a real act in the sim — it takes
   * time, kicking costs leverage, and a half-drawn gun slips back a notch — but the player should
   * not have to keep a key pressed through it. One press starts the haul and it runs to seated
   * (or until something takes the hands away: a shot, a fish on, a blackout, holstering).
   * Pressing again mid-haul lets go, which is the only way back to the old behaviour and is also
   * what you want if you would rather swim.
   */
  let drawLatched = false;

  /** Target id the most recent shot's assist locked onto — see `assistTargetId`. */
  let lastAssist: string | number | null = null;
  /** Last simulated time seen by `update`, for `GearPort.mods(nowS)` (the spear's gear is
   * permanent so the value never matters, but the port wants one). */
  let simNow = 0;
  let lastRange = SPEAR_RANGE;

  /** Range the NEXT shot would have — long gun bonus, and the spare shaft's cut if none are left.
   * Shared by the assist (so the lead is solved for the shaft that will fly) and `tryFire`. */
  function nextRange(): number {
    const g = deps.gear;
    if (!g) return SPEAR_RANGE;
    return spearRangeFor(g.mods(simNow).spearRangeM, countOf(g.inventory(), 'spear.shafts') <= 0);
  }

  function tryFire(diver: DiverAimInput): boolean {
    if (shot || speared) return false; // one shaft out at a time — see this module's header
    if (!canFire(gun)) { reloadHint.nudge(); return false; }
    if (diver.breath <= 0 || diver.blackedOut) return false;
    // The shot's visual origin is the view model's actual muzzle, not the diver's body position
    // (`diver.position` is still what the fight env below ties the tether to) — same convention
    // as game/fishing/update.ts's `cast()` reading `rodVM.tip`'s world position for `F.from`
    // rather than the boat's own origin.
    gunVM.muzzle.getWorldPosition(tmpMuzzle);
    const origin = { x: tmpMuzzle.x, y: tmpMuzzle.y, z: tmpMuzzle.z };
    // Aim assist (@keysrun/shared/sim/spear's `assistAim`) — nudges the shot toward the best
    // target in a ~7 deg cone and, more importantly, *leads* it by the shaft's real time of
    // flight. A shot at 8 m is in the water over half a second against a decelerating shaft, so
    // aiming straight at a swimming fish is a clean miss behind it, and nothing underwater tells
    // you that. Deliberately inside docs/ARCHITECTURE.md's 0.22 rad server aim-plausibility
    // window, so an assisted shot can never trip the anti-aimbot envelope.
    // `eye` = the camera, i.e. where the crosshair is measured from; `origin` = the muzzle, where
    // the shaft physically leaves. Passing both lets assist lock on what the player is actually
    // pointing at and still fire a shaft that converges on it — see assistAim's `eye` doc.
    deps.camera.getWorldPosition(tmpEye);
    // Spend the shaft FIRST (spending is an event, and this is where the shot happens) so the
    // range the assist solves for is the one of the shaft that actually flies: a spare is 60%
    // range and a lead computed for 24 m would be wrong for it.
    let range = SPEAR_RANGE;
    if (deps.gear) {
      const taken = takeShaft(deps.gear.inventory());
      deps.gear.commit(taken.inventory);
      range = spearRangeFor(deps.gear.mods(simNow).spearRangeM, taken.spare);
      const note = shaftNotice(taken.left, taken.spare);
      if (note) toast(note);
    }
    lastRange = range;
    const assist = assistAim(origin, diver.aimDir, deps.getTargets(), { range, eye: { x: tmpEye.x, y: tmpEye.y, z: tmpEye.z } });
    lastAssist = assist.targetId;
    shot = fire(origin, { x: assist.dx, y: assist.dy, z: assist.dz }, range);
    gun = startReload(SPEAR_RELOAD);
    shaftVisual.setVisible(true);
    shaftVisual.update(shot);
    gunVM.kick();
    // A loaded band snapping forward through water visibly exhausts a puff of air out the
    // muzzle — see shaft.ts's createMuzzleBubbles header for why this owns its own tiny particle
    // system rather than reaching into world/particles.ts's shared one.
    muzzleBubbles.burst(origin, { x: assist.dx, y: assist.dy, z: assist.dz });
    return true;
  }

  function setHauling(v: boolean): void { hauling = v; }
  /** `v` is the key/button going DOWN. The release is ignored — see `drawLatched`. */
  function setDrawing(v: boolean): void {
    if (!v) return;
    drawLatched = !drawLatched;
    drawing = drawLatched;
  }
  function getReloadState(): { loaded: boolean; draw: number; recoverLeft: number } {
    return { loaded: canFire(gun), draw: gun.draw, recoverLeft: gun.reloadT };
  }

  /** The target the last shot's aim assist locked onto, or null. Exposed so a reticle can show a
   * lock — an assist the player cannot see reads as the gun being inaccurate rather than helpful. */
  function assistTargetId(): string | number | null { return lastAssist; }

  /** The target aim assist *would* lock onto right now, without firing — the live reticle feed.
   * Runs the identical `assistAim` so what the reticle promises and what the shot does can never
   * disagree; `strength: 0` means it only reports, never moves anything. */
  function aimTargetId(diver: DiverAimInput): string | number | null {
    gunVM.muzzle.getWorldPosition(tmpMuzzle);
    deps.camera.getWorldPosition(tmpEye);
    return assistAim({ x: tmpMuzzle.x, y: tmpMuzzle.y, z: tmpMuzzle.z }, diver.aimDir, deps.getTargets(),
      { strength: 0, range: nextRange(), eye: { x: tmpEye.x, y: tmpEye.y, z: tmpEye.z } }).targetId;
  }

  function lastShotRangeM(): number { return lastRange; }
  function shaftsLeft(): number | null { return deps.gear ? countOf(deps.gear.inventory(), 'spear.shafts') : null; }

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
    // The bands can only be worked with the shaft out of the gun and nothing on the line: a fish
    // being hauled has both hands on the reel line. That is also what makes a fight cost you the
    // follow-up shot, which is the point of a one-shot gun.
    simNow = t;
    const handsFree = !shot && !speared && !diver.blackedOut;
    const water = currentAt(diver.position.x, diver.position.z, t, Math.max(0, -diver.position.y));
    // Leverage is lost by KICKING, not by being carried: a diver drifting with the current is
    // stationary relative to the water. `diver.speed` is over-the-ground, so take off the drift
    // the water gives a diver who is not kicking (CURRENT_COUPLING of the flow, sim/diver.ts; the
    // near-floor boundary layer can make the true drift smaller, never larger, so this only ever
    // under-subtracts) — otherwise sitting in a 0.9 m/s stream would slow every reload.
    const kickSpeed = Math.max(0, (diver.speed ?? 0) - 0.75 * water.speed);
    // The latch drops itself: when the gun is seated there is nothing left to haul, and when the
    // hands are busy (a shot in flight, a fish on, blacked out) the haul was going to be ignored
    // anyway — leaving the latch set would silently resume it later.
    if (drawLatched && (canFire(gun) || !handsFree)) { drawLatched = false; drawing = false; }
    const hand = { drawing: drawing && handsFree, speed: kickSpeed };
    // Gear-scaled draw: the band gun and the reel conversion make the hauled phase quicker
    // (sim/shop.ts's `spearReloadMul`). No gear = 1 = exactly the stock reload.
    gun = stepReload(gun, dt, hand, deps.gear?.mods(t).spearReloadMul ?? 1);
    muzzleBubbles.update(dt, water.vx, water.vz);
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
          const params = spearFightParamsFor(target.key, target.weight, (deps.gear?.mods(simNow) ?? NO_MODIFIERS).spearTetherMul);
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

    const loaded = canFire(gun);
    const reloadView = {
      loaded,
      recover: gun.reloadT > 0 ? Math.min(1, 1 - gun.reloadT / SPEAR_RELOAD) : 1,
      draw: gun.draw,
      drawing: hand.drawing && !loaded && gun.reloadT <= 0,
      // How hard the diver is fighting the rubbers right now: 1 hanging still, lower while kicking.
      effort: drawRateFor(kickSpeed),
    };
    gunVM.update(dt, reloadView, !!speared, diver.speed ?? 0);
    reloadHint.update(reloadView, gun.reloadT, !!speared || !!shot || !!diver.blackedOut);
  }

  function reset(): void {
    shot = null;
    drawing = false; drawLatched = false;
    reloadHint.hide();
    shaftVisual.setVisible(false);
    speredVisual.vanish();
    if (speared) endFight();
  }

  function setViewVisible(v: boolean): void {
    gunVM.group.visible = v;
    if (!v) { drawing = false; drawLatched = false; reloadHint.hide(); }
  }

  function debugForceReloadReady(): void { gun = createGun(); }

  function dispose(): void {
    gunVM.dispose();
    shaftVisual.dispose();
    floatLine.dispose();
    muzzleBubbles.dispose();
    speredVisual.dispose();
    reloadHint.dispose();
  }

  return { update, tryFire, setHauling, setDrawing, getReloadState, isActive, getFightState, assistTargetId, aimTargetId, lastShotRangeM, shaftsLeft, reset, debugForceReloadReady, setViewVisible, dispose };
}
