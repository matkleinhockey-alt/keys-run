/**
 * The party on deck: crew walk laps around the cockpit, dance when the boat is slow, and hang on
 * when it's running; the Freeman's pull-down shower; the Midnight Express's dance pole.
 *
 * Ported faithfully from legacy/index.html:3262-3352 (`pathAt`→`entities/life/path.ts`,
 * `updateShower`, `updatePole`, `updateParty`). The dancing is **beat-synced to the radio** —
 * `deps.bpm()` reads `audio/music/radio.ts`'s `MusicController.bpm()` rather than reimplementing
 * it, exactly the coupling legacy had between `MUSIC` and this module.
 *
 * `entities/boat/model.ts` (a deck-mount point this task is allowed to touch) builds the `party`/
 * `pole`/`shower` descriptors below and owns their one-time construction; this module only
 * animates them every frame. Structural (not imported) typing against `DeckPartyBoat` avoids a
 * circular import with model.ts, which imports `PartyMember`/`PoleRig`/`ShowerRig` from here.
 */
import * as THREE from 'three';
import type { Human } from './human.js';
import type { Path } from './path.js';
import { angLerp } from './path.js';
import { clamp, lerp, rand } from '../../core/math.js';
import type { ParticleSystem } from '../../world/particles.js';

export interface PartyMember {
  h: Human;
  path: Path;
  s: number;
  ph: number;
  mode: 'walk' | 'dance';
  modeT: number;
  mv?: string;
  mvT?: number;
  mv0?: number;
  aL?: THREE.Vector3; aR?: THREE.Vector3;
  fL?: THREE.Vector3; fR?: THREE.Vector3;
  sw?: number; ln?: number;
}

/** legacy `pole` (index.html:1619-1624, Midnight Express only). */
export interface PoleRig {
  h: Human;
  z: number;
  y: number;
  top: number;
  ang: number;
  climbT?: number;
  spin?: number;
}

/** legacy `shower` (index.html:1609-1617, Freeman only). */
export interface ShowerRig {
  x: number; y: number; z: number;
  h: Human;
  on: boolean;
  t: number;
  /** `null` = automatic; `true`/`false` pins it on/off (legacy never actually drives this from UI,
   * kept for parity / a future debug hook). */
  forced: boolean | null;
}

export interface DeckPartyBoat {
  group: THREE.Group;
  party: PartyMember[];
  pole: PoleRig | null;
  shower: ShowerRig | null;
  soleAt(z: number): number;
  uwLights?: THREE.PointLight[];
  cabin?: THREE.Group;
  cabinLight?: THREE.PointLight;
  cabinLight2?: THREE.PointLight | null;
}

export interface DeckLifeDeps {
  particles: ParticleSystem;
  /** World-space camera position, for the shower's splash LOD cutoff. */
  cameraPos: { x: number; y: number; z: number };
  /** `audio/music/radio.ts`'s `MusicController.bpm()` — the whole point of this module's header
   * comment: dancing tracks the radio, not an independent clock. */
  bpm(): number;
  /** `core/time-of-day.ts`'s `getK()` — drives the cabin lights and underwater-light boost that
   * legacy tied to the same `updatePole` call as the dance pole (index.html:3288-3289), because
   * they're both "things the deck-party update loop touches every frame" rather than because
   * they're conceptually about the party. */
  todK(): number;
  /** Luigi mode flipping the pole dancer's resting-hand target toward the mouth as her sip blends
   * in (legacy index.html:3349's `LUIGI.on?...:...`) — see `entities/life/luigi.ts`. */
  luigiOn(): boolean;
}

const _tmpA = new THREE.Vector3();
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** legacy `updateShower` (index.html:3267-3285): the Freeman's rinse-off, triggered automatically
 * while the boat is stopped, with a human rinsing under a scatter of falling-water particles. */
