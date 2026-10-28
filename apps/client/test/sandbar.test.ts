/**
 * The sandbar raft-up: that the bars it picks are real bars, that there is more than one of them,
 * and that the party actually moves between them.
 *
 * These pin PROPERTIES, not the coordinates. The point of deriving the sites from the bathymetry
 * is that the terrain can change and the party follows it, so asserting `x === -3080` would pin
 * the one thing this code is deliberately not committing to.
 */
import { describe, it, expect } from 'vitest';
import { findSandbars, sandbarIndexAt, ROTATE_MS } from '../src/entities/life/sandbar.js';
import { shoreInfo } from '@keysrun/shared/world/chain';
import { depthAt, landH, WB } from '@keysrun/shared/world/depth';

const SITES = findSandbars();

describe('the sandbar sites', () => {
  it('finds several, so the party has somewhere else to go', () => {
    // The whole feature is "not always the same spot". One site is a fixture, not a party.
    expect(SITES.length).toBeGreaterThanOrEqual(4);
  });

  it('are each genuinely a bar: knee deep, with deeper water round them', () => {
    for (const s of SITES) {
      const d = depthAt(s.x, s.z);
      expect(d, `crest depth at ${s.x},${s.z.toFixed(0)}`).toBeGreaterThan(0.4);
      // Shallow enough to stand in. A "sandbar" in three metres of water is just water.
      expect(d, `crest depth at ${s.x},${s.z.toFixed(0)}`).toBeLessThan(1.2);
      expect(landH(s.x, s.z), `dry land at ${s.x},${s.z.toFixed(0)}`).toBeLessThanOrEqual(0.02);

      let sum = 0, deepest = -Infinity;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        const q = depthAt(s.x + Math.cos(th) * 140, s.z + Math.sin(th) * 140);
        sum += q; deepest = Math.max(deepest, q);
      }
      // A local HIGH — the thing that makes it a bar rather than a patch of flat.
      expect(sum / 8 - d, `mean relief at ${s.x},${s.z.toFixed(0)}`).toBeGreaterThan(0.5);
      // ...and a way in. A bar nobody can reach by boat is not a party venue.
      expect(deepest, `deepest approach at ${s.x},${s.z.toFixed(0)}`).toBeGreaterThan(1.5);
    }
  });

  it('are out in open water, not the shallows off a beach', () => {
    // party-boats.ts already does the beach raft-up. If these land on a shoreline the two
    // features are the same feature and the sandbar has lost the only thing that made it one.
    for (const s of SITES) {
      expect(shoreInfo(s.x, s.z).d, `shore distance at ${s.x},${s.z.toFixed(0)}`).toBeGreaterThan(190);
    }
  });

  it('are all somewhere the player can actually sail to', () => {
    // The oil rigs shipped with two platforms outside the box the boat is clamped to, which made
    // them scenery you could see and never reach. Same mistake is available here.
    const MARGIN = 120;
    for (const s of SITES) {
      expect(s.x, 'x inside the sailable box').toBeGreaterThan(WB.x0 + MARGIN);
      expect(s.x, 'x inside the sailable box').toBeLessThan(WB.x1 - MARGIN);
      expect(s.z, 'z inside the sailable box').toBeGreaterThan(WB.z0 + MARGIN);
      expect(s.z, 'z inside the sailable box').toBeLessThan(WB.z1 - MARGIN);
    }
  });

  it('are distinct places, not neighbouring squares of one bank', () => {
    for (let i = 0; i < SITES.length; i++) {
      for (let j = i + 1; j < SITES.length; j++) {
        const d = Math.hypot(SITES[i].x - SITES[j].x, SITES[i].z - SITES[j].z);
        expect(d, `sites ${i} and ${j} are the same bar`).toBeGreaterThan(600);
      }
    }
  });
});

describe('which bar it is', () => {
  it('is in range and the same for everyone at the same moment', () => {
    // World content, so two clients an ocean apart have to agree. Not a per-session roll.
    for (let k = 0; k < 200; k++) {
      const t = Date.UTC(2026, 0, 1) + k * 1271 * 1000;
      const a = sandbarIndexAt(t, SITES.length);
      expect(a).toBe(sandbarIndexAt(t, SITES.length));
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(SITES.length);
    }
  });

  it('actually moves, and gets round to every bar', () => {
    const seen = new Set<number>();
    let changes = 0, prev = -1;
    const t0 = Date.UTC(2026, 0, 1);
    for (let k = 0; k < 200; k++) {
      const i = sandbarIndexAt(t0 + k * ROTATE_MS, SITES.length);
      seen.add(i);
      if (prev >= 0 && i !== prev) changes++;
      prev = i;
    }
    expect(seen.size, 'bars ever used').toBe(SITES.length);
    // Not stuck: a hash that lands on the same bar most periods would pass `seen` and still feel
    // like a fixture.
    expect(changes).toBeGreaterThan(120);
  });

  it('holds one bar for a whole period, rather than flickering', () => {
    // Within a period the answer must not change, or the raft would try to move constantly.
    const base = Date.UTC(2026, 5, 3) - (Date.UTC(2026, 5, 3) % ROTATE_MS);
    const want = sandbarIndexAt(base, SITES.length);
    for (const frac of [0, 0.01, 0.37, 0.5, 0.99]) {
      expect(sandbarIndexAt(base + ROTATE_MS * frac, SITES.length)).toBe(want);
    }
    expect(ROTATE_MS).toBeGreaterThan(10 * 60 * 1000);
  });
});
