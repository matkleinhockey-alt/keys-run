/**
 * The AI boats you can see: lined up abreast in Boot Key Harbor for the intro, then heading out
 * along the channel (sim/tournament.ts `harbourExitRoute`) when lines go in, until they're out of
 * the harbour and away. After that they exist only on the leaderboard — their catches come from
 * the seed (`npcPlan`), not from fishing anywhere you could watch.
 *
 * Same hulls and names as the race field, built the same cheap way (game/race/opponents.ts).
 */
import * as THREE from 'three';
import { BOATS } from '@keysrun/shared/content/boats';
import { seaHAt, seaSlopeAt } from '@keysrun/shared/sim/depth-grid';
import { HARBOUR, TOURNEY_NPCS, harbourExitRoute } from '@keysrun/shared/sim/tournament';
import { createPath } from '../../entities/life/path.js';
import { makeBoat, type BoatBuildDeps, type BoatModel } from '../../entities/boat/model.js';
import { lerp } from '../../core/math.js';
import type { ParticleSystem } from '../../world/particles.js';

export interface FleetBoat {
  model: BoatModel;
  x: number; z: number; heading: number;
  /** Arc length along the exit route. */
  s: number;
  speed: number;
}

// Spacing abreast at the line-up, metres, and how long after the gun each boat goes — they leave
// one after another, the way a field clears a harbour, not in a wall.
const ABREAST_M = 14;
const STAGGER_S = 1.4;
// Slow through the harbour (no-wake), then up on plane once clear of the moorings.
const HARBOUR_KN_MS = 5;
const RUN_MS = 24;
const HARBOUR_LEG_M = 260;
/** After this long under way the fleet is out of sight up Hawk Channel; stop drawing it. */
const GONE_AFTER_S = 75;

function buildDeps(): BoatBuildDeps {
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const placeholder = new THREE.CanvasTexture(c);
  return { lightMats: [], todK: 0.3, mfdTex: placeholder, gpsTex: placeholder, sonTex: placeholder };
}

export function createTourneyFleet() {
  const group = new THREE.Group();
  group.name = 'tourneyFleet';
  group.visible = false;

  const route = harbourExitRoute();
  // createPath closes the loop; boats stop at the open end instead of turning back for home.
  const path = createPath(route);
  let openLen = 0;
  for (let i = 1; i < route.length; i++) openLen += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);

  const deps = buildDeps();
  const boats: FleetBoat[] = TOURNEY_NPCS.map((n) => {
    const spec = BOATS.find((b) => b.id === n.hull) ?? BOATS[BOATS.length - 1];
    const model = makeBoat(spec, deps);
    group.add(model.group);
    return { model, x: HARBOUR.x, z: HARBOUR.z, heading: 0, s: 0, speed: 0 };
  });

  function place(b: FleetBoat, x: number, z: number, tx: number, tz: number, t: number): void {
    b.x = x; b.z = z;
    b.heading = Math.atan2(-tx, -tz);
    const [sx, sz] = seaSlopeAt(x, z, t);
    const g = b.model.group;
    g.position.set(x, seaHAt(x, z, t), z);
    g.rotation.set(0, 0, 0);
    g.rotateY(b.heading);
    g.rotateX(-sz * 0.6 - Math.min(0.2, b.speed * 0.004));
    g.rotateZ(sx * 0.6);
  }

  /** Abreast across the start of the route, bows pointing the way out. */
  function lineUp(t: number): void {
    const p = path.at(0);
    const nx = -p.tz, nz = p.tx;
    boats.forEach((b, i) => {
      const off = (i - (boats.length - 1) / 2) * ABREAST_M;
      b.s = 0; b.speed = 0;
      place(b, p.x + nx * off, p.z + nz * off, p.tx, p.tz, t);
    });
  }

  /**
   * `sinceGo` = seconds since lines went in (negative during the countdown): line up before it,
   * head out after it, gone a while later.
   */
  function update(dt: number, t: number, sinceGo: number | null, particles: ParticleSystem | null): void {
    if (sinceGo === null || sinceGo > GONE_AFTER_S) { group.visible = false; return; }
    group.visible = true;
    if (sinceGo < 0) { lineUp(t); return; }
    boats.forEach((b, i) => {
      if (sinceGo < i * STAGGER_S) { b.speed = 0; return; }
      const want = b.s < HARBOUR_LEG_M ? HARBOUR_KN_MS : RUN_MS;
      b.speed = lerp(b.speed, want, Math.min(1, dt * (want > b.speed ? 0.6 : 1.2)));
      b.s = Math.min(openLen - 1, b.s + b.speed * dt);
      const p = path.at(b.s);
      // Ease from the abreast slot onto the route over the first stretch, so they file out
      // rather than snapping into one line.
      const k = Math.max(0, 1 - b.s / 80);
      const off = (i - (boats.length - 1) / 2) * ABREAST_M * k;
      place(b, p.x - p.tz * off, p.z + p.tx * off, p.tx, p.tz, t);
      if (particles && b.speed > 6 && Math.random() < dt * 14) {
        particles.splash(b.x + Math.sin(b.heading) * 5.5, b.z + Math.cos(b.heading) * 5.5, 1.1 + b.speed * 0.03, 0.35);
      }
    });
  }

  function dispose(): void {
    for (const b of boats) group.remove(b.model.group);
  }

  return { group, boats, update, dispose };
}

export type TourneyFleet = ReturnType<typeof createTourneyFleet>;
