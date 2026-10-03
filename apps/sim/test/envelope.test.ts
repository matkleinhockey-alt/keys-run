import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createBoatState, stepBoat, type BoatEnv, type BoatHull, type BoatInput } from '@keysrun/shared/sim/boat';
import { createShadowState, stepBoatShadow, type ShadowBoatState } from '@keysrun/shared/sim/boat-shadow';
import { DEFAULT_CH, DEFAULT_SW } from '@keysrun/shared/waves';
import { WB } from '@keysrun/shared/world/depth';
import { BOATS } from '@keysrun/shared/content/boats';
import { reconcileBoat } from '../src/world/envelope.js';

const DT = 1 / 30;

function hullFor(id: string): BoatHull {
  const b = BOATS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown boat ${id}`);
  return { len: b.len, beam: b.beam, top: b.top, accel: b.accel, turn: b.turn, draft: b.draft, cat: b.cat };
}

const NEUTRAL: BoatInput = { fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false };

function fullEnvAt(t: number, hull: BoatHull): BoatEnv {
  return {
    t,
    hull,
    sw: DEFAULT_SW,
    ch: DEFAULT_CH,
    worldBounds: WB,
    pilings: [],
    dockRects: [],
    canDrive: true,
    fightActive: false,
    fightTarget: null,
    lineOut: false,
    luigiOn: false,
  };
}

/** A short-ish, smoothly-varying (not frame-noisy) control sequence — what a real player drives. */
const controlSequenceArb = fc.array(
  fc.record({
    fwd: fc.boolean(),
    back: fc.boolean(),
    left: fc.boolean(),
    right: fc.boolean(),
    holdTicks: fc.integer({ min: 5, max: 60 }),
  }),
  { minLength: 3, maxLength: 12 },
);

function expandControls(spec: { fwd: boolean; back: boolean; left: boolean; right: boolean; holdTicks: number }[]): BoatInput[] {
  const out: BoatInput[] = [];
  for (const s of spec) {
    for (let i = 0; i < s.holdTicks; i++) out.push({ ...NEUTRAL, fwd: s.fwd, back: s.back, left: s.left, right: s.right });
  }
  return out;
}

/** Runs a "legitimate" session: full stepBoat as the client, stepBoatShadow + reconcileBoat as the server. */
function runLegitimateSession(hullId: string, controls: BoatInput[], startX: number, startZ: number, startH: number) {
  const hull = hullFor(hullId);
  let client = createBoatState(startX, startZ, startH);
  let shadow: ShadowBoatState = createShadowState(startX, startZ, startH);
  let prevReport = { x: startX, z: startZ, h: startH, speed: 0 };

  const violations: { tick: number; reason: string | null }[] = [];

  for (let tick = 0; tick < controls.length; tick++) {
    const input = controls[tick];
    const t = tick * DT;
    client = stepBoat(client, input, fullEnvAt(t, hull), DT);
    shadow = stepBoatShadow(shadow, input, { t, hull, sw: DEFAULT_SW, ch: DEFAULT_CH }, DT);

    const result = reconcileBoat({
      prevX: prevReport.x,
      prevZ: prevReport.z,
      prevH: prevReport.h,
      prevSpeed: prevReport.speed,
      reportX: client.x,
      reportZ: client.z,
      reportH: client.h,
      reportSpeed: client.speed,
      shadow,
      hull,
      dt: DT,
    });

    if (result.violated) violations.push({ tick, reason: result.reason });
    shadow = result.newShadow;
    prevReport = { x: client.x, z: client.z, h: client.h, speed: client.speed };
  }

  return { violations, finalClient: client };
}

describe('reconcileBoat: legitimate play is never falsely rejected', () => {
  it('a full stepBoat client (every hull) tracked by the cheap shadow never trips the envelope over smooth control sequences', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BOATS.map((b) => b.id)),
        controlSequenceArb,
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: 1200, max: 1600, noNaN: true }), // dz in the Hawk-Channel-ish band: real navigable water
        (hullId, controlSpec, startX, startDz) => {
          const controls = expandControls(controlSpec);
          if (controls.length === 0) return;
          const { violations } = runLegitimateSession(hullId, controls, startX, startDz, 0);
          expect(violations).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('holding full throttle from rest to top speed never trips the speed/accel/turn checks', () => {
    for (const boat of BOATS) {
      const controls = Array.from({ length: 30 * 15 }, () => ({ ...NEUTRAL, fwd: true }));
      const { violations } = runLegitimateSession(boat.id, controls, 0, 1400, 0);
      expect(violations).toEqual([]);
    }
  });

  it('a hard turn at speed never trips the turn-rate check', () => {
    const controls = [
      ...Array.from({ length: 150 }, () => ({ ...NEUTRAL, fwd: true })),
      ...Array.from({ length: 90 }, () => ({ ...NEUTRAL, fwd: true, left: true })),
    ];
    const { violations } = runLegitimateSession('robalo', controls, 0, 1400, 0);
    expect(violations).toEqual([]);
  });
});

describe('reconcileBoat: cheating is rejected and flagged', () => {
  const hull = hullFor('robalo');

  function baseline(): ShadowBoatState {
    return { x: 0, z: 1400, h: 0, speed: 10, thr: 0.5, steer: 0, gear: 'D' };
  }

  it('a teleport (large instantaneous jump) is rejected', () => {
    const shadow = baseline();
    const result = reconcileBoat({
      prevX: shadow.x,
      prevZ: shadow.z,
      prevH: shadow.h,
      prevSpeed: shadow.speed,
      reportX: shadow.x + 500,
      reportZ: shadow.z + 500,
      reportH: shadow.h,
      reportSpeed: shadow.speed,
      shadow,
      hull,
      dt: DT,
    });
    expect(result.violated).toBe(true);
    expect(result.corrected).toBe(true);
    expect(result.x).toBe(shadow.x);
    expect(result.z).toBe(shadow.z);
  });

  it('an impossible speed claim is rejected', () => {
    const shadow = baseline();
    const result = reconcileBoat({
      prevX: shadow.x,
      prevZ: shadow.z,
      prevH: shadow.h,
      prevSpeed: shadow.speed,
      reportX: shadow.x,
      reportZ: shadow.z,
      reportH: shadow.h,
      reportSpeed: 500, // way above any hull's top speed
      shadow,
      hull,
      dt: DT,
    });
    expect(result.violated).toBe(true);
    expect(result.reason).toBe('speed');
  });

  it('driving onto land is rejected regardless of leash distance', () => {
    const shadow = baseline();
    // A point with landH > 0.2 inshore of the chain — pick a spot well up a real island's beach.
    // prevX/prevZ equal the report itself (zero implied one-tick motion) so this isolates the
    // land check specifically, rather than also tripping the position-delta check.
    const onLandX = shadow.x;
    const onLandZ = 50; // far inshore of Hawk Channel; dz near 0 is beach/shoreline territory
    const result = reconcileBoat({
      prevX: onLandX,
      prevZ: onLandZ,
      prevH: shadow.h,
      prevSpeed: 0,
      reportX: onLandX,
      reportZ: onLandZ,
      reportH: shadow.h,
      reportSpeed: 0,
      shadow: { ...shadow, x: onLandX, z: onLandZ }, // shadow "agrees" too — isolates the land check further
      hull,
      dt: DT,
    });
    expect(result.violated).toBe(true);
    expect(result.reason).toBe('land');
  });

  it('beyond the hard leash (>12m from the shadow) is rejected and corrected from the shadow', () => {
    const shadow = baseline();
    // The client's own report is self-consistent tick-to-tick (prev == report, zero implied
    // motion) — only its *shadow* is far away, modelling a boat that has gradually diverged from
    // the server's cheap model (e.g. via wake pushes the shadow doesn't simulate) rather than a
    // sudden teleport, which is what the leash (as opposed to the position-delta check) exists to
    // judge independently.
    const reportX = shadow.x + 20;
    const result = reconcileBoat({
      prevX: reportX,
      prevZ: shadow.z,
      prevH: shadow.h,
      prevSpeed: shadow.speed,
      reportX,
      reportZ: shadow.z,
      reportH: shadow.h,
      reportSpeed: shadow.speed,
      shadow,
      hull,
      dt: DT,
    });
    expect(result.violated).toBe(true);
    expect(result.reason).toBe('leash');
    expect(result.x).toBe(shadow.x);
  });

  it('within the soft leash (<3m) is accepted verbatim and resyncs the shadow', () => {
    const shadow = baseline();
    const result = reconcileBoat({
      prevX: shadow.x,
      prevZ: shadow.z,
      prevH: shadow.h,
      prevSpeed: shadow.speed,
      reportX: shadow.x + 1,
      reportZ: shadow.z,
      reportH: shadow.h,
      reportSpeed: shadow.speed,
      shadow,
      hull,
      dt: DT,
    });
    expect(result.violated).toBe(false);
    expect(result.corrected).toBe(false);
    expect(result.x).toBe(shadow.x + 1);
    expect(result.newShadow.x).toBe(shadow.x + 1);
  });

  it('between soft and hard leash (3-12m) is accepted but pulls the shadow only partway', () => {
    const shadow = baseline();
    const reportX = shadow.x + 8;
    const result = reconcileBoat({
      prevX: reportX,
      prevZ: shadow.z,
      prevH: shadow.h,
      prevSpeed: shadow.speed,
      reportX,
      reportZ: shadow.z,
      reportH: shadow.h,
      reportSpeed: shadow.speed,
      shadow,
      hull,
      dt: DT,
    });
    expect(result.violated).toBe(false);
    expect(result.corrected).toBe(false);
    expect(result.x).toBe(shadow.x + 8); // report trusted verbatim
    expect(result.newShadow.x).toBeGreaterThan(shadow.x);
    expect(result.newShadow.x).toBeLessThan(shadow.x + 8); // but shadow only partway pulled
  });

  it('corrections never carry y/pitch/roll fields (structural — EnvelopeOutput has none)', () => {
    const shadow = baseline();
    const result = reconcileBoat({
      prevX: shadow.x,
      prevZ: shadow.z,
      prevH: shadow.h,
      prevSpeed: shadow.speed,
      reportX: shadow.x + 1000,
      reportZ: shadow.z,
      reportH: shadow.h,
      reportSpeed: shadow.speed,
      shadow,
      hull,
      dt: DT,
    });
    expect(Object.keys(result).sort()).toEqual(['corrected', 'h', 'newShadow', 'reason', 'speed', 'violated', 'x', 'z'].sort());
  });
});
