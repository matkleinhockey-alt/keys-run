/**
 * Electronics: the chartplotter GPS and fish finder (sonar) canvases mounted at the helm and
 * tower dashes.
 *
 * Ported faithfully from legacy/index.html:1107-1212 (the canvas/chart drawing plus
 * `addHelmDisplay`/`addScreens`, the two helpers that mount these textures onto the boat model
 * in model.ts). Out-of-scope systems the chart/sonar would otherwise draw — oil rigs,
 * weedlines, bird hotspots, the fishing buddy, ambient traffic, racers, multiplayer ghosts, fish
 * schools, an active fish fight — are stubbed via src/stubs.ts (always empty/inactive), so their
 * drawing loops below simply iterate zero elements. See docs/ARCHITECTURE.md Phase 0 scope.
 */
import * as THREE from 'three';
import { VACA } from '@keysrun/shared/world/chain';
import { depthAt, MARINAS } from '@keysrun/shared/world/depth';
import { depthFast } from '@keysrun/shared/sim/depth-grid';
import { SPEED_SCALE } from '@keysrun/shared/content/boats';
import { RIGS, WEEDS, hotspots, BUDDY, TRAFFIC, RACERS, MP, groups, F } from '../../stubs.js';

export interface BoatReadout { x: number; z: number; h: number; speed: number }

interface ChartView {
  W: number; H: number; sw: number; sh: number;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture | null;
  img: ImageData;
  small: HTMLCanvasElement;
  sctx: CanvasRenderingContext2D;
}

export interface ElectronicsResult {
  gpsTex: THREE.CanvasTexture;
  sonTex: THREE.CanvasTexture;
  mfdTex: THREE.CanvasTexture;
  update(dt: number, t: number, driveOn: boolean): void;
  zoom(k: number): void;
}

function mkCanvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return { c, ctx, tex };
}

