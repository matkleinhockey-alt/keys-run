import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { depthAt, landH, zoneAt, offshoreF, creekDist, nearBridge, nearHump, type Zone } from '../src/world/depth.js';
import { shoreInfo } from '../src/world/chain.js';
import { COAST_CAP } from '../src/world/coast.js';
import { expectGolden } from './golden-compare.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden: any = JSON.parse(fs.readFileSync(path.join(HERE, 'golden.json'), 'utf8'));
const allSamples = [...golden.grid, ...golden.points];
/** The islands' shores are real outlines now, not legacy's ellipses (world/coast-data.ts), so the
 * bit-for-bit oracle holds only where no shore reaches: well clear of both the old and the new one.
 * That is still most of the sea — the depth bands, humps, channels, creeks, bridge and the mainland. */
const awayFromShore = allSamples.filter((p) => p.shoreD > COAST_CAP + 20 && shoreInfo(p.x, p.z).d >= COAST_CAP);

describe('world/depth: the world does not change by accident', () => {
  it('still covers most of the golden samples away from the shores', () => {
    expect(awayFromShore.length).toBeGreaterThan(allSamples.length * 0.75);
  });

  it('depthAt matches the baseline away from the shores', () => {
    for (const p of awayFromShore) expectGolden(depthAt(p.x, p.z), p.depthAt, `depthAt(${p.x}, ${p.z})`);
  });

  it('landH matches the baseline exactly, away from the shores', () => {
    for (const p of awayFromShore) expect(landH(p.x, p.z)).toBe(p.landH);
  });

  it('zoneAt matches legacy exactly away from the shores', () => {
    for (const p of awayFromShore) expect(zoneAt(p.x, p.z)).toBe(p.zoneAt);
  });

  it('offshoreF matches the baseline exactly', () => {
    for (const p of allSamples) expect(offshoreF(p.x, p.z)).toBe(p.offshoreF);
  });

  it('creekDist matches the baseline exactly', () => {
    for (const p of allSamples) expect(creekDist(p.x, p.z)).toBe(p.creekDist);
  });

  it('nearBridge matches legacy exactly', () => {
    for (const p of allSamples) expect(nearBridge(p.x, p.z)).toBe(p.nearBridge);
  });

  it('nearHump matches legacy exactly (by hump name, or null)', () => {
    for (const p of allSamples) {
      const h = nearHump(p.x, p.z);
      expect(h ? h.name : null).toBe(p.nearHump);
    }
  });
});

describe('zoneAt: known coordinates', () => {
  const byLabel = new Map<string, (typeof golden.points)[number]>(golden.points.map((p: { label: string }) => [p.label, p]));
  const expected: Array<[string, Zone]> = [
    ['creek:Snake Creek:0', 'Creek'],
    ['bridge-on:x=-2500', 'Bridge'],
    ['zone-d2.6:37.1:-3:x=0', 'Flats'],
    ['zone-d2.6:-917.6:-3:x=0', 'Backcountry'],
    ['zone-dz:1250:-5:x=0', 'Hawk Channel'],
    ['zone-dz:1250:5:x=0', 'Reef'],
    ['hump-far:Marathon Hump', 'Offshore'],
  ];

  it.each(expected)('%s -> %s', (label, zone) => {
    const p = byLabel.get(label);
    expect(p, `fixture is missing point "${label}"`).toBeDefined();
    // the fixture itself (legacy, via generate-golden.mjs) must agree with the hardcoded
    // expectation above, and so must the TypeScript port:
    expect(p!.zoneAt).toBe(zone);
    expect(zoneAt(p!.x, p!.z)).toBe(zone);
  });

  it('covers all seven zones across the hand-picked points', () => {
    const seen = new Set(golden.points.map((p: { zoneAt: string }) => p.zoneAt));
    for (const z of ['Creek', 'Bridge', 'Flats', 'Backcountry', 'Offshore', 'Reef', 'Hawk Channel']) {
      expect(seen.has(z), `no hand-picked point landed in zone "${z}"`).toBe(true);
    }
  });
});
