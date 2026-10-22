/**
 * The town's services and money sinks: the motel, the cabaret, the lotto counter, the laundromat
 * and the Stop-N-Go can. Everything here is pure (no three.js, no DOM, no `Date.now()`, no
 * `Math.random()`), in the same shape as sim/shop.ts, so the same functions can run on a server
 * later. The client glue (apps/client/src/game/services/) only adds persistence, a fade and some
 * neon.
 *
 * ## Contract with the shop UI (owned by someone else)
 *
 * The shop panel calls, for the items listed in `SERVICE_KEYS`:
 *   1. `canBuy(state, key, ctx)`  BEFORE `shop.buy()`. A refusal here means the player is NOT
 *      charged. Every "you can't do that right now" case lives here (already sunset, not on the
 *      list, nothing to wash) precisely so we never take money and then decline to deliver.
 *   2. `shop.buy()` and the wallet deduction as usual.
 *   3. `resolve(state, key, ctx)` AFTER payment. It returns the next services state and an
 *      `Outcome` (lines to show, a payout to credit, what to do to the inventory).
 *
 * ## Randomness
 *
 * Anything that decides money (the scratch-off) is drawn from `mulberry32(hashSeed(seed, n, 0,
 * SALT))` where `seed` is a per-save value and `n` is the ticket counter. The counter is bumped
 * and persisted by `resolve` itself, so reloading the page cannot re-roll a ticket you already
 * bought: ticket n is a fixed function of (seed, n), and n only ever goes up. Rejected:
 * `Math.random()` (unreproducible, and un-testable as a distribution), and seeding from the clock
 * at purchase time (lets a player time their click).
 */
import { hashCell, mulberry32, type Rng } from '../rng/index.js';
import type { Inventory } from './shop.js';

/** `hashCell` returns a float in [0,1); mulberry32 wants an integer seed, and `>>> 0` on the float
 * would silently be 0 for every input (a bug the distribution test caught: all seeds dealt the same
 * tickets). Scale to 32 bits first. */
const hashSeed = (seed: number, a: number, b: number, salt: number): number =>
  Math.floor(hashCell(seed, a, b, salt) * 4294967296) >>> 0;

/** The effect keys this module is responsible for. */
export const SERVICE_KEYS = [
  'motel.night', 'club.cover', 'club.bottle', 'club.tip', 'liquor.scratch',
  'boat.fuel', 'laundromat.wash', 'laundromat.sock',
] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];
export const isServiceKey = (k: string): k is ServiceKey => (SERVICE_KEYS as readonly string[]).includes(k);

/* ------------------------------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------------------------------ */

export interface ServicesState {
  v: 1;
  /** Per-save RNG seed. Fixed for the life of the save. */
  seed: number;
  /** Scratch-offs bought so far. Ticket n's result is a pure function of (seed, n). */
  tickets: number;
  scratchSpent: number;
  scratchWon: number;
  /** Nights slept at the motel. */
  nights: number;
  /** On the cabaret's list tonight. Cleared by a night at the motel (a new evening). */
  admitted: boolean;
  /** Lifetime dollars left at the cabaret; decides how the bouncer greets you. */
  clubSpent: number;
  /** Tips left this evening (resets with `admitted`). */
  tipsTonight: number;
  /** Distinct lost socks collected, as a bitmask of SOCKS indices. */
  socks: number;
  washes: number;
  /** Monotonic counter that varies flavour lines without ever touching money. */
  beat: number;
}

export function createServices(seed: number): ServicesState {
  return {
    v: 1, seed: seed >>> 0, tickets: 0, scratchSpent: 0, scratchWon: 0, nights: 0,
    admitted: false, clubSpent: 0, tipsTonight: 0, socks: 0, washes: 0, beat: 0,
  };
}

/** Defensive load: localStorage is the player's to edit, so every field is clamped. */
export function sanitizeServices(raw: unknown, fallbackSeed: number): ServicesState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (k: string, max = 1e9): number => {
    const x = Number(r[k]);
    return Number.isFinite(x) ? Math.min(max, Math.max(0, Math.floor(x))) : 0;
  };
  const seed = r.seed !== undefined && Number.isFinite(Number(r.seed)) ? Number(r.seed) >>> 0 : fallbackSeed >>> 0;
  return {
    v: 1, seed, tickets: n('tickets'), scratchSpent: n('scratchSpent'), scratchWon: n('scratchWon'),
    nights: n('nights'), admitted: r.admitted === true, clubSpent: n('clubSpent'), tipsTonight: n('tipsTonight', 1e6),
    socks: n('socks', 255), washes: n('washes'), beat: n('beat'),
  };
}

