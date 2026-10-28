/**
 * Handgun mode, as game/world.ts sees it: a fourth peer beside the boat, the diver and the walker.
 *
 *   9 (or the pistol button)  draw   |   9 / Esc  holster
 *   click / Space  fire   |   R  reload   |   drag or arrows  aim
 *
 * Plinking from the boat at fish near the surface and at the gulls, pelicans and frigatebirds
 * that fly around. Cartoon register, same as the speargun it sits beside: the targets are fish
 * and seabirds, a hit is a comic reaction (a stunned fish floats up and wakes offended; a bird
 * leaves in a huff and comes back), and nothing here has any notion of a person to aim at. The
 * ballistics are pure and shared (`@keysrun/shared/sim/handgun`); this file is everything that
 * needs a scene, a camera, a clock or the DOM.
 *
 * ## Why a facade (and the world.ts touch-points)
 * game/world.ts is contested, so this follows entities/land/index.ts: everything mode-shaped lives
 * here and world.ts calls it at a handful of marked points: construct; pin the boat (neutral
 * input) while it is in hand; `step` in the fixed loop; `syncMode` after it; `updateCamera`
 * instead of the boat camera; `update` once a frame; read `activeSpooks()` into the fish threats;
 * and ask before diving / tying up / switching boats.
 *
 * ## The mode-change discipline (the part that has gone wrong twice here)
 * Mode flips happen in exactly one place, `syncMode()`, called once per frame after the fixed-step
 * loop, never inside a key handler. `draw()`/`holster()` only change what the mode WANTS to be.
 * `syncMode` then saves on the way in and restores on the way out, and the two are written
 * together so one cannot be edited without seeing the other:
 *   - the boat camera's drift (`camState`, `fpState`): entities/camera.ts's pointer binding is
 *     mode-agnostic and keeps mutating them while you drag-look, so they are snapshotted and put
 *     back, along with `camera.near/far/fov`;
 *   - the boat HUD (gauges, chart, scorebox, hint, touch pad): hidden on the way in, restored on
 *     the way out - but only if the game is still running (see `restoreBoatUi`);
 *   - the view model, HUD, held keys, an interrupted reload, brass and streaks in flight.
 * Involuntary exits (Switch boat, the net agent swapping hulls) go through `exitToBoat()` and the
 * same `syncMode()`, so no path skips the restore.
 *
 * ## While the pistol is out
 * The boat is given neutral input and drifts (world.ts), exactly as it does under a diver: you
 * cannot shoot straight from a planing hull and the rod cannot be cast. Space/R/J/F/... are
 * swallowed before they reach the boat-era listeners (input.ts explains why a capture listener).
 *
 * ## What a shot does (consequences)
 *  - costs a round (shop item `handgun.ammo`; the inventory is the single source of truth);
 *  - the report spooks fish: `kind: 'spear'` threats, the same mechanism a missed shaft uses, placed
 *    under the shooter and along the shot (sim/handgun.ts `gunshotSpooks`) and held for a few
 *    seconds, so a school that bolts stays bolted instead of drifting straight back;
 *  - the report scatters birds, probabilistically with distance and nearness to the bullet
 *    (seabirds.ts `scareBird`: out, gone, and flying back in);
 *  - a bird that is actually HIT falls out of the sky, hits the water and floats there as a
 *    carcass, which draws the big predatory species in to it (`life.shootBird` ->
 *    entities/life/carcass.ts -> @keysrun/shared/sim/chum). A dead bird on the surface is chum, and
 *    that - not the scattering - is what a hit on a bird is for;
 *  - Caelen is reached through `life.caelenShot` with the bullet's real air path, so his hitbox,
 *    "you suck at this" taunt and two-minute sulk are his own and not duplicated here.
 */
import * as THREE from 'three';
import { seaHAt } from '@keysrun/shared/sim/depth-grid';
import { landH } from '@keysrun/shared/world/depth';
import { mulberry32 } from '@keysrun/shared/rng';
import { SPECIES } from '@keysrun/shared/content/species';
import { countOf, useOne, type Modifiers } from '@keysrun/shared/sim/shop';
import type { GearPort } from '@keysrun/shared/sim/gear';
import type { HandWobble } from '@keysrun/shared/sim/steady';
import {
  AMMO_KEY, ASSIST_MAX_DEPTH_M, FLARE_KEY, takeFlare, RELOAD_EMPTY_S, RELOAD_S, REPORT_BIRD_M,
  aimBullet, ammoNotice, birdAwaySeconds, birdScatterChance, createGun, fireBullet, gunshotSpooks, magSizeFor,
  pullTrigger, startReload, spreadDir, spreadFor, stepBullet, stepGun, FISH_SPOOK_S,
  type BulletEnv, type BulletEvent, type BulletHit, type BulletState, type BulletTarget, type GunState, type Spook,
} from '@keysrun/shared/sim/handgun';
import type { BoatModel } from '../boat/model.js';
import type { CamState, FpState } from '../camera.js';
import type { FishWorld } from '../fish/index.js';
import type { LifeSystems } from '../life/index.js';
import { birdShown, birdWorldPos, scareBird, type Bird } from '../life/seabirds.js';
import { CAELEN_NEAR_MISS } from '../life/caelen.js';
import { closestDistSqSegmentSegment } from '@keysrun/shared/sim/spear';
import type { ParticleSystem } from '../../world/particles.js';
import type { AudioSystem } from '../../audio/index.js';
import { createPistolViewModel, type PistolViewModel } from './viewmodel.js';
import { createBrass, createFloaters, createStreaks, type Brass, type Floaters, type Streaks } from './fx.js';
import { createBlood, type Blood } from './blood.js';
import { createFlares, type Flares } from './flares.js';
import { createGunHud, type GunHud } from './hud.js';
import { bindPistolInput } from './input.js';

