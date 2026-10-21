/**
 * Seep bubbles: thin columns of small bubbles rising off the seafloor around the diver, leaning
 * downstream with the current.
 *
 * Why this exists: the current is modelled (shared/world/current.ts) and already moves weeds and
 * marine snow, but a diver drifting with the water sees nothing move relative to the water — and
 * snow specks are single points with no length, so even where they do move there is no line to
 * read direction off. A bubble stream is the one cue that shows the flow as a SHAPE: it leaves the
 * bottom vertical and bends over as it rises, the bend is the flow vector, and in surge it visibly
 * whips back and forth with the 7.5 s wave. Real reefs have exactly these (gas seeps, sand-borne
 * air, sponges venting); the placement here is cosmetic and deterministic per 16 m cell.
 *
 * Self-contained pooled `THREE.Points`, same family as marine-snow.ts / shaft.ts's muzzle bubbles.
 * Bubbles are NOT neutrally buoyant in the horizontal sense — they lag the water a little — hence
 * `FLOW_FOLLOW` < 1 and a relaxation time rather than setting velocity = flow.
 */
import * as THREE from 'three';
import { currentAt } from '@keysrun/shared/world/current';
import { depthAt } from '@keysrun/shared/world/depth';
import { seafloorHeightAt } from '../terrain/heightfield.js';

const CELL = 16; // metres between candidate emitter sites
const CELL_REACH = 2; // cells scanned each side of the camera (visibility is ~10-30 m)
const EMITTER_P = 0.3; // fraction of cells that vent
const MAX_EMITTERS = 8;
const PER_EMITTER = 34;
const TOTAL = MAX_EMITTERS * PER_EMITTER;
const RISE_SPEED = 0.3; // m/s, small-bubble terminal rise
const FLOW_FOLLOW = 0.92; // fraction of the water's speed a bubble reaches
const FLOW_RELAX = 1.6; // 1/s — how fast horizontal velocity chases the flow
const MIN_FLOOR_DEPTH = 1.8; // don't vent in the skinny flats
const RESCAN_DIST = 5;

const hash = (a: number, b: number, s: number): number => {
  const h = Math.sin(a * 127.1 + b * 311.7 + s * 74.7) * 43758.5453;
  return h - Math.floor(h);
};

export interface SeepBubbles {
  points: THREE.Points;
  /** `amount` 0..1 is how underwater the camera is (transition.underwaterAmount()). */
  update(dt: number, cameraPos: THREE.Vector3, simTime: number, amount: number): void;
  dispose(): void;
}

interface Emitter { key: string; x: number; y: number; z: number; rate: number }

