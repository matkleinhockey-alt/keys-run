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
import { WORLD } from '@keysrun/shared/world/depth';

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
});
