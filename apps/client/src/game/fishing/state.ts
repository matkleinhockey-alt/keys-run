/**
 * The rod-fishing state machine's data (legacy `F`, index.html:2628) — ported to a plain TS
 * object instead of mixing in `THREE.Vector3`/species refs, so the fight-critical numeric
 * fields can live in `@keysrun/shared/sim/fight`'s `FightState` (see update.ts) while this
 * object keeps everything presentation/UI needs: casting, waiting/nibble/bite timers, drag,
 * and a few fields mirrored from `FightState` each tick (`fx`/`fz`) purely so
 * entities/camera.ts's existing `F.fx`/`F.fz`/`F.bob`/`F.state`/`F.charging` reads (wired back
 * in Phase 0b against the stubs in src/stubs.ts) keep working unchanged.
 */
import type { FightState, FightParams } from '@keysrun/shared/sim/fight';
import type { SpeciesDef } from '@keysrun/shared/content/species';

export type FishFightState = 'idle' | 'casting' | 'waiting' | 'nibble' | 'bite' | 'fight' | 'caught';

export interface Vec3Like { x: number; y: number; z: number }

export interface FishingState {
  state: FishFightState;
  /** The bobber/bait position (legacy `F.bob`). */
  bob: Vec3Like;
  from: Vec3Like;
  to: Vec3Like;
  castT: number;
  castDur: number;
  castH: number;
  biteT: number;
  win: number;
  zone: string;
  /** legacy `F.hs` — a hotspot/weedline/rig reference. Always null until those systems land
   * (src/stubs.ts's RIGS/WEEDS/hotspots); kept so that code reads the same shape either way. */
  hs: { fr?: number } | null;
  sp: SpeciesDef | null;
  key: string | null;
  weight: number;
  /** Mirrors the active `FightState.x/z` once hooked — camera.ts reads these directly. */
  fx: number;
  fz: number;
  /** legacy `F.ofx`/`F.ofz` — the fish's station-keeping offset from the bobber pre-hookset. */
  ofx: number;
  ofz: number;
  drag: number;
  charging: boolean;
  charge: number;
  chargeT: number;
  nibs: number;
  nibT: number;
  dipT: number;
  reeling: boolean;
  caughtT: number;
  lastPts: number;
  lastStats: { inches: number; sex: string } | null;
  /** Non-null exactly while state is 'fight'. */
  fight: FightState | null;
  fightParams: FightParams | null;
}

export function createFishingState(): FishingState {
  return {
    state: 'idle',
    bob: { x: 0, y: 0, z: 0 }, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 },
    castT: 0, castDur: 0.7, castH: 10,
    biteT: 0, win: 0,
    zone: '', hs: null, sp: null, key: null, weight: 0,
    fx: 0, fz: 0, ofx: 0, ofz: 0,
    drag: 3,
    charging: false, charge: 0, chargeT: 0,
    nibs: 0, nibT: 0, dipT: 0,
    reeling: false,
    caughtT: 0, lastPts: 0, lastStats: null,
    fight: null, fightParams: null,
  };
}

const LINE_STATES: readonly FishFightState[] = ['casting', 'waiting', 'nibble', 'bite', 'fight'];

/** The single live fishing-rod state for the local player (legacy's module-level `F`). A
 * singleton, matching this codebase's existing convention for this kind of per-player session
 * state (see src/stubs.ts's `F`/`BUDDY`/`MP`, src/state/game.ts) — entities/camera.ts imports
 * this exact binding. */
export const F: FishingState = createFishingState();

/** legacy `lineOut()` (index.html:2634) — zero-arg, reading the singleton `F` above, so
 * entities/camera.ts's existing call sites need only a new import path, not new arguments. */
export function lineOut(): boolean {
  return LINE_STATES.includes(F.state);
}

/** legacy `fishingActive()` (index.html:2635). */
export function fishingActive(): boolean {
  return F.charging || lineOut();
}
