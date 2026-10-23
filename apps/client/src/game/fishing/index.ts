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

export { F, lineOut, fishingActive } from './state.js';
export type { LandedFish } from './update.js';

export interface FishingSystemDeps {
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
}

export interface FishingSystem {
  update(dt: number, t: number, boat: BoatState, sw: number, ch: number): void;
  render(t: number, boat: BoatState, sw: number, ch: number): void;
  setDrag(v: number): void;
  reelIn(msg?: string): void;
  /** Returns the rod to idle after a catch card is dismissed — see update.ts's `clearCaught`. */
  clearCaught(): void;
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
  const logic = createFishingLogic({
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
  });
  const unbindInput = bindFishingInput(logic, deps.fp, deps.getBoat, deps.isSuspended);

  function update(dt: number, t: number, boat: BoatState, sw: number, ch: number): void {
    logic.update(dt, t, boat, sw, ch);
    rodVM.update(dt, deps.fp.on, F.reeling, logic.actionInput.held, deps.getModel());
  }

  function render(t: number, boat: BoatState, sw: number, ch: number): void {
    if (!lineOut()) { visuals.fishLine.visible = false; deps.getModel().rodPivot.visible = fishingActive() && !deps.fp.on; return; }
    deps.getModel().rodPivot.visible = fishingActive() && !deps.fp.on;
    const model = deps.getModel();
    rodVM.lineTip(model, deps.fp.on).getWorldPosition(tipWorld);
    visuals.drawLine(t, boat, sw, ch, tipWorld);
  }

  function dispose(): void {
    unbindInput();
    visuals.dispose();
  }

  return { update, render, setDrag: logic.setDrag, reelIn: logic.reelIn, clearCaught: logic.clearCaught, setHook: logic.setHook, dispose };
}

const tipWorld = new THREE.Vector3();
