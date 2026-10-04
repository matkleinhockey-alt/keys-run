/**
 * Deck crew — places the loaded, rigged figure (see asset.ts) on whichever boat is current,
 * parented to the boat's own group so it rides the hull's heave/pitch/roll for free (docs/
 * ARCHITECTURE.md: "boat y, pitch, roll ... client only" — anything parented under `model.group`
 * inherits that motion with zero extra code; it would be wrong to position figures in world
 * space), and drives each one's dance/brace/idle animation every frame (see dance.ts).
 *
 * Quality tiers gate how many figures appear (docs/ARCHITECTURE.md "Performance budget" — see
 * this project's report for the measured draw-call delta this adds): Low gets none, Medium gets
 * one, High/Ultra get every slot entities/crew-model/placements.ts defines for that hull (1-3).
 * Low getting zero figures is also what makes "no dancing on Low" true for free — there's simply
 * nothing in the crew group to animate.
 *
 * --- History: this used to be a static, unrigged figure ---
 * Earlier, `asset.ts` loaded `raw/bikini_girl.glb` (no skeleton, one pose, no update() method
 * needed at all) and this module's only job was `template.clone()` + position/rotate/scale. That
 * asset is now swapped for a rigged, animated one (Mixamo's "X Bot" + "Hip Hop Dancing" — see
 * asset.ts's header and docs/ASSET-LICENCES.md for why the figure's *appearance* changed as a
 * result, and what's left open about that). The three changes that migration actually needed,
 * for the next asset swap (e.g. if the user's own bikini_girl mesh gets auto-rigged later) to
 * reuse:
 *   1. asset.ts: load the new glTF, export its `template: THREE.Object3D` + `clip:
 *      THREE.AnimationClip` (whatever `gltf.animations[0]` is).
 *   2. spawnFigure() below: `SkeletonUtils.clone(template)` (NOT `.clone()` — a skinned mesh's
 *      `.clone()` doesn't duplicate its skeleton, so naively cloning N instances would have them
 *      all sharing one skeleton's bone transforms), then one `THREE.AnimationMixer` + clip
 *      action per clone, started at a random point in the clip so several figures on one deck
 *      aren't in lockstep.
 *   3. dance.ts's `updateFigure(dt)` calls `mixer.update(dt)` per figure; this module's own
 *      `update()` below calls that per figure, and game/world.ts's frame() calls this module's
 *      `update()` once a frame (see that file's own crewSystem.update call).
 * Everything about *where* figures stand (placements.ts) and *how many* (quality tiers, this
 * file) is unaffected by either swap — it's a contained asset+driver change, not a rewrite.
 */
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Boat } from '@keysrun/shared/content/boats';
import type { BoatModel } from '../boat/model.js';
import type { QualityTier } from '../../core/quality.js';
import { rand } from '../../core/math.js';
import { loadCrewAsset, TEMPLATE_HEIGHT_M, type CrewAsset } from './asset.js';
import { placementsFor } from './placements.js';
import { createAnimatedFigure, updateFigure, type AnimatedFigure, type CrewMotionInput } from './dance.js';
import { createFallbackBeatSource, type BeatSource } from './beat.js';

// Medium keeps the single most-important slot per boat (placements.ts orders each boat's list
// with that figure first); Low drops crew entirely; High/Ultra show every slot defined.
function slotCountForTier(tier: QualityTier, totalSlots: number): number {
  switch (tier) {
    case 'low': return 0;
    case 'medium': return Math.min(1, totalSlots);
    default: return totalSlots; // high, ultra
  }
}

