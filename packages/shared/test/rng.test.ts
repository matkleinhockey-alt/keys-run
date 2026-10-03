import { describe, expect, it } from 'vitest';
import { hashCell, mulberry32, xoshiro128ss, weightedPick } from '../src/rng/index.js';

describe('hashCell', () => {
  it('is deterministic: same inputs always produce the same output', () => {
    for (let i = 0; i < 50; i++) {
      const a = hashCell(7, i * 3 - 10, i * -5 + 2, i % 4);
      const b = hashCell(7, i * 3 - 10, i * -5 + 2, i % 4);
      expect(a).toBe(b);
    }
  });

  it('returns values in [0, 1)', () => {
    for (let cx = -5; cx <= 5; cx++) {
      for (let cz = -5; cz <= 5; cz++) {
        const v = hashCell(11, cx, cz, 0);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('is sensitive to each input (seed, cx, cz, salt independently change the output)', () => {
    const base = hashCell(1, 2, 3, 4);
    expect(hashCell(2, 2, 3, 4)).not.toBe(base);
    expect(hashCell(1, 3, 3, 4)).not.toBe(base);
    expect(hashCell(1, 2, 4, 4)).not.toBe(base);
    expect(hashCell(1, 2, 3, 5)).not.toBe(base);
  });

  it('is well-distributed over a grid of cells (10-bucket histogram within 25% of uniform)', () => {
    const buckets = new Array(10).fill(0);
    let n = 0;
    for (let cx = 0; cx < 200; cx++) {
      for (let cz = 0; cz < 50; cz++) {
        const v = hashCell(42, cx, cz, 1);
        buckets[Math.min(9, Math.floor(v * 10))]++;
        n++;
      }
    }
    const expectedPerBucket = n / 10;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(expectedPerBucket * 0.75);
      expect(count).toBeLessThan(expectedPerBucket * 1.25);
    }
  });
});

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0, 1) and different seeds diverge', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    for (let i = 0; i < 10; i++) {
      const va = a(), vb = b();
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
      expect(va).not.toBe(vb);
    }
  });
});

describe('xoshiro128**', () => {
  it('is deterministic for a given seed', () => {
    const a = xoshiro128ss(777);
    const b = xoshiro128ss(777);
    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0, 1) with a reasonable mean over many draws', () => {
    const rng = xoshiro128ss(2024);
    let sum = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / N).toBeGreaterThan(0.48);
    expect(sum / N).toBeLessThan(0.52);
  });
});

describe('weightedPick', () => {
  it('respects weights over 10k samples', () => {
    const rng = mulberry32(0xfeed);
    const table: Array<[string, number]> = [['a', 1], ['b', 2], ['c', 7]];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const N = 10000;
    for (let i = 0; i < N; i++) counts[weightedPick(rng, table)]++;
    // expected proportions: a=10%, b=20%, c=70%
    expect(counts.a / N).toBeGreaterThan(0.08);
    expect(counts.a / N).toBeLessThan(0.12);
    expect(counts.b / N).toBeGreaterThan(0.17);
    expect(counts.b / N).toBeLessThan(0.23);
    expect(counts.c / N).toBeGreaterThan(0.65);
    expect(counts.c / N).toBeLessThan(0.75);
  });

  it('always returns an entry from the table', () => {
    const rng = mulberry32(5);
    const table: Array<[string, number]> = [['only', 1]];
    for (let i = 0; i < 100; i++) expect(weightedPick(rng, table)).toBe('only');
  });

  it('never picks a zero-weight entry', () => {
    const rng = mulberry32(9);
    const table: Array<[string, number]> = [['never', 0], ['always', 1]];
    for (let i = 0; i < 200; i++) expect(weightedPick(rng, table)).toBe('always');
  });
});
