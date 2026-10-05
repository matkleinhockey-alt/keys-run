/**
 * The visible fish on the end of the spear line — this task's "aftermath" brief: sim/spear.ts's
 * `SpearFightState` already tracks a speared fish's x/z and tension/stamina (it's a real fight),
 * but nothing ever rendered it, so a speared fish just teleported from "swimming in its school"
 * to "a landed catch on the trophy card" with nothing visible in between, and an escaped
 * (`tornFree`) fish simply vanished. Styled after game/fishing/visuals.ts's `showHooked`/
 * `updateHooked` (same idea: a real per-species mesh, following the sim's fight position, with a
 * thrash wobble scaled by how hard it's fighting) — the spear fight has no jumping/sounding
 * (sim/spear.ts's header), so there's no airborne hop here, just a tighter, closer-range thrash,
 * plus a swim-off animation on `tornFree` that rod fishing's hooked-fish visual doesn't need (a
 * hooked fish that gets away is handled by game/fishing's own release path, not this module's).
 *
 * `index.ts` owns the lifecycle wiring (spawn on a held hit, feed it the fight state every tick,
 * `flee` on `tornFree`, `vanish` on `landed`/reset) — this module only knows how to look right
 * doing each of those things.
 */
import * as THREE from 'three';
import { SPECIES } from '@keysrun/shared/content/species';
import { scaledLenM } from '@keysrun/shared/sim/fight';
import { makeFishMesh } from '../../game/fishing/fish-mesh.js';
import { clamp, lerp } from '../../core/math.js';

export interface SperedFishVisual {
  /** A fresh hit just started a fight — builds the real per-species mesh at the impact point. */
  spawnAt(key: string, weight: number, x: number, y: number, z: number): void;
  /** Call every fight tick while held (index.ts's `update()`, right after `stepSpearFight`) —
   * stores where the fish actually is; `tick` below is what turns that into a mesh transform. */
  setTarget(x: number, y: number, z: number, tension: number, stam: number): void;
  /** The shaft tore free (sim/spear.ts's `tornFree` outcome) — the fish swims away from
   * `awayFromX/Z` (the diver) rather than simply disappearing. One-shot; call once per escape. */
  flee(awayFromX: number, awayFromZ: number): void;
  /** Immediate cleanup for the two cases that don't want a lingering fish: landed (the trophy
   * card takes over the "what did I catch" visualization) and a hard reset (diver climbs out
   * mid-fight). Safe to call when nothing is active. */
  vanish(): void;
  /** Per-frame animation — advances the held thrash wobble and the flee swim-off; a no-op when
   * idle. Safe to call unconditionally every `update()`. */
  tick(dt: number, t: number): void;
  dispose(): void;
}

function disposeFishGroup(mesh: THREE.Group): void {
  mesh.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    // NOT the material — fish-mesh.ts's `matFor` caches materials per species colour at module
    // scope specifically so many live fish of the same species can share one; disposing it here
    // would pull the rug out from under anything else currently rendering that species (a school
    // member, the catch card). Only this mesh's own (always-fresh, see that file's header)
    // geometry is actually owned by this instance.
  });
}

const FLEE_DUR = 2.4; // s — long enough to read as "swam off", short enough not to loiter
const FLEE_SPEED = 2.4; // m/s, escape swim speed

type Mode = 'idle' | 'held' | 'fleeing';

