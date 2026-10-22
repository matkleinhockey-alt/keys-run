/**
 * Dead birds floating on the water: the three.js half of `@keysrun/shared/sim/chum`.
 *
 * Shoot a gull off the boat (entities/handgun) and it tumbles down (seabirds.ts's
 * `shootDownBird`); the frame it reaches the water this system takes over. It owns one bobbing
 * mesh per carcass and the plain `Carcass[]` the fish simulation reads
 * (entities/fish/school.ts -> `chumPull`). All the rules — lifetime, reach, which species care —
 * live in sim/chum.ts, which is pure; everything here is presentation and ownership.
 *
 * The mesh is the bird's OWN geometry, from `makeSeabird`, posed limp and rolled part way over.
 * A bespoke "dead bird" model was considered and is not worth it: the point of the moment is that
 * the thing floating there is unmistakably the gull you just shot, and a bird's geometry is cheap
 * (two wing panels and a body) and already cached per kind.
 *
 * Deliberately NOT done: gore. The game's register is comic — a struck fish "bobs up stunned,
 * wakes offended and swims off" (entities/handgun/index.ts) — so a carcass is a limp silhouette
 * on the swell that quietly slips under at the end, nothing more.
 */
import * as THREE from 'three';
import { waveHBase } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import {
  CARCASS_LIFE_S, admitCarcass, carcassPotency, createCarcass, stepCarcasses, type Carcass,
} from '@keysrun/shared/sim/chum';
import { makeSeabird, poseBirdLimp, type Bird, type BirdKind } from './seabirds.js';

/**
 * Seconds a flock is a bird short after one is shot down. Deliberately longer than the carcass
 * lifetime: a replacement gull drifting back in while its own corpse is still floating under it
 * is the one way this can read as a bug rather than as a consequence.
 */
export const BIRD_REPLACE_S = CARCASS_LIFE_S + 30;

/** Seconds at the end of a carcass's life over which it settles under the surface and goes. */
const SINK_S = 6;

interface Live {
  c: Carcass;
  bird: Bird;
  /** Fixed per carcass so several in the water do not bob and swing in lockstep. */
  seed: number;
}

export interface Carcasses {
  /**
   * A bird has just hit the water at `(x, z)`. Returns the carcass, or null if the splash was
   * rejected (today: never — the cap is handled by dropping the oldest, see `admitCarcass`).
   */
  spawn(kind: BirdKind, x: number, z: number): Carcass | null;
  update(dt: number, t: number): void;
  /** The plain state the fish simulation reads. Live array identity is not stable; do not retain. */
  list(): readonly Carcass[];
  clear(): void;
  /** Verification only: one row per carcass, with the potency the rules currently give it. */
  debug(): Array<{ id: string; x: number; z: number; age: number; potency: number }>;
  /**
   * VERIFICATION ONLY: age every carcass by `seconds` in one go. A carcass lives two minutes of
   * simulated time, which in the ~3 fps software-GL sandbox is a quarter of an hour of wall clock
   * per carcass — longer than any test's patience. This jumps the clock through exactly the same
   * `stepCarcasses` path a real frame uses, so expiry is still tested rather than faked.
   */
  debugAge(seconds: number): void;
  dispose(): void;
}

export function createCarcasses(scene: THREE.Scene): Carcasses {
  const live: Live[] = [];
  let seq = 0;

  function remove(l: Live): void {
    scene.remove(l.bird.g);
    live.splice(live.indexOf(l), 1);
    // The bird geometries are cached and shared per kind inside seabirds.ts (`BIRD_GEO`) and the
    // material is a single module-level one, so neither is ours to dispose — doing so would take
    // out every live gull in the world with it.
  }

  return {
    spawn(kind, x, z) {
      const c = createCarcass(`carcass-${seq++}`, x, z);
      // Ask the rules who stays: `admitCarcass` caps the water and drops the oldest, so reconcile
      // the meshes against the list it returns rather than second-guessing the cap here.
      const kept = admitCarcass(live.map((l) => l.c), c);
      const keptIds = new Set(kept.map((k) => k.id));
      for (const l of [...live]) if (!keptIds.has(l.c.id)) remove(l);
      if (!keptIds.has(c.id)) return null;
      const bird = makeSeabird(kind, kind === 'pelican' ? 1 : 1.05);
      scene.add(bird.g);
      live.push({ c, bird, seed: Math.random() * 6.28 });
      return c;
    },

    update(dt, t) {
      // Age through the pure rules, then reconcile: anything the rules dropped is spent and its
      // mesh goes with it. Keeping the authority in one place is what stops the visible carcass
      // and the one the fish are circling from ever disagreeing about whether it still exists.
      const next = stepCarcasses(live.map((l) => l.c), undefined, dt);
      const byId = new Map(next.map((c) => [c.id, c]));
      for (const l of [...live]) {
        const c = byId.get(l.c.id);
        if (!c) { remove(l); continue; }
        l.c = c;
        const surf = waveHBase(c.x, c.z, t, ampAt(c.x, c.z));
        // It rides the swell nearly flush, rolled most of the way onto its side with one wing
        // half out of the water — the silhouette that reads "dead" at any distance.
        const sink = Math.max(0, (c.age - (c.life - SINK_S)) / SINK_S);
        const y = surf - 0.04 - sink * 0.9 + Math.sin(t * 1.6 + l.seed) * 0.035;
        l.bird.g.position.set(c.x, y, c.z);
        l.bird.g.rotation.set(
          Math.sin(t * 1.1 + l.seed) * 0.12,
          l.seed * 3.1 + Math.sin(t * 0.21 + l.seed) * 0.5, // turns slowly on the surface
          2.25 + Math.sin(t * 1.4 + l.seed * 2) * 0.16,
          'YXZ',
        );
        // The same limp pose the fall used (seabirds.ts), re-applied every frame so nothing else
        // that walks the scene graph can leave a wing up.
        poseBirdLimp(l.bird);
        l.bird.g.visible = sink < 1;
      }
    },

    list() { return live.map((l) => l.c); },
    debugAge(seconds) { for (const l of live) l.c = { ...l.c, age: l.c.age + seconds }; },
    clear() { for (const l of [...live]) remove(l); },
    debug() {
      return live.map((l) => ({
        id: l.c.id, x: +l.c.x.toFixed(1), z: +l.c.z.toFixed(1),
        age: +l.c.age.toFixed(1), potency: +carcassPotency(l.c).toFixed(3),
      }));
    },
    dispose() { for (const l of [...live]) remove(l); },
  };
}
