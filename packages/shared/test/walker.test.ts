/**
 * The walker, on a synthetic world first (rules in isolation) and then on the real town (the
 * property that matters: nothing you can do with the keys puts you anywhere you cannot walk back
 * from — "refuse to strand the player").
 */
import { describe, expect, it } from 'vitest';
import { createWalkerState, stepWalker, canStand, WALK_SPEED, SPRINT_SPEED, STEP_MAX, type WalkerEnv, type WalkerInput, type WalkerState } from '../src/sim/walker.js';
import { COLLIDERS, groundAt, findBerth, TOWN_FRAME, toWorld, PAD_Y, DECK_TOP, marinaDecks } from '../src/world/town.js';
import { MARINAS } from '../src/world/depth.js';

const none: WalkerInput = { fwd: false, back: false, left: false, right: false, sprint: false, lookYaw: 0 };
const DT = 1 / 30;

// A 20x20 floor with a wall across the middle and a hole in the south-east corner.
const toy: WalkerEnv = {
  ground: (x, z) => (x < 0 || x > 20 || z < 0 || z > 20 || (x > 15 && z > 15) ? null : 1),
  colliders: [{ x0: 9, x1: 11, z0: 0, z1: 14 }],
};

function run(s: WalkerState, input: Partial<WalkerInput>, env: WalkerEnv, seconds: number): WalkerState {
  for (let i = 0; i < Math.round(seconds / DT); i++) s = stepWalker(s, { ...none, ...input }, env, DT);
  return s;
}

describe('walking', () => {
  it('goes where the camera points, forward being -z at yaw 0', () => {
    const s = run(createWalkerState(5, 10, 0, toy), { fwd: true }, toy, 1);
    expect(s.z).toBeLessThan(10 - 1.5);
    expect(Math.abs(s.x - 5)).toBeLessThan(0.01);
  });

  it('strafes right of the view, and turns with it', () => {
    const s = run(createWalkerState(5, 10, 0, toy), { right: true }, toy, 1);
    expect(s.x).toBeGreaterThan(5 + 1.5);
    // looking 90 degrees left, forward is -x
    const t = run(createWalkerState(5, 10, 0, toy), { fwd: true, lookYaw: Math.PI / 2 }, toy, 1);
    expect(t.x).toBeLessThan(5 - 1.5);
  });

  it('is capped at walking pace, with a faster sprint, and does not go faster diagonally', () => {
    const w = run(createWalkerState(2, 18, 0, toy), { fwd: true, right: true }, toy, 3);
    expect(w.speed).toBeLessThanOrEqual(WALK_SPEED + 1e-6);
    expect(w.speed).toBeGreaterThan(WALK_SPEED - 0.05);
    const r = run(createWalkerState(2, 18, 0, toy), { fwd: true, sprint: true }, toy, 2);
    expect(r.speed).toBeCloseTo(SPRINT_SPEED, 1);
  });

  it('stops dead when you let go', () => {
    let s = run(createWalkerState(5, 10, 0, toy), { fwd: true }, toy, 1);
    s = run(s, {}, toy, 0.6);
    expect(s.speed).toBeLessThan(0.01);
  });

  it('is stopped by a wall and slides along it', () => {
    // walk east into the wall at x = 9 while also drifting north-south
    let s = createWalkerState(5, 8, 0, toy);
    s = run(s, { right: true, fwd: true }, toy, 4);
    expect(s.x).toBeLessThan(9 - 0.3);
    // the z component carried on (it slid up the wall) until it ran out of floor at z = 0
    expect(s.z).toBeLessThan(2);
  });

  it('will not walk into the void', () => {
    const s = run(createWalkerState(14, 14, 0, toy), { right: true, back: true }, toy, 3);
    expect(toy.ground(s.x, s.z)).not.toBeNull();
    expect(s.x > 15 && s.z > 15).toBe(false);
  });

  it('refuses a step higher than a person can climb, and takes a gentle one', () => {
    const steppy: WalkerEnv = { ground: (x) => (x < 5 ? 0 : x < 6 ? STEP_MAX + 0.1 : 0.05), colliders: [] };
    let s = createWalkerState(2, 0, 0, steppy);
    s = run(s, { right: true }, steppy, 3);
    expect(s.x).toBeLessThan(5.01);
    expect(canStand(steppy, 6.5, 0, 0)).toBe(true);
  });

  it('is deterministic', () => {
    const a = run(createWalkerState(5, 10, 0, toy), { fwd: true, right: true, lookYaw: 0.7 }, toy, 2.5);
    const b = run(createWalkerState(5, 10, 0, toy), { fwd: true, right: true, lookYaw: 0.7 }, toy, 2.5);
    expect(a).toEqual(b);
  });
});

