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

  return {
    get state() { return state; },
    /** The hull to start in: the last one the player selected (always owned). */
    startingBoat(): Boat { return hullById(state.boat); },
    wealthFor,
    syncDeck,
    payForCatch,
    market,
    /** Dev/test: a legal wallet for a screenshot script. Not reachable from normal play. */
    debugSet(over: Partial<EconomyState>): void { commit(sanitizeEconomy({ ...state, ...over })); syncDeck(); },
  };
}

export type EconomySystem = ReturnType<typeof createEconomySystem>;
