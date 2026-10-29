/**
 * Rod fishing from a pier, a private dock or a marina's planks: the rules half, pure and
 * three-free so test/shore-fishing.test.ts can drive it.
 *
 * ## How the shore reuses the boat's fishing
 * The state machine (update.ts) only ever asks the "boat" three things: where it is, which way it
 * points and how fast it is going. Standing on a pier those are the angler's feet, the way they
 * face and nothing — so ashore it is handed a stand-in `BoatState` at the walker (`shoreBoat`)
 * instead of the moored hull's, and every rule downstream (cast reach, the 140 m drift limit, the
 * fight's line length, `landed` at the angler's feet, `mangrove` when the fish runs under the
 * shore) works unchanged. The real boat is pinned at its mooring the whole time
 * (entities/land/index.ts's `holdBoat`), so nothing about it needs to change.
 *
 * Bites do not care where you stand: the wait is `rand(4, 10)` s in any water and the species
 * come from the zone the bobber lands in (shared `zoneAt` / `ZONE_TABLE`), so a pier end in three
 * metres of water fishes like a skiff anchored on the same flat.
 */
import type { BoatState } from '@keysrun/shared/sim/boat';
import type { FishFightState } from './state.js';
import type { ShoreRod } from './shore-rod.js';

/** Where the walker is standing on a fishable deck — `LandSystem.fishSpot()`. */
export interface ShoreSpot {
  name: string;
  x: number; y: number; z: number;
  /** The body's facing, same convention as a boat heading: forward = (-sin yaw, -cos yaw). */
  yaw: number;
}

/** Everything fishing needs to know about an angler standing ashore (game/world.ts builds it). */
export interface ShoreAngler {
  spot: ShoreSpot;
  /** The rod in the walking body's hands (shore-rod.ts), standing in for the boat's. */
  rod: ShoreRod;
  /** The land camera is first-person: the camera-space rod (rod-viewmodel.ts) is the one in view. */
  firstPerson: boolean;
}

/**
 * The boat as fishing should see it while you stand at `spot`: the moored hull's state with the
 * pose swapped for the angler's and the speed zeroed (a pier never has way on, so "slow under 3
 * knots to cast" and "reeled in so you can run" can never fire). Everything else — the wake ring
 * the water height samples, the sea state — is the real boat's, because it is the real sea.
 */
export function shoreBoat(boat: BoatState, spot: ShoreSpot): BoatState {
  return { ...boat, x: spot.x, y: spot.y, z: spot.z, h: spot.yaw, speed: 0, dvx: 0, dvz: 0 };
}

/**
 * Whether the walker should stand still: from the moment a cast starts charging until the catch
 * card is dealt with. On the boat the rod does not stop you driving, but the boat is not walking
 * on S — ashore the reel key IS a walking key (entities/boat/input.ts maps S/▼ to `back`, which
 * update.ts reads as "reel"), so a free walker would back off the end of the pier every time you
 * cranked. R reels in, and then you can walk.
 */
export function shoreHoldsStill(state: FishFightState, charging: boolean): boolean {
  return charging || state !== 'idle';
}

/**
 * The land HUD's prompt while standing somewhere fishable, in its "KEY  text" form
 * (entities/land/hud.ts splits on the double space). Null when the fishing HUD already says what
 * to do (the cast meter, the strike flash, the fight panel, the catch card).
 */
export function shorePrompt(state: FishFightState, charging: boolean, deck: string): string | null {
  if (charging) return null;
  if (state === 'idle') return `Space  Cast off ${deckLabel(deck)}`;
  if (state === 'waiting' || state === 'nibble') return 'R  Reel in to walk on';
  return null;
}

/** "the pier" / "the bridge" / "the dock" — a marina's planks and a house's private dock are both docks. */
function deckLabel(name: string): string {
  return /pier/i.test(name) ? 'the pier' : /bridge/i.test(name) ? 'the bridge' : 'the dock';
}
