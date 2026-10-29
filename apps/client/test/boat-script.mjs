/**
 * The scripted run the boat baseline is built from, shared by the generator and the test so the
 * two can never drift.
 *
 * ~600 steps at a fixed 1/30 s: accelerate, trim, turn, chop, throttle off, reverse, hard turn,
 * trim-mode, idle — with a dock and a piling dropped on the boat's own path so the collision
 * code is genuinely exercised rather than hopefully nearby.
 */
import { createBoatState, stepBoat } from '@keysrun/shared/sim/boat';
import { chainZ } from '@keysrun/shared/world/chain';
import { WB } from '@keysrun/shared/world/depth';

export const DT = 1 / 30;
export const HULL = { len: 9.3, beam: 3.23, top: 58, accel: 0.5, turn: 0.9, draft: 0.72 };
export const SPAWN_X = -1150;
export const SPAWN_Z = chainZ(SPAWN_X) + 305;
export const SPAWN_H = Math.PI / 2;

const CALM = { sw: 0.9, ch: 1 };
const ROUGH = { sw: 2.6, ch: 1.1 };
const base = { fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false, gear: 'D', trimMode: false, ...CALM };

export function buildScript() {
  const steps = [];
  const push = (n, over) => { for (let i = 0; i < n; i++) steps.push({ ...base, ...over }); };
  push(90, { fwd: true });                                   // accelerate
  push(15, { fwd: true, trimUp: true });                     // trim up at speed
  push(90, { fwd: true, left: true });                       // turn under power
  push(90, { fwd: true, ...ROUGH });                         // chop
  push(60, {});                                              // throttle off, coast
  push(40, { fwd: true, gear: 'R' });                        // reverse thrust
  push(80, { right: true, gear: 'D' });                      // hard turn, coasting
  push(30, { fwd: true, trimDn: true, trimMode: true });     // trim mode, trimming down
  push(105, {});                                             // idle, settle
  return steps;
}

export const SCRIPT = buildScript();

const input = (s) => ({ fwd: s.fwd, back: s.back, left: s.left, right: s.right, trimUp: s.trimUp, trimDn: s.trimDn });

/**
 * The env. Note what is NOT here: the `seaEffects: 0` the legacy oracle needed. This runs the
 * physics as shipped — chop under the hull, added resistance in waves, the bow pushed around —
 * which the old test could not, because every one of those was a divergence from legacy and had
 * to be switched off to compare against it.
 */
const env = (sw, ch, dockRects, pilings, t) => ({
  t, hull: HULL, sw, ch, worldBounds: WB, pilings, dockRects,
  canDrive: true, fightActive: false, lineOut: false, luigiOn: false,
});

/** Walk the script, returning every step's state and a tally of the events raised. */
export function run(dockRects, pilings) {
  let st = createBoatState(SPAWN_X, SPAWN_Z, SPAWN_H);
  let t = 0;
  const steps = [];
  const events = { bumpedDock: 0, bumpedPiling: 0, slam: 0, beached: 0, propVentilation: 0 };
  for (const s of SCRIPT) {
    t += DT;
    st = { ...st, gear: s.gear, trimMode: s.trimMode };
    st = stepBoat(st, input(s), env(s.sw, s.ch, dockRects, pilings, t), DT);
    for (const ev of st.events) if (ev.type in events) events[ev.type]++;
    steps.push({ x: st.x, z: st.z, h: st.h, speed: st.speed, y: st.y, pitch: st.pitch, roll: st.roll });
  }
  return { steps, events };
}

/**
 * A dock and a piling on the boat's ACTUAL path, found in two stages because placing the dock
 * moves every later position: stage one picks the dock off the unobstructed run (valid, it is
 * met first), stage two picks the piling off the run that already has that dock in it.
 */
export function waypoints() {
  const a = run([], []).steps[60];
  const dock = { x0: a.x - 4, x1: a.x + 4, z0: a.z - 4, z1: a.z + 4 };
  const b = run([dock], []).steps[400];
  return { dock, piling: { x: b.x, z: b.z } };
}

export function buildBaseline() {
  const { dock, piling } = waypoints();
  const { steps, events } = run([dock], [piling]);
  return { dock, piling, steps, events };
}
