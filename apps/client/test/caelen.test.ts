/**
 * Caelen's hitbox and his two-minute sulk (src/entities/life/caelen.ts).
 *
 * Node environment, so `document` is stubbed to the three members the module actually touches —
 * the name tag is presentation and `ui/toast.ts` already no-ops without a `#toast` element. The
 * part under test is the geometry and the state machine, both of which are DOM-free.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createCaelen, CAELEN_AWAY_S, CAELEN_RADIUS, type Caelen } from '../src/entities/life/caelen.js';

const DT = 1 / 30;
const BOAT = { x: 0, y: 0.4, z: 0, speed: 0 };

/** Everything `toast()` wrote, in order — the player-facing text is the only place his lines are
 * observable from outside, and they are half the feature. */
const toasts: string[] = [];
const toastEl = {
  set textContent(v: string) { toasts.push(v); },
  get textContent() { return toasts[toasts.length - 1] ?? ''; },
  classList: { add() {}, remove() {} },
};

function stubDom(): void {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ className: '', style: {} as Record<string, string>, textContent: '', remove() {} }),
    getElementById: (id: string) => (id === 'toast' ? toastEl : null),
  };
}

/** A camera that projects to a fixed point — `update` only uses it for the name tag. */
const CAM = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
const VIEW = { w: 1280, h: 800 };

/** Runs `secs` of simulated time with the player in the water next to the boat, which is what
 * brings him onto the tight low orbit his hitbox is reachable from. */
function fly(c: Caelen, secs: number, t0 = 0): number {
  let t = t0;
  for (let i = 0; i < Math.round(secs / DT); i++) {
    t += DT;
    c.update(DT, t, BOAT, CAM, VIEW, { active: true, x: 0, y: -0.5, z: 0 });
  }
  return t;
}

let scene: THREE.Scene;
let said: string[];
let caelen: Caelen;

beforeAll(() => { stubDom(); });
afterAll(() => { delete (globalThis as Record<string, unknown>).document; });

function build(): void {
  scene = new THREE.Scene();
  said = [];
  toasts.length = 0;
  caelen = createCaelen(scene, { sayCaelenLine: () => said.push('line') });
}

describe('where he flies', () => {
  it('settles inside spear range of a diver, which is the whole reason the hitbox is reachable', () => {
    build();
    fly(caelen, 20);
    const box = caelen.debugHitbox();
    expect(box).not.toBeNull();
    const cx = (box!.ax + box!.bx) / 2, cy = (box!.ay + box!.by) / 2, cz = (box!.az + box!.bz) / 2;
    // From a diver just under the surface at the origin.
    const dist = Math.hypot(cx - 0, cy - -0.5, cz - 0);
    expect(dist).toBeLessThan(11); // SPEAR_RANGE
    expect(cy).toBeGreaterThan(0.5); // above the water, not swimming in it
  });

  it('orbits the boat instead when nobody is in the water', () => {
    build();
    let t = 0;
    for (let i = 0; i < 900; i++) { t += DT; caelen.update(DT, t, { x: 200, y: 0.4, z: -60, speed: 0 }, CAM, VIEW, null); }
    const box = caelen.debugHitbox()!;
    const cx = (box.ax + box.bx) / 2, cz = (box.az + box.bz) / 2;
    expect(Math.hypot(cx - 200, cz - -60)).toBeLessThan(26);
  });
});

