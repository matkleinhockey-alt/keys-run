/**
 * Caelen the seagull: circles your boat, swoops the deck, and has opinions — a name tag with a
 * speech bubble, on a timer.
 *
 * Ported faithfully from legacy/index.html:3713-3741 (`CAELEN`, `caelenSquawk`→
 * `audio/engine.ts`'s `caelenSquawk()`, `caelenSays`→`audio/index.ts`'s `sayCaelenLine()`,
 * `updateCaelen`), then extended net-new with the part legacy never had: he is **shootable**.
 *
 * ## The hitbox (`resolveSpearShot`)
 *
 * He carries a capsule, same shape and same closest-segment test `sim/spear.ts` uses for a fish
 * (`closestDistSqSegmentSegment`), so "did the shaft hit the bird" is answered by the identical
 * geometry rather than a second, looser notion of hitting. Three outcomes:
 *
 * - inside `CAELEN_RADIUS` → `'hit'`: he squawks, climbs out of the scene and is **gone for
 *   `CAELEN_AWAY_S`** (two minutes). No hitbox, no tag, no lines while away.
 * - inside `CAELEN_NEAR_MISS` of that → `'nearMiss'`: you were clearly shooting at him, so he
 *   tells you what he thinks of your aim.
 * - anything else → `null`: he never noticed, and a shot at a fish 20 m away must not trip this.
 *
 * Kept here rather than in `entities/speargun/**` on purpose: the gun stays a gun (it knows about
 * capsules and fish, see that module's `SpearTarget`), and the one thing in the world that reacts
 * to being shot at by having *opinions* owns both the reaction and the geometry that triggers it.
 * `game/world.ts` feeds it the ray it already captures for the fish near-miss spook.
 *
 * ## Why he comes down when you dive
 *
 * A gull orbiting the boat at 12-20 m sits outside `SPEAR_RANGE` (11 m), so the hitbox above
 * would be unreachable and the gag dead on arrival. Diving flips him onto `DIVE_RADIUS`/
 * `DIVE_HEIGHT` around the *diver* instead of the boat — which is also just what gulls do to a
 * spearo in the water, so the mechanic and the behaviour want the same thing.
 */
import * as THREE from 'three';
import { closestDistSqSegmentSegment, type Vec3 } from '@keysrun/shared/sim/spear';
import { makeSeabird, poseBird, moveBird, type Bird } from './seabirds.js';
import { rand } from '../../core/math.js';
import { toast } from '../../ui/toast.js';

/** Capsule radius, metres. Sized off the wings, not the body: the model is a 1.45-scaled gull,
 * so the body is ~0.5 m but the span is well over a metre, and a spear through the wing is a hit
 * by any reasonable reading. Also the generous end of honest because the shot is unassisted —
 * aim assist only ever locks onto `SpearTarget`s and he is deliberately not one. */
export const CAELEN_RADIUS = 0.75;
/** Half-length of the capsule along his heading. */
const CAELEN_HALF_LEN = 0.35;
/** Extra margin outside the hitbox that still counts as a shot *at* him, for the taunt. Wide,
 * because the whole point is that he notices and comments on bad aim. */
export const CAELEN_NEAR_MISS = 2.2;
/** How long he stays gone after a connecting shot, seconds — the brief's two minutes. */
export const CAELEN_AWAY_S = 120;
/** Seconds of visible departure flight before he blinks out, so a hit reads as "he left" rather
 * than "he was deleted". */
const LEAVE_FLIGHT_S = 2.4;

/** Orbit he holds around a diver in the water — inside `SPEAR_RANGE` from a diver near the
 * surface (hypot(5.5, ~3) ≈ 6.3 m), which is what makes him hittable at all. */
const DIVE_RADIUS = 5.5;
const DIVE_HEIGHT = 2.9;
/**
 * Angular rate on that orbit, rad/s — and a number that had to be measured rather than guessed.
 *
 * His boat orbit's 0.35 rad/s is fine at 12-20 m, but the same rate on a 5.5 m circle is 3.6 m/s
 * of tangential motion across a diver's view. A browser harness tracking him with the real
 * pointer-drag look (test/verify-caelen-shot.mjs) converged to a **constant 37 deg of lag**: he
 * outran the aim, every pass, forever. At 1.2 m/s he is a gull coasting over a diver — which is
 * what gulls actually do — and the lead needed over the shaft's ~0.26 s flight at 6 m drops to
 * 0.31 m, comfortably inside `CAELEN_RADIUS`. So you can hit him by pointing at him, which is
 * the whole bargain: hard enough to miss a lot, fair enough that the hit is yours.
 */
