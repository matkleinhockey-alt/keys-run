/**
 * The nautical-chart minimap: a static base chart baked once (buff land, blue shallows fading
 * to white deep water, depth contours, soundings, a lat/long graticule, compass rose and scale
 * bar), redrawn each frame with the dynamic overlay (own boat, marina anchors, golf flags).
 *
 * Ported from legacy/index.html:3782-3863. Dynamic overlays for out-of-scope systems — oil rig
 * platforms, weedlines, bird hotspots, the fishing buddy, traffic/racer boats, multiplayer
 * ghosts — are dropped (see src/stubs.ts); their arrays are always empty, so those loops drew
 * nothing in legacy either, but porting dead loops added no value here.
 */
import { chainZ, islandWorld, VACA } from '@keysrun/shared/world/chain';
import { landH, depthAt, WORLD, WB, OLDBR, HUMPS, MARINAS, GOLF } from '@keysrun/shared/world/depth';
import type { BoatState } from '@keysrun/shared/sim/boat';

const MS = 512;
const MW = WORLD.size;
const inCity = (x: number, z: number): boolean => x > 250 && x < 3900 && z < -2560 && z > -3600;
const inMiami = (x: number, z: number): boolean => x > -500 && x < 4200 && z < -1450;

export interface Minimap {
  canvas: HTMLCanvasElement;
  draw(t: number, boat: BoatState): void;
}

