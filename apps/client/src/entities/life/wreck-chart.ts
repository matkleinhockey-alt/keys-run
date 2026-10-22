/**
 * Which shipwrecks are on the player's chart. Three-free so the minimap (which has no business
 * knowing about scene graphs) and the wreck entity can share it, and so it is unit-testable.
 *
 * **Decision: wrecks are found, not gifted.** The chart starts without them and a wreck is added
 * the first time the boat or the diver comes within `WRECK_CHART_M` (260 m) of its hull. Reasons:
 *
 *  - The point of a wreck, as the brief puts it, is that it is a thing you find. A chart that
 *    opens with six pins on it turns that into a shopping list: you drive to a pin, which is
 *    exactly the "game pin" feel this is meant to avoid. Real wrecks are the opposite - the fish
 *    people hunt for are on numbers that were found by running a sounder over bottom.
 *  - 260 m is a sounder's reach, not a visual one: you chart a wreck by passing near it, not by
 *    seeing it, which is how it works on a real boat and keeps the discovery from needing line of
 *    sight through 20 m of water. It is wide enough that a deliberate sweep of the reef wall finds
 *    them and narrow enough that you do have to sweep.
 *  - The cost is that a first-time player sees an empty chart; the toast on discovery ("Wreck
 *    charted ...") and the cast toast cover that. `WRECKS_PRECHARTED` flips the whole feature to
 *    "known from the start" in one place if that trade turns out wrong.
 *
 * Persisted in localStorage per browser (the wallet is client-local today, see sim/economy.ts, so
 * this is no less honest than the rest of the client's progress); every access is guarded because
 * storage is absent in private windows and in the headless harness.
 */
import { WRECK_CHART_M, wreckEdgeDist, wrecksFor, type Wreck } from '@keysrun/shared/world/wrecks';
import { WORLD_SEED } from '../../state/constants.js';

/** Flip to `true` to chart every wreck from the first frame (see header). */
export const WRECKS_PRECHARTED = false;
const STORE_KEY = 'keysrun.wrecks.charted.v1';

const charted = new Set<string>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw) for (const id of JSON.parse(raw) as string[]) charted.add(id);
  } catch { /* storage unavailable or corrupt: start empty */ }
}

function save(): void {
  try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify([...charted])); } catch { /* ignore */ }
}

export function isCharted(id: string): boolean {
  load();
  return WRECKS_PRECHARTED || charted.has(id);
}

/** Wrecks currently on the chart, for the minimap. */
export function chartedWrecks(seed: number = WORLD_SEED): Wreck[] {
  load();
  return wrecksFor(seed).filter((w) => isCharted(w.id));
}

/** Charts every not-yet-charted wreck whose hull lies within `WRECK_CHART_M` of (x,z); returns the
 * ones newly charted so the caller can announce them. */
export function chartNear(x: number, z: number, seed: number = WORLD_SEED): Wreck[] {
  load();
  const found: Wreck[] = [];
  for (const w of wrecksFor(seed)) {
    if (charted.has(w.id) || WRECKS_PRECHARTED) continue;
    if (wreckEdgeDist(w, x, z) <= WRECK_CHART_M) { charted.add(w.id); found.push(w); }
  }
  if (found.length) save();
  return found;
}

/** Test/debug only: forget everything. */
export function resetChart(): void {
  charted.clear();
  loaded = true;
  save();
}
