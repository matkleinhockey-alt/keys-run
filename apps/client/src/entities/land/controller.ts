/**
 * Land controller: the state machine for "I tied up and stepped onto the dock", with no rendering
 * in it. Peer of entities/diver/controller.ts — same shape (`mode`, `enter…`, `exitToBoat`,
 * `step`), same promise: every way in has a way out, and nothing in between can leave the player
 * somewhere they cannot get back from.
 *
 * ## Entering (`tryEnter`)
 * Refuses, with a reason the HUD can show, unless ALL of these hold:
 *   - the hull is lying alongside a dock (`findBerth` within `hullLen/2 + 9` m of the boat);
 *   - the boat is nearly stopped (the same 2.5 threshold the dock weigh-in uses, game/catch);
 *   - there is somewhere safe to put a person (`canStand` at the berth point).
 * It places the walker on the planks nearest the boat and records the mooring: the boat's exact
 * x/z/heading, which `holdBoat` re-applies every tick so a tied-up boat does not wander off on the
 * current while you are in a bar.
 *
 * ## Leaving
 * `board()` needs you within `BOARD_REACH` of the boat (or of the plank you stepped off from) and
 * says how far away and which way if you are not. Walk far and it gets easier, not harder: press B
 * twice within `CAB_WINDOW` seconds and a cab takes you back to the dock ("refuse to strand the
 * player"). `exitToBoat()` is the unconditional version for edge cases outside the normal flow
 * (switching boats, returning to the marina screen) — it always works.
 *
 * ## What it does not own
 * The camera save/restore, HUD swaps and the boat-pinning live in the facade (entities/land/
 * index.ts) because they touch the scene and world.ts's boat state; this file is the part a server
 * could one day run.
 */
import { createWalkerState, stepWalker, canStand, type WalkerState, type WalkerEnv } from '@keysrun/shared/sim/walker';
import { findBerth, groundAt, COLLIDERS } from '@keysrun/shared/world/town';
import { createLandButtons, bindLandInput, type LandButtons, type LandActions } from './input.js';
import { createLandCamState, bindLandPointerControls, type LandCamState } from './camera.js';

export type LandMode = 'boat' | 'land';

/** Slowest the boat may be moving to step off, in sim speed units (same as the dock weigh-in). */
export const TIE_UP_MAX_SPEED = 2.5;
export const BOARD_REACH = 9;
const CAB_WINDOW = 3.5;

export const WALK_ENV: WalkerEnv = { ground: groundAt, colliders: COLLIDERS };

export interface Mooring {
  marina: string;
  /** Where you stepped off: the plank nearest the hull. */
  dockX: number; dockZ: number;
  /** Where the boat is held. */
  boatX: number; boatZ: number; boatH: number;
  hullLen: number;
}

export type EnterResult = { ok: true } | { ok: false; reason: string };

export interface LandController {
  readonly mode: LandMode;
  readonly state: WalkerState | null;
  readonly cam: LandCamState;
  readonly buttons: LandButtons;
  readonly mooring: Mooring | null;
  /** Would `tryEnter` succeed right now, and if not, why not. Pure: used for the dock prompt. */
  canTieUp(boat: { x: number; z: number; speed: number }, hullLen: number): EnterResult;
  tryEnter(boat: { x: number; z: number; h: number; speed: number }, hullLen: number): EnterResult;
  /** Distance to the nearest boarding point (boat or the plank you left it from), metres. */
  boardDistance(): number;
  /** Compass-ish bearing text from the player to the boat, e.g. "NE". */
  boatBearing(): string;
  /** Try to climb aboard. 'cab' = you were far away and asked twice; the walker is now at the dock. */
  board(): 'boarded' | 'far' | 'cab' | 'idle';
  exitToBoat(): void;
  /** VERIFICATION-ONLY: put the walker somewhere (refuses unwalkable spots). */
  debugPlace(x: number, z: number, yaw?: number): boolean;
  step(dt: number, frozen: boolean): void;
  bind(actions: LandActions): void;
  dispose(): void;
}

