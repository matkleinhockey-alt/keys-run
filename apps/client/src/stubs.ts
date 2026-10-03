/**
 * Explicit no-op stand-ins for every system that is out of Phase 0 scope per
 * docs/ARCHITECTURE.md / the task brief, but that in-scope legacy code (electronics, HUD,
 * minimap, camera, input) still reads. Each is named after its legacy global so the diff
 * against legacy/index.html stays obvious. Grepping this repo for `TODO(phase-0b)` finds every
 * one of these call sites.
 *
 * Nothing here is a design decision — it's a placeholder a later phase deletes wholesale when
 * that system actually lands (fish/fishing: phase 3+; humans/traffic/racers/buddy/Luigi/Caelen/
 * deck party: unscheduled; Miami/oil rigs/weedlines/hotspots: unscheduled; multiplayer/
 * leaderboard: phase 2+/3).
 */

// TODO(phase-0b): fish — oil rigs, weedlines, bird/fish hotspots (legacy RIGS/WEEDS/hotspots).
export const RIGS: never[] = [];
export const WEEDS: never[] = [];
export const hotspots: never[] = [];

// TODO(phase-0b): fish schools (legacy `groups`) — tracked by the sonar/minimap.
export const groups: never[] = [];

// TODO: fishing buddy NPC boat (legacy `BUDDY`).
export const BUDDY = { on: false, model: null as null, x: 0, z: 0 };

// TODO: ambient traffic and racer boats (legacy `TRAFFIC`/`RACERS`).
export const TRAFFIC: never[] = [];
export const RACERS: never[] = [];

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
