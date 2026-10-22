/**
 * The people of Boot Key Harbor City: strollers, loiterers, a doorman, a bartender.
 *
 * Reuses `makeHuman` (entities/life/human.ts), the same figure as the boat's captain and deck
 * party, with `walker: true` so it has real jointed IK legs. That function already knows how to
 * pose limbs from target points (`pose`, `poseLegs`); the only thing this file adds is a gait that
 * drives those targets from a phase, and a walkway follower.
 *
 * ## Tiers, by distance from the camera
 *   - beyond `PEOPLE_RANGE`: the whole crowd is `visible = false` and not even moved. Nobody sees a
 *     stroller at 300 m, and a crowd that is paused out there simply resumes when you return.
 *   - inside it: positions advance every frame (14 vector adds; free).
 *   - inside `GAIT_RANGE`: the legs and arms are solved by IK each frame. Beyond that, a walker
 *     slides along in its last pose, which at 90 m is indistinguishable from stepping.
 *
 * The humans are built lazily on first approach, not at town build: `makeHuman` merges a lathe
 * torso, a head with hair, eyes and lids per figure, which is the single most expensive thing in
 * the town to construct and is only worth paying for when someone could see it.
 */
import * as THREE from 'three';
import { WALKWAYS, type Npc, type NpcLook, type Walkway } from '@keysrun/shared/world/town';
import { makeHuman, type Human, type HumanOptions } from '../life/human.js';
import { Zf } from './props.js';

/** Whole crowd hidden beyond this, metres from the camera to the nearest edge of the street. */
export const PEOPLE_RANGE = 150;
/** Each figure is its own draw calls (a `makeHuman` is ~15 meshes: body, head, hair, limbs), so the
 * crowd is culled PER PERSON, not just as a group: the first perf pass measured ~280 extra draw
 * calls in the street, nearly all of them people. Beyond this a stroller is a 10-pixel smudge. */
export const PEOPLE_DRAW_RANGE = 95;
export const GAIT_RANGE = 70;

const SHIRTS = [0xf26b5b, 0x3fb6c9, 0xf2c14e, 0x7bc96f, 0xe86aa8, 0xffffff, 0x5a7bd6, 0xff9f43];
const HAIR = [0x3b2a1e, 0x1c1410, 0x7a3a1c, 0xd8b46a, 0x5a3825, 0x2e1c12];
const SKIN = [0xd9a27f, 0xe9b48f, 0xc98d68, 0xb87a55, 0xf0c2a0, 0x9a6644];

export function humanOptionsFor(look: NpcLook, i: number): HumanOptions {
  const base: HumanOptions = { walker: true, skin: SKIN[i % SKIN.length], hair: HAIR[(i * 3) % HAIR.length], shirt: SHIRTS[i % SHIRTS.length], shorts: 0xcdbf9a, shoes: 0xe9e4d8 };
  switch (look) {
    case 'tourist': return { ...base, shortSleeve: true, cap: i % 2 ? 0xffffff : undefined, glasses: i % 3 === 0, shorts: 0xe9e1c8 };
    case 'angler': return { ...base, shirt: 0x6b7f8a, shortSleeve: true, cap: 0x23466e, shorts: 0x4d5a4a, shoes: 0x5a4a38 };
    case 'local': return { ...base, shirt: i % 2 ? 0x2f2f33 : 0xb8423a, shortSleeve: true, cap: 0x2b2118, shorts: 0x3d4a5a, shoes: 0xc9c2b2 };
    case 'woman': return { ...base, longHair: true, hairStyle: (['long', 'wavy', 'pony', 'bun'] as const)[i % 4], shirt: SHIRTS[(i + 2) % SHIRTS.length], shortSleeve: true, shorts: 0x3d5a8a };
    case 'bouncer': return { ...base, shirt: 0x111114, shorts: 0x111114, shortsLong: true, glasses: true, shoes: 0x111114, skin: 0xb87a55, shortSleeve: true };
    case 'bartender': return { ...base, shirt: 0xf3efe5, shortSleeve: true, shorts: 0x2b2118, hair: 0x7a3a1c, longHair: true, hairStyle: 'bun' };
    case 'cook': return { ...base, shirt: 0xffffff, cap: 0xffffff, shorts: 0x23262a, shortSleeve: true };
    case 'patron': return { ...base, shortSleeve: true, cap: 0x5a7bd6, shorts: 0x6b5a3a };
  }
}

interface Route { pts: Array<[number, number]>; cum: number[]; total: number }

function routeOf(w: Walkway): Route {
  const pts = w.pts.map(([u, v]) => [u, v] as [number, number]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, total: cum[cum.length - 1] };
}

function pointAt(r: Route, s: number, out: { u: number; v: number; du: number; dv: number }): void {
  let i = 1;
  while (i < r.cum.length - 1 && r.cum[i] < s) i++;
  const a = r.pts[i - 1], b = r.pts[i], seg = r.cum[i] - r.cum[i - 1] || 1, t = (s - r.cum[i - 1]) / seg;
  out.u = a[0] + (b[0] - a[0]) * t; out.v = a[1] + (b[1] - a[1]) * t;
  out.du = (b[0] - a[0]) / seg; out.dv = (b[1] - a[1]) / seg;
}

