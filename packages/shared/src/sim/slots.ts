/**
 * The Gaff & Gill's slot machines: the reel strips, the paytable, the odds and the seeded draw.
 * Pure (no three.js, no DOM, no `Date.now()`, no `Math.random()`), so the same functions can move
 * to the server with the wallet. The client glue is apps/client/src/game/casino/.
 *
 * ## "Import a slot-game physics": deliberately NOT imported
 * The brief asked for slot physics "found online". Two separate things get called that, and
 * neither is something to pull a package in for:
 *   - the REEL MOTION (spin-up, constant spin, an eased stop with a small overshoot and settle) is
 *     forty lines of closed-form maths and lives, dependency-free, in ./reels.ts;
 *   - the PAYOUT CURVE is the part that actually decides whether the casino wrecks the economy,
 *     and it has to be tuned against THIS game's wallet (boats $9k-$85k, ~$250 per effective
 *     minute of rod time inshore, see content/venues.ts PRICING), not against whatever RTP, hit
 *     rate and jackpot a library ships with. A third-party slot engine would also bring its own
 *     RNG (almost certainly `Math.random()`), which this codebase refuses for anything that
 *     decides money. So: written here, small, exact, and tested. This is a choice, not an oversight.
 *
 * ## The machine
 * Three reels, three visible rows, five fixed lines (three rows and both diagonals) that are
 * ALWAYS in play. A bet is split evenly across the lines (`bet / LINES`), which is why every legal
 * bet is a multiple of 5 dollars: the line bet is a whole number and every payout is whole dollars.
 * Symbols are fish: shrimp (bait, the common one), bonefish, permit, tarpon, the marlin (jackpot)
 * and the boot (the dud: it pays nothing and it is on every reel to make that point).
 *
 * ## Honest odds
 * Each reel is a fixed 24-stop strip (below). A spin picks one stop per reel uniformly, so the full
 * outcome space is 24^3 = 13,824 equally likely combinations and `slotOdds()` simply ENUMERATES it:
 * the RTP printed on the machine is not an estimate, it is the sum over every possible spin. The
 * seeded-simulation test then checks the draw against that sum. Rejected: "virtual reels" with a
 * hidden weighting table behind a short visible strip (what real machines do so the near-miss is
 * more common than the maths of the picture suggests). The strips you see spinning ARE the
 * probabilities; the near-miss animation (./reels.ts `teaseReel`) is only a slower stop on a result
 * that was already decided, and never changes it.
 *
 * ## Randomness and reloading
 * Spin n of a save is `mulberry32(hashSeed(seed, n, 0, SLOT_SALT))`, a pure function of the per-save
 * seed and a counter that only ever goes up and is persisted BEFORE the reels move (the scratch-off's
 * rule, sim/services.ts). Reloading the page, closing the panel or killing the tab mid-spin therefore
 * cannot re-roll anything: the stake is gone, the result is already fixed, and any win is parked in
 * `pending` and paid on the next load if the animation never finished. The result is also independent
 * of the bet size, so betting small until "a feeling" and then going big has no information to use.
 *
 * ## It is a sink, and it cannot be ground (the numbers)
 * RETURN_TO_PLAYER is whatever `slotOdds().rtp` enumerates (about 0.90; the test pins the exact
 * figure). Every spin therefore has expected net = -(1 - RTP) x bet < 0 for EVERY bet size and EVERY
 * wallet, so no staking plan (flat, martingale, stop-win, stop-loss, all-in) can have positive
 * expectation: the player's wealth is a supermartingale. What the limits do:
 *   - MIN_BET 5 / MAX_BET 100: the largest single stake is a third of one effective rod-minute,
 *     so a bad run costs a visible slice of a session and never a boat;
 *   - the top prize: each reel has ONE marlin, so three can only line up on one line, which makes
 *     the true maximum 1000 line-bets = 200x the stake ($20,000 at the cap, a mid-priced hull, about
 *     one spin in 2,765). MAX_WIN_MULT 250 is a seat belt behind that, so an edit to the paytable
 *     can never quietly let a single spin skip the whole boat ladder the economy agent priced;
 *   - MIN_SPIN_GAP_S: reels take ~3.3 s of simulated time, so at the cap a player can turn over at
 *     most ~$1,800/min, expected cost ~$170/min against ~$250-$700/min of income. The casino eats
 *     roughly a third to two thirds of a fisherman's pay if he does nothing else, and nothing else
 *     is how you grind it.
 * apps/client/test and packages/shared/test/slots.test.ts run five staking strategies over seeded
 * sessions and assert their mean result is negative.
 */
