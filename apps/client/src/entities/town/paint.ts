/**
 * Facades and signs, painted on canvases.
 *
 * Each storefront is a flat decal on a plain box, so the whole street costs one coloured-vertex
 * mesh for the masses plus one textured quad per building. A facade is painted TWICE from the same
 * layout:
 *
 *   - `day`:  everything — wall, brick, windows with a reflection streak, door, sign, painted neon
 *     tubes (dim, as unlit neon is).
 *   - `glow`: ONLY the things that emit — lit window panes, neon text, marquee bulbs — on a
 *     transparent canvas, drawn additively over the day decal. Its material is registered with
 *     `core/time-of-day.ts`'s `lightMats`, so the existing day/sunset crossfade lights the whole
 *     town with zero per-frame work of ours.
 *
 * Painting two canvases per building is what keeps night honest: a neon sign is bright because it
 * is drawn bright in `glow`, not because a point light happens to be near it.
 *
 * Pixel density is 24 px/m, capped at 1024 px wide. That reads cleanly from the sidewalk and costs
 * ~2 MB per decal; the biggest frontage is the 34 m club.
 *
 * (Polish pass: the DRAWING is still laid out at 24 px/m, but every facade except the club's is now RENDERED at
 * `DENS` = 40 px/m, capped at 2048 px wide. The canvas transform scales the vector drawing, so the sign lettering is
 * sharp where it used to be soft inside about 3 m, with no change to any layout number. Small print that must be read
 * up close, the notices in the windows, is not painted here at all: it is a separate atlas, see notices.ts.)
 */
import * as THREE from 'three';
import { VENUES } from '@keysrun/shared/content/venues';
import { DOOR_W, type Lot, type LotStyle } from '@keysrun/shared/world/town';

export const PPM = 24;
/** Rendered texture density for facades, px per metre (see the header). */
const DENS = 40;

/** Sun-bleach: a Keys building after ten summers is the colour it was painted mixed with the colour of salt. */
export function fadeColor(c: number, k = 0.14): number {
  return new THREE.Color(c).lerp(new THREE.Color(0xe9e2d2), k).getHex();
}
const FONT = '"Big Shoulders Display", Impact, "Arial Narrow", sans-serif';
const BODY = '"Instrument Sans", system-ui, sans-serif';

const css = (c: number): string => '#' + c.toString(16).padStart(6, '0');

interface Look {
  wall: number; trim: number; roof: number;
  signBg: string; signFg: string; signRim: string;
  /** Neon colour: used for the glow layer and the dim tube in the day layer. */
  neon: string;
  windows: 'store' | 'barred' | 'none' | 'diner' | 'small';
  pattern: 'stucco' | 'brick' | 'planks' | 'chrome' | 'dark';
  awning: readonly [number, number] | null;
  /** Small print under the name, drawn from the venue tagline when true. */
  tagline: boolean;
  nameFont?: string;
}

export const LOOKS: Readonly<Record<LotStyle, Look>> = {
  tackle:     { wall: 0x2f8f9d, trim: 0xf4f1e8, roof: 0x9aa4ab, signBg: '#f4f1e8', signFg: '#13495a', signRim: '#1c7080', neon: '#38e0ff', windows: 'store', pattern: 'stucco', awning: [0x1f4f8c, 0xf4f1e8], tagline: true },
  guns:       { wall: 0x6a2f29, trim: 0x16110f, roof: 0x3b3b3e, signBg: '#17120f', signFg: '#f2ece0', signRim: '#c32a2a', neon: '#ff3b30', windows: 'barred', pattern: 'brick', awning: null, tagline: true },
  liquor:     { wall: 0xe0ac3c, trim: 0x2a2a2a, roof: 0x9a8f7a, signBg: '#b3202a', signFg: '#fff6c8', signRim: '#fff6c8', neon: '#ffd34a', windows: 'small', pattern: 'stucco', awning: null, tagline: false },
  bar:        { wall: 0x8a6746, trim: 0x2b2118, roof: 0x8f959b, signBg: '#2b2118', signFg: '#f3dfb4', signRim: '#c9852c', neon: '#58b6ff', windows: 'small', pattern: 'planks', awning: null, tagline: true },
  club:       { wall: 0x2e1d3a, trim: 0xff3fa4, roof: 0x15101a, signBg: '#120a18', signFg: '#ff7ccb', signRim: '#ff3fa4', neon: '#ff3fa4', windows: 'none', pattern: 'dark', awning: null, tagline: true },
  gifts:      { wall: 0xf08a7c, trim: 0xfff2dc, roof: 0xb8bcc2, signBg: '#fff2dc', signFg: '#c0392b', signRim: '#2bb3a8', neon: '#2bf0d0', windows: 'store', pattern: 'stucco', awning: [0x2bb3a8, 0xfff2dc], tagline: true },
  diner:      { wall: 0xd7dde2, trim: 0xc23a3a, roof: 0xb8bcc2, signBg: '#1d2430', signFg: '#ff5a4f', signRim: '#e8edf1', neon: '#ff4538', windows: 'diner', pattern: 'chrome', awning: [0xc23a3a, 0xf4f4f2], tagline: true },
  pawn:       { wall: 0x7a7a4e, trim: 0xf0c64a, roof: 0x6f7378, signBg: '#b3202a', signFg: '#ffe27a', signRim: '#ffe27a', neon: '#ffe27a', windows: 'barred', pattern: 'stucco', awning: null, tagline: true },
  laundromat: { wall: 0x8fc4e8, trim: 0xffffff, roof: 0xb8bcc2, signBg: '#ffffff', signFg: '#1d6fb3', signRim: '#8fc4e8', neon: '#7fe0ff', windows: 'store', pattern: 'stucco', awning: null, tagline: true },
  icecream:   { wall: 0xf7c6d8, trim: 0xffffff, roof: 0xe8e0d0, signBg: '#ffffff', signFg: '#e0457b', signRim: '#7ad7d0', neon: '#ff7ab0', windows: 'store', pattern: 'stucco', awning: [0xe0457b, 0xffffff], tagline: false },
  motel:      { wall: 0xefe3c8, trim: 0x2bb3a8, roof: 0xb86a4a, signBg: '#2bb3a8', signFg: '#fff6e0', signRim: '#fff6e0', neon: '#ff6a3a', windows: 'small', pattern: 'stucco', awning: null, tagline: true },
  convenience:{ wall: 0xe8e4da, trim: 0x2a8f4a, roof: 0x9aa4ab, signBg: '#2a8f4a', signFg: '#ffffff', signRim: '#ffd34a', neon: '#6dff9a', windows: 'store', pattern: 'stucco', awning: [0x2a8f4a, 0xffffff], tagline: true },
  casino:     { wall: 0x0d4d5c, trim: 0xe0b34a, roof: 0x0b1a22, signBg: '#06222e', signFg: '#ffd96a', signRim: '#35e0ff', neon: '#35e0ff', windows: 'none', pattern: 'dark', awning: null, tagline: true },
  dive:       { wall: 0x1f6fa0, trim: 0xffd34a, roof: 0x9aa4ab, signBg: '#0e3a58', signFg: '#ffd34a', signRim: '#38e0ff', neon: '#38e0ff', windows: 'store', pattern: 'stucco', awning: [0xffd34a, 0x0e3a58], tagline: true },
};

function makeCanvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h));
  return { c, g: c.getContext('2d')! };
}

function toTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** Draws `text` centred at (cx,cy), shrinking the font until it fits `maxW`. */
function fitText(g: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, size: number, font = FONT, weight = '800'): number {
  let s = size;
  g.font = `${weight} ${s}px ${font}`;
  const w = g.measureText(text).width;
  if (w > maxW) { s = Math.floor(s * (maxW / w)); g.font = `${weight} ${s}px ${font}`; }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, cx, cy);
  return s;
}

/** Neon: the tube colour, a blurred halo, and a hot white core. On the glow layer it is the whole point. */
function neonText(g: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, size: number, color: string, glow: boolean): void {
  g.save();
  if (glow) { g.shadowColor = color; g.shadowBlur = size * 0.55; }
  g.fillStyle = color;
  const s = fitText(g, text, cx, cy, maxW, size);
  if (glow) {
    g.shadowBlur = 0; g.globalAlpha = 0.85; g.fillStyle = '#ffffff';
    g.font = `800 ${Math.max(6, s - 2)}px ${FONT}`;
    g.fillText(text, cx, cy);
  }
  g.restore();
}

interface Layout {
  W: number; H: number;
  door: { x: number; w: number; h: number };
  windows: Array<{ x: number; y: number; w: number; h: number }>;
  signBand: { x: number; y: number; w: number; h: number };
}

/** All in metres, y up from the base of the facade. */
function layoutFor(lot: Lot): Layout {
  const W = lot.u1 - lot.u0, H = lot.h, look = LOOKS[lot.style];
  const dw = lot.enterable ? DOOR_W : lot.style === 'club' ? 2.8 : 1.8;
  const dx = lot.door - lot.u0 - dw / 2;
  const windows: Layout['windows'] = [];
  if (look.windows !== 'none') {
    const paneH = look.windows === 'small' ? 1.3 : 2.05, y = look.windows === 'small' ? 1.2 : 0.8;
    for (const [a, b] of [[0.7, dx - 0.5], [dx + dw + 0.5, W - 0.7]] as const) {
      const span = b - a;
      if (span < 1.4) continue;
      const n = Math.max(1, Math.round(span / (look.windows === 'small' ? 2.4 : 3.6)));
      const pw = (span - (n - 1) * 0.5) / n;
      for (let i = 0; i < n; i++) windows.push({ x: a + i * (pw + 0.5), y, w: pw, h: paneH });
    }
  }
  const tall = H > 5.5;
  const signBand = lot.style === 'club'
    ? { x: 0.8, y: 3.3, w: W - 1.6, h: H - 3.3 - 0.5 }
    : lot.style === 'casino' ? { x: 1.2, y: 3.5, w: W - 2.4, h: H - 3.5 - 0.5 }
    : tall ? { x: 1.2, y: 3.2, w: W - 2.4, h: 1.7 }
    : { x: 0.9, y: Math.max(3.05, H - 1.55), w: W - 1.8, h: Math.min(1.35, H - 3.05 - 0.2) };
  return { W, H, door: { x: dx, w: dw, h: 2.35 }, windows, signBand };
}

