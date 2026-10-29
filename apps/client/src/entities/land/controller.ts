/**
 * Land controller: the state machine for "I tied up and stepped onto the dock", with no rendering
 * in it. Peer of entities/diver/controller.ts — same shape (`mode`, `enter…`, `exitToBoat`,
 * `step`), same promise: every way in has a way out, and nothing in between can leave the player
 * somewhere they cannot get back from.
 *
 * ## Entering (`tryEnter`)
 * Refuses, with a reason the HUD can show, unless ALL of these hold:
 *   - the hull is lying alongside a dock (`nearestBerth` within `hullLen/2 + 9` m of the boat) —
 *     a marina's, a public fishing pier (shared world/piers.ts), a waterfront house's private dock
 *     (`deps.docks`), or the dock on one of your own Keys Run Estates lots (`deps.estates`);
 *   - the boat is nearly stopped (the same 2.5 threshold the dock weigh-in uses, game/catch);
 *   - there is somewhere safe to put a person (`canStand` at the berth point).
 * It places the walker on the planks nearest the boat, from where the whole key is walkable
 * (ground.ts: any dry land, the piers, the docks), and records the mooring: the boat's exact
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
import { outsideGround, dockBerth, pierBerth, fishableDeck, type WalkDock } from './ground.js';

export type LandMode = 'boat' | 'land';

/** Slowest the boat may be moving to step off, in sim speed units (same as the dock weigh-in). */
export const TIE_UP_MAX_SPEED = 2.5;
export const BOARD_REACH = 9;
const CAB_WINDOW = 3.5;

/** The town's surfaces, then everything outside it (ground.ts), with no private docks. */
export const WALK_ENV: WalkerEnv = { ground: (x, z) => groundAt(x, z) ?? outsideGround([], x, z), colliders: COLLIDERS };

/** A lot of yours you may walk on and tie up at (Keys Run Estates). */
export interface WalkableEstate { parcel: Parcel; layout: SiteLayout }

/**
 * The town's walk surface plus your own estates': their dry ground, their dock and its ramp
 * (shared `estateGround`), then the rest of the world (ground.ts). The house itself is solid — a
 * square the size of its short side, so a turned house still never blocks the dock path that runs
 * out past its corner. `solid` adds the houses and palms out on the keys.
 */
function estateWalkEnv(list: readonly WalkableEstate[], docks: readonly WalkDock[], solid: readonly Rect[]): WalkerEnv {
  const colliders: Rect[] = [...COLLIDERS, ...solid];
  for (const e of list) {
    const h = e.layout.house, r = Math.min(h.w, h.d) / 2;
    if (e.parcel.tier !== 'harbor') colliders.push({ x0: h.x - r, x1: h.x + r, z0: h.z - r, z1: h.z + r });
  }
  return {
    ground: (x, z) => {
      const g = groundAt(x, z);
      if (g !== null) return g;
      for (const e of list) { const eg = estateGround(e.parcel, e.layout, x, z); if (eg !== null) return eg; }
      return outsideGround(docks, x, z);
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
  /** Where you could fish from, standing here: the pier's or dock's name, or null on dry land. */
  fishingDeck(): string | null;
  /** VERIFICATION-ONLY: put the walker somewhere (refuses unwalkable spots). */
  debugPlace(x: number, z: number, yaw?: number): boolean;
  step(dt: number, frozen: boolean): void;
  bind(actions: LandActions): void;
  dispose(): void;
}

const NO_RECTS: readonly Rect[] = [];

export interface LandControllerDeps {
  canvas: HTMLCanvasElement;
  estates?: () => readonly WalkableEstate[];
  /** The waterfront houses' private docks. */
  docks?: readonly WalkDock[];
  /** Everything solid out on the keys (houses, palm trunks). A new array when it changes. */
  solid?: () => readonly Rect[];
}

/** Colliders bucketed by GRID_M cell, so a step only tests the few near the walker. */
const GRID_M = 32;
function gridIndex(rects: readonly Rect[]): Map<number, Rect[]> {
  const g = new Map<number, Rect[]>();
  for (const r of rects) {
    for (let cx = Math.floor(r.x0 / GRID_M); cx <= Math.floor(r.x1 / GRID_M); cx++) {
      for (let cz = Math.floor(r.z0 / GRID_M); cz <= Math.floor(r.z1 / GRID_M); cz++) {
        const k = cx * 100003 + cz;
        let b = g.get(k);
        if (!b) g.set(k, (b = []));
        b.push(r);
      }
    }
  }
  return g;
}
/** The colliders in the 3 x 3 cells round (x,z): everything a step from there can touch. */
function nearby(g: Map<number, Rect[]>, x: number, z: number): Rect[] {
  const out: Rect[] = [], cx = Math.floor(x / GRID_M), cz = Math.floor(z / GRID_M);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const b = g.get((cx + i) * 100003 + cz + j); if (b) for (const r of b) out.push(r); }
  return out;
}

export function createLandController(deps: LandControllerDeps): LandController {
  const docks = deps.docks ?? [], solid = deps.solid ?? (() => NO_RECTS);
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
  let envList: readonly WalkableEstate[] | null = null, envSolid: readonly Rect[] | null = null;
  let env: WalkerEnv = WALK_ENV, grid = new Map<number, Rect[]>();
  /** Re-derived only when the estate list or what stands on the keys changes (each a new array). */
  function walkEnv(): WalkerEnv {
    const list = deps.estates?.() ?? [], sol = solid();
    if (list !== envList || sol !== envSolid) {
      envList = list; envSolid = sol;
      env = estateWalkEnv(list, docks, sol);
      grid = gridIndex(env.colliders);
    }
    return env;
  }
  /** The environment for a step taken from (x,z): the same ground, only the colliders near it. */
  function localEnv(x: number, z: number): WalkerEnv {
    const e = walkEnv();
    return { ground: e.ground, colliders: nearby(grid, x, z) };
  }

  type Berth = { name: string; estate?: string; x: number; z: number };
  function nearestBerth(x: number, z: number, reach: number): Berth | null {
    const m = findBerth(x, z, reach);
    let best: (Berth & { dist: number }) | null = m ? { name: m.marina.name, x: m.x, z: m.z, dist: m.dist } : null;
    for (const e of deps.estates?.() ?? []) {
      const b = estateDockBerth(e.layout, x, z, reach);
      if (b && (!best || b.dist < best.dist)) best = { name: e.parcel.name, estate: e.parcel.id, x: b.x, z: b.z, dist: b.dist };
    }
    const p = pierBerth(x, z, reach);
    if (p && (!best || p.dist < best.dist)) best = { name: p.pier.name, x: p.x, z: p.z, dist: p.dist };
    const d = dockBerth(docks, x, z, reach);
    if (d && (!best || d.dist < best.dist)) best = { name: d.dock.name, x: d.x, z: d.z, dist: d.dist };
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

    fishingDeck(): string | null {
      return mode === 'land' && state ? fishableDeck(docks, state.x, state.z) : null;
    },

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
      state = stepWalker(state, { fwd: i.fwd, back: i.back, left: i.left, right: i.right, sprint: i.sprint, lookYaw: cam.yaw }, localEnv(state.x, state.z), dt);
    },

    bind(a): void { actions = a; },

    dispose(): void { leave(); },
  };
}