export function updateShower(dt: number, t: number, model: DeckPartyBoat, boatState: { x: number; z: number; speed: number; air: boolean }, deps: DeckLifeDeps): void {
  const W = model.shower;
  if (!W) return;
  const h = W.h;
  const calm = Math.abs(boatState.speed) < 1.5 && !boatState.air;
  W.t -= dt;
  if (W.forced === null && W.t <= 0) { W.on = !W.on && calm; W.t = W.on ? rand(10, 16) : rand(25, 45); }
  const on = (W.forced !== null ? W.forced : W.on) && calm;
  h.group.visible = on;
  if (!on) return;
  // rinsing off: hands up through the hair, head tipped back, a slow sway under the spray
  const w = Math.sin(t * 1.6), w2 = Math.sin(t * 2.3 + 1);
  h.group.rotation.set(0, Math.PI + Math.sin(t * 0.4) * 0.6, w * 0.04, 'YXZ');
  h.poseLegs(V(-0.12, 0.085, 0), V(0.12, 0.085 + Math.max(0, w) * 0.02, 0));
  h.pose(V(-0.12 + 0.04 * w2, h.hipY + 0.8 + 0.05 * w, -0.02), V(0.12 - 0.04 * w2, h.hipY + 0.8 - 0.05 * w, -0.02));
  if (h.head) h.head.rotation.x = -0.35 + 0.05 * w;
  // the water
  if (Math.hypot(boatState.x - deps.cameraPos.x, boatState.z - deps.cameraPos.z) < 120) {
    model.group.updateMatrixWorld(true);
    const src = model.group.localToWorld(_tmpA.set(W.x, W.y, W.z));
    const n = Math.ceil(dt * 70);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283, r = Math.random() * 0.05;
      deps.particles.spawnP(src.x + Math.cos(a) * r, src.y, src.z + Math.sin(a) * r, Math.cos(a) * 0.35, -rand(1.5, 2.6), Math.sin(a) * 0.35, rand(0.45, 0.7), rand(0.05, 0.11), 0.55, true);
    }
    if (Math.random() < dt * 14) {
      const f = model.group.localToWorld(_tmpA.set(W.x + rand(-0.15, 0.15), model.soleAt(W.z) + 0.05, W.z + rand(-0.15, 0.15)));
      deps.particles.spawnP(f.x, f.y, f.z, rand(-0.4, 0.4), rand(0.3, 0.8), rand(-0.4, 0.4), rand(0.3, 0.5), rand(0.08, 0.15), 0.45, true);
    }
  }
}

/** legacy `updatePole` (index.html:3286-3304): also carries the underwater-light TOD boost and
 * cabin-light visibility legacy ties to the same call (see `DeckLifeDeps.todK`'s doc comment). */
export function updatePole(dt: number, t: number, model: DeckPartyBoat, boatState: { x: number; z: number; speed: number; air: boolean }, deps: DeckLifeDeps): void {
  updateShower(dt, t, model, boatState, deps);
  const k = deps.todK();
  if (model.uwLights) model.uwLights.forEach((l, i) => { l.intensity = (i < model.uwLights!.length - 1 ? 1.6 : 1.1) + (i < model.uwLights!.length - 1 ? 3.4 : 2.2) * k; });
  if (model.cabin) {
    model.cabin.visible = k > 0.5;
    if (model.cabinLight) model.cabinLight.intensity = 0.9 * clamp((k - 0.5) * 2, 0, 1);
    if (model.cabinLight2) model.cabinLight2.intensity = 0.8 * clamp((k - 0.5) * 2, 0, 1);
  }
  const P = model.pole;
  if (!P) return;
  const h = P.h;
  const fast = Math.abs(boatState.speed) > 6 || boatState.air;
  const bpm = deps.bpm(), beat = Math.sin(t * bpm / 60 * Math.PI);
  if (fast) {
    // hang on to the pole with both hands while the boat is running
    const r = 0.32, x = Math.sin(P.ang) * r, z = P.z + Math.cos(P.ang) * r;
    h.group.position.set(x, P.y, z);
    h.group.rotation.set(0, P.ang + Math.PI, 0);
    h.poseLegs(V(-0.14, 0.085, 0), V(0.14, 0.085, 0));
    const pw = V(0, P.y + 1.25, P.z);
    model.group.worldToLocal(model.group.localToWorld(pw));
    h.pose(pw.clone().add(V(-0.04, 0, 0)), pw.clone().add(V(0.04, 0.08, 0)));
    return;
  }
  // spin slowly around the pole, one hand high on it, the other reaching out, swaying on the beat; now and then a lifted-leg spin
  P.climbT = (P.climbT ?? rand(5, 9)) - dt;
  if (P.climbT <= 0 && !((P.spin ?? 0) > 0)) { P.spin = 2.4; P.climbT = rand(7, 12); }
  const spinning = (P.spin ?? 0) > 0;
  if (spinning) P.spin = (P.spin ?? 0) - dt;
  const sp = spinning ? Math.sin(Math.PI * (1 - (P.spin ?? 0) / 2.4)) : 0;
  P.ang += dt * (0.55 + 1.8 * sp);
  const r = 0.33 - 0.05 * sp, x = Math.sin(P.ang) * r, z = P.z + Math.cos(P.ang) * r;
  h.group.position.set(x, P.y + 0.12 * sp, z);
  h.group.rotation.set(0, P.ang + Math.PI * 0.5, -0.12 - 0.2 * sp, 'YXZ');
  const lift = 0.35 * sp, sway = beat * 0.03 * (1 - sp);
  h.poseLegs(V(-0.12, 0.085 + lift * 0.4, 0.02 + lift * 0.3), V(0.12, 0.085 + lift, -0.02 - lift * 0.6));
  const toPole = V(0, P.y + 1.6 + 0.15 * sp, P.z);
  model.group.updateMatrixWorld(true); h.group.updateMatrixWorld(true);
  const hl = h.group.worldToLocal(model.group.localToWorld(toPole));
  h.pose(hl, V(0.42 + sway, h.hipY + 0.55 + 0.1 * beat, 0.1));
}

