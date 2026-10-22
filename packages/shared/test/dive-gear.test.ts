/**
 * Dive gear: scaled air budget, fins, and the pony-bottle fill rule. Bottom time is measured in
 * SIMULATED seconds by stepping the pure sim (a 252 s breath hold cannot be waited out live).
 */
import { describe, expect, it } from 'vitest';
import {
  AIR_MAX, NEUTRAL_DEPTH, airBurnRate, airMaxFor, createDiverState, stepDiver,
  type DiverEnv, type DiverInput, type DiverState, type SeafloorSampler,
} from '../src/sim/diver.js';
import { NO_GEAR, TANK_BREATH_MUL, TANK_CHARGE_DEPTH, loadoutFor, shouldChargeFill, type DiveGear } from '../src/sim/dive-gear.js';
import { emptyInventory, modifiersFor, buy, type Inventory } from '../src/sim/shop.js';

const DT = 1 / 30;
const OPEN = { x0: -1e6, x1: 1e6, z0: -1e6, z1: 1e6 };
const CALM = { x: -3000, z: -2500 }; // slack water, so we measure the diver, not the current
const IDLE: DiverInput = { fwd: false, back: false, left: false, right: false, ascend: false, descend: false, sprint: false, lookYaw: 0, lookPitch: 0 };
const envFor = (floor: SeafloorSampler, swimMul = 1): DiverEnv => ({ t: 0, seafloor: floor, worldBounds: OPEN, swimMul });

/**
 * Seconds until blackout starting on the floor at `depth` (the pony-bottle use case: park and
 * shoot). NOT a constant-depth measurement any more: buoyancy no longer pulls a diver down below
 * neutral (sim/diver.ts's `BUOY_DRIFT_UP_ACCEL`), so a diver who stops working drifts up off the
 * bottom and burns air a little slower than the ATA rate at `depth` would suggest. That is the
 * point of the change, not a flaw in it — see the assertions below, which account for it.
 */
function bottomTime(airMax: number, depth: number, input: Partial<DiverInput> = {}): number {
  const floor: SeafloorSampler = { heightAt: () => -depth - 0.35 };
  let s: DiverState = createDiverState(CALM.x, -depth, CALM.z, 0, airMax);
  let t = 0;
  while (!s.blackedOut && t < 2000) { s = stepDiver(s, { ...IDLE, ...input }, envFor(floor), DT); t += DT; }
  return t;
}

const kit = (...keys: string[]): Inventory => ({ ...emptyInventory(), gear: keys });
const FULL = ['dive.tank', 'dive.wetsuit', 'dive.fins', 'dive.mask'];
const gearOf = (inv: Inventory, fills: number): DiveGear => {
  const mods = modifiersFor(inv, 0);
  return { mods, hasTank: inv.gear.includes('dive.tank'), fills };
};

