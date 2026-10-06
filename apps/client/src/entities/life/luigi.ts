/**
 * Luigi mode: trimmed all the way up on plane — a rooster tail thrown off the props, beers up for
 * everyone aboard, an air horn + crowd roar + hype-man callout, and the screen itself going hazy.
 *
 * Ported faithfully from legacy/index.html:3607-3712 (`LUIGI`, `beerCan`, `luigiPeople`,
 * `luigiStart`/`luigiEnd`/`luigiCleanup`, `roosterTex`/`makeRooster`, `updateLuigi`). The audio
 * half (air horn, crowd roar, ducking the radio, the hype-man speech lines) is already fully
 * ported in `audio/music/dj.ts` — this module just calls `deps.hypeCallout()` at the trigger
 * moment rather than reimplementing it.
 *
 * Deliberately **not** ported: `travelMiami`/`btnMiami` (the Keys<->Miami quick-travel) and
 * `shiftGear`/`GEAR`, which sit textually inside this same legacy block (3660-3672) but are a
 * separate feature from "Luigi mode" (boat gear-shifting is already live via
 * `entities/boat/input.ts`'s `toggleEngine`/`shiftGear` callbacks in `game/world.ts`, and Miami
 * isn't in the task brief or built anywhere else in this port — see docs/ARCHITECTURE.md's Phase
 * 0 scope).
 *
 * `capMode` (legacy's helm-vs-other-view flag gating the captain's beer pose) has no equivalent
 * here — `entities/camera.ts` doesn't expose anything like it to this task's deliberately
 * decoupled module. The captain's beer pose is applied unconditionally instead; a cosmetic
 * simplification, not a functional gap (Luigi mode itself still fully engages regardless).
 */
import * as THREE from 'three';
import type { BoatModel } from '../boat/model.js';
import type { Human } from './human.js';
import { clamp, lerp, rand } from '../../core/math.js';

const beerMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 0.8, roughness: 0.25 });
const beerTopMat = new THREE.MeshStandardMaterial({ color: 0x2f6fd0, metalness: 0.5, roughness: 0.35 });

/** legacy `beerCan` (index.html:3610). */
function beerCan(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.12, 12), beerMat));
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.05, 12), beerTopMat);
  top.position.y = 0.01;
  g.add(top);
  return g;
}

interface LuigiPerson { h: Human; cap?: boolean; party?: boolean }

function luigiPeople(model: BoatModel): LuigiPerson[] {
  const L: LuigiPerson[] = [{ h: model.captain, cap: true }, { h: model.crew }];
  for (const P of model.party) L.push({ h: P.h, party: true });
  return L;
}

/** legacy `roosterTex` (index.html:3640-3643): a streaky white-water canvas texture, scrolled
 * along the sheet every frame for the sense of flow. */
