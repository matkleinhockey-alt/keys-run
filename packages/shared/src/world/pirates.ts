/**
 * The pirates' schedule, and what they say about your cooler. Pure: no clock read, no
 * `Math.random()`, no three.js (CI: check:no-three). The client hands in "now" and the loot, and
 * everything below is a function of those plus the world seed.
 *
 * ## Why a wall-clock bucket and not a countdown
 *
 * The obvious build is `timer -= dt; if (timer <= 0) arrive()`. Rejected for the reason
 * `frenzy.ts` replaced legacy's per-site countdown: a timer in local dt can only be tested by
 * waiting thirty minutes, drifts from every other client, and restarts from zero on every reload
 * (so a player who reloads every twenty-five minutes would never meet them). Instead time is cut
 * into 30-minute buckets and each bucket hashes (seed, bucket) to a start time, so the answer to
 * "are they due" is a function of unix seconds alone. The client injects the clock; a test
 * passes any number it likes.
 *
 * ## "About" every 30 minutes
 *
 * Each bucket's visit starts somewhere in the 40%..60% slice of the bucket. Consecutive visits
 * are therefore 24-36 minutes apart and average exactly 30, which reads as "about every half
 * hour" without being a metronome you could set a watch by. The wider 10%..90% slice was tried on
 * paper and rejected: it allows an 11-minute gap, which is not "every 30 minutes" to anyone.
 *
 * ## The late-joiner rule
 *
 * A player who loads the game 20 minutes into a visit must not have a boat materialise next to
 * them, and one who comes back from a sleeping laptop must not get a stale "they're arriving
 * now". `pirateVisitDue` reports how late you are; the client treats anything past
 * `PIRATE_JOIN_GRACE_S` as a visit you missed and waits for the next bucket. The cost is
 * honest: a ten-minute session sees them about one time in three. That is the brief ("every 30
 * minutes"), not a bug, and `__pirateDebug.summon()` exists for everyone who wants the bit now.
 */
import { hashCell } from '../rng/index.js';

/** One bucket = one scheduled visit. */
export const PIRATE_PERIOD_S = 30 * 60;
/** Where in the bucket the visit may start, as fractions of it. See the header on why narrow. */
export const PIRATE_START_LO = 0.4;
export const PIRATE_START_HI = 0.6;
/** How late into a visit's start you may be and still get the approach, seconds. The approach
 * itself is a few minutes of sailing from far off, so arriving 45 s "late" still means they
 * appear on the horizon, not on top of you. */
export const PIRATE_JOIN_GRACE_S = 45;

/** Independent salts, kept clear of frenzy.ts's 9001-9003 and the client's `SALT` table. */
const SALT_START = 9101, SALT_SEA = 9102, SALT_SPREAD = 9103, SALT_LINES = 9110;

/** Which water they sail out of. `gulf` is the north side of the chain (-z); `channel` is Hawk
 * Channel, which runs along the chain (+/-x) on the ocean side. */
export type PirateSea = 'gulf' | 'channel';

export interface PirateVisit {
  bucket: number;
  /** Unix seconds when the boat first leaves the horizon. */
  start: number;
  sea: PirateSea;
  /** -1..1: which way round the compass they favour inside that sea. For `channel` the sign is
   * east vs west along the chain. */
  spread: number;
}

export function pirateBucket(nowS: number): number {
  return Math.floor(nowS / PIRATE_PERIOD_S);
}

export function pirateVisit(seed: number, bucket: number): PirateVisit {
  const f = PIRATE_START_LO + (PIRATE_START_HI - PIRATE_START_LO) * hashCell(seed, bucket, 0, SALT_START);
  return {
    bucket,
    start: bucket * PIRATE_PERIOD_S + f * PIRATE_PERIOD_S,
    sea: hashCell(seed, bucket, 0, SALT_SEA) < 0.5 ? 'gulf' : 'channel',
    spread: hashCell(seed, bucket, 0, SALT_SPREAD) * 2 - 1,
  };
}

export interface PirateDue {
  visit: PirateVisit;
  /** Seconds past the scheduled start. */
  lateS: number;
  /** True when it is too late to arrive honestly — the caller should mark the bucket handled and
   * wait for the next one. */
  missed: boolean;
}

/**
 * Is a visit due right now? `handled` is the highest bucket the caller has already dealt with
 * (arrived, or written off as missed); starting at -Infinity is correct for a fresh page.
 * Only the current bucket is considered: a visit lasts under 12 minutes and starts no later than
 * 60% in, so it can never spill into the next bucket.
 */