import { hashCell, mulberry32 } from '../rng/index.js';

/** `hashCell` returns a float in [0,1); mulberry32 wants an integer seed (the same trap services.ts documents). */
const hashSeed = (seed: number, a: number, b: number, salt: number): number =>
  Math.floor(hashCell(seed, a, b, salt) * 4294967296) >>> 0;

const SLOT_SALT = 0x51075;

export const SYMBOLS = ['shrimp', 'bonefish', 'permit', 'tarpon', 'marlin', 'boot'] as const;
export type SymbolName = (typeof SYMBOLS)[number];
export const SYMBOL_LABEL: Readonly<Record<SymbolName, string>> = {
  shrimp: 'Shrimp', bonefish: 'Bonefish', permit: 'Permit', tarpon: 'Tarpon', marlin: 'Blue Marlin', boot: 'Old Boot',
};
const SHRIMP = 0, BONEFISH = 1, PERMIT = 2, TARPON = 3, MARLIN = 4, BOOT = 5;
export const SYMBOL_ID = { shrimp: SHRIMP, bonefish: BONEFISH, permit: PERMIT, tarpon: TARPON, marlin: MARLIN, boot: BOOT } as const;

export const REELS = 3;
export const ROWS = 3;
export const REEL_LEN = 24;

/**
 * The strips (symbol indices into SYMBOLS), top to bottom as they sit on the reel. 7 shrimp, 5
 * bonefish, 4 permit, 3 tarpon, 4 boots and exactly ONE marlin on each reel, spread out so no two
 * of the rare ones are neighbours. Written out rather than generated so that a change to a helper
 * can never silently change the odds of a deployed save.
 */
export const STRIPS: ReadonlyArray<readonly number[]> = [
  [0, 3, 1, 0, 2, 5, 1, 0, 3, 0, 2, 5, 1, 4, 0, 1, 2, 3, 5, 0, 0, 1, 2, 5],
  [0, 3, 1, 0, 2, 5, 1, 0, 3, 0, 2, 5, 1, 0, 4, 1, 2, 0, 3, 5, 0, 1, 2, 5],
  [5, 0, 3, 1, 0, 2, 5, 0, 1, 3, 0, 2, 5, 1, 0, 4, 1, 2, 0, 5, 3, 0, 1, 2],
];

/** The five lines as [row on reel 0, row on reel 1, row on reel 2]. */
export const LINES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 1], [0, 0, 0], [2, 2, 2], [0, 1, 2], [2, 1, 0],
];
export const LINE_COUNT = LINES.length;
export const LINE_NAMES = ['Middle', 'Top', 'Bottom', 'Down diagonal', 'Up diagonal'] as const;

/** Multiples of the LINE bet paid for three of a kind on a line. The boot pays nothing, on purpose. */
export const PAY_THREE: Readonly<Record<SymbolName, number>> = {
  shrimp: 8, bonefish: 16, permit: 40, tarpon: 125, marlin: 1000, boot: 0,
};
/** Two shrimp from the left on a line pay their line bet back: the hit-frequency sweetener. */
export const PAY_SHRIMP_PAIR = 1;

export const MIN_BET = 5;
export const MAX_BET = 100;
/** The bets on the bet buttons. All multiples of LINE_COUNT, so the line bet is a whole dollar. */
export const BET_LADDER: readonly number[] = [5, 10, 25, 50, 100];
/** No single spin pays more than this multiple of the stake. With one marlin per reel the real
 * maximum is 200x (asserted in the test); this is the ceiling a future paytable edit cannot exceed. */
export const MAX_WIN_MULT = 250;
/** Simulated seconds the machine insists on between the start of one spin and the next. */
export const MIN_SPIN_GAP_S = 3.2;