function paintPattern(g: CanvasRenderingContext2D, look: Look, w: number, h: number): void {
  const base = css(look.wall);
  const grad = g.createLinearGradient(0, 0, 0, h);
  const lighten = (c: number, k: number): string => { const col = new THREE.Color(c).multiplyScalar(k); return '#' + col.getHexString(); };
  grad.addColorStop(0, lighten(look.wall, 1.05)); grad.addColorStop(1, lighten(look.wall, 0.86));
  g.fillStyle = look.pattern === 'chrome' ? grad : base; g.fillRect(0, 0, w, h);
  if (look.pattern !== 'chrome') { g.fillStyle = grad; g.globalAlpha = 0.5; g.fillRect(0, 0, w, h); g.globalAlpha = 1; }
  if (look.pattern !== 'dark') {
    // sun-bleach, strongest where the sun hits (the top), so no two neighbours are quite the colour on the paint chip
    const wash = g.createLinearGradient(0, 0, 0, h); wash.addColorStop(0, 'rgba(240,232,214,0.20)'); wash.addColorStop(0.6, 'rgba(240,232,214,0.09)'); wash.addColorStop(1, 'rgba(60,50,38,0.14)');
    g.fillStyle = wash; g.fillRect(0, 0, w, h);
  }
  if (look.pattern === 'brick') {
    g.strokeStyle = 'rgba(20,10,8,0.45)'; g.lineWidth = 1;
    for (let y = 0; y < h; y += 7) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); for (let x = (Math.floor(y / 7) % 2) * 9; x < w; x += 18) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 7); g.stroke(); } }
  } else if (look.pattern === 'planks') {
    g.strokeStyle = 'rgba(20,12,6,0.4)'; g.lineWidth = 1.2;
    for (let y = 0; y < h; y += 12) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    for (let i = 0; i < 160; i++) { g.fillStyle = `rgba(${40 + (i * 7) % 60},${25 + (i * 11) % 40},10,0.12)`; g.fillRect((i * 97) % w, (i * 53) % h, 18 + (i % 5) * 8, 2); }
  } else if (look.pattern === 'chrome') {
    // brushed steel streaks and a checkerboard skirt: the diner
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let x = 0; x < w; x += 9) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    const sq = 12;
    for (let x = 0; x < w; x += sq) for (let y = h - sq * 2; y < h; y += sq) { g.fillStyle = ((x / sq + (y - (h - sq * 2)) / sq) | 0) % 2 ? '#22262c' : '#f4f4f2'; g.fillRect(x, y, sq, sq); }
  } else if (look.pattern === 'stucco') {
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${i % 2 ? 255 : 0},${i % 2 ? 255 : 0},${i % 2 ? 255 : 0},0.035)`; g.fillRect((i * 131) % w, (i * 71) % h, 2 + (i % 3), 2 + (i % 2)); }
    // water staining under the roof line: Keys buildings always have it
    const stain = g.createLinearGradient(0, 0, 0, h * 0.12); stain.addColorStop(0, 'rgba(0,0,0,0.12)'); stain.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = stain; g.fillRect(0, 0, w, h * 0.12);
  } else if (look.pattern === 'dark') {
    for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(255,63,164,0.05)'; g.fillRect(((i * 211) % w), 0, 3, h); }
  }
}

function glass(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, kind: Look['windows'], glow: boolean, warm: string): void {
  if (glow) {
    // The glow layer: the pane itself lit from inside, with a vignette so it reads as a room.
    const gr = g.createRadialGradient(x + w / 2, y + h * 0.55, 2, x + w / 2, y + h * 0.55, Math.max(w, h) * 0.75);
    gr.addColorStop(0, warm); gr.addColorStop(1, 'rgba(255,150,40,0.55)');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    return;
  }
  const gr = g.createLinearGradient(x, y, x + w, y + h);
  gr.addColorStop(0, '#6c8da3'); gr.addColorStop(0.5, '#27414f'); gr.addColorStop(1, '#16252e');
  g.fillStyle = gr; g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(255,255,255,0.14)';
  g.beginPath(); g.moveTo(x + w * 0.1, y); g.lineTo(x + w * 0.38, y); g.lineTo(x + w * 0.1 + h * 0.2, y + h); g.lineTo(x - w * 0.18, y + h); g.closePath(); g.fill();
  // silhouettes of things inside, so a window is never an empty blue rectangle
  g.fillStyle = 'rgba(8,14,18,0.55)';
  if (kind === 'diner') { for (let i = 0; i < 4; i++) g.fillRect(x + 6 + i * (w / 4), y + h * 0.55, w / 5, h * 0.45); }
  else if (kind === 'store') { for (let i = 0; i < 5; i++) g.fillRect(x + 8 + i * (w / 5.3), y + h * 0.3 + (i % 2) * 8, 8, h * 0.7); }
  g.strokeStyle = '#d8dcdf'; g.lineWidth = 3; g.strokeRect(x, y, w, h);
  g.beginPath(); g.moveTo(x + w / 2, y); g.lineTo(x + w / 2, y + h); g.lineWidth = 2; g.stroke();
}

/** What a storefront window says on the glass (decals), painted on both layers. */
function windowLettering(g: CanvasRenderingContext2D, lot: Lot, win: Layout['windows'][number], glow: boolean, pxY: (m: number) => number): void {
  const look = LOOKS[lot.style];
  const x = win.x * PPM, w = win.w * PPM, y = pxY(win.y + win.h), h = win.h * PPM;
  const cx = x + w / 2;
  const lines: Record<string, string[]> = {
    tackle: ['LIVE BAIT', 'ICE'], guns: ['FIREARMS', 'AMMO'], bar: ['COLD BEER'], liquor: ['LOTTO', 'WINE'], gifts: ['T-SHIRTS', 'SHELLS'],
    pawn: ['WE BUY GOLD', 'LOANS'], laundromat: ['WASH · DRY'], icecream: ['SOFT SERVE'], convenience: ['OPEN 24'], dive: ['AIR FILLS', 'SPEARGUNS'], diner: ['EAT'], motel: ['TV'], club: [],
  };
  const t = lines[lot.style] ?? [];
  if (!t.length) return;
  g.save();
  g.fillStyle = glow ? look.neon : 'rgba(255,255,255,0.78)';
  if (glow) { g.shadowColor = look.neon; g.shadowBlur = 10; }
  t.forEach((s, i) => fitText(g, s, cx, y + h * (0.28 + i * 0.3), w * 0.78, Math.min(26, h * 0.26), FONT, '800'));
  g.restore();
}

export interface FacadeTex {
  day: THREE.CanvasTexture;
  glow: THREE.CanvasTexture;
  /** Facade size in metres. */
  w: number; h: number;
  /** Metres from the facade's left edge / base, and size, of the sign band (hero elements hang off it). */
  layout: Layout;
}

/** Paint the front of `lot`. Call once per building; textures are owned by the caller. */
export function paintFacade(lot: Lot): FacadeTex {
  const look = LOOKS[lot.style], venue = VENUES[lot.venue], L = layoutFor(lot);
  const club = lot.style === 'club'; // not ours to touch: it keeps its original density and paint
  const cw = club ? Math.min(1024, Math.round(L.W * PPM)) : Math.min(2048, Math.round(L.W * DENS)), scale = cw / (L.W * PPM);
  const ch = Math.round(L.H * PPM * scale);
  // Draw at PPM and let the canvas transform scale down to the capped width.
  const day = makeCanvas(cw, ch), glow = makeCanvas(cw, ch);
  for (const layer of [day, glow]) { layer.g.scale(scale, scale); }
  const wPx = L.W * PPM, hPx = L.H * PPM;
  const pxY = (m: number): number => hPx - m * PPM;

  const dg = day.g, gg = glow.g;
  paintPattern(dg, look, wPx, hPx);
  // parapet / trim line at the top and a baseboard
  dg.fillStyle = css(look.trim); dg.fillRect(0, 0, wPx, 0.28 * PPM); dg.fillRect(0, hPx - 0.18 * PPM, wPx, 0.18 * PPM);

  // windows
  for (const win of L.windows) {
    const x = win.x * PPM, y = pxY(win.y + win.h), w = win.w * PPM, h = win.h * PPM;
    glass(dg, x, y, w, h, look.windows, false, '');
    windowLettering(dg, lot, win, false, pxY);
    if (look.windows === 'barred') { dg.strokeStyle = '#0c0c0e'; dg.lineWidth = 3; for (let bx = x + 8; bx < x + w; bx += 11) { dg.beginPath(); dg.moveTo(bx, y); dg.lineTo(bx, y + h); dg.stroke(); } }
    // lit pane for the night layer: warm, slightly different per window so the street is not a grid of clones
    const warm = ['#ffe3a0', '#ffd68a', '#fff0c8', '#ffcf80'][(Math.floor(win.x) + lot.id.length) % 4];
    if (lot.style !== 'club') glass(gg, x, y, w, h, look.windows, true, warm);
    windowLettering(gg, lot, win, true, pxY);
    if (look.windows === 'barred') { gg.globalCompositeOperation = 'destination-out'; gg.strokeStyle = '#000'; gg.lineWidth = 3; for (let bx = x + 8; bx < x + w; bx += 11) { gg.beginPath(); gg.moveTo(bx, y); gg.lineTo(bx, y + h); gg.stroke(); } gg.globalCompositeOperation = 'source-over'; }
  }

  // door
  const dX = L.door.x * PPM, dW = L.door.w * PPM, dH = L.door.h * PPM, dY = hPx - dH;
  if (lot.enterable) {
    // an open doorway: cut it out of the decal so the real gap in the wall shows through
    dg.save(); dg.globalCompositeOperation = 'destination-out'; dg.fillStyle = '#000'; dg.fillRect(dX, dY, dW, dH + 2); dg.restore();
    dg.fillStyle = css(look.trim); dg.fillRect(dX - 5, dY - 6, dW + 10, 6); dg.fillRect(dX - 5, dY - 6, 5, dH + 6); dg.fillRect(dX + dW, dY - 6, 5, dH + 6);
  } else {
    const club = lot.style === 'club';
    dg.fillStyle = club ? '#0a060d' : '#2a2f33'; dg.fillRect(dX, dY, dW, dH);
    dg.strokeStyle = club ? '#e0b34a' : '#aeb4b8'; dg.lineWidth = 4; dg.strokeRect(dX, dY, dW, dH);
    if (club) { dg.beginPath(); dg.moveTo(dX + dW / 2, dY); dg.lineTo(dX + dW / 2, dY + dH); dg.stroke(); dg.fillStyle = '#e0b34a'; dg.fillRect(dX + dW / 2 - 14, dY + dH * 0.5, 7, 22); dg.fillRect(dX + dW / 2 + 7, dY + dH * 0.5, 7, 22); }
    else { dg.fillStyle = glassFill(dg, dX + 8, dY + 8, dW - 16, dH * 0.55); dg.fillRect(dX + 8, dY + 8, dW - 16, dH * 0.55); dg.fillStyle = '#d8d8d8'; dg.fillRect(dX + dW - 14, dY + dH * 0.55, 5, 18); }
    // OPEN sign on the glass door: lit on the glow layer
    if (!club) { gg.fillStyle = '#ff3b30'; gg.shadowColor = '#ff3b30'; gg.shadowBlur = 8; fitText(gg, 'OPEN', dX + dW / 2, dY + dH * 0.32, dW * 0.6, 20); gg.shadowBlur = 0; dg.fillStyle = 'rgba(200,60,50,0.6)'; fitText(dg, 'OPEN', dX + dW / 2, dY + dH * 0.32, dW * 0.6, 20); }
    // a door light so the entrance reads at night
    const dl = gg.createRadialGradient(dX + dW / 2, dY - 4, 2, dX + dW / 2, dY - 4, dW * 0.9);
    dl.addColorStop(0, club ? 'rgba(255,63,164,0.9)' : 'rgba(255,230,160,0.7)'); dl.addColorStop(1, 'rgba(255,200,100,0)');
    gg.fillStyle = dl; gg.fillRect(dX - dW, dY - dW, dW * 3, dW * 1.6);
  }

  // sign band
  const sb = L.signBand, sx = sb.x * PPM, sw = sb.w * PPM, sh = sb.h * PPM, sy = pxY(sb.y + sb.h);
  dg.fillStyle = look.signBg; rrect(dg, sx, sy, sw, sh, 8); dg.fill();
  dg.strokeStyle = look.signRim; dg.lineWidth = 4; rrect(dg, sx + 3, sy + 3, sw - 6, sh - 6, 6); dg.stroke();
  const name = venue.name.toUpperCase();
  const taglined = look.tagline && sh > 44;
  const nameY = sy + (taglined ? sh * 0.42 : sh * 0.5);
  const nameSize = Math.min(sh * (taglined ? 0.52 : 0.64), 110);
  if (lot.style === 'club') {
    // magenta marquee: big name, a second neon line and a ring of bulbs
    neonText(dg, name, sx + sw / 2, sy + sh * 0.3, sw * 0.9, nameSize * 0.9, look.neon + 'aa', false);
    neonText(dg, 'GIRLS  ·  GIRLS  ·  GIRLS', sx + sw / 2, sy + sh * 0.62, sw * 0.8, sh * 0.2, '#ffd23f', false);
    neonText(dg, venue.tagline.split('·')[0].trim().toUpperCase(), sx + sw / 2, sy + sh * 0.84, sw * 0.7, sh * 0.12, '#f4f4f4', false);
    neonText(gg, name, sx + sw / 2, sy + sh * 0.3, sw * 0.9, nameSize * 0.9, look.neon, true);
    neonText(gg, 'GIRLS  ·  GIRLS  ·  GIRLS', sx + sw / 2, sy + sh * 0.62, sw * 0.8, sh * 0.2, '#ffd23f', true);
    neonText(gg, venue.tagline.split('·')[0].trim().toUpperCase(), sx + sw / 2, sy + sh * 0.84, sw * 0.7, sh * 0.12, '#ffffff', true);
    bulbRing(dg, sx, sy, sw, sh, false); bulbRing(gg, sx, sy, sw, sh, true);
  } else if (lot.style === 'casino') {
    casinoSign(dg, gg, sx, sy, sw, sh, name);
  } else {
    dg.fillStyle = look.signFg; fitText(dg, name, sx + sw / 2, nameY, sw * 0.92, nameSize);
    if (taglined) { dg.fillStyle = look.signFg; dg.globalAlpha = 0.8; fitText(dg, venue.tagline.toUpperCase(), sx + sw / 2, sy + sh * 0.82, sw * 0.9, sh * 0.15, BODY, '700'); dg.globalAlpha = 1; }
    // the sign band glows softly at night (backlit), the lettering hotter
    gg.fillStyle = 'rgba(255,255,255,0.10)'; rrect(gg, sx, sy, sw, sh, 8); gg.fill();
    if (['bar', 'diner', 'liquor', 'guns', 'dive', 'pawn'].includes(lot.style)) neonText(gg, name, sx + sw / 2, nameY, sw * 0.92, nameSize, look.neon, true);
    else { gg.fillStyle = look.signFg; gg.globalAlpha = 0.55; fitText(gg, name, sx + sw / 2, nameY, sw * 0.92, nameSize); gg.globalAlpha = 1; }
  }

  // motel: a row of room doors and windows on the upper floor with a walkway rail
  if (lot.style === 'motel') {
    const n = Math.floor(L.W / 4.6);
    for (let i = 0; i < n; i++) {
      const x = (1.2 + i * 4.6) * PPM, y = pxY(6.7);
      dg.fillStyle = '#2f6f6a'; dg.fillRect(x, y, 1.1 * PPM, 2.1 * PPM);
      glass(dg, x + 1.35 * PPM, pxY(6.1), 1.8 * PPM, 1.2 * PPM, 'small', false, '');
      glass(gg, x + 1.35 * PPM, pxY(6.1), 1.8 * PPM, 1.2 * PPM, 'small', true, '#ffd68a');
      dg.fillStyle = '#fff6e0'; fitText(dg, String(i + 1), x + 0.55 * PPM, y + 0.35 * PPM, 20, 16, BODY);
    }
    dg.fillStyle = css(look.trim); dg.fillRect(0, pxY(4.6), wPx, 0.14 * PPM);
  }

  // dim painted tubes on the day layer for lots with a neon feature; the glow layer carries the real thing
  if (lot.style === 'bar') {
    const win = L.windows[0];
    if (win) {
      neonText(dg, 'OPEN', (win.x + win.w * 0.5) * PPM, pxY(win.y + win.h * 0.7), win.w * PPM * 0.5, 34, '#ff4b3a88', false);
      neonText(gg, 'OPEN', (win.x + win.w * 0.5) * PPM, pxY(win.y + win.h * 0.7), win.w * PPM * 0.5, 34, '#ff4b3a', true);
      neonText(dg, 'BEER', (win.x + win.w * 0.5) * PPM, pxY(win.y + win.h * 0.32), win.w * PPM * 0.5, 30, '#58b6ff88', false);
      neonText(gg, 'BEER', (win.x + win.w * 0.5) * PPM, pxY(win.y + win.h * 0.32), win.w * PPM * 0.5, 30, '#58b6ff', true);
    }
  }

  if (!club) livedIn(dg, lot, L, pxY, wPx, hPx);

  return { day: toTexture(day.c), glow: toTexture(glow.c), w: L.W, h: L.H, layout: L };
}

/** A deterministic stream of 0..1, so the same wall is stained the same way every build. */
function lcg(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed) * 1000) + 12345) >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * What ten summers and one hurricane do to a storefront: salt streaks under every sill, a rain-line of
 * grime where the wall meets the pavement, rust weeping from the sign band's corners, a patch of paint that
 * does not match, a door that has been pushed open a thousand times. Day layer only.
 *
 * Why these and not a noise overlay: a uniform dirt texture reads as a filter; stains that start AT something
 * (a sill, a bracket, a ground line) read as the thing having been there for years.
 */
function livedIn(g: CanvasRenderingContext2D, lot: Lot, L: Layout, pxY: (m: number) => number, wPx: number, hPx: number): void {
  const r = lcg(lot.u0 * 7.3 + lot.v0 * 1.7 + lot.h);
  g.save();
  // grime where the wall meets the sidewalk: rain splash and a century of shoes
  const base = g.createLinearGradient(0, hPx - 0.75 * PPM, 0, hPx);
  base.addColorStop(0, 'rgba(48,40,30,0)'); base.addColorStop(1, 'rgba(48,40,30,0.30)');
  g.fillStyle = base; g.fillRect(0, hPx - 0.75 * PPM, wPx, 0.75 * PPM);
  // salt and rust streaks down from every sill
  for (const win of L.windows) {
    const x = win.x * PPM, w = win.w * PPM, yb = pxY(win.y);
    for (let k = 0; k < 3; k++) {
      const sx = x + w * (0.12 + 0.3 * k + r() * 0.12), len = (0.5 + r() * 1.1) * PPM, sw = 1.5 + r() * 2.5;
      const gr = g.createLinearGradient(0, yb, 0, yb + len);
      gr.addColorStop(0, 'rgba(70,58,44,0.18)'); gr.addColorStop(1, 'rgba(70,58,44,0)');
      g.fillStyle = gr; g.fillRect(sx, yb + 1, sw, len);
    }
  }
  // rust weeping from the sign band's lower corners
  const sb = L.signBand, sy = pxY(sb.y);
  for (const sx of [sb.x * PPM + 5, (sb.x + sb.w) * PPM - 7]) {
    const gr = g.createLinearGradient(0, sy, 0, sy + 1.3 * PPM);
    gr.addColorStop(0, 'rgba(150,80,40,0.28)'); gr.addColorStop(1, 'rgba(150,80,40,0)');
    g.fillStyle = gr; g.fillRect(sx, sy, 3, 1.3 * PPM);
  }
  // a repainted patch that does not quite match, and one sun-faded panel
  g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(wPx * (0.1 + r() * 0.7), hPx - (2.4 + r() * 0.8) * PPM, (0.9 + r()) * PPM, (0.8 + r() * 0.5) * PPM);
  g.fillStyle = 'rgba(0,0,0,0.05)'; g.fillRect(wPx * (0.1 + r() * 0.7), hPx - (1.6 + r() * 0.6) * PPM, (0.6 + r()) * PPM, (0.7 + r() * 0.4) * PPM);
  // a handprint-high scuff either side of the door, where every hand goes
  const dx = L.door.x * PPM, dw = L.door.w * PPM;
  g.fillStyle = 'rgba(40,32,24,0.12)';
  for (const sx of [dx - 6, dx + dw + 2]) g.fillRect(sx, hPx - 1.25 * PPM, 4, 0.5 * PPM);
  g.restore();
}

function glassFill(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): CanvasGradient {
  const gr = g.createLinearGradient(x, y, x + w, y + h);
  gr.addColorStop(0, '#6c8da3'); gr.addColorStop(1, '#16252e');
  return gr;
}

function bulbRing(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, glow: boolean): void {
  const n = Math.floor(w / 16);
  for (let i = 0; i <= n; i++) {
    const bx = x + 6 + (i * (w - 12)) / n;
    for (const by of [y + 6, y + h - 6]) {
      g.fillStyle = glow ? '#fff6c0' : '#d9c98a';
      if (glow) { g.shadowColor = '#ffd23f'; g.shadowBlur = 6; }
      g.beginPath(); g.arc(bx, by, 3, 0, Math.PI * 2); g.fill();
    }
  }
  g.shadowBlur = 0;
}

// ---------------------------------------------------------------------------------------------
// Hero signs: the one big thing that makes each venue recognisable from across the street.
// ---------------------------------------------------------------------------------------------

export type HeroKind = 'flamingo' | 'target' | 'vacancy' | 'beer' | 'dinerRoof' | 'marlin' | 'casinoMarlin';
export interface HeroTex { day: THREE.CanvasTexture; glow: THREE.CanvasTexture; aspect: number }

export function paintHero(kind: HeroKind): HeroTex {
  const W = 512, H = kind === 'dinerRoof' ? 192 : kind === 'vacancy' ? 640 : 512;
  const day = makeCanvas(W, H), glow = makeCanvas(W, H);
  for (const [layer, isGlow] of [[day, false], [glow, true]] as const) {
    const g = layer.g;
    g.lineJoin = 'round'; g.lineCap = 'round';
    if (kind === 'flamingo') flamingo(g, W, H, isGlow);
    else if (kind === 'target') target(g, W, H, isGlow);
    else if (kind === 'vacancy') vacancy(g, W, H, isGlow);
    else if (kind === 'beer') beerSign(g, W, isGlow);
    else if (kind === 'dinerRoof') dinerRoof(g, W, H, isGlow);
    else if (kind === 'casinoMarlin') casinoMarlin(g, W, H, isGlow);
    else marlin(g, isGlow);
  }
  return { day: toTexture(day.c), glow: toTexture(glow.c), aspect: W / H };
}

function tube(g: CanvasRenderingContext2D, color: string, glow: boolean, width = 10): void {
  g.strokeStyle = glow ? color : color + '77'; g.lineWidth = width;
  if (glow) { g.shadowColor = color; g.shadowBlur = 22; }
}

function flamingo(g: CanvasRenderingContext2D, W: number, H: number, glow: boolean): void {
  const pink = '#ff3fa4';
  if (!glow) { g.fillStyle = '#120a18'; rrect(g, 20, 20, W - 40, H - 40, 40); g.fill(); }
  tube(g, pink, glow, 12);
  // body: an S-curved neck, a teardrop body, one standing leg; the classic flamingo, in one tube of neon
  g.beginPath();
  g.moveTo(330, 120); g.bezierCurveTo(250, 90, 190, 150, 250, 210); g.bezierCurveTo(300, 250, 250, 300, 190, 300);
  g.bezierCurveTo(130, 300, 120, 360, 180, 380); g.bezierCurveTo(250, 400, 340, 360, 360, 300);
  g.bezierCurveTo(375, 250, 340, 210, 300, 170); g.stroke();
  g.beginPath(); g.moveTo(330, 120); g.lineTo(380, 135); g.lineTo(345, 150); g.stroke(); // beak
  g.beginPath(); g.moveTo(230, 395); g.lineTo(225, 470); g.lineTo(255, 478); g.stroke(); // leg
  tube(g, '#ffd23f', glow, 8);
  g.beginPath(); g.arc(340, 128, 5, 0, Math.PI * 2); g.stroke();
  g.shadowBlur = 0;
}

function target(g: CanvasRenderingContext2D, W: number, H: number, glow: boolean): void {
  const cx = W / 2, cy = H / 2;
  if (!glow) {
    g.fillStyle = '#17120f'; g.beginPath(); g.arc(cx, cy, 240, 0, Math.PI * 2); g.fill();
    for (const [r, c] of [[220, '#f2ece0'], [160, '#c32a2a'], [100, '#f2ece0'], [44, '#c32a2a']] as const) { g.fillStyle = c; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); }
  } else {
    tube(g, '#ff3b30', true, 9);
    g.beginPath(); g.arc(cx, cy, 232, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(cx - 250, cy); g.lineTo(cx + 250, cy); g.moveTo(cx, cy - 250); g.lineTo(cx, cy + 250); g.stroke();
    g.shadowBlur = 0;
  }
}

function vacancy(g: CanvasRenderingContext2D, W: number, H: number, glow: boolean): void {
  if (!glow) { g.fillStyle = '#2bb3a8'; rrect(g, 16, 16, W - 32, H - 32, 28); g.fill(); g.strokeStyle = '#fff6e0'; g.lineWidth = 8; rrect(g, 30, 30, W - 60, H - 60, 20); g.stroke(); }
  g.fillStyle = glow ? '#fff6e0' : '#fff6e0cc';
  if (glow) { g.shadowColor = '#fff6e0'; g.shadowBlur = 14; }
  fitText(g, 'MOTEL', W / 2, 130, W * 0.78, 130); g.shadowBlur = 0;
  fitText(g, 'SUNSET', W / 2, 240, W * 0.7, 70, BODY, '700');
  neonText(g, 'VACANCY', W / 2, 400, W * 0.8, 110, glow ? '#ff6a3a' : '#ff6a3a66', glow);
  neonText(g, 'COLOR TV', W / 2, 520, W * 0.6, 56, glow ? '#38e0ff' : '#38e0ff66', glow);
}

function beerSign(g: CanvasRenderingContext2D, W: number, glow: boolean): void {
  if (!glow) { g.fillStyle = '#2b2118'; rrect(g, 20, 120, W - 40, 280, 30); g.fill(); }
  neonText(g, 'COLD', W / 2, 200, W * 0.7, 130, glow ? '#58b6ff' : '#58b6ff66', glow);
  neonText(g, 'BEER', W / 2, 330, W * 0.7, 150, glow ? '#ff4b3a' : '#ff4b3a66', glow);
}

function dinerRoof(g: CanvasRenderingContext2D, W: number, H: number, glow: boolean): void {
  if (!glow) { g.fillStyle = '#e8edf1'; rrect(g, 8, 8, W - 16, H - 16, 40); g.fill(); g.fillStyle = '#c23a3a'; rrect(g, 20, 20, W - 40, H - 40, 32); g.fill(); }
  neonText(g, 'DINER', W / 2, H / 2, W * 0.84, 160, glow ? '#ffffff' : '#ffffffcc', glow);
}

/**
 * A leaping marlin, drawn into a 512 box at (ox, oy) scaled by `k`. Day layer: filled blue with a pale
 * belly, the way a fibreglass fish on a roof looks. Glow layer: the same outline in neon. `flip`
 * mirrors it so a pair of them can face each other across the sign.
 */
function leapMarlin(g: CanvasRenderingContext2D, ox: number, oy: number, k: number, glow: boolean, flip: boolean, color = '#35e0ff'): void {
  g.save();
  g.translate(ox, oy); g.scale(flip ? -k : k, k);
  const body = (): void => {
    g.beginPath();
    g.moveTo(40, 440); g.lineTo(200, 300); g.bezierCurveTo(240, 250, 330, 200, 410, 170); g.bezierCurveTo(440, 160, 470, 130, 490, 70);
    g.bezierCurveTo(470, 150, 440, 210, 400, 250); g.bezierCurveTo(330, 320, 260, 380, 120, 440); g.closePath();
  };
  const sail = (): void => { g.beginPath(); g.moveTo(300, 230); g.lineTo(330, 110); g.lineTo(380, 200); g.closePath(); };
  if (!glow) {
    g.fillStyle = '#1f6fb0'; body(); g.fill();
    g.fillStyle = '#134a7a'; sail(); g.fill();
    g.fillStyle = '#c8dff0'; g.beginPath(); g.moveTo(180, 340); g.bezierCurveTo(260, 330, 330, 300, 380, 250); g.lineTo(350, 290); g.bezierCurveTo(300, 340, 240, 360, 180, 340); g.fill();
  } else {
    g.strokeStyle = color; g.lineWidth = 14 / Math.max(0.2, k * 2); g.lineJoin = 'round'; g.shadowColor = color; g.shadowBlur = 24;
    body(); g.stroke(); sail(); g.stroke();
  }
  g.restore();
}

/** The casino's roof sign: a big neon marlin in a gold ring with stars. */
function casinoMarlin(g: CanvasRenderingContext2D, W: number, H: number, glow: boolean): void {
  const cx = W / 2, cy = H / 2;
  if (!glow) {
    g.fillStyle = '#06222e'; g.beginPath(); g.arc(cx, cy, 246, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#e0b34a'; g.lineWidth = 12; g.beginPath(); g.arc(cx, cy, 240, 0, Math.PI * 2); g.stroke();
  } else {
    tube(g, '#ffd23f', true, 12); g.beginPath(); g.arc(cx, cy, 240, 0, Math.PI * 2); g.stroke();
    tube(g, '#ff3fa4', true, 6); g.beginPath(); g.arc(cx, cy, 214, 0, Math.PI * 2); g.stroke();
  }
  leapMarlin(g, cx - 190, cy - 215, 0.74, glow, false, '#35e0ff');
  g.shadowBlur = 0;
  if (glow) {
    g.fillStyle = '#ffd23f'; g.shadowColor = '#ffd23f'; g.shadowBlur = 12;
    for (const [x, y, r] of [[120, 130, 11], [400, 110, 9], [430, 330, 12], [96, 340, 8], [256, 52, 10]] as const) {
      g.beginPath(); for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4, rr2 = i % 2 ? r * 0.4 : r; g.lineTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2); } g.closePath(); g.fill();
    }
    g.shadowBlur = 0;
  }
  neonText(g, '777', cx, H - 58, W * 0.42, 64, glow ? '#ff3fa4' : '#ff3fa488', glow);
}

/** The casino marquee in the sign band: the name in gold, CASINO in cyan, a marlin leaping at each end, a ring of bulbs. */
function casinoSign(dg: CanvasRenderingContext2D, gg: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, name: string): void {
  const nm = name.replace(' CASINO', '');
  for (const [g, glow] of [[dg, false], [gg, true]] as const) {
    neonText(g, nm, x + w / 2, y + h * 0.33, w * 0.62, h * 0.42, glow ? '#ffd96a' : '#ffd96acc', glow);
    neonText(g, 'CASINO', x + w / 2, y + h * 0.7, w * 0.3, h * 0.3, glow ? '#35e0ff' : '#35e0ffcc', glow);
    neonText(g, 'SLOTS  ·  ODDS POSTED INSIDE  ·  PLEASE READ THEM', x + w / 2, y + h * 0.9, w * 0.62, h * 0.09, glow ? '#ffffff' : '#e8e0c8', glow);
    leapMarlin(g, x + w * 0.04, y + h * 0.1, (h * 0.8) / 512 * 0.85, glow, false);
    leapMarlin(g, x + w * 0.96, y + h * 0.1, (h * 0.8) / 512 * 0.85, glow, true);
    bulbRing(g, x, y, w, h, glow);
  }
}

function marlin(g: CanvasRenderingContext2D, glow: boolean): void {
  if (glow) return;
  // a fibreglass blue marlin leaping: bill, sail, tail
  g.fillStyle = '#1f6fb0'; g.beginPath();
  g.moveTo(40, 440); g.lineTo(200, 300); g.bezierCurveTo(240, 250, 330, 200, 410, 170); g.bezierCurveTo(440, 160, 470, 130, 490, 70);
  g.bezierCurveTo(470, 150, 440, 210, 400, 250); g.bezierCurveTo(330, 320, 260, 380, 120, 440); g.closePath(); g.fill();
  g.fillStyle = '#134a7a'; g.beginPath(); g.moveTo(300, 230); g.lineTo(330, 110); g.lineTo(380, 200); g.closePath(); g.fill();
  g.fillStyle = '#c8dff0'; g.beginPath(); g.moveTo(180, 340); g.bezierCurveTo(260, 330, 330, 300, 380, 250); g.lineTo(350, 290); g.bezierCurveTo(300, 340, 240, 360, 180, 340); g.fill();
}

// ---------------------------------------------------------------------------------------------
// Ground textures
// ---------------------------------------------------------------------------------------------

/** A soft radial dot: a halo / a pool of light, tinted by vertex colour. Shared by every glow quad. */
export function radialGlowTexture(): THREE.CanvasTexture {
  const { c, g } = makeCanvas(128, 128);
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  // a smooth quadratic-ish falloff: with fewer stops the additive pools showed a visible hard rim at night
  for (const [t, a] of [[0, 1], [0.12, 0.72], [0.28, 0.42], [0.5, 0.18], [0.72, 0.06], [0.9, 0.012], [1, 0]] as const) gr.addColorStop(t, `rgba(255,255,255,${a})`);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Wood planks: the promenade and the ramp. Tiles every 2 m of a plank row. */
export function plankTexture(): THREE.CanvasTexture {
  const { c, g } = makeCanvas(256, 256);
  g.fillStyle = '#9c7a55'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 8; i++) {
    const y = i * 32, shade = 0.9 + ((i * 37) % 7) / 35;
    g.fillStyle = `rgba(${Math.round(160 * shade)},${Math.round(125 * shade)},${Math.round(86 * shade)},1)`; g.fillRect(0, y, 256, 30);
    g.fillStyle = 'rgba(40,24,10,0.5)'; g.fillRect(0, y + 30, 256, 2);
    const off = (i * 71) % 200; g.fillRect(off, y, 2, 32);
    g.strokeStyle = 'rgba(60,36,16,0.18)'; g.lineWidth = 1;
    for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(0, y + 6 + k * 6); g.lineTo(256, y + 7 + k * 6); g.stroke(); }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** The floors an interior can have. One texture per KIND, shared by every room that uses it (interiors.ts). */
export type FloorKind = 'checker' | 'boards' | 'tile' | 'concrete' | 'carpet' | 'lino';

/**
 * Interior floor patterns. 256 px, tiling. The first two are the bar's and the diner's, unchanged; the
 * rest were added with the other ten rooms and are deliberately the cheapest thing that reads as
 * its material from standing height: a flat base, a grid or a speckle, nothing photographic.
 */
export function floorTexture(kind: FloorKind): THREE.CanvasTexture {
  const { c, g } = makeCanvas(256, 256);
  // Deterministic speckle (no Math.random: a rebuilt room must look identical to the one it replaces)
  const speck = (n: number, a: string, b: string): void => {
    for (let i = 0; i < n; i++) {
      const x = (i * 97 + (i * i) % 53) % 256, y = (i * 61 + (i * 7) % 29) % 256;
      g.fillStyle = i % 2 ? a : b; g.fillRect(x, y, 2, 2);
    }
  };
  if (kind === 'checker') {
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { g.fillStyle = (i + j) % 2 ? '#22262c' : '#e9e6dc'; g.fillRect(i * 32, j * 32, 32, 32); }
  } else if (kind === 'tile') {
    // pale blue-and-white 2x2 squares with grout: dive shop, ice cream, anywhere that gets wet
    g.fillStyle = '#f1f5f6'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if ((i + j) % 2) { g.fillStyle = '#b9dbe6'; g.fillRect(i * 32, j * 32, 32, 32); }
    g.fillStyle = 'rgba(70,90,100,0.35)'; for (let i = 0; i < 8; i++) { g.fillRect(i * 32, 0, 1, 256); g.fillRect(0, i * 32, 256, 1); }
  } else if (kind === 'concrete') {
    g.fillStyle = '#8b8d8f'; g.fillRect(0, 0, 256, 256);
    speck(420, '#7a7c7e', '#9a9c9e');
    g.fillStyle = 'rgba(40,40,44,0.35)'; g.fillRect(0, 127, 256, 2); g.fillRect(127, 0, 2, 256);
  } else if (kind === 'carpet') {
    g.fillStyle = '#6b2f33'; g.fillRect(0, 0, 256, 256);
    speck(900, '#7c3b3f', '#5a272b');
    g.fillStyle = 'rgba(214,170,90,0.55)'; g.fillRect(0, 0, 256, 8); g.fillRect(0, 248, 256, 8);
  } else if (kind === 'lino') {
    g.fillStyle = '#e9e4d2'; g.fillRect(0, 0, 256, 256);
    speck(260, '#d9d3bd', '#f4f0e2');
    g.fillStyle = 'rgba(120,115,95,0.35)'; for (let i = 0; i < 4; i++) { g.fillRect(i * 64, 0, 1, 256); g.fillRect(0, i * 64, 256, 1); }
  } else {
    g.fillStyle = '#6b4a2b'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = `rgba(${90 + (i * 29) % 30},${60 + (i * 17) % 20},${34},1)`; g.fillRect(0, i * 32, 256, 30);
      g.fillStyle = 'rgba(20,10,4,0.55)'; g.fillRect(0, i * 32 + 30, 256, 2); g.fillRect((i * 83) % 256, i * 32, 2, 30);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