describe('the hitbox', () => {
  it('a shaft straight through him counts as a hit, and he leaves for two minutes', () => {
    build();
    fly(caelen, 20);
    const box = caelen.debugHitbox()!;
    const cy = (box.ay + box.by) / 2;
    const cx = (box.ax + box.bx) / 2, cz = (box.az + box.bz) / 2;
    // Fire from 6 m away on the far side, through his centre.
    const len = Math.hypot(cx, cz) || 1;
    const p1 = { x: cx + (cx / len) * 6, y: cy, z: cz + (cz / len) * 6 };
    const p2 = { x: cx - (cx / len) * 5, y: cy, z: cz - (cz / len) * 5 };
    expect(caelen.resolveSpearShot(p1, p2)).toBe('hit');
    expect(caelen.awayFor()).toBeCloseTo(CAELEN_AWAY_S, 5);
    // Gone means gone: no hitbox at all, so a second shot cannot hit him again.
    fly(caelen, 5);
    expect(caelen.debugHitbox()).toBeNull();
    expect(caelen.resolveSpearShot(p1, p2)).toBeNull();
  });

  it('comes back when the two minutes are up, with something to say', () => {
    build();
    fly(caelen, 20);
    const box = caelen.debugHitbox()!;
    const cy = (box.ay + box.by) / 2, cx = (box.ax + box.bx) / 2, cz = (box.az + box.bz) / 2;
    const len = Math.hypot(cx, cz) || 1;
    caelen.resolveSpearShot(
      { x: cx + (cx / len) * 6, y: cy, z: cz + (cz / len) * 6 },
      { x: cx - (cx / len) * 5, y: cy, z: cz - (cz / len) * 5 },
    );
    const linesWhenHit = said.length;
    fly(caelen, CAELEN_AWAY_S - 10);
    expect(caelen.awayFor()).toBeGreaterThan(0);
    expect(caelen.debugHitbox()).toBeNull();
    fly(caelen, 12);
    expect(caelen.awayFor()).toBe(0);
    expect(caelen.debugHitbox()).not.toBeNull();
    expect(said.length).toBeGreaterThan(linesWhenHit); // the return line
  });

  it('a shot that goes near him is a near miss — he has opinions, but he stays', () => {
    build();
    fly(caelen, 20);
    const box = caelen.debugHitbox()!;
    const cy = (box.ay + box.by) / 2, cx = (box.ax + box.bx) / 2, cz = (box.az + box.bz) / 2;
    const len = Math.hypot(cx, cz) || 1;
    // Same line, offset 1.5 m vertically — outside CAELEN_RADIUS, inside the taunt margin.
    const dy = CAELEN_RADIUS + 0.9;
    expect(caelen.resolveSpearShot(
      { x: cx + (cx / len) * 6, y: cy + dy, z: cz + (cz / len) * 6 },
      { x: cx - (cx / len) * 5, y: cy + dy, z: cz - (cz / len) * 5 },
    )).toBe('nearMiss');
    expect(caelen.awayFor()).toBe(0);
    expect(caelen.debugHitbox()).not.toBeNull();
  });

  it('a shot at a fish nowhere near him does not involve him at all', () => {
    build();
    fly(caelen, 20);
    // Straight down from the diver — a real spearfishing shot.
    expect(caelen.resolveSpearShot({ x: 0, y: -1, z: 0 }, { x: 0, y: -12, z: 0 })).toBeNull();
    expect(caelen.awayFor()).toBe(0);
  });

  it('the taunt margin is finite — 8 m off is not "shooting at Caelen"', () => {
    build();
    fly(caelen, 20);
    const box = caelen.debugHitbox()!;
    const cy = (box.ay + box.by) / 2, cx = (box.ax + box.bx) / 2, cz = (box.az + box.bz) / 2;
    const len = Math.hypot(cx, cz) || 1;
    expect(caelen.resolveSpearShot(
      { x: cx + (cx / len) * 6, y: cy + 8, z: cz + (cz / len) * 6 },
      { x: cx - (cx / len) * 5, y: cy + 8, z: cz - (cz / len) * 5 },
    )).toBeNull();
  });
});

describe('what he says', () => {
  it('announces that he is an executive, unprompted', () => {
    build();
    // Ambient lines fire on a 45-90 s timer and rotate, so a few minutes covers the whole list.
    fly(caelen, 300);
    expect(toasts.some((m) => m.includes('I’m an executive'))).toBe(true);
    expect(toasts.some((m) => m.includes('you didn’t make this'))).toBe(true);
  });

  it('tells you off for a near miss, and squawks doing it', () => {
    build();
    fly(caelen, 20);
    const box = caelen.debugHitbox()!;
    const cy = (box.ay + box.by) / 2, cx = (box.ax + box.bx) / 2, cz = (box.az + box.bz) / 2;
    const len = Math.hypot(cx, cz) || 1;
    const before = said.length;
    const dy = CAELEN_RADIUS + 0.9;
    caelen.resolveSpearShot(
      { x: cx + (cx / len) * 6, y: cy + dy, z: cz + (cz / len) * 6 },
      { x: cx - (cx / len) * 5, y: cy + dy, z: cz - (cz / len) * 5 },
    );
    expect(toasts[toasts.length - 1]).toContain('you suck at this braowww');
    expect(said.length).toBe(before + 1);
  });

  it('calls a hit assault on the way out', () => {
    build();
    fly(caelen, 20);
    const box = caelen.debugHitbox()!;
    const cy = (box.ay + box.by) / 2, cx = (box.ax + box.bx) / 2, cz = (box.az + box.bz) / 2;
    const len = Math.hypot(cx, cz) || 1;
    caelen.resolveSpearShot(
      { x: cx + (cx / len) * 6, y: cy, z: cz + (cz / len) * 6 },
      { x: cx - (cx / len) * 5, y: cy, z: cz - (cz / len) * 5 },
    );
    expect(toasts[toasts.length - 1]).toContain('assault braowww');
  });
});
