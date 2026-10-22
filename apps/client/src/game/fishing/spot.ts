/**
 * What a landed cast is "into": an oil rig, a sargassum weedline, a live bird-and-bait frenzy,
 * or plain water. Pure and three-free so test/spot.test.ts can drive it with fakes.
 *
 * Order matters: rig > weedline > frenzy. A rig and a boiling bait ball can overlap offshore,
 * and the rig's table (amberjack, cobia) is the rarer, more specific prize; a frenzy on top of
 * it still gets its bite-speed and rare-odds bonus because `hs` is set for all three.
 *
 * Rigs and weedlines set `hs` too (legacy `F.hs` was "any hotspot-like spot"): without it the
 * rare entries that only exist in those tables (sailfish 1, wahoo 1.5) sit at base odds and a
 * rig bites no faster than empty water, which would make the 2,500 m run to one pointless.
 */
export interface SpotQuery {
  nearHotspot(x: number, z: number): { fr: number } | null;
  nearWeed(x: number, z: number): unknown | null;
  nearRig(x: number, z: number): unknown | null;
}

export interface CastSpot {
  zone: string;
  hs: { fr: number } | null;
  /** For the cast toast: which special spot this was, or null. */
  kind: 'rig' | 'weedline' | 'frenzy' | null;
}

export function resolveCastSpot(q: SpotQuery, x: number, z: number, baseZone: string): CastSpot {
  const hot = q.nearHotspot(x, z);
  if (q.nearRig(x, z)) return { zone: 'Oil Rig', hs: hot ?? { fr: 1 }, kind: 'rig' };
  if (q.nearWeed(x, z)) return { zone: 'Weedline', hs: hot ?? { fr: 1 }, kind: 'weedline' };
  if (hot) return { zone: baseZone, hs: hot, kind: 'frenzy' };
  return { zone: baseZone, hs: null, kind: null };
}

/** No-op query for harnesses/tests with no life systems. */
export const NO_SPOTS: SpotQuery = { nearHotspot: () => null, nearWeed: () => null, nearRig: () => null };
