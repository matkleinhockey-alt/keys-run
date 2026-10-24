/**
 * Tag-and-release: how a tagged fish lives on between catches.
 *
 * Pure (no three.js, no DOM, no `Date.now()`) in the same shape as fight.ts / economy.ts, so
 * apps/api (which owns the shared registry) and the client's offline registry run the identical
 * rules. Elapsed time is always passed in, in days, by the caller.
 *
 * A tagged fish is one persistent individual: it keeps its species, keeps growing in real time
 * while it is at large, and wanders away from where it was last released. Anyone who hooks a fish
 * of that species near where it could have wandered to may be hooking *that* fish — then the
 * catch card shows its tag, who tagged it, and every recapture since.
 */
import { SPECIES } from '../content/species.js';

/** von Bertalanffy-style growth rate, as the fraction of the remaining gap to this fish's own
 * ceiling (`growthCeiling`) closed per day at large. 0.02 means a 20 lb mahi (max 55) is ~26 lb after two weeks and ~38 lb
 * after two months: visible from one recapture to the next without every tagged fish being a
 * record within a week. */
export const GROWTH_K_PER_DAY = 0.02;

/**
 * The weight THIS individual is growing towards — its own ceiling, not the species record.
 *
 * Growth used to use `SPECIES.max` as the asymptote for every tagged fish, which meant time
 * alone produced records: at k = 0.02/day a tarpon tagged at 80 lb reaches 159.95 lb of a 160 lb
 * maximum inside a year, and so does every other tarpon. Any tag left out long enough came back
 * a record, and the species leaderboard became a question of patience rather than of catching
 * anything. Real fish each stop at their own size, and only a rare one approaches the biggest
 * ever recorded.
 *
 * So each tag draws a ceiling from its own number, uniformly between the middle of the species
 * range and the record. Half of all tagged fish therefore top out below the three-quarter mark,
 * and a fish that genuinely grows into a record is uncommon. It is derived rather than stored:
 * the tag number is already a stable per-fish identity in both registries, so this needs no new
 * column and no migration, and the same fish grows the same way wherever it is evaluated.
 *
 * A fish tagged above its drawn ceiling (a big one from the start) keeps the larger figure: the
 * ceiling can only ever be the bigger of the two, never a reason to shrink.
 */
export function growthCeiling(speciesKey: string, weightLb: number, tagNo: number): number {
  const S = SPECIES[speciesKey];
  if (!S) return weightLb;
  // Integer hash of the tag number -> u in [0,1). Deterministic and stable for the life of
  // the tag; no stored state, so client and server always agree.
  let h = Math.imul(tagNo ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  const u = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  const mid = (S.min + S.max) / 2;
  return Math.max(weightLb, mid + (S.max - mid) * u);
}

/** Weight after `days` at large, growing towards this individual's own ceiling (see
 * `growthCeiling`). Never shrinks, and never passes that ceiling. */
export function grownWeight(speciesKey: string, weightLb: number, days: number, tagNo: number): number {
  const S = SPECIES[speciesKey];
  if (!S || !(days > 0)) return +weightLb.toFixed(2);
  const ceiling = growthCeiling(speciesKey, weightLb, tagNo);
  if (weightLb >= ceiling) return +weightLb.toFixed(2);
  const w = ceiling - (ceiling - weightLb) * Math.exp(-GROWTH_K_PER_DAY * days);
  // Clamp AFTER rounding: a fish all but converged rounds up, and 2 dp of rounding was enough to
  // report a weight a hundredth of a pound past its own ceiling.
  return Math.min(+w.toFixed(2), +ceiling.toFixed(2));
}

/** `"KR-00042"` -> `42`. The client registry carries the printed code rather than the raw
 * number, and `grownWeight` needs the number to find this fish's own ceiling. */
export function tagNoFromCode(code: string): number {
  return Number.parseInt(code.replace(/^KR-/, ''), 10) || 0;
}

/** How far (world metres) a tagged fish may have moved from its last release point. A fish just
 * released is still on the same patch; after a few weeks it could be anywhere along a stretch of
 * reef, capped so a tag never becomes catchable from one end of the chain to the other. */
export function wanderRadiusM(days: number): number {
  return Math.min(1500, 150 + 40 * Math.max(0, days));
}

/** A released tagged fish is off the bite for this long — it is not instantly re-hookable on the
 * very next cast (which would also let a player farm the release bonus off one fish). */
export const RECAPTURE_COOLDOWN_MS = 10 * 60 * 1000;

/** Given a candidate tagged fish of the right species within range, the chance the fish on the
 * line is that individual rather than an untagged one. */
export const RECAPTURE_P = 0.5;

/** Conservation bonus for releasing a fish with a fresh tag, as a fraction of the catch's points
 * (plain release is 0.25 — see apps/client/src/game/catch/catch-flow.ts). */
export const TAG_RELEASE_BONUS = 0.4;
/** Bonus for reporting a recaptured tag and releasing it again — the data point is the valuable
 * part of a tagging programme. */
export const RECAPTURE_RELEASE_BONUS = 0.6;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Human-readable tag number, e.g. 42 -> "KR-00042". */
export function tagCode(tagNo: number): string {
  return 'KR-' + String(tagNo).padStart(5, '0');
}

export type TagEventKind = 'tagged' | 'released' | 'harvested';

export interface TagEvent {
  kind: TagEventKind;
  displayName: string;
  weightLb: number;
  zone: string;
  x: number;
  z: number;
  /** ISO timestamp. */
  at: string;
}

/** One tagged individual as both registries hand it to the client. `weightLb` is its weight
 * *now* (grown since `lastSeenAt`), not the weight it was last caught at — that is the last event's. */
export interface TaggedFish {
  id: string;
  code: string;
  speciesKey: string;
  weightLb: number;
  x: number;
  z: number;
  status: 'at_large' | 'harvested';
  lastSeenAt: string;
  events: TagEvent[];
}
