/**
 * The slot machine's pictures: six fish-themed symbols drawn procedurally with the 2D canvas, and
 * the reel strips made from them. No image files: the casino adds no bytes to the bundle for art and
 * nothing to load, and the symbols stay crisp at any device pixel ratio.
 *
 * Each reel is pre-rendered ONCE as a tall strip (24 cells), plus a blurred twin. During the spin
 * `render.ts` just scrolls a window over the strip, crossfading to the blur as the reel speeds up,
 * so a frame costs three `drawImage` calls however fast the reels go. The blur is made by smearing
 * the sharp strip vertically (25 offset copies at low alpha) rather than with `ctx.filter`, which
 * Safari does not implement.
 */
import { REEL_LEN, REELS, STRIPS, type SymbolName, SYMBOLS } from '@keysrun/shared/sim/slots';

/** Cell size in CSS px. The strips are built at `scale` times this. */
export const CELL_W = 118;
export const CELL_H = 82;

type G = CanvasRenderingContext2D;

const ink = '#10202c';

function fishBody(g: G, rx: number, ry: number, fill: string | CanvasGradient): void {
  g.fillStyle = fill; g.strokeStyle = ink; g.lineWidth = 2;
  g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); g.fill(); g.stroke();
}
function eye(g: G, x: number, y: number, r: number, ring = '#f2f0e6'): void {
  g.fillStyle = ring; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = ink; g.beginPath(); g.arc(x + r * 0.15, y, r * 0.58, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x + r * 0.35, y - r * 0.25, r * 0.2, 0, Math.PI * 2); g.fill();
}
function forkedTail(g: G, x: number, h: number, len: number, fill: string): void {
  g.fillStyle = fill; g.strokeStyle = ink; g.lineWidth = 2;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x - len, -h); g.quadraticCurveTo(x - len * 0.62, 0, x - len, h); g.closePath(); g.fill(); g.stroke();
}
function vGrad(g: G, y0: number, y1: number, ...stops: string[]): CanvasGradient {
  const gr = g.createLinearGradient(0, y0, 0, y1);
  stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c));
  return gr;
}
function scales(g: G, rx: number, ry: number, color: string, step = 7): void {
  g.save();
  g.beginPath(); g.ellipse(0, 0, rx - 1, ry - 1, 0, 0, Math.PI * 2); g.clip();
  g.strokeStyle = color; g.lineWidth = 1;
  for (let row = -ry; row < ry; row += step * 0.8) for (let x = -rx + ((Math.round(row / step) % 2) ? step / 2 : 0); x < rx; x += step) {
    g.beginPath(); g.arc(x, row, step * 0.55, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  }
  g.restore();
}

const PAINT: Record<SymbolName, (g: G) => void> = {
  shrimp(g) {
    // a curled prawn: tapering segments along an arc, fan tail, long whiskers
    g.strokeStyle = ink; g.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const a = -1.2 + i * 0.36, r = 22, x = Math.cos(a + Math.PI) * r + 4, y = Math.sin(a + Math.PI) * r * 0.9 + 6;
      g.fillStyle = i % 2 ? '#ff8d5c' : '#ff7a45';
      g.beginPath(); g.ellipse(x, y, 11 - i * 0.7, 8.5 - i * 0.5, a + Math.PI / 2, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    g.fillStyle = '#ff6a38';
    for (const d of [-0.5, 0, 0.5]) { g.beginPath(); g.ellipse(-24 + d * 6, 18 + d * 10, 6, 3.2, 0.9 + d, 0, Math.PI * 2); g.fill(); g.stroke(); }
    g.strokeStyle = '#ff9d78'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(22, -14); g.quadraticCurveTo(38, -26, 48, -20); g.moveTo(24, -10); g.quadraticCurveTo(42, -12, 50, -4); g.stroke();
    eye(g, 18, -9, 3.4, '#ffffff');
  },
  bonefish(g) {
    forkedTail(g, -28, 11, 14, '#b4c4cf');
    g.fillStyle = '#8ea3b1'; g.strokeStyle = ink; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-6, -10); g.lineTo(2, -20); g.lineTo(10, -9); g.closePath(); g.fill(); g.stroke();
    fishBody(g, 33, 11.5, vGrad(g, -12, 12, '#7f98a8', '#d3e0e8', '#f4f8fa'));
    scales(g, 33, 11.5, 'rgba(60,90,110,0.35)', 6);
    g.strokeStyle = '#6a8394'; g.lineWidth = 1; g.beginPath(); g.moveTo(-26, -1); g.lineTo(28, 1); g.stroke();
    g.fillStyle = '#d7e3ea'; g.beginPath(); g.moveTo(32, 2); g.quadraticCurveTo(40, 4, 36, 8); g.lineTo(30, 6); g.closePath(); g.fill(); g.stroke();
    eye(g, 22, -3, 3.8);
  },
  permit(g) {
    forkedTail(g, -22, 13, 14, '#6e7d52');
    g.fillStyle = '#4f5d3c'; g.strokeStyle = ink; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-12, -17); g.quadraticCurveTo(0, -38, 14, -34); g.quadraticCurveTo(10, -22, 14, -16); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-6, 17); g.quadraticCurveTo(0, 32, 10, 30); g.quadraticCurveTo(8, 22, 10, 17); g.closePath(); g.fill(); g.stroke();
    fishBody(g, 25, 21, vGrad(g, -21, 21, '#a7b07a', '#e5e8c9', '#f6f3dc'));
    scales(g, 25, 21, 'rgba(90,100,60,0.3)', 6);
    g.fillStyle = '#e9d27a'; g.beginPath(); g.ellipse(6, 10, 9, 5, 0.2, 0, Math.PI * 2); g.fill();
    eye(g, 15, -5, 4.2);
  },
  tarpon(g) {
    forkedTail(g, -32, 15, 16, '#9fb0bb');
    g.fillStyle = '#8196a4'; g.strokeStyle = ink; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-8, -14); g.lineTo(2, -24); g.quadraticCurveTo(10, -34, 22, -42); g.lineTo(12, -22); g.lineTo(8, -13); g.closePath(); g.fill(); g.stroke();
    fishBody(g, 36, 15, vGrad(g, -15, 15, '#56707f', '#b9c9d3', '#eef3f6', '#ffffff'));
    scales(g, 36, 15, 'rgba(40,70,90,0.45)', 7);
    // the big upturned jaw
    g.fillStyle = '#c5d2da'; g.strokeStyle = ink; g.lineWidth = 2;
    g.beginPath(); g.moveTo(26, 5); g.lineTo(44, 1); g.lineTo(46, 7); g.lineTo(30, 13); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#d7a33d'; g.beginPath(); g.arc(-6, 2, 3, 0, Math.PI * 2); g.fill();
    eye(g, 24, -4, 5.4, '#e8c75a');
  },
  marlin(g) {
    // bill first so the body overlaps its root; sail; crescent tail; vertical neon-blue bars
    g.strokeStyle = ink; g.lineWidth = 2; g.fillStyle = '#2a4f7c';
    g.beginPath(); g.moveTo(34, -2); g.lineTo(58, -3); g.lineTo(34, 3); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#1b4f9c';
    g.beginPath(); g.moveTo(-34, 0); g.lineTo(-48, -22); g.quadraticCurveTo(-42, 0, -48, 22); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#1a3f86';
    g.beginPath(); g.moveTo(-18, -12); g.quadraticCurveTo(-4, -44, 26, -30); g.quadraticCurveTo(10, -26, 14, -12); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#7fd0ff';
    for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(-6 + i * 8, -26 + i * 2.4 - (i === 3 ? 4 : 0), 1.7, 0, Math.PI * 2); g.fill(); }
    fishBody(g, 34, 13, vGrad(g, -13, 13, '#0f3c87', '#2f86e0', '#dff2ff'));
    g.save(); g.beginPath(); g.ellipse(0, 0, 33, 12, 0, 0, Math.PI * 2); g.clip();
    g.strokeStyle = 'rgba(160,225,255,0.65)'; g.lineWidth = 2;
    for (let x = -24; x < 26; x += 8) { g.beginPath(); g.moveTo(x, -12); g.lineTo(x + 2, 12); g.stroke(); }
    g.restore();
    eye(g, 22, -3, 3.8, '#f2c14e');
  },
  boot(g) {
    // an old wellington with a hole in the toe, a strand of weed and a very small crab having a nap
    g.strokeStyle = ink; g.lineWidth = 2;
    g.fillStyle = vGrad(g, -34, 30, '#8a5a2c', '#5a3a1c');
    g.beginPath(); g.moveTo(-14, -34); g.lineTo(8, -34); g.lineTo(10, 8); g.quadraticCurveTo(34, 8, 42, 20); g.lineTo(42, 30); g.lineTo(-18, 30); g.lineTo(-16, 8); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#2d1c0d'; g.beginPath(); g.rect(-18, 24, 60, 6); g.fill();
    g.fillStyle = '#b07a42'; g.beginPath(); g.rect(-15, -34, 24, 6); g.fill(); g.stroke();
    g.fillStyle = '#16242e'; g.beginPath(); g.ellipse(32, 18, 4.2, 3, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#3fa05a'; g.lineWidth = 2.4; g.beginPath(); g.moveTo(6, -34); g.quadraticCurveTo(16, -42, 8, -50); g.stroke();
    g.fillStyle = '#e8573d'; g.beginPath(); g.ellipse(20, 26, 5, 3, 0, 0, Math.PI * 2); g.fill();
  },
};