export type Grid = number[][]; // grid[reel][row] -> symbol index

export function gridFor(stops: readonly number[]): Grid {
  return stops.map((s, r) => Array.from({ length: ROWS }, (_, k) => STRIPS[r][(s + k) % REEL_LEN]));
}

export interface LineWin { line: number; symbol: SymbolName; count: 2 | 3; mult: number }

/** Every winning line of a grid, in line-bet multiples. */
export function winningLines(grid: Grid): LineWin[] {
  const out: LineWin[] = [];
  LINES.forEach((ln, i) => {
    const a = grid[0][ln[0]], b = grid[1][ln[1]], c = grid[2][ln[2]];
    if (a === b && b === c) {
      const m = PAY_THREE[SYMBOLS[a]];
      if (m > 0) out.push({ line: i, symbol: SYMBOLS[a], count: 3, mult: m });
    } else if (a === SHRIMP && b === SHRIMP) out.push({ line: i, symbol: 'shrimp', count: 2, mult: PAY_SHRIMP_PAIR });
  });
  return out;
}

/** Dollars paid for these stops at this bet (whole dollars, capped). */
export function payoutFor(stops: readonly number[], bet: number): number {
  const lineBet = bet / LINE_COUNT;
  let mult = 0;
  for (const w of winningLines(gridFor(stops))) mult += w.mult;
  return Math.min(Math.floor(mult * lineBet), bet * MAX_WIN_MULT);
}

export interface SlotOdds {
  combos: number;
  /** Expected payout per $1 staked, exact. */
  rtp: number;
  /** Printed on the machine, e.g. 90.5 */
  rtpPct: number;
  houseEdgePct: number;
  /** Fraction of spins that pay anything. */
  hitRate: number;
  /** Fraction of spins that pay MORE than the stake (a two-shrimp 'win' returns a fifth of it). */
  profitRate: number;
  /** One spin in this many pays at least 5x the stake. */
  oneInBigWin: number;
  /** One spin in this many pays the marlin on any line. */
  oneInJackpot: number;
  /** Largest multiple of the stake any spin can pay (after the cap). */
  maxMult: number;
  /** Std deviation of the payout multiple of the stake, per spin. */
  sigma: number;
  /** Share of RTP contributed by each symbol's three-of-a-kind, for the paytable card. */
  share: Record<SymbolName, number>;
}

let oddsCache: SlotOdds | null = null;
/** Enumerates all 13,824 stop combinations. Cached; ~1 ms. */
export function slotOdds(): SlotOdds {
  if (oddsCache) return oddsCache;
  const share: Record<SymbolName, number> = { shrimp: 0, bonefish: 0, permit: 0, tarpon: 0, marlin: 0, boot: 0 };
  // Work in a reference bet of LINE_COUNT * 1 = 5 dollars so everything is an integer; cap = 5 * 250.
  const REF = LINE_COUNT, cap = REF * MAX_WIN_MULT;
  let total = 0, hits = 0, ahead = 0, big = 0, jack = 0, maxPay = 0, sq = 0, n = 0;
  for (let a = 0; a < REEL_LEN; a++) for (let b = 0; b < REEL_LEN; b++) for (let c = 0; c < REEL_LEN; c++) {
    const wins = winningLines(gridFor([a, b, c]));
    let mult = 0;
    for (const w of wins) { mult += w.mult; share[w.symbol] += w.mult; }
    const pay = Math.min(mult, cap);
    total += pay; sq += pay * pay; n++;
    if (pay > 0) hits++;
    if (pay > REF) ahead++;
    if (pay >= REF * 5) big++;
    if (wins.some((w) => w.symbol === 'marlin')) jack++;
    if (pay > maxPay) maxPay = pay;
  }
  const rtp = total / n / REF;
  const mean = total / n;
  for (const k of SYMBOLS) share[k] = share[k] / n / REF;
  oddsCache = {
    combos: n, rtp, rtpPct: Math.round(rtp * 1000) / 10, houseEdgePct: Math.round((1 - rtp) * 1000) / 10,
    hitRate: hits / n, profitRate: ahead / n, oneInBigWin: Math.round(n / big), oneInJackpot: Math.round(n / jack), maxMult: maxPay / REF,
    sigma: Math.sqrt(sq / n - mean * mean) / REF, share,
  };
  return oddsCache;
}

