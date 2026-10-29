/**
 * Assembles rod fishing: visuals (hooked fish/line/bobber), the first-person rod view model, the
 * state machine (update.ts), and input. `game/world.ts` calls `fishing.update(...)` once per
 * fixed step and `fishing.render(t, boat, sw, ch)` once per frame (drawing the line needs the
 * rod tip's *rendered* world transform, same cadence as legacy's `drawLine`).
 */
import * as THREE from 'three';
import type { BoatModel } from '../../entities/boat/model.js';
import type { BoatState, BoatInput } from '@keysrun/shared/sim/boat';
import type { ParticleSystem } from '../../world/particles.js';
import type { CamState, FpState } from '../../entities/camera.js';
import { createFishingVisuals } from './visuals.js';
import { createRodViewModel } from './rod-viewmodel.js';
import { createFishingLogic, type FishingDeps, type LandedFish } from './update.js';
import { bindFishingInput } from './input.js';
import { F, lineOut, fishingActive } from './state.js';
import { NO_SPOTS, type SpotQuery } from './spot.js';
import type { Human } from '../../entities/life/human.js';
import { shoreBoat, type ShoreAngler, type ShoreSpot } from './shore.js';
import { createShoreRod } from './shore-rod.js';

export { F, lineOut, fishingActive } from './state.js';
export type { LandedFish } from './update.js';

export interface FishingSystemDeps {
  /** See FishingDeps.onHookset — the fish-cam trigger. */
  onHookset?(x: number, z: number): void;
  scene: THREE.Scene;
  camera: THREE.Camera;
  getModel(): BoatModel;
  fp: FpState;
  camState: CamState;
  particles: ParticleSystem;
  boatInput: BoatInput;
  getBoat(): BoatState;
  /** Player inventory port — see update.ts's `FishingDeps.gear`. */
  gear?: FishingDeps['gear'];
  /** Equipped outfit; omitted = the starter rung. */
  getTackle?: FishingDeps['getTackle'];
  /** Frenzy/weedline/rig lookup (life.spots); omitted by harnesses with no life systems. */
  spots?: SpotQuery;
  onLanded(fish: LandedFish): void;
  onActionWhileCaught(): void;
  /** Tag-and-release registry — see update.ts's `FishingDeps.tags`. */
  tags?: FishingDeps['tags'];
  /** True while the fishing Space/cast input should be ignored (game/world.ts passes
   * `diver.mode === 'diver'` — Space doubles as the diver's ascend key, and this module's
   * window-level listener has no idea diving exists; see input.ts's `isSuspended` doc comment). */
  isSuspended?(): boolean;
  /** Hand steadiness / sway for the strike window (game/buffs.ts `mods`). */
  getModifiers?: FishingDeps['getModifiers'];
  /**
   * Fishing off a pier, a private dock or a marina's planks (shore.ts). Omitted = only ever from
   * the boat. While `spot()` is non-null the state machine is handed a stand-in boat at the
   * walker's feet, the line hangs from a rod in the walking body's hands, and stepping off the
   * deck (or back aboard) with a line out reels it in.
   */
  shore?: {
    /** Where the walker stands on a fishable deck — `LandSystem.fishSpot()`; null aboard or on dry land. */
    spot(): ShoreSpot | null;
    /** The land camera is first-person. */
    firstPerson(): boolean;
    /** The walking body, to put the rod in its hands; null while there is none. */
    body(): Human | null;
  };
}

export interface FishingSystem {
  update(dt: number, t: number, boat: BoatState, sw: number, ch: number): void;
  render(t: number, boat: BoatState, sw: number, ch: number): void;
  setDrag(v: number): void;
  reelIn(msg?: string): void;
  /** Returns the rod to idle after a catch card is dismissed — see update.ts's `clearCaught`. */
  clearCaught(): void;
  /** The cast/strike button, pressed or released — for a touch control that is not `#tAct` (the
   * land pad's, entities/land/hud.ts). Same as Space. */
  action(down: boolean): void;
  /**
   * Set the hook on whatever `F` is currently holding, exactly as hitting the strike window does.
   *
   * Exposed for trolling (game/fishing/trolling.ts), which has no cast and no strike window: the
   * fish hooks itself against the drag at seven knots. Everything after this point — the fight,
   * the drag, the jumps, the catch card — is then the machinery that already exists, rather than
   * a second fight to keep in step with the first.
   */
  setHook(): void;
  dispose(): void;
}

