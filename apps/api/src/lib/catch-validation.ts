/**
 * Species/weight plausibility check for POST /catches — see that route's doc
 * comment for the full honesty tradeoff this is one piece of. Pure and
 * DB-free on purpose, so the scoring itself is trivially unit-testable
 * without a database (the route's own integration tests in
 * test/catches.test.ts cover the end-to-end behaviour this feeds).
 */
import { SPECIES, type SpeciesDef } from '@keysrun/shared/content/species';

export interface WeightAssessment {
  species: SpeciesDef;
  /**
   * 0 when `weightLb` falls within [species.min, species.max] — the normal,
   * trusted case. Otherwise a positive score: how far outside the boundary
   * it crossed, as a fraction of that boundary (e.g. 0.5 under `min` means
   * "half of the species' minimum possible weight"; 0.5 over `max` means
   * "50% heavier than the species' max"). Not a calibrated probability —
   * just enough signal to rank/triage `audit_flags` rows, never to reject
   * outright (see routes/catches.ts: out-of-range is flagged, not rejected).
   */
  suspicion: number;
}

/** Returns `null` only when `speciesKey` isn't in packages/shared's SPECIES table — the one case
 * routes/catches.ts treats as a hard 400 rather than a suspicion flag, since an unknown key isn't
 * "an implausible real fish", it's not a fish this game has at all. */
export function assessCatch(speciesKey: string, weightLb: number): WeightAssessment | null {
  const species = SPECIES[speciesKey];
  if (!species) return null;

  let suspicion = 0;
  if (weightLb < species.min) suspicion = (species.min - weightLb) / species.min;
  else if (weightLb > species.max) suspicion = (weightLb - species.max) / species.max;

  return { species, suspicion };
}
