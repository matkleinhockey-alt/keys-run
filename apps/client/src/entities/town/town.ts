/**
 * Boot Key Harbor City, as the rest of the game sees it: one object that costs nothing until you
 * are near it and tiers its own detail by distance when you are.
 *
 * ## Tiers (distance is from the camera to the nearest edge of the town pad)
 *
 *   beyond BUILD_RANGE   not built. No geometry, no textures, nothing in the scene. This is the
 *                        state of the world while you fish the Gulf Stream; `stats().built` is false
 *                        and the profiler's draw-call count is the same as without the town.
 *   BUILD_RANGE..        building: one stage per frame (build.ts is a generator), so the cost is
 *                        spread over a handful of frames you spend approaching, not paid in one.
 *   FAR_RANGE..NEAR_RANGE  `far`: the buildings as bare coloured boxes and a glow quad per sign —
 *                        two draw calls. Enough to steer by from the harbour mouth, and to see
 *                        the town glow at sunset from half a kilometre out.
 *   inside NEAR_RANGE    `near`: facades, signs, props, cars, lights. People animate inside
 *                        GAIT_RANGE; interiors are built inside INTERIOR_BUILD_RANGE and drawn
 *                        inside INTERIOR_RANGE; the PointLight pool only exists inside LIGHT_HOT_RANGE
 *                        and only when it is dusk or you are in a room.
 *   beyond FAR_RANGE     hidden again (resident in memory, but `visible = false`: free to render).
 *
 * This is the same idea as the fish LOD (entities/fish/pool.ts: tier by apparent size) and the
 * party boats (entities/life/party-boats.ts: cull hulls and, crucially, lights by distance), with
 * the extra step the town needs that neither does: it is built lazily, because its textures are
 * not cheap and most sessions spend most of their time elsewhere.
 *
 * Hysteresis (`HYST` metres) on every switch, so hovering at a boundary cannot flip a tier each
 * frame — for the lights that would be a world-wide shader recompile per flip.
 */
import * as THREE from 'three';
import {
  TOWN_FRAME, PAD, PAD_Y, LOTS, NPCS, INTERACTS, WALL_T, toLocal, toWorld, type Interact,
} from '@keysrun/shared/world/town';
import type { LightMatEntry } from '../../core/time-of-day.js';
import { buildTown, type LightSource, type TownBuild } from './build.js';
import { createPeople, type PeopleSystem } from './people.js';
import { buildInterior, INTERIOR_BUILD_RANGE, INTERIOR_RANGE, type Interior } from './interiors.js';
import { createLightPool, type LightPool } from './lights.js';

export const BUILD_RANGE = 900;
export const FAR_RANGE = 1500;
export const NEAR_RANGE = 280;
export const LIGHT_HOT_RANGE = 110;
const HYST = 25;

export interface TownDeps {
  scene: THREE.Scene;
  lightMats: LightMatEntry[];
  getTodK(): number;
  /** Called once the town's meshes exist and are in the scene — world.ts runs the cascaded-shadow sweep here. */
  onBuilt(root: THREE.Group): void;
}

export interface Town {
  readonly root: THREE.Group;
  /** Per frame. `cam` is the render camera's position. */
  update(dt: number, t: number, cam: THREE.Vector3): void;
  /** Build every remaining stage right now (land mode needs the town this frame). */
  ensureBuilt(): void;
  built(): boolean;
  /** The reachable interaction point nearest (x,z), or null. */
  nearestInteract(x: number, z: number): { interact: Interact; dist: number } | null;
  /** The walk-in building containing (x,z), or null. */
  insideLot(x: number, z: number): string | null;
  /** Interactions in world coordinates, for debug and tests. */
  interactWorld(id: string): [number, number] | null;
  stats(): TownStats;
  /** VERIFICATION-ONLY: force the whole town out of the render so a harness can measure its cost as a delta. */
  debugHide(hidden: boolean): void;
  dispose(): void;
}

export interface TownStats {
  built: boolean; building: boolean; stagesDone: number; rootVisible: boolean;
  nearVisible: boolean; farVisible: boolean; peopleVisible: boolean;
  interiorsBuilt: string[]; interiorsVisible: string[];
  lightsActive: boolean; lights: ReturnType<LightPool['debug']>;
  distance: number;
  triangles: number;
}

