/**
 * Day/sunset blending: sky palette, sun/hemi lights, fog, water sky-reflection colour, sun disc,
 * clouds and any day/night-crossfaded materials (boat underwater + nav lights).
 *
 * Ported faithfully from legacy/index.html:948-969. Legacy's `CITY_U`/Miami window-lighting is
 * out of scope (see docs/ARCHITECTURE.md Phase 0 scope — Miami is explicitly excluded) and is
 * dropped; `LIGHT_MATS`'s day/night opacity crossfade is kept because the boat's own underwater
 * and navigation lights use it (see entities/boat/model.ts).
 */
import * as THREE from 'three';
import { lerp } from './math.js';
import type { SceneCtx, SkyPalette } from './scene.js';
import { toast } from '../ui/toast.js';

const C3 = (h: number): THREE.Color => new THREE.Color(h);

interface TodPalette extends SkyPalette {
  name: string;
  sun: THREE.Vector3;
  fog: THREE.Color;
  sunC: THREE.Color; sunI: number;
  hS: THREE.Color; hG: THREE.Color; hI: number;
  sky: THREE.Color; disc: THREE.Color; discS: number;
  cloud: THREE.Color; cloudE: THREE.Color;
}

const TOD_P: [TodPalette, TodPalette] = [
  {
    name: 'Day', sun: new THREE.Vector3(0.55, 0.32, -0.62).normalize(), top: C3(0x2a76c2), mid: C3(0x7fb0d8), hor: C3(0xc9e4ee), warm: C3(0xffd7a0), glowPow: 6, glowK: 0.55, fog: C3(0xc9e4ee),
    sunC: C3(0xfff0d6), sunI: 1.05, hS: C3(0xd6efff), hG: C3(0x2b7088), hI: 0.7, sky: C3(0xb9d9e8), disc: C3(0xfff3cf), discS: 1, cloud: C3(0xffffff), cloudE: C3(0x8a99a6),
  },
  {
    name: 'Sunset', sun: new THREE.Vector3(-0.9, 0.06, -0.42).normalize(), top: C3(0x23305e), mid: C3(0x9a5f8e), hor: C3(0xf7a463), warm: C3(0xff6a2a), glowPow: 3, glowK: 0.85, fog: C3(0xd99a86),
    sunC: C3(0xff9a5a), sunI: 0.95, hS: C3(0xffb98a), hG: C3(0x2c3a62), hI: 0.55, sky: C3(0xe9a07e), disc: C3(0xffb36a), discS: 1.8, cloud: C3(0xffc4a4), cloudE: C3(0xa0507a),
  },
];

export interface LightMatEntry { m: { opacity: number }; day: number; night: number }

export interface TimeOfDayController {
  lightMats: LightMatEntry[];
  setCloudMat(m: THREE.MeshStandardMaterial | null): void;
  update(dt: number): void;
  toggleSunset(onLabel?: (label: string) => void): void;
  /** Current day(0)/sunset(1) blend — legacy's module-level `TOD.k`. Boats read this for their
   * cockpit mood-light crossfade (entities/boat/visuals.ts); see index.html:3289. */
  getK(): number;
}

export function createTimeOfDay(ctx: SceneCtx, waterSky: { value: THREE.Color }): TimeOfDayController {
  const { sunDir, paintSky, scene, renderer, sun, hemi, sunDisc } = ctx;
  const fog = scene.fog as THREE.Fog;
  const lightMats: LightMatEntry[] = [];
  let cloudMat: THREE.MeshStandardMaterial | null = null;
  const state = { k: 0, target: 0, dirty: true };

  function applyTOD(k: number): void {
    const A = TOD_P[0], B = TOD_P[1];
    const L = (a: THREE.Color, b: THREE.Color) => a.clone().lerp(b, k);
    sunDir.copy(A.sun).lerp(B.sun, k).normalize();
    paintSky({ top: L(A.top, B.top), mid: L(A.mid, B.mid), hor: L(A.hor, B.hor), warm: L(A.warm, B.warm), glowPow: lerp(A.glowPow, B.glowPow, k), glowK: lerp(A.glowK, B.glowK, k) });
    fog.color.copy(L(A.fog, B.fog));
    renderer.setClearColor(fog.color);
    sun.color.copy(L(A.sunC, B.sunC));
    sun.intensity = lerp(A.sunI, B.sunI, k);
    hemi.color.copy(L(A.hS, B.hS));
    hemi.groundColor.copy(L(A.hG, B.hG));
    hemi.intensity = lerp(A.hI, B.hI, k);
    waterSky.value.copy(L(A.sky, B.sky));
    sunDisc.material = sunDisc.material as THREE.MeshBasicMaterial;
    (sunDisc.material as THREE.MeshBasicMaterial).color.copy(L(A.disc, B.disc));
    sunDisc.scale.setScalar(lerp(A.discS, B.discS, k));
    if (cloudMat) {
      cloudMat.color.copy(L(A.cloud, B.cloud));
      cloudMat.emissive.copy(L(A.cloudE, B.cloudE));
    }
    lightMats.forEach((o) => { o.m.opacity = lerp(o.day, o.night, k); });
  }

  function updateTOD(dt: number): void {
    if (!state.dirty && state.k === state.target) return;
    state.dirty = false;
    state.k = state.target > state.k ? Math.min(state.target, state.k + dt / 3) : Math.max(state.target, state.k - dt / 3);
    applyTOD(state.k);
  }

  // Apply the initial (day) palette once at boot, same as legacy's implicit initial render.
  applyTOD(state.k);

  return {
    lightMats,
    setCloudMat(m) { cloudMat = m; },
    update: updateTOD,
    getK() { return state.k; },
    toggleSunset() {
      state.target = state.target ? 0 : 1;
      state.dirty = true;
      toast(state.target ? 'Sunset mode — golden hour over the Seven Mile Bridge.' : 'Back to daytime.');
      const b = document.getElementById('btnSun');
      if (b) b.textContent = state.target ? '☀️' : '🌅';
    },
  };
}
