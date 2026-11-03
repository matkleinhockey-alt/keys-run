/**
 * First-person rod view model (legacy index.html:2825-2865, "Fishing Planet style"): a jointed
 * rod rendered in camera space, bending under tension and whipping on a cast.
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math.js';
import { F } from './state.js';
import { aimFlex, applyFlex, bendTarget, createFlex, kickFlex, lineTarget, recoilFlex, stepFlex, worldRodFor } from './rod-bend.js';

export interface RodViewModel {
  group: THREE.Group;
  tip: THREE.Object3D;
  /** `model` is the third-person rod — the boat's, or the one in the walker's hands ashore
   * (shore-rod.ts) — flexed by the same solver. */
  update(dt: number, fpOn: boolean, reeling: boolean, actionHeld: boolean, model?: RodHolder): void;
  whip(): void;
  /** A transient load hit the line (bolt, head shake, jump landing): tip yanks down. */
  kick(mag: number): void;
  /** The load just vanished (hook pulled, line parted): tip whips back past straight. */
  recoil(load: number): void;
  /** Where the line is tied: the first-person tip, or the third-person rod's *flexing* tip. */
  lineTip(model: RodHolder, fpOn: boolean): THREE.Object3D;
}

/** Anything carrying a third-person rod: the boat model, or the walker's shore rod. */
export interface RodHolder { rodPivot: THREE.Group }

