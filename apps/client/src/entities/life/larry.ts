/**
 * Larry's POS: a plywood deck on three oil drums, a sagging tent, and a motor the size of a
 * kettle.
 *
 * Every other hull out here is somebody's boat. This is not a boat. It is a raft a man built
 * out of what was behind the marina, and the joke only works if the construction is legible:
 * three blue drums lashed under mismatched decking, a tent that has lost a pole, a jerry can,
 * a bucket, a rod in a milk crate, and a 2 hp outboard clamped to a scrap of two-by-ten doing
 * about two knots flat out. He is going somewhere. He will get there eventually.
 *
 * ## Why he is not always there
 *
 * A fixture stops being funny the second time you pass it. Larry is out only during some
 * wall-clock windows and on one of a handful of slow drift loops, both hashed off the clock
 * period the way the sandbar party picks its bar — so he is a thing you come across rather than
 * a landmark, and so two players out at the same time see him in the same place. He only ever
 * appears, disappears or changes loop while nobody is near enough to watch it happen.
 *
 * ## The physics
 *
 * A raft is the one thing on this water that genuinely does follow the surface: no freeboard, no
 * ballast, no deadrise. So where the working boats damp their roll, Larry gets the wave slope
 * slightly EXAGGERATED and takes it on both axes. It wallows, and it should.
 */
import * as THREE from 'three';
import { createPath, angLerp, type Path } from './path.js';
import { depthAt, landH } from '@keysrun/shared/world/depth';
import { chainZ, shoreInfo } from '@keysrun/shared/world/chain';
import { waveHBase } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { createHumanRegistry } from './human.js';
import { hashCell } from '@keysrun/shared/rng';
import { WORLD_SEED, SALT } from '../../state/constants.js';
import { toast } from '../../ui/toast.js';

/** Flat out, m/s. About two knots — a 2 hp kicker pushing a barn door. */
const SPEED = 1.05;
/** Rendered inside this; he is small and low and there is no point drawing him at a mile. */
const SHOW_M = 1100;
/** How close you have to be before he notices you. */
const SAY_M = 130;
/** ...and how long before he says it again. He is not in a hurry. */
const SAY_COOLDOWN_S = 26;
/** One roll of the dice per window of real time. */
const WINDOW_MS = 11 * 60 * 1000;
/** ...and this is how often it comes up Larry. */
const OUT_CHANCE = 0.42;
/** The only thing he has ever said. */
const LINE = 'yeahhhhh dude';

/** Deck plan, metres. Three drums wide, a bit longer than it is broad. */
const DECK_W = 3.0, DECK_L = 3.4, DECK_Y = 0.36;

export interface Larry {
  group: THREE.Group;
  update(dt: number, t: number, camera: THREE.PerspectiveCamera, viewport: { w: number; h: number }): void;
  /** VERIFICATION ONLY. */
  debug(): { out: boolean; route: number; x: number; z: number; visible: boolean; depth: number; speedKn: number; s: number; total: number };
  dispose(): void;
}

/** Wanted at every sample point. Well over what the raft needs, on purpose — see `driftLoop`. */
const LOOP_DEPTH_M = 1.8;
/**
 * What the raft actually draws. A deck on three drums sits about a hand's width in the water,
 * which is the one real advantage Larry has over everybody else out here: his loops run through
 * skinny water that would have your boat off the plane and sounding the alarm.
 */
export const RAFT_DRAFT_M = 0.25;

/**
 * A slow loop of open water, squashed into an oval so he is not visibly going round in a circle.
 *
 * Each bearing is pushed in or out to find water rather than dropped. Dropping was the first
 * version and it is wrong in a way that only shows up once you run the path: the route is a
 * polyline through the surviving points, so taking a bite out of one side leaves a long straight
 * leg running right across the shallow the drop was supposed to avoid. Measured 0.63 m on a loop
 * whose every sample point cleared 1.3 m.
 *
 * So the margin is deliberate too. Sample points are held to `LOOP_DEPTH_M`, which is more water
 * than a raft on three drums could possibly want, and the slack is what the spline spends
 * rounding off the corners between them.
 */
