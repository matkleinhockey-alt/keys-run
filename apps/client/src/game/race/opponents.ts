/**
 * The AI field: three go-fast boats that actually run the buoy course against you.
 *
 * They are **path followers, not boat-sim instances.** `stepBoat` is a 15-point buoyancy
 * integrator (docs/ARCHITECTURE.md: a stiff coupled oscillator) and running three more of them
 * for opponents the player mostly sees from behind would cost more than the entire fish system
 * for no visible gain. Instead each opponent advances along the course path by arc length and
 * takes its heading from the path tangent, then bobs on the real wave sum — the same compromise
 * `entities/life/racers.ts` already makes for the ambient go-fasts, and from the cockpit the
 * difference is invisible.
 *
 * What they do model, because it is visible:
 *  - **They slow for corners.** Speed scales down with the path's local curvature, so they run
 *    wide-open down Hawk Channel and back off into the reef turns. A field that holds one speed
 *    all lap reads as a conveyor belt.
 *  - **They take slightly different lines.** A per-boat lateral offset from the centreline, eased
 *    rather than snapped, so they aren't a single-file train through every mark.
 *  - **They are beatable but not free.** Per-boat pace multipliers straddle the player's own hull
 *    speed, so the result depends on how well you drive rather than on which boat you picked.
 *
 * Deliberately no rubber-banding. It is tempting for a 2-lap race, but the player can see the
 * whole course from most of it, and a boat that visibly gains on a straight while you are at full
 * throttle reads as cheating — far worse than losing honestly.
 */
import * as THREE from 'three';
import { BOATS } from '@keysrun/shared/content/boats';
import { waveHBase, waveSlope } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { coursePoints } from '@keysrun/shared/sim/race';
import { pointRoute, type Path } from '../../entities/life/path.js';
import { makeBoat, type BoatBuildDeps, type BoatModel } from '../../entities/boat/model.js';
import { lerp } from '../../core/math.js';
import type { ParticleSystem } from '../../world/particles.js';

/** Boat ids used for the field, fastest-looking first. */
const FIELD: ReadonlyArray<{ boat: string; pace: number; line: number; name: string }> = [
  { boat: 'mti', pace: 1.04, line: 10, name: 'Reel Deal' },
  { boat: 'midnight', pace: 0.97, line: -12, name: 'Sand Bar' },
  { boat: 'freeman', pace: 0.91, line: 22, name: 'Conch Runner' },
];

/** Metres either side of the centreline an opponent will drift to take its own line. */
const LINE_EASE = 0.35;

export interface Opponent {
  id: string;
  name: string;
  model: BoatModel;
  /** Arc length along the course path. */
  s: number;
  speed: number;
  pace: number;
  line: number;
  curLine: number;
  heading: number;
  x: number;
  z: number;
  wakeT: number;
}

export interface RaceField {
  group: THREE.Group;
  opponents: readonly Opponent[];
  /** Places the field on the start line, stopped, facing the first mark. */
  lineUp(): void;
  /** `released` is false during the countdown — they sit on the line and idle. */
  update(dt: number, t: number, released: boolean, particles: ParticleSystem | null): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

function buildDeps(): BoatBuildDeps {
  // Opponents never show an MFD/GPS/sounder screen at race distance, so they get a 2x2
  // placeholder rather than their own render targets — same trick net/remote-boats.ts uses for
  // other players' boats, and for the same reason.
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const placeholder = new THREE.CanvasTexture(c);
  return { lightMats: [], todK: 0.3, mfdTex: placeholder, gpsTex: placeholder, sonTex: placeholder };
}

export function createRaceField(): RaceField {
  const group = new THREE.Group();
  group.name = 'raceField';
  group.visible = false;

  const path: Path = pointRoute(coursePoints());
  const deps = buildDeps();

  const opponents: Opponent[] = FIELD.map((f, i) => {
    const spec = BOATS.find((b) => b.id === f.boat) ?? BOATS[BOATS.length - 1];
    const model = makeBoat(spec, deps);
    group.add(model.group);
    return {
      id: `ai${i}`, name: f.name, model,
      // Staggered slightly back from the line so they don't start inside each other.
      s: path.total - (i + 1) * 9,
      speed: 0, pace: f.pace, line: f.line, curLine: f.line,
      heading: 0, x: 0, z: 0, wakeT: 0,
    };
  });

  /** Local curvature at arc length `s`, 1/m — sampled as the heading change over a short span
   * ahead, which is cheaper and smoother than differentiating the tangent twice. */
  function curvatureAt(s: number): number {
    const span = 55;
    const a = path.at(s), b = path.at(s + span);
    const da = Math.atan2(a.tz, a.tx), db = Math.atan2(b.tz, b.tx);
    let d = db - da;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) / span;
  }

  function placeOne(o: Opponent, t: number): void {
    const p = path.at(o.s);
    // Offset perpendicular to the path for this boat's own line.
    const nx = -p.tz, nz = p.tx;
    const x = p.x + nx * o.curLine;
    const z = p.z + nz * o.curLine;
    o.x = x; o.z = z;

    const amp = ampAt(x, z);
    const surf = waveHBase(x, z, t, amp);
    const [sx, sz] = waveSlope(x, z, t, amp);

    const g = o.model.group;
    g.position.set(x, surf, z);
    // Path tangent gives heading; the wave slope gives pitch/roll so the hull sits in the swell
    // instead of sliding across a flat plane.
    const yaw = Math.atan2(-p.tx, -p.tz);
    o.heading = yaw;
    g.rotation.set(0, 0, 0);
    g.rotateY(yaw);
    g.rotateX(-sz * 0.6 - Math.min(0.25, o.speed * 0.004));
    g.rotateZ(sx * 0.6);
  }

  function lineUp(): void {
    for (let i = 0; i < opponents.length; i++) {
      const o = opponents[i];
      o.s = path.total - (i + 1) * 9;
      o.speed = 0;
      o.curLine = o.line;
      placeOne(o, 0);
    }
  }

  function update(dt: number, t: number, released: boolean, particles: ParticleSystem | null): void {
    if (!group.visible) return;
    for (const o of opponents) {
      // Corner speed: full noise down the straights, backed off through the turns.
      const k = curvatureAt(o.s);
      const cornerK = 1 / (1 + k * 260);
      const want = released ? 30 * o.pace * (0.55 + 0.45 * cornerK) : 0;
      // Asymmetric: a go-fast gets up on plane far quicker than it scrubs off speed.
      o.speed = lerp(o.speed, want, Math.min(1, dt * (want > o.speed ? 0.5 : 0.9)));
      o.s = (o.s + o.speed * dt) % path.total;

      // Ease toward this boat's line, and straighten up through tight corners the way a driver
      // would rather than holding an offset through the apex.
      const targetLine = o.line * (0.35 + 0.65 * cornerK);
      o.curLine = lerp(o.curLine, targetLine, Math.min(1, dt * LINE_EASE));

      placeOne(o, t);

      if (particles && o.speed > 6) {
        o.wakeT -= dt;
        if (o.wakeT <= 0) {
          o.wakeT = 0.06;
          const back = 5.5;
          particles.splash(o.x + Math.sin(o.heading) * back, o.z + Math.cos(o.heading) * back, 1.1 + o.speed * 0.03, 0.35);
        }
      }
    }
  }

  function setVisible(v: boolean): void { group.visible = v; }

  function dispose(): void {
    for (const o of opponents) group.remove(o.model.group);
  }

  return { group, opponents, lineUp, update, setVisible, dispose };
}
