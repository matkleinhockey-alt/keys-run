/**
 * School sizes against how the animal actually aggregates.
 *
 * These pin the BIOLOGY, not the numbers: a blackfin tuna may be 14-34 or 12-30 and both are
 * defensible, but it must never be a trio, and a great hammerhead must never be a shoal. The
 * table was built by eye and had most of the small reef fish right while leaving the schooling
 * pelagics — tarpon, blackfin, jacks, yellowtail — at the two-to-seven of an ambush predator.
 */
import { describe, expect, it } from 'vitest';
import { VIS } from '../src/content/creatures.js';

/** Animals that hunt or sit alone. A pair happens; a shoal does not. */
const SOLITARY = [
  'barracuda', 'grouper', 'goliath', 'warsaw', 'gag', 'redgrouper', 'hogfish', 'tripletail',
  'flounder', 'lionfish', 'mola', 'swordfish', 'marlin', 'blackmarlin', 'wahoo',
  'bullshark', 'hammerhead', 'tigershark', 'mako', 'greatwhite', 'sawfish', 'nurse',
  'whaleshark', 'humpback', 'turtle', 'cubera', 'cobia',
];

/** Animals that are only ever seen in numbers — bait, reef shoals, schooling pelagics. */
const SCHOOLING = [
  'bluerunner', 'schoolmaster', 'lanesnapper', 'vermilion', 'lookdown', 'palometa',
  'spanishmack', 'yellowtail', 'mangrove', 'blackfin', 'skipjack', 'flyingfish',
  'jackcrevalle', 'ladyfish', 'pompano', 'tarpon',
];

describe('school sizes match how the animal aggregates', () => {
  it('keeps the solitary hunters solitary', () => {
    for (const k of SOLITARY) {
      const v = VIS[k];
      expect(v, k).toBeDefined();
      expect(v.school[1], `${k} should not shoal`).toBeLessThanOrEqual(3);
    }
  });

  it('puts the schooling species in real numbers', () => {
    for (const k of SCHOOLING) {
      const v = VIS[k];
      expect(v, k).toBeDefined();
      expect(v.school[0], `${k} should never appear as a handful`).toBeGreaterThanOrEqual(5);
      expect(v.school[1], `${k} should reach a proper school`).toBeGreaterThanOrEqual(12);
    }
  });

  it('never shoals a large fish or shark', () => {
    // No big FISH or SHARK here forms a school — past about three metres they are all ambush
    // predators or solitary giants. This is the check that catches a baitfish row copy-pasted
    // onto a marlin.
    //
    // Deliberately not applied to the cetaceans: the first version of this rule was "nothing over
    // 3 m shoals" and it failed on the pilot whale, correctly. Pilot whales are six metres and
    // among the most social animals in the ocean, travelling in pods of tens — the rule was
    // wrong, not the data, so size alone is not the test. See the pod check below.
    for (const [k, v] of Object.entries(VIS)) {
      if (v.len >= 3 && (v.kind === 'fish' || v.kind === 'shark' || v.kind === 'ray')) {
        expect(v.school[1], `${k} is a ${v.len} m ${v.kind} and should not shoal`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('keeps the social cetaceans in pods, big as they are', () => {
    for (const k of ['dolphin', 'pilotwhale']) {
      expect(VIS[k].school[1], `${k} travels in a pod`).toBeGreaterThanOrEqual(8);
    }
    // ...and the ones that genuinely are loners stay that way.
    for (const k of ['humpback', 'spermwhale']) {
      expect(VIS[k].school[1], `${k}`).toBeLessThanOrEqual(4);
    }
  });

  it('is a well-formed range everywhere', () => {
    for (const [k, v] of Object.entries(VIS)) {
      expect(v.school[0], k).toBeGreaterThanOrEqual(1);
      expect(v.school[1], k).toBeGreaterThanOrEqual(v.school[0]);
    }
  });
});