/* ------------------------------------------------------------------------------------------ *
 * The scratch-off
 * ------------------------------------------------------------------------------------------ */

export const SCRATCH_PRICE = 5;
const SCRATCH_SALT = 0x5c7a7c4;
/** Odds are expressed over this many equally-likely outcomes, so the EV is exact integer maths and
 * the card can print "1 in N" without rounding stories. */
export const SCRATCH_DENOM = 1000;

/** [prize in dollars, outcomes out of SCRATCH_DENOM]. Anything not listed is a loser.
 *
 * Shaped like a real lotto card: plenty of ticket-price wins to keep you scratching, a thin tail,
 * one jackpot. Gross return = (5*150 + 10*80 + 25*28 + 100*7 + 500*1) / 1000 = $3.45 per $5
 * ticket = 69 cents on the dollar, so the house keeps 31% (a real state lotto keeps 35-50%; this
 * is a little kinder because the game is not trying to ruin anyone's evening). Rejected: a
 * near-fair 90%+ return (the sink would be a rounding error against a $1,000 marlin), and a
 * jackpot above $500 (one lucky card would become a boat-tier event, which is the fishing's job). */
export const SCRATCH_TABLE: ReadonlyArray<readonly [number, number]> = [
  [5, 150], [10, 80], [25, 28], [100, 7], [500, 1],
];

export interface ScratchOdds {
  /** Winning outcomes out of SCRATCH_DENOM. */
  winners: number;
  oneIn: number;
  /** Expected gross payout per ticket, dollars. */
  ev: number;
  returnPct: number;
  /** Expected profit per ticket (negative). */
  netEv: number;
  top: number;
}
export function scratchOdds(): ScratchOdds {
  const winners = SCRATCH_TABLE.reduce((a, [, w]) => a + w, 0);
  const ev = SCRATCH_TABLE.reduce((a, [p, w]) => a + p * w, 0) / SCRATCH_DENOM;
  return {
    winners, oneIn: SCRATCH_DENOM / winners, ev, returnPct: Math.round((ev / SCRATCH_PRICE) * 100),
    netEv: ev - SCRATCH_PRICE, top: Math.max(...SCRATCH_TABLE.map(([p]) => p)),
  };
}

export const SCRATCH_SYMBOLS = ['palm', 'conch', 'marlin', 'sun', 'anchor', 'gull'] as const;

export interface ScratchCard {
  /** Dollars won (0 = loser). */
  prize: number;
  /** Six cells. A winner shows exactly three of one symbol; a loser never shows three of any. */
  cells: string[];
}

/** Ticket `n` of a save with this seed. Pure and total: same (seed, n) -> same card, forever. */
export function drawScratch(seed: number, n: number): ScratchCard {
  const rng = mulberry32(hashSeed(seed >>> 0, n >>> 0, 0, SCRATCH_SALT));
  const roll = Math.floor(rng() * SCRATCH_DENOM);
  let acc = 0, prize = 0;
  for (const [p, w] of SCRATCH_TABLE) { acc += w; if (roll < acc) { prize = p; break; } }
  // Faces are cosmetic: dealt AFTER the prize from the same stream, so they can never influence it.
  const pick = (): string => SCRATCH_SYMBOLS[Math.floor(rng() * SCRATCH_SYMBOLS.length)];
  const cells: string[] = [];
  if (prize > 0) {
    const win = pick();
    const others = SCRATCH_SYMBOLS.filter((s) => s !== win);
    const spots = new Set<number>();
    while (spots.size < 3) spots.add(Math.floor(rng() * 6));
    for (let i = 0; i < 6; i++) cells.push(spots.has(i) ? win : others[Math.floor(rng() * others.length)]);
    capAtTwo(cells, win);
  } else {
    // Loser: no symbol appears three times. Two of a kind is allowed (that is the near-miss).
    for (let i = 0; i < 6; i++) cells.push(pick());
    capAtTwo(cells, '');
  }
  return { prize, cells };
}

/** Rewrites surplus copies of any non-winning symbol so none shows three times (it would read as a
 * second win). 6 cells, 6 symbols, cap 2 each: there is always room. */