const DIVE_TURN_RATE = 0.22;

/** What he says unprompted, in rotation. */
const AMBIENT_LINES: readonly string[] = [
  'I’m an executive',
  'you didn’t make this… you didn’t make this',
  'I’m an executive, braow',
  'I don’t even fish, I own the fish',
];
const TAUNT_LINE = 'you suck at this braowww';
const HIT_LINE = 'AYO— that’s assault braowww';
const RETURN_LINE = 'I’m back. I’m an executive, you can’t ban me';

/** The slice of the diver `update` needs — see this module's header on why he changes orbit. */
export interface CaelenDiverInput {
  /** True exactly while the player is in the water (`diver.mode === 'diver'`). */
  active: boolean;
  x: number;
  y: number;
  z: number;
}

export interface CaelenDeps {
  /** `audio/index.ts`'s `AudioSystem.sayCaelenLine()` — squawk synth + the speech line, both
   * already fully implemented; see this module's header. */
  sayCaelenLine(): void;
}

/** What a resolved spear shot did to him — see `resolveSpearShot`. */
export type CaelenShotResult = 'hit' | 'nearMiss' | null;

export interface Caelen {
  update(dt: number, t: number, boat: { x: number; y: number; z: number; speed: number }, camera: THREE.PerspectiveCamera, viewport: { w: number; h: number }, diver?: CaelenDiverInput | null): void;
  /**
   * Tests one resolved spear shot (the swept shaft segment `p1`→`p2`) against his hitbox and
   * reacts. Returns what happened so the caller can log/verify it; the reaction itself — squawk,
   * speech bubble, two-minute exit — is applied here.
   *
   * Safe and inert while he is away: no hitbox exists, so every shot returns `null`.
   */
  resolveSpearShot(p1: Vec3, p2: Vec3): CaelenShotResult;
  /** Seconds until he returns, or 0 when he is already here. */
  awayFor(): number;
  /** VERIFICATION-ONLY: his live capsule, or null while away. */
  debugHitbox(): { ax: number; ay: number; az: number; bx: number; by: number; bz: number; radius: number } | null;
  dispose(): void;
}

/** legacy `CAELEN`/`updateCaelen` (index.html:3714, 3725-3741), plus the hitbox described in this
 * module's header. */
