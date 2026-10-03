/**
 * Explicit no-op stand-ins for every system that is out of Phase 0 scope per
 * docs/ARCHITECTURE.md / the task brief, but that in-scope legacy code (electronics, HUD,
 * minimap, camera, input) still reads. Each is named after its legacy global so the diff
 * against legacy/index.html stays obvious. Grepping this repo for `TODO(phase-0b)` finds every
 * one of these call sites.
 *
 * Nothing here is a design decision — it's a placeholder a later phase deletes wholesale when
 * that system actually lands (fish/fishing: phase 3+; multiplayer/leaderboard: phase 2+/3).
 *
 * RIGS/WEEDS/hotspots/BUDDY/TRAFFIC/RACERS are **no longer stubs** — they're real now
 * (`entities/life/hotspots.ts`, `entities/life/buddy.ts`, `entities/life/traffic.ts`,
 * `entities/life/racers.ts`). `entities/boat/electronics.ts`'s sonar-trace loops over these
 * (currently inert `.forEach(() => {})`/`BUDDY.on&&BUDDY.model` placeholders of their own, not
 * this task's to flesh out) still import them *by this name*, so rather than rewire that file's
 * import line — outside this task's ownership — `installWorldLife` below lets `game/world.ts`
 * swap live references in once, right after building the real systems.
 */

export let RIGS: ReadonlyArray<unknown> = [];
export let WEEDS: ReadonlyArray<unknown> = [];
export let hotspots: ReadonlyArray<unknown> = [];
export let TRAFFIC: ReadonlyArray<unknown> = [];
export let RACERS: ReadonlyArray<unknown> = [];
export const BUDDY: { on: boolean; model: unknown; x: number; z: number } = { on: false, model: null, x: 0, z: 0 };

/** Called once by `game/world.ts` right after `entities/life/**`'s world-life factories are
 * built. `BUDDY` is a stable object `game/world.ts` keeps mutating in place (`.on` toggles at
 * runtime); the arrays are one-time snapshots since each one's *membership* is fixed after
 * construction (only the individual sites'/boats' own position state mutates in place). */
export function installWorldLife(life: {
  rigs: ReadonlyArray<unknown>; weeds: ReadonlyArray<unknown>; hotspots: ReadonlyArray<unknown>;
  traffic: ReadonlyArray<unknown>; racers: ReadonlyArray<unknown>;
}): void {
  RIGS = life.rigs; WEEDS = life.weeds; hotspots = life.hotspots; TRAFFIC = life.traffic; RACERS = life.racers;
}

// TODO(phase-0b): fish schools (legacy `groups`) — tracked by the sonar/minimap.
export const groups: never[] = [];

// TODO: multiplayer ghosts (legacy `MP.ghosts`).
export const MP = { ghosts: [] as never[] };

/**
 * TODO(phase-3): rod fishing state machine (legacy `F`). Always `idle`/inactive in Phase 0 —
 * nothing in this port ever transitions it, so every branch gated on `F.state!=='idle'`
 * elsewhere in legacy is dead code here and was dropped at the call site rather than ported.
 */
export type FishFightState = 'idle' | 'casting' | 'waiting' | 'nibble' | 'bite' | 'fight' | 'caught';
export const F: {
  state: FishFightState;
  bob: { x: number; y: number; z: number };
  fx: number; fz: number;
  running: boolean;
  charging: boolean;
  drag: number;
  caughtT: number;
} = {
  state: 'idle',
  bob: { x: 0, y: 0, z: 0 },
  fx: 0, fz: 0,
  running: false,
  charging: false,
  drag: 3,
  caughtT: 0,
};

/** legacy `lineOut()` / `fishingActive()` — both always false with no fishing state machine. */
export const lineOut = (): boolean => false;
export const fishingActive = (): boolean => false;
