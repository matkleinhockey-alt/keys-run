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
import { chooseFish, fightParamsFor, scaledLenM, startFight, stepFight, type FightState } from '@keysrun/shared/sim/fight';
import { xoshiro128ss } from '@keysrun/shared/rng';
import { SPECIES } from '@keysrun/shared/content/species';
import { clamp, lerp, rand } from '../../core/math.js';
import { toast } from '../../ui/toast.js';
import { F } from './state.js';
import type { FishingVisuals } from './visuals.js';
import type { RodViewModel } from './rod-viewmodel.js';

function $(id: string): HTMLElement | null { return document.getElementById(id); }

export interface LandedFish {
  key: string;
  weight: number;
  fx: number;
  fz: number;
  zone: string;
}

export interface FishingDeps {
  scene: THREE.Scene;
  getModel(): BoatModel;
  camera: THREE.Camera;
  fp: FpState;
  camState: CamState;
  visuals: FishingVisuals;
  rodVM: RodViewModel;
  particles: ParticleSystem;
  boatInput: BoatInput;
  onLanded(fish: LandedFish): void;
  /** legacy's `case 'caught': if (now-caughtT>1600) releaseFish();` — delegated to game/catch. */
  onActionWhileCaught(): void;
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

  function setRod(v: boolean): void { deps.getModel().rodPivot.visible = v; }

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
    const model = deps.getModel();
    if (deps.fp.on) {
      tmpDir.set(-Math.sin(deps.fp.yaw), 0, -Math.cos(deps.fp.yaw));
    } else {
      deps.camera.getWorldDirection(tmpDir);
      tmpDir.y = 0; tmpDir.normalize();
    }
    let dist = 12 + power * 73;
    for (let k = 0; k < 8 && landH(boat.x + tmpDir.x * dist, boat.z + tmpDir.z * dist) > -0.4; k++) dist *= 0.8;
    F.to = { x: boat.x + tmpDir.x * dist, y: 0, z: boat.z + tmpDir.z * dist };
    const tipSrc = deps.fp.on ? deps.rodVM.tip : model.rodTip;
    tipSrc.getWorldPosition(tmpTarget);
    F.from = { x: tmpTarget.x, y: tmpTarget.y, z: tmpTarget.z };
    F.castT = 0; F.castDur = 0.5 + power * 0.9; F.castH = 3 + power * 14;
    F.state = 'casting'; F.key = null;
    setRod(true);
    visuals.bobber.visible = true;
    deps.rodVM.whip();
  }

  function reelIn(msg?: string): void {
    visuals.hideHooked();
    F.state = 'idle'; F.key = null; F.charging = false;
    $('castbar')?.classList.add('hidden');
    setRod(false);
    visuals.bobber.visible = false;
    visuals.fishLine.visible = false;
    $('fight')?.classList.add('hidden');
    $('strike')?.classList.add('hidden');
    F.fight = null; F.fightParams = null;
    if (msg) toast(msg);
  }

  /** legacy `chooseFish()` (index.html:2655-2660) — shows the hooked-fish mesh as soon as a
   * species/weight is rolled, same as legacy (the fish is visible swimming near the bobber
   * before the strike). */
  function chooseFishLocal(): void {
    const hump = nearHump(F.bob.x, F.bob.z);
    const fish = chooseFish(F.zone, F.bob, { hotspot: !!F.hs, hump }, clientRng);
    F.key = fish.key; F.sp = SPECIES[fish.key]; F.weight = fish.weight;
    F.fx = fish.x; F.fz = fish.z; F.ofx = fish.ofx; F.ofz = fish.ofz;
    visuals.showHooked(F.sp.color, scaledLenM(fish.key, fish.weight));
  }

  function missFish(msg: string): void {
    $('strike')?.classList.add('hidden');
    visuals.hideHooked();
    F.key = null; F.state = 'waiting';
    F.biteT = rand(4, 8) * (F.hs ? 0.5 : 1);
    toast(msg);
  }

  function setHook(): void {
    $('strike')?.classList.add('hidden');
    if (!F.key) chooseFishLocal();
    const key = F.key!, S = F.sp!;
    const params = fightParamsFor(key, F.weight, F.drag);
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
  }

  function lose(msg: string): void { reelIn(msg); }

  function land(): void {
    const key = F.key!, weight = F.weight, fx = F.fx, fz = F.fz, zone = F.zone;
    F.state = 'caught';
    F.caughtT = performance.now();
    visuals.hideHooked();
    setRod(false);
    $('fight')?.classList.add('hidden');
    F.fight = null; F.fightParams = null;
    deps.onLanded({ key, weight, fx, fz, zone });
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
    const model = deps.getModel();

    if (F.charging) {
      F.chargeT += dt;
      F.charge = Math.min(1, F.chargeT / 1.3);
      const fill = $('castFill'); if (fill) fill.style.width = F.charge * 100 + '%';
      setText('castDist', Math.round(12 + F.charge * 73) + ' m');
    }
    if (F.state === 'idle') return;

    const reel = deps.boatInput.back || (actionInput.held && F.state === 'fight');
    F.reeling = reel;
    const aimTarget = F.state === 'fight' ? tmpTarget.set(F.fx, 0, F.fz) : tmpTarget.set(F.bob.x, 0, F.bob.z);
    visuals.aimRod(model, aimTarget, F.state === 'fight', F.fight ? F.fight.tension : 0);

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
        F.zone = zoneAt(F.bob.x, F.bob.z);
        F.hs = null; // bird/bait hotspots, weedlines and rigs are unscheduled — see src/stubs.ts
        F.biteT = rand(4, 10) * (F.hs ? 0.4 : 1);
        F.key = null;
        toast(Math.round(Math.hypot(F.bob.x - boat.x, F.bob.z - boat.z)) + ' m cast into the ' + F.zone.toLowerCase() + '.');
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
        if (F.biteT <= 0) { F.state = 'nibble'; F.nibs = 1 + Math.floor(Math.random() * 3); F.nibT = 0.05; }
      } else if (F.state === 'nibble') {
        F.nibT -= dt;
        if (F.nibT <= 0) {
          if (F.nibs <= 0) {
            F.state = 'bite'; F.win = 1.4;
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
      const next: FightState = stepFight(F.fight, { reeling: reel }, F.fightParams, { boatX: boat.x, boatZ: boat.z }, clientRng, dt);
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
        }
      }
      visuals.updateHooked(t, dt, next.running, next.shake, next.deep, next.airborne);

      const fT = $('fT');
      if (fT) { fT.style.width = clamp(next.tension, 0, 1) * 100 + '%'; fT.className = next.tension > 0.82 ? 'hot' : next.tension < 0.08 ? 'slack' : ''; }
      setText('fLine', Math.round(next.dist) + ' m');
      const fStam = $('fStam'); if (fStam) fStam.style.width = next.stam * 100 + '%';

      if (next.outcome === 'landed') { land(); return; }
      if (next.outcome === 'snapped') { lose('Snap! Too much pressure and the line parted.'); return; }
      if (next.outcome === 'slack') { lose('Slack line — the fish shook the hook.'); return; }
      if (next.outcome === 'spooled') { lose('Spooled! Chase the big ones with the boat next time.'); return; }
      if (next.outcome === 'mangrove') { lose('Cut off in the mangroves.'); return; }
    }
  }

  renderDrag();

  return {
    startCharge, releaseCast, cast, reelIn, setHook, setDrag,
    onAction, onActionUp, update, actionInput,
  };
}

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}