const DANCE_MOVES = ['sway', 'hands', 'step', 'roll', 'groove', 'twirl', 'hipcircle', 'shimmy', 'wave', 'hipcircle', 'groove', 'wave'] as const;

/** legacy `updateParty` (index.html:3305-3352): the deck party itself — walking laps, or dancing
 * together on the beat; hangs on in silence while the boat is running. */
export function updateParty(dt: number, t: number, model: DeckPartyBoat, boatState: { x: number; z: number; speed: number; air: boolean }, deps: DeckLifeDeps): void {
  updatePole(dt, t, model, boatState, deps);
  if (!model.party.length) return;
  const fast = Math.abs(boatState.speed) > 6 || boatState.air;
  for (const P of model.party) {
    const h = P.h;
    P.modeT -= dt;
    if (P.modeT <= 0) { P.mode = P.mode === 'walk' ? 'dance' : 'walk'; P.modeT = rand(7, 14); }
    const mode: 'walk' | 'dance' | 'hold' = fast ? 'hold' : P.mode;
    let x = h.group.position.x, z = h.group.position.z, bounce = 0;
    if (mode === 'walk') {
      P.s += dt * 0.85;
      const p = P.path.at(P.s);
      x = p.x; z = p.z;
      h.group.rotation.set(0, Math.atan2(p.tx, p.tz), 0);
      P.ph += dt * 6.5;
      const f1 = Math.sin(P.ph), lift = (k: number): number => Math.max(0, k) * 0.07;
      h.poseLegs(V(-0.105, 0.085 + lift(Math.cos(P.ph)), 0.17 * f1), V(0.105, 0.085 + lift(-Math.cos(P.ph)), -0.17 * f1));
      h.pose(V(-0.22, h.hipY + 0.05, -0.13 * f1 + 0.04), V(0.22, h.hipY + 0.05, 0.13 * f1 + 0.04));
      bounce = Math.abs(Math.cos(P.ph)) * 0.022;
      h.group.rotation.set(0.02, Math.atan2(p.tx, p.tz) + f1 * 0.06, Math.sin(P.ph) * 0.045, 'YXZ');
      x += Math.cos(Math.atan2(p.tx, p.tz)) * Math.sin(P.ph) * 0.02;
    } else if (mode === 'dance') {
      // dance on the beat of the radio: several moves, facing into the group, head nodding with the music
      const bpm = deps.bpm();
      P.ph += dt * bpm / 60 * Math.PI;
      P.mvT = (P.mvT ?? 0) - dt;
      if (P.mvT <= 0) {
        P.mv = DANCE_MOVES[Math.floor(Math.random() * DANCE_MOVES.length)];
        P.mvT = P.mv === 'twirl' ? 60 / bpm * 4 : rand(4, 8);
        P.mv0 = P.ph;
      }
      const beat = Math.sin(P.ph), half = Math.sin(P.ph * 0.5), down = Math.abs(beat);
      // face the middle of the group so it looks like they're dancing together
      let cx = 0, cz2 = 0;
      model.party.forEach((Q) => { cx += Q.h.group.position.x; cz2 += Q.h.group.position.z; });
      cx /= model.party.length; cz2 /= model.party.length;
      const face = Math.atan2(cx - x, cz2 - z) + Math.sin(t * 0.3 + P.s) * 0.5;
      let ry = angLerp(h.group.rotation.y, face, dt * 1.2);
      let sway = 0, lean = 0, aL: THREE.Vector3, aR: THREE.Vector3;
      const fL = V(-0.13, 0.085, 0.02), fR = V(0.13, 0.085, -0.02);
      let nod = down * 0.12;
      if (P.mv === 'sway') {
        sway = half * 0.07; lean = -half * 0.1; bounce = -0.035 - down * 0.03;
        fL.y += Math.max(0, half) * 0.03; fR.y += Math.max(0, -half) * 0.03;
        aL = V(-0.2, h.hipY + 0.06, 0.02); aR = V(0.32 + 0.05 * half, h.hipY + 0.85 + 0.12 * beat, 0.12);
      } else if (P.mv === 'hands') {
        sway = half * 0.04; lean = -half * 0.06; bounce = -down * 0.06;
        aL = V(-0.22 + 0.08 * half, h.hipY + 1.0 + 0.06 * beat, 0.08); aR = V(0.22 + 0.08 * half, h.hipY + 1.0 - 0.06 * beat, 0.08);
      } else if (P.mv === 'step') {
        const st = half * 0.11; sway = st * 0.6; bounce = -0.03 - down * 0.025;
        fL.x -= Math.max(0, -st); fR.x += Math.max(0, st);
        aL = V(-0.24, h.hipY + 0.45 + 0.08 * down, 0.2); aR = V(0.24, h.hipY + 0.45 + 0.08 * down, 0.2);
      } else if (P.mv === 'roll') {
        const w = Math.sin(P.ph * 0.5); bounce = -0.04 - 0.04 * Math.max(0, w); h.group.rotation.x = 0.12 * w; // body roll: chest leads, hips follow
        aL = V(-0.18, h.hipY + 0.55 + 0.15 * w, 0.25); aR = V(0.18, h.hipY + 0.55 - 0.15 * w, 0.25); lean = 0.03 * w;
      } else if (P.mv === 'groove') {
        const st = Math.sin(P.ph) * 0.06; sway = st; bounce = -0.02 - down * 0.03;
        fL.z += Math.max(0, st) * 1.5; fR.z -= Math.max(0, -st) * 1.5;
        aL = V(-0.28, h.hipY + 0.5 + 0.06 * beat, 0.15 + 0.05 * half); aR = V(0.28, h.hipY + 0.5 - 0.06 * beat, 0.15 - 0.05 * half); lean = -st * 0.8;
      } else if (P.mv === 'hipcircle') {
        const a = P.ph * 0.5; sway = Math.cos(a) * 0.06; lean = -Math.cos(a) * 0.09; bounce = -0.04 - 0.03 * Math.max(0, Math.sin(a)); h.group.rotation.x = 0.06 * Math.sin(a); // slow hip circles
        aL = V(-0.2, h.hipY + 0.12, 0.06); aR = Math.sin(P.ph * 0.25) > 0 ? V(0.12, h.hipY + 1.02, 0.04) : V(0.2, h.hipY + 0.12, 0.06);
        nod = down * 0.06;
      } else if (P.mv === 'shimmy') {
        const f = Math.sin(P.ph * 4) * 0.035; sway = f * 0.4; bounce = -0.05 - down * 0.02; lean = f * 0.6; // quick shoulder shimmy
        aL = V(-0.3, h.hipY + 0.48 + f, 0.18); aR = V(0.3, h.hipY + 0.48 - f, 0.18); nod = 0.02;
      } else if (P.mv === 'wave') {
        const a = P.ph * 0.5; sway = Math.sin(a) * 0.05; lean = -Math.sin(a) * 0.08; bounce = -down * 0.045; // both arms waving overhead side to side
        aL = V(-0.18 + 0.22 * Math.sin(a), h.hipY + 1.02, 0.06); aR = V(0.18 + 0.22 * Math.sin(a), h.hipY + 1.02, 0.06);
      } else {
        const p2 = clamp((P.ph - (P.mv0 ?? 0)) / (Math.PI * 4), 0, 1); void p2;
        ry += dt * Math.PI * 2 * (bpm / 60) / 4 * 2.0; bounce = -0.02; // twirl: one full spin with an arm up
        aL = V(-0.25, h.hipY + 0.3, 0.05); aR = V(0.05, h.hipY + 1.12, 0.02); fL.y += 0.02; nod = 0;
      }
      // blend into each new move instead of snapping
      const bl = Math.min(1, dt * 7);
      P.aL = (P.aL ?? aL.clone()).lerp(aL, bl); P.aR = (P.aR ?? aR.clone()).lerp(aR, bl);
      P.fL = (P.fL ?? fL.clone()).lerp(fL, bl); P.fR = (P.fR ?? fR.clone()).lerp(fR, bl);
      P.sw = lerp(P.sw ?? 0, sway, bl); P.ln = lerp(P.ln ?? 0, lean, bl);
      sway = P.sw; lean = P.ln;
      h.poseLegs(P.fL, P.fR); h.pose(P.aL, P.aR);
      h.group.rotation.set(P.mv === 'roll' || P.mv === 'hipcircle' ? h.group.rotation.x : 0.04, ry, lean, 'YXZ');
      x += Math.cos(ry) * sway; z += -Math.sin(ry) * sway;
      if (h.head) h.head.rotation.x = nod - 0.04;
    } else {
      h.group.rotation.z = 0;
      h.poseLegs(V(-0.14, 0.085, 0), V(0.14, 0.085, 0));
      const restR = V(0.22, h.hipY + 1.0, 0.14);
      const sippingR = deps.luigiOn() ? V(0.3, h.hipY + 1.08 + 0.06 * Math.sin(t * 2.4 + P.s), 0.04).lerp(V(0.05, h.hipY + 0.71, 0.15), h.sipAmt || 0) : restR;
      h.pose(V(-0.2, h.hipY + 1.0, 0.14), sippingR);
    }
    h.group.position.set(x, model.soleAt(z) + bounce, z);
  }
}