export function createElectronics(boat: BoatReadout): ElectronicsResult {
  const gps = mkCanvas(256, 192), son = mkCanvas(256, 192);
  const img = gps.ctx.createImageData(128, 96);
  const small = document.createElement('canvas');
  small.width = 128; small.height = 96;
  const sctx = small.getContext('2d') as CanvasRenderingContext2D;
  const trail: Array<[number, number]> = [];
  let gT = 0, sT = 0, tT = 0, range = 400;
  son.ctx.fillStyle = '#04122a';
  son.ctx.fillRect(0, 0, 256, 192);

  const band = (d: number): number => (d <= 0.36 ? -1 : d < 1.8 ? 0 : d < 3.6 ? 1 : d < 6 ? 2 : d < 20 ? 3 : d < 60 ? 4 : 5);
  const BAND: Array<[number, number, number]> = [[111, 167, 214], [156, 199, 234], [201, 226, 245], [232, 243, 251], [247, 250, 253], [255, 255, 255]];
  const latlon = (x: number, z: number): string => {
    const lat = 24.7130 - (z - VACA.z) / 111320 * 2.5, lon = 81.0900 - (x - VACA.x) / 101090 * 2.5;
    const f = (v: number, d: number) => {
      const a = Math.floor(v), m = (v - a) * 60;
      return String(a).padStart(d, '0') + '°' + m.toFixed(3).padStart(6, '0') + "'";
    };
    return 'N ' + f(lat, 2) + '   W ' + f(lon, 3);
  };

  function drawChart(V: ChartView): void {
    const W = V.sw, H = V.sh, img2 = V.img, sctx2 = V.sctx, small2 = V.small, d = img2.data, s = range * 2 / W, bx = boat.x, bz = boat.z;
    const bands = new Int8Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const x = bx + (i - W / 2 + 0.5) * s, z = bz + (j - H / 2 + 0.5) * s; bands[j * W + i] = band(depthFast(x, z)); }
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i, b = bands[k], o = k * 4;
        let c: [number, number, number];
        if (b < 0) c = [214, 196, 140];
        else {
          c = BAND[b];
          const r = i < W - 1 ? bands[k + 1] : b, dn = j < H - 1 ? bands[k + W] : b;
          if ((r !== b && r >= 0) || (dn !== b && dn >= 0)) c = [70, 110, 150];
        }
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    }
    sctx2.putImageData(img2, 0, 0);
    const g = V.ctx;
    g.imageSmoothingEnabled = true;
    g.drawImage(small2, 0, 0, W, H, 0, 0, V.W, V.H);
    const P = (x: number, z: number): [number, number] => [V.W / 2 + (x - bx) / s * 2, V.H / 2 + (z - bz) / s * 2];
    g.strokeStyle = 'rgba(200,40,40,.85)'; g.lineWidth = 1.5; g.beginPath();
    trail.forEach((p, i) => { const [u, v] = P(p[0], p[1]); if (i) g.lineTo(u, v); else g.moveTo(u, v); });
    g.stroke();
    g.font = 'bold 11px sans-serif'; g.textAlign = 'center';
    RIGS.forEach(() => {});
    WEEDS.forEach(() => {});
    hotspots.forEach(() => {});
    MARINAS.forEach((M) => { const [u, v] = P(M.sx, M.ez); if (u > 0 && u < V.W && v > 0 && v < V.H) { g.fillStyle = '#1f4f8c'; g.fillText('⚓', u, v + 4); } });
    if (BUDDY.on && BUDDY.model) { /* TODO(phase-0b): fishing buddy marker */ }
    TRAFFIC.forEach(() => {});
    RACERS.forEach(() => {});
    MP.ghosts.forEach(() => {});
    g.save(); g.translate(V.W / 2, V.H / 2); g.rotate(-boat.h);
    g.strokeStyle = '#111'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -60); g.stroke();
    g.fillStyle = '#111'; g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 7); g.lineTo(0, 3); g.lineTo(-6, 7); g.closePath(); g.fill();
    g.restore();
    const kn = Math.abs(boat.speed) / SPEED_SCALE / 0.5144, hdg = Math.round((((-boat.h * 180 / Math.PI) % 360) + 360) % 360), dep = depthAt(boat.x, boat.z) * 3.28;
    g.fillStyle = 'rgba(10,20,30,.82)'; g.fillRect(0, 0, V.W, 22); g.fillRect(0, V.H - 18, V.W, 18);
    g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = 'bold 12px sans-serif';
    g.fillText('SOG ' + kn.toFixed(1) + ' kn', 6, 15); g.fillText('COG ' + String(hdg).padStart(3, '0') + '°', V.W * 0.375, 15); g.fillText(dep.toFixed(1) + ' ft', V.W - 66, 15);
    g.font = '10px sans-serif'; g.fillText(latlon(boat.x, boat.z), 6, V.H - 5);
    g.textAlign = 'right'; g.fillText((range * 2 * 0.00054 * 2.5).toFixed(2) + ' nm', V.W - 6, V.H - 5);
    g.fillStyle = '#1f4f8c'; g.font = 'bold 10px sans-serif'; g.textAlign = 'left'; g.fillText('N↑', 6, 36);
    if (V.tex) V.tex.needsUpdate = true;
  }

  const GV: ChartView = { W: 256, H: 192, sw: 128, sh: 96, ctx: gps.ctx, tex: gps.tex, img, small, sctx };
  const wideSmall = document.createElement('canvas'); wideSmall.width = 224; wideSmall.height = 128;
  const chartW = document.createElement('canvas'); chartW.width = 448; chartW.height = 256;
  const WV: ChartView = { W: 448, H: 256, sw: 224, sh: 128, ctx: chartW.getContext('2d') as CanvasRenderingContext2D, tex: null, img: gps.ctx.createImageData(224, 128), small: wideSmall, sctx: wideSmall.getContext('2d') as CanvasRenderingContext2D };
  const mfd = mkCanvas(640, 256);

  function drawGPS(): void {
    drawChart(GV); drawChart(WV);
    const g = mfd.ctx;
    g.drawImage(chartW, 0, 0);
    g.fillStyle = '#0b0c0e'; g.fillRect(448, 0, 4, 256);
    g.drawImage(son.c, 452, 0, 188, 256);
    g.fillStyle = 'rgba(10,20,30,.82)'; g.fillRect(452, 0, 188, 18);
    g.fillStyle = '#fff'; g.font = 'bold 11px sans-serif'; g.textAlign = 'left'; g.fillText('SONAR  200 kHz', 458, 13);
    mfd.tex.needsUpdate = true;
  }

  let sonMax = 20;
  function drawSonar(): void {
    const g = son.ctx, W = 256, H = 192, top = 20, col = 3;
    const dep = depthAt(boat.x, boat.z), want = Math.max(5, Math.ceil(dep * 1.35 / 5) * 5);
    if (Math.abs(want - sonMax) > sonMax * 0.25) sonMax = want;
    const sy = (H - top) / sonMax;
    g.drawImage(son.c, col, top, W - col, H - top, 0, top, W - col, H - top);
    const x0 = W - col;
    g.fillStyle = '#04122a'; g.fillRect(x0, top, col, H - top);
    for (let k = 0; k < 6; k++) { g.fillStyle = 'rgba(60,110,190,' + Math.random() * 0.25 + ')'; g.fillRect(x0, top + Math.random() * dep * sy, col, 1); }
    const by = top + dep * sy;
    const gr = g.createLinearGradient(0, by, 0, by + 16);
    gr.addColorStop(0, '#ffe14a'); gr.addColorStop(0.25, '#ff4a2a'); gr.addColorStop(0.6, '#8a2a20'); gr.addColorStop(1, '#2a1410');
    g.fillStyle = gr; g.fillRect(x0, by - 1, col, H - by + 1);
    for (const grp of groups) { void grp; } // TODO(phase-0b): fish-school arches on the sonar trace
    for (const h of hotspots) { void h; } // TODO(phase-0b): hotspot bait blips
    if (F.state === 'fight') { /* TODO(phase-3): hooked-fish mark */ }
    g.fillStyle = '#071a33'; g.fillRect(0, 0, W, top);
    g.fillStyle = '#fff'; g.font = 'bold 15px sans-serif'; g.textAlign = 'left'; g.fillText((dep * 3.28).toFixed(1) + ' ft', 6, 15);
    g.font = '10px sans-serif'; g.fillText('200 kHz', 96, 14); g.fillText((dep > 40 ? 80.6 : 78.4).toFixed(1) + '°F', 150, 14);
    g.textAlign = 'right'; g.fillText(((sonMax * 3.28) | 0) + ' ft', W - 4, H - 4);
    for (let k = 1; k < 4; k++) {
      const y = top + (H - top) * k / 4;
      g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(W - 14, y, 10, 1);
      g.fillStyle = 'rgba(255,255,255,.55)'; g.fillText(((sonMax * 3.28 * k / 4) | 0) + '', W - 16, y + 3);
    }
    son.tex.needsUpdate = true;
  }

  return {
    gpsTex: gps.tex, sonTex: son.tex, mfdTex: mfd.tex,
    update(dt, t, driveOn) {
      tT -= dt;
      if (tT <= 0) { tT = 1; trail.push([boat.x, boat.z]); if (trail.length > 240) trail.shift(); }
      if (!driveOn) return;
      gT -= dt; if (gT <= 0) { gT = 0.25; drawGPS(); }
      sT -= dt; if (sT <= 0) { sT = 0.08; drawSonar(); }
      void t;
    },
    zoom(k) {
      range = Math.max(120, Math.min(2400, range * k));
    },
  };
}