export type HandgunMode = 'boat' | 'gun';

export interface HandgunDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  sky: THREE.Object3D;
  sunDisc: THREE.Object3D;
  sunDir: THREE.Vector3;
  /** The boat camera's own state: snapshotted on entry, restored on exit. */
  camState: CamState;
  fpState: FpState;
  isTouch: boolean;
  getBoat(): { x: number; y: number; z: number; h: number; speed: number };
  getModel(): BoatModel;
  gameRunning(): boolean;
  /** Why the pistol cannot be drawn right now (diving, ashore, a fish on the line, a race), or null. */
  refuse(): string | null;
  /** Called on the way in: reel in an idle line so fishing never holds a reference to a boat nobody is working. */
  prepare(): void;
  toast(msg: string): void;
  /**
   * Caelen is down. The deck reacts — see game/world.ts's wiring. Optional so the gun does not
   * depend on there being a crew aboard to shoot him.
   */
  onCaelenDown?(): void;
  /** The player's inventory; rounds are `handgun.ammo`, upgrades read from `mods`. */
  gear: GearPort;
  fishWorld: Pick<FishWorld, 'spearTargetsNear'>;
  life: Pick<LifeSystems, 'shootableBirds' | 'shootBird' | 'caelenShot' | 'caelenDebugHitbox'>;
  audio: Pick<AudioSystem['engine'], 'gunshot' | 'gunClick' | 'gunBrass' | 'gunReload' | 'gunImpact' | 'gunHitTick' | 'gull'>;
  particles: ParticleSystem;
}

export interface HandgunSystem {
  readonly mode: HandgunMode;
  draw(): void;
  holster(): void;
  toggle(): void;
  /** One fixed physics step: the gun's clocks, held look keys, bullets in flight. */
  step(dt: number, t: number): void;
  /** Once per frame after the fixed-step loop: the single place mode changes are applied. */
  syncMode(): void;
  /** Camera for this frame (only call while `mode === 'gun'`). */
  updateCamera(dt: number, t: number, hand?: HandWobble): void;
  /** Every frame, after the camera is final: view model, HUD, brass, streaks, the stunned fish. */
  update(dt: number, t: number): void;
  /** Where fish are currently frightened by gunfire; world.ts turns each into a `'spear'` threat. */
  activeSpooks(): readonly Spook[];
  exitToBoat(): void;
  dispose(): void;
}

/** Everything the bullet can hit this tick, with what the hit means. */
interface TargetInfo {
  kind: 'fish' | 'bird' | 'synthetic-fish' | 'synthetic-bird';
  key: string;
  weight: number;
  bird?: Bird;
  birdKind?: string;
}

interface Tracked { B: Bird; kind: string; x: number; y: number; z: number; vx: number; vy: number; vz: number; seen: number }

/** Capsule radius by bird kind, m. Sized off the wings, like Caelen's (entities/life/caelen.ts
 * `CAELEN_RADIUS`, whose 0.75 is for a 1.45x gull): a pistol round through the wing is a hit by any
 * cartoon reading, and a hit on a bird 30 m away has to be a thing a human can land. */
const BIRD_RADIUS: Record<string, number> = { gull: 0.5, tern: 0.42, frigate: 0.8, pelican: 0.8 };
const BIRD_HALF_LEN = 0.3;
/** Birds farther than this from the eye are not tracked at all (the bullet is gone by then). */
const BIRD_TRACK_M = 130;

interface Snapshot {
  camYaw: number; camPitchOff: number; camZoom: number;
  fpDYaw: number; fpDPitch: number; fpView: number; fpPref: boolean; fpOn: boolean; fpDriveOn: boolean;
  near: number; far: number; fov: number;
}

const GUN_NEAR = 0.05;
const KEY_LOOK_RATE = 1.5;
const PITCH_MIN = -1.2, PITCH_MAX = 1.1;

function $(id: string): HTMLElement | null { return document.getElementById(id); }

const _eye = new THREE.Vector3(), _dir = new THREE.Vector3(), _muz = new THREE.Vector3(), _port = new THREE.Vector3(), _tmp = new THREE.Vector3();

