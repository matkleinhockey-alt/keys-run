/**
 * The boat physics does not change by accident.
 *
 * ## What this replaced, and why
 *
 * This used to drive an oracle extracted at test time from `legacy/index.html` alongside
 * `stepBoat` and assert they agreed. That was the right test while the port was in flight, and
 * it earned its keep — it caught a real mistake the day it was removed, when a `seaEffects` gate
 * was applied to legacy's own low-speed yaw term as well as to the new one.
 *
 * It had two problems by the end. It could only compare the parts of the model legacy also had,
 * so every piece of physics added since — the short wind chop under the hull, the speed a seaway
 * costs, the bow being pushed around at speed — had to be switched OFF (`seaEffects: 0`) for the
 * comparison to mean anything. The test therefore verified a configuration the game does not
 * ship. And it pinned the boat to a historical artifact rather than to a decision.
 *
 * So it is a baseline of its own behaviour now, recorded with the physics as shipped. It detects
 * change; it does not claim correctness. When the physics is MEANT to change, regenerate:
 *
 *     node apps/client/test/boat-baseline.mjs
 *
 * and read the diff before committing it. A regenerate with no explanation is the same as
 * deleting the test.
 *
 * ## Why the tolerances are what they are
 *
 * Tight, because the trajectory turns out not to be chaotic over this script: nudging the start
 * by 1e-9 m leaves the run 1e-9 m away six hundred steps later, with no amplification and no
 * collision flipping sides. So the only drift to absorb is last-ulp differences in `Math.sin` and
 * `Math.cos` between architectures — the same thing that had the world goldens failing on CI for
 * months. These sit far above that and far below any real change, which moves the boat metres.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, waypoints, SCRIPT } from './boat-script.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
interface Step { x: number; z: number; h: number; speed: number; y: number; pitch: number; roll: number }
interface Baseline {
  dock: { x0: number; x1: number; z0: number; z1: number };
  piling: { x: number; z: number };
  steps: Step[];
  events: Record<string, number>;
}
const baseline = JSON.parse(fs.readFileSync(path.join(HERE, 'boat-baseline.json'), 'utf8')) as Baseline;

/** Per-field tolerance. See the header for why these are safe to have this tight. */
const TOL: Record<keyof Step, number> = {
  x: 1e-5, z: 1e-5, y: 1e-5,
  h: 1e-7, speed: 1e-6, pitch: 1e-6, roll: 1e-6,
};

describe('boat trajectory', () => {
  it('matches its baseline over a ~600-step scripted run at a fixed 1/30 s timestep', () => {
    const { dock, piling } = waypoints();
    // The obstacles are derived from the boat's own path, so if the physics moved, these move
    // too — and a baseline compared against a different course would be meaningless.
    expect(dock, 'the dock waypoint moved, so the trajectory did').toEqual(baseline.dock);
    expect(piling, 'the piling waypoint moved, so the trajectory did').toEqual(baseline.piling);

    const { steps, events } = run([dock], [piling]);
    expect(steps.length).toBe(baseline.steps.length);
    expect(steps.length).toBe(SCRIPT.length);

    const worst: Record<string, { d: number; at: number }> = {};
    for (let i = 0; i < steps.length; i++) {
      for (const k of Object.keys(TOL) as Array<keyof Step>) {
        const d = Math.abs(steps[i][k] - baseline.steps[i][k]);
        if (!worst[k] || d > worst[k].d) worst[k] = { d, at: i };
        // Fail at the first step that diverges, with the step number: an aggregate alone makes
        // this very slow to debug.
        expect(d, `${k} at step ${i}`).toBeLessThanOrEqual(TOL[k]);
      }
    }
    console.log('boat-trajectory worst |diff|:', Object.fromEntries(
      Object.entries(worst).map(([k, v]) => [k, `${v.d.toExponential(1)} @${v.at}`]),
    ));

    // The events have to match too, or the boat could take the same path while silently no
    // longer noticing it hit anything.
    expect(events).toEqual(baseline.events);
  });

  it('actually exercises the collision paths it claims to', () => {
    // Without this the dock and piling could drift off the course and the test would keep
    // passing while covering nothing but open water.
    expect(baseline.events.bumpedDock + baseline.events.bumpedPiling,
      'the scripted run no longer hits the dock or the piling').toBeGreaterThan(0);
  });
});
