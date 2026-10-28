/**
 * Added resistance in waves: what a seaway costs the boat.
 *
 * Before this, a seaway cost nothing. Measured wide open across every heading in a big swell the
 * boat made 54.3 to 56.6 knots whether it was running away from the sea or punching into it, and
 * it managed 49 degrees of peak-to-peak pitch and a fifth of its time airborne precisely BECAUSE
 * nothing slowed it down.
 *
 * These pin the behaviour, not the coefficients: which way you point has to matter, and the
 * motion has to be something a hull could survive.
 */
import { describe, expect, it } from 'vitest';
import { createBoatState, stepBoat, type BoatEnv, type BoatInput } from '../src/sim/boat.js';
import { SEA_STATES } from '../src/waves/index.js';
import { chainZ } from '../src/world/chain.js';
import { WB } from '../src/world/depth.js';
import { SPEED_SCALE } from '../src/content/boats.js';

const HULL = { len: 9.3, beam: 3.23, top: 58, accel: 0.5, turn: 0.9, draft: 0.72 };
const DT = 1 / 60;
const INPUT: BoatInput = { fwd: true, back: false, left: false, right: false, trimUp: false, trimDn: false };

/** Hold the throttle open on `headingDeg` in deep water and report how it goes. */
function run(headingDeg: number, sw: number, ch: number, secs = 55) {
  let st = createBoatState();
  st.x = 0; st.z = chainZ(0) + 2600; st.h = headingDeg * Math.PI / 180;
  st.engineOn = true; st.gear = 'D';
  const env: Omit<BoatEnv, 't'> = {
    hull: HULL, sw, ch, worldBounds: WB, pilings: [], dockRects: [],
    canDrive: true, fightActive: false, lineOut: false, luigiOn: false,
  };
  let pMin = 9, pMax = -9, air = 0, n = 0, sumSpeed = 0;
  for (let i = 0; i < secs / DT; i++) {
    st = stepBoat(st, INPUT, { ...env, t: i * DT }, DT);
    if (i * DT < 25) continue;                   // let it settle at whatever the sea allows
    if (st.air) air++;
    pMin = Math.min(pMin, st.pitch); pMax = Math.max(pMax, st.pitch);
    sumSpeed += st.speed; n++;
  }
  return {
    kn: sumSpeed / n / SPEED_SCALE / 0.5144,
    pitchDeg: (pMax - pMin) * 180 / Math.PI,
    airPct: 100 * air / n,
  };
}

const BIG = SEA_STATES.find((s) => s.n === 'Big swell')!;
const CALM = SEA_STATES.find((s) => s.n === 'Calm')!;

describe('a seaway costs you speed', () => {
  it('punishes a head sea and leaves a following sea alone', () => {
    // 0 degrees runs away from the swell, 180 punches into it. Both wide open.
    const following = run(0, BIG.sw, BIG.ch);
    const head = run(180, BIG.sw, BIG.ch);
    expect(head.kn, 'head sea should be far slower').toBeLessThan(following.kn * 0.8);
    expect(following.kn, 'a following sea should barely cost anything').toBeGreaterThan(50);
  });

  it('costs almost nothing in a calm', () => {
    // If flat water slowed the boat down the whole model would be wrong.
    expect(run(0, CALM.sw, CALM.ch).kn).toBeGreaterThan(53);
  });

  it('costs more in a bigger sea, on the same heading', () => {
    expect(run(180, BIG.sw, BIG.ch).kn).toBeLessThan(run(180, CALM.sw, CALM.ch).kn);
  });

  it('keeps the motion to something a hull could live through', () => {
    // The symptom that started this: 49 degrees of pitch and 21% of the run in the air, both
    // only reachable because the boat never slowed. It is still rough — it should be — but a
    // centre console is not standing on end.
    const head = run(180, BIG.sw, BIG.ch);
    expect(head.pitchDeg, 'peak-to-peak pitch').toBeLessThan(32);
    expect(head.airPct, 'time airborne').toBeLessThan(13);
  });

  it('still gets out of its own way — the sea slows it, it does not stop it', () => {
    // A resistance term with no ceiling would park the boat in a chop.
    const CHOP = SEA_STATES.find((s) => s.n === 'Choppy')!;
    for (const hd of [0, 90, 180, 270]) {
      expect(run(hd, CHOP.sw, CHOP.ch).kn, `heading ${hd}`).toBeGreaterThan(30);
    }
  });

  it('can be switched off, for the legacy oracle', () => {
    // boat-trajectory.test.ts compares against a legacy extract that predates all of this.
    let a = createBoatState(), b = createBoatState();
    for (const s of [a, b]) { s.x = 0; s.z = chainZ(0) + 2600; s.engineOn = true; s.gear = 'D'; s.h = Math.PI; }
    const base: Omit<BoatEnv, 't'> = {
      hull: HULL, sw: BIG.sw, ch: BIG.ch, worldBounds: WB, pilings: [], dockRects: [],
      canDrive: true, fightActive: false, lineOut: false, luigiOn: false,
    };
    for (let i = 0; i < 40 / DT; i++) {
      a = stepBoat(a, INPUT, { ...base, t: i * DT }, DT);
      b = stepBoat(b, INPUT, { ...base, t: i * DT, seakeeping: 0 }, DT);
    }
    expect(b.speed, 'seakeeping: 0 should not be slowed').toBeGreaterThan(a.speed);
  });
});