export function createLandController(deps: { canvas: HTMLCanvasElement }): LandController {
  const buttons = createLandButtons();
  const cam = createLandCamState();
  let unbindInput: (() => void) | null = null;
  let unbindPointer: (() => void) | null = null;
  let actions: LandActions | null = null;
  let mode: LandMode = 'boat';
  let state: WalkerState | null = null;
  let mooring: Mooring | null = null;
  let farPressedAt = -Infinity;
  let clock = 0;

  function check(boat: { x: number; z: number; speed: number }, hullLen: number): EnterResult & { berth?: ReturnType<typeof findBerth> } {
    if (Math.abs(boat.speed) > TIE_UP_MAX_SPEED) return { ok: false, reason: 'Slow down to tie up at the dock.' };
    const berth = findBerth(boat.x, boat.z, hullLen / 2 + 9);
    if (!berth) return { ok: false, reason: 'Pull alongside a dock to tie up.' };
    if (!canStand(WALK_ENV, berth.x, berth.z, groundAt(berth.x, berth.z) ?? 0)) return { ok: false, reason: 'Nowhere safe to step off here — try the pier.' };
    return { ok: true, berth };
  }

  function leave(): void {
    mode = 'boat';
    state = null;
    mooring = null;
    farPressedAt = -Infinity;
    unbindInput?.(); unbindInput = null;
    unbindPointer?.(); unbindPointer = null;
  }

  return {
    get mode() { return mode; },
    get state() { return state; },
    get cam() { return cam; },
    get buttons() { return buttons; },
    get mooring() { return mooring; },

    canTieUp(boat, hullLen) { const r = check(boat, hullLen); return r.ok ? { ok: true } : r; },

    tryEnter(boat, hullLen): EnterResult {
      if (mode === 'land') return { ok: false, reason: 'Already ashore.' };
      const r = check(boat, hullLen);
      if (!r.ok || !r.berth) return r.ok ? { ok: false, reason: 'No berth.' } : r;
      const b = r.berth;
      // face from the hull toward the plank, so the first thing you see is where you are going
      const dx = b.x - boat.x, dz = b.z - boat.z;
      const yaw = Math.hypot(dx, dz) > 0.5 ? Math.atan2(-dx, -dz) : boat.h;
      state = createWalkerState(b.x, b.z, yaw, WALK_ENV);
      cam.yaw = yaw; cam.pitch = -0.08; cam.dragging = false;
      mooring = { marina: b.marina.name, dockX: b.x, dockZ: b.z, boatX: boat.x, boatZ: boat.z, boatH: boat.h, hullLen };
      mode = 'land';
      farPressedAt = -Infinity;
      if (actions) unbindInput = bindLandInput(buttons, actions, () => mode === 'land');
      unbindPointer = bindLandPointerControls(deps.canvas, cam, () => mode === 'land');
      return { ok: true };
    },

    boardDistance(): number {
      if (!state || !mooring) return Infinity;
      const toBoat = Math.hypot(state.x - mooring.boatX, state.z - mooring.boatZ) - mooring.hullLen / 2;
      const toDock = Math.hypot(state.x - mooring.dockX, state.z - mooring.dockZ);
      return Math.max(0, Math.min(toBoat, toDock));
    },

    boatBearing(): string {
      if (!state || !mooring) return '';
      // x east, z south in this world (north is -z)
      const a = Math.atan2(mooring.boatX - state.x, -(mooring.boatZ - state.z)); // 0 = north, clockwise
      const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      return names[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
    },

    board(): 'boarded' | 'far' | 'cab' | 'idle' {
      if (mode !== 'land' || !state || !mooring) return 'idle';
      if (this.boardDistance() <= BOARD_REACH) { leave(); return 'boarded'; }
      if (clock - farPressedAt <= CAB_WINDOW) {
        // The cab: back to the plank you stepped off from. Always walkable by construction (it was
        // validated on the way in), so this cannot itself strand you.
        state = createWalkerState(mooring.dockX, mooring.dockZ, state.yaw, WALK_ENV);
        farPressedAt = -Infinity;
        return 'cab';
      }
      farPressedAt = clock;
      return 'far';
    },

    exitToBoat(): void { leave(); },

    debugPlace(x, z, yaw): boolean {
      if (mode !== 'land' || !state) return false;
      const g = groundAt(x, z);
      if (g === null || !canStand(WALK_ENV, x, z, g)) return false;
      state = createWalkerState(x, z, yaw ?? state.yaw, WALK_ENV);
      if (yaw !== undefined) cam.yaw = yaw;
      return true;
    },

    step(dt, frozen): void {
      clock += dt;
      if (mode !== 'land' || !state) return;
      cam.yaw -= buttons.turn * dt * 1.9;
      const idle = { fwd: false, back: false, left: false, right: false, sprint: false };
      const i = frozen ? idle : buttons;
      state = stepWalker(state, { fwd: i.fwd, back: i.back, left: i.left, right: i.right, sprint: i.sprint, lookYaw: cam.yaw }, WALK_ENV, dt);
    },

    bind(a): void { actions = a; },

    dispose(): void { leave(); },
  };
}
