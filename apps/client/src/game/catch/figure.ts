/**
 * Shared procedural human figure for both catch cards — the underwater diver
 * (game/catch/underwater-trophy.ts) and the surface captain (game/catch/portrait.ts) grip-and-grin
 * holds. Extracted from underwater-trophy.ts's original `buildDiverFigure` (see that file's header
 * for the full "why procedural, not rigged" rationale and the two-bone IK precedent — in short:
 * one static hold, not a loop, and the one thing that matters — hands actually meeting the fish,
 * not floating near it — is exactly what procedural two-bone IK nails by construction, driven by
 * the fish's own measured grip points).
 *
 * `buildFigure('diver')` renders the identical figure underwater-trophy.ts shipped before this
 * extraction — only the module moved, not one number changed. `buildFigure('captain')` is new:
 * the same torso/neck/head/two-bone-IK-arm skeleton (so it inherits the exact hand-placement
 * machinery that was specifically fixed after a "mannequin with a fish floating nearby" failure —
 * see underwater-trophy.ts's header), re-dressed for an above-water look — cap + sunglasses +
 * short-sleeve fishing shirt + a khaki shorts hem, sun-tanned bare skin — instead of the diver's
 * wetsuit/mask/snorkel. Matte skin (no clearcoat) is the one deliberate material difference beyond
 * colour: the diver is dripping wet, the captain is dry and sun-lit.
 */
import * as THREE from 'three';

export type FigureLook = 'diver' | 'captain';

export interface Figure {
  group: THREE.Group;
  /** Poses both arms so each hand lands exactly on the given world (pivot-local) target — call
   * once per `show()` with the fish's own grip points. */
  poseArms(targetA: THREE.Vector3, targetB: THREE.Vector3): void;
  /** The points a camera-fit should actually care about: head top, headwear top (snorkel/cap),
   * both shoulders, both (posed) hands — deliberately NOT the torso, which is allowed to run out
   * the bottom of frame (see TORSO_BOTTOM_Y's comment below). Call after `poseArms`. */
  framePoints(): THREE.Vector3[];
  dispose(): void;
}

// ---- two-bone IK (legacy index.html:1331-1333's `solve`, ported) -----------------------------

interface IKResult { elbow: THREE.Vector3; hand: THREE.Vector3; dir: THREE.Vector3 }

function solveIK(shoulder: THREE.Vector3, target: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3): IKResult {
  const d = target.clone().sub(shoulder);
  const len = Math.min(d.length(), l1 + l2 - 0.003) || 0.001;
  const dir = d.clone().normalize();
  const a1 = (l1 * l1 - l2 * l2 + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a1 * a1));
  const pp = pole.clone();
  pp.addScaledVector(dir, -pp.dot(dir));
  if (pp.lengthSq() < 1e-6) pp.set(0, 1, 0).addScaledVector(dir, -pp.dot(dir));
  pp.normalize();
  const elbow = shoulder.clone().addScaledVector(dir, a1).addScaledVector(pp, h);
  const hand = shoulder.clone().addScaledVector(dir, len);
  return { elbow, hand, dir };
}

/** Orients a unit-height (built with height=1) cylinder mesh to run from `a` to `b` — legacy's
 * `setLimb`, ported. */
function setLimb(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
  const d = b.clone().sub(a);
  const len = d.length() || 0.001;
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().multiplyScalar(1 / len));
  mesh.scale.set(1, len, 1);
}

interface Arm {
  sx: -1 | 1;
  shoulder: THREE.Vector3;
  upper: THREE.Mesh;
  fore: THREE.Mesh;
  elbow: THREE.Mesh;
  hand: THREE.Mesh;
}

const L1 = 0.27; // upper arm
const L2 = 0.25; // forearm

