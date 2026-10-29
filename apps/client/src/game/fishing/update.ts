/**
 * The rod-fishing state machine: `startCharge`→`releaseCast`→`cast`→`waiting`→`nibble`→`bite`→
 * `setHook`→`fight`→`land`, and `updateFishing` (legacy index.html:2636-2811). The `fight` phase
 * itself is `@keysrun/shared/sim/fight`'s `stepFight` (see that module's header) — everything
 * else here is unchanged minigame pacing/presentation logic.
 */
import * as THREE from 'three';
import type { BoatModel } from '../../entities/boat/model.js';
import type { BoatState, BoatInput } from '@keysrun/shared/sim/boat';
import type { ParticleSystem } from '../../world/particles.js';
import type { CamState, FpState } from '../../entities/camera.js';
import { sampleWaterHeight } from '../../entities/boat/visuals.js';
import { landH, zoneAt, nearHump } from '@keysrun/shared/world/depth';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { chooseFish, fightParamsFor, scaledLenM, startFight, stepFight, type FightState, tensionFrac, warnFrac, HOOK_TEAR, SLACK_TENSION } from '@keysrun/shared/sim/fight';
import { xoshiro128ss } from '@keysrun/shared/rng';
import { SPECIES } from '@keysrun/shared/content/species';
import type { Tackle } from '@keysrun/shared/content/tackle';
import { rigCast, rigLeader, type CastRig, type GearPort } from '@keysrun/shared/sim/gear';
import type { TaggedFish } from '@keysrun/shared/sim/tagging';
import { clamp, lerp, rand } from '../../core/math.js';
import { toast } from '../../ui/toast.js';
import { F } from './state.js';
import type { FishingVisuals } from './visuals.js';
import type { RodViewModel } from './rod-viewmodel.js';
import { strikeWindowS, STRIKE_BASE_S, type HandInputs } from '@keysrun/shared/sim/steady';
import { resolveCastSpot, type SpotQuery } from './spot.js';
import type { ShoreAngler } from './shore.js';

function $(id: string): HTMLElement | null { return document.getElementById(id); }

export interface LandedFish {
  key: string;
  weight: number;
  fx: number;
  fz: number;
  zone: string;
  /** Non-null when this was a tagged fish being recaptured. */
  tag: TaggedFish | null;
  /** Where the angler stood, when landed from a pier or a dock (shore.ts); null over the boat's gunwale. */
  ashore: { x: number; z: number } | null;
}

export interface FishingDeps {
  /** Fired the instant a fish is ON — the hookset, whether from the strike window or a trolling
   * strike. game/world.ts turns it into the fish cam (game/fishing/fish-cam.ts). */
  onHookset?(x: number, z: number): void;
  scene: THREE.Scene;
  getModel(): BoatModel;
  camera: THREE.Camera;
  fp: FpState;
  camState: CamState;
  visuals: FishingVisuals;
  rodVM: RodViewModel;
  particles: ParticleSystem;
  boatInput: BoatInput;
  /** Bird/bait frenzies, weedlines and rigs — `entities/life`'s `HotspotWorld`. */
  spots: SpotQuery;
  onLanded(fish: LandedFish): void;
  /** The equipped rod-and-line outfit (shared/content/tackle). Omitted = the starter 30 lb; this is
   * the seam a tackle shop plugs into — see content/tackle.ts. */
  getTackle?(): Tackle;
  /** Steadiness and sway from the food/drink buffs (game/buffs.ts). Omitted = unbuffed. */
  getModifiers?(): HandInputs;
  /** The player's inventory (rod.*, reel.lever, bait, leader). Omitted = stock rod, no bait —
   * exactly the pre-shop behaviour; wiring the real inventory in is passing this one object. */
  gear?: GearPort;
  /** The angler standing on a pier or a dock, or null aboard (shore.ts). Omitted = always aboard.
   * Ashore the line hangs from the rod in the walker's hands instead of the boat's, and the cast
   * goes where the land camera looks. */
  getShore?(): ShoreAngler | null;
  /** legacy's `case 'caught': if (now-caughtT>1600) releaseFish();` — delegated to game/catch. */
  onActionWhileCaught(): void;
  /** Tag-and-release registry (game/catch/tags.ts). Omitted = every fish is untagged. */
  tags?: {
    prefetch(x: number, z: number): void;
    pickRecapture(key: string, x: number, z: number, rng: () => number): TaggedFish | null;
  };
}

