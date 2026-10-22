/**
 * What a landed cast is "into": an oil rig, a sargassum weedline, a live bird-and-bait frenzy,
 * or plain water. Pure and three-free so test/spot.test.ts can drive it with fakes.
 *
 * Order matters: rig > weedline > frenzy. A rig and a boiling bait ball can overlap offshore,
 * and the rig's table (amberjack, cobia) is the rarer, more specific prize; a frenzy on top of
 * it still gets its bite-speed and rare-odds bonus because `hs` is set for all three.
 *
 * A wreck sits between rig and weedline: it is a fixed piece of structure like a rig (a weedline
 * drifts 20 m a minute and only sometimes passes over one), and its table is the one that
 * carries the big resident fish, so a cast that is both on a wreck and under a drifting weedline
 * should get the wreck's fish. It cannot overlap a rig (they are 1.5 km+ apart; asserted in
 * test/wrecks.test.ts), so rig > wreck is only a tiebreak for the contract.
 *
 * Rigs and weedlines set `hs` too (legacy `F.hs` was "any hotspot-like spot"): without it the
 * rare entries that only exist in those tables (sailfish 1, wahoo 1.5) sit at base odds and a
 * rig bites no faster than empty water, which would make the 2,500 m run to one pointless.
 */
export interface SpotQuery {
  nearHotspot(x: number, z: number): { fr: number } | null;
  nearWeed(x: number, z: number): unknown | null;
  nearRig(x: number, z: number): unknown | null;
  /** The shipwreck a cast at (x,z) landed on, or null. Optional so existing harnesses that build
   * a `SpotQuery` by hand keep compiling; absent means "no wrecks here". */
  nearWreck?(x: number, z: number): { name: string } | null;
}

export interface CastSpot {
  zone: string;
  hs: { fr: number } | null;
  /** For the cast toast: which special spot this was, or null. */
  kind: 'rig' | 'wreck' | 'weedline' | 'frenzy' | null;
  /** The wreck's name for the cast toast, when `kind === 'wreck'`. */
  wreckName?: string;
}

export function resolveCastSpot(q: SpotQuery, x: number, z: number, baseZone: string): CastSpot {
  const hot = q.nearHotspot(x, z);
  if (q.nearRig(x, z)) return { zone: 'Oil Rig', hs: hot ?? { fr: 1 }, kind: 'rig' };
  const wreck = q.nearWreck?.(x, z);
  if (wreck) return { zone: 'Wreck', hs: hot ?? { fr: 1 }, kind: 'wreck', wreckName: wreck.name };
  if (q.nearWeed(x, z)) return { zone: 'Weedline', hs: hot ?? { fr: 1 }, kind: 'weedline' };
  if (hot) return { zone: baseZone, hs: hot, kind: 'frenzy' };
  return { zone: baseZone, hs: null, kind: null };
}

/** No-op query for harnesses/tests with no life systems. */
export const NO_SPOTS: SpotQuery = { nearHotspot: () => null, nearWeed: () => null, nearRig: () => null };