export function createSeepBubbles(pixelRatio = 1): SeepBubbles {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(TOTAL * 3);
  const alpha = new Float32Array(TOTAL);
  const size = new Float32Array(TOTAL);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('psize', new THREE.BufferAttribute(size, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uPR: { value: pixelRatio } },
    vertexShader: `
      attribute float alpha; attribute float psize; uniform float uPR; varying float vA;
      void main() {
        vA = alpha * smoothstep(0.1, 0.5, -(modelViewMatrix * vec4(position, 1.0)).z);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(psize * uPR * (420.0 / max(-mv.z, 0.3)), 40.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5; float d = length(c);
        if (d > 0.5) discard;
        // bright rim, clear-ish middle, and a small highlight — reads as a bubble, not a dot
        float rim = smoothstep(0.5, 0.34, d) * (0.35 + 0.65 * smoothstep(0.2, 0.46, d));
        float hl = smoothstep(0.12, 0.0, length(c - vec2(-0.14, 0.14))) * 0.5;
        gl_FragColor = vec4(vec3(0.86, 0.96, 1.0), (rim + hl) * vA);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;

  // Per-bubble state. `slot / PER_EMITTER` is the emitter index, so each emitter owns a fixed ring.
  const age = new Float32Array(TOTAL).fill(-1); // -1 = unborn/dead
  const life = new Float32Array(TOTAL);
  const vel = new Float32Array(TOTAL * 3);
  const emitters: Emitter[] = [];
  let lastScanX = Infinity, lastScanZ = Infinity;
  const spawnAcc = new Float32Array(MAX_EMITTERS);

  function rescan(cx: number, cz: number): void {
    const cands: Array<Emitter & { d: number }> = [];
    const ix = Math.floor(cx / CELL), iz = Math.floor(cz / CELL);
    for (let j = -CELL_REACH; j <= CELL_REACH; j++) {
      for (let i = -CELL_REACH; i <= CELL_REACH; i++) {
        const gx = ix + i, gz = iz + j;
        if (hash(gx, gz, 1) > EMITTER_P) continue;
        const x = (gx + 0.15 + hash(gx, gz, 2) * 0.7) * CELL, z = (gz + 0.15 + hash(gx, gz, 3) * 0.7) * CELL;
        if (depthAt(x, z) < MIN_FLOOR_DEPTH) continue;
        cands.push({ key: `${gx},${gz}`, x, y: seafloorHeightAt(x, z), z, rate: 4 + hash(gx, gz, 4) * 6, d: Math.hypot(x - cx, z - cz) });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    const next = cands.slice(0, MAX_EMITTERS);
    // Keep an emitter in the SAME slot when it survives the rescan, so its live bubbles don't
    // teleport to a different vent; only slots whose emitter changed are cleared.
    const slotOf: Array<Emitter | null> = new Array(MAX_EMITTERS).fill(null);
    const placed = new Set<string>();
    for (let s = 0; s < MAX_EMITTERS; s++) {
      const old = emitters[s];
      const keep = old && next.find((n) => n.key === old.key);
      if (keep) { slotOf[s] = keep; placed.add(keep.key); }
    }
    for (const n of next) {
      if (placed.has(n.key)) continue;
      const free = slotOf.indexOf(null);
      if (free < 0) break;
      slotOf[free] = n; placed.add(n.key);
      for (let b = 0; b < PER_EMITTER; b++) age[free * PER_EMITTER + b] = -1;
    }
    for (let s = 0; s < MAX_EMITTERS; s++) {
      const e = slotOf[s];
      if (e) emitters[s] = e;
      else { delete emitters[s]; for (let b = 0; b < PER_EMITTER; b++) age[s * PER_EMITTER + b] = -1; }
    }
  }

  function update(dt: number, cam: THREE.Vector3, simTime: number, amount: number): void {
    if (amount <= 0.01 || cam.y > -0.4) { points.visible = false; return; }
    points.visible = true;
    if (Math.hypot(cam.x - lastScanX, cam.z - lastScanZ) > RESCAN_DIST) {
      lastScanX = cam.x; lastScanZ = cam.z;
      rescan(cam.x, cam.z);
    }
    // One flow sample at the viewer, as for marine snow and the weeds: the field varies over
    // hundreds of metres and the whole scene here is ~40 m across.
    const flow = currentAt(cam.x, cam.z, simTime, Math.max(0, -cam.y));
    const fvx = flow.vx * FLOW_FOLLOW, fvz = flow.vz * FLOW_FOLLOW;
    const relax = Math.min(1, dt * FLOW_RELAX);

    for (let s = 0; s < MAX_EMITTERS; s++) {
      const e = emitters[s];
      if (!e) { for (let b = 0; b < PER_EMITTER; b++) alpha[s * PER_EMITTER + b] = 0; continue; }
      spawnAcc[s] += e.rate * dt;
      for (let b = 0; b < PER_EMITTER; b++) {
        const i = s * PER_EMITTER + b, o = i * 3;
        if (age[i] < 0) {
          if (spawnAcc[s] < 1) { alpha[i] = 0; continue; }
          spawnAcc[s] -= 1;
          age[i] = 0; life[i] = 3.2 + Math.random() * 3;
          pos[o] = e.x + (Math.random() - 0.5) * 0.25; pos[o + 1] = e.y + 0.05; pos[o + 2] = e.z + (Math.random() - 0.5) * 0.25;
          vel[o] = 0; vel[o + 1] = RISE_SPEED * (0.75 + Math.random() * 0.5); vel[o + 2] = 0;
          size[i] = 0.018 + Math.random() * 0.03;
        }
        age[i] += dt;
        // horizontal: chase the water's velocity; vertical: buoyant rise, a little faster as the
        // bubble expands on the way up
        vel[o] += (fvx - vel[o]) * relax;
        vel[o + 2] += (fvz - vel[o + 2]) * relax;
        pos[o] += vel[o] * dt; pos[o + 1] += vel[o + 1] * dt * (1 + age[i] * 0.06); pos[o + 2] += vel[o + 2] * dt;
        if (age[i] > life[i] || pos[o + 1] > -0.1) { age[i] = -1; alpha[i] = 0; continue; }
        const u = age[i] / life[i];
        alpha[i] = Math.min(1, age[i] * 4) * (1 - u * u) * 0.75 * amount;
        size[i] += dt * 0.004;
      }
      // unspent fraction must not pile up while every slot is busy
      if (spawnAcc[s] > 2) spawnAcc[s] = 2;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
    geo.attributes.psize.needsUpdate = true;
  }

  return { points, update, dispose() { geo.dispose(); mat.dispose(); } };
}
