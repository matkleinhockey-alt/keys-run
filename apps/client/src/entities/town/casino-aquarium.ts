/**
 * The Gaff & Gill's aquarium wall: a 6.4 m built-in tank down the west wall, with fourteen fish
 * swimming in it.
 *
 * ## Why this is not the game's fish
 * `entities/fish/**` is the open ocean's system: schooling, hunger, flee responses, hook state, a
 * spatial hash, LOD rigs. None of that is visible through 12 mm of glass from three metres away,
 * and all of it costs. So this is a self-contained decoration with no simulation state at all:
 * every fish's position is a closed-form function of the clock (a figure-of-eight in plan, a slow
 * sine in depth), which means nothing to integrate, nothing to advance while the player is at sea,
 * and a fish that is in exactly the right place the first frame the player walks in.
 *
 * ## The budget (this room's whole point — see casino-interior.ts's header)
 * The tank adds NO light. Its shell, gravel, rockwork and gold frame go into the interior's
 * existing `solid` batch (1,332 triangles), the hood lamp into `neon` (12) and the light it throws
 * on the carpet into `glow` (44) — all of that is zero extra draw calls. What it does add is three
 * meshes:
 *   - one InstancedMesh for the fish bodies (14 instances, tinted per fish with `setColorAt`),
 *   - one InstancedMesh for their tails, hinged at the peduncle so they can actually wag,
 *   - one additive pane for the glass.
 * Measured standing in front of it with test/capture-casino-aquarium.mjs's `cost` mode, against the
 * same three meshes hidden: +4 draw calls and +13k triangles, on a frame of 317 and 620k. (Four and
 * not three: something draws one of the two opaque instanced meshes twice, most likely the postfx
 * normal pass. Not chased further — it is one call.) Per frame the animation is 28 matrix composes
 * and 42 sin/cos, and it runs only while the player is in the room.
 *
 * ## Why two instanced meshes rather than one merged geometry
 * A single merged geometry would be one draw call, but then animating it means rewriting 14 fish
 * worth of vertices on the CPU every frame. Instancing writes 28 matrices instead and lets the tail
 * swing about its own hinge, which is the one motion that makes a shape read as a fish rather than
 * a drifting pebble. (A shader-deformed single mesh would be cheaper still and was rejected: a
 * custom material in this room is a fourth program compiled for a decoration.)
 */
import * as THREE from 'three';
import { GeoBatch } from './batch.js';
import { Zf } from './props.js';

/** The footprint, from CASINO_BOXES — the collider the player bumps into is the same rectangle. */
export interface TankBox { u0: number; u1: number; v0: number; v1: number }

export interface Aquarium {
  /** Called only while the player is in the room (casino-interior.ts gates it the same way as the crowd). */
  update(t: number): void;
  dispose(): void;
  /** For the capture script's cost report. */
  readonly tris: number;
}

const GOLD = 0xe0b34a;

/**
 * One fish. All in the interior's local frame (x = u, z = -v) except `len`, which scales the
 * unit-length model. The plan path is a figure-of-eight — `x` runs at twice the angular rate of
 * `z` — so the turn rate varies around the loop and the fish visibly bank into the tight end of
 * it, which a plain circle never does.
 */
interface Fish {
  cx: number; rx: number; cz: number; rz: number;
  y: number; vamp: number; vw: number;
  w: number; ph: number; xph: number; vph: number;
  len: number; beat: number; color: number;
}

/** Tropical-tank colours: the loud ones, because this is a casino and the glass is tinted. */
const COLORS = [0xffb03a, 0xf2f2ea, 0x3fd8ff, 0xff6a4a, 0xffe27a, 0x7de0a0, 0xff7ac0, 0x8ab4ff];

