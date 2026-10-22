/**
 * The animals of Boot Key Harbor City: street dogs (on leads, loose, tied outside a shop), squirrels
 * up the palms, skunks round the bins at dusk, a cat on a dumpster, and gulls on the rooflines.
 *
 * Where each one is comes from world/town-life.ts (closed-form scripts, tested against the real
 * colliders). This file only dresses them: it picks the right model, steps the gait with distance
 * travelled, and, the part that matters most, decides what NOT to draw.
 *
 * ## Cost
 * No lights, and no animal is built until you could see it:
 *   - dogs   (entities/life/dog.ts, `merge` build: 7 draw calls, shared geometry and material)
 *            built when you come within DOG_BUILD, drawn within DOG_RANGE (80 m), one build per frame.
 *   - squirrels, skunks, the cat (entities/life/critters.ts: 3 meshes each, ONE material for all)
 *            drawn within CRITTER_RANGE (46 m): beyond it a 20 cm animal is under 3 pixels.
 *   - gulls  (entities/life/seabirds.ts, the same bird the sea uses, wings folded) drawn within
 *            GULL_RANGE (110 m): they are big and white and they are what sells a roofline.
 * An animal beyond its range is `visible = false` and is not even posed (the scripts are pure
 * functions of the clock, so nothing needs advancing while it is away). Shadows: the critters
 * cast, nobody receives extra.
 *
 * ## Day and dusk
 * Skunks are `night`: they are out when the sky blend (`todK`) passes 0.3 and gone by 0.12, growing
 * out of nothing over a couple of seconds as they come round the bin rather than popping. The cat
 * sleeps on its lid by day and goes about its business at dusk. A skunk that you walk up to (4 m)
 * turns its head to you and raises its tail; it does not run, because nothing bothers a skunk.
 */
import * as THREE from 'three';
import {
  DOGS, SQUIRRELS, SKUNKS, CATS, GULLS, PEOPLE, DECOR, sample, newPose, leashDog, gullAt, type LifePose, type LifeDog, type Script,
} from '@keysrun/shared/world/town-life';
import { PAD_Y } from '@keysrun/shared/world/town';
import { buildDog, poseDog, DOG_LOOKS, type Parts } from '../life/dog.js';
import { makeCritter, poseSquirrel, poseSkunk, poseCat, placeCritter, type Critter } from '../life/critters.js';
import { makeSeabird, poseBird, moveBird, type Bird } from '../life/seabirds.js';
import { Zf } from './props.js';

export const DOG_RANGE = 80;
export const CRITTER_RANGE = 46;
export const GULL_RANGE = 110;
/** A fox squirrel is ~30 cm of body and a tail as long again; the model is 24 cm, and 1.3 puts it where a grey squirrel is, not a rat. */
const SQUIRREL_SCALE = 1.3;
/** The gull is the sea's own model (a 42 cm body under a 1.25 m span): sat on a roof, 1.4 is a herring gull and reads from across the street. */
const GULL_SCALE = 1.4;

const rotY = (yaw: number): number => Math.atan2(Math.cos(yaw), -Math.sin(yaw));
const angDiff = (a: number, b: number): number => ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
const smooth = (a: number, b: number, k: number): number => a + (b - a) * Math.min(1, k);

export interface Wildlife {
  group: THREE.Group;
  update(t: number, dt: number, cam: { x: number; y: number; z: number }, camLocal: { u: number; v: number }, todK: number): void;
  debug(): { dogs: number; critters: number; gulls: number; built: number; visible: number };
  /** VERIFICATION-ONLY: every animal's current pose (local u, v, height above the pad), drawn or not. */
  where(): Array<{ id: string; u: number; v: number; y: number; stance: string; drawn: boolean }>;
  dispose(): void;
}

interface DogRig { def: LifeDog; parts: Parts | null; pose: LifePose; x: number; z: number; yaw: number; step: number; wag: number; ph: number; init: boolean; lead: THREE.Line | null; owner: Script | null; ownerPose: LifePose }
interface SqRig { id: string; c: Critter | null; script: Script; pose: LifePose; ahead: LifePose; step: number; ph: number }
interface SkRig { id: string; c: Critter | null; script: Script; pose: LifePose; step: number; ph: number; scale: number; yaw: number; init: boolean }
interface CatRig { c: Critter | null; u: number; v: number; y: number; yaw: number; ph: number; scale: number }
interface GullRig { id: string; b: Bird | null; def: typeof GULLS[number]; pose: LifePose & { flap: number }; ph: number }

