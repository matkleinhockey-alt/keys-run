/**
 * The pirates: an old wooden sloop that sails up to you about every 30 minutes, hails you, asks
 * whether you have any loot, comments on your cooler and your wallet, hangs about for a bit and
 * sails off. A bit, not a combat system — they never take or touch anything.
 *
 * Modelled on `caelen.ts` (a recurring character who talks through toasts and a world-space name
 * tag) with three differences that matter:
 *
 * 1. **The timer is not in here.** "Are they due" is `pirateVisitDue(seed, nowS, handled)` from
 *    `@keysrun/shared/world/pirates` — a pure function of the wall clock, with the clock injected
 *    as `deps.nowS`. This file keeps one integer (`handled`, the last bucket dealt with) and
 *    nothing else about time, so a test drives a whole visit by setting a number, and the browser
 *    debug hook never has to fake a Date.
 * 2. **Nothing exists while they are away.** Not the hull, not the crew, not the tag element, not
 *    a light. The boat is built on first arrival, added to the scene for the visit and removed at
 *    the end; the 29 minutes in between cost one subtraction a second (the "are they due" check
 *    is throttled to 1 Hz and does not run at all during a visit). Compare party-boats.ts, which
 *    has to keep its hulls resident because they are permanent landmarks.
 * 3. **They arrive by sailing.** Spawn is ~1 km out, on a bearing chosen by `pirate-nav.ts` to be
 *    open water all the way to you and outside the camera cone, so a visit is: a toast and a
 *    bell from the horizon, a sail growing, a hail, the banter, and the same trip in reverse.
 *
 * ## Sim time vs wall time
 *
 * Only the *trigger* reads the wall clock. Everything after that — sailing, the pauses between
 * lines, how long they hang about — advances on `dt`, the same clamped simulated seconds the rest
 * of the game runs on, so a slow frame rate stretches a visit in real seconds instead of skipping
 * the dialogue (which is how the sandbox's 3 fps software GPU was measured: in simulated
 * seconds, by design).
 */
import * as THREE from 'three';
import { COOLER_CAP } from '@keysrun/shared/content/boats';
import { ampAt, seaHAt } from '@keysrun/shared/sim/depth-grid';
import {
  CAPTAIN, MATE, nextPirateVisit, pirateScript, pirateVisit, pirateVisitDue,
  type PirateBeat, type PirateLoot, type PirateVisit,
} from '@keysrun/shared/world/pirates';
import { WORLD_SEED } from '../../state/constants.js';
import { angLerp } from './path.js';
import { HAIL_DIST, SAIL_SPEED, SPAWN_DIST, clearWater, escapeHeading, headingTo, placeSpawn, steerHeading, type Spawn, type ViewCone } from './pirate-nav.js';
import { buildPirateShip, type PirateShip } from './pirate-ship.js';
import { toast } from '../../ui/toast.js';
import type { ParticleSystem } from '../../world/particles.js';
import type { PirateSite } from '../../audio/interfaces.js';

export type PiratePhase = 'away' | 'approach' | 'linger' | 'depart';

/** What world.ts can tell us about the player's cooler and wallet. The cap is looked up here from
 * the hull id so the one world.ts line does not need `COOLER_CAP` imported into it. */
export interface PirateLootSource {
  cash: number;
  coolerLb: number;
  coolerCount: number;
  boatId: string;
  boat?: string;
}

export interface PirateDeps {
  /** Unix seconds. Injected so no test (and no debug hook) ever waits for a wall clock. */
  nowS?: () => number;
  seed?: number;
  loot?: () => PirateLootSource | null;
}

