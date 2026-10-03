/**
 * Renderer, scene, sky dome and lighting.
 *
 * Ported faithfully from legacy/index.html:577-608. `paintSky` vertex-paints the sky dome from
 * a time-of-day palette (see core/time-of-day.ts); `sunDisc` and `sun`/`hemi` are driven the
 * same way every frame.
 */
import * as THREE from 'three';
import { clamp } from './math.js';

export const isTouch = (): boolean =>
  typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);

export interface SceneCtx {
  wrap: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sunDir: THREE.Vector3;
  sky: THREE.Mesh;
  sunDisc: THREE.Mesh;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  paintSky: (p: SkyPalette) => void;
}

export interface SkyPalette {
  top: THREE.Color; mid: THREE.Color; hor: THREE.Color; warm: THREE.Color;
  glowPow: number; glowK: number;
}

/** legacy/index.html:593-597 `paintSky`. */
function makePaintSky(skyGeo: THREE.SphereGeometry, sunDir: THREE.Vector3): (p: SkyPalette) => void {
  const v = new THREE.Vector3(), c = new THREE.Color();
  return (P: SkyPalette) => {
    const pos = skyGeo.attributes.position, ca = skyGeo.attributes.color;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
      const t = clamp(v.y, 0, 1);
      if (t < 0.3) c.copy(P.hor).lerp(P.mid, Math.pow(t / 0.3, 0.8));
      else c.copy(P.mid).lerp(P.top, Math.pow((t - 0.3) / 0.7, 0.7));
      const s2 = Math.max(0, v.dot(sunDir));
      c.lerp(P.warm, Math.pow(s2, P.glowPow) * P.glowK * (1 - t * 0.6));
      ca.setXYZ(i, c.r, c.g, c.b);
    }
    ca.needsUpdate = true;
  };
}

export function createScene(wrap: HTMLElement): SceneCtx {
  const touch = isTouch();
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, touch ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  // r186 removed PCFSoftShadowMap (it silently downgraded to PCFShadowMap with a console warning);
  // VSMShadowMap is the modern equivalent for soft, blurrable shadows and is what the cascaded
  // shadow setup (core/shadows.ts) and quality tiers (core/quality.ts) tune per-tier.
  renderer.shadowMap.type = THREE.VSMShadowMap;
  // r186's colour-management migration: outputColorSpace already defaults to SRGBColorSpace, but
  // set it explicitly since the whole lighting re-tune below is built around it. ACESFilmicToneMapping
  // + a tuned exposure is what brings contrast back after the sRGB round-trip makes everything read
  // flatter/washed out than the old (pre-color-managed) r128 pipeline — see docs/ARCHITECTURE.md's
  // "Art direction" and this project's report for the full before/after.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.className = 'gl';
  wrap.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const FOG = new THREE.Color(0xc9e4ee);
  scene.fog = new THREE.Fog(FOG, 260, 1750);
  const camera = new THREE.PerspectiveCamera(58, 1, 0.5, 9000);
  const sunDir = new THREE.Vector3(0.55, 0.32, -0.62).normalize();

  const skyGeo = new THREE.SphereGeometry(6000, 40, 20);
  skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(skyGeo.attributes.position.count * 3), 3));
  const paintSky = makePaintSky(skyGeo, sunDir);
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  scene.add(sky);
  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(150, 32), new THREE.MeshBasicMaterial({ color: 0xfff3cf, fog: false }));
  scene.add(sunDisc);

  const hemi = new THREE.HemisphereLight(0xd6efff, 0x2b7088, 0.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d6, 1.05);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 260 });
  sun.shadow.bias = -0.0006;
  scene.add(sun);
  scene.add(sun.target);

  return { wrap, renderer, scene, camera, sunDir, sky, sunDisc, sun, hemi, paintSky };
}
