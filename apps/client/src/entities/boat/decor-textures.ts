/**
 * Canvas-painted flag textures and cloth simulation, plus two small reusable canvas textures
 * (a radial glow sprite, a quilted-upholstery pattern). Ported faithfully from
 * legacy/index.html:1361-1394.
 */
import * as THREE from 'three';
import { clamp } from '../../core/math.js';

export function usFlagTex(): THREE.CanvasTexture {
  const W = 494, H = 260, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  for (let i = 0; i < 13; i++) { x.fillStyle = i % 2 ? '#ffffff' : '#b22234'; x.fillRect(0, i * H / 13, W, H / 13 + 1); }
  const uw = W * 0.4, uh = H * 7 / 13;
  x.fillStyle = '#3c3b6e'; x.fillRect(0, 0, uw, uh);
  const star = (cx: number, cy: number, r: number) => {
    x.beginPath();
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.38 : r; x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
    x.closePath(); x.fill();
  };
  x.fillStyle = '#fff';
  for (let row = 0; row < 9; row++) {
    const n = row % 2 ? 5 : 6;
    for (let i = 0; i < n; i++) star(uw / 12 * (row % 2 ? 2 + 2 * i : 1 + 2 * i), uh / 10 * (row + 1), uh * 0.052);
  }
  return new THREE.CanvasTexture(c);
}

export function jollyRogerTex(): THREE.CanvasTexture {
  const W = 420, H = 280, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d') as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
  x.fillStyle = '#0d0d0f'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#f2efe6';
  x.save(); x.translate(W / 2, H * 0.62);
  for (const a of [-0.62, 0.62]) {
    x.save(); x.rotate(a); x.beginPath();
    if (x.roundRect) x.roundRect(-140, -11, 280, 22, 11); else x.rect(-140, -11, 280, 22);
    x.fill();
    for (const e of [-1, 1]) { x.beginPath(); x.arc(e * 140, -10, 13, 0, 6.283); x.arc(e * 140, 10, 13, 0, 6.283); x.fill(); }
    x.restore();
  }
  x.restore();
  x.beginPath(); x.arc(W / 2, H * 0.4, 62, 0, 6.283); x.fill();
  x.fillRect(W / 2 - 36, H * 0.4 + 30, 72, 44);
  x.fillStyle = '#0d0d0f';
  for (const e of [-1, 1]) { x.beginPath(); x.ellipse(W / 2 + e * 24, H * 0.39, 16, 19, 0, 0, 6.283); x.fill(); }
  x.beginPath(); x.moveTo(W / 2, H * 0.44); x.lineTo(W / 2 - 8, H * 0.5); x.lineTo(W / 2 + 8, H * 0.5); x.fill();
  for (let i = -2; i <= 2; i++) x.fillRect(W / 2 + i * 14 - 2, H * 0.4 + 52, 4, 22);
  return new THREE.CanvasTexture(c);
}

export interface Flag { mesh: THREE.Mesh; update(t: number, wind: number): void }

export function makeFlag(tex: THREE.Texture, w: number, h: number): Flag {
  const geo = new THREE.PlaneGeometry(w, h, 24, 12);
  geo.translate(w / 2, 0, 0);
  const base = (geo.attributes.position.array as Float32Array).slice(0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.85 }));
  mesh.castShadow = true;
  return {
    mesh,
    update(t, wind) {
      const p = geo.attributes.position, a = p.array as Float32Array, k = clamp(wind / 20, 0.15, 1.2), ph = t * (5 + 6 * k);
      for (let i = 0; i < p.count; i++) {
        const x0 = base[i * 3], y0 = base[i * 3 + 1], u = x0 / w;
        a[i * 3 + 2] = Math.sin(u * 7 - ph + y0 * 1.5) * u * (0.06 + 0.1 * k) * w + Math.sin(u * 13 - ph * 1.7) * u * 0.02 * w;
        a[i * 3 + 1] = y0 - u * u * h * 0.55 * (1 - Math.min(1, k * 1.4));
        a[i * 3] = x0 * (1 - 0.04 * Math.abs(Math.sin(u * 7 - ph)));
      }
      p.needsUpdate = true;
      geo.computeVertexNormals();
    },
  };
}

