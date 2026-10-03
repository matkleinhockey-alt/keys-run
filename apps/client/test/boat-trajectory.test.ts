/**
 * Physics fidelity test (docs/ARCHITECTURE.md Phase 0 acceptance criterion A, "the strong
 * test"): drives an independent, legacy-extracted oracle (boat-oracle.ts) and the new pure
 * `stepBoat` (packages/shared/src/sim/boat.ts) through an identical ~600-step scripted input
 * sequence at a forced fixed dt of 1/30, and asserts the trajectories match tightly.
 *
 * If this test fails, the port has a real bug — per the task brief, the fix is to find and fix
 * it, not to loosen the tolerance.
 */

import { describe, expect, it } from 'vitest';
import { createBoatState, stepBoat, type BoatEnv, type BoatInput, type BoatState, type DockRect, type Piling } from '@keysrun/shared/sim/boat';
import { chainZ } from '@keysrun/shared/world/chain';
import { WB } from '@keysrun/shared/world/depth';
import { createBoatOracle, type OracleControls, type OracleDockRect, type OraclePiling, type OracleSnapshot } from './boat-oracle.js';

const DT = 1 / 30;

// legacy's grady-white hull (BOATS[1] — legacy's actual default boat), trimmed to the fields
// updateBoat/autoChaseControl read. See packages/shared/src/content/boats.ts.
const HULL = { len: 9.3, beam: 3.23, top: 58, accel: 0.5, turn: 0.9, draft: 0.72 };

// legacy SPAWN: open water in Boot Key Harbor (index.html:367).
const SPAWN_X = -1150;
const SPAWN_Z = chainZ(SPAWN_X) + 305;
const SPAWN_H = Math.PI / 2;

interface ScriptStep {
  fwd: boolean; back: boolean; left: boolean; right: boolean;
  trimUp: boolean; trimDn: boolean;
  gear: 'D' | 'N' | 'R';
  trimMode: boolean;
  sw: number; ch: number;
}

const CALM = { sw: 0.9, ch: 1 };       // legacy's initial SW/CH (index.html:435)
const ROUGH = { sw: 2.6, ch: 1.1 };    // legacy SEA_STATES[3], "Big swell"

const base: ScriptStep = { fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false, gear: 'D', trimMode: false, ...CALM };

/**
 * ~600 steps: accelerate, trim, turn, chop, throttle off, reverse, hard turn, trim-mode, idle.
 * Both the oracle and stepBoat are driven by this exact same array — see docs/ARCHITECTURE.md
 * acceptance criterion A.
 */
function buildScript(): ScriptStep[] {
  const steps: ScriptStep[] = [];
  const push = (n: number, over: Partial<ScriptStep>) => {
    for (let i = 0; i < n; i++) steps.push({ ...base, ...over });
  };
  push(90, { fwd: true });                                              // accelerate
  push(15, { fwd: true, trimUp: true });                                 // trim up at speed
  push(90, { fwd: true, left: true });                                   // turn under power
  push(90, { fwd: true, ...ROUGH });                                     // chop
  push(60, {});                                                          // throttle off, coast
  push(40, { fwd: true, gear: 'R' });                                    // reverse thrust
  push(80, { right: true, gear: 'D' });                                  // hard turn, coasting
  push(30, { fwd: true, trimDn: true, trimMode: true });                 // trim mode, trimming down
  push(105, {});                                                         // idle, settle
  return steps;
}

const SCRIPT = buildScript();

function toOracleControls(s: ScriptStep): OracleControls {
  return { fwd: s.fwd, back: s.back, left: s.left, right: s.right, trimUp: s.trimUp, trimDn: s.trimDn, gear: s.gear, engineOn: true, trimMode: s.trimMode, autoChaseEnabled: true };
}

function toBoatInput(s: ScriptStep): BoatInput {
  return { fwd: s.fwd, back: s.back, left: s.left, right: s.right, trimUp: s.trimUp, trimDn: s.trimDn };
}

function baseEnv(sw: number, ch: number, dockRects: readonly DockRect[], pilings: readonly Piling[]): Omit<BoatEnv, 't'> {
  return {
    hull: HULL, sw, ch, worldBounds: WB, pilings, dockRects,
    canDrive: true, fightActive: false, fightTarget: null, lineOut: false, luigiOn: false,
  };
}

/** Run stepBoat alone through the full script with a given (fixed) obstacle set, recording x/z at every step. */
function runPortOnly(dockRects: readonly DockRect[], pilings: readonly Piling[]): Array<{ x: number; z: number }> {
  let state = createBoatState(SPAWN_X, SPAWN_Z, SPAWN_H);
  let t = 0;
  const positions: Array<{ x: number; z: number }> = [];
  for (const s of SCRIPT) {
    t += DT;
    state = { ...state, gear: s.gear, trimMode: s.trimMode };
    state = stepBoat(state, toBoatInput(s), { ...baseEnv(s.sw, s.ch, dockRects, pilings), t }, DT);
    positions.push({ x: state.x, z: state.z });
  }
  return positions;
}