export function driftLoop(cx: number, cz: number, r: number): Path {
  const ok = (x: number, z: number): boolean =>
    depthAt(x, z) >= LOOP_DEPTH_M && landH(x, z) <= 0.02 && shoreInfo(x, z).d >= 70;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a) * 0.62;
    // Nominal radius first, then alternately further out and further in, so the loop keeps its
    // shape where it can and only deforms where the bottom makes it.
    for (const k of [1, 1.12, 0.88, 1.26, 0.76, 1.4, 0.64, 0.52]) {
      const x = cx + ca * r * k, z = cz + sa * r * k;
      if (!ok(x, z)) continue;
      pts.push([x, z]);
      break;
    }
  }
  return createPath(pts);
}

/** Where he putters. Bay side and the near flats — nobody takes a raft into the Straits. */
export const LARRY_LOOPS: ReadonlyArray<readonly [number, number, number]> = [
  [-2400, chainZ(-2400) - 700, 520],
  [-900, chainZ(-900) - 820, 460],
  [700, chainZ(700) - 760, 540],
  [2300, chainZ(2300) - 640, 480],
  [1500, chainZ(1500) + 700, 430],
];

/** Is Larry out at this moment, and if so on which loop? */
export function larryAt(wallMs: number, loops: number): { out: boolean; route: number } {
  const w = Math.floor(wallMs / WINDOW_MS);
  const out = hashCell(WORLD_SEED, w, 11, SALT.LARRY_OUT) < OUT_CHANCE;
  const route = Math.min(loops - 1, Math.floor(hashCell(WORLD_SEED, w, 12, SALT.LARRY_ROUTE) * loops));
  return { out, route };
}

