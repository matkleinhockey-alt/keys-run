/**
 * Puts the captain on the actual boat deck for a landed rod fish — the thing catch-flow.ts's
 * `setupPhoto` was missing (see that file's header on why: the hold/present poses needed a real
 * human model, which didn't exist when that comment was written). The catch CARD already shows a
 * captain holding the fish (game/catch/portrait.ts) — this module puts the same moment on the
 * boat itself, grounded on the real deck, for both of `setupPhoto`'s existing branches:
 *
 *  - small/holdable fish: `placeHoldingCaptain` — captain stands at the fishing spot, both hands
 *    IK-posed onto the fish's own measured grip points. Deliberately the exact same numeric
 *    recipe portrait.ts's captain-hold branch uses (fish axis, half-span, hand targets) — that
 *    recipe is what makes hands actually land on the fish instead of floating near it (figure.ts's
 *    header: "the one thing that matters"), so reusing it verbatim rather than re-deriving a new
 *    one carries that fix over unchanged.
 *
 *  - big/hung fish: `placePresentingCaptain` — stands beside catch-flow.ts's existing `hangRig`
 *    gin pole, presenting the catch with an open two-hand gesture, NOT gripping the hanging fish.
 *    A hand-on-the-fish pose was considered and rejected: the hang point/hookY/fish-bottom
 *    geometry swings wildly across the weight range this path covers (an 80 lb tarpon hangs with
 *    its tail well clear of the deck; a 600 lb marlin's tail dips to near the deck — see
 *    catch-flow.ts's `hookY` clamp), so one fixed grip offset cannot reliably land a hand ON the
 *    fish for both without clipping through it at one end of the range. figure.ts's own header
 *    already documents this project hitting exactly that failure once before ("a mannequin with a
 *    fish floating nearby") — a standing presenting pose beside a fish that's structurally
 *    anchored to the crane (not floating) is the safe, honest version of this shot.
 *
 * ## Why this file exists instead of extending figure.ts
 *
 * figure.ts's `buildFigure('captain')` is a chest-up BUST by design — the catch card crops the
 * frame below the hips, so it was deliberately built with no legs (see figure.ts's
 * `TORSO_BOTTOM_Y` comment: "there are no legs ... a fish too small for the gin pole rig just
 * rests..."). Standing that bust directly on a real deck with nothing below the hem would be
 * exactly the "floating mannequin" failure mode this project has already had to redo once.
 * `buildLegs` below adds simple standing legs + feet below the figure's existing shorts hem so the
 * deck version is a whole grounded person. This lives here (not in figure.ts, which is the
 * catch-card's shared asset and out of scope for this task) because legs are a deck-only concern.
 */
import * as THREE from 'three';
import { buildFigure, type Figure } from './figure.js';
import type { BoatModel } from '../../entities/boat/model.js';

export interface DeckCaptainHandle {
  /** The whole standing captain, already positioned/rotated in `model.group`'s local space —
   * callers add this to `model.group` themselves, same convention catch-flow.ts's existing
   * `hangRig`/fish-mesh placement already uses (the builder returns an unparented node, the call
   * site parents it). */
  group: THREE.Group;
  dispose(): void;
}

// A believable adult height for the deck version — figure.ts has no opinion on overall height
// (the catch card centres the composition on its own frame points, never measures a total
// standing height), so this is this module's own call, picked to land in the same range
// entities/crew-model/placements.ts already uses for the other human figures on these decks
// (1.6-1.72 m).
const STAND_HEIGHT_M = 1.72;

// figure.ts's captain torso ends in a khaki shorts hem (`hem.position.y = TORSO_BOTTOM_Y - 0.06`,
// `TORSO_BOTTOM_Y = -0.22`, hem height `0.12`) whose bottom edge sits at -0.22 - 0.06 - 0.06 =
// -0.34 in the figure's own local space. Not exposed by Figure's public interface
// (`framePoints()` only covers head/shoulders/hands — the points a card camera-fit cares about),
// so this is a direct, documented reading of figure.ts's own current numbers. figure.ts is
// read-only for this task; if its hem geometry ever moves, revisit this constant.
const HEM_BOTTOM_Y = -0.34;
const CHEST_Z = -0.03; // matches figure.ts's own chestZ — legs sit under the torso, not forward of it.

/** Adds standing legs + feet to `figure.group`, running from the existing shorts hem down to the
 * deck. Tracks every geometry/material it creates in `geos`/`mats` so the caller can dispose them
 * alongside `figure.dispose()` — nothing here is shared/cached across catches (unlike, say,
 * fish-mesh.ts's material cache), so a plain dispose-everything-this-call is correct and required. */
function buildLegs(figure: Figure, legLength: number, geos: THREE.BufferGeometry[], mats: THREE.Material[]): void {
  // Same bare-skin tone as figure.ts's `captainSkin` (0xb97b50) — the shorts hem already covers
  // the thigh; bare skin below is consistent with the rest of the dry, sun-tanned captain look.
  const skin = new THREE.MeshStandardMaterial({ color: 0xb97b50, roughness: 0.58 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0x262626, roughness: 0.75 });
  mats.push(skin, shoe);
  for (const sx of [-1, 1] as const) {
    const legGeo = new THREE.CylinderGeometry(0.052, 0.075, legLength, 12);
    geos.push(legGeo);
    const leg = new THREE.Mesh(legGeo, skin);
    leg.position.set(sx * 0.085, HEM_BOTTOM_Y - legLength / 2, CHEST_Z);
    figure.group.add(leg);

    const footGeo = new THREE.BoxGeometry(0.1, 0.055, 0.22);
    geos.push(footGeo);
    const foot = new THREE.Mesh(footGeo, shoe);
    foot.position.set(sx * 0.085, HEM_BOTTOM_Y - legLength - 0.027, CHEST_Z + 0.06);
    figure.group.add(foot);
  }
}