export function createRodViewModel(camera: THREE.Camera): RodViewModel {
  const group = new THREE.Group();
  group.visible = false;
  camera.add(group);

  const base = new THREE.Group();
  base.position.set(0.3, -0.42, -0.55);
  base.rotation.set(-1.15, 0.16, 0, 'YXZ');
  group.add(base);

  const segs: THREE.Group[] = [];
  let tip: THREE.Object3D;
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x1d2126, roughness: 0.3, metalness: 0.3 });
  const SEGL = 0.52;
  /*
   * BUILT TO A REAL BLANK'S DIMENSIONS.
   *
   * A 7 ft medium spinning blank measures .454-.544 inch at the butt and a size-5 tip: 11.5-13.8
   * mm down to about 2 mm (CRB IS701M, MHX SJ843). This was 44 mm at the butt and 8 mm at the
   * tip — three to four times over — on eight radial segments, so the thing in your hands was a
   * fat octagonal stick. A real rod is a fine line that tapers away to nothing, and that is most
   * of what makes one look like a rod rather than a prop.
   */
  const BUTT_R = 0.0065, TIP_R = 0.001;             // 13 mm -> 2 mm
  const rAt = (u: number): number => BUTT_R + (TIP_R - BUTT_R) * u;
  let parent: THREE.Object3D = base;
  for (let i = 0; i < 5; i++) {
    const sg = new THREE.Group();
    if (i > 0) sg.position.y = SEGL;
    parent.add(sg);
    const r0 = rAt(i / 5), r1 = rAt((i + 1) / 5);
    // 14 sides, not 8: at a third of a metre from the lens an octagon reads as an octagon, and
    // the blank is now thin enough that the extra triangles are nothing.
    sg.add(new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, SEGL, 14).translate(0, SEGL / 2, 0), rodMat));
    segs.push(sg);
    parent = sg;
  }

  /*
   * Guides: eight of them, closing up toward the tip, standing clear of the blank.
   *
   * There were four, one at the base of each segment, evenly spaced and all the same size — and
   * each ring was SMALLER than the blank it sat on (ring outer 0.019 against a 0.0186 blank), so
   * they were buried in the rod rather than mounted on it. The wire was a 4-segment torus, which
   * is to say square. A real rod's guides run large at the stripper and shrink to the tip, spaced
   * tighter as they go, each held off the blank on a foot — that run of shrinking rings is the
   * rod's most recognisable detail after the taper itself.
   */
  const guideMat = new THREE.MeshStandardMaterial({ color: 0xc9ced3, metalness: 0.85, roughness: 0.18 });
  const wrapMat = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.55 });
  // [segment, local y along that segment] — two per segment past the stripper, so spacing in
  // world terms tightens as the segments themselves carry less rod.
  const GUIDES: Array<[number, number]> = [
    [0, 0.46], [1, 0.22], [1, 0.46], [2, 0.20], [2, 0.44], [3, 0.18], [3, 0.42], [4, 0.24],
  ];
  for (const [si, ly] of GUIDES) {
    const u = (si + ly / SEGL) / 5;
    const blank = rAt(u);
    // The ring shrinks with the blank but never below something a line could pass through.
    const ring = Math.max(0.0035, 0.016 * (1 - u) + 0.003);
    const wire = 0.0011;
    const stand = blank + ring + 0.0015;            // ring centre, clear of the blank
    const g = new THREE.Mesh(new THREE.TorusGeometry(ring, wire, 8, 16), guideMat);
    g.position.set(0, ly, -stand);
    sg_add(si, g);
    // the foot and its thread wrap, which is what actually holds a guide on
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(wire, wire, stand - blank, 6).rotateX(Math.PI / 2), guideMat);
    foot.position.set(0, ly - ring * 0.5, -(blank + (stand - blank) / 2));
    sg_add(si, foot);
    const wrap = new THREE.Mesh(new THREE.CylinderGeometry(blank * 1.25, blank * 1.25, 0.012, 10), wrapMat);
    wrap.position.set(0, ly - ring * 0.5 - 0.008, 0);
    sg_add(si, wrap);
  }
  function sg_add(i: number, m: THREE.Object3D): void { segs[i].add(m); }
  tip = new THREE.Object3D();
  tip.position.y = SEGL;
  parent.add(tip);

  const s0 = segs[0];
  const cork = new THREE.MeshStandardMaterial({ color: 0xb8925e, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.35, metalness: 0.5 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.25, metalness: 0.8 });
  // 25 mm of cork, not 60. A spinning rod's grip is something you close a hand around; this was
  // wider than the reel's own spool.
  s0.add(new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0135, 0.34, 16).translate(0, 0.12, 0), cork));

  const reel = new THREE.Group();
  reel.name = 'reel';
  reel.position.set(0, 0.3, -0.075);
  s0.add(reel);
  // A spinning reel, built to its real anatomy. It used to be two plain cylinders and a stick:
  // a bare gold drum standing on a dark barrel, with no bail, no line on it and no drag. The bail
  // is the one shape that says "spinning reel" at a glance, and its absence was most of why this
  // read as a lump rather than a reel. The rod runs along +Y with the tip at +Y, so the spool sits
  // forward of the gearbox, which is where it belongs.
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9c0c7, metalness: 0.85, roughness: 0.22 });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.75, metalness: 0.05 });
  // Foot and stem: what actually clamps to the blank.
  reel.add(new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.012, 0.06).translate(0, 0, 0.035), dark));
  reel.add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 20), dark));
  // Rotor cup around the base of the spool, with the arm that carries the bail.
  const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.043, 0.028, 20), dark);
  rotor.position.y = 0.05;
  reel.add(rotor);
  // Spool: two flanges with the line pack between them, not a solid drum.
  const spool = new THREE.Group();
  spool.position.y = 0.065;
  reel.add(spool);
  spool.add(new THREE.Mesh(new THREE.CylinderGeometry(0.0445, 0.0445, 0.005, 20).translate(0, -0.024, 0), gold));
  spool.add(new THREE.Mesh(new THREE.CylinderGeometry(0.0445, 0.0445, 0.005, 20).translate(0, 0.024, 0), gold));
  spool.add(new THREE.Mesh(new THREE.CylinderGeometry(0.0395, 0.0395, 0.043, 20), lineMat));
  // Front drag knob — the stack of thumb-wheels on top of a front-drag reel.
  spool.add(new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.022, 0.012, 14).translate(0, 0.032, 0), gold));
  spool.add(new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.008, 12).translate(0, 0.041, 0), dark));
  // The bail: a wire hoop arcing over the front of the spool, with the line roller at one end.
  // A half-torus in the XY plane arcs over +Y, which is exactly the path a real bail takes.
  // Radius clears the 0.0445 flange: at 0.05 the hoop grazed through the spool instead of arcing
  // over it, which is the one thing a bail must visibly do.
  const bail = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.0032, 6, 20, Math.PI), steel);
  bail.position.y = 0.072;
  reel.add(bail);
  const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0068, 0.012, 10), steel);
  roller.rotation.z = Math.PI / 2;
  roller.position.set(0.058, 0.072, 0);
  reel.add(roller);
  const handle = new THREE.Group();
  handle.position.set(0.055, 0, 0);
  reel.add(handle);
  handle.add(new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.1, 0.012).translate(0, 0.05, 0), dark));
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.04, 8), dark);
  knob.rotation.z = Math.PI / 2;
  knob.position.set(0.02, 0.1, 0);
  handle.add(knob);

  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a27f, roughness: 0.6, flatShading: true });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x9cc8e0, roughness: 0.8, flatShading: true });
  const gripHand = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.11, 0.1), skin);
  gripHand.position.set(0, 0.38, -0.02);
  s0.add(gripHand);
  const cuff1 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.45, 8), sleeve);
  cuff1.position.set(0.02, 0.3, -0.2);
  cuff1.rotation.x = 1.1;
  s0.add(cuff1);
  const crankHand = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.075), skin);
  crankHand.position.set(0.045, 0.1, 0);
  handle.add(crankHand);
  const cuff2 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.4, 8), sleeve);
  cuff2.position.set(0.16, 0.16, -0.22);
  cuff2.rotation.set(0.9, 0, -0.5);
  s0.add(cuff2);

  let whipT = 0;
  const flex = createFlex();
  const aim = new THREE.Vector3();
  let lift = 0;
  let worldFlex: ReturnType<typeof createFlex> | null = null;

  function update(dt: number, fpOn: boolean, reeling: boolean, actionHeld: boolean, model?: RodHolder): void {
    // The third-person rod flexes whether or not the camera is first-person: it is what you see from
    // the boat camera, and a kick landing while the view is toggled must not be lost.
    if (model) {
      const wr = worldRodFor(model);
      worldFlex = wr.flex;
      lineTarget(aim);
      aimFlex(wr.flex, model.rodPivot, aim.x, aim.y, aim.z, dt);
      stepFlex(wr.flex, dt, bendTarget(wr.flex));
      applyFlex(wr.segs, wr.flex, wr.weights);
    }
    group.visible = fpOn;
    if (!fpOn) return;
    lineTarget(aim);
    aimFlex(flex, base, aim.x, aim.y, aim.z, dt);
    stepFlex(flex, dt, bendTarget(flex));
    applyFlex(segs, flex);
    const fight = F.state === 'fight' ? F.fight : null;
    // Pumping: under load with the handle still, the rod is held up and leans on the fish; when the
    // handle turns the tip drops to take in line. Alternating the two is the pump-and-wind.
    const liftTarget = fight ? (reeling || actionHeld ? 0 : clamp(fight.tension, 0, 1) * 0.3) : 0;
    lift = lerp(lift, liftTarget, Math.min(1, dt * 6));
    let rx = -1.15 - lift + (F.charging ? F.charge * 0.7 : 0);
    if (whipT > 0) {
      whipT = Math.max(0, whipT - dt / 0.35);
      rx -= 0.45 * Math.sin(whipT * Math.PI);
    }
    base.rotation.x = lerp(base.rotation.x, rx, Math.min(1, dt * 14));
    base.rotation.y = lerp(base.rotation.y, 0.16 + (fight ? flex.ux * 0.12 * clamp(fight.tension, 0, 1) : 0), Math.min(1, dt * 8));
    if (reeling || (F.state === 'fight' && actionHeld)) handle.rotation.x -= dt * 22;
  }

  return {
    group, tip, update, whip: () => { whipT = 1; },
    kick: (mag) => { kickFlex(flex, mag); if (worldFlex) kickFlex(worldFlex, mag); },
    recoil: (load) => { recoilFlex(flex, load); if (worldFlex) recoilFlex(worldFlex, load); },
    lineTip: (model, fpOn) => (fpOn ? tip : worldRodFor(model).tip),
  };
}