export interface CrewSystem {
  /** Call once per boat build — both the initial makeBoat() in initWorld and every later
   * placeBoat() swap. Removes any previous boat's figures (they go with the old model.group
   * anyway once it's removed from the scene, but this also handles re-placing on the *same*
   * model if ever needed) and places fresh ones sized to the new hull. */
  attachTo(model: BoatModel, spec: Boat): void;
  /** Call when the quality tier changes (core/quality.ts's applyQuality). Re-runs placement for
   * whichever boat is current at the new tier's figure count — cheap (clone + position a handful
   * of objects), does not touch the boat model itself. */
  setQuality(tier: QualityTier): void;
  /** Call once per rendered frame (not per fixed physics step — this is cosmetic, not
   * simulation) from game/world.ts's frame(), after the boat's own model.group transform for
   * this frame is set. Advances every current figure's AnimationMixer and lean overlay — see
   * dance.ts. Cheap no-op when there are no figures (Low tier, or before the glTF resolves). */
  update(dt: number, simTime: number, motion: CrewMotionInput): void;
}

export function createCrewSystem(
  initialTier: QualityTier,
  /** Called with the freshly-(re)built crew group every time it changes — sync on attachTo/
   * setQuality, and again whenever the async glTF arrives after a boat already asked for crew.
   * world.ts uses this to run the cascaded-shadow setup (`shadows.applyToSubtree`) on just the
   * new group, since this module has no business knowing the shadow system exists. */
  onGroupReady: (group: THREE.Group) => void,
  /** The dance's tempo source — see beat.ts's header for the real one-line swap once
   * apps/client/src/audio/** lands. Defaults to a free-running fallback tempo. */
  beatSource: BeatSource = createFallbackBeatSource(),
): CrewSystem {
  let tier = initialTier;
  let asset: CrewAsset | null = null;
  let current: { model: BoatModel; spec: Boat; group: THREE.Group } | null = null;
  let figures: AnimatedFigure[] = [];

  loadCrewAsset()
    .then((loaded) => {
      asset = loaded;
      rebuild(); // asset may have arrived after a boat already asked for crew — pop in now
    })
    .catch((err: unknown) => {
      // Never block or crash the boat over a cosmetic asset — boats just sail empty-decked.
      console.error('[crew-model] failed to load deck crew asset; boats will have no crew', err);
    });

  function spawnFigure(loaded: CrewAsset, slot: ReturnType<typeof placementsFor>[number]): AnimatedFigure {
    // SkeletonUtils' `clone`, not plain Object3D.clone — see this module's header comment.
    const obj = cloneSkinned(loaded.template);
    obj.position.copy(slot.position);
    obj.rotation.y = slot.rotationY;
    // loaded.template is TEMPLATE_HEIGHT_M metres tall (not unit-height, unlike the old static
    // asset — see asset.ts), so the scale factor that makes it `slot.heightM` metres tall is the
    // ratio, not heightM itself.
    obj.scale.setScalar(slot.heightM / TEMPLATE_HEIGHT_M);

    const mixer = new THREE.AnimationMixer(obj);
    const action = mixer.clipAction(loaded.clip);
    action.play();
    // Random start point in the clip (cosmetic-only randomness — core/math.ts's `rand`) so
    // several figures on one deck aren't dancing in perfect lockstep.
    action.time = rand(0, loaded.clip.duration);
    mixer.update(0); // apply that starting pose immediately, don't wait a frame to pop in

    return createAnimatedFigure(obj, mixer, action, slot.rotationY);
  }

  function rebuild(): void {
    if (!current) return;
    const { model, spec } = current;
    if (current.group.parent) current.group.parent.remove(current.group);
    const group = new THREE.Group();
    group.name = 'crew-model';
    figures = [];
    if (asset) {
      const slots = placementsFor(spec, model);
      const count = slotCountForTier(tier, slots.length);
      for (let i = 0; i < count; i++) {
        const fig = spawnFigure(asset, slots[i]);
        group.add(fig.object);
        figures.push(fig);
      }
    }
    model.group.add(group);
    current.group = group;
    onGroupReady(group);
  }

  return {
    attachTo(model, spec) {
      current = { model, spec, group: new THREE.Group() };
      rebuild();
    },
    setQuality(newTier) {
      tier = newTier;
      rebuild();
    },
    update(dt, simTime, motion) {
      for (const f of figures) updateFigure(f, simTime, dt, motion, beatSource);
    },
  };
}