/** Deterministic spread, so two captures of the same second show the same tank. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The fish model, nose at +x. Built in a frame where UP is +z and the thin lateral axis is +y —
 * that is the only way to get a laterally flattened body out of `GeoBatch.ball`, whose `sy` squashes
 * y and nothing else. The geometry is rotated upright at the end. (Post-scaling a built geometry in z
 * was the first attempt; it flattens the eyes into the skull along with everything else.)
 *
 * Vertex colours are near-white on purpose: the InstancedMesh multiplies them by a per-fish
 * `instanceColor`, so eight colours of fish cost one geometry and one material.
 */
function fishBody(): THREE.BufferGeometry {
  const b = new GeoBatch();
  const FLAT = 0.44;
  // nose to peduncle, as a row of tapering balls — the same idiom as the lobby fountain's marlin
  const prof: ReadonlyArray<readonly [number, number]> = [[0.44, 0.05], [0.34, 0.1], [0.21, 0.13], [0.06, 0.135], [-0.1, 0.11], [-0.24, 0.07], [-0.33, 0.035]];
  for (const [x, r] of prof) b.ball(x, 0, 0, r, 0xffffff, FLAT, 8);
  for (const [x, r] of prof) if (r > 0.06) b.ball(x, 0, -r * 0.42, r * 0.66, 0xf0f6ff, FLAT, 6); // pale belly
  b.box(0.0, 0, 0.17, 0.3, 0.014, 0.13, 0xe6eef4, { ry: 0.12 });     // dorsal
  b.box(-0.12, 0, -0.13, 0.16, 0.012, 0.08, 0xe6eef4, { ry: -0.3 }); // anal fin
  for (const sy of [-1, 1]) b.box(0.17, sy * 0.055, -0.03, 0.14, 0.01, 0.1, 0xdfe8ef, { ry: sy * 0.35, rz: sy * 0.2 }); // pectorals
  for (const sy of [-1, 1]) {
    b.ball(0.35, sy * 0.045, 0.045, 0.04, 0xffffff, 1, 6);
    b.ball(0.362, sy * 0.058, 0.048, 0.021, 0x0e1620, 1, 5);
  }
  const g = b.build();
  g.rotateX(-Math.PI / 2); // build-frame +z (up) -> +y, +y (lateral) -> -z
  topLight(g);
  return g;
}

/** The caudal fin, hinged at the origin and trailing off toward -x so a yaw about the origin wags it. */
function fishTail(): THREE.BufferGeometry {
  const b = new GeoBatch();
  b.box(-0.05, 0, 0, 0.12, 0.05, 0.07, 0xffffff);                              // peduncle
  for (const s of [1, -1]) b.box(-0.18, 0, s * 0.07, 0.2, 0.012, 0.15, 0xdbe6ee, { ry: s * 0.45 });
  const g = b.build();
  g.rotateX(-Math.PI / 2);
  topLight(g);
  return g;
}

/**
 * Bake a top-down shade into the vertex colours. The tank's material is unlit (`MeshBasicMaterial`),
 * because the room has no sun and adding a real light here is the one thing this casino must not do;
 * without this the fish are flat silhouettes of colour. Scaling albedo by the normal's y gives the
 * same read as a hood lamp overhead for the cost of one pass at build time.
 */
function topLight(g: THREE.BufferGeometry): void {
  const n = g.attributes.normal, c = g.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < c.count; i++) {
    const k = 0.6 + 0.5 * (0.5 + 0.5 * n.getY(i));
    c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
  }
}