describe('walking in Boot Key Harbor City', () => {
  const env: WalkerEnv = { ground: groundAt, colliders: COLLIDERS };
  const F = TOWN_FRAME;

  it('starts you on the pier and lets you walk up the ramp onto the pad', () => {
    const [x, z] = toWorld(F, 0, -6);
    let s = createWalkerState(x, z, 0, env);
    expect(s.y).toBe(DECK_TOP);
    // inland is -z for this marina; looking inland is yaw 0 (forward = -z)
    s = run(s, { fwd: true }, env, 14);
    expect(s.y).toBe(PAD_Y);
  });

  it('cannot be walked off the end of the pier or into the harbour', () => {
    const [x, z] = toWorld(F, 0, -40);
    let s = createWalkerState(x, z, 0, env);
    s = run(s, { back: true }, env, 10);
    expect(groundAt(s.x, s.z)).not.toBeNull();
    s = run(s, { back: true, sprint: true }, env, 10);
    expect(groundAt(s.x, s.z)).not.toBeNull();
  });

  it('survives a hundred thousand random inputs without ever standing on nothing or inside a wall', () => {
    // A tiny deterministic LCG so a failure reproduces.
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (const m of [MARINAS[0], MARINAS[1], MARINAS[2], MARINAS[3]]) {
      const [r0] = marinaDecks(m);
      let s = createWalkerState((r0.x0 + r0.x1) / 2, (r0.z0 + r0.z1) / 2, 0, env);
      let input: WalkerInput = { ...none };
      for (let i = 0; i < 25000; i++) {
        if (i % 20 === 0) input = { fwd: rnd() < 0.7, back: rnd() < 0.1, left: rnd() < 0.3, right: rnd() < 0.3, sprint: rnd() < 0.5, lookYaw: rnd() * 6.28 };
        s = stepWalker(s, input, env, DT);
        const g = groundAt(s.x, s.z);
        if (g === null) throw new Error(`${m.name}: walked onto nothing at step ${i} (${s.x.toFixed(2)}, ${s.z.toFixed(2)})`);
        for (const c of COLLIDERS) {
          if (s.x > c.x0 && s.x < c.x1 && s.z > c.z0 && s.z < c.z1) throw new Error(`${m.name}: inside a collider at step ${i}`);
        }
      }
    }
  });

  it('can always get from the berth to the pad and back', () => {
    // Walk from where a boat lying alongside would put you, to the town, then back to the same plank.
    const m = MARINAS[0];
    const berth = findBerth(m.sx + 5, m.sz + 20, 12)!;
    expect(berth).not.toBeNull();
    let s = createWalkerState(berth.x, berth.z, 0, env);
    // head for the ramp foot
    const [tx, tz] = toWorld(F, 0, 10);
    for (let i = 0; i < 3000; i++) {
      const dx = tx - s.x, dz = tz - s.z;
      if (Math.hypot(dx, dz) < 0.6) break;
      s = stepWalker(s, { ...none, fwd: true, lookYaw: Math.atan2(-dx, -dz) }, env, DT);
    }
    expect(Math.hypot(tx - s.x, tz - s.z)).toBeLessThan(0.7);
  });
});