export interface Pirates {
  update(dt: number, t: number, boat: { x: number; y: number; z: number }, camera: THREE.PerspectiveCamera, viewport: { w: number; h: number }, particles: ParticleSystem, todK: number): void;
  /** Audio's view of them, or null while they are away. */
  site(): PirateSite | null;
  phase(): PiratePhase;
  /** Ask for a visit now (debug/verification). `distM` overrides the 1 km spawn so a screenshot
   * does not need two minutes of sailing. Takes effect on the next `update`. */
  summon(distM?: number): void;
  /** VERIFICATION-ONLY. */
  debug(): { phase: PiratePhase; x: number; z: number; heading: number; speed: number; dist: number; handled: number; visible: boolean; inScene: boolean; spawnDist: number; nextInS: number; beatsSpoken: number };
  dispose(): void;
}

/** Hail range: they start talking once this close, still sailing in. */
const HAIL_AT = 150;
/** Give-up distance in approach (the player outran them), metres. */
const LOST_D = 2600;
/** Hard cap on one approach, sim seconds. The whole visit has to fit inside a bucket's slack. */
const APPROACH_MAX_S = 330;
/** Beyond this the boat is not drawn. */
const DRAW_RANGE = 2300;
/** Rigging/flag/lantern animate inside this. */
const ANIM_RANGE = 700;
/** Crew IK and waving inside this. */
const CREW_RANGE = 170;
/** The wind, toward which it blows: the trades, out of the east-north-east. Constant on purpose —
 * a boat's trim only needs to be self-consistent, and a shared wind means two sailboats seen
 * together agree. */