export interface Person {
  npc: Npc;
  human: Human;
  route: Route | null;
  /** Distance along the route, metres, and which way it is walking (+1 / -1). */
  s: number; dir: 1 | -1;
  phase: number;
  baseY: number;
}

const _fl = new THREE.Vector3(), _fr = new THREE.Vector3(), _hl = new THREE.Vector3(), _hr = new THREE.Vector3();

/**
 * One stride cycle: legs swing on opposite phases with a lifted heel at the front of the swing,
 * arms counter-swing, the body bobs twice per cycle. Targets are in the human's own frame, which
 * is exactly what `poseLegs`/`pose` expect (feet near y=0.085, hips at `hipY`). Returns the body bob.
 */
export function animateGait(h: Human, phase: number, amount: number): number {
  const sw = Math.sin(phase), sw2 = Math.sin(phase + Math.PI);
  const stride = 0.3 * amount;
  const lift = (s: number): number => Math.max(0, Math.cos(s)) * 0.11 * amount;
  _fl.set(-0.105, 0.085 + lift(phase), sw * stride);
  _fr.set(0.105, 0.085 + lift(phase + Math.PI), sw2 * stride);
  h.poseLegs(_fl, _fr);
  _hl.set(-0.24, h.hipY + 0.0, 0.05 + sw2 * 0.22 * amount);
  _hr.set(0.24, h.hipY + 0.0, 0.05 + sw * 0.22 * amount);
  h.pose(_hl, _hr);
  return Math.abs(Math.sin(phase)) * 0.035 * amount;
}

export interface PeopleSystem {
  group: THREE.Group;
  /** Build the figures if they do not exist yet. Cheap to call every frame. */
  ensure(): void;
  update(t: number, dt: number, cam: { x: number; y: number; z: number }, toLocal: (x: number, z: number) => [number, number]): void;
  /** For tests / debug. */
  debug(): Array<{ id: string; u: number; v: number }>;
  dispose(): void;
}

/** Place a human at a fixed spot (a stander, or someone inside a building). */
export function placeStander(p: Person): void {
  const a = p.npc.at!;
  p.human.group.position.set(a.u, p.baseY, Zf(a.v));
  p.human.group.rotation.y = Math.atan2(Math.cos(a.yaw), -Math.sin(a.yaw));
}

export function makePerson(npc: Npc, index: number, baseY: number): Person {
  const human = makeHuman(humanOptionsFor(npc.look, index));
  if (npc.look === 'bouncer') {
    human.group.scale.setScalar(1.12);
    human.pose(new THREE.Vector3(0.1, human.hipY + 0.3, 0.2), new THREE.Vector3(-0.1, human.hipY + 0.33, 0.22));
  }
  const walkway = npc.route ? WALKWAYS.find((w) => w.id === npc.route) : undefined;
  const route = walkway ? routeOf(walkway) : null;
  const p: Person = { npc, human, route, s: route ? route.total * (npc.phase ?? 0) : 0, dir: 1, phase: index * 1.7, baseY };
  if (!route) placeStander(p);
  return p;
}

export function createPeople(npcs: readonly Npc[], baseY: number): PeopleSystem {
  const group = new THREE.Group();
  group.name = 'townPeople';
  group.visible = false;
  let people: Person[] = [];
  let built = false;
  const out = { u: 0, v: 0, du: 1, dv: 0 };

  return {
    group,
    ensure(): void {
      if (built) return;
      built = true;
      // Interior staff (`inside`) are made by the interior that owns them, not here.
      people = npcs.filter((n) => !n.inside).map((n, i) => makePerson(n, i, baseY));
      for (const p of people) group.add(p.human.group);
    },
    update(t, dt, cam, toLocal): void {
      if (!built) return;
      const [cu, cv] = toLocal(cam.x, cam.z);
      // distance to the nearest part of the street, not to its centre: the crowd is 200 m wide
      const du = Math.max(0, Math.abs(cu) - 104), dv = cv < 18 ? 18 - cv : cv > 172 ? cv - 172 : 0;
      const d = Math.hypot(du, dv, Math.max(0, cam.y - 40));
      group.visible = d < PEOPLE_RANGE;
      if (!group.visible) return;
      for (const p of people) {
        const g = p.human.group;
        const near = Math.hypot(g.position.x - cu, -g.position.z - cv) < PEOPLE_DRAW_RANGE;
        g.visible = near;
        if (p.route) {
          p.s += p.npc.speed! * dt * p.dir;
          if (p.s > p.route.total) { p.s = p.route.total; p.dir = -1; }
          else if (p.s < 0) { p.s = 0; p.dir = 1; }
          pointAt(p.route, p.s, out);
          g.position.x = out.u; g.position.z = Zf(out.v);
          g.rotation.y = Math.atan2(out.du * p.dir, -out.dv * p.dir);
          p.phase += p.npc.speed! * dt * 4.2;
          const pd = Math.hypot(out.u - cu, out.v - cv);
          g.position.y = baseY + (pd < GAIT_RANGE ? animateGait(p.human, p.phase, 1) : 0);
        }
        if (near && Math.hypot(g.position.x - cu, -g.position.z - cv) < 45) p.human.update(t, 0);
      }
    },
    debug: () => people.map((p) => ({ id: p.npc.id, u: p.human.group.position.x, v: -p.human.group.position.z })),
    dispose(): void {
      group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      group.clear();
    },
  };
}