export function pirateVisitDue(seed: number, nowS: number, handled: number): PirateDue | null {
  const b = pirateBucket(nowS);
  if (b <= handled) return null;
  const visit = pirateVisit(seed, b);
  if (nowS < visit.start) return null;
  const lateS = nowS - visit.start;
  return { visit, lateS, missed: lateS > PIRATE_JOIN_GRACE_S };
}

/** The next visit that has not started yet, for a debug readout or a "they're due in" hint. */
export function nextPirateVisit(seed: number, nowS: number): PirateVisit {
  const here = pirateVisit(seed, pirateBucket(nowS));
  return here.start > nowS ? here : pirateVisit(seed, pirateBucket(nowS) + 1);
}

// ---------------------------------------------------------------- what they say

/** What the player is carrying, as much as the pirates care. */
export interface PirateLoot {
  cash: number;
  /** Total pounds of fish in the cooler. */
  coolerLb: number;
  coolerCount: number;
  /** The hull's `COOLER_CAP`. */
  coolerCap: number;
  /** "Grady-White Actively Sinking" — for the insults. */
  boat?: string;
}

export type Appraisal = 'broke' | 'pocketChange' | 'someFish' | 'fullCooler' | 'rich';

/** Cash at which they treat you as rich: the economy's "Local legend" tier floor. */
export const PIRATE_RICH_CASH = 25_000;
/** Cooler fill at which it counts as a haul. */
export const PIRATE_FULL_COOLER = 0.6;
/** Below this, cash is nothing rather than pocket change. */
export const PIRATE_POCKET_CASH = 100;

/**
 * Sorts the player into the one thing the pirates will remark on. Order is the joke's priority:
 * a full cooler beats a fat wallet (they can see the cooler from the deck, they cannot see the
 * wallet), and the wallet beats a few fish.
 */
export function appraiseLoot(l: PirateLoot): Appraisal {
  const fill = l.coolerCap > 0 ? l.coolerLb / l.coolerCap : 0;
  if (l.coolerCount > 0 && fill >= PIRATE_FULL_COOLER) return 'fullCooler';
  if (l.cash >= PIRATE_RICH_CASH) return 'rich';
  if (l.coolerCount > 0) return 'someFish';
  if (l.cash >= PIRATE_POCKET_CASH) return 'pocketChange';
  return 'broke';
}

export const usd = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');

export const CAPTAIN = "Cap'n Barnacle Bev";
export const MATE = 'Mr. Mildew';

export interface PirateBeat {
  /** Seconds after the hail. */
  at: number;
  who: 'captain' | 'mate';
  text: string;
}

type LineFn = (l: PirateLoot) => string;

const HAIL: readonly LineFn[] = [
  () => 'AHOY, fibreglass! Fine-looking boat! Ye got any loot aboard?',
  (l) => (l.boat ? `Ahoy, ${l.boat}! Any loot to declare?` : 'Ahoy, shiny boat! Any loot to declare?'),
  () => 'Heave to, ye gleaming land-ship! We come in peace! And for loot!',
  () => 'AHOY! Yer boat has an engine! Ours has a bucket! Any loot?',
  () => 'Ahoy, friend! Quick question: loot?',
];

const ASK: readonly LineFn[] = [
  () => 'Doubloons? Gold? Gift cards? Cap’n would settle for a sandwich.',
  () => 'He’s asking nicely. It’s the new policy. HR made us.',
  () => 'Any treasure, jewels, or unopened Capri-Suns?',
  () => 'Cap’n says look in the cooler. Cap’n always says look in the cooler.',
];

const VERDICT: Record<Appraisal, readonly LineFn[]> = {
  broke: [
    () => 'Not a doubloon! Not a fish! Even the seagull has more than ye.',
    () => 'Empty cooler, empty pockets. Ye’re the poorest boat we’ve not robbed all week.',
    () => 'We checked. It’s just vibes aboard. Disgraceful.',
    () => 'Nothing! Ye’re sailing a boat for fun and have nothing to show for it!',
  ],
  pocketChange: [
    (l) => `${usd(l.cash)}? That’s not loot, that’s a tip jar.`,
    (l) => `Ye’ve got ${usd(l.cash)} and an empty cooler. Respect. Nothing, but respect.`,
    (l) => `${usd(l.cash)}! We’ll leave it. The parrot would charge more to listen to ye.`,
  ],
  someFish: [
    (l) => `${l.coolerCount} fish, ${Math.round(l.coolerLb)} lb on ice. That’s not loot, that’s dinner!`,
    (l) => `${Math.round(l.coolerLb)} lb of fish. Is that loot? The parrot says it’s loot.`,
    () => 'A cooler with actual fish! We accept payment in snapper.',
    (l) => `${l.coolerCount} fish? We’ll not take them. We have no ice. And no refrigeration. And no plan.`,
  ],
  fullCooler: [
    (l) => `${Math.round(l.coolerLb)} lb of fish?! That cooler’s heavier than our conscience!`,
    () => 'Blimey, that’s a haul. We’ll not touch it. Pirates’ code, article 7: respect the fisherman.',
    (l) => `${Math.round(l.coolerLb)} lb! Ye’re the real pirate here. We just have a flag.`,
    () => 'That cooler is stuffed! Ye’ve been robbing the ocean and we’re MAD at the competition.',
  ],
  rich: [
    (l) => `${usd(l.cash)}?! Ye’re LOADED! Can we borrow ten? We’ll pay ye back in exposure.`,
    (l) => `${usd(l.cash)} and ye’re sailing ${l.boat ? `a ${l.boat}` : 'that'}? Cap’n, we’re in the wrong business.`,
    (l) => `${usd(l.cash)}! Ye could buy our whole fleet. Admittedly, it’s one boat and it leaks.`,
  ],
};