export function createFishing(deps: FishingSystemDeps): FishingSystem {
  const visuals = createFishingVisuals(deps.scene);
  const rodVM = createRodViewModel(deps.camera);
  const shoreRod = createShoreRod();
  function getShore(): ShoreAngler | null {
    const spot = deps.shore?.spot() ?? null;
    return spot ? { spot, rod: shoreRod, firstPerson: deps.shore!.firstPerson() } : null;
  }
  /** The boat as fishing sees it: the real one, or the stand-in at the angler's feet ashore. */
  const fishingBoat = (boat: BoatState): BoatState => { const s = getShore(); return s ? shoreBoat(boat, s.spot) : boat; };
  const logic = createFishingLogic({
    onHookset: deps.onHookset,
    scene: deps.scene,
    getModel: deps.getModel,
    camera: deps.camera,
    fp: deps.fp,
    camState: deps.camState,
    visuals,
    rodVM,
    particles: deps.particles,
    boatInput: deps.boatInput,
    spots: deps.spots ?? NO_SPOTS,
    onLanded: deps.onLanded,
    onActionWhileCaught: deps.onActionWhileCaught,
    tags: deps.tags,
    getModifiers: deps.getModifiers,
    gear: deps.gear,
    getTackle: deps.getTackle,
    getShore,
  });
  const getBoat = (): BoatState => fishingBoat(deps.getBoat());
  // V is the land camera's own first/third toggle ashore (entities/land/input.ts); only the boat's
  // fishing view answers it here.
  const unbindInput = bindFishingInput(logic, deps.fp, getBoat, deps.isSuspended, () => !deps.shore?.spot());

  /** Whether the last step was fished from a deck: leaving one with a line out reels it in. */
  let wasAshore = false;
  function update(dt: number, t: number, boat: BoatState, sw: number, ch: number): void {
    const shore = getShore();
    // Stepped off the planks, or back aboard, with a cast charging or a line in the water. The
    // walker stands still while a line is out (shore.ts's `shoreHoldsStill`), so this is the
    // boarding and cab paths and anything else that moves the walker for you.
    if (wasAshore && !shore && (F.charging || lineOut())) logic.reelIn('Line reeled in.');
    wasAshore = !!shore;
    logic.update(dt, t, shore ? shoreBoat(boat, shore.spot) : boat, sw, ch);
    // The boat's `fp.on` is already "fishing view AND fishing"; the land camera's first person is
    // just a camera, so the rod comes up only once there is something to do with it.
    rodVM.update(dt, shore ? shore.firstPerson && fishingActive() : deps.fp.on, F.reeling, logic.actionInput.held, shore ? shoreRod : deps.getModel());
  }

  let lastRenderT = 0;
  function render(t: number, boat: BoatState, sw: number, ch: number): void {
    const dt = Math.min(0.1, Math.max(0, t - lastRenderT));
    lastRenderT = t;
    const shore = getShore();
    const model = deps.getModel();
    model.rodPivot.visible = !shore && fishingActive() && !deps.fp.on;
    shoreRod.rodPivot.visible = !!shore && fishingActive();
    const body = shore && !shore.firstPerson && fishingActive() ? deps.shore!.body() : null;
    if (body) {
      // Face the line once it is out; while a cast is charging, face where it is about to go.
      let target: THREE.Vector3 | null = null;
      if (F.state === 'fight') target = holdAt.set(F.fx, 0, F.fz);
      else if (lineOut()) target = holdAt.set(F.bob.x, 0, F.bob.z);
      else if (F.charging) { deps.camera.getWorldDirection(holdAt); holdAt.y = 0; holdAt.normalize().multiplyScalar(10).add(body.group.position); target = holdAt; }
      shoreRod.hold(body, target, F.state === 'fight', F.fight ? F.fight.tension : 0, dt);
    }
    if (!lineOut()) { visuals.fishLine.visible = false; return; }
    rodVM.lineTip(shore ? shoreRod : model, shore ? shore.firstPerson : deps.fp.on).getWorldPosition(tipWorld);
    visuals.drawLine(t, shore ? shoreBoat(boat, shore.spot) : boat, sw, ch, tipWorld);
  }

  function action(down: boolean): void {
    if (deps.isSuspended?.()) { if (!down) logic.actionInput.held = false; return; }
    logic.actionInput.held = down;
    if (down) logic.onAction(getBoat()); else logic.onActionUp(getBoat());
  }

  function dispose(): void {
    unbindInput();
    visuals.dispose();
  }

  return { update, render, setDrag: logic.setDrag, reelIn: logic.reelIn, clearCaught: logic.clearCaught, setHook: logic.setHook, action, dispose };
}

const tipWorld = new THREE.Vector3();
const holdAt = new THREE.Vector3();