/** Builds the captain bust (figure.ts), poses its arms onto the given targets (figure-local
 * space), then grounds it with legs sized so the whole figure is `STAND_HEIGHT_M` tall. Returns
 * the figure's own group (legs included) plus how far below local y=0 the feet land — the caller
 * needs that to place the group's world Y on the real deck. */
function buildStandingCaptain(armTargetA: THREE.Vector3, armTargetB: THREE.Vector3): {
  group: THREE.Group;
  feetLocalY: number;
  dispose(): void;
} {
  const figure = buildFigure('captain');
  figure.poseArms(armTargetA, armTargetB);
  // Index 0 is "bare head top" (figure.ts's framePoints doc comment) — static geometry, doesn't
  // depend on the arm pose above, but called after poseArms anyway per that method's own contract.
  const headTopY = figure.framePoints()[0].y;
  const legLength = STAND_HEIGHT_M - headTopY + HEM_BOTTOM_Y;

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  buildLegs(figure, legLength, geos, mats);

  return {
    group: figure.group,
    feetLocalY: HEM_BOTTOM_Y - legLength,
    dispose(): void {
      figure.dispose();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

/** Small/holdable fish (catch-flow.ts's `setupPhoto` non-hang branch): the captain stands at
 * `model.fishSpot` holding `fish` up at chest height. `fish` is the live mesh/group catch-flow.ts
 * already built with `makeFishMesh` — parented here as a sibling of the captain, posed with the
 * exact fishAxis/fishPos/half-span recipe game/catch/portrait.ts's captain-hold branch uses (see
 * this file's header), just grounded instead of centred for an isolated camera. Caller still owns
 * `fish` for teardown/release — this only positions it. */
export function placeHoldingCaptain(model: BoatModel, deckY: number, fish: THREE.Object3D): DeckCaptainHandle {
  const fishBox = new THREE.Box3().setFromObject(fish);
  const totalLen = Math.max(0.05, fishBox.max.z - fishBox.min.z);
  const midZLocal = (fishBox.max.z + fishBox.min.z) / 2;
  const halfSpanLocal = Math.min(totalLen * 0.41, 0.34);

  const fishAxis = new THREE.Vector3(1, 0.14, 0).normalize();
  const fishPos = new THREE.Vector3(0, -0.04, 0.34);
  const fishQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fishAxis);
  const toRigSpace = (localZ: number): THREE.Vector3 =>
    new THREE.Vector3(0, 0, localZ).applyQuaternion(fishQuat).add(fishPos);

  const captain = buildStandingCaptain(toRigSpace(midZLocal - halfSpanLocal), toRigSpace(midZLocal + halfSpanLocal));

  fish.position.copy(fishPos);
  fish.quaternion.copy(fishQuat);

  const rig = new THREE.Group();
  rig.add(captain.group);
  rig.add(fish);
  // Figure's own front (chest/sunglasses, figure.ts's header) faces local +Z — leave rotationY at
  // 0 so he faces the same way the fish/camera-facing composition above already assumes.
  rig.position.set(model.fishSpot.x, deckY - captain.feetLocalY, model.fishSpot.z);

  return {
    group: rig,
    dispose(): void { captain.dispose(); },
  };
}

/** Big/hung fish (catch-flow.ts's `setupPhoto` hang-rig branch): the captain stands beside the
 * gin pole, presenting the catch with an open two-hand gesture — see this file's header for why
 * that gesture doesn't try to touch the hanging fish itself. Stands at `model.fishSpot` (the same
 * anchor the gin pole itself is offset from by `hangRig`'s own `+0.55` in x), facing the pole. */
export function placePresentingCaptain(model: BoatModel, deckY: number): DeckCaptainHandle {
  // A relaxed near hand close to the body and a raised/extended far hand, in the figure's own
  // local space — an open "here it is" gesture, not a grip. Well within both arms' reach
  // (L1+L2 = 0.52 m; both targets sit under 0.47 m from either shoulder).
  const near = new THREE.Vector3(-0.24, -0.08, 0.16);
  const far = new THREE.Vector3(0.32, 0.14, 0.4);
  const captain = buildStandingCaptain(near, far);

  const rig = new THREE.Group();
  rig.add(captain.group);
  rig.position.set(model.fishSpot.x, deckY - captain.feetLocalY, model.fishSpot.z);
  // Face local +Z (the figure's own front) toward world +X, the fixed direction `hangRig`/
  // catch-flow.ts always offsets the gin pole in (`hx = fishSpot.x + 0.55`), regardless of which
  // side of the boat the active fishing station happens to be on.
  rig.rotation.y = Math.PI / 2;

  return {
    group: rig,
    dispose(): void { captain.dispose(); },
  };
}