export function buildAquarium(group: THREE.Object3D, tank: TankBox, y0: number, solid: GeoBatch, neon: GeoBatch, glow: GeoBatch): Aquarium {
  const x0 = tank.u0, x1 = tank.u1, z0 = Zf(tank.v1), z1 = Zf(tank.v0); // z0 < z1
  const zc = (z0 + z1) / 2, len = z1 - z0;
  // The water column. Deliberately tall: from the door you see the tank side-on across the aisle,
  // and a short tank reads as a serving hatch.
  const SILL = y0 + 0.58, BED = y0 + 0.74, LIP = y0 + 2.96, HOOD = y0 + 3.3;

  // ---- the cabinet it stands in, and the stone surround
  solid.span(x0, x1, y0, SILL, z0, z1, 0x182631);
  solid.span(x0, x1 + 0.06, SILL - 0.1, SILL, z0 - 0.06, z1 + 0.06, 0x2a1d12); // a dark timber nosing
  solid.span(x1 - 0.02, x1 + 0.06, y0 + 0.06, SILL - 0.12, z0 - 0.04, z1 + 0.04, GOLD); // kick rail
  // ---- the inside: gravel, a dark back glass, rockwork.
  // Every colour here is HALVED against what it should look like: the interior's `solid` batch is
  // `new GeoBatch(false, 2.0)`, which doubles albedo to stand in for a room the sun never reaches.
  // The first capture put reef-coloured coral in at face value and it came out chalk white.
  solid.span(x0 + 0.06, x1 - 0.12, SILL, BED, z0 + 0.06, z1 - 0.06, 0x6a6049);
  // the back panel sits 8 cm off the wall: the wall's own gold dado is drawn at x0+0.03..x0+0.06 and
  // co-planar faces z-fight through the polygon offset the solid material already uses
  solid.span(x0 + 0.08, x0 + 0.12, BED - 0.1, LIP, z0 + 0.04, z1 - 0.04, 0x05202f);
  solid.span(x0 + 0.12, x1 - 0.12, LIP, LIP + 0.04, z0 + 0.04, z1 - 0.04, 0x07293a); // the surface, seen from below
  for (const s of [0, 1]) solid.span(x0 + 0.06, x1 - 0.1, BED - 0.1, LIP, s ? z1 - 0.1 : z0 + 0.04, s ? z1 - 0.04 : z0 + 0.1, 0x0a3346); // end glass, smoked
  // rockwork and weed: three cairns on the gravel with stands of turtle grass between them, tall
  // enough to break the empty middle of the tank (at 0.5 m they sat in a band along the bottom)
  for (let k = 0; k < 3; k++) {
    const z = z0 + len * (0.18 + k * 0.31), x = x0 + 0.42 + (k % 2) * 0.2;
    solid.ball(x, BED + 0.08, z, 0.32, k % 2 ? 0x4a4034 : 0x3c4a47, 0.7, 8);
    solid.ball(x + 0.2, BED + 0.04, z - 0.46, 0.22, 0x52473a, 0.7, 7);
    solid.ball(x - 0.12, BED + 0.06, z + 0.4, 0.18, 0x3c4a47, 0.8, 7);
    for (let j = 0; j < 6; j++) {
      const lean = (j - 2.5) * 0.1;
      solid.cyl(x + 0.16 - (j % 3) * 0.08, BED + 0.06, z + (j - 2.5) * 0.22, 0.01, 0.038, 0.8 + 0.4 * ((j * 5 + k) % 3), j % 2 ? 0x2d7a4c : 0x256e5e, 5, { rz: lean, rx: lean * 0.6 });
    }
    // a staghorn, which is the one thing in here that also grows out on the reef. The branches lean
    // 0.4 rad, not 0.7: at 0.7 the trunk vanished behind them and the whole thing read as a letter X.
    solid.cyl(x + 0.3, BED + 0.04, z + 0.1, 0.05, 0.1, 0.5, 0x9c5a42, 6);
    for (const a of [-0.4, 0.4]) solid.cyl(x + 0.3, BED + 0.36, z + 0.1, 0.022, 0.05, 0.34, 0xb06a50, 5, { rz: a });
  }
  // ---- the gold frame on the glass: a rail top and bottom, a mullion every 1.6 m
  solid.span(x1 - 0.12, x1 + 0.03, BED - 0.14, BED - 0.02, z0, z1, GOLD);
  solid.span(x1 - 0.12, x1 + 0.03, LIP + 0.02, LIP + 0.16, z0, z1, GOLD);
  for (let k = 0; k <= 4; k++) {
    const z = z0 + (len * k) / 4;
    solid.span(x1 - 0.1, x1 + 0.03, BED - 0.02, LIP + 0.02, z - 0.055, z + 0.055, GOLD);
  }
  // ---- the hood, and the lamp inside it (unlit geometry, never a PointLight)
  solid.span(x0, x1 + 0.1, LIP + 0.16, HOOD, z0 - 0.06, z1 + 0.06, 0x12394a);
  solid.span(x0, x1 + 0.12, HOOD - 0.07, HOOD, z0 - 0.08, z1 + 0.08, GOLD);
  neon.span(x0 + 0.18, x1 - 0.2, LIP + 0.1, LIP + 0.15, z0 + 0.1, z1 - 0.1, 0xdff4ff);
  // ---- what the tank throws into the room: a pool on the carpet, and a glare off the water's
  // surface where the hood lamp is. (Halos the height of the glass were tried first and read as four
  // glowing portals hanging in the water — the tank is already a lit panel, it does not need haloing.)
  glow.pool(x1 + 1.5, y0 + 0.05, zc, 4.6, 0x35e0ff);
  for (let k = 0; k < 5; k++) glow.halo(x1 - 0.5, LIP - 0.12, z0 + len * (0.1 + k * 0.2), 0.6, 0x9ad8ff);

  // ---- the fish
  const FISH = 14;
  const xi0 = x0 + 0.26, xi1 = x1 - 0.22;      // the swimmable depth: 0.92 m between the rockwork and the glass
  const zi0 = z0 + 0.5, zi1 = z1 - 0.5;
  const yi0 = BED + 0.22, yi1 = LIP - 0.2;
  const rnd = mulberry(0x9e3779b9);
  const fish: Fish[] = [];
  for (let i = 0; i < FISH; i++) {
    const rz = 0.9 + rnd() * (len / 2 - 1.1);
    const rx = 0.1 + rnd() * 0.26;
    const vamp = 0.08 + rnd() * 0.3;
    const y = yi0 + vamp + rnd() * (yi1 - yi0 - 2 * vamp);
    fish.push({
      cx: (xi0 + xi1) / 2 + (rnd() - 0.5) * ((xi1 - xi0) / 2 - 2 * rx),
      rx,
      cz: zi0 + rz + rnd() * (zi1 - zi0 - 2 * rz),
      rz,
      y, vamp, vw: 0.25 + rnd() * 0.6,
      w: (0.2 + rnd() * 0.3) * (rnd() < 0.5 ? -1 : 1),
      ph: rnd() * Math.PI * 2, xph: rnd() * Math.PI * 2, vph: rnd() * Math.PI * 2,
      len: 0.16 + rnd() * 0.26,
      beat: 5 + rnd() * 5,
      color: COLORS[i % COLORS.length],
    });
  }

  const bodyGeo = fishBody(), tailGeo = fishTail();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const bodies = new THREE.InstancedMesh(bodyGeo, mat, FISH);
  const tails = new THREE.InstancedMesh(tailGeo, mat, FISH);
  const c = new THREE.Color();
  fish.forEach((f, i) => { c.setHex(f.color); bodies.setColorAt(i, c); tails.setColorAt(i, c); });
  // One sphere over the whole tank: without it three.js culls by the unit fish model at the origin,
  // which is 23 m away, so the tank would be empty until the camera happened to frame the town centre.
  const sphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, (BED + LIP) / 2, zc), len / 2 + 1);
  bodies.boundingSphere = sphere; tails.boundingSphere = sphere.clone();
  for (const m of [bodies, tails]) { m.castShadow = false; m.receiveShadow = false; m.renderOrder = 1; }
  // named so test/capture-casino-aquarium.mjs can toggle the three new draw calls and report the delta
  bodies.name = 'aquarium-fish'; tails.name = 'aquarium-tails';

  // the glass: additive and barely there, so it reads as a sheen on the pane rather than a wall of
  // blue, and so it needs no depth sorting against the fish behind it
  const paneGeo = new THREE.PlaneGeometry(len + 0.1, LIP - BED + 0.1).rotateY(Math.PI / 2);
  const paneMat = new THREE.MeshBasicMaterial({ color: 0x4fc8ff, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const pane = new THREE.Mesh(paneGeo, paneMat);
  pane.position.set(x1 - 0.04, (BED + LIP) / 2, zc);
  pane.renderOrder = 3;
  pane.name = 'aquarium-glass';

  group.add(bodies, tails, pane);

  const dummy = new THREE.Object3D();
  const _m = new THREE.Matrix4();

  /** Where fish `f` is at time `t`, and which way it is pointing. Closed form, so `bank` below can
   * just ask again a moment later instead of keeping per-fish state. */
  const sample = (f: Fish, t: number, out: THREE.Vector3): number => {
    const a = f.w * t + f.ph;
    out.set(f.cx + f.rx * Math.sin(2 * a + f.xph), f.y + f.vamp * Math.sin(f.vw * t + f.vph), f.cz + f.rz * Math.sin(a));
    const dx = 2 * f.rx * Math.cos(2 * a + f.xph) * f.w, dz = f.rz * Math.cos(a) * f.w;
    return Math.atan2(-dz, dx); // the model's nose is +x
  };

  const api: Aquarium = {
    get tris() { return bodyGeo.index!.count / 3 * FISH + tailGeo.index!.count / 3 * FISH + 2; },
    update(t): void {
      for (let i = 0; i < FISH; i++) {
        const f = fish[i];
        const yaw = sample(f, t, dummy.position);
        // bank and pitch from the path itself: re-sample a third of a second on and difference it.
        // Cheaper than it looks (six trig calls) and it means a fish leans into the bend of the
        // figure-of-eight without a single stored variable.
        const y0s = dummy.position.y;
        const yaw2 = sample(f, t + 0.3, _v3);
        let d = yaw2 - yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        dummy.rotation.set(Math.max(-0.7, Math.min(0.7, -d * 1.6)), yaw, Math.max(-0.5, Math.min(0.5, (_v3.y - y0s) * 2.2)), 'YXZ');
        dummy.scale.setScalar(f.len);
        dummy.updateMatrix();
        bodies.setMatrixAt(i, dummy.matrix);
        // The tail is a second instance hinged at the peduncle: body matrix, then a step back along
        // the body's own -x to the hinge, then the wag. Amplitude rises with how fast this fish is
        // going round the loop, so a fish cruising the long side beats harder than one turning.
        const sw = Math.sin(t * f.beat + f.ph) * (0.3 + 0.35 * Math.abs(Math.cos(f.w * t + f.ph)));
        _m.copy(dummy.matrix).multiply(_HINGE.makeTranslation(-0.33, 0, 0)).multiply(_WAG.makeRotationY(sw));
        tails.setMatrixAt(i, _m);
      }
      bodies.instanceMatrix.needsUpdate = true;
      tails.instanceMatrix.needsUpdate = true;
    },
    dispose(): void {
      bodyGeo.dispose(); tailGeo.dispose(); paneGeo.dispose();
      mat.dispose(); paneMat.dispose();
      bodies.dispose(); tails.dispose();
    },
  };
  // Pose them once at build time. An InstancedMesh starts with identity matrices, and `update` only
  // runs once the player is in the room (casino-interior.ts), so without this the room spends its
  // first seconds of existence with fourteen one-metre fish stacked at the town's own origin — down
  // on the harbour, 150 m away, inside the tank's bounding sphere as far as the frustum is concerned.
  api.update(0);
  return api;
}

const _v3 = new THREE.Vector3();
const _HINGE = new THREE.Matrix4();
const _WAG = new THREE.Matrix4();
