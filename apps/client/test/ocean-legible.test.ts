/**
 * Worked water is legible: schools over a fished-out cell show fewer fish (entities/fish/thin.ts),
 * and the same fish are not speared. Proves the cue's guarantees:
 *   - recovery 1.0, no ledger, a signed-out ledger: nothing hidden, `shown` never set (today's path);
 *   - low recovery: fewer fish, never zero, monotonic as water gets worse;
 *   - NaN / negative / > 1 / Infinity / a throwing ledger: never throws, never hides by accident.
 */
import { describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '@keysrun/shared/rng';
import { FULL_AT, KEEP_MIN, keepFraction, shownCount } from '../src/entities/fish/thin.js';
import { createFishWorld } from '../src/entities/fish/index.js';
import { createOceanLedger } from '../src/net/ocean.js';

const FOCUS = { x: 2400, z: 1560 };
const BOAT = { x: FOCUS.x, z: FOCUS.z, vx: 0, vz: 0, speed: 0, kind: 'boat' } as never;

function worldWith(rec: ((x: number, z: number) => number | undefined) | undefined) {
  // Roamers are topped up from Math.random (fish/index.ts), so pin it or two worlds differ by noise.
  const spy = vi.spyOn(Math, 'random').mockImplementation(mulberry32(7));
  try {
    const w = createFishWorld(undefined, undefined, rec as never);
    for (let i = 0; i < 3; i++) w.update(0.05, i * 0.05, FOCUS, BOAT);
    return w;
  } finally { spy.mockRestore(); }
}
const spears = (w: ReturnType<typeof worldWith>) => w.spearTargetsNear(FOCUS.x, 0, FOCUS.z, 400).length;

describe('thin.ts', () => {
  it('pristine water hides nothing', () => {
    for (const n of [1, 3, 8, 40]) expect(shownCount(n, 1)).toBe(n);
    expect(keepFraction(1)).toBe(1);
    expect(shownCount(8, FULL_AT)).toBe(8);
    expect(shownCount(8, 0.9)).toBe(8);
  });
  it('worked water shows fewer, never none, and thins monotonically', () => {
    expect(shownCount(10, 0.09)).toBeLessThan(10);
    expect(shownCount(10, 0)).toBe(Math.ceil(10 * KEEP_MIN));
    expect(shownCount(1, 0)).toBe(1);
    let prev = 99;
    for (let r = 1; r >= 0; r -= 0.05) { const n = shownCount(20, r); expect(n).toBeLessThanOrEqual(prev); prev = n; }
  });
  it('absurd recovery never throws and never hides by accident', () => {
    for (const bad of [NaN, Infinity, 2, 1e9]) expect(shownCount(8, bad)).toBe(8);
    for (const bad of [-1, -Infinity]) expect(shownCount(8, bad)).toBe(Math.ceil(8 * KEEP_MIN));
    for (const bad of [undefined, null, '0.1', {}] as unknown[]) expect(shownCount(8, bad as number)).toBe(8);
    expect(shownCount(0, 0)).toBe(0);
  });
});

describe('fish world with the ledger wired in', () => {
  const base = worldWith(() => 1);

  it('the scene has schools to thin', () => {
    expect(base.debugActiveSchools().length).toBeGreaterThan(0);
    expect(base.stats.fish).toBeGreaterThan(0);
  });

  it('no ledger, a signed-out ledger, recovery 1 and garbage all draw exactly today\'s fish', () => {
    const signedOut = createOceanLedger({ session: () => null, fetch: (() => { throw new Error('no network'); }) as never, now: () => 0, baseUrl: '' });
    const worlds = [
      worldWith(undefined),
      worldWith((x, z) => signedOut.recoveryAt(x, z)),
      ...[NaN, 7, Infinity, undefined].map((g) => worldWith(() => g)),
    ];
    for (const w of worlds) {
      expect(w.stats.fish).toBe(base.stats.fish);
      expect(spears(w)).toBe(spears(base));
    }
  });

  it('a ledger that throws leaves the water whole', () => {
    const w = worldWith(() => { throw new Error('boom'); });
    expect(w.stats.fish).toBe(base.stats.fish);
  });

  it('worked-out water draws fewer fish and offers no more spear targets', () => {
    const w = worldWith(() => 0.05);
    expect(w.stats.fish).toBeLessThan(base.stats.fish);
    expect(w.stats.fish).toBeGreaterThan(0);
    expect(spears(w)).toBeLessThanOrEqual(spears(base));
    console.log(`fish drawn: pristine ${base.stats.fish} -> worked-out ${w.stats.fish}`);
  });

  it('negative recovery reads as fully worked, not as an error', () => {
    const w = worldWith(() => -3);
    expect(w.stats.fish).toBeLessThan(base.stats.fish);
  });
});
