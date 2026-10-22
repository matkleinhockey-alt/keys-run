/**
 * The bird side of handgun mode (src/entities/life/seabirds.ts `scareBird` / `moveBird`): a startled
 * bird flies off, is out of sight for a while, and flies back in - and it does all of that through
 * `moveBird`, the one function every bird system already calls, so none of them needs to know.
 *
 * Node environment; three's scene graph does not need a DOM.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { makeSeabird, moveBird, poseBird, scareBird, birdShown, birdWorldPos, FLEE_FLIGHT_S } from '../src/entities/life/seabirds.js';

const DT = 1 / 30;

/** A gull circling a point, driven the way pelicans.ts/hotspots.ts drive theirs. */
function orbit(B: ReturnType<typeof makeSeabird>, t: number): void {
  const a = t * 0.4;
  poseBird(B, DT, 1, 0, 9);
  moveBird(B, 100 + Math.cos(a) * 10, 8, 50 + Math.sin(a) * 10, DT);
}

describe('a startled bird', () => {
  it('flies away from the shooter, vanishes, and flies back in on its own schedule', () => {
    const B = makeSeabird('gull');
    const scene = new THREE.Scene(); scene.add(B.g);
    let t = 0;
    for (let i = 0; i < 30; i++) { t += DT; orbit(B, t); }
    const home = birdWorldPos(B, new THREE.Vector3()).clone();
    expect(birdShown(B)).toBe(true);

    scareBird(B, 0, 0, 20); // shooter at the origin, bird out at x ~100
    expect(B.flee).not.toBeNull();
    expect(B.flee!.dx).toBeGreaterThan(0.8); // runs away from the shooter

    let maxDist = 0, wentHidden = false, hiddenAt = -1;
    const t0 = t;
    for (let i = 0; i < Math.round(21 / DT); i++) {
      t += DT; orbit(B, t);
      const p = birdWorldPos(B, new THREE.Vector3());
      maxDist = Math.max(maxDist, Math.hypot(p.x - home.x, p.z - home.z));
      if (!B.g.visible && !wentHidden) { wentHidden = true; hiddenAt = t - t0; }
    }
    expect(maxDist).toBeGreaterThan(40);                 // it really did leave, not just blink
    expect(wentHidden).toBe(true);
    expect(hiddenAt).toBeLessThan(FLEE_FLIGHT_S + 0.5);  // visible flight first, then gone
    expect(B.flee).toBeNull();                           // and the sulk ended
    expect(B.g.visible).toBe(true);                      // back where its home system wants it
    expect(Math.hypot(B.g.position.x - 100, B.g.position.z - 50)).toBeLessThan(11);
  });

  it('is not extended or reset by a second scare while it is away', () => {
    const B = makeSeabird('tern');
    new THREE.Scene().add(B.g);
    for (let i = 0; i < 5; i++) orbit(B, i * DT);
    scareBird(B, 0, 0, 30);
    const first = B.flee;
    for (let i = 0; i < 60; i++) orbit(B, i * DT);
    scareBird(B, 500, 500, 100);
    expect(B.flee).toBe(first);
    expect(B.flee!.away).toBe(30);
  });

  it('flaps its wings hard while it runs, whatever its home behaviour says', () => {
    const B = makeSeabird('gull');
    new THREE.Scene().add(B.g);
    scareBird(B, 0, 0, 20);
    const ph0 = B.ph;
    poseBird(B, DT, 0, 0, 5); // home behaviour: gliding
    expect(B.ph - ph0).toBeGreaterThan(DT * 9);
  });

  it('a hidden bird is not "shown", so the pistol cannot target it', () => {
    const B = makeSeabird('gull');
    const g = new THREE.Group(); g.add(B.g);
    expect(birdShown(B)).toBe(true);
    g.visible = false;
    expect(birdShown(B)).toBe(false); // an invisible hotspot group hides its birds
    g.visible = true;
    B.g.visible = false;
    expect(birdShown(B)).toBe(false);
  });

  it('works for a bird parented to a translated group (the hotspot case)', () => {
    const B = makeSeabird('gull');
    const g = new THREE.Group(); g.position.set(1000, 0, 2000); g.add(B.g);
    new THREE.Scene().add(g);
    moveBird(B, 5, 9, 5, DT);
    const p = birdWorldPos(B, new THREE.Vector3());
    expect(p.x).toBeCloseTo(1005); expect(p.z).toBeCloseTo(2005);
    scareBird(B, 1000, 2000, 20); // shooter at the group origin: bird is to its +x/+z
    expect(B.flee!.dx).toBeGreaterThan(0); expect(B.flee!.dz).toBeGreaterThan(0);
  });
});