const QUIP: readonly LineFn[] = [
  () => 'Fine. We’ll just be over here. Being historically accurate.',
  () => 'We tried robbing a Contender once. It left. It left very fast.',
  () => 'No robbing today. Mr. Mildew says the paperwork is a nightmare.',
  () => 'Do not tell the Coast Guard we were here. We are, uh, not insured.',
  () => 'Legally we are required to say we are reenactors.',
];

const ASIDE: readonly LineFn[] = [
  () => 'Does anyone have a sandwich?',
  () => 'Our boat has no engine. Ye can stop asking.',
  () => 'Yo ho ho. And a bottle of sparkling water. Doctor’s orders.',
  () => 'Smile for the camera, ye land-lubbers!',
  () => 'We’ve been sailing since 1722. The boat is on its first coat of paint.',
  () => 'Mind the sails. They’re mostly patches. Holy patches.',
  () => 'Is that a Yamaha? We hate it. We love it.',
  () => 'The Keys are lovely this time of year. Every time of year. We’re lost.',
  () => 'Mr. Mildew, is this still the Caribbean? — It says Marathon. — Close enough.',
  () => 'Arrr. Arrr. Wait, that’s not right either.',
];

const FAREWELL: readonly LineFn[] = [
  () => 'Fair winds! We’ll be back in half an hour. Have the loot ready!',
  () => 'Off we go! Come back with loot or come back with snacks!',
  () => 'Keep yer cooler cold and yer tales tall — see ye in thirty minutes!',
  () => 'Back around the clock in thirty minutes. We’re very punctual for pirates.',
];

const pick = <T>(xs: readonly T[], u: number): T => xs[Math.min(xs.length - 1, Math.floor(u * xs.length))];

/**
 * The whole exchange for one visit, in order, with times relative to the hail. Deterministic in
 * (seed, bucket, loot): the same visit with the same cooler always says the same thing, and two
 * different visits almost never do (every beat draws from a pool of 3-10 lines on its own hash).
 * The verdict is the one beat that reads the player; the rest is banter, but the banter is
 * picked per visit so the second visit is not a repeat of the first.
 */
export function pirateScript(seed: number, bucket: number, loot: PirateLoot): PirateBeat[] {
  const u = (i: number): number => hashCell(seed, bucket, i, SALT_LINES);
  const beats: PirateBeat[] = [
    { at: 0, who: 'captain', text: pick(HAIL, u(0))(loot) },
    { at: 5.5, who: 'mate', text: pick(ASK, u(1))(loot) },
    { at: 11, who: 'captain', text: pick(VERDICT[appraiseLoot(loot)], u(2))(loot) },
    { at: 17.5, who: 'mate', text: pick(QUIP, u(3))(loot) },
  ];
  // Two different asides, never the same one twice in a row.
  const i1 = Math.min(ASIDE.length - 1, Math.floor(u(4) * ASIDE.length));
  const i2 = (i1 + 1 + Math.floor(u(5) * (ASIDE.length - 1))) % ASIDE.length;
  beats.push({ at: 24, who: 'captain', text: ASIDE[i1](loot) });
  beats.push({ at: 30.5, who: 'mate', text: ASIDE[i2](loot) });
  beats.push({ at: 37, who: 'captain', text: pick(FAREWELL, u(6))(loot) });
  return beats;
}

/** Pool sizes, exported so a test can assert the "several lines, does not get stale" promise. */
export const PIRATE_POOLS = {
  hail: HAIL.length, ask: ASK.length, quip: QUIP.length, aside: ASIDE.length, farewell: FAREWELL.length,
  verdict: Object.fromEntries(Object.entries(VERDICT).map(([k, v]) => [k, v.length])) as Record<Appraisal, number>,
};