function capAtTwo(cells: string[], winner: string): void {
  const count = (s: string): number => cells.filter((c) => c === s).length;
  for (const s of new Set(cells)) {
    if (s === winner) continue;
    let seen = 0;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== s) continue;
      if (++seen > 2) {
        const alt = SCRATCH_SYMBOLS.find((p) => p !== winner && count(p) < 2);
        if (alt) cells[i] = alt;
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------ *
 * The motel's fade
 * ------------------------------------------------------------------------------------------ */

/** Seconds of SIMULATED time (callers feed a clamped dt): fade to black, hold on the room card, fade back. */
export const SLEEP_TIMES = { out: 0.9, hold: 2.2, in: 1.2 } as const;

export interface SleepTimeline {
  /** Advance by dt; returns black-overlay alpha 0..1 and whether the card should be showing. */
  step(dt: number): { alpha: number; card: boolean; done: boolean };
}

/**
 * The deliberate transition. `onBlack` fires exactly once, on the first step at which the screen is
 * fully black, which is where the caller moves the sky to sunset: the player never sees the sun
 * jump, only a dark screen and a line about room 7, then a sunset already in place.
 * (The time-of-day controller would otherwise glide there over ~3 s, visibly and oddly.)
 */
export function createSleepTimeline(onBlack: () => void): SleepTimeline {
  const { out, hold, in: fadeIn } = SLEEP_TIMES;
  let t = 0, fired = false;
  return {
    step(dt: number) {
      t += Math.max(0, dt);
      if (t >= out && !fired) { fired = true; onBlack(); }
      if (t < out) return { alpha: t / out, card: false, done: false };
      if (t < out + hold) return { alpha: 1, card: true, done: false };
      const k = (t - out - hold) / fadeIn;
      return { alpha: Math.max(0, 1 - k), card: false, done: k >= 1 };
    },
  };
}

/** Sleeping drops every timed buff: eight hours is longer than any of them, and it is how a night
 * sobers you up (bar.shot / liquor.sixer are the only buffs that hurt). Same reference when there
 * is nothing to drop. */
export function sleepOff(inv: Inventory): Inventory {
  return Object.keys(inv.buffs).length === 0 ? inv : { ...inv, buffs: {} };
}

const SWAY_BUFFS = ['bar.shot', 'bar.beer', 'liquor.sixer'] as const;
/** Washes away the drink only (a laundromat is not a nap): good buffs like coffee survive. */
export function washOff(inv: Inventory): Inventory {
  const keep = Object.entries(inv.buffs).filter(([k]) => !(SWAY_BUFFS as readonly string[]).includes(k));
  return keep.length === Object.keys(inv.buffs).length ? inv : { ...inv, buffs: Object.fromEntries(keep) };
}
export const isTipsy = (inv: Inventory, nowS: number): boolean =>
  SWAY_BUFFS.some((k) => (inv.buffs[k] ?? 0) > nowS);

/* ------------------------------------------------------------------------------------------ *
 * canBuy / resolve
 * ------------------------------------------------------------------------------------------ */

export interface ServiceCtx {
  /** True when the sky is already at (or heading to) sunset, or a sleep is already under way. */
  isSunset: boolean;
  /** For the wash: is there a drink to wash off? Omit when unknown (then it is allowed). */
  tipsy?: boolean;
  boatName?: string;
}

export type Fx = 'none' | 'sleep' | 'rope' | 'sparkler' | 'spotlight' | 'scratch' | 'wash' | 'sock';

export interface Outcome {
  fx: Fx;
  /** Shown to the player in order. The first is the headline. */
  lines: string[];
  /** Dollars to credit to the wallet (scratch winnings). */
  payout: number;
  /** What the inventory should do. The caller applies it with sleepOff / washOff. */
  inventory: 'none' | 'sleep' | 'wash';
  card?: ScratchCard;
}

/**
 * Fuel: rejected, on purpose, and said out loud.
 *
 * This boat has no fuel model (sim/boat.ts has no tank and nothing reads one), the sea is large, and
 * a tank that can run dry is a stranded player: a session-ending bug in a game whose whole loop is
 * "go far, come back". A fuel system that can never strand you is a gauge that never matters, which
 * is a chore with extra steps. Also rejected: a speed boost for the can (a hull top-speed change
 * would have to cross sim/boat.ts, world.ts and the server's speed envelope for one $30 item).
 * The honest answer is that the Stop-N-Go will not sell a can the boat cannot use, and nothing is
 * charged. The shelf entry stays in content/venues.ts (that file is not mine beyond the
 * laundromat); the lead should flip it to 'planned' or delete it when convenient.
 */
export const FUEL_REFUSAL = 'The clerk slides the jerry can back. "Your boat doesn\'t take it, captain. Pump one\'s broken, pump two is broken, and it runs fine without either. Keep your thirty bucks."';

/** Why a purchase must be declined, or null. A refusal means: do not charge. */
export function canBuy(s: ServicesState, key: string, ctx: ServiceCtx): string | null {
  switch (key) {
    case 'motel.night':
      return ctx.isSunset
        ? 'The desk clerk squints at the sky. "It is already evening, hon. Rooms are for people who want it to be."'
        : null;
    case 'club.cover':
      return s.admitted ? 'The doorman checks his clipboard. "You\'re already on the list tonight. Go in."' : null;
    case 'club.tip':
      return s.admitted ? null : 'The doorman does not take the jar outside. "Tips go to the staff. Cover first, fisherman."';
    case 'boat.fuel':
      return FUEL_REFUSAL;
    case 'laundromat.wash':
      return ctx.tipsy === false ? 'You have nothing to wash off. The machine looks at you the way the bouncer does.' : null;
    default:
      return null;
  }
}

const pickLine = (rng: Rng, lines: readonly string[]): string => lines[Math.floor(rng() * lines.length)];
const flavourRng = (s: ServicesState, salt: number): Rng => mulberry32(hashSeed(s.seed, s.beat, 1, salt));

export type ClubTier = 'stranger' | 'face' | 'regular' | 'vip';
export function clubTier(spent: number): ClubTier {
  return spent >= 400 ? 'vip' : spent >= 100 ? 'regular' : spent > 0 ? 'face' : 'stranger';
}

const COVER_LINES: Record<ClubTier, readonly string[]> = {
  stranger: [
    'The doorman looks at your flip-flops, then your wallet. The rope comes off its hook.',
    '"Twenty." He takes it without looking at it. The rope comes off its hook.',
  ],
  face: [
    '"You again." A nod that costs him nothing. The rope drops.',
    'He stamps your hand with a flamingo. It will not wash off for three days.',
  ],
  regular: [
    '"Captain." He has already unhooked the rope. "Usual spot."',
    'The doorman holds the door and, for the first time, almost smiles.',
  ],
  vip: [
    'The rope is gone before you reach it. "Evening, boss. Table is warm."',
    'He takes your twenty like it is a favour he is doing you.',
  ],
};
const INSIDE_LINES = [
  'Inside: magenta haze, a mirror ball with one bad bulb, a band doing a bossa nova of a song you almost know.',
  'The stage lights go from pink to a pink you did not know existed. Somebody applauds a saxophone.',
  'The bar is lit like an aquarium. A man in a white suit is explaining crypto to a lamp.',
];
const BOTTLE_LINES = [
  'A bottle arrives with a sparkler in it, carried by two staff and a sense of occasion. Heads turn. A man you do not know raises a glass to you.',
  'The MC stops the show: "Ladies, gentlemen, and whoever left that boat double-parked: our friend has ordered the big one." You are escorted to a booth with a tiny lamp.',
  'The sparkler goes off like the Fourth of July. The bouncer, from the door, gives you a thumbs up. It is the nicest thing he has ever done.',
];
const TIP_LINES = [
  'The MC taps the mic: "A hand for the captain!" The room does it. You will be charging this to the boat.',
  'The jar goes round. Somebody on stage tips an imaginary hat at you.',
  'A towering performer in feathers sweeps a bow in your direction that moves the air in the room.',
];
const WASH_LINES = [
  'Machine 4, warm, delicate. Forty minutes of orange light and your dignity returns.',
  'The dryer eats a quarter and gives back a shirt that smells like a field you have never been in.',
];
const SOCKS = [
  'a single argyle', 'a tube sock with "DENNIS" in marker', 'a sock shaped like a crab',
  'a wool hiking sock, in Florida', 'a child\'s sock with a little shark', 'a sock that is somehow wet',
  'a fishnet stocking (nobody asks)', 'a golden sock. Probably painted.',
] as const;
export const SOCK_COUNT = SOCKS.length;

export function bitCount(n: number): number { let c = 0; for (let x = n >>> 0; x; x &= x - 1) c++; return c; }

export function resolve(s: ServicesState, key: string, ctx: ServiceCtx): { state: ServicesState; outcome: Outcome } {
  const base = { ...s, beat: s.beat + 1 };
  const rng = flavourRng(s, 0x77);
  const none: Outcome = { fx: 'none', lines: [], payout: 0, inventory: 'none' };
  switch (key) {
    case 'motel.night': {
      // Everything that is state happens here, at purchase, atomically with the wallet deduction:
      // if the tab closes mid-fade you have still had your night. Only the SKY waits for the black.
      const next = { ...base, nights: s.nights + 1, admitted: false, tipsTonight: 0 };
      return { state: next, outcome: {
        fx: 'sleep', inventory: 'sleep', payout: 0,
        lines: ['Room 7. The ice machine hums all night.', 'You wake up to sunset.', 'Progress saved.'],
      } };
    }
    case 'club.cover': {
      const tier = clubTier(s.clubSpent);
      return { state: { ...base, admitted: true, clubSpent: s.clubSpent + 20 }, outcome: {
        ...none, fx: 'rope', lines: [pickLine(rng, COVER_LINES[tier]), pickLine(rng, INSIDE_LINES)],
      } };
    }
    case 'club.bottle': {
      // Bottle service includes the rope: nobody makes a man with a $250 bottle show a cover.
      return { state: { ...base, admitted: true, clubSpent: s.clubSpent + 250 }, outcome: {
        ...none, fx: 'sparkler', lines: [pickLine(rng, BOTTLE_LINES), ...(s.admitted ? [] : ['The cover was waived. It always is, for this.'])],
      } };
    }
    case 'club.tip': {
      const tips = s.tipsTonight + 1;
      const who = ctx.boatName ? `the captain of the ${ctx.boatName}` : 'the captain';
      const lines = [pickLine(rng, TIP_LINES)];
      if (tips >= 3) lines.push(`Third tip tonight. The MC now introduces you as "${who}, patron of the arts".`);
      return { state: { ...base, tipsTonight: tips, clubSpent: s.clubSpent + 10 }, outcome: { ...none, fx: 'spotlight', lines } };
    }
    case 'liquor.scratch': {
      // Ticket number consumed here; the caller persists the new state before showing anything.
      const card = drawScratch(s.seed, s.tickets);
      const o = scratchOdds();
      const trio = card.cells.find((c) => card.cells.filter((x) => x === c).length === 3);
      const lines = card.prize > 0
        ? [`Three ${trio}s. You win $${card.prize}.`, card.prize >= 100 ? 'The clerk checks it against a light. Twice. "Huh."' : 'The clerk nods, unimpressed.']
        : ['Nothing. The card says "TRY AGAIN", as it says to everyone.'];
      lines.push(`Odds: about 1 in ${o.oneIn.toFixed(1)} tickets wins anything, and over time it pays back ${o.returnPct} cents on the dollar. Top prize $${o.top}.`);
      return { state: { ...base, tickets: s.tickets + 1, scratchSpent: s.scratchSpent + SCRATCH_PRICE, scratchWon: s.scratchWon + card.prize },
        outcome: { fx: 'scratch', lines, payout: card.prize, inventory: 'none', card } };
    }
    case 'laundromat.wash':
      return { state: { ...base, washes: s.washes + 1 }, outcome: { ...none, fx: 'wash', inventory: 'wash', lines: [pickLine(rng, WASH_LINES), 'The bar is out of your shirt.'] } };
    case 'laundromat.sock': {
      const i = Math.floor(rng() * SOCKS.length);
      const had = (s.socks >> i) & 1;
      const socks = s.socks | (1 << i);
      const count = bitCount(socks);
      const lines = [`You pull ${SOCKS[i]} out of the lost-and-found bin.`, had ? 'You already had one of those. Somehow this is worse.' : `Collection: ${count} of ${SOCK_COUNT}.`];
      if (!had && count === SOCK_COUNT) lines.push('That is the whole set. The attendant bows. You have achieved nothing, completely.');
      return { state: { ...base, socks }, outcome: { ...none, fx: 'sock', lines } };
    }
    default:
      return { state: s, outcome: none };
  }
}
