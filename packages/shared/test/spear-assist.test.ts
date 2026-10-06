/**
 * Spearfishing aim assist. The load-bearing property is the cone bound: assist must stay well
 * inside docs/ARCHITECTURE.md's 0.22 rad server aim-plausibility window, or the feature that makes
 * the gun usable would also make every assisted shot look like an aimbot to the server.
 */
import { describe, expect, it } from 'vitest';
import {
  assistAim, timeToDistance, distAtFlightTime,
  ASSIST_CONE, SPEAR_RANGE,
  type AssistTarget,
} from '../src/sim/spear.js';

const ORIGIN = { x: 0, y: 0, z: 0 };
const FWD = { x: 0, y: 0, z: 1 };

/** A capsule centred at (x,y,z), axis along X, optionally moving. */
function target(id: string, x: number, y: number, z: number, v?: { vx?: number; vy?: number; vz?: number }): AssistTarget {
  return { id, ax: x - 0.2, ay: y, az: z, bx: x + 0.2, by: y, bz: z, radius: 0.15, ...v };
}

/** Angle between two (not necessarily unit) vectors. */
function angleBetween(a: { x: number; y: number; z: number }, b: { dx: number; dy: number; dz: number }): number {
  const al = Math.hypot(a.x, a.y, a.z), bl = Math.hypot(b.dx, b.dy, b.dz);
  return Math.acos(Math.min(1, Math.max(-1, (a.x * b.dx + a.y * b.dy + a.z * b.dz) / (al * bl))));
}

describe('timeToDistance', () => {
  it('inverts distAtFlightTime', () => {
    for (const d of [0.5, 2, 5, 8, 11]) {
      expect(distAtFlightTime(timeToDistance(d))).toBeCloseTo(d, 6);
    }
  });

  it('is finite even past the shaft’s asymptotic max range', () => {
    expect(Number.isFinite(timeToDistance(1e6))).toBe(true);
    expect(timeToDistance(0)).toBeCloseTo(0, 9);
  });

  it('a shot at 8 m really is airborne long enough for leading to matter', () => {
    // This is the premise of the whole feature: if time of flight were negligible, aiming straight
    // at the fish would be correct and the lead term would be noise.
    expect(timeToDistance(8)).toBeGreaterThan(0.35);
  });
});

describe('assistAim', () => {
  it('returns the input direction untouched when there are no targets', () => {
    const r = assistAim(ORIGIN, FWD, []);
    expect(r.targetId).toBeNull();
    expect(r.applied).toBe(0);
    expect(r.dz).toBeCloseTo(1, 9);
  });

  it('ignores targets outside the cone', () => {
    // ~34 deg off axis, far outside ASSIST_CONE.
    const r = assistAim(ORIGIN, FWD, [target('far-off', 4, 0, 6)]);
    expect(r.targetId).toBeNull();
  });

  it('locks a target just inside the cone and moves aim toward it', () => {
    const t = target('near', 0.3, 0, 6); // ~2.9 deg off axis
    const r = assistAim(ORIGIN, FWD, [t]);
    expect(r.targetId).toBe('near');
    expect(r.applied).toBeGreaterThan(0);
    expect(r.dx).toBeGreaterThan(0); // nudged toward +x, where the fish is
  });

  it('NEVER moves aim further than the cone — the server anti-aimbot bound', () => {
    // Sweep targets all round the cone edge and well past it; nothing may exceed ASSIST_CONE,
    // which is itself far inside the server's 0.22 rad plausibility window.
    for (let a = 0; a < Math.PI * 2; a += 0.21) {
      for (const off of [0.05, 0.3, 0.8, 2.5]) {
        for (const dist of [1, 4, 8, 10.5]) {
          const t = target('t', Math.cos(a) * off, Math.sin(a) * off, dist, { vx: 2, vy: 1, vz: -2 });
          const r = assistAim(ORIGIN, FWD, [t]);
          expect(r.applied).toBeLessThanOrEqual(ASSIST_CONE + 1e-9);
          expect(r.applied).toBeLessThan(0.22); // the documented server envelope
        }
      }
    }
  });

  it('is partial, not a snap — aim lands between the original and the target', () => {
    const t = target('near', 0.5, 0, 6);
    const r = assistAim(ORIGIN, FWD, [t], { cone: 0.5 });
    const toTarget = { x: 0.5, y: 0, z: 6 };
    const full = angleBetween(toTarget, { dx: 0, dy: 0, dz: 1 });
    // Moved meaningfully toward the fish, but not all the way onto it.
    expect(r.applied).toBeGreaterThan(full * 0.3);
    expect(r.applied).toBeLessThan(full * 0.95);
  });

  it('leads a crossing target — aims ahead of where it currently is', () => {
    const still = assistAim(ORIGIN, FWD, [target('a', 0, 0, 8)], { cone: 0.5, strength: 1 });
    const moving = assistAim(ORIGIN, FWD, [target('a', 0, 0, 8, { vx: 2 })], { cone: 0.5, strength: 1 });
    // The crossing fish must be led in its direction of travel (+x), the stationary one not.
    expect(Math.abs(still.dx)).toBeLessThan(1e-6);
    expect(moving.dx).toBeGreaterThan(0.05);
  });

  it('leads further for a faster target', () => {
    const slow = assistAim(ORIGIN, FWD, [target('a', 0, 0, 8, { vx: 1 })], { cone: 0.6, strength: 1 });
    const fast = assistAim(ORIGIN, FWD, [target('a', 0, 0, 8, { vx: 3 })], { cone: 0.6, strength: 1 });
    expect(fast.dx).toBeGreaterThan(slow.dx);
  });

  it('never locks a non-catchable target — the shaft would pass straight through it', () => {
    const dolphin = { ...target('dolphin', 0.2, 0, 6), catchable: false as const };
    expect(assistAim(ORIGIN, FWD, [dolphin]).targetId).toBeNull();
    // ...and with a legal fish slightly further off axis, that one wins instead.
    const fish = target('fish', -0.45, 0, 6);
    expect(assistAim(ORIGIN, FWD, [dolphin, fish]).targetId).toBe('fish');
  });

  it('prefers the target closest to the crosshair, not merely the nearest one', () => {
    const closeButOffAxis = target('off', 0.55, 0, 5);
    const furtherButCentred = target('centred', 0.05, 0, 9);
    expect(assistAim(ORIGIN, FWD, [closeButOffAxis, furtherButCentred]).targetId).toBe('centred');
  });

  it('ignores targets beyond spear range', () => {
    expect(assistAim(ORIGIN, FWD, [target('t', 0, 0, SPEAR_RANGE + 4)]).targetId).toBeNull();
  });

  it('ignores a target practically inside the muzzle', () => {
    expect(assistAim(ORIGIN, FWD, [target('t', 0, 0, 0.1)]).targetId).toBeNull();
  });

  it('always returns a unit direction', () => {
    for (const vx of [0, 1, 4]) {
      const r = assistAim(ORIGIN, FWD, [target('t', 0.2, 0.1, 7, { vx })]);
      expect(Math.hypot(r.dx, r.dy, r.dz)).toBeCloseTo(1, 9);
    }
  });

  it('strength 0 reports a lock without moving aim — the reticle feed', () => {
    const r = assistAim(ORIGIN, FWD, [target('t', 0.3, 0, 6)], { strength: 0 });
    expect(r.targetId).toBe('t');
    expect(r.applied).toBeCloseTo(0, 9);
    expect(r.dz).toBeCloseTo(1, 9);
  });
});