export function createCaelen(scene: THREE.Scene, deps: CaelenDeps): Caelen {
  const B: Bird = makeSeabird('gull', 1.45);
  scene.add(B.g);
  const tag = document.createElement('div');
  tag.className = 'tag';
  document.getElementById('tags')?.appendChild(tag);

  let a = Math.random() * 6.28, r = 12, h = 8, talkT = rand(20, 35), swoop = 0, bubble = 0;
  let lineIdx = 0;
  let line = AMBIENT_LINES[0];
  /** Seconds left of his two-minute sulk; 0 = present. */
  let away = 0;
  /** Seconds left of the visible departure climb. */
  let leaveT = 0;
  /** Live capsule, kept in sync by `update` so `resolveSpearShot` never has to re-derive it. */
  let hx = 0, hy = 0, hz = 0;
  const projV = new THREE.Vector3();

  /** Says `text` — toast, speech bubble and the squawk+speech synth, one place. */
  function say(text: string, hold = 4): void {
    line = text;
    bubble = hold;
    toast(`\u{1F426} Caelen: ${text}`);
    deps.sayCaelenLine();
  }

  function setPresent(present: boolean): void {
    B.g.visible = present;
    if (!present) tag.style.display = 'none';
  }

  return {
    update(dt, t, boat, camera, viewport, diver) {
      if (away > 0) {
        // Still sulking. He keeps flying for `LEAVE_FLIGHT_S` first (climbing away on the heading
        // he was hit on) so the exit is legible, then blinks out for the rest of the two minutes.
        away -= dt;
        if (leaveT > 0) {
          leaveT -= dt;
          r += dt * 14; h += dt * 7;
          a += dt * 0.5;
          const cx = boat.x + Math.cos(a) * r, cz = boat.z + Math.sin(a) * r;
          poseBird(B, dt, 1, 0, 13);
          moveBird(B, cx, boat.y + h, cz, dt);
          if (leaveT <= 0) setPresent(false);
        }
        if (away <= 0) {
          // Back, with a parting shot. Reset the orbit so he doesn't reappear a kilometre out.
          away = 0; leaveT = 0;
          r = 12; h = 8; a = Math.random() * 6.28; swoop = 0;
          B.px = null; B.py = null; B.pz = null; // don't bank wildly through the teleport
          setPresent(true);
          say(RETURN_LINE);
          talkT = rand(45, 90);
        }
        return;
      }

      // Who he is orbiting, and what counts as "sea level" for his height. Diving moves him onto
      // the diver at a much tighter, lower orbit — see this module's header.
      const diving = !!diver?.active;
      const cx = diving ? diver!.x : boat.x;
      const cz = diving ? diver!.z : boat.z;
      const baseY = diving ? 0 : boat.y;

      const sp = Math.abs(boat.speed);
      // keep pace with the boat: circle wider and higher when running, swoop low over the cockpit now and then
      a += dt * (diving ? DIVE_TURN_RATE : 0.35 + Math.min(0.5, sp * 0.012));
      const wantR = diving ? DIVE_RADIUS : (sp > 8 ? 20 : 12);
      const wantH = diving ? DIVE_HEIGHT : (sp > 8 ? 10 : 7);
      r += (wantR - r) * Math.min(1, dt * 0.5);
      h += (wantH - h) * Math.min(1, dt * 0.5);
      if (swoop <= 0 && Math.random() < dt * 0.03 && sp < 6) swoop = 3.5;
      let rr = r, hh = h;
      if (swoop > 0) {
        swoop -= dt;
        const q = Math.sin(Math.PI * (1 - swoop / 3.5));
        rr = rr + (3 - rr) * q; hh = hh + (baseY + 3.2 - hh) * q;
      }
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr, y = baseY + hh + Math.sin(t * 1.7) * 0.6;
      poseBird(B, dt, (Math.sin(t * 0.9) > -0.2 || sp > 10) ? 1 : 0, 0, 9);
      moveBird(B, x, y, z, dt);
      hx = x; hy = y; hz = z;
      talkT -= dt;
      if (talkT <= 0) {
        talkT = rand(45, 90);
        lineIdx = (lineIdx + 1) % AMBIENT_LINES.length;
        say(AMBIENT_LINES[lineIdx]);
      }
      if (bubble > 0) bubble -= dt;
      // name tag (and a speech bubble while he's talking)
      projV.set(x, y + 1.2, z).project(camera);
      const dc = Math.hypot(x - camera.position.x, z - camera.position.z), vis = projV.z < 1 && dc < 160;
      tag.style.display = vis ? 'block' : 'none';
      if (vis) {
        tag.style.left = ((projV.x + 1) / 2 * viewport.w) + 'px';
        tag.style.top = ((1 - projV.y) / 2 * viewport.h) + 'px';
        tag.textContent = bubble > 0 ? `\u{1F426} Caelen: “${line}”` : '\u{1F426} Caelen';
      }
    },

    resolveSpearShot(p1, p2): CaelenShotResult {
      if (away > 0) return null;
      // Capsule along his heading (`moveBird` keeps `B.yaw` as atan2(vx,vz), so forward is
      // (sin yaw, cos yaw) in x/z) — the same body-axis segment a fish's capsule uses.
      const fx = Math.sin(B.yaw) * CAELEN_HALF_LEN, fz = Math.cos(B.yaw) * CAELEN_HALF_LEN;
      const { distSq } = closestDistSqSegmentSegment(
        p1, p2,
        { x: hx - fx, y: hy, z: hz - fz },
        { x: hx + fx, y: hy, z: hz + fz },
      );
      if (distSq <= CAELEN_RADIUS * CAELEN_RADIUS) {
        say(HIT_LINE, 2.4);
        away = CAELEN_AWAY_S;
        leaveT = LEAVE_FLIGHT_S;
        return 'hit';
      }
      const near = CAELEN_RADIUS + CAELEN_NEAR_MISS;
      if (distSq <= near * near) {
        say(TAUNT_LINE);
        return 'nearMiss';
      }
      return null;
    },

    awayFor(): number { return Math.max(0, away); },

    debugHitbox() {
      if (away > 0) return null;
      const fx = Math.sin(B.yaw) * CAELEN_HALF_LEN, fz = Math.cos(B.yaw) * CAELEN_HALF_LEN;
      return { ax: hx - fx, ay: hy, az: hz - fz, bx: hx + fx, by: hy, bz: hz + fz, radius: CAELEN_RADIUS };
    },

    dispose(): void {
      tag.remove();
      scene.remove(B.g);
    },
  };
}
