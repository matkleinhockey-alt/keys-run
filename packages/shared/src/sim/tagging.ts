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

/** von Bertalanffy-style growth rate, as the fraction of the remaining gap to the species max
 * closed per day at large. 0.02 means a 20 lb mahi (max 55) is ~26 lb after two weeks and ~38 lb
 * after two months: visible from one recapture to the next without every tagged fish being a
 * record within a week. */
export const GROWTH_K_PER_DAY = 0.02;

/** Weight after `days` at large. Never shrinks, never passes the species max (a fish tagged above
 * the max by some quirk keeps its weight rather than being pulled down to it). */
export function grownWeight(speciesKey: string, weightLb: number, days: number): number {
  const S = SPECIES[speciesKey];
  if (!S || !(days > 0) || weightLb >= S.max) return +weightLb.toFixed(2);
  const w = S.max - (S.max - weightLb) * Math.exp(-GROWTH_K_PER_DAY * days);
  return +w.toFixed(2);
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