/** `onGrow` is told when something has been built, so the cascaded-shadow sweep can register its materials. */
export function createWildlife(baseY: number, onGrow?: (g: THREE.Group) => void): Wildlife {
  const group = new THREE.Group();
  group.name = 'townWildlife';
  const owners = new Map(PEOPLE.map((p) => [p.id, p.script]));
  const tie = DECOR.find((d) => d.kind === 'bike-rack' && d.id === 'rack-stopngo');

  const dogs: DogRig[] = DOGS.map((def, i) => ({
    def, parts: null, pose: newPose(), x: 0, z: 0, yaw: 0, step: 0, wag: 0, ph: i * 1.9, init: false, lead: null,
    owner: def.leash ? owners.get(def.leash.owner) ?? null : def.tie ? owners.get(def.tie.owner) ?? null : null, ownerPose: newPose(),
  }));
  const squirrels: SqRig[] = SQUIRRELS.map((s, i) => ({ id: s.id, c: null, script: s.script, pose: newPose(), ahead: newPose(), step: 0, ph: i * 2.1 }));
  const skunks: SkRig[] = SKUNKS.map((s, i) => ({ id: s.id, c: null, script: s.script, pose: newPose(), step: 0, ph: i * 1.3, scale: 0, yaw: 0, init: false }));
  const cats: CatRig[] = CATS.map((c, i) => ({ c: null, u: c.u, v: c.v, y: c.y, yaw: c.yaw, ph: i * 3.1, scale: 1 }));
  const gulls: GullRig[] = GULLS.map((def, i) => ({ id: def.id, b: null, def, pose: { ...newPose(), flap: 0 }, ph: i * 1.1 }));

  let built = 0, shown = 0;
  const leadMat = new THREE.LineBasicMaterial({ color: 0x7a1f1f });
  let budget = 1;

  const near = (u: number, v: number, cu: number, cv: number, r: number): boolean => Math.abs(u - cu) < r && Math.abs(v - cv) < r && Math.hypot(u - cu, v - cv) < r;

  function updateDog(r: DogRig, t: number, dt: number, cu: number, cv: number): void {
    const d = r.def, p = r.pose;
    if (d.leash && r.owner) { sample(r.owner, t, r.ownerPose); leashDog(r.ownerPose, d.leash, p); }
    else if (d.script) sample(d.script, t, p);
    // a tied dog knows its owner: when he walks back out of sight into the shop it settles, when he is near it is beside itself
    let excited = false;
    if (d.tie && r.owner) {
      sample(r.owner, t, r.ownerPose);
      const op = r.ownerPose;
      if (!op.hidden && Math.hypot(op.u - p.u, op.v - p.v) < 9) { excited = true; p.stance = 'wag'; }
    }
    if (p.hidden) { if (r.parts) r.parts.g.visible = false; return; }
    const dist = Math.hypot(p.u - cu, p.v - cv);
    if (dist > DOG_RANGE) { if (r.parts) r.parts.g.visible = false; return; }
    if (!r.parts) {
      if (budget <= 0) return;
      budget--;
      r.parts = buildDog(DOG_LOOKS[d.variant], true).parts;
      group.add(r.parts.g);
      if (d.leash || d.tie) { r.lead = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), leadMat); r.lead.frustumCulled = false; group.add(r.lead); }
      built++; onGrow?.(r.parts.g);
    }
    const g = r.parts.g, look = r.parts.look;
    g.visible = true; shown++;
    const tx = p.u, tz = Zf(p.v);
    if (!r.init) { r.x = tx; r.z = tz; r.yaw = rotY(p.yaw); r.init = true; }
    // follow the script closely; a dog on a lead lags its owner by a few centimetres and cuts a corner, which is the point
    const k = d.leash ? 9 : 40;
    const px = r.x, pz = r.z;
    r.x = smooth(r.x, tx, dt * k); r.z = smooth(r.z, tz, dt * k);
    const mv = Math.hypot(r.x - px, r.z - pz) / Math.max(dt, 1e-3);
    r.yaw += angDiff(r.yaw, mv > 0.15 ? Math.atan2(r.x - px, r.z - pz) : rotY(p.yaw)) * Math.min(1, dt * 6);
    const st = p.stance;
    const moving = mv > 0.12 && (st === 'walk' || st === 'trot' || st === 'run');
    const act = st === 'sniff' ? 'sniff' : st === 'lie' ? 'lie' : (st === 'sit' || st === 'wag' || st === 'groom') ? 'sit' : 'trot';
    r.step += mv * dt * (10 / look.scale ** 0.5);
    r.wag = smooth(r.wag, excited || st === 'wag' ? 1 : moving ? 0.6 : act === 'sit' ? 0.3 : 0.15, dt * 3);
    g.position.set(r.x, baseY, r.z);
    g.rotation.y = r.yaw;
    poseDog(r.parts, { act: act === 'trot' && !moving ? 'sit' : act, trotting: moving, step: r.step, wag: r.wag, excited, lean: 0, t, ph: r.ph });
    if (r.lead) {
      // the lead: from a hand at hip height (owner) or the rack (tied) down to the collar
      const a = r.lead.geometry.attributes.position as THREE.BufferAttribute;
      if (d.leash) a.setXYZ(0, r.ownerPose.u + Math.cos(r.ownerPose.yaw + Math.PI / 2) * 0.25, baseY + 0.95, Zf(r.ownerPose.v + Math.sin(r.ownerPose.yaw + Math.PI / 2) * 0.25));
      else if (tie) a.setXYZ(0, tie.u, baseY + 0.7, Zf(tie.v));
      a.setXYZ(1, r.x, baseY + 0.3 * look.scale, r.z);
      a.needsUpdate = true;
      r.lead.visible = true;
    }
  }

  function updateSquirrel(r: SqRig, t: number, dt: number, cu: number, cv: number): void {
    const p = r.pose;
    sample(r.script, t, p);
    if (!near(p.u, p.v, cu, cv, CRITTER_RANGE)) { if (r.c) r.c.g.visible = false; return; }
    if (!r.c) { if (budget <= 0) return; budget--; r.c = makeCritter('squirrel'); group.add(r.c.g); built++; onGrow?.(r.c.g); }
    r.c.g.visible = true; shown++;
    // up or down the trunk: head the way it is going
    sample(r.script, t + 0.25, r.ahead);
    const dy = r.ahead.y - p.y;
    const onTrunk = p.y > 0.6;
    const climb = onTrunk ? (dy > 0.01 ? 1 : dy < -0.01 ? -1 : 0) : 0;
    const pitch = onTrunk ? (climb >= 0 ? Math.PI / 2 * 0.96 : -Math.PI / 2 * 0.96) : 0;
    r.step += p.speed * dt * 14;
    poseSquirrel(r.c, { stance: p.stance, t, ph: r.ph, step: r.step, speed: p.speed, climb: onTrunk && climb === 0 ? 1 : climb, alarm: 0 });
    // sitting on a trunk (the flick) is still head-up
    placeCritter(r.c, p.u, baseY + p.y, Zf(p.v), rotY(p.yaw), onTrunk ? pitch : 0, SQUIRREL_SCALE);
    if (onTrunk) r.c.g.rotation.set(-pitch, rotY(p.yaw), 0, 'YXZ');
  }

  function updateSkunk(r: SkRig, t: number, dt: number, cu: number, cv: number, todK: number): void {
    // out at dusk, grown from nothing over a couple of seconds; hysteresis so a sky that hovers does not flicker it
    const want = todK > (r.scale > 0.05 ? 0.12 : 0.3) ? 1 : 0;
    r.scale = smooth(r.scale, want, dt * 0.6);
    const p = r.pose;
    sample(r.script, t, p);
    if (r.scale < 0.03 || !near(p.u, p.v, cu, cv, CRITTER_RANGE)) { if (r.c) r.c.g.visible = false; return; }
    if (!r.c) { if (budget <= 0) return; budget--; r.c = makeCritter('skunk'); group.add(r.c.g); built++; onGrow?.(r.c.g); }
    r.c.g.visible = true; shown++;
    const dist = Math.hypot(p.u - cu, p.v - cv);
    const alarm = Math.max(0, 1 - dist / 4.5);
    r.step += p.speed * dt * 9;
    const yaw = rotY(p.yaw);
    if (!r.init) { r.yaw = yaw; r.init = true; }
    r.yaw += angDiff(r.yaw, yaw) * Math.min(1, dt * 3);
    poseSkunk(r.c, { stance: p.stance, t, ph: r.ph, step: r.step, speed: p.speed, climb: 0, alarm });
    // bothered: the head turns to the intruder (it does not turn the body: it is still on its way)
    if (alarm > 0.2) {
      const bearing = Math.atan2(cu - p.u, -(cv - p.v));
      r.c.head.rotation.y = Math.max(-1.1, Math.min(1.1, angDiff(r.yaw, bearing)));
    }
    placeCritter(r.c, p.u, baseY, Zf(p.v), r.yaw, 0, 1.05 * r.scale);
  }

  function updateCat(r: CatRig, t: number, dt: number, cu: number, cv: number, todK: number): void {
    r.scale = smooth(r.scale, todK < 0.35 ? 1 : 0, dt * 0.8);
    if (r.scale < 0.03 || !near(r.u, r.v, cu, cv, CRITTER_RANGE)) { if (r.c) r.c.g.visible = false; return; }
    if (!r.c) { if (budget <= 0) return; budget--; r.c = makeCritter('cat'); group.add(r.c.g); built++; onGrow?.(r.c.g); }
    r.c.g.visible = true; shown++;
    poseCat(r.c, { stance: 'loaf', t, ph: r.ph, step: 0, speed: 0, climb: 0, alarm: 0 });
    placeCritter(r.c, r.u, baseY + r.y, Zf(r.v), rotY(r.yaw), 0, r.scale);
  }

  function updateGull(r: GullRig, t: number, dt: number, cu: number, cv: number): void {
    const p = r.pose;
    gullAt(r.def, t, p);
    if (!near(p.u, p.v, cu, cv, GULL_RANGE)) { if (r.b) r.b.g.visible = false; return; }
    if (!r.b) { if (budget <= 0) return; budget--; r.b = makeSeabird('gull', GULL_SCALE); r.b.g.rotation.order = 'YXZ'; group.add(r.b.g); built++; onGrow?.(r.b.g); }
    r.b.g.visible = true; shown++;
    const flying = p.flap > 0;
    poseBird(r.b, dt, flying ? 1 : 0, flying ? 0 : 1, 10);
    if (flying) moveBird(r.b, p.u, baseY + p.y, Zf(p.v), dt);
    else {
      // perched: sat on the parapet, wings folded, facing the water (or whatever the script says)
      r.b.g.position.set(p.u, baseY + p.y + 0.14 * GULL_SCALE, Zf(p.v));
      r.b.g.rotation.set(0, rotY(p.yaw), 0);
      r.b.yaw = rotY(p.yaw); r.b.px = null; r.b.py = null; r.b.pz = null;
    }
  }

  return {
    group,
    update(t, dt, cam, camLocal, todK): void {
      budget = 1; shown = 0;
      const { u: cu, v: cv } = camLocal;
      for (const r of dogs) updateDog(r, t, dt, cu, cv);
      for (const r of squirrels) updateSquirrel(r, t, dt, cu, cv);
      for (const r of skunks) updateSkunk(r, t, dt, cu, cv, todK);
      for (const r of cats) updateCat(r, t, dt, cu, cv, todK);
      for (const r of gulls) updateGull(r, t, dt, cu, cv);
      void cam;
    },
    debug: () => ({ dogs: dogs.filter((d) => d.parts?.g.visible).length, critters: [...squirrels, ...skunks, ...cats].filter((c) => c.c?.g.visible).length, gulls: gulls.filter((g) => g.b?.g.visible).length, built, visible: shown }),
    where: () => [
      ...dogs.map((r) => ({ id: r.def.id, u: r.pose.u, v: r.pose.v, y: 0, stance: r.pose.stance, drawn: !!r.parts?.g.visible })),
      ...squirrels.map((r) => ({ id: r.id, u: r.pose.u, v: r.pose.v, y: r.pose.y, stance: r.pose.stance, drawn: !!r.c?.g.visible })),
      ...skunks.map((r) => ({ id: r.id, u: r.pose.u, v: r.pose.v, y: 0, stance: r.pose.stance, drawn: !!r.c?.g.visible })),
      ...cats.map((r) => ({ id: 'cat', u: r.u, v: r.v, y: r.y, stance: 'loaf', drawn: !!r.c?.g.visible })),
      ...gulls.map((r) => ({ id: r.id, u: r.pose.u, v: r.pose.v, y: r.pose.y, stance: r.pose.stance, drawn: !!r.b?.g.visible })),
    ],
    dispose(): void {
      group.traverse((o) => { const m = o as THREE.Line; if (m.isLine) m.geometry.dispose(); });
      leadMat.dispose();
      group.clear();
    },
  };
}

void PAD_Y;
