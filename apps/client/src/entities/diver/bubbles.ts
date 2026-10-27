/**
 * The diver's own bubbles.
 *
 * The water already had seep bubbles venting off the bottom (world/underwater/seep-bubbles.ts),
 * marine snow, caustics and god rays — everything except any sign that the person in the middle
 * of it was breathing. A freediver on a breath-hold is not silent: air escapes the mask every
 * time they equalise on the way down, it leaks faster as the dive runs long and the urge to
 * breathe builds, and the breath comes out all at once when they surface.
 *
 * ## Boyle's law is the whole look
 *
 * The one thing that makes underwater bubbles read as underwater is that they GROW on the way
 * up. Pressure is 1 ATA at the surface and another atmosphere every ten metres, so a bubble
 * leaving a mask at 20 m is at 3 ATA and has three times the volume by the time it surfaces —
 * `cbrt(3)`, about 1.44x the radius — and it accelerates as it goes, because a bigger bubble
 * rises faster. Each bubble here therefore remembers the pressure it was born at and is sized
 * from the pressure where it currently is, rather than from a fudge against its age.
 *
 * Everything else is detail on top: bubbles above about a millimetre do not rise straight, they
 * zigzag, so each carries its own wobble; and they are carried by the same current
 * (shared/world/current.ts) that moves the weeds and the snow, so a diver hanging in a tide sees
 * their own breath stream away downcurrent.
 *
 * Cosmetic and self-contained. `sim/diver.ts` does not know this exists, so nothing here can
 * change a dive — it only reads air, exertion, depth and the events the sim already raises.
 */
import * as THREE from 'three';
import { currentAt } from '@keysrun/shared/world/current';
import type { DiverState, DiverEvent } from '@keysrun/shared/sim/diver';

/** Bubbles in the pool. A long dive leaks steadily, and a 20 m bubble takes over a minute to get
 * up, so a lot of them are in the water at once. */
const MAX = 420;

/** Metres of descent between equalisations. A freediver clears every couple of metres on the way
 * down and a little air escapes the mask each time — the most recognisable bubble cue there is. */
const EQ_STEP_M = 2.4;

/** Bubbles per second with air in hand and nothing going on. A slow, occasional trickle. */
const LEAK_BASE = 0.7;
/** Added as the breath-hold runs out: the urge to breathe gets expensive to resist. Quadratic, so
 * it is barely there for most of the dive and obvious at the end. */
const LEAK_LOW_AIR = 7.5;
/** Added by hard finning. */
const LEAK_EXERTION = 3.5;

/** Terminal rise speed, m/s, for a bubble of `R_REF` radius. Bubbles this size rise at a few
 * tenths of a metre per second and barely vary — they get faster mostly by getting bigger. */
const RISE_REF = 0.26;
const R_REF = 0.011;

/** How much of the water's horizontal velocity a bubble picks up, and how fast it gets there. */
const FLOW_FOLLOW = 0.92;
const FLOW_RELAX = 1.7;

/**
 * Seconds before a bubble gives up even if it never reached the surface.
 *
 * This is a backstop against a leaked slot, not a lifetime: it has to be longer than the real
 * journey or bubbles wink out in mid-water, which is exactly what the first value did. At the
 * rise speeds below, a bubble born at 30 m takes about 85 seconds to surface — it starts slow
 * and speeds up as it expands — so anything under that was killing deep ones halfway home.
 */
const MAX_LIFE = 110;

/** Absolute pressure in atmospheres at height `y` (y is negative under water). */
const ata = (y: number): number => 1 + Math.max(0, -y) / 10;

export interface DiverBubbles {
  points: THREE.Points;
  /**
   * One frame. `state` is null whenever there is no diver in the water — bubbles already up
   * keep rising and surfacing on their own, which is what you want when the dive has just ended.
   */
  update(dt: number, state: DiverState | null, events: readonly DiverEvent[], simTime: number): void;
  /** VERIFICATION ONLY. */
  debug(): { live: number; rate: number; meanRadius: number; deepest: number };
  dispose(): void;
}