/** This port's client-local roll stream for immediate feedback — see sim/fight.ts's header.
 * Never the authority; a later phase's server roll supersedes this entirely. */
const clientRng = xoshiro128ss((Date.now() ^ 0x9e3779b9) >>> 0);

const tmpDir = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();

export function createFishingLogic(deps: FishingDeps) {
  const { visuals } = deps;
  /** legacy `input.action` — held true while Space is down. Set directly by game/fishing/input.ts
   * (on keydown/keyup); `onAction`/`onActionUp` are edge-triggered calls from that same module. */
  const actionInput = { held: false };

  /** Bait on the line for the current cast; null = bare hook. Spent in `cast` completion (below),
   * where the bobber lands and the zone is known, because the right bait depends on the water. */
  let rig: CastRig | null = null;
  let simNow = 0;

  /** The rod the line is tied to when the view is not first-person: the boat's, or the one in the
   * walker's hands ashore. */
  function rodHolder(shore: ShoreAngler | null): { rodPivot: THREE.Group } { return shore ? shore.rod : deps.getModel(); }
  /** First-person rod in view: the boat's fishing view (`fp.on`), or the land camera's first person. */
  function fpOn(shore: ShoreAngler | null): boolean { return shore ? shore.firstPerson : deps.fp.on; }

  function setRod(v: boolean): void {
    const shore = deps.getShore?.() ?? null;
    deps.getModel().rodPivot.visible = v && !shore;
    if (shore) shore.rod.rodPivot.visible = v;
  }

  function startCharge(boat: BoatState): void {
    if (Math.abs(boat.speed) > 1.6) { toast('Slow under 3 knots to cast.'); return; }
    F.charging = true; F.charge = 0; F.chargeT = 0;
    setRod(true);
    $('castbar')?.classList.remove('hidden');
  }

  function releaseCast(boat: BoatState): void {
    if (!F.charging) return;
    F.charging = false;
    $('castbar')?.classList.add('hidden');
    cast(F.charge, boat);
  }

  function cast(power: number, boat: BoatState): void {
    const shore = deps.getShore?.() ?? null;
    // Ashore the boat's fishing view is not running (`fp.yaw` is stale): cast where the land
    // camera looks, which in first person is where you are looking and in third is over your head.
    if (deps.fp.on && !shore) {
      tmpDir.set(-Math.sin(deps.fp.yaw), 0, -Math.cos(deps.fp.yaw));
    } else {
      deps.camera.getWorldDirection(tmpDir);
      tmpDir.y = 0; tmpDir.normalize();
    }
    let dist = 12 + power * 73;
    for (let k = 0; k < 8 && landH(boat.x + tmpDir.x * dist, boat.z + tmpDir.z * dist) > -0.4; k++) dist *= 0.8;
    // A boat is always on the water, so the shortened cast always lands in some. Standing at the
    // root of a pier facing the beach it need not: refuse rather than float a bobber on the sand.
    if (shore && landH(boat.x + tmpDir.x * dist, boat.z + tmpDir.z * dist) > -0.4) {
      setRod(false);
      toast('Face the water to cast.');
      return;
    }
    F.to = { x: boat.x + tmpDir.x * dist, y: 0, z: boat.z + tmpDir.z * dist };
    deps.rodVM.lineTip(rodHolder(shore), fpOn(shore)).getWorldPosition(tmpTarget);
    F.from = { x: tmpTarget.x, y: tmpTarget.y, z: tmpTarget.z };
    F.castT = 0; F.castDur = 0.5 + power * 0.9; F.castH = 3 + power * 14;
    F.state = 'casting'; F.key = null; F.tag = null;
    deps.tags?.prefetch(F.to.x, F.to.z);
    setRod(true);
    visuals.bobber.visible = true;
    deps.rodVM.whip();
  }

  function reelIn(msg?: string): void {
    visuals.hideHooked();
    F.state = 'idle'; F.key = null; F.tag = null; F.charging = false;
    $('castbar')?.classList.add('hidden');
    setRod(false);
    visuals.bobber.visible = false;
    visuals.fishLine.visible = false;
    $('fight')?.classList.add('hidden');
    $('strike')?.classList.add('hidden');
    F.fight = null; F.fightParams = null;
    rig = null;
    if (msg) toast(msg);
  }

  /** legacy `chooseFish()` (index.html:2655-2660) — shows the hooked-fish mesh as soon as a
   * species/weight is rolled, same as legacy (the fish is visible swimming near the bobber
   * before the strike). */
  function chooseFishLocal(): void {
    const hump = nearHump(F.bob.x, F.bob.z);
    const fish = chooseFish(F.zone, F.bob, { hotspot: !!F.hs, hump, rareMul: rig?.rareMul }, clientRng);
    F.key = fish.key; F.sp = SPECIES[fish.key]; F.weight = fish.weight;
    // A tagged fish in range may be this one — then it fights at its own grown weight.
    F.tag = deps.tags?.pickRecapture(fish.key, F.bob.x, F.bob.z, clientRng) ?? null;
    if (F.tag) F.weight = +F.tag.weightLb.toFixed(1);
    F.fx = fish.x; F.fz = fish.z; F.ofx = fish.ofx; F.ofz = fish.ofz;
    visuals.showHooked(F.sp.color, scaledLenM(fish.key, F.weight));
  }

  function missFish(msg: string): void {
    $('strike')?.classList.add('hidden');
    visuals.hideHooked();
    F.key = null; F.tag = null; F.state = 'waiting';
    F.biteT = rand(4, 8) * (F.hs ? 0.5 : 1) * (rig?.biteMul ?? 1); // the bait is still on the hook
    toast(msg);
  }

  function setHook(): void {
    $('strike')?.classList.add('hidden');
    if (!F.key) chooseFishLocal();
    // A trolling hookup arrives with its fish already rolled — game/fishing/trolling.ts sets
    // F.key, F.weight and the lure position before calling this — so `chooseFishLocal`, which is
    // the only thing that ever reveals the hooked-fish mesh, never ran. The fish ate the lure,
    // fought the whole way to the boat and was landed without ever being drawn: a trolling strike
    // was a splash, a toast and an invisible fight. Reveal it either way.
    else if (F.sp) visuals.showHooked(F.sp.color, scaledLenM(F.key, F.weight));
    const key = F.key!, S = F.sp!;
    // Rod / reel gear is permanent (Modifiers.lineMul / reelMul); the fluoro leader is a
    // consumable and is spent here, on the hookup it protects, not on the cast.
    let gear: { lineMul: number; reelMul: number; fluoro: boolean } | undefined;
    if (deps.gear) {
      const m = deps.gear.mods(simNow);
      const leader = rigLeader(deps.gear.inventory());
      if (leader.fluoro) { deps.gear.commit(leader.inventory); toast('Fluorocarbon leader rigged.'); }
      gear = { lineMul: m.lineMul, reelMul: m.reelMul, fluoro: leader.fluoro };
    }
    const params = fightParamsFor(key, F.weight, F.drag, deps.getTackle?.(), gear);
    F.fightParams = params;
    F.fight = startFight(params, F.fx, F.fz, clientRng);
    const sizeT = (F.weight - S.min) / (S.max - S.min);
    F.state = 'fight';
    visuals.bobber.visible = false;
    $('fight')?.classList.remove('hidden');
    setText('fLabel', sizeT > 0.7 ? 'Something heavy is on' : sizeT > 0.35 ? 'Solid fish on' : 'Fish on');
    setText('fSub', 'It’s running! Hold ▼ to reel, ease off when the bar runs red.');
    deps.particles.splash(F.fx, F.fz, 30, 1.5);
    deps.camState.shake = Math.max(deps.camState.shake, 0.3);
    deps.onHookset?.(F.fx, F.fz);
  }

  function lose(msg: string): void { reelIn(msg); }

  /**
   * Returns the rod to `idle` once the catch card has been dismissed (kept or released).
   *
   * Nothing used to do this. `land()` parks the state machine in `'caught'`, and the only thing
   * that ever sets `'idle'` is `reelIn()` — which every caller explicitly guards off while caught
   * (`F.state !== 'idle' && F.state !== 'caught'`, world.ts). So after keeping or releasing a
   * fish the rod stayed in `'caught'` forever: `onAction` fell through to the `'caught'` branch,
   * called `onActionWhileCaught` -> `releaseFish()`, which bailed immediately because `current`
   * was already null. Casting again was impossible without reloading.
   *
   * Deliberately NOT `reelIn()`: that also kicks `camState.shake`, which would jolt the camera
   * every time a card closes. This only undoes what `land()` did.
   */
  function clearCaught(): void {
    if (F.state !== 'caught') return; // spear catches never enter this state machine — no-op
    F.state = 'idle';
    F.key = null; F.tag = null;
    F.charging = false;
    rig = null;
    F.caughtT = 0;
    $('castbar')?.classList.add('hidden');
    setRod(false);
    visuals.bobber.visible = false;
    visuals.fishLine.visible = false;
  }

  function land(): void {
    const key = F.key!, weight = F.weight, fx = F.fx, fz = F.fz, zone = F.zone, tag = F.tag, shore = deps.getShore?.(), ashore = shore ? { x: shore.spot.x, z: shore.spot.z } : null;
    F.tag = null;
    F.state = 'caught';
    F.caughtT = performance.now();
    visuals.hideHooked();
    setRod(false);
    $('fight')?.classList.add('hidden');
    F.fight = null; F.fightParams = null;
    deps.onLanded({ key, weight, fx, fz, zone, tag, ashore });
  }

  function onAction(boat: BoatState): void {
    switch (F.state) {
      case 'idle': startCharge(boat); break;
      case 'nibble': missFish('Too early! You pulled the bait away from the fish.'); break;
      case 'bite': setHook(); break;
      case 'caught': if (performance.now() - (F.caughtT || 0) > 1600) deps.onActionWhileCaught(); break;
      case 'waiting': toast('Wait for the float to go under, then strike. Hold ▼ to retrieve, R to reel in.'); break;
      default: break;
    }
  }

  function onActionUp(boat: BoatState): void {
    if (F.charging) releaseCast(boat);
  }

  function setDrag(v: number): void {
    F.drag = clamp(v, 1, 5);
    renderDrag();
    toast(F.drag >= 4 ? `Drag tightened (${F.drag}/5) — more pressure, more risk of a break-off.` : F.drag <= 2 ? `Drag loosened (${F.drag}/5) — the fish can take line easier.` : `Drag set to ${F.drag}/5.`);
  }

  function renderDrag(): void {
    const el = $('fDrag');
    if (el) el.innerHTML = [1, 2, 3, 4, 5].map((i) => `<i class="${i <= F.drag ? 'on' : ''}"></i>`).join('');
  }

  function update(dt: number, t: number, boat: BoatState, sw: number, ch: number): void {
    simNow = t;

    if (F.charging) {
      F.chargeT += dt;
      F.charge = Math.min(1, F.chargeT / 1.3);
      const fill = $('castFill'); if (fill) fill.style.width = F.charge * 100 + '%';
      setText('castDist', Math.round(12 + F.charge * 73) + ' m');
    }
    if (F.state === 'idle') return;

    const reel = deps.boatInput.back || (actionInput.held && F.state === 'fight');
    F.reeling = reel;
    // Ashore the rod in the walker's hands is aimed per frame instead (shore-rod.ts, from
    // index.ts's render), because it rides on a body the land facade re-poses every frame.
    if (!deps.getShore?.()) {
      const aimTarget = F.state === 'fight' ? tmpTarget.set(F.fx, 0, F.fz) : tmpTarget.set(F.bob.x, 0, F.bob.z);
      visuals.aimRod(deps.getModel(), aimTarget, F.state === 'fight', F.fight ? F.fight.tension : 0);
    }

    if (F.state === 'casting') {
      F.castT += dt / F.castDur;
      const p = Math.min(1, F.castT);
      F.bob = {
        x: lerp(F.from.x, F.to.x, p),
        y: lerp(F.from.y, 0, p) + F.castH * 4 * p * (1 - p),
        z: lerp(F.from.z, F.to.z, p),
      };
      if (p >= 1) {
        F.state = 'waiting';
        deps.particles.splash(F.bob.x, F.bob.z, 8, 0.6);
        const spot = resolveCastSpot(deps.spots, F.bob.x, F.bob.z, zoneAt(F.bob.x, F.bob.z));
        F.zone = spot.zone; F.hs = spot.hs;
        // biteT is untouched by the spot: the `* 0.4` is the whole frenzy bite-speed payoff and
        // the only knob, so it stays in one place.
        // Bait is spent HERE: the cast has landed and `F.zone` is known, which decides shrimp vs
        // ballyhoo (sim/gear.ts rigCast). biteMul multiplies the wait, so it composes with the
        // frenzy's 0.4 instead of replacing it.
        rig = null;
        if (deps.gear) {
          rig = rigCast(deps.gear.inventory(), F.zone, deps.gear.mods(simNow));
          deps.gear.commit(rig.inventory);
          if (rig.bait) toast(rig.bait === 'shrimp' ? 'Live shrimp on the hook.' : 'Rigged ballyhoo on the hook.');
        }
        F.biteT = rand(4, 10) * (F.hs ? 0.4 : 1) * (rig?.biteMul ?? 1);
        F.key = null; F.tag = null;
        const cm = Math.round(Math.hypot(F.bob.x - boat.x, F.bob.z - boat.z)) + ' m cast ';
        toast(spot.kind === 'frenzy' ? cm + 'into the bait — fish on the surface!' : spot.kind === 'wreck' ? cm + 'onto the ' + (spot.wreckName ?? 'wreck').toLowerCase() + ' — big fish hold on the steel.' : cm + 'into the ' + F.zone.toLowerCase() + '.');
      }
    } else if (F.state === 'waiting' || F.state === 'nibble' || F.state === 'bite') {
      const surf = sampleWaterHeight(boat, F.bob.x, F.bob.z, t, ampAt(F.bob.x, F.bob.z), sw, ch);
      const bd = Math.hypot(F.bob.x - boat.x, F.bob.z - boat.z) || 1;
      if (bd > 140) { reelIn('Drifted too far — line reeled in.'); return; }
      if (Math.abs(boat.speed) > 3.2) { reelIn('Line reeled in so you can run.'); return; }
      if (reel && F.state === 'waiting') {
        F.bob.x += (boat.x - F.bob.x) / bd * 3.5 * dt;
        F.bob.z += (boat.z - F.bob.z) / bd * 3.5 * dt;
        if (bd < 6) { reelIn('Line in.'); return; }
      }
      let dip = Math.sin(t * 2) * 0.05;
      if (F.state === 'waiting') {
        F.biteT -= dt * (reel ? 0.6 : 1);
        if (!F.key && F.biteT < 3.2) chooseFishLocal();
        if (F.biteT <= 0) { F.state = 'nibble'; F.nibs = 1 + Math.floor(clientRng() * 3); F.nibT = 0.05; }
      } else if (F.state === 'nibble') {
        F.nibT -= dt;
        if (F.nibT <= 0) {
          if (F.nibs <= 0) {
            F.state = 'bite';
            // The strike window is where steady hands pay off: coffee 1.4 -> 1.75 s, a six-pack
            // 1.4 -> ~1.0 s (sim/steady.ts has the numbers and why).
            F.win = strikeWindowS(STRIKE_BASE_S, deps.getModifiers?.() ?? { steadyMul: 1, sway: 0 });
            $('strike')?.classList.remove('hidden');
            deps.particles.splash(F.bob.x, F.bob.z, 20, 1.2);
            deps.camState.shake = Math.max(deps.camState.shake, 0.15);
          } else {
            F.nibs--; F.dipT = 0.28;
            deps.particles.spawnP(F.bob.x, 0.1, F.bob.z, 0, 0, 0, 1, 0.9, 0.6, false, 0.2);
            F.nibT = rand(0.8, 1.6);
          }
        }
      } else {
        F.win -= dt;
        if (F.win <= 0) { missFish('Missed it — the fish dropped the bait.'); return; }
      }
      if (F.dipT > 0) { F.dipT -= dt; dip = -0.16 * Math.sin(clamp(1 - F.dipT / 0.28, 0, 1) * Math.PI); }
      if (F.state === 'bite') dip = -0.6 + Math.sin(t * 30) * 0.1;
      F.bob.y = surf + dip;
      if (F.key) {
        let tx = F.bob.x + F.ofx, tz = F.bob.z + F.ofz, k = dt * 0.9;
        if (F.state === 'nibble') { tx = F.bob.x + F.ofx * 0.3; tz = F.bob.z + F.ofz * 0.3; k = dt * 2.5; }
        if (F.state === 'bite') {
          const ax = F.bob.x - boat.x, az = F.bob.z - boat.z, al = Math.hypot(ax, az) || 1;
          F.bob.x += ax / al * 2 * dt; F.bob.z += az / al * 2 * dt;
          tx = F.bob.x; tz = F.bob.z; k = dt * 5;
        }
        F.fx += (tx - F.fx) * Math.min(1, k);
        F.fz += (tz - F.fz) * Math.min(1, k);
      }
    } else if (F.state === 'fight' && F.fight && F.fightParams) {
      const next: FightState = stepFight(F.fight, { reeling: reel, drag: F.drag }, F.fightParams, { boatX: boat.x, boatZ: boat.z }, clientRng, dt);
      F.fight = next;
      F.fx = next.x; F.fz = next.z;
      for (const ev of next.events) {
        if (ev.type === 'splash') deps.particles.splash(ev.x, ev.z, ev.big ? 20 : 6, ev.big ? 1.3 : 0.6);
        else if (ev.type === 'startJump') {
          setText('fLabel', ev.low ? 'It’s tail-walking!' : 'It jumped!');
          setText('fSub', 'Bow to the fish — ease off the reel while it’s airborne.');
          deps.camState.shake = Math.max(deps.camState.shake, ev.low ? 0.1 : 0.18);
        } else if (ev.type === 'sounding') {
          toast('It’s sounding — diving for the bottom!');
        } else if (ev.type === 'shock') {
          deps.rodVM.kick(ev.mag);
        }
      }
      visuals.updateHooked(t, dt, next.running, next.shake, next.deep, next.airborne);

      const fT = $('fT');
      if (fT) {
        // The bar reads LOAD AGAINST WHAT THE LINE WILL TAKE, not raw tension — see
        // sim/fight.ts's `tensionFrac` for why the old absolute scale could not run red on most
        // of the fish in the game. Full bar means the line is going now.
        const frac = tensionFrac(next.tension, next.limit);
        fT.style.width = clamp(frac, 0, 1) * 100 + '%';
        /*
         * Coloured against the two things that ACTUALLY lose you the fish, not against a
         * fraction of the bar. Hot is `HOOK_TEAR` — the tension above which the hook starts
         * prising out — and slack is `SLACK_TENSION`, below which a jump throws it. Both are
         * the same constants stepFight wears the hook with, so the warning and the damage
         * cannot disagree; the old fixed 0.68-of-limit mark was a different quantity and sat
         * green through the whole band where a grouper or a blackfin tears off.
         *
         * `over` is still its own state: past the limit is the one moment that needs acting on
         * this second.
         */
        fT.className = next.tension >= next.limit ? 'over'
          : next.tension > HOOK_TEAR ? 'hot'
          : next.tension < SLACK_TENSION ? 'slack' : '';
        /*
         * Paint the track's bands where those failures are for THIS leader. They move: the bar
         * is tension over `limit` and the hook tears at a fixed tension, so as the leader chafes
         * the warning mark slides right and the gap between "tearing the hook" and "parting the
         * line" visibly closes.
         *
         * Setting it every frame also ends a cross-contamination bug — the spear fight writes
         * these same custom properties on this same shared element (entities/speargun/
         * fight-ui.ts) and never cleared them, so after one speared fish every rod fight drew
         * its red band at the spear's 82% while the fill still changed colour somewhere else.
         */
        const tr = fT.parentElement;
        if (tr) {
          tr.style.setProperty('--warn', warnFrac(next.limit) * 100 + '%');
          tr.style.setProperty('--snap', '100%');
        }
      }
      /*
       * Whether cranking is doing anything.
       *
       * This is the decision the whole fight turns on and the HUD never showed it. Reeling while
       * the fish is RUNNING recovers line at a quarter rate and piles `horse` onto the tension —
       * you are burning the leader for almost nothing. Reeling when it is not running recovers
       * at full rate for far less load. "Pulse the reel" is exactly that, and the player had no
       * way to see which half of the cycle they were in except by watching a number change.
       *
       * So the line readout now says which way it is going and the bar says whether to crank.
       */
      setText('fLine', Math.round(next.dist) + ' m' + (next.running ? '  ▲' : reel ? '  ▼' : ''));
      const label = $('fLabel'), sub = $('fSub');
      if (label && sub && !next.airborne) {
        if (next.running) {
          label.textContent = 'It\u2019s running — let it go';
          sub.textContent = 'Cranking now costs line and loads the leader. Wait for it to stop.';
        } else {
          label.textContent = reel ? 'Gaining line' : 'It has stopped — reel!';
          sub.textContent = 'Pulse the reel. Back off when the bar runs red.';
        }
      }
      const track = fT?.parentElement;
      if (track) track.classList.toggle('hold', next.running);
      const fStam = $('fStam'); if (fStam) fStam.style.width = next.stam * 100 + '%';

      if (next.outcome === 'landed') { land(); return; }
      // The load vanishes the instant a fight ends badly: whip the rod back before reelIn hides it.
      if (next.outcome !== 'fighting') deps.rodVM.recoil(next.tension);
      if (next.outcome === 'snapped') { lose('Snap! Too much pressure and the line parted.'); return; }
      if (next.outcome === 'frayed') { lose('The leader chafed through — too long on the line.'); return; }
      if (next.outcome === 'pulled') { lose('The hook pulled free.'); return; }
      if (next.outcome === 'slack') { lose('Slack line — the fish shook the hook.'); return; }
      if (next.outcome === 'spooled') { lose('Spooled! Chase the big ones with the boat next time.'); return; }
      if (next.outcome === 'mangrove') { lose('Cut off in the mangroves.'); return; }
    }
  }

  renderDrag();

  return {
    startCharge, releaseCast, cast, reelIn, clearCaught, setHook, setDrag,
    onAction, onActionUp, update, actionInput,
  };
}

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}