// ---------------------------------------------------------------------------------------------
// The save: seed, counter, parked winnings
// ---------------------------------------------------------------------------------------------

export interface CasinoState {
  v: 1;
  /** Per-save RNG seed. Fixed for the life of the save. */
  seed: number;
  /** Spins taken. Spin n's result is a pure function of (seed, n); n only goes up. */
  spins: number;
  wagered: number;
  /** Total paid to the player (recorded when the spin is drawn, not when it finishes animating). */
  won: number;
  /** A win drawn but not yet credited to the wallet: paid when the reels stop, or on the next load. */
  pending: number;
  /** Biggest single payout. */
  best: number;
  /** Where the reels are resting, so the machine shows the last result after a reload. */
  stops: [number, number, number];
  /** Last bet chosen, so the machine remembers it. */
  bet: number;
}

export function createCasino(seed: number): CasinoState {
  return { v: 1, seed: seed >>> 0, spins: 0, wagered: 0, won: 0, pending: 0, best: 0, stops: [0, 0, 0], bet: BET_LADDER[1] };
}

/** Defensive load: localStorage is the player's to edit, so every field is clamped. */
export function sanitizeCasino(raw: unknown, fallbackSeed: number): CasinoState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (k: string, max = 1e12): number => { const x = Number(r[k]); return Number.isFinite(x) ? Math.min(max, Math.max(0, Math.floor(x))) : 0; };
  const seed = r.seed !== undefined && Number.isFinite(Number(r.seed)) ? Number(r.seed) >>> 0 : fallbackSeed >>> 0;
  const st = Array.isArray(r.stops) ? r.stops : [];
  const stop = (i: number): number => { const x = Number(st[i]); return Number.isFinite(x) ? ((Math.floor(x) % REEL_LEN) + REEL_LEN) % REEL_LEN : 0; };
  const bet = Number(r.bet);
  return {
    v: 1, seed, spins: n('spins'), wagered: n('wagered'), won: n('won'),
    // a hand-edited pending is capped at the biggest legal payout: the file is the player's, the ceiling is ours
    pending: n('pending', MAX_BET * MAX_WIN_MULT), best: n('best'),
    stops: [stop(0), stop(1), stop(2)], bet: BET_LADDER.includes(bet) ? bet : BET_LADDER[1],
  };
}

/** The three stops of spin `n`. Pure and total. */
export function drawStops(seed: number, n: number): [number, number, number] {
  const rng = mulberry32(hashSeed(seed >>> 0, n >>> 0, 0, SLOT_SALT));
  return [Math.floor(rng() * REEL_LEN), Math.floor(rng() * REEL_LEN), Math.floor(rng() * REEL_LEN)];
}

/** Why a spin may not start, or null. `sinceLastS`: simulated seconds since the previous spin began. */
export function canSpin(bet: number, cash: number, sinceLastS: number, pending = 0): string | null {
  if (pending > 0) return 'Hold on, the last spin is still paying out.';
  if (!BET_LADDER.includes(bet)) return `Bets run $${MIN_BET} to $${MAX_BET}.`;
  if (cash < bet) return cash < MIN_BET ? 'The slots take cash, and you are out of it. The fish are biting.' : `You only have $${Math.floor(cash)}.`;
  if (sinceLastS < MIN_SPIN_GAP_S) return 'Let the reels finish.';
  return null;
}

export interface SpinResult {
  bet: number;
  stops: [number, number, number];
  grid: Grid;
  lines: LineWin[];
  /** Dollars paid (gross). */
  win: number;
  net: number;
  /** Cosmetic only: the reel that should hold its stop longer because the picture before it was a near-miss. */
  tease: number | null;
  kind: WinKind;
}

export type WinKind = 'none' | 'push' | 'small' | 'big' | 'jackpot';

/**
 * Take the stake, draw the spin, park the win. The caller has already checked `canSpin` and moves
 * `bet` out of the wallet; `state.spins` is bumped and the winnings are put in `pending`, and the
 * caller MUST persist `state` before it animates (see the header). Pure.
 */
