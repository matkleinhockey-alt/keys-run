/**
 * The pulley block at the head of the gin pole that a big fish hangs from — shared by the boat
 * deck's rig (game/catch/catch-flow.ts's `hangRig`) and the catch card's studio prop
 * (game/catch/portrait.ts's `buildHangRigProp`).
 *
 * Both rigs already had a post, a boom, a cable and a spring scale, but the cable simply began in
 * mid-air at the boom tip. A gin pole does not work that way: the lifting line runs over a sheave
 * in a block at the head, which is the part that makes it read as a hoist you could actually crank
 * a 600 lb fish up with rather than a bent pipe with a fish glued under it.
 *
 * Lives in its own module rather than in either caller because the two rigs are built at very
 * different scales — the deck rig is in world metres on a 12.8 m boat, the card's prop is sized
 * against the fish filling a small offscreen render — so the one thing they must share is the
 * *shape*, parameterised by radius. Duplicating it in both files is how the two drifted apart
 * before (see `floorY`'s stale copy in entities/fish/school.ts for what that costs).
 */
import * as THREE from 'three';

export interface PulleyOptions {
  /** Sheave radius. The cheeks, pin and becket are all derived from this. */
  radius: number;
  /** Rotation of the whole block about Y, so the cheeks face the viewer. Defaults to facing +X. */
  faceY?: number;
}

/**
 * A single-sheave block: two cheek plates, the grooved sheave between them, the pin through the
 * middle, and a becket shackle on top that carries the load into the boom.
 *
 * Returned centred on its own origin, which is the sheave's axle — put that at the point where the
 * cable changes direction and the line will read as running over the wheel.
 */
export function buildPulleyBlock(opts: PulleyOptions): THREE.Group {
  const { radius: r, faceY = 0 } = opts;
  const g = new THREE.Group();

  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced3, metalness: 0.9, roughness: 0.22 });
  const cheekMat = new THREE.MeshStandardMaterial({ color: 0x8e959b, metalness: 0.75, roughness: 0.35 });
  const pinMat = new THREE.MeshStandardMaterial({ color: 0x4a4f54, metalness: 0.8, roughness: 0.4 });

  // Sheave: a slightly tapered cylinder reads as a grooved rim at this size without needing a
  // lathe profile — the groove is only ever a couple of pixels on the card.
  const sheave = new THREE.Mesh(new THREE.CylinderGeometry(r, r, r * 0.42, 20), steel);
  sheave.rotation.x = Math.PI / 2; // axle along Z, wheel face in the XY plane
  g.add(sheave);

  // Cheek plates either side, a touch proud of the sheave so the wheel sits in a visible slot.
  for (const sz of [-1, 1]) {
    const cheek = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.18, r * 1.18, r * 0.12, 18), cheekMat);
    cheek.rotation.x = Math.PI / 2;
    cheek.position.z = sz * r * 0.3;
    g.add(cheek);
  }

  // Axle pin through both cheeks.
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.16, r * 0.16, r * 0.9, 10), pinMat);
  pin.rotation.x = Math.PI / 2;
  g.add(pin);

  // Becket: the shackle above the sheave that takes the load up into the boom.
  const strapR = r * 0.1;
  const strap = new THREE.Mesh(new THREE.TorusGeometry(r * 0.72, strapR, 6, 16, Math.PI), steel);
  strap.position.y = r * 0.1;
  g.add(strap);
  const eye = new THREE.Mesh(new THREE.TorusGeometry(r * 0.3, strapR, 6, 14), steel);
  eye.position.y = r * 1.05;
  eye.rotation.y = Math.PI / 2;
  g.add(eye);

  g.rotation.y = faceY;
  return g;
}