export function createDiverBubbles(pixelRatio = 1): DiverBubbles {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAX * 3);
  const alpha = new Float32Array(MAX);
  const psize = new Float32Array(MAX);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('psize', new THREE.BufferAttribute(psize, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  // Same point shader as the seeps, so one diver's breath and the reef's own venting read as the
  // same substance: a bright rim, a clear middle and a small highlight.
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uPR: { value: pixelRatio } },
    vertexShader: `
      attribute float alpha; attribute float psize; uniform float uPR; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vA = alpha * smoothstep(0.08, 0.4, -mv.z);
        gl_PointSize = min(psize * uPR * (420.0 / max(-mv.z, 0.3)), 56.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5; float d = length(c);
        if (d > 0.5) discard;
        float rim = smoothstep(0.5, 0.34, d) * (0.35 + 0.65 * smoothstep(0.2, 0.46, d));
        float hl = smoothstep(0.12, 0.0, length(c - vec2(-0.14, 0.14))) * 0.5;
        gl_FragColor = vec4(vec3(0.88, 0.97, 1.0), (rim + hl) * vA);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;

  const age = new Float32Array(MAX).fill(-1);  // -1 = free
  const vel = new Float32Array(MAX * 3);
  const r0 = new Float32Array(MAX);            // radius at birth
  const p0 = new Float32Array(MAX);            // pressure (ATA) at birth
  const wobA = new Float32Array(MAX);
  const wobF = new Float32Array(MAX);
  const wobP = new Float32Array(MAX);

  let cursor = 0;
  let spawnAcc = 0;
  /** Deepest point reached since the last equalisation, for the descent puffs. */
  let lastEqDepth = 0;
  let lastRate = 0;

  function spawn(x: number, y: number, z: number, r: number): void {
    // Ring buffer: the oldest bubble is the one that gets recycled under pressure, which is the
    // least noticeable thing to lose.
    let i = -1;
    for (let n = 0; n < MAX; n++) {
      const k = (cursor + n) % MAX;
      if (age[k] < 0) { i = k; break; }
    }
    if (i < 0) { i = cursor; }
    cursor = (i + 1) % MAX;

    const o = i * 3;
    age[i] = 0;
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
    vel[o] = 0; vel[o + 1] = 0; vel[o + 2] = 0;
    r0[i] = r;
    p0[i] = ata(y);
    wobA[i] = 0.05 + Math.random() * 0.12;
    wobF[i] = 1.6 + Math.random() * 2.4;
    wobP[i] = Math.random() * Math.PI * 2;
  }

  /** A burst from the mouth, scattered a little so it does not read as one object. */
  function puff(n: number, x: number, y: number, z: number, rMin: number, rMax: number): void {
    for (let k = 0; k < n; k++) {
      spawn(
        x + (Math.random() - 0.5) * 0.16,
        y + (Math.random() - 0.5) * 0.08,
        z + (Math.random() - 0.5) * 0.16,
        rMin + Math.random() * (rMax - rMin),
      );
    }
  }

  function update(dt: number, state: DiverState | null, events: readonly DiverEvent[], simTime: number): void {
    const h = Math.min(0.05, Math.max(0, dt));

    if (state) {
      // The mouth: a little forward of the body origin along the look direction, at about the
      // height the mask sits (entities/diver/model.ts puts the head at z -0.62, y +0.04).
      const cp = Math.cos(state.pitch);
      const fx = -Math.sin(state.yaw) * cp, fy = Math.sin(state.pitch), fz = -Math.cos(state.yaw) * cp;
      const mx = state.x + fx * 0.5, my = state.y + 0.12 + fy * 0.5, mz = state.z + fz * 0.5;
      const depth = Math.max(0, -state.y);

      if (depth > 0.4) {
        // Equalising on the way down. Tracked against the deepest point reached rather than a
        // timer, because it is depth that forces it — hang at 12 m and you stop clearing.
        if (depth > lastEqDepth + EQ_STEP_M) {
          lastEqDepth = depth;
          puff(4 + Math.floor(Math.random() * 4), mx, my, mz, 0.004, 0.011);
        } else if (depth < lastEqDepth - EQ_STEP_M * 2) {
          lastEqDepth = depth; // came back up; the next descent clears again
        }

        // The steady leak.
        const airFrac = state.airMax > 0 ? Math.max(0, Math.min(1, state.air / state.airMax)) : 0;
        const want = 1 - airFrac;
        lastRate = LEAK_BASE + LEAK_LOW_AIR * want * want + LEAK_EXERTION * state.exertion;
        spawnAcc += lastRate * h;
        while (spawnAcc >= 1) {
          spawnAcc -= 1;
          puff(1, mx, my, mz, 0.003, 0.009);
        }
        if (spawnAcc > 2) spawnAcc = 2;
      } else {
        lastEqDepth = 0;
        lastRate = 0;
      }

      for (const ev of events) {
        // Breaking the surface: the held breath finally comes out, all of it.
        if (ev.type === 'surfaced') puff(24, mx, my - 0.1, mz, 0.006, 0.02);
        // The lungs letting go. The loudest thing that can happen on a dive, and the last.
        if (ev.type === 'blackout') puff(44, mx, my, mz, 0.006, 0.024);
      }
    } else {
      lastRate = 0;
    }

    // One flow sample for the whole stream: the field varies over hundreds of metres and a
    // bubble trail is a few metres across. Same simplification the snow and the seeps make.
    const sx = state ? state.x : pos[0], sz = state ? state.z : pos[2];
    const flow = currentAt(sx, sz, simTime, Math.max(0, state ? -state.y : 0));
    const fvx = flow.vx * FLOW_FOLLOW, fvz = flow.vz * FLOW_FOLLOW;
    const relax = Math.min(1, h * FLOW_RELAX);

    let live = 0, rSum = 0, deepest = 0;
    for (let i = 0; i < MAX; i++) {
      if (age[i] < 0) { alpha[i] = 0; continue; }
      const o = i * 3;
      age[i] += h;

      // Boyle: the bubble holds its gas, so its radius follows the cube root of the pressure
      // ratio between where it was born and where it is now.
      const r = r0[i] * Math.cbrt(p0[i] / ata(pos[o + 1]));
      // Bigger bubbles rise faster — this is why a stream fans out and speeds up as it climbs.
      const rise = Math.min(0.46, RISE_REF * Math.sqrt(r / R_REF));

      vel[o] += (fvx - vel[o]) * relax;
      vel[o + 2] += (fvz - vel[o + 2]) * relax;
      // The zigzag. Anything above about a millimetre refuses to rise in a straight line.
      const w = wobF[i] * (simTime + wobP[i]);
      pos[o] += (vel[o] + Math.cos(w) * wobA[i]) * h;
      pos[o + 1] += rise * h;
      pos[o + 2] += (vel[o + 2] + Math.sin(w * 0.9) * wobA[i]) * h;

      if (pos[o + 1] > -0.06 || age[i] > MAX_LIFE) { age[i] = -1; alpha[i] = 0; continue; }

      psize[i] = r;
      // Fade in over the first instants so a spawn does not pop, and out at the very end of life.
      alpha[i] = Math.min(1, age[i] * 6) * (age[i] > MAX_LIFE - 2 ? (MAX_LIFE - age[i]) / 2 : 1) * 0.9;
      live++; rSum += r;
      if (-pos[o + 1] > deepest) deepest = -pos[o + 1];
    }

    points.visible = live > 0;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
    geo.attributes.psize.needsUpdate = true;

    lastLive = live;
    lastMeanR = live ? rSum / live : 0;
    lastDeepest = deepest;
  }

  let lastLive = 0, lastMeanR = 0, lastDeepest = 0;

  return {
    points,
    update,
    debug: () => ({
      live: lastLive,
      rate: +lastRate.toFixed(2),
      meanRadius: +lastMeanR.toFixed(4),
      deepest: +lastDeepest.toFixed(2),
    }),
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