export function createLarry(scene: THREE.Scene): Larry {
  const group = new THREE.Group();
  group.name = 'larry';
  group.visible = false;
  scene.add(group);

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };
  const M = (c: number, rough = 0.92, flat = true): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: rough, flatShading: flat });
    mats.push(m);
    return m;
  };
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, ry = 0): THREE.Mesh => {
    const me = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), m);
    me.position.set(x, y, z); me.rotation.y = ry;
    group.add(me);
    return me;
  };

  const drumBlue = M(0x2f6fa8, 0.78);
  const ply = M(0xb08d5c), plyDark = M(0x8a6c45), plyGrey = M(0x9aa09b);
  const rope = M(0xcdbd96, 0.98);
  const rust = M(0x7a4a2e, 0.95);

  // ---- three drums under it, athwartships. The whole raft reads from these: you can see what
  // it is floating on, which is the entire gag.
  for (let i = 0; i < 3; i++) {
    const d = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.29, 0.29, DECK_W - 0.1, 12)), drumBlue);
    d.rotation.z = Math.PI / 2;
    d.position.set(0, 0.03, -1.15 + i * 1.15);
    group.add(d);
    // Rolling hoops, so it is a drum and not a pipe.
    for (const o of [-0.55, 0.55]) {
      const h = new THREE.Mesh(keep(new THREE.TorusGeometry(0.3, 0.025, 5, 12)), rust);
      h.rotation.y = Math.PI / 2;
      h.position.set(o, 0.03, -1.15 + i * 1.15);
      group.add(h);
    }
  }

  // ---- decking: boards of three different widths and three different greys, because he used
  // what was there.
  let zc = -DECK_L / 2;
  const WID = [0.42, 0.3, 0.37, 0.26, 0.45, 0.33, 0.4, 0.3, 0.38, 0.29];
  for (let i = 0; zc < DECK_L / 2 - 0.02; i++) {
    const w = Math.min(WID[i % WID.length], DECK_L / 2 - zc);
    const b = box(DECK_W, 0.06, w - 0.015, [ply, plyDark, plyGrey][i % 3], 0, DECK_Y, zc + w / 2);
    b.rotation.x = (i % 3 === 1 ? 0.012 : -0.008); // not one of them is flat
    zc += w;
  }
  // Two stringers across the drums, and the lashings over the top of everything.
  box(0.1, 0.09, DECK_L, plyDark, -1.2, DECK_Y - 0.07, 0);
  box(0.1, 0.09, DECK_L, plyDark, 1.2, DECK_Y - 0.07, 0);
  for (const z of [-1.15, 0, 1.15]) {
    const l = new THREE.Mesh(keep(new THREE.TorusGeometry(0.36, 0.022, 5, 16)), rope);
    l.rotation.y = Math.PI / 2;
    l.position.set(0.6, 0.12, z);
    group.add(l);
  }

  // ---- the tent, which has lost a pole.
  const tentG = keep(new THREE.SphereGeometry(0.95, 14, 9, 0, Math.PI * 2, 0, Math.PI / 2));
  {
    const pos = tentG.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      // Taller than a hemisphere, then the whole port-forward quarter pulled down: one pole gone
      // and the fly dropped onto whatever is underneath it.
      const sag = Math.max(0, -x / 0.95) * Math.max(0, (z + 0.3) / 1.25);
      pos.setXYZ(i, x * 1.05, y * (1.18 - 0.72 * sag), z * 1.05);
    }
    tentG.computeVertexNormals();
  }
  const tentM = new THREE.MeshStandardMaterial({ color: 0xcf7a3c, roughness: 0.95, flatShading: true, side: THREE.DoubleSide });
  mats.push(tentM);
  const tent = new THREE.Mesh(tentG, tentM);
  tent.position.set(-0.1, DECK_Y + 0.03, -0.55);
  group.add(tent);
  // The door, unzipped and hanging open.
  const door = new THREE.Mesh(keep(new THREE.CircleGeometry(0.42, 10, 0, Math.PI)), M(0x241c16, 1, false));
  door.position.set(0.1, DECK_Y + 0.04, 0.36);
  door.rotation.set(0, 0.22, 0);
  group.add(door);
  // The pole that gave up, still poking out of the sagging corner.
  const pole = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.018, 0.018, 1.1, 5)), M(0x5e6166, 0.5));
  pole.position.set(-0.92, DECK_Y + 0.3, -0.5);
  pole.rotation.set(0.5, 0, 0.95);
  group.add(pole);
  // A blue tarp patch over the hole, because of course there is one.
  const patch = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.62, 0.5)), M(0x3f72b0, 1, false));
  patch.position.set(-0.68, DECK_Y + 0.42, -0.62);
  patch.rotation.set(-0.9, 0.5, 0.3);
  (patch.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  group.add(patch);

  // ---- the motor. A 2 hp kicker on a bolted-on scrap of two-by-ten, tiller to port.
  box(0.5, 0.11, 0.09, plyDark, 0, DECK_Y + 0.08, DECK_L / 2 - 0.02);
  const mg = new THREE.Group();
  mg.position.set(0.12, DECK_Y + 0.12, DECK_L / 2 + 0.02);
  mg.rotation.x = -0.14;
  group.add(mg);
  const cowl = new THREE.Mesh(keep(new THREE.BoxGeometry(0.23, 0.26, 0.3)), M(0x9c2f28, 0.6));
  cowl.position.y = 0.08; mg.add(cowl);
  const shaft = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.045, 0.045, 0.62, 7)), M(0xd9dde0, 0.5));
  shaft.position.y = -0.32; mg.add(shaft);
  const skeg = new THREE.Mesh(keep(new THREE.BoxGeometry(0.05, 0.14, 0.26)), M(0xd9dde0, 0.5));
  skeg.position.set(0, -0.6, 0.02); mg.add(skeg);
  const prop = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.01, 0.01, 0.11, 5)), M(0x8d9298, 0.4));
  prop.rotation.x = Math.PI / 2; prop.position.set(0, -0.6, 0.16); mg.add(prop);
  for (let i = 0; i < 3; i++) {
    const bl = new THREE.Mesh(keep(new THREE.BoxGeometry(0.02, 0.1, 0.05)), M(0x8d9298, 0.4));
    bl.position.set(0, -0.6, 0.19);
    bl.rotation.z = (i / 3) * Math.PI * 2;
    bl.position.add(new THREE.Vector3(Math.sin((i / 3) * Math.PI * 2) * 0.05, Math.cos((i / 3) * Math.PI * 2) * 0.05, 0));
    mg.add(bl);
  }
  const tiller = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.022, 0.022, 0.5, 6)), M(0x1f2429, 0.6));
  tiller.rotation.set(0.1, 0, Math.PI / 2 - 0.25);
  tiller.position.set(-0.26, 0.09, -0.12); mg.add(tiller);

  // ---- the rest of his worldly goods.
  box(0.62, 0.36, 0.4, M(0xe3e6e4, 0.7), -0.95, DECK_Y + 0.21, 0.78);          // cooler
  box(0.56, 0.03, 0.34, M(0xcf4b3a, 0.7), -0.95, DECK_Y + 0.4, 0.78);          // ...its lid
  box(0.22, 0.3, 0.16, M(0xc8302c, 0.8), 0.95, DECK_Y + 0.18, -1.05);          // jerry can
  box(0.06, 0.06, 0.06, M(0x2a2f33, 0.6), 0.95, DECK_Y + 0.36, -1.05);         // ...its cap
  const crate = box(0.36, 0.3, 0.36, M(0x2f7d4f, 0.85), 0.78, DECK_Y + 0.18, 0.95);
  crate.rotation.y = 0.3;
  const bucket = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.17, 0.13, 0.3, 10)), M(0xe0a63c, 0.9));
  bucket.position.set(-1.2, DECK_Y + 0.17, -0.1); group.add(bucket);
  // A rod in the crate, pointing nowhere in particular.
  const rod = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.008, 0.016, 2.4, 5)), M(0x23262a, 0.5));
  rod.position.set(0.86, DECK_Y + 0.95, 0.45);
  rod.rotation.set(-0.55, 0.2, 0.18);
  group.add(rod);
  // Empties. There is no version of this raft without empties on the deck.
  for (let i = 0; i < 5; i++) {
    const can = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.033, 0.033, 0.12, 7)), M([0xc0392b, 0xb8bcc0, 0xc0392b, 0x2f6fa8, 0xb8bcc0][i], 0.45));
    can.rotation.z = Math.PI / 2;
    can.rotation.y = i * 1.3;
    can.position.set(-0.4 + i * 0.3, DECK_Y + 0.06, 1.05 - (i % 2) * 0.22);
    group.add(can);
  }
  // A flag on a stick: a pillowcase, really.
  const mast = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.014, 0.014, 1.5, 5)), M(0x6d5a42, 0.9));
  mast.position.set(-1.3, DECK_Y + 0.75, 0.95); group.add(mast);
  const flagM = M(0xdcd6c4, 1, false);
  flagM.side = THREE.DoubleSide;
  const flag = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.5, 0.3, 4, 1)), flagM);
  flag.position.set(-1.05, DECK_Y + 1.3, 0.95);
  group.add(flag);
  const flagPos = flag.geometry.attributes.position as THREE.BufferAttribute;
  const flagX = Array.from({ length: flagPos.count }, (_, i) => flagPos.getX(i));

  // ---- Larry, on the crate with a hand on the tiller.
  const humans = createHumanRegistry();
  const larry = humans.makeHuman({
    pose: 'seated', shirtPattern: 'hawaiian', shirt: 0x2e8b74, shirtAccent: 0xe8d9a0,
    shorts: 0xd8cfae, capStyle: 'bucket', cap: 0xcfc7a8, glasses: true, glassesStyle: 'round',
    shortSleeve: true, hair: 0x6b5435,
  });
  larry.group.position.set(0.78, DECK_Y + 0.33, 0.95);
  larry.group.rotation.y = Math.PI - 0.5;
  group.add(larry.group);

  // ---- the speech bubble, same `.tag` machinery Caelen uses.
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.style.display = 'none';
  document.getElementById('tags')?.appendChild(tag);
  const projV = new THREE.Vector3();

  const loops: Path[] = LARRY_LOOPS.map(([x, z, r]) => driftLoop(x, z, r));
  let st = larryAt(Date.now(), loops.length);
  let s = Math.random() * (loops[st.route]?.total ?? 1);
  let h = 0, bubble = 0, cool = 0, px = 0, pz = 0;

  function update(dt: number, t: number, camera: THREE.PerspectiveCamera, viewport: { w: number; h: number }): void {
    const cx = camera.position.x, cz = camera.position.z;
    const near = Math.hypot(px - cx, pz - cz) < SHOW_M;

    /*
     * Appear, vanish and change loop only out of sight — the same rule the sandbar party follows.
     * A raft that blinks into existence off your bow is a glitch; one you come over the horizon
     * and find is the whole idea.
     */
    if (!near) {
      const want = larryAt(Date.now(), loops.length);
      if (want.out !== st.out || want.route !== st.route) {
        if (want.route !== st.route) s = Math.random() * (loops[want.route]?.total ?? 1);
        st = want;
      }
    }

    if (!st.out) {
      group.visible = false;
      tag.style.display = 'none';
      return;
    }

    const R = loops[st.route];
    if (!R || R.total <= 0) { group.visible = false; tag.style.display = 'none'; return; }
    s += SPEED * dt;
    const P = R.at(s);
    px = P.x; pz = P.z;
    h = angLerp(h, Math.atan2(-P.tx, -P.tz), dt * 0.6);

    const vis = Math.hypot(px - cx, pz - cz) < SHOW_M;
    group.visible = vis;
    if (!vis) { tag.style.display = 'none'; return; }

    /*
     * Four-point wave attitude, but UNDAMPED and then some. The working boats multiply their roll
     * down because a loaded hull resists; a deck on three drums has nothing to resist with, so it
     * takes the full slope on both axes and a little extra.
     */
    const amp = ampAt(px, pz);
    const fx = -Math.sin(h), fz = -Math.cos(h), hl = DECK_L * 0.5, hw = DECK_W * 0.5;
    const hb = waveHBase(px + fx * hl, pz + fz * hl, t, amp);
    const hs = waveHBase(px - fx * hl, pz - fz * hl, t, amp);
    const rx = Math.cos(h), rz = -Math.sin(h);
    const hp = waveHBase(px - rx * hw, pz - rz * hw, t, amp);
    const hst = waveHBase(px + rx * hw, pz + rz * hw, t, amp);
    group.position.set(px, (hb + hs) / 2 - 0.16, pz);
    group.rotation.set(Math.atan2(hb - hs, DECK_L) * 1.25, h, Math.atan2(hp - hst, DECK_W) * 1.25, 'YXZ');

    // The motor is the only thing moving under its own power out here.
    prop.rotation.z += dt * 26;
    mg.rotation.z = Math.sin(t * 7.3) * 0.015;
    // Flag, in whatever breeze there is.
    for (let i = 0; i < flagPos.count; i++) {
      const u = (flagX[i] + 0.25) / 0.5;
      flagPos.setZ(i, Math.sin(t * 3.1 - u * 3.4) * 0.07 * u);
    }
    flagPos.needsUpdate = true;
    humans.updateHumans(t, camera.position, 0);

    // He notices you eventually.
    if (cool > 0) cool -= dt;
    if (bubble > 0) bubble -= dt;
    if (cool <= 0 && Math.hypot(px - cx, pz - cz) < SAY_M) {
      cool = SAY_COOLDOWN_S;
      bubble = 5;
      toast(`\u{1F6F6} Larry: ${LINE}`);
    }

    projV.set(px, group.position.y + 1.9, pz).project(camera);
    const show = projV.z < 1 && Math.hypot(px - cx, pz - cz) < 260;
    tag.style.display = show ? 'block' : 'none';
    if (show) {
      tag.style.left = ((projV.x + 1) / 2 * viewport.w) + 'px';
      tag.style.top = ((1 - projV.y) / 2 * viewport.h) + 'px';
      tag.textContent = bubble > 0 ? `\u{1F6F6} Larry: “${LINE}”` : "\u{1F6F6} Larry's POS";
    }
  }

  return {
    group,
    update,
    debug: () => ({
      out: st.out, route: st.route, x: +px.toFixed(0), z: +pz.toFixed(0),
      visible: group.visible, depth: +depthAt(px, pz).toFixed(2), speedKn: +(SPEED * 1.94384).toFixed(2),
      s: +s.toFixed(1), total: +(loops[st.route]?.total ?? 0).toFixed(0),
    }),
    dispose() {
      tag.remove();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
