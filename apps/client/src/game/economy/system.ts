/**
 * The player's wallet, wired into the game: pays for landed fish, owns the "which boats do I
 * have" question the boat cards ask, and fills the deck as the player gets rich.
 *
 * The rules themselves (what a fish is worth, boat prices, wealth tiers) are pure and live in
 * packages/shared/src/sim/economy.ts, with tests. This file is only the glue: persistence, HUD
 * text, toasts, and telling the boat model how many guests to carry.
 *
 * ⚠ CLIENT-SIDE FOR NOW, AND NOT CHEAT-PROOF. The whole wallet is one JSON blob in the player's
 * own localStorage; opening devtools and typing a bigger number works, and that is accepted here
 * because offline play is a first-class mode (ui/auth/gate.ts) and nothing in this wallet reaches
 * the leaderboard. docs/ARCHITECTURE.md's authority model puts anything that *can* reach a shared
 * board on the server, so when cash or boats start to matter to anyone but the person holding
 * them, the move is: the sim, which already resolves each landing, runs `stepCatch` from that
 * validated event and the client's `load`/`save` below become a read-through cache of the
 * server's wallet. That swap is confined to the two functions marked SERVER SEAM.
 */
import { BOATS, type Boat } from '@keysrun/shared/content/boats';
import {
  TIER_NAMES, boatPrice, createEconomy, deckWealth, netWorth, owns, payoutFor,
  sanitizeEconomy, stepBuy, stepCatch, stepSelect, nextBoat,
  type DeckWealth, type EconomyState, type Payout,
} from '@keysrun/shared/sim/economy';
import { VENUES, type VenueId } from '@keysrun/shared/content/venues';
import {
  buy as shopBuy, modifiersFor, pruneBuffs, useOne,
  type BuyFailure, type Inventory, type Modifiers,
} from '@keysrun/shared/sim/shop';
import { loadInventory, saveInventory } from './inventory.js';
import { toast } from '../../ui/toast.js';
import type { BoatModel } from '../../entities/boat/model.js';
import type { BoatMarket } from '../../ui/start.js';

const STORAGE_KEY = 'keysrun.economy.v1';

/** SERVER SEAM 1/2: where the wallet comes from. Today: this browser's localStorage. Later: the
 * server's copy, fetched at login, with localStorage kept only for the offline fallback. Wrapped
 * because storage throws in private windows and when site data is blocked — the game must still
 * run, on a fresh wallet that simply isn't remembered. */
function load(): EconomyState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeEconomy(JSON.parse(raw)) : createEconomy();
  } catch {
    return createEconomy();
  }
}

/** SERVER SEAM 2/2: where the wallet goes. Today a local write; later a no-op for money (the
 * server owns it) and only a selected-hull preference would be sent. */
function save(s: EconomyState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* unremembered, not fatal */ }
}

const usd = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');
function setText(id: string, s: string): void { const el = document.getElementById(id); if (el) el.textContent = s; }

export interface EconomyDeps {
  getModel(): BoatModel;
  /** Called after the guest list changes, so new materials get the cascaded-shadow setup. */
  onGuestsChanged?(): void;
}

