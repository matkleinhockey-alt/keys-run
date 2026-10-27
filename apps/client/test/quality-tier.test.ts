import { describe, expect, it } from 'vitest';
import { detectDefaultTier, type GpuProbe } from '../src/core/quality.js';

const probe = (p: Partial<GpuProbe>): GpuProbe => ({ renderer: 'unknown', isSoftware: false, cores: 4, touch: false, ...p });

describe('default quality tier', () => {
  it('never hands a touch device better than medium, however its GPU reports itself', () => {
    // iOS Safari reports EVERY device as the literal string "Apple GPU" — an iPhone exactly as an
    // M-series iPad — so a renderer-string match cannot be allowed to outrank the touch check.
    for (const renderer of ['Apple GPU', 'Apple M1', 'Apple A17 Pro GPU', 'Mali-G78', 'Adreno (TM) 740']) {
      for (const cores of [2, 4, 6, 8, 16]) {
        const tier = detectDefaultTier(probe({ renderer, cores, touch: true }));
        expect(['low', 'medium'], `${renderer} / ${cores} cores`).toContain(tier);
      }
    }
  });

  it('still gives a desktop its due', () => {
    expect(detectDefaultTier(probe({ renderer: 'NVIDIA GeForce RTX 4080', cores: 16 }))).toBe('ultra');
    expect(detectDefaultTier(probe({ renderer: 'Apple M1', cores: 8 }))).toBe('high');
    expect(detectDefaultTier(probe({ renderer: 'Intel Iris Xe Graphics', cores: 8 }))).toBe('medium');
  });

  it('puts a software rasteriser on the floor before anything else is asked', () => {
    expect(detectDefaultTier(probe({ renderer: 'SwiftShader', isSoftware: true, cores: 16 }))).toBe('low');
  });
});
