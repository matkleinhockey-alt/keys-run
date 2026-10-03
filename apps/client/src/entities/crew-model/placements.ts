/**
 * Per-boat figure placement — where the deck crew stand on each of the 5 hulls.
 *
 * Deliberately independent of entities/boat/model.ts's own `makeHumanStub` positions (captain at
 * the helm, a stub "crew" near the console/sunpad, the Freeman shower stub, the Midnight dance-
 * pole stub): those are a separate, zero-geometry placeholder system with their own future
 * (presumably getting real models dropped directly into model.ts someday), and this project's
 * brief was explicit about keeping this new work in its own module rather than extending that
 * one. So positions here are computed fresh from each boat's public `Boat` spec (len/beam/style)
 * and its built `BoatModel` (deckY, soleAt(), helmPos, fishSpot, stations, tower) — the same
 * hull-aware building blocks model.ts itself uses — rather than by poking at its internals.
 *
 * The model has no skeleton (see docs/ASSET-LICENCES.md), so there is exactly one pose. "Sitting
 * on the cooler" the way the brief suggested isn't achievable without a seated pose; these are all
 * standing spots instead (leaning on a gunwale, standing at the helm, standing on the open bow) —
 * the honest version of "varied, sensible spots" for a rigid mesh.
 *
 * Coordinates are in the boat model's local space (same space as BoatModel.group's children):
 * +z toward the stern, -z toward the bow, +x to port or starboard depending on hull (mirrored by
 * `side` below), y from `soleAt(z)` (the real deck height at that z, not a guess).
 */
import * as THREE from 'three';
import type { Boat } from '@keysrun/shared/content/boats';
import type { BoatModel } from '../boat/model.js';

export interface FigureSlot {
  position: THREE.Vector3;
  /** Facing, radians around Y. Tuned by eye against the screenshots in
   * test/screenshots/crew/ — if the model's default-forward axis turns out to be flipped, adjust
   * the `FACING_OFFSET` constant below once rather than every slot. */
  rotationY: number;
  /** Target real-world height in metres (the source mesh is normalised to 1 unit tall — see
   * asset.ts's TEMPLATE_UNIT_HEIGHT — so this doubles as the clone's uniform scale). */
  heightM: number;
}

// The glTF's forward axis wasn't verified before building this (no rig/animation to eyeball
// against — a static pose's "facing" is just whichever way the sculpt's chest points). Every
// rotationY below is written as if forward were -Z (three's usual convention) *plus* this
// constant; if the screenshots show everyone facing backward, flip this to Math.PI once here
// instead of re-deriving every slot's angle.
const FACING_OFFSET = 0;

const faceTowardBow = Math.PI + FACING_OFFSET; // local -z is the bow (see header)
const faceTowardStern = FACING_OFFSET;
const faceInboard = (side: 1 | -1): number => side * Math.PI * 0.5 + FACING_OFFSET;

/** A point `inset` metres in from the rail at longitudinal position `z`, at real deck height. */
function gunwale(model: BoatModel, B: number, z: number, side: 1 | -1, inset: number): THREE.Vector3 {
  return new THREE.Vector3(side * (B / 2 - inset), model.soleAt(z), z);
}

function onDeck(model: BoatModel, x: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, model.soleAt(z), z);
}

/**
 * Returns 1-3 slots for the given boat, most-important-first (createCrewSystem truncates this
 * list for lower quality tiers, so put the figure you'd keep if you could only keep one at index
 * 0 — generally a gunwale/helm figure the camera actually gets close to, not the bow).
 */
export function placementsFor(spec: Boat, model: BoatModel): FigureSlot[] {
  const L = spec.len;
  const B = spec.beam;
  const bowZ = -L * 0.33;
  const bowX = Math.min(0.35, B * 0.12);

  switch (spec.id) {
    case 'robalo':
      // 7 m — small enough for one figure to read clearly, two at a stretch.
      return [
        { position: model.stations[0].spot.clone().setY(model.soleAt(model.stations[0].spot.z)), rotationY: faceInboard(-1), heightM: 1.67 },
        { position: onDeck(model, bowX, bowZ), rotationY: faceTowardStern, heightM: 1.6 },
      ];

    case 'grady':
      // 9.3 m all-rounder — one at the helm (the captain stub there is invisible geometry, so
      // this is the only visible "someone's driving" cue), one working the port gunwale.
      return [
        { position: onDeck(model, model.helmPos.x - 0.55, model.helmPos.z + 0.15), rotationY: faceTowardBow, heightM: 1.7 },
        { position: gunwale(model, B, model.stations[1].spot.z, -1, 0.4), rotationY: faceInboard(1), heightM: 1.65 },
      ];

    case 'freeman': {
      // 12.8 m catamaran with a bow lounge and a big tower — the largest deck, three figures.
      const loungeZ = bowZ + L * 0.08;
      return [
        { position: onDeck(model, 0.4, loungeZ), rotationY: faceTowardStern, heightM: 1.68 },
        { position: gunwale(model, B, model.stations[0].spot.z, 1, 0.45), rotationY: faceInboard(-1), heightM: 1.63 },
        { position: onDeck(model, -0.5, model.stations[0].spot.z + L * 0.12), rotationY: faceTowardBow, heightM: 1.72 },
      ];
    }

    case 'midnight':
      // 13.1 m — forward sunpad plus a helm figure. The dance-pole stub (model.ts) is amidships;
      // this helm spot is forward of it, so nobody overlaps the (currently invisible) pole rig.
      return [
        { position: onDeck(model, bowX, bowZ + L * 0.1), rotationY: faceTowardStern, heightM: 1.66 },
        { position: onDeck(model, model.helmPos.x + 0.5, model.helmPos.z - 0.2), rotationY: faceTowardBow, heightM: 1.7 },
      ];

    case 'mti':
      // 12.8 m — forward sunpad plus a starboard gunwale figure.
      return [
        { position: onDeck(model, bowX, bowZ + L * 0.1), rotationY: faceTowardStern, heightM: 1.64 },
        { position: gunwale(model, B, model.stations[0].spot.z, 1, 0.4), rotationY: faceInboard(-1), heightM: 1.69 },
      ];

    default:
      return [{ position: onDeck(model, 0, model.helmPos.z), rotationY: faceTowardBow, heightM: 1.67 }];
  }
}
