/**
 * Rod fishing ashore (game/fishing/shore.ts): the stand-in boat, when the walker is rooted, the
 * land prompt — and that the public piers are somewhere a cast actually lands in fishable water.
 */
import { describe, expect, it } from 'vitest';
import { createBoatState } from '@keysrun/shared/sim/boat';
import { PIERS, PIER_TOP } from '@keysrun/shared/world/piers';
import { landH, zoneAt } from '@keysrun/shared/world/depth';
import { ZONE_TABLE } from '@keysrun/shared/content/species';
import { shoreBoat, shoreHoldsStill, shorePrompt } from '../src/game/fishing/shore.js';

describe('shoreBoat', () => {
  it('puts the "boat" at the angler, facing their way, stopped — and keeps the real sea', () => {
    const boat = { ...createBoatState(100, 200, 0.3), speed: 4, dvx: 1, dvz: 2 };
    const s = shoreBoat(boat, { name: 'Pier', x: -5, y: 1.3, z: 7, yaw: 2 });
    expect(s).toMatchObject({ x: -5, y: 1.3, z: 7, h: 2, speed: 0, dvx: 0, dvz: 0 });
    expect(s.wakeRing).toBe(boat.wakeRing);
    expect(boat.x).toBe(100); // not mutated
  });
});

describe('shoreHoldsStill', () => {
  it('roots the walker from the first charge until the catch card is dealt with', () => {
    expect(shoreHoldsStill('idle', false)).toBe(false);
    expect(shoreHoldsStill('idle', true)).toBe(true);
    for (const st of ['casting', 'waiting', 'nibble', 'bite', 'fight', 'caught'] as const) expect(shoreHoldsStill(st, false)).toBe(true);
  });
});

describe('shorePrompt', () => {
  it('says how to cast, and how to get walking again, and keeps out of the fishing HUD otherwise', () => {
    expect(shorePrompt('idle', false, 'Vaca Key Fishing Pier')).toBe('Space  Cast off the pier');
    expect(shorePrompt('idle', false, 'a private dock')).toBe('Space  Cast off the dock');
    expect(shorePrompt('idle', false, 'Boot Key Harbor City Marina')).toBe('Space  Cast off the dock');
    expect(shorePrompt('waiting', false, 'x')).toBe('R  Reel in to walk on');
    expect(shorePrompt('idle', true, 'x')).toBeNull();
    for (const st of ['bite', 'fight', 'caught'] as const) expect(shorePrompt(st, false, 'x')).toBeNull();
  });
  it('splits into a key and a label the way the land HUD reads it', () => {
    const [k, ...rest] = shorePrompt('idle', false, 'pier')!.split(/\s{2,}/);
    expect(k).toBe('Space');
    expect(rest.join(' ')).toBe('Cast off the pier');
  });
});

describe('the piers fish', () => {
  it('there are some', () => { expect(PIERS.length).toBeGreaterThan(0); });

  it('a cast straight off the end of every pier lands in water, in a zone with fish in it', () => {
    for (const p of PIERS) {
      // standing at the front edge of the T, casting out to sea at the shortest and longest power
      const sx = p.x1 + p.nx * 2, sz = p.z1 + p.nz * 2;
      for (const dist of [12, 40, 85]) {
        const x = sx + p.nx * dist, z = sz + p.nz * dist;
        expect(landH(x, z), `${p.name} at ${dist} m`).toBeLessThan(-0.4);
        const zone = zoneAt(x, z);
        expect(ZONE_TABLE[zone]?.length ?? 0, `${p.name}: ${zone}`).toBeGreaterThan(0);
      }
    }
  });

  it('the deck stands above the water you cast into', () => {
    for (const p of PIERS) expect(PIER_TOP).toBeGreaterThan(landH(p.x1, p.z1));
  });
});
