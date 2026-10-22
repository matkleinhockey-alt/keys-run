/**
 * Money, boat progression and wealth tiers.
 *
 * Pure (no three.js, no DOM, no `Date.now()`) in the same shape as fight.ts / race.ts: plain
 * calculators plus `step*(state, input) => state` transitions. That is so a server can run the
 * identical functions later, NOT because anything here is authoritative today. Be plain about it:
 * the wallet currently lives in the player's own localStorage (apps/client/src/game/economy/), so
 * anyone can edit it. docs/ARCHITECTURE.md's authority model says anything that can reach a
 * leaderboard belongs on the server; cash must never be shown on, or ranked by, a shared board
 * until `stepCatch` is run server-side from a *validated* landing (the sim already knows the
 * species and weight it spawned and the fight it resolved).
 *
 * The player starts in the Grady-White "Actively Sinking" (the cheapest, worst hull) and buys up.
 * Nothing here removes or hides a hull from the game; ownership only gates who can be selected.
 */
import { SPECIES } from '../content/species.js';

// ---------------------------------------------------------------- fish value

/** Dollars-per-species-unit. Species have no rarity field, so rarity is derived from what the
 * data does carry: `str` (how hard it fights, i.e. how hard it is to land) squared so the
 * heavy-tackle fish pull away from the pack, times a gentle log of `max` weight so a species that
 * grows huge is worth more than a same-strength one that doesn't. Measured against the 49-species
 * table: yellowtail averages ~$40, mahi ~$420, yellowfin ~$1,100, blue marlin ~$2,000. Rejected:
 * pricing per pound, which made a 900 lb bluefin worth ~100x a 10 lb snapper and broke the curve
 * on the very first marlin; and the existing score `mult`, which is *inversely* related to size
 * (lionfish 60, bluefin 5) because it is tuned to make small fish worth scoring, not to pay. */
function speciesBase(max: number, str: number): number {
  return 96 * Math.pow(str / 0.5, 2.0) * (1 + 0.55 * Math.log10(Math.max(1, max / 8)));
}

/** Fraction of the way from a species' smallest to largest fish, 0..1. */
export function sizeFraction(key: string, weight: number): number {
  const S = SPECIES[key];
  if (!S || S.max <= S.min) return 0;
  return Math.min(1, Math.max(0, (weight - S.min) / (S.max - S.min)));
}

/** Top slice of a species' size range that counts as a trophy. */
export const TROPHY_FRACTION = 0.85;

/** What a landed fish is worth, whole dollars. Size-within-species is convex (`t^1.5`) so the
 * middle of the range pays a middling amount and the top end pays a real bonus; the extra 1.35x
 * past TROPHY_FRACTION is the "that one's going on the wall" payday. A species-minimum fish is
 * 0.4x base, a maximum fish ~4x base (3x * 1.35 - rounding) — roughly a 10x spread within one
 * species, which is what makes holding out for the big one worth it. Unknown keys pay nothing
 * rather than throwing: this sits on the landing path and must never break a catch. */
export function fishValue(key: string, weight: number): number {
  const S = SPECIES[key];
  if (!S) return 0;
  const t = sizeFraction(key, weight);
  const size = (0.4 + 2.2 * Math.pow(t, 1.5)) * (t >= TROPHY_FRACTION ? 1.35 : 1);
  return Math.max(1, Math.round(speciesBase(S.max, S.str) * size));
}

export function isTrophy(key: string, weight: number): boolean {
  return !!SPECIES[key] && sizeFraction(key, weight) >= TROPHY_FRACTION;
}

// ---------------------------------------------------------------- boats

/** Unlock order, cheapest/worst first. Keyed by `BOATS[].id` (content/boats.ts); the test asserts
 * every hull there has a price so adding a ninth hull without pricing it fails loudly. */
export const BOAT_ORDER: readonly string[] = [
  'grady', 'robalo', 'contender', 'yellowfin', 'freeman', 'midnight', 'mti', 'nortech',
];

/** The hull you start in and can never lose. */
export const STARTER_BOAT = 'grady';