describe('scaled air budget', () => {
  it('full kit is ~252 s of surface air, and airMaxFor guards bad input', () => {
    const m = modifiersFor(kit(...FULL), 0);
    expect(airMaxFor(m.breathMul)).toBeCloseTo(252.4, 0);
    expect(airMaxFor(1)).toBe(AIR_MAX);
    expect(airMaxFor(NaN)).toBe(AIR_MAX);
    expect(airMaxFor(0)).toBe(AIR_MAX);       // never an instant blackout
    expect(airMaxFor(1e9)).toBe(AIR_MAX * 6); // never silly
  });

  it('tank factor here agrees with the shop (fails loudly if shop.ts is retuned)', () => {
    expect(modifiersFor(kit('dive.tank'), 0).breathMul).toBeCloseTo(TANK_BREATH_MUL, 10);
  });

  it('bottom time scales linearly with the budget and still obeys ATA (depth stays self-limiting)', () => {
    // `descend` held, which is what "park on the bottom" MEANS now: buoyancy never pulls a diver
    // under any more (sim/diver.ts's `BUOY_DRIFT_UP_ACCEL`), so an idle diver drifts up, reaches
    // the surface and refills — with a full kit's budget they never black out at all and this
    // measured 2000 s, the harness's own cap. That is the safety the change buys and it is
    // correct; it just means bottom time has to be measured on a diver who is holding themselves
    // down, not on one who has let go.
    const HOLD = { descend: true };
    const base = bottomTime(AIR_MAX, 15, HOLD);
    const full = bottomTime(airMaxFor(modifiersFor(kit(...FULL), 0).breathMul), 15, HOLD);
    // SHORTER than the resting figure, not longer: holding yourself down is work, and work burns
    // air. That is the trade the drift introduces — the bottom is still yours, you just pay for it.
    const resting = AIR_MAX / airBurnRate(15, 0);
    expect(base).toBeLessThan(resting);
    expect(base).toBeGreaterThan(resting * 0.5);
    expect(full / base).toBeCloseTo(2.804, 1);
    // deeper still burns proportionally faster with the big budget — held down, same as above.
    // Without HOLD this one measured 70.4 s against a 43.8 s bound: the diver simply drifted up
    // out of the 30 m it was supposed to be testing.
    expect(bottomTime(airMaxFor(2.804), 30, HOLD)).toBeLessThan(full / 1.5);
  });

  it('prints bottom time per item', () => {
    const rows: string[] = [];
    for (const [name, keys] of [['none', []], ['tank', ['dive.tank']], ['wetsuit', ['dive.wetsuit']], ['fins', ['dive.fins']], ['mask', ['dive.mask']], ['full', FULL]] as const) {
      const a = airMaxFor(modifiersFor(kit(...keys), 0).breathMul);
      rows.push(`${name}: surface-equiv ${a.toFixed(1)} s, rest@15m ${bottomTime(a, 15).toFixed(1)} s`);
    }
    console.log(rows.join('\n'));
    expect(rows).toHaveLength(6);
  });

  it('refill at the surface is relative to the scaled budget and caps there', () => {
    const big = airMaxFor(2.804);
    let s: DiverState = { ...createDiverState(CALM.x, 0, CALM.z, 0, big), air: big * 0.1 };
    const floor: SeafloorSampler = { heightAt: () => -50 };
    // Buoyancy bobs a floating diver across the SURFACE_EPS band; give the 3 s refill room to land.
    for (let i = 0; i < 12 * 30; i++) s = stepDiver(s, IDLE, envFor(floor), DT);
    expect(s.air).toBeGreaterThan(big * 0.98);
    expect(s.air).toBeLessThanOrEqual(big);
  });

  it('shallow-water blackout threshold stays in absolute seconds, not a fraction of the bigger budget', () => {
    const big = airMaxFor(2.804);
    const floor: SeafloorSampler = { heightAt: () => -50 };
    // 15 s of air at 3 m on a 252 s budget is 6%: would blackout if the threshold scaled (8% = 20 s).
    const s0: DiverState = { ...createDiverState(CALM.x, -3, CALM.z, 0, big), air: 15, vy: 1 };
    expect(stepDiver(s0, IDLE, envFor(floor), DT).blackedOut).toBe(false);
    const s1: DiverState = { ...s0, air: AIR_MAX * 0.05 };
    expect(stepDiver(s1, IDLE, envFor(floor), DT).blackedOut).toBe(true);
  });

  it('stepDiver stays pure: input state is not mutated', () => {
    const s = createDiverState(CALM.x, -5, CALM.z, 0, 200);
    const snap = JSON.stringify(s);
    stepDiver(s, { ...IDLE, fwd: true }, envFor({ heightAt: () => -50 }, 1.28), DT);
    expect(JSON.stringify(s)).toBe(snap);
  });
});