let _glow: THREE.CanvasTexture | null = null;
export function glowTex(): THREE.CanvasTexture {
  if (_glow) return _glow;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  _glow = new THREE.CanvasTexture(c);
  return _glow;
}

let _flame: THREE.CanvasTexture | null = null;
/**
 * A gas flare's flame: an OPAQUE body, not a halo.
 *
 * `glowTex` is a soft radial gradient meant to be blended additively onto dark metal, and a
 * flare built from it simply vanishes against the sky — additive can only brighten, and the sky
 * is already bright in daylight and at sunset alike. A real flare reads because the flame is a
 * solid luminous object that occludes what is behind it, white-hot at the root and dropping
 * through yellow to deep orange at the tip.
 */
export function flameTex(): THREE.CanvasTexture {
  if (_flame) return _flame;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  // teardrop: wide and white at the base, tapering to a torn orange tip
  for (let row = 0; row < 256; row++) {
    const u = row / 255;                       // 0 root .. 1 tip
    const halfW = 52 * Math.pow(1 - u, 0.62) * (0.82 + 0.18 * Math.sin(u * 9));
    if (halfW <= 0.5) continue;
    const g = x.createLinearGradient(64 - halfW, 0, 64 + halfW, 0);
    const core = u < 0.18 ? '#fffdf0' : u < 0.45 ? '#ffd24a' : u < 0.75 ? '#ff9a22' : '#f2641a';
    const a = u < 0.86 ? 1 : (1 - u) / 0.14;   // only the very tip softens
    g.addColorStop(0, 'rgba(255,150,40,0)');
    g.addColorStop(0.28, core);
    g.addColorStop(0.72, core);
    g.addColorStop(1, 'rgba(255,150,40,0)');
    x.globalAlpha = Math.max(0, Math.min(1, a));
    x.fillStyle = g;
    x.fillRect(64 - halfW, 255 - row, halfW * 2, 1);
  }
  x.globalAlpha = 1;
  _flame = new THREE.CanvasTexture(c);
  return _flame;
}

let _smoke: THREE.CanvasTexture | null = null;
/** The plume above the flame — dark, soft-edged. In daylight this is what you actually pick a
 * flare out by from miles off, long before the flame itself resolves. */
export function smokeTex(): THREE.CanvasTexture {
  if (_smoke) return _smoke;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  // A plume, not a puff: densest where it leaves the flame, widening and thinning as it lifts.
  // A radial blob read as a separate grey cloud parked above the rig with a gap under it.
  for (let row = 0; row < 256; row++) {
    const u = row / 255;                        // 0 at the flame .. 1 at the top
    const halfW = 16 + 44 * Math.pow(u, 0.7) * (0.9 + 0.1 * Math.sin(u * 7 + 1.3));
    const a = 0.62 * Math.pow(1 - u, 1.35) * Math.min(1, u / 0.06);  // fades out, and in at the root
    if (a <= 0.004) continue;
    const g = x.createLinearGradient(64 - halfW, 0, 64 + halfW, 0);
    g.addColorStop(0, 'rgba(74,74,80,0)');
    g.addColorStop(0.5, 'rgba(58,58,64,1)');
    g.addColorStop(1, 'rgba(74,74,80,0)');
    x.globalAlpha = a;
    x.fillStyle = g;
    x.fillRect(64 - halfW, 255 - row, halfW * 2, 1);
  }
  x.globalAlpha = 1;
  _smoke = new THREE.CanvasTexture(c);
  return _smoke;
}

let _quilt: THREE.CanvasTexture | null = null;
export function quiltTex(): THREE.CanvasTexture {
  if (_quilt) return _quilt;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  x.fillStyle = '#f6f1e8'; x.fillRect(0, 0, 128, 128);
  x.strokeStyle = 'rgba(120,88,55,.55)'; x.lineWidth = 2.5;
  for (let k = -128; k <= 256; k += 32) {
    x.beginPath(); x.moveTo(k, 0); x.lineTo(k + 128, 128); x.stroke();
    x.beginPath(); x.moveTo(k, 128); x.lineTo(k + 128, 0); x.stroke();
  }
  _quilt = new THREE.CanvasTexture(c);
  _quilt.wrapS = _quilt.wrapT = THREE.RepeatWrapping;
  return _quilt;
}
