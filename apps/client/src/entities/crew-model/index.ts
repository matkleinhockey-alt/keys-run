/**
 * Deck crew — places the loaded figure (see asset.ts) on whichever boat is current, parented to
 * the boat's own group so it rides the hull's heave/pitch/roll for free (docs/ARCHITECTURE.md:
 * "boat y, pitch, roll ... client only" — anything parented under `model.group` inherits that
 * motion with zero extra code; it would be wrong to position figures in world space).
 *
 * Quality tiers gate how many figures appear (docs/ARCHITECTURE.md "Performance budget" — see
 * this project's report for the measured draw-call delta this adds): Low gets none, Medium gets
 * one, High/Ultra get every slot entities/crew-model/placements.ts defines for that hull (1-3).
 *
 * --- Adding the rigged+animated version later ---
 * The user's Mixamo-animated export (once they've run the current static model through Mixamo's
 * auto-rigger themselves — NOT done by this pipeline, see docs/ASSET-LICENCES.md) would change
 * exactly three things here, nothing in apps/game/world.ts or placements.ts:
 *   1. asset.ts: `template.clone()` → the clip has bones, so cloning must walk through
 *      `SkeletonUtils.clone(scene)` (three/addons/utils/SkeletonUtils.js) instead of the plain
 *      `Object3D.clone()` a `THREE.LOD.clone()` does today — a skinned mesh's `.clone()` does NOT
 *      duplicate its skeleton, so naively cloning N instances would have them all sharing (and
 *      fighting over) one skeleton's bone transforms.
 *   2. spawnFigure() below: after cloning, build one `THREE.AnimationMixer` per clone and
 *      `mixer.clipAction(danceClip).play()`; store the mixer on the returned handle.
 *   3. This module's `update(dt)` (doesn't exist yet, because nothing needs per-frame work for a
 *      static pose) would need to exist and call `mixer.update(dt)` per figure, and
 *      apps/client/src/game/world.ts's frame() loop would need one call added.
 * Everything about *where* figures stand (placements.ts) and *how many* (quality tiers, this
 * file) is unaffected — swapping the asset is a contained change, not a rewrite.
 */
import * as THREE from 'three';
import type { Boat } from '@keysrun/shared/content/boats';
import type { BoatModel } from '../boat/model.js';
import type { QualityTier } from '../../core/quality.js';
import { loadCrewAsset, type CrewAsset } from './asset.js';
import { placementsFor } from './placements.js';

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
}

export function createCrewSystem(
  initialTier: QualityTier,
  /** Called with the freshly-(re)built crew group every time it changes — sync on attachTo/
   * setQuality, and again whenever the async glTF arrives after a boat already asked for crew.
   * world.ts uses this to run the cascaded-shadow setup (`shadows.applyToSubtree`) on just the
   * new group, since this module has no business knowing the shadow system exists. */
  onGroupReady: (group: THREE.Group) => void,
): CrewSystem {
  let tier = initialTier;
  let asset: CrewAsset | null = null;
  let current: { model: BoatModel; spec: Boat; group: THREE.Group } | null = null;

  loadCrewAsset()
    .then((loaded) => {
      asset = loaded;
      rebuild(); // asset may have arrived after a boat already asked for crew — pop in now
    })
    .catch((err: unknown) => {
      // Never block or crash the boat over a cosmetic asset — boats just sail empty-decked.
      console.error('[crew-model] failed to load deck crew asset; boats will have no crew', err);
    });

  function spawnFigure(template: THREE.LOD, slot: ReturnType<typeof placementsFor>[number]): THREE.Object3D {
    const fig = template.clone(); // shares geometry/material across every instance — see asset.ts
    fig.position.copy(slot.position);
    fig.rotation.y = slot.rotationY;
    fig.scale.setScalar(slot.heightM); // template is unit-height; scale == target metres
    return fig;
  }

  function rebuild(): void {
    if (!current) return;
    const { model, spec } = current;
    if (current.group.parent) current.group.parent.remove(current.group);
    const group = new THREE.Group();
    group.name = 'crew-model';
    if (asset) {
      const slots = placementsFor(spec, model);
      const count = slotCountForTier(tier, slots.length);
      for (let i = 0; i < count; i++) group.add(spawnFigure(asset.template, slots[i]));
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
  };
}