export function createTown(deps: TownDeps): Town {
  const root = new THREE.Group();
  root.name = 'bootKeyHarborCity';
  root.position.set(TOWN_FRAME.ox, 0, TOWN_FRAME.oz);
  root.rotation.y = TOWN_FRAME.dir > 0 ? 0 : Math.PI;
  root.visible = false;

  let gen: Generator<void, TownBuild> | null = null;
  let build: TownBuild | null = null;
  let stages = 0;
  let distance = Infinity;
  let people: PeopleSystem | null = null;
  let pool: LightPool | null = null;
  const interiors = new Map<string, Interior>();
  const interiorHolder = new THREE.Group(); interiorHolder.name = 'interiors';
  const sources: LightSource[] = [];
  const camLocal = new THREE.Vector3();
  let inside: string | null = null;
  let forceHidden = false;

  const world: Array<{ i: Interact; x: number; z: number }> = INTERACTS.map((i) => { const [x, z] = toWorld(TOWN_FRAME, i.u, i.v); return { i, x, z }; });
  const lotRects = LOTS.filter((l) => l.enterable).map((l) => ({ id: l.id, l }));

  function finish(b: TownBuild): void {
    build = b;
    b.near.visible = false; b.far.visible = false;
    root.add(b.far, b.near);
    b.near.add(interiorHolder);
    sources.push(...b.lights);
    deps.scene.add(root);
    root.visible = true;
    deps.onBuilt(root);
  }

  function pump(steps: number): void {
    if (build) return;
    if (!gen) gen = buildTown(deps.lightMats, deps.getTodK);
    for (let i = 0; i < steps; i++) {
      const r = gen.next();
      stages++;
      if (r.done) { finish(r.value); return; }
    }
  }

  function nearEdgeDistance(cam: THREE.Vector3): number {
    const [u, v] = toLocal(TOWN_FRAME, cam.x, cam.z);
    const du = Math.max(PAD.u0 - u, 0, u - PAD.u1), dv = Math.max(PAD.v0 - v, 0, v - PAD.v1);
    return Math.hypot(du, dv);
  }

  return {
    root,

    built: () => !!build,

    ensureBuilt(): void {
      while (!build) pump(1);
      ensurePeople();
      for (const l of lotRects) ensureInterior(l.id);
    },

    update(dt, t, cam): void {
      distance = nearEdgeDistance(cam);
      if (!build) {
        if (distance < BUILD_RANGE) pump(distance < 400 ? 2 : 1);
        return;
      }
      const b = build;
      if (forceHidden) { root.visible = false; pool?.update(camLocal, sources, 0, false, null); return; }
      // tier switches, with hysteresis
      const nearNow = b.near.visible ? distance < NEAR_RANGE + HYST : distance < NEAR_RANGE - HYST;
      const showAny = root.visible ? distance < FAR_RANGE + HYST : distance < FAR_RANGE - HYST;
      root.visible = showAny;
      b.near.visible = showAny && nearNow;
      b.far.visible = showAny && !nearNow;
      if (!showAny) { pool?.update(camLocal, sources, 0, false, null); return; }

      // The pool exists only near the town; lights hang under `near`, which is hidden beyond NEAR_RANGE.
      root.updateWorldMatrix(true, false);
      camLocal.copy(cam); root.worldToLocal(camLocal);
      const todK = deps.getTodK();
      const [cu, cv] = toLocal(TOWN_FRAME, cam.x, cam.z);
      inside = null;
      for (const l of lotRects) {
        if (cu > l.l.u0 + WALL_T && cu < l.l.u1 - WALL_T && cv > l.l.v0 + WALL_T && cv < l.l.v1 - WALL_T) inside = l.id;
      }
      if (b.near.visible) {
        if (distance < NEAR_RANGE) ensurePeople();
        people?.update(t, dt, cam, (x, z) => toLocal(TOWN_FRAME, x, z));
        for (const l of lotRects) {
          const [lx, lz] = toWorld(TOWN_FRAME, (l.l.u0 + l.l.u1) / 2, (l.l.v0 + l.l.v1) / 2);
          const d = Math.hypot(cam.x - lx, cam.z - lz);
          if (d < INTERIOR_BUILD_RANGE) ensureInterior(l.id);
          const it = interiors.get(l.id);
          if (it) {
            it.group.visible = d < INTERIOR_RANGE;
            if (it.group.visible) {
              for (const p of it.people) p.human.update(t, 0);
            }
          }
        }
        if (!pool) pool = createLightPool(b.near);
        pool.update(camLocal, sources, todK, distance < LIGHT_HOT_RANGE, inside);
      } else if (pool?.active) {
        pool.update(camLocal, sources, 0, false, null);
      }
    },

    nearestInteract(x, z): { interact: Interact; dist: number } | null {
      let best: { interact: Interact; dist: number } | null = null;
      for (const w of world) {
        const d = Math.hypot(w.x - x, w.z - z);
        if (d <= w.i.r && (!best || d < best.dist)) best = { interact: w.i, dist: d };
      }
      return best;
    },

    insideLot(x, z): string | null {
      const [u, v] = toLocal(TOWN_FRAME, x, z);
      for (const l of lotRects) if (u > l.l.u0 && u < l.l.u1 && v > l.l.v0 && v < l.l.v1) return l.id;
      return null;
    },

    interactWorld(id): [number, number] | null {
      const w = world.find((q) => q.i.id === id);
      return w ? [w.x, w.z] : null;
    },

    stats(): TownStats {
      return {
        built: !!build, building: !!gen && !build, stagesDone: stages, rootVisible: root.visible,
        nearVisible: !!build?.near.visible, farVisible: !!build?.far.visible, peopleVisible: !!people?.group.visible,
        interiorsBuilt: [...interiors.keys()], interiorsVisible: [...interiors].filter(([, i]) => i.group.visible).map(([k]) => k),
        lightsActive: !!pool?.active, lights: pool ? pool.debug() : [],
        distance: +distance.toFixed(1), triangles: build?.triangleCount ?? 0,
      };
    },

    debugHide(hidden): void { forceHidden = hidden; },

    dispose(): void {
      pool?.dispose(); people?.dispose();
      interiors.forEach((i) => i.dispose());
      build?.dispose();
      deps.scene.remove(root);
    },
  };

  function ensurePeople(): void {
    if (people || !build) return;
    people = createPeople(NPCS, PAD_Y);
    people.ensure();
    build.near.add(people.group);
  }

  function ensureInterior(id: string): void {
    if (interiors.has(id) || !build) return;
    const lot = LOTS.find((l) => l.id === id)!;
    const it = buildInterior(lot, build.kit);
    interiors.set(id, it);
    interiorHolder.add(it.group);
    sources.push(...it.lights);
    deps.onBuilt(it.group);
  }
}