export function createSperedFishVisual(scene: THREE.Scene): SperedFishVisual {
  let mesh: THREE.Group | null = null;
  let mode: Mode = 'idle';

  // 'held' target (set every fight tick) — the mesh eases toward this rather than snapping, so a
  // sim tick's discrete x/z doesn't read as a jitter.
  let tx = 0, ty = 0, tz = 0, tension = 0, stam = 1;
  let headingY = 0;

  let fleeT = 0, fleeDirX = 0, fleeDirZ = 1;

  function disposeMesh(): void {
    if (!mesh) return;
    scene.remove(mesh);
    disposeFishGroup(mesh);
    mesh = null;
  }

  function spawnAt(key: string, weight: number, x: number, y: number, z: number): void {
    disposeMesh();
    const S = SPECIES[key];
    const lenM = scaledLenM(key, weight);
    mesh = makeFishMesh(S?.color ?? '#9aa', lenM);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    mode = 'held';
    tx = x; ty = y; tz = z; tension = 0.5; stam = 1;
    headingY = 0;
  }

  function setTarget(x: number, y: number, z: number, nextTension: number, nextStam: number): void {
    if (mode !== 'held') return;
    tx = x; ty = y; tz = z; tension = nextTension; stam = nextStam;
  }

  function flee(awayFromX: number, awayFromZ: number): void {
    if (!mesh || mode !== 'held') return;
    const dx = tx - awayFromX, dz = tz - awayFromZ;
    const len = Math.hypot(dx, dz);
    if (len > 0.05) { fleeDirX = dx / len; fleeDirZ = dz / len; }
    // Diver basically on top of it (degenerate len) — keep whatever heading it already had rather
    // than picking a direction out of thin air.
    mode = 'fleeing';
    fleeT = 0;
  }

  function vanish(): void {
    disposeMesh();
    mode = 'idle';
  }

  function tick(dt: number, t: number): void {
    if (!mesh || mode === 'idle') return;

    if (mode === 'held') {
      // Ease toward the fight's actual x/z/y rather than snapping straight to it — same spirit as
      // game/fishing/visuals.ts's `updateHooked` smoothing its heading rather than reading it raw
      // every frame.
      mesh.position.x = lerp(mesh.position.x, tx, Math.min(1, dt * 9));
      mesh.position.y = lerp(mesh.position.y, ty, Math.min(1, dt * 6));
      mesh.position.z = lerp(mesh.position.z, tz, Math.min(1, dt * 9));

      const dx = tx - mesh.position.x, dz = tz - mesh.position.z;
      if (dx * dx + dz * dz > 1e-5) headingY = Math.atan2(-dx, -dz);

      // Struggle: amplitude/frequency both climb with tension and with exhaustion (low stamina —
      // a tiring fish thrashes harder right before it gives up, not less). Clamped so a torn-free
      // moment (tension can spike past 1) doesn't fling the mesh into a blur.
      const fight = clamp(tension, 0, 1.2);
      const exhaustion = 1 - clamp(stam, 0, 1);
      const amp = 0.1 + fight * 0.3 + exhaustion * 0.2;
      const freq = 5 + fight * 9 + exhaustion * 4;
      mesh.rotation.set(
        Math.sin(t * freq * 0.7) * amp * 0.5,
        headingY + Math.sin(t * freq) * amp,
        Math.sin(t * freq * 1.4 + 0.6) * amp * 0.6,
        'YXZ',
      );
      const pulse = 1 + Math.sin(t * freq * 2) * 0.04 * (fight + exhaustion);
      mesh.scale.setScalar(pulse);
      return;
    }

    // fleeing — a straight-line dart away from the diver with a swim wiggle, slowly sinking out
    // of sight (reads as "gone back into the reef") rather than fading, which this mesh's material
    // (fish-mesh.ts's cached, opaque-by-default MeshStandardMaterial) isn't set up to do cheaply.
    fleeT += dt;
    mesh.position.x += fleeDirX * FLEE_SPEED * dt;
    mesh.position.z += fleeDirZ * FLEE_SPEED * dt;
    mesh.position.y -= 0.25 * dt;
    mesh.rotation.set(
      0.12,
      Math.atan2(-fleeDirX, -fleeDirZ) + Math.sin(t * 13) * 0.1,
      Math.sin(t * 13 + 0.5) * 0.14,
      'YXZ',
    );
    mesh.scale.setScalar(1);
    if (fleeT > FLEE_DUR) vanish();
  }

  function dispose(): void { disposeMesh(); }

  return { spawnAt, setTarget, flee, vanish, tick, dispose };
}