const WIND = { x: -0.93, z: 0.37 };

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createPirates(scene: THREE.Scene, deps: PirateDeps = {}): Pirates {
  const clock = deps.nowS ?? ((): number => Date.now() / 1000);
  const seed = deps.seed ?? WORLD_SEED;

  let ship: PirateShip | null = null;
  let tag: HTMLElement | null = null;
  let inScene = false;

  let phase: PiratePhase = 'away';
  /** Highest scheduled bucket dealt with. */
  let handled = -Infinity;
  let checkT = 0;
  let summonReq: { distM: number } | null = null;
  let summons = 0;

  let x = 0, z = 0, heading = 0, speed = 0;
  let spawn: Spawn | null = null;
  let visit: PirateVisit | null = null;
  let scheduled = true;
  let tPhase = 0;
  let tHail = 0;
  let script: PirateBeat[] = [];
  let spoken = 0;
  let bubble = 0, bubbleWho = CAPTAIN, bubbleText = '';
  let waveT = 0;
  let departT = 0;
  let relocations = 0;
  let escapeT = 0, escapeH = 0;
  let heraldedClose = false;
  /** Distance to the player as of the last update, for the debug readout. */
  let lastD = 0;

  const siteObj: PirateSite = { id: 'pirates', x: 0, z: 0, hail: 0, voice: 0, singing: false };
  const projV = new THREE.Vector3();
  const tagW = new THREE.Vector3();
  const camDir = new THREE.Vector3();

  function lootNow(): PirateLoot {
    const l = deps.loot?.();
    if (!l) return { cash: 0, coolerLb: 0, coolerCount: 0, coolerCap: 300 };
    return { cash: l.cash, coolerLb: l.coolerLb, coolerCount: l.coolerCount, coolerCap: COOLER_CAP[l.boatId] ?? 300, boat: l.boat };
  }

  function ensureBuilt(): PirateShip {
    if (!ship) ship = buildPirateShip();
    if (!tag && typeof document !== 'undefined') {
      tag = document.createElement('div');
      tag.className = 'tag';
      tag.style.display = 'none';
      document.getElementById('tags')?.appendChild(tag);
    }
    if (!inScene) { scene.add(ship.group); inScene = true; }
    return ship;
  }

  /** Back to nothing: out of the scene, tag hidden, audio site gone. */
  function finish(): void {
    phase = 'away';
    if (ship && inScene) { scene.remove(ship.group); inScene = false; }
    if (tag) tag.style.display = 'none';
    siteObj.singing = false;
    bubble = 0;
    if (scheduled && visit) handled = Math.max(handled, visit.bucket);
    visit = null; spawn = null;
  }

  function viewCone(camera: THREE.PerspectiveCamera): ViewCone {
    camera.getWorldDirection(camDir);
    const h = Math.hypot(camDir.x, camDir.z) || 1;
    const halfV = THREE.MathUtils.degToRad(camera.fov) / 2;
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    // 0.4 rad of margin: the player can swing the view 23 degrees faster than a boat appears.
    return { fx: camDir.x / h, fz: camDir.z / h, half: halfH + 0.4 };
  }

  function begin(v: PirateVisit, boat: { x: number; z: number }, camera: THREE.PerspectiveCamera, distM: number, isScheduled: boolean): boolean {
    const sp = placeSpawn(boat, v.sea, v.spread, viewCone(camera), distM);
    if (!sp) return false;
    const s = ensureBuilt();
    visit = v; scheduled = isScheduled; spawn = sp;
    x = sp.x; z = sp.z; speed = SAIL_SPEED;
    heading = headingTo(boat.x - x, boat.z - z);
    phase = 'approach';
    tPhase = 0; tHail = 0; spoken = 0; bubble = 0; waveT = 0; departT = 0; relocations = 0; heraldedClose = false;
    script = [];
    s.group.visible = true;
    siteObj.hail = 0;
    // The heads-up. The bell is the real herald (audio/engine.ts, audible from ~800 m, well before
    // the hull clears the haze); this toast is for the player with the sound off.
    toast('\u{1F514} A ship’s bell, somewhere out on the water…', 4200);
    return true;
  }

  function say(b: PirateBeat): void {
    const who = b.who === 'captain' ? CAPTAIN : MATE;
    toast(`\u{1F3F4}‍☠️ ${who}: ${b.text}`, 4800);
    bubble = 5.5; bubbleWho = who; bubbleText = b.text;
    waveT = 4.2;
    siteObj.hail++;
    siteObj.voice = b.who === 'captain' ? 0 : 1;
  }

  function sail(dt: number, t: number, boat: { x: number; z: number }, camera: THREE.PerspectiveCamera, particles: ParticleSystem, todK: number): void {
    const s = ship!;
    const px = boat.x - x, pz = boat.z - z;
    const d = Math.hypot(px, pz) || 1;
    let wantSpeed: number, wantH = heading, beamOn = false;

    if (phase === 'depart') {
      departT += dt;
      // Out to open water, re-planned every few seconds. "Sail back to the spawn point" was the first
      // version and it circled that point forever on a short (summoned) approach; "sail straight
      // away" runs onto the nearest key. See `escapeHeading`.
      escapeT -= dt;
      if (escapeT <= 0) { escapeT = 4; escapeH = escapeHeading(x, z, boat.x, boat.z); }
      wantH = escapeH;
      wantSpeed = SAIL_SPEED * smooth(0, 7, departT);
    } else {
      // Heave to HAIL_DIST out on whichever side they arrived on, slowing over the last stretch so
      // there is no lurch from full speed to stopped, and never closer than that.
      const tx = boat.x - px / d * HAIL_DIST, tz = boat.z - pz / d * HAIL_DIST;
      wantH = headingTo(tx - x, tz - z);
      wantSpeed = SAIL_SPEED * smooth(HAIL_DIST - 1, HAIL_DIST + 120, d);
      beamOn = d < HAIL_DIST + 16;
    }

    if (beamOn) {
      // Starboard (local +x = world (cos h, -sin h)) toward the player: where the mate is waving from.
      wantH = Math.atan2(-pz, px);
    } else {
      const steered = steerHeading(x, z, wantH);
      if (steered === null) wantSpeed = 0;
      else wantH = steered;
    }
    heading = angLerp(heading, wantH, Math.min(1, dt * (beamOn ? 0.5 : 0.9)));
    speed += (wantSpeed - speed) * Math.min(1, dt * 0.6);

    const fx = -Math.sin(heading), fz = -Math.cos(heading);
    let nx = x + fx * speed * dt, nz = z + fz * speed * dt;
    // The player has driven into them: they sheer off rather than sit inside the hull.
    if (d < 16) { nx -= px / d * (16 - d) * dt * 1.2; nz -= pz / d * (16 - d) * dt * 1.2; }
    if (clearWater(nx, nz)) { x = nx; z = nz; } else speed = 0;

    // Sit on the real wave sum, exactly like traffic.ts: bow/stern for pitch, port/starboard for roll.
    const amp = ampAt(x, z), hl = s.L * 0.45, hbm = s.B * 0.5;
    const rxv = Math.cos(heading), rzv = -Math.sin(heading);
    const hb = seaHAt(x + fx * hl, z + fz * hl, t), hs = seaHAt(x - fx * hl, z - fz * hl, t);
    const hp = seaHAt(x - rxv * hbm, z - rzv * hbm, t), hst = seaHAt(x + rxv * hbm, z + rzv * hbm, t);
    const speedFrac = speed / SAIL_SPEED;

    // Wind in the hull's own frame: local +x is (cos h, -sin h), local +z (aft) is (sin h, cos h).
    const wl = { lx: WIND.x * rxv + WIND.z * rzv, lz: WIND.x * Math.sin(heading) + WIND.z * Math.cos(heading) };
    const dCam = Math.hypot(x - camera.position.x, z - camera.position.z);
    s.group.visible = dCam < DRAW_RANGE;
    let heel = -wl.lx * 0.1 * (0.35 + 0.65 * speedFrac);
    s.group.position.set(x, (hb + hs) / 2, z);
    if (dCam < ANIM_RANGE) {
      heel = s.animate(t, dt, wl, speedFrac, todK, waveT > 0, dCam < CREW_RANGE);
    }
    s.group.rotation.set(Math.atan2(hb - hs, s.L), heading, Math.atan2(hp - hst, s.B) * 0.7 + heel, 'YXZ');

    if (speed > 1.5 && dCam < 420) {
      // A modest bow wave and wake: a slow heavy hull pushes water, it does not rooster-tail.
      const sx = x - fx * s.L * 0.5, sz = z - fz * s.L * 0.5;
      if (Math.random() < dt * 10) {
        for (const sg of [-1, 1]) particles.spawnP(sx + rxv * s.B * 0.35 * sg, 0.1, sz + rzv * s.B * 0.35 * sg, rxv * sg * 1.2 - fx * 1.5, 0, rzv * sg * 1.2 - fz * 1.5, 2.6, 1.3, 0.4, false, amp);
      }
      if (Math.random() < dt * 8) {
        const bx = x + fx * s.L * 0.42;
        const bz = z + fz * s.L * 0.42;
        for (const sg of [-1, 1]) particles.spawnP(bx + rxv * 0.5 * sg, 0.15, bz + rzv * 0.5 * sg, rxv * sg * 1.6, 0.4, rzv * sg * 1.6, 1.4, 0.9, 0.45, false, amp);
      }
    }
  }

  function updateTag(camera: THREE.PerspectiveCamera, viewport: { w: number; h: number }): void {
    if (!tag || !ship) return;
    const dc = Math.hypot(x - camera.position.x, z - camera.position.z);
    tagW.copy(ship.tagAnchor);
    ship.group.localToWorld(tagW);
    projV.copy(tagW).project(camera);
    const vis = projV.z < 1 && dc < 320;
    tag.style.display = vis ? 'block' : 'none';
    if (!vis) return;
    tag.style.left = ((projV.x + 1) / 2 * viewport.w) + 'px';
    tag.style.top = ((1 - projV.y) / 2 * viewport.h) + 'px';
    tag.textContent = bubble > 0 ? `\u{1F3F4}‍☠️ ${bubbleWho}: “${bubbleText}”` : `\u{1F3F4}‍☠️ ${CAPTAIN}`;
  }

  const api: Pirates = {
    update(dt, t, boat, camera, viewport, particles, todK) {
      if (phase === 'away') {
        // The whole cost of the pirates for 29 minutes in 30: this.
        if (!summonReq) {
          checkT -= dt;
          if (checkT > 0) return;
          checkT = 1;
        }
        if (summonReq) {
          const s = summonReq; summonReq = null;
          const b = 1_000_000 + summons++;
          begin({ ...pirateVisit(seed, b), bucket: b }, boat, camera, s.distM, false);
          return;
        }
        const due = pirateVisitDue(seed, clock(), handled);
        if (!due) return;
        if (due.missed) { handled = due.visit.bucket; return; } // joined too late: wait for the next one
        // If there is nowhere to spawn (landlocked harbour) `begin` fails and we try again next
        // second, until the grace window closes and the visit is written off above.
        begin(due.visit, boat, camera, SPAWN_DIST, true);
        return;
      }

      const dt1 = Math.min(dt, 0.1);
      tPhase += dt1;
      const d = Math.hypot(boat.x - x, boat.z - z);
      lastD = d;

      if (phase === 'approach') {
        if (!heraldedClose && d < 480) {
          heraldedClose = true;
          toast('A wooden sailboat is bearing down on you. In the Keys. In this economy.', 4200);
        }
        if (d < HAIL_AT) {
          phase = 'linger'; tHail = 0; spoken = 0;
          script = pirateScript(seed, visit!.bucket, lootNow()); // read the cooler at the moment they look
        } else if (d > LOST_D && relocations < 2) {
          // The player outran them. Re-enter from over the horizon on the player's new side rather
          // than sail 3 km after a go-fast; the camera-cone rule means it still doesn't pop in.
          const sp = placeSpawn(boat, visit!.sea, visit!.spread, viewCone(camera), SPAWN_DIST);
          if (sp) { spawn = sp; x = sp.x; z = sp.z; relocations++; heading = headingTo(boat.x - x, boat.z - z); speed = SAIL_SPEED; }
        } else if (tPhase > APPROACH_MAX_S || d > LOST_D) {
          phase = 'depart'; departT = 0; escapeT = 0; // gave up; sails home without a word
        }
      } else if (phase === 'linger') {
        tHail += dt1;
        while (spoken < script.length && tHail >= script[spoken].at) say(script[spoken++]);
        const last = script[script.length - 1];
        if ((spoken >= script.length && tHail > last.at + 4.5) || d > 450) { phase = 'depart'; departT = 0; escapeT = 0; }
      } else {
        // sailing away; done once far enough, or after a long time
        if (d > 850 || (departT > 240 && d > 300) || departT > 420) { finish(); return; }
      }
      if (bubble > 0) bubble -= dt1;
      if (waveT > 0) waveT -= dt1;

      sail(dt1, t, boat, camera, particles, todK);
      siteObj.x = x; siteObj.z = z;
      siteObj.singing = phase !== 'depart' && d < 330;
      updateTag(camera, viewport);
    },

    site(): PirateSite | null { return phase === 'away' ? null : siteObj; },
    phase(): PiratePhase { return phase; },
    summon(distM = SPAWN_DIST): void { if (phase === 'away') summonReq = { distM }; },

    debug() {
      const now = clock();
      return {
        phase, x: +x.toFixed(1), z: +z.toFixed(1), heading: +heading.toFixed(3), speed: +speed.toFixed(2),
        dist: +lastD.toFixed(0),
        handled, visible: !!ship?.group.visible, inScene, spawnDist: spawn ? +spawn.dist.toFixed(0) : 0,
        nextInS: Math.round(nextPirateVisit(seed, now).start - now), beatsSpoken: spoken,
      };
    },

    dispose(): void {
      if (ship) { scene.remove(ship.group); ship.dispose(); }
      tag?.remove();
      ship = null; tag = null; inScene = false;
    },
  };
  return api;
}