describe('fins (swimMul)', () => {
  const floor: SeafloorSampler = { heightAt: () => -1000 };
  function cruise(swimMul: number, seconds: number): { speed: number; dist: number; glide: number } {
    let s = createDiverState(CALM.x, -NEUTRAL_DEPTH, CALM.z, 0, AIR_MAX);
    for (let i = 0; i < seconds * 30; i++) s = stepDiver(s, { ...IDLE, fwd: true }, envFor(floor, swimMul), DT);
    const speed = Math.hypot(s.vx, s.vz), dist = Math.hypot(s.x - CALM.x, s.z - CALM.z);
    const x0 = s.x, z0 = s.z;
    for (let i = 0; i < 20 * 30; i++) s = stepDiver(s, IDLE, envFor(floor, swimMul), DT);
    return { speed, dist, glide: Math.hypot(s.x - x0, s.z - z0) };
  }

  it('fins raise cruise speed, but sub-linearly because drag is still applied (not a velocity hack)', () => {
    const a = cruise(1, 12), b = cruise(1.28, 12);
    const gain = b.speed / a.speed;
    console.log('[fins] cruise', a.speed.toFixed(2), '->', b.speed.toFixed(2), 'm/s  x', gain.toFixed(3), ' dist12s', a.dist.toFixed(1), '->', b.dist.toFixed(1));
    expect(gain).toBeGreaterThan(1.08);
    expect(gain).toBeLessThan(1.28);
  });

  it('the drag model is intact with fins: sideslip still dies fast and a coast still glides', () => {
    const b = cruise(1.28, 12);
    expect(b.glide).toBeGreaterThan(1.5); // momentum, not a stop
    let s = { ...createDiverState(CALM.x, -NEUTRAL_DEPTH, CALM.z, 0, AIR_MAX), vx: 2 }; // pure sideways slip
    for (let i = 0; i < 30; i++) s = stepDiver(s, IDLE, envFor(floor, 1.28), DT);
    expect(Math.abs(s.vx)).toBeLessThan(0.45);
  });

  it('swimMul 1 or undefined is bit-identical to before', () => {
    let a = createDiverState(CALM.x, -5, CALM.z, 0), b = a;
    for (let i = 0; i < 60; i++) {
      a = stepDiver(a, { ...IDLE, fwd: true }, { t: 0, seafloor: floor, worldBounds: OPEN }, DT);
      b = stepDiver(b, { ...IDLE, fwd: true }, envFor(floor, 1), DT);
    }
    expect(b).toEqual(a);
  });
});

describe('pony bottle fill rule', () => {
  const owned = kit(...FULL);

  it('with a fill the bottle is live; without one only its factor is withheld', () => {
    const withFill = loadoutFor(gearOf(owned, 1));
    const without = loadoutFor(gearOf(owned, 0));
    expect(withFill.tankLive).toBe(true);
    expect(withFill.airMax).toBeCloseTo(252.4, 0);
    expect(without.tankLive).toBe(false);
    expect(without.airMax).toBeCloseTo(AIR_MAX * 1.18 * 1.08, 3); // suit + fins still work
    expect(without.swimMul).toBeCloseTo(1.28, 10);
    expect(without.viewBonusM).toBe(6);
  });

  it('can never leave a diver with less than a gearless diver (no stranding)', () => {
    for (const keys of [[], ['dive.tank'], FULL])
      for (const fills of [0, 1, 5]) {
        const l = loadoutFor(gearOf(kit(...keys), fills));
        expect(l.airMax).toBeGreaterThanOrEqual(AIR_MAX - 1e-9);
      }
    expect(loadoutFor(NO_GEAR).airMax).toBe(AIR_MAX);
  });

  it('spends exactly one fill per dive, only once deep enough', () => {
    const l = loadoutFor(gearOf(owned, 1));
    expect(shouldChargeFill(l, TANK_CHARGE_DEPTH - 0.1, false)).toBe(false); // splashing about is free
    expect(shouldChargeFill(l, TANK_CHARGE_DEPTH, false)).toBe(true);
    expect(shouldChargeFill(l, 20, true)).toBe(false);                        // already paid
    expect(shouldChargeFill(loadoutFor(gearOf(owned, 0)), 20, false)).toBe(false); // nothing to spend
  });

  it('the shop actually sells a fill that this rule can consume', () => {
    const r = buy(owned, 'dive', 'fill', 100, 0);
    expect(r.ok).toBe(true);
    expect(r.inventory.consumables['dive.fill']).toBe(1);
  });
});
