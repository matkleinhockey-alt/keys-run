/**
 * Persistence for the player's inventory (what they own, carry and are under the influence of).
 * The rules live in packages/shared/src/sim/shop.ts; this file is only the localStorage seam, kept
 * beside the wallet's (system.ts) because the two are one purse: buying debits one and credits the
 * other, and they should be equally easy to swap for a server copy.
 *
 * Stored as its OWN key rather than a field on the wallet blob. The wallet's `sanitizeEconomy` is
 * shared and tested and owned by someone else; folding a second shape into it would mean editing
 * that contract for a client-only concern. The cost is that the two writes are not atomic — a tab
 * killed between them can leave you with the item and the money, or neither. Rejected: a combined
 * blob, because that only matters once cash is worth cheating for, and by then the server owns
 * both and this whole file is a read-through cache.
 *
 * `clockS` is saved with the inventory because buffs are stored as expiry TIMESTAMPS on a
 * simulated-seconds clock that starts at 0 each page load. Without the clock, a reload would
 * compare yesterday's expiry to a fresh 0 and hand you a many-hour coffee.
 *
 * ⚠ CLIENT-SIDE FOR NOW, AND NOT CHEAT-PROOF — same status and same reasoning as the wallet (see
 * system.ts). Editing this blob in devtools grants any gear. Accepted: offline play is first-class
 * and nothing here reaches a leaderboard. docs/ARCHITECTURE.md puts anything that can (e.g. "caught
 * on a heavy rod") on the server, where `buy` from sim/shop.ts runs unchanged against the server's
 * wallet. That swap is confined to the two functions marked SERVER SEAM.
 */
import { emptyInventory, type Inventory } from '@keysrun/shared/sim/shop';

const STORAGE_KEY = 'keysrun.inventory.v1';

export interface StoredInventory { inventory: Inventory; clockS: number }

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
function numRecord(v: unknown, keep: (n: number) => boolean): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object') {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n) && keep(n)) out[k] = n;
    }
  }
  return out;
}

/** A hand-edited or old blob degrades to the nearest legal inventory instead of throwing. */
export function sanitizeInventory(raw: unknown): StoredInventory {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const inv = (o.inventory && typeof o.inventory === 'object' ? o.inventory : {}) as Record<string, unknown>;
  const wearing: Record<string, string> = {};
  if (inv.wearing && typeof inv.wearing === 'object') {
    for (const [k, s] of Object.entries(inv.wearing as Record<string, unknown>)) if (typeof s === 'string') wearing[k] = s;
  }
  const clockS = typeof o.clockS === 'number' && Number.isFinite(o.clockS) && o.clockS >= 0 ? o.clockS : 0;
  return {
    inventory: {
      gear: [...new Set(strs(inv.gear))],
      cosmetics: [...new Set(strs(inv.cosmetics))],
      consumables: numRecord(inv.consumables, (n) => n > 0),
      buffs: numRecord(inv.buffs, (n) => n > clockS),
      wearing,
    },
    clockS,
  };
}

/** SERVER SEAM 1/2 (inventory): where ownership comes from. Today this browser's localStorage;
 * later the server's copy fetched at login. Wrapped because storage throws in private windows. */
export function loadInventory(): StoredInventory {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeInventory(JSON.parse(raw)) : { inventory: emptyInventory(), clockS: 0 };
  } catch {
    return { inventory: emptyInventory(), clockS: 0 };
  }
}

/** SERVER SEAM 2/2 (inventory): where ownership goes. Today a local write; later a no-op, because
 * the server records the purchase when it validates `buy`. */
export function saveInventory(s: StoredInventory): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* unremembered, not fatal */ }
}