function roosterTex(): THREE.CanvasTexture {
  const W = 128, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d')!;
  x.clearRect(0, 0, W, H);
  for (let k = 0; k < 420; k++) {
    const cx = Math.random() * W, w = rand(1.5, 6), y0 = Math.random() * H, l = rand(20, 90), a = rand(0.15, 0.6);
    const gr = x.createLinearGradient(0, y0, 0, y0 + l);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, `rgba(255,255,255,${a})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr;
    x.fillRect(cx - w / 2, y0, w, l);
    x.fillRect(cx - w / 2, y0 - H, w, l);
  }
  const ed = x.getImageData(0, 0, W, H), d = ed.data;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const e = Math.min(1, Math.min(i, W - 1 - i) / (W * 0.28));
    const o = (j * W + i) * 4;
    d[o + 3] *= e * e * (3 - 2 * e);
    d[o] = d[o + 1] = d[o + 2] = 255;
  }
  x.putImageData(ed, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 2);
  return t;
}

interface Rooster {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  tex: THREE.CanvasTexture; tex2: THREE.CanvasTexture;
  yAt(u: number): number;
  wAt(u: number): number;
}

/** legacy `makeRooster` (index.html:3644-3659): a curved ribbon of streaky white water. */
function makeRooster(): Rooster {
  const NU = 28, NV = 8;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const yAt = (u: number): number => { const a = Math.min(1, u / 0.42); return u < 0.42 ? Math.sin(a * Math.PI / 2) * (1 - 0.05 * (1 - a)) : Math.max(0, 1 - Math.pow((u - 0.42) / 0.58, 2) * 1.02); };
  const wAt = (u: number): number => 0.12 + 1.1 * Math.pow(u, 0.8);
  for (let i = 0; i <= NU; i++) {
    const u = i / NU;
    for (let j = 0; j <= NV; j++) { const v = j / NV - 0.5; pos.push(v * 2 * wAt(u), yAt(u), u); uv.push(j / NV, u); }
  }
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) { const a = i * (NV + 1) + j, b = a + NV + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  // fade the sheet in at the props and out as it falls
  const al: number[] = [];
  for (let i = 0; i <= NU; i++) {
    const u = i / NU, a = Math.min(1, u / 0.06) * (u > 0.7 ? Math.max(0, 1 - (u - 0.7) / 0.3) : 1);
    for (let j = 0; j <= NV; j++) al.push(a, a, a);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(al, 3));
  const tex = roosterTex(), tex2 = roosterTex();
  // ⚠ r186 blends transparent sprites in correct linear light (unlike r128's gamma-space
  // blending) — a vertex-colour alpha multiplied straight onto an already-premultiplied-looking
  // alphaMap read twice as hot here as it did pre-upgrade (see this project's wake-foam/sea-fan
  // reports for the same class of bug). `transparent` + `depthWrite:false` + an explicit `opacity`
  // ramp (set every frame below, never above ~0.9) keeps this sheet from saturating to a flat
  // white card the way an unclamped double-multiply would.
  const mat = new THREE.MeshBasicMaterial({ map: tex, alphaMap: tex2, color: 0xf4f8fb, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.a*=vColor.r; diffuseColor.rgb=mix(vec3(.93,.96,.98),diffuseColor.rgb,.4);');
  };
  const mesh = new THREE.Mesh(g, mat);
  mesh.visible = false; mesh.renderOrder = 3; mesh.frustumCulled = false;
  return { mesh, mat, tex, tex2, yAt, wAt };
}

export interface LuigiTriggerInputs {
  /** `TRIM.v`, 0..1. */
  trimV: number;
  /** Signed boat speed, m/s. */
  speed: number;
  lineOut: boolean;
  /** `F.state==='caught'`. */
  fishCaught: boolean;
}

export interface LuigiDeps {
  /** `audio/music/radio.ts`'s `MusicController.hypeCallout()` — the air horn/crowd-roar/hype-man
   * callout and the radio duck, already fully implemented; see this module's header. */
  hypeCallout(): void;
  particles: import('../../world/particles.js').ParticleSystem;
}

export interface LuigiMode {
  isOn(): boolean;
  /** 0 (off) .. 1 (fully engaged) — for anything else that wants to react (none currently). */
  intensity(): number;
  update(dt: number, t: number, model: BoatModel, boatLen: number, inputs: LuigiTriggerInputs, camera: THREE.PerspectiveCamera, rendererEl: HTMLCanvasElement): void;
  dispose(): void;
}

export function createLuigiMode(deps: LuigiDeps): LuigiMode {
  let on = false, k = 0, cool = 0, held = 0;
  const saved = new Map<Human, [THREE.Vector3, THREE.Vector3]>();
  const roosters = new WeakMap<BoatModel, Rooster>();
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  const hazeEl = document.getElementById('haze');
  const luigiEl = document.getElementById('luigi');

  function start(model: BoatModel): void {
    on = true; held = 0;
    if (luigiEl) { luigiEl.classList.remove('show'); void luigiEl.offsetWidth; luigiEl.classList.add('show'); }
    deps.hypeCallout();
    // everyone grabs a beer
    for (const p of luigiPeople(model)) {
      const h = p.h;
      if (!h.hands.length || h.beer) continue;
      const can = beerCan();
      h.group.add(can);
      h.beer = can;
      if (h._pose && !p.party && !p.cap) saved.set(h, [h._pose[0].clone(), h._pose[1].clone()]);
    }
  }
  function end(): void { on = false; held = 6; }
  function cleanup(model: BoatModel): void {
    for (const p of luigiPeople(model)) {
      const h = p.h;
      h.sipAmt = 0; h.sip = 0;
      if (h.head) h.head.rotation.x = 0;
      if (h.beer) { h.group.remove(h.beer); h.beer = null; }
      const sv = saved.get(h);
      if (sv) h.pose(sv[0], sv[1]);
    }
    saved.clear();
  }

  return {
    isOn(): boolean { return on; },
    intensity(): number { return k; },
    update(dt, t, model, boatLen, inputs, camera, rendererEl) {
      // (legacy also computed a `planing` local here that nothing downstream ever read — dropped)
      const want = inputs.trimV >= 0.97 && Math.abs(inputs.speed) > 8 && !inputs.lineOut && !inputs.fishCaught;
      cool = Math.max(0, cool - dt);
      if (want && !on && cool <= 0) start(model);
      if (on && (inputs.trimV < 0.9 || Math.abs(inputs.speed) < 5 || inputs.lineOut)) { end(); cool = 3; }
      if (!on && held > 0) { held -= dt; if (held <= 0) cleanup(model); }
      k = lerp(k, on ? 1 : 0, Math.min(1, dt * (on ? 0.8 : 0.5)));

      // beers in hand: raised for a toast, and every few seconds a pull off the can
      luigiPeople(model).forEach((p, i) => {
        const h = p.h;
        if (!h.beer) return;
        h.sipT = (h.sipT ?? rand(0.6, 2)) - dt;
        if (h.sipT <= 0 && !(h.sip > 0)) { h.sip = 1.4; h.sipT = rand(2.2, 4.5); }
        if (h.sip > 0) h.sip = Math.max(0, h.sip - dt);
        const sa = h.sip > 0 ? Math.sin(Math.PI * (1 - h.sip / 1.4)) : 0;
        h.sipAmt = sa;
        const up = 0.06 * Math.sin(t * 2.2 + i) * (1 - sa), mouth = V(0.05, h.hipY + 0.71, 0.15);
        // legacy gates the captain's beer pose on `capMode==='helm'` — see this module's header
        // for why that flag has no equivalent here; applied unconditionally instead.
        if (p.cap) h.pose(model.helmPose[0], V(0.24, h.hipY + 0.62 + up, 0.18).lerp(mouth, sa));
        else if (!p.party) h.pose(V(-0.18, h.hipY + 0.2, 0.25), V(0.26, h.hipY + 0.95 + up, 0.12).lerp(mouth, sa));
        const hd = h.hands[1];
        if (hd && h.beer) {
          h.beer.position.copy(hd.position).add(V(0, 0.04, 0));
          h.beer.rotation.set(-2.1 * sa, 0, 0.3 * sa);
        }
        if (h.head) h.head.rotation.x = -0.4 * sa;
      });

      // rooster tail: a solid sheet of water thrown up off the props in a tight arc
      let R = roosters.get(model);
      if (!R) { R = makeRooster(); model.group.add(R.mesh); roosters.set(model, R); }
      {
        const sp = Math.abs(inputs.speed), kk = k * clamp((sp - 6) / 14, 0, 1);
        R.mesh.visible = kk > 0.02;
        R.mat.opacity = 0.9 * kk;
        R.tex.offset.y -= dt * (1.2 + sp * 0.06);
        R.tex2.offset.y -= dt * (0.9 + sp * 0.05);
        const Hh = (2.5 + 6 * clamp(sp / 32, 0, 1)) * kk, Dl = 8 + sp * 0.55;
        R.mesh.position.set(0, -0.15, boatLen / 2 + 0.55);
        R.mesh.scale.set(1 + 0.4 * kk, Math.max(0.01, Hh), Dl);
        if (kk > 0.05) {
          model.group.updateMatrixWorld(true);
          const boatPos = model.group.position, boatH = model.group.rotation.y;
          const fx = -Math.sin(boatH), fz = -Math.cos(boatH), rx = Math.cos(boatH), rz = -Math.sin(boatH);
          const pt = (u: number, lat: number): [number, number, number] => {
            const y = Hh * R!.yAt(u) - 0.15, d = boatLen / 2 + 0.55 + Dl * u;
            return [boatPos.x - fx * d + rx * lat, y, boatPos.z - fz * d + rz * lat];
          };
          for (let n = 0; n < Math.ceil(dt * 45 * kk); n++) {
            const u = rand(0.3, 0.6), w = R.wAt(u), [x, y, z] = pt(u, rand(-w, w) * 0.5);
            deps.particles.spawnP(x, y, z, fx * sp * rand(0.45, 0.65) + rx * rand(-1, 1), rand(-0.5, 2.5), fz * sp * rand(0.45, 0.65) + rz * rand(-1, 1), rand(0.6, 1.1), rand(0.12, 0.3), 0.85, true);
          }
          if (Math.random() < dt * 14 * kk) {
            const u = rand(0.35, 0.75), [x, y, z] = pt(u, rand(-1, 1));
            deps.particles.spawnP(x, y + 0.5, z, fx * sp * 0.62 + rx * rand(-1.5, 1.5), rand(0.2, 1.2), fz * sp * 0.62 + rz * rand(-1.5, 1.5), rand(1.8, 3), rand(2.5, 4.5), 0.22, false);
          }
          if (Math.random() < dt * 22 * kk) {
            const u = rand(0.85, 1), w = R.wAt(u), [x, , z] = pt(u, rand(-w, w) * 0.7);
            deps.particles.splash(x, z, 3, 0.5);
            deps.particles.spawnP(x, 0.15, z, fx * sp * 0.6, rand(0.5, 1.5), fz * sp * 0.6, rand(0.8, 1.4), rand(1.2, 2.2), 0.45, false);
          }
        }
      }

      // the screen goes hazy and swims a little
      rendererEl.style.filter = k > 0.02 ? `blur(${(1.4 * k).toFixed(2)}px) saturate(${(1 + 0.35 * k).toFixed(2)}) brightness(${(1 + 0.06 * k).toFixed(2)})` : '';
      if (hazeEl) hazeEl.style.opacity = (k * 0.85).toFixed(2);
      if (k > 0.02) {
        camera.rotateZ(Math.sin(t * 0.7) * 0.035 * k);
        camera.rotateY(Math.sin(t * 0.43) * 0.02 * k);
        camera.rotateX(Math.sin(t * 0.53 + 1) * 0.012 * k);
      }
    },
    dispose(): void {
      if (hazeEl) hazeEl.style.opacity = '0';
      if (luigiEl) luigiEl.classList.remove('show');
    },
  };
}
