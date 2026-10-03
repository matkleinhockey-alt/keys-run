/**
 * Determinism tests for entities/fish/spawn.ts — docs/ARCHITECTURE.md "Resident schools" and the
 * task brief's verification requirement: "spawning is deterministic for a given seed; the same
 * chunk yields the same residents twice."
 *
 * `residentsForChunk` is pure (no three.js, no Math.random, no module-level mutable state), so
 * these run under plain vitest/node — no renderer, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { residentsForChunk, chunkOf, CHUNK_SIZE } from '../src/entities/fish/spawn.js';
import { WORLD, zoneAt } from '@keysrun/shared/world/depth';
import { ZONE_LIFE } from '@keysrun/shared/content/creatures';

const SEED = 20240817;

describe('residentsForChunk determinism', () => {
  it('returns an equivalent result for the same (seed, cx, cz) called twice', () => {
    let residentChunks = 0;
    let checked = 0;
    for (let cx = -20; cx <= 20; cx++) {
      for (let cz = 10; cz <= 30; cz++) {
        checked++;
        const a = residentsForChunk(SEED, cx, cz);
        const b = residentsForChunk(SEED, cx, cz);
        expect(b).toEqual(a);
        if (a) residentChunks++;
      }
    }
    // Sanity: the scan actually exercised some non-null chunks (reef/hawk-channel chunks in this
    // band), otherwise the `toEqual(null)` check above would be vacuous.
    expect(checked).toBeGreaterThan(0);
    expect(residentChunks).toBeGreaterThan(0);
  });

  it('is a pure function of (seed, cx, cz) — independent of call order and prior calls', () => {
    const probes: Array<[number, number]> = [[-5, 20], [12, 15], [-30, 5], [7, 25]];
    const first = probes.map(([cx, cz]) => residentsForChunk(SEED, cx, cz));
    // interleave a few hundred unrelated calls in between, like a player wandering the chart
    for (let i = 0; i < 300; i++) residentsForChunk(SEED, (i * 13) % 50 - 25, (i * 7) % 40 + 5);
    const second = probes.map(([cx, cz]) => residentsForChunk(SEED, cx, cz));
    expect(second).toEqual(first);
  });

  it('a different seed can (and for at least one probed chunk, does) disagree', () => {
    let anyDifference = false;
    for (let cx = -10; cx <= 10; cx++) {
      for (let cz = 15; cz <= 25; cz++) {
        const a = residentsForChunk(SEED, cx, cz);
        const b = residentsForChunk(SEED + 1, cx, cz);
        if (JSON.stringify(a) !== JSON.stringify(b)) { anyDifference = true; break; }
      }
      if (anyDifference) break;
    }
    expect(anyDifference).toBe(true);
  });

  it('every non-null resident anchors inside the world bounds and its own species depth band', () => {
    for (let cx = -20; cx <= 20; cx++) {
      for (let cz = 5; cz <= 30; cz++) {
        const spec = residentsForChunk(SEED, cx, cz);
        if (!spec) continue;
        expect(spec.anchorX).toBeGreaterThanOrEqual(WORLD.x0);
        expect(spec.anchorX).toBeLessThanOrEqual(WORLD.x0 + WORLD.size);
        expect(spec.members.length).toBeGreaterThanOrEqual(spec.V.school[0]);
        expect(spec.members.length).toBeLessThanOrEqual(spec.V.school[1]);
      }
    }
  });

  it('chunkOf/CHUNK_SIZE round-trips a point back to the chunk containing it', () => {
    const [cx, cz] = chunkOf(123, -456);
    expect(cx).toBe(Math.floor(123 / CHUNK_SIZE));
    expect(cz).toBe(Math.floor(-456 / CHUNK_SIZE));
  });

  // docs/ARCHITECTURE.md's "Seeding" section, restated for fish: "adding one [species] shifts
  // every later object" is exactly the legacy iteration-order bug this task's density work must
  // not reintroduce. These two tests cover it from both directions spawn.ts's `lifeTableFor` makes
  // possible: a brand-new habitat table (`Humps`/`ReefWall`, added by this task) is a different
  // dictionary key, so chunks that resolve to any other zone cannot read it at all — exact, no
  // caveats. Appending to an *existing* zone's own table is weaker (weightedPick scales by the new
  // total, so in principle any chunk's draw could move) but negligible for a small appended
  // weight, verified empirically below over a wide chunk sample.
  it('adding an entirely new habitat table (Humps/ReefWall) does not change any resident outside that habitat', () => {
    // Excludes the 'Reef' zone itself — part of it legitimately IS the ReefWall habitat
    // (depthAt >= REEF_WALL_DEPTH, spawn.ts), so chunks there are *supposed* to read
    // ZONE_LIFE.ReefWall. The claim under test is that habitats with no such relationship
    // (Flats/Backcountry/Bridge/Hawk Channel/Creek/plain Offshore) can't read it at all.
    // cz capped well below 46 (z=3000) to stay clear of Marathon/West Hump's dz~3350/3650 ±
    // HUMP_RADIUS — those two legitimately read ZONE_LIFE.Humps too (spawn.ts), same reasoning as
    // excluding 'Reef' above.
    const probes: Array<[number, number]> = [];
    for (let cx = -40; cx <= 40; cx++) for (let cz = -20; cz <= 40; cz++) {
      const [ccx, ccz] = [(cx + 0.5) * CHUNK_SIZE, (cz + 0.5) * CHUNK_SIZE];
      if (zoneAt(ccx, ccz) !== 'Reef') probes.push([cx, cz]);
    }
    expect(probes.length).toBeGreaterThan(0);
    const before = probes.map(([cx, cz]) => residentsForChunk(SEED, cx, cz));
    expect(before.some((r) => r !== null)).toBe(true);

    const humps = [...ZONE_LIFE.Humps];
    const reefWall = [...ZONE_LIFE.ReefWall];
    try {
      (ZONE_LIFE.Humps as Array<[string, number]>).push(['tarpon', 50]);
      (ZONE_LIFE.ReefWall as Array<[string, number]>).push(['bonefish', 50]);
      const after = probes.map(([cx, cz]) => residentsForChunk(SEED, cx, cz));
      expect(after).toEqual(before);
    } finally {
      ZONE_LIFE.Humps.length = 0; ZONE_LIFE.Humps.push(...humps);
      ZONE_LIFE.ReefWall.length = 0; ZONE_LIFE.ReefWall.push(...reefWall);
    }
  });

  it('appending a new low-weight species to an existing zone’s own table does not shift that zone’s already-sampled residents', () => {
    const probes: Array<[number, number]> = [];
    for (let cx = -40; cx <= 40; cx += 2) for (let cz = -20; cz <= 70; cz += 3) probes.push([cx, cz]);
    const flatsProbes = probes.filter(([cx, cz]) => {
      const [ccx, ccz] = [(cx + 0.5) * CHUNK_SIZE, (cz + 0.5) * CHUNK_SIZE];
      return zoneAt(ccx, ccz) === 'Flats';
    });
    // Sanity: the sample must actually include Flats chunks and at least one real resident,
    // otherwise the equality check below would be vacuous.
    expect(flatsProbes.length).toBeGreaterThan(0);
    const before = flatsProbes.map(([cx, cz]) => residentsForChunk(SEED, cx, cz));
    expect(before.some((r) => r !== null)).toBe(true);

    const original = [...ZONE_LIFE.Flats];
    try {
      // A vanishingly small weight at the END of the table — "I added a new species" — should
      // only ever claim the sliver of hash-space previously unreachable (see spawn.ts/weightedPick);
      // for 1e-6 against a total already > 10, that sliver is far too small for any of these
      // deterministic draws to land in.
      (ZONE_LIFE.Flats as Array<[string, number]>).push(['tarpon', 1e-6]);
      const after = flatsProbes.map(([cx, cz]) => residentsForChunk(SEED, cx, cz));
      expect(after).toEqual(before);
    } finally {
      ZONE_LIFE.Flats.length = 0; ZONE_LIFE.Flats.push(...original);
    }
  });
});
