/**
 * Land controller: the state machine for "I tied up and stepped onto the dock", with no rendering
 * in it. Peer of entities/diver/controller.ts — same shape (`mode`, `enter…`, `exitToBoat`,
 * `step`), same promise: every way in has a way out, and nothing in between can leave the player
 * somewhere they cannot get back from.
 *
 * ## Entering (`tryEnter`)
 * Refuses, with a reason the HUD can show, unless ALL of these hold:
 *   - the hull is lying alongside a dock (`findBerth` within `hullLen/2 + 9` m of the boat) —
 *     a marina's, or the dock on one of your own Keys Run Estates lots (`deps.estates`);
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
import { findBerth, groundAt, COLLIDERS, type Rect } from '@keysrun/shared/world/town';
import { estateDockBerth, estateGround, type Parcel, type SiteLayout } from '@keysrun/shared/content/estates';
import { createLandButtons, bindLandInput, type LandButtons, type LandActions } from './input.js';
import { createLandCamState, bindLandPointerControls, type LandCamState } from './camera.js';

export type LandMode = 'boat' | 'land';

/** Slowest the boat may be moving to step off, in sim speed units (same as the dock weigh-in). */
export const TIE_UP_MAX_SPEED = 2.5;
export const BOARD_REACH = 9;
const CAB_WINDOW = 3.5;

export const WALK_ENV: WalkerEnv = { ground: groundAt, colliders: COLLIDERS };

/** A lot of yours you may walk on and tie up at (Keys Run Estates). */
export interface WalkableEstate { parcel: Parcel; layout: SiteLayout }

/**
 * The town's walk surface plus your own estates': their dry ground, their dock and its ramp
 * (shared `estateGround`). The house itself is solid — a square the size of its short side, so a
 * turned house still never blocks the dock path that runs out past its corner.
 */
function estateWalkEnv(list: readonly WalkableEstate[]): WalkerEnv {
  if (!list.length) return WALK_ENV;
  const colliders: Rect[] = [...COLLIDERS];
  for (const e of list) {
    const h = e.layout.house, r = Math.min(h.w, h.d) / 2;
    if (e.parcel.tier !== 'harbor') colliders.push({ x0: h.x - r, x1: h.x + r, z0: h.z - r, z1: h.z + r });
  }
  return {
    ground: (x, z) => {
      const g = groundAt(x, z);
      if (g !== null) return g;
      for (const e of list) { const eg = estateGround(e.parcel, e.layout, x, z); if (eg !== null) return eg; }
      return null;
    },
    colliders,
  };
}

export interface Mooring {
  /** The marina's name, or the estate's lot name when tied up at your own dock. */
  marina: string;
  /** Set when tied up at one of your estates: its parcel id. */
  estate?: string;
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

export function createLandController(deps: { canvas: HTMLCanvasElement; estates?: () => readonly WalkableEstate[] }): LandController {
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
  let envList: readonly WalkableEstate[] = [];
  let env: WalkerEnv = WALK_ENV;
  /** Re-derived only when the estate list itself changes (the registry hands out a new array). */
  function walkEnv(): WalkerEnv {
    const list = deps.estates?.() ?? [];
    if (list !== envList) { envList = list; env = estateWalkEnv(list); }
    return env;
  }

  type Berth = { name: string; estate?: string; x: number; z: number };
  function nearestBerth(x: number, z: number, reach: number): Berth | null {
    const m = findBerth(x, z, reach);
    let best: (Berth & { dist: number }) | null = m ? { name: m.marina.name, x: m.x, z: m.z, dist: m.dist } : null;
    for (const e of deps.estates?.() ?? []) {
      const b = estateDockBerth(e.layout, x, z, reach);
      if (b && (!best || b.dist < best.dist)) best = { name: e.parcel.name, estate: e.parcel.id, x: b.x, z: b.z, dist: b.dist };
    }
    return best;
  }

  function check(boat: { x: number; z: number; speed: number }, hullLen: number): EnterResult & { berth?: Berth } {
    if (Math.abs(boat.speed) > TIE_UP_MAX_SPEED) return { ok: false, reason: 'Slow down to tie up at the dock.' };
    const berth = nearestBerth(boat.x, boat.z, hullLen / 2 + 9);
    if (!berth) return { ok: false, reason: 'Pull alongside a dock to tie up.' };
    const e = walkEnv();
    if (!canStand(e, berth.x, berth.z, e.ground(berth.x, berth.z) ?? 0)) return { ok: false, reason: 'Nowhere safe to step off here — try the pier.' };
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
      state = createWalkerState(b.x, b.z, yaw, walkEnv());
      cam.yaw = yaw; cam.pitch = -0.08; cam.dragging = false;
      mooring = { marina: b.name, estate: b.estate, dockX: b.x, dockZ: b.z, boatX: boat.x, boatZ: boat.z, boatH: boat.h, hullLen };
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
        state = createWalkerState(mooring.dockX, mooring.dockZ, state.yaw, walkEnv());
        farPressedAt = -Infinity;
        return 'cab';
      }
      farPressedAt = clock;
      return 'far';
    },

    exitToBoat(): void { leave(); },

    debugPlace(x, z, yaw): boolean {
      if (mode !== 'land' || !state) return false;
      const e = walkEnv();
      const g = e.ground(x, z);
      if (g === null || !canStand(e, x, z, g)) return false;
      state = createWalkerState(x, z, yaw ?? state.yaw, e);
      if (yaw !== undefined) cam.yaw = yaw;
      return true;
    },

    step(dt, frozen): void {
      clock += dt;
      if (mode !== 'land' || !state) return;
      cam.yaw -= buttons.turn * dt * 1.9;
      const idle = { fwd: false, back: false, left: false, right: false, sprint: false };
      const i = frozen ? idle : buttons;
      state = stepWalker(state, { fwd: i.fwd, back: i.back, left: i.left, right: i.right, sprint: i.sprint, lookYaw: cam.yaw }, walkEnv(), dt);
    },

    bind(a): void { actions = a; },

    dispose(): void { leave(); },
  };
}