/**
 * Prices, dollars.
 *
 * RE-MEASURED, not re-guessed (apps/client/test/playthrough-economy.mjs; the old note here assumed a
 * 12-fish, ~$2k session). With the fight reworked and the starter outfit moved to braid50, 30
 * sim-minutes on the Grady pay $11.1k (Hawk Channel) / $12.5k (Reef) / $21.0k (Offshore), ~58/56/33
 * fish, so fish COUNT fell against the effortless fights but dollars per fish are high enough that
 * income is ~1.7x what these prices were sized for. A human is not the harness angler: one "session"
 * is 15 rod-minutes at 60% realism = 0.3 x that table = **$3.75k at the Reef, $6.3k offshore** on
 * the starter kit, rising to ~$8.9k with the town rod+reel and ~$10.6k+ on braid130 (hulls do NOT
 * change income today: the Grady already runs the Gulf Stream and the stream is ~35 s away, so a
 * hull is range, handling, status and the deck party, never a catch multiplier).
 *
 * Hulls are therefore a status sink that competes with a gear sink, and the ladder is sized as a
 * greedy buyer's timeline through BOTH (test/economy.test.ts walks it): cheap dive kit in session 1,
 * lever reel session 2, pony bottle session 3, FIRST HULL session 4, contender 7, braid130 9,
 * yellowfin 12, freeman 16, midnight 21, mti 27, nortech 34 (whole fleet + every shelf item ~34
 * sessions, close to the original ~30). Hull-to-hull gaps are 3,3,4,5,6,7 sessions.
 *
 * What changed and why: robalo 8k -> 9k (it is a flats boat that is WORSE in a chop than the Grady, so
 * it must not be the obvious first buy; at 9k it is ~2.4 inshore sessions, the same price band as the
 * bottle+reel it competes with). contender 18k -> 20k, yellowfin 28k -> 30k and freeman 40k -> 42k
 * so the early hulls sit behind the 22k braid130 rung rather than ahead of it. The top three were
 * CUT (midnight 62k -> 56k, mti 90k -> 70k, nortech 125k -> 85k): income plateaus near $10-11k per
 * session once the kit is bought, and the old 22k/28k/35k steps had grown to 7-12 sessions each. Cuts
 * to 56/70/85 keep every step at or under 7. Rejected: scaling everything x2.5 to restore the old
 * "3-6 sessions at ~$2k" arithmetic (a 20k first hull is an afternoon wall to a new player) and
 * raising payouts (it would inflate the shop's lift/price ratios I just set).
 */
export const BOAT_PRICE: Readonly<Record<string, number>> = {
  grady: 0,
  robalo: 9_000,
  contender: 20_000,
  yellowfin: 30_000,
  freeman: 42_000,
  midnight: 56_000,
  mti: 70_000,
  nortech: 85_000,
};

export function boatPrice(id: string): number {
  return BOAT_PRICE[id] ?? Infinity;
}

// ---------------------------------------------------------------- state

export interface EconomyState {
  /** Schema version, for the persisted blob. */
  v: 1;
  cash: number;
  /** Lifetime earnings from fish. Never decreases; spending doesn't touch it. */
  earned: number;
  owned: string[];
  /** The hull currently selected. Always in `owned`. */
  boat: string;
  catches: number;
  /** Value of the single best catch, for the "personal best" toast. */
  bestCatch: number;
}

export function createEconomy(): EconomyState {
  return { v: 1, cash: 0, earned: 0, owned: [STARTER_BOAT], boat: STARTER_BOAT, catches: 0, bestCatch: 0 };
}

export interface Payout {
  value: number;
  trophy: boolean;
  /** True when this fish is the best single payday so far. */
  personalBest: boolean;
}

export function payoutFor(state: EconomyState, key: string, weight: number): Payout {
  const value = fishValue(key, weight);
  return { value, trophy: isTrophy(key, weight), personalBest: value > state.bestCatch };
}

/** A fish was landed. Both rod and spear funnel here (via catch-flow). Paying on landing, not on
 * keep/release: the conservation-release bonus stays a score thing, and punishing a release with
 * lost money would train players to keep protected species. */
export function stepCatch(state: EconomyState, fish: { key: string; weight: number }): EconomyState {
  const value = fishValue(fish.key, fish.weight);
  return {
    ...state,
    cash: state.cash + value,
    earned: state.earned + value,
    catches: state.catches + 1,
    bestCatch: Math.max(state.bestCatch, value),
  };
}

export type BuyResult =
  | { ok: true; state: EconomyState }
  | { ok: false; state: EconomyState; reason: 'unknown-boat' | 'already-owned' | 'insufficient-funds'; short: number };

export function owns(state: EconomyState, id: string): boolean {
  return state.owned.includes(id);
}

export function canAfford(state: EconomyState, id: string): boolean {
  return Number.isFinite(boatPrice(id)) && state.cash >= boatPrice(id);
}

/** Buying also selects the hull — nobody buys a boat to leave it at the dock. Never lets cash go
 * negative: the affordability check is the only gate, and it is here, not in the UI. */