export function createMinimap(): Minimap {
  const mapC = document.getElementById('map') as HTMLCanvasElement;
  const mctx = mapC.getContext('2d') as CanvasRenderingContext2D;
  const mapBase = document.createElement('canvas');
  mapBase.width = mapBase.height = MS;

  {
    const c = mapBase.getContext('2d') as CanvasRenderingContext2D;
    const img = c.createImageData(MS, MS), N = MS * MS, band = new Int8Array(N), land = new Uint8Array(N), dep = new Float32Array(N);
    const CONT = [6, 12, 30, 60, 100, 300];
    for (let py = 0; py < MS; py++) {
      for (let px = 0; px < MS; px++) {
        const k = py * MS + px, x = WORLD.x0 + (px + 0.5) / MS * MW, z = WORLD.z0 + (py + 0.5) / MS * MW, lh = landH(x, z);
        if (lh > 0.1) { land[k] = inCity(x, z) ? 2 : 1; band[k] = -1; }
        else { const ft = depthAt(x, z) * 3.28; dep[k] = ft; let b = 0; while (b < CONT.length && ft >= CONT[b]) b++; band[k] = b; }
      }
    }
    const WC: Array<[number, number, number]> = [[150, 200, 232], [171, 212, 238], [196, 226, 245], [220, 238, 250], [236, 246, 252], [246, 250, 254], [251, 253, 255]];
    for (let k = 0; k < N; k++) {
      const o = k * 4;
      let col: [number, number, number];
      if (land[k] === 2) col = [226, 212, 166]; else if (land[k] === 1) col = [244, 228, 178]; else col = WC[band[k]];
      const px = k % MS, py = (k / MS) | 0;
      if (px < MS - 1 && py < MS - 1) {
        const r = band[k + 1], d = band[k + MS];
        if ((band[k] < 0) !== (r < 0) || (band[k] < 0) !== (d < 0)) col = [96, 82, 54];
        else if (band[k] >= 0 && (r !== band[k] || d !== band[k])) col = [118, 160, 190];
      }
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    const MX = (x: number) => (x - WORLD.x0) / MW * MS, MZ = (z: number) => (z - WORLD.z0) / MW * MS;
    c.save(); c.strokeStyle = 'rgba(120,100,60,.25)'; c.lineWidth = 1;
    for (let py = 0; py < MS; py += 4) for (let px = 0; px < MS; px += 4) { if (land[py * MS + px] === 2) { c.beginPath(); c.moveTo(px, py + 3); c.lineTo(px + 3, py); c.stroke(); } }
    c.restore();
    c.strokeStyle = 'rgba(60,70,90,.75)'; c.lineWidth = 1;
    for (let py = 6; py < MS; py += 9) {
      for (let px = 6; px < MS; px += 9) {
        const k = py * MS + px;
        if (band[k] < 0) continue;
        const x = WORLD.x0 + px / MS * MW, z = WORLD.z0 + py / MS * MW;
        if (z > chainZ(x) + 1100 && dep[k] < 14 && !inMiami(x, z)) { c.beginPath(); c.moveTo(px - 2, py); c.lineTo(px + 2, py); c.moveTo(px, py - 2); c.lineTo(px, py + 2); c.stroke(); }
      }
    }
    c.fillStyle = 'rgba(40,55,75,.8)'; c.font = 'italic 9px Georgia, serif'; c.textAlign = 'center';
    for (let gy = 10; gy < MS - 10; gy += 26) {
      for (let gx = 10; gx < MS - 10; gx += 26) {
        const px = Math.round(gx + ((gx * 13 + gy * 7) % 11) - 5), py = Math.round(gy + ((gx * 5 + gy * 11) % 9) - 4), k = py * MS + px;
        if (band[k] < 0) continue;
        let near = false;
        for (let dy = -4; dy <= 4 && !near; dy += 4) for (let dx = -6; dx <= 6; dx += 6) { const kk = (py + dy) * MS + px + dx; if (kk >= 0 && kk < N && band[kk] < 0) { near = true; break; } }
        if (near) continue;
        const ft = dep[k];
        c.fillText(String(ft < 10 ? ft.toFixed(0) : Math.round(ft / (ft > 100 ? 10 : 1)) * (ft > 100 ? 10 : 1)), px, py + 3);
      }
    }
    c.strokeStyle = 'rgba(60,50,40,.8)'; c.lineWidth = 1.6; c.beginPath();
    for (let x = WB.x0; x <= WB.x1; x += 40) { if (x === WB.x0) c.moveTo(MX(x), MZ(chainZ(x))); else c.lineTo(MX(x), MZ(chainZ(x))); }
    c.stroke();
    c.setLineDash([3, 3]); c.beginPath(); c.moveTo(MX(OLDBR.x0), MZ(chainZ(OLDBR.x0) + OLDBR.dz)); c.lineTo(MX(OLDBR.x1), MZ(chainZ(OLDBR.x1) + OLDBR.dz)); c.stroke(); c.setLineDash([]);
    const latZ = (lat: number) => VACA.z - (lat - 24.7130) * 111320 / 2.5, lonX = (lon: number) => VACA.x - (lon - 81.0900) * 101090 / 2.5;
    const zLat = (z: number) => 24.7130 - (z - VACA.z) / 111320 * 2.5, xLon = (x: number) => 81.0900 - (x - VACA.x) / 101090 * 2.5;
    const fm = (v: number) => { const a = Math.floor(v), m = Math.round((v - a) * 60); return a + '°' + String(m).padStart(2, '0') + "'"; };
    c.strokeStyle = 'rgba(70,90,110,.22)'; c.lineWidth = 1; c.fillStyle = 'rgba(40,55,75,.85)'; c.font = '9px Georgia, serif';
    const step = 2 / 60, la0 = Math.ceil(zLat(WORLD.z0 + MW) / step) * step, la1 = zLat(WORLD.z0), lo0 = Math.ceil(xLon(WORLD.x0 + MW) / step) * step, lo1 = xLon(WORLD.x0);
    for (let la = la0; la <= la1; la += step) { const y = MZ(latZ(la)); c.beginPath(); c.moveTo(0, y); c.lineTo(MS, y); c.stroke(); c.textAlign = 'left'; c.fillText(fm(la) + 'N', 3, y - 2); }
    for (let lo = lo0; lo <= lo1; lo += step) { const x = MX(lonX(lo)); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, MS); c.stroke(); c.textAlign = 'center'; c.fillText(fm(lo) + 'W', x, MS - 3); }
    c.strokeStyle = 'rgba(30,40,55,.8)'; c.lineWidth = 2; c.strokeRect(1, 1, MS - 2, MS - 2);
    const land_: Array<[string, number, number]> = [['MARATHON', VACA.x, VACA.z - VACA.b - 60], ['Grassy Key', 3640, chainZ(3640) - 260], ['Key Colony Beach', 2050, chainZ(2050) + 500]];
    const sea_: Array<[string, number, number]> = [['Boot Key Harbor', -1050, chainZ(-1050) + 300], ['Seven Mile Bridge', -3000, chainZ(-3000) - 110], ['Sombrero Reef', 250, chainZ(250) + 1340], ['HAWK CHANNEL', -2400, chainZ(-2400) + 900], ['FLORIDA BAY', -2600, -1300], ['STRAITS OF FLORIDA', 0, chainZ(0) + 3300]];
    c.textAlign = 'center'; c.fillStyle = 'rgba(30,30,25,.9)'; c.font = '600 10px Georgia, serif';
    land_.forEach(([n, x, z]) => c.fillText(n, MX(x), MZ(z)));
    c.fillStyle = 'rgba(25,70,120,.9)'; c.font = 'italic 11px Georgia, serif';
    sea_.forEach(([n, x, z]) => c.fillText(n, MX(x), MZ(z)));
    c.font = 'italic 9px Georgia, serif';
    HUMPS.forEach((H) => { const x = MX(H.x), y = MZ(chainZ(H.x) + H.dz); c.strokeStyle = 'rgba(25,70,120,.7)'; c.beginPath(); c.arc(x, y, H.patch ? 3 : 5, 0, 6.283); c.stroke(); c.fillText(H.name, x, y - 8); });
    { const cx = 58, cy = MS - 70, R = 40; c.save(); c.translate(cx, cy); c.strokeStyle = 'rgba(120,40,60,.75)'; c.fillStyle = 'rgba(120,40,60,.75)'; c.lineWidth = 1;
      c.beginPath(); c.arc(0, 0, R, 0, 6.283); c.stroke(); c.beginPath(); c.arc(0, 0, R - 6, 0, 6.283); c.stroke();
      for (let a = 0; a < 360; a += 10) { const r = a % 30 ? R - 3 : R - 6, th = a * Math.PI / 180; c.beginPath(); c.moveTo(Math.sin(th) * R, -Math.cos(th) * R); c.lineTo(Math.sin(th) * r, -Math.cos(th) * r); c.stroke(); }
      for (let i = 0; i < 4; i++) { c.save(); c.rotate(i * Math.PI / 2); c.beginPath(); c.moveTo(0, -(R - 8)); c.lineTo(5, 0); c.lineTo(0, 0); c.closePath(); c.fill(); c.beginPath(); c.moveTo(0, -(R - 8)); c.lineTo(-5, 0); c.lineTo(0, 0); c.closePath(); c.stroke(); c.restore(); }
      c.font = '700 10px Georgia, serif'; c.textAlign = 'center'; c.fillText('N', 0, -R - 3); c.restore(); }
    { const nm = 1852 / 2.5, px = nm / MW * MS, x0 = MS - 14 - px * 2, y0 = MS - 26; c.fillStyle = 'rgba(30,40,55,.9)'; c.strokeStyle = 'rgba(30,40,55,.9)'; c.lineWidth = 1;
      for (let i = 0; i < 2; i++) { c.fillStyle = i % 2 ? '#fff' : 'rgba(30,40,55,.9)'; c.fillRect(x0 + i * px, y0, px, 4); c.strokeRect(x0 + i * px, y0, px, 4); }
      c.fillStyle = 'rgba(30,40,55,.9)'; c.font = '9px Georgia, serif'; c.textAlign = 'center'; ['0', '1', '2 nm'].forEach((s2, i) => c.fillText(s2, x0 + i * px, y0 - 3)); }
    c.fillStyle = 'rgba(30,40,55,.85)'; c.font = 'italic 9px Georgia, serif'; c.textAlign = 'right'; c.fillText('Soundings in feet', MS - 12, 16);
  }

  function drawMap(t: number, boat: BoatState): void {
    mctx.drawImage(mapBase, 0, 0);
    const toM = (x: number, z: number): [number, number] => [(x - WORLD.x0) / MW * MS, (z - WORLD.z0) / MW * MS];
    mctx.font = '13px sans-serif'; mctx.textAlign = 'center';
    MARINAS.forEach((M) => { const [x, y] = toM(M.sx, M.sz + M.dir * 24); mctx.fillStyle = '#7a1f3d'; mctx.fillText('⚓', x, y + 4); });
    GOLF.forEach((G) => { const w = islandWorld(G.I, G.lx, G.lz), [x, y] = toM(w[0], w[1]); mctx.fillText('⛳', x, y + 4); });
    const [bx, by] = toM(boat.x, boat.z);
    mctx.save(); mctx.translate(bx, by); mctx.rotate(-boat.h);
    mctx.fillStyle = '#f2c14e'; mctx.strokeStyle = '#0d3b66'; mctx.lineWidth = 2;
    mctx.beginPath(); mctx.moveTo(0, -9); mctx.lineTo(6, 7); mctx.lineTo(0, 4); mctx.lineTo(-6, 7); mctx.closePath(); mctx.fill(); mctx.stroke();
    mctx.restore();
    void t;
  }

  document.getElementById('mapbox')?.addEventListener('click', () => document.getElementById('mapbox')?.classList.toggle('big'));
  document.getElementById('mapbox')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); document.getElementById('mapbox')?.classList.toggle('big'); }
  });

  return { canvas: mapC, draw: drawMap };
}