export function createEconomySystem(deps: EconomyDeps) {
  let state = load();
  let lastTier = deckWealth(netWorth(state), 10).tier;
  const listeners = new Set<() => void>();

  // ---- inventory (rules: shared sim/shop.ts; persistence: ./inventory.ts) -----------------------
  const stored = loadInventory();
  let inventory: Inventory = stored.inventory;
  /** Simulated seconds since the first ever session; the clock every buff expiry is stamped on.
   * Advanced only by `tick`, so a paused or backgrounded game does not burn your coffee. */
  let clockS = stored.clockS;
  let lastClockSave = clockS;
  const invListeners = new Set<() => void>();
  /** `modifiersFor` allocates a bag; the fight sim and the diver may ask every frame. Keyed on the
   * inventory reference, which only changes on a purchase, a spend or an expiry — `tick` prunes
   * before anyone reads, so the cache can never serve a buff that has run out. */
  let modsInv: Inventory | null = null;
  let mods: Modifiers = modifiersFor(inventory, clockS);

  function commitInv(next: Inventory): void {
    inventory = next;
    saveInventory({ inventory, clockS });
    lastClockSave = clockS;
    invListeners.forEach((f) => f());
  }

  /** Once per fixed step, from world.ts. Expires buffs and, while any are running, re-saves the
   * clock every ~5 s so a reload mid-buff resumes within seconds of where it was. */
  function tick(dt: number): void {
    clockS += dt;
    const pruned = pruneBuffs(inventory, clockS);
    if (pruned !== inventory) {
      const all = Object.values(VENUES).flatMap((v) => v.sells);
      for (const k of Object.keys(inventory.buffs)) {
        if (k in pruned.buffs) continue;
        const it = all.find((s) => s.effect.key === k);
        if (it) toast(`${it.name} has worn off.`);
      }
      commitInv(pruned);
    } else if (Object.keys(inventory.buffs).length && clockS - lastClockSave > 5) {
      saveInventory({ inventory, clockS });
      lastClockSave = clockS;
    }
  }

  /** ★ THE SHARED SEAM. Every system that wants to know what the player's gear and buffs change
   * reads this and only this — never the inventory, never an item id. Multipliers are 1 = no
   * change, additive fields 0 = no change, so ignoring a field is always safe. Cheap to call per
   * frame (cached); the returned object is shared, so treat it as read-only. */
  function modifiers(): Modifiers {
    if (modsInv !== inventory) { mods = modifiersFor(inventory, clockS); modsInv = inventory; }
    return mods;
  }

  const FAIL_TEXT: Record<BuyFailure, string> = {
    'not-for-sale': 'That is not for sale yet.',
    'cannot-afford': 'You cannot afford that.',
    'already-owned': 'You already own that.',
    'no-such-item': 'They do not stock that.',
  };

  /** Buys one item: `shopBuy` validates against the wallet and returns the new inventory + cost,
   * this debits the wallet and applies both. Never throws. `message` is player-facing either way. */
  function buyItem(venueId: VenueId, itemId: string): { ok: boolean; message: string } {
    try {
      const it = VENUES[venueId]?.sells.find((s) => s.id === itemId);
      const r = shopBuy(inventory, venueId, itemId, state.cash, clockS);
      if (!r.ok) {
        const reason = r.reason ?? 'no-such-item';
        return { ok: false, message: reason === 'cannot-afford' && it ? `You need ${usd(it.price - state.cash)} more for the ${it.name}.` : FAIL_TEXT[reason] };
      }
      // Wallet first, inventory second: if the second ever threw you would be out money rather
      // than holding free gear, the failure a player forgives. Both are sync writes in practice.
      commit({ ...state, cash: state.cash - r.cost });
      commitInv(r.inventory);
      const msg = `Bought ${it?.name ?? itemId} for ${usd(r.cost)}.`;
      toast(msg);
      return { ok: true, message: msg };
    } catch (e) {
      console.error('economy buyItem', e);
      return { ok: false, message: 'The till jammed. Try again.' };
    }
  }

  /** Spends one carried unit (a cast of bait, a shaft). True if there was one to spend. */
  function useConsumable(key: string): boolean {
    const next = useOne(inventory, key);
    if (next === inventory) return false;
    commitInv(next);
    return true;
  }

  function hullById(id: string): Boat { return BOATS.find((b) => b.id === id) ?? BOATS[1]; }

  function paintHud(): void {
    setText('scCash', usd(state.cash));
    const n = nextBoat(state);
    const nb = n ? hullById(n.id) : null;
    setText('startCash', usd(state.cash) + ' · ' + TIER_NAMES[deckWealth(netWorth(state), 10).tier]
      + (nb ? ` · next boat: ${nb.brand} ${nb.name} at ${usd(n!.price)}` : ' · you own the whole fleet'));
  }

  function commit(next: EconomyState): void {
    state = next;
    save(state);
    paintHud();
    listeners.forEach((f) => f());
  }

  /** How many guests this wallet puts on a hull of the given length — read by world.ts when it
   * builds a boat, and by `syncDeck` for a live boat. */
  function wealthFor(lenM: number): DeckWealth { return deckWealth(netWorth(state), lenM); }

  /** Push the current tier onto the boat that's actually on the water. */
  function syncDeck(): void {
    const model = deps.getModel();
    const spec = hullById(state.boat);
    const w = wealthFor(spec.len);
    if (model.party.length === w.partyCount) return;
    const grew = w.partyCount > model.party.length;
    model.setPartySize(w.partyCount);
    deps.onGuestsChanged?.();
    if (grew && w.tier !== lastTier) toast(`${TIER_NAMES[w.tier]}. Word gets around: more people on deck.`);
    lastTier = w.tier;
  }

  /** The one entry point from the landing path (game/catch/catch-flow.ts), rod and spear alike.
   * Never throws: money must not be able to break the catch card. */
  function payForCatch(key: string, weight: number): Payout {
    try {
      const p = payoutFor(state, key, weight);
      commit(stepCatch(state, { key, weight }));
      syncDeck();
      return p;
    } catch (e) {
      console.error('economy payForCatch', e);
      return { value: 0, trophy: false, personalBest: false };
    }
  }

  const market: BoatMarket = {
    cash: () => state.cash,
    owns: (id) => owns(state, id),
    price: (id) => boatPrice(id),
    /** Returns null on success, or a short message for the player on refusal. */
    buy(id) {
      const r = stepBuy(state, { boatId: id });
      if (!r.ok) {
        if (r.reason === 'insufficient-funds') return `Need ${usd(r.short)} more for that one.`;
        if (r.reason === 'already-owned') return null;
        return 'That boat is not for sale.';
      }
      commit(r.state);
      const h = hullById(id);
      toast(`Bought the ${h.brand} ${h.name} for ${usd(boatPrice(id))}.`);
      return null;
    },
    select(id) { commit(stepSelect(state, { boatId: id })); },
    subscribe(f) { listeners.add(f); return () => { listeners.delete(f); }; },
  };

  paintHud();

  const api = {
    get state() { return state; },
    /** The hull to start in: the last one the player selected (always owned). */
    startingBoat(): Boat { return hullById(state.boat); },
    wealthFor,
    syncDeck,
    payForCatch,
    market,
    modifiers,
    /** Consume one carried unit of an `effect.key` (e.g. 'bait.shrimp'); false when none is left. */
    useConsumable,
    /** Advance the inventory clock (simulated seconds) and expire buffs. world.ts, once per fixed step. */
    tick,
    /** What the shop panel and gear screen need — game systems read `modifiers()` instead. */
    shop: {
      cash: (): number => state.cash,
      inventory: (): Inventory => inventory,
      clock: (): number => clockS,
      buy: buyItem,
      subscribe(f: () => void): () => void {
        invListeners.add(f); listeners.add(f); // wallet changes (a catch pays out) matter to the panel too
        return () => { invListeners.delete(f); listeners.delete(f); };
      },
    },
    /** Dev/test: replace the inventory wholesale, and fast-forward the buff clock. */
    debugSetInventory(inv: Inventory): void { commitInv(inv); },
    debugAdvanceClock(s: number): void { tick(s); },
    /** Dev/test: a legal wallet for a screenshot script. Not reachable from normal play. */
    debugSet(over: Partial<EconomyState>): void { commit(sanitizeEconomy({ ...state, ...over })); syncDeck(); },
  };

  // DEV/VERIFICATION HOOK ONLY, same spirit as __fishDebug: earning $900 for a pony bottle by hand
  // is not a test. Nothing in normal play calls it. `buy` goes through the real `buyItem`, so
  // wallet, refusals, persistence and the panel all behave exactly as for a player.
  (window as unknown as { __shopDebug?: unknown }).__shopDebug = {
    grant(n: number) { commit({ ...state, cash: Math.max(0, state.cash + n) }); return state.cash; },
    /** Buy by item id (e.g. 'dive-tank') from whichever venue stocks it. */
    buy(itemId: string) {
      const v = Object.values(VENUES).find((x) => x.sells.some((s) => s.id === itemId));
      return v ? buyItem(v.id, itemId) : { ok: false, message: 'no such item id' };
    },
    /** Fast-forward the buff clock by simulated seconds. */
    advance(s: number) { tick(s); return clockS; },
    modifiers: () => ({ ...modifiers() }),
    state: () => ({ cash: state.cash, clockS, inventory }),
    reset() { commit({ ...state, cash: 0 }); commitInv({ gear: [], consumables: {}, buffs: {}, cosmetics: [], wearing: {} }); },
    ids: () => Object.values(VENUES).flatMap((v) => v.sells.map((s) => `${v.id}/${s.id} $${s.price}`)),
  };
  return api;
}

export type EconomySystem = ReturnType<typeof createEconomySystem>;