export function stepBuy(state: EconomyState, input: { boatId: string }): BuyResult {
  const id = input.boatId;
  const price = boatPrice(id);
  if (!Number.isFinite(price)) return { ok: false, state, reason: 'unknown-boat', short: 0 };
  if (owns(state, id)) return { ok: false, state, reason: 'already-owned', short: 0 };
  if (state.cash < price) return { ok: false, state, reason: 'insufficient-funds', short: price - state.cash };
  return { ok: true, state: { ...state, cash: state.cash - price, owned: [...state.owned, id], boat: id } };
}

/** Select an owned hull. A no-op (same state) for one you don't own. */
export function stepSelect(state: EconomyState, input: { boatId: string }): EconomyState {
  return owns(state, input.boatId) ? { ...state, boat: input.boatId } : state;
}

/** The cheapest hull not yet owned, in unlock order; null when you own the fleet. */
export function nextBoat(state: EconomyState): { id: string; price: number; short: number } | null {
  for (const id of BOAT_ORDER) {
    if (!owns(state, id)) return { id, price: boatPrice(id), short: Math.max(0, boatPrice(id) - state.cash) };
  }
  return null;
}

// ---------------------------------------------------------------- wealth tiers

/** Cash plus the sticker price of every hull you own. Counting the fleet is deliberate: if wealth
 * were cash alone, buying a boat would empty the deck at the exact moment you got the nicer one. */
export function netWorth(state: EconomyState): number {
  let w = state.cash;
  for (const id of state.owned) w += boatPrice(id);
  return w;
}

/** Net-worth floor of each tier. Tier 0 is a broke angler and a buddy; tier 5 is a full dock
 * party. Net worth counts every hull's sticker price, so the cumulative fleet is what matters:
 * robalo 9k -> tier 2, contender 29k -> 3, freeman 101k -> 4, mti 227k -> 5 (the top floor moved
 * 240k -> 215k so the party still peaks at the same hull after the top-end price cuts). */
export const TIER_FLOOR: readonly number[] = [0, 1_500, 6_000, 25_000, 90_000, 215_000];
export const TIER_NAMES: readonly string[] = ['Bait money', 'Weekend angler', 'Regular', 'Local legend', 'High roller', 'Dockside royalty'];
/** People partying aboard at each tier, before the hull's own capacity cap. */
const TIER_PARTY: readonly number[] = [1, 2, 3, 4, 6, 8];

export function wealthTier(worth: number): number {
  let t = 0;
  for (let i = 0; i < TIER_FLOOR.length; i++) if (worth >= TIER_FLOOR[i]) t = i;
  return t;
}

export interface DeckWealth {
  tier: number;
  name: string;
  /** How many party guests to put aboard. */
  partyCount: number;
  /** Underwater lights default on from tier 2 — the "trim" half of the flair. */
  underglow: boolean;
}

/** Deck population for a tier on a hull of `lenM` metres. The cap is about one guest per 1.4 m of
 * waterline: the party path is a single loop round the cockpit, and more than that and the dancers
 * clip through each other (the 7 m Robalo tops out at 5, the 13 m Freeman takes the full 8). */
export function deckWealth(worth: number, lenM: number): DeckWealth {
  const tier = wealthTier(worth);
  const cap = Math.max(1, Math.floor(lenM / 1.4));
  return { tier, name: TIER_NAMES[tier], partyCount: Math.min(TIER_PARTY[tier], cap), underglow: tier >= 2 };
}

// ---------------------------------------------------------------- persistence

/** Turns whatever came out of storage into a valid state. Never throws, never trusts: a corrupted
 * or hand-edited blob degrades to the nearest legal state (negative cash -> 0, unknown hulls
 * dropped, the starter re-added, selection forced onto an owned hull). This is input hygiene for
 * a single-player save, not anti-cheat — see the file header. */
export function sanitizeEconomy(raw: unknown): EconomyState {
  const base = createEconomy();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  const owned = new Set<string>([STARTER_BOAT]);
  if (Array.isArray(r.owned)) for (const id of r.owned) if (typeof id === 'string' && id in BOAT_PRICE) owned.add(id);
  const boat = typeof r.boat === 'string' && owned.has(r.boat) ? r.boat : STARTER_BOAT;
  return {
    v: 1, cash: num(r.cash), earned: num(r.earned), owned: BOAT_ORDER.filter((id) => owned.has(id)),
    boat, catches: num(r.catches), bestCatch: num(r.bestCatch),
  };
}