export function buildFigure(look: FigureLook): Figure {
  const isDiver = look === 'diver';
  const group = new THREE.Group();

  // Every geometry/material created below is tracked here and disposed exactly once — a single
  // `part()` helper (rather than the hand-picked dispose list the pre-extraction diver-only file
  // used) so adding/removing look-specific pieces can never leave something undisposed or double-
  // dispose something shared.
  const geos: THREE.BufferGeometry[] = [];
  const seenMats = new Set<THREE.Material>();
  const mats: THREE.Material[] = [];
  function part(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
    geos.push(geo);
    if (!seenMats.has(mat)) { seenMats.add(mat); mats.push(mat); }
    const m = new THREE.Mesh(geo, mat);
    group.add(m);
    return m;
  }
  // 14 radial segments (was 10 in the first pass) — at 10 segments a smooth-shaded cylinder still
  // reads as faceted at this card's close framing; built once per catch (human-interaction
  // frequency, not per-frame), so the extra triangles cost nothing that matters.
  const unitCyl = (r0: number, r1: number, seg = 14): THREE.CylinderGeometry => {
    const g = new THREE.CylinderGeometry(r1, r0, 1, seg);
    return g;
  };

  // ---- materials ---------------------------------------------------------------------------
  // Diver: wetsuit/mask/snorkel, numbers unchanged from the pre-extraction file. Lighter than a
  // literal near-black neoprene on purpose — it measured as nearly invisible against this card's
  // dark backdrop; "wetsuit-dark-teal" reads as a wetsuit while still catching the key light.
  // `MeshPhysicalMaterial` with a light clearcoat on both wetsuit and skin — the diver is wet.
  const wetsuit = new THREE.MeshPhysicalMaterial({ color: 0x2d4f58, roughness: 0.45, metalness: 0.1, clearcoat: 0.25, clearcoatRoughness: 0.4 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x23282d, roughness: 0.55 });
  const diverSkin = new THREE.MeshPhysicalMaterial({ color: 0xc9916b, roughness: 0.5, clearcoat: 0.2, clearcoatRoughness: 0.45 });

  // Captain: above water, dry and sun-lit — matte everywhere (no clearcoat on skin or fabric),
  // a light short-sleeve fishing shirt and khaki shorts, deeper/warmer tan than the diver's.
  const shirt = new THREE.MeshStandardMaterial({ color: 0xcfe2e3, roughness: 0.78 });
  const shorts = new THREE.MeshStandardMaterial({ color: 0xcab791, roughness: 0.82 });
  const captainSkin = new THREE.MeshStandardMaterial({ color: 0xb97b50, roughness: 0.58 });
  const capCrown = new THREE.MeshStandardMaterial({ color: 0x1f3b57, roughness: 0.65 });
  const capBrim = new THREE.MeshStandardMaterial({ color: 0x16293b, roughness: 0.7 });
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.75 });
  const shadesMat = new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.15, metalness: 0.35 });

  const bodyMat = isDiver ? wetsuit : shirt;         // torso / shoulder caps / upper arm (sleeve)
  // Diver's wetsuit sleeve runs the full arm; the captain's short sleeve ends above the elbow, so
  // the forearm/elbow/hand are bare sun-tanned skin instead.
  const foreMat = isDiver ? wetsuit : captainSkin;
  const elbowMat = isDiver ? wetsuit : captainSkin;
  const handMat = isDiver ? glove : captainSkin;     // gloved vs. bare hand
  const headSkin = isDiver ? diverSkin : captainSkin;

  const shoulderY = 0.12, chestZ = -0.03;
  // Deliberately cropped at the chest, not the real waist: there are no legs (the frame never
  // shows them) and a flat-bottomed cylinder — rather than a capsule's rounded cap — reads as
  // "continues below, just out of frame" instead of "this is where the body actually ends".
  const TORSO_BOTTOM_Y = -0.22, TORSO_TOP_Y = shoulderY + 0.03;
  const torso = part(new THREE.CylinderGeometry(0.155, 0.185, TORSO_TOP_Y - TORSO_BOTTOM_Y, 18), bodyMat);
  torso.position.set(0, (TORSO_TOP_Y + TORSO_BOTTOM_Y) / 2, chestZ);

  if (isDiver) {
    // a BCD-ish ridge + a hint of tank, same cheap read as entities/diver/model.ts's own placeholder.
    const tank = part(new THREE.CapsuleGeometry(0.1, 0.26, 4, 8), new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.35, metalness: 0.5 }));
    tank.position.set(0, TORSO_TOP_Y - 0.16, chestZ - 0.2);
  } else {
    // A khaki hem below the shirt — reads as shorts if the frame's bottom crop reaches this low,
    // without building legs the frame never shows (same "crop, don't build what's cut" convention
    // as the diver's torso, above).
    const hem = part(new THREE.CylinderGeometry(0.185, 0.19, 0.12, 18), shorts);
    hem.position.set(0, TORSO_BOTTOM_Y - 0.06, chestZ);
  }

  // shoulders (small caps where the arms root — helps the arm/torso joint read as one body).
  for (const sx of [-1, 1] as const) {
    const cap = part(new THREE.SphereGeometry(0.095, 14, 10), bodyMat);
    cap.position.set(sx * 0.19, shoulderY - 0.02, chestZ);
  }

  // neck + head.
  const neck = part(new THREE.CylinderGeometry(0.052, 0.058, 0.1, 14), headSkin);
  neck.position.set(0, shoulderY + 0.1, chestZ + 0.01);

  const headY = shoulderY + 0.28;
  const head = part(new THREE.SphereGeometry(0.135, 18, 14), headSkin);
  head.position.set(0, headY, chestZ + 0.02);

  // The accessory-specific "top" framing point (snorkel tip for the diver, cap crown for the
  // captain) — see Figure.framePoints' doc comment on why this matters more than the bare head.
  let topPoint: THREE.Vector3;

  if (isDiver) {
    const maskGlass = new THREE.MeshStandardMaterial({ color: 0x0a0e12, roughness: 0.08, metalness: 0.3 });
    const maskFrame = new THREE.MeshStandardMaterial({ color: 0x2b3238, roughness: 0.5 });
    // Dark rubber, not a bright accent colour — a first pass made the snorkel the single most
    // visually dominant thing in frame by giving it the only saturated colour anywhere on the
    // figure. A small bright purge-valve accent (near the mouthpiece) is plenty.
    const snorkelMat = new THREE.MeshStandardMaterial({ color: 0x24292e, roughness: 0.5 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.4 });

    // A flattened sphere ("lens" shape) rather than a flat BoxGeometry — a box's corner vertices
    // can't share smooth normals across perpendicular faces no matter the shading mode; a sphere
    // is smooth by construction and scales down to the same rounded-rectangle silhouette a real
    // dive mask lens has.
    const mask = part(new THREE.SphereGeometry(1, 16, 12), maskGlass);
    mask.scale.set(0.105, 0.05, 0.025);
    mask.position.set(0, headY - 0.01, chestZ + 0.02 + 0.105);
    const maskRim = part(new THREE.TorusGeometry(0.1, 0.016, 6, 16), maskFrame);
    maskRim.position.copy(mask.position);
    maskRim.position.z -= 0.015;
    const strap = part(new THREE.TorusGeometry(0.135, 0.012, 6, 12, Math.PI), maskFrame);
    strap.position.set(0, headY - 0.01, chestZ + 0.02 - 0.02);
    strap.rotation.y = Math.PI / 2;

    // snorkel: mouthpiece near the mask's lower side, a bent tube running up past the top of the
    // head — two straight segments read fine as a "J" at this fidelity.
    const snorkA = new THREE.Vector3(0.1, headY - 0.1, chestZ + 0.09);
    const snorkB = new THREE.Vector3(0.13, headY + 0.07, chestZ + 0.05);
    const snorkC = new THREE.Vector3(0.13, headY + 0.22, chestZ + 0.03);
    const snork1 = part(unitCyl(0.017, 0.017, 8), snorkelMat);
    setLimb(snork1, snorkA, snorkB);
    const snork2 = part(unitCyl(0.015, 0.015, 8), snorkelMat);
    setLimb(snork2, snorkB, snorkC);
    const purge = part(new THREE.CylinderGeometry(0.019, 0.019, 0.03, 8), accentMat);
    setLimb(purge, snorkB.clone().add(new THREE.Vector3(0, -0.015, 0)), snorkB.clone().add(new THREE.Vector3(0, 0.015, 0)));
    const mouthpiece = part(new THREE.SphereGeometry(0.026, 8, 6), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }));
    mouthpiece.position.copy(snorkA);

    topPoint = snorkC.clone();
  } else {
    // Cap: a crown covering the top/back of the head, a flat forward brim, and a sliver of hair
    // peeking out beneath the back of the crown (legacy `makeHuman`'s `o.cap` branch, index.html
    // ~1296-1298, trimmed to primitives).
    const crown = part(new THREE.SphereGeometry(0.142, 16, 10, 0, Math.PI * 2, 0, Math.PI / 1.9), capCrown);
    crown.position.set(0, headY + 0.02, chestZ + 0.005);
    const brim = part(new THREE.BoxGeometry(0.19, 0.014, 0.1), capBrim);
    brim.position.set(0, headY + 0.06, chestZ + 0.02 + 0.095);
    brim.rotation.x = -0.28;
    const hairPeek = part(new THREE.SphereGeometry(0.09, 12, 8), hairMat);
    hairPeek.scale.set(1, 0.7, 0.55);
    hairPeek.position.set(0, headY - 0.03, chestZ - 0.06);

    // Sunglasses: one lens bar + two temple arms, sitting directly on the face — no mask standoff
    // (a scuba mask has an air gap; sunglasses don't).
    part(new THREE.BoxGeometry(0.165, 0.04, 0.018), shadesMat).position.set(0, headY - 0.015, chestZ + 0.02 + 0.1);
    for (const sx of [-1, 1] as const) {
      part(new THREE.BoxGeometry(0.012, 0.014, 0.08), shadesMat).position.set(sx * 0.088, headY - 0.013, chestZ + 0.02 + 0.06);
    }

    topPoint = new THREE.Vector3(0, headY + 0.185, chestZ);
  }

  // arms, built in a neutral pose — poseArms() re-solves them per catch.
  const buildArm = (sx: -1 | 1): Arm => {
    const shoulder = new THREE.Vector3(sx * 0.19, shoulderY - 0.02, chestZ);
    const upper = part(unitCyl(0.052, 0.045), bodyMat);
    const fore = part(unitCyl(0.044, 0.036), foreMat);
    const elbow = part(new THREE.SphereGeometry(0.046, 14, 10), elbowMat);
    // A short capsule (rotated so its long axis is Z, matching the grip-direction quaternion
    // below — same "build pre-rotated, orient with setFromUnitVectors" convention `unitCyl`/
    // `setLimb` use for the limbs) rather than a plain sphere — it reads as a loosely-closed fist
    // wrapped around the fish instead of a ball balanced against it.
    const hand = part(new THREE.CapsuleGeometry(0.05, 0.028, 4, 12).rotateX(Math.PI / 2), handMat);
    return { sx, shoulder, upper, fore, elbow, hand };
  };
  const arms: [Arm, Arm] = [buildArm(-1), buildArm(1)];

  function poseArms(targetA: THREE.Vector3, targetB: THREE.Vector3): void {
    // Nearest-shoulder assignment so the arms never cross — try both pairings, keep the shorter.
    const dAA = arms[0].shoulder.distanceToSquared(targetA) + arms[1].shoulder.distanceToSquared(targetB);
    const dAB = arms[0].shoulder.distanceToSquared(targetB) + arms[1].shoulder.distanceToSquared(targetA);
    const [tL, tR] = dAA <= dAB ? [targetA, targetB] : [targetB, targetA];
    for (const [arm, target] of [[arms[0], tL], [arms[1], tR]] as const) {
      const pole = new THREE.Vector3(arm.sx * 0.5, -0.85, 0.5);
      const { elbow, hand } = solveIK(arm.shoulder, target, L1, L2, pole);
      setLimb(arm.upper, arm.shoulder, elbow);
      setLimb(arm.fore, elbow, hand);
      arm.elbow.position.copy(elbow);
      arm.hand.position.copy(hand);
      // A slight squeeze/elongation along the grip direction reads a little more like a wrapped
      // hand than a bare ball, cheaply.
      const gripDir = target.clone().sub(elbow).normalize();
      arm.hand.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), gripDir);
      arm.hand.scale.set(1.25, 0.95, 0.85);
    }
  }

  function framePoints(): THREE.Vector3[] {
    return [
      new THREE.Vector3(0, headY + 0.145, chestZ), // bare head top, a touch past the sphere radius
      topPoint.clone(),
      arms[0].shoulder.clone(), arms[1].shoulder.clone(),
      arms[0].hand.position.clone(), arms[1].hand.position.clone(),
    ];
  }

  function dispose(): void {
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
  }

  return { group, poseArms, framePoints, dispose };
}