export function createHandgunSystem(deps: HandgunDeps): HandgunSystem {
  const { camera, scene } = deps;
  const vm: PistolViewModel = createPistolViewModel(camera);
  const brass: Brass = createBrass(scene, () => deps.audio.gunBrass());
  const streaks: Streaks = createStreaks(scene);
  const floaters: Floaters = createFloaters(scene);
  const blood: Blood = createBlood(scene);
  const flares: Flares = createFlares(scene, deps.particles);
  const hud: GunHud = createGunHud(deps.isTouch, { fire: () => pull(), reload: () => reload(), holster: () => holster() });
  const aimRng = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
  const scatterRng = mulberry32((Date.now() ^ 0x85ebca6b) >>> 0);

  let mode: HandgunMode = 'boat';
  let prevMode: HandgunMode = 'boat';
  let snap: Snapshot | null = null;
  let gun: GunState = createGun(0); // arrives empty: first draw loads it (see `syncMode`)
  const look = { yaw: 0, pitch: 0.04 };
  let keyLook = { yaw: 0, pitch: 0 };
  let simNow = 0;
  let camKick = 0;

  interface Flight {
    b: BulletState; shooter: { x: number; z: number }; impact: { x: number; z: number } | null; prev: { x: number; y: number; z: number };
    /** Where the shot was fired from and which way, for scattering birds when it ARRIVES (see `finish`). */
    eye: { x: number; y: number; z: number }; dir: { x: number; y: number; z: number };
    /** Caelen has already been told about this shot (hit, or taunted) - see `tellCaelen`. */
    caelenHit: boolean; caelenTaunted: boolean;
  }
  const flights: Flight[] = [];
  let spooks: Spook[] = [];
  const tally = { fish: 0, birds: 0, caelen: 0, shots: 0, hits: 0, misses: 0 };
  let firstFishToast = false, firstBirdToast = false;
  let lastReloadFrac = 0;
  let noteT = 0;

  /** VERIFICATION-ONLY targets (see `__handgunDebug.synth`). */
  const synth: Array<{ info: TargetInfo; t: BulletTarget }> = [];

  // ------------------------------------------------------------------ numbers from the gear
  const mods = (): Modifiers => deps.gear.mods(simNow);
  const magSize = (): number => magSizeFor(mods());
  const carried = (): number => countOf(deps.gear.inventory(), AMMO_KEY);
  /** Rounds in the box: everything owned that is not loaded. */
  const reserve = (): number => Math.max(0, carried() - gun.mag);

  const surfaceY = (x: number, z: number): number => seaHAt(x, z, simNow);
  const env: BulletEnv = { surfaceY, groundY: (x, z) => landH(x, z) };

  // ------------------------------------------------------------------ targets
  const tracked = new Map<Bird, Tracked>();
  let lastTrack = -1;

  /** Which birds are close enough and drawn, with a smoothed velocity for the assist's lead. Birds
   * move smoothly (no swim wiggle to average out, unlike fish - entities/fish/index.ts), so a
   * plain exponential average of frame-to-frame displacement is a good velocity. */
  function refreshBirds(t: number, force = false): void {
    if (!force && t - lastTrack < 0.1) return;
    const dt = lastTrack < 0 ? 0 : t - lastTrack;
    lastTrack = t;
    camera.getWorldPosition(_eye);
    const seen = new Set<Bird>();
    for (const B of deps.life.shootableBirds()) {
      if (!birdShown(B)) continue;
      const p = birdWorldPos(B, _tmp);
      if (Math.hypot(p.x - _eye.x, p.y - _eye.y, p.z - _eye.z) > BIRD_TRACK_M) continue;
      seen.add(B);
      const tr = tracked.get(B);
      if (tr && dt > 1e-3) {
        const k = 0.5;
        tr.vx += ((p.x - tr.x) / dt - tr.vx) * k; tr.vy += ((p.y - tr.y) / dt - tr.vy) * k; tr.vz += ((p.z - tr.z) / dt - tr.vz) * k;
        tr.x = p.x; tr.y = p.y; tr.z = p.z; tr.seen = t;
      } else if (!tr) {
        tracked.set(B, { B, kind: B.kind, x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, seen: t });
      }
    }
    for (const B of [...tracked.keys()]) if (!seen.has(B)) tracked.delete(B);
  }

  /** The live capsule list for this instant, with an index back to what each one is. */
  function gatherTargets(near: { x: number; y: number; z: number }, radius: number): { list: BulletTarget[]; info: Map<string | number, TargetInfo> } {
    const list: BulletTarget[] = [];
    const info = new Map<string | number, TargetInfo>();
    for (const f of deps.fishWorld.spearTargetsNear(near.x, near.y, near.z, radius)) {
      if (f.catchable === false) continue;
      // The bullet cannot reach anything with its TOP more than a few metres under: don't spend hit
      // tests (or an assist lock) on it. The real gate is the water model in the sim; this is only
      // a cull.
      if (Math.max(f.ay, f.by) + f.radius < -3) continue;
      list.push(f);
      info.set(f.id, { kind: 'fish', key: f.key, weight: f.weight });
    }
    let i = 0;
    for (const tr of tracked.values()) {
      if (!birdShown(tr.B)) continue;
      const p = birdWorldPos(tr.B, _tmp);
      const fx = Math.sin(tr.B.yaw) * BIRD_HALF_LEN, fz = Math.cos(tr.B.yaw) * BIRD_HALF_LEN;
      const id = `bird#${i++}`;
      list.push({
        id, ax: p.x - fx, ay: p.y, az: p.z - fz, bx: p.x + fx, by: p.y, bz: p.z + fz,
        radius: BIRD_RADIUS[tr.kind] ?? 0.5, vx: tr.vx, vy: tr.vy, vz: tr.vz,
      });
      info.set(id, { kind: 'bird', key: tr.kind, weight: 0, bird: tr.B, birdKind: tr.kind });
    }
    for (const s of synth) { list.push(s.t); info.set(s.t.id, s.info); }
    return { list, info };
  }

  // ------------------------------------------------------------------ the trigger
  function aimBasis(): { eye: THREE.Vector3; dir: THREE.Vector3 } {
    camera.updateMatrixWorld(true);
    camera.getWorldPosition(_eye);
    camera.getWorldDirection(_dir);
    return { eye: _eye, dir: _dir };
  }

  function pull(): void {
    if (mode !== 'gun') return;
    const r = pullTrigger(gun);
    if (r.result === 'busy') return;
    if (r.result === 'empty') {
      deps.audio.gunClick();
      const n = ammoNotice(0, reserve());
      if (n) flashNote(n, true);
      if (reserve() > 0 && !gun.reloading) reload();
      return;
    }
    const before = gun;
    gun = r.gun;
    // Spend the round. The inventory is the single source of truth (sim/handgun.ts).
    const spent = useOne(deps.gear.inventory(), AMMO_KEY);
    if (spent !== deps.gear.inventory()) deps.gear.commit(spent);

    refreshBirds(simNow, true);
    const { eye, dir } = aimBasis();
    vm.muzzle.getWorldPosition(_muz);
    vm.port.getWorldPosition(_port);
    const muzzle = { x: _muz.x, y: _muz.y, z: _muz.z };
    const eyeP = { x: eye.x, y: eye.y, z: eye.z };
    const dirP = { x: dir.x, y: dir.y, z: dir.z };
    const { list } = gatherTargets(eyeP, 70);
    // Only offer the assist things the bullet could actually hit: a fish deeper than the water
    // will let a bullet through is not a fair lock (sim/handgun.ts `ASSIST_MAX_DEPTH_M`).
    const assistable = list.filter((t) => {
      const top = Math.max(t.ay, t.by) + t.radius;
      return surfaceY((t.ax + t.bx) / 2, (t.az + t.bz) / 2) - top <= ASSIST_MAX_DEPTH_M;
    });
    const aim = aimBullet(muzzle, eyeP, dirP, assistable);
    const spread = spreadFor(before, mods().handgunSpreadMul);
    const d = spreadDir({ x: aim.dx, y: aim.dy, z: aim.dz }, spread, aimRng);
    const b = fireBullet(muzzle, d);
    flights.push({ b, shooter: { x: eye.x, z: eye.z }, impact: null, prev: { x: muzzle.x, y: muzzle.y, z: muzzle.z }, eye: eyeP, dir: d, caelenHit: false, caelenTaunted: false });
    tally.shots++;

    // --- presentation
    vm.kick(before.heat);
    camKick = Math.min(0.03, camKick + 0.009 + 0.01 * before.heat);
    deps.audio.gunshot();
    brass.eject(_port, camera, eye.y);
    // The report's CONSEQUENCES (fish spooked, birds scattered) are deliberately NOT applied here but
    // when the bullet resolves (`finish`). A supersonic round reaches its target before the sound of
    // the shot does, so a gull cannot flee the bang before the bullet gets there - and the first
    // version of this did exactly that: birds left on the trigger pull, so every shot at a bird
    // was aimed at a bird that was already running (measured 0 hits in 5 on the live gulls). The
    // same goes for the school under the boat: it must still be where the bullet is going.
    const note = ammoNotice(gun.mag, reserve());
    if (note) flashNote(note, gun.mag === 0);
  }

  function reload(): void {
    if (mode !== 'gun') return;
    const r = startReload(gun, magSize(), reserve());
    if (!r.started) {
      if (!gun.reloading) {
        if (reserve() <= 0 && gun.mag < magSize()) flashNote('No spare rounds. Deadeye Guns & Ammo sells 9 mm by the box.', true);
        else if (gun.mag >= magSize()) flashNote('Magazine is full.');
      }
      return;
    }
    gun = r.gun;
    lastReloadFrac = 0;
  }

  /** Z: fire a marine flare (shop item `safety.flare`). Spends one from the inventory through the same
   * GearPort every other consumable uses; with none, says so. Fired along the aim but always lofted
   * (sim/handgun.ts `flareLaunch`), lights for ~18 s (flares.ts, no scene light), and the pop startles
   * gulls within earshot. Best fired around sunset (the O key / sun button), when it is worth seeing. */
  function flare(): void {
    if (mode !== 'gun') return;
    const taken = takeFlare(deps.gear.inventory());
    if (!taken.ok) { deps.toast('No flares. Deadeye Guns & Ammo sells a marine flare kit (three for $38).'); return; }
    deps.gear.commit(taken.inventory);
    const { eye, dir } = aimBasis();
    vm.muzzle.getWorldPosition(_muz);
    flares.launch({ x: _muz.x, y: _muz.y, z: _muz.z }, { x: dir.x, y: dir.y, z: dir.z });
    deps.audio.gunReload('rack'); // the flare gun's thunk; no separate sample for a one-off
    refreshBirds(simNow, true);
    for (const tr of tracked.values()) {
      if (!tr.B.flee && Math.hypot(tr.x - eye.x, tr.z - eye.z) < 60 && scatterRng() < 0.5) scareBird(tr.B, eye.x, eye.z, birdAwaySeconds(tr.kind, false));
    }
    const left = countOf(deps.gear.inventory(), FLARE_KEY);
    deps.toast(left > 0 ? `Flare away. ${left} left.` : 'Flare away. That was the last one.');
  }

  function flashNote(text: string, bad = false): void { hud.setNote(text, bad); noteT = 2.4; }

  // ------------------------------------------------------------------ consequences
  function addSpook(s: Spook): void {
    // Merge with an existing nearby spook so a string of shots does not grow the list without bound.
    for (const o of spooks) if (Math.hypot(o.x - s.x, o.z - s.z) < 3) { o.ttl = Math.max(o.ttl, s.ttl); return; }
    spooks.push({ ...s });
  }

  /** Birds scatter at the report: probabilistic in distance to the shooter and to the bullet's
   * line (`birdScatterChance`). Called at fire time with the planned line, so a bird a bullet
   * cracks past at 5 m leaves even if the bullet then keeps going. */
  function scatterBirds(eye: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }): void {
    for (const tr of tracked.values()) {
      if (tr.B.flee) continue;
      const rx = tr.x - eye.x, ry = tr.y - eye.y, rz = tr.z - eye.z;
      const along = Math.max(0, Math.min(REPORT_BIRD_M, rx * d.x + ry * d.y + rz * d.z));
      const px = eye.x + d.x * along - tr.x, py = eye.y + d.y * along - tr.y, pz = eye.z + d.z * along - tr.z;
      const distPath = Math.hypot(px, py, pz), distShooter = Math.hypot(rx, ry, rz);
      if (scatterRng() < birdScatterChance(distShooter, distPath)) scareBird(tr.B, eye.x, eye.z, birdAwaySeconds(tr.kind, false));
    }
  }

  function onHit(h: BulletHit, info: TargetInfo, shooter: { x: number; z: number }): void {
    tally.hits++;
    hud.flashHit();
    deps.audio.gunHitTick();
    if (info.kind === 'fish' || info.kind === 'synthetic-fish') {
      tally.fish++;
      deps.particles.splash(h.point.x, h.point.z, 12, 0.9);
      floaters.spawn(info.key, info.weight, h.point.x, h.point.z, shooter.x, shooter.z);
      // A small dark cloud at the wound, carried off by the current (blood.ts). Kept under the
      // surface: a hit fish is a metre or less down, and the cloud should read as water, not as
      // something on the screen.
      blood.burst(h.point.x, Math.min(h.point.y, surfaceY(h.point.x, h.point.z) - 0.08), h.point.z, simNow);
      // The school bolts: a louder spook right where the fish was, held longer than the report's.
      addSpook({ x: h.point.x, z: h.point.z, ttl: FISH_SPOOK_S * 1.4 });
      // Say what it was and how big, the way a catch is reported (name, then weight in lb, as the
      // cooler and the weigh-in do). Every hit says it: a hit that says nothing is the bug. The
      // longer explanation of what happens next is only for the first one.
      const name = SPECIES[info.key]?.name ?? 'fish';
      const lb = `${info.weight.toFixed(1)} lb`;
      deps.toast(firstFishToast
        ? `Plink! ${name}, ${lb}.`
        : `Plink! ${name}, ${lb} - it bobs up stunned, wakes offended and swims off. (Nothing to land it with: the pistol is for plinking.)`);
      firstFishToast = true;
    } else {
      tally.birds++;
      const p = h.point;
      for (let i = 0; i < 12; i++) {
        deps.particles.spawnP(p.x, p.y, p.z, (Math.random() - 0.5) * 2.2, 0.8 + Math.random() * 1.6, (Math.random() - 0.5) * 2.2, 1.2 + Math.random() * 0.9, 0.55, 0.95, true);
      }
      if (info.bird) {
        // Shot DOWN, not merely scattered. `scareBird` (which is still what the report itself does
        // to every other bird in earshot, below) was the whole consequence of a hit, so a hit and
        // a near miss amounted to the same thing: the flock left. Now the struck bird falls,
        // splashes, and leaves a carcass in the water that the big predatory species come to
        // (entities/life/carcass.ts, @keysrun/shared/sim/chum). `birdAwaySeconds(kind, true)` is
        // no longer consulted for a struck bird: how long the flock is a bird short is now tied to
        // how long its corpse floats (carcass.ts's BIRD_REPLACE_S), not to the scare table.
        deps.life.shootBird(info.bird);
        deps.audio.gull(p.x, p.z);
      }
      if (!firstBirdToast || tally.birds % 5 === 0) {
        firstBirdToast = true;
        deps.toast(info.kind === 'bird'
          ? `Squawk! The ${info.birdKind ?? 'gull'} drops into the water and lies there. Something big will be along for it shortly.`
          : `Squawk! The ${info.birdKind ?? 'gull'} loses a few feathers and its dignity.`);
      }
    }
    hud.setScore(tally.fish, tally.birds, tally.caelen);
  }

  function onEvent(e: BulletEvent): void {
    if (e.kind === 'splash') {
      deps.particles.splash(e.x, e.z, 7, 0.6);
      deps.audio.gunImpact('splash', e.x, e.z);
    } else if (e.kind === 'skip') {
      deps.particles.splash(e.x, e.z, 4, 0.4);
      deps.audio.gunImpact('skip', e.x, e.z);
    } else if (e.kind === 'thud') {
      deps.audio.gunImpact('thud', e.x, e.z);
    }
  }

  /**
   * Caelen, tested AS THE BULLET PASSES HIM, tick by tick. Testing once when the bullet ends (the
   * first version, mirroring how the speargun hands him its resolved ray) is wrong for a bullet:
   * one that misses everything flies on for ~120 m, which is a third of a second, and by the time it
   * has ended he has moved a metre and a half from where the bullet went through, so a shot that was
   * dead on him scored as a miss (0 in 8 on a stationary-aimed shot). A shaft ends within a few
   * metres, so there the ray and the bird agree.
   *
   * His geometry and his reaction both stay his own (`caelenShot` -> `resolveSpearShot`: capsule,
   * "you suck at this" taunt, two-minute sulk). This only decides WHEN to ask, using his published
   * hitbox, so that one bullet cannot ask twice and make him taunt twice as it crosses a tick
   * boundary: a hit always counts; a near miss is announced at most once per shot.
   */
  function tellCaelen(f: Flight, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    if (f.caelenHit) return;
    const hb = deps.life.caelenDebugHitbox();
    if (!hb) return;
    const { distSq } = closestDistSqSegmentSegment(from, to, { x: hb.ax, y: hb.ay, z: hb.az }, { x: hb.bx, y: hb.by, z: hb.bz });
    const near = hb.radius + CAELEN_NEAR_MISS;
    if (distSq <= hb.radius * hb.radius) {
      if (deps.life.caelenShot(from, to) === 'hit') {
        f.caelenHit = true;
        tally.caelen++; tally.hits++;
        hud.flashHit(); deps.audio.gunHitTick(); hud.setScore(tally.fish, tally.birds, tally.caelen);
        deps.onCaelenDown?.();
      }
    } else if (!f.caelenTaunted && distSq <= near * near) {
      f.caelenTaunted = true;
      deps.life.caelenShot(from, to); // 'nearMiss': he comments on your aim
    }
  }

  /** The bullet has ended (hit, water, ground, range). The report arrives now: spook the water along
   * the shot and scatter birds by how near they are to the shooter and to its line. */
  function finish(f: Flight, hitSomethingElse: boolean): void {
    const b = f.b;
    if (!hitSomethingElse) tally.misses++;
    // The report arrives: spook the water under the shooter and along the line to where the bullet
    // ended, and scatter birds by how close they are to the shooter and to that line.
    const end = f.impact ?? { x: b.x, z: b.z };
    for (const s of gunshotSpooks(f.shooter, end)) addSpook(s);
    scatterBirds(f.eye, f.dir);
  }

  // ------------------------------------------------------------------ fixed step
  function step(dt: number, t: number): void {
    simNow = t;
    // the gun's clocks run whether or not it is in hand (a holstered pistol cools off)
    // A pistol holstered mid-reload has its reload cancelled (nothing was spent: a reload only moves
    // rounds from the box to the magazine, see sim/handgun.ts), checked BEFORE the clock runs so a
    // reload cannot complete in the same step the gun was put away.
    if (mode !== 'gun' && gun.reloading) gun = { ...gun, reloading: false, reloadT: 0, fromEmpty: false };
    gun = stepGun(gun, dt, magSize(), (want) => Math.min(want, Math.max(0, carried() - gun.mag)));
    if (mode === 'gun' && (keyLook.yaw || keyLook.pitch)) {
      look.yaw += keyLook.yaw * KEY_LOOK_RATE * dt;
      look.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, look.pitch + keyLook.pitch * KEY_LOOK_RATE * dt));
    }

    if (flights.length) {
      refreshBirds(t);
      for (let i = flights.length - 1; i >= 0; i--) {
        const f = flights[i];
        const { list, info } = gatherTargets({ x: f.b.x, y: f.b.y, z: f.b.z }, 26);
        const r = stepBullet(f.b, list, dt, env);
        f.b = r.bullet;
        streaks.add(f.prev.x, f.prev.y, f.prev.z, f.b.x, f.b.y, f.b.z);
        tellCaelen(f, f.prev, { x: f.b.x, y: f.b.y, z: f.b.z });
        f.prev = { x: f.b.x, y: f.b.y, z: f.b.z };
        for (const e of r.events) { onEvent(e); if (e.kind === 'splash' || e.kind === 'thud') f.impact = { x: e.x, z: e.z }; }
        if (r.hit) {
          f.impact = { x: r.hit.point.x, z: r.hit.point.z };
          const what = info.get(r.hit.id);
          if (what) onHit(r.hit, what, f.shooter);
          finish(f, true);
          flights.splice(i, 1);
        } else if (!f.b.alive) {
          finish(f, false);
          flights.splice(i, 1);
        }
      }
    }
    for (const s of spooks) s.ttl -= dt;
    spooks = spooks.filter((s) => s.ttl > 0);
  }

  // ------------------------------------------------------------------ mode changes
  function setBoatUi(hidden: boolean): void {
    $('gauges')?.classList.toggle('hidden', hidden);
    $('mapbox')?.classList.toggle('hidden', hidden);
    $('scorebox')?.classList.toggle('hidden', hidden);
    $('hint')?.classList.toggle('hidden', hidden); // ui/hud.ts only refreshes it while driving, so it would sit there frozen
    if (deps.isTouch) $('touch')?.classList.toggle('hidden', hidden);
  }

  function syncMode(): void {
    if (mode === prevMode) return;
    const { camState, fpState } = deps;
    if (mode === 'gun') {
      snap = {
        camYaw: camState.yaw, camPitchOff: camState.pitchOff, camZoom: camState.zoom,
        fpDYaw: fpState.dYaw, fpDPitch: fpState.dPitch, fpView: fpState.view, fpPref: fpState.pref, fpOn: fpState.on, fpDriveOn: fpState.driveOn,
        near: camera.near, far: camera.far, fov: camera.fov,
      };
      camera.near = GUN_NEAR;
      camera.updateProjectionMatrix();
      setBoatUi(true);
      vm.group.visible = true;
      hud.show(true);
      const boat = deps.getBoat();
      // Start looking out over the side, as the first-person fishing view does (entities/camera.ts:
      // `boat.h - PI/2`), NOT down the boat: forward of the cockpit is where the captain, the crew and
      // the deck party stand, and the first version of this looked straight at the back of a
      // passenger's head. You can still look anywhere; nothing here aims at or hits a person.
      look.yaw = boat.h - Math.PI / 2; look.pitch = 0.04;
      camKick = 0;
      refreshHud(0);
      hud.setScore(tally.fish, tally.birds, tally.caelen);
      // An empty gun is loaded on the first draw (the magazine is not persisted, so a reloaded page
      // always starts empty). It costs the reload time and nothing else.
      if (gun.mag === 0 && reserve() > 0) { gun = startReload(gun, magSize(), reserve()).gun; lastReloadFrac = 0; }
      else if (gun.mag === 0) flashNote(ammoNotice(0, 0) ?? '', true);
      deps.toast('Pistol out. Click or Space to fire, R to reload, 9 to holster. Fish near the surface and the gulls are fair game.');
    } else {
      // Put back exactly what we took. near/far/fov first, with a projection update, so a frame never
      // renders the boat with the pistol camera's planes.
      if (snap) {
        camera.near = snap.near; camera.far = snap.far; camera.fov = snap.fov;
        camera.updateProjectionMatrix();
        camState.yaw = snap.camYaw; camState.pitchOff = snap.camPitchOff; camState.zoom = snap.camZoom;
        fpState.dYaw = snap.fpDYaw; fpState.dPitch = snap.fpDPitch; fpState.view = snap.fpView; fpState.pref = snap.fpPref;
        fpState.on = snap.fpOn; fpState.driveOn = snap.fpDriveOn;
        snap = null;
      }
      camState.dragging = false;
      restoreBoatUi();
      vm.group.visible = false;
      hud.show(false);
      hud.setReload(null);
      hud.setCross('idle');
      keyLook = { yaw: 0, pitch: 0 };
      // Brass and streaks are cheap to just drop; a bullet already in flight is left to land (it
      // still counts), and the stunned fish keep floating - they are in the world, not in the hand.
      brass.clear(); streaks.clear();
      if (gun.reloading) gun = { ...gun, reloading: false, reloadT: 0, fromEmpty: false };
    }
    prevMode = mode;
  }

  /** Boat HUD back on - unless the player has gone to the start screen in the meantime
   * ("Switch boat" holsters, then hides the HUD), in which case turning pieces back on would put a
   * chart and a throttle gauge over the title card. The `#hud` container is hidden by showStart,
   * so only the touch pad (which lives outside it) needs the explicit check. */
  function restoreBoatUi(): void {
    setBoatUi(false);
    if (deps.isTouch && !deps.gameRunning()) $('touch')?.classList.add('hidden');
  }

  function draw(): void {
    if (mode === 'gun') return;
    if (!deps.gameRunning()) return;
    const why = deps.refuse();
    if (why) { deps.toast(why); return; }
    deps.prepare();
    mode = 'gun';
  }
  function holster(): void { if (mode === 'gun') mode = 'boat'; }
  function toggle(): void { if (mode === 'gun') holster(); else draw(); }

  // ------------------------------------------------------------------ camera and per-frame
  function updateCamera(dt: number, _t: number, hand?: HandWobble): void {
    const model = deps.getModel();
    model.group.updateMatrixWorld(true);
    // The cockpit rod position (BoatModel.fishSpot) at standing eye height: the same spot the
    // first-person fishing view uses, i.e. somewhere on the boat a person plausibly stands.
    const eye = model.group.localToWorld(_tmp.copy(model.fishSpot).add(new THREE.Vector3(0, 1.62, 0)));
    camera.position.copy(eye);
    camKick *= Math.exp(-9 * dt);
    camera.rotation.set(look.pitch + camKick + (hand?.pitch ?? 0), look.yaw + (hand?.yaw ?? 0), hand?.roll ?? 0, 'YXZ');
    camera.updateMatrixWorld(true);
    deps.sky.position.copy(camera.position);
    deps.sunDisc.position.copy(camera.position).addScaledVector(deps.sunDir, 5000);
    deps.sunDisc.lookAt(camera.position);
  }

  function refreshHud(dt: number): void {
    hud.setAmmo(gun.mag, magSize(), reserve());
    const total = gun.fromEmpty ? RELOAD_EMPTY_S : RELOAD_S;
    hud.setReload(gun.reloading ? 1 - gun.reloadT / total : null);
    if (noteT > 0) { noteT -= dt; if (noteT <= 0) hud.setNote(''); }
  }

  let lockT = 0;
  function update(dt: number, t: number): void {
    simNow = t;
    floaters.update(dt, t);
    blood.update(dt);
    flares.update(dt, t, surfaceY);
    brass.update(dt);
    streaks.update(dt);
    if (mode !== 'gun') return;
    refreshBirds(t);
    // reload choreography: audio cues at the moments the model shows them
    const total = gun.fromEmpty ? RELOAD_EMPTY_S : RELOAD_S;
    const frac = gun.reloading ? 1 - gun.reloadT / total : null;
    if (frac !== null) {
      const cue = (at: number, part: 'out' | 'in' | 'rack'): void => { if (lastReloadFrac < at && frac >= at) deps.audio.gunReload(part); };
      cue(0.12, 'out'); cue(0.6, 'in'); if (gun.fromEmpty) cue(0.82, 'rack');
      lastReloadFrac = frac;
    } else lastReloadFrac = 0;
    const b = deps.getBoat();
    vm.update(dt, { reload: frac, fromEmpty: gun.fromEmpty, slideLocked: gun.mag === 0 && !gun.reloading }, Math.abs(b.speed));
    refreshHud(dt);

    // crosshair lock: the same assist the shot will use, evaluated ~5x a second
    lockT -= dt;
    if (lockT <= 0) {
      lockT = 0.2;
      const { eye, dir } = aimBasis();
      vm.muzzle.getWorldPosition(_muz);
      const { list } = gatherTargets({ x: eye.x, y: eye.y, z: eye.z }, 50);
      const a = aimBullet({ x: _muz.x, y: _muz.y, z: _muz.z }, { x: eye.x, y: eye.y, z: eye.z }, { x: dir.x, y: dir.y, z: dir.z }, list, { strength: 0 });
      hud.setCross(a.targetId !== null ? 'lock' : 'idle');
    }
  }

  // ------------------------------------------------------------------ input
  /** Any full-screen panel that owns the keyboard: the start screen, the catch card, the cooler, the
   * gear screen, a town venue panel. The existing handlers guard on `#start` only; the pistol's
   * toggle key must not fire behind ANY of them (a stray 9 while the cooler is open must not draw a
   * gun on the other side of the glass). */
  function overlayOpen(): boolean {
    return !!document.querySelector('.overlay:not(.hidden), #gearScreen:not(.hidden), #landPanel:not(.hidden)');
  }
  const unbind = bindPistolInput(deps.canvas, {
    isGun: () => mode === 'gun',
    suspended: () => !deps.gameRunning() || overlayOpen(),
    toggle, holster, fire: pull, reload, flare,
    look(dy, dp) { look.yaw += dy; look.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, look.pitch + dp)); },
    setKeyLook(yaw, pitch) { keyLook = { yaw, pitch }; },
  });

  // The way in from the boat HUD. Built here, not in index.html, so the only edit to shared markup
  // that this feature needs is none.
  const btn = document.createElement('button');
  btn.id = 'btnGun';
  btn.setAttribute('aria-label', 'Take out the boat pistol');
  btn.textContent = '\u{1F52B} Pistol';
  btn.addEventListener('click', () => { toggle(); });
  $('scorebox')?.appendChild(btn);

  // ------------------------------------------------------------------ debug (verification only)
  (window as unknown as { __handgunDebug?: unknown }).__handgunDebug = {
    mode: () => mode,
    draw, holster, toggle,
    /** Force the mode flip to be applied now rather than at the end of the next frame. */
    sync: syncMode,
    fire: pull,
    reload,
    flare,
    flares: () => flares.active(),
    flareCount: () => countOf(deps.gear.inventory(), FLARE_KEY),
    holdFlash(v: boolean) { vm.holdFlash(v); },
    setLook(yaw: number, pitch: number) { look.yaw = yaw; look.pitch = pitch; },
    /** Point the crosshair at a world position, exactly (the scripted-drag aim does not converge at this frame rate). */
    aimAt(x: number, y: number, z: number) {
      const eye = camera.getWorldPosition(new THREE.Vector3());
      const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z;
      look.yaw = Math.atan2(-dx, -dz);
      look.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      // Apply it to the camera NOW. In play the camera follows `look` once a frame, and a click
      // is always a frame behind a drag, which is how a person aims; a script that sets the aim and
      // fires in the same call would otherwise shoot along last frame's view (which is exactly how the
      // first bird/Caelen measurements here came out 0 for 13, with nothing wrong in the gun).
      camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
      camera.updateMatrixWorld(true);
      return { yaw: look.yaw, pitch: look.pitch };
    },
    state() {
      const eye = camera.getWorldPosition(new THREE.Vector3());
      return {
        mode, prevMode, mag: gun.mag, reserve: reserve(), carried: carried(), magSize: magSize(), reloading: gun.reloading, reloadT: +gun.reloadT.toFixed(2),
        heat: +gun.heat.toFixed(2), flights: flights.length, spooks: spooks.map((s) => ({ x: +s.x.toFixed(1), z: +s.z.toFixed(1), ttl: +s.ttl.toFixed(1) })),
        tally: { ...tally }, floaters: floaters.states(), casings: brass.count(), blood: blood.active(),
        look: { yaw: +look.yaw.toFixed(3), pitch: +look.pitch.toFixed(3) }, eye: { x: +eye.x.toFixed(2), y: +eye.y.toFixed(2), z: +eye.z.toFixed(2) },
        camera: { near: camera.near, far: camera.far, fov: +camera.fov.toFixed(1) },
        vmVisible: vm.group.visible, hudVisible: !$('gunHud')?.classList.contains('hidden'),
        boatHud: { gauges: !$('gauges')?.classList.contains('hidden'), mapbox: !$('mapbox')?.classList.contains('hidden'), scorebox: !$('scorebox')?.classList.contains('hidden') },
        boatCam: { yaw: +deps.camState.yaw.toFixed(3), pitchOff: +deps.camState.pitchOff.toFixed(3), zoom: deps.camState.zoom, dYaw: +deps.fpState.dYaw.toFixed(3), dPitch: +deps.fpState.dPitch.toFixed(3), view: deps.fpState.view, pref: deps.fpState.pref, on: deps.fpState.on, driveOn: deps.fpState.driveOn, dragging: deps.camState.dragging },
        snapshot: !!snap,
      };
    },
    /** Birds currently tracked as targets (drawn and within range), with world positions. */
    birds() { refreshBirds(simNow, true); return [...tracked.values()].map((b) => ({ kind: b.kind, x: +b.x.toFixed(1), y: +b.y.toFixed(1), z: +b.z.toFixed(1), fleeing: !!b.B.flee })); },
    fish(radius = 40) {
      const eye = camera.getWorldPosition(new THREE.Vector3());
      return deps.fishWorld.spearTargetsNear(eye.x, eye.y, eye.z, radius).filter((f) => f.catchable !== false).map((f) => {
        const cx = (f.ax + f.bx) / 2, cy = (f.ay + f.by) / 2, cz = (f.az + f.bz) / 2;
        return { id: f.id, key: f.key, x: +cx.toFixed(2), y: +cy.toFixed(2), z: +cz.toFixed(2), r: +f.radius.toFixed(2), surf: +surfaceY(cx, cz).toFixed(2), d: +Math.hypot(cx - eye.x, cy - eye.y, cz - eye.z).toFixed(1) };
      });
    },
    /** Drops a stationary synthetic target in front of the camera so a hit can be asserted
     * deterministically: a fish 0.5 m under the surface, or a gull. Returns where it put it. */
    synth(kind: 'fish' | 'bird', dist = 5, key = 'yellowtail') {
      const eye = camera.getWorldPosition(new THREE.Vector3());
      const fx = -Math.sin(look.yaw), fz = -Math.cos(look.yaw);
      const x = eye.x + fx * dist, z = eye.z + fz * dist;
      const id = `synthetic-${kind}-${synth.length}`;
      if (kind === 'fish') {
        const y = surfaceY(x, z) - 0.5;
        synth.push({ info: { kind: 'synthetic-fish', key, weight: 3 }, t: { id, ax: x - fx * 0.3, ay: y, az: z - fz * 0.3, bx: x + fx * 0.3, by: y, bz: z + fz * 0.3, radius: 0.18 } });
        return { id, x, y, z };
      }
      const y = eye.y + 3;
      synth.push({ info: { kind: 'synthetic-bird', key: 'gull', weight: 0, birdKind: 'gull' }, t: { id, ax: x - 0.3, ay: y, az: z, bx: x + 0.3, by: y, bz: z, radius: 0.5 } });
      return { id, x, y, z };
    },
    clearSynth() { synth.length = 0; floaters.clear(); blood.clear(); flares.clear(); },
    giveRounds(n: number) {
      let inv = deps.gear.inventory();
      inv = { ...inv, consumables: { ...inv.consumables, [AMMO_KEY]: (inv.consumables[AMMO_KEY] ?? 0) + n } };
      deps.gear.commit(inv);
    },
    setRounds(n: number) {
      const inv = deps.gear.inventory();
      deps.gear.commit({ ...inv, consumables: { ...inv.consumables, [AMMO_KEY]: n } });
    },
  };
  return {
    get mode() { return mode; },
    draw, holster, toggle, step, syncMode, updateCamera, update,
    activeSpooks: () => spooks,
    exitToBoat: holster,
    dispose() {
      unbind(); vm.dispose(); brass.dispose(); streaks.dispose(); floaters.dispose(); blood.dispose(); flares.dispose(); hud.dispose(); btn.remove();
    },
  };
}
