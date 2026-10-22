/**
 * Which treasure containers this player has already emptied.
 *
 * The rules and the transition are pure and shared (`@keysrun/shared/sim/treasure`:
 * `stepOpenContainer`, and its header for WHY the looted set is state and not part of the
 * deterministic generation). This file is only the seam that remembers it between sessions, kept
 * deliberately tiny and beside `wreck-chart.ts`, which does exactly the same job for "which wrecks
 * have I found" — same shape, same caveats, same two SERVER SEAM functions.
 *
 * ⚠ CLIENT-SIDE, AND NOT CHEAT-PROOF — the same status as the wallet (game/economy/system.ts), the
 * inventory (game/economy/inventory.ts) and the chart. Clearing this key in devtools re-fills every
 * wreck in the world, which is worth ~$11k. Accepted for exactly as long as cash is nobody's
 * business but the player's: docs/ARCHITECTURE.md puts anything that can reach a leaderboard on
 * the server, and when it does, the server holds the opened set (it has to — two divers cannot both
 * take the same strongbox) and these two functions become a read-through cache. Nothing else in the
 * client touches localStorage for treasure.
 *
 * Every access is guarded: storage throws in private windows and is absent in the headless
 * harness, and a dive must not break because of it. The cost of storage being unavailable is that
 * the wrecks re-fill on reload, which is the failure a player forgives.
 */
import { createTreasureState, type TreasureState } from '@keysrun/shared/sim/treasure';

const STORE_KEY = 'keysrun.treasure.v1';

/** SERVER SEAM 1/2: where "what have I emptied" comes from. */
export function loadTreasure(): TreasureState {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (!raw) return createTreasureState();
    const o = JSON.parse(raw) as { opened?: unknown };
    // Degrade to the nearest legal state rather than throwing, like `sanitizeInventory`: a
    // hand-edited blob costs you a re-loot, it does not cost you the dive.
    const opened = Array.isArray(o.opened) ? o.opened.filter((x): x is string => typeof x === 'string') : [];
    return { opened: [...new Set(opened)] };
  } catch {
    return createTreasureState();
  }
}

/** SERVER SEAM 2/2: where it goes. */
export function saveTreasure(s: TreasureState): void {
  try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* unremembered, not fatal */ }
}

/** Test/verification only: re-fill every wreck in the world. */
export function resetTreasure(): void {
  try { globalThis.localStorage?.removeItem(STORE_KEY); } catch { /* ignore */ }
}