/** One symbol, drawn centred at (0,0) in a 118x82 cell, scaled to fit. */
export function paintSymbol(g: G, name: SymbolName, scale = 1): void {
  g.save();
  g.scale(scale, scale);
  PAINT[name](g);
  g.restore();
}

export interface Strips {
  scale: number;
  sharp: HTMLCanvasElement[];
  blur: HTMLCanvasElement[];
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h));
  return c;
}

/** Pre-render the three reel strips (sharp + vertically smeared). `scale` is the device pixel ratio, capped by the caller. */
export function buildStrips(scale: number): Strips {
  const sharp: HTMLCanvasElement[] = [], blur: HTMLCanvasElement[] = [];
  for (let r = 0; r < REELS; r++) {
    const c = canvas(CELL_W * scale, CELL_H * REEL_LEN * scale);
    const g = c.getContext('2d')!;
    g.scale(scale, scale);
    for (let i = 0; i < REEL_LEN; i++) {
      // alternate faint bands so a fast reel still reads as moving
      g.fillStyle = i % 2 ? '#f6f2e4' : '#efe9d6';
      g.fillRect(0, i * CELL_H, CELL_W, CELL_H);
      g.save();
      g.translate(CELL_W / 2, i * CELL_H + CELL_H / 2);
      paintSymbol(g, SYMBOLS[STRIPS[r][i]], 0.92);
      g.restore();
    }
    sharp.push(c);
    const b = canvas(c.width, c.height);
    const bg = b.getContext('2d')!;
    // 25 copies, 2.2 px apart (+-26 px), each at 1/9 alpha: a smooth vertical smear. Nine copies 5.5 px apart (the first
    // version) left visible ghost outlines of each fish stacked down the reel, which read as a rendering bug.
    bg.globalAlpha = 1 / 9;
    for (let k = -12; k <= 12; k++) {
      bg.drawImage(c, 0, k * 2.2 * scale);
      bg.drawImage(c, 0, k * 2.2 * scale + c.height, c.width, c.height); // wrap
      bg.drawImage(c, 0, k * 2.2 * scale - c.height, c.width, c.height);
    }
    blur.push(b);
  }
  return { scale, sharp, blur };
}
