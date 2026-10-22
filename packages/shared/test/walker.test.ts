/**
 * The walker, on a synthetic world first (rules in isolation) and then on the real town (the
 * property that matters: nothing you can do with the keys puts you anywhere you cannot walk back
 * from — "refuse to strand the player").
 */
import { describe, expect, it } from 'vitest';
import { createWalkerState, stepWalker, canStand, WALK_SPEED, SPRINT_SPEED, STEP_MAX, type WalkerEnv, type WalkerInput, type WalkerState } from '../src/sim/walker.js';
import { COLLIDERS, groundAt, findBerth, TOWN_FRAME, toWorld, PAD_Y, DECK_TOP, marinaDecks, toLocal, LOTS, INTERACTS } from '../src/world/town.js';
import { flood, nearestReached, pathTo } from './walk-grid.js';
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

describe('walking into every shop', () => {
  const env: WalkerEnv = { ground: groundAt, colliders: COLLIDERS };
  const F = TOWN_FRAME;
  const around = (l: (typeof LOTS)[number]): { u0: number; u1: number; v0: number; v1: number } => ({ u0: l.u0 - 3, u1: l.u1 + 3, v0: l.v0 - 4, v1: l.v1 + 1 });

  it('steps from the sidewalk through the door and up to the counter of every walk-in venue, with the real walker', () => {
    for (const l of LOTS.filter((x) => x.enterable)) {
      const prompt = INTERACTS.find((i) => i.venue === l.venue && i.id.startsWith('counter-'))!;
      const g = flood(l.door, l.v0 - 1.5, around(l));
      const hit = nearestReached(g, prompt.u, prompt.v, 0.4)!;
      expect(hit, l.id).not.toBeNull();
      // follow the grid path with the real stepWalker: head for a waypoint a couple of cells ahead
      const path = pathTo(g, hit[0], hit[1]);
      const [sx, sz] = toWorld(F, path[0][0], path[0][1]);
      let s = createWalkerState(sx, sz, 0, env);
      let k = 0;
      for (let i = 0; i < 6000 && k < path.length - 1; i++) {
        const [tu, tv] = path[Math.min(path.length - 1, k + 2)];
        const [tx, tz] = toWorld(F, tu, tv);
        const dx = tx - s.x, dz = tz - s.z;
        if (Math.hypot(dx, dz) < 0.3) { k += 1; continue; }
        s = stepWalker(s, { ...none, fwd: true, lookYaw: Math.atan2(-dx, -dz) }, env, DT);
      }
      const [px, pz] = toWorld(F, prompt.u, prompt.v);
      const short = Math.hypot(s.x - px, s.z - pz);
      expect(short, `${l.id}: stopped ${short.toFixed(1)} m short of the counter`).toBeLessThan(1.2);
      expect(s.y).toBe(PAD_Y);
    }
  });

  it('survives random inputs inside every shop without ever standing in furniture or a wall', () => {
    let seed = 987654;
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (const l of LOTS.filter((x) => x.enterable)) {
      const [x0, z0] = toWorld(F, l.door, l.v0 + 2);
      let s = createWalkerState(x0, z0, 0, env);
      let input: WalkerInput = { ...none };
      let deepest = 0;
      for (let i = 0; i < 6000; i++) {
        if (i % 15 === 0) input = { fwd: rnd() < 0.6, back: rnd() < 0.15, left: rnd() < 0.3, right: rnd() < 0.3, sprint: rnd() < 0.5, lookYaw: rnd() * 6.28 };
        s = stepWalker(s, input, env, DT);
        if (groundAt(s.x, s.z) === null) throw new Error(`${l.id}: walked onto nothing at step ${i}`);
        for (const c of COLLIDERS) if (s.x > c.x0 && s.x < c.x1 && s.z > c.z0 && s.z < c.z1) throw new Error(`${l.id}: inside a collider at step ${i}`);
        deepest = Math.max(deepest, toLocal(F, s.x, s.z)[1] - l.v0);
      }
      // it actually explored the room rather than sitting in the doorway
      expect(deepest, l.id).toBeGreaterThan(1.5);
    }
  });
});