/** legacy `addHelmDisplay` (index.html:1201-1206): the big glass-helm MFD screen on the dash. */
export function addHelmDisplay(g: THREE.Group, center: THREE.Vector3, eye: THREE.Vector3, w: number, mfdTex: THREE.Texture): THREE.Group {
  const h = w * 256 / 640;
  const grp = new THREE.Group();
  grp.position.copy(center);
  g.add(grp);
  grp.lookAt(eye);
  const bez = new THREE.Mesh(new THREE.BoxGeometry(w + 0.05, h + 0.05, 0.04), new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.3 }));
  bez.position.z = -0.021;
  grp.add(bez);
  const sc = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: mfdTex, toneMapped: false }));
  sc.position.z = 0.001;
  grp.add(sc);
  return grp;
}

/** legacy `addScreens` (index.html:1207-1212): the paired GPS/sonar screens on the tuna tower. */
export function addScreens(g: THREE.Group, center: THREE.Vector3, eye: THREE.Vector3, w: number, gpsTex: THREE.Texture, sonTex: THREE.Texture): THREE.Group {
  const grp = new THREE.Group();
  grp.position.copy(center);
  g.add(grp);
  grp.lookAt(eye);
  const bez = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + 0.05, w * 0.75 + 0.04, 0.03), new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.35 }));
  bez.position.z = -0.016;
  grp.add(bez);
  ([[gpsTex, -1], [sonTex, 1]] as const).forEach(([tex, sx]) => {
    const sc = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.75), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    sc.position.set(sx * (w / 2 + 0.008), 0, 0.001);
    grp.add(sc);
  });
  return grp;
}