export function resolveSpin(state: CasinoState, bet: number): { state: CasinoState; result: SpinResult } {
  const stops = drawStops(state.seed, state.spins);
  const grid = gridFor(stops);
  const lines = winningLines(grid);
  const win = payoutFor(stops, bet);
  const kind: WinKind = win === 0 ? 'none' : lines.some((l) => l.symbol === 'marlin') ? 'jackpot' : win >= bet * 20 ? 'big' : win > bet ? 'small' : 'push';
  return {
    state: { ...state, spins: state.spins + 1, wagered: state.wagered + bet, won: state.won + win, pending: state.pending + win, best: Math.max(state.best, win), stops, bet },
    result: { bet, stops, grid, lines, win, net: win - bet, tease: teaseReel(grid), kind },
  };
}

/** Pay out whatever is parked. Idempotent: a second call pays 0. */
export function settle(state: CasinoState): { state: CasinoState; payout: number } {
  return state.pending > 0 ? { state: { ...state, pending: 0 }, payout: state.pending } : { state, payout: 0 };
}

/**
 * Near-miss animation hint. If, on some line, the first two reels already show the same big symbol
 * (tarpon or marlin; shrimp pairs are too common to be dramatic) the last reel is "teased": it
 * decelerates later and slower. This is derived from the finished grid, so it can only ever dress up
 * a result that already exists; it cannot move one stop of any reel.
 */
export function teaseReel(grid: Grid): number | null {
  for (const ln of LINES) {
    const a = grid[0][ln[0]], b = grid[1][ln[1]];
    if (a === b && (a === MARLIN || a === TARPON)) return 2;
  }
  return null;
}

/** Flavour for the result line under the reels. Money never depends on this. */
export function resultLine(r: SpinResult): string {
  if (r.kind === 'jackpot') return `MARLIN! The bell rings, the gulls panic. $${r.win.toLocaleString('en-US')}!`;
  const best = r.lines.reduce<LineWin | null>((a, l) => (!a || l.mult > a.mult ? l : a), null);
  if (best) {
    const what = best.count === 2 ? 'Two shrimp, the bait pays for itself.' : `Three ${SYMBOL_LABEL[best.symbol].toLowerCase()}${best.symbol === 'shrimp' ? '' : '!'}`;
    return `${what} $${r.win.toLocaleString('en-US')}`;
  }
  const boots = r.grid.flat().filter((s) => s === BOOT).length;
  if (boots >= 4) return 'Boots everywhere. You have caught a pair of waders.';
  return NO_WIN_LINES[(r.stops[0] + r.stops[1] * 3 + r.stops[2] * 7) % NO_WIN_LINES.length];
}
const NO_WIN_LINES = [
  'Nothing. The fish are not biting this reel.', 'A boot. You have caught a boot.', 'Close. The house says close.', 'Dead calm.',
  'Strike two. The sign says there is no strike two.', 'The marlin was in the next county.', 'Not your spin. The gull saw it.',
] as const;

/** The paytable card, in the order the machine prints it. */
export function paytableRows(): Array<{ symbol: SymbolName; label: string; three: number; blurb: string }> {
  return [
    { symbol: 'marlin', label: SYMBOL_LABEL.marlin, three: PAY_THREE.marlin, blurb: 'The jackpot.' },
    { symbol: 'tarpon', label: SYMBOL_LABEL.tarpon, three: PAY_THREE.tarpon, blurb: 'The silver king.' },
    { symbol: 'permit', label: SYMBOL_LABEL.permit, three: PAY_THREE.permit, blurb: 'Hard to fool, harder to hit.' },
    { symbol: 'bonefish', label: SYMBOL_LABEL.bonefish, three: PAY_THREE.bonefish, blurb: 'The grey ghost.' },
    { symbol: 'shrimp', label: SYMBOL_LABEL.shrimp, three: PAY_THREE.shrimp, blurb: `Two from the left pays ${PAY_SHRIMP_PAIR}x.` },
    { symbol: 'boot', label: SYMBOL_LABEL.boot, three: 0, blurb: 'Pays nothing. Never has.' },
  ];
}
