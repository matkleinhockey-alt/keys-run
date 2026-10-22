/**
 * The offline tag registry (game/catch/tags.ts with no session): a tagged fish goes back in the
 * water, is off the bite for its cooldown, then can be recaptured near where it was released —
 * at its grown weight — and keeping it retires the tag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, RECAPTURE_COOLDOWN_MS } from '@keysrun/shared/sim/tagging';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});
vi.mock('../src/ui/auth/session.js', () => ({ getCurrentSession: () => null }));
vi.mock('../src/net/config.js', () => ({ API_BASE_URL: 'http://api.invalid' }));

const { createTagRegistry, describeTag } = await import('../src/game/catch/tags.js');

const always = (): number => 0;
const at = { x: 100, z: 200, zone: 'Flats' };

describe('offline tag registry', () => {
  beforeEach(() => { store.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('tags, cools down, recaptures at a grown weight, and retires on keep', async () => {
    const reg = createTagRegistry();
    const tag = await reg.tagAndRelease('bonefish', 6, at);
    expect(tag?.code).toBe('KR-00001');

    reg.prefetch(at.x, at.z);
    expect(reg.pickRecapture('bonefish', at.x, at.z, always)).toBeNull(); // still on cooldown

    vi.setSystemTime(Date.now() + RECAPTURE_COOLDOWN_MS + 30 * DAY_MS);
    reg.prefetch(at.x, at.z);
    expect(reg.pickRecapture('permit', at.x, at.z, always)).toBeNull(); // wrong species
    const hooked = reg.pickRecapture('bonefish', at.x + 50, at.z, always);
    expect(hooked?.id).toBe(tag!.id);
    expect(hooked!.weightLb).toBeGreaterThan(6);
    expect(describeTag(hooked!).lines[0]).toMatch(/^Tagged by You .* at 6\.0 lb$/);

    const released = await reg.reportLanded(hooked!, { ...at, x: at.x + 50 }, false);
    expect(released?.events.map((e) => e.kind)).toEqual(['tagged', 'released']);

    vi.setSystemTime(Date.now() + RECAPTURE_COOLDOWN_MS + DAY_MS);
    reg.prefetch(at.x, at.z);
    const again = reg.pickRecapture('bonefish', at.x, at.z, always)!;
    const kept = await reg.reportLanded(again, at, true);
    expect(kept?.status).toBe('harvested');

    vi.setSystemTime(Date.now() + 10 * DAY_MS);
    reg.prefetch(at.x, at.z);
    expect(reg.pickRecapture('bonefish', at.x, at.z, always)).toBeNull();
  });

  it('only hands out a tag when the roll says this is that fish', async () => {
    const reg = createTagRegistry();
    await reg.tagAndRelease('bonefish', 6, at);
    vi.setSystemTime(Date.now() + RECAPTURE_COOLDOWN_MS + DAY_MS);
    reg.prefetch(at.x, at.z);
    expect(reg.pickRecapture('bonefish', at.x, at.z, () => 0.99)).toBeNull();
  });
});