/**
 * Pick two real waypoints on stepBoat's own trajectory to drop a synthetic dock rect and a
 * synthetic piling on — guaranteeing dockCollide/piling-collide are actually exercised, without
 * hand-predicting coordinates. Done in two stages because placing the dock perturbs every later
 * position: stage 1 finds the dock from the *unobstructed* trajectory (valid, since the dock is
 * encountered first); stage 2 finds the piling from the trajectory *with that dock already in
 * play* (so it reflects what Pass 1 will actually fly through by the time it gets there).
 */
function findWaypoints(): { dock: DockRect; piling: Piling } {
  const clean = runPortOnly([], []);
  const a = clean[60];
  const dock: DockRect = { x0: a.x - 4, x1: a.x + 4, z0: a.z - 4, z1: a.z + 4 };

  const withDock = runPortOnly([dock], []);
  const b = withDock[400];
  const piling: Piling = { x: b.x, z: b.z };

  return { dock, piling };
}

describe('boat trajectory: stepBoat vs. an independent legacy-extracted oracle', () => {
  it('matches over a ~600-step scripted input sequence at a fixed 1/30 s timestep', () => {
    const { dock, piling } = findWaypoints();
    const dockRects: DockRect[] = [dock];
    const pilings: Piling[] = [piling];
    const oracleDockRects: OracleDockRect[] = [dock];
    const oraclePilings: OraclePiling[] = [piling];

    let portState: BoatState = createBoatState(SPAWN_X, SPAWN_Z, SPAWN_H);
    const oracle = createBoatOracle(HULL, SPAWN_X, SPAWN_Z, SPAWN_H);

    const maxDiff = { x: 0, z: 0, h: 0, speed: 0, y: 0, pitch: 0, roll: 0 };
    let t = 0;
    let dockHits = 0, pilingHits = 0, slams = 0, beaches = 0;

    for (let i = 0; i < SCRIPT.length; i++) {
      const s = SCRIPT[i];
      t += DT;

      portState = { ...portState, gear: s.gear, trimMode: s.trimMode };
      portState = stepBoat(portState, toBoatInput(s), { ...baseEnv(s.sw, s.ch, dockRects, pilings), t }, DT);
      for (const ev of portState.events) {
        if (ev.type === 'bumpedDock') dockHits++;
        if (ev.type === 'bumpedPiling') pilingHits++;
        if (ev.type === 'slam') slams++;
        if (ev.type === 'beached') beaches++;
      }

      oracle.setEnv(s.sw, s.ch, oracleDockRects, oraclePilings);
      oracle.setControls(toOracleControls(s));
      const o: OracleSnapshot = oracle.step(DT, t);

      maxDiff.x = Math.max(maxDiff.x, Math.abs(portState.x - o.x));
      maxDiff.z = Math.max(maxDiff.z, Math.abs(portState.z - o.z));
      maxDiff.h = Math.max(maxDiff.h, Math.abs(portState.h - o.h));
      maxDiff.speed = Math.max(maxDiff.speed, Math.abs(portState.speed - o.speed));
      maxDiff.y = Math.max(maxDiff.y, Math.abs(portState.y - o.y));
      maxDiff.pitch = Math.max(maxDiff.pitch, Math.abs(portState.pitch - o.pitch));
      maxDiff.roll = Math.max(maxDiff.roll, Math.abs(portState.roll - o.roll));

      // Fail fast with full context at the exact step where things first diverge, rather than
      // only a final aggregate — much faster to debug. Explicit tolerances per
      // docs/ARCHITECTURE.md acceptance criterion A: 1e-9 on x/z/heading/speed, 1e-6 on
      // y/pitch/roll.
      const ctx = `at step ${i} (t=${t.toFixed(3)})`;
      expect(Math.abs(portState.x - o.x), `x ${ctx}`).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(portState.z - o.z), `z ${ctx}`).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(portState.h - o.h), `heading ${ctx}`).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(portState.speed - o.speed), `speed ${ctx}`).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(portState.y - o.y), `y ${ctx}`).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(portState.pitch - o.pitch), `pitch ${ctx}`).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(portState.roll - o.roll), `roll ${ctx}`).toBeLessThanOrEqual(1e-6);
    }

    console.log('boat-trajectory max |diff| over', SCRIPT.length, 'steps:', maxDiff,
      '| events — dock:', dockHits, 'piling:', pilingHits, 'slam:', slams, 'beached:', beaches);

    // Sanity: the collision/slam code paths actually got exercised at least once (otherwise
    // this test would silently stop covering dockCollide/piling-collide/slam).
    expect(dockHits + pilingHits).toBeGreaterThan(0);
  });
});
